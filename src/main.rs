mod librus;
mod push;
mod store;
mod watch;
mod web;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use push::{Sent, Subscription, Vapid};
use store::{SESSION_TTL_SECS, Store, Tokens};

const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
const LOGIN_MAX_ATTEMPTS: usize = 5;

static API_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_,-]+(/[A-Za-z0-9_,-]+)*$").expect("static regex"));
/// What the app reads on the Synergia website: the received and sent folders and single messages.
static WEB_PAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^wiadomosci/(?:[56]|1/[56]/[0-9]+/f0)$").expect("static regex"));
static WEB_FILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^wiadomosci/pobierz_zalacznik/[0-9]+/[0-9]+$").expect("static regex"));

struct App {
    store: Store,
    http: reqwest::Client,
    /// ADMIN_EMAILS: always allowed, and may edit the access list kept in the database.
    admins: HashSet<String>,
    /// ALLOWED_EMAILS: always allowed, fixed until the next restart.
    allowed: HashSet<String>,
    // Keys are allowed emails only, so the map is bounded by the env lists plus the access list cap.
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
    // ponytail: one lock serializes every token refresh; per-user locks if the group grows.
    refresh_lock: tokio::sync::Mutex<()>,
    /// Bases of the Synergia API and website; a test points them at a fixture server.
    api: String,
    synergia: String,
    /// Website sessions by "email/login". Bounded and pruned in `web`.
    web: Mutex<HashMap<String, web::Session>>,
    vapid: Vapid,
    /// Asks the notification loop for an early round: a new device or a new login.
    wake: tokio::sync::Notify,
}

type Shared = State<Arc<App>>;

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<librus::Error> for ApiError {
    fn from(e: librus::Error) -> Self {
        use librus::Error::*;
        match e {
            BadCredentials => ApiError(StatusCode::UNAUTHORIZED, "bad_credentials"),
            Captcha => ApiError(StatusCode::FORBIDDEN, "captcha"),
            Maintenance => ApiError(StatusCode::SERVICE_UNAVAILABLE, "maintenance"),
            Status(StatusCode::UNAUTHORIZED) => ApiError(StatusCode::UNAUTHORIZED, "relogin"),
            Status(s) => {
                eprintln!("librus: upstream status {s}");
                ApiError(StatusCode::BAD_GATEWAY, "upstream")
            }
            Flow(at) => {
                eprintln!("librus: login flow stopped at {at:?}");
                ApiError(StatusCode::BAD_GATEWAY, "login_flow")
            }
            Http(e) => {
                eprintln!("librus: {e}");
                ApiError(StatusCode::BAD_GATEWAY, "upstream")
            }
        }
    }
}

fn db_err(e: rusqlite::Error) -> ApiError {
    eprintln!("db: {e}");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "db")
}

const RELOGIN: ApiError = ApiError(StatusCode::UNAUTHORIZED, "relogin");

fn sid(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix("sid="))
}

fn session_cookie(value: &str, max_age: i64) -> String {
    format!("sid={value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={max_age}")
}

fn account_token(t: &Tokens, login: &str) -> Result<String, ApiError> {
    let a = t.accounts.iter().find(|a| a.login == login).ok_or(ApiError(StatusCode::NOT_FOUND, "no_account"))?;
    a.access_token.clone().ok_or(ApiError(StatusCode::BAD_GATEWAY, "account_broken"))
}

/// Shape check only: whether the address is a real Librus account shows when its owner signs in.
fn valid_email(e: &str) -> bool {
    e.len() <= 254
        && !e.chars().any(|c| c.is_whitespace() || c.is_control())
        && e.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.contains('@'))
}

fn me_json(email: &str, t: &Tokens, app: &App) -> Value {
    let accounts: Vec<Value> = t
        .accounts
        .iter()
        .map(|a| json!({ "login": a.login, "name": a.student_name, "state": a.state }))
        .collect();
    json!({ "email": email, "accounts": accounts, "admin": app.admins.contains(email), "push": app.vapid.public })
}

impl App {
    fn is_allowed(&self, email: &str) -> bool {
        self.admins.contains(email) || self.allowed.contains(email) || self.store.is_allowed(email)
    }

    /// Checks access on every request, so a session cannot outlive a revoked address.
    fn user(&self, headers: &HeaderMap) -> Result<String, ApiError> {
        sid(headers)
            .and_then(|s| self.store.session_email(s))
            .filter(|e| self.is_allowed(e))
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"))
    }

    fn admin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        if !self.admins.contains(&self.user(headers)?) {
            return Err(ApiError(StatusCode::FORBIDDEN, "forbidden"));
        }
        Ok(())
    }

    fn access_json(&self) -> Result<Json<Value>, ApiError> {
        let mut fixed: Vec<&String> = self.admins.union(&self.allowed).collect();
        fixed.sort();
        let emails: Vec<Value> = self
            .store
            .allowed()
            .map_err(db_err)?
            .into_iter()
            .map(|(email, added, active)| json!({ "email": email, "added": added, "active": active }))
            .collect();
        Ok(Json(json!({ "fixed": fixed, "emails": emails })))
    }

    /// Reserves an attempt slot atomically so parallel requests cannot exceed the limit.
    fn take_attempt(&self, email: &str) -> Result<(), ApiError> {
        let mut m = self.attempts.lock().unwrap_or_else(|p| p.into_inner());
        let v = m.entry(email.to_string()).or_default();
        v.retain(|t| t.elapsed() < LOGIN_WINDOW);
        if v.len() >= LOGIN_MAX_ATTEMPTS {
            return Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
        }
        v.push(Instant::now());
        Ok(())
    }

    async fn refresh_synergia(&self, email: &str, login: &str, stale: &str) -> Result<String, ApiError> {
        let _guard = self.refresh_lock.lock().await;
        let mut t = self.store.tokens(email).ok_or(RELOGIN)?;
        let current = account_token(&t, login)?;
        if current != stale {
            return Ok(current);
        }
        let acc = match librus::fresh_account(&self.http, &t.access, login).await {
            Err(librus::Error::Status(StatusCode::UNAUTHORIZED)) => {
                let p = librus::refresh(&self.http, &t.refresh).await.map_err(|e| match e {
                    librus::Error::Status(StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED) => RELOGIN,
                    e => e.into(),
                })?;
                t.access = p.access_token;
                if let Some(r) = p.refresh_token {
                    t.refresh = r;
                }
                self.store.update_tokens(email, &t).map_err(db_err)?;
                librus::fresh_account(&self.http, &t.access, login).await?
            }
            r => r?,
        };
        if let Some(slot) = t.accounts.iter_mut().find(|a| a.login == login) {
            *slot = acc;
        }
        self.store.update_tokens(email, &t).map_err(db_err)?;
        account_token(&t, login)
    }

    /// Sends `req` with the account token, retrying once with a refreshed token on 401.
    /// Librus rejects a stale token before acting, so the retry cannot repeat a write.
    async fn send(
        &self,
        email: &str,
        login: &str,
        req: impl Fn(&str) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ApiError> {
        let token = account_token(&self.store.tokens(email).ok_or(RELOGIN)?, login)?;
        let res = req(&token).send().await.map_err(librus::Error::from)?;
        if res.status() != StatusCode::UNAUTHORIZED {
            return Ok(res);
        }
        let fresh = self.refresh_synergia(email, login, &token).await?;
        Ok(req(&fresh).send().await.map_err(librus::Error::from)?)
    }
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(State(app): Shared, Json(b): Json<LoginBody>) -> Result<Response, ApiError> {
    let typed = b.email.trim();
    let email = typed.to_lowercase();
    if !app.is_allowed(&email) {
        return Err(ApiError(StatusCode::FORBIDDEN, "not_allowed"));
    }
    if b.password.is_empty() || b.password.len() > 512 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad_request"));
    }
    app.take_attempt(&email)?;
    let tok = librus::login(typed, &b.password).await?;
    if librus::me_email(&app.http, &tok.access_token).await?.to_lowercase() != email {
        return Err(ApiError(StatusCode::FORBIDDEN, "not_allowed"));
    }
    let accounts = librus::accounts(&app.http, &tok.access_token).await?;
    let t = Tokens { access: tok.access_token, refresh: tok.refresh_token.unwrap_or_default(), accounts };
    app.store.put_tokens(&email, &t).map_err(db_err)?;
    let sid = app.store.new_session(&email).map_err(db_err)?;
    app.attempts.lock().unwrap_or_else(|p| p.into_inner()).remove(&email);
    // Fresh tokens: feeds that stopped on an expired Librus session can go on.
    app.wake.notify_one();
    let me = me_json(&email, &t, &app);
    Ok(([(header::SET_COOKIE, session_cookie(&sid, SESSION_TTL_SECS))], Json(me)).into_response())
}

async fn logout(State(app): Shared, headers: HeaderMap) -> Response {
    if let Some(s) = sid(&headers)
        && let Err(e) = app.store.end_session(s)
    {
        return db_err(e).into_response();
    }
    ([(header::SET_COOKIE, session_cookie("", 0))], StatusCode::NO_CONTENT).into_response()
}

async fn me(State(app): Shared, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let email = app.user(&headers)?;
    let t = app.store.tokens(&email).ok_or(RELOGIN)?;
    Ok(Json(me_json(&email, &t, &app)))
}

/// State of the caller's notification feeds, one per student.
async fn feeds(State(app): Shared, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let email = app.user(&headers)?;
    let feeds: Vec<Value> = app
        .store
        .feeds(&email)
        .map_err(db_err)?
        .into_iter()
        .map(|(login, _, checked, error)| json!({ "login": login, "checked": checked, "error": error }))
        .collect();
    Ok(Json(json!({ "feeds": feeds })))
}

/// What changed for one of the caller's students, newest first, as the change feed reported it.
async fn activity(State(app): Shared, headers: HeaderMap, Path(login): Path<String>) -> Result<Json<Value>, ApiError> {
    let email = app.user(&headers)?;
    let entries: Vec<Value> = app
        .store
        .activity(&email, &login)
        .map_err(db_err)?
        .into_iter()
        .map(|(at, kind, change, resource)| json!({ "at": at, "kind": kind, "change": change, "resource": resource }))
        .collect();
    Ok(Json(json!({ "entries": entries })))
}

/// The fields of `PushSubscription.toJSON()` this server uses.
#[derive(Deserialize)]
struct DeviceBody {
    endpoint: String,
    #[serde(default)]
    keys: DeviceKeys,
}

#[derive(Deserialize, Default)]
struct DeviceKeys {
    #[serde(default)]
    p256dh: String,
    #[serde(default)]
    auth: String,
}

/// Registers the caller's browser. A device seen for the first time gets a message right away, so a subscription
/// the push service would refuse fails here, in front of the user, and not silently later.
async fn add_device(State(app): Shared, headers: HeaderMap, Json(b): Json<DeviceBody>) -> Result<StatusCode, ApiError> {
    let email = app.user(&headers)?;
    let device = Subscription::parse(&b.endpoint, &b.keys.p256dh, &b.keys.auth).ok_or(ApiError(StatusCode::BAD_REQUEST, "bad_device"))?;
    if !app.store.devices(&email).map_err(db_err)?.iter().any(|d| d.endpoint == device.endpoint) {
        let hello = json!({ "title": "Dziennik", "body": "Powiadomienia są włączone na tym urządzeniu.", "url": "/" }).to_string();
        match push::send(&app.http, &app.vapid, &device, hello.as_bytes()).await {
            Ok(Sent::Delivered) => {}
            Ok(Sent::Gone) => return Err(ApiError(StatusCode::BAD_GATEWAY, "push_failed")),
            Err(e) => {
                eprintln!("push: {e}");
                return Err(ApiError(StatusCode::BAD_GATEWAY, "push_failed"));
            }
        }
    }
    app.store.add_device(&email, &device).map_err(db_err)?;
    app.wake.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_device(State(app): Shared, headers: HeaderMap, Json(b): Json<DeviceBody>) -> Result<StatusCode, ApiError> {
    let email = app.user(&headers)?;
    app.store.remove_device(&b.endpoint, Some(&email)).map_err(db_err)?;
    if app.store.devices(&email).map_err(db_err)?.is_empty() {
        watch::stop(&app, &email).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn access(State(app): Shared, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    app.admin(&headers)?;
    app.access_json()
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

async fn allow(State(app): Shared, headers: HeaderMap, Json(b): Json<EmailBody>) -> Result<Json<Value>, ApiError> {
    app.admin(&headers)?;
    let email = b.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad_email"));
    }
    if !app.store.allow(&email).map_err(db_err)? {
        return Err(ApiError(StatusCode::CONFLICT, "list_full"));
    }
    app.access_json()
}

/// A cross-site page cannot send DELETE without a CORS preflight, which this server never answers.
async fn revoke(State(app): Shared, headers: HeaderMap, Path(email): Path<String>) -> Result<Json<Value>, ApiError> {
    app.admin(&headers)?;
    let email = email.trim().to_lowercase();
    // An address also listed in the environment keeps its access, so it keeps its session too.
    let fixed = app.admins.contains(&email) || app.allowed.contains(&email);
    app.store.revoke(&email, !fixed).map_err(db_err)?;
    if !fixed {
        app.attempts.lock().unwrap_or_else(|p| p.into_inner()).remove(&email);
        web::forget(&app, &email);
    }
    app.access_json()
}

/// GET pass-through to api.librus.pl/3.0 with the student's Synergia token.
async fn proxy(
    State(app): Shared,
    headers: HeaderMap,
    Path((login, path)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    if !API_PATH_RE.is_match(&path) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad_path"));
    }
    let mut url = reqwest::Url::parse(&format!("{}/{path}", app.api)).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "bad_path"))?;
    url.set_query(query.as_deref());
    forward(&app, &email, &login, |token| app.http.get(url.clone()).bearer_auth(token)).await
}

/// Reads the Synergia website where the API refuses an account without a subscription. The page travels inside
/// JSON: sent as HTML from this origin it would be rendered here, scripts included, for anyone opening the address.
async fn website(State(app): Shared, headers: HeaderMap, Path((login, path)): Path<(String, String)>) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    let body = if WEB_PAGE_RE.is_match(&path) {
        json!({ "html": web::read(&app, &email, &login, &path, false).await? })
    } else if WEB_FILE_RE.is_match(&path) {
        json!({ "DownloadUrl": web::read(&app, &email, &login, &path, true).await? })
    } else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "bad_path"));
    };
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(body)).into_response())
}

/// The only Synergia writes the app makes; every other path stays read-only.
const WRITES: &[&str] = &["Messages", "HomeWorkAssignments/MarkAsRead", "HomeWorkAssignments/MarkAsDone"];

/// JSON POST to one of `WRITES`. `Json` rejects any other content type, which a cross-site form cannot send,
/// and the SameSite=Strict session cookie is not attached to cross-site fetches.
async fn write(
    State(app): Shared,
    headers: HeaderMap,
    Path((login, path)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    if !WRITES.contains(&path.as_str()) {
        return Err(ApiError(StatusCode::FORBIDDEN, "bad_path"));
    }
    let url = format!("{}/{path}", app.api);
    forward(&app, &email, &login, |token| app.http.post(&url).bearer_auth(token).json(&body)).await
}

/// Sends `req` through `App::send` and streams the answer back.
async fn forward(
    app: &App,
    email: &str,
    login: &str,
    req: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<Response, ApiError> {
    let res = app.send(email, login, req).await?;
    let mut out = Response::builder()
        .status(res.status())
        .header(header::CACHE_CONTROL, "private, no-store");
    if let Some(ct) = res.headers().get(header::CONTENT_TYPE) {
        out = out.header(header::CONTENT_TYPE, ct);
    }
    Ok(out.body(Body::from_stream(res.bytes_stream())).expect("valid response parts"))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let emails = |k: &str| -> HashSet<String> {
        env(k, "").split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
    };
    let (admins, allowed) = (emails("ADMIN_EMAILS"), emails("ALLOWED_EMAILS"));
    if admins.is_empty() && allowed.is_empty() {
        return Err("set ADMIN_EMAILS (may edit the access list in the app) or ALLOWED_EMAILS".into());
    }
    let store = Store::open(&env("DB", "dziennik.db"), &env("SECRET_KEY", ""))?;
    // The notification signing key is made once and kept in the database. A new SECRET_KEY cannot open it, so a
    // new one is made and browsers subscribe again the next time the app is opened.
    let contact = admins.iter().chain(&allowed).min().cloned().unwrap_or_default();
    let vapid = match store.secret("vapid").and_then(|k| Vapid::load(&k, &contact)) {
        Some(v) => v,
        None => {
            let key = Vapid::generate().map_err(|_| "cannot create the notification key")?;
            store.set_secret("vapid", &key)?;
            Vapid::load(&key, &contact).ok_or("cannot load the notification key")?
        }
    };
    let http = reqwest::Client::builder()
        .timeout(librus::TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let app = Arc::new(App {
        store,
        http,
        admins,
        allowed,
        attempts: Mutex::default(),
        refresh_lock: tokio::sync::Mutex::default(),
        api: librus::API.to_string(),
        synergia: librus::SYNERGIA.to_string(),
        web: Mutex::default(),
        vapid,
        wake: tokio::sync::Notify::new(),
    });
    tokio::spawn(watch::run(app.clone()));

    let router = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/admin/emails", get(access).post(allow))
        .route("/api/admin/emails/{email}", delete(revoke))
        .route("/api/push", get(feeds).post(add_device).delete(remove_device))
        .route("/api/activity/{login}", get(activity))
        .route("/api/s/{login}/{*path}", get(proxy).post(write))
        .route("/api/w/{login}/{*path}", get(website))
        // Message bodies are plain text; nothing the app sends comes near this.
        .layer(DefaultBodyLimit::max(256 * 1024))
        .fallback_service(ServeDir::new(env("WEB_DIR", "web/dist")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .with_state(app);

    let bind = env("BIND", "127.0.0.1:8080");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("listening on http://{bind}");
    axum::serve(listener, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_email;

    #[test]
    fn email_shape() {
        assert!(valid_email("jan.kowalski+szkola@example.com"));
        for bad in ["", "jan", "@example.com", "jan@example", "jan@@example.com", "jan kowalski@example.com", "jan@exa\nmple.com"] {
            assert!(!valid_email(bad), "{bad:?}");
        }
        assert!(!valid_email(&format!("{}@example.com", "a".repeat(250))));
    }
}

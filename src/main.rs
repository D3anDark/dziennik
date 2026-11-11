mod librus;
// VULCAN is off: eduVULCAN's terms (ch. II sec. 15) allow only a browser without VULCAN's written consent, and the
// code has never met a real account. To turn it on: add `httpdate = "1"` to Cargo.toml, uncomment the line below,
// then write the sign-in and data routes (see AGENTS.md).
// mod vulcan;
mod provenance;
mod push;
mod store;
mod watch;
mod web;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::middleware::Next;
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
/// What the app reads on the Synergia website: the received and sent folders, single messages, and the forms of a
/// new message (2/5) and of a reply (3/5/<id>).
static WEB_PAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^wiadomosci/(?:[56]|2/5|3/5/[0-9]+|1/[56]/[0-9]+/f0)$").expect("static regex"));
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
    /// OPERATOR: name and contact of whoever runs this server, the controller of its data under RODO.
    operator: String,
    /// BUILD_STATE from build.rs, as `confirm` left it at start.
    build: &'static str,
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

    async fn refresh_synergia(&self, email: &str, sid: Option<&str>, login: &str, stale: &str) -> Result<String, ApiError> {
        let _guard = self.refresh_lock.lock().await;
        let mut t = self.store.tokens(email, sid).ok_or(RELOGIN)?;
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
                self.store.update_tokens(email, sid, &t).map_err(db_err)?;
                librus::fresh_account(&self.http, &t.access, login).await?
            }
            r => r?,
        };
        if let Some(slot) = t.accounts.iter_mut().find(|a| a.login == login) {
            *slot = acc;
        }
        self.store.update_tokens(email, sid, &t).map_err(db_err)?;
        account_token(&t, login)
    }

    /// Sends `req` with the account token, retrying once with a refreshed token on 401.
    /// Librus rejects a stale token before acting, so the retry cannot repeat a write.
    /// `sid` is the caller's session, whose own copy of the tokens it opens; the watcher has none.
    async fn send(
        &self,
        email: &str,
        sid: Option<&str>,
        login: &str,
        req: impl Fn(&str) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ApiError> {
        let token = account_token(&self.store.tokens(email, sid).ok_or(RELOGIN)?, login)?;
        let res = req(&token).send().await.map_err(librus::Error::from)?;
        if res.status() != StatusCode::UNAUTHORIZED {
            return Ok(res);
        }
        let fresh = self.refresh_synergia(email, sid, login, &token).await?;
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
    // The server keeps a copy it can open on its own only for notifications; otherwise the copy is the session's.
    let notify = !app.store.devices(&email).map_err(db_err)?.is_empty();
    if notify {
        app.store.put_tokens(&email, &t).map_err(db_err)?;
    }
    let sid = app.store.new_session(&email, (!notify).then_some(&t)).map_err(db_err)?;
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

/// The app asks this on every start, which is where a session in use gets its time renewed, cookie included.
async fn me(State(app): Shared, headers: HeaderMap) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    let t = app.store.tokens(&email, sid(&headers)).ok_or(RELOGIN)?;
    let me = Json(me_json(&email, &t, &app));
    Ok(match sid(&headers) {
        Some(s) if app.store.renew_session(s).map_err(db_err)? => {
            ([(header::SET_COOKIE, session_cookie(s, SESSION_TTL_SECS))], me).into_response()
        }
        _ => me.into_response(),
    })
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
    if let Some(s) = sid(&headers) {
        app.store.share_tokens(&email, s).map_err(db_err)?;
    }
    app.wake.notify_one();
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_device(State(app): Shared, headers: HeaderMap, Json(b): Json<DeviceBody>) -> Result<StatusCode, ApiError> {
    let email = app.user(&headers)?;
    // The last device: the feeds stop while the server's copy of the tokens is still there, then the copy moves back
    // into this session before the device goes, so that `purge` never leaves the session without one.
    if app.store.devices(&email).map_err(db_err)?.iter().all(|d| d.endpoint == b.endpoint) {
        watch::stop(&app, &email).await;
        if let Some(s) = sid(&headers) {
            app.store.unshare_tokens(&email, s).map_err(db_err)?;
        }
    }
    app.store.remove_device(&b.endpoint, Some(&email)).map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes everything the server keeps for the caller, on every device, and signs them out (RODO art. 17).
async fn forget_me(State(app): Shared, headers: HeaderMap) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    watch::stop(&app, &email).await;
    app.store.forget(&email).map_err(db_err)?;
    web::forget(&app, &email);
    Ok(([(header::SET_COOKIE, session_cookie("", 0))], StatusCode::NO_CONTENT).into_response())
}

/// Who runs this server (RODO art. 13) and whether it was built from the official repository unchanged (build.rs),
/// both shown before signing in. A changed server can lie here as well: this reveals honest changes, not a dishonest host.
async fn about(State(app): Shared) -> Json<Value> {
    Json(json!({ "operator": app.operator, "build": app.build, "commit": env!("BUILD_COMMIT") }))
}

// Whether this server is the official code is decided here, in the backend, and shown by it as well: `inject` puts the
// warning into every page it serves, whoever wrote the frontend. The checks are spread on purpose (build.rs, `confirm`,
// the start in `main`, `inject`), so a modified server has to change each before it stops warning (AGENTS.md). None of
// them stops a determined host.

/// The warning for a build not confirmed as the official one; nothing for an official build.
fn warning(build: &str) -> Option<&'static str> {
    match build {
        "official" => None,
        "modified" => Some(
            "Hostowana wersja serwera jest niezgodna z\u{a0}tą na oficjalnym repozytorium. Jeżeli nie ufasz osobie hostującej ten projekt, nie podawaj swojego loginu i\u{a0}hasła.",
        ),
        _ => Some(
            "Nie da się potwierdzić, że hostowana wersja serwera jest zgodna z\u{a0}tą na oficjalnym repozytorium. Jeżeli nie ufasz osobie hostującej ten projekt, nie podawaj swojego loginu i\u{a0}hasła.",
        ),
    }
}

/// src/warning.js with the warning in it. The file is compiled in: deleting it stops the build.
fn warning_script(text: &str) -> String {
    include_str!("warning.js").replace("__WARNING__", &json!(text).to_string())
}

/// The script `inject` puts into every page: a window with the warning, or nothing for an official build.
async fn warning_js(State(app): Shared) -> Response {
    let js = warning(app.build).map(warning_script);
    let headers = [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")];
    (headers, js.unwrap_or_default()).into_response()
}

/// Adds the warning script to every HTML page served from WEB_DIR, whatever frontend is there, so a new frontend warns
/// without knowing about it. The tag goes in for every build (the script is empty for an official one), so a page a
/// browser keeps from one build still asks the next.
async fn inject(mut req: Request, next: Next) -> Result<Response, ApiError> {
    // A 304 would hand back a page kept from before the tag; pages are always sent whole.
    req.headers_mut().remove(header::IF_MODIFIED_SINCE);
    req.headers_mut().remove(header::IF_NONE_MATCH);
    let res = next.run(req).await;
    let html = res.headers().get(header::CONTENT_TYPE).is_some_and(|t| t.as_bytes().starts_with(b"text/html"));
    if res.status() != StatusCode::OK || !html {
        return Ok(res);
    }
    let (mut parts, body) = res.into_parts();
    // shortcut: a page is read whole, up to 1 MiB, and refused above that; stream it if a frontend needs bigger pages.
    let page = axum::body::to_bytes(body, 1 << 20).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "page_too_large"))?;
    // Bytes, not text: the page may be in any ASCII-compatible encoding. No </head>: at the end, still read as body.
    let at = page.windows(7).position(|w| w.eq_ignore_ascii_case(b"</head>")).unwrap_or(page.len());
    let page = [&page[..at], b"<script src=\"/api/warning.js\" defer></script>", &page[at..]].concat();
    parts.headers.remove(header::CONTENT_LENGTH);
    Ok(Response::from_parts(parts, Body::from(page)))
}

/// GitHub's word on an "official" build: its commit is on the official main branch. build.rs trusts the local clone,
/// whose remote branches can be pointed anywhere (a fork with the official URL, `git update-ref`); this asks the
/// repository itself. It only ever lowers the state.
// shortcut: asked once at start, so a GitHub outage reads as unknown until the next restart; retry if that bites.
async fn confirm(http: &reqwest::Client, github: &str, state: &'static str, commit: &str) -> &'static str {
    if state != "official" {
        return state;
    }
    let repo = provenance::OFFICIAL.trim_start_matches("github.com/");
    // For a commit on main the comparison lists no commits and no files, so the answer is small.
    let res = http
        .get(format!("{github}/repos/{repo}/compare/main...{commit}"))
        .header(header::USER_AGENT, "dziennik")
        .header(header::ACCEPT, "application/vnd.github+json")
        .send()
        .await;
    match res {
        Ok(r) if r.status() == StatusCode::NOT_FOUND => "modified",
        Ok(r) if r.status().is_success() => match r.json::<Value>().await.ok().as_ref().and_then(|v| v["status"].as_str()) {
            // "behind": main has moved past this commit and still contains it.
            Some("identical" | "behind") => "official",
            Some(_) => "modified",
            None => "unknown",
        },
        _ => "unknown",
    }
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
    forward(&app, &email, sid(&headers), &login, |token| app.http.get(url.clone()).bearer_auth(token)).await
}

/// Reads the Synergia website where the API refuses an account without a subscription. The page travels inside
/// JSON: sent as HTML from this origin it would be rendered here, scripts included, for anyone opening the address.
async fn website(State(app): Shared, headers: HeaderMap, Path((login, path)): Path<(String, String)>) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    let body = if WEB_PAGE_RE.is_match(&path) {
        json!({ "html": web::read(&app, &email, sid(&headers), &login, &path, false).await? })
    } else if WEB_FILE_RE.is_match(&path) {
        json!({ "DownloadUrl": web::read(&app, &email, sid(&headers), &login, &path, true).await? })
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
    forward(&app, &email, sid(&headers), &login, |token| app.http.post(&url).bearer_auth(token).json(&body)).await
}

/// The only forms the app submits on the Synergia website, and whether the site takes them as multipart: the people
/// of a recipient group, a new message, a reply.
const WEB_WRITES: &[(&str, bool)] = &[("getRecipients", false), ("wiadomosci/5", true), ("wiadomosci", true)];

/// Submits one of `WEB_WRITES` with the fields the browser read from the site's own form. Protected from other
/// sites the same way as `write`.
async fn website_write(
    State(app): Shared,
    headers: HeaderMap,
    Path((login, path)): Path<(String, String)>,
    Json(fields): Json<Vec<(String, String)>>,
) -> Result<Response, ApiError> {
    let email = app.user(&headers)?;
    let &(_, multipart) = WEB_WRITES.iter().find(|w| w.0 == path).ok_or(ApiError(StatusCode::FORBIDDEN, "bad_path"))?;
    let html = web::post(&app, &email, sid(&headers), &login, &path, fields, multipart).await?;
    Ok(([(header::CACHE_CONTROL, "private, no-store")], Json(json!({ "html": html }))).into_response())
}

/// Sends `req` through `App::send` and streams the answer back.
async fn forward(
    app: &App,
    email: &str,
    sid: Option<&str>,
    login: &str,
    req: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<Response, ApiError> {
    let res = app.send(email, sid, login, req).await?;
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
    let commit = env!("BUILD_COMMIT");
    let hex = commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit());
    // build.rs gives only these; anything else means it was rewritten, and the server does not start on its word.
    let build = match env!("BUILD_STATE") {
        "official" if hex => confirm(&http, "https://api.github.com", "official", commit).await,
        "modified" if hex => "modified",
        "unknown" if commit.is_empty() => "unknown",
        other => return Err(format!("build state {other:?} with commit {commit:?} is not one build.rs gives").into()),
    };
    // An emptied src/warning.js, or one without the place for the text, would warn no one: the server does not start.
    if let Some(text) = warning(build)
        && !warning_script(text).contains(&json!(text).to_string())
    {
        return Err("src/warning.js does not show the build warning (see AGENTS.md)".into());
    }
    let web_dir = env("WEB_DIR", "web/dist");
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
        operator: env("OPERATOR", "").trim().to_string(),
        build,
    });
    tokio::spawn(watch::run(app.clone()));

    let bind = env("BIND", "127.0.0.1:8080");
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("listening on http://{bind}, build {build} {commit}");
    axum::serve(listener, router(app, &web_dir)).await?;
    Ok(())
}

fn router(app: Arc<App>, web_dir: &str) -> Router {
    Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me).delete(forget_me))
        .route("/api/about", get(about))
        .route("/api/warning.js", get(warning_js))
        .route("/api/admin/emails", get(access).post(allow))
        .route("/api/admin/emails/{email}", delete(revoke))
        .route("/api/push", get(feeds).post(add_device).delete(remove_device))
        .route("/api/activity/{login}", get(activity))
        .route("/api/s/{login}/{*path}", get(proxy).post(write))
        .route("/api/w/{login}/{*path}", get(website).post(website_write))
        // Message bodies are plain text; nothing the app sends comes near this.
        .layer(DefaultBodyLimit::max(256 * 1024))
        .fallback_service(Router::new().fallback_service(ServeDir::new(web_dir)).layer(axum::middleware::from_fn(inject)))
        // Told nothing, browsers keep index.html for a while on their own guess, and an installed app goes on starting
        // the previous build. Everything else it names is hashed (/assets) or fetched by the service worker itself.
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, |res: &Response| {
            let html = res.headers().get(header::CONTENT_TYPE).is_some_and(|t| t.as_bytes().starts_with(b"text/html"));
            html.then(|| HeaderValue::from_static("no-cache"))
        }))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .with_state(app)
}

#[cfg(test)]
mod tests {
    use reqwest::Method;

    use super::*;
    use crate::store::Account;

    /// Who may ask for what, on the real routes. Nothing here reaches Librus: every request is refused first.
    #[tokio::test]
    async fn routes_check_who_asks() {
        let app = Arc::new(App {
            store: Store::open(":memory:", &"ab".repeat(32)).unwrap(),
            http: reqwest::Client::new(),
            admins: HashSet::from(["admin@x.pl".to_string()]),
            allowed: HashSet::from(["user@x.pl".to_string()]),
            attempts: Mutex::default(),
            refresh_lock: tokio::sync::Mutex::default(),
            api: "http://127.0.0.1:9".into(),
            synergia: "http://127.0.0.1:9".into(),
            web: Mutex::default(),
            vapid: Vapid::load(&Vapid::generate().unwrap(), "admin@x.pl").unwrap(),
            wake: tokio::sync::Notify::new(),
            operator: String::new(),
            build: "modified",
        });
        let account = Account { login: "1u".into(), access_token: Some("tok".into()), student_name: None, state: None };
        let tokens = Tokens { access: "p".into(), refresh: "r".into(), accounts: vec![account] };
        let sid = |email: &str| app.store.new_session(email, Some(&tokens)).unwrap();
        let (admin, user, guest) = (sid("admin@x.pl"), sid("user@x.pl"), sid("guest@x.pl"));
        app.store.allow("guest@x.pl").unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let web = std::env::temp_dir().join(format!("dziennik-web-{}", std::process::id()));
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("index.html"), "<!doctype html><HTML><HEAD><title>t</title></HEAD><body>x</body>").unwrap();
        std::fs::write(web.join("bare.html"), "<p>x</p>").unwrap();
        std::fs::write(web.join("app.js"), "</head>").unwrap();
        tokio::spawn(axum::serve(listener, router(app.clone(), web.to_str().unwrap())).into_future());
        let http = reqwest::Client::new();
        // The page is asked for again on every start, so an installed app picks up a new build.
        let page = http.get(&base).header(header::IF_MODIFIED_SINCE, "Fri, 01 Jan 2100 00:00:00 GMT").send().await.unwrap();
        assert_eq!(page.headers().get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap()), Some("no-cache"));
        // Whatever frontend is there, its pages load the server's warning, and a kept copy is not answered with a 304.
        assert_eq!(page.status(), 200);
        let tag = "<script src=\"/api/warning.js\" defer></script>";
        assert_eq!(page.text().await.unwrap(), format!("<!doctype html><HTML><HEAD><title>t</title>{tag}</HEAD><body>x</body>"));
        assert_eq!(http.get(format!("{base}/bare.html")).send().await.unwrap().text().await.unwrap(), format!("<p>x</p>{tag}"));
        assert_eq!(http.get(format!("{base}/app.js")).send().await.unwrap().text().await.unwrap(), "</head>");
        let script = http.get(format!("{base}/api/warning.js")).send().await.unwrap();
        assert_eq!(script.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        let script = script.text().await.unwrap();
        assert!(script.contains("const text = \"Hostowana wersja serwera jest niezgodna z\u{a0}tą"), "{script}");
        assert_eq!(warning("official"), None, "an official build sends the script empty");
        assert!(warning("unknown").unwrap().starts_with("Nie da się potwierdzić"));
        std::fs::remove_dir_all(&web).unwrap();
        let ask = async |method: Method, path: &str, sid: &str, body: Option<Value>| {
            let mut req = http.request(method, format!("{base}{path}")).header(header::COOKIE, format!("sid={sid}"));
            if let Some(body) = body {
                req = req.json(&body);
            }
            let res = req.send().await.unwrap();
            let status = res.status().as_u16();
            (status, res.json::<Value>().await.map_or(Value::Null, |v| v["error"].clone()))
        };
        let refused = |status: u16, error: &str| (status, json!(error));

        // No session, or one this server never issued.
        for (method, path) in [
            (Method::GET, "/api/me"),
            (Method::GET, "/api/s/1u/Grades"),
            (Method::GET, "/api/w/1u/wiadomosci/5"),
            (Method::GET, "/api/admin/emails"),
            (Method::GET, "/api/activity/1u"),
            (Method::GET, "/api/push"),
        ] {
            assert_eq!(ask(method, path, "0000", None).await, refused(401, "unauthorized"), "{path}");
        }
        for (path, body) in [
            ("/api/s/1u/Messages", json!({})),
            ("/api/w/1u/wiadomosci/5", json!([])),
            ("/api/admin/emails", json!({ "email": "new@x.pl" })),
            ("/api/push", json!({ "endpoint": "https://fcm.googleapis.com/x" })),
        ] {
            assert_eq!(ask(Method::POST, path, "0000", Some(body)).await, refused(401, "unauthorized"), "{path}");
        }

        assert_eq!(ask(Method::DELETE, "/api/me", "0000", None).await, refused(401, "unauthorized"));
        // The privacy notice and the build's state are read before signing in.
        assert_eq!(ask(Method::GET, "/api/about", "0000", None).await.0, 200);

        // The access list belongs to the administrators.
        assert_eq!(ask(Method::GET, "/api/admin/emails", &user, None).await, refused(403, "forbidden"));
        assert_eq!(ask(Method::POST, "/api/admin/emails", &user, Some(json!({ "email": "new@x.pl" }))).await, refused(403, "forbidden"));
        assert_eq!(ask(Method::DELETE, "/api/admin/emails/guest@x.pl", &user, None).await, refused(403, "forbidden"));
        assert!(!app.store.is_allowed("new@x.pl") && app.store.is_allowed("guest@x.pl"));
        assert_eq!(ask(Method::GET, "/api/admin/emails", &admin, None).await.0, 200);

        // Writes outside the lists and paths that could leave the API are refused before any request goes out.
        assert_eq!(ask(Method::POST, "/api/s/1u/Grades", &user, Some(json!({}))).await, refused(403, "bad_path"));
        assert_eq!(ask(Method::POST, "/api/w/1u/usun_wiadomosc", &user, Some(json!([]))).await, refused(403, "bad_path"));
        assert_eq!(ask(Method::GET, "/api/s/1u/Grades/..%2Fx", &user, None).await, refused(400, "bad_path"));
        assert_eq!(ask(Method::GET, "/api/s/1u/Grades%3Fx", &user, None).await, refused(400, "bad_path"));
        assert_eq!(ask(Method::GET, "/api/w/1u/ustawienia", &user, None).await, refused(400, "bad_path"));
        // Another family's student is not on this account.
        assert_eq!(ask(Method::GET, "/api/s/2u/Grades", &user, None).await, refused(404, "no_account"));
        assert_eq!(ask(Method::POST, "/api/w/2u/wiadomosci/5", &user, Some(json!([]))).await, refused(404, "no_account"));

        // A session does not outlive the address on the list.
        assert_eq!(ask(Method::GET, "/api/me", &guest, None).await.0, 200);
        assert_eq!(ask(Method::DELETE, "/api/admin/emails/guest@x.pl", &admin, None).await.0, 200);
        assert_eq!(ask(Method::GET, "/api/me", &guest, None).await, refused(401, "unauthorized"));

        // Deleting one's own data ends the session and leaves nothing behind.
        assert_eq!(ask(Method::DELETE, "/api/me", &user, None).await.0, 204);
        assert_eq!(ask(Method::GET, "/api/me", &user, None).await, refused(401, "unauthorized"));
        assert!(app.store.tokens("user@x.pl", Some(&user)).is_none());
    }

    #[test]
    fn email_shape() {
        assert!(valid_email("jan.kowalski+szkola@example.com"));
        for bad in ["", "jan", "@example.com", "jan@example", "jan@@example.com", "jan kowalski@example.com", "jan@exa\nmple.com"] {
            assert!(!valid_email(bad), "{bad:?}");
        }
        assert!(!valid_email(&format!("{}@example.com", "a".repeat(250))));
    }

    /// What GitHub's comparison with main makes of an "official" build.
    #[tokio::test]
    async fn github_confirms_the_commit() {
        let compare = async |Path((_, _, range)): Path<(String, String, String)>| -> Response {
            match range.trim_start_matches("main...") {
                "on" => Json(json!({ "status": "behind" })).into_response(),
                "tip" => Json(json!({ "status": "identical" })).into_response(),
                "fork" => Json(json!({ "status": "diverged" })).into_response(),
                "odd" => Json(json!({})).into_response(),
                "gone" => StatusCode::NOT_FOUND.into_response(),
                _ => StatusCode::FORBIDDEN.into_response(),
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().route("/repos/{owner}/{repo}/compare/{range}", get(compare));
        tokio::spawn(axum::serve(listener, router).into_future());
        let http = reqwest::Client::new();
        for (commit, want) in
            [("on", "official"), ("tip", "official"), ("fork", "modified"), ("gone", "modified"), ("odd", "unknown"), ("limit", "unknown")]
        {
            assert_eq!(confirm(&http, &base, "official", commit).await, want, "{commit}");
        }
        // Nothing to confirm otherwise, and nothing is asked.
        assert_eq!(confirm(&http, "http://127.0.0.1:9", "modified", "on").await, "modified");
        assert_eq!(confirm(&http, "http://127.0.0.1:9", "unknown", "").await, "unknown");
        assert_eq!(confirm(&http, "http://127.0.0.1:9", "official", "on").await, "unknown", "GitHub out of reach");
    }
}

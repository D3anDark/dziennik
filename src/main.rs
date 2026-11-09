mod librus;
mod store;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use store::{SESSION_TTL_SECS, Store, Tokens};

const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
const LOGIN_MAX_ATTEMPTS: usize = 5;

static API_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_,-]+(/[A-Za-z0-9_,-]+)*$").expect("static regex"));

struct App {
    store: Store,
    http: reqwest::Client,
    allowed: HashSet<String>,
    // Keys are allowlisted emails only, so the map is bounded by ALLOWED_EMAILS.
    attempts: Mutex<HashMap<String, Vec<Instant>>>,
    // ponytail: one lock serializes every token refresh; per-user locks if the group grows.
    refresh_lock: tokio::sync::Mutex<()>,
}

type Shared = State<Arc<App>>;

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

fn me_json(email: &str, t: &Tokens) -> Value {
    let accounts: Vec<Value> = t
        .accounts
        .iter()
        .map(|a| json!({ "login": a.login, "name": a.student_name, "state": a.state }))
        .collect();
    json!({ "email": email, "accounts": accounts })
}

impl App {
    fn user(&self, headers: &HeaderMap) -> Result<String, ApiError> {
        sid(headers)
            .and_then(|s| self.store.session_email(s))
            .ok_or(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"))
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
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(State(app): Shared, Json(b): Json<LoginBody>) -> Result<Response, ApiError> {
    let typed = b.email.trim();
    let email = typed.to_lowercase();
    if !app.allowed.contains(&email) {
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
    Ok(([(header::SET_COOKIE, session_cookie(&sid, SESSION_TTL_SECS))], Json(me_json(&email, &t))).into_response())
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
    Ok(Json(me_json(&email, &t)))
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
    let mut url = reqwest::Url::parse(&format!("{}/{path}", librus::API)).expect("API base is a valid URL");
    url.set_query(query.as_deref());
    forward(&app, &email, &login, |token| app.http.get(url.clone()).bearer_auth(token)).await
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
    let url = format!("{}/{path}", librus::API);
    forward(&app, &email, &login, |token| app.http.post(&url).bearer_auth(token).json(&body)).await
}

/// Sends `req` with the account token, retrying once with a refreshed token on 401, and streams the answer back.
/// Librus rejects a stale token before acting, so the retry cannot repeat a write.
async fn forward(
    app: &App,
    email: &str,
    login: &str,
    req: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<Response, ApiError> {
    let token = account_token(&app.store.tokens(email).ok_or(RELOGIN)?, login)?;
    let mut res = req(&token).send().await.map_err(librus::Error::from)?;
    if res.status() == StatusCode::UNAUTHORIZED {
        let fresh = app.refresh_synergia(email, login, &token).await?;
        res = req(&fresh).send().await.map_err(librus::Error::from)?;
    }
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
    let allowed: HashSet<String> = env("ALLOWED_EMAILS", "")
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if allowed.is_empty() {
        return Err("ALLOWED_EMAILS is empty".into());
    }
    let store = Store::open(&env("DB", "dziennik.db"), &env("SECRET_KEY", ""))?;
    let http = reqwest::Client::builder()
        .timeout(librus::TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let app = Arc::new(App {
        store,
        http,
        allowed,
        attempts: Mutex::default(),
        refresh_lock: tokio::sync::Mutex::default(),
    });

    let router = Router::new()
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/s/{login}/{*path}", get(proxy).post(write))
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

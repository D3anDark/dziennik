//! Pages of the Synergia website, read with a session opened from the API token (POST AutoLoginToken, then
//! /loguj/token/<token>/przenies/<path>).
//! The website gives every account the modules the API keeps for paid ones. Messages are sent the way its own form
//! does it: POST getRecipients for the people of a group, then the form of wiadomosci/2/5 (new) or
//! wiadomosci/3/5/<id> (reply) as multipart.

use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::LOCATION;
use reqwest::multipart::Form;
use reqwest::{Client, StatusCode, Url, redirect};
use serde_json::Value;

use crate::{ApiError, App, librus};

/// A session nobody used for this long is dropped here; the website ends its own after a pause too.
const IDLE: Duration = Duration::from_secs(20 * 60);
const MAX_SESSIONS: usize = 200;
const MAX_PAGE: usize = 2 * 1024 * 1024;
/// On every page of the message module, and not on the sign-in page an ended session is given instead. The reply
/// form has only the second.
const SIGNED_IN: [&str; 2] = ["container-message", "formWiadomosci"];
/// Attachments are handed out by this host under a keyed link that needs no session.
const FILES_HOST: &str = "sandbox.librus.pl";
const UPSTREAM: ApiError = ApiError(StatusCode::BAD_GATEWAY, "upstream");

pub struct Session {
    client: Client,
    used: Instant,
}

async fn sign_in(app: &App, email: &str, sid: Option<&str>, login: &str) -> Result<Client, ApiError> {
    let url = format!("{}/AutoLoginToken", app.api);
    let res = app.send(email, sid, login, |t| app.http.post(&url).bearer_auth(t)).await?;
    if !res.status().is_success() {
        eprintln!("librus: AutoLoginToken answered {}", res.status());
        return Err(UPSTREAM);
    }
    let body: Value = res.json().await.map_err(librus::Error::from)?;
    // The token becomes a path segment.
    let token = body["Token"]
        .as_str()
        .filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .ok_or(UPSTREAM)?;
    let client = Client::builder()
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .redirect(redirect::Policy::none())
        .timeout(librus::TIMEOUT)
        .pool_max_idle_per_host(1)
        .build()
        .map_err(librus::Error::from)?;
    // The answer sets the session cookies and redirects to the page, which the caller fetches itself.
    let res = client
        .get(format!("{}/loguj/token/{token}/przenies/wiadomosci", app.synergia))
        .send()
        .await
        .map_err(librus::Error::from)?;
    if !res.status().is_redirection() {
        eprintln!("librus: the website answered the sign-in token with {}", res.status());
        return Err(UPSTREAM);
    }
    Ok(client)
}

fn sessions(app: &App) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Session>> {
    app.web.lock().unwrap_or_else(|p| p.into_inner())
}

async fn session(app: &App, email: &str, sid: Option<&str>, login: &str, key: &str) -> Result<Client, ApiError> {
    {
        let mut all = sessions(app);
        all.retain(|_, s| s.used.elapsed() < IDLE);
        if let Some(s) = all.get_mut(key) {
            s.used = Instant::now();
            return Ok(s.client.clone());
        }
    }
    let client = sign_in(app, email, sid, login).await?;
    let mut all = sessions(app);
    if all.len() >= MAX_SESSIONS
        && let Some(oldest) = all.iter().min_by_key(|(_, s)| s.used).map(|(k, _)| k.clone())
    {
        all.remove(&oldest);
    }
    all.insert(key.to_string(), Session { client: client.clone(), used: Instant::now() });
    Ok(client)
}

async fn text(mut res: reqwest::Response) -> Result<String, ApiError> {
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(librus::Error::from)? {
        if body.len() + chunk.len() > MAX_PAGE {
            return Err(UPSTREAM);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn html(res: reqwest::Response) -> Result<Option<String>, ApiError> {
    if !res.status().is_success() {
        return Ok(None);
    }
    let page = text(res).await?;
    Ok(SIGNED_IN.iter().any(|mark| page.contains(mark)).then_some(page))
}

fn file_link(res: &reqwest::Response) -> Option<String> {
    let to = res.headers().get(LOCATION)?.to_str().ok()?;
    let url = Url::parse(to).ok()?;
    (res.status().is_redirection() && url.scheme() == "https" && url.host_str() == Some(FILES_HOST)).then(|| to.to_string())
}

/// `path` on the website as its signed-in user: the HTML of a page, or for `file` the link the site redirects to.
/// A session that ended in the meantime is opened again, once.
pub async fn read(app: &App, email: &str, sid: Option<&str>, login: &str, path: &str, file: bool) -> Result<String, ApiError> {
    let key = format!("{email}/{login}");
    let url = format!("{}/{path}", app.synergia);
    for _ in 0..2 {
        let client = session(app, email, sid, login, &key).await?;
        let res = client.get(&url).send().await.map_err(librus::Error::from)?;
        let found = if file { file_link(&res) } else { html(res).await? };
        if let Some(found) = found {
            return Ok(found);
        }
        sessions(app).remove(&key);
    }
    eprintln!("librus: the website did not serve a page of the message module after signing in");
    Err(UPSTREAM)
}

/// Submits a form of the message module as the signed-in user and returns what the site answers with: a page, or
/// nothing for a redirect. Never repeated, because a second attempt could send a message twice; the caller reads the
/// form page first, which opens the session this request needs.
pub async fn post(app: &App, email: &str, sid: Option<&str>, login: &str, path: &str, fields: Vec<(String, String)>, multipart: bool) -> Result<String, ApiError> {
    let client = session(app, email, sid, login, &format!("{email}/{login}")).await?;
    let req = client.post(format!("{}/{path}", app.synergia));
    let req = if multipart {
        req.multipart(fields.into_iter().fold(Form::new(), |form, (name, value)| form.text(name, value)))
    } else {
        req.form(&fields)
    };
    let res = req.send().await.map_err(librus::Error::from)?;
    if res.status().is_redirection() {
        return Ok(String::new());
    }
    if !res.status().is_success() {
        eprintln!("librus: the website answered a form with {}", res.status());
        return Err(UPSTREAM);
    }
    text(res).await
}

/// Sessions of an address that lost access.
pub fn forget(app: &App, email: &str) {
    let prefix = format!("{email}/");
    sessions(app).retain(|k, _| !k.starts_with(&prefix));
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::Mutex;

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, Method, Uri, header};
    use axum::response::{IntoResponse, Response};

    use super::*;
    use crate::push::Vapid;
    use crate::store::{Account, Store, Tokens};

    /// Stands in for the API and the website. `live` is the number of the one session the site still honours.
    #[derive(Default)]
    struct Site {
        calls: Mutex<Vec<String>>,
        /// Content type and body of every form the site received.
        posted: Mutex<Vec<String>>,
        issued: Mutex<u32>,
        live: Mutex<u32>,
    }

    async fn site(State(site): State<Arc<Site>>, method: Method, uri: Uri, headers: HeaderMap, body: axum::body::Bytes) -> Response {
        let path = uri.path();
        site.calls.lock().unwrap().push(format!("{method} {path}"));
        if path == "/AutoLoginToken" {
            let mut n = site.issued.lock().unwrap();
            *n += 1;
            return axum::Json(serde_json::json!({ "Token": format!("T{n}") })).into_response();
        }
        if let Some(n) = path.strip_prefix("/loguj/token/T").and_then(|p| p.strip_suffix("/przenies/wiadomosci")) {
            *site.live.lock().unwrap() = n.parse().unwrap();
            let cookie = format!("DZIENNIKSID=s{n}; Path=/");
            return (StatusCode::FOUND, [(header::SET_COOKIE, cookie), (header::LOCATION, "/wiadomosci".into())]).into_response();
        }
        let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or_default();
        let signed_in = cookie == format!("DZIENNIKSID=s{}", site.live.lock().unwrap());
        if method == Method::POST {
            let kind = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).and_then(|v| v.split(';').next()).unwrap_or_default();
            site.posted.lock().unwrap().push(format!("{kind} {}", String::from_utf8_lossy(&body)));
            return match (path, signed_in) {
                ("/getRecipients", true) => r#"<input type="checkbox" name="DoKogo[]" value="7">"#.into_response(),
                ("/wiadomosci/5", true) => (StatusCode::FOUND, [(header::LOCATION, "/wiadomosci/5")]).into_response(),
                _ => StatusCode::FORBIDDEN.into_response(),
            };
        }
        match (path, signed_in) {
            ("/wiadomosci/5", true) => r#"<table class="stretch container-message"><tr><td>odebrane</td></tr></table>"#.into_response(),
            ("/wiadomosci/3/5/9", true) => r#"<FORM ID="formWiadomosci"><input name="typ" value="odp"></FORM>"#.into_response(),
            ("/wiadomosci/pobierz_zalacznik/1/2", true) => {
                (StatusCode::FOUND, [(header::LOCATION, "https://sandbox.librus.pl/GetFile/key")]).into_response()
            }
            ("/wiadomosci/pobierz_zalacznik/9/9", true) => (StatusCode::FOUND, [(header::LOCATION, "https://evil.example/x")]).into_response(),
            (_, false) if path.contains("pobierz") => (StatusCode::FOUND, [(header::LOCATION, "/loguj")]).into_response(),
            _ => r#"<form action="/loguj"></form>"#.into_response(),
        }
    }

    #[tokio::test]
    async fn website_session() {
        let fixture = Arc::new(Site::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(axum::serve(listener, Router::new().fallback(site).with_state(fixture.clone())).into_future());
        let app = App {
            store: Store::open(":memory:", &"ab".repeat(32)).unwrap(),
            http: Client::new(),
            admins: HashSet::new(),
            allowed: HashSet::new(),
            attempts: Default::default(),
            failed: Default::default(),
            refresh_lock: Default::default(),
            api: base.clone(),
            synergia: base.clone(),
            web: Default::default(),
            vapid: Vapid::load(&Vapid::generate().unwrap(), "a@x.pl").unwrap(),
            wake: tokio::sync::Notify::new(),
            days: Mutex::default(),
            operator: String::new(),
            build: "official",
        };
        let account = Account { login: "1u".into(), access_token: Some("tok".into()), student_name: None, state: None };
        app.store.put_tokens("a@x.pl", &Tokens { access: "p".into(), refresh: "r".into(), accounts: vec![account] }).unwrap();
        let calls = || std::mem::take(&mut *fixture.calls.lock().unwrap());
        let page = || read(&app, "a@x.pl", None, "1u", "wiadomosci/5", false);

        // The first read signs in with a token from the API; the next one reuses the cookies.
        assert!(page().await.unwrap().contains("odebrane"));
        assert_eq!(calls(), ["POST /AutoLoginToken", "GET /loguj/token/T1/przenies/wiadomosci", "GET /wiadomosci/5"]);
        assert!(page().await.is_ok());
        assert_eq!(calls(), ["GET /wiadomosci/5"]);

        // The site ended the session: its sign-in page is not passed on, the session is opened again.
        *fixture.live.lock().unwrap() = 0;
        assert!(page().await.unwrap().contains("odebrane"));
        assert_eq!(calls(), ["GET /wiadomosci/5", "POST /AutoLoginToken", "GET /loguj/token/T2/przenies/wiadomosci", "GET /wiadomosci/5"]);

        // An attachment is the keyed link the site redirects to, and only on the files host.
        let file = |path: &'static str| read(&app, "a@x.pl", None, "1u", path, true);
        assert_eq!(file("wiadomosci/pobierz_zalacznik/1/2").await.unwrap(), "https://sandbox.librus.pl/GetFile/key");
        assert!(file("wiadomosci/pobierz_zalacznik/9/9").await.is_err());
        calls();

        // Someone else's student has no token here, so no session either.
        assert!(read(&app, "b@x.pl", None, "1u", "wiadomosci/5", false).await.is_err());
        assert!(calls().is_empty());

        forget(&app, "a@x.pl");
        assert!(page().await.is_ok());
        assert_eq!(calls()[0], "POST /AutoLoginToken");

        // The reply form is a page of the module too, though it lacks the marker the folders have.
        assert!(read(&app, "a@x.pl", None, "1u", "wiadomosci/3/5/9", false).await.unwrap().contains("odp"));
        calls();

        // A form goes out once, in the encoding the site's own form uses, on the session the page was read with.
        let fields = |pairs: &[(&str, &str)]| pairs.iter().map(|&(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let people = post(&app, "a@x.pl", None, "1u", "getRecipients", fields(&[("typAdresata", "nauczyciel")]), false).await.unwrap();
        assert!(people.contains("DoKogo[]"));
        let message = fields(&[("temat", "Zażółć"), ("DoKogo[]", "7")]);
        assert_eq!(post(&app, "a@x.pl", None, "1u", "wiadomosci/5", message.clone(), true).await.unwrap(), "", "a redirect has no page");
        assert_eq!(calls(), ["POST /getRecipients", "POST /wiadomosci/5"]);
        let posted = std::mem::take(&mut *fixture.posted.lock().unwrap());
        assert_eq!(posted[0], "application/x-www-form-urlencoded typAdresata=nauczyciel");
        assert!(posted[1].starts_with("multipart/form-data "), "{}", posted[1]);
        assert!(posted[1].contains("name=\"DoKogo[]\"\r\n\r\n7\r\n") && posted[1].contains("name=\"temat\"\r\n\r\nZażółć\r\n"), "{}", posted[1]);

        // The site refuses the form: it is not sent a second time, with or without a new session.
        *fixture.live.lock().unwrap() = 0;
        assert!(post(&app, "a@x.pl", None, "1u", "wiadomosci/5", message, true).await.is_err());
        assert_eq!(calls(), ["POST /wiadomosci/5"]);
    }

    #[test]
    fn readable_paths() {
        for ok in ["wiadomosci/5", "wiadomosci/6", "wiadomosci/1/5/123456/f0", "wiadomosci/2/5", "wiadomosci/3/5/123456"] {
            assert!(crate::WEB_PAGE_RE.is_match(ok), "{ok}");
        }
        for bad in ["wiadomosci/7", "wiadomosci/2/6", "wiadomosci/3/5/1/x", "wiadomosci/1/5/1/f0/../../x", "ustawienia", "wiadomosci/1/5/abc/f0", "wiadomosci/5?x=1"] {
            assert!(!crate::WEB_PAGE_RE.is_match(bad) && !crate::WEB_FILE_RE.is_match(bad), "{bad}");
        }
        assert!(crate::WEB_FILE_RE.is_match("wiadomosci/pobierz_zalacznik/123/456"));
    }
}

//! Server-side sign-in to the Librus portal (OAuth2 authorization code, public client).

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use regex::Regex;
use reqwest::header::LOCATION;
use reqwest::{Client, RequestBuilder, StatusCode, Url, redirect};
use serde::Deserialize;

use crate::store::Account;

pub const PORTAL: &str = "https://portal.librus.pl";
pub const API: &str = "https://api.librus.pl/3.0";
pub const SYNERGIA: &str = "https://synergia.librus.pl";
const CLIENT_ID: &str = "VaItV6oRutdo8fnjJwysnTjVlvaswf52ZqmXsJGP";
const REDIRECT_URI: &str = "app://librus";
const MAX_HOPS: usize = 10;
pub const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub enum Error {
    /// With what the login page said in its alert, as plain text (may be empty).
    BadCredentials(String),
    Captcha,
    /// Portal answered 503/424 for a Synergia account: technical break.
    Maintenance,
    /// Upstream returned a non-success status.
    Status(StatusCode),
    /// Portal flow ended somewhere we do not understand; carries the URL path only.
    Flow(String),
    Http(reqwest::Error),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e)
    }
}

#[derive(Deserialize)]
pub struct PortalToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct Me {
    email: String,
}

#[derive(Deserialize)]
struct Accounts {
    accounts: Vec<Account>,
}

#[derive(Debug, PartialEq)]
pub struct Form {
    pub action: String,
    pub hidden: Vec<(String, String)>,
}

enum Hop {
    Code(String),
    Page(Url, String),
}

fn allowed_host(u: &Url) -> bool {
    u.scheme() == "https"
        && u.host_str().is_some_and(|h| h == "librus.pl" || h.ends_with(".librus.pl"))
}

fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"").replace("&#039;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

static ATTR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).expect("static regex"));
static FORM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<form\b([^>]*)>(.*?)</form>").expect("static regex"));
static INPUT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<input\b([^>]*)>").expect("static regex"));
static ALERT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<(?:span|div|p)\b[^>]*\brole\s*=\s*["']alert["'][^>]*>(.*?)</(?:span|div|p)>"#).expect("static regex"));
static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").expect("static regex"));

fn attrs(tag: &str) -> Vec<(String, String)> {
    ATTR_RE
        .captures_iter(tag)
        .map(|c| {
            let v = c.get(2).or(c.get(3)).map_or("", |m| m.as_str());
            (c[1].to_ascii_lowercase(), unescape(v))
        })
        .collect()
}

fn attr<'a>(a: &'a [(String, String)], name: &str) -> Option<&'a str> {
    a.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// Finds `<form id="login">` and returns its action plus every hidden input.
pub fn parse_login_form(html: &str) -> Option<Form> {
    FORM_RE.captures_iter(html).find_map(|f| {
        let fa = attrs(&f[1]);
        if attr(&fa, "id") != Some("login") {
            return None;
        }
        let hidden = INPUT_RE
            .captures_iter(&f[2])
            .filter_map(|i| {
                let ia = attrs(&i[1]);
                if !attr(&ia, "type")?.eq_ignore_ascii_case("hidden") {
                    return None;
                }
                Some((attr(&ia, "name")?.to_string(), attr(&ia, "value").unwrap_or("").to_string()))
            })
            .collect();
        Some(Form { action: attr(&fa, "action")?.to_string(), hidden })
    })
}

/// `app://librus/...?code=X` -> `X`.
pub fn code_from_redirect(location: &str) -> Option<String> {
    let u = Url::parse(location).ok()?;
    if u.scheme() != "app" {
        return None;
    }
    u.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()).filter(|c| !c.is_empty())
}

/// What the login page says in its alert after a refused sign-in: plain text on one line, at most 300 characters.
/// It is shown to the person and to the admin as text, never as markup.
fn alert(html: &str) -> String {
    let inner = ALERT_RE.captures(html).and_then(|c| c.get(1)).map_or("", |m| m.as_str());
    let text = unescape(&TAG_RE.replace_all(inner, " "));
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(300).collect()
}

pub fn classify_page(html: &str) -> Error {
    let lower = html.to_ascii_lowercase();
    if lower.contains("g-recaptcha") || lower.contains("grecaptcha") || lower.contains("recaptcha/api") {
        Error::Captcha
    } else if parse_login_form(html).is_some() {
        Error::BadCredentials(alert(html))
    } else {
        Error::Flow(String::new())
    }
}

async fn follow(client: &Client, mut req: RequestBuilder) -> Result<Hop, Error> {
    for _ in 0..MAX_HOPS {
        let res = req.send().await?;
        let url = res.url().clone();
        if !res.status().is_redirection() {
            if !res.status().is_success() {
                return Err(Error::Status(res.status()));
            }
            return Ok(Hop::Page(url, res.text().await?));
        }
        let loc = res
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| Error::Flow(url.path().to_string()))?;
        if loc.starts_with(REDIRECT_URI) {
            return code_from_redirect(loc).map(Hop::Code).ok_or_else(|| Error::Flow("app redirect without code".into()));
        }
        let next = url.join(loc).map_err(|_| Error::Flow(url.path().to_string()))?;
        if !allowed_host(&next) {
            return Err(Error::Flow(format!("redirect off librus.pl: {}", next.host_str().unwrap_or(""))));
        }
        req = client.get(next);
    }
    Err(Error::Flow("too many redirects".into()))
}

/// Logs into Konto LIBRUS with email+password and returns portal tokens.
pub async fn login(email: &str, password: &str) -> Result<PortalToken, Error> {
    let client = Client::builder()
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .redirect(redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()?;
    let start = format!("{PORTAL}/konto-librus/redirect/dru?action=login");
    let (page_url, html) = match follow(&client, client.get(start)).await? {
        Hop::Page(u, h) => (u, h),
        Hop::Code(c) => return exchange(&client, &c).await,
    };
    let form = parse_login_form(&html).ok_or_else(|| Error::Flow(format!("no login form at {}", page_url.path())))?;
    let action = page_url.join(&form.action).map_err(|_| Error::Flow("bad form action".into()))?;
    if !allowed_host(&action) {
        return Err(Error::Flow("form action off librus.pl".into()));
    }
    let mut fields = form.hidden;
    fields.push(("email".into(), email.into()));
    fields.push(("password".into(), password.into()));
    match follow(&client, client.post(action).form(&fields)).await? {
        Hop::Code(c) => exchange(&client, &c).await,
        Hop::Page(u, h) => Err(match classify_page(&h) {
            Error::Flow(_) => Error::Flow(u.path().to_string()),
            e => e,
        }),
    }
}

async fn token_request(client: &Client, form: reqwest::multipart::Form) -> Result<PortalToken, Error> {
    let res = client.post(format!("{PORTAL}/oauth2/access_token")).multipart(form).send().await?;
    if !res.status().is_success() {
        return Err(Error::Status(res.status()));
    }
    Ok(res.json().await?)
}

async fn exchange(client: &Client, code: &str) -> Result<PortalToken, Error> {
    let form = reqwest::multipart::Form::new()
        .text("grant_type", "authorization_code")
        .text("client_id", CLIENT_ID)
        .text("redirect_uri", REDIRECT_URI)
        .text("code", code.to_string());
    token_request(client, form).await
}

pub async fn refresh(client: &Client, refresh_token: &str) -> Result<PortalToken, Error> {
    let form = reqwest::multipart::Form::new()
        .text("grant_type", "refresh_token")
        .text("client_id", CLIENT_ID)
        .text("refresh_token", refresh_token.to_string());
    token_request(client, form).await
}

async fn portal_get<T: for<'de> Deserialize<'de>>(client: &Client, token: &str, path: &str) -> Result<T, Error> {
    let res = client.get(format!("{PORTAL}/api/v3/{path}")).bearer_auth(token).send().await?;
    match res.status() {
        s if s.is_success() => Ok(res.json().await?),
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::FAILED_DEPENDENCY => Err(Error::Maintenance),
        s => Err(Error::Status(s)),
    }
}

pub async fn me_email(client: &Client, token: &str) -> Result<String, Error> {
    Ok(portal_get::<Me>(client, token, "Me").await?.email)
}

pub async fn accounts(client: &Client, token: &str) -> Result<Vec<Account>, Error> {
    Ok(portal_get::<Accounts>(client, token, "SynergiaAccounts").await?.accounts)
}

/// Mirrors the app's refreshSynergiaInstance: `fresh/{login}`, 410 falls back to `{login}`.
pub async fn fresh_account(client: &Client, token: &str, login: &str) -> Result<Account, Error> {
    match portal_get(client, token, &format!("SynergiaAccounts/fresh/{login}")).await {
        Err(Error::Status(StatusCode::GONE)) => portal_get(client, token, &format!("SynergiaAccounts/{login}")).await,
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = include_str!("../tests/login_page.html");

    #[test]
    fn parses_login_form() {
        let f = parse_login_form(PAGE).expect("form#login");
        assert_eq!(f.action, "https://portal.librus.pl/konto-librus/login/action");
        let names: Vec<&str> = f.hidden.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["redirectTo", "redirectCrc", "_token"]);
        assert_eq!(f.hidden[0].1, "/konto-librus/redirect/dru");
        assert!(matches!(classify_page(PAGE), Error::BadCredentials(said) if said.is_empty()));
        // The alert Librus adds to the form after a refused sign-in (seen live, 2026-11-12).
        let refused = PAGE.replace(
            "<form id=\"login\"",
            "<span class=\"common_alert--danger\" role=\"alert\">\n <strong>Upewnij się, że to nie dane\n SYNERGIA &amp; szkoły!</strong>\n</span><form id=\"login\"",
        );
        assert!(matches!(classify_page(&refused), Error::BadCredentials(said) if said == "Upewnij się, że to nie dane SYNERGIA & szkoły!"));
        assert!(matches!(classify_page("<div class=\"g-recaptcha\"></div>"), Error::Captcha));
        assert!(matches!(classify_page("<h1>Regulamin</h1>"), Error::Flow(_)));
    }

    #[test]
    fn extracts_code() {
        assert_eq!(code_from_redirect("app://librus/code?code=abc123&state=x").as_deref(), Some("abc123"));
        assert_eq!(code_from_redirect("app://librus?code="), None);
        assert_eq!(code_from_redirect("https://evil/?code=abc"), None);
        assert!(allowed_host(&Url::parse("https://portal.librus.pl/x").unwrap()));
        assert!(!allowed_host(&Url::parse("https://librus.pl.evil.com/").unwrap()));
        assert!(!allowed_host(&Url::parse("http://portal.librus.pl/").unwrap()));
    }
}

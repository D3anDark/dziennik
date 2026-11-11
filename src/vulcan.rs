//! VULCAN (eduVULCAN) through the mobile API of its own app, "Hebe CE". The user signs in on eduvulcan.pl in their
//! own browser and pastes the page https://eduvulcan.pl/api/ap here; the server registers itself as a mobile device
//! with the one-off tokens on that page and from then on signs every request with its own RSA key. No eduVULCAN
//! password reaches this server.
//!
//! The wire format follows the open-source client Dzienniczek-CLI (github.com/MatissowyMati/Dzienniczek-CLI, October
//! 2026). Nothing here has been run against a live VULCAN account.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::encoding::{AsDer, Pkcs8V1Der, PublicKeyX509Der};
use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::rsa::{KeyPair, KeySize};
use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_SHA256};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use regex::Regex;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const BASE: &str = "https://lekcjaplus.vulcan.net.pl";
// What the official app calls itself, as Dzienniczek-CLI sends it: VULCAN may turn away a client it does not know.
const APP_NAME: &str = "DzienniczekPlus 3.0";
const APP_VERSION: &str = "26.04.01 (G)";
const VERSION_CODE: &str = "946";
const USER_AGENT: &str = "Dart/3.10 (dart:io)";
const OS: &str = "Android";
/// The name the device gets in the user's list of devices on eduvulcan.pl.
const DEVICE_MODEL: &str = "Dziennik (aplikacja nieoficjalna)";
/// Records per page, as the app asks; a longer list comes in pages, at most `MAX_PAGES` of them.
const PAGE: usize = 500;
const MAX_PAGES: usize = 6;
const MAX_BODY: usize = 2 * 1024 * 1024;
/// The first page and no sync date: "everything", in the API's words.
const FIRST_ID: i64 = i32::MIN as i64;
const NO_SYNC: &str = "1970-01-01 01:00:00";
/// Most tokens taken from one paste; a family has a token per school system, rarely more than two.
const MAX_TOKENS: usize = 20;
/// The student list (with the school year's periods) is read again at most this often, and only when no period
/// covers today.
const RESYNC_SECS: i64 = 24 * 3600;
/// Status codes VULCAN gives a token it will not take: used, wrong, expired.
const BAD_TOKEN: &[i64] = &[200, 201, 202, 204];
/// Status codes for a device VULCAN no longer knows (removed on eduvulcan.pl): the user has to paste a new code.
const UNKNOWN_DEVICE: &[i64] = &[108, 154];

#[derive(Debug)]
pub enum Error {
    /// The tokens were refused at registration.
    Token,
    /// VULCAN does not know this device any more.
    Device,
    /// Registered, but VULCAN never names the e-mail address the user signed in with.
    NotVouched,
    NoPupils,
    /// A status code of VULCAN's own (Status.Code) other than the above, and its message.
    Refused(i64, String),
    Status(StatusCode),
    /// An answer that is not the API's JSON: a maintenance page, a cut connection.
    Garbled,
    /// Something the app asked for is not on the list, or lacks a date or a period.
    Query,
    Key,
    Http(reqwest::Error),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e)
    }
}

/// One registered device: what the server keeps inside the encrypted tokens of the user.
#[derive(Serialize, Deserialize, Clone)]
pub struct Cred {
    /// RSA private key, PKCS#8 DER in base64.
    key: String,
    fingerprint: String,
    pub pupils: Vec<Pupil>,
    /// When the student list was last read, Unix seconds.
    synced: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Pupil {
    /// The app's name for the student, `v-<tenant>-<pupil id>`; the frontend tells VULCAN students by the `v-`.
    pub login: String,
    pub name: String,
    tenant: String,
    /// The school's API root, under `BASE`.
    rest: String,
    unit: i64,
    pupil: i64,
    constituent: i64,
    periods: Vec<Period>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Period {
    pub id: i64,
    pub number: i64,
    level: i64,
    pub from: String,
    pub to: String,
}

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` date that exists (days_from_civil, H. Hinnant).
pub fn days(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !s.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (s[0..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let n = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    (date(n) == s).then_some(n)
}

/// `YYYY-MM-DD` of a day number from `days` (civil_from_days).
pub fn date(n: i64) -> String {
    let z = n + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{:04}-{m:02}-{d:02}", yoe + era * 400 + i64::from(m <= 2))
}

/// The date part of a VULCAN date: a string like "2026-09-01", "2026-09-01 08:00:00" or "2026-09-01T08:00:00", or an
/// object with a `Date` (the older API).
fn day(v: &Value) -> Option<String> {
    let s = v.as_str().or_else(|| v["Date"].as_str())?;
    let d = s.get(..10)?;
    days(d).map(|_| d.to_string())
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// MD5 (RFC 1321). VULCAN's app names its key by the MD5 of the PEM text; the hash protects nothing here.
fn md5(data: &[u8]) -> [u8; 16] {
    const S: [u32; 16] = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
        0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
        0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
        0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64).wrapping_mul(8)).to_le_bytes());
    let mut h = [0x67452301u32, 0xefcdab89, 0x98badcfe, 0x10325476];
    for chunk in msg.chunks_exact(64) {
        let m: Vec<u32> = chunk.chunks_exact(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let [mut a, mut b, mut c, mut d] = h;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f.wrapping_add(a).wrapping_add(K[i]).wrapping_add(m[g]);
            (a, d, c) = (d, c, b);
            b = b.wrapping_add(f.rotate_left(S[i / 16 * 4 + i % 4]));
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 16];
    for (i, x) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x.to_le_bytes());
    }
    out
}

/// What VULCAN signs a request by: the path from `api/mobile/` on, percent-encoded and lower-cased. The query is not
/// part of it (Dzienniczek-CLI signs the path alone).
fn canonical(url: &str) -> String {
    let path = url.find("api/mobile/").map_or("", |at| &url[at..]);
    let path = path.split('?').next().unwrap_or_default();
    path.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b.to_ascii_lowercase() as char).to_string() } else { format!("%{b:02x}") })
        .collect()
}

/// The device key that signs requests.
struct Signer {
    key: KeyPair,
    fingerprint: String,
}

impl Signer {
    fn new() -> Result<(Self, String), Error> {
        let key = KeyPair::generate(KeySize::Rsa2048).map_err(|_| Error::Key)?;
        let public: PublicKeyX509Der = key.public_key().as_der().map_err(|_| Error::Key)?;
        let certificate = B64.encode(public.as_ref());
        let lines: Vec<&str> = certificate.as_bytes().chunks(64).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect();
        let pem = format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", lines.join("\n"));
        let fingerprint = md5(pem.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        Ok((Self { key, fingerprint }, certificate))
    }

    fn load(cred: &Cred) -> Result<Self, Error> {
        let der = B64.decode(&cred.key).map_err(|_| Error::Key)?;
        Ok(Self { key: KeyPair::from_pkcs8(&der).map_err(|_| Error::Key)?, fingerprint: cred.fingerprint.clone() })
    }

    fn pkcs8(&self) -> Result<String, Error> {
        let der: Pkcs8V1Der = self.key.as_der().map_err(|_| Error::Key)?;
        Ok(B64.encode(der.as_ref()))
    }

    /// vCanonicalUrl, vDate, Digest (with a body) and the Signature over them.
    fn headers(&self, url: &str, body: Option<&str>, at: SystemTime) -> Result<Vec<(&'static str, String)>, Error> {
        let canonical = canonical(url);
        let date = httpdate::fmt_http_date(at);
        let digest = body.map(|b| B64.encode(Sha256::digest(b.as_bytes())));
        let names = if digest.is_some() { "vCanonicalUrl Digest vDate" } else { "vCanonicalUrl vDate" };
        let signed = format!("{canonical}{}{date}", digest.as_deref().unwrap_or_default());
        let mut sig = vec![0; self.key.public_modulus_len()];
        self.key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), signed.as_bytes(), &mut sig).map_err(|_| Error::Key)?;
        let mut out = vec![
            ("vCanonicalUrl", canonical),
            ("vDate", date),
            (
                "Signature",
                format!(
                    r#"keyId="{}",headers="{names}",algorithm="sha256",signature=Base64(sha256withrsa({}))"#,
                    self.fingerprint,
                    B64.encode(&sig)
                ),
            ),
        ];
        if let Some(d) = digest {
            out.push(("Digest", format!("SHA-256={d}")));
        }
        Ok(out)
    }

    /// One API call. `envelope` makes it a POST. Answers the `Envelope` of a status 0 answer.
    async fn call(&self, http: &Client, url: &str, query: &[(&str, String)], hint: Option<i64>, envelope: Option<Value>) -> Result<Value, Error> {
        let at = SystemTime::now();
        let body = envelope.map(|e| {
            let secs = at.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
            json!({
                "AppName": APP_NAME,
                "AppVersion": APP_VERSION,
                "NotificationToken": "",
                "API": 1,
                "RequestId": uuid(),
                "Timestamp": secs,
                "TimestampFormatted": format!("{} {:02}:{:02}:{:02}", date(secs.div_euclid(86_400)), secs / 3600 % 24, secs / 60 % 60, secs % 60),
                "Envelope": e,
            })
            .to_string()
        });
        let full = reqwest::Url::parse_with_params(url, query).map_err(|_| Error::Query)?;
        let mut req = match &body {
            Some(b) => http.post(full).header("Content-Type", "application/json; charset=utf-8").body(b.clone()),
            None => http.get(full).header("Content-Type", "application/json"),
        };
        req = req.header("vOS", OS).header("vVersionCode", VERSION_CODE).header("vAPI", "1").header("User-Agent", USER_AGENT);
        if let Some(h) = hint {
            req = req.header("vHint", h.to_string());
        }
        for (k, v) in self.headers(url, body.as_deref(), at)? {
            req = req.header(k, v);
        }
        let mut res = req.send().await?;
        if res.status() != StatusCode::OK {
            return Err(Error::Status(res.status()));
        }
        let mut raw = Vec::new();
        while let Some(chunk) = res.chunk().await? {
            if raw.len() + chunk.len() > MAX_BODY {
                return Err(Error::Garbled);
            }
            raw.extend_from_slice(&chunk);
        }
        let v: Value = serde_json::from_slice(&raw).map_err(|_| Error::Garbled)?;
        match v["Status"]["Code"].as_i64() {
            Some(0) => Ok(v["Envelope"].clone()),
            Some(c) if UNKNOWN_DEVICE.contains(&c) => Err(Error::Device),
            Some(c) => Err(Error::Refused(c, v["Status"]["Message"].as_str().unwrap_or_default().chars().take(200).collect())),
            None => Err(Error::Garbled),
        }
    }

    /// A list, page by page while pages come full. The next page starts after the highest id so far.
    async fn list(&self, http: &Client, p: &Pupil, endpoint: &str, query: Vec<(&str, String)>) -> Result<Value, Error> {
        let url = format!("{}/{endpoint}", p.rest);
        let mut all = Vec::new();
        let mut last = FIRST_ID;
        for _ in 0..MAX_PAGES {
            let mut q = query.clone();
            q.push(("lastId", last.to_string()));
            q.push(("pageSize", PAGE.to_string()));
            let page = match self.call(http, &url, &q, Some(p.pupil), None).await? {
                Value::Array(a) => a,
                Value::Null => Vec::new(),
                _ => return Err(Error::Garbled),
            };
            let (n, next) = (page.len(), page.iter().filter_map(|x| x["Id"].as_i64()).max());
            all.extend(page);
            match next {
                Some(id) if n >= PAGE && id > last => last = id,
                _ => break,
            }
        }
        Ok(Value::Array(all))
    }
}

/// A token from eduvulcan.pl/api/ap and what it says about itself. Read without checking its signature: VULCAN
/// checks it at registration, and nothing is believed before that succeeds.
#[derive(Debug)]
pub struct Jwt {
    raw: String,
    tenant: String,
    name: String,
    pub exp: i64,
}

static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").expect("static regex"));
static TENANT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("static regex"));

/// The student tokens in whatever the user pasted: the page source of eduvulcan.pl/api/ap, its JSON, or tokens
/// alone. With a `Tokens` list in the text only that list counts (the page also carries a token of another kind).
pub fn tokens(text: &str) -> Vec<Jwt> {
    let text = text.replace("&quot;", "\"");
    let scope = text.find("\"Tokens\"").map_or(text.as_str(), |at| {
        let rest = &text[at..];
        &rest[..rest.find(']').unwrap_or(rest.len())]
    });
    let mut out: Vec<Jwt> = Vec::new();
    for m in JWT_RE.find_iter(scope) {
        let Some(claims) = m.as_str().split('.').nth(1).and_then(|p| B64URL.decode(p.trim_end_matches('=')).ok()) else { continue };
        let Ok(c) = serde_json::from_slice::<Value>(&claims) else { continue };
        let Some(tenant) = c["tenant"].as_str().filter(|t| TENANT_RE.is_match(t)) else { continue };
        if out.iter().any(|j| j.raw == m.as_str()) {
            continue;
        }
        out.push(Jwt {
            raw: m.as_str().to_string(),
            tenant: tenant.to_string(),
            name: c["name"].as_str().unwrap_or_default().trim().to_lowercase(),
            exp: c["exp"].as_i64().unwrap_or(i64::MAX),
        });
        if out.len() == MAX_TOKENS {
            break;
        }
    }
    out
}

/// The e-mail address VULCAN vouches for, wherever it may stand: in the tokens it has just accepted, in its answer to
/// the registration, or in the student list. Which of them carries it is not known yet, so each is tried; none of
/// them can be forged by the user once VULCAN accepted the tokens.
fn vouched(email: &str, jwts: &[Jwt], registered: &[Value], accounts: &[Value]) -> bool {
    let named = |v: &Value| [v.as_str(), v["Value"].as_str()].into_iter().flatten().any(|s| s.trim().to_lowercase() == email);
    jwts.iter().any(|j| j.name == email)
        || registered.iter().any(|r| ["UserLogin", "UserName", "Login"].iter().any(|k| named(&r[*k])))
        || accounts.iter().any(|a| named(&a["Login"]))
}

fn pupil(base: &str, tenant: &str, a: &Value) -> Option<Pupil> {
    let rest = a["Unit"]["RestURL"].as_str()?.trim_end_matches('/');
    // The key signs nothing outside VULCAN's own API.
    if !rest.starts_with(&format!("{base}/")) {
        return None;
    }
    let id = a["Pupil"]["Id"].as_i64()?;
    let name = [&a["Pupil"]["FirstName"], &a["Pupil"]["Surname"]].iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" ");
    let periods = a["Periods"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|p| {
            Some(Period {
                id: p["Id"].as_i64()?,
                number: p["Number"].as_i64().unwrap_or(1),
                level: p["Level"].as_i64().unwrap_or(0),
                from: day(&p["StartAt"]).or_else(|| day(&p["Start"]))?,
                to: day(&p["EndAt"]).or_else(|| day(&p["End"]))?,
            })
        })
        .collect();
    Some(Pupil {
        login: format!("v-{tenant}-{id}"),
        name,
        tenant: tenant.to_string(),
        rest: rest.to_string(),
        unit: a["Unit"]["Id"].as_i64()?,
        pupil: id,
        constituent: a["ConstituentUnit"]["Id"].as_i64()?,
        periods,
    })
}

async fn students(http: &Client, base: &str, signer: &Signer, tenant: &str) -> Result<Vec<Value>, Error> {
    let url = format!("{base}/{tenant}/api/mobile/register/hebe");
    match signer.call(http, &url, &[("mode", "2".into())], None, None).await? {
        Value::Array(a) => Ok(a),
        _ => Err(Error::Garbled),
    }
}

/// Registers a new device with the tokens, one school system (tenant) at a time, and reads its students. Succeeds
/// only when VULCAN names `email` as the account the tokens belong to.
pub async fn sign_in(http: &Client, base: &str, jwts: &[Jwt], email: &str) -> Result<Cred, Error> {
    let (signer, certificate) = tokio::task::spawn_blocking(Signer::new).await.map_err(|_| Error::Key)??;
    let device = uuid();
    let mut by_tenant: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for j in jwts {
        by_tenant.entry(&j.tenant).or_default().push(&j.raw);
    }
    let (mut registered, mut accounts, mut pupils) = (Vec::new(), Vec::new(), Vec::new());
    for (tenant, raw) in by_tenant {
        let url = format!("{base}/{tenant}/api/mobile/register/jwt");
        let envelope = json!({
            "OS": OS,
            "Certificate": certificate,
            "CertificateType": "RSA_PEM",
            "DeviceModel": DEVICE_MODEL,
            "SelfIdentifier": device,
            "CertificateThumbprint": signer.fingerprint,
            "Tokens": raw,
        });
        let answer = signer.call(http, &url, &[], None, Some(envelope)).await.map_err(|e| match e {
            Error::Refused(c, _) if BAD_TOKEN.contains(&c) => Error::Token,
            e => e,
        })?;
        registered.push(answer);
        let list = students(http, base, &signer, tenant).await?;
        pupils.extend(list.iter().filter_map(|a| pupil(base, tenant, a)));
        accounts.extend(list);
    }
    if !vouched(email, jwts, &registered, &accounts) {
        let shape = |v: bool| if v { "present" } else { "absent" };
        eprintln!(
            "vulcan: no e-mail matched (token name {}, registration fields {}, account logins {})",
            shape(jwts.iter().any(|j| j.name.contains('@'))),
            shape(registered.iter().any(|r| r.get("UserLogin").or(r.get("UserName")).or(r.get("Login")).is_some())),
            shape(accounts.iter().any(|a| !a["Login"].is_null())),
        );
        return Err(Error::NotVouched);
    }
    if pupils.is_empty() {
        return Err(Error::NoPupils);
    }
    Ok(Cred { key: signer.pkcs8()?, fingerprint: signer.fingerprint, pupils, synced: now() })
}

impl Pupil {
    fn current(&self, today: i64) -> Option<&Period> {
        self.periods.iter().find(|p| days(&p.from).is_some_and(|f| f <= today) && days(&p.to).is_some_and(|t| today <= t))
    }

    /// The periods of the school year that is on (or the last one, between years): the ones at the class level of
    /// the current period.
    // shortcut: a student repeating a year has two school years at one level and sees both; key them by dates if that matters.
    pub fn year(&self, today: i64) -> Vec<&Period> {
        let Some(now) = self.current(today).or_else(|| self.periods.iter().max_by(|a, b| a.to.cmp(&b.to))) else { return Vec::new() };
        let mut out: Vec<&Period> = self.periods.iter().filter(|p| p.level == now.level).collect();
        out.sort_by(|a, b| a.from.cmp(&b.from));
        out
    }
}

impl Cred {
    /// No period covers today (a new school year) and the list was not read in the last day.
    pub fn stale(&self, today: i64) -> bool {
        now() - self.synced > RESYNC_SECS && self.pupils.iter().any(|p| p.current(today).is_none())
    }

    /// Reads the student lists again for their periods. Students stay as they were signed in; one gone from VULCAN
    /// keeps its last periods.
    pub async fn resync(&mut self, http: &Client, base: &str) -> Result<(), Error> {
        self.synced = now();
        let signer = Signer::load(self)?;
        let mut tenants: Vec<String> = self.pupils.iter().map(|p| p.tenant.clone()).collect();
        tenants.dedup();
        let mut fresh: HashMap<String, Pupil> = HashMap::new();
        for t in &tenants {
            for a in students(http, base, &signer, t).await? {
                if let Some(p) = pupil(base, t, &a) {
                    fresh.insert(p.login.clone(), p);
                }
            }
        }
        for p in &mut self.pupils {
            if let Some(f) = fresh.remove(&p.login) {
                *p = f;
            }
        }
        Ok(())
    }
}

/// What the app may read for one student, by the name it asks for. `from`/`to` are dates (`YYYY-MM-DD`), `period` one
/// of the student's periods; the student's own ids are filled in here, never taken from the request.
pub async fn read(http: &Client, cred: &Cred, p: &Pupil, what: &str, from: Option<&str>, to: Option<&str>, period: Option<i64>) -> Result<Value, Error> {
    let dated = |q: &mut Vec<(&str, String)>| -> Result<(), Error> {
        let (Some(f), Some(t)) = (from.filter(|d| days(d).is_some()), to.filter(|d| days(d).is_some())) else { return Err(Error::Query) };
        q.push(("dateFrom", f.to_string()));
        q.push(("dateTo", t.to_string()));
        Ok(())
    };
    let period = || period.filter(|id| p.periods.iter().any(|x| x.id == *id)).map(|id| id.to_string()).ok_or(Error::Query);
    let (unit, pupil) = (("unitId", p.unit.to_string()), ("pupilId", p.pupil.to_string()));
    let sync = ("lastSyncDate", NO_SYNC.to_string());
    let signer = Signer::load(cred)?;
    let (endpoint, query) = match what {
        "grades" => ("mobile/grade/byPupil", vec![unit, pupil, ("periodId", period()?), sync]),
        "averages" => ("mobile/grade/average/byPupil", vec![unit, pupil, ("periodId", period()?), ("scope", "auto".into())]),
        "notes" => ("mobile/note/byPupil", vec![pupil, sync]),
        "announcements" => ("mobile/announcement/byPupil", vec![unit, pupil, ("view", "6".into())]),
        "lessons" | "schedule" | "exams" | "homework" | "vacations" => {
            let mut q = vec![pupil];
            dated(&mut q)?;
            q.push(sync);
            let endpoint = match what {
                "lessons" => "mobile/lesson/byPupil",
                "schedule" => "mobile/schedule/withchanges/byPupil",
                "exams" => "mobile/exam/byPupil",
                "homework" => "mobile/homework/byPupil",
                _ => "mobile/school/vacation",
            };
            (endpoint, q)
        }
        "lucky" => {
            let day = from.filter(|d| days(d).is_some()).ok_or(Error::Query)?;
            let q = [pupil, ("constituentId", p.constituent.to_string()), ("day", day.to_string())];
            return signer.call(http, &format!("{}/mobile/school/lucky", p.rest), &q, Some(p.pupil), None).await;
        }
        _ => return Err(Error::Query),
    };
    signer.list(http, p, endpoint, query).await
}

/// What the notification round compares, by the activity kind it reports: (kind, short tag, deletions count).
/// Lists read for a window of dates lose entries that only left the window, so their deletions are not news.
const WATCHED: &[(&str, &str, bool)] = &[
    ("Grades", "G", true),
    ("Notes", "N", true),
    ("SchoolNotices", "S", true),
    ("Attendances", "A", false),
    ("HomeWorks", "E", false),
    ("HomeWorkAssignments", "H", false),
    ("Calendars/Substitutions", "P", false),
];
/// Marks a stored state, so a student with nothing yet is told about the first entry.
const STATE: &str = "v1";

fn version(v: &Value) -> String {
    Sha256::digest(v.to_string().as_bytes())[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// `tag:id:version` of every entry worth a notification. Attendance counts only when it is not plain presence, a
/// timetable entry only with a change in it.
fn entries(tag: &str, list: &Value) -> Vec<String> {
    list.as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|x| {
            let id = x["Id"].as_i64()?;
            let seen = match tag {
                "A" => {
                    let t = &x["PresenceType"];
                    if t.is_null() || t["Presence"] == true {
                        return None;
                    }
                    t["Id"].clone()
                }
                "P" => {
                    if x["Substitution"].is_null() {
                        return None;
                    }
                    x["Substitution"].clone()
                }
                "G" => json!([x["Content"], x["ModifiedAt"]]),
                _ => x["ModifiedAt"].clone(),
            };
            Some(format!("{tag}:{id}:{}", version(&seen)))
        })
        .collect()
}

/// The state the notification round keeps for one student (in the feed's `register` column).
pub async fn snapshot(http: &Client, cred: &Cred, p: &Pupil, today: i64) -> Result<String, Error> {
    let span = |a: i64, b: i64| (date(today + a), date(today + b));
    let mut out = vec![STATE.to_string()];
    if let Some(period) = p.current(today) {
        out.extend(entries("G", &read(http, cred, p, "grades", None, None, Some(period.id)).await?));
    }
    for (what, tag, (from, to)) in [
        ("notes", "N", span(0, 0)),
        ("announcements", "S", span(0, 0)),
        ("lessons", "A", span(-14, 0)),
        ("exams", "E", span(-7, 90)),
        ("homework", "H", span(-7, 90)),
        ("schedule", "P", span(0, 13)),
    ] {
        out.extend(entries(tag, &read(http, cred, p, what, Some(&from), Some(&to), None).await?));
    }
    Ok(out.join(","))
}

/// What changed between two states, as activity entries: (kind, Add|Edit|Delete, id). Nothing before a first state.
pub fn diff(old: &str, new: &str) -> Vec<(&'static str, &'static str, String)> {
    let parse = |s: &str| -> BTreeMap<(String, String), String> {
        s.split(',')
            .filter_map(|e| {
                let mut it = e.splitn(3, ':');
                Some(((it.next()?.to_string(), it.next()?.to_string()), it.next()?.to_string()))
            })
            .collect()
    };
    if !old.starts_with(STATE) {
        return Vec::new();
    }
    let (was, now) = (parse(old), parse(new));
    let kind = |tag: &str| WATCHED.iter().find(|w| w.1 == tag);
    let mut out = Vec::new();
    for ((tag, id), v) in &now {
        let Some(&(k, ..)) = kind(tag) else { continue };
        match was.get(&(tag.clone(), id.clone())) {
            None => out.push((k, "Add", id.clone())),
            Some(w) if w != v => out.push((k, "Edit", id.clone())),
            _ => {}
        }
    }
    for (tag, id) in was.keys() {
        if let Some(&(k, _, true)) = kind(tag)
            && !now.contains_key(&(tag.clone(), id.clone()))
        {
            out.push((k, "Delete", id.clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_vectors() {
        let hex = |d: &[u8]| md5(d).iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        assert_eq!(hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890".as_bytes()), "57edf4a22be3c955ac49da2e2107b67a");
    }

    #[test]
    fn calendar_days() {
        assert_eq!(days("1970-01-01"), Some(0));
        assert_eq!(days("2026-09-01").map(date).as_deref(), Some("2026-09-01"));
        assert_eq!(days("2028-02-29").map(|d| date(d + 1)).as_deref(), Some("2028-03-01"));
        assert_eq!(days("2026-02-29"), None);
        assert_eq!(days("2026-9-01"), None);
        assert_eq!(days("+026-09-01"), None);
        assert_eq!(day(&json!("2026-09-01 08:00:00")).as_deref(), Some("2026-09-01"));
        assert_eq!(day(&json!({ "Date": "2026-09-01" })).as_deref(), Some("2026-09-01"));
    }

    #[test]
    fn signs_and_reloads_the_device_key() {
        use aws_lc_rs::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
        let (signer, certificate) = Signer::new().unwrap();
        assert_eq!(B64.decode(certificate).unwrap()[0], 0x30, "DER");
        let at = UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000);
        let h = signer.headers("https://x/t/api/mobile/register/hebe?mode=2", Some("{}"), at).unwrap();
        let get = |k: &str| h.iter().find(|x| x.0 == k).map(|x| x.1.clone()).unwrap();
        assert_eq!(get("vDate"), "Fri, 15 Jan 2027 08:00:00 GMT");
        let signature = get("Signature");
        let b64 = signature.split("sha256withrsa(").nth(1).unwrap().trim_end_matches("))");
        let signed = format!("{}{}{}", get("vCanonicalUrl"), B64.encode(Sha256::digest(b"{}")), get("vDate"));
        let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, signer.key.public_key().as_ref());
        assert!(public.verify(signed.as_bytes(), &B64.decode(b64).unwrap()).is_ok());
        let cred = Cred { key: signer.pkcs8().unwrap(), fingerprint: signer.fingerprint.clone(), pupils: vec![], synced: 0 };
        assert_eq!(Signer::load(&cred).unwrap().fingerprint, signer.fingerprint);
    }

    #[test]
    fn canonical_url() {
        assert_eq!(
            canonical("https://lekcjaplus.vulcan.net.pl/zyrardow/000088/api/mobile/grade/byPupil?pupilId=1"),
            "api%2fmobile%2fgrade%2fbypupil"
        );
    }

    fn jwt(claims: Value) -> String {
        format!("eyJhbGciOiJSUzI1NiJ9.{}.c2ln", B64URL.encode(claims.to_string()))
    }

    #[test]
    fn tokens_from_a_paste() {
        let a = jwt(json!({ "tenant": "zyrardow", "name": "Ola@Example.pl", "exp": 100 }));
        let b = jwt(json!({ "tenant": "warszawa", "name": "ola@example.pl" }));
        let other = jwt(json!({ "tenant": "zyrardow", "name": "x" }));
        let page = format!(
            r#"<input id="ap" type="hidden" value="{{&quot;Tokens&quot;:[&quot;{a}&quot;,&quot;{b}&quot;,&quot;{a}&quot;],&quot;AccessToken&quot;:&quot;{other}&quot;}}">"#
        );
        let found = tokens(&page);
        assert_eq!(found.iter().map(|j| j.tenant.as_str()).collect::<Vec<_>>(), ["zyrardow", "warszawa"]);
        assert_eq!((found[0].name.as_str(), found[0].exp, found[1].exp), ("ola@example.pl", 100, i64::MAX));
        // A token alone, and one whose tenant could leave the URL path, which is dropped.
        assert_eq!(tokens(&format!(" {a}\n")).len(), 1);
        assert!(tokens(&jwt(json!({ "tenant": "../x" }))).is_empty());
        assert!(tokens("nic tu nie ma").is_empty());
    }

    #[test]
    fn email_is_vouched_by_vulcan() {
        let j = tokens(&jwt(json!({ "tenant": "t", "name": "Jan Kowalski" })));
        assert!(!vouched("a@x.pl", &j, &[json!({})], &[json!({ "Login": null })]));
        assert!(vouched("a@x.pl", &j, &[json!({ "UserLogin": "A@x.pl" })], &[]));
        assert!(vouched("a@x.pl", &j, &[], &[json!({ "Login": { "Value": "a@x.pl" } })]));
        assert!(vouched("a@x.pl", &tokens(&jwt(json!({ "tenant": "t", "name": "a@x.pl" }))), &[], &[]));
    }

    #[test]
    fn pupils_stay_on_the_api_host() {
        let a = json!({
            "Unit": { "Id": 2, "RestURL": "https://lekcjaplus.vulcan.net.pl/t/000088/api/" },
            "ConstituentUnit": { "Id": 3 },
            "Pupil": { "Id": 7, "FirstName": "Ola", "Surname": "Nowak" },
            "Periods": [
                { "Id": 11, "Number": 1, "Level": 5, "StartAt": "2026-09-01", "EndAt": "2027-01-31" },
                { "Id": 12, "Number": 2, "Level": 5, "StartAt": "2027-02-01", "EndAt": "2027-08-31" },
                { "Id": 9, "Number": 2, "Level": 4, "StartAt": "2026-02-01", "EndAt": "2026-08-31" }
            ]
        });
        let p = pupil(BASE, "t", &a).unwrap();
        assert_eq!((p.login.as_str(), p.name.as_str(), p.rest.as_str()), ("v-t-7", "Ola Nowak", "https://lekcjaplus.vulcan.net.pl/t/000088/api"));
        let ids = |d: &str| p.year(days(d).unwrap()).iter().map(|x| x.id).collect::<Vec<_>>();
        assert_eq!(ids("2027-03-10"), [11, 12]);
        assert_eq!(ids("2026-05-10"), [9]);
        assert_eq!(ids("2027-09-10"), [11, 12]);
        let mut elsewhere = a.clone();
        elsewhere["Unit"]["RestURL"] = json!("https://evil.example/api");
        assert!(pupil(BASE, "t", &elsewhere).is_none());
    }

    #[test]
    fn changes_between_states() {
        let lessons = json!([
            { "Id": 1, "PresenceType": { "Id": 1, "Presence": true } },
            { "Id": 2, "PresenceType": { "Id": 3, "Presence": false } },
            { "Id": 3, "PresenceType": null }
        ]);
        assert_eq!(entries("A", &lessons).len(), 1);
        let grades = |content: &str| entries("G", &json!([{ "Id": 5, "Content": content, "ModifiedAt": "x" }, { "Id": 6, "Content": "3", "ModifiedAt": "x" }]));
        let state = |g: Vec<String>, rest: &[&str]| [vec![STATE.to_string()], g, rest.iter().map(|s| s.to_string()).collect()].concat().join(",");
        let old = state(grades("4"), &["E:1:aa", "N:9:aa"]);
        let new = state(grades("5")[..1].to_vec(), &["E:2:aa", "A:4:bb"]);
        let mut got = diff(&old, &new);
        got.sort();
        assert_eq!(
            got,
            [
                ("Attendances", "Add", "4".to_string()),
                ("Grades", "Delete", "6".to_string()),
                ("Grades", "Edit", "5".to_string()),
                ("HomeWorks", "Add", "2".to_string()),
                ("Notes", "Delete", "9".to_string()),
            ]
        );
        // The first state is history, not news, even when it is empty.
        assert!(diff("", &new).is_empty());
        assert_eq!(diff(STATE, &state(vec![], &["N:1:aa"])), [("Notes", "Add", "1".to_string())]);
    }
}

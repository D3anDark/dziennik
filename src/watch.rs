//! Notifications: reads the Librus change feed without a push token (ChangeRegister with sendPush=0, then
//! PushChanges) and forwards what is new as Web Push messages.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{RequestBuilder, StatusCode};
use serde_json::{Value, json};
use tokio::time::MissedTickBehavior;

use crate::App;
use crate::push::{self, Sent, Subscription};

// shortcut: one fixed interval for everyone, upgrade to a per-user setting if someone asks for a different pace.
const EVERY: Duration = Duration::from_secs(10 * 60);
/// The version of the app this flow was read from; Librus stores it with the registration.
const APP_VERSION: &str = "8.4.3";
/// The app acknowledges changes 30 at a time.
const ACK_CHUNK: usize = 30;
/// Longest list of attendance ids looked up in one request.
const MAX_LOOKUP: usize = 100;
const MAX_BODY: usize = 1024 * 1024;
/// Standard attendance type "present". School-defined types point at a standard one through StandardType.
const PRESENT: &str = "100";
/// Tokens are dead until the user signs in again; the feed waits for that instead of retrying every round.
const RELOGIN: &str = "relogin";

/// Change feed resource types worth a message, from change-processor.js: (type, what the user reads, page).
/// Left out on purpose: Realizations and PlannedLessons (one per lesson, every day) and LuckyNumbers (daily).
const KINDS: &[(&str, &str, &str)] = &[
    ("Grades", "oceny", "oceny"),
    ("PointGrades", "oceny", "oceny"),
    ("TextGrades", "oceny", "oceny"),
    ("DescriptiveGrades", "oceny", "oceny"),
    ("DescriptiveTextGrades", "oceny", "oceny"),
    ("PartialDescriptiveGrades", "oceny", "oceny"),
    ("BehaviourGrades", "zachowanie", "zachowanie"),
    ("BehaviourGrades/Points", "zachowanie", "zachowanie"),
    ("Attendances", "frekwencja", "frekwencja"),
    ("Notes", "uwagi", "uwagi"),
    ("Messages", "wiadomości", "wiadomosci"),
    ("SchoolNotices", "ogłoszenia", "ogloszenia"),
    ("HomeWorkAssignments", "zadania domowe", "zadania"),
    ("HomeWorks", "terminarz", "terminarz"),
    ("ParentTeacherConferences", "terminarz", "terminarz"),
    ("Calendars/ClassFreeDays", "terminarz", "terminarz"),
    ("Calendars/TeacherFreeDays", "terminarz", "terminarz"),
    ("Calendars/SchoolFreeDays", "terminarz", "terminarz"),
    ("Calendars/Substitutions", "plan lekcji", "plan"),
    ("Timetables", "plan lekcji", "plan"),
];

struct Change {
    id: String,
    /// Add, Edit or Delete.
    how: String,
    kind: String,
    resource: Option<String>,
}

impl Change {
    /// Worth telling the user: a kind the app shows, and for attendance anything but plain presence. A deleted
    /// attendance entry cannot be looked up any more, so it stays out.
    fn news(&self, absences: &HashSet<String>) -> bool {
        KINDS.iter().any(|k| k.0 == self.kind)
            && (self.kind != "Attendances" || self.resource.as_ref().is_some_and(|r| absences.contains(r)))
    }
}

/// Librus sends ids as numbers or strings; they end up in URLs, so anything else is refused.
fn id(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (!s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then_some(s)
}

fn changes(body: &Value) -> Vec<Change> {
    let list = body["Changes"].as_array().map_or(&[][..], Vec::as_slice);
    list.iter()
        .filter_map(|c| {
            Some(Change {
                id: id(&c["Id"])?,
                how: c["Type"].as_str().filter(|h| ["Add", "Edit", "Delete"].contains(h))?.to_string(),
                kind: c["Resource"]["Type"].as_str().unwrap_or_default().to_string(),
                resource: id(&c["Resource"]["Id"]),
            })
        })
        .collect()
}

/// "Nowe: oceny (2), frekwencja. Zmienione: oceny." and the page of the first entry. None when nothing is news.
fn summary(changes: &[Change], absences: &HashSet<String>) -> Option<(String, &'static str)> {
    let mut page = None;
    let mut sentences = Vec::new();
    for (how, lead) in [("Add", "Nowe"), ("Edit", "Zmienione"), ("Delete", "Usunięte")] {
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for c in changes.iter().filter(|c| c.how == how && c.news(absences)) {
            let Some(&(_, label, to)) = KINDS.iter().find(|k| k.0 == c.kind) else { continue };
            page.get_or_insert(to);
            match counts.iter_mut().find(|x| x.0 == label) {
                Some(x) => x.1 += 1,
                None => counts.push((label, 1)),
            }
        }
        let parts: Vec<String> = counts.iter().map(|&(label, n)| if n > 1 { format!("{label} ({n})") } else { label.to_string() }).collect();
        if !parts.is_empty() {
            sentences.push(format!("{lead}: {}.", parts.join(", ")));
        }
    }
    Some((sentences.join(" "), page?))
}

/// One Synergia call for one student. Errors are the short codes the frontend already translates.
async fn call(app: &App, email: &str, login: &str, req: impl Fn(&str) -> RequestBuilder) -> Result<reqwest::Response, String> {
    app.send(email, None, login, req).await.map_err(|e| e.1.to_string())
}

async fn json_body(mut res: reqwest::Response) -> Result<Value, String> {
    if !res.status().is_success() {
        return Err(format!("http_{}", res.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| "upstream")? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("upstream".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "upstream".into())
}

async fn get(app: &App, email: &str, login: &str, path: &str) -> Result<Value, String> {
    let url = format!("{}/{path}", app.api);
    json_body(call(app, email, login, |t| app.http.get(&url).bearer_auth(t)).await?).await
}

/// Of the changed attendance entries, the ones that are not plain presence. Empty when Librus does not say:
/// staying quiet beats a message for every lesson.
async fn absences(app: &App, email: &str, login: &str, changes: &[Change]) -> HashSet<String> {
    let ids: Vec<&str> = changes
        .iter()
        .filter(|c| c.kind == "Attendances" && c.how != "Delete")
        .filter_map(|c| c.resource.as_deref())
        .take(MAX_LOOKUP)
        .collect();
    if ids.is_empty() {
        return HashSet::new();
    }
    let (Ok(types), Ok(entries)) =
        (get(app, email, login, "Attendances/Types").await, get(app, email, login, &format!("Attendances/{}", ids.join(","))).await)
    else {
        return HashSet::new();
    };
    let standard: HashMap<String, String> = types["Types"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|t| Some((id(&t["Id"])?, if t["Standard"] == true { id(&t["Id"])? } else { id(&t["StandardType"]["Id"])? })))
        .collect();
    // A list of ids answers under either key, like every Synergia list.
    let one = [entries["Attendance"].clone()];
    let list = entries["Attendances"].as_array().map_or(&one[..], Vec::as_slice);
    list.iter()
        .filter_map(|a| {
            let kind = id(&a["Type"]["Id"])?;
            (standard.get(&kind).unwrap_or(&kind) != PRESENT).then(|| id(&a["Id"])).flatten()
        })
        .collect()
}

async fn notify(app: &App, devices: &[Subscription], message: &Value) {
    let payload = message.to_string();
    for d in devices {
        match push::send(&app.http, &app.vapid, d, payload.as_bytes()).await {
            Ok(Sent::Delivered) => {}
            Ok(Sent::Gone) => {
                if let Err(e) = app.store.remove_device(&d.endpoint, None) {
                    eprintln!("db: {e}");
                }
            }
            Err(e) => eprintln!("push: {e}"),
        }
    }
}

/// Reads one student's feed and returns the register id to keep (empty: register again next time).
async fn check(app: &App, email: &str, login: &str, name: &str, register: &str, devices: &[Subscription]) -> Result<String, String> {
    let fresh = register.is_empty();
    let register = if fresh {
        let url = format!("{}/ChangeRegister", app.api);
        let body = json!({ "sendPush": "0", "appVersion": APP_VERSION });
        let made = json_body(call(app, email, login, |t| app.http.post(&url).bearer_auth(t).json(&body)).await?).await?;
        id(&made["ChangeRegister"]["Id"]).ok_or("upstream")?
    } else {
        register.to_string()
    };
    let url = format!("{}/PushChanges?pushDevice={register}", app.api);
    let res = call(app, email, login, |t| app.http.get(&url).bearer_auth(t)).await?;
    if res.status() == StatusCode::NOT_FOUND {
        // Librus forgot the registration: the app registers again, and so does the next round.
        return Ok(String::new());
    }
    let found = changes(&json_body(res).await?);
    // Acknowledged before anyone is told: if this failed after the messages went out, every round would repeat them.
    for chunk in found.chunks(ACK_CHUNK) {
        let ids: Vec<&str> = chunk.iter().map(|c| c.id.as_str()).collect();
        let url = format!("{}/PushChanges/{}?pushDevice={register}", app.api, ids.join(","));
        let res = call(app, email, login, |t| app.http.delete(&url).bearer_auth(t)).await?;
        if !res.status().is_success() {
            return Err(format!("http_{}", res.status().as_u16()));
        }
    }
    // What a new registration already holds is history, not news.
    if fresh {
        return Ok(register);
    }
    let absences = absences(app, email, login, &found).await;
    let news: Vec<(&str, &str, &str)> = found
        .iter()
        .filter(|c| c.news(&absences))
        .map(|c| (c.kind.as_str(), c.how.as_str(), c.resource.as_deref().unwrap_or_default()))
        .collect();
    if let Err(e) = app.store.add_activity(email, login, &news) {
        eprintln!("db: {e}");
    }
    if let Some((body, page)) = summary(&found, &absences) {
        notify(app, devices, &json!({ "title": name, "body": body, "url": format!("/#/{page}") })).await;
    }
    Ok(register)
}

/// One pass over every watched user. `all` is the timed round; an early one (a new device, a new login) only
/// touches feeds that are not running: unregistered, or stopped on an expired Librus session.
async fn round(app: &App, all: bool) {
    if let Err(e) = app.store.purge() {
        eprintln!("db: {e}");
    }
    let owners = app.store.watched().unwrap_or_else(|e| {
        eprintln!("db: {e}");
        Vec::new()
    });
    for email in owners.iter().filter(|e| app.is_allowed(e)) {
        let (Some(tokens), Ok(devices), Ok(feeds)) = (app.store.tokens(email, None), app.store.devices(email), app.store.feeds(email)) else {
            continue;
        };
        for account in tokens.accounts.iter().filter(|a| a.access_token.is_some()) {
            let (register, error) =
                feeds.iter().find(|f| f.0 == account.login).map_or(("", ""), |f| (f.1.as_str(), f.3.as_str()));
            let relogin = error == RELOGIN;
            let skip = if all { relogin } else { !register.is_empty() && !relogin };
            if skip {
                continue;
            }
            let name = account.student_name.as_deref().unwrap_or("Dziennik");
            let (register, error) = match check(app, email, &account.login, name, register, &devices).await {
                Ok(register) => (register, String::new()),
                Err(e) => (register.to_string(), e),
            };
            if let Err(e) = app.store.set_feed(email, &account.login, &register, &error) {
                eprintln!("db: {e}");
            }
        }
    }
}

/// Runs for the life of the server: one request at a time, so Librus sees a trickle whatever the group size.
pub async fn run(app: Arc<App>) {
    let mut tick = tokio::time::interval(EVERY);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        let all = tokio::select! {
            _ = tick.tick() => true,
            _ = app.wake.notified() => false,
        };
        round(&app, all).await;
    }
}

/// The user turned notifications off on their last device: take the registrations back from Librus, best effort.
// shortcut: signing out everywhere drops the tokens first, so those registrations stay at Librus unused;
// unregister in logout if Librus ever limits them per account.
pub async fn stop(app: &App, email: &str) {
    for (login, register, ..) in app.store.feeds(email).unwrap_or_default() {
        if !register.is_empty() {
            let url = format!("{}/ChangeRegister/{register}", app.api);
            let _ = call(app, email, &login, |t| app.http.delete(&url).bearer_auth(t)).await;
        }
    }
    if let Err(e) = app.store.clear_feeds(email) {
        eprintln!("db: {e}");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use aws_lc_rs::agreement::{ECDH_P256, PrivateKey};
    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, Method, Uri};
    use axum::response::{IntoResponse, Response};

    use super::*;
    use crate::push::Vapid;
    use crate::store::{Account, Store, Tokens};

    fn change(id: u32, kind: &str, resource: u32, how: &str) -> Value {
        json!({ "Id": id, "Type": how, "Resource": { "Id": resource.to_string(), "Type": kind } })
    }

    #[test]
    fn summary_text() {
        let found = changes(&json!({ "Changes": [
            change(1, "Grades", 10, "Add"),
            change(2, "PointGrades", 11, "Edit"),
            change(3, "Attendances", 12, "Add"),
            change(4, "Attendances", 13, "Add"),
            change(5, "Realizations", 14, "Add"),
            change(6, "Notes", 15, "Delete"),
            { "Id": "../x", "Type": "Add", "Resource": { "Id": 1, "Type": "Grades" } },
        ] }));
        assert_eq!(found.len(), 6, "an id that is not a plain token never reaches a URL");
        let absent = HashSet::from(["13".to_string()]);
        assert_eq!(
            summary(&found, &absent),
            Some(("Nowe: oceny, frekwencja. Zmienione: oceny. Usunięte: uwagi.".to_string(), "oceny"))
        );
        assert_eq!(summary(&found[2..5], &HashSet::new()), None, "presence and lesson topics stay quiet");
    }

    /// Stands in for both the Synergia API and a push service.
    #[derive(Default)]
    struct Fixture {
        calls: Mutex<Vec<String>>,
        pending: Mutex<Vec<Value>>,
        forgotten: Mutex<bool>,
        pushed: Mutex<Vec<(HeaderMap, Bytes)>>,
    }

    async fn fixture(State(fx): State<Arc<Fixture>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
        let path = uri.path_and_query().map_or("", |p| p.as_str());
        fx.calls.lock().unwrap().push(format!("{method} {path} {}", String::from_utf8_lossy(&body)).trim_end().to_string());
        if let Some(device) = path.strip_prefix("/push/") {
            if device == "dead" {
                return StatusCode::GONE.into_response();
            }
            fx.pushed.lock().unwrap().push((headers, body));
            return StatusCode::CREATED.into_response();
        }
        if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer tok") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let answer = match (method.as_str(), uri.path()) {
            ("POST", "/ChangeRegister") => json!({ "ChangeRegister": { "Id": 77 } }),
            ("GET", "/PushChanges") if *fx.forgotten.lock().unwrap() => return StatusCode::NOT_FOUND.into_response(),
            ("GET", "/PushChanges") => json!({ "Changes": *fx.pending.lock().unwrap() }),
            ("DELETE", p) if p.starts_with("/PushChanges/") => {
                fx.pending.lock().unwrap().clear();
                json!({})
            }
            ("DELETE", "/ChangeRegister/77") => json!({}),
            ("GET", "/Attendances/Types") => json!({ "Types": [
                { "Id": 100, "Standard": true },
                { "Id": 1, "Standard": true },
                { "Id": "2001", "Standard": false, "StandardType": { "Id": 100 } },
            ] }),
            ("GET", "/Attendances/12,13") => json!({ "Attendances": [
                { "Id": 12, "Type": { "Id": 2001 } },
                { "Id": "13", "Type": { "Id": "1" } },
            ] }),
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        axum::Json(answer).into_response()
    }

    #[tokio::test]
    async fn feed_becomes_push_messages() {
        let fx = Arc::new(Fixture::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(axum::serve(listener, Router::new().fallback(fixture).with_state(fx.clone())).into_future());

        let app = App {
            store: Store::open(":memory:", &"ab".repeat(32)).unwrap(),
            http: reqwest::Client::new(),
            admins: HashSet::new(),
            allowed: HashSet::new(),
            attempts: Default::default(),
            refresh_lock: Default::default(),
            api: base.clone(),
            synergia: base.clone(),
            web: Default::default(),
            vapid: Vapid::load(&Vapid::generate().unwrap(), "a@x.pl").unwrap(),
            wake: tokio::sync::Notify::new(),
            operator: String::new(),
            build: "official",
        };
        let account = Account { login: "1u".into(), access_token: Some("tok".into()), student_name: Some("Jan Testowy".into()), state: None };
        app.store.put_tokens("a@x.pl", &Tokens { access: "p".into(), refresh: "r".into(), accounts: vec![account] }).unwrap();
        app.store.allow("a@x.pl").unwrap();
        let receiver = PrivateKey::generate(&ECDH_P256).unwrap();
        for name in ["phone", "dead"] {
            let p256dh = receiver.compute_public_key().unwrap().as_ref().to_vec();
            app.store.add_device("a@x.pl", &Subscription { endpoint: format!("{base}/push/{name}"), p256dh, auth: vec![7; 16] }).unwrap();
        }
        let calls = || std::mem::take(&mut *fx.calls.lock().unwrap());
        let feed = || app.store.feeds("a@x.pl").unwrap().into_iter().map(|f| (f.1, f.3)).collect::<Vec<_>>();

        // A new device: the feed is registered, and what it already holds is acknowledged without a message.
        *fx.pending.lock().unwrap() = vec![change(1, "Grades", 10, "Add")];
        round(&app, false).await;
        assert_eq!(calls(), [
            r#"POST /ChangeRegister {"appVersion":"8.4.3","sendPush":"0"}"#,
            "GET /PushChanges?pushDevice=77",
            "DELETE /PushChanges/1?pushDevice=77",
        ]);
        assert_eq!(feed(), [("77".to_string(), String::new())]);

        // An early round leaves a running feed alone.
        round(&app, false).await;
        assert!(calls().is_empty());

        // The timed round: a grade and an absence are news, a presence of a school-defined type and a lesson topic are not.
        *fx.pending.lock().unwrap() = vec![
            change(5, "Grades", 20, "Add"),
            change(6, "Attendances", 12, "Add"),
            change(7, "Attendances", 13, "Add"),
            change(8, "Realizations", 30, "Add"),
        ];
        round(&app, true).await;
        let made = calls();
        assert_eq!(made[..4], [
            "GET /PushChanges?pushDevice=77",
            "DELETE /PushChanges/5,6,7,8?pushDevice=77",
            "GET /Attendances/Types",
            "GET /Attendances/12,13",
        ]);
        assert!(made.len() == 6 && made[4..].iter().all(|c| c.starts_with("POST /push/")), "{made:?}");
        let pushed = std::mem::take(&mut *fx.pushed.lock().unwrap());
        assert_eq!(pushed.len(), 1);
        let (headers, body) = &pushed[0];
        assert_eq!(headers["content-encoding"], "aes128gcm");
        assert_eq!(headers["ttl"], "86400");
        assert!(headers["authorization"].to_str().unwrap().starts_with("vapid t="));
        let message: Value = serde_json::from_slice(&crate::push::tests::decrypt(&receiver, &[7; 16], body)).unwrap();
        assert_eq!(message, json!({ "title": "Jan Testowy", "body": "Nowe: oceny, frekwencja.", "url": "/#/oceny" }));
        let kept: Vec<(String, String, String)> = app.store.activity("a@x.pl", "1u").unwrap().into_iter().map(|e| (e.1, e.2, e.3)).collect();
        assert_eq!(kept, [("Attendances".into(), "Add".into(), "13".into()), ("Grades".into(), "Add".into(), "20".into())], "the same news, newest first");
        let left: Vec<String> = app.store.devices("a@x.pl").unwrap().into_iter().map(|d| d.endpoint).collect();
        assert_eq!(left, [format!("{base}/push/phone")], "a subscription the push service dropped is forgotten");

        // Librus forgot the registration: the next round registers again.
        *fx.forgotten.lock().unwrap() = true;
        round(&app, true).await;
        assert_eq!(feed(), [(String::new(), String::new())]);
        *fx.forgotten.lock().unwrap() = false;
        calls();
        round(&app, true).await;
        assert_eq!(calls()[0], r#"POST /ChangeRegister {"appVersion":"8.4.3","sendPush":"0"}"#);

        // A dead Librus session parks the feed until the user signs in again.
        app.store.set_feed("a@x.pl", "1u", "77", RELOGIN).unwrap();
        round(&app, true).await;
        assert!(calls().is_empty());
        round(&app, false).await;
        assert_eq!(calls(), ["GET /PushChanges?pushDevice=77"]);
        assert_eq!(feed(), [("77".to_string(), String::new())]);

        // An address that lost access is not polled.
        app.store.revoke("a@x.pl", false).unwrap();
        round(&app, true).await;
        assert!(calls().is_empty());
        app.store.allow("a@x.pl").unwrap();

        stop(&app, "a@x.pl").await;
        assert_eq!(calls(), ["DELETE /ChangeRegister/77"]);
        assert!(feed().is_empty());
    }
}

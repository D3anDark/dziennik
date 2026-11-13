//! Notifications: reads the Librus change feed without a push token (ChangeRegister with sendPush=0, then
//! PushChanges) and forwards what is new as Web Push messages.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{RequestBuilder, StatusCode};
use serde_json::{Value, json};
use tokio::time::MissedTickBehavior;

use crate::push::{self, Sent, Subscription};
use crate::{App, breaks, librus};

// shortcut: one fixed interval for everyone, upgrade to a per-user setting if someone asks for a different pace.
const EVERY: Duration = Duration::from_secs(10 * 60);
/// The version of the app this flow was read from; Librus stores it with the registration.
const APP_VERSION: &str = "8.4.3";
/// The app acknowledges changes 30 at a time.
const ACK_CHUNK: usize = 30;
/// Longest list of ids looked up in one request, and most entries of one kind described in one round.
const MAX_LOOKUP: usize = 100;
/// Entries described line by line in one message; the rest are counted. With `MAX_LINE` this keeps a message far
/// below the push payload limit (`push::MAX_PAYLOAD`).
const MAX_LINES: usize = 5;
/// Characters of one line, the cut included.
const MAX_LINE: usize = 100;
const MAX_BODY: usize = 1024 * 1024;
/// Standard attendance type "present". School-defined types point at a standard one through StandardType.
const PRESENT: &str = "100";
/// Tokens are dead until the user signs in again; the feed waits for that instead of retrying every round.
const RELOGIN: &str = "relogin";

/// Change feed resource types worth a message, from change-processor.js: (type, what the user reads, page). The page
/// is also the kind of message a device can turn off (`GROUPS`). Left out on purpose: Realizations and PlannedLessons
/// (one per lesson, every day); LuckyNumbers get a message of their own (`lucky`).
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

/// The kinds of message a device can turn off: the pages of `KINDS`, the lucky number and the breaks (`breaks`).
pub const GROUPS: &[&str] =
    &["oceny", "zachowanie", "frekwencja", "uwagi", "wiadomosci", "ogloszenia", "zadania", "terminarz", "plan", "numerek", "przerwy"];

/// Whether a device whose `Subscription::off` is `off` wants messages of `group`.
pub fn wants(off: &str, group: &str) -> bool {
    !off.split(',').any(|g| g == group)
}

/// A device's quiet hours, "22:00-07:00", as minutes after midnight: (from, to). None for anything else, an empty
/// span included. What the server keeps is only what this reads.
pub fn quiet_hours(s: &str) -> Option<(u32, u32)> {
    let minute = |hm: &str| {
        let (h, m) = hm.split_once(':')?;
        let digits = h.len() == 2 && m.len() == 2 && h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit());
        let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
        (digits && h < 24 && m < 60).then_some(h * 60 + m)
    };
    let (from, to) = s.split_once('-')?;
    Some((minute(from)?, minute(to)?)).filter(|(from, to)| from != to)
}

/// Whether a device with these quiet hours gets nothing at `minute` of the Polish day (`breaks::local`). Hours that
/// end before they start run past midnight.
pub fn quiet_at(quiet: &str, minute: u32) -> bool {
    quiet_hours(quiet).is_some_and(|(from, to)| if from < to { (from..to).contains(&minute) } else { minute >= from || minute < to })
}

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
pub fn id(v: &Value) -> Option<String> {
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

/// A line of `details` for each entry that has one ("Nowa ocena: 5 · Matematyka"), at most `MAX_LINES`, then
/// "Nowe: oceny (2), frekwencja. Zmienione: oceny." for the rest, and the page of the first entry, leaving out the
/// pages in `off`. None when nothing is news.
fn summary(changes: &[Change], absences: &HashSet<String>, details: &HashMap<String, String>, off: &str) -> Option<(String, &'static str)> {
    let mut page = None;
    let mut lines: Vec<&str> = Vec::new();
    // By entry, not by text: two equal grades of one day are two lines; an entry added and changed at once is one.
    let mut described = HashSet::new();
    let mut sentences = Vec::new();
    for (how, lead) in [("Add", "Nowe"), ("Edit", "Zmienione"), ("Delete", "Usunięte")] {
        let mut counts: Vec<(&str, usize)> = Vec::new();
        for c in changes.iter().filter(|c| c.how == how && c.news(absences)) {
            let Some(&(_, label, to)) = KINDS.iter().find(|k| k.0 == c.kind && wants(off, k.2)) else { continue };
            page.get_or_insert(to);
            let key = c.resource.as_ref().map(|r| format!("{}/{r}", c.kind));
            if let Some((key, line)) = key.and_then(|k| details.get(&k).map(|l| (k, l))) {
                if described.insert(key) {
                    lines.push(line);
                }
                continue;
            }
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
    let mut out: Vec<String> = lines.iter().take(MAX_LINES).map(|l| l.to_string()).collect();
    if lines.len() > MAX_LINES {
        out.push(format!("…i jeszcze {}.", lines.len() - MAX_LINES));
    }
    if !sentences.is_empty() {
        out.push(sentences.join(" "));
    }
    Some((out.join("\n"), page?))
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

pub async fn get(app: &App, email: &str, login: &str, path: &str) -> Result<Value, String> {
    let url = format!("{}/{path}", app.api);
    json_body(call(app, email, login, |t| app.http.get(&url).bearer_auth(t)).await?).await
}

/// Of the changed attendance entries, the ones that are not plain presence, by id, with the name of their type.
/// Empty when Librus does not say: staying quiet beats a message for every lesson.
async fn absences(app: &App, email: &str, login: &str, changes: &[Change]) -> HashMap<String, (Value, String)> {
    let ids: Vec<&str> = changes
        .iter()
        .filter(|c| c.kind == "Attendances" && c.how != "Delete")
        .filter_map(|c| c.resource.as_deref())
        .take(MAX_LOOKUP)
        .collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    let (Ok(types), Ok(entries)) =
        (get(app, email, login, "Attendances/Types").await, get(app, email, login, &format!("Attendances/{}", ids.join(","))).await)
    else {
        return HashMap::new();
    };
    // By type: the standard type it stands for, and its name.
    let types: HashMap<String, (String, String)> = items(&types, "Types", "Type")
        .into_iter()
        .filter_map(|t| {
            let standard = if t["Standard"] == true { id(&t["Id"])? } else { id(&t["StandardType"]["Id"])? };
            Some((id(&t["Id"])?, (standard, text(&t["Name"]).unwrap_or_default())))
        })
        .collect();
    items(&entries, "Attendances", "Attendance")
        .into_iter()
        .filter_map(|a| {
            let kind = id(&a["Type"]["Id"])?;
            let (standard, name) = types.get(&kind).cloned().unwrap_or((kind, String::new()));
            (standard != PRESENT).then(|| Some((id(&a["Id"])?, (a.clone(), name)))).flatten()
        })
        .collect()
}

/// The items of a Synergia answer: a list under `many`, or a single one under `one`.
fn items<'a>(v: &'a Value, many: &str, one: &str) -> Vec<&'a Value> {
    v[many].as_array().map_or_else(|| v.get(one).into_iter().collect(), |a| a.iter().collect())
}

/// A text field (or a number) as plain text; None when empty.
fn text(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => librus::plain(s),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (!s.is_empty()).then_some(s)
}

/// Names by id of a dictionary (subjects, categories); a category may call it CategoryName.
fn names(v: &Value, many: &str) -> HashMap<String, String> {
    items(v, many, "").into_iter().filter_map(|x| Some((id(&x["Id"])?, text(&x["Name"]).or_else(|| text(&x["CategoryName"]))?))).collect()
}

/// "14.11" of "2026-11-14 08:00:00", "dziś" for `today`; None for what is not a date.
fn day(v: &Value, today: &str) -> Option<String> {
    let s = v.as_str()?.get(..10)?;
    breaks::parse(s)?;
    Some(if s == today { "dziś".to_string() } else { format!("{}.{}", &s[8..10], &s[5..7]) })
}

/// "Nowa ocena: 5 · Matematyka · Sprawdzian" from what Librus said, cut at `MAX_LINE`; None when it said nothing.
fn line(lead: &str, parts: &[Option<String>]) -> Option<String> {
    let parts: Vec<&str> = parts.iter().flatten().map(String::as_str).collect();
    if parts.is_empty() {
        return None;
    }
    let s = format!("{lead}: {}", parts.join(" · "));
    if s.chars().count() <= MAX_LINE {
        return Some(s);
    }
    Some(format!("{}…", s.chars().take(MAX_LINE - 1).collect::<String>().trim_end()))
}

/// One line about each new or changed entry, by "kind/id", for the kinds an awake device is told of: the grade with
/// its subject and category, the kind of absence with the lesson, the remark, the announcement, the calendar entry,
/// the homework, the sender and subject of a message. Read now and sent, never stored. Whatever does not answer leaves
/// its entries to the plain summary. A message is found in the list, never opened: opening one marks it read.
async fn details(
    app: &App,
    email: &str,
    login: &str,
    changes: &[Change],
    absent: &HashMap<String, (Value, String)>,
    awake: &[&Subscription],
) -> HashMap<String, String> {
    let ask = |path: String| async move { get(app, email, login, &path).await.unwrap_or_default() };
    let today = breaks::iso(breaks::local(breaks::unix_now()).0);
    // The new and changed entries of a kind someone awake is told of, as (id, Add or Edit), in the feed's order.
    let of = |kind: &str| -> Vec<(&str, &str)> {
        let group = KINDS.iter().find(|k| k.0 == kind).map_or("", |k| k.2);
        if !awake.iter().any(|d| wants(&d.off, group)) {
            return Vec::new();
        }
        let mut out: Vec<(&str, &str)> = Vec::new();
        for c in changes.iter().filter(|c| c.kind == kind && c.how != "Delete") {
            if let Some(r) = c.resource.as_deref().filter(|r| !out.iter().any(|x| x.0 == *r) && (kind != "Attendances" || absent.contains_key(*r))) {
                out.push((r, c.how.as_str()));
            }
        }
        out.truncate(MAX_LOOKUP);
        out
    };
    let lead = |how: &str, add: &str, edit: &str| if how == "Add" { add.to_string() } else { edit.to_string() };
    let mut out = HashMap::new();
    let mut put = |kind: &str, id: &str, line: Option<String>| {
        if let Some(l) = line {
            out.insert(format!("{kind}/{id}"), l);
        }
    };

    let systems = [("Grades", "Grades/Categories"), ("PointGrades", "PointGrades/Categories"), ("TextGrades", "Grades/Categories")];
    let graded: Vec<_> = systems.iter().map(|&(kind, dict)| (kind, dict, of(kind))).filter(|s| !s.2.is_empty()).collect();
    let (attendance, calendar) = (of("Attendances"), of("HomeWorks"));
    let subjects =
        if graded.is_empty() && attendance.is_empty() && calendar.is_empty() { HashMap::new() } else { names(&ask("Subjects".into()).await, "Subjects") };
    let subject = |v: &Value| id(v).and_then(|s| subjects.get(&s).cloned());

    for (kind, dict, wanted) in graded {
        let (list, cats) = (ask(kind.into()).await, ask(dict.into()).await);
        let cats: HashMap<String, &Value> = items(&cats, "Categories", "Category").into_iter().filter_map(|c| Some((id(&c["Id"])?, c))).collect();
        for g in items(&list, "Grades", "Grade") {
            let Some((gid, how)) = id(&g["Id"]).and_then(|i| wanted.iter().find(|w| w.0 == i)).copied() else { continue };
            let cat = id(&g["Category"]["Id"]).and_then(|c| cats.get(&c).copied());
            let mut value = text(&g["Grade"]);
            if kind == "PointGrades" {
                value = value.map(|v| cat.and_then(|c| text(&c["ValueTo"])).map_or_else(|| format!("{v} pkt"), |max| format!("{v}/{max}")));
            }
            let category = cat.and_then(|c| text(&c["Name"]).or_else(|| text(&c["CategoryName"])));
            put(kind, gid, line(&lead(how, "Nowa ocena", "Zmieniona ocena"), &[value, subject(&g["Subject"]["Id"]), category]));
        }
    }

    if !attendance.is_empty() {
        let lessons: HashMap<String, Value> =
            items(&ask("Lessons".into()).await, "Lessons", "Lesson").into_iter().filter_map(|l| Some((id(&l["Id"])?, l["Subject"]["Id"].clone()))).collect();
        for (aid, how) in attendance {
            let (a, name) = &absent[aid];
            let name = (!name.is_empty()).then(|| name.clone());
            let lesson = id(&a["Lesson"]["Id"]).and_then(|l| lessons.get(&l)).and_then(subject);
            let no = text(&a["LessonNo"]).map(|n| format!("lekcja {n}"));
            let l = match (how, name) {
                ("Add", Some(name)) => line(&name, &[lesson, no, day(&a["Date"], &today)]),
                (_, name) => line("Zmiana we frekwencji", &[name, lesson, no, day(&a["Date"], &today)]),
            };
            put("Attendances", aid, l);
        }
    }

    let notes = of("Notes");
    if !notes.is_empty() {
        let (list, cats) = (ask("Notes".into()).await, ask("Notes/Categories".into()).await);
        let cats = names(&cats, "Categories");
        for n in items(&list, "Notes", "Note") {
            let Some((nid, how)) = id(&n["Id"]).and_then(|i| notes.iter().find(|w| w.0 == i)).copied() else { continue };
            let category = id(&n["Category"]["Id"]).and_then(|c| cats.get(&c).cloned());
            put("Notes", nid, line(&lead(how, "Nowa uwaga", "Zmieniona uwaga"), &[category, text(&n["Text"])]));
        }
    }

    let notices = of("SchoolNotices");
    if !notices.is_empty() {
        for n in items(&ask("SchoolNotices".into()).await, "SchoolNotices", "SchoolNotice") {
            let Some((nid, how)) = id(&n["Id"]).and_then(|i| notices.iter().find(|w| w.0 == i)).copied() else { continue };
            put("SchoolNotices", nid, line(&lead(how, "Nowe ogłoszenie", "Zmienione ogłoszenie"), &[text(&n["Subject"])]));
        }
    }

    if !calendar.is_empty() {
        let ids: Vec<&str> = calendar.iter().map(|c| c.0).collect();
        let (list, cats) = (ask(format!("HomeWorks/{}", ids.join(","))).await, ask("HomeWorks/Categories".into()).await);
        let cats = names(&cats, "Categories");
        for h in items(&list, "HomeWorks", "HomeWork") {
            let Some((hid, how)) = id(&h["Id"]).and_then(|i| calendar.iter().find(|w| w.0 == i)).copied() else { continue };
            let category = id(&h["Category"]["Id"]).and_then(|c| cats.get(&c).cloned());
            let parts = [category, subject(&h["Subject"]["Id"]), day(&h["Date"], &today), text(&h["Content"])];
            put("HomeWorks", hid, line(&lead(how, "Nowy termin", "Zmieniony termin"), &parts));
        }
    }

    let homework = of("HomeWorkAssignments");
    if !homework.is_empty() {
        for h in items(&ask("HomeWorkAssignments".into()).await, "HomeWorkAssignments", "HomeWorkAssignment") {
            let Some((hid, how)) = id(&h["Id"]).and_then(|i| homework.iter().find(|w| w.0 == i)).copied() else { continue };
            let due = day(&h["DueDate"], &today).map(|d| format!("na {d}"));
            put("HomeWorkAssignments", hid, line(&lead(how, "Nowe zadanie domowe", "Zmienione zadanie domowe"), &[text(&h["Topic"]), due]));
        }
    }

    // The list after the oldest new id, the way the app's message list reads it; an account without Mobilne Dodatki
    // is refused and keeps the plain summary.
    let messages: Vec<&str> = of("Messages").into_iter().filter(|m| m.1 == "Add").map(|m| m.0).collect();
    if let Some(first) = messages.iter().filter_map(|m| m.parse::<u64>().ok()).min() {
        let list = ask(format!("Messages?afterId={}&limit=10&getAllTypes=1&page=1", first.saturating_sub(1))).await;
        let found: Vec<&Value> = items(&list, "Messages", "Message").into_iter().filter(|m| id(&m["Id"]).is_some_and(|i| messages.contains(&i.as_str()))).collect();
        let mut senders: Vec<String> = Vec::new();
        for s in found.iter().filter_map(|m| id(&m["Sender"]["Id"])) {
            if !senders.contains(&s) && senders.len() < 10 {
                senders.push(s);
            }
        }
        let people = if senders.is_empty() { Value::Null } else { ask(format!("Messages/User/{}", senders.join(","))).await };
        let people: HashMap<String, String> = items(&people, "Users", "User")
            .into_iter()
            .filter_map(|u| {
                let name = [text(&u["FirstName"]), text(&u["LastName"])].into_iter().flatten().collect::<Vec<_>>().join(" ");
                Some((id(&u["Id"])?, name)).filter(|p| !p.1.is_empty())
            })
            .collect();
        for m in found {
            let Some(mid) = id(&m["Id"]) else { continue };
            let lead = id(&m["Sender"]["Id"]).and_then(|s| people.get(&s)).map_or_else(|| "Nowa wiadomość".to_string(), |p| format!("Nowa wiadomość od {p}"));
            put("Messages", &mid, line(&lead, &[text(&m["Subject"])]));
        }
    }
    out
}

/// "Szczęśliwy numerek na jutro: 13", for a number of `today` or later.
fn lucky(answer: &Value, today: i64) -> Option<String> {
    let n = match &answer["LuckyNumber"]["LuckyNumber"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) if !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()) => s.clone(),
        _ => return None,
    };
    let day = breaks::parse(answer["LuckyNumber"]["LuckyNumberDay"].as_str()?)?;
    let when = match day - today {
        ..0 => return None,
        0 => "dziś".to_string(),
        1 => "jutro".to_string(),
        2..7 => ["poniedziałek", "wtorek", "środę", "czwartek", "piątek", "sobotę", "niedzielę"][breaks::weekday(day) as usize].to_string(),
        _ => format!("{}.{}", &breaks::iso(day)[8..], &breaks::iso(day)[5..7]),
    };
    Some(format!("Szczęśliwy numerek na {when}: {n}"))
}

/// Sends `message` to the devices, but for those in their quiet hours: what a device misses then is not sent later,
/// the app's activity view has it.
pub async fn notify(app: &App, devices: &[&Subscription], message: &Value, ttl: u32) {
    let payload = message.to_string();
    let minute = breaks::local(breaks::unix_now()).1;
    for d in devices.iter().filter(|d| !quiet_at(&d.quiet, minute)) {
        match push::send(&app.http, &app.vapid, d, payload.as_bytes(), ttl).await {
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

/// Reads one student's feed and returns the register id to keep (empty: register again next time) and whether the
/// plan changed.
async fn check(app: &App, email: &str, login: &str, name: &str, register: &str, devices: &[Subscription]) -> Result<(String, bool), String> {
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
        return Ok((String::new(), false));
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
        return Ok((register, false));
    }
    let absent = absences(app, email, login, &found).await;
    let absences: HashSet<String> = absent.keys().cloned().collect();
    let news: Vec<(&str, &str, &str)> = found
        .iter()
        .filter(|c| c.news(&absences))
        .map(|c| (c.kind.as_str(), c.how.as_str(), c.resource.as_deref().unwrap_or_default()))
        .collect();
    if let Err(e) = app.store.add_activity(email, login, &news) {
        eprintln!("db: {e}");
    }
    // Details only for someone to read them: notify() skips a device in its quiet hours.
    let minute = breaks::local(breaks::unix_now()).1;
    let awake: Vec<&Subscription> = devices.iter().filter(|d| !quiet_at(&d.quiet, minute)).collect();
    let details = if awake.is_empty() { HashMap::new() } else { details(app, email, login, &found, &absent, &awake).await };
    // Devices that turned different kinds off get different summaries: one per choice.
    let mut told = HashSet::new();
    for off in devices.iter().map(|d| d.off.as_str()) {
        if !told.insert(off) {
            continue;
        }
        let to: Vec<&Subscription> = devices.iter().filter(|d| d.off == off).collect();
        if let Some((body, page)) = summary(&found, &absences, &details, off) {
            notify(app, &to, &json!({ "title": name, "body": body, "url": format!("/#/{page}") }), push::TTL).await;
        }
    }
    if found.iter().any(|c| c.kind == "LuckyNumbers" && c.how != "Delete") {
        // Read again: a device the push service dropped just now is gone.
        let devices = app.store.devices(email).unwrap_or_default();
        let to: Vec<&Subscription> = devices.iter().filter(|d| wants(&d.off, "numerek")).collect();
        if !to.is_empty()
            && let Ok(answer) = get(app, email, login, "LuckyNumbers").await
            && let Some(body) = lucky(&answer, breaks::local(breaks::unix_now()).0)
        {
            notify(app, &to, &json!({ "title": name, "body": body, "url": "/#/start" }), push::TTL).await;
        }
    }
    Ok((register, found.iter().any(|c| ["Timetables", "Calendars/Substitutions"].contains(&c.kind.as_str()))))
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
    // Lessons are kept only for the users still watched and allowed in.
    app.days.lock().unwrap_or_else(|p| p.into_inner()).retain(|(email, _), _| owners.contains(email) && app.is_allowed(email));
    let today = breaks::local(breaks::unix_now()).0;
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
                Ok((register, replanned)) => {
                    if devices.iter().any(|d| wants(&d.off, "przerwy")) && (replanned || !breaks::known(app, email, &account.login, today)) {
                        breaks::refresh(app, email, &account.login, name).await;
                    }
                    (register, String::new())
                }
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
    app.days.lock().unwrap_or_else(|p| p.into_inner()).retain(|(e, _), _| e != email);
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
    fn lucky_number_text() {
        let today = breaks::parse("2026-11-13").unwrap();
        let at = |n: Value, day: &str| lucky(&json!({ "LuckyNumber": { "LuckyNumber": n, "LuckyNumberDay": day } }), today);
        assert_eq!(at(json!(13), "2026-11-13").as_deref(), Some("Szczęśliwy numerek na dziś: 13"));
        assert_eq!(at(json!("7"), "2026-11-16").as_deref(), Some("Szczęśliwy numerek na poniedziałek: 7"), "a Friday's number for Monday");
        assert_eq!(at(json!(7), "2026-12-01").as_deref(), Some("Szczęśliwy numerek na 01.12: 7"));
        assert_eq!(at(json!(7), "2026-11-12"), None, "yesterday's number is no news");
        assert_eq!(at(json!("<b>"), "2026-11-13"), None);
    }

    #[test]
    fn quiet_hours_of_a_device() {
        assert_eq!(quiet_hours("22:00-07:00"), Some((22 * 60, 7 * 60)));
        for bad in ["", "22:00", "22:00-22:00", "24:00-07:00", "22:60-07:00", "2:00-07:00", "+2:00-07:00", "22:00-07:00 ", "22:00–07:00"] {
            assert_eq!(quiet_hours(bad), None, "{bad:?}");
        }
        // From the evening to the morning: past midnight.
        assert!(quiet_at("22:00-07:00", 23 * 60) && quiet_at("22:00-07:00", 0) && quiet_at("22:00-07:00", 6 * 60 + 59));
        assert!(!quiet_at("22:00-07:00", 7 * 60) && !quiet_at("22:00-07:00", 21 * 60 + 59));
        // Within one day, and none at all.
        assert!(quiet_at("13:00-15:00", 13 * 60) && !quiet_at("13:00-15:00", 15 * 60) && !quiet_at("", 0));
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
        let none = HashMap::new();
        assert_eq!(
            summary(&found, &absent, &none, ""),
            Some(("Nowe: oceny, frekwencja. Zmienione: oceny. Usunięte: uwagi.".to_string(), "oceny"))
        );
        assert_eq!(summary(&found[2..5], &HashSet::new(), &none, ""), None, "presence and lesson topics stay quiet");
        assert_eq!(
            summary(&found, &absent, &none, "oceny,przerwy").map(|s| s.0).as_deref(),
            Some("Nowe: frekwencja. Usunięte: uwagi."),
            "a device that turned grades off is not told of them"
        );
        // An entry with details gets its own line; the others keep the summary.
        let details = HashMap::from([
            ("Grades/10".to_string(), "Nowa ocena: 5 · Matematyka".to_string()),
            ("Attendances/13".to_string(), "Nieobecność: Fizyka · lekcja 2 · dziś".to_string()),
        ]);
        assert_eq!(
            summary(&found, &absent, &details, "").map(|s| s.0).as_deref(),
            Some("Nowa ocena: 5 · Matematyka\nNieobecność: Fizyka · lekcja 2 · dziś\nZmienione: oceny. Usunięte: uwagi.")
        );
        assert_eq!(summary(&found, &absent, &details, "oceny").map(|s| s.0).as_deref(), Some("Nieobecność: Fizyka · lekcja 2 · dziś\nUsunięte: uwagi."));
        let twice = changes(&json!({ "Changes": [change(1, "Grades", 10, "Add"), change(2, "Grades", 10, "Edit"), change(3, "Grades", 11, "Add")] }));
        let same = HashMap::from([("Grades/10".to_string(), "Nowa ocena: 5".to_string()), ("Grades/11".to_string(), "Nowa ocena: 5".to_string())]);
        assert_eq!(summary(&twice, &HashSet::new(), &same, "").map(|s| s.0).as_deref(), Some("Nowa ocena: 5\nNowa ocena: 5"), "one line per entry");
    }

    #[test]
    fn details_stay_short() {
        let long = "x".repeat(500);
        let cut = line("Nowa uwaga", &[Some(long.clone()), None]).unwrap();
        assert!(cut.chars().count() == MAX_LINE && cut.ends_with('…'), "{cut}");
        assert_eq!(line("Nowa ocena", &[None, None]), None, "nothing said, nothing to add to the summary");
        assert_eq!(line("Nowa ocena", &[Some("5".into()), None, Some("Sprawdzian".into())]).as_deref(), Some("Nowa ocena: 5 · Sprawdzian"));
        assert_eq!(text(&json!("Opis <b>postaci</b>&nbsp;i&amp;tła ")).as_deref(), Some("Opis postaci i&tła"));
        assert_eq!(day(&json!("2026-11-14 08:00:00"), "2026-11-12").as_deref(), Some("14.11"));
        assert_eq!(day(&json!("2026-11-12"), "2026-11-12").as_deref(), Some("dziś"));
        assert_eq!(day(&json!("jutro"), "2026-11-12"), None);
        // However many entries come at once, the message stays far below the push payload limit.
        let many = changes(&json!({ "Changes": (0..200).map(|i| change(i, "Notes", i, "Add")).collect::<Vec<_>>() }));
        let details: HashMap<String, String> = (0..200).map(|i| (format!("Notes/{i}"), line("Nowa uwaga", &[Some("ż".repeat(500))]).unwrap())).collect();
        let body = summary(&many, &HashSet::new(), &details, "").unwrap().0;
        assert_eq!(body.lines().count(), MAX_LINES + 1, "{body}");
        assert!(body.ends_with("…i jeszcze 195.") && body.len() < 1500, "{} bytes", body.len());
    }

    /// Stands in for both the Synergia API and a push service.
    #[derive(Default)]
    struct Fixture {
        calls: Mutex<Vec<String>>,
        pending: Mutex<Vec<Value>>,
        forgotten: Mutex<bool>,
        pushed: Mutex<Vec<(HeaderMap, Bytes)>>,
    }

    fn today() -> String {
        breaks::iso(breaks::local(breaks::unix_now()).0)
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
                { "Id": 1, "Standard": true, "Name": "Nieobecność" },
                { "Id": "2001", "Standard": false, "StandardType": { "Id": 100 } },
            ] }),
            ("GET", "/Timetables") => json!({ "Timetable": { today(): [
                [{ "LessonNo": "1", "HourFrom": "08:00", "HourTo": "08:45", "Subject": { "Name": "Matematyka" }, "Classroom": { "Id": 5 } }],
                [{ "LessonNo": "2", "HourFrom": "08:55", "HourTo": "09:40", "Subject": { "Name": "Fizyka" }, "Classroom": { "Id": 5 } }],
            ] } }),
            ("GET", "/Classrooms/5") => json!({ "Classroom": { "Id": 5, "Symbol": "26" } }),
            ("GET", "/LuckyNumbers") => json!({ "LuckyNumber": { "LuckyNumber": 13, "LuckyNumberDay": today() } }),
            ("GET", "/Attendances/12,13") => json!({ "Attendances": [
                { "Id": 12, "Type": { "Id": 2001 } },
                { "Id": "13", "Type": { "Id": "1" }, "Lesson": { "Id": 3 }, "LessonNo": "2", "Date": today() },
            ] }),
            ("GET", "/Subjects") => json!({ "Subjects": [{ "Id": 5, "Name": "Matematyka" }, { "Id": "6", "Name": "Fizyka" }] }),
            ("GET", "/Grades") => json!({ "Grades": [{ "Id": 20, "Grade": "5", "Subject": { "Id": "5" }, "Category": { "Id": 1 } }] }),
            ("GET", "/Grades/Categories") => json!({ "Categories": [{ "Id": 1, "Name": "Sprawdzian" }] }),
            ("GET", "/Lessons") => json!({ "Lessons": [{ "Id": 3, "Subject": { "Id": 6 } }] }),
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
        let account = Account { login: "1u".into(), access_token: Some("tok".into()), student_name: Some("Jan Testowy".into()), state: None };
        app.store.put_tokens("a@x.pl", &Tokens { access: "p".into(), refresh: "r".into(), accounts: vec![account] }).unwrap();
        app.store.allow("a@x.pl").unwrap();
        let receiver = PrivateKey::generate(&ECDH_P256).unwrap();
        for name in ["phone", "dead"] {
            let p256dh = receiver.compute_public_key().unwrap().as_ref().to_vec();
            app.store.add_device("a@x.pl", &Subscription { endpoint: format!("{base}/push/{name}"), p256dh, auth: vec![7; 16], off: String::new(), quiet: String::new() }).unwrap();
        }
        // The breaks start off; this phone turns them on.
        app.store.set_off("a@x.pl", &format!("{base}/push/phone"), "").unwrap();
        let calls = || std::mem::take(&mut *fx.calls.lock().unwrap());
        let feed = || app.store.feeds("a@x.pl").unwrap().into_iter().map(|f| (f.1, f.3)).collect::<Vec<_>>();

        // A new device: the feed is registered, and what it already holds is acknowledged without a message. Today's
        // lessons are read once, for the breaks.
        *fx.pending.lock().unwrap() = vec![change(1, "Grades", 10, "Add")];
        round(&app, false).await;
        let today = breaks::local(breaks::unix_now()).0;
        assert_eq!(calls(), [
            r#"POST /ChangeRegister {"appVersion":"8.4.3","sendPush":"0"}"#.to_string(),
            "GET /PushChanges?pushDevice=77".into(),
            "DELETE /PushChanges/1?pushDevice=77".into(),
            format!("GET /Timetables?weekStart={}", breaks::iso(today - breaks::weekday(today))),
            "GET /Classrooms/5".into(),
        ]);
        assert_eq!(feed(), [("77".to_string(), String::new())]);
        assert!(breaks::known(&app, "a@x.pl", "1u", today));
        assert_eq!(breaks::due_for(&app, today, 8 * 60 + 45), [("a@x.pl".into(), "Jan Testowy".into(), "Przerwa 10 min. Następna: Fizyka, sala 26, 08:55.".into())]);

        // An early round leaves a running feed alone.
        round(&app, false).await;
        assert!(calls().is_empty());

        // The timed round: a grade and an absence are news, a presence of a school-defined type and a lesson topic are not.
        // The lucky number has a message of its own.
        *fx.pending.lock().unwrap() = vec![
            change(5, "Grades", 20, "Add"),
            change(6, "Attendances", 12, "Add"),
            change(7, "Attendances", 13, "Add"),
            change(8, "Realizations", 30, "Add"),
            change(9, "LuckyNumbers", 1, "Add"),
        ];
        round(&app, true).await;
        let made = calls();
        assert_eq!(made[..4], [
            "GET /PushChanges?pushDevice=77",
            "DELETE /PushChanges/5,6,7,8,9?pushDevice=77",
            "GET /Attendances/Types",
            "GET /Attendances/12,13",
        ]);
        assert_eq!(made[4..8], ["GET /Subjects", "GET /Grades", "GET /Grades/Categories", "GET /Lessons"], "the details of the news");
        assert!(made[8..10].iter().all(|c| c.starts_with("POST /push/")), "{made:?}");
        assert_eq!(made[10], "GET /LuckyNumbers");
        assert!(made.len() == 12 && made[11].starts_with("POST /push/phone "), "the device the push service dropped is not tried again: {made:?}");
        let pushed = std::mem::take(&mut *fx.pushed.lock().unwrap());
        assert_eq!(pushed.len(), 2);
        let message: Value = serde_json::from_slice(&crate::push::tests::decrypt(&receiver, &[7; 16], &pushed[1].1)).unwrap();
        assert_eq!(message, json!({ "title": "Jan Testowy", "body": "Szczęśliwy numerek na dziś: 13", "url": "/#/start" }));
        let (headers, body) = &pushed[0];
        assert_eq!(headers["content-encoding"], "aes128gcm");
        assert_eq!(headers["ttl"], "86400");
        assert!(headers["authorization"].to_str().unwrap().starts_with("vapid t="));
        let message: Value = serde_json::from_slice(&crate::push::tests::decrypt(&receiver, &[7; 16], body)).unwrap();
        assert_eq!(message, json!({ "title": "Jan Testowy", "body": "Nowa ocena: 5 · Matematyka · Sprawdzian\nNieobecność: Fizyka · lekcja 2 · dziś", "url": "/#/oceny" }));
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

        // In its quiet hours a device gets nothing: the feed is read and acknowledged as ever, no message goes out.
        let now = breaks::local(breaks::unix_now()).1;
        let hm = |m: u32| format!("{:02}:{:02}", m % 1440 / 60, m % 60);
        app.store.set_quiet("a@x.pl", &format!("{base}/push/phone"), &format!("{}-{}", hm(now + 1380), hm(now + 60))).unwrap();
        *fx.pending.lock().unwrap() = vec![change(11, "Grades", 21, "Add")];
        round(&app, true).await;
        let made = calls();
        assert!(made.iter().any(|c| c.starts_with("DELETE /PushChanges/")) && !made.iter().any(|c| c.starts_with("POST /push/")), "{made:?}");
        assert!(!made.iter().any(|c| c.starts_with("GET /Grades")), "no details read for nobody: {made:?}");
        app.store.set_quiet("a@x.pl", &format!("{base}/push/phone"), "").unwrap();

        // An address that lost access is not polled, and hears of no breaks.
        app.store.revoke("a@x.pl", false).unwrap();
        round(&app, true).await;
        assert!(calls().is_empty());
        assert!(breaks::due_for(&app, today, 8 * 60 + 45).is_empty());
        app.store.allow("a@x.pl").unwrap();

        breaks::refresh(&app, "a@x.pl", "1u", "Jan Testowy").await;
        assert!(breaks::known(&app, "a@x.pl", "1u", today));
        calls();
        stop(&app, "a@x.pl").await;
        assert_eq!(calls(), ["DELETE /ChangeRegister/77"]);
        assert!(feed().is_empty());
        assert!(!breaks::known(&app, "a@x.pl", "1u", today), "the lessons go with the feeds");
    }
}

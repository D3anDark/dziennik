//! Break notifications: at the end of each lesson, how long the break is and what comes next. The feed round
//! (`watch`) reads each student's lessons for the day once, and again when the plan changes; the ticker here sends
//! them at the minute a lesson ends. Also the school's clock: Polish time, which the server's own zone may not be.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::App;
use crate::push::Subscription;
use crate::watch::{self, wants};

/// A break message is no use late: the push service drops it after this many seconds.
const TTL: u32 = 300;

/// A lesson that takes place, its hours in minutes after midnight.
#[derive(Debug)]
struct Lesson {
    no: u32,
    from: u32,
    to: u32,
    subject: String,
    /// The classroom's id until `refresh` looks up its symbol; empty when there is none.
    room: String,
}

/// One student's lessons on `day` (days since 1970-01-01, school time), earliest first.
pub struct Day {
    pub day: i64,
    name: String,
    lessons: Vec<Lesson>,
}

/// Days since 1970-01-01 of a date (days_from_civil, H. Hinnant); a month past 12 rolls into the next year.
fn days(y: i64, m: i64, d: i64) -> i64 {
    let (y, m) = (y + (m - 1).div_euclid(12), (m - 1).rem_euclid(12) + 1);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// `YYYY-MM-DD` of a day number (civil_from_days).
pub fn iso(n: i64) -> String {
    let z = n + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    format!("{:04}-{m:02}-{d:02}", yoe + era * 400 + i64::from(m <= 2))
}

/// The day number of a `YYYY-MM-DD` that exists.
pub fn parse(s: &str) -> Option<i64> {
    let (y, rest) = s.get(..10)?.split_once('-')?;
    let (m, d) = rest.split_once('-')?;
    let n = days(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    (iso(n) == s[..10]).then_some(n)
}

/// Monday 0 to Sunday 6. 1970-01-01 was a Thursday.
pub fn weekday(n: i64) -> i64 {
    (n + 3).rem_euclid(7)
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

/// Polish time of a Unix time: (day number, minutes after midnight). Summer time (UTC+2) runs from 01:00 UTC on the
/// last Sunday of March to 01:00 UTC on the last Sunday of October, as everywhere in the EU; UTC+1 the rest.
pub fn local(unix: i64) -> (i64, u32) {
    let year = iso(unix.div_euclid(86_400))[..4].parse().unwrap_or(1970);
    let last_sunday = |m: i64| {
        let last = days(year, m + 1, 1) - 1;
        last - (weekday(last) + 1) % 7
    };
    let summer = (last_sunday(3) * 86_400 + 3600..last_sunday(10) * 86_400 + 3600).contains(&unix);
    let t = unix + if summer { 7200 } else { 3600 };
    (t.div_euclid(86_400), (t.rem_euclid(86_400) / 60) as u32)
}

fn minutes(hm: &str) -> Option<u32> {
    let (h, m) = hm.get(..5)?.split_once(':')?;
    Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?)
}

/// The lessons of `date` in a `Timetables` answer that take place, earliest first. A slot holds a list of lessons.
fn lessons(plan: &Value, date: &str) -> Vec<Lesson> {
    let slots = plan["Timetable"][date].as_array().map_or(&[][..], Vec::as_slice);
    let mut out: Vec<Lesson> = slots
        .iter()
        .flat_map(|s| s.as_array().map_or(&[][..], Vec::as_slice))
        .filter(|l| l["IsCanceled"] != true)
        .filter_map(|l| {
            Some(Lesson {
                no: l["LessonNo"].as_str().and_then(|n| n.parse().ok()).or(l["LessonNo"].as_u64().map(|n| n as u32)).unwrap_or(0),
                from: minutes(l["HourFrom"].as_str()?)?,
                to: minutes(l["HourTo"].as_str()?)?,
                subject: l["Subject"]["Name"].as_str().unwrap_or_default().to_string(),
                room: watch::id(&l["Classroom"]["Id"]).unwrap_or_default(),
            })
        })
        .collect();
    out.sort_by_key(|l| (l.from, l.no));
    out
}

/// "sala 26", and a room the school already named "sala gim." left as it is.
fn room(symbol: &str) -> String {
    if symbol.to_lowercase().starts_with("sala") { symbol.to_string() } else { format!("sala {symbol}") }
}

/// What to say when a lesson ends at `minute` and another follows: "Przerwa 10 min" or, where lessons in between are
/// skipped or called off, "Okienko 55 min", then the next lesson.
fn due(lessons: &[Lesson], minute: u32) -> Option<String> {
    let ended = lessons.iter().find(|l| l.to == minute)?;
    let next = lessons.iter().find(|l| l.from >= minute)?;
    let what = if next.no > ended.no + 1 { "Okienko" } else { "Przerwa" };
    let place = if next.room.is_empty() { String::new() } else { format!(", {}", room(&next.room)) };
    Some(format!("{what} {} min. Następna: {}{place}, {:02}:{:02}.", next.from - minute, next.subject, next.from / 60, next.from % 60))
}

/// Whether `login`'s lessons in `app.days` are today's.
pub fn known(app: &App, email: &str, login: &str, today: i64) -> bool {
    app.days.lock().unwrap_or_else(|p| p.into_inner()).get(&(email.to_string(), login.to_string())).is_some_and(|d| d.day == today)
}

/// Reads `login`'s lessons for today into `app.days`: the week's plan, then its rooms. A plan that cannot be read
/// counts as a day without lessons, so a school that hides it is not asked again every round.
pub async fn refresh(app: &App, email: &str, login: &str, name: &str) {
    let (today, _) = local(unix_now());
    let plan = watch::get(app, email, login, &format!("Timetables?weekStart={}", iso(today - weekday(today)))).await;
    let mut lessons = plan.map_or_else(|_| Vec::new(), |p| lessons(&p, &iso(today)));
    let mut ids: Vec<&str> = lessons.iter().map(|l| l.room.as_str()).filter(|r| !r.is_empty()).collect();
    ids.sort_unstable();
    ids.dedup();
    let symbols: HashMap<String, String> = match ids.is_empty() {
        true => HashMap::new(),
        false => watch::get(app, email, login, &format!("Classrooms/{}", ids.join(","))).await.map_or_else(
            |_| HashMap::new(),
            |r| {
                let one = [r["Classroom"].clone()];
                let list = r["Classrooms"].as_array().map_or(&one[..], Vec::as_slice);
                list.iter().filter_map(|c| Some((watch::id(&c["Id"])?, c["Symbol"].as_str()?.to_string()))).collect()
            },
        ),
    };
    for l in &mut lessons {
        l.room = symbols.get(&l.room).cloned().unwrap_or_default();
    }
    let day = Day { day: today, name: name.to_string(), lessons };
    app.days.lock().unwrap_or_else(|p| p.into_inner()).insert((email.to_string(), login.to_string()), day);
}

/// (email, student, message) for every student whose lesson ends at `minute` of `today`.
pub fn due_for(app: &App, today: i64, minute: u32) -> Vec<(String, String, String)> {
    let days = app.days.lock().unwrap_or_else(|p| p.into_inner());
    days.iter()
        .filter(|(_, d)| d.day == today)
        .filter_map(|((email, _), d)| Some((email.clone(), d.name.clone(), due(&d.lessons, minute)?)))
        .collect()
}

/// Runs for the life of the server: wakes just after every minute turns and tells whoever's lesson just ended.
// shortcut: sends go one after another, so a minute with more sends than fit in 60 s makes the next minute's skipped;
// send concurrently or catch up on missed minutes if a server ever has hundreds of devices.
pub async fn run(app: Arc<App>) {
    loop {
        tokio::time::sleep(Duration::from_secs(61 - unix_now().rem_euclid(60) as u64)).await;
        let (today, minute) = local(unix_now());
        for (email, name, body) in due_for(&app, today, minute) {
            let devices = app.store.devices(&email).unwrap_or_default();
            let to: Vec<&Subscription> = devices.iter().filter(|d| wants(&d.off, "przerwy")).collect();
            // One tag: the next break replaces the last one's message instead of piling up.
            watch::notify(&app, &to, &json!({ "title": name, "body": body, "url": "/#/plan", "tag": "przerwa" }), TTL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polish_time() {
        assert_eq!(iso(parse("2026-11-11").unwrap()), "2026-11-11");
        assert_eq!(parse("2026-02-30"), None);
        assert_eq!(weekday(parse("2026-11-11").unwrap()), 2, "a Wednesday");
        let at = |date: &str, h: i64, m: i64| parse(date).unwrap() * 86_400 + h * 3600 + m * 60;
        let local_hm = |unix| {
            let (d, m) = local(unix);
            (iso(d), m / 60, m % 60)
        };
        // 2026: summer time from 29 March to 25 October.
        assert_eq!(local_hm(at("2026-03-29", 0, 59)), ("2026-03-29".into(), 1, 59));
        assert_eq!(local_hm(at("2026-03-29", 1, 0)), ("2026-03-29".into(), 3, 0));
        assert_eq!(local_hm(at("2026-10-25", 0, 59)), ("2026-10-25".into(), 2, 59));
        assert_eq!(local_hm(at("2026-10-25", 1, 0)), ("2026-10-25".into(), 2, 0));
        assert_eq!(local_hm(at("2026-12-31", 23, 30)), ("2027-01-01".into(), 0, 30), "the new year comes an hour early");
    }

    #[test]
    fn breaks_between_lessons() {
        let lesson = |no: u32, from: &str, to: &str, subject: &str, room: &str, canceled: bool| {
            json!({ "LessonNo": no.to_string(), "HourFrom": from, "HourTo": to, "Subject": { "Name": subject },
                    "Classroom": { "Id": room }, "IsCanceled": canceled })
        };
        let plan = json!({ "Timetable": { "2026-11-12": [
            [lesson(1, "08:00", "08:45", "Matematyka", "1", false)], [],
            [lesson(2, "08:55", "09:40", "Fizyka", "2", false)],
            [lesson(3, "09:50", "10:35", "Chemia", "3", true)],
            [lesson(4, "10:50", "11:35", "Historia", "", false)],
        ] } });
        let mut day = lessons(&plan, "2026-11-12");
        assert_eq!(day.iter().map(|l| l.no).collect::<Vec<_>>(), [1, 2, 4], "a lesson called off does not take place");
        day[1].room = "26".into();
        day[2].room = "sala gim.".into();
        assert_eq!(due(&day, 8 * 60 + 45).as_deref(), Some("Przerwa 10 min. Następna: Fizyka, sala 26, 08:55."));
        assert_eq!(due(&day, 9 * 60 + 40).as_deref(), Some("Okienko 70 min. Następna: Historia, sala gim., 10:50."));
        assert_eq!(due(&day, 11 * 60 + 35), None, "after the last lesson there is no break");
        assert_eq!(due(&day, 8 * 60 + 50), None);
    }
}

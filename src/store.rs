use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce, Payload};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::push::Subscription;

pub const SESSION_TTL_SECS: i64 = 30 * 24 * 3600;
const MAX_SESSIONS_PER_USER: i64 = 10;
/// Devices one user can receive notifications on; the oldest subscription goes first.
const MAX_DEVICES_PER_USER: i64 = 5;
/// Entries of the activity list kept for one student; older ones go.
const MAX_ACTIVITY: i64 = 300;
/// Cap on the admin-managed access list; it also bounds the login rate-limit map.
const MAX_ALLOWED: i64 = 500;

#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub login: String,
    #[serde(rename = "accessToken")]
    pub access_token: Option<String>,
    #[serde(rename = "studentName")]
    pub student_name: Option<String>,
    pub state: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
    pub accounts: Vec<Account>,
}

// ponytail: one connection behind a std Mutex, queries are sub-millisecond and never
// held across .await; switch to a pool if the group grows past a few dozen users.
pub struct Store {
    db: Mutex<Connection>,
    cipher: Aes256Gcm,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn sid_hash(sid: &str) -> Vec<u8> {
    Sha256::digest(sid.as_bytes()).to_vec()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS RNG unavailable");
    b
}

fn seal(cipher: &Aes256Gcm, aad: &str, plain: &[u8]) -> Vec<u8> {
    let nonce_bytes = random::<12>();
    let nonce = Nonce::<Aes256Gcm>::from(nonce_bytes);
    let ct = cipher.encrypt(&nonce, Payload { msg: plain, aad: aad.as_bytes() }).expect("AES-GCM encrypt");
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ct);
    blob
}

fn unseal(cipher: &Aes256Gcm, aad: &str, blob: &[u8]) -> Option<Vec<u8>> {
    let (n, ct) = blob.split_at_checked(12)?;
    let nonce = Nonce::<Aes256Gcm>::try_from(n).ok()?;
    cipher.decrypt(&nonce, Payload { msg: ct, aad: aad.as_bytes() }).ok()
}

/// The key of a session's own copy of the tokens. It comes from the session cookie, which the database holds only as
/// a hash of other input, so the copy opens only while that browser is making a request.
fn session_cipher(sid: &str) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(&Sha256::digest(format!("tokens/{sid}").as_bytes())[..]).expect("32-byte key")
}

/// Drops what nobody may use any more: sessions that ran out, users with neither a session nor a device, and, once no
/// device is left to notify, the copy of the tokens the server keeps for notifications with the history it wrote.
fn purge(db: &Connection) -> rusqlite::Result<()> {
    db.execute("DELETE FROM sessions WHERE expires <= ?1", [now()])?;
    db.execute(
        "DELETE FROM users WHERE NOT EXISTS(SELECT 1 FROM sessions WHERE sessions.email = users.email)
         AND NOT EXISTS(SELECT 1 FROM devices WHERE devices.email = users.email)",
        [],
    )?;
    db.execute(
        "UPDATE users SET tokens = x'' WHERE length(tokens) > 0
         AND NOT EXISTS(SELECT 1 FROM devices WHERE devices.email = users.email)",
        [],
    )?;
    db.execute("DELETE FROM feeds WHERE NOT EXISTS(SELECT 1 FROM devices WHERE devices.email = feeds.email)", [])?;
    db.execute("DELETE FROM activity WHERE NOT EXISTS(SELECT 1 FROM devices WHERE devices.email = activity.email)", [])?;
    Ok(())
}

impl Store {
    pub fn open(path: &str, key_hex: &str) -> Result<Self, String> {
        let key = hex_decode(key_hex)
            .filter(|k| k.len() == 32)
            .ok_or("SECRET_KEY must be 64 hex characters")?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS users(
                 email TEXT PRIMARY KEY,
                 tokens BLOB NOT NULL,
                 updated INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS sessions(
                 sid_hash BLOB PRIMARY KEY,
                 email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
                 expires INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);
             CREATE TABLE IF NOT EXISTS allowed(
                 email TEXT PRIMARY KEY,
                 added INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS secrets(
                 name TEXT PRIMARY KEY,
                 value BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS devices(
                 endpoint TEXT PRIMARY KEY,
                 email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
                 p256dh BLOB NOT NULL,
                 auth BLOB NOT NULL,
                 added INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS devices_email ON devices(email);
             CREATE TABLE IF NOT EXISTS feeds(
                 email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
                 login TEXT NOT NULL,
                 register TEXT NOT NULL,
                 checked INTEGER NOT NULL,
                 error TEXT NOT NULL,
                 PRIMARY KEY(email, login));
             CREATE TABLE IF NOT EXISTS activity(
                 id INTEGER PRIMARY KEY,
                 email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
                 login TEXT NOT NULL,
                 at INTEGER NOT NULL,
                 kind TEXT NOT NULL,
                 change TEXT NOT NULL,
                 resource TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS activity_student ON activity(email, login, id);",
        )
        .map_err(|e| e.to_string())?;
        // Added later: the session's own copy of the tokens, sealed with `session_cipher`, NULL when the session uses
        // the copy kept for notifications; and what a device turned off (`Subscription::off`), at first the breaks: a
        // message every lesson is for those who ask for it.
        for column in ["sessions ADD COLUMN tokens BLOB", "devices ADD COLUMN off TEXT NOT NULL DEFAULT 'przerwy'"] {
            if let Err(e) = db.execute(&format!("ALTER TABLE {column}"), [])
                && !e.to_string().contains("duplicate column")
            {
                return Err(e.to_string());
            }
        }
        // Users from before that change, and nobody with notifications on: they sign in again, into their own copy.
        purge(&db).map_err(|e| e.to_string())?;
        Ok(Self { db: Mutex::new(db), cipher })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn seal(&self, aad: &str, plain: &[u8]) -> Vec<u8> {
        seal(&self.cipher, aad, plain)
    }

    fn unseal(&self, aad: &str, blob: &[u8]) -> Option<Vec<u8>> {
        unseal(&self.cipher, aad, blob)
    }

    fn seal_tokens(&self, email: &str, t: &Tokens) -> Vec<u8> {
        self.seal(email, &serde_json::to_vec(t).expect("Tokens serialize"))
    }

    /// Keeps the copy of the tokens the server opens on its own, with SECRET_KEY: only for a user with notifications
    /// on, who has to be told about changes while the app is closed.
    pub fn put_tokens(&self, email: &str, t: &Tokens) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO users(email, tokens, updated) VALUES (?1, ?2, ?3)
             ON CONFLICT(email) DO UPDATE SET tokens = excluded.tokens, updated = excluded.updated",
            params![email, self.seal_tokens(email, t), now()],
        )?;
        Ok(())
    }

    /// Writes refreshed tokens back where `tokens` read them. Update only: never resurrects a user or a session that
    /// signed out mid-refresh.
    pub fn update_tokens(&self, email: &str, sid: Option<&str>, t: &Tokens) -> rusqlite::Result<()> {
        let plain = serde_json::to_vec(t).expect("Tokens serialize");
        let db = self.conn();
        if let Some(sid) = sid
            && db.execute(
                "UPDATE sessions SET tokens = ?2 WHERE sid_hash = ?1 AND tokens IS NOT NULL",
                params![sid_hash(sid), seal(&session_cipher(sid), email, &plain)],
            )? > 0
        {
            return Ok(());
        }
        db.execute(
            "UPDATE users SET tokens = ?2, updated = ?3 WHERE email = ?1 AND length(tokens) > 0",
            params![email, self.seal(email, &plain), now()],
        )?;
        Ok(())
    }

    /// The tokens a request works with: its session's own copy, else the copy kept for notifications. The watcher,
    /// with no session, gets only the latter.
    pub fn tokens(&self, email: &str, sid: Option<&str>) -> Option<Tokens> {
        let db = self.conn();
        if let Some(sid) = sid {
            let own: Option<Vec<u8>> = db
                .query_row("SELECT tokens FROM sessions WHERE sid_hash = ?1 AND email = ?2", params![sid_hash(sid), email], |r| r.get(0))
                .optional()
                .ok()?
                .flatten();
            if let Some(blob) = own {
                return serde_json::from_slice(&unseal(&session_cipher(sid), email, &blob)?).ok();
            }
        }
        let blob: Vec<u8> = db
            .query_row("SELECT tokens FROM users WHERE email = ?1", [email], |r| r.get(0))
            .optional()
            .ok()??;
        serde_json::from_slice(&self.unseal(email, &blob)?).ok()
    }

    /// A new session, with its own sealed copy of `own`; without one it uses the copy kept for notifications.
    pub fn new_session(&self, email: &str, own: Option<&Tokens>) -> rusqlite::Result<String> {
        let sid: String = random::<32>().iter().map(|b| format!("{b:02x}")).collect();
        let own = own.map(|t| seal(&session_cipher(&sid), email, &serde_json::to_vec(t).expect("Tokens serialize")));
        let db = self.conn();
        db.execute("INSERT OR IGNORE INTO users(email, tokens, updated) VALUES (?1, x'', ?2)", params![email, now()])?;
        db.execute(
            "INSERT INTO sessions(sid_hash, email, expires, tokens) VALUES (?1, ?2, ?3, ?4)",
            params![sid_hash(&sid), email, now() + SESSION_TTL_SECS, own],
        )?;
        db.execute(
            "DELETE FROM sessions WHERE email = ?1 AND sid_hash NOT IN
             (SELECT sid_hash FROM sessions WHERE email = ?1 ORDER BY expires DESC LIMIT ?2)",
            params![email, MAX_SESSIONS_PER_USER],
        )?;
        // After the insert above, so that the user signing in right now is not among them.
        purge(&db)?;
        Ok(sid)
    }

    pub fn purge(&self) -> rusqlite::Result<()> {
        purge(&self.conn())
    }

    /// Hands the session's own copy of the tokens to the server, which needs it to look for changes while the app is
    /// closed. Call after the device is stored, so that `purge` does not take the copy straight back.
    pub fn share_tokens(&self, email: &str, sid: &str) -> rusqlite::Result<()> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        let own: Option<Vec<u8>> = tx
            .query_row("SELECT tokens FROM sessions WHERE sid_hash = ?1 AND email = ?2", params![sid_hash(sid), email], |r| r.get(0))
            .optional()?
            .flatten();
        if let Some(plain) = own.and_then(|b| unseal(&session_cipher(sid), email, &b)) {
            tx.execute("UPDATE users SET tokens = ?2, updated = ?3 WHERE email = ?1", params![email, self.seal(email, &plain), now()])?;
            tx.execute("UPDATE sessions SET tokens = NULL WHERE sid_hash = ?1", [sid_hash(sid)])?;
        }
        tx.commit()
    }

    /// Takes the server's copy back into the session as its own and drops the history written with it: the last
    /// device is going. Other sessions that used the server's copy have to sign in again.
    pub fn unshare_tokens(&self, email: &str, sid: &str) -> rusqlite::Result<()> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        let shared: Option<Vec<u8>> = tx.query_row("SELECT tokens FROM users WHERE email = ?1", [email], |r| r.get(0)).optional()?;
        if let Some(plain) = shared.and_then(|b| self.unseal(email, &b)) {
            tx.execute(
                "UPDATE sessions SET tokens = ?3 WHERE sid_hash = ?1 AND email = ?2 AND tokens IS NULL",
                params![sid_hash(sid), email, seal(&session_cipher(sid), email, &plain)],
            )?;
        }
        tx.execute("UPDATE users SET tokens = x'' WHERE email = ?1", [email])?;
        tx.execute("DELETE FROM activity WHERE email = ?1", [email])?;
        tx.commit()
    }

    /// Everything kept for `email`: sessions, tokens, devices, feeds and history go by cascade. The access list,
    /// which belongs to the administrators, stays.
    pub fn forget(&self, email: &str) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM users WHERE email = ?1", [email])?;
        Ok(())
    }

    pub fn session_email(&self, sid: &str) -> Option<String> {
        self.conn()
            .query_row(
                "SELECT email FROM sessions WHERE sid_hash = ?1 AND expires > ?2",
                params![sid_hash(sid), now()],
                |r| r.get(0),
            )
            .optional()
            .ok()?
    }

    /// Starts the session's time again once half of it has passed. True when it did, for the caller to renew the
    /// cookie as well: a device in use stays signed in, one left alone for the whole period does not.
    pub fn renew_session(&self, sid: &str) -> rusqlite::Result<bool> {
        let changed = self.conn().execute(
            "UPDATE sessions SET expires = ?2 WHERE sid_hash = ?1 AND expires > ?3 AND expires < ?4",
            params![sid_hash(sid), now() + SESSION_TTL_SECS, now(), now() + SESSION_TTL_SECS / 2],
        )?;
        Ok(changed > 0)
    }

    /// Drops the session; the user's Librus tokens go with their last session.
    pub fn end_session(&self, sid: &str) -> rusqlite::Result<()> {
        let db = self.conn();
        let email: Option<String> = db
            .query_row("SELECT email FROM sessions WHERE sid_hash = ?1", [sid_hash(sid)], |r| r.get(0))
            .optional()?;
        db.execute("DELETE FROM sessions WHERE sid_hash = ?1", [sid_hash(sid)])?;
        if let Some(e) = email {
            db.execute(
                "DELETE FROM users WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM sessions WHERE email = ?1)",
                [e],
            )?;
        }
        Ok(())
    }

    pub fn is_allowed(&self, email: &str) -> bool {
        self.conn()
            .query_row("SELECT 1 FROM allowed WHERE email = ?1", [email], |_| Ok(()))
            .optional()
            .is_ok_and(|r| r.is_some())
    }

    /// Adds `email` to the access list; adding it twice is fine. False when the list is full.
    pub fn allow(&self, email: &str) -> rusqlite::Result<bool> {
        let db = self.conn();
        db.execute(
            "INSERT OR IGNORE INTO allowed(email, added)
             SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM allowed) < ?3",
            params![email, now(), MAX_ALLOWED],
        )?;
        db.query_row("SELECT EXISTS(SELECT 1 FROM allowed WHERE email = ?1)", [email], |r| r.get(0))
    }

    /// Removes `email` from the access list. `forget` also drops its Librus tokens and, by cascade, its sessions.
    pub fn revoke(&self, email: &str, forget: bool) -> rusqlite::Result<()> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM allowed WHERE email = ?1", [email])?;
        if forget {
            tx.execute("DELETE FROM users WHERE email = ?1", [email])?;
        }
        tx.commit()
    }

    /// The access list, newest first: (email, added, has signed in).
    pub fn allowed(&self) -> rusqlite::Result<Vec<(String, i64, bool)>> {
        self.conn()
            .prepare(
                "SELECT email, added, EXISTS(SELECT 1 FROM users WHERE users.email = allowed.email)
                 FROM allowed ORDER BY added DESC, email",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect()
    }

    /// A server secret kept encrypted like the tokens. None when absent or sealed under another SECRET_KEY.
    pub fn secret(&self, name: &str) -> Option<Vec<u8>> {
        let blob: Vec<u8> = self
            .conn()
            .query_row("SELECT value FROM secrets WHERE name = ?1", [name], |r| r.get(0))
            .optional()
            .ok()??;
        self.unseal(name, &blob)
    }

    pub fn set_secret(&self, name: &str, value: &[u8]) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO secrets(name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![name, self.seal(name, value)],
        )?;
        Ok(())
    }

    /// Registers a device for `email`, or marks a known one as just used. A browser has one subscription, so on a
    /// shared device the last user wins.
    pub fn add_device(&self, email: &str, s: &Subscription) -> rusqlite::Result<()> {
        let db = self.conn();
        db.execute(
            "INSERT INTO devices(endpoint, email, p256dh, auth, added) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET
                 email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth, added = excluded.added,
                 off = CASE WHEN devices.email = excluded.email THEN devices.off ELSE excluded.off END",
            params![s.endpoint, email, s.p256dh, s.auth, now()],
        )?;
        db.execute(
            "DELETE FROM devices WHERE email = ?1 AND endpoint NOT IN
             (SELECT endpoint FROM devices WHERE email = ?1 ORDER BY added DESC, rowid DESC LIMIT ?2)",
            params![email, MAX_DEVICES_PER_USER],
        )?;
        Ok(())
    }

    /// Sets what `email`'s own device at `endpoint` does not want, as `Subscription::off`. False: no such device.
    pub fn set_off(&self, email: &str, endpoint: &str, off: &str) -> rusqlite::Result<bool> {
        let n = self.conn().execute("UPDATE devices SET off = ?3 WHERE endpoint = ?1 AND email = ?2", params![endpoint, email, off])?;
        Ok(n > 0)
    }

    /// `email` limits the removal to the caller's own device; the sender passes None for a dead subscription.
    pub fn remove_device(&self, endpoint: &str, email: Option<&str>) -> rusqlite::Result<()> {
        self.conn().execute(
            "DELETE FROM devices WHERE endpoint = ?1 AND (?2 IS NULL OR email = ?2)",
            params![endpoint, email],
        )?;
        Ok(())
    }

    pub fn devices(&self, email: &str) -> rusqlite::Result<Vec<Subscription>> {
        self.conn()
            .prepare("SELECT endpoint, p256dh, auth, off FROM devices WHERE email = ?1")?
            .query_map([email], |r| Ok(Subscription { endpoint: r.get(0)?, p256dh: r.get(1)?, auth: r.get(2)?, off: r.get(3)? }))?
            .collect()
    }

    /// The users whose change feeds are read: anyone with a device to notify or a session to show activity to.
    pub fn watched(&self) -> rusqlite::Result<Vec<String>> {
        self.conn()
            .prepare(
                "SELECT email FROM users WHERE EXISTS(SELECT 1 FROM devices WHERE devices.email = users.email)
                 OR EXISTS(SELECT 1 FROM sessions WHERE sessions.email = users.email AND expires > ?1) ORDER BY email",
            )?
            .query_map([now()], |r| r.get(0))?
            .collect()
    }

    /// Appends what changed for one student, as (resource type, Add|Edit|Delete, resource id), and trims the list.
    pub fn add_activity(&self, email: &str, login: &str, entries: &[(&str, &str, &str)]) -> rusqlite::Result<()> {
        let mut db = self.conn();
        let tx = db.transaction()?;
        for (kind, change, resource) in entries {
            tx.execute(
                "INSERT INTO activity(email, login, at, kind, change, resource) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![email, login, now(), kind, change, resource],
            )?;
        }
        tx.execute(
            "DELETE FROM activity WHERE email = ?1 AND login = ?2 AND id NOT IN
             (SELECT id FROM activity WHERE email = ?1 AND login = ?2 ORDER BY id DESC LIMIT ?3)",
            params![email, login, MAX_ACTIVITY],
        )?;
        tx.commit()
    }

    /// One student's activity, newest first: (time, resource type, change, resource id).
    pub fn activity(&self, email: &str, login: &str) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
        self.conn()
            .prepare("SELECT at, kind, change, resource FROM activity WHERE email = ?1 AND login = ?2 ORDER BY id DESC")?
            .query_map([email, login], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect()
    }

    /// Change feeds of `email`, one per student: (login, Librus register id, last check, last error).
    pub fn feeds(&self, email: &str) -> rusqlite::Result<Vec<(String, String, i64, String)>> {
        self.conn()
            .prepare("SELECT login, register, checked, error FROM feeds WHERE email = ?1 ORDER BY login")?
            .query_map([email], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect()
    }

    /// Records the outcome of a check. An empty `register` means the feed has to be registered again.
    pub fn set_feed(&self, email: &str, login: &str, register: &str, error: &str) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO feeds(email, login, register, checked, error) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(email, login) DO UPDATE SET register = excluded.register, checked = excluded.checked, error = excluded.error",
            params![email, login, register, now(), error],
        )?;
        Ok(())
    }

    pub fn clear_feeds(&self, email: &str) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM feeds WHERE email = ?1", [email])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_list() {
        let s = Store::open(":memory:", &"ab".repeat(32)).expect("store");
        assert!(!s.is_allowed("a@x.pl"));
        assert!(s.allow("a@x.pl").unwrap());
        assert!(s.allow("a@x.pl").unwrap());
        assert!(s.is_allowed("a@x.pl"));
        assert_eq!(s.allowed().unwrap().len(), 1);

        let t = Tokens { access: "a".into(), refresh: "r".into(), accounts: vec![] };
        let sid = s.new_session("a@x.pl", Some(&t)).unwrap();
        assert!(s.allowed().unwrap()[0].2);

        s.revoke("a@x.pl", true).unwrap();
        assert!(!s.is_allowed("a@x.pl"));
        assert!(s.session_email(&sid).is_none());
        assert!(s.tokens("a@x.pl", Some(&sid)).is_none());

        for i in 0..MAX_ALLOWED {
            assert!(s.allow(&format!("u{i}@x.pl")).unwrap());
        }
        assert!(!s.allow("over@x.pl").unwrap());
        assert!(s.allow("u0@x.pl").unwrap());
    }

    #[test]
    fn tokens_go_with_the_last_session() {
        let s = Store::open(":memory:", &"ab".repeat(32)).expect("store");
        let t = Tokens { access: "a".into(), refresh: "r".into(), accounts: vec![] };
        let sids: Vec<String> = ["gone@x.pl", "phone@x.pl", "here@x.pl"].iter().map(|e| s.new_session(e, Some(&t)).unwrap()).collect();
        s.add_device("phone@x.pl", &Subscription { endpoint: "https://push/1".into(), p256dh: vec![4; 65], auth: vec![1; 16], off: String::new() }).unwrap();
        s.share_tokens("phone@x.pl", &sids[1]).unwrap();
        s.conn().execute("UPDATE sessions SET expires = 0 WHERE email != 'here@x.pl'", []).unwrap();

        let sid = s.new_session("here@x.pl", Some(&t)).unwrap();
        assert!(!s.renew_session(&sid).unwrap(), "a fresh session is left alone");
        s.conn().execute("UPDATE sessions SET expires = ?1 WHERE email = 'here@x.pl'", [now() + 60]).unwrap();
        assert!(s.renew_session(&sid).unwrap() && !s.renew_session(&sid).unwrap(), "one about to run out starts again, once");
        assert!(!s.renew_session("unknown").unwrap());
        assert!(s.tokens("gone@x.pl", Some(&sids[0])).is_none(), "sessions ran out and no device: the tokens are not kept");
        assert!(s.tokens("phone@x.pl", None).is_some(), "a device is still notified");
        assert!(s.tokens("here@x.pl", Some(&sid)).is_some());
    }

    #[test]
    fn own_copy_opens_only_with_its_session() {
        let s = Store::open(":memory:", &"ab".repeat(32)).expect("store");
        let t = |a: &str| Tokens { access: a.into(), refresh: "r".into(), accounts: vec![] };
        let sid = s.new_session("a@x.pl", Some(&t("own-token"))).unwrap();
        // Nothing the database or SECRET_KEY holds opens it.
        assert!(s.tokens("a@x.pl", None).is_none() && s.tokens("a@x.pl", Some("0000")).is_none());
        let blob: Vec<u8> = s.conn().query_row("SELECT tokens FROM sessions", [], |r| r.get(0)).unwrap();
        assert!(s.unseal("a@x.pl", &blob).is_none() && !blob.windows(9).any(|w| w == b"own-token"));
        assert_eq!(s.tokens("a@x.pl", Some(&sid)).unwrap().access, "own-token");
        s.update_tokens("a@x.pl", Some(&sid), &t("fresh")).unwrap();
        assert_eq!(s.tokens("a@x.pl", Some(&sid)).unwrap().access, "fresh");

        // Notifications on: the copy moves to the server, and a session without its own uses that one.
        let device = Subscription { endpoint: "https://push/1".into(), p256dh: vec![4; 65], auth: vec![1; 16], off: String::new() };
        s.add_device("a@x.pl", &device).unwrap();
        s.share_tokens("a@x.pl", &sid).unwrap();
        let other = s.new_session("a@x.pl", None).unwrap();
        assert_eq!(s.tokens("a@x.pl", Some(&other)).unwrap().access, "fresh");
        s.update_tokens("a@x.pl", Some(&sid), &t("again")).unwrap();
        assert_eq!(s.tokens("a@x.pl", None).unwrap().access, "again", "written back to the copy it came from");
        s.add_activity("a@x.pl", "1u", &[("Grades", "Add", "1")]).unwrap();

        // Off again: back into this session; the server keeps nothing it can open, and no history.
        s.unshare_tokens("a@x.pl", &sid).unwrap();
        s.remove_device(&device.endpoint, Some("a@x.pl")).unwrap();
        s.purge().unwrap();
        assert!(s.tokens("a@x.pl", None).is_none() && s.tokens("a@x.pl", Some(&other)).is_none());
        assert_eq!(s.tokens("a@x.pl", Some(&sid)).unwrap().access, "again");
        assert!(s.activity("a@x.pl", "1u").unwrap().is_empty());

        // A copy from before, without a device, goes: its owner signs in again.
        s.put_tokens("old@x.pl", &t("old")).unwrap();
        s.purge().unwrap();
        assert!(s.tokens("old@x.pl", None).is_none());

        // Deleting one's data takes every session with it.
        s.forget("a@x.pl").unwrap();
        assert!(s.session_email(&sid).is_none() && s.tokens("a@x.pl", Some(&sid)).is_none());
    }

    #[test]
    fn devices_and_secrets() {
        let s = Store::open(":memory:", &"ab".repeat(32)).expect("store");
        assert!(s.secret("vapid").is_none());
        s.set_secret("vapid", b"key").unwrap();
        assert_eq!(s.secret("vapid").as_deref(), Some(&b"key"[..]));

        let t = Tokens { access: "a".into(), refresh: "r".into(), accounts: vec![] };
        for email in ["a@x.pl", "b@x.pl"] {
            s.put_tokens(email, &t).unwrap();
        }
        let device = |n: i64| Subscription { endpoint: format!("https://push/{n}"), p256dh: vec![4; 65], auth: vec![1; 16], off: String::new() };
        for n in 0..=MAX_DEVICES_PER_USER {
            s.add_device("a@x.pl", &device(n)).unwrap();
        }
        let kept: Vec<String> = s.devices("a@x.pl").unwrap().into_iter().map(|d| d.endpoint).collect();
        assert_eq!(kept.len() as i64, MAX_DEVICES_PER_USER);
        assert!(!kept.contains(&device(0).endpoint), "the oldest device goes first");

        s.add_device("b@x.pl", &device(1)).unwrap();
        assert_eq!(s.devices("b@x.pl").unwrap().len(), 1, "a shared browser moves to its last user");
        assert_eq!(s.watched().unwrap(), ["a@x.pl", "b@x.pl"]);
        s.remove_device(&device(1).endpoint, Some("a@x.pl")).unwrap();
        assert_eq!(s.devices("b@x.pl").unwrap().len(), 1, "only the owner removes a device");
        assert_eq!(s.devices("b@x.pl").unwrap()[0].off, "przerwy", "the breaks start off");
        assert!(s.set_off("b@x.pl", &device(1).endpoint, "oceny").unwrap());
        assert!(!s.set_off("a@x.pl", &device(1).endpoint, "oceny").unwrap(), "only the owner says what a device gets");
        s.add_device("b@x.pl", &device(1)).unwrap();
        assert_eq!(s.devices("b@x.pl").unwrap()[0].off, "oceny", "a device registered again keeps its choice");
        s.add_device("a@x.pl", &device(1)).unwrap();
        assert_eq!(s.devices("a@x.pl").unwrap().iter().find(|d| d.endpoint == device(1).endpoint).unwrap().off, "przerwy", "not its last user's");
        s.add_device("b@x.pl", &device(1)).unwrap();

        s.set_feed("a@x.pl", "1u", "77", "").unwrap();
        s.set_feed("a@x.pl", "1u", "", "gone").unwrap();
        let feeds = s.feeds("a@x.pl").unwrap();
        assert_eq!((feeds.len(), feeds[0].1.as_str(), feeds[0].3.as_str()), (1, "", "gone"));

        s.put_tokens("c@x.pl", &t).unwrap();
        assert!(!s.watched().unwrap().contains(&"c@x.pl".to_string()), "no device and no session: nobody to tell");
        s.new_session("c@x.pl", None).unwrap();
        assert!(s.watched().unwrap().contains(&"c@x.pl".to_string()));

        let many: Vec<(&str, &str, &str)> = (0..MAX_ACTIVITY + 5).map(|_| ("Grades", "Add", "1")).collect();
        s.add_activity("a@x.pl", "1u", &many).unwrap();
        s.add_activity("a@x.pl", "1u", &[("Grades", "Edit", "7")]).unwrap();
        s.add_activity("a@x.pl", "2u", &[("Notes", "Add", "9")]).unwrap();
        let list = s.activity("a@x.pl", "1u").unwrap();
        assert_eq!(list.len() as i64, MAX_ACTIVITY);
        assert_eq!((list[0].1.as_str(), list[0].2.as_str(), list[0].3.as_str()), ("Grades", "Edit", "7"), "newest first");
        assert_eq!(s.activity("a@x.pl", "2u").unwrap().len(), 1, "one student's list does not push out another's");

        s.revoke("a@x.pl", true).unwrap();
        assert!(s.devices("a@x.pl").unwrap().is_empty() && s.feeds("a@x.pl").unwrap().is_empty());
        assert!(s.activity("a@x.pl", "1u").unwrap().is_empty());
    }
}

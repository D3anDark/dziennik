use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, KeyInit, Nonce, Payload};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SESSION_TTL_SECS: i64 = 30 * 24 * 3600;
const MAX_SESSIONS_PER_USER: i64 = 10;

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
             CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email);",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { db: Mutex::new(db), cipher })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn seal(&self, email: &str, t: &Tokens) -> Vec<u8> {
        let plain = serde_json::to_vec(t).expect("Tokens serialize");
        let nonce_bytes = random::<12>();
        let nonce = Nonce::<Aes256Gcm>::from(nonce_bytes);
        let ct = self
            .cipher
            .encrypt(&nonce, Payload { msg: &plain, aad: email.as_bytes() })
            .expect("AES-GCM encrypt");
        let mut blob = nonce_bytes.to_vec();
        blob.extend_from_slice(&ct);
        blob
    }

    pub fn put_tokens(&self, email: &str, t: &Tokens) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO users(email, tokens, updated) VALUES (?1, ?2, ?3)
             ON CONFLICT(email) DO UPDATE SET tokens = excluded.tokens, updated = excluded.updated",
            params![email, self.seal(email, t), now()],
        )?;
        Ok(())
    }

    /// Update only; never resurrects a user whose last session logged out mid-refresh.
    pub fn update_tokens(&self, email: &str, t: &Tokens) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE users SET tokens = ?2, updated = ?3 WHERE email = ?1",
            params![email, self.seal(email, t), now()],
        )?;
        Ok(())
    }

    pub fn tokens(&self, email: &str) -> Option<Tokens> {
        let blob: Vec<u8> = self
            .conn()
            .query_row("SELECT tokens FROM users WHERE email = ?1", [email], |r| r.get(0))
            .optional()
            .ok()??;
        let (n, ct) = blob.split_at_checked(12)?;
        let nonce = Nonce::<Aes256Gcm>::try_from(n).ok()?;
        let plain = self.cipher.decrypt(&nonce, Payload { msg: ct, aad: email.as_bytes() }).ok()?;
        serde_json::from_slice(&plain).ok()
    }

    pub fn new_session(&self, email: &str) -> rusqlite::Result<String> {
        let sid: String = random::<32>().iter().map(|b| format!("{b:02x}")).collect();
        let db = self.conn();
        db.execute("DELETE FROM sessions WHERE expires <= ?1", [now()])?;
        db.execute(
            "INSERT INTO sessions(sid_hash, email, expires) VALUES (?1, ?2, ?3)",
            params![sid_hash(&sid), email, now() + SESSION_TTL_SECS],
        )?;
        db.execute(
            "DELETE FROM sessions WHERE email = ?1 AND sid_hash NOT IN
             (SELECT sid_hash FROM sessions WHERE email = ?1 ORDER BY expires DESC LIMIT ?2)",
            params![email, MAX_SESSIONS_PER_USER],
        )?;
        Ok(sid)
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
}

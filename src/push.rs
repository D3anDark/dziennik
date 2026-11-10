//! Web Push on the crypto the TLS stack already ships: VAPID (RFC 8292) and aes128gcm message encryption (RFC 8291).

use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::aead::{AES_128_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use aws_lc_rs::agreement::{self, ECDH_P256, PrivateKey, UnparsedPublicKey};
use aws_lc_rs::error::Unspecified;
use aws_lc_rs::hkdf::{HKDF_SHA256, KeyType, Salt};
use aws_lc_rs::rand::{SystemRandom, fill};
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use reqwest::header::{AUTHORIZATION, CONTENT_ENCODING};
use reqwest::{Client, StatusCode, Url};
use serde_json::json;

/// The browser push services. A subscription endpoint comes from the client, so anything else would let a
/// signed-in user aim this server's requests at an arbitrary host.
const SERVICES: &[&str] = &["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
/// One record of the default size (4096) minus the tag and the delimiter, with room to spare.
const MAX_PAYLOAD: usize = 3000;
/// How long the push service keeps a message for a device that is offline.
const TTL_SECS: &str = "86400";

pub struct Subscription {
    pub endpoint: String,
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
}

impl Subscription {
    /// From the fields of `PushSubscription.toJSON()`; None unless it points at a known push service.
    pub fn parse(endpoint: &str, p256dh: &str, auth: &str) -> Option<Self> {
        let url = Url::parse(endpoint).ok().filter(|_| endpoint.len() <= 1024)?;
        let host = url.host_str()?;
        if url.scheme() != "https" || !SERVICES.iter().any(|s| host == *s || host.ends_with(&format!(".{s}"))) {
            return None;
        }
        let p256dh = B64.decode(p256dh.trim_end_matches('=')).ok().filter(|k| k.len() == 65 && k[0] == 4)?;
        let auth = B64.decode(auth.trim_end_matches('=')).ok().filter(|a| a.len() == 16)?;
        Some(Self { endpoint: endpoint.to_string(), p256dh, auth })
    }
}

pub struct Vapid {
    key: EcdsaKeyPair,
    /// The applicationServerKey browsers subscribe with: the public point, base64url.
    pub public: String,
    subject: String,
}

impl Vapid {
    /// A new signing key as PKCS#8, to be stored and passed to `load`.
    pub fn generate() -> Result<Vec<u8>, Unspecified> {
        Ok(EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING)?.to_pkcs8v1()?.as_ref().to_vec())
    }

    /// `contact` is the address a push service operator can reach the admin at.
    pub fn load(pkcs8: &[u8], contact: &str) -> Option<Self> {
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8).ok()?;
        let public = B64.encode(key.public_key().as_ref());
        Some(Self { key, public, subject: format!("mailto:{contact}") })
    }

    fn authorization(&self, endpoint: &Url) -> Result<String, Unspecified> {
        let exp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) + 12 * 3600;
        let claims = json!({ "aud": endpoint.origin().ascii_serialization(), "exp": exp, "sub": self.subject });
        let input = format!("{}.{}", B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#), B64.encode(claims.to_string()));
        let signature = self.key.sign(&SystemRandom::new(), input.as_bytes())?;
        Ok(format!("vapid t={input}.{}, k={}", B64.encode(signature), self.public))
    }
}

struct Len(usize);

impl KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf<const N: usize>(salt: &[u8], ikm: &[u8], info: &[&[u8]]) -> Result<[u8; N], Unspecified> {
    let mut out = [0u8; N];
    Salt::new(HKDF_SHA256, salt).extract(ikm).expand(info, Len(N))?.fill(&mut out)?;
    Ok(out)
}

/// The aes128gcm body of RFC 8291 for a single record. `sender` and `salt` are fresh for every message.
fn encrypt(sub: &Subscription, plaintext: &[u8], sender: &PrivateKey, salt: [u8; 16]) -> Result<Vec<u8>, Unspecified> {
    if plaintext.len() > MAX_PAYLOAD {
        return Err(Unspecified);
    }
    let public = sender.compute_public_key()?;
    let ikm: [u8; 32] = agreement::agree(sender, UnparsedPublicKey::new(&ECDH_P256, &sub.p256dh), Unspecified, |secret| {
        hkdf(&sub.auth, secret, &[b"WebPush: info\0", &sub.p256dh, public.as_ref()])
    })?;
    let key: [u8; 16] = hkdf(&salt, &ikm, &[b"Content-Encoding: aes128gcm\0"])?;
    let nonce: [u8; 12] = hkdf(&salt, &ikm, &[b"Content-Encoding: nonce\0"])?;
    let mut record = plaintext.to_vec();
    record.push(2); // delimiter of the last record
    LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &key)?).seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::empty(),
        &mut record,
    )?;
    let mut body = salt.to_vec();
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(public.as_ref().len() as u8);
    body.extend_from_slice(public.as_ref());
    body.extend_from_slice(&record);
    Ok(body)
}

pub enum Sent {
    Delivered,
    /// The push service no longer knows the subscription, or refuses this server's key: drop it.
    Gone,
}

/// Hands `payload` to the push service of one subscription. `http` must not follow redirects.
pub async fn send(http: &Client, vapid: &Vapid, sub: &Subscription, payload: &[u8]) -> Result<Sent, String> {
    let crypto = |_| "push encryption failed".to_string();
    let url = Url::parse(&sub.endpoint).map_err(|e| e.to_string())?;
    let mut salt = [0u8; 16];
    fill(&mut salt).map_err(crypto)?;
    let sender = PrivateKey::generate(&ECDH_P256).map_err(crypto)?;
    let body = encrypt(sub, payload, &sender, salt).map_err(crypto)?;
    let res = http
        .post(url.clone())
        .header(AUTHORIZATION, vapid.authorization(&url).map_err(crypto)?)
        .header(CONTENT_ENCODING, "aes128gcm")
        .header("TTL", TTL_SECS)
        .body(body)
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    match res.status() {
        s if s.is_success() => Ok(Sent::Delivered),
        StatusCode::NOT_FOUND | StatusCode::GONE | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Ok(Sent::Gone),
        s => Err(format!("push service answered {s}")),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Reverses `encrypt` with the receiver's private key, as a browser does.
    pub fn decrypt(receiver: &PrivateKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        assert_eq!(rest[..5], [0, 0, 16, 0, 65]);
        let (sender, record) = rest[5..].split_at(65);
        let own = receiver.compute_public_key().unwrap();
        let ikm: [u8; 32] = agreement::agree(receiver, UnparsedPublicKey::new(&ECDH_P256, sender), Unspecified, |secret| {
            hkdf(auth, secret, &[b"WebPush: info\0", own.as_ref(), sender])
        })
        .unwrap();
        let key: [u8; 16] = hkdf(salt, &ikm, &[b"Content-Encoding: aes128gcm\0"]).unwrap();
        let nonce: [u8; 12] = hkdf(salt, &ikm, &[b"Content-Encoding: nonce\0"]).unwrap();
        let mut record = record.to_vec();
        let plain = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &key).unwrap())
            .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut record)
            .unwrap();
        assert_eq!(plain.last(), Some(&2));
        plain[..plain.len() - 1].to_vec()
    }

    /// The example of RFC 8291, section 5 and appendix A.
    #[test]
    fn rfc8291_example() {
        let d = |s: &str| B64.decode(s).unwrap();
        let sub = Subscription {
            endpoint: String::new(),
            p256dh: d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
            auth: d("BTBZMqHH6r4Tts7J_aSIgg"),
        };
        let sender = PrivateKey::from_private_key(&ECDH_P256, &d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let plain = b"When I grow up, I want to be a watermelon";
        let body = encrypt(&sub, plain, &sender, salt).unwrap();
        assert_eq!(
            B64.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_\
             yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
        let receiver = PrivateKey::from_private_key(&ECDH_P256, &d("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(decrypt(&receiver, &sub.auth, &body), plain);
        assert!(encrypt(&sub, &[0; MAX_PAYLOAD + 1], &sender, salt).is_err());
    }

    #[test]
    fn vapid_token() {
        use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
        let vapid = Vapid::load(&Vapid::generate().unwrap(), "admin@example.com").unwrap();
        let header = vapid.authorization(&Url::parse("https://fcm.googleapis.com/fcm/send/abc").unwrap()).unwrap();
        let (token, key) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(key, vapid.public);
        let (input, signature) = token.rsplit_once('.').unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, B64.decode(key).unwrap())
            .verify(input.as_bytes(), &B64.decode(signature).unwrap())
            .expect("ES256 signature");
        let claims: serde_json::Value = serde_json::from_slice(&B64.decode(input.split_once('.').unwrap().1).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:admin@example.com");
    }

    #[test]
    fn subscription_shape() {
        let key = B64.encode([4u8; 65]);
        let auth = B64.encode([1u8; 16]);
        assert!(Subscription::parse("https://fcm.googleapis.com/fcm/send/x", &key, &auth).is_some());
        assert!(Subscription::parse("https://web.push.apple.com/x", &key, &auth).is_some());
        assert!(Subscription::parse("https://updates.push.services.mozilla.com/wpush/v2/x", &key, &auth).is_some());
        for endpoint in ["http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://evilfcm.googleapis.com.evil.pl/x", "https://push.apple.com.evil.pl/x"] {
            assert!(Subscription::parse(endpoint, &key, &auth).is_none(), "{endpoint}");
        }
        assert!(Subscription::parse("https://fcm.googleapis.com/x", &B64.encode([4u8; 64]), &auth).is_none());
        assert!(Subscription::parse("https://fcm.googleapis.com/x", &key, &B64.encode([1u8; 15])).is_none());
    }
}

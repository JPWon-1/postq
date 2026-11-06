//! 시크릿 at-rest 암호화.
//!
//! 저장형은 Node 와 바이트 단위로 같다: "enc:v1:" + base64(iv(12) | tag(16) | ciphertext), AES-256-GCM.
//! Node 시절에 저장된 암호문을 그대로 풀어야 한다.
//! 키(SECRET_ENCRYPTION_KEY)가 없으면 평문 그대로(하위호환), 레거시 평문(접두 없음)은 그대로 읽는다.
//!
//! 키는 부를 때마다 환경 변수에서 읽는다. 테스트는 `*_with(&Keys, ..)` 로 키를 직접 넘긴다 —
//! 환경 변수는 프로세스 전역이라 병렬 테스트끼리 서로 덮는다.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::server_log::{self, Level};

const PREFIX: &str = "enc:v1:";

pub type Key = [u8; 32];

/// 현재 키(쓰기·읽기)와 옛 키들(읽기 전용).
#[derive(Clone, Default)]
pub struct Keys {
    pub current: Option<Key>,
    pub old: Vec<Key>,
}

impl Keys {
    /// SECRET_ENCRYPTION_KEY / SECRET_ENCRYPTION_KEY_OLD(쉼표 구분). 빈 값은 '없음'.
    pub fn from_env() -> Keys {
        let current = std::env::var("SECRET_ENCRYPTION_KEY").ok().filter(|k| !k.is_empty()).map(|k| derive_key(&k));
        let old = std::env::var("SECRET_ENCRYPTION_KEY_OLD")
            .ok()
            .map(|raw| raw.split(',').map(crate::js::trim).filter(|s| !s.is_empty()).map(derive_key).collect())
            .unwrap_or_default();
        Keys { current, old }
    }

    pub fn new(current: Option<&str>, old: &[&str]) -> Keys {
        Keys { current: current.filter(|k| !k.is_empty()).map(derive_key), old: old.iter().map(|k| derive_key(k)).collect() }
    }
}

/// 문자열 → 32바이트 키. hex 64자면 그대로(대소문자 무관), 아니면 sha256 으로 파생.
pub fn derive_key(k: &str) -> Key {
    if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) {
        let mut out = [0u8; 32];
        hex::decode_to_slice(k, &mut out).expect("hex 64자");
        return out;
    }
    Sha256::digest(k.as_bytes()).into()
}

pub fn is_encrypted(v: &str) -> bool {
    v.starts_with(PREFIX)
}

// ── 세는 것들 ─────────────────────────────────────────────────────────────
// 못 푼 수와 옛 키로 읽은 수는 섞으면 안 된다 — 앞은 고장, 뒤는 '아직 안 옮겼다' 다.

static DECRYPT_FAILURES: AtomicU64 = AtomicU64::new(0);
static WARNED_DECRYPT: AtomicBool = AtomicBool::new(false);
static OLD_KEY_READS: AtomicU64 = AtomicU64::new(0);
static WARNED_OLD_KEY: AtomicBool = AtomicBool::new(false);

/// 지금까지 못 푼 secret 의 수(0이면 정상). 상태 점검이 읽는다.
pub fn decrypt_failure_count() -> u64 {
    DECRYPT_FAILURES.load(Ordering::Relaxed)
}

/// 옛 키로 읽은 secret 의 수(0이면 옛 키를 지워도 된다).
pub fn old_key_read_count() -> u64 {
    OLD_KEY_READS.load(Ordering::Relaxed)
}

fn warn_decrypt_failure(why: &str) {
    DECRYPT_FAILURES.fetch_add(1, Ordering::Relaxed);
    if WARNED_DECRYPT.swap(true, Ordering::Relaxed) {
        return;
    }
    // 못 푼 secret 은 빈 값이 되어 자격증명 없이 요청이 나간다. 화면엔 신호가 없으니 앱 안 로그에 남긴다.
    let msg = format!("저장된 secret 을 복호화하지 못했습니다({why})");
    let detail = "SECRET_ENCRYPTION_KEY 가 값을 저장할 때와 다릅니다. \
        해당 secret 은 빈 값으로 처리되어, 그 변수를 쓰는 요청은 자격증명 없이 나갑니다. \
        옛 키를 되찾아 넣거나, 값을 다시 입력하세요.";
    eprintln!("[secretbox] {msg} — {detail}");
    server_log::log(Level::Error, "secret 복호화", &msg, Some(detail), None);
}

fn note_old_key_read() {
    OLD_KEY_READS.fetch_add(1, Ordering::Relaxed);
    if WARNED_OLD_KEY.swap(true, Ordering::Relaxed) {
        return;
    }
    let msg = "옛 키로 읽은 secret 이 있습니다";
    let detail = "SECRET_ENCRYPTION_KEY_OLD 덕분에 값은 정상으로 읽힙니다. \
        다만 아직 현재 키로 옮겨지지 않았습니다 — 환경 화면에서 [현재 키로 옮기기] 를 누르면 \
        한 번에 정리되고, 그 뒤 SECRET_ENCRYPTION_KEY_OLD 를 지울 수 있습니다.";
    eprintln!("[secretbox] {msg} — {detail}");
    server_log::log(Level::Warn, "secret 키 교체", msg, Some(detail), None);
}

// ── 암호화·복호화 ─────────────────────────────────────────────────────────

/// 평문 → 암호문. 키 없거나 빈 값이면 평문 그대로. 이미 암호문이면 그대로(이중 암호화 안 함).
pub fn encrypt_with(keys: &Keys, plain: &str) -> String {
    if keys.current.is_none() || plain.is_empty() || is_encrypted(plain) {
        return plain.to_string();
    }
    encrypt_bytes_with(keys, plain.as_bytes()).unwrap_or_else(|| plain.to_string())
}

/// 바이트 그대로 암호화 — Node 에서 Buffer 를 encryptSecret 에 넘긴 경우(cipher.update 가 바이트를 그대로 받는다).
/// 문자열과 달리 빈 값·enc 접두 검사가 없다(isEncrypted 는 typeof string 일 때만 참). 키가 없으면 None.
pub fn encrypt_bytes_with(keys: &Keys, plain: &[u8]) -> Option<String> {
    let k = keys.current?;
    let mut iv = [0u8; 12];
    getrandom::getrandom(&mut iv).expect("난수 생성 실패");
    let cipher = Aes256Gcm::new(&k.into());
    // aes-gcm 은 ciphertext|tag 로 돌려준다. 저장형은 iv|tag|ciphertext — 순서를 바꿔 담는다.
    let sealed = cipher.encrypt(Nonce::from_slice(&iv), plain).expect("AES-GCM 암호화 실패");
    let (ct, tag) = sealed.split_at(sealed.len() - 16);
    let mut buf = Vec::with_capacity(12 + 16 + ct.len());
    buf.extend_from_slice(&iv);
    buf.extend_from_slice(tag);
    buf.extend_from_slice(ct);
    Some(format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

/// Buffer.from(s, 'base64') — 너그럽게 읽는다: url-safe 글자(-_)도 받고, 모르는 글자는 건너뛰고,
/// '=' 에서 멈추고, 남는 비트는 버린다. 엄격하게 읽으면 Node 가 풀던 값을 Rust 만 못 푸는 일이 생긴다.
fn node_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// 이 키로 풀리면 평문, 아니면 None.
///
/// Node 는 12바이트가 아닌 iv·16바이트보다 짧은 tag 도 받지만(GCM 이 허용한다), 우리가 쓴 암호문은 언제나
/// 12/16 이라 그런 값은 손상이거나 만든 값이다 — 여기서는 못 푸는 값으로 본다.
fn try_decrypt(stored: &str, k: &Key) -> Option<String> {
    // Node 의 toString('utf8') 처럼 깨진 바이트는 U+FFFD 로.
    try_decrypt_bytes(stored, k).map(|plain| String::from_utf8_lossy(&plain).into_owned())
}

fn try_decrypt_bytes(stored: &str, k: &Key) -> Option<Vec<u8>> {
    let buf = node_base64(&stored[PREFIX.len()..]);
    if buf.len() < 28 {
        return None;
    }
    let (iv, rest) = buf.split_at(12);
    let (tag, ct) = rest.split_at(16);
    let mut sealed = Vec::with_capacity(ct.len() + 16);
    sealed.extend_from_slice(ct);
    sealed.extend_from_slice(tag);
    Aes256Gcm::new(k.into()).decrypt(Nonce::from_slice(iv), Payload { msg: &sealed, aad: &[] }).ok()
}

/// 현재 키로 풀어 바이트 그대로 — [`encrypt_bytes_with`] 의 짝(테스트·점검용). 못 풀면 None, 카운터는 건드리지 않는다.
pub fn decrypt_bytes_with(keys: &Keys, stored: &str) -> Option<Vec<u8>> {
    if !is_encrypted(stored) {
        return None;
    }
    try_decrypt_bytes(stored, keys.current.as_ref()?)
}

/// 저장값 → 평문. 접두가 없으면 레거시 평문 그대로.
/// 암호문인데 키가 없거나 못 풀면 '' (+경고) — 암호문 원문이 자격증명으로 외부에 나가지 않게, '자격증명 없음' 으로 실패시킨다.
pub fn decrypt_with(keys: &Keys, stored: &str) -> String {
    if !is_encrypted(stored) {
        return stored.to_string();
    }
    let Some(k) = keys.current else {
        warn_decrypt_failure("키 미설정");
        return String::new();
    };
    if let Some(p) = try_decrypt(stored, &k) {
        return p;
    }
    // 현재 키로 안 풀리면 옛 키로 — 값은 살아 있고 포장만 옛것이다. 따로 세어 알린다.
    for old in &keys.old {
        if let Some(p) = try_decrypt(stored, old) {
            note_old_key_read();
            return p;
        }
    }
    warn_decrypt_failure("키 불일치 또는 데이터 손상");
    String::new()
}

pub fn encrypt_secret(plain: &str) -> String {
    encrypt_with(&Keys::from_env(), plain)
}

pub fn decrypt_secret(stored: &str) -> String {
    decrypt_with(&Keys::from_env(), stored)
}

/// 저장된 secret 이 어느 키에 묶여 있나.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyState {
    /// 암호화 전 레거시 값 — 풀 것이 없다
    Plain,
    /// 현재 키로 읽힌다(정상)
    Current,
    /// 옛 키로만 읽힌다 — 값은 살아 있고, 옮기면 된다
    Old,
    /// 어떤 키로도 못 읽는다 — 다시 입력하는 수밖에 없다
    Broken,
}

impl KeyState {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyState::Plain => "plain",
            KeyState::Current => "current",
            KeyState::Old => "old",
            KeyState::Broken => "broken",
        }
    }
}

/// 어느 키에 묶여 있는지 묻기만 한다 — 세지 않는다. 화면이 목록을 그릴 때마다 부르는 자리라,
/// 여기서 세면 실패 수가 불어나 상태 점검이 거짓말을 한다.
pub fn key_state_with(keys: &Keys, stored: &str) -> KeyState {
    if !is_encrypted(stored) {
        return KeyState::Plain;
    }
    if let Some(k) = keys.current {
        if try_decrypt(stored, &k).is_some() {
            return KeyState::Current;
        }
    }
    if keys.old.iter().any(|o| try_decrypt(stored, o).is_some()) {
        return KeyState::Old;
    }
    KeyState::Broken
}

pub fn secret_key_state(stored: &str) -> KeyState {
    key_state_with(&Keys::from_env(), stored)
}

/// 지금 이 값을 쓸 수 있나(현재 키든 옛 키든).
pub fn can_decrypt_secret(stored: &str) -> bool {
    secret_key_state(stored) != KeyState::Broken
}

/// 옛 키로만 읽히는 값을 현재 키로 다시 포장한다. 옮길 필요가 없거나 못 읽으면 None.
/// 다시 읽히는지까지 확인한다 — 안 읽히는 암호문으로 덮으면 살아 있는 자격증명을 영영 잃는다.
pub fn rewrap_with(keys: &Keys, stored: &str) -> Option<String> {
    if key_state_with(keys, stored) != KeyState::Old {
        return None;
    }
    let plain = decrypt_with(keys, stored);
    if plain.is_empty() {
        return None;
    }
    let next = encrypt_with(keys, &plain);
    let k = keys.current?;
    (is_encrypted(&next) && try_decrypt(&next, &k).as_deref() == Some(plain.as_str())).then_some(next)
}

pub fn rewrap_with_current_key(stored: &str) -> Option<String> {
    rewrap_with(&Keys::from_env(), stored)
}

/// 저장 편의: secret 인 값만 암호화.
pub fn store_secret_with(keys: &Keys, value: &str, secret: bool) -> String {
    if secret {
        encrypt_with(keys, value)
    } else {
        value.to_string()
    }
}

pub fn store_secret_value(value: &str, secret: bool) -> String {
    store_secret_with(&Keys::from_env(), value, secret)
}

// ── AuthConfig ──────────────────────────────────────────────────────────
// secret 필드(token/password/value/clientSecret)만 at-rest 암호화/복호화한다. 키 없으면 no-op.

/// 인증 종류별 secret 필드.
fn auth_secret_field(auth: &Value) -> Option<&'static str> {
    match auth.get("type")?.as_str()? {
        "bearer" => Some("token"),
        "basic" => Some("password"),
        "apikey" => Some("value"),
        "oauth2cc" => Some("clientSecret"),
        _ => None,
    }
}

/// Node 는 `{ ...auth, token: f(auth.token ?? '') }` 이다. 그대로 따른다:
/// 필드가 없거나 null 이면 '' 로 채워 넣고(자리는 맨 뒤), 있으면 제자리에서 바꾼다.
/// 문자열이 아닌 값은 — 키가 있으면 Node 가 TypeError 를 던지므로 Err, 키가 없으면 그대로 둔다.
fn map_auth(auth: &Value, f: impl Fn(&str) -> String, needs_string: bool) -> Result<Value, String> {
    let Some(obj) = auth.as_object().filter(|o| o.get("type").map_or(false, Value::is_string)) else {
        return Ok(serde_json::json!({ "type": "none" }));
    };
    let Some(field) = auth_secret_field(auth) else { return Ok(auth.clone()) };
    let mut out = obj.clone();
    let next = match obj.get(field) {
        None | Some(Value::Null) => Value::String(f("")),
        Some(Value::String(s)) => Value::String(f(s)),
        Some(other) if needs_string => {
            return Err(format!("The \"data\" argument must be of type string. Received {}", other))
        }
        Some(other) => other.clone(),
    };
    out.insert(field.to_string(), next);
    Ok(Value::Object(out))
}

pub fn encrypt_auth_config_with(keys: &Keys, auth: &Value) -> Result<Value, String> {
    map_auth(auth, |s| encrypt_with(keys, s), keys.current.is_some())
}

pub fn decrypt_auth_config_with(keys: &Keys, auth: &Value) -> Value {
    // decryptSecret 은 문자열이 아니면 그대로 돌려준다(isEncrypted 가 typeof 를 본다) — 실패할 일이 없다.
    map_auth(auth, |s| decrypt_with(keys, s), false).unwrap_or_else(|_| auth.clone())
}

pub fn encrypt_auth_config(auth: &Value) -> Result<Value, String> {
    encrypt_auth_config_with(&Keys::from_env(), auth)
}

pub fn decrypt_auth_config(auth: &Value) -> Value {
    decrypt_auth_config_with(&Keys::from_env(), auth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "test-secret-encryption-key-32chars!!";
    const OLD: &str = "old-key-from-env-local-aaaaaaaaaaa";
    const NEW: &str = "new-key-from-env-bbbbbbbbbbbbbbbbb";

    fn k(cur: &str) -> Keys {
        Keys::new(Some(cur), &[])
    }
    /// 실패 경고가 서버 로그에 한 줄 남을 수 있다 — 서버 로그 테스트와 엇갈리지 않게 같은 잠금을 쓴다.
    fn quiet() -> std::sync::MutexGuard<'static, ()> {
        crate::server_log::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── Node 와 서로 푼다 ──
    // 아래 암호문은 src/lib/secretbox.ts 의 encryptSecret 으로 만든 것(npx tsx 로 실행).
    const NODE_VECTOR: &str = "enc:v1:W/2Jl2uhQFle/mI3a+q5HfLhGcu+wM/sUDQAioHuF3LgyP0Uuw75Skk2Om67ECQzjGB60Uah0trYNQ==";
    const NODE_HEX_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899AABBCCDDEEFF";
    const NODE_HEX_VECTOR: &str = "enc:v1:U3eqVLLF/jy42lweUeH8VPUb0lUHUOdIJ5xBsGIcLPsS9b/mEfV9zQc=";

    #[test]
    fn node_가_만든_암호문을_푼다() {
        assert_eq!(decrypt_with(&k(KEY), NODE_VECTOR), "super-secret-token 한글 🔑");
        assert_eq!(decrypt_with(&k(NODE_HEX_KEY), NODE_HEX_VECTOR), "hex-key-plain");
        // 키 파생이 같아야 한다 — hex 64자는 sha256 이 아니라 그대로.
        assert_eq!(key_state_with(&k(&NODE_HEX_KEY.to_lowercase()), NODE_HEX_VECTOR), KeyState::Current);
    }

    #[test]
    fn rust_가_만든_암호문을_node_가_푼다() {
        // node 가 없는 곳(CI 이미지 등)에서는 건너뛴다 — 위의 반대 방향 시험이 형식은 묶어 둔다.
        let enc = encrypt_with(&k(KEY), "rust→node 왕복 🔐");
        let script = r#"
const { createDecipheriv, createHash } = require('node:crypto')
const [key, stored] = process.argv.slice(1)
const k = /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, 'hex') : createHash('sha256').update(key).digest()
const buf = Buffer.from(stored.slice('enc:v1:'.length), 'base64')
const d = createDecipheriv('aes-256-gcm', k, buf.subarray(0, 12))
d.setAuthTag(buf.subarray(12, 28))
process.stdout.write(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'))
"#;
        match std::process::Command::new("node").arg("-e").arg(script).arg(KEY).arg(&enc).output() {
            Ok(out) => {
                assert!(out.status.success(), "node 가 못 풀었다: {}", String::from_utf8_lossy(&out.stderr));
                assert_eq!(String::from_utf8(out.stdout).unwrap(), "rust→node 왕복 🔐");
            }
            Err(_) => eprintln!("node 없음 — 건너뜀"),
        }
    }


    #[test]
    fn 암호화_왕복() {
        let enc = encrypt_with(&k(KEY), "super-secret-token");
        assert!(is_encrypted(&enc));
        assert!(!enc.contains("super-secret-token"));
        assert_eq!(decrypt_with(&k(KEY), &enc), "super-secret-token");
    }

    #[test]
    fn 매_암호화가_다른_결과지만_같은_평문으로_복호() {
        let (a, b) = (encrypt_with(&k(KEY), "x"), encrypt_with(&k(KEY), "x"));
        assert_ne!(a, b);
        assert_eq!(decrypt_with(&k(KEY), &a), "x");
        assert_eq!(decrypt_with(&k(KEY), &b), "x");
    }

    #[test]
    fn 빈_값_이미_암호문은_그대로() {
        assert_eq!(encrypt_with(&k(KEY), ""), "");
        let once = encrypt_with(&k(KEY), "v");
        assert_eq!(encrypt_with(&k(KEY), &once), once);
    }

    #[test]
    fn 레거시_평문은_복호화가_그대로_통과() {
        assert_eq!(decrypt_with(&k(KEY), "legacy-plaintext"), "legacy-plaintext");
    }

    #[test]
    fn 변조된_암호문은_빈_값() {
        let _q = quiet();
        let enc = encrypt_with(&k(KEY), "secret");
        let tampered = format!("{}AAAA", &enc[..enc.len() - 4]);
        assert_eq!(decrypt_with(&k(KEY), &tampered), "");
    }

    #[test]
    fn 키_미설정인데_암호문이면_빈_값() {
        let _q = quiet();
        let enc = encrypt_with(&k(KEY), "secret");
        let none = Keys::default();
        assert_eq!(decrypt_with(&none, &enc), "");
        assert_eq!(decrypt_with(&none, "legacy-plaintext"), "legacy-plaintext");
    }

    #[test]
    fn 키_미설정이면_평문_그대로() {
        let none = Keys::default();
        assert_eq!(encrypt_with(&none, "token"), "token");
        assert_eq!(decrypt_with(&none, "token"), "token");
        assert_eq!(store_secret_with(&none, "token", true), "token");
    }

    #[test]
    fn store_secret_은_secret_만_암호화() {
        assert!(is_encrypted(&store_secret_with(&k(KEY), "token", true)));
        assert_eq!(store_secret_with(&k(KEY), "https://api", false), "https://api");
    }

    fn stored_under_old_key(plain: &str) -> String {
        encrypt_with(&k(OLD), plain)
    }

    #[test]
    fn 옛_키를_안_알려주면_값을_잃는다() {
        let _q = quiet();
        let stored = stored_under_old_key("live-api-key");
        assert_eq!(decrypt_with(&k(NEW), &stored), "");
        assert_eq!(key_state_with(&k(NEW), &stored), KeyState::Broken);
    }

    #[test]
    fn 옛_키를_주면_그대로_읽힌다() {
        let _q = quiet();
        let stored = stored_under_old_key("live-api-key");
        let keys = Keys::new(Some(NEW), &[OLD]);
        assert_eq!(decrypt_with(&keys, &stored), "live-api-key");
        assert_eq!(key_state_with(&keys, &stored), KeyState::Old);
    }

    #[test]
    fn 옛_키가_여러_개여도_맞는_것을_찾는다() {
        let _q = quiet();
        let stored = stored_under_old_key("live-api-key");
        // 환경 변수 형식 그대로(앞뒤 공백·쉼표) — from_env 의 나누기 규칙을 같이 본다.
        let raw = format!("틀린키1, {OLD} ,틀린키2");
        let old: Vec<Key> = raw.split(',').map(crate::js::trim).filter(|s| !s.is_empty()).map(derive_key).collect();
        let keys = Keys { current: Some(derive_key(NEW)), old };
        assert_eq!(decrypt_with(&keys, &stored), "live-api-key");
    }

    #[test]
    fn 새_값은_언제나_현재_키로_쓴다() {
        let keys = Keys::new(Some(NEW), &[OLD]);
        let fresh = encrypt_with(&keys, "갓 저장한 값");
        assert_eq!(key_state_with(&keys, &fresh), KeyState::Current);
    }

    #[test]
    fn 옮기면_옛_키_없이도_읽힌다() {
        let _q = quiet();
        let stored = stored_under_old_key("live-api-key");
        let keys = Keys::new(Some(NEW), &[OLD]);
        let moved = rewrap_with(&keys, &stored).expect("옮겨져야 한다");
        assert_ne!(moved, stored);
        assert_eq!(key_state_with(&keys, &moved), KeyState::Current);
        assert_eq!(decrypt_with(&k(NEW), &moved), "live-api-key");
    }

    #[test]
    fn 옮길_것이_없으면_none() {
        let keys = k(NEW);
        assert_eq!(rewrap_with(&keys, &encrypt_with(&keys, "현재 키 값")), None);
        assert_eq!(rewrap_with(&keys, "레거시 평문"), None);
        assert_eq!(rewrap_with(&keys, "enc:v1:못푸는값"), None);
    }

    #[test]
    fn 상태를_묻는_것만으로는_실패_수가_늘지_않는다() {
        let _q = quiet();
        let before = decrypt_failure_count();
        assert_eq!(key_state_with(&k(NEW), "enc:v1:못푸는값"), KeyState::Broken);
        assert_eq!(decrypt_failure_count(), before);
    }

    #[test]
    fn 옛_키로_읽은_것은_실패가_아니라_따로_센다() {
        let _q = quiet();
        let stored = stored_under_old_key("live-api-key");
        let keys = Keys::new(Some(NEW), &[OLD]);
        let (failed, stale) = (decrypt_failure_count(), old_key_read_count());
        decrypt_with(&keys, &stored);
        assert_eq!(decrypt_failure_count(), failed);
        assert!(old_key_read_count() > stale);
    }

    #[test]
    fn 실패_수를_세어_알린다() {
        let _q = quiet();
        let before = decrypt_failure_count();
        decrypt_with(&k(KEY), "enc:v1:이건풀수없는값입니다");
        assert!(decrypt_failure_count() > before);
    }

    #[test]
    fn 암호문이_아니면_세지_않는다() {
        let _q = quiet();
        let before = decrypt_failure_count();
        assert_eq!(decrypt_with(&k(KEY), "그냥 평문"), "그냥 평문");
        assert_eq!(decrypt_failure_count(), before);
    }

    #[test]
    fn base64_는_node_처럼_너그럽게_읽는다() {
        // 줄바꿈이 끼거나 url-safe 로 바뀐 암호문도 Node 는 풀었다.
        let wrapped = format!("{}\n{}", &NODE_VECTOR[..40], &NODE_VECTOR[40..]);
        assert_eq!(decrypt_with(&k(KEY), &wrapped), "super-secret-token 한글 🔑");
        let urlsafe = NODE_VECTOR.replace('+', "-").replace('/', "_");
        assert_eq!(decrypt_with(&k(KEY), &urlsafe), "super-secret-token 한글 🔑");
    }

    // ── AuthConfig ──

    #[test]
    fn auth_config_는_secret_필드만_암호화한다() {
        let keys = k(KEY);
        let enc = encrypt_auth_config_with(&keys, &json!({ "type": "bearer", "token": "t0k", "prefix": "Bearer" })).unwrap();
        assert!(is_encrypted(enc["token"].as_str().unwrap()));
        assert_eq!(enc["prefix"], "Bearer");
        // 키 순서는 그대로(저장 JSON 이 Node 와 같아야 한다)
        assert_eq!(enc.as_object().unwrap().keys().collect::<Vec<_>>(), ["type", "token", "prefix"]);
        assert_eq!(decrypt_auth_config_with(&keys, &enc), json!({ "type": "bearer", "token": "t0k", "prefix": "Bearer" }));
        for (ty, field) in [("basic", "password"), ("apikey", "value"), ("oauth2cc", "clientSecret")] {
            let e = encrypt_auth_config_with(&keys, &json!({ "type": ty, field: "s3cret" })).unwrap();
            assert_eq!(decrypt_with(&keys, e[field].as_str().unwrap()), "s3cret");
        }
    }

    #[test]
    fn auth_config_가장자리() {
        let keys = k(KEY);
        assert_eq!(encrypt_auth_config_with(&keys, &json!(null)).unwrap(), json!({ "type": "none" }));
        assert_eq!(encrypt_auth_config_with(&keys, &json!({ "type": 1 })).unwrap(), json!({ "type": "none" }));
        assert_eq!(encrypt_auth_config_with(&keys, &json!({ "type": "none", "x": 1 })).unwrap(), json!({ "type": "none", "x": 1 }));
        // 필드가 없으면 '' 로 채워진다(`auth.token ?? ''`) — 빈 값은 암호화하지 않는다.
        assert_eq!(encrypt_auth_config_with(&keys, &json!({ "type": "bearer" })).unwrap(), json!({ "type": "bearer", "token": "" }));
        // 문자열이 아닌 값: 키가 있으면 Node 는 TypeError, 없으면 그대로.
        assert!(encrypt_auth_config_with(&keys, &json!({ "type": "bearer", "token": 5 })).is_err());
        assert_eq!(encrypt_auth_config_with(&Keys::default(), &json!({ "type": "bearer", "token": 5 })).unwrap(), json!({ "type": "bearer", "token": 5 }));
    }
}

//! Translate user-facing API errors when the UI sends Accept-Language.
//! Internal logs and errors sent without a language preference keep their original wording.

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;

include!("error_i18n_auto.rs");

const ERRORS: &[(&str, &str)] = &[
    ("본문이 올바른 JSON 이 아닙니다", "Invalid JSON body"),
    ("name 은 비어 있지 않은 문자열이어야 합니다", "Name must be a nonempty string"),
    ("URL 이 올바르지 않습니다", "Invalid URL"),
    ("차단된 주소입니다(메타데이터/사설망)", "This address is blocked (metadata or private network)"),
    ("리다이렉트되었습니다(보안상 차단)", "Redirect blocked for security"),
    ("폴더가 없습니다 — 다른 사람이 지웠을 수 있습니다", "Folder not found. Someone may have deleted it."),
    ("폴더를 찾을 수 없습니다", "Folder not found"),
    ("요청이 없습니다", "Request not found"),
    ("요청이 삭제되었습니다", "Request was deleted"),
    ("저장본이 없습니다", "Saved version not found"),
    ("저장본을 읽지 못했습니다. 암호화 키를 확인하세요.", "Could not read the saved version. Check the encryption key."),
    ("저장본과 현재 수정 시각이 필요합니다", "Saved version and current modification time are required"),
    ("다른 사람이 수정했습니다. 다시 열어 확인하세요.", "Someone else changed this item. Reopen it and review their changes."),
    ("저장본을 복호화하지 못했습니다", "Could not decrypt the saved version"),
    ("복원한 요청을 다시 읽지 못했습니다", "Could not read the restored request"),
    ("본문이 너무 큽니다", "Body is too large"),
    ("응답 상태 코드가 없습니다", "Response status code is missing"),
    ("실제 응답 상태 코드가 필요합니다", "Actual response status code is required"),
    ("연결된 OpenAPI 정의가 없습니다", "No OpenAPI definition is connected"),
    ("OpenAPI에서 이 요청을 찾지 못했습니다. 스펙 동기화를 확인하세요", "Request not found in OpenAPI. Check spec synchronization."),
    ("응답 바디 없음", "No response body"),
    ("응답이 JSON 이 아닙니다", "Response is not JSON"),
    ("읽기 전용 환경에서 쓰기 요청이 차단되었습니다.", "Write requests are blocked in a read-only environment."),
    ("실행 입력으로 URL 호스트·프로토콜·포트·자격증명을 변경할 수 없습니다. 저장된 환경을 선택하세요.", "Execution inputs cannot change the URL host, protocol, port, or credentials. Choose a saved environment."),
    ("OAuth2: 토큰 URL 과 Client ID 가 필요합니다", "OAuth2 requires a token URL and client ID"),
    ("요청 실행 중 서버 오류", "Server error while sending request"),
    ("미리보기 중 서버 오류", "Server error while preparing preview"),
    ("스키마 조회 중 서버 오류", "Server error while loading schema"),
    ("시나리오 실행 중 서버 오류", "Server error while running scenario"),
    ("폴더 실행 중 서버 오류", "Server error while running folder"),
    ("서버 오류", "Server error"),
    ("가져오기 실패 — 아무것도 저장하지 않았습니다", "Import failed. Nothing was saved."),
    ("기본 프로젝트는 삭제할 수 없습니다", "The default project cannot be deleted"),
];

fn english(message: &str) -> Option<String> {
    for &(ko, en) in ERRORS.iter().chain(AUTO_ERRORS) {
        if message == ko { return Some(en.to_owned()); }
        if let Some(detail) = message.strip_prefix(ko).and_then(|rest| rest.strip_prefix(": ")) {
            return Some(format!("{en}: {detail}"));
        }
    }
    for &(ko, en) in AUTO_ERRORS {
        if let Some(result) = template_match(ko, en, message) { return Some(result); }
    }
    None
}

fn korean(message: &str) -> Option<String> {
    for &(ko, en) in ERRORS.iter().chain(AUTO_ERRORS) {
        if message == en { return Some(ko.to_owned()); }
        if let Some(detail) = message.strip_prefix(en).and_then(|rest| rest.strip_prefix(": ")) {
            return Some(format!("{ko}: {detail}"));
        }
    }
    for &(ko, en) in AUTO_ERRORS {
        if let Some(result) = template_match(en, ko, message) { return Some(result); }
    }
    None
}

fn template_match(source: &str, target: &str, message: &str) -> Option<String> {
    if !source.contains('{') { return None; }
    let mut regex = String::from("^");
    let mut names = Vec::new();
    let mut cursor = 0;
    while let Some(open) = source[cursor..].find('{').map(|offset| cursor + offset) {
        let close = source[open..].find('}').map(|offset| open + offset)?;
        regex.push_str(&regex::escape(&source[cursor..open]));
        regex.push_str("(.+?)");
        names.push(source[open + 1..close].to_owned());
        cursor = close + 1;
    }
    if names.is_empty() { return None; }
    regex.push_str(&regex::escape(&source[cursor..]));
    regex.push('$');
    let captures = regex::Regex::new(&regex).ok()?.captures(message)?;
    let mut translated = target.to_owned();
    for (index, name) in names.iter().enumerate() {
        let value = captures.get(index + 1)?.as_str();
        let placeholder = format!("{{{name}}}");
        translated = translated.replacen(&placeholder, value, 1);
    }
    Some(translated)
}

pub async fn translate_response(req: Request<Body>, next: Next) -> Response {
    let language = req.headers().get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .and_then(|value| if value.starts_with("en") { Some("en") } else if value.starts_with("ko") { Some("ko") } else { None });
    let response = next.run(req).await;
    if language.is_none() || response.status() < StatusCode::BAD_REQUEST ||
        !response.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).is_some_and(|value| value.starts_with("application/json")) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = match to_bytes(body, 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return Response::from_parts(parts, Body::empty()),
    };
    let Ok(mut json) = serde_json::from_slice::<Value>(&bytes) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let Some(message) = json.get("error").and_then(Value::as_str) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let Some(translated) = (if language == Some("en") { english(message) } else { korean(message) }) else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    json["error"] = Value::String(translated);
    parts.headers.remove(header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(serde_json::to_vec(&json).expect("JSON serialization")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use tower::ServiceExt;

    #[test]
    fn translates_exact_and_prefixed_errors() {
        assert_eq!(english("본문이 올바른 JSON 이 아닙니다"), Some("Invalid JSON body".into()));
        assert_eq!(english("서버 오류: disk full"), Some("Server error: disk full".into()));
        assert_eq!(english("a log message"), None);
        assert_eq!(english("업스트림 503"), Some("upstream 503".into()));
        assert_eq!(korean("Folder not found"), Some("폴더를 찾을 수 없습니다".into()));
    }

    #[tokio::test]
    async fn accept_language_selects_error_response_without_changing_default() {
        let app = Router::new()
            .route("/api/error", get(|| async { crate::error::ApiError::bad_request("본문이 올바른 JSON 이 아닙니다") }))
            .layer(axum::middleware::from_fn(translate_response));
        for (language, expected) in [
            (Some("en-US,en;q=0.9"), "Invalid JSON body"),
            (Some("ko-KR"), "본문이 올바른 JSON 이 아닙니다"),
            (None, "본문이 올바른 JSON 이 아닙니다"),
        ] {
            let mut request = Request::get("/api/error").body(Body::empty()).unwrap();
            if let Some(language) = language { request.headers_mut().insert(header::ACCEPT_LANGUAGE, language.parse().unwrap()); }
            let response = app.clone().oneshot(request).await.unwrap();
            let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["error"], expected);
        }
    }
}

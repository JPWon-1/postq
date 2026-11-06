//! Postman 컬렉션·환경 → postq 요청 초안.
//!
//! 입력은 사람이 내보낸 파일이라 모양을 믿을 수 없다. Node 는 TypeScript 형식만 믿고 그대로 읽었기 때문에
//! 이상한 파일은 TypeError 로 실패했고(가져오기 500, 아무것도 저장 안 됨), 어떤 값은 형식 그대로
//! 저장됐다(숫자 토큰 등). 같은 파일이 서버에 따라 다르게 들어가면 안 되므로 그 느슨함까지 따른다 —
//! 실패해야 할 자리는 Err 로, 통과하던 값은 그대로.

use serde_json::{json, Value};

use crate::js;
use crate::jsval::{get, get_strict, nullish, string_of};

pub struct Draft {
    pub name: String,
    pub method: String,
    pub url: String,
    pub params: Vec<Value>,
    pub headers: Vec<Value>,
    pub body_type: &'static str,
    /// 보통 문자열이지만 raw 본문이 문자열이 아니면 그 값 그대로다.
    pub body: Value,
    pub description: String,
    pub auth: Option<Value>,
    pub had_auth: bool,
    pub file_fields: usize,
    pub had_script: bool,
}

pub struct Collection {
    pub name: String,
    pub drafts: Vec<Draft>,
    pub summary: Value,
}

/// Postman 은 쿼리 key/value 를 이미 디코딩해 두지만 raw url 은 인코딩된 채다. 한 번만 디코딩해
/// 실행 때 이중 인코딩을 막는다. 깨진 %열은 원문 유지. 인자는 String(v) 로 바뀐다(decodeURIComponent 처럼).
fn safe_decode(v: &Value) -> String {
    let s = js::to_string(v);
    js::decode_uri_component(&s).unwrap_or(s)
}

fn not_iterable(what: &str) -> String {
    format!("{what} is not iterable")
}

/// `arr.find(x => x?.key === k)?.value ?? ''` — 값은 문자열이 아니어도 그대로 돌려준다.
fn pick(arr: Option<&Value>, k: &str) -> Value {
    let found = arr.and_then(Value::as_array).and_then(|a| a.iter().find(|x| get(Some(x), "key").and_then(Value::as_str) == Some(k)));
    match get(found, "value") {
        None | Some(Value::Null) => json!(""),
        Some(v) => v.clone(),
    }
}

/// Postman auth → 구조화 인증. 평문 헤더로 바꾸지 않는다(그래야 마스킹·at-rest 암호화가 적용된다).
fn auth_to_config(auth: Option<&Value>) -> Option<Value> {
    // `!auth || typeof auth !== 'object'` — 배열도 객체라 들어오지만 type 이 없어 null.
    let auth = auth.filter(|a| a.is_object() || a.is_array())?;
    match get(Some(auth), "type").and_then(Value::as_str) {
        Some("bearer") => {
            let t = pick(get(Some(auth), "bearer"), "token");
            js::truthy(Some(&t)).then(|| json!({ "type": "bearer", "token": t }))
        }
        Some("basic") => {
            let b = get(Some(auth), "basic");
            Some(json!({ "type": "basic", "username": pick(b, "username"), "password": pick(b, "password") }))
        }
        Some("apikey") => {
            let a = get(Some(auth), "apikey");
            let (k, v) = (pick(a, "key"), pick(a, "value"));
            let w = pick(a, "in");
            let where_ = if js::truthy(Some(&w)) { w } else { json!("header") };
            js::truthy(Some(&k)).then(|| json!({ "type": "apikey", "key": k, "value": v, "in": if where_ == "query" { "query" } else { "header" } }))
        }
        _ => None,
    }
}

/// `arr.join('\n')` — null·undefined 요소는 빈 칸.
fn join(a: &[Value], sep: &str) -> String {
    a.iter().map(|x| if x.is_null() { String::new() } else { js::to_string(x) }).collect::<Vec<_>>().join(sep)
}

/// pre-request/test 스크립트 원문을 사람이 읽을 텍스트로(실행하지 않는다 — 설명에 보존).
fn scripts_text(events: Option<&Value>) -> Result<String, String> {
    let mut parts = vec![];
    for e in events.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let lines = get(get(Some(e), "script"), "exec");
        let Some(lines) = lines.and_then(Value::as_array) else { continue };
        // lines.some(l => l.trim()) — 문자열이 아닌 요소를 만나면(그 앞에 참이 없을 때) TypeError.
        let mut any = false;
        for l in lines {
            match l {
                Value::String(s) if !js::trim(s).is_empty() => {
                    any = true;
                    break;
                }
                Value::String(_) => {}
                _ => return Err("l.trim is not a function".into()),
            }
        }
        if any {
            let listen = get(Some(e), "listen");
            let label = match listen.and_then(Value::as_str) {
                Some("prerequest") => "pre-request".to_string(),
                Some("test") => "test".to_string(),
                _ => string_of(listen),
            };
            parts.push(format!("[{label} script]\n{}", join(lines, "\n")));
        }
    }
    Ok(parts.join("\n\n"))
}

/// `for (const item of items ?? [])` 의 대상. 문자열은 글자마다 돌지만 글자에는 request 가 없어 아무것도 안 나온다.
fn iter_items<'a>(items: Option<&'a Value>, what: &str) -> Result<&'a [Value], String> {
    match items {
        None | Some(Value::Null) | Some(Value::String(_)) => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        Some(_) => Err(not_iterable(what)),
    }
}

fn walk_items(items: Option<&Value>, prefix: &str, out: &mut Vec<Draft>) -> Result<(), String> {
    for item in iter_items(items, "items")? {
        let item_name = get_strict(Some(item), "name")?;
        let name = if prefix.is_empty() {
            if nullish(item_name) { String::new() } else { string_of(item_name) }
        } else {
            format!("{prefix} / {}", string_of(item_name))
        };
        if let Some(children) = get(Some(item), "item").filter(|c| js::truthy(Some(c))) {
            walk_items(Some(children), &name, out)?;
            continue;
        }
        let Some(r) = get(Some(item), "request").filter(|r| js::truthy(Some(r))) else { continue };

        let r_url = get(Some(r), "url");
        let raw_url: String = match r_url {
            Some(Value::String(s)) => s.clone(),
            _ => match get(r_url, "raw") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(_) => return Err("rawUrl.split is not a function".into()),
            },
        };
        let mut pieces = raw_url.split('?');
        let url = pieces.next().unwrap_or("").to_string();
        let query_string = pieces.collect::<Vec<_>>().join("?");
        // typeof r.url === 'object' — null 도 object 지만 ?. 로 undefined 가 된다.
        let query_arr = if r_url.map_or(false, |u| u.is_object() || u.is_array() || u.is_null()) { get(r_url, "query") } else { None };
        let params: Vec<Value> = if js::truthy(query_arr) {
            let Some(qs) = query_arr.and_then(Value::as_array) else { return Err("queryArr.map is not a function".into()) };
            let mut ps = vec![];
            for q in qs {
                let key = get_strict(Some(q), "key")?;
                let value = get(Some(q), "value");
                let empty = json!("");
                ps.push(json!({
                    "key": safe_decode(if nullish(key) { &empty } else { key.unwrap() }),
                    "value": safe_decode(if nullish(value) { &empty } else { value.unwrap() }),
                    "enabled": get(Some(q), "disabled") != Some(&Value::Bool(true)),
                }));
            }
            ps
        } else if !query_string.is_empty() {
            query_string
                .split('&')
                .filter(|p| !p.is_empty())
                .map(|pair| {
                    let mut kv = pair.split('=');
                    let k = kv.next().unwrap_or("");
                    let rest = kv.collect::<Vec<_>>().join("=");
                    json!({ "key": safe_decode(&json!(k)), "value": safe_decode(&json!(rest)), "enabled": true })
                })
                .collect()
        } else {
            vec![]
        };
        // (r.header ?? []).map(...) — 배열이 아니면 TypeError. key/value 는 형식 그대로(?? '' 만).
        let headers: Vec<Value> = match get(Some(r), "header") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(hs)) => {
                let mut out = vec![];
                for h in hs {
                    let key = get_strict(Some(h), "key")?;
                    let value = get(Some(h), "value");
                    out.push(json!({
                        "key": if nullish(key) { json!("") } else { key.unwrap().clone() },
                        "value": if nullish(value) { json!("") } else { value.unwrap().clone() },
                        "enabled": get(Some(h), "disabled") != Some(&Value::Bool(true)),
                    }));
                }
                out
            }
            Some(_) => return Err("(r.header ?? []).map is not a function".into()),
        };

        let mut notes: Vec<String> = vec![];
        let draft_auth = auth_to_config(get(Some(r), "auth"));
        let had_auth = draft_auth.is_some();

        let mut body_type = "none";
        let mut body = json!("");
        let mut file_fields = 0;
        let rb = get(Some(r), "body");
        let mode = get(rb, "mode").and_then(Value::as_str);
        if mode == Some("raw") && js::truthy(get(rb, "raw")) {
            body = get(rb, "raw").cloned().unwrap_or(Value::Null);
            body_type = if get(get(get(rb, "options"), "raw"), "language").and_then(Value::as_str) == Some("json") { "json" } else { "raw" };
        } else if let (Some("urlencoded"), Some(fields)) = (mode, get(rb, "urlencoded").and_then(Value::as_array)) {
            let mut kept = vec![];
            for f in fields {
                if get_strict(Some(f), "disabled")? != Some(&Value::Bool(true)) {
                    kept.push(f);
                }
            }
            let enc = |v: Option<&Value>| js::encode_uri_component(&if nullish(v) { String::new() } else { js::to_string(v.unwrap()) });
            body = json!(kept.iter().map(|f| format!("{}={}", enc(get(Some(f), "key")), enc(get(Some(f), "value")))).collect::<Vec<_>>().join("&"));
            body_type = "form";
        } else if mode == Some("file") {
            let filename = get(get(rb, "file"), "src").and_then(Value::as_str).unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("");
            body_type = "binary";
            body = json!(js::stringify(&json!({ "filename": filename, "contentType": "application/octet-stream", "dataBase64": null })));
            file_fields = 1;
            notes.push("바이너리 파일 — 실행 전에 파일을 다시 첨부하세요(컬렉션엔 내용 미포함)".into());
        } else if let (Some("formdata"), Some(fd)) = (mode, get(rb, "formdata").and_then(Value::as_array)) {
            let mut fields = vec![];
            for f in fd {
                if get_strict(Some(f), "disabled")? != Some(&Value::Bool(true)) && get(Some(f), "type") != Some(&json!("file")) {
                    let (k, v) = (get(Some(f), "key"), get(Some(f), "value"));
                    fields.push(json!({
                        "name": if nullish(k) { json!("") } else { k.unwrap().clone() },
                        "value": if nullish(v) { json!("") } else { v.unwrap().clone() },
                    }));
                }
            }
            file_fields = fd.iter().filter(|f| get(Some(f), "type") == Some(&json!("file"))).count();
            body = json!(js::stringify(&json!({ "fields": fields, "files": [] })));
            body_type = "multipart";
            if file_fields > 0 {
                notes.push(format!("파일 필드 {file_fields}개 — 실행 시 파일을 다시 첨부해야 합니다(컬렉션엔 내용 미포함)"));
            }
        }

        let scripts = scripts_text(get(Some(item), "event"))?;
        let had_script = !scripts.is_empty();
        if had_script {
            notes.push("pre-request/test 스크립트는 자동 실행되지 않습니다 — 설명에 원문을 보존했으니 Steps 탭으로 옮겨주세요".into());
        }

        let mut desc_parts: Vec<String> = vec![];
        if let Some(d) = get(Some(r), "description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
            desc_parts.push(d.to_string());
        }
        if !notes.is_empty() {
            desc_parts.push(format!("⚠ 가져오기 안내:\n- {}", notes.join("\n- ")));
        }
        if had_script {
            desc_parts.push(format!("--- 원본 Postman 스크립트(참고용, 미실행) ---\n{scripts}"));
        }

        let method = get(Some(r), "method");
        out.push(Draft {
            name,
            method: if nullish(method) { "GET".into() } else { string_of(method) }.to_uppercase(),
            url,
            params,
            headers,
            body_type,
            body,
            description: desc_parts.join("\n\n"),
            auth: draft_auth,
            had_auth,
            file_fields,
            had_script,
        });
    }
    Ok(())
}

pub fn collection_to_drafts(collection: &Value) -> Result<Collection, String> {
    let mut drafts = vec![];
    walk_items(get(Some(collection), "item"), "", &mut drafts)?;
    let summary = json!({
        "total": drafts.len(),
        "withAuth": drafts.iter().filter(|d| d.had_auth).count(),
        "withScript": drafts.iter().filter(|d| d.had_script).count(),
        "withFileField": drafts.iter().filter(|d| d.file_fields > 0).count(),
    });
    let name = get(get(Some(collection), "info"), "name");
    Ok(Collection { name: if nullish(name) { "Imported".into() } else { string_of(name) }, drafts, summary })
}

pub struct EnvVar {
    pub key: String,
    pub value: String,
    pub secret: bool,
}

pub fn environment_to_vars(env: &Value) -> Result<(String, Vec<EnvVar>), String> {
    // (e?.values ?? []).filter(...) — 배열이 아니면 TypeError.
    let values: &[Value] = match get(Some(env), "values") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(a)) => a,
        Some(_) => return Err("(e?.values ?? []).filter is not a function".into()),
    };
    let mut vars = vec![];
    for v in values {
        if get_strict(Some(v), "enabled")? == Some(&Value::Bool(false)) {
            continue;
        }
        let value = get(Some(v), "value");
        vars.push(EnvVar {
            key: string_of(get(Some(v), "key")),
            value: if nullish(value) { String::new() } else { string_of(value) },
            secret: get(Some(v), "type") == Some(&json!("secret")),
        });
    }
    let name = get(Some(env), "name");
    Ok((if nullish(name) { "Imported env".into() } else { string_of(name) }, vars))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({
          "info": { "name": "Sample APIs" },
          "item": [
            { "name": "주문", "item": [{
                "name": "생성",
                "request": {
                  "method": "POST",
                  "url": { "raw": "{{baseUrl}}/orders?dry=true", "query": [{ "key": "dry", "value": "true" }] },
                  "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }],
                  "body": { "mode": "raw", "raw": "{\"memberCode\":\"M1\"}", "options": { "raw": { "language": "json" } } },
                },
                "event": [{ "listen": "test", "script": { "exec": ["pm.test(...)"] } }],
            }] },
            { "name": "루트요청", "request": { "method": "GET", "url": { "raw": "{{baseUrl}}/ping" } } },
          ],
        })
    }

    #[test]
    fn 컬렉션_계층_평탄화_스크립트는_설명에_보존() {
        let c = collection_to_drafts(&sample()).unwrap();
        assert_eq!(c.name, "Sample APIs");
        assert_eq!(c.drafts.len(), 2);
        let d = &c.drafts[0];
        assert_eq!(d.name, "주문 / 생성");
        assert_eq!(d.method, "POST");
        assert_eq!(d.url, "{{baseUrl}}/orders");
        assert_eq!(d.params, vec![json!({ "key": "dry", "value": "true", "enabled": true })]);
        assert_eq!(d.headers[0], json!({ "key": "Authorization", "value": "Bearer {{token}}", "enabled": true }));
        assert_eq!(d.body_type, "json");
        assert!(d.had_script);
        assert!(d.description.contains("pm.test(...)"));
        assert_eq!(c.summary["withScript"], 1);
        assert_eq!(c.drafts[1].name, "루트요청");
    }

    #[test]
    fn auth_매핑() {
        let c = json!({ "info": { "name": "A" }, "item": [
            { "name": "b", "request": { "method": "GET", "url": "/x", "auth": { "type": "bearer", "bearer": [{ "key": "token", "value": "T" }] } } },
            { "name": "ba", "request": { "method": "GET", "url": "/x", "auth": { "type": "basic", "basic": [{ "key": "username", "value": "u" }, { "key": "password", "value": "p" }] } } },
            { "name": "ak", "request": { "method": "GET", "url": "/x", "auth": { "type": "apikey", "apikey": [{ "key": "key", "value": "X-Api-Key" }, { "key": "value", "value": "K" }, { "key": "in", "value": "header" }] } } },
            { "name": "aq", "request": { "method": "GET", "url": "/x", "auth": { "type": "apikey", "apikey": [{ "key": "key", "value": "api_key" }, { "key": "value", "value": "K" }, { "key": "in", "value": "query" }] } } },
        ] });
        let c = collection_to_drafts(&c).unwrap();
        assert_eq!(c.drafts[0].auth, Some(json!({ "type": "bearer", "token": "T" })));
        assert_eq!(c.drafts[1].auth, Some(json!({ "type": "basic", "username": "u", "password": "p" })));
        assert_eq!(c.drafts[2].auth, Some(json!({ "type": "apikey", "key": "X-Api-Key", "value": "K", "in": "header" })));
        assert_eq!(c.drafts[3].auth, Some(json!({ "type": "apikey", "key": "api_key", "value": "K", "in": "query" })));
        assert!(c.drafts[0].headers.is_empty());
        assert_eq!(c.summary["withAuth"], 4);
    }

    #[test]
    fn formdata_는_multipart_파일은_재첨부_안내() {
        let c = json!({ "info": { "name": "F" }, "item": [{ "name": "up", "request": { "method": "POST", "url": "/u", "body": { "mode": "formdata", "formdata": [
            { "key": "title", "value": "hi", "type": "text" }, { "key": "file", "type": "file", "src": "/local/a.png" },
        ] } } }] });
        let c = collection_to_drafts(&c).unwrap();
        let d = &c.drafts[0];
        assert_eq!(d.body_type, "multipart");
        assert_eq!(d.body, json!(r#"{"fields":[{"name":"title","value":"hi"}],"files":[]}"#));
        assert_eq!(d.file_fields, 1);
        assert!(d.description.contains("파일 필드 1개"));
        assert_eq!(c.summary["withFileField"], 1);
    }

    #[test]
    fn 환경_변수와_secret_타입() {
        let (name, vars) = environment_to_vars(&json!({ "name": "stage", "values": [
            { "key": "token", "value": "REAL", "type": "secret", "enabled": true },
            { "key": "baseUrl", "value": "https://stage", "type": "default", "enabled": true },
            { "key": "off", "value": "x", "enabled": false },
        ] }))
        .unwrap();
        assert_eq!(name, "stage");
        assert_eq!(vars.len(), 2);
        assert!(vars[0].secret && vars[0].value == "REAL");
        assert!(!vars[1].secret && vars[1].key == "baseUrl");
    }

    #[test]
    fn 문자열_url_쿼리_분리와_1회_디코딩() {
        let one = |u: &str| collection_to_drafts(&json!({ "info": { "name": "S" }, "item": [{ "name": "q", "request": { "method": "GET", "url": u } }] })).unwrap().drafts.remove(0);
        let d = one("{{baseUrl}}/x?a=1&b=2");
        assert_eq!(d.url, "{{baseUrl}}/x");
        assert_eq!(d.params, vec![json!({ "key": "a", "value": "1", "enabled": true }), json!({ "key": "b", "value": "2", "enabled": true })]);
        assert_eq!(one("{{baseUrl}}/search?q=%EC%A3%BC%EB%AC%B8").params, vec![json!({ "key": "q", "value": "주문", "enabled": true })]);
        assert_eq!(one("{{baseUrl}}/x?a=100%").params, vec![json!({ "key": "a", "value": "100%", "enabled": true })]);
    }

    #[test]
    fn urlencoded_바디는_form_문자열() {
        let c = json!({ "info": { "name": "S" }, "item": [{ "name": "p", "request": { "method": "POST", "url": "{{baseUrl}}/login", "body": { "mode": "urlencoded", "urlencoded": [
            { "key": "a", "value": "1" }, { "key": "b", "value": "2" }, { "key": "dead", "value": "x", "disabled": true },
        ] } } }] });
        let d = collection_to_drafts(&c).unwrap().drafts.remove(0);
        assert_eq!(d.body_type, "form");
        assert_eq!(d.body, json!("a=1&b=2"));
    }

    #[test]
    fn 이상한_모양은_node_처럼_실패하거나_무시한다() {
        assert!(collection_to_drafts(&json!({ "item": [null] })).is_err());
        assert!(collection_to_drafts(&json!({ "item": { "a": 1 } })).is_err());
        assert_eq!(collection_to_drafts(&json!({ "item": "abc" })).unwrap().drafts.len(), 0);
        assert_eq!(collection_to_drafts(&json!(5)).unwrap().name, "Imported");
        assert!(environment_to_vars(&json!({ "values": "x" })).is_err());
        assert_eq!(environment_to_vars(&json!({ "values": [{ "value": 1 }] })).unwrap().1[0].key, "undefined");
    }
}

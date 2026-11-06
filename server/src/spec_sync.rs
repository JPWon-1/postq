//! 스펙 동기화 계획.
//!
//! 순수 함수다(DB·네트워크 없음). 기존 요청(parseRequestRow 를 거친 행)과 새 초안([`crate::openapi`])을
//! 받아 무엇을 넣고·고치고·폐기할지 정한다. 실제 쓰기는 /api/folders/{id}/sync 라우트가 한 트랜잭션으로 한다.

use serde_json::{json, Map, Value};

use crate::api_contract::diff_contract;
use crate::js;

const NONE: &str = "(없음)";

/// kv.map(x => x.key).filter(Boolean)
fn keys(kv: Option<&Value>) -> Vec<Value> {
    kv.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("key")).filter(|k| js::truthy(Some(k))).cloned().collect())
        .unwrap_or_default()
}

fn join(v: &[Value]) -> String {
    v.iter().map(js::to_string).collect::<Vec<_>>().join(", ")
}

/// `(a ?? '').trim()`
fn trimmed(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => js::trim(s).to_string(),
        Some(other) => js::trim(&js::to_string(other)).to_string(),
    }
}

fn change(label: impl Into<String>, from: impl Into<String>, to: impl Into<String>) -> Value {
    json!({ "label": label.into(), "from": from.into(), "to": to.into() })
}

/// 스펙 변경의 이전 → 이후. 이력에 'CHANGED' 만 남으면 무엇이 바뀌었는지 스펙을 열어 대조해야 한다.
pub fn diff_spec_change(prev: &Value, next: &Value) -> Vec<Value> {
    let mut out = vec![];
    for (label, k) in [("이름", "name"), ("메서드", "method"), ("주소", "url"), ("설명", "description")] {
        let (from, to) = (trimmed(prev.get(k)), trimmed(next.get(k)));
        if from != to {
            out.push(change(label, if from.is_empty() { NONE.into() } else { from }, if to.is_empty() { NONE.into() } else { to }));
        }
    }
    // 파라미터·헤더는 이름 목록의 들고 남으로 본다. 값은 사용자가 채우는 것이라 스펙 변경이 아니다.
    for (label, k) in [("파라미터", "params"), ("헤더", "headers")] {
        let (before, after) = (keys(prev.get(k)), keys(next.get(k)));
        let added: Vec<Value> = after.iter().filter(|x| !before.contains(x)).cloned().collect();
        let removed: Vec<Value> = before.iter().filter(|x| !after.contains(x)).cloned().collect();
        if !added.is_empty() {
            out.push(change(format!("{label} 추가"), NONE, join(&added)));
        }
        if !removed.is_empty() {
            out.push(change(format!("{label} 삭제"), join(&removed), NONE));
        }
    }
    // 바디는 통째로 붙이면 이력이 읽히지 않는다 — 바뀌었다는 사실만 적는다.
    let (pb, nb) = (trimmed(prev.get("body")), trimmed(next.get("body")));
    if pb != nb {
        out.push(change("요청 바디 예시", if pb.is_empty() { NONE } else { "있음" }, if nb.is_empty() { NONE } else { "있음(내용 바뀜)" }));
    }
    out.extend(diff_contract(prev.get("specContract"), next.get("specContract")));
    out
}

pub struct Update {
    pub id: Value,
    pub draft: Value,
    pub merged_params: Vec<Value>,
    pub merged_headers: Vec<Value>,
    pub changes: Vec<Value>,
}

#[derive(Default)]
pub struct SyncPlan {
    pub to_insert: Vec<Value>,
    pub to_update: Vec<Update>,
    pub to_deprecate: Vec<Value>,
    pub to_mark_synced: Vec<Value>,
}

/// 사용자가 채운 value/enabled 는 지키고, 스펙에서 온 description 은 최신으로 덮는다.
/// (기존 행을 통째로 재사용하면 스펙에 새로 생긴 설명이 영원히 반영되지 않는다)
fn merge_kv(next: &Value, prev: Option<&Value>) -> Value {
    let Some(prev) = prev else { return next.clone() };
    let mut m: Map<String, Value> = prev.as_object().cloned().unwrap_or_default();
    // next.description ?? prev.description — 스펙 쪽이 없으면 prev 의 것이 제자리에 남는다(둘 다 없으면 키도 없다).
    if let Some(d) = next.get("description").filter(|d| !d.is_null()) {
        m.insert("description".into(), d.clone());
    }
    Value::Object(m)
}

/// `new Map(list.map(x => [x.key, x]))` — 같은 키는 뒤의 것.
fn by_key(list: Option<&Value>) -> Vec<(Value, Value)> {
    let mut out: Vec<(Value, Value)> = vec![];
    for x in list.and_then(Value::as_array).into_iter().flatten() {
        let k = x.get("key").cloned().unwrap_or(Value::Null);
        match out.iter_mut().find(|(ok, _)| *ok == k) {
            Some(slot) => slot.1 = x.clone(),
            None => out.push((k, x.clone())),
        }
    }
    out
}

pub fn plan_sync(existing: &[Value], drafts: &[Value]) -> SyncPlan {
    let op_key = |e: &Value| e.get("specOperationKey").filter(|k| js::truthy(Some(k))).cloned();
    // 같은 operationKey 가 둘이면 뒤의 행(Map 생성자 규칙).
    let find_existing = |k: &Value| existing.iter().rev().find(|e| op_key(e).as_ref() == Some(k));
    let draft_keys: Vec<Value> = drafts.iter().map(|d| d.get("operationKey").cloned().unwrap_or(Value::Null)).collect();
    let mut plan = SyncPlan::default();

    for d in drafts {
        let dk = d.get("operationKey").cloned().unwrap_or(Value::Null);
        let Some(ex) = find_existing(&dk) else {
            plan.to_insert.push(d.clone());
            continue;
        };
        let same_fp = ex.get("specFingerprint").unwrap_or(&Value::Null) == d.get("fingerprint").unwrap_or(&Value::Null)
            && !(ex.get("specFingerprint").is_none() != d.get("fingerprint").is_none());
        if same_fp && diff_contract(ex.get("specContract"), d.get("specContract")).is_empty() {
            plan.to_mark_synced.push(ex["id"].clone());
            continue;
        }
        let prev_values = by_key(ex.get("params"));
        let prev_headers = by_key(ex.get("headers"));
        let lookup = |m: &[(Value, Value)], k: Option<&Value>| m.iter().find(|(x, _)| Some(x) == k).map(|(_, v)| v.clone());
        let merged = |list: Option<&Value>, prev: &[(Value, Value)]| -> Vec<Value> {
            list.and_then(Value::as_array).into_iter().flatten().map(|p| merge_kv(p, lookup(prev, p.get("key")).as_ref())).collect()
        };
        plan.to_update.push(Update {
            id: ex["id"].clone(),
            draft: d.clone(),
            changes: diff_spec_change(ex, d),
            merged_params: merged(d.get("params"), &prev_values),
            merged_headers: merged(d.get("headers"), &prev_headers),
        });
    }
    for e in existing {
        if let Some(k) = op_key(e) {
            if !draft_keys.contains(&k) {
                plan.to_deprecate.push(e["id"].clone());
            }
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(over: Value) -> Value {
        let mut d = json!({ "name": "n", "method": "GET", "url": "{{baseUrl}}/a", "params": [], "headers": [], "bodyType": "none", "body": "", "operationKey": "GET /a", "fingerprint": "fp1" });
        for (k, v) in over.as_object().unwrap() {
            d[k] = v.clone();
        }
        d
    }

    #[test]
    fn 신규_변경_삭제_동일_분류() {
        let existing = vec![
            json!({ "id": "same", "specOperationKey": "GET /a", "specFingerprint": "fp1", "params": [], "headers": [] }),
            json!({ "id": "chg", "specOperationKey": "GET /b", "specFingerprint": "OLD", "params": [], "headers": [] }),
            json!({ "id": "gone", "specOperationKey": "GET /c", "specFingerprint": "fp3", "params": [], "headers": [] }),
        ];
        let drafts = vec![
            draft(json!({ "operationKey": "GET /a", "fingerprint": "fp1" })),
            draft(json!({ "operationKey": "GET /b", "fingerprint": "fpNEW" })),
            draft(json!({ "operationKey": "GET /new", "fingerprint": "fpN" })),
        ];
        let plan = plan_sync(&existing, &drafts);
        assert_eq!(plan.to_mark_synced, vec![json!("same")]);
        assert_eq!(plan.to_update.iter().map(|u| u.id.clone()).collect::<Vec<_>>(), vec![json!("chg")]);
        assert_eq!(plan.to_deprecate, vec![json!("gone")]);
        assert_eq!(plan.to_insert[0]["operationKey"], "GET /new");
    }

    #[test]
    fn 변경_시_살아남은_값_보존_설명은_최신() {
        let existing = vec![json!({
            "id": "chg", "specOperationKey": "GET /b", "specFingerprint": "OLD",
            "params": [{ "key": "keep", "value": "사용자값", "enabled": true }, { "key": "dead", "value": "x", "enabled": true }],
            "headers": [{ "key": "Authorization", "value": "Bearer t", "enabled": true }],
        })];
        let drafts = vec![draft(json!({
            "operationKey": "GET /b", "fingerprint": "NEW",
            "params": [{ "key": "keep", "value": "", "enabled": true, "description": "필수 · 크기" }, { "key": "added", "value": "", "enabled": true }],
            "headers": [{ "key": "Authorization", "value": "", "enabled": true }, { "key": "X-Added", "value": "", "enabled": true }],
        }))];
        let plan = plan_sync(&existing, &drafts);
        let u = &plan.to_update[0];
        assert_eq!(u.merged_params, vec![
            json!({ "key": "keep", "value": "사용자값", "enabled": true, "description": "필수 · 크기" }),
            json!({ "key": "added", "value": "", "enabled": true }),
        ]);
        assert_eq!(u.merged_headers, vec![
            json!({ "key": "Authorization", "value": "Bearer t", "enabled": true }),
            json!({ "key": "X-Added", "value": "", "enabled": true }),
        ]);
        assert!(u.changes.iter().any(|c| c["label"] == "파라미터 삭제" && c["from"] == "dead"));
    }
}

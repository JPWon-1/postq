//! GraphQL introspection. 표준 쿼리로 스키마를 받아 타입→필드 탐색용으로 줄인다.
//!
//! 공개 API
//! - [`INTROSPECTION_QUERY`] — 대상 엔드포인트에 보내는 쿼리(바디는 resolve::gql_wrap 이 {query} 로 감싼다).
//! - [`type_ref_to_string`] — NON_NULL/LIST 래핑을 SDL 표기(String!, [User!]!)로.
//! - [`simplify_schema`] — `data.__schema`(또는 `__schema`) → `{ queryType, mutationType, types }`. 없으면 None.

use serde_json::{json, Value};

use crate::js;

pub const INTROSPECTION_QUERY: &str = "query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name
      fields { name type { ...TypeRef } args { name } }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}";

pub fn type_ref_to_string(t: Option<&Value>) -> String {
    let Some(t) = t.filter(|t| js::truthy(Some(t))) else { return String::new() };
    match t.get("kind").and_then(Value::as_str) {
        Some("NON_NULL") => format!("{}!", type_ref_to_string(t.get("ofType"))),
        Some("LIST") => format!("[{}]", type_ref_to_string(t.get("ofType"))),
        _ => match t.get("name") {
            None | Some(Value::Null) => String::new(),
            Some(n) => js::to_string(n),
        },
    }
}

/// `x?.name ?? null`
fn name_of(v: Option<&Value>) -> Value {
    match v.and_then(|v| v.get("name")) {
        None | Some(Value::Null) => Value::Null,
        Some(n) => n.clone(),
    }
}

fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// 내부 `__` 타입과 OBJECT/INTERFACE 가 아닌 것, fields 가 없는 것은 뺀다.
pub fn simplify_schema(introspection: &Value) -> Option<Value> {
    let schema = nn(introspection.get("data").and_then(|d| d.get("__schema"))).or_else(|| nn(introspection.get("__schema")))?;
    if !(schema.is_object() || schema.is_array()) {
        return None;
    }
    let types: Vec<Value> = schema
        .get("types")
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|t| {
            let name = t.get("name").and_then(Value::as_str).unwrap_or("");
            !name.is_empty()
                && !name.starts_with("__")
                && matches!(t.get("kind").and_then(Value::as_str), Some("OBJECT") | Some("INTERFACE"))
                && js::truthy(t.get("fields"))
        })
        .map(|t| {
            let fields: Vec<Value> = t
                .get("fields")
                .and_then(Value::as_array)
                .map(|a| a.as_slice())
                .unwrap_or(&[])
                .iter()
                .map(|f| {
                    let args: Vec<Value> = f.get("args").and_then(Value::as_array).map(|a| a.iter().map(|x| x.get("name").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
                    json!({ "name": f.get("name").cloned().unwrap_or(Value::Null), "type": type_ref_to_string(f.get("type")), "args": args })
                })
                .collect();
            json!({ "name": t["name"], "kind": t["kind"], "fields": fields })
        })
        .collect();
    Some(json!({ "queryType": name_of(schema.get("queryType")), "mutationType": name_of(schema.get("mutationType")), "types": types }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 타입_표기() {
        assert_eq!(type_ref_to_string(Some(&json!({ "kind": "SCALAR", "name": "String" }))), "String");
        assert_eq!(type_ref_to_string(Some(&json!({ "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "ID" } }))), "ID!");
        assert_eq!(
            type_ref_to_string(Some(&json!({ "kind": "LIST", "name": null, "ofType": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "OBJECT", "name": "User" } } }))),
            "[User!]"
        );
    }

    #[test]
    fn 스키마_단순화() {
        let intro = json!({ "data": { "__schema": {
            "queryType": { "name": "Query" }, "mutationType": null,
            "types": [
                { "kind": "OBJECT", "name": "Query", "fields": [{ "name": "me", "type": { "kind": "OBJECT", "name": "User" }, "args": [] }] },
                { "kind": "OBJECT", "name": "User", "fields": [{ "name": "id", "type": { "kind": "NON_NULL", "name": null, "ofType": { "kind": "SCALAR", "name": "ID" } }, "args": [] }] },
                { "kind": "OBJECT", "name": "__Type", "fields": [{ "name": "x", "type": { "kind": "SCALAR", "name": "String" }, "args": [] }] },
                { "kind": "SCALAR", "name": "String", "fields": null },
            ],
        } } });
        let s = simplify_schema(&intro).unwrap();
        assert_eq!(s["queryType"], "Query");
        assert_eq!(s["mutationType"], Value::Null);
        assert_eq!(s["types"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect::<Vec<_>>(), ["Query", "User"]);
        assert_eq!(s["types"][1]["fields"][0], json!({ "name": "id", "type": "ID!", "args": [] }));
        assert!(simplify_schema(&json!({ "data": {} })).is_none());
    }
}

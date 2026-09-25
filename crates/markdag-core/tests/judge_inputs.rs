// 審判の harness (scripts/judge/lib.ts の loadTypeRefs と harness.ts の hookRefsFrom) が build_model に渡す入力の読み込みの写し。
// types の $ref の中身 (文書の場所からの相対で読む YAML) と、コーパスの脇の <名前>.hooks.json のフックの形。
// 審判の診断と model の突き合わせのテストと、審判に Rust の model を渡す例 (examples/model_corpus.rs) が `#[path]` で読む
#![allow(dead_code)]

use std::fs;
use std::path::Path;

use indexmap::IndexMap;
use markdag_core::model::util::JsValue;
use markdag_core::types::{HookSpec, HookSpecEntry};
use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde_json::Value;

fn yaml_to_js(yaml: &Yaml) -> JsValue {
    match yaml {
        Yaml::Value(Scalar::Null) => JsValue::Null,
        Yaml::Value(Scalar::Boolean(value)) => JsValue::Bool(*value),
        Yaml::Value(Scalar::Integer(value)) => JsValue::Number(*value as f64),
        Yaml::Value(Scalar::FloatingPoint(value)) => JsValue::Number(value.into_inner()),
        Yaml::Value(Scalar::String(text)) => JsValue::String(text.to_string()),
        Yaml::Representation(text, _, _) => JsValue::String(text.to_string()),
        Yaml::Sequence(items) => JsValue::Array(items.iter().map(yaml_to_js).collect()),
        Yaml::Mapping(map) => JsValue::Object(
            map.iter()
                .map(|(key, value)| {
                    let key = match yaml_to_js(key) {
                        JsValue::String(text) => text,
                        other => panic!("types の YAML のキーが文字でない: {other:?}"),
                    };
                    (key, yaml_to_js(value))
                })
                .collect(),
        ),
        Yaml::Tagged(_, inner) => yaml_to_js(inner),
        Yaml::Alias(_) | Yaml::BadValue => JsValue::Null,
    }
}

// scripts/judge/lib.ts の loadTypeRefs と同じ規則: markdag.types.$ref (文字か文字の一覧) を文書の場所からの相対で読み、
// 読めなければ null
pub fn load_type_refs(frontmatter: &JsValue, corpus: &Path) -> IndexMap<String, JsValue> {
    let refs: Vec<String> = match frontmatter {
        JsValue::Object(entries) => match entries.get("markdag") {
            Some(JsValue::Object(markdag)) => match markdag.get("types") {
                Some(JsValue::Object(types)) => match types.get("$ref") {
                    Some(JsValue::String(one)) => vec![one.clone()],
                    Some(JsValue::Array(items)) => items
                        .iter()
                        .filter_map(|item| match item {
                            JsValue::String(text) => Some(text.clone()),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            },
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    refs.into_iter()
        .map(|reference| {
            let loaded = fs::read_to_string(corpus.join(&reference))
                .ok()
                .and_then(|text| Yaml::load_from_str(&text).ok())
                .map(|docs| docs.first().map(yaml_to_js).unwrap_or(JsValue::Null))
                .unwrap_or(JsValue::Null);
            (reference, loaded)
        })
        .collect()
}

// scripts/judge/harness.ts の hookRefsFrom と同じ規則で、コーパスの脇の <名前>.hooks.json (sidecar) を HookSpec にする。
// 脇のファイルがなければ hookRefs を渡さない (None)。null の ref は「渡したが見つからない」なのでキーを作らない。
// モジュールの export の順は functions、values の順 (hookRefsFrom が組む順)
pub fn load_hook_spec(sidecar: &Path) -> Result<Option<HookSpec>, String> {
    if !sidecar.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(sidecar).map_err(|error| error.to_string())?;
    let raw: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let entries = raw.as_object().ok_or("hooks.json がオブジェクトでない")?;
    let mut spec = HookSpec::new();
    for (reference, shape) in entries {
        if shape.is_null() {
            continue;
        }
        let names = |field: &str| -> Result<Vec<String>, String> {
            shape[field]
                .as_array()
                .ok_or_else(|| format!("hooks.json の {reference}.{field} が配列でない"))?
                .iter()
                .map(|name| {
                    name.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| format!("{reference}.{field} に文字でない値"))
                })
                .collect()
        };
        let mut exports: Vec<(String, bool)> = names("functions")?
            .into_iter()
            .map(|name| (name, true))
            .collect();
        exports.extend(names("values")?.into_iter().map(|name| (name, false)));
        spec.insert(reference.clone(), HookSpecEntry::Module { exports });
    }
    Ok(Some(spec))
}

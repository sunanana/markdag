// 審判の期待値 (tests/fixtures/judge/expected/*.json) の形と、境界の JSON の形の差を直す、ただ 1 つの場所 (規則書 4 章)。
// 期待値は旧実装の値を harness の plain() で JSON にしたもので、Map / Set の印と、審判だけが足した欄を持つ。
// 直すもの:
//   parsed (期待値 → 境界。Rust に DOM が無いので html は常に htmlRaw で比べる):
//          styleUrls → features (知らない URL は誤り)、html ← htmlRaw、leadingIcon を落とす
//   model (境界 → 期待値。Rust の出力を期待値の形にして比べる):
//          groupsOf と tagsOf の配列の組 → `$map`、
//          hooks の `{ declared, options, rules }` → `{ hooks: [{ ref, exports }], options }`
//          (rules から markdag.rules の exports を組んで先頭に置き、各 exports は harness と同じく名前の順に並べる)
//   layout.graph (境界 → 期待値。射影の VisibleGraph): layoutParent の配列の組 → `$map`
//   layout の節 (境界 → 期待値。layout_document の LayoutDocumentResult): graph は上の layout.graph の変換、
//          rects / gaps / plannedX / nodeSize の配列の組 → `$map`、frames (outline つき) / edges / bounds / passes はそのまま、
//          harness が入力から足す folded を先頭に置く
//   model (期待値 → 境界) は型の往復のテストで GraphModel に読むための足場。rules の値は frontmatter から組み直すので、
//          値そのものの正しさはここでは確かめない (model のタスクの単体テストで見る)
// `$number` は境界でも同じ印なのでそのまま。`$map` の印を外すのは契約で Map の欄 (groupsOf、tagsOf) だけにし、
// 利用者の値 (frontmatter、hooks.options) の中の同じ形のオブジェクトには触れない
// 他の test crate から `#[path]` で読むので、ここ単体では使われない関数がある
#![allow(dead_code)]

use serde_json::{Map, Value, json};

const RULES_REF: &str = "markdag.rules";

// 契約で Map を配列の組にする model の欄
const MAP_FIELDS: [&str; 2] = ["groupsOf", "tagsOf"];

// 変換器の styleUrls の URL の見分け方 (審判の synth-new.ts と同じ文字)。どれにも当たらない URL は誤りにする
const MATH_URL: &str = "/katex@";
const CODE_URL: &str = "/@highlightjs/";

/// 期待値の文書 1 つ (`{ parsed, model, ... }`) から、境界の形の parsed と model を作る
pub fn boundary_from_expected(expected: &Value) -> Result<(Value, Value), String> {
    let parsed = expected.get("parsed").ok_or("parsed の欄がない")?;
    let model = expected.get("model").ok_or("model の欄がない")?;
    let parsed = boundary_parsed(parsed)?;
    let model = boundary_model(&unmark_map_fields(model)?, &parsed)?;
    Ok((parsed, model))
}

// harness の plain() が Map の欄に付けた `{ $map: [...] }` の印を外す
fn unmark_map_fields(model: &Value) -> Result<Value, String> {
    let mut model = model
        .as_object()
        .ok_or("model がオブジェクトでない")?
        .clone();
    for field in MAP_FIELDS {
        let marked = model
            .get(field)
            .ok_or_else(|| format!("model.{field} がない"))?;
        let pairs = marked
            .as_object()
            .filter(|entries| entries.len() == 1)
            .and_then(|entries| entries.get("$map"))
            .filter(|pairs| pairs.is_array())
            .ok_or_else(|| format!("model.{field} が $map の印でない"))?
            .clone();
        model.insert(field.to_string(), pairs);
    }
    Ok(Value::Object(model))
}

/// Rust の出力の model (境界の形) を、期待値の model の形にする
pub fn expected_model_from_boundary(model: &Value) -> Result<Value, String> {
    let mut model = model
        .as_object()
        .ok_or("model がオブジェクトでない")?
        .clone();
    for field in MAP_FIELDS {
        let pairs = model
            .get(field)
            .filter(|pairs| pairs.is_array())
            .ok_or_else(|| format!("model.{field} が配列でない"))?
            .clone();
        model.insert(field.to_string(), json!({ "$map": pairs }));
    }
    let hooks = model
        .get("hooks")
        .and_then(Value::as_object)
        .ok_or("model.hooks がオブジェクトでない")?;
    let options = hooks
        .get("options")
        .cloned()
        .ok_or("model.hooks.options がない")?;
    let declared = hooks
        .get("declared")
        .and_then(Value::as_array)
        .ok_or("model.hooks.declared が配列でない")?;
    let mut listed = Vec::with_capacity(declared.len() + 1);
    match hooks.get("rules") {
        Some(Value::Null) => {}
        Some(rules) => {
            listed.push(json!({ "ref": RULES_REF, "exports": rules_exports_of(&rules_from_boundary(rules)?) }));
        }
        None => return Err("model.hooks.rules がない".to_string()),
    }
    for (index, hook) in declared.iter().enumerate() {
        let reference = hook
            .get("ref")
            .cloned()
            .ok_or_else(|| format!("model.hooks.declared[{index}].ref がない"))?;
        let mut exports: Vec<String> = hook
            .get("exports")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("model.hooks.declared[{index}].exports が配列でない"))?
            .iter()
            .map(|name| name.as_str().map(str::to_string))
            .collect::<Option<_>>()
            .ok_or_else(|| format!("model.hooks.declared[{index}].exports に文字でない値"))?;
        // 期待値は harness が名前の順に並べたもの。境界の順 (Object.entries の順) は変えず、比べるときだけ並べる
        exports.sort_unstable();
        listed.push(json!({ "ref": reference, "exports": exports }));
    }
    model.insert(
        "hooks".to_string(),
        json!({ "hooks": listed, "options": options }),
    );
    Ok(Value::Object(model))
}

fn rules_from_boundary(rules: &Value) -> Result<Rules, String> {
    let flag = |name: &str| {
        rules
            .get(name)
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("model.hooks.rules.{name} が真偽でない"))
    };
    let readonly_groups = rules
        .get("readonlyGroups")
        .and_then(Value::as_array)
        .ok_or("model.hooks.rules.readonlyGroups が配列でない")?
        .iter()
        .map(|name| name.as_str().map(str::to_string))
        .collect::<Option<_>>()
        .ok_or("model.hooks.rules.readonlyGroups に文字でない値")?;
    Ok(Rules {
        require_upstream_done: flag("requireUpstreamDone")?,
        readonly_groups,
        keep_milestones_open: flag("keepMilestonesOpen")?,
    })
}

fn boundary_parsed(parsed: &Value) -> Result<Value, String> {
    let mut parsed = parsed
        .as_object()
        .ok_or("parsed がオブジェクトでない")?
        .clone();
    let style_urls = parsed
        .shift_remove("styleUrls")
        .ok_or("parsed.styleUrls がない")?;
    let urls: Vec<&str> = style_urls
        .as_array()
        .ok_or("parsed.styleUrls が配列でない")?
        .iter()
        .map(|url| url.as_str().ok_or("parsed.styleUrls に文字でない値"))
        .collect::<Result<_, _>>()?;
    if let Some(unknown) = urls
        .iter()
        .find(|url| !url.contains(MATH_URL) && !url.contains(CODE_URL))
    {
        return Err(format!(
            "parsed.styleUrls に数式でもコードでもない URL がある: {unknown}"
        ));
    }
    parsed.insert(
        "features".to_string(),
        json!({
            "math": urls.iter().any(|url| url.contains(MATH_URL)),
            "code": urls.iter().any(|url| url.contains(CODE_URL)),
        }),
    );
    let nodes = parsed
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .ok_or("parsed.nodes が配列でない")?;
    for (index, node) in nodes.iter_mut().enumerate() {
        let node = node
            .as_object_mut()
            .ok_or_else(|| format!("parsed.nodes[{index}] がオブジェクトでない"))?;
        let raw = node
            .shift_remove("htmlRaw")
            .ok_or_else(|| format!("parsed.nodes[{index}].htmlRaw がない"))?;
        node.shift_remove("leadingIcon");
        node.insert("html".to_string(), raw);
    }
    Ok(Value::Object(parsed))
}

fn boundary_model(model: &Value, parsed: &Value) -> Result<Value, String> {
    let mut model = model
        .as_object()
        .ok_or("model がオブジェクトでない")?
        .clone();
    let hooks = model
        .get("hooks")
        .and_then(Value::as_object)
        .ok_or("model.hooks がオブジェクトでない")?;
    let options = hooks
        .get("options")
        .cloned()
        .ok_or("model.hooks.options がない")?;
    let mut declared: Vec<Value> = hooks
        .get("hooks")
        .and_then(Value::as_array)
        .ok_or("model.hooks.hooks が配列でない")?
        .clone();
    let rules_exports = match declared.first() {
        Some(first) if first.get("ref").and_then(Value::as_str) == Some(RULES_REF) => {
            let exports = first
                .get("exports")
                .cloned()
                .ok_or("markdag.rules の exports がない")?;
            declared.remove(0);
            Some(exports)
        }
        _ => None,
    };
    let rules = rules_config(parsed.pointer("/frontmatter/markdag/rules"));
    let derived = rules.as_ref().map(rules_exports_of);
    if derived != rules_exports {
        return Err(format!(
            "frontmatter の markdag.rules から組んだ exports {derived:?} が、期待値の markdag.rules の exports {rules_exports:?} と合わない"
        ));
    }
    let rules = match rules {
        Some(rules) => json!({
            "requireUpstreamDone": rules.require_upstream_done,
            "readonlyGroups": rules.readonly_groups,
            "keepMilestonesOpen": rules.keep_milestones_open,
        }),
        None => Value::Null,
    };
    model.insert(
        "hooks".to_string(),
        json!({ "declared": declared, "options": options, "rules": rules }),
    );
    Ok(Value::Object(model))
}

struct Rules {
    require_upstream_done: bool,
    readonly_groups: Vec<String>,
    keep_milestones_open: bool,
}

// src/model/hooks.ts の rulesModule が読む値 (関数は作らない)。何も有効でなければ None
fn rules_config(raw: Option<&Value>) -> Option<Rules> {
    let raw = raw?.as_object()?;
    let empty = Map::new();
    let task_toggle = raw
        .get("taskToggle")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let fold = raw.get("fold").and_then(Value::as_object).unwrap_or(&empty);
    let require_upstream_done = task_toggle.get("requireUpstreamDone") == Some(&Value::Bool(true));
    let readonly_groups: Vec<String> = task_toggle
        .get("readonlyGroups")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let keep_milestones_open = fold.get("keepMilestonesOpen") == Some(&Value::Bool(true));
    if !require_upstream_done && readonly_groups.is_empty() && !keep_milestones_open {
        return None;
    }
    Some(Rules {
        require_upstream_done,
        readonly_groups,
        keep_milestones_open,
    })
}

// 規則の設定から、markdag.rules のフックが出す名前 (harness と同じく名前の順に並べる)
fn rules_exports_of(rules: &Rules) -> Value {
    let mut exports = Vec::new();
    if rules.require_upstream_done || !rules.readonly_groups.is_empty() {
        exports.push("beforeTaskToggle");
    }
    if rules.keep_milestones_open {
        exports.push("beforeFold");
    }
    exports.sort_unstable();
    json!(exports)
}

/// Rust の射影の出力 (VisibleGraph の境界の形) を、期待値の layout.graph の形にする (layoutParent の配列の組 → `$map`)
pub fn expected_graph_from_boundary(graph: &Value) -> Result<Value, String> {
    let mut graph = graph
        .as_object()
        .ok_or("graph がオブジェクトでない")?
        .clone();
    let pairs = graph
        .get("layoutParent")
        .filter(|pairs| pairs.is_array())
        .ok_or("graph.layoutParent が配列でない")?
        .clone();
    graph.insert("layoutParent".to_string(), json!({ "$map": pairs }));
    Ok(Value::Object(graph))
}

/// layout_document の出力 (LayoutDocumentResult の境界の形) を、期待値の layout (と layoutFolded) の形にする。
/// folded は harness が layoutFor に渡した閉じたノード (入力の側の値)
pub fn expected_layout_document_from_boundary(
    result: &Value,
    folded: &[u32],
) -> Result<Value, String> {
    let field = |name: &str| result.get(name).cloned().ok_or(format!("{name} がない"));
    let pairs = |name: &str| -> Result<Value, String> {
        let pairs = result
            .get(name)
            .filter(|pairs| pairs.is_array())
            .ok_or(format!("{name} が配列でない"))?;
        Ok(json!({ "$map": pairs }))
    };
    Ok(json!({
        "folded": folded,
        "graph": expected_graph_from_boundary(&field("graph")?)?,
        "frames": field("frames")?,
        "rects": pairs("rects")?,
        "gaps": pairs("gaps")?,
        "edges": field("edges")?,
        "bounds": field("bounds")?,
        "plannedX": pairs("plannedX")?,
        "nodeSize": pairs("nodeSize")?,
        "passes": field("passes")?,
    }))
}

/// JSON の値として等しいか。数は f64 で比べ (`3` と `3.0` は同じ)、オブジェクトのキーの順は見ない。
/// 違えば最初に見つけた場所 (JSON Pointer) と中身を返す
pub fn first_difference(expected: &Value, actual: &Value, path: &str) -> Option<String> {
    match (expected, actual) {
        (Value::Number(a), Value::Number(b)) => {
            (a.as_f64() != b.as_f64()).then(|| format!("{path}: 期待 {a}、実際 {b}"))
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!(
                    "{path}: 長さが違う (期待 {}、実際 {})",
                    a.len(),
                    b.len()
                ));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(index, (x, y))| first_difference(x, y, &format!("{path}/{index}")))
        }
        (Value::Object(a), Value::Object(b)) => {
            if let Some(key) = a.keys().find(|key| !b.contains_key(*key)) {
                return Some(format!("{path}/{key}: 書き出しに欄がない"));
            }
            if let Some(key) = b.keys().find(|key| !a.contains_key(*key)) {
                return Some(format!("{path}/{key}: 期待値にない欄を書き出した"));
            }
            a.iter()
                .find_map(|(key, x)| first_difference(x, &b[key], &format!("{path}/{key}")))
        }
        (a, b) => (a != b).then(|| format!("{path}: 期待 {a}、実際 {b}")),
    }
}

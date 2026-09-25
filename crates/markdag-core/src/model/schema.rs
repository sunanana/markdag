// 原文: src/model/model.ts (2026-09-24) の schema の検査 (IS_TYPE から checkFrontmatter まで)
// frontmatter の形と型の検証。出どころは frontmatter.schema.json の 1 枚だけで、診断のコード (x-code)、
// 重大度 (x-severity)、直し方の手がかり (x-hint) もスキーマが持つ。見るキーワードは type, enum, const, pattern,
// minLength, items, properties, additionalProperties, uniqueItems, oneOf, $ref (#/$defs/ のみ) に限る。
// スキーマは crate の中に写した JSON を include_str! で同梱し、利用者の値と同じ JsValue で読む。
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::model::locator::FrontmatterLocator;
use crate::model::util::{
    JsValue, closest, is_record, js_array_join, js_json_stringify, js_number_to_string,
    js_object_keys, js_same_value_zero, js_slice, js_strict_equals, js_to_string,
};
use crate::types::{Diagnostic, PathStep, Severity, SourcePath};

type Schema = IndexMap<String, JsValue>;

// 原本は src/model/frontmatter.schema.json。写しは手で置き、原本と同じことは crate の tests/ のテストで確かめる
// (規則 1 章の panic の行、A-087 の (b))
const SCHEMA_SOURCE: &str = include_str!("frontmatter.schema.json");

// 規則 1 章 (A-021): include_str! した JSON の from_str は expect を認める (同梱の定数なので失敗は実装の誤り)。
// 規則 2.3 の決定 8 と同じく、キーは書かれた順 (IndexMap) で持つ
static SCHEMA: LazyLock<Schema> =
    LazyLock::new(|| serde_json::from_str(SCHEMA_SOURCE).expect("同梱の frontmatter.schema.json"));

// スキーマの pattern を前もって正規表現にしたもの (pattern の文字 → 正規表現)。
// 規則 2.4 (A-004): schema の pattern は u フラグなしの ASCII の固定の正規表現なので regex に写す。
// 規則 1 章 (A-021): 定数の正規表現なので expect を認める
// pattern は表に集め、集める関数の中の expect を認める。2.4 の文字クラスの書き換えは通さないので、
// 書き換える字を含まないことと表のキーを単体テストで完全に比べて守る (規則 1 章、A-088)
static SCHEMA_PATTERNS: LazyLock<HashMap<String, Regex>> = LazyLock::new(|| {
    let mut patterns = HashMap::new();
    collect_patterns(&SCHEMA, &mut patterns);
    patterns
});

fn collect_patterns(schema: &Schema, into: &mut HashMap<String, Regex>) {
    if let Some(JsValue::String(pattern)) = schema.get("pattern") {
        into.insert(
            pattern.clone(),
            Regex::new(pattern).expect("固定の正規表現"),
        );
    }
    for child in schema.values() {
        collect_patterns_in(child, into);
    }
}

fn collect_patterns_in(value: &JsValue, into: &mut HashMap<String, Regex>) {
    match value {
        JsValue::Object(schema) => collect_patterns(schema, into),
        JsValue::Array(items) => items
            .iter()
            .for_each(|item| collect_patterns_in(item, into)),
        _ => {}
    }
}

// スキーマの欄の読み取り (`schema[k]`)。無ければ undefined
// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn field<'s>(schema: &'s Schema, key: &str) -> &'s JsValue {
    schema.get(key).unwrap_or(&JsValue::Undefined)
}

// `typeof schema[k] === 'string'` で文字のときだけ取り出す
// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn text_field<'s>(schema: &'s Schema, key: &str) -> Option<&'s str> {
    match schema.get(key) {
        Some(JsValue::String(text)) => Some(text),
        _ => None,
    }
}

// 知らないキー 1 つ (SchemaIssue.unknown)。そこに書けるキーの一覧と、下の階層に書くはずのキーならその置き場所
// 名前は 4 章 (A-030) の「型名 + 欄名」。欄の無名のオブジェクト型に当てることの明記は A-090
// 原文で export しない interface なので private の struct にし、境界に出ないので Serialize / Deserialize は付けない (規則 2.6、A-077)
#[derive(Debug, Clone)]
struct SchemaIssueUnknown {
    key: String,
    known: Vec<String>,
    under: Option<Vec<String>>,
}

// 破られた制約 1 つ。path は誤りのある値の場所 (位置の解決にそのまま渡す)、schema はその制約を書いた部分スキーマ
// 原文で export しない interface なので private の struct にし、境界に出ないので Serialize / Deserialize は付けない (規則 2.6、A-077)
#[derive(Debug, Clone)]
struct SchemaIssue<'v> {
    path: SourcePath,
    schema: &'static Schema,
    keyword: &'static str,
    value: &'v JsValue,
    // additionalProperties の違反での、知らないキーと、そこに書けるキーの一覧。
    // そのキーが下の階層に書くはずのものなら、under に置き場所 (そこからの親のキーの道すじ) が入る
    unknown: Option<SchemaIssueUnknown>,
}

/// 原文: IS_TYPE。表にない型の名前は None (原文の `IS_TYPE[type]` が undefined)
// 内部の定数の Record は網羅の match の private fn に写し、名前は定数名の snake_case にする (規則 2.1、A-054、A-071)
fn is_type(name: &str, value: &JsValue) -> Option<bool> {
    let matched = match name {
        "object" => is_record(value),
        "array" => matches!(value, JsValue::Array(_)),
        "string" => matches!(value, JsValue::String(_)),
        "boolean" => matches!(value, JsValue::Bool(_)),
        // 規則 2.1: Number.isFinite / Number.isInteger は f64 の検査 (整数と小数を区別しない)
        "number" => matches!(value, JsValue::Number(number) if number.is_finite()),
        "integer" => {
            matches!(value, JsValue::Number(number) if number.is_finite() && number.fract() == 0.0)
        }
        "null" => matches!(value, JsValue::Null),
        _ => return None,
    };
    Some(matched)
}

/// 原文: TYPE_LABELS
// 内部の定数の Record は網羅の match の private fn に写す (規則 2.1、A-054、A-071)。
// 定数名の snake_case の type_labels は messageOf の局所の typeLabels と同じ名前になり、関数が隠れるので単数にする (規則 2.1、A-091)
fn type_label(name: &str) -> Option<&'static str> {
    match name {
        "object" => Some("キーと値の組"),
        "array" => Some("一覧"),
        "string" => Some("文字列"),
        "boolean" => Some("真偽値"),
        "number" => Some("数値"),
        "integer" => Some("整数"),
        "null" => Some("空"),
        _ => None,
    }
}

/// 原文: asText。診断に書き添える値。長いものは途中で切る
// 規則 2.1: JSON.stringify は js_json_stringify、String(value) は js_to_string。
// JSON.stringify が undefined を返すのは JsValue では Undefined だけなので、`??` の腕はそこで分ける。規則 2.2: [...s] の長さはコードポイント
fn as_text(value: &JsValue) -> String {
    let text = match value {
        JsValue::Undefined => js_to_string(value),
        _ => js_json_stringify(value),
    };
    let shown: Vec<char> = text.chars().collect();
    if shown.len() > 40 {
        format!("{}…", shown.iter().take(40).collect::<String>())
    } else {
        shown.into_iter().collect()
    }
}

/// 原文: asList。そこに書けるキーの一覧。markmap のように多いものは途中までにする
// 規則 2.2 (A-032): 長さは UTF-16 の単位。`names.slice(0, index)` は take(index)
fn as_list(names: &[String]) -> String {
    let kept: Vec<&str> = names
        .iter()
        .enumerate()
        .filter(|(index, name)| {
            names
                .iter()
                .take(*index)
                .map(String::as_str)
                .collect::<Vec<&str>>()
                .join(", ")
                .encode_utf16()
                .count()
                + name.encode_utf16().count()
                <= 48
        })
        .map(|(_, name)| name.as_str())
        .collect();
    if kept.len() == names.len() {
        names.join(", ")
    } else {
        format!("{} ほか", kept.join(", "))
    }
}

/// 原文: refTarget。$ref の先。$ref は type や items の兄弟に置けるので、1 つの値に制約を 2 段 (型と形) で掛けられる
fn ref_target(schema: &Schema) -> Option<&'static Schema> {
    let JsValue::String(reference) = field(schema, "$ref") else {
        return None;
    };
    // 規則 2.1 (A-060): isRecord で中身が要るところは if let JsValue::Object で取り出す
    let JsValue::Object(defs) = field(&SCHEMA, "$defs") else {
        return None;
    };
    // 規則 2.2: g なしの replace は最初の 1 か所だけ
    if let Some(JsValue::Object(target)) = defs.get(&reference.replacen("#/$defs/", "", 1)) {
        Some(target)
    } else {
        None
    }
}

/// 原文: typesOf。type に書かれた型の一覧。type は 1 つの名前か、名前の一覧 (どれかに合えばよい。値が空でもよいキーに null を並べる)
fn types_of(schema: &Schema) -> Vec<String> {
    match field(schema, "type") {
        JsValue::String(name) => vec![name.clone()],
        // 規則 2.1: map(String) は js_to_string
        JsValue::Array(names) => names.iter().map(js_to_string).collect(),
        _ => Vec::new(),
    }
}

/// 原文: typeOf。oneOf の枝は値の型で選ぶので、枝の型を $ref の先まで見て取り出す
fn type_of(schema: &Schema) -> String {
    if let JsValue::String(name) = field(schema, "type") {
        return name.clone();
    }
    match ref_target(schema) {
        Some(target) => type_of(target),
        None => String::new(),
    }
}

/// 原文: propertiesOf。$ref の先の properties に、自分の properties を重ねたもの
// 規則 2.3: `{ ...a, ...b }` は IndexMap::insert (既にあるキーの位置は a の順のまま、b の新しいキーは後ろ)
fn properties_of(schema: Option<&'static Schema>) -> IndexMap<String, &'static JsValue> {
    let Some(schema) = schema else {
        return IndexMap::new();
    };
    let mut merged = properties_of(ref_target(schema));
    if let JsValue::Object(own) = field(schema, "properties") {
        for (name, sub) in own {
            merged.insert(name.clone(), sub);
        }
    }
    merged
}

/// 原文: ownersOf。そのスキーマより下の階層に書くキーと、その置き場所 (そこからの親のキーの道すじ)。
/// properties と $ref の先だけをたどり、名前が決まっていないキー (additionalProperties) の下は見ない。
/// 同じ名前が 2 か所にあれば、先に見つけたほうを取る
// 規則 2.6 (A-022): 呼び出しをまたいで書き換える既定の引数 into は、最上位の呼び出し側が空の値を作って &mut で渡す
fn owners_of(schema: &'static Schema, path: &[String], into: &mut IndexMap<String, Vec<String>>) {
    for (name, sub) in properties_of(Some(schema)) {
        let JsValue::Object(sub) = sub else {
            continue;
        };
        if !path.is_empty() && !into.contains_key(&name) {
            into.insert(name.clone(), path.to_vec());
        }
        let mut deeper = path.to_vec();
        deeper.push(name);
        owners_of(sub, &deeper, into);
    }
}

/// 原文: placementHint。置き場所の手がかり。親のキーの道すじを、上から順に作る言い方にする
fn placement_hint(parents: &[String], key: &str) -> String {
    // 規則 2.5 (A-031): 分割代入の既定値は unwrap_or で写す
    let (first, rest) = parents
        .split_first()
        .map(|(first, rest)| (first.as_str(), rest))
        .unwrap_or(("", &[]));
    let chain = if rest.is_empty() {
        format!("{first}: の行を作り")
    } else {
        let names: Vec<String> = rest.iter().map(|name| format!("{name}:")).collect();
        format!(
            "{first}: の下に {} を作り",
            names.join(" を作り、さらにその下に ")
        )
    };
    format!("{chain}、その下に字下げして {key}: を書きます")
}

// 原文の閉包 add。issues を捕まえて再帰の check と同時に書き換えるので、捕まえていた path / schema / value と
// extra (value と unknown の上書き) を引数にした自由な関数にした (規則 2.6、A-040)
fn add<'v>(
    issues: &mut Vec<SchemaIssue<'v>>,
    path: &SourcePath,
    schema: &'static Schema,
    value: &'v JsValue,
    keyword: &'static str,
    unknown: Option<SchemaIssueUnknown>,
) {
    issues.push(SchemaIssue {
        path: path.clone(),
        schema,
        keyword,
        value,
        unknown,
    });
}

// path に 1 段足した写し (`[...path, step]`)
// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn with_step(path: &SourcePath, step: PathStep) -> SourcePath {
    let mut next = path.clone();
    next.push(step);
    next
}

/// 原文: check
fn check<'v>(
    value: &'v JsValue,
    schema: &'static Schema,
    path: &SourcePath,
    issues: &mut Vec<SchemaIssue<'v>>,
) {
    if let Some(target) = ref_target(schema) {
        check(value, target, path, issues);
    }
    // 型が違えば、その先の制約は見ない (同じ値に 2 つ診断を出さない)
    let types = types_of(schema);
    // 表にない型の名前は合うものとして扱う (`IS_TYPE[type]?.(value) ?? true`)
    if !types.is_empty()
        && !types
            .iter()
            .any(|name| is_type(name, value).unwrap_or(true))
    {
        return add(issues, path, schema, value, "type", None);
    }
    if let JsValue::Array(choices) = field(schema, "enum")
        && !choices
            .iter()
            .any(|choice| js_same_value_zero(choice, value))
    {
        add(issues, path, schema, value, "enum", None);
    }
    // 規則 2.1: `'const' in schema` は自分の持つキーだけを見る。`!==` は js_strict_equals の否定
    if let Some(constant) = schema.get("const")
        && !js_strict_equals(constant, value)
    {
        add(issues, path, schema, value, "const", None);
    }
    if let JsValue::String(text) = value {
        if let Some(pattern) = text_field(schema, "pattern") {
            // TODO(port): Rust 側の不到達。SCHEMA_PATTERNS は同じスキーマのすべての pattern を持つので、引けないことはない (引けなければ検査しない)
            if let Some(regex) = SCHEMA_PATTERNS.get(pattern)
                && !regex.is_match(text)
            {
                add(issues, path, schema, value, "pattern", None);
            }
        }
        // 規則 2.2: [...value].length はコードポイントの数
        if let JsValue::Number(min_length) = field(schema, "minLength")
            && (text.chars().count() as f64) < *min_length
        {
            add(issues, path, schema, value, "minLength", None);
        }
    }
    if let JsValue::Array(candidates) = field(schema, "oneOf") {
        // find は最初の一致。`IS_TYPE[typeOf(candidate)]?.(value) === true` は表にない型の名前を偽にする
        let branch = candidates
            .iter()
            .filter_map(|candidate| {
                if let JsValue::Object(candidate) = candidate {
                    Some(candidate)
                } else {
                    None
                }
            })
            .find(|candidate| is_type(&type_of(candidate), value) == Some(true));
        match branch {
            Some(branch) => check(value, branch, path, issues),
            None => add(issues, path, schema, value, "oneOf", None),
        }
    }
    if let JsValue::Array(items) = value {
        // 規則 2.3 (A-008): 反復しない Set は HashSet でよい
        let mut seen: HashSet<String> = HashSet::new();
        for (index, item) in items.iter().enumerate() {
            let item_path = with_step(path, PathStep::Index(index));
            if let JsValue::Object(item_schema) = field(schema, "items") {
                check(item, item_schema, &item_path, issues);
            }
            // 規則 2.1 (A-026): JSON.stringify は js_json_stringify (キーは JS の順)。`item ?? null` は undefined を null に
            let same = js_json_stringify(if *item == JsValue::Undefined {
                &JsValue::Null
            } else {
                item
            });
            // 重なりは、2 つ目以降の項目の位置で知らせる
            if *field(schema, "uniqueItems") == JsValue::Bool(true) && seen.contains(&same) {
                issues.push(SchemaIssue {
                    path: item_path.clone(),
                    schema,
                    keyword: "uniqueItems",
                    value: item,
                    unknown: None,
                });
            }
            seen.insert(same);
        }
    }
    if let JsValue::Object(entries) = value {
        // `isRecord(schema.properties) ? schema.properties : {}` の {} は None で持つ
        let properties = if let JsValue::Object(properties) = field(schema, "properties") {
            Some(properties)
        } else {
            None
        };
        // 規則 2.3: Object.entries は書かれた順
        for (key, child) in entries {
            let child_path = with_step(path, PathStep::Key(key.clone()));
            // 規則 2.1 (A-027): `properties[key]` は自分の持つキーだけを見る。`__proto__` も知らないキーとして扱う
            // (旧実装は Object.prototype を空のスキーマとして通し、診断を出さない。migration/judge/accepted.md の 7)
            if let Some(JsValue::Object(sub)) =
                properties.and_then(|properties| properties.get(key))
            {
                check(child, sub, &child_path, issues);
            } else if let JsValue::Object(additional) = field(schema, "additionalProperties") {
                check(child, additional, &child_path, issues);
            } else if *field(schema, "additionalProperties") == JsValue::Bool(false) {
                // 規則 2.6 (A-022): ownersOf の既定の引数 into は、呼び出し側が空の値を作って渡す
                let mut owners = IndexMap::new();
                owners_of(schema, &[], &mut owners);
                let known = properties
                    .map(|properties| properties.keys().cloned().collect())
                    .unwrap_or_default();
                let unknown = SchemaIssueUnknown {
                    key: key.clone(),
                    known,
                    under: owners.get(key).cloned(),
                };
                add(
                    issues,
                    path,
                    schema,
                    child,
                    "additionalProperties",
                    Some(unknown),
                );
            }
        }
    }
}

/// 原文: messageOf。破られたキーワードごとの文面。値の書き方そのものは hint (スキーマの x-hint) に任せ、
/// ここでは何が違うかだけを書く。pattern は形の名前をスキーマの description から取る
fn message_of(issue: &SchemaIssue, label: &str, shown: &str) -> String {
    let SchemaIssue {
        schema,
        keyword,
        unknown,
        ..
    } = issue;
    // `Array.isArray(schema.enum) ? schema.enum : []`
    let choices: &[JsValue] = match field(schema, "enum") {
        JsValue::Array(items) => items,
        _ => &[],
    };
    let branches: Vec<&Schema> = match field(schema, "oneOf") {
        JsValue::Array(items) => items
            .iter()
            .filter_map(|item| {
                if let JsValue::Object(item) = item {
                    Some(item)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    if let Some(unknown) = unknown {
        return format!(
            "{label} のキー「{}」は使えません ({})",
            unknown.key,
            as_list(&unknown.known)
        );
    }
    // 空でもよいキーの「空」は、書き方の案内には出さない
    let type_labels: Vec<&str> = types_of(schema)
        .iter()
        .filter(|name| *name != "null")
        .map(|name| type_label(name).unwrap_or(""))
        .collect();
    match *keyword {
        "type" => format!("{label} は{}で書きます{shown}", type_labels.join("か")),
        // 規則 2.1: `choices.join(', ')` は js_array_join (null と undefined の要素は "")
        "enum" => format!(
            "{label} に指定できるのは {} です{shown}",
            js_array_join(choices, ", ")
        ),
        "const" => format!(
            "{label} に指定できるのは {} です{shown}",
            as_text(field(schema, "const"))
        ),
        // 規則 2.1: `String(schema.description ?? '')` は null と undefined を "" に、それ以外を js_to_string
        "pattern" => {
            let description = match field(schema, "description") {
                JsValue::Null | JsValue::Undefined => String::new(),
                other => js_to_string(other),
            };
            format!("{label} は「{description}」の形で書きます{shown}")
        }
        "minLength" => format!("{label} が空です"),
        "uniqueItems" => format!("{label} は前にも書かれています{shown}"),
        _ => {
            let names: Vec<&str> = branches
                .iter()
                .map(|branch| type_label(&type_of(branch)).unwrap_or(""))
                .collect();
            format!(
                "{label} には {} のどれかを書きます{shown}",
                names.join("、")
            )
        }
    }
}

/// 原文: toDiagnostic。破られた制約を、画面が使う診断に直す。位置はスキーマの中の場所 (パス) から引き、
/// コードと重大度と手がかりは、その制約を書いた部分スキーマから取る。知らないキーと使えない値には、近い名前を手がかりにする
fn to_diagnostic(issue: &SchemaIssue, locator: &FrontmatterLocator) -> Diagnostic {
    let SchemaIssue {
        schema,
        keyword,
        value,
        unknown,
        ..
    } = issue;
    // 場所の呼び名。先頭の「.」は落とす。最上位そのものが相手のときは frontmatter と呼ぶ
    // 規則 2.1: `slice(1) || 'frontmatter'` は空文字のときの既定値 (先頭が '[' でも 1 文字落とす旧実装のまま)
    // 規則 2.2: テンプレート文字列に埋める数は js_number_to_string、s.slice(a, b) は js_slice (先頭は '.' か '[' の ASCII 1 バイト)
    let joined: String = issue
        .path
        .iter()
        .map(|step| match step {
            PathStep::Index(index) => format!("[{}]", js_number_to_string(*index as f64)),
            PathStep::Key(key) => format!(".{key}"),
        })
        .collect();
    let dropped = js_slice(&joined, 1, joined.len());
    let label = if dropped.is_empty() {
        "frontmatter".to_string()
    } else {
        dropped.to_string()
    };
    // 下の階層に書くはずのキーは、知らないキーではなく置き場所の違いとして知らせる
    if let Some(unknown) = unknown
        && let Some(under) = &unknown.under
    {
        return Diagnostic {
            severity: Severity::Warning,
            code: "option-misplaced".to_string(),
            message: format!(
                "{label} のキー「{}」は、{label}.{} の下に書いてください。この位置では無視します",
                unknown.key,
                under.join(".")
            ),
            at: locator.key(&with_step(&issue.path, PathStep::Key(unknown.key.clone()))),
            hint: Some(placement_hint(under, &unknown.key)),
        };
    }
    let near = match (unknown, value) {
        (Some(unknown), _) => closest(&unknown.key, &unknown.known),
        (None, JsValue::String(text)) if *keyword == "enum" => {
            // 規則 2.1: `choices.map(String)` は各要素の js_to_string (join と違い null は "null")
            let choices: Vec<String> = match field(schema, "enum") {
                JsValue::Array(items) => items.iter().map(js_to_string).collect(),
                _ => Vec::new(),
            };
            closest(text, &choices)
        }
        _ => None,
    };
    // `schema['x-severity'] ?? 'warning'`。スキーマは固定で error / warning しか書かない
    let severity = Severity::from_js(field(schema, "x-severity")).unwrap_or(Severity::Warning);
    let code = text_field(schema, "x-code")
        .map(str::to_string)
        .unwrap_or_else(|| {
            if unknown.is_some() {
                "option-unknown"
            } else {
                "option-invalid"
            }
            .to_string()
        });
    // markmap-lib が読めない値を undefined に直したものは、原文の値を書き添えられない
    let shown = if **value == JsValue::Undefined {
        String::new()
    } else {
        format!(" ({})", as_text(value))
    };
    let at = match unknown {
        Some(unknown) => locator.key(&with_step(&issue.path, PathStep::Key(unknown.key.clone()))),
        None => locator.value(&issue.path, None),
    };
    let hint = match near {
        Some(near) => Some(format!("もしかして「{near}」")),
        None => text_field(schema, "x-hint").map(str::to_string),
    };
    Diagnostic {
        severity,
        code,
        message: message_of(issue, &label, &shown),
        at,
        hint,
    }
}

/// 原文: schemaDiagnostics
// 原文は export しない関数なので crate の外に出さない (規則 2.6)
pub(crate) fn schema_diagnostics(
    frontmatter: &JsValue,
    locator: &FrontmatterLocator,
) -> Vec<Diagnostic> {
    let root: &'static Schema = &SCHEMA;
    let mut issues: Vec<SchemaIssue> = Vec::new();
    check(frontmatter, root, &Vec::new(), &mut issues);
    let mut diagnostics: Vec<Diagnostic> = issues
        .iter()
        .map(|issue| to_diagnostic(issue, locator))
        .collect();
    // 最上位は、markmap が任意のキー (title など) を許すので閉じられない。代わりに、下の階層に書くはずのキーと、
    // スキーマが知っているキーの書き間違いらしい名前だけを、ここで拾う
    let root_properties = properties_of(Some(root));
    let root_names: Vec<String> = root_properties.keys().cloned().collect();
    // 規則 2.6 (A-022): ownersOf の既定の引数 into は、呼び出し側が空の値を作って渡す
    let mut owner = IndexMap::new();
    owners_of(root, &[], &mut owner);
    // 規則 2.1: Object.keys は js_object_keys (文字列は UTF-16 の添字、配列は添字、それ以外は空)。
    // frontmatter が null / undefined でも投げず、キーなしとして続けて check の型の診断 1 件だけを返す (規則 2.5、A-096 (b)、accepted.md 15)
    for key in js_object_keys(frontmatter) {
        // 規則 2.1 (A-027): `key in rootProperties` は自分の持つキーだけを見る (`__proto__` や `toString` を飛ばさない)
        if root_properties.contains_key(&key) {
            continue;
        }
        let parent = owner.get(&key);
        // 下の階層に書くはずのキーの書き間違い (relation など) も、ここで拾って置き場所ごと手がかりにする
        let near = match parent {
            None => {
                let candidates: Vec<&str> = root_names
                    .iter()
                    .map(String::as_str)
                    .chain(owner.keys().map(String::as_str))
                    .collect();
                closest(&key, &candidates)
            }
            Some(_) => None,
        };
        let near_parent = near.as_ref().and_then(|near| owner.get(near));
        if let Some(parent) = parent {
            diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                code: "option-misplaced".to_string(),
                message: format!(
                    "「{key}」は frontmatter の {} の下に書いてください。この位置では無視します",
                    parent.join(".")
                ),
                at: locator.key(&[PathStep::Key(key.clone())]),
                hint: Some(placement_hint(parent, &key)),
            });
        } else if let Some(near) = near {
            let hint = match near_parent {
                None => format!("もしかして「{near}」"),
                Some(near_parent) => format!(
                    "もしかして「{near}」({} の下に書きます)",
                    near_parent.join(".")
                ),
            };
            diagnostics.push(Diagnostic {
                severity: Severity::Warning,
                code: "option-unknown".to_string(),
                message: format!(
                    "frontmatter のキー「{key}」は、markdag が読むキー ({}) のどれでもありません",
                    as_list(&root_names)
                ),
                at: locator.key(&[PathStep::Key(key.clone())]),
                hint: Some(hint),
            });
        }
    }
    // 画面は上から順に読むので、frontmatter に書かれた順に並べる (位置の分からないものは最後)
    // 規則 2.3: 安定な sort_by。引き算の代わりに cmp と then_with
    diagnostics.sort_by(|a, b| match (&a.at, &b.at) {
        (Some(a), Some(b)) => a.line.cmp(&b.line).then_with(|| a.column.cmp(&b.column)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    });
    diagnostics
}

/// 原文: checkFrontmatter。frontmatter の形と型だけを検べる入口。原文を渡すと、診断に frontmatter での位置が付く
pub fn check_frontmatter(frontmatter: &JsValue, markdown: Option<&str>) -> Vec<Diagnostic> {
    schema_diagnostics(frontmatter, &FrontmatterLocator::new(markdown))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SourcePosition;

    fn js(json: &str) -> JsValue {
        serde_json::from_str(json).expect("テストの JSON")
    }

    fn codes(json: &str) -> Vec<String> {
        check_frontmatter(&js(json), None)
            .into_iter()
            .map(|item| item.code)
            .collect()
    }

    fn first(json: &str) -> Diagnostic {
        check_frontmatter(&js(json), None)
            .into_iter()
            .next()
            .expect("診断が 1 件以上ある")
    }

    fn hint(json: &str) -> Option<String> {
        first(json).hint
    }

    fn some(text: &str) -> Option<String> {
        Some(text.to_string())
    }

    // ---- test/model.test.ts の「frontmatter の形と型の検証」の写し ----

    const EPIC_FRONTMATTER: &str = r###"{"markdag":{"relations":{"join":["仕様策定/* --> 開発完了"],"chain":["開発完了 --> リリース準備 --> リリースノート作成 --> リリース --> 効果測定"],"depends":["登録API --> 登録画面"]},"groups":{"backend":{"label":"バックエンド","color":"#D64545","boundary":true},"frontend":{"label":"フロントエンド","color":"#3B7DD8","boundary":true},"qa":{"label":"QA","color":"#E0A100"}}}}"###;

    #[test]
    fn schema_ts_says_nothing_for_valid_frontmatter() {
        assert_eq!(check_frontmatter(&js(EPIC_FRONTMATTER), None), Vec::new());
        let small = r###"{"title":"小さな DAG","markmap":{"colorFreezeLevel":2,"color":["#2980b9"]},"markdag":{"relations":{"fork":["企画 --> 設計/*"],"depends":"画面設計 --> API設計"},"groups":{"design":{"label":"設計チーム","color":"#3B7DD8","boundary":true,"members":["画面設計"]}},"tags":{"display":"never"},"details":{"display":"always"},"legend":{"position":"bottom-left","display":false},"branches":["企画","実装"]}}"###;
        assert_eq!(check_frontmatter(&js(small), None), Vec::new());
    }

    #[test]
    fn schema_ts_code_and_severity_come_from_schema() {
        let pairs = [
            (
                r#"{"markdag":{"relations":["A --> B"]}}"#,
                Severity::Error,
                "relation-syntax",
            ),
            (
                r#"{"markdag":{"relations":{"fork":[3]}}}"#,
                Severity::Error,
                "relation-not-string",
            ),
            (
                r#"{"markdag":{"relations":{"fork":["A -> B"]}}}"#,
                Severity::Error,
                "relation-syntax",
            ),
            (
                r#"{"markdag":{"relations":{"flow":["A --> B"]}}}"#,
                Severity::Warning,
                "relation-unknown-key",
            ),
            (
                r#"{"markdag":{"groups":{"a":{"color":3}}}}"#,
                Severity::Warning,
                "group-invalid",
            ),
            (
                r#"{"markdag":{"tags":{"display":"yes"}}}"#,
                Severity::Warning,
                "option-invalid",
            ),
            (
                r#"{"markdag":{"tags":{"displa":true}}}"#,
                Severity::Warning,
                "option-unknown",
            ),
            (
                r#"{"markdag":{"branches":"A"}}"#,
                Severity::Warning,
                "option-invalid",
            ),
            (
                r#"{"markdag":{"branch":["A"]}}"#,
                Severity::Warning,
                "option-unknown",
            ),
        ];
        for (json, severity, code) in pairs {
            let item = first(json);
            assert_eq!(
                (item.severity, item.code.as_str()),
                (severity, code),
                "{json}"
            );
        }
        assert_eq!(
            hint(r#"{"markdag":{"tags":{"displa":true}}}"#),
            some("もしかして「display」")
        );
    }

    #[test]
    fn schema_ts_ref_beside_type_checks_in_two_steps() {
        assert_eq!(
            hint(r#"{"markdag":{"relations":{"fork":[3]}}}"#),
            some("「A --> B: C」のように「: 」を含む式は、行全体を \"…\" で囲みます")
        );
        assert!(
            hint(r#"{"markdag":{"relations":{"fork":["A -> B"]}}}"#)
                .is_some_and(|hint| hint.contains("半角の空白で挟んだ --> で結びます"))
        );
        assert_eq!(
            codes(r#"{"markdag":{"branches":"A"}}"#),
            vec!["option-invalid"]
        );
        let item = first(r#"{"markdag":{"branches":["A","B","A"]}}"#);
        assert_eq!(item.code, "option-invalid");
        assert_eq!(
            item.message,
            "markdag.branches[2] は前にも書かれています (\"A\")"
        );
        assert_eq!(
            item.hint,
            some("同じ行が 2 回あります。重なった行は消せます")
        );
    }

    #[test]
    fn schema_ts_one_of_picks_branch_by_type() {
        let item = first(r#"{"markdag":{"legend":{"display":["groups","lines"]}}}"#);
        assert_eq!(
            item.message,
            "markdag.legend.display[1] に指定できるのは groups, branches です (\"lines\")"
        );
        assert_eq!(item.hint, some("凡例に出せるのは groups と branches です"));
        assert_eq!(
            codes(r#"{"markdag":{"legend":{"display":true}}}"#),
            Vec::<String>::new()
        );
        assert_eq!(
            codes(r#"{"markdag":{"legend":{"display":false}}}"#),
            Vec::<String>::new()
        );
        let item = first(r#"{"markdag":{"legend":{"display":"all"}}}"#);
        assert_eq!(
            item.message,
            "markdag.legend.display には 真偽値、一覧 のどれかを書きます (\"all\")"
        );
        assert_eq!(
            item.hint,
            some("凡例を出さないなら false、項目を選ぶなら一覧で書きます")
        );
    }

    #[test]
    fn schema_ts_near_names_become_hints() {
        assert_eq!(
            hint(r#"{"markdag":{"relations":{"chian":["A --> B"]}}}"#),
            some("もしかして「chain」")
        );
        assert_eq!(
            hint(r#"{"markdag":{"branch":["A"]}}"#),
            some("もしかして「branches」")
        );
        assert_eq!(
            hint(r##"{"markdag":{"groups":{"a":{"colour":"#fff"}}}}"##),
            some("もしかして「color」")
        );
        assert_eq!(
            hint(r#"{"markdag":{"details":{"display":"hoverr"}}}"#),
            some("もしかして「hover」")
        );
        assert_eq!(
            hint(r#"{"markdag":{"details":{"display":"open"}}}"#),
            some("always は最初から開いて表示、hover はノードに重ねる、click は印のクリックです")
        );
    }

    #[test]
    fn schema_ts_lower_level_keys_are_misplaced() {
        let item = first(r#"{"markdag":{"fork":["A --> B"]}}"#);
        assert_eq!(item.code, "option-misplaced");
        assert_eq!(
            item.message,
            "markdag のキー「fork」は、markdag.relations の下に書いてください。この位置では無視します"
        );
        assert_eq!(
            item.hint,
            some("relations: の行を作り、その下に字下げして fork: を書きます")
        );
        assert_eq!(
            first(r#"{"markdag":{"position":"top-left"}}"#).message,
            "markdag のキー「position」は、markdag.legend の下に書いてください。この位置では無視します"
        );
        let item = first(r#"{"relations":{"fork":["A --> B"]}}"#);
        assert_eq!(item.code, "option-misplaced");
        assert_eq!(
            item.message,
            "「relations」は frontmatter の markdag の下に書いてください。この位置では無視します"
        );
        assert_eq!(
            item.hint,
            some("markdag: の行を作り、その下に字下げして relations: を書きます")
        );
        assert_eq!(
            hint(r#"{"fork":"A --> B"}"#),
            some("markdag: の下に relations: を作り、その下に字下げして fork: を書きます")
        );
        assert_eq!(
            hint(r#"{"relation":{"fork":["A --> B"]}}"#),
            some("もしかして「relations」(markdag の下に書きます)")
        );
    }

    #[test]
    fn schema_ts_positions_come_from_source() {
        let markdown = [
            "---",
            "markdag:",
            "    details: always",
            "    branches:",
            "        - A",
            "        - A",
            "---",
            "",
            "# root",
        ]
        .join("\n");
        let at: Vec<Option<SourcePosition>> = check_frontmatter(
            &js(r#"{"markdag":{"details":"always","branches":["A","A"]}}"#),
            Some(&markdown),
        )
        .into_iter()
        .map(|item| item.at)
        .collect();
        assert_eq!(
            at,
            vec![
                Some(SourcePosition {
                    line: 3,
                    column: 14,
                    length: 6
                }),
                Some(SourcePosition {
                    line: 6,
                    column: 11,
                    length: 1
                })
            ]
        );
    }

    // ---- test/model.test.ts の「黙って無視されていた書き方を、スキーマが警告にする」の写し (checkFrontmatter の 39 件) ----

    #[test]
    fn schema_ts_silently_ignored_shapes_warn() {
        let cases: &[(&str, &str, &[&str])] = &[
            (
                "グループの色が引用符なしで、# 以降がコメントになった",
                r#"{"markdag":{"groups":{"a":{"color":null}}}}"#,
                &["group-invalid"],
            ),
            (
                "グループの色が文字列でない",
                r#"{"markdag":{"groups":{"a":{"color":123456}}}}"#,
                &["group-invalid"],
            ),
            (
                "グループの色が CSS の色の形でない",
                r#"{"markdag":{"groups":{"a":{"color":"まっか"}}}}"#,
                &["group-invalid"],
            ),
            (
                "グループの色の 16 進の桁数が足りない",
                r##"{"markdag":{"groups":{"a":{"color":"#D6454"}}}}"##,
                &["group-invalid"],
            ),
            ("題が文字列でない", r#"{"title":123}"#, &["option-invalid"]),
            (
                "グループのラベルが文字列でない",
                r#"{"markdag":{"groups":{"a":{"label":2025}}}}"#,
                &["group-invalid"],
            ),
            (
                "グループのラベルが空",
                r#"{"markdag":{"groups":{"a":{"label":""}}}}"#,
                &["group-invalid"],
            ),
            (
                "枠の指定が真偽値でない",
                r#"{"markdag":{"groups":{"a":{"boundary":"yes"}}}}"#,
                &["group-invalid"],
            ),
            (
                "メンバーを一覧にしていない",
                r#"{"markdag":{"groups":{"a":{"members":"A"}}}}"#,
                &["group-invalid"],
            ),
            (
                "メンバーが文字列でない",
                r#"{"markdag":{"groups":{"a":{"members":[3]}}}}"#,
                &["group-invalid"],
            ),
            (
                "グループの中の知らないキー",
                r##"{"markdag":{"groups":{"a":{"colour":"#fff","member":["A"]}}}}"##,
                &["group-invalid", "group-invalid"],
            ),
            (
                "解決されずに残ったマージキー",
                r##"{"markdag":{"groups":{"a":{"<<":{"color":"#fff"}}}}}"##,
                &["group-invalid"],
            ),
            (
                "グループの定義が写像でない",
                r#"{"markdag":{"groups":{"a":"なにか"}}}"#,
                &["group-invalid"],
            ),
            (
                "グループの定義が一覧",
                r#"{"markdag":{"groups":{"a":["A","B"]}}}"#,
                &["group-invalid"],
            ),
            (
                "groups が一覧",
                r#"{"markdag":{"groups":["a","b"]}}"#,
                &["group-invalid"],
            ),
            (
                "groups が文字列",
                r#"{"markdag":{"groups":"abc"}}"#,
                &["group-invalid"],
            ),
            (
                "markdag が文字列",
                r#"{"markdag":"abc"}"#,
                &["option-invalid"],
            ),
            (
                "凡例の項目が重なっている",
                r#"{"markdag":{"legend":{"display":["groups","groups"]}}}"#,
                &["option-invalid"],
            ),
            (
                "最上位のキーが大文字違い",
                r#"{"Markdag":{"details":{"display":"always"}}}"#,
                &["option-unknown"],
            ),
            (
                "relations の書き間違いを最上位に置いた",
                r#"{"relation":{"fork":["A --> B"]}}"#,
                &["option-unknown"],
            ),
            (
                "markmap のオプションを最上位に置いた",
                r#"{"colorFreezeLevel":2}"#,
                &["option-misplaced"],
            ),
            (
                "relations を最上位に置いた",
                r#"{"relations":{"fork":["A --> B"]}}"#,
                &["option-misplaced"],
            ),
            (
                "groups を最上位に置いた",
                r##"{"groups":{"a":{"color":"#fff"}}}"##,
                &["option-misplaced"],
            ),
            (
                "relations のキーを最上位に置いた",
                r#"{"fork":"A --> B"}"#,
                &["option-misplaced"],
            ),
            (
                "relations のキーを markdag の直下に置いた",
                r#"{"markdag":{"fork":["A --> B"]}}"#,
                &["option-misplaced"],
            ),
            (
                "legend のキーを markdag の直下に置いた",
                r#"{"markdag":{"position":"top-left"}}"#,
                &["option-misplaced"],
            ),
            (
                "markdag のキーを markmap の下に置いた",
                r#"{"markmap":{"markdag":{"details":{"display":"always"}}}}"#,
                &["option-unknown"],
            ),
            (
                "markmap の数値に文字列を書いた",
                r#"{"markmap":{"nodeMinHeight":"20"}}"#,
                &["option-invalid"],
            ),
            (
                "markmap の真偽値に文字列を書いた",
                r#"{"markmap":{"autoFit":"no"}}"#,
                &["option-invalid"],
            ),
            (
                "markmap の深さに数でない文字列を書いた",
                r#"{"markmap":{"colorFreezeLevel":"abc"}}"#,
                &["option-invalid"],
            ),
            (
                "markmap の知らないキー",
                r#"{"markmap":{"colorFreeze":2}}"#,
                &["option-unknown"],
            ),
            (
                "title など markmap 側のキーは、最上位にあってもよい",
                r#"{"title":"x","author":"y"}"#,
                &[],
            ),
            (
                "markmap.htmlParser は markmap-lib が読むので通す",
                r#"{"markmap":{"htmlParser":{"selector":"h1,h2"}}}"#,
                &[],
            ),
            (
                "frontmatter がキーと値の組でない",
                r#""abc""#,
                &["option-invalid"],
            ),
            (
                "グループの色に 8 桁の 16 進",
                r##"{"markdag":{"groups":{"a":{"color":"#3B7DD880"}}}}"##,
                &[],
            ),
            (
                "グループの色に色の名前",
                r#"{"markdag":{"groups":{"a":{"color":"steelblue"}}}}"#,
                &[],
            ),
            (
                "グループの色に関数の書き方",
                r#"{"markdag":{"groups":{"a":{"color":"rgb(59, 125, 216)"}}}}"#,
                &[],
            ),
        ];
        for (label, json, expected) in cases {
            assert_eq!(codes(json), expected.to_vec(), "{label}");
        }
        // markmap-lib が読めずに消した値 (undefined) は JSON で書けないので組み立てる
        let undefined_in = |key: &str| {
            JsValue::Object(IndexMap::from([(
                "markmap".to_string(),
                JsValue::Object(IndexMap::from([(key.to_string(), JsValue::Undefined)])),
            )]))
        };
        for key in ["initialExpandLevel", "color"] {
            let got: Vec<String> = check_frontmatter(&undefined_in(key), None)
                .into_iter()
                .map(|item| item.code)
                .collect();
            assert_eq!(got, vec!["option-invalid"], "{key}");
        }
    }

    // ---- test/model.test.ts の「types と tags.keys の形はスキーマが検査する」の写し ----

    #[test]
    fn schema_ts_types_and_tag_keys() {
        let pairs = |json: &str| -> Vec<(String, Option<String>)> {
            check_frontmatter(&js(json), None)
                .into_iter()
                .map(|item| (item.code, item.hint))
                .collect()
        };
        let one = |code: &str, hint: &str| vec![(code.to_string(), some(hint))];
        assert_eq!(
            pairs(r#"{"markdag":{"types":{"a":{"type":3}}}}"#),
            one(
                "type-invalid",
                "「type: string」のように 1 つ書くか、「- enum」の形で 1 行ずつ並べます"
            )
        );
        assert_eq!(
            pairs(r#"{"markdag":{"types":{"a":{"typo":"x"}}}}"#),
            one("type-invalid", "もしかして「type」")
        );
        assert_eq!(
            pairs(r#"{"markdag":{"tags":{"keys":{"a":{"multiple":"yes"}}}}}"#),
            one(
                "type-invalid",
                "true か false と書きます。yes は YAML では文字列になります"
            )
        );
        assert_eq!(
            pairs(r#"{"markdag":{"tags":{"lint":"warn"}}}"#),
            one("option-invalid", "warning か error と書きます")
        );
        assert_eq!(
            pairs(r#"{"markdag":{"tags":{"unknownKey":"denny"}}}"#),
            one("option-invalid", "もしかして「deny」")
        );
        assert_eq!(
            pairs(r#"{"markdag":{"types":{"$ref":3}}}"#),
            one(
                "option-invalid",
                "「$ref: ./types.yaml」のように文書からの相対パスを書くか、「- ./a.yaml」の形で 1 行ずつ並べます"
            )
        );
        let valid = r#"{"markdag":{"types":{"$ref":"./t.yaml","a":{"type":["string","number"],"min":1,"values":["x"],"pattern":"y"}},"tags":{"lint":"error","unknownKey":"deny","keys":{"a":{"type":"a","multiple":true,"unique":true,"description":"d"}}}}}"#;
        assert_eq!(pairs(valid), Vec::new());
    }

    // ---- 原文を node で動かして取った期待値 ----

    // (名前, frontmatter の JSON, 原文の markdown, 期待値の JSON)。期待値は原文の checkFrontmatter を vite-node で動かして取った (2026-09-24)
    const NODE_CASES: &[(&str, &str, Option<&str>, &str)] = &[
        (
            "enum_plain",
            r###"{"markdag":{"tags":{"display":"yes"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"yes\")","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "enum_near",
            r###"{"markdag":{"details":{"display":"hoverr"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.details.display に指定できるのは always, hover, click です (\"hoverr\")","at":null,"hint":"もしかして「hover」"}]"###,
        ),
        (
            "enum_number_value",
            r###"{"markdag":{"tags":{"lint":3}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.lint は文字列で書きます (3)","at":null,"hint":"warning か error と書きます"}]"###,
        ),
        (
            "type_number",
            r###"{"markmap":{"nodeMinHeight":"20"}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markmap.nodeMinHeight は数値で書きます (\"20\")","at":null,"hint":"高さを数値で書きます (既定は 16)"}]"###,
        ),
        (
            "type_number_infinity",
            r###"{"markmap":{"nodeMinHeight":{"$number":"Infinity"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markmap.nodeMinHeight は数値で書きます (null)","at":null,"hint":"高さを数値で書きます (既定は 16)"}]"###,
        ),
        (
            "type_integer",
            r###"{"markmap":{"colorFreezeLevel":1.5}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markmap.colorFreezeLevel は整数で書きます (1.5)","at":null,"hint":"色を固定する深さを整数で書きます (0 なら固定しません)"}]"###,
        ),
        (
            "type_boolean",
            r###"{"markmap":{"autoFit":"no"}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markmap.autoFit は真偽値で書きます (\"no\")","at":null,"hint":"true か false と書きます。yes は YAML では文字列になります"}]"###,
        ),
        (
            "type_array",
            r###"{"markdag":{"branches":"A"}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.branches は一覧で書きます (\"A\")","at":null,"hint":"branches: の下に、起点にするノードを「- 名前」の形で 1 行ずつ並べます"}]"###,
        ),
        (
            "type_object_markdag_array",
            r###"{"markdag":["A"]}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag はキーと値の組で書きます ([\"A\"])","at":null,"hint":"markdag: の下に relations, groups, tags, rules, hooks, tasks, details, legend, branches, edgeHighlight, groupHighlight を字下げして書きます"}]"###,
        ),
        (
            "type_object_groups_string",
            r###"{"markdag":{"groups":"abc"}}"###,
            None,
            r###"[{"severity":"warning","code":"group-invalid","message":"markdag.groups はキーと値の組で書きます (\"abc\")","at":null,"hint":"groups: の下にグループの名前を字下げして書き、さらにその下に label, color, boundary, members を書きます"}]"###,
        ),
        (
            "type_root_string",
            r###""abc""###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"frontmatter はキーと値の組で書きます (\"abc\")","at":null,"hint":null}]"###,
        ),
        (
            "type_root_array",
            r###"["a","b"]"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"frontmatter はキーと値の組で書きます ([\"a\",\"b\"])","at":null,"hint":null}]"###,
        ),
        (
            "unknown_near",
            r###"{"markdag":{"tags":{"displa":true}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-unknown","message":"markdag.tags のキー「displa」は使えません (display, lint, unknownKey, keys)","at":null,"hint":"もしかして「display」"}]"###,
        ),
        (
            "unknown_no_near",
            r###"{"markdag":{"tags":{"zzzzzzzz":1}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-unknown","message":"markdag.tags のキー「zzzzzzzz」は使えません (display, lint, unknownKey, keys)","at":null,"hint":"tags: の下に display, lint, unknownKey, keys を字下げして書きます"}]"###,
        ),
        (
            "unknown_markmap_aslist",
            r###"{"markmap":{"colorFreeze":2}}"###,
            None,
            r###"[{"severity":"warning","code":"option-unknown","message":"markmap のキー「colorFreeze」は使えません (autoFit, color, colorFreezeLevel, duration ほか)","at":null,"hint":"markmap: の下に、markmap のオプションを字下げして書きます"}]"###,
        ),
        (
            "unknown_root_near",
            r###"{"relation":{"fork":["A --> B"]},"Markdag":1}"###,
            None,
            r###"[{"severity":"warning","code":"option-unknown","message":"frontmatter のキー「relation」は、markdag が読むキー (markdag, markmap, title) のどれでもありません","at":null,"hint":"もしかして「relations」(markdag の下に書きます)"},{"severity":"warning","code":"option-unknown","message":"frontmatter のキー「Markdag」は、markdag が読むキー (markdag, markmap, title) のどれでもありません","at":null,"hint":"もしかして「markdag」"}]"###,
        ),
        (
            "to_string_under_tags",
            r###"{"markdag":{"tags":{"toString":1}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-unknown","message":"markdag.tags のキー「toString」は使えません (display, lint, unknownKey, keys)","at":null,"hint":"tags: の下に display, lint, unknownKey, keys を字下げして書きます"}]"###,
        ),
        (
            "oneof_array_branch",
            r###"{"markdag":{"legend":{"display":["groups","lines"]}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.legend.display[1] に指定できるのは groups, branches です (\"lines\")","at":null,"hint":"凡例に出せるのは groups と branches です"}]"###,
        ),
        (
            "oneof_no_branch",
            r###"{"markdag":{"legend":{"display":"all"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.legend.display には 真偽値、一覧 のどれかを書きます (\"all\")","at":null,"hint":"凡例を出さないなら false、項目を選ぶなら一覧で書きます"}]"###,
        ),
        (
            "oneof_types_ref",
            r###"{"markdag":{"types":{"$ref":3}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.types.$ref には 文字列、一覧 のどれかを書きます (3)","at":null,"hint":"「$ref: ./types.yaml」のように文書からの相対パスを書くか、「- ./a.yaml」の形で 1 行ずつ並べます"}]"###,
        ),
        (
            "oneof_types_ref_array",
            r###"{"markdag":{"types":{"$ref":["./a.yaml",""]}}}"###,
            None,
            r###"[{"severity":"warning","code":"type-invalid","message":"markdag.types.$ref[1] が空です","at":null,"hint":"「./types.yaml」のように、文書からの相対パスを文字列で書きます"}]"###,
        ),
        (
            "unique_objects_key_order",
            r###"{"markdag":{"branches":[{"a":1,"1":2},{"1":2,"a":1}]}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.branches[1] は前にも書かれています ({\"1\":2,\"a\":1})","at":null,"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[0] は文字列で書きます ({\"1\":2,\"a\":1})","at":null,"hint":"ノードの 1 行目の文字をそのまま書きます (装飾とタグは除いた文字)"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[1] は文字列で書きます ({\"1\":2,\"a\":1})","at":null,"hint":"ノードの 1 行目の文字をそのまま書きます (装飾とタグは除いた文字)"}]"###,
        ),
        (
            "unique_strings",
            r###"{"markdag":{"branches":["A","B","A","A"]}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.branches[2] は前にも書かれています (\"A\")","at":null,"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[3] は前にも書かれています (\"A\")","at":null,"hint":"同じ行が 2 回あります。重なった行は消せます"}]"###,
        ),
        (
            "unique_null_items",
            r###"{"markdag":{"branches":[null,null]}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.branches[1] は前にも書かれています (null)","at":null,"hint":"同じ行が 2 回あります。重なった行は消せます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[0] は文字列で書きます (null)","at":null,"hint":"ノードの 1 行目の文字をそのまま書きます (装飾とタグは除いた文字)"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[1] は文字列で書きます (null)","at":null,"hint":"ノードの 1 行目の文字をそのまま書きます (装飾とタグは除いた文字)"}]"###,
        ),
        (
            "min_length",
            r###"{"markdag":{"groups":{"a":{"label":""}}}}"###,
            None,
            r###"[{"severity":"warning","code":"group-invalid","message":"markdag.groups.a.label が空です","at":null,"hint":"凡例と枠に出す名前を文字列で書きます"}]"###,
        ),
        (
            "pattern_color",
            r###"{"markdag":{"groups":{"a":{"color":"まっか"}}}}"###,
            None,
            r###"[{"severity":"warning","code":"group-invalid","message":"markdag.groups.a.color は「グループの色。CSS の色として読める書き方 (#rgb, #rrggbb, #rrggbbaa, 色の名前, rgb() など)」の形で書きます (\"まっか\")","at":null,"hint":"「color: \"#3B7DD8\"」のように、CSS の色を引用符で囲んで書きます (空白の直後の # から行末は YAML のコメントになるので、引用符がないと色が消えます)"}]"###,
        ),
        (
            "pattern_relation",
            r###"{"markdag":{"relations":{"fork":["A -> B"]}}}"###,
            None,
            r###"[{"severity":"error","code":"relation-syntax","message":"markdag.relations.fork[0] は「半角の空白で挟んだ --> で項を結んだ式」の形で書きます (\"A -> B\")","at":null,"hint":"「A --> B」のように、半角の空白で挟んだ --> で結びます (空白の直後の # から行末は YAML のコメントになります)"}]"###,
        ),
        (
            "pattern_color_newline",
            r###"{"markdag":{"groups":{"a":{"color":"rgb(1,\n2)"}}}}"###,
            None,
            r###"[]"###,
        ),
        (
            "as_text_40",
            r###"{"markdag":{"tags":{"display":"abcdefghijabcdefghijabcdefghijabcdefghij"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"abcdefghijabcdefghijabcdefghijabcdefghi…)","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "as_text_41",
            r###"{"markdag":{"tags":{"display":"abcdefghijabcdefghijabcdefghijabcdefghijk"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"abcdefghijabcdefghijabcdefghijabcdefghi…)","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "as_text_emoji",
            r###"{"markdag":{"tags":{"display":"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…)","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "as_text_escape",
            r###"{"markdag":{"tags":{"display":"a\"b\nc\u0001"}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"a\\\"b\\nc\\u0001\")","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "as_text_object_keys",
            r###"{"markdag":{"tags":{"display":{"b":1,"2":1}}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display は文字列で書きます ({\"2\":1,\"b\":1})","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "as_text_small_number",
            r###"{"markdag":{"tags":{"display":0.0000001}}}"###,
            None,
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.tags.display は文字列で書きます (1e-7)","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "placement_misplaced",
            r###"{"markdag":{"fork":["A --> B"],"position":"top-left"}}"###,
            None,
            r###"[{"severity":"warning","code":"option-misplaced","message":"markdag のキー「fork」は、markdag.relations の下に書いてください。この位置では無視します","at":null,"hint":"relations: の行を作り、その下に字下げして fork: を書きます"},{"severity":"warning","code":"option-misplaced","message":"markdag のキー「position」は、markdag.legend の下に書いてください。この位置では無視します","at":null,"hint":"legend: の行を作り、その下に字下げして position: を書きます"}]"###,
        ),
        (
            "placement_root_misplaced",
            r###"{"fork":"A --> B","colorFreezeLevel":2,"relations":{}}"###,
            None,
            r###"[{"severity":"warning","code":"option-misplaced","message":"「fork」は frontmatter の markdag.relations の下に書いてください。この位置では無視します","at":null,"hint":"markdag: の下に relations: を作り、その下に字下げして fork: を書きます"},{"severity":"warning","code":"option-misplaced","message":"「colorFreezeLevel」は frontmatter の markmap の下に書いてください。この位置では無視します","at":null,"hint":"markmap: の行を作り、その下に字下げして colorFreezeLevel: を書きます"},{"severity":"warning","code":"option-misplaced","message":"「relations」は frontmatter の markdag の下に書いてください。この位置では無視します","at":null,"hint":"markdag: の行を作り、その下に字下げして relations: を書きます"}]"###,
        ),
        (
            "relation_keys",
            r###"{"markdag":{"relations":{"flow":["A --> B"],"fork":[3],"chain":"A -> B"}}}"###,
            None,
            r###"[{"severity":"warning","code":"relation-unknown-key","message":"markdag.relations のキー「flow」は使えません (fork, join, chain, depends)","at":null,"hint":"relations に書けるのは fork, join, chain, depends です"},{"severity":"error","code":"relation-not-string","message":"markdag.relations.fork[0] は文字列で書きます (3)","at":null,"hint":"「A --> B: C」のように「: 」を含む式は、行全体を \"…\" で囲みます"},{"severity":"error","code":"relation-syntax","message":"markdag.relations.chain は「半角の空白で挟んだ --> で項を結んだ式」の形で書きます (\"A -> B\")","at":null,"hint":"「A --> B」のように、半角の空白で挟んだ --> で結びます (空白の直後の # から行末は YAML のコメントになります)"}]"###,
        ),
        (
            "groups_many",
            r###"{"markdag":{"groups":{"a":{"colour":"#fff","member":["A"],"<<":{"color":"#fff"},"boundary":"yes","members":[3]}}}}"###,
            None,
            r###"[{"severity":"warning","code":"group-invalid","message":"markdag.groups.a のキー「colour」は使えません (label, color, boundary, members)","at":null,"hint":"もしかして「color」"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.a のキー「member」は使えません (label, color, boundary, members)","at":null,"hint":"もしかして「members」"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.a のキー「<<」は使えません (label, color, boundary, members)","at":null,"hint":"グループの名前の下に label, color, boundary, members を字下げして書きます"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.a.boundary は真偽値で書きます (\"yes\")","at":null,"hint":"true か false と書きます。yes は YAML では文字列になります"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.a.members[0] は文字列で書きます (3)","at":null,"hint":"ノードの 1 行目の文字をそのまま書きます (装飾とタグは除いた文字)"}]"###,
        ),
        (
            "tag_types",
            r###"{"markdag":{"types":{"a":{"type":3,"typo":"x"}},"tags":{"keys":{"a":{"multiple":"yes"}},"unknownKey":"denny"}}}"###,
            None,
            r###"[{"severity":"warning","code":"type-invalid","message":"markdag.types.a.type には 文字列、一覧 のどれかを書きます (3)","at":null,"hint":"「type: string」のように 1 つ書くか、「- enum」の形で 1 行ずつ並べます"},{"severity":"warning","code":"type-invalid","message":"markdag.types.a のキー「typo」は使えません (type, values, pattern, minLength, maxLength, min ほか)","at":null,"hint":"もしかして「type」"},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.a.multiple は真偽値で書きます (\"yes\")","at":null,"hint":"true か false と書きます。yes は YAML では文字列になります"},{"severity":"warning","code":"option-invalid","message":"markdag.tags.unknownKey に指定できるのは allow, deny です (\"denny\")","at":null,"hint":"もしかして「deny」"}]"###,
        ),
        (
            "at_value_and_items",
            r###"{"markdag":{"details":"always","branches":["A","A"]}}"###,
            Some(
                "---\nmarkdag:\n    details: always\n    branches:\n        - A\n        - A\n---\n\n# root",
            ),
            r###"[{"severity":"warning","code":"option-invalid","message":"markdag.details はキーと値の組で書きます (\"always\")","at":{"line":3,"column":14,"length":6},"hint":"details: の下に display を字下げして書きます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches[1] は前にも書かれています (\"A\")","at":{"line":6,"column":11,"length":1},"hint":"同じ行が 2 回あります。重なった行は消せます"}]"###,
        ),
        (
            "at_unknown_key_and_misplaced",
            r###"{"markdag":{"tags":{"displa":true},"fork":["A --> B"]},"relation":1}"###,
            Some(
                "---\nrelation: 1\nmarkdag:\n    tags:\n        displa: true\n    fork:\n        - A --> B\n---\n\n# root",
            ),
            r###"[{"severity":"warning","code":"option-unknown","message":"frontmatter のキー「relation」は、markdag が読むキー (markdag, markmap, title) のどれでもありません","at":{"line":2,"column":1,"length":8},"hint":"もしかして「relations」(markdag の下に書きます)"},{"severity":"warning","code":"option-unknown","message":"markdag.tags のキー「displa」は使えません (display, lint, unknownKey, keys)","at":{"line":5,"column":9,"length":6},"hint":"もしかして「display」"},{"severity":"warning","code":"option-misplaced","message":"markdag のキー「fork」は、markdag.relations の下に書いてください。この位置では無視します","at":{"line":6,"column":5,"length":4},"hint":"relations: の行を作り、その下に字下げして fork: を書きます"}]"###,
        ),
        (
            "at_sorted_missing_last",
            r###"{"markdag":{"tags":{"display":"yes"},"branches":"A"},"colorFreezeLevel":2}"###,
            Some("---\ncolorFreezeLevel: 2\nmarkdag:\n    branches: A\n---\n\n# root"),
            r###"[{"severity":"warning","code":"option-misplaced","message":"「colorFreezeLevel」は frontmatter の markmap の下に書いてください。この位置では無視します","at":{"line":2,"column":1,"length":16},"hint":"markmap: の行を作り、その下に字下げして colorFreezeLevel: を書きます"},{"severity":"warning","code":"option-invalid","message":"markdag.branches は一覧で書きます (\"A\")","at":{"line":4,"column":15,"length":1},"hint":"branches: の下に、起点にするノードを「- 名前」の形で 1 行ずつ並べます"},{"severity":"warning","code":"option-invalid","message":"markdag.tags.display に指定できるのは always, hover, click, never です (\"yes\")","at":null,"hint":"always, hover, click, never のどれかを書きます"}]"###,
        ),
        (
            "at_multibyte_column",
            r###"{"markdag":{"groups":{"設計":{"color":"まっか","label":""}}}}"###,
            Some(
                "---\nmarkdag:\n    groups:\n        設計: { label: \"\", color: まっか }\n---\n\n# root",
            ),
            r###"[{"severity":"warning","code":"group-invalid","message":"markdag.groups.設計.label が空です","at":{"line":4,"column":22,"length":2},"hint":"凡例と枠に出す名前を文字列で書きます"},{"severity":"warning","code":"group-invalid","message":"markdag.groups.設計.color は「グループの色。CSS の色として読める書き方 (#rgb, #rrggbb, #rrggbbaa, 色の名前, rgb() など)」の形で書きます (\"まっか\")","at":{"line":4,"column":33,"length":3},"hint":"「color: \"#3B7DD8\"」のように、CSS の色を引用符で囲んで書きます (空白の直後の # から行末は YAML のコメントになるので、引用符がないと色が消えます)"}]"###,
        ),
    ];

    #[test]
    fn schema_node_cases_match_original() {
        for (name, json, markdown, expected) in NODE_CASES {
            let got =
                serde_json::to_value(check_frontmatter(&js(json), *markdown)).expect("診断の JSON");
            let expected: serde_json::Value =
                serde_json::from_str(expected).expect("期待値の JSON");
            assert_eq!(got, expected, "{name}");
        }
    }

    #[test]
    fn schema_node_undefined_value_has_no_shown_text() {
        let frontmatter = JsValue::Object(IndexMap::from([(
            "markmap".to_string(),
            JsValue::Object(IndexMap::from([
                ("initialExpandLevel".to_string(), JsValue::Undefined),
                ("color".to_string(), JsValue::Undefined),
            ])),
        )]));
        let got = serde_json::to_value(check_frontmatter(&frontmatter, None)).expect("診断の JSON");
        let expected: serde_json::Value = serde_json::from_str(r###"[{"severity":"warning","code":"option-invalid","message":"markmap.initialExpandLevel は整数で書きます","at":null,"hint":"深さを整数で書きます (すべて開くなら -1)"},{"severity":"warning","code":"option-invalid","message":"markmap.color には 文字列、一覧 のどれかを書きます","at":null,"hint":"色を 1 つ書くか、「- \"#2980b9\"」の形で 1 行ずつ並べます"}]"###).expect("期待値の JSON");
        assert_eq!(got, expected);
    }

    // accepted.md の 7 (A-027): 旧実装は `__proto__` を Object.prototype (空のスキーマ) として通し、診断を出さない。
    // Rust は他の知らないキーと同じく扱う。期待値は旧実装で `__zzzzz__` と書いたときの出力の名前を置き換えたもの
    #[test]
    fn schema_proto_key_is_unknown_accepted_difference() {
        let markdown = ["---", "markdag:", "    __proto__: 1", "---", "", "# root"].join("\n");
        let got = check_frontmatter(&js(r#"{"markdag":{"__proto__":{"x":1}}}"#), Some(&markdown));
        assert_eq!(
            got,
            vec![Diagnostic {
                severity: Severity::Warning,
                code: "option-unknown".to_string(),
                message: "markdag のキー「__proto__」は使えません (relations, groups, types, tags, rules, hooks ほか)".to_string(),
                at: Some(SourcePosition { line: 3, column: 5, length: 9 }),
                hint: some("markdag: の下に relations, groups, tags, rules, hooks, tasks, details, legend, branches, edgeHighlight, groupHighlight を字下げして書きます"),
            }]
        );
        let got = check_frontmatter(&js(r#"{"markdag":{"tags":{"__proto__":1}}}"#), None);
        assert_eq!(
            got,
            vec![Diagnostic {
                severity: Severity::Warning,
                code: "option-unknown".to_string(),
                message:
                    "markdag.tags のキー「__proto__」は使えません (display, lint, unknownKey, keys)"
                        .to_string(),
                at: None,
                hint: some("tags: の下に display, lint, unknownKey, keys を字下げして書きます"),
            }]
        );
        // 最上位は閉じていないので、近い名前がなければ旧実装と同じく何も言わない (旧実装は `in` で飛ばす)
        assert_eq!(
            check_frontmatter(&js(r#"{"__proto__":1,"toString":1,"constructor":2}"#), None),
            Vec::new()
        );
    }

    // accepted.md の 7 の続き (A-094): additionalProperties がスキーマの位置では `__proto__` はふつうの名前として検査され、
    // additionalProperties: false の位置の code はその部分スキーマの x-code (option-unknown になるのは x-code のない位置だけ)
    #[test]
    fn schema_proto_key_takes_code_of_its_place() {
        assert_eq!(
            check_frontmatter(
                &js(r#"{"markdag":{"groups":{"__proto__":{"label":"a"}}}}"#),
                None
            ),
            Vec::new()
        );
        assert_eq!(
            codes(r#"{"markdag":{"groups":{"__proto__":1}}}"#),
            vec!["group-invalid"]
        );
        assert_eq!(
            codes(r#"{"markdag":{"types":{"__proto__":1}}}"#),
            vec!["type-invalid"]
        );
        let got = first(r#"{"markdag":{"relations":{"__proto__":{"a":1}}}}"#);
        assert_eq!(got.code, "relation-unknown-key");
        assert_eq!(
            got.message,
            "markdag.relations のキー「__proto__」は使えません (fork, join, chain, depends)"
        );
        assert_eq!(
            got.hint,
            some("relations に書けるのは fork, join, chain, depends です")
        );
        assert_eq!(
            codes(r#"{"markdag":{"groups":{"k1":{"__proto__":1}}}}"#),
            vec!["group-invalid"]
        );
    }

    // 原文は frontmatter が null だと Object.keys で TypeError を投げる (schema_diagnostics の印の箇所)。Rust は型の診断 1 件だけを返す
    #[test]
    fn schema_null_frontmatter_reports_type_only() {
        let got = check_frontmatter(&JsValue::Null, None);
        assert_eq!(got.len(), 1);
        assert_eq!(
            got.first().map(|item| item.message.as_str()),
            Some("frontmatter はキーと値の組で書きます (null)")
        );
    }

    #[test]
    fn schema_as_text_and_as_list() {
        assert_eq!(
            as_text(&JsValue::String("a".repeat(38))),
            format!("\"{}\"", "a".repeat(38))
        );
        assert_eq!(
            as_text(&JsValue::String("a".repeat(39))),
            format!("\"{}…", "a".repeat(39))
        );
        assert_eq!(as_text(&JsValue::Undefined), "undefined");
        assert_eq!(as_text(&JsValue::Number(f64::NAN)), "null");
        let names = |list: &[&str]| {
            list.iter()
                .map(|name| name.to_string())
                .collect::<Vec<String>>()
        };
        // 前の名前 (落ちた名前も含む) の連結の長さで測るので、48 を越えた名前のあとは短い名前も落ちる
        let long = "x".repeat(40);
        assert_eq!(
            as_list(&names(&["abc", &long, "de"])),
            format!("abc, {long}, de")
        );
        let longer = "x".repeat(50);
        assert_eq!(as_list(&names(&["abc", &longer, "de"])), "abc ほか");
        assert_eq!(as_list(&names(&["a", "b"])), "a, b");
        // 長さは UTF-16 の単位 (サロゲートの組は 2)
        let emoji = "😀".repeat(24);
        assert_eq!(as_list(&names(&[&emoji])), emoji);
        assert_eq!(as_list(&names(&[&format!("{emoji}a")])), " ほか");
    }

    #[test]
    fn schema_lazy_locks_are_touched() {
        assert!(SCHEMA.contains_key("$defs"));
        // pattern は 2.4 の文字クラスの書き換えを通さないので、書き換える字を含まないことを守る (A-088)
        let mut keys: Vec<&str> = SCHEMA_PATTERNS.keys().map(String::as_str).collect();
        keys.sort_unstable();
        // 1 つ目の \t は JSON の中の書き方なので、読んだ値ではタブ 1 字
        assert_eq!(
            keys,
            vec![
                "[ \t]+-->[ \t]+",
                r"^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]+|[a-zA-Z-]+\([^)]*\))$"
            ]
        );
        for key in keys {
            for rewritten in [r"\d", r"\s", r"\w", ".", r"[\s\S]"] {
                assert!(!key.contains(rewritten), "{key} に {rewritten}");
            }
        }
    }
}

// PORT STATUS: confidence=medium todos=1

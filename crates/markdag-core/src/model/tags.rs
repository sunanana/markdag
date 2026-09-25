// 原文: src/model/tags.ts (2026-09-24)
// タグの型と検査 (linter)。frontmatter の markdag.types (名前付きの型) と markdag.tags.keys (キーごとの定義) を、
// キーごとに「基底の型 + 重ねた制約」の平らな形に解決し、本文のタグをそれに当てて診断の元 (issue) を出す。
// 入力は JSON で表せる値だけにし、frontmatter の中の位置は呼び出し側が path から引く。
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::model::util::{
    JS_WHITESPACE, JsValue, closest, js_date_parts, js_date_utc, js_max, js_min, js_number,
    js_number_of_group, js_number_to_string, js_path_join, js_regexp_u, js_slice, js_to_string,
    unique_in_order,
};
use crate::types::{
    NodeTag, NumberOrString, OutlineNode, PathStep, Primitive, ResolvedTagKeys, Severity,
    SourcePath, SourcePosition, TagIssue, TagKeyDef, TagKeySuggestion, TagLintSeverity,
    TagLintUnknownKey, TagValueType,
};

// 規則 2.6: `as const` の配列は enum の配列 (types.rs の ALL が原文の順)
pub const PRIMITIVES: &[Primitive] = Primitive::ALL;

/// 型の定義の出どころ 1 つ (原文の TypeSource)。文書の frontmatter なら path があり、$ref で読んだファイルなら path は null で label がファイル名
// 規則 4 章 (A-037): 原文のモジュールが export する型で共有の型の一覧にないものは写し先のモジュールに置く
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSource {
    pub label: String,
    /// 台帳: Record<string, unknown> は書かれた順の JsValue の写像 (決定 8)
    pub defs: IndexMap<String, JsValue>,
    pub path: Option<SourcePath>,
}

// 規則 2.4: 内部の固定の正規表現は regex。\d は [0-9]、^ と $ は m フラグなしで同じ
// 台帳: NUMBER / INTEGER / DATE / DATETIME / TIME / DURATION / NODE_ID は \d を [0-9] に書き換えて写す (先読みなし)。[T ] はそのまま
// 規則 1 章 (A-021): 定数の正規表現は LazyLock と expect
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?[0-9]+(?:\.[0-9]+)?$").expect("固定の正規表現"));
static INTEGER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?[0-9]+$").expect("固定の正規表現"));
static DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$").expect("固定の正規表現"));
static DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(Z|[+-][0-9]{2}:[0-9]{2})?$")
        .expect("固定の正規表現")
});
static TIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$").expect("固定の正規表現")
});
static DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+(?:\.[0-9]+)?)([mhdw])$").expect("固定の正規表現"));
static NODE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\$[A-Za-z][A-Za-z0-9_-]*$").expect("固定の正規表現"));
// 原文の `Record<string, number>` を、文字で引く組の一覧にした (引けなければ None で `?? 1` に落ちる)
// キーが文字で値が数の内部の定数は、文字で引く組の一覧に写す (規則 2.1、A-054、A-071)
const DURATION_MINUTES: &[(&str, f64)] = &[("m", 1.0), ("h", 60.0), ("d", 1440.0), ("w", 10080.0)];

// 制約ごとに、それが効く基底の型
// 台帳: CONSTRAINT_TARGETS は const の配列で順を固定 (values → pattern → minLength → maxLength → min → max)
const CONSTRAINT_TARGETS: &[(&str, &[Primitive])] = &[
    ("values", &[Primitive::Enum]),
    ("pattern", &[Primitive::String]),
    ("minLength", &[Primitive::String]),
    ("maxLength", &[Primitive::String]),
    (
        "min",
        &[
            Primitive::Number,
            Primitive::Integer,
            Primitive::Date,
            Primitive::Datetime,
            Primitive::Time,
            Primitive::Duration,
        ],
    ),
    (
        "max",
        &[
            Primitive::Number,
            Primitive::Integer,
            Primitive::Date,
            Primitive::Datetime,
            Primitive::Time,
            Primitive::Duration,
        ],
    ),
];

// 原文: isPrimitive
// 規則 2.6 (A-022): 型の述語は is_x(&JsValue) -> Option (真なら変換した値)。`includes(v as X)` は from_js で写す
fn is_primitive(name: &JsValue) -> Option<Primitive> {
    Primitive::from_js(name)
}

// 原文: validDate
// 規則 2.8: Date.UTC で作って getUTCFullYear などと突き合わせる形は js_date_utc と js_date_parts の往復で写す
// BUG(port): 年 0000〜0099 は Date.UTC が 1900 を足すので、正しい日付 (#due:0099-01-01) も偽になる (審判の edge-tags-all-types)
fn valid_date(year: f64, month: f64, day: f64) -> bool {
    let date = js_date_utc(year, month - 1.0, day, 0.0, 0.0, 0.0);
    // Invalid Date の getUTC* は NaN なので、どの比較も偽になる
    match js_date_parts(date) {
        None => false,
        Some((full_year, month0, date_of_month)) => {
            full_year as f64 == year
                && f64::from(month0) == month - 1.0
                && f64::from(date_of_month) == day
        }
    }
}

// 原文: wellFormed
// 値がその型の書き方に合っているか (範囲と enum の候補は見ない)
fn well_formed(primitive: Primitive, value: &str) -> bool {
    match primitive {
        Primitive::String | Primitive::Enum => true,
        // 規則 2.1: Number.isFinite(Number(value)) は js_number(value).is_finite()
        Primitive::Number => NUMBER.is_match(value) && js_number(value).is_finite(),
        Primitive::Integer => INTEGER.is_match(value),
        // 台帳: value === 'true' || value === 'false' は matches!
        Primitive::Boolean => matches!(value, "true" | "false"),
        Primitive::Date => match DATE.captures(value) {
            None => false,
            Some(found) => valid_date(
                js_number_of_group(found.get(1)),
                js_number_of_group(found.get(2)),
                js_number_of_group(found.get(3)),
            ),
        },
        Primitive::Datetime => {
            let Some(found) = DATETIME.captures(value) else {
                return false;
            };
            let (hour, minute, second) = (
                js_number_of_group(found.get(4)),
                js_number_of_group(found.get(5)),
                found
                    .get(6)
                    .map_or(0.0, |second| js_number(second.as_str())),
            );
            let zone = found.get(7).map_or("Z", |zone| zone.as_str());
            // 台帳: zone は [+-]\d{2}:\d{2} なので split は常に 2 要素で、?? 0 には届かない (unwrap_or で写す。A-016)
            let zone_parts: Vec<f64> = if zone == "Z" {
                vec![0.0, 0.0]
            } else {
                // 規則 2.2: s.slice(a, b) は js_slice
                js_slice(zone, 1, zone.len())
                    .split(':')
                    .map(js_number)
                    .collect()
            };
            let zone_hour = zone_parts.first().copied();
            let zone_minute = zone_parts.get(1).copied();
            valid_date(
                js_number_of_group(found.get(1)),
                js_number_of_group(found.get(2)),
                js_number_of_group(found.get(3)),
            ) && hour < 24.0
                && minute < 60.0
                && second < 60.0
                && zone_hour.unwrap_or(0.0) < 24.0
                && zone_minute.unwrap_or(0.0) < 60.0
        }
        Primitive::Time => match TIME.captures(value) {
            None => false,
            Some(found) => {
                js_number_of_group(found.get(1)) < 24.0
                    && js_number_of_group(found.get(2)) < 60.0
                    && found
                        .get(3)
                        .map_or(0.0, |second| js_number(second.as_str()))
                        < 60.0
            }
        },
        Primitive::Duration => DURATION.is_match(value),
        Primitive::NodeId => NODE_ID.is_match(value),
    }
}

// 原文: ordinal
// 範囲の比較に使う数。書き方に合っていない値では None
// 台帳: fn ordinal(primitive, value: &NumberOrString) -> Option<f64>
fn ordinal(primitive: Primitive, value: &NumberOrString) -> Option<f64> {
    let value = match value {
        NumberOrString::Number(number) => {
            return if primitive == Primitive::Number || primitive == Primitive::Integer {
                Some(*number)
            } else {
                None
            };
        }
        NumberOrString::String(text) => text.as_str(),
    };
    if !well_formed(primitive, value) {
        return None;
    }
    match primitive {
        Primitive::Number | Primitive::Integer => Some(js_number(value)),
        Primitive::Date => {
            let found = DATE.captures(value)?;
            // 規則 2.8: Date.UTC は js_date_utc (月は 0 始まり)
            Some(js_date_utc(
                js_number_of_group(found.get(1)),
                js_number_of_group(found.get(2)) - 1.0,
                js_number_of_group(found.get(3)),
                0.0,
                0.0,
                0.0,
            ))
        }
        Primitive::Datetime => {
            let found = DATETIME.captures(value)?;
            let base = js_date_utc(
                js_number_of_group(found.get(1)),
                js_number_of_group(found.get(2)) - 1.0,
                js_number_of_group(found.get(3)),
                js_number_of_group(found.get(4)),
                js_number_of_group(found.get(5)),
                found
                    .get(6)
                    .map_or(0.0, |second| js_number(second.as_str())),
            );
            // 台帳: match[7] は Option で None か "Z" なら base
            let zone = match found.get(7) {
                None => return Some(base),
                Some(zone) if zone.as_str().is_empty() || zone.as_str() == "Z" => {
                    return Some(base);
                }
                Some(zone) => zone.as_str(),
            };
            // 規則 2.2: s.slice(a, b) は js_slice
            let parts: Vec<f64> = js_slice(zone, 1, zone.len())
                .split(':')
                .map(js_number)
                .collect();
            // 規則 2.5 (A-016、A-031): 分割代入の既定値の不到達は unwrap_or で印なし
            let hour = parts.first().copied().unwrap_or(0.0);
            let minute = parts.get(1).copied().unwrap_or(0.0);
            let sign = if zone.starts_with('-') { -1.0 } else { 1.0 };
            // 規則 2.1 (A-014): 原文の左から右の結合のまま
            Some(base - sign * (hour * 60.0 + minute) * 60000.0)
        }
        Primitive::Time => {
            let found = TIME.captures(value)?;
            Some(
                js_number_of_group(found.get(1)) * 3600.0
                    + js_number_of_group(found.get(2)) * 60.0
                    + found
                        .get(3)
                        .map_or(0.0, |second| js_number(second.as_str())),
            )
        }
        Primitive::Duration => {
            let found = DURATION.captures(value)?;
            // 台帳: [mhdw] は必ず捕まるので ?? 'm' と ?? 1 には届かない (unwrap_or で写す。A-016)
            let unit = found.get(2).map_or("m", |unit| unit.as_str());
            let minutes = DURATION_MINUTES
                .iter()
                .find(|(name, _)| *name == unit)
                .map(|(_, minutes)| *minutes);
            Some(js_number_of_group(found.get(1)) * minutes.unwrap_or(1.0))
        }
        Primitive::String | Primitive::Boolean | Primitive::Enum | Primitive::NodeId => None,
    }
}

// 原文の定数 FORMS (`Record<Primitive, string>`)。型の書き方の説明 (診断の文面に使う)。
// キーが enum の写像なので、キーの取りこぼしをコンパイラが見る網羅の match の関数にした (名前は定数名の snake_case)
// 内部の定数の Record は網羅の match の private fn に写し、名前は定数名の snake_case にする (規則 2.1、A-054、A-071)
fn forms(primitive: Primitive) -> &'static str {
    match primitive {
        Primitive::String => "文字列",
        Primitive::Number => "数値",
        Primitive::Integer => "整数",
        Primitive::Boolean => "true か false のどちらか",
        Primitive::Enum => "決まった値",
        Primitive::Date => "YYYY-MM-DD の日付",
        Primitive::Datetime => "YYYY-MM-DDTHH:MM の日時 (秒と時差は任意)",
        Primitive::Time => "HH:MM の時刻",
        Primitive::Duration => "30m / 2h / 3d / 1w のような期間",
        Primitive::NodeId => "$名前 (行末に $名前 を付けたノード)",
    }
}

// 原文: describe
// 型の説明 (lintTags の文面に使う)
fn describe(value_type: &TagValueType) -> String {
    if value_type.primitive == Primitive::Enum {
        return format!(
            "{} のどれか",
            value_type.values.clone().unwrap_or_default().join(" / ")
        );
    }
    let mut limits: Vec<String> = Vec::new();
    // 規則 2.1: 配列は空でも真なので is_some だけを見る
    if let Some(patterns) = &value_type.patterns {
        limits.push(format!(
            "{} に合う",
            patterns
                .iter()
                .map(|pattern| format!("「{pattern}」"))
                .collect::<Vec<String>>()
                .join(" と ")
        ));
    }
    // 台帳: minLength / maxLength は f64 (NaN もありうる) なので js_number_to_string、min / max は js_to_string
    if let Some(min_length) = value_type.min_length {
        limits.push(format!("{} 文字以上", js_number_to_string(min_length)));
    }
    if let Some(max_length) = value_type.max_length {
        limits.push(format!("{} 文字以下", js_number_to_string(max_length)));
    }
    if let Some(min) = &value_type.min {
        limits.push(format!("{} 以上", js_to_string(&JsValue::from(min))));
    }
    if let Some(max) = &value_type.max {
        limits.push(format!("{} 以下", js_to_string(&JsValue::from(max))));
    }
    if limits.is_empty() {
        forms(value_type.primitive).to_string()
    } else {
        format!("{} ({})", forms(value_type.primitive), limits.join("、"))
    }
}

// 規則 2.4: \s は JS_WHITESPACE の文字クラス (全角空白 U+3000 と NBSP を含み、U+0085 を含まない)
// 台帳: formatTag の /[\s,"]/ は固定の regex
static NEEDS_QUOTE: LazyLock<Regex> = LazyLock::new(|| {
    let whitespace: String = JS_WHITESPACE
        .iter()
        .map(|c| regex::escape(&c.to_string()))
        .collect();
    Regex::new(&format!("[{whitespace},\"]")).expect("固定の正規表現")
});

/// 原文: formatTag
/// タグを本文に書いた形に戻す。空白や , を含む値は " で囲む
// 規則 2.6 (A-031): Pick<NodeTag, 'key' | 'values'> は、呼び手 (lintTags) が NodeTag 全体を持つので &NodeTag で受ける
pub fn format_tag(tag: &NodeTag) -> String {
    if tag.values.is_empty() {
        return format!("#{}", tag.key);
    }
    let values: Vec<String> = tag
        .values
        .iter()
        .map(|value| {
            if NEEDS_QUOTE.is_match(value) {
                format!("\"{value}\"")
            } else {
                value.clone()
            }
        })
        .collect();
    format!("#{}:{}", tag.key, values.join(","))
}

// 原文の NamedType
// 原文で export しない interface なので private の struct にし、境界に出ないので Serialize / Deserialize は付けない (規則 2.6、A-077)
struct NamedType {
    def: IndexMap<String, JsValue>,
    path: Option<SourcePath>,
    label: String,
}

// 原文の Place。定義の置き場所 1 つ (名前付きの型か、キーのインラインの定義)
// 原文で export しない interface なので private の struct にし、境界に出ないので Serialize / Deserialize は付けない (規則 2.6、A-077)
struct Place {
    path: Option<SourcePath>,
    label: String,
}

// path に 1 段足した写し (`[...path, key]`。原文の 6 か所)
// 何度も出る同じ式を private の関数 1 つにまとめる (規則 2.6、A-072)
fn with_step(path: &[PathStep], key: &str) -> SourcePath {
    let mut next = path.to_vec();
    next.push(PathStep::Key(key.to_string()));
    next
}

// 原文: resolveTagKeys の中の warn
// 規則 2.6 (A-040): issues を捕まえる閉包は、resolveSpec / applyConstraints と同時に issues を書き換えるので、issues を引数にした関数にした
fn warn(
    issues: &mut Vec<TagIssue>,
    code: &str,
    message: String,
    hint: Option<String>,
    path: Option<SourcePath>,
) {
    issues.push(TagIssue {
        severity: Severity::Warning,
        code: code.to_string(),
        message,
        hint,
        path,
        at: None,
    });
}

/// 原文: resolveTagKeys
/// frontmatter の types と tags.keys を、キーごとの平らな定義に解決する。
/// refs_unresolved は、$ref を読めなかったときに真にする。読めなかったファイルがどの名前を上書きするか分からないので、
/// 名前で指した型は (知っている名前でも) 黙って捨て、そのキーは検査しない。組み込みの型を直接書いたキーは検査する
pub fn resolve_tag_keys(
    sources: &[TypeSource],
    raw_keys: &IndexMap<String, JsValue>,
    keys_path: &[PathStep],
    refs_unresolved: bool,
) -> ResolvedTagKeys {
    let mut issues: Vec<TagIssue> = Vec::new();

    // 出どころの順に重ねる。あとの出どころが同じ名前を上書きする
    // 台帳: named は IndexMap。insert は既存のキーの位置を変えない (JS の Map.set と同じ)。defs は書かれた順に回す (決定 8)
    let mut named: IndexMap<String, NamedType> = IndexMap::new();
    for source in sources {
        for (name, raw) in &source.defs {
            // 規則 2.1: 配列は空でも真 (source.path ? … は is_some だけ)
            let path = source
                .path
                .as_ref()
                .map(|source_path| with_step(source_path, name));
            let label = match &path {
                Some(path) => js_path_join(path),
                None => format!("{} の {}", source.label, name),
            };
            if name == "$ref" {
                // 参照は文書の frontmatter にだけ書ける。読んだファイルの中の $ref は追わない
                if source.path.is_none() {
                    warn(
                        &mut issues,
                        "type-invalid",
                        format!(
                            "{} の中の $ref は読みません (参照は文書の frontmatter にだけ書けます)",
                            source.label
                        ),
                        Some("ファイルには型の定義だけを書きます".to_string()),
                        None,
                    );
                }
                continue;
            }
            if is_primitive(&JsValue::String(name.clone())).is_some() {
                warn(
                    &mut issues,
                    "type-reserved",
                    format!("{label} は組み込みの型と同じ名前なので定義できません"),
                    Some("別の名前にします".to_string()),
                    path,
                );
                continue;
            }
            // 規則 2.1: isRecord は JsValue::Object の match (Array は record でない)
            let JsValue::Object(def) = raw else {
                // 文書の中の形の誤りはスキーマが知らせている。ファイルの中のものは、ここでしか気づけない
                if source.path.is_none() {
                    warn(
                        &mut issues,
                        "type-invalid",
                        format!("{label} は、type と制約をキーと値の組で書きます"),
                        None,
                        None,
                    );
                }
                continue;
            };
            named.insert(
                name.clone(),
                NamedType {
                    def: def.clone(),
                    path,
                    label,
                },
            );
        }
    }

    let mut keys: Vec<TagKeyDef> = Vec::new();
    // 台帳: rawKeys は JsValue::Object を書かれた順に (決定 8。数字だけのキーも書かれた位置)
    for (key, raw) in raw_keys {
        let empty = IndexMap::new();
        let def = match raw {
            JsValue::Object(def) => def,
            _ => &empty,
        };
        let place_path = with_step(keys_path, key);
        let place = Place {
            label: js_path_join(&place_path),
            path: Some(place_path),
        };
        let resolved = resolve_spec(
            def.get("type"),
            &[],
            &place,
            &named,
            refs_unresolved,
            &mut issues,
        );
        // 台帳: filter の中の warn は filter の評価の順 (alternatives の順) で issues に入る
        let alternatives: Vec<TagValueType> = apply_constraints(def, resolved, &place, &mut issues)
            .into_iter()
            .filter(|value_type| {
                if value_type.primitive != Primitive::Enum
                    || value_type
                        .values
                        .as_ref()
                        .is_some_and(|values| !values.is_empty())
                {
                    return true;
                }
                // 台帳: place.path は常に Some なので ?? [] には届かない (unwrap_or_default で写す。A-016)
                warn(
                    &mut issues,
                    "type-invalid",
                    format!(
                        "{} は enum なので values (許す値の一覧) が要ります",
                        place.label
                    ),
                    Some("values: の下に、許す値を「- high」の形で 1 行ずつ並べます".to_string()),
                    Some(with_step(&place.path.clone().unwrap_or_default(), "values")),
                );
                false
            })
            .collect();
        keys.push(TagKeyDef {
            key: key.clone(),
            alternatives,
            // 台帳: === true は JsValue::Bool(true) だけ (文字列 "true" は false)
            multiple: def.get("multiple") == Some(&JsValue::Bool(true)),
            unique: def.get("unique") == Some(&JsValue::Bool(true)),
            description: match def.get("description") {
                Some(JsValue::String(description)) => Some(description.clone()),
                _ => None,
            },
        });
    }
    ResolvedTagKeys { keys, issues }
}

// 原文: resolveTagKeys の中の resolveSpec
// 型の指定 (名前 1 つか一覧) を、基底の型と制約の一覧に解決する。chain は自分に戻る参照を見つけるため
// 規則 2.6 (A-040): applyConstraints と互いに呼び合い issues を書き換える閉包なので、捕まえていた named、refsUnresolved、issues を引数にした関数にした
fn resolve_spec(
    spec: Option<&JsValue>,
    chain: &[String],
    place: &Place,
    named: &IndexMap<String, NamedType>,
    refs_unresolved: bool,
    issues: &mut Vec<TagIssue>,
) -> Vec<TagValueType> {
    // 台帳: def.get("type") が None か Null なら ["string"] (undefined と null をここでは同じに扱う)
    let default_names = [JsValue::String("string".to_string())];
    let names: &[JsValue] = match spec {
        None | Some(JsValue::Undefined) | Some(JsValue::Null) => &default_names,
        Some(JsValue::Array(items)) => items,
        Some(other) => std::slice::from_ref(other),
    };
    let mut alternatives: Vec<TagValueType> = Vec::new();
    for raw_name in names {
        let JsValue::String(name) = raw_name else {
            if place.path.is_none() {
                warn(
                    issues,
                    "type-invalid",
                    format!("{} の type は型の名前を文字列で書きます", place.label),
                    None,
                    None,
                );
            }
            continue;
        };
        if let Some(primitive) = is_primitive(raw_name) {
            alternatives.push(TagValueType {
                primitive,
                values: None,
                patterns: None,
                min_length: None,
                max_length: None,
                min: None,
                max: None,
            });
            continue;
        }
        if refs_unresolved {
            continue;
        }
        let Some(found) = named.get(name) else {
            // 台帳: 候補の並びは PRIMITIVES の順 + named の挿入順 (closest は同点なら先勝ち)
            let candidates: Vec<&str> = PRIMITIVES
                .iter()
                .map(|primitive| primitive.as_str())
                .chain(named.keys().map(String::as_str))
                .collect();
            let near = closest(name, &candidates);
            let hint = match near {
                None => format!(
                    "組み込みの型は {} です",
                    PRIMITIVES
                        .iter()
                        .map(|primitive| primitive.as_str())
                        .collect::<Vec<&str>>()
                        .join(", ")
                ),
                Some(near) => format!("もしかして「{near}」"),
            };
            warn(
                issues,
                "type-unknown",
                format!(
                    "{} の型「{}」は、組み込みの型にも markdag.types にもありません",
                    place.label, name
                ),
                Some(hint),
                place.path.as_ref().map(|path| with_step(path, "type")),
            );
            continue;
        };
        if chain.contains(name) {
            let cycle: Vec<&str> = chain
                .iter()
                .map(String::as_str)
                .chain([name.as_str()])
                .collect();
            warn(
                issues,
                "type-cycle",
                format!(
                    "型「{}」の定義が自分自身に戻っています ({})",
                    name,
                    cycle.join(" → ")
                ),
                Some("型の type には、自分より基底の型を書きます".to_string()),
                found.path.as_ref().map(|path| with_step(path, "type")),
            );
            continue;
        }
        // 台帳: chain は Vec<String> を clone して伸ばす。警告は再帰の深さ優先で issues に push
        let mut next_chain = chain.to_vec();
        next_chain.push(name.clone());
        // 原文は found (NamedType) をそのまま Place として渡す
        let found_place = Place {
            path: found.path.clone(),
            label: found.label.clone(),
        };
        let base = resolve_spec(
            found.def.get("type"),
            &next_chain,
            &found_place,
            named,
            refs_unresolved,
            issues,
        );
        alternatives.extend(apply_constraints(&found.def, base, &found_place, issues));
    }
    alternatives
}

// 原文: resolveTagKeys の中の applyConstraints
// 定義に書かれた制約を、それが効く型に重ねる。効く型が 1 つもなければ知らせて捨てる
// 規則 2.6 (A-040): resolveSpec と同じく issues を引数にした関数にした
fn apply_constraints(
    def: &IndexMap<String, JsValue>,
    base: Vec<TagValueType>,
    place: &Place,
    issues: &mut Vec<TagIssue>,
) -> Vec<TagValueType> {
    // 原文は各要素と values / patterns の配列を写す。base は呼び出しごとに作った値を受け取るので、持ち主を移すことが写しになる
    let mut result = base;
    for (constraint, targets) in CONSTRAINT_TARGETS {
        let constraint = *constraint;
        // 台帳: def.get(constraint) の None と Null をここでは同じに扱う
        let value = match def.get(constraint) {
            None | Some(JsValue::Undefined) | Some(JsValue::Null) => continue,
            Some(value) => value,
        };
        let at = place.path.as_ref().map(|path| with_step(path, constraint));
        // 台帳: applicable は添字の Vec (JS は同じオブジェクトを参照する)
        let applicable: Vec<usize> = result
            .iter()
            .enumerate()
            .filter(|(_, value_type)| {
                targets.contains(&value_type.primitive)
                    && bound_fits(constraint, value_type.primitive, value)
            })
            .map(|(index, _)| index)
            .collect();
        if applicable.is_empty() {
            // 規則 2.3: [...new Set(xs)] は unique_in_order (台帳 84 の IndexSet と同じ順)
            let kinds: Vec<&str> = unique_in_order(
                result
                    .iter()
                    .map(|value_type| value_type.primitive.as_str()),
            );
            let wrong_bound = (constraint == "min" || constraint == "max")
                && result
                    .iter()
                    .any(|value_type| targets.contains(&value_type.primitive));
            let message = if wrong_bound {
                let form = if kinds
                    .iter()
                    .any(|kind| *kind == "number" || *kind == "integer")
                {
                    "数値"
                } else {
                    "その型と同じ書き方の文字列"
                };
                format!(
                    "{} の {} は、{} の型では{}で書きます",
                    place.label,
                    constraint,
                    kinds.join(", "),
                    form
                )
            } else {
                // 規則 2.1: `|| 'なし'` は空文字のとき
                let joined = kinds.join(", ");
                let kinds_text = if joined.is_empty() {
                    "なし".to_string()
                } else {
                    joined
                };
                let targets_text = targets
                    .iter()
                    .map(|target| target.as_str())
                    .collect::<Vec<&str>>()
                    .join(", ");
                format!(
                    "{} の {} は {} の型にだけ書けます (この型は {})",
                    place.label, constraint, targets_text, kinds_text
                )
            };
            warn(issues, "type-invalid", message, None, at);
            continue;
        }
        if constraint == "pattern"
            && let JsValue::String(pattern) = value
        {
            // 規則 2.4、2.5: 利用者の pattern は regress。new RegExp(value, 'u') の throw は js_regexp_u の None (regress と V8 の差の補いを含む)
            if js_regexp_u(pattern).is_none() {
                warn(
                    issues,
                    "type-invalid",
                    format!(
                        "{} の pattern「{}」は正規表現として読めません",
                        place.label, pattern
                    ),
                    Some("JavaScript の正規表現の文法で書きます".to_string()),
                    at,
                );
                continue;
            }
        }
        // 台帳 84 の「result.get_mut(i) で書き換える」から外れる。理由: get_mut の None は原文にない分岐 (Rust の API が作る不到達) なので、
        // 規則 2.5 (A-031) の「不到達を作らない形」で result を回し applicable の添字だけ書き換える。applicable は昇順なので、stack の順は原文の for と同じ。
        // 台帳の文面の直しは A-070
        for (index, value_type) in result.iter_mut().enumerate() {
            if applicable.contains(&index) {
                stack(value_type, constraint, value);
            }
        }
    }
    result
}

// 原文: boundFits
// min と max は、number と integer には数値、日付や時間にはその型の書き方の文字列だけが効く
fn bound_fits(constraint: &str, primitive: Primitive, value: &JsValue) -> bool {
    if constraint != "min" && constraint != "max" {
        return true;
    }
    if primitive == Primitive::Number || primitive == Primitive::Integer {
        return matches!(value, JsValue::Number(_));
    }
    match value {
        JsValue::String(text) => well_formed(primitive, text),
        _ => false,
    }
}

// 原文: stack
// 制約を重ねる。狭める方向にだけ効き、values は置き換える
fn stack(value_type: &mut TagValueType, constraint: &str, value: &JsValue) {
    match (constraint, value) {
        // 規則 2.1: value.map(String) は各要素を js_to_string
        ("values", JsValue::Array(items)) => {
            value_type.values = Some(items.iter().map(js_to_string).collect())
        }
        ("pattern", JsValue::String(pattern)) => {
            let mut patterns = value_type.patterns.clone().unwrap_or_default();
            patterns.push(pattern.clone());
            value_type.patterns = Some(patterns);
        }
        // 規則 2.1: Math.max / Math.min は js_max / js_min (NaN が伝わる)
        ("minLength", JsValue::Number(number)) => {
            value_type.min_length = Some(js_max(value_type.min_length.unwrap_or(*number), *number));
        }
        ("maxLength", JsValue::Number(number)) => {
            value_type.max_length = Some(js_min(value_type.max_length.unwrap_or(*number), *number));
        }
        ("min" | "max", _) => {
            // 台帳: type[constraint] = value は NumberOrString をそのまま持つ (文字列の min はあとで ordinal が解釈)。
            // 数でも文字列でもなければ何もしない (原文の else if の条件)
            let next_value = match value {
                JsValue::Number(number) => NumberOrString::Number(*number),
                JsValue::String(text) => NumberOrString::String(text.clone()),
                _ => return,
            };
            let primitive = value_type.primitive;
            let slot = if constraint == "min" {
                &mut value_type.min
            } else {
                &mut value_type.max
            };
            let next = ordinal(primitive, &next_value).unwrap_or(0.0);
            // 台帳: known === null は Option
            let known = slot
                .as_ref()
                .map(|current| ordinal(primitive, current).unwrap_or(0.0));
            let tighter = match known {
                None => true,
                Some(known) => {
                    if constraint == "min" {
                        next > known
                    } else {
                        next < known
                    }
                }
            };
            if tighter {
                *slot = Some(next_value);
            }
        }
        _ => {}
    }
}

/// 本文のタグの検査の設定 (原文の TagLintOptions)
// 規則 4 章 (A-037): 原文のモジュールが export する型で共有の型の一覧にないものは写し先のモジュールに置く
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagLintOptions {
    pub severity: TagLintSeverity,
    pub unknown_key: TagLintUnknownKey,
}

// 原文の Rejection
// 原文で export しない interface なので private の struct にし、境界に出ないので Serialize / Deserialize は付けない (規則 2.6、A-077)
struct Rejection {
    reason: String,
    hint: Option<String>,
}

// 原文: reject
// 値が 1 つの形に合わない理由。合えば None
fn reject(value_type: &TagValueType, value: &str, nodes: &[OutlineNode]) -> Option<Rejection> {
    let primitive = value_type.primitive;
    if primitive == Primitive::Enum {
        let values = value_type.values.clone().unwrap_or_default();
        if values.iter().any(|item| item == value) {
            return None;
        }
        let near = closest(value, &values);
        return Some(Rejection {
            reason: format!("{} のどれかで書きます", values.join(" / ")),
            hint: near.map(|near| format!("もしかして「{near}」")),
        });
    }
    if primitive == Primitive::String {
        for pattern in value_type.patterns.iter().flatten() {
            // 台帳: 利用者の pattern は regress (new RegExp(pattern, 'u').test は find が Some か)
            // regress 0.10.5 の Unicode の表は 15.1 までで、Unicode 16.0 で足された字 (U+1C89、U+A7CB、U+10D4A、U+1FA89 など) が
            // \p{L} や \p{Emoji_Presentation} に合わず、node 22 (Unicode 16.0) の旧実装にない tag-type を出す。前段で塞げない差なので写さず、
            // regress は 0.10.5 のまま決定済みの差とする (規則 2.4、A-068、A-074 の (a)。accepted.md の 20)
            let matched = match js_regexp_u(pattern) {
                Some(regex) => regex.find(value).is_some(),
                // TODO(port): 原文では到達しない (resolve_tag_keys が同じ js_regexp_u で読めない pattern を落とす)。lintTags を直接呼ぶ経路の throw (例: `^\-$` で SyntaxError) は写さず、合わないものとして扱う (A-075)
                None => false,
            };
            if !matched {
                return Some(Rejection {
                    reason: format!("「{pattern}」の形に合いません"),
                    hint: None,
                });
            }
        }
        // 規則 2.2: [...value].length はコードポイントの数 (台帳: 絵文字は 1)
        let length = value.chars().count() as f64;
        // 規則 2.1: 数の文字列化は js_number_to_string (minLength は NaN もありうる。NaN との比較は偽)
        if let Some(min_length) = value_type.min_length
            && length < min_length
        {
            return Some(Rejection {
                reason: format!("{} 文字以上で書きます", js_number_to_string(min_length)),
                hint: None,
            });
        }
        if let Some(max_length) = value_type.max_length
            && length > max_length
        {
            return Some(Rejection {
                reason: format!("{} 文字以下で書きます", js_number_to_string(max_length)),
                hint: None,
            });
        }
        return None;
    }
    if !well_formed(primitive, value) {
        return Some(Rejection {
            reason: format!("{}で書きます", forms(primitive)),
            hint: None,
        });
    }
    if primitive == Primitive::NodeId {
        // 規則 2.2: s.slice(a, b) は js_slice (台帳 81: 先頭の $ は ASCII 1 バイト)
        let ref_id = js_slice(value, 1, value.len());
        // 台帳: found は collect してから len
        let found: Vec<&OutlineNode> = nodes
            .iter()
            .filter(|node| node.ref_id.as_deref() == Some(ref_id))
            .collect();
        if found.len() == 1 {
            return None;
        }
        if found.is_empty() {
            let candidates: Vec<String> = nodes
                .iter()
                .filter_map(|node| node.ref_id.as_ref().map(|ref_id| format!("${ref_id}")))
                .collect();
            let near = closest(value, &candidates);
            return Some(Rejection {
                reason: format!("{value} を持つノードがありません"),
                hint: Some(match near {
                    None => "行末に $名前 を付けたノードを指します".to_string(),
                    Some(near) => format!("もしかして「{near}」"),
                }),
            });
        }
        return Some(Rejection {
            // 規則 2.1: 数の文字列化は js_number_to_string。規則 2.1 (A-042): 個数は usize
            reason: format!(
                "{value} を持つノードが {} 個あります",
                js_number_to_string(found.len() as f64)
            ),
            hint: Some("同じ $id を 2 つ以上のノードに書かないようにします".to_string()),
        });
    }
    let position = ordinal(primitive, &NumberOrString::String(value.to_string()));
    if let Some(position) = position {
        let low = value_type
            .min
            .as_ref()
            .and_then(|min| ordinal(primitive, min));
        let high = value_type
            .max
            .as_ref()
            .and_then(|max| ordinal(primitive, max));
        // 台帳: ${type.min} は js_to_string
        if let (Some(low), Some(min)) = (low, &value_type.min)
            && position < low
        {
            return Some(Rejection {
                reason: format!("{} 以上で書きます", js_to_string(&JsValue::from(min))),
                hint: None,
            });
        }
        if let (Some(high), Some(max)) = (high, &value_type.max)
            && position > high
        {
            return Some(Rejection {
                reason: format!("{} 以下で書きます", js_to_string(&JsValue::from(max))),
                hint: None,
            });
        }
    }
    None
}

// 原文の seen の値の要素 `{ node, tag }`
// 台帳 (A-080): node と tag は nodes と node.tags への参照。同一性は entries の中の位置の添字で比べる
struct Entry<'a> {
    node: &'a OutlineNode,
    tag: &'a NodeTag,
}

// 診断の文に出すノードの呼び名。名前 (refText) を持たないノード (1 行目が空の項目など。A-219) は $id か「名前のないノード」
fn node_label(node: &OutlineNode) -> String {
    match (node.ref_text.is_empty(), &node.ref_id) {
        (false, _) => format!("「{}」", node.ref_text),
        (true, Some(ref_id)) => format!("「${ref_id}」"),
        (true, None) => "名前のないノード".to_string(),
    }
}

/// 原文: lintTags
/// 本文のタグを、解決済みのキーの定義に当てる。定義のないキーは unknownKey が deny のときだけ知らせる
pub fn lint_tags(
    nodes: &[OutlineNode],
    keys: &[TagKeyDef],
    options: &TagLintOptions,
) -> Vec<TagIssue> {
    let mut issues: Vec<TagIssue> = Vec::new();
    // 台帳: byKey は IndexMap (同じ key が 2 度あれば後勝ちで位置は先)
    let mut by_key: IndexMap<&str, &TagKeyDef> = IndexMap::new();
    for def in keys {
        by_key.insert(def.key.as_str(), def);
    }
    // 規則 4 章 (A-079): union の部分集合から元の union への変換は types.rs の From
    let severity = Severity::from(options.severity);
    let mut report = |code: &str, message: String, hint: Option<String>, at: &SourcePosition| {
        issues.push(TagIssue {
            severity,
            code: code.to_string(),
            message,
            hint,
            path: None,
            at: Some(at.clone()),
        });
    };
    // unique のキーの、値ごとの出現
    // 台帳: seen は IndexMap<(String, String), Vec<Entry>>。規則 2.3 (A-015): `${key}\u0000${value}` の連結のキーは組。
    // 組にしてよい根拠: タグのキーは document.ts:97 (TRAILING_TOKEN) の `[\p{L}\p{N}_-]+` の字だけなので \u0000 を含まず、
    // 連結は最初の \u0000 で一意に分かれる (値が \u0000 を含んでもよい)。lint_tags を直接呼んでキーに \u0000 を入れると、原文の連結は
    // 別のキーと値の組を同じと見るが、組では区別する (台帳 79 行の文面の直しは A-076)
    let mut seen: IndexMap<(String, String), Vec<Entry>> = IndexMap::new();

    for node in nodes {
        for tag in &node.tags {
            let name = format!("{}の {}", node_label(node), format_tag(tag));
            let Some(def) = by_key.get(tag.key.as_str()) else {
                if options.unknown_key == TagLintUnknownKey::Deny {
                    // 台帳: closest(tag.key, [...byKey.keys()])
                    let candidates: Vec<&str> = by_key.keys().copied().collect();
                    let near = closest(&tag.key, &candidates);
                    report(
                        "tag-unknown-key",
                        format!("{name} は、markdag.tags.keys に定義のないキーです"),
                        Some(match near {
                            None => "keys に定義するか、unknownKey を allow にします".to_string(),
                            Some(near) => format!("もしかして「{near}」"),
                        }),
                        &tag.at,
                    );
                }
                continue;
            };
            // 型を解決できなかったキーは検査しない (理由は解決のときに知らせている)
            if def.alternatives.is_empty() {
                continue;
            }
            if tag.values.is_empty() {
                if !def
                    .alternatives
                    .iter()
                    .any(|value_type| value_type.primitive == Primitive::Boolean)
                {
                    report(
                        "tag-missing-value",
                        format!(
                            "{name} には値が要ります ({})",
                            def.alternatives
                                .iter()
                                .map(describe)
                                .collect::<Vec<String>>()
                                .join("、")
                        ),
                        Some(format!("#{}:値 の形で書きます", tag.key)),
                        &tag.at,
                    );
                }
                continue;
            }
            if tag.values.len() > 1 && !def.multiple {
                report(
                    "tag-multiple",
                    format!("{name} は値を 1 つだけ書くキーです"),
                    Some(format!(
                        "複数の値を許すなら markdag.tags.keys.{} に multiple: true を書きます",
                        tag.key
                    )),
                    &tag.at,
                );
            }
            for value in &tag.values {
                // 台帳: rejections は Vec<Option<Rejection>> を集めてから every / find
                let rejections: Vec<Option<Rejection>> = def
                    .alternatives
                    .iter()
                    .map(|value_type| reject(value_type, value, nodes))
                    .collect();
                if rejections.iter().all(Option::is_some) {
                    // 原文の `single = alternatives.length === 1 && first` (first は every を通ったので必ず Rejection)
                    let message = match (def.alternatives.len(), rejections.first()) {
                        (1, Some(Some(first))) => format!("{name}: {}", first.reason),
                        _ => format!(
                            "{name} の「{value}」は {} のどれにも合いません",
                            def.alternatives
                                .iter()
                                .map(describe)
                                .collect::<Vec<String>>()
                                .join("、")
                        ),
                    };
                    // 台帳: r?.hint は Some で hint が Some かつ空でない (truthy)。規則 2.1 の真偽の位置の Option<String>
                    let hint = rejections
                        .iter()
                        .flatten()
                        .find(|rejection| {
                            rejection
                                .hint
                                .as_deref()
                                .is_some_and(|hint| !hint.is_empty())
                        })
                        .and_then(|rejection| rejection.hint.clone());
                    report("tag-type", message, hint, &tag.at);
                }
                if def.unique {
                    // 規則 2.3: IndexMap の entry は既にあるキーの位置を変えない (Map.set と同じ)
                    seen.entry((tag.key.clone(), value.clone()))
                        .or_default()
                        .push(Entry { node, tag });
                }
            }
        }
    }

    // 同じ値が複数のノードにあれば、すべての箇所に知らせ、ほかの箇所の行を添える
    for entries in seen.values() {
        if entries.len() < 2 {
            continue;
        }
        for (index, entry) in entries.iter().enumerate() {
            let Entry { node, tag } = entry;
            // 規則 2.3、2.6: other !== entry は entries の中の位置の比較 (台帳: (node, tag) の組では比べない)
            let others: Vec<String> = entries
                .iter()
                .enumerate()
                .filter(|(other_index, _)| *other_index != index)
                // 規則 2.1: 数の文字列化は js_number_to_string
                .map(|(_, other)| {
                    format!("{} 行目", js_number_to_string(f64::from(other.tag.at.line)))
                })
                .collect();
            report(
                "tag-unique",
                format!(
                    "{}の {} は、ほかのノードにも書かれています ({})",
                    node_label(node),
                    format_tag(tag),
                    others.join("、")
                ),
                Some("unique のキーなので、値を変えるか片方を消します".to_string()),
                &tag.at,
            );
        }
    }
    issues
}

/// 原文: suggestTagKeys
/// 編集側の候補: キーの名前 (入力途中の文字で絞る)
// 規則 2.6: 既定の引数 (prefix = '') は Option で受け、関数の先頭で unwrap_or
pub fn suggest_tag_keys(keys: &[TagKeyDef], prefix: Option<&str>) -> Vec<TagKeySuggestion> {
    let prefix = prefix.unwrap_or("");
    keys.iter()
        .filter(|def| def.key.starts_with(prefix))
        .map(|def| TagKeySuggestion {
            key: def.key.clone(),
            description: def.description.clone(),
        })
        .collect()
}

/// 原文: suggestTagValues
/// 編集側の候補: そのキーの値。enum の values と boolean の true / false だけが候補になる
// 規則 2.6: 既定の引数 (prefix = '') は Option で受け、関数の先頭で unwrap_or
pub fn suggest_tag_values(keys: &[TagKeyDef], key: &str, prefix: Option<&str>) -> Vec<String> {
    let prefix = prefix.unwrap_or("");
    let Some(def) = keys.iter().find(|item| item.key == key) else {
        return Vec::new();
    };
    // 規則 2.3: 段ごとに collect する
    let candidates: Vec<String> = def
        .alternatives
        .iter()
        .flat_map(|value_type| match value_type.primitive {
            Primitive::Enum => value_type.values.clone().unwrap_or_default(),
            Primitive::Boolean => vec!["true".to_string(), "false".to_string()],
            _ => Vec::new(),
        })
        .collect();
    // 規則 2.3: [...new Set(xs)] は unique_in_order (台帳: IndexSet で最初の出現の順)
    unique_in_order(candidates)
        .into_iter()
        .filter(|value| value.starts_with(prefix))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期待値は node で原文 (src/model/tags.ts) を動かして取った (vite-node、2026-09-24)

    #[test]
    fn tags_regexes_compile() {
        LazyLock::force(&NUMBER);
        LazyLock::force(&INTEGER);
        LazyLock::force(&DATE);
        LazyLock::force(&DATETIME);
        LazyLock::force(&TIME);
        LazyLock::force(&DURATION);
        LazyLock::force(&NODE_ID);
        LazyLock::force(&NEEDS_QUOTE);
    }

    #[test]
    fn tags_well_formed_matches_node() {
        let cases: &[(Primitive, &str, bool)] = &[
            (Primitive::Date, "0099-01-01", false),
            (Primitive::Date, "0100-01-01", true),
            (Primitive::Date, "2024-02-29", true),
            (Primitive::Date, "2023-02-29", false),
            (Primitive::Date, "2024-13-01", false),
            (Primitive::Date, "2024-04-31", false),
            (Primitive::Datetime, "2024-01-01T10:00", true),
            (Primitive::Datetime, "2024-01-01 23:59:59+09:00", true),
            (Primitive::Datetime, "2024-01-01T24:00", false),
            (Primitive::Datetime, "2024-01-01T10:00+24:00", false),
            (Primitive::Datetime, "2024-01-01T10:00-05:60", false),
            (Primitive::Datetime, "2024-01-01T10:00:60Z", false),
            (Primitive::Datetime, "2024-02-30T10:00", false),
            (Primitive::Time, "23:59", true),
            (Primitive::Time, "24:00", false),
            (Primitive::Time, "12:30:60", false),
            (Primitive::Time, "12:30:59", true),
            (Primitive::Duration, "30m", true),
            (Primitive::Duration, "1.5h", true),
            (Primitive::Duration, "2d", true),
            (Primitive::Duration, "1w", true),
            (Primitive::Duration, "3y", false),
            (Primitive::Duration, "h", false),
            (Primitive::Number, "-1.5", true),
            (Primitive::Number, "1e3", false),
            (Primitive::Number, "1.", false),
            (Primitive::Number, "٣", false),
            (Primitive::Integer, "10", true),
            (Primitive::Integer, "1.0", false),
            (Primitive::Boolean, "true", true),
            (Primitive::Boolean, "True", false),
            (Primitive::NodeId, "$a-1", true),
            (Primitive::NodeId, "$1a", false),
            (Primitive::String, "", true),
            (Primitive::Enum, "x", true),
        ];
        for (primitive, value, expected) in cases {
            assert_eq!(
                well_formed(*primitive, value),
                *expected,
                "{primitive:?} {value:?}"
            );
        }
    }

    #[test]
    fn tags_ordinal_matches_node() {
        let cases: &[(Primitive, NumberOrString, Option<f64>)] = &[
            (Primitive::Number, NumberOrString::Number(1.5), Some(1.5)),
            (Primitive::Date, NumberOrString::Number(5.0), None),
            (
                Primitive::Number,
                NumberOrString::String("-2.5".to_string()),
                Some(-2.5),
            ),
            (
                Primitive::Integer,
                NumberOrString::String("42".to_string()),
                Some(42.0),
            ),
            (
                Primitive::Date,
                NumberOrString::String("2024-02-29".to_string()),
                Some(1709164800000.0),
            ),
            (
                Primitive::Date,
                NumberOrString::String("0099-01-01".to_string()),
                None,
            ),
            (
                Primitive::Date,
                NumberOrString::String("0100-03-01".to_string()),
                Some(-59006361600000.0),
            ),
            (
                Primitive::Datetime,
                NumberOrString::String("2024-01-01T10:00+09:00".to_string()),
                Some(1704070800000.0),
            ),
            (
                Primitive::Datetime,
                NumberOrString::String("2024-01-01T10:00-05:30".to_string()),
                Some(1704123000000.0),
            ),
            (
                Primitive::Datetime,
                NumberOrString::String("2024-01-01T10:00Z".to_string()),
                Some(1704103200000.0),
            ),
            (
                Primitive::Datetime,
                NumberOrString::String("2024-01-01 10:00:30".to_string()),
                Some(1704103230000.0),
            ),
            (
                Primitive::Time,
                NumberOrString::String("01:02:03".to_string()),
                Some(3723.0),
            ),
            (
                Primitive::Time,
                NumberOrString::String("23:59".to_string()),
                Some(86340.0),
            ),
            (
                Primitive::Duration,
                NumberOrString::String("30m".to_string()),
                Some(30.0),
            ),
            (
                Primitive::Duration,
                NumberOrString::String("1.5h".to_string()),
                Some(90.0),
            ),
            (
                Primitive::Duration,
                NumberOrString::String("2d".to_string()),
                Some(2880.0),
            ),
            (
                Primitive::Duration,
                NumberOrString::String("1w".to_string()),
                Some(10080.0),
            ),
            (
                Primitive::Boolean,
                NumberOrString::String("true".to_string()),
                None,
            ),
            (
                Primitive::NodeId,
                NumberOrString::String("$a".to_string()),
                None,
            ),
            (
                Primitive::Time,
                NumberOrString::String("25:00".to_string()),
                None,
            ),
        ];
        for (primitive, value, expected) in cases {
            assert_eq!(
                ordinal(*primitive, value),
                *expected,
                "{primitive:?} {value:?}"
            );
        }
    }

    fn value_type(primitive: Primitive) -> TagValueType {
        TagValueType {
            primitive,
            values: None,
            patterns: None,
            min_length: None,
            max_length: None,
            min: None,
            max: None,
        }
    }

    fn strings(items: &[&str]) -> Option<Vec<String>> {
        Some(items.iter().map(|item| item.to_string()).collect())
    }

    #[test]
    fn tags_describe_matches_node() {
        let text = |text: &str| Some(NumberOrString::String(text.to_string()));
        let cases: Vec<TagValueType> = vec![
            TagValueType {
                values: strings(&["a", "b"]),
                ..value_type(Primitive::Enum)
            },
            value_type(Primitive::Enum),
            value_type(Primitive::Date),
            TagValueType {
                patterns: strings(&["^a", "b$"]),
                min_length: Some(2.0),
                max_length: Some(1e21),
                ..value_type(Primitive::String)
            },
            TagValueType {
                patterns: strings(&[]),
                ..value_type(Primitive::String)
            },
            TagValueType {
                min_length: Some(f64::NAN),
                ..value_type(Primitive::String)
            },
            TagValueType {
                min: Some(NumberOrString::Number(1.0)),
                max: Some(NumberOrString::Number(2.5)),
                ..value_type(Primitive::Number)
            },
            TagValueType {
                min: text("2024-01-01"),
                max: text("2024-12-31"),
                ..value_type(Primitive::Date)
            },
            TagValueType {
                min: Some(NumberOrString::Number(1e-7)),
                ..value_type(Primitive::Number)
            },
        ];
        let expected: &[&str] = &[
            "a / b のどれか",
            " のどれか",
            "YYYY-MM-DD の日付",
            "文字列 (「^a」 と 「b$」 に合う、2 文字以上、1e+21 文字以下)",
            "文字列 ( に合う)",
            "文字列 (NaN 文字以上)",
            "数値 (1 以上、2.5 以下)",
            "YYYY-MM-DD の日付 (2024-01-01 以上、2024-12-31 以下)",
            "数値 (1e-7 以上)",
        ];
        let actual: Vec<String> = cases.iter().map(describe).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn tags_format_tag_quotes_like_node() {
        let cases: &[(&[&str], &str)] = &[
            (&[], "#k"),
            (&["a b"], "#k:\"a b\""),
            (&["a\u{3000}b"], "#k:\"a\u{3000}b\""),
            (&["a,b"], "#k:\"a,b\""),
            (&["a\"b"], "#k:\"a\"b\""),
            (&["plain", "x y"], "#k:plain,\"x y\""),
            (&["a\u{a0}b"], "#k:\"a\u{a0}b\""),
            (&["a\u{85}b"], "#k:a\u{85}b"),
            (&["a\u{feff}b"], "#k:\"a\u{feff}b\""),
            (&["a\u{9}b"], "#k:\"a\u{9}b\""),
            (&["日本語"], "#k:日本語"),
        ];
        for (values, expected) in cases {
            let tag = NodeTag {
                key: "k".to_string(),
                values: values.iter().map(|value| value.to_string()).collect(),
                at: SourcePosition {
                    line: 1,
                    column: 1,
                    length: 1,
                },
            };
            assert_eq!(format_tag(&tag), *expected, "{values:?}");
        }
    }

    // node の resolveTagKeys に渡した入力と、JSON.stringify した出力を突き合わせる
    fn check_resolve(input: &str, expected: &str) {
        #[derive(Deserialize)]
        struct Input {
            sources: Vec<TypeSource>,
            keys: IndexMap<String, JsValue>,
            unresolved: bool,
        }
        let input: Input = serde_json::from_str(input).expect("入力の JSON");
        let keys_path = vec![
            PathStep::Key("markdag".to_string()),
            PathStep::Key("tags".to_string()),
            PathStep::Key("keys".to_string()),
        ];
        let actual = resolve_tag_keys(&input.sources, &input.keys, &keys_path, input.unresolved);
        let actual = serde_json::to_value(&actual).expect("出力の JSON");
        let expected: serde_json::Value = serde_json::from_str(expected).expect("期待値の JSON");
        assert_eq!(actual, expected);
    }

    #[test]
    fn tags_resolve_named_types_and_stacked_constraints() {
        check_resolve(
            r#"{"sources":[{"label":"markdag.types","defs":{"short":{"type":"string","maxLength":10,"pattern":"^[a-z]+$"},"tiny":{"type":"short","maxLength":20,"minLength":2,"pattern":"x"},"level":{"type":"enum","values":["low","high"]},"due":{"type":"date","min":"2024-01-01","max":"2024-12-31"},"soon":{"type":"due","max":"2024-06-30","min":"2023-01-01"},"mixed":{"type":["integer","level"],"min":1,"values":[1,true,null,[2,3]]}},"path":["markdag","types"]}],"keys":{"name":{"type":"tiny"},"lv":{"type":["level","integer"],"min":1,"values":[1,true,null]},"d":{"type":"soon","multiple":true,"unique":"true","description":"期日"},"plain":null,"list":[1],"m":{"type":"mixed","minLength":1},"len":{"minLength":5,"maxLength":3},"len2":{"type":"short","minLength":4,"maxLength":12},"num":{"type":"number","min":3,"max":10},"num2":{"type":"number","min":5}},"unresolved":false}"#,
            r#"{"keys":[{"key":"name","alternatives":[{"primitive":"string","patterns":["^[a-z]+$","x"],"maxLength":10,"minLength":2}],"multiple":false,"unique":false,"description":null},{"key":"lv","alternatives":[{"primitive":"enum","values":["1","true","null"]},{"primitive":"integer","min":1}],"multiple":false,"unique":false,"description":null},{"key":"d","alternatives":[{"primitive":"date","min":"2024-01-01","max":"2024-06-30"}],"multiple":true,"unique":false,"description":"期日"},{"key":"plain","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"list","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"m","alternatives":[{"primitive":"integer","min":1},{"primitive":"enum","values":["1","true","null","2,3"]}],"multiple":false,"unique":false,"description":null},{"key":"len","alternatives":[{"primitive":"string","minLength":5,"maxLength":3}],"multiple":false,"unique":false,"description":null},{"key":"len2","alternatives":[{"primitive":"string","patterns":["^[a-z]+$"],"maxLength":10,"minLength":4}],"multiple":false,"unique":false,"description":null},{"key":"num","alternatives":[{"primitive":"number","min":3,"max":10}],"multiple":false,"unique":false,"description":null},{"key":"num2","alternatives":[{"primitive":"number","min":5}],"multiple":false,"unique":false,"description":null}],"issues":[{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.m の minLength は string の型にだけ書けます (この型は integer, enum)","hint":null,"path":["markdag","tags","keys","m","minLength"],"at":null}]}"#,
        );
    }

    #[test]
    fn tags_resolve_warns_unknown_cycle_invalid_reserved() {
        check_resolve(
            r#"{"sources":[{"label":"markdag.types","defs":{"a":{"type":"b"},"b":{"type":"a"},"date":{"type":"string"},"bad":"x","self":{"type":"self"},"e":{"type":"enum"}},"path":["markdag","types"]}],"keys":{"k1":{"type":"strng"},"k2":{"type":"zzzzzzzzzz"},"k3":{"type":"a"},"k4":{"type":42},"k5":{"type":"number","minLength":1},"k6":{"type":"number","min":"1"},"k7":{"type":"date","min":3},"k8":{"type":"string","pattern":"("},"k9":{"type":[],"minLength":1},"k10":{"type":"e"},"k11":{"type":"enum","values":[]},"k12":{"type":["self","date"],"max":"x"},"k13":{"type":"string","pattern":5},"k14":{"type":["number","string"],"min":"abc"},"k15":{"type":"duration","min":"2h","max":"1d"},"k16":{"type":"enum","values":["a"]}},"unresolved":false}"#,
            r#"{"keys":[{"key":"k1","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k2","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k3","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k4","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k5","alternatives":[{"primitive":"number"}],"multiple":false,"unique":false,"description":null},{"key":"k6","alternatives":[{"primitive":"number"}],"multiple":false,"unique":false,"description":null},{"key":"k7","alternatives":[{"primitive":"date"}],"multiple":false,"unique":false,"description":null},{"key":"k8","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"k9","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k10","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k11","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"k12","alternatives":[{"primitive":"date"}],"multiple":false,"unique":false,"description":null},{"key":"k13","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"k14","alternatives":[{"primitive":"number"},{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"k15","alternatives":[{"primitive":"duration","min":"2h","max":"1d"}],"multiple":false,"unique":false,"description":null},{"key":"k16","alternatives":[{"primitive":"enum","values":["a"]}],"multiple":false,"unique":false,"description":null}],"issues":[{"severity":"warning","code":"type-reserved","message":"markdag.types.date は組み込みの型と同じ名前なので定義できません","hint":"別の名前にします","path":["markdag","types","date"],"at":null},{"severity":"warning","code":"type-unknown","message":"markdag.tags.keys.k1 の型「strng」は、組み込みの型にも markdag.types にもありません","hint":"もしかして「string」","path":["markdag","tags","keys","k1","type"],"at":null},{"severity":"warning","code":"type-unknown","message":"markdag.tags.keys.k2 の型「zzzzzzzzzz」は、組み込みの型にも markdag.types にもありません","hint":"組み込みの型は string, number, integer, boolean, enum, date, datetime, time, duration, nodeId です","path":["markdag","tags","keys","k2","type"],"at":null},{"severity":"warning","code":"type-cycle","message":"型「a」の定義が自分自身に戻っています (a → b → a)","hint":"型の type には、自分より基底の型を書きます","path":["markdag","types","a","type"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k5 の minLength は string の型にだけ書けます (この型は number)","hint":null,"path":["markdag","tags","keys","k5","minLength"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k6 の min は、number の型では数値で書きます","hint":null,"path":["markdag","tags","keys","k6","min"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k7 の min は、date の型ではその型と同じ書き方の文字列で書きます","hint":null,"path":["markdag","tags","keys","k7","min"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k8 の pattern「(」は正規表現として読めません","hint":"JavaScript の正規表現の文法で書きます","path":["markdag","tags","keys","k8","pattern"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k9 の minLength は string の型にだけ書けます (この型は なし)","hint":null,"path":["markdag","tags","keys","k9","minLength"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k10 は enum なので values (許す値の一覧) が要ります","hint":"values: の下に、許す値を「- high」の形で 1 行ずつ並べます","path":["markdag","tags","keys","k10","values"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k11 は enum なので values (許す値の一覧) が要ります","hint":"values: の下に、許す値を「- high」の形で 1 行ずつ並べます","path":["markdag","tags","keys","k11","values"],"at":null},{"severity":"warning","code":"type-cycle","message":"型「self」の定義が自分自身に戻っています (self → self)","hint":"型の type には、自分より基底の型を書きます","path":["markdag","types","self","type"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k12 の max は、date の型ではその型と同じ書き方の文字列で書きます","hint":null,"path":["markdag","tags","keys","k12","max"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.k14 の min は、number, string の型では数値で書きます","hint":null,"path":["markdag","tags","keys","k14","min"],"at":null}]}"#,
        );
    }

    #[test]
    fn tags_resolve_ref_file_source_warnings() {
        check_resolve(
            r#"{"sources":[{"label":"types.yml","defs":{"$ref":"x","t1":5,"t2":{"type":[1,"string"]},"t3":{"type":"nope"},"dup":{"type":"integer"},"string":{}},"path":null},{"label":"markdag.types","defs":{"$ref":"./types.yml","dup":{"type":"number","max":9}},"path":["markdag","types"]}],"keys":{"a":{"type":"t2"},"b":{"type":"t3"},"c":{"type":"dup"},"d":{"type":"dupp"}},"unresolved":false}"#,
            r#"{"keys":[{"key":"a","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"b","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"c","alternatives":[{"primitive":"number","max":9}],"multiple":false,"unique":false,"description":null},{"key":"d","alternatives":[],"multiple":false,"unique":false,"description":null}],"issues":[{"severity":"warning","code":"type-invalid","message":"types.yml の中の $ref は読みません (参照は文書の frontmatter にだけ書けます)","hint":"ファイルには型の定義だけを書きます","path":null,"at":null},{"severity":"warning","code":"type-invalid","message":"types.yml の t1 は、type と制約をキーと値の組で書きます","hint":null,"path":null,"at":null},{"severity":"warning","code":"type-reserved","message":"types.yml の string は組み込みの型と同じ名前なので定義できません","hint":"別の名前にします","path":null,"at":null},{"severity":"warning","code":"type-invalid","message":"types.yml の t2 の type は型の名前を文字列で書きます","hint":null,"path":null,"at":null},{"severity":"warning","code":"type-unknown","message":"types.yml の t3 の型「nope」は、組み込みの型にも markdag.types にもありません","hint":"組み込みの型は string, number, integer, boolean, enum, date, datetime, time, duration, nodeId です","path":null,"at":null},{"severity":"warning","code":"type-unknown","message":"markdag.tags.keys.d の型「dupp」は、組み込みの型にも markdag.types にもありません","hint":"もしかして「dup」","path":["markdag","tags","keys","d","type"],"at":null}]}"#,
        );
    }

    // regress は u フラグの \b+ / \B* を通すが、V8 は SyntaxError (tags1-review-a)
    #[test]
    fn tags_resolve_rejects_quantified_word_boundary_like_node() {
        check_resolve(
            r#"{"sources":[],"keys":{"p":{"type":"string","pattern":"\\b+"},"q":{"type":"string","pattern":"\\B*"},"r":{"type":"string","pattern":"[\\b]+"}},"unresolved":false}"#,
            r#"{"keys":[{"key":"p","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"q","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"r","alternatives":[{"primitive":"string","patterns":["[\\b]+"]}],"multiple":false,"unique":false,"description":null}],"issues":[{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.p の pattern「\\b+」は正規表現として読めません","hint":"JavaScript の正規表現の文法で書きます","path":["markdag","tags","keys","p","pattern"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.q の pattern「\\B*」は正規表現として読めません","hint":"JavaScript の正規表現の文法で書きます","path":["markdag","tags","keys","q","pattern"],"at":null}]}"#,
        );
    }

    // 境界の JSON の数は最短表記から 1 ULP もずれずに読む (serde_json の float_roundtrip。tags1-review-a)。
    // 期待値と実際を同じ読み手で読むと揃ってずれるので、文字にした describe で比べる
    #[test]
    fn tags_boundary_numbers_round_trip_like_node() {
        let source: TypeSource = serde_json::from_str(
            r#"{"label":"t.yml","defs":{"n":{"type":"number","min":1.2345678901234566e-7,"max":123456789012345680000}},"path":null}"#,
        )
        .expect("入力の JSON");
        let mut keys = IndexMap::new();
        let mut def = IndexMap::new();
        def.insert("type".to_string(), JsValue::String("n".to_string()));
        keys.insert("a".to_string(), JsValue::Object(def));
        let resolved = resolve_tag_keys(&[source], &keys, &[], false);
        let described: Vec<String> = resolved
            .keys
            .iter()
            .flat_map(|key| key.alternatives.iter().map(describe))
            .collect();
        assert_eq!(
            described,
            vec!["数値 (1.2345678901234566e-7 以上、123456789012345680000 以下)"]
        );
        for text in [
            "1.2345678901234566e-7",
            "123456789012345680000",
            "2.2250738585072011e-308",
        ] {
            let parsed: JsValue = serde_json::from_str(text).expect("数の JSON");
            assert_eq!(parsed, JsValue::Number(js_number(text)), "{text}");
        }
    }

    #[test]
    fn tags_resolve_refs_unresolved_skips_named_types() {
        check_resolve(
            r#"{"sources":[{"label":"markdag.types","defs":{"t":{"type":"integer"}},"path":["markdag","types"]}],"keys":{"a":{"type":"t"},"b":{"type":["t","date"]},"c":{"type":"unknown"}},"unresolved":true}"#,
            r#"{"keys":[{"key":"a","alternatives":[],"multiple":false,"unique":false,"description":null},{"key":"b","alternatives":[{"primitive":"date"}],"multiple":false,"unique":false,"description":null},{"key":"c","alternatives":[],"multiple":false,"unique":false,"description":null}],"issues":[]}"#,
        );
    }

    // node の resolveTagKeys と lintTags に渡した入力と、[...resolved.issues, ...lintTags(...)] を JSON.stringify した出力を突き合わせる。
    // nodes は [refText, refId, [[key, line, ...values], ...]] の短い形で書き、ここで OutlineNode に組む
    fn check_lint(input: &str, expected: &str) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Input {
            sources: Vec<TypeSource>,
            keys: IndexMap<String, JsValue>,
            tag_keys: Option<Vec<TagKeyDef>>,
            nodes: Vec<(String, Option<String>, Vec<Vec<JsValue>>)>,
            options: TagLintOptions,
            // buildModel の $ref が 1 つでも読めなかったか (resolveTagKeys の refsUnresolved)
            #[serde(default)]
            unresolved: bool,
        }
        let input: Input = serde_json::from_str(input).expect("入力の JSON");
        let keys_path = vec![
            PathStep::Key("markdag".to_string()),
            PathStep::Key("tags".to_string()),
            PathStep::Key("keys".to_string()),
        ];
        let resolved = match input.tag_keys {
            Some(keys) => ResolvedTagKeys {
                keys,
                issues: Vec::new(),
            },
            None => resolve_tag_keys(&input.sources, &input.keys, &keys_path, input.unresolved),
        };
        let nodes: Vec<OutlineNode> = input
            .nodes
            .into_iter()
            .enumerate()
            .map(|(index, (ref_text, ref_id, tags))| OutlineNode {
                id: index as u32 + 1,
                parent: None,
                depth: 1,
                html: ref_text.clone(),
                ref_text,
                ref_id,
                groups: Vec::new(),
                tags: tags
                    .into_iter()
                    .map(|items| {
                        let text = |item: &JsValue| match item {
                            JsValue::String(text) => text.clone(),
                            other => panic!("タグの文字列でない: {other:?}"),
                        };
                        let line = match items.get(1) {
                            Some(JsValue::Number(line)) => *line as u32,
                            other => panic!("タグの行でない: {other:?}"),
                        };
                        NodeTag {
                            key: text(&items[0]),
                            values: items[2..].iter().map(text).collect(),
                            at: SourcePosition {
                                line,
                                column: 1,
                                length: 1,
                            },
                        }
                    })
                    .collect(),
                milestone: false,
                fold_hint: 0.0,
                lines: None,
                task: None,
                details: None,
            })
            .collect();
        let mut issues = resolved.issues;
        issues.extend(lint_tags(&nodes, &resolved.keys, &input.options));
        let actual = serde_json::to_value(&issues).expect("出力の JSON");
        let expected: serde_json::Value = serde_json::from_str(expected).expect("期待値の JSON");
        assert_eq!(actual, expected);
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_values_against_types() {
        check_lint(
            r##"{"sources":[],"keys":{"priority":{"type":"enum","values":["high","medium","low"],"description":"優先度"},"estimate":{"type":"number","min":0},"due":{"type":"date"},"urgent":{"type":"boolean"},"id":{"type":"string","pattern":"^T-\\d+$","unique":true},"blockedBy":{"type":"nodeId"},"owner":{"type":"string","multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["priority",2,"high"],["estimate",2,"3.5"],["due",2,"2026-10-01"],["urgent",2]]],["B",null,[["priority",3,"hgih"],["estimate",3,"abc"],["due",3,"2026-13-01"],["urgent",3,"yes"]]],["C","api",[["id",4,"T-1"],["blockedBy",4,"$api"],["owner",4,"alice","bob"]]],["D",null,[["id",5,"T-1"],["blockedBy",5,"$missing"],["owner",5,"carol"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「B」の #priority:hgih: high / medium / low のどれかで書きます","hint":"もしかして「high」","path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #estimate:abc: 数値で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #due:2026-13-01: YYYY-MM-DD の日付で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #urgent:yes: true か false のどちらかで書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「D」の #blockedBy:$missing: $missing を持つノードがありません","hint":"行末に $名前 を付けたノードを指します","path":null,"at":{"line":5,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「C」の #id:T-1 は、ほかのノードにも書かれています (5 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":4,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「D」の #id:T-1 は、ほかのノードにも書かれています (4 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":5,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_severity_error_and_unknown_key_deny() {
        check_lint(
            r##"{"sources":[],"keys":{"owner":{"type":"string"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["onwer",2,"alice"],["memo",2,"x"]]]],"options":{"severity":"error","unknownKey":"deny"}}"##,
            r##"[{"severity":"error","code":"tag-unknown-key","message":"「A」の #onwer:alice は、markdag.tags.keys に定義のないキーです","hint":"もしかして「owner」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"error","code":"tag-unknown-key","message":"「A」の #memo:x は、markdag.tags.keys に定義のないキーです","hint":"keys に定義するか、unknownKey を allow にします","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_unknown_key_allow_without_keys() {
        check_lint(
            r##"{"sources":[],"keys":{},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["priority",2,"high"],["estimate",2,"3.5"],["due",2,"2026-10-01"],["urgent",2]]],["B",null,[["priority",3,"hgih"],["estimate",3,"abc"],["due",3,"2026-13-01"],["urgent",3,"yes"]]],["C","api",[["id",4,"T-1"],["blockedBy",4,"$api"],["owner",4,"alice","bob"]]],["D",null,[["id",5,"T-1"],["blockedBy",5,"$missing"],["owner",5,"carol"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_value_count() {
        check_lint(
            r##"{"sources":[],"keys":{"due":{"type":"date"},"urgent":{"type":"boolean"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["due",2],["urgent",2],["due",2,"2026-10-01","2026-10-02"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-missing-value","message":"「A」の #due には値が要ります (YYYY-MM-DD の日付)","hint":"#due:値 の形で書きます","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-multiple","message":"「A」の #due:2026-10-01,2026-10-02 は値を 1 つだけ書くキーです","hint":"複数の値を許すなら markdag.tags.keys.due に multiple: true を書きます","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_named_types_and_alternatives() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{"ticket":{"type":"string","pattern":"^[A-Z]+-\\d+$"},"jira":{"type":"ticket","pattern":"^JIRA-"},"level":{"type":"integer","min":1,"max":5}},"path":["markdag","types"]}],"keys":{"id":{"type":"jira"},"priority":{"type":["level","enum"],"values":["high","low"],"multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["id",2,"JIRA-12"],["priority",2,"3"],["priority",2,"high"]]],["B",null,[["id",3,"ABC-12"],["priority",3,"9"],["priority",3,"medium"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「B」の #id:ABC-12: 「^JIRA-」の形に合いません","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #priority:9 の「9」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #priority:medium の「medium」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (model.tagKeys の expect。patterns は基底が先、alternatives は type の一覧の順)
    #[test]
    fn tags_resolve_ts_named_types_and_alternatives() {
        check_resolve(
            r##"{"sources":[{"label":"markdag.types","defs":{"ticket":{"type":"string","pattern":"^[A-Z]+-\\d+$"},"jira":{"type":"ticket","pattern":"^JIRA-"},"level":{"type":"integer","min":1,"max":5}},"path":["markdag","types"]}],"keys":{"id":{"type":"jira"},"priority":{"type":["level","enum"],"values":["high","low"],"multiple":true}},"unresolved":false}"##,
            r##"{"keys":[{"key":"id","alternatives":[{"primitive":"string","patterns":["^[A-Z]+-\\d+$","^JIRA-"]}],"multiple":false,"unique":false,"description":null},{"key":"priority","alternatives":[{"primitive":"integer","min":1,"max":5},{"primitive":"enum","values":["high","low"]}],"multiple":true,"unique":false,"description":null}],"issues":[]}"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_invalid_definition_skips_key() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{"loop":{"type":"loop"},"string":{"type":"string"},"bad":{"type":"number","pattern":"x","min":"1"}},"path":["markdag","types"]}],"keys":{"a":{"type":"strng"},"b":{"type":"loop"},"c":{"type":"enum"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["a",2,"x"],["b",2,"x"],["c",2,"x"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"type-reserved","message":"markdag.types.string は組み込みの型と同じ名前なので定義できません","hint":"別の名前にします","path":["markdag","types","string"],"at":null},{"severity":"warning","code":"type-unknown","message":"markdag.tags.keys.a の型「strng」は、組み込みの型にも markdag.types にもありません","hint":"もしかして「string」","path":["markdag","tags","keys","a","type"],"at":null},{"severity":"warning","code":"type-cycle","message":"型「loop」の定義が自分自身に戻っています (loop → loop)","hint":"型の type には、自分より基底の型を書きます","path":["markdag","types","loop","type"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.tags.keys.c は enum なので values (許す値の一覧) が要ります","hint":"values: の下に、許す値を「- high」の形で 1 行ずつ並べます","path":["markdag","tags","keys","c","values"],"at":null}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_invalid_definition_used_type() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{"bad":{"type":"number","pattern":"x","min":"1"}},"path":["markdag","types"]}],"keys":{"a":{"type":"bad"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["a",2,"x"],["b",2,"x"],["c",2,"x"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"type-invalid","message":"markdag.types.bad の pattern は string の型にだけ書けます (この型は number)","hint":null,"path":["markdag","types","bad","pattern"],"at":null},{"severity":"warning","code":"type-invalid","message":"markdag.types.bad の min は、number の型では数値で書きます","hint":null,"path":["markdag","types","bad","min"],"at":null},{"severity":"warning","code":"tag-type","message":"「A」の #a:x: 数値で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_ref_sources_later_wins() {
        check_lint(
            r##"{"sources":[{"label":"./a.yaml","defs":{"level":{"type":"integer","max":3}},"path":null},{"label":"./b.yaml","defs":{"level":{"type":"integer","max":5}},"path":null},{"label":"markdag.types","defs":{"$ref":["./a.yaml","./b.yaml"]},"path":["markdag","types"]}],"keys":{"p":{"type":"level"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"4"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_ref_sources_document_wins() {
        check_lint(
            r##"{"sources":[{"label":"./a.yaml","defs":{"level":{"type":"integer","max":3}},"path":null},{"label":"./b.yaml","defs":{"level":{"type":"integer","max":5}},"path":null},{"label":"markdag.types","defs":{"$ref":["./a.yaml","./b.yaml"],"level":{"type":"integer","max":2}},"path":["markdag","types"]}],"keys":{"p":{"type":"level"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"4"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #p:4: 2 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した ($ref の b.yaml が読めない。読めた a.yaml の max: 3 には合わないが黙って通す。types-unresolved は model の診断なので含めない)
    #[test]
    fn tags_lint_ts_ref_unresolved_keeps_quiet() {
        check_lint(
            r##"{"sources":[{"label":"./a.yaml","defs":{"level":{"type":"integer","max":3}},"path":null},{"label":"markdag.types","defs":{},"path":["markdag","types"]}],"keys":{"p":{"type":"level"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"4"]]]],"options":{"severity":"warning","unknownKey":"allow"},"unresolved":true}"##,
            r##"[]"##,
        );
    }

    // test/model.test.ts から写した ('./b.yaml': null で、$ref が 2 つとも読めない)
    #[test]
    fn tags_lint_ts_ref_null_keeps_quiet() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{},"path":["markdag","types"]}],"keys":{"p":{"type":"level"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"4"]]]],"options":{"severity":"warning","unknownKey":"allow"},"unresolved":true}"##,
            r##"[]"##,
        );
    }

    // test/model.test.ts から写した (組み込みの型を直接書いたキーは、$ref が読めなくても検査する)
    #[test]
    fn tags_lint_ts_ref_unresolved_checks_builtin_key() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{},"path":["markdag","types"]}],"keys":{"p":{"type":"integer","max":3}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"4"]]]],"options":{"severity":"warning","unknownKey":"allow"},"unresolved":true}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #p:4: 3 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // test/model.test.ts から写した (buildModel の診断のうち、resolveTagKeys と lintTags が出すもの)
    #[test]
    fn tags_lint_ts_datetime_time_duration() {
        check_lint(
            r##"{"sources":[],"keys":{"start":{"type":"datetime","min":"2026-10-01T00:00"},"at":{"type":"time","max":"18:00"},"est":{"type":"duration","max":"2d"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["start",2,"2026-10-01T09:30"],["at",2,"17:59:30"],["est",2,"1.5d"],["start",2,"2026-10-01 09:30+09:00"]]],["B",null,[["start",3,"2026-09-30T23:59"],["at",3,"18:01"],["est",3,"3d"],["est",3,"2 days"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「B」の #start:2026-09-30T23:59: 2026-10-01T00:00 以上で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #at:18:01: 18:00 以下で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #est:3d: 2d 以下で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #est:\"2 days\": 30m / 2h / 3d / 1w のような期間で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_unique_same_value_twice_on_one_tag() {
        check_lint(
            r##"{"sources":[],"keys":{"owner":{"type":"string","unique":true,"multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["owner",2,"x","x"]]],["B",null,[["owner",3,"y"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-unique","message":"「A」の #owner:x,x は、ほかのノードにも書かれています (2 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「A」の #owner:x,x は、ほかのノードにも書かれています (2 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_unique_across_three_nodes_and_rejected_values() {
        check_lint(
            r##"{"sources":[],"keys":{"id":{"type":"integer","unique":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["id",2,"z"]]],["B",null,[["id",3,"z"]]],["C",null,[["id",4,"z"]]],["D",null,[["id",5,"1"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #id:z: 整数で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「B」の #id:z: 整数で書きます","hint":null,"path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「C」の #id:z: 整数で書きます","hint":null,"path":null,"at":{"line":4,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「A」の #id:z は、ほかのノードにも書かれています (3 行目、4 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「B」の #id:z は、ほかのノードにも書かれています (2 行目、4 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":3,"column":1,"length":1}},{"severity":"warning","code":"tag-unique","message":"「C」の #id:z は、ほかのノードにも書かれています (2 行目、3 行目)","hint":"unique のキーなので、値を変えるか片方を消します","path":null,"at":{"line":4,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_multiple_values_not_allowed_still_checks_each() {
        check_lint(
            r##"{"sources":[],"keys":{"n":{"type":"integer"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["n",2,"1","x","y z"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-multiple","message":"「A」の #n:1,x,\"y z\" は値を 1 つだけ書くキーです","hint":"複数の値を許すなら markdag.tags.keys.n に multiple: true を書きます","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #n:1,x,\"y z\": 整数で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #n:1,x,\"y z\": 整数で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_missing_value_with_and_without_boolean() {
        check_lint(
            r##"{"sources":[],"keys":{"flag":{"type":["integer","boolean"]},"size":{"type":["integer","enum"],"values":["s","m"],"min":1},"note":{}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["flag",2],["size",2],["note",2]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-missing-value","message":"「A」の #size には値が要ります (整数 (1 以上)、s / m のどれか)","hint":"#size:値 の形で書きます","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-missing-value","message":"「A」の #note には値が要ります (文字列)","hint":"#note:値 の形で書きます","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_enum_closest_hint() {
        check_lint(
            r##"{"sources":[],"keys":{"p":{"type":"enum","values":["high","medium","low"]}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["p",2,"hihg"],["p",2,"zzzzzz"],["p",2,"low"],["p",2,"mediu"],["p",2,""]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #p:hihg: high / medium / low のどれかで書きます","hint":"もしかして「high」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #p:zzzzzz: high / medium / low のどれかで書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #p:mediu: high / medium / low のどれかで書きます","hint":"もしかして「medium」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #p:: high / medium / low のどれかで書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_node_id_zero_one_many() {
        check_lint(
            r##"{"sources":[],"keys":{"dep":{"type":"nodeId","multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A","api",[["dep",2,"$ap","$zzzz","$web","$dup","$api","api"]]],["B","dup",[]],["C","dup",[]],["D","web",[]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #dep:$ap,$zzzz,$web,$dup,$api,api: $ap を持つノードがありません","hint":"もしかして「$api」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #dep:$ap,$zzzz,$web,$dup,$api,api: $zzzz を持つノードがありません","hint":"行末に $名前 を付けたノードを指します","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #dep:$ap,$zzzz,$web,$dup,$api,api: $dup を持つノードが 2 個あります","hint":"同じ $id を 2 つ以上のノードに書かないようにします","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #dep:$ap,$zzzz,$web,$dup,$api,api: $名前 (行末に $名前 を付けたノード)で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_node_id_zero_without_any_ref_id() {
        check_lint(
            r##"{"sources":[],"keys":{"dep":{"type":"nodeId"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["dep",2,"$api"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #dep:$api: $api を持つノードがありません","hint":"行末に $名前 を付けたノードを指します","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_range_min_max() {
        check_lint(
            r##"{"sources":[],"keys":{"n":{"type":"number","min":1,"max":10,"multiple":true},"i":{"type":"integer","min":1e+21,"max":1e+22,"multiple":true},"d":{"type":"date","min":"2024-01-01","max":"2024-12-31","multiple":true},"t":{"type":"time","min":"09:00","max":"18:00","multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["n",2,"0.5","10.5","5","1","10"],["i",2,"1","100000000000000000000000"],["d",2,"2023-12-31","2025-01-01","2024-06-01"],["t",2,"08:59:59","18:00:01","12:00"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #n:0.5,10.5,5,1,10: 1 以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #n:0.5,10.5,5,1,10: 10 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #i:1,100000000000000000000000: 1e+21 以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #i:1,100000000000000000000000: 1e+22 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #d:2023-12-31,2025-01-01,2024-06-01: 2024-01-01 以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #d:2023-12-31,2025-01-01,2024-06-01: 2024-12-31 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #t:08:59:59,18:00:01,12:00: 09:00 以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #t:08:59:59,18:00:01,12:00: 18:00 以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_patterns_in_order_and_unicode() {
        check_lint(
            r##"{"sources":[],"keys":{"a":{"type":"string","pattern":"^\\p{L}+$","multiple":true},"b":{"type":"string","pattern":"x","multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["a",2,"äß日本","ab1","👍"],["b",2,"axb","ab"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #a:äß日本,ab1,👍: 「^\\p{L}+$」の形に合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #a:äß日本,ab1,👍: 「^\\p{L}+$」の形に合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #b:axb,ab: 「x」の形に合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_patterns_stacked_second_fails() {
        check_lint(
            r##"{"sources":[{"label":"markdag.types","defs":{"t":{"type":"string","pattern":"^a"}},"path":["markdag","types"]}],"keys":{"k":{"type":"t","pattern":"z$","multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["k",2,"baz","abz","ab"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #k:baz,abz,ab: 「^a」の形に合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #k:baz,abz,ab: 「z$」の形に合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_min_max_length_with_emoji() {
        check_lint(
            r##"{"sources":[],"keys":{"s":{"type":"string","minLength":2,"maxLength":3,"multiple":true}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["s",2,"👍","👍👍","👍👍👍","👍👍👍👍","é","𠮷野家"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #s:👍,👍👍,👍👍👍,👍👍👍👍,é,𠮷野家: 2 文字以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #s:👍,👍👍,👍👍👍,👍👍👍👍,é,𠮷野家: 3 文字以下で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #s:👍,👍👍,👍👍👍,👍👍👍👍,é,𠮷野家: 2 文字以上で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_alternatives_message_and_hint_choice() {
        check_lint(
            r##"{"sources":[],"keys":{"a":{"type":["integer","enum"],"values":["high","low"]},"b":{"type":["nodeId","enum"],"values":["$apx"]},"c":{"type":["enum","nodeId"],"values":["$apx"]},"d":{"type":["integer","date"]},"e":{"type":["enum"],"values":["x"]}},"tagKeys":null,"nodes":[["root",null,[]],["A","api",[["a",2,"hgh"],["a",2,"zzzzzz"],["b",2,"$ap"],["c",2,"$ap"],["d",2,"x y"],["e",2,"y"]]]],"options":{"severity":"warning","unknownKey":"allow"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #a:hgh の「hgh」は 整数、high / low のどれか のどれにも合いません","hint":"もしかして「high」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #a:zzzzzz の「zzzzzz」は 整数、high / low のどれか のどれにも合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #b:$ap の「$ap」は $名前 (行末に $名前 を付けたノード)、$apx のどれか のどれにも合いません","hint":"もしかして「$api」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #c:$ap の「$ap」は $apx のどれか、$名前 (行末に $名前 を付けたノード) のどれにも合いません","hint":"もしかして「$apx」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #d:\"x y\" の「x y」は 整数、YYYY-MM-DD の日付 のどれにも合いません","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-type","message":"「A」の #e:y: x のどれかで書きます","hint":"もしかして「x」","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_unknown_key_deny_hint_and_allow() {
        check_lint(
            r##"{"sources":[],"keys":{"owner":{"type":"string"},"owners":{}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["ownr",2,"a"],["zzz",2],["owner",2,"a b"]]]],"options":{"severity":"warning","unknownKey":"deny"}}"##,
            r##"[{"severity":"warning","code":"tag-unknown-key","message":"「A」の #ownr:a は、markdag.tags.keys に定義のないキーです","hint":"もしかして「owner」","path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-unknown-key","message":"「A」の #zzz は、markdag.tags.keys に定義のないキーです","hint":"keys に定義するか、unknownKey を allow にします","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_unknown_key_allow_error_severity() {
        check_lint(
            r##"{"sources":[],"keys":{"owner":{"type":"string"},"n":{"type":"number"}},"tagKeys":null,"nodes":[["root",null,[]],["A",null,[["ownr",2,"a"],["n",2,"x"]]]],"options":{"severity":"error","unknownKey":"allow"}}"##,
            r##"[{"severity":"error","code":"tag-type","message":"「A」の #n:x: 数値で書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    // 期待値は node で原文を動かして取った
    #[test]
    fn tags_lint_duplicate_key_defs_later_wins() {
        check_lint(
            r##"{"sources":[],"keys":{},"tagKeys":[{"key":"k","alternatives":[{"primitive":"integer"}],"multiple":false,"unique":false,"description":null},{"key":"j","alternatives":[{"primitive":"integer"}],"multiple":false,"unique":false,"description":null},{"key":"k","alternatives":[{"primitive":"boolean"}],"multiple":false,"unique":false,"description":null}],"nodes":[["root",null,[]],["A",null,[["k",2,"1"],["kk",2]]]],"options":{"severity":"warning","unknownKey":"deny"}}"##,
            r##"[{"severity":"warning","code":"tag-type","message":"「A」の #k:1: true か false のどちらかで書きます","hint":null,"path":null,"at":{"line":2,"column":1,"length":1}},{"severity":"warning","code":"tag-unknown-key","message":"「A」の #kk は、markdag.tags.keys に定義のないキーです","hint":"もしかして「k」","path":null,"at":{"line":2,"column":1,"length":1}}]"##,
        );
    }

    fn suggestions(items: Vec<TagKeySuggestion>) -> serde_json::Value {
        serde_json::to_value(items).expect("出力の JSON")
    }

    // test/model.test.ts から写した (編集側の候補)
    #[test]
    fn tags_suggest_ts_keys_and_values() {
        let raw: IndexMap<String, JsValue> = serde_json::from_str(
            r##"{"priority": {"type": "enum", "values": ["high", "medium", "low"], "description": "優先度"}, "estimate": {"type": "number", "min": 0}, "due": {"type": "date"}, "urgent": {"type": "boolean"}, "id": {"type": "string", "pattern": "^T-\\\\d+$", "unique": true}, "blockedBy": {"type": "nodeId"}, "owner": {"type": "string", "multiple": true}}"##,
        )
        .expect("入力の JSON");
        let keys = resolve_tag_keys(&[], &raw, &[], false).keys;
        let expected: serde_json::Value =
            serde_json::from_str(r##"[{"key": "priority", "description": "優先度"}]"##)
                .expect("期待値の JSON");
        assert_eq!(suggestions(suggest_tag_keys(&keys, Some("p"))), expected);
        let all: Vec<String> = suggest_tag_keys(&keys, None)
            .into_iter()
            .map(|item| item.key)
            .collect();
        assert_eq!(
            all,
            vec![
                "priority",
                "estimate",
                "due",
                "urgent",
                "id",
                "blockedBy",
                "owner"
            ]
        );
        assert_eq!(
            suggest_tag_values(&keys, "priority", Some("h")),
            vec!["high"]
        );
        assert_eq!(
            suggest_tag_values(&keys, "urgent", None),
            vec!["true", "false"]
        );
        assert!(suggest_tag_values(&keys, "due", None).is_empty());
        assert!(suggest_tag_values(&keys, "nothing", None).is_empty());
    }

    // 期待値は node で原文を動かして取った (重複を除いて最初の出現の順、prefix で絞る)
    #[test]
    fn tags_suggest_dedupes_in_first_seen_order() {
        let keys: Vec<TagKeyDef> = serde_json::from_str(r##"[{"key":"mix","alternatives":[{"primitive":"enum","values":["b","a","true"]},{"primitive":"boolean"},{"primitive":"integer"}],"multiple":false,"unique":false,"description":null},{"key":"only","alternatives":[{"primitive":"enum","values":["x","y","x"]}],"multiple":false,"unique":false,"description":null},{"key":"pa","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null},{"key":"pb","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":"B"},{"key":"q","alternatives":[{"primitive":"string"}],"multiple":false,"unique":false,"description":null}]"##).expect("入力の JSON");
        assert_eq!(
            suggest_tag_values(&keys, "mix", None),
            vec!["b", "a", "true", "false"]
        );
        assert_eq!(suggest_tag_values(&keys, "mix", Some("t")), vec!["true"]);
        assert_eq!(suggest_tag_values(&keys, "only", None), vec!["x", "y"]);
        assert_eq!(suggest_tag_values(&keys, "only", Some("")), vec!["x", "y"]);
        let expected: serde_json::Value = serde_json::from_str(
            r##"[{"key": "pa", "description": null}, {"key": "pb", "description": "B"}]"##,
        )
        .expect("期待値の JSON");
        assert_eq!(suggestions(suggest_tag_keys(&keys, Some("p"))), expected);
        assert!(suggest_tag_keys(&keys, Some("zz")).is_empty());
        let expected: serde_json::Value = serde_json::from_str(r##"[{"key": "mix", "description": null}, {"key": "only", "description": null}, {"key": "pa", "description": null}, {"key": "pb", "description": "B"}, {"key": "q", "description": null}]"##).expect("期待値の JSON");
        assert_eq!(suggestions(suggest_tag_keys(&keys, Some(""))), expected);
    }
}

// PORT STATUS: confidence=high todos=1

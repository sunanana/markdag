// markdag.icons の alias の定義の読み取り。文書の定義と、呼び出し側が読んで渡した $ref のファイルの中身を重ね、
// 正規化した表 (IconTable) と診断の元 (IconIssue) を返す。
// alias の値は set:name (Iconify の流儀)、文書からの相対パスの SVG、絵文字 1 文字、それらを ref に持つオブジェクト形 ({ ref, color })。
// 値が指す実体 (SVG) の解決はここでは行わない。markdag はファイルもネットワークも読まない (types.$ref、hooks.$ref と同じ)。
// 文書に書いた値の型の誤り (文字列でもオブジェクトでもない、など) はスキーマが警告にするので、ここでは $ref のファイルの中の分だけ知らせる。
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::model::util::{JsValue, closest, js_json_stringify};
use crate::types::{IconColor, IconDef, IconKind, IconTable, PathStep, Severity, SourcePath};

/// alias にできない名前 (markdag.icons の設定のキー)
pub(crate) const RESERVED_ICON_KEYS: &[&str] = &["$ref", "color"];

/// alias の名前の字の並び (アンカーなし)。frontmatter の alias の名前と、解析が書いた印の要素を読む正規表現が共有する。
/// 本文の印の取り出し (字ごとの判定) も同じ並びを受ける
pub(crate) const ALIAS_PATTERN: &str = "[a-z][a-z0-9_-]*";

// 大文字は許さない ($id とは違う)。本文の :alias: の印の規則 (英小文字で始める) に合わせる
pub(crate) static ALIAS_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^{ALIAS_PATTERN}$")).expect("固定の正規表現"));
// Iconify のアイコンの名前 (prefix:name)。どちらも英小文字と数字を - か _ でつなぐ
static SET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9]+(?:[-_][a-z0-9]+)*:[a-z0-9]+(?:[-_][a-z0-9]+)*$")
        .expect("固定の正規表現")
});
// 絵文字 1 文字 (見た目の 1 字)。国旗 (地域指示子 2 つ)、キーキャップ、タグ列の旗、
// 絵文字に異体字セレクタと肌の色を添え ZWJ でつないだ列を 1 字とみなす
// 書記素クラスタの判定の近似で、Unicode の emoji-test の全件とは突き合わせていない
static EMOJI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^(?:\p{Regional_Indicator}{2}",
        r"|[0-9#*]\x{FE0F}?\x{20E3}",
        r"|\x{1F3F4}[\x{E0061}-\x{E007A}]+\x{E007F}",
        r"|\p{Extended_Pictographic}\x{FE0F}?\p{Emoji_Modifier}?(?:\x{200D}\p{Extended_Pictographic}\x{FE0F}?\p{Emoji_Modifier}?)*)$",
    ))
    .expect("固定の正規表現")
});
static WINDOWS_DRIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("固定の正規表現"));
static EXTENSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.([A-Za-z0-9]+)$").expect("固定の正規表現"));

const VALUE_HINT: &str = "set:name の形 (simple-icons:github)、./images/x.svg のような SVG の相対パス、絵文字 1 文字のどれかを書きます";
const RESERVED_HINT: &str =
    "$ref と color は markdag.icons の設定の名前なので alias にできません。別の名前にします";

/// alias の定義の読み取りで見つかった問題。呼び出し側が Diagnostic に直す。
/// at_key が真なら path のキーの位置、偽なら値の位置を指す
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct IconIssue {
    pub(crate) severity: Severity,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) hint: Option<String>,
    pub(crate) path: SourcePath,
    pub(crate) at_key: bool,
}

/// resolve_icons の戻り値
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolveIconsResult {
    pub(crate) table: IconTable,
    pub(crate) issues: Vec<IconIssue>,
}

// 値の誤り。Shape はスキーマが見る型の誤りなので、文書に書いたものは知らせない
enum ValueError {
    Shape(String, String),
    Content {
        code: &'static str,
        detail: String,
        hint: String,
        sub: Option<&'static str>,
    },
}

fn key(name: &str) -> PathStep {
    PathStep::Key(name.to_string())
}

fn icons_path() -> SourcePath {
    vec![key("markdag"), key("icons")]
}

// markdag.icons.$ref に書いた ref と、その道すじ。配列なら道すじに元の添字を使い、
// 文字列でない項目はスキーマが警告にしているので飛ばす
fn listed_refs(own: &IndexMap<String, JsValue>) -> Vec<(SourcePath, &String)> {
    let path_at = |index: Option<usize>| {
        let mut path = icons_path();
        path.push(key("$ref"));
        path.extend(index.map(PathStep::Index));
        path
    };
    match own.get("$ref") {
        Some(JsValue::String(one)) => vec![(path_at(None), one)],
        Some(JsValue::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| match item {
                JsValue::String(text) => Some((path_at(Some(index)), text)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// 文字列の値を、どの種類の参照かに分ける。誤りは (説明, 手がかり)
pub(crate) fn classify_icon_ref(text: &str) -> Result<(IconKind, String), (String, String)> {
    if EMOJI.is_match(text) {
        return Ok((IconKind::Emoji, text.to_string()));
    }
    if SET_NAME.is_match(text) {
        return Ok((IconKind::Set, text.to_string()));
    }
    if text.is_empty() {
        return Err(("値が空です".to_string(), VALUE_HINT.to_string()));
    }
    if WINDOWS_DRIVE.is_match(text) || text.starts_with('/') || text.starts_with('\\') {
        return Err((
            "文書からの相対パスで書きます".to_string(),
            "./images/x.svg のように、文書の場所からの相対パスで書きます".to_string(),
        ));
    }
    if text.contains("://") || text.starts_with("data:") {
        // markdag はネットワークを読まないので、URL の SVG は誤り
        return Err((
            "URL は書けません".to_string(),
            "ロゴのファイルを文書の近くに置いて ./images/x.svg のように書くか、set:name の形 (simple-icons:github) で書きます".to_string(),
        ));
    }
    if text.contains(':') {
        let hint = if SET_NAME.is_match(&text.to_lowercase()) {
            "set:name は英小文字で書きます (simple-icons:github)".to_string()
        } else {
            VALUE_HINT.to_string()
        };
        return Err(("set:name の形として読めません".to_string(), hint));
    }
    let relative = text.starts_with("./") || text.starts_with("../");
    let extension = EXTENSION
        .captures(text)
        .and_then(|found| found.get(1))
        .map(|found| found.as_str().to_lowercase());
    // 値に別の alias の名前 (github) を書いて引く書き方はない。読めない値として誤りにする
    if !(relative || text.contains('/') || extension.is_some()) {
        return Err((
            "alias の値として読めません".to_string(),
            VALUE_HINT.to_string(),
        ));
    }
    match extension.as_deref() {
        Some("svg") => Ok((IconKind::Path, text.to_string())),
        // 画像は SVG だけ (mono は inline の SVG でしか効かない)。この alias は使えず、本文の :alias: は文字のまま残る
        Some(other) => Err((
            format!("画像は SVG だけ使えます (.{other} は使えません)"),
            "SVG にして ./images/x.svg のように書きます。この alias は使えないので、本文の印は文字のまま残ります".to_string(),
        )),
        None => Err((
            "画像のファイルは拡張子 .svg まで書きます".to_string(),
            "./images/x.svg のように、SVG のファイルを文書からの相対パスで書きます".to_string(),
        )),
    }
}

fn read_color(value: &JsValue) -> Option<IconColor> {
    IconColor::from_js(value)
}

fn color_choices() -> Vec<String> {
    IconColor::ALL
        .iter()
        .map(|color| color.as_str().to_string())
        .collect()
}

// alias 1 つの値を IconDef にする
fn read_alias(value: &JsValue) -> Result<IconDef, ValueError> {
    match value {
        JsValue::String(text) => classify_icon_ref(text)
            .map(|(kind, ref_text)| IconDef {
                kind,
                ref_text,
                color: None,
            })
            .map_err(|(detail, hint)| ValueError::Content {
                code: "icon-invalid",
                detail: format!("「{text}」: {detail}"),
                hint,
                sub: None,
            }),
        JsValue::Object(entries) => {
            if let Some(unknown) = entries
                .keys()
                .find(|name| !["ref", "color"].contains(&name.as_str()))
            {
                return Err(ValueError::Shape(
                    format!("のキー「{unknown}」は使えません (ref, color)"),
                    "{ ref: simple-icons:github, color: original } のように ref と color だけを書きます".to_string(),
                ));
            }
            let color = match entries.get("color") {
                None => None,
                Some(raw) => match read_color(raw) {
                    Some(color) => Some(color),
                    None => {
                        return Err(ValueError::Shape(
                            format!(
                                ".color に指定できるのは mono, original です ({})",
                                js_json_stringify(raw)
                            ),
                            "mono か original のどちらかを書きます".to_string(),
                        ));
                    }
                },
            };
            match entries.get("ref") {
                Some(JsValue::String(text)) => classify_icon_ref(text)
                    .map(|(kind, ref_text)| IconDef {
                        kind,
                        ref_text,
                        color,
                    })
                    .map_err(|(detail, hint)| ValueError::Content {
                        code: "icon-invalid",
                        detail: format!(".ref「{text}」: {detail}"),
                        hint,
                        sub: Some("ref"),
                    }),
                Some(other) => Err(ValueError::Shape(
                    format!(".ref は文字列で書きます ({})", js_json_stringify(other)),
                    VALUE_HINT.to_string(),
                )),
                None => Err(ValueError::Content {
                    code: "icon-invalid",
                    detail: " に ref がありません".to_string(),
                    hint: "{ ref: simple-icons:github, color: original } のように ref を書きます"
                        .to_string(),
                    sub: None,
                }),
            }
        }
        other => Err(ValueError::Shape(
            format!(
                " は文字列かキーと値の組で書きます ({})",
                js_json_stringify(other)
            ),
            VALUE_HINT.to_string(),
        )),
    }
}

/// markdag.icons と、呼び出し側が渡した $ref のファイルの中身 (provided、$ref に書いた文字列をキーに YAML を読んだ値。
/// 読めなければ Null) から、alias の表を作る。重ねる順は $ref の一覧の順、最後にこの文書の定義 (後のものが勝つ)
pub(crate) fn resolve_icons(
    raw: &JsValue,
    provided: Option<&IndexMap<String, JsValue>>,
) -> ResolveIconsResult {
    let mut issues: Vec<IconIssue> = Vec::new();
    let mut table = IconTable::default();
    let JsValue::Object(own) = raw else {
        return ResolveIconsResult { table, issues };
    };

    for (path, ref_text) in listed_refs(own) {
        // キーがないか値が Undefined は「渡していない」、Null などオブジェクトでない値は「読めなかった」(types.$ref と同じ)
        let loaded = provided
            .and_then(|files| files.get(ref_text.as_str()))
            .filter(|value| !matches!(value, JsValue::Undefined));
        let Some(JsValue::Object(entries)) = loaded else {
            issues.push(IconIssue {
                severity: Severity::Warning,
                code: "icons-unresolved".to_string(),
                message: format!("markdag.icons.$ref「{ref_text}」を読めなかったので、その中の alias は使えません"),
                hint: Some(if loaded.is_none() {
                    "呼び出し側が読んで buildModel の icons に渡します (npm run check は文書の場所からの相対で読みます)".to_string()
                } else {
                    "ファイルが YAML のキーと値の組 (alias: 値) として読めるか確かめます".to_string()
                }),
                path,
                at_key: false,
            });
            continue;
        };
        let label = format!("markdag.icons.$ref「{ref_text}」");
        for (name, value) in entries {
            if RESERVED_ICON_KEYS.contains(&name.as_str()) {
                // $ref のファイルの中では color (ファイル単位の既定の色) も $ref (入れ子の読み込み) も効かない。予約語として飛ばす
                issues.push(IconIssue {
                    severity: Severity::Warning,
                    code: "icon-invalid".to_string(),
                    message: format!("{label} のキー「{name}」は予約語なので alias にできません"),
                    hint: Some(RESERVED_HINT.to_string()),
                    path: path.clone(),
                    at_key: false,
                });
                continue;
            }
            if !ALIAS_NAME.is_match(name) {
                issues.push(name_issue(
                    &format!("{label} のキー「{name}」"),
                    name,
                    path.clone(),
                    false,
                ));
                continue;
            }
            match read_alias(value) {
                Ok(def) => {
                    table.aliases.insert(name.clone(), def);
                }
                // $ref のファイルの中はスキーマが見ないので、型の誤りも内容の誤りと同じく知らせる
                Err(error) => {
                    let (code, detail, hint) = match error {
                        ValueError::Shape(detail, hint) => ("icon-invalid", detail, hint),
                        ValueError::Content {
                            code, detail, hint, ..
                        } => (code, detail, hint),
                    };
                    issues.push(IconIssue {
                        severity: Severity::Warning,
                        code: code.to_string(),
                        message: format!("{label} の {name}{detail}"),
                        hint: Some(hint),
                        path: path.clone(),
                        at_key: false,
                    });
                }
            }
        }
    }

    for (name, value) in own {
        match name.as_str() {
            "$ref" => continue,
            "color" => {
                let mut path = icons_path();
                path.push(key("color"));
                // 文字列でもオブジェクトでもない値はスキーマが警告にしている
                if !matches!(value, JsValue::String(_) | JsValue::Object(_)) {
                    continue;
                }
                // 空の文字列はスキーマの minLength が同じ位置で知らせている (空の値は 1 件)
                if matches!(value, JsValue::String(text) if text.is_empty()) {
                    continue;
                }
                if let Some(color) = read_color(value) {
                    table.color = color;
                    continue;
                }
                // alias のつもりで color と名付けたらしい値 (ロゴの参照として読める値) には、予約語であることを添える
                let looks_like_alias = match value {
                    JsValue::String(text) => classify_icon_ref(text).is_ok(),
                    _ => true,
                };
                let hint = if looks_like_alias {
                    RESERVED_HINT.to_string()
                } else {
                    match value {
                        JsValue::String(text) => closest(text, &color_choices())
                            .map(|near| format!("もしかして「{near}」"))
                            .unwrap_or_else(|| {
                                "mono (文字の色で塗る) か original (ロゴの元の色) を書きます"
                                    .to_string()
                            }),
                        _ => "mono (文字の色で塗る) か original (ロゴの元の色) を書きます"
                            .to_string(),
                    }
                };
                issues.push(IconIssue {
                    severity: Severity::Warning,
                    code: "option-invalid".to_string(),
                    message: format!(
                        "markdag.icons.color に指定できるのは mono, original です ({})",
                        js_json_stringify(value)
                    ),
                    hint: Some(hint),
                    path,
                    at_key: false,
                });
            }
            _ => {
                let mut path = icons_path();
                path.push(key(name));
                if !ALIAS_NAME.is_match(name) {
                    issues.push(name_issue(
                        &format!("markdag.icons のキー「{name}」"),
                        name,
                        path,
                        true,
                    ));
                    continue;
                }
                match read_alias(value) {
                    Ok(def) => {
                        // 文書の定義が最優先。$ref から来た同じ alias の位置は保ったまま上書きする
                        table.aliases.insert(name.clone(), def);
                    }
                    Err(ValueError::Shape(..)) => {}
                    // 空の値 (文字列の形と .ref) はスキーマの minLength が同じ位置で知らせている
                    Err(ValueError::Content { .. }) if is_empty_ref(value) => {}
                    Err(ValueError::Content {
                        code,
                        detail,
                        hint,
                        sub,
                    }) => {
                        if let Some(sub) = sub {
                            path.push(key(sub));
                        }
                        issues.push(IconIssue {
                            severity: Severity::Warning,
                            code: code.to_string(),
                            message: format!("markdag.icons.{name}{detail}"),
                            hint: Some(hint),
                            path,
                            at_key: false,
                        });
                    }
                }
            }
        }
    }
    ResolveIconsResult { table, issues }
}

// alias の値の参照が空の文字列か (文字列の形と、オブジェクトの形の ref)
fn is_empty_ref(value: &JsValue) -> bool {
    match value {
        JsValue::String(text) => text.is_empty(),
        JsValue::Object(entries) => {
            matches!(entries.get("ref"), Some(JsValue::String(text)) if text.is_empty())
        }
        _ => false,
    }
}

/// 大文字を含むだけで alias の名前にならないとき、小文字にした名前を「もしかして」で示す手がかり。
/// alias の名前を書く所 (表のキー、タグの対応、グループの icon) が共有する
pub(crate) fn lowercase_alias_hint(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    (lower != name && ALIAS_NAME.is_match(&lower))
        .then(|| format!("もしかして「{lower}」(alias は英小文字で書きます)"))
}

fn name_issue(subject: &str, name: &str, path: SourcePath, at_key: bool) -> IconIssue {
    let hint = lowercase_alias_hint(name).unwrap_or_else(|| {
        "英小文字で始め、英小文字と数字、- と _ だけで書きます (本文では :github: の形で使います)"
            .to_string()
    });
    IconIssue {
        severity: Severity::Warning,
        code: "icon-invalid".to_string(),
        message: format!("{subject}は alias の名前に使えません"),
        hint: Some(hint),
        path,
        at_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn js(value: serde_json::Value) -> JsValue {
        serde_json::from_value(value).expect("JsValue に読める")
    }

    fn codes(result: &ResolveIconsResult) -> Vec<&str> {
        result
            .issues
            .iter()
            .map(|issue| issue.code.as_str())
            .collect()
    }

    #[test]
    fn 三種の値と既定の色を正規化する() {
        let result = resolve_icons(
            &js(
                json!({ "github": "simple-icons:github", "logo": "./images/our-logo.svg", "fire": "🔥", "aws-lambda": "logos:aws-lambda" }),
            ),
            None,
        );
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(result.table.color, IconColor::Mono);
        let kinds: Vec<(&str, IconKind, &str)> = result
            .table
            .aliases
            .iter()
            .map(|(name, def)| (name.as_str(), def.kind, def.ref_text.as_str()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("github", IconKind::Set, "simple-icons:github"),
                ("logo", IconKind::Path, "./images/our-logo.svg"),
                ("fire", IconKind::Emoji, "🔥"),
                ("aws-lambda", IconKind::Set, "logos:aws-lambda"),
            ]
        );
    }

    #[test]
    fn 絵文字は1字だけを受ける() {
        for one in ["🔥", "👍🏽", "🇯🇵", "👨‍👩‍👧", "❤️", "#️⃣"] {
            assert!(
                matches!(classify_icon_ref(one), Ok((IconKind::Emoji, _))),
                "{one}"
            );
        }
        for many in ["🔥🔥", "🔥a", "a", "日"] {
            assert!(classify_icon_ref(many).is_err(), "{many}");
        }
    }

    #[test]
    fn オブジェクト形は_alias_ごとの色を持つ() {
        let result = resolve_icons(
            &js(
                json!({ "color": "original", "vm": { "ref": "./azure/vm.svg", "color": "original" }, "gh": { "ref": "simple-icons:github" } }),
            ),
            None,
        );
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(result.table.color, IconColor::Original);
        assert_eq!(
            result.table.aliases["vm"],
            IconDef {
                kind: IconKind::Path,
                ref_text: "./azure/vm.svg".to_string(),
                color: Some(IconColor::Original)
            }
        );
        assert_eq!(result.table.aliases["gh"].color, None);
        let missing = resolve_icons(&js(json!({ "vm": { "color": "mono" } })), None);
        assert_eq!(codes(&missing), ["icon-invalid"]);
    }

    #[test]
    fn 予約語の_color_に_alias_を書くと予約語だと知らせる() {
        let result = resolve_icons(&js(json!({ "color": "simple-icons:github" })), None);
        assert_eq!(codes(&result), ["option-invalid"]);
        assert_eq!(result.issues[0].hint.as_deref(), Some(RESERVED_HINT));
        let typo = resolve_icons(&js(json!({ "color": "orignal" })), None);
        assert_eq!(
            typo.issues[0].hint.as_deref(),
            Some("もしかして「original」")
        );
        assert_eq!(typo.table.color, IconColor::Mono);
    }

    #[test]
    fn 不正な名前と値は使わずに知らせる() {
        let result = resolve_icons(
            &js(
                json!({ "GitHub": "simple-icons:github", "1st": "simple-icons:one", "shot": "./images/x.png", "bare": "github", "web": "https://example.com/x.svg", "abs": "/x.svg" }),
            ),
            None,
        );
        assert_eq!(codes(&result), ["icon-invalid"; 6]);
        assert!(result.table.aliases.is_empty());
        assert_eq!(
            result.issues[0].hint.as_deref(),
            Some("もしかして「github」(alias は英小文字で書きます)")
        );
        assert!(result.issues[0].at_key);
        assert!(
            result.issues[2].message.contains(".png"),
            "{}",
            result.issues[2].message
        );
    }

    // 文書に書いた空の値はスキーマの minLength が知らせるので黙る。スキーマが見ない $ref のファイルの中は知らせる
    #[test]
    fn 空の値は文書ではスキーマに任せ_ref_のファイルでは知らせる() {
        let own = resolve_icons(
            &js(
                json!({ "empty": "", "blank": { "ref": "" }, "tinted": { "ref": "", "color": "mono" } }),
            ),
            None,
        );
        assert!(own.issues.is_empty(), "{:?}", own.issues);
        assert!(own.table.aliases.is_empty());
        let provided: IndexMap<String, JsValue> = [(
            "./a.yaml".to_string(),
            js(json!({ "empty": "", "blank": { "ref": "" } })),
        )]
        .into_iter()
        .collect();
        let from_file = resolve_icons(&js(json!({ "$ref": "./a.yaml" })), Some(&provided));
        let messages: Vec<&str> = from_file
            .issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect();
        assert_eq!(
            messages,
            [
                "markdag.icons.$ref「./a.yaml」 の empty「」: 値が空です",
                "markdag.icons.$ref「./a.yaml」 の blank.ref「」: 値が空です",
            ]
        );
    }

    #[test]
    fn ref_は後のものが勝ち_文書の定義が最優先() {
        let provided: IndexMap<String, JsValue> = [
            ("./a.yaml".to_string(), js(json!({ "github": "simple-icons:github", "k8s": "simple-icons:kubernetes", "color": "original" }))),
            ("./b.yaml".to_string(), js(json!({ "github": "logos:github-icon", "aws": "logos:aws" }))),
            ("./broken.yaml".to_string(), JsValue::Null),
        ]
        .into_iter()
        .collect();
        let result = resolve_icons(
            &js(
                json!({ "$ref": ["./a.yaml", "./b.yaml", "./broken.yaml", "./missing.yaml"], "k8s": "./k8s.svg" }),
            ),
            Some(&provided),
        );
        assert_eq!(
            codes(&result),
            ["icon-invalid", "icons-unresolved", "icons-unresolved"]
        );
        let refs: Vec<(&str, &str)> = result
            .table
            .aliases
            .iter()
            .map(|(name, def)| (name.as_str(), def.ref_text.as_str()))
            .collect();
        assert_eq!(
            refs,
            [
                ("github", "logos:github-icon"),
                ("k8s", "./k8s.svg"),
                ("aws", "logos:aws")
            ]
        );
        // ファイルの中の color は文書全体の色にしない
        assert_eq!(result.table.color, IconColor::Mono);
        assert_eq!(result.issues[2].path.last(), Some(&PathStep::Index(3)));
    }

    #[test]
    fn 正規表現の_lazy_lock_をすべて一度触る() {
        assert!(ALIAS_NAME.is_match("aws-lambda_2"));
        assert!(!ALIAS_NAME.is_match("GitHub"));
        assert!(SET_NAME.is_match("simple-icons:github"));
        assert!(!SET_NAME.is_match("set:a-"));
        assert!(EMOJI.is_match("🔥"));
        assert!(!EMOJI.is_match("a"));
        assert!(WINDOWS_DRIVE.is_match("C:\\x.svg"));
        assert!(!WINDOWS_DRIVE.is_match("./x.svg"));
        assert_eq!(
            EXTENSION
                .captures("./a.b.SVG")
                .and_then(|found| found.get(1))
                .map(|found| found.as_str()),
            Some("SVG")
        );
    }

    // 「もしかして「x」(alias は英小文字で書きます)」は、大文字を小文字にすれば alias の名前になるときだけ付ける
    #[test]
    fn 名前の誤りの手がかりは大文字だけのときに小文字を示す() {
        let hints: Vec<(String, bool, Option<String>)> = [
            ("GitHub", true),
            ("AWS-Lambda_2", true),
            ("1st", true),
            ("Ab c", false),
            ("Ä", false),
        ]
        .into_iter()
        .map(|(name, at_key)| {
            let issue = name_issue(&format!("主語「{name}」"), name, icons_path(), at_key);
            assert_eq!(issue.code, "icon-invalid");
            assert_eq!(issue.severity, Severity::Warning);
            assert_eq!(issue.path, icons_path());
            (issue.message, issue.at_key, issue.hint)
        })
        .collect();
        let generic = Some(
            "英小文字で始め、英小文字と数字、- と _ だけで書きます (本文では :github: の形で使います)"
                .to_string(),
        );
        assert_eq!(
            hints,
            [
                (
                    "主語「GitHub」は alias の名前に使えません".to_string(),
                    true,
                    Some("もしかして「github」(alias は英小文字で書きます)".to_string())
                ),
                (
                    "主語「AWS-Lambda_2」は alias の名前に使えません".to_string(),
                    true,
                    Some("もしかして「aws-lambda_2」(alias は英小文字で書きます)".to_string())
                ),
                (
                    "主語「1st」は alias の名前に使えません".to_string(),
                    true,
                    generic.clone()
                ),
                (
                    "主語「Ab c」は alias の名前に使えません".to_string(),
                    false,
                    generic.clone()
                ),
                (
                    "主語「Ä」は alias の名前に使えません".to_string(),
                    false,
                    generic
                ),
            ]
        );
    }

    // 値の種類の判定。誤りは (説明, 手がかり) で、呼び出し側 (read_alias、グループの icon、タグの対応) が文に埋める
    #[test]
    fn 値の種類と誤りの文を分ける() {
        assert_eq!(
            classify_icon_ref("logos:aws"),
            Ok((IconKind::Set, "logos:aws".to_string()))
        );
        assert_eq!(
            classify_icon_ref("../shared/x.svg"),
            Ok((IconKind::Path, "../shared/x.svg".to_string()))
        );
        // 拡張子は大文字でもよく、./ を付けなくても / を含めばパス
        assert_eq!(
            classify_icon_ref("images/x.SVG"),
            Ok((IconKind::Path, "images/x.SVG".to_string()))
        );
        assert_eq!(
            classify_icon_ref("./x.png").map_err(|(what, _)| what),
            Err("画像は SVG だけ使えます (.png は使えません)".to_string())
        );
        let errors: Vec<(String, String)> = [
            "",
            "C:/x.svg",
            "/x.svg",
            "https://example.com/x.svg",
            "data:image/svg+xml,x",
            "Logos:AWS",
            "a:b:c",
            "github",
            "./x",
        ]
        .into_iter()
        .map(|text| classify_icon_ref(text).expect_err(text))
        .collect();
        let explanations: Vec<&str> = errors.iter().map(|(what, _)| what.as_str()).collect();
        assert_eq!(
            explanations,
            [
                "値が空です",
                "文書からの相対パスで書きます",
                "文書からの相対パスで書きます",
                "URL は書けません",
                "URL は書けません",
                "set:name の形として読めません",
                "set:name の形として読めません",
                "alias の値として読めません",
                "画像のファイルは拡張子 .svg まで書きます",
            ]
        );
        assert_eq!(
            errors[5].1,
            "set:name は英小文字で書きます (simple-icons:github)"
        );
        assert_eq!(errors[6].1, VALUE_HINT);
    }
}

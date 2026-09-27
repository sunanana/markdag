// タグの値とグループに添えるロゴの対応づけ (markdag.tags.keys.<key>.icons / icon と markdag.groups.<name>.icon)。
// frontmatter に書いた対応を、解決済みのタグの定義 (TagKeyDef) とグループの定義 (GroupDef) に載せ、
// markdag.icons の表にない alias と、使えない書き方を診断の元 (IconIssue) にする。
// alias が指す実体 (SVG) の解決と描画はここでは行わない (文書が使う ref の一覧 document_icon_defs までを受け持つ)。
// 型と形の誤り (文字列でない、alias の名前の形でない) はスキーマが知らせるので、ここでは黙って使わないだけにする。
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;

use crate::model::icons::{
    ALIAS_NAME, ALIAS_PATTERN, IconIssue, classify_icon_ref, lowercase_alias_hint,
};
use crate::model::util::{JsValue, closest, js_path_join};
use crate::parse::{ICON_ATTRIBUTE, ICON_CLASS, IconMark};
use crate::types::{
    Diagnostic, GraphModel, GroupDef, IconDef, IconKind, IconTable, OutlineNode, PathStep,
    Primitive, Severity, SourcePath, TagKeyDef,
};

const TAG_HINT: &str = "markdag.icons に定義した alias の名前 (github など) を書きます";
const GROUP_HINT: &str =
    "markdag.icons に定義した alias の名前 (aws) か、set:name の形 (logos:aws) を書きます";

fn path_of(steps: &[&str]) -> SourcePath {
    steps
        .iter()
        .map(|step| PathStep::Key((*step).to_string()))
        .collect()
}

fn label_of(path: &SourcePath) -> String {
    js_path_join(path)
}

fn warning(message: String, hint: String, path: SourcePath, at_key: bool) -> IconIssue {
    IconIssue {
        severity: Severity::Warning,
        code: "icon-invalid".to_string(),
        message,
        hint: Some(hint),
        path,
        at_key,
    }
}

// 表の alias のうち、表にない alias に近いもの (書いた順で最初の候補)
fn similar_alias(alias: &str, table: &IconTable) -> Option<String> {
    let names: Vec<&str> = table.aliases.keys().map(String::as_str).collect();
    closest(alias, &names)
}

// 表にない alias。本文の :alias: の icon-unknown と同じく、似た alias があれば「もしかして」を出す
fn unknown_alias(alias: &str, path: SourcePath, table: &IconTable) -> IconIssue {
    let hint = match similar_alias(alias, table) {
        Some(similar) => format!(
            "もしかして「{similar}」ですか。定義しなければ、ロゴなしで書いたとおりの文字を出します"
        ),
        None => format!(
            "markdag.icons に {alias}: を足して set:name か SVG のパスを書くとロゴになります。定義しなければ、ロゴなしで書いたとおりの文字を出します"
        ),
    };
    IconIssue {
        severity: Severity::Warning,
        code: "icon-unknown".to_string(),
        message: format!(
            "{} の「{alias}」は markdag.icons にない alias です",
            label_of(&path)
        ),
        hint: Some(hint),
        path,
        at_key: false,
    }
}

// タグの対応の右辺が alias の名前の形でないとき。set:name やパスは、markdag.icons に alias として定義してから使う
fn tag_alias_issue(text: &str, path: SourcePath) -> IconIssue {
    let hint = if let Some(hint) = lowercase_alias_hint(text) {
        hint
    } else if classify_icon_ref(text).is_ok() {
        format!(
            "タグの対応には alias の名前を書きます。markdag.icons に alias として定義し (例: logo: {text})、その名前を書きます"
        )
    } else {
        TAG_HINT.to_string()
    };
    warning(
        format!(
            "{} の「{text}」は alias の名前として読めません",
            label_of(&path)
        ),
        hint,
        path,
        false,
    )
}

// キーの型がすべて enum なら、許す値の和。それ以外の型を含むなら (どんな値でも来うるので) None
fn enum_values(def: &TagKeyDef) -> Option<Vec<String>> {
    if def.alternatives.is_empty()
        || def
            .alternatives
            .iter()
            .any(|alternative| alternative.primitive != Primitive::Enum)
    {
        return None;
    }
    let mut values: Vec<String> = Vec::new();
    for alternative in &def.alternatives {
        for value in alternative.values.iter().flatten() {
            if !values.contains(value) {
                values.push(value.clone());
            }
        }
    }
    Some(values)
}

/// markdag.tags.keys.<key>.icons (値 → alias) と icon (キーそのものの alias) を、解決済みのキーの定義に載せる。
/// check_unknown が偽なら、表にない alias を知らせない (icons.$ref が読めていないと、表の全体が分からないため)
pub(crate) fn attach_tag_icons(
    keys: &mut [TagKeyDef],
    raw_keys: &IndexMap<String, JsValue>,
    table: &IconTable,
    check_unknown: bool,
) -> Vec<IconIssue> {
    let mut issues: Vec<IconIssue> = Vec::new();
    for (key_name, raw) in raw_keys {
        let JsValue::Object(def) = raw else {
            continue;
        };
        let Some(target) = keys.iter_mut().find(|key| &key.key == key_name) else {
            continue;
        };
        let key_path = path_of(&["markdag", "tags", "keys", key_name]);
        // 空の文字と文字列でない値はスキーマが知らせている
        if let Some(JsValue::String(alias)) = def.get("icon")
            && !alias.is_empty()
        {
            let mut path = key_path.clone();
            path.push(PathStep::Key("icon".to_string()));
            if !ALIAS_NAME.is_match(alias) {
                issues.push(tag_alias_issue(alias, path));
            } else {
                if check_unknown && !table.aliases.contains_key(alias) {
                    issues.push(unknown_alias(alias, path, table));
                }
                target.icon = Some(alias.clone());
            }
        }
        let Some(JsValue::Object(entries)) = def.get("icons") else {
            continue;
        };
        let allowed = enum_values(target);
        let mut icons_path = key_path.clone();
        icons_path.push(PathStep::Key("icons".to_string()));
        for (value, alias) in entries {
            let JsValue::String(alias) = alias else {
                continue;
            };
            if alias.is_empty() {
                continue;
            }
            let mut path = icons_path.clone();
            path.push(PathStep::Key(value.clone()));
            if !ALIAS_NAME.is_match(alias) {
                issues.push(tag_alias_issue(alias, path));
                continue;
            }
            // enum のキーで values にない値は、どのタグにも付かない (付けば lint が別に知らせる) ので、書き間違いとして知らせる。
            // 対応は書いたとおりに残す (値の検査と対応づけは別。lint に落ちたタグの値も、書いたとおりの文字で出るため)
            if let Some(allowed) = &allowed
                && !allowed.contains(value)
            {
                let hint = match closest(value, allowed) {
                    Some(similar) => format!("もしかして「{similar}」"),
                    None => format!("values にある値 ({}) を書きます", allowed.join(", ")),
                };
                issues.push(warning(
                    format!(
                        "{} の「{value}」は、このキーの values にない値です",
                        label_of(&icons_path)
                    ),
                    hint,
                    path.clone(),
                    true,
                ));
            }
            if check_unknown && !table.aliases.contains_key(alias) {
                issues.push(unknown_alias(alias, path, table));
            }
            target.icons.insert(value.clone(), alias.clone());
        }
    }
    issues
}

/// markdag.groups.<name>.icon を、定義のあるグループに載せる。alias か set:name を受ける。
/// SVG のパスと絵文字は直接書けない (markdag.icons に alias として定義してから使う)
pub(crate) fn attach_group_icons(
    groups: &mut [GroupDef],
    groups_raw: &IndexMap<String, JsValue>,
    table: &IconTable,
    check_unknown: bool,
) -> Vec<IconIssue> {
    let mut issues: Vec<IconIssue> = Vec::new();
    for (id, raw) in groups_raw {
        let JsValue::Object(def) = raw else {
            continue;
        };
        // 空の文字はスキーマが知らせている
        let Some(JsValue::String(text)) = def.get("icon") else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let Some(group) = groups
            .iter_mut()
            .find(|group| group.defined && &group.id == id)
        else {
            continue;
        };
        let path = path_of(&["markdag", "groups", id, "icon"]);
        let label = label_of(&path);
        if ALIAS_NAME.is_match(text) {
            if check_unknown && !table.aliases.contains_key(text) {
                issues.push(unknown_alias(text, path, table));
            }
            group.icon = Some(text.clone());
            continue;
        }
        match classify_icon_ref(text) {
            Ok((IconKind::Set, reference)) => group.icon = Some(reference),
            // グループのロゴは alias か set:name だけ。SVG のパスや絵文字を直接書くのは誤り
            Ok((kind, _)) => {
                let what = if kind == IconKind::Path {
                    "SVG のファイル"
                } else {
                    "絵文字"
                };
                issues.push(warning(
                    format!("{label} に {what}は直接書けません (「{text}」)"),
                    format!(
                        "markdag.icons に alias として定義し (例: {id}: {text})、その名前を書きます"
                    ),
                    path,
                    false,
                ));
            }
            Err((_, set_hint)) => {
                let hint = if let Some(hint) = lowercase_alias_hint(text) {
                    hint
                } else if text.contains(':') && text.to_lowercase() != *text {
                    set_hint
                } else {
                    GROUP_HINT.to_string()
                };
                issues.push(warning(
                    format!(
                        "{label} の「{text}」は、alias の名前としても set:name としても読めません"
                    ),
                    hint,
                    path,
                    false,
                ));
            }
        }
    }
    issues
}

// 本文と詳細の HTML に解析が書いた印の要素 (TS の ICON_MARK と同じ形)。書く側と同じクラスと属性の名前から組む。
// regex は後方参照を持たないので、2 つの alias を比べて確かめる
static ICON_MARK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"<span class="{}" {}="({ALIAS_PATTERN})">:({ALIAS_PATTERN}):</span>"#,
        regex::escape(ICON_CLASS),
        regex::escape(ICON_ATTRIBUTE),
    ))
    .expect("固定の正規表現")
});

// TS の iconDefOf と同じ引き方: 表の alias、なければ `:` を含む名前を set:name とみなす
fn icon_def_of(table: &IconTable, name: &str) -> Option<IconDef> {
    match table.aliases.get(name) {
        Some(def) => Some(def.clone()),
        None if name.contains(':') => Some(IconDef {
            kind: IconKind::Set,
            ref_text: name.to_string(),
            color: None,
        }),
        None => None,
    }
}

/// 文書が描くのに要るロゴの定義 (本文と詳細の印、タグ、グループ)。ref ごとに 1 つ、最初に出てきた順。絵文字は解決しないので入れない。
/// 描画の側の documentIconRefs と同じ集め方で、ネイティブの入口 (CLI の html) が焼き込む SVG を選ぶのに使う
pub fn document_icon_defs(nodes: &[OutlineNode], model: &GraphModel) -> Vec<IconDef> {
    let mut found: IndexMap<String, IconDef> = IndexMap::new();
    let mut add = |def: Option<IconDef>| {
        if let Some(def) = def.filter(|def| def.kind != IconKind::Emoji) {
            found.entry(def.ref_text.clone()).or_insert(def);
        }
    };
    for node in nodes {
        for html in std::iter::once(node.html.as_str()).chain(node.details.as_deref()) {
            for mark in ICON_MARK.captures_iter(html) {
                let alias = mark.get(1).map(|found| found.as_str());
                if alias.is_some() && alias == mark.get(2).map(|found| found.as_str()) {
                    add(alias
                        .and_then(|alias| model.icons.aliases.get(alias))
                        .cloned());
                }
            }
        }
        for tag in model.tags_of.get(&node.id).into_iter().flatten() {
            let Some(key) = model.tag_keys.iter().find(|def| def.key == tag.key) else {
                continue;
            };
            let values = tag.values.iter().filter_map(|value| key.icons.get(value));
            for alias in key.icon.iter().chain(values) {
                add(icon_def_of(&model.icons, alias));
            }
        }
    }
    for group in &model.groups {
        if let Some(icon) = &group.icon {
            add(icon_def_of(&model.icons, icon));
        }
    }
    found.into_values().collect()
}

/// 本文の :alias: の印のうち表にないもの。似た alias があれば「もしかして」を出す。
/// 位置は印そのもの (原文の `:alias:` 全体) を指す
pub(crate) fn unknown_body_marks(marks: Vec<IconMark>, table: &IconTable) -> Vec<Diagnostic> {
    marks
        .into_iter()
        .filter(|mark| !table.aliases.contains_key(&mark.alias))
        .map(|mark| {
            let hint = match similar_alias(&mark.alias, table) {
                Some(similar) => format!(
                    "もしかして「:{similar}:」ですか。定義しなければ、書いたとおりの文字で表示します"
                ),
                None => format!(
                    "markdag.icons に {} を足すとロゴになります。文字として書くなら「\\:{}:」と書きます",
                    mark.alias, mark.alias
                ),
            };
            Diagnostic {
                severity: Severity::Warning,
                code: "icon-unknown".to_string(),
                message: format!("「:{}:」は markdag.icons にない alias です", mark.alias),
                at: Some(mark.at),
                hint: Some(hint),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::icons::resolve_icons;
    use crate::types::TagValueType;
    use serde_json::json;

    fn js(value: serde_json::Value) -> JsValue {
        serde_json::from_value(value).expect("JsValue に読める")
    }

    fn object(value: serde_json::Value) -> IndexMap<String, JsValue> {
        match js(value) {
            JsValue::Object(entries) => entries,
            other => panic!("オブジェクトでない: {other:?}"),
        }
    }

    fn table(value: serde_json::Value) -> IconTable {
        resolve_icons(&js(value), None).table
    }

    fn key_def(key: &str, alternatives: Vec<TagValueType>) -> TagKeyDef {
        TagKeyDef {
            key: key.to_string(),
            alternatives,
            multiple: false,
            unique: false,
            description: None,
            icons: IndexMap::new(),
            icon: None,
        }
    }

    fn enum_type(values: &[&str]) -> TagValueType {
        TagValueType {
            primitive: Primitive::Enum,
            values: Some(values.iter().map(|value| (*value).to_string()).collect()),
            patterns: None,
            min_length: None,
            max_length: None,
            min: None,
            max: None,
        }
    }

    fn group(id: &str, defined: bool) -> GroupDef {
        GroupDef {
            id: id.to_string(),
            label: id.to_string(),
            color: None,
            boundary: false,
            defined,
            icon: None,
        }
    }

    fn summary(issues: &[IconIssue]) -> Vec<(String, String)> {
        issues
            .iter()
            .map(|issue| (issue.code.clone(), issue.message.clone()))
            .collect()
    }

    #[test]
    fn タグの値とキーに_alias_を載せ_書いた順を保つ() {
        let icons =
            table(json!({ "grafana": "simple-icons:grafana", "sentry": "simple-icons:sentry" }));
        let mut keys = vec![key_def("tool", vec![]), key_def("oncall", vec![])];
        let issues = attach_tag_icons(
            &mut keys,
            &object(json!({
                "tool": { "multiple": true, "icons": { "sentry": "sentry", "grafana": "grafana" } },
                "oncall": { "type": "boolean", "icon": "sentry" }
            })),
            &icons,
            true,
        );
        assert!(issues.is_empty(), "{issues:?}");
        let tool: Vec<(&str, &str)> = keys[0]
            .icons
            .iter()
            .map(|(value, alias)| (value.as_str(), alias.as_str()))
            .collect();
        assert_eq!(tool, vec![("sentry", "sentry"), ("grafana", "grafana")]);
        assert_eq!(keys[0].icon, None);
        assert_eq!(keys[1].icon.as_deref(), Some("sentry"));
        assert!(keys[1].icons.is_empty());
    }

    #[test]
    fn 表にない_alias_は_icon_unknown_で_読めていなければ黙る() {
        let icons = table(json!({ "apple": "simple-icons:apple" }));
        let raw = object(
            json!({ "platform": { "icons": { "ios": "appel", "android": "android" }, "icon": "phone" } }),
        );
        let mut keys = vec![key_def("platform", vec![])];
        let issues = attach_tag_icons(&mut keys, &raw, &icons, true);
        assert_eq!(
            summary(&issues),
            vec![
                (
                    "icon-unknown".to_string(),
                    "markdag.tags.keys.platform.icon の「phone」は markdag.icons にない alias です"
                        .to_string()
                ),
                (
                    "icon-unknown".to_string(),
                    "markdag.tags.keys.platform.icons.ios の「appel」は markdag.icons にない alias です"
                        .to_string()
                ),
                (
                    "icon-unknown".to_string(),
                    "markdag.tags.keys.platform.icons.android の「android」は markdag.icons にない alias です"
                        .to_string()
                ),
            ]
        );
        assert_eq!(
            issues[1].hint.as_deref(),
            Some(
                "もしかして「apple」ですか。定義しなければ、ロゴなしで書いたとおりの文字を出します"
            )
        );
        // 表にない alias も対応には残す (描画の側が表を引いて、なければ文字だけにする)
        assert_eq!(keys[0].icons.len(), 2);

        let mut keys = vec![key_def("platform", vec![])];
        assert!(attach_tag_icons(&mut keys, &raw, &icons, false).is_empty());
    }

    #[test]
    fn enum_の_values_にない値の対応は知らせて残す_alias_でない右辺は使わない() {
        let icons =
            table(json!({ "apple": "simple-icons:apple", "android": "simple-icons:android" }));
        let mut keys = vec![key_def("platform", vec![enum_type(&["ios", "android"])])];
        let issues = attach_tag_icons(
            &mut keys,
            &object(
                json!({ "platform": { "icons": { "iso": "apple", "android": "android", "web": "simple-icons:html5", "x": 3 } } }),
            ),
            &icons,
            true,
        );
        assert_eq!(
            summary(&issues),
            vec![
                (
                    "icon-invalid".to_string(),
                    "markdag.tags.keys.platform.icons の「iso」は、このキーの values にない値です"
                        .to_string()
                ),
                (
                    "icon-invalid".to_string(),
                    "markdag.tags.keys.platform.icons.web の「simple-icons:html5」は alias の名前として読めません"
                        .to_string()
                ),
            ]
        );
        assert_eq!(issues[0].hint.as_deref(), Some("もしかして「ios」"));
        assert!(issues[0].at_key);
        assert_eq!(
            issues[1].hint.as_deref(),
            Some(
                "タグの対応には alias の名前を書きます。markdag.icons に alias として定義し (例: logo: simple-icons:html5)、その名前を書きます"
            )
        );
        let written: Vec<&str> = keys[0].icons.keys().map(String::as_str).collect();
        assert_eq!(written, vec!["iso", "android"]);
    }

    #[test]
    fn グループは_alias_か_set_name_を受け_パスと絵文字は誤り() {
        let icons = table(json!({ "aws": "logos:aws" }));
        let mut groups = vec![
            group("a", true),
            group("b", true),
            group("c", true),
            group("d", true),
            group("e", true),
            group("f", true),
            group("g", false),
        ];
        let issues = attach_group_icons(
            &mut groups,
            &object(json!({
                "a": { "icon": "aws" },
                "b": { "icon": "logos:google-cloud" },
                "c": { "icon": "./gcp.svg" },
                "d": { "icon": "AWS" },
                "e": { "icon": "azure" },
                "f": { "label": "F" }
            })),
            &icons,
            true,
        );
        let icons_of: Vec<Option<&str>> =
            groups.iter().map(|group| group.icon.as_deref()).collect();
        assert_eq!(
            icons_of,
            vec![
                Some("aws"),
                Some("logos:google-cloud"),
                None,
                None,
                Some("azure"),
                None,
                None
            ]
        );
        assert_eq!(
            summary(&issues),
            vec![
                (
                    "icon-invalid".to_string(),
                    "markdag.groups.c.icon に SVG のファイルは直接書けません (「./gcp.svg」)".to_string()
                ),
                (
                    "icon-invalid".to_string(),
                    "markdag.groups.d.icon の「AWS」は、alias の名前としても set:name としても読めません"
                        .to_string()
                ),
                (
                    "icon-unknown".to_string(),
                    "markdag.groups.e.icon の「azure」は markdag.icons にない alias です".to_string()
                ),
            ]
        );
        assert_eq!(
            issues[1].hint.as_deref(),
            Some("もしかして「aws」(alias は英小文字で書きます)")
        );
    }

    #[test]
    fn document_icon_defs_collect_body_details_tags_and_groups_once_without_emoji() {
        use crate::model::model::{ModelOptions, build_model};
        use crate::parse::parse_document;
        let source = concat!(
            "---\n",
            "markdag:\n",
            "  icons:\n",
            "    gh: ./logos/github.svg\n",
            "    apple: simple-icons:apple\n",
            "    fire: \"🔥\"\n",
            "    unused: ./unused.svg\n",
            "    ops: ./ops.svg\n",
            "    det: ./det.svg\n",
            "  tags:\n",
            "    keys:\n",
            "      platform:\n",
            "        type: enum\n",
            "        values: [ios, android]\n",
            "        icons: { ios: apple }\n",
            "  groups:\n",
            "    run:\n",
            "      icon: ops\n",
            "    aws:\n",
            "      icon: logos:aws\n",
            "---\n",
            "# R\n",
            "## :gh: Push :fire: #platform:ios %run %aws\n",
            "- :gh: again\n",
            "  > 詳細は :det: と :apple: と :nope:\n",
        );
        let parsed = parse_document(source);
        let model = build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(source),
            &ModelOptions::default(),
        );
        let refs: Vec<(IconKind, String)> = document_icon_defs(&parsed.nodes, &model)
            .into_iter()
            .map(|def| (def.kind, def.ref_text))
            .collect();
        assert_eq!(
            refs,
            [
                (IconKind::Path, "./logos/github.svg".to_string()),
                (IconKind::Set, "simple-icons:apple".to_string()),
                (IconKind::Path, "./det.svg".to_string()),
                (IconKind::Path, "./ops.svg".to_string()),
                (IconKind::Set, "logos:aws".to_string()),
            ]
        );
    }

    #[test]
    fn document_icon_defs_is_empty_without_icons() {
        use crate::model::model::{ModelOptions, build_model};
        use crate::parse::parse_document;
        let source = "---\nmarkdag: {}\n---\n# R\n## :gh: Push\n";
        let parsed = parse_document(source);
        let model = build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(source),
            &ModelOptions::default(),
        );
        assert!(document_icon_defs(&parsed.nodes, &model).is_empty());
    }

    // 解析が書く印の要素 (TS の plainMark と同じ文字列) の形。TS の側の同じ入力は testdata/unit/icons/marks.json
    const MARK_HTML: &str =
        r#"<span class="mdag-icon" data-icon="aws-lambda_2">:aws-lambda_2:</span>"#;

    #[test]
    fn 正規表現の_lazy_lock_をすべて一度触る() {
        let found = ICON_MARK.captures(MARK_HTML).expect("印の要素に当たる");
        assert_eq!(found.get(1).map(|m| m.as_str()), Some("aws-lambda_2"));
        assert_eq!(found.get(2).map(|m| m.as_str()), Some("aws-lambda_2"));
    }

    #[test]
    fn 印の正規表現は解析が書いた要素に当たり_中身と属性が違う要素は数えない() {
        use crate::parse::parse_document;
        let source = "---\nmarkdag:\n  icons: {}\n---\n# R\n## :aws-lambda_2: :a: A\n";
        let parsed = parse_document(source);
        let html = &parsed.nodes[1].html;
        assert!(html.contains(MARK_HTML), "{html}");
        let aliases: Vec<(String, String)> = ICON_MARK
            .captures_iter(html)
            .map(|found| (found[1].to_string(), found[2].to_string()))
            .collect();
        assert_eq!(
            aliases,
            [
                ("aws-lambda_2".to_string(), "aws-lambda_2".to_string()),
                ("a".to_string(), "a".to_string())
            ]
        );
        // 属性と中身の alias が違うもの、属性の並びやクラスが違うものは印でない
        for other in [
            r#"<span class="mdag-icon" data-icon="a">:b:</span>"#,
            r#"<span data-icon="a" class="mdag-icon">:a:</span>"#,
            r#"<span class="mdag-icon x" data-icon="a">:a:</span>"#,
            r#"<span class="mdag-icon" data-icon="A">:A:</span>"#,
        ] {
            let equal = ICON_MARK
                .captures_iter(other)
                .any(|found| found[1] == found[2]);
            assert!(!equal, "{other}");
        }
    }

    #[test]
    fn 属性と中身の_alias_が違う要素からは_ref_を集めない() {
        use crate::model::model::{ModelOptions, build_model};
        use crate::parse::parse_document;
        let source =
            "---\nmarkdag:\n  icons:\n    a: ./a.svg\n    b: ./b.svg\n---\n# R\n## :a: A\n";
        let mut parsed = parse_document(source);
        let model = build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(source),
            &ModelOptions::default(),
        );
        parsed.nodes[1].html = r#"<span class="mdag-icon" data-icon="a">:b:</span> A"#.to_string();
        assert!(document_icon_defs(&parsed.nodes, &model).is_empty());
        parsed.nodes[1].html = String::new();
        parsed.nodes[1].details =
            Some(r#"<span class="mdag-icon" data-icon="b">:b:</span>"#.to_string());
        let refs: Vec<String> = document_icon_defs(&parsed.nodes, &model)
            .into_iter()
            .map(|def| def.ref_text)
            .collect();
        assert_eq!(refs, ["./b.svg"]);
    }

    #[test]
    fn 道すじの文字は_js_path_join_と同じ() {
        use crate::model::util::js_path_join;
        let paths: Vec<SourcePath> = vec![
            vec![],
            path_of(&["markdag", "groups", "a.b", "icon"]),
            vec![
                PathStep::Key("markdag".to_string()),
                PathStep::Key("icons".to_string()),
                PathStep::Key("$ref".to_string()),
                PathStep::Index(3),
            ],
            vec![PathStep::Key(String::new()), PathStep::Index(0)],
        ];
        let labels: Vec<String> = paths.iter().map(label_of).collect();
        assert_eq!(
            labels,
            ["", "markdag.groups.a.b.icon", "markdag.icons.$ref.3", ".0"]
        );
        for path in &paths {
            assert_eq!(label_of(path), js_path_join(path), "{path:?}");
        }
    }

    // TS の iconDefOf と同じ入力と答え (test/icons-boundary.test.ts の同じ表)
    #[test]
    fn 名前の引き方は表の_alias_が先_なければ_colon_を含む名前を_set_name_とみなす() {
        let icons = table(json!({
            "gh": "./github.svg",
            "fire": "🔥",
            "k8s": { "ref": "simple-icons:kubernetes", "color": "original" }
        }));
        let cases: Vec<(&str, Option<IconDef>)> = vec![
            (
                "gh",
                Some(IconDef {
                    kind: IconKind::Path,
                    ref_text: "./github.svg".to_string(),
                    color: None,
                }),
            ),
            (
                "fire",
                Some(IconDef {
                    kind: IconKind::Emoji,
                    ref_text: "🔥".to_string(),
                    color: None,
                }),
            ),
            (
                "k8s",
                Some(IconDef {
                    kind: IconKind::Set,
                    ref_text: "simple-icons:kubernetes".to_string(),
                    color: Some(crate::types::IconColor::Original),
                }),
            ),
            (
                "logos:aws",
                Some(IconDef {
                    kind: IconKind::Set,
                    ref_text: "logos:aws".to_string(),
                    color: None,
                }),
            ),
            (
                "Not:A:Set",
                Some(IconDef {
                    kind: IconKind::Set,
                    ref_text: "Not:A:Set".to_string(),
                    color: None,
                }),
            ),
            ("nope", None),
            ("", None),
        ];
        for (name, expected) in cases {
            assert_eq!(icon_def_of(&icons, name), expected, "{name}");
        }
    }

    #[test]
    fn タグの右辺の名前の誤りは大文字だけなら小文字を示し_読める値なら定義の仕方を示す() {
        let icons = table(json!({ "apple": "simple-icons:apple" }));
        let mut keys = vec![key_def("os", vec![])];
        let issues = attach_tag_icons(
            &mut keys,
            &object(
                json!({ "os": { "icon": "Apple", "icons": { "a": "APPLE", "b": "./x.svg", "c": "a b", "d": "" } } }),
            ),
            &icons,
            true,
        );
        let found: Vec<(String, Option<String>, bool)> = issues
            .iter()
            .map(|issue| (issue.message.clone(), issue.hint.clone(), issue.at_key))
            .collect();
        assert_eq!(
            found,
            [
                (
                    "markdag.tags.keys.os.icon の「Apple」は alias の名前として読めません".to_string(),
                    Some("もしかして「apple」(alias は英小文字で書きます)".to_string()),
                    false
                ),
                (
                    "markdag.tags.keys.os.icons.a の「APPLE」は alias の名前として読めません".to_string(),
                    Some("もしかして「apple」(alias は英小文字で書きます)".to_string()),
                    false
                ),
                (
                    "markdag.tags.keys.os.icons.b の「./x.svg」は alias の名前として読めません".to_string(),
                    Some("タグの対応には alias の名前を書きます。markdag.icons に alias として定義し (例: logo: ./x.svg)、その名前を書きます".to_string()),
                    false
                ),
                (
                    "markdag.tags.keys.os.icons.c の「a b」は alias の名前として読めません".to_string(),
                    Some(TAG_HINT.to_string()),
                    false
                ),
            ]
        );
        assert_eq!(keys[0].icon, None);
        assert!(keys[0].icons.is_empty());
    }

    #[test]
    fn values_にない値の知らせはキーの位置を指し_道すじは値まで持つ() {
        let icons = table(json!({ "apple": "simple-icons:apple" }));
        let mut keys = vec![key_def(
            "os",
            vec![enum_type(&["mac", "linux"]), enum_type(&["win"])],
        )];
        let issues = attach_tag_icons(
            &mut keys,
            &object(json!({ "os": { "icons": { "zzz": "apple" } } })),
            &icons,
            true,
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].message,
            "markdag.tags.keys.os.icons の「zzz」は、このキーの values にない値です"
        );
        assert_eq!(
            issues[0].hint.as_deref(),
            Some("values にある値 (mac, linux, win) を書きます")
        );
        assert!(issues[0].at_key);
        assert_eq!(
            issues[0].path,
            path_of(&["markdag", "tags", "keys", "os", "icons", "zzz"])
        );
        // enum でない型を含むキーは値を問わない
        let mut keys = vec![key_def(
            "os",
            vec![
                enum_type(&["mac"]),
                TagValueType {
                    primitive: Primitive::String,
                    ..enum_type(&[])
                },
            ],
        )];
        assert!(
            attach_tag_icons(
                &mut keys,
                &object(json!({ "os": { "icons": { "zzz": "apple" } } })),
                &icons,
                true
            )
            .is_empty()
        );
    }
}

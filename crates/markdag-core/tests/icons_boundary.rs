// アイコン機能の境界 (Rust と TS が同じ形を出し入れする所) の一致と、診断の組み立ての今の形を固定する単体テスト。
// 入力と期待値は testdata/unit/icons/ の JSON で、TS の側 (test/icons-boundary.test.ts) も同じファイルを読む。
// 受け入れの例 (testdata/acceptance/icons/) とは別物で、公開面でない関数 (document_icon_defs など) も叩く。
// source は行の配列で、"\n" でつないで末尾に "\n" を足したものを原文にする。provided は markdag.icons.$ref の中身 (ModelOptions.icons)。
use indexmap::IndexMap;
use markdag_core::model::icon_uses::document_icon_defs;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::native::{
    diagnose, diagnose_with_icons, parse_and_model, parse_and_model_with_icons,
};
use markdag_core::parse::parse_document;
use markdag_core::standalone::{StandaloneOptions, StandaloneRuntime, render_standalone_page};
use markdag_core::types::{Diagnostic, GraphModel, ParsedDocument};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../testdata/unit/icons/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn source_of(case: &Value) -> String {
    let lines: Vec<&str> = case["source"]
        .as_array()
        .expect("source は行の配列")
        .iter()
        .map(|line| line.as_str().expect("行は文字列"))
        .collect();
    format!("{}\n", lines.join("\n"))
}

fn provided_of(case: &Value) -> Option<IndexMap<String, JsValue>> {
    case.get("provided")
        .map(|value| serde_json::from_value(value.clone()).expect("provided は JsValue の表"))
}

fn built(
    source: &str,
    provided: Option<IndexMap<String, JsValue>>,
) -> (ParsedDocument, GraphModel) {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions {
            types: None,
            hook_refs: None,
            icons: provided,
        },
    );
    (parsed, model)
}

fn name_of(case: &Value) -> &str {
    case["name"].as_str().expect("name")
}

// ---- 本文の印の要素の形 ----

#[test]
fn icons_boundary_marks_parse_writes_the_shared_mark_html() {
    let marks = fixture("marks.json");
    let (parsed, _) = built(&source_of(&marks), None);
    let html: String = parsed
        .nodes
        .iter()
        .map(|node| node.html.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    for mark in marks["marks"].as_array().expect("marks") {
        let expected = mark["html"].as_str().expect("html");
        assert!(html.contains(expected), "{expected} が HTML にない: {html}");
    }
    let written = html.matches("class=\"mdag-icon\"").count();
    assert_eq!(
        written,
        marks["marks"].as_array().expect("marks").len(),
        "{html}"
    );
    for text in marks["texts"].as_array().expect("texts") {
        let text = text.as_str().expect("文字");
        assert!(html.contains(text), "{text} は文字のまま残る: {html}");
    }
}

#[test]
fn icons_boundary_marks_document_icon_defs_reads_every_written_mark() {
    // 書いた印をすべて表に載せると、document_icon_defs (Rust の ICON_MARK) がすべてを拾う
    let marks = fixture("marks.json");
    let aliases: Vec<&str> = marks["marks"]
        .as_array()
        .expect("marks")
        .iter()
        .map(|mark| mark["alias"].as_str().expect("alias"))
        .collect();
    let mut source = source_of(&marks);
    let table: String = aliases
        .iter()
        .map(|alias| format!("    {alias}: ./{alias}.svg\n"))
        .collect();
    source = source.replacen("    a: ./a.svg\n", &table, 1);
    let (parsed, model) = built(&source, None);
    let refs: Vec<String> = document_icon_defs(&parsed.nodes, &model)
        .into_iter()
        .map(|def| def.ref_text)
        .collect();
    let expected: Vec<String> = aliases
        .iter()
        .map(|alias| format!("./{alias}.svg"))
        .collect();
    assert_eq!(refs, expected);
}

// ---- ref の集め方の一致 (Rust の側) ----

#[test]
fn icons_boundary_refs_document_icon_defs_matches_the_shared_cases() {
    for case in fixture("refs.json").as_array().expect("cases") {
        let (parsed, model) = built(&source_of(case), provided_of(case));
        let refs: Vec<String> = document_icon_defs(&parsed.nodes, &model)
            .into_iter()
            .map(|def| def.ref_text)
            .collect();
        let expected: Vec<String> = case["refs"]
            .as_array()
            .expect("refs")
            .iter()
            .map(|item| item.as_str().expect("ref").to_string())
            .collect();
        assert_eq!(refs, expected, "{}", name_of(case));
    }
}

// ---- IconTable、IconDef、TagKeyDef、GroupDef の JSON ----

#[test]
fn icons_boundary_tables_graph_model_json_matches_the_shared_cases() {
    for case in fixture("tables.json").as_array().expect("cases") {
        let name = name_of(case);
        let (_, model) = built(&source_of(case), provided_of(case));
        let json = serde_json::to_value(&model).expect("serialize");
        match &case["icons"] {
            Value::Null => assert!(json.get("icons").is_none(), "{name}: {json}"),
            expected => assert_eq!(json.get("icons"), Some(expected), "{name}"),
        }
        if let Some(keys) = case.get("tagKeys").and_then(Value::as_object) {
            for (key, fields) in keys {
                let def = json["tagKeys"]
                    .as_array()
                    .expect("tagKeys")
                    .iter()
                    .find(|def| def["key"] == Value::String(key.clone()))
                    .unwrap_or_else(|| panic!("{name}: キー {key}"));
                for field in ["icons", "icon"] {
                    match &fields[field] {
                        Value::Null => assert!(def.get(field).is_none(), "{name}: {key}.{field}"),
                        expected => {
                            assert_eq!(def.get(field), Some(expected), "{name}: {key}.{field}")
                        }
                    }
                }
            }
        }
        if let Some(groups) = case.get("groups").and_then(Value::as_object) {
            for (id, icon) in groups {
                let def = json["groups"]
                    .as_array()
                    .expect("groups")
                    .iter()
                    .find(|def| def["id"] == Value::String(id.clone()))
                    .unwrap_or_else(|| panic!("{name}: グループ {id}"));
                match icon {
                    Value::Null => assert!(def.get("icon").is_none(), "{name}: {id}"),
                    expected => assert_eq!(def.get("icon"), Some(expected), "{name}: {id}"),
                }
            }
        }
    }
}

// ---- 単体 HTML の素材の欄の順 ----

fn embedded_keys(html: &str) -> Vec<String> {
    let open = "<script id=\"markdag-data\" type=\"application/json\">";
    let start = html.find(open).expect("素材の script") + open.len();
    let end = start + html[start..].find("</script>").expect("閉じタグ");
    let data: Value = serde_json::from_str(&html[start..end]).expect("JSON");
    data.as_object()
        .expect("オブジェクト")
        .keys()
        .cloned()
        .collect()
}

#[test]
fn icons_boundary_data_keys_follow_the_shared_order_whatever_order_they_come_in() {
    let order: Vec<String> = serde_json::from_value(fixture("data-keys.json")).expect("欄の名前");
    let mut data: IndexMap<String, JsValue> = IndexMap::new();
    for key in order.iter().rev() {
        let value = match key.as_str() {
            "parsed" => serde_json::from_value(serde_json::json!({ "nodes": [] })).expect("parsed"),
            "source" | "tasks" => JsValue::String("scratch".to_string()),
            _ => serde_json::from_value(serde_json::json!({ "k": "v" })).expect("オブジェクト"),
        };
        data.insert(key.clone(), value);
    }
    data.insert("other".to_string(), JsValue::Bool(true));
    let runtime = StandaloneRuntime {
        script: "var markdag = {};".to_string(),
        style: "".to_string(),
    };
    let html = render_standalone_page(
        &StandaloneOptions::default(),
        &JsValue::Object(data),
        &runtime,
    )
    .expect("組み立てられる");
    assert_eq!(embedded_keys(&html), order);
}

// ---- icons を足した入口と足す前の入口 ----

#[test]
fn icons_boundary_native_entry_points_without_icons_are_the_with_icons_ones_given_none() {
    let sources = [
        "---\nmarkdag:\n  icons:\n    $ref: ./team.yaml\n    gh: simple-icons:github\n---\n# R\n## :gh: :k8s: A\n",
        "---\nmarkdag:\n  icons:\n    gh: simple-icons:github\n---\n# R\n## :gh: :k8s: A\n",
        "# R\n## :gh: A\n",
    ];
    for source in sources {
        let types: IndexMap<String, JsValue> = IndexMap::new();
        let plain: Vec<Diagnostic> = diagnose(source, types.clone());
        assert_eq!(
            plain,
            diagnose_with_icons(source, types.clone(), None),
            "{source}"
        );
        assert_eq!(
            parse_and_model(source, types.clone()),
            parse_and_model_with_icons(source, types, None),
            "{source}"
        );
    }
    // 渡すと icons-unresolved が消え、$ref の中の alias が表に入る (包みが icons を build_model に届けている)
    let source = sources[0];
    let provided: IndexMap<String, JsValue> = serde_json::from_value(
        serde_json::json!({ "./team.yaml": { "k8s": "simple-icons:kubernetes" } }),
    )
    .expect("provided");
    let codes = |diagnostics: Vec<Diagnostic>| -> Vec<String> {
        diagnostics.into_iter().map(|item| item.code).collect()
    };
    assert_eq!(
        codes(diagnose(source, IndexMap::new())),
        ["icons-unresolved"]
    );
    assert!(codes(diagnose_with_icons(source, IndexMap::new(), Some(provided))).is_empty());
}

// ---- 診断の組み立て (報告の loop、本文の icon-unknown、「もしかして」の候補、values にない値) ----

type Row = (
    &'static str,
    &'static str,
    Option<(u32, u32, u32)>,
    Option<&'static str>,
);
// (code, message, at の行と桁と長さ, hint)
type OwnedRow = (String, String, Option<(u32, u32, u32)>, Option<String>);

fn rows(model: &GraphModel) -> Vec<OwnedRow> {
    model
        .diagnostics
        .iter()
        .map(|item| {
            (
                item.code.clone(),
                item.message.clone(),
                item.at.as_ref().map(|at| (at.line, at.column, at.length)),
                item.hint.clone(),
            )
        })
        .collect()
}

fn owned(expected: &[Row]) -> Vec<OwnedRow> {
    expected
        .iter()
        .map(|(code, message, at, hint)| {
            (
                code.to_string(),
                message.to_string(),
                *at,
                hint.map(str::to_string),
            )
        })
        .collect()
}

#[test]
fn icons_boundary_diagnostics_of_the_icons_table_and_ref_files() {
    let source = concat!(
        "---\n",
        "markdag:\n",
        "  icons:\n",
        "    $ref: [./a.yaml, ./missing.yaml, ./broken.yaml]\n",
        "    GitHub: simple-icons:github\n",
        "    1st: simple-icons:one\n",
        "    shot: ./x.png\n",
        "    color: orignal\n",
        "---\n",
        "# R\n",
        "## :k8s: A\n",
    );
    let provided: IndexMap<String, JsValue> = serde_json::from_value(serde_json::json!({
        "./a.yaml": { "Bad": "set:b", "color": "original", "ok": "set:ok" },
        "./broken.yaml": null
    }))
    .expect("provided");
    let (_, model) = built(source, Some(provided));
    // $ref のファイルの中の誤りは $ref の項目の位置、文書のキーの名前の誤りはキーの位置、値の誤りは値の位置。
    // $ref が読めていないので本文の :k8s: は知らせない
    let expected: [Row; 8] = [
        (
            "icon-invalid",
            "markdag.icons.$ref「./a.yaml」 のキー「Bad」は alias の名前に使えません",
            Some((4, 12, 8)),
            Some("もしかして「bad」(alias は英小文字で書きます)"),
        ),
        (
            "icon-invalid",
            "markdag.icons.$ref「./a.yaml」 のキー「color」は予約語なので alias にできません",
            Some((4, 12, 8)),
            Some(
                "$ref と color は markdag.icons の設定の名前なので alias にできません。別の名前にします",
            ),
        ),
        (
            "icons-unresolved",
            "markdag.icons.$ref「./missing.yaml」を読めなかったので、その中の alias は使えません",
            Some((4, 22, 14)),
            Some(
                "呼び出し側が読んで buildModel の icons に渡します (npm run check は文書の場所からの相対で読みます)",
            ),
        ),
        (
            "icons-unresolved",
            "markdag.icons.$ref「./broken.yaml」を読めなかったので、その中の alias は使えません",
            Some((4, 38, 13)),
            Some("ファイルが YAML のキーと値の組 (alias: 値) として読めるか確かめます"),
        ),
        (
            "icon-invalid",
            "markdag.icons のキー「GitHub」は alias の名前に使えません",
            Some((5, 5, 6)),
            Some("もしかして「github」(alias は英小文字で書きます)"),
        ),
        (
            "icon-invalid",
            "markdag.icons のキー「1st」は alias の名前に使えません",
            Some((6, 5, 3)),
            Some(
                "英小文字で始め、英小文字と数字、- と _ だけで書きます (本文では :github: の形で使います)",
            ),
        ),
        (
            "icon-invalid",
            "markdag.icons.shot「./x.png」: 画像は SVG だけ使えます (.png は使えません)",
            Some((7, 11, 7)),
            Some(
                "SVG にして ./images/x.svg のように書きます。この alias は使えないので、本文の印は文字のまま残ります",
            ),
        ),
        (
            "option-invalid",
            "markdag.icons.color に指定できるのは mono, original です (\"orignal\")",
            Some((8, 12, 7)),
            Some("もしかして「original」"),
        ),
    ];
    assert_eq!(rows(&model), owned(&expected));
    let aliases: Vec<&str> = model.icons.aliases.keys().map(String::as_str).collect();
    assert_eq!(aliases, ["ok"]);
}

#[test]
fn icons_boundary_diagnostics_of_tags_groups_and_body_marks() {
    let source = concat!(
        "---\n",
        "markdag:\n",
        "  icons:\n",
        "    github: simple-icons:github\n",
        "    apple: simple-icons:apple\n",
        "  tags:\n",
        "    keys:\n",
        "      platform:\n",
        "        type: enum\n",
        "        values: [ios, android]\n",
        "        icon: Apple\n",
        "        icons: { iso: apple, android: droid, web: \"a b\" }\n",
        "      os:\n",
        "        type: enum\n",
        "        values: [mac]\n",
        "        icons: { win: apple }\n",
        "  groups:\n",
        "    g1: { icon: AWS }\n",
        "    g2: { icon: ./x.svg }\n",
        "    g3: { icon: \"🚀\" }\n",
        "    g4: { icon: Logos:AWS }\n",
        "    g5: { icon: \"a b\" }\n",
        "    g6: { icon: azure }\n",
        "---\n",
        "# R\n",
        "## :githb: :k8s: A %g1 %g2 %g3 %g4 %g5 %g6\n",
    );
    let (_, model) = built(source, None);
    // タグの values にない値はキーの位置 (at_key)、ほかは値の位置。タグ、グループ、本文の順に積む
    let expected: [Row; 13] = [
        (
            "icon-invalid",
            "markdag.tags.keys.platform.icon の「Apple」は alias の名前として読めません",
            Some((11, 15, 5)),
            Some("もしかして「apple」(alias は英小文字で書きます)"),
        ),
        (
            "icon-invalid",
            "markdag.tags.keys.platform.icons の「iso」は、このキーの values にない値です",
            Some((12, 18, 3)),
            Some("もしかして「ios」"),
        ),
        (
            "icon-unknown",
            "markdag.tags.keys.platform.icons.android の「droid」は markdag.icons にない alias です",
            Some((12, 39, 5)),
            Some(
                "markdag.icons に droid: を足して set:name か SVG のパスを書くとロゴになります。定義しなければ、ロゴなしで書いたとおりの文字を出します",
            ),
        ),
        (
            "icon-invalid",
            "markdag.tags.keys.platform.icons.web の「a b」は alias の名前として読めません",
            Some((12, 51, 5)),
            Some("markdag.icons に定義した alias の名前 (github など) を書きます"),
        ),
        (
            "icon-invalid",
            "markdag.tags.keys.os.icons の「win」は、このキーの values にない値です",
            Some((16, 18, 3)),
            Some("values にある値 (mac) を書きます"),
        ),
        (
            "icon-invalid",
            "markdag.groups.g1.icon の「AWS」は、alias の名前としても set:name としても読めません",
            Some((18, 17, 3)),
            Some("もしかして「aws」(alias は英小文字で書きます)"),
        ),
        (
            "icon-invalid",
            "markdag.groups.g2.icon に SVG のファイルは直接書けません (「./x.svg」)",
            Some((19, 17, 7)),
            Some("markdag.icons に alias として定義し (例: g2: ./x.svg)、その名前を書きます"),
        ),
        (
            "icon-invalid",
            "markdag.groups.g3.icon に 絵文字は直接書けません (「🚀」)",
            Some((20, 17, 3)),
            Some("markdag.icons に alias として定義し (例: g3: 🚀)、その名前を書きます"),
        ),
        (
            "icon-invalid",
            "markdag.groups.g4.icon の「Logos:AWS」は、alias の名前としても set:name としても読めません",
            Some((21, 17, 9)),
            Some("set:name は英小文字で書きます (simple-icons:github)"),
        ),
        (
            "icon-invalid",
            "markdag.groups.g5.icon の「a b」は、alias の名前としても set:name としても読めません",
            Some((22, 17, 5)),
            Some(
                "markdag.icons に定義した alias の名前 (aws) か、set:name の形 (logos:aws) を書きます",
            ),
        ),
        (
            "icon-unknown",
            "markdag.groups.g6.icon の「azure」は markdag.icons にない alias です",
            Some((23, 17, 5)),
            Some(
                "markdag.icons に azure: を足して set:name か SVG のパスを書くとロゴになります。定義しなければ、ロゴなしで書いたとおりの文字を出します",
            ),
        ),
        (
            "icon-unknown",
            "「:githb:」は markdag.icons にない alias です",
            Some((26, 4, 7)),
            Some("もしかして「:github:」ですか。定義しなければ、書いたとおりの文字で表示します"),
        ),
        (
            "icon-unknown",
            "「:k8s:」は markdag.icons にない alias です",
            Some((26, 12, 5)),
            Some(
                "markdag.icons に k8s を足すとロゴになります。文字として書くなら「\\:k8s:」と書きます",
            ),
        ),
    ];
    assert_eq!(rows(&model), owned(&expected));
    let icons: Vec<(&str, Option<&str>)> = model
        .groups
        .iter()
        .map(|group| (group.id.as_str(), group.icon.as_deref()))
        .collect();
    assert_eq!(
        icons,
        [
            ("g1", None),
            ("g2", None),
            ("g3", None),
            ("g4", None),
            ("g5", None),
            ("g6", Some("azure"))
        ]
    );
    let platform = model
        .tag_keys
        .iter()
        .find(|def| def.key == "platform")
        .expect("platform");
    let written: Vec<(&str, &str)> = platform
        .icons
        .iter()
        .map(|(value, alias)| (value.as_str(), alias.as_str()))
        .collect();
    assert_eq!(written, [("iso", "apple"), ("android", "droid")]);
    assert_eq!(platform.icon, None);
}

// ---- 本文の icon-unknown を読む条件。frontmatter の markdag.icons と、原文の frontmatter の両方が要る ----

#[test]
fn icons_boundary_body_unknown_needs_icons_in_both_the_given_frontmatter_and_the_source() {
    let with_icons = "---\nmarkdag:\n  icons:\n    gh: simple-icons:github\n---\n# R\n## :k8s: A\n";
    let without_icons = "---\nmarkdag:\n  tags: {}\n---\n# R\n## :k8s: A\n";
    let unknown = |frontmatter_from: &str, markdown: &str| -> usize {
        let parsed = parse_document(frontmatter_from);
        let model = build_model(
            &parsed.nodes,
            &parsed.frontmatter,
            Some(markdown),
            &ModelOptions::default(),
        );
        model
            .diagnostics
            .iter()
            .filter(|item| item.code == "icon-unknown")
            .count()
    };
    assert_eq!(unknown(with_icons, with_icons), 1);
    assert_eq!(unknown(with_icons, without_icons), 0);
    assert_eq!(unknown(without_icons, with_icons), 0);
    assert_eq!(unknown(without_icons, without_icons), 0);
}

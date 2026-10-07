// GUI 編集の差分のレビューで確かめた指摘 (今直すと仕分けたもの) を、直す前に落ちるテストとして書く。
// 容器と 1 行目を分け合う最初の項目の削除と付け替え (容器が残る形) と canMark、名前の変更の追随で区切りに化ける名前、
// 付け替えでのコードブロックの中身、選び方に読める名前 (x/*、x/**) の参照、BOM で始まる 1 行目の名前、
// 式 1 つのスカラを一覧に書き直すときの行末のコメント。
// 公開の markdag_core::edit (edit_source、inspect_node) と、解析とモデルの公開の関数だけを使う。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして比べる。期待の文書は、比べる前に解析し直して
// 読み方 (ノードの親子、コードの中身、線) を確かめる (期待の書き誤りを、直す前の赤の確認で見分けるため)。
// 関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める。
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

type Target<'a> = (u32, &'a str);

fn op(value: Value) -> EditOp {
    serde_json::from_value(value).expect("EditOp の JSON")
}

fn target(id: u32, ref_text: &str) -> NodeTarget {
    serde_json::from_value(json!({ "id": id, "refText": ref_text })).expect("NodeTarget の JSON")
}

// 数を f64 にそろえる (id や start を整数で書くか浮動小数で書くかを契約に含めない)
fn normalized(value: Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().expect("有限の数")),
        Value::Array(items) => Value::Array(items.into_iter().map(normalized).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalized(value)))
                .collect(),
        ),
        other => other,
    }
}

fn edited_by(source: &str, value: Value) -> Value {
    normalized(
        serde_json::to_value(edit_source(source, &op(value)))
            .expect("EditSourceResult は JSON にできる"),
    )
}

fn node_json((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn node_of(source: &str, id: u32) -> OutlineNode {
    parse_document(source)
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

fn node_named(source: &str, ref_text: &str) -> OutlineNode {
    parse_document(source)
        .nodes
        .into_iter()
        .find(|node| node.ref_text == ref_text)
        .unwrap_or_else(|| panic!("{ref_text:?} のノードがある: {source:?}"))
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(node_of(source, id).ref_text, ref_text, "{source:?}");
}

fn rename(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "renameNode", "node": node_json(node), "label": label }),
    )
}

fn delete_nodes(source: &str, nodes: &[Target]) -> Value {
    for &node in nodes {
        assert_target(source, node);
    }
    let nodes: Vec<Value> = nodes.iter().map(|&node| node_json(node)).collect();
    edited_by(source, json!({ "kind": "deleteNodes", "nodes": nodes }))
}

fn move_node(source: &str, node: Target, parent: Target) -> Value {
    assert_target(source, node);
    assert_target(source, parent);
    edited_by(
        source,
        json!({ "kind": "moveNode", "node": node_json(node), "parent": node_json(parent) }),
    )
}

fn inspect(source: &str, node: Target) -> Value {
    assert_target(source, node);
    let result = inspect_node(source, &target(node.0, node.1))
        .unwrap_or_else(|| panic!("{node:?} の inspectNode がある: {source:?}"));
    normalized(serde_json::to_value(result).expect("InspectNodeResult は JSON にできる"))
}

// TS の包み (editSource) の写し: splices を後ろから原文の行 (split('\n')) に当てて join('\n') する
fn applied(source: &str, result: &Value) -> String {
    assert_eq!(
        result["status"], "edited",
        "書き換えるはず: {source:?}: {result}"
    );
    let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
    let splices = result["splices"].as_array().expect("splices は配列");
    for splice in splices.iter().rev() {
        let start = splice["start"].as_f64().expect("start は数") as usize;
        let delete_count = splice["deleteCount"].as_f64().expect("deleteCount は数") as usize;
        let inserted: Vec<String> = splice["lines"]
            .as_array()
            .expect("lines は配列")
            .iter()
            .map(|line| line.as_str().expect("行は文字列").to_string())
            .collect();
        lines.splice(start..start + delete_count, inserted);
    }
    lines.join("\n")
}

fn selected((id, ref_text): Target) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [{ "id": id, "refText": ref_text }] }))
}

fn assert_reason(result: &Value, status: &str, code: &str) {
    assert_eq!(result["status"], status, "{result}");
    assert_eq!(result["reason"]["code"], code, "{result}");
    assert!(
        result["reason"]["message"]
            .as_str()
            .is_some_and(|message| !message.trim().is_empty()),
        "message は空でない文: {result}"
    );
}

fn assert_refused(result: &Value, code: &str) {
    assert_reason(result, "refused", code);
}

// 書き換えた結果: 原文の全体、select が 1 つのノード (書き換えたあとの原文を解析し直した id と refText)、rename は null、notes は空
fn assert_rewritten(source: &str, result: &Value, expected: &str, chosen: Target) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], selected(chosen), "{source:?}: {result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_eq!(result["notes"], json!([]), "{result}");
    assert_eq!(
        node_of(expected, chosen.0).ref_text,
        chosen.1,
        "{expected:?}"
    );
}

fn note_codes(result: &Value) -> Vec<String> {
    let mut codes: Vec<String> = result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .map(|note| note["code"].as_str().expect("code は文字列").to_string())
        .collect();
    codes.sort();
    codes
}

// 線 (kind、始点、終点) の並びを整えたもの。名前を変えてもノードの id は変わらないので、id のまま比べる
fn relations_of(source: &str) -> Vec<(String, u32, u32)> {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    );
    let mut relations: Vec<(String, u32, u32)> = model
        .relations
        .iter()
        .map(|relation| {
            (
                relation.kind.as_str().to_string(),
                relation.source,
                relation.target,
            )
        })
        .collect();
    relations.sort();
    relations
}

fn diagnostic_codes(source: &str) -> Vec<String> {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    );
    let mut codes: Vec<String> = model
        .diagnostics
        .iter()
        .map(|diagnostic| format!("{}:{}", diagnostic.code, diagnostic.message))
        .collect();
    codes.sort();
    codes
}

// ---- A-01 / B-02: 容器と 1 行目を分け合う最初の項目の削除と付け替え (容器が残る形) ----
// design 3.5 の削除の既定と behaviors B-038、B-055: 断るのは「容器がなくなるか、ルートが置き換わる」形だけ (G-008、G-010 は項目 2 つ)。
// 項目 3 つ以上のリストで最初の項目を消すか動かしても容器は残るので、書き換える

#[test]
fn edit_review_a01_delete_the_first_item_when_the_container_stays() {
    // リストだけの文書 (ルートが容器)。選ぶのは消したノードの親 (ルートは id 1)
    let cases: [(&str, Target, &str, Target); 5] = [
        ("- a\n- b\n- c\n", (2, "a"), "- b\n- c\n", (1, "")),
        (
            "---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n",
            (2, "a"),
            "---\ntitle: 手順\nmarkdag:\n---\n- b\n- c\n",
            (1, "手順"),
        ),
        ("- a\n    - a1\n- b\n- c\n", (2, "a"), "- b\n- c\n", (1, "")),
        // 見出しの下の種類の違うリスト (容器が 2 つ)。選ぶのは消した項目の親の容器。番号付きのリストは、消す前の始まりの番号 (1) から
        // 振り直す (例の承認の U7-first)
        (
            "# R\n- p\n- q\n\n1. a\n2. b\n3. c\n",
            (6, "1. a"),
            "# R\n- p\n- q\n\n1. b\n2. c\n",
            (5, ""),
        ),
        (
            "# R\n\n- a\n- b\n- c\n\n1. p\n2. q\n",
            (3, "a"),
            "# R\n\n- b\n- c\n\n1. p\n2. q\n",
            (2, ""),
        ),
    ];
    for (source, node, expected, chosen) in cases {
        let result = delete_nodes(source, &[node]);
        assert_rewritten(source, &result, expected, chosen);
    }
}

#[test]
fn edit_review_a01_move_the_first_item_when_the_container_stays() {
    // 移す先の最後の子として入れ子の項目で書く (字下げは文書の入れ子の差、なければ 4)。選ぶのは動かしたノード
    let cases: [(&str, Target, Target, &str, Target, u32); 5] = [
        (
            "- a\n- b\n- c\n",
            (2, "a"),
            (3, "b"),
            "- b\n    - a\n- c\n",
            (3, "a"),
            2,
        ),
        (
            "---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n",
            (2, "a"),
            (4, "c"),
            "---\ntitle: 手順\nmarkdag:\n---\n- b\n- c\n    - a\n",
            (4, "a"),
            3,
        ),
        (
            "- a\n    - a1\n- b\n- c\n",
            (2, "a"),
            (4, "b"),
            "- b\n    - a\n        - a1\n- c\n",
            (3, "a"),
            2,
        ),
        (
            "# R\n\n- a\n- b\n- c\n\n1. p\n2. q\n",
            (3, "a"),
            (4, "b"),
            "# R\n\n- b\n    - a\n- c\n\n1. p\n2. q\n",
            (4, "a"),
            3,
        ),
        // 番号付きのリストは、移す前の始まりの番号 (1) から振り直す (例の承認の U7-first)
        (
            "# R\n- p\n- q\n\n1. a\n2. b\n3. c\n",
            (6, "1. a"),
            (7, "2. b"),
            "# R\n- p\n- q\n\n1. b\n    - a\n2. c\n",
            (7, "a"),
            6,
        ),
    ];
    for (source, node, parent, expected, moved, new_parent) in cases {
        let result = move_node(source, node, parent);
        assert_rewritten(source, &result, expected, moved);
        assert_eq!(
            node_of(expected, moved.0).parent,
            Some(new_parent),
            "{expected:?}"
        );
    }
}

#[test]
fn edit_review_a01_two_item_lists_still_refuse_when_the_container_would_go() {
    // 項目 2 つのリストは、1 つ消すか動かすと容器がなくなる (G-008、G-010)。直したあとも断る
    assert_refused(
        &delete_nodes("- a\n- b\n", &[(2, "a")]),
        "structure-changed",
    );
    assert_refused(
        &delete_nodes("---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n", &[(2, "a")]),
        "structure-changed",
    );
    assert_refused(
        &delete_nodes("# R\n\n- a\n- b\n\n1. c\n2. d\n", &[(3, "a")]),
        "structure-changed",
    );
    assert_refused(
        &move_node("- a\n- b\n", (2, "a"), (3, "b")),
        "structure-changed",
    );
}

// ---- A-06: 容器と 1 行目を分け合う項目の canMark ----
// design 3.8: canMark は「1 行目に印を書けるか」で、編集の層は can* で帯のボタンを押せなくする。
// 容器は分け合う行の印 (グループ、タグ、$id) を読まず、印は最初の項目だけのもの (plan.md の 5、B-107 / B-135) なので、
// 最初の項目も 2 つ目からの項目と同じく印を書け、タグとグループは最初の項目だけに付く (deviations.md の D-033)

#[test]
fn edit_review_a06_first_items_sharing_the_container_line_can_mark() {
    let first_items: [(&str, Target); 5] = [
        ("- a\n- b\n- c\n", (2, "a")),
        ("---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n", (2, "a")),
        ("- a\n- b\n", (2, "a")),
        ("# R\n\n- a\n- b\n\n1. c\n2. d\n", (3, "a")),
        ("# R\n\n- a\n- b\n\n1. c\n2. d\n", (6, "1. c")),
    ];
    for (source, node) in first_items {
        let result = inspect(source, node);
        assert_eq!(result["kind"], "item", "{source:?} の {node:?}: {result}");
        assert_eq!(
            result["canMark"],
            json!(true),
            "{source:?} の {node:?}: {result}"
        );
        // 名前、詳細、子と兄弟も書ける
        for key in [
            "canRename",
            "canHaveDetails",
            "canAddChild",
            "canAddSibling",
        ] {
            assert_eq!(
                result[key],
                json!(true),
                "{source:?} の {node:?} の {key}: {result}"
            );
        }
    }
    // 2 つ目からの項目と、容器のない所の項目は印を書ける
    let markable: [(&str, Target); 5] = [
        ("- a\n- b\n- c\n", (3, "b")),
        ("---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n", (4, "c")),
        ("# R\n\n- a\n- b\n\n1. c\n2. d\n", (4, "b")),
        ("# R\n\n- a\n- b\n\n1. c\n2. d\n", (7, "2. d")),
        ("# R\n- a\n    - a1\n- b\n", (3, "a1")),
    ];
    for (source, node) in markable {
        let result = inspect(source, node);
        assert_eq!(
            result["canMark"],
            json!(true),
            "{source:?} の {node:?}: {result}"
        );
    }
    let result = inspect("# R\n- a\n- b\n", (2, "a"));
    assert_eq!(result["canMark"], json!(true), "{result}");
}

#[test]
fn edit_review_a06_marking_the_first_item_marks_only_the_first_item() {
    // 1 容器 (ルート) / 2 a / 3 b / 4 c。最初の項目の 1 行目に印を書き、解析し直すと印は a だけが読む (容器は読まない)
    let source = "---\nmarkdag:\n---\n- a\n- b\n- c\n";
    assert_target(source, (2, "a"));

    let tagged = "---\nmarkdag:\n---\n- a #k\n- b\n- c\n";
    let result = edited_by(
        source,
        json!({ "kind": "setTag", "nodes": [node_json((2, "a"))], "key": "k", "value": null, "replaceKey": null }),
    );
    assert_rewritten(source, &result, tagged, (2, "a"));
    let tag_keys = |id: u32| -> Vec<String> {
        node_of(tagged, id)
            .tags
            .into_iter()
            .map(|tag| tag.key)
            .collect()
    };
    assert_eq!(tag_keys(1), Vec::<String>::new(), "容器: {tagged:?}");
    assert_eq!(tag_keys(2), vec!["k".to_string()], "a: {tagged:?}");

    let grouped = "---\nmarkdag:\n    groups:\n        group1:\n            label: グループ 1\n            color: \"#3B7DD8\"\n            boundary: true\n---\n- a %group1\n- b\n- c\n";
    let result = edited_by(
        source,
        json!({ "kind": "groupNodes", "nodes": [node_json((2, "a"))] }),
    );
    assert_eq!(applied(source, &result), grouped, "{result}");
    assert_eq!(
        result["select"],
        json!({ "kind": "group", "id": "group1" }),
        "{result}"
    );
    assert_eq!(
        result["rename"],
        json!({ "kind": "group", "id": "group1" }),
        "{result}"
    );
    assert_eq!(
        node_of(grouped, 1).groups,
        Vec::<String>::new(),
        "容器: {grouped:?}"
    );
    assert_eq!(
        node_of(grouped, 2).groups,
        vec!["group1".to_string()],
        "a: {grouped:?}"
    );
}

// ---- B-01: 名前の変更の追随で、新しい名前の端が --> か & ----
// design 3.6 の名前の変更の追随: 名前を変えるノードに解決した区間を、書き換えたあとの原文での参照の書き方に置き換える
// (書いた参照がねらいのノードを指す)。名前の端の --> と & が式の区切りに読まれて線が消えないこと。
// 書き方 ("…" で囲むか $n で指すか) は決めず、線が同じ相手で残り、診断が増えないことを見る

const SEPARATOR_LIKE_NAMES: [&str; 8] = [
    "x -->", "x &", "--> y", "& y", "-->", "&", "x --> y", "x & y",
];

fn relations_document(relations: &str) -> String {
    format!("---\nmarkdag:\n  relations:\n{relations}---\n# R\n- a\n- b\n- c\n- d\n- e\n")
}

#[test]
fn edit_review_b01_rename_keeps_relations_when_the_name_has_separators_at_its_ends() {
    // どの式でも、名前を変えるノードが先頭、途中、末尾、& の前後に来る形を含める (a〜e のどれを変えても見る)
    let documents = [
        relations_document("    depends:\n      - a --> b\n      - c --> a\n"),
        relations_document("    join:\n      - a & c --> d\n      - b & c --> a\n"),
        relations_document("    chain:\n      - c --> a --> b\n      - e --> d --> a\n"),
        relations_document("    fork:\n      - a --> b & c\n      - d --> e & a\n"),
    ];
    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0;
    for source in &documents {
        let relations = relations_of(source);
        assert!(!relations.is_empty(), "線がある: {source:?}");
        let diagnostics = diagnostic_codes(source);
        assert!(diagnostics.is_empty(), "{source:?}: {diagnostics:?}");
        for name in ["a", "b", "c", "d", "e"] {
            let node = node_named(source, name);
            for label in SEPARATOR_LIKE_NAMES {
                checked += 1;
                let result = rename(source, (node.id, name), label);
                if result["status"] != "edited" {
                    failures.push(format!("{name} → {label:?}: {result}"));
                    continue;
                }
                let after = applied(source, &result);
                let renamed = node_of(&after, node.id).ref_text;
                let after_relations = relations_of(&after);
                let after_diagnostics = diagnostic_codes(&after);
                if renamed != label
                    || after_relations != relations
                    || after_diagnostics != diagnostics
                {
                    failures.push(format!(
                        "{name} → {label:?}: 名前 {renamed:?}、線 {after_relations:?}、診断 {after_diagnostics:?}\n{after}"
                    ));
                }
            }
        }
    }
    assert_eq!(checked, 160);
    assert!(
        failures.is_empty(),
        "{} / {checked} 件で線が変わった:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

// ---- B-05: 付け替えで内容の桁が変わっても、コードブロックの中身を書き直さない ----
// design 3.5 の付け替え (2 行目以降は相対の字下げを保つ) と字下げの書き方 (行の中身のタブは変えない)。
// 書き直すのは元の内容の桁までの字下げで、それより深い所の字 (タブと空白) は原文のまま残す

// ノードの html の中のコードブロックの中身 (<code …> と </code> の間)
fn code_of(html: &str) -> Option<String> {
    let start = html.find("<code")?;
    let open_end = start + html[start..].find('>')? + 1;
    let close = open_end + html[open_end..].find("</code>")?;
    Some(html[open_end..close].to_string())
}

fn assert_code_of(source: &str, ref_text: &str, code: &str) {
    assert_eq!(
        code_of(&node_named(source, ref_text).html).as_deref(),
        Some(code),
        "{ref_text} のコード: {source:?}"
    );
}

#[test]
fn edit_review_b05_move_keeps_tabs_inside_fenced_code() {
    // リストの項目からリストの項目の下へ (内容の桁 2 → 6): Makefile のタブを残す
    let source = "---\nmarkdag:\n---\n# R\n- a\n  ```make\n  build:\n  \tgcc x.c\n  ```\n- b\n";
    let expected = "---\nmarkdag:\n---\n# R\n- b\n    - a\n      ```make\n      build:\n      \tgcc x.c\n      ```\n";
    assert_code_of(source, "a", "build:\n\tgcc x.c\n");
    assert_code_of(expected, "a", "build:\n\tgcc x.c\n");
    let result = move_node(source, (2, "a"), (3, "b"));
    assert_rewritten(source, &result, expected, (3, "a"));
    assert_code_of(&applied(source, &result), "a", "build:\n\tgcc x.c\n");

    // 浅くする (内容の桁 6 → 2)
    let source = "---\nmarkdag:\n---\n# R\n- a\n    - b\n      ```make\n      build:\n      \tgcc x.c\n      ```\n- c\n";
    let expected =
        "---\nmarkdag:\n---\n# R\n- a\n- c\n- b\n  ```make\n  build:\n  \tgcc x.c\n  ```\n";
    assert_code_of(source, "b", "build:\n\tgcc x.c\n");
    assert_code_of(expected, "b", "build:\n\tgcc x.c\n");
    let result = move_node(source, (3, "b"), (1, "R"));
    assert_rewritten(source, &result, expected, (4, "b"));
    assert_code_of(&applied(source, &result), "b", "build:\n\tgcc x.c\n");
}

#[test]
fn edit_review_b05_move_a_heading_under_an_item_keeps_tabs_inside_fenced_code() {
    // 見出しをリストの項目の下へ (コードは項目の続きの行になる。内容の桁 0 → 6)
    let source =
        "---\nmarkdag:\n---\n# R\n\n## A\n\n- t\n\n## H\n\n```py\ndef f():\n\treturn 1\n```\n";
    let expected = "---\nmarkdag:\n---\n# R\n\n## A\n\n- t\n    - H\n\n      ```py\n      def f():\n      \treturn 1\n      ```\n";
    // 動かす前のコードは H の配下のコードのノード (5) の中身
    assert_eq!(
        code_of(&node_of(source, 5).html).as_deref(),
        Some("def f():\n\treturn 1\n")
    );
    assert_code_of(expected, "H", "def f():\n\treturn 1\n");
    let result = move_node(source, (4, "H"), (3, "t"));
    assert_rewritten(source, &result, expected, (4, "H"));
    assert_code_of(&applied(source, &result), "H", "def f():\n\treturn 1\n");
}

#[test]
fn edit_review_b05_spaces_inside_code_keep_their_relative_indent() {
    // 対照: 空白だけで字下げしたコードは今も中身が変わらない (直したあとも同じ)
    let source = "---\nmarkdag:\n---\n# R\n- a\n  ~~~\n  x\n      y\n  ~~~\n- b\n";
    let expected =
        "---\nmarkdag:\n---\n# R\n- b\n    - a\n      ~~~\n      x\n          y\n      ~~~\n";
    let result = move_node(source, (2, "a"), (3, "b"));
    assert_rewritten(source, &result, expected, (3, "a"));
    assert_code_of(&applied(source, &result), "a", "x\n    y\n");
}

// ---- B-06: 参照されているノードの名前を x/* や x/** にする ----
// design 3.6 の参照の書き方の (4): 名前でも親/名前でも決まらなければ、1 行目の末尾に $n を足して指す (線を引く操作と同じ)。
// ambiguous-reference は $id を持つノードだけ

#[test]
fn edit_review_b06_rename_to_a_selector_like_name_points_with_an_added_id() {
    let documents = [
        "---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n",
        "---\nmarkdag:\n  relations:\n    join:\n      - a & c --> b\n---\n# R\n- a\n- b\n- c\n",
    ];
    for source in documents {
        let relations = relations_of(source);
        assert!(!relations.is_empty(), "{source:?}");
        for label in ["x/*", "x/**"] {
            let result = rename(source, (2, "a"), label);
            assert_eq!(
                result["status"], "edited",
                "{source:?} → {label:?}: {result}"
            );
            assert!(
                note_codes(&result).contains(&"id-added".to_string()),
                "{label:?}: {result}"
            );
            let after = applied(source, &result);
            assert_eq!(node_of(&after, 2).ref_text, label, "{after:?}");
            assert_eq!(relations_of(&after), relations, "{after:?}");
            assert_eq!(diagnostic_codes(&after), Vec::<String>::new(), "{after:?}");
        }
    }
}

#[test]
fn edit_review_b06_nodes_with_an_id_still_refuse_as_ambiguous() {
    // $id を持つノードは 2 つ目の $id を書けないので、今までどおり ambiguous-reference
    let source = "---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a $dup\n- b\n- c $dup\n";
    assert_eq!(relations_of(source), vec![("depends".to_string(), 2, 3)]);
    for label in ["x/*", "x/**"] {
        assert_refused(&rename(source, (2, "a"), label), "ambiguous-reference");
    }
}

// ---- B-07: BOM で始まる文書の 1 行目のノード ----
// design 3.8: label は図の名前と同じ文字 (BOM と行頭の記号を入れない)。3.1: BOM は 1 行目の中身として扱う
// (名前ではない)。名前の変更は BOM を行頭に残して書き換える

#[test]
fn edit_review_b07_bom_first_line_label_has_no_bom_and_rename_keeps_it() {
    // (原文、ノード、label、名前を X にしたあとの原文、そのあとの refText)
    let cases: [(&str, Target, &str, &str, &str); 6] = [
        (
            "\u{FEFF}# R\n- a\n",
            (1, "R"),
            "R",
            "\u{FEFF}# X\n- a\n",
            "X",
        ),
        (
            "\u{FEFF}- a\n- b\n- c\n",
            (2, "a"),
            "a",
            "\u{FEFF}- X\n- b\n- c\n",
            "X",
        ),
        (
            "\u{FEFF}R\n=\n- a\n",
            (1, "R"),
            "R",
            "\u{FEFF}X\n=\n- a\n",
            "X",
        ),
        (
            "\u{FEFF}1. a\n2. b\n3. c\n",
            (2, "1. a"),
            "a",
            "\u{FEFF}1. X\n2. b\n3. c\n",
            "1. X",
        ),
        (
            "\u{FEFF}## [ ] R\n- a\n",
            (1, "R"),
            "R",
            "\u{FEFF}## [ ] X\n- a\n",
            "X",
        ),
        ("\u{FEFF}- a\n", (1, "a"), "a", "\u{FEFF}- X\n", "X"),
    ];
    for (source, node, label, expected, renamed) in cases {
        let result = inspect(source, node);
        assert_eq!(result["label"], label, "{source:?}: {result}");
        let result = rename(source, node, "X");
        assert_rewritten(source, &result, expected, (node.0, renamed));
        // label のまま決めると変えない
        assert_reason(&rename(source, node, label), "unchanged", "same-name");
    }
}

// ---- B-09: 式 1 つのスカラを一覧に書き直すときの行末のコメント ----
// design 4.2: 名前の追随、削除の追随、参照の守りも、線を引く操作と同じ 2 行の形にする (もとの式の文字は変えない)。
// 4.8: 範囲の外のコメントは残る。線を引く操作は、キーの行の後ろのコメントを項目の行の末尾に移す

#[test]
fn edit_review_b09_scalar_expression_keeps_its_trailing_comment() {
    let source =
        "---\nmarkdag:\n  relations:\n    depends: a --> b  # メモ\n---\n# R\n- a\n- b\n- c\n";
    assert_eq!(relations_of(source), vec![("depends".to_string(), 2, 3)]);

    // 対照: 線を引く操作はコメントを項目の行に残す (今の振る舞い)
    let result = edited_by(
        source,
        json!({ "kind": "addRelation", "from": node_json((3, "b")), "to": node_json((4, "c")) }),
    );
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n  relations:\n    depends:\n      - a --> b  # メモ\n      - b --> c\n---\n# R\n- a\n- b\n- c\n"
    );

    // 名前の変更の追随
    let result = rename(source, (2, "a"), "x");
    let after = applied(source, &result);
    assert_eq!(
        after,
        "---\nmarkdag:\n  relations:\n    depends:\n      - x --> b  # メモ\n---\n# R\n- x\n- b\n- c\n"
    );
    assert_eq!(relations_of(&after), vec![("depends".to_string(), 2, 3)]);

    // 参照の守り (同じ名前の兄弟を足すと名前の参照が決まらなくなり、$n1 で書き直す)
    let result = edited_by(
        source,
        json!({ "kind": "addSibling", "node": node_json((2, "a")), "label": "a" }),
    );
    let after = applied(source, &result);
    assert_eq!(
        after,
        "---\nmarkdag:\n  relations:\n    depends:\n      - $n1 --> b  # メモ\n---\n# R\n- a $n1\n- a\n- b\n- c\n"
    );
    assert_eq!(relations_of(&after), vec![("depends".to_string(), 2, 4)]);

    // 削除の追随 (chain の末尾の項を外して書き直す)
    let source = "---\nmarkdag:\n  relations:\n    chain: a --> b --> c --> d  # メモ\n---\n# R\n- a\n- b\n- c\n- d\n";
    let result = delete_nodes(source, &[(5, "d")]);
    let after = applied(source, &result);
    assert_eq!(
        after,
        "---\nmarkdag:\n  relations:\n    chain:\n      - a --> b --> c  # メモ\n---\n# R\n- a\n- b\n- c\n"
    );
    assert_eq!(
        relations_of(&after),
        vec![("chain".to_string(), 2, 3), ("chain".to_string(), 3, 4)]
    );
}

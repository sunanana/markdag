// 書き換えの公開の入口 (edit_source、inspect_node) を、操作をまたぐ境界の形で確かめる。
// 字下げが混ざる文書の入れ子の幅 (いちばん小さい差)、番号付きの項目の内容の桁、名前が空のノード、改行で終わらない CRLF の文書、
// 単独の \r と古いノードの指し方をどの操作でも断ること、差し替えの列の形、名前の入力の初めの値と詳細の原文をそのまま返すと変えないこと、
// フロー形式の frontmatter でも参照を書き直さない本文の操作は通すこと、frontmatter の足す所と消す所の境界 (空の frontmatter、
// 値のないキーとコメント、項目がキーと同じ字下げの一覧、`~`、組の中と外のコメント、CRLF)。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして比べる。関数名は edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

const NEW: &str = "新しいノード";
const MD: &str = "---\nmarkdag:\n---\n";

fn op(value: Value) -> EditOp {
    serde_json::from_value(value).expect("EditOp の JSON")
}

// 数を f64 にそろえる (整数で書くか浮動小数で書くかを契約に含めない)
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

fn run(source: &str, value: Value) -> Value {
    normalized(serde_json::to_value(edit_source(source, &op(value))).expect("結果は JSON にできる"))
}

fn node(id: u32, ref_text: &str) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn stale(id: f64, ref_text: &str) -> Value {
    json!({ "id": id, "refText": ref_text })
}

// 包みの写し: splices を後ろから原文の行に当てて \n でつなぐ
fn applied(source: &str, result: &Value) -> String {
    assert_eq!(result["status"], "edited", "書き換えるはず: {result}");
    let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
    for splice in result["splices"]
        .as_array()
        .expect("splices は配列")
        .iter()
        .rev()
    {
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

fn inspect(source: &str, id: u32, ref_text: &str) -> Value {
    let target: NodeTarget =
        serde_json::from_value(node(id, ref_text)).expect("NodeTarget の JSON");
    normalized(
        serde_json::to_value(inspect_node(source, &target).expect("ノードがある"))
            .expect("JSON にできる"),
    )
}

// 文書のノード (id と refText) を文書の順に
fn nodes_of(source: &str) -> Vec<(u32, String)> {
    parse_document(source)
        .nodes
        .into_iter()
        .map(|item| (item.id, item.ref_text))
        .collect()
}

fn id_of(source: &str, ref_text: &str) -> u32 {
    nodes_of(source)
        .into_iter()
        .find(|(_, text)| text == ref_text)
        .unwrap_or_else(|| panic!("「{ref_text}」のノードがある: {source:?}"))
        .0
}

fn target_of(source: &str, ref_text: &str) -> Value {
    node(id_of(source, ref_text), ref_text)
}

fn assert_reason(result: &Value, status: &str, code: &str, case: &str) {
    assert_eq!(result["status"], status, "{case}: {result}");
    assert_eq!(result["reason"]["code"], code, "{case}: {result}");
    assert!(
        result["reason"]["message"]
            .as_str()
            .is_some_and(|message| !message.trim().is_empty()),
        "{case}: message は空でない文: {result}"
    );
}

fn note_codes(result: &Value) -> Vec<String> {
    result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .map(|note| note["code"].as_str().expect("code は文字列").to_string())
        .collect()
}

fn selected_nodes(nodes: &[(u32, &str)]) -> Value {
    normalized(json!({
        "kind": "nodes",
        "nodes": nodes.iter().map(|(id, ref_text)| node(*id, ref_text)).collect::<Vec<_>>(),
    }))
}

fn add_child(source: &str, parent: Value) -> Value {
    run(
        source,
        json!({ "kind": "addChild", "parent": parent, "label": NEW }),
    )
}

// CRLF の文書で、改行で終わらない最後の行を除き、どの行も \r で終わる (\n だけの行がない)
fn assert_every_line_ends_with_carriage(text: &str, ends_with_newline: bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    let (last, body) = lines.split_last().expect("1 行以上");
    for line in body {
        assert!(
            line.ends_with('\r'),
            "\\r で終わらない行 {line:?}: {text:?}"
        );
    }
    if ends_with_newline {
        assert_eq!(*last, "", "{text:?}");
    } else {
        assert!(!last.ends_with('\r'), "単独の \\r を作らない: {text:?}");
    }
}

// ---- 字下げの混ざる文書の入れ子の幅 ----

// 入れ子の差が 2 (画面) と 4 (API) の文書
const MIXED: &str = "---\nmarkdag:\n---\n# 計画\n- 設計\n  - 画面\n- 実装\n    - API\n- 公開\n";

#[test]
fn edit_bounds_add_child_takes_the_smallest_nesting_width_when_widths_mix() {
    // 子のない項目に足す幅は、文書の入れ子の字下げの差のうち最小のもの (2)。いちばん大きい差 (4) ではない
    let result = add_child(MIXED, node(6, "公開"));
    assert_eq!(
        applied(MIXED, &result),
        "---\nmarkdag:\n---\n# 計画\n- 設計\n  - 画面\n- 実装\n    - API\n- 公開\n  - 新しいノード\n"
    );
    assert_eq!(result["select"], selected_nodes(&[(7, NEW)]));
    assert_eq!(
        result["rename"],
        normalized(json!({ "kind": "node", "node": node(7, NEW) }))
    );
}

#[test]
fn edit_bounds_nesting_width_does_not_depend_on_where_the_widths_appear() {
    // 差 4 が先、差 2 があと: 子のない項目にはやはり 2
    let source = "---\nmarkdag:\n---\n# 計画\n- 実装\n    - API\n- 設計\n  - 画面\n- 公開\n";
    assert_eq!(
        applied(source, &add_child(source, node(6, "公開"))),
        "---\nmarkdag:\n---\n# 計画\n- 実装\n    - API\n- 設計\n  - 画面\n- 公開\n  - 新しいノード\n"
    );
    // 子がいる項目は最後の子の形にそろえる (文書の最小の差ではなく、その子の字下げ 4)
    assert_eq!(
        applied(source, &add_child(source, node(2, "実装"))),
        "---\nmarkdag:\n---\n# 計画\n- 実装\n    - API\n    - 新しいノード\n- 設計\n  - 画面\n- 公開\n"
    );
}

#[test]
fn edit_bounds_add_child_under_a_deep_item_adds_the_smallest_width_to_its_indent() {
    // 差は 2 (a → b) と 4 (b → c)。c (字下げ 6) の子は 6 + 2 = 8
    let source = "# R\n- a\n  - b\n      - c\n";
    assert_eq!(
        applied(source, &add_child(source, node(4, "c"))),
        "# R\n- a\n  - b\n      - c\n        - 新しいノード\n"
    );
}

#[test]
fn edit_bounds_add_child_under_a_nested_numbered_item_uses_its_content_column() {
    // 文書の入れ子の差は 2 だが、`1. d` (字下げ 2) の内容の桁は 5。2 + 2 = 4 は内容の桁より小さいので 5 にそろえる
    let source = "# R\n- a\n  - b\n- c\n  1. d\n";
    let result = add_child(source, node(5, "1. d"));
    assert_eq!(
        applied(source, &result),
        "# R\n- a\n  - b\n- c\n  1. d\n     - 新しいノード\n"
    );
    assert_eq!(result["select"], selected_nodes(&[(6, NEW)]));
}

#[test]
fn edit_bounds_move_into_a_mixed_document_keeps_the_relative_indents() {
    // 実装 (配下の API は差 4、認証は差 4) を設計の下へ。設計の最後の子 (画面、字下げ 2) の形で書き、
    // 2 行目以降は元の内容の桁 (2) からの相対の字下げ (+2、+6) を新しい内容の桁 (4) に合わせる
    let source = "---\nmarkdag:\n---\n# R\n- 設計\n  - 画面\n- 実装\n    - API\n        - 認証\n";
    let result = run(
        source,
        json!({ "kind": "moveNode", "node": node(4, "実装"), "parent": node(2, "設計") }),
    );
    let after = applied(source, &result);
    assert_eq!(
        after,
        "---\nmarkdag:\n---\n# R\n- 設計\n  - 画面\n  - 実装\n      - API\n          - 認証\n"
    );
    let parents: Vec<(String, Option<u32>)> = parse_document(&after)
        .nodes
        .into_iter()
        .map(|item| (item.ref_text, item.parent))
        .collect();
    assert_eq!(
        parents,
        [
            ("R".to_string(), None),
            ("設計".to_string(), Some(1)),
            ("画面".to_string(), Some(2)),
            ("実装".to_string(), Some(2)),
            ("API".to_string(), Some(4)),
            ("認証".to_string(), Some(5)),
        ]
    );
    assert_eq!(result["select"], selected_nodes(&[(4, "実装")]));
}

#[test]
fn edit_bounds_set_details_in_a_mixed_document_takes_the_smallest_width() {
    // 詳細の字下げは子の項目の字下げ: 文書の入れ子の差の最小 (2)
    let result = run(
        MIXED,
        json!({ "kind": "setDetails", "node": node(6, "公開"), "text": "メモ" }),
    );
    assert_eq!(
        applied(MIXED, &result),
        "---\nmarkdag:\n---\n# 計画\n- 設計\n  - 画面\n- 実装\n    - API\n- 公開\n  > メモ\n"
    );
}

// ---- 名前が空のノード ----

#[test]
fn edit_bounds_add_child_under_an_item_with_an_empty_name_is_structure_changed() {
    // 1 行目が空の項目のすぐ下に入れ子の項目を書くと、その項目の 1 行目として読まれ、空の項目が消える。
    // 読み方が変わる書き換えは書き換えたあとの確かめで止める (原文を変えない)
    let source = "# R\n-\n- b\n";
    assert_reason(
        &add_child(source, node(2, "")),
        "refused",
        "structure-changed",
        "空の項目の子",
    );
}

#[test]
fn edit_bounds_add_relation_from_an_item_with_an_empty_name_marks_it_with_n() {
    // 名前が空のノードは名前でも 親/名前 でも指せないので、1 行目の末尾に $n1 を足して指す (どの書き方でも指せないノードの最後の手段)
    let source = format!("{MD}# R\n-\n- b\n");
    let result = run(
        &source,
        json!({ "kind": "addRelation", "from": node(2, ""), "to": node(3, "b") }),
    );
    assert_eq!(
        applied(&source, &result),
        "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> b\n---\n# R\n- $n1\n- b\n"
    );
    assert!(
        note_codes(&result).contains(&"id-added".to_string()),
        "{result}"
    );
}

#[test]
fn edit_bounds_rename_a_heading_or_an_item_under_it_to_an_empty_name_is_empty_name() {
    // どのノードも名前を空にできない (D-029): 見出しも、見出しの下の項目も empty-name で断り、原文を変えない
    let source = "# R\n## a\n- x\n- y\n";
    let result = run(
        source,
        json!({ "kind": "renameNode", "node": node(2, "a"), "label": "" }),
    );
    assert_reason(&result, "refused", "empty-name", "空の見出し");
    let result = run(
        source,
        json!({ "kind": "renameNode", "node": node(4, "y"), "label": "" }),
    );
    assert_reason(&result, "refused", "empty-name", "見出しの下の空の項目");
}

// ---- 改行で終わらない CRLF の文書 ----

#[test]
fn edit_bounds_rename_the_last_line_of_a_crlf_document_without_a_final_newline() {
    // 書き換える行は元の行末の \r を残す。最後の行には \r がないので付けない
    let source = "# R\r\n- a\r\n- b";
    let result = run(
        source,
        json!({ "kind": "renameNode", "node": node(3, "b"), "label": "c" }),
    );
    assert_eq!(applied(source, &result), "# R\r\n- a\r\n- c");
}

#[test]
fn edit_bounds_tag_the_last_line_of_a_crlf_document_without_a_final_newline() {
    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- a";
    let result = run(
        source,
        json!({ "kind": "setTag", "nodes": [node(2, "a")], "key": "k", "value": null, "replaceKey": null }),
    );
    assert_eq!(
        applied(source, &result),
        "---\r\nmarkdag:\r\n---\r\n# R\r\n- a #k"
    );
}

// ---- どの操作でも同じ断り ----

// 2 a (タグ k、グループ g)、3 b、4 c。グループ g の定義あり
const ALL_OPS_DOC: &str =
    "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n# R\n- a %g #k\n- b\n- c\n";

// 原文の正しいノードを指す、19 種の操作
fn every_op(source: &str) -> Vec<(&'static str, Value)> {
    let r = target_of(source, "R");
    let a = target_of(source, "a");
    let b = target_of(source, "b");
    let c = target_of(source, "c");
    vec![
        (
            "addChild",
            json!({ "kind": "addChild", "parent": r, "label": "x" }),
        ),
        (
            "addSibling",
            json!({ "kind": "addSibling", "node": a, "label": "x" }),
        ),
        (
            "renameNode",
            json!({ "kind": "renameNode", "node": a, "label": "z" }),
        ),
        (
            "deleteNodes",
            json!({ "kind": "deleteNodes", "nodes": [b] }),
        ),
        (
            "moveNode",
            json!({ "kind": "moveNode", "node": b, "parent": a }),
        ),
        (
            "setDetails",
            json!({ "kind": "setDetails", "node": a, "text": "d" }),
        ),
        (
            "setTag",
            json!({ "kind": "setTag", "nodes": [b], "key": "x", "value": null, "replaceKey": null }),
        ),
        (
            "removeTag",
            json!({ "kind": "removeTag", "nodes": [a], "key": "k" }),
        ),
        (
            "toggleTag",
            json!({ "kind": "toggleTag", "nodes": [a], "key": "k", "value": null }),
        ),
        (
            "addToGroup",
            json!({ "kind": "addToGroup", "group": "g", "nodes": [b] }),
        ),
        (
            "addRelation",
            json!({ "kind": "addRelation", "from": a, "to": c }),
        ),
        (
            "joinInto",
            json!({ "kind": "joinInto", "sources": [a, b], "target": c }),
        ),
        (
            "joinIntoNew",
            json!({ "kind": "joinIntoNew", "sources": [a, b], "label": "合流点" }),
        ),
        ("groupNodes", json!({ "kind": "groupNodes", "nodes": [b] })),
        ("defineGroup", json!({ "kind": "defineGroup" })),
        (
            "renameGroup",
            json!({ "kind": "renameGroup", "group": "g", "label": "H" }),
        ),
        (
            "setGroupColor",
            json!({ "kind": "setGroupColor", "group": "g", "color": "#123456" }),
        ),
        (
            "setGroupBoundary",
            json!({ "kind": "setGroupBoundary", "group": "g", "boundary": true }),
        ),
        ("ungroup", json!({ "kind": "ungroup", "group": "g" })),
    ]
}

#[test]
fn edit_bounds_every_op_edits_the_document_without_lone_carriage_returns() {
    // 次のテストの相手: 単独の \r のない同じ文書では、どの操作も書き換える (断る理由が単独の \r だけであることの確かめ)
    for (name, value) in every_op(ALL_OPS_DOC) {
        let result = run(ALL_OPS_DOC, value);
        assert_eq!(result["status"], "edited", "{name}: {result}");
    }
}

#[test]
fn edit_bounds_every_op_rewrites_a_lone_carriage_return_as_the_document_line_break() {
    // c の続きの段落に単独の \r。名前と id はどれも同じに読まれる。どの操作も、単独の \r を文書の改行 (\n) にそろえてから書き換え、
    // 結果はそろえた文書に同じ操作を当てたときと同じ (原文、選び直し、知らせ)。単独の \r は残らない (D-062)
    let source = ALL_OPS_DOC.replace("- c\n", "- c\n  続き\rの行\n");
    let normalized_source = ALL_OPS_DOC.replace("- c\n", "- c\n  続き\nの行\n");
    assert_eq!(nodes_of(&source), nodes_of(ALL_OPS_DOC));
    assert_eq!(nodes_of(&normalized_source), nodes_of(ALL_OPS_DOC));
    for ((name, value), (_, same)) in every_op(&source)
        .into_iter()
        .zip(every_op(&normalized_source))
    {
        let result = run(&source, value);
        let expected = run(&normalized_source, same);
        assert_eq!(result["status"], "edited", "{name}: {result}");
        let after = applied(&source, &result);
        assert_eq!(
            after,
            applied(&normalized_source, &expected),
            "{name}: {result}"
        );
        assert!(!after.contains('\r'), "{name}: {after:?}");
        assert_eq!(result["select"], expected["select"], "{name}: {result}");
        assert_eq!(result["rename"], expected["rename"], "{name}: {result}");
        assert_eq!(
            note_codes(&result),
            note_codes(&expected),
            "{name}: {result}"
        );
    }
}

#[test]
fn edit_bounds_every_node_op_refuses_stale_targets() {
    // 同じ id のノードがないか、refText が違うか、id が整数でなければ stale-node。複数を指す操作は 1 つでも古ければ全体を断る
    let a = node(2, "a");
    let b = node(3, "b");
    let c = node(4, "c");
    for bad in [
        stale(2.0, "z"),
        stale(99.0, "a"),
        stale(2.5, "a"),
        stale(0.0, "R"),
    ] {
        let cases = vec![
            (
                "addChild",
                json!({ "kind": "addChild", "parent": bad, "label": "x" }),
            ),
            (
                "addSibling",
                json!({ "kind": "addSibling", "node": bad, "label": "x" }),
            ),
            (
                "renameNode",
                json!({ "kind": "renameNode", "node": bad, "label": "z" }),
            ),
            (
                "deleteNodes",
                json!({ "kind": "deleteNodes", "nodes": [b, bad] }),
            ),
            (
                "moveNode の node",
                json!({ "kind": "moveNode", "node": bad, "parent": c }),
            ),
            (
                "moveNode の parent",
                json!({ "kind": "moveNode", "node": b, "parent": bad }),
            ),
            (
                "setDetails",
                json!({ "kind": "setDetails", "node": bad, "text": "d" }),
            ),
            (
                "setTag",
                json!({ "kind": "setTag", "nodes": [b, bad], "key": "x", "value": null, "replaceKey": null }),
            ),
            (
                "removeTag",
                json!({ "kind": "removeTag", "nodes": [a, bad], "key": "k" }),
            ),
            (
                "toggleTag",
                json!({ "kind": "toggleTag", "nodes": [a, bad], "key": "k", "value": null }),
            ),
            (
                "addToGroup",
                json!({ "kind": "addToGroup", "group": "g", "nodes": [b, bad] }),
            ),
            (
                "addRelation の from",
                json!({ "kind": "addRelation", "from": bad, "to": c }),
            ),
            (
                "addRelation の to",
                json!({ "kind": "addRelation", "from": b, "to": bad }),
            ),
            (
                "joinInto の sources",
                json!({ "kind": "joinInto", "sources": [a, b, bad], "target": c }),
            ),
            (
                "joinInto の target",
                json!({ "kind": "joinInto", "sources": [a, b], "target": bad }),
            ),
            (
                "joinIntoNew",
                json!({ "kind": "joinIntoNew", "sources": [a, b, bad], "label": "合流点" }),
            ),
            (
                "groupNodes",
                json!({ "kind": "groupNodes", "nodes": [b, bad] }),
            ),
        ];
        for (name, value) in cases {
            let case = format!("{name} {bad}");
            assert_reason(&run(ALL_OPS_DOC, value), "refused", "stale-node", &case);
        }
    }
}

// ---- 差し替えの列の形 (start の昇順、重ならない。lines は行末の \n を含まない) ----

#[test]
fn edit_bounds_splices_are_ascending_and_do_not_overlap() {
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n---\n# 計画\n## 設計\n- 画面\n- API\n## 公開\n- 手順\n";
    let line_count = source.split('\n').count() as f64;
    let ops = [
        json!({ "kind": "renameNode", "node": node(2, "設計"), "label": "基本設計" }),
        json!({ "kind": "deleteNodes", "nodes": [node(2, "設計")] }),
        json!({ "kind": "groupNodes", "nodes": [node(3, "画面"), node(6, "手順")] }),
        json!({ "kind": "joinIntoNew", "sources": [node(3, "画面"), node(6, "手順")], "label": "合流点" }),
        json!({ "kind": "moveNode", "node": node(6, "手順"), "parent": node(2, "設計") }),
        json!({ "kind": "addRelation", "from": node(4, "API"), "to": node(6, "手順") }),
        json!({ "kind": "setDetails", "node": node(3, "画面"), "text": "x\ny" }),
        json!({ "kind": "setTag", "nodes": [node(3, "画面"), node(6, "手順")], "key": "k", "value": "v", "replaceKey": null }),
    ];
    for value in ops {
        let case = value.to_string();
        let result = run(source, value);
        assert_eq!(result["status"], "edited", "{case}: {result}");
        let splices = result["splices"].as_array().expect("splices は配列");
        assert!(!splices.is_empty(), "{case}");
        // 前の差し替えの start と、前の差し替えが消す行の終わり
        let mut previous: Option<(f64, f64)> = None;
        for splice in splices {
            let start = splice["start"].as_f64().expect("start");
            let delete_count = splice["deleteCount"].as_f64().expect("deleteCount");
            assert!(
                start + delete_count <= line_count,
                "{case}: 原文の行の外 {splice}"
            );
            if let Some((previous_start, previous_end)) = previous {
                assert!(
                    start > previous_start && start >= previous_end,
                    "{case}: 昇順で重ならない {splices:?}"
                );
            }
            previous = Some((start, start + delete_count));
            for line in splice["lines"].as_array().expect("lines") {
                assert!(!line.as_str().expect("行").contains('\n'), "{case}: {line}");
            }
        }
        assert!(
            !parse_document(&applied(source, &result)).nodes.is_empty(),
            "{case}"
        );
    }
}

// ---- 読んだ値をそのまま返すと変えない ----

// 逃がしの \、番号、タスク、末尾の印、見出しの閉じ、下線の見出し、タブ、CRLF、markdag キーのない文書、改行で終わらない文書
const ROUND_TRIP_DOCS: [&str; 6] = [
    "---\nmarkdag:\n---\n# 計画 ##\n\n## 設計 \\#a\n- 1\\. 準備 %g\n- \\[ ] x #k:v\n- y \\$z\n\t- タブ\n- \\# 見出し風\n- 末尾 \\%g2\n",
    "---\r\nmarkdag:\r\n---\r\n# R\r\n- a \\#b\r\n  1. c\r\n  2. [x] d #k\r\n",
    "# R\n- a #k\n- b %g\n- c \\#d\n",
    "---\nmarkdag:\n---\n設計\n===\n\n- x\n\n実装\n---\n\n- y\n",
    "---\nmarkdag:\n---\n# R #\n## a ## #k\n- b\n",
    "# R\n-\n- b",
];

#[test]
fn edit_bounds_renaming_to_the_inspected_label_is_unchanged_for_every_node() {
    let mut checked = 0;
    for source in ROUND_TRIP_DOCS {
        for (id, ref_text) in nodes_of(source) {
            let found = inspect(source, id, &ref_text);
            if found["canRename"] != json!(true) {
                continue;
            }
            let label = found["label"].as_str().expect("label は文字列").to_string();
            let result = run(
                source,
                json!({ "kind": "renameNode", "node": node(id, &ref_text), "label": label }),
            );
            let case = format!("{source:?} の {id} {ref_text:?} (label {label:?})");
            assert_reason(&result, "unchanged", "same-name", &case);
            checked += 1;
        }
    }
    assert!(checked >= 20, "確かめたノードの数 {checked}");
}

#[test]
fn edit_bounds_setting_the_inspected_details_is_unchanged_for_every_item() {
    let sources = [
        "---\nmarkdag:\n---\n# R\n- a\n    > x\n    >\n    > **y**\n    - c\n- b\n  > 2 の字下げ\n- d\n",
        "---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n    > x\r\n    > y\r\n- b\r\n",
        "---\nmarkdag:\n---\n# R\n- a\n\t> x\n\t> y\n",
        "---\nmarkdag:\n---\n# R\n- a\n  続き\n  > x\n- b\n",
        "---\nmarkdag:\n---\n# R\n1. a\n   > x\n2. b",
    ];
    let mut with_details = 0;
    for source in sources {
        for (id, ref_text) in nodes_of(source) {
            let found = inspect(source, id, &ref_text);
            if found["canHaveDetails"] != json!(true) {
                continue;
            }
            let text = found["details"].as_str().unwrap_or("").to_string();
            if !text.is_empty() {
                with_details += 1;
            }
            let result = run(
                source,
                json!({ "kind": "setDetails", "node": node(id, &ref_text), "text": text }),
            );
            let case = format!("{source:?} の {id} {ref_text:?} (details {text:?})");
            assert_reason(&result, "unchanged", "nothing-to-change", &case);
        }
    }
    assert!(with_details >= 5, "詳細のあるノードの数 {with_details}");
}

// ---- フロー形式の frontmatter (参照を書き直さない本文の操作は断らない) ----

#[test]
fn edit_bounds_body_ops_go_through_flow_style_frontmatter_when_no_reference_changes() {
    let source = "---\nmarkdag: {relations: {depends: [a --> b]}}\n---\n# R\n- a\n- b\n- c\n";
    let frontmatter: Vec<&str> = source.split('\n').take(3).collect();
    for value in [
        json!({ "kind": "renameNode", "node": node(4, "c"), "label": "d" }),
        json!({ "kind": "addChild", "parent": node(4, "c"), "label": NEW }),
        json!({ "kind": "addSibling", "node": node(4, "c"), "label": NEW }),
        json!({ "kind": "deleteNodes", "nodes": [node(4, "c")] }),
        json!({ "kind": "moveNode", "node": node(4, "c"), "parent": node(2, "a") }),
    ] {
        let case = value.to_string();
        let result = run(source, value);
        assert_eq!(result["status"], "edited", "{case}: {result}");
        let after = applied(source, &result);
        assert_eq!(
            after.split('\n').take(3).collect::<Vec<_>>(),
            frontmatter,
            "{case}"
        );
    }
}

// ---- frontmatter の足す所 ----

#[test]
fn edit_bounds_add_relation_into_an_empty_frontmatter() {
    // 空の frontmatter (--- の次の行が ---) は、その間に markdag: と子の行を入れる
    let source = "---\n---\n# R\n- a\n- b\n";
    let result = run(
        source,
        json!({ "kind": "addRelation", "from": node(2, "a"), "to": node(3, "b") }),
    );
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n"
    );
    assert!(
        note_codes(&result).contains(&"markdag-added".to_string()),
        "{result}"
    );
}

#[test]
fn edit_bounds_add_relation_under_a_bare_key_keeps_the_comment_after_it() {
    // 値のないキー (relations:) はキーの行のすぐあとに足し、そのあとのコメントの行は足した行のあとに残る
    let source = "---\nmarkdag:\n    relations:\n    # メモ\n---\n# R\n- a\n- b\n";
    let result = run(
        source,
        json!({ "kind": "addRelation", "from": node(2, "a"), "to": node(3, "b") }),
    );
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n    # メモ\n---\n# R\n- a\n- b\n"
    );
}

#[test]
fn edit_bounds_add_relation_to_a_list_written_at_the_key_indent() {
    // 項目がキーと同じ字下げの一覧 (`depends:` の下の `- `): 既存の項目の字下げで足す
    let source =
        "---\nmarkdag:\n  relations:\n    depends:\n    - a --> b\n---\n# R\n- a\n- b\n- c\n";
    let result = run(
        source,
        json!({ "kind": "addRelation", "from": node(2, "a"), "to": node(4, "c") }),
    );
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n  relations:\n    depends:\n    - a --> b\n    - a --> c\n---\n# R\n- a\n- b\n- c\n"
    );
}

#[test]
fn edit_bounds_group_nodes_into_groups_written_as_null() {
    // 値の字がある null (`groups: ~`) は値の範囲を消して、値のないキーと同じに子を足す (行末の空白は比べない)
    let source = "---\nmarkdag:\n    groups: ~\n---\n# R\n- a\n";
    let result = run(
        source,
        json!({ "kind": "groupNodes", "nodes": [node(2, "a")] }),
    );
    let after: Vec<String> = applied(source, &result)
        .split('\n')
        .map(|line| line.trim_end().to_string())
        .collect();
    assert_eq!(
        after.join("\n"),
        "---\nmarkdag:\n    groups:\n        group1:\n            label: グループ 1\n            color: \"#3B7DD8\"\n            boundary: true\n---\n# R\n- a %group1\n"
    );
}

// ---- frontmatter の消す所 ----

#[test]
fn edit_bounds_ungroup_removes_comments_inside_the_definition_and_keeps_the_ones_after() {
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            # 中のコメント\n            color: \"#123456\"\n    # 外のコメント\n---\n# R\n- a %g\n- b\n";
    let result = run(source, json!({ "kind": "ungroup", "group": "g" }));
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n    # 外のコメント\n---\n# R\n- a\n- b\n"
    );
}

#[test]
fn edit_bounds_ungroup_a_definition_without_fields() {
    // 値のないグループの定義 (`g:`) もキーの行ごと消し、空になった groups も消す
    let source = "---\nmarkdag:\n    groups:\n        g:\n---\n# R\n- a %g\n";
    let result = run(source, json!({ "kind": "ungroup", "group": "g" }));
    assert_eq!(applied(source, &result), "---\nmarkdag:\n---\n# R\n- a\n");
}

// ---- グループの frontmatter の書き換えと CRLF ----

#[test]
fn edit_bounds_group_definition_ops_keep_crlf() {
    let source = "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n---\r\n# R\r\n- a %g\r\n- b\r\n";
    let rename = run(
        source,
        json!({ "kind": "renameGroup", "group": "g", "label": "H" }),
    );
    assert_eq!(
        applied(source, &rename),
        "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: H\r\n---\r\n# R\r\n- a %g\r\n- b\r\n"
    );
    let color = run(
        source,
        json!({ "kind": "setGroupColor", "group": "g", "color": "#123456" }),
    );
    assert_eq!(
        applied(source, &color),
        "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n            color: \"#123456\"\r\n---\r\n# R\r\n- a %g\r\n- b\r\n"
    );
    let boundary = run(
        source,
        json!({ "kind": "setGroupBoundary", "group": "g", "boundary": true }),
    );
    assert_eq!(
        applied(source, &boundary),
        "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n            boundary: true\r\n---\r\n# R\r\n- a %g\r\n- b\r\n"
    );
    let defined = run(source, json!({ "kind": "defineGroup" }));
    assert_every_line_ends_with_carriage(&applied(source, &defined), true);
    let added = run(
        source,
        json!({ "kind": "addToGroup", "group": "g", "nodes": [node(3, "b")] }),
    );
    assert_eq!(
        applied(source, &added),
        "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n---\r\n# R\r\n- a %g\r\n- b %g\r\n"
    );
}

// ---- タグの値は書いたとおりに読み戻せる ----

#[test]
fn edit_bounds_tag_values_read_back_as_written() {
    let source = format!("{MD}# R\n- a\n");
    for value in ["x", "山田 太郎", "a,b", "10:30", "日本", "v1.2"] {
        let result = run(
            &source,
            json!({ "kind": "setTag", "nodes": [node(2, "a")], "key": "k", "value": value, "replaceKey": null }),
        );
        let after = applied(&source, &result);
        let tags = &parse_document(&after).nodes[1].tags;
        assert_eq!(tags.len(), 1, "{value:?}: {after:?}");
        assert_eq!(tags[0].key, "k", "{value:?}");
        assert_eq!(tags[0].values, [value.to_string()], "{value:?}: {after:?}");
        assert_eq!(parse_document(&after).nodes[1].ref_text, "a", "{value:?}");
    }
}

// ---- markdag: を足す操作と文書の先頭の BOM ----

// markdag: を足す 8 種の操作 (詳細、タグ 2 つ、グループ 2 つ、線、合流 2 つ)
fn markdag_adding_ops(source: &str) -> Vec<(&'static str, Value)> {
    let a = target_of(source, "a");
    let b = target_of(source, "b");
    let c = target_of(source, "c");
    vec![
        (
            "setDetails",
            json!({ "kind": "setDetails", "node": a, "text": "d" }),
        ),
        (
            "setTag",
            json!({ "kind": "setTag", "nodes": [a], "key": "k", "value": null, "replaceKey": null }),
        ),
        (
            "toggleTag",
            json!({ "kind": "toggleTag", "nodes": [a], "key": "k", "value": null }),
        ),
        ("groupNodes", json!({ "kind": "groupNodes", "nodes": [a] })),
        ("defineGroup", json!({ "kind": "defineGroup" })),
        (
            "addRelation",
            json!({ "kind": "addRelation", "from": a, "to": b }),
        ),
        (
            "joinInto",
            json!({ "kind": "joinInto", "sources": [a, b], "target": c }),
        ),
        (
            "joinIntoNew",
            json!({ "kind": "joinIntoNew", "sources": [a, b], "label": "合流点" }),
        ),
    ]
}

#[test]
fn edit_bounds_markdag_adding_ops_remove_a_leading_bom_to_create_frontmatter() {
    // frontmatter の開きは文書の先頭の --- でしか読まれないので、作るときは BOM を外す (note bom-removed)
    let source = "\u{feff}# R\n- a\n- b\n- c\n";
    for (name, value) in markdag_adding_ops(source) {
        let result = run(source, value);
        assert_eq!(result["status"], "edited", "{name}: {result}");
        let after = applied(source, &result);
        assert!(after.starts_with("---\nmarkdag:"), "{name}: {after:?}");
        assert!(!after.contains('\u{feff}'), "{name}: {after:?}");
        let codes = note_codes(&result);
        for code in ["bom-removed", "frontmatter-added"] {
            assert!(codes.contains(&code.to_string()), "{name}: {result}");
        }
    }
}

#[test]
fn edit_bounds_markdag_adding_ops_remove_a_bom_right_before_a_fence() {
    // BOM のせいで読まれていない frontmatter がある文書は、BOM を外してその frontmatter に markdag: を足してから書く。
    // 結果は BOM のない同じ文書に同じ操作を当てたときと同じで、知らせに bom-removed が加わる (D-067)
    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n- b\n- c\n";
    let plain = "---\ntitle: T\n---\n# R\n- a\n- b\n- c\n";
    for ((name, value), (_, same)) in markdag_adding_ops(source)
        .into_iter()
        .zip(markdag_adding_ops(plain))
    {
        let result = run(source, value);
        let expected = run(plain, same);
        assert_eq!(result["status"], "edited", "{name}: {result}");
        let after = applied(source, &result);
        assert_eq!(after, applied(plain, &expected), "{name}: {result}");
        assert!(
            after.starts_with("---\ntitle: T\nmarkdag:"),
            "{name}: {after:?}"
        );
        assert!(!after.contains('\u{feff}'), "{name}: {after:?}");
        assert_eq!(result["select"], expected["select"], "{name}: {result}");
        assert_eq!(result["rename"], expected["rename"], "{name}: {result}");
        let mut codes = note_codes(&expected);
        codes.push("bom-removed".to_string());
        codes.sort();
        let mut actual = note_codes(&result);
        actual.sort();
        assert_eq!(actual, codes, "{name}: {result}");
    }
}

#[test]
fn edit_bounds_markdag_adding_ops_rewrite_flow_style_and_refuse_frontmatter_that_is_not_a_map() {
    // frontmatter の全体がフロー形式なら、字下げの形 (title: T) に書き直してから markdag: を足す。結果は字下げの形で書いた
    // 同じ文書に同じ操作を当てたときと同じ (D-052)。最上位が写像でなければ今のまま frontmatter-not-map
    let source = "---\n{title: T}\n---\n# R\n- a\n- b\n- c\n";
    let block = "---\ntitle: T\n---\n# R\n- a\n- b\n- c\n";
    for ((name, value), (_, same)) in markdag_adding_ops(source)
        .into_iter()
        .zip(markdag_adding_ops(block))
    {
        let result = run(source, value);
        let expected = run(block, same);
        assert_eq!(result["status"], "edited", "{name}: {result}");
        assert_eq!(
            applied(source, &result),
            applied(block, &expected),
            "{name}: {result}"
        );
        assert_eq!(result["select"], expected["select"], "{name}: {result}");
        assert_eq!(result["rename"], expected["rename"], "{name}: {result}");
        assert_eq!(
            note_codes(&result),
            note_codes(&expected),
            "{name}: {result}"
        );
    }
    let source = "---\n- x\n---\n# R\n- a\n- b\n- c\n";
    for (name, value) in markdag_adding_ops(source) {
        assert_reason(&run(source, value), "refused", "frontmatter-not-map", name);
    }
}

// ---- 改行の種類が混ざる文書 (文書の最初の改行で決める) ----

#[test]
fn edit_bounds_the_first_line_break_decides_the_line_ending_of_added_lines() {
    // 最初の改行が \n なら LF の文書: 足す行に \r を付けず、ほかの行の \r は変えない
    let source = "# R\n- a\r\n- b\r\n";
    let result = run(
        source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": NEW }),
    );
    assert_eq!(
        applied(source, &result),
        "# R\n- a\r\n- 新しいノード\n- b\r\n"
    );
    // 最初の改行が \r\n なら CRLF の文書: 足す行に \r を付ける
    let source = "# R\r\n- a\n- b\n";
    let result = run(
        source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": NEW }),
    );
    assert_eq!(
        applied(source, &result),
        "# R\r\n- a\n- 新しいノード\r\n- b\n"
    );
    // 名前を変えた行は、その行の行末のまま
    let result = run(
        "# R\n- a\r\n",
        json!({ "kind": "renameNode", "node": node(2, "a"), "label": "x" }),
    );
    assert_eq!(applied("# R\n- a\r\n", &result), "# R\n- x\r\n");
}

// ---- 入れた名前はそのまま名前として読み戻せる (書き換えたあとの確かめと、名前の逃がし) ----

#[test]
fn edit_bounds_unusual_names_read_back_as_written() {
    let long = "長".repeat(2000);
    let names = [
        "👨‍👩‍👧 家族",
        "🇯🇵",
        "مرحبا بالعالم",
        "a \u{202e}b",
        "100%",
        "a %",
        "a #",
        "a $",
        "a: b # c",
        "\"引用\"",
        "末尾 \\",
        long.as_str(),
    ];
    for markdag in [true, false] {
        let source = if markdag {
            format!("{MD}# R\n- a\n- b\n")
        } else {
            "# R\n- a\n- b\n".to_string()
        };
        for name in names {
            let result = run(
                &source,
                json!({ "kind": "renameNode", "node": node(2, "a"), "label": name }),
            );
            let case = format!(
                "markdag {markdag} {:?}",
                name.chars().take(20).collect::<String>()
            );
            assert_eq!(result["status"], "edited", "{case}: {result}");
            let after = applied(&source, &result);
            let renamed = &parse_document(&after).nodes[1];
            assert_eq!(renamed.ref_text, name, "{case}: {after:?}");
            assert!(
                renamed.tags.is_empty() && renamed.groups.is_empty() && renamed.ref_id.is_none(),
                "{case}"
            );
            // 開き直した名前の入力の初めの値も同じ名前
            assert_eq!(inspect(&after, 2, name)["label"], json!(name), "{case}");
        }
    }
}

#[test]
fn edit_bounds_names_with_inline_markdown_reopen_as_written() {
    // 名前の Markdown の記法はそのまま書き、名前の入力の初めの値も書いたとおり (refText は記法を外した文字)
    let source = format!("{MD}# R\n- a\n");
    let name = "`code` と *強調*";
    let result = run(
        &source,
        json!({ "kind": "renameNode", "node": node(2, "a"), "label": name }),
    );
    let after = applied(&source, &result);
    let ref_text = parse_document(&after).nodes[1].ref_text.clone();
    assert_eq!(
        inspect(&after, 2, &ref_text)["label"],
        json!(name),
        "{after:?}"
    );
    let again = run(
        &after,
        json!({ "kind": "renameNode", "node": node(2, &ref_text), "label": name }),
    );
    assert_reason(&again, "unchanged", "same-name", name);
}

// ---- frontmatter に書いた値は同じ文字列として読める ----

fn group_label_of(source: &str) -> Option<markdag_core::model::util::JsValue> {
    use markdag_core::model::util::JsValue;
    let JsValue::Object(top) = parse_document(source).frontmatter else {
        return None;
    };
    let JsValue::Object(markdag) = top.get("markdag")?.clone() else {
        return None;
    };
    let JsValue::Object(groups) = markdag.get("groups")?.clone() else {
        return None;
    };
    let JsValue::Object(group) = groups.get("g")?.clone() else {
        return None;
    };
    group.get("label").cloned()
}

#[test]
fn edit_bounds_group_labels_read_back_as_the_same_string() {
    use markdag_core::model::util::JsValue;
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n# R\n- a %g\n";
    for label in [
        "1e3",
        ".5",
        "+1",
        "-1",
        "0x1F",
        "0o17",
        "1_000",
        ".inf",
        "-.inf",
        ".nan",
        "NULL",
        "True",
        "Yes",
        "~",
        "12:30",
        "a: b",
        "a #b",
        "#a",
        "- a",
        "? a",
        "[a]",
        "{a}",
        "*a",
        "&a",
        "!a",
        "|a",
        ">a",
        "%a",
        "@a",
        "`a`",
        "'a'",
        "\"a\"",
        "a\\b",
        " 前後の空白 ",
        "グループ: 設計 #1",
        "👨‍👩‍👧",
    ] {
        let result = run(
            source,
            json!({ "kind": "renameGroup", "group": "g", "label": label }),
        );
        // 前後の空白は名前の入力と同じく外す
        let expected = label.trim();
        assert_eq!(result["status"], "edited", "{label:?}: {result}");
        let after = applied(source, &result);
        assert_eq!(
            group_label_of(&after),
            Some(JsValue::String(expected.to_string())),
            "{label:?}: {after:?}"
        );
    }
}

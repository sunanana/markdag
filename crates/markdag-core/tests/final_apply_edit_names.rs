// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 1、9、16) を、直す前に落ちるテストとして書く。
// 1. AM-06: 名前の逃がしを行の全体 (行頭の印、名前、後ろの印) で決め、断らずに書く。今の名前だけの逃がしは残し、足りない所にだけ \ を足す。
//    足す操作 (addChild、addSibling、joinIntoNew) の名前も同じ。名前の入力の初めの値 (inspect_node の label) に、足した \ を出さない (細部 1、2)
// 2. B-134: タグのキーと値は要るときだけ " で囲み、囲みの中の " と \ を逃がして書く。タグの操作は空のキーのほかは断らない。
//    空の値は "" と囲む (細部 13 と、5 章の「解析を直す」のあとの決定)
// 3. empty-name: どのノードも名前を空にできない。理由の文は「名前を空にできません」だけ。今の名前が空のノードを空のまま決めたら
//    same-name が先。足す操作の空の名前は断らない (細部 25、26)
// 変えない挙動 (今も通り、直したあとも通るもの) は、名前か注に「変えない」と書いた。
// 公開の markdag_core::edit (edit_source、inspect_node)、parse_document、format_tag と types の型の名前だけを使う。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして見る。関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::model::tags::format_tag;
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTag, NodeTarget, OutlineNode, SourcePosition};
use serde_json::{Value, json};

// markdag キーだけの frontmatter (印を読む文書)。本文の 1 行目は 4 行目 (0 始まりの添字は 3)
const MD: &str = "---\nmarkdag:\n---\n";

// empty-name の理由の文 (scope.md の「最後の関門 原文の都合で断る 7」)
const EMPTY_NAME_MESSAGE: &str = "名前を空にできません";

// ---- 入出力の補助 ----

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

fn rename(source: &str, id: u32, ref_text: &str, label: &str) -> Value {
    run(
        source,
        json!({ "kind": "renameNode", "node": node(id, ref_text), "label": label }),
    )
}

fn set_tag(
    source: &str,
    nodes: &[(u32, &str)],
    key: &str,
    value: Option<&str>,
    replace_key: Option<&str>,
) -> Value {
    let nodes: Vec<Value> = nodes.iter().map(|(id, name)| node(*id, name)).collect();
    run(
        source,
        json!({ "kind": "setTag", "nodes": nodes, "key": key, "value": value, "replaceKey": replace_key }),
    )
}

fn toggle_tag(source: &str, nodes: &[(u32, &str)], key: &str, value: Option<&str>) -> Value {
    let nodes: Vec<Value> = nodes.iter().map(|(id, name)| node(*id, name)).collect();
    run(
        source,
        json!({ "kind": "toggleTag", "nodes": nodes, "key": key, "value": value }),
    )
}

fn remove_tag(source: &str, nodes: &[(u32, &str)], key: &str) -> Value {
    let nodes: Vec<Value> = nodes.iter().map(|(id, name)| node(*id, name)).collect();
    run(
        source,
        json!({ "kind": "removeTag", "nodes": nodes, "key": key }),
    )
}

// 包みの写し: splices を後ろから原文の行 (split('\n')) に当てて \n でつなぐ
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

fn nodes_of(source: &str) -> Vec<OutlineNode> {
    parse_document(source).nodes
}

fn node_of(source: &str, id: u32) -> OutlineNode {
    nodes_of(source)
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

fn line_of(source: &str, index: usize) -> String {
    source
        .split('\n')
        .nth(index)
        .expect("その行がある")
        .to_string()
}

// ノードの種類と名前の入力の初めの値 (inspect_node の kind と label)
fn inspected(source: &str, id: u32, ref_text: &str) -> (String, String) {
    let target: NodeTarget =
        serde_json::from_value(node(id, ref_text)).expect("NodeTarget の JSON");
    let result = inspect_node(source, &target)
        .unwrap_or_else(|| panic!("id {id} の「{ref_text}」がある: {source:?}"));
    let value = serde_json::to_value(result).expect("JSON にできる");
    (
        value["kind"].as_str().expect("kind は文字").to_string(),
        value["label"].as_str().expect("label は文字").to_string(),
    )
}

fn selected(id: u32, ref_text: &str) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [{ "id": id, "refText": ref_text }] }))
}

// 書き換えた 1 行だけの splice (行末の \n を含まず、CRLF の \r は含む)
fn assert_one_line_splice(result: &Value, line: usize, text: &str) {
    assert_eq!(result["status"], "edited", "{result}");
    assert_eq!(
        result["splices"],
        normalized(json!([{ "start": line, "deleteCount": 1, "lines": [text] }])),
        "{result}"
    );
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

// empty-name で断り、理由の文は「名前を空にできません」だけ
fn assert_empty_name(result: &Value, case: &str) {
    assert_eq!(result["status"], "refused", "{case}: {result}");
    assert_eq!(result["reason"]["code"], "empty-name", "{case}: {result}");
    assert_eq!(
        result["reason"]["message"], EMPTY_NAME_MESSAGE,
        "{case}: {result}"
    );
    assert!(result["reason"]["path"].is_null(), "{case}: {result}");
    assert!(result.get("splices").is_none(), "{case}: {result}");
}

type TagRow = (String, Vec<String>);

fn tag(key: &str, values: &[&str]) -> TagRow {
    (
        key.to_string(),
        values.iter().map(|value| (*value).to_string()).collect(),
    )
}

fn tags_of(node: &OutlineNode) -> Vec<TagRow> {
    node.tags
        .iter()
        .map(|tag| (tag.key.clone(), tag.values.clone()))
        .collect()
}

fn node_tag(key: &str, values: &[&str]) -> NodeTag {
    NodeTag {
        key: key.to_string(),
        values: values.iter().map(|value| (*value).to_string()).collect(),
        at: SourcePosition {
            line: 1,
            column: 1,
            length: 1,
        },
    }
}

// ==== 1. AM-06: 名前の逃がしを行の全体で決める ====

// records/final-gate/am06/index.html の表の 4 例: (本文の行、新しい名前、書く行、種類)
const AM06_CASES: &[(&str, &str, &str, &str)] = &[
    ("- 設計 %画面班", "[x]", r"- \[x] %画面班", "item"),
    ("## 設計 ##", "[ ]", r"## \[ ] ##", "heading"),
    ("- 設計", "--", r"- \--", "item"),
    ("* 設計", "**", r"* \**", "item"),
];

#[test]
fn edit_am06_rename_writes_symbol_names_that_merge_with_the_line_marks_escaped() {
    // 今は書いたあとの確かめで structure-changed。後は行の全体で読んで要る所に \ を置き、断らずに書く
    for (line, name, written, kind) in AM06_CASES {
        let source = format!("{MD}# R\n{line}\n");
        let result = rename(&source, 2, "設計", name);
        assert_one_line_splice(&result, 4, written);
        assert_eq!(result["select"], selected(2, name), "{line:?}");
        assert_eq!(result["rename"], Value::Null, "{line:?}");
        assert_eq!(result["notes"], json!([]), "{line:?}");
        let after = applied(&source, &result);
        // 名前は入れたとおりの文字として読まれ、タスクにならない。種類と数と親子は変わらない
        let renamed = node_of(&after, 2);
        assert_eq!(renamed.ref_text, *name, "{after:?}");
        assert_eq!(renamed.task, None, "{after:?}");
        assert_eq!(renamed.parent, Some(1), "{after:?}");
        assert_eq!(nodes_of(&after).len(), 2, "{after:?}");
        assert_eq!(inspected(&after, 2, name).0, *kind, "{after:?}");
    }
    // 後ろの印 (グループ) は残る
    let after = applied(
        &format!("{MD}# R\n- 設計 %画面班\n"),
        &rename(&format!("{MD}# R\n- 設計 %画面班\n"), 2, "設計", "[x]"),
    );
    assert_eq!(node_of(&after, 2).groups, vec!["画面班".to_string()]);
}

#[test]
fn edit_am06_rename_escapes_task_marks_before_trailing_marks() {
    // タスクの記号だけの名前 ([ ]、[x]、[X]、[/]、[-]) と後ろの印 (%、#、$) が合わさる行。後ろの印はそのまま残る
    let cases: &[(&str, &str, &str)] = &[
        ("- 設計 #k:v", "[x]", r"- \[x] #k:v"),
        ("- 設計 $d", "[ ]", r"- \[ ] $d"),
        ("- 設計 %g", "[/]", r"- \[/] %g"),
        ("- 設計 %g", "[-]", r"- \[-] %g"),
        ("- 設計 %g", "[X]", r"- \[X] %g"),
        ("- 設計 %g #k $d", "[x]", r"- \[x] %g #k $d"),
        ("## 設計 #k", "[x]", r"## \[x] #k"),
        ("1. 設計 %g", "[ ]", r"1. \[ ] %g"),
    ];
    for (line, name, written) in cases {
        let source = format!("{MD}# R\n{line}\n");
        let before = node_of(&source, 2);
        let result = rename(&source, 2, &before.ref_text, name);
        assert_one_line_splice(&result, 4, written);
        let after = applied(&source, &result);
        let renamed = node_of(&after, 2);
        assert_eq!(renamed.task, None, "{line:?}: {after:?}");
        assert_eq!(tags_of(&renamed), tags_of(&before), "{line:?}: {after:?}");
        assert_eq!(renamed.groups, before.groups, "{line:?}: {after:?}");
        assert_eq!(renamed.ref_id, before.ref_id, "{line:?}: {after:?}");
        assert_eq!(nodes_of(&after).len(), 2, "{line:?}: {after:?}");
        assert_eq!(
            inspected(&after, 2, &renamed.ref_text).1,
            *name,
            "{line:?}: {after:?}"
        );
    }
}

#[test]
fn edit_am06_rename_escapes_thematic_breaks_made_with_the_list_marker() {
    // 行頭の印と名前が合わさると区切り線に読まれる (ノードが消える)。後ろの印があっても、印を外した行は区切り線になる
    let cases: &[(&str, &str, &str)] = &[
        ("- 設計 %g", "--", r"- \-- %g"),
        ("* 設計 %g", "**", r"* \** %g"),
        ("- 設計 #k", "--", r"- \-- #k"),
        ("-   設計", "--", r"-   \--"),
    ];
    for (line, name, written) in cases {
        let source = format!("{MD}# R\n{line}\n");
        let before = node_of(&source, 2);
        let result = rename(&source, 2, "設計", name);
        assert_one_line_splice(&result, 4, written);
        let after = applied(&source, &result);
        let renamed = node_of(&after, 2);
        assert_eq!(renamed.ref_text, *name, "{after:?}");
        assert_eq!(renamed.groups, before.groups, "{after:?}");
        assert_eq!(tags_of(&renamed), tags_of(&before), "{after:?}");
        assert_eq!(nodes_of(&after).len(), 2, "{after:?}");
    }
    // 入れ子の項目
    let source = format!("{MD}# R\n- a\n    - 設計\n");
    let result = rename(&source, 3, "設計", "--");
    assert_one_line_splice(&result, 5, r"    - \--");
    let after = applied(&source, &result);
    assert_eq!(node_of(&after, 3).ref_text, "--");
    assert_eq!(node_of(&after, 3).parent, Some(2));
}

#[test]
fn edit_am06_rename_escapes_by_the_whole_line_in_crlf_and_without_markdag_key() {
    // CRLF の文書: 行末の \r を残す
    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- 設計 %画面班\r\n";
    let result = rename(source, 2, "設計", "[x]");
    assert_one_line_splice(&result, 4, "- \\[x] %画面班\r");
    let after = applied(source, &result);
    assert_eq!(node_of(&after, 2).ref_text, "[x]");
    assert_eq!(node_of(&after, 2).task, None);

    // markdag キーのない文書も同じに逃がす。あとで markdag: が足されても読み方が変わらない
    for (line, name, written) in [("- 設計", "--", r"- \--"), ("* 設計", "**", r"* \**")] {
        let source = format!("# R\n{line}\n");
        let result = rename(&source, 2, "設計", name);
        assert_one_line_splice(&result, 1, written);
        let after = applied(&source, &result);
        assert_eq!(node_of(&after, 2).ref_text, name, "{after:?}");
        let with_key = format!("{MD}{after}");
        assert_eq!(node_of(&with_key, 2).ref_text, name, "{with_key:?}");
    }
}

// 行の全体の逃がしで \ を足した行: (本文の行、id、名前)
const ESCAPED_BY_THE_WHOLE_LINE: &[(&str, u32, &str)] = &[
    (r"- \[x] %画面班", 2, "[x]"),
    (r"## \[ ] ##", 2, "[ ]"),
    (r"- \--", 2, "--"),
    (r"* \**", 2, "**"),
    (r"- \-- %g", 2, "--"),
    (r"## \[x] #k", 2, "[x]"),
];

#[test]
fn edit_am06_inspect_label_has_no_escapes_added_by_the_whole_line() {
    // 名前の入力の初めの値に、行の全体の逃がしが足した \ を出さない。その値のまま決めたら原文を変えない (same-name)
    for (line, id, name) in ESCAPED_BY_THE_WHOLE_LINE {
        let source = format!("{MD}# R\n{line}\n");
        assert_eq!(node_of(&source, *id).ref_text, *name, "{source:?}");
        assert_eq!(inspected(&source, *id, name).1, *name, "{source:?}");
        assert_reason(&rename(&source, *id, name, name), "unchanged", "same-name");
    }
    // 名前を変えて書いた行を開き直しても同じ
    for (line, name, _, _) in AM06_CASES {
        let source = format!("{MD}# R\n{line}\n");
        let after = applied(&source, &rename(&source, 2, "設計", name));
        assert_eq!(inspected(&after, 2, name).1, *name, "{after:?}");
        assert_reason(&rename(&after, 2, name, name), "unchanged", "same-name");
    }
}

#[test]
fn edit_am06_added_labels_are_escaped_by_the_whole_line() {
    // 細部 2: 足す操作の名前にも行の全体の逃がしを当てる (後ろの印はないので行頭と名前で読む)
    let source = format!("{MD}# R\n- a\n");
    let result = run(
        &source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": "--" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a\n- \\--\n"));
    assert_eq!(result["select"], selected(3, "--"));
    assert_eq!(
        result["rename"],
        normalized(json!({ "kind": "node", "node": { "id": 3, "refText": "--" } }))
    );

    let source = format!("{MD}# R\n* a\n");
    let result = run(
        &source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": "**" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n* a\n* \\**\n"));
    assert_eq!(result["select"], selected(3, "**"));

    let source = format!("{MD}# R\n- a\n    - b\n");
    let result = run(
        &source,
        json!({ "kind": "addChild", "parent": node(2, "a"), "label": "--" }),
    );
    let after = applied(&source, &result);
    assert_eq!(after, format!("{MD}# R\n- a\n    - b\n    - \\--\n"));
    assert_eq!(node_of(&after, 4).ref_text, "--");
    assert_eq!(node_of(&after, 4).parent, Some(2));

    // 新しい合流先: 最後の始点 (b) を含む最上位の枝と同じ形 (- の項目) で書く
    let source = format!("{MD}# R\n- a\n- b\n");
    let result = run(
        &source,
        json!({ "kind": "joinIntoNew", "sources": [node(2, "a"), node(3, "b")], "label": "--" }),
    );
    let after = applied(&source, &result);
    assert!(after.ends_with("# R\n- a\n- b\n- \\--\n"), "{after:?}");
    assert_eq!(node_of(&after, 4).ref_text, "--", "{after:?}");
    assert_eq!(result["select"], selected(4, "--"));
    assert_eq!(inspected(&after, 4, "--").1, "--", "{after:?}");
}

#[test]
fn edit_am06_keeps_current_escapes_and_lines_that_need_no_more_escapes() {
    // 変えない (細部 1): 今の名前だけの逃がしは全部残し、行の全体で読んでも名前のとおりに読まれる行には \ を足さない
    let cases: &[(&str, &str, &str, &str)] = &[
        ("- 設計", "設計", "[x]", "- [x]"),
        ("## 設計", "設計", "[ ]", "## [ ]"),
        ("+ 設計", "設計", "++", "+ ++"),
        ("+ 設計", "設計", "--", "+ --"),
        ("* 設計", "設計", "--", "* --"),
        ("- 設計", "設計", "__", "- __"),
        ("1. 設計", "1. 設計", "--", "1. --"),
        ("- 設計", "設計", "-", r"- \-"),
        ("- 設計", "設計", "- -", r"- \- -"),
        ("- 設計", "設計", "[x] 済み", r"- \[x] 済み"),
        ("- 設計 %g", "設計", "#todo", r"- \#todo %g"),
        ("- 設計 %g", "設計", "設計 #a", r"- 設計 \#a %g"),
        ("- [ ] 設計 %g", "設計", "[x]", "- [ ] [x] %g"),
        ("## 設計", "設計", "a ##", r"## a \##"),
    ];
    for (line, ref_text, name, written) in cases {
        let source = format!("{MD}# R\n{line}\n");
        let result = rename(&source, 2, ref_text, name);
        assert_one_line_splice(&result, 4, written);
        let after = applied(&source, &result);
        assert_eq!(nodes_of(&after).len(), 2, "{line:?} {name:?}: {after:?}");
    }
    // タスクの記号のあとの [x] は名前 (タスクの状態は今のまま)
    let source = format!("{MD}# R\n- [ ] 設計 %g\n");
    let after = applied(&source, &rename(&source, 2, "設計", "[x]"));
    let renamed = node_of(&after, 2);
    assert_eq!(renamed.ref_text, "[x]");
    assert_eq!(
        renamed.task.map(|task| task.state),
        node_of(&source, 2).task.map(|task| task.state)
    );
    // 足す操作の仮の名前も、要らない所に \ を足さない
    let source = format!("{MD}# R\n- a\n");
    let result = run(
        &source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": "[x]" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a\n- [x]\n"));
    let source = format!("{MD}# R\n");
    let result = run(
        &source,
        json!({ "kind": "addChild", "parent": node(1, "R"), "label": "[ ]" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n\n## [ ]\n"));
}

// ==== 2. B-134: タグのキーと値の書き出し ====

// 囲みが要るキーと、書く印 (値 v)。キーは文字、数字、_、- の外の字を含むか、ASCII の数字だけなら囲む
const QUOTED_KEYS: &[(&str, &str)] = &[
    ("a.b", r#"#"a.b":v"#),
    ("s.a", r#"#"s.a":v"#),
    ("a/b", r#"#"a/b":v"#),
    ("123", r#"#"123":v"#),
    ("a b", r#"#"a b":v"#),
    ("a\tb", "#\"a\tb\":v"),
    ("a\u{3000}b", "#\"a\u{3000}b\":v"),
    ("a:b", r#"#"a:b":v"#),
    ("a#b", r#"#"a#b":v"#),
    ("a%b", r#"#"a%b":v"#),
    ("a$b", r#"#"a$b":v"#),
    ("a,b", r#"#"a,b":v"#),
    ("a\"b", r#"#"a\"b":v"#),
    ("a\\b", r#"#"a\\b":v"#),
    ("#", r##"#"#":v"##),
];

#[test]
fn edit_b134_set_tag_writes_keys_that_need_quotes_in_quotes() {
    // 今は tag-key-invalid で断る。後は " で囲んで (中の " と \ を逃がして) 書き、読み直すと入れたとおりのキーになる
    let source = format!("{MD}# R\n- a %g\n");
    for (key, mark) in QUOTED_KEYS {
        // "#" は先頭の # を 1 つ外したキーなので、入れるのは "##"
        let raw = if *key == "#" {
            "##".to_string()
        } else {
            (*key).to_string()
        };
        let result = set_tag(&source, &[(2, "a")], &raw, Some("v"), None);
        assert_one_line_splice(&result, 4, &format!("- a %g {mark}"));
        assert_eq!(result["select"], selected(2, "a"), "{key:?}");
        let after = applied(&source, &result);
        let tagged = node_of(&after, 2);
        assert_eq!(
            tags_of(&tagged),
            vec![tag(key, &["v"])],
            "{key:?}: {after:?}"
        );
        assert_eq!(tagged.ref_text, "a", "{key:?}: {after:?}");
        assert_eq!(tagged.groups, vec!["g".to_string()], "{key:?}: {after:?}");
    }
}

#[test]
fn edit_b134_toggle_tag_writes_and_removes_keys_that_need_quotes() {
    let source = format!("{MD}# R\n- a\n");
    for (key, mark) in QUOTED_KEYS {
        let raw = if *key == "#" {
            "##".to_string()
        } else {
            (*key).to_string()
        };
        let result = toggle_tag(&source, &[(2, "a")], &raw, Some("v"));
        assert_one_line_splice(&result, 4, &format!("- a {mark}"));
        let after = applied(&source, &result);
        assert_eq!(
            tags_of(&node_of(&after, 2)),
            vec![tag(key, &["v"])],
            "{key:?}: {after:?}"
        );
        // もう 1 度押すと外す
        let again = toggle_tag(&after, &[(2, "a")], &raw, Some("v"));
        assert_eq!(applied(&after, &again), source, "{key:?}");
    }
}

#[test]
fn edit_b134_set_tag_quotes_keys_and_values_together_and_trims_the_key() {
    let source = format!("{MD}# R\n- a\n");
    let cases: &[(&str, Option<&str>, &str, TagRow)] = &[
        ("s.a", None, r#"#"s.a""#, tag("s.a", &[])),
        ("a b", Some("x y"), r#"#"a b":"x y""#, tag("a b", &["x y"])),
        (
            "a.b",
            Some(r#"say "hi""#),
            r#"#"a.b":"say \"hi\"""#,
            tag("a.b", &[r#"say "hi""#]),
        ),
        // 前後の空白と先頭の # を 1 つ外す
        (" #a.b ", Some("v"), r#"#"a.b":v"#, tag("a.b", &["v"])),
        ("\u{3000}s.a\u{3000}", None, r#"#"s.a""#, tag("s.a", &[])),
    ];
    for (key, value, mark, row) in cases {
        let result = set_tag(&source, &[(2, "a")], key, *value, None);
        assert_one_line_splice(&result, 4, &format!("- a {mark}"));
        let after = applied(&source, &result);
        assert_eq!(tags_of(&node_of(&after, 2)), vec![row.clone()], "{key:?}");
    }
}

#[test]
fn edit_b134_set_tag_with_quoted_keys_on_headings_several_nodes_crlf_and_without_markdag_key() {
    // 見出し
    let source = format!("{MD}# R\n## A\n");
    let result = set_tag(&source, &[(2, "A")], "s.a", Some("x y"), None);
    assert_one_line_splice(&result, 4, r#"## A #"s.a":"x y""#);
    // 2 つのノードに 1 回で
    let source = format!("{MD}# R\n- a\n- b #k\n");
    let result = set_tag(&source, &[(2, "a"), (3, "b")], "a.b", Some("v"), None);
    let after = applied(&source, &result);
    assert_eq!(
        after,
        format!("{MD}# R\n- a #\"a.b\":v\n- b #k #\"a.b\":v\n")
    );
    // CRLF の文書
    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n";
    let result = set_tag(source, &[(2, "a")], "a.b", Some("v"), None);
    assert_one_line_splice(&result, 4, "- a #\"a.b\":v\r");
    // markdag キーのない文書: markdag: を足してから書く
    let source = "# R\n- a\n";
    let result = set_tag(source, &[(2, "a")], "a.b", Some("v"), None);
    let after = applied(source, &result);
    assert_eq!(after, "---\nmarkdag:\n---\n\n# R\n- a #\"a.b\":v\n");
    assert_eq!(tags_of(&node_of(&after, 2)), vec![tag("a.b", &["v"])]);
}

#[test]
fn edit_b134_replace_key_and_remove_tag_take_quoted_keys() {
    // キーを変える編集: もとのキーも新しいキーも囲みが要るキーでよい
    let source = format!("{MD}# R\n- a #\"a.b\":v %g\n");
    let result = set_tag(&source, &[(2, "a")], "x", Some("v"), Some("a.b"));
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a #x:v %g\n"));
    let source = format!("{MD}# R\n- a #x:v %g\n");
    let result = set_tag(&source, &[(2, "a")], "a.b", Some("v"), Some("x"));
    assert_eq!(
        applied(&source, &result),
        format!("{MD}# R\n- a #\"a.b\":v %g\n")
    );
    // 変えない: removeTag は囲んだキーのタグも外す
    let source = format!("{MD}# R\n- a #\"a.b\":v %g\n");
    let result = remove_tag(&source, &[(2, "a")], "a.b");
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a %g\n"));
}

#[test]
fn edit_b134_tag_ops_refuse_only_empty_keys() {
    // 変えない: 前後の空白と先頭の # を 1 つ外して空になるキーだけは tag-key-invalid
    let source = format!("{MD}# R\n- a\n");
    for key in ["", " ", "#", " # ", "\u{3000}", "\t#\t"] {
        assert_reason(
            &set_tag(&source, &[(2, "a")], key, Some("v"), None),
            "refused",
            "tag-key-invalid",
        );
        assert_reason(
            &toggle_tag(&source, &[(2, "a")], key, Some("v")),
            "refused",
            "tag-key-invalid",
        );
    }
}

#[test]
fn edit_b134_values_with_quotes_backslashes_spaces_and_commas_are_quoted_and_escaped() {
    // 解析を直したので今も通る (前は structure-changed)。値の " と \ は囲みの中で逃がし、空白と , を含む値は囲んで今の値に足す
    let source = format!("{MD}# R\n- a\n");
    let cases: &[(&str, &str)] = &[
        (r#"say "hi""#, r#"#k:"say \"hi\"""#),
        (r"a\b", r#"#k:"a\\b""#),
        (r#"a\"b"#, r#"#k:"a\\\"b""#),
        ("\"", r#"#k:"\"""#),
        ("\\", r#"#k:"\\""#),
        ("a b,c", r#"#k:"a b,c""#),
        ("plain", "#k:plain"),
    ];
    for (value, mark) in cases {
        let result = set_tag(&source, &[(2, "a")], "k", Some(value), None);
        assert_one_line_splice(&result, 4, &format!("- a {mark}"));
        let after = applied(&source, &result);
        assert_eq!(
            tags_of(&node_of(&after, 2)),
            vec![tag("k", &[value])],
            "{value:?}"
        );
    }
    // 複数の値を持てるキー (定義がない) に足す
    let source = format!("{MD}# R\n- a #k:alice\n");
    let cases: &[(&str, &str)] = &[
        ("山田 太郎", r#"#k:alice,"山田 太郎""#),
        ("a,b", r#"#k:alice,"a,b""#),
        (r#"say "hi""#, r#"#k:alice,"say \"hi\"""#),
        (r"a\b", r#"#k:alice,"a\\b""#),
    ];
    for (value, mark) in cases {
        let result = toggle_tag(&source, &[(2, "a")], "k", Some(value));
        assert_one_line_splice(&result, 4, &format!("- a {mark}"));
        let after = applied(&source, &result);
        assert_eq!(
            tags_of(&node_of(&after, 2)),
            vec![tag("k", &["alice", value])],
            "{value:?}"
        );
        // 足した値だけを外すと、今の値に戻る
        let again = toggle_tag(&after, &[(2, "a")], "k", Some(value));
        assert_eq!(applied(&after, &again), source, "{value:?}");
    }
}

#[test]
fn edit_b134_empty_values_are_written_quoted() {
    // 空の値は "" と囲む。#k:"" を読んで書き戻しても #k:"" (今は #k: と書いて structure-changed)
    let cases: &[(&str, &str, &str, &str, TagRow)] = &[
        (r#"#k:"""#, "k", "b", r#"#k:"",b"#, tag("k", &["", "b"])),
        (r#"#k:"",b"#, "k", "b", r#"#k:"""#, tag("k", &[""])),
        (r#"#k:b,"""#, "k", "b", r#"#k:"""#, tag("k", &[""])),
        (
            r#"#k:"",b"#,
            "k",
            "c",
            r#"#k:"",b,c"#,
            tag("k", &["", "b", "c"]),
        ),
        (
            r#"#"a.b":"""#,
            "a.b",
            "b",
            r#"#"a.b":"",b"#,
            tag("a.b", &["", "b"]),
        ),
    ];
    for (mark, key, value, written, row) in cases {
        let source = format!("{MD}# R\n- a {mark}\n");
        let result = toggle_tag(&source, &[(2, "a")], key, Some(value));
        assert_one_line_splice(&result, 4, &format!("- a {written}"));
        let after = applied(&source, &result);
        assert_eq!(tags_of(&node_of(&after, 2)), vec![row.clone()], "{mark:?}");
    }
    // 変えない: setTag の空の値は値のないタグ (#k)
    let source = format!("{MD}# R\n- a\n");
    let result = set_tag(&source, &[(2, "a")], "k", Some(""), None);
    assert_one_line_splice(&result, 4, "- a #k");
}

#[test]
fn edit_b134_format_tag_quotes_empty_values() {
    assert_eq!(format_tag(&node_tag("k", &[""])), r#"#k:"""#);
    assert_eq!(format_tag(&node_tag("k", &["", "b"])), r#"#k:"",b"#);
    assert_eq!(format_tag(&node_tag("k", &["a", ""])), r#"#k:a,"""#);
    assert_eq!(format_tag(&node_tag("a.b", &[""])), r#"#"a.b":"""#);
    // 変えない: 値のないタグは #キー
    assert_eq!(format_tag(&node_tag("k", &[])), "#k");
    // 書き出した形を項目の 1 行目に書いて読み直すと、同じキーと値
    for values in [vec![""], vec!["", "b"], vec!["a", ""], vec!["", ""]] {
        let mark = format_tag(&node_tag("k", &values));
        let source = format!("{MD}# R\n- a {mark}\n");
        let read = node_of(&source, 2);
        assert_eq!(tags_of(&read), vec![tag("k", &values)], "{mark}");
        assert_eq!(read.ref_text, "a", "{mark}");
    }
}

// ==== 3. empty-name: どのノードも名前を空にできない ====

// (原文、id、refText、場合の名前)
fn nodes_with_names() -> Vec<(String, u32, &'static str, &'static str)> {
    vec![
        (
            "# R\n- a\n- b\n".to_string(),
            3,
            "b",
            "印もタスクの記号もない項目",
        ),
        (
            format!("{MD}# R\n- a\n- b\n"),
            3,
            "b",
            "markdag キーのある文書の項目",
        ),
        (
            "# R\n- a #k\n- b\n".to_string(),
            2,
            "a #k",
            "markdag キーのない文書の末尾の #k",
        ),
        (format!("{MD}# R\n- [ ] a\n- b\n"), 2, "a", "タスクの項目"),
        (format!("{MD}# R\n- a #k\n- b\n"), 2, "a", "タグのある項目"),
        (
            format!("{MD}# R\n- a %g\n- b\n"),
            2,
            "a",
            "グループの印のある項目",
        ),
        (format!("{MD}# R\n- a $id\n- b\n"), 2, "a", "$id のある項目"),
        (
            format!("{MD}# R\n- A\n\n    - x\n- B\n"),
            2,
            "A",
            "1 行目のすぐ次が空行で続きのある項目",
        ),
        (
            format!("{MD}# R\n\n前置きの段落\n- a\n    - c\n"),
            2,
            "a",
            "段落の直後の項目",
        ),
        (
            "# R\n## a\n- x\n- y\n".to_string(),
            2,
            "a",
            "子のある見出し",
        ),
        (
            "# R\n## a\n- x\n- y\n".to_string(),
            4,
            "y",
            "見出しの下の項目",
        ),
        (format!("{MD}# R\n## a\n"), 2, "a", "子のない見出し"),
        (format!("{MD}# R\n- a\n"), 1, "R", "ルートの見出し"),
        (
            format!("{MD}# R\n\n設計\n---\n- a\n"),
            2,
            "設計",
            "下線の見出し",
        ),
        (format!("{MD}# R\n## [ ] a\n"), 2, "a", "タスクの見出し"),
        (
            format!("{MD}# R\n1. a\n2. b\n"),
            2,
            "1. a",
            "番号付きの項目",
        ),
        (
            format!("{MD}# R\n- [ ]\n- b\n"),
            2,
            "[ ]",
            "名前が [ ] の項目",
        ),
        (
            "- a\n- b\n".to_string(),
            2,
            "a",
            "リストだけの文書の最初の項目",
        ),
        (
            "# R\r\n- a\r\n- b\r\n".to_string(),
            3,
            "b",
            "CRLF の文書の項目",
        ),
    ]
}

#[test]
fn edit_empty_name_refuses_every_node_kind_with_one_message() {
    // 空の名前 (空白と改行だけも) は、ノードの種類、タスクの記号、末尾の印によらず empty-name。文は 1 つ
    for (source, id, ref_text, case) in nodes_with_names() {
        assert_eq!(node_of(&source, id).ref_text, ref_text, "{case}");
        for label in ["", "   ", "\r\n", "\u{3000}", " \n "] {
            assert_empty_name(
                &rename(&source, id, ref_text, label),
                &format!("{case} ({label:?})"),
            );
        }
    }
}

#[test]
fn edit_empty_name_same_name_comes_first_for_nodes_already_without_a_name() {
    // 変えない (細部 26): 今の名前が空のノードを空のまま決めたら、空の判定より先に same-name (原文を変えず、断らない)
    let cases: Vec<(String, u32)> = vec![
        ("# R\n-\n- b\n".to_string(), 2),
        (format!("{MD}# R\n-\n- b\n"), 2),
        (format!("{MD}# R\n- %g\n- b\n"), 2),
        (format!("{MD}# R\n- $n1\n- b\n"), 2),
    ];
    for (source, id) in cases {
        assert_eq!(node_of(&source, id).ref_text, "", "{source:?}");
        for label in ["", "  ", "\r\n"] {
            assert_reason(&rename(&source, id, "", label), "unchanged", "same-name");
        }
    }
}

#[test]
fn edit_empty_name_add_ops_with_an_empty_label_are_not_refused() {
    // 変えない (細部 25): 足す操作の空の名前は断らず、今のまま空の本文を書く (断るのは名前の変更だけ)
    let source = format!("{MD}# R\n- a\n");
    let result = run(
        &source,
        json!({ "kind": "addSibling", "node": node(2, "a"), "label": "" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a\n-\n"));
    assert_eq!(result["select"], selected(3, ""));

    let result = run(
        &source,
        json!({ "kind": "addChild", "parent": node(1, "R"), "label": "" }),
    );
    assert_eq!(applied(&source, &result), format!("{MD}# R\n- a\n-\n"));

    let source = format!("{MD}# R\n## a\n## b\n");
    let result = run(
        &source,
        json!({ "kind": "joinIntoNew", "sources": [node(2, "a"), node(3, "b")], "label": "" }),
    );
    assert_eq!(result["status"], "edited", "{result}");
    let after = applied(&source, &result);
    assert_eq!(node_of(&after, 4).ref_text, "", "{after:?}");
    assert_eq!(line_of(&after, after.split('\n').count() - 2), "## $n1");
}

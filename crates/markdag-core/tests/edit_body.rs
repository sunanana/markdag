// GUI 編集の本文の書き換えのテスト: 書き換えの土台と名前の変更、子と兄弟の追加、ノードの削除と付け替えの本文の部分、
// 詳細とタグの書き換え、ノードの問い合わせ (inspect_node)、名前の入力の初めの値 (名前の変更で markdag が足す \ を出さない)。
// 公開の markdag_core::edit (edit_source、inspect_node) と markdag_core::types の型の名前だけを使う。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして比べる (包みとの契約は JSON の形なので、
// Rust の欄の形 (列挙の名前、数の型) によらずに確かめる)。関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める。
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::{body_diagnostics, parse_document};
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

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

fn rename(source: &str, id: u32, ref_text: &str, label: &str) -> Value {
    let op = op(json!({
        "kind": "renameNode",
        "node": { "id": id, "refText": ref_text },
        "label": label,
    }));
    normalized(
        serde_json::to_value(edit_source(source, &op)).expect("EditSourceResult は JSON にできる"),
    )
}

fn inspect(source: &str, id: u32, ref_text: &str) -> Option<Value> {
    inspect_node(source, &target(id, ref_text)).map(|result| {
        normalized(serde_json::to_value(result).expect("InspectNodeResult は JSON にできる"))
    })
}

// TS の包み (editSource) の写し: splices を後ろから原文の行 (split('\n')) に当てて join('\n') する
fn applied(source: &str, result: &Value) -> String {
    assert_eq!(result["status"], "edited", "書き換えるはず: {result}");
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

fn renamed(source: &str, id: u32, ref_text: &str, label: &str) -> String {
    applied(source, &rename(source, id, ref_text, label))
}

fn node_of(source: &str, id: u32) -> OutlineNode {
    parse_document(source)
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

fn ref_texts(source: &str) -> Vec<(u32, Option<u32>, String)> {
    parse_document(source)
        .nodes
        .into_iter()
        .map(|node| (node.id, node.parent, node.ref_text))
        .collect()
}

fn first_line_blocks(source: &str) -> Vec<String> {
    body_diagnostics(source)
        .into_iter()
        .filter(|diagnostic| diagnostic.code == "block-on-first-line")
        .map(|diagnostic| diagnostic.message)
        .collect()
}

fn line_of(source: &str, index: usize) -> String {
    source
        .split('\n')
        .nth(index)
        .expect("その行がある")
        .to_string()
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
    // 本文の操作は frontmatter の道すじを持たない
    assert!(result["reason"]["path"].is_null(), "{result}");
}

fn assert_refused(result: &Value, code: &str) {
    assert_reason(result, "refused", code);
}

fn assert_unchanged(result: &Value, code: &str) {
    assert_reason(result, "unchanged", code);
}

// 書き換えた 1 行だけの splice (行末の \n を含まず、CRLF の \r は含む)
fn assert_one_line_splice(result: &Value, line: usize, text: &str) {
    assert_eq!(
        result["splices"],
        normalized(json!([{ "start": line, "deleteCount": 1, "lines": [text] }])),
        "{result}"
    );
}

fn selected(id: u32, ref_text: &str) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [{ "id": id, "refText": ref_text }] }))
}

// select のノードが、書き換えたあとの原文を解析し直した同じ id のノードの refText と一致する
fn assert_select_matches_reparse(source: &str, result: &Value) {
    let after = applied(source, result);
    let nodes = result["select"]["nodes"]
        .as_array()
        .expect("select は nodes");
    assert!(!nodes.is_empty(), "{result}");
    for chosen in nodes {
        let id = chosen["id"].as_f64().expect("id は数") as u32;
        assert_eq!(
            chosen["refText"].as_str(),
            Some(node_of(&after, id).ref_text.as_str()),
            "{result}"
        );
    }
}

// can* の並び: canRename、canDelete、canMove、canHaveDetails、canAddChild、canAddSibling、canMark
type Can = [bool; 7];
const ITEM: Can = [true; 7];
// 見出しも詳細を持てる (最後の関門 原文の都合で断る 6。D-038)
const HEADING: Can = [true, true, true, true, true, true, true];
const ROOT_HEADING: Can = [true, false, false, true, true, true, true];
// 下線の見出しと行頭に空白のある ATX の見出しは、印を書く前に ATX の見出しに書き直すので印を書ける (最後の関門 原文の都合で断る 1。D-038)
const UNMARKABLE_HEADING: Can = [true, true, true, true, true, true, true];
const CONTAINER: Can = [false, true, false, false, true, false, false];
const BLOCK: Can = [false, true, true, false, false, false, false];
const LINELESS_ROOT: Can = [false, false, false, false, true, true, false];

fn inspected(
    id: u32,
    kind: &str,
    label: &str,
    details: Option<&str>,
    task: bool,
    can: Can,
) -> Value {
    let [rename, delete, move_, details_ok, child, sibling, mark] = can;
    normalized(json!({
        "id": id,
        "kind": kind,
        "label": label,
        "details": details,
        "task": task,
        "canRename": rename,
        "canDelete": delete,
        "canMove": move_,
        "canHaveDetails": details_ok,
        "canAddChild": child,
        "canAddSibling": sibling,
        "canMark": mark,
    }))
}

// ---- 文書 ----

const MD: &str = "---\nmarkdag:\n---\n";

// 1 R / 2 h (タスクの見出し、印つき) / 3 印と詳細と子のあるタスクの項目 (refText は「太字 と code」) / 4 c
const MARKED: &str = "---\nmarkdag:\n---\n# R\n\n## [x] h #k %g $hid\n- [ ] **太字** と `code` #k:v %g $id\n    > 1 行目\n    >\n    > **3** 行目\n    - c\n";
// 見出しの下に種類の違うリストが 2 つ (edge-nested-lists の形)。2 は ul、5 は ol の容器 (refText は空) で、
// 容器の lines.start は最初の項目 (3 a、6「1. c」) の行と同じ
const NESTED_LISTS: &str = "# R\n\n- a\n- b\n\n1. c\n2. d\n";
// 1 R / 2 表 / 3 コード / 4 画像
const BLOCKS: &str = "---\nmarkdag:\n---\n# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n";
// 見出しがなく最上位のブロックが 2 つ: ルート (refText は title) は lines が null
const LINELESS: &str = "---\ntitle: T\nmarkdag:\n---\n- a\n\n1. b\n";
// リストだけの文書: ルートは ul の容器で、lines.start は最初の項目の行と同じ
const LIST_ROOT_TITLED: &str = "---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n";
const LIST_ROOT: &str = "- a\n- b\n";
// 1 R / 2 下線の見出し「設計」/ 3 画面 / 4 行頭に空白のある ATX の見出し「実装」
const UNMARKABLE: &str = "---\nmarkdag:\n---\n# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n";

// ---- inspectNode ----

#[test]
fn edit_inspect_node_tells_headings_and_items() {
    assert_eq!(
        inspect(MARKED, 1, "R"),
        Some(inspected(1, "heading", "R", None, false, ROOT_HEADING))
    );
    assert_eq!(
        inspect(MARKED, 2, "h"),
        Some(inspected(2, "heading", "h", None, true, HEADING))
    );
    // label は行頭の記号、タスクの記号、末尾の印を除いた原文 (Markdown の記法はそのまま)。details は > と続く空白 1 つを外して \n でつなぐ
    assert_eq!(
        inspect(MARKED, 3, "太字 と code"),
        Some(inspected(
            3,
            "item",
            "**太字** と `code`",
            Some("1 行目\n\n**3** 行目"),
            true,
            ITEM
        ))
    );
    assert_eq!(
        inspect(MARKED, 4, "c"),
        Some(inspected(4, "item", "c", None, false, ITEM))
    );
}

#[test]
fn edit_inspect_node_tells_containers_and_blocks() {
    // 容器は名前、詳細、印、兄弟、付け替えを持たない。子を足すことと消すことはできる
    for (id, first_item) in [(2, (3, "a")), (5, (6, "1. c"))] {
        assert_eq!(
            inspect(NESTED_LISTS, id, ""),
            Some(inspected(id, "list", "", None, false, CONTAINER)),
            "容器 {id}"
        );
        // 同じ 1 行目の最初の項目は容器でなく項目
        let (item_id, item_ref) = first_item;
        assert_eq!(
            inspect(NESTED_LISTS, item_id, item_ref).map(|r| r["kind"].clone()),
            Some(json!("item"))
        );
    }
    for id in [2, 3, 4] {
        assert_eq!(
            inspect(BLOCKS, id, ""),
            Some(inspected(id, "block", "", None, false, BLOCK)),
            "表とコードと画像 {id}"
        );
    }
}

#[test]
fn edit_inspect_node_tells_roots_without_a_line_and_list_roots() {
    assert_eq!(
        inspect(LINELESS, 1, "T"),
        Some(inspected(1, "root", "", None, false, LINELESS_ROOT))
    );
    // リストだけの文書のルートは容器。ルートなので消せず動かせない。兄弟 (canAddSibling) はここでは見ない
    for (source, ref_text) in [(LIST_ROOT_TITLED, "手順"), (LIST_ROOT, "")] {
        let result = inspect(source, 1, ref_text).expect("ルートがある");
        let expected = inspected(
            1,
            "list",
            "",
            None,
            false,
            [false, false, false, false, true, false, false],
        );
        for key in [
            "id",
            "kind",
            "label",
            "details",
            "task",
            "canRename",
            "canDelete",
            "canMove",
            "canHaveDetails",
            "canAddChild",
            "canMark",
        ] {
            assert_eq!(result[key], expected[key], "{source:?} の {key}");
        }
    }
}

#[test]
fn edit_inspect_node_setext_and_indented_headings_can_mark() {
    assert_eq!(
        inspect(UNMARKABLE, 1, "R"),
        Some(inspected(1, "heading", "R", None, false, ROOT_HEADING))
    );
    assert_eq!(
        inspect(UNMARKABLE, 2, "設計"),
        Some(inspected(
            2,
            "heading",
            "設計",
            None,
            false,
            UNMARKABLE_HEADING
        ))
    );
    assert_eq!(
        inspect(UNMARKABLE, 3, "画面"),
        Some(inspected(3, "item", "画面", None, false, ITEM))
    );
    assert_eq!(
        inspect(UNMARKABLE, 4, "実装"),
        Some(inspected(
            4,
            "heading",
            "実装",
            None,
            false,
            UNMARKABLE_HEADING
        ))
    );
}

#[test]
fn edit_inspect_node_label_keeps_trailing_marks_without_markdag_key() {
    // markdag キーのない文書は印を読まないので、末尾の #… も label に入る
    let source = "# R\n- Issue #123 fix #urgent\n- [ ] a #k\n";
    assert_eq!(
        inspect(source, 2, "Issue #123 fix #urgent"),
        Some(inspected(
            2,
            "item",
            "Issue #123 fix #urgent",
            None,
            false,
            ITEM
        ))
    );
    assert_eq!(
        inspect(source, 3, "a #k"),
        Some(inspected(3, "item", "a #k", None, true, ITEM))
    );
    // 対照: markdag キーのある文書では #urgent はタグ (数字だけの #123 は名前に残る)
    let source = format!("{MD}# R\n- Issue #123 fix #urgent\n");
    assert_eq!(
        inspect(&source, 2, "Issue #123 fix"),
        Some(inspected(2, "item", "Issue #123 fix", None, false, ITEM))
    );
}

#[test]
fn edit_inspect_node_is_none_for_missing_id_or_other_ref_text() {
    assert_eq!(inspect(NESTED_LISTS, 99, "a"), None);
    assert_eq!(inspect(NESTED_LISTS, 0, ""), None);
    assert_eq!(inspect(NESTED_LISTS, 3, "b"), None);
    // label (Markdown の記法) は refText ではない
    assert_eq!(inspect(MARKED, 3, "**太字** と `code`"), None);
}

// ---- 名前の変更 ----

#[test]
fn edit_rename_rewrites_only_the_body_and_keeps_marks() {
    let source = format!("{MD}# R #top\n## [x] h #k %g $hid\n- [ ] a #k:v %g $id\n\t- [/] b #k\n");
    let cases = [
        (1, "R", "S", 3, "# S #top"),
        (2, "h", "y", 4, "## [x] y #k %g $hid"),
        (3, "a", "x", 5, "- [ ] x #k:v %g $id"),
        (4, "b", "z", 6, "\t- [/] z #k"),
    ];
    for (id, ref_text, label, line, text) in cases {
        let result = rename(&source, id, ref_text, label);
        assert_one_line_splice(&result, line, text);
        let after = applied(&source, &result);
        let mut lines: Vec<&str> = source.split('\n').collect();
        lines[line] = text;
        assert_eq!(after, lines.join("\n"));
        let node = node_of(&after, id);
        assert_eq!(node.ref_text, label);
        // 印はそのノードに残る
        assert_eq!(node.tags, node_of(&source, id).tags);
        assert_eq!(node.groups, node_of(&source, id).groups);
        assert_eq!(node.ref_id, node_of(&source, id).ref_id);
        assert_eq!(node.task.is_some(), node_of(&source, id).task.is_some());
    }
    // 番号付きの項目は頭の番号とタスクの記号を残す
    let source = format!("{MD}# R\n- a\n    1. [-] b #k\n");
    let result = rename(&source, 3, &node_of(&source, 3).ref_text, "z");
    assert_one_line_splice(&result, 5, "    1. [-] z #k");
    // markdag キーのない文書では末尾の #… も本文なので置き換わる
    assert_eq!(renamed("# R\n- a #k %g\n", 2, "a #k %g", "x"), "# R\n- x\n");
}

#[test]
fn edit_rename_keeps_crlf_and_touches_no_other_line() {
    let source = "# R\r\n- a\r\n- b\r\n";
    let result = rename(source, 2, "a", "x");
    assert_one_line_splice(&result, 1, "- x\r");
    assert_eq!(applied(source, &result), "# R\r\n- x\r\n- b\r\n");

    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- [ ] a #k\r\n- b\r\n";
    let result = rename(source, 2, "a", "x");
    assert_one_line_splice(&result, 4, "- [ ] x #k\r");
    assert_eq!(
        applied(source, &result),
        "---\r\nmarkdag:\r\n---\r\n# R\r\n- [ ] x #k\r\n- b\r\n"
    );

    // 改行で終わらない文書の最後の行には \r がない
    let source = "# R\r\n- a";
    let result = rename(source, 2, "a", "x");
    assert_one_line_splice(&result, 1, "- x");
    assert_eq!(applied(source, &result), "# R\r\n- x");
}

#[test]
fn edit_rename_turns_line_breaks_into_spaces_and_trims() {
    let source = "# R\n- a\n";
    // \r\n、\r、\n、U+2028、U+2029 はどれも空白 1 つ
    assert_eq!(
        renamed(source, 2, "a", "x\r\ny\rz\nw\u{2028}v\u{2029}u"),
        "# R\n- x y z w v u\n"
    );
    assert_eq!(renamed(source, 2, "a", "  x \n"), "# R\n- x\n");
    assert_eq!(renamed(source, 2, "a", "\r\nx y\r\n"), "# R\n- x y\n");
    // CRLF の文書でも入力の改行は空白になり、行末の \r だけが残る
    let source = "# R\r\n- a\r\n";
    let result = rename(source, 2, "a", "x\r\ny");
    assert_one_line_splice(&result, 1, "- x y\r");
}

#[test]
fn edit_rename_same_name_is_unchanged() {
    assert_unchanged(&rename("# R\n- a\n", 2, "a", "a"), "same-name");
    assert_unchanged(&rename("# R\n- a\n", 2, "a", " a\n"), "same-name");
    let source = format!("{MD}# R\n- [ ] a #k\n");
    assert_unchanged(&rename(&source, 2, "a", "a"), "same-name");
    // 逃がしたあとの本文が今の本文と同じ
    assert_unchanged(
        &rename("# R\n- 1\\. 準備\n", 2, "1. 準備", "1. 準備"),
        "same-name",
    );
}

// 名前と、項目の 1 行目に書く逃がしたあとの本文
const ITEM_ESCAPES: &[(&str, &str)] = &[
    ("#todo", r"\#todo"),
    ("Issue #frontend", r"Issue \#frontend"),
    ("%g", r"\%g"),
    ("$id", r"\$id"),
    ("a #x #y", r"a #x \#y"),
    ("# x", r"\# x"),
    ("> x", r"\> x"),
    ("- x", r"\- x"),
    ("* x", r"\* x"),
    ("+ x", r"\+ x"),
    ("1. x", r"1\. x"),
    ("1) x", r"1\) x"),
    ("---", r"\---"),
    ("***", r"\***"),
    ("```js", r"\```js"),
    ("~~~", r"\~~~"),
    ("<div>", r"\<div>"),
    ("<!-- c -->", r"\<!-- c -->"),
    ("[ ] x", r"\[ ] x"),
    ("[x] x", r"\[x] x"),
    ("[X] x", r"\[X] x"),
    ("[/] x", r"\[/] x"),
    ("[-] x", r"\[-] x"),
];

fn assert_plain_name(source: &str, id: u32, label: &str) {
    let node = node_of(source, id);
    assert_eq!(node.ref_text, label, "{source:?}");
    assert!(
        node.tags.is_empty(),
        "{label:?} がタグにならない: {source:?}"
    );
    assert!(
        node.groups.is_empty(),
        "{label:?} がグループにならない: {source:?}"
    );
    assert_eq!(node.ref_id, None, "{label:?} が $id にならない: {source:?}");
    assert_eq!(node.task, None, "{label:?} がタスクにならない: {source:?}");
}

#[test]
fn edit_rename_escapes_marks_and_block_starts_in_items() {
    // markdag キーのある文書
    let source = format!("{MD}# R\n- a\n- b\n");
    for (label, body) in ITEM_ESCAPES {
        let result = rename(&source, 2, "a", label);
        assert_one_line_splice(&result, 4, &format!("- {body}"));
        let after = applied(&source, &result);
        assert_plain_name(&after, 2, label);
        assert_eq!(ref_texts(&after).len(), 3, "{label:?}: {after:?}");
        assert_eq!(node_of(&after, 3).ref_text, "b");
        assert!(first_line_blocks(&after).is_empty(), "{label:?}: {after:?}");
        assert_eq!(result["select"], selected(2, label));
    }
    // markdag キーのない文書でも同じに逃がす。あとで markdag: が足されても読み方が変わらない
    let source = "# R\n- a\n- b\n";
    for (label, body) in ITEM_ESCAPES {
        let result = rename(source, 2, "a", label);
        assert_one_line_splice(&result, 1, &format!("- {body}"));
        let after = applied(source, &result);
        assert_plain_name(&after, 2, label);
        assert_eq!(ref_texts(&after).len(), 3, "{label:?}: {after:?}");
        let with_key = format!("{MD}{after}");
        assert_plain_name(&with_key, 2, label);
        assert!(
            first_line_blocks(&with_key).is_empty(),
            "{label:?}: {with_key:?}"
        );
    }
}

#[test]
fn edit_rename_escapes_heading_names() {
    // 見出しの閉じの記号 (末尾の空白と # の並び) は並びの最初の # の前に \ を置く
    let cases: &[(&str, &str)] = &[
        ("Issue #", r"Issue \#"),
        ("a ##", r"a \##"),
        ("#todo", r"\#todo"),
        ("Issue #frontend", r"Issue \#frontend"),
        ("# x", r"\# x"),
        ("1. x", r"1\. x"),
        ("- x", r"\- x"),
    ];
    for prefix in [MD, ""] {
        let source = format!("{prefix}# R\n## h\n");
        let line = prefix.matches('\n').count() + 1;
        for (label, body) in cases {
            let result = rename(&source, 2, "h", label);
            assert_one_line_splice(&result, line, &format!("## {body}"));
            let after = applied(&source, &result);
            assert_plain_name(&after, 2, label);
            assert!(first_line_blocks(&after).is_empty(), "{label:?}: {after:?}");
        }
        // ルートの見出しも同じ
        let result = rename(&source, 1, "R", "Issue #");
        assert_one_line_splice(&result, line - 1, r"# Issue \#");
        assert_plain_name(&applied(&source, &result), 1, "Issue #");
    }
}

#[test]
fn edit_rename_does_not_escape_number_only_tags() {
    for prefix in [MD, ""] {
        let source = format!("{prefix}# R\n- a\n");
        let line = prefix.matches('\n').count() + 1;
        for label in ["Issue #12", "#12"] {
            let result = rename(&source, 2, "a", label);
            assert_one_line_splice(&result, line, &format!("- {label}"));
            assert_plain_name(&applied(&source, &result), 2, label);
        }
    }
}

#[test]
fn edit_rename_to_an_empty_name_is_empty_name_even_without_marks() {
    // どのノードも名前を空にできない (D-028): 印もタスクの記号もないノードも empty-name で断り、原文を変えない
    let source = "# R\n- a\n- b\n";
    for label in ["", "   ", "\r\n"] {
        assert_refused(&rename(source, 3, "b", label), "empty-name");
    }
    // markdag キーのない文書の末尾の #… (印でなく本文) だけの名前も同じ
    assert_refused(&rename("# R\n- a #k\n- b\n", 2, "a #k", ""), "empty-name");
}

#[test]
fn edit_rename_to_an_empty_name_refuses_marked_lines_and_loose_items() {
    let refused = [
        format!("{MD}# R\n- [ ] a\n- b\n"),
        format!("{MD}# R\n- a #k\n- b\n"),
        format!("{MD}# R\n- a %g\n- b\n"),
        format!("{MD}# R\n- a $id\n- b\n"),
        "# R\n- [ ] a\n- b\n".to_string(),
    ];
    for source in &refused {
        assert_refused(&rename(source, 2, "a", ""), "empty-name");
    }
    // 1 行目のすぐ次が空行で、そのあとに続き (子、詳細、段落) がある項目
    for rest in ["    - x", "    > d", "    続き"] {
        let source = format!("{MD}# R\n- A\n\n{rest}\n- B\n");
        assert_refused(&rename(&source, 2, "A", ""), "empty-name");
        assert_refused(&rename(&source, 2, "A", " \n "), "empty-name");
    }
}

#[test]
fn edit_rename_to_an_empty_name_after_a_paragraph_is_empty_name() {
    // 段落の直後の項目も、ほかのノードと同じく empty-name で断る (D-028。前は書いたあとの確かめで structure-changed)
    let source = format!("{MD}# R\n\n前置きの段落\n- a\n    - c\n");
    assert_eq!(node_of(&source, 2).ref_text, "a");
    assert_refused(&rename(&source, 2, "a", ""), "empty-name");
}

#[test]
fn edit_rename_refuses_nodes_without_a_name_line() {
    assert_refused(&rename(LINELESS, 1, "T", "x"), "no-source-line");
    assert_refused(&rename(LIST_ROOT_TITLED, 1, "手順", "x"), "no-source-line");
    assert_refused(&rename(LIST_ROOT, 1, "", "x"), "no-source-line");
    for id in [2, 5] {
        assert_refused(&rename(NESTED_LISTS, id, "", "x"), "no-source-line");
    }
    for id in [2, 3, 4] {
        assert_refused(&rename(BLOCKS, id, "", "x"), "block-node");
    }
}

#[test]
fn edit_rename_refuses_stale_targets() {
    assert_refused(&rename(NESTED_LISTS, 3, "b", "x"), "stale-node");
    assert_refused(&rename(NESTED_LISTS, 99, "a", "x"), "stale-node");
    assert_refused(&rename(NESTED_LISTS, 0, "", "x"), "stale-node");
    assert_refused(&rename(MARKED, 3, "**太字** と `code`", "x"), "stale-node");
}

#[test]
fn edit_rename_rewrites_lone_carriage_returns_as_the_document_line_break() {
    // 単独の \r は comrak と split('\n') で行の数え方が食い違うので、文書の最初の改行にそろえてから書き換える (D-061)
    for (source, expected) in [
        ("# R\n- a\r- b\n", "# R\n- x\n- b\n"),
        ("# R\r\n- a\r- b\r\n", "# R\r\n- x\r\n- b\r\n"),
    ] {
        assert_eq!(node_of(source, 2).ref_text, "a");
        let result = rename(source, 2, "a", "x");
        assert_eq!(applied(source, &result), expected, "{result}");
        assert_eq!(result["select"], selected(2, "x"), "{result}");
        assert_select_matches_reparse(source, &result);
    }
}

#[test]
fn edit_rename_selects_the_renamed_node_in_the_rewritten_source() {
    // 容器と同じ行から始まる最初の項目: 容器でなく項目を選ぶ
    let result = rename(NESTED_LISTS, 3, "a", "x");
    assert_eq!(result["select"], selected(3, "x"));
    assert_eq!(result["rename"], Value::Null);
    assert_eq!(result["notes"], json!([]));
    assert_select_matches_reparse(NESTED_LISTS, &result);
    let after = applied(NESTED_LISTS, &result);
    assert_eq!(
        node_of(&after, 2).lines.map(|lines| lines.start),
        node_of(&after, 3).lines.map(|lines| lines.start)
    );

    // リストだけの文書: ルート (容器) と最初の項目が同じ行
    let result = rename(LIST_ROOT, 2, "a", "x");
    assert_eq!(result["select"], selected(2, "x"));
    assert_select_matches_reparse(LIST_ROOT, &result);

    // 番号付きの項目の refText は頭の番号を含むので、入れた名前でなく解析し直した値を返す
    let source = "# R\n1. a\n2. b\n";
    let result = rename(source, 3, "2. b", "x");
    assert_eq!(result["select"], selected(3, "2. x"));
    assert_select_matches_reparse(source, &result);

    let source = format!("{MD}# R\n- a\n- b\n");
    let result = rename(&source, 2, "a", "#todo");
    assert_eq!(result["select"], selected(2, "#todo"));
    assert_select_matches_reparse(&source, &result);
}

// ---- JSON の形 ----

#[test]
fn edit_op_json_rejects_unknown_kind_and_wrong_field_types() {
    // 封筒の error (invalid-input) になるのは入力の JSON が読めないときだけ。読めない形は serde が受け付けない
    let ok = json!({ "kind": "renameNode", "node": { "id": 2, "refText": "a" }, "label": "x" });
    assert!(serde_json::from_value::<EditOp>(ok).is_ok());
    for bad in [
        json!({ "kind": "nope" }),
        json!({ "kind": "nope", "node": { "id": 2, "refText": "a" }, "label": "x" }),
        json!({ "kind": "renameNode", "node": { "id": 2, "refText": "a" }, "label": 1 }),
        json!({ "kind": "renameNode", "node": { "id": 2 }, "label": "x" }),
        json!({ "kind": "renameNode", "node": { "id": "2", "refText": "a" }, "label": "x" }),
        json!({ "node": { "id": 2, "refText": "a" }, "label": "x" }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    assert!(serde_json::from_value::<NodeTarget>(json!({ "id": 2 })).is_err());
}

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .expect("オブジェクト")
        .keys()
        .cloned()
        .collect();
    keys.sort();
    keys
}

#[test]
fn edit_source_result_json_has_the_contract_fields() {
    let edited = rename("# R\n- a\n", 2, "a", "x");
    assert_eq!(
        keys(&edited),
        ["notes", "rename", "select", "splices", "status"]
    );
    assert_eq!(
        keys(&edited["splices"][0]),
        ["deleteCount", "lines", "start"]
    );
    assert_eq!(keys(&edited["select"]), ["kind", "nodes"]);
    assert_eq!(keys(&edited["select"]["nodes"][0]), ["id", "refText"]);

    let unchanged = rename("# R\n- a\n", 2, "a", "a");
    assert_eq!(keys(&unchanged), ["reason", "status"]);
    assert_eq!(keys(&unchanged["reason"]), ["code", "message", "path"]);

    let refused = rename("# R\n- a\n", 2, "b", "x");
    assert_eq!(keys(&refused), ["reason", "status"]);
    assert_eq!(keys(&refused["reason"]), ["code", "message", "path"]);

    let inspected = inspect("# R\n- a\n", 2, "a").expect("ノードがある");
    assert_eq!(
        keys(&inspected),
        [
            "canAddChild",
            "canAddSibling",
            "canDelete",
            "canHaveDetails",
            "canMark",
            "canMove",
            "canRename",
            "details",
            "id",
            "kind",
            "label",
            "task"
        ]
    );
}

// ---- 子と兄弟の追加 (addChild と addSibling。子の形、位置、兄弟、字下げ、空行) ----

// 足したノードの仮の名前。呼び出し側が label で渡す
const NEW: &str = "新しいノード";

// 見出しのない文書で最上位のリストが 2 つ (どちらも項目が 2 つ)。ルート「T」は lines が null で、子は ul (2) と ol (5) の容器
const LINELESS_LISTS: &str = "---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n";
// 1 Root / 2 設計 / 3 画面。Root と設計は下線の見出し
const SETEXT: &str = "---\nmarkdag:\n---\nRoot\n====\n\n設計\n----\n- 画面\n";
// 項目の字下げがタブの文書。ルートは lines が null (1)、2 x / 3 y / 4「100. a」
const TABBED: &str = "---\nmarkdag:\n---\n- x\n\t- y\n100. a\n";
// 1 R / 2 a。a の中のフェンスは閉じているので、次の「本文」は a の続きでなく R の下の段落
const FENCED_ITEM: &str = "# R\n- a\n\n  ~~~\n  x\n  ~~~\n本文\n";

fn edited_by(source: &str, value: Value) -> Value {
    normalized(
        serde_json::to_value(edit_source(source, &op(value)))
            .expect("EditSourceResult は JSON にできる"),
    )
}

fn add_child(source: &str, id: u32, ref_text: &str, label: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "addChild", "parent": { "id": id, "refText": ref_text }, "label": label }),
    )
}

fn add_sibling(source: &str, id: u32, ref_text: &str, label: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "addSibling", "node": { "id": id, "refText": ref_text }, "label": label }),
    )
}

// 足した結果: 原文の全体、select と rename が足したノード、notes が空、
// 足したノードの親。select は書き換えたあとの原文を解析し直した id と refText
fn assert_added(source: &str, result: &Value, expected: &str, added: (u32, &str), parent: u32) {
    let after = applied(source, result);
    assert_eq!(after, expected, "{source:?}: {result}");
    let (id, ref_text) = added;
    assert_eq!(result["select"], selected(id, ref_text), "{result}");
    assert_eq!(
        result["rename"],
        normalized(json!({ "kind": "node", "node": { "id": id, "refText": ref_text } })),
        "{result}"
    );
    assert_eq!(result["notes"], json!([]), "{result}");
    assert_select_matches_reparse(source, result);
    assert_eq!(node_of(&after, id).parent, Some(parent), "{after:?}");
}

#[test]
fn edit_add_child_of_a_heading_without_children_is_a_heading_one_level_down() {
    // 見出しの子は 1 段下の ATX の見出し。前の行が空でないので空行をはさむ
    let source = "# R\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n\n## 新しいノード\n",
        (2, NEW),
        1,
    );
    let source = "# R\n## A\n### C\n";
    assert_added(
        source,
        &add_child(source, 3, "C", NEW),
        "# R\n## A\n### C\n\n#### 新しいノード\n",
        (4, NEW),
        3,
    );
    // 6 段の見出しの子はリストの項目 (段落があれば段落のあと)
    let source = "# R\n###### F\n";
    assert_added(
        source,
        &add_child(source, 2, "F", NEW),
        "# R\n###### F\n- 新しいノード\n",
        (3, NEW),
        2,
    );
    let source = "# R\n###### F\n本文\n";
    assert_added(
        source,
        &add_child(source, 2, "F", NEW),
        "# R\n###### F\n本文\n- 新しいノード\n",
        (3, NEW),
        2,
    );
}

#[test]
fn edit_add_child_of_an_item_without_children_is_a_nested_item() {
    // 入れ子のリストのない文書は 4 桁
    let source = "# R\n- a\n- b\n";
    assert_added(
        source,
        &add_child(source, 2, "a", NEW),
        "# R\n- a\n    - 新しいノード\n- b\n",
        (3, NEW),
        2,
    );
    // 文書の入れ子の字下げの差の最小は 2。`- ` の内容の桁 (2) 以上なので 2 を足す
    let source = "# R\n## A\n- x\n  - y\n## B\n10. a\n";
    assert_added(
        source,
        &add_child(source, 4, "y", NEW),
        "# R\n## A\n- x\n  - y\n    - 新しいノード\n## B\n10. a\n",
        (5, NEW),
        4,
    );
    // 差の最小 (2) が `10. ` の内容の桁 (4) より小さいので内容の桁にそろえる
    assert_added(
        source,
        &add_child(source, 6, "10. a", NEW),
        "# R\n## A\n- x\n  - y\n## B\n10. a\n    - 新しいノード\n",
        (7, NEW),
        6,
    );
    // 空白の文書の `100. a` の子は内容の桁 5 (4 では a の段落の続きになる)
    let source = "# R\n100. a\n";
    assert_added(
        source,
        &add_child(source, 2, "100. a", NEW),
        "# R\n100. a\n     - 新しいノード\n",
        (3, NEW),
        2,
    );
}

#[test]
fn edit_add_child_follows_the_last_child_shape() {
    // 最後の子が見出しなら同じ段
    let source = "# R\n## A\n### a1\n## B\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n## A\n### a1\n## B\n\n## 新しいノード\n",
        (5, NEW),
        1,
    );
    // 最後の子が項目なら同じ字下げと同じ印
    let source = "# R\n## A\n- x\n    > 詳細\n- y\n\n## B\n";
    assert_added(
        source,
        &add_child(source, 2, "A", NEW),
        "# R\n## A\n- x\n    > 詳細\n- y\n- 新しいノード\n\n## B\n",
        (5, NEW),
        2,
    );
    let source = "# R\n## A\n- x\n  - y\n## B\n10. a\n";
    assert_added(
        source,
        &add_child(source, 3, "x", NEW),
        "# R\n## A\n- x\n  - y\n  - 新しいノード\n## B\n10. a\n",
        (5, NEW),
        3,
    );
    let source = "# R\n* a\n* b\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n* a\n* b\n* 新しいノード\n",
        (4, NEW),
        1,
    );
    let source = "# R\n- a\n    + x\n";
    assert_added(
        source,
        &add_child(source, 2, "a", NEW),
        "# R\n- a\n    + x\n    + 新しいノード\n",
        (4, NEW),
        2,
    );
    // 番号付きは最後の子の番号 + 1 で、区切りの . と ) を保つ。refText は解析し直した値 (頭の番号を含む)
    let source = "# R\n1. a\n2. b\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n1. a\n2. b\n3. 新しいノード\n",
        (4, "3. 新しいノード"),
        1,
    );
    let source = "# R\n1) a\n2) b\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n1) a\n2) b\n3) 新しいノード\n",
        (4, "3. 新しいノード"),
        1,
    );
    let source = "# R\n- a\n    1. x\n    2. y\n";
    assert_added(
        source,
        &add_child(source, 2, "a", NEW),
        "# R\n- a\n    1. x\n    2. y\n    3. 新しいノード\n",
        (5, "3. 新しいノード"),
        2,
    );
    // 最後の子がタスクなら `[ ] ` を付ける (状態によらず未着手)
    let source = "# R\n- [x] a\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n- [x] a\n- [ ] 新しいノード\n",
        (3, NEW),
        1,
    );
    let source = "# R\n- a\n    1. [/] x\n";
    assert_added(
        source,
        &add_child(source, 2, "a", NEW),
        "# R\n- a\n    1. [/] x\n    2. [ ] 新しいノード\n",
        (4, "2. 新しいノード"),
        2,
    );
}

#[test]
fn edit_add_child_after_a_container_or_a_block_last_child() {
    // 最後の子が容器なら、その容器の最後の項目の形で容器のリストの末尾に足す。足したノードの親は容器
    assert_added(
        NESTED_LISTS,
        &add_child(NESTED_LISTS, 1, "R", NEW),
        "# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n",
        (8, "3. 新しいノード"),
        5,
    );
    // 容器そのものの子も容器のリストの末尾
    assert_added(
        NESTED_LISTS,
        &add_child(NESTED_LISTS, 2, "", NEW),
        "# R\n\n- a\n- b\n- 新しいノード\n\n1. c\n2. d\n",
        (5, NEW),
        2,
    );
    assert_added(
        NESTED_LISTS,
        &add_child(NESTED_LISTS, 5, "", NEW),
        "# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n",
        (8, "3. 新しいノード"),
        5,
    );
    // 最後の子が表かコード: 子のないときの形 (`## 新しいノード`) で書くと、解析は見出しの前の表とコードを子にしなくなる
    // (子の段が見出しに変わると前の子を捨てる)。書き換えたあとの確かめが止め、原文を変えない
    for source in [
        "# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
        "# R\n\n~~~js\nx\n~~~\n",
    ] {
        assert_eq!(ref_texts(source).len(), 2, "{source:?}");
        assert_refused(&add_child(source, 1, "R", NEW), "structure-changed");
    }
}

#[test]
fn edit_add_child_goes_after_the_last_line_of_the_parent_block() {
    // 見出しの子は配下の段落のあと
    let source = "# R\n\n## A\n本文の段落\n\n## B\n";
    assert_added(
        source,
        &add_child(source, 2, "A", NEW),
        "# R\n\n## A\n本文の段落\n\n### 新しいノード\n\n## B\n",
        (3, NEW),
        2,
    );
    // 項目の子は詳細と入れ子の全部のあと
    let source = "# R\n- x\n    > 詳細\n    - x1\n        - x2\n- y\n";
    assert_added(
        source,
        &add_child(source, 2, "x", NEW),
        "# R\n- x\n    > 詳細\n    - x1\n        - x2\n    - 新しいノード\n- y\n",
        (5, NEW),
        2,
    );
    // 続きの段落のあと。ブロックの末尾の空行のあとではない
    let source = "# R\n- a\n\n  続き\n\n- b\n";
    assert_added(
        source,
        &add_child(source, 2, "a", NEW),
        "# R\n- a\n\n  続き\n    - 新しいノード\n\n- b\n",
        (3, NEW),
        2,
    );
    // 行を持たないルートの子は本文の末尾。形は最上位の最後のノード (ol の容器) の最後の項目
    assert_added(
        LINELESS_LISTS,
        &add_child(LINELESS_LISTS, 1, "T", NEW),
        "---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n",
        (8, "3. 新しいノード"),
        5,
    );
    // リストだけの文書のルート (容器) の子はリストの末尾
    assert_added(
        LIST_ROOT,
        &add_child(LIST_ROOT, 1, "", NEW),
        "- a\n- b\n- 新しいノード\n",
        (4, NEW),
        1,
    );
    assert_added(
        LIST_ROOT_TITLED,
        &add_child(LIST_ROOT_TITLED, 1, "手順", NEW),
        "---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n- 新しいノード\n",
        (4, NEW),
        1,
    );
}

#[test]
fn edit_add_sibling_goes_after_the_block_in_the_same_shape() {
    // 見出し: 配下のあとに同じ段。末尾の空行のあとではない
    let source = "# R\n## A\n### a1\n\n## B\n";
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\n## A\n### a1\n\n## 新しいノード\n\n## B\n",
        (4, NEW),
        1,
    );
    // 項目: 詳細と入れ子のあとに、同じ字下げと同じ印
    let source = "# R\n- x\n    > 詳細\n    - x1\n- y\n";
    assert_added(
        source,
        &add_sibling(source, 2, "x", NEW),
        "# R\n- x\n    > 詳細\n    - x1\n- 新しいノード\n- y\n",
        (4, NEW),
        1,
    );
    assert_added(
        source,
        &add_sibling(source, 3, "x1", NEW),
        "# R\n- x\n    > 詳細\n    - x1\n    - 新しいノード\n- y\n",
        (4, NEW),
        2,
    );
    // 番号付き: 自分の番号 + 1。あとに続く兄弟の番号は振り直さない
    let source = "# R\n1. a\n2. b\n3. c\n";
    assert_added(
        source,
        &add_sibling(source, 2, "1. a", NEW),
        "# R\n1. a\n2. 新しいノード\n2. b\n3. c\n",
        (3, "2. 新しいノード"),
        1,
    );
    let source = "# R\n1) a\n2) b\n";
    assert_added(
        source,
        &add_sibling(source, 3, "2. b", NEW),
        "# R\n1) a\n2) b\n3) 新しいノード\n",
        (4, "3. 新しいノード"),
        1,
    );
    // タスク: `[ ] ` を付ける (項目、番号付きの項目、見出し)
    let source = "# R\n- [/] a\n- b\n";
    assert_added(
        source,
        &add_sibling(source, 2, "a", NEW),
        "# R\n- [/] a\n- [ ] 新しいノード\n- b\n",
        (3, NEW),
        1,
    );
    let source = "# R\n1. [-] a\n";
    assert_added(
        source,
        &add_sibling(source, 2, "1. [-] a", NEW),
        "# R\n1. [-] a\n2. [ ] 新しいノード\n",
        (3, "2. 新しいノード"),
        1,
    );
    let source = "# R\n## [x] h\n";
    assert_added(
        source,
        &add_sibling(source, 2, "h", NEW),
        "# R\n## [x] h\n\n## [ ] 新しいノード\n",
        (3, NEW),
        1,
    );
    // 容器の中の項目の兄弟は、同じ容器のリストに入る
    assert_added(
        NESTED_LISTS,
        &add_sibling(NESTED_LISTS, 3, "a", NEW),
        "# R\n\n- a\n- 新しいノード\n- b\n\n1. c\n2. d\n",
        (4, NEW),
        2,
    );
    assert_added(
        NESTED_LISTS,
        &add_sibling(NESTED_LISTS, 7, "2. d", NEW),
        "# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n",
        (8, "3. 新しいノード"),
        5,
    );
}

#[test]
fn edit_add_sibling_of_the_root_adds_a_child() {
    // 親のない (ルートの) 兄弟は子として足す
    let source = "# R\n- a\n";
    assert_added(
        source,
        &add_sibling(source, 1, "R", NEW),
        "# R\n- a\n- 新しいノード\n",
        (3, NEW),
        1,
    );
    // ルートだけの文書
    let source = "# R\n";
    assert_added(
        source,
        &add_sibling(source, 1, "R", NEW),
        "# R\n\n## 新しいノード\n",
        (2, NEW),
        1,
    );
    // 項目 1 つだけの文書: ルートはその項目
    let source = "- a\n";
    assert_eq!(ref_texts(source), vec![(1, None, "a".to_string())]);
    assert_added(
        source,
        &add_sibling(source, 1, "a", NEW),
        "- a\n    - 新しいノード\n",
        (2, NEW),
        1,
    );
    // 行を持たないルート
    assert_added(
        LINELESS_LISTS,
        &add_sibling(LINELESS_LISTS, 1, "T", NEW),
        "---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n",
        (8, "3. 新しいノード"),
        5,
    );
    // ルートでもある容器 (リストだけの文書のルート) はルートの規則が勝つ: 兄弟を足せて、子として足す
    for (source, ref_text, expected) in [
        (LIST_ROOT, "", "- a\n- b\n- 新しいノード\n"),
        (
            LIST_ROOT_TITLED,
            "手順",
            "---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n- 新しいノード\n",
        ),
    ] {
        assert_eq!(
            inspect(source, 1, ref_text).map(|result| result["canAddSibling"].clone()),
            Some(json!(true)),
            "{source:?}"
        );
        assert_added(
            source,
            &add_sibling(source, 1, ref_text, NEW),
            expected,
            (4, NEW),
            1,
        );
    }
}

#[test]
fn edit_add_to_setext_headings_writes_atx_headings() {
    // 下線の見出しの兄弟と子は ATX で足す。Root の子と兄弟 (ルートなので子)、設計の兄弟は同じ行になる
    let expected = "---\nmarkdag:\n---\nRoot\n====\n\n設計\n----\n- 画面\n\n## 新しいノード\n";
    assert_added(
        SETEXT,
        &add_sibling(SETEXT, 2, "設計", NEW),
        expected,
        (4, NEW),
        1,
    );
    assert_added(
        SETEXT,
        &add_child(SETEXT, 1, "Root", NEW),
        expected,
        (4, NEW),
        1,
    );
    assert_added(
        SETEXT,
        &add_sibling(SETEXT, 1, "Root", NEW),
        expected,
        (4, NEW),
        1,
    );
    // 下線の見出しの子が項目なら項目
    assert_added(
        SETEXT,
        &add_child(SETEXT, 2, "設計", NEW),
        "---\nmarkdag:\n---\nRoot\n====\n\n設計\n----\n- 画面\n- 新しいノード\n",
        (4, NEW),
        2,
    );
    // 子のない下線の見出しの子は 1 段下の ATX の見出し (下線の `----` ではない)
    let source = "Root\n====\n";
    assert_added(
        source,
        &add_child(source, 1, "Root", NEW),
        "Root\n====\n\n## 新しいノード\n",
        (2, NEW),
        1,
    );
}

#[test]
fn edit_add_refuses_containers_blocks_and_stale_targets() {
    // 容器の兄弟は no-source-line
    for id in [2, 5] {
        assert_refused(&add_sibling(NESTED_LISTS, id, "", NEW), "no-source-line");
    }
    // 表とコードと画像の子と兄弟は block-node
    for id in [2, 3, 4] {
        assert_refused(&add_child(BLOCKS, id, "", NEW), "block-node");
        assert_refused(&add_sibling(BLOCKS, id, "", NEW), "block-node");
    }
    // refText が違う NodeTarget と、その id のノードがない NodeTarget は stale-node
    for (source, id, ref_text) in [
        (NESTED_LISTS, 3, "b"),
        (NESTED_LISTS, 99, "a"),
        (NESTED_LISTS, 0, ""),
        (MARKED, 3, "**太字** と `code`"),
    ] {
        assert_refused(&add_child(source, id, ref_text, NEW), "stale-node");
        assert_refused(&add_sibling(source, id, ref_text, NEW), "stale-node");
    }
}

#[test]
fn edit_add_rewrites_lone_carriage_returns_as_the_document_line_break() {
    // 単独の \r は comrak と split('\n') で行の数え方が食い違うので、文書の最初の改行にそろえてから足す (D-061)
    for (source, nl) in [("# R\n- a\r- b\n", "\n"), ("# R\r\n- a\r- b\r\n", "\r\n")] {
        assert_eq!(node_of(source, 2).ref_text, "a");
        let lines = |items: &[&str]| {
            items
                .iter()
                .map(|line| format!("{line}{nl}"))
                .collect::<String>()
        };
        assert_added(
            source,
            &add_child(source, 2, "a", NEW),
            &lines(&["# R", "- a", "    - 新しいノード", "- b"]),
            (3, NEW),
            2,
        );
        assert_added(
            source,
            &add_child(source, 1, "R", NEW),
            &lines(&["# R", "- a", "- b", "- 新しいノード"]),
            (4, NEW),
            1,
        );
        assert_added(
            source,
            &add_sibling(source, 2, "a", NEW),
            &lines(&["# R", "- a", "- 新しいノード", "- b"]),
            (3, NEW),
            1,
        );
    }
}

#[test]
fn edit_add_inserts_blank_lines_around_headings_and_before_paragraphs() {
    // 項目を段落の前に足すときは、段落が項目に吸い込まれないよう足した項目のあとに空行をはさむ
    assert_added(
        FENCED_ITEM,
        &add_sibling(FENCED_ITEM, 2, "a", NEW),
        "# R\n- a\n\n  ~~~\n  x\n  ~~~\n- 新しいノード\n\n本文\n",
        (3, NEW),
        1,
    );
    assert_added(
        FENCED_ITEM,
        &add_child(FENCED_ITEM, 2, "a", NEW),
        "# R\n- a\n\n  ~~~\n  x\n  ~~~\n    - 新しいノード\n\n本文\n",
        (3, NEW),
        2,
    );
    // 見出しを段落の直後とリストの直後に足すときは、前と後ろ (次の行が空でなければ) に空行をはさむ
    let source = "# R\n## A\n本文\n## B\n";
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\n## A\n本文\n\n## 新しいノード\n\n## B\n",
        (3, NEW),
        1,
    );
    let source = "# R\n## A\n- x\n- y\n## B\n";
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\n## A\n- x\n- y\n\n## 新しいノード\n\n## B\n",
        (5, NEW),
        1,
    );
    // もう空行があれば重ねない
    let source = "# R\n\n## A\n\n- x\n\n## B\n";
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\n\n## A\n\n- x\n\n## 新しいノード\n\n## B\n",
        (4, NEW),
        1,
    );
}

#[test]
fn edit_add_indents_children_with_tabs_in_tab_documents() {
    // タブを使う文書は、求めた桁を 4 桁ごとのタブと残りの空白で書く。
    // `100. a` の子は内容の桁 5 (入れ子の差の最小 4 より大きい) なので、タブ 1 つと空白 1 つ
    assert_added(
        TABBED,
        &add_child(TABBED, 4, "100. a", NEW),
        "---\nmarkdag:\n---\n- x\n\t- y\n100. a\n\t - 新しいノード\n",
        (5, NEW),
        4,
    );
    // y (桁 4) の子は桁 8 でタブ 2 つ
    assert_added(
        TABBED,
        &add_child(TABBED, 3, "y", NEW),
        "---\nmarkdag:\n---\n- x\n\t- y\n\t\t- 新しいノード\n100. a\n",
        (4, NEW),
        3,
    );
    // 最後の子と同じ形、自分と同じ形
    let expected = "---\nmarkdag:\n---\n- x\n\t- y\n\t- 新しいノード\n100. a\n";
    assert_added(
        TABBED,
        &add_child(TABBED, 2, "x", NEW),
        expected,
        (4, NEW),
        2,
    );
    assert_added(
        TABBED,
        &add_sibling(TABBED, 3, "y", NEW),
        expected,
        (4, NEW),
        2,
    );
}

#[test]
fn edit_add_keeps_line_endings_and_the_document_end() {
    // CRLF の文書は足す行 (はさむ空行も) の末尾に \r を付け、ほかの行は変えない
    let source = "# R\r\n- a\r\n- b\r\n";
    assert_added(
        source,
        &add_sibling(source, 2, "a", NEW),
        "# R\r\n- a\r\n- 新しいノード\r\n- b\r\n",
        (3, NEW),
        1,
    );
    let source = "# R\r\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\r\n\r\n## 新しいノード\r\n",
        (2, NEW),
        1,
    );
    // 改行で終わる文書は改行で終わり、終わらない文書は終わらないまま (改行のない文書は LF)
    let source = "# R\n- a\n";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n- a\n- 新しいノード\n",
        (3, NEW),
        1,
    );
    let source = "# R\n- a";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n- a\n- 新しいノード",
        (3, NEW),
        1,
    );
    let source = "# R";
    assert_added(
        source,
        &add_child(source, 1, "R", NEW),
        "# R\n\n## 新しいノード",
        (2, NEW),
        1,
    );
    // 改行で終わらない CRLF の文書: 前の最後の行に \r を足し、足す最後の行には付けない
    let source = "# R\r\n- a";
    let once = applied(source, &add_child(source, 1, "R", NEW));
    assert_eq!(once, "# R\r\n- a\r\n- 新しいノード");
    let source = "# R\r\n## A";
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\r\n## A\r\n\r\n## 新しいノード",
        (3, NEW),
        1,
    );
    // 2 回続けて足しても単独の \r ができず、line-endings で断られない。足したノードの名前の決定も通る
    assert_added(
        &once,
        &add_child(&once, 1, "R", NEW),
        "# R\r\n- a\r\n- 新しいノード\r\n- 新しいノード",
        (4, NEW),
        1,
    );
    assert_eq!(renamed(&once, 3, NEW, "b"), "# R\r\n- a\r\n- b");
}

#[test]
fn edit_add_selects_and_renames_the_added_item_not_its_container() {
    // select と rename は足したノード。行を持たないルートや容器のある文書でも、容器でなく足した項目を指す
    let cases: [(&str, Value, (u32, &str)); 5] = [
        (
            NESTED_LISTS,
            add_sibling(NESTED_LISTS, 3, "a", NEW),
            (4, NEW),
        ),
        (
            NESTED_LISTS,
            add_child(NESTED_LISTS, 1, "R", NEW),
            (8, "3. 新しいノード"),
        ),
        (
            LINELESS_LISTS,
            add_child(LINELESS_LISTS, 1, "T", NEW),
            (8, "3. 新しいノード"),
        ),
        (LIST_ROOT, add_child(LIST_ROOT, 1, "", NEW), (4, NEW)),
        (LIST_ROOT, add_sibling(LIST_ROOT, 2, "a", NEW), (3, NEW)),
    ];
    for (source, result, (id, ref_text)) in cases {
        assert_eq!(result["select"], selected(id, ref_text), "{result}");
        assert_eq!(
            result["rename"],
            normalized(json!({ "kind": "node", "node": { "id": id, "refText": ref_text } })),
            "{result}"
        );
        assert_eq!(
            keys(&result),
            ["notes", "rename", "select", "splices", "status"]
        );
        assert_select_matches_reparse(source, &result);
        let after = applied(source, &result);
        assert_eq!(
            inspect(&after, id, ref_text).map(|inspected| inspected["kind"].clone()),
            Some(json!("item")),
            "{after:?}"
        );
    }
    // 項目 1 つの文書の兄弟 (ルートの子) も同じ
    let source = "- a\n";
    let result = add_sibling(source, 1, "a", NEW);
    assert_eq!(result["select"], selected(2, NEW), "{result}");
    assert_select_matches_reparse(source, &result);
}

#[test]
fn edit_add_writes_the_provisional_name_by_the_name_line_rules() {
    // 足す操作の label にも名前の行の規則 (改行は空白、前後の空白を外す) と逃がしを当てる (3.5 の名前の行)
    let source = format!("{MD}# R\n- a\n");
    assert_added(
        &source,
        &add_child(&source, 2, "a", "#todo"),
        &format!("{MD}# R\n- a\n    - \\#todo\n"),
        (3, "#todo"),
        2,
    );
    assert_added(
        &source,
        &add_sibling(&source, 2, "a", " x\ny "),
        &format!("{MD}# R\n- a\n- x y\n"),
        (3, "x y"),
        1,
    );
    let source = format!("{MD}# R\n");
    assert_added(
        &source,
        &add_child(&source, 1, "R", "Issue #"),
        &format!("{MD}# R\n\n## Issue \\#\n"),
        (2, "Issue #"),
        1,
    );
}

// ---- 子を足せない所と、足すと読み方が変わる文書 (最後の子が表、コード、画像の見出し、新しい容器、空の文書、題だけの文書) ----

// 1 R / 2 A / 3 表、コード、画像 (A の子) / 4 B
const HEADING_WITH_BLOCKS: [&str; 3] = [
    "# R\n## A\n\n| a | b |\n| - | - |\n| 1 | 2 |\n## B\n",
    "# R\n## A\n\n~~~js\nx\n~~~\n## B\n",
    "# R\n## A\n\n![img](x.png)\n## B\n",
];

#[test]
fn edit_add_child_is_not_offered_under_a_heading_whose_last_child_is_a_block() {
    // 見出しの最後の子が表、コード、画像なら、その見出しの canAddChild は false で、addChild は structure-changed。
    // 見出しも詳細を持てるので canHaveDetails は true (D-079)
    for source in HEADING_WITH_BLOCKS {
        assert_eq!(node_of(source, 3).parent, Some(2), "{source:?}");
        assert_eq!(
            inspect(source, 2, "A"),
            Some(inspected(
                2,
                "heading",
                "A",
                None,
                false,
                [true, true, true, true, false, true, true]
            )),
            "{source:?}"
        );
        assert_refused(&add_child(source, 2, "A", NEW), "structure-changed");
    }
    // 6 段の見出し (子のないときの形は `- `) と、ルートの見出し (最後の子が画像)
    let source = "# R\n###### F\n\n~~~\nx\n~~~\n";
    assert_eq!(
        inspect(source, 2, "F").map(|result| result["canAddChild"].clone()),
        Some(json!(false))
    );
    assert_refused(&add_child(source, 2, "F", NEW), "structure-changed");
    assert_eq!(
        inspect(BLOCKS, 1, "R").map(|result| result["canAddChild"].clone()),
        Some(json!(false))
    );
    assert_refused(&add_child(BLOCKS, 1, "R", NEW), "structure-changed");
    // 兄弟は今までの規則のまま足せる (表やコードは A の子に残る)
    let source = HEADING_WITH_BLOCKS[1];
    assert_added(
        source,
        &add_sibling(source, 2, "A", NEW),
        "# R\n## A\n\n~~~js\nx\n~~~\n\n## 新しいノード\n\n## B\n",
        (4, NEW),
        1,
    );
    assert_eq!(
        node_of(&applied(source, &add_sibling(source, 2, "A", NEW)), 3).parent,
        Some(2)
    );
}

#[test]
fn edit_add_refuses_when_a_new_container_would_take_existing_items() {
    // 同じ親の下にリストが 2 つあり、項目 1 つのリストに足すと容器ができて、触らない項目の親が変わる。
    // 容器を飛ばして比べず structure-changed で断る
    let source = "# R\n\n- a\n\n1. c\n2. d\n";
    assert_eq!(node_of(source, 2).parent, Some(1));
    assert_refused(&add_sibling(source, 2, "a", NEW), "structure-changed");
    // LINELESS の文書: ルートの子はどちらも項目 1 つのリスト (容器にならず、ルートの直下)
    assert_eq!(node_of(LINELESS, 3).parent, Some(1));
    assert_refused(&add_child(LINELESS, 1, "T", NEW), "structure-changed");
    assert_refused(&add_sibling(LINELESS, 1, "T", NEW), "structure-changed");
    assert_refused(&add_sibling(LINELESS, 2, "a", NEW), "structure-changed");
    assert_refused(&add_sibling(LINELESS, 3, "1. b", NEW), "structure-changed");
    // タブの文書の `100. a` の兄弟 (`101. `)
    assert_refused(&add_sibling(TABBED, 4, "100. a", NEW), "structure-changed");
}

#[test]
fn edit_add_to_an_empty_document_makes_the_added_item_the_root() {
    // 空の文書 (frontmatter の title もない) は断らず、足した項目がルートになる。選び直しは id 1 (足したノード)
    for (source, expected) in [
        ("", "- 新しいノード\n"),
        (
            "---\nmarkdag:\n---\n",
            "---\nmarkdag:\n---\n- 新しいノード\n",
        ),
    ] {
        assert_eq!(ref_texts(source), vec![(1, None, String::new())]);
        for result in [
            add_child(source, 1, "", NEW),
            add_sibling(source, 1, "", NEW),
        ] {
            let after = applied(source, &result);
            assert_eq!(after, expected, "{source:?}: {result}");
            assert_eq!(result["select"], selected(1, NEW), "{result}");
            assert_eq!(
                result["rename"],
                normalized(json!({ "kind": "node", "node": { "id": 1, "refText": NEW } })),
                "{result}"
            );
            assert_eq!(result["notes"], json!([]), "{result}");
            assert_select_matches_reparse(source, &result);
            assert_eq!(ref_texts(&after), vec![(1, None, NEW.to_string())]);
        }
    }
}

#[test]
fn edit_add_to_a_title_only_document_is_structure_changed() {
    // frontmatter の title だけがある文書は、足した項目がルートに置き換わり title が名前から消えるので断る
    for source in ["---\ntitle: T\n---\n", "---\ntitle: T\nmarkdag:\n---\n"] {
        assert_eq!(ref_texts(source), vec![(1, None, "T".to_string())]);
        assert_refused(&add_child(source, 1, "T", NEW), "structure-changed");
        assert_refused(&add_sibling(source, 1, "T", NEW), "structure-changed");
    }
}

// ---- ノードの削除と付け替え (deleteNodes と moveNode。削除、付け替え、字下げの書き方) ----
// 本文の書き換えだけを見る (relations の追随は frontmatter の書き換えのテストが見る)。文書は frontmatter に relations を持たない

fn delete_nodes(source: &str, nodes: &[(u32, &str)]) -> Value {
    let nodes: Vec<Value> = nodes
        .iter()
        .map(|(id, ref_text)| json!({ "id": id, "refText": ref_text }))
        .collect();
    edited_by(source, json!({ "kind": "deleteNodes", "nodes": nodes }))
}

fn move_node(source: &str, node: (u32, &str), parent: (u32, &str)) -> Value {
    edited_by(
        source,
        json!({
            "kind": "moveNode",
            "node": { "id": node.0, "refText": node.1 },
            "parent": { "id": parent.0, "refText": parent.1 },
        }),
    )
}

// 書き換えた結果: 原文の全体、select が 1 つのノード (書き換えたあとの原文を解析し直した id と refText)、
// rename は null、notes は空
fn assert_rewritten(source: &str, result: &Value, expected: &str, chosen: (u32, &str)) {
    let after = applied(source, result);
    assert_eq!(after, expected, "{source:?}: {result}");
    let (id, ref_text) = chosen;
    assert_eq!(result["select"], selected(id, ref_text), "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_eq!(result["notes"], json!([]), "{result}");
    assert_select_matches_reparse(source, result);
}

// 付け替えた結果: 上に加えて、動かしたノードの親が移す先
fn assert_moved(source: &str, result: &Value, expected: &str, moved: (u32, &str), parent: u32) {
    assert_rewritten(source, result, expected, moved);
    assert_eq!(
        node_of(expected, moved.0).parent,
        Some(parent),
        "{expected:?}"
    );
}

// splices は元の原文の行の添字で start の昇順、重ならない
fn assert_splices_ordered(result: &Value) {
    let splices = result["splices"].as_array().expect("splices は配列");
    let mut end = 0.0;
    for splice in splices {
        let start = splice["start"].as_f64().expect("start は数");
        assert!(start >= end, "昇順で重ならない: {result}");
        end = start + splice["deleteCount"].as_f64().expect("deleteCount は数");
    }
}

fn details_of(source: &str, id: u32, ref_text: &str) -> Value {
    inspect(source, id, ref_text).expect("ノードがある")["details"].clone()
}

#[test]
fn edit_delete_removes_an_item_with_its_subtree() {
    // 項目のブロックは lines の範囲 (詳細の引用と入れ子のリストを含む)。選ぶのは消したノードの親
    let source = "# R\n- a\n    > 詳細\n    - a1\n        - a2\n- b\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "a")]),
        "# R\n- b\n",
        (1, "R"),
    );
    // frontmatter (relations なし) は変わらない。文書の最後の項目
    let source = format!("{MD}# R\n- a\n- b\n");
    assert_rewritten(
        &source,
        &delete_nodes(&source, &[(3, "b")]),
        &format!("{MD}# R\n- a\n"),
        (1, "R"),
    );
    // 番号付き: 行を消すだけで後ろの番号は書き直さない (解析し直した refText は並びの位置の番号)
    let source = "# R\n1. a\n2. b\n3. c\n";
    let result = delete_nodes(source, &[(3, "2. b")]);
    assert_rewritten(source, &result, "# R\n1. a\n3. c\n", (1, "R"));
    assert_eq!(node_of(&applied(source, &result), 3).ref_text, "2. c");
    // 改行で終わらない文書は終わらないまま
    let source = "# R\n- a\n- b";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "b")]),
        "# R\n- a",
        (1, "R"),
    );
}

#[test]
fn edit_delete_removes_a_heading_up_to_the_next_node_outside_it() {
    // 見出しのブロックは、文書順で次の「配下でないノード」の前まで (配下の段落、リスト、コードを含む)
    let source = "# R\n## A\n段落\n- a1\n## B\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "A")]),
        "# R\n## B\n",
        (1, "R"),
    );
    // 末尾の空行はブロックに入れない
    let source = "# R\n## A\n\n段落\n\n~~~\nx\n~~~\n\n## B\n本文\n";
    assert_eq!(node_of(source, 3).parent, Some(2));
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "A")]),
        "# R\n\n## B\n本文\n",
        (1, "R"),
    );
    // 深い段の見出しは、上の段の次の見出しの前まで
    let source = "# R\n## A\n### A1\n本文\n## B\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "A1")]),
        "# R\n## A\n## B\n",
        (2, "A"),
    );
    // あとに配下でないノードがなければ本文の最後まで
    let source = "# R\n## A\n- x\n## B\n本文\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(4, "B")]),
        "# R\n## A\n- x\n",
        (1, "R"),
    );
}

#[test]
fn edit_delete_collapses_blank_lines_that_meet() {
    // 消したあとに空行が 2 つ以上続けば 1 つにする
    let source = "# R\n\n## A\n\n段落\n\n## B\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "A")]),
        "# R\n\n## B\n",
        (1, "R"),
    );
    let source = "# R\n\n- a\n\n- b\n\n- c\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "b")]),
        "# R\n\n- a\n\n- c\n",
        (1, "R"),
    );
}

#[test]
fn edit_delete_many_nodes_at_once() {
    // 1 回の操作で全部を配下ごと消す。選ぶのは文書順で最初に消したノードの親
    let source = "# R\n- a\n    - a1\n- b\n- c\n";
    let result = delete_nodes(source, &[(5, "c"), (2, "a")]);
    assert_rewritten(source, &result, "# R\n- b\n", (1, "R"));
    assert_splices_ordered(&result);
    // 配下に含まれるノード (a1) と同じノードを重ねて渡しても、a のブロックは 1 回だけ消える
    let result = delete_nodes(source, &[(3, "a1"), (2, "a"), (2, "a")]);
    assert_rewritten(source, &result, "# R\n- b\n- c\n", (1, "R"));
    assert_splices_ordered(&result);
    // 親の違うノード: 文書順で最初の y の親 A を選ぶ
    let source = "# R\n## A\n- x\n- y\n## B\n- z\n";
    let result = delete_nodes(source, &[(6, "z"), (4, "y")]);
    assert_rewritten(source, &result, "# R\n## A\n- x\n## B\n", (2, "A"));
    assert_splices_ordered(&result);
    // 見出しと項目
    let result = delete_nodes(source, &[(5, "B"), (3, "x")]);
    assert_rewritten(source, &result, "# R\n## A\n- y\n", (2, "A"));
    assert_splices_ordered(&result);
}

#[test]
fn edit_delete_selects_the_parent_even_when_it_has_no_line() {
    // 親が行を持たないルートなら id 1 (行から引けない)
    let source = "---\ntitle: T\n---\n## A\n## B\n## C\n";
    assert_eq!(node_of(source, 1).lines, None);
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "B")]),
        "---\ntitle: T\n---\n## A\n## C\n",
        (1, "T"),
    );
    let source = "# A\n# B\n# C\n";
    assert_eq!(node_of(source, 1).lines, None);
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "B")]),
        "# A\n# C\n",
        (1, ""),
    );
    // 入れ子の項目を消すと、その親の項目を選ぶ
    let source = "# R\n- a\n    - a1\n    - a2\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(4, "a2")]),
        "# R\n- a\n    - a1\n",
        (2, "a"),
    );
}

#[test]
fn edit_delete_removes_containers_and_blocks() {
    // 容器の削除はリストの行の全体。リストが 3 つの文書なので、残る 2 つは容器のまま
    let source = "# R\n\n- a\n- b\n\n1. c\n2. d\n\n- e\n- f\n";
    assert_eq!(node_of(source, 2).ref_text, "");
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "")]),
        "# R\n\n1. c\n2. d\n\n- e\n- f\n",
        (1, "R"),
    );
    // 表とコードと画像は消せる (名前などは block-node でも、削除はできる)
    assert_rewritten(
        BLOCKS,
        &delete_nodes(BLOCKS, &[(2, "")]),
        &format!("{MD}# R\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n"),
        (1, "R"),
    );
    assert_rewritten(
        BLOCKS,
        &delete_nodes(BLOCKS, &[(3, "")]),
        &format!("{MD}# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![img](x.png)\n"),
        (1, "R"),
    );
    let source = format!("{MD}# R\n\n![img](x.png)\n\n~~~js\nx\n~~~\n");
    assert_rewritten(
        &source,
        &delete_nodes(&source, &[(2, "")]),
        &format!("{MD}# R\n\n~~~js\nx\n~~~\n"),
        (1, "R"),
    );
}

#[test]
fn edit_delete_refuses_the_root() {
    // ルートは消せない。見出しのルート、行を持たないルート、リストだけの文書のルート (容器)、項目 1 つの文書のルート
    assert_refused(&delete_nodes("# R\n- a\n", &[(1, "R")]), "root");
    assert_refused(&delete_nodes(LINELESS, &[(1, "T")]), "root");
    assert_refused(&delete_nodes(LIST_ROOT, &[(1, "")]), "root");
    assert_refused(&delete_nodes("- a\n", &[(1, "a")]), "root");
    // ほかのノードと一緒にルートを渡しても全体を断る
    assert_refused(&delete_nodes("# R\n- a\n", &[(2, "a"), (1, "R")]), "root");
}

#[test]
fn edit_delete_refuses_when_a_container_or_the_root_would_be_replaced() {
    // 項目 2 つのリストが 1 つになると容器がなくなり、触らない項目の親が変わる。子と兄弟の追加と同じく、容器を飛ばして比べず
    // structure-changed (書き換えたあとの確かめで断る)
    assert_eq!(node_of(NESTED_LISTS, 4).parent, Some(2));
    assert_refused(
        &delete_nodes(NESTED_LISTS, &[(3, "a")]),
        "structure-changed",
    );
    // 容器を消すとリストが 1 つになり、もう 1 つの容器がなくなる
    assert_refused(&delete_nodes(NESTED_LISTS, &[(2, "")]), "structure-changed");
    // 残る最上位のブロックが 1 つになり、ルートが残った項目か見出しに置き換わる (title も名前から消える)
    assert_refused(&delete_nodes(LIST_ROOT, &[(2, "a")]), "structure-changed");
    assert_refused(
        &delete_nodes(LIST_ROOT_TITLED, &[(2, "設計")]),
        "structure-changed",
    );
    assert_refused(
        &delete_nodes("# A\n# B\n", &[(3, "B")]),
        "structure-changed",
    );
}

#[test]
fn edit_delete_refuses_stale_targets_and_rewrites_lone_carriage_returns() {
    // どれか 1 つでも古い NodeTarget なら stale-node
    let source = "# R\n- a\n- b\n";
    for nodes in [
        vec![(2, "b")],
        vec![(99, "a")],
        vec![(0, "")],
        vec![(2, "a"), (3, "x")],
    ] {
        assert_refused(&delete_nodes(source, &nodes), "stale-node");
    }
    assert_refused(
        &delete_nodes(MARKED, &[(3, "**太字** と `code`")]),
        "stale-node",
    );
    // 単独の \r は comrak と split('\n') で行の数え方が食い違うので、文書の最初の改行にそろえてから消す (D-061)
    for (source, expected) in [
        ("# R\n- a\r- b\n- c\n", "# R\n- a\n- b\n"),
        ("# R\r\n- a\r- b\r\n- c\r\n", "# R\r\n- a\r\n- b\r\n"),
    ] {
        assert_eq!(node_of(source, 4).ref_text, "c");
        assert_rewritten(
            source,
            &delete_nodes(source, &[(4, "c")]),
            expected,
            (1, "R"),
        );
    }
}

#[test]
fn edit_delete_keeps_crlf() {
    let source = "# R\r\n- a\r\n    - a1\r\n- b\r\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "a")]),
        "# R\r\n- b\r\n",
        (1, "R"),
    );
    // \r だけの行も空行として、重なりを 1 つにする
    let source = "# R\r\n\r\n## A\r\n\r\n段落\r\n\r\n## B\r\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(2, "A")]),
        "# R\r\n\r\n## B\r\n",
        (1, "R"),
    );
}

#[test]
fn edit_delete_keeps_a_crlf_document_without_a_final_newline() {
    // 改行で終わらない CRLF の文書の最後のブロックを消すと、新しい最後の行の末尾に \r が残る。この \r を外し、
    // 改行で終わらない形を保つ (単独の \r を作らない)
    let source = "# R\r\n- a\r\n- b";
    assert_eq!(node_of(source, 3).ref_text, "b");
    let result = delete_nodes(source, &[(3, "b")]);
    assert_rewritten(source, &result, "# R\r\n- a", (1, "R"));
    // 続けて書き換えても line-endings で断られない
    let after = applied(source, &result);
    assert_eq!(renamed(&after, 2, "a", "x"), "# R\r\n- x");
    assert_rewritten(&after, &delete_nodes(&after, &[(2, "a")]), "# R", (1, "R"));
}

#[test]
fn edit_move_an_item_under_a_heading_whose_children_are_items() {
    // 移す先の最後の子として、最後の子の形で書く。配下と詳細が付いてくる
    let source = "# R\n## A\n- x\n## B\n- y\n    > 詳細\n    - y1\n        - y2\n";
    let result = move_node(source, (5, "y"), (2, "A"));
    let expected = "# R\n## A\n- x\n- y\n    > 詳細\n    - y1\n        - y2\n## B\n";
    assert_moved(source, &result, expected, (4, "y"), 2);
    assert_eq!(details_of(expected, 4, "y"), json!("詳細"));
    assert_eq!(node_of(expected, 6).parent, Some(5));
    // 2 行目以降は、元の 1 行目の内容の桁からの相対の字下げを保って新しい内容の桁に合わせる
    let source = "# R\n## A\n- x\n## B\n- y\n    - y1\n        > y1 の詳細\n        - y2\n";
    let result = move_node(source, (6, "y1"), (2, "A"));
    let expected = "# R\n## A\n- x\n- y1\n    > y1 の詳細\n    - y2\n## B\n- y\n";
    assert_moved(source, &result, expected, (4, "y1"), 2);
    assert_eq!(details_of(expected, 4, "y1"), json!("y1 の詳細"));
    assert_eq!(node_of(expected, 5).parent, Some(4));
    // タスクの項目は記号と状態を保つ
    let source = "# R\n## A\n- x\n## B\n- [/] y\n";
    assert_moved(
        source,
        &move_node(source, (5, "y"), (2, "A")),
        "# R\n## A\n- x\n- [/] y\n## B\n",
        (4, "y"),
        2,
    );
}

#[test]
fn edit_move_items_into_items_and_up_to_an_ancestor() {
    // 子のない項目の下へは入れ子の項目 (字下げは入れ子の差の最小。なければ 4)。後ろへも前へも移せる
    let source = "# R\n- a\n- b\n";
    assert_moved(
        source,
        &move_node(source, (2, "a"), (3, "b")),
        "# R\n- b\n    - a\n",
        (3, "a"),
        2,
    );
    assert_moved(
        source,
        &move_node(source, (3, "b"), (2, "a")),
        "# R\n- a\n    - b\n",
        (3, "b"),
        2,
    );
    // 祖先の見出しへ上げる (移す先のブロックの中から切り出す)
    let source = "# R\n## B\n- y\n    - y1\n";
    assert_moved(
        source,
        &move_node(source, (4, "y1"), (2, "B")),
        "# R\n## B\n- y\n- y1\n",
        (4, "y1"),
        2,
    );
    // 深くする: 詳細と子も同じだけ字下げを深くする
    let source = "# R\n- a\n    - a1\n- b\n    > b の詳細\n    - b1\n";
    let expected = "# R\n- a\n    - a1\n        - b\n            > b の詳細\n            - b1\n";
    assert_moved(
        source,
        &move_node(source, (4, "b"), (3, "a1")),
        expected,
        (4, "b"),
        3,
    );
    assert_eq!(details_of(expected, 4, "b"), json!("b の詳細"));
    assert_eq!(node_of(expected, 5).parent, Some(4));
}

#[test]
fn edit_move_numbered_items() {
    // 番号付きのリストへは最後の子の番号 + 1 で、区切りの . と ) を保つ。select の refText は解析し直した値
    let source = "# R\n## A\n1. a\n2. b\n## B\n- y\n";
    assert_moved(
        source,
        &move_node(source, (6, "y"), (2, "A")),
        "# R\n## A\n1. a\n2. b\n3. y\n## B\n",
        (5, "3. y"),
        2,
    );
    let source = "# R\n## A\n1) a\n2) b\n## B\n- y\n";
    assert_moved(
        source,
        &move_node(source, (6, "y"), (2, "A")),
        "# R\n## A\n1) a\n2) b\n3) y\n## B\n",
        (5, "3. y"),
        2,
    );
    // 番号付きの項目は移す先の形で書く (印の違うリストなら `- `)。残った項目の番号は書き直さない
    let source = "# R\n## A\n- x\n## B\n1. a\n2. b\n3. c\n";
    let result = move_node(source, (6, "2. b"), (2, "A"));
    let expected = "# R\n## A\n- x\n- b\n## B\n1. a\n3. c\n";
    assert_moved(source, &result, expected, (4, "b"), 2);
    assert_eq!(node_of(expected, 7).ref_text, "2. c");
    // 子のない項目の下へは入れ子の `- `。字下げは 4 (内容の桁 3 より大きい)
    let source = "# R\n1. a\n2. b\n";
    assert_moved(
        source,
        &move_node(source, (3, "2. b"), (2, "1. a")),
        "# R\n1. a\n    - b\n",
        (3, "b"),
        2,
    );
}

#[test]
fn edit_move_an_item_with_only_details_under_a_heading_writes_heading_details_and_refuses_continuation()
 {
    // 見出しで書くことになる項目 (移す先が子のない見出しか、最後の子が見出しの見出し) が詳細 (引用) だけを持つなら、
    // `### y` (段は付け替えの規則のまま) と見出しの詳細 `> 詳細` に書いて通す (D-078。メインの決定の細部 18)
    let source = "# R\n## A\n## B\n- y\n    > 詳細\n";
    assert_moved(
        source,
        &move_node(source, (4, "y"), (2, "A")),
        "# R\n## A\n\n### y\n> 詳細\n\n## B\n",
        (3, "y"),
        2,
    );
    // markdag キーのある文書では、書いた引用が見出しの詳細に読まれる
    let source = format!("{MD}# R\n## A\n## B\n- y\n    > 詳細\n");
    let expected = format!("{MD}# R\n## A\n\n### y\n> 詳細\n\n## B\n");
    assert_moved(
        &source,
        &move_node(&source, (4, "y"), (2, "A")),
        &expected,
        (3, "y"),
        2,
    );
    assert_eq!(details_of(&expected, 3, "y"), json!("詳細"));
    // 続きの段落を持つ項目は、見出しの下の段落が読まれず図から消えるので、今のまま heading-details で断り、原文を変えない。
    // 続き: 空行のあとの段落と、1 行目に続く行 (1 行目のあと、最初の子の前の行)
    for source in [
        "# R\n## A\n### A1\n## B\n- y\n\n  続き\n",
        "# R\n## A\n### A1\n## B\n- y\n  続き\n",
    ] {
        assert_eq!(node_of(source, 5).ref_text, "y", "{source:?}");
        assert_refused(&move_node(source, (5, "y"), (2, "A")), "heading-details");
    }
}

#[test]
fn edit_move_an_item_without_details_under_a_heading_writes_a_heading() {
    // 詳細も続きもない項目は見出しで書く (段は移す先の段 + 1。前後の行が空でなければ空行をはさむ)
    let source = "# R\n## A\n## B\n- y\n- z\n";
    let expected = "# R\n## A\n\n### y\n\n## B\n- z\n";
    assert_moved(
        source,
        &move_node(source, (4, "y"), (2, "A")),
        expected,
        (3, "y"),
        2,
    );
    assert_eq!(
        inspect(expected, 3, "y").map(|result| result["kind"].clone()),
        Some(json!("heading"))
    );
    let source = "# R\n## A\n### A1\n## B\n- y\n- z\n";
    assert_moved(
        source,
        &move_node(source, (5, "y"), (2, "A")),
        "# R\n## A\n### A1\n\n### y\n\n## B\n- z\n",
        (4, "y"),
        2,
    );
}

#[test]
fn edit_move_a_heading_under_an_item_turns_headings_into_items() {
    // 配下の見出しも入れ子の項目になる
    let source = "# Root\n## A\n- x\n    > 詳細\n- y\n## B\n### C\n";
    let expected = "# Root\n## A\n- x\n    > 詳細\n- y\n    - B\n        - C\n";
    assert_moved(
        source,
        &move_node(source, (5, "B"), (4, "y")),
        expected,
        (5, "B"),
        4,
    );
    assert_eq!(node_of(expected, 6).parent, Some(5));
    // 見出しの配下の段落は項目の続きの行 (項目の内容の桁に字下げ)。空行は空行のまま
    let source = "# R\n## A\n- y\n## B\n\n本文\n\n### C\n\nC の本文\n";
    let expected = "# R\n## A\n- y\n    - B\n\n      本文\n\n        - C\n\n          C の本文\n";
    assert_moved(
        source,
        &move_node(source, (4, "B"), (3, "y")),
        expected,
        (4, "B"),
        3,
    );
    assert_eq!(
        ref_texts(expected),
        vec![
            (1, None, "R".to_string()),
            (2, Some(1), "A".to_string()),
            (3, Some(2), "y".to_string()),
            (4, Some(3), "B".to_string()),
            (5, Some(4), "C".to_string()),
        ]
    );
    // 見出しのすぐ下の引用は項目の詳細になる
    let source = format!("{MD}# R\n## A\n- y\n## B\n> 引用\n");
    let expected = format!("{MD}# R\n## A\n- y\n    - B\n      > 引用\n");
    assert_moved(
        &source,
        &move_node(&source, (4, "B"), (3, "y")),
        &expected,
        (4, "B"),
        3,
    );
    assert_eq!(details_of(&expected, 4, "B"), json!("引用"));
    // 移す先が見出しでも、最後の子が項目ならリストで書く (子の形)
    let source = "# R\n## A\n- x\n## C\n";
    assert_moved(
        source,
        &move_node(source, (4, "C"), (2, "A")),
        "# R\n## A\n- x\n- C\n",
        (4, "C"),
        2,
    );
}

#[test]
fn edit_move_a_heading_under_a_heading_shifts_levels() {
    // 自分の段 = 移す先の段 + 1。配下の見出しは相対の段を保ってずらし、7 段以上になるものはリストの項目 (その配下もリスト)
    let source = "# R\n## P\n### P1\n#### P2\n##### P3\n## Q\n### Q1\n#### Q2\n";
    let expected = "# R\n## Q\n### Q1\n#### Q2\n\n##### P\n###### P1\n- P2\n    - P3\n";
    assert_moved(
        source,
        &move_node(source, (2, "P"), (8, "Q2")),
        expected,
        (5, "P"),
        4,
    );
    assert_eq!(
        ref_texts(expected)[5..],
        [
            (6, Some(5), "P1".to_string()),
            (7, Some(6), "P2".to_string()),
            (8, Some(7), "P3".to_string()),
        ]
    );
    // 段を上げる: 配下の見出しも同じだけ上がり、段落の行はそのまま
    let source = "# R\n## A\n### A1\n#### A11\n本文\n## B\n";
    let expected = "# R\n## A\n## B\n\n## A1\n### A11\n本文\n";
    assert_moved(
        source,
        &move_node(source, (3, "A1"), (1, "R")),
        expected,
        (4, "A1"),
        1,
    );
    assert_eq!(node_of(expected, 5).parent, Some(4));
}

#[test]
fn edit_move_a_setext_heading_writes_an_atx_heading() {
    // 下線の見出しは ATX で書き直し、下線の行を消す。配下の項目はそのまま付いてくる
    let source = "# R\n## A\n設計\n----\n- 画面\n";
    assert_eq!(node_of(source, 3).ref_text, "設計");
    let expected = "# R\n## A\n\n### 設計\n- 画面\n";
    assert_moved(
        source,
        &move_node(source, (3, "設計"), (2, "A")),
        expected,
        (3, "設計"),
        2,
    );
    assert_eq!(node_of(expected, 4).parent, Some(3));
}

// 1 R / 2 A / 3 x / 4 B / 5 C
const MOVES: &str = "# R\n## A\n- x\n## B\n### C\n";

#[test]
fn edit_move_refuses_self_descendants_root_containers_and_blocks() {
    // 自分と配下へは move-into-self
    assert_refused(&move_node(MOVES, (4, "B"), (4, "B")), "move-into-self");
    assert_refused(&move_node(MOVES, (4, "B"), (5, "C")), "move-into-self");
    // ルートは root (配下へ移すことにもなるが、ルートの規則で断る)。行を持たないルートとリストだけの文書のルートも
    assert_refused(&move_node(MOVES, (1, "R"), (3, "x")), "root");
    assert_refused(&move_node(LINELESS, (1, "T"), (2, "a")), "root");
    assert_refused(&move_node(LIST_ROOT, (1, ""), (2, "a")), "root");
    // 容器は no-source-line
    assert_refused(
        &move_node(NESTED_LISTS, (2, ""), (7, "2. d")),
        "no-source-line",
    );
    assert_refused(
        &move_node(NESTED_LISTS, (5, ""), (3, "a")),
        "no-source-line",
    );
    // 表とコードと画像はリストの項目の下へは block-node。表とコードと画像の下へ (子として) も block-node
    for block in [
        "| a | b |\n| - | - |\n| 1 | 2 |",
        "~~~js\nx\n~~~",
        "![img](x.png)",
    ] {
        let source = format!("# R\n## A\n- x\n## B\n\n{block}\n");
        assert_eq!(node_of(&source, 5).parent, Some(4), "{source:?}");
        assert_refused(&move_node(&source, (5, ""), (3, "x")), "block-node");
        assert_refused(&move_node(&source, (3, "x"), (5, "")), "block-node");
    }
}

#[test]
fn edit_move_to_the_current_parent_is_unchanged() {
    // すでにその親の子なら何もしない (最後の子でなくても)
    assert_unchanged(&move_node(MOVES, (3, "x"), (2, "A")), "already-child");
    assert_unchanged(&move_node(MOVES, (5, "C"), (4, "B")), "already-child");
    assert_unchanged(&move_node(MOVES, (2, "A"), (1, "R")), "already-child");
}

#[test]
fn edit_move_refuses_stale_targets_and_rewrites_lone_carriage_returns() {
    // 動かすノードと移す先のどちらが古くても stale-node
    assert_refused(&move_node(MOVES, (3, "y"), (2, "A")), "stale-node");
    assert_refused(&move_node(MOVES, (3, "x"), (99, "A")), "stale-node");
    assert_refused(&move_node(MOVES, (3, "x"), (4, "A")), "stale-node");
    assert_refused(&move_node(MOVES, (0, ""), (2, "A")), "stale-node");
    // 単独の \r は文書の最初の改行にそろえてから動かす (D-061)
    for (source, expected) in [
        ("# R\n- a\r- b\n- c\n", "# R\n- a\n    - c\n- b\n"),
        (
            "# R\r\n- a\r- b\r\n- c\r\n",
            "# R\r\n- a\r\n    - c\r\n- b\r\n",
        ),
    ] {
        assert_moved(
            source,
            &move_node(source, (4, "c"), (2, "a")),
            expected,
            (3, "c"),
            2,
        );
    }
}

#[test]
fn edit_move_indents_with_tabs_in_tab_documents() {
    // タブを使う文書は、書き直す行の字下げを 4 桁ごとのタブと残りの空白で書き、行の中身のタブは変えない。
    // y の新しい字下げは `100. a` の内容の桁 5 (タブ 1 つと空白 1 つ)、詳細は内容の桁 7 + 2 = 9 (タブ 2 つと空白 1 つ)
    let source = "---\nmarkdag:\n---\n- x\n\t- y\n\t\t> 詳細\tタブ\n100. a\n";
    let expected = "---\nmarkdag:\n---\n- x\n100. a\n\t - y\n\t\t > 詳細\tタブ\n";
    assert_moved(
        source,
        &move_node(source, (3, "y"), (4, "100. a")),
        expected,
        (4, "y"),
        3,
    );
    assert_eq!(details_of(expected, 4, "y"), json!("詳細\tタブ"));
}

#[test]
fn edit_move_keeps_crlf_and_the_document_end() {
    // CRLF の文書は書き直す行とはさむ空行に \r を付ける
    let source = "# R\r\n## A\r\n- x\r\n## B\r\n- y\r\n    > 詳細\r\n";
    assert_moved(
        source,
        &move_node(source, (5, "y"), (2, "A")),
        "# R\r\n## A\r\n- x\r\n- y\r\n    > 詳細\r\n## B\r\n",
        (4, "y"),
        2,
    );
    let source = "# R\r\n## A\r\n## B\r\n- y\r\n- z\r\n";
    assert_moved(
        source,
        &move_node(source, (4, "y"), (2, "A")),
        "# R\r\n## A\r\n\r\n### y\r\n\r\n## B\r\n- z\r\n",
        (3, "y"),
        2,
    );
    // 改行で終わらない CRLF の文書の末尾へ移す: 前の最後の行に \r を足し、はさむ空行にも付け、移した最後の行には付けない。
    // 子のない見出し B の下なので、詳細のない項目 x は 1 段下の見出しで書く
    let source = "# R\r\n## A\r\n- x\r\n## B";
    assert_moved(
        source,
        &move_node(source, (3, "x"), (4, "B")),
        "# R\r\n## A\r\n## B\r\n\r\n### x",
        (4, "x"),
        3,
    );
}

#[test]
fn edit_move_the_last_block_of_a_crlf_document_without_a_final_newline() {
    // 改行で終わらない CRLF の文書の最後のブロックを動かすと、新しい最後の行の \r を外し、動かした行には \r を付ける
    // (改行で終わらない形を保つ)
    let source = "# R\r\n## A\r\n- x\r\n## B\r\n- y";
    assert_eq!(node_of(source, 5).ref_text, "y");
    let result = move_node(source, (5, "y"), (2, "A"));
    let expected = "# R\r\n## A\r\n- x\r\n- y\r\n## B";
    assert_moved(source, &result, expected, (4, "y"), 2);
    // 続けて書き換えても line-endings で断られない (最後の行の名前の変更、最後のブロックの削除)
    assert_eq!(
        renamed(expected, 5, "B", "C"),
        "# R\r\n## A\r\n- x\r\n- y\r\n## C"
    );
    assert_rewritten(
        expected,
        &delete_nodes(expected, &[(5, "B")]),
        "# R\r\n## A\r\n- x\r\n- y",
        (1, "R"),
    );
}

#[test]
fn edit_delete_and_move_op_json_has_the_contract_shape() {
    // deleteNodes と moveNode の JSON の形。読めない形は serde が受け付けない (境界では invalid-input)
    for ok in [
        json!({ "kind": "deleteNodes", "nodes": [{ "id": 2, "refText": "a" }, { "id": 3, "refText": "b" }] }),
        json!({ "kind": "moveNode", "node": { "id": 2, "refText": "a" }, "parent": { "id": 1, "refText": "R" } }),
    ] {
        assert!(serde_json::from_value::<EditOp>(ok.clone()).is_ok(), "{ok}");
    }
    for bad in [
        json!({ "kind": "deleteNodes" }),
        json!({ "kind": "deleteNodes", "nodes": { "id": 2, "refText": "a" } }),
        json!({ "kind": "deleteNodes", "nodes": [{ "id": 2 }] }),
        json!({ "kind": "moveNode", "node": { "id": 2, "refText": "a" } }),
        json!({ "kind": "moveNode", "node": { "id": 2, "refText": "a" }, "parent": "R" }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

// ---- 詳細とタグの書き換え (setDetails、setTag、removeTag、toggleTag。詳細と 1 行目の印、markdag: を足す) ----
// 期待の文書は、比べる前に解析し直して詳細 (inspect_node の details と、解析のノードの details の有無) とタグ (解析とモデルの tagsOf) を
// 確かめ、指すノードは操作の前に原文の解析で id と refText を確かめる (期待の書き誤りを、実装の前の赤の確認で見分けるため)

type Target<'a> = (u32, &'a str);

fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(
        node_of(source, id).ref_text,
        ref_text,
        "id {id} のノードの refText: {source:?}"
    );
}

fn targets_json(nodes: &[Target]) -> Vec<Value> {
    nodes
        .iter()
        .map(|(id, ref_text)| json!({ "id": id, "refText": ref_text }))
        .collect()
}

fn set_details_unchecked(source: &str, node: Target, text: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "setDetails", "node": { "id": node.0, "refText": node.1 }, "text": text }),
    )
}

fn set_details(source: &str, node: Target, text: &str) -> Value {
    assert_target(source, node);
    set_details_unchecked(source, node, text)
}

fn set_tag_unchecked(
    source: &str,
    nodes: &[Target],
    key: &str,
    value: Option<&str>,
    replace_key: Option<&str>,
) -> Value {
    edited_by(
        source,
        json!({
            "kind": "setTag",
            "nodes": targets_json(nodes),
            "key": key,
            "value": value,
            "replaceKey": replace_key,
        }),
    )
}

fn set_tag(
    source: &str,
    nodes: &[Target],
    key: &str,
    value: Option<&str>,
    replace_key: Option<&str>,
) -> Value {
    for &node in nodes {
        assert_target(source, node);
    }
    set_tag_unchecked(source, nodes, key, value, replace_key)
}

fn remove_tag_unchecked(source: &str, nodes: &[Target], key: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "removeTag", "nodes": targets_json(nodes), "key": key }),
    )
}

fn remove_tag(source: &str, nodes: &[Target], key: &str) -> Value {
    for &node in nodes {
        assert_target(source, node);
    }
    remove_tag_unchecked(source, nodes, key)
}

fn toggle_tag_unchecked(source: &str, nodes: &[Target], key: &str, value: Option<&str>) -> Value {
    edited_by(
        source,
        json!({ "kind": "toggleTag", "nodes": targets_json(nodes), "key": key, "value": value }),
    )
}

fn toggle_tag(source: &str, nodes: &[Target], key: &str, value: Option<&str>) -> Value {
    for &node in nodes {
        assert_target(source, node);
    }
    toggle_tag_unchecked(source, nodes, key, value)
}

// 期待の文書で、そのノードの詳細がこれ (inspect_node の details。なければ null) で、解析のノードにも詳細があるか (markdag キーのある文書)
fn assert_details_in(source: &str, (id, ref_text): Target, details: Option<&str>) {
    assert_eq!(
        details_of(source, id, ref_text),
        json!(details),
        "{source:?}"
    );
    assert_eq!(
        node_of(source, id).details.is_some(),
        details.is_some(),
        "解析のノードの details: {source:?}"
    );
}

// 期待の文書で、そのノードのタグ ([キー, [値…]] の並び) が解析とモデルの tagsOf の両方でこれで、タグの診断 (tag-) がない
fn assert_tags_in(source: &str, id: u32, tags: Value) {
    let parsed = parse_document(source);
    let node = parsed
        .nodes
        .iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"));
    let read: Vec<Value> = node
        .tags
        .iter()
        .map(|tag| json!([tag.key, tag.values]))
        .collect();
    assert_eq!(Value::Array(read), tags, "解析のタグ: {source:?}");
    let model = markdag_core::model::model::build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &markdag_core::model::model::ModelOptions::default(),
    );
    let modeled: Vec<Value> = model
        .tags_of
        .get(&id)
        .map(|tags| {
            tags.iter()
                .map(|tag| json!([tag.key, tag.values]))
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(Value::Array(modeled), tags, "モデルの tagsOf: {source:?}");
    let issues: Vec<String> = model
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.code.starts_with("tag-"))
        .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
        .collect();
    assert!(issues.is_empty(), "{source:?}: {issues:?}");
}

// 原文の 1 行を差し替えた文書
fn with_line(source: &str, index: usize, text: &str) -> String {
    let mut lines: Vec<&str> = source.split('\n').collect();
    lines[index] = text;
    lines.join("\n")
}

fn nodes_selected(nodes: &[Target]) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": targets_json(nodes) }))
}

// 書き換えた結果: 原文の全体、select が同じノード (書き換えたあとの原文を解析し直した id と refText)、rename は null。
// notes は呼ぶ側が見る
fn assert_nodes_rewritten(source: &str, result: &Value, expected: &str, chosen: &[Target]) {
    let after = applied(source, result);
    assert_eq!(after, expected, "{source:?}: {result}");
    assert_eq!(result["select"], nodes_selected(chosen), "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_select_matches_reparse(source, result);
}

// markdag キーのある文書の書き換え: 上に加えて notes が空
fn assert_same_nodes(source: &str, result: &Value, expected: &str, chosen: &[Target]) {
    assert_nodes_rewritten(source, result, expected, chosen);
    assert_eq!(result["notes"], json!([]), "{result}");
}

// 詳細を書いた結果: 期待の文書の詳細を先に確かめてから、原文の全体と select (markdag キーのある文書なので notes は空)
fn assert_details_set(
    source: &str,
    result: &Value,
    expected: &str,
    chosen: Target,
    details: Option<&str>,
) {
    assert_details_in(expected, chosen, details);
    assert_same_nodes(source, result, expected, &[chosen]);
}

fn note_codes(result: &Value) -> Vec<String> {
    let notes = result["notes"].as_array().expect("notes は配列");
    for note in notes {
        assert!(
            note["message"]
                .as_str()
                .is_some_and(|message| !message.trim().is_empty()),
            "note の message は空でない文: {result}"
        );
    }
    let mut codes: Vec<String> = notes
        .iter()
        .map(|note| note["code"].as_str().expect("code は文字列").to_string())
        .collect();
    codes.sort();
    codes
}

// notes の code がちょうどこれだけ (並びは問わない)
fn assert_notes(result: &Value, expected: &[&str]) {
    let mut expected: Vec<String> = expected.iter().map(|code| code.to_string()).collect();
    expected.sort();
    assert_eq!(note_codes(result), expected, "{result}");
}

// notes にこの code が入る (ほかの code があってもよい)
fn assert_notes_include(result: &Value, expected: &[&str]) {
    let codes = note_codes(result);
    for code in expected {
        assert!(
            codes.iter().any(|item| item == code),
            "{code} がある: {result}"
        );
    }
}

fn note_message(result: &Value, code: &str) -> String {
    result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .find(|note| note["code"] == code)
        .and_then(|note| note["message"].as_str())
        .unwrap_or_else(|| panic!("{code} の note がある: {result}"))
        .to_string()
}

// markdag キーのない文書で、末尾の印に読める名前のノード (API #draft、画面 %ui) が 2 つ。数字だけの #12 は印に読まれない
const UNEXTRACTED: &str = "---\ntitle: T\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n- b\n";
// markdag.tags.keys に、値を 1 つしか持てない priority と、複数の値を持てる owner の定義がある
const TAG_KEYS: &str = "---\nmarkdag:\n    tags:\n        keys:\n            priority:\n                type: enum\n                values: [high, low]\n            owner:\n                type: string\n                multiple: true\n---\n";
const CRLF_MD: &str = "---\r\nmarkdag:\r\n---\r\n";

// ---- 詳細を読み、書き換える ----

#[test]
fn edit_set_details_reads_and_replaces_the_written_details() {
    // 書いてある詳細は字下げと > と続く空白 1 つを外して読む (inspectNode の details)
    let source = format!("{MD}# R\n- a\n    > 古い詳細\n    - c\n- b\n");
    assert_details_in(&source, (2, "a"), Some("古い詳細"));
    // 書いてある引用の行を置き換える
    let expected = format!("{MD}# R\n- a\n    > 新しい詳細\n    - c\n- b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "新しい詳細"),
        &expected,
        (2, "a"),
        Some("新しい詳細"),
    );
    // 複数行は行ごとに > を付け、空の行は > だけにする。Markdown の記法はそのまま書く
    let expected = format!("{MD}# R\n- a\n    > 1 行目\n    >\n    > **3** 行目\n    - c\n- b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "1 行目\n\n**3** 行目"),
        &expected,
        (2, "a"),
        Some("1 行目\n\n**3** 行目"),
    );
    // 複数行の詳細を 1 行に置き換える
    let source = format!("{MD}# R\n- a\n    > 1 行目\n    >\n    > 3 行目\n    - c\n");
    assert_details_in(&source, (2, "a"), Some("1 行目\n\n3 行目"));
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "1 行"),
        &format!("{MD}# R\n- a\n    > 1 行\n    - c\n"),
        (2, "a"),
        Some("1 行"),
    );
    // 1 行目と詳細の間の空行は残し、引用の行だけを置き換える
    let source = format!("{MD}# R\n- a\n\n    > 古い\n    - c\n");
    assert_details_in(&source, (2, "a"), Some("古い"));
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "新しい"),
        &format!("{MD}# R\n- a\n\n    > 新しい\n    - c\n"),
        (2, "a"),
        Some("新しい"),
    );
}

#[test]
fn edit_set_details_splits_the_text_on_every_line_break() {
    // \r\n、\r、\n、U+2028、U+2029 のどれも行の区切り
    let source = format!("{MD}# R\n- a\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "u\r\nv\rw\nx\u{2028}y\u{2029}z"),
        &format!("{MD}# R\n- a\n    > u\n    > v\n    > w\n    > x\n    > y\n    > z\n"),
        (2, "a"),
        Some("u\nv\nw\nx\ny\nz"),
    );
    // \r\n は 1 つの区切り。続けて 2 つ書いた区切りのあいだは空の行 (> だけ)
    let expected = format!("{MD}# R\n- a\n    > x\n    >\n    > y\n");
    for text in ["x\r\n\r\ny", "x\r\ry", "x\u{2028}\u{2029}y"] {
        assert_details_set(
            &source,
            &set_details(&source, (2, "a"), text),
            &expected,
            (2, "a"),
            Some("x\n\ny"),
        );
    }
}

#[test]
fn edit_set_details_with_the_same_text_is_unchanged() {
    // 書く行が今の詳細の行と同じなら変えない (nothing-to-change)
    let source = format!("{MD}# R\n- a\n    > x\n    >\n    > y\n- b\n");
    assert_details_in(&source, (2, "a"), Some("x\n\ny"));
    assert_unchanged(
        &set_details(&source, (2, "a"), "x\n\ny"),
        "nothing-to-change",
    );
    // 改行の種類が違っても同じ行になるなら変えない
    assert_unchanged(
        &set_details(&source, (2, "a"), "x\r\n\r\ny"),
        "nothing-to-change",
    );
    // 詳細のないノードを空にしても変えない
    assert_unchanged(&set_details(&source, (3, "b"), ""), "nothing-to-change");
}

// ---- 詳細を足す位置と外し方 ----

#[test]
fn edit_set_details_adds_after_the_first_line_and_before_the_children() {
    // 詳細がなければ 1 行目のあと、最初の子の前に足す
    let source = format!("{MD}# R\n- a\n    - c\n- b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "d"),
        &format!("{MD}# R\n- a\n    > d\n    - c\n- b\n"),
        (2, "a"),
        Some("d"),
    );
    // 子のない項目は 1 行目のすぐあと
    assert_details_set(
        &source,
        &set_details(&source, (4, "b"), "d"),
        &format!("{MD}# R\n- a\n    - c\n- b\n    > d\n"),
        (4, "b"),
        Some("d"),
    );
    // 入れ子の項目
    let source = format!("{MD}# R\n- a\n    - b\n        - c\n");
    assert_details_set(
        &source,
        &set_details(&source, (3, "b"), "d"),
        &format!("{MD}# R\n- a\n    - b\n        > d\n        - c\n"),
        (3, "b"),
        Some("d"),
    );
    // タスクの記号と末尾の印のある 1 行目は変えない
    let source = format!("{MD}# R\n- [ ] a #k %g $id\n- b\n");
    let expected = format!("{MD}# R\n- [ ] a #k %g $id\n    > d\n- b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "d"),
        &expected,
        (2, "a"),
        Some("d"),
    );
    assert_tags_in(&expected, 2, json!([["k", []]]));
    // 1 行目に続く同じ段落の行のあと
    let source = format!("{MD}# R\n- a\n  続き\n    - c\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "d"),
        &format!("{MD}# R\n- a\n  続き\n    > d\n    - c\n"),
        (2, "a"),
        Some("d"),
    );
    // 1 行目と最初の子の間に空行があっても、1 行目のすぐあと (空行は子の前に残る)
    let source = format!("{MD}# R\n- a\n\n    - c\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "d"),
        &format!("{MD}# R\n- a\n    > d\n\n    - c\n"),
        (2, "a"),
        Some("d"),
    );
    // 改行で終わらない文書の最後の項目に足しても、改行で終わらないまま
    let source = format!("{MD}# R\n- a");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "d"),
        &format!("{MD}# R\n- a\n    > d"),
        (2, "a"),
        Some("d"),
    );
}

#[test]
fn edit_set_details_indents_the_quote_like_a_child_item() {
    // 字下げは子の項目の字下げ: 文書の入れ子の差の最小が 2 なら 2
    let source = format!("{MD}# R\n- x\n  - y\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "x"), "d"),
        &format!("{MD}# R\n- x\n  > d\n  - y\n"),
        (2, "x"),
        Some("d"),
    );
    // 入れ子のない文書は 4。番号付きの `1. ` の内容の桁 (3) より大きい
    let source = format!("{MD}# R\n1. a\n2. b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "1. a"), "d"),
        &format!("{MD}# R\n1. a\n    > d\n2. b\n"),
        (2, "1. a"),
        Some("d"),
    );
    // `100. ` の内容の桁は 5 なので 5
    let source = format!("{MD}# R\n100. a\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "100. a"), "d"),
        &format!("{MD}# R\n100. a\n     > d\n"),
        (2, "100. a"),
        Some("d"),
    );
}

#[test]
fn edit_set_details_with_empty_text_removes_the_quote_lines() {
    // 空にすると引用の行を消す。子と次の項目は残る
    let source = format!("{MD}# R\n- a\n    > x\n    >\n    > y\n    - c\n- b\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), ""),
        &format!("{MD}# R\n- a\n    - c\n- b\n"),
        (2, "a"),
        None,
    );
    // 改行で終わらない文書の最後の詳細を消しても、改行で終わらないまま
    let source = format!("{MD}# R\n- a\n    > x");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), ""),
        &format!("{MD}# R\n- a"),
        (2, "a"),
        None,
    );
}

// ---- 詳細を書けないノード ----

#[test]
fn edit_set_details_writes_headings_and_refuses_containers_and_blocks() {
    // 見出しも詳細を持つ (ルートの見出し、下線の見出し、行頭に空白のある ATX の見出しも)。見出しの行 (下線の見出しは下線の行) の
    // すぐ次に字下げなしの `> ` で書き、すぐ次の行が空でなければ空行を 1 つはさむ (D-040)
    let source = format!("{MD}# R\n## A\n- a\n");
    assert_details_set(
        &source,
        &set_details(&source, (1, "R"), "d"),
        &format!("{MD}# R\n> d\n\n## A\n- a\n"),
        (1, "R"),
        Some("d"),
    );
    assert_details_set(
        &source,
        &set_details(&source, (2, "A"), "d"),
        &format!("{MD}# R\n## A\n> d\n\n- a\n"),
        (2, "A"),
        Some("d"),
    );
    assert_details_set(
        UNMARKABLE,
        &set_details(UNMARKABLE, (2, "設計"), "d"),
        &format!("{MD}# R\n\n設計\n---\n> d\n\n- 画面\n\n ## 実装\n"),
        (2, "設計"),
        Some("d"),
    );
    assert_details_set(
        UNMARKABLE,
        &set_details(UNMARKABLE, (4, "実装"), "d"),
        &format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n> d\n"),
        (4, "実装"),
        Some("d"),
    );
    // markdag キーのない文書の見出しは、項目と同じく markdag: (と frontmatter) を足してから書く
    let source = "# R\n## A\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n## A\n> d\n";
    assert_details_in(expected, (2, "A"), Some("d"));
    let result = set_details(source, (2, "A"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "A")]);
    assert_notes_include(&result, &["frontmatter-added"]);
    // 行を持たないルートと容器は no-source-line
    assert_refused(&set_details(LINELESS, (1, "T"), "d"), "no-source-line");
    assert_refused(
        &set_details(LIST_ROOT_TITLED, (1, "手順"), "d"),
        "no-source-line",
    );
    assert_refused(&set_details(LIST_ROOT, (1, ""), "d"), "no-source-line");
    for id in [2, 5] {
        assert_refused(&set_details(NESTED_LISTS, (id, ""), "d"), "no-source-line");
    }
    // 表とコードと画像は block-node
    for id in [2, 3, 4] {
        assert_refused(&set_details(BLOCKS, (id, ""), "d"), "block-node");
    }
}

#[test]
fn edit_set_details_refuses_stale_targets_and_rewrites_lone_carriage_returns() {
    let source = format!("{MD}# R\n- a\n- b\n");
    assert_refused(&set_details_unchecked(&source, (2, "b"), "d"), "stale-node");
    assert_refused(
        &set_details_unchecked(&source, (99, "a"), "d"),
        "stale-node",
    );
    assert_refused(
        &set_details_unchecked(MARKED, (3, "**太字** と `code`"), "d"),
        "stale-node",
    );
    // 単独の \r は文書の最初の改行にそろえてから書く。markdag キーのない文書なので frontmatter も作る (D-061)
    for (source, expected) in [
        (
            "# R\n- a\r- b\n",
            "---\nmarkdag:\n---\n\n# R\n- a\n    > d\n- b\n",
        ),
        (
            "# R\r\n- a\r- b\r\n",
            "---\r\nmarkdag:\r\n---\r\n\r\n# R\r\n- a\r\n    > d\r\n- b\r\n",
        ),
    ] {
        assert_details_in(expected, (2, "a"), Some("d"));
        let result = set_details(source, (2, "a"), "d");
        assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
        assert_notes_include(&result, &["frontmatter-added"]);
    }
}

// ---- markdag: を足す ----

#[test]
fn edit_set_details_adds_markdag_to_documents_without_the_key() {
    // frontmatter に markdag キーがなければ、最上位の写像の末尾に markdag: を足してから書く (note markdag-added)
    let source = "---\ntitle: T\n---\n# R\n- a\n";
    let expected = "---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n";
    assert_details_in(expected, (2, "a"), Some("d"));
    let result = set_details(source, (2, "a"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes(&result, &["markdag-added"]);
    // 空の frontmatter は、その間に入れる
    let source = "---\n---\n# R\n- a\n";
    let expected = "---\nmarkdag:\n---\n# R\n- a\n    > d\n";
    let result = set_details(source, (2, "a"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes(&result, &["markdag-added"]);
    // frontmatter がなければ作る (もとの 1 行目が空でないので、閉じの --- のあとに空行)
    let source = "# R\n- a\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n- a\n    > d\n";
    assert_details_in(expected, (2, "a"), Some("d"));
    let result = set_details(source, (2, "a"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes_include(&result, &["frontmatter-added"]);
}

#[test]
fn edit_set_details_counts_names_read_differently_after_adding_markdag() {
    // 名前の末尾が印に読めるノード (API #draft と 画面 %ui。数字だけの #12 は読まれない) の数 2 が markdag-added の message に入る。
    // 選ぶのは書き換えたあとの原文のノード (API #draft は名前 API とタグ draft に読まれる)
    let expected =
        "---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft\n    > d\n- 画面 %ui\n- Issue #12\n- b\n";
    assert_details_in(expected, (2, "API"), Some("d"));
    assert_tags_in(expected, 2, json!([["draft", []]]));
    let result = set_details(UNEXTRACTED, (2, "API #draft"), "d");
    assert_nodes_rewritten(UNEXTRACTED, &result, expected, &[(2, "API")]);
    assert_notes(&result, &["markdag-added"]);
    assert!(
        note_message(&result, "markdag-added").contains('2'),
        "{result}"
    );
    // 名前の変わらないノードに書いても同じ数を添える
    let expected =
        "---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n- b\n    > d\n";
    assert_details_in(expected, (5, "b"), Some("d"));
    let result = set_details(UNEXTRACTED, (5, "b"), "d");
    assert_nodes_rewritten(UNEXTRACTED, &result, expected, &[(5, "b")]);
    assert!(
        note_message(&result, "markdag-added").contains('2'),
        "{result}"
    );
}

#[test]
fn edit_set_details_removes_a_bom_before_writing() {
    // frontmatter の開きは文書の先頭の --- でしか読まれないので、BOM を外して作る (note bom-removed)
    let source = "\u{feff}# R\n- a\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n- a\n    > d\n";
    assert_details_in(expected, (2, "a"), Some("d"));
    let result = set_details(source, (2, "a"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes_include(&result, &["bom-removed", "frontmatter-added"]);
    // BOM のすぐあとが --- の行の文書 (BOM のせいで frontmatter が読まれていない) も、BOM を外してその frontmatter に
    // markdag: を足してから書く (note は bom-removed と markdag-added。D-066)
    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n";
    let expected = "---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n";
    assert_details_in(expected, (2, "a"), Some("d"));
    let result = set_details(source, (2, "a"), "d");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes(&result, &["bom-removed", "markdag-added"]);
}

// ---- CRLF とタブ ----

#[test]
fn edit_set_details_keeps_crlf() {
    // 足す行と書き直す行に \r を付け、ほかの行は変えない
    let source = format!("{CRLF_MD}# R\r\n- a\r\n    - c\r\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "x\ny"),
        &format!("{CRLF_MD}# R\r\n- a\r\n    > x\r\n    > y\r\n    - c\r\n"),
        (2, "a"),
        Some("x\ny"),
    );
    let source = format!("{CRLF_MD}# R\r\n- a\r\n    > 古い\r\n- b\r\n");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "新しい"),
        &format!("{CRLF_MD}# R\r\n- a\r\n    > 新しい\r\n- b\r\n"),
        (2, "a"),
        Some("新しい"),
    );
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), ""),
        &format!("{CRLF_MD}# R\r\n- a\r\n- b\r\n"),
        (2, "a"),
        None,
    );
    // 改行で終わらない CRLF の文書: 末尾に足すときは前の最後の行に \r を足し、足した最後の行には付けない。
    // 最後の詳細を消すときは新しい最後の行の \r を外す (単独の \r を作らない)
    let source = format!("{CRLF_MD}# R\r\n- a");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), "x"),
        &format!("{CRLF_MD}# R\r\n- a\r\n    > x"),
        (2, "a"),
        Some("x"),
    );
    let source = format!("{CRLF_MD}# R\r\n- a\r\n    > x");
    assert_details_set(
        &source,
        &set_details(&source, (2, "a"), ""),
        &format!("{CRLF_MD}# R\r\n- a"),
        (2, "a"),
        None,
    );
    // CRLF の frontmatter に markdag: を足す
    let source = "---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n";
    let expected = "---\r\ntitle: T\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n    > x\r\n";
    assert_details_in(expected, (2, "a"), Some("x"));
    let result = set_details(source, (2, "a"), "x");
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes(&result, &["markdag-added"]);
}

#[test]
fn edit_set_details_indents_with_tabs_in_tab_documents() {
    // タブを使う文書は、引用の行の字下げを 4 桁ごとのタブと残りの空白で書く。
    // TABBED: 2 x / 3 y (字下げはタブ。桁 4) / 4「100. a」(内容の桁 5)
    assert_details_set(
        TABBED,
        &set_details(TABBED, (3, "y"), "d"),
        &format!("{MD}- x\n\t- y\n\t\t> d\n100. a\n"),
        (3, "y"),
        Some("d"),
    );
    assert_details_set(
        TABBED,
        &set_details(TABBED, (2, "x"), "d"),
        &format!("{MD}- x\n\t> d\n\t- y\n100. a\n"),
        (2, "x"),
        Some("d"),
    );
    assert_details_set(
        TABBED,
        &set_details(TABBED, (4, "100. a"), "d"),
        &format!("{MD}- x\n\t- y\n100. a\n\t > d\n"),
        (4, "100. a"),
        Some("d"),
    );
    // 詳細の中のタブは字のまま書く。書いてある詳細を置き換える
    let source = format!("{MD}- x\n\t- y\n\t\t> 古い\n100. a\n");
    assert_details_set(
        &source,
        &set_details(&source, (3, "y"), "a\tb"),
        &format!("{MD}- x\n\t- y\n\t\t> a\tb\n100. a\n"),
        (3, "y"),
        Some("a\tb"),
    );
}

// ---- タグを付ける ----

#[test]
fn edit_set_tag_appends_after_the_marks_and_keeps_them() {
    let source = format!("{MD}# R\n- a\n");
    let expected = format!("{MD}# R\n- a #k:v\n");
    assert_tags_in(&expected, 2, json!([["k", ["v"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("v"), None),
        &expected,
        &[(2, "a")],
    );
    // 新しい印は既存の印の並びの末尾に空白 1 つで足し、%、$ の印とタスクの記号は残す
    let source = format!("{MD}# R\n- [ ] a %g $id\n");
    let expected = format!("{MD}# R\n- [ ] a %g $id #k:v\n");
    assert_tags_in(&expected, 2, json!([["k", ["v"]]]));
    let node = node_of(&expected, 2);
    assert_eq!(
        (node.groups, node.ref_id, node.task.is_some()),
        (vec!["g".to_string()], Some("id".to_string()), true)
    );
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("v"), None),
        &expected,
        &[(2, "a")],
    );
    // 見出し (ルートも)、番号付きの項目、字下げがタブの項目
    let source = format!("{MD}# R\n## A %g\n1. b\n\t- c\n");
    // 1 R / 2 A / 3「1. b」/ 4 c (b の子)。原文の行は 3〜6
    let cases: [(Target, usize, &str); 4] = [
        ((1, "R"), 3, "# R #k:v"),
        ((2, "A"), 4, "## A %g #k:v"),
        ((3, "1. b"), 5, "1. b #k:v"),
        ((4, "c"), 6, "\t- c #k:v"),
    ];
    for (node, line, text) in cases {
        let expected = with_line(&source, line, text);
        assert_tags_in(&expected, node.0, json!([["k", ["v"]]]));
        assert_same_nodes(
            &source,
            &set_tag(&source, &[node], "k", Some("v"), None),
            &expected,
            &[node],
        );
    }
    // 数字だけの #12 は名前に残り、そのあとに足す
    let source = format!("{MD}# R\n- Issue #12\n");
    let expected = format!("{MD}# R\n- Issue #12 #k:v\n");
    assert_tags_in(&expected, 2, json!([["k", ["v"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "Issue #12")], "k", Some("v"), None),
        &expected,
        &[(2, "Issue #12")],
    );
}

#[test]
fn edit_set_tag_replaces_the_same_key_in_place() {
    // 同じキーのタグがあれば、その位置で置き換える。ほかの印の並びは変えない
    let source = format!("{MD}# R\n- a #x:1 #k:old %g $id\n");
    let expected = format!("{MD}# R\n- a #x:1 #k:new %g $id\n");
    assert_tags_in(&expected, 2, json!([["x", ["1"]], ["k", ["new"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("new"), None),
        &expected,
        &[(2, "a")],
    );
    // 値のないタグに値を入れる、値のあるタグを値のないタグにする、複数の値を 1 つの値に置き換える
    let cases = [
        ("- a #k %g", Some("v"), "- a #k:v %g", json!([["k", ["v"]]])),
        ("- a #k:v %g", None, "- a #k %g", json!([["k", []]])),
        (
            "- a #k:alice,bob %g",
            Some("carol"),
            "- a #k:carol %g",
            json!([["k", ["carol"]]]),
        ),
    ];
    for (line, value, written, tags) in cases {
        let source = format!("{MD}# R\n{line}\n");
        let expected = format!("{MD}# R\n{written}\n");
        assert_tags_in(&expected, 2, tags);
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], "k", value, None),
            &expected,
            &[(2, "a")],
        );
    }
    // 見出し
    let source = format!("{MD}# R\n## A #k:1\n");
    let expected = format!("{MD}# R\n## A #k:2\n");
    assert_tags_in(&expected, 2, json!([["k", ["2"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "A")], "k", Some("2"), None),
        &expected,
        &[(2, "A")],
    );
}

// ---- タグの書き方とキーの形 ----

#[test]
fn edit_set_tag_writes_values_in_the_tag_format() {
    // 値のないタグは #キー、空白 (タブ、全角の空白も)、`,` を含む値は "…" で囲む (formatTag と同じ)
    let source = format!("{MD}# R\n- a\n");
    let cases = [
        (None, "#flag", json!([["flag", []]])),
        (Some("a b"), "#flag:\"a b\"", json!([["flag", ["a b"]]])),
        (Some("a,b"), "#flag:\"a,b\"", json!([["flag", ["a,b"]]])),
        (Some("a\tb"), "#flag:\"a\tb\"", json!([["flag", ["a\tb"]]])),
        (
            Some("a\u{3000}b"),
            "#flag:\"a\u{3000}b\"",
            json!([["flag", ["a\u{3000}b"]]]),
        ),
        (
            Some("2026-10-01"),
            "#flag:2026-10-01",
            json!([["flag", ["2026-10-01"]]]),
        ),
    ];
    for (value, mark, tags) in cases {
        let expected = format!("{MD}# R\n- a {mark}\n");
        assert_tags_in(&expected, 2, tags);
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], "flag", value, None),
            &expected,
            &[(2, "a")],
        );
    }
}

#[test]
fn edit_set_tag_turns_line_breaks_in_the_value_into_spaces() {
    // 値の改行 (\r\n、\r、\n、U+2028、U+2029) は空白 1 つ。空白を含むので "…" で囲む
    let source = format!("{MD}# R\n- a\n");
    let expected = format!("{MD}# R\n- a #k:\"x y\"\n");
    assert_tags_in(&expected, 2, json!([["k", ["x y"]]]));
    for value in ["x\r\ny", "x\ry", "x\ny", "x\u{2028}y", "x\u{2029}y"] {
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], "k", Some(value), None),
            &expected,
            &[(2, "a")],
        );
    }
    let expected = format!("{MD}# R\n- a #k:\"x y z\"\n");
    assert_tags_in(&expected, 2, json!([["k", ["x y z"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("x\r\ny\rz"), None),
        &expected,
        &[(2, "a")],
    );
}

#[test]
fn edit_set_tag_trims_the_key_and_its_leading_hash() {
    // キーの前後の空白と先頭の # を外す
    let source = format!("{MD}# R\n- a\n");
    let expected = format!("{MD}# R\n- a #k:v\n");
    for key in [" k ", "#k", " #k ", "\tk\t"] {
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], key, Some("v"), None),
            &expected,
            &[(2, "a")],
        );
    }
}

// 前後の空白と先頭の # を 1 つ外したあとに空になるキー (書けないのはこれだけ)
const INVALID_KEYS: [&str; 4] = ["", " ", "#", " # "];

// 空白、:、#、%、$、"、, を含むキーと、書く印 (値 v)。" で囲み、囲みの中の " は \" と逃がす (B-134)
const QUOTED_KEYS: [(&str, &str); 8] = [
    ("a b", r#"#"a b":v"#),
    ("a\tb", "#\"a\tb\":v"),
    ("a:b", r#"#"a:b":v"#),
    ("a#b", r#"#"a#b":v"#),
    ("a%b", r#"#"a%b":v"#),
    ("a$b", r#"#"a$b":v"#),
    ("a\"b", r#"#"a\"b":v"#),
    ("a,b", r#"#"a,b":v"#),
];

#[test]
fn edit_set_tag_and_toggle_tag_refuse_only_empty_keys_and_quote_the_others() {
    // GUI のタグの操作は B-134 で断らない (D-073): 空のキーだけを tag-key-invalid で断り、ほかは " で囲んで書く
    let source = format!("{MD}# R\n- a\n");
    for key in INVALID_KEYS {
        assert_refused(
            &set_tag(&source, &[(2, "a")], key, Some("v"), None),
            "tag-key-invalid",
        );
        assert_refused(
            &toggle_tag(&source, &[(2, "a")], key, Some("v")),
            "tag-key-invalid",
        );
    }
    let expected_tags = |key: &str| json!([[key, ["v"]]]);
    for (key, mark) in QUOTED_KEYS {
        let expected = format!("{MD}# R\n- a {mark}\n");
        assert_tags_in(&expected, 2, expected_tags(key));
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], key, Some("v"), None),
            &expected,
            &[(2, "a")],
        );
        assert_same_nodes(
            &source,
            &toggle_tag(&source, &[(2, "a")], key, Some("v")),
            &expected,
            &[(2, "a")],
        );
    }
}

// ---- キーを変える編集とタグを外す ----

#[test]
fn edit_set_tag_with_a_replace_key_removes_the_old_key() {
    // キーを変える編集は、もとのキーのタグを外す。もとのキーのないノードには新しいキーを足すだけ
    let source = format!("{MD}# R\n- a %g #old:v\n- b\n");
    let expected = format!("{MD}# R\n- a %g #new:v\n- b #new:v\n");
    assert_tags_in(&expected, 2, json!([["new", ["v"]]]));
    assert_tags_in(&expected, 3, json!([["new", ["v"]]]));
    let result = set_tag(
        &source,
        &[(2, "a"), (3, "b")],
        "new",
        Some("v"),
        Some("old"),
    );
    assert_same_nodes(&source, &result, &expected, &[(2, "a"), (3, "b")]);
    assert_splices_ordered(&result);
    // 値だけを変える編集 (replaceKey が同じキー) は、その位置で値を置き換える
    let source = format!("{MD}# R\n- a #k:1 %g\n");
    let expected = format!("{MD}# R\n- a #k:2 %g\n");
    assert_tags_in(&expected, 2, json!([["k", ["2"]]]));
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("2"), Some("k")),
        &expected,
        &[(2, "a")],
    );
}

#[test]
fn edit_remove_tag_removes_the_key_from_the_selected_nodes() {
    // そのキーのタグを選んだノードから外す。ほかの印は空白 1 つの並びのまま残る
    let source = format!("{MD}# R\n- a #x:1 #k:v %g $id\n- b #k\n- c\n");
    let expected = format!("{MD}# R\n- a #x:1 %g $id\n- b\n- c\n");
    assert_tags_in(&expected, 2, json!([["x", ["1"]]]));
    assert_tags_in(&expected, 3, json!([]));
    let nodes = [(2, "a"), (3, "b"), (4, "c")];
    let result = remove_tag(&source, &nodes, "k");
    assert_same_nodes(&source, &result, &expected, &nodes);
    assert_splices_ordered(&result);
    // 複数の値を持つタグはキーごと外す。最後の印を外しても行末に空白を残さない
    let cases = [
        ("- a #owner:alice,bob %g", "- a %g"),
        ("- a %g #owner:alice", "- a %g"),
        ("- [x] a #owner", "- [x] a"),
    ];
    for (line, written) in cases {
        let source = format!("{MD}# R\n{line}\n");
        assert_same_nodes(
            &source,
            &remove_tag(&source, &[(2, "a")], "owner"),
            &format!("{MD}# R\n{written}\n"),
            &[(2, "a")],
        );
    }
    // 見出し
    let source = format!("{MD}# R\n## A #k:v\n");
    assert_same_nodes(
        &source,
        &remove_tag(&source, &[(2, "A")], "k"),
        &format!("{MD}# R\n## A\n"),
        &[(2, "A")],
    );
}

#[test]
fn edit_remove_tag_without_the_key_is_unchanged() {
    // どのノードにもそのキーがなければ変えない (nothing-to-change)
    let source = format!("{MD}# R\n- a #x:1\n- b\n");
    assert_unchanged(
        &remove_tag(&source, &[(2, "a"), (3, "b")], "k"),
        "nothing-to-change",
    );
    // markdag キーのない文書は印を読まないので、末尾の #k はタグでなく名前の一部
    assert_unchanged(
        &remove_tag("# R\n- a #k\n", &[(2, "a #k")], "k"),
        "nothing-to-change",
    );
}

// ---- 一覧での付け外し ----

#[test]
fn edit_toggle_tag_adds_unless_every_node_has_it() {
    // どのノードにもなければ全部に付ける
    let source = format!("{MD}# R\n- a\n- b\n");
    let nodes = [(2, "a"), (3, "b")];
    let expected = format!("{MD}# R\n- a #k:v\n- b #k:v\n");
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "k", Some("v")),
        &expected,
        &nodes,
    );
    // 一部のノードにだけあれば、ないノードに足す (あるノードは変えない)
    let source = format!("{MD}# R\n- a #k:v %g\n- b\n");
    let expected = format!("{MD}# R\n- a #k:v %g\n- b #k:v\n");
    assert_tags_in(&expected, 3, json!([["k", ["v"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "k", Some("v")),
        &expected,
        &nodes,
    );
    // 全部にあれば全部から外す
    let source = format!("{MD}# R\n- a #k:v %g\n- b #x:1 #k:v\n");
    let expected = format!("{MD}# R\n- a %g\n- b #x:1\n");
    assert_tags_in(&expected, 2, json!([]));
    assert_tags_in(&expected, 3, json!([["x", ["1"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "k", Some("v")),
        &expected,
        &nodes,
    );
    // 値のないタグ
    let source = format!("{MD}# R\n- a #done\n- b\n");
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "done", None),
        &format!("{MD}# R\n- a #done\n- b #done\n"),
        &nodes,
    );
    let source = format!("{MD}# R\n- a #done\n- b #done\n");
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "done", None),
        &format!("{MD}# R\n- a\n- b\n"),
        &nodes,
    );
    // 空白を含む値は "…" で書く
    let source = format!("{MD}# R\n- a\n");
    let expected = format!("{MD}# R\n- a #k:\"x y\"\n");
    assert_tags_in(&expected, 2, json!([["k", ["x y"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &[(2, "a")], "k", Some("x y")),
        &expected,
        &[(2, "a")],
    );
}

#[test]
fn edit_toggle_tag_adds_a_value_to_keys_that_take_many_values() {
    // 同じキーに別の値があるとき、キーの定義がなければ , で値を足す (その位置で)
    let source = format!("{MD}# R\n- a #owner:alice %g\n");
    let expected = format!("{MD}# R\n- a #owner:alice,bob %g\n");
    assert_tags_in(&expected, 2, json!([["owner", ["alice", "bob"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &[(2, "a")], "owner", Some("bob")),
        &expected,
        &[(2, "a")],
    );
    // multiple: true の定義があるキーも足す。markdag.tags.keys に定義のないキー (reviewer) も足す
    for key in ["owner", "reviewer"] {
        let source = format!("{TAG_KEYS}# R\n- a #{key}:alice\n");
        let expected = format!("{TAG_KEYS}# R\n- a #{key}:alice,bob\n");
        assert_tags_in(&expected, 2, json!([[key, ["alice", "bob"]]]));
        assert_same_nodes(
            &source,
            &toggle_tag(&source, &[(2, "a")], key, Some("bob")),
            &expected,
            &[(2, "a")],
        );
    }
    // 定義があって multiple: true でないキーは置き換える (tag-multiple にならない)
    let source = format!("{TAG_KEYS}# R\n- a #priority:high %g\n");
    let expected = format!("{TAG_KEYS}# R\n- a #priority:low %g\n");
    assert_tags_in(&expected, 2, json!([["priority", ["low"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &[(2, "a")], "priority", Some("low")),
        &expected,
        &[(2, "a")],
    );
    // 一部のノードにだけその値があるときは、ないノードに足す (もうあるノードは変えない)
    let source = format!("{MD}# R\n- a #owner:alice,bob\n- b #owner:carol\n");
    let expected = format!("{MD}# R\n- a #owner:alice,bob\n- b #owner:carol,alice\n");
    assert_tags_in(&expected, 3, json!([["owner", ["carol", "alice"]]]));
    let nodes = [(2, "a"), (3, "b")];
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "owner", Some("alice")),
        &expected,
        &nodes,
    );
    let source = format!("{TAG_KEYS}# R\n- a #priority:low\n- b #priority:high\n");
    let expected = format!("{TAG_KEYS}# R\n- a #priority:low\n- b #priority:low\n");
    assert_tags_in(&expected, 3, json!([["priority", ["low"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "priority", Some("low")),
        &expected,
        &nodes,
    );
}

#[test]
fn edit_toggle_tag_removes_only_that_value_when_others_remain() {
    // 全部にその値があれば外す。値がほかにもあればその値だけ、なくなればキーごと外す
    let source = format!("{MD}# R\n- a #owner:alice,bob %g\n- b #owner:alice\n");
    let expected = format!("{MD}# R\n- a #owner:bob %g\n- b\n");
    assert_tags_in(&expected, 2, json!([["owner", ["bob"]]]));
    assert_tags_in(&expected, 3, json!([]));
    let nodes = [(2, "a"), (3, "b")];
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "owner", Some("alice")),
        &expected,
        &nodes,
    );
    // 真ん中の値
    let source = format!("{MD}# R\n- a #owner:alice,bob,carol\n");
    let expected = format!("{MD}# R\n- a #owner:alice,carol\n");
    assert_tags_in(&expected, 2, json!([["owner", ["alice", "carol"]]]));
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &[(2, "a")], "owner", Some("bob")),
        &expected,
        &[(2, "a")],
    );
}

// ---- 複数のノードと、印を書けないノード ----

#[test]
fn edit_tag_ops_change_many_nodes_at_once_and_select_them() {
    // 選んだノードの全部に 1 回の書き換えで付け、select は同じノード
    let source = format!("{MD}# R\n## A\n- [ ] a %g\n- b\n");
    let nodes = [(1, "R"), (2, "A"), (3, "a"), (4, "b")];
    let expected = format!("{MD}# R #k:v\n## A #k:v\n- [ ] a %g #k:v\n- b #k:v\n");
    for (id, _) in nodes {
        assert_tags_in(&expected, id, json!([["k", ["v"]]]));
    }
    let result = set_tag(&source, &nodes, "k", Some("v"), None);
    assert_same_nodes(&source, &result, &expected, &nodes);
    assert_splices_ordered(&result);
    // 外す、付け外しも同じ
    let result = remove_tag(&expected, &nodes, "k");
    assert_same_nodes(&expected, &result, &source, &nodes);
    assert_splices_ordered(&result);
    let result = toggle_tag(&expected, &nodes, "k", Some("v"));
    assert_same_nodes(&expected, &result, &source, &nodes);
    assert_splices_ordered(&result);
}

#[test]
fn edit_tag_ops_rewrite_setext_and_indented_headings_and_refuse_lineless_nodes_and_blocks() {
    // 下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから印を書く (ほかのノードと 1 回で)。
    // removeTag は見出しに印を書かない (下線の見出しと行頭に空白のある見出しは印を読まないので、外すタグもない) ので見出しを書き直さない (D-045)
    let tagged = format!("{MD}# R\n\n設計\n---\n\n- 画面 #k\n\n ## 実装\n");
    for (nodes, expected) in [
        (
            [(2, "設計"), (3, "画面")],
            format!("{MD}# R\n\n## 設計 #k:v\n\n- 画面 #k:v\n\n ## 実装\n"),
        ),
        (
            [(3, "画面"), (4, "実装")],
            format!("{MD}# R\n\n設計\n---\n\n- 画面 #k:v\n\n## 実装 #k:v\n"),
        ),
    ] {
        for (id, _) in nodes {
            assert_tags_in(&expected, id, json!([["k", ["v"]]]));
        }
        assert_eq!(ref_texts(&expected), ref_texts(UNMARKABLE), "{expected:?}");
        assert_same_nodes(
            UNMARKABLE,
            &set_tag(UNMARKABLE, &nodes, "k", Some("v"), None),
            &expected,
            &nodes,
        );
        assert_same_nodes(
            UNMARKABLE,
            &toggle_tag(UNMARKABLE, &nodes, "k", Some("v")),
            &expected,
            &nodes,
        );
        assert_same_nodes(
            &tagged,
            &remove_tag(&tagged, &nodes, "k"),
            &format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n"),
            &nodes,
        );
    }
    // 行を持たないルートと容器は no-source-line (容器と 1 行目が同じ最初の項目は避けて、2 つ目の項目と一緒に選ぶ)
    let lineless = "---\ntitle: T\nmarkdag:\n---\n- a #k\n\n1. b\n";
    let list_root = "---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装 #k\n";
    let nested = format!("{MD}# R\n\n- a\n- b #k\n\n1. c\n2. d #k\n");
    let cases: [(&str, [Target; 2]); 4] = [
        (lineless, [(2, "a"), (1, "T")]),
        (list_root, [(3, "実装"), (1, "手順")]),
        (&nested, [(4, "b"), (2, "")]),
        (&nested, [(7, "2. d"), (5, "")]),
    ];
    for (source, nodes) in cases {
        assert_refused(
            &set_tag(source, &nodes, "k", Some("v"), None),
            "no-source-line",
        );
        assert_refused(
            &toggle_tag(source, &nodes, "k", Some("v")),
            "no-source-line",
        );
        assert_refused(&remove_tag(source, &nodes, "k"), "no-source-line");
    }
    // 表とコードと画像は block-node
    let source = format!(
        "{MD}# R #k\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nx\n~~~\n\n![img](x.png)\n"
    );
    for id in [2, 3, 4] {
        let nodes = [(1, "R"), (id, "")];
        assert_refused(
            &set_tag(&source, &nodes, "k", Some("v"), None),
            "block-node",
        );
        assert_refused(&toggle_tag(&source, &nodes, "k", Some("v")), "block-node");
        assert_refused(&remove_tag(&source, &nodes, "k"), "block-node");
    }
}

#[test]
fn edit_tag_ops_refuse_stale_targets_and_rewrite_lone_carriage_returns() {
    // どれか 1 つでも古い NodeTarget なら stale-node
    let source = format!("{MD}# R\n- a #k\n- b\n");
    for nodes in [vec![(2, "b")], vec![(99, "a")], vec![(2, "a"), (3, "x")]] {
        assert_refused(
            &set_tag_unchecked(&source, &nodes, "k", Some("v"), None),
            "stale-node",
        );
        assert_refused(&remove_tag_unchecked(&source, &nodes, "k"), "stale-node");
        assert_refused(
            &toggle_tag_unchecked(&source, &nodes, "k", Some("v")),
            "stale-node",
        );
    }
    // 単独の \r は文書の最初の改行にそろえてから書く (D-061)
    for (source, head, nl) in [
        (format!("{MD}# R\n- a #k\n- b\r- c\n"), MD, "\n"),
        (
            format!("{CRLF_MD}# R\r\n- a #k\r\n- b\r- c\r\n"),
            CRLF_MD,
            "\r\n",
        ),
    ] {
        assert_eq!(node_of(&source, 2).ref_text, "a", "{source:?}");
        let doc = |a: &str| format!("{head}# R{nl}{a}{nl}- b{nl}- c{nl}");
        assert_same_nodes(
            &source,
            &set_tag(&source, &[(2, "a")], "k", Some("v"), None),
            &doc("- a #k:v"),
            &[(2, "a")],
        );
        assert_same_nodes(
            &source,
            &remove_tag(&source, &[(2, "a")], "k"),
            &doc("- a"),
            &[(2, "a")],
        );
        assert_same_nodes(
            &source,
            &toggle_tag(&source, &[(2, "a")], "k", Some("v")),
            &doc("- a #k:v"),
            &[(2, "a")],
        );
    }
}

// ---- タグの markdag: を足す ----

#[test]
fn edit_tag_ops_add_markdag_to_documents_without_the_key() {
    // markdag キーのない frontmatter には markdag: を足してから付ける (note markdag-added)
    let source = "---\ntitle: T\n---\n# R\n- a\n";
    let expected = "---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n";
    assert_tags_in(expected, 2, json!([["k", ["v"]]]));
    for result in [
        set_tag(source, &[(2, "a")], "k", Some("v"), None),
        toggle_tag(source, &[(2, "a")], "k", Some("v")),
    ] {
        assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
        assert_notes(&result, &["markdag-added"]);
    }
    // frontmatter がなければ作る (frontmatter-added)
    let source = "# R\n- a\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n- a #k:v\n";
    assert_tags_in(expected, 2, json!([["k", ["v"]]]));
    for result in [
        set_tag(source, &[(2, "a")], "k", Some("v"), None),
        toggle_tag(source, &[(2, "a")], "k", Some("v")),
    ] {
        assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
        assert_notes_include(&result, &["frontmatter-added"]);
    }
}

#[test]
fn edit_tag_ops_count_names_read_differently_after_adding_markdag() {
    // markdag: を足すと API #draft は名前 API とタグ draft に読まれ、そのあとに足す。読み方が変わるノードの数 2 を message に添える
    let expected =
        "---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft #owner:me\n- 画面 %ui\n- Issue #12\n- b\n";
    assert_tags_in(expected, 2, json!([["draft", []], ["owner", ["me"]]]));
    for result in [
        set_tag(UNEXTRACTED, &[(2, "API #draft")], "owner", Some("me"), None),
        toggle_tag(UNEXTRACTED, &[(2, "API #draft")], "owner", Some("me")),
    ] {
        assert_nodes_rewritten(UNEXTRACTED, &result, expected, &[(2, "API")]);
        assert_notes(&result, &["markdag-added"]);
        assert!(
            note_message(&result, "markdag-added").contains('2'),
            "{result}"
        );
    }
}

#[test]
fn edit_tag_ops_remove_a_bom_before_writing() {
    let source = "\u{feff}# R\n- a\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n- a #k:v\n";
    assert_tags_in(expected, 2, json!([["k", ["v"]]]));
    for result in [
        set_tag(source, &[(2, "a")], "k", Some("v"), None),
        toggle_tag(source, &[(2, "a")], "k", Some("v")),
    ] {
        assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
        assert_notes_include(&result, &["bom-removed", "frontmatter-added"]);
    }
    // BOM のすぐあとが --- の行の文書も、BOM を外してその frontmatter に markdag: を足してから付ける (D-066)
    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n";
    let expected = "---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n";
    assert_tags_in(expected, 2, json!([["k", ["v"]]]));
    for result in [
        set_tag(source, &[(2, "a")], "k", Some("v"), None),
        toggle_tag(source, &[(2, "a")], "k", Some("v")),
    ] {
        assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
        assert_notes(&result, &["bom-removed", "markdag-added"]);
    }
}

#[test]
fn edit_tag_ops_keep_crlf() {
    // 書き換えた 1 行目の行末の \r を残し、ほかの行は変えない
    let source = format!("{CRLF_MD}# R\r\n- a %g\r\n- b #k:v\r\n");
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("x\r\ny"), None),
        &format!("{CRLF_MD}# R\r\n- a %g #k:\"x y\"\r\n- b #k:v\r\n"),
        &[(2, "a")],
    );
    assert_same_nodes(
        &source,
        &remove_tag(&source, &[(3, "b")], "k"),
        &format!("{CRLF_MD}# R\r\n- a %g\r\n- b\r\n"),
        &[(3, "b")],
    );
    let nodes = [(2, "a"), (3, "b")];
    assert_same_nodes(
        &source,
        &toggle_tag(&source, &nodes, "k", Some("v")),
        &format!("{CRLF_MD}# R\r\n- a %g #k:v\r\n- b #k:v\r\n"),
        &nodes,
    );
    // 改行で終わらない文書の最後の行には \r を付けない
    let source = format!("{CRLF_MD}# R\r\n- a");
    assert_same_nodes(
        &source,
        &set_tag(&source, &[(2, "a")], "k", Some("v"), None),
        &format!("{CRLF_MD}# R\r\n- a #k:v"),
        &[(2, "a")],
    );
    // CRLF の frontmatter に markdag: を足す
    let source = "---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n";
    let expected = "---\r\ntitle: T\r\nmarkdag:\r\n---\r\n# R\r\n- a #k:v\r\n";
    assert_tags_in(expected, 2, json!([["k", ["v"]]]));
    let result = set_tag(source, &[(2, "a")], "k", Some("v"), None);
    assert_nodes_rewritten(source, &result, expected, &[(2, "a")]);
    assert_notes(&result, &["markdag-added"]);
}

// ---- JSON の形 ----

#[test]
fn edit_details_and_tag_op_json_has_the_contract_shape() {
    // setDetails、setTag、removeTag、toggleTag の JSON の形。読めない形は serde が受け付けない (境界では invalid-input)
    for ok in [
        json!({ "kind": "setDetails", "node": { "id": 2, "refText": "a" }, "text": "d" }),
        json!({ "kind": "setTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": "v", "replaceKey": null }),
        json!({ "kind": "setTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": null, "replaceKey": "old" }),
        json!({ "kind": "removeTag", "nodes": [{ "id": 2, "refText": "a" }, { "id": 3, "refText": "b" }], "key": "k" }),
        json!({ "kind": "toggleTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": null }),
    ] {
        assert!(serde_json::from_value::<EditOp>(ok.clone()).is_ok(), "{ok}");
    }
    for bad in [
        json!({ "kind": "setDetails", "node": { "id": 2, "refText": "a" } }),
        json!({ "kind": "setDetails", "node": { "id": 2, "refText": "a" }, "text": 1 }),
        json!({ "kind": "setDetails", "nodes": [{ "id": 2, "refText": "a" }], "text": "d" }),
        json!({ "kind": "setTag", "nodes": { "id": 2, "refText": "a" }, "key": "k", "value": "v", "replaceKey": null }),
        json!({ "kind": "setTag", "nodes": [{ "id": 2, "refText": "a" }], "value": "v", "replaceKey": null }),
        json!({ "kind": "setTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": 1, "replaceKey": null }),
        json!({ "kind": "setTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": "v", "replaceKey": 1 }),
        json!({ "kind": "removeTag", "nodes": [{ "id": 2 }], "key": "k" }),
        json!({ "kind": "removeTag", "nodes": [{ "id": 2, "refText": "a" }], "key": 1 }),
        json!({ "kind": "toggleTag", "nodes": [{ "id": 2, "refText": "a" }], "value": "v" }),
        json!({ "kind": "toggleTag", "nodes": [{ "id": 2, "refText": "a" }], "key": "k", "value": true }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

// ---- 名前の入力の初めの値から、markdag が足す \ を外す ----
// 名前の入力を開き直したときの初めの値 (inspect_node の label) には、名前の変更で markdag が足す \ (末尾の印に化ける語、ブロックに化ける書き始め、
// タスクの記号に化ける書き始め、見出しの閉じの記号) を出さない。その値のまま決めても原文は変わらない (二重に逃がさない)。
// 原文に人が書いた \ のうち、markdag が足すのと同じ所のものも同じ扱い。markdag が足さない所の \ (行の途中の \# など) は入力欄に
// そのまま出す。そちらは、その値のまま決めても図の名前が変わらないことを見る

// 依頼者の言葉の例と、項目で逃がす種類ごとの名前 (ITEM_ESCAPES の名前を全部)
fn item_names_escaped_by_rename() -> Vec<&'static str> {
    let mut names = vec!["設計 #a", "C# と F# の比較 #draft", "1. はじめに"];
    names.extend(ITEM_ESCAPES.iter().map(|(label, _)| *label));
    names
}

// 見出しで逃がす種類ごとの名前 (閉じの記号、印、ブロックの書き始め)
const HEADING_NAMES_ESCAPED_BY_RENAME: &[&str] = &[
    "設計 #a",
    "Issue #",
    "a ##",
    "#todo",
    "Issue #frontend",
    "# x",
    "1. はじめに",
    "- x",
];

fn label_of(source: &str, id: u32, ref_text: &str) -> Value {
    inspect(source, id, ref_text)
        .unwrap_or_else(|| panic!("id {id} の「{ref_text}」がある: {source:?}"))["label"]
        .clone()
}

#[test]
fn edit_inspect_node_label_has_no_escapes_added_by_renaming_items() {
    // markdag キーのある文書とない文書 (逃がしは markdag キーの有無によらない)
    for prefix in [MD, ""] {
        let source = format!("{prefix}# R\n- a\n- b\n");
        let line = prefix.matches('\n').count() + 1;
        for name in item_names_escaped_by_rename() {
            let after = renamed(&source, 2, "a", name);
            // markdag が \ を足した例であること
            assert!(line_of(&after, line).contains('\\'), "{name:?}: {after:?}");
            assert_eq!(node_of(&after, 2).ref_text, name, "{after:?}");
            assert_eq!(label_of(&after, 2, name), json!(name), "{after:?}");
        }
    }
}

#[test]
fn edit_inspect_node_label_has_no_escapes_added_by_renaming_headings() {
    for prefix in [MD, ""] {
        let source = format!("{prefix}# R\n## h\n");
        let line = prefix.matches('\n').count() + 1;
        for name in HEADING_NAMES_ESCAPED_BY_RENAME {
            let after = renamed(&source, 2, "h", name);
            assert!(line_of(&after, line).contains('\\'), "{name:?}: {after:?}");
            assert_eq!(label_of(&after, 2, name), json!(name), "{after:?}");
        }
        // ルートの見出しも同じ
        let after = renamed(&source, 1, "R", "Issue #");
        assert_eq!(
            label_of(&after, 1, "Issue #"),
            json!("Issue #"),
            "{after:?}"
        );
    }
}

#[test]
fn edit_inspect_node_label_has_no_escapes_added_on_task_numbered_crlf_and_added_lines() {
    // タスクの記号と末尾の印のある項目: label は記号と印を除き、足した \ も出さない
    let source = format!("{MD}# R\n- [ ] a #k\n");
    let after = renamed(&source, 2, "a", "#todo");
    assert_eq!(line_of(&after, 4), r"- [ ] \#todo #k");
    assert_eq!(label_of(&after, 2, "#todo"), json!("#todo"));

    // 番号付きの項目: label は頭の番号を除いた名前 (refText は頭の番号を含む)
    let source = format!("{MD}# R\n1. a\n2. b\n");
    let after = renamed(&source, 2, "1. a", "1. はじめに");
    assert_eq!(line_of(&after, 4), r"1. 1\. はじめに");
    let ref_text = node_of(&after, 2).ref_text;
    assert_eq!(label_of(&after, 2, &ref_text), json!("1. はじめに"));

    // CRLF の文書: label に \ も \r も入らない
    let source = "# R\r\n- a\r\n";
    let after = renamed(source, 2, "a", "設計 #a");
    assert_eq!(after, "# R\r\n- 設計 \\#a\r\n");
    assert_eq!(label_of(&after, 2, "設計 #a"), json!("設計 #a"));

    // 足す操作の仮の名前に足した \ も、開き直した値には出さない
    let source = format!("{MD}# R\n- a\n");
    let after = applied(&source, &add_child(&source, 2, "a", "#todo"));
    assert_eq!(after, format!("{MD}# R\n- a\n    - \\#todo\n"));
    assert_eq!(label_of(&after, 3, "#todo"), json!("#todo"));
}

// 原文に人が書いた \ のうち、markdag が名前の変更で足すのと同じ所のもの: (原文、id、refText (= 入力欄に出す値))
const HAND_WRITTEN_SAME_PLACE: &[(&str, u32, &str)] = &[
    ("---\nmarkdag:\n---\n# R\n- 設計 \\#a\n", 2, "設計 #a"),
    ("# R\n- 設計 \\#a\n", 2, "設計 #a"),
    (
        "---\nmarkdag:\n---\n# R\n- C# と F# の比較 \\#draft\n",
        2,
        "C# と F# の比較 #draft",
    ),
    ("---\nmarkdag:\n---\n# R\n- \\#todo #k\n", 2, "#todo"),
    ("---\nmarkdag:\n---\n# R\n- [ ] \\#todo\n", 2, "#todo"),
    ("---\nmarkdag:\n---\n# R\n- \\%g\n", 2, "%g"),
    ("---\nmarkdag:\n---\n# R\n- \\$id\n", 2, "$id"),
    (
        "---\nmarkdag:\n---\n# R\n- 1\\. はじめに\n",
        2,
        "1. はじめに",
    ),
    ("---\nmarkdag:\n---\n# R\n- \\# x\n", 2, "# x"),
    ("---\nmarkdag:\n---\n# R\n- \\> x\n", 2, "> x"),
    ("---\nmarkdag:\n---\n# R\n- \\[ ] x\n", 2, "[ ] x"),
    ("---\nmarkdag:\n---\n# R\n## Issue \\#\n", 2, "Issue #"),
    (
        "---\nmarkdag:\n---\n# R\n## 1\\. はじめに\n",
        2,
        "1. はじめに",
    ),
    (
        "---\r\nmarkdag:\r\n---\r\n# R\r\n- 設計 \\#a\r\n",
        2,
        "設計 #a",
    ),
];

#[test]
fn edit_inspect_node_label_has_no_hand_written_escapes_where_rename_would_add_them() {
    for (source, id, name) in HAND_WRITTEN_SAME_PLACE {
        assert_eq!(node_of(source, *id).ref_text, *name, "{source:?}");
        assert_eq!(label_of(source, *id, name), json!(name), "{source:?}");
    }
}

#[test]
fn edit_rename_with_the_reopened_label_is_unchanged() {
    // 開き直した値のまま決めても原文は変わらない (二重に逃がさない)。markdag が足した \ と、人が同じ所に書いた \
    let mut cases: Vec<(String, u32, String)> = Vec::new();
    for prefix in [MD, ""] {
        let items = format!("{prefix}# R\n- a\n- b\n");
        for name in item_names_escaped_by_rename() {
            cases.push((renamed(&items, 2, "a", name), 2, name.to_string()));
        }
        let headings = format!("{prefix}# R\n## h\n");
        for name in HEADING_NAMES_ESCAPED_BY_RENAME {
            cases.push((renamed(&headings, 2, "h", name), 2, name.to_string()));
        }
    }
    for (source, id, name) in HAND_WRITTEN_SAME_PLACE {
        cases.push((source.to_string(), *id, name.to_string()));
    }
    for (source, id, ref_text) in cases {
        let label = label_of(&source, id, &ref_text);
        let label = label.as_str().expect("label は文字列");
        assert_unchanged(&rename(&source, id, &ref_text, label), "same-name");
        // 図の名前 (refText) で決めても同じ
        assert_unchanged(&rename(&source, id, &ref_text, &ref_text), "same-name");
    }
}

#[test]
fn edit_rename_with_the_reopened_label_keeps_the_name_for_other_backslashes() {
    // markdag が足さない所の \ (行の途中の \#、強調の記号の \*) と Markdown の記法: 入力欄にはそのまま出し、
    // 開き直した値のまま決めても図の名前 (refText) と印は変わらない
    let sources: &[(&str, &str)] = &[
        (
            "---\nmarkdag:\n---\n# R\n- 設計 \\#a の説明\n",
            "設計 #a の説明",
        ),
        ("---\nmarkdag:\n---\n# R\n- a \\* b #k\n", "a * b"),
        ("---\nmarkdag:\n---\n# R\n- \\*\\*x\\*\\*\n", "**x**"),
        (
            "---\nmarkdag:\n---\n# R\n- C\\# と F\\# の比較 \\#draft\n",
            "C# と F# の比較 #draft",
        ),
        (
            "---\nmarkdag:\n---\n# R\n- **太字** と `code` %g\n",
            "太字 と code",
        ),
    ];
    for (source, ref_text) in sources {
        let before = node_of(source, 2);
        assert_eq!(before.ref_text, *ref_text, "{source:?}");
        let label = label_of(source, 2, ref_text);
        let label = label.as_str().expect("label は文字列");
        let result = rename(source, 2, ref_text, label);
        if result["status"] == "unchanged" {
            assert_unchanged(&result, "same-name");
            continue;
        }
        let after = applied(source, &result);
        let node = node_of(&after, 2);
        assert_eq!(node.ref_text, *ref_text, "{label:?}: {after:?}");
        assert_eq!(node.tags, before.tags, "{after:?}");
        assert_eq!(node.groups, before.groups, "{after:?}");
        assert_eq!(result["select"], selected(2, ref_text), "{after:?}");
    }
}

#[test]
fn edit_inspect_node_label_keeps_backslashes_that_rename_would_not_add() {
    // メインの決定 (1 の (a)): markdag が足さない所に人が書いた \ は入力欄にそのまま出す。外すのは名前の変更で足すのと同じ所のものだけ
    let cases: &[(&str, &str, &str)] = &[
        (
            "---\nmarkdag:\n---\n# R\n- 設計 \\#a の説明\n",
            "設計 #a の説明",
            r"設計 \#a の説明",
        ),
        (
            "# R\n- 設計 \\#a の説明\n",
            "設計 #a の説明",
            r"設計 \#a の説明",
        ),
        (
            "---\nmarkdag:\n---\n# R\n- a \\* b #k\n",
            "a * b",
            r"a \* b",
        ),
        (
            "---\nmarkdag:\n---\n# R\n- \\*\\*x\\*\\*\n",
            "**x**",
            r"\*\*x\*\*",
        ),
        // 行の途中の \# は残し、末尾の印に化ける語の \ だけを外す
        (
            "---\nmarkdag:\n---\n# R\n- C\\# と F\\# の比較 \\#draft\n",
            "C# と F# の比較 #draft",
            r"C\# と F\# の比較 #draft",
        ),
    ];
    for (source, ref_text, label) in cases {
        assert_eq!(node_of(source, 2).ref_text, *ref_text, "{source:?}");
        assert_eq!(label_of(source, 2, ref_text), json!(label), "{source:?}");
    }
}

// markdag キーのない文書の、末尾の印に見える語を持つ行 (印を読まないので名前の一部): (原文、id、refText = label)
const NO_KEY_MARK_LIKE: &[(&str, u32, &str)] = &[
    ("# R\n- a #k\n", 2, "a #k"),
    (
        "# R\n- Issue #123 fix #urgent\n",
        2,
        "Issue #123 fix #urgent",
    ),
    ("# R\n- a #k:v\n", 2, "a #k:v"),
    ("# R\n- a %g\n", 2, "a %g"),
    ("# R\n- a $id\n", 2, "a $id"),
    ("# R\n- [ ] a #k\n", 2, "a #k"),
    ("# R\n## h #k\n", 2, "h #k"),
    ("# R\r\n- a #k\r\n", 2, "a #k"),
];

#[test]
fn edit_rename_with_the_unchanged_label_keeps_the_source_without_markdag_key() {
    // メインの決定 (3): 名前の入力を開いて何も変えずに決めたときは、どの文書でも原文を変えない (- a #k を - a \#k にしない)
    for (source, id, name) in NO_KEY_MARK_LIKE {
        assert_eq!(node_of(source, *id).ref_text, *name, "{source:?}");
        let label = label_of(source, *id, name);
        assert_eq!(label, json!(name), "{source:?}");
        assert_unchanged(&rename(source, *id, name, name), "same-name");
    }
    // markdag キーのある文書では #k はタグで、label は印を除いた名前。何も変えずに決めても原文は変わらない
    let source = format!("{MD}# R\n## h %g\n- a #k\n");
    assert_eq!(label_of(&source, 2, "h"), json!("h"));
    assert_unchanged(&rename(&source, 2, "h", "h"), "same-name");
    assert_eq!(label_of(&source, 3, "a"), json!("a"));
    assert_unchanged(&rename(&source, 3, "a", "a"), "same-name");
}

#[test]
fn edit_rename_still_escapes_changed_names_with_or_without_markdag_key() {
    // 名前を変えたときは今までどおり逃がす (印に化ける末尾の語の前に \)
    assert_eq!(
        renamed("# R\n- a #k\n", 2, "a #k", "b #k"),
        "# R\n- b \\#k\n"
    );
    assert_eq!(
        renamed("# R\n- a #k\n", 2, "a #k", "a #k #m"),
        "# R\n- a #k \\#m\n"
    );
    assert_eq!(
        renamed("# R\n## h #k\n", 2, "h #k", "h #j"),
        "# R\n## h \\#j\n"
    );
    let source = format!("{MD}# R\n- a #k\n");
    assert_eq!(
        renamed(&source, 2, "a", "b #c"),
        format!("{MD}# R\n- b \\#c #k\n")
    );
}

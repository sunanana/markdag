// 番号付きリストの番号の振り直しのうち、2 つ以上の項目が全部同じ番号で書かれたリスト (「1. 1. 1.」「3. 3. 3.」「1) 1) 1)」。
// 番号を表示に任せる書き方) を、足す (下、上、末尾、子、合流)、移す (入れる、出す)、消す (1 つ、先頭、まとめて) のどの操作の
// あとも全部同じ番号のまま書くことを、直す前に落ちるテストとして書く。連番のリストと項目が 1 つのリストは今の振り直しのまま
// (足したら後ろが + 1、消したら詰める) であることも見る。図のノードの名前 (refText) はどちらでも最初の番号から数えた番号。
// 公開の markdag_core::edit (edit_source) と解析 (parse_document) だけを使う。入力は境界と同じ JSON を serde で読んで作り、
// 出力は serde の JSON にして比べる。指すノードは操作の前に原文の解析で id と refText を確かめ、期待の文書は比べる前に
// 解析し直して数えた番号の名前で読まれることを確かめる (期待の書き誤りを、直す前の赤の確認で見分けるため)。
// 関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める。
use markdag_core::edit::edit_source;
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

type Target<'a> = (u32, &'a str);

fn op(value: Value) -> EditOp {
    serde_json::from_value(value).expect("EditOp の JSON")
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

fn node_of(source: &str, id: u32) -> OutlineNode {
    parse_document(source)
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

// 親 parent の子の refText を文書の順に
fn children_of(source: &str, parent: u32) -> Vec<String> {
    parse_document(source)
        .nodes
        .into_iter()
        .filter(|node| node.parent == Some(parent))
        .map(|node| node.ref_text)
        .collect()
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(node_of(source, id).ref_text, ref_text, "{source:?}");
}

fn node_json((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn selected((id, ref_text): Target) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [node_json((id, ref_text))] }))
}

fn add_child(source: &str, parent: Target, label: &str) -> Value {
    assert_target(source, parent);
    edited_by(
        source,
        json!({ "kind": "addChild", "parent": node_json(parent), "label": label }),
    )
}

fn add_sibling(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSibling", "node": node_json(node), "label": label }),
    )
}

fn add_sibling_before(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSiblingBefore", "node": node_json(node), "label": label }),
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

fn join_into_new(source: &str, sources: &[Target], label: &str) -> Value {
    for &node in sources {
        assert_target(source, node);
    }
    let sources: Vec<Value> = sources.iter().map(|&node| node_json(node)).collect();
    edited_by(
        source,
        json!({ "kind": "joinIntoNew", "sources": sources, "label": label }),
    )
}

// 足した結果: 原文の全体、select と rename が足したノード、notes が空、足したノードの親
fn assert_added(source: &str, result: &Value, expected: &str, added: Target, parent: u32) {
    assert_eq!(
        node_of(expected, added.0).ref_text,
        added.1,
        "期待の文書: {expected:?}"
    );
    assert_eq!(
        node_of(expected, added.0).parent,
        Some(parent),
        "期待の文書: {expected:?}"
    );
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], selected(added), "{result}");
    assert_eq!(
        result["rename"],
        normalized(json!({ "kind": "node", "node": node_json(added) })),
        "{result}"
    );
    assert_eq!(result["notes"], json!([]), "{result}");
}

// 書き換えた結果: 原文の全体、select が 1 つのノード、rename は null、notes は空
fn assert_rewritten(source: &str, result: &Value, expected: &str, chosen: Target) {
    assert_eq!(
        node_of(expected, chosen.0).ref_text,
        chosen.1,
        "期待の文書: {expected:?}"
    );
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], selected(chosen), "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_eq!(result["notes"], json!([]), "{result}");
}

// 付け替えた結果: 上に加えて、動かしたノードの親が移す先
fn assert_moved(source: &str, result: &Value, expected: &str, moved: Target, parent: u32) {
    assert_eq!(
        node_of(expected, moved.0).parent,
        Some(parent),
        "期待の文書: {expected:?}"
    );
    assert_rewritten(source, result, expected, moved);
}

fn body_of(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    assert_eq!(lines.first(), Some(&"---"), "{text:?}");
    let close = lines
        .iter()
        .skip(1)
        .position(|line| *line == "---")
        .unwrap_or_else(|| panic!("閉じの --- がある: {text:?}"))
        + 1;
    lines[close + 1..].join("\n")
}

// ---- 全部同じ番号のリストの書き方 ----

// 足したノードの仮の名前。呼び出し側が label で渡す
const NEW: &str = "新しいノード";
// 新しい合流先の仮の名前
const JOINED: &str = "合流点";

// 全部の項目に書く番号と区切り。図の名前は、この番号から数えた番号と . (区切りが ) でも .)
#[derive(Clone, Copy, Debug)]
struct Same {
    number: u32,
    delimiter: char,
}

const STYLES: [Same; 3] = [
    Same {
        number: 1,
        delimiter: '.',
    },
    Same {
        number: 3,
        delimiter: '.',
    },
    Same {
        number: 1,
        delimiter: ')',
    },
];

// 項目の名前の段落のすぐ下に書く入れ子のリストに使える書き方。CommonMark では 1 以外から始まる番号付きリストは段落を
// 中断できず、名前の続きの行に読まれるので、1 から始まるものだけ
fn nestable() -> impl Iterator<Item = Same> {
    STYLES.into_iter().filter(|list| list.number == 1)
}

impl Same {
    // 項目の頭 (「1.」「3.」「1)」)
    fn marker(self) -> String {
        format!("{}{}", self.number, self.delimiter)
    }

    // 字下げ indent で、名前ごとに 1 行の項目を全部同じ番号で書く
    fn items(self, indent: &str, names: &[&str]) -> String {
        names
            .iter()
            .map(|name| format!("{indent}{} {name}\n", self.marker()))
            .collect()
    }

    // リストの position 番目 (0 始まり) の項目の図の名前
    fn ref_text(self, position: u32, name: &str) -> String {
        format!("{}. {name}", self.number + position)
    }

    fn ref_texts(self, names: &[&str]) -> Vec<String> {
        names
            .iter()
            .enumerate()
            .map(|(position, name)| self.ref_text(position as u32, name))
            .collect()
    }
}

// 期待の文書で、親 parent の子がそのリストの項目だけで、名前が数えた番号で読まれる
fn assert_counted(expected: &str, parent: u32, list: Same, names: &[&str]) {
    assert_eq!(
        children_of(expected, parent),
        list.ref_texts(names),
        "期待の文書の図の名前: {expected:?}"
    );
}

// ---- 全部同じ番号のリスト: 足す ----

#[test]
fn edit_same_number_add_sibling_below_a_middle_item_keeps_the_number() {
    // 1 R / 2 a / 3 b / 4 c。b の下に足すと、足した項目も同じ番号で、後ろの c も同じ番号のまま
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["a", "b", NEW, "c"]));
        assert_counted(&expected, 1, list, &["a", "b", NEW, "c"]);
        let result = add_sibling(&source, (3, &list.ref_text(1, "b")), NEW);
        assert_added(&source, &result, &expected, (4, &list.ref_text(2, NEW)), 1);
    }
}

#[test]
fn edit_same_number_add_sibling_below_the_last_item_keeps_the_number() {
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["a", "b", "c", NEW]));
        assert_counted(&expected, 1, list, &["a", "b", "c", NEW]);
        let result = add_sibling(&source, (4, &list.ref_text(2, "c")), NEW);
        assert_added(&source, &result, &expected, (5, &list.ref_text(3, NEW)), 1);
    }
}

#[test]
fn edit_same_number_two_items_are_enough_to_keep_the_number() {
    // 項目が 2 つの「1. 1.」も全部同じ番号のリスト
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b"]));
        let expected = format!("# R\n{}", list.items("", &["a", NEW, "b"]));
        assert_counted(&expected, 1, list, &["a", NEW, "b"]);
        let result = add_sibling(&source, (2, &list.ref_text(0, "a")), NEW);
        assert_added(&source, &result, &expected, (3, &list.ref_text(1, NEW)), 1);
    }
}

#[test]
fn edit_same_number_add_sibling_before_a_middle_item_keeps_the_number() {
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["a", NEW, "b", "c"]));
        assert_counted(&expected, 1, list, &["a", NEW, "b", "c"]);
        let result = add_sibling_before(&source, (3, &list.ref_text(1, "b")), NEW);
        assert_added(&source, &result, &expected, (3, &list.ref_text(1, NEW)), 1);
    }
}

#[test]
fn edit_same_number_add_sibling_before_the_first_item_keeps_the_number() {
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &[NEW, "a", "b", "c"]));
        assert_counted(&expected, 1, list, &[NEW, "a", "b", "c"]);
        let result = add_sibling_before(&source, (2, &list.ref_text(0, "a")), NEW);
        assert_added(&source, &result, &expected, (2, &list.ref_text(0, NEW)), 1);
    }
}

#[test]
fn edit_same_number_add_child_of_a_heading_keeps_the_number() {
    // 親の子がそのリスト: 末尾に足す項目も同じ番号 (「1. 1. 1. 4.」にしない)
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["a", "b", "c", NEW]));
        assert_counted(&expected, 1, list, &["a", "b", "c", NEW]);
        let result = add_child(&source, (1, "R"), NEW);
        assert_added(&source, &result, &expected, (5, &list.ref_text(3, NEW)), 1);
    }
}

#[test]
fn edit_same_number_add_child_of_an_item_keeps_the_number_of_its_nested_list() {
    // 1 R / 2 x / 3 a / 4 b。x の子は字下げした同じ番号のリスト
    for list in nestable() {
        let source = format!("# R\n- x\n{}", list.items("    ", &["a", "b"]));
        let expected = format!("# R\n- x\n{}", list.items("    ", &["a", "b", NEW]));
        assert_counted(&expected, 2, list, &["a", "b", NEW]);
        let result = add_child(&source, (2, "x"), NEW);
        assert_added(&source, &result, &expected, (5, &list.ref_text(2, NEW)), 2);
    }
}

#[test]
fn edit_same_number_add_to_items_with_details_and_nested_lists_keeps_both_lists() {
    // 1 R / 2 a (詳細つき) / 3 b / 4 b1 / 5 b2 / 6 c。外のリストも b の中のリストも全部同じ番号
    for list in nestable() {
        let n = list.marker();
        let source = format!("# R\n{n} a\n    > 詳細\n{n} b\n    {n} b1\n    {n} b2\n{n} c\n");
        assert_counted(&source, 1, list, &["a", "b", "c"]);
        assert_counted(&source, 3, list, &["b1", "b2"]);

        // 詳細のある a の下に足す: 詳細のあと
        let expected =
            format!("# R\n{n} a\n    > 詳細\n{n} {NEW}\n{n} b\n    {n} b1\n    {n} b2\n{n} c\n");
        assert_counted(&expected, 1, list, &["a", NEW, "b", "c"]);
        let result = add_sibling(&source, (2, &list.ref_text(0, "a")), NEW);
        assert_added(&source, &result, &expected, (3, &list.ref_text(1, NEW)), 1);

        // b の子を足す: b の中のリストの末尾。外のリストの c も同じ番号のまま
        let expected = format!(
            "# R\n{n} a\n    > 詳細\n{n} b\n    {n} b1\n    {n} b2\n    {n} {NEW}\n{n} c\n"
        );
        assert_counted(&expected, 3, list, &["b1", "b2", NEW]);
        let result = add_child(&source, (3, &list.ref_text(1, "b")), NEW);
        assert_added(&source, &result, &expected, (6, &list.ref_text(2, NEW)), 3);
    }
}

#[test]
fn edit_same_number_add_to_a_list_in_a_container_keeps_the_number() {
    // 見出しの下に種類の違うリストが 2 つ: 1 R / 2 ul の容器 / 3 p / 4 q / 5 ol の容器 / 6 a / 7 b
    for list in STYLES {
        let source = format!("# R\n\n- p\n- q\n\n{}", list.items("", &["a", "b"]));
        assert_counted(&source, 5, list, &["a", "b"]);

        let expected = format!("# R\n\n- p\n- q\n\n{}", list.items("", &["a", NEW, "b"]));
        assert_counted(&expected, 5, list, &["a", NEW, "b"]);
        let result = add_sibling(&source, (6, &list.ref_text(0, "a")), NEW);
        assert_added(&source, &result, &expected, (7, &list.ref_text(1, NEW)), 5);

        let expected = format!("# R\n\n- p\n- q\n\n{}", list.items("", &["a", "b", NEW]));
        assert_counted(&expected, 5, list, &["a", "b", NEW]);
        let result = add_child(&source, (5, ""), NEW);
        assert_added(&source, &result, &expected, (8, &list.ref_text(2, NEW)), 5);
    }
}

#[test]
fn edit_same_number_join_into_new_keeps_the_number() {
    // 合流で足す新しいノードは、いちばん後ろの始点のあと。途中でも末尾でも同じ番号で書き、後ろの項目も同じ番号のまま。
    // 本文だけを比べる (relations の書き方は合流のテストが見る)。1 R / 2 a / 3 b / 4 c
    for list in STYLES {
        let source = format!(
            "---\nmarkdag:\n---\n# R\n{}",
            list.items("", &["a", "b", "c"])
        );
        let a = list.ref_text(0, "a");
        let b = list.ref_text(1, "b");
        let c = list.ref_text(2, "c");

        let expected = format!("# R\n{}", list.items("", &["a", "b", JOINED, "c"]));
        assert_counted(&expected, 1, list, &["a", "b", JOINED, "c"]);
        let result = join_into_new(&source, &[(2, &a), (3, &b)], JOINED);
        let after = applied(&source, &result);
        assert_eq!(body_of(&after), expected, "{list:?}: {result}");
        assert_eq!(
            result["select"],
            selected((4, &list.ref_text(2, JOINED))),
            "{result}"
        );

        let expected = format!("# R\n{}", list.items("", &["a", "b", "c", JOINED]));
        assert_counted(&expected, 1, list, &["a", "b", "c", JOINED]);
        let result = join_into_new(&source, &[(3, &b), (4, &c)], JOINED);
        let after = applied(&source, &result);
        assert_eq!(body_of(&after), expected, "{list:?}: {result}");
        assert_eq!(
            result["select"],
            selected((5, &list.ref_text(3, JOINED))),
            "{result}"
        );
    }
}

// ---- 全部同じ番号のリスト: 移す ----

#[test]
fn edit_same_number_move_an_item_into_the_list_keeps_the_number() {
    // 1 R / 2 A / 3 a / 4 b / 5 c / 6 B / 7 y。y を A へ移すと A のリストの末尾に同じ番号で書く
    for list in STYLES {
        let source = format!("# R\n## A\n{}## B\n- y\n", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n## A\n{}## B\n", list.items("", &["a", "b", "c", "y"]));
        assert_counted(&expected, 2, list, &["a", "b", "c", "y"]);
        let result = move_node(&source, (7, "y"), (2, "A"));
        assert_moved(&source, &result, &expected, (6, &list.ref_text(3, "y")), 2);
    }
}

#[test]
fn edit_same_number_move_a_middle_item_out_keeps_the_rest_the_same() {
    // 1 R / 2 A / 3 x / 4 B / 5 a / 6 b / 7 c。b を A へ移すと、残った a と c は同じ番号のまま
    for list in STYLES {
        let source = format!("# R\n## A\n- x\n## B\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n## A\n- x\n- b\n## B\n{}", list.items("", &["a", "c"]));
        assert_counted(&expected, 5, list, &["a", "c"]);
        let result = move_node(&source, (6, &list.ref_text(1, "b")), (2, "A"));
        assert_moved(&source, &result, &expected, (4, "b"), 2);
    }
}

#[test]
fn edit_same_number_move_the_first_item_out_keeps_the_rest_the_same() {
    for list in STYLES {
        let source = format!("# R\n## A\n- x\n## B\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n## A\n- x\n- a\n## B\n{}", list.items("", &["b", "c"]));
        assert_counted(&expected, 5, list, &["b", "c"]);
        let result = move_node(&source, (5, &list.ref_text(0, "a")), (2, "A"));
        assert_moved(&source, &result, &expected, (4, "a"), 2);
    }
}

#[test]
fn edit_same_number_move_between_two_same_number_lists_keeps_both() {
    // 1 R / 2 A / 3 a / 4 b / 5 B / 6 x / 7 y / 8 z。y を A へ: 移す先も移す元も同じ番号のまま
    for list in STYLES {
        let source = format!(
            "# R\n## A\n{}## B\n{}",
            list.items("", &["a", "b"]),
            list.items("", &["x", "y", "z"])
        );
        let expected = format!(
            "# R\n## A\n{}## B\n{}",
            list.items("", &["a", "b", "y"]),
            list.items("", &["x", "z"])
        );
        assert_counted(&expected, 2, list, &["a", "b", "y"]);
        assert_counted(&expected, 6, list, &["x", "z"]);
        let result = move_node(&source, (7, &list.ref_text(1, "y")), (2, "A"));
        assert_moved(&source, &result, &expected, (5, &list.ref_text(2, "y")), 2);
    }
}

// ---- 全部同じ番号のリスト: 消す ----

#[test]
fn edit_same_number_delete_a_middle_item_keeps_the_rest_the_same() {
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["a", "c"]));
        assert_counted(&expected, 1, list, &["a", "c"]);
        let result = delete_nodes(&source, &[(3, &list.ref_text(1, "b"))]);
        assert_rewritten(&source, &result, &expected, (1, "R"));
    }
}

#[test]
fn edit_same_number_delete_the_first_item_keeps_the_rest_the_same() {
    // 「3. 3. 3.」の先頭を消しても残りは 3 のまま (図の名前は残った最初の項目の 3 から数える)
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c"]));
        let expected = format!("# R\n{}", list.items("", &["b", "c"]));
        assert_counted(&expected, 1, list, &["b", "c"]);
        let result = delete_nodes(&source, &[(2, &list.ref_text(0, "a"))]);
        assert_rewritten(&source, &result, &expected, (1, "R"));
    }
}

#[test]
fn edit_same_number_delete_the_first_item_with_details_and_a_nested_list() {
    // 1 R / 2 a (詳細つき) / 3 b / 4 b1 / 5 b2 / 6 c。a を消しても、外のリストも b の中のリストも同じ番号のまま
    for list in nestable() {
        let n = list.marker();
        let source = format!("# R\n{n} a\n    > 詳細\n{n} b\n    {n} b1\n    {n} b2\n{n} c\n");
        let expected = format!("# R\n{n} b\n    {n} b1\n    {n} b2\n{n} c\n");
        assert_counted(&expected, 1, list, &["b", "c"]);
        assert_counted(&expected, 2, list, &["b1", "b2"]);
        let result = delete_nodes(&source, &[(2, &list.ref_text(0, "a"))]);
        assert_rewritten(&source, &result, &expected, (1, "R"));
    }
}

#[test]
fn edit_same_number_delete_two_items_at_once_keeps_the_rest_the_same() {
    // 1 R / 2 a / 3 b / 4 c / 5 d。先頭の a と途中の c をまとめて消す
    for list in STYLES {
        let source = format!("# R\n{}", list.items("", &["a", "b", "c", "d"]));
        let expected = format!("# R\n{}", list.items("", &["b", "d"]));
        assert_counted(&expected, 1, list, &["b", "d"]);
        let result = delete_nodes(
            &source,
            &[(4, &list.ref_text(2, "c")), (2, &list.ref_text(0, "a"))],
        );
        assert_rewritten(&source, &result, &expected, (1, "R"));
    }
}

#[test]
fn edit_same_number_delete_items_of_two_lists_at_once_keeps_both() {
    // 1 R / 2 A / 3 a / 4 b / 5 c / 6 B / 7 x / 8 y / 9 z。b と y をまとめて消す。選ぶのは文書順で最初の b の親 A
    for list in STYLES {
        let source = format!(
            "# R\n## A\n{}## B\n{}",
            list.items("", &["a", "b", "c"]),
            list.items("", &["x", "y", "z"])
        );
        let expected = format!(
            "# R\n## A\n{}## B\n{}",
            list.items("", &["a", "c"]),
            list.items("", &["x", "z"])
        );
        assert_counted(&expected, 2, list, &["a", "c"]);
        assert_counted(&expected, 5, list, &["x", "z"]);
        let result = delete_nodes(
            &source,
            &[(8, &list.ref_text(1, "y")), (4, &list.ref_text(1, "b"))],
        );
        assert_rewritten(&source, &result, &expected, (2, "A"));
    }
}

// ---- 連番のリストと項目が 1 つのリスト (今の振り直しのまま) ----

#[test]
fn edit_same_number_sequential_lists_still_renumber_after_adding() {
    // 足した項目は前の番号 + 1 (上に足すときは足した前の項目の番号)、後ろの兄弟は + 1
    let source = "# R\n1. a\n2. b\n3. c\n";
    assert_added(
        source,
        &add_sibling_before(source, (3, "2. b"), NEW),
        "# R\n1. a\n2. 新しいノード\n3. b\n4. c\n",
        (3, "2. 新しいノード"),
        1,
    );
    assert_added(
        source,
        &add_sibling(source, (3, "2. b"), NEW),
        "# R\n1. a\n2. b\n3. 新しいノード\n4. c\n",
        (4, "3. 新しいノード"),
        1,
    );
    assert_added(
        source,
        &add_child(source, (1, "R"), NEW),
        "# R\n1. a\n2. b\n3. c\n4. 新しいノード\n",
        (5, "4. 新しいノード"),
        1,
    );
    let source = "# R\n1) a\n2) b\n";
    assert_added(
        source,
        &add_sibling_before(source, (3, "2. b"), NEW),
        "# R\n1) a\n2) 新しいノード\n3) b\n",
        (3, "2. 新しいノード"),
        1,
    );
    let source = "# R\n3. a\n4. b\n5. c\n";
    assert_added(
        source,
        &add_sibling(source, (2, "3. a"), NEW),
        "# R\n3. a\n4. 新しいノード\n5. b\n6. c\n",
        (3, "4. 新しいノード"),
        1,
    );
}

#[test]
fn edit_same_number_sequential_lists_still_close_up_after_deleting_and_moving() {
    // 1 R / 2 a / 3 b / 4 c / 5 d
    let source = "# R\n1. a\n2. b\n3. c\n4. d\n";
    assert_rewritten(
        source,
        &delete_nodes(source, &[(3, "2. b")]),
        "# R\n1. a\n2. c\n3. d\n",
        (1, "R"),
    );
    assert_rewritten(
        source,
        &delete_nodes(source, &[(4, "3. c"), (3, "2. b")]),
        "# R\n1. a\n2. d\n",
        (1, "R"),
    );
    // 1 R / 2 A / 3 x / 4 B / 5 a / 6 b / 7 c / 8 d
    let source = "# R\n## A\n- x\n## B\n1. a\n2. b\n3. c\n4. d\n";
    assert_moved(
        source,
        &move_node(source, (6, "2. b"), (2, "A")),
        "# R\n## A\n- x\n- b\n## B\n1. a\n2. c\n3. d\n",
        (4, "b"),
        2,
    );
}

#[test]
fn edit_same_number_a_single_item_list_is_sequential() {
    // 項目が 1 つのリストは連番として扱う: 「1.」の下に足すと「1. 2.」
    let source = "# R\n1. a\n";
    assert_added(
        source,
        &add_sibling(source, (2, "1. a"), NEW),
        "# R\n1. a\n2. 新しいノード\n",
        (3, "2. 新しいノード"),
        1,
    );
    assert_added(
        source,
        &add_sibling_before(source, (2, "1. a"), NEW),
        "# R\n1. 新しいノード\n2. a\n",
        (2, "1. 新しいノード"),
        1,
    );
    assert_added(
        source,
        &add_child(source, (1, "R"), NEW),
        "# R\n1. a\n2. 新しいノード\n",
        (3, "2. 新しいノード"),
        1,
    );
    let source = "# R\n3. a\n";
    assert_added(
        source,
        &add_sibling(source, (2, "3. a"), NEW),
        "# R\n3. a\n4. 新しいノード\n",
        (3, "4. 新しいノード"),
        1,
    );
    let source = "# R\n1) a\n";
    assert_added(
        source,
        &add_child(source, (1, "R"), NEW),
        "# R\n1) a\n2) 新しいノード\n",
        (3, "2. 新しいノード"),
        1,
    );
    // 1 R / 2 A / 3 a / 4 B / 5 y
    let source = "# R\n## A\n1. a\n## B\n- y\n";
    assert_moved(
        source,
        &move_node(source, (5, "y"), (2, "A")),
        "# R\n## A\n1. a\n2. y\n## B\n",
        (4, "2. y"),
        2,
    );
}

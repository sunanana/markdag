// GUI 編集のキーの手直しのレビューで「直す」と決めた指摘 (records/fix.md) のうち、原文の書き換えの層のものを、直す前に落ちるテストとして書く。
// 期待は spec.md と fix.md の理由から書く。再現の文書と手順はレビュアーの記録 (records/review-a.md、review-b.md) から取った。
// - A-08 / B-12: 桁が増えて子の字下げを書き直すとき、子でも詳細でもない怠惰な続きの行 (字下げのない行) はずらさない (U7-digits)
// - B-04: 見出しのない文書のルートの名前 (title) は、項目の名前の変更で通る名前を断らず、図の名前は項目と同じ読み方になる
// - B-10: 日付の形の名前も、title にほかの値と同じ決まりで書く (引用符で囲まない。0.12.0 の書き方)。
//   引用符を付けて書く直しは、関門の答え (修正案 K-008、2026-10-07) で取り消した
// - B-11: 先頭に BOM のある文書でも、最初の見出しの上に足せる (最初の兄弟の上にも足せる。S-05 は今のまま)
// 公開の markdag_core::edit (edit_source) と解析 (parse_document) だけを使う。関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::edit_source;
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, OutlineNode};
use serde_json::{Value, json};

type Target<'a> = (u32, &'a str);

const NEW: &str = "新しいノード";

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

fn named(source: &str, ref_text: &str) -> OutlineNode {
    let found: Vec<OutlineNode> = parse_document(source)
        .nodes
        .into_iter()
        .filter(|node| node.ref_text == ref_text)
        .collect();
    assert_eq!(
        found.len(),
        1,
        "名前 {ref_text:?} のノードが 1 つ: {source:?}"
    );
    found.into_iter().next().expect("1 つある")
}

fn parent_name(source: &str, child: &str) -> String {
    let parent = named(source, child)
        .parent
        .unwrap_or_else(|| panic!("{child:?} に親がある: {source:?}"));
    node_of(source, parent).ref_text
}

fn children_of(source: &str, parent: u32) -> Vec<String> {
    parse_document(source)
        .nodes
        .into_iter()
        .filter(|node| node.parent == Some(parent))
        .map(|node| node.ref_text)
        .collect()
}

fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(node_of(source, id).ref_text, ref_text, "{source:?}");
}

fn node_json((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn selected((id, ref_text): Target) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [node_json((id, ref_text))] }))
}

fn rename_node(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "renameNode", "node": node_json(node), "label": label }),
    )
}

fn add_sibling_before(source: &str, node: Target) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSiblingBefore", "node": node_json(node), "label": NEW }),
    )
}

// 1. 一 〜 8. 八 の形の 8 行 (名前は prefix + 番号)
fn eight(prefix: &str) -> String {
    (1..=8).map(|n| format!("{n}. {prefix}{n}\n")).collect()
}

// ---- A-08 / B-12 ----

#[test]
fn edit_review_keys_a08_digits_growing_keeps_lazy_continuation_lines() {
    // review-a の A-08: 1. n1 の上に足して 9. n9 が 10. になる。詳細の行 (> memo line1) は字下げを 3 から 4 に書き直すが、
    // 字下げのない怠惰な続きの行 (lazy memo) は書き換えない
    let source = format!(
        "---\nmarkdag:\n---\n# R\n{}9. n9\n   > memo line1\nlazy memo\n",
        eight("n")
    );
    let shifted: String = (1..=8).map(|n| format!("{}. n{n}\n", n + 1)).collect();
    let expected = format!(
        "---\nmarkdag:\n---\n# R\n1. {NEW}\n{shifted}10. n9\n    > memo line1\nlazy memo\n"
    );
    let result = add_sibling_before(&source, (2, "1. n1"));
    assert_eq!(applied(&source, &result), expected, "{result}");
    assert_eq!(
        result["select"],
        selected((2, &format!("1. {NEW}"))),
        "{result}"
    );
}

#[test]
fn edit_review_keys_b12_digits_growing_shifts_the_child_but_not_the_lazy_line_before_it() {
    // review-b の B-12: 9. i9 の上に足す。詳細と子 (- c) は 10. の子のままになるよう字下げを 4 に書き直し、
    // あいだの字下げのない怠惰な続きの行 (lazy continuation) は書き換えない。1 A / 2〜9 i1〜i8 / 10 i9 / 11 c
    let source = format!(
        "# A\n{}9. i9\n   > detail\nlazy continuation\n   - c\n",
        eight("i")
    );
    assert_eq!(parent_name(&source, "c"), "9. i9");
    let expected = format!(
        "# A\n{}9. {NEW}\n10. i9\n    > detail\nlazy continuation\n    - c\n",
        eight("i")
    );
    assert_eq!(
        parent_name(&expected, "c"),
        "10. i9",
        "期待の文書: {expected:?}"
    );
    let result = add_sibling_before(&source, (10, "9. i9"));
    assert_eq!(applied(&source, &result), expected, "{result}");
    assert_eq!(
        result["select"],
        selected((10, &format!("9. {NEW}"))),
        "{result}"
    );
}

// ---- B-04 ----

// 項目の名前の変更で通る名前 (空白 2 つ、山括弧、文字参照、HTML の書式、改行のタグ、タブ)
const ITEM_NAMES: [&str; 6] = [
    "新しい  題",
    "Release <v2>",
    "a &lt; b",
    "<b>x</b>",
    "a<br>b",
    "x\ty",
];

// 項目 a の名前を name に変えたときの図の名前 (項目の名前の変更が通ることも確かめる)
fn item_ref_text(name: &str) -> String {
    let source = "# R\n- a\n- b\n";
    let result = rename_node(source, (2, "a"), name);
    node_of(&applied(source, &result), 2).ref_text
}

#[test]
fn edit_review_keys_b04_root_title_takes_names_that_items_take() {
    // ルートのタイトルの名前の変更は、項目なら通る名前を断らない。図の名前 (refText) は、同じ名前を項目に付けたときと同じ読み方
    for source in [
        "---\ntitle: T\n---\n- 甲\n- 乙\n",
        "---\ntitle: T\n---\n- a\n\n1. b\n",
    ] {
        for name in ITEM_NAMES {
            let expected = item_ref_text(name);
            let result = rename_node(source, (1, "T"), name);
            assert_eq!(
                result["status"], "edited",
                "{source:?} を {name:?} に: {result}"
            );
            let after = applied(source, &result);
            assert_eq!(node_of(&after, 1).ref_text, expected, "{name:?}: {after:?}");
            assert_eq!(result["select"], selected((1, &expected)), "{result}");
            // 本文は変えない
            assert_eq!(
                after.split("---\n").last(),
                source.split("---\n").last(),
                "{after:?}"
            );
        }
    }
}

// ---- B-10 ----

#[test]
fn edit_review_keys_b10_date_like_title_is_written_without_quotes() {
    // 日付の形の名前は、ほかの値と同じ決まりで引用符なしで書く (0.12.0 の書き方。YAML 1.1 の型を持つ読み手が日付に読んでもかまわない)。
    // 図の名前はその名前 (markdag の読み方では文字)
    for (source, title) in [
        ("---\ntitle: T\n---\n- a\n- b\n", "T"),
        ("---\nmarkdag:\n    tasks: scratch\n---\n- a\n- b\n", ""),
        ("- a\n- b\n", ""),
    ] {
        let result = rename_node(source, (1, title), "2026-10-06");
        let after = applied(source, &result);
        let lines: Vec<&str> = after
            .split('\n')
            .filter(|line| line.starts_with("title:"))
            .collect();
        assert_eq!(lines.len(), 1, "{after:?}");
        assert_eq!(lines[0], "title: 2026-10-06", "引用符なしで書く: {after:?}");
        assert_eq!(node_of(&after, 1).ref_text, "2026-10-06", "{after:?}");
    }
}

// ---- B-11 ----

#[test]
fn edit_review_keys_b11_add_before_the_first_heading_of_a_bom_document() {
    // 先頭に BOM のある文書 (見出しが 2 つで、ルートは行のない入れ物)。A の上に足すと、BOM は文書の先頭に 1 つだけ残り、
    // 足した見出しは A の前に読まれる。見出しのまわりの空行の置き方は決めていないので、空でない行の並びを見る
    let source = "\u{FEFF}# A\n# B\n";
    assert_eq!(children_of(source, 1), ["A", "B"]);
    let result = add_sibling_before(source, (2, "A"));
    let after = applied(source, &result);
    assert!(after.starts_with('\u{FEFF}'), "BOM は先頭に残る: {after:?}");
    assert_eq!(after.matches('\u{FEFF}').count(), 1, "{after:?}");
    let lines: Vec<&str> = after
        .trim_start_matches('\u{FEFF}')
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert_eq!(lines, ["# 新しいノード", "# A", "# B"], "{after:?}");
    assert_eq!(children_of(&after, 1), [NEW, "A", "B"], "{after:?}");
    assert_eq!(result["select"], selected((2, NEW)), "{result}");
}

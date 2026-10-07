// GUI 編集のキーの手直しの最後の関門で、依頼者が修正案 (amendments.md) に答えた挙動 (2026-10-07) のうち、原文の書き換えの層のものを、
// 直す前に落ちるテストとして書く。期待は答えから書き、今の書き換えの出力はなぞらない。
// - K-002 (a): BOM で始まる文書でも、番号付きリストの最初の項目の番号を読み、足す・消す・移したあとの番号を、BOM のない文書と同じく
//   振り直す (BOM は先頭に残る)。ほかのまれな形 (振り直した原文が別の形に読まれるとき) は知らせずに振り直さないまま (ここでは見ない)
// - K-004 (b): 末尾に足す操作 (子を足す、移して入れる、合流で末尾に足す) でも、原文の番号がずれた番号付きリストは、全体を図の番号に
//   そろえる (1. 5. 6. の末尾に足すと 1. 2. 3. 4.)。連番のリストは続きの番号、全部同じ番号のリストは同じ番号のまま (今の決まり)
// - K-005 (b): 見出しのない文書のルートの名前の入力 (inspect_node の label) は、項目と同じく原文の title の文字のまま
//   (書式の記法を含む) で開き、少し直して決めても書式が残る。label のまま決めると原文を変えない。
//   title が文字でないときと title がないときは、今までどおり図の名前で開く
// - K-008 (0.12.0 に戻す): 日付の形の値は、グループの名前も引用符で囲まずに書く (title は edit_keys_review の B-10 が見る)。
//   yes / no / on / off などは今までどおり囲む
// 公開の markdag_core::edit (edit_source、inspect_node) と解析 (parse_document) だけを使う。指すノードは操作の前に原文の解析で
// id と refText を確かめ、期待の文書は比べる前に解析し直して、ねらいの名前と親子で読まれることを確かめる。
// 関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

type Target<'a> = (u32, &'a str);

const NEW: &str = "新しいノード";
const JOINED: &str = "合流点";
const BOM: char = '\u{FEFF}';

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

fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(node_of(source, id).ref_text, ref_text, "{source:?}");
}

fn node_json((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn selected((id, ref_text): Target) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [node_json((id, ref_text))] }))
}

fn renamed((id, ref_text): Target) -> Value {
    normalized(json!({ "kind": "node", "node": node_json((id, ref_text)) }))
}

fn rename_node(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "renameNode", "node": node_json(node), "label": label }),
    )
}

fn add_child(source: &str, parent: Target) -> Value {
    assert_target(source, parent);
    edited_by(
        source,
        json!({ "kind": "addChild", "parent": node_json(parent), "label": NEW }),
    )
}

fn add_sibling(source: &str, node: Target) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSibling", "node": node_json(node), "label": NEW }),
    )
}

fn add_sibling_before(source: &str, node: Target) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSiblingBefore", "node": node_json(node), "label": NEW }),
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

fn join_into_new(source: &str, sources: &[Target]) -> Value {
    for &node in sources {
        assert_target(source, node);
    }
    let sources: Vec<Value> = sources.iter().map(|&node| node_json(node)).collect();
    edited_by(
        source,
        json!({ "kind": "joinIntoNew", "sources": sources, "label": JOINED }),
    )
}

fn rename_group(source: &str, group: &str, label: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "renameGroup", "group": group, "label": label }),
    )
}

fn inspected(source: &str, node: Target) -> Value {
    assert_target(source, node);
    let target: NodeTarget = serde_json::from_value(node_json(node)).expect("NodeTarget の JSON");
    normalized(serde_json::to_value(inspect_node(source, &target)).expect("JSON にできる"))
}

fn frontmatter_of(text: &str) -> Value {
    serde_json::to_value(parse_document(text).frontmatter).expect("JSON にできる")
}

// frontmatter の閉じの --- のあとの本文
fn body_of(text: &str) -> &str {
    text.split("---\n").last().expect("本文")
}

// 書き換えた結果: 原文の全体、select が 1 つのノード、notes が空。rename は足す操作なら足したノード、ほかは null
fn assert_result(source: &str, result: &Value, expected: &str, chosen: Target, adds: bool) {
    assert_eq!(
        node_of(expected, chosen.0).ref_text,
        chosen.1,
        "期待の文書: {expected:?}"
    );
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], selected(chosen), "{result}");
    let rename = if adds { renamed(chosen) } else { Value::Null };
    assert_eq!(result["rename"], rename, "{result}");
    assert_eq!(result["notes"], json!([]), "{result}");
}

// ---- K-002: BOM で始まる文書の番号の振り直し ----

// BOM のないリストだけの文書。1 (容器) / 2 a / 3 b / 4 c
const LIST: &str = "1. a\n2. b\n3. c\n";

// (操作の名前, 原文に当てる操作, BOM のない文書での期待, 選ぶノード, 足す操作か)
type BomCase = (
    &'static str,
    fn(&str) -> Value,
    &'static str,
    Target<'static>,
    bool,
);

const BOM_CASES: [BomCase; 4] = [
    (
        "上に足す",
        |source| add_sibling_before(source, (3, "2. b")),
        "1. a\n2. 新しいノード\n3. b\n4. c\n",
        (3, "2. 新しいノード"),
        true,
    ),
    (
        "下に足す",
        |source| add_sibling(source, (3, "2. b")),
        "1. a\n2. b\n3. 新しいノード\n4. c\n",
        (4, "3. 新しいノード"),
        true,
    ),
    (
        "消す",
        |source| delete_nodes(source, &[(3, "2. b")]),
        "1. a\n2. c\n",
        (1, ""),
        false,
    ),
    (
        "移す (c の子へ)",
        |source| move_node(source, (3, "2. b"), (4, "3. c")),
        "1. a\n2. c\n    - b\n",
        (4, "b"),
        false,
    ),
];

#[test]
fn edit_gate_k002_bom_list_is_renumbered_like_the_same_list_without_a_bom() {
    // 1 行目が番号付きの項目で、BOM で始まる文書 (リストだけの文書)。BOM のない同じ文書の振り直しを先に確かめ (対照)、
    // BOM のある文書では、その結果の先頭に BOM が 1 つ付いた原文になる (BOM は残し、番号は図とそろう)
    let bommed = format!("{BOM}{LIST}");
    for (name, apply, expected, chosen, adds) in BOM_CASES {
        let result = apply(LIST);
        assert_result(LIST, &result, expected, chosen, adds);

        let expected = format!("{BOM}{expected}");
        let result = apply(&bommed);
        let after = applied(&bommed, &result);
        assert_eq!(after.matches(BOM).count(), 1, "{name}: {after:?}");
        assert_result(&bommed, &result, &expected, chosen, adds);
    }
}

#[test]
fn edit_gate_k002_bom_list_keeps_the_number_it_started_with() {
    // 1 以外から始まるリストも、BOM の付いた最初の項目の番号 (3) から数えて振り直す。1 (容器) / 2 a / 3 b / 4 c
    for (prefix, label) in [("", "BOM なし"), ("\u{FEFF}", "BOM あり")] {
        let source = format!("{prefix}3. a\n4. b\n5. c\n");
        assert_eq!(children_of(&source, 1), ["3. a", "4. b", "5. c"], "{label}");
        let result = delete_nodes(&source, &[(3, "4. b")]);
        assert_result(
            &source,
            &result,
            &format!("{prefix}3. a\n4. c\n"),
            (1, ""),
            false,
        );

        let result = add_sibling_before(&source, (3, "4. b"));
        assert_result(
            &source,
            &result,
            &format!("{prefix}3. a\n4. {NEW}\n5. b\n6. c\n"),
            (3, "4. 新しいノード"),
            true,
        );
    }
}

// ---- K-004: 番号のずれたリストの末尾に足す ----

#[test]
fn edit_gate_k004_add_child_to_a_list_with_shifted_numbers_aligns_the_whole_list() {
    // (原文, 親, 期待, 足したノード)。原文の番号がずれたリスト (図は数えた番号) の末尾に子を足すと、前の項目も図の番号に書き直し、
    // 足した項目はその続きの番号
    let cases: [(&str, Target, &str, Target); 4] = [
        // 1 R / 2 a / 3 b / 4 c
        (
            "# R\n1. a\n5. b\n6. c\n",
            (1, "R"),
            "# R\n1. a\n2. b\n3. c\n4. 新しいノード\n",
            (5, "4. 新しいノード"),
        ),
        // 区切りが「)」
        (
            "# R\n1) a\n5) b\n6) c\n",
            (1, "R"),
            "# R\n1) a\n2) b\n3) c\n4) 新しいノード\n",
            (5, "4. 新しいノード"),
        ),
        // 3 から始まるリスト (図は 3. 4. 5.)
        (
            "# R\n3. a\n7. b\n8. c\n",
            (1, "R"),
            "# R\n3. a\n4. b\n5. c\n6. 新しいノード\n",
            (5, "6. 新しいノード"),
        ),
        // 入れ子のリスト (外のリストは変えない)。1 R / 2 a / 3 a1 / 4 a2 / 5 a3 / 6 b
        (
            "# R\n- a\n    1. a1\n    5. a2\n    6. a3\n- b\n",
            (2, "a"),
            "# R\n- a\n    1. a1\n    2. a2\n    3. a3\n    4. 新しいノード\n- b\n",
            (6, "4. 新しいノード"),
        ),
    ];
    for (source, parent, expected, added) in cases {
        assert_eq!(
            node_of(expected, added.0).parent,
            Some(parent.0),
            "期待の文書: {expected:?}"
        );
        let result = add_child(source, parent);
        assert_result(source, &result, expected, added, true);
    }
}

#[test]
fn edit_gate_k004_move_into_a_list_with_shifted_numbers_aligns_the_whole_list() {
    // 番号のずれたリストの末尾へ移して入れる。1 R / 2 作業 / 3 a / 4 b / 5 c / 6 後で / 7 x / 8 y
    let source = "# R\n\n## 作業\n1. a\n5. b\n6. c\n\n## 後で\n- x\n- y\n";
    let expected = "# R\n\n## 作業\n1. a\n2. b\n3. c\n4. x\n\n## 後で\n- y\n";
    assert_eq!(
        children_of(expected, 2),
        ["1. a", "2. b", "3. c", "4. x"],
        "期待の文書"
    );
    let result = move_node(source, (7, "x"), (2, "作業"));
    assert_result(source, &result, expected, (6, "4. x"), false);
}

#[test]
fn edit_gate_k004_join_at_the_end_of_a_list_with_shifted_numbers_aligns_the_whole_list() {
    // 見出しの下に種類の違うリストが 2 つ (リストの入れ物)。いちばん後ろの始点の枝が入れ物なので、合流点はそのリストの最後の項目に
    // 足す。番号のずれたリストなら、前の項目も図の番号にそろえる (本文だけを比べる。合流の行の書き方は見ない)。
    // 1 R / 2 入れ物 / 3 p / 4 q / 5 入れ物 / 6 a / 7 b / 8 c
    let source = "---\nmarkdag:\n---\n# R\n- p\n- q\n\n1. a\n5. b\n6. c\n";
    let result = join_into_new(source, &[(6, "1. a"), (7, "2. b")]);
    let after = applied(source, &result);
    assert_eq!(
        body_of(&after),
        "# R\n- p\n- q\n\n1. a\n2. b\n3. c\n4. 合流点\n",
        "{after:?}"
    );
    assert_eq!(
        children_of(&after, 5),
        ["1. a", "2. b", "3. c", "4. 合流点"]
    );
    assert_eq!(result["select"], selected((9, "4. 合流点")), "{result}");
}

#[test]
fn edit_gate_k004_sequential_and_same_number_lists_keep_their_rules() {
    // 今の決まりのまま: 連番のリストは続きの番号を足し、前の項目は変えない。全部同じ番号のリストは同じ番号で足す
    // (子を足す、移して入れる、合流で末尾に足す)
    // [a, b, c の番号, 足す項目の番号]
    for [a, b, c, n] in [["1", "2", "3", "4"], ["1", "1", "1", "1"]] {
        let source = format!("# R\n{a}. a\n{b}. b\n{c}. c\n");
        let result = add_child(&source, (1, "R"));
        assert_result(
            &source,
            &result,
            &format!("{source}{n}. {NEW}\n"),
            (5, "4. 新しいノード"),
            true,
        );

        let source = format!("# R\n\n## 作業\n{a}. a\n{b}. b\n{c}. c\n\n## 後で\n- x\n- y\n");
        let result = move_node(&source, (7, "x"), (2, "作業"));
        assert_result(
            &source,
            &result,
            &format!("# R\n\n## 作業\n{a}. a\n{b}. b\n{c}. c\n{n}. x\n\n## 後で\n- y\n"),
            (6, "4. x"),
            false,
        );

        let source = format!("---\nmarkdag:\n---\n# R\n- p\n- q\n\n{a}. a\n{b}. b\n{c}. c\n");
        let result = join_into_new(&source, &[(6, "1. a"), (7, "2. b")]);
        let after = applied(&source, &result);
        assert_eq!(
            body_of(&after),
            format!("# R\n- p\n- q\n\n{a}. a\n{b}. b\n{c}. c\n{n}. 合流点\n"),
            "{after:?}"
        );
    }
}

// ---- K-005: ルートのタイトルの名前の入力は原文の title の文字のまま ----

// (原文, ルートの refText, 名前の入力の初めの値 = 原文の title の文字)
const TITLES: [(&str, &str, &str); 4] = [
    (
        "---\ntitle: <b>計画</b>\n---\n- 甲\n- 乙\n",
        "計画",
        "<b>計画</b>",
    ),
    (
        "---\ntitle: \"<b>計画</b> &amp; 実行\"\n---\n- 甲\n- 乙\n",
        "計画 & 実行",
        "<b>計画</b> &amp; 実行",
    ),
    (
        "---\ntitle: '**計画**'\n---\n- 甲\n- 乙\n",
        "**計画**",
        "**計画**",
    ),
    // 種類の違うリストが 2 つ (ルートは容器でない)
    (
        "---\ntitle: <i>計画</i>\n---\n- a\n\n1. b\n",
        "計画",
        "<i>計画</i>",
    ),
];

#[test]
fn edit_gate_k005_title_name_input_starts_from_the_title_as_written() {
    for (source, root, written) in TITLES {
        let facts = inspected(source, (1, root));
        assert_eq!(facts["canRename"], true, "{source:?}: {facts}");
        assert_eq!(facts["label"], written, "{source:?}: {facts}");
    }
}

#[test]
fn edit_gate_k005_editing_the_title_a_little_keeps_its_markup() {
    // 名前の入力の初めの値 (label) の末尾に 1 字足して決めると、title の書式 (<b> など) は残る。
    // 末尾は </b> のあとなので、足した字は書式の外 (<b>計画</b>書)。図の名前は「計画書」
    let source = "---\ntitle: <b>計画</b>\n---\n- 甲\n- 乙\n";
    let label = inspected(source, (1, "計画"))["label"]
        .as_str()
        .expect("label は文字")
        .to_string();
    let result = rename_node(source, (1, "計画"), &format!("{label}書"));
    assert_result(
        source,
        &result,
        "---\ntitle: <b>計画</b>書\n---\n- 甲\n- 乙\n",
        (1, "計画書"),
        false,
    );

    // 引用符で書いた title: 値の書き方 (引用符の有無) は決めていないので、読んだ title の値と図の名前を見る
    let source = "---\ntitle: \"<b>計画</b> &amp; 実行\"\n---\n- 甲\n- 乙\n";
    let label = inspected(source, (1, "計画 & 実行"))["label"]
        .as_str()
        .expect("label は文字")
        .to_string();
    let result = rename_node(source, (1, "計画 & 実行"), &format!("{label}!"));
    let after = applied(source, &result);
    assert_eq!(
        frontmatter_of(&after)["title"],
        "<b>計画</b> &amp; 実行!",
        "{after:?}"
    );
    assert_eq!(node_of(&after, 1).ref_text, "計画 & 実行!", "{after:?}");
    assert!(
        after.ends_with("---\n- 甲\n- 乙\n"),
        "本文は変えない: {after:?}"
    );
}

#[test]
fn edit_gate_k005_deciding_the_title_as_it_opened_changes_nothing() {
    // 項目と同じく、名前の入力の初めの値のまま決めると原文を変えない (same-name)
    for (source, root, _) in TITLES {
        let label = inspected(source, (1, root))["label"]
            .as_str()
            .expect("label は文字")
            .to_string();
        let result = rename_node(source, (1, root), &label);
        assert_eq!(result["status"], "unchanged", "{source:?}: {result}");
        assert_eq!(
            result["reason"]["code"], "same-name",
            "{source:?}: {result}"
        );
    }
}

#[test]
fn edit_gate_k005_title_that_is_not_text_starts_from_the_diagram_name() {
    // title が文字でないとき (数、真偽、一覧、null) と title がないときは、今までどおり名前の入力の初めの値は図の名前
    // (YAML として読んだ値。0x1F は 31 で、原文の字ではない)。label のまま決めると原文を変えない (same-name)。
    // レビューの G-03 で足した見張り。(frontmatter の中身 (なければ frontmatter を書かない), 図の名前)
    let cases: [(Option<&str>, &str); 8] = [
        (Some("title: 42"), "42"),
        (Some("title: 0x1F"), "31"),
        (Some("title: true"), "true"),
        (Some("title: [a, b]"), "a,b"),
        (Some("title: null"), ""),
        (Some("title:"), ""),
        (Some("markdag:"), ""),
        (None, ""),
    ];
    for (inner, name) in cases {
        for body in ["- 甲\n- 乙\n", "- a\n\n1. b\n"] {
            let source = match inner {
                Some(inner) => format!("---\n{inner}\n---\n{body}"),
                None => body.to_string(),
            };
            let facts = inspected(&source, (1, name));
            assert_eq!(facts["canRename"], true, "{source:?}: {facts}");
            assert_eq!(facts["label"], name, "{source:?}: {facts}");
            let result = rename_node(&source, (1, name), name);
            assert_eq!(result["status"], "unchanged", "{source:?}: {result}");
            assert_eq!(
                result["reason"]["code"], "same-name",
                "{source:?}: {result}"
            );
        }
    }
}

// ---- K-008: 日付の形の値は引用符で囲まずに書く ----

// グループの名前の変更に使う文書。1 R / 2 a (g1)
const GROUPED: &str =
    "---\nmarkdag:\n    groups:\n        g1:\n            label: 準備\n---\n# R\n- a %g1\n";

// グループ g1 の label の行 (名前を label に変えたあと)
fn group_label_line(label: &str) -> String {
    let after = applied(GROUPED, &rename_group(GROUPED, "g1", label));
    let lines: Vec<&str> = after
        .split('\n')
        .filter(|line| line.trim_start().starts_with("label:"))
        .collect();
    assert_eq!(lines.len(), 1, "{after:?}");
    assert_eq!(
        frontmatter_of(&after)["markdag"]["groups"]["g1"]["label"],
        label,
        "読んだ名前はその名前: {after:?}"
    );
    lines[0].to_string()
}

#[test]
fn edit_gate_k008_date_like_group_names_are_written_without_quotes() {
    // 0.12.0 の書き方に戻す: 日付の形 (日付だけ、日付と時刻) の名前は、ほかの文字の名前と同じく引用符なしで書く
    for label in ["2026-10-06", "2026-10-06T09:30:00", "2026-10-06 09:30:00"] {
        assert_eq!(
            group_label_line(label),
            format!("            label: {label}"),
            "{label:?}"
        );
    }
}

#[test]
fn edit_gate_k008_yes_no_on_off_are_still_quoted() {
    // 今までどおり: 真偽に読まれる語は、グループの名前も title も引用符で囲む
    for word in ["yes", "no", "on", "off"] {
        let line = group_label_line(word);
        assert!(
            [
                format!("            label: \"{word}\""),
                format!("            label: '{word}'")
            ]
            .contains(&line),
            "{word:?}: {line:?}"
        );

        let source = "---\ntitle: T\n---\n- a\n- b\n";
        let after = applied(source, &rename_node(source, (1, "T"), word));
        assert!(
            after.starts_with(&format!("---\ntitle: \"{word}\"\n"))
                || after.starts_with(&format!("---\ntitle: '{word}'\n")),
            "{word:?}: {after:?}"
        );
        assert_eq!(node_of(&after, 1).ref_text, word, "{after:?}");
    }
}

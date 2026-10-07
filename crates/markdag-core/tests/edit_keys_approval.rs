// GUI 編集のキーの手直しで、例の承認 (2026-10-06) に依頼者が今の作りと違う答えをした挙動のうち、原文の書き換えの層のものを、
// 直す前に落ちるテストとして書く。期待は決まった挙動から書き、今の書き換えの出力はなぞらない。
// - ルートのタイトル: 見出しのない文書のルート (原文の本文に行を持たず、名前は frontmatter の title) の名前を変えられる。
//   名前の入力の初めの値は今の title。決めた名前を title に書き、title がなければ足す (frontmatter がなければ作る)。
//   ルートが容器のもの (リストだけの文書) と、容器でないもの (種類の違うリストが 2 つ) の両方を見る
// - U7-first: 連番のリストで先頭を消すか外へ移したときは、消す前の始まりの番号から振り直す (1 以外から始まるリストはその番号から)
// - U7-digits: 番号の桁が増えて子の字下げが足りなくなるときは、子が子のままになるだけ字下げを書き直す。
//   足りているときと、桁が減るときは字下げを変えない
// 公開の markdag_core::edit (edit_source、inspect_node) と解析 (parse_document) だけを使う。指すノードは操作の前に原文の解析で
// id と refText を確かめ、期待の文書は比べる前に解析し直して、ねらいの名前と親子で読まれることを確かめる
// (期待の書き誤りを、直す前の赤の確認で見分けるため)。
// 関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める。
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
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

// 名前が ref_text のノード (文書で 1 つ)
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

// 親 parent の子の refText を文書の順に
fn children_of(source: &str, parent: u32) -> Vec<String> {
    parse_document(source)
        .nodes
        .into_iter()
        .filter(|node| node.parent == Some(parent))
        .map(|node| node.ref_text)
        .collect()
}

// 名前が child のノードの親の名前
fn parent_name(source: &str, child: &str) -> String {
    let parent = named(source, child)
        .parent
        .unwrap_or_else(|| panic!("{child:?} に親がある: {source:?}"));
    node_of(source, parent).ref_text
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

fn rename_node(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "renameNode", "node": node_json(node), "label": label }),
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

// inspect_node の結果 (JSON)。ノードがなければ null
fn inspected(source: &str, node: Target) -> Value {
    assert_target(source, node);
    let target: NodeTarget = serde_json::from_value(node_json(node)).expect("NodeTarget の JSON");
    normalized(serde_json::to_value(inspect_node(source, &target)).expect("JSON にできる"))
}

// 解析した frontmatter の値 (JSON)
fn frontmatter_of(text: &str) -> Value {
    serde_json::to_value(parse_document(text).frontmatter).expect("JSON にできる")
}

// frontmatter の中の行 (開きと閉じの --- を除く) と本文。frontmatter がなければ None
fn split_frontmatter(text: &str) -> Option<(Vec<String>, String)> {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.first() != Some(&"---") {
        return None;
    }
    let close = lines.iter().skip(1).position(|line| *line == "---")? + 1;
    let inner = lines[1..close]
        .iter()
        .map(|line| line.to_string())
        .collect();
    Some((inner, lines[close + 1..].join("\n")))
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

// ---- ルートのタイトル ----

// 名前の入力で決める新しい名前
const TITLE: &str = "新しい題";

#[test]
fn edit_approval_root_title_lineless_roots_can_be_renamed_and_start_from_the_title() {
    // (原文, ルートの refText)。名前の入力の初めの値は今の title (なければ空)
    let cases: [(&str, &str); 6] = [
        // リストだけの文書 (ルートはリストの容器)
        ("---\ntitle: リストだけ\n---\n- 甲\n- 乙\n", "リストだけ"),
        ("- 甲\n- 乙\n", ""),
        ("---\nmarkdag:\n    tasks: scratch\n---\n- 甲\n- 乙\n", ""),
        // 種類の違うリストが 2 つ (ルートは容器でない)
        ("---\ntitle: T\n---\n- a\n\n1. b\n", "T"),
        ("- a\n\n1. b\n", ""),
        // CRLF の文書
        ("---\r\ntitle: T\r\n---\r\n- a\r\n- b\r\n", "T"),
    ];
    for (source, title) in cases {
        assert_eq!(node_of(source, 1).parent, None, "{source:?}");
        let facts = inspected(source, (1, title));
        assert_eq!(facts["canRename"], true, "{source:?}: {facts}");
        assert_eq!(facts["label"], title, "{source:?}: {facts}");
    }
}

#[test]
fn edit_approval_root_title_rewrites_the_title() {
    // (原文, ルートの refText, 期待)。title の行の値だけを書き換え、ほかの行は変えない
    let cases: [(&str, &str, &str); 4] = [
        (
            "---\ntitle: リストだけ\n---\n- 甲\n- 乙\n",
            "リストだけ",
            "---\ntitle: 新しい題\n---\n- 甲\n- 乙\n",
        ),
        (
            "---\ntitle: T\n---\n- a\n\n1. b\n",
            "T",
            "---\ntitle: 新しい題\n---\n- a\n\n1. b\n",
        ),
        (
            "---\nmarkdag:\n    tasks: scratch\ntitle: T\n---\n- 甲\n- 乙\n",
            "T",
            "---\nmarkdag:\n    tasks: scratch\ntitle: 新しい題\n---\n- 甲\n- 乙\n",
        ),
        // CRLF の文書は行末の \r を残す
        (
            "---\r\ntitle: T\r\n---\r\n- a\r\n- b\r\n",
            "T",
            "---\r\ntitle: 新しい題\r\n---\r\n- a\r\n- b\r\n",
        ),
    ];
    for (source, title, expected) in cases {
        let result = rename_node(source, (1, title), TITLE);
        assert_rewritten(source, &result, expected, (1, TITLE));
    }
}

#[test]
fn edit_approval_root_title_adds_a_title_to_a_frontmatter_without_one() {
    // 空の frontmatter: その間に書く
    let source = "---\n---\n- 甲\n- 乙\n";
    let result = rename_node(source, (1, ""), TITLE);
    let after = applied(source, &result);
    assert_eq!(after, "---\ntitle: 新しい題\n---\n- 甲\n- 乙\n", "{result}");
    assert_eq!(result["select"], selected((1, TITLE)), "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");

    // ほかのキーがある frontmatter: 置き場 (先頭か末尾か) は決めていないので、最上位に title の行が 1 つ増えたことと、
    // ほかの行と本文が変わらないこと、読んだ値が変わらないことを見る
    let cases: [(&str, &[&str], &str); 2] = [
        (
            "---\nmarkdag:\n    tasks: scratch\n---\n- 甲\n- 乙\n",
            &["markdag:", "    tasks: scratch"],
            "- 甲\n- 乙\n",
        ),
        (
            "---\nmarkdag:\n    tasks: scratch\n---\n- a\n\n1. b\n",
            &["markdag:", "    tasks: scratch"],
            "- a\n\n1. b\n",
        ),
    ];
    for (source, kept, body) in cases {
        let result = rename_node(source, (1, ""), TITLE);
        let after = applied(source, &result);
        let (inner, rest) =
            split_frontmatter(&after).unwrap_or_else(|| panic!("frontmatter がある: {after:?}"));
        assert_eq!(rest, body, "本文は変わらない: {after:?}");
        let titles: Vec<&String> = inner
            .iter()
            .filter(|line| line.as_str() == "title: 新しい題")
            .collect();
        assert_eq!(titles.len(), 1, "title の行が 1 つ: {after:?}");
        let others: Vec<&str> = inner
            .iter()
            .filter(|line| line.as_str() != "title: 新しい題")
            .map(String::as_str)
            .collect();
        assert_eq!(others, kept, "ほかの行はそのまま: {after:?}");
        assert_eq!(frontmatter_of(&after)["markdag"]["tasks"], "scratch");
        assert_eq!(node_of(&after, 1).ref_text, TITLE, "{after:?}");
        assert_eq!(result["select"], selected((1, TITLE)), "{result}");
        assert_eq!(result["rename"], Value::Null, "{result}");
    }
}

#[test]
fn edit_approval_root_title_creates_a_frontmatter_when_there_is_none() {
    // 文書の先頭に frontmatter を作って title を書く。閉じの --- のあとの空行 (関係やグループで frontmatter を作るときの書き方) は、
    // 決めていないので、あってもなくてもよい
    for body in ["- 甲\n- 乙\n", "- a\n\n1. b\n"] {
        let result = rename_node(body, (1, ""), TITLE);
        let after = applied(body, &result);
        let with_blank = format!("---\ntitle: {TITLE}\n---\n\n{body}");
        let without_blank = format!("---\ntitle: {TITLE}\n---\n{body}");
        assert!(
            after == with_blank || after == without_blank,
            "{body:?} → {after:?}"
        );
        assert_eq!(node_of(&after, 1).ref_text, TITLE, "{after:?}");
        assert_eq!(result["select"], selected((1, TITLE)), "{result}");
        assert_eq!(result["rename"], Value::Null, "{result}");
    }
}

#[test]
fn edit_approval_root_title_names_yaml_would_read_differently_read_back_as_written() {
    // YAML の素の値では別の値に読まれる名前 (写像になる「: 」、注釈になる「#」、数の 0) も、図の名前と title の文字がその名前になる
    let sources: [(&str, &str); 2] = [
        ("---\ntitle: T\n---\n- a\n- b\n", "T"),
        ("---\nmarkdag:\n    tasks: scratch\n---\n- a\n- b\n", ""),
    ];
    for (source, title) in sources {
        for name in ["注意: 重要", "#1 案", "0"] {
            let result = rename_node(source, (1, title), name);
            let after = applied(source, &result);
            assert_eq!(node_of(&after, 1).ref_text, name, "{after:?}");
            assert_eq!(frontmatter_of(&after)["title"], name, "{after:?}");
            assert_eq!(result["select"], selected((1, name)), "{result}");
        }
    }
}

#[test]
fn edit_approval_root_title_follows_references_that_name_the_root() {
    // ルートを title の名前で指す関係は、名前の変更の追随で新しい名前に書き直す (ノードの名前の変更と同じ)
    let source = "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - T --> c\n---\n- a\n    - c\n\n1. b\n";
    let expected = "---\ntitle: U\nmarkdag:\n    relations:\n        depends:\n            - U --> c\n---\n- a\n    - c\n\n1. b\n";
    let result = rename_node(source, (1, "T"), "U");
    assert_eq!(applied(source, &result), expected, "{result}");
    assert_eq!(result["select"], selected((1, "U")), "{result}");
}

#[test]
fn edit_approval_root_title_same_name_is_unchanged_and_an_empty_name_is_refused() {
    // ほかのノードの名前の変更と同じ: 今と同じ名前は原文を変えず、空の名前は断る
    let source = "---\ntitle: T\n---\n- a\n- b\n";
    let result = rename_node(source, (1, "T"), "T");
    assert_eq!(result["status"], "unchanged", "{result}");
    assert_eq!(result["reason"]["code"], "same-name", "{result}");
    let result = rename_node(source, (1, "T"), "");
    assert_eq!(result["status"], "refused", "{result}");
    assert_eq!(result["reason"]["code"], "empty-name", "{result}");

    // title のない文書で空のまま決めても原文を変えない (今の名前が空のノードを空のまま決めたとき)
    let source = "- a\n- b\n";
    let result = rename_node(source, (1, ""), "");
    assert_eq!(result["status"], "unchanged", "{result}");
    assert_eq!(result["reason"]["code"], "same-name", "{result}");
}

// ---- U7-first: 先頭を消すか外へ移したときの始まりの番号 ----

// 1 手順 / 2 作業 / 3 停止 / 4 更新 / 5 再開。marker は区切りまでの番号の書き方 (「1.」「3.」「1)」) を項目ごとに返す
fn steps(marker: impl Fn(u32) -> String, tail: &str) -> String {
    let items: String = ["停止", "更新", "再開"]
        .iter()
        .enumerate()
        .map(|(index, name)| format!("{} {name}\n", marker(index as u32)))
        .collect();
    format!("# 手順\n\n## 作業\n{items}{tail}")
}

// (区切り, 始まりの番号)
const STARTS: [(char, u32); 3] = [('.', 1), ('.', 3), (')', 1)];

#[test]
fn edit_approval_first_delete_restarts_from_the_number_the_list_started_with() {
    for (delimiter, start) in STARTS {
        let source = steps(|index| format!("{}{delimiter}", start + index), "");
        let expected = format!(
            "# 手順\n\n## 作業\n{start}{delimiter} 更新\n{}{delimiter} 再開\n",
            start + 1
        );
        assert_eq!(
            children_of(&expected, 2),
            vec![format!("{start}. 更新"), format!("{}. 再開", start + 1)],
            "期待の文書: {expected:?}"
        );
        let result = delete_nodes(&source, &[(3, &format!("{start}. 停止"))]);
        assert_rewritten(&source, &result, &expected, (2, "作業"));
    }
}

#[test]
fn edit_approval_first_delete_with_other_items_restarts_once() {
    // 先頭を含めてまとめて消しても、残った項目を消す前の始まりの番号から 1 回で振り直す
    let source = "# 手順\n\n## 作業\n1. 停止\n2. 更新\n3. 確認\n4. 再開\n";
    // 1 手順 / 2 作業 / 3 停止 / 4 更新 / 5 確認 / 6 再開
    let cases: [(&[Target], &str); 2] = [
        (
            &[(3, "1. 停止"), (4, "2. 更新")],
            "# 手順\n\n## 作業\n1. 確認\n2. 再開\n",
        ),
        (
            &[(3, "1. 停止"), (5, "3. 確認")],
            "# 手順\n\n## 作業\n1. 更新\n2. 再開\n",
        ),
    ];
    for (nodes, expected) in cases {
        let result = delete_nodes(source, nodes);
        assert_rewritten(source, &result, expected, (2, "作業"));
    }
}

#[test]
fn edit_approval_first_move_out_restarts_from_the_number_the_list_started_with() {
    // リストの外 (別の見出しの子) へ移す。移した項目は移す先の最後の子の形
    for (delimiter, start) in STARTS {
        let source = steps(
            |index| format!("{}{delimiter}", start + index),
            "\n## 後で\n- 記録\n",
        );
        // 1 手順 / 2 作業 / 3 停止 / 4 更新 / 5 再開 / 6 後で / 7 記録
        let expected = format!(
            "# 手順\n\n## 作業\n{start}{delimiter} 更新\n{}{delimiter} 再開\n\n## 後で\n- 記録\n- 停止\n",
            start + 1
        );
        assert_eq!(
            children_of(&expected, 2),
            vec![format!("{start}. 更新"), format!("{}. 再開", start + 1)],
            "期待の文書: {expected:?}"
        );
        let result = move_node(&source, (3, &format!("{start}. 停止")), (6, "後で"));
        assert_moved(&source, &result, &expected, (7, "停止"), 5);
    }

    // 同じリストの 2 つ目の項目の子へ移す (先頭がリストから外れる)。子のない項目へは入れ子の項目 (字下げ 4) で書く
    let source = steps(|index| format!("{}.", 1 + index), "");
    let expected = "# 手順\n\n## 作業\n1. 更新\n    - 停止\n2. 再開\n";
    let result = move_node(&source, (3, "1. 停止"), (4, "2. 更新"));
    assert_moved(&source, &result, expected, (4, "停止"), 3);
}

#[test]
fn edit_approval_first_delete_and_move_in_a_list_container_restart_from_the_first_number() {
    // 見出しの下に種類の違うリストが 2 つ (容器と 1 行目を分け合う最初の項目。A-01)。
    // 1 R / 2 容器 / 3 p / 4 q / 5 容器 / 6 a / 7 b / 8 c
    let source = "# R\n- p\n- q\n\n1. a\n2. b\n3. c\n";
    let result = delete_nodes(source, &[(6, "1. a")]);
    assert_rewritten(source, &result, "# R\n- p\n- q\n\n1. b\n2. c\n", (5, ""));

    let result = move_node(source, (6, "1. a"), (7, "2. b"));
    assert_moved(
        source,
        &result,
        "# R\n- p\n- q\n\n1. b\n    - a\n2. c\n",
        (7, "a"),
        6,
    );
}

// ---- U7-digits: 番号の桁が変わるときの子の字下げ ----

const NEW: &str = "新しいノード";
const HEAD: &str = "# 手順\n\n## 作業\n";

// 1. 一 〜 8. 八 (1 手順 / 2 作業 / 3〜10 一〜八)
fn eight() -> String {
    ["一", "二", "三", "四", "五", "六", "七", "八"]
        .iter()
        .enumerate()
        .map(|(index, name)| format!("{}. {name}\n", index + 1))
        .collect()
}

// 9. 九 (id 11) の上に足す操作と、8. 八 (id 10) の下に足す操作。どちらも九は 10. になり、足したノードは 9. で id 11
fn add_before_nine(source: &str) -> [Value; 2] {
    [
        add_sibling_before(source, (11, "9. 九"), NEW),
        add_sibling(source, (10, "8. 八"), NEW),
    ]
}

#[test]
fn edit_approval_digits_growing_rewrites_child_indents_that_fall_short() {
    // 9. のあとの本文の位置は 3、10. は 4。字下げ 3 の子は 10. の子に読まれないので、子のままになるよう 4 に書き直す。
    // 孫と詳細も同じだけずらして、親子と詳細を保つ。(9. 九 の下の行, 10. 九 の下の行)
    let cases: [(&str, &str); 2] = [
        ("   - 細目\n", "    - 細目\n"),
        (
            "   > 詳細\n   - 細目\n     - 孫\n",
            "    > 詳細\n    - 細目\n      - 孫\n",
        ),
    ];
    for (under_nine, under_ten) in cases {
        let source = format!("{HEAD}{}9. 九\n{under_nine}", eight());
        assert_eq!(parent_name(&source, "細目"), "9. 九", "{source:?}");
        let expected = format!("{HEAD}{}9. {NEW}\n10. 九\n{under_ten}", eight());
        assert_eq!(
            parent_name(&expected, "細目"),
            "10. 九",
            "期待の文書: {expected:?}"
        );
        if under_ten.contains("孫") {
            assert_eq!(
                parent_name(&expected, "孫"),
                "細目",
                "期待の文書: {expected:?}"
            );
        }
        for result in add_before_nine(&source) {
            assert_added(&source, &result, &expected, (11, &format!("9. {NEW}")), 2);
        }
    }
}

#[test]
fn edit_approval_digits_growing_keeps_child_indents_that_are_enough() {
    // 字下げ 4 以上の子は 10. の子のまま読めるので、字下げを変えない (孫と詳細も)
    let unders = [
        "    - 細目\n",
        "      - 細目\n",
        "    - 細目\n      - 孫\n",
        "    > 詳細\n    - 細目\n",
    ];
    for under in unders {
        let source = format!("{HEAD}{}9. 九\n{under}", eight());
        assert_eq!(parent_name(&source, "細目"), "9. 九", "{source:?}");
        let expected = format!("{HEAD}{}9. {NEW}\n10. 九\n{under}", eight());
        assert_eq!(
            parent_name(&expected, "細目"),
            "10. 九",
            "期待の文書: {expected:?}"
        );
        for result in add_before_nine(&source) {
            assert_added(&source, &result, &expected, (11, &format!("9. {NEW}")), 2);
        }
    }
}

#[test]
fn edit_approval_digits_shrinking_keeps_the_indent() {
    // 10 項目のリストで 2. 二 を消すか外へ移すと、10. 十 は 9. になる。字下げ 4 の子 (と孫と詳細) は 9. の子のまま読めるので変えない
    // 1 手順 / 2 作業 / 3〜12 一〜十 / 13 以降は十の下
    let unders = ["    - 細目\n", "    > 詳細\n    - 細目\n      - 孫\n"];
    for under in unders {
        let numbered = |names: &[&str]| -> String {
            names
                .iter()
                .enumerate()
                .map(|(index, name)| format!("{}. {name}\n", index + 1))
                .collect()
        };
        let all = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
        let rest = ["一", "三", "四", "五", "六", "七", "八", "九", "十"];
        let source = format!("{HEAD}{}{under}", numbered(&all));
        assert_eq!(parent_name(&source, "細目"), "10. 十", "{source:?}");

        let expected = format!("{HEAD}{}{under}", numbered(&rest));
        assert_eq!(
            parent_name(&expected, "細目"),
            "9. 十",
            "期待の文書: {expected:?}"
        );
        let result = delete_nodes(&source, &[(4, "2. 二")]);
        assert_rewritten(&source, &result, &expected, (2, "作業"));

        let source = format!("{HEAD}{}{under}\n## 後で\n- 記録\n", numbered(&all));
        let expected = format!("{HEAD}{}{under}\n## 後で\n- 記録\n- 二\n", numbered(&rest));
        assert_eq!(
            parent_name(&expected, "細目"),
            "9. 十",
            "期待の文書: {expected:?}"
        );
        let moved = named(&expected, "二").id;
        let later = named(&source, "後で").id;
        let result = move_node(&source, (4, "2. 二"), (later, "後で"));
        let parent = named(&expected, "後で").id;
        assert_moved(&source, &result, &expected, (moved, "二"), parent);
    }
}

#[test]
fn edit_approval_digits_three_digit_numbers() {
    // 98 から始まるリスト (1 手順 / 2 作業 / 3 a / 4 b / 5 c)。99. b の上に足すと b は 100. になり、本文の位置は 4 から 5 へ。
    // 字下げ 4 の子は足りないので 5 に書き直し、字下げ 5 の子は足りているのでそのまま
    let cases: [(&str, &str); 2] = [("    - c\n", "     - c\n"), ("     - c\n", "     - c\n")];
    for (under99, under100) in cases {
        let source = format!("{HEAD}98. a\n99. b\n{under99}");
        assert_eq!(parent_name(&source, "c"), "99. b", "{source:?}");
        let expected = format!("{HEAD}98. a\n99. {NEW}\n100. b\n{under100}");
        assert_eq!(
            parent_name(&expected, "c"),
            "100. b",
            "期待の文書: {expected:?}"
        );
        let result = add_sibling_before(&source, (4, "99. b"), NEW);
        assert_added(&source, &result, &expected, (4, &format!("99. {NEW}")), 2);
    }

    // 100. が 99. に戻るとき (99. b を消す) は、字下げ 5 の子をそのまま
    let source = format!("{HEAD}98. a\n99. b\n100. c\n     - d\n");
    let expected = format!("{HEAD}98. a\n99. c\n     - d\n");
    assert_eq!(
        parent_name(&expected, "d"),
        "99. c",
        "期待の文書: {expected:?}"
    );
    let result = delete_nodes(&source, &[(4, "99. b")]);
    assert_rewritten(&source, &result, &expected, (2, "作業"));
}

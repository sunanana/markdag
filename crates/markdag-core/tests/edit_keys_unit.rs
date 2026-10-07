// GUI 編集のキーの手直しで足した書き換えの単体テスト。期待は spec.md の「兄弟を上に足す」「挙動の細部」「例の承認で決めたこと」と
// 承認した受け入れの例から書き、今の書き換えの出力はなぞらない。ほかのファイルが見ている所は重ねない
// (全部同じ番号のリストは edit_same_number_lists、U7-first と U7-digits の基本とタイトルの基本は edit_keys_approval)。
// - 上に足す (addSiblingBefore): 選んだノードの 1 行目の前に同じ形で 1 行書く (見出しは同じ段の ATX、項目は同じ字下げと印、タスクは [ ])。
//   最初の兄弟の上にも足せる。ルートは兄弟がないので子を足す (下に足すときと同じ)。表、コード、画像と、リストの入れ物は断る
// - 番号の振り直し: 番号付きのリストに足す (上と下)、消す、移す、合流で足すと、残った兄弟の原文の番号を数えた番号 (図の名前) にそろえる。
//   入れ子のリストはそのリストだけ、別のリスト (別の印や区切り) は振り直さない。間に詳細や空行があっても同じ
// - タイトルの名前の変更: 見出しのないルートの名前は title に書く。見出しのあるルートは見出しを書き換え、title は変えない
// 公開の markdag_core::edit (edit_source、inspect_node) と解析 (parse_document) だけを使う。指すノードは操作の前に原文の解析で
// id と refText を確かめ、期待の文書は比べる前に解析し直して、ねらいの名前と親子で読まれることを確かめる。
// 空行の置き方を決めていない所は、空でない行の並びだけを比べる。関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

type Target<'a> = (u32, &'a str);

const NEW: &str = "新しいノード";
const JOINED: &str = "合流点";

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

fn nodes_of(source: &str) -> Vec<OutlineNode> {
    parse_document(source).nodes
}

fn node_of(source: &str, id: u32) -> OutlineNode {
    nodes_of(source)
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

// 名前が ref_text のノード (文書で 1 つ)
fn named(source: &str, ref_text: &str) -> OutlineNode {
    let found: Vec<OutlineNode> = nodes_of(source)
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

// 名前で引いた指す相手 (id と refText)
fn target_named(source: &str, ref_text: &str) -> (u32, String) {
    (named(source, ref_text).id, ref_text.to_string())
}

// 親 parent の子の refText を文書の順に
fn children_of(source: &str, parent: u32) -> Vec<String> {
    nodes_of(source)
        .into_iter()
        .filter(|node| node.parent == Some(parent))
        .map(|node| node.ref_text)
        .collect()
}

// 名前が parent のノードの子の名前 (文書の順)
fn children_named(source: &str, parent: &str) -> Vec<String> {
    children_of(source, named(source, parent).id)
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

fn inspected(source: &str, node: Target) -> Value {
    assert_target(source, node);
    let target: NodeTarget = serde_json::from_value(node_json(node)).expect("NodeTarget の JSON");
    normalized(serde_json::to_value(inspect_node(source, &target)).expect("JSON にできる"))
}

fn frontmatter_of(text: &str) -> Value {
    serde_json::to_value(parse_document(text).frontmatter).expect("JSON にできる")
}

// 空でない行 (空行の置き方を決めていない所の比べに使う)
fn non_blank(text: &str) -> Vec<&str> {
    text.split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect()
}

// 足した結果: 原文の全体、select と rename が足したノード、notes が空
fn assert_added(source: &str, result: &Value, expected: &str, added: Target) {
    assert_eq!(
        node_of(expected, added.0).ref_text,
        added.1,
        "期待の文書: {expected:?}"
    );
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], selected(added), "{result}");
    assert_eq!(result["rename"], renamed(added), "{result}");
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

fn assert_refused(result: &Value, code: &str) {
    assert_eq!(result["status"], "refused", "{result}");
    assert_eq!(result["reason"]["code"], code, "{result}");
}

// ---- 上に足す (addSiblingBefore) ----

#[test]
fn edit_unit_add_before_writes_a_heading_of_the_same_level_before_the_heading() {
    // 3 段の見出しの途中 (b) と最初 (a) の上に足す。足す行は ### 新しいノード で、b (か a) の前、前の兄弟のブロックのあと。
    // 見出しのまわりの空行の置き方は承認した例 (add-before-heading) と同じ形を求めず、空でない行の並びと親子を見る
    let source = "# R\n\n## S\n\n### a\n- a1\n\n### b\n- b1\n\n## T\n";
    for (node, before) in [("b", "### b"), ("a", "### a")] {
        let target = target_named(source, node);
        let result = add_sibling_before(source, (target.0, &target.1));
        let after = applied(source, &result);
        let mut expected: Vec<&str> = non_blank(source);
        let at = expected
            .iter()
            .position(|line| *line == before)
            .expect("選んだ見出しの行");
        expected.insert(at, "### 新しいノード");
        assert_eq!(non_blank(&after), expected, "{node}: {after:?}");
        let mut siblings = vec!["a".to_string(), "b".to_string()];
        let index = siblings.iter().position(|name| name == node).expect("兄弟");
        siblings.insert(index, NEW.to_string());
        assert_eq!(children_named(&after, "S"), siblings, "{node}: {after:?}");
        let added = named(&after, NEW).id;
        assert_eq!(result["select"], selected((added, NEW)), "{result}");
        assert_eq!(result["rename"], renamed((added, NEW)), "{result}");
        // ほかの段の見出しは増えない
        assert_eq!(children_named(&after, "R"), ["S", "T"], "{after:?}");
    }
}

#[test]
fn edit_unit_add_before_writes_an_item_of_the_same_indent_and_marker() {
    // (原文, 選ぶ項目, 期待)。印 (- * +) と字下げは選んだ項目と同じ。名前、タスクの状態、タグは写さない
    let cases: [(&str, &str, &str); 5] = [
        ("# R\n- a\n- b\n", "b", "# R\n- a\n- 新しいノード\n- b\n"),
        ("# R\n* a\n* b\n", "b", "# R\n* a\n* 新しいノード\n* b\n"),
        ("# R\n+ a\n+ b\n", "a", "# R\n+ 新しいノード\n+ a\n+ b\n"),
        // 2 つの空白で字下げした入れ子の最初の項目
        (
            "# R\n- a\n  - a1\n  - a2\n",
            "a1",
            "# R\n- a\n  - 新しいノード\n  - a1\n  - a2\n",
        ),
        // タグのある項目の上: タグは写さない
        (
            "---\nmarkdag:\n---\n# R\n- a\n- b #owner:x\n",
            "b",
            "---\nmarkdag:\n---\n# R\n- a\n- 新しいノード\n- b #owner:x\n",
        ),
    ];
    for (source, node, expected) in cases {
        let target = target_named(source, node);
        let result = add_sibling_before(source, (target.0, &target.1));
        let added = named(expected, NEW).id;
        assert_eq!(
            node_of(expected, added).parent,
            named(expected, node).parent,
            "期待の文書: {expected:?}"
        );
        assert_added(source, &result, expected, (added, NEW));
    }
}

#[test]
fn edit_unit_add_before_a_task_writes_an_unstarted_task() {
    // 状態によらず [ ] で書く (承認した例 add-before-task)。印と番号は選んだ項目と同じ形
    let cases: [(&str, &str, &str, &str); 4] = [
        (
            "# R\n- [x] a\n- [ ] b\n",
            "a",
            "# R\n- [ ] 新しいノード\n- [x] a\n- [ ] b\n",
            NEW,
        ),
        (
            "# R\n- [ ] a\n- [/] b\n",
            "b",
            "# R\n- [ ] a\n- [ ] 新しいノード\n- [/] b\n",
            NEW,
        ),
        (
            "# R\n* [-] a\n",
            "a",
            "# R\n* [ ] 新しいノード\n* [-] a\n",
            NEW,
        ),
        // 番号付きのタスク: 選んだ項目の番号で書き、後ろを振り直す
        (
            "# R\n1. [x] a\n2. [ ] b\n",
            "1. a",
            "# R\n1. [ ] 新しいノード\n2. [x] a\n3. [ ] b\n",
            "1. 新しいノード",
        ),
    ];
    for (source, node, expected, added) in cases {
        let target = target_named(source, node);
        let result = add_sibling_before(source, (target.0, &target.1));
        let id = named(expected, added).id;
        assert!(
            node_of(expected, id).task.is_some(),
            "期待の文書: {expected:?}"
        );
        assert_added(source, &result, expected, (id, added));
    }
}

#[test]
fn edit_unit_add_before_a_numbered_item_takes_its_number_and_renumbers_the_rest() {
    // (原文, 選ぶ項目, 期待, 足した項目の名前)
    let cases: [(&str, &str, &str, &str); 4] = [
        // 最初の項目の上
        (
            "# R\n1. a\n2. b\n3. c\n",
            "1. a",
            "# R\n1. 新しいノード\n2. a\n3. b\n4. c\n",
            "1. 新しいノード",
        ),
        // 最後の項目の上
        (
            "# R\n1. a\n2. b\n3. c\n",
            "3. c",
            "# R\n1. a\n2. b\n3. 新しいノード\n4. c\n",
            "3. 新しいノード",
        ),
        // 区切りが「)」: 区切りを保つ。図の名前は「.」の形
        (
            "# R\n1) a\n2) b\n",
            "2. b",
            "# R\n1) a\n2) 新しいノード\n3) b\n",
            "2. 新しいノード",
        ),
        // 3 から始まるリスト: 始まりの番号を保つ (U7-start)
        (
            "# R\n3. a\n4. b\n",
            "3. a",
            "# R\n3. 新しいノード\n4. a\n5. b\n",
            "3. 新しいノード",
        ),
    ];
    for (source, node, expected, added) in cases {
        let target = target_named(source, node);
        let result = add_sibling_before(source, (target.0, &target.1));
        let id = named(expected, added).id;
        assert_added(source, &result, expected, (id, added));
    }
}

#[test]
fn edit_unit_add_before_the_first_sibling_of_a_list_and_a_list_container() {
    // 最初の兄弟の上にも足せる (S-05 は今のまま): リストだけの文書の先頭、見出しの下の 2 つのリストのそれぞれの先頭、入れ子の最初の項目
    let cases: [(&str, &str, &str, &str); 5] = [
        ("- 甲\n- 乙\n", "甲", "- 新しいノード\n- 甲\n- 乙\n", NEW),
        (
            "---\ntitle: T\n---\n- 甲\n- 乙\n",
            "甲",
            "---\ntitle: T\n---\n- 新しいノード\n- 甲\n- 乙\n",
            NEW,
        ),
        (
            "# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n",
            "赤",
            "# 二つのリスト\n\n- 新しいノード\n- 赤\n- 青\n\n1. 一号\n2. 二号\n",
            NEW,
        ),
        (
            "# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n",
            "1. 一号",
            "# 二つのリスト\n\n- 赤\n- 青\n\n1. 新しいノード\n2. 一号\n3. 二号\n",
            "1. 新しいノード",
        ),
        (
            "# R\n- a\n    - a1\n- b\n",
            "a1",
            "# R\n- a\n    - 新しいノード\n    - a1\n- b\n",
            NEW,
        ),
    ];
    for (source, node, expected, added) in cases {
        let target = target_named(source, node);
        let result = add_sibling_before(source, (target.0, &target.1));
        let id = named(expected, added).id;
        // 足した項目の親は、選んだ項目の親 (容器は名前が空)
        let parent_of = |text: &str, id: u32| -> String {
            node_of(text, node_of(text, id).parent.expect("親がある")).ref_text
        };
        assert_eq!(
            parent_of(expected, id),
            parent_of(source, target.0),
            "期待の文書: {expected:?}"
        );
        assert_added(source, &result, expected, (id, added));
    }
}

#[test]
fn edit_unit_add_before_goes_after_the_whole_block_of_the_previous_sibling() {
    // 前の兄弟の詳細と入れ子の子のあと、選んだ項目の 1 行目の前に書く (詳細の引用と子のリストを割らない)
    let cases: [(&str, &str); 3] = [
        (
            "# R\n- a\n    > メモ\n- b\n",
            "# R\n- a\n    > メモ\n- 新しいノード\n- b\n",
        ),
        (
            "# R\n- a\n    - a1\n        - a11\n- b\n",
            "# R\n- a\n    - a1\n        - a11\n- 新しいノード\n- b\n",
        ),
        (
            "# R\n1. a\n    > メモ\n    - a1\n2. b\n",
            "# R\n1. a\n    > メモ\n    - a1\n2. 新しいノード\n3. b\n",
        ),
    ];
    for (source, expected) in cases {
        let b = if source.contains("2. b") { "2. b" } else { "b" };
        let added = if b == "b" {
            NEW
        } else {
            "2. 新しいノード"
        };
        let target = target_named(source, b);
        let result = add_sibling_before(source, (target.0, &target.1));
        let id = named(expected, added).id;
        assert_added(source, &result, expected, (id, added));
        // 前の兄弟の詳細と子はそのまま
        let a = if b == "b" { "a" } else { "1. a" };
        assert_eq!(
            children_named(expected, a),
            children_named(source, a),
            "{expected:?}"
        );
    }
}

#[test]
fn edit_unit_add_before_the_root_adds_a_child_like_add_sibling() {
    // ルートには兄弟がないので、下に足すときと同じく子を足す (見出しのルート、リストだけの文書のルート、見出しのない文書のルート)
    let sources = [
        "# 計画\n\n## 設計\n- 画面\n\n## 実装\n",
        "- 甲\n- 乙\n",
        "---\ntitle: T\n---\n- a\n\n1. b\n",
    ];
    for source in sources {
        let root = node_of(source, 1);
        assert_eq!(root.parent, None);
        let before = add_sibling_before(source, (1, &root.ref_text));
        let child = add_child(source, (1, &root.ref_text));
        // 子を足せない文書 (種類の違うリストが 2 つで見出しのない文書は、足すと容器ができて形が変わる) では、どちらも同じ理由で断る
        if !source.contains("1. b") {
            assert_eq!(before["status"], "edited", "{source:?}: {before}");
        }
        assert_eq!(before, child, "上に足すと子を足すが同じ: {source:?}");
        assert_eq!(
            before,
            add_sibling(source, (1, &root.ref_text)),
            "{source:?}"
        );
    }
}

#[test]
fn edit_unit_add_before_refuses_blocks_and_list_containers_like_add_sibling() {
    // 表、コード、画像のノードと、リストの入れ物は断る (下に足すときと同じ理由)。原文は変えない
    let shapes = "# 形\n\n## 表の親\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## コードの親\n\n```\ncode\n```\n\n## 画像の親\n\n![絵](a.png)\n";
    for parent in ["表の親", "コードの親", "画像の親"] {
        let block = node_of(shapes, named(shapes, parent).id + 1);
        assert_eq!(
            inspected(shapes, (block.id, &block.ref_text))["kind"],
            "block",
            "{parent}"
        );
        let before = add_sibling_before(shapes, (block.id, &block.ref_text));
        assert_refused(&before, "block-node");
        assert_eq!(
            before["reason"]["code"],
            add_sibling(shapes, (block.id, &block.ref_text))["reason"]["code"],
            "{parent}"
        );
    }
    let lists = "# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n";
    for container in [2, 5] {
        assert_eq!(inspected(lists, (container, ""))["kind"], "list");
        let before = add_sibling_before(lists, (container, ""));
        assert_refused(&before, "no-source-line");
        assert_eq!(
            before["reason"]["code"],
            add_sibling(lists, (container, ""))["reason"]["code"]
        );
    }
}

#[test]
fn edit_unit_add_before_refuses_a_stale_target() {
    // 原文に同じ id で同じ refText のノードがなければ断る
    let source = "# R\n- a\n- b\n";
    let result = edited_by(
        source,
        json!({ "kind": "addSiblingBefore", "node": { "id": 3, "refText": "x" }, "label": NEW }),
    );
    assert_refused(&result, "stale-node");
    let result = edited_by(
        source,
        json!({ "kind": "addSiblingBefore", "node": { "id": 9, "refText": "b" }, "label": NEW }),
    );
    assert_refused(&result, "stale-node");
}

#[test]
fn edit_unit_add_before_keeps_crlf_and_documents_without_a_final_newline() {
    // CRLF の文書は足す行にも \r を付け、番号を振り直した行の \r も残す
    let source = "# R\r\n1. a\r\n2. b\r\n";
    let result = add_sibling_before(source, (3, "2. b"));
    assert_added(
        source,
        &result,
        "# R\r\n1. a\r\n2. 新しいノード\r\n3. b\r\n",
        (3, "2. 新しいノード"),
    );
    let source = "# R\r\n- a\r\n- b\r\n";
    let result = add_sibling_before(source, (3, "b"));
    assert_added(
        source,
        &result,
        "# R\r\n- a\r\n- 新しいノード\r\n- b\r\n",
        (3, NEW),
    );
    // 改行で終わらない文書は、終わり方を変えない
    let source = "# R\n- a\n- b";
    let result = add_sibling_before(source, (3, "b"));
    assert_added(source, &result, "# R\n- a\n- 新しいノード\n- b", (3, NEW));
}

// ---- 番号の振り直し ----

#[test]
fn edit_unit_renumber_after_adding_below() {
    // (原文, 下に足す項目, 期待, 足した項目の名前)
    let cases: [(&str, &str, &str, &str); 4] = [
        // 途中の項目の下: 後ろを振り直す (U2)
        (
            "# R\n1. a\n2. b\n3. c\n",
            "2. b",
            "# R\n1. a\n2. b\n3. 新しいノード\n4. c\n",
            "3. 新しいノード",
        ),
        // 最後の項目の下: 前の番号 + 1。振り直すものはない
        (
            "# R\n1. a\n2. b\n",
            "2. b",
            "# R\n1. a\n2. b\n3. 新しいノード\n",
            "3. 新しいノード",
        ),
        // 詳細のある項目の下: 詳細のあとに書き、後ろを振り直す
        (
            "# R\n1. a\n    > メモ\n2. b\n    > メモ2\n3. c\n",
            "1. a",
            "# R\n1. a\n    > メモ\n2. 新しいノード\n3. b\n    > メモ2\n4. c\n",
            "2. 新しいノード",
        ),
        // 区切りが「)」
        (
            "# R\n1) a\n2) b\n",
            "1. a",
            "# R\n1) a\n2) 新しいノード\n3) b\n",
            "2. 新しいノード",
        ),
    ];
    for (source, node, expected, added) in cases {
        let target = target_named(source, node);
        let result = add_sibling(source, (target.0, &target.1));
        let id = named(expected, added).id;
        assert_added(source, &result, expected, (id, added));
    }
}

#[test]
fn edit_unit_renumber_only_the_list_that_changed() {
    // 入れ子の番号付きリストに足すと、そのリストだけを振り直す (外のリストは変えない)
    let source = "# R\n1. a\n    1. a1\n    2. a2\n    3. a3\n2. b\n";
    let expected = "# R\n1. a\n    1. a1\n    2. 新しいノード\n    3. a2\n    4. a3\n2. b\n";
    let target = target_named(source, "1. a1");
    let result = add_sibling(source, (target.0, &target.1));
    assert_added(
        source,
        &result,
        expected,
        (named(expected, "2. 新しいノード").id, "2. 新しいノード"),
    );
    assert_eq!(
        children_named(expected, "1. a"),
        ["1. a1", "2. 新しいノード", "3. a2", "4. a3"]
    );

    // 後ろに別のリスト (印のリスト、区切りの違う番号付きリスト) が続いても、足したリストだけを振り直す
    let cases: [(&str, &str); 2] = [
        (
            "# R\n\n1. a\n2. b\n\n- x\n- y\n",
            "# R\n\n1. a\n2. 新しいノード\n3. b\n\n- x\n- y\n",
        ),
        (
            "# R\n\n1. a\n2. b\n\n1) p\n2) q\n",
            "# R\n\n1. a\n2. 新しいノード\n3. b\n\n1) p\n2) q\n",
        ),
    ];
    for (source, expected) in cases {
        let target = target_named(source, "1. a");
        let result = add_sibling(source, (target.0, &target.1));
        assert_added(
            source,
            &result,
            expected,
            (named(expected, "2. 新しいノード").id, "2. 新しいノード"),
        );
    }
}

#[test]
fn edit_unit_renumber_with_blank_lines_between_items() {
    // 項目の間に空行のあるリスト (ゆるいリスト)。空行の置き方は決めていないので、空でない行の並びと子の数を見る
    // (ゆるいリストの項目の図の名前は、今の解析では番号だけ (「1.」) になるので、名前は原文の解析から引く)
    let source = "# R\n\n1. a\n\n2. b\n\n3. c\n";
    let first = node_of(source, 2).ref_text;
    let second = node_of(source, 3).ref_text;
    let after = applied(source, &add_sibling(source, (2, &first)));
    assert_eq!(
        non_blank(&after),
        ["# R", "1. a", "2. 新しいノード", "3. b", "4. c"],
        "{after:?}"
    );
    assert_eq!(children_of(&after, 1).len(), 4, "{after:?}");

    let after = applied(source, &delete_nodes(source, &[(3, &second)]));
    assert_eq!(non_blank(&after), ["# R", "1. a", "2. c"], "{after:?}");
    assert_eq!(children_of(&after, 1).len(), 2, "{after:?}");
}

#[test]
fn edit_unit_renumber_after_deleting() {
    // (原文, 消す項目, 期待)。選ぶのは親
    let source = "# R\n1. a\n2. b\n3. c\n4. d\n";
    let cases: [(&[Target], &str); 3] = [
        (&[(3, "2. b")], "# R\n1. a\n2. c\n3. d\n"),
        // まとめて消す (先頭を含まない): 1 回で振り直す (U7-multi)
        (&[(3, "2. b"), (4, "3. c")], "# R\n1. a\n2. d\n"),
        (&[(3, "2. b"), (5, "4. d")], "# R\n1. a\n2. c\n"),
    ];
    for (nodes, expected) in cases {
        let result = delete_nodes(source, nodes);
        assert_rewritten(source, &result, expected, (1, "R"));
    }
    // 区切りが「)」と、詳細のある項目を消す (詳細ごと消える)
    let source = "# R\n1) a\n2) b\n    > メモ\n3) c\n";
    let result = delete_nodes(source, &[(3, "2. b")]);
    assert_rewritten(source, &result, "# R\n1) a\n2) c\n", (1, "R"));
}

#[test]
fn edit_unit_renumber_after_deleting_the_first_item_of_a_nested_list() {
    // 入れ子の番号付きリストの先頭を消すと、そのリストだけを始まりの番号から振り直す (U7-first)。
    // 振り直したあとの原文は入れ子のまま読める (2. で始まる行は段落を割り込めないが、振り直すと 1. になる)
    // 1 R / 2 a / 3 a1 / 4 a2 / 5 b
    let source = "# R\n1. a\n    1. a1\n    2. a2\n2. b\n";
    let expected = "# R\n1. a\n    1. a2\n2. b\n";
    assert_eq!(children_named(expected, "1. a"), ["1. a2"], "期待の文書");
    let result = delete_nodes(source, &[(3, "1. a1")]);
    assert_rewritten(source, &result, expected, (2, "1. a"));
}

#[test]
fn edit_unit_renumber_after_moving_the_first_item_of_a_nested_list_out() {
    // 入れ子の番号付きリストの先頭を外 (別の項目の子) へ移すと、残ったリストを始まりの番号から振り直す (U7-first)。
    // 1 R / 2 a / 3 a1 / 4 a2 / 5 b
    let source = "# R\n1. a\n    1. a1\n    2. a2\n2. b\n";
    // 子のない項目の子へは、入れ子の項目 (字下げ 4 の「-」) で書く (移す先の最後の子の形がないとき)
    let expected = "# R\n1. a\n    1. a2\n2. b\n    - a1\n";
    assert_eq!(children_named(expected, "2. b"), ["a1"], "期待の文書");
    let result = move_node(source, (3, "1. a1"), (5, "2. b"));
    assert_rewritten(source, &result, expected, (named(expected, "a1").id, "a1"));
}

#[test]
fn edit_unit_renumber_after_deleting_the_first_of_ten_keeps_enough_indents() {
    // 10 項目のリストの先頭を消すと、1 から振り直し (U7-first)、10. 十 は 9. になる。字下げ 4 の子は 9. の子のまま読めるので変えない (U7-digits)
    let names = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
    let numbered = |names: &[&str]| -> String {
        names
            .iter()
            .enumerate()
            .map(|(index, name)| format!("{}. {name}\n", index + 1))
            .collect()
    };
    let source = format!("# R\n{}    - 細目\n", numbered(&names));
    let expected = format!("# R\n{}    - 細目\n", numbered(&names[1..]));
    assert_eq!(
        node_of(&expected, named(&expected, "細目").parent.expect("親")).ref_text,
        "9. 十"
    );
    let result = delete_nodes(&source, &[(2, "1. 一")]);
    assert_rewritten(&source, &result, &expected, (1, "R"));
}

#[test]
fn edit_unit_renumber_after_moving() {
    // 途中の項目を外へ移す: 残った兄弟を振り直す。移した項目は移す先の最後の子の形
    let source = "# R\n\n## 作業\n1. a\n2. b\n3. c\n\n## 後で\n- x\n";
    let expected = "# R\n\n## 作業\n1. a\n2. c\n\n## 後で\n- x\n- b\n";
    let b = target_named(source, "2. b");
    let later = target_named(source, "後で");
    let result = move_node(source, (b.0, &b.1), (later.0, &later.1));
    assert_rewritten(source, &result, expected, (named(expected, "b").id, "b"));

    // 番号付きのリストの末尾へ移す: 最後の番号 + 1 で書き、もとの番号付きの項目は変えない。もとのリストの残りは振り直す
    let source = "# R\n\n## 作業\n1. a\n2. b\n\n## 後で\n1. p\n2. q\n3. r\n";
    let expected = "# R\n\n## 作業\n1. a\n2. b\n3. q\n\n## 後で\n1. p\n2. r\n";
    let q = target_named(source, "2. q");
    let work = target_named(source, "作業");
    let result = move_node(source, (q.0, &q.1), (work.0, &work.1));
    assert_rewritten(
        source,
        &result,
        expected,
        (named(expected, "3. q").id, "3. q"),
    );
}

#[test]
fn edit_unit_renumber_after_joining_into_a_new_node_in_the_middle() {
    // 合流で足す新しいノードは、いちばん後ろの始点のあと。番号付きリストの途中なら、後ろの番号も振り直す (本文だけを比べる)
    let source = "---\nmarkdag:\n---\n# R\n1. a\n2. b\n3. c\n";
    let result = join_into_new(source, &[(2, "1. a"), (3, "2. b")]);
    let after = applied(source, &result);
    let body = after.split("---\n").last().expect("本文");
    assert_eq!(body, "# R\n1. a\n2. b\n3. 合流点\n4. c\n", "{after:?}");
    assert_eq!(
        children_named(&after, "R"),
        ["1. a", "2. b", "3. 合流点", "4. c"]
    );
    assert_eq!(result["select"], selected((4, "3. 合流点")), "{result}");
}

// ---- タイトルの名前の変更 ----

#[test]
fn edit_unit_root_title_quoted_and_number_titles() {
    // 引用符で書いた title と数の title も、決めた名前が図の名前になる。ほかの行は変えない
    for (source, title) in [
        (
            "---\ntitle: \"T\"\nmarkdag:\n    tasks: scratch\n---\n- a\n- b\n",
            "T",
        ),
        ("---\ntitle: 'T'\n---\n- a\n- b\n", "T"),
        ("---\ntitle: 12\n---\n- a\n- b\n", "12"),
    ] {
        assert_eq!(
            inspected(source, (1, title))["canRename"],
            true,
            "{source:?}"
        );
        let result = rename_node(source, (1, title), "U");
        let after = applied(source, &result);
        assert_eq!(node_of(&after, 1).ref_text, "U", "{after:?}");
        assert_eq!(frontmatter_of(&after)["title"], "U", "{after:?}");
        let before_lines: Vec<&str> = source
            .split('\n')
            .filter(|line| !line.starts_with("title:"))
            .collect();
        let after_lines: Vec<&str> = after
            .split('\n')
            .filter(|line| !line.starts_with("title:"))
            .collect();
        assert_eq!(
            after_lines, before_lines,
            "title のほかの行はそのまま: {after:?}"
        );
        assert_eq!(result["select"], selected((1, "U")), "{result}");
    }
}

#[test]
fn edit_unit_root_title_added_to_a_crlf_document_keeps_the_line_endings() {
    // CRLF の文書に title を足しても (frontmatter を作っても)、どの改行も \r\n のまま
    for source in ["---\r\nmarkdag:\r\n---\r\n- a\r\n- b\r\n", "- a\r\n- b\r\n"] {
        let result = rename_node(source, (1, ""), "題");
        let after = applied(source, &result);
        assert_eq!(node_of(&after, 1).ref_text, "題", "{after:?}");
        let lone = after
            .match_indices('\n')
            .filter(|(at, _)| !after[..*at].ends_with('\r'))
            .count();
        assert_eq!(lone, 0, "\\r のない改行がある: {after:?}");
    }
}

#[test]
fn edit_unit_root_with_a_heading_is_renamed_in_the_heading_not_the_title() {
    // 見出しのあるルートは見出しを書き換え、title は変えない (タイトルに書くのは見出しのない文書のルートだけ)
    let source = "---\ntitle: T\n---\n# R\n- a\n";
    let result = rename_node(source, (1, "R"), "新しい題");
    assert_rewritten(
        source,
        &result,
        "---\ntitle: T\n---\n# 新しい題\n- a\n",
        (1, "新しい題"),
    );
}

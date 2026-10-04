// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 6、7、8、10、11、12、13、14、15) を、直す前に落ちるテストとして書く。
// 原文の書き方の都合で断っていた操作を、原文を書き直して通す (scope.md の「最後の関門 GUI の操作の方針」)。
// 1. B-115: グループの定義の値が組でない (1 行のスカラ、複数行のスカラ、一覧) なら、組に書き直してから名前、色、枠を書く。
//    別名と、groups そのものが写像でないときは frontmatter-not-map のまま (細部 7)
// 2. B-121: 怠惰な続きの行も詳細として読み (inspect_node の details)、保存では詳細の行を全部 > 付きで書き直す。
//    中身が今と同じなら unchanged (細部 8、9)
// 3. B-096: joinIntoNew で、最後の始点 (文書の順) を含む最上位の枝がリストの入れ物なら、そのリストの最後に、入れ物に子を足すのと
//    同じ形の項目として足す。枝が表・コード・画像なら block-node のまま (細部 10〜12)
// 4. 見出しの詳細: setDetails を見出しで断らない。見出しの行のすぐ次に字下げなしの `> ` で書き、すぐ次の行が空でなければ
//    空行を 1 つはさむ。詳細だけを持つ項目を付け替えで見出しにするときも、見出しの詳細として書く (細部 16、メインの決定の細部 18)
// 5. marker-line: 下線の見出しと行頭に空白のある ATX の見出しを、同じ段の ATX の見出しに書き直してから印を書く。
//    2 行以上の下線の見出しは、つないだ名前が今と同じときだけ通す (細部 19)
// 6. flow-style: 書く道すじを含むいちばん外のフロー形式のブロックを、中の値ごと字下げの形に書き直してから書く。
//    コメント、アンカー、別名、タグ、明示のキー、一覧の中の 1 組の写像を含むブロックは flow-style のまま (細部 20、21)
// 7. block-scalar: relations の kind の値が | や > の複数行の文字なら、空でない行ごとに 1 項目の一覧に書き直してから書く (細部 22)
// 8. line-endings: 単独の \r を、文書の最初の \n の改行 (\n がなければ \n) にそろえてから書く (細部 23)
// 9. bom: BOM のすぐあとが --- の行の文書で markdag: を足す操作は、BOM を外してから書く。note は bom-removed (細部 24)
// 書き直して通したことは新しい note で知らせない (細部 28)。断るままのもの (ambiguous-reference、frontmatter-invalid、block-node、
// 名前が変わる 2 行以上の下線の見出し、書き直せないフロー形式) は守りのテストで見る。
// 書いた原文 (行) と、読み直したときの木と frontmatter の値 (図の見え方) の両方を見る。
// 変えない挙動 (今も通り、直したあとも通るもの) は、名前か注に「変えない」と書いた。
// 公開の markdag_core::edit (edit_source、inspect_node)、parse_document、build_model と types の型の名前だけを使う。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして見る。関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, GraphModel, NodeTarget, OutlineNode, RelationKind};
use serde_json::{Value, json};

// markdag キーだけの frontmatter (印と詳細を読む文書)
const MD: &str = "---\nmarkdag:\n---\n";
const CRLF_MD: &str = "---\r\nmarkdag:\r\n---\r\n";
// 定義 g (label G) だけの frontmatter
const DEFINED_G: &str = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n";

type Target<'a> = (u32, &'a str);

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

fn node((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

fn nodes_json(nodes: &[Target]) -> Vec<Value> {
    nodes.iter().map(|&target| node(target)).collect()
}

// 包みの写し: splices を後ろから原文の行 (split('\n')) に当てて \n でつなぐ
fn applied(source: &str, result: &Value) -> String {
    assert_eq!(result["status"], "edited", "書き換えるはず: {result}");
    let splices = result["splices"].as_array().expect("splices は配列");
    // start の昇順で重ならない
    let mut end = 0.0;
    for splice in splices {
        let start = splice["start"].as_f64().expect("start は数");
        assert!(
            start >= end,
            "splices は start の昇順で重ならない: {result}"
        );
        end = start + splice["deleteCount"].as_f64().expect("deleteCount は数");
    }
    let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
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

// 木の形 (id、親、refText)
fn ref_texts(source: &str) -> Vec<(u32, Option<u32>, String)> {
    nodes_of(source)
        .into_iter()
        .map(|node| (node.id, node.parent, node.ref_text))
        .collect()
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(
        node_of(source, id).ref_text,
        ref_text,
        "id {id} のノードの refText: {source:?}"
    );
}

fn inspect(source: &str, (id, ref_text): Target) -> Value {
    let target: NodeTarget =
        serde_json::from_value(node((id, ref_text))).expect("NodeTarget の JSON");
    normalized(
        serde_json::to_value(
            inspect_node(source, &target)
                .unwrap_or_else(|| panic!("id {id} の「{ref_text}」がある: {source:?}")),
        )
        .expect("JSON にできる"),
    )
}

fn model_of(source: &str) -> GraphModel {
    let parsed = parse_document(source);
    build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    )
}

fn diagnostic_codes(source: &str) -> Vec<String> {
    model_of(source)
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.code.clone())
        .collect()
}

// 線と参照と frontmatter の形の誤りの診断 (書き直した frontmatter が壊れていない)
fn is_broken(code: &str) -> bool {
    code.starts_with("ref-")
        || code.starts_with("relation-")
        || code.starts_with("yaml-")
        || code.starts_with("option-")
        || matches!(
            code,
            "cycle" | "shape-mismatch" | "duplicate-edge" | "self-loop" | "group-invalid"
        )
}

fn assert_not_broken(source: &str) {
    let broken: Vec<String> = diagnostic_codes(source)
        .into_iter()
        .filter(|code| is_broken(code))
        .collect();
    assert!(broken.is_empty(), "{source:?}: {broken:?}");
}

// 線 1 本: (始点、終点、relations の kind)
type Edge<'a> = (u32, u32, &'a str);

fn relation_kind(kind: &str) -> RelationKind {
    match kind {
        "depends" => RelationKind::Depends,
        "join" => RelationKind::Join,
        "fork" => RelationKind::Fork,
        "chain" => RelationKind::Chain,
        other => panic!("relations の kind でない: {other}"),
    }
}

// 原文を解析し直したモデルの relations に、これらの線がその kind で出て、壊れた線と参照と YAML の診断がない
fn assert_edges(source: &str, edges: &[Edge]) {
    let model = model_of(source);
    for &(from, to, kind) in edges {
        let kind = relation_kind(kind);
        assert!(
            model
                .relations
                .iter()
                .any(|relation| relation.source == from
                    && relation.target == to
                    && relation.kind == kind),
            "{from} --> {to} ({kind:?}) の線がある: {source:?}: {:?}",
            model.relations
        );
    }
    assert_not_broken(source);
}

// 原文の markdag.relations.<kind> を YAML として読み直した値
fn relations_value_of(source: &str, kind: &str) -> Value {
    let frontmatter = serde_json::to_value(parse_document(source).frontmatter)
        .expect("frontmatter は JSON にできる");
    frontmatter["markdag"]["relations"][kind].clone()
}

fn frontmatter_of(source: &str) -> Value {
    serde_json::to_value(parse_document(source).frontmatter).expect("frontmatter は JSON にできる")
}

// 閉じの --- の行のあとの本文
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
    let mut codes: Vec<String> = result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .map(|note| note["code"].as_str().expect("code は文字列").to_string())
        .collect();
    codes.sort();
    codes
}

// notes の code がちょうどこれだけ (並びは問わない)。書き直して通したことの note はない (細部 28)
fn assert_notes(result: &Value, expected: &[&str]) {
    let mut expected: Vec<String> = expected.iter().map(|code| code.to_string()).collect();
    expected.sort();
    assert_eq!(note_codes(result), expected, "{result}");
}

fn selected_nodes(nodes: &[Target]) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": nodes_json(nodes) }))
}

fn selected_edge(from: u32, to: u32) -> Value {
    normalized(
        json!({ "kind": "edge", "edge": { "kind": "depends", "source": from, "target": to } }),
    )
}

fn selected_group(id: &str) -> Value {
    json!({ "kind": "group", "id": id })
}

// 書き換えた結果: 原文の全体、select、rename が null、notes がちょうど notes
fn assert_rewritten(source: &str, result: &Value, expected: &str, select: &Value, notes: &[&str]) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(&result["select"], select, "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_notes(result, notes);
}

fn tags_of(source: &str, id: u32) -> Vec<(String, Vec<String>)> {
    node_of(source, id)
        .tags
        .iter()
        .map(|tag| (tag.key.clone(), tag.values.clone()))
        .collect()
}

fn tag(key: &str, values: &[&str]) -> (String, Vec<String>) {
    (
        key.to_string(),
        values.iter().map(|value| (*value).to_string()).collect(),
    )
}

// ---- 操作 ----

fn set_details(source: &str, target: Target, text: &str) -> Value {
    assert_target(source, target);
    run(
        source,
        json!({ "kind": "setDetails", "node": node(target), "text": text }),
    )
}

fn set_tag(source: &str, nodes: &[Target], key: &str, value: Option<&str>) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "setTag", "nodes": nodes_json(nodes), "key": key, "value": value, "replaceKey": null }),
    )
}

fn toggle_tag(source: &str, nodes: &[Target], key: &str, value: Option<&str>) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "toggleTag", "nodes": nodes_json(nodes), "key": key, "value": value }),
    )
}

fn remove_tag(source: &str, nodes: &[Target], key: &str) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "removeTag", "nodes": nodes_json(nodes), "key": key }),
    )
}

fn group_nodes(source: &str, nodes: &[Target]) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "groupNodes", "nodes": nodes_json(nodes) }),
    )
}

fn add_to_group(source: &str, group: &str, nodes: &[Target]) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "addToGroup", "group": group, "nodes": nodes_json(nodes) }),
    )
}

fn add_relation(source: &str, from: Target, to: Target) -> Value {
    assert_target(source, from);
    assert_target(source, to);
    run(
        source,
        json!({ "kind": "addRelation", "from": node(from), "to": node(to) }),
    )
}

fn join_into(source: &str, sources: &[Target], target: Target) -> Value {
    for &item in sources {
        assert_target(source, item);
    }
    assert_target(source, target);
    run(
        source,
        json!({ "kind": "joinInto", "sources": nodes_json(sources), "target": node(target) }),
    )
}

fn join_into_new(source: &str, sources: &[Target], label: &str) -> Value {
    for &item in sources {
        assert_target(source, item);
    }
    run(
        source,
        json!({ "kind": "joinIntoNew", "sources": nodes_json(sources), "label": label }),
    )
}

fn rename_node(source: &str, target: Target, label: &str) -> Value {
    assert_target(source, target);
    run(
        source,
        json!({ "kind": "renameNode", "node": node(target), "label": label }),
    )
}

fn delete_nodes(source: &str, nodes: &[Target]) -> Value {
    for &target in nodes {
        assert_target(source, target);
    }
    run(
        source,
        json!({ "kind": "deleteNodes", "nodes": nodes_json(nodes) }),
    )
}

fn move_node(source: &str, moved: Target, parent: Target) -> Value {
    assert_target(source, moved);
    assert_target(source, parent);
    run(
        source,
        json!({ "kind": "moveNode", "node": node(moved), "parent": node(parent) }),
    )
}

// 新しいグループ group<番号> の定義の行 (字下げの幅 4。label、color、boundary の順)
const GROUP_COLORS: [&str; 6] = [
    "#3B7DD8", "#2E9E6B", "#E8833A", "#8A5FC2", "#D64545", "#E0A100",
];

fn new_group(number: usize) -> String {
    format!(
        "        group{number}:\n            label: グループ {number}\n            color: \"{}\"\n            boundary: true\n",
        GROUP_COLORS[(number - 1) % GROUP_COLORS.len()]
    )
}

fn new_groups(number: usize) -> String {
    format!("    groups:\n{}", new_group(number))
}

// グループ 1 つ: (id、label、color、boundary)。どれも定義のあるグループ
type GroupRow<'a> = (&'a str, &'a str, Option<&'a str>, bool);

// 原文を解析し直したモデルの groups がこのとおりで (定義の順)、壊れた診断 (group-invalid を含む) がない
fn assert_groups(source: &str, rows: &[GroupRow]) {
    let model = model_of(source);
    let actual: Vec<(String, String, Option<String>, bool, bool)> = model
        .groups
        .iter()
        .map(|group| {
            (
                group.id.clone(),
                group.label.clone(),
                group.color.clone(),
                group.boundary,
                group.defined,
            )
        })
        .collect();
    let expected: Vec<(String, String, Option<String>, bool, bool)> = rows
        .iter()
        .map(|&(id, label, color, boundary)| {
            (
                id.to_string(),
                label.to_string(),
                color.map(str::to_string),
                boundary,
                true,
            )
        })
        .collect();
    assert_eq!(actual, expected, "{source:?}");
    assert_not_broken(source);
}

// ==== 1. B-115: 組でないグループの定義を組に書き直す ====

// records/final-gate/b115 の本文。1 計画 / 2 設計 (%dev) / 3 実装 / 4 テスト
const B115_BODY: &str = "\n# 計画\n\n- 設計 %dev\n- 実装\n- テスト\n";

fn b115(definitions: &str) -> String {
    format!("---\nmarkdag:\n    groups:\n{definitions}---\n{B115_BODY}")
}

// 組でない dev の定義の値: 1 行のスカラ (引用符なしとあり)、複数行のスカラ (| と >-)、一覧
const B115_WRONG: [&str; 5] = [
    "        dev: 開発\n",
    "        dev: \"開発\"\n",
    "        dev: |\n            開発\n            班\n",
    "        dev: >-\n            開発\n",
    "        dev:\n            - a\n            - b\n",
];

// 名前、色、枠を書く操作と、書き直した dev の定義と、読み直したグループ
fn b115_ops() -> [(Value, &'static str, GroupRow<'static>); 3] {
    [
        (
            json!({ "kind": "renameGroup", "group": "dev", "label": "開発班" }),
            "        dev:\n            label: 開発班\n",
            ("dev", "開発班", None, false),
        ),
        (
            json!({ "kind": "setGroupColor", "group": "dev", "color": "#D64545" }),
            "        dev:\n            color: \"#D64545\"\n",
            ("dev", "dev", Some("#D64545"), false),
        ),
        (
            json!({ "kind": "setGroupBoundary", "group": "dev", "boundary": true }),
            "        dev:\n            boundary: true\n",
            ("dev", "dev", None, true),
        ),
    ]
}

#[test]
fn edit_rewrite_b115_group_definitions_that_are_not_maps_are_rewritten_as_maps() {
    // b115 の頁の案 (a): 誤った値を消し、dev: の下に組で書く。凡例は書いた名前になり、group-invalid は消える。消えた値は知らせない
    for wrong in B115_WRONG {
        let source = b115(wrong);
        // 前提: 今の定義は読まれず、group-invalid (warning) で label は dev
        assert!(
            diagnostic_codes(&source).contains(&"group-invalid".to_string()),
            "{source:?}"
        );
        for (value, written, row) in b115_ops() {
            let expected = b115(written);
            assert_groups(&expected, &[row]);
            assert_eq!(
                model_of(&expected).groups_of.get(&2).cloned(),
                Some(vec!["dev".to_string()]),
                "{expected:?}"
            );
            let case = format!("{wrong:?} の {value}");
            let result = run(&source, value);
            assert_eq!(applied(&source, &result), expected, "{case}: {result}");
            assert_eq!(result["select"], selected_group("dev"), "{case}: {result}");
            assert_eq!(result["rename"], Value::Null, "{case}: {result}");
            assert_notes(&result, &[]);
        }
    }
}

#[test]
fn edit_rewrite_b115_keeps_other_definitions_the_indent_width_and_crlf() {
    // あとに続くほかのグループの定義は変えない
    let source = "---\nmarkdag:\n    groups:\n        dev: 開発\n        ops:\n            label: 運用\n---\n\n# 計画\n\n- 設計 %dev\n- 実装 %ops\n";
    let expected = "---\nmarkdag:\n    groups:\n        dev:\n            label: 開発班\n        ops:\n            label: 運用\n---\n\n# 計画\n\n- 設計 %dev\n- 実装 %ops\n";
    assert_groups(
        expected,
        &[("dev", "開発班", None, false), ("ops", "運用", None, false)],
    );
    let result = run(
        source,
        json!({ "kind": "renameGroup", "group": "dev", "label": "開発班" }),
    );
    assert_rewritten(source, &result, expected, &selected_group("dev"), &[]);

    // 字下げが 2 の frontmatter は、組の中も 2 の幅で書く
    let source = format!("---\nmarkdag:\n  groups:\n    dev: 開発\n---\n{B115_BODY}");
    let expected =
        format!("---\nmarkdag:\n  groups:\n    dev:\n      label: 開発班\n---\n{B115_BODY}");
    assert_groups(&expected, &[("dev", "開発班", None, false)]);
    let result = run(
        &source,
        json!({ "kind": "renameGroup", "group": "dev", "label": "開発班" }),
    );
    assert_rewritten(&source, &result, &expected, &selected_group("dev"), &[]);

    // CRLF の文書は書き直した行に \r を付ける
    let source = "---\r\nmarkdag:\r\n    groups:\r\n        dev: 開発\r\n---\r\n\r\n# 計画\r\n\r\n- 設計 %dev\r\n";
    let expected = "---\r\nmarkdag:\r\n    groups:\r\n        dev:\r\n            label: 開発班\r\n---\r\n\r\n# 計画\r\n\r\n- 設計 %dev\r\n";
    assert_groups(expected, &[("dev", "開発班", None, false)]);
    let result = run(
        source,
        json!({ "kind": "renameGroup", "group": "dev", "label": "開発班" }),
    );
    assert_rewritten(source, &result, expected, &selected_group("dev"), &[]);
}

#[test]
fn edit_rewrite_b115_still_refuses_aliases_and_groups_that_are_not_maps() {
    // 変えない (細部 7): 定義の値が別名 (*x) か、groups そのものが写像でない (スカラ、一覧) なら frontmatter-not-map
    for frontmatter in [
        "x: &x 開発\nmarkdag:\n    groups:\n        dev: *x\n",
        "markdag:\n    groups: 設計\n",
        "markdag:\n    groups:\n        - dev\n",
    ] {
        let source = format!("---\n{frontmatter}---\n{B115_BODY}");
        for (value, _, _) in b115_ops() {
            let case = format!("{frontmatter:?} の {value}");
            assert_reason(
                &run(&source, value),
                "refused",
                "frontmatter-not-map",
                &case,
            );
        }
    }
}

// ==== 2. B-121: 怠惰な続きの行も詳細として扱う ====

// records/final-gate/b121 の文書。1 計画 / 2 設計 (詳細の引用に > のない続きの行) / 3 実装
const B121_HEAD: &str = "---\nmarkdag:\n    details:\n        display: always\n---\n\n# 計画\n\n";
const B121_ITEMS: &str = "- 設計\n    > 画面の案\n    続きの行\n- 実装\n";

fn b121(items: &str) -> String {
    format!("{B121_HEAD}{items}")
}

// 怠惰な続きの行が 2 つ、> だけの行、深い字下げの怠惰な行のある詳細 (引用の段落が 2 つ)。1 R / 2 設計 / 3 実装
const LAZY_MANY: &str = "- 設計\n    > a\n    b\n    >\n    > c\n      d\n- 実装\n";

#[test]
fn edit_rewrite_b121_inspect_details_include_lazy_continuation_lines() {
    // 図 (解析) は怠惰な行も詳細に読む。詳細の入力の初めの値 (inspect_node の details) も図と同じ行にする
    let source = b121(B121_ITEMS);
    let parsed = node_of(&source, 2).details.unwrap_or_default();
    assert!(
        parsed.contains("画面の案") && parsed.contains("続きの行"),
        "{parsed:?}"
    );
    let found = inspect(&source, (2, "設計"));
    assert_eq!(found["details"], json!("画面の案\n続きの行"), "{found}");
    assert_eq!(found["canHaveDetails"], json!(true), "{found}");

    // 怠惰な行は行頭の空白を外し、> の行は今までどおり字下げと > と空白 1 つを外す。> だけの行は空の行
    let source = format!("{MD}# R\n{LAZY_MANY}");
    let parsed = node_of(&source, 2).details.unwrap_or_default();
    assert!(parsed.contains('b') && parsed.contains('d'), "{parsed:?}");
    assert_eq!(
        inspect(&source, (2, "設計"))["details"],
        json!("a\nb\n\nc\nd")
    );
}

#[test]
fn edit_rewrite_b121_set_details_rewrites_every_details_line_with_quote_marks() {
    // b121 の頁の案 (a): 怠惰な行を含む詳細の行を全部外し、入力の行ごとに > を付けて書く (最初の詳細の行の位置に)
    let source = b121(B121_ITEMS);
    for (text, items, details) in [
        (
            "画面の案を直した",
            "- 設計\n    > 画面の案を直した\n- 実装\n",
            Some("画面の案を直した"),
        ),
        (
            "画面の案\n続きの行\n追加",
            "- 設計\n    > 画面の案\n    > 続きの行\n    > 追加\n- 実装\n",
            Some("画面の案\n続きの行\n追加"),
        ),
        // 空の入力は詳細の行を全部外す
        ("", "- 設計\n- 実装\n", None),
    ] {
        let expected = b121(items);
        assert_eq!(
            inspect(&expected, (2, "設計"))["details"],
            json!(details),
            "{expected:?}"
        );
        assert_eq!(
            node_of(&expected, 2).details.is_some(),
            details.is_some(),
            "{expected:?}"
        );
        let result = set_details(&source, (2, "設計"), text);
        assert_rewritten(
            &source,
            &result,
            &expected,
            &selected_nodes(&[(2, "設計")]),
            &[],
        );
    }

    // 怠惰な行が 2 つ以上と > だけの行の詳細も、全部を外して書く
    let source = format!("{MD}# R\n{LAZY_MANY}");
    let expected = format!("{MD}# R\n- 設計\n    > x\n- 実装\n");
    let result = set_details(&source, (2, "設計"), "x");
    assert_rewritten(
        &source,
        &result,
        &expected,
        &selected_nodes(&[(2, "設計")]),
        &[],
    );
}

#[test]
fn edit_rewrite_b121_same_details_with_lazy_lines_are_rewritten_with_quote_marks() {
    // 改めた細部 9 (D-081): 今の詳細に怠惰な続きの行があれば、中身を変えずに保存しても詳細の行を全部 > 付きで書き直す (edited)。
    // b121 の頁の案 (a) の見本 (4-filled.png): > が補われるだけで、図の詳細は変わらない。改行の種類と前後の空行は問わない
    let source = b121(B121_ITEMS);
    let filled = b121("- 設計\n    > 画面の案\n    > 続きの行\n- 実装\n");
    assert_eq!(
        inspect(&filled, (2, "設計"))["details"],
        json!("画面の案\n続きの行")
    );
    assert_eq!(node_of(&filled, 2).details, node_of(&source, 2).details);
    for text in [
        "画面の案\n続きの行",
        "画面の案\r\n続きの行",
        "\n画面の案\n続きの行\n",
    ] {
        let result = set_details(&source, (2, "設計"), text);
        assert_rewritten(
            &source,
            &result,
            &filled,
            &selected_nodes(&[(2, "設計")]),
            &[],
        );
    }
    // 詳細の入力の初めの値のまま保存しても同じ (怠惰な行が 2 つ、> だけの行、深い字下げの怠惰な行)
    let source = format!("{MD}# R\n{LAZY_MANY}");
    let filled = format!("{MD}# R\n- 設計\n    > a\n    > b\n    >\n    > c\n    > d\n- 実装\n");
    let text = inspect(&source, (2, "設計"))["details"]
        .as_str()
        .expect("詳細がある")
        .to_string();
    assert_eq!(inspect(&filled, (2, "設計"))["details"], json!(text));
    assert_eq!(node_of(&filled, 2).details, node_of(&source, 2).details);
    let result = set_details(&source, (2, "設計"), &text);
    assert_rewritten(
        &source,
        &result,
        &filled,
        &selected_nodes(&[(2, "設計")]),
        &[],
    );
    // 見出しの詳細と CRLF の文書も
    let source = format!("{MD}# R\n## 設計\n> a\nb\n\n- 子\n");
    let result = set_details(&source, (2, "設計"), "a\nb");
    assert_rewritten(
        &source,
        &result,
        &format!("{MD}# R\n## 設計\n> a\n> b\n\n- 子\n"),
        &selected_nodes(&[(2, "設計")]),
        &[],
    );
    let source = format!("{CRLF_MD}# R\r\n- 設計\r\n    > a\r\n    b\r\n- 実装\r\n");
    let result = set_details(&source, (2, "設計"), "a\nb");
    assert_rewritten(
        &source,
        &result,
        &format!("{CRLF_MD}# R\r\n- 設計\r\n    > a\r\n    > b\r\n- 実装\r\n"),
        &selected_nodes(&[(2, "設計")]),
        &[],
    );
}

#[test]
fn edit_rewrite_b121_same_details_without_lazy_lines_are_unchanged() {
    // 変えない: 怠惰な続きの行を含まない詳細は、中身を変えずに保存したら unchanged (nothing-to-change)
    let source = b121("- 設計\n    > 画面の案\n    > 続きの行\n- 実装\n");
    for text in ["画面の案\n続きの行", "画面の案\r\n続きの行"] {
        assert_reason(
            &set_details(&source, (2, "設計"), text),
            "unchanged",
            "nothing-to-change",
            text,
        );
    }
}

#[test]
fn edit_rewrite_b121_lazy_lines_in_crlf_documents_and_heading_details() {
    // CRLF の文書: 読む値に \r を入れず、書き直す行に \r を付ける
    let source = format!("{CRLF_MD}# R\r\n- 設計\r\n    > a\r\n    b\r\n- 実装\r\n");
    assert_eq!(inspect(&source, (2, "設計"))["details"], json!("a\nb"));
    let result = set_details(&source, (2, "設計"), "x");
    assert_rewritten(
        &source,
        &result,
        &format!("{CRLF_MD}# R\r\n- 設計\r\n    > x\r\n- 実装\r\n"),
        &selected_nodes(&[(2, "設計")]),
        &[],
    );

    // 見出しの詳細の怠惰な行も同じ
    let source = format!("{MD}# R\n## 設計\n> a\nb\n\n- 子\n");
    assert!(node_of(&source, 2).details.is_some(), "{source:?}");
    assert_eq!(inspect(&source, (2, "設計"))["details"], json!("a\nb"));
    let result = set_details(&source, (2, "設計"), "x");
    assert_rewritten(
        &source,
        &result,
        &format!("{MD}# R\n## 設計\n> x\n\n- 子\n"),
        &selected_nodes(&[(2, "設計")]),
        &[],
    );
}

// ==== 3. B-096: 最上位の枝がリストの入れ物なら、そのリストの最後に足す ====

// records/final-gate/b096 の文書。見出しの下にリストが 2 つあり、どちらも入れ物 (容器) を持つ。
// 1 計画 / 2 容器 / 3 設計 / 4 実装 / 5 容器 / 6〜 2 つ目のリストの項目
const B096_HEAD: &str = "---\nmarkdag:\n---\n\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n";

fn b096(second: &str) -> String {
    format!("{B096_HEAD}{second}")
}

fn assert_join_new(result: &Value, chosen: Target) {
    assert_eq!(result["select"], selected_nodes(&[chosen]), "{result}");
    assert_eq!(
        result["rename"],
        normalized(json!({ "kind": "node", "node": node(chosen) })),
        "{result}"
    );
    assert_notes(result, &[]);
}

#[test]
fn edit_rewrite_b096_join_into_new_appends_an_item_to_the_container_list() {
    // b096 の頁の案: 最後の始点 (公開) を含む最上位の枝は容器 5 なので、そのリストの最後 (運用のあと) に項目として足す
    let source = b096("- 公開\n- 運用\n");
    for id in [2, 5] {
        assert_eq!(inspect(&source, (id, ""))["kind"], json!("list"));
    }
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - 設計 & 公開 --> 合流\n---\n\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n- 公開\n- 運用\n- 合流\n";
    assert_edges(expected, &[(3, 8, "join"), (6, 8, "join")]);
    assert_eq!(node_of(expected, 8).parent, Some(5), "{expected:?}");
    // 細部 10: 最後の始点は渡した順でなく文書の順
    for sources in [[(3, "設計"), (6, "公開")], [(6, "公開"), (3, "設計")]] {
        let result = join_into_new(&source, &sources, "合流");
        let after = applied(&source, &result);
        assert_eq!(body_of(&after), body_of(expected), "{sources:?}: {result}");
        let items = relations_value_of(&after, "join");
        assert!(
            items == json!(["設計 & 公開 --> 合流"]) || items == json!(["公開 & 設計 --> 合流"]),
            "{after:?}"
        );
        assert_edges(&after, &[(3, 8, "join"), (6, 8, "join")]);
        assert_join_new(&result, (8, "合流"));
    }

    // 最後の始点が前のリストにあれば、前のリストの最後 (段落の前) に足す
    let result = join_into_new(&source, &[(3, "設計"), (4, "実装")], "合流");
    let after = applied(&source, &result);
    assert_eq!(
        body_of(&after),
        "\n# 計画\n\n- 設計\n- 実装\n- 合流\n\n段落\n\n- 公開\n- 運用\n",
        "{result}"
    );
    assert_eq!(node_of(&after, 5).parent, Some(2), "{after:?}");
    assert_edges(&after, &[(3, 5, "join"), (4, 5, "join")]);
    assert_join_new(&result, (5, "合流"));

    // 始点が入れ子のリストの中でも、足すのは最上位の枝 (容器) のリスト。6 公開 / 7 公開の準備 / 8 運用
    let source = b096("- 公開\n    - 公開の準備\n- 運用\n");
    let result = join_into_new(&source, &[(3, "設計"), (7, "公開の準備")], "合流");
    let after = applied(&source, &result);
    assert_eq!(
        body_of(&after),
        "\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n- 公開\n    - 公開の準備\n- 運用\n- 合流\n",
        "{result}"
    );
    assert_eq!(node_of(&after, 9).parent, Some(5), "{after:?}");
    assert_edges(&after, &[(3, 9, "join"), (7, 9, "join")]);
    assert_join_new(&result, (9, "合流"));
}

#[test]
fn edit_rewrite_b096_the_added_item_follows_the_last_item_of_the_list() {
    // 細部 11: 容器に子を足すのと同じ形。番号付きは最後の番号 + 1、最後の項目がタスクなら [ ]、印は最後の項目の印
    for (second, added, new_ref) in [
        ("1. 公開\n2. 運用\n", "3. 合流", "3. 合流"),
        ("- [ ] 公開\n- [x] 運用\n", "- [ ] 合流", "合流"),
        ("* 公開\n* 運用\n", "* 合流", "合流"),
    ] {
        let source = b096(second);
        let first = node_of(&source, 6).ref_text;
        let result = join_into_new(&source, &[(3, "設計"), (6, &first)], "合流");
        let after = applied(&source, &result);
        assert_eq!(
            body_of(&after),
            format!("\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n{second}{added}\n"),
            "{second:?}: {result}"
        );
        let joined = node_of(&after, 8);
        assert_eq!(joined.ref_text, new_ref, "{after:?}");
        assert_eq!(joined.parent, Some(5), "{after:?}");
        assert_eq!(nodes_of(&after).len(), 8, "{after:?}");
        assert_edges(&after, &[(3, 8, "join"), (6, 8, "join")]);
        assert_join_new(&result, (8, new_ref));
    }
}

#[test]
fn edit_rewrite_b096_still_refuses_tables_code_and_images_as_the_top_branch() {
    // 変えない (細部 12): 最上位の枝が表・コード・画像なら block-node。1 R / 2 表 / 3 コード
    let source = format!("{MD}# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nx\n~~~\n");
    for id in [2, 3] {
        assert_eq!(inspect(&source, (id, ""))["kind"], json!("block"));
    }
    assert_reason(
        &join_into_new(&source, &[(2, ""), (3, "")], "合流"),
        "refused",
        "block-node",
        "表とコード",
    );
}

// ==== 4. 見出しの詳細を書く ====

// inspect_node の details と、解析のノードにも詳細があるか
fn assert_details_in(source: &str, target: Target, details: Option<&str>) {
    assert_eq!(
        inspect(source, target)["details"],
        json!(details),
        "{source:?}"
    );
    assert_eq!(
        node_of(source, target.0).details.is_some(),
        details.is_some(),
        "解析のノードの details: {source:?}"
    );
}

#[test]
fn edit_rewrite_heading_details_are_inspected_like_item_details() {
    // 見出しのすぐ下 (空行だけをはさんでよい) の引用が見出しの詳細。canHaveDetails は true
    for (source, target, details) in [
        (
            format!("{MD}# R\n## 設計\n> 詳細\n\n- 子\n"),
            (2, "設計"),
            "詳細",
        ),
        (
            format!("{MD}# R\n\n## 設計\n\n> 詳細\n\n- 子\n"),
            (2, "設計"),
            "詳細",
        ),
        (
            format!("{MD}# R\n> 1 行目\n>\n> **3** 行目\n\n## 設計\n"),
            (1, "R"),
            "1 行目\n\n**3** 行目",
        ),
        (
            format!("{MD}# R\n\n設計\n---\n> 詳細\n\n- 子\n"),
            (2, "設計"),
            "詳細",
        ),
    ] {
        let found = inspect(&source, target);
        assert_eq!(found["kind"], json!("heading"), "{source:?}");
        assert_eq!(found["canHaveDetails"], json!(true), "{source:?}");
        assert_details_in(&source, target, Some(details));
    }
    // ほかのものが先に来たあとの引用は詳細にしない (変えない読み方)。詳細を持てることは変わらない
    let source = format!("{MD}# R\n## 設計\n\n段落\n\n> 引用\n");
    assert_details_in(&source, (2, "設計"), None);
    assert_eq!(inspect(&source, (2, "設計"))["canHaveDetails"], json!(true));
}

#[test]
fn edit_rewrite_heading_details_are_written_right_below_the_heading() {
    // 細部 16: 見出しの行 (下線の見出しは下線の行) のすぐ次に字下げなしの `> ` で書き、すぐ次の行が空でなければ空行を 1 つはさむ
    let cases: Vec<(String, Target, &str, String)> = vec![
        (
            format!("{MD}# R\n## A\n- a\n"),
            (2, "A"),
            "d",
            format!("{MD}# R\n## A\n> d\n\n- a\n"),
        ),
        (
            format!("{MD}# R\n## A\n- a\n"),
            (1, "R"),
            "d",
            format!("{MD}# R\n> d\n\n## A\n- a\n"),
        ),
        // すぐ次の行が空なら、空行をはさまない
        (
            format!("{MD}# R\n\n## A\n\n- a\n"),
            (2, "A"),
            "d",
            format!("{MD}# R\n\n## A\n> d\n\n- a\n"),
        ),
        // 文書の終わり (改行で終わる、終わらない)
        (
            format!("{MD}# R\n## A\n"),
            (2, "A"),
            "d",
            format!("{MD}# R\n## A\n> d\n"),
        ),
        (
            format!("{MD}# R\n## A"),
            (2, "A"),
            "d",
            format!("{MD}# R\n## A\n> d"),
        ),
        // 複数行と空の行
        (
            format!("{MD}# R\n## A\n\n- a\n"),
            (2, "A"),
            "x\n\ny",
            format!("{MD}# R\n## A\n> x\n>\n> y\n\n- a\n"),
        ),
        // 見出しのすぐ下に段落があっても、引用は段落の前に書く (段落のあとでは詳細に読まれない)
        (
            format!("{MD}# R\n## A\n本文\n\n- a\n"),
            (2, "A"),
            "d",
            format!("{MD}# R\n## A\n> d\n\n本文\n\n- a\n"),
        ),
        // 下線の見出しは下線の行のすぐ次。行頭に空白のある見出しも字下げなしの > で書く
        (
            format!("{MD}# R\n\n設計\n---\n\n- 画面\n"),
            (2, "設計"),
            "d",
            format!("{MD}# R\n\n設計\n---\n> d\n\n- 画面\n"),
        ),
        (
            format!("{MD}# R\n\n ## 実装\n\n- 画面\n"),
            (2, "実装"),
            "d",
            format!("{MD}# R\n\n ## 実装\n> d\n\n- 画面\n"),
        ),
        // タスクの記号と印のある 1 行目は変えない
        (
            format!("{MD}# R\n## [ ] A #k %g\n- a\n"),
            (2, "A"),
            "d",
            format!("{MD}# R\n## [ ] A #k %g\n> d\n\n- a\n"),
        ),
        // CRLF
        (
            format!("{CRLF_MD}# R\r\n## A\r\n- a\r\n"),
            (2, "A"),
            "d",
            format!("{CRLF_MD}# R\r\n## A\r\n> d\r\n\r\n- a\r\n"),
        ),
    ];
    for (source, target, text, expected) in cases {
        let details = text.to_string();
        assert_details_in(&expected, target, Some(&details));
        assert_eq!(ref_texts(&expected), ref_texts(&source), "{expected:?}");
        let result = set_details(&source, target, text);
        assert_rewritten(&source, &result, &expected, &selected_nodes(&[target]), &[]);
    }
}

#[test]
fn edit_rewrite_heading_details_are_replaced_removed_and_unchanged() {
    // 詳細があればその行を置き換え、空の入力は外して重なった空行を詰める。同じ中身なら変えない
    for (head, between) in [("## A\n", ""), ("## A\n", "\n")] {
        let source = format!("{MD}# R\n{head}{between}> 古い\n\n- a\n");
        assert_details_in(&source, (2, "A"), Some("古い"));
        for (text, expected, details) in [
            (
                "新しい",
                format!("{MD}# R\n{head}{between}> 新しい\n\n- a\n"),
                Some("新しい"),
            ),
            (
                "x\ny",
                format!("{MD}# R\n{head}{between}> x\n> y\n\n- a\n"),
                Some("x\ny"),
            ),
            ("", format!("{MD}# R\n{head}\n- a\n"), None),
        ] {
            assert_details_in(&expected, (2, "A"), details);
            let result = set_details(&source, (2, "A"), text);
            assert_rewritten(
                &source,
                &result,
                &expected,
                &selected_nodes(&[(2, "A")]),
                &[],
            );
        }
        assert_reason(
            &set_details(&source, (2, "A"), "古い"),
            "unchanged",
            "nothing-to-change",
            &source,
        );
    }
}

#[test]
fn edit_rewrite_heading_details_add_markdag_to_documents_without_the_key() {
    // markdag キーのない文書は、項目の詳細と同じく markdag: (と frontmatter) を足してから書く
    let source = "# R\n## A\n";
    let expected = "---\nmarkdag:\n---\n\n# R\n## A\n> d\n";
    assert_details_in(expected, (2, "A"), Some("d"));
    let result = set_details(source, (2, "A"), "d");
    assert_eq!(applied(source, &result), expected, "{result}");
    assert_eq!(result["select"], selected_nodes(&[(2, "A")]), "{result}");
    assert!(
        note_codes(&result).contains(&"frontmatter-added".to_string()),
        "{result}"
    );
    let source = "---\ntitle: T\n---\n# R\n## A\n";
    let expected = "---\ntitle: T\nmarkdag:\n---\n# R\n## A\n> d\n";
    assert_details_in(expected, (2, "A"), Some("d"));
    let result = set_details(source, (2, "A"), "d");
    assert_rewritten(
        source,
        &result,
        expected,
        &selected_nodes(&[(2, "A")]),
        &["markdag-added"],
    );
}

#[test]
fn edit_rewrite_move_an_item_with_only_details_under_a_heading_writes_heading_details() {
    // メインの決定 (細部 18): 詳細 (引用) だけを持つ項目は、付け替えで見出しになるとき詳細を見出しの詳細として書いて通す
    // (見出しのすぐ下に字下げなしの >。見出しの前後の空行は、詳細のない項目を見出しにするときと同じ)
    for (details_lines, quoted, details) in [
        ("    > 詳細\n", "> 詳細\n", "詳細"),
        (
            "    > 1 行目\n    >\n    > 3 行目\n",
            "> 1 行目\n>\n> 3 行目\n",
            "1 行目\n\n3 行目",
        ),
    ] {
        let source = format!("{MD}# R\n## A\n## B\n- y\n{details_lines}");
        let expected = format!("{MD}# R\n## A\n\n### y\n{quoted}\n## B\n");
        assert_eq!(inspect(&expected, (3, "y"))["kind"], json!("heading"));
        assert_details_in(&expected, (3, "y"), Some(details));
        let result = move_node(&source, (4, "y"), (2, "A"));
        assert_rewritten(
            &source,
            &result,
            &expected,
            &selected_nodes(&[(3, "y")]),
            &[],
        );
    }
}

#[test]
fn edit_rewrite_move_an_item_with_continuation_under_a_heading_is_still_heading_details() {
    // 変えない (メインの決定の細部 18): 続きの段落を持つ項目は heading-details で断る (見出しの下の段落は読まれず、図から消えるため)
    for (source, moved) in [
        (
            "# R\n## A\n### A1\n## B\n- y\n\n  続き\n".to_string(),
            (5, "y"),
        ),
        (
            "# R\n## A\n### A1\n## B\n- y\n  続き\n".to_string(),
            (5, "y"),
        ),
        (
            format!("{MD}# R\n## A\n## B\n- y\n  続き\n    > 詳細\n"),
            (4, "y"),
        ),
    ] {
        assert_reason(
            &move_node(&source, moved, (2, "A")),
            "refused",
            "heading-details",
            &source,
        );
    }
}

// ==== 5. marker-line: 下線の見出しと字下げした見出しを ATX の見出しに書き直す ====

#[test]
fn edit_rewrite_marker_line_tags_rewrite_setext_and_indented_headings_as_atx() {
    // 細部 19: 下線 = は 1 段、- は 2 段の ATX。行頭の空白は外し、段と閉じの # の並びは残す。前後の空行は足さない
    let cases: Vec<(String, Target, String)> = vec![
        (
            format!("{MD}# R\n\n設計\n---\n\n- 画面\n"),
            (2, "設計"),
            format!("{MD}# R\n\n## 設計 #k:v\n\n- 画面\n"),
        ),
        (
            format!("{MD}# R\n\n設計\n------\n\n- 画面\n"),
            (2, "設計"),
            format!("{MD}# R\n\n## 設計 #k:v\n\n- 画面\n"),
        ),
        (
            format!("{MD}設計\n===\n\n- 画面\n"),
            (1, "設計"),
            format!("{MD}# 設計 #k:v\n\n- 画面\n"),
        ),
        (
            format!("{MD}# R\n\n ## 実装\n\n- 画面\n"),
            (2, "実装"),
            format!("{MD}# R\n\n## 実装 #k:v\n\n- 画面\n"),
        ),
        (
            format!("{MD}# R\n\n   ### 実装 ###\n\n- 画面\n"),
            (2, "実装"),
            format!("{MD}# R\n\n### 実装 ### #k:v\n\n- 画面\n"),
        ),
        (
            format!("{CRLF_MD}# R\r\n\r\n設計\r\n---\r\n\r\n- 画面\r\n"),
            (2, "設計"),
            format!("{CRLF_MD}# R\r\n\r\n## 設計 #k:v\r\n\r\n- 画面\r\n"),
        ),
    ];
    for (source, target, expected) in cases {
        assert_eq!(
            tags_of(&expected, target.0),
            [tag("k", &["v"])],
            "{expected:?}"
        );
        assert_eq!(ref_texts(&expected), ref_texts(&source), "{expected:?}");
        assert_eq!(inspect(&expected, target)["kind"], json!("heading"));
        assert_eq!(
            inspect(&source, target)["canMark"],
            json!(true),
            "{source:?}"
        );
        for result in [
            set_tag(&source, &[target], "k", Some("v")),
            toggle_tag(&source, &[target], "k", Some("v")),
        ] {
            assert_rewritten(&source, &result, &expected, &selected_nodes(&[target]), &[]);
        }
    }

    // ほかのノードと一緒に選んでも、見出しだけを書き直す。1 R / 2 設計 (下線) / 3 画面 / 4 実装 (行頭に空白)
    let source = format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n");
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
            assert_eq!(tags_of(&expected, id), [tag("k", &["v"])], "{expected:?}");
        }
        assert_eq!(ref_texts(&expected), ref_texts(&source), "{expected:?}");
        let result = set_tag(&source, &nodes, "k", Some("v"));
        assert_rewritten(&source, &result, &expected, &selected_nodes(&nodes), &[]);
    }
}

#[test]
fn edit_rewrite_marker_line_groups_and_references_rewrite_headings_as_atx() {
    // groupNodes: 下線の見出しと行頭に空白のある見出しに %group1
    let source = format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n\n## 設計 %group1\n\n- 画面\n\n## 実装 %group1\n",
        new_groups(1)
    );
    assert_eq!(ref_texts(&expected), ref_texts(&source), "{expected:?}");
    let model = model_of(&expected);
    for id in [2, 3, 4] {
        assert_eq!(
            model.groups_of.get(&id).cloned(),
            Some(vec!["group1".to_string()]),
            "id {id}: {expected:?}"
        );
    }
    let result = group_nodes(&source, &[(2, "設計"), (4, "実装")]);
    assert_eq!(applied(&source, &result), expected, "{result}");
    assert_eq!(result["select"], selected_group("group1"), "{result}");
    assert_eq!(result["rename"], selected_group("group1"), "{result}");
    assert_notes(&result, &[]);

    // addToGroup
    let source = format!("{DEFINED_G}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n");
    let expected = format!("{DEFINED_G}# R\n\n## 設計 %g\n\n- 画面\n\n## 実装 %g\n");
    assert_eq!(
        model_of(&expected).groups_of.get(&4).cloned(),
        Some(vec!["g".to_string()])
    );
    let result = add_to_group(&source, "g", &[(2, "設計"), (4, "実装")]);
    assert_rewritten(
        &source,
        &result,
        &expected,
        &selected_nodes(&[(2, "設計"), (4, "実装")]),
        &[],
    );

    // $n の要る参照 (名前も 親/名前 も 2 つに当たる): 下線の見出しを ATX にして $n1 を付ける。
    // 1 R / 2 設計 (下線) / 3 画面 / 4 設計 (下線) / 5 API
    let source = format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n設計\n---\n\n- API\n");
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n";
    assert_edges(expected, &[(2, 5, "depends")]);
    let result = add_relation(&source, (2, "設計"), (5, "API"));
    assert_rewritten(
        &source,
        &result,
        expected,
        &selected_edge(2, 5),
        &["id-added"],
    );
}

#[test]
fn edit_rewrite_marker_line_remove_tag_leaves_headings_it_writes_no_mark_on() {
    // 下線の見出しと行頭に空白のある見出しは印を読まない (外すタグがない) ので、removeTag はほかのノードのタグだけを外し、見出しは書き直さない
    let source = format!("{MD}# R\n\n設計\n---\n\n- 画面 #k\n\n ## 実装\n");
    let expected = format!("{MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n");
    for nodes in [[(2, "設計"), (3, "画面")], [(3, "画面"), (4, "実装")]] {
        let result = remove_tag(&source, &nodes, "k");
        assert_rewritten(&source, &result, &expected, &selected_nodes(&nodes), &[]);
    }
}

#[test]
fn edit_rewrite_marker_line_still_refuses_setext_headings_whose_name_changes_when_joined() {
    // 変えない (細部 19): 本文が 2 行の下線の見出しの名前 (refText) は 1 行目の「設計」で、1 行につなぐと「設計 の続き」に変わるので
    // marker-line のまま。1 R / 2 設計 (2 行の下線の見出し) / 3 画面
    let source = format!("{MD}# R\n\n設計\nの続き\n---\n\n- 画面\n");
    assert_target(&source, (2, "設計"));
    // そのノードの canMark は false (印の操作のボタンを押せない。メインの決定)
    let found = inspect(&source, (2, "設計"));
    assert_eq!(found["kind"], json!("heading"), "{found}");
    assert_eq!(found["canMark"], json!(false), "{found}");
    for result in [
        set_tag(&source, &[(2, "設計")], "k", Some("v")),
        toggle_tag(&source, &[(2, "設計")], "k", Some("v")),
        group_nodes(&source, &[(2, "設計")]),
    ] {
        assert_reason(&result, "refused", "marker-line", &source);
    }
    // $n の要る参照も。1 R / 2 設計 (2 行) / 3 画面 / 4 設計 / 5 API
    let source = format!("{MD}# R\n\n設計\nの続き\n---\n\n- 画面\n\n設計\n---\n\n- API\n");
    assert_reason(
        &add_relation(&source, (2, "設計"), (5, "API")),
        "refused",
        "marker-line",
        &source,
    );
}

#[test]
fn edit_rewrite_marker_line_escapes_mark_like_endings_when_rewriting_as_atx() {
    // メインの決定: 下線の見出しと行頭に空白のある見出しの本文が印に読める字で終わるとき (今は印を読まないので名前の一部)、
    // ATX に書き直すときに名前の逃がし (行の全体の逃がし) で `\#k` などと逃がし、名前を変えずに通す。数字だけの #12 は印に読まれないので逃がさない
    let cases: Vec<(String, Target, &str)> = vec![
        (
            format!("{MD}# R\n\n設計 #k\n---\n\n- 画面\n"),
            (2, "設計 #k"),
            r"## 設計 \#k #x:v",
        ),
        (
            format!("{MD}# R\n\n ## 実装 #k\n\n- 画面\n"),
            (2, "実装 #k"),
            r"## 実装 \#k #x:v",
        ),
        (
            format!("{MD}# R\n\n設計 %g\n---\n\n- 画面\n"),
            (2, "設計 %g"),
            r"## 設計 \%g #x:v",
        ),
        (
            format!("{MD}# R\n\n設計 #a #b\n---\n\n- 画面\n"),
            (2, "設計 #a #b"),
            r"## 設計 #a \#b #x:v",
        ),
        (
            format!("{MD}# R\n\n設計 #12\n---\n\n- 画面\n"),
            (2, "設計 #12"),
            "## 設計 #12 #x:v",
        ),
    ];
    for (source, target, written) in cases {
        let expected = format!("{MD}# R\n\n{written}\n\n- 画面\n");
        // 期待の文書: 名前は変わらず (refText と名前の入力の初めの値に \ を出さない)、タグは x だけ
        assert_eq!(ref_texts(&expected), ref_texts(&source), "{expected:?}");
        assert_eq!(tags_of(&expected, 2), [tag("x", &["v"])], "{expected:?}");
        assert_eq!(
            inspect(&expected, target)["label"],
            json!(target.1),
            "{expected:?}"
        );
        for result in [
            set_tag(&source, &[target], "x", Some("v")),
            toggle_tag(&source, &[target], "x", Some("v")),
        ] {
            assert_rewritten(&source, &result, &expected, &selected_nodes(&[target]), &[]);
        }
    }

    // groupNodes と、$n の要る参照も同じ
    let source = format!("{MD}# R\n\n設計 #k\n---\n\n- 画面\n");
    let result = group_nodes(&source, &[(2, "設計 #k")]);
    assert_eq!(
        applied(&source, &result),
        format!(
            "---\nmarkdag:\n{}---\n# R\n\n## 設計 \\#k %group1\n\n- 画面\n",
            new_groups(1)
        ),
        "{result}"
    );
    assert_eq!(result["select"], selected_group("group1"), "{result}");
    // 1 R / 2 設計 #k (下線) / 3 画面 / 4 設計 #k (下線) / 5 API
    let source = format!("{MD}# R\n\n設計 #k\n---\n\n- 画面\n\n設計 #k\n---\n\n- API\n");
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 \\#k $n1\n\n- 画面\n\n設計 #k\n---\n\n- API\n";
    assert_edges(expected, &[(2, 5, "depends")]);
    assert_eq!(ref_texts(expected), ref_texts(&source), "{expected:?}");
    let result = add_relation(&source, (2, "設計 #k"), (5, "API"));
    assert_rewritten(
        &source,
        &result,
        expected,
        &selected_edge(2, 5),
        &["id-added"],
    );
}

#[test]
fn edit_rewrite_marker_line_inspect_can_mark_tells_headings_that_can_be_rewritten() {
    // メインの決定: 1 行の下線の見出しと行頭に空白のある ATX の見出しは、書き直して印を書けるので canMark が true
    // (印に読める字で終わる本文も、逃がして書けるので true)
    for (source, target) in [
        (format!("{MD}# R\n\n設計\n---\n\n- 画面\n"), (2, "設計")),
        (format!("{MD}設計\n===\n\n- 画面\n"), (1, "設計")),
        (format!("{MD}# R\n\n ## 実装\n\n- 画面\n"), (2, "実装")),
        (
            format!("{MD}# R\n\n設計 #k\n---\n\n- 画面\n"),
            (2, "設計 #k"),
        ),
    ] {
        let found = inspect(&source, target);
        assert_eq!(found["kind"], json!("heading"), "{source:?}");
        assert_eq!(found["canMark"], json!(true), "{source:?}");
    }
}

// ==== 6. flow-style: フロー形式のブロックを字下げの形に書き直す ====

const FLOW_BODY: &str = "# R\n- a\n- b\n- c\n";

#[test]
fn edit_rewrite_flow_style_rewrites_the_outermost_flow_block_before_adding() {
    // 細部 20: 書く道すじを含むいちばん外のフロー形式のブロックを、中の値ごと字下げの形 (キーと - で 1 行ずつ) に書き直す。
    // スカラの字は引用符も書いたまま。字下げの幅は frontmatter の最小の字下げ (なければ 4)
    // (frontmatter、始点、終点、書き直したあとの frontmatter、notes)
    let cases: [(&str, Target, Target, &str, &[&str]); 11] = [
        (
            "markdag: {}\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n",
            &[],
        ),
        (
            "markdag:\n    relations: {}\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n",
            &[],
        ),
        (
            "markdag:\n    relations:\n        depends: []\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n",
            &[],
        ),
        (
            "markdag:\n    relations:\n        depends: [a --> b]\n",
            (3, "b"),
            (4, "c"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n",
            &[],
        ),
        // 複数行にまたがるフロー形式
        (
            "markdag:\n    relations:\n        depends: [\n            a --> b,\n            b --> c,\n          ]\n",
            (2, "a"),
            (4, "c"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n            - a --> c\n",
            &[],
        ),
        // フロー形式の中のフロー形式は、いちばん外 (markdag の値) から書き直す
        (
            "markdag: { relations: { depends: [a --> c] } }\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> c\n            - a --> b\n",
            &[],
        ),
        // frontmatter の全体がフロー形式
        (
            "{markdag: {}}\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n",
            &[],
        ),
        (
            "{title: T}\n",
            (2, "a"),
            (3, "b"),
            "title: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n",
            &["markdag-added"],
        ),
        // 引用符のある値はそのまま。フロー形式のあとのキーも残る
        (
            "markdag: { legend: { position: \"bottom-right\" }, edgeHighlight: true }\ntitle: T\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    legend:\n        position: \"bottom-right\"\n    edgeHighlight: true\n    relations:\n        depends:\n            - a --> b\ntitle: T\n",
            &[],
        ),
        // 字下げが 2 の frontmatter
        (
            "markdag:\n  relations:\n    depends: [a --> b]\n",
            (3, "b"),
            (4, "c"),
            "markdag:\n  relations:\n    depends:\n      - a --> b\n      - b --> c\n",
            &[],
        ),
        (
            "markdag:\n  edgeHighlight: true\n  relations: { depends: [a --> b] }\n",
            (3, "b"),
            (4, "c"),
            "markdag:\n  edgeHighlight: true\n  relations:\n    depends:\n      - a --> b\n      - b --> c\n",
            &[],
        ),
    ];
    for (frontmatter, from, to, written, notes) in cases {
        let source = format!("---\n{frontmatter}---\n{FLOW_BODY}");
        let expected = format!("---\n{written}---\n{FLOW_BODY}");
        assert_edges(&expected, &[(from.0, to.0, "depends")]);
        let result = add_relation(&source, from, to);
        assert_rewritten(
            &source,
            &result,
            &expected,
            &selected_edge(from.0, to.0),
            notes,
        );
    }
    // 読み直した値は書き直す前と同じ (足した線のほか)
    let source = format!(
        "---\nmarkdag: {{ legend: {{ position: \"bottom-right\" }}, edgeHighlight: true }}\ntitle: T\n---\n{FLOW_BODY}"
    );
    let after = applied(&source, &add_relation(&source, (2, "a"), (3, "b")));
    let read = frontmatter_of(&after);
    assert_eq!(read["title"], json!("T"), "{after:?}");
    assert_eq!(
        read["markdag"]["legend"],
        json!({ "position": "bottom-right" }),
        "{after:?}"
    );
    assert_eq!(read["markdag"]["edgeHighlight"], json!(true), "{after:?}");
}

#[test]
fn edit_rewrite_flow_style_applies_to_every_op_that_writes_the_frontmatter() {
    // 細部 21: frontmatter を書く操作の全部 (足す操作、名前の追随、削除の追随、グループの定義の書き換えと外し)
    // タグと詳細: frontmatter の全体がフロー形式の文書に markdag: を足す
    let source = format!("---\n{{title: T}}\n---\n{FLOW_BODY}");
    let result = set_tag(&source, &[(2, "a")], "k", None);
    assert_rewritten(
        &source,
        &result,
        "---\ntitle: T\nmarkdag:\n---\n# R\n- a #k\n- b\n- c\n",
        &selected_nodes(&[(2, "a")]),
        &["markdag-added"],
    );
    let result = set_details(&source, (2, "a"), "d");
    assert_rewritten(
        &source,
        &result,
        "---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n- b\n- c\n",
        &selected_nodes(&[(2, "a")]),
        &["markdag-added"],
    );

    // groupNodes と defineGroup: groups の値がフロー形式
    let source = "---\nmarkdag:\n    groups: { g: { label: G } }\n---\n# R\n- a %g\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n    groups:\n        g:\n            label: G\n{}---\n# R\n- a %g\n- b %group1\n",
        new_group(1)
    );
    let result = group_nodes(source, &[(3, "b")]);
    assert_eq!(applied(source, &result), expected, "{result}");
    assert_eq!(result["select"], selected_group("group1"), "{result}");
    assert_notes(&result, &[]);
    let source = format!("---\nmarkdag: {{}}\n---\n{FLOW_BODY}");
    let result = run(&source, json!({ "kind": "defineGroup" }));
    assert_eq!(
        applied(&source, &result),
        format!("---\nmarkdag:\n{}---\n{FLOW_BODY}", new_groups(1)),
        "{result}"
    );

    // joinInto: join の値がフロー形式。1 R / 2 a / 3 b / 4 c / 5 d / 6 e
    let source = "---\nmarkdag:\n    relations:\n        join: [a & b --> c]\n---\n# R\n- a\n- b\n- c\n- d\n- e\n";
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - a & b --> c\n            - d & e --> c\n---\n# R\n- a\n- b\n- c\n- d\n- e\n";
    assert_edges(expected, &[(2, 4, "join"), (5, 4, "join"), (6, 4, "join")]);
    let result = join_into(source, &[(5, "d"), (6, "e")], (4, "c"));
    assert_rewritten(source, &result, expected, &selected_nodes(&[(4, "c")]), &[]);

    // 名前の追随: relations と branches がフロー形式
    let source = "---\nmarkdag:\n    relations:\n        depends: [API --> 公開]\n    branches: [API]\n---\n# R\n- API\n- 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - API サーバー --> 公開\n    branches:\n        - API サーバー\n---\n# R\n- API サーバー\n- 公開\n";
    assert_edges(expected, &[(2, 3, "depends")]);
    assert_eq!(model_of(expected).branches, [2], "{expected:?}");
    let result = rename_node(source, (2, "API"), "API サーバー");
    assert_rewritten(
        source,
        &result,
        expected,
        &selected_nodes(&[(2, "API サーバー")]),
        &[],
    );

    // 削除の追随: 項目を外す一覧がフロー形式
    let source = "---\nmarkdag:\n    relations:\n        depends: [a --> b, b --> c]\n---\n# R\n- a\n- b\n- c\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - b --> c\n---\n# R\n- b\n- c\n";
    assert_edges(expected, &[(2, 3, "depends")]);
    let result = delete_nodes(source, &[(2, "a")]);
    assert_rewritten(
        source,
        &result,
        expected,
        &selected_nodes(&[(1, "R")]),
        &["relations-removed"],
    );

    // グループの定義の書き換えと外し: 定義がフロー形式
    let source = "---\nmarkdag:\n    groups:\n        g: { label: G, color: \"#3B7DD8\" }\n---\n# R\n- a %g\n";
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            label: 設計\n            color: \"#3B7DD8\"\n---\n# R\n- a %g\n";
    assert_groups(expected, &[("g", "設計", Some("#3B7DD8"), false)]);
    let result = run(
        source,
        json!({ "kind": "renameGroup", "group": "g", "label": "設計" }),
    );
    assert_rewritten(source, &result, expected, &selected_group("g"), &[]);
    let result = run(source, json!({ "kind": "ungroup", "group": "g" }));
    assert_eq!(
        applied(source, &result),
        "---\nmarkdag:\n---\n# R\n- a\n",
        "{result}"
    );
    assert_eq!(result["select"], json!({ "kind": "none" }), "{result}");
}

#[test]
fn edit_rewrite_flow_style_still_refuses_blocks_it_cannot_rewrite_as_written() {
    // 変えない (細部 20): コメント、アンカー、別名、タグ、明示のキー、フロー形式の一覧の中の 1 組の写像を含むブロックは flow-style
    for frontmatter in [
        "markdag:\n    relations:\n        depends: [\n            a --> c, # メモ\n        ]\n",
        "markdag:\n    relations: &r { depends: [a --> c] }\n",
        "x: &a a --> c\nmarkdag:\n    relations:\n        depends: [*a]\n",
        "markdag:\n    relations:\n        depends: [!!str a --> c]\n",
        "markdag:\n    relations: { ? depends : [a --> c] }\n",
        "markdag:\n    relations:\n        depends: [a --> c: x]\n",
    ] {
        let source = format!("---\n{frontmatter}---\n{FLOW_BODY}");
        assert_reason(
            &add_relation(&source, (2, "a"), (3, "b")),
            "refused",
            "flow-style",
            frontmatter,
        );
    }
}

#[test]
fn edit_rewrite_frontmatter_invalid_is_still_refused() {
    // 変えない (scope.md の「最後の関門 原文の都合で断る 8」): YAML が壊れた frontmatter は推測で書き直さない
    let source = "---\nmarkdag:\n    groups: [\n---\n# R\n- a\n- b\n";
    let a = node((2, "a"));
    let b = node((3, "b"));
    for value in [
        json!({ "kind": "groupNodes", "nodes": [a] }),
        json!({ "kind": "defineGroup" }),
        json!({ "kind": "addRelation", "from": a, "to": b }),
        json!({ "kind": "joinIntoNew", "sources": [a, b], "label": "合流" }),
        json!({ "kind": "setTag", "nodes": [a], "key": "k", "value": null, "replaceKey": null }),
        json!({ "kind": "setDetails", "node": a, "text": "d" }),
    ] {
        let case = value.to_string();
        assert_reason(&run(source, value), "refused", "frontmatter-invalid", &case);
    }
}

// ==== 7. block-scalar: | や > の値を - の一覧に書き直す ====

fn relations_doc(relations: &str, body: &str) -> String {
    format!("---\nmarkdag:\n    relations:\n{relations}---\n{body}")
}

const ABCD: &str = "# R\n- a\n- b\n- c\n- d\n";

#[test]
fn edit_rewrite_block_scalar_relations_become_one_item_per_line_before_adding() {
    // 細部 22: 中身の行 (ブロックの字下げを外したもの) のうち空でない行ごとに 1 項目。| も > も書いた見た目どおり
    let one = "        depends:\n            - a --> b\n            - b --> c\n";
    let two =
        "        depends:\n            - a --> b\n            - b --> c\n            - c --> d\n";
    let cases: [(&str, Target, Target, &str); 5] = [
        (
            "        depends: |\n            a --> b\n",
            (3, "b"),
            (4, "c"),
            one,
        ),
        (
            "        depends: >-\n            a --> b\n",
            (3, "b"),
            (4, "c"),
            one,
        ),
        (
            "        depends: |\n            a --> b\n            b --> c\n",
            (4, "c"),
            (5, "d"),
            two,
        ),
        (
            "        depends: >\n            a --> b\n            b --> c\n",
            (4, "c"),
            (5, "d"),
            two,
        ),
        (
            "        depends: |-\n            a --> b\n\n            b --> c\n",
            (4, "c"),
            (5, "d"),
            two,
        ),
    ];
    for (relations, from, to, written) in cases {
        let source = relations_doc(relations, ABCD);
        let expected = relations_doc(written, ABCD);
        assert_edges(&expected, &[(from.0, to.0, "depends")]);
        let result = add_relation(&source, from, to);
        assert_rewritten(
            &source,
            &result,
            &expected,
            &selected_edge(from.0, to.0),
            &[],
        );
    }
    // 前提: 2 行以上の値は今は 1 つの式に読まれて線にならない (書いた見た目の意図に直す)
    let source = relations_doc(
        "        depends: |\n            a --> b\n            b --> c\n",
        ABCD,
    );
    assert!(
        diagnostic_codes(&source).contains(&"ref-not-found".to_string()),
        "{source:?}"
    );

    // 字下げが 2 の frontmatter
    let source =
        "---\nmarkdag:\n  relations:\n    depends: |\n      a --> b\n---\n# R\n- a\n- b\n- c\n";
    let expected = "---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n      - b --> c\n---\n# R\n- a\n- b\n- c\n";
    assert_edges(expected, &[(2, 3, "depends"), (3, 4, "depends")]);
    let result = add_relation(source, (3, "b"), (4, "c"));
    assert_rewritten(source, &result, expected, &selected_edge(3, 4), &[]);
}

#[test]
fn edit_rewrite_block_scalar_keeps_a_comment_after_the_indicator_on_the_key_line() {
    // キーの行の値のあとのコメント (depends: | # メモ) はキーの行に残す
    let source = relations_doc(
        "        depends: | # メモ\n            a --> b\n",
        "# R\n- a\n- b\n- c\n",
    );
    let result = add_relation(&source, (3, "b"), (4, "c"));
    let after = applied(&source, &result);
    assert_eq!(
        relations_value_of(&after, "depends"),
        json!(["a --> b", "b --> c"]),
        "{after:?}"
    );
    assert_edges(&after, &[(2, 3, "depends"), (3, 4, "depends")]);
    let lines: Vec<&str> = after.split('\n').collect();
    let key = lines
        .iter()
        .position(|line| line.starts_with("        depends:"))
        .unwrap_or_else(|| panic!("depends のキーの行がある: {after:?}"));
    assert!(
        lines[key].ends_with("# メモ") && !lines[key].contains('|'),
        "{after:?}"
    );
    assert_eq!(
        lines[key + 1..key + 3],
        ["            - a --> b", "            - b --> c"],
        "{after:?}"
    );
}

#[test]
fn edit_rewrite_block_scalar_relations_are_rewritten_for_joins_renames_and_deletes() {
    // joinInto: join の値が複数行の文字。1 R / 2 a / 3 b / 4 c / 5 d / 6 e
    let source = relations_doc(
        "        join: |\n            a & b --> c\n",
        "# R\n- a\n- b\n- c\n- d\n- e\n",
    );
    let expected = relations_doc(
        "        join:\n            - a & b --> c\n            - d & e --> c\n",
        "# R\n- a\n- b\n- c\n- d\n- e\n",
    );
    assert_edges(&expected, &[(2, 4, "join"), (5, 4, "join"), (6, 4, "join")]);
    let result = join_into(&source, &[(5, "d"), (6, "e")], (4, "c"));
    assert_rewritten(
        &source,
        &result,
        &expected,
        &selected_nodes(&[(4, "c")]),
        &[],
    );

    // 名前の追随
    let source = relations_doc(
        "        depends: |\n            API --> 公開\n",
        "# R\n- API\n- 公開\n",
    );
    let expected = relations_doc(
        "        depends:\n            - API サーバー --> 公開\n",
        "# R\n- API サーバー\n- 公開\n",
    );
    assert_edges(&expected, &[(2, 3, "depends")]);
    let result = rename_node(&source, (2, "API"), "API サーバー");
    assert_rewritten(
        &source,
        &result,
        &expected,
        &selected_nodes(&[(2, "API サーバー")]),
        &[],
    );

    // 削除の追随 (chain の終わりのノードを消す)
    let source = relations_doc("        chain: |\n            a --> b --> c --> d\n", ABCD);
    let expected = relations_doc(
        "        chain:\n            - a --> b --> c\n",
        "# R\n- a\n- b\n- c\n",
    );
    assert_edges(&expected, &[(2, 3, "chain"), (3, 4, "chain")]);
    let result = delete_nodes(&source, &[(5, "d")]);
    assert_rewritten(
        &source,
        &result,
        &expected,
        &selected_nodes(&[(1, "R")]),
        &["relations-removed"],
    );
}

// ==== 8. line-endings: 単独の \r を文書の改行にそろえる ====

#[test]
fn edit_rewrite_line_endings_lone_carriage_returns_become_the_first_line_break_of_the_document() {
    // 細部 23: 文書の最初の \n の改行 (\r\n か \n。\n がなければ \n) に、文書の中の単独の \r を全部置き換えてから操作を当てる
    let a = node((2, "a"));
    let b = node((3, "b"));
    let cases: Vec<(String, Value, String)> = vec![
        (
            "# R\n- a\r- b\n".to_string(),
            json!({ "kind": "renameNode", "node": a, "label": "x" }),
            "# R\n- x\n- b\n".to_string(),
        ),
        (
            "# R\r\n- a\r- b\r\n".to_string(),
            json!({ "kind": "renameNode", "node": a, "label": "x" }),
            "# R\r\n- x\r\n- b\r\n".to_string(),
        ),
        // \n が 1 つもない文書
        (
            "# R\r- a\r- b".to_string(),
            json!({ "kind": "renameNode", "node": a, "label": "x" }),
            "# R\n- x\n- b".to_string(),
        ),
        // 最初の改行が \n なら、ほかの行の \r\n は変えず、単独の \r だけを \n にする
        (
            "# R\n- a\r\n- b\r- c\r\n".to_string(),
            json!({ "kind": "renameNode", "node": a, "label": "x" }),
            "# R\n- x\r\n- b\n- c\r\n".to_string(),
        ),
        // frontmatter の中の単独の \r も
        (
            "---\nmarkdag:\r    edgeHighlight: true\n---\n# R\n- a\n".to_string(),
            json!({ "kind": "renameNode", "node": a, "label": "x" }),
            "---\nmarkdag:\n    edgeHighlight: true\n---\n# R\n- x\n".to_string(),
        ),
        // 書き換える行から離れた所の単独の \r も
        (
            format!("{MD}# R\n- a #k\n- b\r- c\n"),
            json!({ "kind": "setTag", "nodes": [a], "key": "k", "value": "v", "replaceKey": null }),
            format!("{MD}# R\n- a #k:v\n- b\n- c\n"),
        ),
        (
            "# R\n- a\n- b\r- c\n".to_string(),
            json!({ "kind": "addRelation", "from": a, "to": b }),
            "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n\n# R\n- a\n- b\n- c\n".to_string(),
        ),
    ];
    for (source, value, expected) in cases {
        // 前提: 単独の \r のある原文と、そろえた原文は同じノードに読まれる
        let lone = with_lone_carriage_returns_replaced(&source);
        assert_eq!(ref_texts(&source), ref_texts(&lone), "{source:?}");
        let case = format!("{source:?} の {value}");
        let result = run(&source, value);
        let after = applied(&source, &result);
        assert_eq!(after, expected, "{case}: {result}");
        assert!(!has_lone_carriage_return(&after), "{case}: {after:?}");
    }
}

// 単独の \r (すぐあとが \n でない \r) があるか
fn has_lone_carriage_return(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes
        .iter()
        .enumerate()
        .any(|(index, &byte)| byte == b'\r' && bytes.get(index + 1) != Some(&b'\n'))
}

// 単独の \r を文書の最初の \n の改行 (なければ \n) に置き換えた原文 (前提の確かめに使う)
fn with_lone_carriage_returns_replaced(text: &str) -> String {
    let newline = match text.find('\n') {
        Some(at) if at > 0 && text.as_bytes()[at - 1] == b'\r' => "\r\n",
        _ => "\n",
    };
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\r' && chars.peek() != Some(&'\n') {
            out.push_str(newline);
        } else {
            out.push(char);
        }
    }
    out
}

#[test]
fn edit_rewrite_line_endings_do_not_write_when_the_op_changes_nothing_or_is_refused() {
    // 操作が何も変えないか断るときは、単独の \r をそろえるだけの書き換えもしない (原文を返さない)
    let source = "# R\n- a\r- b\n";
    assert_reason(
        &rename_node(source, (2, "a"), "a"),
        "unchanged",
        "same-name",
        "同じ名前",
    );
    assert_reason(
        &run(
            source,
            json!({ "kind": "renameNode", "node": node((2, "x")), "label": "y" }),
        ),
        "refused",
        "stale-node",
        "古いノード",
    );
}

// ==== 9. bom: BOM のすぐあとが --- の行の文書は BOM を外してから書く ====

#[test]
fn edit_rewrite_bom_right_before_a_fence_is_removed_and_the_frontmatter_written() {
    // 細部 24: BOM を外すとその frontmatter が読まれる。markdag キーがあればそこに書き、なければ markdag: を足す。note は bom-removed
    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a\n";
    let result = group_nodes(source, &[(2, "a")]);
    assert_eq!(
        applied(source, &result),
        format!("---\nmarkdag:\n{}---\n# R\n- a %group1\n", new_groups(1)),
        "{result}"
    );
    assert_notes(&result, &["bom-removed"]);

    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a\n- b\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n";
    assert_edges(expected, &[(2, 3, "depends")]);
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_rewritten(
        source,
        &result,
        expected,
        &selected_edge(2, 3),
        &["bom-removed"],
    );

    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n";
    let result = set_details(source, (2, "a"), "d");
    assert_rewritten(
        source,
        &result,
        "---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n",
        &selected_nodes(&[(2, "a")]),
        &["bom-removed", "markdag-added"],
    );
    let result = set_tag(source, &[(2, "a")], "k", Some("v"));
    assert_rewritten(
        source,
        &result,
        "---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n",
        &selected_nodes(&[(2, "a")]),
        &["bom-removed", "markdag-added"],
    );

    // CRLF の文書
    let source = "\u{feff}---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n";
    let result = set_tag(source, &[(2, "a")], "k", Some("v"));
    assert_rewritten(
        source,
        &result,
        "---\r\ntitle: T\r\nmarkdag:\r\n---\r\n# R\r\n- a #k:v\r\n",
        &selected_nodes(&[(2, "a")]),
        &["bom-removed", "markdag-added"],
    );
}

#[test]
fn edit_rewrite_bom_removal_selects_nodes_as_read_after_removal() {
    // BOM を外すと markdag キーが効き、「a #k」は名前 a とタグ k に読まれる。markdag: を足したときと同じく、外したあとの原文で
    // ノードの対応を取り、選ぶのは書き換えたあとの原文のノード
    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a #k\n";
    assert_target(source, (2, "a #k"));
    let expected = "---\nmarkdag:\n---\n# R\n- a #k #x:v\n";
    assert_eq!(
        tags_of(expected, 2),
        [tag("k", &[]), tag("x", &["v"])],
        "{expected:?}"
    );
    let result = set_tag(source, &[(2, "a #k")], "x", Some("v"));
    assert_rewritten(
        source,
        &result,
        expected,
        &selected_nodes(&[(2, "a")]),
        &["bom-removed"],
    );
}

#[test]
fn edit_rewrite_bom_stays_for_ops_that_do_not_add_markdag() {
    // 変えない (細部 24): markdag: を足さない操作では BOM を行頭のまま残す
    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n";
    let result = rename_node(source, (2, "a"), "x");
    assert_eq!(
        applied(source, &result),
        "\u{feff}---\ntitle: T\n---\n# R\n- x\n",
        "{result}"
    );
}

// ==== 断るままのもの ====

#[test]
fn edit_rewrite_ambiguous_references_are_still_refused() {
    // 変えない (scope.md の「最後の関門 原文の都合で断る 4」): 同じ $id が 2 つあり名前でも決まらないノードは指せない。
    // 1 計画 / 2 設計 $x / 3 設計 $x / 4 実装
    let source = format!("{MD}# 計画\n\n- 設計 $x\n- 設計 $x\n- 実装\n");
    assert_reason(
        &add_relation(&source, (4, "実装"), (3, "設計")),
        "refused",
        "ambiguous-reference",
        "addRelation",
    );
    assert_reason(
        &join_into(&source, &[(4, "実装"), (2, "設計")], (3, "設計")),
        "refused",
        "ambiguous-reference",
        "joinInto",
    );
}

#[test]
fn edit_rewrite_block_nodes_are_still_refused() {
    // 変えない (scope.md の「最後の関門 原文の都合で断る 5」): 表、コード、画像のノードへの子、印、詳細。1 計画 / 2 設計 / 3 表
    let source =
        format!("{MD}# 計画\n\n## 設計\n\n| 画面 | 担当 |\n| --- | --- |\n| 一覧 | 山田 |\n");
    assert_eq!(inspect(&source, (3, ""))["kind"], json!("block"));
    let table = node((3, ""));
    for value in [
        json!({ "kind": "addChild", "parent": table, "label": "x" }),
        json!({ "kind": "setTag", "nodes": [table], "key": "k", "value": null, "replaceKey": null }),
        json!({ "kind": "setDetails", "node": table, "text": "d" }),
        json!({ "kind": "groupNodes", "nodes": [table] }),
    ] {
        let case = value.to_string();
        assert_reason(&run(&source, value), "refused", "block-node", &case);
    }
}

// GUI 編集のタスク化 / タスク解除で足した書き換え (toggleTaskMark) の単体テスト。期待は spec.md の「タスクにできるノード」「書き換え」
// 「2 つ以上を選んだとき」と、承認した受け入れの例 (data/task-* と screen/task-*) から書き、今の書き換えの出力はなぞらない。
// - タスク化: 行頭の印 (字下げ、リストの印と番号、見出しの #、そのあとの空白) のあとに `[ ] ` を書く。いつも未着手。
//   印のあとの空白が 2 字以上でもタブでも、空白はそのままでその後ろに書く
// - タスク解除: 状態によらず (`[ ]` `[/]` `[x]` `[X]` `[-]`) 記号とあとの空白を外す。外したあとに別の書き方に読まれる名前は `\` で逃がす。
//   名前が空のタスクの項目は記号を `\` で逃がして名前として残す
// - 2 つ以上: タスクにできるものだけを見て、1 つでもタスクでないものがあればそれだけに書き (タスクのものは状態のまま)、全部タスクなら全部外す。
//   タスクにできないノード (表、コード、リストの入れ物、自分の行を持たないルート、名前が空の項目、1 行目が文章でない項目。markdag キーの有無によらない) と、
//   タスク解除で外すと HTML のブロックとして読まれて見出しでなくなるタスクは飛ばし、1 つもなければ断る。指したノードは全部選び直す。
//   名前が HTML のブロックで始まる項目は `\` を足さずに付け外しする (図の形か名前が変わるものは書かない)
// - 名前 (refText) と id、親子、名前のあとの印、frontmatter (relations と groups) は変えない。BOM は 1 行目に書くときだけ外す。CRLF と改行で終わらない文書はそのまま
// - U1: 下線の見出しは見出しの文字の行の先頭に書き、下線の行は変えない。U2: 規則の requireUpstreamDone は当てない
// 読み取りだけのグループ (U2 の readonlyGroups) は編集の層が操作に渡さないことで守るので、ここでは見ない (editSource が規則をどう扱うかは spec.md が決めていない)。
// 番号付きの項目の作業中と中止の解除 (修正案 T-007) と、BOM のすぐあとのタスクの記号の読み方 (修正案 T-002) は答えが出ていないので見ない。
// 公開の markdag_core::edit (edit_source、inspect_node) と解析 (parse_document) だけを使う。指すノードは操作の前に原文の解析で id と refText を確かめる。
// 関数名は `cargo test -p markdag-core edit_` で選ばれるよう edit_ で始める
use markdag_core::edit::{edit_source, inspect_node};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

type Target = (u32, String);

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

// 名前で引いた指す相手
fn by_names(source: &str, names: &[&str]) -> Vec<Target> {
    names
        .iter()
        .map(|name| (named(source, name).id, (*name).to_string()))
        .collect()
}

// id で引いた指す相手 (名前の空のノードや表を指すとき)
fn by_ids(source: &str, ids: &[u32]) -> Vec<Target> {
    ids.iter()
        .map(|&id| (id, node_of(source, id).ref_text))
        .collect()
}

fn toggle(source: &str, targets: &[Target]) -> Value {
    let nodes: Vec<Value> = targets
        .iter()
        .map(|(id, ref_text)| json!({ "id": id, "refText": ref_text }))
        .collect();
    normalized(
        serde_json::to_value(edit_source(
            source,
            &op(json!({ "kind": "toggleTaskMark", "nodes": nodes })),
        ))
        .expect("EditSourceResult は JSON にできる"),
    )
}

fn toggle_named(source: &str, names: &[&str]) -> Value {
    toggle(source, &by_names(source, names))
}

fn kind_of(source: &str, (id, ref_text): &Target) -> String {
    let target: NodeTarget = serde_json::from_value(json!({ "id": id, "refText": ref_text }))
        .expect("NodeTarget の JSON");
    let facts = serde_json::to_value(inspect_node(source, &target)).expect("JSON にできる");
    facts["kind"].as_str().expect("kind は文字列").to_string()
}

// タスクの状態 (タスクでなければ None)
fn state_of(source: &str, id: u32) -> Option<String> {
    node_of(source, id)
        .task
        .map(|task| serde_json::to_value(task.state).expect("状態は JSON にできる"))
        .map(|state| state.as_str().expect("状態は文字列").to_string())
}

// 選び直すノード (並びは問わない)
fn selected_targets(result: &Value) -> Vec<Target> {
    assert_eq!(result["select"]["kind"], "nodes", "{result}");
    let mut targets: Vec<Target> = result["select"]["nodes"]
        .as_array()
        .expect("nodes は配列")
        .iter()
        .map(|node| {
            (
                node["id"].as_f64().expect("id は数") as u32,
                node["refText"]
                    .as_str()
                    .expect("refText は文字列")
                    .to_string(),
            )
        })
        .collect();
    targets.sort();
    targets
}

// 名前のあとの印の比べ方 (位置は記号を書いた分だけ動くので、キーと値だけ)
fn tag_pairs(node: &OutlineNode) -> Vec<(String, Vec<String>)> {
    node.tags
        .iter()
        .map(|tag| (tag.key.clone(), tag.values.clone()))
        .collect()
}

// 書き換えの前とあとで、タスクの状態のほかは図の形が同じ: ノードの数、id、名前、親、行の範囲、グループ、$id、タグ、詳細、frontmatter
fn assert_same_outline(before: &str, after: &str) {
    let old = nodes_of(before);
    let new = nodes_of(after);
    assert_eq!(old.len(), new.len(), "ノードの数: {after:?}");
    for (a, b) in old.iter().zip(new.iter()) {
        assert_eq!(
            (a.id, &a.ref_text, a.parent, &a.lines, &a.groups, &a.ref_id),
            (b.id, &b.ref_text, b.parent, &b.lines, &b.groups, &b.ref_id),
            "id {} が変わらない: {after:?}",
            a.id
        );
        assert_eq!(tag_pairs(a), tag_pairs(b), "id {} のタグ: {after:?}", a.id);
        assert_eq!(a.details, b.details, "id {} の詳細: {after:?}", a.id);
    }
    assert_eq!(
        serde_json::to_value(parse_document(before).frontmatter).expect("JSON にできる"),
        serde_json::to_value(parse_document(after).frontmatter).expect("JSON にできる"),
        "frontmatter は変えない: {after:?}"
    );
}

// 書き換えた結果: 原文の全体、選び直すのは指したノードの全部、名前の入力は開かない、図の形はタスクの状態のほか同じ
fn assert_toggled(source: &str, result: &Value, expected: &str, targets: &[Target]) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    let mut wanted = targets.to_vec();
    wanted.sort();
    assert_eq!(selected_targets(result), wanted, "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
    assert_same_outline(source, expected);
}

fn assert_no_notes(result: &Value) {
    assert_eq!(result["notes"], json!([]), "{result}");
}

fn assert_refused(result: &Value, code: &str) {
    assert_eq!(result["status"], "refused", "{result}");
    assert_eq!(result["reason"]["code"], code, "{result}");
}

// 1 つを指してタスク化 / 解除し、原文の全体と、そのノードのタスクの状態 (Some("todo") か None) を確かめる
fn assert_one(source: &str, name: &str, expected: &str, state: Option<&str>) {
    let targets = by_names(source, &[name]);
    let result = toggle(source, &targets);
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    assert_eq!(
        state_of(expected, targets[0].0).as_deref(),
        state,
        "{name}: {expected:?}"
    );
}

// ---- タスク化: 記号を書く位置 ----

#[test]
fn edit_task_mark_writes_after_each_list_marker_and_number() {
    // spec.md「書き換え」: 行頭の印、番号のあとに [ ] を書き、印と番号と区切りは変えない (data/task-mark-list-markers の 5 つの形と、1 から始まらない番号)
    let cases: [(&str, &str, &str); 7] = [
        ("# R\n- a\n", "a", "# R\n- [ ] a\n"),
        ("# R\n* a\n", "a", "# R\n* [ ] a\n"),
        ("# R\n+ a\n", "a", "# R\n+ [ ] a\n"),
        ("# R\n1. a\n2. b\n", "2. b", "# R\n1. a\n2. [ ] b\n"),
        ("# R\n1) a\n2) b\n", "1. a", "# R\n1) [ ] a\n2) b\n"),
        ("# R\n3. a\n4. b\n", "3. a", "# R\n3. [ ] a\n4. b\n"),
        ("# R\n10. a\n", "10. a", "# R\n10. [ ] a\n"),
    ];
    for (source, name, expected) in cases {
        assert_one(source, name, expected, Some("todo"));
    }
}

#[test]
fn edit_task_mark_writes_after_the_hashes_of_every_heading_level() {
    // spec.md「書き換え」の `## 準備` → `## [ ] 準備`。ルートの見出しもできる (タスクにできるノード)。# の数 (段) は変えない (data/task-mark-headings)
    let source = "# R\n\n## a\n\n### b\n\n#### c\n\n##### d\n\n###### e\n- 項目\n";
    let names = ["R", "a", "b", "c", "d", "e"];
    let targets = by_names(source, &names);
    let result = toggle(source, &targets);
    let expected =
        "# [ ] R\n\n## [ ] a\n\n### [ ] b\n\n#### [ ] c\n\n##### [ ] d\n\n###### [ ] e\n- 項目\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    for (id, name) in &targets {
        assert_eq!(state_of(expected, *id).as_deref(), Some("todo"), "{name}");
    }
    assert_eq!(state_of(expected, named(expected, "項目").id), None);
}

#[test]
fn edit_task_mark_keeps_the_indent_and_closing_hashes_of_a_heading() {
    // 行頭に空白のある見出しは字下げを、閉じの # のある見出しは閉じの # を変えない (行頭の印と名前のあとは変えない)
    assert_one(
        "# R\n\n  ## 準備\n- a\n",
        "準備",
        "# R\n\n  ## [ ] 準備\n- a\n",
        Some("todo"),
    );
    assert_one(
        "# R\n\n## 番号 ##\n- a\n",
        "番号",
        "# R\n\n## [ ] 番号 ##\n- a\n",
        Some("todo"),
    );
    assert_one(
        "# R\n\n## [x] 番号 ##\n- a\n",
        "番号",
        "# R\n\n## 番号 ##\n- a\n",
        None,
    );
}

#[test]
fn edit_task_mark_keeps_two_or_more_spaces_and_tabs_after_the_marker() {
    // 印のあとの空白は行頭の印の一部なのでそのまま残し、その後ろに [ ] を書く (印のあとが 1 字だけの例では見分けられない所。変異 M01 の穴を埋める案)
    let source = "# 引っ越し\n\n##  準備\n-   見積もりを取る\n*\t荷造りの箱を買う\n1.  転出届を出す\n2)   電気・ガス・水道\n";
    let names = [
        "準備",
        "見積もりを取る",
        "荷造りの箱を買う",
        "1. 転出届を出す",
        "2. 電気・ガス・水道",
    ];
    let targets = by_names(source, &names);
    let result = toggle(source, &targets);
    let expected = "# 引っ越し\n\n##  [ ] 準備\n-   [ ] 見積もりを取る\n*\t[ ] 荷造りの箱を買う\n1.  [ ] 転出届を出す\n2)   [ ] 電気・ガス・水道\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    for (id, name) in &targets {
        assert_eq!(state_of(expected, *id).as_deref(), Some("todo"), "{name}");
    }
    // 1 字のタブ
    assert_one("# R\n-\ta\n", "a", "# R\n-\t[ ] a\n", Some("todo"));
}

#[test]
fn edit_task_mark_unmark_keeps_two_or_more_spaces_after_the_marker() {
    // 外すときも印のあとの空白はそのまま、記号とそのあとの空白だけを外す (番号付きは未着手と完了だけ。作業中と中止は修正案 T-007 で見ない)
    let source = "# 引っ越し\n\n##  [ ] 準備\n-   [/] 見積もりを取る\n1.  [x] 転出届を出す\n";
    let targets = by_names(source, &["準備", "見積もりを取る", "1. 転出届を出す"]);
    let result = toggle(source, &targets);
    let expected = "# 引っ越し\n\n##  準備\n-   見積もりを取る\n1.  転出届を出す\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
}

#[test]
fn edit_task_mark_nested_items_keep_indent_and_marker() {
    // 入れ子の項目は字下げ (タブ、空白 2 つ、空白 4 つ) とリストの印を残す (data/task-mark-nested-tab)。親と孫を一緒に指しても、それぞれの行に書く
    let source =
        "# 準備\n\n## 荷物\n- 本棚\n\t- 本\n\t- 服\n\n## 台所\n- 食器\n    - 皿\n    - 鍋\n";
    let targets = by_names(source, &["本", "鍋"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 準備\n\n## 荷物\n- 本棚\n\t- [ ] 本\n\t- 服\n\n## 台所\n- 食器\n    - 皿\n    - [ ] 鍋\n",
        &targets,
    );
    assert_no_notes(&result);

    let source = "# R\n- a\n  - b\n    - c\n- d\n";
    let targets = by_names(source, &["a", "c"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n- [ ] a\n  - b\n    - [ ] c\n- d\n",
        &targets,
    );

    // 外すときも同じ字下げのまま
    assert_one("# R\n- a\n\t- [x] b\n", "b", "# R\n- a\n\t- b\n", None);
}

#[test]
fn edit_task_mark_keeps_trailing_marks_and_frontmatter_references() {
    // 名前のあとの印 (#タグ、$id、%グループ) は変えず、図の名前と id が変わらないので relations と groups は書き換えない (data/task-mark-trailing-marks)
    let front = "---\nmarkdag:\n    groups:\n        g1:\n            label: 当日の組\n    relations:\n        depends:\n            - 見積もりを取る --> 鍵の返却\n            - $hand --> 鍵の返却\n---\n\n";
    let source = format!(
        "{front}# 引っ越し\n\n## 準備\n- 見積もりを取る #owner:alice\n- 荷物を運ぶ $hand\n\n## 当日\n- 鍵の返却 %g1 #owner:bob $key\n"
    );
    let marked = format!(
        "{front}# 引っ越し\n\n## 準備\n- [ ] 見積もりを取る #owner:alice\n- [ ] 荷物を運ぶ $hand\n\n## 当日\n- [ ] 鍵の返却 %g1 #owner:bob $key\n"
    );
    let names = ["見積もりを取る", "荷物を運ぶ", "鍵の返却"];
    let targets = by_names(&source, &names);
    let result = toggle(&source, &targets);
    assert_toggled(&source, &result, &marked, &targets);
    assert_no_notes(&result);

    // 外す向きも同じ (状態は完了と作業中)
    let done = marked
        .replace("- [ ] 見積もりを取る", "- [x] 見積もりを取る")
        .replace("- [ ] 鍵の返却", "- [/] 鍵の返却");
    let targets = by_names(&done, &names);
    let result = toggle(&done, &targets);
    assert_toggled(&done, &result, &source, &targets);
    assert_no_notes(&result);
}

#[test]
fn edit_task_mark_writes_only_the_first_line_of_a_node_with_details() {
    // 詳細 (2 行目からの引用) のある項目は 1 行目だけを書き換える (data/task-mark-details)。見出しの下の詳細も同じ
    assert_one(
        "# 準備\n\n- 不用品を処分する\n    > 粗大ごみは予約する\n    > 回収は月曜\n- 荷造りの箱を買う\n",
        "不用品を処分する",
        "# 準備\n\n- [ ] 不用品を処分する\n    > 粗大ごみは予約する\n    > 回収は月曜\n- 荷造りの箱を買う\n",
        Some("todo"),
    );
    assert_one(
        "# 準備\n\n- [x] 不用品を処分する\n    > 粗大ごみは予約する\n- 荷造りの箱を買う\n",
        "不用品を処分する",
        "# 準備\n\n- 不用品を処分する\n    > 粗大ごみは予約する\n- 荷造りの箱を買う\n",
        None,
    );
    assert_one(
        "# 引っ越し\n\n## 手続き\n\n> 役所は平日だけ\n\n- 転出届を出す\n",
        "手続き",
        "# 引っ越し\n\n## [ ] 手続き\n\n> 役所は平日だけ\n\n- 転出届を出す\n",
        Some("todo"),
    );
}

#[test]
fn edit_task_mark_marks_a_name_that_starts_with_an_escaped_task_mark() {
    // 名前が `[ ] a` の項目 (原文は逃がした `\[ ] a`) も記号を前に足すだけで、名前は変わらない (screen/task-unmark-empty-name のもう一度タスク化する段の形)
    assert_one(
        "# R\n- \\[ ] a\n",
        "[ ] a",
        "# R\n- [ ] \\[ ] a\n",
        Some("todo"),
    );
    assert_one("# R\n- \\[ ]\n", "[ ]", "# R\n- [ ] \\[ ]\n", Some("todo"));
}

// ---- タスク解除 ----

#[test]
fn edit_task_mark_unmarks_every_state() {
    // spec.md「書き換え」: 状態によらず記号 ([ ] [/] [x] [X] [-]) とあとの空白を外す (data/task-unmark-states)。印の種類と番号は変えない
    // ルートの見出しのすぐ下のリストは、下に見出しがあると図に出ない (解析の読み方) ので、どのリストも見出しの下に置く
    let source = "# 準備\n\n## 印\n- [ ] a\n- [/] b\n- [x] c\n- [X] d\n- [-] e\n\n## 物\n* [x] f\n+ [/] g\n\n## 番号\n1. [ ] h\n2. [x] i\n\n## 括弧\n1) [ ] j\n2) [x] k\n";
    let names = [
        "a", "b", "c", "d", "e", "f", "g", "1. h", "2. i", "1. j", "2. k",
    ];
    let targets = by_names(source, &names);
    let result = toggle(source, &targets);
    let expected = "# 準備\n\n## 印\n- a\n- b\n- c\n- d\n- e\n\n## 物\n* f\n+ g\n\n## 番号\n1. h\n2. i\n\n## 括弧\n1) j\n2) k\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    for (id, name) in &targets {
        assert_eq!(state_of(expected, *id), None, "{name}");
    }
}

#[test]
fn edit_task_mark_unmarks_headings_of_every_state() {
    // 見出しの記号も状態によらず外し、# の数は変えない (ルートの見出しも)
    let source = "# [x] R\n\n## [/] S\n\n### [-] T\n\n#### [ ] U\n";
    let targets = by_names(source, &["R", "S", "T", "U"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n## S\n\n### T\n\n#### U\n",
        &targets,
    );
    assert_no_notes(&result);
}

#[test]
fn edit_task_mark_unmark_removes_every_space_after_the_mark() {
    // 「記号とそのあとの空白を消す」: 記号のあとの空白が 2 字以上でも、名前の前に空白を残さない。
    // 記号のあとがタブの形 (`- [ ]\ta`) は、解析が記号を名前にも残す (0.12.1 からの読み方) ので、ここでは見ない
    assert_one("# R\n- [x]   a\n", "a", "# R\n- a\n", None);
    assert_one(
        "# R\n\n## [/]  見出し\n",
        "見出し",
        "# R\n\n## 見出し\n",
        None,
    );
}

#[test]
fn edit_task_mark_unmark_escapes_names_read_as_other_markdown() {
    // spec.md「書き換え」の最後: 外したあとの文字が別の書き方に読まれるなら `\` で逃がし、断らずに通す (data/task-unmark-escape。変異 M05)
    let source = "# 準備\n\n- [ ] 1. 段取りを決める\n- [x] 2) 手順を書く\n- [/] # 見出しの字\n- [-] > 引用の字\n- [x] ---\n- [ ] [x] 済みの字\n";
    let names = [
        "1. 段取りを決める",
        "2) 手順を書く",
        "# 見出しの字",
        "> 引用の字",
        "---",
        "[x] 済みの字",
    ];
    let targets = by_names(source, &names);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 準備\n\n- 1\\. 段取りを決める\n- 2\\) 手順を書く\n- \\# 見出しの字\n- \\> 引用の字\n- \\---\n- \\[x] 済みの字\n",
        &targets,
    );
    assert_no_notes(&result);
}

// 1 つのタスクを外し、名前と種類と親が変わらず、タスクでなくなり、ほかの行は変わらないことを確かめる (逃がし方の字の並びは問わない)
fn assert_unmarked_keeps_the_name(source: &str, name: &str) {
    let before = named(source, name);
    assert!(before.task.is_some(), "{name} はタスク: {source:?}");
    let target: Target = (before.id, name.to_string());
    let result = toggle(source, std::slice::from_ref(&target));
    assert_eq!(result["status"], "edited", "{name}: {result}");
    let after = applied(source, &result);
    let node = node_of(&after, before.id);
    assert_eq!(node.ref_text, name, "{after:?}");
    assert!(node.task.is_none(), "{name} はタスクでなくなる: {after:?}");
    assert_eq!(
        kind_of(&after, &target),
        kind_of(source, &target),
        "{after:?}"
    );
    assert_same_outline(source, &after);
    let line = before.lines.as_ref().expect("自分の行を持つ").start as usize;
    let old: Vec<&str> = source.split('\n').collect();
    let new: Vec<&str> = after.split('\n').collect();
    assert_eq!(old.len(), new.len(), "{after:?}");
    for (index, (a, b)) in old.iter().zip(new.iter()).enumerate() {
        if index != line {
            assert_eq!(a, b, "{name}: 書いた行のほかは変えない: {after:?}");
        }
    }
}

#[test]
fn edit_task_mark_unmark_escapes_other_block_starts_and_task_like_names() {
    // 例にない書き始め (別の印、番号の多い桁、区切り線の別の字、タスクの記号に見える字、見出しと下線の見出し) も、名前を変えずに外す
    let cases: [(&str, &str); 10] = [
        ("# R\n- [ ] + a\n", "+ a"),
        ("# R\n- [x] * a\n", "* a"),
        ("# R\n- [/] 10. a\n", "10. a"),
        ("# R\n- [ ] ***\n", "***"),
        ("# R\n- [x] ___\n", "___"),
        ("# R\n- [-] [/] a\n", "[/] a"),
        ("# R\n- [x] [-] a\n", "[-] a"),
        ("# R\n\n## [x] 1. 準備\n", "1. 準備"),
        ("# R\n\n[ ] - 準備\n---\n", "- 準備"),
        ("# R\n\n[x] # 準備\n---\n", "# 準備"),
    ];
    for (source, name) in cases {
        assert_unmarked_keeps_the_name(source, name);
    }
}

// ---- 2 つ以上を指したとき ----

#[test]
fn edit_task_mark_mixed_targets_mark_only_non_tasks_and_keep_task_states() {
    // spec.md「2 つ以上を選んだとき」: 1 つでもタスクでないものがあればタスク化。タスクのものは状態のまま (data/task-mark-mixed。変異 M04)
    let source = "# 準備\n\n- 見積もりを取る\n- [ ] 荷造りの箱を買う\n- [/] 荷物をまとめる\n- [x] 新居を決める\n- [X] 業者を決める\n- [-] 古い家具を売る\n- 不用品を処分する\n";
    let names = [
        "見積もりを取る",
        "荷造りの箱を買う",
        "荷物をまとめる",
        "新居を決める",
        "業者を決める",
        "古い家具を売る",
        "不用品を処分する",
    ];
    let targets = by_names(source, &names);
    let result = toggle(source, &targets);
    let expected = "# 準備\n\n- [ ] 見積もりを取る\n- [ ] 荷造りの箱を買う\n- [/] 荷物をまとめる\n- [x] 新居を決める\n- [X] 業者を決める\n- [-] 古い家具を売る\n- [ ] 不用品を処分する\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    let states: Vec<Option<String>> = targets
        .iter()
        .map(|(id, _)| state_of(expected, *id))
        .collect();
    let wanted: Vec<Option<String>> = ["todo", "todo", "doing", "done", "done", "canceled", "todo"]
        .iter()
        .map(|state| Some((*state).to_string()))
        .collect();
    assert_eq!(states, wanted);
}

#[test]
fn edit_task_mark_one_non_task_among_tasks_keeps_the_tasks_as_they_are() {
    // タスクでないものが 1 つだけでもタスク化 (外さない)。見出しと項目が混ざっても同じ
    let source = "# R\n\n## [x] 設計\n- [/] 画面\n- API\n";
    let targets = by_names(source, &["設計", "画面", "API"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n## [x] 設計\n- [/] 画面\n- [ ] API\n",
        &targets,
    );
    assert_no_notes(&result);

    let source = "# R\n- 甲\n- [x] 乙\n";
    let targets = by_names(source, &["甲", "乙"]);
    let result = toggle(source, &targets);
    assert_toggled(source, &result, "# R\n- [ ] 甲\n- [x] 乙\n", &targets);
}

#[test]
fn edit_task_mark_all_tasks_unmark_every_target() {
    // 全部タスクなら全部外す。指していないタスクは変えない
    let source = "# R\n\n## [x] 設計\n- [/] 画面\n- [ ] API\n- [x] 残す\n";
    let targets = by_names(source, &["設計", "画面", "API"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n## 設計\n- 画面\n- API\n- [x] 残す\n",
        &targets,
    );
    assert_no_notes(&result);
}

#[test]
fn edit_task_mark_marking_then_unmarking_returns_the_source() {
    // 名前と id が変わらないので、同じ指し方で 2 回当てると元の原文に戻る (帯のボタンを続けて押す、screen/task-bar-one)
    let source = "---\nmarkdag:\n    groups:\n        g1:\n            label: 組\n    relations:\n        depends:\n            - 画面 --> 公開\n---\n\n# 計画\n\n## 設計 %g1\n- 画面 #owner:a\n- API $api\n\n## 公開\n";
    let names = ["計画", "設計", "画面", "API", "公開"];
    let targets = by_names(source, &names);
    let first = toggle(source, &targets);
    let marked = applied(source, &first);
    assert_same_outline(source, &marked);
    for (id, name) in &targets {
        assert_eq!(state_of(&marked, *id).as_deref(), Some("todo"), "{name}");
    }
    let second = toggle(&marked, &by_names(&marked, &names));
    assert_eq!(applied(&marked, &second), source);
}

// ---- タスクにできないノード ----

#[test]
fn edit_task_mark_skips_nodes_that_cannot_be_tasks() {
    // spec.md「2 つ以上を選んだとき」: タスクにできないノードは飛ばし、残りを書き換える。指したノードは飛ばしたものも選び直す
    // (data/task-mark-skip-not-taskable、data/task-mark-skip-empty-name)
    // 表 (id 5) と項目
    let source = "# 引っ越し\n\n## 準備\n- 見積もりを取る\n\n## 費用\n\n| 項目 | 金額 |\n| --- | --- |\n| 運送 | 50000 |\n";
    let mut targets = by_names(source, &["見積もりを取る"]);
    targets.extend(by_ids(source, &[5]));
    assert_eq!(kind_of(source, &targets[1]), "block");
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 引っ越し\n\n## 準備\n- [ ] 見積もりを取る\n\n## 費用\n\n| 項目 | 金額 |\n| --- | --- |\n| 運送 | 50000 |\n",
        &targets,
    );

    // コードと項目
    let source = "# R\n\n## 控え\n\n```\nmemo\n```\n\n## 準備\n- a\n";
    let code = nodes_of(source)
        .into_iter()
        .find(|node| node.parent == Some(named(source, "控え").id))
        .expect("コードのノード");
    let targets = vec![
        (code.id, code.ref_text.clone()),
        (named(source, "a").id, "a".to_string()),
    ];
    assert_eq!(kind_of(source, &targets[0]), "block");
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n## 控え\n\n```\nmemo\n```\n\n## 準備\n- [ ] a\n",
        &targets,
    );

    // 名前が空の項目 (id 3) と名前のある項目
    let source = "# 買い物\n\n## 準備\n- \n- 名前のある項目\n";
    let mut targets = by_ids(source, &[3]);
    targets.extend(by_names(source, &["名前のある項目"]));
    assert_eq!(targets[0].1, "");
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 買い物\n\n## 準備\n- \n- [ ] 名前のある項目\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_skips_list_containers_and_roots_without_a_line() {
    // リストの入れ物と自分の行を持たないルートもタスクにできない (spec.md「タスクにできるノード」)。項目と一緒なら飛ばす
    let source = "---\ntitle: 買い物リスト\n---\n\n- 牛乳\n- 卵\n";
    let root = named(source, "買い物リスト");
    let mut targets = vec![(root.id, root.ref_text.clone())];
    targets.extend(by_names(source, &["牛乳"]));
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "---\ntitle: 買い物リスト\n---\n\n- [ ] 牛乳\n- 卵\n",
        &targets,
    );

    // 見出しの下に 2 つあるリストの入れ物 (名前を持たない、項目の親)
    let source = "# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n";
    let red = named(source, "赤");
    let container = node_of(source, red.parent.expect("親がある"));
    let targets = vec![
        (container.id, container.ref_text.clone()),
        (red.id, "赤".to_string()),
    ];
    assert_eq!(kind_of(source, &targets[0]), "list");
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 二つのリスト\n\n- [ ] 赤\n- 青\n\n1. 一号\n2. 二号\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_skipped_nodes_do_not_count_when_every_other_target_is_a_task() {
    // 「全部タスク」はタスクにできるものだけで数える: 表とタスクだけを指せば、タスクを外す
    let source = "# R\n\n## 準備\n- [x] 見積もりを取る\n\n## 費用\n\n| 項目 | 金額 |\n| --- | --- |\n| 運送 | 50000 |\n";
    let mut targets = by_names(source, &["見積もりを取る"]);
    targets.extend(by_ids(source, &[5]));
    assert_eq!(kind_of(source, &targets[1]), "block");
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n## 準備\n- 見積もりを取る\n\n## 費用\n\n| 項目 | 金額 |\n| --- | --- |\n| 運送 | 50000 |\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_refuses_when_no_target_can_be_a_task() {
    // タスクにできるノードを 1 つも指していなければ、原文を変えずに断る (data/task-refused-block、task-refused-no-source-line、task-refused-empty-name)
    let source = "# 引っ越し\n\n## 費用\n\n| 項目 | 金額 |\n| --- | --- |\n| 運送 | 50000 |\n\n## 控え\n\n```\nmemo\n```\n";
    assert_refused(&toggle(source, &by_ids(source, &[3, 5])), "block-node");

    let source = "---\ntitle: 買い物リスト\n---\n\n- 牛乳\n- 卵\n";
    assert_refused(&toggle_named(source, &["買い物リスト"]), "no-source-line");

    let source = "# 買い物\n\n## 準備\n- \n- 名前のある項目\n";
    assert_refused(&toggle(source, &by_ids(source, &[3])), "empty-name");

    // 見出しのない、リストだけの文書のルート (リストの入れ物)
    let source = "- 牛乳\n- 卵\n";
    let root = nodes_of(source)
        .into_iter()
        .find(|node| node.parent.is_none())
        .expect("ルート");
    let result = toggle(source, &[(root.id, root.ref_text)]);
    assert_eq!(result["status"], "refused", "{result}");
}

#[test]
fn edit_task_mark_refuses_a_stale_target() {
    // どの操作も、解析し直した原文に同じ id と名前のノードがなければ stale-node で断る。2 つ以上を指すなら 1 つでも古ければ全体を断る
    let source = "# R\n- a\n- b\n";
    assert_refused(&toggle(source, &[(2, "z".to_string())]), "stale-node");
    let mut targets = by_names(source, &["a"]);
    targets.push((99, "b".to_string()));
    assert_refused(&toggle(source, &targets), "stale-node");
}

// ---- 名前が空のタスクの項目 ----

#[test]
fn edit_task_mark_unmarks_an_empty_named_task_by_escaping_the_mark() {
    // spec.md「書き換え」: 名前が空のタスクの項目 (`- [ ] `。図の名前は「[ ]」) の解除は `- \[ ]` と逃がし、名前と id は変えない。
    // 行末の空白は残さない (data/task-unmark-empty-name)
    let source = "# 買い物\n\n## 準備\n- [ ] \n- 名前のある項目\n";
    let targets = by_ids(source, &[3]);
    assert_eq!(targets[0].1, "[ ]");
    let result = toggle(source, &targets);
    let expected = "# 買い物\n\n## 準備\n- \\[ ]\n- 名前のある項目\n";
    assert_toggled(source, &result, expected, &targets);
    assert_no_notes(&result);
    assert_eq!(state_of(expected, 3), None);

    // もう一度当てると、名前「[ ]」のタスクでない項目をタスク化する (screen/task-unmark-empty-name)
    let again = toggle(expected, &by_ids(expected, &[3]));
    assert_eq!(
        applied(expected, &again),
        "# 買い物\n\n## 準備\n- [ ] \\[ ]\n- 名前のある項目\n"
    );
}

#[test]
fn edit_task_mark_unmarks_empty_named_tasks_with_trailing_marks_in_every_state() {
    // 名前が空で、記号のすぐあとに名前のあとの印が続くタスクも、状態によらず記号を逃がして名前として残す。大文字の [X] の名前は解析で [x]。
    // グループの所属は変えない (data/task-unmark-empty-name-forms の形に、大文字の完了と作業中と中止を足したもの。変異 M03 の穴を埋める案)
    let front = "---\nmarkdag:\n    groups:\n        g1:\n            label: 当日の組\n---\n\n";
    let source = format!("{front}# 準備\n\n- [X] %g1\n- [/] %g1\n- [-] %g1\n");
    let targets = by_ids(&source, &[2, 3, 4]);
    assert_eq!(
        targets
            .iter()
            .map(|(_, name)| name.as_str())
            .collect::<Vec<_>>(),
        ["[x]", "[/]", "[-]"]
    );
    let result = toggle(&source, &targets);
    let expected = format!("{front}# 準備\n\n- \\[x] %g1\n- \\[/] %g1\n- \\[-] %g1\n");
    assert_toggled(&source, &result, &expected, &targets);
    assert_no_notes(&result);
    for (id, _) in &targets {
        assert_eq!(state_of(&expected, *id), None);
        assert_eq!(node_of(&expected, *id).groups, ["g1"]);
    }

    // 承認した例の 4 つの形 (見出し、大文字の完了、作業中、末尾の印)
    let source = format!("{front}# 準備\n\n## [ ] \n- [X] \n- [/] \n- [ ] %g1\n");
    let targets = by_ids(&source, &[2, 3, 4, 5]);
    let result = toggle(&source, &targets);
    assert_toggled(
        &source,
        &result,
        &format!("{front}# 準備\n\n## \\[ ]\n- \\[x]\n- \\[/]\n- \\[ ] %g1\n"),
        &targets,
    );
}

// ---- 下線の見出し (U1) ----

#[test]
fn edit_task_mark_setext_headings_write_on_the_text_line() {
    // U1: 下線の見出し (=== と ---) は見出しの文字の行の先頭に [ ] を書き、下線の行は変えない (data/task-mark-setext、data/task-unmark-setext)
    let plain = "引っ越し\n===\n\n準備\n---\n\n- 見積もりを取る\n\n手続き\n---\n\n- 転出届を出す\n";
    let targets = by_names(plain, &["引っ越し", "準備"]);
    let result = toggle(plain, &targets);
    let marked =
        "[ ] 引っ越し\n===\n\n[ ] 準備\n---\n\n- 見積もりを取る\n\n手続き\n---\n\n- 転出届を出す\n";
    assert_toggled(plain, &result, marked, &targets);
    assert_no_notes(&result);
    for (id, name) in &targets {
        assert_eq!(state_of(marked, *id).as_deref(), Some("todo"), "{name}");
    }

    let done =
        "[x] 引っ越し\n===\n\n[/] 準備\n---\n\n- 見積もりを取る\n\n手続き\n---\n\n- 転出届を出す\n";
    let targets = by_names(done, &["引っ越し", "準備"]);
    let result = toggle(done, &targets);
    assert_toggled(done, &result, plain, &targets);
    assert_no_notes(&result);
}

// ---- 行の終わりと BOM ----

#[test]
fn edit_task_mark_keeps_crlf_line_endings() {
    // CRLF の文書は書き換えた行も CRLF のまま (data/task-mark-crlf)。外す向きも、見出しも同じ
    let source = "# 引っ越し\r\n\r\n- 見積もりを取る\r\n- [ ] 荷造りの箱を買う\r\n";
    let targets = by_names(source, &["見積もりを取る", "荷造りの箱を買う"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# 引っ越し\r\n\r\n- [ ] 見積もりを取る\r\n- [ ] 荷造りの箱を買う\r\n",
        &targets,
    );
    assert_no_notes(&result);

    let source = "# R\r\n\r\n## [-] H\r\n- [x] a\r\n- [/] b\r\n";
    let targets = by_names(source, &["H", "a", "b"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\r\n\r\n## H\r\n- a\r\n- b\r\n",
        &targets,
    );
    assert_no_notes(&result);
}

#[test]
fn edit_task_mark_keeps_a_document_without_a_final_newline() {
    // 改行で終わらない文書の最後の行を書いても、終わりは改行なしのまま (data/task-unmark-no-final-newline)。CRLF の文書でも同じ
    assert_one(
        "# 確認\n\n- [ ] 点検\n- [x] 報告",
        "報告",
        "# 確認\n\n- [ ] 点検\n- 報告",
        None,
    );
    assert_one(
        "# 確認\n\n- [ ] 点検\n- 報告",
        "報告",
        "# 確認\n\n- [ ] 点検\n- [ ] 報告",
        Some("todo"),
    );
    assert_one("# R\r\n\r\n## H", "H", "# R\r\n\r\n## [ ] H", Some("todo"));
    assert_one("# R\r\n- [x] a", "a", "# R\r\n- a", None);
}

#[test]
fn edit_task_mark_removes_the_bom_only_when_writing_the_first_line() {
    // spec.md「書き換え」: 文書の先頭に BOM があり 1 行目のノードに記号を書くときは BOM を外す (data/task-mark-bom-first-line、
    // data/task-mark-bom-heading-crlf)。2 行目から下だけを書くときは BOM に触らない (screen/task-bom-first-line、data/task-unmark-bom-later-lines)。
    // BOM を外した知らせを editSource が出すかは決まっていないので、知らせは見ない
    let source = "\u{feff}- 一行目の項目\n- 二行目の項目\n- [ ] 三行目のタスク\n";
    let targets = by_names(source, &["一行目の項目", "二行目の項目"]);
    let result = toggle(source, &targets);
    let expected = "- [ ] 一行目の項目\n- [ ] 二行目の項目\n- [ ] 三行目のタスク\n";
    assert_toggled(source, &result, expected, &targets);
    for (id, name) in &targets {
        assert_eq!(state_of(expected, *id).as_deref(), Some("todo"), "{name}");
    }

    let targets = by_names(source, &["一行目の項目"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "- [ ] 一行目の項目\n- 二行目の項目\n- [ ] 三行目のタスク\n",
        &targets,
    );

    let targets = by_names(source, &["二行目の項目"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "\u{feff}- 一行目の項目\n- [ ] 二行目の項目\n- [ ] 三行目のタスク\n",
        &targets,
    );

    let source = "\u{feff}# 引っ越し\r\n\r\n## 準備\r\n- 見積もりを取る\r\n";
    let targets = by_names(source, &["引っ越し"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# [ ] 引っ越し\r\n\r\n## 準備\r\n- 見積もりを取る\r\n",
        &targets,
    );

    let source = "\u{feff}# 引っ越し\n\n## 準備\n- [ ] 見積もりを取る\n- [x] 不用品を処分する\n- 荷造りの箱を買う\n";
    let targets = by_names(source, &["見積もりを取る", "不用品を処分する"]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "\u{feff}# 引っ越し\n\n## 準備\n- 見積もりを取る\n- 不用品を処分する\n- 荷造りの箱を買う\n",
        &targets,
    );
    assert_no_notes(&result);
}

// ---- 規則 (U2) ----

#[test]
fn edit_task_mark_does_not_apply_require_upstream_done() {
    // U2: 上流の完了を求める規則 (requireUpstreamDone) はタスク化とタスク解除に当てない。上流が未完了でも書き換える
    let front = "---\nmarkdag:\n    rules:\n        taskToggle:\n            requireUpstreamDone: true\n    relations:\n        depends:\n            - 設計 --> 実装\n---\n\n";
    let source = format!("{front}# R\n- [ ] 設計\n- 実装\n");
    let targets = by_names(&source, &["実装"]);
    let result = toggle(&source, &targets);
    assert_toggled(
        &source,
        &result,
        &format!("{front}# R\n- [ ] 設計\n- [ ] 実装\n"),
        &targets,
    );

    let source = format!("{front}# R\n- [ ] 設計\n- [x] 実装\n");
    let targets = by_names(&source, &["実装"]);
    let result = toggle(&source, &targets);
    assert_toggled(
        &source,
        &result,
        &format!("{front}# R\n- [ ] 設計\n- 実装\n"),
        &targets,
    );
}

// ---- 1 行目が文章でない項目と、外すと HTML のブロックとして読まれるタスク (レビューの B-01、A-02、B-02、B-03、A-01) ----
// どちらも「タスクにできないノード」と同じ扱い: 1 つだけなら原文を変えずに断り (帯のボタンは無効、チェックは出さない)、2 つ以上ならそのノードだけを飛ばす。
// 判定は原文の事実 (inspectNode) の canToggleTask にも出す

const NOT_TEXT: &str = "1 行目が文章でない項目はタスクにできません";
const HTML_AFTER_UNMARK: &str =
    "タスクの記号を外すと HTML として読まれるため、タスク解除できません";
const EMPTY_NAME: &str = "名前が空の項目はタスクにできません。先に名前を付けてください";
const KEYED: &str = "---\nmarkdag:\n---\n";

// 原文の事実 (inspectNode) の JSON
fn facts_of(source: &str, (id, ref_text): &Target) -> Value {
    let target: NodeTarget = serde_json::from_value(json!({ "id": id, "refText": ref_text }))
        .expect("NodeTarget の JSON");
    serde_json::to_value(inspect_node(source, &target)).expect("JSON にできる")
}

fn assert_refused_because(result: &Value, code: &str, message: &str) {
    assert_refused(result, code);
    assert_eq!(result["reason"]["message"], message, "{result}");
}

#[test]
fn edit_task_mark_refuses_items_whose_first_line_is_not_text() {
    // markdag キーのない文書で、項目の 1 行目の印のあとが段落の書き始めでない形は、タスクにできないノード。1 つだけを指せば原文を変えずに
    // marker-line で断り、事実の canToggleTask は false。印のあとの空白が 5 桁以上 (字下げのコード。タブは 4 の倍数の桁まで進めて数える)、
    // 見出し、引用、リスト (1 行に 2 つの印は外側と内側の両方)、柵、区切り線、1 行目が空で 2 行目から名前を読む項目。
    // 番号付きの項目のコードの中に記号を書かない (B-01)。HTML のブロックで始まる項目は例外で、下の付け外しのテストが見る
    let forms: [(&str, &[u32]); 16] = [
        ("-     a", &[2]),
        ("-      a", &[2]),
        ("-\t\ta", &[2]),
        ("  -\t\ta", &[2]),
        ("1.     a", &[2]),
        ("1.\t\ta", &[2]),
        ("- # a", &[2]),
        ("- > a", &[2]),
        ("1. - a", &[2, 3]),
        ("- - a", &[2]),
        ("- 1. a", &[2]),
        ("- ```\n  x\n  ```", &[2]),
        ("- ~~~", &[2]),
        ("- ***", &[2]),
        ("-\n  a", &[2]),
        ("1.\n   a", &[2]),
    ];
    for (form, ids) in forms {
        let source = format!("# R\n\n{form}\n- z\n");
        for target in by_ids(&source, ids) {
            let facts = facts_of(&source, &target);
            assert_eq!(
                facts["task"],
                json!(false),
                "{source:?} の {target:?}: {facts}"
            );
            assert_eq!(
                facts["canToggleTask"],
                json!(false),
                "{source:?} の {target:?}: {facts}"
            );
            let result = toggle(&source, std::slice::from_ref(&target));
            assert_refused_because(&result, "marker-line", NOT_TEXT);
        }
    }
}

#[test]
fn edit_task_mark_keeps_the_empty_name_reason_for_items_without_a_name() {
    // 名前が空の項目の理由 (empty-name と、名前を付けるよう求める文) は、本当に名前が空の項目 (1 行目にも 2 行目からも名前がない) だけに出す。
    // markdag キーのある文書の 1 行目が空の項目は、2 行目があっても名前を持たない (A-219)。2 行目から名前を読む項目は上の 1 行目が文章でない理由 (B-03)
    let sources = [
        "# R\n\n- \n- z\n".to_string(),
        "# R\n\n-\n- z\n".to_string(),
        "# R\n\n1.\n2. z\n".to_string(),
        format!("{KEYED}# R\n\n-\n  a\n- z\n"),
    ];
    for source in &sources {
        let target = by_ids(source, &[2]).remove(0);
        assert_eq!(
            facts_of(source, &target)["canToggleTask"],
            json!(false),
            "{source:?}"
        );
        let result = toggle(source, &[target]);
        assert_refused_because(&result, "empty-name", EMPTY_NAME);
    }
}

#[test]
fn edit_task_mark_skips_items_whose_first_line_is_not_text_among_other_targets() {
    // 2 つ以上を指せば、1 行目が文章でない項目は飛ばして残りを書く (全体を断らない)。飛ばした項目の行は変えず、指したノードは全部選び直す
    let source = "# R\n\n1. a\n2.     b\n3. # c\n4. d\n";
    let targets = by_ids(source, &[2, 3, 4, 5]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n1. [ ] a\n2.     b\n3. # c\n4. [ ] d\n",
        &targets,
    );

    let source = "# R\n\n-     a\n-\n  b\n- c\n";
    let targets = by_ids(source, &[2, 3, 4]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n-     a\n-\n  b\n- [ ] c\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_refuses_unmarking_tasks_that_would_be_read_as_html_blocks() {
    // 記号を外すと本文が HTML のブロックとして読まれて見出しでなくなる下線の見出しのタスクは、キーの有無によらずタスク解除できないノード。
    // `\` で逃がして HTML を文字に変える書き換えはしない。1 つだけを指せば原文を変えずに marker-line で断り、事実の canToggleTask は false (A-01、B-02)。
    // 項目は外しても Markdown の表示が記号のほか変わらないので外す (下の付け外しのテスト)
    let sources = [
        "# R\n\n[x] <div>a</div>\n---\n".to_string(),
        "# R\n\n[/] <p>a</p>\n---\n".to_string(),
        format!("{KEYED}# R\n\n[x] <div>a</div>\n---\n"),
    ];
    for source in &sources {
        let target = by_ids(source, &[2]).remove(0);
        let facts = facts_of(source, &target);
        assert_eq!(facts["kind"], "heading", "{source:?}: {facts}");
        assert_eq!(facts["task"], json!(true), "{source:?}: {facts}");
        assert_eq!(facts["canToggleTask"], json!(false), "{source:?}: {facts}");
        let result = toggle(source, &[target]);
        assert_refused_because(&result, "marker-line", HTML_AFTER_UNMARK);
    }
}

#[test]
fn edit_task_mark_unmarks_html_names_without_escaping_where_they_are_read_as_text() {
    // ATX の見出しの中は行内だけを読み、markdag キーのある文書の項目は 1 行目を文字として読む (A-219) ので、HTML で始まる名前のタスクは
    // `\` を足さずに外す (HTML を文字に変えない)。名前と id は変わらない (A-01 のキーのある文書)
    let cases = [
        (
            "# R\n\n## [x] <div>a</div>\n".to_string(),
            "# R\n\n## <div>a</div>\n".to_string(),
        ),
        (
            format!("{KEYED}# R\n\n## [ ] <div>a</div>\n"),
            format!("{KEYED}# R\n\n## <div>a</div>\n"),
        ),
        (
            format!("{KEYED}# R\n\n- [ ] <div>a</div>\n- z\n"),
            format!("{KEYED}# R\n\n- <div>a</div>\n- z\n"),
        ),
        (
            format!("{KEYED}# R\n\n- [x] <!-- c -->\n- z\n"),
            format!("{KEYED}# R\n\n- <!-- c -->\n- z\n"),
        ),
    ];
    for (source, expected) in &cases {
        let targets = by_ids(source, &[2]);
        assert_eq!(
            facts_of(source, &targets[0])["canToggleTask"],
            json!(true),
            "{source:?}"
        );
        let result = toggle(source, &targets);
        assert_toggled(source, &result, expected, &targets);
        assert_eq!(state_of(expected, 2), None, "{expected:?}");
    }
}

#[test]
fn edit_task_mark_skips_tasks_that_cannot_be_unmarked_among_other_targets() {
    // 外せないタスク (外すと見出しでなくなる下線の見出し) は、ほかに指したノードが全部タスクなら飛ばして残りを外す。
    // タスクでないノードがあればタスク化で、外せないタスクは状態のまま
    let source = "# R\n\n[ ] <div>a</div>\n---\n\n- [x] b\n- c\n";
    let targets = by_ids(source, &[2, 3]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n[ ] <div>a</div>\n---\n\n- b\n- c\n",
        &targets,
    );

    let targets = by_ids(source, &[2, 4]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n[ ] <div>a</div>\n---\n\n- [x] b\n- [ ] c\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_inspect_tells_whether_the_task_mark_can_be_toggled() {
    // 事実の canToggleTask: タスクでないノードは記号を付けられるか、タスクは記号を外せるか。自分の行を持つ見出しと項目 (ルート、下線の見出し、
    // 名前が `[ ]` の項目、どの状態のタスクも) はでき、名前が空の項目、表、リストの入れ物、自分の行を持たないルートはできない
    let source = "# R\n\n## 準備\n- a\n- [/] b\n- \\[ ] c\n- \n\n下線\n---\n\n## 費用\n\n| x | y |\n| - | - |\n| 1 | 2 |\n";
    for target in by_names(source, &["R", "準備", "a", "b", "[ ] c", "下線", "費用"]) {
        assert_eq!(
            facts_of(source, &target)["canToggleTask"],
            json!(true),
            "{target:?}"
        );
    }
    let empty = by_ids(source, &[6]).remove(0);
    assert_eq!(empty.1, "");
    assert_eq!(facts_of(source, &empty)["kind"], "item");
    let table = nodes_of(source)
        .into_iter()
        .find(|node| node.parent == Some(named(source, "費用").id))
        .expect("表のノード");
    for target in [empty, (table.id, table.ref_text.clone())] {
        assert_eq!(
            facts_of(source, &target)["canToggleTask"],
            json!(false),
            "{target:?}"
        );
    }

    let titled = "---\ntitle: 買い物リスト\n---\n\n- 牛乳\n- 卵\n";
    let root = by_names(titled, &["買い物リスト"]).remove(0);
    assert_eq!(facts_of(titled, &root)["canToggleTask"], json!(false));

    let lists = "# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n";
    let container = node_of(lists, named(lists, "赤").parent.expect("親がある"));
    let target = (container.id, container.ref_text.clone());
    assert_eq!(facts_of(lists, &target)["kind"], "list");
    assert_eq!(facts_of(lists, &target)["canToggleTask"], json!(false));
}

// ---- 1 行目が文章でない項目は markdag キーの有無によらない。名前が HTML のブロックで始まる項目はその例外 ----
// 1 行目が文章かは、markdag キーのある文書でも、Markdown (CommonMark / GFM) として 1 行目の中身が段落になるかで決める
// (キーのある文書の解析は 1 行目を文字として読むが、記号を書くと Markdown の表示では記号がコードの字になったりブロックの前に出たりする)。
// 名前が HTML のブロックで始まる項目は、記号の有無で Markdown の表示がチェックのほか変わらず、図の名前も変わらないので、
// キーの有無によらず `\` を足さずに付け外しする。下線の見出しは外すと見出しでなくなるので、外せないまま

#[test]
fn edit_task_mark_refuses_items_whose_first_line_is_not_text_in_documents_with_the_markdag_key() {
    // markdag キーのある文書の同じ形も、タスクにできないノード。1 つだけを指せば原文を変えずに marker-line で断り、事実の canToggleTask は false。
    // 1 行目を文字として読む規則の候補に当たらない形 (印のあとが空白 4 つとタブ、リンクの参照の定義) も同じ
    let forms = [
        "-     a",
        "-      a",
        "-\t\ta",
        "1.     a",
        "1.\t\ta",
        "- # a",
        "- > a",
        "- - a",
        "1. - a",
        "- 1. a",
        "- ```\n  x\n  ```",
        "- ~~~",
        "- ***",
        "-    \ta",
        "- [a]: http://x",
    ];
    for form in forms {
        let source = format!("{KEYED}# R\n\n{form}\n- z\n");
        let target = by_ids(&source, &[2]).remove(0);
        let facts = facts_of(&source, &target);
        assert_eq!(facts["kind"], "item", "{source:?}: {facts}");
        assert_eq!(facts["task"], json!(false), "{source:?}: {facts}");
        assert_eq!(facts["canToggleTask"], json!(false), "{source:?}: {facts}");
        let result = toggle(&source, std::slice::from_ref(&target));
        assert_refused_because(&result, "marker-line", NOT_TEXT);
    }
}

#[test]
fn edit_task_mark_skips_items_whose_first_line_is_not_text_among_other_targets_in_documents_with_the_markdag_key()
 {
    // 2 つ以上を指せば、キーのある文書でも 1 行目が文章でない項目だけを飛ばして残りを書く
    let source = format!("{KEYED}# R\n\n1. a\n2.     b\n3. # c\n4. d\n");
    let targets = by_ids(&source, &[2, 3, 4, 5]);
    let result = toggle(&source, &targets);
    assert_toggled(
        &source,
        &result,
        &format!("{KEYED}# R\n\n1. [ ] a\n2.     b\n3. # c\n4. [ ] d\n"),
        &targets,
    );
}

#[test]
fn edit_task_mark_toggles_items_whose_name_starts_with_html_without_escaping() {
    // 名前が HTML のブロックで始まる項目と、`\` で逃がしてある項目は、キーの有無によらずタスク化とタスク解除を行き来する。
    // `\` は足さず、あるものは残す。名前と id は変わらない。番号付きの項目はキーのある文書だけ (キーのない文書は下の名前が変わる形)
    let pairs = [
        ("", "- <div>a</div>", "- [ ] <div>a</div>"),
        ("", "- <div> a", "- [ ] <div> a"),
        ("", "* <p>a</p>", "* [ ] <p>a</p>"),
        ("", "- \\<div>a</div>", "- [ ] \\<div>a</div>"),
        ("", "- <!-- c -->", "- [ ] <!-- c -->"),
        (KEYED, "- <div>a</div>", "- [ ] <div>a</div>"),
        (KEYED, "- <div> a", "- [ ] <div> a"),
        (KEYED, "* <p>a</p>", "* [ ] <p>a</p>"),
        (KEYED, "- \\<div>a</div>", "- [ ] \\<div>a</div>"),
        (KEYED, "- <!-- c -->", "- [ ] <!-- c -->"),
        (KEYED, "1. <div>a</div>", "1. [ ] <div>a</div>"),
    ];
    for (head, plain, task) in pairs {
        let source = format!("{head}# R\n\n{plain}\n- z\n");
        let marked = format!("{head}# R\n\n{task}\n- z\n");
        let targets = by_ids(&source, &[2]);
        let facts = facts_of(&source, &targets[0]);
        assert_eq!(facts["task"], json!(false), "{source:?}: {facts}");
        assert_eq!(facts["canToggleTask"], json!(true), "{source:?}: {facts}");
        let result = toggle(&source, &targets);
        assert_toggled(&source, &result, &marked, &targets);
        assert_no_notes(&result);
        assert_eq!(state_of(&marked, 2).as_deref(), Some("todo"), "{marked:?}");

        let targets = by_ids(&marked, &[2]);
        let facts = facts_of(&marked, &targets[0]);
        assert_eq!(facts["task"], json!(true), "{marked:?}: {facts}");
        assert_eq!(facts["canToggleTask"], json!(true), "{marked:?}: {facts}");
        let result = toggle(&marked, &targets);
        assert_toggled(&marked, &result, &source, &targets);
        assert_no_notes(&result);
        assert_eq!(state_of(&source, 2), None, "{source:?}");
    }
}

#[test]
fn edit_task_mark_unmarks_html_names_of_every_state_without_escaping() {
    // 状態によらず (`[x]`、`[X]`、`[/]`、`[-]`)、HTML のブロックで始まる名前のタスクは、キーの有無によらず記号だけを外す
    let cases = [
        ("- [x] <div>a</div>", "- <div>a</div>"),
        ("- [X] <div>a</div>", "- <div>a</div>"),
        ("* [/] <p>a</p>", "* <p>a</p>"),
        ("- [-] <div>a</div>", "- <div>a</div>"),
        ("- [x] <!-- c -->", "- <!-- c -->"),
    ];
    for head in ["", KEYED] {
        for (task, plain) in cases {
            let source = format!("{head}# R\n\n{task}\n- z\n");
            let expected = format!("{head}# R\n\n{plain}\n- z\n");
            let targets = by_ids(&source, &[2]);
            assert_eq!(
                facts_of(&source, &targets[0])["canToggleTask"],
                json!(true),
                "{source:?}"
            );
            let result = toggle(&source, &targets);
            assert_toggled(&source, &result, &expected, &targets);
            assert_eq!(state_of(&expected, 2), None, "{expected:?}");
        }
    }
}

#[test]
fn edit_task_mark_mixed_targets_unmark_html_names_with_other_tasks() {
    // HTML で始まる名前のタスクは、ほかのタスクと一緒に外す (スキップしない)
    let source = "# R\n\n- [ ] <div>a</div>\n- [x] b\n- c\n";
    let targets = by_ids(source, &[2, 3]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n- <div>a</div>\n- b\n- c\n",
        &targets,
    );
}

#[test]
fn edit_task_mark_refuses_html_names_whose_reading_changes_with_the_mark_without_the_markdag_key() {
    // markdag キーのない文書の解析は、記号のない 1 行目を HTML のブロックとして読み、記号のある 1 行目を段落として読む。すぐ下 (空行なし) に
    // 詳細の引用、子のリスト、名前の続きの行が続くと、記号がなければ HTML のブロックがその行を飲み込み、記号があれば段落のあとの引用やリスト、
    // 段落の続きに読まれる。番号付きの項目は記号の有無で名前が変わる。どちらも図の形か名前か内容が変わるので書かない: 付けるなら 1 行目が
    // 文章でない項目、外すなら記号を外すと HTML として読まれるタスクとして、事実の canToggleTask は false、1 つだけなら原文を変えずに断る。
    // キーのある文書は 1 行目を文字として読むので、どちらの向きも書く
    let pairs = [
        ("- <div>a</div>\n  > 詳細", "- [ ] <div>a</div>\n  > 詳細"),
        ("- <div>a</div>\n  - b", "- [ ] <div>a</div>\n  - b"),
        ("- <div>a</div>\n  続き", "- [ ] <div>a</div>\n  続き"),
        ("1. <div>a</div>", "1. [ ] <div>a</div>"),
    ];
    for (plain, task) in pairs {
        for (source, message) in [
            (format!("# R\n\n{plain}\n- z\n"), NOT_TEXT),
            (format!("# R\n\n{task}\n- z\n"), HTML_AFTER_UNMARK),
        ] {
            let target = by_ids(&source, &[2]).remove(0);
            assert_eq!(
                facts_of(&source, &target)["canToggleTask"],
                json!(false),
                "{source:?}"
            );
            let result = toggle(&source, &[target]);
            assert_refused_because(&result, "marker-line", message);
        }
        let source = format!("{KEYED}# R\n\n{plain}\n- z\n");
        let marked = format!("{KEYED}# R\n\n{task}\n- z\n");
        let targets = by_ids(&source, &[2]);
        assert_toggled(&source, &toggle(&source, &targets), &marked, &targets);
        let targets = by_ids(&marked, &[2]);
        assert_toggled(&marked, &toggle(&marked, &targets), &source, &targets);
    }

    // 2 つ以上を指せば、そのノードだけを飛ばして残りを書く
    let source = "# R\n\n- <div>a</div>\n  > 詳細\n- z\n";
    let targets = by_ids(source, &[2, 3]);
    let result = toggle(source, &targets);
    assert_toggled(
        source,
        &result,
        "# R\n\n- <div>a</div>\n  > 詳細\n- [ ] z\n",
        &targets,
    );
}

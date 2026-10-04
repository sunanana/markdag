// GUI 編集の frontmatter の書き換えのテスト: 書き換えの土台と線を引く addRelation (CRLF、単独の \r、BOM、stale-node、JSON の形、
// 参照の書き方と数え方の原文、frontmatter の足し方と消し方)、合流と参照の追随、グループの書き換え。
// 公開の markdag_core::edit::edit_source と、解析とモデルの公開の関数 (parse_document、build_model) だけを使う。
// 入力は境界と同じ JSON を serde で読んで作り、出力は serde の JSON にして比べる。
// 期待の文書は、比べる前に解析し直して「引いた線がモデルの relations に出て、参照と YAML の診断がない」ことを確かめ、
// 指すノードは操作の前に原文の解析で id と refText を確かめる (期待の書き誤りを、実装の前の赤の確認で見分けるため)。
// 関数名は `cargo test -p markdag-core edit_frontmatter_` で選ばれるよう edit_frontmatter_ で始める。
use markdag_core::edit::edit_source;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::parse::parse_document;
use markdag_core::types::{EditOp, NodeTarget, OutlineNode, RelationKind};
use serde_json::{Value, json};

// ---- 入出力の補助 ----

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

type Target<'a> = (u32, &'a str);

fn node_of(source: &str, id: u32) -> OutlineNode {
    parse_document(source)
        .nodes
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
fn assert_target(source: &str, (id, ref_text): Target) {
    assert_eq!(node_of(source, id).ref_text, ref_text, "{source:?}");
}

fn add_relation_unchecked(source: &str, from: Target, to: Target) -> Value {
    let op = op(json!({
        "kind": "addRelation",
        "from": { "id": from.0, "refText": from.1 },
        "to": { "id": to.0, "refText": to.1 },
    }));
    normalized(
        serde_json::to_value(edit_source(source, &op)).expect("EditSourceResult は JSON にできる"),
    )
}

fn add_relation(source: &str, from: Target, to: Target) -> Value {
    assert_target(source, from);
    assert_target(source, to);
    add_relation_unchecked(source, from, to)
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

// 線と参照と frontmatter の形の誤りの診断 (引いた線が解決できなかった、YAML として読めない、スキーマに合わない)
fn is_broken_relation_diagnostic(code: &str) -> bool {
    code.starts_with("ref-")
        || code.starts_with("relation-")
        || code.starts_with("yaml-")
        || code.starts_with("option-")
        || code == "cycle"
}

// 原文を解析し直したモデルの relations に、from から to への depends の線が出て、線と参照と YAML の診断がない
fn assert_relation_resolves(source: &str, from: u32, to: u32) {
    let parsed = parse_document(source);
    let model = build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    );
    assert!(
        model
            .relations
            .iter()
            .any(|relation| relation.source == from
                && relation.target == to
                && relation.kind == RelationKind::Depends),
        "{from} --> {to} の depends の線がある: {source:?}: {:?}",
        model.relations
    );
    let broken: Vec<String> = model
        .diagnostics
        .iter()
        .filter(|diagnostic| is_broken_relation_diagnostic(&diagnostic.code))
        .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
        .collect();
    assert!(broken.is_empty(), "{source:?}: {broken:?}");
}

// 原文の markdag.relations.depends を YAML として読み直した値
fn depends_of(source: &str) -> Value {
    let frontmatter = serde_json::to_value(parse_document(source).frontmatter)
        .expect("frontmatter は JSON にできる");
    frontmatter["markdag"]["relations"]["depends"].clone()
}

// 引いた線を選ぶ (EdgeTarget は図の線の kind と端点)
fn drawn_edge(from: u32, to: u32) -> Value {
    normalized(
        json!({ "kind": "edge", "edge": { "kind": "depends", "source": from, "target": to } }),
    )
}

fn assert_selects_the_drawn_edge(result: &Value, from: u32, to: u32) {
    assert_eq!(result["select"], drawn_edge(from, to), "{result}");
    // 線を引いたあとに名前の入力は開かない
    assert_eq!(result["rename"], Value::Null, "{result}");
}

// 線を引いた結果: 書き換えたあとの原文の全体、select が引いた線 (書き換えたあとの原文の id)、rename が null。
// 期待の文書を先に解析し直して、線がモデルに出ることを確かめる
fn assert_drawn(source: &str, result: &Value, expected: &str, from: u32, to: u32) {
    assert_relation_resolves(expected, from, to);
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_selects_the_drawn_edge(result, from, to);
}

// 行末の空白を比べない (`markdag: ~` の値の範囲を消したあとの `markdag: ` の空白は、約束にしない)
fn without_trailing_spaces(text: &str) -> String {
    text.split('\n')
        .map(|line| line.trim_end_matches(' '))
        .collect::<Vec<_>>()
        .join("\n")
}

fn assert_drawn_ignoring_trailing_spaces(
    source: &str,
    result: &Value,
    expected: &str,
    from: u32,
    to: u32,
) {
    assert_relation_resolves(expected, from, to);
    assert_eq!(
        without_trailing_spaces(&applied(source, result)),
        expected,
        "{source:?}: {result}"
    );
    assert_selects_the_drawn_edge(result, from, to);
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

fn assert_refused(result: &Value, code: &str) {
    assert_reason(result, "refused", code);
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

// ---- 文書 ----

// frontmatter のない文書と `markdag:` だけの文書に a --> b を引いたときに作る frontmatter (字下げの幅は 4)
const CREATED_AB: &str =
    "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n";

// ---- frontmatter と markdag: を作る ----

#[test]
fn edit_frontmatter_add_relation_creates_frontmatter_when_there_is_none() {
    // frontmatter、markdag、relations、depends を文書の先頭に作る。もとの 1 行目が空でなければ、閉じの --- のあとに空行を 1 つ入れる
    let source = "# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}\n# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes_include(&result, &["frontmatter-added"]);
    assert!(
        !note_codes(&result).contains(&"bom-removed".to_string()),
        "{result}"
    );

    // もとの 1 行目が空なら空行を足さない (その空行が閉じの --- のあとに残る)
    let source = "\n# R\n- a\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        &format!("{CREATED_AB}\n# R\n- a\n- b\n"),
        2,
        3,
    );

    // 改行で終わらない文書も、終わり方は変わらない
    let source = "# R\n- a\n- b";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        &format!("{CREATED_AB}\n# R\n- a\n- b"),
        2,
        3,
    );

    // CRLF の文書では足す行に \r を付ける
    let source = "# R\r\n- a\r\n- b\r\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n\r\n# R\r\n- a\r\n- b\r\n",
        2,
        3,
    );
}

#[test]
fn edit_frontmatter_add_relation_adds_markdag_to_a_frontmatter_without_it() {
    // 最上位の写像の末尾 (閉じの --- の前) に markdag: と子の行を足す (note markdag-added)
    let source = "---\ntitle: T\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &["markdag-added"]);

    // 空の frontmatter (--- の次の行が ---) は、その間に入れる
    let source = "---\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes(&result, &["markdag-added"]);
}

#[test]
fn edit_frontmatter_add_relation_fills_a_bare_markdag_key() {
    // `markdag:` だけ (値の字のない null) なら、キーの行のあとに子の行を入れる。markdag キーはあるので notes は空
    let source = "---\nmarkdag:\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes(&result, &[]);

    // markdag: のあとに兄弟のキーがあっても、markdag: の行のすぐあとに入れる
    let source = "---\nmarkdag:\ntitle: T\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\ntitle: T\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &[]);

    // relations: だけ (Null) にも続けて書く
    let source = "---\nmarkdag:\n    relations:\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes(&result, &[]);
}

#[test]
fn edit_frontmatter_add_relation_replaces_null_values_written_as_text() {
    // 値の字がある null (`~`、`null`) は、キーの行の値の範囲を消して Null と同じに続ける。
    // 値の範囲を消したあとの行末の空白は比べない
    for source in [
        "---\nmarkdag: ~\n---\n# R\n- a\n- b\n",
        "---\nmarkdag: null\n---\n# R\n- a\n- b\n",
        "---\nmarkdag:\n    relations: ~\n---\n# R\n- a\n- b\n",
    ] {
        let result = add_relation(source, (2, "a"), (3, "b"));
        assert_drawn_ignoring_trailing_spaces(
            source,
            &result,
            &format!("{CREATED_AB}# R\n- a\n- b\n"),
            2,
            3,
        );
        assert_notes(&result, &[]);
    }
}

// ---- depends に足す ----

#[test]
fn edit_frontmatter_add_relation_adds_depends_next_to_other_kinds() {
    // relations があって depends がない: relations の写像の末尾に depends: と項目を足す。
    // キーの字下げは relations の子 (8)、新しく作る一覧の項目は キーの字下げ + 幅 (4)
    let source = "---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n";
    let result = add_relation(source, (3, "b"), (4, "c"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );
    assert_notes(&result, &[]);

    // 書き足さない kind の式 1 つの値 (chain: a --> b) は書き直さない
    let source = "---\nmarkdag:\n    relations:\n        chain: a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (3, "b"), (4, "c")),
        "---\nmarkdag:\n    relations:\n        chain: a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );
}

#[test]
fn edit_frontmatter_add_relation_appends_to_the_end_of_depends() {
    // 既存の depends の最後の項目のすぐあとに足す。あとに続くキー (edgeHighlight、chain) の並びは変えない
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n    edgeHighlight: true\n---\n# R\n- a\n- b\n- c\n";
    let result = add_relation(source, (2, "a"), (4, "c"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - a --> c\n    edgeHighlight: true\n---\n# R\n- a\n- b\n- c\n",
        2,
        4,
    );
    assert_notes(&result, &[]);

    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n        chain:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (4, "c")),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - a --> c\n        chain:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n",
        2,
        4,
    );

    // 終点から始点への向き (文書で後ろのノードから前のノード) も、そのまま書く
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (4, "c"), (2, "a")),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - c --> a\n---\n# R\n- a\n- b\n- c\n",
        4,
        2,
    );
}

#[test]
fn edit_frontmatter_add_relation_rewrites_a_single_expression_as_a_list() {
    // depends の値が式 1 つのスカラなら、キーの行を「キー:」と「- もとの式」の 2 行に書き直してから足す
    let source =
        "---\nmarkdag:\n    relations:\n        depends: a --> b\n---\n# R\n- a\n- b\n- c\n";
    let result = add_relation(source, (3, "b"), (4, "c"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );
    assert_notes(&result, &[]);

    // 字下げが 2 の frontmatter では、項目の字下げは キーの字下げ + 2
    let source = "---\nmarkdag:\n  relations:\n    depends: a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (3, "b"), (4, "c")),
        "---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n      - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );
}

#[test]
fn edit_frontmatter_add_relation_rewrites_block_scalar_kinds_as_lists() {
    // depends の値が複数行のスカラ (| と >) なら、中身の空でない行ごとに 1 項目の - の一覧に書き直してから足す (D-059)
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n---\n# R\n- a\n- b\n- c\n";
    for source in [
        "---\nmarkdag:\n    relations:\n        depends: |\n            a --> b\n---\n# R\n- a\n- b\n- c\n",
        "---\nmarkdag:\n    relations:\n        depends: >-\n            a --> b\n---\n# R\n- a\n- b\n- c\n",
    ] {
        let result = add_relation(source, (3, "b"), (4, "c"));
        assert_drawn(source, &result, expected, 3, 4);
        assert_notes(&result, &[]);
    }
}

// ---- 同じノードと、もうある線 ----

#[test]
fn edit_frontmatter_add_relation_refuses_the_same_node() {
    for source in [
        "---\nmarkdag:\n---\n# R\n- a\n- b\n",
        // markdag キーのない文書と frontmatter のない文書でも、何も足さずに断る
        "---\ntitle: T\n---\n# R\n- a\n- b\n",
        "# R\n- a\n- b\n",
    ] {
        assert_refused(&add_relation(source, (2, "a"), (2, "a")), "same-node");
    }
}

#[test]
fn edit_frontmatter_add_relation_refuses_an_existing_edge() {
    // depends にもうある線 (一覧と式 1 つ)。chain、fork、join が展開した線も、図に同じ向きでもうある線として断る
    let body = "# R\n- a\n- b\n- c\n";
    for (relations, from, to) in [
        (
            "        depends:\n            - a --> b\n",
            (2, "a"),
            (3, "b"),
        ),
        ("        depends: a --> b\n", (2, "a"), (3, "b")),
        (
            "        chain:\n            - a --> b --> c\n",
            (3, "b"),
            (4, "c"),
        ),
        (
            "        fork:\n            - a --> b & c\n",
            (2, "a"),
            (4, "c"),
        ),
        (
            "        join:\n            - a & b --> c\n",
            (3, "b"),
            (4, "c"),
        ),
    ] {
        let source = format!("---\nmarkdag:\n    relations:\n{relations}---\n{body}");
        assert_refused(&add_relation(&source, from, to), "edge-exists");
    }
}

#[test]
fn edit_frontmatter_add_relation_result_json_selects_the_drawn_edge() {
    // edited の欄は本文の操作と同じ。select は { kind: 'edge', edge: { kind, source, target } }
    let source = "---\nmarkdag:\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (3, "b"), (2, "a"));
    assert_eq!(
        keys(&result),
        ["notes", "rename", "select", "splices", "status"]
    );
    assert_eq!(keys(&result["select"]), ["edge", "kind"]);
    assert_eq!(
        keys(&result["select"]["edge"]),
        ["kind", "source", "target"]
    );
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - b --> a\n---\n# R\n- a\n- b\n",
        3,
        2,
    );

    // 断るときは reason だけ (原文を返さない)
    let refused = add_relation(source, (2, "a"), (2, "a"));
    assert_eq!(keys(&refused), ["reason", "status"]);
    assert_eq!(keys(&refused["reason"]), ["code", "message", "path"]);
}

#[test]
fn edit_frontmatter_add_relation_op_json_shape() {
    // 封筒の error (invalid-input) になるのは入力の JSON が読めないときだけ。読めない形は serde が受け付けない
    let ok = json!({
        "kind": "addRelation",
        "from": { "id": 2, "refText": "a" },
        "to": { "id": 3, "refText": "b" },
    });
    assert!(serde_json::from_value::<EditOp>(ok).is_ok());
    for bad in [
        json!({ "kind": "addRelation", "from": { "id": 2, "refText": "a" } }),
        json!({ "kind": "addRelation", "from": 2, "to": { "id": 3, "refText": "b" } }),
        json!({ "kind": "addRelation", "from": { "id": 2, "refText": "a" }, "to": { "id": 3 } }),
        json!({ "kind": "addRelation", "source": { "id": 2, "refText": "a" }, "target": { "id": 3, "refText": "b" } }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    assert!(serde_json::from_value::<NodeTarget>(json!({ "refText": "a" })).is_err());
}

// ---- 参照の書き方 ----

#[test]
fn edit_frontmatter_reference_uses_the_id_then_the_name_then_the_parent_path() {
    // (1) ノードが $id を持ち、文書でその $id が 1 つなら $id
    let source = "---\nmarkdag:\n---\n# R\n- a $x\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - $x --> b\n---\n# R\n- a $x\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &[]);

    // $id が重複していても、名前が文書で 1 つなら名前 ((1) で決まらず (2))
    let source = "---\nmarkdag:\n---\n# R\n- p $d\n- q $d\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "p"), (4, "b")),
        "---\nmarkdag:\n    relations:\n        depends:\n            - p --> b\n---\n# R\n- p $d\n- q $d\n- b\n",
        2,
        4,
    );

    // 名前が 2 つあり、親/名前 で 1 つに決まる (3)
    let source = "---\nmarkdag:\n---\n# R\n## A\n- x\n## B\n- x\n";
    let result = add_relation(source, (3, "x"), (5, "x"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n---\n# R\n## A\n- x\n## B\n- x\n",
        3,
        5,
    );
    assert_notes(&result, &[]);
}

#[test]
fn edit_frontmatter_reference_adds_the_smallest_free_n_number() {
    // (4) 名前でも 親/名前 でも決まらないノードは、1 行目の末尾に $n<番号> (使われていない最小の番号) を足してそれで指す (note id-added)
    let source = "---\nmarkdag:\n---\n# R\n## A\n- x\n- x\n## B\n- y\n";
    let result = add_relation(source, (4, "x"), (6, "y"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> y\n---\n# R\n## A\n- x\n- x $n1\n## B\n- y\n",
        4,
        6,
    );
    assert_notes(&result, &["id-added"]);

    // 終点の側でも同じ
    let result = add_relation(source, (6, "y"), (3, "x"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - y --> $n1\n---\n# R\n## A\n- x $n1\n- x\n## B\n- y\n",
        6,
        3,
    );
    assert_notes(&result, &["id-added"]);

    // 使われている $n1 と $n3 は飛ばして $n2。印のある行は、印の並びの末尾に空白 1 つで足す
    let source = "---\nmarkdag:\n---\n# R\n## A\n- x\n- x #k\n## B\n- y $n1\n- z $n3\n";
    let result = add_relation(source, (4, "x"), (7, "z"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - $n2 --> $n3\n---\n# R\n## A\n- x\n- x #k $n2\n## B\n- y $n1\n- z $n3\n",
        4,
        7,
    );
    assert_notes(&result, &["id-added"]);
}

#[test]
fn edit_frontmatter_reference_refuses_duplicated_ids_without_a_unique_name() {
    // $id が重複していて、名前でも 親/名前 でも決まらないノードは ambiguous-reference (2 つ目の $id は書けない)
    let source = "---\nmarkdag:\n---\n# R\n## A\n- x $d\n- x $d\n## B\n- y\n";
    assert_refused(
        &add_relation(source, (4, "x"), (6, "y")),
        "ambiguous-reference",
    );
    assert_refused(
        &add_relation(source, (6, "y"), (3, "x")),
        "ambiguous-reference",
    );
}

#[test]
fn edit_frontmatter_reference_refuses_n_on_nodes_without_a_line() {
    // 見出しのない文書の行を持たないルート (title がなく名前は空) と、ul と ol の容器 (名前は空) は、名前で決まらず
    // $n を書く 1 行目もないので no-source-line
    // 1 ルート / 2 ul / 3 a / 4 b / 5 ol / 6「1. c」/ 7「2. d」
    let source = "---\nmarkdag:\n---\n- a\n- b\n\n1. c\n2. d\n";
    assert_refused(
        &add_relation(source, (1, ""), (6, "1. c")),
        "no-source-line",
    );
    assert_refused(&add_relation(source, (3, "a"), (5, "")), "no-source-line");
    assert_refused(
        &add_relation(source, (2, ""), (7, "2. d")),
        "no-source-line",
    );
}

#[test]
fn edit_frontmatter_reference_rewrites_unmarkable_headings_to_write_n() {
    // 下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから $n を足して指す (D-046)
    // 1 R / 2 設計 (下線) / 3 画面 / 4 設計 (下線) / 5 API
    let source = "---\nmarkdag:\n---\n# R\n\n設計\n---\n\n- 画面\n\n設計\n---\n\n- API\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n";
    let result = add_relation(source, (2, "設計"), (5, "API"));
    assert_drawn(source, &result, expected, 2, 5);
    assert_notes(&result, &["id-added"]);
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> $n1\n---\n# R\n\n設計\n---\n\n- 画面\n\n## 設計 $n1\n\n- API\n";
    let result = add_relation(source, (3, "画面"), (4, "設計"));
    assert_drawn(source, &result, expected, 3, 4);
    assert_notes(&result, &["id-added"]);
    // 1 R / 2 実装 / 3 画面 / 4 実装 / 5 API
    let source = "---\nmarkdag:\n---\n# R\n\n ## 実装\n\n- 画面\n\n ## 実装\n\n- API\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 実装 $n1\n\n- 画面\n\n ## 実装\n\n- API\n";
    let result = add_relation(source, (2, "実装"), (5, "API"));
    assert_drawn(source, &result, expected, 2, 5);
    assert_notes(&result, &["id-added"]);
}

#[test]
fn edit_frontmatter_reference_names_a_lineless_root_by_a_unique_title() {
    // 行を持たないルートでも、名前 (title) が文書で 1 つなら名前で指せる ((2)。$n は要らない)
    let source = "---\ntitle: T\nmarkdag:\n---\n- a\n    - c\n\n1. b\n";
    assert_drawn(
        source,
        &add_relation(source, (1, "T"), (3, "c")),
        "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - T --> c\n---\n- a\n    - c\n\n1. b\n",
        1,
        3,
    );
}

// 本文 (1 R / 2〜8 記号を含む名前 / 9 b) と、escape_segment と同じ規則で逃がした参照
const SYMBOL_BODY: &str =
    "# R\n- A --> B\n- R & D\n- \"引用\"\n- #1 案\n- 注意: 重要\n- 入/出力\n- (仮) 案\n- b\n";
const SYMBOL_REFS: [(u32, &str, &str); 7] = [
    (2, "A --> B", r#""A --> B""#),
    (3, "R & D", r#""R & D""#),
    (4, "\"引用\"", r#""\"引用\"""#),
    (5, "#1 案", "#1 案"),
    (6, "注意: 重要", "注意: 重要"),
    (7, "入/出力", r"入\/出力"),
    (8, "(仮) 案", r"\(仮) 案"),
];

#[test]
fn edit_frontmatter_reference_reads_back_names_with_yaml_and_relation_symbols() {
    // `-->` と `&` と `"` を含む名前、`#` で始まる名前、`: ` を含む名前 (と / と先頭の ( を含む名前) の参照を書いた項目が、
    // YAML として読み直して「参照 --> 参照」の式になり、線が解決する。引用符の付け方は比べない
    let source = format!("---\nmarkdag:\n---\n{SYMBOL_BODY}");
    for (id, name, reference) in SYMBOL_REFS {
        for (from, to, expression) in [
            ((id, name), (9, "b"), format!("{reference} --> b")),
            ((9, "b"), (id, name), format!("b --> {reference}")),
        ] {
            let result = add_relation(&source, from, to);
            let after = applied(&source, &result);
            assert_eq!(depends_of(&after), json!([expression]), "{after:?}");
            assert_relation_resolves(&after, from.0, to.0);
            assert_selects_the_drawn_edge(&result, from.0, to.0);
            // 足すのは frontmatter の 3 行 (relations、depends、項目) だけで、本文は変わらない
            assert!(
                after
                    .starts_with("---\nmarkdag:\n    relations:\n        depends:\n            - "),
                "{after:?}"
            );
            assert!(
                after.ends_with(&format!("\n---\n{SYMBOL_BODY}")),
                "{after:?}"
            );
            assert_eq!(
                after.split('\n').count(),
                source.split('\n').count() + 3,
                "{after:?}"
            );
        }
    }
}

// ---- 数え方の原文 ----

#[test]
fn edit_frontmatter_add_relation_counts_names_read_differently_after_adding_markdag() {
    // markdag キーのない文書は markdag: を足したあとの原文で数えるので、「API #draft」は名前「API」(タグ draft) で指す。
    // 読み方が変わるノード (API と 画面。数字だけの #12 は印に読まれない) の数 2 を markdag-added の message に添える
    let source = "---\ntitle: T\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n";
    let result = add_relation(source, (2, "API #draft"), (3, "画面 %ui"));
    let expected = "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - API --> 画面\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n";
    assert_drawn(source, &result, expected, 2, 3);
    assert_notes(&result, &["markdag-added"]);
    assert!(
        note_message(&result, "markdag-added").contains('2'),
        "{result}"
    );
    let api = node_of(expected, 2);
    assert_eq!(
        (api.ref_text.as_str(), api.tags[0].key.as_str()),
        ("API", "draft")
    );
    assert_eq!(node_of(expected, 3).groups, ["ui"]);
    assert_eq!(node_of(expected, 4).ref_text, "Issue #12");

    // 足す前は「API #draft」と「API」で別の名前でも、足したあとは同じ名前になるので $n で指す
    let source = "---\ntitle: T\n---\n# R\n- API #draft\n- API\n- 画面\n";
    let result = add_relation(source, (2, "API #draft"), (4, "画面"));
    assert_drawn(
        source,
        &result,
        "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> 画面\n---\n# R\n- API #draft $n1\n- API\n- 画面\n",
        2,
        4,
    );
    assert_notes(&result, &["id-added", "markdag-added"]);

    // frontmatter のない文書も、足したあとの名前で指す
    let source = "# R\n- API #draft\n- 画面\n";
    let result = add_relation(source, (2, "API #draft"), (3, "画面"));
    assert_drawn(
        source,
        &result,
        "---\nmarkdag:\n    relations:\n        depends:\n            - API --> 画面\n---\n\n# R\n- API #draft\n- 画面\n",
        2,
        3,
    );
    assert_notes_include(&result, &["frontmatter-added"]);
}

// ---- BOM ----

#[test]
fn edit_frontmatter_add_relation_removes_a_leading_bom_to_create_frontmatter() {
    // frontmatter の開きは文書の先頭の --- でしか読まれないので、BOM を外して作る (note bom-removed)
    let source = "\u{feff}# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}\n# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes_include(&result, &["bom-removed", "frontmatter-added"]);
}

#[test]
fn edit_frontmatter_add_relation_removes_a_bom_right_before_a_fence() {
    // BOM のすぐあとが --- の行の文書 (BOM のせいで frontmatter が読まれていない) は、BOM を外してその frontmatter に書く。
    // markdag キーがなければ足す。note は bom-removed (D-068)
    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}# R\n- a\n- b\n"),
        2,
        3,
    );
    assert_notes(&result, &["bom-removed"]);
    let source = "\u{feff}---\ntitle: T\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &["bom-removed", "markdag-added"]);
}

// ---- 書き足せない frontmatter ----

#[test]
fn edit_frontmatter_add_relation_rewrites_flow_style_blocks() {
    // 足す先がフロー形式 ({ } と [ ]) なら、書く道すじを含むいちばん外のフロー形式のブロックを、中の値ごと字下げの形
    // (キーと - で 1 行ずつ。幅は frontmatter の最小の字下げ、なければ 4) に書き直してから足す (D-050)
    let body = "# R\n- a\n- b\n- c\n";
    let ab = "markdag:\n    relations:\n        depends:\n            - a --> b\n";
    for (frontmatter, from, to, written) in [
        ("markdag: {}\n", (2, "a"), (3, "b"), ab),
        ("markdag:\n    relations: {}\n", (2, "a"), (3, "b"), ab),
        (
            "markdag:\n    relations:\n        depends: []\n",
            (2, "a"),
            (3, "b"),
            ab,
        ),
        (
            "markdag:\n    relations:\n        depends: [a --> b]\n",
            (3, "b"),
            (4, "c"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n",
        ),
        (
            "markdag:\n    relations:\n        depends: [\n            a --> b,\n            b --> c,\n          ]\n",
            (2, "a"),
            (4, "c"),
            "markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n            - a --> c\n",
        ),
        // フロー形式の中のフロー形式は、いちばん外 (markdag の値) から書き直す
        (
            "markdag: { relations: { depends: [a --> c] } }\n",
            (2, "a"),
            (3, "b"),
            "markdag:\n    relations:\n        depends:\n            - a --> c\n            - a --> b\n",
        ),
        // frontmatter の全体がフロー形式 (markdag キーのあるもの)
        ("{markdag: {}}\n", (2, "a"), (3, "b"), ab),
    ] {
        let source = format!("---\n{frontmatter}---\n{body}");
        let result = add_relation(&source, from, to);
        assert_drawn(
            &source,
            &result,
            &format!("---\n{written}---\n{body}"),
            from.0,
            to.0,
        );
        assert_notes(&result, &[]);
    }
    // frontmatter の全体がフロー形式で markdag キーがない: title: T に書き直してから markdag: を足す
    let source = format!("---\n{{title: T}}\n---\n{body}");
    let result = add_relation(&source, (2, "a"), (3, "b"));
    assert_drawn(
        &source,
        &result,
        &format!("---\ntitle: T\n{ab}---\n{body}"),
        2,
        3,
    );
    assert_notes(&result, &["markdag-added"]);
}

#[test]
fn edit_frontmatter_add_relation_refuses_unreadable_frontmatter() {
    // YAML として読めない frontmatter (locator の syntax_errors が空でない) は frontmatter-invalid
    for source in [
        "---\nmarkdag:\n    relations: \"x\n---\n# R\n- a\n- b\n",
        "---\nmarkdag:\nmarkdag:\n---\n# R\n- a\n- b\n",
    ] {
        assert_refused(
            &add_relation(source, (2, "a"), (3, "b")),
            "frontmatter-invalid",
        );
    }
}

#[test]
fn edit_frontmatter_add_relation_refuses_values_that_are_not_maps() {
    // 道すじの途中が写像でない (スカラ、ブロックの一覧、別名) か、最上位が写像でない (一覧、文字列) なら frontmatter-not-map
    let body = "# R\n- a\n- b\n- c\n";
    for frontmatter in [
        "markdag: true\n",
        "markdag: 設定\n",
        "markdag:\n    relations: a --> b\n",
        "markdag:\n    relations:\n        - a --> b\n",
        "x: &a\n    edgeHighlight: true\nmarkdag: *a\n",
        "- a\n",
        "hello\n",
    ] {
        let source = format!("---\n{frontmatter}---\n{body}");
        assert_refused(
            &add_relation(&source, (3, "b"), (4, "c")),
            "frontmatter-not-map",
        );
    }
}

// ---- 字下げ、コメント、数字に見えるキー、CRLF ----

#[test]
fn edit_frontmatter_add_relation_follows_the_indent_width_of_the_frontmatter() {
    // 字下げが 2 の frontmatter: depends: は relations の子の字下げ (4)、項目は キーの字下げ + 2
    let source =
        "---\nmarkdag:\n  relations:\n    chain:\n      - a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (3, "b"), (4, "c")),
        "---\nmarkdag:\n  relations:\n    chain:\n      - a --> b\n    depends:\n      - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );

    // 字下げが 4 の frontmatter
    let source = "---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (3, "b"), (4, "c")),
        "---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n",
        3,
        4,
    );

    // 新しく作る階層は 親のキーの字下げ + 幅。幅は frontmatter の行の字下げのうち最小の正の値 (2)
    let source = "---\nmarkdag:\n  edgeHighlight: true\n---\n# R\n- a\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\nmarkdag:\n  edgeHighlight: true\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    // markdag: だけでも、ほかのキーの字下げ (2) を幅にする
    let source = "---\nfoo:\n  bar: 1\nmarkdag:\n---\n# R\n- a\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\nfoo:\n  bar: 1\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    // markdag キーがない frontmatter に作るときも同じ幅
    let source = "---\ntitle: T\nfoo:\n  bar: 1\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\ntitle: T\nfoo:\n  bar: 1\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &["markdag-added"]);

    // 一覧の項目は既存の項目の字下げにそろえる (キーと同じ桁の「- 」)
    let source = "---\nmarkdag:\n    relations:\n        depends:\n        - a --> b\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (4, "c")),
        "---\nmarkdag:\n    relations:\n        depends:\n        - a --> b\n        - a --> c\n---\n# R\n- a\n- b\n- c\n",
        2,
        4,
    );
}

#[test]
fn edit_frontmatter_add_relation_keeps_comment_lines() {
    // コメントは木に入らない。足す行は足す先の最後の値の行のすぐあとに入れ、そのあとのコメントの行は足した行のあとに残る。
    // 値のあとの ` #` のコメントも残る
    let source = "---\n# 先頭のコメント\nmarkdag:\n    # relations の前のコメント\n    relations:\n        depends:\n            - a --> b # 行末のコメント\n            # 項目のあとのコメント\n    # markdag の終わりのコメント\n---\n# R\n- a\n- b\n- c\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (4, "c")),
        "---\n# 先頭のコメント\nmarkdag:\n    # relations の前のコメント\n    relations:\n        depends:\n            - a --> b # 行末のコメント\n            - a --> c\n            # 項目のあとのコメント\n    # markdag の終わりのコメント\n---\n# R\n- a\n- b\n- c\n",
        2,
        4,
    );

    // markdag キーがない: 最上位の写像の最後の値のすぐあとに足し、コメントの行はそのあとに残る。字下げしたコメントは幅に数えない (幅は 4)
    let source = "---\ntitle: T\n  # 字下げしたコメント\n# 終わりのコメント\n---\n# R\n- a\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n  # 字下げしたコメント\n# 終わりのコメント\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
}

#[test]
fn edit_frontmatter_add_relation_into_maps_with_number_like_keys() {
    // 数字に見えるキー (2024) を持つ写像にも足せる (locator がキーを文字として突き合わせる)
    let source = "---\n2024: 年\n---\n# R\n- a\n- b\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        "---\n2024: 年\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
    assert_notes(&result, &["markdag-added"]);

    // markdag.groups.2024 の定義のあとに relations を足す (2024 の写像の最後の行を越えない)
    let source =
        "---\nmarkdag:\n    groups:\n        2024:\n            label: 年\n---\n# R\n- a\n- b\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\nmarkdag:\n    groups:\n        2024:\n            label: 年\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n",
        2,
        3,
    );
}

#[test]
fn edit_frontmatter_add_relation_keeps_crlf_in_the_frontmatter() {
    // CRLF の frontmatter: 足す行と書き直す行の末尾に \r を付け、ほかの行は変えない
    let source = "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (4, "c")),
        "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n            - a --> c\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n",
        2,
        4,
    );

    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n",
        2,
        3,
    );

    let source = "---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n- b\r\n";
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (3, "b")),
        "---\r\ntitle: T\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n",
        2,
        3,
    );

    // 式 1 つの値を 2 行に書き直す行も \r を持つ
    let source = "---\r\nmarkdag:\r\n    relations:\r\n        depends: a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n";
    assert_drawn(
        source,
        &add_relation(source, (3, "b"), (4, "c")),
        "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n            - b --> c\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n",
        3,
        4,
    );

    // $n を足す本文の行は、行末の \r の前に足す
    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n## A\r\n- x\r\n- x\r\n## B\r\n- y\r\n";
    assert_drawn(
        source,
        &add_relation(source, (4, "x"), (6, "y")),
        "---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - $n1 --> y\r\n---\r\n# R\r\n## A\r\n- x\r\n- x $n1\r\n## B\r\n- y\r\n",
        4,
        6,
    );
}

// ---- 古いノードと行の数え方 ----

#[test]
fn edit_frontmatter_add_relation_refuses_stale_targets() {
    // refText が違う NodeTarget と、その id のノードがない NodeTarget は stale-node
    let source = "---\nmarkdag:\n---\n# R\n- a\n- b\n";
    assert_refused(
        &add_relation_unchecked(source, (2, "x"), (3, "b")),
        "stale-node",
    );
    assert_refused(
        &add_relation_unchecked(source, (2, "a"), (99, "b")),
        "stale-node",
    );
    assert_refused(
        &add_relation_unchecked(source, (0, ""), (3, "b")),
        "stale-node",
    );
}

#[test]
fn edit_frontmatter_add_relation_rewrites_lone_carriage_returns() {
    // 単独の \r を含む文書は、解析と split('\n') で行の数え方が食い違うので、文書の最初の改行 (\n) にそろえてから足す (D-063)
    let source = "# R\n- a\n- b\r- c\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}\n# R\n- a\n- b\n- c\n"),
        2,
        3,
    );
    assert_notes_include(&result, &["frontmatter-added"]);
    let source = "---\nmarkdag:\n---\n# R\n- a\n- b\r- c\n";
    let result = add_relation(source, (2, "a"), (3, "b"));
    assert_drawn(
        source,
        &result,
        &format!("{CREATED_AB}# R\n- a\n- b\n- c\n"),
        2,
        3,
    );
    assert_notes(&result, &[]);
}

// ==== 合流と参照の追随 ====
// ノードの対応と EditNote、joinInto と joinIntoNew、addRelation の cycle、名前の変更の追随、参照の守り、削除の追随、合流の規則。
// 削除の追随の例は、依頼者が触って決めた比べの頁の 4 つの文書をそのまま使う。
// 期待の文書は、比べる前に解析し直して「ねらいの線がねらいの kind でモデルに出て、線と参照と YAML の診断がない」ことを確かめ、
// 指すノードは操作の前に原文の解析で id と refText を確かめる (線を引くテストと同じく、期待の書き誤りを実装の前の赤の確認で見分けるため)

// ---- 合流と参照の追随の入出力の補助 ----

const MARKDAG_ONLY: &str = "---\nmarkdag:\n---\n";
// 新しい合流先の仮の名前 (呼び出し側が label で渡す)
const JOINED: &str = "合流点";

fn edited_by(source: &str, value: Value) -> Value {
    normalized(
        serde_json::to_value(edit_source(source, &op(value)))
            .expect("EditSourceResult は JSON にできる"),
    )
}

fn target_json((id, ref_text): Target) -> Value {
    json!({ "id": id, "refText": ref_text })
}

// 指すノードを原文の解析で確かめてから JSON にする
fn checked_targets(source: &str, nodes: &[Target]) -> Vec<Value> {
    nodes
        .iter()
        .map(|&node| {
            assert_target(source, node);
            target_json(node)
        })
        .collect()
}

fn join_into(source: &str, sources: &[Target], target: Target) -> Value {
    let sources = checked_targets(source, sources);
    assert_target(source, target);
    edited_by(
        source,
        json!({ "kind": "joinInto", "sources": sources, "target": target_json(target) }),
    )
}

fn join_into_new(source: &str, sources: &[Target], label: &str) -> Value {
    let sources = checked_targets(source, sources);
    edited_by(
        source,
        json!({ "kind": "joinIntoNew", "sources": sources, "label": label }),
    )
}

fn rename_node(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "renameNode", "node": target_json(node), "label": label }),
    )
}

fn delete_nodes(source: &str, nodes: &[Target]) -> Value {
    let nodes = checked_targets(source, nodes);
    edited_by(source, json!({ "kind": "deleteNodes", "nodes": nodes }))
}

fn add_child(source: &str, parent: Target, label: &str) -> Value {
    assert_target(source, parent);
    edited_by(
        source,
        json!({ "kind": "addChild", "parent": target_json(parent), "label": label }),
    )
}

fn add_sibling(source: &str, node: Target, label: &str) -> Value {
    assert_target(source, node);
    edited_by(
        source,
        json!({ "kind": "addSibling", "node": target_json(node), "label": label }),
    )
}

fn move_node(source: &str, node: Target, parent: Target) -> Value {
    assert_target(source, node);
    assert_target(source, parent);
    edited_by(
        source,
        json!({ "kind": "moveNode", "node": target_json(node), "parent": target_json(parent) }),
    )
}

fn model_of(source: &str) -> markdag_core::types::GraphModel {
    let parsed = parse_document(source);
    build_model(
        &parsed.nodes,
        &parsed.frontmatter,
        Some(source),
        &ModelOptions::default(),
    )
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

fn has_edge(model: &markdag_core::types::GraphModel, (from, to, kind): Edge) -> bool {
    let kind = relation_kind(kind);
    model
        .relations
        .iter()
        .any(|relation| relation.source == from && relation.target == to && relation.kind == kind)
}

// 線と参照と YAML の診断に、式の形の違い、重なった線、自分への線、展開できない X/*、members の誤りを足したもの
fn is_broken_diagnostic(code: &str) -> bool {
    is_broken_relation_diagnostic(code)
        || matches!(
            code,
            "shape-mismatch" | "duplicate-edge" | "self-loop" | "selector-empty" | "group-invalid"
        )
}

fn broken_codes(model: &markdag_core::types::GraphModel) -> Vec<String> {
    model
        .diagnostics
        .iter()
        .filter(|diagnostic| is_broken_diagnostic(&diagnostic.code))
        .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
        .collect()
}

// 原文を解析し直したモデルの relations に、これらの線がその kind で出て、壊れた線と参照の診断がない
fn assert_edges(source: &str, edges: &[Edge]) {
    let model = model_of(source);
    for &edge in edges {
        assert!(
            has_edge(&model, edge),
            "{edge:?} の線がある: {source:?}: {:?}",
            model.relations
        );
    }
    let broken = broken_codes(&model);
    assert!(broken.is_empty(), "{source:?}: {broken:?}");
}

fn assert_no_edge(source: &str, from: u32, to: u32) {
    let model = model_of(source);
    assert!(
        !model
            .relations
            .iter()
            .any(|relation| relation.source == from && relation.target == to),
        "{from} --> {to} の線はない: {source:?}: {:?}",
        model.relations
    );
}

fn nodes_selected(chosen: Target) -> Value {
    normalized(json!({ "kind": "nodes", "nodes": [target_json(chosen)] }))
}

fn rename_of(chosen: Target) -> Value {
    normalized(json!({ "kind": "node", "node": target_json(chosen) }))
}

// 書き換えた結果: 原文の全体と、select が 1 つのノード (書き換えたあとの原文の id と refText)、
// rename がそのノードか null
fn assert_rewritten(source: &str, result: &Value, expected: &str, chosen: Target, rename: bool) {
    assert_target(expected, chosen);
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], nodes_selected(chosen), "{result}");
    let renamed = if rename {
        rename_of(chosen)
    } else {
        Value::Null
    };
    assert_eq!(result["rename"], renamed, "{result}");
}

fn note_count(result: &Value, code: &str) -> f64 {
    result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .find(|note| note["code"] == code)
        .and_then(|note| note["count"].as_f64())
        .unwrap_or_else(|| panic!("{code} の note がある: {result}"))
}

// 原文の markdag.relations.<kind> を YAML として読み直した値
fn relations_value_of(source: &str, kind: &str) -> Value {
    let frontmatter = serde_json::to_value(parse_document(source).frontmatter)
        .expect("frontmatter は JSON にできる");
    frontmatter["markdag"]["relations"][kind].clone()
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

// 本文の行から、行末の ` $n<番号>` を外したもの ($n の番号の振り方は比べない)
fn body_without_n_marks(text: &str) -> String {
    body_of(text)
        .split('\n')
        .map(|line| match line.rfind(" $n") {
            Some(at)
                if line.len() > at + 3
                    && line[at + 3..].chars().all(|char| char.is_ascii_digit()) =>
            {
                &line[..at]
            }
            _ => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- addRelation の cycle (引く線が閉路を作るなら断る) ----

// 1 R / 2 a / 3 a1 / 4 a2 / 5 b / 6 c。relations は a1 --> b と b --> c
const CYCLE_SOURCE: &str = "---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n";

#[test]
fn edit_frontmatter_add_relation_refuses_a_cycle() {
    // 閉路を作らない線は今までどおり引ける: 同じ向きの道がもうある線 (a1 → b → c があるときの a1 --> c) と、
    // 子でない子孫への線 (a --> a2)
    let source = CYCLE_SOURCE;
    assert_drawn(
        source,
        &add_relation(source, (3, "a1"), (6, "c")),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n            - a1 --> c\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n",
        3,
        6,
    );
    assert_drawn(
        source,
        &add_relation(source, (2, "a"), (4, "a2")),
        "---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n            - a --> a2\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n",
        2,
        4,
    );
    // 終点から始点へ届く線は cycle で断る: relations をたどって届く (c --> b、c --> a1)、木の親子をたどって届く
    // (子から親の a1 --> a、孫から祖父母の a2 --> a)、木の親子と relations の両方をたどって届く (b --> a。a → a1 → b)
    for (from, to) in [
        ((6, "c"), (5, "b")),
        ((6, "c"), (3, "a1")),
        ((3, "a1"), (2, "a")),
        ((4, "a2"), (2, "a")),
        ((5, "b"), (2, "a")),
    ] {
        assert_refused(&add_relation(source, from, to), "cycle");
    }
    // markdag キーのない文書と frontmatter のない文書でも、何も足さずに断る
    for source in [
        "---\ntitle: T\n---\n# R\n- a\n    - a1\n",
        "# R\n- a\n    - a1\n",
    ] {
        assert_refused(&add_relation(source, (3, "a1"), (2, "a")), "cycle");
    }
}

// ---- 既存のノードへの合流 (joinInto) ----

// 1 R / 2 設計 / 3 実装 / 4 テスト / 5 リリース
const JOIN_BODY: &str = "# R\n- 設計\n- 実装\n- テスト\n- リリース\n";

#[test]
fn edit_frontmatter_join_into_writes_one_join_item() {
    // 始点が 2 つ以上なら join に「始点 & 始点 --> 合流先」を 1 行足し、合流先を選ぶ (名前の入力は開かない)。
    // 外した始点がなければ notes は空
    let source = format!("{MARKDAG_ONLY}{JOIN_BODY}");
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 設計 & 実装 & テスト --> リリース\n---\n{JOIN_BODY}"
    );
    assert_edges(&expected, &[(2, 5, "join"), (3, 5, "join"), (4, 5, "join")]);
    let result = join_into(
        &source,
        &[(2, "設計"), (3, "実装"), (4, "テスト")],
        (5, "リリース"),
    );
    assert_rewritten(&source, &result, &expected, (5, "リリース"), false);
    assert_notes(&result, &[]);

    // 既存の join の一覧の最後の項目のすぐあとに足す (あとに続く depends のキーの並びは変えない)
    // 1 R / 2 企画 / 3 設計 / 4 実装 / 5 テスト / 6 リリース
    let body = "# R\n- 企画\n- 設計\n- 実装\n- テスト\n- リリース\n";
    let source = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 企画 & 設計 --> 実装\n        depends:\n            - 企画 --> 設計\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 企画 & 設計 --> 実装\n            - 実装 & テスト --> リリース\n        depends:\n            - 企画 --> 設計\n---\n{body}"
    );
    assert_edges(
        &expected,
        &[
            (2, 4, "join"),
            (3, 4, "join"),
            (2, 3, "depends"),
            (4, 6, "join"),
            (5, 6, "join"),
        ],
    );
    let result = join_into(&source, &[(4, "実装"), (5, "テスト")], (6, "リリース"));
    assert_rewritten(&source, &result, &expected, (6, "リリース"), false);
    assert_notes(&result, &[]);

    // 同じ名前の始点は 親/名前 で指す。1 R / 2 A / 3 画面 / 4 B / 5 画面 / 6 C / 7 公開
    let body = "# R\n## A\n- 画面\n## B\n- 画面\n## C\n- 公開\n";
    let source = format!("{MARKDAG_ONLY}{body}");
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - A/画面 & B/画面 --> 公開\n---\n{body}"
    );
    assert_edges(&expected, &[(3, 7, "join"), (5, 7, "join")]);
    let result = join_into(&source, &[(3, "画面"), (5, "画面")], (7, "公開"));
    assert_rewritten(&source, &result, &expected, (7, "公開"), false);
    assert_notes(&result, &[]);
}

#[test]
fn edit_frontmatter_join_into_skips_sources_with_an_edge_to_the_target() {
    // 合流先へもう線がある始点 (depends、join、fork が展開した線) は外し、外した数を sources-existing に出す。
    // 残りが 1 つなら depends に「始点 --> 合流先」を書く (depends がなければ relations の末尾に作る)
    for (relations, sources, written, remaining) in [
        (
            "        depends:\n            - 設計 --> リリース\n",
            [(2, "設計"), (3, "実装")],
            "        depends:\n            - 設計 --> リリース\n            - 実装 --> リリース\n",
            3,
        ),
        (
            "        join:\n            - 設計 & 実装 --> リリース\n",
            [(3, "実装"), (4, "テスト")],
            "        join:\n            - 設計 & 実装 --> リリース\n        depends:\n            - テスト --> リリース\n",
            4,
        ),
        (
            "        fork:\n            - 設計 --> 実装 & リリース\n",
            [(2, "設計"), (4, "テスト")],
            "        fork:\n            - 設計 --> 実装 & リリース\n        depends:\n            - テスト --> リリース\n",
            4,
        ),
    ] {
        let source = format!("---\nmarkdag:\n    relations:\n{relations}---\n{JOIN_BODY}");
        let expected = format!("---\nmarkdag:\n    relations:\n{written}---\n{JOIN_BODY}");
        assert_edges(&expected, &[(remaining, 5, "depends")]);
        let result = join_into(&source, &sources, (5, "リリース"));
        assert_rewritten(&source, &result, &expected, (5, "リリース"), false);
        assert_notes(&result, &["sources-existing"]);
        assert_eq!(note_count(&result, "sources-existing"), 1.0, "{result}");
    }

    // 木の親から子への線もある線として外す (図にもう線があり、書けば duplicate-edge になる)。1 R / 2 設計 / 3 画面 / 4 実装
    let body = "# R\n- 設計\n    - 画面\n- 実装\n";
    let source = format!("{MARKDAG_ONLY}{body}");
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> 画面\n---\n{body}"
    );
    assert_edges(&expected, &[(4, 3, "depends")]);
    let result = join_into(&source, &[(2, "設計"), (4, "実装")], (3, "画面"));
    assert_rewritten(&source, &result, &expected, (3, "画面"), false);
    assert_notes(&result, &["sources-existing"]);

    // 循環になる始点と線のある始点を両方外し、残りが 2 つなら join に書く。数は分けて出す
    // 1 R / 2 設計 / 3 実装 / 4 テスト / 5 リリース / 6 告知 (リリースの子なので 告知 --> リリース は循環になる)
    let body = "# R\n- 設計\n- 実装\n- テスト\n- リリース\n    - 告知\n";
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> リリース\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> リリース\n        join:\n            - 実装 & テスト --> リリース\n---\n{body}"
    );
    assert_edges(
        &expected,
        &[(2, 5, "depends"), (3, 5, "join"), (4, 5, "join")],
    );
    let result = join_into(
        &source,
        &[(2, "設計"), (3, "実装"), (4, "テスト"), (6, "告知")],
        (5, "リリース"),
    );
    assert_rewritten(&source, &result, &expected, (5, "リリース"), false);
    assert_notes(&result, &["sources-cycle", "sources-existing"]);
    assert_eq!(note_count(&result, "sources-cycle"), 1.0, "{result}");
    assert_eq!(note_count(&result, "sources-existing"), 1.0, "{result}");
}

// 1 R / 2 設計 / 3 画面 (設計の子) / 4 実装 / 5 テスト / 6 リリース
const REACH_BODY: &str = "# R\n- 設計\n    - 画面\n- 実装\n- テスト\n- リリース\n";

#[test]
fn edit_frontmatter_join_into_skips_sources_the_target_reaches() {
    // 合流先から木の親子と relations をたどって届く始点 (線を引くと循環になる) を外し、数を sources-cycle に出す
    // 木の親子で届く (設計 → 画面)
    let source = format!("{MARKDAG_ONLY}{REACH_BODY}");
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 実装 & テスト --> 設計\n---\n{REACH_BODY}"
    );
    assert_edges(&expected, &[(4, 2, "join"), (5, 2, "join")]);
    let result = join_into(
        &source,
        &[(3, "画面"), (4, "実装"), (5, "テスト")],
        (2, "設計"),
    );
    assert_rewritten(&source, &result, &expected, (2, "設計"), false);
    assert_notes(&result, &["sources-cycle"]);
    assert_eq!(note_count(&result, "sources-cycle"), 1.0, "{result}");

    // relations を 2 本たどって届く (リリース → 実装 → テスト)。残りの 1 つは depends の末尾に足す
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - リリース --> 実装\n            - 実装 --> テスト\n---\n{REACH_BODY}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - リリース --> 実装\n            - 実装 --> テスト\n            - 画面 --> リリース\n---\n{REACH_BODY}"
    );
    assert_edges(
        &expected,
        &[(6, 4, "depends"), (4, 5, "depends"), (3, 6, "depends")],
    );
    let result = join_into(&source, &[(3, "画面"), (5, "テスト")], (6, "リリース"));
    assert_rewritten(&source, &result, &expected, (6, "リリース"), false);
    assert_notes(&result, &["sources-cycle"]);

    // 木の親子と relations の両方をたどって届く (設計 → 画面 は木、画面 → テスト は relations)
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> テスト\n---\n{REACH_BODY}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> テスト\n            - 実装 --> 設計\n---\n{REACH_BODY}"
    );
    assert_edges(&expected, &[(3, 5, "depends"), (4, 2, "depends")]);
    let result = join_into(&source, &[(4, "実装"), (5, "テスト")], (2, "設計"));
    assert_rewritten(&source, &result, &expected, (2, "設計"), false);
    assert_notes(&result, &["sources-cycle"]);
}

#[test]
fn edit_frontmatter_join_into_refuses_when_all_sources_are_skipped() {
    // 全部の始点が外れたら all-sources-skipped で断り、原文を変えない
    // どの始点にも合流先への線がある
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> リリース\n            - テスト --> リリース\n---\n{REACH_BODY}"
    );
    assert_refused(
        &join_into(&source, &[(4, "実装"), (5, "テスト")], (6, "リリース")),
        "all-sources-skipped",
    );
    // 循環になる始点 (画面) と線のある始点 (実装)
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> 設計\n---\n{REACH_BODY}"
    );
    assert_refused(
        &join_into(&source, &[(3, "画面"), (4, "実装")], (2, "設計")),
        "all-sources-skipped",
    );
    // frontmatter のない文書でも何も作らずに断る (子から親へは循環)。1 R / 2 設計 / 3 画面 / 4 API
    let source = "# R\n- 設計\n    - 画面\n    - API\n";
    assert_refused(
        &join_into(source, &[(3, "画面"), (4, "API")], (2, "設計")),
        "all-sources-skipped",
    );
}

// ---- 新しい合流先への合流 (joinIntoNew) ----

// 1 R / 2 a / 3 a1 / 4 b / 5 c
const JOIN_NEW_BODY: &str = "# R\n- a\n    - a1\n- b\n- c\n";

#[test]
fn edit_frontmatter_join_into_new_adds_a_top_level_sibling_after_the_last_source() {
    // 新しい合流先は、始点のうち文書でいちばん後ろのものを含む最上位の枝のブロックのすぐあとに、最上位の兄弟として足す。
    // join に「始点 & 始点 --> 合流先」を書き、select と rename が新しいノード
    let source = format!("{MARKDAG_ONLY}{JOIN_NEW_BODY}");
    // いちばん後ろの始点 b は最上位の枝そのもの: b のすぐあと
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - a1 & b --> 合流点\n---\n# R\n- a\n    - a1\n- b\n- 合流点\n- c\n";
    assert_edges(expected, &[(3, 5, "join"), (4, 5, "join")]);
    let result = join_into_new(&source, &[(3, "a1"), (4, "b")], JOINED);
    assert_rewritten(&source, &result, expected, (5, JOINED), true);
    assert_notes(&result, &[]);

    // いちばん後ろの始点 a1 は枝 a の中: a のブロック (入れ子の a1 を含む) のすぐあと
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - a & a1 --> 合流点\n---\n# R\n- a\n    - a1\n- 合流点\n- b\n- c\n";
    assert_edges(expected, &[(2, 4, "join"), (3, 4, "join")]);
    let result = join_into_new(&source, &[(2, "a"), (3, "a1")], JOINED);
    assert_rewritten(&source, &result, expected, (4, JOINED), true);
    assert_notes(&result, &[]);
}

// 1 R / 2 設計 / 3 画面 / 4 API / 5 実装 / 6 DB / 7 移行 / 8 テスト
const JOIN_NEW_HEADINGS: &str =
    "# R\n## 設計\n- 画面\n- API\n## 実装\n- DB\n    - 移行\n## テスト\n";

#[test]
fn edit_frontmatter_join_into_new_places_the_node_by_document_order() {
    // 渡した順でなく文書の順でいちばん後ろの始点 (移行) を含む最上位の枝 (実装) のあとに、同じ形 (## の見出し) で足す。
    // 見出しを足すときは前後に空行をはさむ。join の項目の始点の並びは比べない
    let source = format!("{MARKDAG_ONLY}{JOIN_NEW_HEADINGS}");
    let result = join_into_new(&source, &[(7, "移行"), (3, "画面")], JOINED);
    let after = applied(&source, &result);
    assert_eq!(
        body_of(&after),
        "# R\n## 設計\n- 画面\n- API\n## 実装\n- DB\n    - 移行\n\n## 合流点\n\n## テスト\n",
        "{result}"
    );
    let items = relations_value_of(&after, "join");
    assert!(
        items == json!(["画面 & 移行 --> 合流点"]) || items == json!(["移行 & 画面 --> 合流点"]),
        "{after:?}"
    );
    assert_edges(&after, &[(3, 8, "join"), (7, 8, "join")]);
    assert_eq!(result["select"], nodes_selected((8, JOINED)), "{result}");
    assert_eq!(result["rename"], rename_of((8, JOINED)), "{result}");
    assert_notes(&result, &[]);
}

#[test]
fn edit_frontmatter_join_into_new_refuses_too_few_sources() {
    // 始点が 2 つ未満なら too-few-sources で断る
    let source = format!("{MARKDAG_ONLY}{JOIN_NEW_BODY}");
    assert_refused(
        &join_into_new(&source, &[(4, "b")], JOINED),
        "too-few-sources",
    );
    assert_refused(&join_into_new(&source, &[], JOINED), "too-few-sources");
}

#[test]
fn edit_frontmatter_join_into_new_creates_frontmatter_when_there_is_none() {
    // frontmatter のない文書は frontmatter、markdag、relations、join を作ってから書く
    let source = "# R\n- a\n- b\n";
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - a & b --> 合流点\n---\n\n# R\n- a\n- b\n- 合流点\n";
    assert_edges(expected, &[(2, 4, "join"), (3, 4, "join")]);
    let result = join_into_new(source, &[(2, "a"), (3, "b")], JOINED);
    assert_rewritten(source, &result, expected, (4, JOINED), true);
    assert_notes_include(&result, &["frontmatter-added"]);
}

#[test]
fn edit_frontmatter_join_into_new_twice_keeps_the_first_join_resolvable() {
    // 合流を 2 回続けて「合流点」が 2 つになっても、前の join は前の合流点を指したまま解決できる (参照の守り)
    // 1 R / 2 a / 3 b / 4 c / 5 d
    let source = format!("{MARKDAG_ONLY}# R\n- a\n- b\n- c\n- d\n");
    let first = "---\nmarkdag:\n    relations:\n        join:\n            - a & b --> 合流点\n---\n# R\n- a\n- b\n- 合流点\n- c\n- d\n";
    assert_edges(first, &[(2, 4, "join"), (3, 4, "join")]);
    let result = join_into_new(&source, &[(2, "a"), (3, "b")], JOINED);
    assert_rewritten(&source, &result, first, (4, JOINED), true);

    // 2 回目: 1 R / 2 a / 3 b / 4 合流点 / 5 c / 6 d に、7 の合流点を足す。合流点 も R/合流点 も 2 つに当たるので、
    // 前の合流点は $n で指すように書き直す ($n の番号の振り方は比べない)
    let result = join_into_new(first, &[(5, "c"), (6, "d")], JOINED);
    let after = applied(first, &result);
    assert_eq!(
        body_without_n_marks(&after),
        "# R\n- a\n- b\n- 合流点\n- c\n- d\n- 合流点\n",
        "{after:?}"
    );
    assert_edges(
        &after,
        &[
            (2, 4, "join"),
            (3, 4, "join"),
            (5, 7, "join"),
            (6, 7, "join"),
        ],
    );
    assert_eq!(
        relations_value_of(&after, "join").as_array().map(Vec::len),
        Some(2),
        "{after:?}"
    );
    assert_eq!(result["select"], nodes_selected((7, JOINED)), "{result}");
    assert_eq!(result["rename"], rename_of((7, JOINED)), "{result}");
    assert_notes_include(&result, &["refs-rewritten", "id-added"]);
}

#[test]
fn edit_frontmatter_join_op_json_shape() {
    // joinInto と joinIntoNew の EditOp の JSON。読めない形は serde が受け付けない (いまも通る)
    for ok in [
        json!({ "kind": "joinInto", "sources": [{ "id": 2, "refText": "a" }, { "id": 3, "refText": "b" }], "target": { "id": 4, "refText": "c" } }),
        json!({ "kind": "joinIntoNew", "sources": [{ "id": 2, "refText": "a" }, { "id": 3, "refText": "b" }], "label": "合流点" }),
    ] {
        assert!(serde_json::from_value::<EditOp>(ok.clone()).is_ok(), "{ok}");
    }
    for bad in [
        json!({ "kind": "joinInto", "sources": [{ "id": 2, "refText": "a" }] }),
        json!({ "kind": "joinInto", "sources": { "id": 2, "refText": "a" }, "target": { "id": 4, "refText": "c" } }),
        json!({ "kind": "joinIntoNew", "sources": [{ "id": 2, "refText": "a" }] }),
        json!({ "kind": "joinIntoNew", "sources": [{ "id": 2 }], "label": "合流点" }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

// ---- 名前の変更の追随 ----

// 1 R / 2 設計 / 3 API / 4 画面 / 5 結合 / 6 公開 / 7 運用 / 8 保守 / 9 監視
const RENAME_BODY: &str =
    "# R\n- 設計\n    - API\n- 画面\n- 結合\n- 公開\n- 運用\n- 保守\n- 監視\n";

// API を指す relations (4 つの kind)、branches、members。join と fork は 親/名前 で指す
fn rename_frontmatter(api: &str) -> String {
    format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - {api} --> 公開\n        chain:\n            - 画面 --> {api} --> 結合\n        join:\n            - 画面 & 設計/{api} --> 運用\n        fork:\n            - 設計/{api} --> 保守 & 監視\n    branches:\n        - {api}\n    groups:\n        back:\n            members:\n                - {api}\n---\n"
    )
}

#[test]
fn edit_frontmatter_rename_follows_relations_branches_and_members() {
    // 名前を変えたノードを指す relations (depends、chain、join、fork)、branches、groups の members の参照が新しい名前を追う。
    // 親/名前 は名前を変えたノードに解決した最後の区間を書き直し、祖先の区間 (設計) は残す
    let edges = [
        (3, 6, "depends"),
        (4, 3, "chain"),
        (3, 5, "chain"),
        (4, 7, "join"),
        (3, 7, "join"),
        (3, 8, "fork"),
        (3, 9, "fork"),
    ];
    let source = format!("{}{RENAME_BODY}", rename_frontmatter("API"));
    assert_edges(&source, &edges);
    let expected = format!(
        "{}{}",
        rename_frontmatter("API サーバー"),
        RENAME_BODY.replace("    - API\n", "    - API サーバー\n")
    );
    assert_edges(&expected, &edges);
    let model = model_of(&expected);
    assert_eq!(model.branches, [3], "{expected:?}");
    assert!(
        model
            .groups_of
            .get(&3)
            .is_some_and(|groups| groups.iter().any(|group| group == "back")),
        "{expected:?}"
    );
    let result = rename_node(&source, (3, "API"), "API サーバー");
    assert_rewritten(&source, &result, &expected, (3, "API サーバー"), false);
}

#[test]
fn edit_frontmatter_rename_follows_ancestor_segments_and_leaf_selectors() {
    // 親/名前 の祖先の区間 (設計/API の 設計) と X/* の X も、名前を変えたノードに一致した区間として追う
    // 1 R / 2 設計 / 3 画面 / 4 API / 5 結合 / 6 公開
    let body = "# R\n- 設計\n    - 画面\n    - API\n- 結合\n- 公開\n";
    let source = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 設計/* --> 公開\n        depends:\n            - 設計/API --> 結合\n    branches:\n        - 設計\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        join:\n            - 基本設計/* --> 公開\n        depends:\n            - 基本設計/API --> 結合\n    branches:\n        - 基本設計\n---\n{}",
        body.replace("- 設計\n", "- 基本設計\n")
    );
    let edges = [(3, 6, "join"), (4, 6, "join"), (4, 5, "depends")];
    assert_edges(&source, &edges);
    assert_edges(&expected, &edges);
    assert_eq!(model_of(&expected).branches, [2], "{expected:?}");
    let result = rename_node(&source, (2, "設計"), "基本設計");
    assert_rewritten(&source, &result, &expected, (2, "基本設計"), false);
}

#[test]
fn edit_frontmatter_rename_follows_single_expressions_and_symbol_names() {
    // 式 1 つのスカラ (depends: API --> 公開) は 1 項目の一覧として扱い、書き直すときは 2 行の形にする
    let source =
        "---\nmarkdag:\n    relations:\n        depends: API --> 公開\n---\n# R\n- API\n- 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - API サーバー --> 公開\n---\n# R\n- API サーバー\n- 公開\n";
    assert_edges(expected, &[(2, 3, "depends")]);
    let result = rename_node(source, (2, "API"), "API サーバー");
    assert_rewritten(source, &result, expected, (2, "API サーバー"), false);

    // 新しい名前が --> を含むなら、参照は escape_segment の書き方 ("…" で囲む) で、YAML の値の書き方で書く。
    // 引用符の付け方は比べず、YAML として読み直した式を比べる
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n---\n# R\n- API\n- 公開\n";
    let result = rename_node(source, (2, "API"), "A --> B");
    let after = applied(source, &result);
    assert_eq!(body_of(&after), "# R\n- A --> B\n- 公開\n", "{after:?}");
    assert_eq!(
        depends_of(&after),
        json!([r#""A --> B" --> 公開"#]),
        "{after:?}"
    );
    assert_edges(&after, &[(2, 3, "depends")]);
}

#[test]
fn edit_frontmatter_rename_follows_a_parent_path_among_same_names() {
    // 同じ名前のノードが 2 つある文書で、親/名前 で指したノードの名前を変えても参照が追い、ref-not-found にならない。
    // 書き換える前に解決できなかった参照 (2 つに当たる x と、ない名前) は変えない
    // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 z
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n            - x --> z\n            - 存在しない --> z\n---\n# R\n## A\n- x\n## B\n- x\n## C\n- z\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/y\n            - x --> z\n            - 存在しない --> z\n---\n# R\n## A\n- x\n## B\n- y\n## C\n- z\n";
    let model = model_of(expected);
    for edge in [(3, 5, "depends"), (3, 7, "depends")] {
        assert!(
            has_edge(&model, edge),
            "{edge:?}: {expected:?}: {:?}",
            model.relations
        );
    }
    let codes: Vec<&str> = model
        .diagnostics
        .iter()
        .filter(|diagnostic| is_broken_diagnostic(&diagnostic.code))
        .map(|diagnostic| diagnostic.code.as_str())
        .collect();
    assert_eq!(codes, ["ref-not-found"], "{expected:?}");
    let result = rename_node(source, (5, "x"), "y");
    assert_rewritten(source, &result, expected, (5, "y"), false);
}

#[test]
fn edit_frontmatter_rename_rewrites_flow_style_references() {
    // 追う参照がフロー形式のブロックにあれば、そのブロックを字下げの形に書き直してから追う (細部 21。D-053)
    let body = "# R\n- API\n- 公開\n";
    let renamed_body = "# R\n- API サーバー\n- 公開\n";
    for (frontmatter, written) in [
        (
            "markdag:\n    relations:\n        depends: [API --> 公開]\n",
            "markdag:\n    relations:\n        depends:\n            - API サーバー --> 公開\n",
        ),
        (
            "markdag:\n    branches: [API]\n",
            "markdag:\n    branches:\n        - API サーバー\n",
        ),
    ] {
        let source = format!("---\n{frontmatter}---\n{body}");
        let expected = format!("---\n{written}---\n{renamed_body}");
        let result = rename_node(&source, (2, "API"), "API サーバー");
        assert_rewritten(&source, &result, &expected, (2, "API サーバー"), false);
        assert_notes(&result, &[]);
    }
}

// ---- 参照の守り ----

#[test]
fn edit_frontmatter_guard_rename_to_an_existing_name() {
    // 名前の変更で既存の名前と同じにしても、その名前を指していた参照は前のノードを指すように書き直る (note refs-rewritten)
    // 1 R / 2 A / 3 設計 / 4 B / 5 実装 / 6 C / 7 公開。設計 が 2 つになるので 親/名前 で書く
    let body = "# R\n## A\n- 設計\n## B\n- 実装\n## C\n- 公開\n";
    let renamed_body = "# R\n## A\n- 設計\n## B\n- 設計\n## C\n- 公開\n";
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - A/設計 --> 公開\n---\n{renamed_body}"
    );
    assert_edges(&expected, &[(3, 7, "depends")]);
    let result = rename_node(&source, (5, "実装"), "設計");
    assert_rewritten(&source, &result, &expected, (5, "設計"), false);
    assert_notes(&result, &["refs-rewritten"]);
    assert_eq!(note_count(&result, "refs-rewritten"), 1.0, "{result}");

    // 名前を変えるノードを指す参照 (追随) と、前の名前を指す参照 (守り) が、どちらも 親/名前 になる
    let source = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n            - 実装 --> 公開\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        depends:\n            - A/設計 --> 公開\n            - B/設計 --> 公開\n---\n{renamed_body}"
    );
    assert_edges(&expected, &[(3, 7, "depends"), (5, 7, "depends")]);
    let result = rename_node(&source, (5, "実装"), "設計");
    assert_rewritten(&source, &result, &expected, (5, "設計"), false);
    assert_notes_include(&result, &["refs-rewritten"]);

    // 親/名前 でも決まらなければ、前のノードの 1 行目に $n を足して指す (id-added)。1 R / 2 設計 / 3 実装 / 4 公開
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n---\n# R\n- 設計\n- 実装\n- 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> 公開\n---\n# R\n- 設計 $n1\n- 設計\n- 公開\n";
    assert_edges(expected, &[(2, 4, "depends")]);
    let result = rename_node(source, (3, "実装"), "設計");
    assert_rewritten(source, &result, expected, (3, "設計"), false);
    assert_notes(&result, &["id-added", "refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_numbered_list_sibling() {
    // 番号付きのリストの先頭に兄弟を足すと後ろの項目の名前 (頭の番号) が変わるので、名前で指す参照を新しい番号に書き直す
    // 1 R / 2 手順 / 3「1. 準備」/ 4「2. 確認」/ 5 公開 → 足したあと 4「2. 新しいノード」/ 5「3. 確認」/ 6 公開
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 2. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 確認\n## 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 新しいノード\n2. 確認\n## 公開\n";
    assert_edges(source, &[(4, 5, "depends")]);
    assert_edges(expected, &[(5, 6, "depends")]);
    let result = add_sibling(source, (3, "1. 準備"), "新しいノード");
    assert_rewritten(source, &result, expected, (4, "2. 新しいノード"), true);
    assert_notes(&result, &["refs-rewritten"]);
    assert_eq!(note_count(&result, "refs-rewritten"), 1.0, "{result}");

    // 同じ名前の項目がある文書: 書き直さないと「2. 確認」が足した項目を指し、線が別のノードへ付け替わる
    // 1 R / 2 手順 / 3「1. 確認」/ 4「2. 確認」/ 5 公開 → 足したあと 4「2. 確認」(足した項目) / 5「3. 確認」/ 6 公開
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 2. 確認 --> 公開\n---\n# R\n## 手順\n1. 確認\n2. 確認\n## 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 確認\n2. 確認\n2. 確認\n## 公開\n";
    assert_edges(source, &[(4, 5, "depends")]);
    assert_edges(expected, &[(5, 6, "depends")]);
    assert_no_edge(expected, 4, 6);
    let result = add_sibling(source, (3, "1. 確認"), "確認");
    assert_rewritten(source, &result, expected, (4, "2. 確認"), true);
    assert_notes(&result, &["refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_numbered_list_delete() {
    // 番号付きのリストの途中の項目を消すと後ろの項目の名前が変わるので、消したノードを指していない参照を書き直す
    // 1 R / 2 手順 / 3「1. 準備」/ 4「2. 確認」/ 5「3. 公開」/ 6 まとめ → 消したあと 4「2. 公開」/ 5 まとめ
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 3. 公開 --> まとめ\n---\n# R\n## 手順\n1. 準備\n2. 確認\n3. 公開\n## まとめ\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 2. 公開 --> まとめ\n---\n# R\n## 手順\n1. 準備\n3. 公開\n## まとめ\n";
    assert_edges(source, &[(5, 6, "depends")]);
    assert_edges(expected, &[(4, 5, "depends")]);
    let result = delete_nodes(source, &[(4, "2. 確認")]);
    assert_rewritten(source, &result, expected, (2, "手順"), false);
    assert_notes(&result, &["refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_move_rewrites_parent_paths() {
    // 親/名前 で指したノードを付け替えると祖先が変わって指せなくなるので、新しい場所での書き方に書き直す
    // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 y → 付け替えたあと 1 R / 2 A / 3 B / 4 x / 5 C / 6 y / 7 x
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n---\n# R\n## A\n- x\n## B\n- x\n## C\n- y\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - C/x --> B/x\n---\n# R\n## A\n## B\n- x\n## C\n- y\n- x\n";
    assert_edges(source, &[(3, 5, "depends")]);
    assert_edges(expected, &[(7, 4, "depends")]);
    let result = move_node(source, (3, "x"), (6, "C"));
    assert_rewritten(source, &result, expected, (7, "x"), false);
    assert_notes(&result, &["refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_add_child_with_a_name_already_used() {
    // 名前の重なるノードを足すと名前の参照が ref-ambiguous になるので、前のノードを 親/名前 で指すように書き直す
    // 1 R / 2 設計 / 3 API / 4 実装 / 5 公開 → 足したあと 5 API (実装の子) / 6 公開
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n---\n# R\n- 設計\n    - API\n- 実装\n- 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 設計/API --> 公開\n---\n# R\n- 設計\n    - API\n- 実装\n    - API\n- 公開\n";
    assert_edges(expected, &[(3, 6, "depends")]);
    let result = add_child(source, (4, "実装"), "API");
    assert_rewritten(source, &result, expected, (5, "API"), true);
    assert_notes(&result, &["refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_rewrites_flow_style() {
    // 守りで書き直す参照がフロー形式のブロックにあれば、そのブロックを字下げの形に書き直してから書き直す (細部 21。D-053)
    let source = "---\nmarkdag:\n    relations:\n        depends: [2. 確認 --> 公開]\n---\n# R\n## 手順\n1. 準備\n2. 確認\n## 公開\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 新しいノード\n2. 確認\n## 公開\n";
    assert_edges(expected, &[(5, 6, "depends")]);
    let result = add_sibling(source, (3, "1. 準備"), "新しいノード");
    assert_rewritten(source, &result, expected, (4, "2. 新しいノード"), true);
    assert_notes(&result, &["refs-rewritten"]);
}

#[test]
fn edit_frontmatter_guard_rewrites_setext_headings_to_write_n_and_refuses_lineless_roots() {
    // 守りの書き直しに $n が要るとき、下線の見出しは同じ段の ATX の見出しに書き直してから $n を足す (D-046)。
    // 1 R / 2 設計 (下線) / 3 画面 / 4 実装 (下線) / 5 API。実装 を 設計 にすると 設計 も R/設計 も 2 つに当たる。
    // 名前を変えた 4 は下線の見出しのまま (名前の変更は下線の形を残す)
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> API\n---\n# R\n\n設計\n---\n\n- 画面\n\n実装\n---\n\n- API\n";
    assert_edges(source, &[(2, 5, "depends")]);
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n";
    assert_edges(expected, &[(2, 5, "depends")]);
    let result = rename_node(source, (4, "実装"), "設計");
    assert_rewritten(source, &result, expected, (4, "設計"), false);
    assert_notes(&result, &["id-added", "refs-rewritten"]);
    // 行を持たないルート (title の T) は no-source-line。1 T / 2 a / 3 c。T という子を足すと T が 2 つに当たり、ルートには親もない
    let source = "---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - T --> c\n---\n- a\n    - c\n\n1. b\n";
    assert_edges(source, &[(1, 3, "depends")]);
    assert_refused(&add_child(source, (2, "a"), "T"), "no-source-line");
}

// ---- 削除の追随 ----

// 削除の追随で直した relations の項目 1 つの通知: message は「kind「直す前の項目」」で始まり、
// 同じ kind に残した項目を「」で囲んで含み、phrases の句 (移した depends の項目、外した理由) を含む
struct Fixed<'a> {
    kind: &'a str,
    before: &'a str,
    after: &'a [&'a str],
    phrases: &'a [&'a str],
}

const SIDE_EMPTIED: [&str; 2] = ["を外した", "片側の項が全部なくなった"];
const CHAIN_GONE: [&str; 2] = ["を外した", "2 つ以上つながる所が残らない"];

// relations-removed は直した項目ごとに 1 つ (count は 1)
fn assert_relations_removed(result: &Value, expected: &[Fixed]) {
    let notes: Vec<&Value> = result["notes"]
        .as_array()
        .expect("notes は配列")
        .iter()
        .filter(|note| note["code"] == "relations-removed")
        .collect();
    assert_eq!(
        notes.len(),
        expected.len(),
        "直した項目ごとに 1 つ: {result}"
    );
    for fixed in expected {
        let head = format!("{}「{}」", fixed.kind, fixed.before);
        let note = notes
            .iter()
            .find(|note| {
                note["message"]
                    .as_str()
                    .is_some_and(|message| message.starts_with(&head))
            })
            .unwrap_or_else(|| panic!("{head} で始まる relations-removed がある: {result}"));
        assert_eq!(note["count"], json!(1.0), "{result}");
        let message = note["message"].as_str().expect("message は文字列");
        for after in fixed.after {
            assert!(
                message.contains(&format!("「{after}」")),
                "{message} に「{after}」: {result}"
            );
        }
        for phrase in fixed.phrases {
            assert!(message.contains(phrase), "{message} に {phrase}: {result}");
        }
    }
}

// 削除の結果: 原文の全体、select が最初に消したノードの親、rename が null、notes が直した項目ごとの relations-removed だけ
fn assert_deleted(source: &str, result: &Value, expected: &str, parent: Target, fixed: &[Fixed]) {
    assert_rewritten(source, result, expected, parent, false);
    let codes: Vec<&str> = fixed.iter().map(|_| "relations-removed").collect();
    assert_notes(result, &codes);
    assert_relations_removed(result, fixed);
}

// 比べの頁の 1. chain: 1 停止の手順 / 2 画面を切替 / 3 バッチ停止 / 4 書き込み停止 / 5 バックアップ
const DEMO_CHAIN: &str = "---\nmarkdag:\n    relations:\n        chain:\n            - 画面を切替 --> バッチ停止 --> 書き込み停止 --> バックアップ\n---\n\n# 停止の手順\n- 画面を切替\n- バッチ停止\n- 書き込み停止\n- バックアップ\n";
// 比べの頁の 2. join: 1 開発 / 2 企画 / 3 設計 / 4 実装 / 5 テスト / 6 リリース
const DEMO_JOIN: &str = "---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n        join:\n            - 設計 & 実装 & テスト --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- 実装\n- テスト\n- リリース\n";
// 比べの頁の 3. fork と chain: 1 作る / 2 決定 / 3 画面 / 4 API / 5 DB / 6 結合テスト / 7 公開
const DEMO_FORK: &str = "---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 画面 & API & DB\n        chain:\n            - API --> 結合テスト --> 公開\n---\n\n# 作る\n- 決定\n- 画面\n- API\n- DB\n- 結合テスト\n- 公開\n";
// 比べの頁の 4. 配下ごとの削除と 調査/*: 1 企画 / 2 調査 / 3 インタビュー / 4 競合の比較 / 5 アンケート / 6 まとめ / 7 設計
const DEMO_SUBTREE: &str = "---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        depends:\n            - インタビュー --> 設計\n            - まとめ --> 設計\n---\n\n# 企画\n## 調査\n- インタビュー\n- 競合の比較\n- アンケート\n## まとめ\n## 設計\n";

#[test]
fn edit_frontmatter_delete_splits_a_chain_at_the_deleted_node() {
    // chain は消したノードの前後で分け、2 つ以上つながる所だけを残す。途中の「バッチ停止」を消すと、前は 1 つだけなので残らない
    let before = "画面を切替 --> バッチ停止 --> 書き込み停止 --> バックアップ";
    assert_edges(
        DEMO_CHAIN,
        &[(2, 3, "chain"), (3, 4, "chain"), (4, 5, "chain")],
    );
    let expected = "---\nmarkdag:\n    relations:\n        chain:\n            - 書き込み停止 --> バックアップ\n---\n\n# 停止の手順\n- 画面を切替\n- 書き込み停止\n- バックアップ\n";
    assert_edges(expected, &[(3, 4, "chain")]);
    assert_deleted(
        DEMO_CHAIN,
        &delete_nodes(DEMO_CHAIN, &[(3, "バッチ停止")]),
        expected,
        (1, "停止の手順"),
        &[Fixed {
            kind: "chain",
            before,
            after: &["書き込み停止 --> バックアップ"],
            phrases: &[],
        }],
    );

    // 端の「バックアップ」を消すと、残りの 3 つはつながったまま
    let expected = "---\nmarkdag:\n    relations:\n        chain:\n            - 画面を切替 --> バッチ停止 --> 書き込み停止\n---\n\n# 停止の手順\n- 画面を切替\n- バッチ停止\n- 書き込み停止\n";
    assert_edges(expected, &[(2, 3, "chain"), (3, 4, "chain")]);
    assert_deleted(
        DEMO_CHAIN,
        &delete_nodes(DEMO_CHAIN, &[(5, "バックアップ")]),
        expected,
        (1, "停止の手順"),
        &[Fixed {
            kind: "chain",
            before,
            after: &["画面を切替 --> バッチ停止 --> 書き込み停止"],
            phrases: &[],
        }],
    );

    // 2 つ以上つながる所がどこにも残らなければ項目を外す。relations が空になれば relations のキーも外し、markdag キーは残す
    let source = "---\nmarkdag:\n    relations:\n        chain:\n            - a --> b --> c\n---\n# R\n- a\n- b\n- c\n";
    let expected = "---\nmarkdag:\n---\n# R\n- a\n- c\n";
    assert_edges(expected, &[]);
    assert_deleted(
        source,
        &delete_nodes(source, &[(3, "b")]),
        expected,
        (1, "R"),
        &[Fixed {
            kind: "chain",
            before: "a --> b --> c",
            after: &[],
            phrases: &CHAIN_GONE,
        }],
    );
}

#[test]
fn edit_frontmatter_delete_removes_join_terms_and_moves_a_single_source_to_depends() {
    // join は当たる項だけを外す。「実装」を消すと 設計 & テスト --> リリース
    assert_edges(
        DEMO_JOIN,
        &[
            (2, 3, "depends"),
            (3, 6, "join"),
            (4, 6, "join"),
            (5, 6, "join"),
        ],
    );
    let first = "---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n        join:\n            - 設計 & テスト --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- テスト\n- リリース\n";
    assert_edges(first, &[(2, 3, "depends"), (3, 5, "join"), (4, 5, "join")]);
    assert_deleted(
        DEMO_JOIN,
        &delete_nodes(DEMO_JOIN, &[(4, "実装")]),
        first,
        (1, "開発"),
        &[Fixed {
            kind: "join",
            before: "設計 & 実装 & テスト --> リリース",
            after: &["設計 & テスト --> リリース"],
            phrases: &[],
        }],
    );

    // 続けて「テスト」を消すと始点が 1 つになるので、join の項目を外して depends の一覧の末尾に足す。空になった join のキーも外す
    let second = "---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n            - 設計 --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- リリース\n";
    assert_edges(second, &[(2, 3, "depends"), (3, 4, "depends")]);
    assert_deleted(
        first,
        &delete_nodes(first, &[(4, "テスト")]),
        second,
        (1, "開発"),
        &[Fixed {
            kind: "join",
            before: "設計 & テスト --> リリース",
            after: &[],
            phrases: &["depends「設計 --> リリース」", "始点が 1 つになった"],
        }],
    );
}

#[test]
fn edit_frontmatter_delete_removes_fork_and_chain_terms() {
    // fork と chain の両方に出てくる「API」を消すと、fork は 決定 --> 画面 & DB、chain は 結合テスト --> 公開。通知は項目ごと
    assert_edges(
        DEMO_FORK,
        &[
            (2, 3, "fork"),
            (2, 4, "fork"),
            (2, 5, "fork"),
            (4, 6, "chain"),
            (6, 7, "chain"),
        ],
    );
    let chain = Fixed {
        kind: "chain",
        before: "API --> 結合テスト --> 公開",
        after: &["結合テスト --> 公開"],
        phrases: &[],
    };
    let expected = "---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 画面 & DB\n        chain:\n            - 結合テスト --> 公開\n---\n\n# 作る\n- 決定\n- 画面\n- DB\n- 結合テスト\n- 公開\n";
    assert_edges(expected, &[(2, 3, "fork"), (2, 4, "fork"), (5, 6, "chain")]);
    assert_deleted(
        DEMO_FORK,
        &delete_nodes(DEMO_FORK, &[(4, "API")]),
        expected,
        (1, "作る"),
        &[
            Fixed {
                kind: "fork",
                before: "決定 --> 画面 & API & DB",
                after: &["決定 --> 画面 & DB"],
                phrases: &[],
            },
            chain,
        ],
    );

    // fork の終点が 1 つになると、fork の項目を外して depends に移す (depends がなければ relations の末尾に作る)。
    // 1 回で 2 つを消しても、通知は直した項目ごとに 1 つ
    let chain = Fixed {
        kind: "chain",
        before: "API --> 結合テスト --> 公開",
        after: &["結合テスト --> 公開"],
        phrases: &[],
    };
    let expected = "---\nmarkdag:\n    relations:\n        chain:\n            - 結合テスト --> 公開\n        depends:\n            - 決定 --> 画面\n---\n\n# 作る\n- 決定\n- 画面\n- 結合テスト\n- 公開\n";
    assert_edges(expected, &[(4, 5, "chain"), (2, 3, "depends")]);
    assert_deleted(
        DEMO_FORK,
        &delete_nodes(DEMO_FORK, &[(4, "API"), (5, "DB")]),
        expected,
        (1, "作る"),
        &[
            Fixed {
                kind: "fork",
                before: "決定 --> 画面 & API & DB",
                after: &[],
                phrases: &["depends「決定 --> 画面」", "終点が 1 つになった"],
            },
            chain,
        ],
    );
}

#[test]
fn edit_frontmatter_delete_hits_leaf_selectors_only_when_their_node_goes() {
    // 「調査」の子 (インタビュー) を消しても 調査/* --> まとめ は残り、depends の インタビュー --> 設計 は片側の項が全部なくなるので外す
    assert_edges(
        DEMO_SUBTREE,
        &[
            (3, 6, "join"),
            (4, 6, "join"),
            (5, 6, "join"),
            (3, 7, "depends"),
            (6, 7, "depends"),
        ],
    );
    let interview = Fixed {
        kind: "depends",
        before: "インタビュー --> 設計",
        after: &[],
        phrases: &SIDE_EMPTIED,
    };
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        depends:\n            - まとめ --> 設計\n---\n\n# 企画\n## 調査\n- 競合の比較\n- アンケート\n## まとめ\n## 設計\n";
    assert_edges(
        expected,
        &[(3, 5, "join"), (4, 5, "join"), (5, 6, "depends")],
    );
    assert_deleted(
        DEMO_SUBTREE,
        &delete_nodes(DEMO_SUBTREE, &[(3, "インタビュー")]),
        expected,
        (2, "調査"),
        &[interview],
    );

    // 「調査」(見出し。配下ごと) を消すと 調査/* --> まとめ も外れ、空になった join のキーも外す
    let interview = Fixed {
        kind: "depends",
        before: "インタビュー --> 設計",
        after: &[],
        phrases: &SIDE_EMPTIED,
    };
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - まとめ --> 設計\n---\n\n# 企画\n## まとめ\n## 設計\n";
    assert_edges(expected, &[(2, 3, "depends")]);
    assert_deleted(
        DEMO_SUBTREE,
        &delete_nodes(DEMO_SUBTREE, &[(2, "調査")]),
        expected,
        (1, "企画"),
        &[
            Fixed {
                kind: "join",
                before: "調査/* --> まとめ",
                after: &[],
                phrases: &SIDE_EMPTIED,
            },
            interview,
        ],
    );

    // X/** も X そのものが消えたときだけ当たる。1 企画 / 2 決定 / 3 調査 / 4 インタビュー / 5 アンケート
    let source = "---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 調査/**\n---\n# 企画\n- 決定\n- 調査\n    - インタビュー\n    - アンケート\n";
    let expected = "---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 調査/**\n---\n# 企画\n- 決定\n- 調査\n    - アンケート\n";
    assert_edges(expected, &[(2, 3, "fork"), (2, 4, "fork")]);
    assert_deleted(
        source,
        &delete_nodes(source, &[(4, "インタビュー")]),
        expected,
        (3, "調査"),
        &[],
    );
    let expected = "---\nmarkdag:\n---\n# 企画\n- 決定\n";
    assert_edges(expected, &[]);
    assert_deleted(
        source,
        &delete_nodes(source, &[(3, "調査")]),
        expected,
        (1, "企画"),
        &[Fixed {
            kind: "fork",
            before: "決定 --> 調査/**",
            after: &[],
            phrases: &SIDE_EMPTIED,
        }],
    );
}

#[test]
fn edit_frontmatter_delete_keeps_join_and_fork_left_with_leaf_selectors() {
    // 始点か終点が 1 つになっても、その項が X/* なら depends に移さず、残った項で同じ kind に書き直す
    // 1 企画 / 2 決定 / 3 画面 / 4 メモ / 5 調査 / 6 インタビュー / 7 アンケート / 8 まとめ
    let source = "---\nmarkdag:\n    relations:\n        join:\n            - 調査/* & メモ --> まとめ\n        fork:\n            - 決定 --> 画面 & 調査/*\n---\n# 企画\n- 決定\n- 画面\n- メモ\n- 調査\n    - インタビュー\n    - アンケート\n- まとめ\n";
    let expected = "---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        fork:\n            - 決定 --> 調査/*\n---\n# 企画\n- 決定\n- 調査\n    - インタビュー\n    - アンケート\n- まとめ\n";
    assert_edges(
        source,
        &[
            (6, 8, "join"),
            (7, 8, "join"),
            (4, 8, "join"),
            (2, 3, "fork"),
            (2, 6, "fork"),
            (2, 7, "fork"),
        ],
    );
    assert_edges(
        expected,
        &[
            (4, 6, "join"),
            (5, 6, "join"),
            (2, 4, "fork"),
            (2, 5, "fork"),
        ],
    );
    let result = delete_nodes(source, &[(3, "画面"), (4, "メモ")]);
    assert_deleted(
        source,
        &result,
        expected,
        (1, "企画"),
        &[
            Fixed {
                kind: "join",
                before: "調査/* & メモ --> まとめ",
                after: &["調査/* --> まとめ"],
                phrases: &[],
            },
            Fixed {
                kind: "fork",
                before: "決定 --> 画面 & 調査/*",
                after: &["決定 --> 調査/*"],
                phrases: &[],
            },
        ],
    );
    for note in result["notes"].as_array().expect("notes は配列") {
        assert!(
            !note["message"].as_str().unwrap_or("").contains("depends"),
            "depends に移さない: {result}"
        );
    }
}

#[test]
fn edit_frontmatter_delete_removes_empty_keys_and_keeps_branches_and_members() {
    // 項目がなくなった kind のキーと relations のキーは外す。markdag.branches と members の項目は外さない
    let source = "---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n    branches:\n        - API\n    groups:\n        back:\n            members:\n                - API\n---\n# R\n- API\n- 公開\n";
    let expected = "---\nmarkdag:\n    branches:\n        - API\n    groups:\n        back:\n            members:\n                - API\n---\n# R\n- 公開\n";
    assert_deleted(
        source,
        &delete_nodes(source, &[(2, "API")]),
        expected,
        (1, "R"),
        &[Fixed {
            kind: "depends",
            before: "API --> 公開",
            after: &[],
            phrases: &SIDE_EMPTIED,
        }],
    );

    // 式 1 つのスカラの kind も 1 項目の一覧として扱い、外れたらキーごと外す。markdag のほかのキーは残る
    let source = "---\nmarkdag:\n    relations:\n        depends: 設計 --> リリース\n    edgeHighlight: true\n---\n# R\n- 設計\n- リリース\n";
    let expected = "---\nmarkdag:\n    edgeHighlight: true\n---\n# R\n- リリース\n";
    assert_edges(expected, &[]);
    assert_deleted(
        source,
        &delete_nodes(source, &[(2, "設計")]),
        expected,
        (1, "R"),
        &[Fixed {
            kind: "depends",
            before: "設計 --> リリース",
            after: &[],
            phrases: &SIDE_EMPTIED,
        }],
    );
}

#[test]
fn edit_frontmatter_delete_leaves_terms_that_did_not_resolve() {
    // 書き換える前に解決できなかった項 (2 つに当たる x、ない名前) は当てない。当たる項のない項目は変えず、notes は空
    // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 公開
    let frontmatter = "---\nmarkdag:\n    relations:\n        depends:\n            - x --> 公開\n            - 存在しない --> 公開\n---\n";
    let source = format!("{frontmatter}# R\n## A\n- x\n## B\n- x\n## C\n- 公開\n");
    let expected = format!("{frontmatter}# R\n## A\n## B\n- x\n## C\n- 公開\n");
    assert_deleted(
        &source,
        &delete_nodes(&source, &[(3, "x")]),
        &expected,
        (2, "A"),
        &[],
    );
}

#[test]
fn edit_frontmatter_delete_rewrites_a_single_expression_as_a_list() {
    // 式 1 つのスカラを直すときは、キーの行と「- 直した式」の 2 行の形にする。字下げは frontmatter の幅
    let after_body = "# R\n- 設計\n- テスト\n- リリース\n";
    for (source, expected) in [
        (
            format!(
                "---\nmarkdag:\n    relations:\n        join: 設計 & 実装 & テスト --> リリース\n---\n{JOIN_BODY}"
            ),
            format!(
                "---\nmarkdag:\n    relations:\n        join:\n            - 設計 & テスト --> リリース\n---\n{after_body}"
            ),
        ),
        (
            format!(
                "---\nmarkdag:\n  relations:\n    join: 設計 & 実装 & テスト --> リリース\n---\n{JOIN_BODY}"
            ),
            format!(
                "---\nmarkdag:\n  relations:\n    join:\n      - 設計 & テスト --> リリース\n---\n{after_body}"
            ),
        ),
    ] {
        assert_edges(&expected, &[(2, 4, "join"), (3, 4, "join")]);
        assert_deleted(
            &source,
            &delete_nodes(&source, &[(3, "実装")]),
            &expected,
            (1, "R"),
            &[Fixed {
                kind: "join",
                before: "設計 & 実装 & テスト --> リリース",
                after: &["設計 & テスト --> リリース"],
                phrases: &[],
            }],
        );
    }
}

#[test]
fn edit_frontmatter_delete_splits_a_chain_in_place() {
    // 分けた chain の項目は、もとの項目の位置にもとの順で並べる (前後の項目の並びは変えない)
    // 1 R / 2 a / 3 b / 4 c / 5 d / 6 e / 7 p / 8 q / 9 x / 10 y → 消したあと 4 d / 5 e / 6 p / 7 q / 8 x / 9 y
    let body = "# R\n- a\n- b\n- c\n- d\n- e\n- p\n- q\n- x\n- y\n";
    let source = format!(
        "---\nmarkdag:\n    relations:\n        chain:\n            - x --> y\n            - a --> b --> c --> d --> e\n            - p --> q\n---\n{body}"
    );
    let expected = format!(
        "---\nmarkdag:\n    relations:\n        chain:\n            - x --> y\n            - a --> b\n            - d --> e\n            - p --> q\n---\n{}",
        body.replace("- c\n", "")
    );
    assert_edges(
        &expected,
        &[
            (8, 9, "chain"),
            (2, 3, "chain"),
            (4, 5, "chain"),
            (6, 7, "chain"),
        ],
    );
    assert_deleted(
        &source,
        &delete_nodes(&source, &[(4, "c")]),
        &expected,
        (1, "R"),
        &[Fixed {
            kind: "chain",
            before: "a --> b --> c --> d --> e",
            after: &["a --> b", "d --> e"],
            phrases: &[],
        }],
    );
}

#[test]
fn edit_frontmatter_delete_creates_depends_at_the_end_of_relations() {
    // join の始点が 1 つになり depends がなければ、relations の写像の末尾に depends を作る。
    // 1 回で同じ項目の 2 つの項を消しても、通知は項目ごとに 1 つ。1 R / 2 a / 3 b / 4 c / 5 d / 6 x / 7 y / 8 z
    let source = "---\nmarkdag:\n    relations:\n        join:\n            - a & b & c --> d\n        chain:\n            - x --> y --> z\n---\n# R\n- a\n- b\n- c\n- d\n- x\n- y\n- z\n";
    let expected = "---\nmarkdag:\n    relations:\n        chain:\n            - x --> y --> z\n        depends:\n            - c --> d\n---\n# R\n- c\n- d\n- x\n- y\n- z\n";
    assert_edges(
        expected,
        &[(4, 5, "chain"), (5, 6, "chain"), (2, 3, "depends")],
    );
    assert_deleted(
        source,
        &delete_nodes(source, &[(2, "a"), (3, "b")]),
        expected,
        (1, "R"),
        &[Fixed {
            kind: "join",
            before: "a & b & c --> d",
            after: &[],
            phrases: &["depends「c --> d」", "始点が 1 つになった"],
        }],
    );
}

#[test]
fn edit_frontmatter_delete_rewrites_flow_style_and_block_scalar_relations() {
    // 直す項目がフロー形式のブロックにあれば、字下げの形に書き直してから外す (細部 21)。空になった kind と relations のキーは外す。
    // join の項目を移す先の depends が複数行のスカラなら、- の一覧に書き直してから足す (D-053)
    let source = "---\nmarkdag:\n    relations:\n        depends: [a --> b]\n---\n# R\n- a\n- b\n";
    assert_deleted(
        source,
        &delete_nodes(source, &[(2, "a")]),
        "---\nmarkdag:\n---\n# R\n- b\n",
        (1, "R"),
        &[Fixed {
            kind: "depends",
            before: "a --> b",
            after: &[],
            phrases: &SIDE_EMPTIED,
        }],
    );
    let source = "---\nmarkdag:\n    relations:\n        depends: |\n            x --> y\n        join:\n            - a & b --> c\n---\n# R\n- a\n- b\n- c\n- x\n- y\n";
    let expected = "---\nmarkdag:\n    relations:\n        depends:\n            - x --> y\n            - b --> c\n---\n# R\n- b\n- c\n- x\n- y\n";
    assert_edges(expected, &[(4, 5, "depends"), (2, 3, "depends")]);
    assert_deleted(
        source,
        &delete_nodes(source, &[(2, "a")]),
        expected,
        (1, "R"),
        &[Fixed {
            kind: "join",
            before: "a & b --> c",
            after: &[],
            phrases: &["depends「b --> c」", "始点が 1 つになった"],
        }],
    );
}

// ==== グループの書き換え ====
// JSON の形、グループの操作と断る理由と飛ばすノード、%印と印を書ける行、frontmatter の書き換えの方式、グループの 6 色の値。
// 期待の文書は、比べる前に解析し直して「モデルの groups と groups_of がねらいどおりで、壊れた診断がない」ことを確かめ、
// 指すノードは操作の前に原文の解析で id と refText を確かめる (合流のテストと同じく、期待の書き誤りを実装の前の赤の確認で見分けるため)

// ---- グループの書き換えの入出力の補助 ----

// 新しいグループの色。group<番号> は番号から 1 を引いた位置の色で、6 色を巡る
const GROUP_COLORS: [&str; 6] = [
    "#3B7DD8", "#2E9E6B", "#E8833A", "#8A5FC2", "#D64545", "#E0A100",
];

fn color_of(number: usize) -> &'static str {
    GROUP_COLORS[(number - 1) % GROUP_COLORS.len()]
}

// 新しいグループ group<番号> の定義の行 (label、color、boundary の順)。key はグループのキーの字下げ、child は中のキーの字下げ
fn new_group_lines(number: usize, key: &str, child: &str) -> String {
    format!(
        "{key}group{number}:\n{child}label: グループ {number}\n{child}color: \"{}\"\n{child}boundary: true\n",
        color_of(number)
    )
}

// 字下げの幅が 4 の frontmatter の markdag.groups の下に足す定義
fn new_group(number: usize) -> String {
    new_group_lines(number, "        ", "            ")
}

// markdag の下に groups のキーと新しい定義を作るときの行 (幅 4)
fn new_groups(number: usize) -> String {
    format!("    groups:\n{}", new_group(number))
}

fn targets_json(nodes: &[Target]) -> Vec<Value> {
    nodes.iter().map(|&node| target_json(node)).collect()
}

fn group_nodes_unchecked(source: &str, nodes: &[Target]) -> Value {
    edited_by(
        source,
        json!({ "kind": "groupNodes", "nodes": targets_json(nodes) }),
    )
}

fn group_nodes(source: &str, nodes: &[Target]) -> Value {
    let nodes = checked_targets(source, nodes);
    edited_by(source, json!({ "kind": "groupNodes", "nodes": nodes }))
}

fn add_to_group_unchecked(source: &str, group: &str, nodes: &[Target]) -> Value {
    edited_by(
        source,
        json!({ "kind": "addToGroup", "group": group, "nodes": targets_json(nodes) }),
    )
}

fn add_to_group(source: &str, group: &str, nodes: &[Target]) -> Value {
    let nodes = checked_targets(source, nodes);
    edited_by(
        source,
        json!({ "kind": "addToGroup", "group": group, "nodes": nodes }),
    )
}

fn define_group(source: &str) -> Value {
    edited_by(source, json!({ "kind": "defineGroup" }))
}

fn rename_group(source: &str, group: &str, label: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "renameGroup", "group": group, "label": label }),
    )
}

fn set_group_color(source: &str, group: &str, color: &str) -> Value {
    edited_by(
        source,
        json!({ "kind": "setGroupColor", "group": group, "color": color }),
    )
}

fn set_group_boundary(source: &str, group: &str, boundary: bool) -> Value {
    edited_by(
        source,
        json!({ "kind": "setGroupBoundary", "group": group, "boundary": boundary }),
    )
}

fn ungroup(source: &str, group: &str) -> Value {
    edited_by(source, json!({ "kind": "ungroup", "group": group }))
}

// グループ 1 つ: (id、label、color、boundary、defined)
type GroupRow<'a> = (&'a str, &'a str, Option<&'a str>, bool, bool);

// 定義のあるグループの行
fn defined<'a>(
    id: &'a str,
    label: &'a str,
    color: Option<&'a str>,
    boundary: bool,
) -> GroupRow<'a> {
    (id, label, color, boundary, true)
}

// 本文の %印だけで使われている、定義のないグループの行 (文字のラベル)
fn undefined(id: &str) -> GroupRow<'_> {
    (id, id, None, false, false)
}

// groupNodes と defineGroup が作る group<番号> の行
fn created(id: &str, number: usize) -> GroupRow<'_> {
    (id, "", Some(color_of(number)), true, true)
}

// 原文を解析し直したモデルの groups (定義の順、そのあとに定義のないグループを書かれた順) と、ノードごとの所属 (groups_of) が
// このとおりで、壊れた診断 (YAML、スキーマ、group-invalid、参照) がない。created の行の label は「グループ <番号>」で比べる
fn assert_groups(source: &str, groups: &[GroupRow], members: &[(u32, &[&str])]) {
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
    let expected: Vec<(String, String, Option<String>, bool, bool)> = groups
        .iter()
        .map(|&(id, label, color, boundary, defined)| {
            let label = match (label, id.strip_prefix("group")) {
                ("", Some(number)) => format!("グループ {number}"),
                _ => label.to_string(),
            };
            (
                id.to_string(),
                label,
                color.map(str::to_string),
                boundary,
                defined,
            )
        })
        .collect();
    assert_eq!(actual, expected, "{source:?}");
    for &(id, names) in members {
        let of = model.groups_of.get(&id).cloned().unwrap_or_default();
        assert_eq!(of, names, "id {id} の所属: {source:?}");
    }
    let broken = broken_codes(&model);
    assert!(broken.is_empty(), "{source:?}: {broken:?}");
}

fn group_selected(id: &str) -> Value {
    json!({ "kind": "group", "id": id })
}

// グループを書き換えた結果: 原文の全体、select がそのグループ、rename がそのグループか null
fn assert_group_edited(source: &str, result: &Value, expected: &str, group: &str, rename: bool) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], group_selected(group), "{result}");
    let renamed = if rename {
        group_selected(group)
    } else {
        Value::Null
    };
    assert_eq!(result["rename"], renamed, "{result}");
}

// addToGroup の結果: 原文の全体、select が渡した同じノード、rename が null
fn assert_nodes_kept(source: &str, result: &Value, expected: &str, nodes: &[Target]) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(
        result["select"],
        normalized(json!({ "kind": "nodes", "nodes": targets_json(nodes) })),
        "{result}"
    );
    assert_eq!(result["rename"], Value::Null, "{result}");
}

// グループ解除の結果: 原文の全体、選択を解き (select が none)、rename が null
fn assert_ungrouped(source: &str, result: &Value, expected: &str) {
    assert_eq!(applied(source, result), expected, "{source:?}: {result}");
    assert_eq!(result["select"], json!({ "kind": "none" }), "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
}

// 1 R / 2 a / 3 a1 / 4 a2 / 5 b / 6 c
const GROUP_NESTED: &str = "# R\n- a\n    - a1\n        - a2\n- b\n- c\n";
// 1 R / 2 設計 (下線の見出し) / 3 画面 / 4 実装 (行頭に空白のある ATX の見出し)
const GROUP_UNMARKABLE: &str = "# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n";
// 1 R / 2 ul / 3 a / 4 b / 5 ol / 6「1. c」/ 7「2. d」
const GROUP_LISTS: &str = "# R\n\n- a\n- b\n\n1. c\n2. d\n";
// 1 R / 2 表 / 3 コード / 4 画像
const GROUP_BLOCKS: &str =
    "# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n";
// 定義 g (label G) だけの frontmatter
const DEFINED_G: &str = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n";
// group1 の label がブロックスカラで、あとに group2 の定義が続く文書 (ブロックスカラの最後の行と次のキーの行を取り違えない)
const BLOCK_LABEL: &str = "---\nmarkdag:\n    groups:\n        group1:\n            label: |\n                設計の\n                まとまり\n        group2:\n            label: 実装\n---\n# R\n\n- a %group1\n- b %group2\n";

// ---- groupNodes: 印の付け方と飛ばすノード ----

#[test]
fn edit_frontmatter_group_nodes_marks_the_selected_node_and_defines_the_group() {
    // 1 つだけ選んでいてもまとめられる。1 行目の末尾に %group1 を付け、markdag.groups に定義を足し、
    // select と rename がそのグループ。1 R / 2 a / 3 b
    let source = format!("{MARKDAG_ONLY}# R\n- a\n- b\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(1, &[]), (2, &["group1"]), (3, &[])],
    );
    let result = group_nodes(&source, &[(2, "a")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    assert_notes(&result, &[]);

    // 見出しにも 1 行目の末尾に付ける。配下は印を引き継ぐ。1 R / 2 A / 3 x / 4 B
    let source = format!("{MARKDAG_ONLY}# R\n## A\n- x\n## B\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n## A %group1\n- x\n## B\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &["group1"]), (4, &[])],
    );
    let result = group_nodes(&source, &[(2, "A")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
}

#[test]
fn edit_frontmatter_group_nodes_result_json_selects_the_group() {
    // select と rename は { kind: 'group', id }
    let source = format!("{MARKDAG_ONLY}# R\n- a\n- b\n");
    let result = group_nodes(&source, &[(2, "a")]);
    assert_eq!(
        keys(&result),
        ["notes", "rename", "select", "splices", "status"]
    );
    assert_eq!(keys(&result["select"]), ["id", "kind"]);
    assert_eq!(keys(&result["rename"]), ["id", "kind"]);
    assert_eq!(result["select"], group_selected("group1"), "{result}");
    assert_eq!(result["rename"], group_selected("group1"), "{result}");
}

#[test]
fn edit_frontmatter_group_nodes_skips_descendants_of_selected_nodes() {
    // 選んだノードの子孫には印を付けない (印は子孫に引き継がれる)。渡した順によらない
    let source = format!("{MARKDAG_ONLY}{GROUP_NESTED}");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n    - a1\n        - a2\n- b %group1\n- c\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[
            (2, &["group1"]),
            (3, &["group1"]),
            (4, &["group1"]),
            (5, &["group1"]),
            (6, &[]),
        ],
    );
    let result = group_nodes(&source, &[(2, "a"), (3, "a1"), (4, "a2"), (5, "b")]);
    assert_group_edited(&source, &result, &expected, "group1", true);

    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n    - a1\n        - a2\n- b\n- c\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(4, &["group1"]), (5, &[])],
    );
    let result = group_nodes(&source, &[(4, "a2"), (2, "a")]);
    assert_group_edited(&source, &result, &expected, "group1", true);

    // 見出しの配下の項目も子孫。1 R / 2 A / 3 x / 4 y / 5 B / 6 z
    let source = format!("{MARKDAG_ONLY}# R\n## A\n- x\n- y\n## B\n- z\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n## A %group1\n- x\n- y\n## B\n- z %group1\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(3, &["group1"]), (5, &[]), (6, &["group1"])],
    );
    let result = group_nodes(&source, &[(2, "A"), (3, "x"), (6, "z")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
}

#[test]
fn edit_frontmatter_group_nodes_skips_the_root() {
    // ルートには付けない。ルートと一緒に選んだノードはまとめる (飛ばすノードは断る理由に数えない)
    let source = format!("{MARKDAG_ONLY}# R\n- a\n- b\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(1, &[]), (2, &["group1"])],
    );
    let result = group_nodes(&source, &[(1, "R"), (2, "a")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    // ルートだけを選んだら root で断る
    assert_refused(&group_nodes(&source, &[(1, "R")]), "root");

    // 行を持たないルート (title の T) も飛ばす (no-source-line にしない)。1 T / 2 a / 3「1. b」
    let source = "---\ntitle: T\nmarkdag:\n---\n- a\n\n1. b\n";
    let expected = format!(
        "---\ntitle: T\nmarkdag:\n{}---\n- a %group1\n\n1. b\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &[])],
    );
    let result = group_nodes(source, &[(1, "T"), (2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_refused(&group_nodes(source, &[(1, "T")]), "root");

    // リストだけの文書のルート (容器) も、ルートの規則が勝って飛ばす。1 容器 / 2 a / 3 b。
    // 最初の項目 a の行は容器の 1 行目と同じ行で、容器も a の印を読むので、2 つ目の項目で見る
    let source = format!("{MARKDAG_ONLY}- a\n- b\n");
    let expected = format!("---\nmarkdag:\n{}---\n- a\n- b %group1\n", new_groups(1));
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(1, &[]), (2, &[]), (3, &["group1"])],
    );
    let result = group_nodes(&source, &[(1, ""), (3, "b")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    assert_refused(&group_nodes(&source, &[(1, "")]), "root");
}

#[test]
fn edit_frontmatter_group_nodes_appends_the_mark_after_existing_marks() {
    // 新しい印は既存の印の並びの末尾に、空白 1 つで足す (タグ、ほかのグループ、$id、タスクの項目)
    // 1 R / 2 a / 3 b / 4 c / 5 d
    let source = format!("{MARKDAG_ONLY}# R\n- a #k:v\n- [ ] b\n- c %g\n- d $x\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a #k:v %group1\n- [ ] b %group1\n- c %g %group1\n- d $x %group1\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1), undefined("g")],
        &[
            (2, &["group1"]),
            (3, &["group1"]),
            (4, &["group1", "g"]),
            (5, &["group1"]),
        ],
    );
    let result = group_nodes(&source, &[(2, "a"), (3, "b"), (4, "c"), (5, "d")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
}

// ---- groupNodes: 名前の番号と定義の足し方 ----

#[test]
fn edit_frontmatter_group_nodes_names_the_smallest_unused_number() {
    // 名前は使われていない最小の group<番号>。定義と本文の印の両方を見る。色は番号の位置
    let group1 = "---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n";
    // 定義に group1 がある
    let source = format!("{group1}---\n# R\n- a %group1\n- b\n");
    let expected = format!(
        "{group1}{}---\n# R\n- a %group1\n- b %group2\n",
        new_group(2)
    );
    assert_groups(
        &expected,
        &[defined("group1", "設計", None, false), created("group2", 2)],
        &[(2, &["group1"]), (3, &["group2"])],
    );
    let result = group_nodes(&source, &[(3, "b")]);
    assert_group_edited(&source, &result, &expected, "group2", true);

    // 本文の印にだけ group1 がある (定義がない)
    let source = format!("{MARKDAG_ONLY}# R\n- a %group1\n- b\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b %group2\n",
        new_groups(2)
    );
    assert_groups(
        &expected,
        &[created("group2", 2), undefined("group1")],
        &[(2, &["group1"]), (3, &["group2"])],
    );
    let result = group_nodes(&source, &[(3, "b")]);
    assert_group_edited(&source, &result, &expected, "group2", true);

    // 定義の group1 と本文の印の group2 の両方を避ける
    let source = format!("{group1}---\n# R\n- a %group2\n- b\n");
    let expected = format!(
        "{group1}{}---\n# R\n- a %group2\n- b %group3\n",
        new_group(3)
    );
    assert_groups(
        &expected,
        &[
            defined("group1", "設計", None, false),
            created("group3", 3),
            undefined("group2"),
        ],
        &[(2, &["group2"]), (3, &["group3"])],
    );
    let result = group_nodes(&source, &[(3, "b")]);
    assert_group_edited(&source, &result, &expected, "group3", true);

    // 空いている番号を使う: 定義が group2 だけなら group1 (groups の末尾に足す。並び替えない)
    let group2 = "---\nmarkdag:\n    groups:\n        group2:\n            label: 実装\n";
    let source = format!("{group2}---\n# R\n- a\n- b %group2\n");
    let expected = format!(
        "{group2}{}---\n# R\n- a %group1\n- b %group2\n",
        new_group(1)
    );
    assert_groups(
        &expected,
        &[defined("group2", "実装", None, false), created("group1", 1)],
        &[(2, &["group1"]), (3, &["group2"])],
    );
    let result = group_nodes(&source, &[(2, "a")]);
    assert_group_edited(&source, &result, &expected, "group1", true);

    // 本文の印の group1 と group3 の間の group2
    let source = format!("{MARKDAG_ONLY}# R\n- a %group1\n- b %group3\n- c\n");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b %group3\n- c %group2\n",
        new_groups(2)
    );
    assert_groups(
        &expected,
        &[
            created("group2", 2),
            undefined("group1"),
            undefined("group3"),
        ],
        &[(4, &["group2"])],
    );
    let result = group_nodes(&source, &[(4, "c")]);
    assert_group_edited(&source, &result, &expected, "group2", true);
}

#[test]
fn edit_frontmatter_group_nodes_cycles_six_colors_by_the_number() {
    // color は番号から 1 を引いた位置の色で、6 色を巡る: group6 は 6 色目、group7 は 1 色目、group8 は 2 色目
    for (used, number) in [(5, 6), (6, 7), (7, 8)] {
        // 1 R / 2〜(used + 1) が %group1〜%group<used> の項目 / 最後が b
        let marks: String = (1..=used).map(|n| format!("- a{n} %group{n}\n")).collect();
        let source = format!("{MARKDAG_ONLY}# R\n{marks}- b\n");
        let id = format!("group{number}");
        let expected = format!(
            "---\nmarkdag:\n{}---\n# R\n{marks}- b %{id}\n",
            new_groups(number)
        );
        let b = (used + 2) as u32;
        let mut groups = vec![created(&id, number)];
        let names: Vec<String> = (1..=used).map(|n| format!("group{n}")).collect();
        groups.extend(names.iter().map(|name| undefined(name)));
        assert_groups(&expected, &groups, &[(b, &[id.as_str()])]);
        let result = group_nodes(&source, &[(b, "b")]);
        assert_group_edited(&source, &result, &expected, &id, true);
    }
    assert_eq!(color_of(7), GROUP_COLORS[0]);
    assert_eq!(color_of(8), GROUP_COLORS[1]);
}

#[test]
fn edit_frontmatter_group_nodes_creates_frontmatter_markdag_and_groups() {
    // frontmatter、markdag、groups がなければ作る
    // frontmatter がない: 先頭に作り、閉じの --- のあとに空行 (frontmatter-added)
    let source = "# R\n- a\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n{}---\n\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes_include(&result, &["frontmatter-added"]);

    // markdag キーがない frontmatter: 最上位の写像の末尾に markdag: を足す (markdag-added)
    let source = "---\ntitle: T\n---\n# R\n- a\n- b\n";
    let expected = format!(
        "---\ntitle: T\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["markdag-added"]);

    // 空の frontmatter はその間に入れる
    let source = "---\n---\n# R\n- a\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["markdag-added"]);

    // groups がない markdag: 写像の末尾 (relations のあと) に groups を作る
    let relations = "---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n";
    let source = format!("{relations}---\n# R\n- a\n- b\n");
    let expected = format!("{relations}{}---\n# R\n- a %group1\n- b\n", new_groups(1));
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(&source, &[(2, "a")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    assert_notes(&result, &[]);

    // markdag のあとに兄弟のキーがあっても、markdag の写像の末尾に足す
    let source = "---\nmarkdag:\n    edgeHighlight: true\ntitle: T\n---\n# R\n- a\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n    edgeHighlight: true\n{}title: T\n---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
}

#[test]
fn edit_frontmatter_group_nodes_adds_markdag_before_marking() {
    // markdag キーのない文書では markdag: を足してから印を付ける。
    // `API #draft` は markdag: を足すと名前 API とタグ draft に読まれ、%group1 はタグのあとに足す
    // 1 R / 2「API #draft」(markdag キーのない原文の refText) / 3 b
    let source = "---\ntitle: T\n---\n# R\n- API #draft\n- b\n";
    let expected = format!(
        "---\ntitle: T\nmarkdag:\n{}---\n# R\n- API #draft %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &[])],
    );
    assert_eq!(node_of(&expected, 2).ref_text, "API", "{expected:?}");
    let result = group_nodes(source, &[(2, "API #draft")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["markdag-added"]);
}

#[test]
fn edit_frontmatter_group_nodes_follows_indent_comments_and_crlf() {
    // 字下げが 2 の frontmatter は、既存のグループのキーの字下げで足し、中は +2
    let source = "---\nmarkdag:\n  groups:\n    g:\n      label: G\n---\n# R\n- a %g\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n  groups:\n    g:\n      label: G\n{}---\n# R\n- a %g\n- b %group1\n",
        new_group_lines(1, "    ", "      ")
    );
    assert_groups(
        &expected,
        &[defined("g", "G", None, false), created("group1", 1)],
        &[(2, &["g"]), (3, &["group1"])],
    );
    let result = group_nodes(source, &[(3, "b")]);
    assert_group_edited(source, &result, &expected, "group1", true);

    // groups を新しく作る階層も、frontmatter の最小の字下げ (2) で作る
    let source = "---\nmarkdag:\n  edgeHighlight: true\n---\n# R\n- a\n";
    let expected = format!(
        "---\nmarkdag:\n  edgeHighlight: true\n  groups:\n{}---\n# R\n- a %group1\n",
        new_group_lines(1, "    ", "      ")
    );
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);

    // groups の最後の値のあとのコメントの行は、足した行のあとに残る。値の行末のコメントも残る
    let head = "---\nmarkdag:\n    groups:\n        g:\n            label: G # 設計\n";
    let tail = "        # 終わりのコメント\n---\n";
    let source = format!("{head}{tail}# R\n- a %g\n- b\n");
    let expected = format!("{head}{}{tail}# R\n- a %g\n- b %group1\n", new_group(1));
    assert_groups(
        &expected,
        &[defined("g", "G", None, false), created("group1", 1)],
        &[(3, &["group1"])],
    );
    let result = group_nodes(&source, &[(3, "b")]);
    assert_group_edited(&source, &result, &expected, "group1", true);

    // CRLF の文書は足す行と印を付けた行の末尾に \r
    let source = "---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n";
    let expected = format!(
        "---\r\nmarkdag:\r\n{}---\r\n# R\r\n- a %group1\r\n- b\r\n",
        new_groups(1).replace('\n', "\r\n")
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &[])],
    );
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
}

#[test]
fn edit_frontmatter_group_nodes_removes_a_bom() {
    // BOM で始まる文書は BOM を外して frontmatter を作る (bom-removed)。BOM のすぐあとが --- の行の文書も、BOM を外して
    // その frontmatter に書く (bom-removed。D-068)
    let source = "\u{feff}# R\n- a\n";
    let expected = format!("---\nmarkdag:\n{}---\n\n# R\n- a %group1\n", new_groups(1));
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes_include(&result, &["bom-removed", "frontmatter-added"]);

    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a\n- b\n";
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n",
        new_groups(1)
    );
    assert_groups(&expected, &[created("group1", 1)], &[(2, &["group1"])]);
    let result = group_nodes(source, &[(2, "a")]);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["bom-removed"]);
}

// ---- groupNodes: 断る ----

#[test]
fn edit_frontmatter_group_nodes_rewrites_unmarkable_headings_and_refuses_containers_and_blocks() {
    // 下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから %印を付ける (D-046)。
    // 画面は設計の配下なので、設計と一緒に選ぶと印を付けない
    let source = format!("{MARKDAG_ONLY}{GROUP_UNMARKABLE}");
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n\n## 設計 %group1\n\n- 画面\n\n ## 実装\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &["group1"]), (4, &[])],
    );
    let result = group_nodes(&source, &[(2, "設計"), (3, "画面")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    let expected = format!(
        "---\nmarkdag:\n{}---\n# R\n\n設計\n---\n\n- 画面 %group1\n\n## 実装 %group1\n",
        new_groups(1)
    );
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &[]), (3, &["group1"]), (4, &["group1"])],
    );
    let result = group_nodes(&source, &[(3, "画面"), (4, "実装")]);
    assert_group_edited(&source, &result, &expected, "group1", true);
    // 印を書けないノードを含めてまとめると全体を断り、原文を変えない
    // 容器は no-source-line
    let source = format!("{MARKDAG_ONLY}{GROUP_LISTS}");
    assert_refused(
        &group_nodes(&source, &[(5, ""), (3, "a")]),
        "no-source-line",
    );
    assert_refused(&group_nodes(&source, &[(2, "")]), "no-source-line");
    // 表、コード、画像は block-node
    let source = format!("{MARKDAG_ONLY}{GROUP_BLOCKS}");
    for id in [2, 3, 4] {
        assert_refused(&group_nodes(&source, &[(id, "")]), "block-node");
    }
}

#[test]
fn edit_frontmatter_group_nodes_rewrites_flow_style_and_refuses_frontmatter_it_cannot_write() {
    // 足す先がフロー形式なら、字下げの形に書き直してから足す (D-050)
    let body = "# R\n- a\n- b\n";
    let marked = "# R\n- a %group1\n- b\n";
    for (frontmatter, written) in [
        ("markdag: {}\n", format!("markdag:\n{}", new_groups(1))),
        (
            "markdag:\n    groups: {}\n",
            format!("markdag:\n{}", new_groups(1)),
        ),
        (
            "markdag:\n    groups: { g: { label: G } }\n",
            format!(
                "markdag:\n    groups:\n        g:\n            label: G\n{}",
                new_group(1)
            ),
        ),
    ] {
        let source = format!("---\n{frontmatter}---\n{body}");
        let expected = format!("---\n{written}---\n{marked}");
        let result = group_nodes(&source, &[(2, "a")]);
        assert_group_edited(&source, &result, &expected, "group1", true);
        assert_notes(&result, &[]);
    }
    // YAML として読めない frontmatter は frontmatter-invalid、道すじの途中が写像でなければ frontmatter-not-map
    for frontmatter in ["markdag:\n    groups: \"x\n", "markdag:\nmarkdag:\n"] {
        let source = format!("---\n{frontmatter}---\n{body}");
        assert_refused(&group_nodes(&source, &[(2, "a")]), "frontmatter-invalid");
    }
    for frontmatter in [
        "markdag: true\n",
        "markdag:\n    groups: 設計\n",
        "markdag:\n    groups:\n        - g\n",
    ] {
        let source = format!("---\n{frontmatter}---\n{body}");
        assert_refused(&group_nodes(&source, &[(2, "a")]), "frontmatter-not-map");
    }
}

#[test]
fn edit_frontmatter_group_nodes_refuses_stale_targets_and_rewrites_lone_carriage_returns() {
    // refText が違う、その id のノードがないなら stale-node。単独の \r を含む文書は、文書の最初の改行 (\n) にそろえてから
    // まとめる (D-063)
    let source = format!("{MARKDAG_ONLY}# R\n- a\n- b\n");
    assert_refused(&group_nodes_unchecked(&source, &[(2, "x")]), "stale-node");
    assert_refused(
        &group_nodes_unchecked(&source, &[(2, "a"), (99, "b")]),
        "stale-node",
    );
    for (source, expected) in [
        (
            "# R\n- a\n- b\r- c\n",
            format!(
                "---\nmarkdag:\n{}---\n\n# R\n- a %group1\n- b\n- c\n",
                new_groups(1)
            ),
        ),
        (
            "---\nmarkdag:\n---\n# R\n- a\n- b\r- c\n",
            format!(
                "---\nmarkdag:\n{}---\n# R\n- a %group1\n- b\n- c\n",
                new_groups(1)
            ),
        ),
    ] {
        let result = group_nodes(source, &[(2, "a")]);
        assert_group_edited(source, &result, &expected, "group1", true);
    }
}

#[test]
fn edit_frontmatter_group_op_json_shape() {
    // グループの 7 つの操作の EditOp の JSON。読めない形は serde が受け付けない (いまも通る)
    let node = json!({ "id": 2, "refText": "a" });
    for ok in [
        json!({ "kind": "groupNodes", "nodes": [node.clone()] }),
        json!({ "kind": "defineGroup" }),
        json!({ "kind": "addToGroup", "group": "g", "nodes": [node.clone()] }),
        json!({ "kind": "renameGroup", "group": "g", "label": "設計" }),
        json!({ "kind": "setGroupColor", "group": "g", "color": "#3B7DD8" }),
        json!({ "kind": "setGroupBoundary", "group": "g", "boundary": false }),
        json!({ "kind": "ungroup", "group": "g" }),
    ] {
        assert!(serde_json::from_value::<EditOp>(ok.clone()).is_ok(), "{ok}");
    }
    for bad in [
        json!({ "kind": "groupNodes" }),
        json!({ "kind": "groupNodes", "nodes": node.clone() }),
        json!({ "kind": "addToGroup", "nodes": [node.clone()] }),
        json!({ "kind": "addToGroup", "group": 1, "nodes": [node.clone()] }),
        json!({ "kind": "renameGroup", "group": "g" }),
        json!({ "kind": "setGroupColor", "group": "g", "color": 3 }),
        json!({ "kind": "setGroupBoundary", "group": "g", "boundary": "true" }),
        json!({ "kind": "ungroup" }),
    ] {
        assert!(
            serde_json::from_value::<EditOp>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

// ---- defineGroup: 定義だけのグループ ----

#[test]
fn edit_frontmatter_define_group_adds_a_definition_without_members() {
    // メンバーのいないグループ (定義だけ) を作り、select と rename がそのグループ。本文は変えない
    let source = format!("{MARKDAG_ONLY}# R\n- a\n");
    let expected = format!("---\nmarkdag:\n{}---\n# R\n- a\n", new_groups(1));
    assert_groups(&expected, &[created("group1", 1)], &[(1, &[]), (2, &[])]);
    let result = define_group(&source);
    assert_group_edited(&source, &result, &expected, "group1", true);
    assert_notes(&result, &[]);

    // 名前の番号は本文の印と定義の両方を避ける
    let source = format!("{MARKDAG_ONLY}# R\n- a %group1\n");
    let expected = format!("---\nmarkdag:\n{}---\n# R\n- a %group1\n", new_groups(2));
    assert_groups(
        &expected,
        &[created("group2", 2), undefined("group1")],
        &[(2, &["group1"])],
    );
    assert_group_edited(&source, &define_group(&source), &expected, "group2", true);
    let group1 = "---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n";
    let source = format!("{group1}---\n# R\n- a\n");
    let expected = format!("{group1}{}---\n# R\n- a\n", new_group(2));
    assert_groups(
        &expected,
        &[defined("group1", "設計", None, false), created("group2", 2)],
        &[(2, &[])],
    );
    assert_group_edited(&source, &define_group(&source), &expected, "group2", true);

    // frontmatter や markdag キーがなければ作る
    let source = "# R\n- a\n";
    let expected = format!("---\nmarkdag:\n{}---\n\n# R\n- a\n", new_groups(1));
    let result = define_group(source);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes_include(&result, &["frontmatter-added"]);
    let source = "---\ntitle: T\n---\n# R\n- a\n";
    let expected = format!("---\ntitle: T\nmarkdag:\n{}---\n# R\n- a\n", new_groups(1));
    let result = define_group(source);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["markdag-added"]);
}

#[test]
fn edit_frontmatter_define_group_rewrites_flow_style_and_a_bom_and_refuses_invalid_yaml() {
    // フロー形式は字下げの形に書き直してから足す。BOM のすぐあとが --- の行の文書は BOM を外してから足す (bom-removed)。
    // YAML の誤りは今のまま frontmatter-invalid (D-051)
    let body = "# R\n- a\n";
    let expected = format!("---\nmarkdag:\n{}---\n{body}", new_groups(1));
    for frontmatter in ["markdag: {}\n", "markdag:\n    groups: {}\n"] {
        let source = format!("---\n{frontmatter}---\n{body}");
        let result = define_group(&source);
        assert_group_edited(&source, &result, &expected, "group1", true);
        assert_notes(&result, &[]);
    }
    let source = format!("---\nmarkdag:\n    groups: \"x\n---\n{body}");
    assert_refused(&define_group(&source), "frontmatter-invalid");
    let source = "\u{feff}---\nmarkdag:\n---\n# R\n- a\n";
    let result = define_group(source);
    assert_group_edited(source, &result, &expected, "group1", true);
    assert_notes(&result, &["bom-removed"]);
}

// ---- addToGroup: あとから入れる ----

#[test]
fn edit_frontmatter_add_to_group_marks_the_selected_nodes() {
    // 定義だけのグループに、選んだノードを入れる: 1 行目の末尾に %印を付け、frontmatter は変えない。
    // select は同じノード、rename は null。1 R / 2 a / 3 b / 4 c
    let frontmatter = format!("---\nmarkdag:\n{}---\n", new_groups(1));
    let source = format!("{frontmatter}# R\n- a\n- b\n- c\n");
    let expected = format!("{frontmatter}# R\n- a %group1\n- b\n- c %group1\n");
    assert_groups(
        &expected,
        &[created("group1", 1)],
        &[(2, &["group1"]), (3, &[]), (4, &["group1"])],
    );
    let result = add_to_group(&source, "group1", &[(2, "a"), (4, "c")]);
    assert_nodes_kept(&source, &result, &expected, &[(2, "a"), (4, "c")]);
    assert_notes(&result, &[]);

    // 本文の印だけのグループ (定義がない) にも入れられ、frontmatter は変えない。1 R / 2 A / 3 a / 4 B / 5 x / 6 C / 7 y
    // 見出しは 1 行目の末尾に付け、配下は引き継ぐ
    let source = format!("{MARKDAG_ONLY}# R\n## A\n- a %g\n## B\n- x\n## C\n- y #k\n");
    let expected = format!("{MARKDAG_ONLY}# R\n## A\n- a %g\n## B %g\n- x\n## C\n- y #k\n");
    assert_groups(
        &expected,
        &[undefined("g")],
        &[(3, &["g"]), (4, &["g"]), (5, &["g"]), (7, &[])],
    );
    let result = add_to_group(&source, "g", &[(4, "B")]);
    assert_nodes_kept(&source, &result, &expected, &[(4, "B")]);
    // 印のある行は、印の並びの末尾に足す
    let expected = format!("{MARKDAG_ONLY}# R\n## A\n- a %g\n## B\n- x\n## C\n- y #k %g\n");
    assert_groups(&expected, &[undefined("g")], &[(5, &[]), (7, &["g"])]);
    let result = add_to_group(&source, "g", &[(7, "y")]);
    assert_nodes_kept(&source, &result, &expected, &[(7, "y")]);
}

#[test]
fn edit_frontmatter_add_to_group_skips_members_descendants_and_the_root() {
    // もう入っているノード (印、祖先の印、members) と、選んだノードの子孫と、ルートには付けない。
    // 付けるノードが残らなければ nothing-to-change で原文を変えない
    // 1 R / 2 a %g / 3 a1 / 4 b / 5 b1 / 6 c / 7 d (members で g)
    let frontmatter =
        "---\nmarkdag:\n    groups:\n        g:\n            members:\n                - d\n---\n";
    let source = format!("{frontmatter}# R\n- a %g\n    - a1\n- b\n    - b1\n- c\n- d\n");
    assert_groups(
        &source,
        &[defined("g", "g", None, false)],
        &[(2, &["g"]), (3, &["g"]), (4, &[]), (7, &["g"])],
    );
    for nodes in [
        &[(2, "a")][..],
        &[(3, "a1")][..],
        &[(7, "d")][..],
        &[(1, "R")][..],
        &[(1, "R"), (2, "a"), (3, "a1"), (7, "d")][..],
    ] {
        assert_reason(
            &add_to_group(&source, "g", nodes),
            "unchanged",
            "nothing-to-change",
        );
    }
    // まとめて渡すと、b と c だけに付ける (b1 は b の子孫)
    let expected = format!("{frontmatter}# R\n- a %g\n    - a1\n- b %g\n    - b1\n- c %g\n- d\n");
    assert_groups(
        &expected,
        &[defined("g", "g", None, false)],
        &[(4, &["g"]), (5, &["g"]), (6, &["g"]), (7, &["g"])],
    );
    let result = add_to_group(
        &source,
        "g",
        &[
            (1, "R"),
            (2, "a"),
            (3, "a1"),
            (4, "b"),
            (5, "b1"),
            (6, "c"),
            (7, "d"),
        ],
    );
    assert_eq!(applied(&source, &result), expected, "{result}");
    assert_eq!(result["rename"], Value::Null, "{result}");
}

#[test]
fn edit_frontmatter_add_to_group_refuses_unknown_groups_and_lineless_nodes_and_rewrites_unmarkable_headings()
 {
    // 定義にも本文の印にもないグループは group-unknown
    let source = format!("{MARKDAG_ONLY}# R\n- a %g\n- b\n");
    assert_refused(&add_to_group(&source, "h", &[(3, "b")]), "group-unknown");
    // 下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから %印を付ける (D-046)。
    // 画面は設計の配下なので印を付けない
    let source = format!("{DEFINED_G}{GROUP_UNMARKABLE}");
    let expected = format!("{DEFINED_G}# R\n\n## 設計 %g\n\n- 画面\n\n ## 実装\n");
    assert_groups(
        &expected,
        &[defined("g", "G", None, false)],
        &[(2, &["g"]), (3, &["g"]), (4, &[])],
    );
    let result = add_to_group(&source, "g", &[(3, "画面"), (2, "設計")]);
    assert_nodes_kept(&source, &result, &expected, &[(3, "画面"), (2, "設計")]);
    let expected = format!("{DEFINED_G}# R\n\n設計\n---\n\n- 画面\n\n## 実装 %g\n");
    assert_groups(&expected, &[defined("g", "G", None, false)], &[(4, &["g"])]);
    let result = add_to_group(&source, "g", &[(4, "実装")]);
    assert_nodes_kept(&source, &result, &expected, &[(4, "実装")]);
    // 印を書けないノードを含めると全体を断る: no-source-line、block-node
    let source = format!("{DEFINED_G}{GROUP_LISTS}");
    assert_refused(
        &add_to_group(&source, "g", &[(3, "a"), (5, "")]),
        "no-source-line",
    );
    let source = format!("{DEFINED_G}{GROUP_BLOCKS}");
    for id in [2, 3, 4] {
        assert_refused(&add_to_group(&source, "g", &[(id, "")]), "block-node");
    }
    // stale-node
    let source = format!("{DEFINED_G}# R\n- a\n");
    assert_refused(
        &add_to_group_unchecked(&source, "g", &[(2, "x")]),
        "stale-node",
    );
}

// ---- renameGroup: 名前の変更 ----

#[test]
fn edit_frontmatter_rename_group_rewrites_the_label() {
    // label の値の範囲だけを書き換え、行末のコメントと、ほかのキーとグループは残す。select はグループ、rename は null
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: 旧 # メモ\n            color: \"#3B7DD8\"\n        h:\n            label: H\n---\n# R\n- a %g\n- b %h\n";
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            label: 設計の範囲 # メモ\n            color: \"#3B7DD8\"\n        h:\n            label: H\n---\n# R\n- a %g\n- b %h\n";
    assert_groups(
        expected,
        &[
            defined("g", "設計の範囲", Some("#3B7DD8"), false),
            defined("h", "H", None, false),
        ],
        &[(2, &["g"]), (3, &["h"])],
    );
    let result = rename_group(source, "g", "設計の範囲");
    assert_group_edited(source, &result, expected, "g", false);
    assert_notes(&result, &[]);
}

#[test]
fn edit_frontmatter_rename_group_quotes_values_yaml_cannot_read_as_is() {
    // YAML でそのまま書けない名前は引用符で囲む。中に " があれば '…'
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    for (label, written) in [
        ("設計: 実装", "\"設計: 実装\""),
        ("#1 案", "\"#1 案\""),
        ("a # b", "\"a # b\""),
        ("- 項目", "\"- 項目\""),
        ("yes", "\"yes\""),
        ("true", "\"true\""),
        ("123", "\"123\""),
        ("\"引用\"", "'\"引用\"'"),
    ] {
        let expected = format!(
            "---\nmarkdag:\n    groups:\n        g:\n            label: {written}\n---\n# R\n- a %g\n"
        );
        assert_groups(
            &expected,
            &[defined("g", label, None, false)],
            &[(2, &["g"])],
        );
        assert_group_edited(
            &source,
            &rename_group(&source, "g", label),
            &expected,
            "g",
            false,
        );
    }
}

#[test]
fn edit_frontmatter_rename_group_adds_a_label_when_there_is_no_definition() {
    // 定義がなければ label だけの定義を足す。groups がなければ作る
    let source = format!("{MARKDAG_ONLY}# R\n- a %g\n");
    let expected =
        "---\nmarkdag:\n    groups:\n        g:\n            label: 設計\n---\n# R\n- a %g\n";
    assert_groups(
        expected,
        &[defined("g", "設計", None, false)],
        &[(2, &["g"])],
    );
    let result = rename_group(&source, "g", "設計");
    assert_group_edited(&source, &result, expected, "g", false);
    assert_notes(&result, &[]);

    // ほかのグループの定義があれば groups の末尾に足す
    let head = "---\nmarkdag:\n    groups:\n        h:\n            label: H\n";
    let source = format!("{head}---\n# R\n- a %g\n- b %h\n");
    let expected = format!("{head}        g:\n            label: 設計\n---\n# R\n- a %g\n- b %h\n");
    assert_groups(
        &expected,
        &[
            defined("h", "H", None, false),
            defined("g", "設計", None, false),
        ],
        &[(2, &["g"]), (3, &["h"])],
    );
    assert_group_edited(
        &source,
        &rename_group(&source, "g", "設計"),
        &expected,
        "g",
        false,
    );

    // 定義に label がなければ、その写像の末尾に label を足す
    let head = "---\nmarkdag:\n    groups:\n        g:\n            color: \"#3B7DD8\"\n";
    let source = format!("{head}---\n# R\n- a %g\n");
    let expected = format!("{head}            label: 設計\n---\n# R\n- a %g\n");
    assert_groups(
        &expected,
        &[defined("g", "設計", Some("#3B7DD8"), false)],
        &[(2, &["g"])],
    );
    assert_group_edited(
        &source,
        &rename_group(&source, "g", "設計"),
        &expected,
        "g",
        false,
    );
}

#[test]
fn edit_frontmatter_rename_group_refuses_empty_unknown_and_unchanged_labels_and_rewrites_flow_style()
 {
    // 空の名前は group-label-empty、ないグループは group-unknown、同じ名前は same-name で変えない
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    for label in ["", "   "] {
        assert_refused(&rename_group(&source, "g", label), "group-label-empty");
    }
    assert_refused(&rename_group(&source, "h", "設計"), "group-unknown");
    assert_reason(&rename_group(&source, "g", "G"), "unchanged", "same-name");
    // 書き換える定義がフロー形式なら、字下げの形に書き直してから書き換える (D-050)
    let expected =
        "---\nmarkdag:\n    groups:\n        g:\n            label: 設計\n---\n# R\n- a %g\n";
    assert_groups(
        expected,
        &[defined("g", "設計", None, false)],
        &[(2, &["g"])],
    );
    for frontmatter in [
        "markdag:\n    groups:\n        g: { label: G }\n",
        "markdag:\n    groups: { g: { label: G } }\n",
    ] {
        let source = format!("---\n{frontmatter}---\n# R\n- a %g\n");
        let result = rename_group(&source, "g", "設計");
        assert_group_edited(&source, &result, expected, "g", false);
        assert_notes(&result, &[]);
    }
}

#[test]
fn edit_frontmatter_rename_group_makes_a_block_scalar_label_one_line() {
    // label がブロックスカラ (| と >-) なら、組の行を 1 行の label に置き換え、あとに続く group2 の組は変えない
    let expected = "---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n        group2:\n            label: 実装\n---\n# R\n\n- a %group1\n- b %group2\n";
    assert_groups(
        expected,
        &[
            defined("group1", "設計", None, false),
            defined("group2", "実装", None, false),
        ],
        &[(2, &["group1"]), (3, &["group2"])],
    );
    let folded = BLOCK_LABEL.replace("label: |", "label: >-");
    for source in [BLOCK_LABEL, folded.as_str()] {
        assert_group_edited(
            source,
            &rename_group(source, "group1", "設計"),
            expected,
            "group1",
            false,
        );
    }
}

// ---- setGroupColor と setGroupBoundary: 色と枠の有無 ----

#[test]
fn edit_frontmatter_set_group_color_rewrites_or_adds_the_color() {
    // color の値の範囲を "#RRGGBB" で書き換え、行末のコメントは残す。select はグループ、rename は null
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: \"#3B7DD8\" # 青\n            boundary: true\n---\n# R\n- a %g\n";
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: \"#D64545\" # 青\n            boundary: true\n---\n# R\n- a %g\n";
    assert_groups(
        expected,
        &[defined("g", "G", Some("#D64545"), true)],
        &[(2, &["g"])],
    );
    let result = set_group_color(source, "g", "#D64545");
    assert_group_edited(source, &result, expected, "g", false);
    assert_notes(&result, &[]);

    // 引用符のない色の名前も "#RRGGBB" に置き換える
    let source =
        "---\nmarkdag:\n    groups:\n        g:\n            color: red\n---\n# R\n- a %g\n";
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            color: \"#D64545\"\n---\n# R\n- a %g\n";
    assert_groups(expected, &[defined("g", "g", Some("#D64545"), false)], &[]);
    assert_group_edited(
        source,
        &set_group_color(source, "g", "#D64545"),
        expected,
        "g",
        false,
    );

    // 定義に color がなければ写像の末尾に足す
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: \"#D64545\"\n---\n# R\n- a %g\n";
    assert_groups(expected, &[defined("g", "G", Some("#D64545"), false)], &[]);
    assert_group_edited(
        &source,
        &set_group_color(&source, "g", "#D64545"),
        expected,
        "g",
        false,
    );

    // 定義がなければ color だけの定義を足す
    let source = format!("{MARKDAG_ONLY}# R\n- a %g\n");
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            color: \"#D64545\"\n---\n# R\n- a %g\n";
    assert_groups(
        expected,
        &[defined("g", "g", Some("#D64545"), false)],
        &[(2, &["g"])],
    );
    assert_group_edited(
        &source,
        &set_group_color(&source, "g", "#D64545"),
        expected,
        "g",
        false,
    );
}

#[test]
fn edit_frontmatter_set_group_color_refuses_invalid_colors_and_rewrites_flow_style() {
    // 色の書き方の誤りは color-invalid、ないグループは group-unknown。定義がフロー形式なら字下げの形に書き直してから足す (D-050)
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    for color in ["", "#12345", "#GGGGGG", "青", "rgb(1, 2"] {
        assert_refused(&set_group_color(&source, "g", color), "color-invalid");
    }
    assert_refused(&set_group_color(&source, "h", "#D64545"), "group-unknown");
    let source = "---\nmarkdag:\n    groups:\n        g: { label: G }\n---\n# R\n- a %g\n";
    let expected = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: \"#D64545\"\n---\n# R\n- a %g\n";
    assert_groups(
        expected,
        &[defined("g", "G", Some("#D64545"), false)],
        &[(2, &["g"])],
    );
    assert_group_edited(
        source,
        &set_group_color(source, "g", "#D64545"),
        expected,
        "g",
        false,
    );
}

#[test]
fn edit_frontmatter_set_group_boundary_rewrites_or_adds_boundary() {
    // boundary の値を書き換える (true と false)。select はグループ、rename は null
    let frame = |boundary: &str| {
        format!(
            "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            boundary: {boundary}\n---\n# R\n- a %g\n"
        )
    };
    assert_groups(
        &frame("false"),
        &[defined("g", "G", None, false)],
        &[(2, &["g"])],
    );
    assert_groups(
        &frame("true"),
        &[defined("g", "G", None, true)],
        &[(2, &["g"])],
    );
    let result = set_group_boundary(&frame("true"), "g", false);
    assert_group_edited(&frame("true"), &result, &frame("false"), "g", false);
    assert_notes(&result, &[]);
    assert_group_edited(
        &frame("false"),
        &set_group_boundary(&frame("false"), "g", true),
        &frame("true"),
        "g",
        false,
    );

    // 定義に boundary がなければ写像の末尾に足す
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    assert_group_edited(
        &source,
        &set_group_boundary(&source, "g", true),
        &frame("true"),
        "g",
        false,
    );
    // 定義がなければ boundary だけの定義を足す
    let source = format!("{MARKDAG_ONLY}# R\n- a %g\n");
    let expected =
        "---\nmarkdag:\n    groups:\n        g:\n            boundary: true\n---\n# R\n- a %g\n";
    assert_groups(expected, &[defined("g", "g", None, true)], &[(2, &["g"])]);
    assert_group_edited(
        &source,
        &set_group_boundary(&source, "g", true),
        expected,
        "g",
        false,
    );

    // ないグループは group-unknown。定義がフロー形式なら字下げの形に書き直してから足す (D-050)
    assert_refused(&set_group_boundary(&source, "h", true), "group-unknown");
    let source = "---\nmarkdag:\n    groups:\n        g: { label: G }\n---\n# R\n- a %g\n";
    assert_group_edited(
        source,
        &set_group_boundary(source, "g", true),
        &frame("true"),
        "g",
        false,
    );
}

// ---- ungroup: グループ解除 ----

#[test]
fn edit_frontmatter_ungroup_removes_marks_and_the_definition() {
    // 全部のノードの印と定義を外し、空になった groups のキーも外す (markdag キーは残す)。ノードは残る。
    // ほかの印 (タグ、$id) は残し、印の間は空白 1 つ。選択を解く
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: \"#3B7DD8\"\n            boundary: true\n---\n# R\n- a %g\n    - a1\n- b #k %g $x\n- c\n";
    let expected = "---\nmarkdag:\n---\n# R\n- a\n    - a1\n- b #k $x\n- c\n";
    assert_groups(expected, &[], &[(2, &[]), (3, &[]), (4, &[])]);
    let result = ungroup(source, "g");
    assert_ungrouped(source, &result, expected);
    assert_notes(&result, &[]);

    // ほかのグループの定義と印は残る。groups のキーも残る。印が 2 つの行は外したグループの印だけを外す
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n        h:\n            label: H\n---\n# R\n- a %g %h\n- b %h\n";
    let expected =
        "---\nmarkdag:\n    groups:\n        h:\n            label: H\n---\n# R\n- a %h\n- b %h\n";
    assert_groups(
        expected,
        &[defined("h", "H", None, false)],
        &[(2, &["h"]), (3, &["h"])],
    );
    assert_ungrouped(source, &ungroup(source, "g"), expected);
    let expected =
        "---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n# R\n- a %g\n- b\n";
    assert_groups(
        expected,
        &[defined("g", "G", None, false)],
        &[(2, &["g"]), (3, &[])],
    );
    assert_ungrouped(source, &ungroup(source, "h"), expected);

    // markdag のほかのキーは残る
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n    edgeHighlight: true\n---\n# R\n## A %g\n- x\n";
    let expected = "---\nmarkdag:\n    edgeHighlight: true\n---\n# R\n## A\n- x\n";
    assert_groups(expected, &[], &[(2, &[]), (3, &[])]);
    assert_ungrouped(source, &ungroup(source, "g"), expected);
}

#[test]
fn edit_frontmatter_ungroup_handles_marks_only_and_definitions_only() {
    // 本文の印だけのグループは印だけを外す (frontmatter は変えない)
    let source = format!("{MARKDAG_ONLY}# R\n- a %g\n- b %g\n");
    let expected = format!("{MARKDAG_ONLY}# R\n- a\n- b\n");
    assert_groups(&expected, &[], &[(2, &[]), (3, &[])]);
    assert_ungrouped(&source, &ungroup(&source, "g"), &expected);

    // 定義だけのグループ (members を含む) は定義の組を外す。members のノードは残る
    let source = "---\nmarkdag:\n    groups:\n        g:\n            label: G\n            members:\n                - a\n---\n# R\n- a\n- b\n";
    let expected = "---\nmarkdag:\n---\n# R\n- a\n- b\n";
    assert_groups(source, &[defined("g", "G", None, false)], &[(2, &["g"])]);
    assert_ungrouped(source, &ungroup(source, "g"), expected);

    // CRLF の文書
    let source = "---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n---\r\n# R\r\n- a %g\r\n- b\r\n";
    let expected = "---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n";
    assert_groups(expected, &[], &[(2, &[])]);
    assert_ungrouped(source, &ungroup(source, "g"), expected);
}

#[test]
fn edit_frontmatter_ungroup_keeps_the_next_definition_after_a_block_scalar_label() {
    // label をブロックスカラで書いたグループを解除しても、あとに続く group2 の定義が残る
    let expected = "---\nmarkdag:\n    groups:\n        group2:\n            label: 実装\n---\n# R\n\n- a\n- b %group2\n";
    assert_groups(
        expected,
        &[defined("group2", "実装", None, false)],
        &[(2, &[]), (3, &["group2"])],
    );
    assert_ungrouped(BLOCK_LABEL, &ungroup(BLOCK_LABEL, "group1"), expected);
}

#[test]
fn edit_frontmatter_ungroup_refuses_unknown_groups_and_rewrites_flow_style_definitions() {
    // ないグループは group-unknown。外す定義がフロー形式でも、印と定義を外す (空になった groups のキーも外す。細部 21。D-053)
    let source = format!("{DEFINED_G}# R\n- a %g\n");
    assert_refused(&ungroup(&source, "h"), "group-unknown");
    let expected = "---\nmarkdag:\n---\n# R\n- a\n";
    assert_groups(expected, &[], &[(2, &[])]);
    for frontmatter in [
        "markdag:\n    groups:\n        g: { label: G }\n",
        "markdag:\n    groups: { g: { label: G } }\n",
    ] {
        let source = format!("---\n{frontmatter}---\n# R\n- a %g\n");
        let result = ungroup(&source, "g");
        assert_ungrouped(&source, &result, expected);
        assert_notes(&result, &[]);
    }
}

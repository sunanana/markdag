// 最後の関門で決まった解析の読み方 (records/final-apply/plan.md の 5、9、10) を、直す前に落ちるテストとして書く。
// 1. リストの入れ物と最初の項目が 1 行目を分け合うとき、その行の末尾の印 (%グループ、#タグ、$id) は最初の項目だけのもの (B-107 / B-135)
// 2. タグのキーを " で囲む書き方、囲んだ値を , で並べる、囲みの中の \" と \\ の逃がし、tags.keys の数字のキー、
//    タグを文字に戻す format_tag の囲み方 (B-134、細部 13、14)
// 3. 見出しの行のあと、空行だけをはさんで続く引用を、その見出しの詳細にする (細部 15、17)
// 変えない挙動 (今も通り、直したあとも通るもの) も、読み方の境目として同じ所に置く。それぞれの注に「変えない」と書いた。
// 公開の parse_document、build_model、format_tag だけを使う。
// 関数名は `cargo test -p markdag-core parse_` で選ばれるよう parse_ で始める。
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::tags::format_tag;
use markdag_core::parse::parse_document;
use markdag_core::types::{GraphModel, NodeTag, OutlineNode, SourcePosition};

// markdag キーだけの frontmatter (印と詳細を読む文書)
const MD: &str = "---\nmarkdag:\n---\n";

fn nodes_of(source: &str) -> Vec<OutlineNode> {
    parse_document(source).nodes
}

fn node_of(source: &str, id: u32) -> OutlineNode {
    nodes_of(source)
        .into_iter()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("id {id} のノードがある: {source:?}"))
}

fn node_named(source: &str, ref_text: &str) -> OutlineNode {
    nodes_of(source)
        .into_iter()
        .find(|node| node.ref_text == ref_text)
        .unwrap_or_else(|| panic!("{ref_text:?} のノードがある: {source:?}"))
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

// タグのキーと値 (位置は見ない)
fn tags_of(node: &OutlineNode) -> Vec<(String, Vec<String>)> {
    node.tags
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

fn no_tags() -> Vec<(String, Vec<String>)> {
    Vec::new()
}

// 項目 1 つの文書 `{MD}# R\n- a {marks}\n` の a (id 2) のタグ
fn item_tags(marks: &str) -> Vec<(String, Vec<String>)> {
    let source = format!("{MD}# R\n- a {marks}\n");
    let node = node_of(&source, 2);
    tags_of(&node)
}

// 項目 1 つの文書の a (id 2) の名前 (印にならなかった字は名前に残る)
fn item_name(marks: &str) -> String {
    let source = format!("{MD}# R\n- a {marks}\n");
    node_of(&source, 2).ref_text
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

// 詳細の 1 つの段落: 原文で `line` と同じ行 (0 始まりの行の添字) の段落を、項目の詳細と同じ形 (data-lines を持つ p) で書いたもの
fn quote_paragraph(source: &str, line: &str, inner: &str) -> String {
    let index = source
        .split('\n')
        .position(|item| item == line)
        .unwrap_or_else(|| panic!("{line:?} の行がある: {source:?}"));
    format!("<p data-lines=\"{index},{}\">{inner}</p>", index + 1)
}

// ==== 1. リストの入れ物と最初の項目が分け合う行の印は、最初の項目だけのもの (B-107 / B-135) ====

// リストだけの文書: 1 入れ物 (ルート) / 2 設計 / 3 実装 / 4 テスト
fn list_only(first_marks: &str) -> String {
    format!("{MD}- 設計 {first_marks}\n- 実装\n- テスト\n")
}

#[test]
fn parse_list_only_first_item_group_mark_belongs_only_to_the_first_item() {
    let source = list_only("%画面班");
    assert_eq!(node_of(&source, 2).ref_text, "設計", "{source:?}");
    assert_eq!(
        node_of(&source, 1).groups,
        Vec::<String>::new(),
        "入れ物: {source:?}"
    );
    assert_eq!(
        node_of(&source, 2).groups,
        vec!["画面班".to_string()],
        "設計: {source:?}"
    );
}

#[test]
fn parse_list_only_first_item_tag_belongs_only_to_the_first_item() {
    let source = list_only("#担当:山田");
    assert_eq!(
        tags_of(&node_of(&source, 1)),
        no_tags(),
        "入れ物: {source:?}"
    );
    assert_eq!(
        tags_of(&node_of(&source, 2)),
        vec![tag("担当", &["山田"])],
        "設計: {source:?}"
    );
}

#[test]
fn parse_list_only_first_item_ref_id_belongs_only_to_the_first_item() {
    let source = list_only("$design");
    assert_eq!(node_of(&source, 1).ref_id, None, "入れ物: {source:?}");
    assert_eq!(
        node_of(&source, 2).ref_id,
        Some("design".to_string()),
        "設計: {source:?}"
    );
}

#[test]
fn parse_lists_under_a_heading_first_item_marks_belong_only_to_the_first_item() {
    // 見出しの下にリストが 2 つ: 1 R / 2 入れ物 / 3 a / 4 b / 5 番号の入れ物 / 6「1. c」/ 7「2. d」
    let source = format!("{MD}# R\n\n- a %g $x\n- b\n\n1. c #k:v\n2. d\n");
    let container = node_of(&source, 2);
    let first = node_of(&source, 3);
    assert_eq!(first.ref_text, "a", "{source:?}");
    assert_eq!(
        (container.groups, container.ref_id),
        (Vec::<String>::new(), None),
        "入れ物: {source:?}"
    );
    assert_eq!(
        (first.groups, first.ref_id),
        (vec!["g".to_string()], Some("x".to_string())),
        "a: {source:?}"
    );
    let ordered = node_of(&source, 5);
    let step = node_of(&source, 6);
    assert_eq!(step.ref_text, "1. c", "{source:?}");
    assert_eq!(tags_of(&ordered), no_tags(), "番号の入れ物: {source:?}");
    assert_eq!(tags_of(&step), vec![tag("k", &["v"])], "1. c: {source:?}");
}

#[test]
fn parse_list_only_first_item_group_does_not_spread_to_the_list() {
    // グループは配下に引き継がれるので、最初の項目の子は入り、2 つ目からの項目と入れ物は入らない
    let source = "---\nmarkdag:\n    groups:\n        画面班:\n            label: 画面班\n---\n- 設計 %画面班\n    - 画面\n- 実装\n- テスト\n";
    let model = model_of(source);
    let groups = |id: u32| model.groups_of.get(&id).cloned().unwrap_or_default();
    assert_eq!(node_of(source, 3).ref_text, "画面", "{source:?}");
    assert_eq!(groups(1), Vec::<String>::new(), "入れ物");
    assert_eq!(groups(2), vec!["画面班".to_string()], "設計");
    assert_eq!(groups(3), vec!["画面班".to_string()], "画面 (設計の子)");
    assert_eq!(groups(4), Vec::<String>::new(), "実装");
    assert_eq!(groups(5), Vec::<String>::new(), "テスト");
}

#[test]
fn parse_list_only_container_keeps_its_lines_from_the_first_item() {
    // 変えない: 入れ物の lines は最初の項目の行から始まり、名前と内容は空のまま
    let source = list_only("%画面班 #担当:山田 $design");
    let container = node_of(&source, 1);
    let first = node_of(&source, 2);
    assert_eq!(
        container.lines.as_ref().map(|lines| lines.start),
        first.lines.as_ref().map(|lines| lines.start),
        "{source:?}"
    );
    assert_eq!(
        (container.ref_text.as_str(), container.html.as_str()),
        ("", ""),
        "{source:?}"
    );
}

// ==== 2. タグのキーを " で囲む、囲んだ値を , で並べる、囲みの中の逃がし (B-134、細部 14) ====

#[test]
fn parse_tag_quoted_key_without_value() {
    assert_eq!(item_tags(r#"#"s.a""#), vec![tag("s.a", &[])]);
    assert_eq!(item_name(r#"#"s.a""#), "a");
}

#[test]
fn parse_tag_quoted_key_with_plain_value() {
    assert_eq!(item_tags(r#"#"s.a":x"#), vec![tag("s.a", &["x"])]);
}

#[test]
fn parse_tag_quoted_key_with_quoted_value() {
    assert_eq!(item_tags(r#"#"s.a":"x y""#), vec![tag("s.a", &["x y"])]);
}

#[test]
fn parse_tag_quoted_key_keeps_spaces_including_ideographic_space() {
    assert_eq!(item_tags(r#"#"a b""#), vec![tag("a b", &[])]);
    assert_eq!(item_tags("#\"a\u{3000}b\""), vec![tag("a\u{3000}b", &[])]);
}

#[test]
fn parse_tag_quoted_key_splits_at_the_first_colon_outside_the_quotes() {
    assert_eq!(item_tags(r#"#"a:b":c"#), vec![tag("a:b", &["c"])]);
}

#[test]
fn parse_tag_quoted_digits_only_key() {
    assert_eq!(item_tags(r#"#"123""#), vec![tag("123", &[])]);
    assert_eq!(item_tags(r#"#"123":x"#), vec![tag("123", &["x"])]);
}

#[test]
fn parse_tag_unquoted_digits_only_key_stays_text() {
    // 変えない: 囲まない #123 は印にしない (名前に残る)
    assert_eq!(item_tags("#123"), no_tags());
    assert_eq!(item_name("#123"), "a #123");
}

#[test]
fn parse_tag_quoted_key_reads_mark_characters_as_plain_characters() {
    for key in ["a,b", "%x", "#x", "$x"] {
        let mark = format!("#\"{key}\"");
        assert_eq!(item_tags(&mark), vec![tag(key, &[])], "{mark}");
        assert_eq!(item_name(&mark), "a", "{mark}");
    }
}

#[test]
fn parse_tag_quoted_and_unquoted_keys_are_the_same_key() {
    // 同じキーの値は 1 つにつなぐ (merge_tags。囲みのありなしで扱いを変えない)
    assert_eq!(
        item_tags(r#"#"owner":x #owner:y"#),
        vec![tag("owner", &["x", "y"])]
    );
    assert_eq!(
        item_tags(r#"#owner:x #"owner":y"#),
        vec![tag("owner", &["x", "y"])]
    );
}

#[test]
fn parse_tag_empty_quoted_key_stays_text() {
    // 変えない: #"" (空のキー) は印にしない
    assert_eq!(item_tags(r#"#"""#), no_tags());
    assert_eq!(item_name(r#"#"""#), r#"a #"""#);
}

#[test]
fn parse_tag_quoted_value_after_plain_value_in_a_list() {
    assert_eq!(
        item_tags(r#"#owner:alice,"山田 太郎""#),
        vec![tag("owner", &["alice", "山田 太郎"])]
    );
}

#[test]
fn parse_tag_plain_value_after_quoted_value_in_a_list() {
    assert_eq!(
        item_tags(r#"#owner:"山田 太郎",alice"#),
        vec![tag("owner", &["山田 太郎", "alice"])]
    );
}

#[test]
fn parse_tag_comma_inside_quoted_value_does_not_split() {
    assert_eq!(item_tags(r#"#k:"a,b",c"#), vec![tag("k", &["a,b", "c"])]);
}

#[test]
fn parse_tag_escaped_quote_in_quoted_value() {
    assert_eq!(
        item_tags(r#"#note:"say \"hi\"""#),
        vec![tag("note", &[r#"say "hi""#])]
    );
}

#[test]
fn parse_tag_escaped_backslash_in_quoted_value() {
    assert_eq!(item_tags(r#"#k:"a\\b""#), vec![tag("k", &[r"a\b"])]);
    // 囲みの終わりの直前の \\ も 1 字の \ (閉じの " を逃がさない)
    assert_eq!(item_tags(r#"#k:"a\\""#), vec![tag("k", &[r"a\"])]);
}

#[test]
fn parse_tag_other_backslash_in_quotes_stays_two_characters() {
    assert_eq!(item_tags(r#"#k:"a\xb""#), vec![tag("k", &[r"a\xb"])]);
    assert_eq!(item_tags(r#"#"a\xb""#), vec![tag(r"a\xb", &[])]);
}

#[test]
fn parse_tag_escaped_quote_and_backslash_in_quoted_key() {
    assert_eq!(item_tags(r#"#"a\"b""#), vec![tag(r#"a"b"#, &[])]);
    assert_eq!(item_tags(r#"#"a\\b""#), vec![tag(r"a\b", &[])]);
}

#[test]
fn parse_tag_backslash_in_unquoted_value_is_not_an_escape() {
    // 変えない: 囲まない値の \ は逃がしにしない
    assert_eq!(item_tags(r"#k:a\b"), vec![tag("k", &[r"a\b"])]);
    assert_eq!(item_tags(r"#k:a\\b"), vec![tag("k", &[r"a\\b"])]);
}

#[test]
fn parse_tag_unclosed_quote_stays_text() {
    assert_eq!(item_tags(r#"#"a"#), no_tags());
    assert_eq!(item_tags(r#"#k:"a"#), no_tags());
    // \" は逃がした " なので、囲みは閉じていない
    assert_eq!(item_tags(r#"#k:"a\""#), no_tags());
    assert_eq!(item_tags(r#"#"a\""#), no_tags());
}

#[test]
fn parse_tag_escaped_hash_before_quoted_key_stays_text() {
    // 変えない: \# は逃がしで文字 (名前に # が残る)
    assert_eq!(item_tags(r#"\#"s.a""#), no_tags());
    assert_eq!(item_name(r#"\#"s.a""#), r#"a #"s.a""#);
}

#[test]
fn parse_tag_quoted_key_on_a_heading() {
    let source = format!("{MD}# R\n\n## 設計 #\"s.a\":x\n");
    let heading = node_of(&source, 2);
    assert_eq!(heading.ref_text, "設計", "{source:?}");
    assert_eq!(tags_of(&heading), vec![tag("s.a", &["x"])], "{source:?}");
}

#[test]
fn parse_tag_quoted_key_with_group_and_ref_id_marks() {
    let source = format!("{MD}# R\n- a #\"s.a\" %g $d\n");
    let item = node_of(&source, 2);
    assert_eq!(item.ref_text, "a", "{source:?}");
    assert_eq!(tags_of(&item), vec![tag("s.a", &[])], "{source:?}");
    assert_eq!(item.groups, vec!["g".to_string()], "{source:?}");
    assert_eq!(item.ref_id, Some("d".to_string()), "{source:?}");
}

#[test]
fn parse_tag_quoted_key_position_covers_the_whole_mark() {
    // 印の位置は # から印の終わりまで (囲みの " を含む)。行は 1 始まり、桁と長さは文字で数える
    let source = format!("{MD}# R\n- a #\"s.a\":x\n");
    let item = node_of(&source, 2);
    let at: Vec<(u32, u32, u32)> = item
        .tags
        .iter()
        .map(|tag| (tag.at.line, tag.at.column, tag.at.length))
        .collect();
    assert_eq!(at, vec![(5, 5, 8)], "{source:?}");
}

// ---- tags.keys の数字のキー ----

#[test]
fn parse_tag_keys_digits_only_yaml_key_is_the_string_key() {
    // 変えない: 囲まない 123: も "123": も文字のキー「123」
    for key in ["123", "\"123\""] {
        let source = format!(
            "---\nmarkdag:\n    tags:\n        keys:\n            {key}:\n                type: string\n---\n# R\n- a\n"
        );
        let keys: Vec<String> = model_of(&source)
            .tag_keys
            .iter()
            .map(|def| def.key.clone())
            .collect();
        assert_eq!(keys, vec!["123".to_string()], "{source:?}");
    }
}

#[test]
fn parse_tag_keys_digits_only_key_is_known_to_the_quoted_tag() {
    for key in ["123", "\"123\""] {
        let source = format!(
            "---\nmarkdag:\n    tags:\n        unknownKey: deny\n        keys:\n            {key}:\n                type: string\n---\n# R\n- a #\"123\":x\n"
        );
        let model = model_of(&source);
        let tags: Vec<(String, Vec<String>)> = model
            .tags_of
            .get(&2)
            .map(|tags| {
                tags.iter()
                    .map(|tag| (tag.key.clone(), tag.values.clone()))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(tags, vec![tag("123", &["x"])], "{source:?}");
        let codes: Vec<&str> = model
            .diagnostics
            .iter()
            .map(|item| item.code.as_str())
            .collect();
        assert!(!codes.contains(&"tag-unknown-key"), "{source:?}: {codes:?}");
    }
}

// 診断 1 つの code、位置 (行、桁、長さ)、文
type DiagnosticRow = (String, Option<(u32, u32, u32)>, String);

#[test]
fn parse_tag_keys_type_checks_the_quoted_digits_only_tag() {
    let source = "---\nmarkdag:\n    tags:\n        keys:\n            123:\n                type: number\n---\n# R\n- a #\"123\":abc\n";
    let model = model_of(source);
    let found: Vec<DiagnosticRow> = model
        .diagnostics
        .iter()
        .filter(|item| item.code == "tag-type")
        .map(|item| {
            (
                item.code.clone(),
                item.at.as_ref().map(|at| (at.line, at.column, at.length)),
                item.message.clone(),
            )
        })
        .collect();
    assert_eq!(found.len(), 1, "{source:?}: {:?}", model.diagnostics);
    assert_eq!(found[0].1, Some((9, 5, 10)), "{found:?}");
    // 診断の文の中のタグも、書き出しの規則で囲んだ形
    assert!(found[0].2.contains(r#"#"123":abc"#), "{found:?}");
}

// ---- タグを文字に戻す (format_tag。細部 13) ----

#[test]
fn parse_format_tag_quotes_keys_with_characters_outside_the_key_characters() {
    for (key, expected) in [
        ("s.a", r#"#"s.a""#),
        ("a b", r#"#"a b""#),
        ("a\u{3000}b", "#\"a\u{3000}b\""),
        ("a:b", r#"#"a:b""#),
        ("a,b", r#"#"a,b""#),
        ("%x", r#"#"%x""#),
        ("#x", r##"#"#x""##),
        ("$x", r#"#"$x""#),
    ] {
        assert_eq!(format_tag(&node_tag(key, &[])), expected, "{key:?}");
    }
    assert_eq!(format_tag(&node_tag("s.a", &["x"])), r#"#"s.a":x"#);
}

#[test]
fn parse_format_tag_quotes_digits_only_keys() {
    assert_eq!(format_tag(&node_tag("123", &[])), r#"#"123""#);
    assert_eq!(format_tag(&node_tag("123", &["x"])), r#"#"123":x"#);
}

#[test]
fn parse_format_tag_does_not_quote_plain_keys() {
    // 文字、数字、_、- だけで数字だけでないキーは囲まない。全角数字だけのキーは解析が印に読むので囲まない
    for key in ["owner", "担当", "a_b-c", "a1", "１２３"] {
        assert_eq!(
            format_tag(&node_tag(key, &[])),
            format!("#{key}"),
            "{key:?}"
        );
        assert_eq!(
            format_tag(&node_tag(key, &["v"])),
            format!("#{key}:v"),
            "{key:?}"
        );
    }
}

#[test]
fn parse_format_tag_escapes_quote_and_backslash_in_keys() {
    assert_eq!(format_tag(&node_tag(r#"a"b"#, &[])), r#"#"a\"b""#);
    assert_eq!(format_tag(&node_tag(r"a\b", &[])), r#"#"a\\b""#);
}

#[test]
fn parse_format_tag_quotes_values_with_backslash() {
    assert_eq!(format_tag(&node_tag("k", &[r"a\b"])), r#"#k:"a\\b""#);
}

#[test]
fn parse_format_tag_escapes_quote_and_backslash_in_values() {
    assert_eq!(
        format_tag(&node_tag("note", &[r#"say "hi""#])),
        r#"#note:"say \"hi\"""#
    );
    assert_eq!(format_tag(&node_tag("k", &[r#"a\"b"#])), r#"#k:"a\\\"b""#);
}

#[test]
fn parse_format_tag_keeps_plain_values_unquoted() {
    // 変えない: 要らない所では囲まない
    assert_eq!(format_tag(&node_tag("owner", &["alice"])), "#owner:alice");
    assert_eq!(
        format_tag(&node_tag("owner", &["alice", "山田 太郎"])),
        r#"#owner:alice,"山田 太郎""#
    );
}

#[test]
fn parse_format_tag_round_trips_through_the_parser() {
    // 書き出した形を項目の 1 行目に書いて解析し直すと、同じキーと値に読まれる
    let tags: Vec<(&str, Vec<&str>)> = vec![
        ("s.a", vec![]),
        ("s.a", vec!["x y"]),
        ("a b", vec!["v"]),
        ("a:b", vec!["c"]),
        ("123", vec!["x"]),
        ("a,b", vec![]),
        (r#"a"b"#, vec![]),
        (r"a\b", vec![]),
        ("note", vec![r#"say "hi""#]),
        ("k", vec![r"a\b"]),
        ("k", vec![r"a\"]),
        ("owner", vec!["alice", "山田 太郎", "a,b"]),
    ];
    let mut failures: Vec<String> = Vec::new();
    for (key, values) in &tags {
        let mark = format_tag(&node_tag(key, values));
        let read = item_tags(&mark);
        if read != vec![tag(key, values)] {
            failures.push(format!("{key:?} {values:?} → {mark} → {read:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ==== 3. 見出しの詳細 (細部 15、17) ====

#[test]
fn parse_heading_details_quote_right_below_the_heading() {
    let source = format!("{MD}# R\n\n## 設計\n> 詳細\n\n- 子\n");
    let heading = node_named(&source, "設計");
    assert_eq!(
        heading.details,
        Some(quote_paragraph(&source, "> 詳細", "詳細")),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_quote_after_blank_lines() {
    let source = format!("{MD}# R\n\n## 設計\n\n\n> 詳細\n\n- 子\n");
    let heading = node_named(&source, "設計");
    assert_eq!(
        heading.details,
        Some(quote_paragraph(&source, "> 詳細", "詳細")),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_marks_the_quote_in_html_and_keeps_the_name() {
    let source = format!("{MD}# R\n\n## 設計\n\n> 詳細\n");
    let heading = node_named(&source, "設計");
    assert!(
        heading.html.contains("class=\"mdag-details\""),
        "{source:?}: {}",
        heading.html
    );
    assert!(
        heading.html.starts_with("設計"),
        "{source:?}: {}",
        heading.html
    );
}

#[test]
fn parse_heading_details_joins_consecutive_quotes() {
    let source = format!("{MD}# R\n\n## 設計\n\n> 一つ目\n\n> 二つ目\n");
    let heading = node_named(&source, "設計");
    let expected = format!(
        "{}\n{}",
        quote_paragraph(&source, "> 一つ目", "一つ目"),
        quote_paragraph(&source, "> 二つ目", "二つ目")
    );
    assert_eq!(heading.details, Some(expected), "{source:?}");
}

#[test]
fn parse_heading_details_on_the_root_heading() {
    let source = format!("{MD}# R\n\n> 全体の詳細\n\n- a\n");
    let root = node_of(&source, 1);
    assert_eq!(root.ref_text, "R", "{source:?}");
    assert_eq!(
        root.details,
        Some(quote_paragraph(&source, "> 全体の詳細", "全体の詳細")),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_on_a_setext_heading() {
    let source = format!("{MD}# R\n\n設計\n----\n\n> 詳細\n");
    let heading = node_named(&source, "設計");
    assert_eq!(
        heading.details,
        Some(quote_paragraph(&source, "> 詳細", "詳細")),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_keep_the_heading_lines_on_the_heading_line() {
    // 変えない: 見出しの lines は見出しの行だけ (詳細の行まで広げない。細部 17)
    let source = format!("{MD}# R\n\n## 設計\n\n> 詳細\n");
    let heading = node_named(&source, "設計");
    let line = source
        .split('\n')
        .position(|item| item == "## 設計")
        .expect("見出しの行");
    assert_eq!(
        heading.lines.map(|lines| (lines.start, lines.end)),
        Some((line as u32, line as u32 + 1)),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_do_not_change_the_children() {
    // 変えない: 見出しの下のリストの項目は見出しの子のままで、見出しの詳細を持たない
    let source = format!("{MD}# R\n\n## 設計\n\n> 詳細\n\n- 子\n");
    let heading = node_named(&source, "設計");
    let child = node_named(&source, "子");
    assert_eq!(child.parent, Some(heading.id), "{source:?}");
    assert_eq!(child.details, None, "{source:?}");
}

#[test]
fn parse_heading_details_go_to_the_nearest_heading_above() {
    // 見出しのすぐ下が別の見出しなら、引用はあとの見出しの詳細 (前の見出しの詳細にしない)
    let source = format!("{MD}# R\n\n## 設計\n\n### 画面\n\n> 引用\n");
    assert_eq!(node_named(&source, "設計").details, None, "{source:?}");
    assert_eq!(
        node_named(&source, "画面").details,
        Some(quote_paragraph(&source, "> 引用", "引用")),
        "{source:?}"
    );
}

#[test]
fn parse_heading_details_stop_at_a_paragraph_between_quotes() {
    // 段落のあとの引用は詳細にしない (前の引用だけが詳細)
    let source = format!("{MD}# R\n\n## 設計\n\n> 一つ目\n\n段落\n\n> 二つ目\n");
    assert_eq!(
        node_named(&source, "設計").details,
        Some(quote_paragraph(&source, "> 一つ目", "一つ目")),
        "{source:?}"
    );
}

// 見出しの下で先に来るもの。どれのあとの引用も詳細にしない (変えない: 今も引用は捨てる)
const BEFORE_QUOTE: [(&str, &str); 7] = [
    ("段落", "段落\n"),
    ("リスト", "- 子\n"),
    ("表", "| a |\n| - |\n| 1 |\n"),
    ("コード", "~~~\ncode\n~~~\n"),
    ("HTML のブロック", "<div>html</div>\n"),
    ("コメントだけの行", "<!-- メモ -->\n"),
    ("区切り線", "***\n"),
];

#[test]
fn parse_heading_details_not_after_other_blocks() {
    for (name, block) in BEFORE_QUOTE {
        let source = format!("{MD}# R\n\n## 設計\n\n{block}\n> 引用\n");
        let heading = node_named(&source, "設計");
        assert_eq!(heading.details, None, "{name}: {source:?}");
        assert!(
            !heading.html.contains("引用"),
            "{name}: {source:?}: {}",
            heading.html
        );
    }
}

#[test]
fn parse_heading_paragraph_is_still_not_read() {
    // 変えない: 見出しの下の段落は見出しの内容に入れない
    let source = format!("{MD}# R\n\n## 設計\n\n段落\n");
    let heading = node_named(&source, "設計");
    assert_eq!(heading.html, "設計", "{source:?}");
    assert_eq!(heading.details, None, "{source:?}");
}

#[test]
fn parse_heading_details_not_read_without_the_markdag_key() {
    // 変えない: markdag キーのない文書は項目と同じく詳細を読まない
    let source = "# R\n\n## 設計\n\n> 詳細\n";
    assert_eq!(node_named(source, "設計").details, None, "{source:?}");
}

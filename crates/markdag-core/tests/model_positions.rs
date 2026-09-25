// 原文: test/model.test.ts の describe('診断が指す frontmatter での位置') (2026-09-24)。
// buildModel に原文を渡したとき、診断が frontmatter の書かれた場所 (行、桁、長さ) を指すことを、同じ入力と同じ期待値で見る。
// 関数名は `cargo test -p markdag-core model` で選ばれるよう model_ で始める。
mod common;

use common::{build_with, codes, leaf, outline, position};
use markdag_core::types::{GraphModel, OutlineNode, SourcePosition};
use serde_json::json;

// 原文の doc: frontmatter の行のあとに閉じと本文の見出しを足す
fn doc(lines: &[&str]) -> String {
    let mut all: Vec<&str> = lines.to_vec();
    all.extend(["---", "", "# root"]);
    all.join("\n")
}

fn places(model: &GraphModel) -> Vec<Option<SourcePosition>> {
    model
        .diagnostics
        .iter()
        .map(|item| item.at.clone())
        .collect()
}

fn at(line: u32, column: u32, length: u32) -> Option<SourcePosition> {
    Some(position(line, column, length))
}

fn nodes_of(names: &[&'static str]) -> Vec<OutlineNode> {
    let mut rows = vec![leaf("root", None)];
    rows.extend(names.iter().map(|name| leaf(name, Some(0))));
    outline(rows)
}

// 原文: 一覧の項目は添字で見分けるので、同じ式が別の行にも含まれるときに行を取り違えない
#[test]
fn model_position_list_item_is_found_by_index() {
    let nodes = nodes_of(&["X", "A", "B"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - X --> A --> B",
        "            - A --> B",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["X --> A --> B", "A --> B"] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["duplicate-edge"]);
    // 「A --> B」は 5 行目にも含まれるが、指すのは 2 個目の項目が書かれた 6 行目
    assert_eq!(places(&model), [at(6, 21, 1)]);
}

// 原文: 桁は文字数で数えるので、絵文字のある行でもずれない。引用符の内側の語も指せる
#[test]
fn model_position_counts_columns_in_characters() {
    let nodes = nodes_of(&["🎨設計"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - \"🎨設計 --> 実装\"",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["🎨設計 --> 実装"] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["ref-not-found"]);
    assert_eq!(places(&model), [at(5, 24, 2)]);
}

// 原文: 式の全体を指すときは、書かれたまま引用符も含めて指す
#[test]
fn model_position_whole_expression_includes_quotes() {
    let nodes = nodes_of(&["A", "B"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - \"A -> B\"",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["A -> B"] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["relation-syntax"]);
    assert_eq!(places(&model), [at(5, 15, 8)]);
}

// 原文: # がコメントになって値が空になった行は、キーから行末までを指す
#[test]
fn model_position_comment_emptied_value_points_from_key_to_line_end() {
    let nodes = nodes_of(&["A", "B"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        fork: #A --> B",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "fork": null } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["relation-not-string"]);
    assert_eq!(places(&model), [at(4, 9, 14)]);
}

// 原文: ならびの項目が空になった行は、その項目の位置から行末までを指す
#[test]
fn model_position_empty_list_item_points_from_item_to_line_end() {
    let nodes = nodes_of(&[]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    legend:",
        "        display:",
        "            - groups",
        "            - #branches",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "legend": { "display": ["groups", null] } } }),
        Some(&markdown),
    );
    assert_eq!(
        serde_json::to_value(&model.legend).expect("legend"),
        json!(["groups"])
    );
    assert_eq!(places(&model), [at(6, 15, 9)]);
}

// 原文: 文字列でない項目にも位置が付く
#[test]
fn model_position_non_string_item_has_position() {
    let nodes = nodes_of(&[]);
    let markdown = doc(&["---", "markdag:", "    branches:", "        - 3"]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "branches": [3] } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["option-invalid"]);
    assert_eq!(places(&model), [at(4, 11, 1)]);
}

// 原文: ならびの項目が写像やならびでも、親のキーではなくその項目の行を指す
#[test]
fn model_position_mapping_item_points_at_its_line() {
    let nodes = nodes_of(&["A", "B"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - A --> B",
        "            - A: B",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["A --> B", { "A": "B" }] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["relation-not-string"]);
    assert_eq!(places(&model), [at(6, 15, 4)]);
}

// 原文: ならびの項目に何も書かれていない行は、その行の「-」を指す
#[test]
fn model_position_bare_dash_points_at_dash() {
    let nodes = nodes_of(&["A"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    branches:",
        "        - A",
        "        -",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "branches": ["A", null] } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["option-invalid"]);
    assert_eq!(places(&model), [at(5, 9, 1)]);
}

// 原文: 折り返しのスカラは、記号の行ではなく中身の行を指す
#[test]
fn model_position_block_scalar_points_at_content_line() {
    let nodes = nodes_of(&[]);
    let markdown = doc(&["---", "markdag:", "    details: |-", "        always"]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "details": "always" } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["option-invalid"]);
    assert_eq!(places(&model), [at(4, 9, 6)]);
}

// 原文: 空の項目は、スキーマと参照の解決で二重に報告しない
#[test]
fn model_position_empty_item_is_reported_once() {
    let nodes = nodes_of(&[]);
    let markdown = doc(&["---", "markdag:", "    branches:", "        - \"\""]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "branches": [""] } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["option-invalid"]);
    assert_eq!(places(&model), [at(4, 11, 2)]);
}

// 原文: 入れ子の同じ名前のキーを取り違えない
#[test]
fn model_position_nested_same_key_is_not_confused() {
    let nodes = nodes_of(&[]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    groups:",
        "        design:",
        "            label: 設計",
        "    label: x",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "groups": { "design": { "label": "設計" } }, "label": "x" } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["option-unknown"]);
    assert_eq!(places(&model), [at(6, 5, 5)]);
}

// 原文: 複数行のスカラでも、語が書かれた行を指す
#[test]
fn model_position_multiline_scalar_points_at_word_line() {
    let nodes = nodes_of(&["開発", "リリース"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - >-",
        "              開発 -->",
        "              リリーズ",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["開発 --> リリーズ"] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["ref-not-found"]);
    assert_eq!(places(&model), [at(7, 15, 4)]);
}

// 原文: 本文の中に --- があっても、最初の閉じまでを frontmatter として数える
#[test]
fn model_position_frontmatter_ends_at_first_close() {
    let nodes = nodes_of(&["リリース"]);
    let markdown = [
        doc(&["---", "markdag:", "    branches:", "        - リリーズ"]).as_str(),
        "",
        "---",
        "",
        "## x",
    ]
    .join("\n");
    let model = build_with(
        &nodes,
        json!({ "markdag": { "branches": ["リリーズ"] } }),
        Some(&markdown),
    );
    assert_eq!(places(&model), [at(4, 11, 4)]);
}

// 原文: 同じ語が式に 2 回出るときは、どちらか決められないので式の全体を指す
#[test]
fn model_position_repeated_word_points_at_whole_expression() {
    let nodes = nodes_of(&["A"]);
    let markdown = doc(&[
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - A --> A",
    ]);
    let model = build_with(
        &nodes,
        json!({ "markdag": { "relations": { "depends": ["A --> A"] } } }),
        Some(&markdown),
    );
    assert_eq!(codes(&model), ["self-loop"]);
    assert_eq!(places(&model), [at(5, 15, 7)]);
}

// 原文: 改行が CRLF でも同じ位置になる
#[test]
fn model_position_crlf_gives_same_position() {
    let nodes = nodes_of(&["X", "A", "B"]);
    let lines = [
        "---",
        "markdag:",
        "    relations:",
        "        depends:",
        "            - X --> A --> B",
        "            - A --> B",
        "            - \"A -> B\"",
        "---",
        "",
        "# root",
    ];
    let frontmatter = json!({ "markdag": { "relations": { "depends": ["X --> A --> B", "A --> B", "A -> B"] } } });
    // スキーマが出す 7 行目の診断が先、グラフを見る 6 行目の診断があと
    let expected = [at(7, 15, 8), at(6, 21, 1)];
    assert_eq!(
        places(&build_with(
            &nodes,
            frontmatter.clone(),
            Some(&lines.join("\n"))
        )),
        expected
    );
    assert_eq!(
        places(&build_with(&nodes, frontmatter, Some(&lines.join("\r\n")))),
        expected
    );
}

// 原文: frontmatter が壊れていたら、位置付きのエラーにして、例外にせず続ける
#[test]
fn model_position_broken_frontmatter_is_reported_with_position() {
    let nodes = nodes_of(&["リリース"]);
    let broken: Vec<(String, bool)> = vec![
        (
            doc(&["---", "markdag:", "\tbranches:", "        - リリーズ"]),
            true,
        ),
        (
            doc(&["---", "markdag:", "    branches:", "        - \"リリーズ"]),
            true,
        ),
        (
            doc(&[
                "---",
                "markdag:",
                "  branches:",
                "        - リリーズ",
                "   details: click",
            ]),
            true,
        ),
        (doc(&["---", "markdag: @reserved"]), true),
        // 空の frontmatter と frontmatter のない文書は、YAML としては壊れていない
        (doc(&["---"]), false),
        ("# root".to_string(), false),
    ];
    for (markdown, is_broken) in broken {
        let model = build_with(
            &nodes,
            json!({ "markdag": { "branches": ["リリーズ"] } }),
            Some(&markdown),
        );
        let expected: &[&str] = if is_broken {
            &["yaml-syntax", "ref-not-found"]
        } else {
            &["ref-not-found"]
        };
        assert_eq!(codes(&model), expected, "{markdown:?}");
        if is_broken {
            assert!(model.diagnostics[0].at.is_some(), "{markdown:?}");
        }
    }
}

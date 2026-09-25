// markdag parse <file> --json の結合試験。出力は 1 行の JSON で `{ "parsed": ..., "model": ... }`。
// parsed は JS の parseDocument の公開の形、model の groupsOf と tagsOf は `[[ノードの id, 値], ...]` の組の配列。
mod common;

use common::{markdag, write};
use predicates::str::contains;
use serde_json::{Value, json};

fn parse_json(path: &str) -> Value {
    let output = markdag()
        .args(["parse", path, "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).expect("UTF-8 で出る");
    assert!(
        text.ends_with('\n') && !text.trim_end().contains('\n'),
        "1 行で出る"
    );
    serde_json::from_str(&text).expect("JSON として読める")
}

fn keys(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .expect("オブジェクト")
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn the_envelope_and_its_fields_keep_the_public_order() {
    let json = parse_json("docs/examples/notation.md");
    assert_eq!(keys(&json), ["parsed", "model"]);
    assert_eq!(
        keys(&json["parsed"]),
        [
            "nodes",
            "frontmatter",
            "extracted",
            "taskIcons",
            "styleUrls"
        ]
    );
    assert_eq!(
        keys(&json["model"]),
        [
            "detailsMode",
            "legend",
            "legendPosition",
            "edgeHighlight",
            "groupHighlight",
            "branches",
            "relations",
            "suppressRootLine",
            "groups",
            "groupsOf",
            "tagDisplay",
            "tagsOf",
            "tagKeys",
            "taskCycle",
            "taskDim",
            "hooks",
            "diagnostics",
        ]
    );
    assert!(json["parsed"].get("features").is_none());
}

#[test]
fn a_known_document_has_its_node_count_and_no_diagnostics() {
    let json = parse_json("docs/examples/notation.md");
    assert_eq!(json["parsed"]["nodes"].as_array().map(Vec::len), Some(19));
    assert_eq!(json["model"]["groupsOf"].as_array().map(Vec::len), Some(19));
    assert_eq!(json["parsed"]["extracted"], json!(true));
    assert_eq!(json["model"]["diagnostics"], json!([]));
    assert_eq!(
        json["parsed"]["nodes"][0]["refText"],
        json!("新機能リリースの流れ")
    );
}

#[test]
fn groups_of_is_a_list_of_node_id_and_group_pairs() {
    let json = parse_json("testdata/judge/corpus/edge-groups-nested.md");
    assert_eq!(
        json["model"]["groupsOf"],
        json!([
            [1, []],
            [2, ["outer"]],
            [3, ["outer", "inner"]],
            [4, ["outer", "inner"]],
            [5, ["outer", "inner"]],
            [6, ["outer", "num2026"]],
            [7, []]
        ])
    );
    let names: Vec<&str> = json["parsed"]["nodes"]
        .as_array()
        .expect("配列")
        .iter()
        .map(|node| node["refText"].as_str().expect("文字列"))
        .collect();
    assert_eq!(names, ["Root", "A", "Deep", "Leaf 1", "Leaf 2", "B", "C"]);
}

#[test]
fn tags_of_is_a_list_of_pairs_and_math_adds_a_style_url() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let doc = write(
        dir.path(),
        "doc.md",
        "---\nmarkdag: {}\n---\n# a\n\n## b %g #k:v\n\n- $x^2$\n",
    );
    let output = markdag()
        .arg("parse")
        .arg(&doc)
        .arg("--json")
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let json: Value = serde_json::from_slice(&output).expect("JSON");
    assert_eq!(json["model"]["tagsOf"][1][0], json!(2));
    assert_eq!(json["model"]["tagsOf"][1][1][0]["key"], json!("k"));
    assert_eq!(json["model"]["tagsOf"][1][1][0]["values"], json!(["v"]));
    assert_eq!(json["model"]["groupsOf"][1], json!([2, ["g"]]));
    assert_eq!(
        json["parsed"]["styleUrls"],
        json!(["https://cdn.jsdelivr.net/npm/katex@0.16.18/dist/katex.min.css"])
    );
}

#[test]
fn diagnostics_are_part_of_the_model_and_hooks_are_not_loaded() {
    let json = parse_json("docs/examples/hooks.md");
    let diagnostics = json["model"]["diagnostics"].as_array().expect("配列");
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["code"], json!("hooks-unresolved"));
    assert_eq!(diagnostics[0]["severity"], json!("info"));
}

#[test]
fn the_json_flag_is_required_and_a_missing_file_exits_2() {
    markdag()
        .args(["parse", "docs/examples/notation.md"])
        .assert()
        .code(2)
        .stderr(contains("--json"));
    markdag()
        .args(["parse", "no-such-document.md", "--json"])
        .assert()
        .code(2)
        .stdout("");
}

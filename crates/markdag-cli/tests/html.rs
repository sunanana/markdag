// markdag html <file> [-o out.html] の結合試験。ページを開くブラウザは使わず、焼き込んだランタイムと
// 埋めた素材 (<script id="markdag-data"> の JSON) を文字列として確かめる。
// 前提: バイナリは dist/markdag.core.iife.js と dist/style.css を include_str! で焼き込む。build.rs はこれらがないと
// 「先に npm run build (まとめて npm run build:cli)」の文面でビルドを止めるので、この試験の前に dist を作っておく。
mod common;

use std::fs;

use common::{markdag, repo_root, write};
use predicates::prelude::*;
use predicates::str::contains;
use serde_json::{Value, json};

const DATA_OPEN: &str = "<script id=\"markdag-data\" type=\"application/json\">";

// 焼き込んだ core の IIFE の先頭 (ビルドのたびに中身は変わるので、今の dist の先頭を読んで比べる)
fn runtime_head() -> String {
    let runtime = fs::read_to_string(repo_root().join("dist/markdag.core.iife.js"))
        .expect("dist/markdag.core.iife.js がある (npm run build のあと)");
    runtime.chars().take(200).collect()
}

fn embedded_data(html: &str) -> Value {
    let start = html.find(DATA_OPEN).expect("素材の script がある") + DATA_OPEN.len();
    let end = start + html[start..].find("</script>").expect("script が閉じる");
    serde_json::from_str(&html[start..end]).expect("素材は JSON")
}

fn keys(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .expect("オブジェクト")
        .keys()
        .map(String::as_str)
        .collect()
}

fn html_to_stdout(path: &str) -> String {
    let output = markdag()
        .args(["html", path])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    String::from_utf8(output).expect("UTF-8")
}

#[test]
fn output_file_has_the_baked_runtime_style_and_embedded_data() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let out = dir.path().join("notation.html");
    markdag()
        .args(["html", "docs/examples/notation.md", "-o"])
        .arg(&out)
        .assert()
        .code(0)
        .stdout("")
        .stderr("");
    let html = fs::read_to_string(&out).expect("書き出したファイルがある");
    assert!(html.starts_with("<!doctype html>\n"));
    assert!(html.contains(&runtime_head()), "core の IIFE を焼き込む");
    assert!(
        html.contains("<style>\n/* 図の見た目。"),
        "style.css を焼き込む"
    );
    assert!(!html.contains("<script src="), "外のスクリプトを読まない");

    let data = embedded_data(&html);
    assert_eq!(keys(&data), ["parsed", "source"]);
    let source = fs::read_to_string(repo_root().join("docs/examples/notation.md")).expect("読める");
    assert_eq!(data["source"], json!(source));
    assert_eq!(data["parsed"]["nodes"].as_array().map(Vec::len), Some(19));
}

#[test]
fn without_output_the_page_goes_to_stdout_unchanged() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    let out = dir.path().join("x.html");
    markdag()
        .args(["html", "docs/examples/notation.md", "--output"])
        .arg(&out)
        .assert()
        .code(0);
    let written = fs::read_to_string(&out).expect("読める");
    assert_eq!(html_to_stdout("docs/examples/notation.md"), written);
}

#[test]
fn javascript_hooks_are_embedded_as_source() {
    let html = html_to_stdout("docs/examples/hooks.md");
    let data = embedded_data(&html);
    assert_eq!(keys(&data), ["parsed", "source", "hookScripts"]);
    let source =
        fs::read_to_string(repo_root().join("docs/examples/task-guard.hooks.js")).expect("読める");
    assert_eq!(
        data["hookScripts"],
        json!({ "./task-guard.hooks.js": source })
    );
}

#[test]
fn types_are_embedded_when_the_document_refers_to_them() {
    let data = embedded_data(&html_to_stdout("testdata/judge/corpus/fx-typed.md"));
    assert_eq!(keys(&data), ["parsed", "source", "types"]);
    assert_eq!(keys(&data["types"]), ["./types.yaml"]);
    assert!(data["types"]["./types.yaml"].is_object());
}

#[test]
fn typescript_and_unreadable_hooks_are_skipped_with_a_note_on_stderr() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    write(
        dir.path(),
        "hooks/ok.js",
        "export function decorateNode() {}\n",
    );
    let doc = write(
        dir.path(),
        "doc.md",
        "---\nmarkdag:\n    hooks:\n        $ref: [./hooks/guard.ts, ./hooks/ok.js, ./hooks/none.js]\n---\n# a\n",
    );
    let output = markdag()
        .arg("html")
        .arg(&doc)
        .assert()
        .code(0)
        .stderr(
            contains("./hooks/guard.ts")
                .and(contains("./hooks/none.js"))
                .and(contains("./hooks/ok.js").not()),
        )
        .get_output()
        .stdout
        .clone();
    let data = embedded_data(&String::from_utf8(output).expect("UTF-8"));
    assert_eq!(
        data["hookScripts"],
        json!({ "./hooks/ok.js": "export function decorateNode() {}\n" })
    );
}

#[test]
fn a_missing_input_or_an_unwritable_output_exits_2() {
    markdag()
        .args(["html", "no-such-document.md"])
        .assert()
        .code(2)
        .stdout("");
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    markdag()
        .args(["html", "docs/examples/notation.md", "-o"])
        .arg(dir.path().join("no-such-dir/out.html"))
        .assert()
        .code(2)
        .stderr(contains("no-such-dir"));
}

// markdag check <file> の結合試験。出力の形 (1 件 1 行と字下げしたヒント) と終了コード (docs/validation.md) を確かめる。
mod common;

use common::{markdag, write};
use predicates::prelude::*;
use predicates::str::contains;

#[test]
fn a_clean_document_prints_no_diagnostics_and_exits_0() {
    markdag()
        .args(["check", "docs/examples/notation.md"])
        .assert()
        .code(0)
        .stdout("no diagnostics\n")
        .stderr("");
}

#[test]
fn errors_are_one_line_each_with_an_indented_hint_and_exit_1() {
    markdag()
        .args(["check", "testdata/judge/corpus/edge-cycle.md"])
        .assert()
        .code(1)
        .stdout(
            "error cycle 7:21 閉路になるので追加しません: C --> A\n\
             \x20   「A」から「C」へ、すでに道があります。向きを入れ替えるか、この指定を消します\n\
             error self-loop 8:15 始点と終点が同じです: D --> D\n\
             warning duplicate-edge 10:25 同じ線がすでにあります: B --> C\n\
             \x20   この向きの線はすでにあります。重なった指定を消せます\n",
        );
}

#[test]
fn warnings_alone_exit_0() {
    markdag()
        .args(["check", "testdata/judge/corpus/edge-tags-all-types.md"])
        .assert()
        .code(0)
        .stdout(contains("warning tag-type ").and(contains("error ").not()));
}

#[test]
fn a_yaml_error_is_followed_by_not_extracted() {
    markdag()
        .args(["check", "testdata/judge/corpus/edge-yaml-error.md"])
        .assert()
        .code(1)
        .stdout(
            predicate::str::starts_with("error yaml-syntax 2:1 ").and(contains(
                "\ninfo not-extracted frontmatter に markdag のキーがない",
            )),
        );
}

#[test]
fn a_missing_file_exits_2_with_a_message_on_stderr() {
    markdag()
        .args(["check", "testdata/judge/corpus/no-such-document.md"])
        .assert()
        .code(2)
        .stdout("")
        .stderr(contains("no-such-document.md"));
}

#[test]
fn missing_arguments_exit_2() {
    markdag().arg("check").assert().code(2);
}

#[test]
fn types_ref_is_read_relative_to_the_document() {
    // fx-typed.md は ./types.yaml を $ref に書く。読めれば types-unresolved は出ず、型 priority で値が検査される
    markdag()
        .args(["check", "testdata/judge/corpus/fx-typed.md"])
        .assert()
        .code(1)
        .stdout(
            contains("error tag-type 22:9 「誤った行」の #priority:hgih: high / medium / low のどれかで書きます")
                .and(contains("types-unresolved").not()),
        );
}

#[test]
fn types_ref_is_resolved_from_the_document_not_the_working_directory() {
    let dir = tempfile::tempdir().expect("一時ディレクトリ");
    write(
        dir.path(),
        "notes/defs/types.yaml",
        "level:\n    type: enum\n    values: [low, high]\n",
    );
    let doc = write(
        dir.path(),
        "notes/doc.md",
        "---\nmarkdag:\n    types:\n        $ref: defs/types.yaml\n    tags:\n        keys:\n            lv:\n                type: level\n---\n# Root\n\n## A #lv:mid\n",
    );
    // 作業ディレクトリは文書と別の場所 (リポジトリの根) にする
    markdag()
        .arg("check")
        .arg(&doc)
        .assert()
        .code(0)
        .stdout("warning tag-type 12:6 「A」の #lv:mid: low / high のどれかで書きます\n");

    // 型のファイルがないと types-unresolved の warning になり、型を使うキーは検査しない
    std::fs::remove_file(dir.path().join("notes/defs/types.yaml")).expect("消せる");
    markdag().arg("check").arg(&doc).assert().code(0).stdout(
        contains("warning types-unresolved 4:15 markdag.types.$ref「defs/types.yaml」")
            .and(contains("tag-type").not()),
    );
}

#[test]
fn hooks_are_not_loaded_and_reported_as_info() {
    markdag()
        .args(["check", "docs/examples/hooks.md"])
        .assert()
        .code(0)
        .stdout(
            "info hooks-unresolved 17:15 markdag.hooks.$ref「./task-guard.hooks.js」は読み込まれていないので、このフックは動きません\n\
             \x20   このアプリはフックを読み込みません (markdag.rules ならコードなしで効きます)\n",
        );
}

// html のサブコマンド。文書を単体で開ける HTML にする。ページの組み立ては JS の buildStandaloneHtml と同じ
// render_standalone_page で、ランタイム (dist/markdag.core.iife.js) とスタイルシート (dist/style.css) はビルド時に焼き込む
// (build.rs が dist の 2 つのファイルがあることを確かめる。npm run build のあとに cargo build する)。
// 素材は JS で buildStandaloneHtml({ parsed, source, types, hookScripts }) を呼んだときと同じ形と順にする:
//   parsed は公開の ParsedDocument の形、types は文書が markdag.types.$ref を書いたときだけ、
//   hookScripts は読めた .js のソースがあるときだけ入れる。
// markdag.hooks.$ref は文書からの相対で読み、ソースの文字列のまま埋める (実行は開いたブラウザ)。
// TypeScript のフック (.ts、.tsx、.mts、.cts) は変換しないので埋めず、読めないファイルも埋めない。どちらも stderr に知らせ、
// 開いたページでは hooks-unresolved の警告になる。

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::sync::LazyLock;

use indexmap::IndexMap;
use markdag_core::model::util::JsValue;
use markdag_core::native::public_parsed;
use markdag_core::parse::parse_document;
use markdag_core::standalone::{StandaloneOptions, StandaloneRuntime, render_standalone_page};
use regex::Regex;

use crate::document::{load_type_refs, read_document, refs_of};

const CORE_RUNTIME: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../dist/markdag.core.iife.js"
));
const STYLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../dist/style.css"));

// Node の check が TypeScript として変換する拡張子 (scripts/check.ts の `/\.[cm]?tsx?$/`)
static TYPESCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.[cm]?tsx?$").expect("固定の正規表現"));

pub fn run(file: &Path, output: Option<&Path>) -> ExitCode {
    let Some(markdown) = read_document(file) else {
        return ExitCode::from(2);
    };
    let data = standalone_data(file, &markdown);
    let defaults = StandaloneRuntime {
        script: CORE_RUNTIME.to_string(),
        style: STYLE.to_string(),
    };
    let html = match render_standalone_page(&StandaloneOptions::default(), &data, &defaults) {
        Ok(html) => html,
        Err(error) => {
            eprintln!("単体 HTML を組み立てられませんでした: {error}");
            return ExitCode::from(1);
        }
    };
    match output {
        Some(path) => {
            if let Err(error) = fs::write(path, html) {
                eprintln!("ファイルに書けませんでした: {}: {error}", path.display());
                return ExitCode::from(2);
            }
        }
        None => print!("{html}"),
    }
    ExitCode::SUCCESS
}

fn standalone_data(file: &Path, markdown: &str) -> JsValue {
    let parsed = parse_document(markdown);
    let mut data = IndexMap::new();
    data.insert("parsed".to_string(), public_parsed(&parsed));
    data.insert("source".to_string(), JsValue::String(markdown.to_string()));
    let types = load_type_refs(file, markdown);
    if !types.is_empty() {
        data.insert("types".to_string(), JsValue::Object(types));
    }
    let scripts = load_hook_scripts(file, markdown);
    if !scripts.is_empty() {
        data.insert("hookScripts".to_string(), JsValue::Object(scripts));
    }
    JsValue::Object(data)
}

// markdag.hooks.$ref が指す JavaScript のソースを、書かれたパスをキーにして集める
fn load_hook_scripts(file: &Path, markdown: &str) -> IndexMap<String, JsValue> {
    let base = file.parent().unwrap_or_else(|| Path::new(""));
    let mut scripts = IndexMap::new();
    for reference in refs_of(markdown, "hooks") {
        if TYPESCRIPT.is_match(&reference) {
            eprintln!(
                "TypeScript のフックは埋め込みません (JavaScript にしてから $ref に書きます): {reference}"
            );
            continue;
        }
        match fs::read(base.join(&reference)) {
            Ok(bytes) => {
                let code = String::from_utf8_lossy(&bytes).into_owned();
                scripts.insert(reference, JsValue::String(code));
            }
            Err(error) => eprintln!("フックのファイルを読めませんでした: {reference}: {error}"),
        }
    }
    scripts
}

#[cfg(test)]
mod tests {
    use super::*;
    use markdag_core::model::util::js_json_stringify;

    #[test]
    fn typescript_extensions_match_the_node_check() {
        for name in ["a.ts", "a.tsx", "a.mts", "a.cts", "./x/a.mtsx"] {
            assert!(TYPESCRIPT.is_match(name), "{name}");
        }
        for name in ["a.js", "a.mjs", "a.ts.js", "ts"] {
            assert!(!TYPESCRIPT.is_match(name), "{name}");
        }
    }

    #[test]
    fn data_has_only_the_fields_the_document_needs() {
        let markdown = "# a\n";
        let json = js_json_stringify(&standalone_data(Path::new("missing/doc.md"), markdown));
        assert!(json.starts_with("{\"parsed\":{\"nodes\":"));
        assert!(json.ends_with(",\"source\":\"# a\\n\"}"));
    }

    #[test]
    fn unreadable_and_typescript_hooks_are_skipped() {
        let markdown = "---\nmarkdag:\n  hooks:\n    $ref: [./a.ts, ./none.js]\n  types:\n    $ref: none.yaml\n---\n# a\n";
        let JsValue::Object(data) = standalone_data(Path::new("missing/doc.md"), markdown) else {
            panic!("オブジェクトになる");
        };
        assert!(!data.contains_key("hookScripts"));
        assert_eq!(
            data.get("types").map(js_json_stringify).as_deref(),
            Some("{\"none.yaml\":null}")
        );
    }
}

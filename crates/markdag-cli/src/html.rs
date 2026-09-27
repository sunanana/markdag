// html のサブコマンド。文書を単体で開ける HTML にする。ページの組み立ては JS の buildStandaloneHtml と同じ
// render_standalone_page で、ランタイム (dist/markdag.core.iife.js) とスタイルシート (dist/style.css) はビルド時に焼き込む
// (build.rs が dist の 2 つのファイルがあることを確かめる。npm run build のあとに cargo build する)。
// 素材は JS で buildStandaloneHtml({ parsed, source, types, hookScripts, iconAliases, icons }) を呼んだときと同じ形と順にする:
//   parsed は公開の ParsedDocument の形、types は文書が markdag.types.$ref を書いたときだけ、
//   hookScripts は読めた .js のソースがあるときだけ入れる。
// markdag.hooks.$ref は文書からの相対で読み、ソースの文字列のまま埋める (実行は開いたブラウザ)。
// TypeScript のフック (.ts、.tsx、.mts、.cts) は変換しないので埋めず、読めないファイルも埋めない。どちらも stderr に知らせ、
// 開いたページでは hooks-unresolved の警告になる。
// markdag.icons.$ref は types と同じく文書からの相対で読み、YAML を読んだ値を iconAliases に入れる (書いたときだけ)。
// ロゴは、文書が使う alias (本文、詳細、タグ、グループ) のうち相対パスの SVG だけを文書からの相対で読み、icons に
// 書かれたパスをキーにして入れる (読めたものがあるときだけ)。set:name (Iconify の名前) はネットワークに出ないので解決せず、
// 開いたページでは文字のまま残る。読めないファイルは埋めず stderr に知らせる。中身は検めずに埋め、開いたときに描画の側が
// sanitizeSvg を通す (SVG として読めなければ文字のまま)。

use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::sync::LazyLock;

use indexmap::IndexMap;
use markdag_core::model::icon_uses::document_icon_defs;
use markdag_core::model::model::{ModelOptions, build_model};
use markdag_core::model::util::JsValue;
use markdag_core::native::public_parsed;
use markdag_core::parse::parse_document;
use markdag_core::standalone::{StandaloneOptions, StandaloneRuntime, render_standalone_page};
use markdag_core::types::{IconKind, ParsedDocument};
use regex::Regex;

use crate::document::{base_dir, load_icon_refs, load_type_refs, read_document, refs_of};

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
        data.insert("types".to_string(), JsValue::Object(types.clone()));
    }
    let scripts = load_hook_scripts(file, markdown);
    if !scripts.is_empty() {
        data.insert("hookScripts".to_string(), JsValue::Object(scripts));
    }
    let icon_aliases = load_icon_refs(file, markdown);
    let svgs = load_icon_svgs(file, &parsed, types, icon_aliases.clone());
    if !icon_aliases.is_empty() {
        data.insert("iconAliases".to_string(), JsValue::Object(icon_aliases));
    }
    if !svgs.is_empty() {
        data.insert("icons".to_string(), JsValue::Object(svgs));
    }
    JsValue::Object(data)
}

// 文書が使うロゴのうち相対パスの SVG を、書かれたパスをキーにして集める。どの alias を使うかはモデルを組み立てて決める
// (開いたページが組み立てるモデルと同じ types と icons.$ref を渡す)。
// パスは文書のあるディレクトリからの相対で、types.$ref と同じく `..` で上に出るものも読む
// (絶対パスと URL は alias の表の段で誤りになり、ここまで来ない)。
// icons.$ref のファイルに書いた相対パスも、そのファイルの場所ではなく文書の場所から読む
fn load_icon_svgs(
    file: &Path,
    parsed: &ParsedDocument,
    types: IndexMap<String, JsValue>,
    icon_aliases: IndexMap<String, JsValue>,
) -> IndexMap<String, JsValue> {
    let options = ModelOptions {
        types: Some(types),
        hook_refs: None,
        icons: Some(icon_aliases),
    };
    // 使うのはモデルの表と対応だけで診断は捨てるので、原文を渡さない (渡すと本文の診断と印のために解析し直す)
    let model = build_model(&parsed.nodes, &parsed.frontmatter, None, &options);
    let base = base_dir(file);
    let mut svgs = IndexMap::new();
    for def in document_icon_defs(&parsed.nodes, &model) {
        if def.kind != IconKind::Path || !is_svg_path(&def.ref_text) {
            continue;
        }
        match fs::read(base.join(&def.ref_text)) {
            Ok(bytes) => {
                let svg = String::from_utf8_lossy(&bytes).into_owned();
                svgs.insert(def.ref_text, JsValue::String(svg));
            }
            Err(error) => {
                eprintln!(
                    "ロゴのファイルを読めませんでした: {}: {error}",
                    def.ref_text
                )
            }
        }
    }
    svgs
}

// 拡張子が .svg (大文字と小文字を同一視) のパスか。alias の表は SVG 以外のパスを誤りにしているが、読む前にもう一度確かめる
fn is_svg_path(reference: &str) -> bool {
    Path::new(reference)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
}

// markdag.hooks.$ref が指す JavaScript のソースを、書かれたパスをキーにして集める
fn load_hook_scripts(file: &Path, markdown: &str) -> IndexMap<String, JsValue> {
    let base = base_dir(file);
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

    #[test]
    fn only_svg_extensions_are_read() {
        for name in ["./a.svg", "../x/a.SVG", "a/b.Svg"] {
            assert!(is_svg_path(name), "{name}");
        }
        for name in ["./a.png", "./a.svg.png", "./svg", "./a.svgz"] {
            assert!(!is_svg_path(name), "{name}");
        }
    }
}

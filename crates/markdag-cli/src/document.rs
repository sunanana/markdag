// サブコマンドが共有する文書の読み込み。文書のファイルと、frontmatter の markdag.<key>.$ref が指すファイルを
// 文書のあるディレクトリからの相対で読む (ライブラリはファイルを読まないので、呼び出し側のこの crate が読む)。
// $ref の取り出し方は Node の check (scripts/check.ts の refsOf) と同じ規則にする。

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use indexmap::IndexMap;
use markdag_core::model::util::JsValue;
use markdag_core::parse::parse_yaml;
use regex::Regex;

// Node の check が frontmatter を切り出す形 (markmap の切り出しとは別。閉じの行のあとに改行が要る)
static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n([\s\S]*?)\n---\r?\n").expect("固定の正規表現"));

/// 文書を UTF-8 として読む。Node の readFileSync(..., 'utf8') と同じく、読めないバイトは U+FFFD にする。
/// 読めなければ stderr に知らせて None (呼び出し側は終了コード 2 にする)
pub fn read_document(file: &Path) -> Option<String> {
    match fs::read(file) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => {
            eprintln!("ファイルを読めませんでした: {}: {error}", file.display());
            None
        }
    }
}

/// frontmatter の markdag.<key> の下の $ref を、書かれた順に取り出す。文字列 1 つか文字列の配列 (文字列でない項目は飛ばす)
pub fn refs_of(markdown: &str, key: &str) -> Vec<String> {
    let Some(body) = FRONTMATTER
        .captures(markdown)
        .and_then(|found| found.get(1))
    else {
        return Vec::new();
    };
    let Some(JsValue::Object(frontmatter)) = parse_yaml(body.as_str()) else {
        return Vec::new();
    };
    let Some(JsValue::Object(markdag)) = frontmatter.get("markdag") else {
        return Vec::new();
    };
    let Some(JsValue::Object(section)) = markdag.get(key) else {
        return Vec::new();
    };
    match section.get("$ref") {
        Some(JsValue::String(single)) => vec![single.clone()],
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// markdag.types.$ref が指すファイルを読む。読めないものと YAML として読めないものは null (ライブラリが types-unresolved にする)
pub fn load_type_refs(file: &Path, markdown: &str) -> IndexMap<String, JsValue> {
    let base = file.parent().unwrap_or_else(|| Path::new(""));
    let mut loaded = IndexMap::new();
    for reference in refs_of(markdown, "types") {
        let value = fs::read(base.join(&reference))
            .ok()
            .and_then(|bytes| parse_yaml(&String::from_utf8_lossy(&bytes)))
            .unwrap_or(JsValue::Null);
        loaded.insert(reference, value);
    }
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_pattern_compiles() {
        assert!(FRONTMATTER.is_match("---\na: 1\n---\n"));
    }

    #[test]
    fn refs_follow_the_node_check() {
        assert_eq!(
            refs_of(
                "---\nmarkdag:\n  types:\n    $ref: t.yaml\n---\n# a\n",
                "types"
            ),
            vec!["t.yaml"]
        );
        assert_eq!(
            refs_of(
                "---\nmarkdag:\n  types:\n    $ref: [a.yaml, 1, b.yaml]\n---\n# a\n",
                "types"
            ),
            vec!["a.yaml", "b.yaml"]
        );
        assert_eq!(
            refs_of(
                "---\nmarkdag:\n  hooks:\n    $ref: ./h.js\n---\n# a\n",
                "hooks"
            ),
            vec!["./h.js"]
        );
        // 閉じの行のあとに改行がない frontmatter は、Node の check も読まない
        assert!(refs_of("---\nmarkdag:\n  types:\n    $ref: t.yaml\n---", "types").is_empty());
        assert!(refs_of("---\nmarkdag: [\n---\n", "types").is_empty());
    }
}

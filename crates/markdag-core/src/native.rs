// ネイティブの入口 (CLI と MCP サーバー) が共有する、文書 1 つ分の検査と JSON の組み立て。
// wasm の境界は通らず、JS の包み (parseDocument の公開の形への直し) と Node の check の集め方をここで写す。
// ファイルは読まない: markdag.types.$ref の中身は呼び出し側が読むか引数で受けて types に渡す。
// markdag.hooks.$ref は常に読まない扱い (hookRefs を渡さないので、ライブラリが hooks-unresolved を知らせる)。
// フックがないので transformSource による差し替えは起きず、1 回の解析と組み立てで足りる。

use indexmap::IndexMap;
use serde::Serialize;

use crate::model::model::{ModelOptions, build_model};
use crate::model::util::JsValue;
use crate::parse::parse_document;
use crate::types::{Diagnostic, ParsedDocument, Severity};

// 数式とコードの色付けのスタイルシート。JS の包み (parseDocument) の MATH_STYLE_URL と CODE_STYLE_URL と同じ値と順 (決定 12)
pub const MATH_STYLE_URL: &str = "https://cdn.jsdelivr.net/npm/katex@0.16.18/dist/katex.min.css";
pub const CODE_STYLE_URL: &str =
    "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/default.min.css";

/// 境界の JSON と同じ直列化を経て JsValue にする。有限でない数と undefined の印 ($number、$undefined、$object) は
/// JsValue の読み取りが戻すので、JS の包みが受け取る値と同じになる
pub fn to_js_value<T: Serialize>(value: &T) -> JsValue {
    let json = serde_json::to_string(value).expect("markdag-core の型は JSON にできる");
    serde_json::from_str(&json).expect("直列化した JSON は JsValue として読める")
}

/// 解析の結果を JS の公開の ParsedDocument の形にする (包みの decorateParsed のうち、KaTeX と highlight.js がないときの動き)。
/// features を消して styleUrls を足し、欄の順を JS の parseDocument と同じ nodes、frontmatter、extracted、taskIcons、styleUrls にする
pub fn public_parsed(parsed: &ParsedDocument) -> JsValue {
    let style_urls = [
        (parsed.features.math, MATH_STYLE_URL),
        (parsed.features.code, CODE_STYLE_URL),
    ]
    .into_iter()
    .filter(|(used, _)| *used)
    .map(|(_, url)| JsValue::String(url.to_string()))
    .collect();
    let mut fields = IndexMap::new();
    fields.insert("nodes".to_string(), to_js_value(&parsed.nodes));
    fields.insert("frontmatter".to_string(), parsed.frontmatter.clone());
    fields.insert("extracted".to_string(), JsValue::Bool(parsed.extracted));
    fields.insert("taskIcons".to_string(), to_js_value(&parsed.task_icons));
    fields.insert("styleUrls".to_string(), JsValue::Array(style_urls));
    JsValue::Object(fields)
}

/// Node の check (--hooks なし) と同じ診断を集める: 解析と組み立ての診断に、markdag のキーがない文書の not-extracted を足す。
/// types は $ref に書いた文字列をキーにした型のファイルの中身 (ないキーは「渡していない」で types-unresolved になる)
pub fn diagnose(markdown: &str, types: IndexMap<String, JsValue>) -> Vec<Diagnostic> {
    let parsed = parse_document(markdown);
    let options = ModelOptions {
        types: Some(types),
        hook_refs: None,
    };
    let model = build_model(&parsed.nodes, &parsed.frontmatter, Some(markdown), &options);
    let mut diagnostics = model.diagnostics;
    if !parsed.extracted {
        diagnostics.push(Diagnostic {
            severity: Severity::Info,
            code: "not-extracted".to_string(),
            message: "frontmatter に markdag のキーがないので、タグや $id の抽出は行っていません (markmap と同じ表示)".to_string(),
            at: None,
            hint: None,
        });
    }
    diagnostics
}

/// 診断に error が 1 件でもあるか (CLI の終了コード 1 と MCP の結果の印)
pub fn has_error(diagnostics: &[Diagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|item| item.severity == Severity::Error)
}

/// 解析の結果とグラフのモデルを `{ "parsed": 公開の ParsedDocument, "model": GraphModel のデータ部分 }` にする。
/// model の groupsOf と tagsOf は `[[ノードの id, 値], ...]` の組の配列、hooks は `{ declared, options, rules }`
pub fn parse_and_model(markdown: &str, types: IndexMap<String, JsValue>) -> JsValue {
    let parsed = parse_document(markdown);
    let options = ModelOptions {
        types: Some(types),
        hook_refs: None,
    };
    let model = build_model(&parsed.nodes, &parsed.frontmatter, Some(markdown), &options);
    let mut envelope = IndexMap::new();
    envelope.insert("parsed".to_string(), public_parsed(&parsed));
    envelope.insert("model".to_string(), to_js_value(&model));
    JsValue::Object(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::util::js_json_stringify;

    #[test]
    fn public_parsed_replaces_features_with_style_urls() {
        let parsed = parse_document("# a\n\n- $x$ and `y`\n\n```js\nz\n```\n");
        let json = js_json_stringify(&public_parsed(&parsed));
        assert!(!json.contains("\"features\""));
        let keys = [
            "\"nodes\"",
            "\"frontmatter\"",
            "\"extracted\"",
            "\"taskIcons\"",
            "\"styleUrls\"",
        ];
        let positions: Vec<usize> = keys.iter().map(|key| json.find(key).expect(key)).collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(json.ends_with(&format!(
            "\"styleUrls\":[\"{MATH_STYLE_URL}\",\"{CODE_STYLE_URL}\"]}}"
        )));
    }

    #[test]
    fn non_finite_numbers_come_back_as_numbers() {
        let parsed = parse_document("---\nmarkdag: {}\nv: .inf\n---\n# a\n");
        let JsValue::Object(fields) = public_parsed(&parsed) else {
            panic!("オブジェクトになる");
        };
        let Some(JsValue::Object(frontmatter)) = fields.get("frontmatter") else {
            panic!("frontmatter はオブジェクト");
        };
        assert_eq!(frontmatter.get("v"), Some(&JsValue::Number(f64::INFINITY)));
    }

    #[test]
    fn maps_are_pairs_and_the_envelope_has_two_fields() {
        let markdown = "---\nmarkdag: {}\n---\n# a\n\n## b %g #k:v\n";
        let json = js_json_stringify(&parse_and_model(markdown, IndexMap::new()));
        assert!(json.starts_with("{\"parsed\":{\"nodes\":"));
        assert!(json.contains("\"groupsOf\":[[1,[]],[2,[\"g\"]]]"));
        assert!(json.contains("\"tagsOf\":[[1,[]],[2,[{\"key\":\"k\",\"values\":[\"v\"]"));
        assert!(json.contains("\"styleUrls\":[]"));
    }

    #[test]
    fn diagnose_adds_not_extracted_last() {
        let diagnostics = diagnose("# a\n", IndexMap::new());
        assert_eq!(
            diagnostics.last().map(|item| item.code.as_str()),
            Some("not-extracted")
        );
        assert!(!has_error(&diagnostics));
    }

    #[test]
    fn missing_types_are_unresolved_and_given_types_are_used() {
        let markdown = "---\nmarkdag:\n  types:\n    $ref: ./t.yaml\n  tags:\n    keys:\n      p:\n        type: prio\n---\n# a #p:9\n";
        let codes = |types| {
            diagnose(markdown, types)
                .into_iter()
                .map(|item| item.code)
                .collect::<Vec<_>>()
        };
        let without = codes(IndexMap::new());
        assert!(without.contains(&"types-unresolved".to_string()));
        assert!(!without.contains(&"tag-type".to_string()));
        let definition: JsValue =
            serde_json::from_str(r#"{"prio":{"type":"enum","values":["high","low"]}}"#).unwrap();
        let mut given = IndexMap::new();
        given.insert("./t.yaml".to_string(), definition);
        let with_types = codes(given);
        assert!(!with_types.contains(&"types-unresolved".to_string()));
        assert!(with_types.contains(&"tag-type".to_string()));
    }
}

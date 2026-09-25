// 原文: src/standalone/page.ts (2026-09-24)
// 図を「単体で開ける HTML」の文字列にする。DOM を触らない。
// ランタイム (script タグ 1 本で動く版) とスタイルシートをページに埋め、図の素材は JSON で埋めて、開いたときに組み立てる。
// 外部を読みに行くものはページに入れない。画像や書体の同梱は、呼び出し側が素材 (parsed の html、css) に済ませて渡す。
// 素材 (StandaloneData) は JS の値のまま (JsValue) 受け、JSON.stringify と同じ文字列 (js_json_stringify) にして埋める。
// JS の包み (buildStandaloneHtml) と CLI の html が同じこの関数を呼び、テンプレートを 2 か所に持たない (A-017)
use std::fmt;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::model::util::{JS_WHITESPACE, JsValue, js_json_stringify};

/// 原文: StandaloneRuntime
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneRuntime {
    // ランタイムのコード。グローバル markdag を定義する IIFE
    pub script: String,
    pub style: String,
}

/// 原文: `Partial<StandaloneRuntime>` (StandaloneOptions.runtime)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneRuntimeOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// 原文: StandaloneOptions のうち、素材 (StandaloneData) を除いたページの指定。
/// 素材の欄 (parsed、source、types、hookScripts、view、state、tasks) は render_standalone_page の data で受ける
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    // html 要素の lang。省略すると付けない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    // 図を置く要素に足すクラス。呼び出し側のスタイルシートが詳細度を稼ぐのに使う
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_class: Option<String>,
    // 追加のスタイルシート。ランタイムのものより後に入るので、同じ詳細度なら勝つ
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<Vec<String>>,
    // head の末尾に入れる HTML (meta など)。そのまま入るので、呼び出し側が正しい HTML を渡す
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    // 埋めるランタイムを差し替える (原文だけを渡すときは、変換器を含む版が要る)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<StandaloneRuntimeOverride>,
}

/// ページを組み立てられないとき (原文の `throw new Error(message)`)。文面は原文のまま
#[derive(Debug, Clone, PartialEq)]
pub struct StandaloneError {
    pub message: String,
}

impl fmt::Display for StandaloneError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

const DEFAULT_TITLE: &str = "markdag";
pub const CONTAINER_CLASS: &str = "mdag-standalone";
pub const DATA_ID: &str = "markdag-data";
// 開いたときの図の窓口を置く window の名前
pub const DIAGRAM_GLOBAL: &str = "markdagStandalone";

// 素材の JSON に入れる欄と、その順 (原文の `const data: StandaloneData = { parsed, source, types, hookScripts, view, state, tasks }`)
const DATA_KEYS: [&str; 7] = [
    "parsed",
    "source",
    "types",
    "hookScripts",
    "view",
    "state",
    "tasks",
];

// ページの骨組みの CSS。図を置く要素が画面いっぱいになるようにする。色は図のスタイルシートと css が決める
fn base_style() -> String {
    [
        "html, body { margin: 0; height: 100%; }".to_string(),
        format!(".{CONTAINER_CLASS} {{ width: 100%; height: 100vh; height: 100dvh; }}"),
    ]
    .join("\n")
}

// 開いたときに図を組み立てる。ランタイムに焼き込んだ wasm で init を待ってから mountStandalone を呼ぶ (A-188、A-192 (6))。
// 診断は見せる場所がないので開発者ツールに出し、図の窓口も開発者ツールから触れるように window に置く。
// init か組み立てが失敗したら、図を置く要素に文面を出し (白紙のページにしない)、開発者ツールにも誤りを出す
fn boot() -> String {
    [
        format!(
            "Promise.resolve().then(() => markdag.init()).then(() => markdag.mountStandalone(document.querySelector('.{CONTAINER_CLASS}'), JSON.parse(document.getElementById('{DATA_ID}').textContent))).then((diagram) => {{"
        ),
        format!("    window.{DIAGRAM_GLOBAL} = diagram;"),
        "    if (diagram.diagnostics.length > 0) console.warn(markdag.formatDiagnostics(diagram.diagnostics));".to_string(),
        "}, (error) => {".to_string(),
        "    console.error(error);".to_string(),
        format!(
            "    document.querySelector('.{CONTAINER_CLASS}').textContent = 'markdag: ' + (error instanceof Error ? error.message : String(error));"
        ),
        "});".to_string(),
    ]
    .join("\n")
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

// `text.replace(/<\/{tag}/gi, '<\\/{tag}')`。置き換えた後は小文字になる (原文の置換の文字列が小文字の固定)。
// 原文の i フラグは u なしなので、大文字と小文字を同一視するのは ASCII の字だけ
fn escape_closing_tag(text: &str, tag: &str) -> String {
    let needle = format!("</{tag}");
    let replacement = format!("<\\/{tag}");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        // needle は ASCII だけなので、一致するなら先頭の needle.len() バイトは char の境界で切れる
        let after_match = rest
            .get(..needle.len())
            .filter(|head| head.eq_ignore_ascii_case(&needle))
            .and_then(|_| rest.get(needle.len()..));
        if let Some(after) = after_match {
            out.push_str(&replacement);
            rest = after;
            continue;
        }
        let mut chars = rest.chars();
        if let Some(c) = chars.next() {
            out.push(c);
        }
        rest = chars.as_str();
    }
    out
}

// `/<!--[\s\S]*<script/i.test(code)`: 最初の `<!--` より後ろに `<script` (ASCII の大文字と小文字を同一視) があるか
fn has_comment_then_script(code: &str) -> bool {
    code.split_once("<!--").is_some_and(|(_, rest)| {
        rest.as_bytes()
            .windows(7)
            .any(|window| window.eq_ignore_ascii_case(b"<script"))
    })
}

// script の中の閉じタグで script が途中で終わらないようにする。`<!--` のあとに `<script` があると閉じタグの扱いが変わり、
// 文字の置き換えでは直せないので、そのコードは埋められないものとして断る
fn embed_script(code: &str) -> Result<String, StandaloneError> {
    if has_comment_then_script(code) {
        return Err(StandaloneError {
            message: "script の中に「<!--」と「<script」が続けて現れるので、HTML に埋め込めません"
                .to_string(),
        });
    }
    Ok(escape_closing_tag(code, "script"))
}

// style の中の閉じタグも同じ。CSS では `\/` は `/` なので、置き換えても意味は変わらない
fn embed_style(css: &str) -> String {
    escape_closing_tag(css, "style")
}

// JSON を script に埋める。`<` を逃がしておけば、中身が何であれタグとして読まれない (JSON.parse はそのまま読める)
fn embed_json(value: &JsValue) -> String {
    let json = js_json_stringify(value);
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        match c {
            '<' => out.push_str("\\u003c"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out
}

// 素材の欄の値。欄がないか undefined なら None (原文の分割代入で undefined になる欄)
fn data_field<'a>(data: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match data {
        JsValue::Object(entries) => entries
            .get(key)
            .filter(|value| **value != JsValue::Undefined),
        _ => None,
    }
}

/// 原文: renderStandalonePage。
/// data は素材 (StandaloneData の欄を持つオブジェクト。他の欄は読まない)、defaults は既定のランタイム
pub fn render_standalone_page(
    options: &StandaloneOptions,
    data: &JsValue,
    defaults: &StandaloneRuntime,
) -> Result<String, StandaloneError> {
    if data_field(data, "parsed").is_none() && data_field(data, "source").is_none() {
        return Err(StandaloneError {
            message: "parsed か source のどちらかが要ります".to_string(),
        });
    }
    // undefined の欄は JSON.stringify で落ちるので、ある欄だけを原文の順に入れる
    let mut material = IndexMap::new();
    for key in DATA_KEYS {
        if let Some(value) = data_field(data, key) {
            material.insert(key.to_string(), value.clone());
        }
    }
    let material = JsValue::Object(material);
    let title = options.title.as_deref().unwrap_or(DEFAULT_TITLE);
    let css: &[String] = options.css.as_deref().unwrap_or(&[]);
    let head = options.head.as_deref().unwrap_or("");
    let runtime = options.runtime.clone().unwrap_or_default();
    let script = runtime.script.as_deref().unwrap_or(&defaults.script);
    let style = runtime.style.as_deref().unwrap_or(&defaults.style);
    let mut classes = vec![CONTAINER_CLASS];
    classes.extend(
        options
            .container_class
            .as_deref()
            .unwrap_or("")
            .split(JS_WHITESPACE)
            .filter(|name| !name.is_empty()),
    );
    let classes = classes.join(" ");

    // 原文は配列の要素を順に評価するので、embedStyle のあとに embedScript が断る (どちらも副作用はない)
    let mut lines: Vec<String> = vec![
        "<!doctype html>".to_string(),
        match options.lang.as_deref() {
            None => "<html>".to_string(),
            Some(lang) => format!("<html lang=\"{}\">", escape_html(lang)),
        },
        "<head>".to_string(),
        "<meta charset=\"utf-8\">".to_string(),
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">".to_string(),
        format!("<title>{}</title>", escape_html(title)),
        format!("<style>\n{}\n</style>", embed_style(style)),
        format!("<style>\n{}\n</style>", base_style()),
    ];
    if !css.is_empty() {
        lines.push(format!(
            "<style>\n{}\n</style>",
            embed_style(&css.join("\n"))
        ));
    }
    if !head.is_empty() {
        lines.push(head.to_string());
    }
    lines.extend([
        "</head>".to_string(),
        "<body>".to_string(),
        format!("<div class=\"{}\"></div>", escape_html(&classes)),
        format!(
            "<script id=\"{DATA_ID}\" type=\"application/json\">{}</script>",
            embed_json(&material)
        ),
        format!("<script>\n{}\n</script>", embed_script(script)?),
        format!("<script>\n{}\n</script>", boot()),
        "</body>".to_string(),
        "</html>".to_string(),
        String::new(),
    ]);
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> StandaloneRuntime {
        StandaloneRuntime {
            script: "var markdag = { mountStandalone() {} };".to_string(),
            style: ".markdag { color: red; }".to_string(),
        }
    }

    fn value(json: &str) -> JsValue {
        serde_json::from_str(json).expect("JSON")
    }

    fn parsed() -> JsValue {
        value(
            r#"{"nodes":[{"id":1,"parent":null,"depth":1,"html":"<p>Root &lt;b&gt;</p>","refText":"Root <b>","refId":null,"groups":[],"tags":[],"milestone":false,"foldHint":0,"lines":{"start":3,"end":4},"task":null,"details":null}],"frontmatter":{"markdag":{}},"extracted":true,"styleUrls":[],"taskIcons":null}"#,
        )
    }

    fn embedded(html: &str) -> &str {
        let open = format!("<script id=\"{DATA_ID}\" type=\"application/json\">");
        let start = html.find(&open).expect("埋め込んだ JSON") + open.len();
        let end = start + html[start..].find("</script>").expect("閉じタグ");
        &html[start..end]
    }

    #[test]
    fn standalone_解析結果と状態を_json_で埋め_ランタイムとスタイルシートを入れる() {
        let data = value(
            r#"{"tasks":"scratch","types":{"./t.yaml":{"x":1}},"view":{"theme":"dark"},"state":{"folded":[1]},"parsed":null}"#,
        );
        let mut data = data;
        if let JsValue::Object(entries) = &mut data {
            entries.insert("parsed".to_string(), parsed());
        }
        let options = StandaloneOptions {
            title: Some("A & B".to_string()),
            ..Default::default()
        };
        let html = render_standalone_page(&options, &data, &runtime()).expect("組み立てられる");
        assert!(html.starts_with("<!doctype html>\n<html>\n"));
        assert!(html.ends_with("</body>\n</html>\n"));
        assert!(html.contains("<title>A &amp; B</title>"));
        assert!(html.contains(&format!("<style>\n{}\n</style>", runtime().style)));
        assert!(html.contains(&format!("<script>\n{}\n</script>", runtime().script)));
        assert!(html.contains(&format!("<div class=\"{CONTAINER_CLASS}\"></div>")));
        assert!(html.contains("markdag.mountStandalone("));
        // 欄は原文の data の順 (parsed, source, types, hookScripts, view, state, tasks) に並べ直す
        let json = embedded(&html);
        assert!(json.starts_with(r#"{"parsed":{"nodes":[{"id":1,"#));
        assert!(json.ends_with(r#""types":{"./t.yaml":{"x":1}},"view":{"theme":"dark"},"state":{"folded":[1]},"tasks":"scratch"}"#));
    }

    #[test]
    fn standalone_起動は_init_を待ってから_mount_standalone_を呼び_失敗を要素に出す() {
        let html = render_standalone_page(
            &StandaloneOptions::default(),
            &value(r##"{"source":"# a"}"##),
            &runtime(),
        )
        .expect("組み立てられる");
        let boot = html.rsplit("<script>\n").next().expect("起動の script");
        let init = boot.find("markdag.init()").expect("init を呼ぶ");
        let mount = boot
            .find("markdag.mountStandalone(")
            .expect("mountStandalone を呼ぶ");
        assert!(init < mount);
        assert!(boot.contains(".then(() => markdag.mountStandalone("));
        assert!(boot.contains("}, (error) => {"));
        assert!(boot.contains(&format!(
            "document.querySelector('.{CONTAINER_CLASS}').textContent = 'markdag: '"
        )));
    }

    #[test]
    fn standalone_埋めた_json_の中の_lt_はタグとして読まれない形にする() {
        let data = value(
            r#"{"parsed":{"a":1},"source":"</script><script>alert(1)</script>\u2028\u2029"}"#,
        );
        let html = render_standalone_page(&StandaloneOptions::default(), &data, &runtime())
            .expect("組み立てられる");
        let json = embedded(&html);
        assert!(!json.contains('<'));
        assert_eq!(
            json,
            r#"{"parsed":{"a":1},"source":"\u003c/script>\u003cscript>alert(1)\u003c/script>\u2028\u2029"}"#
        );
    }

    #[test]
    fn standalone_ランタイムと追加の_css_の中の閉じタグを逃がす() {
        let options = StandaloneOptions {
            css: Some(vec![".a::after { content: \"</style>\"; }".to_string()]),
            runtime: Some(StandaloneRuntimeOverride {
                script: Some("var s = \"</script>\";".to_string()),
                style: None,
            }),
            ..Default::default()
        };
        let html = render_standalone_page(&options, &value(r#"{"parsed":{}}"#), &runtime())
            .expect("組み立てられる");
        assert!(html.contains("var s = \"<\\/script>\";"));
        assert!(html.contains("content: \"<\\/style>\";"));
        assert!(!html.contains(&runtime().script));
    }

    #[test]
    fn standalone_閉じタグの置き換えは大文字も拾い小文字で書く() {
        assert_eq!(
            escape_closing_tag("a</SCRIPT>b</Script </scrip", "script"),
            "a<\\/script>b<\\/script </scrip"
        );
        assert_eq!(
            escape_closing_tag("あ</StYlE>い", "style"),
            "あ<\\/style>い"
        );
        assert_eq!(escape_closing_tag("", "style"), "");
    }

    #[test]
    fn standalone_lang_コンテナのクラス_追加の_css_head_の追加を指定したときだけ入れる() {
        let data = value(r#"{"parsed":{}}"#);
        let plain = render_standalone_page(&StandaloneOptions::default(), &data, &runtime())
            .expect("組み立てられる");
        assert!(plain.contains("<html>\n"));
        assert_eq!(plain.matches("<style>").count(), 2);

        let options = StandaloneOptions {
            lang: Some("ja".to_string()),
            container_class: Some(" zu-markdag \u{3000}print\u{FEFF} ".to_string()),
            css: Some(vec![
                ".markdag { --markdag-bg: #000; }".to_string(),
                ".b {}".to_string(),
            ]),
            head: Some("<meta name=\"color-scheme\" content=\"dark\">".to_string()),
            ..Default::default()
        };
        let html = render_standalone_page(&options, &data, &runtime()).expect("組み立てられる");
        assert!(html.contains("<html lang=\"ja\">"));
        assert!(html.contains(&format!(
            "<div class=\"{CONTAINER_CLASS} zu-markdag print\"></div>"
        )));
        assert_eq!(html.matches("<style>").count(), 3);
        assert!(html.contains("<style>\n.markdag { --markdag-bg: #000; }\n.b {}\n</style>"));
        assert!(html.contains(&format!(
            ".{CONTAINER_CLASS} {{ width: 100%; height: 100vh; height: 100dvh; }}"
        )));
        assert!(html.contains("<meta name=\"color-scheme\" content=\"dark\">\n</head>"));
    }

    #[test]
    fn standalone_解析結果も原文もないとき_逃がせないランタイムのときは断る() {
        let none = render_standalone_page(&StandaloneOptions::default(), &value("{}"), &runtime());
        assert_eq!(
            none.map_err(|error| error.message),
            Err("parsed か source のどちらかが要ります".to_string())
        );
        assert!(
            render_standalone_page(
                &StandaloneOptions::default(),
                &value(r##"{"source":"# a"}"##),
                &runtime()
            )
            .is_ok()
        );
        // null は undefined ではないので通る (原文の `=== undefined`)
        assert!(
            render_standalone_page(
                &StandaloneOptions::default(),
                &value(r#"{"parsed":null}"#),
                &runtime()
            )
            .is_ok()
        );
        let with = |script: &str| StandaloneOptions {
            runtime: Some(StandaloneRuntimeOverride {
                script: Some(script.to_string()),
                style: None,
            }),
            ..Default::default()
        };
        let data = value(r#"{"parsed":{}}"#);
        let refused = render_standalone_page(
            &with("var a = 1; /* <!-- */ var b = \"<SCRIPT>\";"),
            &data,
            &runtime(),
        );
        assert!(refused.is_err_and(|error| error.message.contains("埋め込めません")));
        assert!(render_standalone_page(&with("var a = \"<!--\";"), &data, &runtime()).is_ok());
        // `<script` が `<!--` より前だけにあるなら断らない
        assert!(render_standalone_page(&with("\"<script>\" <!--"), &data, &runtime()).is_ok());
    }

    #[test]
    fn standalone_素材の欄は_json_stringify_と同じ文字列にする() {
        // 数の書き方、有限でない数、制御文字の逃がし、整数に見えるキーの順 (js_json_stringify)
        let data = JsValue::Object(IndexMap::from([
            (
                "types".to_string(),
                JsValue::Object(IndexMap::from([
                    ("b".to_string(), JsValue::Number(1e-6)),
                    ("2".to_string(), JsValue::Number(f64::NAN)),
                    (
                        "a".to_string(),
                        JsValue::Array(vec![
                            JsValue::Number(1e21),
                            JsValue::Undefined,
                            JsValue::Number(-0.0),
                        ]),
                    ),
                    (
                        "c".to_string(),
                        JsValue::String("\u{0001}\"\\/\u{007f}😀".to_string()),
                    ),
                    ("u".to_string(), JsValue::Undefined),
                ])),
            ),
            ("source".to_string(), JsValue::String("x".to_string())),
            ("other".to_string(), JsValue::Bool(true)),
        ]));
        let html = render_standalone_page(&StandaloneOptions::default(), &data, &runtime())
            .expect("組み立てられる");
        assert_eq!(
            embedded(&html),
            "{\"source\":\"x\",\"types\":{\"2\":null,\"b\":0.000001,\"a\":[1e+21,null,0],\"c\":\"\\u0001\\\"\\\\/\u{007f}😀\"}}"
        );
    }
}

// PORT STATUS: confidence=high todos=0

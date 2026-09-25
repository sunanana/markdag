// 原文: sample/markmap/packages/markmap-lib/src/markdown-it.ts (initializeMarkdownIt) (2026-09-24)
// comrak の設定と、markdown-it のプラグイン (ins / mark / sub / sup) にあたるインラインの記法と、数式の印。
// markdown-it は `html: true, breaks: true` に ins / mark / sub / sup のプラグイン。comrak ではそれぞれ unsafe (生の HTML を残す)、
// hardbreaks、拡張の insert / highlight / subscript / superscript にあたる。記号の `[ ]` は自前で扱うので tasklist は使わない。
// 数式は `$…$` と `$$…$$` を comrak の math_dollars で読み、飾らずに印の要素 (mdag-math / mdag-math-block) にする。
// 飾り (KaTeX) は TS の包みが features.math を見て後から当てる (決定 2、12)。
use comrak::Options;
use comrak::nodes::NodeValue;

use super::html::escape_html;

/// 解析に使う comrak の設定 (DESIGN (a) の crate の行)
pub(super) fn comrak_options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = false;
    options.extension.highlight = true;
    options.extension.insert = true;
    options.extension.subscript = true;
    options.extension.superscript = true;
    options.extension.math_dollars = true;
    options.parse.smart = false;
    options.render.r#unsafe = true;
    options.render.hardbreaks = true;
    options.render.sourcepos = true;
    options
}

/// ==x== ++x++ ~x~ ^x^ を書く要素の名前
pub(super) fn mark_tag(value: &NodeValue) -> Option<&'static str> {
    match value {
        NodeValue::Highlight => Some("mark"),
        NodeValue::Insert => Some("ins"),
        NodeValue::Subscript => Some("sub"),
        NodeValue::Superscript => Some("sup"),
        _ => None,
    }
}

/// 数式の印の要素。中身は区切りの `$` を除いた TeX
pub(super) fn render_math(literal: &str, display: bool) -> String {
    if display {
        format!(
            "<div class=\"mdag-math-block\">{}</div>",
            escape_html(literal)
        )
    } else {
        format!("<span class=\"mdag-math\">{}</span>", escape_html(literal))
    }
}

// PORT STATUS: confidence=high todos=0

// 本文の診断。解析の結果 (ParsedDocument) は診断を持たないので、model 層が原文を受けたときに、解析と同じ読み方で本文を読み直して出す。
// 出すのは、図に出ない書き方のうち書き手が気づきにくいもの: 上限より深い入れ子 (A-105) と、見出しやリストと同じ並びに置いた
// 生の HTML の見出し (A-112)。どちらも当たりうる文書だけを読み直すよう、先に原文の文字で絞る (多くの文書は comrak を 2 度走らせない)。
use std::sync::LazyLock;

use comrak::Arena;
use comrak::nodes::{AstNode, NodeValue};
use regex::Regex;

use super::document::{
    normalize_task_marks, probe_frontmatter, read_frontmatter, strip_annotations,
};
use super::outline::{normalize_source, parse_body, too_deep_nodes};
use crate::limits::{MAX_NESTING, too_deep_message};
use crate::model::util::js_slice;
use crate::types::{Diagnostic, Severity, SourcePosition};

// 原文に HTML の見出しの開きのタグ (`<h1>`〜`<h6>`、属性つきと `<h2/>` を含む) がありうるか。CommonMark の HTML ブロックの
// 始まりの規則 6 と同じ区切り。先の絞り込みだけに使い、位置は html_headings がコメントと生の文字の要素を飛ばして探す
static HTML_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<h[1-6](?:[ \t/>\r\n]|$)").expect("固定の正規表現"));

// 中身を HTML として読まない要素 (生の文字の要素と、字を逃がす生の文字の要素)。この中の `<h1>` は見出しにならない
const RAW_TEXT_ELEMENTS: [&str; 4] = ["script", "style", "textarea", "title"];

// 行頭の入れ物の印 (字下げ、`>`、リストの印) の読み取りの結果
struct LinePrefix {
    // 印の桁の数 (タブは 4 の倍数まで進めて数える)。入れ物 (リストと引用) の 1 段には行頭の 1 桁以上が要るので、
    // 桁の数は行頭で開いている入れ物の段数以上
    columns: usize,
    // 印のあとの字の先頭のバイト位置
    rest: usize,
    // 段落を切るリストの印 (`-` `+` `*` と `1.` `1)`) の最初のものの桁。段落を切れない `2.` などは数えない
    item_column: Option<usize>,
}

fn line_prefix(line: &[u8]) -> LinePrefix {
    let mut columns = 0;
    let mut index = 0;
    let mut item_column = None;
    let separated = |at: usize| matches!(line.get(at), Some(b' ' | b'\t'));
    while let Some(&byte) = line.get(index) {
        match byte {
            b' ' | b'>' => {
                columns += 1;
                index += 1;
            }
            b'\t' => {
                columns += 4 - columns % 4;
                index += 1;
            }
            b'-' | b'+' | b'*' if separated(index + 1) => {
                item_column = item_column.or(Some(columns));
                columns += 1;
                index += 1;
            }
            b'0'..=b'9' => {
                let digits = line
                    .iter()
                    .skip(index)
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
                let marker = index + digits;
                if digits > 9
                    || !matches!(line.get(marker), Some(b'.' | b')'))
                    || !separated(marker + 1)
                {
                    break;
                }
                if byte == b'1' && digits == 1 {
                    item_column = item_column.or(Some(columns));
                }
                columns += digits + 1;
                index = marker + 1;
            }
            _ => break,
        }
    }
    LinePrefix {
        columns,
        rest: index,
        item_column,
    }
}

// 上限を越える入れ子がありうるか (先の絞り込み。ありえないと言えたら comrak で読み直さない)。
// 入れ子の段は、行頭で開いている入れ物 (リストと引用) と、段落の中のインラインの入れ物 (強調、リンク、画像、~ ^ == ++) の和。
// 入れ物の段数は行頭の桁の数以下 (LinePrefix)。インラインの入れ物の 1 段には、同じ段落に少なくとも 1 字の印
// (`*` `_` `[` `~` `^` `=` `+`) が要る。行のまとまり (段落の候補) ごとに
// 「行頭の桁の最大 + 行頭より後ろの印の字の数 + 1 (角括弧の自動リンク。リンクの中にリンクは入らないので 1 段まで)」を上限と比べる。
// まとまりは空の行と、確かに段落を切るリストの項目の始まりで切る。項目の印の桁がまとまりの行の本文の桁の最小以下なら、
// 印は続いている段落の入れ物の本文の桁 + 3 以下にあり (段落の最初の行は入れ物の本文の桁から 3 桁までしか下げられない)、
// 段落の続きにならない (段落は空の行と項目の始まりをまたがないので、最初の行は同じまとまりにある)。
// どのまとまりも上限以下なら、上限を越える入れ子はない (見逃しはなく、越えうると言いすぎるだけ)
fn may_be_too_deep(markdown: &str) -> bool {
    let mut columns = 0;
    let mut marks = 0;
    // まとまりの行の本文の桁の最小
    let mut text_column: Option<usize> = None;
    for line in markdown.as_bytes().split(|&byte| byte == b'\n') {
        if line.iter().all(|byte| matches!(byte, b' ' | b'\t' | b'\r')) {
            (columns, marks, text_column) = (0, 0, None);
            continue;
        }
        let prefix = line_prefix(line);
        let text = line.get(prefix.rest..).unwrap_or_default();
        let has_text = text
            .iter()
            .any(|byte| !matches!(byte, b' ' | b'\t' | b'\r'));
        if has_text
            && let (Some(item), Some(start)) = (prefix.item_column, text_column)
            && item <= start
        {
            (columns, marks, text_column) = (0, 0, None);
        }
        text_column = Some(text_column.map_or(prefix.columns, |start| start.min(prefix.columns)));
        columns = columns.max(prefix.columns);
        marks += text
            .iter()
            .filter(|byte| matches!(byte, b'*' | b'_' | b'[' | b'~' | b'^' | b'=' | b'+'))
            .count();
        if columns + marks + 1 > MAX_NESTING {
            return true;
        }
    }
    false
}

/// 原文から本文の診断を作る。markdown は build_model が受けた原文 (parse_document に渡したものと同じ)
pub fn body_diagnostics(markdown: &str) -> Vec<Diagnostic> {
    // 前処理は字を取るだけなので、原文で当たらなければ前処理のあとも当たらない。先に原文で安く絞る
    if !may_be_too_deep(markdown) && !HTML_HEADING.is_match(markdown) {
        return Vec::new();
    }
    // parse_document と同じ前処理 (記号の大文字、markdag の文書なら注釈の取り除き) と本文の切り出し
    // (frontmatter が YAML として読めなければ本文に残る)。注釈の字 (`#k:***` など) を入れ子に数えない
    let source = normalize_task_marks(markdown);
    let text = if probe_frontmatter(&source).extracted {
        strip_annotations(&source).text
    } else {
        source
    };
    let read = read_frontmatter(&text);
    let (body, frontmatter_lines) = match &read {
        Some(info) => (js_slice(&text, info.offset, text.len()), info.lines),
        None => (text.as_str(), 0),
    };
    let body = normalize_source(body);
    let deep = may_be_too_deep(&body);
    let heading = HTML_HEADING.is_match(&body);
    if !deep && !heading {
        return Vec::new();
    }
    let lines: Vec<&str> = body.split('\n').collect();
    let arena = Arena::new();
    let document = parse_body(&arena, &body);
    let mut diagnostics = Vec::new();
    if heading {
        diagnostics.extend(html_headings(document, &lines, frontmatter_lines));
    }
    if deep && let Some(first) = too_deep_nodes(document).first() {
        let start = first.data().sourcepos.start;
        let at = position(&lines, frontmatter_lines, start.line, start.column, None);
        diagnostics.push(Diagnostic {
            severity: Severity::Error,
            code: "nesting-too-deep".to_string(),
            message: format!(
                "{}。これより深い部分は図に出ません",
                too_deep_message(MAX_NESTING)
            ),
            at,
            hint: Some("リスト、引用、強調などの入れ子を浅くします".to_string()),
        });
    }
    diagnostics
}

// 見出しやリストと同じ並び (文書の直下) の HTML ブロックのうち、HTML の見出しを含むもの。アウトラインはこのブロックを丸ごと捨てる。
// リストの項目の中の HTML ブロックは項目の内容として図に出るので数えない。1 つのブロックにつき最初の見出しを指す
fn html_headings<'a>(
    document: &'a AstNode<'a>,
    lines: &[&str],
    frontmatter_lines: usize,
) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    for block in document.children() {
        let data = block.data();
        if !matches!(data.value, NodeValue::HtmlBlock(_)) {
            continue;
        }
        let (first, last) = (data.sourcepos.start.line, data.sourcepos.end.line);
        let block_lines: Vec<&str> = lines
            .iter()
            .skip(first.saturating_sub(1))
            .take((last.max(first) + 1).saturating_sub(first.max(1)))
            .copied()
            .collect();
        let Some((line_index, column, length)) = first_heading(&block_lines) else {
            continue;
        };
        diagnostics.push(Diagnostic {
            severity: Severity::Info,
            code: "html-heading-ignored".to_string(),
            message: "この HTML の見出しは図に出ません。## 見出し で書きます".to_string(),
            at: position(
                lines,
                frontmatter_lines,
                first.max(1) + line_index,
                column,
                Some(length),
            ),
            hint: Some(
                "見出しやリストと同じ並びに置いた生の HTML のブロックは、図のノードになりません"
                    .to_string(),
            ),
        });
    }
    diagnostics
}

// HTML のブロックの行のうち、最初の見出しの開きのタグの (ブロックの中の行の添字、バイトの桁 (1 始まり)、`>` までの文字数)。
// コメント (`<!-- -->`) と生の文字の要素 (`<script>` など) の中は HTML の要素にならないので飛ばす。どちらも行をまたげる
fn first_heading(block_lines: &[&str]) -> Option<(usize, usize, usize)> {
    let text = block_lines.join("\n");
    // ASCII の大文字だけを小文字にするので、バイト位置は text と同じ
    let lower = text.to_ascii_lowercase();
    let mut at = 0;
    while let Some(offset) = lower.get(at..).and_then(|rest| rest.find('<')) {
        at += offset;
        let rest = lower.get(at..).unwrap_or_default();
        if rest.starts_with("<!--") {
            at = skip_past(&lower, at + 4, "-->");
            continue;
        }
        if let Some(name) = RAW_TEXT_ELEMENTS
            .iter()
            .find(|name| open_tag_named(rest, name))
        {
            at = skip_past(&lower, at + 1 + name.len(), &format!("</{name}"));
            continue;
        }
        if !is_heading_tag(rest) {
            at += 1;
            continue;
        }
        let before = text.get(..at).unwrap_or_default();
        let line_index = before.matches('\n').count();
        let line_start = before.rfind('\n').map_or(0, |index| index + 1);
        let line_end = text
            .get(at..)
            .and_then(|tail| tail.find('\n'))
            .map_or(text.len(), |index| at + index);
        // タグの閉じの `>` まで (行の中になければ行末まで)
        let end = text
            .get(at..line_end)
            .and_then(|tail| tail.find('>'))
            .map_or(line_end, |index| at + index + 1);
        let length = text.get(at..end).unwrap_or_default().chars().count();
        return Some((line_index, at - line_start + 1, length));
    }
    None
}

// text の from から探して、needle の後ろの位置。なければ末尾
fn skip_past(text: &str, from: usize, needle: &str) -> usize {
    text.get(from..)
        .and_then(|rest| rest.find(needle))
        .map_or(text.len(), |index| from + index + needle.len())
}

// rest (小文字にしたもの) が `<name` の開きのタグで始まるか (名前の後ろが空白、`>`、`/` か末尾)
fn open_tag_named(rest: &str, name: &str) -> bool {
    rest.strip_prefix('<')
        .and_then(|tail| tail.strip_prefix(name))
        .is_some_and(|tail| {
            matches!(
                tail.bytes().next(),
                None | Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
            )
        })
}

// rest (小文字にしたもの) が `<h1`〜`<h6` の開きのタグで始まるか
fn is_heading_tag(rest: &str) -> bool {
    let mut bytes = rest.bytes();
    bytes.next() == Some(b'<')
        && bytes.next() == Some(b'h')
        && matches!(bytes.next(), Some(b'1'..=b'6'))
        && matches!(
            bytes.next(),
            None | Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
        )
}

// 本文の行 (1 始まり) とバイトの桁 (1 始まり) を、原文の行と文字の桁の位置にする。length がなければ行末までの文字数
fn position(
    lines: &[&str],
    frontmatter_lines: usize,
    line: usize,
    column: usize,
    length: Option<usize>,
) -> Option<SourcePosition> {
    let text = lines.get(line.checked_sub(1)?)?;
    let byte = column.saturating_sub(1).min(text.len());
    let before = text.get(..byte)?;
    let rest = text.get(byte..)?;
    let to_u32 = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
    Some(SourcePosition {
        line: to_u32(line + frontmatter_lines),
        column: to_u32(before.chars().count() + 1),
        length: to_u32(length.unwrap_or_else(|| rest.chars().count())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(markdown: &str) -> Vec<(String, Option<SourcePosition>)> {
        body_diagnostics(markdown)
            .into_iter()
            .map(|item| (item.code, item.at))
            .collect()
    }

    fn at(line: u32, column: u32, length: u32) -> Option<SourcePosition> {
        Some(SourcePosition {
            line,
            column,
            length,
        })
    }

    #[test]
    fn notes_html_heading_at_top_level_is_reported() {
        assert_eq!(
            codes("# R\n\n<h2>raw heading</h2>\n\n- a\n"),
            vec![("html-heading-ignored".to_string(), at(3, 1, 4))]
        );
        // 属性つき、大文字、字下げ、frontmatter の行を足す
        assert_eq!(
            codes("---\ntitle: t\n---\n# R\n\n  <H3 class=\"x\">t</H3>\n"),
            vec![("html-heading-ignored".to_string(), at(6, 3, 14))]
        );
        // 1 つのブロックに見出しが 2 つあっても 1 件
        assert_eq!(codes("<div>\n<h2>a</h2>\n<h3>b</h3>\n</div>\n").len(), 1);
    }

    #[test]
    fn notes_html_heading_inside_items_or_code_is_not_reported() {
        // 項目の中の HTML ブロックは項目の内容として図に出る。コードの中と、見出しでない h のタグ (<hr>、<header>) は当たらない
        for markdown in [
            "- a\n\n  <h2>in item</h2>\n",
            "```\n<h2>code</h2>\n```\n",
            "    <h2>indented code</h2>\n",
            "<hr>\n\n<header>x</header>\n",
            "text <h2>inline</h2>\n",
        ] {
            assert_eq!(codes(markdown), Vec::new(), "{markdown:?}");
        }
    }

    #[test]
    fn notes_html_heading_in_comments_and_raw_text_is_not_reported() {
        for markdown in [
            "# R\n\n<!-- <h2>x</h2> -->\n",
            "# R\n\n<!--\n<h2>x</h2>\n-->\n",
            "# R\n\n<script>\nel.innerHTML = \"<h1>x</h1>\";\n</script>\n",
            "# R\n\n<style>\n/* <h2> */\n</style>\n",
            "# R\n\n<div>\n<textarea><h3>x</h3></textarea>\n</div>\n",
        ] {
            assert_eq!(codes(markdown), Vec::new(), "{markdown:?}");
        }
        // コメントと生の文字の要素の後ろの見出しは数える (位置はその見出し)
        assert_eq!(
            codes("# R\n\n<div><!-- <h1> --><script>\"<h2>\"</script>\n<h3 id=a>x</h3>\n</div>\n"),
            vec![("html-heading-ignored".to_string(), at(4, 1, 9))]
        );
    }

    #[test]
    fn notes_annotations_are_not_counted_as_nesting() {
        // 行の末尾のタグ (#k:値) は解析の前処理で取り除くので、値に入れ子の印の字が並んでも入れ子にならない
        for mark in ["*", "_", "^"] {
            let run = mark.repeat(1100);
            let markdown = format!("---\nmarkdag: {{}}\n---\n# R\n\n- a #k:{run}x{run}\n");
            assert_eq!(codes(&markdown), Vec::new(), "{mark}");
        }
        // markdag の文書でなければ注釈を取り除かないので、同じ行は入れ子として数える (図も同じく欠ける)
        let run = "*".repeat(1100);
        assert_eq!(codes(&format!("# R\n\n- a #k:{run}x{run}\n")).len(), 1);
    }

    #[test]
    fn notes_prefilter_skips_plain_documents() {
        assert!(!may_be_too_deep("# a\n- b\n- c\n"));
        // 段落の区切り (空の行、項目の始まり) ごとに数えるので、長い平らなリストは当たらない
        let flat: String = (0..2000)
            .map(|i| format!("- **b{i}** _x_ [l](u)\n"))
            .collect();
        assert!(!may_be_too_deep(&flat));
        let loose: String = (0..2000).map(|i| format!("*a{i}*\n\n")).collect();
        assert!(!may_be_too_deep(&loose));
        // 行頭の桁で数えるので、1 行のリストの印 (1 段に 2 桁) は段数の約 2 倍で当たる (言いすぎる側)
        assert!(may_be_too_deep(&format!(
            "{}a",
            "- ".repeat(MAX_NESTING / 2)
        )));
        assert!(!may_be_too_deep(&format!(
            "{}a",
            "- ".repeat(MAX_NESTING / 2 - 1)
        )));
    }

    // 絞り込みの見逃しがないこと: 上限を越える入れ子のある文書は、どの形でも絞り込みを通る
    #[test]
    fn notes_prefilter_never_misses_too_deep_documents() {
        let deep = MAX_NESTING + 1;
        let list_lines = |prefix: &dyn Fn(usize) -> String| -> String {
            (0..deep).map(|i| format!("{}x{i}\n", prefix(i))).collect()
        };
        let cases: Vec<String> = vec![
            list_lines(&|i| format!("{}- ", "  ".repeat(i))),
            list_lines(&|i| format!("{}- ", "\t".repeat(i))),
            list_lines(&|i| format!("{}1. ", "   ".repeat(i))),
            list_lines(&|i| format!("{} ", ">".repeat(i + 1))),
            list_lines(&|i| format!("{}- > ", "    ".repeat(i))),
            format!("{}a{}", "**".repeat(deep), "**".repeat(deep)),
            format!("{}a{}", "![".repeat(deep), "](u)".repeat(deep)),
            // 強調が段落の中で行をまたぐ
            format!(
                "{}a\n{}",
                (0..deep).map(|_| "**b\n").collect::<String>(),
                (0..deep).map(|_| "c**\n").collect::<String>()
            ),
            // 段落の続きの行に項目の印に見える字がある (字下げが深いので項目にならない)
            format!(
                "{}a\n{}",
                (0..deep).map(|_| "**b\n        - x\n").collect::<String>(),
                (0..deep).map(|_| "c**\n").collect::<String>()
            ),
            // `2.` は段落を切れない
            format!(
                "{}a\n{}",
                (0..deep).map(|_| "**b\n2. x\n").collect::<String>(),
                (0..deep).map(|_| "c**\n").collect::<String>()
            ),
            // 字下げのコードのあとの段落の続き
            format!(
                "    code\n{}a\n{}",
                (0..deep).map(|_| "**b\n    - x\n").collect::<String>(),
                (0..deep).map(|_| "c**\n").collect::<String>()
            ),
            // 深いリストの中の強調
            format!(
                "{}{}{}a{}\n",
                (0..300)
                    .map(|i| format!("{}- x\n", "  ".repeat(i)))
                    .collect::<String>(),
                "  ".repeat(300),
                "**".repeat(250),
                "**".repeat(250)
            ),
        ];
        for markdown in cases {
            let arena = Arena::new();
            let body = normalize_source(&markdown);
            let document = parse_body(&arena, &body);
            // どの形も実際に上限を越える (試験の入力の確かめ)
            // どの形も実際に上限を越える (試験の入力の確かめ)
            assert!(
                !too_deep_nodes(document).is_empty(),
                "{:?}",
                markdown.get(..80)
            );
            assert!(may_be_too_deep(&markdown), "{:?}", markdown.get(..80));
        }
    }
}

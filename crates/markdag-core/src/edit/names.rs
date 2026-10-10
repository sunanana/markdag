// 原文なし。
// 名前の行の書き方と、入力の改行の読み方。名前の入力を 1 行の本文にし (改行は空白)、1 行目の行頭と本文のあとを残して本文だけを差し替えるか、
// 足すノードの行頭のあとに置く。入れた名前がそのまま名前として読まれるよう、印に化ける語、ブロックに化ける書き始め、見出しの閉じの記号に化ける末尾を
// `\` で逃がす。そのうえで行の全体 (行頭、名前、本文のあとの印) を読み、名前が行頭や後ろの印と合わさってタスクの記号か区切り線に読まれるなら、
// 名前の先頭にも `\` を足す (今の逃がしは外さず、足りない所にだけ足す)。逃がしは文書の markdag キーの有無によらず行う
// (あとで markdag: が足されても読み方が変わらない)。
// 名前の入力の初めの値は、1 行目の本文からこの逃がしと同じ所の `\` を外したもの (GUI 編集ではユーザーに `\` を見せない)。
use std::sync::LazyLock;

use regex::Regex;

use super::blocks::{BOM, FirstLine};
use crate::model::util::js_trim;
use crate::parse::task::{TaskLineKind, task_mark_at};
use crate::parse::{LineBlock, line_block, trailing_marks};

// 名前の入力の改行。\r\n は 1 つの改行として空白 1 つにする
static LINE_BREAKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\r\n|[\r\n\u{2028}\u{2029}]").expect("固定の正規表現"));
// タスクの記号に読まれる書き始め
static TASK_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[[ xX/-]\][ \t]").expect("固定の正規表現"));
// 見出しの末尾で閉じの記号に読まれる # の並び
static CLOSING_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[ \t])(#+)$").expect("固定の正規表現"));
// 区切り線 (同じ字の -、*、_ が 3 つ以上で、間と後ろに空白だけ)。字下げを外した行頭と名前の行に当てる
static THEMATIC_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$").expect("固定の正規表現")
});
// 逃がしが足しうる \ (逃がしたあとの本文の中): 番号付きのリストの区切りの字の前、印の字の前、見出しの末尾の # の並びの前。
// どれも ASCII の記号の前の \ (CommonMark の逃がし) で、外しても名前の前後に空白はできない
static ESCAPED_ORDERED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+(\\)[.)]").expect("固定の正規表現"));
static ESCAPED_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[ \t])(\\)[#%$]").expect("固定の正規表現"));
static ESCAPED_CLOSING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[ \t])(\\)#+$").expect("固定の正規表現"));

/// 名前の入力を 1 行の本文にする: 改行 (\r\n、\r、\n、U+2028、U+2029) を空白 1 つにし、前後の空白を外す
pub(super) fn normalize_label(label: &str) -> String {
    js_trim(&LINE_BREAKS.replace_all(label, " ")).to_string()
}

/// 複数行の入力 (詳細) を、名前の入力と同じ改行 (\r\n は 1 つの改行) で行に分ける
pub(super) fn input_lines(text: &str) -> Vec<&str> {
    LINE_BREAKS.split(text).collect()
}

/// 1 行目の本文を name (normalize_label を当てた空でないもの) にした行。行頭、本文のあと、行末の \r は残す
pub(super) fn name_line(first: &FirstLine<'_>, name: &str, heading: bool) -> String {
    let lead = name_lead(first);
    let body = escaped(&lead, name, first.rest, heading);
    format!("{lead}{body}{}{}", first.rest, first.carriage)
}

/// 名前の入力の初めの値: 1 行目の本文から、名前の変更の逃がしが足すのと同じ所の `\` を外したもの (外した名前を逃がすと本文に戻る)。
/// 外し方が何通りかあれば多く外すもの。どの外し方でも本文に戻らなければ本文のまま (逃がしが足さない所の `\` は残る)
pub(super) fn input_label(first: &FirstLine<'_>, heading: bool) -> String {
    let body = first.body;
    if !body.contains('\\') {
        return body.to_string();
    }
    let lead = name_lead(first);
    // 本文の先頭 (ブロックとタスクの記号に化ける書き始め)、番号の区切りの字の前、見出しの閉じの記号の前は、どの組み合わせでも試す
    let mut fixed: Vec<usize> = Vec::new();
    if body.starts_with('\\') && body[1..].starts_with(|c: char| c.is_ascii_punctuation()) {
        fixed.push(0);
    }
    fixed.extend(backslash_of(&ESCAPED_ORDERED, body));
    if heading {
        fixed.extend(backslash_of(&ESCAPED_CLOSING, body));
    }
    fixed.sort_unstable();
    fixed.dedup();
    // 印の字の前は、逃がしが末尾の最後の印にだけ足すので 1 つまで。外すとその印が行の末尾の最後の印になる所だけを試す
    let marks: Vec<usize> = ESCAPED_MARK
        .captures_iter(body)
        .filter_map(|found| found.get(1).map(|slash| slash.start()))
        .filter(|at| !fixed.contains(at))
        .filter(|&at| {
            let line = format!("{lead}{}", without_backslashes(body, &[at]));
            trailing_marks(&line)
                .last()
                .is_some_and(|mark| mark.token.start == lead.len() + at)
        })
        .collect();
    let mut choices: Vec<Vec<usize>> = Vec::new();
    for mark in std::iter::once(None).chain(marks.into_iter().map(Some)) {
        for mask in 0..1_usize << fixed.len() {
            let mut at: Vec<usize> = fixed
                .iter()
                .enumerate()
                .filter(|(bit, _)| mask & (1 << bit) != 0)
                .map(|(_, &offset)| offset)
                .chain(mark)
                .collect();
            if !at.is_empty() {
                at.sort_unstable();
                choices.push(at);
            }
        }
    }
    choices.sort_by_key(|at| std::cmp::Reverse(at.len()));
    choices
        .iter()
        .map(|at| without_backslashes(body, at))
        .find(|name| escaped(&lead, name, first.rest, heading) == body)
        .unwrap_or_else(|| body.to_string())
}

// 名前の前に置く行頭。空の項目と空の見出し (印で行が終わる) は、印と本文の間に空白を 1 つ置く。
// 文書の先頭の BOM だけの行頭 (下線の見出し) は、行頭のない行と同じ
fn name_lead(first: &FirstLine<'_>) -> String {
    let lead = first.lead.trim_start_matches(BOM);
    if lead.is_empty() || lead.ends_with([' ', '\t']) {
        first.lead.to_string()
    } else {
        format!("{} ", first.lead)
    }
}

// 正規表現の 1 番の組 (\ の 1 字) の位置
fn backslash_of(pattern: &Regex, body: &str) -> Option<usize> {
    pattern
        .captures(body)
        .and_then(|found| found.get(1))
        .map(|slash| slash.start())
}

// 本文から、バイトの位置 at (どれも \ の位置) の字を外したもの
fn without_backslashes(body: &str, at: &[usize]) -> String {
    body.char_indices()
        .filter(|(offset, _)| !at.contains(offset))
        .map(|(_, c)| c)
        .collect()
}

/// 足すノードの行 (行末の \r を含まない): 行頭 lead のあとに name (normalize_label を当てたもの) を逃がして置く。
/// 空の名前では行末の空白を残さない
pub(super) fn added_line(lead: &str, name: &str, heading: bool) -> String {
    if name.is_empty() {
        return lead.trim_end_matches([' ', '\t']).to_string();
    }
    format!("{lead}{}", escaped(lead, name, "", heading))
}

/// 見出しの行頭 lead (`## ` など) と本文のあと rest の間に置く本文 (原文の字) を、名前の変更と同じ逃がしで、その行で同じ名前に読まれるようにしたもの
/// (印を読まない見出しを ATX の見出しに書き直すとき、印や閉じの記号に読まれる字の前に `\` を置く)
pub(super) fn heading_body(lead: &str, body: &str, rest: &str) -> String {
    escaped(lead, body, rest, true)
}

/// タスクの記号を外して行頭 lead のすぐあとに来る本文 (原文の字) を、同じ名前に読まれるように逃がしたもの。
/// 記号を外して位置が変わるのは本文の書き始めだけなので、書き始めがブロックかタスクの記号に読まれるときと、行頭や本文のあと rest と
/// 合わさってタスクの記号か区切り線に読まれるときだけ `\` を足す (本文の中と末尾は記号があったときと同じ読み方なので足さない)。
/// HTML のブロックの書き始めは逃がさない (逃がすと HTML が文字になり、Markdown として読んだときの見た目が変わる。
/// 外すと HTML のブロックが下線の行を飲み込んで見出しでなくなる下線の見出しのタスクは、呼ぶ側が外さない)
pub(super) fn unmarked_body(lead: &str, body: &str, rest: &str, heading: bool) -> String {
    if body.is_empty() {
        return String::new();
    }
    let mut at: Vec<usize> = Vec::new();
    match line_block(body) {
        LineBlock::Paragraph | LineBlock::Html => {}
        LineBlock::OrderedList => at.push(body.bytes().take_while(u8::is_ascii_digit).count()),
        LineBlock::Other => at.push(0),
    }
    if TASK_LIKE.is_match(body) {
        at.push(0);
    }
    at.sort_unstable();
    at.dedup();
    if !at.contains(&0) {
        let written = with_backslashes(body, &at);
        if task_from_name(lead, &written, rest, heading) || thematic_break(lead, &written) {
            at.insert(0, 0);
        }
    }
    with_backslashes(body, &at)
}

// 行頭 lead と本文のあと rest (空白、見出しの閉じの記号、末尾の印) の間に置く名前を逃がしたもの
fn escaped(lead: &str, name: &str, rest: &str, heading: bool) -> String {
    let mut at = name_escapes(lead, name, heading);
    // 行の全体: 名前だけの逃がしを当てても、行頭や後ろの印と合わさってタスクの記号か区切り線に読まれるなら、名前の先頭の字の前
    if !at.contains(&0) {
        let written = with_backslashes(name, &at);
        if task_from_name(lead, &written, rest, heading) || thematic_break(lead, &written) {
            at.insert(0, 0);
        }
    }
    with_backslashes(name, &at)
}

// 行頭 lead のあとに置く名前だけを読んで逃がす位置 (名前の中のバイトの位置。昇順で重なりなし)
fn name_escapes(lead: &str, name: &str, heading: bool) -> Vec<usize> {
    let mut at: Vec<usize> = Vec::new();
    // ブロックに化ける書き始め: 番号付きのリストは区切りの字の前、それ以外は先頭の字の前
    match line_block(name) {
        LineBlock::Paragraph => {}
        LineBlock::OrderedList => at.push(name.bytes().take_while(u8::is_ascii_digit).count()),
        LineBlock::Html | LineBlock::Other => at.push(0),
    }
    if TASK_LIKE.is_match(name) {
        at.push(0);
    }
    // 印に化ける語: 行頭と名前だけの行の末尾から印が 1 つでも取れるなら、名前の最後の語の印の字の前
    let line = format!("{lead}{name}");
    if let Some(offset) = trailing_marks(&line)
        .last()
        .and_then(|mark| mark.token.start.checked_sub(lead.len()))
    {
        at.push(offset);
    }
    // 見出しの閉じの記号に化ける末尾の # の並び: 並びの最初の # の前
    if heading && let Some(run) = CLOSING_RUN.captures(name).and_then(|found| found.get(1)) {
        at.push(run.start());
    }
    at.sort_unstable();
    at.dedup();
    at
}

// 名前のバイトの位置 at (昇順) の字の前に \ を置いたもの
fn with_backslashes(name: &str, at: &[usize]) -> String {
    let mut out = String::with_capacity(name.len() + at.len());
    let mut from = 0;
    for &offset in at {
        out.push_str(&name[from..offset]);
        out.push('\\');
        from = offset;
    }
    out.push_str(&name[from..]);
    out
}

// 行頭がタスクの記号を持たず、行頭、名前 (written)、本文のあとをつなげた行を解析がタスクに読むか (名前の先頭がタスクの記号に読まれる)
fn task_from_name(lead: &str, written: &str, rest: &str, heading: bool) -> bool {
    let kind = if heading {
        TaskLineKind::Heading
    } else {
        TaskLineKind::Item
    };
    let lead = lead.trim_start_matches(BOM);
    task_mark_at(&format!("{lead}{written}{rest}"), kind).is_some()
        && task_mark_at(&format!("{lead}x"), kind).is_none()
}

// 字下げを外した行頭と名前 (written) が区切り線に読まれるか (`- --`、`* **`)。末尾の印は解析が行から外して読むので見ない
fn thematic_break(lead: &str, written: &str) -> bool {
    let lead = lead.trim_start_matches(BOM).trim_start_matches([' ', '\t']);
    THEMATIC_BREAK.is_match(&format!("{lead}{written}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_names_regexes_compile() {
        LazyLock::force(&LINE_BREAKS);
        LazyLock::force(&TASK_LIKE);
        LazyLock::force(&CLOSING_RUN);
        LazyLock::force(&THEMATIC_BREAK);
        LazyLock::force(&ESCAPED_ORDERED);
        LazyLock::force(&ESCAPED_MARK);
        LazyLock::force(&ESCAPED_CLOSING);
    }

    #[test]
    fn edit_names_normalize_label_turns_every_line_break_into_one_space_and_trims() {
        // 改行は \r\n、\r、\n、U+2028、U+2029 のどれも空白 1 つ (\r\n は 1 つの改行)。前後の空白は外す
        for (label, expected) in [
            ("a\r\nb", "a b"),
            ("a\rb", "a b"),
            ("a\nb", "a b"),
            ("a\u{2028}b", "a b"),
            ("a\u{2029}b", "a b"),
            ("  a  \n", "a"),
            ("\u{3000}設計\u{3000}", "設計"),
            ("\r\n", ""),
            ("   ", ""),
        ] {
            assert_eq!(normalize_label(label), expected, "{label:?}");
        }
    }

    #[test]
    fn edit_names_input_lines_split_on_the_same_line_breaks() {
        assert_eq!(
            input_lines("x\r\ny\rz\nw\u{2028}v\u{2029}u"),
            ["x", "y", "z", "w", "v", "u"]
        );
        assert_eq!(input_lines("x"), ["x"]);
        assert_eq!(input_lines("x\r\n\r\ny"), ["x", "", "y"]);
    }

    #[test]
    fn edit_names_added_line_writes_an_empty_name_without_trailing_spaces() {
        assert_eq!(added_line("- ", "", false), "-");
        assert_eq!(added_line("    - [ ] ", "", false), "    - [ ]");
        assert_eq!(added_line("## ", "", true), "##");
    }

    #[test]
    fn edit_names_added_line_escapes_block_starts_and_task_marks() {
        // 番号付きのリストに読める書き始めは区切りの字の前、ほかのブロックの書き始めは先頭の字の前、タスクの記号は [ の前
        for (name, expected) in [
            ("1. 準備", "- 1\\. 準備"),
            ("2) 準備", "- 2\\) 準備"),
            ("# x", "- \\# x"),
            ("> x", "- \\> x"),
            ("---", "- \\---"),
            ("[x] 済み", "- \\[x] 済み"),
            ("[ ] 未", "- \\[ ] 未"),
            ("ふつうの名前", "- ふつうの名前"),
        ] {
            assert_eq!(added_line("- ", name, false), expected, "{name:?}");
        }
    }

    #[test]
    fn edit_names_added_line_escapes_only_the_trailing_word_that_reads_as_a_mark() {
        for (name, expected) in [
            ("設計 #a", "- 設計 \\#a"),
            ("設計 #k:v", "- 設計 \\#k:v"),
            ("設計 %g", "- 設計 \\%g"),
            ("設計 $id", "- 設計 \\$id"),
            // 1 語でも、行頭の印のあとの空白に続くので印に読まれる
            ("#todo", "- \\#todo"),
            // 数字だけの名前は印にならない。行の途中の #語 と、前が空白でない # も逃がさない
            ("課題 #12", "- 課題 #12"),
            ("設計 #a の説明", "- 設計 #a の説明"),
            ("C# と F#", "- C# と F#"),
        ] {
            assert_eq!(added_line("- ", name, false), expected, "{name:?}");
        }
    }

    #[test]
    fn edit_names_added_line_escapes_a_closing_run_only_in_headings() {
        assert_eq!(added_line("## ", "番号 ##", true), "## 番号 \\##");
        assert_eq!(added_line("## ", "C#", true), "## C#");
        assert_eq!(added_line("- ", "番号 ##", false), "- 番号 ##");
    }
}

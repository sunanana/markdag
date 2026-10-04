// 原文なし。
// 書くノードの行の形と字下げの書き方。足す行の行頭 (ATX の見出しの # の並びか、字下げとリストの印) を、並ぶノード
// (親の最後の子か自分) の形か、子のないときの形から決める。入れ子の項目の字下げの桁は文書の入れ子の幅から求め、
// タブを使う文書では 4 桁ごとのタブと残りの空白で書く。書いた行の前後にはさむ空行 (見出しの前後と、段落の前の項目) も
// ここで決める。付け替えで動かすブロックは、移す先での形で行頭を書き直し、2 行目からの字下げを新しい内容の桁に合わせ
// (元の内容の桁より深い所の字は原文のまま)、配下の見出しの段をずらす (6 段を超えるものと、項目にした見出しの配下の見出しは
// 入れ子の項目にする)。
// 桁はタブを次の 4 の倍数の桁まで進めて数える (CommonMark のタブ止め)。
use std::sync::LazyLock;

use regex::Regex;

use super::blocks::ParsedSource;
use super::lines::{is_blank, split_carriage};
use crate::parse::BlockTag;
use crate::types::{LineRange, NodeKind, OutlineNode};

// 項目の行頭: 字下げ、印 (箇条の字か、番号と区切り)、印のあとの空白
static ITEM_LEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([ \t]*)([-*+]|[0-9]+[.)])([ \t]*)").expect("固定の正規表現"));
// 項目の行 (印のあとに空白か行末)
static ITEM_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)").expect("固定の正規表現")
});
// ATX の見出しの行 (行頭の空白は 3 つまで)
static ATX_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}#{1,6}(?:[ \t]|$)").expect("固定の正規表現"));

const TAB_STOP: usize = 4;
// 文書に入れ子の項目がないときの入れ子の幅
const DEFAULT_NESTING: usize = 4;
// 印のあとの空白がこの幅を超えると、項目の内容は字下げのコードになる (内容の桁は印の 1 つあと)
const MAX_MARKER_GAP: usize = 4;

/// 足す行の行頭の形
#[derive(Debug, Clone, PartialEq)]
pub(super) enum LineShape {
    /// ATX の見出し。段と、タスクの記号を付けるか
    Heading { level: u8, task: bool },
    /// リストの項目。indent は字下げの字、marker は印 (番号付きは番号と区切り) とそのあとの空白
    Item {
        indent: String,
        marker: String,
        task: bool,
    },
}

impl LineShape {
    /// 字下げのない `- ` の項目 (子のない 6 段の見出しと、行も子もないルートの子)
    pub(super) fn bullet() -> Self {
        LineShape::Item {
            indent: String::new(),
            marker: "- ".to_string(),
            task: false,
        }
    }

    /// 本文の前に置く行頭。タスクの記号は、並ぶノードの状態によらず未着手の `[ ] `
    pub(super) fn lead(&self) -> String {
        let task = if self.task() { "[ ] " } else { "" };
        match self {
            LineShape::Heading { level, .. } => {
                format!("{} {task}", "#".repeat(usize::from(*level)))
            }
            LineShape::Item { indent, marker, .. } => format!("{indent}{marker}{task}"),
        }
    }

    pub(super) fn is_heading(&self) -> bool {
        matches!(self, LineShape::Heading { .. })
    }

    pub(super) fn task(&self) -> bool {
        match self {
            LineShape::Heading { task, .. } | LineShape::Item { task, .. } => *task,
        }
    }

    /// 見出しは段、項目は Li (書いた行が読まれるはずの要素の種類)
    pub(super) fn tag(&self) -> BlockTag {
        match self {
            LineShape::Heading { level, .. } => BlockTag::Heading(*level),
            LineShape::Item { .. } => BlockTag::Li,
        }
    }

    /// 書いた行の前後の空行の決め方
    pub(super) fn spacing(&self) -> Spacing {
        match self {
            LineShape::Heading { .. } => Spacing::Apart,
            LineShape::Item { .. } => Spacing::Item(self.content_column()),
        }
    }

    // 項目の字下げの字 (見出しは空)
    fn indent(&self) -> &str {
        match self {
            LineShape::Heading { .. } => "",
            LineShape::Item { indent, .. } => indent,
        }
    }

    // 項目の内容の桁 (字下げ、印、印のあとの空白を進めた桁)。見出しは 0
    fn content_column(&self) -> usize {
        match self {
            LineShape::Heading { .. } => 0,
            LineShape::Item { indent, marker, .. } => advance(advance(0, indent), marker),
        }
    }
}

/// 書いた行の前後にはさむ空行の決め方
pub(super) enum Spacing {
    /// 見出しと、表とコードと画像: 前の行と次の行が空でなければ、それぞれ空行をはさむ
    Apart,
    /// リストの項目 (内容の桁): 次の行が段落の行なら、段落が項目に吸い込まれないよう後ろにはさむ
    Item(usize),
}

/// 文書の入れ子の字下げの書き方。入れ子の幅 (入れ子の項目の字下げの差の最小。なければ 4) と、
/// リスト項目の字下げにタブを使う文書か。付け替えでは、ブロックを切り出す前の文書で数える
pub(super) struct Indentation {
    width: usize,
    tabs: bool,
}

impl Indentation {
    pub(super) fn of(read: &ParsedSource<'_>) -> Self {
        Indentation {
            width: nesting_width(read).unwrap_or(DEFAULT_NESTING),
            tabs: uses_tabs(read),
        }
    }
}

// 項目の 1 行目の行頭 (タスクの記号の前まで)
struct ItemLead<'s> {
    indent: &'s str,
    marker: &'s str,
    gap: &'s str,
}

impl<'s> ItemLead<'s> {
    fn read(lead: &'s str) -> Option<Self> {
        let found = ITEM_LEAD.captures(lead)?;
        Some(ItemLead {
            indent: found.get(1)?.as_str(),
            marker: found.get(2)?.as_str(),
            gap: found.get(3).map_or("", |gap| gap.as_str()),
        })
    }

    fn indent_column(&self) -> usize {
        advance(0, self.indent)
    }

    // 内容の桁の、字下げからの幅。印のあとの空白がないか広すぎれば、印の 1 つあと
    fn content_width(&self) -> usize {
        let marker_end = advance(self.indent_column(), self.marker);
        let gap = advance(marker_end, self.gap) - marker_end;
        let gap = if gap == 0 || gap > MAX_MARKER_GAP {
            1
        } else {
            gap
        };
        marker_end + gap - self.indent_column()
    }

    // 次に並べる印とそのあとの空白。番号付きは原文に書いた番号 + 1 で、区切り (. か )) を保つ
    fn next_marker(&self) -> String {
        let marker = match self.marker.strip_suffix(['.', ')']) {
            Some(number) => {
                let delimiter = &self.marker[number.len()..];
                let next = number
                    .parse::<u64>()
                    .map_or_else(|_| number.to_string(), |value| (value + 1).to_string());
                format!("{next}{delimiter}")
            }
            None => self.marker.to_string(),
        };
        let gap = advance(0, self.gap);
        let gap = if gap == 0 || gap > MAX_MARKER_GAP {
            " "
        } else {
            self.gap
        };
        format!("{marker}{gap}")
    }
}

/// node と同じ形で次に並べる行頭 (兄弟の形と、最後の子にそろえる子の形)。見出しは同じ段の ATX (下線の見出しも ATX)、
/// 項目は同じ字下げと印 (番号付きは番号 + 1)。タスクなら未着手の記号を付ける。見出しと項目のほかは None
pub(super) fn next_shape(read: &ParsedSource<'_>, node: &OutlineNode) -> Option<LineShape> {
    let first = read.first_line(node)?;
    match read.tag_of(node)? {
        BlockTag::Heading(level) => Some(LineShape::Heading {
            level,
            task: first.task,
        }),
        BlockTag::Li => {
            let lead = ItemLead::read(first.lead)?;
            Some(LineShape::Item {
                indent: lead.indent.to_string(),
                marker: lead.next_marker(),
                task: first.task,
            })
        }
        _ => None,
    }
}

/// 子のない項目の子の行頭: 親の字下げの桁に足す幅を足した桁の `- `。足す幅は文書の入れ子の幅の最小 (なければ 4) で、
/// 親の内容の桁 (印と後ろの空白の幅) より小さければ内容の桁にそろえる (そろえないと親の段落の続きに読まれる)
pub(super) fn nested_shape(
    read: &ParsedSource<'_>,
    parent: &OutlineNode,
    indentation: &Indentation,
) -> Option<LineShape> {
    let first = read.first_line(parent)?;
    let lead = ItemLead::read(first.lead)?;
    let width = indentation.width.max(lead.content_width());
    let tabs = lead.indent.contains('\t') || indentation.tabs;
    Some(LineShape::Item {
        indent: write_indent(lead.indent_column() + width, tabs),
        marker: "- ".to_string(),
        task: false,
    })
}

/// 書く行の前と後ろに空行をはさむか。見出しと、表とコードと画像は、前の行と次の行が空でなければそれぞれはさむ。
/// 項目は、次の行が段落の行 (空でなく、項目でも見出しでもなく、字下げが書く項目の内容の桁より浅い) なら、
/// 段落が項目に吸い込まれないよう後ろにはさむ。前か次の行がない (文書の先頭か、改行で終わらない文書の末尾) ときは、
/// その側にははさまない
pub(super) fn blank_lines_around(
    spacing: &Spacing,
    previous: Option<&str>,
    next: Option<&str>,
) -> (bool, bool) {
    let filled = |line: Option<&str>| line.is_some_and(|line| !is_blank(line));
    match spacing {
        Spacing::Apart => (filled(previous), filled(next)),
        Spacing::Item(content_column) => (
            false,
            next.is_some_and(|line| is_paragraph_line(line, *content_column)),
        ),
    }
}

/// 付け替えで動かすノードのブロックを、移す先での形 shape で書き直した行 (行末の \r を含む。\r のない行には文書の改行の \r を付ける)。
/// shape が None (表、コード、画像) は行をそのまま写す。
/// - 項目を項目で書く: 1 行目の行頭 (字下げと印) を差し替え、2 行目からは元の 1 行目の内容の桁からの相対の字下げを保って
///   新しい内容の桁に合わせる。タスクの記号と状態は行の中身として残す
/// - 項目を見出しで書く: 1 行目を ATX の見出しにし、子の行は最初の子が字下げなしになるようにずらす
///   (詳細の行は字下げなしの引用になり、見出しの詳細に読まれる。続きの段落を持つ項目は、呼ぶ側が断る)
/// - 見出しを書く: 配下の見出しは相対の段を保ってずらし、6 段を超えるものと、項目で書く見出しの配下の見出しは入れ子の項目にする。
///   段の変わる見出しは ATX で書き (下線の見出しは下線の行を消す)、項目にした見出しの配下の行はその項目の内容の桁だけ字下げする
pub(super) fn moved_lines(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
    shape: Option<&LineShape>,
    indentation: &Indentation,
    carriage: &str,
) -> Option<Vec<String>> {
    let range = read.block_lines(node)?;
    let lines = read.lines.get(range.start as usize..range.end as usize)?;
    let writer = LineWriter {
        carriage,
        tabs: indentation.tabs || shape.is_some_and(|shape| shape.indent().contains('\t')),
    };
    match (read.kind_of(node), shape) {
        (NodeKind::Block, None) => Some(
            lines
                .iter()
                .map(|line| writer.shifted(line, 0, 0, false))
                .collect(),
        ),
        (NodeKind::Item, Some(shape)) => {
            let code = inside_fences(read, range.start, lines.len());
            item_lines(read, node, lines, &code, shape, &writer)
        }
        (NodeKind::Heading, Some(shape)) => {
            heading_lines(read, node, range.start, lines, shape, indentation, &writer)
        }
        _ => None,
    }
}

// ブロックの行ごとに、フェンスのコードの中の行 (開きと閉じの行のあいだ) か。start はブロックの 1 行目の添字
fn inside_fences(read: &ParsedSource<'_>, start: u32, count: usize) -> Vec<bool> {
    let mut inside = false;
    (start..)
        .take(count)
        .map(|index| {
            if read.is_fence_line(index) {
                inside = !inside;
                false
            } else {
                inside
            }
        })
        .collect()
}

// 書き直す行の書き方: 行末の \r (行が持たなければ文書の改行の \r) と、字下げにタブを使うか
struct LineWriter<'c> {
    carriage: &'c str,
    tabs: bool,
}

impl LineWriter<'_> {
    fn ended(&self, content: &str, own: &str) -> String {
        let carriage = if own.is_empty() { self.carriage } else { own };
        format!("{content}{carriage}")
    }

    // 字下げの桁を from の桁から to の桁へずらした行 (浅くするときは 0 で止める)。空行と、ずらさない行はそのまま。
    // 書き直すのは字下げのうち from の桁までの字で、それより深い所の字 (タブと空白) は原文のまま残す (コードの中身を変えない)。
    // from の桁がタブの途中にかかる行と from の桁より浅い行は、桁で書き直す。残す字下げにタブがあり、ずれが 4 の倍数でない行も
    // (タブの幅が変わって相対の字下げが崩れるので) 桁で書き直す。ただしフェンスのコードの中の行 (code) は、タブの字のまま読まれるので残す
    fn shifted(&self, line: &str, from: usize, to: usize, code: bool) -> String {
        let (content, own) = split_carriage(line);
        if from == to || is_blank(content) {
            return self.ended(content, own);
        }
        if let Some(rest) = beyond_column(content, from)
            && (code || keeps_tab_widths(rest, from, to))
        {
            return self.ended(&format!("{}{rest}", write_indent(to, self.tabs)), own);
        }
        let body = content.trim_start_matches([' ', '\t']);
        let column = (indent_column(content) + to).saturating_sub(from);
        self.ended(&format!("{}{body}", write_indent(column, self.tabs)), own)
    }
}

// 行の字下げの字が、ちょうど column の桁で切れるなら、そこから後ろ。column の桁がタブの途中にかかるか、字下げが column の桁より浅ければ None
fn beyond_column(content: &str, column: usize) -> Option<&str> {
    let mut at = 0;
    for (offset, c) in content.char_indices() {
        if at == column {
            return content.get(offset..);
        }
        if at > column || !matches!(c, ' ' | '\t') {
            return None;
        }
        at = advance(at, &content[offset..offset + c.len_utf8()]);
    }
    (at == column).then_some("")
}

// 字下げの残りを from の桁から to の桁へ動かしても、残りの中のタブの幅が変わらないか (タブがないか、ずれがタブ止めの倍数)
fn keeps_tab_widths(rest: &str, from: usize, to: usize) -> bool {
    let indent = &rest[..rest.len() - rest.trim_start_matches([' ', '\t']).len()];
    !indent.contains('\t') || from.abs_diff(to).is_multiple_of(TAB_STOP)
}

// 行の字下げの桁
fn indent_column(content: &str) -> usize {
    let body = content.trim_start_matches([' ', '\t']);
    advance(0, &content[..content.len() - body.len()])
}

// 項目のブロックを、項目か見出しで書き直す。code は行ごとの、フェンスのコードの中の行か
fn item_lines(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
    lines: &[&str],
    code: &[bool],
    shape: &LineShape,
    writer: &LineWriter<'_>,
) -> Option<Vec<String>> {
    let first = read.first_line(node)?;
    let lead = ItemLead::read(first.lead)?;
    let (head, rest) = lines.split_first()?;
    let rest_code = code.get(1..).unwrap_or_default();
    let (content, own) = split_carriage(head);
    // 印のあと (タスクの記号、本文、本文のあと)
    let tail = content.get(first.marker.len()..)?;
    let mut out = Vec::with_capacity(lines.len());
    match shape {
        LineShape::Item { indent, marker, .. } => {
            let line = format!("{indent}{marker}{tail}");
            out.push(writer.ended(line.trim_end_matches([' ', '\t']), own));
            let from = lead.indent_column() + lead.content_width();
            let to = shape.content_column();
            out.extend(
                rest.iter()
                    .zip(rest_code)
                    .map(|(line, code)| writer.shifted(line, from, to, *code)),
            );
        }
        LineShape::Heading { level, .. } => {
            let line = format!("{} {tail}", "#".repeat(usize::from(*level)));
            out.push(writer.ended(line.trim_end_matches([' ', '\t']), own));
            let from = rest
                .iter()
                .find(|line| !is_blank(line))
                .map_or(0, |line| indent_column(split_carriage(line).0));
            out.extend(
                rest.iter()
                    .zip(rest_code)
                    .map(|(line, code)| writer.shifted(line, from, 0, *code)),
            );
        }
    }
    Some(out)
}

// 動かす見出しと配下の見出しを書く形
#[derive(Debug)]
enum HeadingForm {
    /// ATX の見出しの段
    Heading(u8),
    /// 項目。字下げの字、印 (後ろの空白を含む)、字下げの桁、内容の桁
    Item {
        indent: String,
        marker: String,
        column: usize,
        content: usize,
    },
}

// 見出しのブロックを書き直す。見出しの行は新しい形で書き、見出しでない行は、その行を配下に持つ見出し (直前の見出しの行) が
// 項目になればその項目の内容の桁だけ字下げし、見出しのままなら変えない
fn heading_lines(
    read: &ParsedSource<'_>,
    node: &OutlineNode,
    start: u32,
    lines: &[&str],
    shape: &LineShape,
    indentation: &Indentation,
    writer: &LineWriter<'_>,
) -> Option<Vec<String>> {
    let level_of = |node: &OutlineNode| match read.tag_of(node) {
        Some(BlockTag::Heading(level)) => Some(level),
        _ => None,
    };
    let first_form = match shape {
        LineShape::Heading { level, .. } => HeadingForm::Heading(*level),
        LineShape::Item { indent, marker, .. } => HeadingForm::Item {
            indent: indent.clone(),
            marker: marker.clone(),
            column: advance(0, indent),
            content: shape.content_column(),
        },
    };
    // 見出しごとの (ノード、元の段、書く形)。配下の見出しの形は親の見出しの形から決める
    let mut forms: Vec<(&OutlineNode, u8, HeadingForm)> = vec![(node, level_of(node)?, first_form)];
    for sub in read
        .descendants(node)
        .filter(|sub| read.kind_of(sub) == NodeKind::Heading)
    {
        let level = level_of(sub)?;
        let (_, parent_level, parent_form) = forms
            .iter()
            .find(|(heading, ..)| Some(heading.id) == sub.parent)?;
        let form = match parent_form {
            HeadingForm::Heading(parent) => {
                let shifted =
                    usize::from(*parent) + usize::from(level.saturating_sub(*parent_level));
                match u8::try_from(shifted) {
                    Ok(shifted) if shifted <= 6 => HeadingForm::Heading(shifted),
                    // 6 段の見出しの子の形 (字下げなしの項目)
                    _ => HeadingForm::Item {
                        indent: String::new(),
                        marker: "- ".to_string(),
                        column: 0,
                        content: 2,
                    },
                }
            }
            HeadingForm::Item {
                column, content, ..
            } => {
                let nested = column + indentation.width.max(content - column);
                HeadingForm::Item {
                    indent: write_indent(nested, writer.tabs),
                    marker: "- ".to_string(),
                    column: nested,
                    content: nested + 2,
                }
            }
        };
        forms.push((sub, level, form));
    }
    let mut out = Vec::with_capacity(lines.len());
    let mut section: Option<&HeadingForm> = None;
    let mut skip_until = start;
    let code = inside_fences(read, start, lines.len());
    for ((index, line), code) in (start..).zip(lines).zip(&code) {
        if index < skip_until {
            continue;
        }
        if let Some((heading, level, form)) = forms
            .iter()
            .find(|(heading, ..)| heading.lines.as_ref().map(|lines| lines.start) == Some(index))
        {
            let range = heading.lines.as_ref()?;
            skip_until = range.end.max(index + 1);
            out.push(heading_line(
                read,
                heading,
                *level,
                range.clone(),
                form,
                writer,
            )?);
            section = Some(form);
            continue;
        }
        let content = match section {
            Some(HeadingForm::Item { content, .. }) => *content,
            _ => 0,
        };
        out.push(writer.shifted(line, 0, content, *code));
    }
    Some(out)
}

// 見出しの 1 行を新しい形で書く。下線の見出し (行の範囲が 2 行以上) は ATX にし、本文が 2 行以上なら空白でつなぐ。
// 項目にするときは ATX の閉じの記号を外す (項目では名前の一部に読まれるため)
fn heading_line(
    read: &ParsedSource<'_>,
    heading: &OutlineNode,
    level: u8,
    range: LineRange,
    form: &HeadingForm,
    writer: &LineWriter<'_>,
) -> Option<String> {
    let first = read.first_line(heading)?;
    let (content, own) = split_carriage(read.lines.get(range.start as usize)?);
    let setext = range.end > range.start + 1;
    // 下線の見出しの 2 行目からの本文 (最後の行は下線)
    let more: String = read
        .lines
        .get(range.start as usize + 1..(range.end as usize).saturating_sub(1))
        .unwrap_or_default()
        .iter()
        .map(|line| format!(" {}", split_carriage(line).0.trim_matches([' ', '\t'])))
        .collect();
    let task = first.lead.get(first.marker.len()..).unwrap_or_default();
    let indent = &content[..content.len() - content.trim_start_matches([' ', '\t']).len()];
    let line = match form {
        // 段の変わらない ATX の見出しは書き直さない
        HeadingForm::Heading(new_level) if !setext && *new_level == level => content.to_string(),
        // ATX の見出しは # の並びだけを差し替える (行頭の空白、閉じの記号、末尾の印は残す)
        HeadingForm::Heading(new_level) if !setext => format!(
            "{indent}{}{}",
            "#".repeat(usize::from(*new_level)),
            content[indent.len()..].trim_start_matches('#')
        ),
        HeadingForm::Heading(new_level) => format!(
            "{indent}{} {task}{}{more}",
            "#".repeat(usize::from(*new_level)),
            first.body
        ),
        HeadingForm::Item { indent, marker, .. } => {
            let line = format!("{indent}{marker}{task}{}{more}{}", first.body, first.marks);
            line.trim_end_matches([' ', '\t']).to_string()
        }
    };
    Some(writer.ended(&line, own))
}

fn is_paragraph_line(line: &str, content_column: usize) -> bool {
    let content = split_carriage(line).0;
    if is_blank(content) || ITEM_LINE.is_match(content) || ATX_LINE.is_match(content) {
        return false;
    }
    let body = content.trim_start_matches([' ', '\t']);
    advance(0, &content[..content.len() - body.len()]) < content_column
}

// 文書の入れ子の項目の字下げの差 (いちばん近い祖先の項目からの桁の差) のうち最小のもの
fn nesting_width(read: &ParsedSource<'_>) -> Option<usize> {
    read.parsed
        .nodes
        .iter()
        .filter_map(|node| {
            let column = item_indent(read, node)?;
            let mut parent = node.parent;
            while let Some(id) = parent {
                let ancestor = read.node(id)?;
                if let Some(ancestor_column) = item_indent(read, ancestor) {
                    return column
                        .checked_sub(ancestor_column)
                        .filter(|width| *width > 0);
                }
                parent = ancestor.parent;
            }
            None
        })
        .min()
}

// 文書のリスト項目の字下げにタブがあるか
fn uses_tabs(read: &ParsedSource<'_>) -> bool {
    read.parsed.nodes.iter().any(|node| {
        read.kind_of(node) == NodeKind::Item
            && read
                .first_line(node)
                .and_then(|first| ItemLead::read(first.lead))
                .is_some_and(|lead| lead.indent.contains('\t'))
    })
}

// 項目の字下げの桁。項目でなければ None
fn item_indent(read: &ParsedSource<'_>, node: &OutlineNode) -> Option<usize> {
    if read.kind_of(node) != NodeKind::Item {
        return None;
    }
    let first = read.first_line(node)?;
    ItemLead::read(first.lead).map(|lead| lead.indent_column())
}

// column の桁を、タブを使う文書では 4 桁ごとのタブと残りの空白で、そうでなければ空白で書く
fn write_indent(column: usize, tabs: bool) -> String {
    if tabs {
        format!(
            "{}{}",
            "\t".repeat(column / TAB_STOP),
            " ".repeat(column % TAB_STOP)
        )
    } else {
        " ".repeat(column)
    }
}

// start の桁から text を進めた桁 (タブは次の 4 の倍数の桁まで)
fn advance(start: usize, text: &str) -> usize {
    text.chars().fold(start, |column, c| {
        if c == '\t' {
            column + TAB_STOP - column % TAB_STOP
        } else {
            column + 1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_shape_regexes_compile() {
        LazyLock::force(&ITEM_LEAD);
        LazyLock::force(&ITEM_LINE);
        LazyLock::force(&ATX_LINE);
    }

    #[test]
    fn edit_shape_writes_columns_with_tabs_and_spaces() {
        assert_eq!(write_indent(5, true), "\t ");
        assert_eq!(write_indent(8, true), "\t\t");
        assert_eq!(write_indent(5, false), "     ");
        assert_eq!(advance(0, "\t "), 5);
        assert_eq!(advance(2, "\t"), 4);
    }

    #[test]
    fn edit_shape_next_marker_counts_up_and_keeps_the_delimiter() {
        let next = |lead: &str| ItemLead::read(lead).map(|lead| lead.next_marker());
        assert_eq!(next("9) ").as_deref(), Some("10) "));
        assert_eq!(next("  * ").as_deref(), Some("* "));
        // 空の項目 (印で行が終わる) と、内容が字下げのコードになる広い空白は空白 1 つ
        assert_eq!(next("-").as_deref(), Some("- "));
        assert_eq!(next("1.      ").as_deref(), Some("2. "));
    }
}

#[cfg(test)]
mod nesting_tests {
    use super::*;

    fn width(source: &str) -> Option<usize> {
        nesting_width(&ParsedSource::read(source))
    }

    #[test]
    fn edit_shape_nesting_width_is_the_smallest_indent_step_of_nested_items() {
        // 字下げの差が 2 と 4 の文書は、どちらが先でも 2 (いちばん大きい差ではない)
        assert_eq!(width("# R\n- 設計\n  - 画面\n- 実装\n    - API\n"), Some(2));
        assert_eq!(width("# R\n- 実装\n    - API\n- 設計\n  - 画面\n"), Some(2));
        assert_eq!(width("# R\n- a\n  - b\n      - c\n"), Some(2));
        assert_eq!(width("# R\n- a\n    - b\n        - c\n"), Some(4));
    }

    #[test]
    fn edit_shape_nesting_width_counts_tabs_to_the_next_tab_stop_and_needs_nesting() {
        assert_eq!(width("# R\n- a\n\t- b\n"), Some(4));
        assert_eq!(width("# R\n- a\n- b\n"), None);
    }
}

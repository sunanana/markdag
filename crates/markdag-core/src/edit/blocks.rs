// 原文なし。
// 書き換えの層が原文を読む単位。原文を解析し直してノードの種類 (見出し、項目、容器、表とコードと画像、行を持たないルート) を見分け、
// ノードの 1 行目を行頭 (字下げ、リストの印か見出しの #、タスクの記号)、本文、本文のあと (空白、ATX の見出しの閉じの記号、
// 末尾の印)、行末の \r に分ける。ノードが占める行 (ブロック) の範囲と、最後の子、配下を引き、詳細 (項目の直下の引用と、見出しのすぐ下の
// 引用。どちらも怠惰な続きの行を含む) の行と原文と、読むだけの問い合わせ (inspect_node) の答えもここで組む。
use std::ops::Range;
use std::sync::LazyLock;

use regex::Regex;

use super::headings::atx_heading;
use super::lines::{is_blank, split_carriage};
use super::names::input_label;
use crate::model::model::{ModelOptions, build_model};
use crate::parse::{BlockTag, is_mark_line, parse_with_block_tags, trailing_marks};
use crate::types::{
    GraphModel, InspectNodeResult, NodeKind, NodeTarget, OutlineNode, ParsedDocument,
};

// リストの印と続く空白 (空の項目は印で行が終わる)
static ITEM_LEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:[-*+]|[0-9]+[.)])(?:[ \t]+|$)").expect("固定の正規表現")
});
// ATX の見出しの # と続く空白 (空の見出しは # で行が終わる)。下線の見出しは行頭の空白だけ
static ATX_LEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*#{1,6}(?:[ \t]+|$)").expect("固定の正規表現"));
static SETEXT_LEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*").expect("固定の正規表現"));
// タスクの記号。解析と同じく、記号のあとに空白かタブが要る
static TASK_LEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[[ xX/-]\][ \t]+").expect("固定の正規表現"));
// ATX の見出しの閉じの記号 (前に空白のある # の並び。中身が # の並びだけのときも閉じ)
static ATX_CLOSING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[ \t]+)#+[ \t]*$").expect("固定の正規表現"));
static FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*(?:```|~~~)").expect("固定の正規表現"));
// 解析が読んだ引用ブロックの行の範囲 (data-lines は 0 始まりで終わりを含まない、原文の行)
static QUOTE_LINES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<blockquote data-lines="([0-9]+),([0-9]+)""#).expect("固定の正規表現")
});
/// 文書の先頭の BOM。1 行目のノードでは行頭の一部として扱う
pub(super) const BOM: char = '\u{FEFF}';

/// 解析し直した原文。行 (split('\n')) と解析の結果と、ノードごとの要素の種類 (nodes と同じ順)
pub(super) struct ParsedSource<'s> {
    pub(super) lines: Vec<&'s str>,
    pub(super) parsed: ParsedDocument,
    tags: Vec<Option<BlockTag>>,
}

/// ノードの 1 行目を分けたもの。lead、body、rest、carriage をつなげると行に戻る
#[derive(Debug, Clone, PartialEq)]
pub(super) struct FirstLine<'s> {
    /// 行の添字 (0 始まり)
    pub(super) index: u32,
    /// 字下げ、リストの印か見出しの #、タスクの記号と、それぞれに続く空白 (文書の先頭の行では、前に BOM があれば BOM も)
    pub(super) lead: &'s str,
    /// lead のうちタスクの記号の前まで (字下げ、リストの印か見出しの #、続く空白)
    pub(super) marker: &'s str,
    /// 名前の本文の原文 (後ろの空白を含まない)
    pub(super) body: &'s str,
    /// 本文のあと (本文の後ろの空白、ATX の見出しの閉じの記号、末尾の印)
    pub(super) rest: &'s str,
    /// rest のうち末尾の印 (前の空白から。なければ空)
    pub(super) marks: &'s str,
    /// 行末の \r (なければ空)
    pub(super) carriage: &'s str,
    /// 末尾の印 (%、#、$) があるか。markdag キーのない文書では印を読まないので、いつも false
    pub(super) marked: bool,
    pub(super) task: bool,
    /// 1 行目に印を書けるか (行頭に空白のない ATX の見出しと、リストの項目)
    pub(super) can_mark: bool,
}

impl<'s> ParsedSource<'s> {
    pub(super) fn read(source: &'s str) -> Self {
        let (parsed, tags) = parse_with_block_tags(source);
        ParsedSource {
            lines: source.split('\n').collect(),
            parsed,
            tags,
        }
    }

    /// NodeTarget の id と refText に合うノード
    pub(super) fn find(&self, target: &NodeTarget) -> Option<&OutlineNode> {
        let id = target.id;
        if !(id.is_finite() && id.fract() == 0.0 && id >= 1.0 && id <= f64::from(u32::MAX)) {
            return None;
        }
        self.node(id as u32)
            .filter(|node| node.ref_text == target.ref_text)
    }

    pub(super) fn node(&self, id: u32) -> Option<&OutlineNode> {
        let index = (id as usize).checked_sub(1)?;
        self.parsed.nodes.get(index).filter(|node| node.id == id)
    }

    pub(super) fn tag_of(&self, node: &OutlineNode) -> Option<BlockTag> {
        let index = (node.id as usize).checked_sub(1)?;
        self.tags.get(index).copied().flatten()
    }

    pub(super) fn kind_of(&self, node: &OutlineNode) -> NodeKind {
        match self.tag_of(node) {
            None => NodeKind::Root,
            Some(BlockTag::Heading(_)) => NodeKind::Heading,
            Some(BlockTag::Li) => NodeKind::Item,
            Some(BlockTag::Ul | BlockTag::Ol) => NodeKind::List,
            Some(BlockTag::Table | BlockTag::Pre | BlockTag::Img) => NodeKind::Block,
        }
    }

    /// 見出しと項目の 1 行目。それ以外の種類と、行を持たないノードは None
    pub(super) fn first_line(&self, node: &OutlineNode) -> Option<FirstLine<'s>> {
        let kind = self.kind_of(node);
        if !matches!(kind, NodeKind::Heading | NodeKind::Item) {
            return None;
        }
        let index = node.lines.as_ref()?.start;
        let line = *self.lines.get(index as usize)?;
        Some(split_first_line(
            line,
            index,
            kind == NodeKind::Heading,
            self.parsed.extracted,
        ))
    }

    // 先行順の並びなので、最初の子はすぐ後ろのノード
    fn first_child(&self, node: &OutlineNode) -> Option<&OutlineNode> {
        self.parsed
            .nodes
            .get(node.id as usize)
            .filter(|child| child.parent == Some(node.id))
    }

    /// 直下の子のうち文書順で最後のもの
    pub(super) fn last_child(&self, node: &OutlineNode) -> Option<&OutlineNode> {
        self.parsed
            .nodes
            .iter()
            .skip(node.id as usize)
            .take_while(|other| other.depth > node.depth)
            .filter(|child| child.parent == Some(node.id))
            .last()
    }

    /// 最後の子が表、コード、画像か。解析は子の段 (見出し、ブロック、リスト) を最初の子で決め、より小さい段の子が来ると
    /// 前の子を捨て、より大きい段の子は入れないので、このノードにはどの形の子を足しても今の子が残らない
    pub(super) fn ends_with_block(&self, node: &OutlineNode) -> bool {
        self.last_child(node)
            .is_some_and(|child| self.kind_of(child) == NodeKind::Block)
    }

    /// ノードの配下 (先行順なので、ノードのすぐ後ろに続く深いノード)
    pub(super) fn descendants<'n>(
        &'n self,
        node: &'n OutlineNode,
    ) -> impl Iterator<Item = &'n OutlineNode> + 'n {
        self.parsed
            .nodes
            .iter()
            .skip(node.id as usize)
            .take_while(move |other| other.depth > node.depth)
    }

    /// node が ancestor そのものか、その配下か
    pub(super) fn is_within(&self, node: &OutlineNode, ancestor: u32) -> bool {
        let mut current = Some(node);
        while let Some(visited) = current {
            if visited.id == ancestor {
                return true;
            }
            current = visited.parent.and_then(|parent| self.node(parent));
        }
        false
    }

    /// 番号付きのリストの項目か (1 行目の印が番号)
    pub(super) fn is_ordered_item(&self, node: &OutlineNode) -> bool {
        self.kind_of(node) == NodeKind::Item
            && self.first_line(node).is_some_and(|first| {
                first
                    .lead
                    .trim_start_matches(BOM)
                    .trim_start_matches([' ', '\t'])
                    .starts_with(|c: char| c.is_ascii_digit())
            })
    }

    /// ブロック (ノードが占める行) の最後の空でない行の次の行の添字。子と兄弟はここに足す。
    /// 見出しは配下の段落を含めて、文書順で配下でない次のノードの前まで。行を持たないルートは文書の全体で、
    /// 空でない行がなければ 0
    pub(super) fn block_end(&self, node: &OutlineNode) -> u32 {
        let whole = u32::try_from(self.lines.len()).unwrap_or(u32::MAX);
        let (start, end) = match (self.kind_of(node), node.lines.as_ref()) {
            (NodeKind::Heading, Some(lines)) => (lines.start, self.subtree_end_line(node, whole)),
            (_, Some(lines)) => (lines.start, lines.end),
            (_, None) => (0, whole),
        };
        (start..end)
            .rev()
            .find(|&index| {
                self.lines
                    .get(index as usize)
                    .is_some_and(|line| !is_blank(line))
            })
            .map_or(start, |index| index + 1)
    }

    /// ノードが占める行 (ブロック) の範囲。1 行目から、ブロックの最後の空でない行まで (末尾の空行は入れない)。
    /// 消すか切り出す行。行を持たないノードは None
    pub(super) fn block_lines(&self, node: &OutlineNode) -> Option<Range<u32>> {
        let start = node.lines.as_ref()?.start;
        Some(start..self.block_end(node).max(start))
    }

    // 配下でない次のノードの 1 行目 (なければ文書の終わり)。先行順なので、配下は node のすぐ後ろに続く
    fn subtree_end_line(&self, node: &OutlineNode, whole: u32) -> u32 {
        self.parsed
            .nodes
            .iter()
            .skip(node.id as usize)
            .find(|other| other.depth <= node.depth)
            .and_then(|other| other.lines.as_ref())
            .map_or(whole, |lines| lines.start)
    }

    /// 項目が 1 行目のあと、最初の子の前に、詳細 (引用とその怠惰な続きの行) のほかの空でない行 (続きの段落) を持つか。
    /// 見出しは配下の段落を読まないので持たない
    pub(super) fn has_continuation(&self, node: &OutlineNode) -> bool {
        if self.kind_of(node) != NodeKind::Item {
            return false;
        }
        let Some(range) = node.lines.as_ref() else {
            return false;
        };
        let details = self.detail_lines(node);
        (range.start + 1..self.children_start(node)).any(|index| {
            !details.contains(&index)
                && self
                    .lines
                    .get(index as usize)
                    .is_some_and(|line| !is_blank(line))
        })
    }

    /// 最初の子の 1 行目 (子がなければ自分の行の終わり)
    pub(super) fn children_start(&self, node: &OutlineNode) -> u32 {
        let Some(range) = node.lines.as_ref() else {
            return 0;
        };
        self.first_child(node)
            .and_then(|child| child.lines.as_ref())
            .map_or(range.end, |child| child.start.min(range.end))
            .max(range.start + 1)
    }

    /// 詳細の行に、行頭に > のない引用の続き (怠惰な続きの行) があるか
    pub(super) fn has_lazy_detail_lines(&self, node: &OutlineNode) -> bool {
        self.detail_lines(node).into_iter().any(|index| {
            self.lines.get(index as usize).is_some_and(|line| {
                !split_carriage(line)
                    .0
                    .trim_start_matches([' ', '\t'])
                    .starts_with('>')
            })
        })
    }

    /// 詳細の原文: 詳細の行を文書の順に 1 行ずつ、引用の行は字下げと `>` とそのあとの空白 1 つを外し、
    /// 怠惰な続きの行 (行頭に > のない引用の続き) は行頭の空白を外して \n でつなぐ
    pub(super) fn details_of(&self, node: &OutlineNode) -> Option<String> {
        let rows: Vec<&str> = self
            .detail_lines(node)
            .into_iter()
            .filter_map(|index| self.lines.get(index as usize))
            .map(|line| {
                let content = split_carriage(line).0.trim_start_matches([' ', '\t']);
                match content.strip_prefix('>') {
                    Some(after) => after.strip_prefix(' ').unwrap_or(after),
                    None => content,
                }
            })
            .collect();
        (!rows.is_empty()).then(|| rows.join("\n"))
    }

    /// 詳細の行の添字 (文書の順)。項目は、1 行目のあと最初の子の前にある引用の行 (フェンスの中は除く) と、
    /// 解析が読んだ引用ブロックの中の怠惰な続きの行。見出しは、解析が詳細に読んだ引用ブロック (見出しのすぐ下の引用) の行
    /// (markdag キーのない文書の見出しは詳細を読まないので、ない)
    pub(super) fn detail_lines(&self, node: &OutlineNode) -> Vec<u32> {
        match self.kind_of(node) {
            NodeKind::Item => self.item_detail_lines(node),
            NodeKind::Heading => quote_lines(node)
                .filter(|index| {
                    self.lines
                        .get(*index as usize)
                        .is_some_and(|line| !is_blank(line))
                })
                .collect(),
            NodeKind::List | NodeKind::Block | NodeKind::Root => Vec::new(),
        }
    }

    fn item_detail_lines(&self, node: &OutlineNode) -> Vec<u32> {
        let Some(range) = node.lines.as_ref() else {
            return Vec::new();
        };
        let (first, limit) = (range.start + 1, self.children_start(node));
        let mut quoted: Vec<u32> = Vec::new();
        let mut in_fence = false;
        let lines = self
            .lines
            .get(first as usize..limit as usize)
            .unwrap_or_default();
        for (index, line) in (first..).zip(lines) {
            let content = split_carriage(line).0;
            if FENCE.is_match(content) {
                in_fence = !in_fence;
                continue;
            }
            if !in_fence && content.trim_start_matches([' ', '\t']).starts_with('>') {
                quoted.push(index);
            }
        }
        // 引用ブロックの中で、行頭に > のない行 (怠惰な続きの行)
        quoted.extend(quote_lines(node).filter(|index| {
            (first..limit).contains(index)
                && self
                    .lines
                    .get(*index as usize)
                    .is_some_and(|line| !is_blank(line))
        }));
        quoted.sort_unstable();
        quoted.dedup();
        quoted
    }

    /// 行の添字が、フェンス (``` か ~~~) の開きか閉じの行か
    pub(super) fn is_fence_line(&self, index: u32) -> bool {
        self.lines
            .get(index as usize)
            .is_some_and(|line| FENCE.is_match(split_carriage(line).0))
    }
}

fn split_first_line(line: &str, index: u32, heading: bool, extracted: bool) -> FirstLine<'_> {
    let (content, carriage) = split_carriage(line);
    // 末尾の印は解析と同じく、markdag キーのある文書の、印を読む形の行でだけ読む
    let marks_start = if extracted && is_mark_line(content) {
        trailing_marks(content)
            .first()
            .map_or(content.len(), |mark| mark.start)
    } else {
        content.len()
    };
    let head = &content[..marks_start];
    // 文書の先頭の BOM は行頭に含め、名前に入れない (字下げと記号は BOM のあとから読む)
    let bom = if index == 0 && head.starts_with(BOM) {
        BOM.len_utf8()
    } else {
        0
    };
    let atx = heading && ATX_LEAD.is_match(&head[bom..]);
    let lead_regex: &Regex = if !heading {
        &ITEM_LEAD
    } else if atx {
        &ATX_LEAD
    } else {
        &SETEXT_LEAD
    };
    let mut lead_end = bom + lead_regex.find(&head[bom..]).map_or(0, |found| found.end());
    let marker_end = lead_end;
    let task = match TASK_LEAD.find(&head[lead_end..]) {
        Some(found) => {
            lead_end += found.end();
            true
        }
        None => false,
    };
    let after_lead = &head[lead_end..];
    let closing_start = if atx {
        ATX_CLOSING
            .find(after_lead)
            .map_or(after_lead.len(), |found| found.start())
    } else {
        after_lead.len()
    };
    let body = after_lead[..closing_start].trim_end_matches([' ', '\t']);
    let body_end = lead_end + body.len();
    FirstLine {
        index,
        lead: &content[..lead_end],
        marker: &content[..marker_end],
        body,
        rest: &content[body_end..],
        marks: &content[marks_start..],
        carriage,
        marked: marks_start < content.len(),
        task,
        can_mark: !heading || (atx && content.starts_with('#')),
    }
}

pub(super) fn inspect(source: &str, target: &NodeTarget) -> Option<InspectNodeResult> {
    let read = ParsedSource::read(source);
    let node = read.find(target)?;
    let kind = read.kind_of(node);
    let first = read.first_line(node);
    // 種類ごとにできること: 名前、削除、付け替え、詳細、子、兄弟
    let (can_rename, can_delete, can_move, can_have_details, can_add_child, can_add_sibling) =
        match kind {
            NodeKind::Heading => (true, true, true, true, true, true),
            NodeKind::Item => (true, true, true, true, true, true),
            NodeKind::List => (false, true, false, false, true, false),
            NodeKind::Block => (false, true, true, false, false, false),
            NodeKind::Root => (false, false, false, false, true, true),
        };
    // 最後の子が表、コード、画像のノードには子を足せない (足すと今の子が捨てられる)
    let can_add_child = can_add_child && !read.ends_with_block(node);
    // ルートは消せず動かせない。ルートの兄弟は子として足すので、兄弟は子と同じ (ルートでもある容器を含む)
    let root = node.parent.is_none();
    Some(InspectNodeResult {
        id: node.id,
        kind,
        label: first
            .as_ref()
            .map(|first| input_label(first, kind == NodeKind::Heading))
            .unwrap_or_default(),
        details: read.details_of(node),
        task: node.task.is_some(),
        can_rename,
        can_delete: can_delete && !root,
        can_move: can_move && !root,
        can_have_details,
        can_add_child,
        can_add_sibling: if root { can_add_child } else { can_add_sibling },
        // 容器と 1 行目を分け合う項目 (容器の最初の項目) も、その行の印は項目だけが読む (容器は読まない。B-107 / B-135) ので書ける
        // 印を読まない見出し (下線の見出しと行頭に空白のある見出し) も、ATX の見出しに書き直せれば書ける
        can_mark: first.as_ref().is_some_and(|first| first.can_mark)
            || atx_heading(&read, node).is_some(),
    })
}

/// 解析し直した原文のモデル (グループの定義と所属、タグのキーの定義を読む)
pub(super) fn model_of(read: &ParsedSource<'_>) -> GraphModel {
    build_model(
        &read.parsed.nodes,
        &read.parsed.frontmatter,
        Some(&read.lines.join("\n")),
        &ModelOptions::default(),
    )
}

/// 断る理由の文に入れるノードの名前。名前が空のノードは #id
pub(super) fn display_name(node: &OutlineNode) -> String {
    if node.ref_text.is_empty() {
        format!("#{}", node.id)
    } else {
        node.ref_text.clone()
    }
}

/// ノードの 1 行目の行の添字。行を持たないノードは None
pub(super) fn start_line(node: &OutlineNode) -> Option<u32> {
    node.lines.as_ref().map(|lines| lines.start)
}

// 解析がノードの中身に読んだ引用ブロックの行 (data-lines の範囲。入れ子の引用は重ねて数えない)
fn quote_lines(node: &OutlineNode) -> impl Iterator<Item = u32> + '_ {
    let mut seen: Vec<u32> = Vec::new();
    QUOTE_LINES
        .captures_iter(&node.html)
        .filter_map(|found| {
            let start: u32 = found.get(1)?.as_str().parse().ok()?;
            let end: u32 = found.get(2)?.as_str().parse().ok()?;
            Some(start..end)
        })
        .flatten()
        .filter(move |index| {
            if seen.contains(index) {
                return false;
            }
            seen.push(*index);
            true
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_blocks_regexes_compile() {
        LazyLock::force(&ITEM_LEAD);
        LazyLock::force(&ATX_LEAD);
        LazyLock::force(&SETEXT_LEAD);
        LazyLock::force(&TASK_LEAD);
        LazyLock::force(&ATX_CLOSING);
        LazyLock::force(&FENCE);
        LazyLock::force(&QUOTE_LINES);
    }

    fn named<'p>(read: &'p ParsedSource<'_>, ref_text: &str) -> &'p OutlineNode {
        read.parsed
            .nodes
            .iter()
            .find(|node| node.ref_text == ref_text)
            .unwrap_or_else(|| panic!("「{ref_text}」のノードがある"))
    }

    #[test]
    fn edit_blocks_heading_block_holds_paragraphs_and_tables_up_to_the_next_node_outside_it() {
        // 0 # R / 1 空 / 2 ## A / 3 空 / 4 本文 / 5 空 / 6 | t | / 7 | - | / 8 空 / 9 ## B / 10 - x / 11 (末尾)
        let source = "# R\n\n## A\n\n本文\n\n| t |\n| - |\n\n## B\n- x\n";
        let read = ParsedSource::read(source);
        // 末尾の空行 (8) は入れない
        assert_eq!(read.block_lines(named(&read, "A")), Some(2..8));
        assert_eq!(read.block_end(named(&read, "A")), 8);
        assert_eq!(read.block_lines(named(&read, "B")), Some(9..11));
        // 配下でないノードがあとにないルートは、本文の最後の行まで
        assert_eq!(read.block_lines(named(&read, "R")), Some(0..11));
    }

    #[test]
    fn edit_blocks_item_block_holds_details_and_nested_items_but_not_the_blank_after() {
        // 3 # R / 4 - a / 5     > d / 6     - b / 7 空 / 8 - c / 9 (末尾)
        let source = "---\nmarkdag:\n---\n# R\n- a\n    > d\n    - b\n\n- c\n";
        let read = ParsedSource::read(source);
        assert_eq!(read.block_lines(named(&read, "a")), Some(4..7));
        assert_eq!(read.block_end(named(&read, "a")), 7);
        assert_eq!(read.block_lines(named(&read, "b")), Some(6..7));
        assert_eq!(read.block_lines(named(&read, "c")), Some(8..9));
    }

    #[test]
    fn edit_blocks_a_root_without_a_line_spans_the_whole_body() {
        // 見出しがなく最上位のブロックが 2 つ: ルートは行を持たず、子はブロックの最後の空でない行 (6) のあとに足す
        let source = "---\ntitle: T\nmarkdag:\n---\n- a\n\n1. b\n\n";
        let read = ParsedSource::read(source);
        let root = &read.parsed.nodes[0];
        assert!(root.lines.is_none());
        assert_eq!(read.block_lines(root), None);
        assert_eq!(read.block_end(root), 7);
    }

    #[test]
    fn edit_blocks_ordered_items_are_told_by_their_number_marker() {
        for (source, ordered) in [
            ("# R\n1. a\n", true),
            ("# R\n3) a\n", true),
            ("# R\n- a\n", false),
            ("# R\n* [x] a\n", false),
            ("# R\n10. [ ] a\n", true),
        ] {
            let read = ParsedSource::read(source);
            assert_eq!(
                read.is_ordered_item(&read.parsed.nodes[1]),
                ordered,
                "{source:?}"
            );
        }
    }
}

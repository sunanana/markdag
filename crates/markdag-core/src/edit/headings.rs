// 原文なし。
// 印を読まない見出し (下線の見出しと、行頭に空白のある ATX の見出し) を、Markdown の読み方が同じ ATX の見出し (行頭に空白のない `## 名前`) に
// 書き直す。印 (タグ、グループ、$id) を書く操作が、その見出しに印を書く前に当てる。下線の見出しは解析の段のまま (= は 1 段、- は 2 段) の
// # の並びにし、本文が 2 行以上なら空白 1 つでつなぐ。行頭に空白のある ATX の見出しは空白を外す (段と閉じの # の並びは残す)。
// 本文が ATX の見出しの行で印や閉じの記号に読まれる字で終わるなら、名前の変更と同じ逃がしで `\` を置く (名前を変えない)。前後の空行は足さない。
// 書き直したあとの原文を解析し直し、本文の形 (ノードの数、親子、名前、種類) と全部のノードの印が変わらず、書き直した見出しに印を書けるときだけ書き直す
// (本文が 2 行以上の下線の見出しは、名前が 1 行目だけなので、つなぐと名前が変わり書き直せない)。
use super::blocks::{BOM, ParsedSource};
use super::lines::{LinePlan, composed, split_carriage};
use super::names::heading_body;
use super::verify::{Expectation, keeps_structure, same_marks};
use crate::parse::BlockTag;
use crate::types::{EditSourceResult, LineSplice, NodeKind, OutlineNode};

/// ATX の見出しへの書き直し: start の行から count 行 (下線の見出しは下線の行まで) を line (行末の \r を含む) の 1 行にする
#[derive(Debug, Clone)]
pub(super) struct AtxHeading {
    pub(super) start: u32,
    pub(super) count: u32,
    pub(super) line: String,
}

impl AtxHeading {
    // 行の列 (read の原文の行のままの位置) に当てる
    fn apply(&self, plan: &mut LinePlan<'_>) {
        let start = self.start as usize;
        plan.remove(start + 1, (self.count as usize).saturating_sub(1));
        plan.rewrite(start, self.line.clone());
    }
}

/// 印を読まない見出しを ATX の見出しにする書き直し。印を読む見出しと項目と、書き直すと読み方が変わる見出しは None
pub(super) fn atx_heading(read: &ParsedSource<'_>, node: &OutlineNode) -> Option<AtxHeading> {
    if read.kind_of(node) != NodeKind::Heading {
        return None;
    }
    let first = read.first_line(node)?;
    if first.can_mark {
        return None;
    }
    let Some(BlockTag::Heading(level)) = read.tag_of(node) else {
        return None;
    };
    let range = node.lines.as_ref()?;
    let bom = if first.lead.starts_with(BOM) {
        "\u{feff}"
    } else {
        ""
    };
    let setext = range.end > range.start + 1;
    let line = if setext {
        // 下線の見出し: 行頭の空白を外し、2 行目からの本文 (最後の行は下線) を空白でつなぐ
        let task = first.lead.get(first.marker.len()..).unwrap_or_default();
        let lead = format!("{bom}{} {task}", "#".repeat(usize::from(level)));
        let more: String = read
            .lines
            .get(range.start as usize + 1..(range.end as usize).saturating_sub(1))
            .unwrap_or_default()
            .iter()
            .map(|line| format!(" {}", split_carriage(line).0.trim_matches([' ', '\t'])))
            .collect();
        let body = format!("{}{more}", first.body);
        format!("{lead}{}", heading_body(&lead, &body, ""))
    } else {
        let lead = format!(
            "{bom}{}",
            first
                .lead
                .trim_start_matches(BOM)
                .trim_start_matches([' ', '\t'])
        );
        format!(
            "{lead}{}{}",
            heading_body(&lead, first.body, first.rest),
            first.rest
        )
    };
    let heading = AtxHeading {
        start: range.start,
        count: range.end - range.start,
        line: format!("{}{}", line.trim_end_matches([' ', '\t']), first.carriage),
    };
    // 書き直したあとも本文の形と印が変わらず、書き直した見出しに印を書ける
    let mut plan = LinePlan::new(&read.lines);
    heading.apply(&mut plan);
    let text = plan.text();
    let after = ParsedSource::read(&text);
    let correspondence = keeps_structure(read, &after, &plan.splices(), &Expectation::default())?;
    let marks_kept = read.parsed.nodes.iter().all(|old| {
        correspondence
            .new_id(old.id)
            .and_then(|id| after.node(id))
            .is_some_and(|new| same_marks(old, new))
    });
    let markable = correspondence
        .new_id(node.id)
        .and_then(|id| after.node(id))
        .and_then(|new| after.first_line(new))
        .is_some_and(|first| first.can_mark);
    (marks_kept && markable).then_some(heading)
}

/// 印を書くノード (nodes) のうち印を読まない見出しを全部 ATX の見出しに書き直した原文で op を当てた結果
/// (書き直しは op の書き換えと 1 つの差し替えの列にまとめる)。書き直す見出しがないか、書き直せない見出しがあれば None
/// (呼び出し側はそのまま進み、印を読まない見出しとして断る)
pub(super) fn with_atx_headings(
    source: &str,
    read: &ParsedSource<'_>,
    nodes: &[&OutlineNode],
    op: impl FnOnce(&str) -> EditSourceResult,
) -> Option<EditSourceResult> {
    let unmarkable: Vec<&OutlineNode> = nodes
        .iter()
        .copied()
        .filter(|node| {
            read.kind_of(node) == NodeKind::Heading
                && read.first_line(node).is_some_and(|first| !first.can_mark)
        })
        .collect();
    if unmarkable.is_empty() {
        return None;
    }
    let mut headings: Vec<AtxHeading> = unmarkable
        .iter()
        .map(|node| atx_heading(read, node))
        .collect::<Option<Vec<_>>>()?;
    // 後ろの見出しから当てる (下線の行を外すと後ろの行の位置がずれるため)
    headings.sort_by_key(|heading| std::cmp::Reverse(heading.start));
    let mut plan = LinePlan::new(&read.lines);
    for heading in &headings {
        heading.apply(&mut plan);
    }
    let rewritten: Vec<LineSplice> = plan.splices();
    let text = plan.text();
    Some(match op(&text) {
        EditSourceResult::Edited {
            splices,
            select,
            rename,
            notes,
        } => EditSourceResult::Edited {
            splices: composed(source, &rewritten, &splices),
            select,
            rename,
            notes,
        },
        other => other,
    })
}

// 原文なし。
// 番号付きのリストの番号の振り直し。兄弟が増えたか減ったリストの項目の原文の番号を、書き換える前の始まりの番号から数えた番号
// (図の名前の頭の番号と同じ数え方) に書き直す行の列を作る。先頭を消すか外へ移しても、始まりの番号は書き換える前のまま。
// 全部同じ番号で書いたリスト (「1. 1. 1.」のように番号を表示に任せる書き方) は振り直さない (足す項目も同じ番号で書くので、
// どの操作のあとも同じ番号のまま。足す項目の番号は行頭の形の側が決める)。
// 足すときは足したあとの原文に当て、消すか外へ移すときは外す前の原文に (外すノードを数えずに) 当てる。外してから振り直すと、
// 外したあとの原文が別の形に読まれることがあるため (入れ子の番号付きのリストの先頭を外すと、2. から始まる続きは段落を割り込めない)。
// 番号の字の書き直しと、桁が増えたときの子の字下げは行頭の形の側が受け持つ。書き換えたあとの確かめと参照の追随は呼ぶ側
use super::blocks::{ParsedSource, start_line};
use super::lines::LinePlan;
use super::shape::{Indentation, renumbered_lines, same_number_list, written_number};
use crate::types::OutlineNode;

/// 振り直すリスト: 親の id と、書き換える前の始まりの番号 (最初の項目の数えた番号)
#[derive(Debug, Clone, Copy)]
pub(super) struct Renumbering {
    pub(super) parent: u32,
    pub(super) start: Option<u64>,
}

/// 兄弟が増えたか減った親 (before の id) のうち、全部同じ番号のリストを持たないものを、文書の順に重なりなく並べ、
/// 書き換える前の始まりの番号を添えたもの。リストの書き方と始まりの番号は書き換える前の原文で見る
/// (消して項目が 1 つになっても、先頭を消すか外へ移しても同じ)
pub(super) fn renumbered_lists(
    before: &ParsedSource<'_>,
    parents: impl IntoIterator<Item = u32>,
) -> Vec<Renumbering> {
    let mut lists: Vec<Renumbering> = parents
        .into_iter()
        .filter_map(|parent| {
            let node = before.node(parent)?;
            if same_number_list(before, node) {
                return None;
            }
            let start = children(before, node)
                .next()
                .and_then(|first| before.list_number(first));
            Some(Renumbering { parent, start })
        })
        .collect();
    lists.sort_unstable_by_key(|list| list.parent);
    lists.dedup_by_key(|list| list.parent);
    lists
}

/// read の lists の項目の番号を書き直した行の列と、書き直したあとの原文。skipped (このあと外すノード) は数えない。
/// 親ごとに 1 段ずつ当て、前の段で字下げをずらした原文で次の段を数える (入れ子のリストの親が 2 つあるとき)。
/// 書き直すものがなければ None
pub(super) fn renumber_lines<'a>(
    read: &'a ParsedSource<'_>,
    lists: &[Renumbering],
    skipped: &[u32],
) -> Option<(LinePlan<'a>, String)> {
    let mut plan = LinePlan::new(&read.lines);
    let mut text: Option<String> = None;
    for &list in lists {
        let next = {
            let reread;
            let current = match text.as_deref() {
                Some(text) => {
                    reread = ParsedSource::read(text);
                    &reread
                }
                None => read,
            };
            let Some(stage) = renumbering(current, list, skipped) else {
                continue;
            };
            plan = plan.then(&stage);
            stage.text()
        };
        text = Some(next);
    }
    text.map(|text| (plan, text))
}

/// read の parents の直下の番号付きの項目の、書いた番号が数えた番号とそろっているか (振り直した結果の確かめ)
pub(super) fn aligned(read: &ParsedSource<'_>, parents: impl IntoIterator<Item = u32>) -> bool {
    parents.into_iter().all(|parent| {
        read.node(parent).is_none_or(|parent| {
            children(read, parent)
                .all(|child| written_number(read, child) == read.list_number(child))
        })
    })
}

// 親の直下の子 (文書の順)
fn children<'r>(
    read: &'r ParsedSource<'_>,
    parent: &'r OutlineNode,
) -> impl Iterator<Item = &'r OutlineNode> + 'r {
    read.descendants(parent)
        .filter(move |child| child.parent == Some(parent.id))
}

// read の list の親の直下の番号付きの項目のうち、書いた番号がねらいの番号と違うものの番号を書き直した行の列。ねらいの番号は、
// 子が 1 つのリスト (解析が数えた番号が並びの順に 1 つずつ増える) なら、書き換える前の始まりの番号から skipped を除いて数えた番号。
// そうでなければ (項目 1 つのリストが並ぶときなど) 解析が数えた番号。書き直すものがなければ None
fn renumbering<'r>(
    read: &'r ParsedSource<'_>,
    list: Renumbering,
    skipped: &[u32],
) -> Option<LinePlan<'r>> {
    let parent = read.node(list.parent)?;
    let children: Vec<&OutlineNode> = children(read, parent).collect();
    let counted: Vec<Option<u64>> = children
        .iter()
        .map(|child| read.list_number(child))
        .collect();
    let first = counted.first().copied().flatten();
    let one_list = first.is_some_and(|first| {
        counted
            .iter()
            .zip(0..)
            .all(|(number, index)| *number == Some(first + index))
    });
    let indentation = Indentation::of(read);
    let mut plan = LinePlan::new(&read.lines);
    let mut changed = false;
    let mut position: u64 = 0;
    for (child, counted) in children.iter().zip(&counted) {
        if skipped.contains(&child.id) {
            continue;
        }
        let index = position;
        position += 1;
        let (Some(counted), Some(written), Some(at)) =
            (*counted, written_number(read, child), start_line(child))
        else {
            continue;
        };
        let wanted = match list.start {
            Some(start) if one_list => start + index,
            _ => counted,
        };
        if wanted == written {
            continue;
        }
        let Some(lines) = renumbered_lines(read, child, wanted, &indentation) else {
            continue;
        };
        for (line_at, line) in (at as usize..).zip(lines) {
            plan.rewrite(line_at, line);
        }
        changed = true;
    }
    changed.then_some(plan)
}

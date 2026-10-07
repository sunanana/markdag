// 原文なし。
// 書き換えたあとの確かめと選び直し。書き換えたあとのノードから書いたノード (足したノードか、動かしたノードと配下) を除き、
// 書き換える前のノードから消したノードと配下 (動かしたノードと配下) を除いて、残りを文書の順で対応させ、操作が触らないノードの数、
// 文書の順、親、名前 (refText)、要素の種類、1 行目の行 (行の差し替えで写したもの。容器は、書き換える前と後のどちらも、
// 消したノードと書いたノードを除いた最初の子の行) が変わらないことを確かめる。
// 足したノードは、ねらいの親の子で、印のない行に読まれることを見る。動かしたノードは、ねらいの親の子で、名前と印が動かす前のままで、
// 書いた形 (見出しの段か項目) に読まれることを見る (配下は比べない)。CommonMark の読み方で行の意味が変わる書き換え
// (段落を割り込めない項目、下線の見出しになる行、触らない項目を取り込むか手放す容器など) をここで止める。
// 確かめを通れば、書き換える前のノードから書き換えたあとのノードへの対応を返す (選び直しと、参照の追随が使う)。
// 選ぶノードは、書き換えたあとの原文を解析し直した id と refText で返す (id は書き換えでずれるため)。
use std::ops::RangeInclusive;
use std::sync::LazyLock;

use regex::Regex;

use super::blocks::{ParsedSource, start_line};
use crate::parse::BlockTag;
use crate::types::{LineSplice, NodeKind, NodeTag, NodeTarget, OutlineNode, TaskState};

// 番号付きの項目の名前の頭の番号 (解析が並びの位置から付けるもの)
static LIST_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+\.(?: |$)").expect("固定の正規表現"));

/// 操作のねらい (確かめで、変わってよいとする所)
#[derive(Default)]
pub(super) struct Expectation {
    /// 名前を変えたノード (書き換える前の id)。名前は比べず、印とタスクの状態が変わらないことを見る
    pub(super) renamed: Option<u32>,
    /// 消したノード (書き換える前の id)。配下ごと、書き換えたあとのノードと対応しない
    pub(super) removed: Vec<u32>,
    /// 書いたノード (足したノードか、動かしたノード)
    pub(super) placed: Option<Placed>,
}

/// 書いたノードのねらい
pub(super) struct Placed {
    /// 書き換えたあとの原文での 1 行目の行
    pub(super) line: u32,
    /// 親 (書き換える前の id)。None は、行も子もないルートに足して、足したノードがルートに置き換わるとき
    pub(super) parent: Option<u32>,
    pub(super) node: PlacedNode,
}

/// 書いたノードの中身のねらい
pub(super) enum PlacedNode {
    /// 足したノード。未着手のタスクの記号を書いたか
    Added { task: bool },
    /// 動かしたノード。名前 (番号付きの項目は頭の番号を除く) と印は動かす前のノード (original) のまま、要素の種類は tag
    Moved {
        name: String,
        original: Box<OutlineNode>,
        tag: BlockTag,
    },
}

impl PlacedNode {
    /// read の原文の node を、要素の種類が tag になる形で書き直して動かす
    pub(super) fn moved(read: &ParsedSource<'_>, node: &OutlineNode, tag: BlockTag) -> Self {
        PlacedNode::Moved {
            name: comparable_name(read, node).to_string(),
            original: Box::new(node.clone()),
            tag,
        }
    }
}

/// 書き換える前のノードから書き換えたあとのノードへの対応 (id から id へ)。消したノードと配下、動かしたノードの配下は対応を持たない
pub(super) struct Correspondence {
    // 添字は書き換える前の id - 1
    ids: Vec<Option<u32>>,
    /// 書いたノード (足したか動かしたもの) の、書き換えたあとの id
    pub(super) placed: Option<u32>,
}

impl Correspondence {
    /// 書き換える前の id のノードに対応する、書き換えたあとのノードの id
    pub(super) fn new_id(&self, old: u32) -> Option<u32> {
        let index = (old as usize).checked_sub(1)?;
        self.ids.get(index).copied().flatten()
    }

    /// この対応のあとに next (書き換えたあとの原文を、さらに書き換えた対応) を重ねた対応。書いたノードは next のもの
    pub(super) fn then(&self, next: &Correspondence) -> Correspondence {
        Correspondence {
            ids: self
                .ids
                .iter()
                .map(|id| id.and_then(|id| next.new_id(id)))
                .collect(),
            placed: next.placed,
        }
    }

    /// 対応を 1 つ足す (動かしたノードと配下は、確かめで比べないので対応を持たない)
    pub(super) fn insert(&mut self, old: u32, new: u32) {
        if let Some(slot) = (old as usize)
            .checked_sub(1)
            .and_then(|index| self.ids.get_mut(index))
        {
            *slot = Some(new);
        }
    }

    // 書き換える前の親 (なければルート) に対応する、書き換えたあとの親であるか
    fn same_parent(&self, old: Option<u32>, new: Option<u32>) -> bool {
        match old {
            None => new.is_none(),
            Some(old) => self.new_id(old).is_some_and(|id| new == Some(id)),
        }
    }
}

/// 書き換える前の行が、書き換えたあとの何行目か。差し替えで消えた行は None。
/// 差し替えた範囲の行は、差し替えたあとの同じ位置の行に写す (その位置に行がなければ None)
pub(super) fn map_line(splices: &[LineSplice], line: u32) -> Option<u32> {
    let mut shift: i64 = 0;
    for splice in splices {
        let start = splice.start;
        if line < start {
            break;
        }
        let offset = line - start;
        if offset < splice.delete_count {
            let inserted = u32::try_from(splice.lines.len()).ok()?;
            if offset >= inserted {
                return None;
            }
            return u32::try_from(i64::from(line) + shift).ok();
        }
        shift += splice.lines.len() as i64 - i64::from(splice.delete_count);
    }
    u32::try_from(i64::from(line) + shift).ok()
}

/// 書き換えたあとの原文が、操作のねらいどおりの形に読まれるか。読まれれば、書き換える前と後のノードの対応
pub(super) fn keeps_structure(
    before: &ParsedSource<'_>,
    after: &ParsedSource<'_>,
    splices: &[LineSplice],
    expectation: &Expectation,
) -> Option<Correspondence> {
    let (old_nodes, new_nodes) = (&before.parsed.nodes, &after.parsed.nodes);
    let placed = match &expectation.placed {
        Some(placed) => Some((placed, node_starting_at(after, placed.line)?)),
        None => None,
    };
    if let Some((placed, node)) = placed
        && placed.parent.is_none()
    {
        // 行も子もないルートに足した項目は、解析でルートに置き換わる。ルートが名前 (frontmatter の title) を持っていれば、
        // その名前が図から消えるので認めない
        let PlacedNode::Added { task } = placed.node else {
            return None;
        };
        let replaced = old_nodes.len() == 1
            && new_nodes.len() == 1
            && node.id == 1
            && old_nodes.iter().all(|root| root.ref_text.is_empty())
            && fresh_marks(node, task);
        return replaced.then(|| Correspondence {
            ids: vec![None; old_nodes.len()],
            placed: Some(node.id),
        });
    }
    // 書き換える前の側で比べないノード: 消したノードと配下 (先行順なので親が先に決まる)
    let mut skipped = vec![false; old_nodes.len()];
    for (index, node) in old_nodes.iter().enumerate() {
        skipped[index] = expectation.removed.contains(&node.id)
            || node
                .parent
                .and_then(|parent| skipped.get((parent as usize).checked_sub(1)?).copied())
                .unwrap_or(false);
    }
    // 書き換えたあとの側で比べないノード: 書いたノードと、動かしたノードの配下
    let written = placed.map(|(placed, node)| {
        let last = match placed.node {
            PlacedNode::Added { .. } => node.id,
            PlacedNode::Moved { .. } => after
                .descendants(node)
                .last()
                .map_or(node.id, |last| last.id),
        };
        node.id..=last
    });
    let old_kept: Vec<&OutlineNode> = old_nodes
        .iter()
        .zip(&skipped)
        .filter(|(_, skipped)| !**skipped)
        .map(|(node, _)| node)
        .collect();
    let new_kept: Vec<&OutlineNode> = new_nodes
        .iter()
        .filter(|node| {
            written
                .as_ref()
                .is_none_or(|written| !written.contains(&node.id))
        })
        .collect();
    if old_kept.len() != new_kept.len() {
        return None;
    }
    let mut ids = vec![None; old_nodes.len()];
    for (old, new) in old_kept.iter().zip(&new_kept) {
        if let Some(slot) = (old.id as usize)
            .checked_sub(1)
            .and_then(|index| ids.get_mut(index))
        {
            *slot = Some(new.id);
        }
    }
    let correspondence = Correspondence {
        ids,
        placed: placed.map(|(_, node)| node.id),
    };
    let kept_ok = old_kept.iter().zip(&new_kept).all(|(old, new)| {
        correspondence.same_parent(old.parent, new.parent)
            && before.tag_of(old) == after.tag_of(new)
            && kept_start_line(before, old, &skipped).and_then(|line| map_line(splices, line))
                == new_start_line(after, new, written.as_ref())
            && if expectation.renamed == Some(old.id) {
                same_marks(old, new)
            } else {
                comparable_name(before, old) == comparable_name(after, new)
            }
    });
    let placed_ok = placed.is_none_or(|(placed, node)| {
        correspondence.same_parent(placed.parent, node.parent)
            && match &placed.node {
                PlacedNode::Added { task } => fresh_marks(node, *task),
                PlacedNode::Moved {
                    name,
                    original,
                    tag,
                } => {
                    comparable_name(after, node) == name
                        && same_marks(original, node)
                        && after.tag_of(node) == Some(*tag)
                }
            }
    });
    (kept_ok && placed_ok).then_some(correspondence)
}

/// ノードを指す NodeTarget (その原文を解析した id と refText)
pub(super) fn target_of(node: &OutlineNode) -> NodeTarget {
    NodeTarget {
        id: f64::from(node.id),
        ref_text: node.ref_text.clone(),
    }
}

// 書き換えたあとに残るノードの、書き換える前の原文で見た 1 行目の行。容器の 1 行目は最初の項目の行なので、
// 残った最初の子の 1 行目 (最初の項目を消すか動かすと、容器は次の項目の行から始まる)。残る子がなければ自分の 1 行目
fn kept_start_line(before: &ParsedSource<'_>, node: &OutlineNode, skipped: &[bool]) -> Option<u32> {
    if before.kind_of(node) != NodeKind::List {
        return start_line(node);
    }
    let removed = |child: &OutlineNode| {
        (child.id as usize)
            .checked_sub(1)
            .and_then(|index| skipped.get(index).copied())
            .unwrap_or(false)
    };
    before
        .descendants(node)
        .find(|child| child.parent == Some(node.id) && !removed(child))
        .map_or_else(|| start_line(node), start_line)
}

// 書き換えたあとに残るノードの 1 行目。容器の 1 行目は最初の項目の行なので、書いたノード (足したノードか、動かしたノードと配下) を
// 除いた最初の子の 1 行目 (容器の最初の項目の上に兄弟を足すと、容器は足した項目の行から始まる)。書いた子のほかに子がなければ自分の 1 行目
fn new_start_line(
    after: &ParsedSource<'_>,
    node: &OutlineNode,
    written: Option<&RangeInclusive<u32>>,
) -> Option<u32> {
    if after.kind_of(node) != NodeKind::List {
        return start_line(node);
    }
    after
        .descendants(node)
        .find(|child| {
            child.parent == Some(node.id)
                && written.is_none_or(|written| !written.contains(&child.id))
        })
        .map_or_else(|| start_line(node), start_line)
}

fn node_starting_at<'p>(after: &'p ParsedSource<'_>, line: u32) -> Option<&'p OutlineNode> {
    after
        .parsed
        .nodes
        .iter()
        .filter(|node| start_line(node) == Some(line))
        .max_by_key(|node| (after.kind_of(node) != NodeKind::List, node.depth))
}

// 比べる名前。番号付きの項目は頭の番号を除く (解析は番号を並びの位置から付けるので、兄弟を足すと後ろの項目の番号が変わる)
fn comparable_name<'n>(read: &ParsedSource<'_>, node: &'n OutlineNode) -> &'n str {
    let name = node.ref_text.as_str();
    if !read.is_ordered_item(node) {
        return name;
    }
    LIST_NUMBER
        .find(name)
        .map_or(name, |number| &name[number.end()..])
}

// 足したノードの 1 行目に印 (タグ、グループ、$id) がなく、タスクの状態が書いた記号どおり (未着手か、タスクでない)
fn fresh_marks(node: &OutlineNode, task: bool) -> bool {
    node.tags.is_empty()
        && node.groups.is_empty()
        && node.ref_id.is_none()
        && node.task.as_ref().map(|task| task.state) == task.then_some(TaskState::Todo)
}

// 1 行目の印 (タグはキーと値。位置は名前の長さで動くので比べない)、グループ、$id、タスクの状態が同じか
pub(super) fn same_marks(old: &OutlineNode, new: &OutlineNode) -> bool {
    let tags = |tags: &[NodeTag]| -> Vec<(String, Vec<String>)> {
        tags.iter()
            .map(|tag| (tag.key.clone(), tag.values.clone()))
            .collect()
    };
    tags(&old.tags) == tags(&new.tags)
        && old.groups == new.groups
        && old.ref_id == new.ref_id
        && old.task.as_ref().map(|task| task.state) == new.task.as_ref().map(|task| task.state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_verify_regexes_compile() {
        LazyLock::force(&LIST_NUMBER);
    }

    fn splice(start: u32, delete_count: u32, lines: &[&str]) -> LineSplice {
        LineSplice {
            start,
            delete_count,
            lines: lines.iter().map(|line| (*line).to_string()).collect(),
        }
    }

    #[test]
    fn edit_map_line_follows_replaced_deleted_and_inserted_lines() {
        let splices = [
            splice(1, 1, &["x"]),
            splice(3, 2, &[]),
            splice(6, 0, &["y", "z"]),
        ];
        let mapped: Vec<Option<u32>> = (0..8).map(|line| map_line(&splices, line)).collect();
        assert_eq!(
            mapped,
            [
                Some(0),
                Some(1),
                Some(2),
                None,
                None,
                Some(3),
                Some(6),
                Some(7)
            ]
        );
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    #[test]
    fn edit_verify_target_of_points_at_the_node_by_its_id_and_ref_text() {
        let read = ParsedSource::read("# R\n1. a\n");
        let target = target_of(&read.parsed.nodes[1]);
        assert_eq!(target.id, 2.0);
        assert_eq!(target.ref_text, "1. a");
    }

    #[test]
    fn edit_verify_node_starting_at_a_line_prefers_the_deepest_node_that_is_not_a_container() {
        // リストだけの文書: ルート (容器) と最初の項目が同じ行
        let read = ParsedSource::read("- a\n- b\n");
        let name = |read: &ParsedSource<'_>, line: u32| {
            node_starting_at(read, line).map(|node| node.ref_text.clone())
        };
        assert_eq!(name(&read, 0).as_deref(), Some("a"));
        assert_eq!(name(&read, 1).as_deref(), Some("b"));
        // 見出しの下に種類の違うリストが 2 つ: 容器と最初の項目が同じ行
        let read = ParsedSource::read("# R\n\n- a\n- b\n\n1. c\n2. d\n");
        assert_eq!(name(&read, 0).as_deref(), Some("R"));
        assert_eq!(name(&read, 2).as_deref(), Some("a"));
        assert_eq!(name(&read, 5).as_deref(), Some("1. c"));
        // どのノードも始まらない行
        assert_eq!(name(&read, 1), None);
    }
}

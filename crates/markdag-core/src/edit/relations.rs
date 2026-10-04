// 原文なし。
// relations を書き足す操作。線を引く (addRelation) は、markdag.relations.depends の一覧の末尾に「始点 --> 終点」を 1 つ足す。
// 既存のノードへの合流 (joinInto) は、合流先へもう線がある始点と、合流先から線をたどって届く始点 (引くと閉路になる) を外し、
// 残りが 2 つ以上なら join に「始点 & … --> 合流先」を 1 つ、1 つなら depends に「始点 --> 合流先」を足す。
// 新しいノードへの合流 (joinIntoNew) は、文書でいちばん後ろの始点を含む最上位の枝のすぐあとに最上位の兄弟を足し、そこへ join を書く
// (枝がリストの入れ物なら、そのリストの最後に項目として足す)。
// 線のつながり (届くかの判定) は、木の親から子への線と、解析し直したモデルの relations の線で見る (図に描かれる線と同じ)。
// markdag キーのない文書には先に markdag: を (frontmatter のない文書には frontmatter ごと) 足し、参照の書き方は足したあとの原文で決める。
// 書き足しと書いたあとの確かめは参照の書き直しの側が行う (名前で 1 つに決まらないノードは 1 行目の末尾に $n<番号> を足して指す)。
use indexmap::IndexMap;

use super::blocks::ParsedSource;
use super::body::{child_edit, sibling_edit};
use super::frontmatter::Marking;
use super::refs::{Follow, Guard, NewRelation, rewrite_references};
use super::verify::target_of;
use super::{STALE_NODE, STRUCTURE_CHANGED, refused};
use crate::layout::project::VisibleEdgeKind;
use crate::model::model::{ModelOptions, build_model};
use crate::types::{
    EdgeTarget, EditNote, EditNoteCode, EditReasonCode, EditRename, EditSelection,
    EditSourceResult, LineSplice, NodeKind, NodeTarget, OutlineNode, RelationKind,
};

/// from から to への線を引く。markdag.relations.depends の末尾に足し、引いた線を選ぶ
pub(super) fn add_relation(source: &str, from: &NodeTarget, to: &NodeTarget) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let (Some(from_node), Some(to_node)) = (before.find(from), before.find(to)) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    if from_node.id == to_node.id {
        return refused(
            EditReasonCode::SameNode,
            "始点と終点が同じノードなので、線を引けません",
        );
    }
    let edges = Edges::of(source, &before);
    if edges.exists(from_node.id, to_node.id) {
        return refused(
            EditReasonCode::EdgeExists,
            "この 2 つのノードの間には、同じ向きの線がもうあります",
        );
    }
    if edges.reaches(to_node.id, from_node.id) {
        return refused(
            EditReasonCode::Cycle,
            "終点から始点へ木の親子か線をたどって届くので、この線を引くと閉路になり、図に描かれません",
        );
    }
    match draw(
        source,
        &before,
        &[from_node],
        to_node,
        RelationKind::Depends,
    ) {
        Ok(drawn) => EditSourceResult::Edited {
            splices: drawn.splices,
            select: EditSelection::Edge {
                edge: EdgeTarget {
                    kind: VisibleEdgeKind::Depends,
                    source: drawn.sources.first().copied().unwrap_or_default(),
                    target: drawn.target,
                },
            },
            rename: None,
            notes: drawn.notes,
        },
        Err(result) => result,
    }
}

/// sources から既存の target へ合流する。外した始点の数を知らせ、合流先を選ぶ
pub(super) fn join_into(
    source: &str,
    sources: &[NodeTarget],
    target: &NodeTarget,
) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let (Some(nodes), Some(target_node)) = (found(&before, sources), before.find(target)) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    // 合流先へもう線がある始点 (木の親を含む) と、合流先から届く始点 (自分自身を含む) を外す
    let edges = Edges::of(source, &before);
    let (mut existing, mut cycle) = (0u32, 0u32);
    let kept: Vec<&OutlineNode> = nodes
        .into_iter()
        .filter(|node| {
            if edges.exists(node.id, target_node.id) {
                existing += 1;
                false
            } else if edges.reaches(target_node.id, node.id) {
                cycle += 1;
                false
            } else {
                true
            }
        })
        .collect();
    if kept.is_empty() {
        return refused(
            EditReasonCode::AllSourcesSkipped,
            "どの始点も、合流先へもう線があるか、合流先からたどって届く (線を引くと閉路になる) ので、合流する線がありません",
        );
    }
    let kind = if kept.len() >= 2 {
        RelationKind::Join
    } else {
        RelationKind::Depends
    };
    let drawn = match draw(source, &before, &kept, target_node, kind) {
        Ok(drawn) => drawn,
        Err(result) => return result,
    };
    let mut notes = skipped_notes(cycle, existing);
    notes.extend(drawn.notes);
    EditSourceResult::Edited {
        splices: drawn.splices,
        select: EditSelection::Nodes {
            nodes: vec![drawn.target_node],
        },
        rename: None,
        notes,
    }
}

/// sources から新しいノード (名前は label) へ合流する。新しいノードは、文書でいちばん後ろの始点を含む最上位の枝のすぐあとに、
/// 最上位の兄弟として足す (枝がリストの入れ物なら、そのリストの最後の項目のあと)。新しいノードを選び、名前の入力を開く
pub(super) fn join_into_new(source: &str, sources: &[NodeTarget], label: &str) -> EditSourceResult {
    let before = ParsedSource::read(source);
    let Some(nodes) = found(&before, sources) else {
        return refused(EditReasonCode::StaleNode, STALE_NODE);
    };
    if nodes.len() < 2 {
        return refused(
            EditReasonCode::TooFewSources,
            "合流するには始点が 2 つ以上いります",
        );
    }
    let marking = match Marking::of(source, &before) {
        Ok(marking) => marking,
        Err(result) => return result,
    };
    let marked = ParsedSource::read(&marking.text);
    let Some(ids) = marking.ids(&before, &marked, &nodes) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    // いちばん後ろの始点を含む最上位の枝 (ルートの子)
    let Some(mut branch) = ids.iter().max().and_then(|id| marked.node(*id)) else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    while let Some(parent) = branch.parent.and_then(|id| marked.node(id))
        && parent.parent.is_some()
    {
        branch = parent;
    }
    // 枝がリストの入れ物 (容器) なら、そのリストの最後に、入れ物に子を足すのと同じ形の項目として足す
    // (容器は自分の行を持たず、見出しで足すと前のリストが読まれなくなるため)
    let edit = if marked.kind_of(branch) == NodeKind::List {
        child_edit(&marking.text, &marked, branch, label)
    } else {
        sibling_edit(&marking.text, &marked, branch, label)
    };
    let edit = match edit {
        Ok(edit) => edit,
        Err(result) => return result,
    };
    let after = ParsedSource::read(&edit.text);
    let Some(sources) = ids
        .iter()
        .map(|id| edit.correspondence.new_id(*id))
        .collect::<Option<Vec<u32>>>()
    else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    // 新しいノードは線も子も持たないので、外す始点はない
    let relation = NewRelation {
        kind: RelationKind::Join,
        sources,
        target: edit.selected,
    };
    let follow = Follow::default();
    let guard = Guard {
        before: &marked,
        correspondence: &edit.correspondence,
        follow: &follow,
    };
    let rewritten = match rewrite_references(&after, Some(guard), Some(&relation)) {
        Ok(Some(rewritten)) => rewritten,
        Ok(None) => return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED),
        Err(reason) => return EditSourceResult::Refused { reason },
    };
    let last = ParsedSource::read(&rewritten.text);
    let Some(joined) = rewritten
        .drawn
        .as_ref()
        .and_then(|(_, target)| last.node(*target))
        .map(target_of)
    else {
        return refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED);
    };
    let splices = marking
        .plan
        .then(&edit.plan)
        .then(&rewritten.plan)
        .splices();
    let mut notes = marking.notes(&before);
    notes.extend(rewritten.notes);
    EditSourceResult::Edited {
        splices,
        select: EditSelection::Nodes {
            nodes: vec![joined.clone()],
        },
        rename: Some(EditRename::Node { node: joined }),
        notes,
    }
}

/// 図の線のつながり: 木の親から子への線と、relations の線 (chain、fork、join が展開したものを含む、どの kind でも)
struct Edges {
    successors: IndexMap<u32, Vec<u32>>,
}

impl Edges {
    fn of(source: &str, read: &ParsedSource<'_>) -> Self {
        let mut successors: IndexMap<u32, Vec<u32>> = IndexMap::new();
        for node in &read.parsed.nodes {
            if let Some(parent) = node.parent {
                successors.entry(parent).or_default().push(node.id);
            }
        }
        let model = build_model(
            &read.parsed.nodes,
            &read.parsed.frontmatter,
            Some(source),
            &ModelOptions::default(),
        );
        for relation in &model.relations {
            successors
                .entry(relation.source)
                .or_default()
                .push(relation.target);
        }
        Edges { successors }
    }

    /// from から to への線がもうあるか
    fn exists(&self, from: u32, to: u32) -> bool {
        self.successors
            .get(&from)
            .is_some_and(|next| next.contains(&to))
    }

    /// from から線をたどって to へ届くか (from そのものは届くとする)
    fn reaches(&self, from: u32, to: u32) -> bool {
        let mut seen = vec![from];
        let mut stack = vec![from];
        while let Some(current) = stack.pop() {
            if current == to {
                return true;
            }
            for next in self.successors.get(&current).into_iter().flatten() {
                if !seen.contains(next) {
                    seen.push(*next);
                    stack.push(*next);
                }
            }
        }
        false
    }
}

// 指したノードを文書の順に並べ、重ねて指したノードを 1 つにしたもの。どれかが見つからなければ None
fn found<'p>(read: &'p ParsedSource<'_>, targets: &[NodeTarget]) -> Option<Vec<&'p OutlineNode>> {
    let mut nodes = targets
        .iter()
        .map(|target| read.find(target))
        .collect::<Option<Vec<&OutlineNode>>>()?;
    nodes.sort_by_key(|node| node.id);
    nodes.dedup_by_key(|node| node.id);
    Some(nodes)
}

// 合流で外した始点の知らせ (外したときだけ)
fn skipped_notes(cycle: u32, existing: u32) -> Vec<EditNote> {
    let mut notes = Vec::new();
    if cycle > 0 {
        notes.push(EditNote {
            code: EditNoteCode::SourcesCycle,
            count: cycle,
            message: format!(
                "合流先からたどって届く始点が {cycle} 個あり、線を引くと閉路になるので外しました"
            ),
        });
    }
    if existing > 0 {
        notes.push(EditNote {
            code: EditNoteCode::SourcesExisting,
            count: existing,
            message: format!("合流先へもう線がある始点が {existing} 個あったので外しました"),
        });
    }
    notes
}

/// 書き足した線
struct Drawn {
    splices: Vec<LineSplice>,
    /// 始点と終点 (書き換えたあとの原文の id)
    sources: Vec<u32>,
    target: u32,
    target_node: NodeTarget,
    notes: Vec<EditNote>,
}

// sources (文書の順) から target への線を kind の一覧の末尾に書き足す (始点が 2 つ以上なら「始点 & … --> 終点」)
fn draw(
    source: &str,
    before: &ParsedSource<'_>,
    sources: &[&OutlineNode],
    target: &OutlineNode,
    kind: RelationKind,
) -> Result<Drawn, EditSourceResult> {
    let marking = Marking::of(source, before)?;
    let marked = ParsedSource::read(&marking.text);
    let ends: Vec<&OutlineNode> = sources.iter().copied().chain([target]).collect();
    let Some((target_id, source_ids)) = marking
        .ids(before, &marked, &ends)
        .and_then(|ids| ids.split_last().map(|(last, rest)| (*last, rest.to_vec())))
    else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    let relation = NewRelation {
        kind,
        sources: source_ids,
        target: target_id,
    };
    let rewritten = match rewrite_references(&marked, None, Some(&relation)) {
        Ok(Some(rewritten)) => rewritten,
        Ok(None) => {
            return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
        }
        Err(reason) => return Err(EditSourceResult::Refused { reason }),
    };
    let last = ParsedSource::read(&rewritten.text);
    let Some(((sources, target), target_node)) = rewritten.drawn.clone().and_then(|drawn| {
        let node = last.node(drawn.1).map(target_of)?;
        Some((drawn, node))
    }) else {
        return Err(refused(EditReasonCode::StructureChanged, STRUCTURE_CHANGED));
    };
    let mut notes = marking.notes(before);
    notes.extend(rewritten.notes);
    Ok(Drawn {
        splices: marking.plan.then(&rewritten.plan).splices(),
        sources,
        target,
        target_node,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_relations_edges_follow_tree_lines_and_every_relation_kind() {
        // 1 R / 2 a / 3 b / 4 c / 5 d (c の子)。depends b → c、chain d → a
        let source = "---\nmarkdag:\n    relations:\n        depends:\n            - b --> c\n        chain:\n            - d --> a\n---\n# R\n- a\n- b\n- c\n    - d\n";
        let read = ParsedSource::read(source);
        let edges = Edges::of(source, &read);
        assert!(edges.exists(1, 2), "木の線");
        assert!(edges.exists(4, 5), "木の線");
        assert!(edges.exists(3, 4), "depends");
        assert!(edges.exists(5, 2), "chain");
        assert!(!edges.exists(2, 3));
        assert!(!edges.exists(4, 3), "線には向きがある");
        // b → c → d → a と届き、a からは b に届かない
        assert!(edges.reaches(3, 2));
        assert!(edges.reaches(1, 5));
        assert!(!edges.reaches(2, 3));
    }
}

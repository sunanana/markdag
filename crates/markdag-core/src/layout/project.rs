// 原文: src/layout/project.ts (2026-09-24)
// 折りたたみの前のモデルから、見えているグラフへ射影する。
// 隠れたノードを代表ノードに置き換えてエッジをまとめ、射影で生じた閉路を作る relations を配置の計算から外し、
// 配置上の親 (レイアウト木の親) を確定するところまでを受け持つ。座標は扱わない。
use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::limits::check_layout_number;
use crate::model::util::JsValue;
use crate::types::{GroupDef, LayoutError, LayoutInput, RelationKind};

/// 見えているノード。原文は LayoutInputNode を展開 (`...node`) して欄を足すので、欄の順は入力の欄のあとに depth、treeParent、folded
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleNode {
    pub id: u32,
    pub label: String,
    #[serde(with = "crate::model::util::js_f64")]
    pub width: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub height: f64,
    pub groups: Vec<String>,
    /// Markdown のツリーでの深さ。ルートが 1 (markmap の数え方に合わせる)
    pub depth: u32,
    pub tree_parent: Option<u32>,
    /// 閉じていて、隠れた配下を持つ
    pub folded: bool,
}

/// VisibleEdge.kind (原文の `'tree' | RelationKind`)
// RelationKind は 'tree' を持たないので、'tree' を足した別の enum にする (規則 4 章、A-159)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VisibleEdgeKind {
    Tree,
    Fork,
    Join,
    Chain,
    Depends,
}

impl VisibleEdgeKind {
    /// 原文の型の union と同じ順の、すべての値
    pub const ALL: &'static [VisibleEdgeKind] = &[
        VisibleEdgeKind::Tree,
        VisibleEdgeKind::Fork,
        VisibleEdgeKind::Join,
        VisibleEdgeKind::Chain,
        VisibleEdgeKind::Depends,
    ];

    /// 原文の文字
    pub fn as_str(self) -> &'static str {
        match self {
            VisibleEdgeKind::Tree => "tree",
            VisibleEdgeKind::Fork => "fork",
            VisibleEdgeKind::Join => "join",
            VisibleEdgeKind::Chain => "chain",
            VisibleEdgeKind::Depends => "depends",
        }
    }

    /// JS の値が原文の文字のどれかならその値
    pub fn from_js(value: &JsValue) -> Option<Self> {
        match value {
            JsValue::String(text) => Self::ALL.iter().copied().find(|item| item.as_str() == text),
            _ => None,
        }
    }
}

impl From<RelationKind> for VisibleEdgeKind {
    fn from(kind: RelationKind) -> Self {
        match kind {
            RelationKind::Fork => VisibleEdgeKind::Fork,
            RelationKind::Join => VisibleEdgeKind::Join,
            RelationKind::Chain => VisibleEdgeKind::Chain,
            RelationKind::Depends => VisibleEdgeKind::Depends,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleEdge {
    pub kind: VisibleEdgeKind,
    pub source: u32,
    pub target: u32,
    /// まとめた元のエッジ。relations は入力の配列での位置、ツリーのエッジは空
    pub member_relation_indexes: Vec<usize>,
    /// 端点のどちらかが代表ノードに置き換わった
    pub proxied: bool,
    /// 足すと閉路になるため、横位置の計算と配置上の親の候補から外した
    pub excluded_from_layout: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleGraph {
    pub root_id: u32,
    /// 文書順
    pub nodes: Vec<VisibleNode>,
    /// 描く線。ルートからの線を抑制したノードへのツリーのエッジは含まない
    pub edges: Vec<VisibleEdge>,
    /// ルート以外の見えているノードについて、レイアウト木での親。境界の JSON では `[[child, parent], ...]`
    #[serde(with = "crate::model::util::pairs")]
    pub layout_parent: IndexMap<u32, u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutParentCandidate {
    pub node: u32,
    pub relation_index: usize,
}

// computeLayoutParentHints の incoming の 1 要素 ({ node, relationIndex, kind })
#[derive(Clone)]
struct IncomingCandidate {
    node: u32,
    relation_index: usize,
    kind: RelationKind,
}

/// 原文: computeLayoutParentHints。
/// 配置上の親の候補を、モデル全体 (折りたたみの前) で優先順に並べる。
/// depends 以外の先行ノードを文書順に並べ、中央 (偶数個なら前側) から近い順。尽きたら depends の先行ノードを同じ規則で続ける。
pub fn compute_layout_parent_hints(
    input: &LayoutInput,
) -> IndexMap<u32, Vec<LayoutParentCandidate>> {
    let mut hints = IndexMap::new();
    for &target in &input.suppress_root_line {
        let incoming: Vec<IncomingCandidate> = input
            .relations
            .iter()
            .enumerate()
            .filter(|(_, relation)| relation.target == target)
            .map(|(relation_index, relation)| IncomingCandidate {
                node: relation.source,
                relation_index,
                kind: relation.kind,
            })
            .collect();
        let others: Vec<IncomingCandidate> = incoming
            .iter()
            .filter(|candidate| candidate.kind != RelationKind::Depends)
            .cloned()
            .collect();
        let depends: Vec<IncomingCandidate> = incoming
            .iter()
            .filter(|candidate| candidate.kind == RelationKind::Depends)
            .cloned()
            .collect();
        let mut ordered = order_from_center(&others, |candidate| candidate.node);
        ordered.extend(order_from_center(&depends, |candidate| candidate.node));
        hints.insert(
            target,
            ordered
                .into_iter()
                .map(|candidate| LayoutParentCandidate {
                    node: candidate.node,
                    relation_index: candidate.relation_index,
                })
                .collect(),
        );
    }
    hints
}

// 原文の orderFromCenter<T extends { node: number }>。node の取り出しを閉包で受ける
fn order_from_center<T: Clone>(candidates: &[T], node_of: impl Fn(&T) -> u32) -> Vec<T> {
    let mut sorted = candidates.to_vec();
    // sort_by_key も安定 (規則 2.3)
    sorted.sort_by_key(|candidate| node_of(candidate));
    // 候補が 0 個なら -1 だが、要素がないので結果は同じ (規則 2.1)
    let center = ((sorted.len() as f64 - 1.0) / 2.0).floor() as i64;
    let mut ranked: Vec<(T, usize, i64)> = sorted
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| (candidate, index, (index as i64 - center).abs()))
        .collect();
    ranked.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.1.cmp(&b.1)));
    ranked
        .into_iter()
        .map(|(candidate, _, _)| candidate)
        .collect()
}

/// 原文: project
pub fn project(input: &LayoutInput) -> Result<VisibleGraph, LayoutError> {
    project_with(input, None)
}

/// project と同じ射影を行い、配置上の親を選ぶときに枠 (boundary のグループ) を見る。
/// relations の始点が、このノードの入っていない枠の中に描かれるノードなら、その始点を配置上の親にしない
/// (付けると、このノードとその配下が枠の矩形の中に入り込むため)。候補がすべてそうなら、ツリーの親を配置上の親にし、
/// ルートからの線は抑制したままにする (線を戻すのは、候補が閉路で外れたときだけ)
pub fn project_framed(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
) -> Result<VisibleGraph, LayoutError> {
    project_with(input, Some((groups, groups_of)))
}

// 枠を持つグループの所属。ノードごとの所属と、同じグループのノードがツリーの親、子、兄弟にいて枠の中に描かれるグループ
struct Framing {
    groups_of: HashMap<u32, HashSet<String>>,
    framed_of: HashMap<u32, HashSet<String>>,
}

impl Framing {
    // 見えているノードだけで作る。枠のまとまりは、ツリーの線でつながるか、同じ配置上の親の下で縦に隣り合うメンバーで作られる
    // (compute_frames)。配置上の親はまだ決まっていないので、兄弟はツリーの親で見る
    fn new(
        nodes: &[VisibleNode],
        groups: &[GroupDef],
        groups_of: &IndexMap<u32, Vec<String>>,
    ) -> Self {
        let boundary: HashSet<&str> = groups
            .iter()
            .filter(|group| group.boundary)
            .map(|group| group.id.as_str())
            .collect();
        let own: HashMap<u32, HashSet<String>> = nodes
            .iter()
            .map(|node| {
                let set = groups_of
                    .get(&node.id)
                    .map(|list| {
                        list.iter()
                            .filter(|id| boundary.contains(id.as_str()))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                (node.id, set)
            })
            .collect();
        let empty = HashSet::new();
        let own_of = |id: u32| own.get(&id).unwrap_or(&empty);
        // (ツリーの親, グループ) ごとの、そのグループに入っている子の数と、子にそのグループがいる親
        let mut siblings: HashMap<(u32, &str), usize> = HashMap::new();
        let mut parent_of_member: HashSet<(u32, &str)> = HashSet::new();
        for node in nodes {
            let Some(parent) = node.tree_parent else {
                continue;
            };
            for group in own_of(node.id) {
                *siblings.entry((parent, group.as_str())).or_default() += 1;
                parent_of_member.insert((parent, group.as_str()));
            }
        }
        let framed_of = nodes
            .iter()
            .map(|node| {
                let framed: HashSet<String> = own_of(node.id)
                    .iter()
                    .filter(|group| {
                        let group = group.as_str();
                        let with_parent = node
                            .tree_parent
                            .is_some_and(|parent| own_of(parent).contains(group));
                        let with_child = parent_of_member.contains(&(node.id, group));
                        let with_sibling = node.tree_parent.is_some_and(|parent| {
                            siblings.get(&(parent, group)).copied().unwrap_or(0) >= 2
                        });
                        with_parent || with_child || with_sibling
                    })
                    .cloned()
                    .collect();
                (node.id, framed)
            })
            .collect();
        Framing {
            groups_of: own,
            framed_of,
        }
    }

    // candidate の下に node を付けてよいか: candidate が枠の中に描かれるグループに、node もすべて入っている
    fn accepts(&self, node: u32, candidate: u32) -> bool {
        let Some(framed) = self.framed_of.get(&candidate) else {
            return true;
        };
        let own = self.groups_of.get(&node);
        framed
            .iter()
            .all(|group| own.is_some_and(|set| set.contains(group)))
    }
}

// 枠を見るときに渡す、グループの定義とノードごとの所属
type FrameGroups<'a> = (&'a [GroupDef], &'a IndexMap<u32, Vec<String>>);

fn project_with(
    input: &LayoutInput,
    frames: Option<FrameGroups>,
) -> Result<VisibleGraph, LayoutError> {
    let Some(root_id) = input.nodes.first().map(|node| node.id) else {
        return Err(LayoutError {
            message: "入力にノードがない".to_string(),
        });
    };
    // 配置の入口の検査 (A-156 の (b))。有限でない大きさや大きすぎる大きさは、配置の計算 (flextree の輪郭の走査) を終わらなくする
    for node in &input.nodes {
        check_layout_number(node.width, || format!("ノード {} の width", node.id))?;
        check_layout_number(node.height, || format!("ノード {} の height", node.id))?;
    }

    // 同じ target が 2 度あれば後勝ち (Map の構築と同じ)
    let mut tree_parent_of: HashMap<u32, u32> = HashMap::new();
    for edge in &input.tree_edges {
        tree_parent_of.insert(edge.target, edge.source);
    }
    let folded: HashSet<u32> = input.folded.iter().copied().collect();

    // 文書順では親が必ず先に来るので、1 回の走査で深さと代表を決められる。
    // 親が後ろにある入力 (view は渡さない) では、深さは 0 + 1、代表は親の id をそのまま使う (原文の順序依存のまま)
    let mut depth_of: HashMap<u32, u32> = HashMap::new();
    let mut rep_of: HashMap<u32, u32> = HashMap::new();
    for node in &input.nodes {
        let Some(&parent) = tree_parent_of.get(&node.id) else {
            depth_of.insert(node.id, 1);
            rep_of.insert(node.id, node.id);
            continue;
        };
        depth_of.insert(node.id, depth_of.get(&parent).copied().unwrap_or(0) + 1);
        let parent_rep = rep_of.get(&parent).copied().unwrap_or(parent);
        // 親が隠れているか、親自身が閉じていれば、その代表 (閉じている祖先のうち最も上のもの) を引き継ぐ
        rep_of.insert(
            node.id,
            if parent_rep != parent || folded.contains(&parent) {
                parent_rep
            } else {
                node.id
            },
        );
    }
    let rep = |id: u32| -> u32 { rep_of.get(&id).copied().unwrap_or(id) };
    let is_visible = |id: u32| -> bool { rep(id) == id };

    let has_children: HashSet<u32> = input.tree_edges.iter().map(|edge| edge.source).collect();
    let nodes: Vec<VisibleNode> = input
        .nodes
        .iter()
        .filter(|node| is_visible(node.id))
        .map(|node| VisibleNode {
            id: node.id,
            label: node.label.clone(),
            width: node.width,
            height: node.height,
            groups: node.groups.clone(),
            depth: depth_of.get(&node.id).copied().unwrap_or(1),
            tree_parent: tree_parent_of.get(&node.id).copied(),
            folded: folded.contains(&node.id) && has_children.contains(&node.id),
        })
        .collect();

    let visible_tree_edges: Vec<VisibleEdge> = input
        .tree_edges
        .iter()
        .filter(|edge| is_visible(edge.target))
        .map(|edge| VisibleEdge {
            kind: VisibleEdgeKind::Tree,
            source: edge.source,
            target: edge.target,
            member_relation_indexes: Vec::new(),
            proxied: false,
            excluded_from_layout: false,
        })
        .collect();

    // relations を代表ノードどうしのエッジに置き換え、種類と両端が同じものをまとめる。
    // 原文のキー `${kind}:${source}>${target}` は組にする (規則 2.3、A-015)
    let mut merged: IndexMap<(RelationKind, u32, u32), VisibleEdge> = IndexMap::new();
    for (relation_index, relation) in input.relations.iter().enumerate() {
        let source = rep(relation.source);
        let target = rep(relation.target);
        if source == target {
            continue;
        }
        let proxied = source != relation.source || target != relation.target;
        if let Some(existing) = merged.get_mut(&(relation.kind, source, target)) {
            existing.member_relation_indexes.push(relation_index);
            existing.proxied = existing.proxied || proxied;
            continue;
        }
        merged.insert(
            (relation.kind, source, target),
            VisibleEdge {
                kind: relation.kind.into(),
                source,
                target,
                member_relation_indexes: vec![relation_index],
                proxied,
                excluded_from_layout: false,
            },
        );
    }
    let mut relation_edges: Vec<VisibleEdge> = merged.into_values().collect();

    // ツリーのエッジをすべて入れたグラフに、relations を記述順に 1 本ずつ足し、閉路になるものを外す。
    // 先に足した辺が後の辺を閉路にするので relation_edges の順を保つ
    let mut successors: HashMap<u32, Vec<u32>> =
        nodes.iter().map(|node| (node.id, Vec::new())).collect();
    for edge in &visible_tree_edges {
        add_edge(&mut successors, edge.source, edge.target);
    }
    for edge in &mut relation_edges {
        if reaches(&successors, edge.target, edge.source) {
            edge.excluded_from_layout = true;
        } else {
            add_edge(&mut successors, edge.source, edge.target);
        }
    }

    // 配置上の親の確定。候補を生んだエッジが外されていたら次の候補へ。尽きたらルートに戻し、ルートからの線も戻す
    let hints = compute_layout_parent_hints(input);
    // relationIndex → relation_edges の添字 (エッジの参照は持たない。規則 2.6 の同一性は添字)
    let mut edge_of_relation: HashMap<usize, usize> = HashMap::new();
    for (edge_index, edge) in relation_edges.iter().enumerate() {
        for &relation_index in &edge.member_relation_indexes {
            edge_of_relation.insert(relation_index, edge_index);
        }
    }
    let framing = frames.map(|(groups, groups_of)| Framing::new(&nodes, groups, groups_of));
    let mut layout_parent: IndexMap<u32, u32> = IndexMap::new();
    let mut suppressed: HashSet<u32> = HashSet::new();
    for node in &nodes {
        let Some(tree_parent) = node.tree_parent else {
            continue;
        };
        // 原文の `edge !== undefined && !edge.excludedFromLayout`
        // relation_edges.get(edge_index) の None (閉路の判定のあとには届かない) は原文の undefined の側 (偽) に合流させる (規則 2.5、A-160 (3))
        let in_layout = |candidate: &&LayoutParentCandidate| {
            edge_of_relation
                .get(&candidate.relation_index)
                .and_then(|&edge_index| relation_edges.get(edge_index))
                .is_some_and(|edge| !edge.excluded_from_layout)
        };
        let candidates = hints.get(&node.id).map(Vec::as_slice).unwrap_or(&[]);
        let adopted = candidates.iter().filter(in_layout).find(|candidate| {
            framing
                .as_ref()
                .is_none_or(|framing| framing.accepts(node.id, rep(candidate.node)))
        });
        if let Some(adopted) = adopted {
            layout_parent.insert(node.id, rep(adopted.node));
            suppressed.insert(node.id);
        } else if framing.is_some() && candidates.iter().any(|candidate| in_layout(&candidate)) {
            // 候補はあるが、どれも枠の外のノードを枠の中に入れてしまう。ツリーの親の下に置き、線は relations に任せる
            layout_parent.insert(node.id, tree_parent);
            suppressed.insert(node.id);
        } else {
            layout_parent.insert(node.id, tree_parent);
        }
    }

    let mut edges: Vec<VisibleEdge> = visible_tree_edges
        .into_iter()
        .filter(|edge| !suppressed.contains(&edge.target))
        .collect();
    edges.extend(relation_edges);
    Ok(VisibleGraph {
        root_id,
        nodes,
        edges,
        layout_parent,
    })
}

// 原文の addEdge。source が見えているノードでなければ黙って落とす (`?.push`)。規則 2.6 (successors を捕まえる閉包を関数に)
fn add_edge(successors: &mut HashMap<u32, Vec<u32>>, source: u32, target: u32) {
    if let Some(next) = successors.get_mut(&source) {
        next.push(target);
    }
}

// 原文の reaches。seen と stack で深さ優先にたどる (到達の可否だけなので LIFO の順は結果に効かないが原文のまま)。規則 2.6 (successors を捕まえる閉包を関数に)
fn reaches(successors: &HashMap<u32, Vec<u32>>, from: u32, to: u32) -> bool {
    let mut seen: HashSet<u32> = HashSet::from([from]);
    let mut stack = vec![from];
    while let Some(current) = stack.pop() {
        if current == to {
            return true;
        }
        for &next in successors.get(&current).map(Vec::as_slice).unwrap_or(&[]) {
            if seen.insert(next) {
                stack.push(next);
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LayoutInputEdge, LayoutInputNode, LayoutInputRelation};

    fn input(
        ids: &[u32],
        tree: &[(u32, u32)],
        relations: &[(RelationKind, u32, u32)],
        suppress: &[u32],
        folded: &[u32],
    ) -> LayoutInput {
        LayoutInput {
            name: "test".to_string(),
            nodes: ids
                .iter()
                .map(|&id| LayoutInputNode {
                    id,
                    label: format!("n{id}"),
                    width: 40.0,
                    height: 20.0,
                    groups: Vec::new(),
                })
                .collect(),
            tree_edges: tree
                .iter()
                .map(|&(source, target)| LayoutInputEdge { source, target })
                .collect(),
            relations: relations
                .iter()
                .map(|&(kind, source, target)| LayoutInputRelation {
                    source,
                    target,
                    kind,
                    origin: format!("{source} --> {target}"),
                })
                .collect(),
            suppress_root_line: suppress.to_vec(),
            folded: folded.to_vec(),
        }
    }

    fn pairs(map: &IndexMap<u32, u32>) -> Vec<(u32, u32)> {
        map.iter()
            .map(|(&child, &parent)| (child, parent))
            .collect()
    }

    #[test]
    fn project_empty_input_is_layout_error() {
        let error = project(&input(&[], &[], &[], &[], &[])).unwrap_err();
        assert_eq!(error.message, "入力にノードがない");
    }

    #[test]
    fn project_order_from_center_prefers_the_front_middle() {
        let order = |nodes: &[u32]| order_from_center(nodes, |&node| node);
        assert_eq!(order(&[]), Vec::<u32>::new());
        assert_eq!(order(&[5]), vec![5]);
        // 偶数個は前側の中央から
        assert_eq!(order(&[4, 1, 3, 2]), vec![2, 1, 3, 4]);
        assert_eq!(order(&[9, 8, 7, 5, 4]), vec![7, 5, 8, 4, 9]);
        // 同じ node は sort が安定なので入力の順のまま
        let tagged = [(2, 'a'), (1, 'b'), (2, 'c')];
        assert_eq!(
            order_from_center(&tagged, |item| item.0),
            vec![(2, 'a'), (1, 'b'), (2, 'c')]
        );
    }

    #[test]
    fn project_hints_put_depends_after_the_others() {
        use RelationKind::*;
        let graph_input = input(
            &[1, 2, 3, 4, 5],
            &[(1, 2), (1, 3), (1, 4), (1, 5)],
            &[(Depends, 2, 5), (Join, 4, 5), (Join, 3, 5), (Depends, 3, 5)],
            &[5, 5],
            &[],
        );
        let hints = compute_layout_parent_hints(&graph_input);
        assert_eq!(hints.len(), 1);
        let nodes: Vec<(u32, usize)> = hints[&5]
            .iter()
            .map(|candidate| (candidate.node, candidate.relation_index))
            .collect();
        assert_eq!(nodes, vec![(3, 2), (4, 1), (2, 0), (3, 3)]);
    }

    #[test]
    fn project_folded_branch_is_merged_into_proxy_edges() {
        use RelationKind::*;
        // 1 root / 2 A (閉じる) / 3 a1 / 4 B / 5 b1
        let graph = project(&input(
            &[1, 2, 3, 4, 5],
            &[(1, 2), (2, 3), (1, 4), (4, 5)],
            &[(Depends, 3, 5), (Depends, 2, 5), (Fork, 3, 3)],
            &[],
            &[2],
        ))
        .unwrap();
        assert_eq!(
            graph.nodes.iter().map(|node| node.id).collect::<Vec<_>>(),
            vec![1, 2, 4, 5]
        );
        assert!(graph.nodes[1].folded);
        assert_eq!(graph.nodes[3].depth, 3);
        let relation_edges: Vec<&VisibleEdge> = graph
            .edges
            .iter()
            .filter(|edge| edge.kind != VisibleEdgeKind::Tree)
            .collect();
        assert_eq!(relation_edges.len(), 1);
        assert_eq!((relation_edges[0].source, relation_edges[0].target), (2, 5));
        assert_eq!(relation_edges[0].member_relation_indexes, vec![0, 1]);
        assert!(relation_edges[0].proxied);
    }

    #[test]
    fn project_folded_leaf_is_not_marked_folded() {
        let graph = project(&input(&[1, 2], &[(1, 2)], &[], &[], &[2])).unwrap();
        assert!(!graph.nodes[1].folded);
    }

    #[test]
    fn project_excluded_candidate_falls_back_to_the_next_then_tree_parent() {
        use RelationKind::*;
        // 2 --> 3 と 3 --> 2 の 2 本目は閉路で外れる。3 の候補は 2 (外れていない) なので採る。
        // 2 の候補は 3 (外れた辺) だけなので、ツリーの親 1 に戻り、ルートからの線も残る
        let graph = project(&input(
            &[1, 2, 3],
            &[(1, 2), (1, 3)],
            &[(Chain, 2, 3), (Chain, 3, 2)],
            &[2, 3],
            &[],
        ))
        .unwrap();
        assert_eq!(pairs(&graph.layout_parent), vec![(2, 1), (3, 2)]);
        let flags: Vec<(u32, u32, bool)> = graph
            .edges
            .iter()
            .map(|edge| (edge.source, edge.target, edge.excluded_from_layout))
            .collect();
        assert_eq!(flags, vec![(1, 2, false), (2, 3, false), (3, 2, true)]);
    }

    #[test]
    fn project_order_dependence_when_parent_comes_later() {
        // 親が後ろにある入力 (view は渡さない): 4 は親 3 より前にあるので深さ 1 で自分が代表になり、
        // 3 が閉じた 2 の配下で隠れても 4 は見えたまま。配置上の親は見えていない 3 を指す (原文の順序依存のまま)
        let graph = project(&input(
            &[1, 4, 2, 3],
            &[(1, 2), (2, 3), (3, 4)],
            &[],
            &[],
            &[2],
        ))
        .unwrap();
        let depths: Vec<(u32, u32)> = graph
            .nodes
            .iter()
            .map(|node| (node.id, node.depth))
            .collect();
        assert_eq!(depths, vec![(1, 1), (4, 1), (2, 2)]);
        assert_eq!(pairs(&graph.layout_parent), vec![(4, 3), (2, 1)]);
        let tree: Vec<(u32, u32)> = graph
            .edges
            .iter()
            .map(|edge| (edge.source, edge.target))
            .collect();
        assert_eq!(tree, vec![(1, 2), (3, 4)]);
    }

    #[test]
    fn project_cyclic_tree_edges_make_a_layout_parent_cycle() {
        // ツリーのエッジが閉路を持つ入力 (view は渡さない) では、閉路の除外は relations だけを見るので layoutParent も閉路になる
        let graph = project(&input(&[1, 2, 3], &[(1, 2), (2, 3), (3, 2)], &[], &[], &[])).unwrap();
        assert_eq!(pairs(&graph.layout_parent), vec![(2, 3), (3, 2)]);
    }

    fn boundary_group(id: &str) -> GroupDef {
        GroupDef {
            id: id.to_string(),
            label: id.to_string(),
            color: None,
            boundary: true,
            defined: true,
            icon: None,
        }
    }

    #[test]
    fn project_framed_keeps_nodes_out_of_other_frames() {
        use RelationKind::*;
        // 1 root / 2 A %d / 3 a1 (d) / 4 B %b / 5 b1 (b) / 6 C / 7 D / 8 E %x (x はこのノードだけ) / 9 F
        // A --> B、a1 --> C、C --> D、E --> F。B、C、D、F はルートからの線を抑制する
        let input = input(
            &[1, 2, 3, 4, 5, 6, 7, 8, 9],
            &[
                (1, 2),
                (2, 3),
                (1, 4),
                (4, 5),
                (1, 6),
                (1, 7),
                (1, 8),
                (1, 9),
            ],
            &[(Chain, 2, 4), (Join, 3, 6), (Chain, 6, 7), (Chain, 8, 9)],
            &[4, 6, 7, 9],
            &[],
        );
        let groups_of: IndexMap<u32, Vec<String>> = [
            (2, vec!["d"]),
            (3, vec!["d"]),
            (4, vec!["b"]),
            (5, vec!["b"]),
            (8, vec!["x"]),
        ]
        .into_iter()
        .map(|(id, list)| (id, list.into_iter().map(String::from).collect()))
        .collect();
        let groups = [
            boundary_group("d"),
            boundary_group("b"),
            boundary_group("x"),
        ];

        // 枠を見ない射影では、B は A の下、C は a1 の下に付く (枠 d の矩形に入り込む)
        let plain = project(&input).unwrap();
        assert_eq!(
            pairs(&plain.layout_parent),
            vec![
                (2, 1),
                (3, 2),
                (4, 2),
                (5, 4),
                (6, 3),
                (7, 6),
                (8, 1),
                (9, 8)
            ]
        );
        // 枠を見る射影では、枠 d のメンバーの下に付けず、ツリーの親 (ルート) に置く。
        // C は枠の外なので D はその下のまま。E は枠 x のメンバーだが、同じグループのノードが周りにいない (枠にならない) ので F はその下
        let framed = project_framed(&input, &groups, &groups_of).unwrap();
        assert_eq!(
            pairs(&framed.layout_parent),
            vec![
                (2, 1),
                (3, 2),
                (4, 1),
                (5, 4),
                (6, 1),
                (7, 6),
                (8, 1),
                (9, 8)
            ]
        );
        // ルートからの線は抑制したまま (relations の線でつながる)
        let tree: Vec<(u32, u32)> = framed
            .edges
            .iter()
            .filter(|edge| edge.kind == VisibleEdgeKind::Tree)
            .map(|edge| (edge.source, edge.target))
            .collect();
        assert_eq!(tree, vec![(1, 2), (2, 3), (4, 5), (1, 8)]);
        // 枠のない文書では project と同じ
        assert_eq!(
            project_framed(&input, &[], &IndexMap::new()).unwrap(),
            plain
        );
    }

    #[test]
    fn project_visible_edge_kind_strings_match_serde() {
        for &kind in VisibleEdgeKind::ALL {
            let json = serde_json::to_value(kind).unwrap();
            assert_eq!(json, serde_json::Value::String(kind.as_str().to_string()));
            assert_eq!(
                VisibleEdgeKind::from_js(&JsValue::String(kind.as_str().to_string())),
                Some(kind)
            );
        }
        assert_eq!(
            VisibleEdgeKind::from_js(&JsValue::String("relation".to_string())),
            None
        );
    }
}

// PORT STATUS: confidence=high todos=0

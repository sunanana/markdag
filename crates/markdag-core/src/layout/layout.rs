// 原文: src/layout/layout.ts (2026-09-24)
// 見えているグラフとノードのサイズから、座標を決める (同期の純粋関数)。
// 配置上の親で作ったレイアウト木を flextree に渡す。relations の始点より右に来る必要があるノードは、
// flextree に渡す深さ方向のサイズを左余白のぶんだけ広げ、本体をその領域の右側に置く。
// 原文の関数の値のうち、lineWidth は式の係数 (LineWidth) に、flextree の spacing は layout.rs の中の関数にした (規則 2.6)。
// 兄弟方向の追加の間隔 (原文の extraSpacing) は、LayoutOptions の extra_spacing (枠と前回の矩形の値) から layout_graph が
// FrameSpacing を 1 度作って渡す (A-019、A-039)。任意の関数を渡す本体 layout_graph_with_extra_spacing も残す (A-163)。
use std::collections::HashMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::flextree::FlexTree;
use crate::layout::frames::{Frame, frame_spacing};
use crate::layout::project::{VisibleEdge, VisibleEdgeKind, VisibleGraph, VisibleNode};
use crate::limits::check_layout_number;
use crate::model::util::{js_max, js_min};
use crate::types::{LayoutError, Rect};

/// 線の太さの式 `base + scale / 2^depth` の係数 (原文の `lineWidth: (depth) => number` をデータにしたもの。規則 2.6、DESIGN (c)(d))
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineWidth {
    #[serde(with = "crate::model::util::js_f64")]
    pub base: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub scale: f64,
}

impl LineWidth {
    /// 深さ depth の線の太さ。原文 `1 + 3 / 2 ** depth` と同じ順で計算する (規則 2.1 の A-014、`**` は powf)
    pub fn at(&self, depth: u32) -> f64 {
        self.base + self.scale / 2f64.powf(f64::from(depth))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutOptions {
    #[serde(with = "crate::model::util::js_f64")]
    pub padding_x: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub spacing_horizontal: f64,
    #[serde(with = "crate::model::util::js_f64")]
    pub spacing_vertical: f64,
    pub line_width: LineWidth,
    /// 兄弟方向の追加の間隔 (原文の `extraSpacing: frameSpacing(frames, previous)`) を、関数でなく値で持つ。
    /// 境界の JSON には出さない (規則 2.6、A-019、A-029)
    #[serde(skip)]
    pub extra_spacing: Option<ExtraSpacing>,
    /// 実験用: 折りたたみで生じた depends の代理エッジを、横位置の計算に入れない (線が右から左へ向くことがある)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_proxied_depends: Option<bool>,
}

/// 原文の `extraSpacing: frameSpacing(frames, rects)` の引数。rects は前回の配置の結果で、最初の配置では None
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ExtraSpacing {
    pub frames: Vec<Frame>,
    pub rects: Option<IndexMap<u32, Rect>>,
}

/// markmap の既定値
pub const MARKMAP_DEFAULTS: LayoutOptions = LayoutOptions {
    padding_x: 8.0,
    spacing_horizontal: 80.0,
    spacing_vertical: 5.0,
    line_width: LineWidth {
        base: 1.0,
        scale: 3.0,
    },
    extra_spacing: None,
    ignore_proxied_depends: None,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedNode {
    pub node: VisibleNode,
    /// ノード本体の矩形 (左右の余白を含み、次のノードまでの間隔は含まない)
    pub rect: Rect,
    /// 本体の左に確保した余白の幅。0 なら markmap と同じ置き方
    #[serde(with = "crate::model::util::js_f64")]
    pub gap: f64,
    pub layout_parent: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedEdge {
    pub edge: VisibleEdge,
    /// 始点の下線の右端と、終点の下線の左端
    #[serde(with = "crate::model::util::js_f64::pair")]
    pub source: [f64; 2],
    #[serde(with = "crate::model::util::js_f64::pair")]
    pub target: [f64; 2],
    /// 配置上の親子を結ぶ線かどうか
    pub is_layout_link: bool,
    /// 経路を自前で決める方式が返す中継点 (始点と終点を含む)。ない場合は、始点と終点を 1 本の曲線で結ぶ
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::model::util::js_f64::option_pair_list"
    )]
    pub points: Option<Vec<[f64; 2]>>,
}

/// flextree の spacing が受けた組と返した値 (呼ばれた順)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacingCall {
    pub upper: u32,
    pub lower: u32,
    #[serde(with = "crate::model::util::js_f64")]
    pub value: f64,
}

/// flextree に渡した値。markmap と同じ値になっているかを外から確かめるために公開する。
/// 原文の spacing は関数なので、実際に呼ばれた組と値の表で返す (A-164)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlextreeParams {
    #[serde(with = "crate::model::util::pairs::f64_pair_values")]
    pub node_size: IndexMap<u32, [f64; 2]>,
    pub spacing: Vec<SpacingCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutResult {
    /// flextree の each の順 (幅優先)
    #[serde(with = "crate::model::util::pairs")]
    pub nodes: IndexMap<u32, PlacedNode>,
    pub edges: Vec<PlacedEdge>,
    pub bounds: Rect,
    /// flextree を実行する前に、最長経路で計算した横位置。flextree の結果と一致するはずの値
    #[serde(with = "crate::model::util::pairs::f64_values")]
    pub planned_x: IndexMap<u32, f64>,
    pub flextree_params: FlextreeParams,
}

// underline の side (原文の `'left' | 'right'`。規則 2.6 の局所の union、A-041)
#[derive(Clone, Copy)]
enum Side {
    Left,
    Right,
}

/// 原文: layoutGraph。options が None なら MARKMAP_DEFAULTS (規則 2.6 の既定の引数)。
/// options.extra_spacing があれば、そこから FrameSpacing を 1 回の配置につき 1 度作り、兄弟の組ごとに between を足す (A-039)
pub fn layout_graph(
    graph: &VisibleGraph,
    options: Option<LayoutOptions>,
) -> Result<LayoutResult, LayoutError> {
    let mut options = options.unwrap_or(MARKMAP_DEFAULTS);
    let Some(extra) = options.extra_spacing.take() else {
        return layout_graph_with_extra_spacing(graph, Some(options), None);
    };
    let spacing = frame_spacing(&extra.frames, extra.rects.as_ref());
    let mut between = |upper: u32, lower: u32| spacing.between(upper, lower);
    layout_graph_with_extra_spacing(graph, Some(options), Some(&mut between))
}

/// 原文: layoutGraph の本体。extra_spacing は原文の `options.extraSpacing` (兄弟方向の間隔に足す値。
/// 上に置かれるノード、下に置かれるノードの順で受ける)。None なら足す値は 0 (`?? 0`)。
/// options.extra_spacing (値の形) は読まない (値から関数を作るのは layout_graph。A-163)
pub fn layout_graph_with_extra_spacing(
    graph: &VisibleGraph,
    options: Option<LayoutOptions>,
    mut extra_spacing: Option<&mut dyn FnMut(u32, u32) -> f64>,
) -> Result<LayoutResult, LayoutError> {
    let options = options.unwrap_or(MARKMAP_DEFAULTS);
    // 反復しない Map (A-008)。同じ id が 2 度あれば後勝ち (new Map と同じ)
    let node_of: HashMap<u32, &VisibleNode> =
        graph.nodes.iter().map(|node| (node.id, node)).collect();
    let get = |id: u32| -> Result<&VisibleNode, LayoutError> {
        node_of.get(&id).copied().ok_or_else(|| LayoutError {
            message: format!("見えていないノード: {id}"),
        })
    };
    let ext = |node: &VisibleNode| -> f64 {
        node.width
            + (if node.width > 0.0 {
                options.padding_x * 2.0
            } else {
                0.0
            })
            + options.spacing_horizontal
    };

    // 横位置の下限を与える先行ノード: 配置上の親と、配置の計算から外されていない relations の始点
    let mut predecessors: IndexMap<u32, Vec<u32>> = graph
        .nodes
        .iter()
        .map(|node| (node.id, Vec::new()))
        .collect();
    for (child, parent) in &graph.layout_parent {
        if let Some(list) = predecessors.get_mut(child) {
            list.push(*parent);
        }
    }
    for edge in &graph.edges {
        if edge.kind == VisibleEdgeKind::Tree || edge.excluded_from_layout {
            continue;
        }
        if options.ignore_proxied_depends == Some(true)
            && edge.kind == VisibleEdgeKind::Depends
            && edge.proxied
        {
            continue;
        }
        if let Some(list) = predecessors.get_mut(&edge.target) {
            list.push(edge.source);
        }
    }
    let planned_x = longest_path_x(graph, &predecessors, &mut |id| Ok(ext(get(id)?)))?;

    let mut gap_of: HashMap<u32, f64> = HashMap::new();
    for node in &graph.nodes {
        let start = match graph.layout_parent.get(&node.id) {
            None => 0.0,
            Some(&parent) => planned_x.get(&parent).copied().unwrap_or(0.0) + ext(get(parent)?),
        };
        gap_of.insert(
            node.id,
            planned_x.get(&node.id).copied().unwrap_or(0.0) - start,
        );
    }

    let children_of = layout_children_of(graph);

    let node_size: IndexMap<u32, [f64; 2]> = graph
        .nodes
        .iter()
        .map(|node| {
            (
                node.id,
                [
                    node.height,
                    gap_of.get(&node.id).copied().unwrap_or(0.0) + ext(node),
                ],
            )
        })
        .collect();
    let mut spacing_calls: Vec<SpacingCall> = Vec::new();
    let mut spacing = |a: u32, b: u32| -> Result<f64, LayoutError> {
        let base = if graph.layout_parent.get(&a) == graph.layout_parent.get(&b) {
            options.spacing_vertical
        } else {
            options.spacing_vertical * 2.0
        };
        let line = options.line_width.at(get(a)?.depth);
        let extra = match extra_spacing.as_mut() {
            Some(extra) => extra(a, b),
            None => 0.0,
        };
        let value = base + line + extra;
        spacing_calls.push(SpacingCall {
            upper: a,
            lower: b,
            value,
        });
        Ok(value)
    };

    let tree = FlexTree::layout(graph.root_id, &children_of, &node_size, &mut spacing)?;

    // flextree は縦型 (x が兄弟方向、y が深さ方向) なので、markmap と同じく入れ替えて横型にする
    let mut nodes: IndexMap<u32, PlacedNode> = IndexMap::new();
    for flex_node in &tree {
        let node = get(flex_node.id)?;
        let gap = gap_of.get(&node.id).copied().unwrap_or(0.0);
        nodes.insert(
            node.id,
            PlacedNode {
                node: node.clone(),
                gap,
                layout_parent: graph.layout_parent.get(&node.id).copied(),
                rect: Rect {
                    x: flex_node.y + gap,
                    y: flex_node.x - flex_node.x_size / 2.0,
                    width: flex_node.y_size - gap - options.spacing_horizontal,
                    height: flex_node.x_size,
                },
            },
        );
    }

    let placed = |id: u32| -> Result<&PlacedNode, LayoutError> {
        nodes.get(&id).ok_or_else(|| LayoutError {
            message: format!("配置されていないノード: {id}"),
        })
    };
    let underline = |id: u32, side: Side| -> Result<[f64; 2], LayoutError> {
        let PlacedNode { rect, node, .. } = placed(id)?;
        Ok([
            match side {
                Side::Left => rect.x,
                Side::Right => rect.x + rect.width,
            },
            rect.y + rect.height + options.line_width.at(node.depth) / 2.0,
        ])
    };
    let edges = graph
        .edges
        .iter()
        .map(|edge| {
            Ok(PlacedEdge {
                edge: edge.clone(),
                source: underline(edge.source, Side::Right)?,
                target: underline(edge.target, Side::Left)?,
                is_layout_link: graph.layout_parent.get(&edge.target) == Some(&edge.source),
                points: None,
            })
        })
        .collect::<Result<Vec<_>, LayoutError>>()?;

    let bounds = bounds_of(&nodes.values().map(|node| node.rect).collect::<Vec<_>>());
    Ok(LayoutResult {
        nodes,
        edges,
        bounds,
        planned_x,
        flextree_params: FlextreeParams {
            node_size,
            spacing: spacing_calls,
        },
    })
}

/// 配置の指定の数 (余白、間隔、線の太さの係数) を検べる。NaN、無限大、絶対値が 1e300 以上なら誤り (A-156 の (b))。
/// 検べるのは入口 (layout_document) で、layout_graph は検べない (入口を通った値を受ける内側の段。有限でない値の出力の印を試験で見るため)
pub fn check_layout_options(options: &LayoutOptions) -> Result<(), LayoutError> {
    check_layout_number(options.padding_x, || "paddingX".to_string())?;
    check_layout_number(options.spacing_horizontal, || {
        "spacingHorizontal".to_string()
    })?;
    check_layout_number(options.spacing_vertical, || "spacingVertical".to_string())?;
    check_layout_number(options.line_width.base, || "lineWidth.base".to_string())?;
    check_layout_number(options.line_width.scale, || "lineWidth.scale".to_string())
}

/// 原文: layoutChildrenOf。
/// レイアウト木の子の並び (上から下の順): Markdown の子を文書順に並べ、そのあとに relations で付け替えた子を文書順に並べる。
/// 座標を決める前に兄弟の縦の並びを知りたい処理 (グループの枠のまとまりの判定など) も、この順を使う
pub fn layout_children_of(graph: &VisibleGraph) -> IndexMap<u32, Vec<u32>> {
    let mut children_of: IndexMap<u32, Vec<u32>> = graph
        .nodes
        .iter()
        .map(|node| (node.id, Vec::new()))
        .collect();
    let mut adopted_of: IndexMap<u32, Vec<u32>> = graph
        .nodes
        .iter()
        .map(|node| (node.id, Vec::new()))
        .collect();
    for node in &graph.nodes {
        let Some(&parent) = graph.layout_parent.get(&node.id) else {
            continue;
        };
        let target = if Some(parent) == node.tree_parent {
            &mut children_of
        } else {
            &mut adopted_of
        };
        if let Some(list) = target.get_mut(&parent) {
            list.push(node.id);
        }
    }
    for (parent, adopted) in adopted_of {
        if let Some(list) = children_of.get_mut(&parent) {
            list.extend(adopted);
        }
    }
    children_of
}

// 原文: longestPathX。x(v) = max(x(u) + ext(u))。u は v の先行ノードすべて。先行ノードのないノード (ルート) は 0。
// ext は get が投げうるので Result を返す関数で受ける (原文では ready に入るのは見えているノードだけなので Err は届かない)
fn longest_path_x(
    graph: &VisibleGraph,
    predecessors: &IndexMap<u32, Vec<u32>>,
    ext: &mut dyn FnMut(u32) -> Result<f64, LayoutError>,
) -> Result<IndexMap<u32, f64>, LayoutError> {
    let mut successors: IndexMap<u32, Vec<u32>> = graph
        .nodes
        .iter()
        .map(|node| (node.id, Vec::new()))
        .collect();
    // 反復しない Map (A-008)。1 ずつ減らすので負になりうる値として i64 で持つ (規則 2.1)
    let mut remaining: HashMap<u32, i64> = HashMap::new();
    for (&target, sources) in predecessors {
        remaining.insert(target, sources.len() as i64);
        for source in sources {
            if let Some(list) = successors.get_mut(source) {
                list.push(target);
            }
        }
    }
    let mut x: IndexMap<u32, f64> = IndexMap::new();
    let mut ready: Vec<u32> = graph
        .nodes
        .iter()
        .filter(|node| remaining.get(&node.id).copied().unwrap_or(0) == 0)
        .map(|node| node.id)
        .collect();
    for &id in &ready {
        x.insert(id, 0.0);
    }
    while let Some(id) = ready.pop() {
        let right = x.get(&id).copied().unwrap_or(0.0) + ext(id)?;
        for &next in successors.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            x.insert(next, js_max(x.get(&next).copied().unwrap_or(0.0), right));
            let left = remaining.get(&next).copied().unwrap_or(0) - 1;
            remaining.insert(next, left);
            if left == 0 {
                ready.push(next);
            }
        }
    }
    if x.len() != graph.nodes.len() {
        return Err(LayoutError {
            message: "横位置の制約に閉路がある".to_string(),
        });
    }
    Ok(x)
}

/// 原文: boundsOf。rects が空なら x と y は Infinity、width と height は -Infinity (規則 2.1 の Math.min(...xs))
pub fn bounds_of(rects: &[Rect]) -> Rect {
    let x1 = rects.iter().map(|rect| rect.x).fold(f64::INFINITY, js_min);
    let y1 = rects.iter().map(|rect| rect.y).fold(f64::INFINITY, js_min);
    let x2 = rects
        .iter()
        .map(|rect| rect.x + rect.width)
        .fold(f64::NEG_INFINITY, js_max);
    let y2 = rects
        .iter()
        .map(|rect| rect.y + rect.height)
        .fold(f64::NEG_INFINITY, js_max);
    Rect {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u32, width: f64, depth: u32, tree_parent: Option<u32>) -> VisibleNode {
        VisibleNode {
            id,
            label: format!("n{id}"),
            width,
            height: 20.0,
            groups: Vec::new(),
            depth,
            tree_parent,
            folded: false,
        }
    }

    fn tree_edge(source: u32, target: u32) -> VisibleEdge {
        VisibleEdge {
            kind: VisibleEdgeKind::Tree,
            source,
            target,
            member_relation_indexes: Vec::new(),
            proxied: false,
            excluded_from_layout: false,
        }
    }

    // 1 ─ 2 ─ 3、1 ─ 4。relations 2 --> 4 で 4 の配置上の親を 2 に付け替えたグラフ
    fn adopted_graph() -> VisibleGraph {
        VisibleGraph {
            root_id: 1,
            nodes: vec![
                node(1, 40.0, 1, None),
                node(2, 30.0, 2, Some(1)),
                node(3, 50.0, 3, Some(2)),
                node(4, 0.0, 2, Some(1)),
            ],
            edges: vec![
                tree_edge(1, 2),
                tree_edge(2, 3),
                VisibleEdge {
                    kind: VisibleEdgeKind::Depends,
                    source: 2,
                    target: 4,
                    member_relation_indexes: vec![0],
                    proxied: true,
                    excluded_from_layout: false,
                },
            ],
            layout_parent: IndexMap::from([(2, 1), (3, 2), (4, 2)]),
        }
    }

    #[test]
    fn layout_line_width_matches_the_markmap_formula() {
        let line = MARKMAP_DEFAULTS.line_width;
        assert_eq!(line.at(0), 4.0);
        assert_eq!(line.at(1), 2.5);
        assert_eq!(line.at(2), 1.75);
        assert_eq!(line.at(3), 1.375);
    }

    #[test]
    fn layout_children_put_adopted_children_after_markdown_children() {
        let children = layout_children_of(&adopted_graph());
        let pairs: Vec<(u32, Vec<u32>)> = children.into_iter().collect();
        assert_eq!(
            pairs,
            vec![(1, vec![2]), (2, vec![3, 4]), (3, vec![]), (4, vec![])]
        );
    }

    #[test]
    fn layout_bounds_of_empty_is_infinite() {
        let bounds = bounds_of(&[]);
        assert_eq!(bounds.x, f64::INFINITY);
        assert_eq!(bounds.y, f64::INFINITY);
        assert_eq!(bounds.width, f64::NEG_INFINITY);
        assert_eq!(bounds.height, f64::NEG_INFINITY);
    }

    #[test]
    fn layout_bounds_of_rects() {
        let rects = [
            Rect {
                x: 10.0,
                y: -5.0,
                width: 20.0,
                height: 10.0,
            },
            Rect {
                x: -3.0,
                y: 2.0,
                width: 5.0,
                height: 30.0,
            },
        ];
        assert_eq!(
            bounds_of(&rects),
            Rect {
                x: -3.0,
                y: -5.0,
                width: 33.0,
                height: 37.0
            }
        );
    }

    // 1 ─ 2 ─ 3、1 ─ 4。折りたたみの代理の depends 3 --> 4 があり、4 は 3 の右端まで左余白を取る
    fn gap_graph() -> VisibleGraph {
        let mut graph = adopted_graph();
        graph.edges = vec![
            tree_edge(1, 2),
            tree_edge(2, 3),
            tree_edge(1, 4),
            VisibleEdge {
                kind: VisibleEdgeKind::Depends,
                source: 3,
                target: 4,
                member_relation_indexes: vec![0],
                proxied: true,
                excluded_from_layout: false,
            },
        ];
        graph.layout_parent = IndexMap::from([(2, 1), (3, 2), (4, 1)]);
        graph
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    // 期待値は原文を vite-node で同じ入力に通した値 (plannedX の順は ready の LIFO の順)
    #[test]
    fn layout_gap_graph_matches_the_old_implementation() {
        let result = layout_graph(&gap_graph(), None).unwrap();
        let planned: Vec<(u32, f64)> = result.planned_x.iter().map(|(&id, &x)| (id, x)).collect();
        assert_eq!(planned, vec![(1, 0.0), (2, 136.0), (4, 408.0), (3, 262.0)]);
        let placed: Vec<(u32, f64, Rect)> = result
            .nodes
            .iter()
            .map(|(&id, placed)| (id, placed.gap, placed.rect))
            .collect();
        assert_eq!(
            placed,
            vec![
                (1, 0.0, rect(0.0, -10.0, 56.0, 20.0)),
                (2, 0.0, rect(136.0, -25.6875, 46.0, 20.0)),
                (4, 272.0, rect(408.0, 5.6875, 0.0, 20.0)),
                (3, 0.0, rect(262.0, -25.6875, 66.0, 20.0)),
            ]
        );
        let edges: Vec<([f64; 2], [f64; 2], bool)> = result
            .edges
            .iter()
            .map(|edge| (edge.source, edge.target, edge.is_layout_link))
            .collect();
        assert_eq!(
            edges,
            vec![
                ([56.0, 11.25], [136.0, -4.8125], true),
                ([182.0, -4.8125], [262.0, -5.0], true),
                ([56.0, 11.25], [408.0, 26.5625], true),
                ([328.0, -5.0], [408.0, 26.5625], false),
            ]
        );
        assert_eq!(result.bounds, rect(0.0, -25.6875, 408.0, 51.375));
        let sizes: Vec<(u32, [f64; 2])> = result
            .flextree_params
            .node_size
            .iter()
            .map(|(&id, &size)| (id, size))
            .collect();
        assert_eq!(
            sizes,
            vec![
                (1, [20.0, 136.0]),
                (2, [20.0, 126.0]),
                (3, [20.0, 146.0]),
                (4, [20.0, 352.0])
            ]
        );
    }

    #[test]
    fn layout_ignore_proxied_depends_drops_the_proxy_edge_from_the_horizontal_bound() {
        let options = LayoutOptions {
            ignore_proxied_depends: Some(true),
            ..MARKMAP_DEFAULTS
        };
        let result = layout_graph(&gap_graph(), Some(options)).unwrap();
        assert_eq!(result.planned_x[&4], 136.0);
        assert_eq!(result.nodes[&4].gap, 0.0);
        assert_eq!(result.nodes[&4].rect, rect(136.0, 3.375, 0.0, 20.0));
        // 線は右から左へ向く
        assert_eq!(result.edges[3].source, [328.0, -2.6875]);
        assert_eq!(result.edges[3].target, [136.0, 24.25]);
        assert_eq!(result.bounds, rect(0.0, -23.375, 328.0, 46.75));
    }

    #[test]
    fn layout_spacing_calls_match_the_markmap_formula() {
        // 原文 p-l1「flextree に渡す spacing は、すべてのノードの組で markmap の式の値と一致する」の単体版 (台帳 6 行)。
        // spacing の関数は公開しないので、flextree が実際に受けた組と値の表 (flextree_params.spacing) を式と突き合わせる (A-164)
        let graph = adopted_graph();
        let result = layout_graph(&graph, None).unwrap();
        assert!(!result.flextree_params.spacing.is_empty());
        let depth_of: HashMap<u32, u32> = graph.nodes.iter().map(|n| (n.id, n.depth)).collect();
        for call in &result.flextree_params.spacing {
            let same = graph.layout_parent.get(&call.upper) == graph.layout_parent.get(&call.lower);
            let expected = (if same { 5.0 } else { 10.0 })
                + MARKMAP_DEFAULTS.line_width.at(depth_of[&call.upper]);
            assert_eq!(call.value.to_bits(), expected.to_bits());
        }
    }

    #[test]
    fn layout_missing_layout_parent_node_is_an_error() {
        let mut graph = adopted_graph();
        graph.layout_parent.insert(4, 9);
        let error = layout_graph(&graph, None).unwrap_err();
        assert_eq!(error.message, "見えていないノード: 9");
    }

    #[test]
    fn layout_cycle_in_horizontal_constraints_is_an_error() {
        let mut graph = adopted_graph();
        graph.edges.push(VisibleEdge {
            kind: VisibleEdgeKind::Chain,
            source: 3,
            target: 2,
            member_relation_indexes: vec![1],
            proxied: false,
            excluded_from_layout: false,
        });
        let error = layout_graph(&graph, None).unwrap_err();
        assert_eq!(error.message, "横位置の制約に閉路がある");
    }

    #[test]
    fn layout_edge_to_unplaced_node_is_an_error() {
        // 見えているが配置の木に入らないノード (配置上の親が無く、ルートでもない) への線
        let mut graph = adopted_graph();
        graph.nodes.push(node(5, 10.0, 2, Some(1)));
        graph.edges.push(tree_edge(1, 5));
        let error = layout_graph(&graph, None).unwrap_err();
        assert_eq!(error.message, "配置されていないノード: 5");
    }
}

// PORT STATUS: confidence=high todos=0

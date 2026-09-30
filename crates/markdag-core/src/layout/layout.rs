// 原文: src/layout/layout.ts (2026-09-24)
// 見えているグラフとノードのサイズから、座標を決める (同期の純粋関数)。
// 配置上の親で作ったレイアウト木を flextree に渡す。relations の始点より右に来る必要があるノードは、
// flextree に渡す深さ方向のサイズを左余白のぶんだけ広げ、本体をその領域の右側に置く。
// 原文の関数の値のうち、lineWidth は式の係数 (LineWidth) に、flextree の spacing は layout.rs の中の関数にした (規則 2.6)。
// 兄弟方向の追加の間隔 (原文の extraSpacing) は、LayoutOptions の extra_spacing (枠と前回の矩形の値) から layout_graph が
// FrameSpacing を 1 度作って渡す (A-019、A-039)。任意の関数を渡す本体 layout_graph_with_extra_spacing も残す (A-163)。
// 原文にない枠の配置の段 3 (block_depths、深さの方向の位置) と段 4 の入口 (layout_graph_framed。配置の木の組み立てから
// 兄弟の方向の位置までをつなぎ、layout_graph_with_extra_spacing と同じ形の結果を返す) もここに置く。
use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::flextree::{FlexTree, Placed};
use crate::layout::frames::{Frame, FrameBlocks, frame_padding, frame_spacing};
use crate::layout::placement::{PlacementTree, Slot, layout_placement, placement_tree};
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
    let get = visible_node_getter(graph);
    let ext = |node: &VisibleNode| -> f64 { node_ext(node, &options) };

    let predecessors = layout_predecessors(graph, &options);
    let planned_x = longest_path_x(graph, &predecessors, &mut |id| Ok(ext(get(id)?)), &[])?;

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

    let mut nodes: IndexMap<u32, PlacedNode> = IndexMap::new();
    for flex_node in &tree {
        let node = get(flex_node.id)?;
        let gap = gap_of.get(&node.id).copied().unwrap_or(0.0);
        nodes.insert(node.id, placed_node(graph, node, flex_node, gap, &options));
    }
    let edges = placed_edges(graph, &nodes, &options)?;
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

/// 原文なし。
/// 枠のある文書の配置 (枠の配置の段 4 の入口)。配置の木 (placement_tree) → 深さの方向の位置 (block_depths) →
/// 兄弟の方向の位置 (layout_placement) の順に回し、layout_graph_with_extra_spacing と同じ形の LayoutResult にする。
/// blocks が空なら、layout_graph_with_extra_spacing と同じ値と並びになる。
/// flextree の spacing は配置の木の Slot の組で問われる。base は 2 つの Slot の配置の木の親 (parent_of) が同じかで決め、
/// 線の太さと extra_spacing は Slot を実のノード (上の側は最後の根、下の側は最初の根) に置き換えて問う。
/// これで箱と下の兄弟の間隔は、箱の根の数に依らない。SpacingCall にも置き換えた実のノードの組を記録する。
/// nodes の並びは children_of (L0) を graph.root_id から幅優先にたどった順
pub fn layout_graph_framed(
    graph: &VisibleGraph,
    options: Option<LayoutOptions>,
    mut extra_spacing: Option<&mut dyn FnMut(u32, u32) -> f64>,
    children_of: &IndexMap<u32, Vec<u32>>,
    frames: &[Frame],
    blocks: &FrameBlocks,
) -> Result<LayoutResult, LayoutError> {
    let options = options.unwrap_or(MARKMAP_DEFAULTS);
    let get = visible_node_getter(graph);

    let predecessors = layout_predecessors(graph, &options);
    let placement = placement_tree(graph, children_of, frames, blocks, &predecessors);
    let depths = block_depths(graph, &options, &placement, blocks, frames, &predecessors)?;
    let gap_of = |id: u32| depths.gap_of.get(&id).copied().unwrap_or(0.0);

    let node_size: IndexMap<u32, [f64; 2]> = graph
        .nodes
        .iter()
        .map(|node| {
            (
                node.id,
                [node.height, gap_of(node.id) + node_ext(node, &options)],
            )
        })
        .collect();
    let mut spacing_calls: Vec<SpacingCall> = Vec::new();
    let mut spacing = |a: Slot, b: Slot| -> Result<f64, LayoutError> {
        let base = if placement.parent_of.get(&a) == placement.parent_of.get(&b) {
            options.spacing_vertical
        } else {
            options.spacing_vertical * 2.0
        };
        let upper = edge_node(&placement, a, End::Last)?;
        let lower = edge_node(&placement, b, End::First)?;
        let line = options.line_width.at(get(upper)?.depth);
        let extra = match extra_spacing.as_mut() {
            Some(extra) => extra(upper, lower),
            None => 0.0,
        };
        let value = base + line + extra;
        spacing_calls.push(SpacingCall {
            upper,
            lower,
            value,
        });
        Ok(value)
    };
    let placed = layout_placement(&placement, &node_size, &depths, blocks, &mut spacing)?;

    // layout_placement は箱ごとにまとめて返すので、L0 の幅優先の順 (枠のない配置の flextree の each と同じ順) に並べ直す
    let mut rest: IndexMap<u32, Placed> = IndexMap::new();
    for flex_node in placed {
        rest.entry(flex_node.id).or_insert(flex_node);
    }
    let mut order: Vec<u32> = Vec::with_capacity(rest.len());
    let mut seen: HashSet<u32> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::from([graph.root_id]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        order.push(id);
        queue.extend(children_of.get(&id).map(Vec::as_slice).unwrap_or(&[]));
    }
    let mut nodes: IndexMap<u32, PlacedNode> = IndexMap::new();
    for id in order {
        let Some(flex_node) = rest.shift_remove(&id) else {
            continue;
        };
        let node = get(id)?;
        nodes.insert(
            id,
            placed_node(graph, node, &flex_node, gap_of(id), &options),
        );
    }
    // L0 でたどれないノード (壊れた入力) も落とさず、layout_placement の順で後ろに足す
    for (id, flex_node) in rest {
        let node = get(id)?;
        nodes.insert(
            id,
            placed_node(graph, node, &flex_node, gap_of(id), &options),
        );
    }

    let edges = placed_edges(graph, &nodes, &options)?;
    let bounds = bounds_of(&nodes.values().map(|node| node.rect).collect::<Vec<_>>());
    Ok(LayoutResult {
        nodes,
        edges,
        bounds,
        planned_x: depths.planned_x,
        flextree_params: FlextreeParams {
            node_size,
            spacing: spacing_calls,
        },
    })
}

// 横位置の下限を与える先行ノード: 配置上の親と、配置の計算から外されていない relations の始点
pub(crate) fn layout_predecessors(
    graph: &VisibleGraph,
    options: &LayoutOptions,
) -> IndexMap<u32, Vec<u32>> {
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
    predecessors
}

// id から見えているノードを引く。反復しない Map (A-008) で、同じ id が 2 度あれば後勝ち (new Map と同じ)
fn visible_node_getter<'a>(
    graph: &'a VisibleGraph,
) -> impl Fn(u32) -> Result<&'a VisibleNode, LayoutError> + 'a {
    let node_of: HashMap<u32, &VisibleNode> =
        graph.nodes.iter().map(|node| (node.id, node)).collect();
    move |id: u32| {
        node_of.get(&id).copied().ok_or_else(|| LayoutError {
            message: format!("見えていないノード: {id}"),
        })
    }
}

// 本体の幅 (左右の余白を含む)
fn node_body(node: &VisibleNode, options: &LayoutOptions) -> f64 {
    node.width
        + (if node.width > 0.0 {
            options.padding_x * 2.0
        } else {
            0.0
        })
}

// 原文の ext: 本体の幅 + spacing_horizontal (足す順は原文の width + padding + spacing のまま)
fn node_ext(node: &VisibleNode, options: &LayoutOptions) -> f64 {
    node_body(node, options) + options.spacing_horizontal
}

// flextree は縦型 (x が兄弟方向、y が深さ方向) なので、markmap と同じく入れ替えて横型にする
fn placed_node(
    graph: &VisibleGraph,
    node: &VisibleNode,
    flex_node: &Placed,
    gap: f64,
    options: &LayoutOptions,
) -> PlacedNode {
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
    }
}

// 線の端: 始点の下線の右端と、終点の下線の左端
fn placed_edges(
    graph: &VisibleGraph,
    nodes: &IndexMap<u32, PlacedNode>,
    options: &LayoutOptions,
) -> Result<Vec<PlacedEdge>, LayoutError> {
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
    graph
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
        .collect()
}

// 箱や仮の根の、兄弟の方向のどちらの端の実のノードを取るか
#[derive(Clone, Copy)]
enum End {
    First,
    Last,
}

// Slot を、兄弟の方向の端にある実のノードに置き換える。箱は中の木の根へ、仮の根は子の並びの端へ下りる
// (後戻りした単位は仮の根の子の末尾にあるので、Last はそれを含む)。外側の仮の根の子の並びは外側の木にある。
// 入れ子は深くなりうるので反復でたどる
fn edge_node(placement: &PlacementTree, slot: Slot, end: End) -> Result<u32, LayoutError> {
    let missing = || LayoutError {
        message: format!("枠の箱の中に実のノードがない: {slot:?}"),
    };
    let mut at = slot;
    // 箱と仮の根はそれぞれ 1 度しか通らない。越えたら壊れた配置の木
    for _ in 0..=placement.inner.len() * 2 + 1 {
        match at {
            Slot::Node(id) => return Ok(id),
            Slot::Block(index) => at = placement.inner.get(index).ok_or_else(missing)?.0,
            Slot::Joint(index) => {
                let children = placement
                    .inner
                    .get(index)
                    .and_then(|(_, map)| map.get(&at))
                    .ok_or_else(missing)?;
                at = end_of(children, end).ok_or_else(missing)?;
            }
            Slot::Origin => {
                let children = placement.children.get(&at).ok_or_else(missing)?;
                at = end_of(children, end).ok_or_else(missing)?;
            }
        }
    }
    Err(missing())
}

fn end_of(children: &[Slot], end: End) -> Option<Slot> {
    match end {
        End::First => children.first(),
        End::Last => children.last(),
    }
    .copied()
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
// ext は get が投げうるので Result を返す関数で受ける (原文では ready に入るのは見えているノードだけなので Err は届かない)。
// extra_edges は原文にない枠の配置の制約 (先行, 後続, 足す値) で、x(後続) ≥ x(先行) + ext(先行) + 足す値。
// Node 以外の Slot は幅 0 の仮の点で、ext を足さず結果にも入れない。足す値が 0 の辺は足し算をしない (0 を足すと -0 の符号が変わる)。
// extra_edges が空なら値と並びは原文と同じ
fn longest_path_x(
    graph: &VisibleGraph,
    predecessors: &IndexMap<u32, Vec<u32>>,
    ext: &mut dyn FnMut(u32) -> Result<f64, LayoutError>,
    extra_edges: &[(Slot, Slot, f64)],
) -> Result<IndexMap<u32, f64>, LayoutError> {
    // 反復しない Map (A-008)。後続の並びは Vec なので、原文の辺の順 (predecessors の順) のまま
    let mut successors: HashMap<Slot, Vec<(Slot, f64)>> = graph
        .nodes
        .iter()
        .map(|node| (Slot::Node(node.id), Vec::new()))
        .collect();
    // 反復しない Map (A-008)。1 ずつ減らすので負になりうる値として i64 で持つ (規則 2.1)
    let mut remaining: HashMap<Slot, i64> = HashMap::new();
    for (&target, sources) in predecessors {
        remaining.insert(Slot::Node(target), sources.len() as i64);
        for &source in sources {
            if let Some(list) = successors.get_mut(&Slot::Node(source)) {
                list.push((Slot::Node(target), 0.0));
            }
        }
    }
    // 仮の点 (初めて現れた順)
    let mut points: Vec<Slot> = Vec::new();
    for &(source, target, extra) in extra_edges {
        for slot in [source, target] {
            if !matches!(slot, Slot::Node(_)) && !successors.contains_key(&slot) {
                successors.insert(slot, Vec::new());
                points.push(slot);
            }
        }
        *remaining.entry(target).or_insert(0) += 1;
        if let Some(list) = successors.get_mut(&source) {
            list.push((target, extra));
        }
    }
    let mut x: IndexMap<u32, f64> = IndexMap::new();
    let mut point_x: HashMap<Slot, f64> = HashMap::new();
    // 仮の点を先に積むので、先行のない仮の点はノードのあとに取り出す
    let mut ready: Vec<Slot> = points
        .iter()
        .copied()
        .filter(|slot| remaining.get(slot).copied().unwrap_or(0) == 0)
        .collect();
    for &slot in &ready {
        point_x.insert(slot, 0.0);
    }
    for node in &graph.nodes {
        if remaining.get(&Slot::Node(node.id)).copied().unwrap_or(0) == 0 {
            x.insert(node.id, 0.0);
            ready.push(Slot::Node(node.id));
        }
    }
    while let Some(slot) = ready.pop() {
        let right = match slot {
            Slot::Node(id) => x.get(&id).copied().unwrap_or(0.0) + ext(id)?,
            _ => point_x.get(&slot).copied().unwrap_or(0.0),
        };
        for &(next, extra) in successors.get(&slot).map(Vec::as_slice).unwrap_or(&[]) {
            let reach = if extra == 0.0 { right } else { right + extra };
            match next {
                Slot::Node(id) => {
                    x.insert(id, js_max(x.get(&id).copied().unwrap_or(0.0), reach));
                }
                _ => {
                    point_x.insert(
                        next,
                        js_max(point_x.get(&next).copied().unwrap_or(0.0), reach),
                    );
                }
            }
            let left = remaining.get(&next).copied().unwrap_or(0) - 1;
            remaining.insert(next, left);
            if left == 0 {
                ready.push(next);
            }
        }
    }
    // 値の入った数だけの判定 (原文) は、閉路のどの点にも閉路の外から値が入ると見逃す。
    // 先行を待ち続けた点が残ったときだけ、graph の中の点どうしの辺で閉路を探す
    // (graph にない先行を待つだけなら閉路ではなく、原文と同じ扱いにする)
    let stalled = remaining.values().any(|&left| left > 0);
    if (stalled && has_cycle(graph, predecessors, extra_edges)) || x.len() != graph.nodes.len() {
        return Err(LayoutError {
            message: "横位置の制約に閉路がある".to_string(),
        });
    }
    Ok(x)
}

// longest_path_x の制約 (graph の中のノードと仮の点のあいだの辺だけ) に閉路があるか。取り出す順は結果に出ない
fn has_cycle(
    graph: &VisibleGraph,
    predecessors: &IndexMap<u32, Vec<u32>>,
    extra_edges: &[(Slot, Slot, f64)],
) -> bool {
    let mut indegree: HashMap<Slot, usize> = graph
        .nodes
        .iter()
        .map(|node| (Slot::Node(node.id), 0))
        .collect();
    for &(source, target, _) in extra_edges {
        for slot in [source, target] {
            if !matches!(slot, Slot::Node(_)) {
                indegree.entry(slot).or_insert(0);
            }
        }
    }
    let edges = predecessors
        .iter()
        .flat_map(|(&target, sources)| {
            sources
                .iter()
                .map(move |&source| (Slot::Node(source), Slot::Node(target)))
        })
        .chain(
            extra_edges
                .iter()
                .map(|&(source, target, _)| (source, target)),
        );
    let mut next_of: HashMap<Slot, Vec<Slot>> = HashMap::new();
    for (source, target) in edges {
        if !indegree.contains_key(&source) {
            continue;
        }
        let Some(count) = indegree.get_mut(&target) else {
            continue;
        };
        *count += 1;
        next_of.entry(source).or_default().push(target);
    }
    let mut stack: Vec<Slot> = indegree
        .iter()
        .filter(|&(_, &count)| count == 0)
        .map(|(&slot, _)| slot)
        .collect();
    let mut done = 0usize;
    while let Some(slot) = stack.pop() {
        done += 1;
        for next in next_of.get(&slot).map(Vec::as_slice).unwrap_or(&[]) {
            if let Some(count) = indegree.get_mut(next) {
                *count -= 1;
                if *count == 0 {
                    stack.push(*next);
                }
            }
        }
    }
    done < indegree.len()
}

/// 箱ごとの深さの方向の範囲 (枠の配置の段 3)
#[derive(Debug, Clone, PartialEq)]
pub struct BlockDepth {
    /// 箱の左の端 (flextree の深さの座標)。配置の木の親 (placement.parent_of) の右の端。
    /// 箱が包む箱の中の木の根なら、包む箱の start と同じ (B-5)。配置の木の根の箱は 0
    pub start: f64,
    /// 枠の右の辺 (メンバーの本体の右の端の最大 + frame_padding(level).side)
    pub frame_right: f64,
    /// 箱の深さの方向の終わり (frame_right + spacing_horizontal)。出口の単位はここから始まる。
    /// 段 4 の箱の深さの方向の大きさは end − start
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DepthPlan {
    pub planned_x: IndexMap<u32, f64>,
    /// 本体の左に確保した余白。配置の木の親の右の端から測る (出口の単位の根は移し先の frame_right + spacing_horizontal から)
    pub gap_of: HashMap<u32, f64>,
    /// blocks の添字ごと
    pub blocks: Vec<BlockDepth>,
}

// 深さの始まりを測る相手。箱の中の木の根と仮の根 (Joint) の子は包む箱と同じ所から始まるので、包む箱をさかのぼった先の親。
// 外側の仮の根 (Origin) の子は原点から
#[derive(Clone, Copy)]
enum Anchor {
    // 配置の木の根。0 から
    Origin,
    // 実のノードの右の端 (planned_x + ext) から
    Node(u32),
    // 箱の出口の子。その箱の frame_right + spacing_horizontal から
    Exit(usize),
}

// 配置の木の親 parent から、child の深さの始まりを測る相手を 1 段だけ決める。包む箱と同じ所から始まるなら Err でその箱を返す
fn anchor_step(
    placement: &PlacementTree,
    parent: Option<Slot>,
    child: Slot,
) -> Result<Anchor, usize> {
    match parent {
        None => Ok(Anchor::Origin),
        Some(Slot::Node(p)) => Ok(Anchor::Node(p)),
        Some(Slot::Block(x)) if placement.inner.get(x).map(|inner| inner.0) == Some(child) => {
            Err(x)
        }
        Some(Slot::Block(x)) => Ok(Anchor::Exit(x)),
        Some(Slot::Origin) => Ok(Anchor::Origin),
        Some(Slot::Joint(x)) => Err(x),
    }
}

/// 原文なし。
/// 枠の配置の段 3 (深さの方向の位置)。longest_path_x に、箱ごとの仮の点を通る出口の制約
/// (メンバー → 仮の点 (足す値 side)、仮の点 → 出口の単位の根 (0)) と、枠の左の辺が手前の本体や枠に食い込まないための
/// 箱の根の余白の差 (side − spacing_horizontal、正のときだけ) を足して planned_x を決める。
/// gap と箱の start は、配置の木の親 (placement.parent_of) の右の端から測る。後戻りした単位 (fallbacks) には制約を足さない。
/// 出口の制約が閉路になる配置の木 (段 2 の前提が崩れた入力) では「横位置の制約に閉路がある」を返す。
/// predecessors は layout_graph_with_extra_spacing と同じ組み立ての先行ノード
pub fn block_depths(
    graph: &VisibleGraph,
    options: &LayoutOptions,
    placement: &PlacementTree,
    blocks: &FrameBlocks,
    frames: &[Frame],
    predecessors: &IndexMap<u32, Vec<u32>>,
) -> Result<DepthPlan, LayoutError> {
    let spacing = options.spacing_horizontal;
    let get = visible_node_getter(graph);
    // ext は layout_graph_with_extra_spacing と同じ式を同じ順で足す
    let body = |id: u32| -> Result<f64, LayoutError> { Ok(node_body(get(id)?, options)) };
    let ext = |id: u32| -> Result<f64, LayoutError> { Ok(node_ext(get(id)?, options)) };
    let count = blocks.blocks.len();
    let side_of = |index: usize| frame_padding(blocks.blocks[index].level).side;
    let members_of = |index: usize| -> &[u32] {
        frames
            .get(blocks.blocks[index].frame)
            .map(|frame| frame.members.as_slice())
            .unwrap_or(&[])
    };

    // 箱ごとの深さの始まりの相手。包む箱をたどる鎖は深くなりうるので、再帰せずに鎖をたどって覚える
    let mut anchors: Vec<Option<Anchor>> = vec![None; count];
    for index in 0..count {
        let mut path: Vec<usize> = Vec::new();
        let mut block = index;
        let anchor = loop {
            if let Some(known) = anchors[block] {
                break known;
            }
            path.push(block);
            let slot = Slot::Block(block);
            match anchor_step(placement, placement.parent_of.get(&slot).copied(), slot) {
                Ok(anchor) => break anchor,
                Err(outer) => block = outer,
            }
        };
        for walked in path {
            anchors[walked] = Some(anchor);
        }
    }

    let mut extra_edges: Vec<(Slot, Slot, f64)> = Vec::new();
    // 出口の制約。仮の点は出口を受け入れた箱ごとに 1 つで、辺はメンバーの数 + 出口の根の数 (A-5)
    let mut has_point = vec![false; count];
    for (unit, exit) in &placement.exits {
        let target = exit.block;
        if !has_point[target] {
            has_point[target] = true;
            let side = side_of(target);
            for &member in members_of(target) {
                extra_edges.push((Slot::Node(member), Slot::Block(target), side));
            }
        }
        let roots: &[u32] = match unit {
            Slot::Node(id) => std::slice::from_ref(id),
            Slot::Block(block) => &blocks.blocks[*block].roots,
            Slot::Joint(_) | Slot::Origin => &[],
        };
        for &root in roots {
            extra_edges.push((Slot::Block(target), Slot::Node(root), 0.0));
        }
    }
    // 箱の根の余白の差。枠の左の辺 (根の本体の左から side) が、深さの始まりの相手 (手前の本体か、出口の子なら移し先の枠) に
    // 食い込まないよう、始まりから side 以上離す。同じ根を持つ箱が重なるとき (入れ子) は、いちばん大きい差だけでよい
    let mut root_extra: IndexMap<(Slot, u32), f64> = IndexMap::new();
    for (index, block) in blocks.blocks.iter().enumerate() {
        let extra = side_of(index) - spacing;
        if extra <= 0.0 || extra.is_nan() {
            continue;
        }
        let from = match anchors[index] {
            Some(Anchor::Node(p)) => Slot::Node(p),
            Some(Anchor::Exit(x)) => Slot::Block(x),
            Some(Anchor::Origin) | None => continue,
        };
        for &root in &block.roots {
            let entry = root_extra.entry((from, root)).or_insert(0.0);
            *entry = js_max(*entry, extra);
        }
    }
    extra_edges.extend(
        root_extra
            .into_iter()
            .map(|((from, root), extra)| (from, Slot::Node(root), extra)),
    );

    let planned_x = longest_path_x(graph, predecessors, &mut |id| ext(id), &extra_edges)?;
    let x_of = |id: u32| planned_x.get(&id).copied().unwrap_or(0.0);

    let mut frame_right: Vec<f64> = Vec::with_capacity(count);
    for (index, block) in blocks.blocks.iter().enumerate() {
        let mut right = f64::NEG_INFINITY;
        for &member in members_of(index) {
            right = right.max(x_of(member) + body(member)?);
        }
        frame_right.push(right + frame_padding(block.level).side);
    }
    let right_end = |anchor: Anchor| -> Result<f64, LayoutError> {
        Ok(match anchor {
            Anchor::Origin => 0.0,
            Anchor::Node(p) => x_of(p) + ext(p)?,
            Anchor::Exit(x) => frame_right[x] + spacing,
        })
    };
    let mut starts: Vec<f64> = Vec::with_capacity(count);
    for anchor in &anchors {
        starts.push(right_end(anchor.unwrap_or(Anchor::Origin))?);
    }

    let mut gap_of: HashMap<u32, f64> = HashMap::new();
    for node in &graph.nodes {
        let slot = Slot::Node(node.id);
        let start = match anchor_step(placement, placement.parent_of.get(&slot).copied(), slot) {
            Ok(anchor) => right_end(anchor)?,
            Err(block) => starts[block],
        };
        gap_of.insert(node.id, x_of(node.id) - start);
    }

    Ok(DepthPlan {
        planned_x,
        gap_of,
        blocks: starts
            .into_iter()
            .zip(frame_right)
            .map(|(start, frame_right)| BlockDepth {
                start,
                frame_right,
                end: frame_right + spacing,
            })
            .collect(),
    })
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

    // 段 3 (深さの方向の位置) の単体テスト。期待値は design.md の「段 3: 深さの方向の位置」から導く。
    // 仮定したシグネチャ (出力の型の欄は設計のとおり。関数の引数の並びと戻り値の Result は設計に書かれていないので仮定):
    //     pub struct BlockDepth { pub start: f64, pub frame_right: f64 }
    //     pub struct DepthPlan { pub planned_x: IndexMap<u32, f64>, pub gap_of: HashMap<u32, f64>, pub blocks: Vec<BlockDepth> }
    //     pub fn block_depths(graph: &VisibleGraph, options: &LayoutOptions, placement: &PlacementTree, blocks: &FrameBlocks,
    //                         frames: &[Frame], predecessors: &IndexMap<u32, Vec<u32>>) -> Result<DepthPlan, LayoutError>
    //     fn longest_path_x(graph: &VisibleGraph, predecessors: &IndexMap<u32, Vec<u32>>,
    //                       ext: &mut dyn FnMut(u32) -> Result<f64, LayoutError>,
    //                       extra_edges: &[(Slot, Slot, f64)]) -> Result<IndexMap<u32, f64>, LayoutError>
    //         extra_edges は (先行, 後続, 足す値)。Slot::Node(id) は実のノード、Slot::Block(i) は箱 i の仮の点 (幅 0、ext 0)。
    //         仮の点は結果に入れない。x(後続) ≥ x(先行) + ext(先行) + 足す値
    // BlockDepth と DepthPlan の derive (Debug、PartialEq) には頼らない (欄を読んで比べる)。
    // 数値の約束: graph_with のノードは幅 40。既定の options (padding_x 8、spacing_horizontal 80) で
    //     本体の幅 = 40 + 8 × 2 = 56、ext = 56 + 80 = 136。
    //     frame_padding(level).side = 8 + 22 × level (level 0 は 8、1 は 30、2 は 52)。
    // 各テストは check_plan で、設計の定義 (frame_right、start、gap_of、出口の制約) を plan の値どうしで確かめる。
    mod depth {
        use std::collections::HashMap;
        use std::time::{Duration, Instant};

        use indexmap::IndexMap;

        use crate::layout::frames::{
            Frame, FrameBlocks, compute_frames, frame_blocks, frame_padding,
        };
        use crate::layout::layout::{
            DepthPlan, LayoutOptions, MARKMAP_DEFAULTS, block_depths, layout_children_of,
            layout_graph, layout_predecessors, longest_path_x,
        };
        use crate::layout::placement::{Exit, PlacementTree, Slot, placement_tree};
        use crate::layout::project::{VisibleGraph, project};
        use crate::model::util::js_max;
        use crate::types::{
            GroupDef, LayoutError, LayoutInput, LayoutInputEdge, LayoutInputNode,
            LayoutInputRelation, RelationKind,
        };

        // nested-groups (frames.rs と placement.rs の tests と同じ): 1 root / 2 仕様策定 / 3 画面開発 / 4, 5 その子 /
        // 6 API開発 / 7, 8 その子 / 9 効果測定
        // longest_path_x に足す辺 (先行, 後続, 足す値)
        type ExtraEdge = (Slot, Slot, f64);

        const NESTED_TREE: [(u32, u32); 8] = [
            (1, 2),
            (2, 3),
            (3, 4),
            (3, 5),
            (2, 6),
            (6, 7),
            (6, 8),
            (1, 9),
        ];

        fn group(id: &str) -> GroupDef {
            GroupDef {
                id: id.to_string(),
                label: id.to_string(),
                color: Some("#888".to_string()),
                boundary: true,
                defined: true,
                icon: None,
            }
        }

        fn groups_of(entries: &[(u32, &[&str])]) -> IndexMap<u32, Vec<String>> {
            entries
                .iter()
                .map(|(id, groups)| (*id, groups.iter().map(|g| g.to_string()).collect()))
                .collect()
        }

        // ノードは 1..=count (1 がルート、幅 40)。付け替え (配置上の親) は project が決める
        fn graph_with(
            count: u32,
            tree: &[(u32, u32)],
            relations: &[(RelationKind, u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            project(&LayoutInput {
                name: "block-depths".to_string(),
                nodes: (1..=count)
                    .map(|id| LayoutInputNode {
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
                folded: Vec::new(),
            })
            .unwrap()
        }

        fn graph_of(
            count: u32,
            tree: &[(u32, u32)],
            chain: &[(u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            let relations: Vec<(RelationKind, u32, u32)> = chain
                .iter()
                .map(|&(source, target)| (RelationKind::Chain, source, target))
                .collect();
            graph_with(count, tree, &relations, suppress)
        }

        fn nested() -> VisibleGraph {
            graph_of(9, &NESTED_TREE, &[], &[])
        }

        fn frames_of(graph: &VisibleGraph, ids: &[&str], entries: &[(u32, &[&str])]) -> Vec<Frame> {
            let groups: Vec<GroupDef> = ids.iter().map(|id| group(id)).collect();
            compute_frames(
                graph,
                &groups,
                &groups_of(entries),
                &layout_children_of(graph),
            )
        }

        fn members_of(frames: &[Frame]) -> Vec<(String, Vec<u32>)> {
            frames
                .iter()
                .map(|frame| (frame.group.id.clone(), frame.members.clone()))
                .collect()
        }

        fn assert_no_excluded_relations(graph: &VisibleGraph) {
            assert!(graph.edges.iter().all(|edge| !edge.excluded_from_layout));
        }

        fn with_spacing(spacing_horizontal: f64) -> LayoutOptions {
            LayoutOptions {
                spacing_horizontal,
                ..MARKMAP_DEFAULTS
            }
        }

        fn widths(graph: &VisibleGraph) -> HashMap<u32, f64> {
            graph
                .nodes
                .iter()
                .map(|node| (node.id, node.width))
                .collect()
        }

        // 本体の幅 (layout_graph_with_extra_spacing の ext から spacing_horizontal を除いたもの)
        fn body_of(width: f64, options: &LayoutOptions) -> f64 {
            width
                + (if width > 0.0 {
                    options.padding_x * 2.0
                } else {
                    0.0
                })
        }

        fn ext_of(width: f64, options: &LayoutOptions) -> f64 {
            body_of(width, options) + options.spacing_horizontal
        }

        fn ext(graph: &VisibleGraph, options: &LayoutOptions, id: u32) -> f64 {
            ext_of(
                graph.nodes.iter().find(|node| node.id == id).unwrap().width,
                options,
            )
        }

        // 変える前の longest_path_x の写し (3e0b00f と同じ本体)。旧の値の基準
        fn longest_path_x_before_frames(
            graph: &VisibleGraph,
            predecessors: &IndexMap<u32, Vec<u32>>,
            ext: &mut dyn FnMut(u32) -> Result<f64, LayoutError>,
        ) -> Result<IndexMap<u32, f64>, LayoutError> {
            let mut successors: IndexMap<u32, Vec<u32>> = graph
                .nodes
                .iter()
                .map(|node| (node.id, Vec::new()))
                .collect();
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

        fn old_planned_x(graph: &VisibleGraph, options: &LayoutOptions) -> IndexMap<u32, f64> {
            let widths = widths(graph);
            longest_path_x_before_frames(
                graph,
                &layout_predecessors(graph, &MARKMAP_DEFAULTS),
                &mut |id| Ok(ext_of(widths[&id], options)),
            )
            .unwrap()
        }

        // 旧の gap: L0 の親の右の端 (planned_x + ext) から測る。親がなければ 0 から
        fn old_gap_of(
            graph: &VisibleGraph,
            options: &LayoutOptions,
            planned_x: &IndexMap<u32, f64>,
        ) -> HashMap<u32, f64> {
            let widths = widths(graph);
            graph
                .nodes
                .iter()
                .map(|node| {
                    let start = match graph.layout_parent.get(&node.id) {
                        None => 0.0,
                        Some(&parent) => planned_x[&parent] + ext_of(widths[&parent], options),
                    };
                    (node.id, planned_x[&node.id] - start)
                })
                .collect()
        }

        struct Prepared {
            graph: VisibleGraph,
            options: LayoutOptions,
            frames: Vec<Frame>,
            blocks: FrameBlocks,
            tree: PlacementTree,
            predecessors: IndexMap<u32, Vec<u32>>,
        }

        // 段 1 と段 2 の本物の関数で段 3 の入力を作る
        fn prepare(graph: VisibleGraph, frames: Vec<Frame>, options: LayoutOptions) -> Prepared {
            let children_of = layout_children_of(&graph);
            let blocks = frame_blocks(&graph, &frames, &children_of);
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let tree = placement_tree(&graph, &children_of, &frames, &blocks, &predecessors);
            Prepared {
                graph,
                options,
                frames,
                blocks,
                tree,
                predecessors,
            }
        }

        impl Prepared {
            fn run(&self) -> Result<DepthPlan, LayoutError> {
                block_depths(
                    &self.graph,
                    &self.options,
                    &self.tree,
                    &self.blocks,
                    &self.frames,
                    &self.predecessors,
                )
            }

            fn block(&self, group: &str) -> usize {
                let found: Vec<usize> = (0..self.blocks.blocks.len())
                    .filter(|&index| self.frames[self.blocks.blocks[index].frame].group.id == group)
                    .collect();
                assert_eq!(found.len(), 1, "{group} の箱はちょうど 1 つ");
                found[0]
            }

            fn exits(&self) -> Vec<(Slot, usize)> {
                self.tree
                    .exits
                    .iter()
                    .map(|(unit, exit)| (*unit, exit.block))
                    .collect()
            }
        }

        struct Depths {
            input: Prepared,
            plan: DepthPlan,
        }

        impl Depths {
            fn x(&self, id: u32) -> f64 {
                self.plan.planned_x[&id]
            }

            fn gap(&self, id: u32) -> f64 {
                self.plan.gap_of[&id]
            }

            fn start(&self, group: &str) -> f64 {
                self.plan.blocks[self.input.block(group)].start
            }

            fn frame_right(&self, group: &str) -> f64 {
                self.plan.blocks[self.input.block(group)].frame_right
            }
        }

        fn depths_with(graph: VisibleGraph, frames: Vec<Frame>, options: LayoutOptions) -> Depths {
            let input = prepare(graph, frames, options);
            let plan = match input.run() {
                Ok(plan) => plan,
                Err(error) => panic!("block_depths が誤りを返した: {}", error.message),
            };
            check_plan(&input, &plan);
            Depths { input, plan }
        }

        fn depths(graph: VisibleGraph, frames: Vec<Frame>) -> Depths {
            depths_with(graph, frames, MARKMAP_DEFAULTS)
        }

        // 配置の木の親の右の端 (設計の段 3 の BlockDepth.start と gap_of の定義):
        //     Node(p) → planned_x(p) + ext(p)
        //     Block(x) → s が inner[x].0 なら x の start (箱の中の木の根。B-5)、違えば x の frame_right + spacing_horizontal (出口の子)
        //     Joint(x) → x の start (Joint は大きさ 0)
        //     外側の仮の根 (G-005 の C-01) → 0 (原点)
        fn right_end_for(
            input: &Prepared,
            plan: &DepthPlan,
            widths: &HashMap<u32, f64>,
            parent: Slot,
            child: Slot,
        ) -> f64 {
            let spacing = input.options.spacing_horizontal;
            match parent {
                Slot::Node(p) => plan.planned_x[&p] + ext_of(widths[&p], &input.options),
                Slot::Block(x) if input.tree.inner[x].0 == child => plan.blocks[x].start,
                Slot::Block(x) => plan.blocks[x].frame_right + spacing,
                Slot::Joint(x) => plan.blocks[x].start,
                // 外側の仮の根 (G-005 の C-01) は原点 (大きさ 0)
                #[allow(unreachable_patterns)]
                _ => 0.0,
            }
        }

        // 設計の段 3 の定義を、plan の値どうしで確かめる
        fn check_plan(input: &Prepared, plan: &DepthPlan) {
            let graph = &input.graph;
            let options = &input.options;
            let spacing = options.spacing_horizontal;
            let widths = widths(graph);
            assert_eq!(
                plan.blocks.len(),
                input.blocks.blocks.len(),
                "blocks は箱ごとに 1 つ"
            );
            // 仮の点は planned_x に入れない。gap_of は実のノードごと
            assert_eq!(plan.planned_x.len(), graph.nodes.len());
            assert_eq!(plan.gap_of.len(), graph.nodes.len());
            for node in &graph.nodes {
                assert!(
                    plan.planned_x.contains_key(&node.id),
                    "planned_x に {} がない",
                    node.id
                );
                assert!(
                    plan.gap_of.contains_key(&node.id),
                    "gap_of に {} がない",
                    node.id
                );
            }

            // frame_right = メンバーの本体の右の端の最大 + frame_padding(level).side
            for (index, block) in input.blocks.blocks.iter().enumerate() {
                let frame = &input.frames[block.frame];
                let right = frame
                    .members
                    .iter()
                    .map(|&m| plan.planned_x[&m] + body_of(widths[&m], options))
                    .fold(f64::NEG_INFINITY, f64::max);
                let expected = right + frame_padding(block.level).side;
                assert_eq!(
                    plan.blocks[index].frame_right, expected,
                    "{} の frame_right",
                    frame.group.id
                );
            }

            // start = 配置の木の親の右の端
            for index in 0..input.blocks.blocks.len() {
                let slot = Slot::Block(index);
                // 配置の木の根 (親のない箱) の start は 0 (gap の「親がなければ 0 から」と同じ)
                let Some(&parent) = input.tree.parent_of.get(&slot) else {
                    assert_eq!(
                        plan.blocks[index].start, 0.0,
                        "箱 {index} の start (配置の木の根)"
                    );
                    continue;
                };
                assert_eq!(
                    plan.blocks[index].start,
                    right_end_for(input, plan, &widths, parent, slot),
                    "箱 {index} の start"
                );
            }

            // gap_of = planned_x − 配置の木の親の右の端。親がなければ 0 から (旧と同じ)
            for node in &graph.nodes {
                let slot = Slot::Node(node.id);
                let start = match input.tree.parent_of.get(&slot) {
                    None => 0.0,
                    Some(&parent) => right_end_for(input, plan, &widths, parent, slot),
                };
                assert_eq!(
                    plan.gap_of[&node.id].to_bits(),
                    (plan.planned_x[&node.id] - start).to_bits(),
                    "{} の gap",
                    node.id
                );
            }

            // 出口の制約: 単位の根の planned_x ≥ 移し先の frame_right + spacing_horizontal。
            // Node の単位の gap は planned_x − (frame_right + spacing_horizontal) で 0 以上。Block の単位の start はその値
            for (unit, exit) in &input.tree.exits {
                let bound = plan.blocks[exit.block].frame_right + spacing;
                let roots: Vec<u32> = match unit {
                    Slot::Node(id) => vec![*id],
                    Slot::Block(b) => input.blocks.blocks[*b].roots.clone(),
                    _ => panic!("出口の単位は Node か Block"),
                };
                for root in roots {
                    assert!(
                        plan.planned_x[&root] >= bound,
                        "出口の根 {root} は移し先の枠の右の辺 + spacing_horizontal より右"
                    );
                }
                match unit {
                    Slot::Node(id) => assert!(plan.gap_of[id] >= 0.0),
                    Slot::Block(b) => assert_eq!(plan.blocks[*b].start, bound),
                    _ => {}
                }
            }
        }

        fn assert_same_bits(actual: &IndexMap<u32, f64>, expected: &IndexMap<u32, f64>) {
            let a: Vec<(u32, u64)> = actual.iter().map(|(&id, x)| (id, x.to_bits())).collect();
            let e: Vec<(u32, u64)> = expected.iter().map(|(&id, x)| (id, x.to_bits())).collect();
            assert_eq!(a, e);
        }

        fn sorted_bits(map: &IndexMap<u32, f64>) -> Vec<(u32, u64)> {
            let mut list: Vec<(u32, u64)> = map.iter().map(|(&id, x)| (id, x.to_bits())).collect();
            list.sort();
            list
        }

        fn gap_bits(map: &HashMap<u32, f64>) -> Vec<(u32, u64)> {
            let mut list: Vec<(u32, u64)> = map.iter().map(|(&id, x)| (id, x.to_bits())).collect();
            list.sort();
            list
        }

        // 試作の pipeline.rs の notation_like (placement.rs の tests と同じ): 1 root / 2 要件 / 3 設計 %d (4、5 が子) /
        // 6 実装 %b (7 フロント (8、9、10)、11 バック (12、13)) / 14 検証 (15、16 が子)。
        // 2 -fork-> 4、5、3 -chain-> 6 -chain-> 14、10 -join-> 14、13 -join-> 14、12 -depends-> 9
        fn notation_like_graph() -> VisibleGraph {
            use RelationKind::*;
            let graph = graph_with(
                16,
                &[
                    (1, 2),
                    (1, 3),
                    (3, 4),
                    (3, 5),
                    (1, 6),
                    (6, 7),
                    (7, 8),
                    (7, 9),
                    (7, 10),
                    (6, 11),
                    (11, 12),
                    (11, 13),
                    (1, 14),
                    (14, 15),
                    (14, 16),
                ],
                &[
                    (Fork, 2, 4),
                    (Fork, 2, 5),
                    (Chain, 3, 6),
                    (Chain, 6, 14),
                    (Join, 10, 14),
                    (Join, 13, 14),
                    (Depends, 12, 9),
                ],
                &[6, 14],
            );
            assert_eq!(graph.layout_parent.get(&6), Some(&3));
            assert_eq!(graph.layout_parent.get(&14), Some(&10));
            assert_no_excluded_relations(&graph);
            graph
        }

        fn notation_like_frames(graph: &VisibleGraph) -> Vec<Frame> {
            let entries: Vec<(u32, &[&str])> = (1..=16)
                .map(|id| {
                    let list: &[&str] = match id {
                        3..=5 => &["d"],
                        6..=13 => &["b"],
                        _ => &[],
                    };
                    (id, list)
                })
                .collect();
            let frames = frames_of(graph, &["d", "b"], &entries);
            assert_eq!(
                members_of(&frames),
                vec![
                    ("d".to_string(), vec![3, 4, 5]),
                    ("b".to_string(), (6..=13).collect())
                ]
            );
            frames
        }

        // loose-frames.md の例 1: 1 root / 2 設計 / 3 入力画面の改修 (設計の子) / 4 エラー文言と案内文の見直し / 5 告知。
        // 設計 --> 4 で 4 は設計の下へ、3 --> 告知 で告知は 3 の下へ付け替わる。copy = {3, 4}
        fn example1_graph() -> VisibleGraph {
            graph_of(
                5,
                &[(1, 2), (2, 3), (1, 4), (1, 5)],
                &[(2, 4), (3, 5)],
                &[4, 5],
            )
        }

        // design.md の Q3 の例 3: 1 root / 2 設計 %design / 3 画面、4 API / 5 告知。画面 --> 告知 --> API
        fn example3() -> (VisibleGraph, Vec<Frame>) {
            let graph = graph_of(
                5,
                &[(1, 2), (2, 3), (2, 4), (1, 5)],
                &[(3, 5), (5, 4)],
                &[5],
            );
            assert_eq!(graph.layout_parent.get(&5), Some(&3));
            assert_no_excluded_relations(&graph);
            let frames = frames_of(
                &graph,
                &["design"],
                &[(2, &["design"]), (3, &["design"]), (4, &["design"])],
            );
            (graph, frames)
        }

        // 1 root / 2 開発 / 3 設計 (開発の子) / 4 画面、5 API (設計の子) / 6 告知 (設計 --> 告知 で設計の下へ)
        fn nested_exit_graph() -> VisibleGraph {
            graph_of(
                6,
                &[(1, 2), (2, 3), (3, 4), (3, 5), (1, 6)],
                &[(3, 6)],
                &[6],
            )
        }

        // 1 root / 2 本部 / 3 開発 / 4 設計 / 5 画面、6 API (設計の子) / 7 告知 (設計 --> 告知 で設計の下へ)
        fn three_levels_graph() -> VisibleGraph {
            let graph = graph_of(
                7,
                &[(1, 2), (2, 3), (3, 4), (4, 5), (4, 6), (1, 7)],
                &[(4, 7)],
                &[7],
            );
            assert_eq!(layout_children_of(&graph).get(&4), Some(&vec![5, 6, 7]));
            graph
        }

        #[test]
        fn block_depths_without_frames_match_the_old_longest_path_x() {
            // 枠のない入力 (I3): planned_x (並びと to_bits) と gap が、変える前の longest_path_x と旧の gap の式と同じ。blocks は空
            let cases: Vec<(VisibleGraph, LayoutOptions)> = vec![
                (super::gap_graph(), MARKMAP_DEFAULTS),
                (super::adopted_graph(), MARKMAP_DEFAULTS),
                (nested(), MARKMAP_DEFAULTS),
                (notation_like_graph(), MARKMAP_DEFAULTS),
                (example1_graph(), with_spacing(10.0)),
                (
                    super::gap_graph(),
                    LayoutOptions {
                        padding_x: 3.5,
                        spacing_horizontal: 17.25,
                        ..MARKMAP_DEFAULTS
                    },
                ),
            ];
            for (graph, options) in cases {
                let expected_x = old_planned_x(&graph, &options);
                let expected_gap = old_gap_of(&graph, &options, &expected_x);
                let result = depths_with(graph, Vec::new(), options);
                assert!(result.plan.blocks.is_empty());
                assert_same_bits(&result.plan.planned_x, &expected_x);
                assert_eq!(gap_bits(&result.plan.gap_of), gap_bits(&expected_gap));
            }
        }

        #[test]
        fn block_depths_without_frames_match_layout_graph() {
            // 旧の実装 (原文を vite-node に通した値。layout_gap_graph_matches_the_old_implementation) と layout_graph の結果と同じ
            let graph = super::gap_graph();
            let old = layout_graph(&graph, None).unwrap();
            let result = depths(graph, Vec::new());
            let planned: Vec<(u32, f64)> = result
                .plan
                .planned_x
                .iter()
                .map(|(&id, &x)| (id, x))
                .collect();
            assert_eq!(planned, vec![(1, 0.0), (2, 136.0), (4, 408.0), (3, 262.0)]);
            assert_same_bits(&result.plan.planned_x, &old.planned_x);
            for (id, placed) in &old.nodes {
                assert_eq!(
                    result.gap(*id).to_bits(),
                    placed.gap.to_bits(),
                    "{id} の gap"
                );
            }
            assert_eq!(result.gap(4), 272.0);
        }

        #[test]
        fn block_depths_longest_path_x_with_only_zero_extras_matches_the_old_values() {
            // 足す値 0 の辺だけなら、旧と同じ値 (to_bits)。
            // (1) 足す辺がないときは並びも同じ。
            // (2) 既にある先行の組に足す値 0 の辺を重ねても、仮の点を通して 0 の辺をつないでも、値は同じ。
            //     TODO(spec): 足す辺があるときの planned_x の並び (ready の順) は設計に書かれていないので、id の順に並べて比べる
            let cases: Vec<(VisibleGraph, Vec<ExtraEdge>)> = vec![
                (
                    super::gap_graph(),
                    // gap_graph の先行: 2 ← 1、3 ← 2、4 ← 1 と 3
                    vec![
                        (Slot::Node(1), Slot::Node(2), 0.0),
                        (Slot::Node(3), Slot::Node(4), 0.0),
                        (Slot::Node(2), Slot::Block(0), 0.0),
                        (Slot::Block(0), Slot::Node(3), 0.0),
                    ],
                ),
                (
                    super::adopted_graph(),
                    // adopted_graph の先行: 2 ← 1、3 ← 2、4 ← 2 (配置上の親) と 2 (depends)
                    vec![
                        (Slot::Node(2), Slot::Node(4), 0.0),
                        (Slot::Node(2), Slot::Block(0), 0.0),
                        (Slot::Block(0), Slot::Node(3), 0.0),
                        (Slot::Block(0), Slot::Node(4), 0.0),
                    ],
                ),
                (
                    nested(),
                    vec![
                        (Slot::Node(3), Slot::Block(0), 0.0),
                        (Slot::Node(6), Slot::Block(1), 0.0),
                        (Slot::Block(0), Slot::Node(4), 0.0),
                        (Slot::Block(0), Slot::Node(5), 0.0),
                        (Slot::Block(1), Slot::Node(7), 0.0),
                        (Slot::Node(1), Slot::Node(9), 0.0),
                    ],
                ),
            ];
            for (graph, extras) in cases {
                let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
                let options = MARKMAP_DEFAULTS;
                let old = longest_path_x_before_frames(&graph, &predecessors, &mut |id| {
                    Ok(ext(&graph, &options, id))
                })
                .unwrap();
                let none = longest_path_x(
                    &graph,
                    &predecessors,
                    &mut |id| Ok(ext(&graph, &options, id)),
                    &[],
                )
                .unwrap();
                assert_same_bits(&none, &old);
                let zero = longest_path_x(
                    &graph,
                    &predecessors,
                    &mut |id| Ok(ext(&graph, &options, id)),
                    &extras,
                )
                .unwrap();
                assert_eq!(zero.len(), graph.nodes.len(), "仮の点は結果に入らない");
                assert_eq!(sorted_bits(&zero), sorted_bits(&old));
            }
        }

        #[test]
        fn block_depths_longest_path_x_with_zero_extras_keeps_negative_ext_values() {
            // ext が負 (-5) の関数でも、足す値 0 の辺は値を変えない (0 のときは足さない。試作の edge_extra と同じ口)。
            // 期待値は変える前の longest_path_x の写しの値
            let graph = super::adopted_graph();
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let old =
                longest_path_x_before_frames(&graph, &predecessors, &mut |_| Ok(-5.0)).unwrap();
            let extras = vec![
                (Slot::Node(1), Slot::Node(2), 0.0),
                (Slot::Node(2), Slot::Block(0), 0.0),
                (Slot::Block(0), Slot::Node(4), 0.0),
            ];
            let zero = longest_path_x(&graph, &predecessors, &mut |_| Ok(-5.0), &extras).unwrap();
            assert_eq!(sorted_bits(&zero), sorted_bits(&old));
        }

        #[test]
        fn block_depths_longest_path_x_adds_the_extra_of_an_edge() {
            // adopted_graph (幅 1: 40、2: 30、3: 50、4: 0)。ext = 幅 + 16 (幅 > 0) + 80: 1 は 136、2 は 126、3 は 146、4 は 80。
            // 旧: x(1) = 0、x(2) = 136、x(3) = x(4) = 136 + 126 = 262。
            // 2 → 仮の点 p (足す値 8)、p → 4 (0): x(p) = 262 + 8 = 270、x(4) = max(262, 270 + ext(p) 0) = 270
            let graph = super::adopted_graph();
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let options = MARKMAP_DEFAULTS;
            let x = longest_path_x(
                &graph,
                &predecessors,
                &mut |id| Ok(ext(&graph, &options, id)),
                &[
                    (Slot::Node(2), Slot::Block(0), 8.0),
                    (Slot::Block(0), Slot::Node(4), 0.0),
                ],
            )
            .unwrap();
            assert_eq!(x.len(), 4, "仮の点は結果に入らない");
            assert_eq!(x[&1], 0.0);
            assert_eq!(x[&2], 136.0);
            assert_eq!(x[&3], 262.0);
            assert_eq!(x[&4], 270.0);

            // 実のノードどうしの辺 1 → 3 (足す値 200): x(3) = max(262, 0 + 136 + 200) = 336
            let x = longest_path_x(
                &graph,
                &predecessors,
                &mut |id| Ok(ext(&graph, &options, id)),
                &[(Slot::Node(1), Slot::Node(3), 200.0)],
            )
            .unwrap();
            assert_eq!(x[&3], 336.0);
            assert_eq!(x[&4], 262.0);
        }

        #[test]
        fn block_depths_longest_path_x_reports_a_cycle_through_extra_edges() {
            // 3 → 仮の点 → 2 は、2 → 3 (配置上の親) と閉路になる。旧と同じ誤り
            let graph = super::adopted_graph();
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let options = MARKMAP_DEFAULTS;
            let result = longest_path_x(
                &graph,
                &predecessors,
                &mut |id| Ok(ext(&graph, &options, id)),
                &[
                    (Slot::Node(3), Slot::Block(0), 0.0),
                    (Slot::Block(0), Slot::Node(2), 0.0),
                ],
            );
            let Err(error) = result else {
                panic!("閉路なのに値を返した");
            };
            assert_eq!(error.message, "横位置の制約に閉路がある");
        }

        #[test]
        fn block_depths_longest_path_x_reports_a_cycle_whose_nodes_all_have_outside_predecessors() {
            // 閉路 2 → 3 → 仮の点 → 2 の各点に、閉路の外の先行 1 からも辺がある (4 にも 1 から辺を足す)。
            // 変える前の判定 (x に値の入った数 == ノードの数) は、閉路の外から値が入るので閉路を見逃す。
            // 段 3 の閉路 (例 3 の告知を出口にしたとき) はこの形なので、確定した (ready から取り出した) 数で判定する必要がある。
            // 閉路なら誤りを返す (G-003)。設計の「longest_path_x が誤りを返さない」を閉路がないことの確かめに使う
            let graph = super::adopted_graph();
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let options = MARKMAP_DEFAULTS;
            let extras = [
                (Slot::Node(3), Slot::Block(0), 0.0),
                (Slot::Block(0), Slot::Node(2), 0.0),
                (Slot::Node(1), Slot::Node(3), 0.0),
                (Slot::Node(1), Slot::Block(0), 0.0),
                (Slot::Node(1), Slot::Node(4), 0.0),
            ];
            let result = longest_path_x(
                &graph,
                &predecessors,
                &mut |id| Ok(ext(&graph, &options, id)),
                &extras,
            );
            let Err(error) = result else {
                panic!("閉路なのに値を返した");
            };
            assert_eq!(error.message, "横位置の制約に閉路がある");
        }

        #[test]
        fn block_depths_put_the_exit_of_loose_example_1_right_of_the_frame() {
            // 例 1。配置の木: 1 → 2 → Block(copy) → 5 (出口)。copy の中は Joint の子に [3, 4]。level 0 (side 8)。
            // 旧: x(1) = 0、x(2) = 136、x(3) = x(4) = 272、x(5) = 272 + 136 = 408。
            // frame_right(copy) = (272 + 56) + 8 = 336。出口の制約で x(5) ≥ 336 + 80 = 416 (仮の点 p: 272 + 136 + 8 = 416)。
            // start(copy) = x(2) + ext(2) = 272。gap(5) = 416 − 416 = 0
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            let result = depths(graph, frames);
            let copy = result.input.block("copy");
            assert_eq!(result.input.exits(), vec![(Slot::Node(5), copy)]);
            assert_eq!(
                old_planned_x(&result.input.graph, &MARKMAP_DEFAULTS)[&5],
                408.0
            );
            assert_eq!(result.x(1), 0.0);
            assert_eq!(result.x(2), 136.0);
            assert_eq!(result.x(3), 272.0);
            assert_eq!(result.x(4), 272.0);
            assert_eq!(result.x(5), 416.0);
            assert_eq!(result.frame_right("copy"), 336.0);
            assert_eq!(result.start("copy"), 272.0);
            assert_eq!(result.gap(5), 0.0);
            assert_eq!(result.gap(3), 0.0);
            assert_eq!(result.gap(4), 0.0);
        }

        #[test]
        fn block_depths_put_the_exit_of_loose_example_2_right_of_the_frame() {
            // 例 2: 1 root / 2 開発 / 3 画面、4 決済 (開発の子) / 5 脆弱性診断 / 6 本番反映。開発 --> 5 --> 6。security = {4, 5}。
            // x(2) = 136、x(3) = x(4) = x(5) = 272、旧 x(6) = 408。frame_right(security) = 272 + 56 + 8 = 336。
            // x(6) ≥ 336 + 80 = 416。start(security) = 136 + 136 = 272
            let graph = graph_of(
                6,
                &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6)],
                &[(2, 5), (5, 6)],
                &[5, 6],
            );
            let frames = frames_of(
                &graph,
                &["security"],
                &[(4, &["security"]), (5, &["security"])],
            );
            let result = depths(graph, frames);
            let security = result.input.block("security");
            assert_eq!(result.input.exits(), vec![(Slot::Node(6), security)]);
            assert_eq!(result.x(3), 272.0);
            assert_eq!(result.x(5), 272.0);
            assert_eq!(result.x(6), 416.0);
            assert_eq!(result.frame_right("security"), 336.0);
            assert_eq!(result.start("security"), 272.0);
            assert_eq!(result.gap(6), 0.0);
        }

        #[test]
        fn block_depths_notation_puts_the_build_block_and_the_verification_right_of_the_frames() {
            // notation_like。d = {3, 4, 5}、b = {6..=13}、どちらも level 0 (side 8)。出口: Block(b) は d の、14 は b の。
            // x(1) = 0、x(2) = x(3) = 136、x(4) = x(5) = 272 (3 と 2 の fork から)。
            // frame_right(d) = 272 + 56 + 8 = 336。実装 6 (b の根) ≥ 336 + 80 = 416 (旧は 272)。start(b) = 416。
            // b の中: x(7) = x(11) = 552、x(8) = x(10) = x(12) = x(13) = 688、x(9) = max(552 + 136、12 の depends 688 + 136) = 824。
            // frame_right(b) = (824 + 56) + 8 = 888。検証 14 ≥ 888 + 80 = 968 (旧の制約だけなら 824)。x(15) = x(16) = 1104。
            // start(d) = x(1) + ext(1) = 136。gap(14) = 0、gap(9) = 824 − (552 + 136) = 136
            let graph = notation_like_graph();
            let frames = notation_like_frames(&graph);
            let result = depths(graph, frames);
            let d = result.input.block("d");
            let b = result.input.block("b");
            assert_eq!(result.input.exits().len(), 2);
            assert_eq!(
                result.input.tree.exits.get(&Slot::Block(b)),
                Some(&Exit { block: d, from: 3 })
            );
            assert_eq!(
                result.input.tree.exits.get(&Slot::Node(14)),
                Some(&Exit { block: b, from: 10 })
            );
            assert_eq!(result.x(3), 136.0);
            assert_eq!(result.x(4), 272.0);
            assert_eq!(result.frame_right("d"), 336.0);
            assert_eq!(result.start("d"), 136.0);
            assert_eq!(result.x(6), 416.0);
            assert_eq!(result.start("b"), 416.0);
            assert_eq!(result.x(7), 552.0);
            assert_eq!(result.x(11), 552.0);
            assert_eq!(result.x(10), 688.0);
            assert_eq!(result.x(13), 688.0);
            assert_eq!(result.x(9), 824.0);
            assert_eq!(result.frame_right("b"), 888.0);
            assert_eq!(result.x(14), 968.0);
            assert_eq!(result.x(15), 1104.0);
            assert_eq!(result.x(16), 1104.0);
            assert_eq!(result.gap(6), 0.0);
            assert_eq!(result.gap(14), 0.0);
            assert_eq!(result.gap(9), 136.0);
            // b のメンバーはどれも b の start より右 (build の箱が design の枠の右にある)
            for id in 6..=13 {
                assert!(result.x(id) >= result.start("b"));
            }
        }

        #[test]
        fn block_depths_exit_unit_block_with_two_roots_starts_right_of_the_frame() {
            // A-4 の入力: 1 root / 2 設計 %design / 3 画面、4 API / 5 告知A %notice / 6 周知 / 7 告知B %notice。
            // 画面 --> 告知A、API --> 周知、画面 --> 告知B。design の箱の子は [Block(notice), 周知]。
            // x(2) = 136、x(3) = x(4) = 272。frame_right(design) = 272 + 56 + 8 = 336。
            // 仮の点は 1 つで、根 5、7 と 6 に 0 の辺: x(5) = x(6) = x(7) = 416 (旧は 408)。
            // start(notice) = 416 (出口の子の箱)。frame_right(notice) = 416 + 56 + 8 = 480。
            // 5、7 の配置の木の親は Joint(notice) なので gap は start(notice) から測って 0
            // 出口の単位が箱で、その side が spacing_horizontal より大きいときは、枠の左の辺が移し先の枠に食い込まないよう、
            // 移し先の仮の点 → 根に根の余白の差 (side − spacing_horizontal) を足す (段 3 の実装で決めた)。この入力は side 8 < 80 で差がない
            let graph = graph_of(
                7,
                &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
                &[(3, 5), (4, 6), (3, 7)],
                &[5, 6, 7],
            );
            let frames = frames_of(
                &graph,
                &["design", "notice"],
                &[
                    (2, &["design"]),
                    (3, &["design"]),
                    (4, &["design"]),
                    (5, &["notice"]),
                    (7, &["notice"]),
                ],
            );
            let result = depths(graph, frames);
            let design = result.input.block("design");
            let notice = result.input.block("notice");
            assert_eq!(
                result.input.tree.exits.get(&Slot::Block(notice)),
                Some(&Exit {
                    block: design,
                    from: 3
                })
            );
            assert_eq!(result.frame_right("design"), 336.0);
            assert_eq!(result.x(5), 416.0);
            assert_eq!(result.x(6), 416.0);
            assert_eq!(result.x(7), 416.0);
            assert_eq!(result.start("notice"), 416.0);
            assert_eq!(result.frame_right("notice"), 480.0);
            assert_eq!(result.gap(5), 0.0);
            assert_eq!(result.gap(6), 0.0);
            assert_eq!(result.gap(7), 0.0);
        }

        #[test]
        fn block_depths_same_members_share_the_start_of_the_outer_block() {
            // B-5 の入力: nested-groups で a と b はどちらも {3, 4, 5}。a が外 (level 1、side 30)、b が内 (level 0、side 8)。
            // a の中の木の根は Block(b)、b の中の木の根は 3。start(a) = x(2) + ext(2) = 136 + 136 = 272、start(b) = start(a) = 272。
            // 箱の中の根 3 の深さも 272 (side 30 < 80 なので根の余白の差は足さない)。
            // frame_right(b) = (408 + 56) + 8 = 472、frame_right(a) = 464 + 30 = 494。出口はないので planned_x は旧と同じ
            let graph = nested();
            let all: &[&str] = &["a", "b"];
            let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all), (5, all)]);
            let expected_x = old_planned_x(&graph, &MARKMAP_DEFAULTS);
            let result = depths(graph, frames);
            let a = result.input.block("a");
            let b = result.input.block("b");
            assert_eq!(result.input.tree.inner[a].0, Slot::Block(b));
            assert_eq!(result.input.blocks.blocks[a].level, 1);
            assert_eq!(result.input.blocks.blocks[b].level, 0);
            assert_eq!(result.start("a"), 272.0);
            assert_eq!(result.start("b"), 272.0);
            assert_eq!(result.x(3), 272.0);
            assert_eq!(result.x(3), result.start("b"));
            assert_eq!(result.gap(3), 0.0);
            assert_eq!(result.frame_right("b"), 472.0);
            assert_eq!(result.frame_right("a"), 494.0);
            assert_eq!(
                sorted_bits(&result.plan.planned_x),
                sorted_bits(&expected_x)
            );
        }

        #[test]
        fn block_depths_nested_two_levels_exit_to_the_inner_frame() {
            // 入れ子 2 段: dev = {2..=6} (level 1、side 30)、design = {3, 4, 5} (level 0、side 8)。告知 6 は dev のメンバーで
            // design のメンバーでないので design の出口の子 (dev の中にいる)。
            // x(2) = 136、x(3) = 272、x(4) = x(5) = 408、旧 x(6) = 408。frame_right(design) = 408 + 56 + 8 = 472。
            // x(6) ≥ 472 + 80 = 552。frame_right(dev) = (552 + 56) + 30 = 638。start(dev) = 136、start(design) = 272
            let graph = nested_exit_graph();
            let frames = frames_of(
                &graph,
                &["dev", "design"],
                &[
                    (2, &["dev"]),
                    (3, &["dev", "design"]),
                    (4, &["dev", "design"]),
                    (5, &["dev", "design"]),
                    (6, &["dev"]),
                ],
            );
            let result = depths(graph, frames);
            let design = result.input.block("design");
            assert_eq!(result.input.exits(), vec![(Slot::Node(6), design)]);
            assert_eq!(result.frame_right("design"), 472.0);
            assert_eq!(result.x(6), 552.0);
            assert_eq!(result.gap(6), 0.0);
            assert_eq!(result.frame_right("dev"), 638.0);
            assert_eq!(result.start("dev"), 136.0);
            assert_eq!(result.start("design"), 272.0);
        }

        #[test]
        fn block_depths_nested_two_levels_exit_to_the_outer_frame() {
            // 告知 6 がどちらのメンバーでもない: 移し先は dev (いちばん外側)。dev = {2..=5} (level 1、side 30)。
            // frame_right(dev) = (408 + 56) + 30 = 494。x(6) ≥ 494 + 80 = 574。design の枠の右 (472 + 80 = 552) よりも右
            let graph = nested_exit_graph();
            let frames = frames_of(
                &graph,
                &["dev", "design"],
                &[
                    (2, &["dev"]),
                    (3, &["dev", "design"]),
                    (4, &["dev", "design"]),
                    (5, &["dev", "design"]),
                ],
            );
            let result = depths(graph, frames);
            let dev = result.input.block("dev");
            assert_eq!(result.input.exits(), vec![(Slot::Node(6), dev)]);
            assert_eq!(result.frame_right("dev"), 494.0);
            assert_eq!(result.frame_right("design"), 472.0);
            assert_eq!(result.x(6), 574.0);
            assert_eq!(result.gap(6), 0.0);
        }

        #[test]
        fn block_depths_nested_three_levels_exit_to_the_middle_frame() {
            // 入れ子 3 段: hq = {2..=7} (level 2、side 52)、dev = {3..=6} (level 1、side 30)、design = {4, 5, 6} (level 0、side 8)。
            // 告知 7 は hq だけのメンバー。u = 設計 4 を含み告知を含まない箱は design と dev なので、移し先は dev。
            // x(2) = 136、x(3) = 272、x(4) = 408、x(5) = x(6) = 544、旧 x(7) = 544。
            // frame_right(design) = (544 + 56) + 8 = 608、frame_right(dev) = 600 + 30 = 630。x(7) ≥ 630 + 80 = 710。
            // frame_right(hq) = (710 + 56) + 52 = 818。start: hq 136、dev 272、design 408
            let graph = three_levels_graph();
            let frames = frames_of(
                &graph,
                &["hq", "dev", "design"],
                &[
                    (2, &["hq"]),
                    (3, &["hq", "dev"]),
                    (4, &["hq", "dev", "design"]),
                    (5, &["hq", "dev", "design"]),
                    (6, &["hq", "dev", "design"]),
                    (7, &["hq"]),
                ],
            );
            assert_eq!(
                members_of(&frames),
                vec![
                    ("hq".to_string(), vec![2, 3, 4, 5, 6, 7]),
                    ("dev".to_string(), vec![3, 4, 5, 6]),
                    ("design".to_string(), vec![4, 5, 6])
                ]
            );
            let result = depths(graph, frames);
            let dev = result.input.block("dev");
            assert_eq!(result.input.exits(), vec![(Slot::Node(7), dev)]);
            assert_eq!(result.frame_right("design"), 608.0);
            assert_eq!(result.frame_right("dev"), 630.0);
            assert_eq!(result.x(7), 710.0);
            assert_eq!(result.gap(7), 0.0);
            assert_eq!(result.frame_right("hq"), 818.0);
            assert_eq!(result.start("hq"), 136.0);
            assert_eq!(result.start("dev"), 272.0);
            assert_eq!(result.start("design"), 408.0);
        }

        #[test]
        fn block_depths_nested_three_levels_exit_to_the_outermost_frame() {
            // 告知 7 がどのメンバーでもない: 移し先は hq。hq = {2..=6} (level 2、side 52)。
            // frame_right(hq) = (544 + 56) + 52 = 652。x(7) ≥ 652 + 80 = 732
            let graph = three_levels_graph();
            let frames = frames_of(
                &graph,
                &["hq", "dev", "design"],
                &[
                    (2, &["hq"]),
                    (3, &["hq", "dev"]),
                    (4, &["hq", "dev", "design"]),
                    (5, &["hq", "dev", "design"]),
                    (6, &["hq", "dev", "design"]),
                ],
            );
            let result = depths(graph, frames);
            let hq = result.input.block("hq");
            assert_eq!(result.input.exits(), vec![(Slot::Node(7), hq)]);
            assert_eq!(result.frame_right("hq"), 652.0);
            assert_eq!(result.x(7), 732.0);
            assert_eq!(result.gap(7), 0.0);
        }

        #[test]
        fn block_depths_spacing_10_keeps_the_frame_left_edge_off_the_parent_body() {
            // nested-groups: dev = {2..=8} (level 1、side 30)、frontend = {3, 4, 5}、backend = {6, 7, 8} (level 0、side 8)。
            // spacing_horizontal = 10: ext = 56 + 10 = 66。dev の根 2 (親 1) に side − spacing = 30 − 10 = 20 を足す。
            // x(1) = 0、x(2) = 0 + 66 + 20 = 86。親の本体の右の端 56 から 86 − 56 = 30 (= side) 離れる。
            // frontend と backend の side 8 は 10 より小さいので足さない: x(3) = x(6) = 86 + 66 = 152、x(4) = x(5) = x(7) = x(8) = 218。
            // x(9) = 66。frame_right(dev) = (218 + 56) + 30 = 304、frame_right(frontend) = 274 + 8 = 282。
            // start(dev) = 66、start(frontend) = start(backend) = 86 + 66 = 152。gap(2) = 86 − 66 = 20
            let graph = nested();
            let frames = frames_of(
                &graph,
                &["dev", "backend", "frontend"],
                &[
                    (2, &["dev"]),
                    (3, &["dev", "frontend"]),
                    (4, &["dev", "frontend"]),
                    (5, &["dev", "frontend"]),
                    (6, &["dev", "backend"]),
                    (7, &["dev", "backend"]),
                    (8, &["dev", "backend"]),
                ],
            );
            let result = depths_with(graph, frames, with_spacing(10.0));
            let dev = result.input.block("dev");
            assert_eq!(result.input.blocks.blocks[dev].level, 1);
            assert_eq!(frame_padding(1).side, 30.0);
            let parent_body_right = result.x(1) + 56.0;
            assert!(result.x(2) - parent_body_right >= frame_padding(1).side);
            assert_eq!(result.x(2), 86.0);
            assert_eq!(result.x(3), 152.0);
            assert_eq!(result.x(6), 152.0);
            assert_eq!(result.x(4), 218.0);
            assert_eq!(result.x(8), 218.0);
            assert_eq!(result.x(9), 66.0);
            assert_eq!(result.frame_right("dev"), 304.0);
            assert_eq!(result.frame_right("frontend"), 282.0);
            assert_eq!(result.start("dev"), 66.0);
            assert_eq!(result.start("frontend"), 152.0);
            assert_eq!(result.start("backend"), 152.0);
            assert_eq!(result.gap(2), 20.0);
            assert_eq!(result.gap(3), 0.0);
        }

        #[test]
        fn block_depths_spacing_10_separates_the_roots_of_each_level_by_its_side() {
            // 入れ子 3 段 (hq level 2 side 52、dev level 1 side 30、design level 0 side 8)、spacing_horizontal = 10、ext = 66。
            // 根の余白の差: hq の根 2 に 52 − 10 = 42、dev の根 3 に 30 − 10 = 20、design の根 4 は 8 < 10 なので足さない。
            // x(2) = 0 + 66 + 42 = 108、x(3) = 108 + 66 + 20 = 194、x(4) = 194 + 66 = 260、x(5) = x(6) = 326。
            // 告知 7 は dev の出口: frame_right(dev) = (326 + 56) + 30 = 412、x(7) ≥ 412 + 10 = 422。
            // どの根も親の本体の右の端から、その箱の side 以上離れる (design の根 4 は 260 − 250 = 10 ≥ 8)
            let graph = three_levels_graph();
            let frames = frames_of(
                &graph,
                &["hq", "dev", "design"],
                &[
                    (2, &["hq"]),
                    (3, &["hq", "dev"]),
                    (4, &["hq", "dev", "design"]),
                    (5, &["hq", "dev", "design"]),
                    (6, &["hq", "dev", "design"]),
                    (7, &["hq"]),
                ],
            );
            let result = depths_with(graph, frames, with_spacing(10.0));
            assert_eq!(result.x(2), 108.0);
            assert_eq!(result.x(3), 194.0);
            assert_eq!(result.x(4), 260.0);
            assert_eq!(result.x(5), 326.0);
            assert_eq!(result.frame_right("dev"), 412.0);
            assert_eq!(result.x(7), 422.0);
            for (group, root, parent) in [("hq", 2, 1), ("dev", 3, 2), ("design", 4, 3)] {
                let level = result.input.blocks.blocks[result.input.block(group)].level;
                assert!(
                    result.x(root) - (result.x(parent) + 56.0) >= frame_padding(level).side,
                    "{group} の根 {root}"
                );
            }
        }

        #[test]
        fn block_depths_fallback_of_example_3_keeps_its_old_depth() {
            // 例 3: 告知 5 は後戻りし (fallbacks)、配置の木の親はルート 1。出口の制約は足さないので planned_x は旧と同じ:
            // x(2) = 136、x(3) = 272、x(5) = 408、x(4) = max(272、5 の 408 + 136) = 544。閉路はない (誤りを返さない)。
            // gap は配置の木の親の右の端から測る: gap(5) = 408 − (0 + 136) = 272 (旧は L0 の親 3 から測って 0)。
            // frame_right(design) = (544 + 56) + 8 = 608
            let (graph, frames) = example3();
            let expected_x = old_planned_x(&graph, &MARKMAP_DEFAULTS);
            let result = depths(graph, frames);
            assert_eq!(result.input.tree.fallbacks, vec![Slot::Node(5)]);
            assert!(result.input.tree.exits.is_empty());
            assert_eq!(
                result.input.tree.parent_of.get(&Slot::Node(5)),
                Some(&Slot::Node(1))
            );
            assert_eq!(
                sorted_bits(&result.plan.planned_x),
                sorted_bits(&expected_x)
            );
            assert_eq!(result.x(5), 408.0);
            assert_eq!(result.x(4), 544.0);
            assert_eq!(result.gap(5), 272.0);
            assert_eq!(result.gap(4), 272.0);
            assert_eq!(result.frame_right("design"), 608.0);
            assert_eq!(result.start("design"), 136.0);
        }

        #[test]
        fn block_depths_review_b_1_has_no_cycle_after_the_fallback() {
            // B-1 の入力: 1 root / 2 設計 %design (3 画面、4 API) / 5 告知 / 6 運用 %ops (7 監視、8 手順) / 9 連絡。
            // 画面 --> 告知 --> 手順、監視 --> 連絡 --> API。告知は design の出口、連絡は後戻り。
            // x(2) = x(6) = 136、x(3) = x(7) = 272、x(9) = 408、x(4) = max(272、408 + 136) = 544。
            // frame_right(design) = (544 + 56) + 8 = 608。x(5) ≥ 608 + 80 = 688。x(8) = max(6 の 272、告知の 688 + 136) = 824。
            // frame_right(ops) = (824 + 56) + 8 = 888。gap(9) = 408 − 136 = 272 (親はルート)
            let graph = graph_of(
                9,
                &[
                    (1, 2),
                    (2, 3),
                    (2, 4),
                    (1, 5),
                    (1, 6),
                    (6, 7),
                    (6, 8),
                    (1, 9),
                ],
                &[(3, 5), (5, 8), (7, 9), (9, 4)],
                &[5, 9],
            );
            assert_no_excluded_relations(&graph);
            let frames = frames_of(
                &graph,
                &["design", "ops"],
                &[
                    (2, &["design"]),
                    (3, &["design"]),
                    (4, &["design"]),
                    (6, &["ops"]),
                    (7, &["ops"]),
                    (8, &["ops"]),
                ],
            );
            let result = depths(graph, frames);
            let design = result.input.block("design");
            assert_eq!(result.input.exits(), vec![(Slot::Node(5), design)]);
            assert_eq!(result.input.tree.fallbacks, vec![Slot::Node(9)]);
            assert_eq!(result.x(9), 408.0);
            assert_eq!(result.x(4), 544.0);
            assert_eq!(result.frame_right("design"), 608.0);
            assert_eq!(result.x(5), 688.0);
            assert_eq!(result.x(8), 824.0);
            assert_eq!(result.frame_right("ops"), 888.0);
            assert_eq!(result.gap(9), 272.0);
            assert_eq!(result.gap(5), 0.0);
        }

        #[test]
        fn block_depths_fallback_under_a_joint_measures_from_the_block_start() {
            // B-2 の入力: 1 root / 2 設計 %team %design (3 画面 (4 下書き)、5 API) / 6 付録 / 7 告知 %team。画面 --> 告知 --> API。
            // 告知は後戻りし、team の中の木は Joint(team) の子に [Block(design), 告知]。
            // x(2) = 136、x(3) = 272、x(4) = x(7) = 408、x(5) = max(272、408 + 136) = 544。
            // start(team) = 0 + 136 = 136。Joint の子の design と告知は team の start から: start(design) = 136、gap(7) = 408 − 136 = 272。
            // frame_right(design) = (544 + 56) + 8 = 608、frame_right(team) = 600 + 30 = 630
            let graph = graph_of(
                7,
                &[(1, 2), (2, 3), (3, 4), (2, 5), (1, 6), (1, 7)],
                &[(3, 7), (7, 5)],
                &[7],
            );
            assert_no_excluded_relations(&graph);
            let both: &[&str] = &["team", "design"];
            let frames = frames_of(
                &graph,
                &["team", "design"],
                &[(2, both), (3, both), (4, both), (5, both), (7, &["team"])],
            );
            let result = depths(graph, frames);
            let team = result.input.block("team");
            assert_eq!(result.input.tree.fallbacks, vec![Slot::Node(7)]);
            assert_eq!(result.input.tree.inner[team].0, Slot::Joint(team));
            assert_eq!(result.x(7), 408.0);
            assert_eq!(result.x(5), 544.0);
            assert_eq!(result.start("team"), 136.0);
            assert_eq!(result.start("design"), 136.0);
            assert_eq!(result.gap(7), 272.0);
            assert_eq!(result.gap(2), 0.0);
            assert_eq!(result.frame_right("design"), 608.0);
            assert_eq!(result.frame_right("team"), 630.0);
        }

        #[test]
        fn block_depths_cycle_in_a_hand_built_placement_is_an_error() {
            // 段 2 は閉路になる出口を後戻りさせる。その前提が崩れた入力 (例 3 の告知 5 を手で design の出口に戻す) では、
            // 制約が design のメンバー → 仮の点 → 5 → API 4 (design のメンバー) の閉路になり、panic せずに誤りを返す。
            // この閉路の点 (メンバー、仮の点、5) はどれも閉路の外 (1、2、3) からも値が入るので、変える前の判定では見逃す
            // (block_depths_longest_path_x_reports_a_cycle_whose_nodes_all_have_outside_predecessors)。
            // 段 3 で閉路が出たら、panic せずに longest_path_x の既存の誤り (同じ文面) を返す (G-003)
            let (graph, frames) = example3();
            let mut input = prepare(graph, frames, MARKMAP_DEFAULTS);
            let design = input.block("design");
            let tree = &mut input.tree;
            assert_eq!(tree.fallbacks, vec![Slot::Node(5)]);
            tree.fallbacks.clear();
            tree.children
                .get_mut(&Slot::Node(1))
                .unwrap()
                .retain(|slot| *slot != Slot::Node(5));
            tree.children
                .entry(Slot::Block(design))
                .or_default()
                .push(Slot::Node(5));
            tree.parent_of.insert(Slot::Node(5), Slot::Block(design));
            tree.exits.insert(
                Slot::Node(5),
                Exit {
                    block: design,
                    from: 3,
                },
            );
            let Err(error) = input.run() else {
                panic!("閉路なのに値を返した");
            };
            assert_eq!(error.message, "横位置の制約に閉路がある");
        }

        #[test]
        fn block_depths_frame_containing_the_root() {
            // 全部のノードが 1 つのグループ (level 0)。配置の木の根は Block(all) で親がない。出口はないので planned_x は旧と同じ。
            // frame_right(all) = (408 + 56) + 8 = 472
            // 親のない箱の start は 0 で、その中の根 1 の gap は planned_x − 0 (旧と同じ。段 3 の実装で決めた)
            let graph = nested();
            let entries: Vec<(u32, &[&str])> = (1..=9).map(|id| (id, &["all"][..])).collect();
            let frames = frames_of(&graph, &["all"], &entries);
            let expected_x = old_planned_x(&graph, &MARKMAP_DEFAULTS);
            let result = depths(graph, frames);
            let all = result.input.block("all");
            assert_eq!(result.input.tree.root, Slot::Block(all));
            assert_eq!(
                sorted_bits(&result.plan.planned_x),
                sorted_bits(&expected_x)
            );
            assert_eq!(result.frame_right("all"), 472.0);
            assert_eq!(result.start("all"), 0.0);
            assert_eq!(result.gap(1), result.x(1));
            assert_eq!(result.gap(2), 0.0);
        }

        #[test]
        fn block_depths_many_exits_share_one_virtual_point() {
            // A-5 の入力を N で: 1 root / 2 設計 %design / 3..=N+2 項目k (設計の子) / N+3..=2N+2 告知k (項目k --> 告知k)。
            // 告知はすべて design の出口の子。仮の点が 1 つなので足す辺は「メンバー N + 1 本 + 出口 N 本」で、N × N にならない。
            // x(項目) = 272、frame_right(design) = 272 + 56 + 8 = 336、x(告知) = 416。
            // TODO(spec): 辺の数そのものは DepthPlan に出ないので、block_depths だけの時間 (debug で 1 秒以内) で見る。
            // N = 5000 で掛け算なら 2500 万の辺になり 1 秒に収まらない見込み
            let count = 5000u32;
            let items: Vec<u32> = (3..count + 3).collect();
            let notices: Vec<u32> = (count + 3..2 * count + 3).collect();
            let mut tree: Vec<(u32, u32)> = vec![(1, 2)];
            tree.extend(items.iter().map(|&item| (2, item)));
            tree.extend(notices.iter().map(|&notice| (1, notice)));
            let chain: Vec<(u32, u32)> =
                items.iter().copied().zip(notices.iter().copied()).collect();
            let graph = graph_of(2 * count + 2, &tree, &chain, &notices);
            let mut entries: Vec<(u32, &[&str])> = vec![(2, &["design"][..])];
            entries.extend(items.iter().map(|&item| (item, &["design"][..])));
            let frames = frames_of(&graph, &["design"], &entries);
            let input = prepare(graph, frames, MARKMAP_DEFAULTS);
            assert_eq!(input.tree.exits.len(), count as usize);
            let begin = Instant::now();
            let plan = match input.run() {
                Ok(plan) => plan,
                Err(error) => panic!("{}", error.message),
            };
            let elapsed = begin.elapsed();
            assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
            check_plan(&input, &plan);
            assert_eq!(plan.blocks[input.block("design")].frame_right, 336.0);
            for &notice in &notices {
                assert_eq!(plan.planned_x[&notice], 416.0);
                assert_eq!(plan.gap_of[&notice], 0.0);
            }
        }

        #[test]
        fn block_depths_deep_tree_does_not_overflow_the_stack() {
            // 深さ 20000 の 1 本の木 (1 → 2 → … → 20000)。f = {10, 11} (level 0)。12 は f の出口の子。1 MiB のスタックで回す。
            // x(k) = (k − 1) × 136 (k ≤ 11): x(10) = 1224、x(11) = 1360。frame_right(f) = 1360 + 56 + 8 = 1424。
            // x(12) = 1424 + 80 = 1504 (旧は 1496)。以降 136 ずつ: x(20000) = 1504 + (20000 − 12) × 136 = 2719872
            let length = 20_000u32;
            let result = std::thread::Builder::new()
                .stack_size(1 << 20)
                .spawn(move || {
                    let tree: Vec<(u32, u32)> = (1..length).map(|id| (id, id + 1)).collect();
                    let graph = graph_of(length, &tree, &[], &[]);
                    let frames = frames_of(&graph, &["f"], &[(10, &["f"]), (11, &["f"])]);
                    let result = depths(graph, frames);
                    (
                        result.input.exits().len(),
                        result.frame_right("f"),
                        result.x(12),
                        result.x(length),
                        result.gap(12),
                    )
                })
                .unwrap()
                .join()
                .unwrap();
            assert_eq!(result, (1, 1424.0, 1504.0, 2_719_872.0, 0.0));
        }

        #[test]
        fn block_depths_deep_nesting_does_not_overflow_the_stack() {
            // 同じ 2 つのメンバー (3、4) の枠 2000 個は 1 本の鎖に入れ子になる (段 1、段 2)。各箱の中の木の根は 1 つ内側の Block。
            // 5 はいちばん外側の箱の出口の子。1 MiB のスタックで回す。
            // start はどれも x(2) + ext(2) = 272 (いちばん外側の親は 2、ほかは包む箱の中の根。B-5)。
            // いちばん外側の side は 8 + 1999 × 22 = 43986 で spacing_horizontal より大きいので、根 3 は親の本体の右の端から
            // side 以上離れる。5 は frame_right(いちばん外側) + 80 以上
            // 根 3 は 2000 個の箱の根。足す差は箱ごとではなく、いちばん大きいもの (いちばん外側の side − spacing_horizontal) だけ
            // (段 3 の実装で決めた。試作と同じ) なので、根 3 は親の本体の右の端からちょうど side 離れる
            let count = 2000u32;
            let result = std::thread::Builder::new()
                .stack_size(1 << 20)
                .spawn(move || {
                    let graph = nested();
                    let groups: Vec<GroupDef> =
                        (0..count).map(|i| group(&format!("g{i}"))).collect();
                    let ids: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
                    let groups_of: IndexMap<u32, Vec<String>> = (1..=9)
                        .map(|id| {
                            (
                                id,
                                if [3, 4].contains(&id) {
                                    ids.clone()
                                } else {
                                    Vec::new()
                                },
                            )
                        })
                        .collect();
                    let frames =
                        compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
                    let result = depths(graph, frames);
                    let blocks = &result.input.blocks.blocks;
                    let outermost = (0..blocks.len())
                        .find(|&index| blocks[index].level == count - 1)
                        .unwrap();
                    let starts_equal = result.plan.blocks.iter().all(|depth| depth.start == 272.0);
                    (
                        blocks.len(),
                        starts_equal,
                        result.x(3) - (result.x(2) + 56.0),
                        frame_padding(count - 1).side,
                        result.x(5) - (result.plan.blocks[outermost].frame_right + 80.0),
                        result.input.exits(),
                        outermost,
                    )
                })
                .unwrap()
                .join()
                .unwrap();
            let (len, starts_equal, root_offset, side, exit_offset, exits, outermost) = result;
            assert_eq!(len, count as usize);
            assert!(starts_equal);
            assert_eq!(side, 43986.0);
            assert_eq!(root_offset, side);
            assert!(exit_offset >= 0.0);
            assert_eq!(exits, vec![(Slot::Node(5), outermost)]);
        }
    }

    // 段 4 (兄弟の方向の位置、箱の配置) の入口 layout_graph_framed の単体テスト。期待値は design.md の「段 4」と「3. 守る不変条件」から導く。
    // 仮定したシグネチャ (引数の並びは設計の `layout_graph_framed(graph, options, extra_spacing, children_of, frames, blocks)` のとおり。
    // 型と戻り値は設計に書かれていないので、layout_graph_with_extra_spacing と段 1〜3 の型に合わせて仮定):
    //     pub fn layout_graph_framed(graph: &VisibleGraph, options: Option<LayoutOptions>,
    //                                extra_spacing: Option<&mut dyn FnMut(u32, u32) -> f64>,
    //                                children_of: &IndexMap<u32, Vec<u32>>, frames: &[Frame], blocks: &FrameBlocks)
    //         -> Result<LayoutResult, LayoutError>
    //     extra_spacing は layout_graph_with_extra_spacing と同じ意味 (上のノード、下のノードの順で受け、足す値を返す)。
    //     段 5 は loose の枠だけの between を渡す (設計の段 5 の 5)。このテストは値を返す関数を直に渡す。
    // 入力は段 1〜3 の本物の関数 (project、compute_frames、layout_children_of、frame_blocks) で作り、段 2、段 3 は入口の中で呼ばれる。
    // 数値の約束: ノードは幅 40、高さ 20。既定の options (padding_x 8、spacing_horizontal 80、spacing_vertical 5、
    //     線の太さ 1 + 3 / 2^depth) で本体 = 56、ext = 136。depth はルートが 1 (VisibleNode.depth)。
    //     depth 2 の線は 1.75、depth 3 は 1.375。同じ親の兄弟の spacing は 5 + 線の太さ (上のノードの depth)。
    //     frame_padding(level) は四辺とも 8 + 22 × level、LABEL_HEIGHT は 14。
    // 不変条件は design.md の 3 章の定義 (許容 0.5、「重なる」は x と y の重なりの幅がどちらも 0.5 を超える、枠の矩形は outline を上へ
    // LABEL_HEIGHT 広げたもの) で check_invariants が確かめる。箱にした枠は 0 を assert し、loose の枠が関わるものは数えて返すだけ。
    mod framed {
        use std::collections::{HashMap, HashSet, VecDeque};

        use indexmap::IndexMap;

        use crate::layout::frames::{
            Frame, FrameBlocks, LABEL_HEIGHT, compute_frames, frame_blocks, frame_outline,
        };
        use crate::layout::layout::{
            LayoutOptions, LayoutResult, MARKMAP_DEFAULTS, block_depths, layout_children_of,
            layout_graph, layout_graph_framed, layout_graph_with_extra_spacing,
            layout_predecessors,
        };
        use crate::layout::placement::{Slot, placement_tree};
        use crate::layout::project::{VisibleEdgeKind, VisibleGraph, project};
        use crate::types::{
            GroupDef, LayoutError, LayoutInput, LayoutInputEdge, LayoutInputNode,
            LayoutInputRelation, Rect, RelationKind,
        };

        const NESTED_TREE: [(u32, u32); 8] = [
            (1, 2),
            (2, 3),
            (3, 4),
            (3, 5),
            (2, 6),
            (6, 7),
            (6, 8),
            (1, 9),
        ];

        fn group(id: &str) -> GroupDef {
            GroupDef {
                id: id.to_string(),
                label: id.to_string(),
                color: Some("#888".to_string()),
                boundary: true,
                defined: true,
                icon: None,
            }
        }

        fn groups_of(entries: &[(u32, &[&str])]) -> IndexMap<u32, Vec<String>> {
            entries
                .iter()
                .map(|(id, groups)| (*id, groups.iter().map(|g| g.to_string()).collect()))
                .collect()
        }

        // ノードの id は base + 1..=count (1 がルート、幅 40、高さ 20)。tree と relations は 1 始まりの番号で書き、base を足す。
        // 付け替え (配置上の親) は project が決める
        fn graph_with_base(
            base: u32,
            count: u32,
            tree: &[(u32, u32)],
            relations: &[(RelationKind, u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            project(&LayoutInput {
                name: "layout-graph-framed".to_string(),
                nodes: (1..=count)
                    .map(|id| LayoutInputNode {
                        id: base + id,
                        label: format!("n{id}"),
                        width: 40.0,
                        height: 20.0,
                        groups: Vec::new(),
                    })
                    .collect(),
                tree_edges: tree
                    .iter()
                    .map(|&(source, target)| LayoutInputEdge {
                        source: base + source,
                        target: base + target,
                    })
                    .collect(),
                relations: relations
                    .iter()
                    .map(|&(kind, source, target)| LayoutInputRelation {
                        source: base + source,
                        target: base + target,
                        kind,
                        origin: format!("{source} --> {target}"),
                    })
                    .collect(),
                suppress_root_line: suppress.iter().map(|id| base + id).collect(),
                folded: Vec::new(),
            })
            .unwrap()
        }

        fn graph_with(
            count: u32,
            tree: &[(u32, u32)],
            relations: &[(RelationKind, u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            graph_with_base(0, count, tree, relations, suppress)
        }

        fn graph_of(
            count: u32,
            tree: &[(u32, u32)],
            chain: &[(u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            let relations: Vec<(RelationKind, u32, u32)> = chain
                .iter()
                .map(|&(source, target)| (RelationKind::Chain, source, target))
                .collect();
            graph_with(count, tree, &relations, suppress)
        }

        fn nested() -> VisibleGraph {
            graph_of(9, &NESTED_TREE, &[], &[])
        }

        fn frames_of(graph: &VisibleGraph, ids: &[&str], entries: &[(u32, &[&str])]) -> Vec<Frame> {
            let groups: Vec<GroupDef> = ids.iter().map(|id| group(id)).collect();
            compute_frames(
                graph,
                &groups,
                &groups_of(entries),
                &layout_children_of(graph),
            )
        }

        fn members_of(frames: &[Frame]) -> Vec<(String, Vec<u32>)> {
            frames
                .iter()
                .map(|frame| (frame.group.id.clone(), frame.members.clone()))
                .collect()
        }

        fn with_spacing(spacing_horizontal: f64) -> LayoutOptions {
            LayoutOptions {
                spacing_horizontal,
                ..MARKMAP_DEFAULTS
            }
        }

        struct Case {
            graph: VisibleGraph,
            options: LayoutOptions,
            children_of: IndexMap<u32, Vec<u32>>,
            frames: Vec<Frame>,
            blocks: FrameBlocks,
        }

        fn case_with(graph: VisibleGraph, frames: Vec<Frame>, options: LayoutOptions) -> Case {
            let children_of = layout_children_of(&graph);
            let blocks = frame_blocks(&graph, &frames, &children_of);
            Case {
                graph,
                options,
                children_of,
                frames,
                blocks,
            }
        }

        fn make_case(graph: VisibleGraph, frames: Vec<Frame>) -> Case {
            case_with(graph, frames, MARKMAP_DEFAULTS)
        }

        impl Case {
            fn run_with(
                &self,
                extra_spacing: Option<&mut dyn FnMut(u32, u32) -> f64>,
            ) -> Result<LayoutResult, LayoutError> {
                layout_graph_framed(
                    &self.graph,
                    Some(self.options.clone()),
                    extra_spacing,
                    &self.children_of,
                    &self.frames,
                    &self.blocks,
                )
            }

            fn run(&self) -> LayoutResult {
                match self.run_with(None) {
                    Ok(result) => result,
                    Err(error) => panic!("layout_graph_framed が誤りを返した: {}", error.message),
                }
            }

            // frames の添字 (グループの id で 1 つに決まるもの)
            fn frame(&self, group: &str) -> usize {
                let found: Vec<usize> = (0..self.frames.len())
                    .filter(|&index| self.frames[index].group.id == group)
                    .collect();
                assert_eq!(found.len(), 1, "{group} の枠はちょうど 1 つ");
                found[0]
            }

            fn is_boxed(&self, frame: usize) -> bool {
                self.blocks.blocks.iter().any(|block| block.frame == frame)
            }
        }

        fn rects_of(result: &LayoutResult) -> IndexMap<u32, Rect> {
            result
                .nodes
                .iter()
                .map(|(&id, placed)| (id, placed.rect))
                .collect()
        }

        fn outline(case: &Case, result: &LayoutResult, frame: usize) -> Rect {
            frame_outline(&case.frames[frame], &rects_of(result)).unwrap()
        }

        // 枠の矩形 (outline を上へ LABEL_HEIGHT 広げたもの)
        fn labeled(outline: Rect) -> Rect {
            Rect {
                y: outline.y - LABEL_HEIGHT,
                height: outline.height + LABEL_HEIGHT,
                ..outline
            }
        }

        fn right(rect: &Rect) -> f64 {
            rect.x + rect.width
        }

        fn bottom(rect: &Rect) -> f64 {
            rect.y + rect.height
        }

        // x の重なりの幅と y の重なりの幅が、どちらも 0.5 を超える
        fn overlaps(a: &Rect, b: &Rect) -> bool {
            let across = right(a).min(right(b)) - a.x.max(b.x);
            let along = bottom(a).min(bottom(b)) - a.y.max(b.y);
            across > 0.5 && along > 0.5
        }

        fn inside(outer: &Rect, inner: &Rect) -> bool {
            inner.x >= outer.x - 0.5
                && inner.y >= outer.y - 0.5
                && right(inner) <= right(outer) + 0.5
                && bottom(inner) <= bottom(outer) + 0.5
        }

        // loose の枠が関わる件数 (I1 の入り込みと I2 の重なり)。design.md の 3 章どおり 0 を求めず、試験の出力に出す
        #[derive(Debug, Default, PartialEq)]
        struct LooseCounts {
            intrusions: usize,
            overlaps: usize,
        }

        // design.md の 3 章の I1、I2、I10、I5、I6 を確かめる。箱にした枠は 0 を assert し、loose の枠が関わるものは数えて返す
        fn check_invariants(name: &str, case: &Case, result: &LayoutResult) -> LooseCounts {
            let graph = &case.graph;
            let rects = rects_of(result);
            let spacing = case.options.spacing_horizontal;
            let mut counts = LooseCounts::default();
            let outlines: Vec<Option<Rect>> = case
                .frames
                .iter()
                .map(|frame| frame_outline(frame, &rects))
                .collect();
            let sets: Vec<HashSet<u32>> = case
                .frames
                .iter()
                .map(|frame| frame.members.iter().copied().collect())
                .collect();

            // I1: 枠の矩形と、その枠のメンバーでないノードの矩形 (gap を左に足した矩形でも) が重ならない
            for (index, frame) in case.frames.iter().enumerate() {
                let Some(outline) = outlines[index] else {
                    continue;
                };
                let area = labeled(outline);
                for (id, placed) in &result.nodes {
                    let rect = placed.rect;
                    if sets[index].contains(id) || rect.width <= 0.0 || rect.height <= 0.0 {
                        continue;
                    }
                    let with_gap = Rect {
                        x: rect.x - placed.gap,
                        width: rect.width + placed.gap,
                        ..rect
                    };
                    if overlaps(&rect, &area) || overlaps(&with_gap, &area) {
                        assert!(
                            !case.is_boxed(index),
                            "{name}: I1 箱の枠 {} にメンバーでない {id} が入る",
                            frame.group.id
                        );
                        counts.intrusions += 1;
                    }
                }
            }

            // I2: メンバーが交わらない 2 つの枠は、枠の矩形が重ならない
            for i in 0..case.frames.len() {
                for j in i + 1..case.frames.len() {
                    if !sets[i].is_disjoint(&sets[j]) {
                        continue;
                    }
                    let (Some(a), Some(b)) = (outlines[i], outlines[j]) else {
                        continue;
                    };
                    if overlaps(&labeled(a), &labeled(b)) {
                        assert!(
                            !(case.is_boxed(i) && case.is_boxed(j)),
                            "{name}: I2 箱の枠 {} と {} が重なる",
                            case.frames[i].group.id,
                            case.frames[j].group.id
                        );
                        counts.overlaps += 1;
                    }
                }
            }

            // I10: 箱にした 2 つの枠で一方のメンバーが他方に含まれれば (同じメンバーなら level の高い方が外)、
            // 内側の枠の矩形が外側の outline の中に収まる
            for inner in &case.blocks.blocks {
                for outer in &case.blocks.blocks {
                    let (i, o) = (inner.frame, outer.frame);
                    if i == o || !sets[i].is_subset(&sets[o]) {
                        continue;
                    }
                    if sets[i].len() == sets[o].len() && inner.level >= outer.level {
                        continue;
                    }
                    let (Some(a), Some(b)) = (outlines[i], outlines[o]) else {
                        continue;
                    };
                    assert!(
                        inside(&b, &labeled(a)),
                        "{name}: I10 {} の枠が {} の outline からはみ出す",
                        case.frames[i].group.id,
                        case.frames[o].group.id
                    );
                }
            }

            // I5: rect.x と planned_x の差が 0.5 以下。配置から外されていない relations と配置上の親子で、
            // 終点の rect.x ≥ 始点の右の端 + spacing_horizontal − 0.5
            for (id, placed) in &result.nodes {
                assert!(
                    (placed.rect.x - result.planned_x[id]).abs() <= 0.5,
                    "{name}: I5 {id} の rect.x が planned_x と違う"
                );
            }
            for edge in &graph.edges {
                let counted = (edge.kind != VisibleEdgeKind::Tree && !edge.excluded_from_layout)
                    || graph.layout_parent.get(&edge.target) == Some(&edge.source);
                if !counted {
                    continue;
                }
                let source = rects[&edge.source];
                let target = rects[&edge.target];
                assert!(
                    target.x >= right(&source) + spacing - 0.5,
                    "{name}: I5 {} → {} が左から右へ流れない",
                    edge.source,
                    edge.target
                );
            }

            // I6: 出口の単位の根の rect.x ≥ 移し先の枠の outline の右の辺 + spacing_horizontal − 0.5。
            // 出口は入口の中と同じ入力で段 2 の placement_tree を呼んで知る
            let tree = placement_tree(
                graph,
                &case.children_of,
                &case.frames,
                &case.blocks,
                &layout_predecessors(graph, &MARKMAP_DEFAULTS),
            );
            for (unit, exit) in &tree.exits {
                let target = outlines[case.blocks.blocks[exit.block].frame].unwrap();
                let roots: Vec<u32> = match unit {
                    Slot::Node(id) => vec![*id],
                    Slot::Block(b) => case.blocks.blocks[*b].roots.clone(),
                    _ => panic!("出口の単位は Node か Block"),
                };
                for root in roots {
                    assert!(
                        rects[&root].x >= right(&target) + spacing - 0.5,
                        "{name}: I6 出口の {root} が移し先の枠の右の辺 + spacing_horizontal より左"
                    );
                }
            }

            if !case.blocks.loose.is_empty() {
                eprintln!(
                    "{name}: loose の枠 {} 個、入り込み {}、メンバーの交わらない枠との重なり {}",
                    case.blocks.loose.len(),
                    counts.intrusions,
                    counts.overlaps
                );
            }
            counts
        }

        // 箱にできる入力 (loose がない) で、不変条件を確かめる
        fn check_boxed(name: &str, case: &Case) -> LayoutResult {
            assert!(case.blocks.loose.is_empty(), "{name}: loose がある");
            let result = case.run();
            assert_eq!(
                check_invariants(name, case, &result),
                LooseCounts::default()
            );
            result
        }

        type ResultBits = (
            Vec<(u32, [u64; 4], u64, Option<u32>)>,
            Vec<([u64; 2], [u64; 2], bool)>,
            [u64; 4],
            Vec<(u32, u64)>,
            Vec<(u32, [u64; 2])>,
            Vec<(u32, u32, u64)>,
        );

        fn rect_bits(rect: &Rect) -> [u64; 4] {
            [
                rect.x.to_bits(),
                rect.y.to_bits(),
                rect.width.to_bits(),
                rect.height.to_bits(),
            ]
        }

        // LayoutResult の欄を並びごと to_bits にしたもの
        fn result_bits(result: &LayoutResult) -> ResultBits {
            (
                result
                    .nodes
                    .iter()
                    .map(|(&id, placed)| {
                        (
                            id,
                            rect_bits(&placed.rect),
                            placed.gap.to_bits(),
                            placed.layout_parent,
                        )
                    })
                    .collect(),
                result
                    .edges
                    .iter()
                    .map(|edge| {
                        (
                            [edge.source[0].to_bits(), edge.source[1].to_bits()],
                            [edge.target[0].to_bits(), edge.target[1].to_bits()],
                            edge.is_layout_link,
                        )
                    })
                    .collect(),
                rect_bits(&result.bounds),
                result
                    .planned_x
                    .iter()
                    .map(|(&id, x)| (id, x.to_bits()))
                    .collect(),
                result
                    .flextree_params
                    .node_size
                    .iter()
                    .map(|(&id, size)| (id, [size[0].to_bits(), size[1].to_bits()]))
                    .collect(),
                result
                    .flextree_params
                    .spacing
                    .iter()
                    .map(|call| (call.upper, call.lower, call.value.to_bits()))
                    .collect(),
            )
        }

        fn spacing_calls(result: &LayoutResult) -> Vec<(u32, u32, f64)> {
            result
                .flextree_params
                .spacing
                .iter()
                .map(|call| (call.upper, call.lower, call.value))
                .collect()
        }

        // L0 (children_of) を根から幅優先にたどった順
        fn breadth_first(case: &Case) -> Vec<u32> {
            let mut order = Vec::new();
            let mut queue = VecDeque::from([case.graph.root_id]);
            while let Some(id) = queue.pop_front() {
                order.push(id);
                queue.extend(case.children_of.get(&id).into_iter().flatten().copied());
            }
            order
        }

        // 試作の pipeline.rs の notation_like (placement.rs と段 3 の tests と同じ): 1 root / 2 要件 / 3 設計 %d (4、5 が子) /
        // 6 実装 %b (7 フロント (8、9、10)、11 バック (12、13)) / 14 検証 (15、16 が子)。
        // 2 -fork-> 4、5、3 -chain-> 6 -chain-> 14、10 -join-> 14、13 -join-> 14、12 -depends-> 9。d = {3, 4, 5}、b = {6..=13}
        const NOTATION_TREE: [(u32, u32); 15] = [
            (1, 2),
            (1, 3),
            (3, 4),
            (3, 5),
            (1, 6),
            (6, 7),
            (7, 8),
            (7, 9),
            (7, 10),
            (6, 11),
            (11, 12),
            (11, 13),
            (1, 14),
            (14, 15),
            (14, 16),
        ];
        const NOTATION_RELATIONS: [(RelationKind, u32, u32); 7] = [
            (RelationKind::Fork, 2, 4),
            (RelationKind::Fork, 2, 5),
            (RelationKind::Chain, 3, 6),
            (RelationKind::Chain, 6, 14),
            (RelationKind::Join, 10, 14),
            (RelationKind::Join, 13, 14),
            (RelationKind::Depends, 12, 9),
        ];

        fn notation_like_graph() -> VisibleGraph {
            let graph = graph_with(16, &NOTATION_TREE, &NOTATION_RELATIONS, &[6, 14]);
            assert_eq!(graph.layout_parent.get(&6), Some(&3));
            assert_eq!(graph.layout_parent.get(&14), Some(&10));
            graph
        }

        fn notation_like_entries(base: u32) -> Vec<(u32, &'static [&'static str])> {
            (1..=16)
                .map(|id| {
                    let list: &[&str] = match id {
                        3..=5 => &["d"],
                        6..=13 => &["b"],
                        _ => &[],
                    };
                    (base + id, list)
                })
                .collect()
        }

        fn notation_like() -> Case {
            let graph = notation_like_graph();
            let frames = frames_of(&graph, &["d", "b"], &notation_like_entries(0));
            assert_eq!(
                members_of(&frames),
                vec![
                    ("d".to_string(), vec![3, 4, 5]),
                    ("b".to_string(), (6..=13).collect())
                ]
            );
            make_case(graph, frames)
        }

        // nested-groups (frames.rs の model): dev = {2..=8}、backend = {6, 7, 8}、frontend = {3, 4, 5}。9 は枠のメンバーでない
        fn nested_groups_with(options: LayoutOptions) -> Case {
            let graph = nested();
            let frames = frames_of(
                &graph,
                &["dev", "backend", "frontend"],
                &[
                    (2, &["dev"]),
                    (3, &["dev", "frontend"]),
                    (4, &["dev", "frontend"]),
                    (5, &["dev", "frontend"]),
                    (6, &["dev", "backend"]),
                    (7, &["dev", "backend"]),
                    (8, &["dev", "backend"]),
                ],
            );
            case_with(graph, frames, options)
        }

        // loose-frames.md の例 1: 1 root / 2 設計 / 3 入力画面の改修 (設計の子) / 4 エラー文言と案内文の見直し / 5 告知。
        // 設計 --> 4 で 4 は設計の下へ、3 --> 告知 で告知は 3 の下へ付け替わる。copy = {3, 4}
        fn example1_graph() -> VisibleGraph {
            graph_of(
                5,
                &[(1, 2), (2, 3), (1, 4), (1, 5)],
                &[(2, 4), (3, 5)],
                &[4, 5],
            )
        }

        fn example1_with(options: LayoutOptions) -> Case {
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            case_with(graph, frames, options)
        }

        // loose-frames.md の例 2: 1 root / 2 開発 / 3 画面、4 決済APIとWebhookの実装 (開発の子) / 5 脆弱性診断 / 6 本番反映。
        // 開発 --> 脆弱性診断 --> 本番反映 で 5 は開発の下、6 は 5 の下へ付け替わる。security = {4, 5}
        fn example2() -> Case {
            let graph = graph_of(
                6,
                &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6)],
                &[(2, 5), (5, 6)],
                &[5, 6],
            );
            let frames = frames_of(
                &graph,
                &["security"],
                &[(4, &["security"]), (5, &["security"])],
            );
            make_case(graph, frames)
        }

        // design.md の Q3 の例 3: 1 root / 2 設計 %design / 3 画面、4 API / 5 告知。画面 --> 告知 --> API
        fn example3() -> Case {
            let graph = graph_of(
                5,
                &[(1, 2), (2, 3), (2, 4), (1, 5)],
                &[(3, 5), (5, 4)],
                &[5],
            );
            assert_eq!(graph.layout_parent.get(&5), Some(&3));
            let frames = frames_of(
                &graph,
                &["design"],
                &[(2, &["design"]), (3, &["design"]), (4, &["design"])],
            );
            make_case(graph, frames)
        }

        // design.md の Q4 の例 4: 1 root / 2 要件 %p / 3 試作 %p %q / 4 画面、5 API、6 計測 (試作の子) / 7 実装 %q。p が箱、q が loose
        fn example4() -> Case {
            let graph = graph_of(
                7,
                &[(1, 2), (1, 3), (3, 4), (3, 5), (3, 6), (1, 7)],
                &[],
                &[],
            );
            let frames = frames_of(
                &graph,
                &["p", "q"],
                &[
                    (2, &["p"]),
                    (3, &["p", "q"]),
                    (4, &["p", "q"]),
                    (5, &["p", "q"]),
                    (6, &["p", "q"]),
                    (7, &["q"]),
                ],
            );
            make_case(graph, frames)
        }

        // B-7 の入力 (design-review-b.md の b5-two-root-box-sibling.md): 1 root / 2 設計 / 3 画面 %ui / 4 部品 %ui / 5 API。
        // ui の根は [3, 4]。設計の下の外側の木の子の並びは [Block(ui), 5]
        fn review_b_7_two_roots() -> Case {
            let graph = graph_of(5, &[(1, 2), (2, 3), (2, 4), (2, 5)], &[], &[]);
            let frames = frames_of(&graph, &["ui"], &[(3, &["ui"]), (4, &["ui"])]);
            make_case(graph, frames)
        }

        // B-7 の入力の ui を 1 つの根にしたもの: 1 root / 2 設計 / 3 画面 %ui (4 部品はその子) / 5 API。ui の根は [3]
        fn review_b_7_one_root() -> Case {
            let graph = graph_of(5, &[(1, 2), (2, 3), (3, 4), (2, 5)], &[], &[]);
            let frames = frames_of(&graph, &["ui"], &[(3, &["ui"]), (4, &["ui"])]);
            make_case(graph, frames)
        }

        #[test]
        fn layout_graph_framed_without_frames_matches_layout_graph_with_extra_spacing() {
            // 枠のない入力 (frames と blocks が空) では、layout_graph_with_extra_spacing と同じ結果 (I3。全部の欄を並びごと to_bits で)。
            // 足す間隔の関数を渡したときも同じで、関数が受ける組も同じ順
            let cases: Vec<(VisibleGraph, LayoutOptions)> = vec![
                (super::gap_graph(), MARKMAP_DEFAULTS),
                (super::adopted_graph(), MARKMAP_DEFAULTS),
                (nested(), MARKMAP_DEFAULTS),
                (notation_like_graph(), MARKMAP_DEFAULTS),
                (example1_graph(), with_spacing(10.0)),
                (
                    super::gap_graph(),
                    LayoutOptions {
                        padding_x: 3.5,
                        spacing_horizontal: 17.25,
                        ..MARKMAP_DEFAULTS
                    },
                ),
            ];
            for (graph, options) in cases {
                let case = case_with(graph, Vec::new(), options.clone());
                assert!(case.blocks.blocks.is_empty() && case.blocks.loose.is_empty());
                let expected =
                    layout_graph_with_extra_spacing(&case.graph, Some(options.clone()), None)
                        .unwrap();
                assert_eq!(result_bits(&case.run()), result_bits(&expected));

                let extra =
                    |upper: u32, lower: u32| f64::from(upper % 3) * 1.5 + f64::from(lower % 2);
                let mut framed_calls: Vec<(u32, u32)> = Vec::new();
                let mut framed_extra = |upper: u32, lower: u32| {
                    framed_calls.push((upper, lower));
                    extra(upper, lower)
                };
                let framed = case.run_with(Some(&mut framed_extra)).unwrap();
                let mut old_calls: Vec<(u32, u32)> = Vec::new();
                let mut old_extra = |upper: u32, lower: u32| {
                    old_calls.push((upper, lower));
                    extra(upper, lower)
                };
                let old = layout_graph_with_extra_spacing(
                    &case.graph,
                    Some(options),
                    Some(&mut old_extra),
                )
                .unwrap();
                assert_eq!(result_bits(&framed), result_bits(&old));
                assert_eq!(framed_calls, old_calls);
            }
        }

        #[test]
        fn layout_graph_framed_nested_groups_keep_the_invariants() {
            // nested-groups: dev、backend、frontend の 3 つとも箱 (段 1)。I1 (9 は dev の枠に入らない)、I2 (frontend と backend は
            // 重ならない)、I10 (frontend と backend の枠はラベルの行ごと dev の outline に収まる)
            let case = nested_groups_with(MARKMAP_DEFAULTS);
            assert_eq!(case.blocks.blocks.len(), 3);
            let result = check_boxed("nested-groups", &case);
            let frontend = labeled(outline(&case, &result, case.frame("frontend")));
            let backend = labeled(outline(&case, &result, case.frame("backend")));
            let dev = outline(&case, &result, case.frame("dev"));
            assert!(!overlaps(&frontend, &backend));
            assert!(inside(&dev, &frontend) && inside(&dev, &backend));
            assert!(!overlaps(&labeled(dev), &rects_of(&result)[&9]));
        }

        #[test]
        fn layout_graph_framed_puts_the_announcement_of_loose_example_1_right_of_the_frame() {
            // 例 1: 告知 5 は copy の箱の出口の子で、枠の右の外 (Q2-c)。
            // 深さの方向 (段 3): 3 と 4 は 272、copy の枠の右の辺は 272 + 56 + 8 = 336、告知は 336 + 80 = 416。
            // 兄弟の方向: copy の中の木は Joint(copy) の子に [3, 4]。spacing(3, 4) は base 5 (どちらも親は Joint(copy)) +
            // 線の太さ (3 の depth 3) 1.375 = 6.375 で、中心は ±(10 + 3.1875) = ±13.1875。中身の外接は ±23.1875。
            // 箱は上へ 8 + 14、下へ 8 広げて [-45.1875, 31.1875] (大きさ 76.375)。外側の木は 1 → 2 → 箱 → 5 の 1 つの子の鎖なので
            // 中心はどれも 0、箱の範囲は ±38.1875 で、中の木を -38.1875 − (-45.1875) = 7 ずらす。
            // よって 3 の矩形の上端は -13.1875 + 7 − 10 = -16.1875、4 は 13.1875 + 7 − 10 = 10.1875、告知は -10。
            // copy の outline は x 264 (= 272 − 8)、y -24.1875 (= -16.1875 − 8)、幅 72 (= 56 + 16)、高さ 46.375 + 16 = 62.375
            let case = example1_with(MARKMAP_DEFAULTS);
            let result = check_boxed("例 1", &case);
            let rects = rects_of(&result);
            assert_eq!((rects[&3].x, rects[&3].y), (272.0, -16.1875));
            assert_eq!((rects[&4].x, rects[&4].y), (272.0, 10.1875));
            assert_eq!((rects[&5].x, rects[&5].y), (416.0, -10.0));
            let copy = outline(&case, &result, case.frame("copy"));
            assert_eq!(
                copy,
                Rect {
                    x: 264.0,
                    y: -24.1875,
                    width: 72.0,
                    height: 62.375
                }
            );
            assert!(rects[&5].x >= right(&copy) + 80.0);
            assert!(!overlaps(&labeled(copy), &rects[&5]));
        }

        #[test]
        fn layout_graph_framed_puts_the_release_of_loose_example_2_right_of_the_frame() {
            // 例 2: 本番反映 6 は security の箱の出口の子で、枠の右の外 (Q2-c)。深さの方向は例 1 と同じ形 (4、5 は 272、6 は 416)。
            // security の中の木は Joint の子に [4, 5] で、spacing(4, 5) = 5 + 1.375 (4 の depth 3) = 6.375。箱は例 1 と同じ大きさ 76.375、
            // 中の木の上端は -45.1875。外側の木は 2 → [3, Block(security)]。spacing(3, 箱) は下の側を最初の根 4 に置き換えて
            // base 5 (3 と箱の配置の木の親はどちらも 2) + 1.375 (3 の depth 3) = 6.375。
            // 中心の間は 10 + 6.375 + 38.1875 = 54.5625。2 (0) は 3 の上端 c − 10 と箱の下端 c + 54.5625 + 38.1875 の中点なので
            // c = -41.375、箱の中心は 13.1875、箱の範囲は [-25, 51.375]。中の木を -25 − (-45.1875) = 20.1875 ずらす。
            // よって 3 の上端は -51.375、4 は -13.1875 + 20.1875 − 10 = -3、5 は 13.1875 + 20.1875 − 10 = 23.375、6 は 3.1875。
            // security の outline は x 264、y -11、幅 72、高さ (23.375 + 20 − (-3)) + 16 = 62.375。上のラベルの行の上端は -25 で、
            // 3 の下端 -31.375 との間が spacing 6.375
            let case = example2();
            let result = check_boxed("例 2", &case);
            let rects = rects_of(&result);
            assert_eq!((rects[&3].x, rects[&3].y), (272.0, -51.375));
            assert_eq!((rects[&4].x, rects[&4].y), (272.0, -3.0));
            assert_eq!((rects[&5].x, rects[&5].y), (272.0, 23.375));
            assert_eq!((rects[&6].x, rects[&6].y), (416.0, 3.1875));
            let security = outline(&case, &result, case.frame("security"));
            assert_eq!(
                security,
                Rect {
                    x: 264.0,
                    y: -11.0,
                    width: 72.0,
                    height: 62.375
                }
            );
            assert!(rects[&6].x >= right(&security) + 80.0);
            assert_eq!(labeled(security).y - bottom(&rects[&3]), 6.375);
        }

        #[test]
        fn layout_graph_framed_notation_puts_build_right_of_design_and_verification_right_of_build()
        {
            // notation_like (Q3-b): build (b) の箱は design (d) の箱の出口の単位で、d の枠の右。検証 14 は b の箱の出口の子で、b の枠の右。
            // 深さの方向 (段 3): d の枠の右の辺 336、実装 6 は 336 + 80 = 416 で、b の枠の左の辺は 416 − 8 = 408 (d の右の辺より 72 右)。
            // 検証は b の枠の右の辺 + 80 以上。d と b はメンバーが交わらないので重ならない (I2)
            let case = notation_like();
            let result = check_boxed("notation_like", &case);
            let rects = rects_of(&result);
            let design = outline(&case, &result, case.frame("d"));
            let build = outline(&case, &result, case.frame("b"));
            assert_eq!(right(&design), 336.0);
            assert_eq!(rects[&6].x, 416.0);
            assert_eq!(build.x, 408.0);
            assert!(build.x >= right(&design) + 72.0);
            assert!(rects[&14].x >= right(&build) + 80.0);
            assert!(rects[&15].x > right(&rects[&14]) && rects[&16].x > right(&rects[&14]));
            assert!(!overlaps(&labeled(design), &labeled(build)));
        }

        #[test]
        fn layout_graph_framed_review_a_inputs_keep_the_invariants() {
            // A-2 (2 つの出口の制約が合わさる閉路。周知は後戻り)、A-3 の入力 1 と 2 (外側の箱の中の後戻り)、A-4 (根が 2 つの箱が出口の単位)。
            // どれも全部の枠が箱で、I1、I2、I10、I5、I6 が成り立つ。A-1 の 2 つの入力は loose があるので
            // layout_graph_framed_loose_frames_are_counted_not_asserted で見る
            let a2 = {
                let graph = graph_of(
                    9,
                    &[
                        (1, 2),
                        (2, 3),
                        (2, 4),
                        (1, 5),
                        (5, 6),
                        (5, 7),
                        (1, 8),
                        (1, 9),
                    ],
                    &[(3, 8), (8, 7), (6, 9), (9, 4)],
                    &[8, 9],
                );
                let frames = frames_of(
                    &graph,
                    &["design", "dev"],
                    &[
                        (2, &["design"]),
                        (3, &["design"]),
                        (4, &["design"]),
                        (5, &["dev"]),
                        (6, &["dev"]),
                        (7, &["dev"]),
                    ],
                );
                make_case(graph, frames)
            };
            let a3_1 = {
                let graph = graph_of(
                    7,
                    &[(1, 2), (2, 3), (3, 4), (3, 5), (1, 6), (1, 7)],
                    &[(3, 6), (6, 5)],
                    &[6],
                );
                let both: &[&str] = &["dev", "design"];
                let frames = frames_of(
                    &graph,
                    &["dev", "design"],
                    &[
                        (2, &["dev"]),
                        (3, both),
                        (4, both),
                        (5, both),
                        (6, &["dev"]),
                    ],
                );
                make_case(graph, frames)
            };
            let a3_2 = {
                let graph = graph_of(
                    9,
                    &[
                        (1, 2),
                        (2, 3),
                        (3, 4),
                        (4, 5),
                        (4, 6),
                        (3, 7),
                        (1, 8),
                        (1, 9),
                    ],
                    &[(4, 8), (8, 6)],
                    &[8],
                );
                let three: &[&str] = &["hq", "dev", "design"];
                let frames = frames_of(
                    &graph,
                    &["hq", "dev", "design"],
                    &[
                        (2, &["hq"]),
                        (3, &["hq", "dev"]),
                        (4, three),
                        (5, three),
                        (6, three),
                        (7, &["hq", "dev"]),
                        (8, &["hq"]),
                    ],
                );
                make_case(graph, frames)
            };
            let a4 = {
                let graph = graph_of(
                    7,
                    &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
                    &[(3, 5), (4, 6), (3, 7)],
                    &[5, 6, 7],
                );
                let frames = frames_of(
                    &graph,
                    &["design", "notice"],
                    &[
                        (2, &["design"]),
                        (3, &["design"]),
                        (4, &["design"]),
                        (5, &["notice"]),
                        (7, &["notice"]),
                    ],
                );
                make_case(graph, frames)
            };
            for (name, case) in [
                ("A-2", a2),
                ("A-3 の 1", a3_1),
                ("A-3 の 2", a3_2),
                ("A-4", a4),
            ] {
                check_boxed(name, &case);
            }
        }

        #[test]
        fn layout_graph_framed_review_b_inputs_keep_the_invariants() {
            // B-1 (2 つの出口の制約が合わさる閉路)、B-2 (外側の箱の中の後戻り)、B-4 (同じグループの 2 つの枠)、B-5 (メンバーが同じ 2 つの枠)、
            // B-7 (根が 2 つの箱と下の兄弟)、B-10 (境界の入力で tree_parent がメンバー。後戻り)。どれも全部の枠が箱。
            // B-3 は loose があるので layout_graph_framed_loose_frames_are_counted_not_asserted で見る
            let b1 = {
                let graph = graph_of(
                    9,
                    &[
                        (1, 2),
                        (2, 3),
                        (2, 4),
                        (1, 5),
                        (1, 6),
                        (6, 7),
                        (6, 8),
                        (1, 9),
                    ],
                    &[(3, 5), (5, 8), (7, 9), (9, 4)],
                    &[5, 9],
                );
                let frames = frames_of(
                    &graph,
                    &["design", "ops"],
                    &[
                        (2, &["design"]),
                        (3, &["design"]),
                        (4, &["design"]),
                        (6, &["ops"]),
                        (7, &["ops"]),
                        (8, &["ops"]),
                    ],
                );
                make_case(graph, frames)
            };
            let b2 = {
                let graph = graph_of(
                    7,
                    &[(1, 2), (2, 3), (3, 4), (2, 5), (1, 6), (1, 7)],
                    &[(3, 7), (7, 5)],
                    &[7],
                );
                let both: &[&str] = &["team", "design"];
                let frames = frames_of(
                    &graph,
                    &["team", "design"],
                    &[(2, both), (3, both), (4, both), (5, both), (7, &["team"])],
                );
                make_case(graph, frames)
            };
            let b4 = {
                let graph = graph_of(
                    7,
                    &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
                    &[(3, 5), (3, 7), (4, 6)],
                    &[5, 6, 7],
                );
                let frames = frames_of(
                    &graph,
                    &["sec"],
                    &[
                        (2, &["sec"]),
                        (3, &["sec"]),
                        (4, &["sec"]),
                        (5, &["sec"]),
                        (7, &["sec"]),
                    ],
                );
                assert_eq!(frames.len(), 2);
                make_case(graph, frames)
            };
            let b5 = {
                let graph = nested();
                let all: &[&str] = &["a", "b"];
                let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all), (5, all)]);
                make_case(graph, frames)
            };
            let b10 = {
                let graph = graph_of(9, &NESTED_TREE, &[(5, 4)], &[]);
                assert_eq!(graph.layout_parent.get(&5), Some(&3));
                let frames = frames_of(&graph, &["screen"], &[(3, &["screen"]), (4, &["screen"])]);
                make_case(graph, frames)
            };
            for (name, case) in [
                ("B-1", b1),
                ("B-2", b2),
                ("B-4", b4),
                ("B-5", b5),
                ("B-7", review_b_7_two_roots()),
                ("B-10", b10),
            ] {
                check_boxed(name, &case);
            }
        }

        #[test]
        fn layout_graph_framed_loose_frames_are_counted_not_asserted() {
            // メンバーを共有する枠 (一部だけ重なる) は重なってよい (3 章の重なりの規定)。loose の枠が関わる入り込みと重なりは
            // 0 を求めず、件数を試験の出力に出すだけ。箱にした枠の I1、I2、I10 は check_invariants が assert する。
            // 例 4 (p が箱、q が loose。groups に書いた順で p が先。A-6)、A-1 の入力 1 (a が箱、s が loose)、
            // B-3 (A-1 の入力 2。design が箱、ux が loose)
            let a1 = {
                let graph = graph_of(
                    6,
                    &[(1, 2), (2, 3), (2, 4), (4, 5), (1, 6)],
                    &[(4, 6)],
                    &[6],
                );
                let frames = frames_of(
                    &graph,
                    &["a", "s"],
                    &[(3, &["a"]), (4, &["a", "s"]), (5, &["a", "s"]), (6, &["s"])],
                );
                make_case(graph, frames)
            };
            let b3 = {
                let graph = graph_of(5, &[(1, 2), (2, 3), (3, 4), (1, 5)], &[(3, 5)], &[5]);
                let frames = frames_of(
                    &graph,
                    &["design", "ux"],
                    &[
                        (2, &["design"]),
                        (3, &["design", "ux"]),
                        (4, &["design", "ux"]),
                        (5, &["ux"]),
                    ],
                );
                make_case(graph, frames)
            };
            for (name, case, boxed, loose) in [
                ("例 4", example4(), "p", "q"),
                ("A-1 の 1", a1, "a", "s"),
                ("B-3", b3, "design", "ux"),
            ] {
                assert!(case.is_boxed(case.frame(boxed)), "{name}: {boxed} が箱");
                assert_eq!(
                    case.blocks.loose,
                    vec![case.frame(loose)],
                    "{name}: {loose} が loose"
                );
                let result = case.run();
                // 件数は返すだけ (値は求めない)
                let counts = check_invariants(name, &case, &result);
                eprintln!("{name}: {counts:?}");
            }
        }

        #[test]
        fn layout_graph_framed_fallback_of_example_3_sits_below_the_frame() {
            // 例 3: 告知 5 は出口にすると閉路なので後戻りし、ルートの子の並びの末尾 (段 2)。design の枠は箱で、告知は枠の下の行。
            // 深さの方向 (段 3) は旧と同じで、告知は 408 (画面 272 + 136)、API は 544 (告知 408 + 136)。
            // 外側の木は 1 → [Block(design), 5] なので、告知の上端は design の枠 (ラベルの行を含む箱) の下端より下
            let case = example3();
            let result = check_boxed("例 3", &case);
            let rects = rects_of(&result);
            assert_eq!(rects[&5].x, 408.0);
            assert_eq!(rects[&4].x, 544.0);
            let design = outline(&case, &result, case.frame("design"));
            assert!(rects[&5].y >= bottom(&design) - 0.5);
            assert!(rects[&5].x >= right(&rects[&3]) + 80.0 - 0.5);
            assert!(rects[&4].x >= right(&rects[&5]) + 80.0 - 0.5);
        }

        #[test]
        fn layout_graph_framed_roots_of_one_box_are_spaced_like_old_siblings() {
            // 根が複数の箱 (例 1 の copy。根 3、4 は Joint(copy) の子) の根の間隔は、旧と同じ spacing (同じ親の兄弟の base)。
            // 旧 (枠なしの layout_graph) では 3 と 4 は配置上の親が同じ 2 で、base 5 + 線の太さ (3 の depth 3) 1.375 = 6.375。
            // 新でも Joint(copy) の子どうしで base 5、同じ 6.375。3 と 4 は箱の中の葉なので、矩形の間も 6.375
            let case = example1_with(MARKMAP_DEFAULTS);
            let result = case.run();
            let calls = spacing_calls(&result);
            assert_eq!(calls, vec![(3, 4, 6.375)]);
            let old = layout_graph(&case.graph, None).unwrap();
            let old_value = spacing_calls(&old)
                .into_iter()
                .find(|&(upper, lower, _)| (upper, lower) == (3, 4))
                .map(|(_, _, value)| value);
            assert_eq!(old_value, Some(6.375));
            let rects = rects_of(&result);
            assert_eq!(rects[&4].y - bottom(&rects[&3]), 6.375);
        }

        #[test]
        fn layout_graph_framed_box_and_lower_sibling_use_the_same_base_for_one_or_two_roots() {
            // B-7: 箱と下の兄弟の spacing の base は、置き換える前の Slot の配置の木の親で比べる (Block(ui) と API の親はどちらも設計 2)
            // ので、箱の根が 2 つでも 1 つでも spacing_vertical (5)。線の太さは上の側を最後の根に置き換えて引く。
            // 根が 2 つ: 最後の根は 部品 4 (depth 3) → 5 + 1.375 = 6.375。旧 (layout_parent で比べる) の (4, 5) と同じ base。
            // 根が 1 つ: 根は 画面 3 (depth 3) → 5 + 1.375 = 6.375。
            // 箱の下端は枠の outline の下端 (中身 + bottom 8) なので、API の矩形の上端は outline の下端 + 6.375
            for (name, case, last_root) in [
                ("根が 2 つ", review_b_7_two_roots(), 4),
                ("根が 1 つ", review_b_7_one_root(), 3),
            ] {
                let result = check_boxed(name, &case);
                let calls = spacing_calls(&result);
                assert!(
                    calls.contains(&(last_root, 5, 6.375)),
                    "{name}: 箱と API の spacing {calls:?}"
                );
                assert_eq!(
                    calls.iter().filter(|call| call.1 == 5).count(),
                    1,
                    "{name}: API を下にした問い合わせは 1 度"
                );
                let ui = outline(&case, &result, case.frame("ui"));
                assert_eq!(rects_of(&result)[&5].y - bottom(&ui), 6.375, "{name}");
            }
            // 根が 2 つのときの中の根どうし (3, 4) も同じ親 (Joint(ui)) の兄弟で 6.375
            let result = review_b_7_two_roots().run();
            assert_eq!(spacing_calls(&result), vec![(3, 4, 6.375), (4, 5, 6.375)]);
        }

        #[test]
        fn layout_graph_framed_neighbors_with_different_parents_get_twice_the_vertical_spacing() {
            // 枠のある配置でも、兄弟の方向で隣り合う 2 つの Slot の配置の木の親が違えば、spacing の base は spacing_vertical × 2 (10)。
            // 1 root / 2、3、6 (ルートの子) / 4 (2 の子)、5 (3 の子) / 7、8 (6 の子で枠 f)。外側の木: 1 → [2, 3, 6]、2 → [4]、3 → [5]、
            // 6 → [Block(f)]。f の中の木は Joint(f) の子に [7, 8]。
            // 同じ親: (2, 3)、(3, 6) は 5 + 線の太さ (depth 2) 1.75 = 6.75、f の中の (7, 8) は 5 + 1.375 = 6.375。
            // 親が違う: (4, 5) と (5, Block(f)) は 10 + 1.375 = 11.375。Block(f) は下の側なので最初の根 7 に置き換わる。
            // 枠のない同じ木 (旧の layout_graph) の (4, 5) も 11.375
            let tree = [(1, 2), (1, 3), (2, 4), (3, 5), (1, 6), (6, 7), (6, 8)];
            let graph = graph_of(8, &tree, &[], &[]);
            let frames = frames_of(&graph, &["f"], &[(7, &["f"]), (8, &["f"])]);
            let case = make_case(graph, frames);
            let result = check_boxed("親の違う隣", &case);
            let calls = spacing_calls(&result);
            for expected in [
                (7, 8, 6.375),
                (2, 3, 6.75),
                (3, 6, 6.75),
                (4, 5, 11.375),
                (5, 7, 11.375),
            ] {
                assert!(calls.contains(&expected), "{expected:?} がない: {calls:?}");
            }
            let old = layout_graph(&case.graph, None).unwrap();
            assert!(spacing_calls(&old).contains(&(4, 5, 11.375)));
            let rects = rects_of(&result);
            assert_eq!(rects[&5].y - bottom(&rects[&4]), 11.375);
        }

        #[test]
        fn layout_graph_framed_extra_spacing_gets_the_last_root_above_and_the_first_root_below() {
            // 足す間隔 (loose の枠の between) は、Slot を実のノードに置き換えて問う。上の側の箱は最後の根、下の側の箱は最初の根 (B-7)。
            // 「最後の根」は箱の中の木から求める (段 4 の実装で決めた。Block は中の木の根へ、Joint は子の並びの端へ下り、後戻りした
            // 単位と内側の箱を含む)。後戻りのない入力では FrameBlock.roots の最後 / 最初と同じで、ここではその入力だけで見る
            // 箱にした枠は between に渡さない (段 5 が loose の枠だけを渡す) ので、ここでは関数が受けた組だけを見る。
            // B-7 の入力 (設計の子 [Block(ui) (根 3、4), 5]): 中の木の (3, 4)、外側の木の (最後の根 4, 5) の順 (内側の箱から回す)。
            // 並びを逆にした入力 (設計の子 [3, Block(ui) (根 4、5)]): 中の木の (4, 5)、外側の木の (3, 最初の根 4)
            let mut calls: Vec<(u32, u32)> = Vec::new();
            let mut record = |upper: u32, lower: u32| {
                calls.push((upper, lower));
                0.0
            };
            let case = review_b_7_two_roots();
            let result = case.run_with(Some(&mut record)).unwrap();
            assert_eq!(calls, vec![(3, 4), (4, 5)]);
            let recorded: Vec<(u32, u32)> = spacing_calls(&result)
                .into_iter()
                .map(|(upper, lower, _)| (upper, lower))
                .collect();
            assert_eq!(recorded, calls);

            let graph = graph_of(5, &[(1, 2), (2, 3), (2, 4), (2, 5)], &[], &[]);
            let frames = frames_of(&graph, &["ui"], &[(4, &["ui"]), (5, &["ui"])]);
            let case = make_case(graph, frames);
            let mut calls: Vec<(u32, u32)> = Vec::new();
            let mut record = |upper: u32, lower: u32| {
                calls.push((upper, lower));
                2.5
            };
            let result = case.run_with(Some(&mut record)).unwrap();
            assert_eq!(calls, vec![(4, 5), (3, 4)]);
            // 足す値はそのまま足す: 5 + 1.375 + 2.5
            assert_eq!(spacing_calls(&result), vec![(4, 5, 8.875), (3, 4, 8.875)]);
        }

        #[test]
        fn layout_graph_framed_records_node_size_and_spacing_calls() {
            // B-6: flextree_params に、実のノードの node_size ([高さ, gap + ext]) と、spacing の問い合わせ (実のノードに置き換えた組と値) が入る。
            // planned_x と gap は段 3 (block_depths) の値のまま。spacing の値は base (5 か 10) + 線の太さ (上の depth)
            // TODO(spec): node_size の並び (graph.nodes の順か) は設計に書かれていないので、id の順に並べて比べる
            let case = notation_like();
            let result = case.run();
            let depths = block_depths(
                &case.graph,
                &case.options,
                &placement_tree(
                    &case.graph,
                    &case.children_of,
                    &case.frames,
                    &case.blocks,
                    &layout_predecessors(&case.graph, &MARKMAP_DEFAULTS),
                ),
                &case.blocks,
                &case.frames,
                &layout_predecessors(&case.graph, &MARKMAP_DEFAULTS),
            )
            .unwrap();
            let mut planned: Vec<(u32, u64)> = result
                .planned_x
                .iter()
                .map(|(&id, x)| (id, x.to_bits()))
                .collect();
            planned.sort_unstable();
            let mut expected_planned: Vec<(u32, u64)> = depths
                .planned_x
                .iter()
                .map(|(&id, x)| (id, x.to_bits()))
                .collect();
            expected_planned.sort_unstable();
            assert_eq!(planned, expected_planned);

            let mut sizes: Vec<(u32, [u64; 2])> = result
                .flextree_params
                .node_size
                .iter()
                .map(|(&id, size)| (id, [size[0].to_bits(), size[1].to_bits()]))
                .collect();
            sizes.sort_unstable();
            let mut expected_sizes: Vec<(u32, [u64; 2])> = case
                .graph
                .nodes
                .iter()
                .map(|node| {
                    let gap = depths.gap_of[&node.id];
                    assert_eq!(result.nodes[&node.id].gap.to_bits(), gap.to_bits());
                    (node.id, [node.height.to_bits(), (gap + 136.0).to_bits()])
                })
                .collect();
            expected_sizes.sort_unstable();
            assert_eq!(sizes, expected_sizes);

            let depth_of: HashMap<u32, u32> = case
                .graph
                .nodes
                .iter()
                .map(|node| (node.id, node.depth))
                .collect();
            let calls = &result.flextree_params.spacing;
            assert!(!calls.is_empty());
            for call in calls {
                let line = MARKMAP_DEFAULTS.line_width.at(depth_of[&call.upper]);
                assert!(
                    call.value.to_bits() == (5.0 + line).to_bits()
                        || call.value.to_bits() == (10.0 + line).to_bits(),
                    "({}, {}) の spacing {}",
                    call.upper,
                    call.lower,
                    call.value
                );
            }
        }

        #[test]
        fn layout_graph_framed_nodes_are_in_breadth_first_order_of_l0() {
            // 段 4 の出力の並びは、graph を L0 で根から幅優先にたどった順 (LayoutResult.nodes の「flextree の each の順 (幅優先)」と同じ)。
            // 出口の子 (例 1、notation) と後戻り (例 3) があっても、配置の木ではなく L0 の順
            // layout_placement の入力に graph (L0) がないので、並べ直すのは layout_graph_framed (段 4 の実装で決めた)
            for (name, case) in [
                ("例 1", example1_with(MARKMAP_DEFAULTS)),
                ("例 3", example3()),
                ("notation_like", notation_like()),
                ("nested-groups", nested_groups_with(MARKMAP_DEFAULTS)),
            ] {
                let result = case.run();
                let order: Vec<u32> = result.nodes.keys().copied().collect();
                assert_eq!(order, breadth_first(&case), "{name}");
            }
        }

        #[test]
        fn layout_graph_framed_same_input_gives_the_same_bits() {
            // I8: 同じ入力なら同じ結果 (to_bits)
            for case in [
                notation_like(),
                nested_groups_with(MARKMAP_DEFAULTS),
                example2(),
            ] {
                assert_eq!(result_bits(&case.run()), result_bits(&case.run()));
            }
        }

        #[test]
        fn layout_graph_framed_narrow_horizontal_spacing_keeps_frames_off_other_nodes() {
            // spacing_horizontal を 10 にすると、level 1 の枠 (side 30) の左の辺が親の本体の手前まで広がる (段 3 の根の余白)。
            // nested-groups (dev は level 1)、notation_like、例 1 で I1、I2、I10 が成り立つ (4 章の「枠の左の辺と左の列」)
            for (name, case) in [
                ("nested-groups", nested_groups_with(with_spacing(10.0))),
                ("例 1", example1_with(with_spacing(10.0))),
                ("notation_like", {
                    let graph = notation_like_graph();
                    let frames = frames_of(&graph, &["d", "b"], &notation_like_entries(0));
                    case_with(graph, frames, with_spacing(10.0))
                }),
            ] {
                check_boxed(name, &case);
            }
        }

        #[test]
        fn layout_graph_framed_accepts_ids_near_u32_max() {
            // notation_like の形で id を u32::MAX − 16 + 1..=u32::MAX にする (いちばん大きい id が u32::MAX)。
            // 試作は仮ノードの id を「いちばん大きい id の次」から振り、ここで誤りになった (context 3 章)
            let base = u32::MAX - 16;
            let graph = graph_with_base(base, 16, &NOTATION_TREE, &NOTATION_RELATIONS, &[6, 14]);
            assert_eq!(graph.nodes.last().map(|node| node.id), Some(u32::MAX));
            let frames = frames_of(&graph, &["d", "b"], &notation_like_entries(base));
            let case = make_case(graph, frames);
            assert_eq!(case.blocks.blocks.len(), 2);
            let result = check_boxed("u32::MAX 付近", &case);
            assert_eq!(result.nodes.len(), 16);
        }

        #[test]
        fn layout_graph_framed_same_two_members_5000_levels_do_not_overflow_the_stack() {
            // B-11: test/wasm-limits.test.ts の「同じ 2 つのメンバーの枠 5000 個」の形。1 の下に 2、3 がどれも g0〜g4999 のメンバー。
            // 根が 2 つ ([2, 3]) の同じメンバーの箱が 5000 段入れ子になる (B-5 の形)。wasm の既定と同じ 1 MiB のスタックで誤りなく終わる。
            // 遅さは確かめない (設計の B-11 と計画書の決まり)。全部の組の不変条件は枠の数の 2 乗なので、いちばん内側と外側だけを見る
            let count = 5000u32;
            let result = std::thread::Builder::new()
                .stack_size(1 << 20)
                .spawn(move || {
                    let graph = graph_of(3, &[(1, 2), (1, 3)], &[], &[]);
                    let groups: Vec<GroupDef> =
                        (0..count).map(|i| group(&format!("g{i}"))).collect();
                    let ids: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
                    let groups_of: IndexMap<u32, Vec<String>> =
                        [(2, ids.clone()), (3, ids)].into_iter().collect();
                    let frames =
                        compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
                    let case = make_case(graph, frames);
                    let result = case.run();
                    let rects = rects_of(&result);
                    let level = |level: u32| {
                        case.frames
                            .iter()
                            .position(|frame| frame.level == level)
                            .unwrap()
                    };
                    let innermost = labeled(outline(&case, &result, level(0)));
                    let outermost = outline(&case, &result, level(count - 1));
                    (
                        case.frames.len(),
                        case.blocks.blocks.len(),
                        case.blocks.loose.len(),
                        result.nodes.len(),
                        inside(&outermost, &innermost),
                        overlaps(&labeled(outermost), &rects[&1]),
                    )
                })
                .unwrap()
                .join()
                .unwrap();
            assert_eq!(result, (count as usize, count as usize, 0, 3, true, false));
        }
    }
}

// PORT STATUS: confidence=high todos=0

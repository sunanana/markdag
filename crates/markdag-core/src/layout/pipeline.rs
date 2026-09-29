// 原文: src/view/view.ts (2026-09-24) の update の配置の流れ (944-978 行)。出力の形は scripts/judge/harness.ts の layoutFor
// view の配置の流れを 1 関数にしたもの (DESIGN (d)。やり直しの単位で、manifest の表の外。規則書 4 章のモジュールの木にある。A-171)。
// 射影 → 枠 → 配置を行う。枠のない文書は旧の 1 回の配置そのまま。
// 枠のある文書は、1 つの矩形のまとまりにできる枠を配置の木の箱にして (layout_graph_framed)、枠どうしとメンバーでないノードが
// 重ならない形で置く。まとまりにできない枠 (loose) があるときだけ、前回の結果の張り出しのぶん loose の枠の間隔を空けて配置を繰り返し、
// 入り込みが 0 の回で止め、0 にならなければ入り込み、面積、早さの順で一番よい回を採る (Q4-b)。
// 箱にした枠の余白は箱の大きさに入っているので、ExtraSpacing (between) に渡すのは loose の枠だけ (二重にしない)。
// layoutOverride (利用者の関数) の経路と、折りたたみの状態 (initialFold、visibleIds) は JS の view に残る (DESIGN (d))。
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::frames::{
    Frame, FrameBlocks, LABEL_HEIGHT, compute_frames, frame_blocks, frame_outline, frame_padding,
    frame_spacing,
};
use crate::layout::layout::{
    ExtraSpacing, LayoutOptions, LayoutResult, MARKMAP_DEFAULTS, PlacedEdge, SpacingCall,
    check_layout_options, layout_children_of, layout_graph, layout_graph_framed,
};
use crate::layout::project::{VisibleGraph, project};
use crate::types::{GroupDef, LayoutError, LayoutInput, Rect};

/// 原文: view.ts の MAX_LAYOUT_PASSES (審判の harness も同じ値)。枠のある文書で配置を繰り返す上限
pub const MAX_LAYOUT_PASSES: usize = 4;

/// 枠と、採った回の矩形から作った枠の矩形 (harness の `{ ...frame, outline: frameOutline(frame, rects) }`)。
/// 箱にした枠とメンバーを一部共有する loose の枠の outline は、交差が見えるようずらした後の値 (E-1)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocumentFrame {
    #[serde(flatten)]
    pub frame: Frame,
    /// 矩形のあるメンバーが 1 つもなければ null
    pub outline: Option<Rect>,
}

/// layout_document の戻り値 (DESIGN (b) の mdag_layout_document の出力。審判の layout と同じ欄、folded は入力側なので持たない)。
/// graph は射影の結果のまま。配置の木の親は、箱の出口へ移したノードと後戻りしたノードで graph.layoutParent と違う
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocumentResult {
    pub graph: VisibleGraph,
    /// 外側の枠が先 (compute_frames の順)
    pub frames: Vec<LayoutDocumentFrame>,
    /// 採った回の配置。並びは配置上の親子 (L0) を根から幅優先にたどった順
    #[serde(with = "crate::model::util::pairs")]
    pub rects: IndexMap<u32, Rect>,
    #[serde(with = "crate::model::util::pairs::f64_values")]
    pub gaps: IndexMap<u32, f64>,
    pub edges: Vec<PlacedEdge>,
    pub bounds: Rect,
    #[serde(with = "crate::model::util::pairs::f64_values")]
    pub planned_x: IndexMap<u32, f64>,
    #[serde(with = "crate::model::util::pairs::f64_pair_values")]
    pub node_size: IndexMap<u32, [f64; 2]>,
    /// 採った回 (1 始まり)。枠のない文書と、まとまりにできない枠のない文書では 1
    pub passes: usize,
    /// 採った回に flextree が呼んだ spacing の組と値 (枠の余白を含む合計)。境界の JSON には出さない (A-169)
    #[serde(skip)]
    pub spacing: Vec<SpacingCall>,
}

/// 枠のうち、配置の木の箱にした数と、まとまりにできなかった (loose) 数。
/// 境界の JSON と公開 API には出さず、試験と棚卸しの道具が layout_document_with_counts から読む (設計 7 章の出口の案 1)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameBoxCounts {
    pub boxed: usize,
    pub loose: usize,
}

/// 原文: view.ts の update のうち layoutOverride が null の経路 (944-978 行)。layout_document_with_counts の前半を返す。
/// options が None なら MARKMAP_DEFAULTS、max_passes が None なら MAX_LAYOUT_PASSES (規則 2.6 の既定の引数)
pub fn layout_document(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
) -> Result<LayoutDocumentResult, LayoutError> {
    layout_document_with_counts(input, groups, groups_of, options, max_passes)
        .map(|(result, _)| result)
}

/// 原文なし (layout_document の本体)。配置の結果と、箱にした枠の数、loose の枠の数を返す。
/// options の extra_spacing は使わず、枠から作り直す (view の `{ ...MARKMAP_DEFAULTS, extraSpacing }` と同じく上書き)。
/// max_passes は繰り返しの上限で、0 は 1 と同じ (境界から 0 が来ても 1 回は配置する。A-170)
pub fn layout_document_with_counts(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
) -> Result<(LayoutDocumentResult, FrameBoxCounts), LayoutError> {
    let mut options = options.unwrap_or(MARKMAP_DEFAULTS);
    options.extra_spacing = None;
    let max_passes = max_passes.unwrap_or(MAX_LAYOUT_PASSES).max(1);
    // 入口の検査 (A-156 の (b))。大きさは project が、指定の数はここで、枠の余白より前に弾く
    check_layout_options(&options)?;

    let graph = project(input)?;
    let children_of = layout_children_of(&graph);
    let frames = compute_frames(&graph, groups, groups_of, &children_of);

    if frames.is_empty() {
        // 枠のない文書は旧の流れの 1 回目そのもの (I3。枠が空の ExtraSpacing も旧と同じに渡す)
        let result = layout_graph(
            &graph,
            Some(LayoutOptions {
                extra_spacing: Some(ExtraSpacing {
                    frames: Vec::new(),
                    rects: None,
                }),
                ..options
            }),
        )?;
        let counts = FrameBoxCounts { boxed: 0, loose: 0 };
        return Ok((finish(graph, frames, result, 1, &[]), counts));
    }

    let blocks = frame_blocks(&graph, &frames, &children_of);
    let counts = FrameBoxCounts {
        boxed: blocks.blocks.len(),
        loose: blocks.loose.len(),
    };
    let loose: Vec<Frame> = blocks
        .loose
        .iter()
        .filter_map(|&index| frames.get(index).cloned())
        .collect();

    // PERF(spec): 回ごとの結果を全部持つので、境界の maxPasses が大きいとメモリが回数に比例する。最良の回だけを持てば足りる (G-011)
    let mut results: Vec<LayoutResult> = Vec::new();
    let mut scores: Vec<(usize, f64)> = Vec::new();
    let mut previous: Option<IndexMap<u32, Rect>> = None;
    for _ in 0..max_passes {
        // 1 回目は前回の矩形がないので、loose の枠の余白は frame_clearance のぶんだけ見込む (旧の流れの 1 回目と同じ)
        let spacing = frame_spacing(&loose, previous.as_ref());
        let mut between = |upper: u32, lower: u32| spacing.between(upper, lower);
        let result = layout_graph_framed(
            &graph,
            Some(options.clone()),
            Some(&mut between),
            &children_of,
            &frames,
            &blocks,
        )?;
        let rects = rects_of(&result);
        // 箱の枠は段 1〜4 の形で 0 の見込みだが、数えから外さない (B-9)
        let intruders = label_row_intruders(&frames, &rects, &result);
        scores.push((intruders, result.bounds.width * result.bounds.height));
        results.push(result);
        if intruders == 0 || loose.is_empty() {
            break;
        }
        previous = Some(rects);
    }
    let pass = adopted_pass(&scores);
    let result = results.swap_remove(pass - 1);
    let targets = partly_shared_loose(&frames, &blocks);
    Ok((finish(graph, frames, result, pass, &targets), counts))
}

// Q4-b の採る回 (1 始まり)。scores は回ごとの (入り込みの数, bounds の面積) で、入り込みが 0 の回があればそこで終わる。
// 入り込みが最も少ない回、同じなら面積が小さい回、さらに同じなら早い回。面積が NaN の回は面積で選ばれない
fn adopted_pass(scores: &[(usize, f64)]) -> usize {
    let mut best = 0;
    for (index, &(intruders, area)) in scores.iter().enumerate().skip(1) {
        let (kept_intruders, kept_area) = scores[best];
        if intruders < kept_intruders || (intruders == kept_intruders && area < kept_area) {
            best = index;
        }
    }
    best + 1
}

// Q4-b の止め方と採る回の比べ方で使う入り込みの数 (設計 3 章の I1 の定義。G-009)。
// 全部の枠 (箱と loose) について、ずらす前の outline (frame_outline) をラベルの行ぶん上へ広げた矩形に、
// メンバーでないノードの矩形 (gap を左に足した矩形でも見る) が許容を超えて重なる組の数。幅か高さが 0 のノードは除く。
// 旧の count_intruders はラベルの行を見ないので、入り込みがラベルの行にだけある回で止まってしまう
// PERF(spec): frame.members の contains は線形探索で、枠 × ノード × メンバー (loose の枠があるときだけ回ごとに走る)
fn label_row_intruders(
    frames: &[Frame],
    rects: &IndexMap<u32, Rect>,
    result: &LayoutResult,
) -> usize {
    let mut count = 0;
    for frame in frames {
        let Some(outline) = frame_outline(frame, rects) else {
            continue;
        };
        let area = with_label(&outline);
        for (id, placed) in &result.nodes {
            let rect = &placed.rect;
            if rect.width > 0.0
                && rect.height > 0.0
                && !frame.members.contains(id)
                && (rects_overlap(rect, &area) || rects_overlap(&with_gap(rect, placed.gap), &area))
            {
                count += 1;
            }
        }
    }
    count
}

fn with_gap(rect: &Rect, gap: f64) -> Rect {
    Rect {
        x: rect.x - gap,
        width: rect.width + gap,
        ..*rect
    }
}

fn rects_of(result: &LayoutResult) -> IndexMap<u32, Rect> {
    result
        .nodes
        .iter()
        .map(|(id, placed)| (*id, placed.rect))
        .collect()
}

// 採った回の配置から境界の形を作る。枠の outline はその回の矩形から作り、
// targets (一部共有する loose の枠) だけ交差と分かる形へずらす (E-1)
fn finish(
    graph: VisibleGraph,
    frames: Vec<Frame>,
    result: LayoutResult,
    pass: usize,
    targets: &[(usize, Vec<usize>)],
) -> LayoutDocumentResult {
    let rects = rects_of(&result);
    let gaps: IndexMap<u32, f64> = result
        .nodes
        .iter()
        .map(|(id, placed)| (*id, placed.gap))
        .collect();
    let mut outlines: Vec<Option<Rect>> = frames
        .iter()
        .map(|frame| frame_outline(frame, &rects))
        .collect();
    shift_shared_outlines(&frames, targets, &rects, &gaps, &mut outlines);
    let frames = frames
        .into_iter()
        .zip(outlines)
        .map(|(frame, outline)| LayoutDocumentFrame { frame, outline })
        .collect();
    LayoutDocumentResult {
        graph,
        frames,
        rects,
        gaps,
        edges: result.edges,
        bounds: result.bounds,
        planned_x: result.planned_x,
        node_size: result.flextree_params.node_size,
        passes: pass,
        spacing: result.flextree_params.spacing,
    }
}

// 3 章の「重なる」の許容 (接するだけは数えない)
const OVERLAP_TOLERANCE: f64 = 0.5;

fn right_of(rect: &Rect) -> f64 {
    rect.x + rect.width
}

fn y_overlaps(a: &Rect, b: &Rect) -> bool {
    (a.y + a.height).min(b.y + b.height) - a.y.max(b.y) > OVERLAP_TOLERANCE
}

fn rects_overlap(a: &Rect, b: &Rect) -> bool {
    right_of(a).min(right_of(b)) - a.x.max(b.x) > OVERLAP_TOLERANCE && y_overlaps(a, b)
}

fn with_label(outline: &Rect) -> Rect {
    Rect {
        y: outline.y - LABEL_HEIGHT,
        height: outline.height + LABEL_HEIGHT,
        ..*outline
    }
}

// 両方に属するノードがあり、どちらも他方の部分集合でない
// PERF(spec): members の contains は線形探索で、組ごとにメンバー × メンバー。b.members を HashSet にすれば線形 (loose の枠があるときだけ走る)
fn partly_shares(a: &Frame, b: &Frame) -> bool {
    let common = a.members.iter().filter(|id| b.members.contains(id)).count();
    common > 0 && common < a.members.len() && common < b.members.len()
}

// ずらす対象: loose の枠のうち、箱にした枠とメンバーを一部共有するもの。
// (frames の添字, 一部共有する箱の枠の添字) を frames の順に並べる
fn partly_shared_loose(frames: &[Frame], blocks: &FrameBlocks) -> Vec<(usize, Vec<usize>)> {
    blocks
        .loose
        .iter()
        .filter_map(|&loose| {
            let boxed: Vec<usize> = blocks
                .blocks
                .iter()
                .map(|block| block.frame)
                .filter(|&boxed| partly_shares(&frames[loose], &frames[boxed]))
                .collect();
            (!boxed.is_empty()).then_some((loose, boxed))
        })
        .collect()
}

// E-1 (設計 3 章の「メンバーを一部共有する枠の組の見た目」)。
// 対象の枠の outline の左の辺を side/2 右へ (含まれる枠の左の辺を越えない所まで) 動かし、右の辺を max(自分の右の辺, 共有する箱の枠の右の辺) + side × 2 まで広げる。
// 右の辺は、メンバーでないノード (gap 込み)、メンバーの交わらない枠 (ラベルの行込み) の左の端と、その枠を含む枠の右の辺で止め、
// 自分の右の辺より内側には戻さない。止めた右の辺が箱の枠の右の辺を越えなければ、右で交差が見えないのでずらさない。
// 先に決めた対象のずれは後の対象の障害に入る。ノードの矩形は動かさない
// PERF(spec): frame.members の contains は線形探索で、ノード × メンバーと枠 × メンバー × メンバー。対象ごとに frame.members を HashSet にすれば減る
fn shift_shared_outlines(
    frames: &[Frame],
    targets: &[(usize, Vec<usize>)],
    rects: &IndexMap<u32, Rect>,
    gaps: &IndexMap<u32, f64>,
    outlines: &mut [Option<Rect>],
) {
    for (index, boxed) in targets {
        let index = *index;
        let frame = &frames[index];
        let Some(base) = outlines[index] else {
            continue;
        };
        let side = frame_padding(frame.level).side;
        let area = with_label(&base);
        let box_right = boxed
            .iter()
            .filter_map(|&b| outlines[b].map(|outline| right_of(&outline)))
            .fold(f64::NEG_INFINITY, f64::max);
        let mut edge = right_of(&base).max(box_right) + side * 2.0;
        let mut clip = |obstacle: &Rect| {
            if !rects_overlap(obstacle, &area)
                && right_of(obstacle) > right_of(&base)
                && y_overlaps(obstacle, &area)
            {
                edge = edge.min(obstacle.x);
            }
        };
        for (id, rect) in rects {
            if rect.width > 0.0 && rect.height > 0.0 && !frame.members.contains(id) {
                let gap = gaps.get(id).copied().unwrap_or(0.0);
                clip(&Rect {
                    x: rect.x - gap,
                    width: rect.width + gap,
                    ..*rect
                });
            }
        }
        let mut enclosing = f64::INFINITY;
        for (other, entry) in frames.iter().enumerate() {
            let Some(outline) = outlines[other] else {
                continue;
            };
            if other == index {
                continue;
            }
            if !entry.members.iter().any(|id| frame.members.contains(id)) {
                clip(&with_label(&outline));
            } else if frame.members.iter().all(|id| entry.members.contains(id)) {
                enclosing = enclosing.min(right_of(&outline));
            }
        }
        let edge = edge.min(enclosing).max(right_of(&base));
        if edge > box_right + OVERLAP_TOLERANCE {
            // 左の辺は、L に含まれる枠 F (F のメンバーがすべて L のメンバー、F ≠ L) の左の辺
            // (F が先に決めた対象ならずらした後の値) を越えない所まで。含む枠を含まれる枠からはみ出させない (レビュー B-2)。
            // base の左の辺より左には戻さない
            let x = frames
                .iter()
                .enumerate()
                .filter(|&(other, entry)| {
                    other != index && entry.members.iter().all(|id| frame.members.contains(id))
                })
                .filter_map(|(other, _)| outlines[other].map(|outline| outline.x))
                .fold(base.x + side / 2.0, f64::min)
                .max(base.x);
            outlines[index] = Some(Rect {
                x,
                width: edge - x,
                ..base
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LayoutInputEdge, LayoutInputNode};

    fn group(id: &str) -> GroupDef {
        GroupDef {
            id: id.to_string(),
            label: id.to_string(),
            color: None,
            boundary: true,
            defined: true,
            icon: None,
        }
    }

    // 1 ─ 2 (g) ─ 3 (g) の枝と、2 の兄弟の葉 4 を持つ木。枠 g は 2 と 3 を囲む
    fn input() -> LayoutInput {
        let node = |id: u32, groups: &[&str]| LayoutInputNode {
            id,
            label: format!("n{id}"),
            width: 40.0,
            height: 20.0,
            groups: groups.iter().map(|name| (*name).to_string()).collect(),
        };
        let edge = |source, target| LayoutInputEdge { source, target };
        LayoutInput {
            name: "pipeline".to_string(),
            nodes: vec![node(1, &[]), node(2, &["g"]), node(3, &["g"]), node(4, &[])],
            tree_edges: vec![edge(1, 2), edge(2, 3), edge(1, 4)],
            relations: Vec::new(),
            suppress_root_line: Vec::new(),
            folded: Vec::new(),
        }
    }

    fn groups_of() -> IndexMap<u32, Vec<String>> {
        IndexMap::from([(2, vec!["g".to_string()]), (3, vec!["g".to_string()])])
    }

    #[test]
    fn pipeline_without_frames_is_one_pass_of_layout_graph() {
        let result = layout_document(&input(), &[], &IndexMap::new(), None, None).unwrap();
        assert_eq!(result.passes, 1);
        assert!(result.frames.is_empty());
        let graph = project(&input()).unwrap();
        let plain = layout_graph(&graph, None).unwrap();
        let rects: IndexMap<u32, Rect> = plain.nodes.iter().map(|(id, p)| (*id, p.rect)).collect();
        assert_eq!(result.rects, rects);
        assert_eq!(result.graph, graph);
    }

    #[test]
    fn pipeline_frames_carry_outline_of_last_pass() {
        let result = layout_document(&input(), &[group("g")], &groups_of(), None, None).unwrap();
        assert_eq!(result.frames.len(), 1);
        assert_eq!(result.frames[0].frame.members, vec![2, 3]);
        assert_eq!(
            result.frames[0].outline,
            frame_outline(&result.frames[0].frame, &result.rects)
        );
        assert!(result.passes >= 1 && result.passes <= MAX_LAYOUT_PASSES);
    }

    #[test]
    fn pipeline_max_passes_zero_stops_after_first_pass() {
        let one = layout_document(&input(), &[group("g")], &groups_of(), None, Some(1)).unwrap();
        let zero = layout_document(&input(), &[group("g")], &groups_of(), None, Some(0)).unwrap();
        assert_eq!((one.passes, zero.passes), (1, 1));
        assert_eq!(one, zero);
    }

    #[test]
    fn pipeline_ignores_extra_spacing_given_in_options() {
        let given = LayoutOptions {
            extra_spacing: Some(ExtraSpacing {
                frames: Vec::new(),
                rects: Some(IndexMap::from([(
                    2,
                    Rect {
                        x: 0.0,
                        y: -500.0,
                        width: 1.0,
                        height: 1000.0,
                    },
                )])),
            }),
            ..MARKMAP_DEFAULTS
        };
        let with =
            layout_document(&input(), &[group("g")], &groups_of(), Some(given), None).unwrap();
        let without = layout_document(&input(), &[group("g")], &groups_of(), None, None).unwrap();
        assert_eq!(with, without);
    }

    #[test]
    fn pipeline_boundary_json_has_contract_fields_only() {
        let result = layout_document(&input(), &[group("g")], &groups_of(), None, None).unwrap();
        let value = serde_json::to_value(&result).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            vec![
                "graph", "frames", "rects", "gaps", "edges", "bounds", "plannedX", "nodeSize",
                "passes"
            ]
        );
        let frame_keys: Vec<&str> = value["frames"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(frame_keys, vec!["group", "members", "level", "outline"]);
        let back: LayoutDocumentResult = serde_json::from_value(value).unwrap();
        assert_eq!(back.spacing, Vec::new());
        assert_eq!(
            LayoutDocumentResult {
                spacing: Vec::new(),
                ..result
            },
            back
        );
    }

    #[test]
    fn pipeline_propagates_project_error() {
        let mut empty = input();
        empty.nodes.clear();
        let direct = project(&empty).err();
        assert!(direct.is_some());
        let piped = layout_document(&empty, &[], &IndexMap::new(), None, None).err();
        assert_eq!(direct, piped);
    }

    // 段 5 (配置の流れ) の単体テスト。期待は設計 (段 5 の「確かめること」、3 章の不変条件と重なりの規定、Q4-b、7 章の出口と passes) から導く。
    // 実装より先に書いたので、次のシグネチャを仮定する (実装役が変えたら、ここと記録を合わせる):
    //     pub struct FrameBoxCounts { pub boxed: usize, pub loose: usize }   (Debug, Clone, Copy, PartialEq, Eq)
    //     pub fn layout_document_with_counts(input: &LayoutInput, groups: &[GroupDef], groups_of: &IndexMap<u32, Vec<String>>,
    //         options: Option<LayoutOptions>, max_passes: Option<usize>) -> Result<(LayoutDocumentResult, FrameBoxCounts), LayoutError>
    //     fn adopted_pass(scores: &[(usize, f64)]) -> usize
    //         回ごとの (入り込みの数, bounds の面積) の並びから、採る回 (1 始まり) を返す。並びは入り込みが 0 の回で終わる
    mod flow {
        use std::collections::HashSet;

        use indexmap::IndexMap;

        use super::super::{
            FrameBoxCounts, LayoutDocumentResult, MAX_LAYOUT_PASSES, adopted_pass, layout_document,
            layout_document_with_counts,
        };
        use super::{group, groups_of as small_groups_of, input as small_input};
        use crate::layout::frames::{
            Frame, LABEL_HEIGHT, compute_frames, count_intruders, frame_blocks, frame_outline,
            frame_spacing,
        };
        use crate::layout::layout::{
            ExtraSpacing, LayoutOptions, MARKMAP_DEFAULTS, layout_children_of, layout_graph,
            layout_graph_framed,
        };
        use crate::layout::project::{VisibleEdgeKind, project};
        use crate::model::model::{ModelOptions, build_model};
        use crate::parse::parse_document;
        use crate::types::{
            GroupDef, LayoutInput, LayoutInputEdge, LayoutInputNode, LayoutInputRelation, Rect,
            RelationKind, Severity,
        };

        // 3 章の許容 (接するだけは数えない)
        const TOLERANCE: f64 = 0.5;

        // loose-frames.md の例 1 の文書の写し (元の置き場所は git に入らないので、ここに写す)
        const EXAMPLE1: &str = concat!(
            "---\n",
            "title: 画面の改修\n",
            "markdag:\n",
            "    relations:\n",
            "        chain:\n",
            "            - 設計 --> エラー文言と案内文の見直し\n",
            "            - 入力画面の改修 --> 告知\n",
            "    groups:\n",
            "        copy:\n",
            "            label: 文言チーム\n",
            "            color: \"#E0A100\"\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 入力画面の改修\n",
            "                - エラー文言と案内文の見直し\n",
            "---\n",
            "\n",
            "# 画面の改修\n",
            "\n",
            "## 設計\n",
            "- 入力画面の改修\n",
            "\n",
            "## エラー文言と案内文の見直し\n",
            "\n",
            "## 告知\n",
        );

        // loose-frames.md の例 2 の文書の写し
        const EXAMPLE2: &str = concat!(
            "---\n",
            "title: 決済の導入\n",
            "markdag:\n",
            "    relations:\n",
            "        chain:\n",
            "            - 開発 --> 脆弱性診断 --> 本番反映\n",
            "    groups:\n",
            "        security:\n",
            "            label: セキュリティ確認\n",
            "            color: \"#D64545\"\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 決済APIとWebhookの実装\n",
            "                - 脆弱性診断\n",
            "---\n",
            "\n",
            "# 決済の導入\n",
            "\n",
            "## 開発\n",
            "- 画面\n",
            "- 決済APIとWebhookの実装\n",
            "\n",
            "## 脆弱性診断\n",
            "\n",
            "## 本番反映\n",
        );

        // design.md の Q4 の例 4 (一部だけ重なる枠)。groups の順は p、q
        const EXAMPLE4: &str = concat!(
            "---\n",
            "title: 一部だけ重なる枠\n",
            "markdag:\n",
            "    groups:\n",
            "        p:\n",
            "            label: 企画\n",
            "            boundary: true\n",
            "        q:\n",
            "            label: 開発\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 一部だけ重なる枠\n",
            "\n",
            "## 要件 %p\n",
            "\n",
            "## 試作 %p %q\n",
            "- 画面\n",
            "- API\n",
            "- 計測\n",
            "\n",
            "## 実装 %q\n",
        );

        // レビュー B-1 の入力: 例 4 (partial-share-heading) の「試作」の子を 2 つにしたもの。
        // 1 回目は loose の q の上の張り出しを frame_clearance でしか見込めず、要件が q のラベルの行にだけ入る
        const EXAMPLE4_TWO_CHILDREN: &str = concat!(
            "---\n",
            "title: 一部共有と出口\n",
            "markdag:\n",
            "    groups:\n",
            "        p:\n",
            "            label: 企画\n",
            "            boundary: true\n",
            "        q:\n",
            "            label: 開発\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 一部共有と出口\n",
            "\n",
            "## 要件 %p\n",
            "\n",
            "## 試作 %p %q\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 実装 %q\n",
        );

        const NOTATION: &str = include_str!("../../../../docs/examples/notation.md");

        // 枠のない文書の I3 の入力 (名前、入力、groups、groups_of)
        type FramelessCase<'a> = (
            &'a str,
            &'a LayoutInput,
            Vec<GroupDef>,
            IndexMap<u32, Vec<String>>,
        );

        struct Document {
            input: LayoutInput,
            groups: Vec<GroupDef>,
            groups_of: IndexMap<u32, Vec<String>>,
        }

        // 審判の harness と同じ疑似の大きさ (参照用のテキストのコードポイントの数 x 8 + 16、高さは 20 + 改行の数 x 14) で入力を組む
        fn document(source: &str) -> Document {
            let parsed = parse_document(source);
            let model = build_model(
                &parsed.nodes,
                &parsed.frontmatter,
                Some(source),
                &ModelOptions::default(),
            );
            let errors: Vec<&str> = model
                .diagnostics
                .iter()
                .filter(|item| item.severity == Severity::Error)
                .map(|item| item.code.as_str())
                .collect();
            assert!(errors.is_empty(), "文書に error がある: {errors:?}");
            let nodes = parsed
                .nodes
                .iter()
                .map(|node| LayoutInputNode {
                    id: node.id,
                    label: node.ref_text.clone(),
                    width: if node.ref_text.is_empty() {
                        0.0
                    } else {
                        node.ref_text.chars().count() as f64 * 8.0 + 16.0
                    },
                    height: 20.0 + node.html.matches('\n').count() as f64 * 14.0,
                    groups: node.groups.clone(),
                })
                .collect();
            let tree_edges = parsed
                .nodes
                .iter()
                .filter_map(|node| {
                    node.parent.map(|parent| LayoutInputEdge {
                        source: parent,
                        target: node.id,
                    })
                })
                .collect();
            Document {
                input: LayoutInput {
                    name: "flow".to_string(),
                    nodes,
                    tree_edges,
                    relations: model.relations.clone(),
                    suppress_root_line: model.suppress_root_line.clone(),
                    folded: Vec::new(),
                },
                groups: model.groups.clone(),
                groups_of: model.groups_of.clone(),
            }
        }

        // 例 4 の groups の順を入れ替えたもの (q が先)
        fn example4_q_first() -> Document {
            let swapped = EXAMPLE4.replace(
                    "        p:\n            label: 企画\n            boundary: true\n        q:\n            label: 開発\n            boundary: true\n",
                    "        q:\n            label: 開発\n            boundary: true\n        p:\n            label: 企画\n            boundary: true\n",
                );
            assert_ne!(swapped, EXAMPLE4);
            document(&swapped)
        }

        // docs/examples/notation.md を縮めたもの (試作の単体テストの入力)。1 root / 2 要件 / 3 設計 %d (4 画面、5 API) /
        // 6 実装 %b (7 FE (8、9、10)、11 BE (12、13)) / 14 検証 (15、16)。要件 --> 設計/*、設計 --> 実装 --> 検証、10 & 13 --> 検証、12 --> 9
        fn notation_like() -> Document {
            let parents: [(u32, u32); 15] = [
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
            let relation = |kind, source, target| LayoutInputRelation {
                source,
                target,
                kind,
                origin: format!("{source} --> {target}"),
            };
            let input = LayoutInput {
                name: "notation-like".to_string(),
                nodes: (1..=16)
                    .map(|id| LayoutInputNode {
                        id,
                        label: format!("n{id}"),
                        width: 60.0,
                        height: 20.0,
                        groups: Vec::new(),
                    })
                    .collect(),
                tree_edges: parents
                    .iter()
                    .map(|&(source, target)| LayoutInputEdge { source, target })
                    .collect(),
                relations: vec![
                    relation(RelationKind::Fork, 2, 4),
                    relation(RelationKind::Fork, 2, 5),
                    relation(RelationKind::Chain, 3, 6),
                    relation(RelationKind::Chain, 6, 14),
                    relation(RelationKind::Join, 10, 14),
                    relation(RelationKind::Join, 13, 14),
                    relation(RelationKind::Depends, 12, 9),
                ],
                suppress_root_line: vec![6, 14],
                folded: Vec::new(),
            };
            let groups_of = (1..=16)
                .map(|id| {
                    let list = match id {
                        3..=5 => vec!["d".to_string()],
                        6..=13 => vec!["b".to_string()],
                        _ => Vec::new(),
                    };
                    (id, list)
                })
                .collect();
            Document {
                input,
                groups: vec![group("d"), group("b")],
                groups_of,
            }
        }

        fn run(doc: &Document) -> (LayoutDocumentResult, FrameBoxCounts) {
            layout_document_with_counts(&doc.input, &doc.groups, &doc.groups_of, None, None)
                .unwrap()
        }

        fn id_of(doc: &Document, label: &str) -> u32 {
            doc.input
                .nodes
                .iter()
                .find(|node| node.label == label)
                .map(|node| node.id)
                .unwrap_or_else(|| panic!("ノード {label} がない"))
        }

        fn frames_of(result: &LayoutDocumentResult) -> Vec<Frame> {
            result
                .frames
                .iter()
                .map(|entry| entry.frame.clone())
                .collect()
        }

        fn group_ids(result: &LayoutDocumentResult) -> Vec<&str> {
            result
                .frames
                .iter()
                .map(|entry| entry.frame.group.id.as_str())
                .collect()
        }

        // 3 章の「重なる」: x の重なりの幅と y の重なりの幅が、どちらも許容を超える
        fn overlaps(a: &Rect, b: &Rect) -> bool {
            let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
            let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
            x > TOLERANCE && y > TOLERANCE
        }

        fn contains(outer: &Rect, inner: &Rect) -> bool {
            inner.x >= outer.x - TOLERANCE
                && inner.y >= outer.y - TOLERANCE
                && inner.x + inner.width <= outer.x + outer.width + TOLERANCE
                && inner.y + inner.height <= outer.y + outer.height + TOLERANCE
        }

        // 3 章の「枠の矩形」: outline を上へ LABEL_HEIGHT 広げたもの
        fn with_label(outline: &Rect) -> Rect {
            Rect {
                y: outline.y - LABEL_HEIGHT,
                height: outline.height + LABEL_HEIGHT,
                ..*outline
            }
        }

        // view の withGap: 本体の左に確保した余白を足した矩形
        fn with_gap(rect: &Rect, gap: f64) -> Rect {
            Rect {
                x: rect.x - gap,
                width: rect.width + gap,
                ..*rect
            }
        }

        // I1: 枠の矩形に入る、メンバーでないノード (本体の矩形か、gap を足した矩形のどちらかが重なる)。幅か高さが 0 のノードは除く
        fn intruders(result: &LayoutDocumentResult, index: usize) -> Vec<u32> {
            let entry = &result.frames[index];
            let Some(outline) = entry.outline else {
                return Vec::new();
            };
            let area = with_label(&outline);
            result
                .rects
                .iter()
                .filter(|(id, rect)| {
                    let gap = result.gaps.get(*id).copied().unwrap_or(0.0);
                    rect.width > 0.0
                        && rect.height > 0.0
                        && !entry.frame.members.contains(id)
                        && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
                })
                .map(|(id, _)| *id)
                .collect()
        }

        fn shares_members(a: &Frame, b: &Frame) -> bool {
            a.members.iter().any(|id| b.members.contains(id))
        }

        fn is_subset(inner: &Frame, outer: &Frame) -> bool {
            inner.members.iter().all(|id| outer.members.contains(id))
        }

        pub(super) struct Report {
            pub(super) boxed: Vec<usize>,
            pub(super) loose: Vec<usize>,
            pub(super) loose_intruders: usize,
            pub(super) loose_overlaps: usize,
        }

        // 3 章の不変条件 I1、I2、I10、I5 を結果だけから確かめる。箱にした枠は 0 を assert し、loose の枠が関わるものは数えて返す。
        // 箱かどうかは、結果の graph と frames に frame_blocks (段 1) を当てて決める
        pub(super) fn check_invariants(
            name: &str,
            result: &LayoutDocumentResult,
            options: &LayoutOptions,
        ) -> Report {
            let frames = frames_of(result);
            let blocks = frame_blocks(&result.graph, &frames, &layout_children_of(&result.graph));
            let boxed: HashSet<usize> = blocks.blocks.iter().map(|block| block.frame).collect();
            let mut report = Report {
                boxed: {
                    let mut list: Vec<usize> = boxed.iter().copied().collect();
                    list.sort_unstable();
                    list
                },
                loose: blocks.loose.clone(),
                loose_intruders: 0,
                loose_overlaps: 0,
            };
            for (index, frame) in frames.iter().enumerate() {
                let found = intruders(result, index);
                if boxed.contains(&index) {
                    assert!(
                        found.is_empty(),
                        "{name}: 箱にした枠 {} {:?} にメンバーでないノード {found:?} が入る (I1)",
                        frame.group.id,
                        frame.members
                    );
                } else {
                    report.loose_intruders += found.len();
                }
            }
            for a in 0..frames.len() {
                for b in a + 1..frames.len() {
                    let (Some(outline_a), Some(outline_b)) =
                        (result.frames[a].outline, result.frames[b].outline)
                    else {
                        continue;
                    };
                    let (frame_a, frame_b) = (&frames[a], &frames[b]);
                    let path = format!("{name}: 枠 {} と {}", frame_a.group.id, frame_b.group.id);
                    if !shares_members(frame_a, frame_b) {
                        // I2: メンバーが交わらない枠どうし
                        let hit = overlaps(&with_label(&outline_a), &with_label(&outline_b));
                        if boxed.contains(&a) && boxed.contains(&b) {
                            assert!(!hit, "{path}: メンバーが交わらない箱の枠が重なる (I2)");
                        } else if hit {
                            report.loose_overlaps += 1;
                        }
                        continue;
                    }
                    // メンバーを共有する組は規定で重なってよい。入れ子の箱の形 (I10) だけを見る
                    if !(boxed.contains(&a) && boxed.contains(&b)) {
                        continue;
                    }
                    let (inner, outer) =
                        if is_subset(frame_a, frame_b) && frame_a.level < frame_b.level {
                            (a, b)
                        } else if is_subset(frame_b, frame_a) && frame_b.level < frame_a.level {
                            (b, a)
                        } else if is_subset(frame_a, frame_b) && is_subset(frame_b, frame_a) {
                            // TODO(spec): メンバーも level も同じ 2 つの枠 (同じ id のグループが 2 つ) は、設計に内と外の決め方がない。
                            // 同じメンバーから作る矩形なので、同じ outline になることだけを見る
                            assert_eq!(outline_a, outline_b, "{path}: メンバーも level も同じ枠");
                            continue;
                        } else {
                            panic!("{path}: メンバーが一部だけ重なる枠を、両方とも箱にした");
                        };
                    let inner_area = with_label(&result.frames[inner].outline.unwrap());
                    let outer_outline = result.frames[outer].outline.unwrap();
                    assert!(
                        contains(&outer_outline, &inner_area),
                        "{path}: 内側の枠がラベルの行ごと外側の枠に収まらない (I10)"
                    );
                }
            }
            check_left_to_right(name, result, options);
            report
        }

        // I5: rect.x と plannedX の差が 0.5 以下。配置上の親子と、配置の計算から外されていない relations で、
        // 終点の rect.x ≥ 始点の右の端 + spacing_horizontal − 0.5
        fn check_left_to_right(name: &str, result: &LayoutDocumentResult, options: &LayoutOptions) {
            for (id, rect) in &result.rects {
                let planned = result.planned_x[id];
                assert!(
                    (rect.x - planned).abs() <= TOLERANCE,
                    "{name}: ノード {id} の x {} が plannedX {planned} と違う (I5)",
                    rect.x
                );
            }
            let mut pairs: Vec<(u32, u32)> = result
                .graph
                .layout_parent
                .iter()
                .map(|(child, parent)| (*parent, *child))
                .collect();
            for edge in &result.graph.edges {
                if edge.kind == VisibleEdgeKind::Tree || edge.excluded_from_layout {
                    continue;
                }
                if options.ignore_proxied_depends == Some(true)
                    && edge.kind == VisibleEdgeKind::Depends
                    && edge.proxied
                {
                    continue;
                }
                pairs.push((edge.source, edge.target));
            }
            for (source, target) in pairs {
                let (Some(from), Some(to)) = (result.rects.get(&source), result.rects.get(&target))
                else {
                    continue;
                };
                assert!(
                    to.x >= from.x + from.width + options.spacing_horizontal - TOLERANCE,
                    "{name}: {source} → {target} で終点が始点の右に来ない (I5)"
                );
            }
        }

        // Q4-b の止め方と採る回の比べ方で使う入り込みの数 (G-009): 全部の枠 (箱と loose) について、ずらす前の outline
        // (frame_outline) をラベルの行ごと見た枠の矩形に、メンバーでないノードの矩形 (gap を左に足した矩形でも見る) が
        // 許容 0.5 を超えて重なる組の数。3 章の I1 の定義と同じ。幅か高さが 0 のノードは除く
        fn label_row_intruders(
            frames: &[Frame],
            rects: &IndexMap<u32, Rect>,
            gaps: &IndexMap<u32, f64>,
        ) -> usize {
            let mut count = 0;
            for frame in frames {
                let Some(outline) = frame_outline(frame, rects) else {
                    continue;
                };
                let area = with_label(&outline);
                for (id, rect) in rects {
                    let gap = gaps.get(id).copied().unwrap_or(0.0);
                    if rect.width > 0.0
                        && rect.height > 0.0
                        && !frame.members.contains(id)
                        && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
                    {
                        count += 1;
                    }
                }
            }
            count
        }

        // Q4-b を設計の文から組んだ参照。loose の枠だけを前回の矩形の余白 (between) に渡して layout_graph_framed を回し、
        // 入り込みの数 (label_row_intruders。G-009) が 0 の回か上限で止める
        struct ReferencePass {
            intruders: usize,
            area: f64,
            rects: IndexMap<u32, Rect>,
        }

        fn reference_passes(
            doc: &Document,
            options: &LayoutOptions,
            max_passes: usize,
        ) -> Vec<ReferencePass> {
            let graph = project(&doc.input).unwrap();
            let children_of = layout_children_of(&graph);
            let frames = compute_frames(&graph, &doc.groups, &doc.groups_of, &children_of);
            let blocks = frame_blocks(&graph, &frames, &children_of);
            let loose: Vec<Frame> = blocks
                .loose
                .iter()
                .map(|&index| frames[index].clone())
                .collect();
            let mut passes: Vec<ReferencePass> = Vec::new();
            let mut previous: Option<IndexMap<u32, Rect>> = None;
            for _ in 0..max_passes.max(1) {
                // 1 回目も loose の枠を前回の矩形なし (frame_clearance のぶん) で渡す (旧と試作の流れと同じ。段 5 の実装がこの読みで実装した)
                let spacing = frame_spacing(&loose, previous.as_ref());
                let mut between = |upper: u32, lower: u32| spacing.between(upper, lower);
                let layout = layout_graph_framed(
                    &graph,
                    Some(LayoutOptions {
                        extra_spacing: None,
                        ..options.clone()
                    }),
                    Some(&mut between),
                    &children_of,
                    &frames,
                    &blocks,
                )
                .unwrap();
                let rects: IndexMap<u32, Rect> = layout
                    .nodes
                    .iter()
                    .map(|(id, placed)| (*id, placed.rect))
                    .collect();
                let gaps: IndexMap<u32, f64> = layout
                    .nodes
                    .iter()
                    .map(|(id, placed)| (*id, placed.gap))
                    .collect();
                let intruders = label_row_intruders(&frames, &rects, &gaps);
                passes.push(ReferencePass {
                    intruders,
                    area: layout.bounds.width * layout.bounds.height,
                    rects: rects.clone(),
                });
                if intruders == 0 {
                    break;
                }
                previous = Some(rects);
            }
            passes
        }

        // Q4-b の採る回 (1 始まり): 入り込みが最も少ない回、同じなら面積が小さい回、さらに同じなら早い回
        fn reference_adopted(passes: &[ReferencePass]) -> usize {
            let mut best = 0;
            for (index, pass) in passes.iter().enumerate().skip(1) {
                let kept = &passes[best];
                if pass.intruders < kept.intruders
                    || (pass.intruders == kept.intruders && pass.area < kept.area)
                {
                    best = index;
                }
            }
            best + 1
        }

        fn same_bits<T: std::fmt::Debug>(a: &T, b: &T) -> bool {
            // f64 の Debug は -0 と 0 を分けて出すので、to_bits の比較の代わりにする
            format!("{a:?}") == format!("{b:?}")
        }

        #[test]
        fn pipeline_without_frames_matches_one_old_layout_graph_bit_for_bit() {
            // I3: 枠のない文書 (groups がない、boundary の枠がない、ノードが 1 つのグループに 1 つずつ) は、旧の 1 回の layout_graph と同じ
            let narrow = LayoutOptions {
                spacing_horizontal: 10.0,
                spacing_vertical: 3.0,
                padding_x: 0.0,
                ..MARKMAP_DEFAULTS
            };
            let notation = document(NOTATION);
            let no_boundary: Vec<GroupDef> = notation
                .groups
                .iter()
                .map(|group| GroupDef {
                    boundary: false,
                    ..group.clone()
                })
                .collect();
            let like = notation_like();
            let small = small_input();
            let cases: Vec<FramelessCase> = vec![
                (
                    "notation の groups なし",
                    &notation.input,
                    Vec::new(),
                    IndexMap::new(),
                ),
                (
                    "notation の boundary なし",
                    &notation.input,
                    no_boundary,
                    notation.groups_of.clone(),
                ),
                (
                    "notation_like の groups なし",
                    &like.input,
                    Vec::new(),
                    IndexMap::new(),
                ),
                ("小さな木", &small, Vec::new(), IndexMap::new()),
            ];
            for (name, input, groups, groups_of) in cases {
                for options in [MARKMAP_DEFAULTS, narrow.clone()] {
                    let (result, counts) = layout_document_with_counts(
                        input,
                        &groups,
                        &groups_of,
                        Some(options.clone()),
                        None,
                    )
                    .unwrap();
                    assert!(result.frames.is_empty(), "{name}: 枠がない");
                    assert_eq!(result.passes, 1, "{name}: passes");
                    assert_eq!(counts, FrameBoxCounts { boxed: 0, loose: 0 }, "{name}");
                    let graph = project(input).unwrap();
                    assert_eq!(result.graph, graph, "{name}: graph");
                    // 旧の流れの 1 回目 (枠の余白は、枠が空の ExtraSpacing)
                    let old = layout_graph(
                        &graph,
                        Some(LayoutOptions {
                            extra_spacing: Some(ExtraSpacing {
                                frames: Vec::new(),
                                rects: None,
                            }),
                            ..options.clone()
                        }),
                    )
                    .unwrap();
                    let rects: IndexMap<u32, Rect> =
                        old.nodes.iter().map(|(id, p)| (*id, p.rect)).collect();
                    let gaps: IndexMap<u32, f64> =
                        old.nodes.iter().map(|(id, p)| (*id, p.gap)).collect();
                    assert!(same_bits(&result.rects, &rects), "{name}: rects");
                    assert!(same_bits(&result.gaps, &gaps), "{name}: gaps");
                    assert!(same_bits(&result.edges, &old.edges), "{name}: edges");
                    assert!(same_bits(&result.bounds, &old.bounds), "{name}: bounds");
                    assert!(
                        same_bits(&result.planned_x, &old.planned_x),
                        "{name}: plannedX"
                    );
                    assert!(
                        same_bits(&result.node_size, &old.flextree_params.node_size),
                        "{name}: nodeSize"
                    );
                    assert!(
                        same_bits(&result.spacing, &old.flextree_params.spacing),
                        "{name}: spacing"
                    );
                }
            }
        }

        #[test]
        fn pipeline_example1_boxes_copy_and_keeps_the_notice_out_in_one_pass() {
            let doc = document(EXAMPLE1);
            let (result, counts) = run(&doc);
            assert_eq!(group_ids(&result), ["copy"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(count_intruders(&frames_of(&result), &result.rects), 0);
            let report = check_invariants("例 1", &result, &MARKMAP_DEFAULTS);
            assert_eq!(report.boxed, vec![0]);
            // 告知 (出口の子) は copy の枠の右の外 (I6 の形。Q2-c)
            let notice = result.rects[&id_of(&doc, "告知")];
            let outline = result.frames[0].outline.unwrap();
            assert!(
                notice.x
                    >= outline.x + outline.width + MARKMAP_DEFAULTS.spacing_horizontal - TOLERANCE
            );
        }

        #[test]
        fn pipeline_example2_boxes_security_and_keeps_the_release_out_in_one_pass() {
            let doc = document(EXAMPLE2);
            let (result, counts) = run(&doc);
            assert_eq!(group_ids(&result), ["security"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(count_intruders(&frames_of(&result), &result.rects), 0);
            let report = check_invariants("例 2", &result, &MARKMAP_DEFAULTS);
            assert_eq!(report.boxed, vec![0]);
            let release = result.rects[&id_of(&doc, "本番反映")];
            let outline = result.frames[0].outline.unwrap();
            assert!(
                release.x
                    >= outline.x + outline.width + MARKMAP_DEFAULTS.spacing_horizontal - TOLERANCE
            );
        }

        #[test]
        fn pipeline_notation_has_no_intruders_and_no_frame_overlap_in_one_pass() {
            let doc = document(NOTATION);
            let (result, counts) = run(&doc);
            // qa は boundary がないので枠にならない
            assert_eq!(group_ids(&result), ["design", "build"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(count_intruders(&frames_of(&result), &result.rects), 0);
            let report = check_invariants("notation", &result, &MARKMAP_DEFAULTS);
            assert_eq!((report.loose_intruders, report.loose_overlaps), (0, 0));
            // design と build はメンバーが交わらないので、枠 (ラベルの行を含む) どうしも重ならない
            let (a, b) = (
                with_label(&result.frames[0].outline.unwrap()),
                with_label(&result.frames[1].outline.unwrap()),
            );
            assert!(!overlaps(&a, &b));
            // Q3-b: 実装と検証は、始点を含む枠の右の外に置く
            for (label, frame) in [("実装", 0), ("検証", 1)] {
                let rect = result.rects[&id_of(&doc, label)];
                let outline = result.frames[frame].outline.unwrap();
                assert!(
                    rect.x
                        >= outline.x + outline.width + MARKMAP_DEFAULTS.spacing_horizontal
                            - TOLERANCE,
                    "{label}"
                );
            }
            // I8: 同じ入力なら同じ結果
            let (again, _) = run(&doc);
            assert!(same_bits(&result, &again));
        }

        #[test]
        fn pipeline_notation_like_keeps_invariants_in_one_pass() {
            let doc = notation_like();
            let (result, counts) = run(&doc);
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(count_intruders(&frames_of(&result), &result.rects), 0);
            let report = check_invariants("notation_like", &result, &MARKMAP_DEFAULTS);
            assert_eq!(report.boxed, vec![0, 1]);
        }

        #[test]
        fn pipeline_frames_keep_invariants_with_narrow_horizontal_spacing() {
            // 小さな木の枠 g を、spacing_horizontal を枠の横の余白より狭くして回す (枠の左の辺が親に食い込まない。I1)
            let narrow = LayoutOptions {
                spacing_horizontal: 10.0,
                ..MARKMAP_DEFAULTS
            };
            for doc in [notation_like(), document(NOTATION), document(EXAMPLE1)] {
                let (result, counts) = layout_document_with_counts(
                    &doc.input,
                    &doc.groups,
                    &doc.groups_of,
                    Some(narrow.clone()),
                    None,
                )
                .unwrap();
                assert_eq!(counts.loose, 0);
                assert_eq!(result.passes, 1);
                check_invariants("狭い spacing", &result, &narrow);
            }
            let (result, _) = layout_document_with_counts(
                &small_input(),
                &[group("g")],
                &small_groups_of(),
                Some(narrow.clone()),
                None,
            )
            .unwrap();
            check_invariants("小さな木", &result, &narrow);
        }

        #[test]
        fn pipeline_graph_and_frames_are_those_of_project_and_compute_frames() {
            // I4: graph と枠の group、members、level は、project と compute_frames を直に呼んだ結果と同じ
            for (name, doc) in [
                ("例 1", document(EXAMPLE1)),
                ("例 2", document(EXAMPLE2)),
                ("例 4", document(EXAMPLE4)),
                ("例 4 (q が先)", example4_q_first()),
                ("notation", document(NOTATION)),
                ("notation_like", notation_like()),
            ] {
                let (result, _) = run(&doc);
                let graph = project(&doc.input).unwrap();
                let frames = compute_frames(
                    &graph,
                    &doc.groups,
                    &doc.groups_of,
                    &layout_children_of(&graph),
                );
                assert_eq!(result.graph, graph, "{name}: graph");
                assert_eq!(frames_of(&result), frames, "{name}: frames");
            }
        }

        #[test]
        fn pipeline_partly_overlapping_frames_adopt_the_pass_by_the_q4_rule() {
            // 例 4。p と q はメンバーの数 (5) も level (0) も同じなので、安定な sort で frames の順 (groups に書いた順) が残り、
            // 先の p が箱、q が loose になる。この期待は frames の順に依る (A-6。q を先に書いた場合は次のテスト)
            let doc = document(EXAMPLE4);
            let (result, counts) = run(&doc);
            assert_eq!(group_ids(&result), ["p", "q"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let report = check_invariants("例 4", &result, &MARKMAP_DEFAULTS);
            assert_eq!(
                (report.boxed.clone(), report.loose.clone()),
                (vec![0], vec![1])
            );

            let passes = reference_passes(&doc, &MARKMAP_DEFAULTS, MAX_LAYOUT_PASSES);
            let adopted = reference_adopted(&passes);
            assert!(result.passes >= 1 && result.passes <= MAX_LAYOUT_PASSES);
            assert_eq!(result.passes, adopted, "Q4-b の規則で採る回");
            assert!(
                same_bits(&result.rects, &passes[adopted - 1].rects),
                "採った回の矩形"
            );
            // 入り込みが 0 の回があれば、そこで止めてその回を採る
            if let Some(first_zero) = passes.iter().position(|pass| pass.intruders == 0) {
                assert_eq!(result.passes, first_zero + 1);
            }
            // outline は採った回の矩形から作る。箱の枠 p は frame_outline のまま、loose の q は E-1 の規則どおりにずれる
            // (右へ広げられないときは frame_outline のまま)。依頼者の E-1 の指摘 (2026-09-29) による期待の変更
            assert_eq!(
                result.frames[0].outline,
                frame_outline(&result.frames[0].frame, &result.rects)
            );
            assert_eq!(
                result
                    .frames
                    .iter()
                    .map(|entry| entry.outline)
                    .collect::<Vec<_>>(),
                super::share::expected_outlines(&result)
            );
            // p と q はメンバーを共有するので重なってよい (規定)。q の入り込みは件数を出すだけ
            eprintln!(
                "例 4: passes {}、loose の入り込み {}、loose の枠が関わる重なり {}、回ごとの入り込み {:?}",
                result.passes,
                report.loose_intruders,
                report.loose_overlaps,
                passes.iter().map(|pass| pass.intruders).collect::<Vec<_>>()
            );
        }

        #[test]
        fn pipeline_partly_overlapping_frames_box_the_frame_written_first() {
            // A-6: groups で q を先に書くと、q が箱、p が loose になる (入り込みを受ける枠が入れ替わる)
            let doc = example4_q_first();
            let (result, counts) = run(&doc);
            assert_eq!(group_ids(&result), ["q", "p"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let report = check_invariants("例 4 (q が先)", &result, &MARKMAP_DEFAULTS);
            assert_eq!(
                (report.boxed.clone(), report.loose.clone()),
                (vec![0], vec![1])
            );
            let passes = reference_passes(&doc, &MARKMAP_DEFAULTS, MAX_LAYOUT_PASSES);
            assert_eq!(result.passes, reference_adopted(&passes));
            eprintln!(
                "例 4 (q が先): passes {}、loose の入り込み {}",
                result.passes, report.loose_intruders
            );
        }

        #[test]
        fn pipeline_partly_overlapping_frames_repeat_until_the_label_row_is_clear() {
            // レビュー B-1 (G-009)。Q4-b の止め方と採る回の比べ方の入り込みの数は、3 章の I1 の定義 (ラベルの行を含む枠の矩形、
            // 許容 0.5、gap を足した矩形でも見る) で数える。要件がラベルの行にだけ入る 1 回目で止めず、入り込みが 0 の回まで回す。
            // p が箱、q が loose (groups の順。A-6)
            let doc = document(EXAMPLE4_TWO_CHILDREN);
            let (result, counts) = run(&doc);
            assert_eq!(group_ids(&result), ["p", "q"]);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let passes = reference_passes(&doc, &MARKMAP_DEFAULTS, MAX_LAYOUT_PASSES);
            let counted: Vec<usize> = passes.iter().map(|pass| pass.intruders).collect();
            // 1 回目は要件が q のラベルの行に入る。この入力で「減らせる入り込み」が残ることの前提
            assert!(counted[0] > 0, "1 回目の入り込み {counted:?}");
            let first_zero = counted
                .iter()
                .position(|&count| count == 0)
                .unwrap_or_else(|| panic!("上限までに入り込みが 0 の回がない {counted:?}"));
            assert_eq!(
                result.passes,
                first_zero + 1,
                "回ごとの入り込み {counted:?}"
            );
            assert!(result.passes >= 2);
            assert!(
                same_bits(&result.rects, &passes[first_zero].rects),
                "採った回の矩形"
            );
            let report = check_invariants("B-1", &result, &MARKMAP_DEFAULTS);
            assert_eq!(
                (report.loose_intruders, report.loose_overlaps),
                (0, 0),
                "loose の枠 q の入り込みと重なり"
            );
            let requirement = id_of(&doc, "要件");
            assert!(!intruders(&result, 1).contains(&requirement));
        }

        #[test]
        fn pipeline_passes_is_the_adopted_pass_within_max_passes() {
            // 7 章の passes の意味: 「採った回 (1 始まり)」。max_passes は上限で、0 は 1 と同じ
            let doc = document(EXAMPLE4);
            for max_passes in [0, 1, 2, 3, 4, 6] {
                let result = layout_document(
                    &doc.input,
                    &doc.groups,
                    &doc.groups_of,
                    None,
                    Some(max_passes),
                )
                .unwrap();
                let passes = reference_passes(&doc, &MARKMAP_DEFAULTS, max_passes);
                let adopted = reference_adopted(&passes);
                assert!(
                    result.passes >= 1 && result.passes <= max_passes.max(1),
                    "上限 {max_passes}"
                );
                assert_eq!(result.passes, adopted, "上限 {max_passes}");
                assert!(
                    same_bits(&result.rects, &passes[adopted - 1].rects),
                    "上限 {max_passes}: 採った回の矩形"
                );
            }
            let zero =
                layout_document(&doc.input, &doc.groups, &doc.groups_of, None, Some(0)).unwrap();
            let one =
                layout_document(&doc.input, &doc.groups, &doc.groups_of, None, Some(1)).unwrap();
            assert_eq!(zero, one);
            // loose がなければ 1 (I7)
            for doc in [document(EXAMPLE1), document(NOTATION)] {
                for max_passes in [None, Some(0), Some(4), Some(6)] {
                    let result =
                        layout_document(&doc.input, &doc.groups, &doc.groups_of, None, max_passes)
                            .unwrap();
                    assert_eq!(result.passes, 1);
                }
            }
        }

        #[test]
        fn pipeline_counts_report_boxes_loose_frames_and_the_adopted_pass() {
            // 7 章の出口の案 1: (LayoutDocumentResult, FrameBoxCounts) を返し、前半は layout_document の結果そのもの。
            // 採った回は result.passes で取る
            let cases: Vec<(&str, Document, FrameBoxCounts)> = vec![
                (
                    "枠なし",
                    Document {
                        input: small_input(),
                        groups: Vec::new(),
                        groups_of: IndexMap::new(),
                    },
                    FrameBoxCounts { boxed: 0, loose: 0 },
                ),
                (
                    "小さな木の枠 g",
                    Document {
                        input: small_input(),
                        groups: vec![group("g")],
                        groups_of: small_groups_of(),
                    },
                    FrameBoxCounts { boxed: 1, loose: 0 },
                ),
                (
                    "例 1",
                    document(EXAMPLE1),
                    FrameBoxCounts { boxed: 1, loose: 0 },
                ),
                (
                    "例 2",
                    document(EXAMPLE2),
                    FrameBoxCounts { boxed: 1, loose: 0 },
                ),
                (
                    "notation",
                    document(NOTATION),
                    FrameBoxCounts { boxed: 2, loose: 0 },
                ),
                (
                    "notation_like",
                    notation_like(),
                    FrameBoxCounts { boxed: 2, loose: 0 },
                ),
                (
                    "例 4",
                    document(EXAMPLE4),
                    FrameBoxCounts { boxed: 1, loose: 1 },
                ),
                (
                    "例 4 (q が先)",
                    example4_q_first(),
                    FrameBoxCounts { boxed: 1, loose: 1 },
                ),
            ];
            for (name, doc, expected) in cases {
                for max_passes in [None, Some(1), Some(2)] {
                    let (result, counts) = layout_document_with_counts(
                        &doc.input,
                        &doc.groups,
                        &doc.groups_of,
                        None,
                        max_passes,
                    )
                    .unwrap();
                    assert_eq!(counts, expected, "{name}");
                    assert_eq!(
                        result,
                        layout_document(&doc.input, &doc.groups, &doc.groups_of, None, max_passes)
                            .unwrap(),
                        "{name}: 前半は layout_document の結果"
                    );
                    // 箱の数と箱にできない枠の数は、結果の graph と frames に frame_blocks を当てた数
                    let frames = frames_of(&result);
                    let blocks =
                        frame_blocks(&result.graph, &frames, &layout_children_of(&result.graph));
                    assert_eq!(
                        (counts.boxed, counts.loose),
                        (blocks.blocks.len(), blocks.loose.len()),
                        "{name}"
                    );
                    assert_eq!(counts.boxed + counts.loose, result.frames.len(), "{name}");
                    if counts.loose == 0 {
                        assert_eq!(result.passes, 1, "{name}: loose がなければ 1 回 (I7)");
                    }
                }
            }
            // 誤りは layout_document と同じ
            let mut empty = small_input();
            empty.nodes.clear();
            assert_eq!(
                layout_document_with_counts(&empty, &[], &IndexMap::new(), None, None).err(),
                layout_document(&empty, &[], &IndexMap::new(), None, None).err()
            );
        }

        #[test]
        fn pipeline_adopted_pass_prefers_the_fewest_intruders() {
            assert_eq!(
                adopted_pass(&[(3, 10.0), (1, 900.0), (2, 5.0), (1, 950.0)]),
                2
            );
            assert_eq!(adopted_pass(&[(4, 1.0), (3, 2.0), (2, 3.0), (1, 4.0)]), 4);
        }

        #[test]
        fn pipeline_adopted_pass_breaks_intruder_ties_by_the_smaller_area() {
            assert_eq!(
                adopted_pass(&[(2, 100.0), (1, 400.0), (1, 300.0), (1, 350.0)]),
                3
            );
            // 発散した回 (notation の旧の 340 → 682 → 1406 → 2842 のような伸び方) は面積で外れる
            assert_eq!(
                adopted_pass(&[
                    (6, 340.0 * 500.0),
                    (6, 682.0 * 500.0),
                    (6, 1406.0 * 500.0),
                    (6, 2842.0 * 500.0)
                ]),
                1
            );
        }

        #[test]
        fn pipeline_adopted_pass_breaks_full_ties_by_the_earlier_pass() {
            // 入り込みも面積も同じ回が並ぶ (わざと同点にした入力)
            assert_eq!(
                adopted_pass(&[(1, 300.0), (2, 100.0), (1, 300.0), (1, 300.0)]),
                1
            );
            assert_eq!(
                adopted_pass(&[(2, 50.0), (2, 50.0), (2, 50.0), (2, 50.0)]),
                1
            );
            assert_eq!(adopted_pass(&[(4, 0.0), (1, 200.0), (1, 200.0)]), 2);
        }

        #[test]
        fn pipeline_adopted_pass_takes_the_pass_without_intruders() {
            // 入り込みが 0 の回で止めるので、並びはその回で終わる。面積が大きくても 0 の回を採る
            assert_eq!(adopted_pass(&[(1, 100.0), (0, 900.0)]), 2);
            assert_eq!(adopted_pass(&[(0, 900.0)]), 1);
            assert_eq!(adopted_pass(&[(5, 1.0)]), 1);
        }
    }

    // E-1 (2026-09-29 依頼者。量はメインの決定): メンバーを一部共有する枠の組の見た目。design.md 3 章の
    // 「メンバーを一部共有する枠の組の見た目」と段 5 の 6。loose の枠 L で、箱にした枠とメンバーを一部共有するものは、
    // outline の左の辺を side/2 右へ動かし、右の辺を max(L の frame_outline の右の辺, 共有する箱の枠の右の辺) + side × 2 まで広げる
    // (side = frame_padding(level).side。上下の辺は変えない。右の辺の目標は 2026-09-29、branches の食い違いによる)。
    // 右へ広げた所にメンバーでないノード、メンバーの交わらない枠があればその手前まで、含む枠の右の辺まで。
    // それで右の辺が箱の枠の右の辺を越えなければずらさない。ほかの枠の outline は frame_outline のまま。
    // 入力は testdata/acceptance/frames/ の例をそのまま読む (折りたたみは Markdown のコメントの指定から作る)
    pub(super) mod share {
        use std::collections::HashSet;

        use indexmap::IndexMap;

        use super::super::{FrameBoxCounts, LayoutDocumentResult, layout_document_with_counts};
        use super::group;
        use crate::layout::frames::{
            Frame, LABEL_HEIGHT, frame_blocks, frame_outline, frame_padding,
        };
        use crate::layout::layout::{LayoutOptions, MARKMAP_DEFAULTS, layout_children_of};
        use crate::model::model::{ModelOptions, build_model};
        use crate::parse::parse_document;
        use crate::types::{
            GroupDef, LayoutInput, LayoutInputEdge, LayoutInputNode, Rect, Severity,
        };

        // 3 章の許容 (接するだけは数えない)
        const TOLERANCE: f64 = 0.5;

        const HEADING: &str = include_str!(
            "../../../../testdata/acceptance/frames/library/partial-share-heading/input.md"
        );
        const BRANCHES: &str = include_str!(
            "../../../../testdata/acceptance/frames/library/partial-share-branches/input.md"
        );
        const FOLD_INSIDE: &str = include_str!(
            "../../../../testdata/acceptance/frames/library/partial-share-fold-inside/input.md"
        );
        const FOLD_ROOT: &str = include_str!(
            "../../../../testdata/acceptance/frames/library/partial-share-fold-root/input.md"
        );
        // レビュー B-2 の入力: b (企画) が箱、l (開発) が loose で一部共有。f (試作班) は l と b の両方に含まれる箱で、
        // g (画面班) は f に含まれる箱。l と b は level 2、f は level 1
        const NESTED_IN_LOOSE: &str = concat!(
            "---\n",
            "title: 入れ子を持つ一部共有\n",
            "markdag:\n",
            "    groups:\n",
            "        b:\n",
            "            label: 企画\n",
            "            boundary: true\n",
            "        l:\n",
            "            label: 開発\n",
            "            boundary: true\n",
            "        f:\n",
            "            label: 試作班\n",
            "            boundary: true\n",
            "        g:\n",
            "            label: 画面班\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 入れ子を持つ一部共有\n",
            "\n",
            "## 要件 %b\n",
            "\n",
            "## 試作 %b %l %f\n",
            "### 画面 %g\n",
            "#### 部品\n",
            "### API\n",
            "\n",
            "## 実装 %l\n",
        );

        const UNSHARED: [(&str, &str); 6] = [
            (
                "nested-heading",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/nested-heading/input.md"
                ),
            ),
            (
                "apart-heading",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/apart-heading/input.md"
                ),
            ),
            (
                "same-members",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/same-members/input.md"
                ),
            ),
            (
                "deep-nesting",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/deep-nesting/input.md"
                ),
            ),
            (
                "frame-to-frame",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/frame-to-frame/input.md"
                ),
            ),
            (
                "single-branches",
                include_str!(
                    "../../../../testdata/acceptance/frames/library/single-branches/input.md"
                ),
            ),
        ];

        pub(super) struct Document {
            pub(super) input: LayoutInput,
            pub(super) groups: Vec<GroupDef>,
            pub(super) groups_of: IndexMap<u32, Vec<String>>,
            pub(super) labels: IndexMap<u32, String>,
        }

        // 審判の harness と同じ疑似の大きさで入力を組む。折りたたみは、指定 (fold_hint) があり子を持つノード
        pub(super) fn document(source: &str) -> Document {
            let parsed = parse_document(source);
            let model = build_model(
                &parsed.nodes,
                &parsed.frontmatter,
                Some(source),
                &ModelOptions::default(),
            );
            let errors: Vec<&str> = model
                .diagnostics
                .iter()
                .filter(|item| item.severity == Severity::Error)
                .map(|item| item.code.as_str())
                .collect();
            assert!(errors.is_empty(), "文書に error がある: {errors:?}");
            let has_children: HashSet<u32> =
                parsed.nodes.iter().filter_map(|node| node.parent).collect();
            let folded = parsed
                .nodes
                .iter()
                .filter(|node| node.fold_hint > 0.0 && has_children.contains(&node.id))
                .map(|node| node.id)
                .collect();
            let nodes = parsed
                .nodes
                .iter()
                .map(|node| LayoutInputNode {
                    id: node.id,
                    label: node.ref_text.clone(),
                    width: if node.ref_text.is_empty() {
                        0.0
                    } else {
                        node.ref_text.chars().count() as f64 * 8.0 + 16.0
                    },
                    height: 20.0 + node.html.matches('\n').count() as f64 * 14.0,
                    groups: node.groups.clone(),
                })
                .collect();
            let tree_edges = parsed
                .nodes
                .iter()
                .filter_map(|node| {
                    node.parent.map(|parent| LayoutInputEdge {
                        source: parent,
                        target: node.id,
                    })
                })
                .collect();
            Document {
                input: LayoutInput {
                    name: "share".to_string(),
                    nodes,
                    tree_edges,
                    relations: model.relations.clone(),
                    suppress_root_line: model.suppress_root_line.clone(),
                    folded,
                },
                groups: model.groups.clone(),
                groups_of: model.groups_of.clone(),
                labels: parsed
                    .nodes
                    .iter()
                    .map(|node| (node.id, node.ref_text.clone()))
                    .collect(),
            }
        }

        // groups の p と q の定義の順を入れ替えた文書
        fn swap_p_and_q(source: &str) -> String {
            let p = "        p:\n            label: 企画\n            boundary: true\n";
            let q = "        q:\n            label: 開発\n            boundary: true\n";
            let swapped = source.replace(&format!("{p}{q}"), &format!("{q}{p}"));
            assert_ne!(swapped, source);
            swapped
        }

        fn run(
            doc: &Document,
            options: Option<LayoutOptions>,
        ) -> (LayoutDocumentResult, FrameBoxCounts) {
            layout_document_with_counts(&doc.input, &doc.groups, &doc.groups_of, options, None)
                .unwrap()
        }

        fn id_of(doc: &Document, label: &str) -> u32 {
            doc.labels
                .iter()
                .find(|(_, text)| text.as_str() == label)
                .map(|(id, _)| *id)
                .unwrap_or_else(|| panic!("ノード {label} がない"))
        }

        // group の枠のうち、label のノードをメンバーに持つもの (同じグループの枠が 2 つある文書のため)
        fn frame_index(
            doc: &Document,
            result: &LayoutDocumentResult,
            group: &str,
            label: &str,
        ) -> usize {
            let id = id_of(doc, label);
            result
                .frames
                .iter()
                .position(|entry| {
                    entry.frame.group.id == group && entry.frame.members.contains(&id)
                })
                .unwrap_or_else(|| panic!("{label} を含む {group} の枠がない"))
        }

        fn frames_of(result: &LayoutDocumentResult) -> Vec<Frame> {
            result
                .frames
                .iter()
                .map(|entry| entry.frame.clone())
                .collect()
        }

        fn right(rect: &Rect) -> f64 {
            rect.x + rect.width
        }

        fn overlaps(a: &Rect, b: &Rect) -> bool {
            let x = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
            let y = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
            x > TOLERANCE && y > TOLERANCE
        }

        fn contains(outer: &Rect, inner: &Rect) -> bool {
            inner.x >= outer.x - TOLERANCE
                && inner.y >= outer.y - TOLERANCE
                && right(inner) <= right(outer) + TOLERANCE
                && inner.y + inner.height <= outer.y + outer.height + TOLERANCE
        }

        fn with_label(outline: &Rect) -> Rect {
            Rect {
                y: outline.y - LABEL_HEIGHT,
                height: outline.height + LABEL_HEIGHT,
                ..*outline
            }
        }

        fn with_gap(rect: &Rect, gap: f64) -> Rect {
            Rect {
                x: rect.x - gap,
                width: rect.width + gap,
                ..*rect
            }
        }

        // I1: outline (ラベルの行を含む) に入る、メンバーでないノード。gap を左に足した矩形でも見る。幅か高さが 0 のノードは除く
        fn intruders_of(result: &LayoutDocumentResult, frame: &Frame, outline: &Rect) -> Vec<u32> {
            let area = with_label(outline);
            result
                .rects
                .iter()
                .filter(|(id, rect)| {
                    let gap = result.gaps.get(*id).copied().unwrap_or(0.0);
                    rect.width > 0.0
                        && rect.height > 0.0
                        && !frame.members.contains(id)
                        && (overlaps(rect, &area) || overlaps(&with_gap(rect, gap), &area))
                })
                .map(|(id, _)| *id)
                .collect()
        }

        // 左の辺を右へ動かす幅 (side/2) と、右の辺を右へ広げる幅の上限 (side × 2)
        fn left_shift_of(frame: &Frame) -> f64 {
            frame_padding(frame.level).side / 2.0
        }

        fn right_limit_of(frame: &Frame) -> f64 {
            frame_padding(frame.level).side * 2.0
        }

        // 左の辺を side/2 右へ動かし、右の辺を right_edge にした outline
        fn moved_outline(frame: &Frame, base: &Rect, right_edge: f64) -> Rect {
            let x = base.x + left_shift_of(frame);
            Rect {
                x,
                width: right_edge - x,
                ..*base
            }
        }

        // L とメンバーを一部共有する箱の枠の右の辺の最大
        fn box_right_of(
            result: &LayoutDocumentResult,
            index: usize,
            outlines: &[Option<Rect>],
        ) -> f64 {
            let frames = frames_of(result);
            let blocks = frame_blocks(&result.graph, &frames, &layout_children_of(&result.graph));
            blocks
                .blocks
                .iter()
                .map(|block| block.frame)
                .filter(|&b| partly_shares(&frames[index], &frames[b]))
                .filter_map(|b| outlines[b].map(|outline| right(&outline)))
                .fold(f64::NEG_INFINITY, f64::max)
        }

        fn y_overlaps(a: &Rect, b: &Rect) -> bool {
            (a.y + a.height).min(b.y + b.height) - a.y.max(b.y) > TOLERANCE
        }

        // 設計の規則から組んだ参照: 枠ごとの outline (frames の順に決める)。対象外の枠は frame_outline のまま
        pub(in super::super) fn expected_outlines(
            result: &LayoutDocumentResult,
        ) -> Vec<Option<Rect>> {
            let frames = frames_of(result);
            let targets = shifted_targets(result);
            let mut outlines: Vec<Option<Rect>> = frames
                .iter()
                .map(|frame| frame_outline(frame, &result.rects))
                .collect();
            for &index in &targets {
                let frame = &frames[index];
                let Some(base) = outlines[index] else {
                    continue;
                };
                let area = with_label(&base);
                let box_right = box_right_of(result, index, &outlines);
                let mut edge = right(&base).max(box_right) + right_limit_of(frame);
                // 右へ広げた所にある障害 (base と重ならず、右の端が base より右で、y の範囲が重なる矩形) の左の端まで
                let mut clip = |obstacle: &Rect| {
                    if !overlaps(obstacle, &area)
                        && right(obstacle) > right(&base)
                        && y_overlaps(obstacle, &area)
                    {
                        edge = edge.min(obstacle.x);
                    }
                };
                for (id, rect) in &result.rects {
                    if rect.width > 0.0 && rect.height > 0.0 && !frame.members.contains(id) {
                        let gap = result.gaps.get(id).copied().unwrap_or(0.0);
                        clip(&with_gap(rect, gap));
                    }
                }
                let mut enclosing = f64::INFINITY;
                for (other, entry) in frames.iter().enumerate() {
                    let Some(outline) = outlines[other] else {
                        continue;
                    };
                    if other == index {
                        continue;
                    }
                    if !entry.members.iter().any(|id| frame.members.contains(id)) {
                        clip(&with_label(&outline));
                    } else if frame.members.iter().all(|id| entry.members.contains(id)) {
                        enclosing = enclosing.min(right(&outline));
                    }
                }
                let edge = edge.min(enclosing).max(right(&base));
                // 右の辺が箱の枠の右の辺を越えなければ、右で交差が見えないのでずらさない
                if edge > box_right + TOLERANCE {
                    // 左の辺は、L に含まれる枠 F (F ⊆ L、F ≠ L) の左の辺 (F が先に決めた対象ならずらした後の値) を越えない所まで
                    // (含む枠を含まれる枠からはみ出させない。レビュー B-2)。base の左の辺より左には戻さない
                    let x = frames
                        .iter()
                        .enumerate()
                        .filter(|&(other, entry)| {
                            other != index
                                && entry.members.iter().all(|id| frame.members.contains(id))
                        })
                        .filter_map(|(other, _)| outlines[other].map(|outline| outline.x))
                        .fold(base.x + left_shift_of(frame), f64::min)
                        .max(base.x);
                    outlines[index] = Some(Rect {
                        x,
                        width: edge - x,
                        ..base
                    });
                }
            }
            outlines
        }

        fn partly_shares(a: &Frame, b: &Frame) -> bool {
            let common = a.members.iter().filter(|id| b.members.contains(id)).count();
            common > 0 && common < a.members.len() && common < b.members.len()
        }

        // 設計の対象: loose の枠で、箱にした枠とメンバーを一部共有するもの
        fn shifted_targets(result: &LayoutDocumentResult) -> Vec<usize> {
            let frames = frames_of(result);
            let blocks = frame_blocks(&result.graph, &frames, &layout_children_of(&result.graph));
            let boxed: Vec<usize> = blocks.blocks.iter().map(|block| block.frame).collect();
            blocks
                .loose
                .iter()
                .copied()
                .filter(|&loose| {
                    boxed
                        .iter()
                        .any(|&b| partly_shares(&frames[loose], &frames[b]))
                })
                .collect()
        }

        // 一部共有する組 (shifted が loose、boxed が箱) の見た目を確かめる。ほかの枠の outline は frame_outline のまま
        fn check_shared_pair(
            name: &str,
            result: &LayoutDocumentResult,
            shifted: usize,
            boxed: usize,
        ) {
            let frames = frames_of(result);
            assert_eq!(
                shifted_targets(result),
                vec![shifted],
                "{name}: ずらす対象の枠"
            );
            let moved = result.frames[shifted].outline.expect("ずらす枠の outline");
            let fixed = result.frames[boxed].outline.expect("箱の枠の outline");
            let left = left_shift_of(&frames[shifted]);
            let limit = right_limit_of(&frames[shifted]);
            // 後の枠の左の辺は先の枠の左の辺より side/2 以上右、右の辺は先の枠の右の辺より side × 2 以上右 (交差と分かる形)
            assert!(
                moved.x - fixed.x >= left - TOLERANCE,
                "{name}: 後の枠 {} の左の辺 {} が先の枠 {} の左の辺 {} より {left} 以上右にない",
                frames[shifted].group.id,
                moved.x,
                frames[boxed].group.id,
                fixed.x
            );
            assert!(
                right(&moved) - right(&fixed) >= limit - TOLERANCE,
                "{name}: 後の枠の右の辺 {} が先の枠の右の辺 {} より {limit} 以上右にない",
                right(&moved),
                right(&fixed)
            );
            // 設計の値: 左の辺 +side/2、右の辺 = max(frame_outline の右の辺, 箱の枠の右の辺) + side × 2 (右に障害がない例)。
            // 上下の辺は frame_outline のまま
            let base = frame_outline(&frames[shifted], &result.rects).unwrap();
            assert_eq!(
                moved,
                moved_outline(
                    &frames[shifted],
                    &base,
                    right(&base).max(right(&fixed)) + limit
                ),
                "{name}: 後の枠の outline は左の辺を {left} 右へ、右の辺を外側の右の辺から {limit} 右へ動かしたもの"
            );
            assert_eq!(
                result
                    .frames
                    .iter()
                    .map(|entry| entry.outline)
                    .collect::<Vec<_>>(),
                expected_outlines(result),
                "{name}: 設計の規則から組んだ参照と同じ"
            );
            // 上下は今のまま交差する
            assert!(
                overlaps(&with_label(&moved), &with_label(&fixed)),
                "{name}: 2 つの枠が交差しない"
            );
            // ずらした枠がメンバーを外に出さない
            for id in &frames[shifted].members {
                if let Some(rect) = result.rects.get(id) {
                    assert!(
                        contains(&moved, rect),
                        "{name}: メンバー {id} が後の枠からはみ出る"
                    );
                }
            }
            // ほかの枠は frame_outline のまま、入り込みはどの枠も 0
            for (index, entry) in result.frames.iter().enumerate() {
                if index != shifted {
                    assert_eq!(
                        entry.outline,
                        frame_outline(&entry.frame, &result.rects),
                        "{name}: ずらさない枠 {} の outline",
                        entry.frame.group.id
                    );
                }
                if let Some(outline) = entry.outline {
                    let found = intruders_of(result, &entry.frame, &outline);
                    assert!(
                        found.is_empty(),
                        "{name}: 枠 {} にメンバーでないノード {found:?} が入る",
                        entry.frame.group.id
                    );
                }
            }
        }

        #[test]
        fn pipeline_share_heading_shifts_the_later_frame_right() {
            // partial-share-heading: p (企画) が箱、q (開発) が loose。q の左右の辺を p の左右の辺より右へ
            let doc = document(HEADING);
            let (result, counts) = run(&doc, None);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let p = frame_index(&doc, &result, "p", "要件");
            let q = frame_index(&doc, &result, "q", "実装");
            check_shared_pair("partial-share-heading", &result, q, p);
        }

        #[test]
        fn pipeline_share_keeps_frames_inside_the_loose_frame_on_the_left() {
            // レビュー B-2。E-1 の左のずらし (side/2) は、ずらす枠 L に含まれる枠 F の左の辺を越えない所まで。
            // L = l (level 2、side 52) の side/2 は 26、F = f (level 1、side 30) は L と同じ列の試作が左の端なので
            // L の base より 22 右。ずらしを 26 のままにすると f が l の左へ 4 はみ出す (I10 と同じ向きの崩れ)
            let doc = document(NESTED_IN_LOOSE);
            let (result, counts) = run(&doc, None);
            assert_eq!(counts, FrameBoxCounts { boxed: 3, loose: 1 });
            let b = frame_index(&doc, &result, "b", "要件");
            let l = frame_index(&doc, &result, "l", "実装");
            let f = frame_index(&doc, &result, "f", "試作");
            let g = frame_index(&doc, &result, "g", "画面");
            let frames = frames_of(&result);
            assert_eq!(
                (
                    frames[b].level,
                    frames[l].level,
                    frames[f].level,
                    frames[g].level
                ),
                (2, 2, 1, 0)
            );
            assert_eq!(shifted_targets(&result), vec![l]);
            let moved = result.frames[l].outline.unwrap();
            let base = frame_outline(&frames[l], &result.rects).unwrap();
            // l は右へずれる (交差と分かる形は保つ)
            assert!(moved.x > base.x + TOLERANCE, "l の左の辺がずれていない");
            assert!(right(&moved) > right(&result.frames[b].outline.unwrap()) + TOLERANCE);
            // l に含まれる枠 (f、g) はラベルの行ごと l の中に収まる
            for inner in [f, g] {
                let area = with_label(&result.frames[inner].outline.unwrap());
                assert!(
                    area.x >= moved.x - TOLERANCE,
                    "枠 {} の左の辺 {} が l の左の辺 {} より左にはみ出す",
                    frames[inner].group.id,
                    area.x,
                    moved.x
                );
                assert!(
                    contains(&moved, &area),
                    "枠 {} が l に収まらない",
                    frames[inner].group.id
                );
            }
            // 左のずらしは f の左の辺まで (side/2 より小さい)
            let f_left = result.frames[f].outline.unwrap().x;
            assert!(f_left < base.x + left_shift_of(&frames[l]));
            assert!(
                (moved.x - f_left).abs() <= TOLERANCE,
                "l の左の辺 {} が f の左の辺 {f_left} と揃わない",
                moved.x
            );
            assert_eq!(
                result
                    .frames
                    .iter()
                    .map(|entry| entry.outline)
                    .collect::<Vec<_>>(),
                expected_outlines(&result),
                "設計の規則から組んだ参照と同じ"
            );
            for entry in &result.frames {
                let found = intruders_of(&result, &entry.frame, &entry.outline.unwrap());
                assert!(
                    found.is_empty(),
                    "枠 {} に {found:?} が入る",
                    entry.frame.group.id
                );
            }
        }

        #[test]
        fn pipeline_share_heading_swapped_groups_shift_the_other_frame() {
            // groups で q を先に書くと q が箱、p が loose になり、ずれる枠が p に入れ替わる
            let doc = document(&swap_p_and_q(HEADING));
            let (result, counts) = run(&doc, None);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let p = frame_index(&doc, &result, "p", "要件");
            let q = frame_index(&doc, &result, "q", "実装");
            check_shared_pair("partial-share-heading (q が先)", &result, p, q);
        }

        #[test]
        fn pipeline_share_branches_shift_the_frame_crossing_the_implementation_branch() {
            // partial-share-branches: p は枝ごとに 2 つの枠 (画面と API、フロントとバック)。実装の枝の p とバックを共有する q がずれる。
            // 設計の枝の p はメンバーを共有しないので frame_outline のまま、q と重ならない
            let doc = document(BRANCHES);
            let (result, _) = run(&doc, None);
            let design = frame_index(&doc, &result, "p", "画面");
            let implementation = frame_index(&doc, &result, "p", "フロント");
            let q = frame_index(&doc, &result, "q", "基盤");
            check_shared_pair("partial-share-branches", &result, q, implementation);
            assert!(
                !overlaps(
                    &with_label(&result.frames[q].outline.unwrap()),
                    &with_label(&result.frames[design].outline.unwrap())
                ),
                "ずらした q が、メンバーの交わらない設計の枝の p と重なる (I2)"
            );
        }

        #[test]
        fn pipeline_share_fold_inside_shifts_the_later_frame() {
            // partial-share-fold-inside: 共有する試作を閉じても、q が p より右へずれる
            let doc = document(FOLD_INSIDE);
            assert_eq!(doc.input.folded, vec![id_of(&doc, "試作")]);
            let (result, _) = run(&doc, None);
            let p = frame_index(&doc, &result, "p", "要件");
            let q = frame_index(&doc, &result, "q", "実装");
            check_shared_pair("partial-share-fold-inside", &result, q, p);
        }

        #[test]
        fn pipeline_share_fold_root_shifts_the_later_frame() {
            // partial-share-fold-root: p だけの根 (要件) を閉じても、q が p より右へずれる
            let doc = document(FOLD_ROOT);
            assert_eq!(doc.input.folded, vec![id_of(&doc, "要件")]);
            let (result, _) = run(&doc, None);
            let p = frame_index(&doc, &result, "p", "要件");
            let q = frame_index(&doc, &result, "q", "実装");
            check_shared_pair("partial-share-fold-root", &result, q, p);
        }

        #[test]
        fn pipeline_share_fold_swapped_groups_shift_the_other_frame() {
            // 折りたたみの 2 つの形でも、groups の順を入れ替えるとずれる枠が p に入れ替わる
            for (name, source) in [
                ("partial-share-fold-inside", FOLD_INSIDE),
                ("partial-share-fold-root", FOLD_ROOT),
            ] {
                let doc = document(&swap_p_and_q(source));
                let (result, _) = run(&doc, None);
                let p = frame_index(&doc, &result, "p", "要件");
                let q = frame_index(&doc, &result, "q", "実装");
                check_shared_pair(&format!("{name} (q が先)"), &result, p, q);
            }
        }

        #[test]
        fn pipeline_share_frames_without_partial_share_keep_frame_outline() {
            // メンバーを一部共有しない枠 (入れ子、離れた枠、同じ集合、深い入れ子、枠から枠、枝をまたぐ 1 つの枠) は、
            // loose がなく、どの枠の outline も frame_outline のまま
            for (name, source) in UNSHARED {
                let doc = document(source);
                let (result, counts) = run(&doc, None);
                assert_eq!(counts.loose, 0, "{name}: loose の枠");
                assert!(!result.frames.is_empty(), "{name}: 枠がない");
                for entry in &result.frames {
                    assert_eq!(
                        entry.outline,
                        frame_outline(&entry.frame, &result.rects),
                        "{name}: 枠 {} の outline",
                        entry.frame.group.id
                    );
                }
            }
        }

        // 1 root / 2 要件 %p / 3 試作 %p %q (4、5、6) / 7 実装 %q (8 は q のメンバーでない、実装の子)。
        // 実装の右の端を試作の子の列の右の端にそろえる (配置の幅は入力 + 16。実装の入力の幅 = 60 + 16 + spacing_horizontal + 60)。
        // 8 の左の端は q の frame_outline の右の辺の (spacing_horizontal − 8) 右に来る
        fn narrow_document(spacing_horizontal: f64) -> (LayoutDocumentResult, FrameBoxCounts) {
            let parents: [(u32, u32); 7] = [(1, 2), (1, 3), (3, 4), (3, 5), (3, 6), (1, 7), (7, 8)];
            let width = |id: u32| {
                if id == 7 {
                    60.0 + 16.0 + spacing_horizontal + 60.0
                } else {
                    60.0
                }
            };
            let input = LayoutInput {
                name: "share-narrow".to_string(),
                nodes: (1..=8)
                    .map(|id| LayoutInputNode {
                        id,
                        label: format!("n{id}"),
                        width: width(id),
                        height: 20.0,
                        groups: Vec::new(),
                    })
                    .collect(),
                tree_edges: parents
                    .iter()
                    .map(|&(source, target)| LayoutInputEdge { source, target })
                    .collect(),
                relations: Vec::new(),
                suppress_root_line: Vec::new(),
                folded: Vec::new(),
            };
            let groups_of: IndexMap<u32, Vec<String>> = (1..=8)
                .map(|id| {
                    let list = match id {
                        2 => vec!["p".to_string()],
                        3..=6 => vec!["p".to_string(), "q".to_string()],
                        7 => vec!["q".to_string()],
                        _ => Vec::new(),
                    };
                    (id, list)
                })
                .collect();
            let options = LayoutOptions {
                spacing_horizontal,
                ..MARKMAP_DEFAULTS
            };
            layout_document_with_counts(
                &input,
                &[group("p"), group("q")],
                &groups_of,
                Some(options),
                None,
            )
            .unwrap()
        }

        #[test]
        fn pipeline_share_clips_the_right_edge_at_a_non_member_node() {
            // 右の辺の決め方の 1: 右へ広げた所にメンバーでないノードがあれば、右の辺はその左の端で止まる。
            // spacing_horizontal 10 では 8 が q の frame_outline の右の辺 (= 箱の枠 p の右の辺) の 2px 右にあるので、
            // 右の辺は 2px だけ広がり、p の右の辺を越えるのでずらす (左の辺は side/2 動く)
            let (result, counts) = narrow_document(10.0);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let q = result
                .frames
                .iter()
                .position(|entry| entry.frame.group.id == "q")
                .unwrap();
            let frame = &result.frames[q].frame;
            assert!(!frame.members.contains(&8));
            let base = frame_outline(frame, &result.rects).unwrap();
            let gap = result.rects[&8].x - right(&base);
            // 前提: 8 は q の右の辺の 2px 右で、y の範囲が重なり、ずらす前は入らない
            assert!(
                (gap - 2.0).abs() < 1e-9,
                "前提: 8 と q の右の辺の間が {gap}"
            );
            assert!(
                y_overlaps(&result.rects[&8], &with_label(&base)),
                "前提: 8 の y の範囲が q と重ならない"
            );
            assert!(
                !intruders_of(&result, frame, &base).contains(&8),
                "前提: ずらす前に 8 が入る"
            );
            let outline = result.frames[q].outline.unwrap();
            assert_eq!(
                outline,
                moved_outline(frame, &base, result.rects[&8].x),
                "q の右の辺は 8 の左の端まで"
            );
            let p = result
                .frames
                .iter()
                .position(|entry| entry.frame.group.id == "p")
                .unwrap();
            assert!(
                (right(&outline) - right(&result.frames[p].outline.unwrap()) - 2.0).abs() < 1e-9,
                "q の右の辺は箱の枠 p の右の辺の 2px 右"
            );
            assert!(
                intruders_of(&result, frame, &outline).is_empty(),
                "ずらした q に入り込みがある"
            );
            assert_eq!(
                result
                    .frames
                    .iter()
                    .map(|entry| entry.outline)
                    .collect::<Vec<_>>(),
                expected_outlines(&result)
            );
        }

        #[test]
        fn pipeline_share_does_not_shift_when_the_right_edge_cannot_widen() {
            // spacing_horizontal 8 では 8 の左の端が q の右の辺 (= 箱の枠 p の右の辺) に接し、右の辺を広げられない。
            // 右の辺が p の右の辺を越えないので、左の辺もずらさず frame_outline のまま
            let (result, counts) = narrow_document(8.0);
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 1 });
            let q = result
                .frames
                .iter()
                .position(|entry| entry.frame.group.id == "q")
                .unwrap();
            let frame = &result.frames[q].frame;
            let base = frame_outline(frame, &result.rects).unwrap();
            let gap = result.rects[&8].x - right(&base);
            assert!(gap.abs() < 1e-9, "前提: 8 と q の右の辺の間が {gap}");
            assert!(
                y_overlaps(&result.rects[&8], &with_label(&base)),
                "前提: 8 の y の範囲が q と重ならない"
            );
            assert_eq!(
                result.frames[q].outline,
                Some(base),
                "右へ広げられないのに q をずらした"
            );
        }
    }

    // 組み合わせの表 (枠どうし × メンバーの形 × 折りたたみ × relations を測った表) のうち、受け入れの例のないマスを
    // 配置の流れの入口で確かめる。入力は表の Markdown の写し (表の置き場所は git に入らないので、ここに写す)。
    // 大きさは審判の harness と同じ疑似の大きさなので、座標は表の測った値と違う。確かめるのは、枠の数 (グループごと)、
    // 箱と loose の数、採った回、入り込み 0 と不変条件 (I1、I2、I10、I5)、表の「挙動」の列の位置の関係 (右、左、下)
    mod combos {
        use indexmap::IndexMap;

        use super::super::{FrameBoxCounts, LayoutDocumentResult, layout_document_with_counts};
        use super::flow::check_invariants;
        use super::share::{Document, document};
        use crate::layout::frames::{LABEL_HEIGHT, count_intruders};
        use crate::layout::layout::MARKMAP_DEFAULTS;
        use crate::types::Rect;

        // 3 章の許容 (接するだけは数えない)
        const TOLERANCE: f64 = 0.5;

        // マス 1-3
        const SINGLE_ROOT: &str = concat!(
            "---\n",
            "title: 単独、ルートを含む\n",
            "markdag:\n",
            "    groups:\n",
            "        a:\n",
            "            label: 全体\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 単独、ルートを含む %a\n",
            "\n",
            "## 設計\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 実装\n",
            "- フロント\n",
            "- バック\n",
        );

        // マス 1-5
        const APART_BRANCHES: &str = concat!(
            "---\n",
            "title: 離れている、枝をまたぐ\n",
            "markdag:\n",
            "    groups:\n",
            "        a:\n",
            "            label: 画面担当\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/一覧\n",
            "                - 設計/詳細\n",
            "                - 実装/一覧\n",
            "                - 実装/詳細\n",
            "        b:\n",
            "            label: サーバ担当\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/認証\n",
            "                - 設計/検索\n",
            "                - 実装/認証\n",
            "                - 実装/検索\n",
            "---\n",
            "\n",
            "# 離れている、枝をまたぐ\n",
            "\n",
            "## 設計\n",
            "- 一覧\n",
            "- 詳細\n",
            "- 認証\n",
            "- 検索\n",
            "\n",
            "## 実装\n",
            "- 一覧\n",
            "- 詳細\n",
            "- 認証\n",
            "- 検索\n",
        );

        // マス 1-14
        const SAME_BRANCHES: &str = concat!(
            "---\n",
            "title: 同じ集合、枝をまたぐ\n",
            "markdag:\n",
            "    groups:\n",
            "        a:\n",
            "            label: 画面担当\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/*\n",
            "                - 実装/*\n",
            "        b:\n",
            "            label: 第 1 期\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/*\n",
            "                - 実装/*\n",
            "---\n",
            "\n",
            "# 同じ集合、枝をまたぐ\n",
            "\n",
            "## 設計\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 実装\n",
            "- フロント\n",
            "- バック\n",
        );

        // マス 2-1
        const APART_FOLD_INSIDE: &str = concat!(
            "---\n",
            "title: 離れている、枠の中を閉じる\n",
            "markdag:\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "        b:\n",
            "            label: 開発チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 離れている、枠の中を閉じる\n",
            "\n",
            "## 設計 %a\n",
            "- 画面 <!-- markmap: fold -->\n",
            "    - 一覧\n",
            "    - 詳細\n",
            "- API\n",
            "\n",
            "## 実装 %b\n",
            "- フロント\n",
            "- バック\n",
        );

        // マス 3-6
        const ALT_IN: &str = concat!(
            "---\n",
            "title: 1 つおき、外から中\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 調整 --> 実装\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 1 つおき、外から中\n",
            "\n",
            "## 設計 %a\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 調整\n",
            "\n",
            "## 実装 %a\n",
            "- フロント\n",
            "- バック\n",
            "\n",
            "## 告知\n",
        );

        // マス 3-7
        const ALT_F2F: &str = concat!(
            "---\n",
            "title: 1 つおき、枠から枠\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 設計/API --> 実装\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 1 つおき、枠から枠\n",
            "\n",
            "## 設計 %a\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 調整\n",
            "\n",
            "## 実装 %a\n",
            "- フロント\n",
            "- バック\n",
            "\n",
            "## 告知\n",
        );

        // マス 3-8
        const ALT_CYCLE: &str = concat!(
            "---\n",
            "title: 1 つおき、閉路になる出口\n",
            "markdag:\n",
            "    relations:\n",
            "        chain:\n",
            "            - 設計/画面 --> 告知 --> 設計/API\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 1 つおき、閉路になる出口\n",
            "\n",
            "## 設計 %a\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 調整\n",
            "\n",
            "## 実装 %a\n",
            "- フロント\n",
            "- バック\n",
            "\n",
            "## 告知\n",
        );

        // マス 3-9
        const BRANCHES_OUT: &str = concat!(
            "---\n",
            "title: 枝をまたぐ、中から外\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 設計/画面 --> 告知\n",
            "    groups:\n",
            "        a:\n",
            "            label: 画面担当\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/*\n",
            "                - 実装/*\n",
            "---\n",
            "\n",
            "# 枝をまたぐ、中から外\n",
            "\n",
            "## 設計\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 実装\n",
            "- 画面\n",
            "- サーバ\n",
            "\n",
            "## 告知\n",
        );

        // マス 3-10
        const BRANCHES_IN: &str = concat!(
            "---\n",
            "title: 枝をまたぐ、外から中\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 告知 --> 実装/画面\n",
            "    groups:\n",
            "        a:\n",
            "            label: 画面担当\n",
            "            boundary: true\n",
            "            members:\n",
            "                - 設計/*\n",
            "                - 実装/*\n",
            "---\n",
            "\n",
            "# 枝をまたぐ、外から中\n",
            "\n",
            "## 告知\n",
            "\n",
            "## 設計\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 実装\n",
            "- 画面\n",
            "- サーバ\n",
        );

        // マス 3-14
        const SINGLE_IN: &str = concat!(
            "---\n",
            "title: メンバー 1 つ、外から中\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 告知 --> 設計\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# メンバー 1 つ、外から中\n",
            "\n",
            "## 告知\n",
            "\n",
            "## 設計 %a\n",
            "\n",
            "## 実装\n",
            "- フロント\n",
            "- バック\n",
        );

        // マス 3-15
        const SINGLE_F2F: &str = concat!(
            "---\n",
            "title: メンバー 1 つ、枠から枠\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 設計 --> 実装\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "        b:\n",
            "            label: 開発チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# メンバー 1 つ、枠から枠\n",
            "\n",
            "## 設計 %a\n",
            "\n",
            "## 実装 %b\n",
            "\n",
            "## 告知\n",
        );

        // マス 4-1
        const FOLD_INSIDE_OUT: &str = concat!(
            "---\n",
            "title: 枠の中を閉じる、中から外\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 設計/画面/一覧 --> 告知\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 枠の中を閉じる、中から外\n",
            "\n",
            "## 設計 %a\n",
            "- 画面 <!-- markmap: fold -->\n",
            "    - 一覧\n",
            "    - 詳細\n",
            "- API\n",
            "\n",
            "## 告知\n",
        );

        // マス 4-2
        const FOLD_ROOT_OUT: &str = concat!(
            "---\n",
            "title: 枠の根を閉じる、中から外\n",
            "markdag:\n",
            "    relations:\n",
            "        depends:\n",
            "            - 設計/画面 --> 告知\n",
            "    groups:\n",
            "        a:\n",
            "            label: 設計チーム\n",
            "            boundary: true\n",
            "---\n",
            "\n",
            "# 枠の根を閉じる、中から外\n",
            "\n",
            "## 設計 <!-- markmap: fold --> %a\n",
            "- 画面\n",
            "- API\n",
            "\n",
            "## 告知\n",
        );

        fn run(name: &str, doc: &Document) -> (LayoutDocumentResult, FrameBoxCounts) {
            let (result, counts) =
                layout_document_with_counts(&doc.input, &doc.groups, &doc.groups_of, None, None)
                    .unwrap();
            let frames: Vec<_> = result
                .frames
                .iter()
                .map(|entry| entry.frame.clone())
                .collect();
            assert_eq!(
                count_intruders(&frames, &result.rects),
                0,
                "{name}: 入り込み"
            );
            let report = check_invariants(name, &result, &MARKMAP_DEFAULTS);
            assert_eq!(
                (report.loose_intruders, report.loose_overlaps),
                (0, 0),
                "{name}: loose の枠"
            );
            (result, counts)
        }

        // グループごとの枠の数 (frames に最初に出た順)
        fn frames_per_group(result: &LayoutDocumentResult) -> Vec<(String, usize)> {
            let mut counts: IndexMap<String, usize> = IndexMap::new();
            for entry in &result.frames {
                *counts.entry(entry.frame.group.id.clone()).or_default() += 1;
            }
            counts.into_iter().collect()
        }

        fn per_group(entries: &[(&str, usize)]) -> Vec<(String, usize)> {
            entries
                .iter()
                .map(|(group, count)| (group.to_string(), *count))
                .collect()
        }

        // ルートから見出しと項目の名前をたどってノードを引く (ルートは含めない)。同じ名前のノードが枝ごとにある文書のため
        fn id_at(doc: &Document, path: &[&str]) -> u32 {
            let edges = &doc.input.tree_edges;
            let root = doc
                .input
                .nodes
                .iter()
                .map(|node| node.id)
                .find(|id| !edges.iter().any(|edge| edge.target == *id))
                .expect("ルート");
            path.iter().fold(root, |parent, label| {
                edges
                    .iter()
                    .filter(|edge| edge.source == parent)
                    .map(|edge| edge.target)
                    .find(|id| doc.labels[id] == *label)
                    .unwrap_or_else(|| panic!("{path:?} の {label} がない"))
            })
        }

        // group の枠のうち id をメンバーに持つもの
        fn frame_of(result: &LayoutDocumentResult, group: &str, id: u32) -> usize {
            result
                .frames
                .iter()
                .position(|entry| {
                    entry.frame.group.id == group && entry.frame.members.contains(&id)
                })
                .unwrap_or_else(|| panic!("{id} を含む {group} の枠がない"))
        }

        // 3 章の「枠の矩形」: outline を上へ LABEL_HEIGHT 広げたもの
        fn area(result: &LayoutDocumentResult, group: &str, id: u32) -> Rect {
            let outline = result.frames[frame_of(result, group, id)]
                .outline
                .expect("outline");
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

        fn contains(outer: &Rect, inner: &Rect) -> bool {
            inner.x >= outer.x - TOLERANCE
                && inner.y >= outer.y - TOLERANCE
                && right(inner) <= right(outer) + TOLERANCE
                && bottom(inner) <= bottom(outer) + TOLERANCE
        }

        fn is_right_of(rect: &Rect, other: &Rect) -> bool {
            rect.x >= right(other) - TOLERANCE
        }

        fn is_below(rect: &Rect, other: &Rect) -> bool {
            rect.y >= bottom(other) - TOLERANCE
        }

        #[test]
        fn pipeline_combos_single_frame_containing_the_root_holds_every_node() {
            // 1-3: 全部のノードがメンバーの枠 1 つ (箱)。メンバーでないノードはなく、枠が全部の矩形を囲む
            let doc = document(SINGLE_ROOT);
            let (result, counts) = run("1-3", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 1)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(result.rects.len(), 7);
            assert_eq!(result.frames[0].frame.members.len(), 7);
            let root = id_at(&doc, &[]);
            let all = area(&result, "a", root);
            for (id, rect) in &result.rects {
                assert!(contains(&all, rect), "{id} が枠の外");
            }
        }

        #[test]
        fn pipeline_combos_apart_frames_across_branches_stack_per_branch() {
            // 1-5: a と b がどちらも 2 つの枝に分かれて枠 4 つ (全部箱)。各枝で a の枠の下に b の枠、設計の枝の b の下に実装の枝の a
            let doc = document(APART_BRANCHES);
            let (result, counts) = run("1-5", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2), ("b", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 4, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(result.rects.len(), 11);
            let mut previous: Option<Rect> = None;
            for branch in ["設計", "実装"] {
                let a = area(&result, "a", id_at(&doc, &[branch, "一覧"]));
                let b = area(&result, "b", id_at(&doc, &[branch, "認証"]));
                assert_eq!(
                    frame_of(&result, "a", id_at(&doc, &[branch, "一覧"])),
                    frame_of(&result, "a", id_at(&doc, &[branch, "詳細"])),
                    "{branch}: 一覧と詳細は同じ枠"
                );
                assert!(is_below(&b, &a), "{branch}: b の枠が a の枠の下にない");
                if let Some(upper) = previous {
                    assert!(
                        is_below(&a, &upper),
                        "{branch}: a の枠が前の枝の b の枠の下にない"
                    );
                }
                previous = Some(b);
            }
        }

        #[test]
        fn pipeline_combos_same_members_across_branches_nest_per_branch() {
            // 1-14: a と b はメンバーが同じで、枝ごとに枠 2 つずつ (全部箱)。groups の先の a が外 (level 1)、b が内 (level 0) で、
            // 枝ごとに b の枠がラベルの行ごと a の outline に収まる
            let doc = document(SAME_BRANCHES);
            let (result, counts) = run("1-14", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2), ("b", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 4, loose: 0 });
            assert_eq!(result.passes, 1);
            for (branch, first) in [("設計", "画面"), ("実装", "フロント")] {
                let id = id_at(&doc, &[branch, first]);
                let (a, b) = (frame_of(&result, "a", id), frame_of(&result, "b", id));
                assert_eq!(
                    result.frames[a].frame.members, result.frames[b].frame.members,
                    "{branch}"
                );
                assert_eq!(
                    (result.frames[a].frame.level, result.frames[b].frame.level),
                    (1, 0),
                    "{branch}"
                );
                let outer = result.frames[a].outline.unwrap();
                assert!(
                    contains(&outer, &area(&result, "b", id)),
                    "{branch}: b が a の外"
                );
            }
        }

        #[test]
        fn pipeline_combos_apart_frames_keep_their_order_when_a_member_is_folded() {
            // 2-1: a の中の画面を閉じる (一覧と詳細が隠れる)。枠は a、b の 2 つのまま (箱) で、a の枠の下に b の枠
            let doc = document(APART_FOLD_INSIDE);
            let (result, counts) = run("2-1", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 1), ("b", 1)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(result.rects.len(), 7);
            assert!(
                !result
                    .rects
                    .contains_key(&id_at(&doc, &["設計", "画面", "一覧"]))
            );
            let a = area(&result, "a", id_at(&doc, &["設計", "画面"]));
            let b = area(&result, "b", id_at(&doc, &["実装"]));
            assert!(is_below(&b, &a));
        }

        #[test]
        fn pipeline_combos_alternate_siblings_entry_puts_the_later_frame_right_of_the_source() {
            // 3-6: 調整 --> 実装 で、実装 (a の 2 つ目の枠の根) は調整の配置上の子になる。枠は 2 つ (箱)。
            // 実装の枠は調整の右で、設計の枠の下の行
            let doc = document(ALT_IN);
            let (result, counts) = run("3-6", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            let (adjust, build) = (id_at(&doc, &["調整"]), id_at(&doc, &["実装"]));
            assert_eq!(result.graph.layout_parent.get(&build), Some(&adjust));
            let design = area(&result, "a", id_at(&doc, &["設計"]));
            let later = area(&result, "a", build);
            assert!(is_right_of(&later, &result.rects[&adjust]));
            assert!(is_below(&later, &design));
        }

        #[test]
        fn pipeline_combos_alternate_siblings_frame_to_frame_puts_the_later_frame_right() {
            // 3-7: 設計/API --> 実装。実装の枠 (a の 2 つ目) は設計の枠の右 (Q3-b)。調整と告知は設計の枠の下
            let doc = document(ALT_F2F);
            let (result, counts) = run("3-7", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            let design = area(&result, "a", id_at(&doc, &["設計"]));
            let later = area(&result, "a", id_at(&doc, &["実装"]));
            assert!(is_right_of(&later, &design));
            for label in ["調整", "告知"] {
                let rect = result.rects[&id_at(&doc, &[label])];
                assert!(is_below(&rect, &design), "{label} が設計の枠の下にない");
            }
        }

        #[test]
        fn pipeline_combos_alternate_siblings_cycle_puts_the_notice_below_the_source_frame() {
            // 3-8: 設計/画面 --> 告知 --> 設計/API は閉路になる出口なので、告知は後戻りして設計の枠の下の行 (Q3-b の閉路)。
            // API は告知より右なので、設計の枠が告知の右の端より右へ伸びる
            let doc = document(ALT_CYCLE);
            let (result, counts) = run("3-8", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            let design = area(&result, "a", id_at(&doc, &["設計"]));
            let notice = result.rects[&id_at(&doc, &["告知"])];
            assert!(is_below(&notice, &design));
            assert!(right(&design) > right(&notice));
        }

        #[test]
        fn pipeline_combos_frames_across_branches_exit_to_the_right_of_both() {
            // 3-9: 枝をまたぐ a (枝ごとに枠 2 つ、箱)。設計/画面 --> 告知 で、告知は設計の枝の枠の出口の子 (I6) で、両方の枠の右
            let doc = document(BRANCHES_OUT);
            let (result, counts) = run("3-9", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            let notice = result.rects[&id_at(&doc, &["告知"])];
            let source = area(&result, "a", id_at(&doc, &["設計", "画面"]));
            let other = area(&result, "a", id_at(&doc, &["実装", "画面"]));
            assert!(
                notice.x >= right(&source) + MARKMAP_DEFAULTS.spacing_horizontal - TOLERANCE,
                "告知が出口の枠の右に spacing_horizontal 以上離れない"
            );
            assert!(is_right_of(&notice, &other));
        }

        #[test]
        fn pipeline_combos_frames_across_branches_entry_stays_left_of_both() {
            // 3-10: 告知 --> 実装/画面。終点は最上位でないので付け替わらず、告知は両方の枠の左
            let doc = document(BRANCHES_IN);
            let (result, counts) = run("3-10", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 2)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 2, loose: 0 });
            assert_eq!(result.passes, 1);
            let notice = result.rects[&id_at(&doc, &["告知"])];
            let target = id_at(&doc, &["実装", "画面"]);
            assert_eq!(
                result.graph.layout_parent.get(&target),
                Some(&id_at(&doc, &["実装"]))
            );
            for branch in ["設計", "実装"] {
                let frame = area(&result, "a", id_at(&doc, &[branch, "画面"]));
                assert!(
                    is_right_of(&frame, &notice),
                    "{branch} の枠が告知の右にない"
                );
            }
        }

        #[test]
        fn pipeline_combos_single_member_groups_make_no_frames() {
            // 3-14 と 3-15: メンバー 1 つのグループは枠にならない (外から中、枠から枠)。1 回で終わる
            for (name, source) in [("3-14", SINGLE_IN), ("3-15", SINGLE_F2F)] {
                let doc = document(source);
                let (result, counts) = run(name, &doc);
                assert!(result.frames.is_empty(), "{name}");
                assert_eq!(counts, FrameBoxCounts { boxed: 0, loose: 0 }, "{name}");
                assert_eq!(result.passes, 1, "{name}");
            }
        }

        #[test]
        fn pipeline_combos_folded_member_inside_the_frame_keeps_the_exit_right_of_the_frame() {
            // 4-1: 画面を閉じるので始点の一覧は見えない (見えるノード 5)。枠は a の 1 つ (箱) で、告知は枠の右 (I6)
            let doc = document(FOLD_INSIDE_OUT);
            let (result, counts) = run("4-1", &doc);
            assert_eq!(frames_per_group(&result), per_group(&[("a", 1)]));
            assert_eq!(counts, FrameBoxCounts { boxed: 1, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(result.rects.len(), 5);
            assert!(
                !result
                    .rects
                    .contains_key(&id_at(&doc, &["設計", "画面", "一覧"]))
            );
            let frame = area(&result, "a", id_at(&doc, &["設計"]));
            let notice = result.rects[&id_at(&doc, &["告知"])];
            assert!(notice.x >= right(&frame) + MARKMAP_DEFAULTS.spacing_horizontal - TOLERANCE);
        }

        #[test]
        fn pipeline_combos_folded_frame_root_makes_no_frame() {
            // 4-2: 設計 (a の根) を閉じると見えるメンバーが 1 つで枠にならない (見えるノード 3)。告知は設計の配置上の子
            let doc = document(FOLD_ROOT_OUT);
            let (result, counts) = run("4-2", &doc);
            assert!(result.frames.is_empty());
            assert_eq!(counts, FrameBoxCounts { boxed: 0, loose: 0 });
            assert_eq!(result.passes, 1);
            assert_eq!(result.rects.len(), 3);
            assert_eq!(
                result.graph.layout_parent.get(&id_at(&doc, &["告知"])),
                Some(&id_at(&doc, &["設計"]))
            );
        }
    }
}

// PORT STATUS: confidence=high todos=0

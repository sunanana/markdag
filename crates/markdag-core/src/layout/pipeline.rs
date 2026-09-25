// 原文: src/view/view.ts (2026-09-24) の update の配置の流れ (944-978 行)。出力の形は scripts/judge/harness.ts の layoutFor
// view の配置の流れを 1 関数にしたもの (DESIGN (d)。やり直しの単位で、manifest の表の外。規則書 4 章のモジュールの木にある。A-171)。
// 射影 → 枠のまとまり → 配置の繰り返しを行う。枠の上下の端はメンバーの子の列の広がりで決まるので、1 回目の配置では
// 隣のメンバーでないノードが枠の矩形に入り込むことがある。2 回目からは前回の結果の張り出しのぶんだけ間隔を空け、
// 入り込みが 0 になるか回数の上限に達したら打ち切る。
// 枠の余白は LayoutOptions の extra_spacing (枠と前回の矩形の値) で layout_graph に渡し、FrameSpacing は layout_graph が
// 1 回の配置につき 1 度作る (A-019、A-039。ここでは frame_spacing を呼ばない)。
// layoutOverride (利用者の関数) の経路と、折りたたみの状態 (initialFold、visibleIds) は JS の view に残る (DESIGN (d))。
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::frames::{Frame, compute_frames, count_intruders, frame_outline};
use crate::layout::layout::{
    ExtraSpacing, LayoutOptions, MARKMAP_DEFAULTS, PlacedEdge, SpacingCall, check_layout_options,
    layout_children_of, layout_graph,
};
use crate::layout::project::{VisibleGraph, project};
use crate::types::{GroupDef, LayoutError, LayoutInput, Rect};

/// 原文: view.ts の MAX_LAYOUT_PASSES (審判の harness も同じ値)
pub const MAX_LAYOUT_PASSES: usize = 4;

/// 枠と、最後の回の矩形から作った枠の矩形 (harness の `{ ...frame, outline: frameOutline(frame, rects) }`)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocumentFrame {
    #[serde(flatten)]
    pub frame: Frame,
    /// 矩形のあるメンバーが 1 つもなければ null
    pub outline: Option<Rect>,
}

/// layout_document の戻り値 (DESIGN (b) の mdag_layout_document の出力。審判の layout と同じ欄、folded は入力側なので持たない)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDocumentResult {
    pub graph: VisibleGraph,
    /// 外側の枠が先 (compute_frames の順)
    pub frames: Vec<LayoutDocumentFrame>,
    /// 最後の回の配置。並びは flextree の each の順 (幅優先)
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
    /// 配置を行った回数 (1 始まり)
    pub passes: usize,
    /// 最後の回に flextree が呼んだ spacing の組と値 (枠の余白を含む合計)。境界の JSON には出さない (A-169)
    #[serde(skip)]
    pub spacing: Vec<SpacingCall>,
}

/// 原文: view.ts の update のうち layoutOverride が null の経路 (944-978 行)。
/// options が None なら MARKMAP_DEFAULTS、max_passes が None なら MAX_LAYOUT_PASSES (規則 2.6 の既定の引数)。
/// options の extra_spacing は使わず、回ごとに枠と前回の矩形から作り直す (view の `{ ...MARKMAP_DEFAULTS, extraSpacing }` と同じく上書き)。
/// 原文の打ち切りは `pass === MAX_LAYOUT_PASSES` (定数 4)。境界から 0 が来ても止まるよう `>=` で比べる (1 以上では同じ。A-170)
pub fn layout_document(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
) -> Result<LayoutDocumentResult, LayoutError> {
    let mut options = options.unwrap_or(MARKMAP_DEFAULTS);
    options.extra_spacing = None;
    let max_passes = max_passes.unwrap_or(MAX_LAYOUT_PASSES);
    // 入口の検査 (A-156 の (b))。大きさは project が、指定の数はここで、枠の余白より前に弾く
    check_layout_options(&options)?;

    let graph = project(input)?;
    // 兄弟の縦の並びは配置の前に決まっているので、枠のまとまりを先に作り、枠の余白が入るだけ間隔を空ける
    let frames = compute_frames(&graph, groups, groups_of, &layout_children_of(&graph));
    let mut previous: Option<IndexMap<u32, Rect>> = None;
    let mut pass: usize = 1;
    loop {
        // PERF(port): ExtraSpacing が frames と rects を所有するので回ごとに frames を写す。借用の形にすれば写しは要らない
        let result = layout_graph(
            &graph,
            Some(LayoutOptions {
                extra_spacing: Some(ExtraSpacing {
                    frames: frames.clone(),
                    rects: previous.take(),
                }),
                ..options.clone()
            }),
        )?;
        let targets: IndexMap<u32, Rect> = result
            .nodes
            .iter()
            .map(|(id, placed)| (*id, placed.rect))
            .collect();
        if count_intruders(&frames, &targets) == 0 || pass >= max_passes {
            let gaps: IndexMap<u32, f64> = result
                .nodes
                .iter()
                .map(|(id, placed)| (*id, placed.gap))
                .collect();
            let frames = frames
                .into_iter()
                .map(|frame| {
                    let outline = frame_outline(&frame, &targets);
                    LayoutDocumentFrame { frame, outline }
                })
                .collect();
            return Ok(LayoutDocumentResult {
                graph,
                frames,
                rects: targets,
                gaps,
                edges: result.edges,
                bounds: result.bounds,
                planned_x: result.planned_x,
                node_size: result.flextree_params.node_size,
                passes: pass,
                spacing: result.flextree_params.spacing,
            });
        }
        previous = Some(targets);
        pass += 1;
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
}

// PORT STATUS: confidence=high todos=0

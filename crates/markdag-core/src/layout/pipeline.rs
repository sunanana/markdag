// 原文: src/view/view.ts (2026-09-24) の update の配置の流れ (944-978 行)。出力の形は scripts/judge/harness.ts の layoutFor
// view の配置の流れを 1 関数にしたもの (DESIGN (d)。やり直しの単位で、manifest の表の外。規則書 4 章のモジュールの木にある。A-171)。
// 射影 → 枠のまとまり → 配置の繰り返しを行う。
// layout_document は、枠をできるだけ 1 つの矩形のまとまりとして配置する (layout/blocks.rs):
// (1) 配置上の親を選ぶとき、枠の外のノードを枠の中のノードの下に付けない (project_framed)。
// (2) メンバーが配置の木で閉じている枠は、中だけで配置してから、余白とラベルを足した矩形として外側に置く (frame_blocks)。
//     その枠の矩形には、メンバーでないノードも別の枠も入り込まない (入れ子の枠は外側の枠の中に収まる)。
// (3) 閉じていない枠 (メンバーの間にメンバーでないノードが挟まる) だけ、旧実装の繰り返しで間隔を空ける。
//     1 回目の配置では隣のメンバーでないノードが枠の矩形に入り込むことがあるので、2 回目からは前回の結果の張り出しのぶんだけ
//     間隔を空け、入り込みが 0 になるか回数の上限に達したら打ち切る。間隔を空けても入り込みが減らず、図の高さが 1 回で
//     STALL_GROWTH 倍以上に伸びた回が来たら、そこで打ち切って前の回の配置を採る。メンバーとメンバーでないノードが兄弟の並びで
//     交互に挟まると、空けた間隔のぶんだけ枠も伸びるので、入り込みは減らないまま図の高さが回ごとにほぼ倍になるため
//     (旧実装での docs/examples/notation.md は 340 → 682 → 1406 → 2842)。入り込みが 1 回足踏みしてから減る文書もある
//     (large-project.md を閉じた状態では 2 → 2 → 1 → 0、高さは +24%、+12%、+7%) ので、入り込みが減らないことだけでは打ち切らない。
// layout_document_exact は旧実装 (view の update) の流れそのまま: 配置上の親は枠を見ずに選び、すべての枠を繰り返しで扱い、
// 上限まで回す。回ごとの値を旧実装の記録と比べる試験が使う。
// 枠の余白は LayoutOptions の extra_spacing (枠と前回の矩形の値) で layout_graph に渡し、FrameSpacing は layout_graph が
// 1 回の配置につき 1 度作る (A-019、A-039。ここでは frame_spacing を呼ばない)。
// layoutOverride (利用者の関数) の経路と、折りたたみの状態 (initialFold、visibleIds) は JS の view に残る (DESIGN (d))。
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::frames::{
    Frame, FrameBlock, compute_frames, count_intruders, frame_blocks, frame_outline,
};
use crate::layout::layout::{
    ExtraSpacing, LayoutOptions, LayoutResult, MARKMAP_DEFAULTS, PlacedEdge, SpacingCall,
    check_layout_options, layout_children_of, layout_graph_blocked,
};
use crate::layout::project::{VisibleGraph, project, project_framed};
use crate::types::{GroupDef, LayoutError, LayoutInput, Rect};

/// 原文: view.ts の MAX_LAYOUT_PASSES (審判の harness も同じ値)
pub const MAX_LAYOUT_PASSES: usize = 4;

/// 入り込みが減らない回で、図の高さが前の回のこの倍率以上に伸びたら打ち切る (冒頭のコメント)。
/// 間隔が膨らみ続けるときは約 2 倍、入り込みが減っていくときは数十 % までなので、その間に置く
pub const STALL_GROWTH: f64 = 1.5;

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
    /// 採った回の配置。並びは flextree の each の順 (幅優先)
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
    /// 採った配置が何回目か (1 始まり)。入り込みが減らずに高さだけが伸びて打ち切ったときは、その前の回
    pub passes: usize,
    /// 採った回に flextree が呼んだ spacing の組と値 (枠の余白を含む合計)。境界の JSON には出さない (A-169)
    #[serde(skip)]
    pub spacing: Vec<SpacingCall>,
}

/// 原文: view.ts の update のうち layoutOverride が null の経路 (944-978 行) に、枠のまとまりを足したもの (冒頭のコメント)。
/// 枠のない文書では layout_document_exact と同じ結果になる。
/// options の extra_spacing は使わず、回ごとに枠と前回の矩形から作り直す (view の `{ ...MARKMAP_DEFAULTS, extraSpacing }` と同じく上書き)。
/// options が None なら MARKMAP_DEFAULTS、max_passes が None なら MAX_LAYOUT_PASSES (規則 2.6 の既定の引数)
pub fn layout_document(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
) -> Result<LayoutDocumentResult, LayoutError> {
    run_passes(input, groups, groups_of, options, max_passes, Mode::Framed)
}

/// 旧実装どおり、入り込みが 0 になるか回数の上限に達するまで配置をやり直す (入り込みが減らなくても続ける)。
/// max_passes を k にすると k 回目の配置がそのまま返るので、回ごとの値を旧実装の記録と比べる試験が使う。
/// 原文の打ち切りは `pass === MAX_LAYOUT_PASSES` (定数 4)。境界から 0 が来ても止まるよう `>=` で比べる (1 以上では同じ。A-170)
pub fn layout_document_exact(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
) -> Result<LayoutDocumentResult, LayoutError> {
    run_passes(input, groups, groups_of, options, max_passes, Mode::Exact)
}

/// 繰り返しを打ち切るか: 前の回と今の回の (入り込みの数, 図の高さ) で、入り込みが減らず、高さが STALL_GROWTH 倍以上に伸びた。
/// 打ち切ったら前の回の配置を採る (冒頭のコメント)
pub fn stalled(previous: (usize, f64), current: (usize, f64)) -> bool {
    current.0 >= previous.0 && current.1 >= previous.1 * STALL_GROWTH
}

// Framed: 枠をまとまりにする流れ (layout_document)。Exact: 旧実装の流れ (layout_document_exact)
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Framed,
    Exact,
}

// 1 回の配置の結果と、その矩形、入り込みの数、何回目か
struct Pass {
    result: LayoutResult,
    targets: IndexMap<u32, Rect>,
    intruders: usize,
    pass: usize,
}

fn run_passes(
    input: &LayoutInput,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    options: Option<LayoutOptions>,
    max_passes: Option<usize>,
    mode: Mode,
) -> Result<LayoutDocumentResult, LayoutError> {
    let mut options = options.unwrap_or(MARKMAP_DEFAULTS);
    options.extra_spacing = None;
    let max_passes = max_passes.unwrap_or(MAX_LAYOUT_PASSES);
    // 入口の検査 (A-156 の (b))。大きさは project が、指定の数はここで、枠の余白より前に弾く
    check_layout_options(&options)?;

    let graph = match mode {
        Mode::Framed => project_framed(input, groups, groups_of)?,
        Mode::Exact => project(input)?,
    };
    // 兄弟の縦の並びは配置の前に決まっているので、枠のまとまりを先に作り、枠の余白が入るだけ間隔を空ける
    let children_of = layout_children_of(&graph);
    let frames = compute_frames(&graph, groups, groups_of, &children_of);
    // まとまりにした枠は矩形ごと配置されるので、繰り返しで間隔を空けるのは残りの枠だけ
    let (blocks, loose): (Vec<FrameBlock>, Vec<Frame>) = match mode {
        Mode::Framed => {
            let (blocks, loose) = frame_blocks(&graph, &frames, &children_of);
            let loose = loose
                .into_iter()
                .filter_map(|index| frames.get(index).cloned())
                .collect();
            (blocks, loose)
        }
        Mode::Exact => (Vec::new(), frames.clone()),
    };
    let mut previous: Option<Pass> = None;
    let mut pass: usize = 1;
    loop {
        // PERF(port): ExtraSpacing が frames と rects を所有するので回ごとに frames と前回の矩形を写す。借用の形にすれば写しは要らない
        let result = layout_graph_blocked(
            &graph,
            Some(LayoutOptions {
                extra_spacing: Some(ExtraSpacing {
                    frames: loose.clone(),
                    rects: previous.as_ref().map(|kept| kept.targets.clone()),
                }),
                ..options.clone()
            }),
            &blocks,
        )?;
        let targets: IndexMap<u32, Rect> = result
            .nodes
            .iter()
            .map(|(id, placed)| (*id, placed.rect))
            .collect();
        let intruders = count_intruders(&frames, &targets);
        let current = Pass {
            result,
            targets,
            intruders,
            pass,
        };
        if mode == Mode::Framed {
            let height = current.result.bounds.height;
            if let Some(kept) = previous.take_if(|kept| {
                stalled(
                    (kept.intruders, kept.result.bounds.height),
                    (intruders, height),
                )
            }) {
                return Ok(finish(graph, frames, kept));
            }
        }
        if intruders == 0 || pass >= max_passes {
            return Ok(finish(graph, frames, current));
        }
        previous = Some(current);
        pass += 1;
    }
}

fn finish(graph: VisibleGraph, frames: Vec<Frame>, adopted: Pass) -> LayoutDocumentResult {
    let Pass {
        result,
        targets,
        pass,
        ..
    } = adopted;
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
    LayoutDocumentResult {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::layout::layout_graph;
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

    // docs/examples/notation.md を縮めたもの。1 root / 2 要件 / 3 設計 %d (4 画面、5 API) / 6 実装 %b (7 FE (8、9、10)、11 BE (12、13)) /
    // 14 検証 (15、16)。要件 --> 設計/*、設計 --> 実装 --> 検証、10 & 13 --> 検証、12 --> 9
    fn notation_like() -> (LayoutInput, Vec<GroupDef>, IndexMap<u32, Vec<String>>) {
        use crate::types::{LayoutInputRelation, RelationKind::*};
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
                relation(Fork, 2, 4),
                relation(Fork, 2, 5),
                relation(Chain, 3, 6),
                relation(Chain, 6, 14),
                relation(Join, 10, 14),
                relation(Join, 13, 14),
                relation(Depends, 12, 9),
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
        (input, vec![group("d"), group("b")], groups_of)
    }

    // 枠 (上のラベルの行を含む) どうしが重なる組と、枠に入り込むメンバーでないノードの数
    fn frame_collisions(result: &LayoutDocumentResult) -> (usize, usize) {
        let overlaps = |a: &Rect, b: &Rect| {
            a.x < b.x + b.width
                && b.x < a.x + a.width
                && a.y < b.y + b.height
                && b.y < a.y + a.height
        };
        let area = |frame: &LayoutDocumentFrame| {
            frame.outline.map(|outline| Rect {
                y: outline.y - crate::layout::frames::LABEL_HEIGHT,
                height: outline.height + crate::layout::frames::LABEL_HEIGHT,
                ..outline
            })
        };
        let mut pairs = 0;
        for (index, a) in result.frames.iter().enumerate() {
            for b in &result.frames[index + 1..] {
                if let (Some(ra), Some(rb)) = (area(a), area(b))
                    && overlaps(&ra, &rb)
                {
                    pairs += 1;
                }
            }
        }
        let frames: Vec<Frame> = result
            .frames
            .iter()
            .map(|frame| frame.frame.clone())
            .collect();
        (pairs, count_intruders(&frames, &result.rects))
    }

    #[test]
    fn pipeline_blocks_keep_frames_apart_where_the_old_flow_overlaps() {
        let (input, groups, groups_of) = notation_like();
        let old = layout_document_exact(&input, &groups, &groups_of, None, None).unwrap();
        let (old_pairs, old_intruders) = frame_collisions(&old);
        assert!(
            old_pairs + old_intruders > 0,
            "旧実装の流れでは枠が重なるか、入り込みがある"
        );

        let new = layout_document(&input, &groups, &groups_of, None, None).unwrap();
        assert_eq!(frame_collisions(&new), (0, 0));
        assert_eq!(new.passes, 1);
        // 実装 (6) と検証 (14) は、枠 d と枠 b のメンバーの下に付けず、ルートの下に置く
        assert_eq!(new.graph.layout_parent.get(&6), Some(&1));
        assert_eq!(new.graph.layout_parent.get(&14), Some(&1));
        // 横位置は relations の向きで決まるので変わらない
        assert_eq!(new.planned_x, old.planned_x);
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

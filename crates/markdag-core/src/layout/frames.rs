// 原文: src/view/frames.ts (2026-09-24)
// グループの枠の計算 (簡易版)。枠を持つグループごとに、見えているメンバーのまとまりを作り、入れ子の深さを決める。
// ラベルは枠の外側 (上の辺のすぐ上) に、左の角にそろえて置く。
// 入れ子の外側の枠は、内側の枠より一回り大きくして、枠の線とラベルが重ならないようにする。
// 枠の中に見えてよいのはメンバーだけにする。枠はメンバーの子の列の広がりで上下に張り出すので、隣のメンバーでないノード
// (閉じた枝など) がその下に入り込まないよう、張り出しのぶんだけ間隔を空ける。張り出しは配置の結果で決まるので、配置は 2 回以上行う。
// 原文の frameSpacing (関数を返す) は、framesOf と outlines を前計算した FrameSpacing と between にした (規則 2.6、A-039)
use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::layout::layout::bounds_of;
use crate::layout::project::VisibleGraph;
use crate::model::util::js_max;
use crate::types::{GroupDef, Rect};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub group: GroupDef,
    pub members: Vec<u32>,
    /// 内側に含む枠の段数。内側に枠がなければ 0
    pub level: u32,
}

// 境界に出ない (枠の余白の計算は JS にも写しを残す。DESIGN (c)) ので f64 の欄に js_f64 は付けない
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePadding {
    pub top: f64,
    pub side: f64,
    pub bottom: f64,
}

const BASE_PADDING: f64 = 8.0;
/// ラベルの行の高さ
pub const LABEL_HEIGHT: f64 = 14.0;
// 入れ子の 1 段ごとに、外側の枠を広げる幅。四辺とも同じにして、内側の枠との間隔をそろえる。
// 上側では、内側の枠のラベルの行 (内側の枠の上の辺のすぐ上) がこの幅の中に入るので、ラベルの行が収まる大きさにしている
const NEST_STEP: f64 = BASE_PADDING + LABEL_HEIGHT;

/// 原文: framePadding
pub fn frame_padding(level: u32) -> FramePadding {
    let side = BASE_PADDING + f64::from(level) * NEST_STEP;
    FramePadding {
        top: side,
        side,
        bottom: side,
    }
}

/// 原文: frameClearance。
/// 枠の外の隣のノードとの間に空ける幅。上側は、枠の上の辺の上に置くラベルの行が入るだけ、枠の余白より広い
pub fn frame_clearance(level: u32) -> FramePadding {
    let padding = frame_padding(level);
    FramePadding {
        top: padding.top + LABEL_HEIGHT,
        ..padding
    }
}

/// 原文: frameRect
pub fn frame_rect(bounds: &Rect, level: u32) -> Rect {
    let padding = frame_padding(level);
    Rect {
        x: bounds.x - padding.side,
        y: bounds.y - padding.top,
        width: bounds.width + padding.side * 2.0,
        height: bounds.height + padding.top + padding.bottom,
    }
}

// union-find の根。leader は反復しないので HashMap (A-008)。原文の閉包 find を自由な関数にした (規則 2.6、A-040)
fn find(leader: &HashMap<u32, u32>, id: u32) -> u32 {
    let mut root = id;
    while leader.get(&root) != Some(&root) {
        root = leader.get(&root).copied().unwrap_or(root);
    }
    root
}

// 原文の閉包 union (規則 2.6、A-040)。評価の順は find(a) → find(b) → set (規則 2.3)
fn union(leader: &mut HashMap<u32, u32>, a: u32, b: u32) {
    let root_a = find(leader, a);
    let root_b = find(leader, b);
    leader.insert(root_a, root_b);
}

// 入れ子の判定: 相手のメンバーをすべて含む枠が外側。メンバーが同じなら、groups で先に定義されたほうを外側にする。
// 原文の閉包 contains (規則 2.6、A-040)。枠の同一性は frames の添字で比べる (規則 2.3)
fn contains(
    order: &HashMap<&str, usize>,
    outer: (usize, &Frame, &HashSet<u32>),
    inner: (usize, &Frame),
) -> bool {
    let (outer_index, outer_frame, outer_set) = outer;
    let (inner_index, inner_frame) = inner;
    outer_index != inner_index
        && inner_frame.members.iter().all(|id| outer_set.contains(id))
        && (outer_frame.members.len() > inner_frame.members.len()
            || order
                .get(outer_frame.group.id.as_str())
                .copied()
                .unwrap_or(0)
                < order
                    .get(inner_frame.group.id.as_str())
                    .copied()
                    .unwrap_or(0))
}

// 原文の閉包 levelOf (記憶つきの再帰。規則 2.6、A-040) を反復にした (A-105 (a))。
// 枠の段は、内側に含む枠をたどる最も長い鎖の長さ。contains が当たる内側の枠は (メンバーの数, groups の順の逆) で必ず小さい
// (メンバーが包まれるので数は同じか少なく、同じなら groups で後に定義されている) ので、この順に小さい側から決めれば、
// 内側の枠の段は先に決まっている。結果は記憶つきの再帰と同じで、枠の入れ子がどれだけ深くてもスタックを使わない
fn frame_levels(frames: &[Frame], sets: &[HashSet<u32>], order: &HashMap<&str, usize>) -> Vec<u32> {
    let rank = |frame: &Frame| {
        (
            frame.members.len(),
            std::cmp::Reverse(order.get(frame.group.id.as_str()).copied().unwrap_or(0)),
        )
    };
    let mut ascending: Vec<(usize, &Frame, &HashSet<u32>)> = frames
        .iter()
        .zip(sets)
        .enumerate()
        .map(|(index, (frame, set))| (index, frame, set))
        .collect();
    ascending.sort_by_key(|&(_, frame, _)| rank(frame));
    // levels は反復しないので添字 → 段の HashMap (A-008、A-166)
    let mut levels: HashMap<usize, u32> = HashMap::new();
    for &(index, frame, set) in &ascending {
        let level = frames
            .iter()
            .enumerate()
            .filter(|&(candidate_index, candidate)| {
                contains(order, (index, frame, set), (candidate_index, candidate))
            })
            // TODO(port): Rust 側の不到達 (contains が当たる枠は順が小さく、段は先に決まっている)
            .filter_map(|(candidate_index, _)| levels.get(&candidate_index).copied())
            .map(|inner_level| inner_level.saturating_add(1))
            .fold(0, u32::max);
        levels.insert(index, level);
    }
    // TODO(port): Rust 側の不到達 (どの添字も上の for で入れてある)
    (0..frames.len())
        .map(|index| levels.get(&index).copied().unwrap_or(0))
        .collect()
}

/// 原文: computeFrames。
/// sibling_order は、配置上の親ごとの、子の上から下への並び。
/// 原文の model は `Pick<GraphModel, 'groups' | 'groupsOf'>` で、境界から欄だけが届くので欄ごとの引数にした (A-038)
pub fn compute_frames(
    graph: &VisibleGraph,
    groups: &[GroupDef],
    groups_of: &IndexMap<u32, Vec<String>>,
    sibling_order: &IndexMap<u32, Vec<u32>>,
) -> Vec<Frame> {
    let mut frames: Vec<Frame> = Vec::new();
    for group in groups.iter().filter(|candidate| candidate.boundary) {
        let members: Vec<u32> = graph
            .nodes
            .iter()
            .filter(|node| {
                groups_of
                    .get(&node.id)
                    .is_some_and(|list| list.contains(&group.id))
            })
            .map(|node| node.id)
            .collect();
        let member_set: HashSet<u32> = members.iter().copied().collect();
        let mut leader: HashMap<u32, u32> = members.iter().map(|&id| (id, id)).collect();

        // まとまりの条件: ツリーの線で直接つながっている、または、同じ配置上の親の下で縦に隣り合っている
        for node in &graph.nodes {
            if let Some(parent) = node.tree_parent
                && member_set.contains(&node.id)
                && member_set.contains(&parent)
            {
                union(&mut leader, node.id, parent);
            }
        }
        for siblings in sibling_order.values() {
            for (id, next) in siblings.iter().zip(siblings.iter().skip(1)) {
                if member_set.contains(id) && member_set.contains(next) {
                    union(&mut leader, *id, *next);
                }
            }
        }
        // 値の順が frames の順 (members の中で各まとまりの根が最初に現れた順。規則 2.3)
        let mut components: IndexMap<u32, Vec<u32>> = IndexMap::new();
        for &id in &members {
            let root = find(&leader, id);
            // PERF(port): 原文の `[...(get ?? []), id]` の写しを作り直さず entry().or_default().push(id) で足りる
            let mut list = components.get(&root).cloned().unwrap_or_default();
            list.push(id);
            components.insert(root, list);
        }
        // メンバーが 1 つだけのまとまりは、色帯で所属が分かるので枠にしない
        for component in components.into_values() {
            if component.len() >= 2 {
                frames.push(Frame {
                    group: group.clone(),
                    members: component,
                    level: 0,
                });
            }
        }
    }

    // 入れ子の判定: 相手のメンバーをすべて含む枠が外側。メンバーが同じなら、groups で先に定義されたほうを外側にする。
    // order は反復しないので HashMap (A-008)。同じ id が 2 度あれば後勝ち (new Map と同じ)
    let order: HashMap<&str, usize> = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.id.as_str(), index))
        .collect();
    let sets: Vec<HashSet<u32>> = frames
        .iter()
        .map(|frame| frame.members.iter().copied().collect())
        .collect();
    let computed = frame_levels(&frames, &sets, &order);
    for (frame, level) in frames.iter_mut().zip(computed) {
        frame.level = level;
    }
    // 外側の枠から先に描く (安定な sort。規則 2.3)
    frames.sort_by(|a, b| b.level.cmp(&a.level));
    frames
}

/// 原文: frameOutline。
/// メンバーの外接矩形に余白を足した、枠の矩形。矩形のあるメンバーが 1 つもなければ None
pub fn frame_outline(frame: &Frame, rects: &IndexMap<u32, Rect>) -> Option<Rect> {
    let inside: Vec<Rect> = frame
        .members
        .iter()
        .filter_map(|id| rects.get(id).copied())
        .collect();
    if inside.is_empty() {
        None
    } else {
        Some(frame_rect(&bounds_of(&inside), frame.level))
    }
}

/// 原文: countIntruders。
/// 枠の矩形に重なっている、メンバーでないノードの数。配置をやり直しても入り込みが残っているかを確かめるのに使う
pub fn count_intruders(frames: &[Frame], rects: &IndexMap<u32, Rect>) -> usize {
    let mut count = 0;
    for frame in frames {
        let Some(outline) = frame_outline(frame, rects) else {
            continue;
        };
        for (id, rect) in rects {
            let overlaps = rect.x < outline.x + outline.width
                && rect.x + rect.width > outline.x
                && rect.y < outline.y + outline.height
                && rect.y + rect.height > outline.y;
            if overlaps && rect.width > 0.0 && rect.height > 0.0 && !frame.members.contains(id) {
                count += 1;
            }
        }
    }
    count
}

// overhang の side (原文の `'top' | 'bottom'`。規則 2.6 の局所の union、A-041)
#[derive(Clone, Copy)]
enum Side {
    Top,
    Bottom,
}

// ノードを含む枠 1 つと、その枠の矩形 (前回の配置の結果がなければ None)
#[derive(Debug, Clone)]
struct FrameEntry<'a> {
    frame: &'a Frame,
    outline: Option<Rect>,
}

/// 原文: frameSpacing が返す関数の中身。framesOf (id → そのノードを含む枠と枠の矩形、frames の順) を前計算して持つ。
/// 1 回の配置につき 1 度作り、兄弟の組ごとに between を呼ぶ (A-039)
#[derive(Debug, Clone)]
pub struct FrameSpacing<'a> {
    // 反復しないので HashMap (A-008)。原文の outlines (Frame → 矩形の Map) は、各枠の項目に矩形を添えて持つ
    frames_of: HashMap<u32, Vec<FrameEntry<'a>>>,
    rects: Option<&'a IndexMap<u32, Rect>>,
}

/// 原文: frameSpacing。
/// 兄弟方向に隣り合う 2 ノード (upper が上、lower が下) の間に足す間隔。片方だけを囲む枠が、2 つの間に収まるだけ空ける。
/// 上のノードを囲む枠は下へ、下のノードを囲む枠は上へ (ラベルの行も含めて) 張り出す。張り出しの大きさは、
/// rects (前回の配置の結果) があればそこから求める。なければ、枠の余白のぶんだけを見込む。
/// 相手のノードが枠の横の範囲の外にあるときは、縦にどこへ置いても枠の矩形には入らないので、その枠のぶんは空けない。
/// 空けると、枠の右にある収束先 (外側の枠の下の端まで離そうとする) などで、図が縦に大きく広がってしまう
pub fn frame_spacing<'a>(
    frames: &'a [Frame],
    rects: Option<&'a IndexMap<u32, Rect>>,
) -> FrameSpacing<'a> {
    let mut frames_of: HashMap<u32, Vec<FrameEntry<'a>>> = HashMap::new();
    for frame in frames {
        let outline = rects.and_then(|rects| frame_outline(frame, rects));
        for &id in &frame.members {
            frames_of
                .entry(id)
                .or_default()
                .push(FrameEntry { frame, outline });
        }
    }
    FrameSpacing { frames_of, rects }
}

impl FrameSpacing<'_> {
    /// 原文: frameSpacing が返す `(upper, lower) => number`
    pub fn between(&self, upper: u32, lower: u32) -> f64 {
        // 枠 frame が、その中の inside から、枠の外の outside の側へ張り出している幅 (読むだけの閉包。A-040)
        let overhang = |entry: &FrameEntry, inside: u32, outside: u32, side: Side| -> f64 {
            let rect = self.rects.and_then(|rects| rects.get(&inside));
            let other = self.rects.and_then(|rects| rects.get(&outside));
            let (Some(outline), Some(rect), Some(other)) = (entry.outline, rect, other) else {
                let clearance = frame_clearance(entry.frame.level);
                return match side {
                    Side::Top => clearance.top,
                    Side::Bottom => clearance.bottom,
                };
            };
            if other.x >= outline.x + outline.width || other.x + other.width <= outline.x {
                return 0.0;
            }
            match side {
                Side::Top => rect.y - outline.y + LABEL_HEIGHT,
                Side::Bottom => outline.y + outline.height - (rect.y + rect.height),
            }
        };
        let empty: &[FrameEntry] = &[];
        let frames_of = |id: u32| self.frames_of.get(&id).map_or(empty, Vec::as_slice);
        let only_upper: Vec<&FrameEntry> = frames_of(upper)
            .iter()
            .filter(|entry| !entry.frame.members.contains(&lower))
            .collect();
        let only_lower: Vec<&FrameEntry> = frames_of(lower)
            .iter()
            .filter(|entry| !entry.frame.members.contains(&upper))
            .collect();
        // Math.max(0, ...xs) は 0 を初期値に js_max で畳む (空なら 0。規則 2.1)
        only_upper
            .iter()
            .map(|entry| overhang(entry, upper, lower, Side::Bottom))
            .collect::<Vec<f64>>()
            .into_iter()
            .fold(0.0, js_max)
            + only_lower
                .iter()
                .map(|entry| overhang(entry, lower, upper, Side::Top))
                .collect::<Vec<f64>>()
                .into_iter()
                .fold(0.0, js_max)
    }
}

#[cfg(test)]
mod tests {
    // 原文 test/frames.test.ts の 6 件の写し
    use super::*;
    use crate::layout::layout::layout_children_of;
    use crate::layout::project::project;
    use crate::types::{LayoutInput, LayoutInputEdge, LayoutInputNode};

    // 1 root / 2 仕様策定 (dev) / 3 画面開発 (frontend) / 4, 5 その子 / 6 API開発 (backend) / 7, 8 その子 / 9 効果測定 (backend, frontend)
    const PARENTS: [Option<u32>; 9] = [
        None,
        Some(1),
        Some(2),
        Some(3),
        Some(3),
        Some(2),
        Some(6),
        Some(6),
        Some(1),
    ];

    fn input() -> LayoutInput {
        LayoutInput {
            name: "nested-groups".to_string(),
            nodes: (1..=9)
                .map(|id| LayoutInputNode {
                    id,
                    label: format!("n{id}"),
                    width: 40.0,
                    height: 20.0,
                    groups: Vec::new(),
                })
                .collect(),
            tree_edges: PARENTS
                .iter()
                .zip(1..)
                .filter_map(|(parent, target)| {
                    parent.map(|source| LayoutInputEdge { source, target })
                })
                .collect(),
            relations: Vec::new(),
            suppress_root_line: Vec::new(),
            folded: Vec::new(),
        }
    }

    fn group(id: &str) -> GroupDef {
        GroupDef {
            id: id.to_string(),
            label: id.to_string(),
            color: Some("#888".to_string()),
            boundary: true,
            defined: true,
        }
    }

    fn groups_of(entries: &[(u32, &[&str])]) -> IndexMap<u32, Vec<String>> {
        entries
            .iter()
            .map(|(id, groups)| (*id, groups.iter().map(|g| g.to_string()).collect()))
            .collect()
    }

    fn model() -> (Vec<GroupDef>, IndexMap<u32, Vec<String>>) {
        (
            vec![group("dev"), group("backend"), group("frontend")],
            groups_of(&[
                (1, &[]),
                (2, &["dev"]),
                (3, &["dev", "frontend"]),
                (4, &["dev", "frontend"]),
                (5, &["dev", "frontend"]),
                (6, &["dev", "backend"]),
                (7, &["dev", "backend"]),
                (8, &["dev", "backend"]),
                (9, &["backend", "frontend"]),
            ]),
        )
    }

    fn frames() -> (VisibleGraph, Vec<Frame>) {
        let graph = project(&input()).unwrap();
        let (groups, groups_of) = model();
        let frames = compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
        (graph, frames)
    }

    fn frame_of<'a>(frames: &'a [Frame], id: &str) -> &'a Frame {
        frames.iter().find(|frame| frame.group.id == id).unwrap()
    }

    fn rect(x: f64, y: f64) -> Rect {
        Rect {
            x,
            y,
            width: 40.0,
            height: 20.0,
        }
    }

    #[test]
    fn frames_nested_frames_have_levels_and_single_member_components_are_dropped() {
        let (_, frames) = frames();
        let rows: Vec<(&str, Vec<u32>, u32)> = frames
            .iter()
            .map(|frame| (frame.group.id.as_str(), frame.members.clone(), frame.level))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("dev", vec![2, 3, 4, 5, 6, 7, 8], 1),
                ("backend", vec![6, 7, 8], 0),
                ("frontend", vec![3, 4, 5], 0),
            ]
        );
    }

    #[test]
    fn frames_outer_frame_is_22px_larger_on_every_side() {
        let bounds = Rect {
            x: 100.0,
            y: 50.0,
            width: 300.0,
            height: 120.0,
        };
        for level in [1, 2] {
            let inner = frame_rect(&bounds, level - 1);
            let outer = frame_rect(&bounds, level);
            assert_eq!(inner.x - outer.x, 22.0);
            assert_eq!(inner.y - outer.y, 22.0);
            assert_eq!(outer.x + outer.width - (inner.x + inner.width), 22.0);
            assert_eq!(outer.y + outer.height - (inner.y + inner.height), 22.0);
        }
    }

    #[test]
    fn frames_clearance_adds_the_label_row_only_on_top() {
        for level in [0, 1] {
            assert_eq!(
                frame_clearance(level).top,
                frame_padding(level).top + LABEL_HEIGHT
            );
            assert_eq!(frame_clearance(level).bottom, frame_padding(level).bottom);
        }
    }

    #[test]
    fn frames_spacing_adds_padding_and_label_row_of_frames_containing_only_one_side() {
        let (_, frames) = frames();
        let spacing = frame_spacing(&frames, None);
        let level0 = frame_clearance(0);
        let level1 = frame_clearance(1);
        // 同じ枠の中どうし
        assert_eq!(spacing.between(4, 5), 0.0);
        // フロントエンドの枠の下と、バックエンドの枠の上 (どちらも開発の枠の中)
        assert_eq!(spacing.between(5, 7), level0.bottom + level0.top);
        // 開発の枠の外のノードが下に来るときは、外側の枠の下の余白が入るだけ空ける。上に来るときは、上の余白とラベルの行
        assert_eq!(spacing.between(8, 9), level1.bottom);
        assert_eq!(spacing.between(9, 2), level1.top);
        assert_eq!(spacing.between(1, 9), 0.0);
        assert_eq!(frame_of(&frames, "dev").level, 1);
    }

    #[test]
    fn frames_spacing_uses_previous_rects_to_clear_the_overhang() {
        let (_, frames) = frames();
        let frontend = frame_of(&frames, "frontend").clone();
        // 3 = 画面開発、4 と 5 = その子 (上下に広がる)。9 (効果測定) は 3 のすぐ上にあり、子の列で決まる枠の上の端より下に来ている
        let rects: IndexMap<u32, Rect> = IndexMap::from([
            (3, rect(100.0, 50.0)),
            (4, rect(200.0, 20.0)),
            (5, rect(200.0, 80.0)),
            (9, rect(100.0, 25.0)),
            (6, rect(100.0, 75.0)),
        ]);
        assert_eq!(
            frame_outline(&frontend, &rects),
            Some(Rect {
                x: 92.0,
                y: 12.0,
                width: 156.0,
                height: 96.0
            })
        );
        let only = [frontend];
        assert_eq!(count_intruders(&only, &rects), 2);

        let spacing = frame_spacing(&only, Some(&rects));
        // 上のノードとの間は、枠の上の端 (y 12) まで上がれるだけの幅に、ラベルの行を足す。下のノードとの間は、枠の下の端 (y 108) まで
        assert_eq!(spacing.between(9, 3), 50.0 - 12.0 + LABEL_HEIGHT);
        assert_eq!(spacing.between(3, 6), 108.0 - 70.0);
        assert_eq!(spacing.between(4, 5), 0.0);
        // 枠の横の範囲 (x 92〜248) の外にあるノードは、縦にどこへ置いても枠に入らないので、その枠のぶんは空けない
        let mut outside = rects.clone();
        outside.insert(7, rect(300.0, 60.0));
        assert_eq!(frame_spacing(&only, Some(&outside)).between(5, 7), 0.0);
        assert_eq!(frame_spacing(&only, Some(&outside)).between(7, 5), 0.0);
        // 配置の結果がないうちは、枠の余白とラベルの行だけを見込む
        assert_eq!(
            frame_spacing(&only, None).between(9, 3),
            frame_clearance(0).top
        );
        assert_eq!(
            frame_spacing(&only, None).between(3, 6),
            frame_clearance(0).bottom
        );
    }

    // 原文の 6 件にない補い: 枠の横の範囲の端ちょうどにあるノード (期待値は原文を vite-node で同じ入力に通した値)
    #[test]
    fn frames_spacing_at_the_horizontal_edges_of_the_outline() {
        let frame = Frame {
            group: group("a"),
            members: vec![1, 2],
            level: 0,
        };
        let rects: IndexMap<u32, Rect> = IndexMap::from([
            (1, rect(100.0, 50.0)),
            (2, rect(100.0, 80.0)),
            (3, rect(148.0, 60.0)),
            (4, rect(52.0, 60.0)),
            (5, rect(147.5, 60.0)),
            (
                6,
                Rect {
                    x: 200.0,
                    y: 40.0,
                    width: 0.0,
                    height: 20.0,
                },
            ),
        ]);
        let frames = [frame];
        assert_eq!(
            frame_outline(&frames[0], &rects),
            Some(Rect {
                x: 92.0,
                y: 42.0,
                width: 56.0,
                height: 66.0
            })
        );
        let spacing = frame_spacing(&frames, Some(&rects));
        let values: Vec<f64> = [(2, 3), (3, 1), (2, 4), (4, 1), (2, 5), (5, 1), (2, 6)]
            .iter()
            .map(|&(upper, lower)| spacing.between(upper, lower))
            .collect();
        assert_eq!(values, vec![0.0, 0.0, 0.0, 0.0, 8.0, 22.0, 0.0]);
        assert_eq!(count_intruders(&frames, &rects), 1);
    }

    #[test]
    fn frames_with_same_members_put_the_earlier_defined_group_outside() {
        let graph = project(&input()).unwrap();
        let groups = vec![group("a"), group("b")];
        let groups_of: IndexMap<u32, Vec<String>> = (1..=9)
            .map(|id| {
                let list = if [3, 4, 5].contains(&id) {
                    vec!["a".to_string(), "b".to_string()]
                } else {
                    Vec::new()
                };
                (id, list)
            })
            .collect();
        let result = compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
        let rows: Vec<(&str, u32)> = result
            .iter()
            .map(|frame| (frame.group.id.as_str(), frame.level))
            .collect();
        assert_eq!(rows, vec![("a", 1), ("b", 0)]);
    }

    #[test]
    fn frames_deep_nesting_does_not_recurse() {
        // 同じ 2 つのメンバーを持つ枠 2000 個は groups の順で 1 本の鎖に入れ子になる。
        // 段は反復で決めるので、wasm の既定と同じ 1 MiB のスタックでも溢れない
        let count = 2000u32;
        let levels = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                let graph = project(&input()).unwrap();
                let groups: Vec<GroupDef> = (0..count).map(|i| group(&format!("g{i}"))).collect();
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
                compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph))
                    .iter()
                    .map(|frame| (frame.group.id.clone(), frame.level))
                    .collect::<Vec<_>>()
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(levels.len(), count as usize);
        assert_eq!(levels.first(), Some(&("g0".to_string(), count - 1)));
        assert_eq!(levels.last(), Some(&(format!("g{}", count - 1), 0)));
    }
}

// PORT STATUS: confidence=high todos=2

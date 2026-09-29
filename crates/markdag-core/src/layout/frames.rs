// 原文: src/view/frames.ts (2026-09-24)
// グループの枠の計算 (簡易版)。枠を持つグループごとに、見えているメンバーのまとまりを作り、入れ子の深さを決める。
// ラベルは枠の外側 (上の辺のすぐ上) に、左の角にそろえて置く。
// 入れ子の外側の枠は、内側の枠より一回り大きくして、枠の線とラベルが重ならないようにする。
// 枠の中に見えてよいのはメンバーだけにする。枠はメンバーの子の列の広がりで上下に張り出すので、隣のメンバーでないノード
// (閉じた枝など) がその下に入り込まないよう、張り出しのぶんだけ間隔を空ける。張り出しは配置の結果で決まるので、
// 1 つの矩形の箱にできない枠 (loose) があるときは配置を繰り返す。
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

/// 1 つの矩形の箱として配置する枠。
/// 根は、メンバーのうち配置上の親 (layout_parent) がメンバーでないもの
#[derive(Debug, Clone, PartialEq)]
pub struct FrameBlock {
    /// frames の添字
    pub frame: usize,
    /// 根の配置上の親。根が graph.root_id なら None
    pub parent: Option<u32>,
    /// parent の子の並びで縦に隣り合う根 (上から順)
    pub roots: Vec<u32>,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameBlocks {
    /// 内側から配置する順 (メンバーの少ない順、同じなら level の低い順、さらに同じなら frames の順)
    pub blocks: Vec<FrameBlock>,
    /// 箱にできなかった枠 (frames の添字、昇順)
    pub loose: Vec<usize>,
}

/// 原文なし。
/// 枠を、箱にできるもの (FrameBlocks::blocks) とできないもの (loose) に分ける。箱にするのは、
/// 根が同じ配置上の親の下で縦に隣り合い (根がルートなら根はそれ 1 つ)、先に箱にしたどの枠ともメンバーの集合が
/// 入れ子か交わらない枠。親の違う枠どうしも比べるので、箱の集合はメンバーの包含で木になる。
/// 根の下にメンバーでないノードがいても箱から外さない (出口の子として後の段が箱の外へ移す)。
/// children_of は layout_children_of の結果
pub fn frame_blocks(
    graph: &VisibleGraph,
    frames: &[Frame],
    children_of: &IndexMap<u32, Vec<u32>>,
) -> FrameBlocks {
    // ルートから配置の木で届くノード。壊れた入力 (layout_parent の閉路) で木から外れたノードを根に持つ枠は箱にしない。
    // 幅優先に並べて深い木でもスタックを使わず、同じノードは 1 度だけ並べるので閉路でも終わる
    let mut order: Vec<u32> = vec![graph.root_id];
    let mut reachable: HashSet<u32> = HashSet::from([graph.root_id]);
    let mut index = 0;
    while let Some(&id) = order.get(index) {
        for &child in children_of.get(&id).map(Vec::as_slice).unwrap_or(&[]) {
            if reachable.insert(child) {
                order.push(child);
            }
        }
        index += 1;
    }
    let position_of = |parent: u32, id: u32| {
        children_of
            .get(&parent)
            .and_then(|list| list.iter().position(|&child| child == id))
    };

    let mut candidates: Vec<(FrameBlock, HashSet<u32>)> = Vec::new();
    let mut loose: Vec<usize> = Vec::new();
    for (frame_index, frame) in frames.iter().enumerate() {
        let members: HashSet<u32> = frame.members.iter().copied().collect();
        let roots: Vec<u32> = frame
            .members
            .iter()
            .copied()
            .filter(|id| {
                graph
                    .layout_parent
                    .get(id)
                    .is_none_or(|parent| !members.contains(parent))
            })
            .collect();
        let parent = roots
            .first()
            .and_then(|root| graph.layout_parent.get(root).copied());
        let same_parent = !roots.is_empty()
            && roots.iter().all(|root| {
                reachable.contains(root) && graph.layout_parent.get(root).copied() == parent
            });
        let ordered = match parent {
            None => (roots.len() == 1 && roots[0] == graph.root_id).then(|| roots.clone()),
            Some(parent) => {
                let mut positioned: Vec<(usize, u32)> = roots
                    .iter()
                    .filter_map(|&root| position_of(parent, root).map(|position| (position, root)))
                    .collect();
                positioned.sort_by_key(|&(position, _)| position);
                let adjacent = positioned.len() == roots.len()
                    && positioned.windows(2).all(|pair| pair[1].0 == pair[0].0 + 1);
                adjacent.then(|| positioned.into_iter().map(|(_, root)| root).collect())
            }
        };
        match ordered {
            Some(roots) if same_parent => candidates.push((
                FrameBlock {
                    frame: frame_index,
                    parent,
                    roots,
                    level: frame.level,
                },
                members,
            )),
            _ => loose.push(frame_index),
        }
    }
    // 安定な sort なので、メンバーの数と level が同じ枠は frames の順 (= groups に書いた順) のまま
    candidates.sort_by_key(|(block, members)| (members.len(), block.level));

    let mut taken: Vec<HashSet<u32>> = Vec::new();
    let mut blocks: Vec<FrameBlock> = Vec::new();
    for (block, members) in candidates {
        // 一部だけ重なる 2 つの枠は、同じ配置の木の中で両方を矩形の箱にできないので、先に選んだほうだけを箱にする。
        // members は HashSet だが、交わりの数を数えるだけなので回す順は結果に出ない (A-008)
        // PERF(spec): 箱の候補ごとに先に取った箱すべてとメンバーの交わりを数える。深い入れ子で枠の数の 2 乗 × メンバー (設計 段 1 の計算量のとおり)
        let laminar = taken.iter().all(|other| {
            let common = members.iter().filter(|id| other.contains(id)).count();
            common == 0 || common == members.len() || common == other.len()
        });
        if laminar {
            taken.push(members);
            blocks.push(block);
        } else {
            loose.push(block.frame);
        }
    }
    loose.sort();
    FrameBlocks { blocks, loose }
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
    use crate::types::{
        LayoutInput, LayoutInputEdge, LayoutInputNode, LayoutInputRelation, RelationKind,
    };

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
            icon: None,
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
    // ---- 段 1: 箱にする枠の選び方 (frame_blocks) ----
    // 設計の段 1 の「確かめること」と、境界と誤りの入力。期待値は設計の段 1 の条件 (条件 1 は調べない。条件 2 は根が同じ親の下で
    // 縦に隣り合う。条件 3 は先に選んだ箱のすべてとメンバーの集合が入れ子か交わらない) と並び (メンバーの少ない順、同じなら level の
    // 低い順、さらに同じなら frames の順) から導く。
    // 仮定したシグネチャ: 設計の段 1 の「入力と出力の形」のとおり
    //     pub fn frame_blocks(graph: &VisibleGraph, frames: &[Frame], children_of: &IndexMap<u32, Vec<u32>>) -> FrameBlocks
    //     FrameBlocks { blocks: Vec<FrameBlock>, loose: Vec<usize> }
    //     FrameBlock { frame: usize, parent: Option<u32>, roots: Vec<u32>, level: u32 }
    // 設計が決めていない所として、FrameBlock と FrameBlocks の derive (Debug、PartialEq など) には頼らず、欄を読んで比べる。
    // どちらも frames.rs に pub で置かれ、この mod から super::* で見えると仮定する。

    // 箱にした枠 (frames の添字、グループ、根の親、根) と、箱にできなかった枠の添字
    type BlockRows = (Vec<(usize, String, Option<u32>, Vec<u32>)>, Vec<usize>);

    // 出力の形の約束も確かめる: level は frames の level の写し、どの枠も blocks と loose のちょうど一方に入る、loose は昇順
    fn blocks_of(graph: &VisibleGraph, frames: &[Frame]) -> BlockRows {
        let result = frame_blocks(graph, frames, &layout_children_of(graph));
        for block in &result.blocks {
            assert_eq!(block.level, frames[block.frame].level);
        }
        let mut seen: Vec<usize> = result
            .blocks
            .iter()
            .map(|block| block.frame)
            .chain(result.loose.iter().copied())
            .collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..frames.len()).collect::<Vec<usize>>());
        let mut sorted = result.loose.clone();
        sorted.sort_unstable();
        assert_eq!(result.loose, sorted);
        (
            result
                .blocks
                .iter()
                .map(|block| {
                    (
                        block.frame,
                        frames[block.frame].group.id.clone(),
                        block.parent,
                        block.roots.clone(),
                    )
                })
                .collect(),
            result.loose.clone(),
        )
    }

    fn row(
        frame: usize,
        group: &str,
        parent: Option<u32>,
        roots: &[u32],
    ) -> (usize, String, Option<u32>, Vec<u32>) {
        (frame, group.to_string(), parent, roots.to_vec())
    }

    // ノードは 1..=count (1 がルート)。tree はツリーの線、chain は relations (chain)、suppress はルートからの線を抑える最上位ノード。
    // 付け替え (配置上の親) は project が決める
    fn graph_of(
        count: u32,
        tree: &[(u32, u32)],
        chain: &[(u32, u32)],
        suppress: &[u32],
    ) -> VisibleGraph {
        project(&LayoutInput {
            name: "frame-blocks".to_string(),
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
            relations: chain
                .iter()
                .map(|&(source, target)| LayoutInputRelation {
                    source,
                    target,
                    kind: RelationKind::Chain,
                    origin: format!("{source} --> {target}"),
                })
                .collect(),
            suppress_root_line: suppress.to_vec(),
            folded: Vec::new(),
        })
        .unwrap()
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

    // compute_frames を通さずに枠を手で組む (compute_frames が作らない形の入力に使う)
    fn frame(id: &str, members: &[u32], level: u32) -> Frame {
        Frame {
            group: group(id),
            members: members.to_vec(),
            level,
        }
    }

    // 1 root の下に葉 2..=count が並ぶ
    fn flat(count: u32) -> VisibleGraph {
        let tree: Vec<(u32, u32)> = (2..=count).map(|target| (1, target)).collect();
        graph_of(count, &tree, &[], &[])
    }

    // 例 4 (design.md の Q4): 1 root / 2 要件 %p / 3 試作 %p %q / 4 画面、5 API、6 計測 (試作の子) / 7 実装 %q
    fn example4(order: &[&str]) -> (VisibleGraph, Vec<Frame>) {
        let graph = graph_of(
            7,
            &[(1, 2), (1, 3), (3, 4), (3, 5), (3, 6), (1, 7)],
            &[],
            &[],
        );
        let frames = frames_of(
            &graph,
            order,
            &[
                (2, &["p"]),
                (3, &["p", "q"]),
                (4, &["p", "q"]),
                (5, &["p", "q"]),
                (6, &["p", "q"]),
                (7, &["q"]),
            ],
        );
        (graph, frames)
    }

    // B-3 の入力: 1 root / 2 設計 %design / 3 画面 %ux (設計の子) / 4 ワイヤー (画面の子) / 5 告知 %ux (設計/画面 --> 告知 で画面の下へ)
    fn partial_overlap_different_parents(order: &[&str]) -> (VisibleGraph, Vec<Frame>) {
        let graph = graph_of(5, &[(1, 2), (2, 3), (3, 4), (1, 5)], &[(3, 5)], &[5]);
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 5]));
        let frames = frames_of(
            &graph,
            order,
            &[
                (2, &["design"]),
                (3, &["design", "ux"]),
                (4, &["design", "ux"]),
                (5, &["ux"]),
            ],
        );
        (graph, frames)
    }

    #[test]
    fn frame_blocks_nested_groups_are_all_blocks_from_the_inside() {
        let (graph, frames) = frames();
        // frames は dev (level 1)、backend、frontend の順。backend と frontend はメンバー 3、level 0 で同じなので frames の順
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![
                row(1, "backend", Some(2), &[6]),
                row(2, "frontend", Some(2), &[3]),
                row(0, "dev", Some(1), &[2]),
            ]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_take_a_frame_with_a_non_member_child_as_a_block() {
        // 試作の frame_blocks_leave_frames_with_non_members_inside_to_the_spacing と同じ入力。
        // screen = {3, 4}、3 の子の 5 はメンバーでない。条件 1 は調べないので screen も箱になる (試作では loose だった)
        let graph = project(&input()).unwrap();
        let frames = frames_of(
            &graph,
            &["screen", "leaves"],
            &[
                (3, &["screen"]),
                (4, &["screen"]),
                (7, &["leaves"]),
                (8, &["leaves"]),
            ],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![
                row(0, "screen", Some(2), &[3]),
                row(1, "leaves", Some(6), &[7, 8]),
            ]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_take_copy_of_loose_example_1_as_a_block() {
        // loose-frames.md の例 1: 1 root / 2 設計 / 3 入力画面の改修 (設計の子) / 4 エラー文言と案内文の見直し / 5 告知。
        // 設計 --> 4 で 4 は設計の下へ、3 --> 告知 で告知は 3 の下へ付け替わる。copy = {3, 4}
        let graph = graph_of(
            5,
            &[(1, 2), (2, 3), (1, 4), (1, 5)],
            &[(2, 4), (3, 5)],
            &[4, 5],
        );
        let children_of = layout_children_of(&graph);
        assert_eq!(children_of.get(&2), Some(&vec![3, 4]));
        assert_eq!(children_of.get(&3), Some(&vec![5]));
        let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "copy", Some(2), &[3, 4])]);
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_take_security_of_loose_example_2_as_a_block() {
        // loose-frames.md の例 2: 1 root / 2 開発 / 3 画面、4 決済APIとWebhookの実装 (開発の子) / 5 脆弱性診断 / 6 本番反映。
        // 開発 --> 脆弱性診断 --> 本番反映 で 5 は開発の下、6 は 5 の下へ付け替わる。security = {4, 5}
        let graph = graph_of(
            6,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6)],
            &[(2, 5), (5, 6)],
            &[5, 6],
        );
        let children_of = layout_children_of(&graph);
        assert_eq!(children_of.get(&2), Some(&vec![3, 4, 5]));
        assert_eq!(children_of.get(&5), Some(&vec![6]));
        let frames = frames_of(
            &graph,
            &["security"],
            &[(4, &["security"]), (5, &["security"])],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "security", Some(2), &[4, 5])]);
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_keep_only_one_of_two_partly_overlapping_runs() {
        // 試作と同じ入力: 1 root の下に葉 2、3、4。p = {2, 3}、q = {3, 4} (親が同じ)。メンバーの数と level が同じなので frames の順で p
        let graph = flat(4);
        let frames = frames_of(
            &graph,
            &["p", "q"],
            &[(2, &["p"]), (3, &["p", "q"]), (4, &["q"])],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "p", Some(1), &[2, 3])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_keep_only_one_of_two_partly_overlapping_frames_with_different_parents() {
        // B-3 の入力: design = {2, 3, 4} (根 2、親はルート)、ux = {3, 4, 5} (根 3、親は 2)。親が違っても条件 3 で比べる
        let (graph, frames) = partial_overlap_different_parents(&["design", "ux"]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "design", Some(1), &[2])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_different_parents_swap_the_block_when_groups_are_swapped() {
        // B-3 の入力で groups の順を入れ替えると、メンバーの数と level が同じなので ux が先になり、ux が箱、design が loose
        let (graph, frames) = partial_overlap_different_parents(&["ux", "design"]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "ux", Some(2), &[3])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_nested_root_ranges_with_partly_overlapping_members_keep_one() {
        // A-1 の入力 1: 1 root / 2 設計 / 3 API %a、4 画面 %a %s (設計の子) / 5 一覧 (画面の子) / 6 告知 %s (設計/画面 --> 告知)。
        // a = {3, 4, 5} (根 3、4)、s = {4, 5, 6} (根 4)。根の範囲は入れ子だが、メンバーは一部だけ重なる
        let graph = graph_of(
            6,
            &[(1, 2), (2, 3), (2, 4), (4, 5), (1, 6)],
            &[(4, 6)],
            &[6],
        );
        assert_eq!(layout_children_of(&graph).get(&4), Some(&vec![5, 6]));
        let frames = frames_of(
            &graph,
            &["a", "s"],
            &[(3, &["a"]), (4, &["a", "s"]), (5, &["a", "s"]), (6, &["s"])],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "a", Some(2), &[3, 4])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_equal_size_and_level_take_the_earlier_frame_of_example_4() {
        // 例 4: p = {2..=6}、q = {3..=7}。どちらもメンバー 5、level 0 なので、frames の順 (groups に書いた順) で先の p が箱 (A-6)
        let (graph, frames) = example4(&["p", "q"]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "p", Some(1), &[2, 3])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_equal_size_and_level_swap_the_block_when_groups_are_swapped() {
        // 例 4 で groups に q を先に書くと、q が箱、p が loose に入れ替わる (A-6)
        let (graph, frames) = example4(&["q", "p"]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "q", Some(1), &[3, 7])]);
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_two_frames_of_one_group_are_both_blocks() {
        // B-4 の入力: 1 root / 2 開発 %sec / 3 実装、4 テスト (開発の子) / 5 診断 %sec / 6 告知 / 7 報告 %sec。
        // 実装 --> 診断、実装 --> 報告、テスト --> 告知。F2 = {2, 3, 4}、F1 = {5, 7} (実装の下で隣り合う)。
        // F1 の根の L0 の親 (実装) は F2 のメンバーだが、メンバーは交わらないので 2 つとも箱。F1 の parent は実装 (A-4/B-4)
        let graph = graph_of(
            7,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
            &[(3, 5), (3, 7), (4, 6)],
            &[5, 6, 7],
        );
        let children_of = layout_children_of(&graph);
        assert_eq!(children_of.get(&3), Some(&vec![5, 7]));
        assert_eq!(children_of.get(&4), Some(&vec![6]));
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
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.members.clone())
                .collect::<Vec<_>>(),
            vec![vec![2, 3, 4], vec![5, 7]]
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![
                row(1, "sec", Some(3), &[5, 7]),
                row(0, "sec", Some(1), &[2])
            ]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_frame_containing_the_root_has_no_parent() {
        // 全部のノードが 1 つのグループ。根はルート (L0 の親がない) だけなので parent は None
        let graph = project(&input()).unwrap();
        let entries: Vec<(u32, &[&str])> = (1..=9).map(|id| (id, &["all"][..])).collect();
        let frames = frames_of(&graph, &["all"], &entries);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "all", None, &[1])]);
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_deep_nesting_does_not_overflow_the_stack() {
        // 同じ 2 つのメンバー (3、4) を持つ枠 2000 個は groups の順で 1 本の鎖に入れ子になり、どれも入れ子なので全部が箱。
        // 並びは level の低い順 (g1999 が level 0 で先、g0 が level 1999 で最後)。wasm の既定と同じ 1 MiB のスタックで回す
        let count = 2000u32;
        let (rows, loose) = std::thread::Builder::new()
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
                let frames =
                    compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
                let result = frame_blocks(&graph, &frames, &layout_children_of(&graph));
                let rows: Vec<(String, u32)> = result
                    .blocks
                    .iter()
                    .map(|block| (frames[block.frame].group.id.clone(), block.level))
                    .collect();
                (rows, result.loose)
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(rows.len(), count as usize);
        assert_eq!(rows.first(), Some(&(format!("g{}", count - 1), 0)));
        assert_eq!(rows.last(), Some(&("g0".to_string(), count - 1)));
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_deep_tree_does_not_overflow_the_stack() {
        // 深さ 20000 の 1 本の木 (1 → 2 → … → 20000)。big = {2..=20000}、small = {19999, 20000}。
        // 深い木でスタックを使わないこと (設計の段 1) を、1 MiB のスタックで確かめる
        let length = 20_000u32;
        let (blocks, loose) = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                let tree: Vec<(u32, u32)> = (1..length).map(|id| (id, id + 1)).collect();
                let graph = graph_of(length, &tree, &[], &[]);
                let groups = vec![group("big"), group("small")];
                let groups_of: IndexMap<u32, Vec<String>> = (1..=length)
                    .map(|id| {
                        let list: Vec<String> = match id {
                            1 => Vec::new(),
                            id if id >= length - 1 => vec!["big".to_string(), "small".to_string()],
                            _ => vec!["big".to_string()],
                        };
                        (id, list)
                    })
                    .collect();
                let frames =
                    compute_frames(&graph, &groups, &groups_of, &layout_children_of(&graph));
                blocks_of(&graph, &frames)
            })
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(
            blocks,
            vec![
                row(1, "small", Some(length - 2), &[length - 1]),
                row(0, "big", Some(1), &[2]),
            ]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_no_frames_give_no_blocks() {
        let graph = project(&input()).unwrap();
        let (blocks, loose) = blocks_of(&graph, &[]);
        assert!(blocks.is_empty());
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_single_member_frame_is_a_block() {
        // compute_frames はメンバー 1 つの枠を作らないので手で組む。3 は子 4、5 (メンバーでない) を持つが、条件 1 は調べない。
        // 根は 3 だけで、条件 2 と 3 を満たすので箱
        let graph = project(&input()).unwrap();
        let frames = vec![frame("one", &[3], 0), frame("leaf", &[9], 0)];
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![row(0, "one", Some(2), &[3]), row(1, "leaf", Some(1), &[9])]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_same_members_are_both_blocks_with_the_lower_level_first() {
        // frames_with_same_members_put_the_earlier_defined_group_outside と同じ入力。a と b はどちらも {3, 4, 5}。
        // compute_frames は a を外 (level 1)、b を内 (level 0) にする。同じ集合は入れ子なので 2 つとも箱で、level の低い b が先
        let graph = project(&input()).unwrap();
        let frames = frames_of(
            &graph,
            &["a", "b"],
            &[(3, &["a", "b"]), (4, &["a", "b"]), (5, &["a", "b"])],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![row(1, "b", Some(2), &[3]), row(0, "a", Some(2), &[3])]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_three_nested_levels_are_all_blocks_from_the_inside() {
        // outer = {2..=8}、mid = {3, 4, 5}、inner = {4, 5} (3 の下で隣り合う 2 つの根)。level は 2、1、0
        let graph = project(&input()).unwrap();
        let frames = frames_of(
            &graph,
            &["outer", "mid", "inner"],
            &[
                (2, &["outer"]),
                (3, &["outer", "mid"]),
                (4, &["outer", "mid", "inner"]),
                (5, &["outer", "mid", "inner"]),
                (6, &["outer"]),
                (7, &["outer"]),
                (8, &["outer"]),
            ],
        );
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![
                row(2, "inner", Some(3), &[4, 5]),
                row(1, "mid", Some(2), &[3]),
                row(0, "outer", Some(1), &[2]),
            ]
        );
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_roots_follow_the_top_to_bottom_order_of_the_parent() {
        // 1 root / 2 A / 3 B / 4 c (B の子)。B --> A で A は B の下へ付け替わり、B の子の並びは [4, 2] (Markdown の子が先)。
        // g = {2, 4} は members の順 [2, 4] だが、roots は parent の子の並びの上から順で [4, 2]
        let graph = graph_of(4, &[(1, 2), (1, 3), (3, 4)], &[(3, 2)], &[2]);
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 2]));
        let frames = frames_of(&graph, &["g"], &[(2, &["g"]), (4, &["g"])]);
        assert_eq!(frames[0].members, vec![2, 4]);
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(0, "g", Some(3), &[4, 2])]);
        assert!(loose.is_empty());
    }

    #[test]
    fn frame_blocks_leave_frames_whose_roots_are_not_adjacent_under_one_parent() {
        // compute_frames が作らない形 (条件 2 を満たさない根) を手で組む。flat の 1 root の下に葉 2..=6
        let graph = flat(6);
        let frames = vec![
            // 同じ親の下だが、間に 3 が挟まる
            frame("gap", &[2, 4], 0),
            // 条件 2 を満たす
            frame("run", &[5, 6], 0),
        ];
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(1, "run", Some(1), &[5, 6])]);
        assert_eq!(loose, vec![0]);

        // nested-groups の木で、根の L0 の親が違う枠
        let nested = project(&input()).unwrap();
        let frames = vec![
            // 4 は 3 の子、7 は 6 の子
            frame("apart", &[4, 7], 0),
            // 根はルート (L0 の親がない) と 4 (親は 3)
            frame("with-root", &[1, 4], 0),
        ];
        let (blocks, loose) = blocks_of(&nested, &frames);
        assert!(blocks.is_empty());
        assert_eq!(loose, vec![0, 1]);
    }

    #[test]
    fn frame_blocks_compare_only_with_frames_already_taken_as_blocks() {
        // flat の 1 root の下に葉 2..=7。並びは a (2)、b (3)、c (4)。
        // b は a と一部だけ重なる ({3}) ので loose。c は b と一部だけ重なる ({4, 5}) が、b は箱でないので比べず、a とは交わらないので箱
        let graph = flat(7);
        let frames = vec![
            frame("c", &[4, 5, 6, 7], 0),
            frame("b", &[3, 4, 5], 0),
            frame("a", &[2, 3], 0),
        ];
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(
            blocks,
            vec![
                row(2, "a", Some(1), &[2, 3]),
                row(0, "c", Some(1), &[4, 5, 6, 7])
            ]
        );
        assert_eq!(loose, vec![1]);
    }

    #[test]
    fn frame_blocks_loose_is_ascending_regardless_of_the_reason() {
        // flat の 1 root の下に葉 2..=6。
        // 0: {2, 3, 4} は 2 の箱 {4, 5} と一部だけ重なり loose (条件 3)。1: {2, 6} は根が隣り合わず loose (条件 2)。2: {4, 5} は箱
        let graph = flat(6);
        let frames = vec![
            frame("wide", &[2, 3, 4], 0),
            frame("gap", &[2, 6], 0),
            frame("pair", &[4, 5], 0),
        ];
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(2, "pair", Some(1), &[4, 5])]);
        assert_eq!(loose, vec![0, 1]);
    }

    #[test]
    fn frame_blocks_cyclic_layout_parents_terminate() {
        // 壊れた入力: ツリーの線が閉路 (2 → 3 → 2) で、layout_parent も閉路になる (project_cyclic_tree_edges_make_a_layout_parent_cycle)。
        // 同じノードは 1 度だけ並べるので終わる。どの枠も blocks か loose のちょうど一方に入る (blocks_of が確かめる)
        let graph = graph_of(3, &[(1, 2), (2, 3), (3, 2)], &[], &[]);
        let frames = vec![frame("cycle", &[2, 3], 0), frame("half", &[3], 0)];
        // 閉路の枠 (根が 1 つもない {2, 3}) と、閉路の中の 1 ノードの枠 (根 3 がルートから配置の木で届かない) は、
        // どちらも箱にしない (G-002。loose)
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert!(blocks.is_empty());
        assert_eq!(loose, vec![0, 1]);
    }

    #[test]
    fn frame_blocks_frame_without_members_terminates() {
        // 壊れた入力: メンバーのない枠 (compute_frames は作らない)。どの枠も blocks か loose のちょうど一方に入る
        let graph = project(&input()).unwrap();
        let frames = vec![frame("empty", &[], 0), frame("pair", &[7, 8], 0)];
        // 根が 1 つもない枠 (メンバーなし) は、parent と roots が決まらないので箱にしない (G-002。loose)
        let (blocks, loose) = blocks_of(&graph, &frames);
        assert_eq!(blocks, vec![row(1, "pair", Some(6), &[7, 8])]);
        assert_eq!(loose, vec![0]);
    }
}

// PORT STATUS: confidence=high todos=2

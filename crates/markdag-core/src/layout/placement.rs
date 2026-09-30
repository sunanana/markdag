// 原文なし。
// 配置の木 (枠の配置の段 2)。flextree に渡す前の木を、箱にした枠を 1 つの頂点 (Slot::Block) にまとめて組む。
// 枠のメンバーの下に付け替えられたメンバーでないノードは、始点を含む箱の出口 (箱の子) へ移す。
// 出口の制約で横位置の制約が閉路になるときだけ、その単位を含むいちばん内側の箱の最上位の末尾 (枠の下の行) へ戻す。
// 包む箱がなければ外側の木の最上位の末尾へ戻す。ルートを含む箱があるときは、その箱の上に外側の仮の根を置いて箱の外に並べる。
// graph は書き換えない。深い木と深い入れ子でスタックを使わないよう、再帰せずに組む。
use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::{IndexMap, IndexSet};

use crate::layout::flextree::{FlexTree, Placed};
use crate::layout::frames::{Frame, FrameBlocks, LABEL_HEIGHT, frame_padding};
use crate::layout::layout::DepthPlan;
use crate::layout::project::VisibleGraph;
use crate::types::LayoutError;

/// 配置の木の頂点。実のノード、箱 (blocks.blocks の添字)、仮の根 (箱の中の木の最上位が複数のとき。添字はその箱)、
/// 外側の仮の根 (ルートを含む箱の外に後戻りを置くときの外側の木の根。外側の木に 1 つだけで大きさ 0、深さの原点)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slot {
    Node(u32),
    Block(usize),
    Joint(usize),
    Origin,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Exit {
    /// 移した先の箱 (blocks.blocks の添字)
    pub block: usize,
    /// 出口の単位の根の L0 の親 (始点)。単位が箱なら、その根に共通の親 (FrameBlock.parent)
    pub from: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacementTree {
    /// 外側の木の根。ルートを含む箱がなければ Node(ルート)、あればその箱。
    /// さらに包む箱のない後戻りがあれば Origin (子の並びは [Block(ルートの箱), 後戻りの単位...])
    pub root: Slot,
    /// 外側の木の子の並び。箱の子は出口の単位
    pub children: IndexMap<Slot, Vec<Slot>>,
    /// 箱の中の木 (blocks.blocks の添字ごとに、根と子の並び。根は Node、Block、Joint のどれか)
    pub inner: Vec<(Slot, IndexMap<Slot, Vec<Slot>>)>,
    /// 配置の木での親。外側の木の根のほかはすべて持つ。
    /// 箱の中の木の根の親はその箱 (inner[i].0 の親は Slot::Block(i))。出口の単位の親も移し先の箱なので、
    /// 親が Block(i) のときは inner[i].0 と同じかで「箱の中の根」か「出口の子」かを見分ける
    pub parent_of: IndexMap<Slot, Slot>,
    /// 箱の出口へ移した単位 (Node か Block)。並びは処理した順
    pub exits: IndexMap<Slot, Exit>,
    /// 出口へ移すと横位置の制約が閉路になるので、後戻りした単位 (処理した順)
    pub fallbacks: Vec<Slot>,
}

// 子の並びの置き場所。context が None なら外側の木、Some(i) なら箱 i の中の木
struct Lists {
    outer: IndexMap<Slot, Vec<Slot>>,
    inner: Vec<IndexMap<Slot, Vec<Slot>>>,
    parent_of: IndexMap<Slot, Slot>,
}

impl Lists {
    fn map(&mut self, context: Option<usize>) -> &mut IndexMap<Slot, Vec<Slot>> {
        match context {
            None => &mut self.outer,
            Some(index) => &mut self.inner[index],
        }
    }

    fn attach(&mut self, context: Option<usize>, parent: Slot, child: Slot) {
        self.map(context).entry(parent).or_default().push(child);
        self.parent_of.insert(child, parent);
    }
}

// 出口の単位の候補。処理の順 (u の graph.nodes の順、同じ u なら children_of(u) の位置の順) に並ぶ
struct Candidate {
    unit: Slot,
    from: u32,
    block: usize,
    // 単位を含むいちばん内側の箱 (u も含む)。移し先の箱が置かれる木で、後戻りの置き場所
    context: Option<usize>,
}

/// 原文なし。
/// 配置の木を作る。L0 の辺 u → v ごとに、u を含み v を含まない箱があれば v の単位をそのいちばん外側の箱の出口へ移す。
/// 単位は、v を根に持ち u を含まないいちばん外側の箱 (Slot::Block)、なければ Slot::Node(v)。
/// 出口は u の順に 1 つずつ受け入れ、predecessors に受け入れた出口の制約 (メンバー → 箱の仮の点 → 単位の根) を足した
/// グラフで、単位の根から移し先の箱のメンバーか仮の点に届くなら閉路として後戻りさせる。
/// children_of は layout_children_of の結果、predecessors は横位置の制約の先行ノード (layout_graph_with_extra_spacing と同じ組み立て)
pub fn placement_tree(
    graph: &VisibleGraph,
    children_of: &IndexMap<u32, Vec<u32>>,
    frames: &[Frame],
    blocks: &FrameBlocks,
    predecessors: &IndexMap<u32, Vec<u32>>,
) -> PlacementTree {
    let count = blocks.blocks.len();
    let members: Vec<IndexSet<u32>> = blocks
        .blocks
        .iter()
        .map(|block| {
            frames
                .get(block.frame)
                .map(|frame| frame.members.iter().copied().collect())
                .unwrap_or_default()
        })
        .collect();
    // ノードを含む箱の並び。blocks は内側から並ぶので、各ノードの並びも内側から外側 (段 1 の条件 3 で包含の鎖になる)
    let mut chain: IndexMap<u32, Vec<usize>> = IndexMap::new();
    for (index, set) in members.iter().enumerate() {
        for &id in set {
            chain.entry(id).or_default().push(index);
        }
    }
    // 反復しない Map (A-008)
    let mut position: HashMap<(u32, usize), usize> = HashMap::new();
    for (&id, list) in &chain {
        for (k, &index) in list.iter().enumerate() {
            position.insert((id, index), k);
        }
    }
    let chain_of = |id: u32| chain.get(&id).map(Vec::as_slice).unwrap_or(&[]);
    let home = |id: u32| chain_of(id).first().copied();
    // v を含み u を含まない箱は v の鎖の内側に連続して並ぶ。そのいちばん外側が、u の子の並びで v を表す箱
    let unit_of = |u: u32, v: u32| {
        let list = chain_of(v);
        let k = list
            .iter()
            .take_while(|&&index| !members[index].contains(&u))
            .count();
        match k {
            0 => Slot::Node(v),
            _ => Slot::Block(list[k - 1]),
        }
    };
    // u を含み v を含まない箱のいちばん外側 (移し先) と、そのすぐ外の箱
    let exit_of = |u: u32, v: u32| {
        let list = chain_of(u);
        let k = list
            .iter()
            .take_while(|&&index| !members[index].contains(&v))
            .count();
        (k > 0).then(|| (list[k - 1], list.get(k).copied()))
    };

    let mut lists = Lists {
        outer: IndexMap::new(),
        inner: vec![IndexMap::new(); count],
        parent_of: IndexMap::new(),
    };
    for node in &graph.nodes {
        lists
            .map(home(node.id))
            .entry(Slot::Node(node.id))
            .or_default();
    }
    // 同じ箱の根が並んでも Block は 1 度だけ置く。反復しない Set (A-008)
    let mut placed: HashSet<Slot> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    for node in &graph.nodes {
        let u = node.id;
        for &v in children_of.get(&u).map(Vec::as_slice).unwrap_or(&[]) {
            let unit = unit_of(u, v);
            if !placed.insert(unit) {
                continue;
            }
            match exit_of(u, v) {
                Some((block, context)) => candidates.push(Candidate {
                    unit,
                    from: u,
                    block,
                    context,
                }),
                None => lists.attach(home(u), Slot::Node(u), unit),
            }
        }
    }

    // 箱の中の木の最上位: 根を 1 つ内側の箱に置き換え、同じ箱が続けば 1 つにまとめる
    let mut inner_roots: Vec<Slot> = Vec::with_capacity(count);
    for (index, block) in blocks.blocks.iter().enumerate() {
        let mut top: Vec<Slot> = Vec::new();
        for &root in &block.roots {
            let slot = match position.get(&(root, index)) {
                Some(&k) if k > 0 => Slot::Block(chain_of(root)[k - 1]),
                _ => Slot::Node(root),
            };
            if placed.insert(slot) {
                top.push(slot);
            }
        }
        let root = match top.as_slice() {
            [single] => *single,
            _ => {
                let joint = Slot::Joint(index);
                lists.map(Some(index)).entry(joint).or_default();
                for &slot in &top {
                    lists.attach(Some(index), joint, slot);
                }
                joint
            }
        };
        lists.parent_of.insert(root, Slot::Block(index));
        inner_roots.push(root);
    }

    let mut root = match chain_of(graph.root_id).last() {
        Some(&index) => Slot::Block(index),
        None => Slot::Node(graph.root_id),
    };

    // 横位置の制約のグラフ。0..n は graph.nodes の添字、n + i は箱 i の仮の点
    let ids: Vec<u32> = graph.nodes.iter().map(|node| node.id).collect();
    // 反復しない Map (A-008)
    let index_of: HashMap<u32, usize> = ids.iter().enumerate().map(|(k, &id)| (id, k)).collect();
    let size = ids.len();
    let mut successors: Vec<Vec<usize>> = vec![Vec::new(); size + count];
    for (target, sources) in predecessors {
        let Some(&target) = index_of.get(target) else {
            continue;
        };
        for source in sources {
            if let Some(&source) = index_of.get(source) {
                successors[source].push(target);
            }
        }
    }
    let mut linked = vec![false; count];
    let mut stamp = vec![0u32; size + count];
    let mut generation = 0u32;

    let mut exits: IndexMap<Slot, Exit> = IndexMap::new();
    let mut fallbacks: Vec<Slot> = Vec::new();
    // 包む箱のない後戻りのうち、根がルートの箱のときに箱の外へ出すもの (処理した順)
    let mut outside: Vec<Slot> = Vec::new();
    for candidate in candidates {
        let unit_roots: Vec<usize> = match candidate.unit {
            Slot::Block(index) => blocks.blocks[index].roots.clone(),
            Slot::Node(id) => vec![id],
            Slot::Joint(_) | Slot::Origin => Vec::new(),
        }
        .into_iter()
        .filter_map(|id| index_of.get(&id).copied())
        .collect();
        let target = candidate.block;
        let point = size + target;

        generation += 1;
        let mut stack: Vec<usize> = Vec::new();
        for &start in &unit_roots {
            if stamp[start] != generation {
                stamp[start] = generation;
                stack.push(start);
            }
        }
        let mut cycle = false;
        while let Some(at) = stack.pop() {
            if at == point || (at < size && members[target].contains(&ids[at])) {
                cycle = true;
                break;
            }
            for &next in &successors[at] {
                if stamp[next] != generation {
                    stamp[next] = generation;
                    stack.push(next);
                }
            }
        }

        if !cycle {
            if !linked[target] {
                for id in &members[target] {
                    if let Some(&member) = index_of.get(id) {
                        successors[member].push(point);
                    }
                }
                linked[target] = true;
            }
            successors[point].extend(unit_roots.iter().copied());
            lists.attach(candidate.context, Slot::Block(target), candidate.unit);
            exits.insert(
                candidate.unit,
                Exit {
                    block: target,
                    from: candidate.from,
                },
            );
            continue;
        }

        fallbacks.push(candidate.unit);
        match candidate.context {
            None if matches!(root, Slot::Block(_)) => outside.push(candidate.unit),
            None => lists.attach(None, root, candidate.unit),
            Some(index) => {
                let joint = Slot::Joint(index);
                let top = inner_roots[index];
                if top != joint {
                    lists.attach(Some(index), joint, top);
                    lists.parent_of.insert(joint, Slot::Block(index));
                    inner_roots[index] = joint;
                }
                lists.attach(Some(index), joint, candidate.unit);
            }
        }
    }

    // ルートを含む箱があると外側の木の根はその箱なので、根の子に置くと後戻りの単位が枠の中 (出口の並び) に入る。
    // 箱の上に外側の仮の根を置き、その子を [ルートの箱, 後戻りの単位...] にして、単位を箱の外の最上位の並びの末尾に置く。
    // 箱の Joint は借りない (どの箱も中の木で Joint を使う入力でも、単位を箱の子に置く経路を残さない)
    if !outside.is_empty() {
        lists.outer.entry(Slot::Origin).or_default();
        lists.attach(None, Slot::Origin, root);
        for unit in outside {
            lists.attach(None, Slot::Origin, unit);
        }
        root = Slot::Origin;
    }

    let Lists {
        outer,
        inner,
        parent_of,
    } = lists;
    PlacementTree {
        root,
        children: outer,
        inner: inner_roots.into_iter().zip(inner).collect(),
        parent_of,
        exits,
        fallbacks,
    }
}

// flextree に渡す 1 つの木 (外側の木か、箱の中の木)。Slot を 0 からの連番の id に置き換える
// (入力の id の範囲に依らず、u32::MAX 付近の id でも仮の id が足りなくならない)
struct LocalTree {
    slots: Vec<Slot>,
    children: IndexMap<u32, Vec<u32>>,
    sizes: IndexMap<u32, [f64; 2]>,
}

// root から子の並びを幅優先にたどって LocalTree を作る。大きさの無い Slot は flextree の既定 ([0, 0]) に任せる。
// 同じ Slot が 2 度現れても子は 1 度だけたどる (閉路は FlexTree::layout が誤りにする)
fn local_tree(
    root: Slot,
    map: &IndexMap<Slot, Vec<Slot>>,
    size_of: &dyn Fn(Slot) -> Option<[f64; 2]>,
) -> Result<LocalTree, LayoutError> {
    // 反復しない Map (A-008)
    let mut ids: HashMap<Slot, u32> = HashMap::new();
    let mut tree = LocalTree {
        slots: Vec::new(),
        children: IndexMap::new(),
        sizes: IndexMap::new(),
    };
    let mut id_of = |slot: Slot, tree: &mut LocalTree| -> Result<(u32, bool), LayoutError> {
        if let Some(&id) = ids.get(&slot) {
            return Ok((id, false));
        }
        let id = u32::try_from(tree.slots.len()).map_err(|_| LayoutError {
            message: "配置の木の頂点が多すぎる".to_string(),
        })?;
        ids.insert(slot, id);
        tree.slots.push(slot);
        if let Some(size) = size_of(slot) {
            tree.sizes.insert(id, size);
        }
        Ok((id, true))
    };
    let (root_id, _) = id_of(root, &mut tree)?;
    let mut queue: VecDeque<(Slot, u32)> = VecDeque::from([(root, root_id)]);
    while let Some((slot, parent)) = queue.pop_front() {
        let mut list: Vec<u32> = Vec::new();
        for &child in map.get(&slot).map(Vec::as_slice).unwrap_or(&[]) {
            let (id, fresh) = id_of(child, &mut tree)?;
            list.push(id);
            if fresh {
                queue.push_back((child, id));
            }
        }
        tree.children.insert(parent, list);
    }
    Ok(tree)
}

// 箱の中の木を回した結果。reserved_top は箱の兄弟の方向の上端 (ラベルの行と padding.top を含む) の、中の座標での位置
struct BoxLayout {
    placed: Vec<(Slot, Placed)>,
    reserved_top: f64,
}

// local_tree に渡す Slot の大きさ。箱はそれより内側の箱を回し終えたものだけが大きさを持ち、仮の根は大きさを持たない
fn slot_size(
    slot: Slot,
    node_size: &IndexMap<u32, [f64; 2]>,
    box_size: &[Option<[f64; 2]>],
) -> Option<[f64; 2]> {
    match slot {
        Slot::Node(id) => node_size.get(&id).copied(),
        Slot::Block(index) => box_size.get(index).copied().flatten(),
        Slot::Joint(_) | Slot::Origin => None,
    }
}

fn tree_error(message: &str) -> LayoutError {
    LayoutError {
        message: format!("枠の配置の木が壊れている: {message}"),
    }
}

/// 原文なし。
/// 枠の配置の段 4 (兄弟の方向の位置)。内側の箱から、その箱の中の木だけで FlexTree::layout を回し、
/// 箱を 1 つのノード (兄弟の方向は中身の外接 + padding.top + LABEL_HEIGHT + padding.bottom、深さの方向は end − start) として
/// 外側の木に置く。最後に外側の木を回し、外側から順に箱の中の配置を平行移動して戻す (明示のスタック)。
/// 中身の外接は、実のノードと内側の箱 (ラベルの行を含む大きさ) の兄弟の方向の範囲。仮の根 (Joint と Origin) は大きさ 0 で外接に入れない。
/// spacing は flextree が問う輪郭の組を Slot のまま受ける (上の Slot、下の Slot)。箱は内側から順に回すので、内側の箱の問い合わせが先に来る。
/// 返すのは実のノードだけで、並びは外側の木の幅優先の順の中で、箱をその位置に中の配置 (中の木の幅優先の順) で置き換えたもの。
/// L0 の幅優先の順への並べ直しは呼び出し側 (layout_graph_framed) がする。箱が 1 つもなければ FlexTree::layout と同じ値と並び。
/// 箱の大きさに要る値は blocks と depths にあるので、枠 (Frame) は受けない
pub fn layout_placement(
    placement: &PlacementTree,
    node_size: &IndexMap<u32, [f64; 2]>,
    depths: &DepthPlan,
    blocks: &FrameBlocks,
    spacing: &mut dyn FnMut(Slot, Slot) -> Result<f64, LayoutError>,
) -> Result<Vec<Placed>, LayoutError> {
    let count = blocks.blocks.len();
    if placement.inner.len() != count || depths.blocks.len() != count {
        return Err(tree_error("箱の数が合わない"));
    }

    // 箱を回す順: 中の木に現れる箱を先に (入れ子の内側から)。入れ子は深くなりうるので明示のスタックで後順にたどる
    let inner_blocks = |index: usize| -> Vec<usize> {
        let (root, map) = &placement.inner[index];
        std::iter::once(root)
            .chain(map.values().flatten())
            .filter_map(|slot| match slot {
                Slot::Block(inner) => Some(*inner),
                _ => None,
            })
            .collect()
    };
    let mut order: Vec<usize> = Vec::with_capacity(count);
    // 0: 未着手、1: たどっている途中、2: 済み
    let mut state = vec![0u8; count];
    for start in 0..count {
        if state[start] != 0 {
            continue;
        }
        let mut stack: Vec<(usize, bool)> = vec![(start, false)];
        while let Some((index, done)) = stack.pop() {
            if done {
                state[index] = 2;
                order.push(index);
                continue;
            }
            if state[index] != 0 {
                continue;
            }
            state[index] = 1;
            stack.push((index, true));
            for inner in inner_blocks(index).into_iter().rev() {
                match state.get(inner) {
                    Some(0) => stack.push((inner, false)),
                    Some(1) => return Err(tree_error("箱が自分を含む")),
                    Some(_) => {}
                    None => return Err(tree_error("箱の添字が範囲の外")),
                }
            }
        }
    }

    let mut box_size: Vec<Option<[f64; 2]>> = vec![None; count];
    let mut laid: Vec<Option<BoxLayout>> = (0..count).map(|_| None).collect();
    for index in order {
        let (root, map) = &placement.inner[index];
        let tree = local_tree(*root, map, &|slot| slot_size(slot, node_size, &box_size))?;
        let placed = FlexTree::layout(0, &tree.children, &tree.sizes, &mut |upper, lower| {
            spacing(tree.slots[upper as usize], tree.slots[lower as usize])
        })?;
        let mut top = f64::INFINITY;
        let mut bottom = f64::NEG_INFINITY;
        let mut entries: Vec<(Slot, Placed)> = Vec::with_capacity(placed.len());
        for flex_node in placed {
            let slot = tree.slots[flex_node.id as usize];
            if !matches!(slot, Slot::Joint(_) | Slot::Origin) {
                top = top.min(flex_node.x - flex_node.x_size / 2.0);
                bottom = bottom.max(flex_node.x + flex_node.x_size / 2.0);
            }
            entries.push((slot, flex_node));
        }
        if top > bottom {
            top = 0.0;
            bottom = 0.0;
        }
        let padding = frame_padding(blocks.blocks[index].level);
        let reserved_top = top - padding.top - LABEL_HEIGHT;
        let reserved_bottom = bottom + padding.bottom;
        let depth = &depths.blocks[index];
        box_size[index] = Some([reserved_bottom - reserved_top, depth.end - depth.start]);
        laid[index] = Some(BoxLayout {
            placed: entries,
            reserved_top,
        });
    }

    let tree = local_tree(placement.root, &placement.children, &|slot| {
        slot_size(slot, node_size, &box_size)
    })?;
    let outer = FlexTree::layout(0, &tree.children, &tree.sizes, &mut |upper, lower| {
        spacing(tree.slots[upper as usize], tree.slots[lower as usize])
    })?;

    // 外側の木の座標はそのまま使う (0 を足すと -0 の符号が変わり、枠のない配置が FlexTree::layout と同じにならない)。
    // 箱の中の配置は、箱の兄弟の方向の上端と深さの方向の上端へずらす
    let mut result: Vec<Placed> = Vec::new();
    type Level = (std::vec::IntoIter<(Slot, Placed)>, Option<(f64, f64)>);
    let mut stack: Vec<Level> = vec![(
        outer
            .into_iter()
            .map(|flex_node| (tree.slots[flex_node.id as usize], flex_node))
            .collect::<Vec<_>>()
            .into_iter(),
        None,
    )];
    while let Some((entries, shift)) = stack.last_mut() {
        let shift = *shift;
        let Some((slot, flex_node)) = entries.next() else {
            stack.pop();
            continue;
        };
        let (x, y) = match shift {
            None => (flex_node.x, flex_node.y),
            Some((across, along)) => (flex_node.x + across, flex_node.y + along),
        };
        match slot {
            Slot::Node(id) => result.push(Placed {
                id,
                x,
                y,
                x_size: flex_node.x_size,
                y_size: flex_node.y_size,
            }),
            Slot::Block(index) => {
                let inner = laid
                    .get_mut(index)
                    .and_then(Option::take)
                    .ok_or_else(|| tree_error("箱が 2 度置かれた"))?;
                let across = x - flex_node.x_size / 2.0 - inner.reserved_top;
                stack.push((inner.placed.into_iter(), Some((across, y))));
            }
            Slot::Joint(_) | Slot::Origin => {}
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    // 期待値は設計の段 2 (付け替えの規則、閉路の判定と後戻り、箱の中の木) から導く。
    // 仮定したシグネチャ: 設計の段 2 の「入力と出力の形」のとおり
    //     pub enum Slot { Node(u32), Block(usize), Joint(usize) }
    //     pub struct Exit { pub block: usize, pub from: u32 }
    //     pub struct PlacementTree { root, children, inner, parent_of, exits, fallbacks }
    //     pub fn placement_tree(graph: &VisibleGraph, children_of: &IndexMap<u32, Vec<u32>>, frames: &[Frame], blocks: &FrameBlocks, predecessors: &IndexMap<u32, Vec<u32>>) -> PlacementTree
    // 設計に明記のない仮定:
    //     - Slot は IndexMap の鍵なので Hash と Eq を持つ。Debug、Clone、PartialEq には頼らず、名前 (N3、B0、J1) にして比べる
    //     - Slot::Block(i)、Slot::Joint(i)、Exit.block の i は blocks.blocks の添字。inner[i] は blocks.blocks[i] の箱の中の木
    //     - 箱の子 (出口の単位) の並びは、その箱が置かれた木の子の並びにある (外側の木なら children、箱 c の中なら inner[c])
    // predecessors は配置の入口と同じ layout_predecessors (配置上の親と、配置から外されていない tree 以外の線の始点) で作る。
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant};

    use indexmap::IndexMap;

    use super::*;
    use crate::layout::frames::{Frame, FrameBlocks, compute_frames, frame_blocks};
    use crate::layout::layout::{MARKMAP_DEFAULTS, layout_children_of, layout_predecessors};
    use crate::layout::project::{VisibleGraph, project};
    use crate::types::{
        GroupDef, LayoutInput, LayoutInputEdge, LayoutInputNode, LayoutInputRelation, RelationKind,
    };

    // nested-groups (frames.rs の tests と同じ): 1 root / 2 仕様策定 / 3 画面開発 / 4, 5 その子 / 6 API開発 / 7, 8 その子 / 9 効果測定
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

    // ノードは 1..=count (1 がルート)。tree はツリーの線、relations は (種類, 始点, 終点)、suppress はルートからの線を抑える最上位ノード。
    // 付け替え (配置上の親) は project が決める
    fn graph_with(
        count: u32,
        tree: &[(u32, u32)],
        relations: &[(RelationKind, u32, u32)],
        suppress: &[u32],
    ) -> VisibleGraph {
        project(&LayoutInput {
            name: "placement-tree".to_string(),
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

    fn name(slot: &Slot) -> String {
        match slot {
            Slot::Node(id) => format!("N{id}"),
            Slot::Block(index) => format!("B{index}"),
            Slot::Joint(index) => format!("J{index}"),
            // 外側の仮の根の種類 (G-005 の C-01 で足す) は Debug の名前で呼ぶ。足す前は届かない腕
            #[allow(unreachable_patterns)]
            other => format!("{other:?}"),
        }
    }

    fn names(list: &[Slot]) -> Vec<String> {
        list.iter().map(name).collect()
    }

    fn n(id: u32) -> String {
        format!("N{id}")
    }

    fn b(index: usize) -> String {
        format!("B{index}")
    }

    fn j(index: usize) -> String {
        format!("J{index}")
    }

    fn sorted<T: Ord>(mut list: Vec<T>) -> Vec<T> {
        list.sort();
        list
    }

    fn maps(tree: &PlacementTree) -> Vec<&IndexMap<Slot, Vec<Slot>>> {
        std::iter::once(&tree.children)
            .chain(tree.inner.iter().map(|(_, map)| map))
            .collect()
    }

    // 配置の木の形の約束 (設計の「配置の木は木である」と出力の欄の意味) を、どのテストでも確かめる。
    // 深い入力でも回るよう再帰しない
    fn check_tree(graph: &VisibleGraph, tree: &PlacementTree, blocks: &FrameBlocks) {
        assert_eq!(
            tree.inner.len(),
            blocks.blocks.len(),
            "inner は箱ごとに 1 つ"
        );
        let ids: HashSet<u32> = graph.nodes.iter().map(|node| node.id).collect();
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut bump = |slot: &Slot| {
            match slot {
                Slot::Node(id) => assert!(ids.contains(id), "見えていないノード {id}"),
                Slot::Block(index) | Slot::Joint(index) => {
                    assert!(*index < blocks.blocks.len(), "箱の添字 {index} が範囲の外")
                }
                // 外側の仮の根 (G-005 の C-01) は添字を持たない
                #[allow(unreachable_patterns)]
                _ => {}
            }
            *seen.entry(name(slot)).or_default() += 1;
        };
        bump(&tree.root);
        for (root, map) in &tree.inner {
            bump(root);
            for list in map.values() {
                list.iter().for_each(&mut bump);
            }
        }
        for list in tree.children.values() {
            list.iter().for_each(&mut bump);
        }
        for (slot, count) in &seen {
            assert_eq!(*count, 1, "{slot} は配置の木にちょうど 1 度だけ現れる");
        }
        for node in &graph.nodes {
            assert!(
                seen.contains_key(&n(node.id)),
                "N{} が配置の木にない",
                node.id
            );
        }
        for index in 0..blocks.blocks.len() {
            assert!(seen.contains_key(&b(index)), "B{index} が配置の木にない");
        }

        let all = maps(tree);
        let mut visited: HashSet<String> = HashSet::new();
        let mut stack: Vec<&Slot> = vec![&tree.root];
        while let Some(slot) = stack.pop() {
            assert!(visited.insert(name(slot)), "{} に 2 度届く", name(slot));
            for map in &all {
                if let Some(list) = map.get(slot) {
                    stack.extend(list.iter());
                }
            }
            if let Slot::Block(index) = slot {
                stack.push(&tree.inner[*index].0);
            }
        }
        for node in &graph.nodes {
            assert!(
                visited.contains(&n(node.id)),
                "N{} に根から届かない",
                node.id
            );
        }

        for map in &all {
            for (parent, list) in map.iter() {
                for child in list {
                    assert_eq!(
                        tree.parent_of.get(child).map(name),
                        Some(name(parent)),
                        "parent_of は子の並びと合う"
                    );
                }
            }
        }

        for (unit, exit) in &tree.exits {
            assert!(
                matches!(unit, Slot::Node(_) | Slot::Block(_)),
                "出口の単位は Node か Block"
            );
            let target = Slot::Block(exit.block);
            let children: Vec<String> = all
                .iter()
                .filter_map(|map| map.get(&target))
                .flat_map(|list| names(list))
                .collect();
            assert!(children.contains(&name(unit)), "出口の単位は移し先の箱の子");
        }
        for unit in &tree.fallbacks {
            assert!(
                !tree.exits.contains_key(unit),
                "後戻りした単位は出口に入らない"
            );
        }
        // 逆向き: 箱の子の並びに置かれるのは、その箱を移し先とする出口の単位だけ (箱の中の木の根は inner[i].0 で、子の並びには出ない)。
        // 出口でも中の木の根でもない単位が箱の子にあると、枠に入る (I1。レビュー A-1)
        for map in &all {
            for (parent, list) in map.iter() {
                let Slot::Block(index) = parent else {
                    continue;
                };
                for child in list {
                    assert!(
                        *child == tree.inner[*index].0
                            || tree.exits.get(child).map(|exit| exit.block) == Some(*index),
                        "{} は B{index} の子だが、B{index} の中の木の根でも B{index} への出口でもない",
                        name(child)
                    );
                }
            }
        }
    }

    struct Placed {
        tree: PlacementTree,
        blocks: FrameBlocks,
        frames: Vec<Frame>,
    }

    impl Placed {
        fn block(&self, group: &str) -> usize {
            let found: Vec<usize> = (0..self.blocks.blocks.len())
                .filter(|&index| self.frames[self.blocks.blocks[index].frame].group.id == group)
                .collect();
            assert_eq!(found.len(), 1, "{group} の箱はちょうど 1 つ");
            found[0]
        }

        fn block_with(&self, members: &[u32]) -> usize {
            (0..self.blocks.blocks.len())
                .find(|&index| self.frames[self.blocks.blocks[index].frame].members == members)
                .unwrap()
        }

        fn outer(&self, slot: Slot) -> Vec<String> {
            self.tree
                .children
                .get(&slot)
                .map(|list| names(list))
                .unwrap_or_default()
        }

        fn inner_root(&self, block: usize) -> String {
            name(&self.tree.inner[block].0)
        }

        fn inner(&self, block: usize, slot: Slot) -> Vec<String> {
            self.tree.inner[block]
                .1
                .get(&slot)
                .map(|list| names(list))
                .unwrap_or_default()
        }

        // 箱の中の木の最上位の並び (根が Joint ならその子、そうでなければ根 1 つ)
        fn inner_top(&self, block: usize) -> Vec<String> {
            let (root, map) = &self.tree.inner[block];
            match root {
                Slot::Joint(_) => map.get(root).map(|list| names(list)).unwrap_or_default(),
                _ => vec![name(root)],
            }
        }

        fn parent(&self, slot: Slot) -> Option<String> {
            self.tree.parent_of.get(&slot).map(name)
        }

        // TODO(spec): exits の IndexMap の並びは設計に書かれていないので、名前の順に並べて比べる
        fn exits(&self) -> Vec<(String, usize, u32)> {
            sorted(
                self.tree
                    .exits
                    .iter()
                    .map(|(unit, exit)| (name(unit), exit.block, exit.from))
                    .collect(),
            )
        }

        fn fallbacks(&self) -> Vec<String> {
            names(&self.tree.fallbacks)
        }
    }

    fn place_timed(graph: &VisibleGraph, frames: Vec<Frame>) -> (Placed, Duration) {
        let children_of = layout_children_of(graph);
        let blocks = frame_blocks(graph, &frames, &children_of);
        let predecessors = layout_predecessors(graph, &MARKMAP_DEFAULTS);
        let start = Instant::now();
        let tree = placement_tree(graph, &children_of, &frames, &blocks, &predecessors);
        let elapsed = start.elapsed();
        check_tree(graph, &tree, &blocks);
        (
            Placed {
                tree,
                blocks,
                frames,
            },
            elapsed,
        )
    }

    fn place(graph: &VisibleGraph, frames: Vec<Frame>) -> Placed {
        place_timed(graph, frames).0
    }

    // loose-frames.md の例 1: 1 root / 2 設計 / 3 入力画面の改修 (設計の子) / 4 エラー文言と案内文の見直し / 5 告知。
    // 設計 --> 4 で 4 は設計の下へ、3 --> 告知 で告知は 3 の下へ付け替わる
    fn example1_graph() -> VisibleGraph {
        let graph = graph_of(
            5,
            &[(1, 2), (2, 3), (1, 4), (1, 5)],
            &[(2, 4), (3, 5)],
            &[4, 5],
        );
        let children_of = layout_children_of(&graph);
        assert_eq!(children_of.get(&2), Some(&vec![3, 4]));
        assert_eq!(children_of.get(&3), Some(&vec![5]));
        graph
    }

    #[test]
    fn placement_tree_without_frames_copies_layout_children_of() {
        for graph in [nested(), example1_graph()] {
            let children_of = layout_children_of(&graph);
            let placed = place(&graph, Vec::new());
            let tree = &placed.tree;
            let expected: IndexMap<String, Vec<String>> = children_of
                .iter()
                .map(|(parent, list)| (n(*parent), list.iter().map(|&id| n(id)).collect()))
                .collect();
            let actual: IndexMap<String, Vec<String>> = tree
                .children
                .iter()
                .map(|(parent, list)| (name(parent), names(list)))
                .collect();
            assert_eq!(actual, expected);
            assert_eq!(name(&tree.root), n(graph.root_id));
            assert!(tree.inner.is_empty());
            assert!(tree.exits.is_empty());
            assert!(tree.fallbacks.is_empty());
            let parents: HashMap<String, String> = tree
                .parent_of
                .iter()
                .map(|(child, parent)| (name(child), name(parent)))
                .collect();
            let expected_parents: HashMap<String, String> = graph
                .layout_parent
                .iter()
                .map(|(&child, &parent)| (n(child), n(parent)))
                .collect();
            assert_eq!(parents, expected_parents);
        }
    }

    #[test]
    fn placement_tree_moves_the_announcement_of_loose_example_1_to_the_exit() {
        // copy = {3, 4} (根 3、4 は設計の下で隣り合う)。告知 5 は 3 の下にいてメンバーでないので copy の箱の出口の子
        let graph = example1_graph();
        let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
        let placed = place(&graph, frames);
        let copy = placed.block("copy");
        assert_eq!(placed.outer(Slot::Node(1)), vec![n(2)]);
        assert_eq!(placed.outer(Slot::Node(2)), vec![b(copy)]);
        assert_eq!(placed.outer(Slot::Block(copy)), vec![n(5)]);
        assert_eq!(placed.exits(), vec![(n(5), copy, 3)]);
        assert!(placed.fallbacks().is_empty());
        assert!(placed.inner_root(copy).starts_with('J'));
        assert_eq!(placed.inner_top(copy), vec![n(3), n(4)]);
        assert!(placed.inner(copy, Slot::Node(3)).is_empty());
        assert_eq!(placed.parent(Slot::Block(copy)), Some(n(2)));
        assert_eq!(placed.parent(Slot::Node(5)), Some(b(copy)));
    }

    #[test]
    fn placement_tree_moves_the_release_of_loose_example_2_to_the_exit() {
        // loose-frames.md の例 2: 1 root / 2 開発 / 3 画面、4 決済APIとWebhookの実装 (開発の子) / 5 脆弱性診断 / 6 本番反映。
        // 開発 --> 脆弱性診断 --> 本番反映 で 5 は開発の下、6 は 5 の下へ。security = {4, 5}。本番反映は security の箱の出口の子
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
        let placed = place(&graph, frames);
        let security = placed.block("security");
        assert_eq!(placed.outer(Slot::Node(2)), vec![n(3), b(security)]);
        assert_eq!(placed.outer(Slot::Block(security)), vec![n(6)]);
        assert_eq!(placed.exits(), vec![(n(6), security, 5)]);
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.inner_top(security), vec![n(4), n(5)]);
        assert!(placed.inner(security, Slot::Node(5)).is_empty());
    }

    // 試作の pipeline.rs の notation_like: 1 root / 2 要件 / 3 設計 %d (4、5 が子) / 6 実装 %b (7 フロント (8、9、10)、11 バック (12、13)) /
    // 14 検証 (15、16 が子)。2 -fork-> 4、5、3 -chain-> 6 -chain-> 14、10 -join-> 14、13 -join-> 14、12 -depends-> 9
    fn notation_like() -> (VisibleGraph, Vec<Frame>) {
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
        assert_eq!(graph.layout_parent.get(&4), Some(&3));
        assert_eq!(graph.layout_parent.get(&5), Some(&3));
        assert_no_excluded_relations(&graph);
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
        let frames = frames_of(&graph, &["d", "b"], &entries);
        assert_eq!(
            members_of(&frames),
            vec![
                ("d".to_string(), vec![3, 4, 5]),
                ("b".to_string(), (6..=13).collect())
            ]
        );
        (graph, frames)
    }

    #[test]
    fn placement_tree_notation_moves_the_build_block_and_the_verification_to_exits() {
        // 実装 6 は build (b) の箱の根で、L0 の親の設計 3 は design (d) のメンバー。単位は Block(b) で、d の箱の出口 (A-4)。
        // 検証 14 は L0 の親の 10 が b のメンバーなので、b の箱の出口の子
        let (graph, frames) = notation_like();
        let placed = place(&graph, frames);
        let design = placed.block("d");
        let build = placed.block("b");
        assert_eq!(placed.outer(Slot::Node(1)), vec![n(2), b(design)]);
        assert_eq!(placed.outer(Slot::Block(design)), vec![b(build)]);
        assert_eq!(placed.outer(Slot::Block(build)), vec![n(14)]);
        assert_eq!(placed.outer(Slot::Node(14)), vec![n(15), n(16)]);
        assert_eq!(
            placed.exits(),
            sorted(vec![(b(build), design, 3), (n(14), build, 10)])
        );
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.inner_top(design), vec![n(3)]);
        assert_eq!(placed.inner(design, Slot::Node(3)), vec![n(4), n(5)]);
        assert_eq!(placed.inner_top(build), vec![n(6)]);
        assert_eq!(placed.inner(build, Slot::Node(6)), vec![n(7), n(11)]);
        assert_eq!(placed.inner(build, Slot::Node(7)), vec![n(8), n(9), n(10)]);
        assert_eq!(placed.inner(build, Slot::Node(11)), vec![n(12), n(13)]);
        assert!(placed.inner(build, Slot::Node(10)).is_empty());
        assert_eq!(placed.parent(Slot::Block(build)), Some(b(design)));
        assert_eq!(placed.parent(Slot::Node(14)), Some(b(build)));
    }

    // 1 root / 2 開発 / 3 設計 (開発の子) / 4 画面、5 API (設計の子) / 6 告知 (設計 --> 告知 で設計の下へ)
    fn nested_exit_graph() -> VisibleGraph {
        let graph = graph_of(
            6,
            &[(1, 2), (2, 3), (3, 4), (3, 5), (1, 6)],
            &[(3, 6)],
            &[6],
        );
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 5, 6]));
        graph
    }

    #[test]
    fn placement_tree_moves_an_exit_to_the_inner_frame_when_it_is_a_member_of_the_outer() {
        // u = 設計 3 は design (内) と dev (外) のメンバー。告知 6 は dev のメンバーで design のメンバーでない。
        // 移し先は design。告知は dev の箱の中に残る (Block(design) の子として dev の中の木にいる)
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
        assert_eq!(
            members_of(&frames),
            vec![
                ("dev".to_string(), vec![2, 3, 4, 5, 6]),
                ("design".to_string(), vec![3, 4, 5])
            ]
        );
        let placed = place(&graph, frames);
        let design = placed.block("design");
        let dev = placed.block("dev");
        assert_eq!(placed.exits(), vec![(n(6), design, 3)]);
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(dev)]);
        assert!(placed.outer(Slot::Block(dev)).is_empty());
        assert!(placed.outer(Slot::Block(design)).is_empty());
        assert_eq!(placed.inner_top(dev), vec![n(2)]);
        assert_eq!(placed.inner(dev, Slot::Node(2)), vec![b(design)]);
        assert_eq!(placed.inner(dev, Slot::Block(design)), vec![n(6)]);
        assert_eq!(placed.inner(design, Slot::Node(3)), vec![n(4), n(5)]);
    }

    #[test]
    fn placement_tree_moves_an_exit_to_the_outermost_frame_when_it_is_a_member_of_neither() {
        // 告知 6 はどちらのメンバーでもない。u を含む箱 (design、dev) のどちらも告知を含まないので、いちばん外側の dev が移し先
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
        assert_eq!(
            members_of(&frames),
            vec![
                ("dev".to_string(), vec![2, 3, 4, 5]),
                ("design".to_string(), vec![3, 4, 5])
            ]
        );
        let placed = place(&graph, frames);
        let design = placed.block("design");
        let dev = placed.block("dev");
        assert_eq!(placed.exits(), vec![(n(6), dev, 3)]);
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(dev)]);
        assert_eq!(placed.outer(Slot::Block(dev)), vec![n(6)]);
        assert_eq!(placed.inner(dev, Slot::Node(2)), vec![b(design)]);
        assert!(placed.inner(dev, Slot::Block(design)).is_empty());
    }

    #[test]
    fn placement_tree_moves_a_frame_rooted_at_exits_as_one_unit() {
        // A-4 の入力: 1 root / 2 設計 %design / 3 画面、4 API / 5 告知A %notice / 6 周知 / 7 告知B %notice。
        // 画面 --> 告知A、API --> 周知、画面 --> 告知B。画面の子は [5, 7]、API の子は [6]。
        // notice の根 5、7 は 1 つの Block(notice) として design の出口の単位になり、並びは u の順 (画面、API) で [Block(notice), 周知]
        let graph = graph_of(
            7,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
            &[(3, 5), (4, 6), (3, 7)],
            &[5, 6, 7],
        );
        let children_of = layout_children_of(&graph);
        assert_eq!(children_of.get(&3), Some(&vec![5, 7]));
        assert_eq!(children_of.get(&4), Some(&vec![6]));
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
        let placed = place(&graph, frames);
        let design = placed.block("design");
        let notice = placed.block("notice");
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(design)]);
        assert_eq!(placed.outer(Slot::Block(design)), vec![b(notice), n(6)]);
        assert_eq!(
            placed.exits(),
            sorted(vec![(b(notice), design, 3), (n(6), design, 4)])
        );
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.parent(Slot::Block(notice)), Some(b(design)));
        assert_eq!(placed.inner_top(notice), vec![n(5), n(7)]);
        assert_eq!(placed.inner(design, Slot::Node(2)), vec![n(3), n(4)]);
        assert!(placed.inner(design, Slot::Node(3)).is_empty());
    }

    #[test]
    fn placement_tree_moves_the_other_frame_of_the_same_group_as_one_unit() {
        // B-4 の入力: 1 root / 2 開発 %sec / 3 実装、4 テスト / 5 診断 %sec / 6 告知 / 7 報告 %sec。
        // 実装 --> 診断、実装 --> 報告、テスト --> 告知。F2 = {2, 3, 4}、F1 = {5, 7}。F2 の箱の子は [Block(F1), 告知] (A-4/B-4)
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
            members_of(&frames),
            vec![
                ("sec".to_string(), vec![2, 3, 4]),
                ("sec".to_string(), vec![5, 7])
            ]
        );
        let placed = place(&graph, frames);
        let f2 = placed.block_with(&[2, 3, 4]);
        let f1 = placed.block_with(&[5, 7]);
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(f2)]);
        assert_eq!(placed.outer(Slot::Block(f2)), vec![b(f1), n(6)]);
        assert_eq!(placed.exits(), sorted(vec![(b(f1), f2, 3), (n(6), f2, 4)]));
        assert!(placed.fallbacks().is_empty());
        assert_eq!(placed.parent(Slot::Block(f1)), Some(b(f2)));
        assert_eq!(placed.inner_top(f1), vec![n(5), n(7)]);
    }

    #[test]
    fn placement_tree_orders_exit_units_by_their_sources_in_document_order() {
        // 1 root / 2 設計 %design / 3 画面、4 API / 5 周知 (API --> 周知) / 6 告知 (画面 --> 告知)。
        // 文書順は周知が先だが、並びは u (画面 3、API 4) の graph.nodes の順なので [告知, 周知]
        let graph = graph_of(
            6,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6)],
            &[(4, 5), (3, 6)],
            &[5, 6],
        );
        assert_eq!(graph.layout_parent.get(&5), Some(&4));
        assert_eq!(graph.layout_parent.get(&6), Some(&3));
        let frames = frames_of(
            &graph,
            &["design"],
            &[(2, &["design"]), (3, &["design"]), (4, &["design"])],
        );
        let placed = place(&graph, frames);
        let design = placed.block("design");
        assert_eq!(placed.outer(Slot::Block(design)), vec![n(6), n(5)]);
        assert_eq!(
            placed.exits(),
            sorted(vec![(n(6), design, 3), (n(5), design, 4)])
        );
    }

    #[test]
    fn placement_tree_falls_back_to_the_root_when_the_exit_closes_a_cycle() {
        // design.md の Q3 の例 3: 1 root / 2 設計 %design / 3 画面、4 API / 5 告知。画面 --> 告知 --> API。
        // 告知は画面の下に付け替わる。出口へ移すと design のメンバー → 告知 → API (design のメンバー) の閉路になるので後戻り。
        // 告知を含む箱はないので、外側の木の根の子の並びの末尾
        let graph = graph_of(
            5,
            &[(1, 2), (2, 3), (2, 4), (1, 5)],
            &[(3, 5), (5, 4)],
            &[5],
        );
        assert_eq!(graph.layout_parent.get(&5), Some(&3));
        assert_eq!(graph.layout_parent.get(&4), Some(&2));
        assert_no_excluded_relations(&graph);
        let frames = frames_of(
            &graph,
            &["design"],
            &[(2, &["design"]), (3, &["design"]), (4, &["design"])],
        );
        let placed = place(&graph, frames);
        let design = placed.block("design");
        assert_eq!(placed.fallbacks(), vec![n(5)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(design), n(5)]);
        assert!(placed.outer(Slot::Block(design)).is_empty());
        assert_eq!(placed.parent(Slot::Node(5)), Some(n(1)));
        assert_eq!(placed.inner(design, Slot::Node(2)), vec![n(3), n(4)]);
        assert!(placed.inner(design, Slot::Node(3)).is_empty());
    }

    #[test]
    fn placement_tree_keeps_fallbacks_in_the_order_they_were_processed() {
        // 例 3 の形を 2 つ並べた: 1 root / 2 設計1 %d1 (3 画面1、4 API1) / 5 設計2 %d2 (6 画面2、7 API2) / 8 告知 / 9 周知。
        // 画面2 --> 告知 --> API2、画面1 --> 周知 --> API1。どちらも後戻り。処理は u の順 (画面1 3、画面2 6) なので [周知, 告知]
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
            &[(6, 8), (8, 7), (3, 9), (9, 4)],
            &[8, 9],
        );
        assert_eq!(graph.layout_parent.get(&8), Some(&6));
        assert_eq!(graph.layout_parent.get(&9), Some(&3));
        assert_no_excluded_relations(&graph);
        let frames = frames_of(
            &graph,
            &["d1", "d2"],
            &[
                (2, &["d1"]),
                (3, &["d1"]),
                (4, &["d1"]),
                (5, &["d2"]),
                (6, &["d2"]),
                (7, &["d2"]),
            ],
        );
        let placed = place(&graph, frames);
        let d1 = placed.block("d1");
        let d2 = placed.block("d2");
        assert_eq!(placed.fallbacks(), vec![n(9), n(8)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(d1), b(d2), n(9), n(8)]);
    }

    #[test]
    fn placement_tree_falls_back_the_later_of_two_exits_that_close_a_cycle_together() {
        // B-1 の入力: 1 root / 2 設計 %design (3 画面、4 API) / 5 告知 / 6 運用 %ops (7 監視、8 手順) / 9 連絡。
        // 画面 --> 告知 --> 手順、監視 --> 連絡 --> API。1 つずつなら閉路はないが、両方を出口にすると
        // API → 告知 (出口) → 手順 → 連絡 (出口) → API の閉路。先に処理する告知 (u = 画面 3) は出口、後の連絡 (u = 監視 7) は後戻り
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
        assert_eq!(graph.layout_parent.get(&5), Some(&3));
        assert_eq!(graph.layout_parent.get(&9), Some(&7));
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
        let placed = place(&graph, frames);
        let design = placed.block("design");
        let ops = placed.block("ops");
        assert_eq!(placed.exits(), vec![(n(5), design, 3)]);
        assert_eq!(placed.fallbacks(), vec![n(9)]);
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(design), b(ops), n(9)]);
        assert_eq!(placed.outer(Slot::Block(design)), vec![n(5)]);
        assert!(placed.outer(Slot::Block(ops)).is_empty());
    }

    #[test]
    fn placement_tree_falls_back_the_later_exit_of_review_a_2() {
        // A-2 の入力: 1 root / 2 設計 %design (3 画面、4 API) / 5 開発 %dev (6 フロント、7 バック) / 8 告知 / 9 周知。
        // 画面 --> 告知 --> バック、フロント --> 周知 --> API。告知は出口、周知は後戻り (A-2)
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
        assert_eq!(graph.layout_parent.get(&8), Some(&3));
        assert_eq!(graph.layout_parent.get(&9), Some(&6));
        assert_no_excluded_relations(&graph);
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
        let placed = place(&graph, frames);
        let design = placed.block("design");
        let dev = placed.block("dev");
        assert_eq!(placed.exits(), vec![(n(8), design, 3)]);
        assert_eq!(placed.fallbacks(), vec![n(9)]);
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(design), b(dev), n(9)]);
        assert_eq!(placed.outer(Slot::Block(design)), vec![n(8)]);
    }

    #[test]
    fn placement_tree_falls_back_inside_the_outer_frame_of_review_b_2() {
        // B-2 の入力: 1 root / 2 設計 %team %design (3 画面 (4 下書き)、5 API) / 6 付録 / 7 告知 %team。画面 --> 告知 --> API。
        // 告知は design の出口にすると閉路なので後戻り。告知を含むいちばん内側の箱は team で、team の中の木の最上位は
        // Block(design) 1 つなので、Joint(team) の子に [Block(design), 告知] と並ぶ (A-3/B-2)
        let graph = graph_of(
            7,
            &[(1, 2), (2, 3), (3, 4), (2, 5), (1, 6), (1, 7)],
            &[(3, 7), (7, 5)],
            &[7],
        );
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 7]));
        assert_no_excluded_relations(&graph);
        let both: &[&str] = &["team", "design"];
        let frames = frames_of(
            &graph,
            &["team", "design"],
            &[(2, both), (3, both), (4, both), (5, both), (7, &["team"])],
        );
        assert_eq!(
            members_of(&frames),
            vec![
                ("team".to_string(), vec![2, 3, 4, 5, 7]),
                ("design".to_string(), vec![2, 3, 4, 5])
            ]
        );
        let placed = place(&graph, frames);
        let team = placed.block("team");
        let design = placed.block("design");
        assert_eq!(placed.fallbacks(), vec![n(7)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(team), n(6)]);
        assert_eq!(placed.inner_root(team), j(team));
        assert_eq!(placed.inner(team, Slot::Joint(team)), vec![b(design), n(7)]);
        assert_eq!(placed.inner(design, Slot::Node(2)), vec![n(3), n(5)]);
        assert_eq!(placed.inner(design, Slot::Node(3)), vec![n(4)]);
    }

    #[test]
    fn placement_tree_falls_back_inside_the_outer_frame_of_two_levels() {
        // A-3 の入力 1: 1 root / 2 開発 %dev / 3 設計 %design (開発の子) / 4 画面、5 API / 6 告知 %dev / 7 公開。
        // 設計 --> 告知 --> API。告知は design の出口にすると閉路なので後戻り。dev の中の木の最上位は開発 1 つなので、
        // Joint(dev) の子に [開発, 告知]
        let graph = graph_of(
            7,
            &[(1, 2), (2, 3), (3, 4), (3, 5), (1, 6), (1, 7)],
            &[(3, 6), (6, 5)],
            &[6],
        );
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 5, 6]));
        assert_no_excluded_relations(&graph);
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
        assert_eq!(
            members_of(&frames),
            vec![
                ("dev".to_string(), vec![2, 3, 4, 5, 6]),
                ("design".to_string(), vec![3, 4, 5])
            ]
        );
        let placed = place(&graph, frames);
        let dev = placed.block("dev");
        let design = placed.block("design");
        assert_eq!(placed.fallbacks(), vec![n(6)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(dev), n(7)]);
        assert_eq!(placed.inner_root(dev), j(dev));
        assert_eq!(placed.inner(dev, Slot::Joint(dev)), vec![n(2), n(6)]);
        assert_eq!(placed.inner(dev, Slot::Node(2)), vec![b(design)]);
        assert_eq!(placed.inner(design, Slot::Node(3)), vec![n(4), n(5)]);
    }

    #[test]
    fn placement_tree_falls_back_inside_the_outer_frame_of_three_levels() {
        // A-3 の入力 2: 1 root / 2 本部 %hq / 3 開発 %dev / 4 設計 %design / 5 画面、6 API / 7 運用 (開発の子) / 8 告知 %hq / 9 公開。
        // 設計 --> 告知 --> API。u = 設計 4 を含む箱で告知を含まないのは design と dev なので移し先は dev。API は dev のメンバーで
        // 閉路になり後戻り。告知を含むいちばん内側の箱は hq で、Joint(hq) の子に [本部, 告知]
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
        assert_eq!(layout_children_of(&graph).get(&4), Some(&vec![5, 6, 8]));
        assert_no_excluded_relations(&graph);
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
        assert_eq!(
            members_of(&frames),
            vec![
                ("hq".to_string(), vec![2, 3, 4, 5, 6, 7, 8]),
                ("dev".to_string(), vec![3, 4, 5, 6, 7]),
                ("design".to_string(), vec![4, 5, 6])
            ]
        );
        let placed = place(&graph, frames);
        let hq = placed.block("hq");
        let dev = placed.block("dev");
        let design = placed.block("design");
        assert_eq!(placed.fallbacks(), vec![n(8)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(hq), n(9)]);
        assert_eq!(placed.inner_root(hq), j(hq));
        assert_eq!(placed.inner(hq, Slot::Joint(hq)), vec![n(2), n(8)]);
        assert_eq!(placed.inner(hq, Slot::Node(2)), vec![b(dev)]);
        assert_eq!(placed.inner(dev, Slot::Node(3)), vec![b(design), n(7)]);
        assert_eq!(placed.inner(design, Slot::Node(4)), vec![n(5), n(6)]);
    }

    #[test]
    fn placement_tree_falls_back_to_the_root_even_when_the_tree_parent_is_a_member() {
        // B-10 の入力 (境界の入力。Markdown では書けない): nested-groups に screen = {3, 4} と relations 5 → 4。
        // 5 は 3 のツリーの子でメンバーでないので出口の子。5 → 4 で閉路になり後戻り。5 を含む箱はないので、
        // tree_parent (3) ではなく外側の木の根の子の末尾
        let graph = graph_of(9, &NESTED_TREE, &[(5, 4)], &[]);
        assert_eq!(graph.layout_parent.get(&4), Some(&3));
        assert_eq!(graph.layout_parent.get(&5), Some(&3));
        assert_eq!(layout_children_of(&graph).get(&3), Some(&vec![4, 5]));
        assert_no_excluded_relations(&graph);
        let frames = frames_of(&graph, &["screen"], &[(3, &["screen"]), (4, &["screen"])]);
        let placed = place(&graph, frames);
        let screen = placed.block("screen");
        assert_eq!(placed.fallbacks(), vec![n(5)]);
        assert!(placed.exits().is_empty());
        assert_eq!(placed.outer(Slot::Node(1)), vec![n(2), n(9), n(5)]);
        assert_eq!(placed.outer(Slot::Node(2)), vec![b(screen), n(6)]);
        assert_eq!(placed.inner(screen, Slot::Node(3)), vec![n(4)]);
    }

    #[test]
    fn placement_tree_same_members_put_the_inner_block_at_the_root_of_the_outer() {
        // B-5 の入力 (frames.rs の frames_with_same_members_put_the_earlier_defined_group_outside と同じ): a と b はどちらも {3, 4, 5}。
        // a が外。a の中の木の根は Block(b)
        // 箱の中の木の根 (ここでは Block(b)) の parent_of は包む箱 (段 2 の実装で決めた)
        let graph = nested();
        let all: &[&str] = &["a", "b"];
        let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all), (5, all)]);
        let placed = place(&graph, frames);
        let outer = placed.block("a");
        let inner = placed.block("b");
        assert_eq!(placed.inner_root(outer), b(inner));
        assert_eq!(placed.inner_root(inner), n(3));
        assert_eq!(placed.parent(Slot::Block(inner)), Some(b(outer)));
        assert_eq!(placed.parent(Slot::Node(3)), Some(b(inner)));
        assert_eq!(placed.inner(inner, Slot::Node(3)), vec![n(4), n(5)]);
        assert_eq!(placed.outer(Slot::Node(2)), vec![b(outer), n(6)]);
        assert!(placed.exits().is_empty());
    }

    #[test]
    fn placement_tree_replaces_inner_roots_with_one_block_per_run() {
        // 1 root / 2 仕様 / 3、4、5 (仕様の子で縦に並ぶ) / 6。
        // (1) a = b = {3, 4}: a の根 3、4 はどちらも b の中なので、同じ箱が続いて 1 つにまとまり、a の中の木の根は Block(b)。
        // (2) a = {3, 4, 5}、b = {3, 4}: a の最上位は [Block(b), 5] で、Joint の子に並ぶ (B-5)
        let graph = graph_of(6, &[(1, 2), (2, 3), (2, 4), (2, 5), (1, 6)], &[], &[]);
        let all: &[&str] = &["a", "b"];

        let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all)]);
        let placed = place(&graph, frames);
        let a = placed.block("a");
        let b_ = placed.block("b");
        assert_eq!(placed.inner_root(a), b(b_));
        assert!(placed.inner_root(b_).starts_with('J'));
        assert_eq!(placed.inner_top(b_), vec![n(3), n(4)]);
        assert_eq!(placed.outer(Slot::Node(2)), vec![b(a), n(5)]);

        let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all), (5, &["a"])]);
        let placed = place(&graph, frames);
        let a = placed.block("a");
        let b_ = placed.block("b");
        assert!(placed.inner_root(a).starts_with('J'));
        assert_eq!(placed.inner_top(a), vec![b(b_), n(5)]);
        assert_eq!(placed.inner_top(b_), vec![n(3), n(4)]);
        assert_eq!(placed.outer(Slot::Node(2)), vec![b(a)]);
    }

    #[test]
    fn placement_tree_nested_groups_form_one_tree() {
        // nested-groups (frames.rs の model): dev = {2..=8}、backend = {6, 7, 8}、frontend = {3, 4, 5}。9 はメンバー 1 つなので枠がない。
        // 各ノードがちょうど 1 度だけ現れ、根から全部に届く (check_tree)
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
                (9, &["backend", "frontend"]),
            ],
        );
        let placed = place(&graph, frames);
        let dev = placed.block("dev");
        let backend = placed.block("backend");
        let frontend = placed.block("frontend");
        assert_eq!(name(&placed.tree.root), n(1));
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(dev), n(9)]);
        assert_eq!(placed.inner_top(dev), vec![n(2)]);
        assert_eq!(
            placed.inner(dev, Slot::Node(2)),
            vec![b(frontend), b(backend)]
        );
        assert_eq!(placed.inner(frontend, Slot::Node(3)), vec![n(4), n(5)]);
        assert_eq!(placed.inner(backend, Slot::Node(6)), vec![n(7), n(8)]);
        assert!(placed.exits().is_empty());
        assert!(placed.fallbacks().is_empty());
    }

    #[test]
    fn placement_tree_leaves_members_of_loose_frames_in_the_outer_tree() {
        // 1 root の下に 2、3、4。p = {2, 3} は箱、q = {3, 4} は loose (段 1)。loose の枠は箱にしないので 4 は外側の木にいる
        let graph = graph_of(4, &[(1, 2), (1, 3), (1, 4)], &[], &[]);
        let frames = frames_of(
            &graph,
            &["p", "q"],
            &[(2, &["p"]), (3, &["p", "q"]), (4, &["q"])],
        );
        let placed = place(&graph, frames);
        assert_eq!(placed.blocks.loose, vec![1]);
        let p = placed.block("p");
        assert_eq!(placed.outer(Slot::Node(1)), vec![b(p), n(4)]);
        assert_eq!(placed.inner_top(p), vec![n(2), n(3)]);
        assert!(placed.exits().is_empty());
    }

    #[test]
    fn placement_tree_frame_containing_the_root_is_the_root_block() {
        // 全部のノードが 1 つのグループ。箱の parent は None (段 1)。外側の木では箱が 1 つのノードなので、根は Block(all)
        let graph = nested();
        let entries: Vec<(u32, &[&str])> = (1..=9).map(|id| (id, &["all"][..])).collect();
        let frames = frames_of(&graph, &["all"], &entries);
        let placed = place(&graph, frames);
        let all = placed.block("all");
        assert_eq!(name(&placed.tree.root), b(all));
        assert_eq!(placed.inner_root(all), n(1));
        assert_eq!(placed.inner(all, Slot::Node(1)), vec![n(2), n(9)]);
        assert!(placed.exits().is_empty());
        assert!(placed.fallbacks().is_empty());
    }

    #[test]
    fn placement_tree_many_exits_finish_within_a_second() {
        // A-5 の入力を N = 2000 で: 1 root / 2 設計 %design / 3..=N+2 項目k (設計の子) / N+3..=2N+2 告知k (項目k --> 告知k)。
        // 告知はすべて design の出口の子で、並びは項目の順
        // TODO(spec): 「制約の辺の数が 2N + 1 の程度」は PlacementTree に出ないので確かめられない。時間 (1 秒以内) と結果だけを見る
        let count = 2000u32;
        let items: Vec<u32> = (3..count + 3).collect();
        let notices: Vec<u32> = (count + 3..2 * count + 3).collect();
        let mut tree: Vec<(u32, u32)> = vec![(1, 2)];
        tree.extend(items.iter().map(|&item| (2, item)));
        tree.extend(notices.iter().map(|&notice| (1, notice)));
        let chain: Vec<(u32, u32)> = items.iter().copied().zip(notices.iter().copied()).collect();
        let graph = graph_of(2 * count + 2, &tree, &chain, &notices);
        assert_eq!(graph.layout_parent.get(&notices[0]), Some(&items[0]));
        let mut entries: Vec<(u32, &[&str])> = vec![(2, &["design"][..])];
        entries.extend(items.iter().map(|&item| (item, &["design"][..])));
        let frames = frames_of(&graph, &["design"], &entries);
        let (placed, elapsed) = place_timed(&graph, frames);
        let design = placed.block("design");
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(
            placed.outer(Slot::Block(design)),
            notices.iter().map(|&notice| n(notice)).collect::<Vec<_>>()
        );
        assert_eq!(
            placed.exits(),
            sorted(
                items
                    .iter()
                    .zip(&notices)
                    .map(|(&item, &notice)| (n(notice), design, item))
                    .collect()
            )
        );
        assert!(placed.fallbacks().is_empty());
    }

    #[test]
    fn placement_tree_deep_nesting_does_not_overflow_the_stack() {
        // 同じ 2 つのメンバー (3、4) の枠 2000 個は 1 本の鎖に入れ子になり、全部が箱 (段 1)。各箱の中の木の根は 1 つ内側の Block で、
        // いちばん内側は 3。5 は 3 の子でどの箱のメンバーでもないので、いちばん外側の箱の出口の子。wasm の既定と同じ 1 MiB のスタックで回す
        let count = 2000u32;
        let result = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                let graph = nested();
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
                let placed = place(&graph, frames);
                let by_level = |level: u32| {
                    (0..placed.blocks.blocks.len())
                        .find(|&index| placed.blocks.blocks[index].level == level)
                        .unwrap()
                };
                let innermost = by_level(0);
                let outermost = by_level(count - 1);
                let chained = (1..count)
                    .all(|level| placed.inner_root(by_level(level)) == b(by_level(level - 1)));
                (
                    chained,
                    placed.inner_root(innermost),
                    placed.inner(innermost, Slot::Node(3)),
                    placed.outer(Slot::Node(2)),
                    placed.outer(Slot::Block(outermost)),
                    placed.exits(),
                    outermost,
                )
            })
            .unwrap()
            .join()
            .unwrap();
        let (chained, innermost_root, innermost_children, under_2, exit_children, exits, outermost) =
            result;
        assert!(chained);
        assert_eq!(innermost_root, n(3));
        assert_eq!(innermost_children, vec![n(4)]);
        assert_eq!(under_2, vec![b(outermost), n(6)]);
        assert_eq!(exit_children, vec![n(5)]);
        assert_eq!(exits, vec![(n(5), outermost, 3)]);
    }

    #[test]
    fn placement_tree_deep_tree_does_not_overflow_the_stack() {
        // 深さ 20000 の 1 本の木 (1 → 2 → … → 20000)。f = {10, 11} (境界の入力として 12 はメンバーでない)。
        // 12 は f の出口の子で、その下に 20000 までの鎖が続く。閉路の判定も配置の木の組み立ても 1 MiB のスタックで溢れない
        let length = 20_000u32;
        let result = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                let tree: Vec<(u32, u32)> = (1..length).map(|id| (id, id + 1)).collect();
                let graph = graph_of(length, &tree, &[], &[]);
                let frames = frames_of(&graph, &["f"], &[(10, &["f"]), (11, &["f"])]);
                let placed = place(&graph, frames);
                let f = placed.block("f");
                (
                    f,
                    placed.outer(Slot::Node(9)),
                    placed.outer(Slot::Block(f)),
                    placed.outer(Slot::Node(12)),
                    placed.outer(Slot::Node(length - 1)),
                    placed.inner_top(f),
                    placed.inner(f, Slot::Node(10)),
                    placed.inner(f, Slot::Node(11)),
                    placed.exits(),
                )
            })
            .unwrap()
            .join()
            .unwrap();
        let (f, under_9, exit_children, under_12, under_last, top, under_10, under_11, exits) =
            result;
        assert_eq!(under_9, vec![b(f)]);
        assert_eq!(exit_children, vec![n(12)]);
        assert_eq!(under_12, vec![n(13)]);
        assert_eq!(under_last, vec![n(length)]);
        assert_eq!(top, vec![n(10)]);
        assert_eq!(under_10, vec![n(11)]);
        assert!(under_11.is_empty());
        assert_eq!(exits, vec![(n(12), f, 11)]);
    }

    // ルートを含む枠が箱になり、後戻りした単位を含む箱がない入力 (乱数の pipeline-19、74、113、121 の形を縮めたもの)。
    // 依頼者の規定 (メンバーでないノードは枠に入らない) から、後戻りした単位はルートの箱の中の木にも、その箱の子 (出口の並び) にも
    // 入れず、箱の外側の最上位の並びの末尾に置く (Q3-b の「閉路のときだけ枠の下の行」と同じ)。
    // 外側の木の根の形は G-004 で決めた: 根は仮の根で、その子の並びは [ルートの箱, 後戻りした単位 (処理した順)...]。
    // 仮の根の種類 (箱の Joint を借りるか、G-005 の C-01 の外側の仮の根か) は確かめない
    fn assert_fallback_outside_the_root_block(placed: &Placed, block: usize, unit: Slot) {
        let (inner_root, inner) = &placed.tree.inner[block];
        assert_ne!(
            name(inner_root),
            name(&unit),
            "後戻りの単位が箱の中の木の根にある"
        );
        for (parent, list) in inner {
            assert_ne!(name(parent), name(&unit), "後戻りの単位が箱の中の木にある");
            assert!(
                !names(list).contains(&name(&unit)),
                "後戻りの単位が箱の中の木にある"
            );
        }
        assert!(
            !placed.outer(Slot::Block(block)).contains(&name(&unit)),
            "後戻りの単位が箱の子 (出口の並び) にある"
        );
        assert_ne!(placed.parent(unit), Some(b(block)), "後戻りの単位の親が箱");
        let root = placed.tree.root;
        assert!(
            !matches!(root, Slot::Node(_) | Slot::Block(_)),
            "外側の木の根が仮の根でない"
        );
        let expected: Vec<String> = std::iter::once(b(block))
            .chain(placed.fallbacks())
            .collect();
        assert_eq!(placed.outer(root), expected, "仮の根の子の並び");
        assert_eq!(placed.parent(Slot::Block(block)), Some(name(&root)));
        assert_eq!(placed.parent(unit), Some(name(&root)));
    }

    #[test]
    fn placement_tree_falls_back_outside_the_root_block_when_the_exit_closes_a_cycle() {
        // Q3 の例 3 の形で、ルートも枠のメンバーにしたもの: 1 root %a / 2 設計 %a (3 画面 %a、4 API %a) / 5 告知。
        // 画面 --> 告知 --> API。告知は画面の下に付け替わり、出口へ移すと a のメンバー → 告知 → API の閉路になるので後戻り。
        // a はルートを含むので箱の parent は None で、告知を含む箱はない
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
            &["a"],
            &[(1, &["a"]), (2, &["a"]), (3, &["a"]), (4, &["a"])],
        );
        assert_eq!(
            members_of(&frames),
            vec![("a".to_string(), vec![1, 2, 3, 4])]
        );
        let placed = place(&graph, frames);
        let a = placed.block("a");
        assert_eq!(placed.blocks.blocks[a].parent, None);
        assert_eq!(placed.fallbacks(), vec![n(5)]);
        assert!(placed.exits().is_empty());
        assert_fallback_outside_the_root_block(&placed, a, Slot::Node(5));
        // メンバーの並びは後戻りの前と同じ
        assert_eq!(placed.inner_root(a), n(1));
        assert_eq!(placed.inner(a, Slot::Node(1)), vec![n(2)]);
        assert_eq!(placed.inner(a, Slot::Node(2)), vec![n(3), n(4)]);
    }

    #[test]
    fn placement_tree_falls_back_outside_the_root_block_for_a_plain_child_of_the_root() {
        // pipeline-113 の形: 1 root %a / 2 告知 (ルートのツリーの子でメンバーでない) / 3 実装 %a。告知 --> 実装。
        // 告知の配置上の親はルート (a のメンバー) なので出口の子。出口へ移すと a のメンバー → 告知 → 実装 (a のメンバー) の閉路になり後戻り
        let graph = graph_of(3, &[(1, 2), (1, 3)], &[(2, 3)], &[]);
        assert_eq!(graph.layout_parent.get(&2), Some(&1));
        assert_eq!(graph.layout_parent.get(&3), Some(&1));
        assert_no_excluded_relations(&graph);
        let frames = frames_of(&graph, &["a"], &[(1, &["a"]), (3, &["a"])]);
        assert_eq!(members_of(&frames), vec![("a".to_string(), vec![1, 3])]);
        let placed = place(&graph, frames);
        let a = placed.block("a");
        assert_eq!(placed.blocks.blocks[a].parent, None);
        assert_eq!(placed.fallbacks(), vec![n(2)]);
        assert!(placed.exits().is_empty());
        assert_fallback_outside_the_root_block(&placed, a, Slot::Node(2));
        assert_eq!(placed.inner_root(a), n(1));
        assert_eq!(placed.inner(a, Slot::Node(1)), vec![n(3)]);
    }

    #[test]
    fn placement_tree_keeps_exits_of_the_root_block_and_puts_its_fallback_outside() {
        // pipeline-19、74、121 の形: ルートの箱に、出口の子と後戻りが両方ある。
        // 1 root %a / 2 設計 %a (3 画面 %a、4 API %a) / 5 告知 / 6 公開。画面 --> 告知 --> API、API --> 公開。
        // 告知は後戻り (上の例 3 の形)。公開は API の下に付け替わり、閉路にならないので a の出口の子のまま
        let graph = graph_of(
            6,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6)],
            &[(3, 5), (5, 4), (4, 6)],
            &[5, 6],
        );
        assert_eq!(graph.layout_parent.get(&5), Some(&3));
        assert_eq!(graph.layout_parent.get(&6), Some(&4));
        assert_no_excluded_relations(&graph);
        let frames = frames_of(
            &graph,
            &["a"],
            &[(1, &["a"]), (2, &["a"]), (3, &["a"]), (4, &["a"])],
        );
        let placed = place(&graph, frames);
        let a = placed.block("a");
        assert_eq!(placed.fallbacks(), vec![n(5)]);
        assert_eq!(placed.exits(), vec![(n(6), a, 4)]);
        assert_eq!(placed.outer(Slot::Block(a)), vec![n(6)]);
        assert_fallback_outside_the_root_block(&placed, a, Slot::Node(5));
    }

    #[test]
    fn placement_tree_falls_back_outside_the_root_block_when_every_block_uses_its_joint() {
        // レビュー A-1 (G-005 の穴。境界の入力で、Markdown では書けない。ルートがメンバーなら継承で全部がメンバーになる)。
        // 1 全体 / 2 設計 (3 画面、4 API) / 5 設計2 / 6 告知 / 7 外告知。画面 --> 告知 --> API、画面 --> 外告知 --> API。
        // top = {1..=6}、b = {2, 3, 4, 5} (継承なし)。外告知はどちらのメンバーでもない。
        // b の根は 設計 と 設計2 の 2 つで Joint(b) を使う。告知は b の出口にすると閉路になり、top の中の末尾へ後戻りして Joint(top) を使う。
        // 外告知は top の出口にすると閉路になり、包む箱がないので後戻り。どの箱の Joint も使われているが、
        // 外告知は top の箱の子 (出口の並び) にも中の木にも入れず、箱の外側の最上位の並びの末尾に置く (I1。G-004)
        let graph = graph_of(
            7,
            &[(1, 2), (2, 3), (2, 4), (1, 5), (1, 6), (1, 7)],
            &[(3, 6), (6, 4), (3, 7), (7, 4)],
            &[6, 7],
        );
        assert_eq!(graph.layout_parent.get(&6), Some(&3));
        assert_eq!(graph.layout_parent.get(&7), Some(&3));
        assert_no_excluded_relations(&graph);
        let both: &[&str] = &["top", "b"];
        let frames = frames_of(
            &graph,
            &["top", "b"],
            &[
                (1, &["top"]),
                (2, both),
                (3, both),
                (4, both),
                (5, both),
                (6, &["top"]),
            ],
        );
        assert_eq!(
            members_of(&frames),
            vec![
                ("top".to_string(), vec![1, 2, 3, 4, 5, 6]),
                ("b".to_string(), vec![2, 3, 4, 5]),
            ]
        );
        let placed = place(&graph, frames);
        let top = placed.block("top");
        let b_ = placed.block("b");
        assert_eq!(placed.blocks.blocks[top].parent, None);
        assert_eq!(placed.fallbacks(), vec![n(6), n(7)]);
        assert!(placed.exits().is_empty());
        // どの箱も中の木で Joint を使う
        assert_eq!(placed.inner_root(b_), j(b_));
        assert_eq!(placed.inner_top(b_), vec![n(2), n(5)]);
        assert_eq!(placed.inner_root(top), j(top));
        assert_eq!(placed.inner_top(top), vec![n(1), n(6)]);
        // 外告知は箱の外。外側の木の根は仮の根で、その子の並びは [Block(top), 外告知]
        for block in [top, b_] {
            let (inner_root, inner) = &placed.tree.inner[block];
            assert_ne!(name(inner_root), n(7));
            assert!(
                inner
                    .iter()
                    .all(|(parent, list)| name(parent) != n(7) && !names(list).contains(&n(7))),
                "外告知が B{block} の中の木にある"
            );
            assert!(
                !placed.outer(Slot::Block(block)).contains(&n(7)),
                "外告知が B{block} の子 (出口の並び) にある"
            );
        }
        let root = placed.tree.root;
        assert!(
            !matches!(root, Slot::Node(_) | Slot::Block(_)),
            "外側の木の根が仮の根でない"
        );
        assert_eq!(placed.outer(root), vec![b(top), n(7)]);
        assert_eq!(placed.parent(Slot::Block(top)), Some(name(&root)));
        assert_eq!(placed.parent(Slot::Node(7)), Some(name(&root)));
        // 外側の仮の根は、中の木の Joint と別の頂点 (G-005 の C-01。Joint の使い回しをやめる)
        for block in [top, b_] {
            assert_ne!(name(&root), j(block), "外側の木の根が中の木の Joint と同じ");
        }
    }

    // 段 4 (兄弟の方向の位置、箱の配置) の layout_placement の単体テスト。期待値は design.md の「段 4: 兄弟の方向の位置 (箱の配置)」と
    // flextree の置き方 (子の並びの端の中点に親を置く。1 つの子は親と同じ中心) から導く。
    // 仮定したシグネチャ (入力の名前と型は設計の「layout_placement の入力」のとおり。戻り値の Result は設計に書かれていないので仮定):
    //     pub fn layout_placement(placement: &PlacementTree, node_size: &IndexMap<u32, [f64; 2]>, depths: &DepthPlan,
    //                             blocks: &FrameBlocks,
    //                             spacing: &mut dyn FnMut(Slot, Slot) -> Result<f64, LayoutError>)
    //         -> Result<Vec<Placed>, LayoutError>
    //     Placed は flextree の Placed (id、x は兄弟の方向の中心、y は深さの方向の上端、x_size、y_size)。実のノードだけを返す。
    // 入力は段 1〜3 の本物の関数 (compute_frames、frame_blocks、placement_tree、block_depths) で作る。node_size は
    // layout_graph_with_extra_spacing と同じ形 ([高さ, gap + ext]) を段 3 の gap_of で組む。
    // 数値の約束: ノードは幅 40、高さ 20。既定の options で本体 = 40 + 8 × 2 = 56、ext = 56 + 80 = 136。
    //     frame_padding(level) は四辺とも 8 + 22 × level、LABEL_HEIGHT は 14。
    //     箱の兄弟の方向の大きさ = 中身 (メンバーの矩形と内側の箱) の外接 + top + LABEL_HEIGHT + bottom (level 0 なら外接 + 30)。
    //     spacing は、断らなければ定数 SPACING (10)。
    // 箱の深さの方向の大きさ (frame_right + spacing_horizontal − start) は、段 3 が BlockDepth.end で渡す (段 4 の実装で決めた)。
    // 箱の大きさは出力に出ないので、深さの方向は「上端 + gap が planned_x」(check_placed) だけを求める
    mod place {
        use std::collections::HashMap;

        use indexmap::IndexMap;

        use super::{example1_graph, frames_of, graph_of, group, nested, notation_like};
        use crate::layout::flextree::{FlexTree, Placed};
        use crate::layout::frames::{Frame, FrameBlocks, compute_frames, frame_blocks};
        use crate::layout::layout::{
            DepthPlan, MARKMAP_DEFAULTS, block_depths, layout_children_of, layout_predecessors,
        };
        use crate::layout::placement::{PlacementTree, Slot, layout_placement, placement_tree};
        use crate::layout::project::{VisibleGraph, project};
        use crate::types::{
            GroupDef, LayoutError, LayoutInput, LayoutInputEdge, LayoutInputNode,
            LayoutInputRelation, RelationKind,
        };

        const SPACING: f64 = 10.0;

        struct Input {
            graph: VisibleGraph,
            frames: Vec<Frame>,
            blocks: FrameBlocks,
            tree: PlacementTree,
            depths: DepthPlan,
            node_size: IndexMap<u32, [f64; 2]>,
        }

        // 段 1〜3 の本物の関数で段 4 の入力を作る (既定の options)
        fn input(graph: VisibleGraph, frames: Vec<Frame>) -> Input {
            let options = MARKMAP_DEFAULTS;
            let children_of = layout_children_of(&graph);
            let blocks = frame_blocks(&graph, &frames, &children_of);
            let predecessors = layout_predecessors(&graph, &MARKMAP_DEFAULTS);
            let tree = placement_tree(&graph, &children_of, &frames, &blocks, &predecessors);
            let depths =
                match block_depths(&graph, &options, &tree, &blocks, &frames, &predecessors) {
                    Ok(depths) => depths,
                    Err(error) => panic!("block_depths が誤りを返した: {}", error.message),
                };
            let node_size: IndexMap<u32, [f64; 2]> = graph
                .nodes
                .iter()
                .map(|node| {
                    let ext = node.width
                        + (if node.width > 0.0 {
                            options.padding_x * 2.0
                        } else {
                            0.0
                        })
                        + options.spacing_horizontal;
                    (node.id, [node.height, depths.gap_of[&node.id] + ext])
                })
                .collect();
            Input {
                graph,
                frames,
                blocks,
                tree,
                depths,
                node_size,
            }
        }

        impl Input {
            fn run(
                &self,
                spacing: &mut dyn FnMut(Slot, Slot) -> Result<f64, LayoutError>,
            ) -> Result<Vec<Placed>, LayoutError> {
                layout_placement(
                    &self.tree,
                    &self.node_size,
                    &self.depths,
                    &self.blocks,
                    spacing,
                )
            }

            fn block(&self, group: &str) -> usize {
                let found: Vec<usize> = (0..self.blocks.blocks.len())
                    .filter(|&index| self.frames[self.blocks.blocks[index].frame].group.id == group)
                    .collect();
                assert_eq!(found.len(), 1, "{group} の箱はちょうど 1 つ");
                found[0]
            }
        }

        struct Laid {
            input: Input,
            placed: HashMap<u32, Placed>,
            calls: Vec<(Slot, Slot)>,
        }

        impl Laid {
            fn at(&self, id: u32) -> &Placed {
                &self.placed[&id]
            }

            // 兄弟の方向の上端と下端 (flextree の x は中心)
            fn top(&self, id: u32) -> f64 {
                let placed = self.at(id);
                placed.x - placed.x_size / 2.0
            }

            fn bottom(&self, id: u32) -> f64 {
                let placed = self.at(id);
                placed.x + placed.x_size / 2.0
            }
        }

        // 実のノードがちょうど 1 度ずつ返り (Block と Joint は捨てる)、大きさは node_size のまま、
        // 深さの方向の上端 + gap が段 3 の planned_x と同じ (設計の段 3「どのノードも rect.x = planned_x になる」)
        fn check_placed(input: &Input, placed: &[Placed]) -> HashMap<u32, Placed> {
            let ids: Vec<u32> = input.graph.nodes.iter().map(|node| node.id).collect();
            let mut returned: Vec<u32> = placed.iter().map(|p| p.id).collect();
            returned.sort_unstable();
            let mut expected = ids.clone();
            expected.sort_unstable();
            assert_eq!(returned, expected, "実のノードだけを 1 度ずつ返す");
            for p in placed {
                let size = input.node_size[&p.id];
                assert_eq!(p.x_size.to_bits(), size[0].to_bits(), "{} の x_size", p.id);
                assert_eq!(p.y_size.to_bits(), size[1].to_bits(), "{} の y_size", p.id);
                let x = p.y + input.depths.gap_of[&p.id];
                assert!(
                    (x - input.depths.planned_x[&p.id]).abs() <= 1e-9,
                    "{} の深さの位置 {x} が planned_x {} と違う",
                    p.id,
                    input.depths.planned_x[&p.id]
                );
            }
            placed.iter().map(|p| (p.id, p.clone())).collect()
        }

        fn lay_with(input: Input, spacing: f64) -> Laid {
            let mut calls: Vec<(Slot, Slot)> = Vec::new();
            let placed = match input.run(&mut |upper, lower| {
                calls.push((upper, lower));
                Ok(spacing)
            }) {
                Ok(placed) => placed,
                Err(error) => panic!("layout_placement が誤りを返した: {}", error.message),
            };
            let placed = check_placed(&input, &placed);
            Laid {
                input,
                placed,
                calls,
            }
        }

        fn lay(graph: VisibleGraph, frames: Vec<Frame>) -> Laid {
            lay_with(input(graph, frames), SPACING)
        }

        fn bits(placed: &[Placed]) -> Vec<(u32, u64, u64, u64, u64)> {
            placed
                .iter()
                .map(|p| {
                    (
                        p.id,
                        p.x.to_bits(),
                        p.y.to_bits(),
                        p.x_size.to_bits(),
                        p.y_size.to_bits(),
                    )
                })
                .collect()
        }

        // 箱 b の中の木だけを FlexTree::layout で回した結果 (中の木に内側の箱があれば None)。Joint は使われていない id に写す
        fn alone(laid: &Laid, b: usize) -> Option<HashMap<u32, Placed>> {
            let (root, map) = &laid.input.tree.inner[b];
            let joint_id = laid.input.graph.nodes.iter().map(|node| node.id).max()? + 1;
            let to_id = |slot: &Slot| match slot {
                Slot::Node(id) => Some(*id),
                Slot::Joint(_) => Some(joint_id),
                Slot::Block(_) => None,
                // 外側の仮の根 (G-005 の C-01) は箱の中の木に現れない
                #[allow(unreachable_patterns)]
                _ => None,
            };
            let mut children: IndexMap<u32, Vec<u32>> = IndexMap::new();
            for (parent, list) in map {
                let kids: Option<Vec<u32>> = list.iter().map(to_id).collect();
                children.insert(to_id(parent)?, kids?);
            }
            let mut sizes = laid.input.node_size.clone();
            sizes.insert(joint_id, [0.0, 0.0]);
            let placed =
                FlexTree::layout(to_id(root)?, &children, &sizes, &mut |_, _| Ok(SPACING)).unwrap();
            Some(
                placed
                    .into_iter()
                    .filter(|p| p.id != joint_id)
                    .map(|p| (p.id, p))
                    .collect(),
            )
        }

        // 箱の中の配置は、その箱だけを回した結果を平行移動したもの。兄弟の方向は全員が同じだけずれ、深さの方向は箱の start だけずれる
        fn assert_translated(laid: &Laid, b: usize) {
            let Some(alone) = alone(laid, b) else {
                panic!("箱 {b} の中の木に内側の箱がある");
            };
            let start = laid.input.depths.blocks[b].start;
            let first = alone.keys().next().copied().unwrap();
            let dx = laid.at(first).x - alone[&first].x;
            for (id, expected) in &alone {
                let actual = laid.at(*id);
                assert!(
                    (actual.x - expected.x - dx).abs() <= 1e-9,
                    "箱 {b} の {id} の兄弟の方向のずれが他のメンバーと違う"
                );
                assert!(
                    (actual.y - expected.y - start).abs() <= 1e-9,
                    "箱 {b} の {id} の深さの方向のずれが箱の start ({start}) と違う"
                );
            }
        }

        // 1 root / 2 設計 / 3 画面 %ui / 4 部品 %ui / 5 API (B-7 の入力。design-review-b.md の b5-two-root-box-sibling.md)
        fn review_b_7() -> (VisibleGraph, Vec<Frame>) {
            let graph = graph_of(5, &[(1, 2), (2, 3), (2, 4), (2, 5)], &[], &[]);
            let frames = frames_of(&graph, &["ui"], &[(3, &["ui"]), (4, &["ui"])]);
            (graph, frames)
        }

        // 例 2 (loose-frames.md): 1 root / 2 開発 / 3 画面、4 決済APIとWebhookの実装 / 5 脆弱性診断 / 6 本番反映。security = {4, 5}
        fn example2() -> (VisibleGraph, Vec<Frame>) {
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
            (graph, frames)
        }

        fn nested_frames(graph: &VisibleGraph) -> Vec<Frame> {
            frames_of(
                graph,
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
            )
        }

        #[test]
        fn layout_placement_without_frames_matches_flextree() {
            // 枠のない入力では配置の木は L0 の写し (段 2) なので、FlexTree::layout と同じ結果 (並びと to_bits) で、
            // spacing も同じ組を同じ順に問う (Slot::Node に写しただけ)
            let (notation, _) = notation_like();
            for graph in [nested(), example1_graph(), notation] {
                let input = input(graph, Vec::new());
                assert!(input.blocks.blocks.is_empty());
                let spacing_of = |upper: u32, lower: u32| {
                    3.0 + f64::from(upper % 4) + f64::from(lower % 3) * 0.25
                };
                let mut slot_calls: Vec<(Slot, Slot)> = Vec::new();
                let placed = input
                    .run(&mut |upper, lower| {
                        slot_calls.push((upper, lower));
                        match (upper, lower) {
                            (Slot::Node(a), Slot::Node(b)) => Ok(spacing_of(a, b)),
                            _ => panic!("枠のない入力で Node でない Slot を問うた"),
                        }
                    })
                    .unwrap();
                let mut id_calls: Vec<(Slot, Slot)> = Vec::new();
                let expected = FlexTree::layout(
                    input.graph.root_id,
                    &layout_children_of(&input.graph),
                    &input.node_size,
                    &mut |a, b| {
                        id_calls.push((Slot::Node(a), Slot::Node(b)));
                        Ok(spacing_of(a, b))
                    },
                )
                .unwrap();
                assert_eq!(bits(&placed), bits(&expected));
                assert_eq!(slot_calls, id_calls);
            }
        }

        #[test]
        fn layout_placement_returns_each_real_node_once() {
            // 箱 (Block) と仮の根 (Joint) は捨て、実のノードだけを 1 度ずつ返す (check_placed)。出口と後戻りのある入力も含める
            let (notation, notation_frames) = notation_like();
            let graph = nested();
            let frames = nested_frames(&graph);
            lay(graph, frames);
            lay(notation, notation_frames);
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            lay(graph, frames);
            // Q3 の例 3 (告知は後戻り)
            let graph = graph_of(
                5,
                &[(1, 2), (2, 3), (2, 4), (1, 5)],
                &[(3, 5), (5, 4)],
                &[5],
            );
            let frames = frames_of(
                &graph,
                &["design"],
                &[(2, &["design"]), (3, &["design"]), (4, &["design"])],
            );
            let laid = lay(graph, frames);
            assert_eq!(laid.input.tree.fallbacks, vec![Slot::Node(5)]);
        }

        #[test]
        fn layout_placement_box_of_loose_example_1_covers_members_padding_and_label() {
            // 例 1: 外側の木は 1 → 2 → Block(copy) → 5 (告知)。copy の中の木は Joint(copy) の子に [3, 4]。
            // 中の木: 3 と 4 (高さ 20) の中心の間は 10 + 10 + SPACING 10 = 30 で、Joint (0) の下に -15 と 15。
            // 中身の外接は [-25, 25]。箱は上へ top 8 + LABEL_HEIGHT 14、下へ bottom 8 広げて [-47, 33] (大きさ 80)。
            // 外側の木は 1 つの子の鎖なので、1、2、箱、5 の中心はどれも 0。箱の範囲は [-40, 40] で、中の木を -40 − (-47) = 7 ずらす。
            // よって 3 は -15 + 7 = -8、4 は 15 + 7 = 22、5 は 0。
            // 深さの方向 (段 3): 2 は 136、箱の start 272 (3 と 4 は Joint の下で 272)、告知は frame_right 336 + 80 = 416
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            let laid = lay(graph, frames);
            let copy = laid.input.block("copy");
            assert_eq!(laid.input.depths.blocks[copy].start, 272.0);
            assert_eq!(laid.input.depths.blocks[copy].frame_right, 336.0);
            let xs: Vec<(u32, f64, f64)> = (1..=5)
                .map(|id| (id, laid.at(id).x, laid.at(id).y))
                .collect();
            assert_eq!(
                xs,
                vec![
                    (1, 0.0, 0.0),
                    (2, 0.0, 136.0),
                    (3, -8.0, 272.0),
                    (4, 22.0, 272.0),
                    (5, 0.0, 416.0)
                ]
            );
            // 箱の上端 (ラベルの行を含む) は、メンバーの上端 − top − LABEL_HEIGHT。下端はメンバーの下端 + bottom
            assert_eq!(laid.top(3) - 8.0 - 14.0, -40.0);
            assert_eq!(laid.bottom(4) + 8.0, 40.0);
        }

        #[test]
        fn layout_placement_box_of_loose_example_2_is_separated_from_its_upper_sibling() {
            // 例 2: 外側の木は 2 → [3, Block(security)]、Block(security) → 6 (本番反映)。中の木は Joint の子に [4, 5]。
            // 箱は例 1 と同じ大きさ 80 で、中の木の上端は -47。3 (20) と箱 (80) の中心の間は 10 + SPACING 10 + 40 = 60。
            // 親 2 (0) は、3 の上端 c − 10 と箱の下端 c + 60 + 40 の中点なので c = -45。3 は -45、箱の中心は 15、箱の範囲は [-25, 55]。
            // 中の木を -25 − (-47) = 22 ずらし、4 は -15 + 22 = 7、5 は 15 + 22 = 37。6 は箱の中心 15。
            // 深さの方向: 3、4、5 は 272、6 は frame_right 336 + 80 = 416
            let (graph, frames) = example2();
            let laid = lay(graph, frames);
            let xs: Vec<(u32, f64, f64)> = (1..=6)
                .map(|id| (id, laid.at(id).x, laid.at(id).y))
                .collect();
            assert_eq!(
                xs,
                vec![
                    (1, 0.0, 0.0),
                    (2, 0.0, 136.0),
                    (3, -45.0, 272.0),
                    (4, 7.0, 272.0),
                    (5, 37.0, 272.0),
                    (6, 15.0, 416.0)
                ]
            );
            // 3 の下端から箱の上端 (4 の上端 − 8 − 14) までが SPACING
            assert_eq!(laid.top(4) - 22.0 - laid.bottom(3), SPACING);
        }

        #[test]
        fn layout_placement_inner_layout_is_a_translation_of_the_box_alone() {
            // 箱の中の相対位置は外に左右されない: 中の木に内側の箱のない箱は、その中の木だけを FlexTree::layout で回した結果を
            // 平行移動したもの。Joint が根の箱 (例 1 の copy、例 2 の security)、Node が根で子の列のある箱 (notation の d、b)、
            // 入れ子の内側の箱 (nested-groups の frontend、backend) で見る
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            let laid = lay(graph, frames);
            assert_translated(&laid, laid.input.block("copy"));

            let (graph, frames) = example2();
            let laid = lay(graph, frames);
            assert_translated(&laid, laid.input.block("security"));

            let (graph, frames) = notation_like();
            let laid = lay(graph, frames);
            assert_translated(&laid, laid.input.block("d"));
            assert_translated(&laid, laid.input.block("b"));

            let graph = nested();
            let frames = nested_frames(&graph);
            let laid = lay(graph, frames);
            assert_translated(&laid, laid.input.block("frontend"));
            assert_translated(&laid, laid.input.block("backend"));
        }

        #[test]
        fn layout_placement_same_box_is_laid_out_the_same_under_another_upper_sibling() {
            // 例 2 の security の箱の上の兄弟 3 を、子の列 (10、11、12) を持つ形に変えても、箱の中の相対位置は同じ
            let (graph, frames) = example2();
            let plain = lay(graph, frames);
            let graph = graph_of(
                12,
                &[
                    (1, 2),
                    (2, 3),
                    (2, 4),
                    (1, 5),
                    (1, 6),
                    (3, 10),
                    (3, 11),
                    (3, 12),
                    (1, 7),
                    (1, 8),
                    (1, 9),
                ],
                &[(2, 5), (5, 6)],
                &[5, 6],
            );
            let frames = frames_of(
                &graph,
                &["security"],
                &[(4, &["security"]), (5, &["security"])],
            );
            let busy = lay(graph, frames);
            let plain_gap = plain.at(5).x - plain.at(4).x;
            let busy_gap = busy.at(5).x - busy.at(4).x;
            assert_eq!(plain_gap.to_bits(), busy_gap.to_bits());
            assert_eq!(plain.at(4).y.to_bits(), busy.at(4).y.to_bits());
        }

        #[test]
        fn layout_placement_passes_sibling_pairs_as_slots() {
            // spacing の問い合わせは兄弟の組を Slot のまま渡す (B-7)。置き換えは呼び出し側 (layout_graph_framed) がする。
            // 例 1: copy の中の根どうし (Node(3), Node(4))。例 2: 外側の 3 と箱 (Node(3), Block(security))。
            // B-7 の入力: 箱と下の兄弟 (Block(ui), Node(5)) と、ui の中の根どうし (Node(3), Node(4))
            let graph = example1_graph();
            let frames = frames_of(&graph, &["copy"], &[(3, &["copy"]), (4, &["copy"])]);
            let laid = lay(graph, frames);
            assert_eq!(laid.calls, vec![(Slot::Node(3), Slot::Node(4))]);

            let (graph, frames) = example2();
            let laid = lay(graph, frames);
            let security = laid.input.block("security");
            // 手順は内側の箱から (設計の段 4 の手順)。中の木の組が先、外側の木の組があと
            assert_eq!(
                laid.calls,
                vec![
                    (Slot::Node(4), Slot::Node(5)),
                    (Slot::Node(3), Slot::Block(security))
                ]
            );

            let (graph, frames) = review_b_7();
            let laid = lay(graph, frames);
            let ui = laid.input.block("ui");
            assert_eq!(
                laid.calls,
                vec![
                    (Slot::Node(3), Slot::Node(4)),
                    (Slot::Block(ui), Slot::Node(5))
                ]
            );
        }

        #[test]
        fn layout_placement_spacing_error_stops_the_layout() {
            // spacing の誤りはそのまま返す (FlexTree::layout と同じく最初の Err で打ち切る)
            let (graph, frames) = review_b_7();
            let input = input(graph, frames);
            let result = input.run(&mut |_, _| {
                Err(LayoutError {
                    message: "stop".to_string(),
                })
            });
            match result {
                Err(error) => assert_eq!(error.message, "stop"),
                Ok(_) => panic!("誤りにならなかった"),
            }
        }

        // ノードの id を base + 1..=count にした graph_with (1 がルート)。tree と relations の id は 1 始まりで書き、ここで足す
        fn graph_with_ids(
            base: u32,
            count: u32,
            tree: &[(u32, u32)],
            relations: &[(RelationKind, u32, u32)],
            suppress: &[u32],
        ) -> VisibleGraph {
            project(&LayoutInput {
                name: "layout-placement".to_string(),
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

        #[test]
        fn layout_placement_accepts_ids_near_u32_max() {
            // notation_like の形で id を u32::MAX − 16 + 1..=u32::MAX にする (いちばん大きい id が u32::MAX)。
            // 試作は仮ノードの id を「いちばん大きい id の次」から振り、ここで誤りになった (context 3 章)。箱が 2 つ、出口が 2 つ
            use RelationKind::*;
            let base = u32::MAX - 16;
            let graph = graph_with_ids(
                base,
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
            assert_eq!(graph.nodes.last().map(|node| node.id), Some(u32::MAX));
            let entries: Vec<(u32, &[&str])> = (1..=16)
                .map(|id| {
                    let list: &[&str] = match id {
                        3..=5 => &["d"],
                        6..=13 => &["b"],
                        _ => &[],
                    };
                    (base + id, list)
                })
                .collect();
            let frames = frames_of(&graph, &["d", "b"], &entries);
            let laid = lay(graph, frames);
            assert_eq!(laid.input.blocks.blocks.len(), 2);
            assert_eq!(laid.input.tree.exits.len(), 2);
            assert_eq!(laid.placed.len(), 16);
        }

        #[test]
        fn layout_placement_deep_nesting_does_not_overflow_the_stack() {
            // 同じ 2 つのメンバー (3、4) の枠 2000 個は 1 本の鎖に入れ子になり、全部が箱 (段 1)。各箱の中の木の根は 1 つ内側の Block。
            // 5 は 3 の子でどの箱のメンバーでもないので、いちばん外側の箱の出口の子 (段 2)。wasm の既定と同じ 1 MiB のスタックで回す。
            // 3 と 4 はいちばん内側の箱の中の木 (3 → 4) にあり、1 つの子の鎖なので兄弟の方向の中心が同じ
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
                    let laid = lay(graph, frames);
                    (
                        laid.input.blocks.blocks.len(),
                        laid.placed.len(),
                        laid.at(3).x.to_bits() == laid.at(4).x.to_bits(),
                        laid.input.tree.exits.len(),
                    )
                })
                .unwrap()
                .join()
                .unwrap();
            assert_eq!(result, (count as usize, 9, true, 1));
        }

        #[test]
        fn layout_placement_deep_tree_does_not_overflow_the_stack() {
            // 深さ 20000 の 1 本の木 (1 → 2 → … → 20000)。f = {10, 11} (境界の入力として 12 はメンバーでない)。
            // 12 は f の出口の子で、その下に 20000 までの鎖が続く。1 MiB のスタックで溢れない。
            // どれも 1 つの子の鎖なので、兄弟の方向の中心は 0。ただし f の箱 (10 → 11) は大きさ 20 + 8 + 14 + 8 = 50 で中心 0、
            // 上端 -25 からラベルの行と top の 22 下がメンバーの上端 -3 なので、10 と 11 の中心は 7
            let length = 20_000u32;
            let result = std::thread::Builder::new()
                .stack_size(1 << 20)
                .spawn(move || {
                    let tree: Vec<(u32, u32)> = (1..length).map(|id| (id, id + 1)).collect();
                    let graph = graph_of(length, &tree, &[], &[]);
                    let frames = frames_of(&graph, &["f"], &[(10, &["f"]), (11, &["f"])]);
                    let laid = lay(graph, frames);
                    let mut off_center: Vec<(u32, f64)> = laid
                        .placed
                        .values()
                        .filter(|p| p.x != 0.0)
                        .map(|p| (p.id, p.x))
                        .collect();
                    off_center.sort_by_key(|&(id, _)| id);
                    (laid.placed.len(), off_center)
                })
                .unwrap()
                .join()
                .unwrap();
            assert_eq!(result.0, length as usize);
            assert_eq!(result.1, vec![(10, 7.0), (11, 7.0)]);
        }

        #[test]
        fn layout_placement_nested_boxes_keep_the_inner_box_inside_the_outer() {
            // nested-groups: dev (level 1) の中の木は 2 → [Block(frontend), Block(backend)]。
            // 内側の箱の中身 (メンバーの矩形) は、外側の箱の中身の外接の中にあり、外側の箱の範囲 (中身 ± 30、上はラベルの行も) は
            // 内側の箱の範囲 (中身 ± 8、上に 14) を含む。兄弟の方向だけを見る (深さの方向は段 3)
            let graph = nested();
            let frames = nested_frames(&graph);
            let laid = lay(graph, frames);
            let span = |members: &[u32]| {
                let top = members
                    .iter()
                    .map(|&m| laid.top(m))
                    .fold(f64::INFINITY, f64::min);
                let bottom = members
                    .iter()
                    .map(|&m| laid.bottom(m))
                    .fold(f64::NEG_INFINITY, f64::max);
                (top, bottom)
            };
            let (dev_top, dev_bottom) = span(&[2, 3, 4, 5, 6, 7, 8]);
            for inner in [&[3u32, 4, 5][..], &[6, 7, 8]] {
                let (top, bottom) = span(inner);
                assert!(dev_top - 30.0 - 14.0 <= top - 8.0 - 14.0 + 1e-9);
                assert!(bottom + 8.0 <= dev_bottom + 30.0 + 1e-9);
            }
            // frontend と backend の箱 (ラベルの行を含む) は重ならない: frontend の下端 + SPACING ≤ backend の上端
            let (_, frontend_bottom) = span(&[3, 4, 5]);
            let (backend_top, _) = span(&[6, 7, 8]);
            assert!(frontend_bottom + 8.0 + SPACING <= backend_top - 8.0 - 14.0 + 1e-9);
            // 9 (メンバーでない) は dev の箱の下
            assert!(dev_bottom + 30.0 + SPACING <= laid.top(9) + 1e-9);
        }

        #[test]
        fn layout_placement_same_members_nest_the_inner_box_at_the_root_of_the_outer() {
            // B-5 の入力 (nested-groups で a と b がどちらも {3, 4, 5}) と、同じメンバーで根が 2 つの箱 (1 の下に 2、3、4。a と b が {2, 3})。
            // a (level 1) の中の木の根は Block(b)。設計の段 4 の手順どおり、a の箱の兄弟の方向の大きさは、中身 (内側の箱 b の枠。
            // ラベルの行を含む) の外接 + top 30 + LABEL_HEIGHT + bottom 30。b の枠の下端は中身の下端 + 8 なので、
            // a の箱の下端は中身の下端 + 8 + 30 = + 38。
            // 枠の outline (frame_outline) は中身 ± 30 で内側の枠を含むので、箱はそれより下へ 8、上へ 22 広い。
            // 設計の文のとおりに求める (段 4 の実装で決めた)。
            // 3 の下の 4、5 は b の中の木で SPACING 離れ、6 (メンバーでない) は a の箱の下に SPACING 離れる
            let graph = nested();
            let all: &[&str] = &["a", "b"];
            let frames = frames_of(&graph, &["a", "b"], &[(3, all), (4, all), (5, all)]);
            let laid = lay(graph, frames);
            let a = laid.input.block("a");
            let b = laid.input.block("b");
            assert_eq!(laid.input.tree.inner[a].0, Slot::Block(b));
            assert_eq!(laid.bottom(4) + SPACING, laid.top(5));
            // 外側の木: 2 → [Block(a), 6]。6 の子 7 は箱の深さの範囲 (start 272 から) に入るので、箱と 7 の輪郭が比べられ、
            // a の下端 (5 の下端 + 38) + SPACING = 7 の上端。6 は子 7、8 の中点に置かれ、それより下
            assert_eq!(laid.bottom(5) + 38.0 + SPACING, laid.top(7));
            assert!(laid.top(6) > laid.top(7));

            let graph = graph_of(4, &[(1, 2), (1, 3), (1, 4)], &[], &[]);
            let frames = frames_of(&graph, &["a", "b"], &[(2, all), (3, all)]);
            let laid = lay(graph, frames);
            let a = laid.input.block("a");
            let b = laid.input.block("b");
            assert_eq!(laid.input.tree.inner[a].0, Slot::Block(b));
            assert!(matches!(laid.input.tree.inner[b].0, Slot::Joint(_)));
            assert_eq!(laid.bottom(2) + SPACING, laid.top(3));
            // 外側の木: 1 → [Block(a), 4]。a の下端 (3 の下端 + 8 + 30) + SPACING = 4 の上端
            assert_eq!(laid.bottom(3) + 38.0 + SPACING, laid.top(4));
        }
    }
}

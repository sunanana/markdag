// 枠を 1 つの矩形のまとまりとして配置する。メンバーが配置の木で閉じている枠 (frames.rs の frame_blocks) は、
// 先にまとまりの中だけで flextree を回し、メンバーの外接矩形に枠の余白とラベルの行を足した大きさの 1 つのノードとして、
// 外側の木に置く。外側の flextree はその矩形ごと兄弟を離すので、枠の矩形にメンバーでないノードや別の枠が入り込まない。
// まとまりは内側から順に作り、入れ子の枠は外側のまとまりの中で 1 つのノードになる。最後に外側から順にずらして、
// ノードごとの位置 (flextree の座標) に戻す。
// 深さの方向の位置は、どのノードも親の下端から決まる (配置の層が longest path で決めた隙間を大きさに入れてある) ので、
// まとまりの中で回しても外側の木と同じになる。兄弟の方向だけが、まとまりを単位に決まる。
use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexMap;

use crate::layout::flextree::{FlexTree, Placed};
use crate::layout::frames::{FrameBlock, LABEL_HEIGHT, frame_padding};
use crate::types::{LayoutError, Rect};

// まとまりの中の配置。local はまとまりの根を原点にした flextree の座標 (入れ子のまとまりは 1 つのノードのまま)
struct BlockLayout {
    local: Vec<Placed>,
    // 確保した矩形の上端 (兄弟の方向。ラベルの行を含む)
    reserved_top: f64,
}

// メンバーの外接矩形のうち、確保する大きさに使う端 (兄弟の方向の上下と、深さの方向の右)
#[derive(Clone, Copy)]
struct MemberBox {
    top: f64,
    bottom: f64,
    right: f64,
}

impl MemberBox {
    fn include(&mut self, other: MemberBox) {
        self.top = self.top.min(other.top);
        self.bottom = self.bottom.max(other.bottom);
        self.right = self.right.max(other.right);
    }
}

/// flextree と同じ配置を、blocks の枠をまとまりにして行う。返す順は、元の木 (children) を根から幅優先にたどった順
/// (FlexTree::layout と同じ)。blocks は内側から並べる (frame_blocks の順)。
/// rect_of は flextree の座標からノードの矩形を作る関数 (配置の層の変換)。spacing には実のノードの id だけを渡す
/// (まとまりのノードは、その最初の根の id で問い合わせる)
pub fn layout_with_blocks(
    root: u32,
    children: &IndexMap<u32, Vec<u32>>,
    node_size: &IndexMap<u32, [f64; 2]>,
    blocks: &[FrameBlock],
    rect_of: &dyn Fn(u32, &Placed) -> Rect,
    spacing: &mut dyn FnMut(u32, u32) -> Result<f64, LayoutError>,
) -> Result<Vec<Placed>, LayoutError> {
    // まとまりを表す仮の id は、実のノードの id のどれとも重ならないよう、いちばん大きい id の次から振る
    let mut last_id = std::iter::once(root)
        .chain(children.keys().copied())
        .chain(children.values().flatten().copied())
        .max()
        .unwrap_or(root);
    let mut fresh_id = || -> Result<u32, LayoutError> {
        last_id = last_id.checked_add(1).ok_or_else(|| LayoutError {
            message: "枠のまとまりに振る id が足りません".to_string(),
        })?;
        Ok(last_id)
    };

    let mut kids = children.clone();
    let mut sizes = node_size.clone();
    // 仮のノード → spacing に渡す実のノード
    let mut stand_in: HashMap<u32, u32> = HashMap::new();
    // まとまりの根 (実の id) → 今それを表しているノード。外側のまとまりに包まれるたびに付け替える
    let mut current: HashMap<u32, u32> = HashMap::new();
    let mut layouts: HashMap<u32, BlockLayout> = HashMap::new();
    let mut member_boxes: HashMap<u32, MemberBox> = HashMap::new();
    // 根が複数のまとまりで、根をまとめるために足した仮の根。位置に戻すときに捨てる
    let mut joints: HashSet<u32> = HashSet::new();
    let mut outer_root = root;

    for block in blocks {
        let mut run: Vec<u32> = Vec::new();
        for id in &block.roots {
            let id = current.get(id).copied().unwrap_or(*id);
            if run.last() != Some(&id) {
                run.push(id);
            }
        }
        let inner_root = match run.as_slice() {
            [single] => *single,
            _ => {
                let joint = fresh_id()?;
                kids.insert(joint, run.clone());
                sizes.insert(joint, [0.0, 0.0]);
                if let Some(&first) = block.roots.first() {
                    stand_in.insert(joint, first);
                }
                joints.insert(joint);
                joint
            }
        };
        let local = {
            let mut translated = |upper: u32, lower: u32| {
                let resolve = |id: u32| stand_in.get(&id).copied().unwrap_or(id);
                spacing(resolve(upper), resolve(lower))
            };
            FlexTree::layout(
                inner_root,
                &subtree_children(inner_root, &kids),
                &sizes,
                &mut translated,
            )?
        };

        let mut members: Option<MemberBox> = None;
        for placed in &local {
            let found = if let Some(inner) = member_boxes.get(&placed.id) {
                let reserved_top = layouts
                    .get(&placed.id)
                    .map_or(0.0, |layout| layout.reserved_top);
                let shift = placed.x - placed.x_size / 2.0 - reserved_top;
                MemberBox {
                    top: inner.top + shift,
                    bottom: inner.bottom + shift,
                    right: inner.right + placed.y,
                }
            } else if joints.contains(&placed.id) {
                continue;
            } else {
                let rect = rect_of(placed.id, placed);
                MemberBox {
                    top: rect.y,
                    bottom: rect.y + rect.height,
                    right: rect.x + rect.width,
                }
            };
            match members.as_mut() {
                Some(members) => members.include(found),
                None => members = Some(found),
            }
        }
        let Some(members) = members else {
            continue;
        };
        let padding = frame_padding(block.level);
        let reserved_top = members.top - padding.top - LABEL_HEIGHT;
        let reserved_bottom = members.bottom + padding.bottom;
        let id = fresh_id()?;
        match block.parent {
            Some(parent) => {
                let list = kids.get_mut(&parent).ok_or_else(|| block_error(parent))?;
                let start = run
                    .first()
                    .and_then(|first| list.iter().position(|child| child == first))
                    .ok_or_else(|| block_error(parent))?;
                if list.get(start..start + run.len()) != Some(run.as_slice()) {
                    return Err(block_error(parent));
                }
                list.splice(start..start + run.len(), [id]);
            }
            None => outer_root = id,
        }
        sizes.insert(
            id,
            [
                reserved_bottom - reserved_top,
                (members.right + padding.side).max(0.0),
            ],
        );
        if let Some(&first) = block.roots.first() {
            stand_in.insert(id, first);
        }
        for root in &block.roots {
            current.insert(*root, id);
        }
        layouts.insert(
            id,
            BlockLayout {
                local,
                reserved_top,
            },
        );
        member_boxes.insert(id, members);
    }

    let outer = {
        let mut translated = |upper: u32, lower: u32| {
            let resolve = |id: u32| stand_in.get(&id).copied().unwrap_or(id);
            spacing(resolve(upper), resolve(lower))
        };
        FlexTree::layout(
            outer_root,
            &subtree_children(outer_root, &kids),
            &sizes,
            &mut translated,
        )?
    };

    // 外側から順に、まとまりの中の配置をまとまりの位置までずらす (入れ子の深さでスタックを使わない)
    let mut placed_of: HashMap<u32, Placed> = HashMap::new();
    let mut pending: Vec<(Vec<Placed>, f64, f64)> = vec![(outer, 0.0, 0.0)];
    while let Some((list, across, along)) = pending.pop() {
        for placed in list {
            if let Some(layout) = layouts.remove(&placed.id) {
                let shift = across + placed.x - placed.x_size / 2.0 - layout.reserved_top;
                pending.push((layout.local, shift, along + placed.y));
            } else if !joints.contains(&placed.id) {
                placed_of.insert(
                    placed.id,
                    Placed {
                        x: placed.x + across,
                        y: placed.y + along,
                        ..placed
                    },
                );
            }
        }
    }
    let mut ordered = Vec::with_capacity(placed_of.len());
    let mut queue = VecDeque::from([root]);
    while let Some(id) = queue.pop_front() {
        if let Some(placed) = placed_of.remove(&id) {
            ordered.push(placed);
        }
        queue.extend(children.get(&id).map(Vec::as_slice).unwrap_or(&[]));
    }
    Ok(ordered)
}

// まとまりの根が、親の子の並びで縦に隣り合っていない (frame_blocks が確かめてあるので届かない)
// TODO(port): 不到達 (frame_blocks が親と並びを確かめたまとまりだけを受ける)
fn block_error(parent: u32) -> LayoutError {
    LayoutError {
        message: format!("枠のまとまりの根が、ノード {parent} の子の並びに見つかりません"),
    }
}

// root から届く部分だけの子の表。まとまりごとに flextree を回すので、表全体を渡すと閉路の確かめが全体を読んでしまう。
// 閉路のある表 (壊れた入力) でも終わるよう、同じノードは 1 度だけ開く。閉路の辺は表に残るので、flextree が誤りにする
fn subtree_children(root: u32, kids: &IndexMap<u32, Vec<u32>>) -> IndexMap<u32, Vec<u32>> {
    let mut table = IndexMap::new();
    let mut pending = vec![root];
    while let Some(id) = pending.pop() {
        if table.contains_key(&id) {
            continue;
        }
        let list = kids.get(&id).cloned().unwrap_or_default();
        pending.extend(list.iter().copied());
        table.insert(id, list);
    }
    table
}

// 原文: node_modules/d3-flextree/src/flextree.js (d3-flextree 2.1.2、WTFPL。2026-09-24)
// 大きさの違うノードを重ならないように並べる木の配置 (d3-flextree の移植)。
// 縦型で、x は兄弟の方向 (ノードの中心)、y は深さの方向 (ノードの上端)。横型への入れ替えは配置の層が行う。
// 原文の閉包の設定 (children / nodeSize / spacing) は、子の表・大きさの表・間隔の関数で受ける (規則 2.6、A-019)。
// 参照でつないだ木 (lExt / rExt / lThr / rThr) と lows の連結リストは arena の Vec と添字で持つ (規則 2.6、A-013)。
// 原文のうち配置に効かない部分 (hierarchy の height / length、extents、copy、dump、設定の setter) は写さない (台帳 3、5 行、A-155)。
// extents / maxExtents と height / length / depth は配置の計算も layout.ts も読まないので、写すと dead_code になる。
use std::collections::{HashSet, VecDeque};

use indexmap::IndexMap;

use crate::types::LayoutError;

/// 配置を終えたノード 1 つ。原文の layout(tree) のあとの FlexNode の data / x / y / xSize / ySize。
/// 同じ id が木の 2 か所に現れれば 2 つ出る (原文もノードを別々に作る)
#[derive(Debug, Clone, PartialEq)]
pub struct Placed {
    pub id: u32,
    /// 兄弟の方向の中心
    pub x: f64,
    /// 深さの方向の上端
    pub y: f64,
    pub x_size: f64,
    pub y_size: f64,
}

// 原文の wrapper のクラス (getWrapper) の 1 ノード。欄の初期値は原文の constructor (95-100) と同じ
struct FlexNode {
    id: u32,
    x_size: f64,
    y_size: f64,
    // 空なら原文の children === null (原文は null と [] を同じに扱う)
    children: Vec<usize>,
    x: f64,
    y: f64,
    rel_x: f64,
    prelim: f64,
    shift: f64,
    change: f64,
    l_ext: usize,
    l_ext_rel_x: f64,
    l_thr: Option<usize>,
    r_ext: usize,
    r_ext_rel_x: f64,
    r_thr: Option<usize>,
}

// lows の連結リストの 1 要素 (updateLows が作る { lowY, index, next })。next は同じ呼び出しの Vec の添字
struct Low {
    low_y: f64,
    index: usize,
    next: Option<usize>,
}

/// 配置の計算に使う木 (arena)。原文の FlexNode の木を添字でつないだもの
pub struct FlexTree {
    nodes: Vec<FlexNode>,
}

impl FlexTree {
    /// 原文: flextree({ children, nodeSize, spacing }) で作った layout を layout.hierarchy(root) に当て、tree.each で読む流れ。
    /// children に無い id は子なし (`?? []`)、node_size に無い id は [0, 0] (`?? [0, 0]`) として扱う (layout.ts:108-109)。
    /// spacing は (左の輪郭のノード, 右の輪郭のノード) の id を受け、最初の Err で計算を打ち切って返す (A-019)。
    /// 返す順は d3-hierarchy の each の幅優先 (A-012)
    pub fn layout(
        root: u32,
        children: &IndexMap<u32, Vec<u32>>,
        node_size: &IndexMap<u32, [f64; 2]>,
        spacing: &mut dyn FnMut(u32, u32) -> Result<f64, LayoutError>,
    ) -> Result<Vec<Placed>, LayoutError> {
        // 子の表に閉路があると wrap が終わらないので、先に反復で確かめる。
        // wrap、layout_children、resolve_x は明示のスタックでたどるので、木の深さに上限はない (A-105 (a))
        check_acyclic(root, children)?;
        let mut tree = FlexTree { nodes: Vec::new() };
        let root_index = wrap(&mut tree, root, children, node_size)?;
        // 原文の update(): layoutChildren(this); resolveX(this)
        layout_children(&mut tree, root_index, 0.0, spacing)?;
        resolve_x(&mut tree, root_index)?;
        tree.each(root_index)
    }

    // arena_error を返す箇所 (at、at_mut、child、low_at、update_lows の get) は、どれも A-031 の Rust 側の不到達。
    // 添字はすべて wrap か update_lows が作ったもので、範囲外にならない
    // TODO(port): Rust 側の不到達 (arena の添字の範囲外)
    fn at(&self, index: usize) -> Result<&FlexNode, LayoutError> {
        self.nodes.get(index).ok_or_else(arena_error)
    }

    // TODO(port): Rust 側の不到達 (arena の添字の範囲外)
    fn at_mut(&mut self, index: usize) -> Result<&mut FlexNode, LayoutError> {
        self.nodes.get_mut(index).ok_or_else(arena_error)
    }

    // 原文の w.children[i]
    // TODO(port): Rust 側の不到達 (i は原文の子の添字で、子の数より小さい)
    fn child(&self, w: usize, i: usize) -> Result<usize, LayoutError> {
        self.at(w)?.children.get(i).copied().ok_or_else(arena_error)
    }

    // 原文の get bottom() { return this.y + this.ySize; }
    fn bottom(&self, index: usize) -> Result<f64, LayoutError> {
        let node = self.at(index)?;
        Ok(node.y + node.y_size)
    }

    // 原文の tree.each (d3-hierarchy 1.1.9 の each.js)。深さごとに、各段は子の順
    fn each(&self, root: usize) -> Result<Vec<Placed>, LayoutError> {
        let mut placed = Vec::with_capacity(self.nodes.len());
        let mut queue = VecDeque::from([root]);
        while let Some(index) = queue.pop_front() {
            let node = self.at(index)?;
            placed.push(Placed {
                id: node.id,
                x: node.x,
                y: node.y,
                x_size: node.x_size,
                y_size: node.y_size,
            });
            queue.extend(node.children.iter().copied());
        }
        Ok(placed)
    }
}

// 子の表を根からたどって閉路がないかを確かめる。閉路のない道は同じ id を 2 度通らないので、深さ (根が 1) は現れる id の数を
// 越えない。越えたら閉路があるので誤りにする (閉路があると wrap が終わらない)。幅優先の反復なので、深い木でもスタックを使わない。
// TODO(port): 原文では到達しない (配置上の親は project が木にして渡す。原文の d3-hierarchy は閉路で再帰が終わらない)
fn check_acyclic(root: u32, children: &IndexMap<u32, Vec<u32>>) -> Result<(), LayoutError> {
    let ids: HashSet<u32> = std::iter::once(root)
        .chain(children.keys().copied())
        .chain(children.values().flatten().copied())
        .collect();
    let mut level = vec![root];
    for _ in 0..ids.len() {
        level = level
            .iter()
            .flat_map(|id| children.get(id).map(Vec::as_slice).unwrap_or(&[]))
            .copied()
            .collect();
        if level.is_empty() {
            return Ok(());
        }
    }
    Err(LayoutError {
        message: "配置の木に閉路があります (配置上の親をたどると元のノードに戻ります)".to_string(),
    })
}

fn arena_error() -> LayoutError {
    LayoutError {
        message: "flextree: arena の添字が範囲外".to_string(),
    }
}

// 原文の TypeError (separate の 234 と 246 で lows が null のあと lows.lowY / lows.index を読む)。
// 文面は V8 の TypeError のまま。境界の包みは Error で投げるので型だけ変わる (規則 2.6、A-154)
fn null_lows_error(property: &str) -> LayoutError {
    LayoutError {
        message: format!("Cannot read properties of null (reading '{property}')"),
    }
}

// 原文: wrap (116-139)。先行順に arena へ積む。depth / height / length は配置に効かないので持たない (A-155)。
// 原文の再帰は明示のスタックにした (A-105 (a)。木の深さでスタックを使わない)。子は逆順に積んで取り出すので、arena の添字は
// 原文と同じ先行順になり、親の children も子の順に並ぶ
fn wrap(
    tree: &mut FlexTree,
    root: u32,
    children: &IndexMap<u32, Vec<u32>>,
    node_size: &IndexMap<u32, [f64; 2]>,
) -> Result<usize, LayoutError> {
    let mut pending: Vec<(u32, Option<usize>)> = vec![(root, None)];
    while let Some((id, parent)) = pending.pop() {
        let index = tree.nodes.len();
        let [x_size, y_size] = node_size.get(&id).copied().unwrap_or([0.0, 0.0]);
        tree.nodes.push(FlexNode {
            id,
            x_size,
            y_size,
            children: Vec::new(),
            x: 0.0,
            y: 0.0,
            rel_x: 0.0,
            prelim: 0.0,
            shift: 0.0,
            change: 0.0,
            l_ext: index,
            l_ext_rel_x: 0.0,
            l_thr: None,
            r_ext: index,
            r_ext_rel_x: 0.0,
            r_thr: None,
        });
        if let Some(parent) = parent {
            tree.at_mut(parent)?.children.push(index);
        }
        let kids_data = children.get(&id).map(Vec::as_slice).unwrap_or(&[]);
        pending.extend(kids_data.iter().rev().map(|&kid| (kid, Some(index))));
    }
    // 根は最初に積んだ添字 0
    Ok(0)
}

// layout_children の明示のスタックの 1 段 (原文の layoutChildren の 1 回の呼び出しの局所変数)
struct Visit {
    w: usize,
    kids: Vec<usize>,
    // 次に配置する子の添字 (原文の reduce の i)
    next: usize,
    lows: Vec<Low>,
    last_lows: Option<usize>,
    // 原文の w.children[i - 1]。i == 0 のときだけ None
    l_sib: Option<usize>,
}

// 原文の layoutChildren の入口 (w.y = y と子の一覧)
fn enter(tree: &mut FlexTree, w: usize, y: f64) -> Result<Visit, LayoutError> {
    let node = tree.at_mut(w)?;
    node.y = y;
    Ok(Visit {
        w,
        kids: node.children.clone(),
        next: 0,
        lows: Vec::new(),
        last_lows: None,
        l_sib: None,
    })
}

// 原文: layoutChildren (175-190)。reduce の [i, lastLows] は Visit の next と last_lows で持つ。
// 原文の再帰は明示のスタックにした (A-105 (a))。子の部分木を配置し終えてから separate と updateLows を行う順と、
// spacing を呼ぶ順は原文と同じ
fn layout_children(
    tree: &mut FlexTree,
    root: usize,
    y: f64,
    spacing: &mut dyn FnMut(u32, u32) -> Result<f64, LayoutError>,
) -> Result<(), LayoutError> {
    let mut stack = vec![enter(tree, root, y)?];
    while let Some(top) = stack.last() {
        if let Some(&kid) = top.kids.get(top.next) {
            let kid_y = tree.bottom(top.w)?;
            let visit = enter(tree, kid, kid_y)?;
            stack.push(visit);
            continue;
        }
        let Some(done) = stack.pop() else {
            break;
        };
        shift_change(tree, done.w)?;
        position_root(tree, done.w)?;
        if let Some(parent) = stack.last_mut() {
            after_child(tree, parent, done.w, spacing)?;
        }
    }
    Ok(())
}

// 原文の layoutChildren の reduce の本体のうち、子の部分木を配置したあとの部分
fn after_child(
    tree: &mut FlexTree,
    parent: &mut Visit,
    kid: usize,
    spacing: &mut dyn FnMut(u32, u32) -> Result<f64, LayoutError>,
) -> Result<(), LayoutError> {
    let i = parent.next;
    // 現在の部分木を極端のノードがまだ指している間の、最も低い縦の座標
    let extreme = {
        let node = tree.at(kid)?;
        if i == 0 { node.l_ext } else { node.r_ext }
    };
    let low_y = tree.bottom(extreme)?;
    if let Some(l_sib) = parent.l_sib {
        separate(
            tree,
            parent.w,
            i,
            l_sib,
            &parent.lows,
            parent.last_lows,
            spacing,
        )?;
    }
    parent.last_lows = Some(update_lows(&mut parent.lows, low_y, i, parent.last_lows)?);
    parent.l_sib = Some(kid);
    parent.next += 1;
    Ok(())
}

// 原文: resolveX (196-209)。prev_sum が None なら根 (原文の typeof prevSum === 'undefined')。
// 原文の再帰は明示のスタックにした (A-105 (a))。各ノードは親の値だけで決まるので、たどる順は結果に効かない
fn resolve_x(tree: &mut FlexTree, root: usize) -> Result<(), LayoutError> {
    let mut pending: Vec<(usize, Option<f64>, f64)> = vec![(root, None, 0.0)];
    while let Some((w, prev_sum, parent_x)) = pending.pop() {
        let node = tree.at_mut(w)?;
        let (prev_sum, parent_x) = match prev_sum {
            Some(prev_sum) => (prev_sum, parent_x),
            None => (-node.rel_x - node.prelim, 0.0),
        };
        let sum = prev_sum + node.rel_x;
        node.rel_x = sum + node.prelim - parent_x;
        node.prelim = 0.0;
        node.x = parent_x + node.rel_x;
        let x = node.x;
        pending.extend(node.children.iter().rev().map(|&kid| (kid, Some(sum), x)));
    }
    Ok(())
}

// 原文: shiftChange (213-221)
fn shift_change(tree: &mut FlexTree, w: usize) -> Result<(), LayoutError> {
    let kids = tree.at(w)?.children.clone();
    let mut last_shift_sum = 0.0;
    let mut last_change_sum = 0.0;
    for kid in kids {
        let child = tree.at_mut(kid)?;
        let shift_sum = last_shift_sum + child.shift;
        let change_sum = last_change_sum + shift_sum + child.change;
        child.rel_x += change_sum;
        last_shift_sum = shift_sum;
        last_change_sum = change_sum;
    }
    Ok(())
}

// 原文: separate (225-266)。最新の子 (i 番目) を左の兄弟たちから離す。
// lows は呼び出し側の Vec と先頭の添字で受け、この関数の中の付け替えは呼び出し側に返らない (原文の引数と同じ)。
// 原文の w.children[i - 1] は、呼び出し側が l_sib として渡す (添字の引き算をしない)
fn separate(
    tree: &mut FlexTree,
    w: usize,
    i: usize,
    l_sib: usize,
    lows_list: &[Low],
    mut lows: Option<usize>,
    spacing: &mut dyn FnMut(u32, u32) -> Result<f64, LayoutError>,
) -> Result<(), LayoutError> {
    let cur_subtree = tree.child(w, i)?;
    let mut r_contour = Some(l_sib);
    let mut r_sum_mods = tree.at(l_sib)?.rel_x;
    let mut l_contour = Some(cur_subtree);
    let mut l_sum_mods = tree.at(cur_subtree)?.rel_x;
    let mut is_first = true;
    // 輪郭のノードの bottom (y + ySize) が NaN だと (ySize が NaN のノードがあるなど)、下の <= と >= が
    // どちらも偽で輪郭が進まず、この while が終わらない (原文も同じで、while は原文どおりに写す)。境界からは届かない:
    // 配置の入口で NaN、無限大、絶対値が上限を越える大きさを誤りにする (規則 4 章、A-156 (b)。accepted.md 28)
    while let (Some(r), Some(l)) = (r_contour, l_contour) {
        let head = low_at(lows_list, lows, "lowY")?;
        if tree.bottom(r)? > head.low_y {
            lows = head.next;
        }
        // rContour の右端から lContour の左端までの距離: 中心どうしの距離に spacing を足す
        let (r_id, r_prelim, r_x_size) = {
            let node = tree.at(r)?;
            (node.id, node.prelim, node.x_size)
        };
        let (l_id, l_prelim, l_x_size) = {
            let node = tree.at(l)?;
            (node.id, node.prelim, node.x_size)
        };
        let dist = (r_sum_mods + r_prelim) - (l_sum_mods + l_prelim)
            + r_x_size / 2.0
            + l_x_size / 2.0
            + spacing(r_id, l_id)?;
        if dist > 0.0 || (dist < 0.0 && is_first) {
            l_sum_mods += dist;
            move_subtree(tree, cur_subtree, dist)?;
            let left_sib_i = low_at(lows_list, lows, "index")?.index;
            distribute_extra(tree, w, i, cur_subtree, left_sib_i, dist)?;
        }
        is_first = false;
        // 高い方のノード (と修飾の和) を進める
        let right_bottom = tree.bottom(r)?;
        let left_bottom = tree.bottom(l)?;
        if right_bottom <= left_bottom {
            r_contour = next_r_contour(tree, r)?;
            if let Some(next) = r_contour {
                r_sum_mods += tree.at(next)?.rel_x;
            }
        }
        if right_bottom >= left_bottom {
            l_contour = next_l_contour(tree, l)?;
            if let Some(next) = l_contour {
                l_sum_mods += tree.at(next)?.rel_x;
            }
        }
    }
    // 糸を張り、極端のノードを更新する。前者は現在の部分木が左の兄弟たちより深い場合、後者はその逆
    match (r_contour, l_contour) {
        (None, Some(l)) => set_l_thr(tree, w, cur_subtree, l, l_sum_mods),
        (Some(r), None) => set_r_thr(tree, l_sib, cur_subtree, r, r_sum_mods),
        _ => Ok(()),
    }
}

// lows (null になりうる) の先頭を読む。null なら原文の TypeError
fn low_at<'a>(
    lows_list: &'a [Low],
    lows: Option<usize>,
    property: &str,
) -> Result<&'a Low, LayoutError> {
    let index = lows.ok_or_else(|| null_lows_error(property))?;
    // TODO(port): Rust 側の不到達 (index は update_lows が作った添字)
    lows_list.get(index).ok_or_else(arena_error)
}

// 原文: moveSubtree (270-274)
fn move_subtree(tree: &mut FlexTree, subtree: usize, distance: f64) -> Result<(), LayoutError> {
    let node = tree.at_mut(subtree)?;
    node.rel_x += distance;
    node.l_ext_rel_x += distance;
    node.r_ext_rel_x += distance;
    Ok(())
}

// 原文: distributeExtra (276-286)。n は JS の数の引き算なので f64 で行う (規則 2.1: 符号なしで引かない)
// 原文の w.children[curSubtreeI] は、呼び出し側が cur_subtree として渡す
fn distribute_extra(
    tree: &mut FlexTree,
    w: usize,
    cur_subtree_i: usize,
    cur_subtree: usize,
    left_sib_i: usize,
    dist: f64,
) -> Result<(), LayoutError> {
    let n = cur_subtree_i as f64 - left_sib_i as f64;
    // 間に子があるか
    if n > 1.0 {
        let delta = dist / n;
        let intermediate = tree.child(w, left_sib_i + 1)?;
        tree.at_mut(intermediate)?.shift += delta;
        let node = tree.at_mut(cur_subtree)?;
        node.shift -= delta;
        node.change -= dist - delta;
    }
    Ok(())
}

// 原文: nextLContour (288-290)
fn next_l_contour(tree: &FlexTree, w: usize) -> Result<Option<usize>, LayoutError> {
    let node = tree.at(w)?;
    Ok(match node.children.first() {
        Some(&first) => Some(first),
        None => node.l_thr,
    })
}

// 原文: nextRContour (292-294)
fn next_r_contour(tree: &FlexTree, w: usize) -> Result<Option<usize>, LayoutError> {
    let node = tree.at(w)?;
    Ok(match node.children.last() {
        Some(&last) => Some(last),
        None => node.r_thr,
    })
}

// 原文: setLThr (296-309)。原文の w.children[i] は、呼び出し側が cur_subtree として渡す
fn set_l_thr(
    tree: &mut FlexTree,
    w: usize,
    cur_subtree: usize,
    l_contour: usize,
    l_sum_mods: f64,
) -> Result<(), LayoutError> {
    let first_child = tree.child(w, 0)?;
    let l_ext = tree.at(first_child)?.l_ext;
    tree.at_mut(l_ext)?.l_thr = Some(l_contour);
    // 糸をたどったあとの修飾の和が正しくなるように relX を変える
    let diff = l_sum_mods - tree.at(l_contour)?.rel_x - tree.at(first_child)?.l_ext_rel_x;
    let node = tree.at_mut(l_ext)?;
    node.rel_x += diff;
    // ノードが動かないように仮の x を変える
    node.prelim -= diff;
    // 極端のノードとその修飾の和を更新する
    let (cur_l_ext, cur_l_ext_rel_x) = {
        let cur = tree.at(cur_subtree)?;
        (cur.l_ext, cur.l_ext_rel_x)
    };
    let first = tree.at_mut(first_child)?;
    first.l_ext = cur_l_ext;
    first.l_ext_rel_x = cur_l_ext_rel_x;
    Ok(())
}

// 原文: setRThr (312-322)。setLThr の鏡像。原文の w.children[i - 1] と w.children[i] は、呼び出し側が l_sib と cur_subtree として渡す
fn set_r_thr(
    tree: &mut FlexTree,
    l_sib: usize,
    cur_subtree: usize,
    r_contour: usize,
    r_sum_mods: f64,
) -> Result<(), LayoutError> {
    let r_ext = tree.at(cur_subtree)?.r_ext;
    tree.at_mut(r_ext)?.r_thr = Some(r_contour);
    let diff = r_sum_mods - tree.at(r_contour)?.rel_x - tree.at(cur_subtree)?.r_ext_rel_x;
    let node = tree.at_mut(r_ext)?;
    node.rel_x += diff;
    node.prelim -= diff;
    let (sib_r_ext, sib_r_ext_rel_x) = {
        let sib = tree.at(l_sib)?;
        (sib.r_ext, sib.r_ext_rel_x)
    };
    let cur = tree.at_mut(cur_subtree)?;
    cur.r_ext = sib_r_ext;
    cur.r_ext_rel_x = sib_r_ext_rel_x;
    Ok(())
}

// 原文: positionRoot (325-337)。子の修飾を考えて根を子の間に置く
fn position_root(tree: &mut FlexTree, w: usize) -> Result<(), LayoutError> {
    let (first, last) = {
        let node = tree.at(w)?;
        match (node.children.first(), node.children.last()) {
            (Some(&first), Some(&last)) => (first, last),
            _ => return Ok(()),
        }
    };
    let k0 = tree.at(first)?;
    let kf = tree.at(last)?;
    let prelim =
        (k0.prelim + k0.rel_x - k0.x_size / 2.0 + kf.rel_x + kf.prelim + kf.x_size / 2.0) / 2.0;
    let (l_ext, l_ext_rel_x, r_ext, r_ext_rel_x) =
        (k0.l_ext, k0.l_ext_rel_x, kf.r_ext, kf.r_ext_rel_x);
    let node = tree.at_mut(w)?;
    node.prelim = prelim;
    node.l_ext = l_ext;
    node.l_ext_rel_x = l_ext_rel_x;
    node.r_ext = r_ext;
    node.r_ext_rel_x = r_ext_rel_x;
    Ok(())
}

// 原文: updateLows (341-351)。新しい部分木に隠れる兄弟を外し、先頭に足す。足した要素の添字を返す
fn update_lows(
    lows: &mut Vec<Low>,
    low_y: f64,
    index: usize,
    mut last_lows: Option<usize>,
) -> Result<usize, LayoutError> {
    while let Some(last) = last_lows {
        // TODO(port): Rust 側の不到達 (last は前の呼び出しが返した添字)
        let low = lows.get(last).ok_or_else(arena_error)?;
        if low_y >= low.low_y {
            last_lows = low.next;
        } else {
            break;
        }
    }
    let added = lows.len();
    lows.push(Low {
        low_y,
        index,
        next: last_lows,
    });
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        root: u32,
        children: &[(u32, &[u32])],
        sizes: &[(u32, [f64; 2])],
        spacing: f64,
    ) -> Result<Vec<Placed>, LayoutError> {
        let children: IndexMap<u32, Vec<u32>> = children
            .iter()
            .map(|(id, kids)| (*id, kids.to_vec()))
            .collect();
        let sizes: IndexMap<u32, [f64; 2]> = sizes.iter().copied().collect();
        FlexTree::layout(root, &children, &sizes, &mut |_, _| Ok(spacing))
    }

    fn coords(placed: &[Placed]) -> Vec<(u32, f64, f64)> {
        placed.iter().map(|p| (p.id, p.x, p.y)).collect()
    }

    #[test]
    fn flextree_single_node_is_at_origin() {
        let placed = run(1, &[], &[(1, [10.0, 20.0])], 0.0).unwrap();
        assert_eq!(
            placed,
            vec![Placed {
                id: 1,
                x: 0.0,
                y: 0.0,
                x_size: 10.0,
                y_size: 20.0
            }]
        );
    }

    #[test]
    fn flextree_missing_size_is_zero() {
        // nodeSize.get(id) ?? [0, 0] (layout.ts:109)
        let placed = run(1, &[(1, &[2])], &[(1, [10.0, 20.0])], 0.0).unwrap();
        assert_eq!(
            placed[1],
            Placed {
                id: 2,
                x: 0.0,
                y: 20.0,
                x_size: 0.0,
                y_size: 0.0
            }
        );
    }

    #[test]
    fn flextree_two_children_are_centered_under_parent() {
        let placed = run(
            1,
            &[(1, &[2, 3])],
            &[(1, [10.0, 20.0]), (2, [10.0, 20.0]), (3, [30.0, 20.0])],
            5.0,
        )
        .unwrap();
        // 中心の距離は 10/2 + 30/2 + 5 = 25。根は k0 の左端 (-5) と kf の右端 (25 + 15) の中点 17.5 に置かれ、0 に戻される
        assert_eq!(
            coords(&placed),
            vec![(1, 0.0, 0.0), (2, -17.5, 20.0), (3, 7.5, 20.0)]
        );
    }

    #[test]
    fn flextree_each_is_breadth_first() {
        // d3-hierarchy の each は幅優先 (A-012): 1, 2, 3, 4, 5
        let placed = run(1, &[(1, &[2, 3]), (2, &[4]), (3, &[5])], &[], 0.0).unwrap();
        let ids: Vec<u32> = placed.iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn flextree_spacing_receives_contour_ids_and_error_stops() {
        let children: IndexMap<u32, Vec<u32>> = [(1, vec![2, 3, 4])].into_iter().collect();
        let sizes: IndexMap<u32, [f64; 2]> = IndexMap::new();
        let mut calls = Vec::new();
        let result = FlexTree::layout(1, &children, &sizes, &mut |a, b| {
            calls.push((a, b));
            if b == 3 {
                Err(LayoutError {
                    message: "stop".to_string(),
                })
            } else {
                Ok(1.0)
            }
        });
        assert_eq!(
            result,
            Err(LayoutError {
                message: "stop".to_string()
            })
        );
        // 最初の Err で打ち切り、4 との間は呼ばない
        assert_eq!(calls, vec![(2, 3)]);
    }

    #[test]
    fn flextree_update_lows_drops_hidden_siblings() {
        let mut lows = Vec::new();
        let a = update_lows(&mut lows, 10.0, 0, None).unwrap();
        let b = update_lows(&mut lows, 5.0, 1, Some(a)).unwrap();
        // 5 は 10 より高いので 0 を隠さない
        assert_eq!(lows[b].next, Some(a));
        // 20 は両方を隠す
        let c = update_lows(&mut lows, 20.0, 2, Some(b)).unwrap();
        assert_eq!(lows[c].next, None);
        assert_eq!(lows[c].index, 2);
    }

    #[test]
    fn flextree_cycle_in_children_is_an_error() {
        let error = run(1, &[(1, &[2]), (2, &[3]), (3, &[2])], &[], 0.0).unwrap_err();
        assert_eq!(
            error.message,
            "配置の木に閉路があります (配置上の親をたどると元のノードに戻ります)"
        );
    }

    #[test]
    fn flextree_shared_child_is_placed_twice() {
        // 閉路でない同じ id の再出は、原文と同じく 2 つ置く
        let placed = run(1, &[(1, &[2, 3]), (2, &[4]), (3, &[4])], &[], 0.0).unwrap();
        assert_eq!(placed.iter().filter(|p| p.id == 4).count(), 2);
    }
}

// PORT STATUS: confidence=high todos=6

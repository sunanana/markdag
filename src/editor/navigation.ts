// 矢印キーで選ぶノードを決める (DOM を使わない)。木の形 (親) と、画面に見えているノードの矩形だけで決める。
// ← は親、→ は見えている子のうち画面でいちばん上のもの、↑ ↓ は同じ親の見えている子を画面の上下の順に並べた前と後 (端では反対の端へ回る)。
// 何も選んでいないときは、カーソルにいちばん近い見えているノード (カーソルがウィンドウの外ならルート) を選ぶ。
// 閉じた枝を開くこと、見える所まで図を動かすこと、複数の選択のどのノードから動くかは呼ぶ側が受け持つ (枝を開いたあとは、動き終えたあとの矩形を渡す)
import type { OutlineNode, Rect } from '../core';

// KeyboardEvent の key と同じ名前
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
// 木の形は parent だけで受け取る。子と兄弟の文書の順は配列の順
export type NavigationNode = Pick<OutlineNode, 'id' | 'parent'>;
export interface Point {
    x: number;
    y: number;
}

// parent の子のうち rects にあるもの (見えているもの) を、画面の上から並べる (上の辺、同じ高さなら左の辺で比べる)
function childrenOnScreen(parent: number | null, nodes: readonly NavigationNode[], rects: ReadonlyMap<number, Rect>): number[] {
    const shown = nodes.flatMap((node) => {
        const rect = node.parent === parent ? rects.get(node.id) : undefined;
        return rect ? [{ id: node.id, rect }] : [];
    });
    return shown.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((item) => item.id);
}

// 点から箱までの距離 (箱の中なら 0) と、箱の中心までの距離
function distances(point: Point, rect: Rect): [number, number] {
    const toBox = Math.hypot(Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width)), Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height)));
    const toCenter = Math.hypot(point.x - (rect.x + rect.width / 2), point.y - (rect.y + rect.height / 2));
    return [toBox, toCenter];
}

// 選んでいるノード from から移る先。rects は見えているノードの矩形 (図の領域の左上からの画面の座標)。移る先がなければ null
export function arrowTarget(key: ArrowKey, from: number, nodes: readonly NavigationNode[], rects: ReadonlyMap<number, Rect>): number | null {
    const node = nodes.find((item) => item.id === from);
    if (!node) return null;
    if (key === 'ArrowLeft') return node.parent;
    if (key === 'ArrowRight') return childrenOnScreen(from, nodes, rects)[0] ?? null;
    const siblings = childrenOnScreen(node.parent, nodes, rects);
    const index = siblings.indexOf(from);
    if (index < 0 || siblings.length < 2) return null;
    const step = key === 'ArrowDown' ? 1 : -1;
    return siblings[(index + step + siblings.length) % siblings.length] ?? null;
}

// 何も選んでいないときに矢印キーで選ぶノード。pointer はカーソルの位置 (rects と同じ座標) で、ウィンドウの外なら null。
// カーソルがウィンドウの外か、見えているノードがなければルート
export function startNode(pointer: Point | null, nodes: readonly NavigationNode[], rects: ReadonlyMap<number, Rect>): number | null {
    const root = nodes.find((node) => node.parent === null)?.id ?? null;
    if (pointer === null) return root;
    let best: { id: number; toBox: number; toCenter: number } | null = null;
    for (const node of nodes) {
        const rect = rects.get(node.id);
        if (!rect) continue;
        const [toBox, toCenter] = distances(pointer, rect);
        // 箱までの距離で比べ、同じ (どちらの箱の中にもある) なら中心までの距離で比べる
        if (!best || toBox < best.toBox || (toBox === best.toBox && toCenter < best.toCenter)) best = { id: node.id, toBox, toCenter };
    }
    return best?.id ?? root;
}

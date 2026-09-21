// 見えているグラフとノードのサイズから、座標を決める (同期の純粋関数)。
// 配置上の親で作ったレイアウト木を flextree に渡す。relations の始点より右に来る必要があるノードは、
// flextree に渡す深さ方向のサイズを左余白のぶんだけ広げ、本体をその領域の右側に置く。
import { flextree, type FlexTreeNode } from 'd3-flextree';
import type { VisibleEdge, VisibleGraph, VisibleNode } from './project';

export interface LayoutOptions {
    paddingX: number;
    spacingHorizontal: number;
    spacingVertical: number;
    lineWidth: (depth: number) => number;
    // 兄弟方向の間隔に足す値 (グループの枠の余白など)。指定がなければ markmap と同じ間隔になる
    extraSpacing?: (a: number, b: number) => number;
    // 実験用: 折りたたみで生じた depends の代理エッジを、横位置の計算に入れない (線が右から左へ向くことがある)
    ignoreProxiedDepends?: boolean;
}

// markmap の既定値
export const MARKMAP_DEFAULTS: LayoutOptions = {
    paddingX: 8,
    spacingHorizontal: 80,
    spacingVertical: 5,
    lineWidth: (depth) => 1 + 3 / 2 ** depth,
};

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface PlacedNode {
    node: VisibleNode;
    // ノード本体の矩形 (左右の余白を含み、次のノードまでの間隔は含まない)
    rect: Rect;
    // 本体の左に確保した余白の幅。0 なら markmap と同じ置き方
    gap: number;
    layoutParent: number | null;
}

export interface PlacedEdge {
    edge: VisibleEdge;
    // 始点の下線の右端と、終点の下線の左端
    source: [number, number];
    target: [number, number];
    // 配置上の親子を結ぶ線かどうか
    isLayoutLink: boolean;
    // 経路を自前で決める方式が返す中継点 (始点と終点を含む)。ない場合は、始点と終点を 1 本の曲線で結ぶ
    points?: Array<[number, number]>;
}

// flextree に渡した値。markmap と同じ値になっているかを外から確かめるために公開する
export interface FlextreeParams {
    nodeSize: Map<number, [number, number]>;
    spacing: (a: number, b: number) => number;
}

export interface LayoutResult {
    nodes: Map<number, PlacedNode>;
    edges: PlacedEdge[];
    bounds: Rect;
    // flextree を実行する前に、最長経路で計算した横位置。flextree の結果と一致するはずの値
    plannedX: Map<number, number>;
    flextreeParams: FlextreeParams;
}

export function layoutGraph(graph: VisibleGraph, options: LayoutOptions = MARKMAP_DEFAULTS): LayoutResult {
    const nodeOf = new Map(graph.nodes.map((node) => [node.id, node]));
    const get = (id: number): VisibleNode => {
        const node = nodeOf.get(id);
        if (!node) throw new Error(`見えていないノード: ${id}`);
        return node;
    };
    const ext = (node: VisibleNode): number =>
        node.width + (node.width > 0 ? options.paddingX * 2 : 0) + options.spacingHorizontal;

    // 横位置の下限を与える先行ノード: 配置上の親と、配置の計算から外されていない relations の始点
    const predecessors = new Map<number, number[]>(graph.nodes.map((node) => [node.id, []]));
    for (const [child, parent] of graph.layoutParent) predecessors.get(child)?.push(parent);
    for (const edge of graph.edges) {
        if (edge.kind === 'tree' || edge.excludedFromLayout) continue;
        if (options.ignoreProxiedDepends && edge.kind === 'depends' && edge.proxied) continue;
        predecessors.get(edge.target)?.push(edge.source);
    }
    const plannedX = longestPathX(graph, predecessors, (id) => ext(get(id)));

    const gapOf = new Map<number, number>();
    for (const node of graph.nodes) {
        const parent = graph.layoutParent.get(node.id);
        const start = parent === undefined ? 0 : (plannedX.get(parent) ?? 0) + ext(get(parent));
        gapOf.set(node.id, (plannedX.get(node.id) ?? 0) - start);
    }

    const childrenOf = layoutChildrenOf(graph);

    const nodeSize = new Map<number, [number, number]>(
        graph.nodes.map((node) => [node.id, [node.height, (gapOf.get(node.id) ?? 0) + ext(node)]]),
    );
    const spacing = (a: number, b: number): number =>
        (graph.layoutParent.get(a) === graph.layoutParent.get(b)
            ? options.spacingVertical
            : options.spacingVertical * 2) +
        options.lineWidth(get(a).depth) +
        (options.extraSpacing?.(a, b) ?? 0);

    const layout = flextree<number>({
        children: (id) => childrenOf.get(id) ?? [],
        nodeSize: (flexNode) => nodeSize.get(flexNode.data) ?? [0, 0],
        spacing: (a, b) => spacing(a.data, b.data),
    });
    const tree = layout.hierarchy(graph.rootId);
    layout(tree);

    // flextree は縦型 (x が兄弟方向、y が深さ方向) なので、markmap と同じく入れ替えて横型にする
    const nodes = new Map<number, PlacedNode>();
    tree.each((flexNode: FlexTreeNode<number>) => {
        const node = get(flexNode.data);
        const gap = gapOf.get(node.id) ?? 0;
        nodes.set(node.id, {
            node,
            gap,
            layoutParent: graph.layoutParent.get(node.id) ?? null,
            rect: {
                x: flexNode.y + gap,
                y: flexNode.x - flexNode.xSize / 2,
                width: flexNode.ySize - gap - options.spacingHorizontal,
                height: flexNode.xSize,
            },
        });
    });

    const placed = (id: number): PlacedNode => {
        const node = nodes.get(id);
        if (!node) throw new Error(`配置されていないノード: ${id}`);
        return node;
    };
    const underline = (id: number, side: 'left' | 'right'): [number, number] => {
        const { rect, node } = placed(id);
        return [
            side === 'left' ? rect.x : rect.x + rect.width,
            rect.y + rect.height + options.lineWidth(node.depth) / 2,
        ];
    };
    const edges: PlacedEdge[] = graph.edges.map((edge) => ({
        edge,
        source: underline(edge.source, 'right'),
        target: underline(edge.target, 'left'),
        isLayoutLink: graph.layoutParent.get(edge.target) === edge.source,
    }));

    return {
        nodes,
        edges,
        bounds: boundsOf([...nodes.values()].map((node) => node.rect)),
        plannedX,
        flextreeParams: { nodeSize, spacing },
    };
}

// レイアウト木の子の並び (上から下の順): Markdown の子を文書順に並べ、そのあとに relations で付け替えた子を文書順に並べる。
// 座標を決める前に兄弟の縦の並びを知りたい処理 (グループの枠のまとまりの判定など) も、この順を使う
export function layoutChildrenOf(graph: VisibleGraph): Map<number, number[]> {
    const childrenOf = new Map<number, number[]>(graph.nodes.map((node) => [node.id, []]));
    const adoptedOf = new Map<number, number[]>(graph.nodes.map((node) => [node.id, []]));
    for (const node of graph.nodes) {
        const parent = graph.layoutParent.get(node.id);
        if (parent === undefined) continue;
        (parent === node.treeParent ? childrenOf : adoptedOf).get(parent)?.push(node.id);
    }
    for (const [parent, adopted] of adoptedOf) childrenOf.get(parent)?.push(...adopted);
    return childrenOf;
}

// x(v) = max(x(u) + ext(u))。u は v の先行ノードすべて。先行ノードのないノード (ルート) は 0
function longestPathX(
    graph: VisibleGraph,
    predecessors: Map<number, number[]>,
    ext: (id: number) => number,
): Map<number, number> {
    const successors = new Map<number, number[]>(graph.nodes.map((node) => [node.id, []]));
    const remaining = new Map<number, number>();
    for (const [target, sources] of predecessors) {
        remaining.set(target, sources.length);
        for (const source of sources) successors.get(source)?.push(target);
    }
    const x = new Map<number, number>();
    const ready = graph.nodes.filter((node) => (remaining.get(node.id) ?? 0) === 0).map((node) => node.id);
    for (const id of ready) x.set(id, 0);
    for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
        const right = (x.get(id) ?? 0) + ext(id);
        for (const next of successors.get(id) ?? []) {
            x.set(next, Math.max(x.get(next) ?? 0, right));
            const left = (remaining.get(next) ?? 0) - 1;
            remaining.set(next, left);
            if (left === 0) ready.push(next);
        }
    }
    if (x.size !== graph.nodes.length) throw new Error('横位置の制約に閉路がある');
    return x;
}

export function boundsOf(rects: Rect[]): Rect {
    const x1 = Math.min(...rects.map((rect) => rect.x));
    const y1 = Math.min(...rects.map((rect) => rect.y));
    const x2 = Math.max(...rects.map((rect) => rect.x + rect.width));
    const y2 = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

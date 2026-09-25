// 配置の層の包み。見えているグラフとノードのサイズから座標を決める計算は Rust (wasm の layout_document) が行う:
// 射影、グループの枠のまとまり、枠の余白を入れた配置の繰り返し (枠に入り込むノードがなくなるか上限の回数まで) を 1 回の呼び出しで行う。
// ここは境界の結果の配列の組を Map に戻す。描画とアニメーションの毎コマで使う boundsOf と、線の太さの式 (MARKMAP_DEFAULTS.lineWidth) は JS に写しを残す。
import type { GraphModel } from '../model/model';
import type { Frame } from '../view/frames';
import { callJson } from '../wasm/boundary';
import type { LayoutInput } from './input-types';
import { visibleGraphOf, type RawVisibleGraph, type VisibleEdge, type VisibleGraph } from './project';

export interface LayoutOptions {
    paddingX: number;
    spacingHorizontal: number;
    spacingVertical: number;
    lineWidth: (depth: number) => number;
    // 実験用: 折りたたみで生じた depends の代理エッジを、横位置の計算に入れない (線が右から左へ向くことがある)
    ignoreProxiedDepends?: boolean;
}

// 線の太さの式 base + scale / 2^depth の係数。Rust には関数でなくこの値を渡す
const LINE_WIDTH = { base: 1, scale: 3 };

// markmap の既定値
export const MARKMAP_DEFAULTS: LayoutOptions = {
    paddingX: 8,
    spacingHorizontal: 80,
    spacingVertical: 5,
    lineWidth: (depth) => LINE_WIDTH.base + LINE_WIDTH.scale / 2 ** depth,
};

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
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

// layoutDocument の結果。枠は配置の後の矩形 (outline) つき
export interface DocumentLayout {
    graph: VisibleGraph;
    frames: Array<Frame & { outline: Rect | null }>;
    rects: Map<number, Rect>;
    // 本体の左に確保した余白の幅
    gaps: Map<number, number>;
    edges: PlacedEdge[];
    bounds: Rect;
    plannedX: Map<number, number>;
    nodeSize: Map<number, [number, number]>;
    // 配置を行った回数
    passes: number;
}

interface RawDocumentLayout extends Omit<DocumentLayout, 'graph' | 'rects' | 'gaps' | 'plannedX' | 'nodeSize'> {
    graph: RawVisibleGraph;
    rects: Array<[number, Rect]>;
    gaps: Array<[number, number]>;
    plannedX: Array<[number, number]>;
    nodeSize: Array<[number, [number, number]]>;
}

// 射影から配置までを 1 回の呼び出しで行う (view の配置)。間隔は markmap の既定値で、枠の余白は Rust の中で前回の配置から求める。
// 配置に失敗したとき (横位置の制約に閉路があるなど) は、Rust の LayoutError の文面の MarkdagError を投げる
export function layoutDocument(input: LayoutInput, model: Pick<GraphModel, 'groups' | 'groupsOf'>, options: { ignoreProxiedDepends?: boolean } = {}): DocumentLayout {
    const { paddingX, spacingHorizontal, spacingVertical } = MARKMAP_DEFAULTS;
    const raw = callJson<RawDocumentLayout>('layout_document', {
        input,
        groups: model.groups,
        groupsOf: [...model.groupsOf],
        options: { paddingX, spacingHorizontal, spacingVertical, lineWidth: LINE_WIDTH, ignoreProxiedDepends: options.ignoreProxiedDepends },
        maxPasses: null,
    });
    return {
        ...raw,
        graph: visibleGraphOf(raw.graph),
        rects: new Map(raw.rects),
        gaps: new Map(raw.gaps),
        plannedX: new Map(raw.plannedX),
        nodeSize: new Map(raw.nodeSize),
    };
}

// ---- JS に写しを残す関数 (描画とアニメーションの毎コマで使うので wasm を呼ばない。Rust の bounds_of と同じ) ----

export function boundsOf(rects: Rect[]): Rect {
    const x1 = Math.min(...rects.map((rect) => rect.x));
    const y1 = Math.min(...rects.map((rect) => rect.y));
    const x2 = Math.max(...rects.map((rect) => rect.x + rect.width));
    const y2 = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

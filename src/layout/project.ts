// 射影の層の包み。折りたたみの前のモデルから見えているグラフへの射影 (代表ノードへの置き換え、閉路を作る relations の除外、
// 配置上の親の確定) は Rust (wasm の project) が行う。view の配置は射影から配置までを 1 回で行う layoutDocument を使い、ここは使わない。
import { callJson } from '../wasm/boundary';
import type { LayoutInput, RelationKind } from './input-types';

export interface VisibleNode {
    id: number;
    label: string;
    width: number;
    height: number;
    groups: string[];
    // Markdown のツリーでの深さ。ルートが 1 (markmap の数え方に合わせる)
    depth: number;
    treeParent: number | null;
    // 閉じていて、隠れた配下を持つ
    folded: boolean;
}

export interface VisibleEdge {
    kind: 'tree' | RelationKind;
    source: number;
    target: number;
    // まとめた元のエッジ。relations は入力の配列での位置、ツリーのエッジは空
    memberRelationIndexes: number[];
    // 端点のどちらかが代表ノードに置き換わった
    proxied: boolean;
    // 足すと閉路になるため、横位置の計算と配置上の親の候補から外した
    excludedFromLayout: boolean;
}

export interface VisibleGraph {
    rootId: number;
    // 文書順
    nodes: VisibleNode[];
    // 描く線。ルートからの線を抑制したノードへのツリーのエッジは含まない
    edges: VisibleEdge[];
    // ルート以外の見えているノードについて、レイアウト木での親
    layoutParent: Map<number, number>;
}

// 境界の VisibleGraph。layoutParent は配列の組
export type RawVisibleGraph = Omit<VisibleGraph, 'layoutParent'> & { layoutParent: Array<[number, number]> };

export const visibleGraphOf = (raw: RawVisibleGraph): VisibleGraph => ({ ...raw, layoutParent: new Map(raw.layoutParent) });

// 射影に失敗したとき (壊れた入力) は、Rust の LayoutError の文面の MarkdagError を投げる
export function project(input: LayoutInput): VisibleGraph {
    return visibleGraphOf(callJson<RawVisibleGraph>('project', { input }));
}


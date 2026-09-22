// 折りたたみの前のモデルから、見えているグラフへ射影する。
// 隠れたノードを代表ノードに置き換えてエッジをまとめ、射影で生じた閉路を作る relations を配置の計算から外し、
// 配置上の親 (レイアウト木の親) を確定するところまでを受け持つ。座標は扱わない。
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

export interface LayoutParentCandidate {
    node: number;
    relationIndex: number;
}

// 配置上の親の候補を、モデル全体 (折りたたみの前) で優先順に並べる。
// depends 以外の先行ノードを文書順に並べ、中央 (偶数個なら前側) から近い順。尽きたら depends の先行ノードを同じ規則で続ける。
export function computeLayoutParentHints(input: LayoutInput): Map<number, LayoutParentCandidate[]> {
    const hints = new Map<number, LayoutParentCandidate[]>();
    for (const target of input.suppressRootLine) {
        const incoming = input.relations.flatMap((relation, relationIndex) =>
            relation.target === target ? [{ node: relation.source, relationIndex, kind: relation.kind }] : [],
        );
        const ordered = [
            ...orderFromCenter(incoming.filter((candidate) => candidate.kind !== 'depends')),
            ...orderFromCenter(incoming.filter((candidate) => candidate.kind === 'depends')),
        ];
        hints.set(
            target,
            ordered.map(({ node, relationIndex }) => ({ node, relationIndex })),
        );
    }
    return hints;
}

function orderFromCenter<T extends { node: number }>(candidates: T[]): T[] {
    const sorted = [...candidates].sort((a, b) => a.node - b.node);
    const center = Math.floor((sorted.length - 1) / 2);
    return sorted
        .map((candidate, index) => ({ candidate, index, distance: Math.abs(index - center) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index)
        .map(({ candidate }) => candidate);
}

export function project(input: LayoutInput): VisibleGraph {
    const rootId = input.nodes[0]?.id;
    if (rootId === undefined) throw new Error('入力にノードがない');

    const treeParentOf = new Map<number, number>(input.treeEdges.map((edge) => [edge.target, edge.source]));
    const folded = new Set(input.folded);

    // 文書順では親が必ず先に来るので、1 回の走査で深さと代表を決められる
    const depthOf = new Map<number, number>();
    const repOf = new Map<number, number>();
    for (const node of input.nodes) {
        const parent = treeParentOf.get(node.id);
        if (parent === undefined) {
            depthOf.set(node.id, 1);
            repOf.set(node.id, node.id);
            continue;
        }
        depthOf.set(node.id, (depthOf.get(parent) ?? 0) + 1);
        const parentRep = repOf.get(parent) ?? parent;
        // 親が隠れているか、親自身が閉じていれば、その代表 (閉じている祖先のうち最も上のもの) を引き継ぐ
        repOf.set(node.id, parentRep !== parent || folded.has(parent) ? parentRep : node.id);
    }
    const rep = (id: number): number => repOf.get(id) ?? id;
    const isVisible = (id: number): boolean => rep(id) === id;

    const hasChildren = new Set(input.treeEdges.map((edge) => edge.source));
    const nodes: VisibleNode[] = input.nodes
        .filter((node) => isVisible(node.id))
        .map((node) => ({
            ...node,
            depth: depthOf.get(node.id) ?? 1,
            treeParent: treeParentOf.get(node.id) ?? null,
            folded: folded.has(node.id) && hasChildren.has(node.id),
        }));

    const visibleTreeEdges: VisibleEdge[] = input.treeEdges
        .filter((edge) => isVisible(edge.target))
        .map((edge) => ({
            kind: 'tree',
            source: edge.source,
            target: edge.target,
            memberRelationIndexes: [],
            proxied: false,
            excludedFromLayout: false,
        }));

    // relations を代表ノードどうしのエッジに置き換え、種類と両端が同じものをまとめる
    const merged = new Map<string, VisibleEdge>();
    input.relations.forEach((relation, relationIndex) => {
        const source = rep(relation.source);
        const target = rep(relation.target);
        if (source === target) return;
        const key = `${relation.kind}:${source}>${target}`;
        const existing = merged.get(key);
        const proxied = source !== relation.source || target !== relation.target;
        if (existing) {
            existing.memberRelationIndexes.push(relationIndex);
            existing.proxied ||= proxied;
            return;
        }
        merged.set(key, {
            kind: relation.kind,
            source,
            target,
            memberRelationIndexes: [relationIndex],
            proxied,
            excludedFromLayout: false,
        });
    });
    const relationEdges = [...merged.values()];

    // ツリーのエッジをすべて入れたグラフに、relations を記述順に 1 本ずつ足し、閉路になるものを外す
    const successors = new Map<number, number[]>(nodes.map((node) => [node.id, []]));
    const addEdge = (source: number, target: number): void => {
        successors.get(source)?.push(target);
    };
    const reaches = (from: number, to: number): boolean => {
        const seen = new Set<number>([from]);
        const stack = [from];
        for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
            if (current === to) return true;
            for (const next of successors.get(current) ?? []) {
                if (!seen.has(next)) {
                    seen.add(next);
                    stack.push(next);
                }
            }
        }
        return false;
    };
    for (const edge of visibleTreeEdges) addEdge(edge.source, edge.target);
    for (const edge of relationEdges) {
        if (reaches(edge.target, edge.source)) {
            edge.excludedFromLayout = true;
        } else {
            addEdge(edge.source, edge.target);
        }
    }

    // 配置上の親の確定。候補を生んだエッジが外されていたら次の候補へ。尽きたらルートに戻し、ルートからの線も戻す
    const hints = computeLayoutParentHints(input);
    const edgeOfRelation = new Map<number, VisibleEdge>();
    for (const edge of relationEdges) {
        for (const relationIndex of edge.memberRelationIndexes) edgeOfRelation.set(relationIndex, edge);
    }
    const layoutParent = new Map<number, number>();
    const suppressed = new Set<number>();
    for (const node of nodes) {
        if (node.treeParent === null) continue;
        const adopted = (hints.get(node.id) ?? []).find((candidate) => {
            const edge = edgeOfRelation.get(candidate.relationIndex);
            return edge !== undefined && !edge.excludedFromLayout;
        });
        if (adopted) {
            layoutParent.set(node.id, rep(adopted.node));
            suppressed.add(node.id);
        } else {
            layoutParent.set(node.id, node.treeParent);
        }
    }

    return {
        rootId,
        nodes,
        edges: [...visibleTreeEdges.filter((edge) => !suppressed.has(edge.target)), ...relationEdges],
        layoutParent,
    };
}

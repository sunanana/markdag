// 選んでいるものの値の操作 (DOM を使わない)。選択は EditorSelection の値で持ち、ノードは図の id と refText (NodeTarget) で指す。
// ノードの並びは選んだ順で、最後が「最後に選んだノード」(複数を選んでいるときに矢印キーで動く起点)。
// 線は図の線の種類と両端の id (EdgeTarget) で指し、図の強調 (selectEdge) にはそこから作った線のキーを渡す。
// グループはグループの名前 (markdag.groups のキー) で指し、図の強調 (selectGroups) にもその名前を渡す。1 つは { kind: 'group' }、
// 2 つ以上は { kind: 'groups' } (選んだ順) で持ち、外して 1 つになれば { kind: 'group' } に、なくなれば選択なしに戻す。
// 描き直したあとは、同じ id で refText も同じノードだけを選んだままにし、線とグループはその文書にまだあるときだけ選んだままにする
// (行がずれた文書で、別のノードを選ばないため)。閉じた枝の中に隠れたもの (ノード、メンバーが全部隠れたグループ、端が隠れた線) は
// 選択から外せる (いつ外すかは呼ぶ側)。
// ルートを複数の選択に入れない決まりと、選んだあとの見せ方は呼ぶ側が受け持つ
import type { EdgeTarget, EditSelection, GraphModel, NodeTarget, OutlineNode, ViewDocument } from '../core';

// 編集の層の選択。markdag/core の EditSelection (書き換えの結果の選び直し) に、2 つ以上のグループ (選んだ順) を足したもの
export type EditorSelection = EditSelection | { kind: 'groups'; ids: string[] };

export const NO_SELECTION: EditorSelection = { kind: 'none' };

// 選び直しを確かめる、描いている文書の中身 (ノード、関係の線、グループの名前)
export interface DrawnParts {
    nodes: readonly Pick<OutlineNode, 'id' | 'refText' | 'parent'>[];
    relations: readonly Pick<GraphModel['relations'][number], 'kind' | 'source' | 'target'>[];
    groups: readonly string[];
}

export function drawnParts(document: ViewDocument | null): DrawnParts {
    return { nodes: document?.parsed.nodes ?? [], relations: document?.model.relations ?? [], groups: document?.model.groups.map((group) => group.id) ?? [] };
}

// 図のノードを指す値にする
export function targetOf(node: Pick<OutlineNode, 'id' | 'refText'>): NodeTarget {
    return { id: node.id, refText: node.refText };
}

// ノードの選択 (空なら選択なし)。同じ id は最初のものだけを残す
export function nodesSelection(targets: readonly NodeTarget[]): EditorSelection {
    const nodes = new Map<number, NodeTarget>();
    for (const target of targets) if (!nodes.has(target.id)) nodes.set(target.id, { id: target.id, refText: target.refText });
    return nodes.size === 0 ? NO_SELECTION : { kind: 'nodes', nodes: [...nodes.values()] };
}

// 線の選択 (図の線の欄から、種類と両端だけを取る)
export function edgeSelection(edge: EdgeTarget): EditorSelection {
    return { kind: 'edge', edge: { kind: edge.kind, source: edge.source, target: edge.target } };
}

export function groupSelection(id: string): EditorSelection {
    return { kind: 'group', id };
}

// グループの選択 (並びのまま。同じ名前は最初のものだけを残す)。空なら選択なし、1 つなら { kind: 'group' }
export function groupsSelection(ids: readonly string[]): EditorSelection {
    const unique = [...new Set(ids)];
    const [only] = unique;
    if (only === undefined) return NO_SELECTION;
    return unique.length === 1 ? groupSelection(only) : { kind: 'groups', ids: unique };
}

// 選んでいるノード (ノードの選択でなければ空)
export function selectedNodes(selection: EditorSelection): readonly NodeTarget[] {
    return selection.kind === 'nodes' ? selection.nodes : [];
}

// 選んでいる線 (線の選択でなければ null)
export function selectedEdge(selection: EditorSelection): EdgeTarget | null {
    return selection.kind === 'edge' ? selection.edge : null;
}

// 1 つだけ選んでいるグループの名前 (グループ 1 つの選択でなければ null。2 つ以上でも null)
export function selectedGroup(selection: EditorSelection): string | null {
    return selection.kind === 'group' ? selection.id : null;
}

// 選んでいるグループの名前 (選んだ順。グループの選択でなければ空)
export function selectedGroups(selection: EditorSelection): readonly string[] {
    if (selection.kind === 'group') return [selection.id];
    return selection.kind === 'groups' ? selection.ids : [];
}

// グループの選択に、選んでいれば外し、選んでいなければ最後に足す (グループの選択でなければ、そのグループだけ)
export function toggleGroup(selection: EditorSelection, id: string): EditorSelection {
    const groups = selectedGroups(selection);
    return groupsSelection(groups.includes(id) ? groups.filter((group) => group !== id) : [...groups, id]);
}

// 図の線のキー (selectEdge に渡す形。種類:始点>終点)
export function edgeKeyOf(edge: EdgeTarget): string {
    return `${edge.kind}:${edge.source}>${edge.target}`;
}

export function lastSelectedNode(selection: EditorSelection): NodeTarget | null {
    return selectedNodes(selection).at(-1) ?? null;
}

// 選んでいれば外し、選んでいなければ最後に足す
export function toggleNode(selection: EditorSelection, target: NodeTarget): EditorSelection {
    const nodes = selectedNodes(selection);
    return nodes.some((node) => node.id === target.id) ? nodesSelection(nodes.filter((node) => node.id !== target.id)) : nodesSelection([...nodes, target]);
}

// 選んでいないものを最後に足す (選んでいるものは外さない)
export function addNodes(selection: EditorSelection, targets: readonly NodeTarget[]): EditorSelection {
    return nodesSelection([...selectedNodes(selection), ...targets]);
}

// 選んでいるノードの集まりが同じか (並びと refText は見ない。ノードの選択でなければ空の集まり)
export function sameNodeSet(a: EditorSelection, b: EditorSelection): boolean {
    const left = new Set(selectedNodes(a).map((node) => node.id));
    const right = selectedNodes(b).map((node) => node.id);
    return left.size === new Set(right).size && right.every((id) => left.has(id));
}

export function sameSelection(a: EditorSelection, b: EditorSelection): boolean {
    if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind;
    if (a.kind === 'nodes' && b.kind === 'nodes') return a.nodes.length === b.nodes.length && a.nodes.every((node, index) => node.id === b.nodes[index]?.id && node.refText === b.nodes[index]?.refText);
    if (a.kind === 'edge' && b.kind === 'edge') return a.edge.kind === b.edge.kind && a.edge.source === b.edge.source && a.edge.target === b.edge.target;
    if (a.kind === 'groups' && b.kind === 'groups') return a.ids.length === b.ids.length && a.ids.every((id, index) => id === b.ids[index]);
    return a.kind === 'group' && b.kind === 'group' && a.id === b.id;
}

// 文書にその線があるか。木の線は終点の親が始点、関係の線は同じ種類と両端の関係があること
function hasEdge(edge: EdgeTarget, drawn: DrawnParts): boolean {
    if (edge.kind === 'tree') return drawn.nodes.some((node) => node.id === edge.target && node.parent === edge.source);
    return drawn.relations.some((relation) => relation.kind === edge.kind && relation.source === edge.source && relation.target === edge.target);
}

// 閉じた枝の中に隠れたもの (祖先のどれかが folded にあるノード) を外した選択。ノードは隠れたものだけを外し、閉じた枝そのもの
// (folded にあるノード) は見えているので残す。グループはメンバー (groupsOf でそのグループに入るノード) が全部隠れたものを外し、
// 線は片方の端のノードが隠れたら外す (見えないものを選んだままにしない)
export function withoutFolded(
    selection: EditorSelection,
    nodes: DrawnParts['nodes'],
    folded: readonly number[],
    groupsOf: ReadonlyMap<number, readonly string[]>,
): EditorSelection {
    if (selection.kind === 'none' || folded.length === 0) return selection;
    const closed = new Set(folded);
    const parents = new Map(nodes.map((node) => [node.id, node.parent]));
    const hidden = (id: number): boolean => {
        for (let parent = parents.get(id) ?? null; parent !== null; parent = parents.get(parent) ?? null) if (closed.has(parent)) return true;
        return false;
    };
    if (selection.kind === 'nodes') return nodesSelection(selection.nodes.filter((target) => !hidden(target.id)));
    if (selection.kind === 'edge') return hidden(selection.edge.source) || hidden(selection.edge.target) ? NO_SELECTION : selection;
    const groupHidden = (id: string): boolean => {
        const members = [...groupsOf].flatMap(([node, groups]) => (groups.includes(id) ? [node] : []));
        return members.length > 0 && members.every(hidden);
    };
    const kept = selectedGroups(selection).filter((id) => !groupHidden(id));
    return kept.length === selectedGroups(selection).length ? selection : groupsSelection(kept);
}

// 描き直した文書で選び直す。ノードは同じ id で refText も同じものだけを残し、線とグループは文書にまだあれば残す
// (2 つ以上のグループは残ったものだけにし、1 つになれば { kind: 'group' } にする)
export function keepDrawn(selection: EditorSelection, drawn: DrawnParts): EditorSelection {
    if (selection.kind === 'edge') return hasEdge(selection.edge, drawn) ? edgeSelection(selection.edge) : NO_SELECTION;
    if (selection.kind === 'group' || selection.kind === 'groups') return groupsSelection(selectedGroups(selection).filter((id) => drawn.groups.includes(id)));
    if (selection.kind !== 'nodes') return selection;
    const refTexts = new Map(drawn.nodes.map((node) => [node.id, node.refText]));
    return nodesSelection(selection.nodes.filter((target) => refTexts.get(target.id) === target.refText));
}

// 原文を書き換えて描き直したあとも、閉じていた枝を閉じたままにするための対応 (DOM を使わない)。
// 図は木の形が変わると開閉を文書の初めの状態に戻すので、書き換える前に閉じていたノードを、書き換えたあとの文書で引き直す。
// 木の形 (ノードの数と、文書の順の親) が変わらない書き換え (名前の変更、詳細やタグの書き換え) では、同じ id のノードを閉じたままにする
// (閉じた枝そのものの名前を変えても閉じたまま)。木の形が変わる書き換え (足す、消す、付け替え、元に戻す / やり直す) では、
// ルートから親ごとに子を組にしてたどる。同じ親の子どうしは、名前 (番号付きの項目の頭の番号は除く。足すか消すと振り直しで変わるため) と
// 配下の名前の並びがそろうものを先に書いた順に組にし、残りを名前だけで書いた順に組にする (同じ名前の兄弟の前で足すか消しても、
// 配下が違えば取り違えない)。関係のない枝は同じ組のまま残る。親が組にならないノード (付け替えた枝の中) は閉じたままにしない。
// 足したノードを見せるために枝を開くのは呼ぶ側
import type { OutlineNode } from '../core';

// 木の形は parent だけで受け取る。文書の順は配列の順 (parsed.nodes をそのまま渡せる)
export type FoldNode = Pick<OutlineNode, 'id' | 'parent' | 'refText'>;

// 番号付きの項目の名前の頭の番号 (解析が並びの位置から付けるもの)。項目の間に空行のあるリストでは、名前が番号だけになる
const LIST_NUMBER = /^[0-9]+\.(?: |$)/;

// 親ごとの子 (文書の順)。ルートは null の下
function childrenOf(nodes: readonly FoldNode[]): Map<number | null, FoldNode[]> {
    const children = new Map<number | null, FoldNode[]>();
    for (const node of nodes) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
    return children;
}

// ノードごとの、頭の番号を除いた名前と、配下の名前の並び。子は親より後ろにあるので、後ろから組み立てる
function shapesOf(nodes: readonly FoldNode[], children: ReadonlyMap<number | null, FoldNode[]>): Map<number, string> {
    const shapes = new Map<number, string>();
    for (const node of [...nodes].reverse()) {
        const below = (children.get(node.id) ?? []).map((child) => shapes.get(child.id) ?? '');
        shapes.set(node.id, JSON.stringify([bareName(node), below]));
    }
    return shapes;
}

const bareName = (node: FoldNode): string => node.refText.replace(LIST_NUMBER, '');

// 組にする子と、組にする鍵 (配下の名前の並びつきの名前と、名前だけ)
interface Keyed {
    node: FoldNode;
    shape: string;
    name: string;
}

// 同じ親の子どうしの組 (before の子、after の子)。配下の名前の並びがそろうものを先に、残りを名前だけで、まだ組になっていないものを書いた順に組にする
function pairChildren(before: readonly Keyed[], after: readonly Keyed[]): Array<[FoldNode, FoldNode]> {
    const pairs: Array<[FoldNode, FoldNode]> = [];
    let left = [...before];
    let right = [...after];
    for (const key of ['shape', 'name'] as const) {
        const waiting = new Map<string, Keyed[]>();
        for (const item of right) waiting.set(item[key], [...(waiting.get(item[key]) ?? []), item]);
        left = left.filter((item) => {
            const match = waiting.get(item[key])?.shift();
            if (match === undefined) return true;
            pairs.push([item.node, match.node]);
            right = right.filter((other) => other !== match);
            return false;
        });
    }
    return pairs;
}

// before のノードの id から、組になった after のノードの id への対応
function matchedIds(before: readonly FoldNode[], after: readonly FoldNode[]): Map<number, number> {
    const beforeChildren = childrenOf(before);
    const afterChildren = childrenOf(after);
    const beforeShapes = shapesOf(before, beforeChildren);
    const afterShapes = shapesOf(after, afterChildren);
    const keyed = (nodes: readonly FoldNode[] | undefined, shapes: ReadonlyMap<number, string>): Keyed[] =>
        (nodes ?? []).map((node) => ({ node, shape: shapes.get(node.id) ?? '', name: bareName(node) }));
    const matched = new Map<number, number>();
    const visit = (from: number | null, to: number | null): void => {
        for (const [old, next] of pairChildren(keyed(beforeChildren.get(from), beforeShapes), keyed(afterChildren.get(to), afterShapes))) {
            matched.set(old.id, next.id);
            visit(old.id, next.id);
        }
    };
    visit(null, null);
    return matched;
}

// before で閉じていたノード (folded) のうち、after に残るノードの id。木の形が同じなら同じ id、違えば組になったノード
export function carriedFolds(before: readonly FoldNode[], folded: Iterable<number>, after: readonly FoldNode[]): number[] {
    const sameShape = before.length === after.length && before.every((node, index) => after[index]?.id === node.id && after[index]?.parent === node.parent);
    if (sameShape) return [...folded].filter((id) => after.some((node) => node.id === id));
    const matched = matchedIds(before, after);
    return [...folded].flatMap((id) => {
        const next = matched.get(id);
        return next === undefined ? [] : [next];
    });
}

// 矢印キーで選ぶノードを決める部品 (DOM を使わない) を確かめる。
// 位置は nodeRects の画面の座標で、並びは動き終えたあとの矩形で決める (動いている途中の位置で並べない)。
// 枝を開くこと、見える所まで動かすこと、複数の選択の「最後に選んだノード」 は編集の層の受け持ちなので e2e で確かめる。
// 部品の形 (このテストが確かめる約束):
//     type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
//     type NavigationNode = Pick<OutlineNode, 'id' | 'parent'>
//         木の形は parent だけで渡す。子と兄弟の文書の順は配列の順 (parsed.nodes をそのまま渡せる)
//     interface Point { x: number; y: number }
//     arrowTarget(key: ArrowKey, from: number, nodes: readonly NavigationNode[], rects: ReadonlyMap<number, Rect>): number | null
//         選んでいるノード from から移る先。rects は見えているノードの矩形 (view.nodeRects の値。図の領域の左上からの画面の座標)。
//         ← は親。→ は rects にある子のうち画面でいちばん上のもの。↑ ↓ は from と同じ親の子 (from を含む。rects にあるもの) を
//         画面の上下の位置で並べた前と後で、端では反対の端へ回る。移る先がなければ null
//     startNode(pointer: Point | null, nodes: readonly NavigationNode[], rects: ReadonlyMap<number, Rect>): number | null
//         何も選んでいないときに矢印キーで選ぶノード。pointer はカーソルの位置 (rects と同じ座標)。カーソルがウィンドウの外なら null で、ルートを返す。
//         そうでなければ rects にあるノードのうちカーソルにいちばん近いもの
// 上下の位置を矩形の上の辺で比べるか中ほどで比べるか、近さを箱までの距離で測るか中心までの距離で測るかは決めない
// (どちらで測っても同じ答えになる配置だけを使う)。同じ高さの兄弟の並びも決めない (使わない)
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OutlineNode, Rect } from '../src/core';
import type { EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';
import { arrowTarget, startNode, type ArrowKey, type NavigationNode, type Point } from '../src/editor/navigation';

const ARROWS: readonly ArrowKey[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

// 部品が入力を書き換えないよう、凍らせて渡す
function tree(parents: ReadonlyArray<number | null>): readonly NavigationNode[] {
    return Object.freeze(parents.map((parent, index) => Object.freeze({ id: index + 1, parent })));
}

const box = (x: number, y: number, width = 100, height = 40): Rect => Object.freeze({ x, y, width, height });

function rectsOf(entries: ReadonlyArray<readonly [number, Rect]>): ReadonlyMap<number, Rect> {
    return new Map(entries);
}

// 左から右へ広がる図 (ルート、子の列、孫の列)。同じ親の子は上から文書の順に並ぶ
//   1 Root
//   ├─ 2 A
//   │   ├─ 3 A1
//   │   ├─ 4 A2
//   │   └─ 5 A3
//   └─ 6 B
//       ├─ 7 B1
//       └─ 8 B2
const NODES = tree([null, 1, 2, 2, 2, 1, 6, 6]);
const LAID_OUT = rectsOf([
    [1, box(0, 200)],
    [2, box(200, 100)],
    [3, box(400, 40)],
    [4, box(400, 100)],
    [5, box(400, 160)],
    [6, box(200, 300)],
    [7, box(400, 280)],
    [8, box(400, 340)],
]);

describe('矢印キーで移る先 (arrowTarget)', () => {
    it('← は親を選ぶ。ルートには親がないので null (B-086)', () => {
        expect(arrowTarget('ArrowLeft', 4, NODES, LAID_OUT)).toBe(2);
        expect(arrowTarget('ArrowLeft', 8, NODES, LAID_OUT)).toBe(6);
        expect(arrowTarget('ArrowLeft', 2, NODES, LAID_OUT)).toBe(1);
        expect(arrowTarget('ArrowLeft', 1, NODES, LAID_OUT)).toBeNull();
    });

    it('→ は子のうち画面でいちばん上のものを選ぶ (B-087)', () => {
        expect(arrowTarget('ArrowRight', 1, NODES, LAID_OUT)).toBe(2);
        expect(arrowTarget('ArrowRight', 2, NODES, LAID_OUT)).toBe(3);
        expect(arrowTarget('ArrowRight', 6, NODES, LAID_OUT)).toBe(7);
    });

    it('→ の「いちばん上」は文書の順ではなく画面の位置で決める (文書で後の子が上にあれば、その子) (B-087)', () => {
        // A3 が A1 より上、B2 が B1 より上に描かれている
        const rects = rectsOf([
            [1, box(0, 200)],
            [2, box(200, 100)],
            [3, box(400, 160)],
            [4, box(400, 100)],
            [5, box(400, 40)],
            [6, box(200, 300)],
            [7, box(400, 340)],
            [8, box(400, 280)],
        ]);
        expect(arrowTarget('ArrowRight', 2, NODES, rects)).toBe(5);
        expect(arrowTarget('ArrowRight', 6, NODES, rects)).toBe(8);
        // 子の列が親より上にずれていても、子の中でいちばん上
        const shifted = rectsOf([
            [1, box(0, 500)],
            [2, box(200, 100)],
            [6, box(200, 30)],
            [3, box(400, 40)],
            [4, box(400, 100)],
            [5, box(400, 160)],
            [7, box(400, 280)],
            [8, box(400, 340)],
        ]);
        expect(arrowTarget('ArrowRight', 1, NODES, shifted)).toBe(6);
    });

    it('→ は rects にある (見えている) 子だけから選ぶ。子のないノードと、子が rects にないノード (閉じた枝) では null (B-087、B-090)', () => {
        for (const leaf of [3, 4, 5, 7, 8]) expect(arrowTarget('ArrowRight', leaf, NODES, LAID_OUT), `葉 ${leaf}`).toBeNull();
        // A を閉じた図: A の子の矩形はない
        const folded = rectsOf([...LAID_OUT].filter(([id]) => ![3, 4, 5].includes(id)));
        expect(arrowTarget('ArrowRight', 2, NODES, folded)).toBeNull();
        // 開いて動き終えたあとの矩形を渡せば、その並びでいちばん上の子
        const opened = rectsOf([...folded, [3, box(400, 120)], [4, box(400, 60)], [5, box(400, 180)]]);
        expect(arrowTarget('ArrowRight', 2, NODES, opened)).toBe(4);
    });

    it('↓ は兄弟を画面の上下の順で次へ、いちばん下ではいちばん上へ回る (B-088)', () => {
        expect(arrowTarget('ArrowDown', 3, NODES, LAID_OUT)).toBe(4);
        expect(arrowTarget('ArrowDown', 4, NODES, LAID_OUT)).toBe(5);
        expect(arrowTarget('ArrowDown', 5, NODES, LAID_OUT)).toBe(3);
        expect(arrowTarget('ArrowDown', 2, NODES, LAID_OUT)).toBe(6);
        expect(arrowTarget('ArrowDown', 6, NODES, LAID_OUT)).toBe(2);
    });

    it('↑ は兄弟を画面の上下の順で前へ、いちばん上ではいちばん下へ回る (B-088)', () => {
        expect(arrowTarget('ArrowUp', 5, NODES, LAID_OUT)).toBe(4);
        expect(arrowTarget('ArrowUp', 4, NODES, LAID_OUT)).toBe(3);
        expect(arrowTarget('ArrowUp', 3, NODES, LAID_OUT)).toBe(5);
        expect(arrowTarget('ArrowUp', 8, NODES, LAID_OUT)).toBe(7);
        expect(arrowTarget('ArrowUp', 7, NODES, LAID_OUT)).toBe(8);
    });

    it('兄弟の並びは文書の順ではなく画面の上下の位置で決める (B-088)', () => {
        // 画面の上から A1、A3、A2 (文書の順を回しただけの並びではない)
        const rects = rectsOf([...LAID_OUT, [3, box(400, 40)], [4, box(400, 160)], [5, box(400, 100)]]);
        expect(arrowTarget('ArrowDown', 3, NODES, rects)).toBe(5);
        expect(arrowTarget('ArrowDown', 5, NODES, rects)).toBe(4);
        expect(arrowTarget('ArrowDown', 4, NODES, rects)).toBe(3);
        expect(arrowTarget('ArrowUp', 3, NODES, rects)).toBe(4);
        expect(arrowTarget('ArrowUp', 4, NODES, rects)).toBe(5);
        expect(arrowTarget('ArrowUp', 5, NODES, rects)).toBe(3);
    });

    it('↑ ↓ は同じ親の子だけを並べる。画面で間にあるほかの枝のノード、親、子は飛ばす (B-088)', () => {
        //   1 Root
        //   ├─ 2 A ── 3 A1、4 A2
        //   └─ 5 B ── 6 B1
        const nodes = tree([null, 1, 2, 2, 1, 5]);
        const rects = rectsOf([
            [1, box(0, 150)],
            // A の子の間の高さに、B の子 (いとこ) と B (親の兄弟) を置く
            [2, box(200, 20)],
            [3, box(400, 0)],
            [5, box(200, 120)],
            [6, box(400, 160)],
            [4, box(400, 300)],
        ]);
        expect(arrowTarget('ArrowDown', 3, nodes, rects)).toBe(4);
        expect(arrowTarget('ArrowDown', 4, nodes, rects)).toBe(3);
        expect(arrowTarget('ArrowUp', 4, nodes, rects)).toBe(3);
        expect(arrowTarget('ArrowDown', 2, nodes, rects)).toBe(5);
        expect(arrowTarget('ArrowUp', 2, nodes, rects)).toBe(5);
    });

    it('兄弟のないノードの ↑ ↓ は、ほかのノードへ移らない (自分のままか null) (B-088)', () => {
        //   1 Root ── 2 A ── 3 A1
        const nodes = tree([null, 1, 2]);
        const rects = rectsOf([
            [1, box(0, 100)],
            [2, box(200, 100)],
            [3, box(400, 100)],
        ]);
        for (const from of [1, 2, 3]) {
            for (const key of ['ArrowUp', 'ArrowDown'] as const) expect([from, null], `${key} ${from}`).toContain(arrowTarget(key, from, nodes, rects));
        }
    });

    it('矢印キーで移る先は木と矩形だけで決まり、渡した木と矩形を書き換えない', () => {
        const before = JSON.stringify([...LAID_OUT]);
        for (const key of ARROWS) for (const node of NODES) arrowTarget(key, node.id, NODES, LAID_OUT);
        expect(JSON.stringify([...LAID_OUT])).toBe(before);
        expect(NODES.map((node) => [node.id, node.parent])).toEqual([
            [1, null],
            [2, 1],
            [3, 2],
            [4, 2],
            [5, 2],
            [6, 1],
            [7, 6],
            [8, 6],
        ]);
    });
});

describe('何も選んでいないときに選ぶノード (startNode)', () => {
    it('カーソルがウィンドウの外 (null) ならルートを選ぶ (B-089)', () => {
        expect(startNode(null, NODES, LAID_OUT)).toBe(1);
        // ルートが画面の外へパンされていても (矩形がどこにあっても) ルート
        const panned = rectsOf([...LAID_OUT, [1, box(-900, -700)]]);
        expect(startNode(null, NODES, panned)).toBe(1);
    });

    it('カーソルがノードの箱の上なら、そのノードを選ぶ (B-089)', () => {
        const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        for (const [id, rect] of LAID_OUT) expect(startNode(center(rect), NODES, LAID_OUT), `ノード ${id}`).toBe(id);
    });

    it('カーソルが何もないところなら、いちばん近いノードを選ぶ (B-089)', () => {
        // どれも、箱までの距離と中心までの距離のどちらで測っても同じノードがいちばん近い点
        const cases: Array<{ pointer: Point; expected: number }> = [
            // A1 の右
            { pointer: { x: 530, y: 60 }, expected: 3 },
            // B2 の下
            { pointer: { x: 450, y: 410 }, expected: 8 },
            // ルートの左
            { pointer: { x: -40, y: 220 }, expected: 1 },
            // A の左上
            { pointer: { x: 180, y: 70 }, expected: 2 },
            // 図の全体から遠く離れた右下 (B2 がいちばん近い)
            { pointer: { x: 2000, y: 1500 }, expected: 8 },
        ];
        for (const { pointer, expected } of cases) expect(startNode(pointer, NODES, LAID_OUT), JSON.stringify(pointer)).toBe(expected);
    });

    it('近さは rects にある (見えている) ノードだけで比べる (B-089)', () => {
        // A1 の左の点。開いた図では A1、A を閉じた図では見えていない A1 を選ばず、見えている中でいちばん近い A を選ぶ
        const pointer: Point = { x: 380, y: 50 };
        expect(startNode(pointer, NODES, LAID_OUT)).toBe(3);
        const folded = rectsOf([...LAID_OUT].filter(([id]) => ![3, 4, 5].includes(id)));
        expect(startNode(pointer, NODES, folded)).toBe(2);
    });
});

describe('型', () => {
    it('型: parsed.nodes (OutlineNode[]) と view.nodeRects の値をそのまま渡せ、戻り値はノードの id か null', () => {
        expectTypeOf<OutlineNode>().toExtend<NavigationNode>();
        expectTypeOf<OutlineNode[]>().toExtend<readonly NavigationNode[]>();
        expectTypeOf<Map<number, Rect>>().toExtend<ReadonlyMap<number, Rect>>();
        expectTypeOf(arrowTarget).parameters.toEqualTypeOf<[ArrowKey, number, readonly NavigationNode[], ReadonlyMap<number, Rect>]>();
        expectTypeOf(arrowTarget).returns.toEqualTypeOf<number | null>();
        expectTypeOf(startNode).parameters.toEqualTypeOf<[Point | null, readonly NavigationNode[], ReadonlyMap<number, Rect>]>();
        expectTypeOf(startNode).returns.toEqualTypeOf<number | null>();
        // 名前は KeyboardEvent の key と同じ
        expectTypeOf<ArrowKey>().toEqualTypeOf<'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'>();
    });

    it('型: MarkdagEditor の getSelection は EditorSelection を返し、EditorOptions の onSelectionChange は EditorSelection を受ける (1.2。2 つ以上のグループは編集の層の選択の型だけに足す)', () => {
        expectTypeOf<MarkdagEditor['getSelection']>().toEqualTypeOf<() => EditorSelection>();
        expectTypeOf<NonNullable<EditorOptions['onSelectionChange']>>().toEqualTypeOf<(selection: EditorSelection) => void>();
        expectTypeOf<EditorOptions>().toHaveProperty('onSelectionChange');
    });
});

// 編集の層の選択の値 (DOM を使わない部品) を、選択の状態の遷移ごとに確かめる。
// ノードは id と refText で指し、並びは選んだ順 (最後が最後に選んだノード)。グループは 1 つなら group、2 つ以上なら groups (選んだ順)。
// 線は種類と両端だけを持つ。描き直したあとは、同じ id で refText も同じノードだけを残し、線とグループは文書に残っていれば残す。
// どの部品も入力を書き換えないよう、凍らせて渡す
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/core';
import { isAdditive } from '../src/editor/pointer';
import type { EdgeTarget, NodeTarget, ViewDocument } from '../src/core';
import {
    NO_SELECTION,
    addNodes,
    drawnParts,
    edgeKeyOf,
    edgeSelection,
    groupSelection,
    groupsSelection,
    keepDrawn,
    lastSelectedNode,
    nodesSelection,
    sameNodeSet,
    sameSelection,
    selectedEdge,
    selectedGroup,
    selectedGroups,
    selectedNodes,
    targetOf,
    toggleGroup,
    toggleNode,
    type DrawnParts,
    type EditorSelection,
} from '../src/editor/selection';

const t = (id: number, refText: string): NodeTarget => Object.freeze({ id, refText });
const nodes = (...targets: NodeTarget[]): EditorSelection => Object.freeze({ kind: 'nodes', nodes: Object.freeze([...targets]) as NodeTarget[] });
const group = (id: string): EditorSelection => Object.freeze({ kind: 'group', id });
const groups = (...ids: string[]): EditorSelection => Object.freeze({ kind: 'groups', ids: Object.freeze([...ids]) as string[] });
const edge = (kind: EdgeTarget['kind'], source: number, target: number): EditorSelection => Object.freeze({ kind: 'edge', edge: Object.freeze({ kind, source, target }) });
const NONE: EditorSelection = Object.freeze({ kind: 'none' });

const A = t(2, 'a');
const B = t(3, 'b');
const C = t(4, 'c');

describe('ノードの選択 (軸 C の c1、c2、c4)', () => {
    it('選んでいないのは none で、空のノードの並びも none になる (C1)', () => {
        expect(NO_SELECTION).toEqual({ kind: 'none' });
        expect(nodesSelection([])).toEqual({ kind: 'none' });
    });

    it('同じノードを 2 回指しても 1 つに数える', () => {
        expect(nodesSelection([A, t(2, 'a'), B])).toEqual({ kind: 'nodes', nodes: [A, B] });
    });

    it('修飾キー + ノード: 選んでいなければ最後に足し、選んでいれば外す (C1.c2、C2.c2、C3.c2)', () => {
        expect(toggleNode(NONE, A)).toEqual(nodes(A));
        expect(toggleNode(nodes(A), B)).toEqual(nodes(A, B));
        expect(toggleNode(nodes(A), A)).toEqual(NONE);
        expect(toggleNode(nodes(A, B, C), B)).toEqual(nodes(A, C));
        expect(toggleNode(nodes(A, B), A)).toEqual(nodes(B));
    });

    it('線、グループ、2 つ以上のグループを選んでいるときの修飾キー + ノードは、そのノードだけを選ぶ (種類を混ぜない。C4.c2、C5.c2、C6.c2)', () => {
        for (const from of [edge('depends', 2, 3), group('g'), groups('g', 'h')]) expect(toggleNode(from, A)).toEqual(nodes(A));
    });

    it('修飾キーつきの矩形選択の終わり: 囲んだノードを最後に足し、選んでいるものは外さない (C2.c4、C3.c4)', () => {
        expect(addNodes(nodes(A), [B, C])).toEqual(nodes(A, B, C));
        expect(addNodes(nodes(A, B), [B, C])).toEqual(nodes(A, B, C));
        expect(addNodes(NONE, [B])).toEqual(nodes(B));
        expect(addNodes(nodes(A), [])).toEqual(nodes(A));
    });

    it('線とグループを選んでいるときの修飾キーつきの矩形は、囲んだノードだけにする (線とグループには足さない。C4.c4、C5.c4、C6.c4)', () => {
        for (const from of [edge('depends', 2, 3), group('g'), groups('g', 'h')]) expect(addNodes(from, [B, C])).toEqual(nodes(B, C));
    });

    it('最後に選んだノードは並びの最後 (矢印キーの起点。B-091)', () => {
        expect(lastSelectedNode(nodes(A, B, C))).toEqual(C);
        expect(lastSelectedNode(toggleNode(nodes(C, A), B))).toEqual(B);
        expect(lastSelectedNode(NONE)).toBeNull();
        expect(lastSelectedNode(group('g'))).toBeNull();
    });

    it('選んでいるノードは、ノードの選択のときだけ返す', () => {
        expect(selectedNodes(nodes(A, B))).toEqual([A, B]);
        for (const other of [NONE, group('g'), groups('g', 'h'), edge('tree', 1, 2)]) expect(selectedNodes(other)).toEqual([]);
    });

    it('図のノードを指す値は id と refText だけ', () => {
        const drawn = core.parseDocument('# R\n- a\n').nodes[1];
        if (drawn === undefined) throw new Error('ノードがある');
        expect(targetOf(drawn)).toEqual({ id: 2, refText: 'a' });
    });
});

describe('グループの選択 (軸 C の c6、c7、c8。触る F-01)', () => {
    it('1 つは group、2 つ以上は選んだ順の groups、空は none。同じ名前は 1 つに数える', () => {
        expect(groupsSelection([])).toEqual(NONE);
        expect(groupsSelection(['g'])).toEqual(group('g'));
        expect(groupsSelection(['h', 'g'])).toEqual(groups('h', 'g'));
        expect(groupsSelection(['g', 'g'])).toEqual(group('g'));
        expect(groupSelection('g')).toEqual(group('g'));
    });

    it('修飾キー + 枠: なしなら 1 つ、1 つなら足して 2 つ以上、選んでいるグループなら外す (C1.c7、C5.c7)', () => {
        expect(toggleGroup(NONE, 'g')).toEqual(group('g'));
        expect(toggleGroup(group('g'), 'h')).toEqual(groups('g', 'h'));
        expect(toggleGroup(group('g'), 'g')).toEqual(NONE);
    });

    it('2 つ以上を選んでいるときの修飾キー + 枠は足し外しし、1 つになれば group に戻る (C6.c7)', () => {
        expect(toggleGroup(groups('g', 'h'), 'k')).toEqual(groups('g', 'h', 'k'));
        expect(toggleGroup(groups('g', 'h'), 'g')).toEqual(group('h'));
        expect(toggleGroup(groups('g', 'h', 'k'), 'h')).toEqual(groups('g', 'k'));
    });

    it('ノードと線を選んでいるときの修飾キー + 枠は、そのグループ 1 つにする (種類を混ぜない。C2.c7、C3.c7、C4.c7)', () => {
        for (const from of [nodes(A), nodes(A, B), edge('depends', 2, 3)]) expect(toggleGroup(from, 'g')).toEqual(group('g'));
    });

    it('選んでいるグループの名前: 1 つだけのときの名前と、選んだ順の全部', () => {
        expect(selectedGroup(group('g'))).toBe('g');
        expect(selectedGroup(groups('g', 'h'))).toBeNull();
        expect(selectedGroup(nodes(A))).toBeNull();
        expect(selectedGroups(group('g'))).toEqual(['g']);
        expect(selectedGroups(groups('h', 'g'))).toEqual(['h', 'g']);
        for (const other of [NONE, nodes(A), edge('tree', 1, 2)]) expect(selectedGroups(other)).toEqual([]);
    });
});

describe('線の選択 (軸 C の c5)', () => {
    it('図の線の値から種類と両端だけを取る (design 3.6 の EdgeTarget)', () => {
        const placed = { kind: 'depends', source: 2, target: 5, points: [[0, 0]], color: '#000' } as unknown as EdgeTarget;
        const selection = edgeSelection(placed);
        expect(selection).toEqual({ kind: 'edge', edge: { kind: 'depends', source: 2, target: 5 } });
        expect(selectedEdge(selection)).toEqual({ kind: 'depends', source: 2, target: 5 });
        expect(selectedEdge(nodes(A))).toBeNull();
    });

    it('図の強調 (selectEdge) に渡す線のキーは 種類:始点>終点 (design 2.3)', () => {
        expect(edgeKeyOf({ kind: 'depends', source: 2, target: 5 })).toBe('depends:2>5');
        expect(edgeKeyOf({ kind: 'tree', source: 1, target: 2 })).toBe('tree:1>2');
        expect(edgeKeyOf({ kind: 'join', source: 10, target: 3 })).toBe('join:10>3');
    });
});

describe('同じ選択か', () => {
    it('種類と中身が同じなら同じ。ノードは id と refText で比べる', () => {
        expect(sameSelection(NONE, nodesSelection([]))).toBe(true);
        expect(sameSelection(nodes(A, B), nodes(t(2, 'a'), t(3, 'b')))).toBe(true);
        expect(sameSelection(nodes(A), nodes(t(2, 'x')))).toBe(false);
        expect(sameSelection(nodes(A), NONE)).toBe(false);
        expect(sameSelection(group('g'), group('g'))).toBe(true);
        expect(sameSelection(group('g'), groups('g', 'h'))).toBe(false);
        expect(sameSelection(groups('g', 'h'), groups('g', 'h'))).toBe(true);
        expect(sameSelection(edge('depends', 2, 3), edge('depends', 2, 3))).toBe(true);
        expect(sameSelection(edge('depends', 2, 3), edge('chain', 2, 3))).toBe(false);
        expect(sameSelection(edge('depends', 2, 3), edge('depends', 3, 2))).toBe(false);
    });

    it('同じノードの集まりかは並びを見ない', () => {
        expect(sameNodeSet(nodes(A, B), nodes(B, A))).toBe(true);
        expect(sameNodeSet(nodes(A, B), nodes(A))).toBe(false);
        expect(sameNodeSet(NONE, group('g'))).toBe(true);
    });
});

// 1 R / 2 設計 (g) / 3 画面 / 4 API / 5 公開。depends 画面 → 公開
const DOC = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n    relations:\n        depends:\n            - 画面 --> 公開\n---\n# R\n## 設計 %g\n- 画面\n- API\n## 公開\n';

function documentOf(source: string): ViewDocument {
    const parsed = core.parseDocument(source);
    return { parsed, model: core.buildModel(parsed.nodes, parsed.frontmatter, source) };
}

function drawnOf(source: string): DrawnParts {
    return drawnParts(documentOf(source));
}

describe('描き直したあとの選び直し (軸 C の c13〜c15、design 5.3、B-004)', () => {
    it('描いている文書の中身はノード、関係の線、グループの名前。文書がなければ空', () => {
        const drawn = drawnOf(DOC);
        expect(drawn.nodes.map((node) => [node.id, node.refText, node.parent])).toEqual([
            [1, 'R', null],
            [2, '設計', 1],
            [3, '画面', 2],
            [4, 'API', 2],
            [5, '公開', 1],
        ]);
        expect(drawn.relations.map(({ kind, source, target }) => ({ kind, source, target }))).toEqual([{ kind: 'depends', source: 3, target: 5 }]);
        expect(drawn.groups).toEqual(['g']);
        expect(drawnParts(null)).toEqual({ nodes: [], relations: [], groups: [] });
    });

    it('ノード 1 つ: 同じ id で refText も同じなら保ち、名前が変わったか id がなくなれば解く (C2.c15)', () => {
        const selected = nodes(t(3, '画面'));
        expect(keepDrawn(selected, drawnOf(DOC))).toEqual(selected);
        // ほかのノードの名前の変更では保つ
        const otherRenamed = core.editSource(DOC, { kind: 'renameNode', node: t(4, 'API'), label: 'サーバー' });
        if (otherRenamed.status !== 'edited') throw new Error(JSON.stringify(otherRenamed));
        expect(keepDrawn(selected, drawnOf(otherRenamed.source))).toEqual(selected);
        // 選んでいるノードの名前が変わると、同じ id でも選ばない
        const renamed = core.editSource(DOC, { kind: 'renameNode', node: t(3, '画面'), label: '画面設計' });
        if (renamed.status !== 'edited') throw new Error(JSON.stringify(renamed));
        expect(keepDrawn(selected, drawnOf(renamed.source))).toEqual(NONE);
        // 行がずれて同じ id が別のノードになった文書でも選ばない
        expect(keepDrawn(selected, drawnOf('# R\n## 設計\n- 新しい行\n- 画面\n'))).toEqual(NONE);
        expect(keepDrawn(nodes(t(9, 'x')), drawnOf(DOC))).toEqual(NONE);
    });

    it('ノード 2 つ以上: 残ったノードだけを選んだ順で保ち、1 つなら 1 つ、0 なら none (C3.c15)', () => {
        const selected = nodes(t(4, 'API'), t(3, '画面'), t(5, '公開'));
        expect(keepDrawn(selected, drawnOf(DOC))).toEqual(selected);
        expect(keepDrawn(selected, drawnOf('# R\n## 設計\n- 画面\n- サーバー\n## 公開\n'))).toEqual(nodes(t(3, '画面'), t(5, '公開')));
        expect(keepDrawn(selected, drawnOf('# R\n## 設計\n- 画面\n'))).toEqual(nodes(t(3, '画面')));
        expect(keepDrawn(selected, drawnOf('# X\n'))).toEqual(NONE);
    });

    it('線: 文書にまだあれば保つ。木の線は終点の親が始点、関係の線は同じ種類と両端 (C4.c15)', () => {
        expect(keepDrawn(edge('depends', 3, 5), drawnOf(DOC))).toEqual(edge('depends', 3, 5));
        expect(keepDrawn(edge('tree', 2, 3), drawnOf(DOC))).toEqual(edge('tree', 2, 3));
        expect(keepDrawn(edge('tree', 1, 3), drawnOf(DOC))).toEqual(NONE);
        expect(keepDrawn(edge('chain', 3, 5), drawnOf(DOC))).toEqual(NONE);
        expect(keepDrawn(edge('depends', 5, 3), drawnOf(DOC))).toEqual(NONE);
        // 関係の項目を消した文書では解く
        const withoutRelation = DOC.replace('    relations:\n        depends:\n            - 画面 --> 公開\n', '');
        expect(keepDrawn(edge('depends', 3, 5), drawnOf(withoutRelation))).toEqual(NONE);
    });

    it('グループ: 文書にまだあれば保つ (C5.c15)', () => {
        expect(keepDrawn(group('g'), drawnOf(DOC))).toEqual(group('g'));
        expect(keepDrawn(group('h'), drawnOf(DOC))).toEqual(NONE);
    });

    it('グループ 2 つ以上: 残ったグループだけを保ち、1 つなら group、0 なら none (C6.c15)', () => {
        const two = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n        h:\n            label: H\n---\n# R\n- a %g\n- b %h\n';
        expect(keepDrawn(groups('h', 'g'), drawnOf(two))).toEqual(groups('h', 'g'));
        expect(keepDrawn(groups('h', 'g', 'k'), drawnOf(two))).toEqual(groups('h', 'g'));
        expect(keepDrawn(groups('h', 'k'), drawnOf(two))).toEqual(group('h'));
        expect(keepDrawn(groups('k', 'm'), drawnOf(two))).toEqual(NONE);
    });

    it('選んでいなければ none のまま (C1.c15)', () => {
        expect(keepDrawn(NONE, drawnOf(DOC))).toEqual(NONE);
    });
});

describe('選択に足す・外す修飾キー (B-062、G-021)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const press = (keys: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): MouseEvent =>
        ({ shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...keys }) as MouseEvent;

    it('macOS では Shift と ⌘ だけ (Ctrl +クリックは右クリックになる)', () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' });
        expect(isAdditive(press({ shiftKey: true }))).toBe(true);
        expect(isAdditive(press({ metaKey: true }))).toBe(true);
        expect(isAdditive(press({ ctrlKey: true }))).toBe(false);
        expect(isAdditive(press({ altKey: true }))).toBe(false);
        expect(isAdditive(press({}))).toBe(false);
    });

    it('ほかの OS は Shift、Ctrl、⌘', () => {
        vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
        expect(isAdditive(press({ shiftKey: true }))).toBe(true);
        expect(isAdditive(press({ ctrlKey: true }))).toBe(true);
        expect(isAdditive(press({ metaKey: true }))).toBe(true);
        expect(isAdditive(press({ altKey: true }))).toBe(false);
        expect(isAdditive(press({}))).toBe(false);
    });
});

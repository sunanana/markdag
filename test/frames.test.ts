import { describe, expect, it } from 'vitest';
import type { LayoutInput } from '../src/layout/input-types';
import { layoutChildrenOf } from '../src/layout/layout';
import { project } from '../src/layout/project';
import { computeFrames, countIntruders, frameClearance, frameOutline, framePadding, frameRect, frameSpacing, LABEL_HEIGHT } from '../src/view/frames';
import type { GroupDef } from '../src/model/model';

// 1 root / 2 仕様策定 (dev) / 3 画面開発 (frontend) / 4, 5 その子 / 6 API開発 (backend) / 7, 8 その子 / 9 効果測定 (backend, frontend)
const PARENTS: Array<number | null> = [null, 1, 2, 3, 3, 2, 6, 6, 1];
const input: LayoutInput = {
    name: 'nested-groups',
    nodes: PARENTS.map((_, index) => ({ id: index + 1, label: `n${index + 1}`, width: 40, height: 20, tags: [] })),
    treeEdges: PARENTS.flatMap((parent, index) => (parent === null ? [] : [{ source: parent, target: index + 1 }])),
    relations: [],
    suppressRootLine: [],
    folded: [],
};
const group = (id: string): GroupDef => ({ id, label: id, color: '#888', boundary: true, defined: true });
const model = {
    groups: [group('dev'), group('backend'), group('frontend')],
    groupsOf: new Map<number, string[]>([
        [1, []],
        [2, ['dev']],
        [3, ['dev', 'frontend']],
        [4, ['dev', 'frontend']],
        [5, ['dev', 'frontend']],
        [6, ['dev', 'backend']],
        [7, ['dev', 'backend']],
        [8, ['dev', 'backend']],
        [9, ['backend', 'frontend']],
    ]),
};

describe('グループの枠', () => {
    const graph = project(input);
    const frames = computeFrames(graph, model, layoutChildrenOf(graph));
    const frameOf = (id: string) => frames.find((frame) => frame.group.id === id);

    it('内側に枠を含む枠は、入れ子の段数を持つ。1 ノードだけのまとまりは枠にしない', () => {
        expect(frames.map((frame) => [frame.group.id, frame.members, frame.level])).toEqual([
            ['dev', [2, 3, 4, 5, 6, 7, 8], 1],
            ['backend', [6, 7, 8], 0],
            ['frontend', [3, 4, 5], 0],
        ]);
    });

    it('外側の枠は、内側の枠より四辺とも同じ幅 (22px) だけ外に出る', () => {
        const bounds = { x: 100, y: 50, width: 300, height: 120 };
        for (const level of [1, 2]) {
            const inner = frameRect(bounds, level - 1);
            const outer = frameRect(bounds, level);
            expect(inner.x - outer.x).toBe(22);
            expect(inner.y - outer.y).toBe(22);
            expect(outer.x + outer.width - (inner.x + inner.width)).toBe(22);
            expect(outer.y + outer.height - (inner.y + inner.height)).toBe(22);
        }
    });

    it('枠の外のノードとの間には、上側だけ、枠の上に置くラベルの行のぶんを余白に足す', () => {
        for (const level of [0, 1]) {
            expect(frameClearance(level).top).toBe(framePadding(level).top + LABEL_HEIGHT);
            expect(frameClearance(level).bottom).toBe(framePadding(level).bottom);
        }
    });

    it('隣り合うノードの間隔には、片方だけを含む枠の余白とラベルの行を足す', () => {
        const spacing = frameSpacing(frames);
        const level0 = frameClearance(0);
        const level1 = frameClearance(1);
        // 同じ枠の中どうし
        expect(spacing(4, 5)).toBe(0);
        // フロントエンドの枠の下と、バックエンドの枠の上 (どちらも開発の枠の中)
        expect(spacing(5, 7)).toBe(level0.bottom + level0.top);
        // 開発の枠の外のノードが下に来るときは、外側の枠の下の余白が入るだけ空ける。上に来るときは、上の余白とラベルの行
        expect(spacing(8, 9)).toBe(level1.bottom);
        expect(spacing(9, 2)).toBe(level1.top);
        expect(spacing(1, 9)).toBe(0);
        expect(frameOf('dev')?.level).toBe(1);
    });

    it('前回の配置の結果があれば、枠が上下に張り出すぶんだけ、メンバーでない隣のノードとの間隔を空ける', () => {
        const frontend = frameOf('frontend');
        if (!frontend) throw new Error('frontend の枠がない');
        const rect = (x: number, y: number) => ({ x, y, width: 40, height: 20 });
        // 3 = 画面開発、4 と 5 = その子 (上下に広がる)。9 (効果測定) は 3 のすぐ上にあり、子の列で決まる枠の上の端より下に来ている
        const rects = new Map([[3, rect(100, 50)], [4, rect(200, 20)], [5, rect(200, 80)], [9, rect(100, 25)], [6, rect(100, 75)]]);
        expect(frameOutline(frontend, rects)).toEqual({ x: 92, y: 12, width: 156, height: 96 });
        expect(countIntruders([frontend], rects)).toBe(2);

        const spacing = frameSpacing([frontend], rects);
        // 上のノードとの間は、枠の上の端 (y 12) まで上がれるだけの幅に、ラベルの行を足す。下のノードとの間は、枠の下の端 (y 108) まで
        expect(spacing(9, 3)).toBe(50 - 12 + LABEL_HEIGHT);
        expect(spacing(3, 6)).toBe(108 - 70);
        expect(spacing(4, 5)).toBe(0);
        // 枠の横の範囲 (x 92〜248) の外にあるノードは、縦にどこへ置いても枠に入らないので、その枠のぶんは空けない
        const outside = new Map([...rects, [7, rect(300, 60)]]);
        expect(frameSpacing([frontend], outside)(5, 7)).toBe(0);
        expect(frameSpacing([frontend], outside)(7, 5)).toBe(0);
        // 配置の結果がないうちは、枠の余白とラベルの行だけを見込む
        expect(frameSpacing([frontend])(9, 3)).toBe(frameClearance(0).top);
        expect(frameSpacing([frontend])(3, 6)).toBe(frameClearance(0).bottom);
    });

    it('メンバーが同じ 2 つの枠は、groups で先に定義されたほうを外側にする', () => {
        const same = {
            groups: [group('a'), group('b')],
            groupsOf: new Map<number, string[]>(PARENTS.map((_, index) => [index + 1, [3, 4, 5].includes(index + 1) ? ['a', 'b'] : []])),
        };
        const result = computeFrames(graph, same, layoutChildrenOf(graph));
        expect(result.map((frame) => [frame.group.id, frame.level])).toEqual([
            ['a', 1],
            ['b', 0],
        ]);
    });
});

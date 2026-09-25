import { describe, expect, it } from 'vitest';
import type { LayoutInput } from '../src/layout/input-types';
import { layoutDocument } from '../src/layout/layout';
import { frameClearance, frameOutline, framePadding, frameRect, LABEL_HEIGHT } from '../src/view/frames';
import type { GroupDef } from '../src/model/model';

// 枠のまとまりと入れ子の段数 (computeFrames) と、枠の余白の関数 (frameSpacing、countIntruders) は Rust にだけある (A-189)。
// ここでは公開の包み layoutDocument (射影、枠、配置を 1 回で行う) の返す枠と配置で確かめる。
// 余白の関数そのものの値 (元の試験の 4 件目と 5 件目の frameSpacing / countIntruders) は、同じ入力と期待値の
// Rust の試験 (crates/markdag-core/src/layout/frames.rs の frames_spacing_*) が見る

// 1 root / 2 仕様策定 (dev) / 3 画面開発 (frontend) / 4, 5 その子 / 6 API開発 (backend) / 7, 8 その子 / 9 効果測定 (backend, frontend)
const PARENTS: Array<number | null> = [null, 1, 2, 3, 3, 2, 6, 6, 1];
const input: LayoutInput = {
    name: 'nested-groups',
    nodes: PARENTS.map((_, index) => ({ id: index + 1, label: `n${index + 1}`, width: 40, height: 20, groups: [] })),
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
    const { frames } = layoutDocument(input, model);
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
        // 開発の枠 (段 1) が、フロントエンドとバックエンドの枠 (段 0) を囲む
        expect(frameOf('dev')?.level).toBe(1);
        // 配置では、枠に入り込むメンバーでないノードが残らない (枠の余白とラベルの行を間隔に足した結果)
        const { frames: placed, rects } = layoutDocument(input, model);
        for (const frame of placed) {
            const outline = frameOutline(frame, rects);
            expect(frame.outline).toEqual(outline);
            if (outline === null) throw new Error(`${frame.group.id} の枠の矩形がない`);
            for (const [id, rect] of rects) {
                if (frame.members.includes(id)) continue;
                const overlaps = rect.x < outline.x + outline.width && rect.x + rect.width > outline.x && rect.y < outline.y + outline.height && rect.y + rect.height > outline.y;
                expect(overlaps, `#${id} が ${frame.group.id} の枠に入り込む`).toBe(false);
            }
        }
    });

    it('前回の配置の結果があれば、枠が上下に張り出すぶんだけ、メンバーでない隣のノードとの間隔を空ける', () => {
        const frontend = frameOf('frontend');
        if (!frontend) throw new Error('frontend の枠がない');
        const rect = (x: number, y: number) => ({ x, y, width: 40, height: 20 });
        // 3 = 画面開発、4 と 5 = その子 (上下に広がる)。9 (効果測定) は 3 のすぐ上にあり、子の列で決まる枠の上の端より下に来ている
        const rects = new Map([[3, rect(100, 50)], [4, rect(200, 20)], [5, rect(200, 80)], [9, rect(100, 25)], [6, rect(100, 75)]]);
        expect(frameOutline(frontend, rects)).toEqual({ x: 92, y: 12, width: 156, height: 96 });
    });

    it('メンバーが同じ 2 つの枠は、groups で先に定義されたほうを外側にする', () => {
        const same = {
            groups: [group('a'), group('b')],
            groupsOf: new Map<number, string[]>(PARENTS.map((_, index) => [index + 1, [3, 4, 5].includes(index + 1) ? ['a', 'b'] : []])),
        };
        const result = layoutDocument(input, same).frames;
        expect(result.map((frame) => [frame.group.id, frame.level])).toEqual([
            ['a', 1],
            ['b', 0],
        ]);
    });
});

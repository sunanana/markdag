// 公開の入口の呼び出しの形 (省略できる引数) が Rust 化の前と同じであることを見る。
// 単体テストは DOM のない node の環境で回すので、render は描画の手前 (スタイルシートを差し込む所) まで進むことを確かめる
import { afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as core from '../src/core';
import { render } from '../src/index';
import type { LayoutInput } from '../src/layout/input-types';
import { project } from '../src/layout/project';
import { initFromFile } from '../src/wasm/node';

class ReachedDom extends Error {}

describe('既定の入口の render', () => {
    beforeAll(async () => {
        // src から読むと入口の隣に markdag.wasm がないので、ファイルの場所を探す Node 向けの init を使う (状態は入口の init と共有する)
        await initFromFile();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('options を省ける (型)', () => {
        expectTypeOf(render).toBeCallableWith({} as HTMLElement, '# a');
        expectTypeOf(core.render).toBeCallableWith({} as HTMLElement, '# a', {});
    });

    it('options の既定値がある (必須の引数は 2 つ)', () => {
        expect(render.length).toBe(2);
    });

    it('options を省いて呼ぶと、options を読む所で落ちずに DOM の操作まで進む', () => {
        vi.stubGlobal('document', {
            get head(): never {
                throw new ReachedDom();
            },
        });
        expect(() => render({} as HTMLElement, '# a\n\n- b\n')).toThrow(ReachedDom);
    });
});

describe('射影の入力のノードに groups の欄がない', () => {
    beforeAll(async () => {
        await initFromFile();
    });

    it('旧実装と同じく断らずに射影し、groups は空として読む (A-199)', () => {
        const input = {
            name: 'no-groups',
            nodes: [
                { id: 1, label: 'root', width: 40, height: 20, tags: [] },
                { id: 2, label: 'child', width: 40, height: 20 },
            ],
            treeEdges: [{ source: 1, target: 2 }],
            relations: [],
            suppressRootLine: [],
            folded: [],
        } as unknown as LayoutInput;
        const graph = project(input);
        expect(graph.nodes.map((node) => [node.id, node.groups])).toEqual([
            [1, []],
            [2, []],
        ]);
        expect(graph.layoutParent.get(2)).toBe(1);
    });
});

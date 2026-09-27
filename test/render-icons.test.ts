// render が markdag.icons.$ref の中身 (options.icons) を解析に渡すこと。
// 単体テストは DOM のない node の環境で回すので、描画の部品を差し替え、render が組み立てたモデルを受け取って見る
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphModel } from '../src/model/model';
import { render } from '../src/render';
import { initFromFile } from '../src/wasm/node';

const drawn: GraphModel[] = [];

vi.mock('../src/view/view', () => ({
    MarkdagView: class {
        setOptions(): void {}
        setDocument(_parsed: unknown, model: GraphModel): void {
            drawn.push(model);
        }
        setIconSvg(): void {}
        getFolded(): string[] {
            return [];
        }
        destroy(): void {}
    },
}));

const source = ['---', 'markdag:', '    icons:', '        $ref: ./team-icons.yaml', '        slack: "💬"', '---', '# R', '## :github: A', '## :slack: B'].join('\n');

const container = (): HTMLElement => ({ clientHeight: 100, style: {} }) as unknown as HTMLElement;

describe('render の icons (icons.$ref の中身)', () => {
    beforeAll(async () => {
        await initFromFile();
    });

    it('icons を渡すと icons-unresolved が出ず、$ref の表の alias がモデルに入る', () => {
        drawn.length = 0;
        const diagram = render(container(), source, { injectStyle: false, icons: { './team-icons.yaml': { github: 'simple-icons:github', slack: 'simple-icons:slack' } } });
        expect(diagram.diagnostics.map((item) => item.code)).not.toContain('icons-unresolved');
        const model = drawn.at(-1)!;
        expect(model.icons.aliases.get('github')).toBeDefined();
        // 同じ alias は文書の定義が勝つ
        expect(model.icons.aliases.get('slack')).not.toEqual(model.icons.aliases.get('github'));
        expect(JSON.stringify(model.icons.aliases.get('slack'))).toContain('💬');
        diagram.destroy();
    });

    it('icons を渡さなければ icons-unresolved になる (解析に渡す経路の対照)', () => {
        drawn.length = 0;
        const diagram = render(container(), source, { injectStyle: false });
        expect(diagram.diagnostics.map((item) => item.code)).toContain('icons-unresolved');
        expect(drawn.at(-1)!.icons.aliases.has('github')).toBe(false);
        diagram.destroy();
    });
});

// 入力の上限 (A-105 の (a)、A-156 の (b)) を、release の wasm (1 MiB のスタック) に境界を通して確かめる。
// 上限ちょうどの入力は trap せずに描け、上限を越えた入力は「入れ子が深すぎます」などの分かる診断か誤り (MarkdagError) になる。
import { describe, expect, it } from 'vitest';
import type { LayoutInput } from '../src/layout/input-types';
import { layoutDocument } from '../src/layout/layout';
import { project } from '../src/layout/project';
import { projectAndFrames } from '../src/view/frames';
import { buildModel, renderDocument, type Diagnostic } from '../src/model/model';
import { parseDocument } from '../src/parse/document';
import { MarkdagError } from '../src/wasm/boundary';

const MAX_NESTING = 500;
const MAX_YAML_NESTING = 100;

const nestedList = (depth: number): string => Array.from({ length: depth }, (_, index) => `${'  '.repeat(index)}- a${index}`).join('\n');
const quote = (depth: number): string => `# R\n\n${'>'.repeat(depth)} a`;
const strong = (depth: number): string => `# ${'**'.repeat(depth)}a${'**'.repeat(depth)}`;
const yamlFlow = (depth: number): string => `---\nmarkdag: {}\nx: ${'['.repeat(depth)}${']'.repeat(depth)}\n---\n# a\n`;
const yamlBlock = (depth: number): string =>
    `---\nmarkdag: {}\nx:\n${Array.from({ length: depth }, (_, index) => `${'  '.repeat(index + 1)}k${index}:`).join('\n')} 1\n---\n# a\n`;

const withCode = (diagnostics: Diagnostic[], code: string): Diagnostic[] => diagnostics.filter((item) => item.code === code);
const maxDepth = (nodes: Array<{ depth: number }>): number => Math.max(...nodes.map((node) => node.depth));

describe('Markdown の入れ子の上限', () => {
    it('上限ちょうどのリストは全部ノードになり、診断はない', () => {
        const { parsed, model } = renderDocument(nestedList(MAX_NESTING));
        expect(parsed.nodes).toHaveLength(MAX_NESTING);
        expect(maxDepth(parsed.nodes)).toBe(MAX_NESTING);
        expect(withCode(model.diagnostics, 'nesting-too-deep')).toEqual([]);
    });

    it('上限を 1 つ越えたリストは越えた段を外し、位置つきの誤りを出す', () => {
        const source = nestedList(MAX_NESTING + 1);
        const { parsed, model } = renderDocument(source);
        expect(parsed.nodes).toHaveLength(MAX_NESTING);
        expect(withCode(model.diagnostics, 'nesting-too-deep')).toEqual([
            {
                severity: 'error',
                code: 'nesting-too-deep',
                message: '入れ子が深すぎます (上限 500 段)。これより深い部分は図に出ません',
                at: { line: MAX_NESTING + 1, column: 2 * MAX_NESTING + 1, length: `- a${MAX_NESTING}`.length },
                hint: 'リスト、引用、強調などの入れ子を浅くします',
            },
        ]);
        // zu の経路 (parseDocument → buildModel) でも同じ診断
        const again = parseDocument(source);
        expect(withCode(buildModel(again.nodes, again.frontmatter, source).diagnostics, 'nesting-too-deep')).toHaveLength(1);
    });

    it('trap していた深さ (リスト 2000 段、引用 30000 段、強調 20000 段) も trap せずに診断になる', () => {
        for (const source of [nestedList(2000), quote(30_000), strong(20_000)]) {
            const { model } = renderDocument(source);
            expect(withCode(model.diagnostics, 'nesting-too-deep')).toHaveLength(1);
        }
    });

    it('引用と強調も上限ちょうどまでは通る', () => {
        for (const source of [quote(MAX_NESTING), strong(MAX_NESTING)]) {
            expect(withCode(renderDocument(source).model.diagnostics, 'nesting-too-deep')).toEqual([]);
        }
        for (const source of [quote(MAX_NESTING + 1), strong(MAX_NESTING + 1)]) {
            expect(withCode(renderDocument(source).model.diagnostics, 'nesting-too-deep')).toHaveLength(1);
        }
    });
});

describe('frontmatter の YAML の入れ子の上限', () => {
    it('上限ちょうどは読め、読んだ値を buildModel に渡し直せる (境界の JSON の再帰の上限より浅い)', () => {
        for (const source of [yamlFlow(MAX_YAML_NESTING - 1), yamlBlock(MAX_YAML_NESTING - 1)]) {
            const parsed = parseDocument(source);
            expect(parsed.extracted).toBe(true);
            expect(withCode(buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics, 'yaml-syntax')).toEqual([]);
        }
    });

    it('上限を越えると frontmatter を読めない誤りになる', () => {
        for (const source of [yamlFlow(MAX_YAML_NESTING), yamlBlock(MAX_YAML_NESTING), yamlBlock(5000)]) {
            const { parsed, model } = renderDocument(source);
            expect(parsed.extracted).toBe(false);
            const found = withCode(model.diagnostics, 'yaml-syntax');
            expect(found.map((item) => item.message)).toEqual(['frontmatter を YAML として読めません: 入れ子が深すぎます (上限 100 段)']);
        }
    });
});

const chain = (length: number, width = 40): LayoutInput => ({
    name: 'chain',
    nodes: Array.from({ length }, (_, index) => ({ id: index + 1, label: `n${index + 1}`, width, height: 20, groups: [] })),
    treeEdges: Array.from({ length: length - 1 }, (_, index) => ({ source: index + 1, target: index + 2 })),
    relations: [],
    suppressRootLine: [],
    folded: [],
});
const NO_GROUPS = { groups: [], groupsOf: new Map<number, string[]>() };

function layoutError(run: () => unknown): MarkdagError {
    try {
        run();
    } catch (error) {
        if (error instanceof MarkdagError) return error;
        throw error;
    }
    throw new Error('誤りにならなかった');
}

describe('配置の木の深さ (上限なし)', () => {
    it('旧実装が描けた深さ (1500 段) と描けなかった深さ (3000 段) を越えても配置できる', () => {
        for (const length of [1001, 1500, 3000, 20_000]) {
            expect(layoutDocument(chain(length), NO_GROUPS).rects.size).toBe(length);
        }
    });

    it('relations の付け替えで深くなる平らなリストも配置できる', () => {
        const count = 3000;
        const input = chain(count);
        input.treeEdges = Array.from({ length: count - 1 }, (_, index) => ({ source: 1, target: index + 2 }));
        input.relations = Array.from({ length: count - 2 }, (_, index) => ({ source: index + 2, target: index + 3, kind: 'chain' as const, origin: 'chain' }));
        input.suppressRootLine = Array.from({ length: count - 2 }, (_, index) => index + 3);
        expect(layoutDocument(input, NO_GROUPS).rects.size).toBe(count);
    });

    it('同じ 2 つのメンバーの枠 5000 個 (1 本の鎖の入れ子) も trap しない', () => {
        const count = 5000;
        const groups = Array.from({ length: count }, (_, index) => ({ id: `g${index}`, label: `g${index}`, color: null, boundary: true, defined: true }));
        const ids = groups.map((group) => group.id);
        const input = chain(1);
        input.nodes.push({ id: 2, label: 'n2', width: 40, height: 20, groups: ids }, { id: 3, label: 'n3', width: 40, height: 20, groups: ids });
        input.treeEdges = [{ source: 1, target: 2 }, { source: 1, target: 3 }];
        const model = { groups, groupsOf: new Map<number, string[]>([[2, ids], [3, ids]]) };
        const levels = layoutDocument(input, model).frames.map((frame) => frame.level);
        expect(levels).toHaveLength(count);
        expect(Math.max(...levels)).toBe(count - 1);
        expect(projectAndFrames(input, model, new Map([[1, [2, 3]]])).frames).toHaveLength(count);
    });
});

describe('配置の入口で弾く数 (A-156 の (b))', () => {
    it('NaN、無限大、絶対値 1e300 以上の幅と高さは layout-error (固まらない)', () => {
        const mini = (width: number): LayoutInput => {
            const input = chain(2, width);
            input.nodes.push({ id: 3, label: 'n3', width: 40, height: 20, groups: [] }, { id: 4, label: 'n4', width: 40, height: 20, groups: [] });
            input.treeEdges.push({ source: 2, target: 3 }, { source: 2, target: 4 });
            return input;
        };
        expect(layoutDocument(mini(1e299), NO_GROUPS).rects.size).toBe(4);
        for (const [width, shown] of [
            [Number.NaN, 'NaN'],
            [9e307, '9e+307'],
            [Number.POSITIVE_INFINITY, 'Infinity'],
            [-1e300, '-1e+300'],
        ] as const) {
            const message = `配置の入力の ノード 1 の width が ${shown} です。絶対値が 1e300 未満の有限の数にします`;
            const error = layoutError(() => layoutDocument(mini(width), NO_GROUPS));
            expect([error.code, error.message]).toEqual(['layout-error', message]);
            expect(layoutError(() => project(mini(width))).message).toBe(message);
        }
        const tall = mini(40);
        tall.nodes = tall.nodes.map((node) => (node.id === 4 ? { ...node, height: Number.NaN } : node));
        expect(layoutError(() => layoutDocument(tall, NO_GROUPS)).message).toBe('配置の入力の ノード 4 の height が NaN です。絶対値が 1e300 未満の有限の数にします');
    });
});

describe('生の HTML の見出し (A-112)', () => {
    it('見出しやリストと同じ並びの HTML の見出しに、位置つきの info を出す', () => {
        const source = '# R\n\n<h2>raw heading</h2>\n\n- a\n';
        const { parsed, model } = renderDocument(source);
        expect(parsed.nodes).toHaveLength(2);
        expect(withCode(model.diagnostics, 'html-heading-ignored')).toEqual([
            {
                severity: 'info',
                code: 'html-heading-ignored',
                message: 'この HTML の見出しは図に出ません。## 見出し で書きます',
                at: { line: 3, column: 1, length: 4 },
                hint: '見出しやリストと同じ並びに置いた生の HTML のブロックは、図のノードになりません',
            },
        ]);
    });

    it('項目の中の HTML の見出しは項目の内容として出るので、診断しない', () => {
        expect(withCode(renderDocument('# R\n\n- a\n\n  <h2>in item</h2>\n').model.diagnostics, 'html-heading-ignored')).toEqual([]);
    });

    it('コメントと生の文字の要素 (script、style) の中の見出しのタグは数えない', () => {
        for (const source of [
            '# R\n\n<!-- <h2>x</h2> -->\n',
            '# R\n\n<script>\nel.innerHTML = "<h1>x</h1>";\n</script>\n',
            '# R\n\n<style>\n/* <h3> */\n</style>\n',
        ]) {
            expect(withCode(renderDocument(source).model.diagnostics, 'html-heading-ignored')).toEqual([]);
        }
    });
});

describe('解析と同じ前処理で読み直す (本文の診断)', () => {
    it('行の末尾のタグの値に入れ子の印の字が並んでも、入れ子の誤りにしない', () => {
        for (const mark of ['*', '_', '^']) {
            const run = mark.repeat(1100);
            const source = `---\nmarkdag: {}\n---\n# R\n\n- a #k:${run}x${run}\n`;
            const { parsed, model } = renderDocument(source);
            expect(parsed.nodes.map((node) => node.refText)).toEqual(['R', 'a']);
            expect(withCode(model.diagnostics, 'nesting-too-deep')).toEqual([]);
            const again = parseDocument(source);
            expect(withCode(buildModel(again.nodes, again.frontmatter, source).diagnostics, 'nesting-too-deep')).toEqual([]);
        }
    });
});

describe('frontmatter の別名とフローの入れ子', () => {
    // a は錨つきの 49 段、b は depth 段の底で a を展開する。最上位の写像を合わせた深さは 1 + depth + 49
    const yamlAlias = (depth: number): string =>
        `---\nmarkdag: {}\na: &a ${'['.repeat(49)}1${']'.repeat(49)}\nb: ${'['.repeat(depth)}*a${']'.repeat(depth)}\n---\n# a\n`;
    const tooDeep = 'frontmatter を YAML として読めません: 入れ子が深すぎます (上限 100 段)';

    it('別名を展開した深さが上限ちょうどなら読め、buildModel に渡し直せる', () => {
        const source = yamlAlias(50);
        const parsed = parseDocument(source);
        expect(parsed.extracted).toBe(true);
        expect(withCode(buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics, 'yaml-syntax')).toEqual([]);
    });

    it('別名を展開して上限を越えると読めない frontmatter になり、buildModel は例外を投げない', () => {
        const nest = (depth: number, inner: string): string => `${'['.repeat(depth)}${inner}${']'.repeat(depth)}`;
        const chained = `---\nmarkdag: {}\na0: &a0 ${nest(98, '1')}\na1: &a1 ${nest(98, '*a0')}\n---\n# a\n`;
        for (const [source, line] of [
            [yamlAlias(51), 4],
            [chained, 4],
        ] as const) {
            const parsed = parseDocument(source);
            expect(parsed.extracted).toBe(false);
            const found = withCode(buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics, 'yaml-syntax');
            expect(found.map((item) => [item.message, item.at?.line])).toEqual([[tooDeep, line]]);
        }
    });

    it('saphyr が止まる深さ (256 段以上) のフローも同じ文面になる', () => {
        for (const depth of [256, 1000, 100_000]) {
            const found = withCode(renderDocument(yamlFlow(depth)).model.diagnostics, 'yaml-syntax');
            expect(found.map((item) => [item.message, item.at?.line])).toEqual([[tooDeep, 3]]);
        }
    });
});

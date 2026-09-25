// 包みが境界に送る HookSpec を、文書が宣言した ref だけから自分の持つキーで引いて作ることを見る (A-098、規則書 2.1 の obj[k] の行)。
// buildModel は frontmatter の markdag.hooks.$ref から、renderDocument は hookRefs の自分の持つキー (孤立したサロゲートのないもの) から作る。
// どちらも Rust が宣言した ref だけを引くので、宣言にない hookRefs のキーは結果に効かない
import { describe, expect, it } from 'vitest';
import { buildModel, renderDocument, type Diagnostic, type GraphModel } from '../src/model/model';
import { parseDocument } from '../src/parse/document';

const MISSING_HINT = '呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ)';
const INVALID_HINT = 'モジュールとして読めるか (名前付きの export があるか) 確かめます';

const onDocument = (): undefined => undefined;

function sourceOf(ref: string | string[]): string {
    const refs = Array.isArray(ref) ? `\n${ref.map((item) => `      - ${JSON.stringify(item)}`).join('\n')}` : ` ${JSON.stringify(ref)}`;
    return `---\nmarkdag:\n  hooks:\n    $ref:${refs}\n---\n\n# a\n\n- b\n`;
}

// 原文から buildModel と renderDocument の 2 つの経路でモデルを作る
function bothPaths(ref: string | string[], hookRefs: Record<string, unknown> | null | undefined): GraphModel[] {
    // null の hookRefs は型の外だが、旧実装と同じく空の写像として受ける (A-011)
    const extra = { hookRefs } as { hookRefs?: Record<string, unknown> };
    const source = sourceOf(ref);
    const parsed = parseDocument(source);
    return [buildModel(parsed.nodes, parsed.frontmatter, source, extra), renderDocument(source, extra).model];
}

const hooksOf = (model: GraphModel): Array<[string, string[]]> => model.hooks.hooks.map((hook) => [hook.ref, Object.keys(hook.module)]);
const hookDiagnostics = (model: GraphModel): Array<[Diagnostic['severity'], string | null]> =>
    model.diagnostics.filter((diagnostic) => diagnostic.code === 'hooks-unresolved').map((diagnostic) => [diagnostic.severity, diagnostic.hint]);

describe('宣言にない hookRefs のキー', () => {
    it('結果に効かない (宣言した ref だけを渡したときと同じ)', () => {
        const extra = { './a.js': { onDocument }, './x.js': 42, './y.js': null, toString: { onDocument } };
        const alone = bothPaths('./a.js', { './a.js': { onDocument } });
        bothPaths('./a.js', extra).forEach((model, index) => {
            expect(hooksOf(model)).toEqual([['./a.js', ['onDocument']]]);
            expect(model.diagnostics).toEqual(alone[index]?.diagnostics);
        });
    });

    it('buildModel は宣言にないモジュールの export を読まない', () => {
        const source = sourceOf('./a.js');
        const parsed = parseDocument(source);
        const undeclared = {
            get onDocument(): never {
                throw new Error('宣言にないモジュールを読んだ');
            },
        };
        const model = buildModel(parsed.nodes, parsed.frontmatter, source, { hookRefs: { './a.js': { onDocument }, './x.js': undeclared } });
        expect(hooksOf(model)).toEqual([['./a.js', ['onDocument']]]);
    });

    it('buildModel は frontmatter の途中の欄も自分の持つキーだけを見る', () => {
        const markdag = Object.create({ hooks: { $ref: './a.js' } }) as Record<string, unknown>;
        const model = buildModel([], { markdag }, undefined, { hookRefs: { './a.js': { onDocument } } });
        expect(model.hooks.hooks).toEqual([]);
        expect(hookDiagnostics(model)).toEqual([]);
    });
});

describe('宣言した ref が hookRefs にない', () => {
    it('hooks-unresolved の warning (渡したが見つからない)', () => {
        for (const model of bothPaths(['./a.js', './b.js'], { './b.js': { onDocument } })) {
            expect(hooksOf(model)).toEqual([['./b.js', ['onDocument']]]);
            expect(hookDiagnostics(model)).toEqual([['warning', MISSING_HINT]]);
            expect(model.diagnostics.find((diagnostic) => diagnostic.code === 'hooks-unresolved')?.message).toBe('markdag.hooks.$ref「./a.js」は読み込まれていないので、このフックは動きません');
        }
    });

    it('値が undefined なら見つからない、record でなければ読めない', () => {
        for (const model of bothPaths(['./a.js', './b.js', './c.js'], { './a.js': undefined, './b.js': null, './c.js': [onDocument] })) {
            expect(hookDiagnostics(model)).toEqual([
                ['warning', MISSING_HINT],
                ['warning', INVALID_HINT],
                ['warning', INVALID_HINT],
            ]);
        }
    });

    it('hookRefs が null は空の写像 (warning)、undefined は渡していない (info)', () => {
        for (const model of bothPaths('./a.js', null)) expect(hookDiagnostics(model)).toEqual([['warning', MISSING_HINT]]);
        for (const model of bothPaths('./a.js', undefined)) expect(hookDiagnostics(model).map(([severity]) => severity)).toEqual(['info']);
    });

    it('同じ ref を 2 度宣言しても、2 つとも同じモジュールを引く', () => {
        for (const model of bothPaths(['./a.js', './a.js'], { './a.js': { onDocument } })) {
            expect(hooksOf(model)).toEqual([
                ['./a.js', ['onDocument']],
                ['./a.js', ['onDocument']],
            ]);
        }
    });
});

describe('Object.prototype の名前の ref (accepted.md 11、12)', () => {
    it('hookRefs が {} なら __proto__ と toString などは hooks-unresolved の warning (prototype の値は引かない)', () => {
        for (const ref of ['__proto__', 'toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
            for (const model of bothPaths(ref, {})) {
                expect(model.hooks.hooks).toEqual([]);
                expect(hookDiagnostics(model)).toEqual([['warning', MISSING_HINT]]);
            }
        }
    });

    it('自分の持つ __proto__ のキーは、ほかのキーと同じくモジュールとして引く', () => {
        const hookRefs: Record<string, unknown> = {};
        Object.defineProperty(hookRefs, '__proto__', { value: { onDocument }, enumerable: true });
        for (const model of bothPaths('__proto__', hookRefs)) {
            expect(hooksOf(model)).toEqual([['__proto__', ['onDocument']]]);
            expect(hookDiagnostics(model)).toEqual([]);
        }
    });

    it('自分の持つ toString のキーは、ほかのキーと同じくモジュールとして引く', () => {
        for (const model of bothPaths('toString', { toString: { onDocument } })) expect(hooksOf(model)).toEqual([['toString', ['onDocument']]]);
    });

    it('列挙できない自分のキーも引く (hasOwn と同じ範囲)', () => {
        const hookRefs: Record<string, unknown> = {};
        Object.defineProperty(hookRefs, './a.js', { value: { onDocument }, enumerable: false });
        for (const model of bothPaths('./a.js', hookRefs)) expect(hooksOf(model)).toEqual([['./a.js', ['onDocument']]]);
    });

    it('prototype のない hookRefs でも同じ', () => {
        const hookRefs = Object.assign(Object.create(null) as Record<string, unknown>, { './a.js': { onDocument } });
        for (const model of bothPaths(['./a.js', 'toString'], hookRefs)) {
            expect(hooksOf(model)).toEqual([['./a.js', ['onDocument']]]);
            expect(hookDiagnostics(model)).toEqual([['warning', MISSING_HINT]]);
        }
    });

    it('types の $ref も prototype の値は引かない (types-unresolved の warning)', () => {
        for (const ref of ['__proto__', 'toString']) {
            const source = `---\nmarkdag:\n  types:\n    $ref: ${JSON.stringify(ref)}\n---\n\n# a\n`;
            const parsed = parseDocument(source);
            for (const model of [buildModel(parsed.nodes, parsed.frontmatter, source, { types: {} }), renderDocument(source, { types: {} }).model]) {
                expect(model.diagnostics.filter((diagnostic) => diagnostic.code === 'types-unresolved').map((diagnostic) => [diagnostic.severity, diagnostic.hint])).toEqual([
                    ['warning', expect.stringContaining('呼び出し側が読んで buildModel の types に渡します')],
                ]);
            }
        }
    });
});

describe('孤立したサロゲートを含む hookRefs のキー', () => {
    it('宣言にないなら結果に効かない (境界で U+FFFD になって宣言した ref の値を上書きしない)', () => {
        const hookRefs = { '�x': { onDocument }, '\ud800x': 'モジュールでない値', '\udc00y': { onDocument } };
        for (const model of bothPaths('�x', hookRefs)) {
            expect(hooksOf(model)).toEqual([['�x', ['onDocument']]]);
            expect(hookDiagnostics(model)).toEqual([]);
        }
    });

    it('宣言にないキーだけにあるときも、入力全体は読める', () => {
        for (const model of bothPaths('./a.js', { './a.js': { onDocument }, '\ud800': { onDocument } })) expect(hooksOf(model)).toEqual([['./a.js', ['onDocument']]]);
    });
});

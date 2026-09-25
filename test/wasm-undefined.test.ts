// 利用者の値 (frontmatter、types の値) の undefined を境界の往復で保つ印 `{ "$undefined": true }` (A-197)。
// 旧実装は値をメモリのまま渡していたので、undefined の欄は残り、診断もそれを前提にしていた
import { beforeAll, describe, expect, it } from 'vitest';
import { buildModel, checkFrontmatter, renderDocument } from '../src/model/model';
import { parseDocument } from '../src/parse/document';
import { renderStandalonePage } from '../src/standalone/page';
import { markUndefined, replaceMarks, reviveMarks } from '../src/wasm/boundary';
import { initFromFile } from '../src/wasm/node';

const send = (value: unknown): string => JSON.stringify(value, replaceMarks);
const receive = (text: string): unknown => JSON.parse(text, reviveMarks);

describe('印の書き方と読み方 (JS の側)', () => {
    it('markUndefined はオブジェクトの欄と配列の要素 (穴も) の undefined を印にし、元の値は変えない', () => {
        const original = { a: undefined, b: [1, undefined], c: { d: undefined }, e: null };
        expect(send(markUndefined(original))).toBe('{"a":{"$undefined":true},"b":[1,{"$undefined":true}],"c":{"d":{"$undefined":true}},"e":null}');
        // eslint-disable-next-line no-sparse-arrays
        expect(send(markUndefined([1, , 3]))).toBe('[1,{"$undefined":true},3]');
        expect(Object.keys(original)).toEqual(['a', 'b', 'c', 'e']);
        expect(markUndefined(undefined)).toBeUndefined();
    });

    it('印を付けない位置 (構造体の欄) は今までどおり JSON.stringify と同じに落とす', () => {
        expect(send({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
    });

    it('利用者の 1 欄の $undefined のオブジェクトは $object に包み、印と取り違えない', () => {
        expect(send(markUndefined({ x: { $undefined: true } }))).toBe('{"x":{"$object":[["$undefined",true]]}}');
        expect(send(markUndefined({ x: { $undefined: undefined } }))).toBe('{"x":{"$object":[["$undefined",{"$undefined":true}]]}}');
        expect(send(markUndefined({ x: { $undefined: true, y: 1 } }))).toBe('{"x":{"$undefined":true,"y":1}}');
    });

    it('reviveMarks は印を undefined に戻し、欄と配列の長さを残す', () => {
        const back = receive('{"a":{"$undefined":true},"b":[{"$undefined":true},null],"c":{"$object":[["$undefined",true]]},"d":{"$object":[["$undefined",{"$undefined":true}]]}}') as Record<string, unknown>;
        expect(Object.keys(back)).toEqual(['a', 'b', 'c', 'd']);
        expect(back.a).toBeUndefined();
        expect(back.b).toEqual([undefined, null]);
        expect((back.b as unknown[]).length).toBe(2);
        expect(Object.hasOwn(back.b as unknown[], 0)).toBe(true);
        expect(back.c).toEqual({ $undefined: true });
        const d = back.d as Record<string, unknown>;
        expect(Object.keys(d)).toEqual(['$undefined']);
        expect(d.$undefined).toBeUndefined();
    });

    it('印の形でないもの ($undefined が true でない、欄が 2 つ) は利用者のオブジェクトのまま', () => {
        expect(receive('{"$undefined":false}')).toEqual({ $undefined: false });
        expect(receive('{"$undefined":true,"b":1}')).toEqual({ $undefined: true, b: 1 });
    });
});

describe('境界を越える往復 (wasm)', () => {
    beforeAll(async () => {
        await initFromFile();
    });

    it('JS から送った undefined の欄は Rust で Undefined になり、値を書き添えずに警告する', () => {
        const diagnostics = checkFrontmatter({ markdag: { initialExpandLevel: undefined } });
        expect(diagnostics.map((item) => [item.code, item.message])).toEqual([['option-invalid', 'markdag.initialExpandLevel は整数で書きます']]);
    });

    it('配列の undefined の要素は null と区別する (値を書き添えない)', () => {
        expect(checkFrontmatter({ markdag: { branches: ['a', undefined] } }).map((item) => item.message)).toEqual(['markdag.branches[1] は文字列で書きます']);
        expect(checkFrontmatter({ markdag: { branches: ['a', null] } }).map((item) => item.message)).toEqual(['markdag.branches[1] は文字列で書きます (null)']);
    });

    it('parseDocument → buildModel の経路でも、1 回の経路 (renderDocument) と同じ診断になる', () => {
        const source = '---\nmarkmap:\n  initialExpandLevel: abc\n  color: 3\n  duration: y\nmarkdag:\n  initialExpandLevel: abc\n---\n# a\n';
        const parsed = parseDocument(source);
        expect(parsed.frontmatter.markmap).toEqual({ initialExpandLevel: 'abc', color: 3, duration: 'y' });
        const twoCalls = buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics;
        expect(twoCalls.map((item) => item.code)).toEqual(['option-removed', 'option-invalid']);
        expect(twoCalls).toEqual(renderDocument(source, {}).model.diagnostics);
    });

    it('利用者の書いた { $undefined: true } は値のまま往復する', () => {
        const source = '---\nfoo:\n  $undefined: true\nbar:\n  - $undefined: true\n---\n# a\n';
        const parsed = parseDocument(source);
        expect(parsed.frontmatter.foo).toEqual({ $undefined: true });
        expect(parsed.frontmatter.bar).toEqual([{ $undefined: true }]);
        const again = buildModel(parsed.nodes, parsed.frontmatter, source);
        expect(again.diagnostics).toEqual(renderDocument(source, {}).model.diagnostics);
        expect(checkFrontmatter({ markdag: { $undefined: true } }).map((item) => item.code)).toEqual(['option-unknown']);
    });

    it('types の値の undefined は「渡していない」と同じに扱う', () => {
        const source = '---\nmarkdag:\n  types:\n    $ref: ./t.yaml\n---\n# a\n';
        const withUndefined = buildModel([], { markdag: { types: { $ref: './t.yaml' } } }, source, { types: { './t.yaml': undefined } }).diagnostics;
        const without = buildModel([], { markdag: { types: { $ref: './t.yaml' } } }, source, {}).diagnostics;
        expect(withUndefined).toEqual(without);
        expect(withUndefined.map((item) => item.code)).toContain('types-unresolved');
    });

    it('構造体の欄の undefined (単体 HTML の指定) は今までどおり欄がないのと同じ', () => {
        const parsed = parseDocument('# a\n');
        const html = renderStandalonePage({ parsed, title: undefined, lang: undefined }, { script: 'var markdag = {};', style: '' });
        expect(html).toContain('<title>');
    });

    it('単体 HTML に埋める JSON は JSON.stringify と同じで、undefined の欄を落とし印を書かない', () => {
        const parsed = { ...parseDocument('# a\n'), frontmatter: { markdag: { initialExpandLevel: undefined } } };
        const html = renderStandalonePage({ parsed }, { script: 'var markdag = {};', style: '' });
        expect(html).not.toContain('$undefined');
        expect(html).toContain('"frontmatter":{"markdag":{}}');
    });
});

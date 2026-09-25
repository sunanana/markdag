// wasm の境界の試験。出す関数がそれぞれ中核の crate を直に呼んだ結果と同じ値を返すこと、
// 誤りの封筒が MarkdagError になること、panic のあとインスタンスが作り直されて次の呼び出しが通ること、
// 呼び出しを重ねても線形メモリが伸び続けないこと (alloc と free の釣り合い) を見る。
// 直の結果は cargo の example (crates/markdag-wasm/examples/direct_results.rs) が書き出す。
// panic の試験は `--features test-panic` の debug ビルド (mdag_test_panic を持つ) を別に作って使う。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callJson, callJsonText, init, type JsonFunction, MarkdagError, memoryBytes, ping, replaceMarks, reset, reviveMarks, WasmTrapError } from '../src/wasm';
import { callBytes, readPanicMessage, unpack, unsignedPtr, type WasmExports, writeBytes } from '../src/wasm/abi';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_WASM = `${root}target/wasm32-unknown-unknown/release/markdag_wasm.wasm`;
const PANIC_WASM = `${root}target/wasm32-unknown-unknown/debug/markdag_wasm.wasm`;
const CARGO_TIMEOUT = 600_000;

function cargo(args: string[]): string {
    const result = spawnSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`cargo ${args.join(' ')} が失敗した:\n${result.stderr}`);
    return result.stdout;
}

interface DirectCase {
    name: string;
    fn: JsonFunction;
    input: unknown;
    expected: { ok: unknown } | { error: { code: string; message: string } };
}

// 境界のレイヤーを通さない新しいインスタンス (線形メモリの状態を試験ごとに分けるため)
function freshExports(path: string): WasmExports {
    return new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {}).exports as unknown as WasmExports;
}

interface ModelOutput {
    diagnostics: Array<{ code: string; message: string }>;
    hooks: { declared: Array<{ ref: string; exports: string[] }> };
}

function call(fn: JsonFunction, input: unknown): { ok: unknown } | { error: { code: string; message: string } } {
    try {
        return { ok: callJson(fn, input) };
    } catch (error) {
        if (error instanceof MarkdagError) return { error: { code: error.code, message: error.message } };
        throw error;
    }
}

describe('wasm の出す関数 (release)', () => {
    let cases: DirectCase[] = [];
    // 同じ出力を印の変換を通さずに読んだもの。境界の JSON (Rust が書いた形) のまま比べる
    let rawCases: DirectCase[] = [];

    beforeAll(async () => {
        cargo(['build', '-q', '-p', 'markdag-wasm', '--target', 'wasm32-unknown-unknown', '--release']);
        const direct = cargo(['run', '-q', '-p', 'markdag-wasm', '--example', 'direct_results']);
        // 印 ($number / $object) は JS の値に戻して読み、callJson がもう一度印にして送る (往復も確かめる)
        cases = (JSON.parse(direct, reviveMarks) as { cases: DirectCase[] }).cases;
        rawCases = (JSON.parse(direct) as { cases: DirectCase[] }).cases;
        reset();
        await init(readFileSync(RELEASE_WASM));
    }, CARGO_TIMEOUT);

    afterAll(() => {
        reset();
    });

    it('設計文書 (b) の表の関数をすべて試す', () => {
        const covered = new Set(cases.map((item) => item.fn));
        const all: JsonFunction[] = [
            'parse_document',
            'build_model',
            'check_frontmatter',
            'render_document',
            'layout_document',
            'project_and_frames',
            'project',
            'toggle_task',
            'next_task_mark',
            'replace_leading_mark',
            'suggest_tag_keys',
            'suggest_tag_values',
            'standalone_page',
        ];
        expect([...covered].sort()).toEqual([...all].sort());
    });

    it('どの関数も中核の crate を直に呼んだ結果と同じ値を返す', () => {
        expect(cases.length).toBeGreaterThan(0);
        for (const item of cases) {
            expect(call(item.fn, item.input), `${item.fn}: ${item.name}`).toEqual(item.expected);
        }
    });

    it('印の変換を通さない生の JSON でも、中核の crate を直に呼んだ結果と同じ', () => {
        // reviveMarks / replaceMarks に誤りがあると、上の比較は期待値と実際の値の両方が同じように変わって見逃す。
        // ここでは (1) JS の値を送る形 (replaceMarks) が Rust の書いた境界の JSON と一致すること、
        // (2) Rust の書いた入力の JSON をそのまま送った出力が、Rust の書いた期待値の JSON と一致することを、どちらも印を戻さずに比べる
        expect(rawCases.length).toBe(cases.length);
        cases.forEach((item, index) => {
            const raw = rawCases[index] as DirectCase;
            const label = `${raw.fn}: ${raw.name}`;
            expect(JSON.parse(JSON.stringify(item.input, replaceMarks)), label).toEqual(raw.input);
            expect(JSON.parse(callJsonText(raw.fn, JSON.stringify(raw.input))), label).toEqual(raw.expected);
        });
    });

    it('types と hooks も非 null の項目がある', () => {
        const withTypes = rawCases.filter((item) => (item.input as { types?: unknown }).types != null);
        expect(withTypes.map((item) => item.fn)).toEqual(expect.arrayContaining(['build_model', 'render_document']));
        const withSourceNull = rawCases.filter((item) => item.fn === 'check_frontmatter' && (item.input as { source?: unknown }).source === null);
        expect(withSourceNull.length).toBeGreaterThan(0);
    });

    it('印の変換は手で書いた境界の JSON と対応する (Rust を通さない)', () => {
        const wire = '{"a":{"$object":[["$number","NaN"]]},"b":{"$number":"-Infinity"},"c":{"$object":[["$object",[["k",1]]]]},"d":[{"$number":"NaN"}],"e":{"$number":"x"}}';
        const value = { a: { $number: 'NaN' }, b: Number.NEGATIVE_INFINITY, c: { $object: [['k', 1]] }, d: [Number.NaN], e: { $object: [['$number', 'x']] } };
        const decoded = JSON.parse(wire, reviveMarks) as Record<string, unknown>;
        expect(decoded.a).toEqual(value.a);
        expect(decoded.b).toBe(value.b);
        expect(decoded.c).toEqual(value.c);
        expect(decoded.d).toEqual(value.d);
        // 印の文字でない $number は包みのない形では届かない (JS は包む) ので、そのままのオブジェクトになる
        expect(decoded.e).toEqual({ $number: 'x' });
        expect(JSON.parse(JSON.stringify({ a: value.a, b: value.b, c: value.c, d: value.d }, replaceMarks))).toEqual(JSON.parse(wire.replace(/,"e":.*\}$/, '}')));
    });

    it('types と hooks の写像のキーが $number / $object でも Rust に同じキーで届く', () => {
        const source = (ref: string): string =>
            `---\nmarkdag:\n  types:\n    $ref: ${ref}\n  tags:\n    keys:\n      owner: { type: fromMark }\n  hooks:\n    $ref: ${ref}\n---\n\n# root #owner:me\n`;
        const types = (key: string): Record<string, unknown> => ({ [key]: { fromMark: { type: 'string' }, inf: Number.POSITIVE_INFINITY, user: { $number: 'NaN' } } });
        const hooks = (key: string): Record<string, unknown> => ({ [key]: { kind: 'module', exports: [['decorateNode', true]] } });
        for (const key of ['$number', '$object']) {
            const { model } = callJson<{ model: ModelOutput }>('render_document', { source: source(key), types: types(key), hooks: hooks(key) });
            expect(model.diagnostics.map((item) => item.code), key).not.toContain('types-unresolved');
            expect(model.hooks.declared, key).toEqual([{ ref: key, exports: ['decorateNode'] }]);
            const built = callJson<ModelOutput>('build_model', { nodes: [], frontmatter: { markdag: { hooks: { $ref: key } } }, source: null, types: null, hooks: { [key]: { kind: 'invalid' } } });
            expect(built.diagnostics.map((item) => item.code), key).toContain('hooks-unresolved');
        }
        // 対照: 1 字違いのキーなら読めない型として報告される (上の検査が types-unresolved を見分けられること)
        const { model } = callJson<{ model: ModelOutput }>('render_document', { source: source('$numbe'), types: types('$number'), hooks: null });
        expect(model.diagnostics.map((item) => item.code)).toContain('types-unresolved');
    });

    it('線形メモリの場所は符号なしで読む (2^31 以上の ptr)', () => {
        // wasm の i64 は符号つきの BigInt で届く。上位 32 bit が 2^31 以上なら負の数になるので、符号なしに直して読む
        const ptr = 2_202_031_672;
        const signed = BigInt.asIntN(64, (BigInt(ptr) << 32n) | 3n);
        expect(signed < 0n).toBe(true);
        expect(unpack(signed)).toEqual({ ptr, len: 3 });
        expect(unpack((BigInt(0xffff_ffff) << 32n) | 0xffff_ffffn)).toEqual({ ptr: 0xffff_ffff, len: 0xffff_ffff });
        expect(unpack(BigInt.asIntN(64, 0xffff_ffff_ffff_ffffn))).toEqual({ ptr: 0xffff_ffff, len: 0xffff_ffff });
        // mdag_alloc の戻り値 (i32) も符号つきの number で届く (レビューの 2.2 GB の実測で -2092935656)
        expect(unsignedPtr(-2_092_935_656)).toBe(2_202_031_640);
        expect(unsignedPtr(1024)).toBe(1024);
    });

    // 線形メモリを 2 GiB 越えまで伸ばすので既定では走らせない。MARKDAG_WASM_BIG_MEMORY=1 のときだけ
    it.skipIf(process.env.MARKDAG_WASM_BIG_MEMORY !== '1')('2 GiB を越えた場所でも書いて呼んで読める', () => {
        const exports = freshExports(RELEASE_WASM);
        exports.mdag_alloc(1_100_000_000);
        exports.mdag_alloc(1_100_000_000);
        expect(exports.memory.buffer.byteLength).toBeGreaterThan(2 ** 31);
        const input = new TextEncoder().encode('{"a":1}');
        const high = writeBytes(exports, input);
        expect(high.ptr).toBeGreaterThanOrEqual(2 ** 31);
        exports.mdag_free(high.ptr, high.len);
        expect(new TextDecoder().decode(callBytes(exports, 'echo', input))).toBe('{"a":1}');
        const envelope = new TextDecoder().decode(callBytes(exports, 'parse_document', new TextEncoder().encode('{"source":"# a"}')));
        expect(JSON.parse(envelope)).toHaveProperty('ok.nodes');
    });

    it('有限でない数と、印とぶつかる利用者のオブジェクトを JS の値に戻す', () => {
        const parsed = callJson<{ frontmatter: Record<string, unknown> }>('parse_document', { source: '---\nmarkdag: {}\nx:\n  $number: NaN\ny: .inf\n---\n\n# root\n' });
        expect(parsed.frontmatter.x).toEqual({ $number: 'NaN' });
        expect(parsed.frontmatter.y).toBe(Number.POSITIVE_INFINITY);
    });

    it('JS の NaN と Infinity を印にして送る', () => {
        expect(callJson('toggle_task', { source: '- [ ] a', line: Number.NaN, cycle: null })).toBeNull();
        expect(callJson('toggle_task', { source: '- [ ] a', line: Number.POSITIVE_INFINITY, cycle: null })).toBeNull();
        expect(callJson('toggle_task', { source: '- [ ] a', line: 0, cycle: null })).toEqual({ line: 0, text: '- [x] a' });
    });

    it('入力の JSON が契約に合わなければ invalid-input の MarkdagError', () => {
        expect(() => callJson('parse_document', {})).toThrow(MarkdagError);
        expect(call('parse_document', {})).toMatchObject({ error: { code: 'invalid-input' } });
        expect(call('next_task_mark', { mark: 'X', cycle: [' '] })).toMatchObject({ error: { code: 'invalid-input' } });
        expect(call('toggle_task', { source: '', line: '0', cycle: null })).toMatchObject({ error: { code: 'invalid-input' } });
        // 誤りのあとも同じインスタンスで呼べる (trap ではない)
        expect(ping(1)).toBe(2);
    });

    it('配置の誤りは layout-error の MarkdagError', () => {
        const empty = { name: 'empty', nodes: [], treeEdges: [], relations: [], suppressRootLine: [], folded: [] };
        expect(call('project', { input: empty })).toEqual({ error: { code: 'layout-error', message: '入力にノードがない' } });
    });

    it('1000 回呼んでも線形メモリが伸び続けない (alloc と free の釣り合い)', () => {
        const source = readFileSync(`${root}docs/examples/notation.md`, 'utf8');
        // 最初の数回でアロケータが場所を取り終えるのを待ってから測る
        for (let index = 0; index < 20; index += 1) callJson('render_document', { source, types: null, hooks: null });
        const before = memoryBytes();
        for (let index = 0; index < 1000; index += 1) {
            callJson('render_document', { source, types: null, hooks: null });
            call('parse_document', {});
        }
        expect(memoryBytes()).toBe(before);
    });
});

describe('panic のあとの立て直し (test-panic の debug ビルド)', () => {
    beforeAll(async () => {
        cargo(['build', '-q', '-p', 'markdag-wasm', '--target', 'wasm32-unknown-unknown', '--features', 'test-panic']);
        reset();
        await init(readFileSync(PANIC_WASM));
    }, CARGO_TIMEOUT);

    afterAll(() => {
        reset();
    });

    it('panic は文面つきの WasmTrapError になり、インスタンスを作り直して次の呼び出しが通る', () => {
        const before = callJson<{ nodes: unknown[] }>('parse_document', { source: '# a\n## b\n' });
        let caught: unknown;
        try {
            // mdag_test_panic は試験のビルドにだけある。論理名の型の外なので型を外して呼ぶ
            callJson('test_panic' as JsonFunction, { reason: '試験' });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(WasmTrapError);
        const trap = caught as WasmTrapError;
        expect(trap.functionName).toBe('test_panic');
        expect(trap.panicMessage).toContain('test-panic: {"reason":"試験"}');
        expect(trap.panicMessage).toContain('src/lib.rs');
        expect(trap.cause).toBeInstanceOf(WebAssembly.RuntimeError);

        // 作り直したインスタンスで同じ結果が出る。緩衝も新しいので、次の trap の文面は前のものを引きずらない
        expect(callJson('parse_document', { source: '# a\n## b\n' })).toEqual(before);
        expect(ping(9)).toBe(10);
        expect(() => callJson('test_panic' as JsonFunction, 'again')).toThrow(/test-panic: "again"/);
    });

    it('新しいインスタンスの最初の mdag_alloc が panic しても文面が残る', () => {
        const exports = freshExports(PANIC_WASM);
        // 0x9000_0000 バイトは wasm32 の isize::MAX を越えるので Vec の確保が capacity overflow で panic する
        expect(() => exports.mdag_alloc(0x9000_0000)).toThrow(WebAssembly.RuntimeError);
        expect(readPanicMessage(exports)).toContain('capacity overflow');
    });
});

// 単体 HTML のページの組み立ての Rust の写し (mdag_standalone_page) が、旧実装 (JS) の renderStandalonePage / buildStandaloneHtml と
// 同じ文字列 (1 バイトも違わない HTML) を返すことを、審判のコーパスの文書と、逃がし方を突く文字列で確かめる。
// 基準は旧実装の出力を写した期待値 (test/fixtures/standalone-legacy/。旧実装の置き場を消す前に書き出した。A-200)。
// 場面の一覧は期待値を書き出した側と同じもの (cases.ts) を使い、コーパスの解析結果も期待値の側に写したものを素材にする。
// 配布物のランタイムの場面は、Rust化の前に写した配布物のランタイムとスタイルシート (test/fixtures/legacy-dist/) を既定にする。
// ここでは JS の options を境界の入力 { runtime, css, data, options } に分ける写しを試験の中に持つ。
// 起動の script (ページの最後の script) だけは比べない。Rust は wasm を焼き込んだランタイムで init を待ってから mountStandalone を呼び、
// 旧実装は init のない JS のランタイムで mountStandalone を直に呼ぶので、そこは意図して違う (A-201)。
// 起動の中身は別の試験で見る。JS と CLI が同じ HTML を出すこと (A-017) は、両方が page.rs を通るので組み立てで保たれる
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import coreRuntime from './fixtures/legacy-dist/markdag.core.iife.js?raw';
import { callJson, callJsonText, init, MarkdagError, reset } from '../src/wasm';
import type { StandaloneOptions, StandaloneRuntime } from '../src/standalone/page';
import {
    adversarialCases,
    corpusCases,
    FAKE_RUNTIME,
    LONE_SURROGATE,
    markDist,
    numberCases,
    refusalCases,
    SCRIPT_FIRST_LABEL,
    splitBoot,
    toWellFormed,
    type CorpusDocument,
    type StandaloneCase,
} from './fixtures/standalone-legacy/cases';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_WASM = `${root}target/wasm32-unknown-unknown/release/markdag_wasm.wasm`;
const CORPUS_DIR = `${root}testdata/judge/corpus/`;
const FIXTURE_DIR = `${root}test/fixtures/standalone-legacy/`;
const CARGO_TIMEOUT = 600_000;

const DIST: StandaloneRuntime = { script: coreRuntime, style: readFileSync(`${root}test/fixtures/legacy-dist/style.css`, 'utf8') };

// 旧実装の出力。ページは起動の script を除いたもの。配布物のランタイムの場面は、ページの sha256 と長さ、ランタイムとスタイルシートを印にしたページ
type Expected = { page: string } | { error: string } | { sha256: string; length: number; page: string };
const expectedFile = JSON.parse(readFileSync(`${FIXTURE_DIR}outcomes.json`, 'utf8')) as { legacyBoot: string; cases: Record<string, Expected> };
const LEGACY_BOOT = expectedFile.legacyBoot;
const parsedOf = JSON.parse(readFileSync(`${FIXTURE_DIR}parsed.json`, 'utf8')) as Record<string, CorpusDocument['parsed']>;

function expectedOf(label: string): Expected {
    const expected = expectedFile.cases[label];
    if (expected === undefined) throw new Error(`期待値がない: ${label}`);
    return expected;
}

// 包みの差し替えで buildStandaloneHtml が行う分け方の写し。素材の欄は data、残りは options に入れる
function viaRust(options: StandaloneOptions, defaults: StandaloneRuntime): string {
    const { parsed, source, types, hookScripts, view, state, tasks, title, lang, containerClass, css, head, runtime } = options;
    return callJson<string>('standalone_page', {
        runtime: defaults.script,
        css: defaults.style,
        data: { parsed, source, types, hookScripts, view, state, tasks },
        options: { title, lang, containerClass, css, head, runtime },
    });
}

// 起動の中身はどのページでも同じ文字列。最初に見たものを覚え、以後のページがそれと同じことも見る
let rustBoot: string | undefined;
function pageOf(html: string, label: string): string {
    const { page, boot } = splitBoot(html);
    rustBoot ??= boot;
    expect(boot, `${label} (rust の起動)`).toBe(rustBoot);
    return page;
}

// 同じ入力で旧実装の出力と Rust の結果 (起動の script を除いた HTML か、断ったときの文面) が 1 字も違わないこと
function expectSame({ label, options, runtime }: StandaloneCase): void {
    const expected = expectedOf(label);
    const defaults = runtime === 'dist' ? DIST : runtime;
    let html: string;
    try {
        html = viaRust(options, defaults);
    } catch (error) {
        expect({ error: error instanceof Error ? error.message : String(error) }, label).toEqual(expected);
        return;
    }
    const page = pageOf(html, label);
    if ('sha256' in expected) {
        // 読める違いを先に見せ、そのあとで 1 字も違わないことを sha256 で見る
        expect(markDist(page, defaults), label).toBe(expected.page);
        expect({ sha256: createHash('sha256').update(page).digest('hex'), length: page.length }, label).toEqual({ sha256: expected.sha256, length: expected.length });
        return;
    }
    expect({ html: page }, label).toEqual('page' in expected ? { html: expected.page } : expected);
}

const corpus = readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
const TYPES = { './types.yaml': parseYaml(readFileSync(`${CORPUS_DIR}types.yaml`, 'utf8')) as unknown };

describe('mdag_standalone_page と renderStandalonePage', () => {
    beforeAll(async () => {
        const built = spawnSync('cargo', ['build', '-q', '-p', 'markdag-wasm', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: root, encoding: 'utf8' });
        if (built.status !== 0) throw new Error(`cargo build が失敗した:\n${built.stderr}`);
        reset();
        await init(readFileSync(RELEASE_WASM));
    }, CARGO_TIMEOUT);

    afterAll(() => {
        reset();
    });

    it('コーパスの文書を原文だけ、解析結果だけ、両方と型とフックと表示の指定で埋めても同じ HTML になる', () => {
        expect(corpus.length).toBeGreaterThan(50);
        expect(Object.keys(parsedOf).sort()).toEqual(corpus);
        const documents = corpus.map((name) => ({ name, source: readFileSync(`${CORPUS_DIR}${name}`, 'utf8'), parsed: parsedOf[name] as CorpusDocument['parsed'] }));
        let compared = 0;
        for (const testCase of corpusCases(documents, TYPES)) {
            expectSame(testCase);
            compared++;
        }
        expect(compared).toBe(corpus.length * 6);
    });

    it('逃がし方を突く文字列を、素材、題、lang、クラス、CSS、head、ランタイムのどこに入れても同じ HTML になる', () => {
        const cases = adversarialCases();
        expect(cases).toHaveLength(48);
        for (const testCase of cases) expectSame(testCase);
    });

    it('数とキーの順は JSON.stringify と同じに書く', () => {
        for (const testCase of numberCases()) expectSame(testCase);
    });

    it('断るときは同じ文面の誤りになる', () => {
        for (const testCase of refusalCases()) expectSame(testCase);
        // `<script` が `<!--` より前にしかないなら断らない (最初の `<!--` より後ろだけを探すこと)
        expect(expectedOf(SCRIPT_FIRST_LABEL)).toHaveProperty('page');
        let thrown: unknown;
        try {
            viaRust({}, FAKE_RUNTIME);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(MarkdagError);
        expect((thrown as MarkdagError).code).toBe('standalone-error');
    });

    it('対になっていないサロゲートは境界を越えられない (包みが toWellFormed を当てる。当てたあとは JS と同じ)', () => {
        const raw = JSON.parse(callJsonText('standalone_page', JSON.stringify({ runtime: '', css: '', data: { source: LONE_SURROGATE }, options: null }))) as { error?: { code: string } };
        expect(raw.error?.code).toBe('invalid-input');
        // JS の原文は素材の中の対になっていないサロゲートを \ud800 と逃がして埋めるが、包みが U+FFFD に置き換えてから渡すので、Rust は U+FFFD を埋める
        const js = expectedOf('サロゲート (そのまま)');
        const rust = viaRust({ source: toWellFormed(LONE_SURROGATE) }, FAKE_RUNTIME);
        expect('page' in js && js.page).toContain('"a\\ud800b"');
        expect(rust).toContain('"a�b"');
        const wellFormed = expectedOf('サロゲート (置き換えたあと)');
        expect('page' in wellFormed && wellFormed.page).toBe(splitBoot(rust).page);
    });

    it('起動の script だけが旧実装と違い、Rust の起動は init を待ってから mountStandalone を呼び、失敗を図の要素に出す', () => {
        const legacy = LEGACY_BOOT;
        const rust = splitBoot(viaRust({ source: 'x' }, FAKE_RUNTIME)).boot;
        // 旧実装: init を呼ばずに mountStandalone を直に呼ぶ (wasm のランタイムではこれが F2 の白紙のページになる)
        expect(legacy.startsWith('markdag.mountStandalone(')).toBe(true);
        expect(legacy).not.toContain('markdag.init(');
        const initAt = rust.indexOf('markdag.init()');
        const mount = rust.indexOf('markdag.mountStandalone(');
        expect(initAt).toBeGreaterThanOrEqual(0);
        expect(mount).toBeGreaterThan(initAt);
        expect(rust).toContain('.then(() => markdag.mountStandalone(');
        expect(rust).toContain("document.querySelector('.mdag-standalone').textContent = 'markdag: '");
        // 図を組み立てたあとの処理 (窓口を window に置き、診断を開発者ツールに出す) は旧実装と同じ文
        for (const line of ['    window.markdagStandalone = diagram;', '    if (diagram.diagnostics.length > 0) console.warn(markdag.formatDiagnostics(diagram.diagnostics));']) {
            expect(legacy).toContain(line);
            expect(rust).toContain(line);
        }
    });
});

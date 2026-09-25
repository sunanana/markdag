// 数式とコードの飾りのライブラリ (KaTeX と highlight.js) の読み込み (A-194 (2))。既定の入口の render は、ページにないとき CDN から読み、
// 読めたら描き直す。markdag/core の render と単体 HTML は読まない。CDN への要求は page.route で差し替え、実際の通信はしない。
// 読む script には固定の integrity (SRI、A-204) が付くので、差し替えの本文を実行させる試験は harness の口で integrity をその本文のハッシュに替える。
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { Harness } from './harness';
import type { MarkdagDiagram, ParsedDocument } from '../src/index';
import type { buildStandaloneHtml as BuildStandaloneHtml, init as Init } from '../src/standalone';

type TestWindow = Window & { harness: Harness; diagram: MarkdagDiagram };

const MATH_SCRIPT = 'https://cdn.jsdelivr.net/npm/katex@0.16.18/dist/katex.min.js';
const CODE_SCRIPT = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js';
const MATH_INTEGRITY = 'sha384-v6mkHYHfY/4BWq54f7lQAdtIsoZZIByznQ3ZqN38OL4KCsrxo31SLlPiak7cj/Mg';
const CODE_INTEGRITY = 'sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU';
// SRI の照合は CORS の要求になるので、jsDelivr と同じく誰にでも読ませる応答にする
const CORS = { 'access-control-allow-origin': '*' };
const DIST = resolve('dist/standalone.js');

const DOC = ['---', 'markdag: {}', '---', '', '# Root', '', '- Math $a^2$', '- Code', '', '  ```js', '  const x = 1;', '  ```', ''].join('\n');

// 差し替えの KaTeX と highlight.js。飾ったことが分かる印の要素を返す
const MATH_STUB = 'window.katex = { renderToString: (tex) => `<b class="stub-katex">${tex}</b>` };';
const CODE_STUB = 'window.hljs = { getLanguage: () => true, highlight: (code) => ({ value: `<i class="stub-hljs">${code}</i>` }) };';
const STUBS: Record<string, string> = { [MATH_SCRIPT]: MATH_STUB, [CODE_SCRIPT]: CODE_STUB };

const BROKEN_KATEX = 'window.katex = { renderToString: () => { throw new Error("broken katex"); } };';

// jsDelivr への要求を記録し、JS は差し替えを、CSS は空を返す。fail なら JS の要求を失敗させる
async function stubCdn(page: Page, fail = false): Promise<string[]> {
    const requested: string[] = [];
    await page.route('https://cdn.jsdelivr.net/**', (route: Route) => {
        const url = route.request().url();
        requested.push(url);
        if (url.endsWith('.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        if (fail) return route.abort();
        return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: STUBS[url] ?? '' });
    });
    return requested;
}

const sri = (body: string): string => `sha384-${createHash('sha384').update(body).digest('base64')}`;

// 差し替えの本文を SRI の照合に通す (page を開いたあと、描く前に呼ぶ)
async function trust(page: Page, bodies: Record<string, string>): Promise<void> {
    const values = Object.fromEntries(Object.entries(bodies).map(([url, body]) => [url, sri(body)]));
    await page.evaluate((values) => {
        const { harness } = window as unknown as TestWindow;
        for (const [url, integrity] of Object.entries(values)) harness.overrideScriptIntegrity(url, integrity);
    }, values);
}

// 捕まえられなかった拒否を集める (page を開いたあとに呼ぶ)
async function watchUnhandled(page: Page): Promise<() => Promise<string[]>> {
    await page.evaluate(() => {
        const reasons: string[] = [];
        window.addEventListener('unhandledrejection', (event) => reasons.push(String(event.reason)));
        (window as unknown as { unhandled: string[] }).unhandled = reasons;
    });
    return () => page.evaluate(() => (window as unknown as { unhandled: string[] }).unhandled);
}

// 読み込みのために足した script の要素の SRI の属性
const scriptAttributes = (page: Page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('script[data-markdag-asset]')].map((script) => ({
            src: script.getAttribute('src'),
            integrity: script.getAttribute('integrity'),
            crossorigin: script.getAttribute('crossorigin'),
        })),
    );

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/harness.html');
    await page.waitForFunction(() => 'harness' in window);
}

async function renderWith(page: Page, entry: 'markdag' | 'core', markdown: string): Promise<void> {
    await page.evaluate(
        ({ entry, markdown }) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.diagram = target.harness[entry].render(container, markdown, { animate: false });
        },
        { entry, markdown },
    );
}

const scripts = (requested: string[]): string[] => requested.filter((url) => url.endsWith('.js'));

test.describe('飾りのライブラリの読み込み', () => {
    test('既定の入口は KaTeX と highlight.js を CDN から 1 度だけ読み、読めたら描き直す', async ({ page }) => {
        const requested = await stubCdn(page);
        await open(page);
        await trust(page, STUBS);
        await renderWith(page, 'markdag', DOC);
        const container = page.locator('#a');
        await expect(container.locator('.stub-katex')).toHaveText('a^2');
        await expect(container.locator('.stub-hljs')).toHaveText('const x = 1;');
        expect(scripts(requested).sort()).toEqual([MATH_SCRIPT, CODE_SCRIPT].sort());
        // 同じページでの描き直しと別の文書では、もう読まない (ページにあるものを使う)
        await page.evaluate(() => (window as unknown as TestWindow).diagram.update('# Other\n\n- $b$\n'));
        await expect(container.locator('.stub-katex')).toHaveText('b');
        expect(scripts(requested)).toHaveLength(2);
    });

    test('数式もコードもない文書は何も読まない', async ({ page }) => {
        const requested = await stubCdn(page);
        await open(page);
        await renderWith(page, 'markdag', '# Root\n\n- a\n');
        await expect(page.locator('#a .mdag-node')).toHaveCount(2);
        expect(requested).toEqual([]);
    });

    test('読めなければ印のまま描き、描き直しのたびに読みに行かない', async ({ page }) => {
        const requested = await stubCdn(page, true);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await open(page);
        await renderWith(page, 'markdag', DOC);
        await expect.poll(() => scripts(requested).length).toBe(2);
        await page.evaluate(() => (window as unknown as TestWindow).diagram.update('# Root\n\n- Math $c$\n'));
        await expect(page.locator('#a .mdag-math')).toHaveText('c');
        expect(scripts(requested)).toHaveLength(2);
        expect(errors).toEqual([]);
    });

    test('CDN の本文が固定の integrity に合わなければ実行せず、印のまま描き、読み直さない (A-204)', async ({ page }) => {
        // 差し替えの本文は本物の KaTeX / highlight.js と違うので、固定のハッシュに合わない
        const requested = await stubCdn(page);
        const pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await open(page);
        const unhandled = await watchUnhandled(page);
        await renderWith(page, 'markdag', DOC);
        await expect.poll(() => scripts(requested).length).toBe(2);
        await expect.poll(() => scriptAttributes(page).then((list) => list.length)).toBe(2);
        expect(await scriptAttributes(page)).toEqual(
            expect.arrayContaining([
                { src: MATH_SCRIPT, integrity: MATH_INTEGRITY, crossorigin: 'anonymous' },
                { src: CODE_SCRIPT, integrity: CODE_INTEGRITY, crossorigin: 'anonymous' },
            ]),
        );
        // 読み込みの結果 (失敗) を待つ時間を置いても、本文は実行されていない
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => ({ katex: 'katex' in window, hljs: 'hljs' in window }))).toEqual({ katex: false, hljs: false });
        const container = page.locator('#a');
        await expect(container.locator('.mdag-math')).toHaveText('a^2');
        await expect(container.locator('.stub-katex')).toHaveCount(0);
        await expect(container.locator('.stub-hljs')).toHaveCount(0);
        await page.evaluate(() => (window as unknown as TestWindow).diagram.update('# Root\n\n- Math $c$\n'));
        await expect(container.locator('.mdag-math')).toHaveText('c');
        expect(scripts(requested)).toHaveLength(2);
        expect(await unhandled()).toEqual([]);
        expect(pageErrors).toEqual([]);
    });

    test('integrity に合う本文なら実行して飾り、合わせたハッシュが script に付く (A-204)', async ({ page }) => {
        const requested = await stubCdn(page);
        await open(page);
        const unhandled = await watchUnhandled(page);
        await trust(page, STUBS);
        await renderWith(page, 'markdag', DOC);
        const container = page.locator('#a');
        await expect(container.locator('.stub-katex')).toHaveText('a^2');
        await expect(container.locator('.stub-hljs')).toHaveText('const x = 1;');
        expect(scripts(requested)).toHaveLength(2);
        expect(await scriptAttributes(page)).toEqual(
            expect.arrayContaining([
                { src: MATH_SCRIPT, integrity: sri(MATH_STUB), crossorigin: 'anonymous' },
                { src: CODE_SCRIPT, integrity: sri(CODE_STUB), crossorigin: 'anonymous' },
            ]),
        );
        expect(await unhandled()).toEqual([]);
    });

    test('ハッシュを合わせた本文から 1 バイトでも違えば実行しない (A-204)', async ({ page }) => {
        await page.route('https://cdn.jsdelivr.net/**', (route: Route) => {
            const url = route.request().url();
            if (url.endsWith('.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
            return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: `${STUBS[url] ?? ''} ` });
        });
        await open(page);
        const unhandled = await watchUnhandled(page);
        await trust(page, STUBS);
        await renderWith(page, 'markdag', DOC);
        await expect.poll(() => scriptAttributes(page).then((list) => list.length)).toBe(2);
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => 'katex' in window || 'hljs' in window)).toBe(false);
        await expect(page.locator('#a .mdag-math')).toHaveText('a^2');
        await expect(page.locator('#a .stub-katex')).toHaveCount(0);
        expect(await unhandled()).toEqual([]);
    });

    test('読めたあとの描き直しが失敗しても、今の図を残して console.error に出す (捕まえない拒否にしない)', async ({ page }) => {
        await page.route('https://cdn.jsdelivr.net/**', (route: Route) => {
            const url = route.request().url();
            if (url.endsWith('.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
            // 読めるが、使うと例外を投げる KaTeX (描き直しの中で飾りを当てるときに投げる)
            return route.fulfill({ status: 200, contentType: 'text/javascript', headers: CORS, body: BROKEN_KATEX });
        });
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        await open(page);
        await trust(page, { [MATH_SCRIPT]: BROKEN_KATEX });
        const unhandled = await page.evaluate(() => {
            const reasons: string[] = [];
            window.addEventListener('unhandledrejection', (event) => reasons.push(String(event.reason)));
            (window as unknown as { unhandled: string[] }).unhandled = reasons;
            return reasons.length;
        });
        expect(unhandled).toBe(0);
        await renderWith(page, 'markdag', '---\nmarkdag: {}\n---\n\n# Root\n\n- Math $a^2$\n');
        await expect.poll(() => consoleErrors.some((text) => text.includes('飾りを読んだあとの描き直しに失敗しました'))).toBe(true);
        // 最初に描いた図 (印のままの数式) が残り、診断も最初の図のもの
        await expect(page.locator('#a .mdag-math')).toHaveText('a^2');
        await expect(page.locator('#a .mdag-node')).toHaveCount(2);
        expect(await page.evaluate(() => (window as unknown as TestWindow).diagram.diagnostics)).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as { unhandled: string[] }).unhandled)).toEqual([]);
        expect(pageErrors).toEqual([]);
    });

    test('markdag/core の render は CDN から JS を読まない', async ({ page }) => {
        const requested = await stubCdn(page);
        await open(page);
        await renderWith(page, 'core', DOC);
        await expect(page.locator('#a .mdag-math')).toHaveText('a^2');
        // 読み込みが走るなら描いた直後に要求が出る。少し待ってからも JS の要求がないこと
        await page.waitForTimeout(300);
        expect(scripts(requested)).toEqual([]);
        await expect(page.locator('#a .stub-katex')).toHaveCount(0);
    });

    test('単体 HTML は数式とコードがあっても外部を読みに行かない', async ({ page }) => {
        test.skip(!existsSync(DIST), 'dist/standalone.js がない (npm run build を先に実行する)');
        await open(page);
        const parsed = await page.evaluate((markdown) => (window as unknown as TestWindow).harness.core.parseDocument(markdown), DOC);
        const { buildStandaloneHtml, init } = (await import(pathToFileURL(DIST).href)) as { buildStandaloneHtml: typeof BuildStandaloneHtml; init: typeof Init };
        await init();
        const file = test.info().outputPath('decorators.html');
        writeFileSync(file, buildStandaloneHtml({ parsed: parsed as ParsedDocument, view: { animate: false } }));
        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        await page.goto(pathToFileURL(file).href);
        await page.waitForFunction(() => 'markdagStandalone' in window);
        await expect(page.locator('.mdag-math')).toHaveText('a^2');
        await page.waitForTimeout(300);
        expect(requested.filter((url) => !url.startsWith('file:') && !url.startsWith('blob:'))).toEqual([]);
    });
});

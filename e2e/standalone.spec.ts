// 単体の HTML の書き出しを、実際のブラウザで確かめる。図の組み立て (mountStandalone) は開発サーバのページで、
// 書き出した HTML はビルド済みの入口で作って file:// で開き、対話が残っていることと外部を読みに行かないことを見る
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { ParsedDocument, StandaloneDiagram } from '../src/index';
import type { buildStandaloneHtml as BuildStandaloneHtml, StandaloneOptions } from '../src/standalone';

type TestWindow = Window & { harness: Harness; standalone: StandaloneDiagram; markdagStandalone: StandaloneDiagram };

// ノードの id は文書順で、Root = 1, Design = 2, Task A = 3, Task B = 4, Build = 5, Deep = 6, Leaf = 7
const DOC = [
    '---',
    'markdag:',
    '    relations:',
    '        depends:',
    '            - $api --> Design',
    '    hooks:',
    '        $ref: ./badge.hooks.js',
    '---',
    '',
    '# Root',
    '',
    '## Design %design',
    '',
    '- [ ] Task A',
    '- [x] Task B',
    '',
    '## Build $api',
    '',
    '### Deep',
    '',
    '- Leaf',
    '',
].join('\n');
// 文書が宣言したフックの実体。ソース文字列で渡し、開いたときにモジュールとして読み込まれる
const BADGE_HOOK = 'export function decorateNode(context) { return { badge: "b" + context.node.id }; }';

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/harness.html');
    await page.waitForFunction(() => 'harness' in window);
}

// 解析には DOM が要るので、解析結果は開発サーバのページで作る
async function parseInPage(page: Page, source: string): Promise<ParsedDocument> {
    await open(page);
    return page.evaluate((markdown) => {
        const { core, createTransformer } = (window as unknown as TestWindow).harness;
        return core.parseDocument(markdown, { transformer: createTransformer() });
    }, source);
}

test.describe('mountStandalone', () => {
    test('解析結果を渡すと変換器なしで描け、表示の指定と開閉の状態が復元され、フックのソースが読み込まれる', async ({ page }) => {
        await open(page);
        const result = await page.evaluate(
            async ({ markdown, hook }) => {
                const target = window as unknown as TestWindow;
                const { core, createTransformer } = target.harness;
                const container = document.getElementById('a');
                if (!container) throw new Error('container is missing');
                const parsed = core.parseDocument(markdown, { transformer: createTransformer() });
                target.standalone = await core.mountStandalone(container, { parsed, view: { theme: 'dark', animate: false }, state: { folded: [2] }, hookScripts: { './badge.hooks.js': hook } });
                return { folded: target.standalone.view.getFolded(), diagnostics: target.standalone.diagnostics, dark: container.classList.contains('markdag-dark'), tasks: container.dataset.tasks };
            },
            { markdown: DOC, hook: BADGE_HOOK },
        );
        expect(result).toEqual({ folded: [2], diagnostics: [], dark: true, tasks: 'readonly' });
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(page.locator('#a .mdag-node[data-id="3"]')).toBeHidden();
        await expect(page.locator('#a .mdag-node[data-id="5"] .mdag-badge')).toHaveText('b5');
        await expect(page.locator('#a .mdag-legend')).toBeVisible();
    });

    test('タスクをクリックしても状態は変わらず、指の形にもならない', async ({ page }) => {
        await open(page);
        await page.evaluate(async (markdown) => {
            const target = window as unknown as TestWindow;
            const { core, createTransformer } = target.harness;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.standalone = await core.mountStandalone(container, { parsed: core.parseDocument(markdown, { transformer: createTransformer() }), view: { animate: false } });
        }, DOC);
        const content = page.locator('#a .mdag-node[data-id="3"] .mdag-content');
        await expect(content).toBeVisible();
        expect(await content.evaluate((element) => getComputedStyle(element).cursor)).toBe('auto');
        await content.click();
        await expect(page.locator('#a .mdag-node[data-id="3"]')).toHaveAttribute('data-task', 'todo');
    });

    test('表示位置を渡すと、全体を収める代わりにその位置で開く', async ({ page }) => {
        await open(page);
        const transform = await page.evaluate(async (markdown) => {
            const target = window as unknown as TestWindow;
            const { core, createTransformer } = target.harness;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.standalone = await core.mountStandalone(container, { parsed: core.parseDocument(markdown, { transformer: createTransformer() }), state: { transform: { x: 10, y: 20, k: 0.5 } } });
            return target.standalone.view.getTransform();
        }, DOC);
        expect(transform).toEqual({ x: 10, y: 20, k: 0.5 });
    });

    test('原文だけのときは、既定の入口では標準の変換器で解析し、変換器を渡す入口では断る', async ({ page }) => {
        await open(page);
        const result = await page.evaluate(async (markdown) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            let refused = '';
            await target.harness.core.mountStandalone(container, { source: markdown }).catch((error: Error) => (refused = error.message));
            target.standalone = await target.harness.markdag.mountStandalone(container, { source: markdown, view: { animate: false } });
            return { refused, count: target.standalone.view.getFolded().length, nodes: document.querySelectorAll('#a .mdag-node').length };
        }, DOC);
        expect(result.refused).toContain('変換器');
        expect(result.nodes).toBe(7);
    });

    test('フックのソースが読めなければ、警告の診断にして図は描く', async ({ page }) => {
        await open(page);
        const result = await page.evaluate(async (markdown) => {
            const target = window as unknown as TestWindow;
            const { core, createTransformer } = target.harness;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.standalone = await core.mountStandalone(container, { parsed: core.parseDocument(markdown, { transformer: createTransformer() }), hookScripts: { './badge.hooks.js': 'export function decorateNode( {' } });
            return { codes: target.standalone.diagnostics.map((item) => `${item.severity} ${item.code}`), nodes: document.querySelectorAll('#a .mdag-node').length };
        }, DOC);
        expect(result.codes).toEqual(['warning hooks-unresolved', 'warning hook-failed']);
        expect(result.nodes).toBe(7);
    });
});

const DIST = resolve('dist/standalone.js');

test.describe('書き出した HTML', () => {
    test.skip(!existsSync(DIST), 'dist/standalone.js がない (npm run build を先に実行する)');

    async function exportPage(page: Page, options: Omit<StandaloneOptions, 'parsed'>): Promise<string> {
        const parsed = await parseInPage(page, DOC);
        const { buildStandaloneHtml } = (await import(pathToFileURL(DIST).href)) as { buildStandaloneHtml: typeof BuildStandaloneHtml };
        const file = test.info().outputPath('standalone.html');
        writeFileSync(file, buildStandaloneHtml({ parsed, ...options }));
        return pathToFileURL(file).href;
    }

    test('file:// で開くと、外部を読みに行かずに、折りたたみ、ズーム、凡例、タスクの記号、フックが動く', async ({ page }) => {
        const url = await exportPage(page, {
            title: 'Export <test>',
            lang: 'ja',
            containerClass: 'zu-markdag',
            css: ['.markdag.zu-markdag { --markdag-bg: rgb(1, 2, 3); }'],
            head: '<meta name="color-scheme" content="light dark">',
            view: { animate: false },
            state: { folded: [5] },
            hookScripts: { './badge.hooks.js': BADGE_HOOK },
        });
        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        await page.goto(url);
        await page.waitForFunction(() => 'markdagStandalone' in window);

        await expect(page).toHaveTitle('Export <test>');
        expect(await page.locator('html').getAttribute('lang')).toBe('ja');
        await expect(page.locator('meta[name="color-scheme"]')).toHaveCount(1);
        expect(requested.filter((item) => !item.startsWith('file:') && !item.startsWith('blob:'))).toEqual([]);

        const container = page.locator('.mdag-standalone');
        await expect(container).toHaveClass(/\bmarkdag\b/);
        await expect(container).toHaveClass(/\bzu-markdag\b/);
        // 図を置く要素は画面いっぱい (body の余白なし、高さは表示領域と同じ)
        const box = await container.evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, height: element.getBoundingClientRect().height, top: element.getBoundingClientRect().top, viewport: window.innerHeight }));
        expect(box).toEqual({ background: 'rgb(1, 2, 3)', height: box.viewport, top: 0, viewport: box.viewport });
        expect(await page.evaluate(() => (window as unknown as TestWindow).markdagStandalone.diagnostics)).toEqual([]);

        await expect(page.locator('.mdag-node')).toHaveCount(7);
        await expect(page.locator('.mdag-node[data-id="6"]')).toBeHidden();
        await expect(page.locator('.mdag-node[data-id="3"]')).toBeVisible();
        await expect(page.locator('.mdag-node[data-id="2"] .mdag-badge')).toHaveText('b2');
        await expect(page.locator('.mdag-legend')).toBeVisible();

        const task = page.locator('.mdag-node[data-id="3"]');
        await expect(task).toHaveAttribute('data-task', 'todo');
        await task.locator('.mdag-content').click();
        await expect(task).toHaveAttribute('data-task', 'todo');

        await page.locator('.mdag-fold[data-id="2"]').click();
        await expect(task).toBeHidden();
        expect(await page.evaluate(() => (window as unknown as TestWindow).markdagStandalone.view.getFolded())).toEqual([2, 5]);

        const before = await page.evaluate(() => (window as unknown as TestWindow).markdagStandalone.view.getTransform());
        await page.mouse.move(640, 400);
        await page.mouse.wheel(0, -120);
        await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).markdagStandalone.view.getTransform().k)).not.toBe(before.k);
    });
});

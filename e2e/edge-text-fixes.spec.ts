// 線の下の文字の読みやすさ (袋文字) のレビューで確かめた指摘の回帰テスト。受け入れの例 (testdata/acceptance/edge-text/) とは別に、直した挙動だけを確かめる。
// - 線を選んだまま destroy しても、図を置いた要素に線を選んでいる目印 (data-edge-selected) を残さない
// - 詳細の印は、押して出したまま (data-pinned) でも「i」に縁を付けない (縁の色は字の色と同じ背景の色なので、字が塊になる)
// - 詳細に HTML で書いた abbr と strike は、ほかの線を引く要素と同じく縁を影に替え、点線と取り消し線を縁で消さない
// - 修正案 T-004、T-007、T-008、T-009 (docs/ignore の修正案の一覧で依頼者が直すと決めたもの)
// 公開の入口 dist/markdag.iife.js の render で描く。先に npm run build
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const IIFE = resolve('dist/markdag.iife.js');
const PROBE = readFileSync(resolve('e2e/edge-text-probe.js'), 'utf8');
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

// setup は render の前にページへ入れる script (飾りのライブラリの代わりなど)
async function mount(page: Page, input: string, theme: 'light' | 'dark', setup?: string): Promise<void> {
    if (!existsSync(IIFE)) throw new Error('dist/markdag.iife.js がない (npm run build を先に実行する)');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; height: 100%; }</style></head>` +
            `<body><div id="diagram" style="position:absolute;left:0;top:0;width:1040px;height:1000px"></div></body></html>`,
    );
    await page.addScriptTag({ content: readFileSync(IIFE, 'utf8') });
    await page.evaluate(() => (window as any).markdag.init());
    if (setup) await page.addScriptTag({ content: setup });
    await page.evaluate(
        ({ input, theme }) => {
            const container = document.getElementById('diagram')!;
            (window as any).__diagram = (window as any).markdag.render(container, input, { theme, animate: false });
        },
        { input, theme },
    );
    await page.addScriptTag({ content: PROBE });
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

test.describe('袋文字のレビューの直し @edge-text', () => {
    test('@edge-text 線を選んだまま destroy すると、図を置いた要素から data-edge-selected が外れる (R-11)', async ({ page }) => {
        const input = readFileSync(resolve('testdata/acceptance/edge-text/screen/faded-highlight/input.md'), 'utf8');
        await mount(page, input, 'dark');
        await page.evaluate(() => (window as any).edgeTextProbe.clickEdge('設計の方針を決める --> 結合テストを通す'));
        const container = page.locator('#diagram');
        await expect(container).toHaveAttribute('data-edge-selected', '');
        await page.evaluate(() => (window as any).__diagram.destroy());
        expect(await container.evaluate((element) => element.hasAttribute('data-edge-selected'))).toBe(false);
    });

    for (const theme of ['light', 'dark'] as const) {
        test(`@edge-text 詳細の印は、出したまま (data-pinned) でも字に縁を付けない (R-2、${theme})`, async ({ page }) => {
            const input = ['---', 'title: 詳細の印', 'markdag:', '    details:', '        display: hover', '---', '', '# 根', '', '## 段', '- 詳細つきの行', '    > 詳細の文', ''].join('\n');
            await mount(page, input, theme);
            const node = page.locator('.mdag-node', { hasText: '詳細つきの行' });
            await node.locator('.mdag-note-mark').click();
            await expect(node).toHaveAttribute('data-pinned', '');
            const strokes = await node.locator('.mdag-note-mark').evaluate((mark) => [getComputedStyle(mark).webkitTextStrokeColor, getComputedStyle(mark, '::before').webkitTextStrokeColor]);
            expect(strokes).toEqual([TRANSPARENT, TRANSPARENT]);
        });
    }

    test('@edge-text 詳細に書いた abbr と strike は、縁を影に替えて線を縁で消さない (R-7)', async ({ page }) => {
        const input = [
            '---',
            'title: abbr と strike',
            'markdag:',
            '    details:',
            '        display: always',
            '---',
            '',
            '# 根',
            '',
            '## 段',
            '- [ ] 作業中',
            '    > <abbr title="HyperText">HTML</abbr> と <strike>古い取り消し</strike>',
            '',
        ].join('\n');
        await mount(page, input, 'light');
        const styles: Record<string, unknown> = {};
        for (const tag of ['abbr', 'strike']) {
            const element = page.locator(`.mdag-details ${tag}`);
            await expect(element).toHaveCount(1);
            styles[tag] = await element.evaluate((target) => {
                const computed = getComputedStyle(target);
                return { stroke: computed.webkitTextStrokeColor, shadows: (computed.filter.match(/drop-shadow/g) ?? []).length, line: computed.textDecorationLine };
            });
        }
        expect(styles).toEqual({
            abbr: { stroke: TRANSPARENT, shadows: 8, line: 'underline' },
            strike: { stroke: TRANSPARENT, shadows: 8, line: 'line-through' },
        });
    });
});

// 修正案の直しで使う文書。「基準の行」は薄く表示しない比べる相手、「完了の行」は薄く表示のノード。
// 線「上の端 --> 受け取る」を選ぶと、線に関わらない 2 行は強調から外れる (data-faded)
const PARTS_INPUT = [
    '---',
    'title: 修正案の直し',
    'markdag:',
    '    relations:',
    '        depends:',
    '            - 上の端 --> 受け取る',
    '    details:',
    '        display: always',
    '    tasks:',
    '        dim:',
    "            states: ['x']",
    '---',
    '',
    '# 修正案',
    '',
    '## 部品',
    '- [ ] 上の端',
    ...['- [ ] 基準の行', '- [x] 完了の行'].flatMap((head) => [
        head,
        '    ```js',
        '    const answer = 42; // 答え',
        '    ```',
        '    > 詳細の文',
        '    > <input type="text" value="入力"> <select><option>選択肢</option></select> <button>ボタン</button> <textarea rows="1" cols="8">入力欄</textarea>',
        '    > <iframe srcdoc="中" width="40" height="20"></iframe> <video width="40" height="20"></video> <audio controls></audio> <canvas width="40" height="20"></canvas>',
        // 行に HTML のタグだけが並ぶと HTML のかたまりになり、空行まで続くので、表の前に空行を置く
        '    >',
        '    > | 名前 | 値 |',
        '    > | --- | --- |',
        '    > | alpha | 12 |',
    ]),
    '',
    '## 受け側',
    '- [ ] 受け取る',
    '',
].join('\n');

// highlight.js の代わり。色の付いた span を入れ子まで含めて作り、テーマの CSS の代わりに span に色を付ける (CDN には出ない)
const HLJS_STUB = `window.hljs = {
    getLanguage: () => ({}),
    highlight: () => ({ value: '<span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>; <span class="hljs-comment">// <span class="hljs-doctag">答え</span></span>' }),
};`;
const HLJS_THEME = '.hljs-number { color: rgb(136, 0, 0); } .hljs-comment { color: rgb(105, 112, 112); } .hljs-doctag { color: rgb(0, 0, 255); }';

async function mountParts(page: Page, theme: 'light' | 'dark'): Promise<void> {
    await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
    await mount(page, PARTS_INPUT, theme, HLJS_STUB);
    await page.addStyleTag({ content: HLJS_THEME });
}

const nodeOf = (page: Page, text: string) => page.locator('.mdag-node', { hasText: text });
// ノードの外の隅にポインタを置き、hover を外す
const leave = (page: Page) => page.mouse.move(1590, 990);
const hover = async (page: Page, text: string) => {
    const { x, y } = await page.evaluate((needle) => (window as any).edgeTextProbe.point(needle), text);
    await page.mouse.move(x, y);
    expect(await page.evaluate((needle) => (window as any).edgeTextProbe.hovered(needle), text)).toBe(true);
};
const fadeOthers = async (page: Page) => {
    await leave(page);
    await page.evaluate(() => (window as any).edgeTextProbe.clickEdge('上の端 --> 受け取る'));
    await expect(nodeOf(page, '完了の行')).toHaveAttribute('data-faded', '');
};

test.describe('修正案 T-004、T-007、T-008、T-009 の直し @edge-text', () => {
    for (const theme of ['light', 'dark'] as const) {
        test(`@edge-text 完了のノードのコードブロックでは、色の付いた span の字も code の字と同じ混ぜた色にする (T-004、${theme})`, async ({ page }) => {
            await mountParts(page, theme);
            await leave(page);
            const colors = (text: string) =>
                nodeOf(page, text)
                    .locator('pre > code')
                    .evaluate((code) => ({
                        code: getComputedStyle(code).color,
                        spans: [...code.querySelectorAll('[class*="hljs-"]')].map((span) => `${span.className} ${getComputedStyle(span).color}`),
                    }));
            const base = await colors('基準の行');
            expect(base.spans).toContain('hljs-number rgb(136, 0, 0)');
            expect(base.spans).toContain('hljs-doctag rgb(0, 0, 255)');
            const dimmed = await colors('完了の行');
            expect(dimmed.code).not.toBe(base.code);
            expect(dimmed.spans).toEqual(['hljs-keyword', 'hljs-number', 'hljs-comment', 'hljs-doctag'].map((name) => `${name} ${dimmed.code}`));

            await hover(page, '完了の行');
            expect(await colors('完了の行')).toEqual(base);

            await fadeOthers(page);
            expect(await colors('完了の行')).toEqual(base);
        });
    }

    // 縁は字の輪郭の中心に引かれ、外に出るのは太さの半分。セルの上下左右の余白がそれ以上あれば、字の縁は罫線に届かない
    // (ブラウザの既定の余白 1px では届く)
    test('@edge-text 本文の表のセルには、字の縁の外に出る幅以上の余白が上下左右にある (T-007)', async ({ page }) => {
        await mountParts(page, 'light');
        const cells = await nodeOf(page, '基準の行')
            .locator('.mdag-details :is(th, td)')
            .evaluateAll((elements) =>
                elements.map((cell) => {
                    const style = getComputedStyle(cell);
                    const outside = parseFloat(style.webkitTextStrokeWidth) / 2;
                    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map((value) => outside > 0 && parseFloat(value) >= outside);
                }),
            );
        expect(cells).toEqual(Array(4).fill([true, true, true, true]));
    });

    for (const theme of ['light', 'dark'] as const) {
        test(`@edge-text UI を持つ要素は字の縁を付けず、完了で要素ごと opacity 0.35 にする (T-008、${theme})`, async ({ page }) => {
            await mountParts(page, theme);
            await leave(page);
            const TAGS = ['input', 'select', 'button', 'textarea', 'iframe', 'video', 'audio', 'canvas'];
            const measure = (text: string) =>
                nodeOf(page, text)
                    .locator('.mdag-details')
                    .evaluate(
                        (details, tags) =>
                            Object.fromEntries(
                                tags.map((tag) => {
                                    const element = details.querySelector(tag);
                                    if (element === null) return [tag, null];
                                    const inner = element.querySelector('option') ?? element;
                                    const style = getComputedStyle(element);
                                    return [tag, { stroke: style.webkitTextStrokeColor, innerStroke: getComputedStyle(inner).webkitTextStrokeColor, opacity: style.opacity }];
                                }),
                            ),
                        TAGS,
                    );
            const expected = (opacity: string) => Object.fromEntries(TAGS.map((tag) => [tag, { stroke: TRANSPARENT, innerStroke: TRANSPARENT, opacity }]));
            expect(await measure('基準の行')).toEqual(expected('1'));
            expect(await measure('完了の行')).toEqual(expected('0.35'));

            await hover(page, '完了の行');
            expect(await measure('完了の行')).toEqual(expected('1'));

            await fadeOthers(page);
            expect(await measure('完了の行')).toEqual(expected('1'));
        });

        test(`@edge-text 完了のノードでは、開いた詳細の左の縦線を背景の色と 35% で混ぜる (T-008、${theme})`, async ({ page }) => {
            await mountParts(page, theme);
            await leave(page);
            const line = (text: string) => nodeOf(page, text).locator('.mdag-details').evaluate((details) => getComputedStyle(details).borderLeftColor);
            // 期待の色は、図の要素の中で同じ混ぜ合わせ (--markdag-border 35% と --markdag-bg) を当てた色
            const mixed = await page.locator('.markdag').evaluate((root) => {
                const probe = document.createElement('div');
                probe.style.color = 'color-mix(in srgb, var(--markdag-border) 35%, var(--markdag-bg))';
                root.append(probe);
                const color = getComputedStyle(probe).color;
                probe.remove();
                return color;
            });
            const base = await line('基準の行');
            expect(mixed).not.toBe(base);
            expect(await line('完了の行')).toBe(mixed);

            await hover(page, '完了の行');
            expect(await line('完了の行')).toBe(base);

            await fadeOthers(page);
            expect(await line('完了の行')).toBe(base);
        });
    }

    // getComputedStyle(要素, '::selection') の縁の色は、Chromium では規則があっても currentColor、WebKit では要素の縁の色を返し、
    // 効いているかを読めない (効くことは絵で確かめた)。読めるのは Firefox だけなので、Firefox では計算済みの値も見る。
    // どのブラウザでも、図のスタイルシートに縁を透明にする ::selection の規則があり、選んだ字の要素に当たることを見る
    test('@edge-text 文字を選んでいる間は字の縁を透明にする (T-009)', async ({ page, browserName }) => {
        await mountParts(page, 'light');
        const found = await nodeOf(page, '基準の行')
            .locator('.mdag-task-label')
            .evaluate((element) => {
                const range = document.createRange();
                range.selectNodeContents(element);
                getSelection()!.removeAllRanges();
                getSelection()!.addRange(range);
                const sheet = (document.querySelector('style[data-markdag-style]') as HTMLStyleElement).sheet!;
                const rules = [...sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.includes('::selection'));
                // 「.a ::selection」は .a の子孫の、「.a::selection」は .a そのものの選んだ字に当たる
                const applies = (selector: string) => {
                    const owner = selector.trim().replace(/::selection$/, '');
                    return owner.endsWith(' ') ? element.matches(`${owner}*`) : element.matches(owner);
                };
                return {
                    element: getComputedStyle(element).webkitTextStrokeColor,
                    selection: getComputedStyle(element, '::selection').webkitTextStrokeColor,
                    rules: rules
                        .filter((rule) => rule.selectorText.split(',').some(applies))
                        .map((rule) => rule.style.getPropertyValue('-webkit-text-stroke-color')),
                };
            });
        expect(found.element).not.toBe(TRANSPARENT);
        expect(found.rules.length).toBeGreaterThan(0);
        expect(found.rules.every((value) => value === 'transparent' || value === TRANSPARENT)).toBe(true);
        if (browserName === 'firefox') expect(found.selection).toBe(TRANSPARENT);
    });
});

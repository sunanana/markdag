// グループの枠の受け入れテスト (ブラウザの面)。testdata/acceptance/frames/ の例を 1 件ずつ回す。
// - library の例 (27 件): 枠の矩形、入り込み、sides、visible、edges、clearance は描いた図の実測が要るので、ここで全部の欄を照らす
//   (配置の実測の要らない欄 (diagnostics、グループのメンバー) は test/acceptance-frames.test.ts も見る)
// - screen の例 (10 件): 画面の px で枠、ラベルの文字のインク、ノードの箱を測る。開閉は開閉の円を実際にクリックする
// - standalone の例 (5 件): buildStandaloneHtml (dist/standalone.js) か CLI の markdag html (target/debug/markdag) の HTML を開いて測る
// 公開の入口 (dist/markdag.iife.js の markdag、dist/standalone.js、CLI のバイナリ) だけを呼ぶ。公開 API は枠を返さないので、
// 枠は描いた svg の rect.mdag-frame と data-group から読む。測り方は e2e/frames-probe.js (例を書き起こしたときと同じ定義)。
// 期待は expect.yaml から読み、ここに写さない。先に npm run build (cli-html は cargo build -p markdag-cli も)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { CALL_KEYS, compare, LIBRARY_EXPECT_KEYS, listExamples, readExampleFile, SPEC_KEYS, unknownKeys, type FramesExample } from '../test/acceptance/frames-examples';

// 例を書き起こしたときの大きさ (expect.yaml の api の欄の 1800x1100)
const VIEWPORT = { width: 1800, height: 1100 };
const IIFE = resolve('dist/markdag.iife.js');
const STANDALONE = resolve('dist/standalone.js');
const CLI = resolve('target/debug/markdag');
const PROBE = readFileSync(resolve('e2e/frames-probe.js'), 'utf8');
const SCREEN_STEP_KEYS = ['measure', 'click_fold', 'update', 'expandAll', 'resetFold'];
const SCREEN_MEASURE_KEYS = ['visible', 'frames', 'unframed', 'overlap', 'intrusions', 'sides', 'labels', 'edges', 'clearance'];

type Measured = Record<string, unknown>;

function iife(): string {
    if (!existsSync(IIFE)) throw new Error('dist/markdag.iife.js がない (npm run build を先に実行する)');
    return readFileSync(IIFE, 'utf8');
}

// 1800x1100 の要素 #a に、公開の iife と測り方を入れたページ
async function openBlank(page: Page): Promise<void> {
    await page.setViewportSize(VIEWPORT);
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="a" style="width:${VIEWPORT.width}px;height:${VIEWPORT.height}px"></div></body></html>`);
    await page.addScriptTag({ content: iife() });
    await page.evaluate(() => (window as any).markdag.init());
    await page.addScriptTag({ content: PROBE });
}

const nextFrames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

function specProblems(example: FramesExample): string[] {
    return [...unknownKeys(example.spec, SPEC_KEYS, example.id), ...unknownKeys(example.spec.call, CALL_KEYS, `${example.id}.call`)];
}

// ---- library: render (animate: false、onLayout) → actions → 図の座標で測る ----

async function runLibrary(page: Page, example: FramesExample): Promise<Measured> {
    const actions = (example.spec.call?.actions ?? []) as Array<Record<string, unknown>>;
    for (const action of actions) {
        const keys = Object.keys(action);
        if (keys.length !== 1 || !['setFolded', 'expandAll', 'resetFold', 'update'].includes(keys[0]!)) throw new Error(`${example.id}: 知らない action: ${JSON.stringify(action)}`);
    }
    const texts: Record<string, string> = {};
    for (const action of actions) if (typeof action.update === 'string') texts[action.update] = readExampleFile(example, action.update);
    return page.evaluate(
        ({ source, actions, texts }) => {
            const { markdag, framesProbe } = window as any;
            const element = document.getElementById('a')!;
            let snapshot: unknown = null;
            let parsed = markdag.parseDocument(source);
            let model = markdag.buildModel(parsed.nodes, parsed.frontmatter, source);
            const diagram = markdag.render(element, source, { animate: false, onLayout: (value: unknown) => (snapshot = value) });
            let diagnostics = diagram.diagnostics;
            for (const action of actions as any[]) {
                if (action.setFolded) {
                    const { idOf } = framesProbe.namer(parsed);
                    diagram.view.setFolded(action.setFolded.map(idOf));
                } else if (action.expandAll) diagram.expandAll();
                else if (action.resetFold) diagram.resetFold();
                else if (action.update) {
                    const text = texts[action.update]!;
                    diagnostics = diagram.update(text);
                    parsed = markdag.parseDocument(text);
                    model = markdag.buildModel(parsed.nodes, parsed.frontmatter, text);
                }
            }
            const { name } = framesProbe.namer(parsed);
            const measured = framesProbe.measureLibrary(element, snapshot, model, name);
            const result = { diagnostics: framesProbe.diagnosticsOf(diagnostics), ...measured };
            diagram.destroy();
            return result;
        },
        { source: example.input, actions, texts },
    );
}

// ---- screen: render (animate: false) → steps (クリック、update、expandAll、resetFold) → 画面の px で測る ----

async function clickFold(page: Page, text: string): Promise<void> {
    const id = await page.evaluate((text) => {
        const { framesProbe, __state } = window as any;
        return framesProbe.namer(__state.parsed).idOf(text) as number | undefined;
    }, text);
    if (id === undefined) throw new Error(`ノード「${text}」がない`);
    await page.locator(`circle.mdag-fold[data-id="${id}"]`).click();
    await nextFrames(page);
}

async function runScreen(page: Page, example: FramesExample): Promise<Measured> {
    await page.evaluate((source) => {
        const { markdag } = window as any;
        const element = document.getElementById('a')!;
        const parsed = markdag.parseDocument(source);
        const model = markdag.buildModel(parsed.nodes, parsed.frontmatter, source);
        const diagram = markdag.render(element, source, { animate: false });
        (window as any).__state = { diagram, parsed, model };
    }, example.input);
    const out: Measured = {};
    for (const step of (example.spec.steps ?? [{ measure: '初め' }]) as Array<Record<string, unknown>>) {
        const keys = Object.keys(step);
        if (keys.length !== 1 || !SCREEN_STEP_KEYS.includes(keys[0]!)) throw new Error(`${example.id}: 知らない step: ${JSON.stringify(step)}`);
        if (typeof step.click_fold === 'string') await clickFold(page, step.click_fold);
        else if (typeof step.update === 'string') {
            const text = readExampleFile(example, step.update);
            await page.evaluate((text) => {
                const { markdag, __state: state } = window as any;
                state.diagram.update(text);
                state.parsed = markdag.parseDocument(text);
                state.model = markdag.buildModel(state.parsed.nodes, state.parsed.frontmatter, text);
            }, text);
        } else if (step.expandAll) await page.evaluate(() => (window as any).__state.diagram.expandAll());
        else if (step.resetFold) await page.evaluate(() => (window as any).__state.diagram.resetFold());
        else if (typeof step.measure === 'string') {
            out[step.measure] = await page.evaluate(() => {
                const { framesProbe, __state: state } = window as any;
                const { name } = framesProbe.namer(state.parsed);
                return framesProbe.measureScreen(document.getElementById('a'), state.model, name);
            });
        }
    }
    // 最後に描いた文書の診断 (diagram.diagnostics)
    out.diagnostics = await page.evaluate(() => (window as any).framesProbe.diagnosticsOf((window as any).__state.diagram.diagnostics));
    await page.evaluate(() => (window as any).__state.diagram.destroy());
    return out;
}

// ---- standalone: 単体 HTML を開いて画面の px で測る ----

async function standaloneHtml(browser: Browser, example: FramesExample): Promise<string> {
    const call = example.spec.call ?? {};
    if (call.cli) {
        if (call.cli !== 'markdag html input.md') throw new Error(`${example.id}: 知らない cli: ${call.cli}`);
        if (!existsSync(CLI)) throw new Error('target/debug/markdag がない (npm run build のあとに cargo build -p markdag-cli を実行する)');
        return execFileSync(CLI, ['html', resolve(example.dir, 'input.md')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    }
    if (!existsSync(STANDALONE)) throw new Error('dist/standalone.js がない (npm run build を先に実行する)');
    const { buildStandaloneHtml, init } = await import(pathToFileURL(STANDALONE).href);
    await init();
    const options: Record<string, unknown> = { source: example.input };
    if (call.state_folded) {
        // folded は id で渡す。名前から id を引くのは公開の parseDocument (dist/standalone.js は出さないので iife のページで引く)
        const names = await browser.newPage();
        try {
            await openBlank(names);
            const folded = await names.evaluate(
                ({ source, list }) => {
                    const { markdag, framesProbe } = window as any;
                    const { idOf } = framesProbe.namer(markdag.parseDocument(source));
                    return list.map(idOf);
                },
                { source: example.input, list: call.state_folded as string[] },
            );
            options.state = { folded };
        } finally {
            await names.close();
        }
    }
    return buildStandaloneHtml(options);
}

async function runStandalone(page: Page, browser: Browser, example: FramesExample): Promise<Measured> {
    const html = await standaloneHtml(browser, example);
    await page.setViewportSize(VIEWPORT);
    await page.setContent(html);
    await page.waitForFunction(() => (window as any).markdagStandalone !== undefined, null, { timeout: 20000 });
    await nextFrames(page);
    await page.addScriptTag({ content: PROBE });
    return page.evaluate((source) => {
        const { markdag, framesProbe, markdagStandalone } = window as any;
        const parsed = markdag.parseDocument(source);
        const model = markdag.buildModel(parsed.nodes, parsed.frontmatter, source);
        const { name } = framesProbe.namer(parsed);
        const element = document.querySelector('.mdag-standalone');
        return {
            diagnostics: framesProbe.diagnosticsOf(markdagStandalone.diagnostics),
            folded: markdagStandalone.view.getFolded().map(name),
            ...framesProbe.measureScreen(element, model, name),
        };
    }, example.input);
}

// 期待と照らし、食い違いがあれば測った値ごと出す (通らない例の出力を記録に残すため)
function judge(example: FramesExample, measured: Measured): void {
    const problems = compare(example.spec.expect, measured, 'expect');
    expect(problems, `${example.id} の測った値: ${JSON.stringify(measured)}`).toEqual([]);
}

// ---- 試験 ----

test.describe('受け入れの例 @frames: library', () => {
    const examples = listExamples('library');
    test('@frames library の例が 27 件ある', () => {
        expect(examples.length).toBe(27);
    });
    for (const example of examples) {
        test(`@frames ${example.id} (${example.spec.kind})`, async ({ page }) => {
            expect([...specProblems(example), ...unknownKeys(example.spec.expect, LIBRARY_EXPECT_KEYS, `${example.id}.expect`)]).toEqual([]);
            await openBlank(page);
            judge(example, await runLibrary(page, example));
        });
    }
});

test.describe('受け入れの例 @frames: screen', () => {
    const examples = listExamples('screen');
    test('@frames screen の例が 10 件ある', () => {
        expect(examples.length).toBe(10);
    });
    for (const example of examples) {
        test(`@frames ${example.id} (${example.spec.kind})`, async ({ page }) => {
            const measures = ((example.spec.steps ?? []) as Array<Record<string, unknown>>).filter((step) => typeof step.measure === 'string').map((step) => step.measure as string);
            expect([
                ...specProblems(example),
                ...unknownKeys(example.spec.expect, ['diagnostics', ...measures], `${example.id}.expect`),
                ...measures.flatMap((measure) => unknownKeys(example.spec.expect?.[measure], SCREEN_MEASURE_KEYS, `${example.id}.expect.${measure}`)),
            ]).toEqual([]);
            await openBlank(page);
            judge(example, await runScreen(page, example));
        });
    }
});

test.describe('受け入れの例 @frames: standalone', () => {
    const examples = listExamples('standalone');
    test('@frames standalone の例が 5 件ある', () => {
        expect(examples.length).toBe(5);
    });
    for (const example of examples) {
        test(`@frames ${example.id} (${example.spec.kind})`, async ({ page, browser }) => {
            expect([...specProblems(example), ...unknownKeys(example.spec.expect, ['diagnostics', 'folded', 'visible', 'frames', 'unframed', 'overlap', 'intrusions', 'sides', 'labels'], `${example.id}.expect`)]).toEqual([]);
            judge(example, await runStandalone(page, browser, example));
        });
    }
});

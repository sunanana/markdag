// 線の下の文字の読みやすさ (袋文字、薄く表示の色の混ぜ合わせ、絵文字の囲み、code の地の透かし) の受け入れテスト。
// testdata/acceptance/edge-text/<面>/<名前>/ の例 (input.md と expect.yaml) を 1 件ずつ回す。
// - screen の例: 公開の入口 dist/markdag.iife.js の render で描いた図
// - standalone の例: dist/standalone.js の buildStandaloneHtml が書き出した単体 HTML をそのまま開いたもの
// 測るのは計算済みのスタイルの欄と data 属性だけ (見た目そのものはテストにしない)。測り方は e2e/edge-text-probe.js (例を書き起こしたときと同じ定義)。
// :hover は JS で作れないので、hover と leave は実際のマウスで動かす。期待は expect.yaml から読み、ここに写さない。先に npm run build
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

const ROOT = 'testdata/acceptance/edge-text';
const IIFE = resolve('dist/markdag.iife.js');
const STANDALONE = resolve('dist/standalone.js');
const PROBE = readFileSync(resolve('e2e/edge-text-probe.js'), 'utf8');
// 例を書き起こした確認ページと同じ大きさ。ページは 1600x1000 で、図 (または単体 HTML の iframe) はその左の 1040x1000
const PAGE = { width: 1600, height: 1000 };
const DIAGRAM = { width: 1040, height: 1000 };
const STEP_KINDS = ['measure', 'hover', 'leave', 'click_edge'];
// 最も遅いブラウザ (webkit) を見込んだ待ちの上限
const WAIT = 20_000;
// hover、leave、click_edge のあとの測りで、期待の欄が揃うまで測り直す上限。負荷の高いときの webkit を見込む
const SETTLE = 10_000;

interface Spec {
    kind?: string;
    render?: { theme?: 'light' | 'dark'; resolveIcon?: string; decorate?: { startsWith: string; className?: string; badge?: string; css?: string } };
    reference?: string;
    steps?: Array<Record<string, string>>;
    expect?: Record<string, unknown>;
}
interface Example {
    id: string;
    face: 'screen' | 'standalone';
    input: string;
    spec: Spec;
}
interface Row {
    step: string;
    node: string;
    part: string;
    field: string;
    expected: unknown;
    actual: unknown;
    match: boolean;
}

function listExamples(face: Example['face']): Example[] {
    const dir = join(ROOT, face);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .sort()
        .filter((name) => existsSync(join(dir, name, 'input.md')) && existsSync(join(dir, name, 'expect.yaml')))
        .map((name) => ({
            id: `${face}/${name}`,
            face,
            input: readFileSync(join(dir, name, 'input.md'), 'utf8'),
            spec: parseYaml(readFileSync(join(dir, name, 'expect.yaml'), 'utf8')) as Spec,
        }));
}

function iife(): string {
    if (!existsSync(IIFE)) throw new Error('dist/markdag.iife.js がない (npm run build を先に実行する)');
    return readFileSync(IIFE, 'utf8');
}

const nextFrames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// ---- screen: 公開の iife の render で描く ----

async function mountScreen(page: Page, example: Example): Promise<void> {
    const light = example.spec.render?.theme === 'light';
    await page.setViewportSize(PAGE);
    await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html, body { margin: 0; height: 100%; background: ${light ? '#ffffff' : '#27272a'}; }</style></head>` +
            `<body><div id="diagram" style="position:absolute;left:0;top:0;width:${DIAGRAM.width}px;height:${DIAGRAM.height}px"></div></body></html>`,
    );
    await page.addScriptTag({ content: iife() });
    await page.evaluate(() => (window as any).markdag.init());
    const decorate = example.spec.render?.decorate;
    if (decorate?.css) await page.addStyleTag({ content: decorate.css });
    await page.evaluate(
        ({ input, theme, svg, decorate }) => {
            const { markdag } = window as any;
            const container = document.getElementById('diagram')!;
            const diagram = markdag.render(container, input, {
                theme,
                animate: false,
                resolveIcon: svg ? () => svg : undefined,
                hooks: decorate
                    ? { decorateNode: ({ node }: { node: { text: string } }) => (node.text.startsWith(decorate.startsWith) ? { className: decorate.className, badge: decorate.badge } : undefined) }
                    : undefined,
            });
            (window as any).__edgeDiagnostics = () => diagram.diagnostics.map((item: { severity: string; code: string }) => `${item.severity} ${item.code}`);
        },
        { input: example.input, theme: example.spec.render?.theme ?? 'dark', svg: example.spec.render?.resolveIcon ?? null, decorate: decorate ?? null },
    );
    await nextFrames(page);
}

// ---- standalone: buildStandaloneHtml の HTML を開く ----

async function mountStandalone(page: Page, example: Example): Promise<void> {
    if (example.spec.render?.decorate || example.spec.render?.resolveIcon) throw new Error(`${example.id}: standalone の例は decorate と resolveIcon を使えない`);
    if (!existsSync(STANDALONE)) throw new Error('dist/standalone.js がない (npm run build を先に実行する)');
    const { buildStandaloneHtml, init } = await import(pathToFileURL(STANDALONE).href);
    await init();
    const html: string = buildStandaloneHtml({ title: 'edge-text example', source: example.input, view: { theme: example.spec.render?.theme ?? 'dark', animate: false }, css: [] });
    await page.setViewportSize(DIAGRAM);
    await page.setContent(html);
    await page.waitForFunction(() => (window as any).markdagStandalone !== undefined, null, { timeout: WAIT });
    await page.evaluate(() => {
        (window as any).__edgeDiagnostics = () => (window as any).markdagStandalone.diagnostics.map((item: { severity: string; code: string }) => `${item.severity} ${item.code}`);
    });
    await nextFrames(page);
}

// ---- steps を順に進めて測る ----

async function runSteps(page: Page, example: Example): Promise<Row[]> {
    await page.addScriptTag({ content: PROBE });
    const expectAll = example.spec.expect ?? {};
    const steps = example.spec.steps ?? [{ measure: '初め' }];
    const viewport = page.viewportSize()!;
    const measured = new Set<string>();
    const rows: Row[] = [];
    let stateChanged = false;
    for (const step of steps) {
        const entries = Object.entries(step);
        if (entries.length !== 1 || !STEP_KINDS.includes(entries[0]![0])) throw new Error(`${example.id}: 知らない step: ${JSON.stringify(step)}`);
        const [kind, target] = entries[0]!;
        if (kind === 'measure') {
            measured.add(target);
            const args = { target, expected: expectAll[target] ?? null, reference: example.spec.reference ?? null };
            const measureOnce = (): Promise<Row[]> => page.evaluate(({ target, expected, reference }) => (window as any).edgeTextProbe.measure(target, expected, reference), args);
            let result = await measureOnce();
            // スタイルが切り替わる段階のあとは、反映が遅れても期待の欄が揃うまで測り直す。上限までに揃わなければ最後の測りで判定する (期待は緩めない)
            if (stateChanged) {
                const deadline = Date.now() + SETTLE;
                while (result.some((row) => !row.match) && Date.now() < deadline) {
                    await nextFrames(page);
                    result = await measureOnce();
                }
            }
            rows.push(...result);
            stateChanged = false;
        } else if (kind === 'hover' || kind === 'leave') {
            if (kind === 'hover') {
                const point = await page.evaluate((needle) => (window as any).edgeTextProbe.point(needle), target);
                await page.mouse.move(point.x, point.y);
            } else await page.mouse.move(viewport.width - 10, viewport.height - 10);
            await expect
                .poll(() => page.evaluate((needle) => (window as any).edgeTextProbe.hovered(needle), target), { message: `${kind} で「${target}」の :hover が変わらない`, timeout: WAIT })
                .toBe(kind === 'hover');
            await nextFrames(page);
            stateChanged = true;
        } else {
            await page.evaluate((text) => (window as any).edgeTextProbe.clickEdge(text), target);
            await nextFrames(page);
            stateChanged = true;
        }
    }
    if ('diagnostics' in expectAll) {
        const actual: string[] = await page.evaluate(() => (window as any).__edgeDiagnostics());
        const match: boolean = await page.evaluate(({ expected, actual }) => (window as any).edgeTextProbe.matches(expected, actual), { expected: expectAll.diagnostics, actual });
        rows.push({ step: '診断', node: '', part: '', field: 'diagnostics', expected: expectAll.diagnostics, actual, match });
    }
    const unused = Object.keys(expectAll).filter((key) => key !== 'diagnostics' && !measured.has(key));
    if (unused.length > 0) throw new Error(`${example.id}: steps で測らない段階が expect にある: ${unused.join('、')}`);
    return rows;
}

// 期待と照らし、食い違った欄を 1 行ずつ出す (通らない例の出力を記録に残すため)
function judge(example: Example, rows: Row[], errors: string[]): void {
    const mismatched = rows.filter((row) => !row.match).map((row) => `[${row.step}] ${row.node} / ${row.part} / ${row.field}: 期待 ${JSON.stringify(row.expected)} 実際 ${JSON.stringify(row.actual)}`);
    test.info().annotations.push({ type: '欄', description: `${rows.length - mismatched.length} / ${rows.length}` });
    expect(rows.length, `${example.id}: 測った欄が 0 件`).toBeGreaterThan(0);
    expect(mismatched, `${example.id}: 欄 ${rows.length - mismatched.length} / ${rows.length} が一致`).toEqual([]);
    expect(errors, `${example.id}: ページの誤り`).toEqual([]);
}

function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
    });
    return errors;
}

// ---- 試験 ----

test.describe.configure({ timeout: 90_000 });

test.describe('受け入れの例 @edge-text: screen', () => {
    const examples = listExamples('screen');
    test('@edge-text screen の例が 13 件ある', () => {
        expect(examples.length).toBe(13);
    });
    for (const example of examples) {
        test(`@edge-text ${example.id} (${example.spec.kind})`, async ({ page }) => {
            const errors = watchErrors(page);
            await mountScreen(page, example);
            judge(example, await runSteps(page, example), errors);
        });
    }
});

test.describe('受け入れの例 @edge-text: standalone', () => {
    const examples = listExamples('standalone');
    test('@edge-text standalone の例が 3 件ある', () => {
        expect(examples.length).toBe(3);
    });
    for (const example of examples) {
        test(`@edge-text ${example.id} (${example.spec.kind})`, async ({ page }) => {
            const errors = watchErrors(page);
            await mountStandalone(page, example);
            judge(example, await runSteps(page, example), errors);
        });
    }
});

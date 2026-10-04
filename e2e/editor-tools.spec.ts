// GUI 編集の道具、パン、道具箱、案内、通知、元に戻す / やり直す、キーを、ビルドした配布物の markdag/editor で確かめる。
// キーの受け方、MarkdagEditor の undo と redo と onChange、履歴、道具と dragToPan を見る。
// 見た目そのもの (色、余白、影、アイコンの形) は見ない。目印 (mdag-editor-* の要素の有無と数、data-tool、aria-pressed、.markdag の
// data-editor-tool と data-drag-to-pan)、表示位置 (view.getTransform)、フォーカスのある要素、原文、onChange の呼ばれ方を見る。
// H / V のキーはここでは押さない。反映は expect.poll で待ち、「変わらない」「呼ばれない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { ViewTransform } from '../src/core';
import type { EditorModeOption, EditorOptions, MarkdagEditor } from '../src/editor';

interface ChangeEntry {
    root: string;
    markdown: string;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: ChangeEntry[];
};

const DIST = resolve('dist');

// ノードは Root 1、Design 2、Task A 3 (未完了のタスク)、Task B 4、Build 5、Leaf 6
const BODY = ['# Root', '', '## Design', '', '- [ ] Task A', '- [x] Task B', '', '## Build', '', '- Leaf', ''];
// ノードを 1 つ (7 ノード)、2 つ (8 ノード) 足した本文
const BODY_MORE = [...BODY.slice(0, -1), '- Leaf 2', ''];
const BODY_MORE2 = [...BODY.slice(0, -1), '- Leaf 2', '- Leaf 3', ''];
// Task A の印を進めた本文 (タスクの既定の巡りは ' ' → 'x')
const BODY_TOGGLED = BODY.map((line) => (line === '- [ ] Task A' ? '- [x] Task A' : line));
const TASK_A = 3;

// markdag.editor を書いた文書。editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く。null なら markdag.editor を書かない
function docWith(editor: string[] | null, body: string[] = BODY): string {
    const lines = editor === null ? [] : ['    editor:', ...editor.map((line) => `        ${line}`)];
    return ['---', 'markdag:', '    edgeHighlight: true', ...lines, '---', '', ...body].join('\n');
}

// GUI 編集だけの文書と、GUI 編集で始まる切り替えの文書。setSource で差し替える文書も同じ指定を書く (指定が変わるとモードを合わせ直すため)
const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];
const SWITCH_VIEW = ['mode: switch'];
const DOC = docWith(EDIT);
const DOC_MORE = docWith(EDIT, BODY_MORE);
const DOC_MORE2 = docWith(EDIT, BODY_MORE2);

// 道具箱の並び (選択を上、手のひらをその下にした)。sep は区切り
const TOOLBOX_ORDER = ['select', 'hand', 'join', 'group', 'tag-add', 'tag-select', 'details', 'sep', 'undo', 'redo', 'fit'];
// ボタンの名前
const TOOL_NAMES: Record<string, string> = {
    hand: '手のひら',
    select: '選択',
    join: '合流',
    group: 'グループ',
    'tag-add': 'タグ追加',
    'tag-select': 'タグ選択',
    details: '詳細表示',
    undo: '戻る',
    redo: '進む',
    fit: 'ズームリセット',
};
// 何も選んでいないときの働きが案内の通知の道具。
// 詳細表示は選択肢を出す働きなので (詳細のテストが見る)、案内の通知は見ない
const PLACEHOLDER_TOOLS = ['join', 'group', 'tag-add', 'tag-select'];

interface ToolState {
    // .markdag (図を置いた要素) の data-editor-tool
    tool: string | null;
    // 図の data-drag-to-pan (primary では付かない)。手のひら both、選択 middle、選択 + Space both
    pan: string | null;
    // aria-pressed が true の道具箱のボタンの data-tool
    pressed: string[];
}

const HAND: ToolState = { tool: 'hand', pan: 'both', pressed: ['hand'] };
const SELECT: ToolState = { tool: 'select', pan: 'middle', pressed: ['select'] };

interface Point {
    x: number;
    y: number;
}

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return errors;
}

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors = {};
        target.changes = [];
    });
}

interface MountSpec {
    root?: 'a' | 'b';
    mode?: EditorModeOption;
}

async function mount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    const root = spec.root ?? 'a';
    await page.evaluate(
        ({ markdown, root, mode }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error(`#${root} がない`);
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.changes.push({ root, markdown: next });
                },
            };
            if (mode !== null) options.mode = mode;
            target.editors[root] = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, root, mode: spec.mode ?? null },
    );
    await expect(page.locator(`#${root} .mdag-node`).first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「呼ばれない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page, root = 'a'): Promise<string[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).changes.flatMap((entry) => (entry.root === root ? [entry.markdown] : [])), root);

const getSource = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSource(), root);

const setSource = (page: Page, markdown: string, root = 'a'): Promise<void> =>
    page.evaluate(({ markdown, root }) => void (window as unknown as EditorWindow).editors[root]?.setSource(markdown), { markdown, root });

const setMode = (page: Page, mode: 'view' | 'edit', root = 'a'): Promise<boolean> =>
    page.evaluate(({ mode, root }) => (window as unknown as EditorWindow).editors[root]?.setMode(mode) ?? false, { mode, root });

const callHistory = (page: Page, method: 'undo' | 'redo', root = 'a'): Promise<boolean | undefined> =>
    page.evaluate(({ method, root }) => (window as unknown as EditorWindow).editors[root]?.[method](), { method, root });

async function transformOf(page: Page, root = 'a'): Promise<ViewTransform> {
    const transform = await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getTransform() ?? null, root);
    if (!transform) throw new Error(`#${root} の図がない`);
    return transform;
}

const nodeCount = (page: Page, root = 'a'): Promise<number> => page.locator(`#${root} .mdag-node`).count();

const toolButton = (page: Page, tool: string, root = 'a') => page.locator(`#${root} .mdag-editor-tool[data-tool="${tool}"]`);
const segmentButton = (page: Page, mode: 'view' | 'edit', root = 'a') => page.locator(`#${root} .mdag-editor-segment [data-mode="${mode}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const hint = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-hint`);
const snackbars = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-snackbar`);

async function toolState(page: Page, root = 'a'): Promise<ToolState> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        if (!container) throw new Error(`#${root} がない`);
        return {
            tool: container.getAttribute('data-editor-tool'),
            pan: container.getAttribute('data-drag-to-pan'),
            pressed: [...container.querySelectorAll('.mdag-editor-tool[aria-pressed="true"]')].map((button) => button.getAttribute('data-tool') ?? ''),
        };
    }, root);
}

// フォーカスのある要素: body (か null)、道具箱のボタン (tool:<data-tool>)、id のある要素 (#<id>)、それ以外はタグの名前
async function focusOf(page: Page): Promise<string> {
    return page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        const tool = active.closest('.mdag-editor-tool');
        if (tool) return `tool:${tool.getAttribute('data-tool') ?? ''}`;
        if (active.id) return `#${active.id}`;
        return active.tagName.toLowerCase();
    });
}

// テストのページの原文の欄 (アプリの入力欄の代わり)。図の右の空いた所に置き、図とは重ねない
async function addSourceField(page: Page): Promise<void> {
    await page.evaluate(() => {
        const field = document.createElement('textarea');
        field.id = 'source';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
}

const fieldValue = (page: Page): Promise<string> => page.locator('#source').inputValue();

// 図の外 (#a の右、#b の上) の点
const OUTSIDE: Point = { x: 1100, y: 300 };
// #b の上の点 (#b は #a の下にあり、画面に入るのは上の一部)
const OVER_B: Point = { x: 500, y: 700 };

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank'; root: string }
    // 要素 (か中の要素) が表に出ている点
    | { on: 'element'; selector: string }
    // 要素の中の文字の上の点 (svg の外)
    | { on: 'text'; selector: string };

// 画面の座標で押せる点を探す (図の領域はスクロールを戻すので、locator.click ではなく座標を決めて page.mouse で押す)
async function spot(page: Page, target: Spot): Promise<Point> {
    const found = await page.evaluate((target) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        // 真ん中に近い点から試す
        const grid = (rect: DOMRect, step: number): Array<{ x: number; y: number }> => {
            const points: Array<{ x: number; y: number }> = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        };
        if (target.on === 'blank') {
            const container = document.getElementById(target.root);
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = document.querySelector(target.selector);
        if (!element) return null;
        if (target.on === 'element') {
            const rect = element.getBoundingClientRect();
            return (
                grid(rect, Math.max(2, Math.min(rect.width, rect.height) / 8)).find((point) => {
                    const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                    return hit !== null && element.contains(hit);
                }) ?? null
            );
        }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const parent = text.parentElement;
            const content = text.textContent ?? '';
            const start = content.search(/\S/);
            if (!parent || start < 0 || parent.closest('svg')) continue;
            const range = document.createRange();
            range.setStart(text, start);
            range.setEnd(text, content.trimEnd().length);
            const rect = range.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (inView(x, y) && hit && element.contains(hit) && !hit.closest('svg')) return { x, y };
        }
        return null;
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

async function drag(page: Page, from: Point, to: Point, button: 'left' | 'middle' = 'left'): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up({ button });
}

// 何もないところからドラッグして、図が動いたか (表示位置の x か y が変わったか)
async function pans(page: Page, button: 'left' | 'middle', root = 'a'): Promise<boolean> {
    const before = await transformOf(page, root);
    const from = await spot(page, { on: 'blank', root });
    await drag(page, from, { x: from.x + 60, y: from.y + 40 }, button);
    try {
        await expect
            .poll(
                async () => {
                    const now = await transformOf(page, root);
                    return now.x !== before.x || now.y !== before.y;
                },
                { timeout: 1500 },
            )
            .toBe(true);
        return true;
    } catch {
        return false;
    }
}

// 何もないところでホイールを回すと、倍率が変わる
async function expectWheelZooms(page: Page, root = 'a'): Promise<void> {
    const before = await transformOf(page, root);
    const blank = await spot(page, { on: 'blank', root });
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await transformOf(page, root)).k).not.toBe(before.k);
}

async function pointerOverBlank(page: Page, root = 'a'): Promise<void> {
    const blank = await spot(page, { on: 'blank', root });
    await page.mouse.move(blank.x, blank.y);
}

// フォーカスをどこにもない状態 (body) にする
const blurAll = (page: Page): Promise<void> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

// ページがスクロールしたら戻す (Space を図が受けないときは、ページがスクロールする)
const resetScroll = (page: Page): Promise<void> => page.evaluate(() => window.scrollTo(0, 0));

// 拡大して少し動かし、表示位置を全体が収まる位置から外す
async function disturb(page: Page): Promise<void> {
    const blank = await spot(page, { on: 'blank', root: 'a' });
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.wheel(0, -400);
    await settle(page);
    await drag(page, await spot(page, { on: 'blank', root: 'a' }), { x: blank.x + 120, y: blank.y + 70 });
    await settle(page);
}

const closeTo = (a: ViewTransform, b: ViewTransform): boolean => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

test.describe('道具箱 (B-071、B-077〜B-079、6.3、6.5)', () => {
    test('@editor GUI 編集では道具箱が 1 つ図の左にあり、並びが 選択、手のひら、合流、グループ、タグ追加、タグ選択、詳細表示、(区切り)、戻る、進む、ズームリセット。名前がアイコンの下にある (触る F-04)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(1);

        const toolbox = await page.evaluate(() => {
            const container = document.getElementById('a');
            const box = container?.querySelector('.mdag-editor-toolbox');
            if (!container || !box) throw new Error('道具箱がない');
            const area = container.getBoundingClientRect();
            const rect = box.getBoundingClientRect();
            const tools = [...box.querySelectorAll<HTMLElement>('.mdag-editor-tool')].map((button) => {
                const icon = button.querySelector('svg');
                // 名前の文字 (svg の外の文字) の矩形
                const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
                let textTop = Number.POSITIVE_INFINITY;
                for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                    if (!(text.textContent ?? '').trim() || text.parentElement?.closest('svg')) continue;
                    const range = document.createRange();
                    range.selectNodeContents(text);
                    textTop = Math.min(textTop, range.getBoundingClientRect().top);
                }
                return {
                    tool: button.dataset.tool ?? '',
                    name: (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    top: button.getBoundingClientRect().top,
                    iconBottom: icon ? icon.getBoundingClientRect().bottom : null,
                    textTop,
                };
            });
            return {
                order: [...box.querySelectorAll('.mdag-editor-tool, .mdag-editor-toolbox-sep')].map((item) =>
                    item.classList.contains('mdag-editor-toolbox-sep') ? 'sep' : (item.getAttribute('data-tool') ?? ''),
                ),
                tools,
                inside: rect.left >= area.left - 0.5 && rect.right <= area.right + 0.5 && rect.top >= area.top - 0.5 && rect.bottom <= area.bottom + 0.5,
                leftHalf: rect.right <= area.left + area.width / 2,
                centerOffset: Math.abs(rect.top + rect.height / 2 - (area.top + area.height / 2)),
            };
        });

        expect(toolbox.order).toEqual(TOOLBOX_ORDER);
        expect(Object.fromEntries(toolbox.tools.map((item) => [item.tool, item.name]))).toEqual(TOOL_NAMES);
        // 図の領域の左の辺、上下の中央
        expect(toolbox.inside).toBe(true);
        expect(toolbox.leftHalf).toBe(true);
        expect(toolbox.centerOffset).toBeLessThanOrEqual(2);
        // 縦に並べ、アイコンの下に名前
        const tops = toolbox.tools.map((item) => item.top);
        expect(tops).toEqual([...tops].sort((a, b) => a - b));
        for (const item of toolbox.tools) {
            expect(item.iconBottom, item.tool).not.toBeNull();
            expect(item.textTop, item.tool).toBeGreaterThanOrEqual((item.iconBottom ?? 0) - 1);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 最初の道具は選択で、選択のボタンだけが押された状態 (B-078、B-079、触る F-04)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        expect(await toolState(page)).toEqual(SELECT);
        await expect(toolButton(page, 'select')).toHaveAttribute('aria-pressed', 'true');
        await expect(toolButton(page, 'hand')).toHaveAttribute('aria-pressed', 'false');
    });

    test('@editor 道具箱のボタンで道具を替えると、押された状態、.markdag の data-editor-tool、図の dragToPan が替わる (5.2 の軸 B)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await toolButton(page, 'select').click();
        await settle(page);
        expect(await toolState(page)).toEqual(SELECT);
        await toolButton(page, 'hand').click();
        await expect.poll(() => toolState(page)).toEqual(HAND);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
    });
});

test.describe('パン (B-072〜B-075、5.2 の軸 B)', () => {
    test('@editor 手のひら: 何もないところの主ボタンのドラッグで図が動く。中ボタンのドラッグでも動き、ホイールで拡大縮小する', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await toolButton(page, 'hand').click();
        await expect.poll(() => toolState(page)).toEqual(HAND);
        expect(await pans(page, 'left')).toBe(true);
        expect(await pans(page, 'middle')).toBe(true);
        await expectWheelZooms(page);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 選択: 主ボタンのドラッグでは図が動かず、中ボタンのドラッグで動く。ホイールで拡大縮小する', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        expect(await pans(page, 'left')).toBe(false);
        expect(await pans(page, 'middle')).toBe(true);
        await expectWheelZooms(page);
        expect(await toolState(page)).toEqual(SELECT);
    });

    test('@editor 選択: Space を押している間は主ボタンのドラッグで図が動き、離すと戻る。Space でページはスクロールしない (B-073)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await pointerOverBlank(page);

        await page.keyboard.down('Space');
        await expect.poll(async () => (await toolState(page)).pan).toBe('both');
        expect(await scrollY(page)).toBe(0);
        expect(await pans(page, 'left')).toBe(true);

        await page.keyboard.up('Space');
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        expect(await pans(page, 'left')).toBe(false);
        expect(await scrollY(page)).toBe(0);
    });

    test('@editor 選択: Space を押している間にウィンドウのフォーカスが外れると、選択の道具に戻る (B-073)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await pointerOverBlank(page);

        await page.keyboard.down('Space');
        await expect.poll(async () => (await toolState(page)).pan).toBe('both');
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        expect(await pans(page, 'left')).toBe(false);

        await page.keyboard.up('Space');
        await settle(page);
        expect(await toolState(page)).toEqual(SELECT);
    });
});

test.describe('キーの表 (B-092、B-093、10.1 の 1)', () => {
    test('@editor N、C、L、F は何もしない: 手のひらでも選択でも、原文、道具、表示位置、編集の層の要素が変わらず、通知も出ない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // F でズームリセットされたら分かるように、全体が収まる位置から外しておく
        await disturb(page);
        const snapshot = async () => ({
            source: await getSource(page),
            state: await toolState(page),
            transform: await transformOf(page),
            parts: await page.locator('#a [class*="mdag-editor"]').count(),
            snackbars: await snackbars(page).count(),
            nodes: await nodeCount(page),
        });
        for (const tool of ['hand', 'select']) {
            await toolButton(page, tool).click();
            await pointerOverBlank(page);
            await settle(page);
            const before = await snapshot();
            expect(before.state, tool).toEqual(tool === 'hand' ? HAND : SELECT);
            for (const key of ['KeyN', 'KeyC', 'KeyL', 'KeyF', 'Shift+KeyN', 'Shift+KeyC', 'Shift+KeyL', 'Shift+KeyF']) await page.keyboard.press(key);
            await settle(page);
            expect(await snapshot(), tool).toEqual(before);
        }
        expect(await changeLog(page)).toEqual([]);
    });
});

test.describe('元に戻す / やり直す (B-005、B-008、B-009、B-081、5.1)', () => {
    test('@editor 戻すものもやり直すものもなければ戻るも進むも押せず、undo と redo は false。道具の切り替え、パン、拡大縮小、ズームリセットは履歴に積まれない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expect(toolButton(page, 'redo')).toBeDisabled();
        expect(await callHistory(page, 'undo')).toBe(false);
        expect(await callHistory(page, 'redo')).toBe(false);

        await toolButton(page, 'select').click();
        await toolButton(page, 'hand').click();
        expect(await pans(page, 'left')).toBe(true);
        await expectWheelZooms(page);
        await toolButton(page, 'fit').click();
        await settle(page);

        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expect(toolButton(page, 'redo')).toBeDisabled();
        expect(await callHistory(page, 'undo')).toBe(false);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor setSource は 1 回ずつ履歴に積まれ、onChange は呼ばれない。⌘Z / Ctrl+Z で 1 つずつ戻り、⌘⇧Z / Ctrl+Shift+Z と ⌘Y / Ctrl+Y でやり直す。どれも onChange を呼ぶ', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        await setSource(page, DOC_MORE2);
        await expect(page.locator('#a .mdag-node')).toHaveCount(8);
        await settle(page);
        expect(await changeLog(page)).toEqual([]);
        await expect(toolButton(page, 'undo')).toBeEnabled();
        await expect(toolButton(page, 'redo')).toBeDisabled();

        // フォーカスを図の要素に置く (道具箱のボタンを押すと、フォーカスは図の要素に戻る)
        await toolButton(page, 'hand').click();

        const steps: Array<{ key: string; source: string; nodes: number }> = [
            { key: 'Meta+KeyZ', source: DOC_MORE, nodes: 7 },
            { key: 'Control+KeyZ', source: DOC, nodes: 6 },
            { key: 'Meta+Shift+KeyZ', source: DOC_MORE, nodes: 7 },
            { key: 'Control+Shift+KeyZ', source: DOC_MORE2, nodes: 8 },
            { key: 'Meta+KeyZ', source: DOC_MORE, nodes: 7 },
            { key: 'Meta+KeyY', source: DOC_MORE2, nodes: 8 },
            { key: 'Control+KeyZ', source: DOC_MORE, nodes: 7 },
            { key: 'Control+KeyY', source: DOC_MORE2, nodes: 8 },
        ];
        const expectedChanges: string[] = [];
        for (const step of steps) {
            await page.keyboard.press(step.key);
            expectedChanges.push(step.source);
            await expect.poll(() => getSource(page), step.key).toBe(step.source);
            await expect(page.locator('#a .mdag-node'), step.key).toHaveCount(step.nodes);
            await expect.poll(() => changeLog(page), step.key).toEqual(expectedChanges);
        }
        expect(await toolState(page)).toEqual(HAND);
        expect(errors).toEqual([]);
    });

    test('@editor 戻しきると戻るは押せず、⌘Z は何もしない。やり直しきると進むは押せず、⌘⇧Z は何もしない (B-081)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        await toolButton(page, 'hand').click();

        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expect(toolButton(page, 'redo')).toBeEnabled();
        await page.keyboard.press('Meta+KeyZ');
        await settle(page);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([DOC]);

        await page.keyboard.press('Meta+Shift+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC_MORE);
        await expect(toolButton(page, 'undo')).toBeEnabled();
        await expect(toolButton(page, 'redo')).toBeDisabled();
        await page.keyboard.press('Meta+Shift+KeyZ');
        await page.keyboard.press('Meta+KeyY');
        await settle(page);
        expect(await getSource(page)).toBe(DOC_MORE);
        expect(await changeLog(page)).toEqual([DOC, DOC_MORE]);
    });

    test('@editor 道具箱の戻ると進むは、元に戻す / やり直すと同じ (B-081)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        await toolButton(page, 'undo').click();
        await expect.poll(() => getSource(page)).toBe(DOC);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expect(toolButton(page, 'redo')).toBeEnabled();

        await toolButton(page, 'redo').click();
        await expect.poll(() => getSource(page)).toBe(DOC_MORE);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(toolButton(page, 'undo')).toBeEnabled();
        await expect(toolButton(page, 'redo')).toBeDisabled();
        expect(await changeLog(page)).toEqual([DOC, DOC_MORE]);
    });

    test('@editor MarkdagEditor の undo と redo は、戻した / やり直したら true、何もなければ false。戻したあとに setSource すると、やり直すものはなくなる', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        expect(await callHistory(page, 'undo')).toBe(true);
        expect(await getSource(page)).toBe(DOC);
        expect(await callHistory(page, 'undo')).toBe(false);
        expect(await callHistory(page, 'redo')).toBe(true);
        expect(await getSource(page)).toBe(DOC_MORE);
        expect(await callHistory(page, 'redo')).toBe(false);

        expect(await callHistory(page, 'undo')).toBe(true);
        await setSource(page, DOC_MORE2);
        await expect(toolButton(page, 'redo')).toBeDisabled();
        expect(await callHistory(page, 'redo')).toBe(false);
        expect(await getSource(page)).toBe(DOC_MORE2);
        expect(await callHistory(page, 'undo')).toBe(true);
        expect(await getSource(page)).toBe(DOC);
        expect(await callHistory(page, 'undo')).toBe(false);
    });

    test('@editor 履歴の上限は 200: 201 回の setSource のあと、戻せるのは 200 回で、やり直すと 200 回で元の原文に戻る (10.2 の B-008)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        const docs = Array.from({ length: 202 }, (_, index) => docWith(EDIT, [`# R${index}`, '']));
        await mount(page, docs[0] ?? '');
        const result = await page.evaluate((docs) => {
            const editor = (window as unknown as EditorWindow).editors.a;
            if (!editor) throw new Error('図がない');
            for (const doc of docs.slice(1)) editor.setSource(doc);
            let undone = 0;
            while (undone < 1000 && editor.undo()) undone += 1;
            const afterUndo = editor.getSource();
            let redone = 0;
            while (redone < 1000 && editor.redo()) redone += 1;
            return { undone, afterUndo, redone, afterRedo: editor.getSource() };
        }, docs);
        expect(result).toEqual({ undone: 200, afterUndo: docs[1], redone: 200, afterRedo: docs[201] });
    });
});

test.describe('タスクの印と履歴 (B-010、B-172)', () => {
    test('@editor GUI 編集でタスクの先頭の絵を押すと状態が進んで onChange が呼ばれ、⌘Z で戻り、⌘⇧Z でやり直す (B-010)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        const toggled = docWith(EDIT, BODY_TOGGLED);
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-node[data-id="${TASK_A}"] .mdag-content svg` }));
        await expect.poll(() => changeLog(page)).toEqual([toggled]);
        expect(await getSource(page)).toBe(toggled);
        await expect(toolButton(page, 'undo')).toBeEnabled();

        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC);
        await expect.poll(() => changeLog(page)).toEqual([toggled, DOC]);
        await page.keyboard.press('Meta+Shift+KeyZ');
        await expect.poll(() => getSource(page)).toBe(toggled);
        await expect.poll(() => changeLog(page)).toEqual([toggled, DOC, toggled]);
    });

    test('@editor 閲覧でタスクの文字を押しても状態が進み、履歴に入る。閲覧では ⌘Z は効かず、GUI 編集へ替えると戻るが押せて、押すと戻る (B-172、B-169)', async ({ page }) => {
        await open(page);
        const first = docWith(SWITCH_VIEW);
        const toggled = docWith(SWITCH_VIEW, BODY_TOGGLED);
        await mount(page, first);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('view');

        await press(page, await spot(page, { on: 'text', selector: `#a .mdag-node[data-id="${TASK_A}"] .mdag-content` }));
        await expect.poll(() => changeLog(page)).toEqual([toggled]);

        // 閲覧はキーの操作を切る
        await pointerOverBlank(page);
        await page.keyboard.press('Meta+KeyZ');
        await settle(page);
        expect(await getSource(page)).toBe(toggled);

        expect(await setMode(page, 'edit')).toBe(true);
        await expect(toolButton(page, 'undo')).toBeEnabled();
        await toolButton(page, 'undo').click();
        await expect.poll(() => getSource(page)).toBe(first);
        await expect.poll(() => changeLog(page)).toEqual([toggled, first]);
    });
});

test.describe('ズームリセット (B-082 のボタン)', () => {
    test('@editor ズームリセットのボタンで、全体が収まる表示位置に戻る。ノードは全部図の領域に入る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 全体が収まる表示位置 (fit は今の表示位置によらず、中身と図の領域の大きさで決まる)
        const fitted = await page.evaluate(() => {
            const editor = (window as unknown as EditorWindow).editors.a;
            if (!editor) throw new Error('図がない');
            editor.fit();
            return editor.view.getTransform();
        });
        await disturb(page);
        expect(closeTo(await transformOf(page), fitted)).toBe(false);

        await toolButton(page, 'fit').click();
        await expect.poll(async () => closeTo(await transformOf(page), fitted)).toBe(true);
        const inside = await page.evaluate(() => {
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            const area = container.getBoundingClientRect();
            return [...container.querySelectorAll('.mdag-node .mdag-box')].every((box) => {
                const rect = box.getBoundingClientRect();
                return rect.left >= area.left - 1 && rect.right <= area.right + 1 && rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1;
            });
        });
        expect(inside).toBe(true);
        expect(await changeLog(page)).toEqual([]);
    });
});

test.describe('フォーカスの枠 (B-083、B-084、6.7)', () => {
    test('@editor 道具箱のボタンを押したあと、フォーカスは図の要素にあり、ボタンに残らない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        for (const tool of ['hand', 'select', 'join', 'group', 'tag-add', 'tag-select', 'fit', 'undo', 'redo', 'hand', 'details']) {
            await toolButton(page, tool).click();
            await expect.poll(() => focusOf(page), tool).toBe('#a');
        }
    });

    test('@editor キーボードで道具箱のボタンへフォーカスが移ったあとに ⌘Z / ⌘⇧Z を押すと、フォーカスはボタンに残らない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        await toolButton(page, 'select').focus();
        expect(await focusOf(page)).toBe('tool:select');
        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC);
        await expect.poll(() => focusOf(page)).not.toMatch(/^tool:/);
        expect(['#a', 'body']).toContain(await focusOf(page));

        await toolButton(page, 'hand').focus();
        expect(await focusOf(page)).toBe('tool:hand');
        await page.keyboard.press('Meta+Shift+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC_MORE);
        await expect.poll(() => focusOf(page)).not.toMatch(/^tool:/);
        expect(['#a', 'body']).toContain(await focusOf(page));
    });
});

test.describe('案内と通知 (B-003、B-085、B-105、B-111、B-130、6.4)', () => {
    test('@editor GUI 編集では図の下の中央に案内が 1 つあり、中身が道具で変わる', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await expect(hint(page)).toHaveCount(1);
        await expect(visible(page, '#a .mdag-editor-corner[data-corner="bottom-center"] .mdag-editor-hint')).toHaveCount(1);
        // 最初の道具は選択
        expect(await toolState(page)).toEqual(SELECT);
        const selectText = ((await hint(page).textContent()) ?? '').trim();
        expect(selectText).not.toBe('');

        await toolButton(page, 'hand').click();
        await expect.poll(async () => ((await hint(page).textContent()) ?? '').trim()).not.toBe(selectText);
        expect(((await hint(page).textContent()) ?? '').trim()).not.toBe('');

        await toolButton(page, 'select').click();
        await expect.poll(async () => ((await hint(page).textContent()) ?? '').trim()).toBe(selectText);
    });

    test('@editor 何も選んでいないときに合流、グループ、タグ追加、タグ選択を押すと、案内の通知が図の下の中央に出て、しばらくすると消える。原文と道具は変わらない', async ({ page }) => {
        test.setTimeout(120_000);
        await open(page);
        await mount(page, DOC);
        await expect(snackbars(page)).toHaveCount(0);
        for (const tool of PLACEHOLDER_TOOLS) {
            await toolButton(page, tool).click();
            const shown = visible(page, '#a .mdag-editor-corner[data-corner="bottom-center"] .mdag-editor-snackbar[data-kind="info"]');
            await expect(shown, tool).toHaveCount(1);
            expect(((await shown.textContent()) ?? '').trim(), tool).not.toBe('');
            // 最初の道具 (選択) のまま
            expect(await toolState(page), tool).toEqual(SELECT);
            await expect(snackbars(page), tool).toHaveCount(0, { timeout: 15_000 });
        }
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 詳細表示を押しても原文と道具は変わらない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'details').click();
        await settle(page);
        // 最初の道具 (選択) のまま
        expect(await toolState(page)).toEqual(SELECT);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
    });
});

test.describe('キーの受け方 (1.2、B-25、B-059)', () => {
    test('@editor 図をまだ押していなくても、ポインタが図の上にあれば ⌘Z が効く。ポインタが図の外にあれば効かない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await setSource(page, DOC_MORE);
        expect(await focusOf(page)).toBe('body');

        await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
        await page.keyboard.press('Meta+KeyZ');
        await settle(page);
        expect(await getSource(page)).toBe(DOC_MORE);

        await pointerOverBlank(page);
        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([DOC]);
    });

    test('@editor フォーカスがどこにもなくても、ポインタが図の上にあれば Space が効く。ポインタが図の外にあれば効かない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await blurAll(page);
        expect(await focusOf(page)).toBe('body');

        await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
        await page.keyboard.down('Space');
        await settle(page);
        expect(await toolState(page)).toEqual(SELECT);
        await page.keyboard.up('Space');
        await resetScroll(page);

        await pointerOverBlank(page);
        await page.keyboard.down('Space');
        await expect.poll(async () => (await toolState(page)).pan).toBe('both');
        expect(await scrollY(page)).toBe(0);
        expect(await pans(page, 'left')).toBe(true);
        await page.keyboard.up('Space');
        await expect.poll(() => toolState(page)).toEqual(SELECT);
    });

    test('@editor ページの textarea にフォーカスがあるときは、ポインタが図の上にあっても ⌘Z と Space が効かず、Space は textarea に入る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await addSourceField(page);
        await setSource(page, DOC_MORE);
        await toolButton(page, 'select').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);

        await page.locator('#source').click();
        expect(await focusOf(page)).toBe('#source');
        await pointerOverBlank(page);
        await page.keyboard.press('Meta+KeyZ');
        await settle(page);
        expect(await getSource(page)).toBe(DOC_MORE);

        await page.keyboard.down('Space');
        await settle(page);
        expect(await toolState(page)).toEqual(SELECT);
        await page.keyboard.up('Space');
        expect(await fieldValue(page)).toBe(' ');
        expect(await focusOf(page)).toBe('#source');
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 同じページの 2 つの editor は互いのキーを受けない (ポインタの上の図か、フォーカスのある図だけが受ける)', async ({ page }) => {
        await open(page);
        await mount(page, DOC, { root: 'a' });
        await mount(page, DOC, { root: 'b' });
        for (const root of ['a', 'b']) {
            await setSource(page, DOC_MORE, root);
            await setSource(page, DOC_MORE2, root);
        }
        expect(await focusOf(page)).toBe('body');

        await pointerOverBlank(page, 'a');
        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page, 'a')).toBe(DOC_MORE);
        await settle(page);
        expect(await getSource(page, 'b')).toBe(DOC_MORE2);

        await page.mouse.move(OVER_B.x, OVER_B.y);
        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page, 'b')).toBe(DOC_MORE);
        await settle(page);
        expect(await getSource(page, 'a')).toBe(DOC_MORE);

        // フォーカスが #a の中にあれば、ポインタが #b の上でも #a だけが受ける
        await toolButton(page, 'hand', 'a').click();
        expect(await focusOf(page)).toBe('#a');
        await page.mouse.move(OVER_B.x, OVER_B.y);
        await page.keyboard.press('Meta+KeyZ');
        await expect.poll(() => getSource(page, 'a')).toBe(DOC);
        await settle(page);
        expect(await getSource(page, 'b')).toBe(DOC_MORE);
        expect(await changeLog(page, 'a')).toEqual([DOC_MORE, DOC]);
        expect(await changeLog(page, 'b')).toEqual([DOC_MORE]);
    });

    test('@editor 原文の欄 (textarea) にフォーカスがあるまま図の何もないところかノードを押すと、フォーカスが図へ移り、Backspace が原文の欄に入らない (B-059)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await addSourceField(page);
        await page.locator('#source').click();
        await page.keyboard.type('abc');

        await press(page, await spot(page, { on: 'blank', root: 'a' }));
        await expect.poll(() => focusOf(page)).toBe('#a');
        await page.keyboard.press('Backspace');
        await settle(page);
        expect(await fieldValue(page)).toBe('abc');

        await page.locator('#source').click();
        expect(await focusOf(page)).toBe('#source');
        await press(page, await spot(page, { on: 'text', selector: '#a .mdag-node[data-id="2"] .mdag-content' }));
        await expect.poll(() => focusOf(page)).toBe('#a');
        await page.keyboard.press('Backspace');
        await settle(page);
        expect(await fieldValue(page)).toBe('abc');
    });
});

test.describe('閲覧と GUI 編集の切り替え (B-169、B-171)', () => {
    test('@editor 閲覧へ切り替えると道具が最初の道具 (選択) に戻る。閲覧では道具箱と案内がなく、Space は効かず、主ボタンのドラッグで図が動く (触る F-04)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH_EDIT));
        expect(await toolState(page)).toEqual(SELECT);
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(1);
        await expect(hint(page)).toHaveCount(1);

        // 最初の道具でない手のひらにしてから、セグメントで閲覧へ
        await toolButton(page, 'hand').click();
        await expect.poll(() => toolState(page)).toEqual(HAND);
        await segmentButton(page, 'view').click();
        await expect.poll(async () => (await toolState(page)).pan).toBeNull();
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(0);
        await expect(hint(page)).toHaveCount(0);
        expect(await pans(page, 'left')).toBe(true);

        await blurAll(page);
        await pointerOverBlank(page);
        await page.keyboard.down('Space');
        await settle(page);
        expect((await toolState(page)).pan).toBeNull();
        await page.keyboard.up('Space');
        await resetScroll(page);

        await segmentButton(page, 'edit').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(1);
        await expect(hint(page)).toHaveCount(1);

        // setMode で閲覧へ
        await toolButton(page, 'hand').click();
        await expect.poll(() => toolState(page)).toEqual(HAND);
        expect(await setMode(page, 'view')).toBe(true);
        await expect.poll(async () => (await toolState(page)).pan).toBeNull();
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(0);
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 閲覧だけの文書には道具箱と案内がない (B-169)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(['mode: view']));
        await expect(visible(page, '#a .mdag-editor-toolbox')).toHaveCount(0);
        await expect(hint(page)).toHaveCount(0);
        expect((await toolState(page)).pan).toBeNull();
    });
});

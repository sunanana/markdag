// GUI 編集の差分のレビューで確かめた指摘 (今直すと仕分けたもの) のうち、画面の振る舞いを、ビルドした配布物の markdag/editor で確かめる。
// 入力とパネルの Esc で図の吹き出しが一緒に閉じないこと (名前の入力とカラーピッカーか詳細表示の選択肢を 1 回の Esc で閉じるのは今のまま)、
// 容器と 1 行目を分け合う項目の帯のタグのボタン、図の領域の外で離したドラッグ、受け口の中の destroy のあとの onChange を見る。
// 見た目そのもの (色、余白、影) は見ない。吹き出し (.mdag-popover の data-id)、入力とパネルの有無、帯のボタンの押せるか、
// 移す先の印 (data-drop-target)、通知 (.mdag-editor-snackbar と data-kind)、原文の全文、onChange の呼ばれ方、選択を見る。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
    // true にすると、次の onSelectionChange の中で図を destroy する (一度だけ)
    destroyOnSelect: boolean;
    // destroy したときの onChange の数 (destroy していなければ null)
    changesAtDestroy: number | null;
};

const DIST = resolve('dist');

const NEW = '新しいノード';

function docWith(markdag: string[], body: string[]): string {
    return ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', ...markdag.map((line) => `    ${line}`), '---', '', ...body].join('\n');
}

// ノードは Root 1、Design 2 (グループ g1)、Task A 3 (詳細あり)、Task B 4、Build 5、Leaf 6。凡例のパネルは右下 (ノードを覆わないように)
const BODY = ['# Root', '', '## Design %g1', '', '- Task A', '    > 詳細 A', '- Task B', '', '## Build', '', '- Leaf', ''];
const GROUPS = ['legend:', '    position: bottom-right', 'groups:', '    g1:', '        label: G1', '        color: "#3366cc"'];
const DOC = docWith(GROUPS, BODY);
const TASK_A = 3;
const TASK_B = 4;

// 見出しの下にリストが 2 つある文書。Root 1、リストの入れ物 2、Task A 3、Task B 4、番号のリストの入れ物 5、1. Step 6、2. Next 7。
// 入れ物は最初の項目と 1 行目を分け合うが、その行の印は最初の項目だけが読む (入れ物は読まない)
const DOC_LISTS = docWith([], ['# Root', '', '- Task A', '- Task B', '', '1. Step', '2. Next', '']);
const LISTS_TASK_A = 3;
const LISTS_TASK_B = 4;
const LISTS_STEP = 6;
const LISTS_NEXT = 7;

// 横に長い木 (4 段の鎖が 6 本)。倍率を上げてパンすると、図の領域の外 (右) にノードが出る
function chainsBody(): string[] {
    const body = ['# R', ''];
    for (let index = 0; index < 6; index += 1) body.push(`- P${index}`, `    - Q${index}`, `        - S${index}`, `            - T${index}`);
    body.push('');
    return body;
}
const DOC_CHAINS = docWith([], chainsBody());

// 受け口の中で destroy する文書。Root 1、a 2、b 3。a に子を足すと NEW が a の子になる
const DOC_SMALL = docWith([], ['# R', '', '- a', '- b', '']);
const DOC_SMALL_CHILD = docWith([], ['# R', '', '- a', `    - ${NEW}`, '- b', '']);

// 付け替えと線を引くドラッグの、ノードの外で離したときの案内 (behaviors B-058。承認した例 screen/move-drag)
const DROP_OUTSIDE = 'ほかのノードの上で離すと、その下へ移ります';
const LINK_OUTSIDE = 'ほかのノードの上で離すと、そのノードへ線を引きます';

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
        target.destroyOnSelect = false;
        target.changesAtDestroy = null;
    });
}

async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            animate: false,
            onChange: (next) => {
                target.changes.push(next);
            },
            onSelectionChange: () => {
                if (!target.destroyOnSelect) return;
                target.destroyOnSelect = false;
                target.changesAtDestroy = target.changes.length;
                target.editors.a?.destroy();
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「呼ばれない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);
const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const target = (id: number, refText: string): NodeTarget => ({ id, refText });

// 原文と onChange が変わらない (数コマ待ってから)
async function expectSourceStill(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await settle(page);
    expect(await getSource(page), message).toBe(source);
    expect(await changeLog(page), message).toEqual(changes);
}

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

async function focusDiagram(page: Page): Promise<void> {
    await page.evaluate(() => document.getElementById('a')?.focus({ preventScroll: true }));
    await expect.poll(() => page.evaluate(() => document.activeElement === document.getElementById('a'))).toBe(true);
}

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank' }
    // 要素 (か中の要素) が表に出ている点
    | { on: 'element'; selector: string };

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
            const container = document.getElementById('a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return (
            grid(rect, Math.max(2, Math.min(rect.width, rect.height) / 8)).find((point) => {
                const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                return hit !== null && element.contains(hit) && !hit.closest('.mdag-tags');
            }) ?? null
        );
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

async function pointerOverBlank(page: Page): Promise<void> {
    const blank = await spot(page, { on: 'blank' });
    await page.mouse.move(blank.x, blank.y);
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = [...targets].sort((a, b) => a.id - b.id);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const container = document.getElementById('a');
                    const editor = (window as unknown as EditorWindow).editors.a;
                    if (!container || !editor) throw new Error('#a の図がない');
                    const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
                    const selection = editor.getSelection();
                    const selected = selection.kind === 'nodes' ? [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText })) : selection.kind;
                    return { marked, selected };
                }),
            message,
        )
        .toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
}

// 見えている吹き出しのノードの id (出ていなければ null)
const popoverOf = (page: Page): Promise<string | null> =>
    page.evaluate(() => {
        const popover = document.querySelector('#a .mdag-popover');
        return popover instanceof HTMLElement && !popover.hidden && popover.checkVisibility() ? popover.getAttribute('data-id') : null;
    });

// 開いている入力とパネル (名前の入力 name、詳細の入力 details、タグのパネル tags、カラーピッカー picker、詳細表示の選択肢 flyout)
const openInputs = (page: Page): Promise<string[]> =>
    page.evaluate(() => {
        const shown = (selector: string): boolean => [...document.querySelectorAll(selector)].some((element) => element.checkVisibility());
        const open: string[] = [];
        if (shown('#a .mdag-editor-name-input')) open.push('name');
        if (shown('#a .mdag-editor-details-editor')) open.push('details');
        if (shown('#a .mdag-editor-tag-panel')) open.push('tags');
        if (shown('#a .mdag-editor-color-picker')) open.push('picker');
        if (shown('#a .mdag-editor-flyout')) open.push('flyout');
        return open;
    });

// 詳細のあるノードの吹き出しを、印の click で出したままにする (GUI 編集の詳細の最初の見せ方はホバー時に表示)
async function pinPopover(page: Page, id: number): Promise<void> {
    await page.locator(`${nodeSelector(id)} .mdag-note-mark`).dispatchEvent('click');
    await expect.poll(() => popoverOf(page)).toBe(String(id));
    // ポインタを図の何もない所へ動かす (ホバーで吹き出しを出し直さないように)
    await pointerOverBlank(page);
    await settle(page);
    expect(await popoverOf(page), '出したままの吹き出し').toBe(String(id));
}

test.describe('入力とパネルの Esc は図の Esc と一緒に働かない (レビュー A-03。design 10.2 の context 7-9)', () => {
    // 編集の層の入力は Esc の keydown の伝搬を止める。図の Esc (吹き出しを閉じる) は、入力を閉じたあとの次の Esc で働く
    const openers: Array<{ name: string; open: (page: Page) => Promise<void>; opened: string }> = [
        { name: '名前の入力 (Enter)', open: (page) => page.keyboard.press('Enter'), opened: 'name' },
        { name: '詳細の入力 (D)', open: (page) => page.keyboard.press('d'), opened: 'details' },
        { name: 'タグのパネル (T)', open: (page) => page.keyboard.press('t'), opened: 'tags' },
    ];
    for (const opener of openers) {
        test(`@editor 吹き出しを出したまま${opener.name}を開いて Esc でやめると、入力は閉じ、吹き出しは出たまま。もう 1 度の Esc で吹き出しが閉じる。原文は変わらない`, async ({ page }) => {
            const errors = watchErrors(page);
            await open(page);
            await mount(page, DOC);
            await pressNode(page, TASK_A);
            await expectSelection(page, [target(TASK_A, 'Task A')]);
            await pinPopover(page, TASK_A);

            await opener.open(page);
            await expect.poll(() => openInputs(page), opener.name).toEqual([opener.opened]);
            expect(await popoverOf(page), `${opener.name}を開いている間`).toBe(String(TASK_A));

            await page.keyboard.press('Escape');
            await expect.poll(() => openInputs(page), `${opener.name}の Esc`).toEqual([]);
            await settle(page);
            expect(await popoverOf(page), `${opener.name}の Esc のあとの吹き出し`).toBe(String(TASK_A));
            await expectSelection(page, [target(TASK_A, 'Task A')], `${opener.name}の Esc のあと`);

            await page.keyboard.press('Escape');
            await expect.poll(() => popoverOf(page), 'もう 1 度の Esc').toBeNull();
            await expectSourceStill(page, DOC, []);
            expect(errors).toEqual([]);
        });
    }

    test('@editor カラーピッカーを開いたまま Enter で開いた名前の入力は、1 回の Esc でピッカーと一緒に閉じる (今のまま。states.md の U-10、D9)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await press(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-legend-row[data-group="g1"] .mdag-editor-legend-chip' }));
        await expect.poll(() => openInputs(page)).toEqual(['picker']);
        await focusDiagram(page);
        await page.keyboard.press('Enter');
        await expect.poll(() => openInputs(page)).toEqual(['name', 'picker']);

        await page.keyboard.press('Escape');
        await expect.poll(() => openInputs(page), '1 回の Esc').toEqual([]);
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 詳細表示の選択肢を押して開いたまま Enter で開いた名前の入力は、1 回の Esc で選択肢と一緒に閉じる (今のまま。states.md の U-10、D11)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await press(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-tool[data-tool="details"]' }));
        await expect.poll(() => openInputs(page)).toEqual(['flyout']);
        await focusDiagram(page);
        await page.keyboard.press('Enter');
        await expect.poll(() => openInputs(page)).toEqual(['name', 'flyout']);

        await page.keyboard.press('Escape');
        await expect.poll(() => openInputs(page), '1 回の Esc').toEqual([]);
        await expectSourceStill(page, DOC, []);
    });
});

// 見えている帯の、押せないボタンの data-command
async function disabledBarButtons(page: Page): Promise<string[] | null> {
    return page.evaluate(() => {
        const bars = [...document.querySelectorAll('#a .mdag-editor-bar')].filter((bar) => bar.checkVisibility());
        const [bar] = bars;
        if (bars.length !== 1 || !bar) return null;
        return [...bar.querySelectorAll('.mdag-editor-bar-button')]
            .filter((button) => button.checkVisibility() && ((button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true'))
            .map((button) => button.getAttribute('data-command') ?? '');
    });
}

test.describe('容器と 1 行目を分け合う項目の帯のタグのボタン (レビュー A-06。design 3.8 の canMark。最後の関門 B-107 / B-135)', () => {
    // 容器は分け合う行の印を読まず、印は最初の項目だけのものなので、最初の項目も 2 つ目からの項目と同じくタグを付けられる (deviations.md の D-036)
    test('@editor 見出しの下のリストの最初の項目でも、帯の「タグ追加」「タグ選択」が押せ、T でタグのパネルが開く。2 つ目からの項目でも押せる。原文は変わらない', async ({ page }) => {
        await open(page);
        await mount(page, DOC_LISTS);
        await useSelectTool(page);
        for (const [id, refText, disabled] of [
            [LISTS_TASK_A, 'Task A', []],
            [LISTS_TASK_B, 'Task B', []],
            [LISTS_STEP, '1. Step', []],
            [LISTS_NEXT, '2. Next', []],
        ] as Array<[number, string, string[]]>) {
            await pressNode(page, id);
            await expectSelection(page, [target(id, refText)], refText);
            await expect.poll(() => disabledBarButtons(page), refText).toEqual(disabled);
        }

        await pressNode(page, LISTS_TASK_A);
        await expectSelection(page, [target(LISTS_TASK_A, 'Task A')]);
        await page.keyboard.press('t');
        await expect.poll(() => openInputs(page)).toEqual(['tags']);
        await expectSourceStill(page, DOC_LISTS, []);
        await expect(visible(page, '#a .mdag-editor-snackbar[data-kind="error"]')).toHaveCount(0);
    });
});

interface OutsidePlacement {
    // 図の領域の中に見えている、動かすノード
    source: { id: number; refText: string; point: Point };
    // 図の領域の外 (右) にある、見えないノード
    hidden: { id: number; refText: string; point: Point };
}

// 倍率とパンを変えて、図の領域の中に見えるノードと、図の領域の右の外 (ウィンドウの中) にあるノードの組を作る。
// 外のノードは、動かすノードの祖先でも子孫でもない (付け替えられる相手)
async function placeOutside(page: Page): Promise<OutsidePlacement> {
    const found = await page.evaluate(() => {
        const editor = (window as unknown as EditorWindow).editors.a;
        const container = document.getElementById('a');
        const doc = editor?.view.getDocument();
        if (!editor || !container || !doc) throw new Error('#a の図がない');
        const area = container.getBoundingClientRect();
        const nodes = doc.parsed.nodes;
        const parentOf = (id: number): number | null => nodes.find((node) => node.id === id)?.parent ?? null;
        const ancestors = (id: number): Set<number> => {
            const out = new Set<number>();
            for (let parent = parentOf(id); parent !== null; parent = parentOf(parent)) out.add(parent);
            return out;
        };
        for (const k of [1.6, 2, 2.4, 2.8, 3.2]) {
            for (const x of [0, -100, -200, -300, -400, -500]) {
                editor.view.setTransform({ x, y: 0, k });
                const inside: Array<{ id: number; cx: number; cy: number }> = [];
                const outside: Array<{ id: number; cx: number; cy: number }> = [];
                for (const [id, rect] of editor.view.nodeRects()) {
                    const cx = rect.x + rect.width / 2;
                    const cy = rect.y + rect.height / 2;
                    if (cy < 40 || cy > area.height - 40) continue;
                    if (rect.x > 20 && rect.x + rect.width < area.width - 120) inside.push({ id, cx, cy });
                    if (cx > area.width + 30 && area.left + cx < innerWidth - 30) outside.push({ id, cx, cy });
                }
                for (const hidden of outside) {
                    const up = ancestors(hidden.id);
                    const source = inside.find((item) => item.id !== 1 && item.id !== hidden.id && !up.has(item.id) && parentOf(item.id) !== hidden.id && !ancestors(item.id).has(hidden.id));
                    if (!source) continue;
                    const refOf = (id: number): string => nodes.find((node) => node.id === id)?.refText ?? '';
                    return {
                        source: { id: source.id, refText: refOf(source.id), point: { x: area.left + source.cx, y: area.top + source.cy } },
                        hidden: { id: hidden.id, refText: refOf(hidden.id), point: { x: area.left + hidden.cx, y: area.top + hidden.cy } },
                    };
                }
            }
        }
        return null;
    });
    if (!found) throw new Error('図の領域の外にノードを置けなかった');
    await settle(page);
    return found;
}

// 今の表示でのノードの箱の真ん中 (画面の座標)
async function centerOf(page: Page, id: number): Promise<Point> {
    const point = await page.evaluate((id) => {
        const editor = (window as unknown as EditorWindow).editors.a;
        const area = document.getElementById('a')?.getBoundingClientRect();
        const rect = editor?.view.nodeRects([id]).get(id);
        if (!area || !rect) return null;
        return { x: area.left + rect.x + rect.width / 2, y: area.top + rect.y + rect.height / 2 };
    }, id);
    if (!point) throw new Error(`ノード ${id} の矩形がない`);
    return point;
}

// 図の領域の右の辺 (画面の座標)
const areaRight = (page: Page): Promise<number> => page.evaluate(() => document.getElementById('a')?.getBoundingClientRect().right ?? Number.NaN);

const dropTarget = (page: Page): Promise<string | null> => page.evaluate(() => document.querySelector('#a .mdag-node[data-drop-target]')?.getAttribute('data-id') ?? null);

// 押して、途中を通って、離す前の所まで動かす (離さない)
async function dragTo(page: Page, from: Point, to: Point): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 20; step += 1) await page.mouse.move(from.x + ((to.x - from.x) * step) / 20, from.y + ((to.y - from.y) * step) / 20);
    await settle(page);
}

test.describe('図の領域の外で離したドラッグ (レビュー B-04。behaviors B-058、承認した例 screen/move-drag)', () => {
    test('@editor 付け替えのドラッグを、図の領域の外にある見えないノードの位置で離しても付け替えない。ドラッグ中に移す先の印は付かず、離すとノードの外で離したときの案内が出る。原文は変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_CHAINS);
        await useSelectTool(page);
        const placed = await placeOutside(page);
        // 空振りの防ぎ: 外のノードは図の領域の外で、付け替えれば書き換わる相手
        expect(placed.hidden.point.x).toBeGreaterThan(await areaRight(page));
        const status = await page.evaluate(
            ({ source, hidden }) => {
                const harness = window as unknown as EditorWindow;
                const markdown = harness.editors.a?.getSource() ?? '';
                return harness.editorHarness.core.editSource(markdown, { kind: 'moveNode', node: source, parent: hidden }).status;
            },
            { source: target(placed.source.id, placed.source.refText), hidden: target(placed.hidden.id, placed.hidden.refText) },
        );
        expect(status).toBe('edited');

        await dragTo(page, placed.source.point, placed.hidden.point);
        expect(await dropTarget(page), 'ドラッグ中の移す先の印').toBeNull();
        await page.mouse.up();
        await expect(visible(page, '#a .mdag-editor-snackbar[data-kind="info"]')).toHaveText(DROP_OUTSIDE);
        await expectSourceStill(page, DOC_CHAINS, []);
        expect(await dropTarget(page)).toBeNull();
        expect(errors).toEqual([]);
    });

    test('@editor 線を引くドラッグを、図の領域の外にある見えないノードの位置で離しても線を引かない。ドラッグ中に相手の印は付かず、離すとノードの外で離したときの案内が出る。原文は変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_CHAINS);
        await useSelectTool(page);
        const placed = await placeOutside(page);
        await pressNode(page, placed.source.id);
        await expectSelection(page, [target(placed.source.id, placed.source.refText)]);
        await expect(visible(page, '#a .mdag-editor-handle[data-handle="link"]')).toHaveCount(1);
        // 選んだときに表示が動いても、外のノードが図の領域の外にあるままか見直す
        const hidden = await centerOf(page, placed.hidden.id);
        expect(hidden.x).toBeGreaterThan(await areaRight(page));

        await dragTo(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-handle[data-handle="link"]' }), hidden);
        expect(await dropTarget(page), 'ドラッグ中の相手の印').toBeNull();
        await page.mouse.up();
        await expect(visible(page, '#a .mdag-editor-snackbar[data-kind="info"]')).toHaveText(LINK_OUTSIDE);
        await expectSourceStill(page, DOC_CHAINS, []);
        expect(errors).toEqual([]);
    });
});

test.describe('受け口の中の destroy (レビュー B-11。design 1.2 の破棄の順の (7))', () => {
    test('@editor onSelectionChange の中で destroy したあとは、onChange を呼ばない。ページの誤りは出ず、getSource は書き換えたあとの原文で、名前の入力も図も残らない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_SMALL);
        await pressNode(page, 2);
        await expectSelection(page, [target(2, 'a')]);
        await settle(page);
        await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            target.changes = [];
            target.destroyOnSelect = true;
        });

        await page.keyboard.press('Tab');
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).changesAtDestroy)).not.toBeNull();
        await settle(page);
        const state = await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            return {
                after: target.changes.length - (target.changesAtDestroy ?? 0),
                nameInputs: document.querySelectorAll('.mdag-editor-name-input').length,
                nodes: document.querySelectorAll('#a .mdag-node').length,
                editorLayer: document.querySelectorAll('#a .mdag-editor').length,
            };
        });
        expect(state).toEqual({ after: 0, nameInputs: 0, nodes: 0, editorLayer: 0 });
        expect(await getSource(page)).toBe(DOC_SMALL_CHILD);
        expect(errors).toEqual([]);
    });
});

// GUI 編集の矩形選択の途中の Esc を、ビルドした配布物の markdag/editor で確かめる。
// 矩形選択の途中の Esc は、ほかのドラッグ (付け替え、線) とそろえて矩形をやめる (例を承認するときに依頼者が決めた)。
// 矩形が消え、そのあと離しても何も選ばない。選択は Esc の前のまま残す (Esc で選択を解かない)。修飾キーつきの矩形でも同じ。
// 矩形は何もないところからのドラッグ (選択の道具、主ボタン) で、修飾キーは押下の時に押していたか。
// 修飾キーつきの矩形では、修飾キーを離してから Esc を押す場面と、修飾キーを押したまま Esc を押す場面を見る。
// 矩形の途中の Esc は、修飾キー (Shift、⌘、Ctrl) を押したままでもやめる (矩形をドラッグしている間だけの決まりで、ほかの場面のキーの表は変えない)。
// 見た目そのもの (色、線) は見ない。目印 (.mdag-editor-marquee の有無、.mdag-node の data-selected、.mdag-editor-selection-bounds の数)、
// getSelection と onSelectionChange、原文を見る。反映は expect.poll で待ち、「変わらない」「出ない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';

interface ChangeEntry {
    root: string;
    markdown: string;
}

interface SelectionEntry {
    root: string;
    selection: EditorSelection;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: ChangeEntry[];
    // onSelectionChange に届いた選択 (呼ばれた順)
    selections: SelectionEntry[];
};

const DIST = resolve('dist');

// 選択に足す修飾キー。macOS では Ctrl +クリックが副ボタンのクリックになるので押さない (editor-select と同じ)
const MODIFIERS: readonly string[] = process.platform === 'darwin' ? ['Shift', 'Meta'] : ['Shift', 'Meta', 'Control'];

// ノードは Root 1、Design 2、Task A 3、Task B 4、Task C 5、Build 6、Leaf 7。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '- Task C', '', '## Build', '', '- Leaf', ''];
const TASK_A = 3;
const TASK_B = 4;
const TASK_C = 5;
const LEAF = 7;

const DOC = ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '---', '', ...BODY].join('\n');

// 矩形で囲むノード (Esc の前の選択とは重ならない)
const TARGETS = [TASK_A, TASK_B];

// Esc の前の選択の場面 (ノード 1 つ、2 つ以上、なし)
const BEFORE: ReadonlyArray<{ name: string; ids: number[] }> = [
    { name: 'ノード 1 つ', ids: [LEAF] },
    { name: '2 つ以上', ids: [TASK_C, LEAF] },
    { name: 'なし', ids: [] },
];

interface Point {
    x: number;
    y: number;
}

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface Drag {
    from: Point;
    to: Point;
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
        target.selections = [];
    });
}

// 図を (あれば片付けてから) 描き、onChange と onSelectionChange の記録を空にする
async function mountFresh(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
        target.selections = [];
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            animate: false,
            onChange: (next) => {
                target.changes.push({ root: 'a', markdown: next });
            },
            onSelectionChange: (selection) => {
                target.selections.push({ root: 'a', selection: JSON.parse(JSON.stringify(selection)) as EditorSelection });
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「出ない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const selectionCount = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as EditorWindow).selections.length);

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const marquees = (page: Page) => visible(page, '#a .mdag-editor-marquee');
const selectionBounds = (page: Page) => visible(page, '#a .mdag-editor-selection-bounds');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

async function useSelectTool(page: Page): Promise<void> {
    await page.locator('#a .mdag-editor-tool[data-tool="select"]').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

interface SelectedState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // getSelection のノードの id (昇順)。何も選んでいなければ空、ノードでなければ kind
    selected: number[] | string;
}

async function selectedOf(page: Page): Promise<SelectedState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        const editor = (window as unknown as EditorWindow).editors.a;
        if (!container || !editor) throw new Error('#a の図がない');
        const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        const selection = editor.getSelection();
        const selected = selection.kind === 'nodes' ? selection.nodes.map((target) => target.id).sort((a, b) => a - b) : selection.kind === 'none' ? [] : selection.kind;
        return { marked, selected };
    });
}

// 選んでいるノードが ids になるまで待つ (図の印と getSelection の両方)
async function expectSelected(page: Page, ids: number[], message?: string): Promise<void> {
    const sorted = [...ids].sort((a, b) => a - b);
    await expect.poll(() => selectedOf(page), message).toEqual({ marked: sorted, selected: sorted });
}

// 選択が変わらないことを見る (数コマ待ってから)
async function expectStillSelected(page: Page, ids: number[], message?: string): Promise<void> {
    await settle(page);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(await selectedOf(page), message).toEqual({ marked: sorted, selected: sorted });
}

// 矩形が出ていないことを見る (数コマ待ってから)
async function expectNoMarquee(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect(await marquees(page).count(), message).toBe(0);
}

// 見えている要素の矩形 (画面の座標)
async function rectsOf(page: Page, selector: string): Promise<Box[]> {
    return page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)]
            .filter((element) => element.checkVisibility())
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            });
    }, selector);
}

// 要素 (か中の要素) が表に出ている点 (真ん中に近い点から試す)
async function elementSpot(page: Page, selector: string): Promise<Point> {
    const found = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const step = Math.max(2, Math.min(rect.width, rect.height) / 8);
        const points: Point[] = [];
        for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        return (
            points.find((point) => {
                const hit = document.elementFromPoint(point.x, point.y);
                return hit !== null && element.contains(hit);
            }) ?? null
        );
    }, selector);
    if (!found) throw new Error(`押せる点がない: ${selector}`);
    return found;
}

// 図の何もないところ (図の領域そのものが表に出ている点)
async function blankSpot(page: Page): Promise<Point> {
    const found = await page.evaluate(() => {
        const container = document.getElementById('a');
        const viewport = container?.querySelector(':scope > .mdag-viewport');
        if (!container || !viewport) return null;
        const rect = container.getBoundingClientRect();
        const points: Point[] = [];
        for (let y = rect.top + 8; y < rect.bottom; y += 16) for (let x = rect.left + 8; x < rect.right; x += 16) points.push({ x, y });
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        return points.find((point) => document.elementFromPoint(point.x, point.y) === viewport) ?? null;
    });
    if (!found) throw new Error('図の何もないところがない');
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

// ノードの箱を押す (修飾キーつきもある)
async function pressNode(page: Page, id: number, modifier: string | null = null): Promise<void> {
    const point = await elementSpot(page, `${nodeSelector(id)} .mdag-box`);
    if (modifier !== null) await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        if (modifier !== null) await page.keyboard.up(modifier);
    }
}

// ids を選んだ状態にする (なしなら何もしない。2 つめからは Shift +クリックで足す)
async function selectNodes(page: Page, ids: number[]): Promise<void> {
    for (const [index, id] of ids.entries()) await pressNode(page, id, index === 0 ? null : 'Shift');
    await expectSelected(page, ids, '矩形の前の選択');
}

// 矩形の要素がドラッグの範囲 (from と to を角とする矩形) に出ている
async function expectMarqueeBetween(page: Page, from: Point, to: Point): Promise<void> {
    await expect(marquees(page)).toHaveCount(1);
    const expected: Box = { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), right: Math.max(from.x, to.x), bottom: Math.max(from.y, to.y) };
    await expect
        .poll(async () => {
            const [rect] = await rectsOf(page, '#a .mdag-editor-marquee');
            if (!rect) return null;
            return (['left', 'top', 'right', 'bottom'] as const).every((side) => Math.abs(rect[side] - expected[side]) <= 2);
        })
        .toBe(true);
}

// 何もないところから始め、ちょうど targets の箱にかかる (ほかの箱にかからない) 矩形のドラッグを探す (editor-select と同じ)
async function marqueeFor(page: Page, targets: number[]): Promise<Drag> {
    const found = await page.evaluate(
        ({ targets }) => {
            const container = document.getElementById('a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            const area = container.getBoundingClientRect();
            const boxes = [...container.querySelectorAll<HTMLElement>('.mdag-node[data-id]')].flatMap((node) => {
                const rect = node.querySelector('.mdag-box')?.getBoundingClientRect();
                return rect && rect.width > 0 && rect.height > 0 ? [{ id: Number(node.dataset.id), rect }] : [];
            });
            const picked = boxes.filter((box) => targets.includes(box.id)).map((box) => box.rect);
            if (picked.length !== targets.length) return null;
            const left = Math.min(...picked.map((rect) => rect.left));
            const top = Math.min(...picked.map((rect) => rect.top));
            const right = Math.max(...picked.map((rect) => rect.right));
            const bottom = Math.max(...picked.map((rect) => rect.bottom));
            const inside = (x: number, y: number): boolean => x > area.left + 2 && y > area.top + 2 && x < area.right - 2 && y < area.bottom - 2;
            const blank = (x: number, y: number): boolean => inside(x, y) && document.elementFromPoint(x, y) === viewport;
            const hits = (a: { x: number; y: number }, b: { x: number; y: number }): number[] => {
                const l = Math.min(a.x, b.x);
                const r = Math.max(a.x, b.x);
                const t = Math.min(a.y, b.y);
                const btm = Math.max(a.y, b.y);
                return boxes
                    .filter((box) => box.rect.left < r && box.rect.right > l && box.rect.top < btm && box.rect.bottom > t)
                    .map((box) => box.id)
                    .sort((x, y) => x - y);
            };
            const wanted = [...targets].sort((a, b) => a - b).join(',');
            for (const margin of [6, 8, 10, 12, 16, 20, 24, 30, 40]) {
                const corners = [
                    { x: left - margin, y: top - margin },
                    { x: right + margin, y: top - margin },
                    { x: right + margin, y: bottom + margin },
                    { x: left - margin, y: bottom + margin },
                ];
                for (const [index, from] of corners.entries()) {
                    const to = corners[(index + 2) % 4];
                    if (!to || !blank(from.x, from.y) || !inside(to.x, to.y)) continue;
                    if (hits(from, to).join(',') === wanted) return { from, to };
                }
            }
            return null;
        },
        { targets },
    );
    if (!found) throw new Error(`ノード ${targets.join(', ')} だけにかかる矩形のドラッグがない`);
    return found;
}

// 矩形で targets を囲む (修飾キーつきもある。矩形の要素が出ていることも見る)
async function marqueeSelect(page: Page, targets: number[], modifier: string | null = null): Promise<void> {
    const { from, to } = await marqueeFor(page, targets);
    if (modifier !== null) await page.keyboard.down(modifier);
    try {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + (to.x - from.x) * 0.3, from.y + (to.y - from.y) * 0.3, { steps: 4 });
        await page.mouse.move(to.x, to.y, { steps: 4 });
        await expectMarqueeBetween(page, from, to);
        await page.mouse.up();
    } finally {
        if (modifier !== null) await page.keyboard.up(modifier);
    }
    await expect(marquees(page)).toHaveCount(0);
}

// 図の領域の中で、to からさらに from の反対へ動かした点 (矩形が続いていれば広がる向き)
async function beyond(page: Page, drag: Drag): Promise<Point> {
    const [area] = await rectsOf(page, '#a');
    if (!area) throw new Error('#a がない');
    const step = (a: number, b: number): number => (b >= a ? 60 : -60);
    return {
        x: Math.min(area.right - 10, Math.max(area.left + 10, drag.to.x + step(drag.from.x, drag.to.x))),
        y: Math.min(area.bottom - 10, Math.max(area.top + 10, drag.to.y + step(drag.from.y, drag.to.y))),
    };
}

// 修飾キーの扱い: none は修飾キーなしの矩形、lift は修飾キーを押して矩形を始め、Esc の前に離す、hold は修飾キーを押したまま Esc を押して離す
type ModifierUse = { kind: 'none' } | { kind: 'lift' | 'hold'; key: string };

const useLabel = (use: ModifierUse): string =>
    use.kind === 'none' ? '修飾キーなし' : use.kind === 'lift' ? `${use.key} の矩形 (Esc の前に ${use.key} を離す)` : `${use.key} の矩形 (${use.key} を押したまま Esc)`;

// 矩形で TARGETS を囲む途中で Esc を押す。矩形が消え、ポインタを動かしても戻らず、releaseAt (far はドラッグの終わりの点、
// start は押した所から 1px) で離しても、選択は Esc の前 (before) のまま。onSelectionChange は呼ばれず、原文も変わらない
async function escapeMidMarquee(page: Page, before: number[], use: ModifierUse, releaseAt: 'far' | 'start', label: string): Promise<void> {
    await mountFresh(page, DOC);
    await useSelectTool(page);
    await selectNodes(page, before);
    const calls = await selectionCount(page);
    const drag = await marqueeFor(page, TARGETS);
    const { from, to } = drag;
    const further = await beyond(page, drag);
    const held = use.kind === 'none' ? null : use.key;
    if (held !== null) await page.keyboard.down(held);
    try {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + (to.x - from.x) * 0.3, from.y + (to.y - from.y) * 0.3, { steps: 4 });
        await page.mouse.move(to.x, to.y, { steps: 4 });
        await expectMarqueeBetween(page, from, to);
        // 矩形の途中は、離すまで選択を変えない (Esc の前の選択は before)
        await expectStillSelected(page, before, `${label}: Esc の前`);
        if (use.kind === 'lift') await page.keyboard.up(use.key);
        await page.keyboard.press('Escape');
        await expect(marquees(page), `${label}: Esc のあと矩形が消える`).toHaveCount(0);
        await expectStillSelected(page, before, `${label}: Esc で選択を解かない`);
        // Esc のあとポインタを動かしても矩形は戻らない
        await page.mouse.move(further.x, further.y, { steps: 6 });
        await expectNoMarquee(page, `${label}: Esc のあと広げる向きへ動かしても矩形が戻らない`);
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await expectNoMarquee(page, `${label}: Esc のあと囲む所へ戻しても矩形が戻らない`);
        if (releaseAt === 'start') {
            await page.mouse.move(from.x + 1, from.y + 1, { steps: 6 });
            await expectNoMarquee(page, `${label}: Esc のあと押した所へ戻しても矩形が戻らない`);
        }
        await page.mouse.up();
    } finally {
        if (use.kind === 'hold') await page.keyboard.up(use.key);
    }
    await expectNoMarquee(page, `${label}: 離したあと`);
    await expectStillSelected(page, before, `${label}: 離しても選択は Esc の前のまま`);
    await expect(selectionBounds(page), `${label}: 2 つ以上を選んだ外枠`).toHaveCount(before.length >= 2 ? 1 : 0);
    expect(await selectionCount(page), `${label}: onSelectionChange は呼ばれない`).toBe(calls);
    expect(await getSource(page), label).toBe(DOC);
    expect(await changeLog(page), label).toEqual([]);
}

test.describe('矩形選択の途中の Esc (固める U-08、B-060、B-061、states.md の E4.e5)', () => {
    test('@editor 修飾キーなしの矩形の途中の Esc で矩形が消え、ポインタを動かしても戻らず、離しても何も選ばない。選択は Esc の前のまま (ノード 1 つ、2 つ以上、なし)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        for (const before of BEFORE) {
            await escapeMidMarquee(page, before.ids, { kind: 'none' }, 'far', `修飾キーなし / ${before.name}`);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 修飾キーつき (Shift / ⌘ (/ Ctrl)) の矩形の途中の Esc でも矩形が消え、ポインタを動かしても戻らず、離しても足さない。選択は Esc の前のまま (ノード 1 つ、2 つ以上、なし。修飾キーを離してから Esc と、Shift を押したまま Esc)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const uses: ModifierUse[] = [...MODIFIERS.map((key): ModifierUse => ({ kind: 'lift', key })), { kind: 'hold', key: 'Shift' }];
        for (const use of uses) {
            for (const before of BEFORE) {
                await escapeMidMarquee(page, before.ids, use, 'far', `${useLabel(use)} / ${before.name}`);
            }
        }
        expect(errors).toEqual([]);
    });

    test('@editor ⌘ (macOS 以外は Ctrl も) を押して始めた矩形の途中で、⌘ (Ctrl) を押したまま Esc を押しても矩形が消え、ポインタを動かしても戻らず、離しても足さない。選択は Esc の前のまま (ノード 1 つ、2 つ以上、なし)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const uses: ModifierUse[] = MODIFIERS.filter((key) => key !== 'Shift').map((key): ModifierUse => ({ kind: 'hold', key }));
        expect(uses.length).toBeGreaterThan(0);
        for (const use of uses) {
            for (const before of BEFORE) {
                await escapeMidMarquee(page, before.ids, use, 'far', `${useLabel(use)} / ${before.name}`);
            }
        }
        expect(errors).toEqual([]);
    });

    test('@editor 矩形の途中の Esc のあと、押した所の近く (1px) まで戻して離しても、何もないところのクリックにならず、選択は Esc の前のまま (修飾キーなしと修飾キーつき。ノード 1 つ、2 つ以上、なし)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const uses: ModifierUse[] = [{ kind: 'none' }, ...MODIFIERS.map((key): ModifierUse => ({ kind: 'lift', key }))];
        for (const use of uses) {
            for (const before of BEFORE) {
                await escapeMidMarquee(page, before.ids, use, 'start', `${useLabel(use)} / ${before.name} / 押した所の近くで離す`);
            }
        }
        expect(errors).toEqual([]);
    });

    test('@editor 矩形を Esc でやめて離したあとも、何もないところのクリック、次の矩形 (修飾キーなしは置き換え、修飾キーつきは足す) はふだんどおり', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, DOC);
        await useSelectTool(page);
        await selectNodes(page, [LEAF]);
        const cancelMarquee = async (): Promise<void> => {
            const { from, to } = await marqueeFor(page, TARGETS);
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            await page.mouse.move(to.x, to.y, { steps: 6 });
            await expectMarqueeBetween(page, from, to);
            await page.keyboard.press('Escape');
            await page.mouse.up();
            await expectNoMarquee(page);
        };
        await cancelMarquee();
        // 何もないところのクリックは選択を解く
        await press(page, await blankSpot(page));
        await expectSelected(page, [], 'Esc でやめたあとの何もないところのクリック');

        await selectNodes(page, [LEAF]);
        await cancelMarquee();
        await marqueeSelect(page, TARGETS);
        await expectSelected(page, TARGETS, 'Esc でやめたあとの修飾キーなしの矩形');
        await marqueeSelect(page, [LEAF], 'Shift');
        await expectSelected(page, [...TARGETS, LEAF], 'そのあとの Shift の矩形');
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
        expect(errors).toEqual([]);
    });
});

// 押下で始まったクリックが、押したノードの選択を解かないことを、ビルドした配布物の markdag/editor で 3 ブラウザ確かめる。
// 何もないところのクリック (選択の道具で選択を解く) は、離したときの click の相手だけでは決まらない。次の 2 つの形では、
// ノードの上で押したのに click の相手が図の領域 (.mdag-viewport) になる:
// - 押下の中で書き換えて描き直し、押した要素が外れる (名前の入力と詳細の入力の確定、合流先の押下)。firefox だけが離したあとに
//   click を出し、相手は押した所と離した所の共通の祖先になる (chromium と webkit は click を出さない)
// - ノードの箱の端を押し、箱の外の何もないところで離す (4px までの動きはクリック)。3 ブラウザとも click の相手は共通の祖先
// どちらも押したノードが選ばれたままになることを見る (states.md の D3、D6 の「ノードを押す」、5.2 の軸 B と軸 E)。合流先の形は editor-join.spec.ts が見る。
// 見た目そのものは見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、選択 (data-selected と getSelection、onSelectionChange の最後)、
// 名前の入力と詳細の入力の有無を見る。反映は expect.poll で待ち、「解けない」「変わらない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, EditSelection, NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
    // onSelectionChange に届いた選択 (呼ばれた順)
    selections: EditSelection[];
};

const DIST = resolve('dist');

function docWith(body: string[]): string {
    return ['---', 'markdag:', '    editor:', '        mode: edit', '---', '', ...body].join('\n');
}

// Design の下の項目だけを替えた本文。ノードは Root 1、Design 2、項目 (3 から文書の順)、Build、Leaf
function designBody(items: string[]): string[] {
    return ['# Root', '', '## Design', '', ...items, '', '## Build', '', '- Leaf', ''];
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ (Leaf は右の列のいちばん下)
const DOC = docWith(designBody(['- Task A', '- Task B']));
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;

// Task B の名前を Renamed に決めた原文
const DOC_B_RENAMED = docWith(designBody(['- Task A', '- Renamed']));
// 詳細のない Task B に詳細を足した原文 (項目の直下の引用)
const DETAILS = '外で決める';
const DOC_B_DETAILS = docWith(designBody(['- Task A', '- Task B', `    > ${DETAILS}`]));

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
            onSelectionChange: (selection) => {
                target.selections.push(JSON.parse(JSON.stringify(selection)) as EditSelection);
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「解けない」「変わらない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

// 配布物の editSource で同じ書き換えを試す (期待の原文の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

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

async function boxOf(page: Page, id: number): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
    if (!box) throw new Error(`ノード ${id} の箱がない`);
    return box;
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
                return hit !== null && element.contains(hit);
            }) ?? null
        );
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

// 点の上に出ているもの。ノードの中なら node:<id>、図の領域そのもの (何もないところ) なら blank、ほかは要素の名前と最初のクラス
const hitAt = (page: Page, point: Point): Promise<string> =>
    page.evaluate((point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        if (!hit) return 'none';
        const node = hit.closest<HTMLElement>('#a .mdag-node');
        if (node) return `node:${node.dataset.id ?? ''}`;
        if (hit === document.querySelector('#a > .mdag-viewport')) return 'blank';
        const name = typeof hit.className === 'string' ? hit.className : '';
        return `${hit.tagName.toLowerCase()}.${name.split(' ')[0] ?? ''}`;
    }, point);

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

// ノードの箱を押す
async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

async function pressBlank(page: Page): Promise<void> {
    await press(page, await spot(page, { on: 'blank' }));
}

const target = (id: number, refText: string): NodeTarget => ({ id, refText });

const sortedTargets = (targets: readonly NodeTarget[]): NodeTarget[] => [...targets].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }));

interface SelectionState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // getSelection のノード (id の昇順)。何も選んでいなければ空、ノードでなければ kind
    selected: NodeTarget[] | string;
}

async function selectionOf(page: Page): Promise<SelectionState> {
    const state = await page.evaluate(() => {
        const container = document.getElementById('a');
        const editor = (window as unknown as EditorWindow).editors.a;
        if (!container || !editor) throw new Error('#a の図がない');
        const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        return { marked, selection: editor.getSelection() };
    });
    const { selection } = state;
    const selected = selection.kind === 'nodes' ? sortedTargets(selection.nodes) : selection.kind === 'none' ? [] : selection.kind;
    return { marked: state.marked, selected };
}

// onSelectionChange に最後に届いた選択 (ノードは id の昇順)
async function lastSelectionChange(page: Page): Promise<NodeTarget[] | string | null> {
    const last = await page.evaluate(() => (window as unknown as EditorWindow).selections.at(-1) ?? null);
    if (last === null) return null;
    return last.kind === 'nodes' ? sortedTargets(last.nodes) : last.kind === 'none' ? [] : last.kind;
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方。getSelection は id と refText)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = sortedTargets(targets);
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
}

// 選んでいるノードが targets になり、描画の数コマと 200ms を待ったあとも targets のまま (離したあとの click で解けない)。
// onSelectionChange に最後に届いた選択も targets
async function expectSelectionStays(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = sortedTargets(targets);
    await expectSelection(page, sorted, message);
    await settle(page);
    expect(await selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
    expect(await lastSelectionChange(page), message).toEqual(sorted);
}

// 原文が source になり、onChange の記録が changes になるまで待つ
async function expectSource(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await expect.poll(() => getSource(page), message).toBe(source);
    await expect.poll(() => changeLog(page), message).toEqual(changes);
}

// 原文と onChange が変わらない (数コマ待ってから)
async function expectSourceStill(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await settle(page);
    expect(await getSource(page), message).toBe(source);
    expect(await changeLog(page), message).toEqual(changes);
}

// 付け替えの移す先の枠 (data-drop-target) と名前の影 (.mdag-editor-ghost) が出ていない (数コマ待ってから)
async function expectNoDragFeedback(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect(await page.locator('#a .mdag-node[data-drop-target]').count(), message).toBe(0);
    expect(await visible(page, '#a .mdag-editor-ghost').count(), message).toBe(0);
}

interface InputState {
    // 見えている入力の数
    count: number;
    // 入力欄の値 (1 つのときだけ)
    value: string | null;
    // フォーカスが入力欄にある
    focused: boolean;
}

// 名前の入力 (.mdag-editor-name-input[data-for="node"]) か詳細の入力 (.mdag-editor-details-editor)。要素そのものが入力欄でも、その中に入力欄があってもよい
async function inputOf(page: Page, selector: string): Promise<InputState> {
    return page.evaluate((selector) => {
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...document.querySelectorAll(selector)].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, focused: false };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
        return { count: 1, value, focused };
    }, selector);
}

const NAME_INPUT = '#a .mdag-editor-name-input[data-for="node"]';
const DETAILS_EDITOR = '#a .mdag-editor-details-editor';

// 入力が 1 つ開き、値が value で、フォーカスが入力欄にあるまで待つ
async function expectInputOpen(page: Page, selector: string, value: string, message?: string): Promise<void> {
    await expect.poll(() => inputOf(page, selector), message).toEqual({ count: 1, value, focused: true });
}

// 入力が閉じるまで待つ
async function expectInputClosed(page: Page, selector: string, message?: string): Promise<void> {
    await expect.poll(async () => (await inputOf(page, selector)).count, message).toBe(0);
}

// 入力欄の値を全部選んで text を打つ
async function replaceText(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
}

test.describe('押下の中の描き直しで押した要素が外れても、押したノードを選ぶ (states.md の D3、D6。firefox の click)', () => {
    test('@editor 名前の入力中に別のノードを押すと、入れた名前で決めて閉じ、押したノードが選ばれたままになる (states.md の D3「決めて → D1。押したノードを選ぶ」)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        // 何もないところのクリックで選択を解くのは選択の道具 (最初の道具)
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('Enter');
        await expectInputOpen(page, NAME_INPUT, 'Task B');
        await replaceText(page, 'Renamed');
        await expectInputOpen(page, NAME_INPUT, 'Renamed');
        await expectSourceStill(page, DOC, [], '押す前');

        await pressNode(page, LEAF);
        await expectSource(page, DOC_B_RENAMED, [DOC_B_RENAMED]);
        await expectInputClosed(page, NAME_INPUT);
        await expectSelectionStays(page, [target(LEAF, 'Leaf')], '押した Leaf');
        expect(errors).toEqual([]);
    });

    test('@editor 詳細の入力中に別のノードを押すと、保存して閉じ、押したノードが選ばれたままになる (states.md の D6「保存して → D1。押したノードを選ぶ」)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        // 期待の原文の空振りの防ぎ: 配布物の editSource で同じ原文になる
        expect(editedSource(await tryEdit(page, DOC, { kind: 'setDetails', node: target(TASK_B, 'Task B'), text: DETAILS }))).toBe(DOC_B_DETAILS);
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('d');
        await expectInputOpen(page, DETAILS_EDITOR, '');
        await page.keyboard.type(DETAILS);
        await expectInputOpen(page, DETAILS_EDITOR, DETAILS);
        await expectSourceStill(page, DOC, [], '押す前');

        await pressNode(page, DESIGN);
        await expectSource(page, DOC_B_DETAILS, [DOC_B_DETAILS]);
        await expectInputClosed(page, DETAILS_EDITOR);
        await expectSelectionStays(page, [target(DESIGN, 'Design')], '押した Design');
        expect(errors).toEqual([]);
    });
});

test.describe('ノードの箱の端を押して箱の外で離す (5.2 の軸 B と軸 E。4px までの動きはクリック)', () => {
    test('@editor 選択の道具でノードの箱の端を押し、箱の外の何もないところへ 3px 動かして離しても、押したノードが選ばれたままで、原文は変わらない (右の端と下の端)。何もないところを押せば選択は解ける', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');

        for (const side of ['right', 'bottom'] as const) {
            // 前から選んでいるノードを Task A にしておく (押した Leaf に選び直されることを見分ける)
            await pressNode(page, TASK_A);
            await expectSelection(page, [target(TASK_A, 'Task A')], side);

            const box = await boxOf(page, LEAF);
            const middle = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
            const from = side === 'right' ? { x: box.right - 1, y: middle.y } : { x: middle.x, y: box.bottom - 1 };
            const to = side === 'right' ? { x: box.right + 2, y: middle.y } : { x: middle.x, y: box.bottom + 2 };
            expect(await hitAt(page, from), `${side}: 押す所は Leaf`).toBe(`node:${String(LEAF)}`);

            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            try {
                // 押したあと (Leaf を選んだあと) に、離す所が何もないところ (帯や点の上でない)
                expect(await hitAt(page, to), `${side}: 離す所は何もないところ`).toBe('blank');
                await page.mouse.move(to.x, to.y, { steps: 2 });
            } finally {
                await page.mouse.up();
            }

            await expectSelectionStays(page, [target(LEAF, 'Leaf')], `${side}: 押した Leaf`);
            await expectNoDragFeedback(page, side);
            await expectSourceStill(page, DOC, [], side);
        }

        // 空振りの防ぎ: 何もないところで押して離すクリックは、今までどおり選択を解く
        await pressBlank(page);
        await expectSelection(page, [], '何もないところ');
        expect(await lastSelectionChange(page), '何もないところ').toEqual([]);
        expect(errors).toEqual([]);
    });
});

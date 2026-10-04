// GUI 編集の名前の入力と、子、兄弟、名前の変更を、ビルドした配布物の markdag/editor で確かめる。
// addChild、addSibling、renameNode の書き換えと選び直し、子と兄弟の行の形、名前の行、空の名前、名前の入力のキー (変換中のキーは操作にしない)、
// 名前の入力の置き場 (ノードのラベル)、元に戻す / やり直す、setSource と setMode を見る。F2 のキーは入れない。
// 見た目そのもの (色、余白、影) は見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、選び直し (data-selected と getSelection)、
// 名前の入力の有無、値、選んだ範囲、フォーカス、置き場 (ノードのラベルに重なるか)、通知 (.mdag-editor-snackbar と data-kind)、元に戻す / やり直すを見る。
// 期待の原文は子と兄弟の行の規則から書いた (子の字下げ 4、最後の子の形、見出しの前の空行)。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「開かない」は描画の数コマと 200ms を待ってから見る。
// ファイルの末尾は削除と付け替えのドラッグ。deleteNodes と moveNode の書き換え (削除の追随を含む)、付け替えの移す先の印
// (setDropTarget、data-drop-target)、ドラッグの影 (.mdag-editor-ghost) を見る。Delete はノードの削除だけ
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, EditSelection, NodeTarget, ViewTransform } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

interface ChangeEntry {
    root: string;
    markdown: string;
}

interface SelectionEntry {
    root: string;
    selection: EditSelection;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: ChangeEntry[];
    // onSelectionChange に届いた選択 (呼ばれた順)
    selections: SelectionEntry[];
    // true のあいだ beforeUpdate のフックが原文の差し替えを取りやめる (mount の hooks: 'gate')
    blockUpdates: boolean;
};

const DIST = resolve('dist');

// 足したノードの仮の名前
const NEW = '新しいノード';

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

// markdag.editor を書いた文書。editor の行は markdag.editor の下の字下げ (8 桁) から、markdag の行は markdag の下の字下げ (4 桁) からの相対で書く
function docWith(editor: string[], body: string[], markdag: string[] = []): string {
    return ['---', 'markdag:', '    edgeHighlight: true', ...markdag.map((line) => `    ${line}`), '    editor:', ...editor.map((line) => `        ${line}`), '---', '', ...body].join('\n');
}

// Design の下の項目だけを替えた本文。ノードは Root 1、Design 2、項目 (3 から文書の順)、Build、Leaf
function designBody(items: string[]): string[] {
    return ['# Root', '', '## Design', '', ...items, '', '## Build', '', '- Leaf', ''];
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = designBody(['- Task A', '- Task B']);
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;

// Task A に子を足した本文。足した子は 4 (Task B は 5、Build は 6、Leaf は 7)。リストの子は入れ子の項目で、字下げは 4
const BODY_A_CHILD = designBody(['- Task A', `    - ${NEW}`, '- Task B']);
// その子の名前を Sub に決めた本文
const BODY_A_SUB = designBody(['- Task A', '    - Sub', '- Task B']);
// Task A に兄弟を足した本文。足した兄弟は 4 (自分と同じ形で、自分のすぐあと)
const BODY_A_SIBLING = designBody(['- Task A', `- ${NEW}`, '- Task B']);
// Design に子を足した本文。足した子は 5 (最後の子の形にそろえて、親のブロックの最後の空でない行のあと)
const BODY_DESIGN_CHILD = designBody(['- Task A', '- Task B', `- ${NEW}`]);
// Root に子を足した本文。足した子は 7 (最後の子の見出しの形。前の行が空でないので空行をはさむ)
const BODY_ROOT_CHILD = [...BODY.slice(0, -1), '', `## ${NEW}`, ''];
// Root の名前を Top に決めた本文と、そのあとに子を足した本文 (ルートの兄弟は子)
const BODY_TOP = ['# Top', ...BODY.slice(1)];
const BODY_TOP_CHILD = ['# Top', ...BODY_ROOT_CHILD.slice(1)];
// Task B の名前を Renamed に決めた本文
const BODY_B_RENAMED = designBody(['- Task A', '- Renamed']);

const DOC = docWith(EDIT, BODY);
const DOC_SWITCH = docWith(SWITCH_EDIT, BODY);
const DOC_VIEW = docWith(['mode: view'], BODY);

// タスクのノード (名前を空にすると empty-name で断られる)。Root 1、Todo 2、Plain 3
const TASKS_BODY = ['# Root', '', '- [ ] Todo', '- Plain', ''];
const TODO = 2;

// initialExpandLevel 2 で a (2) の枝が閉じて始まる文書。R 1、a 2、a1 3、b 4
const FOLD_BODY = ['# R', '', '- a', '    - a1', '- b', ''];
const FOLD = ['initialExpandLevel: 2'];
const A1 = 3;

// transformSource が「- a」の前に「- 自動」を足す文書。原文は R 1、a 2、b 3。図は R 1、自動 2、a 3、b 4
const TRANSFORM_BODY = ['# R', '', '- a', '- b', ''];

// 名前を変えられないノード。行を持たないルート (title だけ)、リストだけの文書のルートの容器、表
const DOC_LINELESS = ['---', 'title: T', 'markdag:', '    editor:', '        mode: edit', '---', '- a', '', '1. b', ''].join('\n');
const DOC_LIST_ROOT = ['---', 'title: 手順', 'markdag:', '    editor:', '        mode: edit', '---', '- 設計', '- 実装', ''].join('\n');
const DOC_TABLE = docWith(EDIT, ['# R', '', '## T', '', '| x | y |', '| - | - |', '| 1 | 2 |', '', '## U', '', '- u', '']);

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
        target.blockUpdates = false;
    });
}

interface MountSpec {
    root?: 'a' | 'b';
    // gate: window.blockUpdates のあいだ beforeUpdate が取りやめる。transform: transformSource が「- a」の前に「- 自動」を足す
    hooks?: 'gate' | 'transform';
}

async function mount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    const root = spec.root ?? 'a';
    await page.evaluate(
        ({ markdown, root, hooks }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error(`#${root} がない`);
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.changes.push({ root, markdown: next });
                },
                onSelectionChange: (selection) => {
                    target.selections.push({ root, selection: JSON.parse(JSON.stringify(selection)) as EditSelection });
                },
            };
            if (hooks === 'gate') options.hooks = { beforeUpdate: () => (target.blockUpdates ? false : undefined) };
            if (hooks === 'transform') options.hooks = { transformSource: (context) => context.source.replace('\n- a\n', '\n- 自動\n- a\n') };
            target.editors[root] = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, root, hooks: spec.hooks ?? null },
    );
    await expect(page.locator(`#${root} .mdag-node`).first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知を初めの状態に戻す)。onChange と onSelectionChange の記録も空にする
async function remount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    const root = spec.root ?? 'a';
    await page.evaluate((root) => {
        const target = window as unknown as EditorWindow;
        target.editors[root]?.destroy();
        target.changes = target.changes.filter((entry) => entry.root !== root);
        target.selections = target.selections.filter((entry) => entry.root !== root);
    }, root);
    await mount(page, markdown, spec);
}

// 「変わらない」「呼ばれない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page, root = 'a'): Promise<string[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).changes.flatMap((entry) => (entry.root === root ? [entry.markdown] : [])), root);

const selectionLog = (page: Page, root = 'a'): Promise<EditSelection[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).selections.flatMap((entry) => (entry.root === root ? [entry.selection] : [])), root);

const getSource = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSource(), root);

const setSource = (page: Page, markdown: string, root = 'a'): Promise<void> =>
    page.evaluate(({ markdown, root }) => void (window as unknown as EditorWindow).editors[root]?.setSource(markdown), { markdown, root });

const getMode = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getMode(), root);

const setMode = (page: Page, mode: 'view' | 'edit', root = 'a'): Promise<boolean> =>
    page.evaluate(({ mode, root }) => (window as unknown as EditorWindow).editors[root]?.setMode(mode) ?? false, { mode, root });

const callHistory = (page: Page, method: 'undo' | 'redo', root = 'a'): Promise<boolean | undefined> =>
    page.evaluate(({ method, root }) => (window as unknown as EditorWindow).editors[root]?.[method](), { method, root });

const setBlockUpdates = (page: Page, block: boolean): Promise<void> => page.evaluate((block) => void ((window as unknown as EditorWindow).blockUpdates = block), block);

async function transformOf(page: Page, root = 'a'): Promise<ViewTransform> {
    const transform = await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getTransform() ?? null, root);
    if (!transform) throw new Error(`#${root} の図がない`);
    return transform;
}

const sameTransform = (a: ViewTransform, b: ViewTransform): boolean => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

const getFolded = (page: Page, root = 'a'): Promise<number[]> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getFolded() ?? [], root);

const toolButton = (page: Page, tool: string, root = 'a') => page.locator(`#${root} .mdag-editor-tool[data-tool="${tool}"]`);
const segmentButton = (page: Page, mode: 'view' | 'edit', root = 'a') => page.locator(`#${root} .mdag-editor-segment [data-mode="${mode}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-snackbar`);
const nodeSelector = (id: number, root = 'a'): string => `#${root} .mdag-node[data-id="${id}"]`;
const nodeCount = (page: Page, root = 'a'): Promise<number> => page.locator(`#${root} .mdag-node`).count();
const labelOf = (page: Page, id: number, root = 'a') => page.locator(`${nodeSelector(id, root)} .mdag-content`);

async function useSelectTool(page: Page, root = 'a'): Promise<void> {
    await toolButton(page, 'select', root).click();
    await expect(page.locator(`#${root}`)).toHaveAttribute('data-editor-tool', 'select');
}

// フォーカスを図の要素に置く (道具箱の手のひらを押すと、フォーカスは図の要素に戻る。道具は手のひらになる)
async function focusDiagram(page: Page, root = 'a'): Promise<void> {
    await toolButton(page, 'hand', root).click();
    await expect.poll(() => page.evaluate((root) => document.activeElement === document.getElementById(root), root)).toBe(true);
}

// テストのページの原文の欄 (アプリの入力欄の代わり)。図の右の空いた所に置き、図とは重ねない
async function addSourceField(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('source')) return;
        const field = document.createElement('textarea');
        field.id = 'source';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
}

// 名前の入力の外 (図の外の原文の欄) へフォーカスを移す
async function focusOutside(page: Page): Promise<void> {
    await addSourceField(page);
    await page.locator('#source').click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('source');
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

// ノードの箱が図の領域に収まっているか
async function insideArea(page: Page, id: number, root = 'a'): Promise<boolean> {
    const [area] = await rectsOf(page, `#${root}`);
    const [box] = await rectsOf(page, `${nodeSelector(id, root)} .mdag-box`);
    if (!area || !box) return false;
    return box.right > box.left && area.left <= box.left + 1 && area.top <= box.top + 1 && area.right >= box.right - 1 && area.bottom >= box.bottom - 1;
}

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
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
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

// ノードの箱を押す
async function pressNode(page: Page, id: number, root = 'a'): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id, root)} .mdag-box` }));
}

// ノードの文字の上を押す (タスクのノードは先頭の絵を押すと状態が進むので、文字の上を押して選ぶ)
async function pressLabel(page: Page, id: number, root = 'a'): Promise<void> {
    await press(page, await spot(page, { on: 'text', selector: `${nodeSelector(id, root)} .mdag-content` }));
}

// ノードのラベル (名前の文字) をダブルクリックする
async function doubleClickLabel(page: Page, id: number, root = 'a'): Promise<void> {
    const point = await spot(page, { on: 'text', selector: `${nodeSelector(id, root)} .mdag-content` });
    await page.mouse.move(point.x, point.y);
    await page.mouse.dblclick(point.x, point.y);
}

async function pointerOverBlank(page: Page, root = 'a'): Promise<void> {
    const blank = await spot(page, { on: 'blank', root });
    await page.mouse.move(blank.x, blank.y);
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string, root = 'a'): Promise<void> {
    const selector = `#${root} .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

async function dragFrom(page: Page, from: Point, to: Point): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x - from.x) * 0.3, from.y + (to.y - from.y) * 0.3, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
}

const target = (id: number, refText: string): NodeTarget => ({ id, refText });

const sortedTargets = (targets: readonly NodeTarget[]): NodeTarget[] => [...targets].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }));

interface SelectionState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // getSelection のノード (id の昇順)。何も選んでいなければ空、ノードでなければ kind
    selected: NodeTarget[] | string;
}

async function selectionOf(page: Page, root = 'a'): Promise<SelectionState> {
    const state = await page.evaluate((root) => {
        const container = document.getElementById(root);
        const editor = (window as unknown as EditorWindow).editors[root];
        if (!container || !editor) throw new Error(`#${root} の図がない`);
        const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        return { marked, selection: editor.getSelection() };
    }, root);
    const { selection } = state;
    const selected = selection.kind === 'nodes' ? sortedTargets(selection.nodes) : selection.kind === 'none' ? [] : selection.kind;
    return { marked: state.marked, selected };
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方。getSelection は id と refText)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string, root = 'a'): Promise<void> {
    const sorted = sortedTargets(targets);
    await expect.poll(() => selectionOf(page, root), message).toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
}

// onSelectionChange に最後に届いた選択 (ノードは id の昇順)
async function lastSelectionChange(page: Page, root = 'a'): Promise<NodeTarget[] | string | null> {
    const last = (await selectionLog(page, root)).at(-1);
    if (last === undefined) return null;
    return last.kind === 'nodes' ? sortedTargets(last.nodes) : last.kind === 'none' ? [] : last.kind;
}

interface NameInputState {
    // 見えている名前の入力 (.mdag-editor-name-input[data-for="node"]) の数
    count: number;
    // 入力の値 (1 つのときだけ)
    value: string | null;
    // 入力の中で選んでいる文字
    selected: string | null;
    // フォーカスが入力の中にある
    focused: boolean;
    // 名前の入力の要素の矩形
    rect: Box | null;
}

// 名前の入力。要素そのものが入力欄 (input、textarea、contenteditable) でも、その中に入力欄があってもよい
async function nameInputOf(page: Page, root = 'a'): Promise<NameInputState> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        if (!container) throw new Error(`#${root} がない`);
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...container.querySelectorAll('.mdag-editor-name-input[data-for="node"]')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, selected: null, focused: false, rect: null };
        const outer = element.getBoundingClientRect();
        const rect = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, selected: null, focused: false, rect };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
            const value = field.value;
            const selected = field.selectionStart === null || field.selectionEnd === null ? '' : value.slice(field.selectionStart, field.selectionEnd);
            return { count: 1, value, selected, focused, rect };
        }
        const selection = window.getSelection();
        const selected = selection?.anchorNode && field.contains(selection.anchorNode) ? selection.toString() : '';
        return { count: 1, value: field.textContent ?? '', selected, focused, rect };
    }, root);
}

interface NameInputExpectation {
    value: string;
    // 値の全部を選んだ状態 (足したノードの仮の名前)
    allSelected?: boolean;
}

// 名前の入力がノードのラベルの上に 1 つ開き、フォーカスがあって、値が expected になるまで待つ。
// 「ラベルの上」は、入力の矩形がノードの文字 (.mdag-content) の矩形と左右で重なり、入力の上下の中ほどがノードの箱の中にあること
async function expectNameInputOn(page: Page, id: number, expected: NameInputExpectation, message?: string, root = 'a'): Promise<void> {
    await expect
        .poll(async () => {
            const state = await nameInputOf(page, root);
            const [box] = await rectsOf(page, `${nodeSelector(id, root)} .mdag-box`);
            const [label] = await rectsOf(page, `${nodeSelector(id, root)} .mdag-content`);
            const rect = state.rect;
            const middle = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const onLabel = rect !== null && box !== undefined && label !== undefined && rect.left < label.right && rect.right > label.left && middle >= box.top - 2 && middle <= box.bottom + 2;
            return { count: state.count, value: state.value, focused: state.focused, onLabel, ...(expected.allSelected ? { selected: state.selected } : {}) };
        }, message)
        .toEqual({ count: 1, value: expected.value, focused: true, onLabel: true, ...(expected.allSelected ? { selected: expected.value } : {}) });
}

// 名前の入力が開いていない (数コマ待ってから)
async function expectNoNameInput(page: Page, message?: string, root = 'a'): Promise<void> {
    await settle(page);
    expect((await nameInputOf(page, root)).count, message).toBe(0);
}

// 名前の入力が閉じるまで待つ
async function expectNameInputClosed(page: Page, message?: string, root = 'a'): Promise<void> {
    await expect.poll(async () => (await nameInputOf(page, root)).count, message).toBe(0);
}

// 名前の入力の値を全部選んで text を打つ (足したばかりでない入力の初めの選び方は決めていないので、全部を選んでから打つ)
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
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

// 見えている通知が 1 つあり、文字がある。kind を渡せば data-kind も見る
async function expectNotice(page: Page, kind?: 'info' | 'error', message?: string): Promise<string> {
    const shown = kind ? visible(page, `#a .mdag-editor-snackbar[data-kind="${kind}"]`) : snackbars(page);
    await expect(shown, message).toHaveCount(1);
    const text = ((await shown.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(text, message).not.toBe('');
    return text;
}

// 通知が消えるまで待つ (失敗の通知は長めに出るので、15 秒まで待つ)
async function expectNoticeGone(page: Page, message?: string): Promise<void> {
    await expect(snackbars(page), message).toHaveCount(0, { timeout: 15_000 });
}

// 変換中のキー。Chromium の IME と同じく keyCode 229 で送る (Input.imeSetComposition で変換を始めていれば isComposing も true)
async function pressComposing(client: CDPSession, key: 'Enter' | 'Escape' | 'Tab'): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

test.describe('原文の持ち主と通知 (B-001〜B-003、B-025、B-026、B-004)', () => {
    test('@editor Tab で子を足すと、原文が書き換わって図が描き直され、onChange が 1 回呼ばれる。足したノードが選ばれ、名前の入力が「新しいノード」を全部選んだ状態でそのラベルの上に開く。結果の通知 (info) が出て消える', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expect(snackbars(page)).toHaveCount(0);

        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        await expectSource(page, added, [added]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(labelOf(page, 4)).toHaveText(NEW);
        // 選び直しは書き換えたあとの id と refText (前の id 4 の Task B は 5 になる)
        await expectSelection(page, [target(4, NEW)]);
        await expect.poll(() => lastSelectionChange(page)).toEqual([target(4, NEW)]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });

        await expectNotice(page, 'info');
        await expectNoticeGone(page);
        // 通知が消えても名前の入力は開いたまま
        expect((await nameInputOf(page)).count).toBe(1);
        expect(await changeLog(page)).toEqual([added]);
        expect(errors).toEqual([]);
    });

    test('@editor 足したノードの名前を決めると 1 行目が書き換わり、onChange が呼ばれて選択の refText も新しい名前になる。⌘Z / Ctrl+Z で 1 つずつ戻り、⌘⇧Z / Ctrl+Shift+Z でやり直す', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        const named = docWith(EDIT, BODY_A_SUB);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });

        await page.keyboard.type('Sub');
        await focusOutside(page);
        await expectSource(page, named, [added, named]);
        await expectNameInputClosed(page);
        await expect(labelOf(page, 4)).toHaveText('Sub');
        await expectSelection(page, [target(4, 'Sub')]);
        await expect.poll(() => lastSelectionChange(page)).toEqual([target(4, 'Sub')]);
        await expectNotice(page, 'info');

        await focusDiagram(page);
        const steps: Array<{ key: string; source: string; nodes: number }> = [
            { key: 'ControlOrMeta+KeyZ', source: added, nodes: 7 },
            { key: 'ControlOrMeta+KeyZ', source: DOC, nodes: 6 },
            { key: 'ControlOrMeta+Shift+KeyZ', source: added, nodes: 7 },
            { key: 'ControlOrMeta+Shift+KeyZ', source: named, nodes: 7 },
        ];
        const expectedChanges = [added, named];
        for (const step of steps) {
            await page.keyboard.press(step.key);
            expectedChanges.push(step.source);
            await expectSource(page, step.source, expectedChanges, step.key);
            await expect(page.locator('#a .mdag-node'), step.key).toHaveCount(step.nodes);
        }
        await expect(toolButton(page, 'redo')).toBeDisabled();
        expect(errors).toEqual([]);
    });

    test('@editor beforeUpdate のフックが取りやめた書き換えは、原文も履歴も変えず、通知を出す (子を足すときと名前を決めるとき) (B-001)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC, { hooks: 'gate' });
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);

        // 子を足すのを取りやめる
        await setBlockUpdates(page, true);
        await page.keyboard.press('Tab');
        await expectSourceStill(page, DOC, []);
        expect(await nodeCount(page)).toBe(6);
        await expectNotice(page);
        await expectNoNameInput(page);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectNoticeGone(page);

        // 足すのは通し、名前を決めるのを取りやめる
        await setBlockUpdates(page, false);
        await focusDiagram(page);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        await expectSource(page, added, [added]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
        await expectNoticeGone(page);
        await setBlockUpdates(page, true);
        await page.keyboard.type('Sub');
        await focusOutside(page);
        await expectSourceStill(page, added, [added]);
        await expectNotice(page);

        // 取りやめた名前は履歴に入っていない: 1 回の元に戻すで足す前に戻り、そのあとは戻すものがない
        await setBlockUpdates(page, false);
        expect(await callHistory(page, 'undo')).toBe(true);
        await expectSource(page, DOC, [added, DOC]);
        expect(await callHistory(page, 'undo')).toBe(false);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor 断られた書き換え (タスクのノードの名前を空にする empty-name) は原文を変えず、理由の通知 (error) を出し、通知は消える。履歴に積まない (B-002、B-003)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const doc = docWith(EDIT, TASKS_BODY);
        await mount(page, doc);
        await pressLabel(page, TODO);
        await expectSelection(page, [target(TODO, 'Todo')]);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TODO, { value: 'Todo' });
        await replaceName(page, '');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('');

        await focusOutside(page);
        await expectSourceStill(page, doc, []);
        const reason = await page.evaluate((source) => {
            const outcome = (window as unknown as EditorWindow).editorHarness.core.editSource(source, { kind: 'renameNode', node: { id: 2, refText: 'Todo' }, label: '' });
            return outcome.status === 'refused' ? outcome.reason.message : null;
        }, doc);
        expect(reason).not.toBeNull();
        const text = await expectNotice(page, 'error');
        expect(text).toContain(reason ?? '');
        await expect(labelOf(page, TODO)).toHaveText('Todo');
        await expect(toolButton(page, 'undo')).toBeDisabled();
        await expectNoticeGone(page);
        expect(await getSource(page)).toBe(doc);
    });
});

test.describe('名前の入力を開く (B-013、B-027、B-048、10.1 の 1)', () => {
    test('@editor 帯の「名前」で、選んだノードの名前の入力がラベルの上に開く。値は 1 行目の本文 (見出しの # を除く)。Esc で変えずに閉じる (B-013)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const [id, label] of [
            [TASK_B, 'Task B'],
            [DESIGN, 'Design'],
        ] as const) {
            await pressNode(page, id);
            await expectSelection(page, [target(id, label)], label);
            await pressBar(page, 'rename');
            await expectNameInputOn(page, id, { value: label }, label);
            await page.keyboard.press('Escape');
            await expectNameInputClosed(page, label);
        }
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 選んだノードで Enter を押すと、名前の入力がラベルの上に開く (ルートも) (B-027)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const [id, label] of [
            [TASK_B, 'Task B'],
            [ROOT, 'Root'],
        ] as const) {
            await pressNode(page, id);
            await expectSelection(page, [target(id, label)], label);
            await page.keyboard.press('Enter');
            await expectNameInputOn(page, id, { value: label }, label);
            await page.keyboard.press('Escape');
            await expectNameInputClosed(page, label);
        }
        await expectSourceStill(page, DOC, []);
    });

    test('@editor ラベルのダブルクリックで、そのノードが選ばれて名前の入力がラベルの上に開く (手のひらでも選択の道具でも) (B-048、10.2 の B-076)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const tool of ['hand', 'select']) {
            await toolButton(page, tool).click();
            await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', tool);
            await doubleClickLabel(page, TASK_B);
            await expectNameInputOn(page, TASK_B, { value: 'Task B' }, tool);
            await expectSelection(page, [target(TASK_B, 'Task B')], tool);
            await page.keyboard.press('Escape');
            await expectNameInputClosed(page, tool);
        }
        await expectSourceStill(page, DOC, []);
    });

    test('@editor F2 と、名前の入力の外の Shift+Tab では入力が開かず、原文も変わらない。何もないところのダブルクリックは何もしない (ノードを足さず、表示位置も変えない) (10.1 の 1、10.2 の B-030、request.md 3.1)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('F2');
        await expectNoNameInput(page, 'F2');
        await page.keyboard.press('Shift+Tab');
        await expectNoNameInput(page, 'Shift+Tab');
        await expectSourceStill(page, DOC, []);
        expect(await nodeCount(page)).toBe(6);

        const before = await transformOf(page);
        const blank = await spot(page, { on: 'blank', root: 'a' });
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.dblclick(blank.x, blank.y);
        await expectNoNameInput(page, '何もないところのダブルクリック');
        await expectSourceStill(page, DOC, []);
        expect(await nodeCount(page)).toBe(6);
        expect(sameTransform(await transformOf(page), before)).toBe(true);

        // 空振りの防ぎ: 同じ図でキーは受けている (Enter では開く)
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
    });
});

test.describe('子と兄弟を足す (B-014、B-015、B-025、B-026、3.5)', () => {
    test('@editor 帯の「兄弟」で、自分のすぐあとに同じ形の兄弟を足し、足したノードを選んで「新しいノード」を全部選んだ名前の入力を開く (B-015)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await pressBar(page, 'sibling');
        const added = docWith(EDIT, BODY_A_SIBLING);
        await expectSource(page, added, [added]);
        await expectSelection(page, [target(4, NEW)]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
    });

    test('@editor 帯の「子」で、最後の子の形にそろえた子を足し、足したノードを選んで「新しいノード」を全部選んだ名前の入力を開く (B-014)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, DESIGN);
        await pressBar(page, 'child');
        const added = docWith(EDIT, BODY_DESIGN_CHILD);
        await expectSource(page, added, [added]);
        await expectSelection(page, [target(5, NEW)]);
        await expectNameInputOn(page, 5, { value: NEW, allSelected: true });
    });

    test('@editor ルートで Tab を押すと子 (最後の子の見出しの形) を足す。ルートの名前の入力の Enter は名前を決めて子を足し、その名前の入力へ移る (B-026、B-029)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, ROOT);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_ROOT_CHILD);
        await expectSource(page, added, [added]);
        await expectSelection(page, [target(7, NEW)]);
        await expectNameInputOn(page, 7, { value: NEW, allSelected: true });

        await remount(page, DOC);
        await pressNode(page, ROOT);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, ROOT, { value: 'Root' });
        await replaceName(page, 'Top');
        await page.keyboard.press('Enter');
        const top = docWith(EDIT, BODY_TOP);
        const topChild = docWith(EDIT, BODY_TOP_CHILD);
        await expectSource(page, topChild, [top, topChild]);
        await expectSelection(page, [target(7, NEW)]);
        await expectNameInputOn(page, 7, { value: NEW, allSelected: true });
    });
});

test.describe('名前の入力の中のキー (B-029〜B-031、10.2 の B-030)', () => {
    test('@editor 入力中の Enter は名前を決めて兄弟を足し、Tab は子を、Shift+Tab は兄弟を足して、その名前の入力へ移る。名前を変えずに Enter でも兄弟を足す。最後に Esc で足す前に戻る', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        // C1: Task B を Task B2 に決める。C2: Task B2 の兄弟 (5)。C3: Sub に決める。C4: Sub の子 (6)。C5: Deep に決める。
        // C6: Deep の兄弟 (7)。C7: 名前を変えずに 7 の兄弟 (8)
        const chain = [
            designBody(['- Task A', '- Task B2']),
            designBody(['- Task A', '- Task B2', `- ${NEW}`]),
            designBody(['- Task A', '- Task B2', '- Sub']),
            designBody(['- Task A', '- Task B2', '- Sub', `    - ${NEW}`]),
            designBody(['- Task A', '- Task B2', '- Sub', '    - Deep']),
            designBody(['- Task A', '- Task B2', '- Sub', '    - Deep', `    - ${NEW}`]),
            designBody(['- Task A', '- Task B2', '- Sub', '    - Deep', `    - ${NEW}`, `    - ${NEW}`]),
        ].map((body) => docWith(EDIT, body));
        const [c1, c2, c3, c4, c5, c6, c7] = chain;
        if (!c1 || !c2 || !c3 || !c4 || !c5 || !c6 || !c7) throw new Error('本文が足りない');

        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Task B2');
        await page.keyboard.press('Enter');
        await expectSource(page, c2, [c1, c2], 'Enter');
        await expectSelection(page, [target(5, NEW)], 'Enter');
        await expectNameInputOn(page, 5, { value: NEW, allSelected: true }, 'Enter');

        await page.keyboard.type('Sub');
        await page.keyboard.press('Tab');
        await expectSource(page, c4, [c1, c2, c3, c4], 'Tab');
        await expectSelection(page, [target(6, NEW)], 'Tab');
        await expectNameInputOn(page, 6, { value: NEW, allSelected: true }, 'Tab');

        await page.keyboard.type('Deep');
        await page.keyboard.press('Shift+Tab');
        await expectSource(page, c6, [c1, c2, c3, c4, c5, c6], 'Shift+Tab');
        await expectSelection(page, [target(7, NEW)], 'Shift+Tab');
        await expectNameInputOn(page, 7, { value: NEW, allSelected: true }, 'Shift+Tab');

        // 名前を変えずに決めても兄弟を足す (名前は同じなので書き換えない)
        await page.keyboard.press('Enter');
        await expectSource(page, c7, [c1, c2, c3, c4, c5, c6, c7], '名前を変えずに Enter');
        await expectSelection(page, [target(8, NEW)], '名前を変えずに Enter');
        await expectNameInputOn(page, 8, { value: NEW, allSelected: true }, '名前を変えずに Enter');

        // 足したばかりのノードの Esc は、その兄弟を足す前に戻す
        await page.keyboard.press('Escape');
        await expectSource(page, c6, [c1, c2, c3, c4, c5, c6, c7, c6], 'Esc');
        await expectNameInputClosed(page, 'Esc');
        expect(errors).toEqual([]);
    });
});

test.describe('変換中のキー (B-15、5.2 の軸 D)', () => {
    test('@editor 変換中 (isComposing か keyCode 229) の Enter、Esc、Tab は名前の入力の操作にならない: 決めず、足す前に戻さず、子を足さない。変換を確定したあとの Enter で決める', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '変換は Chromium の CDP (Input.imeSetComposition) で起こす');
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        await expectSource(page, added, [added]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });

        const client = await page.context().newCDPSession(page);
        try {
            // 全部を選んだ仮の名前を、変換中の文字で置き換える (compositionstart が届く)
            await client.send('Input.imeSetComposition', { text: 'せっけい', selectionStart: 4, selectionEnd: 4 });
            await expect.poll(async () => (await nameInputOf(page)).value).toBe('せっけい');
            // IME が送る形 (keyCode 229、isComposing true) と、keyCode のある形 (isComposing true) の両方
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await pressComposing(client, 'Tab');
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            await expectSourceStill(page, added, [added], '変換中');
            expect(await nodeCount(page)).toBe(7);
            await expectNameInputOn(page, 4, { value: 'せっけい' }, '変換中');

            // 変換を確定する (compositionend が届く)
            await client.send('Input.insertText', { text: '設計' });
            await expect.poll(async () => (await nameInputOf(page)).value).toBe('設計');
            // 変換を確定したキーが確定のあとに keyCode 229 で届く形 (isComposing false) も無視する
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, added, [added], '確定のあとの keyCode 229');
            await expectNameInputOn(page, 4, { value: '設計' }, '確定のあとの keyCode 229');
        } finally {
            await client.detach();
        }

        await page.keyboard.press('Enter');
        const named = docWith(EDIT, designBody(['- Task A', '    - 設計', '- Task B']));
        const sibling = docWith(EDIT, designBody(['- Task A', '    - 設計', `    - ${NEW}`, '- Task B']));
        await expectSource(page, sibling, [added, named, sibling]);
        await expectNameInputOn(page, 5, { value: NEW, allSelected: true });
    });
});

test.describe('閉じた枝の中に足す (B-14、5.3、10.1 の 6)', () => {
    test('@editor initialExpandLevel で閉じる枝の中のノードを選んで Tab を押すと、足したノードが見えて名前の入力が開く。入力中の Enter で足した兄弟も見えて入力が開く', async ({ page }) => {
        await open(page);
        const doc = docWith(EDIT, FOLD_BODY, FOLD);
        await mount(page, doc);
        await expect.poll(() => getFolded(page)).toContain(2);
        // a の枝を開いて a1 を選ぶ
        await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.setFolded([]));
        await expect(page.locator(`${nodeSelector(A1)} .mdag-box`)).toBeVisible();
        await pressNode(page, A1);
        await expectSelection(page, [target(A1, 'a1')]);

        await page.keyboard.press('Tab');
        const added = docWith(EDIT, ['# R', '', '- a', '    - a1', `        - ${NEW}`, '- b', ''], FOLD);
        await expectSource(page, added, [added]);
        await expectSelection(page, [target(4, NEW)]);
        await expect.poll(() => insideArea(page, 4)).toBe(true);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });

        await page.keyboard.type('x');
        await page.keyboard.press('Enter');
        const named = docWith(EDIT, ['# R', '', '- a', '    - a1', '        - x', '- b', ''], FOLD);
        const sibling = docWith(EDIT, ['# R', '', '- a', '    - a1', '        - x', `        - ${NEW}`, '- b', ''], FOLD);
        await expectSource(page, sibling, [added, named, sibling]);
        await expectSelection(page, [target(5, NEW)]);
        await expect.poll(() => insideArea(page, 5)).toBe(true);
        await expectNameInputOn(page, 5, { value: NEW, allSelected: true });
    });
});

test.describe('Esc でやめる (B-031、B-032、10.2 の B-031)', () => {
    test('@editor 足したばかりのノードの入力を Esc でやめると、足す前の原文に戻って足したノードの選択が残らず、onChange が呼ばれる。やり直すで足したノードが戻る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_A);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        await expectSource(page, added, [added]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });

        await page.keyboard.press('Escape');
        await expectSource(page, DOC, [added, DOC]);
        await expectNameInputClosed(page);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        // 足したノードはなくなり、その選択は残らない (足す前に選んでいたノードに戻るか、選択なしかは決めていない)
        await expect
            .poll(async () => {
                const state = await selectionOf(page);
                const ids = typeof state.selected === 'string' ? [-1] : state.selected.map((item) => item.id);
                return [...state.marked, ...ids].every((id) => id === TASK_A);
            })
            .toBe(true);
        await expect(toolButton(page, 'redo')).toBeEnabled();

        await focusDiagram(page);
        await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
        await expectSource(page, added, [added, DOC, added]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(labelOf(page, 4)).toHaveText(NEW);
    });

    test('@editor 足したばかりでないノードの入力 (既存のノード、あとで開き直した足したノード) は、Esc で名前を変えずに閉じる (B-032)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Changed');
        await page.keyboard.press('Escape');
        await expectNameInputClosed(page);
        await expectSourceStill(page, DOC, []);
        await expect(labelOf(page, TASK_B)).toHaveText('Task B');

        // 足して名前を決めたノードの入力を、ダブルクリックで開き直して Esc (Task B の帯が Task A に重なるので描き直してから)
        await remount(page, DOC);
        await pressNode(page, TASK_A);
        await page.keyboard.press('Tab');
        const added = docWith(EDIT, BODY_A_CHILD);
        const named = docWith(EDIT, BODY_A_SUB);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
        await page.keyboard.type('Sub');
        await focusOutside(page);
        await expectSource(page, named, [added, named]);
        await expectNameInputClosed(page);

        await doubleClickLabel(page, 4);
        await expectNameInputOn(page, 4, { value: 'Sub' });
        await replaceName(page, 'Other');
        await page.keyboard.press('Escape');
        await expectNameInputClosed(page);
        await expectSourceStill(page, named, [added, named]);
        await expect(labelOf(page, 4)).toHaveText('Sub');
    });
});

test.describe('フォーカスが外へ移ったとき (B-033、5.2 の軸 D)', () => {
    test('@editor 名前の入力の外へフォーカスが移ると、入れた名前で決めて閉じ、名前を変えたノードが選ばれる', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Renamed');
        await focusOutside(page);
        const renamed = docWith(EDIT, BODY_B_RENAMED);
        await expectSource(page, renamed, [renamed]);
        await expectNameInputClosed(page);
        await expect(labelOf(page, TASK_B)).toHaveText('Renamed');
        await expectSelection(page, [target(TASK_B, 'Renamed')]);
    });

    test('@editor 名前の入力中に別のノードを押すと、入れた名前で決めて閉じる', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Renamed');
        await pressNode(page, LEAF);
        const renamed = docWith(EDIT, BODY_B_RENAMED);
        await expectSource(page, renamed, [renamed]);
        await expectNameInputClosed(page);
        await expect(labelOf(page, TASK_B)).toHaveText('Renamed');
    });
});

test.describe('名前を変えられないノード (B-036、3.2、3.8)', () => {
    test('@editor 行を持たないルート、リストだけの文書のルート (容器)、表では、Enter でもラベルのダブルクリックでも名前の入力が開かず、理由の通知が出る。原文は変わらない', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const cases = [
            { name: '行を持たないルート', doc: DOC_LINELESS, id: 1, kind: 'root' },
            { name: 'リストだけの文書のルート', doc: DOC_LIST_ROOT, id: 1, kind: 'list' },
            { name: '表', doc: DOC_TABLE, id: 3, kind: 'block' },
        ];
        let first = true;
        for (const item of cases) {
            for (const action of ['Enter', 'ダブルクリック']) {
                const message = `${item.name} (${action})`;
                if (first) await mount(page, item.doc);
                else await remount(page, item.doc);
                first = false;
                const facts = await page.evaluate((id) => {
                    const target = window as unknown as EditorWindow;
                    const editor = target.editors.a;
                    const node = editor?.view.getDocument()?.parsed.nodes.find((entry) => entry.id === id);
                    if (!editor || !node) throw new Error(`ノード ${id} がない`);
                    return target.editorHarness.core.inspectNode(editor.getSource(), { id: node.id, refText: node.refText });
                }, item.id);
                // 空振りの防ぎ: ねらった種類のノードで、名前を変えられない
                expect({ kind: facts?.kind, canRename: facts?.canRename }, message).toEqual({ kind: item.kind, canRename: false });

                await expect(snackbars(page), message).toHaveCount(0);
                if (action === 'Enter') {
                    await pressNode(page, item.id);
                    await expect.poll(async () => (await selectionOf(page)).marked, message).toEqual([item.id]);
                    await page.keyboard.press('Enter');
                } else {
                    await doubleClickLabel(page, item.id);
                }
                await expectNoNameInput(page, message);
                await expectNotice(page, undefined, message);
                await expectSourceStill(page, item.doc, [], message);
            }
        }
    });
});

test.describe('入力欄の中のキー (B-037、1.2)', () => {
    test('@editor 名前の入力にいるときは、矢印キー、Space、Backspace、⌘Z / Ctrl+Z が図に効かず、入力の中の操作になる', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 図の履歴に戻すものを 1 つ積む
        const more = docWith(EDIT, [...BODY.slice(0, -1), '- Leaf 2', '']);
        await setSource(page, more);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await useSelectTool(page);
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'abc');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('abc');

        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
            await page.keyboard.press(key);
            await settle(page);
            expect((await selectionOf(page)).selected, key).toEqual([target(TASK_B, 'Task B')]);
            expect((await nameInputOf(page)).focused, key).toBe(true);
        }

        // Space は入力に空白を打ち、図を動かす状態 (選択の道具 + Space) にしない
        await page.keyboard.down('Space');
        await settle(page);
        expect(await page.locator('#a').getAttribute('data-drag-to-pan')).toBe('middle');
        await page.keyboard.up('Space');
        await expect.poll(async () => (await nameInputOf(page)).value).toMatch(/^(?=.* )[abc ]{4}$/);

        // Backspace は入力の文字を消し、ノードを消さない
        await page.keyboard.press('Backspace');
        await expect.poll(async () => (await nameInputOf(page)).value?.length).toBe(3);
        await page.keyboard.press('Delete');
        await settle(page);
        expect(await nodeCount(page)).toBe(7);

        // ⌘Z は図の元に戻すにならない
        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expectSourceStill(page, more, []);
        expect(await nodeCount(page)).toBe(7);
        expect((await nameInputOf(page)).count).toBe(1);

        await page.keyboard.press('Escape');
        await expectNameInputClosed(page);
        await expectSourceStill(page, more, []);
        await expect(labelOf(page, TASK_B)).toHaveText('Task B');
    });
});

test.describe('transformSource で図と原文が合わない文書 (A-18、B-18、10.1 の 4)', () => {
    test('@editor 図と原文で id のずれたノードでは、Enter で名前の入力が開かずに理由が出る。Tab は断られて原文が変わらず、理由の通知 (error) が出る', async ({ page }) => {
        await open(page);
        const doc = docWith(EDIT, TRANSFORM_BODY);
        await mount(page, doc, { hooks: 'transform' });
        // 図は R 1、自動 2、a 3、b 4 (原文の id 3 は b)
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getDocument()?.parsed.nodes.map((node) => node.refText))).toEqual(['R', '自動', 'a', 'b']);

        await pressNode(page, 3);
        await expectSelection(page, [target(3, 'a')]);
        await page.keyboard.press('Enter');
        await expectNoNameInput(page, 'Enter');
        await expectNotice(page, undefined, 'Enter');
        await expectSourceStill(page, doc, [], 'Enter');

        await remount(page, doc, { hooks: 'transform' });
        await pressNode(page, 3);
        await expectSelection(page, [target(3, 'a')]);
        await page.keyboard.press('Tab');
        await expectNoNameInput(page, 'Tab');
        await expectNotice(page, 'error', 'Tab');
        await expectSourceStill(page, doc, [], 'Tab');
        expect(await nodeCount(page)).toBe(4);
    });

    test('@editor transformSource がノードを前に足す文書で、ルートに子を足すと原文は書き換わるが、図と合わない選び直しと名前の入力は使われず (別のノードを選ばず、入力も開かず)、理由が出る', async ({ page }) => {
        await open(page);
        const doc = docWith(EDIT, TRANSFORM_BODY);
        const added = docWith(EDIT, ['# R', '', '- a', '- b', `- ${NEW}`, '']);
        // 図と原文が合う文書で同じ操作をしたときの、結果の通知の文字
        await mount(page, doc);
        await pressNode(page, ROOT);
        await page.keyboard.press('Tab');
        await expectSource(page, added, [added], 'transformSource なし');
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true }, 'transformSource なし');
        const plainNotice = await expectNotice(page, 'info', 'transformSource なし');

        await remount(page, doc, { hooks: 'transform' });
        await pressNode(page, ROOT);
        await expectSelection(page, [target(ROOT, 'R')]);
        await page.keyboard.press('Tab');
        await expectSource(page, added, [added]);
        // 図は R 1、自動 2、a 3、b 4、新しいノード 5。書き換えの結果の選び直し (id 4、新しいノード) は図の id 4 (b) と合わない
        await expect(page.locator('#a .mdag-node')).toHaveCount(5);
        await expectNoNameInput(page);
        const state = await selectionOf(page);
        expect(state.marked).not.toContain(4);
        expect(state.marked).not.toContain(5);
        expect(typeof state.selected === 'string' ? [] : state.selected.map((item) => item.id)).not.toContain(4);
        expect(typeof state.selected === 'string' ? [] : state.selected.map((item) => item.id)).not.toContain(5);
        // 理由の通知が出ている (図と原文が合う文書の結果の通知と同じ文字のままではない)
        await expect
            .poll(async () => {
                if ((await snackbars(page).count()) !== 1) return false;
                const text = ((await snackbars(page).textContent()) ?? '').replace(/\s+/g, ' ').trim();
                return text !== '' && text !== plainNotice;
            })
            .toBe(true);
    });
});

test.describe('閲覧への切り替えと外からの差し替え (B-171、A-20、5.3)', () => {
    test('@editor 名前の入力中に閲覧へ切り替えると、入れた名前で決めて閉じる (足したばかりのノードは足す前に戻さない。setMode でもセグメントでも)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SWITCH);
        expect(await getMode(page)).toBe('edit');
        await pressNode(page, TASK_A);
        await page.keyboard.press('Tab');
        const added = docWith(SWITCH_EDIT, BODY_A_CHILD);
        const named = docWith(SWITCH_EDIT, BODY_A_SUB);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
        await page.keyboard.type('Sub');
        expect(await setMode(page, 'view')).toBe(true);
        await expectSource(page, named, [added, named], 'setMode');
        await expectNameInputClosed(page, 'setMode');
        expect(await getMode(page)).toBe('view');

        await remount(page, DOC_SWITCH);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Renamed');
        await segmentButton(page, 'view').click();
        const renamed = docWith(SWITCH_EDIT, BODY_B_RENAMED);
        await expectSource(page, renamed, [renamed], 'セグメント');
        await expectNameInputClosed(page, 'セグメント');
        await expect.poll(() => getMode(page)).toBe('view');
    });

    test('@editor 閲覧へ切り替えるときに決める名前が断られたら (empty-name)、原文を変えずに理由の通知 (error) を出し、入力を閉じて閲覧に替わる (A-20)', async ({ page }) => {
        await open(page);
        const doc = docWith(SWITCH_EDIT, TASKS_BODY);
        await mount(page, doc);
        await pressLabel(page, TODO);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TODO, { value: 'Todo' });
        await replaceName(page, '');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('');

        expect(await setMode(page, 'view')).toBe(true);
        expect(await getMode(page)).toBe('view');
        await expectNameInputClosed(page);
        await expectNotice(page, 'error');
        await expectSourceStill(page, doc, []);
        await expect(labelOf(page, TODO)).toHaveText('Todo');
    });

    test('@editor 名前の入力中に setSource で markdag.editor を閲覧にすると、入力は保存せずに閉じてから閲覧に替わる。入れた名前は原文にも履歴にも入らない (A-20)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SWITCH);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'Typed');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('Typed');

        const next = docWith(['mode: switch', 'default: view'], BODY);
        await setSource(page, next);
        await expect.poll(() => getMode(page)).toBe('view');
        await expectNameInputClosed(page);
        await expectSourceStill(page, next, []);
        await expect(labelOf(page, TASK_B)).toHaveText('Task B');

        // 履歴は setSource の 1 つだけ (入れた名前で決めていない)
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo())).toBe(true);
        expect(await getSource(page)).toBe(DOC_SWITCH);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo())).toBe(false);
        expect((await changeLog(page)).some((markdown) => markdown.includes('Typed'))).toBe(false);
    });
});

test.describe('閲覧 (B-169、B-172)', () => {
    test('@editor 閲覧では、ノードのクリック、ラベルのダブルクリック、Enter、Tab、Shift+Tab、F2 で名前の入力が開かず、原文も変わらない。図を動かす操作は効く (閲覧だけの文書と、GUI 編集から切り替えた閲覧)', async ({ page }) => {
        await open(page);
        for (const [name, doc] of [
            ['閲覧だけの文書', DOC_VIEW],
            ['切り替えた閲覧', DOC_SWITCH],
        ] as const) {
            if (name === '閲覧だけの文書') await mount(page, doc);
            else {
                await remount(page, doc);
                expect(await setMode(page, 'view'), name).toBe(true);
            }
            expect(await getMode(page), name).toBe('view');

            await pressNode(page, TASK_A);
            await doubleClickLabel(page, TASK_B);
            await pointerOverBlank(page);
            for (const key of ['Enter', 'Tab', 'Shift+Tab', 'F2']) await page.keyboard.press(key);
            const blank = await spot(page, { on: 'blank', root: 'a' });
            await page.mouse.dblclick(blank.x, blank.y);
            await expectNoNameInput(page, name);
            await expectSourceStill(page, doc, [], name);
            expect(await nodeCount(page), name).toBe(6);
            expect((await selectionOf(page)).selected, name).toEqual([]);

            const before = await transformOf(page);
            const from = await spot(page, { on: 'blank', root: 'a' });
            await dragFrom(page, from, { x: from.x + 80, y: from.y + 50 });
            await expect.poll(async () => sameTransform(await transformOf(page), before), name).toBe(false);
        }

        // 空振りの防ぎ: GUI 編集へ戻すと、同じ操作で名前の入力が開く
        expect(await setMode(page, 'edit')).toBe(true);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
    });
});

// ---- 削除と付け替えのドラッグ ----

const BUILD = 5;

// Design を配下 (Task A、Task B) ごと消した本文。見出しのブロックは次の見出しの前まで、消したあとに続く 2 つの空行は 1 つにする
const DOC_NO_DESIGN = docWith(EDIT, ['# Root', '', '## Build', '', '- Leaf', '']);
// Task A、Task B を消した本文 (どちらも親は Design)
const DOC_NO_A = docWith(EDIT, designBody(['- Task B']));
const DOC_NO_B = docWith(EDIT, designBody(['- Task A']));
// Task A を Leaf の最後の子へ付け替えた本文 (リストの子は入れ子の項目で、字下げ 4)。動かした Task A は 6
const DOC_A_UNDER_LEAF = docWith(EDIT, ['# Root', '', '## Design', '', '- Task B', '', '## Build', '', '- Leaf', '    - Task A', '']);

// markdag.relations が Task A を指す文書 (削除の追随を見る)
const DOC_RELATIONS = docWith(EDIT, BODY, [
    'relations:',
    '    depends:',
    '        - Task A --> Leaf',
    '        - Design --> Leaf',
    '    chain:',
    '        - Task A --> Task B --> Leaf',
    '    join:',
    '        - Task A & Task B --> Build',
]);
// Task A を消した本文: depends の「Task A --> Leaf」は片側の項がなくなって外れ、chain は残った「Task B --> Leaf」で書き直し、
// join は始点が 1 つになって depends の末尾へ移る。項目のなくなった join のキーは外す
const DOC_RELATIONS_NO_A = docWith(EDIT, designBody(['- Task B']), [
    'relations:',
    '    depends:',
    '        - Design --> Leaf',
    '        - Task B --> Build',
    '    chain:',
    '        - Task B --> Leaf',
]);

// Build の下に項目が 2 つある文書 (複数の削除)。Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6、Leaf 2 7
const DOC_MULTI = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', '- Leaf 2', '']);
// Task A と Leaf を消した本文 (選ぶのは文書の順で最初に消した Task A の親 Design)
const DOC_MULTI_NO_A_LEAF = docWith(EDIT, ['# Root', '', '## Design', '', '- Task B', '', '## Build', '', '- Leaf 2', '']);
// Design、Task A (Design の配下)、Leaf を消した本文 (配下に含まれる Task A は Design と一緒に消える。選ぶのは Design の親 Root)
const DOC_MULTI_NO_DESIGN_LEAF = docWith(EDIT, ['# Root', '', '## Build', '', '- Leaf 2', '']);

// frontmatter がフロー形式の文書。Task A を消すと relations の項を外す書き換えが要るので、markdag の値を字下げの形に書き直してから
// 項を外す (空になった depends と relations のキーも外す。D-057)。Task B は relations に出ないので frontmatter を変えずに消せる
const FLOW_FRONTMATTER = ['---', 'markdag: { editor: { mode: edit }, relations: { depends: [Task A --> Leaf] } }', '---', ''];
const DOC_FLOW = [...FLOW_FRONTMATTER, ...BODY].join('\n');
const DOC_FLOW_NO_B = [...FLOW_FRONTMATTER, ...designBody(['- Task A'])].join('\n');
const DOC_FLOW_NO_A = ['---', 'markdag:', '    editor:', '        mode: edit', '---', '', ...designBody(['- Task B'])].join('\n');

// 詳細を持つ項目と子のない見出しのある文書。Root 1、Design 2、Task A 3 (詳細あり)、Task B 4、Empty 5、Build 6、Leaf 7
const DOC_DETAILS = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A', '    > note', '- Task B', '', '## Empty', '', '## Build', '', '- Leaf', '']);
const EMPTY = 5;
// Task B を Empty の下へ付け替えた本文 (子のない見出しの子は 1 段下の見出し。前の行が空でなければ空行をはさむ)。動かした Task B は 5
const DOC_DETAILS_B_UNDER_EMPTY = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A', '    > note', '', '## Empty', '', '### Task B', '', '## Build', '', '- Leaf', '']);
// 詳細だけを持つ Task A を Empty の下へ付け替えた本文。### Task A と見出しの詳細 > note に書く (D-078)。動かした Task A は 5
const DOC_DETAILS_A_UNDER_EMPTY = docWith(EDIT, ['# Root', '', '## Design', '', '- Task B', '', '## Empty', '', '### Task A', '> note', '', '## Build', '', '- Leaf', '']);
// 続きの段落を持つ Task A の文書 (付け替えで見出しにすると続きの段落が図から消えるので heading-details で断る)
const DOC_CONTINUATION = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A', '  続き', '- Task B', '', '## Empty', '', '## Build', '', '- Leaf', '']);

// ノードの箱の上の点と、ノードの文字の上の点
const boxPoint = (page: Page, id: number, root = 'a'): Promise<Point> => spot(page, { on: 'element', selector: `${nodeSelector(id, root)} .mdag-box` });
const textPoint = (page: Page, id: number, root = 'a'): Promise<Point> => spot(page, { on: 'text', selector: `${nodeSelector(id, root)} .mdag-content` });

// 修飾キーを押したままノードの箱を押す (選択に足す)
async function pressNodeWith(page: Page, id: number, modifier: string, root = 'a'): Promise<void> {
    const point = await boxPoint(page, id, root);
    await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        await page.keyboard.up(modifier);
    }
}

// from で押し、points を順にたどってから離す。at は各点まで動かしたあと (離す前) に、たどった点の添字で呼ぶ
async function dragThrough(page: Page, from: Point, points: Point[], at?: (index: number) => Promise<void>, button: 'left' | 'middle' = 'left'): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    try {
        for (const [index, point] of points.entries()) {
            await page.mouse.move(point.x, point.y, { steps: 6 });
            if (at) await at(index);
        }
    } finally {
        await page.mouse.up({ button });
    }
}

// data-drop-target の付いたノードの id (昇順)
const dropTargetIds = (page: Page, root = 'a'): Promise<number[]> =>
    page.evaluate(
        (root) =>
            [...document.querySelectorAll(`#${root} .mdag-node[data-drop-target]`)].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b),
        root,
    );

interface GhostState {
    // 見えている名前の影 (.mdag-editor-ghost) の数
    count: number;
    // 影の文字 (1 つのときだけ)
    text: string;
    rect: Box | null;
}

async function ghostOf(page: Page, root = 'a'): Promise<GhostState> {
    return page.evaluate((root) => {
        const shown = [...document.querySelectorAll(`#${root} .mdag-editor-ghost`)].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, text: '', rect: null };
        const rect = element.getBoundingClientRect();
        return { count: 1, text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
    }, root);
}

// ページで選ばれている文字
const textSelection = (page: Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? '');

// 配布物の editSource で同じ書き換えを試す (断る理由の文と、結果の通知に続く項目の文を引く。期待の空振りの防ぎにも使う)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const reasonOf = (outcome: EditOutcome): { code: string; message: string } | null => (outcome.status === 'edited' || !outcome.reason ? null : { code: outcome.reason.code, message: outcome.reason.message });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

// ドラッグを離したあと: 移す先の枠と名前の影が残っていない
async function expectDragCleared(page: Page, message?: string): Promise<void> {
    await expect.poll(() => dropTargetIds(page), message).toEqual([]);
    await expect.poll(async () => (await ghostOf(page)).count, message).toBe(0);
}

// ドラッグの途中で、移す先の枠と名前の影が出ていない (数コマ待ってから)
async function expectNoDragFeedback(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect(await dropTargetIds(page), message).toEqual([]);
    expect((await ghostOf(page)).count, message).toBe(0);
}

test.describe('ノードの削除 (段 16。B-016、B-037〜B-041、B-004、3.5、3.6)', () => {
    test('@editor Delete と Backspace で、選んだノードを配下ごと消す。原文が書き換わって onChange が 1 回呼ばれ、消したノードの親が選ばれ、結果の通知 (info) が出る。⌘Z / Ctrl+Z で戻る (B-037、B-038、B-004)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await pressNode(page, DESIGN);
        await expectSelection(page, [target(DESIGN, 'Design')]);
        await expect(snackbars(page)).toHaveCount(0);

        await page.keyboard.press('Delete');
        await expectSource(page, DOC_NO_DESIGN, [DOC_NO_DESIGN], 'Delete');
        await expect(page.locator('#a .mdag-node')).toHaveCount(3);
        await expectSelection(page, [target(ROOT, 'Root')], 'Delete');
        await expect.poll(() => lastSelectionChange(page)).toEqual([target(ROOT, 'Root')]);
        await expectNotice(page, 'info', 'Delete');
        await expectNoNameInput(page, 'Delete');

        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expectSource(page, DOC, [DOC_NO_DESIGN, DOC], '元に戻す');
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);

        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await page.keyboard.press('Backspace');
        await expectSource(page, DOC_NO_A, [DOC_NO_DESIGN, DOC, DOC_NO_A], 'Backspace');
        await expect(page.locator('#a .mdag-node')).toHaveCount(5);
        await expectSelection(page, [target(DESIGN, 'Design')], 'Backspace');
        expect(errors).toEqual([]);
    });

    test('@editor 帯の「削除」で、選んだノードを消し、消したノードの親が選ばれる (B-016、B-004)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await pressBar(page, 'delete');
        await expectSource(page, DOC_NO_B, [DOC_NO_B]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(5);
        await expectSelection(page, [target(DESIGN, 'Design')]);
        await expectNotice(page, 'info');
    });

    test('@editor 消したノードに当たる markdag.relations の項だけを外し (chain は分け、join は depends へ移す)、直した項目ごとの中身を結果の通知に続けて出す (B-039、10.3 の A-03、3.6)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_RELATIONS);
        // 空振りの防ぎ: この削除は relations の項目を 3 つ直す
        const outcome = await tryEdit(page, DOC_RELATIONS, { kind: 'deleteNodes', nodes: [target(TASK_A, 'Task A')] });
        const notes = outcome.status === 'edited' ? outcome.notes : [];
        expect(notes.map((note) => note.code)).toEqual(['relations-removed', 'relations-removed', 'relations-removed']);

        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await page.keyboard.press('Delete');
        await expectSource(page, DOC_RELATIONS_NO_A, [DOC_RELATIONS_NO_A]);
        await expectSelection(page, [target(DESIGN, 'Design')]);
        const text = await expectNotice(page, 'info');
        for (const note of notes) expect(text, note.message).toContain(note.message.replace(/\s+/g, ' ').trim());
    });

    test('@editor 2 つ以上を選んで Delete か、複数の選択の帯の「削除」で、全部を配下ごと 1 回の書き換えで消し、1 回の元に戻すで戻る。選ぶのは最初に消したノード (文書の順) の親 (B-041、B-065、B-004)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_MULTI);
        await useSelectTool(page);

        // 選んだ順 (Leaf、Task A) によらず、文書の順で最初の Task A の親を選ぶ
        await pressNode(page, LEAF);
        await pressNodeWith(page, TASK_A, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(LEAF, 'Leaf')]);
        await page.keyboard.press('Delete');
        await expectSource(page, DOC_MULTI_NO_A_LEAF, [DOC_MULTI_NO_A_LEAF], 'Delete');
        await expect(page.locator('#a .mdag-node')).toHaveCount(5);
        await expectSelection(page, [target(DESIGN, 'Design')], 'Delete');
        await expectNotice(page, 'info', 'Delete');
        expect(await callHistory(page, 'undo')).toBe(true);
        await expectSource(page, DOC_MULTI, [DOC_MULTI_NO_A_LEAF, DOC_MULTI], 'Delete の元に戻す');
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(toolButton(page, 'undo')).toBeDisabled();

        // 配下 (Task A) を一緒に選んでいても、Design に含めて 1 度だけ消す
        await pressNode(page, DESIGN);
        await pressNodeWith(page, TASK_A, 'Shift');
        await pressNodeWith(page, LEAF, 'Shift');
        await expectSelection(page, [target(DESIGN, 'Design'), target(TASK_A, 'Task A'), target(LEAF, 'Leaf')]);
        await pressBar(page, 'delete');
        await expectSource(page, DOC_MULTI_NO_DESIGN_LEAF, [DOC_MULTI_NO_A_LEAF, DOC_MULTI, DOC_MULTI_NO_DESIGN_LEAF], '帯の削除');
        await expect(page.locator('#a .mdag-node')).toHaveCount(3);
        await expectSelection(page, [target(ROOT, 'Root')], '帯の削除');
        await focusDiagram(page);
        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expectSource(page, DOC_MULTI, [DOC_MULTI_NO_A_LEAF, DOC_MULTI, DOC_MULTI_NO_DESIGN_LEAF, DOC_MULTI], '帯の削除の元に戻す');
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor ルートは消せない: 帯に「削除」を出さず、Delete と Backspace では原文を変えずに理由の通知を出す。何も選んでいないときの Delete は何も消さない (B-040、B-012)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pointerOverBlank(page);
        await page.keyboard.press('Delete');
        await expectSourceStill(page, DOC, [], '選んでいないときの Delete');
        expect(await nodeCount(page)).toBe(6);

        await pressNode(page, ROOT);
        await expectSelection(page, [target(ROOT, 'Root')]);
        await expect(visible(page, '#a .mdag-editor-bar[data-for="node"]')).toHaveCount(1);
        await expect(visible(page, '#a .mdag-editor-bar-button[data-command="rename"]')).toHaveCount(1);
        await expect(visible(page, '#a .mdag-editor-bar-button[data-command="delete"]')).toHaveCount(0);
        await expect(snackbars(page)).toHaveCount(0);

        await page.keyboard.press('Delete');
        await expectSourceStill(page, DOC, [], 'Delete');
        await expectNotice(page, undefined, 'Delete');
        await page.keyboard.press('Backspace');
        await expectSourceStill(page, DOC, [], 'Backspace');
        expect(await nodeCount(page)).toBe(6);
        await expectSelection(page, [target(ROOT, 'Root')]);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor 入力欄にいるときの Delete と Backspace は文字の削除で、ノードを消さない (名前の入力と、図の外の原文の欄) (B-037)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await replaceName(page, 'abcd');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('abd');
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('ab');
        await expectSourceStill(page, DOC, [], '名前の入力');
        expect(await nodeCount(page)).toBe(6);
        await page.keyboard.press('Escape');
        await expectNameInputClosed(page);

        // 図の外の欄にフォーカスがあれば、ポインタが図の上にあっても図のキーにならない
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await focusOutside(page);
        await page.keyboard.type('xyz');
        await pointerOverBlank(page);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Delete');
        await expect.poll(() => page.locator('#source').inputValue()).toBe('x');
        await expectSourceStill(page, DOC, [], '図の外の欄');
        expect(await nodeCount(page)).toBe(6);

        // 空振りの防ぎ: 図を押してフォーカスが図へ移れば、同じキーでノードを消す
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('Backspace');
        await expectSource(page, DOC_NO_B, [DOC_NO_B]);
    });

    test('@editor relations の項を外す書き換えが要る削除は、frontmatter がフロー形式でも字下げの形に書き直してから項を外し、原文が書き換わって通知 (info) が出て、履歴に積む (B-002、3.4 の deleteNodes、D-057)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_FLOW, { kind: 'deleteNodes', nodes: [target(TASK_A, 'Task A')] }))).toBe(DOC_FLOW_NO_A);
        await mount(page, DOC_FLOW);
        expect(await getMode(page)).toBe('edit');

        // relations に出ないノードは frontmatter を変えずに消せる (今と同じ)
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('Delete');
        await expectSource(page, DOC_FLOW_NO_B, [DOC_FLOW_NO_B]);

        await remount(page, DOC_FLOW);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await page.keyboard.press('Delete');
        await expectSource(page, DOC_FLOW_NO_A, [DOC_FLOW_NO_A]);
        expect(await nodeCount(page)).toBe(5);
        await expectNotice(page, 'info');
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('付け替えのドラッグ (段 16。B-055〜B-058、B-004、5.2 の軸 B と軸 E、3.5)', () => {
    test('@editor 選択の道具でノードの文字からほかのノードへドラッグすると、ポインタの下のノードに data-drop-target が付き (何もないところでは外れる)、名前の影がポインタに付いてくる。離すと移す先の最後の子へ付け替わり、動かしたノードが選ばれる。文字は選ばれず、⌘Z / Ctrl+Z で戻る (B-055、B-056、B-004、request.md 3.1)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const from = await textPoint(page, TASK_A);
        const build = await boxPoint(page, BUILD);
        const blank = await spot(page, { on: 'blank', root: 'a' });
        const leaf = await textPoint(page, LEAF);
        const seen: { atBuild: Box | null } = { atBuild: null };

        await dragThrough(page, from, [build, blank, leaf], async (index) => {
            if (index === 0) {
                await expect.poll(() => dropTargetIds(page), 'Build の上').toEqual([BUILD]);
                await expect.poll(async () => (await ghostOf(page)).count, 'Build の上の影').toBe(1);
                expect((await ghostOf(page)).text, 'Build の上の影').toContain('Task A');
                seen.atBuild = (await ghostOf(page)).rect;
            } else if (index === 1) {
                await expect.poll(() => dropTargetIds(page), '何もないところ').toEqual([]);
                await expect.poll(async () => (await ghostOf(page)).count, '何もないところの影').toBe(1);
            } else {
                await expect.poll(() => dropTargetIds(page), 'Leaf の上').toEqual([LEAF]);
                // 影はポインタと同じだけ動く (Build の上の点から Leaf の上の点まで)
                await expect
                    .poll(async () => {
                        const now = (await ghostOf(page)).rect;
                        const before = seen.atBuild;
                        if (!now || !before) return null;
                        return Math.abs(now.left - before.left - (leaf.x - build.x)) <= 3 && Math.abs(now.top - before.top - (leaf.y - build.y)) <= 3;
                    }, 'Leaf の上の影')
                    .toBe(true);
                expect(await textSelection(page), 'ドラッグの途中').toBe('');
                // 離すまでは原文を変えない
                expect(await getSource(page)).toBe(DOC);
                expect(await changeLog(page)).toEqual([]);
            }
        });

        await expectSource(page, DOC_A_UNDER_LEAF, [DOC_A_UNDER_LEAF]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        await expectDragCleared(page, '離したあと');
        await expectSelection(page, [target(6, 'Task A')]);
        await expect.poll(() => lastSelectionChange(page)).toEqual([target(6, 'Task A')]);
        await expectNotice(page, 'info');
        expect(await textSelection(page), '離したあと').toBe('');

        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expectSource(page, DOC, [DOC_A_UNDER_LEAF, DOC], '元に戻す');
        expect(errors).toEqual([]);
    });

    test('@editor ノードの外 (何もないところ) で離すと付け替えず、ほかのノードの上で離すよう案内する。移す先の枠と影は外れる (B-058)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const from = await boxPoint(page, TASK_A);
        const leaf = await boxPoint(page, LEAF);
        const blank = await spot(page, { on: 'blank', root: 'a' });
        await expect(snackbars(page)).toHaveCount(0);

        await dragThrough(page, from, [leaf, blank], async (index) => {
            if (index === 0) await expect.poll(() => dropTargetIds(page), 'Leaf の上').toEqual([LEAF]);
        });
        await expectDragCleared(page);
        await expectSourceStill(page, DOC, []);
        expect(await nodeCount(page)).toBe(6);
        await expectNotice(page);
    });

    test('@editor 自分の配下へドラッグして離すと、原文を変えずに理由の通知 (error) を出す (B-057 の move-into-self)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const reason = reasonOf(await tryEdit(page, DOC, { kind: 'moveNode', node: target(DESIGN, 'Design'), parent: target(TASK_A, 'Task A') }));
        expect(reason?.code).toBe('move-into-self');

        await dragThrough(page, await boxPoint(page, DESIGN), [await boxPoint(page, TASK_A)]);
        await expectDragCleared(page);
        await expectSourceStill(page, DOC, []);
        const text = await expectNotice(page, 'error');
        expect(text).toContain(reason?.message ?? '');
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor すでにその親の子なら、親へドラッグしても原文と履歴を変えない。ルートはドラッグしても動かない (B-057)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        // 空振りの防ぎ: Task B はもう Design の子
        expect((await tryEdit(page, DOC, { kind: 'moveNode', node: target(TASK_B, 'Task B'), parent: target(DESIGN, 'Design') })).status).toBe('unchanged');

        await dragThrough(page, await boxPoint(page, TASK_B), [await boxPoint(page, DESIGN)]);
        await expectDragCleared(page, 'もとの親');
        await expectSourceStill(page, DOC, [], 'もとの親');
        await expect(toolButton(page, 'undo')).toBeDisabled();

        await dragThrough(page, await boxPoint(page, ROOT), [await boxPoint(page, LEAF)]);
        await expectDragCleared(page, 'ルート');
        await expectSourceStill(page, DOC, [], 'ルート');
        expect(await nodeCount(page)).toBe(6);
        await expect(toolButton(page, 'undo')).toBeDisabled();

        // 空振りの防ぎ: 同じ図で、ほかの親へのドラッグは付け替わる
        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, LEAF)]);
        await expectSource(page, DOC_A_UNDER_LEAF, [DOC_A_UNDER_LEAF], 'ほかの親');
    });

    test('@editor 詳細だけを持つ項目を子のない見出しへドラッグして離すと、1 段下の見出しと見出しの詳細に書いて付け替わる。続きの段落を持つ項目は理由の通知 (error) が出て原文が変わらない。詳細のない項目は 1 段下の見出しとして付け替わる (A-08、B-10、B-056、D-078)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_DETAILS, { kind: 'moveNode', node: target(TASK_A, 'Task A'), parent: target(EMPTY, 'Empty') }))).toBe(DOC_DETAILS_A_UNDER_EMPTY);
        const reason = reasonOf(await tryEdit(page, DOC_CONTINUATION, { kind: 'moveNode', node: target(TASK_A, 'Task A'), parent: target(EMPTY, 'Empty') }));
        expect(reason?.code).toBe('heading-details');

        // 詳細だけを持つ項目
        await mount(page, DOC_DETAILS);
        await useSelectTool(page);
        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, EMPTY)]);
        await expectDragCleared(page, '詳細を持つ項目');
        await expectSource(page, DOC_DETAILS_A_UNDER_EMPTY, [DOC_DETAILS_A_UNDER_EMPTY], '詳細を持つ項目');
        await expectSelection(page, [target(5, 'Task A')], '詳細を持つ項目');
        await expect(page.locator(nodeSelector(5)), '詳細を持つ項目').toHaveAttribute('data-has-details', '');

        // 続きの段落を持つ項目は断る
        await remount(page, DOC_CONTINUATION);
        await useSelectTool(page);
        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, EMPTY)]);
        await expectDragCleared(page, '続きの段落を持つ項目');
        await expectSourceStill(page, DOC_CONTINUATION, [], '続きの段落を持つ項目');
        const text = await expectNotice(page, 'error', '続きの段落を持つ項目');
        expect(text).toContain(reason?.message ?? '');

        // 詳細のない項目
        await remount(page, DOC_DETAILS);
        await useSelectTool(page);
        await dragThrough(page, await boxPoint(page, TASK_B), [await boxPoint(page, EMPTY)]);
        await expectSource(page, DOC_DETAILS_B_UNDER_EMPTY, [DOC_DETAILS_B_UNDER_EMPTY], '詳細のない項目');
        await expectDragCleared(page, '詳細のない項目');
        await expectSelection(page, [target(5, 'Task B')], '詳細のない項目');
    });

    test('@editor 付け替えるのは選択の道具の主ボタンのドラッグだけ: 手のひらの道具のドラッグと中ボタンのドラッグでは移す先の枠も影も出さず付け替えない。4px までの動きは付け替えずにノードを選ぶ (5.2 の軸 B と軸 E)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await toolButton(page, 'hand').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');

        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, LEAF)], async () => expectNoDragFeedback(page, '手のひら'));
        await expectSourceStill(page, DOC, [], '手のひら');

        await useSelectTool(page);
        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, LEAF)], async () => expectNoDragFeedback(page, '中ボタン'), 'middle');
        await expectSourceStill(page, DOC, [], '中ボタン');

        // 押した所から 4px までの動きはクリック (選ぶ)
        const from = await boxPoint(page, TASK_A);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 2, from.y + 1, { steps: 2 });
        await page.mouse.up();
        await expectSelection(page, [target(TASK_A, 'Task A')], '4px まで');
        await expectNoDragFeedback(page, '4px まで');
        await expectSourceStill(page, DOC, [], '4px まで');

        // 空振りの防ぎ: 同じ図で、選択の道具の主ボタンのドラッグは付け替わる
        await dragThrough(page, await boxPoint(page, TASK_A), [await boxPoint(page, LEAF)]);
        await expectSource(page, DOC_A_UNDER_LEAF, [DOC_A_UNDER_LEAF], '選択の道具の主ボタン');
    });
});

interface KeySeen {
    key: string;
    // window の受け口に届いたときの defaultPrevented (編集の層が既定の動きを止めたか)
    prevented: boolean;
    // フォーカスが図の要素 (#a) の中にあった
    inDiagram: boolean;
}

// 図を埋め込むページ (アプリ) の代わりに、window で Backspace の既定の動きを止め、Delete と Backspace の届き方を記録する。
// 閲覧でも図がキーを受けているときは、編集の層が Backspace と Delete の既定の動きを止める (AM-09。render の図は止めない)。WebKit は止めない Backspace で前のページへ戻ることがあり
// (BackspaceKeyNavigationEnabled。Playwright の WebKit は戻る)、戻るとページそのものが入れ替わって原文を確かめられない。
// window の泡立ちは編集の層の受け口 (document) のあとなので、記録するのは編集の層が決めた defaultPrevented。
// ほかのテストで Backspace による移動を隠さないよう、harness には入れず、このテストだけで使う
async function holdBackspace(page: Page): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as { keysSeen: KeySeen[] };
        target.keysSeen = [];
        window.addEventListener('keydown', (event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            target.keysSeen.push({ key: event.key, prevented: event.defaultPrevented, inDiagram: document.getElementById('a')?.contains(document.activeElement) ?? false });
            if (event.key === 'Backspace') event.preventDefault();
        });
    });
}

// holdBackspace が記録したキーを返し、記録を空にする
const takeKeysSeen = (page: Page): Promise<KeySeen[]> =>
    page.evaluate(() => {
        const target = window as unknown as { keysSeen: KeySeen[] };
        const seen = target.keysSeen;
        target.keysSeen = [];
        return seen;
    });

test.describe('閲覧の削除と付け替え (段 16。B-169、B-171)', () => {
    // 閲覧の Delete と Backspace は、図がキーを受けているので編集の層が既定の動きを止めて何もしないことと、ページが入れ替わらない (URL が同じ) ことも見る (G-040。止めるのは AM-09。D-027)
    test('@editor 閲覧では Delete、Backspace、ノードのドラッグで原文が変わらず、移す先の枠も影も出ない (閲覧だけの文書と、ノードを選んでから GUI 編集から切り替えた閲覧)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await holdBackspace(page);
        const url = page.url();
        for (const [name, doc] of [
            ['閲覧だけの文書', DOC_VIEW],
            ['切り替えた閲覧', DOC_SWITCH],
        ] as const) {
            if (name === '閲覧だけの文書') await mount(page, doc);
            else {
                await remount(page, doc);
                await pressNode(page, TASK_A);
                await expectSelection(page, [target(TASK_A, 'Task A')], name);
                expect(await setMode(page, 'view'), name).toBe(true);
            }
            expect(await getMode(page), name).toBe('view');

            await pressNode(page, TASK_A);
            await page.keyboard.press('Delete');
            await page.keyboard.press('Backspace');
            await pointerOverBlank(page);
            await page.keyboard.press('Delete');
            await page.keyboard.press('Backspace');
            await expectSourceStill(page, doc, [], `${name} のキー`);
            expect(await nodeCount(page), name).toBe(6);
            expect(await takeKeysSeen(page), `${name} のキー`).toEqual(['Delete', 'Backspace', 'Delete', 'Backspace'].map((key) => ({ key, prevented: true, inDiagram: true })));
            expect(page.url(), `${name} のキー`).toBe(url);

            await dragThrough(page, await textPoint(page, TASK_A), [await boxPoint(page, LEAF)], async () => expectNoDragFeedback(page, `${name} のドラッグ`));
            await expectSourceStill(page, doc, [], `${name} のドラッグ`);
            expect(await nodeCount(page), name).toBe(6);
        }

        // 空振りの防ぎ: GUI 編集へ戻すと、同じ図で消せる。GUI 編集の Delete は編集の層が既定の動きを止める (window の受け口に止めたあとで届く)
        expect(await setMode(page, 'edit')).toBe(true);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await page.keyboard.press('Delete');
        await expectSource(page, docWith(SWITCH_EDIT, designBody(['- Task B'])), [docWith(SWITCH_EDIT, designBody(['- Task B']))]);
        expect(await takeKeysSeen(page), 'GUI 編集の Delete').toEqual([{ key: 'Delete', prevented: true, inDiagram: true }]);
        expect(page.url(), 'GUI 編集の Delete').toBe(url);
    });
});

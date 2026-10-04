// GUI 編集の H / V のキーと、子と兄弟を足す + のつまみを、ビルドした配布物の markdag/editor で確かめる。
// H と V は道具を手のひらと選択に替える (F2 と F のキーは入れない)。子の + はノードの右 (縦の中央)、兄弟の + は下に出し、
// 線を引く点も右なので重ならないように縦にずらす。子の + と線を引く点の並べ方は決めていない。フォーカスの枠も見る。
// 見た目そのもの (色、余白、影、アイコンの形、+ と点の大きさ、ずらす量) は見ない。道具の状態 (.markdag の data-editor-tool と data-drag-to-pan、
// 道具箱の aria-pressed)、フォーカスのある要素、つまみの有無と数と data-handle、つまみと点とノードの箱の位置の関係、書き換えたあとの原文の全文、
// onChange の呼ばれ方、選び直し、名前の入力の有無と値、通知を見る。
// 期待の原文は名前と構造のテストと同じ子と兄弟の行の規則のもの (+ は Tab と帯の子、兄弟と同じ書き換え)。
// 反映は expect.poll で待ち、「変わらない」「出ない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditSelection, NodeTarget, ViewTransform } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

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

// 足したノードの仮の名前
const NEW = '新しいノード';

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

// markdag.editor を書いた文書。editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く
function docWith(editor: string[], body: string[]): string {
    return ['---', 'markdag:', '    edgeHighlight: true', '    editor:', ...editor.map((line) => `        ${line}`), '---', '', ...body].join('\n');
}

// Design の下の項目だけを替えた本文。ノードは Root 1、Design 2、項目 (3 から文書の順)、Build、Leaf
function designBody(items: string[]): string[] {
    return ['# Root', '', '## Design', '', ...items, '', '## Build', '', '- Leaf', ''];
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、Task A と Task B は縦に並ぶ
const BODY = designBody(['- Task A', '- Task B']);
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;

// Task A に子を足した本文。足した子は 4 (リストの子は入れ子の項目で、字下げは 4)
const BODY_A_CHILD = designBody(['- Task A', `    - ${NEW}`, '- Task B']);
// Task A に兄弟を足した本文。足した兄弟は 4 (自分と同じ形で、自分のすぐあと)
const BODY_A_SIBLING = designBody(['- Task A', `- ${NEW}`, '- Task B']);
// Root に子を足した本文。足した子は 7 (最後の子の見出しの形。前の行が空でないので空行をはさむ)
const BODY_ROOT_CHILD = [...BODY.slice(0, -1), '', `## ${NEW}`, ''];

const DOC = docWith(EDIT, BODY);
const DOC_SWITCH = docWith(SWITCH_EDIT, BODY);
const DOC_VIEW = docWith(['mode: view'], BODY);

interface ToolState {
    // .markdag (図を置いた要素) の data-editor-tool
    tool: string | null;
    // 図の data-drag-to-pan (primary では付かない)。手のひら both、選択 middle
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

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// 図の外 (#a の右、#b の上) の点
const OUTSIDE: Point = { x: 1100, y: 300 };
// #b の上の点 (#b は #a の下にあり、画面に入るのは上の一部)
const OVER_B: Point = { x: 500, y: 700 };

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

async function mount(page: Page, markdown: string, root: 'a' | 'b' = 'a'): Promise<void> {
    await page.evaluate(
        ({ markdown, root }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error(`#${root} がない`);
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.changes.push({ root, markdown: next });
                },
            };
            target.editors[root] = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, root },
    );
    await expect(page.locator(`#${root} .mdag-node`).first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、道具を初めの状態に戻す)。onChange の記録も空にする
async function remount(page: Page, markdown: string): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = target.changes.filter((entry) => entry.root !== 'a');
    });
    await mount(page, markdown);
}

// 「変わらない」「出ない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page, root = 'a'): Promise<string[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).changes.flatMap((entry) => (entry.root === root ? [entry.markdown] : [])), root);

const getSource = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSource(), root);

async function transformOf(page: Page, root = 'a'): Promise<ViewTransform> {
    const transform = await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getTransform() ?? null, root);
    if (!transform) throw new Error(`#${root} の図がない`);
    return transform;
}

const sameTransform = (a: ViewTransform, b: ViewTransform): boolean => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

const toolButton = (page: Page, tool: string, root = 'a') => page.locator(`#${root} .mdag-editor-tool[data-tool="${tool}"]`);
const segmentButton = (page: Page, mode: 'view' | 'edit', root = 'a') => page.locator(`#${root} .mdag-editor-segment [data-mode="${mode}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const nodeSelector = (id: number, root = 'a'): string => `#${root} .mdag-node[data-id="${id}"]`;
const nodeCount = (page: Page): Promise<number> => page.locator('#a .mdag-node').count();
const labelOf = (page: Page, id: number) => page.locator(`${nodeSelector(id)} .mdag-content`);

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

// 道具の目印のうち、閲覧でも見られるもの (閲覧では道具箱を隠すので、押された状態は見ない)
async function toolMarks(page: Page, root = 'a'): Promise<{ tool: string | null; pan: string | null }> {
    const { tool, pan } = await toolState(page, root);
    return { tool, pan };
}

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 手のひらの道具にする (最初の道具は選択)。#b の道具箱は画面の外にあり、押すとページがスクロールするので戻す
async function useHandTool(page: Page, root = 'a'): Promise<void> {
    await toolButton(page, 'hand', root).click();
    await expect.poll(() => toolState(page, root)).toEqual(HAND);
    await page.evaluate(() => window.scrollTo(0, 0));
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

// フォーカスをどこにもない状態 (body) にする
const blurAll = (page: Page): Promise<void> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

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

const fieldValue = (page: Page): Promise<string> => page.locator('#source').inputValue();

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

async function nodeBox(page: Page, id: number): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
    if (!box) throw new Error(`ノード ${id} の箱がない`);
    return box;
}

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank'; root?: string }
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
            const container = document.getElementById(target.root ?? 'a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return (
            grid(rect, Math.max(1, Math.min(rect.width, rect.height) / 8)).find((point) => {
                const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                return hit !== null && element.contains(hit);
            }) ?? null
        );
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

// key の線を押す帯 (.mdag-edge-hit) が表に出ている点 (線の中ほどから試す)
async function edgeSpot(page: Page, key: string): Promise<Point> {
    const found = await page.evaluate((key) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const hit = document.querySelector<SVGGeometryElement>(`#a .mdag-edge-hit[data-key="${key}"]`);
        const matrix = hit?.getScreenCTM();
        if (!hit || !matrix) return null;
        const length = hit.getTotalLength();
        const steps = Array.from({ length: 49 }, (_, index) => index + 1).sort((a, b) => Math.abs(a - 25) - Math.abs(b - 25));
        for (const step of steps) {
            const at = hit.getPointAtLength((length * step) / 50);
            const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
            if (inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === hit) return { x: point.x, y: point.y };
        }
        return null;
    }, key);
    if (!found) throw new Error(`線 ${key} の帯の上の点がない`);
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

// ノードの箱を押す
async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

// 修飾キーを押したままノードの箱を押す (選択に足す)
async function pressNodeWith(page: Page, id: number, modifier: string): Promise<void> {
    const point = await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` });
    await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        await page.keyboard.up(modifier);
    }
}

async function pointerOverBlank(page: Page, root = 'a'): Promise<void> {
    const blank = await spot(page, { on: 'blank', root });
    await page.mouse.move(blank.x, blank.y);
}

async function drag(page: Page, from: Point, to: Point, button: 'left' | 'middle' = 'left'): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up({ button });
}

// 何もないところからドラッグして、図が動いたか (表示位置の x か y が変わったか)
async function pans(page: Page, button: 'left' | 'middle'): Promise<boolean> {
    const before = await transformOf(page);
    const from = await spot(page, { on: 'blank' });
    await drag(page, from, { x: from.x + 60, y: from.y + 40 }, button);
    try {
        await expect
            .poll(
                async () => {
                    const now = await transformOf(page);
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
        return { marked, selection: editor.getSelection() as EditSelection };
    });
    const { selection } = state;
    const selected = selection.kind === 'nodes' ? sortedTargets(selection.nodes) : selection.kind === 'none' ? [] : selection.kind;
    return { marked: state.marked, selected };
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方。getSelection は id と refText)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = sortedTargets(targets);
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
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
async function nameInputOf(page: Page): Promise<NameInputState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
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
    });
}

interface NameInputExpectation {
    value: string;
    // 値の全部を選んだ状態 (足したノードの仮の名前)
    allSelected?: boolean;
}

// 名前の入力がノードのラベルの上に 1 つ開き、フォーカスがあって、値が expected になるまで待つ。
// 「ラベルの上」は、入力の矩形がノードの文字 (.mdag-content) の矩形と左右で重なり、入力の上下の中ほどがノードの箱の中にあること
async function expectNameInputOn(page: Page, id: number, expected: NameInputExpectation, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await nameInputOf(page);
            const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
            const [label] = await rectsOf(page, `${nodeSelector(id)} .mdag-content`);
            const rect = state.rect;
            const middle = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const onLabel = rect !== null && box !== undefined && label !== undefined && rect.left < label.right && rect.right > label.left && middle >= box.top - 2 && middle <= box.bottom + 2;
            return { count: state.count, value: state.value, focused: state.focused, onLabel, ...(expected.allSelected ? { selected: state.selected } : {}) };
        }, message)
        .toEqual({ count: 1, value: expected.value, focused: true, onLabel: true, ...(expected.allSelected ? { selected: expected.value } : {}) });
}

// 名前の入力が開いていない (数コマ待ってから)
async function expectNoNameInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await nameInputOf(page)).count, message).toBe(0);
}

// 名前の入力が閉じるまで待つ
async function expectNameInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await nameInputOf(page)).count, message).toBe(0);
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

type HandleKind = 'child' | 'sibling' | 'link';

const handleSelector = (kind: HandleKind, root = 'a'): string => `#${root} .mdag-editor-handle[data-handle="${kind}"]`;

// 見えている子の + と兄弟の + の数
async function plusCounts(page: Page): Promise<{ child: number; sibling: number }> {
    return { child: (await rectsOf(page, handleSelector('child'))).length, sibling: (await rectsOf(page, handleSelector('sibling'))).length };
}

const NO_PLUS = { child: 0, sibling: 0 };

// + のつまみが出ていない (数コマ待ってから)
async function expectNoPlus(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect(await plusCounts(page), message).toEqual(NO_PLUS);
}

const centerOf = (box: Box): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

// 子の + の置き場 (ノードの右、縦の中央): 中心が箱の右の辺から右にあり、縦の中心が箱の上下の範囲の内側にある
// (上下の辺から 2px より内。線を引く点と重ならないように縦にずらしてもよいが、右上の角 (中心が上の辺) には置かない)
function childPlaced(handle: Box, box: Box): boolean {
    const center = centerOf(handle);
    return center.x >= box.right && center.y > box.top + 2 && center.y < box.bottom - 2;
}

// 兄弟の + の置き場: 中心が箱の下の辺から下にあり、横の中心が箱の左右の範囲に入る
function siblingPlaced(handle: Box, box: Box): boolean {
    const center = centerOf(handle);
    return center.y >= box.bottom && center.x >= box.left && center.x <= box.right;
}

// 2 つの矩形が重ならない (辺が触れるのはよい)
const disjoint = (a: Box, b: Box): boolean => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;

interface PlusPlacement {
    child: number;
    sibling: number;
    // 子の + が 1 つのときだけ見る
    childRight: boolean | null;
    // 兄弟の + が 1 つのときだけ見る
    siblingBelow: boolean | null;
}

async function plusPlacement(page: Page, id: number): Promise<PlusPlacement> {
    const box = await nodeBox(page, id);
    const children = await rectsOf(page, handleSelector('child'));
    const siblings = await rectsOf(page, handleSelector('sibling'));
    const [child] = children;
    const [sibling] = siblings;
    return {
        child: children.length,
        sibling: siblings.length,
        childRight: children.length === 1 && child ? childPlaced(child, box) : null,
        siblingBelow: siblings.length === 1 && sibling ? siblingPlaced(sibling, box) : null,
    };
}

// 選んだノード id の右に子の + が 1 つ、下に兄弟の + が 1 つ出るまで待つ。ルートなら兄弟の + はない
async function expectPlusAround(page: Page, id: number, message?: string): Promise<void> {
    const expected: PlusPlacement = id === ROOT ? { child: 1, sibling: 0, childRight: true, siblingBelow: null } : { child: 1, sibling: 1, childRight: true, siblingBelow: true };
    await expect.poll(() => plusPlacement(page, id), message).toEqual(expected);
}

// + のつまみを押す
async function pressPlus(page: Page, kind: 'child' | 'sibling'): Promise<void> {
    await expect(visible(page, handleSelector(kind))).toHaveCount(1);
    await press(page, await spot(page, { on: 'element', selector: handleSelector(kind) }));
}

test.describe('H / V のキー (B-080、B-084、5.2 の軸 B、10.1 の 1)', () => {
    test('@editor H で手のひら、V で選択の道具に替わる。押された状態、.markdag の data-editor-tool、図の dragToPan が替わり、同じキーをもう 1 度押しても変わらない。原文、onChange、履歴は変わらない (B-080)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        // フォーカスを図の要素に置く (道具箱のボタンを押すと、フォーカスは図の要素に戻る)。最初の道具は選択なので、手のひらから始める
        await toolButton(page, 'hand').click();
        await expect.poll(() => focusOf(page)).toBe('#a');
        await expect.poll(() => toolState(page)).toEqual(HAND);

        const steps: Array<{ key: string; state: ToolState }> = [
            { key: 'KeyV', state: SELECT },
            { key: 'KeyV', state: SELECT },
            { key: 'KeyH', state: HAND },
            { key: 'KeyH', state: HAND },
            { key: 'KeyV', state: SELECT },
            { key: 'KeyH', state: HAND },
        ];
        for (const [index, step] of steps.entries()) {
            await page.keyboard.press(step.key);
            await expect.poll(() => toolState(page), `${index}: ${step.key}`).toEqual(step.state);
            await settle(page);
            expect(await toolState(page), `${index}: ${step.key} (そのまま)`).toEqual(step.state);
        }
        // キーで替えた道具が効く: 選択の道具では主ボタンのドラッグで図が動かず、手のひらでは動く
        await page.keyboard.press('KeyV');
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        expect(await pans(page, 'left')).toBe(false);
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        expect(await pans(page, 'left')).toBe(true);

        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        expect(errors).toEqual([]);
    });

    test('@editor キーで道具を替えたあと、フォーカスは道具箱のボタンに残らない (キーボードで道具箱のボタンへフォーカスを移してから H / V)。図の要素にフォーカスがあれば、そのまま図の要素にある (B-084、6.7)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        const cases: Array<{ focus: string; key: string; state: ToolState }> = [
            { focus: 'hand', key: 'KeyV', state: SELECT },
            { focus: 'select', key: 'KeyH', state: HAND },
            { focus: 'fit', key: 'KeyV', state: SELECT },
            { focus: 'join', key: 'KeyH', state: HAND },
        ];
        for (const item of cases) {
            await toolButton(page, item.focus).focus();
            expect(await focusOf(page), item.focus).toBe(`tool:${item.focus}`);
            await page.keyboard.press(item.key);
            await expect.poll(() => toolState(page), `${item.focus} ${item.key}`).toEqual(item.state);
            await expect.poll(() => focusOf(page), `${item.focus} ${item.key}`).not.toMatch(/^tool:/);
            expect(['#a', 'body'], `${item.focus} ${item.key}`).toContain(await focusOf(page));
        }

        await toolButton(page, 'hand').click();
        await expect.poll(() => focusOf(page)).toBe('#a');
        await page.keyboard.press('KeyV');
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await settle(page);
        expect(await focusOf(page)).toBe('#a');
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        await settle(page);
        expect(await focusOf(page)).toBe('#a');
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor フォーカスがどこにもなくても、ポインタが図の上にあれば H / V が効く。ポインタが図の外なら効かない。同じページの 2 つの editor は、ポインタの上の図だけが替わる (1.2)', async ({ page }) => {
        await open(page);
        await mount(page, DOC, 'a');
        await mount(page, DOC, 'b');
        // 最初の道具は選択なので、2 つとも手のひらから始める
        await useHandTool(page, 'a');
        await useHandTool(page, 'b');
        await blurAll(page);
        expect(await focusOf(page)).toBe('body');

        await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
        await page.keyboard.press('KeyV');
        await settle(page);
        expect(await toolState(page, 'a'), 'ポインタが図の外').toEqual(HAND);
        expect(await toolState(page, 'b'), 'ポインタが図の外').toEqual(HAND);

        await pointerOverBlank(page, 'a');
        await page.keyboard.press('KeyV');
        await expect.poll(() => toolState(page, 'a')).toEqual(SELECT);
        await settle(page);
        expect(await toolState(page, 'b')).toEqual(HAND);

        // キーのあとにフォーカスを図の要素へ移すかは決めていないので、押す前にフォーカスをどこにもない状態に戻す
        await blurAll(page);
        await page.mouse.move(OVER_B.x, OVER_B.y);
        await page.keyboard.press('KeyV');
        await expect.poll(() => toolState(page, 'b')).toEqual(SELECT);
        await blurAll(page);
        await page.mouse.move(OVER_B.x, OVER_B.y);
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page, 'b')).toEqual(HAND);
        await settle(page);
        expect(await toolState(page, 'a')).toEqual(SELECT);

        await blurAll(page);
        await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
        await page.keyboard.press('KeyV');
        await settle(page);
        expect(await toolState(page, 'a'), 'ポインタが図の外').toEqual(SELECT);
        expect(await toolState(page, 'b'), 'ポインタが図の外').toEqual(HAND);
        expect(await changeLog(page, 'a')).toEqual([]);
        expect(await changeLog(page, 'b')).toEqual([]);
    });

    test('@editor 文字を打つ要素の中の H と V は文字になり、道具は替わらない (ページの textarea と、図の名前の入力) (1.2、B-037)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await addSourceField(page);
        // 最初の道具は選択なので、手のひらから始める
        await useHandTool(page);

        // 手のひらのまま、図の外の textarea で v と h を打つ (ポインタは図の上)
        await page.locator('#source').click();
        expect(await focusOf(page)).toBe('#source');
        await pointerOverBlank(page);
        // 1 つ押すたびに見る (H と V を続けて押すと、両方が道具を替えても元に戻って見分けられないため)
        await page.keyboard.press('KeyV');
        await settle(page);
        expect(await toolState(page), 'textarea の V').toEqual(HAND);
        await page.keyboard.press('KeyH');
        await settle(page);
        expect(await fieldValue(page)).toBe('vh');
        expect(await focusOf(page)).toBe('#source');
        expect(await toolState(page), 'textarea の H').toEqual(HAND);

        // 選択の道具で、名前の入力に h と v を打つ
        await useSelectTool(page);
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, { value: 'Task B' });
        await page.keyboard.press('ControlOrMeta+KeyA');
        await page.keyboard.press('KeyH');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('h');
        await settle(page);
        expect(await toolState(page), '名前の入力の H').toEqual(SELECT);
        await page.keyboard.press('KeyV');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('hv');
        await settle(page);
        expect(await toolState(page), '名前の入力の V').toEqual(SELECT);
        expect((await nameInputOf(page)).focused).toBe(true);

        // 変えずに閉じる
        await page.keyboard.press('Escape');
        await expectNameInputClosed(page);
        await expectSourceStill(page, DOC, []);
        expect(await toolState(page)).toEqual(SELECT);

        // 空振りの防ぎ: 文字を打つ要素の外では、同じ図で H が効く
        await blurAll(page);
        await pointerOverBlank(page);
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        expect(await fieldValue(page)).toBe('vh');
    });

    test('@editor 閲覧では H と V が効かない: 閲覧だけの文書と、GUI 編集から切り替えた閲覧で、data-editor-tool も data-drag-to-pan も付かず、主ボタンのドラッグで図が動く。GUI 編集へ戻ると最初の道具 (選択) で、H が効く (B-169、B-171、触る F-04)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_VIEW);
        await blurAll(page);
        await pointerOverBlank(page);
        for (const key of ['KeyV', 'KeyH', 'KeyV']) await page.keyboard.press(key);
        await settle(page);
        expect(await toolMarks(page), '閲覧だけの文書').toEqual({ tool: null, pan: null });
        expect(await pans(page, 'left'), '閲覧だけの文書').toBe(true);

        await remount(page, DOC_SWITCH);
        // 最初の道具 (選択) でない手のひらにしてから閲覧へ
        await toolButton(page, 'select').click();
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        await segmentButton(page, 'view').click();
        await expect.poll(() => toolMarks(page)).toEqual({ tool: null, pan: null });

        await blurAll(page);
        await pointerOverBlank(page);
        await page.keyboard.press('KeyV');
        await settle(page);
        expect(await toolMarks(page), '切り替えた閲覧').toEqual({ tool: null, pan: null });
        expect(await pans(page, 'left'), '切り替えた閲覧').toBe(true);

        await segmentButton(page, 'edit').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await blurAll(page);
        await pointerOverBlank(page);
        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        expect(await changeLog(page)).toEqual([]);
    });
});

test.describe('子と兄弟を足す + のつまみ (B-020、10.1 の 1、6.3、6.5)', () => {
    test('@editor 選択の道具でノードを 1 つ選ぶと、子の + (data-handle="child") がノードの右 (縦の中央) に 1 つ、兄弟の + (data-handle="sibling") がノードの下に 1 つ出る。選ぶノードを替えるとつまみも移り、拡大縮小しても位置の関係は保つ。原文は変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await expectNoPlus(page, '何も選んでいない');

        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectPlusAround(page, TASK_A, 'Task A');

        // 矢印キーで選び直しても追う
        await page.keyboard.press('ArrowDown');
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await expectPlusAround(page, TASK_B, 'Task B');

        await pressNode(page, DESIGN);
        await expectSelection(page, [target(DESIGN, 'Design')]);
        await expectPlusAround(page, DESIGN, 'Design');

        const before = await transformOf(page);
        await pointerOverBlank(page);
        await page.mouse.wheel(0, -200);
        await expect.poll(async () => (await transformOf(page)).k).not.toBe(before.k);
        await expectPlusAround(page, DESIGN, '拡大したあと');

        await expectSourceStill(page, DOC, []);
        expect(errors).toEqual([]);
    });

    test('@editor 子の + と線を引く点は、どちらも選んだノードの右にあり、矩形が重ならない (6.5、G-001。並べ方は決めていない)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const [id, label] of [
            [TASK_A, 'Task A'],
            [DESIGN, 'Design'],
            [LEAF, 'Leaf'],
        ] as const) {
            await pressNode(page, id);
            await expectSelection(page, [target(id, label)], label);
            await expectPlusAround(page, id, label);
            await expect(visible(page, handleSelector('link')), label).toHaveCount(1);
            await expect
                .poll(async () => {
                    const box = await nodeBox(page, id);
                    const [child] = await rectsOf(page, handleSelector('child'));
                    const [link] = await rectsOf(page, handleSelector('link'));
                    if (!child || !link) return 'つまみか点がない';
                    return { linkRight: centerOf(link).x >= box.right - 4, apart: disjoint(child, link) };
                }, label)
                .toEqual({ linkRight: true, apart: true });
        }
    });

    test('@editor ルートを選ぶと子の + だけが出て、兄弟の + は出ない。子の + を押すと、ルートに最後の子の見出しの形の子を足して、名前の入力を開く (B-020、B-012、B-014)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, ROOT);
        await expectSelection(page, [target(ROOT, 'Root')]);
        await expectPlusAround(page, ROOT);
        await settle(page);
        expect(await plusCounts(page)).toEqual({ child: 1, sibling: 0 });

        // 空振りの防ぎ: ルートでないノードには兄弟の + が出る
        await pressNode(page, TASK_A);
        await expectPlusAround(page, TASK_A);

        await pressNode(page, ROOT);
        await expectPlusAround(page, ROOT);
        await pressPlus(page, 'child');
        const added = docWith(EDIT, BODY_ROOT_CHILD);
        await expectSource(page, added, [added]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(labelOf(page, 7)).toHaveText(NEW);
        await expectSelection(page, [target(7, NEW)]);
        await expectNameInputOn(page, 7, { value: NEW, allSelected: true });
    });

    test('@editor 子の + を押すと、選んだノードに子を足し (Tab と同じ原文)、足したノードを選んで「新しいノード」を全部選んだ名前の入力をそのラベルの上に開く。onChange 1 回、結果の通知 (info)。足したばかりの入力を Esc でやめると足す前に戻る (B-020、B-014、B-025、B-031)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectPlusAround(page, TASK_A);
        await expect(snackbars(page)).toHaveCount(0);

        await pressPlus(page, 'child');
        const added = docWith(EDIT, BODY_A_CHILD);
        await expectSource(page, added, [added]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(labelOf(page, 4)).toHaveText(NEW);
        await expectSelection(page, [target(4, NEW)]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
        await expectNotice(page, 'info');
        expect(await toolState(page)).toEqual(SELECT);

        await page.keyboard.press('Escape');
        await expectSource(page, DOC, [added, DOC]);
        await expectNameInputClosed(page);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        expect(errors).toEqual([]);
    });

    test('@editor 兄弟の + を押すと、自分のすぐあとに同じ形の兄弟を足し、足したノードを選んで「新しいノード」を全部選んだ名前の入力をそのラベルの上に開く。onChange 1 回、結果の通知 (info) (B-020、B-015、B-025)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectPlusAround(page, TASK_A);

        await pressPlus(page, 'sibling');
        const added = docWith(EDIT, BODY_A_SIBLING);
        await expectSource(page, added, [added]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(labelOf(page, 4)).toHaveText(NEW);
        await expectSelection(page, [target(4, NEW)]);
        await expectNameInputOn(page, 4, { value: NEW, allSelected: true });
        await expectNotice(page, 'info');
    });

    test('@editor 手のひらの道具でノードを選んでも + のつまみは出ない。V で選択の道具に替えると選んだノードに出て、H で手のひらに戻すと消える。選択はそのまま (B-020、B-080、B-076)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、手のひらにする
        await useHandTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectNoPlus(page, '手のひら');

        await page.keyboard.press('KeyV');
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await expectPlusAround(page, TASK_A, 'V');
        await expectSelection(page, [target(TASK_A, 'Task A')], 'V');

        await page.keyboard.press('KeyH');
        await expect.poll(() => toolState(page)).toEqual(HAND);
        await expect.poll(() => plusCounts(page), 'H').toEqual(NO_PLUS);
        await expectSelection(page, [target(TASK_A, 'Task A')], 'H');

        await toolButton(page, 'select').click();
        await expectPlusAround(page, TASK_A, '道具箱の選択');
        await expectSourceStill(page, DOC, []);
    });

    test('@editor + のつまみはノードを 1 つ選んでいるときだけ出る: 2 つ以上を選んだとき、選択を解いたとき、線を選んだときは出ない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectPlusAround(page, TASK_A);

        await pressNodeWith(page, LEAF, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(LEAF, 'Leaf')]);
        await expect.poll(() => plusCounts(page), '2 つ').toEqual(NO_PLUS);

        await page.keyboard.press('Escape');
        await expectSelection(page, []);
        await expectNoPlus(page, '選択を解いた');

        // 木の線 (Design から Task A) を押して線を選ぶ
        await press(page, await edgeSpot(page, `tree:${DESIGN}>${TASK_A}`));
        await expect.poll(async () => (await selectionOf(page)).selected).toBe('edge');
        await expectNoPlus(page, '線');

        await pressNode(page, TASK_B);
        await expectPlusAround(page, TASK_B, '空振りの防ぎ');
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 閲覧では + のつまみが出ない: 閲覧だけの文書でノードを押しても出ず、GUI 編集でつまみを出してから閲覧へ切り替えると消える。GUI 編集へ戻っても (最初の道具の選択に戻る) 出ない (B-169、B-171、触る F-04)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_VIEW);
        await pressNode(page, TASK_A);
        await expectNoPlus(page, '閲覧だけの文書');
        await expect(visible(page, '#a .mdag-editor-handle')).toHaveCount(0);

        await remount(page, DOC_SWITCH);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectPlusAround(page, TASK_A, '切り替える前');
        await segmentButton(page, 'view').click();
        await expect.poll(() => plusCounts(page), '切り替えた閲覧').toEqual(NO_PLUS);
        await pressNode(page, TASK_B);
        await expectNoPlus(page, '切り替えた閲覧でノードを押す');

        await segmentButton(page, 'edit').click();
        await expect.poll(() => toolState(page)).toEqual(SELECT);
        await expectNoPlus(page, 'GUI 編集へ戻った');
        await expectSourceStill(page, DOC_SWITCH, []);
    });
});

test.describe('入れないキー (10.1 の 1)', () => {
    test('@editor F2 と F は何もしない: 選択の道具でノードを選んで + のつまみが出ているときも、名前の入力は開かず、表示位置、原文、選択、つまみは変わらず、通知も出ない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectPlusAround(page, TASK_A);

        // F でズームリセットされたら分かるように、全体が収まる位置から動かしておく (選択の道具の中ボタンのドラッグ)
        const fitted = await transformOf(page);
        expect(await pans(page, 'middle')).toBe(true);
        await settle(page);
        const moved = await transformOf(page);
        expect(sameTransform(moved, fitted)).toBe(false);
        await expect(snackbars(page)).toHaveCount(0);

        for (const key of ['F2', 'KeyF', 'Shift+KeyF']) {
            await page.keyboard.press(key);
            await settle(page);
            expect((await nameInputOf(page)).count, key).toBe(0);
            expect(sameTransform(await transformOf(page), moved), key).toBe(true);
            expect(await toolState(page), key).toEqual(SELECT);
        }
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectPlusAround(page, TASK_A);
        await expect(snackbars(page)).toHaveCount(0);
        await expectSourceStill(page, DOC, []);
        expect(await nodeCount(page)).toBe(6);
    });
});

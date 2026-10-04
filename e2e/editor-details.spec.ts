// GUI 編集の詳細 (詳細の入力と詳細表示の選択肢) を、ビルドした配布物の markdag/editor で確かめる。
// 詳細の読み方と書き方 (項目の直下の引用。見出しは詳細を持てない)、markdag: を足す書き換え、詳細の入力のキー (変換中のキーは操作にしない)、
// 閲覧へ切り替えるときと外からの差し替えのときの入力の片付け、詳細の入力の置き場 (right、bottom、top の順で図の領域に収まる最初のもの)、
// 詳細表示の選択肢 (道具箱のボタンの右)、ボタンを押したあとのフォーカス、図の詳細の見せ方 (ViewOptions.details と popover) を見る。
// 見た目そのもの (色、余白、影、テキストエリアの大きさ) は見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、選択 (data-selected と getSelection)、
// 詳細の入力の有無、値、フォーカス、置き場の向き (ノードの箱との位置の関係)、詳細表示の選択肢の有無と置き場、図の詳細の見せ方
// (図の要素とノードの data-details、ノードの中の詳細が見えるか)、通知 (.mdag-editor-snackbar と data-kind)、元に戻すを見る。
// 期待の原文は詳細の書き方と markdag: を足す規則から書いた。配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, EditSelection, NodeTarget } from '../src/core';
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
};

const DIST = resolve('dist');

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];
const SWITCH_VIEW = ['mode: switch', 'default: view'];
const VIEW = ['mode: view'];

type DetailsMode = 'always' | 'hover' | 'click';

// 詳細表示の選択肢の並びと名前 (隠す = i を押したときだけ)
const DETAILS_OPTIONS: ReadonlyArray<{ mode: DetailsMode; label: string }> = [
    { mode: 'always', label: '常に表示' },
    { mode: 'hover', label: 'ホバー時に表示' },
    { mode: 'click', label: '隠す' },
];

// markdag.editor を書いた文書。markdag の行は markdag の下の字下げ (4 桁) から、editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く
function docWith(editor: string[], body: string[], markdag: string[] = []): string {
    return ['---', 'markdag:', ...markdag.map((line) => `    ${line}`), '    editor:', ...editor.map((line) => `        ${line}`), '---', '', ...body].join('\n');
}

// 文書の詳細の見せ方 (markdag.details.display)
const display = (mode: DetailsMode): string[] => ['details:', `    display: ${mode}`];

// Design の下の項目だけを替えた本文。ノードは Root 1、Design 2、項目 (3 から文書の順)、Build、Leaf
function designBody(items: string[]): string[] {
    return ['# Root', '', '## Design', '', ...items, '', '## Build', '', '- Leaf', ''];
}

// Task A は詳細 (引用ブロック。複数行と空行と強調) を持つ。Task B は詳細を持たない
const TASK_A_LINES = ['- Task A', '    > 1 行目', '    >', '    > **3** 行目'];
// Task A の詳細を詳細の読み方で読んだもの (行頭の字下げと > と後ろの空白 1 つを外し、\n でつなぐ)
const DETAILS_A = '1 行目\n\n**3** 行目';

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = designBody([...TASK_A_LINES, '- Task B']);
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Build', 6: 'Leaf' };

const DOC = docWith(EDIT, BODY);

// Task A の詳細を置き換えた本文 (入力の行ごとに子の項目の字下げ (4) と「> 」、空の行は「>」だけ)
const NEW_A = '変えた 1 行目\n\n2 段落目';
const BODY_A_REPLACED = designBody(['- Task A', '    > 変えた 1 行目', '    >', '    > 2 段落目', '- Task B']);
// 詳細のない Task B に詳細を足した本文 (1 行目のあと、次の兄弟の前)
const BODY_B_ADDED = (text: string): string[] => designBody([...TASK_A_LINES, '- Task B', `    > ${text}`]);
// そのあと Task A の詳細を空にして外した本文
const BODY_B_ADDED_A_CLEARED = designBody(['- Task A', '- Task B', '    > 新しい詳細']);

// 本文の Leaf だけを変えた文書 (外からの差し替えに使う)
const DOC_OTHER = docWith(EDIT, designBody([...TASK_A_LINES, '- Task B']).map((line) => (line === '- Leaf' ? '- Leaf 2' : line)));

// 詳細を書けないノード。行を持たないルート (title だけ)、リストだけの文書のルートの容器、表
const DOC_LINELESS = ['---', 'title: T', 'markdag:', '    editor:', '        mode: edit', '---', '- a', '', '1. b', ''].join('\n');
const DOC_LIST_ROOT = ['---', 'title: 手順', 'markdag:', '    editor:', '        mode: edit', '---', '- 設計', '- 実装', ''].join('\n');
const DOC_TABLE = docWith(EDIT, ['# R', '', '## T', '', '| x | y |', '| - | - |', '| 1 | 2 |', '', '## U', '', '- u', '']);

// 怠惰な続きの行 (> のない行が引用の続きとして読まれる) を含む詳細。続きの行も詳細として読み、書き換えると詳細の行を全部 > 付きで書き直す (D-037)
const DOC_LAZY = docWith(EDIT, designBody(['- Task A', '    > 1 行目', '    続き', '- Task B']));
const DETAILS_LAZY = '1 行目\n続き';
const DOC_LAZY_FIXED = docWith(EDIT, designBody(['- Task A', '    > 直した', '- Task B']));

// markdag キーのない文書。frontmatter はあるが markdag キーがないもの、frontmatter がないもの。ノードは R 1、a 2
const DOC_NO_MARKDAG = ['---', 'title: T', '---', '# R', '', '- a', ''].join('\n');
const DOC_NO_MARKDAG_DETAILS = ['---', 'title: T', 'markdag:', '---', '# R', '', '- a', '    > d', ''].join('\n');
const DOC_NO_FRONTMATTER = ['# R', '', '- a', ''].join('\n');
const DOC_NO_FRONTMATTER_DETAILS = ['---', 'markdag:', '---', '', '# R', '', '- a', '    > d', ''].join('\n');

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

interface MountSpec {
    // mount の mode (省くと文書の markdag.editor に従う)
    mode?: 'view' | 'edit' | 'switch';
}

async function mount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    await page.evaluate(
        ({ markdown, mode }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.changes.push({ root: 'a', markdown: next });
                },
                onSelectionChange: (selection) => {
                    target.selections.push({ root: 'a', selection: JSON.parse(JSON.stringify(selection)) as EditSelection });
                },
            };
            if (mode !== null) options.mode = mode;
            target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, mode: spec.mode ?? null },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知、詳細の見せ方の選択を初めの状態に戻す)。onChange と onSelectionChange の記録も空にする
async function remount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
        target.selections = [];
    });
    await mount(page, markdown, spec);
}

// 「変わらない」「呼ばれない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const setSource = (page: Page, markdown: string): Promise<void> => page.evaluate((markdown) => void (window as unknown as EditorWindow).editors.a?.setSource(markdown), markdown);

const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());

const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const callUndo = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo());

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const DETAILS_TOOL = '#a .mdag-editor-tool[data-tool="details"]';

// フォーカスのある所 (#a は図の要素、#source は図の外の欄、body はどこにもない。ほかは要素の名前)
const focusOf = (page: Page): Promise<string> =>
    page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        if (active.id === 'a' || active.id === 'source') return `#${active.id}`;
        return active.tagName.toLowerCase();
    });

async function useTool(page: Page, tool: 'hand' | 'select'): Promise<void> {
    await toolButton(page, tool).click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', tool);
}

// 図の外の欄 (アプリの原文の欄の代わり) へフォーカスを移す。図の右の空いた所に置き、図とは重ねない
async function focusOutside(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('source')) return;
        const field = document.createElement('textarea');
        field.id = 'source';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
    await page.locator('#source').click();
    await expect.poll(() => focusOf(page)).toBe('#source');
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

async function nodeBox(page: Page, id: number): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
    if (!box) throw new Error(`ノード ${id} の箱がない`);
    return box;
}

// 図の領域 (重ねた要素の置き場の基準) の矩形
async function areaBox(page: Page): Promise<Box> {
    const [area] = await rectsOf(page, '#a > .mdag-viewport');
    if (!area) throw new Error('図の領域がない');
    return area;
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
            grid(rect, Math.max(1, Math.min(rect.width, rect.height) / 8)).find((point) => {
                const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                return hit !== null && element.contains(hit);
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

async function doubleClick(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.dblclick(point.x, point.y);
}

// ノードの箱を押す (手のひらでも選択の道具でもノードを選ぶ)
async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

async function pressBlank(page: Page): Promise<void> {
    await press(page, await spot(page, { on: 'blank' }));
}

async function pointerOverBlank(page: Page): Promise<void> {
    const blank = await spot(page, { on: 'blank' });
    await page.mouse.move(blank.x, blank.y);
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

// 帯のボタンが 1 つ見えていて、押せない (disabled か aria-disabled)
async function expectBarDisabled(page: Page, command: string, message?: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector), message).toHaveCount(1);
    await expect
        .poll(
            () =>
                page.evaluate((selector) => {
                    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) => item.checkVisibility());
                    return button !== undefined && (button.disabled || button.getAttribute('aria-disabled') === 'true');
                }, selector),
            message,
        )
        .toBe(true);
}

const target = (id: number): NodeTarget => ({ id, refText: REF_TEXTS[id] ?? '' });

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
    const selected =
        selection.kind === 'nodes'
            ? [...selection.nodes].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }))
            : selection.kind === 'none'
              ? []
              : selection.kind;
    return { marked: state.marked, selected };
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方。getSelection は id と refText)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = [...targets].sort((a, b) => a.id - b.id);
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
}

// 選択を解く (Esc)。選んだノードの帯がほかのノードに重なって押せなくなるのを避ける
async function clearSelection(page: Page, message?: string): Promise<void> {
    await page.keyboard.press('Escape');
    await expectSelection(page, [], message);
}

interface DetailsEditorState {
    // 見えている詳細の入力 (.mdag-editor-details-editor) の数
    count: number;
    // 中のテキストエリアの値 (1 つのときだけ)
    value: string | null;
    // フォーカスがテキストエリアにある
    focused: boolean;
    // 詳細の入力の要素の矩形
    rect: Box | null;
}

// 詳細の入力。要素そのものがテキストエリアでも、その中にテキストエリアがあってもよい (詳細の入力は textarea と保存、やめるのボタンの入れ物)
async function detailsEditorOf(page: Page): Promise<DetailsEditorState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const shown = [...container.querySelectorAll('.mdag-editor-details-editor')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false, rect: null };
        const outer = element.getBoundingClientRect();
        const rect = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
        const field = element instanceof HTMLTextAreaElement ? element : element.querySelector('textarea');
        if (!field) return { count: 1, value: null, focused: false, rect };
        return { count: 1, value: field.value, focused: document.activeElement === field, rect };
    });
}

// 詳細の入力が 1 つ開き、テキストエリアの値が value で、フォーカスがテキストエリアにあるまで待つ
async function expectDetailsEditor(page: Page, value: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await detailsEditorOf(page);
            return { count: state.count, value: state.value, focused: state.focused };
        }, message)
        .toEqual({ count: 1, value, focused: true });
}

// 詳細の入力が閉じるまで待つ
async function expectDetailsEditorClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await detailsEditorOf(page)).count, message).toBe(0);
}

// 詳細の入力が開いていない (数コマ待ってから)
async function expectNoDetailsEditor(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await detailsEditorOf(page)).count, message).toBe(0);
}

// 名前の入力 (ノード) が開いていない (数コマ待ってから)
async function expectNoNameInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect(await page.locator('#a .mdag-editor-name-input[data-for="node"]').filter({ visible: true }).count(), message).toBe(0);
}

// テキストエリアの値を全部選んで text を打つ (改行は Enter で打つ。テキストエリアの Enter は改行)
async function replaceDetails(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await expect.poll(async () => (await detailsEditorOf(page)).value).toBe(text);
}

// 詳細の入力の中のボタン (保存、やめる) を押す。ボタンは文字か aria-label で探す
async function pressEditorButton(page: Page, name: '保存' | 'やめる'): Promise<void> {
    const point = await page.evaluate((name) => {
        const editor = [...document.querySelectorAll('#a .mdag-editor-details-editor')].find((element) => element.checkVisibility());
        if (!editor) return null;
        const button = [...editor.querySelectorAll('button')].find(
            (item) => item.checkVisibility() && ((item.textContent ?? '').replace(/\s+/g, '').includes(name) || (item.getAttribute('aria-label') ?? '').includes(name)),
        );
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        for (const [fx, fy] of [
            [0.5, 0.5],
            [0.3, 0.5],
            [0.7, 0.5],
        ] as const) {
            const x = rect.left + rect.width * fx;
            const y = rect.top + rect.height * fy;
            const hit = document.elementFromPoint(x, y);
            if (hit && button.contains(hit)) return { x, y };
        }
        return null;
    }, name);
    if (!point) throw new Error(`詳細の入力に「${name}」のボタンがない`);
    await press(page, point);
}

type Place = 'right' | 'bottom' | 'top' | 'other';

// 詳細の入力がノードの箱のどちら側にあるか。右: 箱の右の辺より右で上下が重なる。下: 箱の下の辺より下で左右が重なる。上: 箱の上の辺より上で左右が重なる
function placeOf(editor: Box, box: Box): Place {
    const horizontal = editor.left < box.right && editor.right > box.left;
    const vertical = editor.top < box.bottom && editor.bottom > box.top;
    if (editor.left >= box.right - 1 && vertical) return 'right';
    if (editor.top >= box.bottom - 1 && horizontal) return 'bottom';
    if (editor.bottom <= box.top + 1 && horizontal) return 'top';
    return 'other';
}

const insideBox = (inner: Box, outer: Box): boolean => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;

// 詳細の入力が id のノードの place の側にあり、図の領域に収まるまで待つ
async function expectEditorPlaced(page: Page, id: number, place: Place, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await detailsEditorOf(page);
            if (state.rect === null) return { count: state.count };
            return { count: state.count, place: placeOf(state.rect, await nodeBox(page, id)), inside: insideBox(state.rect, await areaBox(page)) };
        }, message)
        .toEqual({ count: 1, place, inside: true });
}

interface NodeSpot {
    // ノードの箱の左の辺 (図の領域の左の辺から)、右の辺 (図の領域の左の辺から)
    left?: number;
    right?: number;
    // ノードの箱の上下の中ほど、下の辺 (図の領域の上の辺から)
    centerY?: number;
    bottom?: number;
}

// 図をパンして、ノードの箱を図の領域の決まった位置に置く (倍率は変えない)
async function moveNodeTo(page: Page, id: number, want: NodeSpot): Promise<void> {
    const area = await areaBox(page);
    const box = await nodeBox(page, id);
    const dx = want.left !== undefined ? area.left + want.left - box.left : want.right !== undefined ? area.left + want.right - box.right : 0;
    const dy = want.centerY !== undefined ? area.top + want.centerY - (box.top + box.bottom) / 2 : want.bottom !== undefined ? area.top + want.bottom - box.bottom : 0;
    await page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });
    await settle(page);
    const moved = await nodeBox(page, id);
    if (want.left !== undefined) expect(Math.abs(moved.left - (area.left + want.left))).toBeLessThan(2);
    if (want.right !== undefined) expect(Math.abs(moved.right - (area.left + want.right))).toBeLessThan(2);
    if (want.centerY !== undefined) expect(Math.abs((moved.top + moved.bottom) / 2 - (area.top + want.centerY))).toBeLessThan(2);
    if (want.bottom !== undefined) expect(Math.abs(moved.bottom - (area.top + want.bottom))).toBeLessThan(2);
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

// 変換中のキー。Chromium の IME と同じく keyCode 229 で送る (Input.imeSetComposition で変換を始めていれば isComposing も true)。
// modifiers は CDP の値 (Ctrl 2、Meta 4)
async function pressComposing(client: CDPSession, key: 'Enter' | 'Escape', modifiers = 0): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229, modifiers };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
const CTRL = 2;
const META = 4;

// 配布物の editSource で同じ書き換えを試す (期待の原文と断る理由の文を確かめる。期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

const setDetailsOp = (id: number, text: string, refText = REF_TEXTS[id] ?? ''): EditOp => ({ kind: 'setDetails', node: { id, refText }, text });

// 描いている文書の原文で、ノードの原文の事実を読む (期待の空振りの防ぎ)
async function factsOf(page: Page, id: number): Promise<{ kind: string; canHaveDetails: boolean; details: string | null } | null> {
    return page.evaluate((id) => {
        const target = window as unknown as EditorWindow;
        const editor = target.editors.a;
        const node = editor?.view.getDocument()?.parsed.nodes.find((entry) => entry.id === id);
        if (!editor || !node) return null;
        const facts = target.editorHarness.core.inspectNode(editor.getSource(), { id: node.id, refText: node.refText });
        return facts === null ? null : { kind: facts.kind, canHaveDetails: facts.canHaveDetails, details: facts.details };
    }, id);
}

interface DetailsLook {
    // 図の要素の data-details (図の詳細の見せ方)
    diagram: string | null;
    // Task A の要素の data-details
    node: string | null;
    // Task A の中の詳細 (.mdag-content の中の .mdag-details) が見えているか
    inNode: boolean;
}

// 図の詳細の見せ方 (ViewOptions.details を図が data-details で示す。詳細を持つノード (Task A) の中に詳細が開いているか)
async function detailsLookOf(page: Page, id = TASK_A): Promise<DetailsLook> {
    return page.evaluate((id) => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const node = container.querySelector(`.mdag-node[data-id="${id}"]`);
        const inside = node?.querySelector('.mdag-content .mdag-details');
        return { diagram: container.getAttribute('data-details'), node: node?.getAttribute('data-details') ?? null, inNode: inside instanceof Element && inside.checkVisibility() };
    }, id);
}

const lookFor = (mode: DetailsMode): DetailsLook => ({ diagram: mode, node: mode, inNode: mode === 'always' });

interface FlyoutState {
    // 見えている詳細表示の選択肢 (.mdag-editor-flyout) の数
    count: number;
    // 選択肢の data-details と文字 (並びの順)
    options: Array<{ mode: string | null; text: string }>;
    // 選択肢の矩形と、道具箱の「詳細表示」のボタンの矩形
    rect: Box | null;
    button: Box | null;
}

async function flyoutOf(page: Page): Promise<FlyoutState> {
    return page.evaluate((toolSelector) => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const box = (element: Element | null | undefined): { left: number; top: number; right: number; bottom: number } | null => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        const tool = document.querySelector(toolSelector);
        const shown = [...container.querySelectorAll('.mdag-editor-flyout')].filter((element) => element.checkVisibility());
        const flyout = shown[0];
        if (shown.length !== 1 || !flyout) return { count: shown.length, options: [], rect: null, button: box(tool) };
        const options = [...flyout.querySelectorAll('[data-details]')]
            .filter((element) => element.checkVisibility())
            .map((element) => ({ mode: element.getAttribute('data-details'), text: (element.textContent ?? '').replace(/\s+/g, ' ').trim() }));
        return { count: 1, options, rect: box(flyout), button: box(tool) };
    }, DETAILS_TOOL);
}

const flyoutCount = async (page: Page): Promise<number> => (await flyoutOf(page)).count;

// 詳細表示の選択肢が開いていて、道具箱の「詳細表示」のボタンの右にあり (左の辺がボタンの右の辺より右で、上下が重なる)、
// 選択肢が 常に表示、ホバー時に表示、隠す の順に並ぶまで待つ
async function expectFlyoutOpen(page: Page, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await flyoutOf(page);
            const { rect, button } = state;
            const right = rect !== null && button !== null && rect.left >= button.right - 1 && rect.top < button.bottom && rect.bottom > button.top;
            return {
                count: state.count,
                modes: state.options.map((option) => option.mode),
                labelled: state.options.every((option, index) => option.text.includes(DETAILS_OPTIONS[index]?.label ?? '\u0000')),
                right,
            };
        }, message)
        .toEqual({ count: 1, modes: DETAILS_OPTIONS.map((option) => option.mode), labelled: true, right: true });
}

// 詳細表示の選択肢が閉じるまで待つ (ポインタで開いたものは離れて少し待ってから閉じるので、5 秒まで待つ)
async function expectFlyoutClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(() => flyoutCount(page), { message, timeout: 5_000 }).toBe(0);
}

// 道具箱の「詳細表示」にポインタを乗せて選択肢を開き、選択肢の上へ動かして mode を押す。図の見せ方が替わるのを待ち、
// ポインタを何もないところへ離して選択肢が閉じるのを待つ
async function chooseDetails(page: Page, mode: DetailsMode): Promise<void> {
    const button = await spot(page, { on: 'element', selector: DETAILS_TOOL });
    await page.mouse.move(button.x, button.y);
    await expectFlyoutOpen(page, `${mode} を選ぶ前`);
    const option = await spot(page, { on: 'element', selector: `#a .mdag-editor-flyout [data-details="${mode}"]` });
    await page.mouse.move(option.x, option.y, { steps: 8 });
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(async () => (await detailsLookOf(page)).diagram, `${mode} を選ぶ`).toBe(mode);
    await pointerOverBlank(page);
    await expectFlyoutClosed(page, `${mode} を選んだあと`);
}

test.describe('詳細の入力を開く (段 20。B-043、B-117、B-118、3.5、3.8、6.3)', () => {
    test('@editor 帯の「詳細編集」と D で、選んだノードの詳細の入力 (.mdag-editor-details-editor) が開き、テキストエリアに書いてある詳細が行頭の > を外して入る (複数行と空行も)。詳細のない項目では空。フォーカスはテキストエリアにあり、開いても原文は変わらない (B-043、B-117、B-118)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        // 空振りの防ぎ: Task A は詳細を持ち、Task B は持たない
        expect(await factsOf(page, TASK_A)).toEqual({ kind: 'item', canHaveDetails: true, details: DETAILS_A });
        expect(await factsOf(page, TASK_B)).toEqual({ kind: 'item', canHaveDetails: true, details: null });
        await expectNoDetailsEditor(page, 'mount のあと');

        for (const trigger of ['帯の詳細編集', 'D'] as const) {
            for (const [id, value] of [
                [TASK_A, DETAILS_A],
                [TASK_B, ''],
            ] as const) {
                const message = `${trigger} (${REF_TEXTS[id]})`;
                await pressNode(page, id);
                await expectSelection(page, [target(id)], message);
                if (trigger === 'D') await page.keyboard.press('d');
                else await pressBar(page, 'details');
                await expectDetailsEditor(page, value, message);
                await expectSelection(page, [target(id)], message);
                await page.keyboard.press('Escape');
                await expectDetailsEditorClosed(page, message);
                await clearSelection(page, message);
            }
        }
        await expectSourceStill(page, DOC, []);
        expect(errors).toEqual([]);
    });

    test('@editor 詳細の入力はノードの右に出る。右に入らなければ下、下にも入らなければ上に出る。どれも図の領域に収まる (B-117、6.5、2.3 の配列の置き方)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B)]);
        // 詳細の入力の大きさを測る (大きさそのものは見ない。置く位置を決めるのに使う)
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '');
        const measured = (await detailsEditorOf(page)).rect;
        if (!measured) throw new Error('詳細の入力の矩形がない');
        const width = measured.right - measured.left;
        const height = measured.bottom - measured.top;
        await page.keyboard.press('Escape');
        await expectDetailsEditorClosed(page);
        const area = await areaBox(page);
        const areaWidth = area.right - area.left;
        const areaHeight = area.bottom - area.top;

        // 右が空いている: 箱の左の辺を道具箱より右に置き、上下の中ほどに置く
        await moveNodeTo(page, TASK_B, { left: 200, centerY: areaHeight / 2 });
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '', '右');
        await expectEditorPlaced(page, TASK_B, 'right', '右');
        await page.keyboard.press('Escape');
        await expectDetailsEditorClosed(page, '右');

        // 右に入らない: 箱の右の辺を、図の領域の右の辺から入力の幅の半分だけ内側に置く (下に置けば左右は収まる)
        const nearRight = areaWidth - Math.max(width / 2, 30);
        await moveNodeTo(page, TASK_B, { right: nearRight, centerY: areaHeight / 2 });
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '', '下');
        await expectEditorPlaced(page, TASK_B, 'bottom', '下');
        await page.keyboard.press('Escape');
        await expectDetailsEditorClosed(page, '下');

        // 下にも入らない: さらに箱の下の辺を、図の領域の下の辺から入力の高さの半分だけ内側に置く
        await moveNodeTo(page, TASK_B, { right: nearRight, bottom: areaHeight - Math.max(height / 2, 30) });
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '', '上');
        await expectEditorPlaced(page, TASK_B, 'top', '上');
        await page.keyboard.press('Escape');
        await expectDetailsEditorClosed(page, '上');
        await expectSourceStill(page, DOC, []);
    });
});

test.describe('詳細のダブルクリック (段 20。B-049、B-050、10.2 の B-076、2.2 の onNodeDoubleClick)', () => {
    test('@editor 常に表示でノードの中に開いた詳細をダブルクリックすると、手のひらでも選択の道具でも、そのノードが選ばれて詳細の入力が開く (名前の入力は開かない)。原文は変わらない (B-049)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        let first = true;
        for (const tool of ['hand', 'select'] as const) {
            if (first) await mount(page, DOC);
            else await remount(page, DOC);
            first = false;
            await useTool(page, tool);
            await chooseDetails(page, 'always');
            await expect.poll(() => detailsLookOf(page), tool).toEqual(lookFor('always'));
            await expectSelection(page, [], tool);

            await doubleClick(page, await spot(page, { on: 'element', selector: `${nodeSelector(TASK_A)} .mdag-content .mdag-details` }));
            await expectSelection(page, [target(TASK_A)], tool);
            await expectDetailsEditor(page, DETAILS_A, tool);
            await expectNoNameInput(page, tool);
            await expectSourceStill(page, DOC, [], tool);
            await page.keyboard.press('Escape');
            await expectDetailsEditorClosed(page, tool);
        }
    });

    test('@editor 吹き出しの中の詳細をダブルクリックすると、手のひらでも選択の道具でも、その吹き出しのノードが選ばれて詳細の入力が開く (名前の入力は開かない)。原文は変わらない (B-050)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        let first = true;
        for (const tool of ['hand', 'select'] as const) {
            if (first) await mount(page, DOC);
            else await remount(page, DOC);
            first = false;
            await useTool(page, tool);
            // GUI 編集の最初の見せ方 (ホバー時に表示) では、詳細は吹き出しに出る。印の click で吹き出しを出したままにする
            await page.locator(`${nodeSelector(TASK_A)} .mdag-note-mark`).dispatchEvent('click');
            await expect(page.locator('#a .mdag-popover'), tool).toHaveAttribute('data-id', String(TASK_A));
            await expectSelection(page, [], tool);

            await doubleClick(page, await spot(page, { on: 'element', selector: '#a .mdag-popover .mdag-details > p' }));
            await expectSelection(page, [target(TASK_A)], tool);
            await expectDetailsEditor(page, DETAILS_A, tool);
            await expectNoNameInput(page, tool);
            await expectSourceStill(page, DOC, [], tool);
            await page.keyboard.press('Escape');
            await expectDetailsEditorClosed(page, tool);
        }
    });
});

test.describe('保存して閉じる (段 20。B-119、B-121〜B-123、B-003、B-004、3.4 の setDetails、3.5)', () => {
    test('@editor ⌘Enter と Ctrl+Enter で、入れた詳細を引用ブロックとして書いて閉じる (置き換え。複数行は行ごとに > を付け、空行は > だけ)。テキストエリアの Enter は改行で保存しない。onChange 1 回、ノードは選んだまま、フォーカスは図の要素、結果の通知 (info)。元に戻すで戻る (B-119、B-121、B-003、B-004)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        const replaced = docWith(EDIT, BODY_A_REPLACED);
        expect(editedSource(await tryEdit(page, DOC, setDetailsOp(TASK_A, NEW_A)))).toBe(replaced);

        let first = true;
        for (const key of ['Meta+Enter', 'Control+Enter']) {
            if (first) await mount(page, DOC);
            else await remount(page, DOC);
            first = false;
            await pressNode(page, TASK_A);
            await page.keyboard.press('d');
            await expectDetailsEditor(page, DETAILS_A, key);
            await replaceDetails(page, NEW_A);
            // 打つ途中の Enter (改行) では保存しない
            await expectSourceStill(page, DOC, [], `${key} の前`);
            expect((await detailsEditorOf(page)).count, `${key} の前`).toBe(1);

            await page.keyboard.press(key);
            await expectSource(page, replaced, [replaced], key);
            await expectDetailsEditorClosed(page, key);
            await expectSelection(page, [target(TASK_A)], key);
            await expect.poll(() => focusOf(page), key).toBe('#a');
            await expectNotice(page, 'info', key);

            expect(await callUndo(page), key).toBe(true);
            await expectSource(page, DOC, [replaced, DOC], `${key} の元に戻す`);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 「保存」で、詳細のない項目には 1 行目のあと (次の兄弟の前) に足し、空にして保存すると詳細の引用ブロックを外す。どちらも onChange 1 回でノードは選んだまま (B-119、B-122、B-123、B-004)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const added = docWith(EDIT, BODY_B_ADDED('新しい詳細'));
        const cleared = docWith(EDIT, BODY_B_ADDED_A_CLEARED);
        expect(editedSource(await tryEdit(page, DOC, setDetailsOp(TASK_B, '新しい詳細')))).toBe(added);
        expect(editedSource(await tryEdit(page, added, setDetailsOp(TASK_A, '')))).toBe(cleared);
        await mount(page, DOC);

        await pressNode(page, TASK_B);
        await pressBar(page, 'details');
        await expectDetailsEditor(page, '');
        await page.keyboard.type('新しい詳細');
        await pressEditorButton(page, '保存');
        await expectSource(page, added, [added], '足す');
        await expectDetailsEditorClosed(page, '足す');
        await expectSelection(page, [target(TASK_B)], '足す');
        await expect.poll(() => focusOf(page), '足す').toBe('#a');
        await expectNotice(page, 'info', '足す');

        await clearSelection(page, '足す');
        await pressNode(page, TASK_A);
        await pressBar(page, 'details');
        await expectDetailsEditor(page, DETAILS_A);
        await replaceDetails(page, '');
        await pressEditorButton(page, '保存');
        await expectSource(page, cleared, [added, cleared], '外す');
        await expectDetailsEditorClosed(page, '外す');
        await expectSelection(page, [target(TASK_A)], '外す');
        // 外したので、図の Task A は詳細を持たない
        await expect(page.locator(nodeSelector(TASK_A)), '外す').not.toHaveAttribute('data-has-details');

        // 開き直すと、空 (外した) と、足した詳細が入っている
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '', '外したあと');
        await page.keyboard.press('Escape');
        await expectDetailsEditorClosed(page);
        await clearSelection(page, '外したあと');
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '新しい詳細', '足したあと');
        await page.keyboard.press('Escape');
        await expectSourceStill(page, cleared, [added, cleared]);
    });

    test('@editor 詳細の入力の外を押すと保存して閉じる: 何もないところ、別のノード、図の外の欄へのフォーカスの移動のどれでも (B-119、5.2 の軸 D)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        const saved = docWith(EDIT, BODY_B_ADDED('外で決める'));
        expect(editedSource(await tryEdit(page, DOC, setDetailsOp(TASK_B, '外で決める')))).toBe(saved);
        let first = true;
        for (const outside of ['何もないところ', '別のノード', '図の外の欄'] as const) {
            if (first) await mount(page, DOC);
            else await remount(page, DOC);
            first = false;
            await pressNode(page, TASK_B);
            await page.keyboard.press('d');
            await expectDetailsEditor(page, '', outside);
            await page.keyboard.type('外で決める');
            await expectSourceStill(page, DOC, [], `${outside} の前`);

            if (outside === '何もないところ') await pressBlank(page);
            else if (outside === '別のノード') await pressNode(page, DESIGN);
            else await focusOutside(page);
            await expectSource(page, saved, [saved], outside);
            await expectDetailsEditorClosed(page, outside);
            if (outside === '図の外の欄') expect(await focusOf(page), outside).toBe('#source');
        }
    });
});

test.describe('保存せずに閉じる (段 20。B-120、10.2 の B-120)', () => {
    test('@editor Esc と「やめる」で、保存せずに閉じる。原文、onChange、履歴は変わらず、ノードは選んだまま、フォーカスは図の要素。開き直すと前の詳細のまま (B-120)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        let first = true;
        for (const how of ['Esc', 'やめる'] as const) {
            if (first) await mount(page, DOC);
            else await remount(page, DOC);
            first = false;
            await pressNode(page, TASK_A);
            await page.keyboard.press('d');
            await expectDetailsEditor(page, DETAILS_A, how);
            await replaceDetails(page, '捨てる詳細');

            if (how === 'Esc') await page.keyboard.press('Escape');
            else await pressEditorButton(page, 'やめる');
            await expectDetailsEditorClosed(page, how);
            await expectSourceStill(page, DOC, [], how);
            await expect(toolButton(page, 'undo'), how).toBeDisabled();
            await expectSelection(page, [target(TASK_A)], how);
            await expect.poll(() => focusOf(page), how).toBe('#a');

            await page.keyboard.press('d');
            await expectDetailsEditor(page, DETAILS_A, `${how} のあとに開き直す`);
            await page.keyboard.press('Escape');
            await expectDetailsEditorClosed(page, how);
        }
    });
});

test.describe('変換中のキー (段 20。B-15、5.2 の軸 D)', () => {
    test('@editor 変換中 (isComposing か keyCode 229) の ⌘Enter、Ctrl+Enter、Esc は詳細の入力の操作にならない: 保存せず、閉じない。確定のあとに keyCode 229 で届くキーも無視し、確定したあとの ⌘Enter で保存する', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '変換は Chromium の CDP (Input.imeSetComposition) で起こす');
        await open(page);
        const saved = docWith(EDIT, BODY_B_ADDED('詳細'));
        expect(editedSource(await tryEdit(page, DOC, setDetailsOp(TASK_B, '詳細')))).toBe(saved);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '');

        const client = await page.context().newCDPSession(page);
        try {
            // 空のテキストエリアに変換中の文字を入れる (compositionstart が届く)
            await client.send('Input.imeSetComposition', { text: 'しょうさい', selectionStart: 5, selectionEnd: 5 });
            await expect.poll(async () => (await detailsEditorOf(page)).value).toBe('しょうさい');
            // IME が送る形 (keyCode 229、isComposing true) と、keyCode のある形 (isComposing true) の両方
            await pressComposing(client, 'Enter', META);
            await pressComposing(client, 'Enter', CTRL);
            await pressComposing(client, 'Escape');
            await page.keyboard.press('Meta+Enter');
            await page.keyboard.press('Escape');
            await expectSourceStill(page, DOC, [], '変換中');
            await expectDetailsEditor(page, 'しょうさい', '変換中');

            // 変換を確定する (compositionend が届く)
            await client.send('Input.insertText', { text: '詳細' });
            await expect.poll(async () => (await detailsEditorOf(page)).value).toBe('詳細');
            // 変換を確定したキーが確定のあとに keyCode 229 で届く形 (isComposing false) も無視する
            await pressComposing(client, 'Enter', META);
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, DOC, [], '確定のあとの keyCode 229');
            await expectDetailsEditor(page, '詳細', '確定のあとの keyCode 229');
        } finally {
            await client.detach();
        }

        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, saved, [saved]);
        await expectDetailsEditorClosed(page);
    });
});

test.describe('詳細を書けないノード (段 20。B-124、3.2、3.8、A-01、B-02)', () => {
    test('@editor 行を持たないルート、リストだけの文書のルート (容器)、表では、帯の「詳細編集」が押せず (押しても開かない)、D では詳細の入力が開かずに理由の通知が出る。原文は変わらない (B-124。見出しは詳細を持てるので外した。D-042)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        const cases = [
            { name: '行を持たないルート', doc: DOC_LINELESS, id: 1, kind: 'root' },
            { name: 'リストだけの文書のルート', doc: DOC_LIST_ROOT, id: 1, kind: 'list' },
            { name: '表', doc: DOC_TABLE, id: 3, kind: 'block' },
        ];
        let first = true;
        for (const item of cases) {
            if (first) await mount(page, item.doc);
            else await remount(page, item.doc);
            first = false;
            // 空振りの防ぎ: ねらった種類のノードで、詳細を持てない
            expect(await factsOf(page, item.id), item.name).toMatchObject({ kind: item.kind, canHaveDetails: false });

            await pressNode(page, item.id);
            await expect.poll(async () => (await selectionOf(page)).marked, item.name).toEqual([item.id]);
            await expectBarDisabled(page, 'details', item.name);
            await press(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-bar-button[data-command="details"]' }));
            await expectNoDetailsEditor(page, `${item.name} (帯)`);
            await expect(snackbars(page), `${item.name} (帯)`).toHaveCount(0);

            await page.keyboard.press('d');
            await expectNoDetailsEditor(page, `${item.name} (D)`);
            await expectNotice(page, undefined, `${item.name} (D)`);
            await expectSourceStill(page, item.doc, [], item.name);
        }
    });
});

test.describe('markdag キーのない文書 (段 20。B-125、4.3、context 7-16)', () => {
    test('@editor markdag キーのない文書 (frontmatter はある、frontmatter もない) で詳細を書くと、markdag: (と frontmatter) を足して詳細を書き、図に詳細が抜き出される。結果の通知に markdag: を足したことを添える。元に戻すで戻る (B-125)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const cases = [
            { name: 'markdag キーのない frontmatter', doc: DOC_NO_MARKDAG, expected: DOC_NO_MARKDAG_DETAILS },
            { name: 'frontmatter のない文書', doc: DOC_NO_FRONTMATTER, expected: DOC_NO_FRONTMATTER_DETAILS },
        ];
        let first = true;
        for (const item of cases) {
            const outcome = await tryEdit(page, item.doc, setDetailsOp(2, 'd', 'a'));
            expect(editedSource(outcome), item.name).toBe(item.expected);
            const note = outcome.status === 'edited' ? outcome.notes.find((entry) => entry.code === 'markdag-added') : undefined;
            expect(note, item.name).toBeDefined();

            // markdag.editor がない文書は閲覧だけなので、mount の mode で GUI 編集にする
            if (first) await mount(page, item.doc, { mode: 'edit' });
            else await remount(page, item.doc, { mode: 'edit' });
            first = false;
            expect(await getMode(page), item.name).toBe('edit');
            await expect(page.locator(nodeSelector(2)), item.name).not.toHaveAttribute('data-has-details');

            await pressNode(page, 2);
            await expectSelection(page, [{ id: 2, refText: 'a' }], item.name);
            await page.keyboard.press('d');
            await expectDetailsEditor(page, '', item.name);
            await page.keyboard.type('d');
            await page.keyboard.press('ControlOrMeta+Enter');
            await expectSource(page, item.expected, [item.expected], item.name);
            await expectDetailsEditorClosed(page, item.name);
            // markdag: を足したので、詳細が抜き出されて図の a が詳細を持つ
            await expect(page.locator(nodeSelector(2)), item.name).toHaveAttribute('data-has-details', '');
            const text = await expectNotice(page, 'info', item.name);
            expect(text, item.name).toContain(note?.message ?? '\u0000');

            expect(await callUndo(page), item.name).toBe(true);
            await expectSource(page, item.doc, [item.expected, item.doc], `${item.name} の元に戻す`);
        }
    });
});

test.describe('怠惰な続きの行を含む詳細 (段 20。G-020、最後の関門 B-121、3.4 の setDetails)', () => {
    test('@editor 怠惰な続きの行を含む詳細は、D で開いた入力の初めの値に図と同じ 2 行 (続きの行も) が入り、書き換えて ⌘Enter で保存すると詳細の行を全部 > 付きで書き直す。原文が書き換わって通知 (info) が出て、履歴に積む (D-037)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_LAZY, setDetailsOp(TASK_A, '直した')))).toBe(DOC_LAZY_FIXED);
        await mount(page, DOC_LAZY);
        expect(await factsOf(page, TASK_A)).toEqual({ kind: 'item', canHaveDetails: true, details: DETAILS_LAZY });

        await pressNode(page, TASK_A);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, DETAILS_LAZY);
        await replaceDetails(page, '直した');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, DOC_LAZY_FIXED, [DOC_LAZY_FIXED]);
        await expectDetailsEditorClosed(page);
        await expectNotice(page, 'info');
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('詳細表示の選択肢 (段 20。B-126、B-127、B-047、5.2 の軸 D、6.5)', () => {
    test('@editor 道具箱の「詳細表示」にポインタを乗せると、ボタンの右に選択肢 (常に表示、ホバー時に表示、隠す) が開く。選択肢の上へ動かす間は閉じず、ポインタが離れると少し待って閉じる。原文は変わらない (B-126、B-127)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pointerOverBlank(page);
        await settle(page);
        expect(await flyoutCount(page)).toBe(0);

        const button = await spot(page, { on: 'element', selector: DETAILS_TOOL });
        await page.mouse.move(button.x, button.y);
        await expectFlyoutOpen(page, 'ポインタを乗せる');

        // ボタンから選択肢の上へ動かしても閉じない
        const option = await spot(page, { on: 'element', selector: '#a .mdag-editor-flyout [data-details="hover"]' });
        await page.mouse.move(option.x, option.y, { steps: 8 });
        await page.waitForTimeout(600);
        await expectFlyoutOpen(page, '選択肢の上');

        // 離れると閉じる
        await pointerOverBlank(page);
        await expectFlyoutClosed(page, '離れる');
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 押して開いた選択肢は、ポインタが離れても開いたまま。もう 1 度押すか、外を押すか、Esc で閉じる。原文は変わらない (B-127、B-047)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        const button = await spot(page, { on: 'element', selector: DETAILS_TOOL });

        await press(page, button);
        await expectFlyoutOpen(page, '押す');
        await pointerOverBlank(page);
        await page.waitForTimeout(1_000);
        await expectFlyoutOpen(page, '押して開いてから離れる');

        // もう 1 度押す
        await press(page, button);
        await expectFlyoutClosed(page, 'もう 1 度押す');

        // 外 (何もないところ) を押す
        await press(page, button);
        await expectFlyoutOpen(page, '押す (2 回目)');
        await pressBlank(page);
        await expectFlyoutClosed(page, '外を押す');

        // Esc
        await press(page, button);
        await expectFlyoutOpen(page, '押す (3 回目)');
        await page.keyboard.press('Escape');
        await expectFlyoutClosed(page, 'Esc');
        await expectSourceStill(page, DOC, []);
    });
});

test.describe('詳細の見せ方 (段 20。B-128、B-170、5.3、10.2 の B-128)', () => {
    test('@editor GUI 編集の最初の見せ方は、文書の markdag.details.display (always、click、書かない) によらず、ホバー時に表示 (10.2 の B-128)', async ({ page }) => {
        await open(page);
        let first = true;
        for (const [name, markdag] of [
            ['always', display('always')],
            ['click', display('click')],
            ['書かない', []],
        ] as const) {
            const doc = docWith(EDIT, BODY, [...markdag]);
            if (first) await mount(page, doc);
            else await remount(page, doc);
            first = false;
            expect(await getMode(page), name).toBe('edit');
            await expect.poll(() => detailsLookOf(page), name).toEqual(lookFor('hover'));
        }
    });

    test('@editor 選んだ見せ方で図の詳細の見せ方が変わる (常に表示はノードの中に詳細を開き、ホバー時に表示と隠すは開かない)。原文、onChange、履歴は変わらない。詳細の書き換えと setSource (文書の display を変える) のあとも、選んだ見せ方のまま (B-128)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        for (const mode of ['always', 'click', 'hover', 'always'] as const) {
            await chooseDetails(page, mode);
            await expect.poll(() => detailsLookOf(page), mode).toEqual(lookFor(mode));
            await expectSourceStill(page, DOC, [], mode);
            await expect(toolButton(page, 'undo'), mode).toBeDisabled();
        }

        // 詳細を書き換えても、常に表示のまま
        const saved = docWith(EDIT, BODY_B_ADDED('見せ方'));
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '');
        await page.keyboard.type('見せ方');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, saved, [saved]);
        await settle(page);
        await expect.poll(() => detailsLookOf(page), '書き換えのあと').toEqual(lookFor('always'));

        // 文書の display を書いても、GUI 編集では選んだ見せ方のまま
        const clicked = docWith(EDIT, BODY_B_ADDED('見せ方'), display('click'));
        await setSource(page, clicked);
        await expect.poll(() => getSource(page)).toBe(clicked);
        await settle(page);
        await expect.poll(() => detailsLookOf(page), 'setSource のあと').toEqual(lookFor('always'));
    });

    test('@editor 閲覧では文書の指定 (markdag.details.display) に戻り、GUI 編集に戻ると選んだ見せ方に戻る。閲覧のあいだに文書の指定が変わっても同じ。閲覧だけの文書は文書の指定のまま (B-170、5.3)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const doc = docWith(SWITCH_VIEW, BODY, display('click'));
        await mount(page, doc);
        expect(await getMode(page)).toBe('view');
        await expect.poll(() => detailsLookOf(page), '閲覧で始まる').toEqual(lookFor('click'));

        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => detailsLookOf(page), 'GUI 編集へ').toEqual(lookFor('hover'));
        await chooseDetails(page, 'always');
        await expect.poll(() => detailsLookOf(page), '常に表示を選ぶ').toEqual(lookFor('always'));

        expect(await setMode(page, 'view')).toBe(true);
        await expect.poll(() => detailsLookOf(page), '閲覧へ').toEqual(lookFor('click'));
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => detailsLookOf(page), 'GUI 編集に戻す').toEqual(lookFor('always'));

        // 閲覧のあいだに文書の display を hover に変える
        expect(await setMode(page, 'view')).toBe(true);
        const hovered = docWith(SWITCH_VIEW, BODY, display('hover'));
        await setSource(page, hovered);
        await expect.poll(() => getSource(page)).toBe(hovered);
        await expect.poll(() => detailsLookOf(page), '閲覧で文書の指定を変える').toEqual(lookFor('hover'));
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => detailsLookOf(page), 'GUI 編集に戻す (2 回目)').toEqual(lookFor('always'));
        expect(await changeLog(page)).toEqual([]);

        // 閲覧だけの文書は文書の指定のまま
        await remount(page, docWith(VIEW, BODY, display('always')));
        expect(await getMode(page)).toBe('view');
        await expect.poll(() => detailsLookOf(page), '閲覧だけの文書').toEqual(lookFor('always'));
    });
});

test.describe('閲覧と外からの差し替え (段 20。B-169、B-171、5.2 の軸 D、5.3)', () => {
    test('@editor 閲覧では、ノードの中の詳細のダブルクリックと D で詳細の入力が開かず、原文も変わらない (閲覧だけの文書) (B-169)', async ({ page }) => {
        await open(page);
        const doc = docWith(VIEW, BODY, display('always'));
        await mount(page, doc);
        expect(await getMode(page)).toBe('view');
        await expect.poll(() => detailsLookOf(page)).toEqual(lookFor('always'));

        await doubleClick(page, await spot(page, { on: 'element', selector: `${nodeSelector(TASK_A)} .mdag-content .mdag-details` }));
        await expectNoDetailsEditor(page, 'ダブルクリック');
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectNoDetailsEditor(page, 'D');
        await expectSourceStill(page, doc, []);
    });

    test('@editor 詳細の入力中に閲覧へ切り替えると (setMode)、入れた詳細で保存して閉じる。詳細表示の選択肢を開いたまま閲覧へ切り替えると閉じ、GUI 編集に戻しても閉じたまま (B-171、5.2 の軸 D の「閲覧へ」)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const doc = docWith(SWITCH_EDIT, BODY);
        const saved = docWith(SWITCH_EDIT, BODY_B_ADDED('途中'));
        expect(editedSource(await tryEdit(page, doc, setDetailsOp(TASK_B, '途中')))).toBe(saved);
        await mount(page, doc);
        expect(await getMode(page)).toBe('edit');
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '');
        await page.keyboard.type('途中');

        expect(await setMode(page, 'view')).toBe(true);
        await expectSource(page, saved, [saved]);
        await expectDetailsEditorClosed(page);
        expect(await getMode(page)).toBe('view');

        await remount(page, doc);
        await press(page, await spot(page, { on: 'element', selector: DETAILS_TOOL }));
        await expectFlyoutOpen(page, '押して開く');
        // ポインタはボタンから離しておく (GUI 編集に戻したときに、ボタンの上のポインタで開くのと分けるため)
        await pointerOverBlank(page);
        await expectFlyoutOpen(page, '押して開いてから離れる');
        expect(await setMode(page, 'view')).toBe(true);
        await expectFlyoutClosed(page, '閲覧へ');
        expect(await setMode(page, 'edit')).toBe(true);
        await settle(page);
        expect(await flyoutCount(page), 'GUI 編集に戻す').toBe(0);
    });

    test('@editor 詳細の入力中に setSource で原文を差し替えると、入れた詳細を保存せずに閉じる (5.3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('d');
        await expectDetailsEditor(page, '');
        await page.keyboard.type('差し替えで捨てる');

        await setSource(page, DOC_OTHER);
        await expectDetailsEditorClosed(page);
        await expectSourceStill(page, DOC_OTHER, []);
        expect(await getSource(page)).not.toContain('差し替えで捨てる');
    });
});

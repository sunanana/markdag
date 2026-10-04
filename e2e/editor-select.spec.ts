// GUI 編集のノードの選択と操作の帯を、ビルドした配布物の markdag/editor で確かめる。
// 選択の受け口と値、キーの受け方、何もない所の押下、選んだノードを見える所へ動かすこと、inspectNode の can* で帯のボタンを押せるか、
// 矩形選択 (枠の内側と線の上からも始められる)、帯の置き場、矢印キーの並び (開いて動き終えたあとの並び) を見る。
// 線を押しても帯は出さない。GUI 編集では枠も線も押せる。
// 帯のボタンが行う操作 (名前の入力、子、兄弟、削除など) は名前と構造のテストが見るので、ここでは押さない。帯のボタンの有無、並び、押せるかを見る。
// 見た目そのもの (色、余白、影) は見ない。目印 (.mdag-node の data-selected、mdag-editor-* の要素の有無と数、data-for と data-command)、
// 要素の置き場 (帯がノードの上か下か、外枠が選んだノードを囲むか、矩形がドラッグの範囲か)、getSelection と onSelectionChange、
// 表示位置 (view.getTransform)、フォーカスのある要素、原文を見る。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditSelection, InspectNodeResult, ViewTransform } from '../src/core';
import type { EditorModeOption, EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';

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

// 選択に足す・外す修飾キー。
// macOS のブラウザは Ctrl +クリックを副ボタンのクリックとして扱い (contextmenu を出し、click を出さない)、依頼者が試した試作もこの組を受けていなかったので、
// macOS では Ctrl を押さない
const MODIFIERS: readonly string[] = process.platform === 'darwin' ? ['Shift', 'Meta'] : ['Shift', 'Meta', 'Control'];

// ノードは Root 1、Design 2、Task A 3、Task B 4、Task C 5、Build 6、Leaf 7。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '- Task C', '', '## Build', '', '- Leaf', ''];
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const TASK_C = 5;
const BUILD = 6;
const LEAF = 7;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Task C', 6: 'Build', 7: 'Leaf' };

// markdag.editor を書いた文書。editor の行は markdag.editor の下の字下げ (8 桁) から、markdag の行は markdag の下の字下げ (4 桁) からの相対で書く
function docWith(editor: string[], body: string[] = BODY, markdag: string[] = []): string {
    return [
        '---',
        'markdag:',
        '    edgeHighlight: true',
        ...markdag.map((line) => `    ${line}`),
        '    editor:',
        ...editor.map((line) => `        ${line}`),
        '---',
        '',
        ...body,
    ].join('\n');
}

const DOC = docWith(['mode: edit']);
// Design と配下がグループ design の枠に入る文書 (ノードの id は DOC と同じ)
const DOC_GROUPS = docWith(
    ['mode: edit'],
    BODY.map((line) => (line === '## Design' ? '## Design %design' : line)),
    ['groups:', '    design:', '        label: 設計', '        boundary: true'],
);
// 種類の違うノード: ATX の見出し (Root、Heading)、項目 (Item)、下線の見出し (Setext)、コード (Setext の子)、行頭に空白のある見出し (Indented)
const DOC_KINDS = docWith(['mode: edit'], ['# Root', '', '## Heading', '', '- Item', '', 'Setext', '------', '', '```js', 'code', '```', '', '  ## Indented', '']);
const DOC_VIEW = docWith(['mode: view']);
const DOC_SWITCH = docWith(['mode: switch', 'default: edit']);

// 1 つのノードを選んだときの帯の並び (sep は区切り)
const NODE_BAR = ['rename', 'child', 'sibling', 'details', 'tag-add', 'tag-select', 'sep', 'delete'];
// ルートを選んだときの帯のボタン (兄弟と削除がない)
const ROOT_BAR_COMMANDS = ['rename', 'child', 'details', 'tag-add', 'tag-select'];
// 2 つ以上を選んだときの帯の並び (title は選んだ数)
const NODES_BAR = ['title', 'join-new', 'join-existing', 'group', 'tag-add', 'tag-select', 'sep', 'delete'];
// 帯のボタンと、押せるかを決める inspectNode の欄。タグは 1 行目の印なので canMark
const CAN: Record<string, keyof InspectNodeResult> = {
    rename: 'canRename',
    child: 'canAddChild',
    sibling: 'canAddSibling',
    details: 'canHaveDetails',
    'tag-add': 'canMark',
    'tag-select': 'canMark',
    delete: 'canDelete',
};

interface Point {
    x: number;
    y: number;
}

// 図の外 (#a の右) で、ウィンドウの中の点
const OUTSIDE: Point = { x: 1100, y: 300 };

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
    root?: 'a' | 'b';
    mode?: EditorModeOption;
    animate?: boolean;
}

async function mount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    const root = spec.root ?? 'a';
    await page.evaluate(
        ({ markdown, root, mode, animate }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error(`#${root} がない`);
            const options: EditorOptions = {
                animate,
                onChange: (next) => {
                    target.changes.push({ root, markdown: next });
                },
                onSelectionChange: (selection) => {
                    target.selections.push({ root, selection: JSON.parse(JSON.stringify(selection)) as EditorSelection });
                },
            };
            if (mode !== null) options.mode = mode;
            target.editors[root] = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, root, mode: spec.mode ?? null, animate: spec.animate ?? false },
    );
    await expect(page.locator(`#${root} .mdag-node`).first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じ文書で描き直す (選択と表示位置を初めの状態に戻す)
async function remount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    const root = spec.root ?? 'a';
    await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.destroy(), root);
    await mount(page, markdown, spec);
}

// 「変わらない」「呼ばれない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page, root = 'a'): Promise<string[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).changes.flatMap((entry) => (entry.root === root ? [entry.markdown] : [])), root);

const selectionLog = (page: Page, root = 'a'): Promise<EditorSelection[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).selections.flatMap((entry) => (entry.root === root ? [entry.selection] : [])), root);

const getSource = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSource(), root);

const setMode = (page: Page, mode: 'view' | 'edit', root = 'a'): Promise<boolean> =>
    page.evaluate(({ mode, root }) => (window as unknown as EditorWindow).editors[root]?.setMode(mode) ?? false, { mode, root });

async function transformOf(page: Page, root = 'a'): Promise<ViewTransform> {
    const transform = await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getTransform() ?? null, root);
    if (!transform) throw new Error(`#${root} の図がない`);
    return transform;
}

const sameTransform = (a: ViewTransform, b: ViewTransform): boolean => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

const panBy = (page: Page, dx: number, dy: number, root = 'a'): Promise<void> =>
    page.evaluate(({ dx, dy, root }) => (window as unknown as EditorWindow).editors[root]?.view.panBy(dx, dy), { dx, dy, root });

const getFolded = (page: Page, root = 'a'): Promise<number[]> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.view.getFolded() ?? [], root);

const toolButton = (page: Page, tool: string, root = 'a') => page.locator(`#${root} .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const hint = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-hint`);
const snackbars = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-snackbar`);
const marquees = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-marquee`);
const selectionBounds = (page: Page, root = 'a') => visible(page, `#${root} .mdag-editor-selection-bounds`);
const nodeSelector = (id: number, root = 'a'): string => `#${root} .mdag-node[data-id="${id}"]`;

async function useSelectTool(page: Page, root = 'a'): Promise<void> {
    await toolButton(page, 'select', root).click();
    await expect(page.locator(`#${root}`)).toHaveAttribute('data-editor-tool', 'select');
}

// フォーカスのある要素: body (か null)、id のある要素 (#<id>)、それ以外はタグの名前
async function focusOf(page: Page): Promise<string> {
    return page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        if (active.id) return `#${active.id}`;
        return active.tagName.toLowerCase();
    });
}

// フォーカスをどこにもない状態 (body) にする
const blurAll = (page: Page): Promise<void> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

// ページの文字の選択 (修飾キーのクリックで文字が選ばれていないか)
const textSelection = (page: Page): Promise<string> => page.evaluate(() => window.getSelection()?.toString() ?? '');

interface SelectedState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // getSelection のノードの id (昇順)。何も選んでいなければ空、ノードでなければ kind
    selected: number[] | string;
}

async function selectedOf(page: Page, root = 'a'): Promise<SelectedState> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        const editor = (window as unknown as EditorWindow).editors[root];
        if (!container || !editor) throw new Error(`#${root} の図がない`);
        const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        const selection = editor.getSelection();
        const selected = selection.kind === 'nodes' ? selection.nodes.map((target) => target.id).sort((a, b) => a - b) : selection.kind === 'none' ? [] : selection.kind;
        return { marked, selected };
    }, root);
}

// 選んでいるノードが ids になるまで待つ (図の印と getSelection の両方)
async function expectSelected(page: Page, ids: number[], message?: string, root = 'a'): Promise<void> {
    const sorted = [...ids].sort((a, b) => a - b);
    await expect.poll(() => selectedOf(page, root), message).toEqual({ marked: sorted, selected: sorted });
}

// 選択が変わらないことを見る (数コマ待ってから)
async function expectStillSelected(page: Page, ids: number[], message?: string, root = 'a'): Promise<void> {
    await settle(page);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(await selectedOf(page, root), message).toEqual({ marked: sorted, selected: sorted });
}

// ノードの順を id の昇順にそろえる (選択の中の並びは決めていない)
function normalized(selection: EditorSelection): EditorSelection {
    return selection.kind === 'nodes' ? { kind: 'nodes', nodes: [...selection.nodes].sort((a, b) => a.id - b.id) } : selection;
}

const nodesSelection = (ids: number[]): EditSelection => ({ kind: 'nodes', nodes: [...ids].sort((a, b) => a - b).map((id) => ({ id, refText: REF_TEXTS[id] ?? '' })) });

async function getSelection(page: Page, root = 'a'): Promise<EditorSelection> {
    const selection = await page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSelection() ?? null, root);
    if (!selection) throw new Error(`#${root} の図がない`);
    return normalized(selection);
}

interface BarInfo {
    // data-for (node、nodes、group)
    for: string | null;
    // 見えている帯の中身の並び (title は数の欄、sep は区切り、ほかは data-command)
    items: string[];
    // 押せないボタンの data-command (disabled か aria-disabled="true")
    disabled: string[];
    title: string;
    rect: Box;
}

// 見えている操作の帯
async function barsOf(page: Page, root = 'a'): Promise<BarInfo[]> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        if (!container) throw new Error(`#${root} がない`);
        const shown = (element: Element): boolean => element.checkVisibility();
        return [...container.querySelectorAll('.mdag-editor-bar')].filter(shown).map((bar) => {
            const items = [...bar.querySelectorAll('.mdag-editor-bar-title, .mdag-editor-bar-button, .mdag-editor-bar-sep')].filter(shown);
            const kindOf = (item: Element): string =>
                item.classList.contains('mdag-editor-bar-title') ? 'title' : item.classList.contains('mdag-editor-bar-sep') ? 'sep' : (item.getAttribute('data-command') ?? '');
            const rect = bar.getBoundingClientRect();
            return {
                for: bar.getAttribute('data-for'),
                items: items.map(kindOf),
                disabled: items
                    .filter((item) => item.classList.contains('mdag-editor-bar-button') && ((item as HTMLButtonElement).disabled || item.getAttribute('aria-disabled') === 'true'))
                    .map(kindOf),
                title: items
                    .filter((item) => item.classList.contains('mdag-editor-bar-title'))
                    .map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim())
                    .join(' '),
                rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            };
        });
    }, root);
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

async function nodeBox(page: Page, id: number, root = 'a'): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id, root)} .mdag-box`);
    if (!box) throw new Error(`ノード ${id} の箱がない`);
    return box;
}

function union(boxes: Box[]): Box {
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

// 帯が相手の上にある (重ならず、相手の左右の中ほどに掛かる)
const isAbove = (bar: Box, target: Box): boolean => bar.bottom <= target.top + 1 && bar.left <= (target.left + target.right) / 2 && bar.right >= (target.left + target.right) / 2;
// 帯が相手の下にある
const isBelow = (bar: Box, target: Box): boolean => bar.top >= target.bottom - 1 && bar.left <= (target.left + target.right) / 2 && bar.right >= (target.left + target.right) / 2;
// outer が inner を囲む (1px まで)
const encloses = (outer: Box, inner: Box): boolean => outer.left <= inner.left + 1 && outer.top <= inner.top + 1 && outer.right >= inner.right - 1 && outer.bottom >= inner.bottom - 1;

// ノードの箱が図の領域に収まっているか
async function insideArea(page: Page, id: number, root = 'a'): Promise<boolean> {
    const [area] = await rectsOf(page, `#${root}`);
    const box = await rectsOf(page, `${nodeSelector(id, root)} .mdag-box`);
    if (!area || !box[0]) return false;
    return encloses(area, box[0]);
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

// 線を押す帯 (.mdag-edge-hit) が表に出ている点 (線の中ほどから試す)
async function edgeSpot(page: Page, root = 'a'): Promise<Point> {
    const found = await page.evaluate((root) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        for (const hit of document.querySelectorAll<SVGGeometryElement>(`#${root} .mdag-edge-hit`)) {
            const matrix = hit.getScreenCTM();
            if (!matrix) continue;
            const length = hit.getTotalLength();
            const steps = Array.from({ length: 49 }, (_, index) => index + 1).sort((a, b) => Math.abs(a - 25) - Math.abs(b - 25));
            for (const step of steps) {
                const at = hit.getPointAtLength((length * step) / 50);
                const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
                if (inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === hit) return { x: point.x, y: point.y };
            }
        }
        return null;
    }, root);
    if (!found) throw new Error('線の帯の上の点がない');
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

// 修飾キーを押したまま action を行う
async function withModifier(page: Page, modifier: string | null, action: () => Promise<void>): Promise<void> {
    if (modifier !== null) await page.keyboard.down(modifier);
    try {
        await action();
    } finally {
        if (modifier !== null) await page.keyboard.up(modifier);
    }
}

// ノードの箱を押す (修飾キーつきもある)
async function pressNode(page: Page, id: number, modifier: string | null = null, root = 'a'): Promise<void> {
    const point = await spot(page, { on: 'element', selector: `${nodeSelector(id, root)} .mdag-box` });
    await withModifier(page, modifier, () => press(page, point));
}

async function pressBlank(page: Page, modifier: string | null = null, root = 'a'): Promise<void> {
    const point = await spot(page, { on: 'blank', root });
    await withModifier(page, modifier, () => press(page, point));
}

// 主ボタンで from から to へドラッグする。during は離す前 (to まで動かしたあと) に呼ぶ
async function dragFrom(page: Page, from: Point, to: Point, during?: () => Promise<void>): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + (to.x - from.x) * 0.3, from.y + (to.y - from.y) * 0.3, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    try {
        if (during) await during();
    } finally {
        await page.mouse.up();
    }
}

// 矩形の要素がドラッグの範囲 (from と to を角とする矩形) に出ている
async function expectMarqueeBetween(page: Page, from: Point, to: Point, root = 'a'): Promise<void> {
    await expect(marquees(page, root)).toHaveCount(1);
    const expected: Box = { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), right: Math.max(from.x, to.x), bottom: Math.max(from.y, to.y) };
    await expect
        .poll(async () => {
            const [rect] = await rectsOf(page, `#${root} .mdag-editor-marquee`);
            if (!rect) return null;
            return (['left', 'top', 'right', 'bottom'] as const).every((side) => Math.abs(rect[side] - expected[side]) <= 2);
        })
        .toBe(true);
}

interface Drag {
    from: Point;
    to: Point;
}

// 何もないところから始め、ちょうど targets の箱にかかる (ほかの箱にかからない) 矩形のドラッグを探す
async function marqueeFor(page: Page, targets: number[], root = 'a'): Promise<Drag> {
    const found = await page.evaluate(
        ({ targets, root }) => {
            const container = document.getElementById(root);
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
        { targets, root },
    );
    if (!found) throw new Error(`ノード ${targets.join(', ')} だけにかかる矩形のドラッグがない`);
    return found;
}

// 矩形の中にかかるノード (箱が一部でも重なるもの) の id
async function nodesHitBy(page: Page, from: Point, to: Point, root = 'a'): Promise<number[]> {
    return page.evaluate(
        ({ from, to, root }) => {
            const container = document.getElementById(root);
            if (!container) return [];
            const l = Math.min(from.x, to.x);
            const r = Math.max(from.x, to.x);
            const t = Math.min(from.y, to.y);
            const b = Math.max(from.y, to.y);
            return [...container.querySelectorAll<HTMLElement>('.mdag-node[data-id]')]
                .flatMap((node) => {
                    const rect = node.querySelector('.mdag-box')?.getBoundingClientRect();
                    return rect && rect.width > 0 && rect.height > 0 && rect.left < r && rect.right > l && rect.top < b && rect.bottom > t ? [Number(node.dataset.id)] : [];
                })
                .sort((x, y) => x - y);
        },
        { from, to, root },
    );
}

// from から始めて、ルートでないノードに 1 つ以上かかる矩形の終わりの点を探す (図の領域の中)
async function dragEndFrom(page: Page, from: Point, root = 'a'): Promise<{ to: Point; hits: number[] }> {
    for (const [dx, dy] of [
        [170, 130],
        [-170, 130],
        [170, -130],
        [-170, -130],
        [260, 60],
        [-260, 60],
    ] as const) {
        const to = { x: Math.min(990, Math.max(10, from.x + dx)), y: Math.min(590, Math.max(10, from.y + dy)) };
        const hits = (await nodesHitBy(page, from, to, root)).filter((id) => id !== ROOT);
        if (hits.length > 0) return { to, hits };
    }
    throw new Error(`(${from.x}, ${from.y}) から始めてノードにかかる矩形がない`);
}

// 修飾キーを押したまま、矩形で targets を囲む (矩形の要素が出ていることも見る)
async function marqueeSelect(page: Page, targets: number[], modifier: string | null = null, root = 'a'): Promise<void> {
    const { from, to } = await marqueeFor(page, targets, root);
    await withModifier(page, modifier, () => dragFrom(page, from, to, () => expectMarqueeBetween(page, from, to, root)));
    await expect(marquees(page, root)).toHaveCount(0);
}

// カーソルを置くと、target がいちばん近いノードになる何もないところの点。
// 箱までの距離と中心までの距離のどちらで測っても target がいちばん近く、2 番目と 12px 以上離れている点を選ぶ
async function nearPoint(page: Page, target: number, root = 'a'): Promise<Point> {
    const found = await page.evaluate(
        ({ target, root }) => {
            const container = document.getElementById(root);
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            const area = container.getBoundingClientRect();
            const boxes = [...container.querySelectorAll<HTMLElement>('.mdag-node[data-id]')].flatMap((node) => {
                const rect = node.querySelector('.mdag-box')?.getBoundingClientRect();
                return rect && rect.width > 0 && rect.height > 0 ? [{ id: Number(node.dataset.id), rect }] : [];
            });
            const own = boxes.find((box) => box.id === target)?.rect;
            if (!own) return null;
            const edge = (x: number, y: number, rect: DOMRect): number => Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
            const center = (x: number, y: number, rect: DOMRect): number => Math.hypot(x - (rect.left + rect.right) / 2, y - (rect.top + rect.bottom) / 2);
            const candidates: Array<{ x: number; y: number; distance: number }> = [];
            for (let y = own.top - 60; y <= own.bottom + 60; y += 4) {
                for (let x = own.left - 60; x <= own.right + 60; x += 4) {
                    if (x <= area.left + 4 || y <= area.top + 4 || x >= area.right - 4 || y >= area.bottom - 4) continue;
                    const distance = edge(x, y, own);
                    if (distance < 8 || distance > 48 || document.elementFromPoint(x, y) !== viewport) continue;
                    const clear = boxes.every((box) => box.id === target || (edge(x, y, box.rect) >= distance + 12 && center(x, y, box.rect) >= center(x, y, own) + 12));
                    if (clear) candidates.push({ x, y, distance });
                }
            }
            candidates.sort((a, b) => a.distance - b.distance);
            return candidates[0] ?? null;
        },
        { target, root },
    );
    if (!found) throw new Error(`ノード ${target} がいちばん近い点がない`);
    return { x: found.x, y: found.y };
}

// parent の子のうち、動き終えたあとの位置で画面のいちばん上のもの
async function topChild(page: Page, parent: number, root = 'a'): Promise<number> {
    const found = await page.evaluate(
        ({ parent, root }) => {
            const view = (window as unknown as EditorWindow).editors[root]?.view;
            const doc = view?.getDocument();
            if (!view || !doc) return null;
            const children = doc.parsed.nodes.filter((node) => node.parent === parent).map((node) => node.id);
            const rects = [...view.nodeRects(children, { settled: true })].sort((a, b) => a[1].y - b[1].y);
            return rects[0]?.[0] ?? null;
        },
        { parent, root },
    );
    if (found === null) throw new Error(`ノード ${parent} の見えている子がない`);
    return found;
}

// id と同じ親の子 (id を含む) を画面の上から並べたもの
async function siblingsOnScreen(page: Page, id: number, root = 'a'): Promise<number[]> {
    return page.evaluate(
        ({ id, root }) => {
            const view = (window as unknown as EditorWindow).editors[root]?.view;
            const doc = view?.getDocument();
            if (!view || !doc) return [];
            const parent = doc.parsed.nodes.find((node) => node.id === id)?.parent ?? null;
            const siblings = doc.parsed.nodes.filter((node) => node.parent === parent).map((node) => node.id);
            return [...view.nodeRects(siblings)].sort((a, b) => a[1].y - b[1].y).map(([sibling]) => sibling);
        },
        { id, root },
    );
}

// 動き終えて、ノードの今の矩形が動き終えたあとの矩形と 1px 以内で一致するまで待つ
async function waitSettled(page: Page, root = 'a'): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate((root) => {
                const view = (window as unknown as EditorWindow).editors[root]?.view;
                if (!view) return false;
                const now = view.nodeRects();
                const settled = view.nodeRects(undefined, { settled: true });
                return [...now].every(([id, rect]) => {
                    const goal = settled.get(id);
                    return goal !== undefined && Math.abs(goal.x - rect.x) <= 1 && Math.abs(goal.y - rect.y) <= 1;
                });
            }, root),
        )
        .toBe(true);
}

// まわり (32px) の点も全部何もないところで、ノードの箱から 48px 以上離れた点
async function openBlank(page: Page, root = 'a'): Promise<Point> {
    const found = await page.evaluate((root) => {
        const container = document.getElementById(root);
        const viewport = container?.querySelector(':scope > .mdag-viewport');
        if (!container || !viewport) return null;
        const area = container.getBoundingClientRect();
        const boxes = [...container.querySelectorAll('.mdag-node .mdag-box')].map((box) => box.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
        const blank = (x: number, y: number): boolean => x > area.left + 2 && y > area.top + 2 && x < area.right - 2 && y < area.bottom - 2 && document.elementFromPoint(x, y) === viewport;
        const around = [-32, 0, 32];
        for (let y = area.top + 40; y < area.bottom - 40; y += 16) {
            for (let x = area.right - 40; x > area.left + 40; x -= 16) {
                const far = boxes.every((rect) => Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom)) >= 48);
                if (far && around.every((dx) => around.every((dy) => blank(x + dx, y + dy)))) return { x, y };
            }
        }
        return null;
    }, root);
    if (!found) throw new Error('まわりにも何もない点がない');
    return found;
}

// 指 (タッチ) で from から to へドラッグする (Chromium の CDP。during は離す前に呼ぶ)
async function touchDrag(page: Page, from: Point, to: Point, during?: () => Promise<void>): Promise<void> {
    const client = await page.context().newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (let step = 1; step <= 8; step++) {
        const x = from.x + ((to.x - from.x) * step) / 8;
        const y = from.y + ((to.y - from.y) * step) / 8;
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    try {
        if (during) await during();
    } finally {
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await client.detach();
    }
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

const hintText = async (page: Page): Promise<string> => ((await hint(page).textContent()) ?? '').replace(/\s+/g, ' ').trim();

const countPattern = (count: number): RegExp => new RegExp(`(^|[^0-9])${count}([^0-9]|$)`);

test.describe('ノードを押して選ぶと出る帯 (B-011、B-012、B-076、3.8、6.5)', () => {
    test('@editor 選択の道具でノードを押すと、そのノードだけに data-selected が付き、ノードの上に帯 (data-for="node") が 1 つ出る。並びは 名前、子の追加、兄弟追加、詳細編集、タグ追加、タグ選択、(区切り)、削除', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
        await useSelectTool(page);

        await pressNode(page, TASK_B);
        await expectSelected(page, [TASK_B]);
        await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['node']);
        const [bar] = await barsOf(page);
        expect(bar?.items).toEqual(NODE_BAR);
        expect(isAbove(bar?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }, await nodeBox(page, TASK_B))).toBe(true);

        // 別のノードを押すと、選択と帯がそちらへ移る
        await pressNode(page, TASK_C);
        await expectSelected(page, [TASK_C]);
        await expect
            .poll(async () => {
                const bars = await barsOf(page);
                return bars.length === 1 && bars[0]?.for === 'node' && isAbove(bars[0].rect, await nodeBox(page, TASK_C));
            })
            .toBe(true);

        // 同じノードをもう 1 度押しても選んだまま
        await pressNode(page, TASK_C);
        await expectStillSelected(page, [TASK_C]);
        expect(await barsOf(page)).toHaveLength(1);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('@editor 手のひらでもノードを押すと選ばれ、帯が出る。道具は手のひらのまま (B-076)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await toolButton(page, 'hand').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');
        await pressNode(page, DESIGN);
        await expectSelected(page, [DESIGN]);
        await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['node']);
        const [bar] = await barsOf(page);
        expect(bar?.items).toEqual(NODE_BAR);
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');
        expect(await getSource(page)).toBe(DOC);
    });

    test('@editor ルートを選んだ帯には兄弟追加と削除がなく、名前、子の追加、詳細編集、タグ追加、タグ選択の順 (B-012、10.2 の B-012)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, ROOT);
        await expectSelected(page, [ROOT]);
        await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['node']);
        const [bar] = await barsOf(page);
        expect(bar?.items.filter((item) => item !== 'sep')).toEqual(ROOT_BAR_COMMANDS);
    });

    test('@editor 帯のボタンは、inspectNode の can* が false なら押せない (見出し、項目、下線の見出し、コード、行頭に空白のある見出し) (3.8)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_KINDS);
        await useSelectTool(page);
        const facts = await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            const editor = target.editors.a;
            const doc = editor?.view.getDocument();
            if (!editor || !doc) throw new Error('図がない');
            return doc.parsed.nodes.map((node) => ({ id: node.id, inspect: target.editorHarness.core.inspectNode(editor.getSource(), { id: node.id, refText: node.refText }) }));
        });
        expect(facts.map((fact) => fact.inspect?.kind ?? null)).toEqual(['heading', 'heading', 'item', 'heading', 'block', 'heading']);
        // 帯が上に出るので、上にあるノードから順に押す (前の帯に隠れないように)
        const tops = await Promise.all(facts.map(async (fact) => ({ id: fact.id, top: (await nodeBox(page, fact.id)).top, left: (await nodeBox(page, fact.id)).left })));
        tops.sort((a, b) => a.top - b.top || a.left - b.left);

        const seen = { disabled: 0, enabled: 0 };
        for (const { id } of tops) {
            const inspect = facts.find((fact) => fact.id === id)?.inspect;
            if (!inspect) throw new Error(`ノード ${id} の inspectNode がない`);
            await pressNode(page, id);
            await expectSelected(page, [id], `ノード ${id}`);
            await expect.poll(async () => (await barsOf(page)).length, `ノード ${id}`).toBe(1);
            const [bar] = await barsOf(page);
            const commands = (bar?.items ?? []).filter((item) => item !== 'sep');
            expect(commands, `ノード ${id}`).toEqual(id === ROOT ? ROOT_BAR_COMMANDS : NODE_BAR.filter((item) => item !== 'sep'));
            const expectedDisabled = commands.filter((command) => {
                const key = CAN[command];
                return key !== undefined && inspect[key] === false;
            });
            expect(bar?.disabled, `ノード ${id} (${inspect.kind})`).toEqual(expectedDisabled);
            seen.disabled += expectedDisabled.length;
            seen.enabled += commands.length - expectedDisabled.length;
        }
        // 空振りの防ぎ: 押せるボタンと押せないボタンの両方を見た
        expect(seen.disabled).toBeGreaterThan(0);
        expect(seen.enabled).toBeGreaterThan(0);
        expect(await getSource(page)).toBe(DOC_KINDS);
    });

    test('@editor ノードの上に帯が入らないときは、ノードの下に出る。上に入れば上に戻る (B-011、6.5)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await expect.poll(async () => (await barsOf(page)).length).toBe(1);

        // Task A の箱の上の辺を図の領域の上の辺から 4px の所へ動かす
        const top = await page.evaluate((id) => (window as unknown as EditorWindow).editors.a?.view.nodeRects([id]).get(id)?.y ?? null, TASK_A);
        if (top === null) throw new Error('Task A の矩形がない');
        await panBy(page, 0, 4 - top);
        await expect
            .poll(async () => {
                const bars = await barsOf(page);
                return bars.length === 1 && isBelow(bars[0]?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }, await nodeBox(page, TASK_A));
            })
            .toBe(true);

        await panBy(page, 0, 200);
        await expect
            .poll(async () => {
                const bars = await barsOf(page);
                return bars.length === 1 && isAbove(bars[0]?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }, await nodeBox(page, TASK_A));
            })
            .toBe(true);
        await expectStillSelected(page, [TASK_A]);
    });
});

test.describe('矩形選択 (B-060、B-061、B-063、A-13、B-13、5.2 の軸 E)', () => {
    test('@editor 選択の道具で何もないところからドラッグすると、ドラッグの間だけ矩形が出て、離すとかかったノードが選ばれる。図は動かない (B-060)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const before = await transformOf(page);
        const { from, to } = await marqueeFor(page, [TASK_A, TASK_B, TASK_C]);
        await expect(marquees(page)).toHaveCount(0);
        await dragFrom(page, from, to, () => expectMarqueeBetween(page, from, to));
        await expect(marquees(page)).toHaveCount(0);
        await expectSelected(page, [TASK_A, TASK_B, TASK_C]);
        expect(sameTransform(await transformOf(page), before)).toBe(true);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('@editor 矩形は一部でもかかったノードを選ぶ (B-060)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const box = await nodeBox(page, TASK_B);
        // Task B の右の何もないところから、Task B の箱の左右の中ほどまで (上下は箱の中に収める)
        const from = await page.evaluate(
            ({ box }) => {
                const viewport = document.querySelector('#a > .mdag-viewport');
                for (const dx of [16, 24, 32, 48, 64, 80]) {
                    const point = { x: box.right + dx, y: box.top + 8 };
                    if (document.elementFromPoint(point.x, point.y) === viewport) return point;
                }
                return null;
            },
            { box },
        );
        if (!from) throw new Error('Task B の右に何もないところがない');
        const to = { x: (box.left + box.right) / 2, y: box.bottom - 8 };
        expect(await nodesHitBy(page, from, to)).toEqual([TASK_B]);
        await dragFrom(page, from, to, () => expectMarqueeBetween(page, from, to));
        await expectSelected(page, [TASK_B]);
    });

    test('@editor 修飾キーなしの矩形はそれまでの選択を置き換え、Shift / ⌘ (/ Ctrl) つきの矩形はそれまでの選択に足す (外さない) (B-061)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const modifier of MODIFIERS) {
            await pressNode(page, LEAF);
            await expectSelected(page, [LEAF], modifier);
            await marqueeSelect(page, [TASK_A, TASK_B], modifier);
            await expectSelected(page, [TASK_A, TASK_B, LEAF], modifier);
            // もう選んでいる Task B にかかっても外さない
            await marqueeSelect(page, [TASK_B, TASK_C], modifier);
            await expectSelected(page, [TASK_A, TASK_B, TASK_C, LEAF], modifier);
            // 修飾キーなしは置き換える
            await marqueeSelect(page, [LEAF]);
            await expectSelected(page, [LEAF], modifier);
        }
        expect(await getSource(page)).toBe(DOC);
    });

    test('@editor ルートは矩形に入らない: 図の全体を囲んでも、ルートのほかのノードが選ばれる (B-063)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await marqueeSelect(page, [ROOT, DESIGN, TASK_A, TASK_B, TASK_C, BUILD, LEAF]);
        await expectSelected(page, [DESIGN, TASK_A, TASK_B, TASK_C, BUILD, LEAF]);
        // ルートだけを囲むと何も選ばれない
        await pressBlank(page);
        await expectSelected(page, []);
        await marqueeSelect(page, [ROOT]);
        await expectStillSelected(page, []);
    });

    test('@editor グループの枠の内側から始めても矩形になり、かかったノードが選ばれる。枠 (グループ) は選ばれない (A-13、B-13、10.1-3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);
        const from = await spot(page, { on: 'element', selector: '#a .mdag-frame[data-group="design"]' });
        const { to, hits } = await dragEndFrom(page, from);
        await dragFrom(page, from, to, () => expectMarqueeBetween(page, from, to));
        await expect(marquees(page)).toHaveCount(0);
        await expectSelected(page, hits);
        expect((await getSelection(page)).kind).toBe('nodes');
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]')).toHaveCount(0);
    });

    test('@editor 線の帯の上から始めても矩形になり、かかったノードが選ばれる。線は選ばれない (A-13、B-13、10.1-1)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);
        const from = await edgeSpot(page);
        const { to, hits } = await dragEndFrom(page, from);
        await dragFrom(page, from, to, () => expectMarqueeBetween(page, from, to));
        await expect(marquees(page)).toHaveCount(0);
        await expectSelected(page, hits);
        expect((await getSelection(page)).kind).toBe('nodes');
        await expect(page.locator('#a')).not.toHaveAttribute('data-edge-selected');
    });

    test('@editor 手のひらのドラッグと、選択の道具の中ボタンのドラッグは矩形にならず、図が動く (5.2 の軸 B と軸 E)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const tool of ['hand', 'select']) {
            await toolButton(page, tool).click();
            await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', tool);
            const before = await transformOf(page);
            const from = await spot(page, { on: 'blank', root: 'a' });
            const to = { x: from.x + 80, y: from.y + 60 };
            if (tool === 'hand') {
                await dragFrom(page, from, to, async () => {
                    await settle(page);
                    await expect(marquees(page)).toHaveCount(0);
                });
            } else {
                await page.mouse.move(from.x, from.y);
                await page.mouse.down({ button: 'middle' });
                await page.mouse.move(to.x, to.y, { steps: 6 });
                await settle(page);
                await expect(marquees(page)).toHaveCount(0);
                await page.mouse.up({ button: 'middle' });
            }
            await expect.poll(async () => sameTransform(await transformOf(page), before), tool).toBe(false);
            await expectStillSelected(page, [], tool);
        }
    });
});

test.describe('指のドラッグ (B-067)', () => {
    test.use({ hasTouch: true });

    test('@editor 選択の道具でも、指のドラッグは矩形にならず図が動き、選択は変わらない (B-067)', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '指の入力は Chromium の CDP で起こす');
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        const before = await transformOf(page);
        // ブラウザは指の押下をそばの要素へ寄せることがあるので、まわりにも何もない所から始める
        const from = await openBlank(page);
        const to = { x: from.x - 90, y: from.y - 60 };
        await touchDrag(page, from, to, async () => {
            await settle(page);
            await expect(marquees(page)).toHaveCount(0);
        });
        await expect.poll(async () => sameTransform(await transformOf(page), before)).toBe(false);
        await expect(marquees(page)).toHaveCount(0);
        await expectStillSelected(page, [TASK_A]);
    });
});

test.describe('修飾キーのクリック (B-062、B-063)', () => {
    test('@editor Shift / ⌘ (/ Ctrl) +クリックで 1 つずつ選択に足し、選んでいるノードは外す (B-062)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const modifier of MODIFIERS) {
            await pressNode(page, TASK_A, modifier);
            await expectSelected(page, [TASK_A], modifier);
            await pressNode(page, TASK_C, modifier);
            await expectSelected(page, [TASK_A, TASK_C], modifier);
            await pressNode(page, LEAF, modifier);
            await expectSelected(page, [TASK_A, TASK_C, LEAF], modifier);
            await pressNode(page, TASK_A, modifier);
            await expectSelected(page, [TASK_C, LEAF], modifier);
            await pressNode(page, LEAF, modifier);
            await expectSelected(page, [TASK_C], modifier);
            await pressNode(page, TASK_C, modifier);
            await expectSelected(page, [], modifier);
        }
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 修飾キー +クリックで文字が選ばれず、修飾キー +ドラッグでノードが付け替わらない (B-062)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const modifier of MODIFIERS) {
            // 文字の上を押してから、修飾キーで別のノードの文字を押す (ふつうのページなら Shift で文字の選択が広がる)
            await press(page, await spot(page, { on: 'text', selector: `${nodeSelector(TASK_A)} .mdag-content` }));
            await withModifier(page, modifier, async () => press(page, await spot(page, { on: 'text', selector: `${nodeSelector(LEAF)} .mdag-content` })));
            await settle(page);
            expect(await textSelection(page), modifier).toBe('');
        }

        for (const modifier of MODIFIERS) {
            const from = await spot(page, { on: 'element', selector: `${nodeSelector(TASK_A)} .mdag-box` });
            const to = await spot(page, { on: 'element', selector: `${nodeSelector(LEAF)} .mdag-box` });
            await withModifier(page, modifier, () =>
                dragFrom(page, from, to, async () => {
                    await settle(page);
                    await expect(page.locator('#a .mdag-node[data-drop-target]'), modifier).toHaveCount(0);
                }),
            );
            await settle(page);
            expect(await getSource(page), modifier).toBe(DOC);
            expect(await textSelection(page), modifier).toBe('');
        }
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor ルートは修飾キー +クリックで選択に入らず、理由の通知が出る (B-063)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await expect(snackbars(page)).toHaveCount(0);

        for (const [index, modifier] of MODIFIERS.entries()) {
            await pressNode(page, ROOT, modifier);
            if (index === 0) {
                await expect(snackbars(page), modifier).toHaveCount(1);
                expect(((await snackbars(page).textContent()) ?? '').trim(), modifier).not.toBe('');
            }
            await expectStillSelected(page, [TASK_A], modifier);
        }

        // 何も選んでいないときも入らない
        await pressBlank(page);
        await expectSelected(page, []);
        await pressNode(page, ROOT, MODIFIERS[0] ?? 'Shift');
        await expectStillSelected(page, []);
        expect(await getSource(page)).toBe(DOC);
    });
});

test.describe('複数の選択 (B-064、B-065、5.2 の軸 C)', () => {
    test('@editor 2 つ以上を選ぶと、それぞれに data-selected、全体を囲む外枠が 1 つ、帯 (data-for="nodes") に選んだ数と 合流ノードを作る、既存のノードへ合流、グループ、タグ追加、タグ選択、(区切り)、削除', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);

        // 1 つのときは外枠がない
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['node']);
        await expect(selectionBounds(page)).toHaveCount(0);

        for (const [added, selected] of [
            [TASK_C, [TASK_A, TASK_C]],
            [LEAF, [TASK_A, TASK_C, LEAF]],
        ] as const) {
            await pressNode(page, added, 'Shift');
            await expectSelected(page, [...selected]);
            await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['nodes']);
            const [bar] = await barsOf(page);
            expect(bar?.items).toEqual(NODES_BAR);
            expect(bar?.title).toMatch(countPattern(selected.length));

            await expect(selectionBounds(page)).toHaveCount(1);
            const boxes = await Promise.all(selected.map((id) => nodeBox(page, id)));
            const [bounds] = await rectsOf(page, '#a .mdag-editor-selection-bounds');
            for (const [index, box] of boxes.entries()) expect(encloses(bounds ?? { left: 0, top: 0, right: 0, bottom: 0 }, box), `ノード ${selected[index]}`).toBe(true);
            // 帯は選んだノードの全体の上
            expect(isAbove(bar?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }, union(boxes))).toBe(true);
        }

        // 修飾キーなしで押すと、そのノード 1 つになる
        await pressNode(page, BUILD);
        await expectSelected(page, [BUILD]);
        await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for)).toEqual(['node']);
        await expect(selectionBounds(page)).toHaveCount(0);
        expect(await getSource(page)).toBe(DOC);
    });
});

test.describe('何もないところのクリック (B-066)', () => {
    test('@editor 選択の道具で何もないところをクリックすると選択が解け、帯と印が消える。修飾キーつきでは解かない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNode(page, TASK_C, 'Shift');
        await expectSelected(page, [TASK_A, TASK_C]);

        for (const modifier of MODIFIERS) {
            await pressBlank(page, modifier);
            await expectStillSelected(page, [TASK_A, TASK_C], modifier);
        }
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(1);

        await pressBlank(page);
        await expectSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
        await expect(selectionBounds(page)).toHaveCount(0);

        await pressNode(page, TASK_B);
        await expectSelected(page, [TASK_B]);
        await pressBlank(page);
        await expectSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
    });

    test('@editor 手のひらでは何もないところをクリックしても、ドラッグしても選択は解けない', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await toolButton(page, 'hand').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await pressBlank(page);
        await expectStillSelected(page, [TASK_A]);
        const from = await spot(page, { on: 'blank', root: 'a' });
        await dragFrom(page, from, { x: from.x + 50, y: from.y + 30 });
        await expectStillSelected(page, [TASK_A]);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(1);
    });
});

test.describe('矢印キー (B-086〜B-091、B-23、request.md 3.2)', () => {
    test('@editor ← で親、→ で子のうち画面でいちばん上のものを選ぶ。ページはスクロールしない (B-086、B-087)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, TASK_B);
        await expectSelected(page, [TASK_B]);
        expect(await focusOf(page)).toBe('#a');

        await page.keyboard.press('ArrowLeft');
        await expectSelected(page, [DESIGN]);
        await page.keyboard.press('ArrowLeft');
        await expectSelected(page, [ROOT]);

        // いちばん上の子は図の矩形で決まる (この図ではどちらも文書の最初の子)
        const rootTop = await topChild(page, ROOT);
        expect(rootTop).toBe(DESIGN);
        await page.keyboard.press('ArrowRight');
        await expectSelected(page, [rootTop]);
        const designTop = await topChild(page, DESIGN);
        expect(designTop).toBe(TASK_A);
        await page.keyboard.press('ArrowRight');
        await expectSelected(page, [designTop]);

        expect(await scrollY(page)).toBe(0);
        expect(await getSource(page)).toBe(DOC);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor ↑ ↓ で兄弟を画面の上下の順に選び、端では反対の端へ回る。ページはスクロールしない (B-088)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);

        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        const tasks = await siblingsOnScreen(page, TASK_A);
        expect([...tasks].sort((a, b) => a - b)).toEqual([TASK_A, TASK_B, TASK_C]);
        const start = tasks.indexOf(TASK_A);
        const at = (offset: number): number => tasks[(start + offset + tasks.length * 2) % tasks.length] ?? 0;
        for (const [key, offset] of [
            ['ArrowDown', 1],
            ['ArrowDown', 2],
            ['ArrowDown', 3],
            ['ArrowUp', 2],
            ['ArrowUp', 1],
            ['ArrowUp', 0],
            ['ArrowUp', -1],
        ] as const) {
            await page.keyboard.press(key);
            await expectSelected(page, [at(offset)], `${key} → ${at(offset)}`);
        }

        await pressNode(page, DESIGN);
        await expectSelected(page, [DESIGN]);
        const heads = await siblingsOnScreen(page, DESIGN);
        expect(heads).toEqual([DESIGN, BUILD]);
        await page.keyboard.press('ArrowDown');
        await expectSelected(page, [BUILD]);
        await page.keyboard.press('ArrowDown');
        await expectSelected(page, [DESIGN]);
        await page.keyboard.press('ArrowUp');
        await expectSelected(page, [BUILD]);

        expect(await scrollY(page)).toBe(0);
    });

    test('@editor 何も選んでいなければ、矢印キーでカーソルにいちばん近いノードだけを選ぶ (B-089)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const [key, target] of [
            ['ArrowDown', LEAF],
            ['ArrowUp', TASK_A],
            ['ArrowLeft', LEAF],
            ['ArrowRight', TASK_A],
        ] as const) {
            await remount(page, DOC);
            const point = await nearPoint(page, target);
            // 描き直した図にポインタの動きが届くよう、図の外から動かして置く
            await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
            await page.mouse.move(point.x, point.y, { steps: 4 });
            await blurAll(page);
            await expectStillSelected(page, [], key);
            await page.keyboard.press(key);
            await expectSelected(page, [target], `${key} (${point.x}, ${point.y})`);
        }
    });

    test('@editor 何も選んでいなくてカーソルがウィンドウの外なら、矢印キーでルートを選ぶ (B-089)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        for (const [key, outside] of [
            ['ArrowDown', { x: -5, y: 300 }],
            ['ArrowRight', { x: 640, y: -10 }],
        ] as const) {
            await remount(page, DOC);
            // 道具箱のボタンを押すと、フォーカスは図の要素へ移る (選択は変わらない)
            await toolButton(page, 'hand').click();
            await expect.poll(() => focusOf(page)).toBe('#a');
            await page.mouse.move(outside.x, outside.y);
            await expectStillSelected(page, [], key);
            await page.keyboard.press(key);
            await expectSelected(page, [ROOT], key);
        }
    });

    test('@editor 矢印キーで選んだノードが図の領域の外なら、見える所まで図が動く (B-090)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await pressNode(page, DESIGN);
        await expectSelected(page, [DESIGN]);
        const first = await topChild(page, DESIGN);

        // 全部のノードを図の領域の下の外へ動かす
        await panBy(page, 0, 650);
        expect(await insideArea(page, first)).toBe(false);
        const panned = await transformOf(page);
        await page.keyboard.press('ArrowRight');
        await expectSelected(page, [first]);
        await expect.poll(() => insideArea(page, first)).toBe(true);
        expect((await transformOf(page)).k).toBeCloseTo(panned.k, 5);

        // 全部のノードを図の領域の右の外へ動かして ↓
        await panBy(page, 1100, 0);
        const next = (await siblingsOnScreen(page, first))[1];
        if (next === undefined) throw new Error('兄弟がない');
        expect(await insideArea(page, next)).toBe(false);
        await page.keyboard.press('ArrowDown');
        await expectSelected(page, [next]);
        await expect.poll(() => insideArea(page, next)).toBe(true);

        // 全部のノードを図の領域の上の外へ動かして ←
        await panBy(page, 0, -900);
        expect(await insideArea(page, DESIGN)).toBe(false);
        await page.keyboard.press('ArrowLeft');
        await expectSelected(page, [DESIGN]);
        await expect.poll(() => insideArea(page, DESIGN)).toBe(true);
    });

    test('@editor 閉じた枝のノードで → を押すと、枝が開き、開いて動き終えたあとの並びでいちばん上の子が選ばれ、図の領域に入る (B-090、B-23)', async ({ page }) => {
        await open(page);
        // 開くときの動き (子が親の位置から出てくる) を付けて描く
        await mount(page, DOC, { animate: true });
        await page.evaluate((id) => (window as unknown as EditorWindow).editors.a?.view.setFolded([id]), DESIGN);
        await expect.poll(() => getFolded(page)).toEqual([DESIGN]);
        await expect.poll(() => page.evaluate((id) => (window as unknown as EditorWindow).editors.a?.view.nodeRects([id]).size ?? -1, TASK_A)).toBe(0);
        await waitSettled(page);

        await pressNode(page, DESIGN);
        await expectSelected(page, [DESIGN]);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => getFolded(page)).toEqual([]);
        await waitSettled(page);
        const first = await topChild(page, DESIGN);
        expect(first).toBe(TASK_A);
        await expectSelected(page, [first]);
        await expect.poll(() => insideArea(page, first)).toBe(true);
    });

    test('@editor 複数を選んでいるときの矢印キーは、最後に選んだノードから動き、1 つの選択になる (B-091)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const tasks = await siblingsOnScreen(page, TASK_A);
        const above = (id: number): number => tasks[(tasks.indexOf(id) - 1 + tasks.length) % tasks.length] ?? 0;

        // 最後に選んだのは Task C
        await pressNode(page, TASK_A);
        await pressNode(page, TASK_C, 'Shift');
        await expectSelected(page, [TASK_A, TASK_C]);
        await page.keyboard.press('ArrowUp');
        await expectSelected(page, [above(TASK_C)]);

        // 最後に選んだのは Task A
        await pressNode(page, TASK_C);
        await pressNode(page, TASK_A, 'Shift');
        await expectSelected(page, [TASK_A, TASK_C]);
        await page.keyboard.press('ArrowUp');
        await expectSelected(page, [above(TASK_A)]);

        // ← は最後に選んだノードの親
        await pressNode(page, BUILD);
        await pressNode(page, TASK_B, 'Shift');
        await expectSelected(page, [TASK_B, BUILD]);
        await page.keyboard.press('ArrowLeft');
        await expectSelected(page, [DESIGN]);
    });
});

test.describe('Esc (B-047)', () => {
    test('@editor Esc で選択が解け、帯、外枠、印が消える (1 つと 2 つ以上)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await page.keyboard.press('Escape');
        await expectSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);

        await pressNode(page, TASK_A);
        await pressNode(page, LEAF, 'Shift');
        await expectSelected(page, [TASK_A, LEAF]);
        await expect(selectionBounds(page)).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expectSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
        await expect(selectionBounds(page)).toHaveCount(0);
        expect(await getSource(page)).toBe(DOC);
    });
});

test.describe('案内 (B-085)', () => {
    test('@editor 案内の中身が選択で変わり、選択を解くと戻る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await expect(hint(page)).toHaveCount(1);
        const idle = await hintText(page);
        expect(idle).not.toBe('');

        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await expect.poll(() => hintText(page)).not.toBe(idle);
        expect(await hintText(page)).not.toBe('');

        await pressBlank(page);
        await expectSelected(page, []);
        await expect.poll(() => hintText(page)).toBe(idle);
    });
});

test.describe('onSelectionChange と getSelection (1.2)', () => {
    test('@editor 選択が変わるたびに onSelectionChange が呼ばれ、最後の値が getSelection と同じ。ノードは図の id と refText', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        await useSelectTool(page);

        const steps: Array<{ name: string; act: () => Promise<void>; expected: EditSelection }> = [
            { name: 'ノードを押す', act: () => pressNode(page, TASK_A), expected: nodesSelection([TASK_A]) },
            { name: 'Shift +クリック', act: () => pressNode(page, TASK_C, 'Shift'), expected: nodesSelection([TASK_A, TASK_C]) },
            { name: '矩形', act: () => marqueeSelect(page, [LEAF]), expected: nodesSelection([LEAF]) },
            { name: '←', act: () => page.keyboard.press('ArrowLeft'), expected: nodesSelection([BUILD]) },
            { name: 'Esc', act: () => page.keyboard.press('Escape'), expected: { kind: 'none' } },
            { name: 'ノードを押す (2)', act: () => pressNode(page, TASK_B), expected: nodesSelection([TASK_B]) },
            { name: '何もないところ', act: () => pressBlank(page), expected: { kind: 'none' } },
        ];
        let count = (await selectionLog(page)).length;
        for (const step of steps) {
            await step.act();
            await expect.poll(async () => (await selectionLog(page)).length, step.name).toBeGreaterThan(count);
            await expect.poll(async () => normalized((await selectionLog(page)).at(-1) ?? { kind: 'none' }), step.name).toEqual(step.expected);
            expect(await getSelection(page), step.name).toEqual(step.expected);
            count = (await selectionLog(page)).length;
        }
    });
});

test.describe('閲覧 (B-169、B-171)', () => {
    test('@editor 閲覧だけの文書では、ノードを押しても、何もないところからドラッグしても、矢印キーを押しても選ばれず、帯と選択の印がなく、onSelectionChange は呼ばれない', async ({ page }) => {
        await open(page);
        await mount(page, DOC_VIEW);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('view');

        await pressNode(page, TASK_A);
        await pressNode(page, TASK_C, 'Shift');
        const from = await spot(page, { on: 'blank', root: 'a' });
        await dragFrom(page, from, { x: from.x + 120, y: from.y + 80 }, async () => {
            await settle(page);
            await expect(marquees(page)).toHaveCount(0);
        });
        await pointerOverBlankAndPress(page, ['ArrowDown', 'ArrowRight', 'Escape']);
        await expectStillSelected(page, []);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
        await expect(selectionBounds(page)).toHaveCount(0);
        expect(await selectionLog(page)).toEqual([]);
        expect(await getSource(page)).toBe(DOC_VIEW);
    });

    test('@editor GUI 編集から閲覧へ切り替えると選択が解け、帯、外枠、印が消えて onSelectionChange が呼ばれる。GUI 編集へ戻っても選択は戻らない (B-171、5.3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SWITCH);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('edit');
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNode(page, LEAF, 'Shift');
        await expectSelected(page, [TASK_A, LEAF]);
        await expect(selectionBounds(page)).toHaveCount(1);

        expect(await setMode(page, 'view')).toBe(true);
        await expectSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
        await expect(selectionBounds(page)).toHaveCount(0);
        await expect.poll(async () => normalized((await selectionLog(page)).at(-1) ?? nodesSelection([]))).toEqual({ kind: 'none' });

        expect(await setMode(page, 'edit')).toBe(true);
        await expectStillSelected(page, []);
        await expect(visible(page, '#a .mdag-editor-bar')).toHaveCount(0);
    });
});

test.describe('原文の欄からのフォーカス (B-059)', () => {
    test('@editor 原文の欄にフォーカスがあるままノードを押すと、ノードが選ばれてフォーカスが図へ移り、矢印キーが図に効く', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await addSourceField(page);
        await page.locator('#source').click();
        await page.keyboard.type('abc');
        expect(await focusOf(page)).toBe('#source');

        await pressNode(page, TASK_A);
        await expectSelected(page, [TASK_A]);
        await expect.poll(() => focusOf(page)).toBe('#a');
        await page.keyboard.press('ArrowDown');
        await expectSelected(page, [(await siblingsOnScreen(page, TASK_A))[1] ?? 0]);
        expect(await focusOf(page)).toBe('#a');
        expect(await page.locator('#source').inputValue()).toBe('abc');
    });
});

// ポインタを図の何もないところに置いてからキーを押す (閲覧で、キーが図に届く形にしても効かないことを見る)
async function pointerOverBlankAndPress(page: Page, keys: string[]): Promise<void> {
    const blank = await spot(page, { on: 'blank', root: 'a' });
    await page.mouse.move(blank.x, blank.y);
    for (const key of keys) await page.keyboard.press(key);
}

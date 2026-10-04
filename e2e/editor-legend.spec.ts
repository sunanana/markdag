// GUI 編集の凡例のパネル「線の色・グループ」を、ビルドした配布物の markdag/editor で確かめる。
// 線の色の段とグループの段 (ロゴ、色、枠の表示、行のボタン)、addToGroup、groupNodes、defineGroup、renameGroup、setGroupColor、
// setGroupBoundary、ungroup の選び直しと名前の入力、カラーピッカー、開閉と閲覧での出し方、隅の規則を見る。
// パネルの形は、依頼者が見た目の案を 2 つ組み合わせて決めたもの。
// 見た目そのもの (色の値、余白、影、アイコンの形) は見ない。パネル、段、行の有無と数、data- の値、開閉の状態、ボタンの有無、
// 書き換えたあとの原文の全文、onChange の呼ばれ方、図の側の凡例 (.mdag-legend) が出ないこと、閲覧での出し方を見る。
// 期待の原文はグループの書き換えと frontmatter の書き換えの規則から書いた (文書の組み立ては docOf)。配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「出ない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, EditSelection, NodeTarget } from '../src/core';
import type { EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';

interface ChangeEntry {
    root: string;
    markdown: string;
}

interface SelectionEntry {
    root: string;
    selection: EditorSelection;
}

interface PendingIcon {
    ref: string;
    resolve: (svg: string | null) => void;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: ChangeEntry[];
    // onSelectionChange に届いた選択 (呼ばれた順)
    selections: SelectionEntry[];
    // view の onSelectGroup に届いたグループ (解いたときは null。呼ばれた順)
    groupKeys: Record<string, Array<string | null>>;
    // 止めておいた resolveIcon の Promise
    pending: PendingIcon[];
    // 要素が見えているか (display、visibility、opacity のどれでも隠していない、大きさがある)。行のボタンをどの書き方で隠してもよいように、3 つとも見る
    isShown: (element: Element) => boolean;
};

const DIST = resolve('dist');

// ロゴ。id を持たない SVG (写しごとの id の付け替えが起きないので、行のロゴと groupLogo の写しを isEqualNode で比べられる)
const LOGO_REF = 'simple-icons:github';
const LOGO_SVG = '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
const ICON_LINES = [`gh: ${LOGO_REF}`, 'fire: "🔥"'];

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];
const SWITCH_VIEW = ['mode: switch', 'default: view'];

interface GroupSpec {
    id: string;
    label: string;
    color?: string;
    boundary?: boolean;
    icon?: string;
}

interface DocSpec {
    // markdag.editor の下の行 (editor の下の字下げからの相対)。省くと editor のキーを書かない (閲覧だけ)
    editor?: string[];
    // markdag.legend の下の行
    legend?: string[];
    // markdag.branches の起点の名前
    branches?: string[];
    // markdag.icons の下の行
    icons?: string[];
    groups?: GroupSpec[];
    body?: string[];
}

// 文書を組み立てる。markdag の下のキーの並びは edgeHighlight、icons、branches、legend、groups、editor
function docOf(spec: DocSpec): string {
    const lines = ['---', 'markdag:', '    edgeHighlight: true'];
    const under = (key: string, items: string[] | undefined): void => {
        if (items) lines.push(`    ${key}:`, ...items.map((item) => `        ${item}`));
    };
    under('icons', spec.icons);
    under('branches', spec.branches?.map((name) => `- ${name}`));
    under('legend', spec.legend);
    if (spec.groups && spec.groups.length > 0) {
        lines.push('    groups:');
        for (const group of spec.groups) {
            lines.push(`        ${group.id}:`, `            label: ${group.label}`);
            if (group.color !== undefined) lines.push(`            color: "${group.color}"`);
            if (group.boundary !== undefined) lines.push(`            boundary: ${String(group.boundary)}`);
            if (group.icon !== undefined) lines.push(`            icon: ${group.icon}`);
        }
    }
    under('editor', spec.editor);
    return [...lines, '---', '', ...(spec.body ?? GROUPED_BODY)].join('\n');
}

// 本文の行の末尾に印を足す
function marked(body: string[], marks: Record<string, string>): string[] {
    return body.map((line) => (marks[line] === undefined ? line : `${line} ${marks[line]}`));
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const BUILD = 5;
const LEAF = 6;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Build', 6: 'Leaf' };

// Design と配下 (2〜4) がグループ design (設計) に、Build と配下 (5、6) がグループ build (実装) に入る。枝の起点は Design と Build
const GROUPED_BODY = marked(BODY, { '## Design': '%design', '## Build': '%build' });
const DESIGN_MEMBERS = [DESIGN, TASK_A, TASK_B];
const BUILD_MEMBERS = [BUILD, LEAF];
const BRANCH_NAMES = ['Design', 'Build'];
const DESIGN_GROUP: GroupSpec = { id: 'design', label: '設計', color: '#3B7DD8', boundary: true };
const BUILD_GROUP: GroupSpec = { id: 'build', label: '実装', color: '#E8833A', boundary: true };
const GROUPS: GroupSpec[] = [DESIGN_GROUP, BUILD_GROUP];

const fullDoc = (editor: string[] | undefined, extra: Partial<DocSpec> = {}): string => docOf({ editor, branches: BRANCH_NAMES, groups: GROUPS, ...extra });

const DOC_EDIT = fullDoc(EDIT);
const DOC_VIEW = fullDoc(undefined);
const DOC_SWITCH = fullDoc(SWITCH_EDIT);
const DOC_EDIT_CLOSED = fullDoc(EDIT, { legend: ['display: false'] });
// build の枠を隠した文書
const DOC_HIDDEN = fullDoc(EDIT, { groups: [DESIGN_GROUP, { ...BUILD_GROUP, boundary: false }] });

// 新しいグループ: 使われていない最小の番号の group1、label「グループ 1」、決まった色の 1 つ目、boundary: true。
// 定義は markdag.groups の末尾に足す
const NEW_GROUP: GroupSpec = { id: 'group1', label: 'グループ 1', color: '#3B7DD8', boundary: true };

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
        target.groupKeys = {};
        target.pending = [];
        target.isShown = (element: Element): boolean => {
            if (!element.isConnected || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
    });
}

// resolveIcon の渡し方。none は渡さない、sync はすぐ SVG を返す、pending は Promise を返して解決を resolvePending まで止める
type IconMode = 'none' | 'sync' | 'pending';

async function mount(page: Page, markdown: string, icons: IconMode = 'none'): Promise<void> {
    await page.evaluate(
        ({ markdown, icons, svg }) => {
            const target = window as unknown as EditorWindow;
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
            if (icons === 'sync') options.resolveIcon = () => svg;
            if (icons === 'pending') options.resolveIcon = (ref: string) => new Promise<string | null>((resolve) => void target.pending.push({ ref, resolve }));
            const editor = target.editorHarness.editor.mountEditor(container, markdown, options);
            target.editors.a = editor;
            const keys: Array<string | null> = [];
            target.groupKeys.a = keys;
            editor.view.addHooks({
                onSelectGroup: (id) => {
                    keys.push(id);
                },
            });
        },
        { markdown, icons, svg: LOGO_SVG },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す。onChange と onSelectionChange の記録も空にする
async function remount(page: Page, markdown: string, icons: IconMode = 'none'): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
        target.selections = [];
        target.pending = [];
    });
    await mount(page, markdown, icons);
}

// 「変わらない」「呼ばれない」「出ない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const selectionLog = (page: Page): Promise<EditorSelection[]> => page.evaluate(() => (window as unknown as EditorWindow).selections.map((entry) => entry.selection));

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());

const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const setSource = async (page: Page, markdown: string): Promise<void> => {
    await page.evaluate((markdown) => void (window as unknown as EditorWindow).editors.a?.setSource(markdown), markdown);
};

const callUndo = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo());

const getSelection = (page: Page): Promise<EditorSelection | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection());

// view の onSelectGroup に最後に届いたグループ (届いていなければ undefined)
const lastGroupKey = (page: Page): Promise<string | null | undefined> => page.evaluate(() => (window as unknown as EditorWindow).groupKeys.a?.at(-1));

// 止めておいた resolveIcon の Promise を全部 svg で解決する。解決した数を返す
const resolvePending = (page: Page, svg: string | null): Promise<number> =>
    page.evaluate((svg) => {
        const pending = (window as unknown as EditorWindow).pending.splice(0);
        for (const item of pending) item.resolve(svg);
        return pending.length;
    }, svg);

interface GroupRowModel {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
}

// 描いている文書のモデルの groups と、グループごとに入っているノードの数 (groupsOf でそのグループを持つノードの数)
const groupModelOf = (page: Page): Promise<{ groups: GroupRowModel[]; counts: Record<string, number> }> =>
    page.evaluate(() => {
        const model = (window as unknown as EditorWindow).editors.a?.view.getDocument()?.model;
        if (!model) return { groups: [], counts: {} };
        const counts: Record<string, number> = {};
        for (const group of model.groups) counts[group.id] = [...model.groupsOf.values()].filter((ids) => ids.includes(group.id)).length;
        return { groups: model.groups.map(({ id, label, color, boundary }) => ({ id, label, color, boundary })), counts };
    });

// branchColors の名前の並び
const branchLabels = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.branchColors().map((branch) => branch.label) ?? []);

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const frameSelector = (group: string): string => `#a .mdag-frame[data-group="${group}"]`;
const frameLabelSelector = (group: string): string => `#a .mdag-frame-label[data-group="${group}"]`;
const frames = (page: Page, group: string) => page.locator(frameSelector(group));

const PANEL = '#a .mdag-editor-legend';
const HEAD = `${PANEL} .mdag-editor-legend-head`;
const NEW_BUTTON = `${PANEL} .mdag-editor-legend-new`;
const groupRowSelector = (group: string): string => `${PANEL} .mdag-editor-legend-row[data-group="${group}"]`;
// 行の中の名前でない所 (色の四角、数、操作ボタン)
const ROW_PARTS = '.mdag-editor-legend-chip, .mdag-editor-legend-count, .mdag-editor-legend-action';

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 名前の入力の外 (図の外の原文の欄の代わり) へフォーカスを移す (フォーカスが外へ移ると名前を決める)
async function focusOutside(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('source')) return;
        const field = document.createElement('textarea');
        field.id = 'source';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
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

async function nodeBox(page: Page, id: number): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
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

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank' }
    // 要素 (か中の要素) が表に出ている点。exclude に当たる要素の上の点は除く
    | { on: 'element'; selector: string; exclude?: string };

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
        const element = [...document.querySelectorAll(target.selector)].find((item) => (window as unknown as EditorWindow).isShown(item));
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return (
            grid(rect, Math.max(1, Math.min(rect.width, rect.height) / 8)).find((point) => {
                const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                return hit !== null && element.contains(hit) && (target.exclude === undefined || hit.closest(target.exclude) === null);
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

const boxPoint = (page: Page, id: number): Promise<Point> => spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` });

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await boxPoint(page, id));
}

// 修飾キーを押したままノードの箱を押す (選択に足す)
async function pressNodeWith(page: Page, id: number, modifier: string): Promise<void> {
    const point = await boxPoint(page, id);
    await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        await page.keyboard.up(modifier);
    }
}

async function pressBlank(page: Page): Promise<void> {
    await press(page, await spot(page, { on: 'blank' }));
}

async function pointerOverBlank(page: Page): Promise<void> {
    const blank = await spot(page, { on: 'blank' });
    await page.mouse.move(blank.x, blank.y);
}

async function pressFrame(page: Page, group: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: frameSelector(group) }));
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

// パネルの見出しの、「新規」でない所を押す (GUI 編集では開閉する)
async function pressHead(page: Page): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: HEAD, exclude: '.mdag-editor-legend-new' }));
}

async function pressNew(page: Page): Promise<void> {
    await expect.poll(() => shownCount(page, NEW_BUTTON), '「新規」が見えている').toBe(1);
    await press(page, await spot(page, { on: 'element', selector: NEW_BUTTON }));
}

// 凡例の行の名前の文字の上の点 (色の四角、数、操作ボタンの上は除く)。名前のクリックとダブルクリックに使う
async function rowNamePoint(page: Page, group: string, label: string): Promise<Point> {
    const found = await page.evaluate(
        ({ selector, label, parts }) => {
            const w = window as unknown as EditorWindow;
            const row = [...document.querySelectorAll(selector)].find((item) => w.isShown(item));
            if (!row) return null;
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
                if (!(text.textContent ?? '').includes(label) || text.parentElement?.closest(parts)) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                for (const rect of range.getClientRects()) {
                    for (const fy of [0.5, 0.3, 0.7]) {
                        for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
                            const x = rect.left + rect.width * fx;
                            const y = rect.top + rect.height * fy;
                            const hit = document.elementFromPoint(x, y);
                            if (hit && row.contains(hit) && !hit.closest(parts)) return { x, y };
                        }
                    }
                }
            }
            return null;
        },
        { selector: groupRowSelector(group), label, parts: ROW_PARTS },
    );
    if (!found) throw new Error(`グループ ${group} の行に名前「${label}」を押せる点がない`);
    return found;
}

async function hoverRow(page: Page, group: string, label: string): Promise<void> {
    const point = await rowNamePoint(page, group, label);
    await page.mouse.move(point.x, point.y);
}

async function pressRow(page: Page, group: string, label: string): Promise<void> {
    await press(page, await rowNamePoint(page, group, label));
}

// 行の操作ボタンを押す。ポインタを行に乗せてボタンが見えるのを待ってから押す
async function pressAction(page: Page, group: string, label: string, action: 'add' | 'boundary' | 'delete'): Promise<void> {
    await hoverRow(page, group, label);
    const selector = `${groupRowSelector(group)} .mdag-editor-legend-action[data-action="${action}"]`;
    await expect.poll(() => shownCount(page, selector), `${group} の ${action} が見える`).toBe(1);
    await press(page, await spot(page, { on: 'element', selector }));
}

async function pressChip(page: Page, group: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${groupRowSelector(group)} .mdag-editor-legend-chip` }));
}

// 見えている要素の数
const shownCount = (page: Page, selector: string): Promise<number> =>
    page.evaluate((selector) => [...document.querySelectorAll(selector)].filter((element) => (window as unknown as EditorWindow).isShown(element)).length, selector);

interface PanelState {
    // .mdag-editor-legend の要素の数 (見えているかによらない) と、見えている数
    panels: number;
    shown: number;
    // data-open の有無 (値が "false" なら閉じているとみなす)
    open: boolean;
    head: string;
    // 見えている段の data-section (DOM の並び)
    sections: string[];
    // 入っている隅の入れ物の data-corner
    corner: string | null;
    // 図の側の凡例: 行の数と、見えている要素の数
    legacyItems: number;
    legacyShown: number;
}

async function panelOf(page: Page): Promise<PanelState> {
    return page.evaluate(() => {
        const w = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const panels = [...container.querySelectorAll('.mdag-editor-legend')];
        const panel = panels.find((item) => w.isShown(item)) ?? null;
        const flag = (element: Element | null, name: string): boolean => element !== null && element.hasAttribute(name) && element.getAttribute(name) !== 'false';
        return {
            panels: panels.length,
            shown: panels.filter((item) => w.isShown(item)).length,
            open: flag(panel, 'data-open'),
            head: (panel?.querySelector('.mdag-editor-legend-head')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            sections: panel ? [...panel.querySelectorAll('.mdag-editor-legend-section')].filter((section) => w.isShown(section)).map((section) => section.getAttribute('data-section') ?? '') : [],
            corner: panel?.closest('.mdag-editor-corner')?.getAttribute('data-corner') ?? null,
            legacyItems: container.querySelectorAll('.mdag-legend li').length,
            legacyShown: [...container.querySelectorAll('.mdag-legend')].filter((item) => w.isShown(item)).length,
        };
    });
}

// パネルが 1 枚見えていて、開閉と見えている段が open と sections になるまで待つ。図の側の凡例はない
async function expectPanel(page: Page, open: boolean, sections: string[], message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await panelOf(page);
            return { shown: state.shown, open: state.open, sections: state.sections, legacy: state.legacyItems + state.legacyShown };
        }, message)
        .toEqual({ shown: 1, open, sections, legacy: 0 });
}

// 閲覧のパネル: 1 枚見えていて、見えている段が sections になるまで待つ (開閉の印は見ない。閲覧は開閉しない)。図の側の凡例はない
async function expectViewPanel(page: Page, sections: string[], message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await panelOf(page);
            return { shown: state.shown, sections: state.sections, legacy: state.legacyItems + state.legacyShown };
        }, message)
        .toEqual({ shown: 1, sections, legacy: 0 });
}

// パネルが見えていない (数コマ待ってから)。図の側の凡例もない
async function expectNoPanel(page: Page, message?: string): Promise<void> {
    await settle(page);
    const state = await panelOf(page);
    expect({ shown: state.shown, legacy: state.legacyItems + state.legacyShown }, message).toEqual({ shown: 0, legacy: 0 });
}

interface GroupRowState {
    id: string;
    text: string;
    // .mdag-editor-legend-count の数
    count: number | null;
    selected: boolean;
    // 見えている操作ボタンの data-action (並べ替えたもの) と、押せないもの
    actions: string[];
    disabled: string[];
}

// グループの段の見えている行 (DOM の並び)
async function groupRowsOf(page: Page): Promise<GroupRowState[]> {
    return page.evaluate((panelSelector) => {
        const w = window as unknown as EditorWindow;
        const panel = [...document.querySelectorAll(panelSelector)].find((item) => w.isShown(item));
        if (!panel) return [];
        const flag = (element: Element, name: string): boolean => element.hasAttribute(name) && element.getAttribute(name) !== 'false';
        return [...panel.querySelectorAll('.mdag-editor-legend-row[data-group]')]
            .filter((row) => w.isShown(row))
            .map((row) => {
                const countElement = row.querySelector('.mdag-editor-legend-count');
                const countText = (countElement?.textContent ?? '').trim();
                const actions = [...row.querySelectorAll('.mdag-editor-legend-action')].filter((action) => w.isShown(action));
                const disabled = (action: Element): boolean => (action instanceof HTMLButtonElement && action.disabled) || action.getAttribute('aria-disabled') === 'true';
                return {
                    id: row.getAttribute('data-group') ?? '',
                    text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    count: countElement && countText !== '' ? Number(countText) : null,
                    selected: flag(row, 'data-selected'),
                    actions: actions.map((action) => action.getAttribute('data-action') ?? '').sort(),
                    disabled: actions
                        .filter(disabled)
                        .map((action) => action.getAttribute('data-action') ?? '')
                        .sort(),
                };
            });
    }, PANEL);
}

// 行ごとの見えている操作ボタン
async function actionsByRow(page: Page): Promise<Record<string, string[]>> {
    return Object.fromEntries((await groupRowsOf(page)).map((row) => [row.id, row.actions]));
}

const ALL_ACTIONS = ['add', 'boundary', 'delete'];

interface BranchRowState {
    text: string;
    rect: Box;
}

// 線の色の段の見えている行 (DOM の並び)
async function branchRowsOf(page: Page): Promise<BranchRowState[]> {
    return page.evaluate((panelSelector) => {
        const w = window as unknown as EditorWindow;
        const panel = [...document.querySelectorAll(panelSelector)].find((item) => w.isShown(item));
        const section = panel ? [...panel.querySelectorAll('.mdag-editor-legend-section[data-section="branches"]')].find((item) => w.isShown(item)) : undefined;
        if (!section) return [];
        return [...section.querySelectorAll('.mdag-editor-legend-row')]
            .filter((row) => w.isShown(row))
            .map((row) => {
                const rect = row.getBoundingClientRect();
                return { text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
            });
    }, PANEL);
}

// 線の色の段の行が、branchColors の名前を 1 行に 1 つずつ同じ並びで持ち、縦に並ぶ (次の行は前の行の下にあり、左右で重なる)
async function expectBranchRows(page: Page, labels: string[], message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const rows = await branchRowsOf(page);
            return {
                texts: rows.map((row, index) => (row.text.includes(labels[index] ?? '\u0000') && labels.every((other, at) => at === index || !row.text.includes(other)) ? labels[index] : row.text)),
                stacked: rows.every((row, index) => {
                    const previous = rows[index - 1];
                    return !previous || (row.rect.top >= previous.rect.bottom - 1 && row.rect.left < previous.rect.right && row.rect.right > previous.rect.left);
                }),
            };
        }, message)
        .toEqual({ texts: labels, stacked: true });
}

// 見えているボタン類の数 (button、入力欄、role="button")。exclude に当たるものは数えない
const shownControlsIn = (page: Page, selector: string, exclude?: string): Promise<number> =>
    page.evaluate(
        ({ selector, exclude }) => {
            const w = window as unknown as EditorWindow;
            return [...document.querySelectorAll(selector)]
                .filter((root) => w.isShown(root))
                .flatMap((root) => [...(root.matches('button, [role="button"]') ? [root] : []), ...root.querySelectorAll('button, input, select, textarea, [role="button"]')])
                .filter((element) => w.isShown(element) && (exclude === undefined || element.closest(exclude) === null)).length;
        },
        { selector, exclude },
    );

// 行の見た目のうち、ポインタを乗せると変わりうるもの (閲覧でホバーの効果がないことを比べる。値そのものは見ない)
const rowLook = (page: Page, group: string): Promise<string> =>
    page.evaluate((selector) => {
        const row = document.querySelector(selector);
        if (!row) return '';
        const parts = [row, ...row.querySelectorAll('*')];
        return parts
            .map((element) => {
                const style = getComputedStyle(element);
                return [style.backgroundColor, style.color, style.borderColor, style.boxShadow, style.outlineStyle, style.opacity, style.textDecorationLine, style.cursor, style.visibility, style.display].join('|');
            })
            .join('\n');
    }, groupRowSelector(group));

interface PickerState {
    // 見えているカラーピッカーの数
    shown: number;
    swatches: string[];
    hex: number;
    // ブラウザの色選び (input[type="color"]。見え方によらず数える)
    native: number;
}

async function pickerOf(page: Page): Promise<PickerState> {
    return page.evaluate(() => {
        const w = window as unknown as EditorWindow;
        const pickers = [...document.querySelectorAll('#a .mdag-editor-color-picker')].filter((picker) => w.isShown(picker));
        const picker = pickers[0];
        return {
            shown: pickers.length,
            swatches: picker ? [...picker.querySelectorAll('.mdag-editor-swatch[data-color]')].filter((swatch) => w.isShown(swatch)).map((swatch) => swatch.getAttribute('data-color') ?? '') : [],
            hex: picker ? [...picker.querySelectorAll('.mdag-editor-hex')].filter((hex) => w.isShown(hex)).length : 0,
            native: picker ? picker.querySelectorAll('input[type="color"]').length : 0,
        };
    });
}

async function expectPickerClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await pickerOf(page)).shown, message).toBe(0);
}

// 行のロゴ: groupLogo があるか、その SVG があるか、行の中に groupLogo と同じ要素 (isEqualNode) があるか
async function rowLogoOf(page: Page, group: string): Promise<{ logo: boolean; svg: boolean; inRow: boolean }> {
    return page.evaluate((group) => {
        const w = window as unknown as EditorWindow;
        const logo = w.editors.a?.view.groupLogo(group) ?? null;
        const row = [...document.querySelectorAll(`#a .mdag-editor-legend .mdag-editor-legend-row[data-group="${group}"]`)].find((item) => w.isShown(item));
        return {
            logo: logo !== null,
            svg: logo?.querySelector('svg') != null,
            inRow: logo !== null && row !== undefined && [...row.querySelectorAll('*')].some((element) => element.isEqualNode(logo)),
        };
    }, group);
}

const target = (id: number): NodeTarget => ({ id, refText: REF_TEXTS[id] ?? '' });

const sortedTargets = (targets: readonly NodeTarget[]): NodeTarget[] => [...targets].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }));

function normalized(selection: EditorSelection): EditorSelection {
    return selection.kind === 'nodes' ? { kind: 'nodes', nodes: sortedTargets(selection.nodes) } : selection;
}

interface SelectionState {
    marked: number[];
    faded: number[];
    selection: EditorSelection;
}

async function selectionOf(page: Page): Promise<SelectionState> {
    const state = await page.evaluate(() => {
        const container = document.getElementById('a');
        const editor = (window as unknown as EditorWindow).editors.a;
        if (!container || !editor) throw new Error('#a の図がない');
        const ids = (selector: string): number[] =>
            [...container.querySelectorAll(selector)].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        return { marked: ids('.mdag-node[data-selected]'), faded: ids('.mdag-node[data-faded]'), selection: editor.getSelection() };
    });
    return { ...state, selection: normalized(state.selection) };
}

async function expectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const sorted = sortedTargets(ids.map(target));
    const selection: EditSelection = sorted.length === 0 ? { kind: 'none' } : { kind: 'nodes', nodes: sorted };
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), faded: [], selection });
}

async function expectNothingSelected(page: Page, message?: string): Promise<void> {
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: [], faded: [], selection: { kind: 'none' } });
}

// グループが選ばれるまで待つ: getSelection がそのグループ、view の selectGroup がそのグループ、ノードの印はなく、
// 図の強調でメンバーは薄くならず、outsider (グループの外で線でもつながらないノード) は薄くなる
async function expectGroupSelected(page: Page, group: string, members: number[], outsider: number, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await selectionOf(page);
            return {
                marked: state.marked,
                selection: state.selection,
                viewKey: await lastGroupKey(page),
                fadedMembers: members.filter((id) => state.faded.includes(id)),
                outsiderFaded: state.faded.includes(outsider),
            };
        }, message)
        .toEqual({ marked: [], selection: { kind: 'group', id: group }, viewKey: group, fadedMembers: [], outsiderFaded: true });
}

async function lastSelectionChange(page: Page): Promise<EditorSelection | null> {
    const last = (await selectionLog(page)).at(-1);
    return last === undefined ? null : normalized(last);
}

async function expectSource(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await expect.poll(() => getSource(page), message).toBe(source);
    await expect.poll(() => changeLog(page), message).toEqual(changes);
}

async function expectSourceStill(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await settle(page);
    expect(await getSource(page), message).toBe(source);
    expect(await changeLog(page), message).toEqual(changes);
}

async function expectNotice(page: Page, kind?: 'info' | 'error', message?: string): Promise<string> {
    const shown = kind ? visible(page, `#a .mdag-editor-snackbar[data-kind="${kind}"]`) : snackbars(page);
    await expect(shown, message).toHaveCount(1);
    const text = ((await shown.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(text, message).not.toBe('');
    return text;
}

interface BarInfo {
    for: string | null;
    items: string[];
    disabled: string[];
    title: string;
    rect: Box;
}

async function barsOf(page: Page): Promise<BarInfo[]> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const shown = (element: Element): boolean => element.checkVisibility();
        return [...container.querySelectorAll('.mdag-editor-bar')].filter(shown).map((bar) => {
            const items = [...bar.querySelectorAll('.mdag-editor-bar-title, .mdag-editor-bar-button')].filter(shown);
            const kindOf = (item: Element): string => (item.classList.contains('mdag-editor-bar-title') ? 'title' : (item.getAttribute('data-command') ?? ''));
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
    });
}

// グループの帯が 1 つだけ見えていて、名前の欄に label が入り、相手の上か下にあるまで待つ
async function expectGroupBar(page: Page, label: string, area: () => Promise<Box>, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const shown = await barsOf(page);
            const bar = shown[0];
            if (shown.length !== 1 || !bar) return { count: shown.length };
            const target = await area();
            return { count: 1, for: bar.for, items: bar.items, titled: bar.title.includes(label), placed: isAbove(bar.rect, target) || isBelow(bar.rect, target) };
        }, message)
        .toEqual({ count: 1, for: 'group', items: ['title', 'rename-group', 'ungroup'], titled: true, placed: true });
}

interface NameInputState {
    count: number;
    value: string | null;
    focused: boolean;
    rect: Box | null;
}

// グループの名前の入力 (.mdag-editor-name-input[data-for="group"])。要素そのものが入力欄でも、その中に入力欄があってもよい
async function groupInputOf(page: Page): Promise<NameInputState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...container.querySelectorAll('.mdag-editor-name-input[data-for="group"]')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false, rect: null };
        const outer = element.getBoundingClientRect();
        const rect = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, focused: false, rect };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
        return { count: 1, value, focused, rect };
    });
}

// グループの名前の入力が、凡例のパネルのそのグループの行の中に 1 つ開き (入力の矩形の中ほどが行の矩形の中)、フォーカスがあって、値が value になるまで待つ
async function expectGroupInputInRow(page: Page, group: string, value: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await groupInputOf(page);
            const [row] = await rectsOf(page, groupRowSelector(group));
            const rect = state.rect;
            const cx = rect === null ? 0 : (rect.left + rect.right) / 2;
            const cy = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const inRow = rect !== null && row !== undefined && cx >= row.left - 1 && cx <= row.right + 1 && cy >= row.top - 1 && cy <= row.bottom + 1;
            return { count: state.count, value: state.value, focused: state.focused, inRow };
        }, message)
        .toEqual({ count: 1, value, focused: true, inRow: true });
}

async function frameLabelBox(page: Page, group: string): Promise<Box | null> {
    return page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    }, frameLabelSelector(group));
}

// グループの名前の入力が枠のラベルの上に 1 つ開く (グループのテストと同じ読み)
async function expectGroupInputOnLabel(page: Page, group: string, value: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await groupInputOf(page);
            const label = await frameLabelBox(page, group);
            const rect = state.rect;
            const middle = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const onLabel = rect !== null && label !== null && rect.left < label.right && rect.right > label.left && middle >= label.top - 4 && middle <= label.bottom + 4;
            return { count: state.count, value: state.value, focused: state.focused, onLabel };
        }, message)
        .toEqual({ count: 1, value, focused: true, onLabel: true });
}

// 枠のないグループの名前の入力が、メンバーの全体の上に 1 つ開く (グループのテストと同じ読み)
async function expectGroupInputAbove(page: Page, members: number[], value: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await groupInputOf(page);
            const area = union(await Promise.all(members.map((id) => nodeBox(page, id))));
            const rect = state.rect;
            const above = rect !== null && rect.left < area.right && rect.right > area.left && (rect.top + rect.bottom) / 2 < area.top;
            return { count: state.count, value: state.value, focused: state.focused, above };
        }, message)
        .toEqual({ count: 1, value, focused: true, above: true });
}

async function expectGroupInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await groupInputOf(page)).count, message).toBe(0);
}

async function expectNoGroupInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await groupInputOf(page)).count, message).toBe(0);
}

// 名前の入力の値を全部選んで text を打つ
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await expect.poll(async () => (await groupInputOf(page)).value).toBe(text);
}

// 変換中のキー。Chromium の IME と同じく keyCode 229 で送る
async function pressComposing(client: CDPSession, key: 'Enter' | 'Escape'): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

// 色を書き換えた原文の候補。色の書き方 (大文字と小文字) は編集の層がそろえてもよいので、そのまま、大文字、小文字の 3 つを候補にする
async function colorSources(page: Page, source: string, group: string, color: string): Promise<string[]> {
    const variants = [...new Set([color, color.toUpperCase(), color.toLowerCase()])];
    const sources: string[] = [];
    for (const variant of variants) {
        const edited = editedSource(await tryEdit(page, source, { kind: 'setGroupColor', group, color: variant }));
        if (edited !== null) sources.push(edited);
    }
    if (sources.length === 0) throw new Error(`色 ${color} は setGroupColor で書けない`);
    return sources;
}

// 原文が候補のどれかになり、onChange の最後がその原文で、呼ばれた数が count になるまで待つ
async function expectSourceOneOf(page: Page, candidates: string[], count: number, message?: string): Promise<string> {
    await expect.poll(async () => candidates.includes((await getSource(page)) ?? ''), message).toBe(true);
    const source = (await getSource(page)) ?? '';
    await expect.poll(() => changeLog(page), message).toHaveLength(count);
    expect((await changeLog(page)).at(-1), message).toBe(source);
    return source;
}

// ---------------------------------------------------------------------------------------------------------------------

test.describe('パネルと図の凡例 (段 19。B-148、B-149、10.1 の 2、6.4)', () => {
    test('@editor mountEditor の図には、GUI 編集でも閲覧でも図の側の凡例 (.mdag-legend) がなく、凡例のパネル (.mdag-editor-legend) が 1 枚あって、見出しが「線の色・グループ」(B-148、B-149、10.1 の 2)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        for (const [markdown, mode] of [
            [DOC_EDIT, 'edit'],
            [DOC_VIEW, 'view'],
            [DOC_SWITCH, 'edit'],
        ] as const) {
            await remount(page, markdown);
            expect(await getMode(page), markdown).toBe(mode);
            await expect.poll(async () => (await panelOf(page)).panels, `${mode}: パネルの要素`).toBe(1);
            if (mode === 'edit') await expectPanel(page, true, ['branches', 'groups'], mode);
            else await expectViewPanel(page, ['branches', 'groups'], mode);
            expect((await panelOf(page)).head, mode).toContain('線の色・グループ');
        }
        // 切り替えの文書で閲覧へ替えても同じ (図の側の凡例は出ない)
        expect(await setMode(page, 'view')).toBe(true);
        await expectViewPanel(page, ['branches', 'groups'], '閲覧へ替えたあと');
        expect((await panelOf(page)).panels).toBe(1);
        expect((await panelOf(page)).head).toContain('線の色・グループ');
        expect(await setMode(page, 'edit')).toBe(true);
        await expectPanel(page, true, ['branches', 'groups'], 'GUI 編集に戻したあと');
        expect(errors).toEqual([]);
    });

    test('@editor GUI 編集では見出しを押すと開閉する (閉じると段が見えず、見出しは残る)。原文は変わらない (B-149、5.2 の軸 F)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await expectPanel(page, true, ['branches', 'groups'], '初め');

        await pressHead(page);
        await expectPanel(page, false, [], '1 回目');
        expect((await panelOf(page)).head).toContain('線の色・グループ');
        await pressHead(page);
        await expectPanel(page, true, ['branches', 'groups'], '2 回目');
        await expectSourceStill(page, DOC_EDIT, []);
        await expectNothingSelected(page);
    });
});

test.describe('段の並びと線の色の段 (段 19。B-150、B-151、6.4、10.1 の 2)', () => {
    test('@editor 上が線の色、下がグループ。線の色の段は branchColors の名前を同じ並びで 1 行に 1 つ、縦に並べ、グループの段は model.groups の並びで名前を出す。GUI 編集でも閲覧でも同じ (B-150、B-151、6.4)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SWITCH);
        const labels = await branchLabels(page);
        expect(labels).toEqual(BRANCH_NAMES);
        const groups = (await groupModelOf(page)).groups;
        expect(groups.map((group) => group.id)).toEqual(['design', 'build']);

        for (const mode of ['edit', 'view'] as const) {
            if (mode === 'view') expect(await setMode(page, 'view')).toBe(true);
            if (mode === 'edit') await expectPanel(page, true, ['branches', 'groups'], mode);
            else await expectViewPanel(page, ['branches', 'groups'], mode);
            await expectBranchRows(page, labels, mode);
            await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.id), mode).toEqual(['design', 'build']);
            const rows = await groupRowsOf(page);
            for (const [index, group] of groups.entries()) expect(rows[index]?.text, `${mode}: ${group.id}`).toContain(group.label);
            // 線の色の段がグループの段より上にある
            const [branches] = await rectsOf(page, `${PANEL} .mdag-editor-legend-section[data-section="branches"]`);
            const [grouped] = await rectsOf(page, `${PANEL} .mdag-editor-legend-section[data-section="groups"]`);
            expect(branches && grouped && branches.bottom <= grouped.top + 1, `${mode}: 段の上下`).toBe(true);
        }
    });

    test('@editor 線の色の段は読み取り専用: ボタンも入力欄もなく、行にポインタを乗せても押しても、原文、選択、入力、カラーピッカーは変わらない (B-150)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await expectBranchRows(page, BRANCH_NAMES);
        const section = `${PANEL} .mdag-editor-legend-section[data-section="branches"]`;
        expect(await shownControlsIn(page, section)).toBe(0);

        const row = await spot(page, { on: 'element', selector: `${section} .mdag-editor-legend-row` });
        await page.mouse.move(row.x, row.y);
        await settle(page);
        expect(await shownControlsIn(page, section), 'ポインタを乗せたとき').toBe(0);
        await press(page, row);
        await page.mouse.dblclick(row.x, row.y);
        await expectSourceStill(page, DOC_EDIT, []);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        expect(await selectionLog(page)).toEqual([]);
        expect((await pickerOf(page)).shown).toBe(0);
        await expectNoGroupInput(page);
    });

    test('@editor 枝の起点 (markdag.branches) がなければ、GUI 編集では線の色の段に行がなく markdag.branches の書き方を案内し、閲覧では線の色の段を出さない (B-151、B-154、10.2 の B-151)', async ({ page }) => {
        await open(page);
        const markdown = docOf({ editor: SWITCH_EDIT, groups: GROUPS });
        await mount(page, markdown);
        expect(await branchLabels(page)).toEqual([]);
        await expectPanel(page, true, ['branches', 'groups'], 'GUI 編集');
        expect(await branchRowsOf(page)).toEqual([]);
        const guide = await page.evaluate((selector) => (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim(), `${PANEL} .mdag-editor-legend-section[data-section="branches"]`);
        expect(guide).toContain('branches');

        expect(await setMode(page, 'view')).toBe(true);
        await expectViewPanel(page, ['groups'], '閲覧');
    });
});

test.describe('グループのロゴ (段 19。A-27、B-16、2.2 の onIconSvg、2.3 の groupLogo)', () => {
    const iconDoc = (editor: string[] | undefined): string =>
        fullDoc(editor, {
            icons: ICON_LINES,
            groups: [
                { ...DESIGN_GROUP, icon: 'gh' },
                { ...BUILD_GROUP, icon: 'fire' },
                { id: 'plain', label: '無地', color: '#888888' },
            ],
        });

    test('@editor icon を書いたグループの行に、groupLogo と同じロゴ (SVG と絵文字) が出る。GUI 編集でも閲覧でも出る (A-27、B-16、B-148)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, iconDoc(SWITCH_EDIT), 'sync');
        for (const mode of ['edit', 'view'] as const) {
            if (mode === 'view') expect(await setMode(page, 'view')).toBe(true);
            await expect.poll(() => rowLogoOf(page, 'design'), `${mode}: design (SVG)`).toEqual({ logo: true, svg: true, inRow: true });
            await expect.poll(() => rowLogoOf(page, 'build'), `${mode}: build (絵文字)`).toEqual({ logo: true, svg: false, inRow: true });
            expect((await rowLogoOf(page, 'plain')).logo, `${mode}: plain`).toBe(false);
            await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.id), mode).toEqual(['design', 'build', 'plain']);
        }
        expect(errors).toEqual([]);
    });

    test('@editor resolveIcon が Promise のとき、届く前は中身のないロゴの置き場が行にあり、届くと行のロゴに SVG が入る (groupLogo と同じ)。閲覧で届いても GUI 編集に替えても出る (A-27、B-16)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, iconDoc(SWITCH_VIEW), 'pending');
        expect(await getMode(page)).toBe('view');
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).pending.map((item) => item.ref))).toContain(LOGO_REF);
        await expect.poll(() => rowLogoOf(page, 'design'), '届く前').toEqual({ logo: true, svg: false, inRow: true });

        expect(await resolvePending(page, LOGO_SVG)).toBeGreaterThan(0);
        await expect.poll(() => rowLogoOf(page, 'design'), '届いたあと (閲覧)').toEqual({ logo: true, svg: true, inRow: true });
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => rowLogoOf(page, 'design'), 'GUI 編集に替えたあと').toEqual({ logo: true, svg: true, inRow: true });
        await expect.poll(() => rowLogoOf(page, 'build'), '絵文字').toEqual({ logo: true, svg: false, inRow: true });
        expect(errors).toEqual([]);
    });

    test('@editor GUI 編集でロゴがあとから届いても、行のロゴに SVG が入る (A-27、B-16)', async ({ page }) => {
        await open(page);
        await mount(page, iconDoc(EDIT), 'pending');
        await expect.poll(() => rowLogoOf(page, 'design'), '届く前').toEqual({ logo: true, svg: false, inRow: true });
        expect(await resolvePending(page, LOGO_SVG)).toBeGreaterThan(0);
        await expect.poll(() => rowLogoOf(page, 'design'), '届いたあと').toEqual({ logo: true, svg: true, inRow: true });
    });
});

test.describe('パネルの隅 (段 19。B-152、B-181、6.4)', () => {
    test('@editor パネルは markdag.legend.position の隅の入れ物に入り、図の領域のその隅にある。書かなければ右上 (B-152、6.4)', async ({ page }) => {
        await open(page);
        for (const position of [null, 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
            const markdown = fullDoc(EDIT, position === null ? {} : { legend: [`position: ${position}`] });
            await remount(page, markdown);
            const expected = position ?? 'top-right';
            await expect.poll(async () => (await panelOf(page)).corner, String(position)).toBe(expected);
            const [panel] = await rectsOf(page, PANEL);
            const [area] = await rectsOf(page, '#a');
            expect(panel && area, String(position)).toBeTruthy();
            if (!panel || !area) continue;
            const near = {
                top: panel.top - area.top < 40,
                bottom: area.bottom - panel.bottom < 40,
                left: panel.left - area.left < 40,
                right: area.right - panel.right < 40,
            };
            const [vertical, horizontal] = expected.split('-') as ['top' | 'bottom', 'left' | 'right'];
            expect({ vertical: near[vertical], horizontal: near[horizontal] }, String(position)).toEqual({ vertical: true, horizontal: true });
        }
        // 閲覧でも同じ隅
        await remount(page, fullDoc(undefined, { legend: ['position: bottom-left'] }));
        await expect.poll(async () => (await panelOf(page)).corner, '閲覧').toBe('bottom-left');
    });

    test('@editor セグメントと同じ隅なら、同じ入れ物に入って縦に並ぶ (重ならない。辺に近い方がセグメント) (B-181、6.4)', async ({ page }) => {
        await open(page);
        for (const position of ['top-right', 'bottom-left'] as const) {
            await remount(page, fullDoc([...SWITCH_EDIT, 'segment:', `    position: ${position}`], { legend: [`position: ${position}`] }));
            await expect.poll(async () => (await panelOf(page)).corner, position).toBe(position);
            const layout = await page.evaluate(() => {
                const segment = document.querySelector('#a .mdag-editor-segment');
                const panel = document.querySelector('#a .mdag-editor-legend');
                const rect = (element: Element | null): { top: number; bottom: number } | null => {
                    if (!element) return null;
                    const box = element.getBoundingClientRect();
                    return { top: box.top, bottom: box.bottom };
                };
                return {
                    sameCorner: segment !== null && panel !== null && segment.closest('.mdag-editor-corner') === panel.closest('.mdag-editor-corner'),
                    segment: rect(segment),
                    panel: rect(panel),
                };
            });
            expect(layout.sameCorner, position).toBe(true);
            const { segment, panel } = layout;
            if (!segment || !panel) throw new Error(`${position}: セグメントかパネルがない`);
            if (position.startsWith('top-')) expect(segment.bottom, position).toBeLessThanOrEqual(panel.top + 0.5);
            else expect(segment.top, position).toBeGreaterThanOrEqual(panel.bottom - 0.5);
        }
    });
});

test.describe('閲覧のパネル (段 19。B-153〜B-155、B-169、5.2 の軸 F の閲覧の出し方、10.1 の 2)', () => {
    test('@editor 閲覧だけの文書でも編集の層のパネルが出る。見出しにもパネルの中にもボタンがなく (開閉、新規、行の操作)、見出しを押しても段は出たまま (B-155、10.1 の 2)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_VIEW);
        expect(await getMode(page)).toBe('view');
        await expectViewPanel(page, ['branches', 'groups']);
        expect(await shownControlsIn(page, HEAD), '見出しのボタン').toBe(0);
        expect(await shownControlsIn(page, PANEL, '.mdag-editor-legend-chip'), 'パネルの中のボタン').toBe(0);
        expect(await shownCount(page, NEW_BUTTON), '新規').toBe(0);

        await pressHead(page);
        await settle(page);
        await expectViewPanel(page, ['branches', 'groups'], '見出しを押したあと');
        await pressHead(page);
        await settle(page);
        await expectViewPanel(page, ['branches', 'groups'], '見出しをもう 1 度押したあと');
        await expectSourceStill(page, DOC_VIEW, []);
        expect(errors).toEqual([]);
    });

    test('@editor 閲覧では legend.display に従う: false ならパネルがなく、出す段は指定どおりで、中身のない段は出さない。どの段も出さなければパネルがない (B-153、B-154)', async ({ page }) => {
        await open(page);
        const cases: Array<{ name: string; markdown: string; sections: string[] | null }> = [
            { name: 'display: false', markdown: fullDoc(undefined, { legend: ['display: false'] }), sections: null },
            { name: 'display: [groups]', markdown: fullDoc(undefined, { legend: ['display:', '    - groups'] }), sections: ['groups'] },
            { name: 'display: [branches]', markdown: fullDoc(undefined, { legend: ['display:', '    - branches'] }), sections: ['branches'] },
            { name: '起点がない', markdown: docOf({ groups: GROUPS }), sections: ['groups'] },
            { name: 'グループがない', markdown: docOf({ branches: BRANCH_NAMES, body: BODY }), sections: ['branches'] },
            { name: '起点もグループもない', markdown: docOf({ body: BODY }), sections: null },
            { name: 'display: [branches] で起点がない', markdown: docOf({ groups: GROUPS, legend: ['display:', '    - branches'] }), sections: null },
        ];
        for (const { name, markdown, sections } of cases) {
            await remount(page, markdown);
            expect(await getMode(page), name).toBe('view');
            if (sections === null) await expectNoPanel(page, name);
            else await expectViewPanel(page, sections, name);
        }
    });

    test('@editor 閲覧ではグループの行にポインタを乗せても何も出ず (操作ボタンも見た目の変化もない)、行、名前、色の四角を押しても、グループは選ばれず、入力もカラーピッカーも開かない (B-155、B-169)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_VIEW);
        await expectViewPanel(page, ['branches', 'groups']);
        await pointerOverBlank(page);
        await settle(page);
        const before = await rowLook(page, 'design');
        expect(before).not.toBe('');

        await hoverRow(page, 'design', '設計');
        await settle(page);
        expect(await shownCount(page, `${PANEL} .mdag-editor-legend-action`), 'ポインタを乗せた行の操作ボタン').toBe(0);
        expect(await rowLook(page, 'design'), 'ポインタを乗せた行の見た目').toBe(before);

        await pressRow(page, 'design', '設計');
        const name = await rowNamePoint(page, 'design', '設計');
        await page.mouse.dblclick(name.x, name.y);
        await pressChip(page, 'design');
        await settle(page);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        expect(await selectionLog(page)).toEqual([]);
        expect(await lastGroupKey(page)).toBeUndefined();
        expect((await groupRowsOf(page)).map((row) => row.selected)).toEqual([false, false]);
        expect((await pickerOf(page)).shown).toBe(0);
        await expectNoGroupInput(page);
        await expectSourceStill(page, DOC_VIEW, []);
    });

    test('@editor GUI 編集でパネルを閉じてから閲覧へ替えても、閲覧では段が出たまま (開閉しない)。GUI 編集に戻すと初めの状態 (開いている) に戻る (5.2 の軸 F、B-157)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SWITCH);
        await expectPanel(page, true, ['branches', 'groups'], '初め');
        await pressHead(page);
        await expectPanel(page, false, [], '閉じた');

        expect(await setMode(page, 'view')).toBe(true);
        await expectViewPanel(page, ['branches', 'groups'], '閲覧');
        expect(await shownControlsIn(page, HEAD), '閲覧の見出しのボタン').toBe(0);
        await pressHead(page);
        await settle(page);
        await expectViewPanel(page, ['branches', 'groups'], '閲覧で見出しを押したあと');

        expect(await setMode(page, 'edit')).toBe(true);
        await expectPanel(page, true, ['branches', 'groups'], 'GUI 編集に戻したあと');
    });

    test('@editor legend.display が false の切り替えの文書: GUI 編集では閉じて始まり、開いてから閲覧へ替えるとパネルがなく、GUI 編集に戻すと閉じている (5.2 の軸 F、B-153、B-157)', async ({ page }) => {
        await open(page);
        await mount(page, fullDoc(SWITCH_EDIT, { legend: ['display: false'] }));
        await expectPanel(page, false, [], '初め');
        await pressHead(page);
        await expectPanel(page, true, ['branches', 'groups'], '開いた');

        expect(await setMode(page, 'view')).toBe(true);
        await expectNoPanel(page, '閲覧');
        expect(await setMode(page, 'edit')).toBe(true);
        await expectPanel(page, false, [], 'GUI 編集に戻したあと');
    });
});

test.describe('GUI 編集の開閉の初めの状態 (段 19。B-156、B-157、Q6、5.2 の軸 F)', () => {
    test('@editor GUI 編集では段は legend.display の指定によらず両方。false なら閉じて始まり (見出しは見える)、見出しを押すと両方の段が出る。出す指定なら開いて始まる (B-156、B-157、Q6)', async ({ page }) => {
        await open(page);
        for (const [name, legend] of [
            ['display: [groups]', ['display:', '    - groups']],
            ['display: [branches]', ['display:', '    - branches']],
            ['display: true', ['display: true']],
        ] as const) {
            await remount(page, fullDoc(EDIT, { legend: [...legend] }));
            await expectPanel(page, true, ['branches', 'groups'], name);
        }

        await remount(page, DOC_EDIT_CLOSED);
        await expectPanel(page, false, [], 'display: false');
        expect((await panelOf(page)).head).toContain('線の色・グループ');
        await pressHead(page);
        await expectPanel(page, true, ['branches', 'groups'], 'display: false で見出しを押したあと');
        await expectBranchRows(page, BRANCH_NAMES, 'display: false で開いたあと');
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.id)).toEqual(['design', 'build']);
    });

    test('@editor 文書の legend.display が変わったら開閉を初めの状態に戻し、ほかの行が変わっただけなら見る人の開閉を保つ (setSource) (B-157)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await expectPanel(page, true, ['branches', 'groups'], '初め');
        await pressHead(page);
        await expectPanel(page, false, [], '閉じた');

        // 本文だけを変えても閉じたまま
        const renamedLeaf = fullDoc(EDIT, { body: GROUPED_BODY.map((line) => (line === '- Leaf' ? '- Leaf 2' : line)) });
        await setSource(page, renamedLeaf);
        await expect.poll(() => getSource(page)).toBe(renamedLeaf);
        await settle(page);
        await expectPanel(page, false, [], '本文だけを変えたあと');

        // 出す指定が変わったので、初めの状態 (開いている) に戻る
        await setSource(page, fullDoc(EDIT, { legend: ['display:', '    - groups'] }));
        await expectPanel(page, true, ['branches', 'groups'], 'display を groups に変えたあと');

        // 出さない指定に変わったので、初めの状態 (閉じている) に戻る
        await setSource(page, DOC_EDIT_CLOSED);
        await expectPanel(page, false, [], 'display を false に変えたあと');

        // 見る人が開いたあと、本文だけを変えても開いたまま
        await pressHead(page);
        await expectPanel(page, true, ['branches', 'groups'], '開いた');
        await setSource(page, fullDoc(EDIT, { legend: ['display: false'], body: GROUPED_BODY.map((line) => (line === '- Leaf' ? '- Leaf 3' : line)) }));
        await settle(page);
        await expectPanel(page, true, ['branches', 'groups'], 'display: false のまま本文を変えたあと');
    });
});

test.describe('行の操作ボタン (段 19。B-158、B-164)', () => {
    test('@editor 操作ボタン (+、目、ごみ箱) は、ポインタを乗せた行と選んだ行にだけ出る (B-158)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), 'ポインタが図の上').toEqual({ design: [], build: [] });

        await hoverRow(page, 'design', '設計');
        await expect.poll(() => actionsByRow(page), 'design に乗せた').toEqual({ design: ALL_ACTIONS, build: [] });
        await hoverRow(page, 'build', '実装');
        await expect.poll(() => actionsByRow(page), 'build に乗せた').toEqual({ design: [], build: ALL_ACTIONS });
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), 'ポインタを図に戻した').toEqual({ design: [], build: [] });

        // 枠を押して選んだグループの行 (data-selected) は、ポインタがなくてもボタンが出る
        await pressFrame(page, 'build');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A);
        await pointerOverBlank(page);
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.selected]), '選んだ行').toEqual([
            ['design', false],
            ['build', true],
        ]);
        await expect.poll(() => actionsByRow(page), '選んだ行のボタン').toEqual({ design: [], build: ALL_ACTIONS });
        await hoverRow(page, 'design', '設計');
        await expect.poll(() => actionsByRow(page), '選んだ行と乗せた行').toEqual({ design: ALL_ACTIONS, build: ALL_ACTIONS });
        await expectSourceStill(page, DOC_EDIT, []);
    });

    test('@editor 枠を隠しているグループ (boundary: false) の行は、ポインタを乗せていなくても目のボタンが出たまま (ほかのボタンは乗せたときだけ) (B-164)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_HIDDEN);
        await useSelectTool(page);
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), 'ポインタが図の上').toEqual({ design: [], build: ['boundary'] });
        await hoverRow(page, 'build', '実装');
        await expect.poll(() => actionsByRow(page), 'build に乗せた').toEqual({ design: [], build: ALL_ACTIONS });
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), 'ポインタを図に戻した').toEqual({ design: [], build: ['boundary'] });
    });
});

test.describe('カラーピッカー (段 19。B-159、B-160、5.2 の軸 D)', () => {
    test('@editor 色の四角を押すとカラーピッカー (よく使う 12 色、16 進の入力、ブラウザの色選び) が開き、同じ四角、外、Esc のどれでも閉じる。原文は変わらない (B-159)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        expect((await pickerOf(page)).shown).toBe(0);

        await pressChip(page, 'design');
        await expect.poll(async () => {
            const state = await pickerOf(page);
            return { shown: state.shown, swatches: state.swatches.length, distinct: new Set(state.swatches).size, hex: state.hex, native: state.native };
        }).toEqual({ shown: 1, swatches: 12, distinct: 12, hex: 1, native: 1 });

        await pressChip(page, 'design');
        await expectPickerClosed(page, '同じ四角');

        await pressChip(page, 'design');
        await expect.poll(async () => (await pickerOf(page)).shown).toBe(1);
        await page.keyboard.press('Escape');
        await expectPickerClosed(page, 'Esc');

        await pressChip(page, 'build');
        await expect.poll(async () => (await pickerOf(page)).shown).toBe(1);
        await pressBlank(page);
        await expectPickerClosed(page, '外');

        await expectSourceStill(page, DOC_EDIT, []);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor カラーピッカーで色を選ぶと、そのグループの color を書き換える (onChange 1 回、モデルの色も替わる)。元に戻すで戻る (B-160、3.4 の setGroupColor)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await pressChip(page, 'design');
        await expect.poll(async () => (await pickerOf(page)).swatches.length).toBe(12);
        const picked = (await pickerOf(page)).swatches.find((color) => color.toLowerCase() !== '#3b7dd8');
        if (!picked) throw new Error('今の色と違う色の四角がない');
        const candidates = await colorSources(page, DOC_EDIT, 'design', picked);

        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-editor-color-picker .mdag-editor-swatch[data-color="${picked}"]` }));
        const source = await expectSourceOneOf(page, candidates, 1);
        await expect.poll(async () => (await groupModelOf(page)).groups.find((group) => group.id === 'design')?.color?.toLowerCase()).toBe(picked.toLowerCase());
        expect(source).not.toBe(DOC_EDIT);

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_EDIT, [source, DOC_EDIT], '元に戻す');
        expect(errors).toEqual([]);
    });

    test('@editor 16 進を入れて Enter で color を書き換える。ブラウザの色選びで選んでも書き換える (B-160)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);

        // 16 進
        const hex = '#2E9E5B';
        const hexCandidates = await colorSources(page, DOC_EDIT, 'design', hex);
        await pressChip(page, 'design');
        await expect.poll(async () => (await pickerOf(page)).hex).toBe(1);
        await press(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-color-picker .mdag-editor-hex' }));
        await page.keyboard.press('ControlOrMeta+KeyA');
        await page.keyboard.type(hex);
        await page.keyboard.press('Enter');
        const afterHex = await expectSourceOneOf(page, hexCandidates, 1, '16 進');
        await expect.poll(async () => (await groupModelOf(page)).groups.find((group) => group.id === 'design')?.color?.toLowerCase()).toBe(hex.toLowerCase());

        // ブラウザの色選び (input[type="color"] の値を変えて input と change を送る。見え方によらない)
        const native = '#123456';
        const nativeCandidates = await colorSources(page, afterHex, 'build', native);
        await pointerOverBlank(page);
        await settle(page);
        if ((await pickerOf(page)).shown > 0) {
            await page.keyboard.press('Escape');
            await expectPickerClosed(page);
        }
        await pressChip(page, 'build');
        await expect.poll(async () => (await pickerOf(page)).native).toBe(1);
        await page.evaluate((value) => {
            const w = window as unknown as EditorWindow;
            const picker = [...document.querySelectorAll('#a .mdag-editor-color-picker')].find((item) => w.isShown(item));
            const input = picker?.querySelector<HTMLInputElement>('input[type="color"]');
            if (!input) throw new Error('ブラウザの色選びがない');
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, native);
        await expectSourceOneOf(page, nativeCandidates, 2, 'ブラウザの色選び');
        await expect.poll(async () => (await groupModelOf(page)).groups.find((group) => group.id === 'build')?.color?.toLowerCase()).toBe(native);
    });
});

test.describe('行の名前 (段 19。B-161、B-15、5.2 の軸 D のグループの名前の入力)', () => {
    test('@editor 名前をダブルクリックすると、行の中に今の名前の入力が開く (フォーカスあり)。Enter で決め (label を書き換え、行と枠のラベルが替わる)、Esc でやめ、フォーカスが外へ移ると決める (B-161)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        const renamed = fullDoc(EDIT, { groups: [{ ...DESIGN_GROUP, label: '設計の範囲' }, BUILD_GROUP] });
        const renamedAgain = fullDoc(EDIT, { groups: [{ ...DESIGN_GROUP, label: '画面' }, BUILD_GROUP] });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'renameGroup', group: 'design', label: '設計の範囲' }))).toBe(renamed);
        expect(editedSource(await tryEdit(page, renamed, { kind: 'renameGroup', group: 'design', label: '画面' }))).toBe(renamedAgain);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);

        // Enter で決める
        let name = await rowNamePoint(page, 'design', '設計');
        await page.mouse.dblclick(name.x, name.y);
        await expectGroupInputInRow(page, 'design', '設計', 'ダブルクリック');
        await replaceName(page, '設計の範囲');
        await page.keyboard.press('Enter');
        await expectSource(page, renamed, [renamed], 'Enter');
        await expectGroupInputClosed(page, 'Enter');
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'design')?.text ?? '').toContain('設計の範囲');
        await expect(page.locator(frameLabelSelector('design'))).toHaveText('設計の範囲');

        // Esc でやめる
        name = await rowNamePoint(page, 'design', '設計の範囲');
        await page.mouse.dblclick(name.x, name.y);
        await expectGroupInputInRow(page, 'design', '設計の範囲', 'Esc の前');
        await replaceName(page, 'やめる名前');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, 'Esc');
        await expectSourceStill(page, renamed, [renamed], 'Esc');

        // フォーカスが外へ移ると決める
        name = await rowNamePoint(page, 'design', '設計の範囲');
        await page.mouse.dblclick(name.x, name.y);
        await expectGroupInputInRow(page, 'design', '設計の範囲', '外へ移る前');
        await replaceName(page, '画面');
        await focusOutside(page);
        await expectSource(page, renamedAgain, [renamed, renamedAgain], 'フォーカスが外へ');
        await expectGroupInputClosed(page, 'フォーカスが外へ');
        expect(errors).toEqual([]);
    });

    test('@editor 変換中 (isComposing か keyCode 229) の Enter と Esc は、行の名前の入力の操作にならない: 決めず、やめない。確定したあとの Enter で決める (B-161、B-15)', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '変換は Chromium の CDP (Input.imeSetComposition) で起こす');
        await open(page);
        const named = fullDoc(EDIT, { groups: [{ ...DESIGN_GROUP, label: '設計案' }, BUILD_GROUP] });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'renameGroup', group: 'design', label: '設計案' }))).toBe(named);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        const name = await rowNamePoint(page, 'design', '設計');
        await page.mouse.dblclick(name.x, name.y);
        await expectGroupInputInRow(page, 'design', '設計');
        await page.keyboard.press('ControlOrMeta+KeyA');

        const client = await page.context().newCDPSession(page);
        try {
            await client.send('Input.imeSetComposition', { text: 'せっけい', selectionStart: 4, selectionEnd: 4 });
            await expect.poll(async () => (await groupInputOf(page)).value).toBe('せっけい');
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            await expectSourceStill(page, DOC_EDIT, [], '変換中');
            await expectGroupInputInRow(page, 'design', 'せっけい', '変換中');

            await client.send('Input.insertText', { text: '設計案' });
            await expect.poll(async () => (await groupInputOf(page)).value).toBe('設計案');
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, DOC_EDIT, [], '確定のあとの keyCode 229');
            await expectGroupInputInRow(page, 'design', '設計案', '確定のあとの keyCode 229');
        } finally {
            await client.detach();
        }

        await page.keyboard.press('Enter');
        await expectSource(page, named, [named]);
        await expectGroupInputClosed(page);
    });
});

test.describe('ノードの数と行の操作 (段 19。B-162〜B-166)', () => {
    test('@editor 行にグループに入っているノードの数 (配下を含む) が出る (B-162)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        const { counts } = await groupModelOf(page);
        expect(counts).toEqual({ design: 3, build: 2 });
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.count])).toEqual([
            ['design', 3],
            ['build', 2],
        ]);
    });

    test('@editor + で選んだノードをそのグループに入れ (1 行目に印。onChange 1 回)、数が増える。ノードは選んだまま。何も選んでいなければ + は押せず、押しても何もしない (B-163、3.4 の addToGroup)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const added = fullDoc(EDIT, { body: marked(GROUPED_BODY, { '- Leaf': '%design' }) });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'addToGroup', group: 'design', nodes: [target(LEAF)] }))).toBe(added);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);

        await pressNode(page, LEAF);
        await expectNodes(page, [LEAF]);
        await hoverRow(page, 'design', '設計');
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'design')?.disabled, '選んでいるとき').toEqual([]);
        await pressAction(page, 'design', '設計', 'add');
        await expectSource(page, added, [added]);
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'design')?.count).toBe(4);
        await expectNodes(page, [LEAF], '足したあと');

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_EDIT, [added, DOC_EDIT], '元に戻す');
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'design')?.count).toBe(3);

        // 何も選んでいない
        await pressBlank(page);
        await expectNothingSelected(page);
        await hoverRow(page, 'design', '設計');
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'design')?.disabled, '何も選んでいないとき').toEqual(['add']);
        await pressAction(page, 'design', '設計', 'add');
        await expectSourceStill(page, DOC_EDIT, [added, DOC_EDIT], '何も選んでいないとき');
        expect(errors).toEqual([]);
    });

    test('@editor 目のボタンで枠の表示 (boundary) を切り替える: 隠すと boundary: false になり枠が消え、もう 1 度で boundary: true に戻り枠が出る。書き換えたあとはそのグループを選ぶ。隠しているグループは選んでいなくても目のボタンが出たまま (B-164、3.4 の setGroupBoundary)', async ({ page }) => {
        await open(page);
        const hidden = fullDoc(EDIT, { groups: [{ ...DESIGN_GROUP, boundary: false }, BUILD_GROUP] });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'setGroupBoundary', group: 'design', boundary: false }))).toBe(hidden);
        expect(editedSource(await tryEdit(page, hidden, { kind: 'setGroupBoundary', group: 'design', boundary: true }))).toBe(DOC_EDIT);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await expect(frames(page, 'design')).toHaveCount(1);

        await pressAction(page, 'design', '設計', 'boundary');
        await expectSource(page, hidden, [hidden], '隠す');
        await expect(frames(page, 'design'), '隠す').toHaveCount(0);
        // 書き換えたあとはそのグループを選ぶ。選択を解いてから、ポインタのない行のボタンを見る
        await expect.poll(() => getSelection(page), '隠したあとの選択').toEqual({ kind: 'group', id: 'design' });
        await pressBlank(page);
        await expectNothingSelected(page, '隠したあと');
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), '隠したあと').toEqual({ design: ['boundary'], build: [] });

        await pressAction(page, 'design', '設計', 'boundary');
        await expectSource(page, DOC_EDIT, [hidden, DOC_EDIT], '出す');
        await expect(frames(page, 'design'), '出す').toHaveCount(1);
        await expect.poll(() => getSelection(page), '出したあとの選択').toEqual({ kind: 'group', id: 'design' });
        await pressBlank(page);
        await expectNothingSelected(page, '出したあと');
        await pointerOverBlank(page);
        await expect.poll(() => actionsByRow(page), '出したあと').toEqual({ design: [], build: [] });
    });

    test('@editor ごみ箱でグループを解く (印と定義を外す。ノードは残る)。行と枠が消える。元に戻すで戻る (B-165、3.4 の ungroup)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const ungrouped = docOf({ editor: EDIT, branches: BRANCH_NAMES, groups: [DESIGN_GROUP], body: marked(BODY, { '## Design': '%design' }) });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'ungroup', group: 'build' }))).toBe(ungrouped);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);

        await pressAction(page, 'build', '実装', 'delete');
        await expectSource(page, ungrouped, [ungrouped]);
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.id)).toEqual(['design']);
        await expect(frames(page, 'build')).toHaveCount(0);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_EDIT, [ungrouped, DOC_EDIT], '元に戻す');
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.id)).toEqual(['design', 'build']);
        await expect(frames(page, 'build')).toHaveCount(1);
        expect(errors).toEqual([]);
    });

    test('@editor 行を押すとそのグループを選び (getSelection、onSelectionChange、図の強調、行の data-selected、グループの帯)、もう 1 度押すと解く。原文は変わらない (B-166)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);

        await pressRow(page, 'design', '設計');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '1 回目');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'group', id: 'design' });
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.selected])).toEqual([
            ['design', true],
            ['build', false],
        ]);
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]')).toHaveCount(1);

        await pressRow(page, 'build', '実装');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A, '別の行');
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.selected])).toEqual([
            ['design', false],
            ['build', true],
        ]);

        await pressRow(page, 'build', '実装');
        await expectNothingSelected(page, '同じ行をもう 1 度');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => row.selected)).toEqual([false, false]);
        await expectSourceStill(page, DOC_EDIT, []);
        await expectNoGroupInput(page);
    });
});

test.describe('枠を隠したグループの名前 (段 19。A-07、B-12、5.3、2.3 の { group } の落とし方)', () => {
    test('@editor 枠を隠したグループを行で選ぶと、帯がメンバーの上か下に出て、帯の「名前」か Enter で、メンバーの全体の上に名前の入力が開く (A-07、B-12)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_HIDDEN);
        await useSelectTool(page);
        await expect(frames(page, 'build')).toHaveCount(0);

        await pressRow(page, 'build', '実装');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A);
        await expectGroupBar(page, '実装', async () => union(await Promise.all(BUILD_MEMBERS.map((id) => nodeBox(page, id)))));
        await pressBar(page, 'rename-group');
        await expectGroupInputAbove(page, BUILD_MEMBERS, '実装', '帯の名前');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, '帯の名前のあとの Esc');

        await pressBlank(page);
        await expectNothingSelected(page);
        await pressRow(page, 'build', '実装');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A, 'Enter の前');
        await page.keyboard.press('Enter');
        await expectGroupInputAbove(page, BUILD_MEMBERS, '実装', 'Enter');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, 'Enter のあとの Esc');
        await expectSourceStill(page, DOC_HIDDEN, []);
    });
});

test.describe('新規 (段 19。B-167、B-168、3.4 の groupNodes と defineGroup、5.3)', () => {
    test('@editor ノードを選んで見出しの「新規」を押すと、選んだノードをグループにまとめ (⌘G と同じ)、グループが選ばれ、名前の入力が枠のラベルの上に開く (B-167)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const grouped = fullDoc(EDIT, { groups: [...GROUPS, NEW_GROUP], body: marked(GROUPED_BODY, { '- Task A': '%group1', '- Task B': '%group1' }) });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'groupNodes', nodes: [target(TASK_A), target(TASK_B)] }))).toBe(grouped);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectNodes(page, [TASK_A, TASK_B]);

        await pressNew(page);
        await expectSource(page, grouped, [grouped]);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'group1' });
        await expectGroupInputOnLabel(page, 'group1', 'グループ 1');
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.count])).toEqual([
            ['design', 3],
            ['build', 2],
            ['group1', 2],
        ]);
        expect(errors).toEqual([]);
    });

    test('@editor 何も選ばずに「新規」を押すと、メンバーのいないグループ (定義だけ) を作り、行の中で名前の入力を開く。名前を入れて Enter で決まる (B-168、3.4 の defineGroup)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const defined = fullDoc(EDIT, { groups: [...GROUPS, NEW_GROUP] });
        const named = fullDoc(EDIT, { groups: [...GROUPS, { ...NEW_GROUP, label: '公開' }] });
        expect(editedSource(await tryEdit(page, DOC_EDIT, { kind: 'defineGroup' }))).toBe(defined);
        expect(editedSource(await tryEdit(page, defined, { kind: 'renameGroup', group: 'group1', label: '公開' }))).toBe(named);
        await mount(page, DOC_EDIT);
        await useSelectTool(page);
        await expectNothingSelected(page);

        await pressNew(page);
        await expectSource(page, defined, [defined]);
        await expect.poll(async () => (await groupRowsOf(page)).map((row) => [row.id, row.count])).toEqual([
            ['design', 3],
            ['build', 2],
            ['group1', 0],
        ]);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'group1' });
        await expectGroupInputInRow(page, 'group1', 'グループ 1');
        await expect(frames(page, 'group1')).toHaveCount(0);

        await replaceName(page, '公開');
        await page.keyboard.press('Enter');
        await expectSource(page, named, [defined, named]);
        await expectGroupInputClosed(page);
        await expect.poll(async () => (await groupRowsOf(page)).find((row) => row.id === 'group1')?.text ?? '').toContain('公開');
        expect(errors).toEqual([]);
    });

    test('@editor パネルが閉じているときに何も選ばずに「新規」を押すと、パネルが開いて、新しいグループの行の中で名前の入力が開く (B-168、5.3)', async ({ page }) => {
        await open(page);
        const defined = fullDoc(EDIT, { legend: ['display: false'], groups: [...GROUPS, NEW_GROUP] });
        expect(editedSource(await tryEdit(page, DOC_EDIT_CLOSED, { kind: 'defineGroup' }))).toBe(defined);
        await mount(page, DOC_EDIT_CLOSED);
        await useSelectTool(page);
        await expectPanel(page, false, [], '初め');

        await pressNew(page);
        await expectSource(page, defined, [defined]);
        await expectPanel(page, true, ['branches', 'groups'], '新規のあと');
        await expectGroupInputInRow(page, 'group1', 'グループ 1');
    });
});

test.describe('閲覧への切り替え (段 19。B-171、5.2 の軸 D の「閲覧へ」)', () => {
    test('@editor カラーピッカーを開いたまま閲覧へ替えると閉じる。行の名前の入力中に閲覧へ替えると、入れた名前で決めて閉じる (setMode) (B-171)', async ({ page }) => {
        await open(page);
        const renamed = fullDoc(SWITCH_EDIT, { groups: [{ ...DESIGN_GROUP, label: '設計の範囲' }, BUILD_GROUP] });
        expect(editedSource(await tryEdit(page, DOC_SWITCH, { kind: 'renameGroup', group: 'design', label: '設計の範囲' }))).toBe(renamed);
        await mount(page, DOC_SWITCH);
        await useSelectTool(page);

        await pressChip(page, 'design');
        await expect.poll(async () => (await pickerOf(page)).shown).toBe(1);
        expect(await setMode(page, 'view')).toBe(true);
        await expectPickerClosed(page, '閲覧へ');
        await expectSourceStill(page, DOC_SWITCH, []);

        expect(await setMode(page, 'edit')).toBe(true);
        await expectPanel(page, true, ['branches', 'groups']);
        const name = await rowNamePoint(page, 'design', '設計');
        await page.mouse.dblclick(name.x, name.y);
        await expectGroupInputInRow(page, 'design', '設計');
        await replaceName(page, '設計の範囲');
        expect(await setMode(page, 'view')).toBe(true);
        await expectSource(page, renamed, [renamed]);
        await expectGroupInputClosed(page);
        expect(await getMode(page)).toBe('view');
        await expectViewPanel(page, ['branches', 'groups']);
    });
});

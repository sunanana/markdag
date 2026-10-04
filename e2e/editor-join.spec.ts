// GUI 編集の合流と線を引く操作を、ビルドした配布物の markdag/editor で確かめる。
// addRelation、joinInto、joinIntoNew の書き換えと断る理由、合流の規則、合流先を選ぶ途中の道具、線を引く点 (ノードの右) と
// 選択全体の点 (選んだノードの全体の右)、線の選択を見る。線の帯、反転、削除は入れない (線を押したら強調するだけ)。
// GUI 編集では文書の edgeHighlight の指定によらず線を押せる。
// 見た目そのもの (色、余白、影) は見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、モデルの relations の線 (view.getDocument)、
// 選び直し (ノードの data-selected、線の data-edge-selected と view の onSelectEdge、getSelection、onSelectionChange)、名前の入力、
// 通知 (.mdag-editor-snackbar と data-kind、外した数)、道具の状態 (data-editor-tool)、点と引く線の有無と置き場、元に戻すを見る。
// 期待の原文は線と合流の書き換えと frontmatter の足し方の規則から書いた (relations は markdag の写像の末尾に足し、項目は一覧の末尾。合流先は最上位の兄弟の形)。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EdgeTarget, EditOp, EditOutcome, EditSelection, NodeTarget } from '../src/core';
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
    // view の onSelectEdge に届いた線のキー (kind:source>target。解いたときは null。呼ばれた順)
    edgeKeys: Record<string, Array<string | null>>;
};

const DIST = resolve('dist');

// 新しい合流先の仮の名前
const JOIN_LABEL = '合流点';

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

const indent = (line: string): string => `    ${line}`;

// markdag.editor を書いた文書。before は markdag の下で editor より前に、after は editor よりあとに置く行 (markdag の下の字下げ (4 桁) からの相対)。
// editor の行は markdag.editor の下の字下げ (8 桁) からの相対
function docWith(editor: string[], body: string[], before: string[] = [], after: string[] = [], edgeHighlight = true): string {
    return ['---', 'markdag:', `    edgeHighlight: ${edgeHighlight}`, ...before.map(indent), '    editor:', ...editor.map((line) => `        ${line}`), ...after.map(indent), '---', '', ...body].join('\n');
}

// markdag.relations の行 (markdag の下の字下げからの相対)。kind ごとの一覧の項目は「- 式」
function relations(entries: Array<[string, string[]]>): string[] {
    return ['relations:', ...entries.flatMap(([kind, items]) => [`    ${kind}:`, ...items.map((item) => `        - ${item}`)])];
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;
// 新しい合流先の id (文書の最後に足すので、もとのノードの id は変わらない)
const JOIN_NODE = 7;

const DOC = docWith(EDIT, BODY);
const DOC_VIEW = docWith(['mode: view'], BODY);
const DOC_SWITCH = docWith(SWITCH_EDIT, BODY);

// Task A から Leaf へ線を引いた文書。relations のキーは markdag の写像の末尾 (editor のあと) に足す
const DOC_LINKED = docWith(EDIT, BODY, [], relations([['depends', ['Task A --> Leaf']]]));

// Task A --> Leaf の線がもうある文書 (線の押下と、もうある線)。edgeHighlight: false の写しもある
const DOC_REL = docWith(EDIT, BODY, relations([['depends', ['Task A --> Leaf']]]));
const DOC_REL_PLAIN = docWith(EDIT, BODY, relations([['depends', ['Task A --> Leaf']]]), [], false);

// Task A と Leaf から新しい合流先を作った本文と文書。合流先は、始点のうち文書でいちばん後ろの Leaf を含む最上位の枝 (Build) のすぐあとに、
// 最上位の兄弟 (Build と同じ ## の見出し。前に空行) として足す。join の項目の始点は文書の順
const BODY_JOIN_NEW = [...BODY.slice(0, -1), '', `## ${JOIN_LABEL}`, ''];
const JOIN_NEW_RELATIONS = relations([['join', [`Task A & Leaf --> ${JOIN_LABEL}`]]]);
const DOC_JOIN_NEW = docWith(EDIT, BODY_JOIN_NEW, [], JOIN_NEW_RELATIONS);
const DOC_SWITCH_JOIN_NEW = docWith(SWITCH_EDIT, BODY_JOIN_NEW, [], JOIN_NEW_RELATIONS);

// Task A と Task B から既存の Leaf へ合流した文書
const DOC_JOIN_LEAF = docWith(EDIT, BODY, [], relations([['join', ['Task A & Task B --> Leaf']]]));

// 外す始点のある文書。Leaf へ合流するとき、Task A は合流先へもう線がある (Task A --> Leaf)、
// Task B は合流先から relations をたどって届く (Leaf --> Task B。線を引くと循環になる)。Design はどちらでもない
const DOC_SKIP = docWith(EDIT, BODY, relations([['depends', ['Task A --> Leaf', 'Leaf --> Task B']]]));
// Design、Task A、Task B から Leaf へ合流した文書。残る始点が 1 つなので depends の一覧の末尾に足す
const DOC_SKIP_JOINED = docWith(EDIT, BODY, relations([['depends', ['Task A --> Leaf', 'Leaf --> Task B', 'Design --> Leaf']]]));

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
        target.edgeKeys = {};
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
                target.changes.push({ root: 'a', markdown: next });
            },
            onSelectionChange: (selection) => {
                target.selections.push({ root: 'a', selection: JSON.parse(JSON.stringify(selection)) as EditorSelection });
            },
        };
        const editor = target.editorHarness.editor.mountEditor(container, markdown, options);
        target.editors.a = editor;
        // 図の線の強調 (selectEdge) が、どの線に掛かったかを view の受け口で控える
        const keys: Array<string | null> = [];
        target.edgeKeys.a = keys;
        editor.view.addHooks({
            onSelectEdge: (edge) => {
                keys.push(edge ? `${edge.edge.kind}:${edge.edge.source}>${edge.edge.target}` : null);
            },
        });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知を初めの状態に戻す)。onChange と onSelectionChange の記録も空にする
async function remount(page: Page, markdown: string): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
        target.selections = [];
    });
    await mount(page, markdown);
}

// 「変わらない」「呼ばれない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const selectionLog = (page: Page): Promise<EditorSelection[]> => page.evaluate(() => (window as unknown as EditorWindow).selections.map((entry) => entry.selection));

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());

const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const callUndo = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo());

// view の onSelectEdge に最後に届いた線のキー (届いていなければ undefined)
const lastEdgeKey = (page: Page): Promise<string | null | undefined> => page.evaluate(() => (window as unknown as EditorWindow).edgeKeys.a?.at(-1));

// 描いている文書のモデルの relations の線 (kind:source>target の昇順)
const relationKeys = (page: Page): Promise<string[]> =>
    page.evaluate(() =>
        ((window as unknown as EditorWindow).editors.a?.view.getDocument()?.model.relations ?? []).map((relation) => `${relation.kind}:${relation.source}>${relation.target}`).sort(),
    );

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const bars = (page: Page) => visible(page, '#a .mdag-editor-bar');
const handles = (page: Page, kind: 'link' | 'join') => visible(page, `#a .mdag-editor-handle[data-handle="${kind}"]`);
const previews = (page: Page) => visible(page, '#a .mdag-editor-link-preview');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const nodeCount = (page: Page): Promise<number> => page.locator('#a .mdag-node').count();
const labelOf = (page: Page, id: number) => page.locator(`${nodeSelector(id)} .mdag-content`);
const editorTool = (page: Page): Promise<string | null> => page.locator('#a').getAttribute('data-editor-tool');

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 名前の入力の外 (図の外の原文の欄の代わり) へフォーカスを移す (外へフォーカスが移ると名前を決める)
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

const expand = (box: Box, by: number): Box => ({ left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by });
const overlaps = (a: Box, b: Box): boolean => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
const containsPoint = (box: Box, point: Point, by = 4): boolean => point.x >= box.left - by && point.x <= box.right + by && point.y >= box.top - by && point.y <= box.bottom + by;

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

const boxPoint = (page: Page, id: number): Promise<Point> => spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` });

// ノードの箱を押す
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

// key の線を押す
async function pressEdge(page: Page, key: string): Promise<void> {
    await press(page, await edgeSpot(page, key));
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

// from で押し、points を順にたどってから離す。at は各点まで動かしたあと (離す前) に、たどった点の添字で呼ぶ
async function dragThrough(page: Page, from: Point, points: Point[], at?: (index: number) => Promise<void>): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    try {
        for (const [index, point] of points.entries()) {
            await page.mouse.move(point.x, point.y, { steps: 6 });
            if (at) await at(index);
        }
    } finally {
        await page.mouse.up();
    }
}

const target = (id: number, refText: string): NodeTarget => ({ id, refText });

const sortedTargets = (targets: readonly NodeTarget[]): NodeTarget[] => [...targets].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }));

// 選択をそろえた形 (ノードは id の昇順。線はそのまま)
function normalized(selection: EditorSelection): EditorSelection {
    return selection.kind === 'nodes' ? { kind: 'nodes', nodes: sortedTargets(selection.nodes) } : selection;
}

interface SelectionState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // 図の要素 (#a) に data-edge-selected がある (線を強調している)
    highlighted: boolean;
    selection: EditorSelection;
}

async function selectionOf(page: Page): Promise<SelectionState> {
    const state = await page.evaluate(() => {
        const container = document.getElementById('a');
        const editor = (window as unknown as EditorWindow).editors.a;
        if (!container || !editor) throw new Error('#a の図がない');
        const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        return { marked, highlighted: container.hasAttribute('data-edge-selected'), selection: editor.getSelection() };
    });
    return { ...state, selection: normalized(state.selection) };
}

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方。線の強調はない)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = sortedTargets(targets);
    const selection: EditSelection = sorted.length === 0 ? { kind: 'none' } : { kind: 'nodes', nodes: sorted };
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), highlighted: false, selection });
}

const edgeKeyOf = (edge: EdgeTarget): string => `${edge.kind}:${edge.source}>${edge.target}`;

// 線が選ばれるまで待つ: getSelection が線、図の要素に data-edge-selected、view の selectEdge がその線 (onSelectEdge のキー)、ノードの印はない
async function expectEdgeSelected(page: Page, edge: EdgeTarget, message?: string): Promise<void> {
    await expect
        .poll(async () => ({ ...(await selectionOf(page)), viewKey: await lastEdgeKey(page) }), message)
        .toEqual({ marked: [], highlighted: true, selection: { kind: 'edge', edge }, viewKey: edgeKeyOf(edge) });
}

// onSelectionChange に最後に届いた選択
async function lastSelectionChange(page: Page): Promise<EditorSelection | null> {
    const last = (await selectionLog(page)).at(-1);
    return last === undefined ? null : normalized(last);
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

interface NameInputState {
    // 見えている名前の入力 (.mdag-editor-name-input[data-for="node"]) の数
    count: number;
    value: string | null;
    focused: boolean;
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

// 名前の入力がノードのラベルの上に 1 つ開き、フォーカスがあって、値が value になるまで待つ。
// 「ラベルの上」は、入力の矩形がノードの文字 (.mdag-content) の矩形と左右で重なり、入力の上下の中ほどがノードの箱の中にあること
async function expectNameInputOn(page: Page, id: number, value: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await nameInputOf(page);
            const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
            const [label] = await rectsOf(page, `${nodeSelector(id)} .mdag-content`);
            const rect = state.rect;
            const middle = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const onLabel = rect !== null && box !== undefined && label !== undefined && rect.left < label.right && rect.right > label.left && middle >= box.top - 2 && middle <= box.bottom + 2;
            return { count: state.count, value: state.value, focused: state.focused, onLabel };
        }, message)
        .toEqual({ count: 1, value, focused: true, onLabel: true });
}

// 名前の入力が開いていない (数コマ待ってから)
async function expectNoNameInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await nameInputOf(page)).count, message).toBe(0);
}

// 点 (.mdag-editor-handle[data-handle]) が 1 つ見えていて、相手 (ノードの箱の全体) の右にあるまで待つ。
// 右: 点の中心が相手の右の辺 (4px まで) より右。縦は相手の上下の範囲から 16px までに収まる (子の + と並べるときに縦にずらすことがある)
async function expectHandleRightOf(page: Page, kind: 'link' | 'join', ids: number[], message?: string): Promise<Box> {
    await expect(handles(page, kind), message).toHaveCount(1);
    await expect
        .poll(async () => {
            const [handle] = await rectsOf(page, `#a .mdag-editor-handle[data-handle="${kind}"]`);
            const area = union(await Promise.all(ids.map((id) => nodeBox(page, id))));
            if (!handle) return false;
            const cx = (handle.left + handle.right) / 2;
            const cy = (handle.top + handle.bottom) / 2;
            return cx >= area.right - 4 && cy >= area.top - 16 && cy <= area.bottom + 16;
        }, message)
        .toBe(true);
    const [handle] = await rectsOf(page, `#a .mdag-editor-handle[data-handle="${kind}"]`);
    if (!handle) throw new Error('点がない');
    return handle;
}

const handlePoint = (page: Page, kind: 'link' | 'join'): Promise<Point> => spot(page, { on: 'element', selector: `#a .mdag-editor-handle[data-handle="${kind}"]` });

// 見えている引く線 (.mdag-editor-link-preview) の全体の矩形。なければ null
async function previewBounds(page: Page): Promise<Box | null> {
    const rects = await rectsOf(page, '#a .mdag-editor-link-preview');
    return rects.length === 0 ? null : union(rects);
}

// 配布物の editSource で同じ書き換えを試す (断る理由の文と、結果の通知に出る外した数の文を引く。期待の空振りの防ぎにも使う)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const reasonOf = (outcome: EditOutcome): { code: string; message: string } | null => (outcome.status === 'edited' || !outcome.reason ? null : { code: outcome.reason.code, message: outcome.reason.message });

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

test.describe('線を引く (段 17。B-017、B-018、5.2 の軸 E、6.5)', () => {
    test('@editor 選択の道具で選んだノードの右に線を引く点が出る。点をほかのノードへドラッグすると、ドラッグの間は引く線が出て、離すと markdag.relations の depends に線を足す。onChange 1 回、モデルに線が出て、通知 (info) が出る。引いた線が選ばれ (data-edge-selected、getSelection と onSelectionChange が線)、ノードの選択と帯はなくなる。元に戻すで戻る (B-017、B-018)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        const handle = await expectHandleRightOf(page, 'link', [TASK_A]);
        expect(await relationKeys(page)).toEqual([]);

        const from = await handlePoint(page, 'link');
        const leaf = await boxPoint(page, LEAF);
        await dragThrough(page, from, [leaf], async () => {
            // 引く線は、点 (かノード) から伸びてポインタまで届く
            await expect
                .poll(async () => {
                    const bounds = await previewBounds(page);
                    if (!bounds) return 'なし';
                    const start = union([await nodeBox(page, TASK_A), handle]);
                    return overlaps(expand(bounds, 2), start) && containsPoint(bounds, leaf);
                }, 'ドラッグの途中の引く線')
                .toBe(true);
            // 離すまでは原文を変えない
            expect(await getSource(page)).toBe(DOC);
            expect(await changeLog(page)).toEqual([]);
        });

        await expectSource(page, DOC_LINKED, [DOC_LINKED]);
        await expect.poll(() => relationKeys(page)).toEqual(['depends:3>6']);
        await expect(previews(page), '離したあと').toHaveCount(0);
        const edge: EdgeTarget = { kind: 'depends', source: TASK_A, target: LEAF };
        await expectEdgeSelected(page, edge);
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'edge', edge });
        await expect(bars(page), '線を選んでも帯は出さない').toHaveCount(0);
        await expectNotice(page, 'info');
        await expectNoNameInput(page);

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC, [DOC_LINKED, DOC], '元に戻す');
        await expect.poll(() => relationKeys(page)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('@editor 線を引く点を同じノードへ戻して離すと、線を引かずに理由の通知を出す。原文、onChange、履歴は変わらない (B-018)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectHandleRightOf(page, 'link', [TASK_A]);
        // 空振りの防ぎ: 同じノードへの線は same-node で断られる
        expect(reasonOf(await tryEdit(page, DOC, { kind: 'addRelation', from: target(TASK_A, 'Task A'), to: target(TASK_A, 'Task A') }))?.code).toBe('same-node');
        await expect(snackbars(page)).toHaveCount(0);

        const from = await handlePoint(page, 'link');
        const blank = await spot(page, { on: 'blank' });
        const self = await boxPoint(page, TASK_A);
        await dragThrough(page, from, [blank, self]);
        await expectSourceStill(page, DOC, []);
        await expectNotice(page);
        await expect(previews(page)).toHaveCount(0);
        expect(await relationKeys(page)).toEqual([]);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor もうある線を引くと、線を引かずに理由 (edge-exists) の通知 (error) を出す。原文、onChange、履歴は変わらない (B-018)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_REL);
        await useSelectTool(page);
        const reason = reasonOf(await tryEdit(page, DOC_REL, { kind: 'addRelation', from: target(TASK_A, 'Task A'), to: target(LEAF, 'Leaf') }));
        expect(reason?.code).toBe('edge-exists');
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await expectHandleRightOf(page, 'link', [TASK_A]);

        await dragThrough(page, await handlePoint(page, 'link'), [await boxPoint(page, LEAF)]);
        await expectSourceStill(page, DOC_REL, []);
        const text = await expectNotice(page, 'error');
        expect(text).toContain(flat(reason?.message ?? ''));
        await expect(previews(page)).toHaveCount(0);
        expect(await relationKeys(page)).toEqual(['depends:3>6']);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });
});

test.describe('線を押す (段 17。5.2 の軸 C、10.1 の 1、10.1 の 3)', () => {
    test('@editor 線を押すと線が強調され (data-edge-selected)、getSelection と onSelectionChange が線を返し、帯は出ない。同じ線をもう 1 度押すと解ける。原文は変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_REL);
        await useSelectTool(page);
        const edge: EdgeTarget = { kind: 'depends', source: TASK_A, target: LEAF };

        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, edge);
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'edge', edge });
        await settle(page);
        await expect(bars(page)).toHaveCount(0);

        await pressEdge(page, 'depends:3>6');
        await expectSelection(page, [], 'もう 1 度押す');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expect(bars(page)).toHaveCount(0);
        await expectSourceStill(page, DOC_REL, []);
        expect(errors).toEqual([]);
    });

    test('@editor ノードを選んでいるときに線を押すと、選択が線に替わる (ノードの印、帯、外枠が消える)。線を選んでいるときにノードを押すとそのノード 1 つになり、何もないところを押すか Esc で選択が解ける (5.2 の軸 C)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_REL);
        await useSelectTool(page);
        const edge: EdgeTarget = { kind: 'depends', source: TASK_A, target: LEAF };

        // ノード 1 つ → 線
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')]);
        await expect(bars(page)).toHaveCount(1);
        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, edge, 'ノード 1 つから');
        await expect(bars(page), 'ノード 1 つから').toHaveCount(0);

        // 線 → ノード 1 つ (線の強調は解ける)
        await pressNode(page, TASK_B);
        await expectSelection(page, [target(TASK_B, 'Task B')], '線からノードへ');
        await expect(bars(page), '線からノードへ').toHaveCount(1);

        // ノード 2 つ以上 → 線
        await pressNodeWith(page, LEAF, 'Shift');
        await expectSelection(page, [target(TASK_B, 'Task B'), target(LEAF, 'Leaf')]);
        await expect(visible(page, '#a .mdag-editor-selection-bounds')).toHaveCount(1);
        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, edge, 'ノード 2 つ以上から');
        await expect(bars(page), 'ノード 2 つ以上から').toHaveCount(0);
        await expect(visible(page, '#a .mdag-editor-selection-bounds'), 'ノード 2 つ以上から').toHaveCount(0);

        // 線 → 何もないところ
        await pressBlank(page);
        await expectSelection(page, [], '何もないところ');

        // 線 → Esc
        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, edge, 'Esc の前');
        await page.keyboard.press('Escape');
        await expectSelection(page, [], 'Esc');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expectSourceStill(page, DOC_REL, []);
    });

    test('@editor markdag.edgeHighlight: false の文書でも、GUI 編集では関係の線と木の線を押して強調できる。別の線を押すとその線に替わる (10.1 の 3、5.2 の軸 C)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_REL_PLAIN);
        await useSelectTool(page);

        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, { kind: 'depends', source: TASK_A, target: LEAF }, '関係の線');
        await pressEdge(page, 'tree:2>3');
        await expectEdgeSelected(page, { kind: 'tree', source: DESIGN, target: TASK_A }, '木の線');
        await expect(bars(page)).toHaveCount(0);
        await expectSourceStill(page, DOC_REL_PLAIN, []);
    });

    test('@editor 線を選んで Delete / Backspace を押しても原文が変わらない (線の削除は入れない。10.1 の 1)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_REL);
        await useSelectTool(page);
        await pressEdge(page, 'depends:3>6');
        await expectEdgeSelected(page, { kind: 'depends', source: TASK_A, target: LEAF });

        await page.keyboard.press('Delete');
        await page.keyboard.press('Backspace');
        await expectSourceStill(page, DOC_REL, []);
        expect(await relationKeys(page)).toEqual(['depends:3>6']);
        expect(await nodeCount(page)).toBe(6);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });
});

test.describe('新しい合流先へ合流 (段 17。B-045、B-094〜B-098、B-105、3.7)', () => {
    test('@editor 2 つ以上を選んで J、帯の「合流ノードを作る」、道具箱の「合流」のどれでも、新しい合流先「合流点」を始点のいちばん後ろの最上位の枝のすぐあとに足し、join を書き足す。onChange 1 回、合流先が選ばれ、名前の入力がそのラベルの上に開き、通知 (info) が出る。元に戻すで戻る (B-045、B-094〜B-097)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        const triggers = ['J', '帯の合流ノードを作る', '道具箱の合流'] as const;
        for (const [index, trigger] of triggers.entries()) {
            if (index === 0) await mount(page, DOC);
            else await remount(page, DOC);
            await useSelectTool(page);
            await pressNode(page, TASK_A);
            await pressNodeWith(page, LEAF, 'Shift');
            await expectSelection(page, [target(TASK_A, 'Task A'), target(LEAF, 'Leaf')], trigger);

            if (trigger === 'J') await page.keyboard.press('j');
            else if (trigger === '帯の合流ノードを作る') await pressBar(page, 'join-new');
            else await toolButton(page, 'join').click();

            await expectSource(page, DOC_JOIN_NEW, [DOC_JOIN_NEW], trigger);
            await expect(page.locator('#a .mdag-node'), trigger).toHaveCount(7);
            await expect(labelOf(page, JOIN_NODE), trigger).toHaveText(JOIN_LABEL);
            await expect.poll(() => relationKeys(page), trigger).toEqual(['join:3>7', 'join:6>7']);
            await expectSelection(page, [target(JOIN_NODE, JOIN_LABEL)], trigger);
            await expect.poll(() => lastSelectionChange(page), trigger).toEqual({ kind: 'nodes', nodes: [target(JOIN_NODE, JOIN_LABEL)] });
            await expectNameInputOn(page, JOIN_NODE, JOIN_LABEL, trigger);
            await expectNotice(page, 'info', trigger);

            // 名前を変えずに決めてから、元に戻す
            await focusOutside(page);
            expect(await callUndo(page), trigger).toBe(true);
            await expectSource(page, DOC, [DOC_JOIN_NEW, DOC], `${trigger} の元に戻す`);
            await expect(page.locator('#a .mdag-node'), `${trigger} の元に戻す`).toHaveCount(6);
            await expect.poll(() => relationKeys(page), `${trigger} の元に戻す`).toEqual([]);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 2 つ未満の選択では、J は合流せずに失敗の通知 (error) を、道具箱の「合流」は囲んで選ぶよう案内の通知 (info) を出す。原文、onChange、履歴、道具は変わらない (B-098、B-105)', async ({ page }) => {
        test.setTimeout(120_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);

        // 何も選んでいない (ポインタは図の上)
        await pointerOverBlank(page);
        await page.keyboard.press('j');
        await expectNotice(page, 'error', '何も選んでいないときの J');
        await expectSourceStill(page, DOC, [], '何も選んでいないときの J');
        await expectNoticeGone(page);
        await toolButton(page, 'join').click();
        await expectNotice(page, 'info', '何も選んでいないときの道具箱の合流');
        await expectSourceStill(page, DOC, [], '何も選んでいないときの道具箱の合流');
        expect(await editorTool(page)).toBe('select');
        await expectNoticeGone(page);

        // 1 つだけ選んでいる
        await pressNode(page, TASK_A);
        await expectSelection(page, [target(TASK_A, 'Task A')]);
        await page.keyboard.press('j');
        await expectNotice(page, 'error', '1 つのときの J');
        await expectSourceStill(page, DOC, [], '1 つのときの J');
        await expectNoticeGone(page);
        await toolButton(page, 'join').click();
        await expectNotice(page, 'info', '1 つのときの道具箱の合流');
        await expectSourceStill(page, DOC, [], '1 つのときの道具箱の合流');
        expect(await editorTool(page)).toBe('select');
        expect(await nodeCount(page)).toBe(6);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });
});

test.describe('既存のノードへ合流 (段 17。B-099〜B-101、B-047、5.2 の軸 B)', () => {
    test('@editor 2 つ以上を選んで帯の「既存のノードへ合流」を押すと合流先を選ぶ途中 (data-editor-tool="join-target") になり、合流先を押すと join を書き足して合流先が選ばれ、もとの道具に戻る (選択の道具と手のひら)。元に戻すで戻る (B-099、B-101、B-095)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        for (const tool of ['select', 'hand'] as const) {
            if (tool === 'select') {
                await mount(page, DOC);
                await useSelectTool(page);
            } else {
                await remount(page, DOC);
                // 最初の道具は選択なので、道具箱で手のひらにする
                await toolButton(page, 'hand').click();
                await expect(page.locator('#a'), tool).toHaveAttribute('data-editor-tool', 'hand');
            }
            await pressNode(page, TASK_A);
            await pressNodeWith(page, TASK_B, 'Shift');
            await expectSelection(page, [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')], tool);

            await pressBar(page, 'join-existing');
            await expect(page.locator('#a'), tool).toHaveAttribute('data-editor-tool', 'join-target');
            await expectSourceStill(page, DOC, [], `${tool}: 合流先を押す前`);

            await pressNode(page, LEAF);
            await expectSource(page, DOC_JOIN_LEAF, [DOC_JOIN_LEAF], tool);
            await expect.poll(() => relationKeys(page), tool).toEqual(['join:3>6', 'join:4>6']);
            await expectSelection(page, [target(LEAF, 'Leaf')], tool);
            await expect.poll(() => lastSelectionChange(page), tool).toEqual({ kind: 'nodes', nodes: [target(LEAF, 'Leaf')] });
            await expect(page.locator('#a'), tool).toHaveAttribute('data-editor-tool', tool);
            await expectNotice(page, 'info', tool);
            await expectNoNameInput(page, tool);

            expect(await callUndo(page), tool).toBe(true);
            await expectSource(page, DOC, [DOC_JOIN_LEAF, DOC], `${tool} の元に戻す`);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 合流先を選ぶ途中は、Esc でやめて選択も解け (1 回で)、何もないところを押してもやめる。どちらも原文は変わらず、もとの道具に戻り、そのあとノードを押しても合流しない (B-099、B-047、5.2 の軸 B)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);

        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')]);
        await pressBar(page, 'join-existing');
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'join-target');
        await page.keyboard.press('Escape');
        await expect(page.locator('#a'), 'Esc').toHaveAttribute('data-editor-tool', 'select');
        await expectSelection(page, [], 'Esc');
        await pressNode(page, LEAF);
        await expectSelection(page, [target(LEAF, 'Leaf')], 'Esc のあとにノードを押す');
        await expectSourceStill(page, DOC, [], 'Esc');

        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')]);
        await pressBar(page, 'join-existing');
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'join-target');
        await pressBlank(page);
        await expect(page.locator('#a'), '何もないところ').toHaveAttribute('data-editor-tool', 'select');
        await pressNode(page, LEAF);
        await expectSelection(page, [target(LEAF, 'Leaf')], '何もないところのあとにノードを押す');
        await expectSourceStill(page, DOC, [], '何もないところ');
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });
});

test.describe('選択全体の点のドラッグ (段 17。B-100、B-101、6.5)', () => {
    test('@editor 2 つ以上を選ぶと選択全体の右に点が出る。点を合流先へドラッグすると、ドラッグの間は各始点から 1 点 (ポインタ) へ集まる線が出て、離すと合流し、合流先が選ばれる。元に戻すで戻る (B-100、B-101)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')]);
        const handle = await expectHandleRightOf(page, 'join', [TASK_A, TASK_B]);

        const from = await handlePoint(page, 'join');
        const leaf = await boxPoint(page, LEAF);
        await dragThrough(page, from, [leaf], async () => {
            // 集まる線は、始点のそれぞれ (縦の中ほど) からポインタまでを覆う
            await expect
                .poll(async () => {
                    const bounds = await previewBounds(page);
                    if (!bounds) return 'なし';
                    const sources = await Promise.all([TASK_A, TASK_B].map((id) => nodeBox(page, id)));
                    const fromEach = sources.every((box) => {
                        const middle = (box.top + box.bottom) / 2;
                        return bounds.top <= middle + 2 && bounds.bottom >= middle - 2;
                    });
                    return fromEach && bounds.left <= handle.right + 2 && containsPoint(bounds, leaf);
                }, 'ドラッグの途中の集まる線')
                .toBe(true);
            expect(await getSource(page)).toBe(DOC);
            expect(await changeLog(page)).toEqual([]);
        });

        await expectSource(page, DOC_JOIN_LEAF, [DOC_JOIN_LEAF]);
        await expect.poll(() => relationKeys(page)).toEqual(['join:3>6', 'join:4>6']);
        await expect(previews(page), '離したあと').toHaveCount(0);
        await expectSelection(page, [target(LEAF, 'Leaf')]);
        await expectNotice(page, 'info');

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC, [DOC_JOIN_LEAF, DOC], '元に戻す');
        expect(errors).toEqual([]);
    });
});

test.describe('外す始点 (段 17。B-102〜B-104、3.7)', () => {
    test('@editor 合流先へもう線がある始点と、合流先からたどって届く (循環になる) 始点を外して合流し、外した数を分けて通知に出す。残りが 1 つなら depends に足す (B-102〜B-104、B-095)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SKIP);
        // 空振りの防ぎ: Design、Task A、Task B から Leaf への合流は、循環になる始点 1 つと線のある始点 1 つを外す
        const outcome = await tryEdit(page, DOC_SKIP, { kind: 'joinInto', sources: [target(DESIGN, 'Design'), target(TASK_A, 'Task A'), target(TASK_B, 'Task B')], target: target(LEAF, 'Leaf') });
        const notes = outcome.status === 'edited' ? outcome.notes : [];
        expect(notes.map((note) => `${note.code}:${note.count}`).sort()).toEqual(['sources-cycle:1', 'sources-existing:1']);

        await useSelectTool(page);
        await pressNode(page, DESIGN);
        await pressNodeWith(page, TASK_A, 'Shift');
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectSelection(page, [target(DESIGN, 'Design'), target(TASK_A, 'Task A'), target(TASK_B, 'Task B')]);
        await pressBar(page, 'join-existing');
        await pressNode(page, LEAF);

        await expectSource(page, DOC_SKIP_JOINED, [DOC_SKIP_JOINED]);
        await expect.poll(() => relationKeys(page)).toEqual(['depends:2>6', 'depends:3>6', 'depends:6>4']);
        await expectSelection(page, [target(LEAF, 'Leaf')]);
        const text = await expectNotice(page, 'info');
        for (const note of notes) expect(text, note.code).toContain(flat(note.message));
    });

    test('@editor 始点が全部外れる合流は原文を変えず、理由 (all-sources-skipped) の通知 (error) を出し、履歴に積まない。もとの道具に戻る (B-104)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SKIP);
        const reason = reasonOf(await tryEdit(page, DOC_SKIP, { kind: 'joinInto', sources: [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')], target: target(LEAF, 'Leaf') }));
        expect(reason?.code).toBe('all-sources-skipped');

        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(TASK_B, 'Task B')]);
        await pressBar(page, 'join-existing');
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'join-target');
        await pressNode(page, LEAF);

        await expectSourceStill(page, DOC_SKIP, []);
        const text = await expectNotice(page, 'error');
        expect(text).toContain(flat(reason?.message ?? ''));
        expect(await relationKeys(page)).toEqual(['depends:3>6', 'depends:6>4']);
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });
});

test.describe('閲覧の合流と線 (段 17。B-169、B-171)', () => {
    test('@editor 閲覧では線を引く点と選択全体の点が出ず、J で原文が変わらない (閲覧だけの文書と、GUI 編集で 2 つを選んでから切り替えた閲覧)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);

        await mount(page, DOC_VIEW);
        expect(await getMode(page)).toBe('view');
        await pressNode(page, TASK_A);
        await page.keyboard.press('j');
        await expectSourceStill(page, DOC_VIEW, [], '閲覧だけの文書');
        await expect(handles(page, 'link'), '閲覧だけの文書').toHaveCount(0);
        await expect(handles(page, 'join'), '閲覧だけの文書').toHaveCount(0);

        await remount(page, DOC_SWITCH);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, LEAF, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(LEAF, 'Leaf')]);
        await expectHandleRightOf(page, 'join', [TASK_A, LEAF], '切り替える前');
        expect(await setMode(page, 'view')).toBe(true);
        await expect(handles(page, 'join'), '切り替えた閲覧').toHaveCount(0);
        await expect(handles(page, 'link'), '切り替えた閲覧').toHaveCount(0);
        await pointerOverBlank(page);
        await page.keyboard.press('j');
        await expectSourceStill(page, DOC_SWITCH, [], '切り替えた閲覧');
        expect(await nodeCount(page)).toBe(6);

        // 空振りの防ぎ: GUI 編集へ戻して選び直すと、同じ図の J で合流する
        expect(await setMode(page, 'edit')).toBe(true);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, LEAF, 'Shift');
        await expectSelection(page, [target(TASK_A, 'Task A'), target(LEAF, 'Leaf')]);
        await page.keyboard.press('j');
        await expectSource(page, DOC_SWITCH_JOIN_NEW, [DOC_SWITCH_JOIN_NEW]);
    });
});

// GUI 編集のタグ (タグ追加とタグ選択のパネル、タグのクリック) を、ビルドした配布物の markdag/editor で確かめる。
// 1 行目の印とタグの書き方、setTag、removeTag、toggleTag の選び直しと断る理由 (印を書けないノードはキーの操作でも理由を知らせる)、
// 1 回の操作は 1 回の editSource (複数のノードに付けるのも 1 回)、markdag: を足す書き換え、最近使ったタグは mount の間だけ覚えること、
// パネルのキー (変換中のキー、同じタグの 2 回目)、パネルの置き場 (right、bottom の順)、タグの上のダブルクリックでは onNodeDoubleClick を呼ばないことを見る。
// 見た目そのもの (色、余白、影、パネルの大きさ) は見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、モデルの tagsOf、
// 選択 (data-selected と getSelection)、パネルの有無と種類 (data-panel)、行 (.mdag-editor-tag-row の data-key、data-value、data-state) の並びと数、
// キーと値の欄の値とフォーカス、追加 / 更新のボタン、置き場の向き (パネルとノードの箱の位置の関係)、通知 (.mdag-editor-snackbar と data-kind)、
// 元に戻すを見る。期待の原文は 1 行目の印とタグの書き方の規則から書き、配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)。
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
const VIEW = ['mode: view'];

// markdag.editor を書いた文書。markdag の行は markdag の下の字下げ (4 桁) から、editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く
function docWith(editor: string[], body: string[], markdag: string[] = []): string {
    return ['---', 'markdag:', ...markdag.map((line) => `    ${line}`), '    editor:', ...editor.map((line) => `        ${line}`), '---', '', ...body].join('\n');
}

// markdag.tags.keys に、文書で使っていないキー status (multiple なし) だけを定義する
const KEYS = ['tags:', '    keys:', '        status:', '            type: string'];

// ノードは Root 1、Design 2、Task A 3、Task B 4、Task C 5、Build 6、Leaf 7。図は左から右へ広がり、同じ親の子は縦に並ぶ。
// owner と prio と team は定義のないキー (複数の値を持てる)。Leaf は Task A と同じ team:core と owner:alice を持つ
// (選んだノードから外しても、登録されているタグの行が残る)
const A_LINE = '- Task A #team:core #prio:high #owner:alice';
const B_LINE = '- Task B #team:core #owner:bob';
const C_LINE = '- Task C';
const LEAF_LINE = '- Leaf #team:core #owner:alice #prio:low';

function designBody(items: string[], leaf = LEAF_LINE): string[] {
    return ['# Root', '', '## Design', '', ...items, '', '## Build', '', leaf, ''];
}

// Task A、Task B、Task C の行だけを替えた文書
function docLines(a = A_LINE, b = B_LINE, c = C_LINE, editor: string[] = EDIT): string {
    return docWith(editor, designBody([a, b, c]), KEYS);
}

const DOC = docLines();
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const TASK_C = 5;
const BUILD = 6;
const LEAF = 7;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Task C', 6: 'Build', 7: 'Leaf' };

interface Row {
    key: string;
    value: string | null;
}

interface StatedRow extends Row {
    state: 'all' | 'some' | 'none';
}

const row = (key: string, value: string | null, state: StatedRow['state']): StatedRow => ({ key, value, state });

// DOC の登録されているタグ (文書で使われているタグと markdag.tags.keys のキー。キー、値の順)
const REGISTERED: Row[] = [
    { key: 'owner', value: 'alice' },
    { key: 'owner', value: 'bob' },
    { key: 'prio', value: 'high' },
    { key: 'prio', value: 'low' },
    { key: 'status', value: null },
    { key: 'team', value: 'core' },
];

// タグ追加の書き換え
// Task A の owner を bob に置き換える (同じキーはその位置で置き換える)
const A_OWNER_BOB = docLines('- Task A #team:core #prio:high #owner:bob');
// 続けて値のない urgent を付ける (末尾に足す)
const A_URGENT = docLines('- Task A #team:core #prio:high #owner:bob #urgent');
// 続けて空白のある値の note を付ける ("…" で囲む)
const A_NOTE = docLines('- Task A #team:core #prio:high #owner:bob #urgent #note:"a b"');
// Task A と Task B に 1 回で note を付ける
const AB_NOTE = docLines('- Task A #team:core #prio:high #owner:alice #note:"a b"', '- Task B #team:core #owner:bob #note:"a b"');
// Task C に、先頭の # と後ろの空白を外したキー prio を付ける
const C_PRIO = docLines(A_LINE, B_LINE, '- Task C #prio:low');
// Task C に、空白を含むキー a b を値なしで付ける (" で囲む。B-134)
const C_QUOTED_KEY = docLines(A_LINE, B_LINE, '- Task C #"a b"');
// Task C に、変換で入れた値を付ける
const C_KANA = docLines(A_LINE, B_LINE, '- Task C #owner:アリス');

// 付いているタグの編集
// prio を押して値を low に更新する
const A_EDIT_PRIO = docLines('- Task A #team:core #prio:low #owner:alice');
// owner を押してキーを lead に変える (もとのキーの位置で置き換える。replaceKey)
const A_EDIT_KEY = docLines('- Task A #team:core #prio:low #lead:alice');
// team を押してから新規に戻り、urgent を付ける (team は変わらず、末尾に足す)
const A_EDIT_NEW = docLines('- Task A #team:core #prio:low #lead:alice #urgent');
// prio の × で外す
const A_EDIT_REMOVED = docLines('- Task A #team:core #lead:alice #urgent');
// Task A と Task B を選んで team の × で外す
const AB_TEAM_REMOVED = docLines('- Task A #prio:high #owner:alice', '- Task B #owner:bob');

// タグ選択の付け外し (Task A と Task B を選ぶ)
// owner:alice は Task A にだけある (some) ので、Task B に足す (owner は定義がないので値を足す)
const AB_TOGGLE_1 = docLines(A_LINE, '- Task B #team:core #owner:bob,alice');
// もう 1 度押すと全部にあるので外す (Task A は値がなくなりキーごと、Task B は alice だけ)
const AB_TOGGLE_2 = docLines('- Task A #team:core #prio:high', B_LINE);
// team:core は全部にあるので外す
const AB_TOGGLE_3 = docLines('- Task A #prio:high', '- Task B #owner:bob');
// もう 1 度押すと付く (末尾に足す)
const AB_TOGGLE_4 = docLines('- Task A #prio:high #team:core', '- Task B #owner:bob #team:core');

// 最近使ったタグ (Task C に付けていく)
const C_RECENT_1 = docLines(A_LINE, B_LINE, '- Task C #urgent');
const C_RECENT_2 = docLines(A_LINE, B_LINE, '- Task C #urgent #owner:carol');
const C_RECENT_3 = docLines(A_LINE, B_LINE, '- Task C #urgent #owner:carol #prio:high');
const C_RECENT_4 = docLines(A_LINE, B_LINE, '- Task C #urgent #owner:carol #prio:high #team:core');

// prio を multiple なしで定義した文書 (同じキーの別の値は置き換える)。ノードは Root 1、Design 2、Task A 3、Task B 4、Task C 5、Build 6、Leaf 7
const PRIO_KEYS = ['tags:', '    keys:', '        prio:', '            type: string'];
const keyedDoc = (a: string, b: string): string => docWith(EDIT, designBody([a, b, C_LINE], '- Leaf'), PRIO_KEYS);
const DOC_KEYS = keyedDoc('- Task A #prio:high #owner:alice', '- Task B #prio:low #owner:bob,carol');
// Task A に prio:low を付けると、prio は複数の値を持てないので置き換える
const KEYS_1 = keyedDoc('- Task A #prio:low #owner:alice', '- Task B #prio:low #owner:bob,carol');
// Task A に owner:bob を付けると、owner は定義がないので値を足す
const KEYS_2 = keyedDoc('- Task A #prio:low #owner:alice,bob', '- Task B #prio:low #owner:bob,carol');
// Task B の owner:bob を外すと、ほかの値 (carol) は残る
const KEYS_3 = keyedDoc('- Task A #prio:low #owner:alice,bob', '- Task B #prio:low #owner:carol');

// タグを吹き出しに出す文書 (markdag.tags.display: click)
const DOC_POPOVER = docWith(EDIT, designBody([A_LINE, B_LINE, C_LINE]), ['tags:', '    display: click']);

// 本文の Leaf だけを変えた文書 (外からの差し替えに使う)
const DOC_OTHER = docWith(EDIT, designBody([A_LINE, B_LINE, C_LINE], '- Leaf 2'), KEYS);

// markdag キーのない文書。frontmatter はあるが markdag キーがないもの、frontmatter がないもの。ノードは R 1、a 2
const DOC_NO_MARKDAG = ['---', 'title: T', '---', '# R', '', '- a', ''].join('\n');
const DOC_NO_MARKDAG_TAGGED = ['---', 'title: T', 'markdag:', '---', '# R', '', '- a #owner:alice', ''].join('\n');
const DOC_NO_FRONTMATTER = ['# R', '', '- a', ''].join('\n');
const DOC_NO_FRONTMATTER_TAGGED = ['---', 'markdag:', '---', '', '# R', '', '- a #owner:alice', ''].join('\n');

// 下線の見出し。ノードは Root 1 (下線の h1)、Design 2 (下線の h2)、Task A 3
const DOC_SETEXT = docWith(EDIT, ['Root', '====', '', 'Design', '------', '', '- Task A', '']);
// Design と Task A にタグを付けた文書。Design は同じ段の ATX の見出しに書き直してから付ける (D-049)
const DOC_SETEXT_TAGGED = docWith(EDIT, ['Root', '====', '', '## Design #owner:alice', '', '- Task A #owner:alice', '']);

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

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知、最近使ったタグを初めの状態に戻す)。onChange と onSelectionChange の記録も空にする
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
// ノードの中のタグの要素 (GUI 編集ではタグごとに分かれる)
const tagSelector = (id: number, key: string): string => `${nodeSelector(id)} .mdag-tags .mdag-tag[data-tag-key="${key}"]`;
// 吹き出しの中のタグの要素
const popoverTagSelector = (key: string): string => `#a .mdag-popover .mdag-popover-tags .mdag-tag[data-tag-key="${key}"]`;

// フォーカスのある所 (#a は図の要素、body はどこにもない。ほかは要素の名前)
const focusOf = (page: Page): Promise<string> =>
    page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        if (active.id === 'a') return '#a';
        return active.tagName.toLowerCase();
    });

async function useTool(page: Page, tool: 'hand' | 'select'): Promise<void> {
    await toolButton(page, tool).click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', tool);
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

// ノードの箱の全体を囲む矩形
async function unionBox(page: Page, ids: number[]): Promise<Box> {
    const boxes = await Promise.all(ids.map((id) => nodeBox(page, id)));
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
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

// 修飾キーを押したまま点を押す
async function pressWith(page: Page, point: Point, modifier: string): Promise<void> {
    await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        await page.keyboard.up(modifier);
    }
}

// ノードの文字を押す (タグの要素の上は押さない。手のひらでも選択の道具でもノードを選ぶ)
const contentPoint = (page: Page, id: number): Promise<Point> => spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-content` });

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await contentPoint(page, id));
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

const target = (id: number, refText = REF_TEXTS[id] ?? ''): NodeTarget => ({ id, refText });

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

// ノードを選ぶ: 最初のノードを修飾キーなしで押し (それだけを選ぶ)、残りを Shift +クリックで足す (選択の道具で使う)
async function selectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const [first, ...rest] = ids;
    if (first === undefined) throw new Error('選ぶノードがない');
    await pressNode(page, first);
    await expectSelection(page, [target(first)], message);
    for (const id of rest) await pressWith(page, await contentPoint(page, id), 'Shift');
    await expectSelection(
        page,
        ids.map((id) => target(id)),
        message,
    );
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

// 変換中のキー。Chromium の IME と同じく keyCode 229 で送る (Input.imeSetComposition で変換を始めていれば isComposing も true)
async function pressComposing(client: CDPSession, key: 'Enter' | 'Escape'): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

// 配布物の editSource で同じ書き換えを試す (期待の原文と断る理由の文を確かめる。期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

const targets = (ids: number[]): NodeTarget[] => ids.map((id) => target(id));
const setTagOp = (ids: number[], key: string, value: string | null, replaceKey: string | null = null): EditOp => ({ kind: 'setTag', nodes: targets(ids), key, value, replaceKey });
const removeTagOp = (ids: number[], key: string): EditOp => ({ kind: 'removeTag', nodes: targets(ids), key });
const toggleTagOp = (ids: number[], key: string, value: string | null): EditOp => ({ kind: 'toggleTag', nodes: targets(ids), key, value });

// source に op を当てると expected になる (期待の書き誤りを、実装の前の赤の確認で見分けるため)
async function expectEdit(page: Page, source: string, op: EditOp, expected: string): Promise<void> {
    expect(editedSource(await tryEdit(page, source, op)), JSON.stringify(op)).toBe(expected);
}

// 描いている文書の原文で、ノードの原文の事実を読む (期待の空振りの防ぎ)
async function factsOf(page: Page, id: number): Promise<{ kind: string; canMark: boolean } | null> {
    return page.evaluate((id) => {
        const target = window as unknown as EditorWindow;
        const editor = target.editors.a;
        const node = editor?.view.getDocument()?.parsed.nodes.find((entry) => entry.id === id);
        if (!editor || !node) return null;
        const facts = target.editorHarness.core.inspectNode(editor.getSource(), { id: node.id, refText: node.refText });
        return facts === null ? null : { kind: facts.kind, canMark: facts.canMark };
    }, id);
}

// 描いている文書のモデルの、ノードのタグ (tagsOf。書いた順)
async function tagsOf(page: Page, id: number): Promise<Array<{ key: string; values: string[] }>> {
    return page.evaluate((id) => {
        const doc = (window as unknown as EditorWindow).editors.a?.view.getDocument();
        return (doc?.model.tagsOf.get(id) ?? []).map((tag) => ({ key: tag.key, values: [...tag.values] }));
    }, id);
}

interface PanelRow {
    key: string | null;
    // data-value。値のない行は、属性がないか空の文字のどちらでも null
    value: string | null;
    state: string | null;
}

interface PanelState {
    // 見えているタグのパネル (.mdag-editor-tag-panel) の数
    count: number;
    // data-panel (add か select)
    kind: string | null;
    // パネルの中の文字の入力 (input の type が text か search か省いたもの) の値 (並びの順)。タグ追加は キー、値 の順、タグ選択は絞り込みの欄
    fields: string[];
    // フォーカスのある文字の入力の添字 (fields の)。なければ -1
    focused: number;
    // パネルの中のボタンの文字 (空白を外したもの)
    buttons: string[];
    // 行 (.mdag-editor-tag-row) の並び
    rows: PanelRow[];
    // パネルの矩形
    rect: Box | null;
}

const CLOSED: Omit<PanelState, 'count'> = { kind: null, fields: [], focused: -1, buttons: [], rows: [], rect: null };

async function panelOf(page: Page): Promise<PanelState> {
    return page.evaluate((closed) => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const shown = [...container.querySelectorAll('.mdag-editor-tag-panel')].filter((element) => element.checkVisibility());
        const panel = shown[0];
        if (shown.length !== 1 || !panel) return { count: shown.length, ...closed };
        const fields = [...panel.querySelectorAll('input')].filter((input) => input.checkVisibility() && ['text', 'search'].includes((input.getAttribute('type') ?? 'text').toLowerCase()));
        const outer = panel.getBoundingClientRect();
        return {
            count: 1,
            kind: panel.getAttribute('data-panel'),
            fields: fields.map((input) => input.value),
            focused: fields.findIndex((input) => input === document.activeElement),
            buttons: [...panel.querySelectorAll('button')].filter((button) => button.checkVisibility()).map((button) => (button.textContent ?? '').replace(/\s+/g, '')),
            rows: [...panel.querySelectorAll('.mdag-editor-tag-row')]
                .filter((element) => element.checkVisibility())
                .map((element) => {
                    const value = element.getAttribute('data-value');
                    return { key: element.getAttribute('data-key'), value: value === null || value === '' ? null : value, state: element.getAttribute('data-state') };
                }),
            rect: { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom },
        };
    }, CLOSED);
}

// タグのパネルが 1 つ開き、種類が kind になるまで待つ
async function expectPanel(page: Page, kind: 'add' | 'select', message?: string): Promise<void> {
    await expect.poll(async () => {
        const state = await panelOf(page);
        return { count: state.count, kind: state.kind };
    }, message).toEqual({ count: 1, kind });
}

async function expectPanelClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await panelOf(page)).count, message).toBe(0);
}

// タグのパネルが開いていない (数コマ待ってから)
async function expectNoPanel(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await panelOf(page)).count, message).toBe(0);
}

type AddMode = 'new' | 'edit' | 'unknown';

// タグ追加のパネルの入力の状態。mode は送るボタンの文字で見る (新規は「追加」、付いているタグの編集は「更新」)
interface AddState {
    count: number;
    kind: string | null;
    key: string | null;
    value: string | null;
    mode: AddMode;
}

const startsWith = (buttons: string[], name: string): boolean => buttons.some((text) => text.startsWith(name));

async function addStateOf(page: Page): Promise<AddState> {
    const state = await panelOf(page);
    const mode: AddMode = startsWith(state.buttons, '更新') ? 'edit' : startsWith(state.buttons, '追加') ? 'new' : 'unknown';
    return { count: state.count, kind: state.kind, key: state.fields[0] ?? null, value: state.fields[1] ?? null, mode };
}

// タグ追加のパネルが開き、キーと値の欄が key と value で、mode になるまで待つ
async function expectAdd(page: Page, key: string, value: string, mode: AddMode, message?: string): Promise<void> {
    await expect.poll(() => addStateOf(page), message).toEqual({ count: 1, kind: 'add', key, value, mode });
}

// タグ追加のパネルが新規の入力 (キーと値が空、送るボタンは「追加」) で、キーの欄にフォーカスがあるまで待つ
async function expectFreshAdd(page: Page, message?: string): Promise<void> {
    await expectAdd(page, '', '', 'new', message);
    await expect.poll(async () => (await panelOf(page)).focused, message).toBe(0);
}

// 行の data-key、data-value、data-state の並び
async function rowsOf(page: Page): Promise<PanelRow[]> {
    return (await panelOf(page)).rows;
}

const statedRows = (rows: StatedRow[]): PanelRow[] => rows.map(({ key, value, state }) => ({ key, value, state }));

// タグ追加のパネルの行 (付いているタグ) のキー (重ならないよう並べ直したもの)
async function attachedKeys(page: Page): Promise<string[]> {
    return [...new Set((await rowsOf(page)).map((item) => item.key ?? ''))].sort();
}

type PanelTarget =
    // 行。value を省くとキーだけで探す。which は同じ行が 2 つ以上 (最近使ったタグと登録されているタグ) あるときの選び方 (既定は後ろ)。
    // part は行そのもの (× の外) か、行の × (外すボタン)
    | { on: 'row'; key: string; value?: string | null; which?: 'first' | 'last'; part?: 'body' | 'remove' }
    // 文字が name で始まるボタン (追加、更新、新規に戻る)
    | { on: 'button'; name: string }
    // 文字の入力 (添字は PanelState の fields と同じ)
    | { on: 'field'; index: number }
    // 絞り込みの欄
    | { on: 'filter' };

// タグのパネルの中の押せる点を探す。行の × は、文字が × の要素か、aria-label か title に「外す」があるボタン
async function panelPoint(page: Page, target: PanelTarget): Promise<Point> {
    const found = await page.evaluate((target) => {
        const shownOnly = (elements: Iterable<Element>): HTMLElement[] => [...elements].filter((element): element is HTMLElement => element instanceof HTMLElement && element.checkVisibility());
        const panel = shownOnly(document.querySelectorAll('#a .mdag-editor-tag-panel'))[0];
        if (!panel) return { error: 'タグのパネルが開いていない' };
        const removeOf = (rowElement: HTMLElement): HTMLElement | undefined => {
            const inside = shownOnly(rowElement.querySelectorAll('*'));
            const byText = inside.filter((element) => ['×', '✕', '✖'].includes((element.textContent ?? '').trim()));
            if (byText.length > 0) return byText.at(-1);
            return inside.filter((element) => element.matches('button, [role="button"]') && `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`.includes('外す')).at(-1);
        };
        let element: HTMLElement | undefined;
        let avoid: HTMLElement | undefined;
        if (target.on === 'row') {
            const rows = shownOnly(panel.querySelectorAll('.mdag-editor-tag-row')).filter((rowElement) => {
                if (rowElement.getAttribute('data-key') !== target.key) return false;
                if (target.value === undefined) return true;
                const value = rowElement.getAttribute('data-value');
                return (value === null || value === '' ? null : value) === target.value;
            });
            const rowElement = target.which === 'first' ? rows[0] : rows.at(-1);
            if (!rowElement) return { error: `行がない: ${JSON.stringify(target)}` };
            if (target.part === 'remove') {
                element = removeOf(rowElement);
                if (!element) return { error: `行に × がない: ${JSON.stringify(target)}` };
            } else {
                element = rowElement;
                avoid = removeOf(rowElement);
            }
        } else if (target.on === 'button') {
            element = shownOnly(panel.querySelectorAll('button')).find((button) => (button.textContent ?? '').replace(/\s+/g, '').startsWith(target.name));
        } else if (target.on === 'field') {
            element = shownOnly(panel.querySelectorAll('input')).filter((input) => ['text', 'search'].includes((input.getAttribute('type') ?? 'text').toLowerCase()))[target.index];
        } else {
            const filter = shownOnly(panel.querySelectorAll('.mdag-editor-tag-filter'))[0];
            element = filter instanceof HTMLInputElement ? filter : (shownOnly(filter?.querySelectorAll('input') ?? [])[0] ?? undefined);
        }
        if (!element) return { error: `見つからない: ${JSON.stringify(target)}` };
        const rect = element.getBoundingClientRect();
        const step = Math.max(1, Math.min(rect.width, rect.height) / 6);
        const points: Array<{ x: number; y: number }> = [];
        for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        const point = points.find(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return hit !== null && element.contains(hit) && !(avoid !== undefined && avoid.contains(hit));
        });
        return point ?? { error: `押せる点がない: ${JSON.stringify(target)}` };
    }, target);
    if ('error' in found) throw new Error(found.error);
    return found;
}

// パネルの中を押す。パネルは中身が変わると大きさが変わり、図が置き直す (描画のコマを待つ) ので、置き場が落ち着いてから押す点を決める
async function pressInPanel(page: Page, target: PanelTarget): Promise<void> {
    await settle(page);
    await press(page, await panelPoint(page, target));
}

// 文字の入力 (fields の添字) を押してフォーカスを置き、中身を全部選んで text を打つ
async function fillField(page: Page, index: number, text: string): Promise<void> {
    await pressInPanel(page, { on: 'field', index });
    await expect.poll(async () => (await panelOf(page)).focused).toBe(index);
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await expect.poll(async () => (await panelOf(page)).fields[index]).toBe(text);
}

const KEY_FIELD = 0;
const VALUE_FIELD = 1;

// タグ追加のパネルでキーと値を入れる (value が空なら値の欄は空にする)
async function fillTag(page: Page, key: string, value: string): Promise<void> {
    await fillField(page, KEY_FIELD, key);
    await fillField(page, VALUE_FIELD, value);
}

// 絞り込みの欄に text を入れる (空なら消す)
async function fillFilter(page: Page, text: string): Promise<void> {
    await pressInPanel(page, { on: 'filter' });
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
}

// キーの欄の候補 (キーの欄の list が指す datalist の option の値。重ならないよう並べ直したもの)
async function keyCandidates(page: Page): Promise<string[] | null> {
    return page.evaluate(() => {
        const panel = [...document.querySelectorAll('#a .mdag-editor-tag-panel')].find((element) => element.checkVisibility());
        const field = [...(panel?.querySelectorAll('input') ?? [])].find((input) => input.checkVisibility() && ['text', 'search'].includes((input.getAttribute('type') ?? 'text').toLowerCase()));
        const list = field?.list;
        if (!list) return null;
        return [...new Set([...list.options].map((option) => option.value))].sort();
    });
}

type Place = 'right' | 'bottom' | 'top' | 'other';

// パネルが相手の矩形のどちら側にあるか。右: 相手の右の辺より右で上下が重なる。下: 相手の下の辺より下で左右が重なる。上: 相手の上の辺より上で左右が重なる
function placeOf(panel: Box, box: Box): Place {
    const horizontal = panel.left < box.right && panel.right > box.left;
    const vertical = panel.top < box.bottom && panel.bottom > box.top;
    if (panel.left >= box.right - 1 && vertical) return 'right';
    if (panel.top >= box.bottom - 1 && horizontal) return 'bottom';
    if (panel.bottom <= box.top + 1 && horizontal) return 'top';
    return 'other';
}

const insideBox = (inner: Box, outer: Box): boolean => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;

// タグのパネルが選んだノード (全体) の place の側にあり、図の領域に収まるまで待つ
async function expectPanelPlaced(page: Page, ids: number[], place: Place, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const state = await panelOf(page);
            if (state.rect === null) return { count: state.count };
            return { count: state.count, place: placeOf(state.rect, await unionBox(page, ids)), inside: insideBox(state.rect, await areaBox(page)) };
        }, message)
        .toEqual({ count: 1, place, inside: true });
}

interface BoxSpot {
    // 箱 (2 つ以上なら全体) の左の辺、右の辺 (図の領域の左の辺から)
    left?: number;
    right?: number;
    // 上下の中ほど (図の領域の上の辺から)
    centerY?: number;
}

// 図をパンして、ノードの箱 (2 つ以上なら全体) を図の領域の決まった位置に置く (倍率は変えない)
async function moveNodesTo(page: Page, ids: number[], want: BoxSpot): Promise<void> {
    const area = await areaBox(page);
    const box = await unionBox(page, ids);
    const dx = want.left !== undefined ? area.left + want.left - box.left : want.right !== undefined ? area.left + want.right - box.right : 0;
    const dy = want.centerY !== undefined ? area.top + want.centerY - (box.top + box.bottom) / 2 : 0;
    await page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });
    await settle(page);
    const moved = await unionBox(page, ids);
    if (want.left !== undefined) expect(Math.abs(moved.left - (area.left + want.left))).toBeLessThan(2);
    if (want.right !== undefined) expect(Math.abs(moved.right - (area.left + want.right))).toBeLessThan(2);
    if (want.centerY !== undefined) expect(Math.abs((moved.top + moved.bottom) / 2 - (area.top + want.centerY))).toBeLessThan(2);
}

// 図を縮めて、右の列 (Task A〜C と Leaf) の右にタグのパネルが入る空きを作る (Task A はタグで横に長い。図の領域の左の辺の近くを中心に縮める)
async function makeRoomOnRight(page: Page): Promise<void> {
    const area = await areaBox(page);
    await page.evaluate((point) => (window as unknown as EditorWindow).editors.a?.view.zoomBy(0.6, point), { x: 100, y: (area.bottom - area.top) / 2 });
    await settle(page);
    const right = Math.max(...(await Promise.all([TASK_A, TASK_B, TASK_C, LEAF].map((id) => nodeBox(page, id)))).map((box) => box.right));
    expect(area.right - right, '右の空き').toBeGreaterThan(360);
}

// 名前の入力 (ノード) と詳細の入力の見えている数
const nameInputCount = (page: Page): Promise<number> => visible(page, '#a .mdag-editor-name-input[data-for="node"]').count();
const detailsEditorCount = (page: Page): Promise<number> => visible(page, '#a .mdag-editor-details-editor').count();

test.describe('パネルを開く (段 21。B-044、B-129、B-130、B-132、6.3)', () => {
    test('@editor 帯、道具箱、T でタグ追加のパネル (data-panel="add") が 1 つ開き、キーと値の欄は空で、キーの欄にフォーカスがある (T の字は入らない)。帯と道具箱でタグ選択のパネル (data-panel="select") が 1 つ開く。ノード 1 つでも 2 つ以上でも同じ。Esc で閉じ、開いても原文は変わらない (B-044、B-129、B-132)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        await expectNoPanel(page, 'mount のあと');

        const routes = [
            ['帯', 'add'],
            ['道具箱', 'add'],
            ['T', 'add'],
            ['帯', 'select'],
            ['道具箱', 'select'],
        ] as const;
        for (const ids of [[TASK_A], [TASK_A, TASK_B]]) {
            for (const [route, kind] of routes) {
                const message = `${route} の${kind === 'add' ? 'タグ追加' : 'タグ選択'} (${ids.map((id) => REF_TEXTS[id]).join('、')})`;
                await selectNodes(page, ids, message);
                const command = kind === 'add' ? 'tag-add' : 'tag-select';
                if (route === '帯') await pressBar(page, command);
                else if (route === '道具箱') await toolButton(page, command).click();
                else await page.keyboard.press('t');
                await expectPanel(page, kind, message);
                if (kind === 'add') await expectFreshAdd(page, message);
                await expectSelection(page, targets(ids), message);
                await page.keyboard.press('Escape');
                await expectPanelClosed(page, message);
            }
        }
        await expectSourceStill(page, DOC, []);
        expect(errors).toEqual([]);
    });

    test('@editor 何も選んでいなければ、T、道具箱のタグ追加とタグ選択でパネルを開かず、選ぶよう案内 (info) を出す。原文は変わらない (B-044、B-130)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        await expectSelection(page, []);
        // キーはポインタが図の上にあるときに受ける
        await pointerOverBlank(page);
        await page.keyboard.press('t');
        await expectNoPanel(page, 'T');
        await expectNotice(page, 'info', 'T');

        for (const tool of ['tag-add', 'tag-select']) {
            await toolButton(page, tool).click();
            await expectNoPanel(page, tool);
            await expectNotice(page, 'info', tool);
        }
        await expectSourceStill(page, DOC, []);
    });

    test('@editor Esc で閉じたあと、フォーカスは図の要素に戻る。選んでいるノードが変わると (別のノードを押す)、開いていたパネルは閉じる (タグ追加もタグ選択も) (B-132、6.7)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');

        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await page.keyboard.press('Escape');
        await expectPanelClosed(page, 'Esc');
        await expect.poll(() => focusOf(page), 'Esc').toBe('#a');

        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        await expectPanel(page, 'add', 'タグ追加');
        await pressNode(page, DESIGN);
        await expectSelection(page, [target(DESIGN)], 'タグ追加のあとに Design を押す');
        await expectPanelClosed(page, 'タグ追加のあとに Design を押す');

        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select', 'タグ選択');
        await pressNode(page, BUILD);
        await expectSelection(page, [target(BUILD)], 'タグ選択のあとに Build を押す');
        await expectPanelClosed(page, 'タグ選択のあとに Build を押す');
        await expectSourceStill(page, DOC, []);
    });
});

test.describe('パネルの置き場と、開いている入力 (段 21。B-131、6.5、2.3 の配列の置き方、5.2 の軸 D)', () => {
    test('@editor タグのパネルは選んだノードの右に出て、右に入らなければ下に出る。2 つ以上なら選んだノードの全体の右。どれも図の領域に収まる (B-131)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        const area = await areaBox(page);
        const areaWidth = area.right - area.left;
        const areaHeight = area.bottom - area.top;

        // パネルの大きさを測る (大きさそのものは見ない。置く位置を決めるのに使う)
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await settle(page);
        const measured = (await panelOf(page)).rect;
        if (!measured) throw new Error('パネルの矩形がない');
        const width = measured.right - measured.left;
        await page.keyboard.press('Escape');
        await expectPanelClosed(page);

        // 右が空いている: 箱の左の辺を道具箱より右に置き、上下の中ほどに置く
        await moveNodesTo(page, [TASK_C], { left: 200, centerY: areaHeight / 2 });
        await selectNodes(page, [TASK_C], '右');
        await page.keyboard.press('t');
        await expectPanelPlaced(page, [TASK_C], 'right', '右');
        await page.keyboard.press('Escape');
        await expectPanelClosed(page, '右');

        // 右に入らない: 箱の右の辺を、図の領域の右の辺からパネルの幅の半分だけ内側に置く (下に置けば左右は収まる)
        await moveNodesTo(page, [TASK_C], { right: areaWidth - Math.max(width / 2, 30), centerY: areaHeight / 2 });
        await selectNodes(page, [TASK_C], '下');
        await page.keyboard.press('t');
        await expectPanelPlaced(page, [TASK_C], 'bottom', '下');
        await page.keyboard.press('Escape');
        await expectPanelClosed(page, '下');
        // 選択を解いて Task C の帯を消す (図を触って直したときに足した手順。全体表示が道具箱を避けて倍率が下がると、Task A を左へ寄せたときに
        // Task C の上の帯が Task A の名前を覆って押せない。確かめることと期待は変えていない)
        await page.keyboard.press('Escape');
        await expectSelection(page, [], '選択を解く');

        // 2 つ以上: 全体の右 (タグ選択のパネル)
        await moveNodesTo(page, [TASK_A, TASK_B], { left: 200, centerY: areaHeight / 2 });
        await selectNodes(page, [TASK_A, TASK_B], '全体の右');
        await pressBar(page, 'tag-select');
        await expectPanelPlaced(page, [TASK_A, TASK_B], 'right', '全体の右');
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 名前の入力を開いたまま道具箱の「タグ追加」を押すと、入れた名前で決めてからタグ追加のパネルが開く (名前の入力を開いている間は帯が見えない。触る G-026)。詳細の入力を開いたまま道具箱の「タグ選択」を押すと、入れた詳細を保存してからタグ選択のパネルが開く (B-131)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const renamed = docLines(A_LINE, B_LINE, '- Task Z');
        const detailed = docLines(A_LINE, B_LINE, ['- Task C', '    > メモ'].join('\n'));
        await expectEdit(page, DOC, { kind: 'renameNode', node: target(TASK_C), label: 'Task Z' }, renamed);
        await expectEdit(page, DOC, { kind: 'setDetails', node: target(TASK_C), text: 'メモ' }, detailed);

        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('Enter');
        await expect.poll(() => nameInputCount(page), '名前の入力').toBe(1);
        // 名前の入力は値の全部を選んで開くので、打つと置き換わる
        await page.keyboard.type('Task Z');
        await expectSourceStill(page, DOC, [], '名前の入力の途中');
        // 名前の入力を開いている間は帯を隠すので、前の帯の「タグ追加」の代わりに道具箱の「タグ追加」で開く (働きは同じ)
        await expect.poll(() => visible(page, '#a .mdag-editor-bar').count(), '名前の入力を開いている間の帯').toBe(0);
        await toolButton(page, 'tag-add').click();
        await expectSource(page, renamed, [renamed], '名前');
        await expect.poll(() => nameInputCount(page), '名前').toBe(0);
        await expectPanel(page, 'add', '名前');
        await expectSelection(page, [target(TASK_C, 'Task Z')], '名前');

        await remount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('d');
        await expect.poll(() => detailsEditorCount(page), '詳細の入力').toBe(1);
        await page.keyboard.type('メモ');
        await expectSourceStill(page, DOC, [], '詳細の入力の途中');
        // 詳細の入力は帯に重なることがあるので、道具箱のボタンで開く
        await toolButton(page, 'tag-select').click();
        await expectSource(page, detailed, [detailed], '詳細');
        await expect.poll(() => detailsEditorCount(page), '詳細').toBe(0);
        await expectPanel(page, 'select', '詳細');
    });
});

test.describe('タグ追加 (段 21。B-133〜B-136、B-140、B-141、B-003、B-004、3.5)', () => {
    test('@editor キーと値を入れて Enter で付ける (同じキーはその位置で値を置き換える)。値がなければ #キーだけ、空白のある値は "…" で囲み、「追加」でも付く。毎回 onChange 1 回、パネルは開いたままキーと値の欄が空に戻ってキーの欄にフォーカスがあり、ノードは選んだまま、結果の通知 (info)。元に戻すで 1 つずつ戻る (B-133、B-136、B-140、B-141)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_A], 'owner', 'bob'), A_OWNER_BOB);
        await expectEdit(page, A_OWNER_BOB, setTagOp([TASK_A], 'urgent', null), A_URGENT);
        await expectEdit(page, A_URGENT, setTagOp([TASK_A], 'note', 'a b'), A_NOTE);

        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);

        // 値の欄で Enter
        await fillTag(page, 'owner', 'bob');
        await expectSourceStill(page, DOC, [], 'Enter の前');
        await page.keyboard.press('Enter');
        await expectSource(page, A_OWNER_BOB, [A_OWNER_BOB], 'owner:bob');
        await expectFreshAdd(page, 'owner:bob');
        await expectSelection(page, [target(TASK_A)], 'owner:bob');
        await expectNotice(page, 'info', 'owner:bob');
        expect(await tagsOf(page, TASK_A), 'owner:bob').toEqual([
            { key: 'team', values: ['core'] },
            { key: 'prio', values: ['high'] },
            { key: 'owner', values: ['bob'] },
        ]);

        // 値のないタグ (キーの欄で Enter)
        await page.keyboard.type('urgent');
        await expect.poll(async () => (await panelOf(page)).fields[KEY_FIELD], 'urgent').toBe('urgent');
        await page.keyboard.press('Enter');
        await expectSource(page, A_URGENT, [A_OWNER_BOB, A_URGENT], 'urgent');
        await expectFreshAdd(page, 'urgent');
        expect((await tagsOf(page, TASK_A)).at(-1), 'urgent').toEqual({ key: 'urgent', values: [] });

        // 空白のある値を「追加」で付ける
        await fillTag(page, 'note', 'a b');
        await pressInPanel(page, { on: 'button', name: '追加' });
        await expectSource(page, A_NOTE, [A_OWNER_BOB, A_URGENT, A_NOTE], 'note');
        await expectFreshAdd(page, 'note');
        await expectSelection(page, [target(TASK_A)], 'note');
        expect((await tagsOf(page, TASK_A)).at(-1), 'note').toEqual({ key: 'note', values: ['a b'] });

        await page.keyboard.press('Escape');
        await expectPanelClosed(page);
        for (const [expected, name] of [
            [A_URGENT, 'note を戻す'],
            [A_OWNER_BOB, 'urgent を戻す'],
            [DOC, 'owner を戻す'],
        ] as const) {
            expect(await callUndo(page), name).toBe(true);
            await expect.poll(() => getSource(page), name).toBe(expected);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 2 つ以上を選んで付けると、選んだノードの全部に 1 回の書き換えで付き (onChange 1 回)、選んだノードはそのまま。1 回の元に戻すで戻る (B-135、3.3)', async ({ page }) => {
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_A, TASK_B], 'note', 'a b'), AB_NOTE);
        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A, TASK_B]);
        await pressBar(page, 'tag-add');
        await expectFreshAdd(page);
        await fillTag(page, 'note', 'a b');
        await page.keyboard.press('Enter');
        await expectSource(page, AB_NOTE, [AB_NOTE]);
        await expectSelection(page, [target(TASK_A), target(TASK_B)]);
        expect((await tagsOf(page, TASK_A)).at(-1)).toEqual({ key: 'note', values: ['a b'] });
        expect((await tagsOf(page, TASK_B)).at(-1)).toEqual({ key: 'note', values: ['a b'] });
        await expectPanel(page, 'add');

        await page.keyboard.press('Escape');
        await expectPanelClosed(page);
        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC, [AB_NOTE, DOC], '元に戻す');
    });

    test('@editor 空白を含むキーも断らずに " で囲んで付け (#"a b")、原文が書き換わって通知 (info) を出し、履歴に積む。キーの先頭の # は外して付ける (B-134、D-075)', async ({ page }) => {
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_C], 'a b', null), C_QUOTED_KEY);
        await expectEdit(page, DOC, setTagOp([TASK_C], '#prio', 'low'), C_PRIO);

        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await fillField(page, KEY_FIELD, 'a b');
        await page.keyboard.press('Enter');
        await expectSource(page, C_QUOTED_KEY, [C_QUOTED_KEY]);
        await expectNotice(page, 'info');
        expect(await tagsOf(page, TASK_C)).toEqual([{ key: 'a b', values: [] }]);
        await expect(toolButton(page, 'undo')).toBeEnabled();

        await remount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await fillTag(page, '#prio', 'low');
        await page.keyboard.press('Enter');
        await expectSource(page, C_PRIO, [C_PRIO]);
        expect(await tagsOf(page, TASK_C)).toEqual([{ key: 'prio', values: ['low'] }]);
    });

    test('@editor キーの欄の候補は、文書で使っているキーと markdag.tags.keys のキー (キーの欄の datalist) (B-133、10.2 の B-133)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await expect.poll(() => keyCandidates(page)).toEqual(['owner', 'prio', 'status', 'team']);
        await expectSourceStill(page, DOC, []);
    });
});

test.describe('付いているタグ (段 21。B-137〜B-139)', () => {
    test('@editor タグ追加のパネルに選んだノードの付いているタグが並ぶ。押すとそのタグの編集 (キーと値が入り、送るボタンは「更新」) になり、値を変えて「更新」するとその位置で置き換わる。キーを変えて Enter すると、もとのキーのタグが外れて新しいキーになる。「新規に戻る」で空の新規の入力に戻り、付けると末尾に足す。× でそのタグを外す (B-137〜B-139)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_A], 'prio', 'low'), A_EDIT_PRIO);
        await expectEdit(page, A_EDIT_PRIO, setTagOp([TASK_A], 'lead', 'alice', 'owner'), A_EDIT_KEY);
        await expectEdit(page, A_EDIT_KEY, setTagOp([TASK_A], 'urgent', null), A_EDIT_NEW);
        await expectEdit(page, A_EDIT_NEW, removeTagOp([TASK_A], 'prio'), A_EDIT_REMOVED);

        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await expect.poll(() => attachedKeys(page), '並び').toEqual(['owner', 'prio', 'team']);

        // prio を押して値を変え、「更新」
        await pressInPanel(page, { on: 'row', key: 'prio' });
        await expectAdd(page, 'prio', 'high', 'edit', 'prio の編集');
        expect(startsWith((await panelOf(page)).buttons, '新規に戻る'), 'prio の編集').toBe(true);
        await expectSourceStill(page, DOC, [], 'prio の編集を開いただけ');
        await fillField(page, VALUE_FIELD, 'low');
        await pressInPanel(page, { on: 'button', name: '更新' });
        await expectSource(page, A_EDIT_PRIO, [A_EDIT_PRIO], 'prio を更新');
        await expectPanel(page, 'add', 'prio を更新');

        // owner を押してキーを lead に変え、Enter
        await pressInPanel(page, { on: 'row', key: 'owner' });
        await expectAdd(page, 'owner', 'alice', 'edit', 'owner の編集');
        await fillField(page, KEY_FIELD, 'lead');
        await page.keyboard.press('Enter');
        await expectSource(page, A_EDIT_KEY, [A_EDIT_PRIO, A_EDIT_KEY], 'キーを変える');
        await expect.poll(() => attachedKeys(page), 'キーを変える').toEqual(['lead', 'prio', 'team']);

        // team を押してから新規に戻り、urgent を付ける
        await pressInPanel(page, { on: 'row', key: 'team' });
        await expectAdd(page, 'team', 'core', 'edit', 'team の編集');
        await pressInPanel(page, { on: 'button', name: '新規に戻る' });
        await expectAdd(page, '', '', 'new', '新規に戻る');
        await fillField(page, KEY_FIELD, 'urgent');
        await page.keyboard.press('Enter');
        await expectSource(page, A_EDIT_NEW, [A_EDIT_PRIO, A_EDIT_KEY, A_EDIT_NEW], '新規に戻って付ける');

        // prio の × で外す
        await pressInPanel(page, { on: 'row', key: 'prio', part: 'remove' });
        await expectSource(page, A_EDIT_REMOVED, [A_EDIT_PRIO, A_EDIT_KEY, A_EDIT_NEW, A_EDIT_REMOVED], '× で外す');
        await expect.poll(() => attachedKeys(page), '× で外す').toEqual(['lead', 'team', 'urgent']);
        await expectPanel(page, 'add', '× で外す');
        await expectSelection(page, [target(TASK_A)], '× で外す');
        expect(await tagsOf(page, TASK_A)).toEqual([
            { key: 'team', values: ['core'] },
            { key: 'lead', values: ['alice'] },
            { key: 'urgent', values: [] },
        ]);

        await page.keyboard.press('Escape');
        await expectPanelClosed(page);
        expect(await callUndo(page)).toBe(true);
        await expect.poll(() => getSource(page), '元に戻す').toBe(A_EDIT_NEW);
    });

    test('@editor 2 つ以上を選ぶと、どれかに付いているタグが並び、× でそのキーのタグを選んだノードの全部から 1 回の書き換えで外す (B-137、B-139)', async ({ page }) => {
        await open(page);
        await expectEdit(page, DOC, removeTagOp([TASK_A, TASK_B], 'team'), AB_TEAM_REMOVED);
        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A, TASK_B]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await expect.poll(() => attachedKeys(page)).toEqual(['owner', 'prio', 'team']);

        await pressInPanel(page, { on: 'row', key: 'team', which: 'first', part: 'remove' });
        await expectSource(page, AB_TEAM_REMOVED, [AB_TEAM_REMOVED]);
        await expect.poll(() => attachedKeys(page)).toEqual(['owner', 'prio']);
        await expectSelection(page, [target(TASK_A), target(TASK_B)]);
        expect(await tagsOf(page, LEAF)).toEqual([
            { key: 'team', values: ['core'] },
            { key: 'owner', values: ['alice'] },
            { key: 'prio', values: ['low'] },
        ]);
    });
});

test.describe('変換中のキー (段 21。B-15、5.2 の軸 D)', () => {
    test('@editor 変換中 (isComposing か keyCode 229) の Enter と Esc はタグのパネルの操作にならない: 付けず、閉じない。確定のあとに keyCode 229 で届く Enter も無視し、確定したあとの Enter で付ける', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '変換は Chromium の CDP (Input.imeSetComposition) で起こす');
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_C], 'owner', 'アリス'), C_KANA);
        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await fillTag(page, 'owner', '');
        await pressInPanel(page, { on: 'field', index: VALUE_FIELD });
        await expect.poll(async () => (await panelOf(page)).focused).toBe(VALUE_FIELD);

        const client = await page.context().newCDPSession(page);
        try {
            // 空の値の欄に変換中の文字を入れる (compositionstart が届く)
            await client.send('Input.imeSetComposition', { text: 'ありす', selectionStart: 3, selectionEnd: 3 });
            await expect.poll(async () => (await panelOf(page)).fields[VALUE_FIELD]).toBe('ありす');
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, DOC, [], '変換中');
            await expectAdd(page, 'owner', 'ありす', 'new', '変換中');

            // 変換を確定する (compositionend が届く)
            await client.send('Input.insertText', { text: 'アリス' });
            await expect.poll(async () => (await panelOf(page)).fields[VALUE_FIELD]).toBe('アリス');
            // 変換を確定したキーが確定のあとに keyCode 229 で届く形 (isComposing false) も無視する
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, DOC, [], '確定のあとの keyCode 229');
            await expectAdd(page, 'owner', 'アリス', 'new', '確定のあとの keyCode 229');
        } finally {
            await client.detach();
        }

        await page.keyboard.press('Enter');
        await expectSource(page, C_KANA, [C_KANA]);
        await expectPanel(page, 'add');
    });
});

test.describe('タグ選択 (段 21。B-142〜B-147、3.5 の toggleTag)', () => {
    test('@editor タグ選択のパネルに登録されているタグ (文書で使われているタグと markdag.tags.keys のキー) がキー、値の順に並び、選んだノードの全部に付いていれば data-state="all"、一部なら "some"、どれにもなければ "none" (B-143、B-144)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');

        await selectNodes(page, [TASK_A, TASK_B]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select');
        await expect.poll(() => rowsOf(page), 'Task A と Task B').toEqual(
            statedRows([
                row('owner', 'alice', 'some'),
                row('owner', 'bob', 'some'),
                row('prio', 'high', 'some'),
                row('prio', 'low', 'none'),
                row('status', null, 'none'),
                row('team', 'core', 'all'),
            ]),
        );
        await page.keyboard.press('Escape');
        await expectPanelClosed(page);

        await selectNodes(page, [LEAF]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select', 'Leaf');
        await expect.poll(() => rowsOf(page), 'Leaf').toEqual(
            statedRows(REGISTERED.map(({ key, value }) => row(key, value, ['owner:alice', 'prio:low', 'team:core'].includes(`${key}:${value}`) ? 'all' : 'none'))),
        );
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 行を押すたびに付け外しする: 一部にだけ付いていれば全部に付け、全部に付いていれば外す (値がほかにもあればその値だけ)。押すたびに onChange 1 回で、パネルは開いたまま、行の data-state が変わり、続けて別の行も押せる。元に戻すで 1 つずつ戻る (B-144、B-145、B-146)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await expectEdit(page, DOC, toggleTagOp([TASK_A, TASK_B], 'owner', 'alice'), AB_TOGGLE_1);
        await expectEdit(page, AB_TOGGLE_1, toggleTagOp([TASK_A, TASK_B], 'owner', 'alice'), AB_TOGGLE_2);
        await expectEdit(page, AB_TOGGLE_2, toggleTagOp([TASK_A, TASK_B], 'team', 'core'), AB_TOGGLE_3);
        await expectEdit(page, AB_TOGGLE_3, toggleTagOp([TASK_A, TASK_B], 'team', 'core'), AB_TOGGLE_4);

        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A, TASK_B]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select');
        // 登録されているタグの行は後ろの 6 つ (前に最近使ったタグが入ることがある。外したタグも Leaf に残るので行は減らない)
        const registeredStates = async (): Promise<PanelRow[]> => (await rowsOf(page)).slice(-REGISTERED.length);
        type State = StatedRow['state'];
        const states = (ownerAlice: State, ownerBob: State, prioHigh: State, team: State): PanelRow[] =>
            statedRows([row('owner', 'alice', ownerAlice), row('owner', 'bob', ownerBob), row('prio', 'high', prioHigh), row('prio', 'low', 'none'), row('status', null, 'none'), row('team', 'core', team)]);

        const steps = [
            { press: { key: 'owner', value: 'alice' }, source: AB_TOGGLE_1, rows: states('all', 'some', 'some', 'all'), name: 'owner:alice (一部) を押す' },
            { press: { key: 'owner', value: 'alice' }, source: AB_TOGGLE_2, rows: states('none', 'some', 'some', 'all'), name: 'owner:alice (全部) を押す' },
            { press: { key: 'team', value: 'core' }, source: AB_TOGGLE_3, rows: states('none', 'some', 'some', 'none'), name: 'team:core (全部) を押す' },
            { press: { key: 'team', value: 'core' }, source: AB_TOGGLE_4, rows: states('none', 'some', 'some', 'all'), name: 'team:core (どれにもない) を押す' },
        ];
        const seen: string[] = [];
        for (const step of steps) {
            await pressInPanel(page, { on: 'row', ...step.press });
            seen.push(step.source);
            await expectSource(page, step.source, seen, step.name);
            await expectPanel(page, 'select', step.name);
            await expect.poll(registeredStates, step.name).toEqual(step.rows);
            await expectSelection(page, [target(TASK_A), target(TASK_B)], step.name);
        }

        await page.keyboard.press('Escape');
        await expectPanelClosed(page);
        expect(await callUndo(page)).toBe(true);
        await expect.poll(() => getSource(page), '元に戻す').toBe(AB_TOGGLE_3);
    });

    test('@editor 同じキーに別の値があるとき、複数の値を持てないキー (markdag.tags.keys の定義に multiple がない) は置き換え、定義のないキーは値を足す。値がほかにもあるタグを外すと、その値だけ外れる (B-145、B-146)', async ({ page }) => {
        await open(page);
        await expectEdit(page, DOC_KEYS, toggleTagOp([TASK_A], 'prio', 'low'), KEYS_1);
        await expectEdit(page, KEYS_1, toggleTagOp([TASK_A], 'owner', 'bob'), KEYS_2);
        await expectEdit(page, KEYS_2, toggleTagOp([TASK_B], 'owner', 'bob'), KEYS_3);

        await mount(page, DOC_KEYS);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select');
        await pressInPanel(page, { on: 'row', key: 'prio', value: 'low' });
        await expectSource(page, KEYS_1, [KEYS_1], 'prio は置き換える');
        expect(await tagsOf(page, TASK_A), 'prio は置き換える').toEqual([
            { key: 'prio', values: ['low'] },
            { key: 'owner', values: ['alice'] },
        ]);
        await pressInPanel(page, { on: 'row', key: 'owner', value: 'bob' });
        await expectSource(page, KEYS_2, [KEYS_1, KEYS_2], 'owner は値を足す');
        expect(await tagsOf(page, TASK_A), 'owner は値を足す').toEqual([
            { key: 'prio', values: ['low'] },
            { key: 'owner', values: ['alice', 'bob'] },
        ]);
        await page.keyboard.press('Escape');
        await expectPanelClosed(page);

        await selectNodes(page, [TASK_B]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select', 'Task B');
        await expect.poll(async () => (await rowsOf(page)).filter((item) => item.key === 'owner' && item.value === 'bob').map((item) => item.state), 'Task B').toContain('all');
        await pressInPanel(page, { on: 'row', key: 'owner', value: 'bob' });
        await expectSource(page, KEYS_3, [KEYS_1, KEYS_2, KEYS_3], 'Task B の bob だけを外す');
        expect(await tagsOf(page, TASK_B), 'Task B の bob だけを外す').toEqual([
            { key: 'prio', values: ['low'] },
            { key: 'owner', values: ['carol'] },
        ]);
    });

    test('@editor 上に最近使ったタグ (付けたタグ。新しい順に 3 つまで) が並び、その下に登録されているタグが並ぶ。絞り込みの欄に入れた文字を含むタグだけが出て (最近使ったタグにも効く)、消すと戻る。最近使ったタグは mount の間だけ覚える (B-142、B-147、10.2 の B-142)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        await expectEdit(page, DOC, setTagOp([TASK_C], 'urgent', null), C_RECENT_1);
        await expectEdit(page, C_RECENT_1, setTagOp([TASK_C], 'owner', 'carol'), C_RECENT_2);
        await expectEdit(page, C_RECENT_2, toggleTagOp([TASK_C], 'prio', 'high'), C_RECENT_3);
        await expectEdit(page, C_RECENT_3, toggleTagOp([TASK_C], 'team', 'core'), C_RECENT_4);

        await mount(page, DOC);
        await useTool(page, 'select');
        // タグ追加で urgent と owner:carol を付ける
        await selectNodes(page, [TASK_C]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await fillField(page, KEY_FIELD, 'urgent');
        await page.keyboard.press('Enter');
        await expectSource(page, C_RECENT_1, [C_RECENT_1], 'urgent');
        await fillTag(page, 'owner', 'carol');
        await page.keyboard.press('Enter');
        await expectSource(page, C_RECENT_2, [C_RECENT_1, C_RECENT_2], 'owner:carol');
        await page.keyboard.press('Escape');
        await expectPanelClosed(page);

        // 登録されているタグ (Task C に付けたものも入る。キー、値の順)
        const withC: Row[] = [
            { key: 'owner', value: 'alice' },
            { key: 'owner', value: 'bob' },
            { key: 'owner', value: 'carol' },
            { key: 'prio', value: 'high' },
            { key: 'prio', value: 'low' },
            { key: 'status', value: null },
            { key: 'team', value: 'core' },
            { key: 'urgent', value: null },
        ];
        const registered = (states: Record<string, StatedRow['state']>): StatedRow[] => withC.map(({ key, value }) => row(key, value, states[`${key}:${value}`] ?? 'none'));

        await selectNodes(page, [TASK_C]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select');
        const afterAdd = { 'owner:carol': 'all', 'urgent:null': 'all' } as const;
        await expect.poll(() => rowsOf(page), '最近使ったタグが 2 つ').toEqual(statedRows([row('owner', 'carol', 'all'), row('urgent', null, 'all'), ...registered(afterAdd)]));

        // タグ選択で付けたものも最近使ったタグに入る (新しい順)
        await pressInPanel(page, { on: 'row', key: 'prio', value: 'high' });
        await expectSource(page, C_RECENT_3, [C_RECENT_1, C_RECENT_2, C_RECENT_3], 'prio:high');
        const afterPrio = { ...afterAdd, 'prio:high': 'all' } as const;
        await expect.poll(() => rowsOf(page), 'prio:high').toEqual(statedRows([row('prio', 'high', 'all'), row('owner', 'carol', 'all'), row('urgent', null, 'all'), ...registered(afterPrio)]));

        // 4 つ目を付けると、一番古いもの (urgent) が落ちる
        await pressInPanel(page, { on: 'row', key: 'team', value: 'core' });
        await expectSource(page, C_RECENT_4, [C_RECENT_1, C_RECENT_2, C_RECENT_3, C_RECENT_4], 'team:core');
        const afterTeam = { ...afterPrio, 'team:core': 'all' } as const;
        const full = statedRows([row('team', 'core', 'all'), row('prio', 'high', 'all'), row('owner', 'carol', 'all'), ...registered(afterTeam)]);
        await expect.poll(() => rowsOf(page), 'team:core').toEqual(full);

        // 絞り込み: 値の一部 (最近使ったタグには当たらない)、キーの一部 (最近使ったタグにも当たる)、消す
        await fillFilter(page, 'ali');
        await expect.poll(() => rowsOf(page), '絞り込み ali').toEqual(statedRows([row('owner', 'alice', 'none')]));
        await fillFilter(page, 'pri');
        await expect.poll(() => rowsOf(page), '絞り込み pri').toEqual(statedRows([row('prio', 'high', 'all'), row('prio', 'high', 'all'), row('prio', 'low', 'none')]));
        await fillFilter(page, '');
        await expect.poll(() => rowsOf(page), '絞り込みを消す').toEqual(full);
        await expectSource(page, C_RECENT_4, [C_RECENT_1, C_RECENT_2, C_RECENT_3, C_RECENT_4], '絞り込みでは原文は変わらない');

        // mount し直すと最近使ったタグはない
        await remount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_C]);
        await pressBar(page, 'tag-select');
        await expectPanel(page, 'select', 'mount し直す');
        await expect.poll(() => rowsOf(page), 'mount し直す').toEqual(statedRows(REGISTERED.map(({ key, value }) => row(key, value, 'none'))));
    });
});

test.describe('タグのクリック (段 21。B-053、B-054、B-26、10.2 の B-053、5.2 の軸 D の同じタグの 2 回目)', () => {
    test('@editor 選択の道具でノードの中のタグを押すと、そのノードを選んで押したタグの編集 (タグ追加のパネル。キーと値が入り「更新」) を開く。同じタグをもう 1 度押しても編集のまま、別のタグを押すとそのタグの編集、ダブルクリックでも同じで名前の入力は開かない。別のノードのタグはそのノードを選んで編集する。Shift +クリックは選択に足すだけ。原文は変わらない (B-053、B-26)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        await makeRoomOnRight(page);
        await expectSelection(page, []);

        await press(page, await spot(page, { on: 'element', selector: tagSelector(TASK_A, 'prio') }));
        await expectSelection(page, [target(TASK_A)], 'prio を押す');
        await expectAdd(page, 'prio', 'high', 'edit', 'prio を押す');

        // 同じタグの 2 回目は編集のまま (閉じない)
        await press(page, await spot(page, { on: 'element', selector: tagSelector(TASK_A, 'prio') }));
        await settle(page);
        await expectAdd(page, 'prio', 'high', 'edit', 'prio をもう 1 度押す');

        // 同じノードの別のタグ
        await press(page, await spot(page, { on: 'element', selector: tagSelector(TASK_A, 'owner') }));
        await expectAdd(page, 'owner', 'alice', 'edit', 'owner を押す');

        // ダブルクリック
        await doubleClick(page, await spot(page, { on: 'element', selector: tagSelector(TASK_A, 'team') }));
        await settle(page);
        await expectAdd(page, 'team', 'core', 'edit', 'team をダブルクリック');
        expect(await nameInputCount(page), 'team をダブルクリック').toBe(0);
        await expectSelection(page, [target(TASK_A)], 'team をダブルクリック');

        // 別のノードのタグ
        await press(page, await spot(page, { on: 'element', selector: tagSelector(TASK_B, 'owner') }));
        await expectSelection(page, [target(TASK_B)], 'Task B の owner を押す');
        await expectAdd(page, 'owner', 'bob', 'edit', 'Task B の owner を押す');

        // Shift +クリックは選択に足すだけ (選択が変わるのでパネルは閉じ、タグの編集は開かない)
        await pressWith(page, await spot(page, { on: 'element', selector: tagSelector(LEAF, 'prio') }), 'Shift');
        await expectSelection(page, [target(TASK_B), target(LEAF)], 'Shift +クリック');
        await expectNoPanel(page, 'Shift +クリック');

        await expectSourceStill(page, DOC, []);
        expect(errors).toEqual([]);
    });

    test('@editor 手のひらの道具でノードの中のタグを押すと、そのノードを選ぶだけでパネルは開かない (10.2 の B-053)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await useTool(page, 'hand');
        await press(page, await spot(page, { on: 'element', selector: tagSelector(TASK_A, 'prio') }));
        await expectSelection(page, [target(TASK_A)]);
        await expectNoPanel(page);
        await expectSourceStill(page, DOC, []);
    });

    test('@editor 吹き出しの中のタグを選択の道具で押すと、その吹き出しのノードを選んで押したタグの編集を開く。手のひらではノードを選ぶだけ。原文は変わらない (B-054、10.2 の B-053)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        let first = true;
        for (const tool of ['select', 'hand'] as const) {
            if (first) await mount(page, DOC_POPOVER);
            else await remount(page, DOC_POPOVER);
            first = false;
            await useTool(page, tool);
            // タグは吹き出しに出る (markdag.tags.display: click)。印の click で吹き出しを出したままにする
            await page.locator(`${nodeSelector(TASK_A)} .mdag-note-mark`).dispatchEvent('click');
            await expect(page.locator('#a .mdag-popover'), tool).toHaveAttribute('data-id', String(TASK_A));
            await expectSelection(page, [], tool);

            await press(page, await spot(page, { on: 'element', selector: popoverTagSelector('owner') }));
            await expectSelection(page, [target(TASK_A)], tool);
            if (tool === 'select') await expectAdd(page, 'owner', 'alice', 'edit', tool);
            else await expectNoPanel(page, tool);
            await expectSourceStill(page, DOC_POPOVER, [], tool);
        }
    });
});

test.describe('markdag キーのない文書 (段 21。B-125、4.3、context 7-16)', () => {
    test('@editor markdag キーのない文書 (frontmatter はある、frontmatter もない) でタグを付けると、markdag: (と frontmatter) を足してタグを書き、モデルにタグが入る。結果の通知に markdag: を足したことを添える。元に戻すで戻る (B-125)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const cases = [
            { name: 'markdag キーのない frontmatter', doc: DOC_NO_MARKDAG, expected: DOC_NO_MARKDAG_TAGGED },
            { name: 'frontmatter のない文書', doc: DOC_NO_FRONTMATTER, expected: DOC_NO_FRONTMATTER_TAGGED },
        ];
        let first = true;
        for (const item of cases) {
            const outcome = await tryEdit(page, item.doc, { kind: 'setTag', nodes: [{ id: 2, refText: 'a' }], key: 'owner', value: 'alice', replaceKey: null });
            expect(editedSource(outcome), item.name).toBe(item.expected);
            const note = outcome.status === 'edited' ? outcome.notes.find((entry) => entry.code === 'markdag-added') : undefined;
            expect(note, item.name).toBeDefined();

            // markdag.editor がない文書は閲覧だけなので、mount の mode で GUI 編集にする
            if (first) await mount(page, item.doc, { mode: 'edit' });
            else await remount(page, item.doc, { mode: 'edit' });
            first = false;
            expect(await getMode(page), item.name).toBe('edit');
            expect(await tagsOf(page, 2), item.name).toEqual([]);

            await pressNode(page, 2);
            await expectSelection(page, [{ id: 2, refText: 'a' }], item.name);
            await page.keyboard.press('t');
            await expectFreshAdd(page, item.name);
            await fillTag(page, 'owner', 'alice');
            await page.keyboard.press('Enter');
            await expectSource(page, item.expected, [item.expected], item.name);
            expect(await tagsOf(page, 2), item.name).toEqual([{ key: 'owner', values: ['alice'] }]);
            const text = await expectNotice(page, 'info', item.name);
            expect(text, item.name).toContain(note?.message ?? '\u0000');

            await page.keyboard.press('Escape');
            await expectPanelClosed(page, item.name);
            expect(await callUndo(page), item.name).toBe(true);
            await expectSource(page, item.doc, [item.expected, item.doc], `${item.name} の元に戻す`);
        }
    });
});

test.describe('印を書けない見出し (段 21。B-05、3.5 の marker-line、3.8 の canMark)', () => {
    test('@editor 下線の見出しを 1 つ選ぶと帯のタグ追加とタグ選択が押せ、T でタグ追加のパネルが開く。下線の見出しを含めて 2 つ選んでタグを付けると、見出しを同じ段の ATX の見出しに書き直してタグを書き、通知 (info) が出て履歴に積む (B-05、D-049)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await expectEdit(page, DOC_SETEXT, setTagOp([DESIGN, 3], 'owner', 'alice'), DOC_SETEXT_TAGGED);

        await mount(page, DOC_SETEXT);
        await useTool(page, 'select');
        // 空振りの防ぎ: Design は下線の見出しで、印を書く前に ATX の見出しに書き直すので印を書ける
        expect(await factsOf(page, DESIGN)).toEqual({ kind: 'heading', canMark: true });

        await selectNodes(page, [DESIGN]);
        await expect(visible(page, '#a .mdag-editor-bar-button[data-command="tag-add"]'), '帯のタグ追加').toBeEnabled();
        await expect(visible(page, '#a .mdag-editor-bar-button[data-command="tag-select"]'), '帯のタグ選択').toBeEnabled();
        await page.keyboard.press('t');
        await expectFreshAdd(page, 'T');
        await expectSourceStill(page, DOC_SETEXT, [], 'T');
        await page.keyboard.press('Escape');
        await expectPanelClosed(page, 'T の Esc');

        // 下線の見出しの Task A も id 3 で refText は Task A
        await selectNodes(page, [3, DESIGN]);
        await pressBar(page, 'tag-add');
        await expectFreshAdd(page, '2 つ');
        await fillTag(page, 'owner', 'alice');
        await page.keyboard.press('Enter');
        await expectSource(page, DOC_SETEXT_TAGGED, [DOC_SETEXT_TAGGED], '2 つ');
        await expectNotice(page, 'info', '2 つ');
        expect(await tagsOf(page, DESIGN)).toEqual([{ key: 'owner', values: ['alice'] }]);
        expect(await tagsOf(page, 3)).toEqual([{ key: 'owner', values: ['alice'] }]);
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('閲覧と外からの差し替え (段 21。B-169、B-171、5.2 の軸 D、5.3)', () => {
    test('@editor タグのパネルを開いたまま閲覧へ切り替えると (setMode) パネルは閉じ、GUI 編集に戻しても閉じたまま。原文は変わらない (B-171、5.2 の軸 D の「閲覧へ」)', async ({ page }) => {
        await open(page);
        const doc = docLines(A_LINE, B_LINE, C_LINE, SWITCH_EDIT);
        await mount(page, doc);
        expect(await getMode(page)).toBe('edit');
        await useTool(page, 'select');
        for (const [command, kind] of [
            ['tag-add', 'add'],
            ['tag-select', 'select'],
        ] as const) {
            await selectNodes(page, [TASK_A], kind);
            await pressBar(page, command);
            await expectPanel(page, kind, kind);
            expect(await setMode(page, 'view'), kind).toBe(true);
            await expectPanelClosed(page, `${kind} から閲覧へ`);
            expect(await setMode(page, 'edit'), kind).toBe(true);
            await expectNoPanel(page, `${kind} から GUI 編集に戻す`);
            await useTool(page, 'select');
        }
        await expectSourceStill(page, doc, []);
    });

    test('@editor 閲覧では、T とタグのクリックでパネルが開かず、原文も変わらない (閲覧だけの文書) (B-169)', async ({ page }) => {
        await open(page);
        const doc = docLines(A_LINE, B_LINE, C_LINE, VIEW);
        await mount(page, doc);
        expect(await getMode(page)).toBe('view');
        await pressNode(page, TASK_A);
        await page.keyboard.press('t');
        await expectNoPanel(page, 'T');
        // 閲覧ではタグは 1 つずつの要素に分かれない。タグの行を押す
        await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(TASK_A)} .mdag-tags` }));
        await expectNoPanel(page, 'タグのクリック');
        await expectSourceStill(page, doc, []);
    });

    test('@editor タグのパネルを開いているときに setSource で原文を差し替えると、パネルは閉じ、入れかけのタグは付かない (5.3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useTool(page, 'select');
        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        await expectFreshAdd(page);
        await fillTag(page, 'owner', 'zed');

        await setSource(page, DOC_OTHER);
        await expectPanelClosed(page);
        await expectSourceStill(page, DOC_OTHER, []);
        expect(await getSource(page)).not.toContain('zed');
    });
});

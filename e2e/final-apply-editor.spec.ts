// 最後の関門で決まった編集の層の直し (records/final-apply/plan.md の 2、4、9 のタグのパネルの行、10 の見出しの詳細の入口、
// scope.md の「最後の関門 GUI の通知の書き方」) を、ビルドした配布物の markdag/editor で、直す前に落ちるテストとして書く。
// 1. AM-07 (plan.md の 2、細部 4): 2 つ以上を選んでいるとき、タグのパネルを開く (T、道具箱のタグ選択) こととタグの操作 (追加、更新、×、付け外し) で
//    図を動かさない (表示位置 getTransform と開閉 getFolded が操作の前と同じ)。手順は records/final-gate/am07 と同じ
//    (縦に長い文書、拡大、項目 1 を選ぶ、パンして項目 24 を Shift+クリック)。1 つだけのときは今と同じく見える所へ動かす (守り)
// 2. AM-09 (plan.md の 4、細部 5): GUI 編集の閲覧のモードで図がキーを受けているとき、修飾キーなしか Shift だけの Backspace と Delete の
//    既定の動きを止め、何もしない。止めないキーで前のページへ戻るのは webkit だけなので、window の受け口で keydown の defaultPrevented を
//    記録して、どのブラウザでも確かめる (window の泡立ちは編集の層の受け口 (document) のあとなので、記録するのは編集の層が決めたもの。
//    記録のあと、文字を打つ要素の外の Backspace は受け口が止める。直す前に webkit でページが移ってテストが崩れないように)。
//    止めないもの (守り): Alt / ⌘ / Ctrl つき、変換中のキー、図の外の入力欄、図がキーを受けていないとき、閲覧のほかのキー、render だけの図。
//    GUI 編集のモードで何も選んでいないときの Backspace (合わせる先) は今のまま止めて何もしない (守り)
// 3. 見出しの詳細の入口 (plan.md の 10): 見出しを選ぶと D と帯の詳細編集で詳細の入力が開き、保存すると見出しのすぐ下に > で書き、
//    図の見出しに詳細の印が出る (守り。書き換えの層を直した前のタスクで通るようになった)
// 4. タグのパネルの行の文字 (plan.md の 9 の編集の層): キーと値の囲みと逃がしを、解析と formatTag の規則に合わせる
// 5. 通知の書き方: 本文が 2 行の下線の見出しで T を押したときの理由は書きすぎない
// 期待の原文は規則から書き、配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)。
// 反映は expect.poll で待ち、「変わらない」「開かない」「動かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, MarkdagDiagram, NodeTarget, ViewTransform } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

interface KeySeen {
    key: string;
    // 押していた修飾キー (Shift、Alt、Meta、Control の順に + でつなぐ。なければ空)
    modifiers: string;
    // window の受け口に届いたときの defaultPrevented (編集の層が既定の動きを止めたか)
    prevented: boolean;
    // フォーカスが図の要素 (#a) の中にあった
    inDiagram: boolean;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // render だけで描いた図
    diagrams: Record<string, MarkdagDiagram>;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
    // watchKeys が記録したキー
    keysSeen: KeySeen[];
};

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

const DIST = resolve('dist');
const FM = ['---', 'markdag:', '---', ''];

const lines = (...items: string[]): string => items.join('\n');

// records/final-gate/am07 の文書 (計画の下に 24 個の項目) に、項目 1 と項目 24 のタグと、項目 2 の prio:high を足したもの。
// ノードは 計画 1、項目 n は n + 1 (項目 1 は 2、項目 24 は 25)。first と last は項目 1 と項目 24 の行の後ろの印
const ITEM_COUNT = 24;
function longDoc(first = '#team:core', last = '#team:core'): string {
    const items = Array.from({ length: ITEM_COUNT }, (_, index) => {
        const n = index + 1;
        const mark = n === 1 ? first : n === 2 ? '#prio:high' : n === ITEM_COUNT ? last : '';
        return `- 項目 ${n}${mark === '' ? '' : ` ${mark}`}`;
    });
    return lines(...FM, '# 計画', '', ...items, '');
}

const LONG_DOC = longDoc();
const FIRST = 2;
const LAST = 25;
const itemTarget = (id: number): NodeTarget => ({ id, refText: `項目 ${id - 1}` });
const FAR_APART = [itemTarget(FIRST), itemTarget(LAST)];
// 2 つに値のない owner を付けた文書 (タグ追加)
const LONG_OWNER = longDoc('#team:core #owner', '#team:core #owner');
// 2 つの team を web に変えた文書 (付いているタグの更新)
const LONG_TEAM_WEB = longDoc('#team:web', '#team:web');
// 2 つから team を外した文書 (行の ×)
const LONG_NO_TEAM = longDoc('', '');
// 2 つに prio:high を付けた文書 (タグ選択の付け外し)
const LONG_PRIO = longDoc('#team:core #prio:high', '#team:core #prio:high');
// 項目 24 だけに owner を付けた文書 (1 つのときの守り)
const LONG_LAST_OWNER = longDoc('#team:core', '#team:core #owner');
// 項目 24 を置く高さ (図の領域の上の辺から、箱の上下の中ほどまで)。下にタグのパネルが入る空きを残す
const LAST_CENTER_Y = 180;

// GUI 編集の閲覧のモードで確かめる文書。ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const TASK_A = 3;
const PLAIN_DOC = lines(...FM, ...BODY);
// markdag.editor で、閲覧と GUI 編集を切り替えられ、閲覧で始まる文書
const SWITCH_VIEW_DOC = lines('---', 'markdag:', '    editor:', '        mode: switch', '        default: view', '---', '', ...BODY);

// 見出しの詳細。ノードは 計画 1、設計 2、画面 3
const HEADING_LIST_DOC = lines(...FM, '# 計画', '', '## 設計', '', '- 画面', '');
// 見出しのすぐ次の行に字下げなしの > で書く (間に空行をはさまない。次の行は空行なので足さない。細部 16)
const HEADING_LIST_AFTER = lines(...FM, '# 計画', '', '## 設計', '> メモ', '', '- 画面', '');
// 空行をはさんだ見出しの詳細 (細部 15) は、その行を置き換える
const HEADING_NOTE_DOC = lines(...FM, '# 計画', '', '## 設計', '', '> 古いメモ', '', '- 画面', '');
const HEADING_NOTE_AFTER = lines(...FM, '# 計画', '', '## 設計', '', '> 新しいメモ', '', '- 画面', '');

// 囲みと逃がしの要るタグ。ノードは 計画 1、設計 2、実装 3。設計のタグは書いた順に
// キーに空白 (a b:x)、値に空白、値に "、値に \、空の値、数字だけのキー、キーに "
const QUOTED_LINE = String.raw`- 設計 #"a b":x #owner:"山田 太郎" #note:"say \"hi\"" #path:"C:\\dir" #k:"" #"123" #"a\"b"`;
const QUOTED_DOC = lines(...FM, '# 計画', '', QUOTED_LINE, '- 実装 #owner:alice #urgent', '');
// 設計に付いているタグの行の文字 (書いた順。formatTag と同じ形で、そのまま本文に書けば同じタグに読まれる)
const QUOTED_ATTACHED = [String.raw`#"a b":x`, String.raw`#owner:"山田 太郎"`, String.raw`#note:"say \"hi\""`, String.raw`#path:"C:\\dir"`, String.raw`#k:""`, String.raw`#"123"`, String.raw`#"a\"b"`];
// 登録されているタグの行の文字 (キー、値の順。並べ方は文字の符号の順: 数字、空白、"、英字の小文字、漢字)
const QUOTED_REGISTERED = [
    String.raw`#"123"`,
    String.raw`#"a b":x`,
    String.raw`#"a\"b"`,
    String.raw`#k:""`,
    String.raw`#note:"say \"hi\""`,
    String.raw`#owner:alice`,
    String.raw`#owner:"山田 太郎"`,
    String.raw`#path:"C:\\dir"`,
    String.raw`#urgent`,
];

// 本文が 2 行の下線の見出し (名前は 1 行目の「設計」。つなぐと名前が変わるので印を書けない)。ノードは 計画 1、設計 2、画面 3
const TWO_LINE_SETEXT_DOC = lines(...FM, '# 計画', '', '設計', 'の続き', '---', '', '- 画面', '');
// その見出しで T を押したときの理由 (書きすぎない。印を書けない見出しは、ATX に書き直せない下線の見出しだけになった)
const CANNOT_TAG_HEADING = 'この見出しにはタグを書けません';

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors = {};
        target.diagrams = {};
        target.changes = [];
        target.keysSeen = [];
    });
}

// mode を省くと文書の markdag.editor に従う。GUI 編集で始まったら選択の道具にする
async function mount(page: Page, markdown: string, mode?: EditorOptions['mode']): Promise<void> {
    await page.evaluate(
        ({ markdown, mode }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.changes.push(next);
                },
            };
            if (mode !== null) options.mode = mode;
            target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, mode: mode ?? null },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
    if ((await getMode(page)) === 'edit') {
        await toolButton(page, 'select').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
    }
}

// render (GUI 編集のない閲覧だけの図) で描く
async function renderOnly(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        target.diagrams.a = target.editorHarness.core.render(container, markdown, { animate: false });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「開かない」「動かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);
const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());
const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());

async function transformOf(page: Page): Promise<ViewTransform> {
    const transform = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getTransform() ?? null);
    if (!transform) throw new Error('#a の図がない');
    return transform;
}

const foldedOf = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getFolded() ?? []);

// 表示位置を置き換える (直す前はパネルを開くときに動くので、そのあとの操作だけの動きを見るために、開く前の位置へ戻す)
async function setTransform(page: Page, transform: ViewTransform): Promise<void> {
    await page.evaluate((transform) => (window as unknown as EditorWindow).editors.a?.view.setTransform(transform), transform);
    await settle(page);
}

const roundTransform = (transform: ViewTransform): ViewTransform => ({ x: Math.round(transform.x * 100) / 100, y: Math.round(transform.y * 100) / 100, k: Math.round(transform.k * 1000) / 1000 });

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const nodeCount = (page: Page): Promise<number> => page.locator('#a .mdag-node').count();

// 要素の矩形 (画面の座標。図の領域の外へパンした要素も入れる)
async function rectOf(page: Page, selector: string): Promise<Box> {
    const box = await page.evaluate((selector) => {
        const element = [...document.querySelectorAll(selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }, selector);
    if (!box) throw new Error(`要素がない: ${selector}`);
    return box;
}

const nodeBox = (page: Page, id: number): Promise<Box> => rectOf(page, `${nodeSelector(id)} .mdag-box`);
const areaBox = (page: Page): Promise<Box> => rectOf(page, '#a > .mdag-viewport');

// ノードの箱が図の領域に (一部でも) 見えているか
async function shownIn(page: Page, id: number): Promise<boolean> {
    const box = await nodeBox(page, id);
    const area = await areaBox(page);
    return box.bottom > area.top && box.top < area.bottom && box.right > area.left && box.left < area.right;
}

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank' }
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
            const container = document.getElementById('a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        if (target.on === 'element') {
            const rect = element.getBoundingClientRect();
            return (
                grid(rect, Math.max(1, Math.min(rect.width, rect.height) / 8)).find((point) => {
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

// ノードの文字の上を押す (Shift を押しながらも)。タグの要素の上は押さない
async function pressLabel(page: Page, id: number, modifier?: 'Shift'): Promise<void> {
    const point = await spot(page, { on: 'text', selector: `${nodeSelector(id)} .mdag-content` });
    if (modifier) await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        if (modifier) await page.keyboard.up(modifier);
    }
}

// ノードの箱を押す
async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
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

// 道具箱のボタンを押す
async function pressTool(page: Page, tool: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `#a .mdag-editor-tool[data-tool="${tool}"]` }));
}

// 選んでいるノード (getSelection) の id と refText (id の昇順)。何も選んでいなければ空、ノードでなければ kind
async function selectedNodes(page: Page): Promise<NodeTarget[] | string> {
    const selection = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() ?? null);
    if (selection === null) return 'no-editor';
    if (selection.kind === 'none') return [];
    return selection.kind === 'nodes' ? [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText })) : selection.kind;
}

async function expectSelected(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    await expect.poll(() => selectedNodes(page), message).toEqual([...targets].sort((a, b) => a.id - b.id));
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

// 見えている通知が 1 つあり、kind (data-kind) で、文字がある。文字を返す
async function expectNotice(page: Page, kind: 'info' | 'error', message?: string): Promise<string> {
    const shown = visible(page, `#a .mdag-editor-snackbar[data-kind="${kind}"]`);
    await expect(shown, message).toHaveCount(1);
    const text = ((await shown.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    expect(text, message).not.toBe('');
    return text;
}

// 配布物の editSource で同じ書き換えを試す (期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

async function expectEdit(page: Page, source: string, op: EditOp, expected: string): Promise<void> {
    const outcome = await tryEdit(page, source, op);
    expect(outcome.status === 'edited' ? outcome.source : outcome, JSON.stringify(op)).toBe(expected);
}

// 描いている文書の原文で、ノードの原文の事実を読む (inspectNode)
async function factsOf(page: Page, id: number): Promise<{ kind: string; canHaveDetails: boolean; canMark: boolean; details: string | null } | null> {
    return page.evaluate((id) => {
        const target = window as unknown as EditorWindow;
        const editor = target.editors.a;
        const node = editor?.view.getDocument()?.parsed.nodes.find((entry) => entry.id === id);
        if (!editor || !node) return null;
        const facts = target.editorHarness.core.inspectNode(editor.getSource(), { id: node.id, refText: node.refText });
        return facts === null ? null : { kind: facts.kind, canHaveDetails: facts.canHaveDetails, canMark: facts.canMark, details: facts.details };
    }, id);
}

interface PanelRow {
    key: string | null;
    // data-value。属性がなければ null (値のないタグ)。空の値は ''
    value: string | null;
    // 行の文字 (× を除く。前後の空白を外したもの)
    text: string;
}

interface PanelState {
    // 見えているタグのパネルの数
    count: number;
    // data-panel (add か select)
    kind: string | null;
    // 行 (.mdag-editor-tag-row) の並び
    rows: PanelRow[];
}

async function panelOf(page: Page): Promise<PanelState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const shown = [...container.querySelectorAll('.mdag-editor-tag-panel')].filter((element) => element.checkVisibility());
        const panel = shown[0];
        if (shown.length !== 1 || !panel) return { count: shown.length, kind: null, rows: [] };
        return {
            count: 1,
            kind: panel.getAttribute('data-panel'),
            rows: [...panel.querySelectorAll('.mdag-editor-tag-row')]
                .filter((element) => element.checkVisibility())
                .map((element) => {
                    const pick = element.querySelector('.mdag-editor-tag-pick');
                    return { key: element.getAttribute('data-key'), value: element.getAttribute('data-value'), text: (pick?.textContent ?? '').trim() };
                }),
        };
    });
}

// タグのパネルが 1 つ開き、種類が kind になるまで待つ
async function expectPanel(page: Page, kind: 'add' | 'select', message?: string): Promise<void> {
    await expect.poll(async () => {
        const state = await panelOf(page);
        return { count: state.count, kind: state.kind };
    }, message).toEqual({ count: 1, kind });
}

// タグ追加のパネルのキーと値の欄の値と、送るボタンの文字 (追加か更新)
async function addFieldsOf(page: Page): Promise<{ key: string | null; value: string | null; submit: string | null }> {
    return page.evaluate(() => {
        const panel = [...document.querySelectorAll('#a .mdag-editor-tag-panel')].find((element) => element.checkVisibility());
        const field = (name: string): string | null => panel?.querySelector<HTMLInputElement>(`input[data-field="${name}"]`)?.value ?? null;
        const submit = [...(panel?.querySelectorAll<HTMLButtonElement>('button[data-action="add"], button[data-action="update"]') ?? [])].find((button) => button.checkVisibility());
        return { key: field('key'), value: field('value'), submit: submit?.dataset.action ?? null };
    });
}

type PanelTarget =
    // 行。part は行の文字 (× の外) か、行の × (外すボタン)
    | { on: 'row'; key: string; value: string | null; part?: 'body' | 'remove' }
    // 文字の入力 (data-field が key か value)
    | { on: 'field'; field: 'key' | 'value' }
    // 絞り込みの欄
    | { on: 'filter' };

const panelSelector = (target: PanelTarget): string => {
    const panel = '#a .mdag-editor-tag-panel';
    if (target.on === 'field') return `${panel} input[data-field="${target.field}"]`;
    if (target.on === 'filter') return `${panel} .mdag-editor-tag-filter`;
    const value = target.value === null ? ':not([data-value])' : `[data-value=${JSON.stringify(target.value)}]`;
    const row = `${panel} .mdag-editor-tag-row[data-key=${JSON.stringify(target.key)}]${value}`;
    return target.part === 'remove' ? `${row} .mdag-editor-tag-remove` : `${row} .mdag-editor-tag-pick`;
};

// パネルの中を押す。パネルは中身が変わると大きさが変わり、図が置き直す (描画のコマを待つ) ので、置き場が落ち着いてから押す点を決める
async function pressInPanel(page: Page, target: PanelTarget): Promise<void> {
    await settle(page);
    await press(page, await spot(page, { on: 'element', selector: panelSelector(target) }));
}

// 文字の入力を押してフォーカスを置き、中身を全部選んで text を打つ
async function fillField(page: Page, target: PanelTarget, text: string): Promise<void> {
    await pressInPanel(page, target);
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
    await expect.poll(() => page.evaluate((selector) => document.querySelector<HTMLInputElement>(selector)?.value ?? null, panelSelector(target))).toBe(text);
}

// 入力 (名前の入力か詳細の入力) の見えている数、値、フォーカス
async function inputOf(page: Page, selector: string): Promise<{ count: number; value: string | null; focused: boolean }> {
    return page.evaluate((selector) => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const shown = [...container.querySelectorAll(selector)].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false };
        const field = element.matches('textarea, input') ? element : element.querySelector('textarea, input');
        if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) return { count: 1, value: null, focused: false };
        return { count: 1, value: field.value, focused: document.activeElement === field };
    }, selector);
}

const DETAILS_EDITOR = '.mdag-editor-details-editor';

// キーの記録を始める。記録するのは Backspace、Delete と、閲覧のほかのキー (矢印、Enter、T)。
// 文字を打つ要素の外の Backspace は、記録のあとに既定の動きを止める (webkit が前のページへ戻らないように。ほかのテストには入れない)
async function watchKeys(page: Page): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.keysSeen = [];
        window.addEventListener('keydown', (event) => {
            if (!['Backspace', 'Delete', 'ArrowDown', 'Enter', 't'].includes(event.key)) return;
            const modifiers = [event.shiftKey ? 'Shift' : '', event.altKey ? 'Alt' : '', event.metaKey ? 'Meta' : '', event.ctrlKey ? 'Control' : ''].filter((name) => name !== '').join('+');
            target.keysSeen.push({ key: event.key, modifiers, prevented: event.defaultPrevented, inDiagram: document.getElementById('a')?.contains(document.activeElement) ?? false });
            const entry = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
            if (event.key === 'Backspace' && !entry) event.preventDefault();
        });
    });
}

// watchKeys が記録したキーを返し、記録を空にする
const takeKeys = (page: Page): Promise<KeySeen[]> =>
    page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        const seen = target.keysSeen;
        target.keysSeen = [];
        return seen;
    });

const seen = (key: string, modifiers: string, prevented: boolean, inDiagram: boolean): KeySeen => ({ key, modifiers, prevented, inDiagram });

// Playwright のキーの名前 (Shift+Backspace など) を、記録の key と modifiers にする
function seenOf(press: string, prevented: boolean, inDiagram: boolean): KeySeen {
    const parts = press.split('+');
    const key = parts.pop() ?? '';
    return seen(key, parts.join('+'), prevented, inDiagram);
}

// 変換中のキー (isComposing が true) を、フォーカスのある要素から送る (変換の始め方はブラウザで違うので、どのブラウザでも同じ形の出来事で確かめる)
async function dispatchComposing(page: Page, key: 'Backspace' | 'Delete'): Promise<void> {
    await page.evaluate((key) => {
        const target = document.activeElement ?? document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }));
    }, key);
}

// 図の外の入力欄 (アプリの入力欄の代わり)。図の右の空いた所に置き、図とは重ねない
async function addOutsideField(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('outside')) return;
        const field = document.createElement('input');
        field.id = 'outside';
        field.type = 'text';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 200px;';
        document.body.append(field);
    });
}

// フォーカスをどこにも置かない (body に戻す)
const blurAll = (page: Page): Promise<void> => page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));

// am07 の手順の前半: 拡大 (1.6 倍) して項目 1 を見せて押す
async function zoomAndPickFirst(page: Page): Promise<void> {
    await page.evaluate((first) => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        if (!view) throw new Error('#a の図がない');
        const t = view.getTransform();
        view.setTransform({ x: t.x, y: t.y, k: 1.6 });
        view.ensureVisible(first);
    }, FIRST);
    await settle(page);
    await pressLabel(page, FIRST);
    await expectSelected(page, [itemTarget(FIRST)]);
}

// 図をパンして、項目 24 の箱の上下の中ほどを図の領域の上の辺から centerY に置く (項目 1 は画面の外へ出る)
async function panLastTo(page: Page, centerY: number): Promise<void> {
    await page.evaluate((last) => (window as unknown as EditorWindow).editors.a?.view.ensureVisible(last), LAST);
    await settle(page);
    const area = await areaBox(page);
    const box = await nodeBox(page, LAST);
    await page.evaluate((dy) => (window as unknown as EditorWindow).editors.a?.view.panBy(0, dy), area.top + centerY - (box.top + box.bottom) / 2);
    await settle(page);
}

// am07 の操作 2 まで: 項目 1 を選び、パンして項目 24 を Shift+クリックで選び足す (項目 1 は画面の外、項目 24 は見えている)。そのときの表示位置を返す
async function pickFarApart(page: Page): Promise<ViewTransform> {
    await mount(page, LONG_DOC, 'edit');
    await zoomAndPickFirst(page);
    await panLastTo(page, LAST_CENTER_Y);
    await pressLabel(page, LAST, 'Shift');
    await expectSelected(page, FAR_APART);
    await settle(page);
    expect(await shownIn(page, FIRST), '項目 1 は画面の外').toBe(false);
    expect(await shownIn(page, LAST), '項目 24 は見えている').toBe(true);
    return transformOf(page);
}

// 図が動いていない: 表示位置が before と同じで、開閉も変わらず、項目 1 は画面の外のまま、項目 24 は見えている
async function expectNotMoved(page: Page, before: ViewTransform, message: string): Promise<void> {
    await settle(page);
    expect(roundTransform(await transformOf(page)), `${message} の表示位置`).toEqual(roundTransform(before));
    expect(await foldedOf(page), `${message} の開閉`).toEqual([]);
    expect(await shownIn(page, FIRST), `${message} の項目 1`).toBe(false);
    expect(await shownIn(page, LAST), `${message} の項目 24`).toBe(true);
}

test.describe('AM-07: 2 つ以上を選んでいるときのタグのパネルとタグの操作では図を動かさない (plan.md の 2、細部 4。records/final-gate/am07)', () => {
    test('@editor 離れた 2 つ (項目 1 は画面の外) を選んで T を押すと、タグ追加のパネルが開き、図は動かない (表示位置と開閉が T の前と同じで、項目 1 は画面の外のまま)', async ({ page }) => {
        await open(page);
        const before = await pickFarApart(page);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await expectNotMoved(page, before, 'T');
        await expectSelected(page, FAR_APART);
        await expectSourceStill(page, LONG_DOC, []);
    });

    test('@editor 離れた 2 つを選んで道具箱のタグ選択を押すと、タグ選択のパネルが開き、図は動かない', async ({ page }) => {
        await open(page);
        const before = await pickFarApart(page);
        await pressTool(page, 'tag-select');
        await expectPanel(page, 'select');
        await expectNotMoved(page, before, '道具箱のタグ選択');
        await expectSelected(page, FAR_APART);
    });

    test('@editor 離れた 2 つに、タグ追加のパネルでキーを入れて Enter (追加) すると、2 つに付けて図は動かない', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'setTag', nodes: FAR_APART, key: 'owner', value: null, replaceKey: null }, LONG_OWNER);
        const before = await pickFarApart(page);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await setTransform(page, before);
        await page.keyboard.type('owner');
        await page.keyboard.press('Enter');
        await expectSource(page, LONG_OWNER, [LONG_OWNER]);
        await expectNotMoved(page, before, '追加');
        await expectSelected(page, FAR_APART);
        await expectPanel(page, 'add', '追加のあともパネルは開いたまま');
    });

    test('@editor 離れた 2 つに付いているタグの行を押して値を変え、Enter (更新) すると、2 つの値を変えて図は動かない', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'setTag', nodes: FAR_APART, key: 'team', value: 'web', replaceKey: null }, LONG_TEAM_WEB);
        const before = await pickFarApart(page);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await setTransform(page, before);
        await pressInPanel(page, { on: 'row', key: 'team', value: 'core' });
        await expect.poll(() => addFieldsOf(page)).toEqual({ key: 'team', value: 'core', submit: 'update' });
        await fillField(page, { on: 'field', field: 'value' }, 'web');
        await page.keyboard.press('Enter');
        await expectSource(page, LONG_TEAM_WEB, [LONG_TEAM_WEB]);
        await expectNotMoved(page, before, '更新');
        await expectSelected(page, FAR_APART);
    });

    test('@editor 離れた 2 つに付いているタグの行の × で外すと、2 つから外して図は動かない', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'removeTag', nodes: FAR_APART, key: 'team' }, LONG_NO_TEAM);
        const before = await pickFarApart(page);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await setTransform(page, before);
        await pressInPanel(page, { on: 'row', key: 'team', value: 'core', part: 'remove' });
        await expectSource(page, LONG_NO_TEAM, [LONG_NO_TEAM]);
        await expectNotMoved(page, before, '×');
        await expectSelected(page, FAR_APART);
    });

    test('@editor 離れた 2 つを選んで、タグ選択のパネルの行を押して付けると、2 つに付けて図は動かない', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'toggleTag', nodes: FAR_APART, key: 'prio', value: 'high' }, LONG_PRIO);
        const before = await pickFarApart(page);
        await pressTool(page, 'tag-select');
        await expectPanel(page, 'select');
        await setTransform(page, before);
        await pressInPanel(page, { on: 'row', key: 'prio', value: 'high' });
        await expectSource(page, LONG_PRIO, [LONG_PRIO]);
        await expectNotMoved(page, before, '付け外し');
        await expectSelected(page, FAR_APART);
    });

    test('@editor 守り: 1 つだけ選んで T を押すと、今と同じく選んだノードを見える所へ動かす (画面の外の項目 1 が見える所に入る)', async ({ page }) => {
        await open(page);
        await mount(page, LONG_DOC, 'edit');
        await zoomAndPickFirst(page);
        await panLastTo(page, LAST_CENTER_Y);
        await expectSelected(page, [itemTarget(FIRST)]);
        expect(await shownIn(page, FIRST), 'T の前の項目 1').toBe(false);
        const before = await transformOf(page);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        await settle(page);
        expect(await shownIn(page, FIRST), 'T のあとの項目 1').toBe(true);
        expect(roundTransform(await transformOf(page)), 'T のあとの表示位置').not.toEqual(roundTransform(before));
    });

    test('@editor 守り: 1 つだけ選んでタグを足すと、今と同じく選んだノードを見える所へ動かす (図の下の辺から外れかけた項目 24 が入る)', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'setTag', nodes: [itemTarget(LAST)], key: 'owner', value: null, replaceKey: null }, LONG_LAST_OWNER);
        await mount(page, LONG_DOC, 'edit');
        await zoomAndPickFirst(page);
        await panLastTo(page, LAST_CENTER_Y);
        await pressLabel(page, LAST);
        await expectSelected(page, [itemTarget(LAST)]);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        // 項目 24 の箱の上の辺を、図の領域の下の辺の少し上に置く (箱の大部分は画面の外)
        const area = await areaBox(page);
        const box = await nodeBox(page, LAST);
        await page.evaluate((dy) => (window as unknown as EditorWindow).editors.a?.view.panBy(0, dy), area.bottom - 6 - box.top);
        await settle(page);
        const before = await transformOf(page);
        const outside = await nodeBox(page, LAST);
        expect(outside.bottom, '足す前の項目 24 は下の辺から外れている').toBeGreaterThan(area.bottom);
        await page.keyboard.type('owner');
        await page.keyboard.press('Enter');
        await expectSource(page, LONG_LAST_OWNER, [LONG_LAST_OWNER]);
        await settle(page);
        const inside = await nodeBox(page, LAST);
        expect(inside.bottom, '足したあとの項目 24 は下の辺の内').toBeLessThanOrEqual(area.bottom);
        expect(roundTransform(await transformOf(page)), '足したあとの表示位置').not.toEqual(roundTransform(before));
    });
});

test.describe('AM-09: GUI 編集の閲覧のモードで、図がキーを受けているときの Backspace と Delete は既定の動きを止めて何もしない (plan.md の 4、細部 5。records/final-gate/am09)', () => {
    test('@editor mount の mode: view の図でノードを押して、Backspace、Delete、Shift+Backspace、Shift+Delete を押すと、既定の動きを止め (defaultPrevented)、原文、ノード、通知、URL は変わらない。ポインタを図の何もない所へ動かしても、フォーカスが図にあれば同じ', async ({ page }) => {
        await open(page);
        await watchKeys(page);
        const url = page.url();
        await mount(page, PLAIN_DOC, 'view');
        expect(await getMode(page)).toBe('view');
        await pressNode(page, TASK_A);
        const keys = ['Backspace', 'Delete', 'Shift+Backspace', 'Shift+Delete'];
        for (const key of keys) await page.keyboard.press(key);
        await pointerOverBlank(page);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        expect(await takeKeys(page)).toEqual([...keys, 'Backspace', 'Delete'].map((key) => seenOf(key, true, true)));
        await expectSourceStill(page, PLAIN_DOC, []);
        expect(await nodeCount(page)).toBe(6);
        await expect(snackbars(page)).toHaveCount(0);
        expect(page.url()).toBe(url);
    });

    test('@editor 閲覧で始まる切り替えの文書 (markdag.editor の mode: switch、default: view) でも止める。フォーカスがどこにもなく、ポインタが図の上にあるときも止める', async ({ page }) => {
        await open(page);
        await watchKeys(page);
        const url = page.url();
        await mount(page, SWITCH_VIEW_DOC);
        expect(await getMode(page)).toBe('view');
        await pressNode(page, TASK_A);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        await blurAll(page);
        await pointerOverBlank(page);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        expect(await takeKeys(page)).toEqual([seen('Backspace', '', true, true), seen('Delete', '', true, true), seen('Backspace', '', true, false), seen('Delete', '', true, false)]);
        await expectSourceStill(page, SWITCH_VIEW_DOC, []);
        expect(await nodeCount(page)).toBe(6);
        await expect(snackbars(page)).toHaveCount(0);
        expect(page.url()).toBe(url);
        expect(await getMode(page)).toBe('view');
    });

    test('@editor 守り: 閲覧のモードでも止めないもの: Alt / ⌘ / Ctrl つきの Backspace と Delete、変換中のキー、閲覧のほかのキー (矢印、Enter、T)、図の外の入力欄のキー (字が消える)、フォーカスがどこにもなくポインタが図の外にあるときのキー', async ({ page }) => {
        await open(page);
        await watchKeys(page);
        await mount(page, PLAIN_DOC, 'view');
        await addOutsideField(page);
        await pressNode(page, TASK_A);
        const modified = ['Alt+Backspace', 'Meta+Backspace', 'Control+Backspace', 'Alt+Delete', 'Meta+Delete', 'Control+Delete'];
        for (const key of modified) await page.keyboard.press(key);
        expect(await takeKeys(page), 'Alt / ⌘ / Ctrl つき').toEqual(modified.map((key) => seenOf(key, false, true)));
        await dispatchComposing(page, 'Backspace');
        await dispatchComposing(page, 'Delete');
        expect(await takeKeys(page), '変換中のキー').toEqual([seen('Backspace', '', false, true), seen('Delete', '', false, true)]);

        // 図の外の入力欄: 既定の動き (字を消す) のまま
        await page.locator('#outside').click();
        await page.keyboard.type('ab');
        await page.keyboard.press('Backspace');
        await expect(page.locator('#outside')).toHaveValue('a');
        expect(await takeKeys(page), '図の外の入力欄').toEqual([seen('Backspace', '', false, false)]);

        // フォーカスがどこにもなく、ポインタが図の外
        await blurAll(page);
        await page.mouse.move(1100, 300);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        expect(await takeKeys(page), 'ポインタが図の外').toEqual([seen('Backspace', '', false, false), seen('Delete', '', false, false)]);

        // 閲覧のほかのキーは今のまま受けない (ページの既定の動きを止めない)
        await pressNode(page, TASK_A);
        for (const key of ['Enter', 't', 'ArrowDown']) await page.keyboard.press(key);
        expect(await takeKeys(page), '閲覧のほかのキー').toEqual([seen('Enter', '', false, true), seen('t', '', false, true), seen('ArrowDown', '', false, true)]);
        await expectSourceStill(page, PLAIN_DOC, []);
        await expect(snackbars(page)).toHaveCount(0);
    });

    test('@editor 守り: render (GUI 編集のない閲覧だけの図) では、ノードを押したあとの Backspace と Delete の既定の動きを止めない', async ({ page }) => {
        await open(page);
        await watchKeys(page);
        await renderOnly(page, PLAIN_DOC);
        await pressNode(page, TASK_A);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        await page.keyboard.press('Shift+Backspace');
        expect((await takeKeys(page)).map((entry) => ({ key: entry.key, modifiers: entry.modifiers, prevented: entry.prevented }))).toEqual([
            { key: 'Backspace', modifiers: '', prevented: false },
            { key: 'Delete', modifiers: '', prevented: false },
            { key: 'Backspace', modifiers: 'Shift', prevented: false },
        ]);
        expect(await nodeCount(page)).toBe(6);
    });

    test('@editor 守り: GUI 編集のモードで何も選んでいないときの Backspace と Delete は、今のまま既定の動きを止めて何もしない (閲覧が合わせる先)。Alt つきは止めない', async ({ page }) => {
        await open(page);
        await watchKeys(page);
        await mount(page, PLAIN_DOC, 'edit');
        await press(page, await spot(page, { on: 'blank' }));
        await expectSelected(page, []);
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Delete');
        await page.keyboard.press('Alt+Backspace');
        expect((await takeKeys(page)).map((entry) => ({ key: entry.key, modifiers: entry.modifiers, prevented: entry.prevented }))).toEqual([
            { key: 'Backspace', modifiers: '', prevented: true },
            { key: 'Delete', modifiers: '', prevented: true },
            { key: 'Backspace', modifiers: 'Alt', prevented: false },
        ]);
        await expectSourceStill(page, PLAIN_DOC, []);
        expect(await nodeCount(page)).toBe(6);
    });
});

test.describe('見出しの詳細の入口 (plan.md の 10。scope.md の「最後の関門 原文の都合で断る 6」)', () => {
    test('@editor 守り: 下にリストのある見出しを選んで D を押すと詳細の入力が空で開き、書いて ⌘Enter で保存すると、見出しのすぐ下に > で書き、図の見出しに詳細の印が出る', async ({ page }) => {
        await open(page);
        await expectEdit(page, HEADING_LIST_DOC, { kind: 'setDetails', node: { id: 2, refText: '設計' }, text: 'メモ' }, HEADING_LIST_AFTER);
        await mount(page, HEADING_LIST_DOC, 'edit');
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'heading', canHaveDetails: true, details: null });
        await expect(page.locator(nodeSelector(2))).not.toHaveAttribute('data-has-details', '');
        await pressLabel(page, 2);
        await expectSelected(page, [{ id: 2, refText: '設計' }]);
        await page.keyboard.press('d');
        await expect.poll(() => inputOf(page, DETAILS_EDITOR)).toEqual({ count: 1, value: '', focused: true });
        await page.keyboard.type('メモ');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, HEADING_LIST_AFTER, [HEADING_LIST_AFTER]);
        await expect.poll(async () => (await inputOf(page, DETAILS_EDITOR)).count).toBe(0);
        await expectNotice(page, 'info');
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
        await expect(visible(page, `${nodeSelector(2)} .mdag-note-mark`), '詳細の印').toHaveCount(1);
        expect(await factsOf(page, 2)).toMatchObject({ details: 'メモ' });
    });

    test('@editor 守り: 詳細のある見出しを選んで帯の「詳細編集」を押すと今の詳細で開き、書き換えて ⌘Enter で保存すると、その行を置き換える', async ({ page }) => {
        await open(page);
        await expectEdit(page, HEADING_NOTE_DOC, { kind: 'setDetails', node: { id: 2, refText: '設計' }, text: '新しいメモ' }, HEADING_NOTE_AFTER);
        await mount(page, HEADING_NOTE_DOC, 'edit');
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
        await pressLabel(page, 2);
        await expectSelected(page, [{ id: 2, refText: '設計' }]);
        await pressBar(page, 'details');
        await expect.poll(() => inputOf(page, DETAILS_EDITOR)).toEqual({ count: 1, value: '古いメモ', focused: true });
        await page.keyboard.press('ControlOrMeta+KeyA');
        await page.keyboard.type('新しいメモ');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, HEADING_NOTE_AFTER, [HEADING_NOTE_AFTER]);
        await expectNotice(page, 'info');
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
    });
});

test.describe('タグのパネルの行の文字を、囲みと逃がしの規則 (formatTag) に合わせる (plan.md の 9 の編集の層)', () => {
    test('@editor タグ追加のパネルの付いているタグの行は、キーと値を要るときだけ " で囲み、囲みの中の " と \\ を逃がした形で出る (#"a b":x、#owner:"山田 太郎"、#note:"say \\"hi\\""、#path:"C:\\\\dir"、#k:""、#"123"、#"a\\"b")', async ({ page }) => {
        await open(page);
        await mount(page, QUOTED_DOC, 'edit');
        await pressLabel(page, 2);
        await expectSelected(page, [{ id: 2, refText: '設計' }]);
        await page.keyboard.press('t');
        await expectPanel(page, 'add');
        const rows = (await panelOf(page)).rows;
        // 行の指すタグ (data-key と data-value) は今と同じ
        expect(rows.map((row) => [row.key, row.value])).toEqual([
            ['a b', 'x'],
            ['owner', '山田 太郎'],
            ['note', 'say "hi"'],
            ['path', 'C:\\dir'],
            ['k', ''],
            ['123', null],
            ['a"b', null],
        ]);
        expect(rows.map((row) => row.text)).toEqual(QUOTED_ATTACHED);
    });

    test('@editor タグ選択のパネルの登録されているタグの行も同じ形で出る。囲まなくてよいタグ (#owner:alice、#urgent) は今と同じ。値の中の字 (山田) で絞り込める', async ({ page }) => {
        await open(page);
        await mount(page, QUOTED_DOC, 'edit');
        await pressLabel(page, 2);
        await expectSelected(page, [{ id: 2, refText: '設計' }]);
        await pressTool(page, 'tag-select');
        await expectPanel(page, 'select');
        expect((await panelOf(page)).rows.map((row) => row.text)).toEqual(QUOTED_REGISTERED);
        await fillField(page, { on: 'filter' }, '山田');
        await expect.poll(async () => (await panelOf(page)).rows.map((row) => [row.key, row.value])).toEqual([['owner', '山田 太郎']]);
    });
});

test.describe('通知の書き方 (scope.md の「最後の関門 GUI の通知の書き方」)', () => {
    test('@editor 本文が 2 行の下線の見出しを選んで T を押すと、パネルを開かず、理由は「この見出しにはタグを書けません」だけ (書きすぎない)。原文は変わらない', async ({ page }) => {
        await open(page);
        await mount(page, TWO_LINE_SETEXT_DOC, 'edit');
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'heading', canMark: false });
        await pressLabel(page, 2);
        await expectSelected(page, [{ id: 2, refText: '設計' }]);
        await page.keyboard.press('t');
        expect(await expectNotice(page, 'error')).toBe(CANNOT_TAG_HEADING);
        await settle(page);
        expect((await panelOf(page)).count).toBe(0);
        await expectSourceStill(page, TWO_LINE_SETEXT_DOC, []);
    });
});


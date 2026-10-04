// GUI 編集のグループ (まとめる、選ぶ、名前、解除) を、ビルドした配布物の markdag/editor で確かめる。
// GUI 編集では文書の groupHighlight の指定によらず枠を押せ、選んでいる間の強調は true の文書と同じ。
// グループの選択と名前の入力のキー、帯と名前の入力の置き場 ({ group } の落とし方)、groupNodes、renameGroup、ungroup の書き換えと断る理由を見る。
// 見た目そのもの (色、余白、影) は見ない。書き換えたあとの原文の全文、onChange の呼ばれ方、モデルの groups と groupsOf (view.getDocument)、
// グループの選択 (getSelection、onSelectionChange、view の onSelectGroup、図の強調の data-faded)、帯の有無と中身と置き場、
// 名前の入力の有無、値、フォーカス、置き場、通知 (.mdag-editor-snackbar と data-kind)、元に戻すを見る。
// 期待の原文はグループの書き換えと frontmatter の足し方の規則から書いた (%印は 1 行目の末尾、groups は markdag の写像の末尾、新しいグループは group<番号>)。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」「開かない」は描画の数コマと 200ms を待ってから見る
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

interface KeyEntry {
    key: string;
    // 編集の層の受け口のあとで、既定の動き (ブラウザの検索) が止められていたか
    prevented: boolean;
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
    // window で受けた G のキーの押下 (mount のあとに足した受け口なので、編集の層の受け口より後に呼ばれる)
    keyLog: KeyEntry[];
    // keyLog の受け口を外す
    unlistenKeys?: () => void;
};

const DIST = resolve('dist');

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

const indent = (line: string): string => `    ${line}`;

// markdag.editor を書いた文書。before は markdag の下で editor より前に、after は editor よりあとに置く行 (markdag の下の字下げ (4 桁) からの相対)。
// editor の行は markdag.editor の下の字下げ (8 桁) からの相対
function docWith(editor: string[], body: string[], before: string[] = [], after: string[] = []): string {
    return ['---', 'markdag:', '    edgeHighlight: true', ...before.map(indent), '    editor:', ...editor.map((line) => `        ${line}`), ...after.map(indent), '---', '', ...body].join('\n');
}

// markdag.groups の 1 つの定義の行 (groups の下の字下げからの相対)。label は YAML に書く形のまま
function groupDef(id: string, label: string, color: string): string[] {
    return [`    ${id}:`, `        label: ${label}`, `        color: "${color}"`, '        boundary: true'];
}

// 本文の行の末尾に印を足す
function marked(body: string[], marks: Record<string, string>): string[] {
    return body.map((line) => (marks[line] === undefined ? line : `${line} ${marks[line]}`));
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、同じ親の子は縦に並ぶ
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const BUILD = 5;
const LEAF = 6;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Build', 6: 'Leaf' };

const DOC = docWith(EDIT, BODY);

// 新しいグループ: 使われていない最小の番号の group1、label「グループ 1」、決まった色の 1 つ目、boundary: true。
// groups のキーは markdag の写像の末尾 (editor のあと) に作る
const NEW_ID = 'group1';
const NEW_LABEL = 'グループ 1';
const NEW_COLOR = '#3B7DD8';
const NEW_GROUPS = ['groups:', ...groupDef(NEW_ID, NEW_LABEL, NEW_COLOR)];

// Task A と Task B をまとめた文書。2 つの 1 行目の末尾に %group1
const DOC_AB = docWith(EDIT, marked(BODY, { '- Task A': '%group1', '- Task B': '%group1' }), [], NEW_GROUPS);
// 子のない Leaf だけをまとめた文書 (メンバーが 1 つでも Leaf を囲む枠が描かれる。前はメンバーが 1 つのグループに枠を描かなかった) と、その名前を「公開」に決めた文書
const DOC_LEAF = docWith(EDIT, marked(BODY, { '- Leaf': '%group1' }), [], NEW_GROUPS);
const DOC_LEAF_NAMED = docWith(EDIT, marked(BODY, { '- Leaf': '%group1' }), [], ['groups:', ...groupDef(NEW_ID, '公開', NEW_COLOR)]);

// グループが 2 つある文書。Design と配下 (2〜4) がグループ design (設計) の枠に、Build と配下 (5、6) がグループ build (実装) の枠に入る
const GROUPED_BODY = marked(BODY, { '## Design': '%design', '## Build': '%build' });
const DESIGN_MEMBERS = [DESIGN, TASK_A, TASK_B];
const BUILD_MEMBERS = [BUILD, LEAF];
function groupsWith(designLabel: string): string[] {
    return ['groups:', ...groupDef('design', designLabel, '#3B7DD8'), ...groupDef('build', '実装', '#E8833A')];
}
const DOC_GROUPS = docWith(EDIT, GROUPED_BODY, groupsWith('設計'));
// groupHighlight を true と false で書いた写し (行の数が同じなので図の並びも同じ)
const DOC_GROUPS_ON = docWith(EDIT, GROUPED_BODY, ['groupHighlight: true', ...groupsWith('設計')]);
const DOC_GROUPS_OFF = docWith(EDIT, GROUPED_BODY, ['groupHighlight: false', ...groupsWith('設計')]);
// design の名前を変えた文書 (label の値だけを書き換える。YAML でそのまま書けない名前は "…" で囲む)
const DOC_RENAMED = docWith(EDIT, GROUPED_BODY, groupsWith('設計の範囲'));
const DOC_RENAMED_QUOTED = docWith(EDIT, GROUPED_BODY, groupsWith('"設計: 画面"'));
const DOC_GROUPS_VIEW = docWith(['mode: view'], GROUPED_BODY, groupsWith('設計'));
const DOC_GROUPS_SWITCH = docWith(SWITCH_EDIT, GROUPED_BODY, groupsWith('設計'));
const DOC_GROUPS_SWITCH_RENAMED = docWith(SWITCH_EDIT, GROUPED_BODY, groupsWith('設計の範囲'));

// グループが design の 1 つだけの文書。解除すると印と定義が外れ、空になった groups のキーも外れて DOC に戻る
const DOC_ONE_GROUP = docWith(EDIT, marked(BODY, { '## Design': '%design' }), ['groups:', ...groupDef('design', '設計', '#3B7DD8')]);

// 下線の見出しを含む文書。Root 1、Design 2 (下線の見出し)、Task A 3、Build 4、Leaf 5
const DOC_SETEXT = docWith(EDIT, ['# Root', '', 'Design', '------', '', '- Task A', '', '## Build', '', '- Leaf', '']);
const SETEXT_DESIGN = 2;
const SETEXT_TASK_A = 3;
const SETEXT_BUILD = 4;
const SETEXT_LEAF = 5;
// 下線の見出しを同じ段の ATX の見出しに書き直してから %group1 を付けた文書 (Design だけ、Design と Build。D-048)
const DOC_SETEXT_DESIGN = docWith(EDIT, ['# Root', '', '## Design %group1', '', '- Task A', '', '## Build', '', '- Leaf', ''], [], NEW_GROUPS);
const DOC_SETEXT_BOTH = docWith(EDIT, ['# Root', '', '## Design %group1', '', '- Task A', '', '## Build %group1', '', '- Leaf', ''], [], NEW_GROUPS);

// 見出しの下にリストが 2 つある文書。Root 1、リストの入れ物 2、Task A 3、Task B 4、番号のリストの入れ物 5、1. Step 6、2. Next 7。
// 入れ物は最初の項目と 1 行目を分け合うが、その行の印は最初の項目だけが読む (入れ物は読まない。最後の関門 B-107 / B-135)
const LISTS_BODY = ['# Root', '', '- Task A', '- Task B', '', '1. Step', '2. Next', ''];
const DOC_LISTS = docWith(EDIT, LISTS_BODY);
const LISTS_TASK_A = 3;
const LISTS_TASK_B = 4;
const LISTS_NEXT = 7;
// Task A だけをまとめた文書。Task A の 1 行目の末尾に %group1
const DOC_LISTS_A = docWith(EDIT, marked(LISTS_BODY, { '- Task A': '%group1' }), [], NEW_GROUPS);

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
        target.keyLog = [];
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
        // 図の強調 (selectGroup) が、どのグループに掛かったかを view の受け口で控える
        const keys: Array<string | null> = [];
        target.groupKeys.a = keys;
        editor.view.addHooks({
            onSelectGroup: (id) => {
                keys.push(id);
            },
        });
        // G のキーの押下を、編集の層のあとに window で控える (ブラウザの検索より先に受けて、既定の動きを止めたか)
        const listener = (event: KeyboardEvent): void => {
            if (event.key.toLowerCase() === 'g') target.keyLog.push({ key: event.key, prevented: event.defaultPrevented });
        };
        window.addEventListener('keydown', listener);
        target.unlistenKeys = () => window.removeEventListener('keydown', listener);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知を初めの状態に戻す)。onChange、onSelectionChange、キーの記録も空にする
async function remount(page: Page, markdown: string): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.unlistenKeys?.();
        target.editors.a?.destroy();
        target.changes = [];
        target.selections = [];
        target.keyLog = [];
    });
    await mount(page, markdown);
}

// 「変わらない」「呼ばれない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const selectionLog = (page: Page): Promise<EditorSelection[]> => page.evaluate(() => (window as unknown as EditorWindow).selections.map((entry) => entry.selection));

const keyLog = (page: Page): Promise<KeyEntry[]> => page.evaluate(() => (window as unknown as EditorWindow).keyLog);

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());

const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const callUndo = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo());

// view の onSelectGroup に最後に届いたグループ (届いていなければ undefined)
const lastGroupKey = (page: Page): Promise<string | null | undefined> => page.evaluate(() => (window as unknown as EditorWindow).groupKeys.a?.at(-1));

interface GroupRow {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
}

interface GroupModel {
    groups: GroupRow[];
    // グループに入っているノードとそのグループ (id の昇順。どこにも入っていないノードは除く)
    members: Array<[number, string[]]>;
}

// 描いている文書のモデルの groups と groupsOf
const groupModelOf = (page: Page): Promise<GroupModel> =>
    page.evaluate(() => {
        const model = (window as unknown as EditorWindow).editors.a?.view.getDocument()?.model;
        if (!model) return { groups: [], members: [] };
        return {
            groups: model.groups.map(({ id, label, color, boundary }) => ({ id, label, color, boundary })),
            members: [...model.groupsOf]
                .filter(([, ids]) => ids.length > 0)
                .map(([id, ids]): [number, string[]] => [id, [...ids]])
                .sort((a, b) => a[0] - b[0]),
        };
    });

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const bars = (page: Page) => visible(page, '#a .mdag-editor-bar');
const marquees = (page: Page) => visible(page, '#a .mdag-editor-marquee');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const frameSelector = (group: string): string => `#a .mdag-frame[data-group="${group}"]`;
const frameLabelSelector = (group: string): string => `#a .mdag-frame-label[data-group="${group}"]`;
const frames = (page: Page, group: string) => page.locator(frameSelector(group));

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

// 帯が相手の上にある (重ならず、相手の左右の中ほどに掛かる)
const isAbove = (bar: Box, target: Box): boolean => bar.bottom <= target.top + 1 && bar.left <= (target.left + target.right) / 2 && bar.right >= (target.left + target.right) / 2;
// 帯が相手の下にある
const isBelow = (bar: Box, target: Box): boolean => bar.top >= target.bottom - 1 && bar.left <= (target.left + target.right) / 2 && bar.right >= (target.left + target.right) / 2;

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

// 枠の内側 (ノードと線のない所) の押せる点
const framePoint = (page: Page, group: string): Promise<Point> => spot(page, { on: 'element', selector: frameSelector(group) });
// 枠のラベルの押せる点 (帯などが重なっている所は除く)
const frameLabelPoint = (page: Page, group: string): Promise<Point> => spot(page, { on: 'element', selector: frameLabelSelector(group) });

// 枠の内側で、そこから (dx, dy) だけ動かした点も枠の内側になる点 (押してから少し動かして離しても、押した相手が枠のままの点)
async function framePointWithRoom(page: Page, group: string, dx: number, dy: number): Promise<Point> {
    const found = await page.evaluate(
        ({ selector, dx, dy }) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const onFrame = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2 && document.elementFromPoint(x, y) === element;
            const points: Array<{ x: number; y: number }> = [];
            for (let y = rect.top + 4; y < rect.bottom; y += 4) for (let x = rect.left + 4; x < rect.right; x += 4) points.push({ x, y });
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
            return points.find((point) => onFrame(point.x, point.y) && onFrame(point.x + dx, point.y + dy) && onFrame(point.x + dx / 2, point.y + dy / 2)) ?? null;
        },
        { selector: frameSelector(group), dx, dy },
    );
    if (!found) throw new Error(`グループ ${group} の枠の内側に、(${dx}, ${dy}) 動かしても枠の上の点がない`);
    return found;
}

async function pressFrame(page: Page, group: string): Promise<void> {
    await press(page, await framePoint(page, group));
}

async function pressFrameLabel(page: Page, group: string): Promise<void> {
    await press(page, await frameLabelPoint(page, group));
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
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

// 矩形の中にかかるノード (箱が一部でも重なるもの) の id
async function nodesHitBy(page: Page, from: Point, to: Point): Promise<number[]> {
    return page.evaluate(
        ({ from, to }) => {
            const container = document.getElementById('a');
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
        { from, to },
    );
}

// from から始めて、ルートでないノードに 1 つ以上かかる矩形の終わりの点を探す (図の領域の中)
async function dragEndFrom(page: Page, from: Point): Promise<{ to: Point; hits: number[] }> {
    for (const [dx, dy] of [
        [170, 130],
        [-170, 130],
        [170, -130],
        [-170, -130],
        [260, 60],
        [-260, 60],
    ] as const) {
        const to = { x: Math.min(990, Math.max(10, from.x + dx)), y: Math.min(590, Math.max(10, from.y + dy)) };
        const hits = (await nodesHitBy(page, from, to)).filter((id) => id !== ROOT);
        if (hits.length > 0) return { to, hits };
    }
    throw new Error(`(${from.x}, ${from.y}) から始めてノードにかかる矩形がない`);
}

const target = (id: number): NodeTarget => ({ id, refText: REF_TEXTS[id] ?? '' });

const sortedTargets = (targets: readonly NodeTarget[]): NodeTarget[] => [...targets].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText }));

// 選択をそろえた形 (ノードは id の昇順。ほかはそのまま)
function normalized(selection: EditorSelection): EditorSelection {
    return selection.kind === 'nodes' ? { kind: 'nodes', nodes: sortedTargets(selection.nodes) } : selection;
}

interface SelectionState {
    // data-selected の付いたノードの id (昇順)
    marked: number[];
    // 強調から外れた (data-faded の付いた) ノードの id (昇順)
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

// 選んでいるノードが ids になるまで待つ (図の印と getSelection の両方。グループの強調はない)
async function expectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const sorted = sortedTargets(ids.map(target));
    const selection: EditSelection = sorted.length === 0 ? { kind: 'none' } : { kind: 'nodes', nodes: sorted };
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: sorted.map((item) => item.id), faded: [], selection });
}

// 何も選んでいない (ノードの印もグループの強調もない) まで待つ
async function expectNothingSelected(page: Page, message?: string): Promise<void> {
    await expect.poll(() => selectionOf(page), message).toEqual({ marked: [], faded: [], selection: { kind: 'none' } });
}

// グループが選ばれるまで待つ: getSelection がそのグループ、view の selectGroup がそのグループ (onSelectGroup に最後に届いた id)、
// ノードの印はなく、図の強調でメンバーは薄くならず、outsider (グループの外で線でもつながらないノード) は薄くなる
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

interface BarInfo {
    // data-for (node、nodes、group)
    for: string | null;
    // 見えている帯の中身の並び (title は名前や数の欄、ほかは data-command。区切りは除く)
    items: string[];
    // 押せないボタンの data-command
    disabled: string[];
    title: string;
    rect: Box;
}

// 見えている操作の帯
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

// グループの帯が 1 つだけ見えていて、中身が 名前の欄、名前、グループ解除 (どれも押せる)、名前の欄に label が入り、
// 相手 (枠か、枠がなければメンバーの全体) の上か下にあるまで待つ
async function expectGroupBar(page: Page, label: string, area: () => Promise<Box>, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const shown = await barsOf(page);
            const bar = shown[0];
            if (shown.length !== 1 || !bar) return { count: shown.length };
            const target = await area();
            return { count: 1, for: bar.for, items: bar.items, disabled: bar.disabled, titled: bar.title.includes(label), placed: isAbove(bar.rect, target) || isBelow(bar.rect, target) };
        }, message)
        .toEqual({ count: 1, for: 'group', items: ['title', 'rename-group', 'ungroup'], disabled: [], titled: true, placed: true });
}

// 枠の矩形 (画面の座標)
async function frameBox(page: Page, group: string): Promise<Box> {
    const [box] = await rectsOf(page, frameSelector(group));
    if (!box) throw new Error(`グループ ${group} の枠がない`);
    return box;
}

interface NameInputState {
    // 見えているグループの名前の入力 (.mdag-editor-name-input[data-for="group"]) の数
    count: number;
    value: string | null;
    focused: boolean;
    rect: Box | null;
}

// グループの名前の入力。要素そのものが入力欄 (input、textarea、contenteditable) でも、その中に入力欄があってもよい
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

// 枠のラベルの矩形。名前の入力を重ねている間もラベルの要素の矩形を読む (見え方によらない)
async function frameLabelBox(page: Page, group: string): Promise<Box | null> {
    return page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    }, frameLabelSelector(group));
}

// グループの名前の入力が枠のラベルの上に 1 つ開き、フォーカスがあって、値が value になるまで待つ。
// 「ラベルの上」は、入力の矩形が枠のラベルの矩形と左右で重なり、入力の上下の中ほどがラベルの上下の範囲 (4px まで) にあること
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

// グループの名前の入力が閉じるまで待つ
async function expectGroupInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await groupInputOf(page)).count, message).toBe(0);
}

// グループの名前の入力が開いていない (数コマ待ってから)
async function expectNoGroupInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await groupInputOf(page)).count, message).toBe(0);
}

// 名前の入力の値を全部選んで text を打つ (初めの選び方は決めていないので、全部を選んでから打つ)
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await expect.poll(async () => (await groupInputOf(page)).value).toBe(text);
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

const reasonOf = (outcome: EditOutcome): { code: string; message: string } | null => (outcome.status === 'edited' || !outcome.reason ? null : { code: outcome.reason.code, message: outcome.reason.message });

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

// 強調の見た目 (線、縁取り、ノード、枠の薄さと太さ、図の要素の目印)。groupHighlight が true の文書と false の文書を比べるのに使う
async function highlightLook(page: Page): Promise<unknown> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const styles = (selector: string, keyOf: (element: SVGElement | HTMLElement) => string) =>
            [...container.querySelectorAll<SVGElement | HTMLElement>(selector)].map((element) => `${keyOf(element)} opacity=${element.style.opacity} width=${element.style.strokeWidth}`).sort();
        return {
            edgeSelected: container.hasAttribute('data-edge-selected'),
            edges: styles('path.mdag-edge, path.mdag-edge-casing', (element) => `${element.getAttribute('class')} ${element.dataset.key}`),
            underlines: styles('.mdag-underline', (element) => `u${element.dataset.id}`),
            folds: styles('.mdag-fold', (element) => `f${element.dataset.id}`),
            nodes: [...container.querySelectorAll<HTMLElement>('.mdag-node')].map((element) => `${element.dataset.id} faded=${String(element.hasAttribute('data-faded'))} opacity=${element.style.opacity}`),
            frames: [...container.querySelectorAll<SVGElement>('.mdag-frames > *')].map((element) => `${element.getAttribute('class')} opacity=${element.style.opacity}`),
        };
    });
}

const GROUP1_ROW: GroupRow = { id: NEW_ID, label: NEW_LABEL, color: NEW_COLOR, boundary: true };

test.describe('まとめる (段 18。B-046、B-106〜B-111、3.4 の groupNodes)', () => {
    test('@editor 2 つを選んで ⌘G、Ctrl+G、複数選択の帯の「グループ」、道具箱の「グループ」のどれでも、1 行目の末尾に %group1 を付け、markdag.groups に label、color、boundary: true の定義を足す。onChange 1 回、枠が出てグループが選ばれ (getSelection、onSelectionChange、図の強調)、名前の入力が「グループ 1」で枠のラベルの上に開き (フォーカスあり)、通知 (info) が出る。⌘G と Ctrl+G はブラウザの検索より先に受ける (既定の動きを止める)。元に戻すで戻る (B-046、B-106〜B-110)', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        await open(page);
        // 空振りの防ぎ: 期待の原文は書き換えの層の結果と同じ
        expect(editedSource(await tryEdit(page, DOC, { kind: 'groupNodes', nodes: [target(TASK_A), target(TASK_B)] }))).toBe(DOC_AB);

        const triggers = ['⌘G', 'Ctrl+G', '帯のグループ', '道具箱のグループ'] as const;
        for (const [index, trigger] of triggers.entries()) {
            if (index === 0) await mount(page, DOC);
            else await remount(page, DOC);
            await useSelectTool(page);
            await pressNode(page, TASK_A);
            await pressNodeWith(page, TASK_B, 'Shift');
            await expectNodes(page, [TASK_A, TASK_B], trigger);
            await expect(frames(page, NEW_ID), trigger).toHaveCount(0);

            if (trigger === '⌘G') await page.keyboard.press('Meta+KeyG');
            else if (trigger === 'Ctrl+G') await page.keyboard.press('Control+KeyG');
            else if (trigger === '帯のグループ') await pressBar(page, 'group');
            else await toolButton(page, 'group').click();

            await expectSource(page, DOC_AB, [DOC_AB], trigger);
            await expect.poll(() => groupModelOf(page), trigger).toEqual({ groups: [GROUP1_ROW], members: [[TASK_A, [NEW_ID]], [TASK_B, [NEW_ID]]] });
            await expect(frames(page, NEW_ID), trigger).toHaveCount(1);
            await expectGroupSelected(page, NEW_ID, [TASK_A, TASK_B], LEAF, trigger);
            await expect.poll(() => lastSelectionChange(page), trigger).toEqual({ kind: 'group', id: NEW_ID });
            await expectGroupInputOnLabel(page, NEW_ID, NEW_LABEL, trigger);
            await expectNotice(page, 'info', trigger);
            if (trigger === '⌘G' || trigger === 'Ctrl+G') expect((await keyLog(page)).map((entry) => entry.prevented), trigger).toEqual([true]);

            // 名前を変えずにフォーカスを外へ移すと、入力は閉じて原文は変わらない。そのあと元に戻す
            await focusOutside(page);
            await expectGroupInputClosed(page, trigger);
            await expectSourceStill(page, DOC_AB, [DOC_AB], `${trigger}: 名前を変えずに決める`);
            expect(await callUndo(page), trigger).toBe(true);
            await expectSource(page, DOC, [DOC_AB, DOC], `${trigger} の元に戻す`);
            await expect(frames(page, NEW_ID), `${trigger} の元に戻す`).toHaveCount(0);
            await expect.poll(() => groupModelOf(page), `${trigger} の元に戻す`).toEqual({ groups: [], members: [] });
        }
        expect(errors).toEqual([]);
    });

    // 期待を変えた (メンバーが 1 つのグループも枠にする)。
    // 前は枠が描かれず、名前の入力と帯はメンバー (Leaf) の上か下だった。枠のないグループの名前の入力は凡例のパネルのテストの「枠を隠したグループの名前」が見る
    test('@editor 子のない項目 1 つだけを ⌘G でまとめると、そのノードを囲む枠が描かれ、グループが選ばれ、名前の入力がその枠のラベルの上に開く。文字を入れて Enter で名前が決まり、グループを選んだまま帯が枠の上か下に出る。Enter でまた名前の入力が枠のラベルの上に開く (B-106、B-110、B-113、B-114、F-02)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        expect(editedSource(await tryEdit(page, DOC, { kind: 'groupNodes', nodes: [target(LEAF)] }))).toBe(DOC_LEAF);
        expect(editedSource(await tryEdit(page, DOC_LEAF, { kind: 'renameGroup', group: NEW_ID, label: '公開' }))).toBe(DOC_LEAF_NAMED);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, LEAF);
        await expectNodes(page, [LEAF]);

        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, DOC_LEAF, [DOC_LEAF]);
        await expect.poll(() => groupModelOf(page)).toEqual({ groups: [GROUP1_ROW], members: [[LEAF, [NEW_ID]]] });
        await expectGroupSelected(page, NEW_ID, [LEAF], TASK_A);
        // メンバーが 1 つでも Leaf を囲む枠が 1 つ描かれ、名前の入力はその枠のラベルの上に開く
        await expect(frames(page, NEW_ID)).toHaveCount(1);
        await expectGroupInputOnLabel(page, NEW_ID, NEW_LABEL);
        const leaf = await nodeBox(page, LEAF);
        const frame = await frameBox(page, NEW_ID);
        expect(frame.left <= leaf.left && frame.top <= leaf.top && frame.right >= leaf.right && frame.bottom >= leaf.bottom, 'Leaf の箱が枠の中').toBe(true);

        await replaceName(page, '公開');
        await page.keyboard.press('Enter');
        await expectSource(page, DOC_LEAF_NAMED, [DOC_LEAF, DOC_LEAF_NAMED]);
        await expectGroupInputClosed(page);
        await expect.poll(() => groupModelOf(page)).toEqual({ groups: [{ ...GROUP1_ROW, label: '公開' }], members: [[LEAF, [NEW_ID]]] });
        await expectGroupSelected(page, NEW_ID, [LEAF], TASK_A, '名前を決めたあと');
        await expectGroupBar(page, '公開', () => frameBox(page, NEW_ID), '名前を決めたあと');

        // Enter で枠のラベルの上に名前の入力が開く。Esc で変えずに閉じる
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, NEW_ID, '公開', 'Enter');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, 'Esc');
        await expectSourceStill(page, DOC_LEAF_NAMED, [DOC_LEAF, DOC_LEAF_NAMED]);
        expect(errors).toEqual([]);
    });

    test('@editor 何も選んでいなければ、⌘G でも道具箱の「グループ」でもまとめずに、囲んで選ぶよう案内の通知 (info) を出す。原文、onChange、履歴は変わらず、名前の入力は開かない (B-111)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await expectNothingSelected(page);

        await pointerOverBlank(page);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectNotice(page, 'info', '⌘G');
        await expectSourceStill(page, DOC, [], '⌘G');
        await expectNoGroupInput(page, '⌘G');
        await expectNoticeGone(page);

        await toolButton(page, 'group').click();
        await expectNotice(page, 'info', '道具箱のグループ');
        await expectSourceStill(page, DOC, [], '道具箱のグループ');
        await expectNoGroupInput(page, '道具箱のグループ');
        await expect(page.locator('#a .mdag-frame')).toHaveCount(0);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor 下線の見出しを含めてまとめると (1 つの ⌘G と、2 つの帯の「グループ」)、見出しを同じ段の ATX の見出し (## Design) に書き直して %group1 を付け、枠が出てグループが選ばれ、名前の入力が「グループ 1」で開き、通知 (info) が出る。履歴に積む (B-05、3.2、3.4 の groupNodes、D-048)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        // 空振りの防ぎ: 期待の原文は書き換えの層の結果と同じ
        expect(editedSource(await tryEdit(page, DOC_SETEXT, { kind: 'groupNodes', nodes: [{ id: SETEXT_DESIGN, refText: 'Design' }] }))).toBe(DOC_SETEXT_DESIGN);
        expect(editedSource(await tryEdit(page, DOC_SETEXT, { kind: 'groupNodes', nodes: [{ id: SETEXT_DESIGN, refText: 'Design' }, { id: SETEXT_BUILD, refText: 'Build' }] }))).toBe(DOC_SETEXT_BOTH);
        await mount(page, DOC_SETEXT);
        await useSelectTool(page);

        await pressNode(page, SETEXT_DESIGN);
        await expect(page.locator(`${nodeSelector(SETEXT_DESIGN)}[data-selected]`)).toHaveCount(1);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, DOC_SETEXT_DESIGN, [DOC_SETEXT_DESIGN], '1 つの ⌘G');
        await expect.poll(() => groupModelOf(page), '1 つの ⌘G').toEqual({ groups: [GROUP1_ROW], members: [[SETEXT_DESIGN, [NEW_ID]], [SETEXT_TASK_A, [NEW_ID]]] });
        await expect(frames(page, NEW_ID), '1 つの ⌘G').toHaveCount(1);
        await expectGroupSelected(page, NEW_ID, [SETEXT_DESIGN, SETEXT_TASK_A], SETEXT_LEAF, '1 つの ⌘G');
        await expectGroupInputOnLabel(page, NEW_ID, NEW_LABEL, '1 つの ⌘G');
        await expectNotice(page, 'info', '1 つの ⌘G');
        await expect(toolButton(page, 'undo')).toBeEnabled();

        await remount(page, DOC_SETEXT);
        await useSelectTool(page);
        await pressNode(page, SETEXT_DESIGN);
        await pressNodeWith(page, SETEXT_BUILD, 'Shift');
        await expect(page.locator('#a .mdag-node[data-selected]')).toHaveCount(2);
        await pressBar(page, 'group');
        await expectSource(page, DOC_SETEXT_BOTH, [DOC_SETEXT_BOTH], '2 つの帯のグループ');
        await expect(frames(page, NEW_ID), '2 つの帯のグループ').not.toHaveCount(0);
        await expectGroupInputOnLabel(page, NEW_ID, NEW_LABEL, '2 つの帯のグループ');
        await expectNotice(page, 'info', '2 つの帯のグループ');
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('リストの入れ物と 1 行目を分け合う最初の項目をまとめる (段 18。G-016、最後の関門 B-107 / B-135)', () => {
    test('@editor リストの入れ物と 1 行目を分け合う最初の項目だけを ⌘G でまとめると、その項目の 1 行目の末尾に %group1 を付けて markdag.groups に定義を足し (onChange 1 回)、枠はその項目だけを囲み (入れ物と 2 つ目の項目はグループに入らない)、グループが選ばれて名前の入力が「グループ 1」で開き、通知 (info) が出る (B-107、B-002)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        // 空振りの防ぎ: 期待の原文は書き換えの層の結果と同じ
        expect(editedSource(await tryEdit(page, DOC_LISTS, { kind: 'groupNodes', nodes: [{ id: LISTS_TASK_A, refText: 'Task A' }] }))).toBe(DOC_LISTS_A);
        await mount(page, DOC_LISTS);
        await useSelectTool(page);
        await pressNode(page, LISTS_TASK_A);
        await expect(page.locator(`${nodeSelector(LISTS_TASK_A)}[data-selected]`)).toHaveCount(1);

        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, DOC_LISTS_A, [DOC_LISTS_A]);
        await expect.poll(() => groupModelOf(page)).toEqual({ groups: [GROUP1_ROW], members: [[LISTS_TASK_A, [NEW_ID]]] });
        await expect(frames(page, NEW_ID)).toHaveCount(1);
        await expectGroupSelected(page, NEW_ID, [LISTS_TASK_A], LISTS_NEXT);
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'group', id: NEW_ID });
        await expectGroupInputOnLabel(page, NEW_ID, NEW_LABEL);
        await expectNotice(page, 'info');

        const frame = await frameBox(page, NEW_ID);
        const taskA = await nodeBox(page, LISTS_TASK_A);
        const taskB = await nodeBox(page, LISTS_TASK_B);
        expect(frame.left <= taskA.left && frame.top <= taskA.top && frame.right >= taskA.right && frame.bottom >= taskA.bottom, 'Task A の箱が枠の中').toBe(true);
        const apart = frame.right <= taskB.left + 0.5 || taskB.right <= frame.left + 0.5 || frame.bottom <= taskB.top + 0.5 || taskB.bottom <= frame.top + 0.5;
        expect(apart, 'Task B の箱は枠と重ならない').toBe(true);
        await expect(toolButton(page, 'undo')).toBeEnabled();
        expect(errors).toEqual([]);
    });
});

test.describe('グループを選ぶ (段 18。B-112、A-13、B-13、5.2 の軸 C、10.1 の 3)', () => {
    test('@editor 選択の道具で枠を押すとグループが選ばれ (getSelection、onSelectionChange、図の強調)、グループの帯が出る。同じ枠をもう 1 度押すと解ける。枠のラベルでも同じ。原文は変わらない (B-112)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);
        await expect(frames(page, 'design')).toHaveCount(1);
        await expect(frames(page, 'build')).toHaveCount(1);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '枠');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'group', id: 'design' });
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]')).toHaveCount(1);
        await pressFrame(page, 'design');
        await expectNothingSelected(page, '同じ枠をもう 1 度');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expect(bars(page), '同じ枠をもう 1 度').toHaveCount(0);

        await pressFrameLabel(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'ラベル');
        await pressFrameLabel(page, 'design');
        await expectNothingSelected(page, '同じラベルをもう 1 度');
        await expectSourceStill(page, DOC_GROUPS, []);
        await expectNoGroupInput(page);
        expect(errors).toEqual([]);
    });

    test('@editor ノードを選んでいるときに枠を押すとグループに替わり (ノードの印と帯が替わる)、別の枠を押すと別のグループに替わる。グループを選んでいるときにノードを押すとそのノード 1 つになり (強調が外れる)、何もないところを押すか Esc で解ける (5.2 の軸 C)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);

        await pressNode(page, TASK_A);
        await expectNodes(page, [TASK_A]);
        await expect(visible(page, '#a .mdag-editor-bar[data-for="node"]')).toHaveCount(1);
        await pressFrame(page, 'build');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A, 'ノードから枠');
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]'), 'ノードから枠').toHaveCount(1);
        await expect(visible(page, '#a .mdag-editor-bar[data-for="node"]'), 'ノードから枠').toHaveCount(0);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '別の枠');

        await pressNode(page, LEAF);
        await expectNodes(page, [LEAF], '枠からノード');
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]'), '枠からノード').toHaveCount(0);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '何もないところの前');
        await pressBlank(page);
        await expectNothingSelected(page, '何もないところ');
        await expect(bars(page), '何もないところ').toHaveCount(0);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'Esc の前');
        await page.keyboard.press('Escape');
        await expectNothingSelected(page, 'Esc');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expectSourceStill(page, DOC_GROUPS, []);
    });

    test('@editor 手のひらでは枠とラベルを押してもグループを選ばない (選択、図の強調、帯がない)。選択の道具に替えると選べる (B-112、10.2 の B-112)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS);
        // 最初の道具は選択なので、道具箱で手のひらにする
        await toolButton(page, 'hand').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');

        await pressFrame(page, 'design');
        await settle(page);
        await expectNothingSelected(page, '手のひらで枠');
        await expect(bars(page), '手のひらで枠').toHaveCount(0);
        await pressFrameLabel(page, 'design');
        await settle(page);
        await expectNothingSelected(page, '手のひらでラベル');
        await expect(bars(page), '手のひらでラベル').toHaveCount(0);
        expect(await selectionLog(page)).toEqual([]);

        // 空振りの防ぎ: 選択の道具では同じ枠で選べる
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);
        await expectSourceStill(page, DOC_GROUPS, []);
    });

    test('@editor 選択の道具で枠の内側を押して 4px 未満で離すとグループを選び、4px 以上動かすとグループを選ばずに矩形選択になって、かかったノードが選ばれる (B-112、A-13、B-13)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);

        const from = await framePointWithRoom(page, 'design', 2, 1);
        await dragFrom(page, from, { x: from.x + 2, y: from.y + 1 });
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '2px');
        await page.keyboard.press('Escape');
        await expectNothingSelected(page, 'Esc');

        const start = await framePoint(page, 'design');
        const { to, hits } = await dragEndFrom(page, start);
        await dragFrom(page, start, to, () => expect(marquees(page), 'ドラッグの途中の矩形').toHaveCount(1));
        await expect(marquees(page)).toHaveCount(0);
        await expectNodes(page, hits, '矩形');
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]')).toHaveCount(0);
        await expectSourceStill(page, DOC_GROUPS, []);
    });

    test('@editor groupHighlight: false の文書でも、GUI 編集では枠を押してグループを選べ、選んでいる間の図の強調は groupHighlight: true の文書と同じ (10.1 の 3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS_ON);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'true の文書');
        const look = await highlightLook(page);

        await remount(page, DOC_GROUPS_OFF);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'false の文書');
        await expect.poll(() => highlightLook(page)).toEqual(look);
        await expect(visible(page, '#a .mdag-editor-bar[data-for="group"]')).toHaveCount(1);
        await expectSourceStill(page, DOC_GROUPS_OFF, []);
    });
});

test.describe('グループの帯 (段 18。B-113、6.3、6.5)', () => {
    test('@editor グループを選ぶと、帯 (data-for="group") が 1 つ、枠の上か下に出て、中身はグループの名前の欄、「名前」(rename-group)、「グループ解除」(ungroup)。別のグループを選ぶと名前の欄が替わる (B-113)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);
        await expectGroupBar(page, '設計', () => frameBox(page, 'design'), 'design');

        await pressFrame(page, 'build');
        await expectGroupSelected(page, 'build', BUILD_MEMBERS, TASK_A);
        await expectGroupBar(page, '実装', () => frameBox(page, 'build'), 'build');
        await expectSourceStill(page, DOC_GROUPS, []);
    });
});

test.describe('グループの名前の入力 (段 18。B-051、B-114、B-115、B-15、5.2 の軸 D、5.3)', () => {
    test('@editor グループを選んで Enter か帯の「名前」で、名前の入力が今の名前で枠のラベルの上に開く (フォーカスあり)。枠の内側とラベルのダブルクリックでも、グループが選ばれて同じく開く。Esc で変えずに閉じる (B-051、B-114)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);

        // Enter
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'Enter の前');
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計', 'Enter');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, 'Enter のあとの Esc');
        await pressBlank(page);
        await expectNothingSelected(page, 'Enter のあと');

        // 帯の「名前」
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '帯の名前の前');
        await pressBar(page, 'rename-group');
        await expectGroupInputOnLabel(page, 'design', '設計', '帯の名前');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, '帯の名前のあとの Esc');
        await pressBlank(page);
        await expectNothingSelected(page, '帯の名前のあと');

        // 枠の内側のダブルクリック (何も選んでいないところから)
        const inside = await framePoint(page, 'design');
        await page.mouse.dblclick(inside.x, inside.y);
        await expectGroupInputOnLabel(page, 'design', '設計', '枠のダブルクリック');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '枠のダブルクリック');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, '枠のダブルクリックのあとの Esc');
        await pressBlank(page);
        await expectNothingSelected(page, '枠のダブルクリックのあと');

        // ラベルのダブルクリック。押す点は、グループを選んで帯が出ている間も帯に隠れないラベルの点にする
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'ラベルの点を探す');
        const label = await frameLabelPoint(page, 'design');
        await pressBlank(page);
        await expectNothingSelected(page, 'ラベルのダブルクリックの前');
        await page.mouse.dblclick(label.x, label.y);
        await expectGroupInputOnLabel(page, 'design', '設計', 'ラベルのダブルクリック');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'ラベルのダブルクリック');
        await page.keyboard.press('Escape');
        await expectGroupInputClosed(page, 'ラベルのダブルクリックのあとの Esc');

        await expectSourceStill(page, DOC_GROUPS, []);
        await expect(toolButton(page, 'undo')).toBeDisabled();
        expect(errors).toEqual([]);
    });

    test('@editor 名前の入力で名前を変えて Enter で決めると、markdag.groups の label だけを書き換え (onChange 1 回)、枠のラベルとモデルの名前が替わり、グループは選んだまま、通知 (info) が出る。YAML でそのまま書けない名前は引用符で囲み、フォーカスが外へ移っても決める。元に戻すで 1 つずつ戻る (B-115、5.2 の軸 D)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_GROUPS, { kind: 'renameGroup', group: 'design', label: '設計の範囲' }))).toBe(DOC_RENAMED);
        expect(editedSource(await tryEdit(page, DOC_RENAMED, { kind: 'renameGroup', group: 'design', label: '設計: 画面' }))).toBe(DOC_RENAMED_QUOTED);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);

        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計');
        await replaceName(page, '設計の範囲');
        await page.keyboard.press('Enter');
        await expectSource(page, DOC_RENAMED, [DOC_RENAMED], 'Enter で決める');
        await expectGroupInputClosed(page, 'Enter で決める');
        await expect.poll(async () => (await groupModelOf(page)).groups.find((group) => group.id === 'design')?.label).toBe('設計の範囲');
        await expect(page.locator(frameLabelSelector('design'))).toHaveText('設計の範囲');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, 'Enter で決めたあと');
        await expectNotice(page, 'info', 'Enter で決める');

        // 帯が凡例のパネル (右上) の下に入っていれば、帯の上の辺がパネルの下の辺より 8px 下になるまで図を下へずらす (図を触って直したときに足した手順。
        // 全体表示は道具箱を避けて右へ寄り、凡例のパネルは避けないので、design の枠の上の帯の「名前」がパネルの下に入る。
        // 確かめることと期待は変えていない)
        const coveredBy = await page.evaluate(() => {
            const shown = (selector: string) => [...document.querySelectorAll(selector)].find((element) => element.checkVisibility())?.getBoundingClientRect();
            const bar = shown('#a .mdag-editor-bar');
            const panel = shown('#a .mdag-editor-legend');
            if (!bar || !panel) return 0;
            return bar.left < panel.right && bar.right > panel.left && bar.top < panel.bottom + 8 ? panel.bottom + 8 - bar.top : 0;
        });
        if (coveredBy > 0) await page.evaluate((dy) => (window as unknown as EditorWindow).editors.a?.view.panBy(0, dy), coveredBy);
        await settle(page);
        await pressBar(page, 'rename-group');
        await expectGroupInputOnLabel(page, 'design', '設計の範囲', '帯の名前');
        await replaceName(page, '設計: 画面');
        await focusOutside(page);
        await expectSource(page, DOC_RENAMED_QUOTED, [DOC_RENAMED, DOC_RENAMED_QUOTED], 'フォーカスが外へ');
        await expectGroupInputClosed(page, 'フォーカスが外へ');
        await expect.poll(async () => (await groupModelOf(page)).groups.find((group) => group.id === 'design')?.label).toBe('設計: 画面');

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_RENAMED, [DOC_RENAMED, DOC_RENAMED_QUOTED, DOC_RENAMED], '元に戻す 1');
        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_GROUPS, [DOC_RENAMED, DOC_RENAMED_QUOTED, DOC_RENAMED, DOC_GROUPS], '元に戻す 2');
        await expect(page.locator(frameLabelSelector('design'))).toHaveText('設計');
        expect(errors).toEqual([]);
    });

    test('@editor 同じ名前のまま Enter では原文を変えない。空の名前で Enter は原文を変えず、理由 (group-label-empty の EditReason.message) の通知 (error) を出し、履歴に積まない (B-115)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const reason = reasonOf(await tryEdit(page, DOC_GROUPS, { kind: 'renameGroup', group: 'design', label: '' }));
        expect(reason?.code).toBe('group-label-empty');
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);

        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '同じ名前');
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計', '同じ名前');
        await page.keyboard.press('Enter');
        await expectSourceStill(page, DOC_GROUPS, [], '同じ名前');
        await expect(toolButton(page, 'undo'), '同じ名前').toBeDisabled();

        await remount(page, DOC_GROUPS);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF, '空の名前');
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計', '空の名前');
        await replaceName(page, '');
        await page.keyboard.press('Enter');
        const text = await expectNotice(page, 'error', '空の名前');
        expect(text).toContain(flat(reason?.message ?? ''));
        await expectSourceStill(page, DOC_GROUPS, [], '空の名前');
        expect((await groupModelOf(page)).groups.find((group) => group.id === 'design')?.label).toBe('設計');
        await expect(page.locator(frameLabelSelector('design'))).toHaveText('設計');
        await expect(toolButton(page, 'undo'), '空の名前').toBeDisabled();
    });

    test('@editor 変換中 (isComposing か keyCode 229) の Enter と Esc は、グループの名前の入力の操作にならない: 決めず、閉じない。変換を確定したあとの Enter で決める (B-15、5.2 の軸 D)', async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', '変換は Chromium の CDP (Input.imeSetComposition) で起こす');
        await open(page);
        const named = docWith(EDIT, GROUPED_BODY, groupsWith('設計案'));
        expect(editedSource(await tryEdit(page, DOC_GROUPS, { kind: 'renameGroup', group: 'design', label: '設計案' }))).toBe(named);
        await mount(page, DOC_GROUPS);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計');
        await page.keyboard.press('ControlOrMeta+KeyA');

        const client = await page.context().newCDPSession(page);
        try {
            // 全部を選んだ名前を、変換中の文字で置き換える (compositionstart が届く)
            await client.send('Input.imeSetComposition', { text: 'せっけい', selectionStart: 4, selectionEnd: 4 });
            await expect.poll(async () => (await groupInputOf(page)).value).toBe('せっけい');
            // IME が送る形 (keyCode 229、isComposing true) と、keyCode のある形 (isComposing true) の両方
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await page.keyboard.press('Enter');
            await page.keyboard.press('Escape');
            await expectSourceStill(page, DOC_GROUPS, [], '変換中');
            await expectGroupInputOnLabel(page, 'design', 'せっけい', '変換中');

            // 変換を確定する (compositionend が届く)
            await client.send('Input.insertText', { text: '設計案' });
            await expect.poll(async () => (await groupInputOf(page)).value).toBe('設計案');
            // 変換を確定したキーが確定のあとに keyCode 229 で届く形 (isComposing false) も無視する
            await pressComposing(client, 'Enter');
            await pressComposing(client, 'Escape');
            await expectSourceStill(page, DOC_GROUPS, [], '確定のあとの keyCode 229');
            await expectGroupInputOnLabel(page, 'design', '設計案', '確定のあとの keyCode 229');
        } finally {
            await client.detach();
        }

        await page.keyboard.press('Enter');
        await expectSource(page, named, [named]);
        await expectGroupInputClosed(page);
    });
});

test.describe('グループ解除 (段 18。B-116、3.4 の ungroup)', () => {
    test('@editor 帯の「グループ解除」で、ノードの 1 行目の印と markdag.groups の定義を外し、空になった groups のキーも外す (ノードは残る)。onChange 1 回、枠が消え、選択が解け (帯と強調もなくなる)、通知 (info) が出る。元に戻すで戻る (B-116)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_ONE_GROUP, { kind: 'ungroup', group: 'design' }))).toBe(DOC);
        await mount(page, DOC_ONE_GROUP);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);

        await pressBar(page, 'ungroup');
        await expectSource(page, DOC, [DOC]);
        await expect.poll(() => groupModelOf(page)).toEqual({ groups: [], members: [] });
        await expect(page.locator('#a .mdag-frame')).toHaveCount(0);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        await expectNothingSelected(page);
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expect(bars(page)).toHaveCount(0);
        await expectNotice(page, 'info');
        await expectNoGroupInput(page);

        expect(await callUndo(page)).toBe(true);
        await expectSource(page, DOC_ONE_GROUP, [DOC, DOC_ONE_GROUP], '元に戻す');
        await expect(frames(page, 'design'), '元に戻す').toHaveCount(1);
        expect(errors).toEqual([]);
    });
});

test.describe('閲覧のグループ (段 18。B-169、B-171、5.2 の軸 D、5.3)', () => {
    test('@editor 閲覧では ⌘G、枠のクリック、Enter で原文が変わらず、グループを選ばず (getSelection がない)、帯も名前の入力も出ない (閲覧だけの文書)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUPS_VIEW);
        expect(await getMode(page)).toBe('view');

        await pressNode(page, TASK_A);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSourceStill(page, DOC_GROUPS_VIEW, [], '⌘G');
        await pressFrame(page, 'design');
        await page.keyboard.press('Enter');
        await settle(page);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection())).toEqual({ kind: 'none' });
        expect(await selectionLog(page)).toEqual([]);
        await expect(bars(page)).toHaveCount(0);
        await expectNoGroupInput(page);
        await expectSourceStill(page, DOC_GROUPS_VIEW, []);
    });

    test('@editor グループの名前の入力中に閲覧へ切り替えると、入れた名前で決めて閉じる (setMode) (B-171、5.2 の軸 D の「閲覧へ」)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, DOC_GROUPS_SWITCH, { kind: 'renameGroup', group: 'design', label: '設計の範囲' }))).toBe(DOC_GROUPS_SWITCH_RENAMED);
        await mount(page, DOC_GROUPS_SWITCH);
        expect(await getMode(page)).toBe('edit');
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroupSelected(page, 'design', DESIGN_MEMBERS, LEAF);
        await page.keyboard.press('Enter');
        await expectGroupInputOnLabel(page, 'design', '設計');
        await replaceName(page, '設計の範囲');

        expect(await setMode(page, 'view')).toBe(true);
        await expectSource(page, DOC_GROUPS_SWITCH_RENAMED, [DOC_GROUPS_SWITCH_RENAMED]);
        await expectGroupInputClosed(page);
        expect(await getMode(page)).toBe('view');
        await expect(bars(page)).toHaveCount(0);
    });
});

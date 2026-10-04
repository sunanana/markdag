// 最後の関門の細部 3 (scope.md の「依頼者の回答」の「最後の関門 細部 3」(a)。records/final-apply/detail3/) を、ビルドした配布物の
// markdag/editor で、直す前に落ちるテストとして書く。
// 書き換えたあとに 2 つ以上を選び直す操作では、どの操作でも図を動かさない (ensureVisible を呼ばない。パンも開閉もしない)。
// 1 つだけのときは今と同じく見える所へ動かす。AM-07 (タグの操作とタグのパネル。e2e/final-apply-editor.spec.ts) と同じ 1 つの決まり。
// 手順は records/final-gate/am07 と detail3 と同じ (縦に長い文書、拡大、項目 1 を選ぶ、パンして項目 24 を Shift+クリック、操作)。
// 「動かない」は、表示位置 (丸めた getTransform) と開閉 (getFolded) が操作の前と同じで、項目 1 が画面の外のまま、項目 24 が見えていること。
// 2 つ以上を選び直す操作: 凡例の + (addToGroup)、グループにまとめる (groupNodes。選び直すのはグループ 1 つで、メンバーは 2 つ以上)、
// 元に戻す / やり直す (履歴から戻した選択)。タグの操作は AM-07 のテストが見る。
// まとめたときのグループの名前の入力は、図を動かさずに見えている枠のラベルの所に開く (図の領域に収まる)。見えている枠がないときだけ、今と同じく最初のメンバーを見せて開く (メインの決定)。
// 守り: 選び直すのが 1 つの操作 (1 つの + と 1 つのまとめ、2 つを消して親を選ぶ、2 つから新しい合流点へ合流させる) は今と同じく見える所へ動かす。
// 期待の原文は規則から書き、配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, NodeTarget, ViewTransform } from '../src/core';
import type { EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
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

const lines = (...items: string[]): string => items.join('\n');

// 班 (g1。枠あり) の定義。凡例のパネルにグループの行を出すため、項目 12 だけを入れておく (detail3 の文書と同じ)
const GROUP_G1 = ['    groups:', '        g1:', '            label: 班', '            color: "#3366cc"', '            boundary: true'];
// まとめたときに足す定義 (使われていない最小の group<番号>、label はグループ <番号>、色は番号の位置、枠あり)
const GROUP_NEW = ['        group1:', '            label: グループ 1', '            color: "#3B7DD8"', '            boundary: true'];

// 計画の下に 24 個の項目。ノードは 計画 1、項目 n は n + 1 (項目 1 は 2、項目 24 は 25)。marks は項目の番号ごとの行の後ろの印
const ITEM_COUNT = 24;
function longDoc(marks: Record<number, string> = {}, groups: string[] = GROUP_G1): string {
    const all: Record<number, string> = { 12: '%g1', ...marks };
    const items = Array.from({ length: ITEM_COUNT }, (_, index) => {
        const n = index + 1;
        const mark = all[n] ?? '';
        return `- 項目 ${n}${mark === '' ? '' : ` ${mark}`}`;
    });
    return lines('---', 'markdag:', ...groups, '---', '', '# 計画', '', ...items, '');
}

const LONG_DOC = longDoc();
const ROOT = 1;
const FIRST = 2;
const LAST = 25;
const itemTarget = (id: number): NodeTarget => ({ id, refText: `項目 ${id - 1}` });
const FAR_APART = [itemTarget(FIRST), itemTarget(LAST)];
// 項目 1 と項目 24 を班に入れた文書 (凡例の +)
const LONG_BOTH_IN_G1 = longDoc({ 1: '%g1', 24: '%g1' });
// 項目 1 だけを班に入れた文書 (1 つのときの守り)
const LONG_FIRST_IN_G1 = longDoc({ 1: '%g1' });
// 項目 1 と項目 24 を新しいグループにまとめた文書
const LONG_BOTH_GROUPED = longDoc({ 1: '%group1', 24: '%group1' }, [...GROUP_G1, ...GROUP_NEW]);
// 項目 1 だけを新しいグループにまとめた文書 (1 つのときの守り)
const LONG_FIRST_GROUPED = longDoc({ 1: '%group1' }, [...GROUP_G1, ...GROUP_NEW]);
// 項目 24 を置く高さ (図の領域の上の辺から、箱の上下の中ほどまで。am07 と同じ)
const LAST_CENTER_Y = 180;

const LEGEND_ROW_G1 = '#a .mdag-editor-legend .mdag-editor-legend-row[data-group="g1"]';
const GROUP_NAME_INPUT = '.mdag-editor-name-input[data-for="group"]';
const NODE_NAME_INPUT = '.mdag-editor-name-input[data-for="node"]';

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors = {};
        target.changes = [];
    });
}

// GUI 編集で mount して、選択の道具にする
async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            animate: false,
            mode: 'edit',
            onChange: (next) => {
                target.changes.push(next);
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
    await page.locator('#a .mdag-editor-tool[data-tool="select"]').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 「動かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);
const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

async function transformOf(page: Page): Promise<ViewTransform> {
    const transform = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getTransform() ?? null);
    if (!transform) throw new Error('#a の図がない');
    return transform;
}

const foldedOf = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getFolded() ?? []);

// 表示位置を置き換える (直す前は操作で動くので、そのあとの元に戻す / やり直すだけの動きを見るために、操作の前の位置へ戻す)
async function setTransform(page: Page, transform: ViewTransform): Promise<void> {
    await page.evaluate((transform) => (window as unknown as EditorWindow).editors.a?.view.setTransform(transform), transform);
    await settle(page);
}

const roundTransform = (transform: ViewTransform): ViewTransform => ({ x: Math.round(transform.x * 100) / 100, y: Math.round(transform.y * 100) / 100, k: Math.round(transform.k * 1000) / 1000 });

const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

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

// 描いている文書で名前が name のノードの id (なければ null)
const idOfName = (page: Page, name: string): Promise<number | null> =>
    page.evaluate((name) => (window as unknown as EditorWindow).editors.a?.view.getDocument()?.parsed.nodes.find((node) => node.refText === name)?.id ?? null, name);

type Spot =
    // 要素 (か中の要素) が表に出ている点
    | { on: 'element'; selector: string }
    // 要素の中の文字の上の点 (svg の外)
    | { on: 'text'; selector: string };

// 画面の座標で押せる点を探す (図の領域はスクロールを戻すので、locator.click ではなく座標を決めて page.mouse で押す)
async function spot(page: Page, target: Spot): Promise<Point> {
    const found = await page.evaluate((target) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        if (target.on === 'element') {
            const rect = element.getBoundingClientRect();
            const step = Math.max(1, Math.min(rect.width, rect.height) / 8);
            const points: Array<{ x: number; y: number }> = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
            return (
                points.find((point) => {
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

// ノードの文字の上を押す (Shift を押しながらも)
async function pressLabel(page: Page, id: number, modifier?: 'Shift'): Promise<void> {
    const point = await spot(page, { on: 'text', selector: `${nodeSelector(id)} .mdag-content` });
    if (modifier) await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        if (modifier) await page.keyboard.up(modifier);
    }
}

// 凡例のパネルの班の行の + を押す。ポインタを行に乗せて + が見えるのを待ってから押す (detail3 の手順)
async function pressLegendAdd(page: Page): Promise<void> {
    const row = await rectOf(page, LEGEND_ROW_G1);
    await page.mouse.move((row.left + row.right) / 2, (row.top + row.bottom) / 2);
    const plus = `${LEGEND_ROW_G1} .mdag-editor-legend-action[data-action="add"]`;
    await expect(page.locator(plus)).toBeVisible();
    await press(page, await spot(page, { on: 'element', selector: plus }));
}

const selectionOf = (page: Page): Promise<EditorSelection | null> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() ?? null);

// 選んでいるノード (getSelection) の id と refText (id の昇順)。何も選んでいなければ空、ノードでなければ kind
async function selectedNodes(page: Page): Promise<NodeTarget[] | string> {
    const selection = await selectionOf(page);
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

// 見えている名前の入力の数と、中の欄にフォーカスがあるか
async function nameInputOf(page: Page, selector: string): Promise<{ count: number; focused: boolean }> {
    return page.evaluate((selector) => {
        const shown = [...document.querySelectorAll(`#a ${selector}`)].filter((element) => element.checkVisibility());
        const element = shown[0];
        const field = element?.matches('input') ? element : element?.querySelector('input');
        return { count: shown.length, focused: field !== undefined && field !== null && document.activeElement === field };
    }, selector);
}

// 配布物の editSource で同じ書き換えを試す (期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

async function expectEdit(page: Page, source: string, op: EditOp, expected: string): Promise<void> {
    const outcome = await tryEdit(page, source, op);
    expect(outcome.status === 'edited' ? outcome.source : outcome, JSON.stringify(op)).toBe(expected);
}

const callHistory = (page: Page, direction: 'undo' | 'redo'): Promise<boolean | undefined> =>
    page.evaluate((direction) => (window as unknown as EditorWindow).editors.a?.[direction](), direction);

// am07 の手順の前半: 拡大 (1.6 倍) して項目 1 を見せて押す。凡例のパネル (図の領域の右上) が項目の列に重ならないよう、図を左へずらす
// (図の領域が 1000px の幅なので、ずらさないと上の方の項目がパネルの下に入る。detail3 の確認ページは 1280px の幅で重ならない)
const SHIFT_LEFT = 360;
async function zoomAndPickFirst(page: Page): Promise<void> {
    await page.evaluate(
        ({ first, shift }) => {
            const view = (window as unknown as EditorWindow).editors.a?.view;
            if (!view) throw new Error('#a の図がない');
            const t = view.getTransform();
            view.setTransform({ x: t.x, y: t.y, k: 1.6 });
            view.ensureVisible(first);
            view.panBy(-shift, 0);
        },
        { first: FIRST, shift: SHIFT_LEFT },
    );
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
    await mount(page, LONG_DOC);
    await zoomAndPickFirst(page);
    await panLastTo(page, LAST_CENTER_Y);
    await pressLabel(page, LAST, 'Shift');
    await expectSelected(page, FAR_APART);
    await settle(page);
    expect(await shownIn(page, FIRST), '項目 1 は画面の外').toBe(false);
    expect(await shownIn(page, LAST), '項目 24 は見えている').toBe(true);
    return transformOf(page);
}

// 1 つのときの守りの前半: 項目 1 だけを選び、パンして画面の外へ出す (項目 24 は見えている)。そのときの表示位置を返す
async function pickFirstOutside(page: Page): Promise<ViewTransform> {
    await mount(page, LONG_DOC);
    await zoomAndPickFirst(page);
    await panLastTo(page, LAST_CENTER_Y);
    await expectSelected(page, [itemTarget(FIRST)]);
    expect(await shownIn(page, FIRST), '項目 1 は画面の外').toBe(false);
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

// 見えている要素 (名前の入力など) の矩形が図の領域に収まっている (はみ出しは 0.5px まで許す)
async function expectInArea(page: Page, selector: string, message: string): Promise<void> {
    await settle(page);
    const box = await rectOf(page, `#a ${selector}`);
    const area = await areaBox(page);
    const inside = box.left >= area.left - 0.5 && box.top >= area.top - 0.5 && box.right <= area.right + 0.5 && box.bottom <= area.bottom + 0.5;
    expect(inside, `${message} の矩形 ${JSON.stringify(box)} が図の領域 ${JSON.stringify(area)} に収まる`).toBe(true);
}

// 見えている要素の矩形が図の領域に一部でも入っている
async function expectPartlyInArea(page: Page, selector: string, message: string): Promise<void> {
    await settle(page);
    const box = await rectOf(page, `#a ${selector}`);
    const area = await areaBox(page);
    const overlaps = box.bottom > area.top && box.top < area.bottom && box.right > area.left && box.left < area.right;
    expect(overlaps, `${message} の矩形 ${JSON.stringify(box)} が図の領域 ${JSON.stringify(area)} に一部でも入る`).toBe(true);
}

// 離れた 2 つを選んだまま図をパンして、項目 13 を図の領域の上下の中ほどに置く (項目 1 も項目 24 も画面の外。まとめる枠がどれも見えない形)。そのときの表示位置を返す
const MIDDLE = 14;
async function panBothOutside(page: Page): Promise<ViewTransform> {
    const area = await areaBox(page);
    const box = await nodeBox(page, MIDDLE);
    await page.evaluate((dy) => (window as unknown as EditorWindow).editors.a?.view.panBy(0, dy), (area.top + area.bottom) / 2 - (box.top + box.bottom) / 2);
    await settle(page);
    await expectSelected(page, FAR_APART);
    expect(await shownIn(page, FIRST), '項目 1 は画面の外').toBe(false);
    expect(await shownIn(page, LAST), '項目 24 は画面の外').toBe(false);
    return transformOf(page);
}

// 図が動いて、id のノードが見える所に入った (表示位置が before と違う)
async function expectMovedTo(page: Page, id: number, before: ViewTransform, message: string): Promise<void> {
    await settle(page);
    expect(await shownIn(page, id), `${message} のノード ${id}`).toBe(true);
    expect(roundTransform(await transformOf(page)), `${message} の表示位置`).not.toEqual(roundTransform(before));
}

test.describe('細部 3: 書き換えたあとに 2 つ以上を選び直す操作では図を動かさない (scope.md の「最後の関門 細部 3」(a)。records/final-apply/detail3)', () => {
    test('@editor 離れた 2 つ (項目 1 は画面の外) を選んで凡例の班の + を押すと、2 つを班に入れ、選んだまま、図は動かない (表示位置と開閉が + の前と同じで、項目 1 は画面の外のまま)', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'addToGroup', group: 'g1', nodes: FAR_APART }, LONG_BOTH_IN_G1);
        const before = await pickFarApart(page);
        await pressLegendAdd(page);
        await expectSource(page, LONG_BOTH_IN_G1, [LONG_BOTH_IN_G1]);
        await expectNotMoved(page, before, '凡例の +');
        await expectSelected(page, FAR_APART);
    });

    test('@editor 離れた 2 つを選んで ⌘G (グループにまとめる) を押すと、2 つを新しいグループにまとめてグループを選び、グループの名前の入力が開き、図は動かない。名前の入力は図の領域の中に見える (見えている枠のラベルの所。メインの決定)', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'groupNodes', nodes: FAR_APART }, LONG_BOTH_GROUPED);
        const before = await pickFarApart(page);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, LONG_BOTH_GROUPED, [LONG_BOTH_GROUPED]);
        await expect.poll(() => selectionOf(page)).toEqual({ kind: 'group', id: 'group1' });
        await expect.poll(() => nameInputOf(page, GROUP_NAME_INPUT)).toEqual({ count: 1, focused: true });
        await expectNotMoved(page, before, '⌘G');
        await expectInArea(page, GROUP_NAME_INPUT, '⌘G のグループの名前の入力');
    });

    test('@editor 守り: 離れた 2 つを選び、パンして 2 つとも画面の外 (まとめる枠がどれも見えない) にしてから ⌘G を押すと、今と同じく最初のメンバー (項目 1) を見える所へ動かし、グループの名前の入力が図の領域に (一部でも) 見える', async ({ page }) => {
        await open(page);
        await pickFarApart(page);
        const before = await panBothOutside(page);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, LONG_BOTH_GROUPED, [LONG_BOTH_GROUPED]);
        await expect.poll(() => selectionOf(page)).toEqual({ kind: 'group', id: 'group1' });
        await expect.poll(() => nameInputOf(page, GROUP_NAME_INPUT)).toEqual({ count: 1, focused: true });
        await expectMovedTo(page, FIRST, before, '見えている枠がないときの ⌘G');
        // 今は項目 1 の箱を辺から 24px の内に入れるだけなので、箱の上の枠のラベルの所に置く名前の入力は上の辺から半分ほどはみ出す (収まるかは見ない)
        await expectPartlyInArea(page, GROUP_NAME_INPUT, '見えている枠がないときの ⌘G のグループの名前の入力');
    });

    test('@editor 守り: 離れた 2 つを凡例の + で班に入れたあと、元に戻す / やり直すで 2 つを選び直しても、図は動かない (表示位置を + の前へ戻してから)', async ({ page }) => {
        await open(page);
        const before = await pickFarApart(page);
        await pressLegendAdd(page);
        await expectSource(page, LONG_BOTH_IN_G1, [LONG_BOTH_IN_G1]);
        await setTransform(page, before);
        expect(await callHistory(page, 'undo')).toBe(true);
        await expectSource(page, LONG_DOC, [LONG_BOTH_IN_G1, LONG_DOC], '元に戻す');
        await expectSelected(page, FAR_APART, '元に戻す');
        await expectNotMoved(page, before, '元に戻す');
        expect(await callHistory(page, 'redo')).toBe(true);
        await expectSource(page, LONG_BOTH_IN_G1, [LONG_BOTH_IN_G1, LONG_DOC, LONG_BOTH_IN_G1], 'やり直す');
        await expectSelected(page, FAR_APART, 'やり直す');
        await expectNotMoved(page, before, 'やり直す');
    });

    test('@editor 守り: 1 つだけ (画面の外の項目 1) を選んで凡例の + を押すと、今と同じく選んだノードを見える所へ動かす', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'addToGroup', group: 'g1', nodes: [itemTarget(FIRST)] }, LONG_FIRST_IN_G1);
        const before = await pickFirstOutside(page);
        await pressLegendAdd(page);
        await expectSource(page, LONG_FIRST_IN_G1, [LONG_FIRST_IN_G1]);
        await expectSelected(page, [itemTarget(FIRST)]);
        await expectMovedTo(page, FIRST, before, '1 つの +');
    });

    test('@editor 守り: 1 つだけ (画面の外の項目 1) を選んで ⌘G を押すと、今と同じくまとめたノードを見える所へ動かし、グループの名前の入力が開く', async ({ page }) => {
        await open(page);
        await expectEdit(page, LONG_DOC, { kind: 'groupNodes', nodes: [itemTarget(FIRST)] }, LONG_FIRST_GROUPED);
        const before = await pickFirstOutside(page);
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, LONG_FIRST_GROUPED, [LONG_FIRST_GROUPED]);
        await expect.poll(() => selectionOf(page)).toEqual({ kind: 'group', id: 'group1' });
        await expect.poll(() => nameInputOf(page, GROUP_NAME_INPUT)).toEqual({ count: 1, focused: true });
        await expectMovedTo(page, FIRST, before, '1 つの ⌘G');
    });

    test('@editor 守り: 離れた 2 つを Delete で消すと、選び直すのは親 (計画) の 1 つなので、今と同じく計画を見える所へ動かす', async ({ page }) => {
        await open(page);
        const removed = lines('---', 'markdag:', ...GROUP_G1, '---', '', '# 計画', '', ...Array.from({ length: ITEM_COUNT - 2 }, (_, index) => `- 項目 ${index + 2}${index + 2 === 12 ? ' %g1' : ''}`), '');
        await expectEdit(page, LONG_DOC, { kind: 'deleteNodes', nodes: FAR_APART }, removed);
        const before = await pickFarApart(page);
        expect(await shownIn(page, ROOT), '消す前の計画は画面の外').toBe(false);
        await page.keyboard.press('Delete');
        await expectSource(page, removed, [removed]);
        await expectSelected(page, [{ id: ROOT, refText: '計画' }]);
        await expectMovedTo(page, ROOT, before, '2 つの削除');
    });

    test('@editor 守り: 離れた 2 つを J で新しい合流点へ合流させると、選び直すのは合流点の 1 つなので、今と同じく合流点を見える所へ動かし、名前の入力が開く', async ({ page }) => {
        await open(page);
        const before = await pickFarApart(page);
        await page.keyboard.press('j');
        await expect.poll(() => idOfName(page, '合流点')).not.toBeNull();
        await expect.poll(() => changeLog(page).then((changes) => changes.length)).toBe(1);
        const joined = await idOfName(page, '合流点');
        if (joined === null) throw new Error('合流点がない');
        await expectSelected(page, [{ id: joined, refText: '合流点' }]);
        await expect.poll(() => nameInputOf(page, NODE_NAME_INPUT)).toEqual({ count: 1, focused: true });
        await expectMovedTo(page, joined, before, '2 つから新しい合流点');
    });
});

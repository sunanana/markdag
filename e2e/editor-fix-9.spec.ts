// GUI 編集の名前の入力の初めの値の \ を、ビルドした配布物の markdag/editor で確かめる。
// 名前の入力を開き直したとき、markdag が名前の変更で自動で足した \ (印に化ける語、
// ブロックに化ける書き始め、見出しの閉じの記号の逃がし) は入力欄に出さない (図の名前と同じ文字を出す)。決めるときは今までどおり markdag が自動で足す。
// その値のまま決めても原文は変わらない (二重に逃がさない)。原文に人が書いた \ のうち、markdag が足すのと同じ所のものも同じ扱い。
// 開き直す道は Enter、ラベルのダブルクリック、帯の「名前」。入力中の Enter は決めて兄弟を足し、
// 足したばかりの入力の Esc は足す前に戻す。外へフォーカスが移ると決めて閉じる。
// 見た目そのものは見ない。名前の入力の値とフォーカスと置き場、原文の全文、onChange の呼ばれ方、選択 (data-selected と getSelection) を見る。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
};

const DIST = resolve('dist');

// 足したノードの仮の名前
const NEW = '新しいノード';

function docWith(body: string[]): string {
    return ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '---', '', ...body].join('\n');
}

// 見出しと Design の下の項目と Leaf の行を替えた本文。ノードは Root 1、Design 2、項目 (3 から文書の順)、Build、Leaf
function bodyWith(design: string, items: string[], leaf = '- Leaf'): string[] {
    return ['# Root', '', design, '', ...items, '', '## Build', '', leaf, ''];
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6
const DOC = docWith(bodyWith('## Design', ['- Task A', '- Task B']));
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;

// Task B の名前を「設計 #a」に決めた原文 (末尾の #a がタグに化けないよう markdag が \ を足す) と、そのあと Enter で兄弟を足した原文
const RENAMED = docWith(bodyWith('## Design', ['- Task A', String.raw`- 設計 \#a`]));
const RENAMED_ADDED = docWith(bodyWith('## Design', ['- Task A', String.raw`- 設計 \#a`, `- ${NEW}`]));

// markdag キーのない文書 (印を読まないので、末尾の #k は名前の一部)。ノードは Root 1、a #k 2、b 3。mount の mode: edit で開く
const NO_KEY = ['# Root', '', '- a #k', '- b', ''].join('\n');
const NO_KEY_ADDED = ['# Root', '', '- a #k', `- ${NEW}`, '- b', ''].join('\n');
// markdag キーのある文書 (#k はタグ)。ノードは Root 1、a 2、b 3
const WITH_KEY = docWith(['# Root', '', '- a #k', '- b', '']);
const WITH_KEY_ADDED = docWith(['# Root', '', '- a #k', `- ${NEW}`, '- b', '']);

// 原文に人が書いた \ (markdag が名前の変更で足すのと同じ所)。見出しの閉じの記号、末尾の印に化ける語、番号に化ける書き始め
const HAND_ESCAPED = docWith(bodyWith(String.raw`## Issue \#`, [String.raw`- 設計 \#a`, String.raw`- 1\. はじめに`]));

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
    });
}

// 図を (あれば片付けてから) 描き、onChange の記録を空にする。mode を渡すと mount のオプションで文書の指定を上書きする (markdag キーのない文書を GUI 編集で開く)
async function mountFresh(page: Page, markdown: string, mode?: 'edit'): Promise<void> {
    await page.evaluate(({ markdown, mode }) => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            animate: false,
            onChange: (next) => {
                target.changes.push(next);
            },
        };
        if (mode) options.mode = mode;
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, { markdown, mode });
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「呼ばれない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const labelOf = (page: Page, id: number) => page.locator(`${nodeSelector(id)} .mdag-content`);
const target = (id: number, refText: string): NodeTarget => ({ id, refText });

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

// 選んでいるノードが targets になるまで待つ (図の印と getSelection の両方)
async function expectSelection(page: Page, targets: NodeTarget[], message?: string): Promise<void> {
    const sorted = [...targets].sort((a, b) => a.id - b.id);
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const container = document.getElementById('a');
                    const editor = (window as unknown as EditorWindow).editors.a;
                    if (!container || !editor) throw new Error('#a の図がない');
                    const marked = [...container.querySelectorAll('.mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
                    const selection = editor.getSelection();
                    const selected = selection.kind === 'nodes' ? [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText })) : selection.kind;
                    return { marked, selected };
                }),
            message,
        )
        .toEqual({ marked: sorted.map((item) => item.id), selected: sorted });
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

// 名前の入力がノードのラベルの上に 1 つ開き、フォーカスがあって、値が value になるまで待つ (allSelected なら値の全部を選んでいる)
async function expectNameInputOn(page: Page, id: number, value: string, message?: string, allSelected = false): Promise<void> {
    await expect
        .poll(async () => {
            const state = await nameInputOf(page);
            const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
            const [label] = await rectsOf(page, `${nodeSelector(id)} .mdag-content`);
            const rect = state.rect;
            const middle = rect === null ? 0 : (rect.top + rect.bottom) / 2;
            const onLabel = rect !== null && box !== undefined && label !== undefined && rect.left < label.right && rect.right > label.left && middle >= box.top - 2 && middle <= box.bottom + 2;
            return { count: state.count, value: state.value, focused: state.focused, onLabel, ...(allSelected ? { selected: state.selected } : {}) };
        }, message)
        .toEqual({ count: 1, value, focused: true, onLabel: true, ...(allSelected ? { selected: value } : {}) });
}

// 名前の入力が 1 つ開いてフォーカスがあるまで待つ (値は見ない)
async function expectNameInputOpen(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => {
        const state = await nameInputOf(page);
        return { count: state.count, focused: state.focused };
    }, message).toEqual({ count: 1, focused: true });
}

async function expectNameInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await nameInputOf(page)).count, message).toBe(0);
}

// 名前の入力の値を全部選んで text を打つ
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
}

// 画面の座標で押せる点を探す (要素か、要素の中の文字の上)
async function spot(page: Page, selector: string, on: 'element' | 'text'): Promise<Point> {
    const found = await page.evaluate(
        ({ selector, on }) => {
            const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
            const element = [...document.querySelectorAll(selector)].find((item) => item.checkVisibility());
            if (!element) return null;
            if (on === 'element') {
                const rect = element.getBoundingClientRect();
                const step = Math.max(2, Math.min(rect.width, rect.height) / 8);
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
        },
        { selector, on },
    );
    if (!found) throw new Error(`押せる点がない: ${selector}`);
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, `${nodeSelector(id)} .mdag-box`, 'element'));
}

// ノードの文字の上を押して選ぶ (タグか詳細の印のあるノードは、箱の真ん中を押すとその印に当たることがあるため)
async function pressLabel(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, `${nodeSelector(id)} .mdag-content`, 'text'));
}

// ノードのラベル (名前の文字) をダブルクリックする
async function doubleClickLabel(page: Page, id: number): Promise<void> {
    const point = await spot(page, `${nodeSelector(id)} .mdag-content`, 'text');
    await page.mouse.move(point.x, point.y);
    await page.mouse.dblclick(point.x, point.y);
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, selector, 'element'));
}

// 名前の入力の外 (図の外の欄) へフォーカスを移す
async function focusOutside(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('outside')) return;
        const field = document.createElement('textarea');
        field.id = 'outside';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
    await page.locator('#outside').click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('outside');
}

type Reopen = 'Enter' | 'ダブルクリック' | '帯の「名前」';

// 選んだノードの名前の入力を開き直す
async function reopen(page: Page, id: number, how: Reopen): Promise<void> {
    if (how === 'ダブルクリック') {
        await doubleClickLabel(page, id);
        return;
    }
    await pressNode(page, id);
    if (how === 'Enter') await page.keyboard.press('Enter');
    else await pressBar(page, 'rename');
}

test.describe('名前の入力の初めの値に、markdag が足した \\ を出さない (整える 名前の入力の \\)', () => {
    test('@editor 名前を「設計 #a」に決めたあと (Enter で兄弟を足し、Esc で足す前に戻す)、Enter で開き直すと入力欄の値は「設計 #a」(原文の行は「- 設計 \\#a」)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, DOC);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, 'Task B');
        await replaceName(page, '設計 #a');
        await page.keyboard.press('Enter');
        await expectSource(page, RENAMED_ADDED, [RENAMED, RENAMED_ADDED]);
        await expectNameInputOn(page, 5, NEW, '足した兄弟の名前の入力', true);
        await page.keyboard.press('Escape');
        await expectSource(page, RENAMED, [RENAMED, RENAMED_ADDED, RENAMED]);
        await expectNameInputClosed(page);
        await expect(labelOf(page, TASK_B)).toHaveText('設計 #a');
        await expectSelection(page, [target(TASK_B, '設計 #a')]);

        await page.keyboard.press('Enter');
        await expectNameInputOn(page, TASK_B, '設計 #a', '開き直した入力欄の値');
        expect(errors).toEqual([]);
    });

    test('@editor 逃がしの種類ごと (末尾の #draft、番号に化ける書き始め、タスクの記号に化ける書き始め、見出しの閉じの記号): 名前を変えて外へフォーカスを移して決め、開き直すと (Enter、ラベルのダブルクリック、帯の「名前」) 入力欄の値は入れた名前のまま', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        const cases: Array<{ id: number; before: string; name: string; after: string; how: Reopen }> = [
            { id: TASK_A, before: 'Task A', name: 'C# と F# の比較 #draft', after: docWith(bodyWith('## Design', [String.raw`- C# と F# の比較 \#draft`, '- Task B'])), how: 'Enter' },
            { id: TASK_B, before: 'Task B', name: '1. はじめに', after: docWith(bodyWith('## Design', ['- Task A', String.raw`- 1\. はじめに`])), how: 'ダブルクリック' },
            { id: LEAF, before: 'Leaf', name: '[ ] x', after: docWith(bodyWith('## Design', ['- Task A', '- Task B'], String.raw`- \[ ] x`)), how: 'Enter' },
            { id: DESIGN, before: 'Design', name: 'Issue #', after: docWith(bodyWith(String.raw`## Issue \#`, ['- Task A', '- Task B'])), how: '帯の「名前」' },
        ];
        await open(page);
        for (const item of cases) {
            const where = `${item.name} (${item.how})`;
            await mountFresh(page, DOC);
            await pressNode(page, item.id);
            await page.keyboard.press('Enter');
            await expectNameInputOn(page, item.id, item.before, where);
            await replaceName(page, item.name);
            await focusOutside(page);
            await expectSource(page, item.after, [item.after], where);
            await expectNameInputClosed(page, where);
            await expect(labelOf(page, item.id), where).toHaveText(item.name);

            await reopen(page, item.id, item.how);
            await expectNameInputOn(page, item.id, item.name, `${where} の開き直した入力欄の値`);
            // 変えずに閉じる
            await page.keyboard.press('Escape');
            await expectNameInputClosed(page, where);
            await expectSourceStill(page, item.after, [item.after], where);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 原文に人が書いた \\ のうち markdag が足すのと同じ所のもの (見出しの閉じの記号、末尾の印に化ける語、番号に化ける書き始め) も、名前の入力に出さない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, HAND_ESCAPED);
        const cases: Array<{ id: number; name: string; how: Reopen }> = [
            { id: DESIGN, name: 'Issue #', how: 'Enter' },
            { id: TASK_A, name: '設計 #a', how: 'ダブルクリック' },
            { id: TASK_B, name: '1. はじめに', how: '帯の「名前」' },
        ];
        for (const item of cases) {
            await expect(labelOf(page, item.id), item.name).toHaveText(item.name);
            await reopen(page, item.id, item.how);
            await expectNameInputOn(page, item.id, item.name, `${item.name} (${item.how}) の入力欄の値`);
            await page.keyboard.press('Escape');
            await expectNameInputClosed(page, item.name);
        }
        await expectSourceStill(page, HAND_ESCAPED, []);
        expect(errors).toEqual([]);
    });

    test('@editor 開き直した値のまま決めても名前の行は変わらない (二重に逃がさない): Enter は兄弟を足すだけで Esc で戻り、外へフォーカスを移して決めると原文も onChange も変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, RENAMED);

        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOpen(page, 'Enter で開いた');
        await page.keyboard.press('Enter');
        await expectSource(page, RENAMED_ADDED, [RENAMED_ADDED], 'そのまま Enter');
        await expectNameInputOn(page, 5, NEW, '足した兄弟の名前の入力', true);
        await page.keyboard.press('Escape');
        await expectSource(page, RENAMED, [RENAMED_ADDED, RENAMED], 'Esc');
        await expectNameInputClosed(page);
        await expectSelection(page, [target(TASK_B, '設計 #a')]);

        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOpen(page, '開き直した');
        await focusOutside(page);
        await expectNameInputClosed(page);
        await expectSourceStill(page, RENAMED, [RENAMED_ADDED, RENAMED], '外へフォーカスを移して決めた');
        await expect(labelOf(page, TASK_B)).toHaveText('設計 #a');
        expect(errors).toEqual([]);
    });

    test('@editor 開き直した値を別の名前に変えて決めると、今までどおり markdag が末尾の印に化ける語を逃がす', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, RENAMED);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOpen(page);
        await replaceName(page, '設計 #b');
        await focusOutside(page);
        const changed = docWith(bodyWith('## Design', ['- Task A', String.raw`- 設計 \#b`]));
        await expectSource(page, changed, [changed]);
        await expect(labelOf(page, TASK_B)).toHaveText('設計 #b');
        expect(errors).toEqual([]);
    });

    test('@editor 開き直した値の末尾に書き足して決めると、markdag は要る所だけを逃がす (行の途中になった #a は逃がさない。原文は「- 設計 #a の説明」)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, RENAMED);
        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectNameInputOpen(page);
        // 全部を選んだ値の選びを外して末尾へ (macOS では End でカーソルが動かない)
        await page.keyboard.press('ArrowRight');
        await page.keyboard.type(' の説明');
        await focusOutside(page);
        const appended = docWith(bodyWith('## Design', ['- Task A', '- 設計 #a の説明']));
        await expectSource(page, appended, [appended]);
        await expect(labelOf(page, TASK_B)).toHaveText('設計 #a の説明');
        expect(errors).toEqual([]);
    });
});

test.describe('名前の入力を開いて何も変えずに決めたときは原文を変えない (整える 名前の入力の \\ のメインの決定 3)', () => {
    // 開いて何も変えずに Enter: 名前の行は変えず兄弟だけを足し (onChange は兄弟の 1 回)、Esc で足す前に戻る。開いて何も変えずに外へフォーカスを移す: 原文も onChange も変わらない
    async function expectUnchangedCommits(page: Page, doc: string, added: string, id: number, name: string, value: string): Promise<void> {
        await pressLabel(page, id);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, id, value, `${name} を Enter で開いた値`);
        await page.keyboard.press('Enter');
        await expectSource(page, added, [added], `${name} を何も変えずに Enter`);
        await expectNameInputOn(page, 3, NEW, '足した兄弟の名前の入力', true);
        await page.keyboard.press('Escape');
        await expectSource(page, doc, [added, doc], 'Esc');
        await expectNameInputClosed(page);
        await expectSelection(page, [target(id, name)]);

        await pressLabel(page, id);
        await page.keyboard.press('Enter');
        await expectNameInputOn(page, id, value, `${name} を開き直した値`);
        await focusOutside(page);
        await expectNameInputClosed(page);
        await expectSourceStill(page, doc, [added, doc], `${name} を何も変えずに外へフォーカスを移して決めた`);
        await expect(labelOf(page, id)).toHaveText(name);
    }

    test('@editor markdag キーのない文書の「- a #k」(#k は名前の一部): 開くと値は「a #k」。何も変えずに Enter で決めても名前の行は「- a #k」のまま (- a \\#k にしない)。外へフォーカスを移して決めても原文も onChange も変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, NO_KEY, 'edit');
        await expectUnchangedCommits(page, NO_KEY, NO_KEY_ADDED, 2, 'a #k', 'a #k');
        expect(errors).toEqual([]);
    });

    test('@editor markdag キーのある文書の「- a #k」(#k はタグ): 開くと値は「a」。何も変えずに Enter で決めても名前の行は「- a #k」のまま。外へフォーカスを移して決めても原文も onChange も変わらない', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mountFresh(page, WITH_KEY);
        await expectUnchangedCommits(page, WITH_KEY, WITH_KEY_ADDED, 2, 'a', 'a');
        expect(errors).toEqual([]);
    });

    test('@editor 名前を変えて決めたときは、markdag キーのない文書でもある文書でも今までどおり末尾の印に化ける語を逃がす', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        const cases: Array<{ doc: string; mode?: 'edit'; before: string; name: string; after: string }> = [
            { doc: NO_KEY, mode: 'edit', before: 'a #k', name: 'b #k', after: ['# Root', '', String.raw`- b \#k`, '- b', ''].join('\n') },
            { doc: WITH_KEY, before: 'a', name: 'b #c', after: docWith(['# Root', '', String.raw`- b \#c #k`, '- b', '']) },
        ];
        for (const item of cases) {
            await mountFresh(page, item.doc, item.mode);
            await pressLabel(page, 2);
            await page.keyboard.press('Enter');
            await expectNameInputOn(page, 2, item.before, item.name);
            await replaceName(page, item.name);
            await focusOutside(page);
            await expectSource(page, item.after, [item.after], item.name);
            await expectNameInputClosed(page, item.name);
        }
        expect(errors).toEqual([]);
    });
});

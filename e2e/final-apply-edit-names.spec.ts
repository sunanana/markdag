// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 1、9、16) を、ビルドした配布物の markdag/editor で、
// 直す前に落ちるテストとして書く。GUI で操作したときの原文、通知 (.mdag-editor-snackbar と data-kind、文)、名前の入力、履歴を見る。
// 1. empty-name: どのノードも名前を空にできない。名前の入力で空にして Enter すると、通知 (error) は「名前を空にできません」だけで、
//    入力は開いたまま、原文と履歴は変わらない。閲覧へ切り替えるときも同じ文で知らせる。今の名前が空なら same-name が先 (細部 26)
// 2. AM-06: 記号だけの名前が行の印と合わさる行も断らずに書き、開き直した名前の入力に足した \ を出さない
// 3. B-134: タグ追加のパネルで、キーに使えない字のあるキーと " のある値を入れても断らず、" で囲んで逃がして書く
// 期待の原文は規則から書き、配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ)。
// 反映は expect.poll で待ち、「変わらない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, EditOutcome, NodeTarget } from '../src/core';
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

interface Point {
    x: number;
    y: number;
}

const DIST = resolve('dist');

const EMPTY_NAME_MESSAGE = '名前を空にできません';

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

// markdag.editor を書いた文書。markdag の行は markdag の下の字下げ (4 桁) から、editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く
function docWith(editor: string[], body: string[], markdag: string[] = []): string {
    return ['---', 'markdag:', ...markdag.map((line) => `    ${line}`), '    editor:', ...editor.map((line) => `        ${line}`), '---', '', ...body].join('\n');
}

// ノードは Root 1、Design 2 (子のある見出し)、Todo 3 (タスクの項目)、Plain 4 (印もタスクの記号もない項目)、Build 5、Leaf 6
const NAMES_BODY = ['# Root', '', '## Design', '', '- [ ] Todo', '- Plain', '', '## Build', '', '- Leaf', ''];
const DESIGN = 2;
const TODO = 3;
const PLAIN = 4;
const NAMES: Record<number, string> = { 2: 'Design', 3: 'Todo', 4: 'Plain' };

// 名前が空の項目 (2) のある文書。ノードは Root 1、空の項目 2、Next 3
const EMPTY_ITEM_BODY = ['# Root', '', '-', '- Next', ''];

// グループの印のある項目 (records/final-gate/am06 の文書)。ノードは 計画 1、設計 2、実装 3
const GROUPS = ['groups:', '    画面班:', '        label: 画面班'];
const AM06_DOC = docWith(EDIT, ['# 計画', '', '- 設計 %画面班', '- 実装', ''], GROUPS);
const AM06_RENAMED = docWith(EDIT, ['# 計画', '', '- \\[x] %画面班', '- 実装', ''], GROUPS);

// タグの文書。ノードは Root 1、Design 2、Task A 3、Task B 4
const TAGS_DOC = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A', '- Task B', '']);
const TAGS_QUOTED = docWith(EDIT, ['# Root', '', '## Design', '', '- Task A #"a.b":"say \\"hi\\""', '- Task B', '']);
const TASK_A = 3;

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
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す (原文、選択、履歴、通知を初めの状態に戻す)。onChange の記録も空にする
async function remount(page: Page, markdown: string): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        target.changes = [];
    });
    await mount(page, markdown);
}

// 「変わらない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));
const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());
const getMode = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode());
const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const snackbars = (page: Page) => visible(page, '#a .mdag-editor-snackbar');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const labelOf = (page: Page, id: number) => page.locator(`${nodeSelector(id)} .mdag-content`);

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

// ノードの文字の上を押す (タスクのノードは先頭の絵を押すと状態が進むので、文字の上を押して選ぶ)
async function pressLabel(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'text', selector: `${nodeSelector(id)} .mdag-content` }));
}

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 選んでいるノード (getSelection) の id と refText
async function selectedNodes(page: Page): Promise<NodeTarget[] | string> {
    const selection = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() ?? null);
    if (selection === null) return 'none';
    return selection.kind === 'nodes' ? selection.nodes.map((node) => ({ id: node.id, refText: node.refText })) : selection.kind;
}

async function expectSelected(page: Page, target: NodeTarget): Promise<void> {
    await expect.poll(() => selectedNodes(page)).toEqual([target]);
}

interface NameInputState {
    // 見えている名前の入力 (.mdag-editor-name-input[data-for="node"]) の数
    count: number;
    // 入力の値 (1 つのときだけ)
    value: string | null;
    // フォーカスが入力の中にある
    focused: boolean;
}

async function nameInputOf(page: Page): Promise<NameInputState> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...container.querySelectorAll('.mdag-editor-name-input[data-for="node"]')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, focused: false };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
        return { count: 1, value, focused };
    });
}

// 名前の入力が 1 つ開き、フォーカスがあって、値が value になるまで待つ
async function expectNameInput(page: Page, value: string, message?: string): Promise<void> {
    await expect.poll(() => nameInputOf(page), message).toEqual({ count: 1, value, focused: true });
}

async function expectNameInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(async () => (await nameInputOf(page)).count, message).toBe(0);
}

// 名前の入力の外 (図の外に置いたテストのページの原文の欄) へフォーカスを移す (名前の入力は外へ移ると決める)
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

// 名前の入力の値を全部選んで text を打つ
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
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

// 配布物の editSource で同じ書き換えを試す (期待の原文と断る理由の文を確かめる。期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

// 描いている文書のモデルの、ノードのタグ (tagsOf。書いた順)
async function tagsOf(page: Page, id: number): Promise<Array<{ key: string; values: string[] }>> {
    return page.evaluate((id) => {
        const doc = (window as unknown as EditorWindow).editors.a?.view.getDocument();
        return (doc?.model.tagsOf.get(id) ?? []).map((tag) => ({ key: tag.key, values: [...tag.values] }));
    }, id);
}

// タグのパネル (.mdag-editor-tag-panel) の文字の入力 (input の type が text か search か省いたもの) の値と、フォーカスのある入力の添字
async function tagFieldsOf(page: Page): Promise<{ count: number; fields: string[]; focused: number }> {
    return page.evaluate(() => {
        const shown = [...document.querySelectorAll('#a .mdag-editor-tag-panel')].filter((element) => element.checkVisibility());
        const panel = shown[0];
        if (shown.length !== 1 || !panel) return { count: shown.length, fields: [], focused: -1 };
        const fields = [...panel.querySelectorAll('input')].filter((input) => input.checkVisibility() && ['text', 'search'].includes((input.getAttribute('type') ?? 'text').toLowerCase()));
        return { count: 1, fields: fields.map((input) => input.value), focused: fields.findIndex((input) => input === document.activeElement) };
    });
}

// タグのパネルの添字 index の文字の入力を押してフォーカスを置き、中身を全部選んで text を打つ
async function fillTagField(page: Page, index: number, text: string): Promise<void> {
    await settle(page);
    const point = await page.evaluate((index) => {
        const panel = [...document.querySelectorAll('#a .mdag-editor-tag-panel')].find((element) => element.checkVisibility());
        const fields = [...(panel?.querySelectorAll('input') ?? [])].filter((input) => input.checkVisibility() && ['text', 'search'].includes((input.getAttribute('type') ?? 'text').toLowerCase()));
        const field = fields[index];
        if (!field) return null;
        const rect = field.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, index);
    if (!point) throw new Error(`タグのパネルの入力 ${index} がない`);
    await press(page, point);
    await expect.poll(async () => (await tagFieldsOf(page)).focused).toBe(index);
    await page.keyboard.press('ControlOrMeta+KeyA');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await expect.poll(async () => (await tagFieldsOf(page)).fields[index]).toBe(text);
}

test.describe('名前を空にできない (empty-name。plan.md の 16)', () => {
    test('@editor 印もタスクの記号もない項目、子のある見出し、タスクの項目の名前を空にして Enter すると、原文を変えずに通知 (error) を「名前を空にできません」だけで出し、名前の入力は空のまま開いている。履歴に積まない', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        const doc = docWith(EDIT, NAMES_BODY);
        for (const id of [PLAIN, DESIGN, TODO]) {
            const name = NAMES[id] ?? '';
            const outcome = await tryEdit(page, doc, { kind: 'renameNode', node: { id, refText: name }, label: '' });
            expect(outcome, name).toEqual({ status: 'refused', reason: { code: 'empty-name', message: EMPTY_NAME_MESSAGE, path: null } });

            await remount(page, doc);
            await pressLabel(page, id);
            await expectSelected(page, { id, refText: name });
            await page.keyboard.press('Enter');
            await expectNameInput(page, name, name);
            await replaceName(page, '');
            await page.keyboard.press('Enter');
            expect(await expectNotice(page, 'error', name), name).toBe(EMPTY_NAME_MESSAGE);
            await expectSourceStill(page, doc, [], name);
            await expectNameInput(page, '', name);
            await expect(labelOf(page, id), name).toHaveText(name);
            await expect(toolButton(page, 'undo'), name).toBeDisabled();
        }
    });

    test('@editor 閲覧へ切り替えるときに決める空の名前も断り、通知 (error) を「名前を空にできません」だけで出して入力を閉じ、閲覧に替わる。原文は変わらない (A-20)', async ({ page }) => {
        await open(page);
        const doc = docWith(SWITCH_EDIT, NAMES_BODY);
        await mount(page, doc);
        await pressLabel(page, PLAIN);
        await expectSelected(page, { id: PLAIN, refText: 'Plain' });
        await page.keyboard.press('Enter');
        await expectNameInput(page, 'Plain');
        await replaceName(page, '');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe('');

        expect(await setMode(page, 'view')).toBe(true);
        expect(await getMode(page)).toBe('view');
        await expectNameInputClosed(page);
        expect(await expectNotice(page, 'error')).toBe(EMPTY_NAME_MESSAGE);
        await expectSourceStill(page, doc, []);
        await expect(labelOf(page, PLAIN)).toHaveText('Plain');
    });

    test('@editor 変えない (細部 26): 名前が空のノードの入力を空のまま決める (外へフォーカスを移す) と、原文を変えず、断る通知も出さずに閉じる', async ({ page }) => {
        await open(page);
        const doc = docWith(EDIT, EMPTY_ITEM_BODY);
        const outcome = await tryEdit(page, doc, { kind: 'renameNode', node: { id: 2, refText: '' }, label: '' });
        expect(outcome.status).toBe('unchanged');
        await mount(page, doc);
        await useSelectTool(page);
        // 名前が空のノードは箱に大きさがないので、兄弟 (Next) を押してから ↑ で選ぶ
        await pressLabel(page, 3);
        await expectSelected(page, { id: 3, refText: 'Next' });
        await page.keyboard.press('ArrowUp');
        await expectSelected(page, { id: 2, refText: '' });
        await page.keyboard.press('Enter');
        await expectNameInput(page, '');
        // Enter は決めて兄弟を足すので、外へフォーカスを移して決める
        await focusOutside(page);
        await expectNameInputClosed(page);
        await expectSourceStill(page, doc, []);
        await expect(snackbars(page)).toHaveCount(0);
    });
});

test.describe('記号だけの名前 (AM-06。plan.md の 1)', () => {
    test('@editor グループの印のある「設計 %画面班」の名前を [x] にして決めると、断らずに `- \\[x] %画面班` と書き、通知 (info) を出す。名前は「[x]」のまま (タスクにならない) で、開き直した入力に \\ は出ず、そのまま決めても原文は変わらない', async ({ page }) => {
        await open(page);
        const outcome = await tryEdit(page, AM06_DOC, { kind: 'renameNode', node: { id: 2, refText: '設計' }, label: '[x]' });
        expect(outcome.status === 'edited' ? outcome.source : outcome).toBe(AM06_RENAMED);

        await mount(page, AM06_DOC);
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('Enter');
        await expectNameInput(page, '設計');
        await replaceName(page, '[x]');
        // Enter は決めて兄弟を足すので、外へフォーカスを移して決める
        await focusOutside(page);
        await expectSource(page, AM06_RENAMED, [AM06_RENAMED]);
        await expectNotice(page, 'info');
        await expectNameInputClosed(page);
        await expect(labelOf(page, 2)).toHaveText('[x]');
        await expect(toolButton(page, 'undo')).toBeEnabled();

        // 開き直した名前の入力の初めの値は「[x]」(足した \ を出さない)。そのまま決めても原文は変わらない
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '[x]' });
        await page.keyboard.press('Enter');
        await expectNameInput(page, '[x]');
        await focusOutside(page);
        await expectNameInputClosed(page);
        await expectSourceStill(page, AM06_RENAMED, [AM06_RENAMED]);
    });
});

test.describe('タグのキーと値の囲み (B-134。plan.md の 9)', () => {
    test('@editor タグ追加のパネルで、キーに使えない字のあるキー (a.b) と " のある値を入れて Enter すると、断らずに #"a.b":"say \\"hi\\"" と書き、通知 (info) を出して履歴に積む。読み直したタグは入れたとおりのキーと値', async ({ page }) => {
        await open(page);
        const op: EditOp = { kind: 'setTag', nodes: [{ id: TASK_A, refText: 'Task A' }], key: 'a.b', value: 'say "hi"', replaceKey: null };
        const outcome = await tryEdit(page, TAGS_DOC, op);
        expect(outcome.status === 'edited' ? outcome.source : outcome).toBe(TAGS_QUOTED);

        await mount(page, TAGS_DOC);
        await useSelectTool(page);
        await pressLabel(page, TASK_A);
        await expectSelected(page, { id: TASK_A, refText: 'Task A' });
        await page.keyboard.press('t');
        await expect.poll(() => tagFieldsOf(page)).toEqual({ count: 1, fields: ['', ''], focused: 0 });
        await fillTagField(page, 0, 'a.b');
        await fillTagField(page, 1, 'say "hi"');
        await page.keyboard.press('Enter');
        await expectSource(page, TAGS_QUOTED, [TAGS_QUOTED]);
        await expectNotice(page, 'info');
        expect(await tagsOf(page, TASK_A)).toEqual([{ key: 'a.b', values: ['say "hi"'] }]);
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});


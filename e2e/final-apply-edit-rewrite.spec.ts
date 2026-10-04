// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 6、7、8、10、11、12、13、15) を、ビルドした配布物の markdag/editor で、
// 直す前に落ちるテストとして書く。records/final-gate/ の b115、b121、b096、refusals の頁で撮った GUI の操作 (撮る道具の手順) が、
// 断らずに原文を書き換えることを見る (原文、onChange、通知 (.mdag-editor-snackbar と data-kind)、入力、履歴)。
// 1. B-115: 凡例の行を押して Enter で開いた名前の入力で、組でない定義 (dev: 開発) のグループの名前を変えると、組に書き直して書く
// 2. B-121: 怠惰な続きの行を含む詳細の入力の初めの値は図と同じ 2 行で、保存すると詳細の行を全部 > 付きで書き直す。変えずに保存しても > を補う (改めた細部 9)
// 3. B-096: 見出しの下のリストが 2 つある文書で J を押すと、2 つ目のリストの最後に合流ノードを足す
// 4. 原文の都合で断っていた操作 (refusals の頁): 下線の見出しの ⌘G (marker-line)、groups: {} の ⌘G (flow-style)、depends: | への線 (block-scalar)、
//    BOM のすぐあとが --- の文書の ⌘G (bom)、見出しの D と帯の詳細編集 (heading-details) は書き換える
// 5. 変えない: ambiguous-reference (同じ $id が 2 つ)、block-node (表への子)、frontmatter-invalid (壊れた YAML) は今のまま断る
// どの文書も mount の mode: 'edit' で GUI 編集にする (BOM や壊れた YAML の文書は markdag.editor を読めないため)。
// 期待の原文は規則から書き、配布物の editSource で同じ原文になることもテストの中で確かめる (期待の空振りの防ぎ。直す前はここで落ちる)。
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
const BOM = '\u{feff}';
const FM = ['---', 'markdag:', '---', ''];
// 新しいグループ group1 の定義 (markdag の下の groups から。字下げの幅 4)
const GROUP1 = ['    groups:', '        group1:', '            label: グループ 1', '            color: "#3B7DD8"', '            boundary: true'];

const lines = (...items: string[]): string => items.join('\n');

// records/final-gate/b115 の文書: dev の定義が組でない (1 行の文字)。ノードは 計画 1、設計 2、実装 3、テスト 4
const B115_BODY = ['', '# 計画', '', '- 設計 %dev', '- 実装', '- テスト', ''];
const B115_DOC = lines('---', 'markdag:', '    groups:', '        dev: 開発', '---', ...B115_BODY);
const B115_AFTER = lines('---', 'markdag:', '    groups:', '        dev:', '            label: 開発班', '---', ...B115_BODY);

// records/final-gate/b121 の文書: 設計の詳細の引用に > のない続きの行がある。ノードは 計画 1、設計 2、実装 3
const B121_DOC = lines(...FM, '# 計画', '', '- 設計', '    > 画面の案', '    続きの行', '- 実装', '');
const B121_DETAILS = '画面の案\n続きの行';
const B121_AFTER = lines(...FM, '# 計画', '', '- 設計', '    > 画面の案を直した', '- 実装', '');
// 中身を変えずに保存したとき: 続きの行に > を補うだけ (b121 の頁の案 (a) の見本 4-filled.png。改めた細部 9、D-081)
const B121_FILLED = lines(...FM, '# 計画', '', '- 設計', '    > 画面の案', '    > 続きの行', '- 実装', '');

// records/final-gate/b096 の文書: 見出しの下にリストが 2 つ (入れ物 2 と 5)。ノードは 計画 1、入れ物 2、設計 3、実装 4、入れ物 5、公開 6、運用 7
const B096_BODY = ['# 計画', '', '- 設計', '- 実装', '', '段落', '', '- 公開', '- 運用'];
const B096_DOC = lines(...FM, ...B096_BODY, '');
const JOIN_LABEL = '合流点';
const B096_AFTER = lines('---', 'markdag:', '    relations:', '        join:', `            - 設計 & 公開 --> ${JOIN_LABEL}`, '---', '', ...B096_BODY, `- ${JOIN_LABEL}`, '');

// records/final-gate/refusals の文書
const SETEXT_DOC = lines(...FM, '# 計画', '', '設計', '---', '', '- 画面', '');
const SETEXT_AFTER = lines('---', 'markdag:', ...GROUP1, '---', '', '# 計画', '', '## 設計 %group1', '', '- 画面', '');
const FLOW_DOC = lines('---', 'markdag:', '    groups: {}', '---', '', '# 計画', '', '- 設計', '- 実装', '');
const FLOW_AFTER = lines('---', 'markdag:', ...GROUP1, '---', '', '# 計画', '', '- 設計 %group1', '- 実装', '');
const SCALAR_DOC = lines('---', 'markdag:', '    relations:', '        depends: |', '            設計 --> 実装', '---', '', '# 計画', '', '- 設計', '- 実装', '- テスト', '');
const SCALAR_AFTER = lines('---', 'markdag:', '    relations:', '        depends:', '            - 設計 --> 実装', '            - 実装 --> テスト', '---', '', '# 計画', '', '- 設計', '- 実装', '- テスト', '');
const BOM_DOC = `${BOM}${lines(...FM, '# 計画', '', '- 設計', '- 実装', '')}`;
const BOM_AFTER = lines('---', 'markdag:', ...GROUP1, '---', '', '# 計画', '', '- 設計 %group1', '- 実装', '');
const HEADING_DOC = lines(...FM, '# 計画', '', '## 設計', '', '## 実装', '');
const HEADING_AFTER = lines(...FM, '# 計画', '', '## 設計', '> メモ', '', '## 実装', '');
// 断るままのもの
const AMBIGUOUS_DOC = lines(...FM, '# 計画', '', '- 設計 $x', '- 設計 $x', '- 実装', '');
const TABLE_DOC = lines(...FM, '# 計画', '', '## 設計', '', '| 画面 | 担当 |', '| --- | --- |', '| 一覧 | 山田 |', '');
const INVALID_DOC = lines('---', 'markdag:', '    groups: [', '---', '', '# 計画', '', '- 設計', '- 実装', '');
// 本文が 2 行の下線の見出し (名前は 1 行目の「設計」。つなぐと名前が変わるので印を書けない)。ノードは 計画 1、設計 2、画面 3
const TWO_LINE_SETEXT_DOC = lines(...FM, '# 計画', '', '設計', 'の続き', '---', '', '- 画面', '');

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

// mount の mode: 'edit' で GUI 編集にして描く
async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            animate: false,
            mode: 'edit',
            onChange: (next) => {
                target.changes.push({ root: 'a', markdown: next });
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
    expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('edit');
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 図を片付けて、同じページで描き直す。onChange の記録も空にする
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
const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
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

// ノードの箱を押す (名前のない表のノード)
async function pressBox(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

// 選んでいるノード (getSelection) の id と refText (id の昇順)
async function selectedNodes(page: Page): Promise<NodeTarget[] | string> {
    const selection = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() ?? null);
    if (selection === null) return 'none';
    return selection.kind === 'nodes' ? [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText })) : selection.kind;
}

async function expectSelected(page: Page, ...targets: NodeTarget[]): Promise<void> {
    await expect.poll(() => selectedNodes(page)).toEqual(targets);
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

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

interface InputState {
    // 見えている入力の数
    count: number;
    // 入力の値 (1 つのときだけ)
    value: string | null;
    // フォーカスが入力の中にある
    focused: boolean;
}

// 名前の入力 (data-for が node か group) か、詳細の入力 (.mdag-editor-details-editor のテキストエリア)
async function inputOf(page: Page, selector: string): Promise<InputState> {
    return page.evaluate((selector) => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...container.querySelectorAll(selector)].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, focused: false };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
        return { count: 1, value, focused };
    }, selector);
}

const NODE_NAME_INPUT = '.mdag-editor-name-input[data-for="node"]';
const GROUP_NAME_INPUT = '.mdag-editor-name-input[data-for="group"]';
const DETAILS_EDITOR = '.mdag-editor-details-editor';

// 入力が 1 つ開き、フォーカスがあって、値が value になるまで待つ
async function expectInput(page: Page, selector: string, value: string, message?: string): Promise<void> {
    await expect.poll(() => inputOf(page, selector), message).toEqual({ count: 1, value, focused: true });
}

async function expectInputClosed(page: Page, selector: string, message?: string): Promise<void> {
    await expect.poll(async () => (await inputOf(page, selector)).count, message).toBe(0);
}

// 入力の値を全部選んで text を打つ
async function replaceText(page: Page, selector: string, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
    await expect.poll(async () => (await inputOf(page, selector)).value).toBe(text);
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

// 配布物の editSource で同じ書き換えを試す (期待の原文と断る理由を確かめる。期待の空振りの防ぎ)
const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | EditOutcome => (outcome.status === 'edited' ? outcome.source : outcome);

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

// 描いている文書のモデルの、グループの id と label (定義の順)
async function groupLabels(page: Page): Promise<Array<[string, string]>> {
    return page.evaluate(() => {
        const doc = (window as unknown as EditorWindow).editors.a?.view.getDocument();
        return (doc?.model.groups ?? []).map((group): [string, string] => [group.id, group.label]);
    });
}

// 描いている文書のモデルの relations (kind:始点>終点)
async function relationKeys(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const doc = (window as unknown as EditorWindow).editors.a?.view.getDocument();
        return (doc?.model.relations ?? []).map((relation) => `${relation.kind}:${relation.source}>${relation.target}`).sort();
    });
}

// 選んだノードの線を引く点を、相手のノードの箱までドラッグして離す
async function dragLink(page: Page, from: number, to: number): Promise<void> {
    await pressLabel(page, from);
    const handle = await spot(page, { on: 'element', selector: '#a .mdag-editor-handle[data-handle="link"]' });
    const end = await spot(page, { on: 'element', selector: `${nodeSelector(to)} .mdag-box` });
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    try {
        await page.mouse.move(end.x, end.y, { steps: 12 });
    } finally {
        await page.mouse.up();
    }
}

test.describe('B-115: 組でないグループの定義の名前を変える (plan.md の 6。records/final-gate/b115)', () => {
    test('@editor 凡例の dev の行を押して Enter で開いた名前の入力で「開発班」にして Enter すると、dev: 開発 を label の組に書き直して書く。凡例は「開発班」になり、通知 (info) が出て履歴に積む', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, B115_DOC, { kind: 'renameGroup', group: 'dev', label: '開発班' }))).toBe(B115_AFTER);
        await mount(page, B115_DOC);
        expect(await groupLabels(page)).toEqual([['dev', 'dev']]);

        // b115-shot.mjs の手順: 凡例の行の名前のあたりを押してグループを選び、Enter で名前の入力を開く
        const row = await page.evaluate(() => {
            const item = [...document.querySelectorAll('#a .mdag-editor-legend-row[data-group="dev"]')].find((element) => element.checkVisibility());
            if (!item) return null;
            const rect = item.getBoundingClientRect();
            return { x: rect.x + 40, y: rect.y + rect.height / 2 };
        });
        if (!row) throw new Error('凡例の dev の行がない');
        await press(page, row);
        await page.keyboard.press('Enter');
        await expectInput(page, GROUP_NAME_INPUT, 'dev');
        await replaceText(page, GROUP_NAME_INPUT, '開発班');
        await page.keyboard.press('Enter');
        await expectSource(page, B115_AFTER, [B115_AFTER]);
        await expectInputClosed(page, GROUP_NAME_INPUT);
        await expectNotice(page, 'info');
        await expect.poll(() => groupLabels(page)).toEqual([['dev', '開発班']]);
        await expect(visible(page, '#a .mdag-editor-legend-row[data-group="dev"]')).toContainText('開発班');
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('B-121: 怠惰な続きの行を含む詳細 (plan.md の 7。records/final-gate/b121)', () => {
    test('@editor 設計を選んで D で開いた詳細の入力の初めの値は、図と同じく続きの行も入れた 2 行。書き換えて ⌘Enter で保存すると、詳細の行を全部 > 付きで書き直し、通知 (info) が出て履歴に積む', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, B121_DOC, { kind: 'setDetails', node: { id: 2, refText: '設計' }, text: '画面の案を直した' }))).toBe(B121_AFTER);
        await mount(page, B121_DOC);
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'item', details: B121_DETAILS });

        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('d');
        await expectInput(page, DETAILS_EDITOR, B121_DETAILS);
        await replaceText(page, DETAILS_EDITOR, '画面の案を直した');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, B121_AFTER, [B121_AFTER]);
        await expectInputClosed(page, DETAILS_EDITOR);
        await expectNotice(page, 'info');
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });

    test('@editor 詳細の入力を開いて中身を変えずに ⌘Enter で保存すると、原文の続きの行に > を補い (onChange 1 回、履歴に積む)、図の詳細は 2 行のまま (改めた細部 9。D-081)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, B121_DOC, { kind: 'setDetails', node: { id: 2, refText: '設計' }, text: B121_DETAILS }))).toBe(B121_FILLED);
        await mount(page, B121_DOC);
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('d');
        await expectInput(page, DETAILS_EDITOR, B121_DETAILS);
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectInputClosed(page, DETAILS_EDITOR);
        await expectSource(page, B121_FILLED, [B121_FILLED]);
        // 図の詳細は 2 行のまま (図が描いている解析の詳細と、詳細の入力の初めの値)
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const node = (window as unknown as EditorWindow).editors.a?.view.getDocument()?.parsed.nodes.find((entry) => entry.id === 2);
                    return node?.details ?? null;
                }),
            )
            .toMatch(/画面の案[\s\S]*続きの行/);
        expect(await factsOf(page, 2)).toMatchObject({ details: B121_DETAILS });
        await expect(toolButton(page, 'undo')).toBeEnabled();
    });
});

test.describe('B-096: 新しい合流ノードをリストの入れ物の最後に足す (plan.md の 8。records/final-gate/b096)', () => {
    test('@editor 設計と公開を選んで J を押すと、2 つ目のリストの最後 (運用のあと) に「合流点」を足して join を書く。合流点が選ばれて名前の入力が開き、通知 (info) が出る', async ({ page }) => {
        await open(page);
        const op: EditOp = { kind: 'joinIntoNew', sources: [{ id: 3, refText: '設計' }, { id: 6, refText: '公開' }], label: JOIN_LABEL };
        expect(editedSource(await tryEdit(page, B096_DOC, op))).toBe(B096_AFTER);
        await mount(page, B096_DOC);

        // b096-shot.mjs の手順: 設計を押し、Shift を押しながら公開を押して、J
        await pressLabel(page, 3);
        await pressLabel(page, 6, 'Shift');
        await expectSelected(page, { id: 3, refText: '設計' }, { id: 6, refText: '公開' });
        await page.keyboard.press('j');
        await expectSource(page, B096_AFTER, [B096_AFTER]);
        await expect(labelOf(page, 8)).toHaveText(JOIN_LABEL);
        await expect.poll(() => relationKeys(page)).toEqual(['join:3>8', 'join:6>8']);
        await expectSelected(page, { id: 8, refText: JOIN_LABEL });
        await expectInput(page, NODE_NAME_INPUT, JOIN_LABEL);
        await expectNotice(page, 'info');
    });
});

test.describe('原文の都合で断っていた GUI の操作 (plan.md の 10、11、12、13、15。records/final-gate/refusals)', () => {
    test('@editor 下線の見出しを選んで ⌘G を押すと、見出しを ## の形に書き直して %group1 を付け、グループの名前の入力が開き、通知 (info) が出る (marker-line)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, SETEXT_DOC, { kind: 'groupNodes', nodes: [{ id: 2, refText: '設計' }] }))).toBe(SETEXT_AFTER);
        await mount(page, SETEXT_DOC);
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'heading', canMark: true });
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, SETEXT_AFTER, [SETEXT_AFTER]);
        await expectInput(page, GROUP_NAME_INPUT, 'グループ 1');
        await expectNotice(page, 'info');
    });

    test('@editor groups: {} の文書でノードを選んで ⌘G を押すと、字下げの形に書き直して定義を足し、%group1 を付ける (flow-style)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, FLOW_DOC, { kind: 'groupNodes', nodes: [{ id: 2, refText: '設計' }] }))).toBe(FLOW_AFTER);
        await mount(page, FLOW_DOC);
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, FLOW_AFTER, [FLOW_AFTER]);
        await expectInput(page, GROUP_NAME_INPUT, 'グループ 1');
        await expectNotice(page, 'info');
    });

    test('@editor depends: | の文書で実装からテストへ線を引くと、- の一覧に書き直して線を足す。モデルに 2 本の線が出て、通知 (info) が出る (block-scalar)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, SCALAR_DOC, { kind: 'addRelation', from: { id: 3, refText: '実装' }, to: { id: 4, refText: 'テスト' } }))).toBe(SCALAR_AFTER);
        await mount(page, SCALAR_DOC);
        expect(await relationKeys(page)).toEqual(['depends:2>3']);
        await dragLink(page, 3, 4);
        await expectSource(page, SCALAR_AFTER, [SCALAR_AFTER]);
        await expect.poll(() => relationKeys(page)).toEqual(['depends:2>3', 'depends:3>4']);
        await expectNotice(page, 'info');
    });

    test('@editor BOM のすぐあとが --- の行の文書でノードを選んで ⌘G を押すと、BOM を外してその frontmatter にグループの定義を書き、%group1 を付ける (bom)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, BOM_DOC, { kind: 'groupNodes', nodes: [{ id: 2, refText: '設計' }] }))).toBe(BOM_AFTER);
        await mount(page, BOM_DOC);
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectSource(page, BOM_AFTER, [BOM_AFTER]);
        await expectInput(page, GROUP_NAME_INPUT, 'グループ 1');
        await expectNotice(page, 'info');
    });

    test('@editor 見出しを選ぶと帯の「詳細編集」が押せ、D でも詳細の入力が開く。書いて ⌘Enter で保存すると、見出しのすぐ下に > の行を書き、図の見出しが詳細を持つ (heading-details。D-042 の見出しの確かめ)', async ({ page }) => {
        await open(page);
        expect(editedSource(await tryEdit(page, HEADING_DOC, { kind: 'setDetails', node: { id: 2, refText: '設計' }, text: 'メモ' }))).toBe(HEADING_AFTER);
        await mount(page, HEADING_DOC);
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'heading', canHaveDetails: true, details: null });

        // 帯の「詳細編集」で開いて、Esc で閉じる
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await pressBar(page, 'details');
        await expectInput(page, DETAILS_EDITOR, '', '帯の詳細編集');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, DETAILS_EDITOR, '帯の詳細編集の Esc');
        await expectSourceStill(page, HEADING_DOC, []);

        // D で開いて書く
        await expectSelected(page, { id: 2, refText: '設計' });
        await page.keyboard.press('d');
        await expectInput(page, DETAILS_EDITOR, '', 'D');
        await page.keyboard.type('メモ');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expectSource(page, HEADING_AFTER, [HEADING_AFTER]);
        await expectInputClosed(page, DETAILS_EDITOR);
        await expectNotice(page, 'info');
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
    });

    test('@editor 変えない: 本文が 2 行の下線の見出しは canMark が false で、帯のタグ追加とタグ選択が押せず、⌘G は原文を変えずに通知 (error) を出す (marker-line。メインの決定)', async ({ page }) => {
        await open(page);
        const outcome = await tryEdit(page, TWO_LINE_SETEXT_DOC, { kind: 'groupNodes', nodes: [{ id: 2, refText: '設計' }] });
        expect(outcome.status === 'refused' ? outcome.reason.code : outcome).toBe('marker-line');
        await mount(page, TWO_LINE_SETEXT_DOC);
        expect(await factsOf(page, 2)).toMatchObject({ kind: 'heading', canMark: false });
        await pressLabel(page, 2);
        await expectSelected(page, { id: 2, refText: '設計' });
        await expectBarDisabled(page, 'tag-add', '帯のタグ追加');
        await expectBarDisabled(page, 'tag-select', '帯のタグ選択');
        await page.keyboard.press('ControlOrMeta+KeyG');
        await expectNotice(page, 'error');
        await expectSourceStill(page, TWO_LINE_SETEXT_DOC, []);
        await expect(toolButton(page, 'undo')).toBeDisabled();
    });

    test('@editor 変えない: 同じ $id が 2 つのノードへの線 (ambiguous-reference)、表への子の追加 (block-node)、壊れた YAML の文書の ⌘G (frontmatter-invalid) は、原文を変えずに通知 (error) を出す', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        const cases: Array<{ name: string; doc: string; op: EditOp; code: string; act: () => Promise<void> }> = [
            {
                name: 'ambiguous-reference',
                doc: AMBIGUOUS_DOC,
                op: { kind: 'addRelation', from: { id: 4, refText: '実装' }, to: { id: 3, refText: '設計' } },
                code: 'ambiguous-reference',
                act: () => dragLink(page, 4, 3),
            },
            {
                name: 'block-node',
                doc: TABLE_DOC,
                op: { kind: 'addChild', parent: { id: 3, refText: '' }, label: '新しいノード' },
                code: 'block-node',
                act: async () => {
                    await pressBox(page, 3);
                    await expectSelected(page, { id: 3, refText: '' });
                    await page.keyboard.press('Tab');
                },
            },
            {
                name: 'frontmatter-invalid',
                doc: INVALID_DOC,
                op: { kind: 'groupNodes', nodes: [{ id: 2, refText: '設計' }] },
                code: 'frontmatter-invalid',
                act: async () => {
                    await pressLabel(page, 2);
                    await expectSelected(page, { id: 2, refText: '設計' });
                    await page.keyboard.press('ControlOrMeta+KeyG');
                },
            },
        ];
        let first = true;
        for (const item of cases) {
            const outcome = await tryEdit(page, item.doc, item.op);
            expect(outcome.status === 'refused' ? outcome.reason.code : outcome, item.name).toBe(item.code);
            if (first) await mount(page, item.doc);
            else await remount(page, item.doc);
            first = false;
            await item.act();
            await expectNotice(page, 'error', item.name);
            await expectSourceStill(page, item.doc, [], item.name);
            await expect(toolButton(page, 'undo'), item.name).toBeDisabled();
        }
    });
});

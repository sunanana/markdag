// GUI 編集のキーの手直しの最後の関門で、依頼者が修正案 (amendments.md) に答えた挙動 (2026-10-07) のうち、画面の操作と公開の口
// (MarkdagDiagram.toggleTasks、view.addHooks) のものを、ビルドした配布物の markdag/core と markdag/editor で、直す前に落ちるテストとして書く。
// 期待は答えから書き、今の作りの出力はなぞらない。
// - K-003 (b): Space (と toggleTasks) でまとめて進めるとき、確かめる順は relations の上流と下流の関係の順 (上流が先)。原文のリストに書いた順や
//   選んだ順には関係しない。原文の並びは書き換えない。上流と下流の関係のないもの同士は文書の順。
//   上流は requireUpstreamDone と同じもの (祖先に入る線と、選んでいないタスクを挟む線もたどる。レビューの G-03 で足した見張り)。
//   両方を満たせない並びは、選んだ中にまだ確かめていない上流を持たないもののうち、文書で先のものから確かめる
// - K-005 (b): 見出しのない文書のルートの名前の入力は、原文の title の文字のまま (書式の記法を含む) で開き、少し直して決めても書式が残る
// - K-006 (b): 確かめの順で 1 つ目が断られたら、そこで確かめをやめる。断られたあとのタスクの beforeTaskToggle (アプリのフック) は呼ばず、
//   知らせ (onDiagnostic の hook-rejected) は最初に断られた 1 件の理由だけ
// - K-007 (b): まとめて進めたとき (toggleTasks と Space) も、印のクリックと同じく、アプリが view.addHooks で足した onToggleTask を、選んだタスク
//   ごとに 1 回ずつ、確かめの順に呼ぶ。進めたときは原文を書き換えて描き直したあと。規則やフックで取りやめになったときも呼ぶ。
//   1 回でタスクは 1 段だけ進む (markdag 自身の受け口は呼び直さない)。印のクリックの挙動は今のまま
// 見た目そのものは見ない。原文の全文、onChange の呼ばれ方、onDiagnostic に届いた診断 (code と message)、アプリの beforeTaskToggle の呼ばれ方、
// 足した onToggleTask の呼ばれ方 (呼ばれた時点の原文と描いている文書のタスクの状態)、選択、名前の入力の値を見る。
// 反映は expect.poll で待ち、「変わらない」「呼ばれない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { Diagnostic, MarkdagDiagram, NodeTarget, OutlineNode, TaskMark } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

// 足した onToggleTask が呼ばれたときの記録
interface ToggleRecord {
    name: string;
    // 呼ばれた時点の原文 (render の図の diagram.source)。GUI 編集の図では記録しない (編集の層の原文は onChange で追うので、
    // 描き直したあとかどうかは drawn で見る)
    source: string | null;
    // 呼ばれた時点で描いている文書の、そのタスクの状態
    drawn: string | null;
}

type GateWindow = Window & {
    editorHarness: EditorHarness;
    editor: MarkdagEditor | null;
    diagram: MarkdagDiagram | null;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
    // onDiagnostic に届いた診断
    diagnostics: Array<{ code: string; message: string }>;
    // アプリの beforeTaskToggle が呼ばれたタスク (呼ばれた順)
    asked: string[];
    // アプリの beforeTaskToggle が「<名前> を断る」の理由で断るタスク
    rejecting: string[];
    // view.addHooks で足した onToggleTask の記録
    toggles: ToggleRecord[];
};

const DIST = resolve('dist');

// ---- 文書 ----

// タスクの文書。1 確認 / 2 点検 / 3 報告 / 4 片付け (タスクでない)
const TASKS = '# 確認\n\n- [ ] 点検\n- [ ] 報告\n- 片付け\n';
const TASKS_DONE = '# 確認\n\n- [x] 点検\n- [x] 報告\n- 片付け\n';

// タスク 3 つ (relations なし)。1 確認 / 2 点検 / 3 報告 / 4 片付け
const THREE = '# 確認\n\n- [ ] 点検\n- [ ] 報告\n- [ ] 片付け\n';

// 依頼者の例: 要件の確定 → 設計 → 実装 (depends) と requireUpstreamDone。原文のリストでは下流を上に書く (実装、設計、要件の確定 の順)。
// marks は 実装、設計、要件の確定 の印。1 リリース / 2 実装 / 3 設計 / 4 要件の確定
function reversed(marks: [string, string, string]): string {
    return [
        '---',
        'markdag:',
        '    rules:',
        '        taskToggle:',
        '            requireUpstreamDone: true',
        '    relations:',
        '        depends:',
        '            - 要件の確定 --> 設計',
        '            - 設計 --> 実装',
        '---',
        '',
        '# リリース',
        '',
        `- [${marks[0]}] 実装`,
        `- [${marks[1]}] 設計`,
        `- [${marks[2]}] 要件の確定`,
        '',
    ].join('\n');
}

// 規則のない文書で、上流と下流 (設計 --> 実装) と、それと関係のないタスク (メモ、片付け)。文書の順は メモ、実装、設計、片付け。
// marks はその順の印。1 リリース / 2 メモ / 3 実装 / 4 設計 / 5 片付け
function mixed(marks: [string, string, string, string] = [' ', ' ', ' ', ' ']): string {
    return [
        '---',
        'markdag:',
        '    relations:',
        '        depends:',
        '            - 設計 --> 実装',
        '---',
        '',
        '# リリース',
        '',
        `- [${marks[0]}] メモ`,
        `- [${marks[1]}] 実装`,
        `- [${marks[2]}] 設計`,
        `- [${marks[3]}] 片付け`,
        '',
    ].join('\n');
}

// 祖先に入る線: 設計 --> 実装 の線は見出しのタスク (実装) に入り、その下の子 (コード) には直の線がない。下流の見出しを上に書く。
// requireUpstreamDone はコードの祖先 (実装) に入る線をたどって、設計を上流に数える。
// marks は 実装、コード、設計 の印。1 リリース / 2 実装 / 3 コード / 4 設計
function layered(marks: [string, string, string] = [' ', ' ', ' ']): string {
    return [
        '---',
        'markdag:',
        '    rules:',
        '        taskToggle:',
        '            requireUpstreamDone: true',
        '    relations:',
        '        depends:',
        '            - 設計 --> 実装',
        '---',
        '',
        '# リリース',
        '',
        `## [${marks[0]}] 実装`,
        '',
        `- [${marks[1]}] コード`,
        '',
        `## [${marks[2]}] 設計`,
        '',
    ].join('\n');
}

// 上流と下流の順と文書の順を両方は満たせない並び: 文書の順は 実装、メモ、設計 で、設計 --> 実装 (規則なし)。
// marks はその順の印。1 リリース / 2 実装 / 3 メモ / 4 設計
function tangled(marks: [string, string, string] = [' ', ' ', ' ']): string {
    return [
        '---',
        'markdag:',
        '    relations:',
        '        depends:',
        '            - 設計 --> 実装',
        '---',
        '',
        '# リリース',
        '',
        `- [${marks[0]}] 実装`,
        `- [${marks[1]}] メモ`,
        `- [${marks[2]}] 設計`,
        '',
    ].join('\n');
}

// ---- 開く ----

interface Point {
    x: number;
    y: number;
}

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

// 開く前に navigator.platform を mac に見せかける。rejecting は、アプリの beforeTaskToggle が断るタスクの名前
async function open(page: Page, rejecting: string[] = []): Promise<void> {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true }));
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate((rejecting) => {
        const target = window as unknown as GateWindow;
        target.editor = null;
        target.diagram = null;
        target.changes = [];
        target.diagnostics = [];
        target.asked = [];
        target.rejecting = rejecting;
        target.toggles = [];
    }, rejecting);
}

// どちらの図を見るか (GUI 編集の editor か、render の diagram)。どちらの図にも、アプリのフック (beforeTaskToggle を記録し、rejecting の
// タスクを断る) を渡し、view.addHooks で onToggleTask (呼ばれた時点の名前と、描いている文書のタスクの状態を記録する) を足す
type Prepared = 'editor' | 'diagram';

// GUI 編集で開く (mount の mode: edit)。アプリのフックを渡し、onToggleTask を view.addHooks で足す
async function mountEditor(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as GateWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            mode: 'edit',
            animate: false,
            onChange: (next) => void target.changes.push(next),
            onDiagnostic: (diagnostic: Diagnostic) => void target.diagnostics.push({ code: diagnostic.code, message: diagnostic.message }),
            hooks: {
                beforeTaskToggle: (context) => {
                    target.asked.push(context.node.text);
                    if (!target.rejecting.includes(context.node.text)) return undefined;
                    context.reject(`${context.node.text} を断る`);
                    return false;
                },
            },
        };
        const editor = target.editorHarness.editor.mountEditor(container, markdown, options);
        target.editor = editor;
        editor.view.addHooks({
            onToggleTask: (node: OutlineNode, _cycle: readonly TaskMark[]) => {
                const drawn = editor.view.getDocument()?.parsed.nodes.find((item) => item.id === node.id)?.task?.state ?? null;
                target.toggles.push({ name: node.refText, source: null, drawn });
            },
        });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// render (markdag/core) で閲覧の図を描く。アプリのフックを渡し、onToggleTask を view.addHooks で足す
async function renderDiagram(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as GateWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const diagram = target.editorHarness.core.render(container, markdown, {
            animate: false,
            onChange: (next) => void target.changes.push(next),
            onDiagnostic: (diagnostic) => void target.diagnostics.push({ code: diagnostic.code, message: diagnostic.message }),
            hooks: {
                beforeTaskToggle: (context) => {
                    target.asked.push(context.node.text);
                    if (!target.rejecting.includes(context.node.text)) return undefined;
                    context.reject(`${context.node.text} を断る`);
                    return false;
                },
            },
        });
        target.diagram = diagram;
        diagram.view.addHooks({
            onToggleTask: (node: OutlineNode) => {
                const drawn = diagram.view.getDocument()?.parsed.nodes.find((item) => item.id === node.id)?.task?.state ?? null;
                target.toggles.push({ name: node.refText, source: diagram.source, drawn });
            },
        });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「呼ばれない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const sourceOf = (page: Page, from: Prepared): Promise<string | undefined> =>
    page.evaluate((from) => {
        const target = window as unknown as GateWindow;
        return from === 'editor' ? target.editor?.getSource() : target.diagram?.source;
    }, from);
const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as GateWindow).changes]);
const diagnosticLog = (page: Page): Promise<Array<{ code: string; message: string }>> => page.evaluate(() => [...(window as unknown as GateWindow).diagnostics]);
const askedLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as GateWindow).asked]);
const toggleLog = (page: Page): Promise<ToggleRecord[]> => page.evaluate(() => [...(window as unknown as GateWindow).toggles]);
const rejectedMessages = async (page: Page): Promise<string[]> => (await diagnosticLog(page)).filter((item) => item.code === 'hook-rejected').map((item) => item.message);

async function expectSource(page: Page, from: Prepared, source: string, changes: string[], message?: string): Promise<void> {
    await expect.poll(() => sourceOf(page, from), message).toBe(source);
    await expect.poll(() => changeLog(page), message).toEqual(changes);
}

async function expectSourceStill(page: Page, from: Prepared, source: string, message?: string): Promise<void> {
    await settle(page);
    expect(await sourceOf(page, from), message).toBe(source);
    expect(await changeLog(page), message).toEqual([]);
}

// 名前で引いたノードの id (描いている文書)
async function idOf(page: Page, from: Prepared, name: string): Promise<number> {
    const id = await page.evaluate(
        ({ from, name }) => {
            const target = window as unknown as GateWindow;
            const view = from === 'editor' ? target.editor?.view : target.diagram?.view;
            const found = (view?.getDocument()?.parsed.nodes ?? []).filter((node) => node.refText === name);
            return found.length === 1 ? found[0]!.id : null;
        },
        { from, name },
    );
    if (id === null) throw new Error(`名前「${name}」のノードが 1 つではない`);
    return id;
}

// render の図の toggleTasks を、名前で引いた id (names の順) で呼ぶ
async function toggleTasks(page: Page, names: string[]): Promise<boolean> {
    const ids = await Promise.all(names.map((name) => idOf(page, 'diagram', name)));
    return page.evaluate((ids) => (window as unknown as GateWindow).diagram?.toggleTasks(ids) ?? false, ids);
}

type SelectionState = NodeTarget[] | string;

// 選んでいるもの。ノードは id の昇順の id と refText、ノードでなければ kind
const selectionOf = (page: Page): Promise<SelectionState> =>
    page.evaluate(() => {
        const selection = (window as unknown as GateWindow).editor?.getSelection();
        if (!selection || selection.kind === 'none') return [];
        if (selection.kind !== 'nodes') return selection.kind;
        return [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText }));
    });

const target = (id: number, refText: string): NodeTarget => ({ id, refText });

// ---- 押す ----

const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

type Spot = { on: 'element'; selector: string } | { on: 'text'; selector: string };

// 画面の座標で押せる点を探す (図の領域はスクロールを戻すので、座標を決めて page.mouse で押す)
async function spot(page: Page, where: Spot): Promise<Point> {
    const found = await page.evaluate((where) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const element = [...document.querySelectorAll(where.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        if (where.on === 'element') {
            const rect = element.getBoundingClientRect();
            const step = Math.max(2, Math.min(rect.width, rect.height) / 8);
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const points: Point[] = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
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
    }, where);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(where)}`);
    return found;
}

async function press(page: Page, point: Point, modifier?: string): Promise<void> {
    await page.mouse.move(point.x, point.y);
    if (modifier) await page.keyboard.down(modifier);
    try {
        await page.mouse.down();
        await page.mouse.up();
    } finally {
        if (modifier) await page.keyboard.up(modifier);
    }
}

// ノードの箱を押す
async function pressNode(page: Page, id: number, modifier?: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }), modifier);
}

// ノードの文字の上を押す (タスクのノードは先頭の絵を押すと印が進むので、文字の上を押して選ぶ)
async function pressLabel(page: Page, id: number, modifier?: string): Promise<void> {
    await press(page, await spot(page, { on: 'text', selector: `${nodeSelector(id)} .mdag-content` }), modifier);
}

// GUI 編集で名前の順にノードを選ぶ (2 つ目からは Shift を押したまま押して選択に足す)
async function selectNames(page: Page, names: string[]): Promise<void> {
    const ids = await Promise.all(names.map((name) => idOf(page, 'editor', name)));
    await pressLabel(page, ids[0]!);
    for (const id of ids.slice(1)) await pressLabel(page, id, 'Shift');
    await expect.poll(async () => ((await selectionOf(page)) as NodeTarget[]).map((node) => node.refText).sort()).toEqual([...names].sort());
}

// ---- 名前の入力 ----

interface InputState {
    count: number;
    value: string | null;
    focused: boolean;
}

const nameInputOf = (page: Page): Promise<InputState> =>
    page.evaluate(() => {
        const shown = [...document.querySelectorAll('#a .mdag-editor-name-input[data-for="node"]')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false };
        const field = element.matches('input, textarea') ? element : element.querySelector('input, textarea');
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return { count: 1, value: null, focused: false };
        return { count: 1, value: field.value, focused: document.activeElement === field };
    });

// 名前の入力が 1 つ開いてフォーカスがあり、値が value で、選んでいるノードが selected になるまで待つ
async function expectNameInput(page: Page, value: string, selected: NodeTarget, message?: string): Promise<void> {
    await expect.poll(() => nameInputOf(page), message).toEqual({ count: 1, value, focused: true });
    await expect.poll(() => selectionOf(page), message).toEqual([selected]);
}

// ---- K-003 ----

test.describe('K-003: まとめて進めるときは、relations の上流 (要件の確定 → 設計 → 実装) から確かめる。原文に書いた順と選んだ順には関係しない', () => {
    for (const order of [
        ['設計', '実装'],
        ['実装', '設計'],
    ]) {
        test(`@editor toggleTasks([${order.join(', ')}]): 要件の確定が完了なら、設計を進めた結果で実装を確かめ、両方進む (書き換えは 1 回。原文の並びは変えない)`, async ({ page }) => {
            await open(page);
            await renderDiagram(page, reversed([' ', ' ', 'x']));
            expect(await toggleTasks(page, order)).toBe(true);
            const toggled = reversed(['x', 'x', 'x']);
            await expectSource(page, 'diagram', toggled, [toggled]);
            expect(await rejectedMessages(page)).toEqual([]);
            expect(await askedLog(page), 'アプリの beforeTaskToggle は上流から').toEqual(['設計', '実装']);
        });

        test(`@editor toggleTasks([${order.join(', ')}]): 要件の確定が未完了なら何も変えない。最初に確かめるのは設計 (先に終えるもの: 要件の確定)`, async ({ page }) => {
            await open(page);
            const source = reversed([' ', ' ', ' ']);
            await renderDiagram(page, source);
            expect(await toggleTasks(page, order)).toBe(false);
            await expectSourceStill(page, 'diagram', source);
            const messages = await rejectedMessages(page);
            expect(messages.length).toBeGreaterThan(0);
            expect(messages[0], '最初の知らせは設計の理由').toContain('先に終えるもの: 要件の確定');
            expect(messages[0]).not.toContain('先に終えるもの: 設計');
        });
    }

    test('@editor 上流と下流の関係のないもの (メモ、片付け) は文書の順。設計は実装より先 (書いた順は 実装、設計)', async ({ page }) => {
        await open(page);
        await renderDiagram(page, mixed());
        expect(await toggleTasks(page, ['片付け', '設計', '実装', 'メモ'])).toBe(true);
        const toggled = mixed(['x', 'x', 'x', 'x']);
        await expectSource(page, 'diagram', toggled, [toggled]);
        expect(await askedLog(page)).toEqual(['メモ', '設計', '実装', '片付け']);
    });

    test('@editor 要件の確定が完了なら、実装と設計を選んで Space を押すと両方進む。元に戻す 1 回で両方戻る', async ({ page }) => {
        await open(page);
        const source = reversed([' ', ' ', 'x']);
        await mountEditor(page, source);
        await selectNames(page, ['実装', '設計']);
        await page.keyboard.press('Space');
        const toggled = reversed(['x', 'x', 'x']);
        await expectSource(page, 'editor', toggled, [toggled]);
        expect(await rejectedMessages(page)).toEqual([]);
        expect(await page.evaluate(() => (window as unknown as GateWindow).editor?.undo())).toBe(true);
        await expectSource(page, 'editor', source, [toggled, source], '元に戻す');
    });

    test('@editor 要件の確定が未完了なら、設計と実装を選んで Space を押しても何も変わらない。最初の知らせは設計の理由', async ({ page }) => {
        await open(page);
        const source = reversed([' ', ' ', ' ']);
        await mountEditor(page, source);
        await selectNames(page, ['設計', '実装']);
        await page.keyboard.press('Space');
        await expectSourceStill(page, 'editor', source);
        await expect.poll(async () => (await rejectedMessages(page)).length).toBeGreaterThan(0);
        expect((await rejectedMessages(page))[0]).toContain('先に終えるもの: 要件の確定');
    });
});

test.describe('K-003 (レビューの G-03): 上流は requireUpstreamDone と同じもの (祖先に入る線、選んでいないタスクを挟む線)。両方を満たせない並びの順', () => {
    for (const order of [
        ['設計', 'コード'],
        ['コード', '設計'],
    ]) {
        test(`@editor 祖先に入る線: toggleTasks([${order.join(', ')}]) は、コードの祖先 (実装) の上流の設計を先に確かめ、その結果でコードを確かめて両方進む`, async ({ page }) => {
            await open(page);
            await renderDiagram(page, layered());
            expect(await toggleTasks(page, order)).toBe(true);
            const toggled = layered([' ', 'x', 'x']);
            await expectSource(page, 'diagram', toggled, [toggled]);
            expect(await rejectedMessages(page)).toEqual([]);
            expect(await askedLog(page)).toEqual(['設計', 'コード']);
        });
    }

    for (const order of [
        ['要件の確定', '実装'],
        ['実装', '要件の確定'],
    ]) {
        test(`@editor 選んでいないタスク (完了の設計) を挟む上流: toggleTasks([${order.join(', ')}]) は、要件の確定を先に確かめ、その結果で実装を確かめて両方進む`, async ({ page }) => {
            await open(page);
            await renderDiagram(page, reversed([' ', 'x', ' ']));
            expect(await toggleTasks(page, order)).toBe(true);
            const toggled = reversed(['x', 'x', 'x']);
            await expectSource(page, 'diagram', toggled, [toggled]);
            expect(await rejectedMessages(page)).toEqual([]);
            expect(await askedLog(page)).toEqual(['要件の確定', '実装']);
        });
    }

    test('@editor 両方を満たせない並び (文書の順が 実装、メモ、設計 で 設計 --> 実装): 確かめの順は メモ、設計、実装', async ({ page }) => {
        await open(page);
        await renderDiagram(page, tangled());
        expect(await toggleTasks(page, ['設計', 'メモ', '実装'])).toBe(true);
        const toggled = tangled(['x', 'x', 'x']);
        await expectSource(page, 'diagram', toggled, [toggled]);
        expect(await askedLog(page)).toEqual(['メモ', '設計', '実装']);
    });
});

// ---- K-006 ----

test.describe('K-006: 1 つ目が断られたら確かめをやめ、その理由だけを知らせる。断られたあとのアプリの beforeTaskToggle は呼ばない', () => {
    test('@editor toggleTasks: 規則が最初の設計を断ると、実装は確かめない。知らせは 1 件 (先に終えるもの: 要件の確定)', async ({ page }) => {
        await open(page);
        const source = reversed([' ', ' ', ' ']);
        await renderDiagram(page, source);
        expect(await toggleTasks(page, ['実装', '設計'])).toBe(false);
        await expectSourceStill(page, 'diagram', source);
        const messages = await rejectedMessages(page);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('先に終えるもの: 要件の確定');
        expect(await askedLog(page)).toEqual([]);
    });

    test('@editor toggleTasks: アプリのフックが 2 つ目 (報告) を断ると、片付けの beforeTaskToggle は呼ばない。知らせは報告の 1 件', async ({ page }) => {
        await open(page, ['報告', '片付け']);
        await renderDiagram(page, THREE);
        expect(await toggleTasks(page, ['点検', '報告', '片付け'])).toBe(false);
        await expectSourceStill(page, 'diagram', THREE);
        expect(await askedLog(page)).toEqual(['点検', '報告']);
        const messages = await rejectedMessages(page);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('報告 を断る');
    });

    test('@editor 3 つを選んで Space: アプリのフックが報告を断ると、片付けの beforeTaskToggle は呼ばず、何も変えない。知らせは報告の 1 件', async ({ page }) => {
        await open(page, ['報告', '片付け']);
        await mountEditor(page, THREE);
        await selectNames(page, ['点検', '報告', '片付け']);
        await page.keyboard.press('Space');
        await expectSourceStill(page, 'editor', THREE);
        await expect.poll(() => askedLog(page)).toEqual(['点検', '報告']);
        const messages = await rejectedMessages(page);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('報告 を断る');
    });
});

// ---- K-007 ----

test.describe('K-007: まとめて進めたときも、view.addHooks で足した onToggleTask を選んだタスクごとに 1 回ずつ呼ぶ', () => {
    test('@editor toggleTasks: 進めたときは、書き換えて描き直したあとに、タスクごとに 1 回 (タスクでない片付けは呼ばない)。タスクは 1 段だけ進む', async ({ page }) => {
        await open(page);
        await renderDiagram(page, TASKS);
        expect(await toggleTasks(page, ['点検', '報告', '片付け'])).toBe(true);
        await expectSource(page, 'diagram', TASKS_DONE, [TASKS_DONE]);
        await expect.poll(() => toggleLog(page)).toEqual([
            { name: '点検', source: TASKS_DONE, drawn: 'done' },
            { name: '報告', source: TASKS_DONE, drawn: 'done' },
        ]);
        await settle(page);
        expect(await sourceOf(page, 'diagram'), '二重に進まない').toBe(TASKS_DONE);
        expect(await changeLog(page)).toEqual([TASKS_DONE]);
    });

    test('@editor toggleTasks: 呼ぶ順は確かめの順 (上流の設計が先。書いた順は 実装、設計)', async ({ page }) => {
        await open(page);
        await renderDiagram(page, mixed());
        expect(await toggleTasks(page, ['実装', '設計'])).toBe(true);
        const toggled = mixed([' ', 'x', 'x', ' ']);
        await expectSource(page, 'diagram', toggled, [toggled]);
        await expect.poll(async () => (await toggleLog(page)).map((record) => record.name)).toEqual(['設計', '実装']);
    });

    test('@editor toggleTasks: 規則で取りやめになって何も変わらなかったときも、選んだタスクごとに呼ぶ (原文はそのまま)', async ({ page }) => {
        await open(page);
        const source = reversed([' ', ' ', ' ']);
        await renderDiagram(page, source);
        expect(await toggleTasks(page, ['実装', '設計'])).toBe(false);
        await expect.poll(() => toggleLog(page)).toEqual([
            { name: '設計', source, drawn: 'todo' },
            { name: '実装', source, drawn: 'todo' },
        ]);
        await expectSourceStill(page, 'diagram', source);
    });

    test('@editor Space: 点検、報告、片付けを選んで Space を押すと、足した受け口は点検と報告に 1 回ずつ、描き直したあとに呼ばれる。1 段だけ進み、元に戻す 1 回で戻る', async ({ page }) => {
        await open(page);
        await mountEditor(page, TASKS);
        await selectNames(page, ['点検', '報告', '片付け']);
        await page.keyboard.press('Space');
        await expectSource(page, 'editor', TASKS_DONE, [TASKS_DONE]);
        await expect.poll(() => toggleLog(page)).toEqual([
            { name: '点検', source: null, drawn: 'done' },
            { name: '報告', source: null, drawn: 'done' },
        ]);
        await settle(page);
        expect(await sourceOf(page, 'editor'), '二重に進まない').toBe(TASKS_DONE);
        expect(await changeLog(page)).toEqual([TASKS_DONE]);
        expect(await page.evaluate(() => (window as unknown as GateWindow).editor?.undo())).toBe(true);
        await expectSource(page, 'editor', TASKS, [TASKS_DONE, TASKS], '元に戻す');
    });

    test('@editor Space: 規則で取りやめになったときも、選んだタスク (設計、実装) ごとに確かめの順で呼ぶ', async ({ page }) => {
        await open(page);
        const source = reversed([' ', ' ', ' ']);
        await mountEditor(page, source);
        await selectNames(page, ['実装', '設計']);
        await page.keyboard.press('Space');
        await expect.poll(() => toggleLog(page)).toEqual([
            { name: '設計', source: null, drawn: 'todo' },
            { name: '実装', source: null, drawn: 'todo' },
        ]);
        await expectSourceStill(page, 'editor', source);
    });

    test('@editor 今のまま: 印 (先頭の状態の絵) のクリックは、足した受け口を 1 回呼び、タスクは 1 段だけ進む', async ({ page }) => {
        await open(page);
        await mountEditor(page, TASKS);
        await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(2)} .mdag-content svg` }));
        const toggled = '# 確認\n\n- [x] 点検\n- [ ] 報告\n- 片付け\n';
        await expectSource(page, 'editor', toggled, [toggled]);
        await expect.poll(() => toggleLog(page)).toEqual([{ name: '点検', source: null, drawn: 'done' }]);
    });
});

// ---- K-005 ----

test.describe('K-005: ルートのタイトルの名前の入力は、原文の title の文字のまま (書式の記法を含む) で開き、少し直しても書式が残る', () => {
    // リストだけの文書。1 計画 (title) / 2 甲 / 3 乙
    const TITLED = '---\ntitle: <b>計画</b>\n---\n- 甲\n- 乙\n';

    test('@editor ルートを選んで Enter を押すと、入力の値は <b>計画</b>。末尾に「書」を足して Enter で決めると title は <b>計画</b>書 (図の名前は「計画書」)', async ({ page }) => {
        await open(page);
        await mountEditor(page, TITLED);
        await pressNode(page, 1);
        await expect.poll(() => selectionOf(page)).toEqual([target(1, '計画')]);
        await page.keyboard.press('Enter');
        await expectNameInput(page, '<b>計画</b>', target(1, '計画'));
        // 全部を選んだ値の選びを外して末尾へ (macOS では End でカーソルが動かない)
        await page.keyboard.press('ArrowRight');
        await page.keyboard.type('書');
        await page.keyboard.press('Enter');
        const renamed = '---\ntitle: <b>計画</b>書\n---\n- 甲\n- 乙\n';
        await expectSource(page, 'editor', renamed, [renamed]);
        await expect.poll(() => selectionOf(page)).toEqual([target(1, '計画書')]);
    });

    test('@editor 乙で Shift+Tab を押すと、ルートの名前の入力が <b>計画</b> で開く。そのまま Enter で決めても原文は変わらない', async ({ page }) => {
        await open(page);
        await mountEditor(page, TITLED);
        await pressNode(page, 3);
        await page.keyboard.press('Shift+Tab');
        await expectNameInput(page, '<b>計画</b>', target(1, '計画'));
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await nameInputOf(page)).count).toBe(0);
        await expectSourceStill(page, 'editor', TITLED);
    });
});

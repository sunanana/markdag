// GUI 編集のキーの手直しで、例の承認 (2026-10-06) に依頼者が今の作りと違う答えをした挙動のうち、画面の操作のものを、
// ビルドした配布物の markdag/editor で、直す前に落ちるテストとして書く。期待は決まった挙動から書き、今の作りの出力はなぞらない。
// - ルートのタイトル: 見出しのない文書のルートの名前の入力が、Enter、帯の「名前」、Shift+Tab で親へ移ったときに開き、決めた名前を title に書く
// - S-09: 何かを選んでいる (ノード 1 つ以外: 2 つ以上、グループ、線、合流先を選ぶ途中) ときの Tab と Shift+Tab は、ブラウザの既定の動きを
//   止めて何もしない。何も選んでいないときはブラウザの既定のまま
// - S-12: 兄弟や子を足したあとも、関係のない閉じた枝は閉じたまま (キー、帯の「兄弟追加」、下の +)。足したノードを見せるために
//   閉じた枝を開くのは今のまま。最初から閉じている枝 (initialExpandLevel、開閉のコメント) と、削除、付け替えのあとも見る
// - S-13 の残り: Shift+Tab で親へ移るとき、名前を持たないリストの入れ物は飛ばして、その上の見出しの名前の入力へ移る
// - S-15: Shift を押している間の Space は、押す順によらず印を進めない
// - S-17: まとめて進めるときは relations の上流から確かめ (上流と下流の関係のないもの同士は文書の順。関門の答え K-003)、前のタスクを進めた結果で
//   次のタスクを確かめる。1 つでも進められなければ全部やめる (U6) は今のまま (最初に断られた所で確かめをやめ、その理由だけを知らせる。K-006)
// - S-18: 合流先を選ぶ途中は、Space の押して離すで印を進めない (Space+ドラッグの図の移動だけ)
// - S-20: 詳細の入力の保存のキーを OS で分ける。mac は ⌘Enter だけ、win は Ctrl+Enter だけ。保存にならない方の修飾キーの Enter は何もしない
// mac と win の割り当ては、開く前に navigator.platform を見せかけて選ぶ (GUI 編集は開くときに 1 回見分ける)。
// 見た目そのものは見ない。原文の全文、onChange の呼ばれ方、選択 (getSelection)、名前の入力と詳細の入力の有無と値とフォーカス、
// 閉じた枝 (view.getFolded を名前に直したもの)、キーの既定の動きを止めたか (window の受け口で defaultPrevented を読む)、道具の状態を見る。
// 反映は expect.poll で待ち、「変わらない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { Diagnostic, NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type Platform = 'mac' | 'win';

interface KeyRecord {
    key: string;
    shift: boolean;
    prevented: boolean;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editor: MarkdagEditor | null;
    // onChange に届いた原文 (呼ばれた順)
    changes: string[];
    // onDiagnostic に届いた診断の code
    diagnostics: string[];
    // window の受け口 (document の受け口のあと) で読んだ Tab の keydown
    keyRecords: KeyRecord[];
};

const DIST = resolve('dist');

// 足したノードの仮の名前
const NEW = '新しいノード';

const PLATFORM_NAMES: Record<Platform, string> = { mac: 'MacIntel', win: 'Win32' };

// 区分ごとの、兄弟を足すキー (詳細の入力では保存のキー) の playwright のキーの名前
const ADD_KEY: Record<Platform, string> = { mac: 'Meta', win: 'Control' };

// ---- 文書 ----

// リストだけの文書 (ルートはリストの容器で、名前は title)。1 リストだけ / 2 甲 / 3 乙 / 4 丙
const LIST_ROOT = '---\ntitle: リストだけ\n---\n- 甲\n- 乙\n- 丙\n';
// title も frontmatter もないリストだけの文書。1 (名前なし) / 2 甲 / 3 乙
const LIST_ROOT_UNTITLED = '- 甲\n- 乙\n';
// 種類の違うリストが 2 つで見出しのない文書 (ルートは容器でない)。1 T / 2 a / 3 1. b
const TWO_LISTS_ROOT = '---\ntitle: T\n---\n- a\n\n1. b\n';

// 見出しの下に種類の違うリストが 2 つ (リストの入れ物ができる)。1 二つのリスト / 2 入れ物 / 3 赤 / 4 青 / 5 入れ物 / 6 1. 一号 / 7 2. 二号
const TWO_LISTS = '# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n';

// グループと線のある文書。1 計画 / 2 準備 / 3 調べる (g1) / 4 決める (g1) / 5 確認 / 6 点検 / 7 片付け。線は 調べる → 片付け
const GROUPED = [
    '---',
    'markdag:',
    '    groups:',
    '        g1:',
    '            label: 準備の組',
    '    relations:',
    '        depends:',
    '            - 調べる --> 片付け',
    '---',
    '',
    '# 計画',
    '',
    '## 準備',
    '- 調べる %g1',
    '- 決める %g1',
    '',
    '## 確認',
    '- 点検',
    '- 片付け',
    '',
].join('\n');

// 枝のある文書。1 計画 / 2 準備 / 3 調べる / 4 決める / 5 作業 / 6 1. 停止 / 7 2. 更新 / 8 3. 再開 / 9 確認 / 10 点検 / 11 報告 / 12 付録 / 13 一つだけ
function planDoc(frontmatter: string[] = [], workHeading = '## 作業'): string {
    const head = frontmatter.length > 0 ? ['---', 'markdag:', ...frontmatter.map((line) => `    ${line}`), '---', ''] : [];
    return [...head, '# 計画', '', '## 準備', '- 調べる', '- 決める', '', workHeading, '1. 停止', '2. 更新', '3. 再開', '', '## 確認', '- 点検', '- 報告', '', '## 付録', '- 一つだけ', ''].join('\n');
}
const PLAN = planDoc();

// タスクの文書。1 確認 / 2 点検 / 3 報告 / 4 片付け
const TASKS = '# 確認\n\n- [ ] 点検\n- [ ] 報告\n- 片付け\n';

// markdag.rules で上流が終わるまで進められないタスク (設計 --> 実装 --> 検証)。1 リリース / 2 設計 / 3 実装 / 4 検証
function rulesDoc(marks: [string, string, string] = [' ', ' ', ' ']): string {
    return [
        '---',
        'markdag:',
        '    rules:',
        '        taskToggle:',
        '            requireUpstreamDone: true',
        '    relations:',
        '        chain:',
        '            - 設計 --> 実装 --> 検証',
        '---',
        '',
        '# リリース',
        '',
        `- [${marks[0]}] 設計`,
        `- [${marks[1]}] 実装`,
        `- [${marks[2]}] 検証`,
        '',
    ].join('\n');
}

// 詳細を書く文書 (markdag キーがあるので、詳細は項目の直下の引用として読まれる)。1 R / 2 a / 3 b
const DETAILS = '---\nmarkdag:\n---\n# R\n\n- a\n- b\n';

// ---- 開く ----

interface Point {
    x: number;
    y: number;
}

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return errors;
}

// 開く前に navigator.platform を区分に見せかけ、Tab のキーの記録を仕込む。図の前にフォーカスを受ける欄 (#before) を置く
async function open(page: Page, platform: Platform = 'mac'): Promise<void> {
    await page.addInitScript((name) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => name, configurable: true }), PLATFORM_NAMES[platform]);
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editor = null;
        target.changes = [];
        target.diagnostics = [];
        target.keyRecords = [];
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Tab') target.keyRecords.push({ key: event.key, shift: event.shiftKey, prevented: event.defaultPrevented });
        });
        const before = document.createElement('textarea');
        before.id = 'before';
        before.style.cssText = 'position: fixed; top: 620px; left: 1020px; width: 200px; height: 60px;';
        document.body.prepend(before);
    });
}

// GUI 編集で開く (mount の mode: edit)。前に開いた図は片付け、記録を空にする
async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        target.editor?.destroy();
        target.changes = [];
        target.diagnostics = [];
        target.keyRecords = [];
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = {
            mode: 'edit',
            animate: false,
            onChange: (next) => {
                target.changes.push(next);
            },
            onDiagnostic: (diagnostic: Diagnostic) => {
                target.diagnostics.push(diagnostic.code);
            },
        };
        target.editor = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「変わらない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editor?.getSource());
const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).changes]);
const diagnosticLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).diagnostics]);
const toolState = (page: Page): Promise<string | null> => page.evaluate(() => document.getElementById('a')?.dataset.editorTool ?? null);
const activeId = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.id ?? '');

async function expectSource(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await expect.poll(() => getSource(page), message).toBe(source);
    await expect.poll(() => changeLog(page), message).toEqual(changes);
}

async function expectSourceStill(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await settle(page);
    expect(await getSource(page), message).toBe(source);
    expect(await changeLog(page), message).toEqual(changes);
}

// 名前で引いたノードの id (描いている文書)
async function idOf(page: Page, name: string): Promise<number> {
    const id = await page.evaluate((name) => {
        const nodes = (window as unknown as EditorWindow).editor?.view.getDocument()?.parsed.nodes ?? [];
        const found = nodes.filter((node) => node.refText === name);
        return found.length === 1 ? found[0]!.id : null;
    }, name);
    if (id === null) throw new Error(`名前「${name}」のノードが 1 つではない`);
    return id;
}

// 閉じた枝の名前 (並べ替えたもの)
const foldedNames = (page: Page): Promise<string[]> =>
    page.evaluate(() => {
        const editor = (window as unknown as EditorWindow).editor;
        const nodes = editor?.view.getDocument()?.parsed.nodes ?? [];
        return (editor?.view.getFolded() ?? []).map((id) => nodes.find((node) => node.id === id)?.refText ?? `#${id}`).sort();
    });

type SelectionState = NodeTarget[] | string;

// 選んでいるもの。ノードは id の昇順の id と refText、ノードでなければ kind
const selectionOf = (page: Page): Promise<SelectionState> =>
    page.evaluate(() => {
        const selection = (window as unknown as EditorWindow).editor?.getSelection();
        if (!selection || selection.kind === 'none') return [];
        if (selection.kind !== 'nodes') return selection.kind;
        return [...selection.nodes].sort((a, b) => a.id - b.id).map((node) => ({ id: node.id, refText: node.refText }));
    });

const target = (id: number, refText: string): NodeTarget => ({ id, refText });

// ---- 押す ----

const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

type Spot = { on: 'blank' } | { on: 'element'; selector: string } | { on: 'text'; selector: string };

// 画面の座標で押せる点を探す (図の領域はスクロールを戻すので、座標を決めて page.mouse で押す)
async function spot(page: Page, where: Spot): Promise<Point> {
    const found = await page.evaluate((where) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const grid = (rect: DOMRect, step: number): Point[] => {
            const points: Point[] = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        };
        if (where.on === 'blank') {
            const container = document.getElementById('a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = [...document.querySelectorAll(where.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        if (where.on === 'element') {
            const rect = element.getBoundingClientRect();
            return (
                grid(rect, Math.max(2, Math.min(rect.width, rect.height) / 8)).find((point) => {
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

// ノードの箱を押す (modifier を押したままなら選択に足す)
async function pressNode(page: Page, id: number, modifier?: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }), modifier);
}

// ノードの文字の上を押す (タスクのノードは先頭の絵を押すと印が進むので、文字の上を押して選ぶ)
async function pressLabel(page: Page, id: number, modifier?: string): Promise<void> {
    await press(page, await spot(page, { on: 'text', selector: `${nodeSelector(id)} .mdag-content` }), modifier);
}

async function pressBlank(page: Page): Promise<void> {
    await press(page, await spot(page, { on: 'blank' }));
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(page.locator(selector).filter({ visible: true })).toHaveCount(1);
    await expect(page.locator(selector).filter({ visible: true })).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

// 選んだノードのまわりの + (child は子、sibling は兄弟) を押す
async function pressPlus(page: Page, kind: 'child' | 'sibling'): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `#a .mdag-editor-handle[data-handle="${kind}"]` }));
}

// 開閉の丸を押して枝を閉じる
async function foldByCircle(page: Page, name: string): Promise<void> {
    const id = await idOf(page, name);
    await press(page, await spot(page, { on: 'element', selector: `#a .mdag-fold[data-id="${id}"]` }));
    await expect.poll(() => foldedNames(page), `${name} を閉じる`).toContain(name);
}

// 図の要素にフォーカスを置く (キーを図が受ける)
async function focusDiagram(page: Page): Promise<void> {
    await page.evaluate(() => document.getElementById('a')?.focus({ preventScroll: true }));
    await expect.poll(() => activeId(page)).toBe('a');
}

// ---- 名前の入力と詳細の入力 ----

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

async function expectNoNameInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    expect((await nameInputOf(page)).count, message).toBe(0);
}

// 名前の入力の値を全部選んで text を打つ
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
}

const detailsOf = (page: Page): Promise<InputState> =>
    page.evaluate(() => {
        const shown = [...document.querySelectorAll('#a .mdag-editor-details-editor textarea')].filter((element) => element.checkVisibility());
        const field = shown[0];
        if (shown.length !== 1 || !(field instanceof HTMLTextAreaElement)) return { count: shown.length, value: null, focused: false };
        return { count: 1, value: field.value, focused: document.activeElement === field };
    });

// ---- ルートのタイトル ----

test.describe('ルートのタイトル: 見出しのない文書のルートの名前を変えられる (名前は frontmatter の title)', () => {
    test('@editor リストだけの文書でルートを選んで Enter を押すと、title を初めの値に名前の入力が開き、決めた名前を title に書く', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, LIST_ROOT);
        await pressNode(page, 1);
        await expect.poll(() => selectionOf(page)).toEqual([target(1, 'リストだけ')]);

        await page.keyboard.press('Enter');
        await expectNameInput(page, 'リストだけ', target(1, 'リストだけ'));
        await replaceName(page, '新しい題');
        await page.keyboard.press('Enter');
        const renamed = '---\ntitle: 新しい題\n---\n- 甲\n- 乙\n- 丙\n';
        await expectSource(page, renamed, [renamed]);
        await expect.poll(() => selectionOf(page)).toEqual([target(1, '新しい題')]);
        await expect(page.locator(`${nodeSelector(1)} .mdag-content`)).toHaveText('新しい題');
        await expectNoNameInput(page, '決めたあと (Enter は決めるだけ)');
        expect(errors).toEqual([]);
    });

    test('@editor 帯の「名前」でも、ルートの名前の入力が title を初めの値に開く', async ({ page }) => {
        await open(page);
        await mount(page, LIST_ROOT);
        await pressNode(page, 1);
        await pressBar(page, 'rename');
        await expectNameInput(page, 'リストだけ', target(1, 'リストだけ'));
    });

    test('@editor 子で Shift+Tab を押すと、親のルートを選んでその名前の入力が開く。名前の入力中なら名前を決めてから移る', async ({ page }) => {
        await open(page);
        await mount(page, LIST_ROOT);
        await pressNode(page, 3);
        await page.keyboard.press('Shift+Tab');
        await expectNameInput(page, 'リストだけ', target(1, 'リストだけ'), '選択中の Shift+Tab');
        await expectSourceStill(page, LIST_ROOT, []);

        await page.keyboard.press('Escape');
        await pressNode(page, 3);
        await page.keyboard.press('Enter');
        await expectNameInput(page, '乙', target(3, '乙'));
        await replaceName(page, 'おつ');
        await page.keyboard.press('Shift+Tab');
        const renamed = '---\ntitle: リストだけ\n---\n- 甲\n- おつ\n- 丙\n';
        await expectSource(page, renamed, [renamed]);
        await expectNameInput(page, 'リストだけ', target(1, 'リストだけ'), '入力中の Shift+Tab');
    });

    test('@editor title も frontmatter もない文書では、ルートの名前の入力が空で開き、決めた名前の title を frontmatter ごと足す', async ({ page }) => {
        await open(page);
        await mount(page, LIST_ROOT_UNTITLED);
        await pressNode(page, 2);
        await page.keyboard.press('Shift+Tab');
        await expectNameInput(page, '', target(1, ''));
        await page.keyboard.type('題');
        await page.keyboard.press('Enter');
        // 閉じの --- のあとの空行は決めていないので、あってもなくてもよい
        const candidates = [`---\ntitle: 題\n---\n\n${LIST_ROOT_UNTITLED}`, `---\ntitle: 題\n---\n${LIST_ROOT_UNTITLED}`];
        await expect.poll(async () => candidates.includes((await getSource(page)) ?? '')).toBe(true);
        expect((await changeLog(page)).length).toBe(1);
        await expect.poll(() => selectionOf(page)).toEqual([target(1, '題')]);
    });

    test('@editor 種類の違うリストが 2 つで見出しのない文書 (ルートは容器でない) でも、ルートの名前の入力が開いて title を書く', async ({ page }) => {
        await open(page);
        await mount(page, TWO_LISTS_ROOT);
        await pressNode(page, 1);
        await page.keyboard.press('Enter');
        await expectNameInput(page, 'T', target(1, 'T'));
        await replaceName(page, 'U');
        await page.keyboard.press('Enter');
        const renamed = '---\ntitle: U\n---\n- a\n\n1. b\n';
        await expectSource(page, renamed, [renamed]);
    });
});

// ---- S-09 ----

type Picked = 'nodes' | 'group' | 'edge' | 'join';

// 選ぶもの。nodes は調べると決める、group は準備の組 (凡例のパネルの行)、edge は 調べる → 片付け (depends)、join は 2 つ選んで帯の「既存のノードへ合流」
async function pick(page: Page, what: Picked): Promise<void> {
    if (what === 'nodes' || what === 'join') {
        await pressNode(page, 3);
        await pressNode(page, 4, 'Shift');
        await expect.poll(() => selectionOf(page)).toEqual([target(3, '調べる'), target(4, '決める')]);
        if (what === 'join') {
            await pressBar(page, 'join-existing');
            await expect.poll(() => toolState(page)).toBe('join-target');
        }
    } else if (what === 'group') {
        // 凡例のパネルのグループの行を押して、そのグループ 1 つを選ぶ
        await press(page, await spot(page, { on: 'element', selector: '#a .mdag-editor-legend-row[data-group="g1"] .mdag-editor-legend-name' }));
        await expect.poll(() => selectionOf(page)).toBe('group');
    } else {
        const point = await page.evaluate(() => {
            for (const hit of document.querySelectorAll<SVGGeometryElement>('#a .mdag-edge-hit[data-key="depends:3>7"]')) {
                const matrix = hit.getScreenCTM();
                if (!matrix) continue;
                const length = hit.getTotalLength();
                for (const ratio of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
                    const at = hit.getPointAtLength(length * ratio);
                    const p = new DOMPoint(at.x, at.y).matrixTransform(matrix);
                    if (document.elementFromPoint(p.x, p.y) === hit) return { x: p.x, y: p.y };
                }
            }
            return null;
        });
        if (!point) throw new Error('線の押せる点がない');
        await press(page, point);
        await expect.poll(() => selectionOf(page)).toBe('edge');
    }
}

const tabRecords = (page: Page): Promise<KeyRecord[]> => page.evaluate(() => [...(window as unknown as EditorWindow).keyRecords]);
const clearTabRecords = (page: Page): Promise<void> => page.evaluate(() => void ((window as unknown as EditorWindow).keyRecords = []));

test.describe('S-09: 何かを選んでいる (ノード 1 つ以外) ときの Tab と Shift+Tab は、ブラウザの既定の動きを止めて何もしない', () => {
    const cases: Array<[Picked, string]> = [
        ['nodes', 'ノード 2 つ'],
        ['group', 'グループ'],
        ['edge', '線'],
        ['join', '合流先を選ぶ途中'],
    ];
    for (const [what, name] of cases) {
        for (const key of ['Tab', 'Shift+Tab']) {
            test(`@editor ${name}を選んでいるとき: ${key} は既定の動きを止め、フォーカスは図に残り、原文と選択は変わらない`, async ({ page }) => {
                await open(page);
                await mount(page, GROUPED);
                await pick(page, what);
                const before = await selectionOf(page);
                await focusDiagram(page);
                await clearTabRecords(page);
                await page.keyboard.press(key);
                await settle(page);
                expect(await tabRecords(page)).toEqual([{ key: 'Tab', shift: key === 'Shift+Tab', prevented: true }]);
                expect(await activeId(page)).toBe('a');
                expect(await selectionOf(page)).toEqual(before);
                expect((await nameInputOf(page)).count).toBe(0);
                await expectSourceStill(page, GROUPED, []);
                if (what === 'join') expect(await toolState(page)).toBe('join-target');
            });
        }
    }

    test('@editor 今のまま: 何も選んでいないときの Tab と Shift+Tab はブラウザの既定 (止めず、フォーカスが図の外へ動く)', async ({ page }) => {
        await open(page);
        await mount(page, GROUPED);
        await pressBlank(page);
        await expect.poll(() => selectionOf(page)).toEqual([]);
        for (const key of ['Tab', 'Shift+Tab']) {
            await focusDiagram(page);
            await clearTabRecords(page);
            await page.keyboard.press(key);
            await settle(page);
            expect(await tabRecords(page), key).toEqual([{ key: 'Tab', shift: key === 'Shift+Tab', prevented: false }]);
            expect(await activeId(page), key).not.toBe('a');
            if (key === 'Shift+Tab') expect(await activeId(page), key).toBe('before');
        }
        await expectSourceStill(page, GROUPED, []);
    });
});

// ---- S-12 ----

// 準備 (2) を選んで op で足し、足したノードの名前の入力が開くまで待つ
async function addFromPreparation(page: Page, op: () => Promise<void>, message: string): Promise<void> {
    await pressNode(page, await idOf(page, '準備'));
    await expect.poll(() => selectionOf(page), message).toEqual([target(await idOf(page, '準備'), '準備')]);
    await op();
    await expect.poll(async () => (await nameInputOf(page)).value, message).toBe(NEW);
    expect((await changeLog(page)).length, message).toBe(1);
}

test.describe('S-12: 兄弟や子を足したあとも、関係のない閉じた枝は閉じたまま', () => {
    const ops: Array<[string, (page: Page) => Promise<void>]> = [
        ['Shift+Enter (兄弟を下に)', (page) => page.keyboard.press('Shift+Enter')],
        ['⌘Enter (兄弟を下に)', (page) => page.keyboard.press(`${ADD_KEY.mac}+Enter`)],
        ['Shift+⌘Enter (兄弟を上に)', (page) => page.keyboard.press(`Shift+${ADD_KEY.mac}+Enter`)],
        ['Tab (子)', (page) => page.keyboard.press('Tab')],
        ['帯の「兄弟追加」', (page) => pressBar(page, 'sibling')],
        ['帯の「子の追加」', (page) => pressBar(page, 'child')],
        ['下の + (兄弟)', (page) => pressPlus(page, 'sibling')],
        ['右の + (子)', (page) => pressPlus(page, 'child')],
    ];
    for (const [name, op] of ops) {
        test(`@editor 作業と付録の枝を閉じ、準備で ${name} を押して足しても、作業と付録は閉じたまま`, async ({ page }) => {
            await open(page);
            await mount(page, PLAN);
            await foldByCircle(page, '作業');
            await foldByCircle(page, '付録');
            await addFromPreparation(page, () => op(page), name);
            await settle(page);
            expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
        });
    }

    test('@editor 閉じた枝の間のノード (確認) に兄弟を足しても、前と後ろの閉じた枝 (作業と付録) は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '確認'));
        await page.keyboard.press('Shift+Enter');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor 閉じた枝そのもの (作業) に兄弟を足すと、作業は閉じたまま (足したノードは作業の外で見える)。付録も閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '作業'));
        await page.keyboard.press('Shift+Enter');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor 閉じた枝そのもの (作業) に子を足すと、足したノードを見せるために作業を開く (今のまま)。関係のない付録は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '作業'));
        await page.keyboard.press('Tab');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録']);
        // 作業の子は番号付きのリストなので、足した子の名前は「4. 新しいノード」
        await expect(page.locator(`${nodeSelector(await idOf(page, `4. ${NEW}`))} .mdag-box`)).toBeVisible();
    });

    test('@editor 最初から閉じている枝 (initialExpandLevel 2 で 準備、作業、確認、付録) は、準備に兄弟を足しても閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, planDoc(['initialExpandLevel: 2']));
        await expect.poll(() => foldedNames(page)).toEqual(['付録', '作業', '準備', '確認'].sort());
        await pressNode(page, await idOf(page, '準備'));
        await page.keyboard.press('Shift+Enter');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業', '準備', '確認'].sort());
    });

    test('@editor 開閉のコメント (<!-- markmap: fold -->) で閉じている枝 (作業) は、準備に兄弟を足しても閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, planDoc([], '## 作業 <!-- markmap: fold -->'));
        await expect.poll(() => foldedNames(page)).toEqual(['作業']);
        await pressNode(page, await idOf(page, '準備'));
        await page.keyboard.press('Shift+Enter');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['作業']);
    });

    test('@editor 足したばかりの入力を Esc でやめて足す前に戻しても、作業と付録は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await addFromPreparation(page, () => page.keyboard.press('Shift+Enter'), 'Shift+Enter');
        await page.keyboard.press('Escape');
        await expectSource(page, PLAN, [(await changeLog(page))[0]!, PLAN]);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor ノードを消しても (報告を Delete)、関係のない作業と付録は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '報告'));
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await changeLog(page)).length).toBe(1);
        expect(await getSource(page)).not.toContain('報告');
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor ノードを付け替えても (報告を準備へドラッグ)、関係のない作業と付録は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressBlank(page);
        const from = await spot(page, { on: 'text', selector: `${nodeSelector(await idOf(page, '報告'))} .mdag-content` });
        const to = await spot(page, { on: 'element', selector: `${nodeSelector(await idOf(page, '準備'))} .mdag-box` });
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + (to.x - from.x) * 0.3, from.y + (to.y - from.y) * 0.3, { steps: 6 });
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await changeLog(page)).length).toBe(1);
        await expect.poll(async () => {
            const nodes = await page.evaluate(() => (window as unknown as EditorWindow).editor?.view.getDocument()?.parsed.nodes.map((node) => ({ id: node.id, parent: node.parent, refText: node.refText })) ?? []);
            const moved = nodes.find((node) => node.refText === '報告');
            return moved ? nodes.find((node) => node.id === moved.parent)?.refText : null;
        }).toBe('準備');
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });
});

// ---- S-13 の残り ----

test.describe('S-13 の残り: Shift+Tab で親へ移るとき、名前を持たないリストの入れ物は飛ばして、その上の見出しの名前の入力へ移る', () => {
    test('@editor 1 つ目のリストの項目 (赤) と 2 つ目のリストの項目 (2. 二号) で Shift+Tab を押すと、見出し「二つのリスト」を選んで名前の入力が開く', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, TWO_LISTS);
        for (const [id, name] of [
            [3, '赤'],
            [7, '2. 二号'],
        ] as const) {
            await page.keyboard.press('Escape');
            await pressNode(page, id);
            await expect.poll(() => selectionOf(page), name).toEqual([target(id, name)]);
            await page.keyboard.press('Shift+Tab');
            await expectNameInput(page, '二つのリスト', target(1, '二つのリスト'), name);
            await expect(page.locator('#a .mdag-editor-snackbar[data-kind="error"]').filter({ visible: true }), name).toHaveCount(0);
        }
        await expectSourceStill(page, TWO_LISTS, []);
        expect(errors).toEqual([]);
    });

    test('@editor 名前の入力中 (青) の Shift+Tab は、名前を決めてから入れ物を飛ばして見出しの名前の入力へ移る', async ({ page }) => {
        await open(page);
        await mount(page, TWO_LISTS);
        await pressNode(page, 4);
        await page.keyboard.press('Enter');
        await expectNameInput(page, '青', target(4, '青'));
        await replaceName(page, 'あお');
        await page.keyboard.press('Shift+Tab');
        const renamed = '# 二つのリスト\n\n- 赤\n- あお\n\n1. 一号\n2. 二号\n';
        await expectSource(page, renamed, [renamed]);
        await expectNameInput(page, '二つのリスト', target(1, '二つのリスト'));
    });
});

// ---- S-15、S-17、S-18 (Space) ----

const checkbox = (marks: [string, string]): string => `# 確認\n\n- [${marks[0]}] 点検\n- [${marks[1]}] 報告\n- 片付け\n`;

test.describe('S-15: Shift を押している間の Space は、押す順によらず印を進めない', () => {
    test('@editor 点検を選び、Shift を押してから Space を押して離すと (Shift を離すのが Space の前でもあとでも) 印は進まない。Space だけなら進む', async ({ page }) => {
        await open(page);
        await mount(page, TASKS);
        await pressLabel(page, 2);
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検')]);

        // Shift → Space → Space を離す → Shift を離す
        await page.keyboard.down('Shift');
        await page.keyboard.down('Space');
        await page.keyboard.up('Space');
        await page.keyboard.up('Shift');
        await expectSourceStill(page, TASKS, [], 'Shift を押したまま Space を押して離す');

        // Shift → Space → Shift を離す → Space を離す
        await page.keyboard.down('Shift');
        await page.keyboard.down('Space');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Space');
        await expectSourceStill(page, TASKS, [], 'Shift を押したまま Space を押し、Shift を先に離す');

        // 今のまま (S-14): Space → Shift → Shift を離す → Space を離す
        await page.keyboard.down('Space');
        await page.keyboard.down('Shift');
        await page.keyboard.up('Shift');
        await page.keyboard.up('Space');
        await expectSourceStill(page, TASKS, [], 'Space を押したまま Shift を押す');

        // 今のまま: Space だけを押して離すと進む
        await page.keyboard.press('Space');
        const toggled = checkbox(['x', ' ']);
        await expectSource(page, toggled, [toggled], 'Space だけ');
    });
});

test.describe('S-17: まとめて進めるときは relations の上流から確かめ (K-003)、前のタスクを進めた結果で次のタスクを確かめる', () => {
    const select = async (page: Page, names: string[]): Promise<void> => {
        const ids = await Promise.all(names.map((name) => idOf(page, name)));
        await pressLabel(page, ids[0]!);
        for (const id of ids.slice(1)) await pressLabel(page, id, 'Shift');
        await expect.poll(async () => ((await selectionOf(page)) as NodeTarget[]).map((node) => node.refText).sort()).toEqual([...names].sort());
    };

    for (const order of [
        ['設計', '実装'],
        ['実装', '設計'],
    ]) {
        test(`@editor 上流 (設計) と下流 (実装) を ${order.join('、')} の順に選んで Space を押すと、両方進む。書き換えは 1 回で、元に戻す 1 回で両方戻る`, async ({ page }) => {
            await open(page);
            const source = rulesDoc();
            await mount(page, source);
            await select(page, order);
            await page.keyboard.press('Space');
            const toggled = rulesDoc(['x', 'x', ' ']);
            await expectSource(page, toggled, [toggled]);
            expect(await diagnosticLog(page)).not.toContain('hook-rejected');
            expect(await page.evaluate(() => (window as unknown as EditorWindow).editor?.undo())).toBe(true);
            await expectSource(page, source, [toggled, source], '元に戻す');
        });
    }

    test('@editor 3 つ (設計、実装、検証) を選んで Space を押すと、上流の設計から順に確かめて全部進む', async ({ page }) => {
        await open(page);
        await mount(page, rulesDoc());
        await select(page, ['設計', '実装', '検証']);
        await page.keyboard.press('Space');
        const toggled = rulesDoc(['x', 'x', 'x']);
        await expectSource(page, toggled, [toggled]);
    });

    test('@editor 今のまま (U6): 設計と検証を選んで Space を押すと、検証は上流の実装が終わっていないので進められず、どちらも進まない。理由は onDiagnostic に出る', async ({ page }) => {
        await open(page);
        const source = rulesDoc();
        await mount(page, source);
        await select(page, ['設計', '検証']);
        await page.keyboard.press('Space');
        await expectSourceStill(page, source, []);
        await expect.poll(() => diagnosticLog(page)).toContain('hook-rejected');
    });
});

test.describe('S-18: 合流先を選ぶ途中は、Space の押して離すで印を進めない (Space+ドラッグの図の移動だけ)', () => {
    test('@editor 点検と報告を選んで帯の「既存のノードへ合流」を押したあと、Space を押して離しても印は進まず、合流先を選ぶ途中のまま。Space+ドラッグは図を動かすだけ', async ({ page }) => {
        await open(page);
        await mount(page, TASKS);
        await pressLabel(page, 2);
        await pressLabel(page, 3, 'Shift');
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検'), target(3, '報告')]);
        await pressBar(page, 'join-existing');
        await expect.poll(() => toolState(page)).toBe('join-target');

        await page.keyboard.press('Space');
        await expectSourceStill(page, TASKS, [], 'Space を押して離す');
        expect(await toolState(page)).toBe('join-target');

        const before = await page.evaluate(() => (window as unknown as EditorWindow).editor?.view.getTransform());
        const blank = await spot(page, { on: 'blank' });
        await page.keyboard.down('Space');
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down();
        await page.mouse.move(blank.x + 60, blank.y + 40, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('Space');
        await settle(page);
        const after = await page.evaluate(() => (window as unknown as EditorWindow).editor?.view.getTransform());
        expect(after, 'Space+ドラッグで図が動く').not.toEqual(before);
        await expectSourceStill(page, TASKS, [], 'Space+ドラッグ');
        expect(await toolState(page)).toBe('join-target');
    });
});

// ---- S-20 ----

// a の詳細の入力を開いて「詳しく」と打つ
async function openDetails(page: Page): Promise<void> {
    await pressNode(page, 2);
    await page.keyboard.press('d');
    await expect.poll(() => detailsOf(page)).toEqual({ count: 1, value: '', focused: true });
    await page.keyboard.type('詳しく');
    await expect.poll(async () => (await detailsOf(page)).value).toBe('詳しく');
}

// 詳細の入力が開いたままで、値も原文も変わらない (保存も改行もしない)
async function expectDetailsKept(page: Page, message: string): Promise<void> {
    await settle(page);
    expect(await detailsOf(page), message).toEqual({ count: 1, value: '詳しく', focused: true });
    await expectSourceStill(page, DETAILS, [], message);
}

// 区分ごとの、保存にならない修飾キーの Enter。保存にならない方の修飾キー (mac の Ctrl、win の Windows キー) と、
// 保存のキーにほかの修飾キーを足したもの、今も保存にならないもの (mac の ⌥、win の Alt)
const NOT_SAVING: Record<Platform, string[]> = {
    mac: ['Control+Enter', 'Meta+Control+Enter', 'Alt+Enter'],
    win: ['Meta+Enter', 'Control+Meta+Enter', 'Alt+Enter', 'Control+Alt+Enter'],
};

test.describe('S-20: 詳細の入力の保存のキーを OS で分ける (mac は ⌘Enter だけ、win は Ctrl+Enter だけ)', () => {
    for (const platform of ['mac', 'win'] as const) {
        const save = ADD_KEY[platform];
        test(`@editor ${platform}: ${NOT_SAVING[platform].join('、')} は何もしない (保存も改行もしない)。${save}+Enter で保存して閉じる`, async ({ page }) => {
            await open(page, platform);
            await mount(page, DETAILS);
            await openDetails(page);
            for (const key of NOT_SAVING[platform]) {
                await page.keyboard.press(key);
                await expectDetailsKept(page, key);
            }
            const saved = await page.evaluate((source) => {
                const outcome = (window as unknown as EditorWindow).editorHarness.core.editSource(source, { kind: 'setDetails', node: { id: 2, refText: 'a' }, text: '詳しく' });
                return outcome.status === 'edited' ? outcome.source : null;
            }, DETAILS);
            expect(saved).not.toBeNull();
            await page.keyboard.press(`${save}+Enter`);
            await expectSource(page, saved!, [saved!]);
            await expect.poll(async () => (await detailsOf(page)).count).toBe(0);
        });
    }
});

// ---- 書き直した例の承認のコメント (空のタイトルの名前の入力、閉じた枝の名前の変更) ----

// タイトルのない、リストだけの文書 (ルートの名前は空)。1 (名前なし) / 2 準備 / 3 実行
const UNTITLED_TASKS = '- [ ] 準備\n- [ ] 実行\n';

// 見えている名前の入力 (ノード) の要素の高さ (画面の px)。開いていなければ null
const nameInputHeight = (page: Page): Promise<number | null> =>
    page.evaluate(() => {
        const shown = [...document.querySelectorAll('#a .mdag-editor-name-input[data-for="node"]')].filter((element) => element.checkVisibility());
        return shown.length === 1 ? shown[0]!.getBoundingClientRect().height : null;
    });

// ふつうのノード (準備) の名前の入力の高さ。Enter で開いて測り、Esc で閉じる
async function ordinaryInputHeight(page: Page): Promise<number> {
    await pressLabel(page, 2);
    await page.keyboard.press('Enter');
    await expectNameInput(page, '準備', target(2, '準備'));
    const height = await nameInputHeight(page);
    expect(height, 'ふつうのノードの名前の入力').not.toBeNull();
    expect(height!, 'ふつうのノードの名前の入力').toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await expectNoNameInput(page);
    return height!;
}

test.describe('空のタイトルの名前の入力: タイトルが空のルートの名前の入力は、潰れずに 1 行ぶんの高さを取って開く', () => {
    const ways: Array<[string, (page: Page) => Promise<void>]> = [
        [
            '子 (準備) で Shift+Tab',
            async (page) => {
                await pressLabel(page, 2);
                await page.keyboard.press('Shift+Tab');
            },
        ],
        [
            'ルートを選んで Enter',
            async (page) => {
                await pressLabel(page, 2);
                await page.keyboard.press('Shift+Tab');
                await expectNameInput(page, '', target(1, ''), 'ルートを選ぶ');
                await page.keyboard.press('Escape');
                await expectNoNameInput(page);
                await expect.poll(() => selectionOf(page)).toEqual([target(1, '')]);
                await page.keyboard.press('Enter');
            },
        ],
        [
            'ルートを選んで帯の「名前」',
            async (page) => {
                await pressLabel(page, 2);
                await page.keyboard.press('Shift+Tab');
                await expectNameInput(page, '', target(1, ''), 'ルートを選ぶ');
                await page.keyboard.press('Escape');
                await expectNoNameInput(page);
                await expect.poll(() => selectionOf(page)).toEqual([target(1, '')]);
                await pressBar(page, 'rename');
            },
        ],
    ];
    for (const [name, openRootInput] of ways) {
        test(`@editor ${name}で開いたルートの名前の入力の高さは、ふつうのノードの名前の入力の 0.8 倍以上`, async ({ page }) => {
            await open(page);
            await mount(page, UNTITLED_TASKS);
            const ordinary = await ordinaryInputHeight(page);
            await openRootInput(page);
            await expectNameInput(page, '', target(1, ''));
            await settle(page);
            const height = await nameInputHeight(page);
            expect(height, 'ルートの名前の入力').not.toBeNull();
            expect(height!, `ルート ${height}px、ふつうのノード ${ordinary}px`).toBeGreaterThanOrEqual(ordinary * 0.8);
        });
    }
});

test.describe('閉じた枝の名前の変更: 閉じた枝そのものの名前を変えても、変えずに決めても、その枝は閉じたまま', () => {
    // 作業と付録の枝を閉じ、作業を選んで名前の入力を開く
    async function openFoldedWork(page: Page): Promise<void> {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '作業'));
        await page.keyboard.press('Enter');
        await expectNameInput(page, '作業', target(await idOf(page, '作業'), '作業'));
    }

    const RENAMED_PLAN = PLAN.replace('## 作業', '## 改');

    // 名前を「改」に変えて key で決める。決めたあとの操作 (足す、移る) の結果は見ず、閉じた枝だけを見る
    const keys: Array<[string, string]> = [
        ['Enter', 'Enter (決めるだけ)'],
        ['Shift+Enter', 'Shift+Enter (決めて兄弟を下に足す)'],
        ['Control+Enter', 'Ctrl+Enter (mac。決めて下の兄弟へ移る)'],
        ['Shift+Tab', 'Shift+Tab (決めて親へ移る)'],
    ];
    for (const [key, name] of keys) {
        test(`@editor 閉じた作業の名前を「改」に変えて ${name} を押すと、名前が変わり、改 (作業だった枝) は閉じたまま。付録も閉じたまま`, async ({ page }) => {
            await openFoldedWork(page);
            await replaceName(page, '改');
            await page.keyboard.press(key);
            await expect.poll(async () => (await getSource(page)) ?? '').toContain('## 改\n');
            if (key === 'Enter') await expectSource(page, RENAMED_PLAN, [RENAMED_PLAN]);
            await settle(page);
            expect(await foldedNames(page)).toEqual(['付録', '改'].sort());
        });
    }

    test('@editor 閉じた作業の名前の入力を、名前を変えずに Enter で決めても、作業は閉じたまま (原文は変わらない)', async ({ page }) => {
        await openFoldedWork(page);
        await page.keyboard.press('Enter');
        await expectNoNameInput(page);
        await expectSourceStill(page, PLAN, []);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor 閉じた作業の名前の入力を、名前を変えてから Esc でやめても、作業は閉じたまま (原文は変わらない)', async ({ page }) => {
        await openFoldedWork(page);
        await replaceName(page, '改');
        await page.keyboard.press('Escape');
        await expectNoNameInput(page);
        await expectSourceStill(page, PLAN, []);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });

    test('@editor 今のまま: ほかのノード (準備) の名前を変えても、閉じた作業と付録は閉じたまま', async ({ page }) => {
        await open(page);
        await mount(page, PLAN);
        await foldByCircle(page, '作業');
        await foldByCircle(page, '付録');
        await pressNode(page, await idOf(page, '準備'));
        await page.keyboard.press('Enter');
        await expectNameInput(page, '準備', target(await idOf(page, '準備'), '準備'));
        await replaceName(page, '支度');
        await page.keyboard.press('Enter');
        const renamed = PLAN.replace('## 準備', '## 支度');
        await expectSource(page, renamed, [renamed]);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['付録', '作業'].sort());
    });
});

// ---- レビューの指摘で直すもの (records/fix.md の「直す」。再現の文書と手順は records/review-a.md と review-b.md) ----

// 閉じた枝の id (昇順)
const foldedIds = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as EditorWindow).editor?.view.getFolded() ?? []);

// 開閉の丸を押して id の枝を閉じる (同じ名前のノードがある文書で使う)
async function foldById(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `#a .mdag-fold[data-id="${id}"]` }));
    await expect.poll(() => foldedIds(page), `#${id} を閉じる`).toContain(id);
}

// ノードの箱が見えているか (閉じた枝の中なら見えない)
const nodeShown = (page: Page, id: number): Promise<boolean> =>
    page.evaluate((id) => document.querySelector(`#a .mdag-node[data-id="${id}"] .mdag-box`)?.checkVisibility() ?? false, id);

// 図の全部の枝を開く (確認ページの「すべて開く」と同じ図の口)。開いて広がった図を押せるよう、全体表示にする
async function expandAll(page: Page): Promise<void> {
    await page.evaluate(() => (window as unknown as EditorWindow).editor?.view.expandAll());
    await expect.poll(() => foldedIds(page)).toEqual([]);
    await page.evaluate(() => (window as unknown as EditorWindow).editor?.fit());
    await settle(page);
}

// window の受け口 (document の受け口のあと) で読んだ keydown を、key ごとに控える
async function recordKeys(page: Page, key: string): Promise<void> {
    await page.evaluate((key) => {
        const target = window as unknown as { keyLog?: Array<{ repeat: boolean; prevented: boolean; shift: boolean; meta: boolean; ctrl: boolean }> };
        target.keyLog = [];
        window.addEventListener('keydown', (event) => {
            if (event.key === key) target.keyLog!.push({ repeat: event.repeat, prevented: event.defaultPrevented, shift: event.shiftKey, meta: event.metaKey, ctrl: event.ctrlKey });
        });
    }, key);
}

const keyLog = (page: Page): Promise<Array<{ repeat: boolean; prevented: boolean; shift: boolean; meta: boolean; ctrl: boolean }>> =>
    page.evaluate(() => [...((window as unknown as { keyLog?: Array<{ repeat: boolean; prevented: boolean; shift: boolean; meta: boolean; ctrl: boolean }> }).keyLog ?? [])]);

// A-01 の文書。initialExpandLevel 1 で、準備、作業、確認の枝が最初から閉じる
const INITIAL_FOLD_DOC = ['---', 'markdag:', '    initialExpandLevel: 1', '---', '# 計画', '', '## 準備', '- 調べる', '- 決める', '', '## 作業', '1. 停止', '2. 更新', '', '## 確認', '- 点検', ''].join('\n');

// B-01 の文書。initialExpandLevel 2 で、A、a1、B、b1 の枝が最初から閉じる
const INITIAL_FOLD_DOC_B = ['---', 'markdag:', '    initialExpandLevel: 2', '---', '# R', '## A', '- a1', '    - a11', '- a2', '## B', '- b1', '    - b11', '- b2', ''].join('\n');

test.describe('A-01 / B-01: 最初から閉じる枝のある文書で全部開いたあとに足す、消す、元に戻すと、関係のない枝が閉じ直る (S-12)', () => {
    test('@editor initialExpandLevel の文書を全部開き、決めるで ⌘Enter を押して兄弟を足しても、どの枝も開いたまま', async ({ page }) => {
        await open(page);
        await mount(page, INITIAL_FOLD_DOC);
        expect((await foldedIds(page)).length, '最初は閉じた枝がある').toBeGreaterThan(0);
        await expandAll(page);
        await pressNode(page, await idOf(page, '決める'));
        await page.keyboard.press(`${ADD_KEY.mac}+Enter`);
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual([]);
    });

    test('@editor initialExpandLevel の文書を全部開き、調べるを Delete で消しても、⌘Z で戻しても、どの枝も開いたまま', async ({ page }) => {
        await open(page);
        await mount(page, INITIAL_FOLD_DOC);
        await expandAll(page);
        await pressNode(page, await idOf(page, '調べる'));
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await changeLog(page)).length).toBe(1);
        await settle(page);
        expect(await foldedNames(page), '消したあと').toEqual([]);
        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(INITIAL_FOLD_DOC);
        await settle(page);
        expect(await foldedNames(page), '元に戻したあと').toEqual([]);
    });

    test('@editor initialExpandLevel 2 の文書 (review-b) を全部開き、b2 を Delete で消しても、A、a1、B、b1 は開いたまま', async ({ page }) => {
        await open(page);
        await mount(page, INITIAL_FOLD_DOC_B);
        await expandAll(page);
        await pressNode(page, await idOf(page, 'b2'));
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await changeLog(page)).length).toBe(1);
        await settle(page);
        expect(await foldedNames(page)).toEqual([]);
    });

    test('@editor 開閉のコメントで閉じる枝 (作業) を開いてから、準備で ⌘Enter を押して兄弟を足しても、作業は開いたまま', async ({ page }) => {
        await open(page);
        await mount(page, planDoc([], '## 作業 <!-- markmap: fold -->'));
        await expect.poll(() => foldedNames(page)).toEqual(['作業']);
        await expandAll(page);
        await pressNode(page, await idOf(page, '準備'));
        await page.keyboard.press(`${ADD_KEY.mac}+Enter`);
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual([]);
    });

    test('@editor 今のまま (比べ): 閉じた枝が 1 つ残っていれば、ほかの開いた枝は開いたまま (確認だけを閉じて、決めるで ⌘Enter)', async ({ page }) => {
        await open(page);
        await mount(page, INITIAL_FOLD_DOC);
        await expandAll(page);
        await foldByCircle(page, '確認');
        await pressNode(page, await idOf(page, '決める'));
        await page.keyboard.press(`${ADD_KEY.mac}+Enter`);
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await settle(page);
        expect(await foldedNames(page)).toEqual(['確認']);
    });
});

test.describe('A-05 / B-03: 同じ名前の兄弟があると、閉じた枝がずれるか開く (S-12)', () => {
    test('@editor 同じ名前「確認」の 2 つ目を閉じ、1 つ目を消しても、残った確認 (2 つ目だったもの) は閉じたまま (review-a)', async ({ page }) => {
        // 1 計画 / 2 準備 / 3 確認 / 4 a / 5 確認 / 6 b / 7 作業 / 8 停止
        await open(page);
        await mount(page, '# 計画\n\n## 準備\n- 確認\n    - a\n- 確認\n    - b\n\n## 作業\n- 停止\n');
        await foldById(page, 5);
        await pressNode(page, 3);
        await page.keyboard.press('Delete');
        await expect.poll(async () => (await changeLog(page)).length).toBe(1);
        await settle(page);
        // 消したあとは 1 計画 / 2 準備 / 3 確認 / 4 b / 5 作業 / 6 停止
        expect(await foldedIds(page)).toEqual([3]);
        expect(await nodeShown(page, 4), 'b は閉じた枝の中').toBe(false);
    });

    test('@editor 番号付きの手順の「3. 確認」を閉じ、「1. 確認」を消しても、振り直した「2. 確認」は閉じたまま (review-b)', async ({ page }) => {
        // 1 手順 / 2 1. 確認 / 3 画面 / 4 2. 実行 / 5 3. 確認 / 6 ログ
        await open(page);
        await mount(page, '# 手順\n1. 確認\n    - 画面\n2. 実行\n3. 確認\n    - ログ\n');
        await foldById(page, 5);
        await pressNode(page, 2);
        await page.keyboard.press('Delete');
        await expect.poll(() => getSource(page)).toBe('# 手順\n1. 実行\n2. 確認\n    - ログ\n');
        await settle(page);
        expect(await foldedNames(page)).toEqual(['2. 確認']);
    });

    test('@editor 「新しいノード」という名前の閉じた枝の上に Shift+⌘Enter で同じ名前の兄弟を足しても、もとの枝は閉じたまま (review-b)', async ({ page }) => {
        // 1 R / 2 新しいノード / 3 子 / 4 b。足したあとは 1 R / 2 新しいノード (足した) / 3 新しいノード (もとの) / 4 子 / 5 b
        await open(page);
        await mount(page, `# R\n- ${NEW}\n    - 子\n- b\n`);
        await foldById(page, 2);
        await pressNode(page, 2);
        await page.keyboard.press(`Shift+${ADD_KEY.mac}+Enter`);
        await expect.poll(() => getSource(page)).toBe(`# R\n- ${NEW}\n- ${NEW}\n    - 子\n- b\n`);
        await settle(page);
        expect(await foldedIds(page)).toEqual([3]);
        expect(await nodeShown(page, 4), '子は閉じた枝の中').toBe(false);
    });
});

// B-02 の文書。項目の間に空行のある番号付きリスト (図の名前は「1.」「2.」)。1 R / 2 1. (a) / 3 c / 4 2. (b) / 5 d
const LOOSE_NUMBERED = '---\nmarkdag: {}\n---\n# R\n\n1. a\n\n   - c\n\n2. b\n\n   - d\n';

test.describe('B-02: 項目の間に空行のある番号付きリストで、閉じた枝が隣の枝へ移る (S-12)', () => {
    for (const [name, key, foldedAfter, cAfter, dAfter] of [
        ['Shift+⌘Enter で a の上に足す', `Shift+${ADD_KEY.mac}+Enter`, 5, 4, 6],
        ['⌘Enter で a の下に足す', `${ADD_KEY.mac}+Enter`, 5, 3, 6],
    ] as const) {
        test(`@editor b の枝を閉じ、${name}と、b は閉じたままで、a の枝は開いたまま`, async ({ page }) => {
            await open(page);
            await mount(page, LOOSE_NUMBERED);
            await foldById(page, 4);
            await pressNode(page, 2);
            await page.keyboard.press(key);
            await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
            await settle(page);
            expect(await foldedIds(page)).toEqual([foldedAfter]);
            expect(await nodeShown(page, cAfter), 'c (a の子) は見える').toBe(true);
            expect(await nodeShown(page, dAfter), 'd (b の子) は閉じた枝の中').toBe(false);
        });
    }
});

test.describe('A-02: 元に戻す / やり直すで選び直したノードは、閉じた枝の中に隠さず見える所まで開く', () => {
    const DOC_A02 = '# 計画\n\n## 準備\n- 調べる\n- 決める\n\n## 作業\n- 停止\n';

    test('@editor 調べるを Delete で消し、準備を閉じてから ⌘Z を押すと、戻った調べるが選ばれ、見える (準備が開く)。続けて Delete で見えないノードを消さない', async ({ page }) => {
        // 1 計画 / 2 準備 / 3 調べる / 4 決める / 5 作業 / 6 停止
        await open(page);
        await mount(page, DOC_A02);
        await pressNode(page, 3);
        await page.keyboard.press('Delete');
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '準備')]);
        await foldById(page, 2);
        await focusDiagram(page);
        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC_A02);
        await expect.poll(() => selectionOf(page)).toEqual([target(3, '調べる')]);
        await expect.poll(() => nodeShown(page, 3), '戻した調べるは見える').toBe(true);
        expect(await foldedIds(page)).not.toContain(2);
    });

    test('@editor 決めるに子を足して元に戻し、準備を閉じてから ⌘⇧Z でやり直すと、選び直した足したノードが見える', async ({ page }) => {
        await open(page);
        await mount(page, DOC_A02);
        await pressNode(page, 4);
        await page.keyboard.press('Tab');
        await expect.poll(async () => (await nameInputOf(page)).value).toBe(NEW);
        await page.keyboard.press('Enter');
        await expectNoNameInput(page);
        const added = '# 計画\n\n## 準備\n- 調べる\n- 決める\n    - 新しいノード\n\n## 作業\n- 停止\n';
        await expect.poll(() => getSource(page)).toBe(added);
        await focusDiagram(page);
        await page.keyboard.press('ControlOrMeta+KeyZ');
        await expect.poll(() => getSource(page)).toBe(DOC_A02);
        await foldById(page, 2);
        await focusDiagram(page);
        await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
        await expect.poll(() => getSource(page)).toBe(added);
        await expect.poll(() => selectionOf(page)).toEqual([target(5, NEW)]);
        await expect.poll(() => nodeShown(page, 5), 'やり直した新しいノードは見える').toBe(true);
    });
});

test.describe('A-03: 図の外で押し始めた Space の、押したままの繰り返しでは印を進めない (states.md の r7)', () => {
    test('@editor 点検を選び、図の外で Space を押したまま、ポインタを図の上へ動かして繰り返しの keydown を図に受けさせ、離しても点検は進まない', async ({ page }) => {
        await open(page);
        await mount(page, TASKS);
        // 頁が送られて図が見えなくならないよう、頁のスクロールを止めておく (図の外で押した Space は図が受けず、ブラウザの既定に任せる)
        await page.evaluate(() => {
            document.documentElement.style.overflow = 'hidden';
        });
        await pressLabel(page, 2);
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検')]);
        // 図の外 (下の空の図の領域) を押す。フォーカスは body、選択は残る
        await page.mouse.click(500, 700);
        await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検')]);
        await recordKeys(page, ' ');

        await page.keyboard.down('Space');
        const blank = await spot(page, { on: 'blank' });
        await page.mouse.move(blank.x, blank.y, { steps: 4 });
        await page.keyboard.down('Space');
        await page.keyboard.up('Space');
        await settle(page);
        const log = await keyLog(page);
        expect(log.map((entry) => entry.repeat), '最初の押下と繰り返しの押下').toEqual([false, true]);
        expect(log[0]?.prevented, '最初の押下は図が受けない').toBe(false);
        await expectSourceStill(page, TASKS, [], '図の外で押し始めた Space');
    });
});

test.describe('B-06: ポインタを押したまま (ドラッグや矩形選択の途中) に Space を押して離しても、印を進めない', () => {
    test('@editor 点検を選び、点検を押したまま少し動かしている間に Space を押して離し、元の位置で離しても、点検は進まない', async ({ page }) => {
        await open(page);
        await mount(page, TASKS);
        await pressLabel(page, 2);
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検')]);
        const from = await spot(page, { on: 'text', selector: `${nodeSelector(2)} .mdag-content` });
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 14, from.y + 10, { steps: 4 });
        await page.keyboard.press('Space');
        await page.mouse.move(from.x, from.y, { steps: 4 });
        await page.mouse.up();
        await expectSourceStill(page, TASKS, []);
    });

    test('@editor 点検を選び、何もないところから矩形選択している途中に Space を押して離しても、点検は進まない', async ({ page }) => {
        await open(page);
        await mount(page, TASKS);
        await pressLabel(page, 2);
        await expect.poll(() => selectionOf(page)).toEqual([target(2, '点検')]);
        const blank = await spot(page, { on: 'blank' });
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down();
        await page.mouse.move(blank.x + 30, blank.y + 20, { steps: 4 });
        await page.keyboard.press('Space');
        await page.mouse.move(blank.x + 40, blank.y + 30, { steps: 2 });
        await page.mouse.up();
        await expectSourceStill(page, TASKS, []);
    });
});

test.describe('B-09: ノードを 2 つ以上選んでいるときの Enter と、修飾キーつきの Enter は、何もせず既定の動きを止める (S-09 と同じく、選択中のキーをブラウザに流さない)', () => {
    const DOC_B09 = '# R\n- a\n- b\n- c\n';
    for (const key of ['Enter', 'Shift+Enter', 'Meta+Enter', 'Shift+Meta+Enter', 'Control+Enter', 'Shift+Control+Enter']) {
        test(`@editor a と c を選んで ${key} を押すと、何も変わらず、既定の動きを止める`, async ({ page }) => {
            await open(page);
            await mount(page, DOC_B09);
            await pressNode(page, 4);
            await pressNode(page, 2, 'Shift');
            await expect.poll(() => selectionOf(page)).toEqual([target(2, 'a'), target(4, 'c')]);
            await focusDiagram(page);
            await recordKeys(page, 'Enter');
            await page.keyboard.press(key);
            await settle(page);
            const log = await keyLog(page);
            expect(log, key).toHaveLength(1);
            expect(log[0]?.prevented, key).toBe(true);
            expect(await selectionOf(page)).toEqual([target(2, 'a'), target(4, 'c')]);
            expect((await nameInputOf(page)).count).toBe(0);
            await expectSourceStill(page, DOC_B09, []);
        });
    }
});

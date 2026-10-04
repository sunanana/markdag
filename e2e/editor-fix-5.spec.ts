// GUI 編集で依頼者が図を触って出した指摘のうち、帯の「子の追加」「兄弟追加」の名前と絵、道具箱の「詳細表示」の絵、
// 帯の「詳細編集」の絵を、ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 子の絵は箱の右に + (丸で囲まない)、兄弟の絵は箱の下に +。詳細表示の絵は上に角を丸めた箱と、その下の縦線と横線 3 本。
// 詳細編集の絵は詳細の絵の右下に鉛筆を重ねる。凡例のパネルの目の絵は変えない。
// 見た目そのもの (絵の形、座標の値) は見ない (見た目は依頼者が画像で確かめる)。見るのは、帯のボタンの名前の文字と並びと、絵を取り違えていないこと
// (どの絵とどの絵が同じか別か、ある絵の図形が別の絵にもあるか) だけ。
// 絵は、ボタンの中の SVG の図形ごとに、要素の名前と属性 (名前の順に並べた名前と値) を文字にしたものの集まりとして比べる (座標の値は期待に書かない)。
// 名前は、ボタンの中の SVG の外の文字 (空白をつめる)。反映は expect.poll で待つ
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
};

const DIST = resolve('dist');

// markdag.editor を書いた文書。markdag の行は markdag の下の字下げ (4 桁) からの相対
function docWith(body: string[], markdag: string[] = []): string {
    return ['---', 'markdag:', '    edgeHighlight: true', ...markdag.map((line) => `    ${line}`), '    editor:', '        mode: edit', '---', '', ...body].join('\n');
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;

const DOC = docWith(BODY);
// Design と配下がグループ design (枠を出す)、Build と配下がグループ build (枠を隠す) に入る文書。
// 凡例のパネルのグループの行に、枠の表示のボタンが枠を出しているときの絵と隠しているときの絵で 1 つずつ並ぶ
const DOC_GROUPS = docWith(
    BODY.map((line) => (line === '## Design' ? '## Design %design' : line === '## Build' ? '## Build %build' : line)),
    [
        'groups:',
        '    design:',
        '        label: 設計',
        '        color: "#3B7DD8"',
        '        boundary: true',
        '    build:',
        '        label: 実装',
        '        color: "#E8833A"',
        '        boundary: false',
    ],
);

// 1 つのノード (ルートでない) を選んだ帯のボタンの並びと名前 (並びは今のまま。sep は区切り)
const NODE_BAR: ReadonlyArray<readonly [string, string] | 'sep'> = [
    ['rename', '名前'],
    ['child', '子の追加'],
    ['sibling', '兄弟追加'],
    ['details', '詳細編集'],
    ['tag-add', 'タグ追加'],
    ['tag-select', 'タグ選択'],
    'sep',
    ['delete', '削除'],
];
// ルートを選んだ帯 (兄弟追加と削除はない)
const ROOT_BAR: ReadonlyArray<readonly [string, string] | 'sep'> = [
    ['rename', '名前'],
    ['child', '子の追加'],
    ['details', '詳細編集'],
    ['tag-add', 'タグ追加'],
    ['tag-select', 'タグ選択'],
];

interface Point {
    x: number;
    y: number;
}

// ボタンの読み取り。shapes は絵の SVG の図形ごとの文字 (並べ替えたもの)。絵がなければ null
interface ButtonInfo {
    key: string;
    name: string;
    shapes: string[] | null;
}

interface BarRead {
    for: string | null;
    // 区切りは sep
    items: Array<ButtonInfo | 'sep'>;
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
        (window as unknown as EditorWindow).editors = {};
    });
}

async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = { animate: false };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 要素 (か中の要素) が表に出ている点 (真ん中に近い点から試す)。図の領域はスクロールを戻すので、座標を決めて page.mouse で押す
async function spotOn(page: Page, selector: string): Promise<Point> {
    const found = await page.evaluate((selector) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const element = [...document.querySelectorAll(selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const step = Math.max(1, Math.min(rect.width, rect.height) / 8);
        const points: Point[] = [];
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
    }, selector);
    if (!found) throw new Error(`押せる点がない: ${selector}`);
    return found;
}

// 選択の道具でノードを 1 つ押して選び、帯が 1 つ出るまで待つ
async function selectNode(page: Page, id: number): Promise<void> {
    const point = await spotOn(page, `${nodeSelector(id)} .mdag-box`);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect
        .poll(() => page.evaluate(() => [...document.querySelectorAll('#a .mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id')))), `ノード ${id} を選ぶ`)
        .toEqual([id]);
    await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for), `ノード ${id} の帯`).toEqual(['node']);
}

// ページの中で使う読み取りの関数 (ボタンの名前と絵の図形の文字)。page.evaluate に関数の文字として渡す
const READERS = `
    window.__fix5 = {
        // ボタンの中の SVG の外の文字 (空白をつめる)
        nameOf(button) {
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            const parts = [];
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                if (text.parentElement && text.parentElement.closest('svg')) continue;
                parts.push(text.textContent || '');
            }
            return parts.join(' ').replace(/\\s+/g, ' ').trim();
        },
        // ボタンの中の最初の SVG の図形ごとの文字 (要素の名前と、名前の順に並べた属性)。並べ替えて返す
        shapesOf(button) {
            const svg = button.querySelector('svg');
            if (!svg) return null;
            return [...svg.querySelectorAll('*')]
                .map((shape) => shape.tagName.toLowerCase() + '(' + [...shape.attributes].map((attribute) => attribute.name + '=' + attribute.value).sort().join(' ') + ')')
                .sort();
        },
    };
`;

async function installReaders(page: Page): Promise<void> {
    await page.evaluate(READERS);
}

// 見えている操作の帯 (ボタンの data-command、名前、絵)
async function barsOf(page: Page): Promise<BarRead[]> {
    await installReaders(page);
    return page.evaluate(() => {
        const readers = (window as unknown as { __fix5: { nameOf(button: Element): string; shapesOf(button: Element): string[] | null } }).__fix5;
        return [...document.querySelectorAll('#a .mdag-editor-bar')]
            .filter((bar) => bar.checkVisibility())
            .map((bar) => ({
                for: bar.getAttribute('data-for'),
                items: [...bar.querySelectorAll('.mdag-editor-bar-button, .mdag-editor-bar-sep')]
                    .filter((item) => item.checkVisibility())
                    .map((item) =>
                        item.classList.contains('mdag-editor-bar-sep')
                            ? ('sep' as const)
                            : { key: item.getAttribute('data-command') ?? '', name: readers.nameOf(item), shapes: readers.shapesOf(item) },
                    ),
            }));
    });
}

// 道具箱のボタン (data-tool、名前、絵)
async function toolsOf(page: Page): Promise<ButtonInfo[]> {
    await installReaders(page);
    return page.evaluate(() => {
        const readers = (window as unknown as { __fix5: { nameOf(button: Element): string; shapesOf(button: Element): string[] | null } }).__fix5;
        return [...document.querySelectorAll('#a .mdag-editor-toolbox .mdag-editor-tool')].map((button) => ({
            key: button.getAttribute('data-tool') ?? '',
            name: readers.nameOf(button),
            shapes: readers.shapesOf(button),
        }));
    });
}

// 凡例のパネルのグループの行の、枠の表示のボタン (data-group、押された印 aria-pressed、絵)。見えていない行のボタンも読む
async function boundaryButtonsOf(page: Page): Promise<Array<{ group: string; pressed: string | null; shapes: string[] | null }>> {
    await installReaders(page);
    return page.evaluate(() => {
        const readers = (window as unknown as { __fix5: { shapesOf(button: Element): string[] | null } }).__fix5;
        return [...document.querySelectorAll('#a .mdag-editor-legend-row[data-group]')].flatMap((row) =>
            [...row.querySelectorAll('.mdag-editor-legend-action[data-action="boundary"]')].map((button) => ({
                group: row.getAttribute('data-group') ?? '',
                pressed: button.getAttribute('aria-pressed'),
                shapes: readers.shapesOf(button),
            })),
        );
    });
}

const signature = (shapes: string[] | null | undefined): string => (shapes ? shapes.join(' | ') : '(絵がない)');
const sameIcon = (a: string[] | null | undefined, b: string[] | null | undefined): boolean => a != null && b != null && signature(a) === signature(b);
// a の図形のうち b にもあるもの
const sharedShapes = (a: string[] | null | undefined, b: string[] | null | undefined): string[] => (a && b ? a.filter((shape) => b.includes(shape)) : []);

// 確かめた結果。よければ true、だめなら中身の文 (失敗の差分に出るように)
const verdict = (ok: boolean, detail: string): true | string => (ok ? true : detail);

function buttonOf(items: Array<ButtonInfo | 'sep'>, key: string): ButtonInfo {
    const found = items.find((item): item is ButtonInfo => item !== 'sep' && item.key === key);
    if (!found) throw new Error(`${key} のボタンがない`);
    return found;
}

const shape = (items: Array<ButtonInfo | 'sep'>): Array<readonly [string, string] | 'sep'> => items.map((item) => (item === 'sep' ? 'sep' : ([item.key, item.name] as const)));

test.describe('帯の「子の追加」「兄弟追加」の名前 (F-13)', () => {
    test('@editor 1 つのノード (ルートでない) を選んだ帯のボタンの名前は、名前、子の追加、兄弟追加、詳細編集、タグ追加、タグ選択、(区切り)、削除 の順 (data-command の並びは今のまま。見出しと項目)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const [id, label] of [
            [TASK_A, 'Task A (項目)'],
            [DESIGN, 'Design (見出し)'],
        ] as const) {
            await selectNode(page, id);
            const [bar] = await barsOf(page);
            expect(shape(bar?.items ?? []), label).toEqual(NODE_BAR);
        }
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor ルートを選んだ帯のボタンの名前は、名前、子の追加、詳細編集、タグ追加、タグ選択 の順 (兄弟追加と削除はない。B-012)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNode(page, ROOT);
        const [bar] = await barsOf(page);
        expect(shape(bar?.items ?? [])).toEqual(ROOT_BAR);
        expect(await getSource(page)).toBe(DOC);
    });
});

test.describe('絵を取り違えていない (F-13、F-14、F-15)', () => {
    test('@editor 帯の「子の追加」と「兄弟追加」の絵は互いに別で、帯のほかのボタンの絵とも別 (どのボタンにも絵がある)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNode(page, TASK_A);
        const [bar] = await barsOf(page);
        const buttons = (bar?.items ?? []).filter((item): item is ButtonInfo => item !== 'sep');
        expect(buttons.map((button) => button.key)).toEqual(NODE_BAR.filter((item) => item !== 'sep').map(([key]) => key));
        const child = buttonOf(buttons, 'child');
        const sibling = buttonOf(buttons, 'sibling');
        const others = buttons.filter((button) => button.key !== 'child' && button.key !== 'sibling');
        expect({
            drawn: verdict(
                buttons.every((button) => (button.shapes?.length ?? 0) > 0),
                `絵のないボタン: ${buttons
                    .filter((button) => (button.shapes?.length ?? 0) === 0)
                    .map((button) => button.key)
                    .join('、')}`,
            ),
            childVsSibling: verdict(!sameIcon(child.shapes, sibling.shapes), `子の追加と兄弟追加が同じ絵: ${signature(child.shapes)}`),
            childVsOthers: verdict(
                others.every((button) => !sameIcon(child.shapes, button.shapes)),
                `子の追加と同じ絵: ${others
                    .filter((button) => sameIcon(child.shapes, button.shapes))
                    .map((button) => button.key)
                    .join('、')}`,
            ),
            siblingVsOthers: verdict(
                others.every((button) => !sameIcon(sibling.shapes, button.shapes)),
                `兄弟追加と同じ絵: ${others
                    .filter((button) => sameIcon(sibling.shapes, button.shapes))
                    .map((button) => button.key)
                    .join('、')}`,
            ),
        }).toEqual({ drawn: true, childVsSibling: true, childVsOthers: true, siblingVsOthers: true });
    });

    test('@editor 道具箱の「詳細表示」の絵は、凡例のパネルの枠の表示の絵 (枠を出しているときの目と、隠しているときの絵のどちらとも) と別で、道具箱のほかのボタンの絵とも別 (F-14: 目の絵から詳細の絵へ)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_GROUPS);
        const tools = await toolsOf(page);
        const details = buttonOf(tools, 'details');
        expect(details.name).toBe('詳細表示');
        // 比べる相手 (凡例のパネルの枠の表示の絵) が読めていることの確かめ: 出している design と隠している build の 1 つずつで、2 つの絵は別
        const boundary = await boundaryButtonsOf(page);
        expect(boundary.map((item) => [item.group, item.pressed])).toEqual([
            ['design', 'true'],
            ['build', 'false'],
        ]);
        const [shown, hidden] = boundary;
        expect((shown?.shapes?.length ?? 0) > 0 && (hidden?.shapes?.length ?? 0) > 0, '枠の表示のボタンの絵').toBe(true);
        expect(sameIcon(shown?.shapes, hidden?.shapes), '枠を出しているときと隠しているときの絵').toBe(false);

        const others = tools.filter((tool) => tool.key !== 'details');
        expect({
            drawn: verdict((details.shapes?.length ?? 0) > 0, '詳細表示に絵がない'),
            vsBoundaryShown: verdict(!sameIcon(details.shapes, shown?.shapes), `凡例のパネルの枠を出しているときの絵 (目) と同じ: ${signature(details.shapes)}`),
            vsBoundaryHidden: verdict(!sameIcon(details.shapes, hidden?.shapes), `凡例のパネルの枠を隠しているときの絵と同じ: ${signature(details.shapes)}`),
            vsOtherTools: verdict(
                others.every((tool) => !sameIcon(details.shapes, tool.shapes)),
                `道具箱で同じ絵: ${others
                    .filter((tool) => sameIcon(details.shapes, tool.shapes))
                    .map((tool) => tool.key)
                    .join('、')}`,
            ),
        }).toEqual({ drawn: true, vsBoundaryShown: true, vsBoundaryHidden: true, vsOtherTools: true });
        expect(errors).toEqual([]);
    });

    test('@editor 帯の「詳細編集」の絵は、道具箱の「詳細表示」の絵を土台にし (詳細表示の絵の図形が 1 つ以上そのまま入る)、詳細表示の絵そのものとも、帯の「名前」の鉛筆の絵とも、帯のほかのボタンの絵とも別 (F-15: 文書の絵から、詳細の絵に鉛筆を重ねた絵へ)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const display = buttonOf(await toolsOf(page), 'details');
        await selectNode(page, TASK_A);
        const [bar] = await barsOf(page);
        const buttons = (bar?.items ?? []).filter((item): item is ButtonInfo => item !== 'sep');
        const edit = buttonOf(buttons, 'details');
        expect(edit.name).toBe('詳細編集');
        const rename = buttonOf(buttons, 'rename');
        const others = buttons.filter((button) => button.key !== 'details');
        const shared = sharedShapes(display.shapes, edit.shapes);
        expect({
            drawn: verdict((edit.shapes?.length ?? 0) > 0, '詳細編集に絵がない'),
            basedOnDisplay: verdict(shared.length > 0, `詳細表示の絵 (${signature(display.shapes)}) の図形が、詳細編集の絵 (${signature(edit.shapes)}) にない`),
            vsDisplay: verdict(!sameIcon(edit.shapes, display.shapes), `道具箱の詳細表示と同じ絵: ${signature(edit.shapes)}`),
            vsRename: verdict(!sameIcon(edit.shapes, rename.shapes), `名前の鉛筆と同じ絵: ${signature(edit.shapes)}`),
            vsOthers: verdict(
                others.every((button) => !sameIcon(edit.shapes, button.shapes)),
                `帯で同じ絵: ${others
                    .filter((button) => sameIcon(edit.shapes, button.shapes))
                    .map((button) => button.key)
                    .join('、')}`,
            ),
        }).toEqual({ drawn: true, basedOnDisplay: true, vsDisplay: true, vsRename: true, vsOthers: true });
    });
});

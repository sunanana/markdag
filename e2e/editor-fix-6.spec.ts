// GUI 編集で依頼者が図を触って出した見た目の指摘のうち、帯を図の領域に収まるよう左右にずらすこと、
// 名前の入力、タグのパネル、詳細の入力を開いている間は帯を隠すこと、全体表示は道具箱とセグメントだけを避けることを、
// ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 帯は道具箱の右 8px から図の領域の右の端の 8px 手前までに収める。開いている間は帯を隠し、閉じたら戻す。
// 全体表示は凡例のパネルを避けない。帯は相手の上、入らなければ下で、間はノードとグループ 20px、2 つ以上 24px。
// 出口を使わない図の全体表示は変えない。
// 見た目そのもの (色、余白、影) は見ない。帯、道具箱、セグメント、図の領域 (#a)、ノードの箱、枠、枠のラベルの矩形 (getBoundingClientRect)、
// 帯の有無 (checkVisibility)、表示位置 (view.getTransform) を見る。
// 帯を左右にずらすかの確かめは、帯を出してから図をパンして、相手を図の領域の左の端 (道具箱の右) と右の端と真ん中に置いて読む
// (どれだけずらすかは「端からちょうど 8px」まで。ずらしすぎない)。全体表示は凡例のパネルの下に入るかを見ない (依頼者が「構わない」とした)。
// 反映は expect.poll で待ち、「出ない」「変わらない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { MarkdagDiagram, ViewTransform } from '../src/core';
import type { EditorModeOption, EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // render で描いた閲覧の図
    diagram?: MarkdagDiagram;
};

const DIST = resolve('dist');

// 帯と道具箱の右の辺、帯と図の領域の右の辺の間。小数の丸めの分 0.5px の余裕を見て、
// ずらしすぎない (端の所までにとどめる) ことは 1.5px の余裕で見る
const EDGE_ROOM = 8;
const EDGE_ROOM_MIN = EDGE_ROOM - 0.5;
const EDGE_ROOM_MAX = EDGE_ROOM + 1.5;
// 帯と相手の間 (1 つのノードとグループは 20px、2 つ以上は 24px)。小数の丸めの分 0.5px の余裕を見る
const BAR_GAP = 20;
const BAR_GAP_AROUND_BOUNDS = 24;

// 確認ページの小さな見本と同じ文書。閲覧と GUI 編集を切り替えられ (左上にセグメント)、GUI 編集で始まる。
// 図の領域 1000×600 の全体表示では、今はルートの「企画」が道具箱の下に入る。
// ノードは 企画 1、調査 2、ユーザーインタビュー 3、競合の比較 4、設計 5、画面 6、API 7、実装 8、フロントエンド 9、バックエンド 10、
// テスト 11、単体テスト 12、結合テスト 13。実装と配下がグループ dev (開発)、テストと配下が test (テスト) の枠に入る
const SIMPLE = [
    '---',
    'markdag:',
    '    editor:',
    '        mode: switch',
    '        default: edit',
    '    relations:',
    '        depends:',
    '            - 調査 --> 設計',
    '            - 実装 --> テスト',
    '    groups:',
    '        dev:',
    '            label: 開発',
    '            color: "#3B7DD8"',
    '            boundary: true',
    '        test:',
    '            label: テスト',
    '            color: "#E0A100"',
    '            boundary: true',
    '---',
    '',
    '# 企画',
    '',
    '## 調査',
    '- ユーザーインタビュー',
    '- 競合の比較',
    '',
    '## 設計',
    '- 画面',
    '- API',
    '',
    '## 実装 %dev',
    '- フロントエンド',
    '- バックエンド',
    '',
    '## テスト %test',
    '- 単体テスト',
    '- 結合テスト',
    '',
].join('\n');
// 同じ文書を閲覧で始めるもの (mode: switch、default: view。左上にセグメント)
const SIMPLE_VIEW_FIRST = SIMPLE.replace('        default: edit', '        default: view');
const PLAN = 1;
const RESEARCH = 2;
const DESIGN_S = 5;
const BUILD_S = 8;
const UNIT_TEST = 12;

// 確認ページの葉の見本と同じ groups と本文。editor だけを GUI 編集に替えた。
// infra (基盤の作業) は 4 月と 5 月の基盤の配下の葉で、枠が 2 つ描かれる。下の枠のラベルを押したグループの帯が、
// 確認ページの図の領域では右の辺からはみ出していた
const LEAVES = [
    '---',
    'title: 葉だけの指定と色だけのグループ',
    'markdag:',
    '    editor:',
    '        mode: edit',
    '    groups:',
    '        alice:',
    '            label: 佐藤',
    '            color: "#E07A5F"',
    '        bob:',
    '            label: 鈴木',
    '            color: "#3D85C6"',
    '        carol:',
    '            label: 高橋',
    '            color: "#81B29A"',
    '        infra:',
    '            label: 基盤の作業',
    '            color: "#6B7280"',
    '            boundary: true',
    '            members:',
    '                - 4月/基盤/*',
    '                - 5月/基盤/*',
    '---',
    '',
    '# 四半期のロードマップ',
    '',
    '## 4月',
    '### 基盤',
    '- DB の移行 %alice',
    '- CI の整備 %bob',
    '### 機能',
    '- 検索の改善 %alice',
    '- 通知 %carol',
    '',
    '## 5月',
    '### 基盤',
    '- 監視の強化 %bob',
    '- バックアップの見直し %carol',
    '### 機能',
    '- エクスポート %carol',
    '- 招待機能 %alice',
    '',
].join('\n');

// グループの複数選択のテストの文書の形 (Root の下に 3 つのグループ。GUI 編集だけ。セグメントなし)。全体表示が上限の 2 倍になり、ルートが道具箱の下に入る
const DOC3 = [
    '---',
    'markdag:',
    '    edgeHighlight: true',
    '    groups:',
    '        design:',
    '            label: 設計',
    '            color: "#3B7DD8"',
    '            boundary: true',
    '        build:',
    '            label: 実装',
    '            color: "#E8833A"',
    '            boundary: true',
    '        ops:',
    '            label: 運用',
    '            color: "#2E9E6B"',
    '            boundary: true',
    '    editor:',
    '        mode: edit',
    '---',
    '',
    '# Root',
    '',
    '## Design %design',
    '',
    '- Task A',
    '- Task B',
    '',
    '## Build %build',
    '',
    '- Leaf',
    '',
    '## Ops %ops',
    '',
    '- Run',
    '- Watch',
    '',
].join('\n');

// 入力とパネルの文書 (GUI 編集だけ)。ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const DOC = ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '---', '', ...BODY].join('\n');
const TASK_A = 3;
const TASK_B = 4;
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Build', 6: 'Leaf' };

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
        (window as unknown as EditorWindow).editors = {};
    });
}

async function mount(page: Page, markdown: string, mode?: EditorModeOption): Promise<void> {
    await page.evaluate(
        ({ markdown, mode }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            const options: EditorOptions = { animate: false };
            if (mode !== null) options.mode = mode;
            target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, mode: mode ?? null },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 図を片付けて、同じページで描き直す
async function remount(page: Page, markdown: string, mode?: EditorModeOption): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        delete target.editors.a;
        target.diagram?.destroy();
        delete target.diagram;
    });
    await mount(page, markdown, mode);
}

// render の閲覧の図 (出口を使わない図) を描く
async function renderView(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        target.diagram = target.editorHarness.core.render(container, markdown, { animate: false });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
}

// 「出ない」「変わらない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

async function transformOf(page: Page): Promise<ViewTransform> {
    const transform = await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        return (target.editors.a?.view ?? target.diagram?.view)?.getTransform() ?? null;
    });
    if (!transform) throw new Error('#a の図がない');
    return transform;
}

const sameTransform = (a: ViewTransform, b: ViewTransform): boolean => Math.abs(a.k - b.k) < 1e-3 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
const fmt = (transform: ViewTransform): string => `k ${transform.k.toFixed(4)}, x ${transform.x.toFixed(1)}, y ${transform.y.toFixed(1)}`;

// 図の倍率を 1 にする (図の領域の中心のまわりで縮める)
async function zoomToOne(page: Page): Promise<void> {
    await page.evaluate(() => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        const container = document.getElementById('a');
        if (!view || !container) throw new Error('#a の図がない');
        view.zoomBy(1 / view.getTransform().k, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
    });
    await expect.poll(async () => (await transformOf(page)).k).toBeCloseTo(1, 3);
    await settle(page);
}

const panBy = (page: Page, dx: number, dy: number): Promise<void> => page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const frameSelector = (group: string): string => `#a .mdag-frame[data-group="${group}"]`;
const frameLabelSelector = (group: string): string => `#a .mdag-frame-label[data-group="${group}"]`;

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 見えている要素の矩形 (画面の座標。selector に合う見えている要素の順)
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

async function rectOf(page: Page, selector: string, index = 0): Promise<Box> {
    const box = (await rectsOf(page, selector))[index];
    if (!box) throw new Error(`見えている要素がない: ${selector} (${index})`);
    return box;
}

const areaBox = (page: Page): Promise<Box> => rectOf(page, '#a');
const toolboxBox = (page: Page): Promise<Box> => rectOf(page, '#a .mdag-editor-toolbox');
const nodeBox = (page: Page, id: number): Promise<Box> => rectOf(page, `${nodeSelector(id)} .mdag-box`);

function union(boxes: Box[]): Box {
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const show = (box: Box): string => `(${round1(box.left)}, ${round1(box.top)})-(${round1(box.right)}, ${round1(box.bottom)})`;

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank' }
    // 要素 (か中の要素) が表に出ている点。index は selector に合う見えている要素の何番目か (既定 0)
    | { on: 'element'; selector: string; index?: number };

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
        const element = [...document.querySelectorAll(target.selector)].filter((item) => item.checkVisibility())[target.index ?? 0];
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

async function press(page: Page, point: Point, modifier?: string): Promise<void> {
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
}

async function pressNode(page: Page, id: number, modifier?: string): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }), modifier);
}

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

// 選んでいるノードの id (図の印、昇順)
const markedOf = (page: Page): Promise<number[]> =>
    page.evaluate(() =>
        [...document.querySelectorAll('#a .mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b),
    );

// ノードを選ぶ: 最初のノードを修飾キーなしで押し、残りを Shift +クリックで足す
async function selectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const [first, ...rest] = ids;
    if (first === undefined) throw new Error('選ぶノードがない');
    await pressNode(page, first);
    await expect.poll(() => markedOf(page), message).toEqual([first]);
    for (const id of rest) await pressNode(page, id, 'Shift');
    await expect.poll(() => markedOf(page), message).toEqual([...ids].sort((a, b) => a - b));
}

// グループの index 番目 (描いた順) の枠のラベルを押して、そのグループを選ぶ (選択の道具)
async function pressFrameLabel(page: Page, group: string, index = 0): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: frameLabelSelector(group), index }));
    await expect.poll(async () => (await barsOf(page)).map((bar) => bar.for), `グループ ${group} の帯`).toEqual(['group']);
}

interface BarRead {
    for: string | null;
    rect: Box;
}

// 見えている操作の帯
async function barsOf(page: Page): Promise<BarRead[]> {
    return page.evaluate(() => {
        return [...document.querySelectorAll('#a .mdag-editor-bar')]
            .filter((bar) => bar.checkVisibility())
            .map((bar) => {
                const rect = bar.getBoundingClientRect();
                return { for: bar.getAttribute('data-for'), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
            });
    });
}

const barCount = async (page: Page): Promise<number> => (await barsOf(page)).length;
const barKinds = async (page: Page): Promise<Array<string | null>> => (await barsOf(page)).map((bar) => bar.for);

// 帯の相手 (ノード 1 つ、ノード 2 つ以上の全体、グループの index 番目の枠) の画面の矩形
type BarTarget = { node: number } | { nodes: number[] } | { group: string; frame: number };

async function targetBox(page: Page, target: BarTarget): Promise<Box> {
    if ('node' in target) return nodeBox(page, target.node);
    if ('nodes' in target) return union(await Promise.all(target.nodes.map((id) => nodeBox(page, id))));
    const box = (await page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)].map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
    }, frameSelector(target.group)))[target.frame];
    if (!box) throw new Error(`グループ ${target.group} の ${target.frame} 番目の枠がない`);
    return box;
}

// 相手の矩形の中心を、図の領域の (x, y) (図の領域の左上からの画面の px) へパンする
async function moveTargetTo(page: Page, target: BarTarget, x: number, y: number): Promise<void> {
    const area = await areaBox(page);
    const box = await targetBox(page, target);
    await panBy(page, area.left + x - (box.left + box.right) / 2, area.top + y - (box.top + box.bottom) / 2);
    await expect
        .poll(async () => {
            const moved = await targetBox(page, target);
            return Math.abs((moved.left + moved.right) / 2 - (area.left + x)) < 0.5 && Math.abs((moved.top + moved.bottom) / 2 - (area.top + y)) < 0.5;
        }, `${JSON.stringify(target)} を (${x}, ${y}) へ`)
        .toBe(true);
}

// 相手の上の辺を図の領域の上の辺から top の所へ、左右の中心を x へパンする
async function moveTargetTopTo(page: Page, target: BarTarget, x: number, top: number): Promise<void> {
    const area = await areaBox(page);
    const box = await targetBox(page, target);
    await panBy(page, area.left + x - (box.left + box.right) / 2, area.top + top - box.top);
    await expect
        .poll(async () => {
            const moved = await targetBox(page, target);
            return Math.abs((moved.left + moved.right) / 2 - (area.left + x)) < 0.5 && Math.abs(moved.top - (area.top + top)) < 0.5;
        }, `${JSON.stringify(target)} の上の辺を ${top} へ`)
        .toBe(true);
}

type Side = 'left' | 'right' | 'center' | 'inside';

interface BarPlacement {
    // 見えている帯の data-for
    bars: Array<string | null>;
    // 相手の上 (間 gap) なら above、下なら below。どちらでもなければ測った値の文
    vertical: string;
    // 左右の置き場が決まりどおりなら true、違えば測った値の文
    horizontal: true | string;
}

// 帯の置き場を読む。side は、left: 帯の左の辺が道具箱の右の辺から 8px (ずらしすぎない)、right: 帯の右の辺が図の領域の右の辺から 8px 内側、
// center: 帯が相手の左右の中央 (ずらさない。1px まで)、inside: 帯が道具箱の右 8px から図の領域の右の端の 8px 手前までに収まる。どれも帯の全体がその間に収まることも見る
async function barPlacement(page: Page, target: BarTarget, side: Side, gap: number): Promise<BarPlacement> {
    const shown = await barsOf(page);
    const bar = shown[0];
    if (shown.length !== 1 || !bar) return { bars: shown.map((item) => item.for), vertical: '帯が 1 つでない', horizontal: '帯が 1 つでない' };
    const box = await targetBox(page, target);
    const area = await areaBox(page);
    const toolbox = await toolboxBox(page);
    const rect = bar.rect;
    const vertical =
        rect.bottom <= box.top - (gap - 0.5) && rect.bottom >= box.top - (gap + 1.5)
            ? 'above'
            : rect.top >= box.bottom + (gap - 0.5) && rect.top <= box.bottom + (gap + 1.5)
              ? 'below'
              : `帯 ${show(rect)}、相手 ${show(box)}`;
    const fromToolbox = rect.left - toolbox.right;
    const fromRight = area.right - rect.right;
    const offCenter = (rect.left + rect.right) / 2 - (box.left + box.right) / 2;
    const room = `帯の左の辺は道具箱の右の辺から ${round1(fromToolbox)}px、帯の右の辺は図の領域の右の辺から ${round1(fromRight)}px、相手の左右の中央からのずれ ${round1(offCenter)}px`;
    const inside = fromToolbox >= EDGE_ROOM_MIN && fromRight >= EDGE_ROOM_MIN;
    const ok =
        side === 'left'
            ? inside && fromToolbox <= EDGE_ROOM_MAX
            : side === 'right'
              ? inside && fromRight <= EDGE_ROOM_MAX
              : side === 'center'
                ? inside && Math.abs(offCenter) <= 1
                : inside;
    return { bars: [bar.for], vertical, horizontal: ok ? true : room };
}

async function expectBarPlaced(page: Page, target: BarTarget, kind: string, side: Side, vertical: 'above' | 'below', gap: number, message: string): Promise<void> {
    await expect.poll(() => barPlacement(page, target, side, gap), message).toEqual({ bars: [kind], vertical, horizontal: true });
}

// 道具箱の右の辺と図の領域の右の辺 (図の領域の左上からの画面の px)
async function edgesOf(page: Page): Promise<{ toolboxRight: number; areaWidth: number; areaHeight: number }> {
    const area = await areaBox(page);
    const toolbox = await toolboxBox(page);
    return { toolboxRight: toolbox.right - area.left, areaWidth: area.right - area.left, areaHeight: area.bottom - area.top };
}

// 相手を、図の領域の左の端 (中心を道具箱の右の辺から 30px)、右の端 (中心を図の領域の右の辺から 30px 内側)、真ん中 (道具箱の右から図の右の端の間の中ほど) に置いて、
// 帯の置き場を確かめる。どれも上下は図の領域の中ほど (帯は相手の上に入る)
async function expectBarAcross(page: Page, target: BarTarget, kind: string, gap: number, label: string): Promise<void> {
    const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
    await moveTargetTo(page, target, toolboxRight + 30, areaHeight / 2);
    await expectBarPlaced(page, target, kind, 'left', 'above', gap, `${label} (図の左の端)`);
    await moveTargetTo(page, target, areaWidth - 30, areaHeight / 2);
    await expectBarPlaced(page, target, kind, 'right', 'above', gap, `${label} (図の右の端)`);
    await moveTargetTo(page, target, (toolboxRight + areaWidth) / 2, areaHeight / 2);
    await expectBarPlaced(page, target, kind, 'center', 'above', gap, `${label} (真ん中)`);
}

test.describe('帯を図の領域に収める (G-022 / G-037。scope.md の「触る G-022 / G-037」、feedback-5 の Q2 の案 A)', () => {
    test('@editor 図の左の端のノード (ルートの「企画」) を選ぶと、帯の左の辺は道具箱の右の辺から 8px (ずらしすぎない)。帯は相手の上 (間 20px) のまま。上に入らず下に出るときも同じ', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        // ルートは今の全体表示で道具箱の下に入るので、真ん中へ動かしてから選ぶ
        await moveTargetTo(page, { node: PLAN }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, [PLAN]);
        await expect.poll(() => barKinds(page)).toEqual(['node']);

        await moveTargetTo(page, { node: PLAN }, toolboxRight + 30, areaHeight / 2);
        await expectBarPlaced(page, { node: PLAN }, 'node', 'left', 'above', BAR_GAP, '企画 (図の左の端)');
        // 上に入らない所 (箱の上の辺を図の領域の上の辺から 4px) では下に出て、左右は同じく道具箱の右 8px
        await moveTargetTopTo(page, { node: PLAN }, toolboxRight + 30, 4);
        await expectBarPlaced(page, { node: PLAN }, 'node', 'left', 'below', BAR_GAP, '企画 (図の左上の端)');
        expect(await getSource(page)).toBe(SIMPLE);
        expect(errors).toEqual([]);
    });

    test('@editor 図の右の端に近いノード (「単体テスト」) を選ぶと、帯の右の辺は図の領域の右の辺から 8px 内側 (ずらしすぎない)。帯は相手の上 (間 20px) のまま', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        await moveTargetTo(page, { node: UNIT_TEST }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, [UNIT_TEST]);
        await expect.poll(() => barKinds(page)).toEqual(['node']);

        await moveTargetTo(page, { node: UNIT_TEST }, areaWidth - 30, areaHeight / 2);
        await expectBarPlaced(page, { node: UNIT_TEST }, 'node', 'right', 'above', BAR_GAP, '単体テスト (図の右の端)');
        // 箱の右の辺を図の領域の右の辺に合わせても同じ
        const box = await nodeBox(page, UNIT_TEST);
        const area = await areaBox(page);
        await moveTargetTo(page, { node: UNIT_TEST }, areaWidth - (box.right - box.left) / 2, areaHeight / 2);
        expect(Math.abs((await nodeBox(page, UNIT_TEST)).right - area.right)).toBeLessThan(0.5);
        await expectBarPlaced(page, { node: UNIT_TEST }, 'node', 'right', 'above', BAR_GAP, '単体テスト (箱の右の辺が図の領域の右の辺)');
    });

    test('@editor 図の真ん中のノードでは、帯は今と同じく相手の左右の中央 (ずらさない)。左の端、右の端へ動かすと帯がずれ、真ん中に戻すと中央に戻る', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        await moveTargetTo(page, { node: DESIGN_S }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, [DESIGN_S]);
        await expectBarPlaced(page, { node: DESIGN_S }, 'node', 'center', 'above', BAR_GAP, '設計 (真ん中)');
        await expectBarAcross(page, { node: DESIGN_S }, 'node', BAR_GAP, '設計');
    });

    test('@editor 2 つ以上を選んだ帯も、図の左の端では道具箱の右 8px、右の端では図の領域の右の辺から 8px 内側に収まり、真ん中では全体の左右の中央。全体の上 (間 24px) のまま', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        await moveTargetTo(page, { nodes: [RESEARCH, BUILD_S] }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, [RESEARCH, BUILD_S]);
        await expect.poll(() => barKinds(page)).toEqual(['nodes']);
        await expectBarAcross(page, { nodes: [RESEARCH, BUILD_S] }, 'nodes', BAR_GAP_AROUND_BOUNDS, '調査と実装');
        expect(await getSource(page)).toBe(SIMPLE);
    });

    test('@editor グループの帯も、枠を図の左の端に置くと道具箱の右 8px、右の端に置くと図の領域の右の辺から 8px 内側に収まり、真ん中では枠の左右の中央。枠の上 (間 20px) のまま', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        for (const group of ['dev', 'test']) {
            await moveTargetTo(page, { group, frame: 0 }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
            await pressFrameLabel(page, group);
            await expectBarAcross(page, { group, frame: 0 }, 'group', BAR_GAP, `グループ ${group}`);
            // 選択を解く (次のグループの枠のラベルを押せるように)
            await page.keyboard.press('Escape');
            await expect.poll(() => barCount(page), `グループ ${group} の選択を解く`).toBe(0);
        }
        expect(await getSource(page)).toBe(SIMPLE);
    });

    test('@editor 葉の例の「基盤の作業」の下の枠のラベルを押すと、グループの帯はその枠の上に出て図の領域に収まる (開いた直後の表示位置のまま)。その枠を図の右の端に置くと、帯の右の辺は図の領域の右の辺から 8px 内側 (G-037)', async ({ page }) => {
        await open(page);
        await mount(page, LEAVES);
        await useSelectTool(page);
        const frames = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((element) => element.getBoundingClientRect().top), frameSelector('infra'));
        expect(frames, 'infra の枠').toHaveLength(2);
        // 下の枠 (上の辺がいちばん下の枠) と、そのラベル (ラベルは枠と同じ描いた順)
        const lower = frames.indexOf(Math.max(...frames));
        await pressFrameLabel(page, 'infra', lower);
        await expectBarPlaced(page, { group: 'infra', frame: lower }, 'group', 'inside', 'above', BAR_GAP, '下の枠 (開いた直後の表示位置)');

        const { areaWidth, areaHeight } = await edgesOf(page);
        await moveTargetTo(page, { group: 'infra', frame: lower }, areaWidth - 30, areaHeight / 2);
        await expectBarPlaced(page, { group: 'infra', frame: lower }, 'group', 'right', 'above', BAR_GAP, '下の枠 (図の右の端)');
        expect(await getSource(page)).toBe(LEAVES);
    });
});

// ---- 入力とパネルを開いている間の帯 ----

const nameInputCount = (page: Page): Promise<number> => visible(page, '#a .mdag-editor-name-input[data-for="node"]').count();
const groupNameInputCount = (page: Page): Promise<number> => visible(page, '#a .mdag-editor-name-input[data-for="group"]').count();
const detailsEditorCount = (page: Page): Promise<number> => visible(page, '#a .mdag-editor-details-editor').count();

async function panelKind(page: Page): Promise<string | null | 'none'> {
    const kinds = await page.evaluate(() =>
        [...document.querySelectorAll('#a .mdag-editor-tag-panel')].filter((element) => element.checkVisibility()).map((element) => element.getAttribute('data-panel')),
    );
    return kinds.length === 0 ? 'none' : kinds.length === 1 ? (kinds[0] ?? null) : `${kinds.length} 個`;
}

// テストのページの原文の欄 (アプリの入力欄の代わり)。図の右の空いた所に置き、図とは重ねない
async function addSourceField(page: Page): Promise<void> {
    await page.evaluate(() => {
        if (document.getElementById('source')) return;
        const field = document.createElement('textarea');
        field.id = 'source';
        field.style.cssText = 'position: fixed; top: 10px; left: 1020px; width: 240px; height: 120px;';
        document.body.append(field);
    });
}

// 入力の外 (図の外の原文の欄) を押してフォーカスを移す
async function pressOutside(page: Page): Promise<void> {
    await addSourceField(page);
    await page.locator('#source').click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? '')).toBe('source');
}

// 入力かパネルが開いていて、その間は帯が見えない (数コマ待ってからも見えない)
async function expectBarHiddenWhile(page: Page, isOpen: () => Promise<boolean>, message: string): Promise<void> {
    await expect.poll(isOpen, `${message}: 開いている`).toBe(true);
    await expect.poll(() => barCount(page), `${message}: 開いている間の帯`).toBe(0);
    await settle(page);
    expect(await barCount(page), `${message}: 開いている間の帯 (数コマあと)`).toBe(0);
    expect(await isOpen(), `${message}: 開いたまま`).toBe(true);
}

// 入力とパネルが閉じて、選んでいる相手の帯 (kind) が戻る。戻った帯は相手の上か下 (間はノードとグループ 20px、2 つ以上 24px) にあり、図の領域に収まる
async function expectBarBack(page: Page, isOpen: () => Promise<boolean>, kind: string, marked: number[], message: string): Promise<void> {
    await expect.poll(isOpen, `${message}: 閉じた`).toBe(false);
    await expect.poll(() => markedOf(page), `${message}: 選んだまま`).toEqual(marked);
    await expect.poll(() => barKinds(page), `${message}: 閉じたあとの帯`).toEqual([kind]);
    const target: BarTarget = marked.length === 1 && marked[0] !== undefined ? { node: marked[0] } : { nodes: marked };
    const gap = marked.length === 1 ? BAR_GAP : BAR_GAP_AROUND_BOUNDS;
    await expect
        .poll(async () => {
            const placement = await barPlacement(page, target, 'inside', gap);
            return { bars: placement.bars, beside: placement.vertical === 'above' || placement.vertical === 'below' ? true : placement.vertical, horizontal: placement.horizontal };
        }, `${message}: 閉じたあとの帯の置き場`)
        .toEqual({ bars: [kind], beside: true, horizontal: true });
}

test.describe('入力とパネルを開いている間は帯を隠す (G-026。scope.md の「触る G-026」、feedback-5 の Q5 の案 A)', () => {
    test('@editor 名前の入力 (Enter と帯の「名前」) を開いている間は帯が見えない。Esc でやめても、外を押して決めても、閉じたら帯が戻る (選んだまま)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNodes(page, [TASK_B]);
        await expect.poll(() => barKinds(page)).toEqual(['node']);
        const isOpen = async (): Promise<boolean> => (await nameInputCount(page)) === 1;

        await page.keyboard.press('Enter');
        await expectBarHiddenWhile(page, isOpen, 'Enter の名前の入力');
        await page.keyboard.press('Escape');
        await expectBarBack(page, isOpen, 'node', [TASK_B], 'Esc でやめる');

        await pressBar(page, 'rename');
        await expectBarHiddenWhile(page, isOpen, '帯の「名前」の名前の入力');
        await page.keyboard.press('Escape');
        await expectBarBack(page, isOpen, 'node', [TASK_B], '帯の「名前」のあとの Esc');

        await pressNode(page, TASK_B);
        await page.keyboard.press('Enter');
        await expectBarHiddenWhile(page, isOpen, '外を押す前の名前の入力');
        await page.keyboard.type('Task Z');
        await pressOutside(page);
        await expect.poll(() => getSource(page), '外を押して決める').toBe(DOC.replace('- Task B', '- Task Z'));
        await expectBarBack(page, isOpen, 'node', [TASK_B], '外を押して決める');
        expect(errors).toEqual([]);
    });

    test('@editor タグのパネル (T のタグ追加、帯のタグ選択、道具箱のタグ追加) を開いている間は帯が見えない。Esc で閉じると帯が戻る。2 つ以上を選んだときも同じ', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const routes = [
            ['T', 'add'],
            ['帯のタグ選択', 'select'],
            ['道具箱のタグ追加', 'add'],
        ] as const;
        for (const ids of [[TASK_A], [TASK_A, TASK_B]]) {
            const kind = ids.length === 1 ? 'node' : 'nodes';
            for (const [route, panel] of routes) {
                const message = `${route} (${ids.map((id) => REF_TEXTS[id]).join('、')})`;
                await selectNodes(page, ids, message);
                await expect.poll(() => barKinds(page), message).toEqual([kind]);
                if (route === 'T') await page.keyboard.press('t');
                else if (route === '帯のタグ選択') await pressBar(page, 'tag-select');
                else await toolButton(page, 'tag-add').click();
                const isOpen = async (): Promise<boolean> => (await panelKind(page)) === panel;
                await expectBarHiddenWhile(page, isOpen, message);
                await page.keyboard.press('Escape');
                await expectBarBack(page, async () => (await panelKind(page)) !== 'none', kind, ids, message);
            }
        }
        expect(await getSource(page)).toBe(DOC);
    });

    test('@editor タグのパネルでタグを付けて図が描き直されても、パネルを開いている間は帯が見えないまま。Esc で閉じると帯が戻る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNodes(page, [TASK_A]);
        await page.keyboard.press('t');
        const isOpen = async (): Promise<boolean> => (await panelKind(page)) === 'add';
        await expectBarHiddenWhile(page, isOpen, 'タグ追加のパネル');
        // キーの欄にフォーカスがあるので、キーを打って Enter で付ける (パネルは開いたまま)
        await page.keyboard.type('owner');
        await page.keyboard.press('Enter');
        await expect.poll(() => getSource(page), '#owner を付ける').toBe(DOC.replace('- Task A', '- Task A #owner'));
        await expectBarHiddenWhile(page, isOpen, '#owner を付けたあと');
        await page.keyboard.press('Escape');
        await expectBarBack(page, async () => (await panelKind(page)) !== 'none', 'node', [TASK_A], 'Esc で閉じる');
    });

    test('@editor 詳細の入力 (D) を開いている間は帯が見えない。Esc でやめても、⌘Enter / Ctrl+Enter で保存しても、外を押して保存しても、閉じたら帯が戻る (選んだまま)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNodes(page, [TASK_A]);
        await expect.poll(() => barKinds(page)).toEqual(['node']);
        const isOpen = async (): Promise<boolean> => (await detailsEditorCount(page)) === 1;

        await page.keyboard.press('d');
        await expectBarHiddenWhile(page, isOpen, 'D の詳細の入力');
        await page.keyboard.press('Escape');
        await expectBarBack(page, isOpen, 'node', [TASK_A], 'Esc でやめる');
        expect(await getSource(page)).toBe(DOC);

        await pressNode(page, TASK_A);
        await page.keyboard.press('d');
        await expectBarHiddenWhile(page, isOpen, '⌘Enter の前の詳細の入力');
        await page.keyboard.type('メモ');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expect.poll(() => getSource(page), '⌘Enter で保存').toBe(DOC.replace('- Task A', '- Task A\n    > メモ'));
        await expectBarBack(page, isOpen, 'node', [TASK_A], '⌘Enter で保存');

        await pressNode(page, TASK_A);
        await page.keyboard.press('d');
        await expectBarHiddenWhile(page, isOpen, '外を押す前の詳細の入力');
        await page.keyboard.press('ControlOrMeta+KeyA');
        await page.keyboard.type('メモ 2');
        await pressOutside(page);
        await expect.poll(() => getSource(page), '外を押して保存').toBe(DOC.replace('- Task A', '- Task A\n    > メモ 2'));
        await expectBarBack(page, isOpen, 'node', [TASK_A], '外を押して保存');
        expect(errors).toEqual([]);
    });

    test('@editor グループの名前の入力を開いている間も帯は出ていない (今のまま)。Esc で閉じるとグループの帯が戻る', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE);
        await zoomToOne(page);
        await useSelectTool(page);
        await pressFrameLabel(page, 'dev');
        const isOpen = async (): Promise<boolean> => (await groupNameInputCount(page)) === 1;
        await page.keyboard.press('Enter');
        await expectBarHiddenWhile(page, isOpen, 'グループの名前の入力');
        await page.keyboard.press('Escape');
        await expect.poll(isOpen, '閉じた').toBe(false);
        await expect.poll(() => barKinds(page), '閉じたあとの帯').toEqual(['group']);
        expect(await getSource(page)).toBe(SIMPLE);
    });
});

// ---- 全体表示 ----

interface FitFacts {
    transform: ViewTransform;
    // 道具箱かセグメントに重なる図の中身 (ノードの箱、枠、枠のラベル)
    covered: string[];
    // 図の領域からはみ出す図の中身
    outside: string[];
    // 図の中身の全体が、道具箱の右から図の右の端までの幅の 8 割以上か、図の領域の高さの 8 割以上か、倍率が上限 (2) か (小さくしすぎていない)
    filled: true | string;
}

async function fitFacts(page: Page): Promise<FitFacts> {
    const facts = await page.evaluate(() => {
        const container = document.getElementById('a');
        const editor = (window as unknown as EditorWindow).editors.a;
        if (!container || !editor) throw new Error('#a の図がない');
        const box = (element: Element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        const shown = (selector: string) => [...container.querySelectorAll(selector)].filter((element) => element.checkVisibility());
        const items = [
            ...shown('.mdag-node').map((node) => ({ name: `ノード「${(node.querySelector('.mdag-content')?.textContent ?? '').trim()}」`, rect: box(node.querySelector('.mdag-box') ?? node) })),
            ...shown('.mdag-frame').map((frame) => ({ name: `枠 ${frame.getAttribute('data-group') ?? ''}`, rect: box(frame) })),
            ...shown('.mdag-frame-label').map((label) => ({ name: `枠のラベル「${(label.textContent ?? '').trim()}」`, rect: box(label) })),
        ];
        const blockers = [...shown('.mdag-editor-toolbox').map((element) => ({ name: '道具箱', rect: box(element) })), ...shown('.mdag-editor-segment').map((element) => ({ name: 'セグメント', rect: box(element) }))];
        return { transform: editor.view.getTransform(), area: box(container), items, blockers, toolboxCount: shown('.mdag-editor-toolbox').length };
    });
    if (facts.toolboxCount !== 1) throw new Error(`道具箱が 1 つでない (${facts.toolboxCount})`);
    const covered: string[] = [];
    for (const item of facts.items) for (const blocker of facts.blockers) if (overlaps(item.rect, blocker.rect)) covered.push(`${item.name} (${blocker.name})`);
    const area = facts.area;
    const outside = facts.items
        .filter((item) => item.rect.left < area.left - 1 || item.rect.top < area.top - 1 || item.rect.right > area.right + 1 || item.rect.bottom > area.bottom + 1)
        .map((item) => item.name);
    const content = union(facts.items.map((item) => item.rect));
    const toolbox = facts.blockers.find((blocker) => blocker.name === '道具箱')?.rect;
    const room = area.right - (toolbox?.right ?? area.left);
    const widthRatio = (content.right - content.left) / room;
    const heightRatio = (content.bottom - content.top) / (area.bottom - area.top);
    const filled =
        widthRatio >= 0.8 || heightRatio >= 0.8 || facts.transform.k >= 2 - 1e-3
            ? true
            : `幅は道具箱の右からの ${round1(widthRatio * 100)}%、高さは図の領域の ${round1(heightRatio * 100)}%、倍率 ${facts.transform.k.toFixed(3)}`;
    return { transform: facts.transform, covered, outside, filled };
}

// 全体表示が落ち着くまで待ってから (表示位置が 2 回続けて同じ)、道具箱とセグメントに重ならず、図の領域に収まることを見る
async function expectFitAvoiding(page: Page, message: string): Promise<ViewTransform> {
    let last: ViewTransform | null = null;
    await expect
        .poll(async () => {
            const now = await transformOf(page);
            const stable = last !== null && sameTransform(last, now);
            last = now;
            return stable;
        }, `${message}: 表示位置が落ち着く`)
        .toBe(true);
    await settle(page);
    const facts = await fitFacts(page);
    expect({ covered: facts.covered, outside: facts.outside, filled: facts.filled }, `${message} (${fmt(facts.transform)})`).toEqual({ covered: [], outside: [], filled: true });
    return facts.transform;
}

// 全体が収まる表示位置から外す (パンと拡大)
async function disturb(page: Page): Promise<void> {
    const before = await transformOf(page);
    await page.evaluate(() => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        if (!view) throw new Error('図がない');
        view.panBy(-180, 90);
        view.zoomBy(1.6, { x: 300, y: 200 });
    });
    await expect.poll(async () => sameTransform(await transformOf(page), before)).toBe(false);
}

// 図の側の全体表示 (view.fit) と同じ式で、今の中身と図の領域から求めた表示位置 (倍率は上限 2、幅の 94%、高さの 92% に収め、中ほどに置く)
async function viewFitTransform(page: Page): Promise<ViewTransform> {
    const transform = await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        const view = target.editors.a?.view ?? target.diagram?.view;
        const viewport = document.querySelector('#a > .mdag-viewport');
        const bounds = view?.contentBounds();
        if (!view || !viewport || !bounds) return null;
        const { clientWidth, clientHeight } = viewport;
        const k = Math.min(2, (clientWidth * 0.94) / Math.max(bounds.width, 1), (clientHeight * 0.92) / Math.max(bounds.height, 1));
        return { k, x: (clientWidth - bounds.width * k) / 2 - bounds.x * k, y: (clientHeight - bounds.height * k) / 2 - bounds.y * k };
    });
    if (!transform) throw new Error('#a の図の中身がない');
    return transform;
}

test.describe('全体表示は道具箱とセグメントを避ける (G-030 / G-035。scope.md の「触る G-030 / G-035」、feedback-5 の Q1)', () => {
    test('@editor GUI 編集で開いた直後の全体表示では、どのノードの箱、枠、枠のラベルも道具箱とセグメントに重ならず、図の領域に収まる (小さな例と、直す 2 の文書の形)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, SIMPLE);
        await expect(visible(page, '#a .mdag-editor-segment'), '小さな例はセグメントを出す').toHaveCount(1);
        await expectFitAvoiding(page, '小さな例 (開いた直後)');

        await remount(page, DOC3);
        await expect(visible(page, '#a .mdag-editor-segment'), '直す 2 の文書の形はセグメントを出さない').toHaveCount(0);
        await expectFitAvoiding(page, '直す 2 の文書の形 (開いた直後)');
        expect(errors).toEqual([]);
    });

    test('@editor 道具箱の「ズームリセット」を押すと、開いた直後と同じ全体表示に戻り、どのノードの箱、枠、枠のラベルも道具箱とセグメントに重ならず、図の領域に収まる', async ({ page }) => {
        await open(page);
        for (const [name, markdown] of [
            ['小さな例', SIMPLE],
            ['直す 2 の文書の形', DOC3],
        ] as const) {
            await remount(page, markdown);
            const opened = await expectFitAvoiding(page, `${name} (開いた直後)`);
            await disturb(page);
            await toolButton(page, 'fit').click();
            await expect.poll(async () => sameTransform(await transformOf(page), opened), `${name} (ズームリセット)`).toBe(true);
            await expectFitAvoiding(page, `${name} (ズームリセット)`);
            expect(await getSource(page)).toBe(markdown);
        }
    });

    test('@editor 閲覧で始まる文書をセグメントで GUI 編集に切り替えると、見る人が図を動かしていなければ GUI 編集の全体表示 (道具箱とセグメントを避ける。ズームリセットと同じ) にし直す。閲覧でパンかズームしてからなら、変換 (倍率と位置) は切り替える前のまま。GUI 編集から閲覧へ切り替えても変換は変わらない', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        const switchTo = async (mode: 'view' | 'edit'): Promise<void> => {
            await press(page, await spot(page, { on: 'element', selector: `#a .mdag-editor-segment [data-mode="${mode}"]` }));
            await expect(page.locator('#a')).toHaveAttribute('data-editor-mode', mode);
            await settle(page);
        };
        // 見る人が図を動かす: 何もないところからのドラッグ (閲覧は主ボタンでパンする) か、ホイール
        const moves = {
            パン: async (): Promise<void> => {
                const from = await spot(page, { on: 'blank' });
                await page.mouse.move(from.x, from.y);
                await page.mouse.down();
                await page.mouse.move(from.x + 30, from.y + 20, { steps: 3 });
                await page.mouse.move(from.x + 60, from.y + 40, { steps: 3 });
                await page.mouse.up();
            },
            ズーム: async (): Promise<void> => {
                const blank = await spot(page, { on: 'blank' });
                await page.mouse.move(blank.x, blank.y);
                await page.mouse.wheel(0, -200);
            },
        };

        // (2) 閲覧で動かしてから GUI 編集へ: 変換は切り替える前のまま。(3) 閲覧へ戻しても同じ
        for (const [name, move] of Object.entries(moves)) {
            await remount(page, SIMPLE_VIEW_FIRST);
            await expect(page.locator('#a'), name).toHaveAttribute('data-editor-mode', 'view');
            const opened = await transformOf(page);
            await move();
            await expect.poll(async () => sameTransform(await transformOf(page), opened), `${name}で動く`).toBe(false);
            await settle(page);
            const moved = await transformOf(page);
            await switchTo('edit');
            const edited = await transformOf(page);
            expect(sameTransform(edited, moved), `${name}のあとに GUI 編集へ: ${fmt(edited)} / 切り替える前 ${fmt(moved)}`).toBe(true);
            await switchTo('view');
            const viewed = await transformOf(page);
            expect(sameTransform(viewed, moved), `${name}のあとに閲覧へ戻す: ${fmt(viewed)} / 切り替える前 ${fmt(moved)}`).toBe(true);
        }

        // (1) 開いた直後の全体表示のまま GUI 編集へ: GUI 編集の全体表示にし直す
        await remount(page, SIMPLE_VIEW_FIRST);
        await expect(page.locator('#a')).toHaveAttribute('data-editor-mode', 'view');
        const opened = await transformOf(page);
        const viewFit = await viewFitTransform(page);
        expect(sameTransform(opened, viewFit), `閲覧で開いた直後は図の領域の全体の全体表示: ${fmt(opened)} / 今の式 ${fmt(viewFit)}`).toBe(true);
        await switchTo('edit');
        const refitted = await expectFitAvoiding(page, '動かさずに GUI 編集へ');
        await disturb(page);
        await toolButton(page, 'fit').click();
        await expect.poll(async () => sameTransform(await transformOf(page), refitted), 'ズームリセットと同じ全体表示').toBe(true);
        // (3) GUI 編集から閲覧へ切り替えても変換は変わらない (全体表示し直さない)
        await switchTo('view');
        const back = await transformOf(page);
        expect(sameTransform(back, refitted), `閲覧へ戻す: ${fmt(back)} / GUI 編集の全体表示 ${fmt(refitted)}`).toBe(true);
        expect(await getSource(page)).toBe(SIMPLE_VIEW_FIRST);
        expect(errors).toEqual([]);
    });

    test('@editor 閲覧の全体表示は今のまま: render の閲覧の図と、mountEditor を閲覧のモードで開いた図は、図の領域の全体に収める今の式の表示位置 (倍率と位置)', async ({ page }) => {
        await open(page);
        await renderView(page, SIMPLE);
        const rendered = await transformOf(page);
        const renderedWant = await viewFitTransform(page);
        expect(sameTransform(rendered, renderedWant), `render の閲覧の図: ${fmt(rendered)} / 今の式 ${fmt(renderedWant)}`).toBe(true);

        await remount(page, SIMPLE, 'view');
        await expect(visible(page, '#a .mdag-editor-toolbox'), '閲覧のモードでは道具箱を出さない').toHaveCount(0);
        const viewed = await transformOf(page);
        const viewedWant = await viewFitTransform(page);
        expect(sameTransform(viewed, viewedWant), `mountEditor の閲覧: ${fmt(viewed)} / 今の式 ${fmt(viewedWant)}`).toBe(true);
        // 同じ文書と図の領域なので、render の図と同じ表示位置
        expect(sameTransform(viewed, rendered), `mountEditor の閲覧 ${fmt(viewed)} / render ${fmt(rendered)}`).toBe(true);
    });
});

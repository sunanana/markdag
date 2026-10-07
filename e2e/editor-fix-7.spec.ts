// GUI 編集で依頼者が図を触って出した指摘のうち、名前の入力などを開いている間に線を引く点が出ることと、
// 図の領域が狭いと帯が右の端からはみ出すことを、ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 名前の入力、詳細の入力、タグのパネルを開いている間は、帯と子の +、兄弟の + と同じく線を引く点も隠し、閉じたら戻す。
// 帯が道具箱の右から図の右の端までに入らないときは右の端を優先し (帯の右の辺を図の領域の右の端の 8px 手前に置き、左は道具箱の下に入る。
// 隠れたボタンは押せない)、入るときは今のまま。再現の手順は、窓の幅 800 (図の領域 475px) で葉の見本の「DB の移行」を選ぶ。
// 見た目そのもの (色、余白、形) は見ない。
// 線を引く点が見えないとは、.mdag-editor-handle[data-handle="link"] のうち見えている (checkVisibility) ものがないか、その中の丸の矩形の幅が 0 のこと
// (点をずらすテストと同じ読み方。visibility: hidden だけでは見えているとみなす)。見えない間は、開く前の丸の中心で線を引く点が反応しないことも見る。
// 2 つ以上を選んだときの合流させる点 (data-handle="join") も同じ決まりで隠す (入力やパネルを開いている間はつまみと点を全部隠す)。
// 合流させる点が見えないとは、見えている (checkVisibility) 要素がないか、その矩形の幅か高さが 0 のこと。
// 帯の置き場は、帯、道具箱、図の領域 (#a) の矩形 (getBoundingClientRect) で読む。e2e の土台の図の領域は幅 1000px に決まっているので、
// 狭い図の領域は、開く前に #a の幅を替えて作る (窓を狭くしたときと同じく、図の領域が狭くなる)。
// 反映は expect.poll で待ち、「出ない」は描画の数コマと 200ms を待ってからも見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, NodeTarget } from '../src/core';
import type { EditorOptions, EditorSelection, MarkdagEditor } from '../src/editor';

type HandleKind = 'child' | 'sibling' | 'link';

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

interface Circle {
    cx: number;
    cy: number;
    r: number;
}

interface HandleScene {
    k: number;
    box: Box;
    // 選択の枠の線の内側と外側の、箱の辺からの距離 (画面の px)
    frame: { inner: number; outer: number };
    // 見えている丸 (画面の座標)。見えていないつまみと点は入れない
    circles: Partial<Record<HandleKind, Circle>>;
}

// ページの中に置く測りの道具
interface Probe {
    scene(id: number): HandleScene;
    // 見えている線を引く点の丸 (どのノードのものでも)。なければ null
    anyLink(): Circle | null;
    // 点 (x, y) で線を引く点が反応するか
    linkAt(x: number, y: number): boolean;
    // 点 (x, y) で合流させる点が反応するか
    joinAt(x: number, y: number): boolean;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    fix7Probe: Probe;
};

const DIST = resolve('dist');

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

// ---- 文書 ----

// 入力とパネルの文書 (GUI 編集だけ。editor-fix-4 と同じ)。ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。
// どのノードも 1 行 (箱の高さは倍率 1 で 20px)。子のあるノード (Root、Design、Build) には開閉の丸がある
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const DOC = ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '---', '', ...BODY].join('\n');
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;
const LABELS: Record<number, string> = { 2: 'Design', 3: 'Task A', 4: 'Task B', 6: 'Leaf' };

// 足したノードの仮の名前
const NEW = '新しいノード';

// 確認ページの小さな見本と同じ文書 (帯の置き場のテストと同じ)。左上にセグメント。
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
const PLAN = 1;
const RESEARCH = 2;
const DESIGN_S = 5;
const BUILD_S = 8;
const UNIT_TEST = 12;

// 確認ページの葉の見本と同じ groups と本文。editor だけを GUI 編集に替えた (帯の置き場のテストと同じ)
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

// ---- 共通 ----

function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return errors;
}

// ページの中に測りの道具を置く (外の値を使わない)
function installProbe(): void {
    const KINDS: readonly HandleKind[] = ['child', 'sibling', 'link'];
    const container = document.getElementById('a');
    if (!container) throw new Error('#a がない');
    const target = window as unknown as EditorWindow;

    // SVG の図形の矩形 (getBoundingClientRect) に線の太さを含めるブラウザ (firefox) か。線のある丸で確かめる
    const strokeInBounds = ((): boolean => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '40');
        svg.setAttribute('height', '40');
        svg.style.cssText = 'position: fixed; left: 0; top: 0;';
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '20');
        circle.setAttribute('cy', '20');
        circle.setAttribute('r', '10');
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'black');
        circle.setAttribute('stroke-width', '4');
        svg.append(circle);
        document.body.append(svg);
        const width = circle.getBoundingClientRect().width;
        svg.remove();
        return width > 22;
    })();

    // 要素の中の最初の SVG の circle。半径は線の外側まで (画面の px)。矩形の幅が 0 なら見えていない
    const circleOf = (root: Element): Circle | null => {
        const circle = root.querySelector('circle');
        if (!circle) return null;
        const bounds = circle.getBoundingClientRect();
        if (bounds.width === 0) return null;
        const style = getComputedStyle(circle);
        const stroke = style.stroke === 'none' ? 0 : parseFloat(style.strokeWidth) || 0;
        const radius = circle.r.baseVal.value;
        const scale = bounds.width / (2 * radius + (strokeInBounds ? stroke : 0));
        return { cx: bounds.left + bounds.width / 2, cy: bounds.top + bounds.height / 2, r: (radius + stroke / 2) * scale };
    };

    // 見えているつまみ (editor-fix-4 と同じく、checkVisibility が true の最初の要素) の丸
    const handleCircle = (kind: HandleKind): Circle | null => {
        const handle = [...container.querySelectorAll(`.mdag-editor-handle[data-handle="${kind}"]`)].find((element) => element.checkVisibility());
        return handle ? circleOf(handle) : null;
    };

    const scene = (id: number): HandleScene => {
        const box = container.querySelector<HTMLElement>(`.mdag-node[data-id="${id}"] .mdag-box`);
        const view = target.editors.a?.view;
        if (!box || !view) throw new Error(`ノード ${id} の箱か図がない`);
        const rect = box.getBoundingClientRect();
        const k = view.getTransform().k;
        const style = getComputedStyle(box);
        const offset = parseFloat(style.outlineOffset) || 0;
        const width = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0;
        const circles: Partial<Record<HandleKind, Circle>> = {};
        for (const kind of KINDS) {
            const circle = handleCircle(kind);
            if (circle) circles[kind] = circle;
        }
        return { k, box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, frame: { inner: offset * k, outer: (offset + width) * k }, circles };
    };

    // 点 (x, y) で読む要素。elementFromPoint が渡した点から右下の 1px の四角に掛かる要素を返すブラウザ (chromium、webkit) では、
    // 点を中心にした四角になるよう 0.5px 戻す (editor-fix-4 と同じ)
    const offset = ((): number => {
        const sample = document.createElement('div');
        sample.style.cssText = 'position: fixed; left: 10.5px; top: 10.5px; width: 4px; height: 4px; z-index: 2147483647;';
        document.body.append(sample);
        const square = document.elementFromPoint(9.75, 12) === sample;
        sample.remove();
        return square ? 0.5 : 0;
    })();

    const handleAt = (kind: 'link' | 'join', x: number, y: number): boolean => {
        const handle = document.elementFromPoint(x - offset, y - offset)?.closest(`.mdag-editor-handle[data-handle="${kind}"]`);
        return Boolean(handle) && container.contains(handle ?? null);
    };

    target.fix7Probe = { scene, anyLink: () => handleCircle('link'), linkAt: (x, y) => handleAt('link', x, y), joinAt: (x, y) => handleAt('join', x, y) };
}

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        (window as unknown as EditorWindow).editors = {};
    });
}

// GUI 編集で開く。width を渡すと、開く前に図の領域 (#a) の幅をその px にする
async function mount(page: Page, markdown: string, width?: number): Promise<void> {
    await page.evaluate(
        ({ markdown, width }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            if (width !== null) container.style.width = `${width}px`;
            const options: EditorOptions = { animate: false };
            target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, width: width ?? null },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
    await page.evaluate(installProbe);
}

// 「出ない」「変わらない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());
const getSelection = (page: Page): Promise<EditorSelection | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection());

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const handleSelector = (kind: HandleKind): string => `#a .mdag-editor-handle[data-handle="${kind}"]`;
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

const round1 = (value: number): number => Math.round(value * 10) / 10;
const show = (box: Box): string => `(${round1(box.left)}, ${round1(box.top)})-(${round1(box.right)}, ${round1(box.bottom)})`;

// 確かめた結果。よければ true、だめなら測った値の文 (失敗の差分に値が出るように)
const verdict = (ok: boolean, detail: string): true | string => (ok ? true : detail);

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
const markedIds = (page: Page): Promise<number[]> =>
    page.evaluate(() =>
        [...document.querySelectorAll('#a .mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b),
    );

// 図を、画面の上の距離で動かす
const panBy = (page: Page, dx: number, dy: number): Promise<void> => page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });

const transformK = (page: Page): Promise<number | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getTransform().k);

// 図の倍率を zoom にする (図の領域の中心のまわりで)
async function zoomTo(page: Page, zoom: number): Promise<void> {
    await page.evaluate((k) => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        const container = document.getElementById('a');
        if (!view || !container) throw new Error('#a の図がない');
        view.zoomBy(k / view.getTransform().k, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
    }, zoom);
    await expect.poll(() => transformK(page)).toBeCloseTo(zoom, 3);
    await settle(page);
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

// ---- 入力とパネルを開いている間の線を引く点 ----

// ポインタを図の外へ逃がす所 (図の領域 #a は 1000×600)
const AWAY: Point = { x: 1200, y: 700 };

// 線を引く点の丸と子の + か兄弟の + の丸の間 (縁から縁)。2px 以上になるまでずらす。測りの丸めの分 0.1px の余裕を見る。
// ずらしたときは必要な分だけ (間が max まで、ずらす量が要る量から over まで)。editor-fix-4 と同じ
const LINK_GAP = { goal: 2, min: 1.9, max: 3, over: 1 };
const DIAGONAL_SLACK = 0.5;
const CORNER_SLACK = 1;
const DECIDE_BAND = 0.1;
// 線を引く点が開く前と同じ所にあるとみなす差 (箱の右下の角からの位置の差。横と縦それぞれ)
const SAME_PLACE = 1;

const sceneOf = (page: Page, id: number): Promise<HandleScene> => page.evaluate((id) => (window as unknown as EditorWindow).fix7Probe.scene(id), id);
const anyLink = (page: Page): Promise<Circle | null> => page.evaluate(() => (window as unknown as EditorWindow).fix7Probe.anyLink());
const linkAt = (page: Page, point: Point): Promise<boolean> => page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix7Probe.linkAt(x, y), point);

interface LinkRead {
    k: number;
    // 丸の中心の、選んだノードの箱の右下の角からの位置 (画面の px)
    dx: number;
    dy: number;
    // 丸の中心 (画面の座標)
    center: Point;
}

// 線を引く点の丸の、ノード id の箱の右下の角からの位置と図の倍率。点が見えていなければ null
async function linkRead(page: Page, id: number): Promise<LinkRead | null> {
    const scene = await sceneOf(page, id);
    const link = scene.circles.link;
    return link ? { k: scene.k, dx: link.cx - scene.box.right, dy: link.cy - scene.box.bottom, center: { x: link.cx, y: link.cy } } : null;
}

function samePlace(before: LinkRead, now: LinkRead | null): true | string {
    if (now === null) return '線を引く点が出ていない';
    return verdict(
        Math.abs(now.dx - before.dx) <= SAME_PLACE && Math.abs(now.dy - before.dy) <= SAME_PLACE && Math.abs(now.k - before.k) < 1e-6,
        `箱の右下の角からの位置 (${round1(now.dx)}, ${round1(now.dy)})px (開く前は (${round1(before.dx)}, ${round1(before.dy)})px、k ${now.k})`,
    );
}

const gapBetween = (a: Circle, b: Circle): number => Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;

// 線を引く点の置き場が縮小のときの決まりどおりか (点をずらすテストの placementVerdict と同じ): 角に置いて子の + と兄弟の + との間が 2px 以上なら
// 選択の枠の右下の角のまま、2px 未満なら右下 45° へ間が 2px 以上になるまで (ずらしすぎない)。点か + が見えていなければその文
async function placementCheck(page: Page, id: number): Promise<true | string> {
    const { box, frame, circles, k } = await sceneOf(page, id);
    const link = circles.link;
    const pluses = [circles.child, circles.sibling].filter((circle): circle is Circle => circle !== undefined);
    if (!link) return '線を引く点が出ていない';
    if (pluses.length === 0) return '+ が出ていない';
    const middle = (frame.inner + frame.outer) / 2;
    const corner = { x: box.right + middle, y: box.bottom + middle };
    const gapAt = (cx: number, cy: number): number => Math.min(...pluses.map((plus) => gapBetween(plus, { cx, cy, r: link.r })));
    let needed = Infinity;
    for (let t = 0; t <= 100; t += 0.05) {
        if (gapAt(corner.x + t, corner.y + t) >= LINK_GAP.goal) {
            needed = t;
            break;
        }
    }
    const dx = link.cx - corner.x;
    const dy = link.cy - corner.y;
    const cornerGap = gapAt(corner.x, corner.y);
    const gap = gapAt(link.cx, link.cy);
    const within = (value: number): boolean => value >= frame.inner - CORNER_SLACK && value <= frame.outer + CORNER_SLACK;
    const atCorner = within(link.cx - box.right) && within(link.cy - box.bottom);
    const t = (dx + dy) / 2;
    const shifted = Math.abs(dx - dy) <= DIAGONAL_SLACK && t > 0 && t <= needed + LINK_GAP.over && gap <= LINK_GAP.max;
    const place = cornerGap >= LINK_GAP.goal + DECIDE_BAND ? atCorner : cornerGap < LINK_GAP.goal - DECIDE_BAND ? shifted : atCorner || shifted;
    return verdict(
        place && gap >= LINK_GAP.min,
        `k ${round1(k * 1000) / 1000}、角に置いたときの間 ${round1(cornerGap)}px、今の間 ${round1(gap)}px、角からのずれ dx ${round1(dx)}px dy ${round1(dy)}px、要るずらす量 ${round1(needed)}px`,
    );
}

// 選んだノードの + と点が出るまで待つ (ここで使うノードはどれもルートでない)
async function expectHandles(page: Page, message?: string): Promise<void> {
    await expect(visible(page, handleSelector('child')), message).toHaveCount(1);
    await expect(visible(page, handleSelector('sibling')), message).toHaveCount(1);
    await expect(visible(page, handleSelector('link')), message).toHaveCount(1);
}

// つまみと点の置き場が落ち着く (続けて 2 回読んで同じ) まで待つ
async function waitStill(page: Page, id: number): Promise<void> {
    const key = async (): Promise<string> => {
        const scene = await sceneOf(page, id);
        return JSON.stringify([scene.box, scene.circles], (_, value: unknown) => (typeof value === 'number' ? Math.round(value * 10) / 10 : value));
    };
    let last = await key();
    for (let round = 0; round < 30; round += 1) {
        await page.waitForTimeout(80);
        const now = await key();
        if (now === last) return;
        last = now;
    }
    throw new Error(`ノード ${id} のつまみと点が落ち着かない`);
}

// 選択の道具でノード id を選び (選んでいなければ)、ノードを図の領域の中心に置いて倍率を zoom にし、ポインタを図の外へ逃がす
async function prepare(page: Page, id: number, zoom: number, message?: string): Promise<void> {
    await expect(visible(page, '#a .mdag-editor-name-input'), message).toHaveCount(0);
    const marked = await markedIds(page);
    if (marked.length !== 1 || marked[0] !== id) {
        await pressNode(page, id);
        await expect.poll(() => markedIds(page), message).toEqual([id]);
    }
    await expectHandles(page, message);
    const [area] = await rectsOf(page, '#a');
    if (!area) throw new Error('#a がない');
    const box = await nodeBox(page, id);
    await panBy(page, (area.left + area.right) / 2 - (box.left + box.right) / 2, (area.top + area.bottom) / 2 - (box.top + box.bottom) / 2);
    await zoomTo(page, zoom);
    await page.mouse.move(AWAY.x, AWAY.y);
    await settle(page);
    await waitStill(page, id);
}

// 見えている操作の帯の数 (editor-fix-6 と同じ読み方)
const barCount = (page: Page): Promise<number> => page.evaluate(() => [...document.querySelectorAll('#a .mdag-editor-bar')].filter((bar) => bar.checkVisibility()).length);

// 開いている間: 線を引く点が見えず、開く前の丸の中心で反応しない。帯と子の +、兄弟の + も見えない (今のまま)。数コマあとも同じで、開いたまま
async function expectLinkHiddenWhile(page: Page, before: Point, isOpen: () => Promise<boolean>, message: string): Promise<void> {
    await expect.poll(isOpen, `${message}: 開いている`).toBe(true);
    await expect.poll(() => anyLink(page), `${message}: 開いている間の線を引く点`).toBeNull();
    await settle(page);
    expect(await anyLink(page), `${message}: 開いている間の線を引く点 (数コマあと)`).toBeNull();
    expect(await linkAt(page, before), `${message}: 開く前の丸の中心で線を引く点が反応しない`).toBe(false);
    expect(
        {
            child: await visible(page, handleSelector('child')).count(),
            sibling: await visible(page, handleSelector('sibling')).count(),
            bar: await barCount(page),
        },
        `${message}: 開いている間の子の +、兄弟の +、帯`,
    ).toEqual({ child: 0, sibling: 0, bar: 0 });
    expect(await isOpen(), `${message}: 開いたまま`).toBe(true);
}

// 閉じたあと: 選んだまま、線を引く点と子の +、兄弟の +、帯が戻る。線を引く点の置き場は、before を渡せば開く前と同じ (1px 以内)、
// 渡さなければ縮小のときの決まりどおり
async function expectLinkBack(page: Page, id: number, isOpen: () => Promise<boolean>, before: LinkRead | null, message: string): Promise<void> {
    await expect.poll(isOpen, `${message}: 閉じた`).toBe(false);
    await expect.poll(() => markedIds(page), `${message}: 選んだまま`).toEqual([id]);
    await page.mouse.move(AWAY.x, AWAY.y);
    await settle(page);
    if (before) await expect.poll(async () => samePlace(before, await linkRead(page, id)), `${message}: 閉じたあとの線を引く点`).toBe(true);
    else await expect.poll(() => placementCheck(page, id), `${message}: 閉じたあとの線を引く点`).toBe(true);
    await expectHandles(page, `${message}: 閉じたあとの + と点`);
    await expect.poll(() => barCount(page), `${message}: 閉じたあとの帯`).toBe(1);
}

// 開くもの: 名前の入力 (Enter)、詳細の入力 (D)、タグのパネル (T のタグ追加と、帯のタグ選択)
type Opener = 'name' | 'details' | 'tagAdd' | 'tagSelect';
const OPENERS: Record<Opener, { label: string; selector: string }> = {
    name: { label: '名前の入力 (Enter)', selector: '#a .mdag-editor-name-input[data-for="node"]' },
    details: { label: '詳細の入力 (D)', selector: '#a .mdag-editor-details-editor' },
    tagAdd: { label: 'タグのパネル (T のタグ追加)', selector: '#a .mdag-editor-tag-panel[data-panel="add"]' },
    tagSelect: { label: 'タグのパネル (帯のタグ選択)', selector: '#a .mdag-editor-tag-panel[data-panel="select"]' },
};

// 兄弟を足すキー (名前の入力中は名前を決めて兄弟を下に足す)。Enter の修飾キーは GUI 編集が開くときに navigator.platform で mac と win に分ける (mac は ⌘、win は Ctrl)
async function addSiblingKey(page: Page): Promise<string> {
    const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
    return mac ? 'Meta+Enter' : 'Control+Enter';
}

// 図の要素にフォーカスを置いてからキーを押す
async function pressKey(page: Page, key: string): Promise<void> {
    await page.evaluate(() => document.getElementById('a')?.focus({ preventScroll: true }));
    await page.keyboard.press(key);
}

async function openWith(page: Page, opener: Opener): Promise<void> {
    if (opener === 'name') await pressKey(page, 'Enter');
    else if (opener === 'details') await pressKey(page, 'd');
    else if (opener === 'tagAdd') await pressKey(page, 't');
    else await pressBar(page, 'tag-select');
}

const isShown = (page: Page, selector: string) => async (): Promise<boolean> => (await visible(page, selector).count()) === 1;

const target = (id: number, refText?: string): NodeTarget => ({ id, refText: refText ?? LABELS[id] ?? '' });

// 配布物の editSource で同じ書き換えをした原文 (期待の原文)
async function edited(page: Page, source: string, op: EditOp): Promise<string> {
    const outcome = await page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });
    if (outcome.status !== 'edited') throw new Error(`書き換えられない: ${JSON.stringify(outcome)}`);
    return outcome.source;
}

test.describe('入力とパネルを開いている間は線を引く点も隠す (F-17。scope.md の「触る F-17」、feedback-6 の F-17 の案)', () => {
    test('@editor 名前の入力 (Enter)、詳細の入力 (D)、タグのパネル (T のタグ追加、帯のタグ選択) を開いている間は線を引く点が見えない (帯と子の +、兄弟の + と同じ)。Esc で閉じると戻り、置き場は開く前と同じ (1px 以内)。倍率 1 と、点をずらす倍率 0.6 (子のないノードと子のあるノード)', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        // 子のないノード (Task A。項目なので詳細の入力も開ける) と子のあるノード (Design。見出しなので詳細の入力は開けない)
        const scenes: ReadonlyArray<{ id: number; name: string; openers: readonly Opener[] }> = [
            { id: TASK_A, name: 'Task A (子なし)', openers: ['name', 'details', 'tagAdd', 'tagSelect'] },
            { id: DESIGN, name: 'Design (子あり)', openers: ['name', 'tagAdd', 'tagSelect'] },
        ];
        const measures: string[] = [];
        for (const { id, name, openers } of scenes) {
            for (const zoom of [1, 0.6] as const) {
                for (const opener of openers) {
                    const { label: what, selector } = OPENERS[opener];
                    const label = `${name} 倍率 ${zoom} の${what}`;
                    await prepare(page, id, zoom, label);
                    await expect.poll(() => placementCheck(page, id), `${label} を開く前の線を引く点`).toBe(true);
                    const before = await linkRead(page, id);
                    if (!before) throw new Error(`${label}: 開く前に線を引く点が出ていない`);
                    if (zoom === 0.6) {
                        // 空振りの防ぎ: 点をずらす倍率では、開く前に点を角からずらしている
                        expect(before.dx, `${label} を開く前の、箱の右下の角からの横の位置 (ずらしている)`).toBeGreaterThan(5);
                    }

                    await openWith(page, opener);
                    const isOpen = isShown(page, selector);
                    await expectLinkHiddenWhile(page, before.center, isOpen, label);

                    await page.keyboard.press('Escape');
                    await expectLinkBack(page, id, isOpen, before, `${label} を Esc で閉じる`);
                    measures.push(`${label}: 開く前の位置 (${round1(before.dx)}, ${round1(before.dy)})px`);
                }
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        for (const line of measures) console.log(`fix-7 F-17: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-7 F-17', description })));
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor 閉じ方によらず、閉じるまで線を引く点は見えず、閉じると戻る: 名前の入力は外を押して決める、詳細の入力は ⌘Enter / Ctrl+Enter で保存、タグのパネルはタグを付けて描き直されても開いている間は見えないまま、Esc で閉じる (倍率 1)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);

        // 名前の入力: 名前を打って外を押して決める (Task B → Task Z)
        await prepare(page, TASK_B, 1, 'Task B');
        const nameBefore = await linkRead(page, TASK_B);
        if (!nameBefore) throw new Error('Task B: 開く前に線を引く点が出ていない');
        const nameOpen = isShown(page, OPENERS.name.selector);
        await openWith(page, 'name');
        await expectLinkHiddenWhile(page, nameBefore.center, nameOpen, 'Task B の名前の入力');
        await page.keyboard.type('Task Z');
        await settle(page);
        expect(await anyLink(page), 'Task B の名前を打っている間の線を引く点').toBeNull();
        await pressOutside(page);
        const renamed = DOC.replace('- Task B', '- Task Z');
        await expect.poll(() => getSource(page), '外を押して決める').toBe(renamed);
        await expectLinkBack(page, TASK_B, nameOpen, null, '外を押して名前を決めた');

        // 詳細の入力: 打って ⌘Enter / Ctrl+Enter で保存する
        await prepare(page, TASK_A, 1, 'Task A');
        const detailsBefore = await linkRead(page, TASK_A);
        if (!detailsBefore) throw new Error('Task A: 開く前に線を引く点が出ていない');
        const detailsOpen = isShown(page, OPENERS.details.selector);
        await openWith(page, 'details');
        await expectLinkHiddenWhile(page, detailsBefore.center, detailsOpen, 'Task A の詳細の入力');
        await page.keyboard.type('メモ');
        await page.keyboard.press('ControlOrMeta+Enter');
        const noted = renamed.replace('- Task A', '- Task A\n    > メモ');
        await expect.poll(() => getSource(page), '⌘Enter で保存').toBe(noted);
        await expectLinkBack(page, TASK_A, detailsOpen, null, '⌘Enter で詳細を保存した');

        // タグのパネル: キーを打って Enter で付ける (パネルは開いたまま)。描き直されても見えないまま。Esc で閉じる
        await prepare(page, LEAF, 1, 'Leaf');
        const tagBefore = await linkRead(page, LEAF);
        if (!tagBefore) throw new Error('Leaf: 開く前に線を引く点が出ていない');
        const tagOpen = isShown(page, OPENERS.tagAdd.selector);
        await openWith(page, 'tagAdd');
        await expectLinkHiddenWhile(page, tagBefore.center, tagOpen, 'Leaf のタグ追加のパネル');
        await page.keyboard.type('owner');
        await page.keyboard.press('Enter');
        const tagged = noted.replace('- Leaf', '- Leaf #owner');
        await expect.poll(() => getSource(page), '#owner を付ける').toBe(tagged);
        await expectLinkHiddenWhile(page, tagBefore.center, tagOpen, '#owner を付けたあとのタグ追加のパネル');
        await page.keyboard.press('Escape');
        await expectLinkBack(page, LEAF, tagOpen, null, 'タグを付けてから Esc で閉じた');
        expect(await getSource(page)).toBe(tagged);
        expect(errors).toEqual([]);
    });

    test('@editor 子の + で足したノードの名前の入力の間も線を引く点は見えない。入力中の兄弟を足すキー (mac は ⌘Enter、win は Ctrl+Enter) で名前を決めて兄弟を足し、次の名前の入力へ移る間も見えない。外を押して閉じると、選んでいる足したノードの右下に戻る。Enter で開き直した入力の間も見えず、入力中の Enter で名前を決めるだけで閉じると戻る (倍率 1)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await prepare(page, TASK_A, 1, 'Task A');
        const before = await linkRead(page, TASK_A);
        if (!before) throw new Error('Task A: 線を引く点が出ていない');
        const nameOpen = isShown(page, OPENERS.name.selector);

        await press(page, await spot(page, { on: 'element', selector: handleSelector('child') }));
        const added = await edited(page, DOC, { kind: 'addChild', parent: target(TASK_A), label: NEW });
        await expect.poll(() => getSource(page), '子の + で子を足す').toBe(added);
        await expectLinkHiddenWhile(page, before.center, nameOpen, '足した子の名前の入力');

        const first = await getSelection(page);
        if (first?.kind !== 'nodes' || first.nodes.length !== 1 || !first.nodes[0]) throw new Error(`足した子を選んでいない: ${JSON.stringify(first)}`);
        const child = first.nodes[0];
        await page.keyboard.type('Task C');
        const addKey = await addSiblingKey(page);
        await page.keyboard.press(addKey);
        const named = await edited(page, added, { kind: 'renameNode', node: child, label: 'Task C' });
        const chained = await edited(page, named, { kind: 'addSibling', node: { id: child.id, refText: 'Task C' }, label: NEW });
        await expect.poll(() => getSource(page), `${addKey} で名前を決めて兄弟を足す`).toBe(chained);
        await expectLinkHiddenWhile(page, before.center, nameOpen, '足した兄弟の名前の入力');

        const second = await getSelection(page);
        if (second?.kind !== 'nodes' || second.nodes.length !== 1 || !second.nodes[0]) throw new Error(`足した兄弟を選んでいない: ${JSON.stringify(second)}`);
        const sibling = second.nodes[0].id;
        await pressOutside(page);
        await expect.poll(() => getSource(page), '外を押して閉じる (名前は変えない)').toBe(chained);
        await expectLinkBack(page, sibling, nameOpen, null, '外を押して足した兄弟の名前の入力を閉じた');

        // 入力中の Enter は名前を決めるだけ: 兄弟を足さずに閉じ、選んでいる足した兄弟の右下に線を引く点が戻る
        const siblingBefore = await linkRead(page, sibling);
        if (!siblingBefore) throw new Error('足した兄弟: 線を引く点が出ていない');
        await pressKey(page, 'Enter');
        await expectLinkHiddenWhile(page, siblingBefore.center, nameOpen, 'Enter で開き直した兄弟の名前の入力');
        await page.keyboard.press('ControlOrMeta+KeyA');
        await page.keyboard.type('Task D');
        await page.keyboard.press('Enter');
        const renamed = await edited(page, chained, { kind: 'renameNode', node: { id: sibling, refText: NEW }, label: 'Task D' });
        await expect.poll(() => getSource(page), 'Enter で名前を決めるだけ').toBe(renamed);
        await expectLinkBack(page, sibling, nameOpen, null, 'Enter で名前を決めて兄弟の名前の入力を閉じた');
        expect(await getSource(page), 'Enter で名前を決めるだけ (兄弟は足さない)').toBe(renamed);
        expect(errors).toEqual([]);
    });
});

// ---- 合流させる点: 2 つ以上を選んでタグのパネルを開いている間 ----

const JOIN_SELECTOR = '#a .mdag-editor-handle[data-handle="join"]';

interface JoinRead {
    k: number;
    // 合流させる点の中心の、選んだノードの全体の矩形の右の辺と上下の中央からの位置 (画面の px)
    dx: number;
    dy: number;
    // 合流させる点の中心 (画面の座標)
    center: Point;
}

// 見えている合流させる点の、選んだノード ids の全体からの位置と図の倍率。見えていなければ null
async function joinRead(page: Page, ids: number[]): Promise<JoinRead | null> {
    return page.evaluate((ids) => {
        const container = document.getElementById('a');
        const view = (window as unknown as EditorWindow).editors.a?.view;
        if (!container || !view) throw new Error('#a の図がない');
        const handle = [...container.querySelectorAll('.mdag-editor-handle[data-handle="join"]')].find((element) => element.checkVisibility());
        if (!handle) return null;
        const rect = handle.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const boxes = ids.map((id) => {
            const box = container.querySelector(`.mdag-node[data-id="${id}"] .mdag-box`);
            if (!box) throw new Error(`ノード ${id} の箱がない`);
            return box.getBoundingClientRect();
        });
        const right = Math.max(...boxes.map((box) => box.right));
        const middle = (Math.min(...boxes.map((box) => box.top)) + Math.max(...boxes.map((box) => box.bottom))) / 2;
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        return { k: view.getTransform().k, dx: center.x - right, dy: center.y - middle, center };
    }, ids);
}

function sameJoinPlace(before: JoinRead, now: JoinRead | null): true | string {
    if (now === null) return '合流させる点が出ていない';
    return verdict(
        Math.abs(now.dx - before.dx) <= SAME_PLACE && Math.abs(now.dy - before.dy) <= SAME_PLACE && Math.abs(now.k - before.k) < 1e-6,
        `全体の右の辺と上下の中央からの位置 (${round1(now.dx)}, ${round1(now.dy)})px (開く前は (${round1(before.dx)}, ${round1(before.dy)})px、k ${now.k})`,
    );
}

const joinAt = (page: Page, point: Point): Promise<boolean> => page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix7Probe.joinAt(x, y), point);

// 選択の道具でノード ids を選び (選んでいなければ)、全体を図の領域の中心に置いて倍率を zoom にし、ポインタを図の外へ逃がして、合流させる点が落ち着くまで待つ
async function prepareNodes(page: Page, ids: number[], zoom: number, message: string): Promise<void> {
    const sorted = [...ids].sort((a, b) => a - b);
    if (JSON.stringify(await markedIds(page)) !== JSON.stringify(sorted)) await selectNodes(page, ids, message);
    await expect(visible(page, JOIN_SELECTOR), message).toHaveCount(1);
    const [area] = await rectsOf(page, '#a');
    if (!area) throw new Error('#a がない');
    const box = union(await Promise.all(ids.map((id) => nodeBox(page, id))));
    await panBy(page, (area.left + area.right) / 2 - (box.left + box.right) / 2, (area.top + area.bottom) / 2 - (box.top + box.bottom) / 2);
    await zoomTo(page, zoom);
    await page.mouse.move(AWAY.x, AWAY.y);
    await settle(page);
    const key = async (): Promise<string> => JSON.stringify(await joinRead(page, ids), (_, value: unknown) => (typeof value === 'number' ? Math.round(value * 10) / 10 : value));
    let last = await key();
    for (let round = 0; ; round += 1) {
        await page.waitForTimeout(80);
        const now = await key();
        if (now === last) break;
        if (round >= 30) throw new Error(`${message}: 合流させる点が落ち着かない`);
        last = now;
    }
}

test.describe('2 つ以上を選んでタグのパネルを開いている間は合流させる点も隠す (F-17 と同じ決まり。入力やパネルを開いている間はつまみと点を全部隠す)', () => {
    test('@editor 2 つ以上を選んでタグのパネル (T のタグ追加、帯のタグ選択) を開いている間は合流させる点が見えず、開く前の所で反応しない (帯と同じ)。Esc で閉じると選んだまま戻り、置き場は開く前と同じ (1px 以内)。倍率 1 と 0.6', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const ids = [TASK_A, TASK_B];
        const measures: string[] = [];
        for (const zoom of [1, 0.6] as const) {
            for (const opener of ['tagAdd', 'tagSelect'] as const) {
                const { label: what, selector } = OPENERS[opener];
                const label = `Task A と Task B 倍率 ${zoom} の${what}`;
                await prepareNodes(page, ids, zoom, label);
                const before = await joinRead(page, ids);
                if (!before) throw new Error(`${label}: 開く前に合流させる点が出ていない`);
                expect(await barCount(page), `${label}: 開く前の帯`).toBe(1);

                await openWith(page, opener);
                const isOpen = isShown(page, selector);
                await expect.poll(isOpen, `${label}: 開いている`).toBe(true);
                await expect.poll(() => joinRead(page, ids), `${label}: 開いている間の合流させる点`).toBeNull();
                await settle(page);
                expect(await joinRead(page, ids), `${label}: 開いている間の合流させる点 (数コマあと)`).toBeNull();
                expect(await joinAt(page, before.center), `${label}: 開く前の点の中心で合流させる点が反応しない`).toBe(false);
                expect(await barCount(page), `${label}: 開いている間の帯`).toBe(0);
                expect(await isOpen(), `${label}: 開いたまま`).toBe(true);

                await page.keyboard.press('Escape');
                await expect.poll(isOpen, `${label}: 閉じた`).toBe(false);
                await expect.poll(() => markedIds(page), `${label}: 選んだまま`).toEqual(ids);
                await page.mouse.move(AWAY.x, AWAY.y);
                await settle(page);
                await expect.poll(async () => sameJoinPlace(before, await joinRead(page, ids)), `${label}: 閉じたあとの合流させる点`).toBe(true);
                await expect.poll(() => barCount(page), `${label}: 閉じたあとの帯`).toBe(1);
                measures.push(`${label}: 開く前の位置 (${round1(before.dx)}, ${round1(before.dy)})px`);
            }
        }
        for (const line of measures) console.log(`fix-7 F-17 join: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-7 F-17 join', description })));
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });
});


// ---- 狭い図の領域の帯 ----

// 帯と道具箱の右の辺、帯と図の領域の右の辺の間
const EDGE_ROOM = 8;
// 入るときの確かめ (editor-fix-6 と同じ): 小数の丸めの分 0.5px、ずらしすぎないことは 1.5px の余裕
const EDGE_ROOM_MIN = EDGE_ROOM - 0.5;
const EDGE_ROOM_MAX = EDGE_ROOM + 1.5;
// 入らないときの確かめ: 帯の右の辺は図の領域の右の辺の 8px 手前 (0.5px の余裕)
const RIGHT_FIRST_MIN = EDGE_ROOM - 0.5;
const RIGHT_FIRST_MAX = EDGE_ROOM + 0.5;
// 帯と相手の間 (1 つのノードとグループは 20px、2 つ以上は 24px)
const BAR_GAP = 20;
const BAR_GAP_AROUND_BOUNDS = 24;

// 狭い図の領域の幅 (px)。道具箱 (図の領域の左の辺から x 10〜110) の右 8px から右の端の 8px 手前までが 234px で、
// ノードの帯 (ルートでも)、2 つ以上の帯、グループの帯のどれも入らない
const NARROW = 360;
// 依頼者が再現した窓の幅 800 の確認ページの図の領域の幅
const NARROW_PREVIEW = 475;
// ノードの帯がちょうど入る図の領域の幅 (道具箱の右 8px から右の端の 8px 手前まで、chromium で 434px)
const JUST_FITS = 560;

const zoomToOne = (page: Page): Promise<void> => zoomTo(page, 1);

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

const barKinds = async (page: Page): Promise<Array<string | null>> => (await barsOf(page)).map((bar) => bar.for);

// ノードを選ぶ: 最初のノードを修飾キーなしで押し、残りを Shift +クリックで足す
async function selectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const [first, ...rest] = ids;
    if (first === undefined) throw new Error('選ぶノードがない');
    await pressNode(page, first);
    await expect.poll(() => markedIds(page), message).toEqual([first]);
    for (const id of rest) await pressNode(page, id, 'Shift');
    await expect.poll(() => markedIds(page), message).toEqual([...ids].sort((a, b) => a - b));
}

// グループの index 番目 (描いた順) の枠のラベルを押して、そのグループを選ぶ (選択の道具)
async function pressFrameLabel(page: Page, group: string, index = 0): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: frameLabelSelector(group), index }));
    await expect.poll(() => barKinds(page), `グループ ${group} の帯`).toEqual(['group']);
}

// 選択を解く (帯を消す。次の相手を押せるように)
async function clearSelection(page: Page, message: string): Promise<void> {
    await page.keyboard.press('Escape');
    await expect.poll(() => barCount(page), `${message} の選択を解く`).toBe(0);
}

// 帯の相手 (ノード 1 つ、ノード 2 つ以上の全体、グループの index 番目の枠) の画面の矩形
type BarTarget = { node: number } | { nodes: number[] } | { group: string; frame: number };

async function targetBox(page: Page, target: BarTarget): Promise<Box> {
    if ('node' in target) return nodeBox(page, target.node);
    if ('nodes' in target) return union(await Promise.all(target.nodes.map((id) => nodeBox(page, id))));
    const box = (
        await page.evaluate((selector) => {
            return [...document.querySelectorAll(selector)].map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            });
        }, frameSelector(target.group))
    )[target.frame];
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

// 左右の置き場の決まり。left / right / center は入るとき (editor-fix-6 と同じ: 道具箱の右 8px にそろう、図の右の端の 8px 手前にそろう、
// 相手の左右の中央。どれも道具箱の右 8px から右の端の 8px 手前までに収まる)。rightFirst は入らないとき: 帯の右の辺が
// 図の領域の右の辺の 8px 手前 (左は道具箱の下に入ってよい)
type Side = 'left' | 'right' | 'center' | 'rightFirst';
type Vertical = 'above' | 'below' | 'beside';

interface BarPlacement {
    bars: Array<string | null>;
    // 相手の上 (間 gap) なら above、下なら below。どちらでもなければ測った値の文
    vertical: string;
    // 左右の置き場が決まりどおりなら true、違えば測った値の文
    horizontal: true | string;
}

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
    const room = `帯の左の辺は道具箱の右の辺から ${round1(fromToolbox)}px、帯の右の辺は図の領域の右の辺から ${round1(fromRight)}px、帯の幅 ${round1(rect.right - rect.left)}px、相手の左右の中央からのずれ ${round1(offCenter)}px`;
    const inside = fromToolbox >= EDGE_ROOM_MIN && fromRight >= EDGE_ROOM_MIN;
    const ok =
        side === 'rightFirst'
            ? fromRight >= RIGHT_FIRST_MIN && fromRight <= RIGHT_FIRST_MAX
            : side === 'left'
              ? inside && fromToolbox <= EDGE_ROOM_MAX
              : side === 'right'
                ? inside && fromRight <= EDGE_ROOM_MAX
                : inside && Math.abs(offCenter) <= 1;
    return { bars: [bar.for], vertical, horizontal: ok ? true : room };
}

async function expectBarPlaced(page: Page, target: BarTarget, kind: string, side: Side, vertical: Vertical, gap: number, message: string): Promise<void> {
    if (vertical === 'beside') {
        await expect
            .poll(async () => {
                const placement = await barPlacement(page, target, side, gap);
                return { bars: placement.bars, beside: placement.vertical === 'above' || placement.vertical === 'below' ? true : placement.vertical, horizontal: placement.horizontal };
            }, message)
            .toEqual({ bars: [kind], beside: true, horizontal: true });
        return;
    }
    await expect.poll(() => barPlacement(page, target, side, gap), message).toEqual({ bars: [kind], vertical, horizontal: true });
}

// 道具箱の右の辺と図の領域の右の辺 (図の領域の左上からの画面の px)
async function edgesOf(page: Page): Promise<{ toolboxRight: number; areaWidth: number; areaHeight: number }> {
    const area = await areaBox(page);
    const toolbox = await toolboxBox(page);
    return { toolboxRight: toolbox.right - area.left, areaWidth: area.right - area.left, areaHeight: area.bottom - area.top };
}

// 見えている帯の幅と、帯を収める範囲 (道具箱の右 8px から図の領域の右の端の 8px 手前まで) の幅
async function barRoom(page: Page): Promise<{ width: number; room: number }> {
    const [bar] = await barsOf(page);
    if (!bar) throw new Error('帯が出ていない');
    const area = await areaBox(page);
    const toolbox = await toolboxBox(page);
    return { width: bar.rect.right - bar.rect.left, room: area.right - EDGE_ROOM - (toolbox.right + EDGE_ROOM) };
}

// 空振りの防ぎ: 帯が「道具箱の右 8px から右の端の 8px 手前まで」に入らない (図の領域が狭い)
async function expectBarTooWide(page: Page, message: string): Promise<void> {
    const { width, room } = await barRoom(page);
    expect(width, `${message}: 帯の幅 ${round1(width)}px は、道具箱の右 8px から右の端の 8px 手前までの ${round1(room)}px より広い`).toBeGreaterThan(room + 1);
}

// 帯の左の辺が道具箱に重なる所では、道具箱が上に描かれる (押すと道具箱のボタン。隠れた帯のボタンは押せない)。
// 重なりの真ん中の点の要素が道具箱の中なら true、重ならなければ 'no-overlap'、ほかは要素の文
async function toolboxOverBar(page: Page): Promise<true | string> {
    return page.evaluate(() => {
        const bar = [...document.querySelectorAll('#a .mdag-editor-bar')].find((element) => element.checkVisibility());
        const toolbox = document.querySelector('#a .mdag-editor-toolbox');
        if (!bar || !toolbox) return '帯か道具箱がない';
        const a = bar.getBoundingClientRect();
        const b = toolbox.getBoundingClientRect();
        const left = Math.max(a.left, b.left, 0);
        const right = Math.min(a.right, b.right);
        const top = Math.max(a.top, b.top);
        const bottom = Math.min(a.bottom, b.bottom);
        if (right - left < 2 || bottom - top < 2) return 'no-overlap';
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        if (hit && toolbox.contains(hit)) return true;
        return `重なりの真ん中の要素 ${hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'なし'}${hit && bar.contains(hit) ? ' (帯の中)' : ''}`;
    });
}

// 狭い図の領域で、相手を図の領域の左の端 (中心を道具箱の右の辺から 30px)、真ん中、右の端 (中心を右の辺から 30px 内側) に置き、
// どこでも帯の右の辺が図の領域の右の辺の 8px 手前にあることを見る (上下は図の領域の中ほど。帯は相手の上)。左の端では帯の左が道具箱の下に入る
async function expectRightFirstAcross(page: Page, target: BarTarget, kind: string, gap: number, label: string): Promise<void> {
    const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
    await expectBarTooWide(page, label);
    const places: ReadonlyArray<[string, number]> = [
        ['左の端', toolboxRight + 30],
        ['真ん中', (toolboxRight + areaWidth) / 2],
        ['右の端', areaWidth - 30],
    ];
    for (const [name, x] of places) {
        await moveTargetTo(page, target, x, areaHeight / 2);
        await expectBarPlaced(page, target, kind, 'rightFirst', 'above', gap, `${label} (${name})`);
        await expect.poll(() => toolboxOverBar(page), `${label} (${name}): 帯の左が重なる所は道具箱が上`).toBe(true);
    }
}

test.describe('図の領域が狭くて帯が入らないときは右の端を優先する (F-18。scope.md の「触る F-18」、feedback-6 の F-18 の案 A)', () => {
    test('@editor 狭い図の領域では、ノードの帯 (ルートの「企画」、「設計」、右の端に近い「単体テスト」) は相手が左の端でも真ん中でも右の端でも、帯の右の辺が図の領域の右の辺の 8px 手前。左は道具箱の下に入り、重なる所は道具箱が上。上に入らず下に出るときも同じ', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, SIMPLE, NARROW);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        for (const [id, name] of [
            [UNIT_TEST, '単体テスト'],
            [PLAN, '企画 (ルート)'],
            [DESIGN_S, '設計'],
        ] as const) {
            await moveTargetTo(page, { node: id }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
            await selectNodes(page, [id], name);
            await expect.poll(() => barKinds(page), name).toEqual(['node']);
            await expectRightFirstAcross(page, { node: id }, 'node', BAR_GAP, name);
            if (id === PLAN) {
                // 上に入らない所 (箱の上の辺を図の領域の上の辺から 4px) では下に出て、左右は同じく右の端の 8px 手前
                await moveTargetTopTo(page, { node: id }, toolboxRight + 30, 4);
                await expectBarPlaced(page, { node: id }, 'node', 'rightFirst', 'below', BAR_GAP, `${name} (図の左上の端)`);
            }
            await clearSelection(page, name);
        }
        expect(await getSource(page)).toBe(SIMPLE);
        expect(errors).toEqual([]);
    });

    test('@editor 狭い図の領域では、2 つ以上を選んだ帯も、全体が左の端でも真ん中でも右の端でも、帯の右の辺が図の領域の右の辺の 8px 手前。全体の上 (間 24px) のまま', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE, NARROW);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        const nodes = [RESEARCH, BUILD_S];
        await moveTargetTo(page, { nodes }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, nodes, '調査と実装');
        await expect.poll(() => barKinds(page)).toEqual(['nodes']);
        await expectRightFirstAcross(page, { nodes }, 'nodes', BAR_GAP_AROUND_BOUNDS, '調査と実装');
        expect(await getSource(page)).toBe(SIMPLE);
    });

    test('@editor 狭い図の領域では、グループの帯も、枠が左の端でも真ん中でも右の端でも、帯の右の辺が図の領域の右の辺の 8px 手前。枠の上 (間 20px) のまま', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, SIMPLE, NARROW);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        for (const group of ['dev', 'test']) {
            await moveTargetTo(page, { group, frame: 0 }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
            await pressFrameLabel(page, group);
            await expectRightFirstAcross(page, { group, frame: 0 }, 'group', BAR_GAP, `グループ ${group}`);
            await clearSelection(page, `グループ ${group}`);
        }
        expect(await getSource(page)).toBe(SIMPLE);
    });

    test('@editor 依頼者の再現 (窓の幅 800 の図の領域 475px): 葉の例を開いた直後の表示のまま「DB の移行」を選ぶと、帯の右の辺が図の領域の右の辺の 8px 手前 (右がはみ出さない)', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, LEAVES, NARROW_PREVIEW);
        await useSelectTool(page);
        const id = await page.evaluate(() => {
            const node = [...document.querySelectorAll('#a .mdag-node')].find((element) => element.querySelector('.mdag-content')?.textContent?.trim() === 'DB の移行');
            return node ? Number(node.getAttribute('data-id')) : null;
        });
        if (id === null) throw new Error('「DB の移行」のノードがない');
        await selectNodes(page, [id], 'DB の移行');
        await expect.poll(() => barKinds(page)).toEqual(['node']);
        await expectBarTooWide(page, 'DB の移行');
        await expectBarPlaced(page, { node: id }, 'node', 'rightFirst', 'beside', BAR_GAP, 'DB の移行 (開いた直後の表示位置)');
        const overlap = await toolboxOverBar(page);
        if (overlap !== 'no-overlap') expect(overlap, 'DB の移行: 帯の左が重なる所は道具箱が上').toBe(true);
        expect(await getSource(page)).toBe(LEAVES);
        expect(errors).toEqual([]);
    });

    test('@editor 帯がちょうど入る図の領域 (幅 560px。道具箱の右 8px から右の端の 8px 手前まで chromium で 434px) では今のまま: 左の端では帯の左の辺が道具箱の右 8px、右の端では帯の右の辺が図の領域の右の辺の 8px 手前、真ん中では相手の左右の中央', async ({ page }) => {
        await open(page);
        await mount(page, SIMPLE, JUST_FITS);
        await zoomToOne(page);
        await useSelectTool(page);
        const { toolboxRight, areaWidth, areaHeight } = await edgesOf(page);
        await moveTargetTo(page, { node: DESIGN_S }, (toolboxRight + areaWidth) / 2, areaHeight / 2);
        await selectNodes(page, [DESIGN_S], '設計');
        await expect.poll(() => barKinds(page)).toEqual(['node']);
        // 空振りの防ぎ: 帯は入るが、余りは 60px まで (入らない境目の近く。帯と道具箱の幅はブラウザの字の幅で変わる: chromium で余り 21px、webkit で 44px)
        const { width, room } = await barRoom(page);
        expect(room - width, `帯の幅 ${round1(width)}px、道具箱の右 8px から右の端の 8px 手前まで ${round1(room)}px`).toBeGreaterThanOrEqual(0);
        expect(room - width, `帯の幅 ${round1(width)}px、道具箱の右 8px から右の端の 8px 手前まで ${round1(room)}px`).toBeLessThanOrEqual(60);
        await expectBarPlaced(page, { node: DESIGN_S }, 'node', 'center', 'above', BAR_GAP, '設計 (真ん中)');
        await moveTargetTo(page, { node: DESIGN_S }, toolboxRight + 30, areaHeight / 2);
        await expectBarPlaced(page, { node: DESIGN_S }, 'node', 'left', 'above', BAR_GAP, '設計 (左の端)');
        await moveTargetTo(page, { node: DESIGN_S }, areaWidth - 30, areaHeight / 2);
        await expectBarPlaced(page, { node: DESIGN_S }, 'node', 'right', 'above', BAR_GAP, '設計 (右の端)');
        expect(await getSource(page)).toBe(SIMPLE);
    });
});

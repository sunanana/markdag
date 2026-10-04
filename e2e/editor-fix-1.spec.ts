// GUI 編集で依頼者が図を触って出した指摘のうち、帯とつまみと線を引く点の置き場を、ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 帯はノードの箱から 20px (2 つ以上を選んだときは選んだ全体の矩形から 24px) 離す。+ のつまみの丸は選択の枠の線の外側から 1px 離し、
// + の印を丸のちょうど中心に置く。線を引く点の丸の中心は選択の枠の右下の角の線の中ほどに置き、乗せると丸の側を止めて 1.1 倍にする。
// 道具箱の並びと最初の道具は、道具のテストの期待で確かめる。
// 見た目そのもの (色、文字とアイコンの大きさ、余白の値、アイコンと線を引く点の形) は見ない。見るのは置き場の関係だけ:
// 帯とノード (か選んだ全体、グループの枠) の間、+ のつまみと選択の枠の線の外側の間、+ の印と丸の中心、線を引く点の丸と選択の枠の右下の角、
// 乗せたときに丸の側が止まるか、つまみと点が重ならないか。
// 線を引く点の置き場は、あとの指摘で、角に置くと子の + か兄弟の + との丸どうしの間が 2px 未満になる倍率
// (この文書では 0.6) では右下 45° へずらすことになったので、その倍率の期待は「ずらした先」にした (ほかの倍率は角のまま。点をずらすテストが見る)。
// 選択の枠は、選んだノードの箱 (.mdag-box) の outline。外側の線は箱の辺から (outline-offset + outline-width) × 図の倍率の所にある。
// つまみと点の「丸」は、要素そのものか中の要素のうち、丸く描くもの (border-radius が幅の半分以上で縦横が同じ HTML の要素、または SVG の circle) の最初のもの
// (線を引く点の尾の線と矢尻は丸の外に描く)。+ の印は、つまみの中の SVG の図形の範囲。
// 反映は expect.poll で待つ
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

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、Task A と Task B は縦に並ぶ。
// 子のあるノード (Root、Design、Build) には開閉の丸がある
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const ROOT = 1;
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;

const DOC = docWith(BODY);
// Design と配下 (2〜4) がグループ design の枠に入る文書 (ノードの id は DOC と同じ)
const DOC_GROUP = docWith(
    BODY.map((line) => (line === '## Design' ? '## Design %design' : line)),
    ['groups:', '    design:', '        label: 設計', '        color: "#3B7DD8"', '        boundary: true'],
);

// 帯とノードの箱の間 (前の 8px から 12px 上へ離して 20px)。2 つ以上を選んだときは選んだ全体の矩形から 24px (今の 12px + 12px)。
// グループは枠から 20px (今の 8px + 12px)。どれも小数の丸めの分 0.5px の余裕を見る
const BAR_GAP = 20 - 0.5;
const BAR_GAP_AROUND_NODES = 24 - 0.5;

// + のつまみの丸と選択の枠の線の外側の間 (1px 離す)。小数の丸めの分 0.1px の余裕を見る
const PLUS_GAP = 1 - 0.1;
// + の印の中心と丸の中心のずれの上限 (ちょうど中心)
const MARK_OFFSET = 1;
// 線を引く点の丸の中心が、選択の枠の線 (内側から外側まで) の範囲に入っているとみなす余裕 (右下の角の線の中ほど)
const CORNER_SLACK = 1;
// 乗せたときに丸の中心が動いてよい量と、大きくなったとみなす直径の比 (丸の側を止めて 1.1 倍)
const HOVER_SHIFT = 1;
const HOVER_GROWTH = 1.05;
// 線を引く点を角に置くと子の + か兄弟の + との丸どうしの間が 2px 未満になる倍率では、右下 45° へ 2px 以上になるまでずらす。
// ずらした先の確かめ: 間は 1.9px (測りの丸め) から 3px まで、横と縦のずれの差は 0.5px まで
const LINK_GAP = { goal: 2, min: 1.9, max: 3 };
const DIAGONAL_SLACK = 0.5;

// 確かめる図の倍率。fit は全体表示 (開いたとき) のまま (この文書と図の領域では上限の 2 倍になる)。
// 1.2 は確認ページで依頼者が触った倍率に近い値、3 は拡大、0.6 は縮小
const ZOOMS = ['fit', 1.2, 3, 0.6] as const;
type Zoom = (typeof ZOOMS)[number];
// 線を引く点を角からずらす倍率 (この文書の 1 行のノードでは、角に置くと子の + との間が 2px 未満になる)
const SHIFTED_ZOOMS: ReadonlySet<Zoom> = new Set<Zoom>([0.6]);

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
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const handleSelector = (kind: 'child' | 'sibling' | 'link'): string => `#a .mdag-editor-handle[data-handle="${kind}"]`;

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
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

function union(boxes: Box[]): Box {
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

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

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }));
}

// 修飾キーを押したままノードの箱を押す (選択に足す)
async function pressNodeWith(page: Page, id: number, modifier: string): Promise<void> {
    const point = await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` });
    await page.keyboard.down(modifier);
    try {
        await press(page, point);
    } finally {
        await page.keyboard.up(modifier);
    }
}

// 選んでいるノード (data-selected の付いたノードの id、昇順) が ids になるまで待つ
async function expectMarked(page: Page, ids: number[], message?: string): Promise<void> {
    await expect
        .poll(
            () => page.evaluate(() => [...document.querySelectorAll('#a .mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b)),
            message,
        )
        .toEqual(ids);
}

// 図を、画面の上の距離で動かす
const panBy = (page: Page, dx: number, dy: number): Promise<void> => page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });

// 矩形 (画面の座標) の中心が図の領域の中心に来るよう、図を動かす (帯とつまみを上下左右のどちらにも置ける所へ)
async function centerOn(page: Page, box: Box): Promise<void> {
    const [area] = await rectsOf(page, '#a');
    if (!area) throw new Error('#a がない');
    await panBy(page, (area.left + area.right) / 2 - (box.left + box.right) / 2, (area.top + area.bottom) / 2 - (box.top + box.bottom) / 2);
}

// ノードを図の領域の中心に置き、図の倍率を zoom にする (fit なら全体表示の倍率のまま中心に置く)
async function zoomOn(page: Page, id: number, zoom: Zoom): Promise<void> {
    await centerOn(page, await nodeBox(page, id));
    if (zoom === 'fit') return;
    await page.evaluate((k) => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        const container = document.getElementById('a');
        if (!view || !container) throw new Error('#a の図がない');
        view.zoomBy(k / view.getTransform().k, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
    }, zoom);
    await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getTransform().k)).toBeCloseTo(zoom, 3);
}

interface BarInfo {
    for: string | null;
    rect: Box;
}

// 見えている操作の帯
async function barsOf(page: Page): Promise<BarInfo[]> {
    return page.evaluate(() => {
        return [...document.querySelectorAll('#a .mdag-editor-bar')]
            .filter((bar) => bar.checkVisibility())
            .map((bar) => {
                const rect = bar.getBoundingClientRect();
                return { for: bar.getAttribute('data-for'), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
            });
    });
}

// 確かめた結果。よければ true、だめなら測った値の文 (失敗の差分に値が出るように)
const verdict = (ok: boolean, detail: string): true | string => (ok ? true : detail);

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface BarPlacement {
    // 見えている帯の data-for
    bars: Array<string | null>;
    // 帯が相手の上 (above) か下 (below) か。相手の左右の中ほどに掛からなければ aside
    side: 'above' | 'below' | 'aside' | null;
    // 相手の矩形と帯の間 (上なら相手の上の辺と帯の下の辺、下なら相手の下の辺と帯の上の辺)
    gap: number | null;
}

// 帯が 1 つ出ていれば、相手の矩形 target との置き場の関係
async function barPlacement(page: Page, target: () => Promise<Box>): Promise<BarPlacement> {
    const bars = await barsOf(page);
    const [bar] = bars;
    if (bars.length !== 1 || !bar) return { bars: bars.map((item) => item.for), side: null, gap: null };
    const box = await target();
    const middle = (box.left + box.right) / 2;
    const across = bar.rect.left <= middle && bar.rect.right >= middle;
    if (across && bar.rect.bottom <= box.top + 1) return { bars: [bar.for], side: 'above', gap: box.top - bar.rect.bottom };
    if (across && bar.rect.top >= box.bottom - 1) return { bars: [bar.for], side: 'below', gap: bar.rect.top - box.bottom };
    return { bars: [bar.for], side: 'aside', gap: null };
}

// 帯が相手の side に、minGap 以上離れて出るまで待つ
async function expectBar(page: Page, kind: string, side: 'above' | 'below', minGap: number, target: () => Promise<Box>, message: string): Promise<void> {
    await expect
        .poll(async () => {
            const placement = await barPlacement(page, target);
            return { bars: placement.bars, side: placement.side, gap: placement.gap === null ? null : verdict(placement.gap >= minGap, `間 ${round1(placement.gap)}px`) };
        }, message)
        .toEqual({ bars: [kind], side, gap: true });
}

interface Geometry {
    // 選んだノードの箱 (画面の座標) と図の倍率 (箱の画面の幅 / 箱の幅)
    box: Box;
    k: number;
    // 選択の枠の線の内側と外側の、箱の辺からの距離 (画面の px)。選択の枠 (outline) がなければ null
    frame: { inner: number; outer: number } | null;
    child: Circle | null;
    sibling: Circle | null;
    link: Circle | null;
    // 子と兄弟の + の印の範囲の中心
    childMark: Point | null;
    siblingMark: Point | null;
    // 選んだノードの開閉の丸 (子がなければ null)
    fold: Circle | null;
}

// 選んだノード id のまわりの、選択の枠、つまみと点の丸、+ の印、開閉の丸を 1 度に読む
async function geometryOf(page: Page, id: number): Promise<Geometry> {
    return page.evaluate((id) => {
        const container = document.getElementById('a');
        const box = container?.querySelector<HTMLElement>(`.mdag-node[data-id="${id}"] .mdag-box`);
        if (!container || !box) throw new Error(`ノード ${id} の箱がない`);
        const rect = box.getBoundingClientRect();
        const k = rect.width / box.offsetWidth;
        const style = getComputedStyle(box);
        const frame =
            style.outlineStyle === 'none' || parseFloat(style.outlineWidth) === 0
                ? null
                : { inner: parseFloat(style.outlineOffset) * k, outer: (parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth)) * k };

        // 丸く描くものの最初のもの。SVG の circle は線の太さの半分を半径に足す
        const circleIn = (root: Element): { cx: number; cy: number; r: number } | null => {
            for (const element of [root, ...root.querySelectorAll('*')]) {
                if (element instanceof SVGCircleElement) {
                    const bounds = element.getBoundingClientRect();
                    if (bounds.width === 0) continue;
                    const matrix = element.getScreenCTM();
                    const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
                    const circleStyle = getComputedStyle(element);
                    const stroke = circleStyle.stroke === 'none' ? 0 : parseFloat(circleStyle.strokeWidth) || 0;
                    return { cx: bounds.left + bounds.width / 2, cy: bounds.top + bounds.height / 2, r: bounds.width / 2 + (stroke * scale) / 2 };
                }
                if (element instanceof HTMLElement) {
                    const width = element.offsetWidth;
                    if (width === 0 || Math.abs(width - element.offsetHeight) > 0.5) continue;
                    const radius = getComputedStyle(element).borderTopLeftRadius;
                    const round = radius.endsWith('%') ? parseFloat(radius) >= 50 : parseFloat(radius) >= width / 2 - 0.5;
                    if (!round) continue;
                    const bounds = element.getBoundingClientRect();
                    return { cx: bounds.left + bounds.width / 2, cy: bounds.top + bounds.height / 2, r: bounds.width / 2 };
                }
            }
            return null;
        };
        // つまみの中の SVG の図形の範囲 (線の太さは含めない) の中心
        const markIn = (root: Element): { x: number; y: number } | null => {
            const svg = root.querySelector('svg');
            if (!svg) return null;
            let left = Infinity;
            let top = Infinity;
            let right = -Infinity;
            let bottom = -Infinity;
            for (const shape of svg.querySelectorAll<SVGGraphicsElement>('path, line, polyline, polygon, rect, circle, ellipse')) {
                const bbox = shape.getBBox();
                const matrix = shape.getScreenCTM();
                if (!matrix) continue;
                for (const [x, y] of [
                    [bbox.x, bbox.y],
                    [bbox.x + bbox.width, bbox.y],
                    [bbox.x, bbox.y + bbox.height],
                    [bbox.x + bbox.width, bbox.y + bbox.height],
                ] as const) {
                    const point = new DOMPoint(x, y).matrixTransform(matrix);
                    left = Math.min(left, point.x);
                    top = Math.min(top, point.y);
                    right = Math.max(right, point.x);
                    bottom = Math.max(bottom, point.y);
                }
            }
            return Number.isFinite(left) ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
        };
        const handle = (kind: string): Element | null => [...container.querySelectorAll(`.mdag-editor-handle[data-handle="${kind}"]`)].find((element) => element.checkVisibility()) ?? null;
        const child = handle('child');
        const sibling = handle('sibling');
        const link = handle('link');
        const fold = container.querySelector(`.mdag-fold[data-id="${id}"]`);
        return {
            box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            k,
            frame,
            child: child ? circleIn(child) : null,
            sibling: sibling ? circleIn(sibling) : null,
            link: link ? circleIn(link) : null,
            childMark: child ? markIn(child) : null,
            siblingMark: sibling ? markIn(sibling) : null,
            fold: fold ? circleIn(fold) : null,
        };
    }, id);
}

// 丸と、選択の枠の線の外側の矩形の間 (中心から矩形までの距離 - 半径。負なら重なる)
function gapToFrame(circle: Circle, box: Box, outer: number): number {
    const left = box.left - outer;
    const top = box.top - outer;
    const right = box.right + outer;
    const bottom = box.bottom + outer;
    const dx = Math.max(left - circle.cx, 0, circle.cx - right);
    const dy = Math.max(top - circle.cy, 0, circle.cy - bottom);
    return Math.hypot(dx, dy) - circle.r;
}

// 2 つの丸の間 (負なら重なる)
const gapBetween = (a: Circle, b: Circle): number => Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;

const kOf = (geometry: Geometry): string => `k ${Math.round(geometry.k * 1000) / 1000}`;

// 選んだノード id の子と兄弟の + の丸が、選択の枠の線の外側から PLUS_GAP 以上離れているか (apart) と、+ の印が丸の中心にあるか (centered)。
// つまみがなければ null
interface PlusCheck {
    apart: { child: true | string | null; sibling: true | string | null };
    centered: { child: true | string | null; sibling: true | string | null };
}

async function plusCheck(page: Page, id: number): Promise<PlusCheck> {
    const geometry = await geometryOf(page, id);
    const { frame, box } = geometry;
    if (!frame) throw new Error(`ノード ${id} の選択の枠 (outline) がない`);
    const apart = (circle: Circle | null): true | string | null => {
        if (circle === null) return null;
        const gap = gapToFrame(circle, box, frame.outer);
        return verdict(gap >= PLUS_GAP, `選択の枠の線の外側との間 ${round1(gap)}px (${kOf(geometry)})`);
    };
    const centered = (circle: Circle | null, mark: Point | null): true | string | null => {
        if (circle === null) return null;
        if (mark === null) return '+ の印 (SVG の図形) がない';
        const dx = mark.x - circle.cx;
        const dy = mark.y - circle.cy;
        return verdict(Math.abs(dx) <= MARK_OFFSET && Math.abs(dy) <= MARK_OFFSET, `印の中心のずれ dx ${round1(dx)}px dy ${round1(dy)}px (${kOf(geometry)})`);
    };
    return {
        apart: { child: apart(geometry.child), sibling: apart(geometry.sibling) },
        centered: { child: centered(geometry.child, geometry.childMark), sibling: centered(geometry.sibling, geometry.siblingMark) },
    };
}

// 選んだノード id の線を引く点の丸の中心が、選択の枠の右下の角 (線の内側から外側までの範囲、CORNER_SLACK の余裕) にあるか。点がなければ null
async function cornerCheck(page: Page, id: number): Promise<true | string | null> {
    const geometry = await geometryOf(page, id);
    const { frame, box, link } = geometry;
    if (!frame) throw new Error(`ノード ${id} の選択の枠 (outline) がない`);
    if (!link) return null;
    const within = (value: number): boolean => value >= frame.inner - CORNER_SLACK && value <= frame.outer + CORNER_SLACK;
    const dx = link.cx - box.right;
    const dy = link.cy - box.bottom;
    return verdict(
        within(dx) && within(dy),
        `丸の中心は箱の右下の角から dx ${round1(dx)}px dy ${round1(dy)}px (選択の枠の線は ${round1(frame.inner)}〜${round1(frame.outer)}px、${kOf(geometry)})`,
    );
}

// 線を引く点の丸の線の外側までの半径 (画面の px)。SVG の図形の矩形に線の太さを含めるブラウザ (firefox) でも同じ値になるよう、半径と線の太さから出す
// (乗せていないときに読む)
const linkRadius = (page: Page): Promise<number | null> =>
    page.evaluate(() => {
        const circle = [...document.querySelectorAll<SVGCircleElement>('#a .mdag-editor-handle[data-handle="link"] circle')].find((element) => element.checkVisibility());
        if (!circle) return null;
        const matrix = circle.getScreenCTM();
        const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
        return (circle.r.baseVal.value + (parseFloat(getComputedStyle(circle).strokeWidth) || 0) / 2) * scale;
    });

// 選んだノード id の線を引く点が、角から右下 45° へ、子の + と兄弟の + との丸どうしの間が 2px 以上 (3px まで) になるだけずれているか。
// 角に置いたときの間が 2px 以上なら (ずらす倍率でないなら) 失敗にする。点がなければ null
async function shiftedCheck(page: Page, id: number): Promise<true | string | null> {
    const geometry = await geometryOf(page, id);
    const { frame, box } = geometry;
    if (!frame) throw new Error(`ノード ${id} の選択の枠 (outline) がない`);
    const radius = await linkRadius(page);
    if (!geometry.link || radius === null) return null;
    const link = { ...geometry.link, r: radius };
    const pluses = [geometry.child, geometry.sibling].filter((circle): circle is Circle => circle !== null);
    const middle = (frame.inner + frame.outer) / 2;
    const corner = { cx: box.right + middle, cy: box.bottom + middle, r: link.r };
    const cornerGap = Math.min(...pluses.map((plus) => gapBetween(plus, corner)));
    const gap = Math.min(...pluses.map((plus) => gapBetween(plus, link)));
    const dx = link.cx - corner.cx;
    const dy = link.cy - corner.cy;
    return verdict(
        cornerGap < LINK_GAP.goal && dx > 0 && Math.abs(dx - dy) <= DIAGONAL_SLACK && gap >= LINK_GAP.min && gap <= LINK_GAP.max,
        `角に置いたときの間 ${round1(cornerGap)}px、今の間 ${round1(gap)}px、角からのずれ dx ${round1(dx)}px dy ${round1(dy)}px (${kOf(geometry)})`,
    );
}

// 倍率 zoom での線を引く点の置き場: ずらす倍率ならずらした先、ほかは角
const placementCheck = (page: Page, id: number, zoom: Zoom): Promise<true | string | null> => (SHIFTED_ZOOMS.has(zoom) ? shiftedCheck(page, id) : cornerCheck(page, id));

// 選んだノードのつまみと点が出るまで待つ (ルートには兄弟の + がない)
async function expectHandles(page: Page, id: number, message?: string): Promise<void> {
    await expect(visible(page, handleSelector('child')), message).toHaveCount(1);
    await expect(visible(page, handleSelector('sibling')), message).toHaveCount(id === ROOT ? 0 : 1);
    await expect(visible(page, handleSelector('link')), message).toHaveCount(1);
}

// 選択の道具でノードを 1 つ選ぶ
async function selectNode(page: Page, id: number): Promise<void> {
    await pressNode(page, id);
    await expectMarked(page, [id]);
    await expectHandles(page, id, `ノード ${id}`);
}

// 子のないノード (Task A、Leaf) と子のあるノード (Design)
const NODES = [
    { id: TASK_A, name: 'Task A (子なし)' },
    { id: LEAF, name: 'Leaf (子なし)' },
    { id: DESIGN, name: 'Design (子あり)' },
] as const;

test.describe('操作の帯の離れ (F-03)', () => {
    test('@editor 1 つのノードを選んだ帯は、ノードの箱の上の辺から 20px 以上離れて上に出る (今は 8px)。選び直したノードでも同じ', async ({ page }) => {
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const { id, name } of NODES) {
            await centerOn(page, await nodeBox(page, id));
            await pressNode(page, id);
            await expectMarked(page, [id], name);
            await expectBar(page, 'node', 'above', BAR_GAP, () => nodeBox(page, id), name);
        }
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor ノードの上に帯が入らないときは下に出て、ノードの箱の下の辺から 20px 以上離れる (下に出すときも 12px 離す)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await expectMarked(page, [TASK_A]);
        await expect.poll(async () => (await barsOf(page)).length).toBe(1);

        // Task A の箱の上の辺を図の領域の上の辺から 4px の所へ動かす (帯は上に入らない)
        const [area] = await rectsOf(page, '#a');
        if (!area) throw new Error('#a がない');
        await panBy(page, 0, area.top + 4 - (await nodeBox(page, TASK_A)).top);
        await expectBar(page, 'node', 'below', BAR_GAP, () => nodeBox(page, TASK_A), '上に入らない');

        // 空振りの防ぎ: 上に入れば上に戻り、同じだけ離れる
        await centerOn(page, await nodeBox(page, TASK_A));
        await expectBar(page, 'node', 'above', BAR_GAP, () => nodeBox(page, TASK_A), '上に入る');
    });

    test('@editor 2 つ以上を選んだ帯は、選んだノードの全体の矩形の上の辺から 24px 以上離れる (今は 12px)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await pressNode(page, TASK_A);
        await pressNodeWith(page, TASK_B, 'Shift');
        await expectMarked(page, [TASK_A, TASK_B]);
        const selected = async (): Promise<Box> => union([await nodeBox(page, TASK_A), await nodeBox(page, TASK_B)]);
        await centerOn(page, await selected());
        await expectBar(page, 'nodes', 'above', BAR_GAP_AROUND_NODES, selected, 'Task A と Task B');
    });

    test('@editor グループを選んだ帯は、グループの枠の上の辺から 20px 以上離れる (今は 8px)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_GROUP);
        await useSelectTool(page);
        const frame = async (): Promise<Box> => {
            const [rect] = await rectsOf(page, '#a .mdag-frame[data-group="design"]');
            if (!rect) throw new Error('グループ design の枠がない');
            return rect;
        };
        await centerOn(page, await frame());
        await press(page, await spot(page, { on: 'element', selector: '#a .mdag-frame[data-group="design"]' }));
        await expectBar(page, 'group', 'above', BAR_GAP, frame, 'グループ design');
        expect(await getSource(page)).toBe(DOC_GROUP);
    });
});

test.describe('子と兄弟の + のつまみ (F-05)', () => {
    test('@editor 子の + と兄弟の + の丸は、選択の枠の線の外側から 1px 以上離れる (倍率は全体表示、1.2、3、0.6。子のないノードと子のあるノード)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const { id, name } of NODES) {
            await selectNode(page, id);
            for (const zoom of ZOOMS) {
                await zoomOn(page, id, zoom);
                await expect.poll(async () => (await plusCheck(page, id)).apart, `${name} 倍率 ${zoom}`).toEqual({ child: true, sibling: true });
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor 子の + と兄弟の + の印は丸のちょうど中心にある (ずれ 1px 以内。倍率は全体表示、1.2、3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await selectNode(page, TASK_A);
        for (const zoom of ['fit', 1.2, 3] as const) {
            await zoomOn(page, TASK_A, zoom);
            await expect.poll(async () => (await plusCheck(page, TASK_A)).centered, `倍率 ${zoom}`).toEqual({ child: true, sibling: true });
        }
    });
});

test.describe('線を引く点 (F-06)', () => {
    test('@editor 線を引く点の丸の中心は、選択の枠の右下の角 (枠の線の上) にある (倍率は全体表示、1.2、3。子のないノードと子のあるノード)。F-16 でずらす倍率 0.6 では、角から右下 45° へ、子の + と兄弟の + との間が 2〜3px になる所', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const { id, name } of NODES) {
            await selectNode(page, id);
            for (const zoom of ZOOMS) {
                await zoomOn(page, id, zoom);
                await expect.poll(() => placementCheck(page, id, zoom), `${name} 倍率 ${zoom}`).toBe(true);
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor 線を引く点の丸にポインタを乗せると丸が大きくなり (1.05 倍以上)、丸の中心は動かない (1px 以内)。離すと戻る', async ({ page }) => {
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const { id, name } of NODES) {
            await selectNode(page, id);
            await centerOn(page, await nodeBox(page, id));
            await expect.poll(() => cornerCheck(page, id), `${name} 乗せる前`).toBe(true);
            const before = (await geometryOf(page, id)).link;
            if (!before) throw new Error(`${name}: 線を引く点の丸がない`);
            // 丸の中心が線を引く点の上 (ほかのつまみや帯に隠れていない)
            const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.mdag-editor-handle')?.getAttribute('data-handle') ?? null, { x: before.cx, y: before.cy });
            expect(hit, `${name}: 丸の中心の上の要素`).toBe('link');

            await page.mouse.move(before.cx, before.cy);
            await expect
                .poll(async () => {
                    const after = (await geometryOf(page, id)).link;
                    if (!after) return 'なくなった';
                    const ratio = after.r / before.r;
                    const shift = Math.hypot(after.cx - before.cx, after.cy - before.cy);
                    return {
                        grown: verdict(ratio >= HOVER_GROWTH, `直径の比 ${Math.round(ratio * 100) / 100}`),
                        still: verdict(shift <= HOVER_SHIFT, `中心の動き ${round1(shift)}px`),
                    };
                }, `${name} 乗せた`)
                .toEqual({ grown: true, still: true });

            // 離すと元の大きさに戻る
            const blank = await spot(page, { on: 'blank' });
            await page.mouse.move(blank.x, blank.y);
            await expect
                .poll(async () => {
                    const after = (await geometryOf(page, id)).link;
                    return after ? round1(after.r) : null;
                }, `${name} 離した`)
                .toBe(round1(before.r));
        }
    });

    test('@editor 子の + と兄弟の + と線を引く点の丸は互いに重ならない (倍率は全体表示、1.2、3。乗せて大きくした点も)。開閉の丸と、縮小 0.6 倍での重なりは測って残す (0.6 倍の線を引く点は F-16 でずらした先)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const measures: string[] = [];
        for (const { id, name } of NODES) {
            await selectNode(page, id);
            for (const zoom of ZOOMS) {
                await zoomOn(page, id, zoom);
                await expect.poll(() => placementCheck(page, id, zoom), `${name} 倍率 ${zoom}`).toBe(true);
                const geometry = await geometryOf(page, id);
                const { child, sibling, link, fold } = geometry;
                if (!child || !sibling || !link) throw new Error(`${name} 倍率 ${zoom}: つまみか点の丸がない`);
                const gaps = {
                    childLink: round1(gapBetween(child, link)),
                    siblingLink: round1(gapBetween(sibling, link)),
                    childSibling: round1(gapBetween(child, sibling)),
                    foldLink: fold ? round1(gapBetween(fold, link)) : null,
                    foldChild: fold ? round1(gapBetween(fold, child)) : null,
                    foldSibling: fold ? round1(gapBetween(fold, sibling)) : null,
                };
                measures.push(`${name} 倍率 ${zoom} (${kOf(geometry)}): ${JSON.stringify(gaps)}`);
                if (zoom === 0.6) continue;
                expect(
                    {
                        childLink: verdict(gaps.childLink >= 0, `${gaps.childLink}px`),
                        siblingLink: verdict(gaps.siblingLink >= 0, `${gaps.siblingLink}px`),
                        childSibling: verdict(gaps.childSibling >= 0, `${gaps.childSibling}px`),
                    },
                    `${name} 倍率 ${zoom}`,
                ).toEqual({ childLink: true, siblingLink: true, childSibling: true });

                // 乗せて大きくした点も、子の + と兄弟の + に重ならない
                await page.mouse.move(link.cx, link.cy);
                await expect
                    .poll(async () => {
                        const hovered = await geometryOf(page, id);
                        if (!hovered.link || !hovered.child || !hovered.sibling) return 'つまみか点の丸がない';
                        const ratio = hovered.link.r / link.r;
                        const childLink = gapBetween(hovered.child, hovered.link);
                        const siblingLink = gapBetween(hovered.sibling, hovered.link);
                        return {
                            grown: verdict(ratio >= HOVER_GROWTH, `直径の比 ${Math.round(ratio * 100) / 100}`),
                            childLink: verdict(childLink >= 0, `${round1(childLink)}px`),
                            siblingLink: verdict(siblingLink >= 0, `${round1(siblingLink)}px`),
                        };
                    }, `${name} 倍率 ${zoom} 乗せた`)
                    .toEqual({ grown: true, childLink: true, siblingLink: true });
                const blank = await spot(page, { on: 'blank' });
                await page.mouse.move(blank.x, blank.y);
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        // 開閉の丸と縮小での重なりは、依頼者が P1 を選んだときに見た値と比べるために残す (負なら重なり)
        for (const line of measures) console.log(`fix-1 measure: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-1 measure', description })));
    });
});

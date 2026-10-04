// GUI 編集で依頼者が図を触って出した指摘のうち、グループのメンバーが離れた所にあって、メンバーが 1 つだけの所にも枠を描くことを、
// ビルドした配布物の markdag/core (render の閲覧の図) と markdag/editor (GUI 編集) で確かめる。
// 決まったこと: 枠は破線、グループの色、余白は 2 つ以上の枠と同じ、ラベルつき、まわりの間も同じ。見えているメンバーだけを数え、
// 1 つでも枠、0 なら枠なし。boundary: false は枠なし。入れ子の決まりは同じ。図の側も見えているメンバーが 1 つの枠を描く。
// 押した枠に名前の入力と帯を出す決まり (離れたグループのテストと同じ読み方)。
// 見た目そのもの (色、破線の形) は見ない。枠は .mdag-frame[data-group]、ラベルは .mdag-frame-label[data-group] の要素の矩形で読み、
// 枠に入るノードは箱 (.mdag-box) が枠の矩形に収まるもので数える。「2 つ以上の枠と同じ」は、同じ図の 2 つのメンバーの枠と比べる
// (枠とメンバーの箱の間の余白、ラベルと枠の位置の差)。反映は expect.poll で待つ
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditSelection, MarkdagDiagram } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // render で描いた閲覧の図
    diagram?: MarkdagDiagram;
};

const DIST = resolve('dist');

// 確認ページの見本「枝をまたぐグループ」と同じ groups と本文。editor の行だけを替える (null なら書かない)。
// ノードは 決済機能 1、フロントエンド 2、カード入力フォーム 3、3Dセキュア画面 4、購入完了画面 5、バックエンド 6、決済API 7、トークン管理 8、
// 領収書メール 9、運用 10、監視の設定 11、鍵のローテーション 12。sec のメンバーは 3 と 4、7 と 8、12 (監視の設定の下で、隣にメンバーがない)
function crossDoc(editor: string[] | null): string {
    const lines = ['---', 'title: 枝をまたぐグループ', 'markdag:'];
    if (editor) lines.push('    editor:', ...editor.map((line) => `        ${line}`));
    lines.push('    groups:', '        sec:', '            label: セキュリティレビュー', '            color: "#D64545"', '            boundary: true', '---');
    return [
        ...lines,
        '',
        '# 決済機能',
        '',
        '## フロントエンド',
        '- カード入力フォーム %sec',
        '- 3Dセキュア画面 %sec',
        '- 購入完了画面',
        '',
        '## バックエンド',
        '- 決済API %sec',
        '- トークン管理 %sec',
        '- 領収書メール',
        '',
        '## 運用',
        '- 監視の設定',
        '- 鍵のローテーション %sec',
        '',
    ].join('\n');
}
const CROSS_VIEW = crossDoc(null);
const CROSS_EDIT = crossDoc(['mode: edit']);
const SEC = 'sec';
const SEC_LABEL = 'セキュリティレビュー';
const CROSS_TEXTS: Record<number, string> = { 3: 'カード入力フォーム', 7: '決済API', 11: '監視の設定', 12: '鍵のローテーション' };
const CROSS_NODES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const KEY_ROTATION = 12;

// 閉じる文書。a は Design とその子 2 つ、b は Design の子の API だけ (a の枠の内側の 1 つのメンバーの枠)、c は boundary: false で Leaf だけ。
// ノードは Root 1、Design 2、Screen 3、API 4、Build 5、Leaf 6
function foldDoc(editor: string[] | null): string {
    const lines = ['---', 'markdag:'];
    if (editor) lines.push('    editor:', ...editor.map((line) => `        ${line}`));
    lines.push(
        '    groups:',
        '        a:',
        '            label: 設計チーム',
        '            color: "#3B7DD8"',
        '            boundary: true',
        '        b:',
        '            label: API担当',
        '            color: "#E8833A"',
        '            boundary: true',
        '        c:',
        '            label: 一人だけ',
        '            color: "#2E9E6B"',
        '            boundary: false',
        '---',
    );
    return [...lines, '', '# Root', '', '## Design %a', '', '- Screen %a', '- API %a %b', '', '## Build', '', '- Leaf %c', ''].join('\n');
}
const FOLD_NODES = [1, 2, 3, 4, 5, 6];
const DESIGN = 2;
const SCREEN = 3;
const API = 4;
const LEAF = 6;

// 帯と相手の間 (1 つのノードとグループは 20px)。小数の丸めの分 0.5px の余裕を見る
const BAR_GAP = 20 - 0.5;
// 位置の比べの許容 (px)
const TOLERANCE = 0.5;

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

type Surface = 'render' | 'editor';
const SURFACES: Array<[Surface, string]> = [
    ['render', '閲覧の図 (render)'],
    ['editor', 'GUI 編集 (mountEditor の mode: edit)'],
];

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

// render の閲覧の図か、GUI 編集の図を #a に描き、図の倍率を 1 にする
async function show(page: Page, surface: Surface, markdown: string): Promise<void> {
    await page.evaluate(
        ({ surface, markdown }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            if (surface === 'render') target.diagram = target.editorHarness.core.render(container, markdown, { animate: false });
            else {
                const options: EditorOptions = { animate: false };
                target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
            }
        },
        { surface, markdown },
    );
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await zoomToOne(page);
}

// 図の倍率を 1 にする (図の領域の中心のまわりで縮める)。全体表示の倍率では、GUI 編集の右上の凡例のパネルが右上の枠を覆うことがあるため
async function zoomToOne(page: Page): Promise<void> {
    await settle(page);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        const view = target.editors.a?.view ?? target.diagram?.view;
        const container = document.getElementById('a');
        if (!view || !container) throw new Error('#a の図がない');
        view.zoomBy(1 / view.getTransform().k, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
    });
    const scale = (): Promise<number | undefined> =>
        page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            return (target.editors.a?.view ?? target.diagram?.view)?.getTransform().k;
        });
    await expect.poll(scale).toBeCloseTo(1, 3);
    await settle(page);
}

// 描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

async function setFolded(page: Page, ids: number[]): Promise<void> {
    await page.evaluate((ids) => {
        const target = window as unknown as EditorWindow;
        const view = target.editors.a?.view ?? target.diagram?.view;
        if (!view) throw new Error('#a の図がない');
        view.setFolded(ids);
    }, ids);
    await settle(page);
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const getSelection = (page: Page): Promise<EditSelection | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() as EditSelection | undefined);

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const frameSelector = (group: string): string => `#a .mdag-frame[data-group="${group}"]`;
const frameLabelSelector = (group: string): string => `#a .mdag-frame-label[data-group="${group}"]`;

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

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

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

const pressBlank = async (page: Page): Promise<void> => press(page, await spot(page, { on: 'blank' }));

// グループの index 番目 (描いた順) の枠の内側 (ノードと線のない所) と、ラベルの押せる点
const framePoint = (page: Page, group: string, index: number): Promise<Point> => spot(page, { on: 'element', selector: frameSelector(group), index });
const labelPoint = (page: Page, group: string, index: number): Promise<Point> => spot(page, { on: 'element', selector: frameLabelSelector(group), index });

interface FrameInfo {
    // 枠の矩形 (rect.mdag-frame)
    box: Box;
    // ラベルの矩形 (text.mdag-frame-label)
    label: Box;
    labelText: string;
    // 箱が枠の矩形に収まるノード (昇順)
    members: number[];
}

interface Drawn {
    // グループの枠 (描いた順。枠とラベルは同じ順で描かれる)
    frames: FrameInfo[];
    // ラベルの要素の数 (枠と同じ数のはず)
    labelCount: number;
    // 見えているノードの箱
    boxes: Record<number, Box>;
}

// 図に描いた group の枠とラベルと、見えているノードの箱
async function drawnOf(page: Page, group: string, ids: number[]): Promise<Drawn> {
    return page.evaluate(
        ({ group, ids }) => {
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            const boxOf = (rect: DOMRect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
            const boxes: Record<number, { left: number; top: number; right: number; bottom: number }> = {};
            for (const id of ids) {
                const element = container.querySelector(`.mdag-node[data-id="${id}"] .mdag-box`);
                const rect = element?.getBoundingClientRect();
                if (element && rect && element.checkVisibility() && rect.width > 0 && rect.height > 0) boxes[id] = boxOf(rect);
            }
            const shapes = [...container.querySelectorAll(`.mdag-frame[data-group="${group}"]`)];
            const labels = [...container.querySelectorAll(`.mdag-frame-label[data-group="${group}"]`)];
            const frames = shapes.map((shape, index) => {
                const box = boxOf(shape.getBoundingClientRect());
                const label = labels[index];
                const members = Object.entries(boxes)
                    .filter(([, inner]) => inner.left >= box.left - 0.5 && inner.top >= box.top - 0.5 && inner.right <= box.right + 0.5 && inner.bottom <= box.bottom + 0.5)
                    .map(([id]) => Number(id))
                    .sort((a, b) => a - b);
                return { box, label: label ? boxOf(label.getBoundingClientRect()) : { left: 0, top: 0, right: 0, bottom: 0 }, labelText: (label?.textContent ?? '').trim(), members };
            });
            return { frames, labelCount: labels.length, boxes };
        },
        { group, ids },
    );
}

// 枠とラベルの行を合わせた矩形 (ラベルは枠の上の辺の上にある)
const areaOf = (frame: FrameInfo): Box => ({
    left: Math.min(frame.box.left, frame.label.left),
    top: Math.min(frame.box.top, frame.label.top),
    right: Math.max(frame.box.right, frame.label.right),
    bottom: frame.box.bottom,
});

// 2 つの矩形が許容を超えて重なる
const overlaps = (a: Box, b: Box): boolean => Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE;

const contains = (outer: Box, inner: Box): boolean =>
    inner.left >= outer.left - TOLERANCE && inner.top >= outer.top - TOLERANCE && inner.right <= outer.right + TOLERANCE && inner.bottom <= outer.bottom + TOLERANCE;

function union(boxes: Box[]): Box {
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        top: Math.min(...boxes.map((box) => box.top)),
        right: Math.max(...boxes.map((box) => box.right)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

// 枠とメンバーの箱の全体の間の余白 (四辺)
function marginsOf(frame: FrameInfo, boxes: Record<number, Box>): [number, number, number, number] {
    const inner = union(frame.members.map((id) => boxes[id] as Box));
    return [inner.left - frame.box.left, inner.top - frame.box.top, frame.box.right - inner.right, frame.box.bottom - inner.bottom];
}

// ラベルの置き方 (枠の左の辺からラベルの左の端まで、ラベルの下の端から枠の上の辺まで)
const labelOffsetOf = (frame: FrameInfo): [number, number] => [frame.label.left - frame.box.left, frame.box.top - frame.label.bottom];

const close = (a: number[], b: number[]): boolean => a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= TOLERANCE);

interface BarInfo {
    for: string | null;
    rect: Box;
}

// 見えている操作の帯
async function barsOf(page: Page): Promise<BarInfo[]> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        return [...container.querySelectorAll('.mdag-editor-bar')]
            .filter((bar) => bar.checkVisibility())
            .map((bar) => {
                const rect = bar.getBoundingClientRect();
                return { for: bar.getAttribute('data-for'), rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
            });
    });
}

interface BarAtFrame {
    bars: Array<string | null>;
    // 帯がいちばん近くで上か下に付いている枠の番号 (描いた順)。どの枠の上にも下にもなければ null
    frame: number | null;
    // その枠との間が 20px 以上なら true、足りなければ測った値の文
    gap: true | string | null;
}

// 帯が 1 つ出ていれば、グループのどの枠の上か下に付いているか (グループの複数選択のテストの barAtFrame と同じ読み方)
async function barAtFrame(page: Page, group: string): Promise<BarAtFrame> {
    const shown = await barsOf(page);
    const bar = shown[0];
    if (shown.length !== 1 || !bar) return { bars: shown.map((item) => item.for), frame: null, gap: null };
    const { frames } = await drawnOf(page, group, []);
    let best: { frame: number; gap: number } | null = null;
    for (const [index, { box }] of frames.entries()) {
        const middle = (box.left + box.right) / 2;
        if (bar.rect.left > middle || bar.rect.right < middle) continue;
        const gap = bar.rect.bottom <= box.top + 1 ? box.top - bar.rect.bottom : bar.rect.top >= box.bottom - 1 ? bar.rect.top - box.bottom : null;
        if (gap !== null && (best === null || gap < best.gap)) best = { frame: index, gap };
    }
    if (best === null) return { bars: [bar.for], frame: null, gap: null };
    return { bars: [bar.for], frame: best.frame, gap: best.gap >= BAR_GAP ? true : `間 ${round1(best.gap)}px` };
}

interface InputAtLabel {
    count: number;
    value: string | null;
    focused: boolean;
    // 入力が「ラベルの所」にあるラベルの番号 (入力の矩形がラベルの矩形と左右で重なり、入力の上下の中ほどがラベルの上下の範囲 (4px まで) にある)
    on: number[];
    // 入力の矩形と重なるラベルの番号
    touches: number[];
}

// グループの名前の入力の置き場 (グループの複数選択のテストの inputAtLabel と同じ読み方)
async function inputAtLabel(page: Page, group: string): Promise<InputAtLabel> {
    const state = await page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const fieldSelector = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
        const shown = [...container.querySelectorAll('.mdag-editor-name-input[data-for="group"]')].filter((element) => element.checkVisibility());
        const element = shown[0];
        if (shown.length !== 1 || !element) return { count: shown.length, value: null, focused: false, rect: null };
        const outer = element.getBoundingClientRect();
        const rect = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
        const field = element.matches(fieldSelector) ? element : element.querySelector(fieldSelector);
        if (!field) return { count: 1, value: null, focused: false, rect };
        const active = document.activeElement;
        const focused = active !== null && (field === active || field.contains(active));
        const value = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '');
        return { count: 1, value, focused, rect };
    });
    const { frames } = await drawnOf(page, group, []);
    const rect = state.rect;
    const on: number[] = [];
    const touches: number[] = [];
    if (rect !== null) {
        const middle = (rect.top + rect.bottom) / 2;
        for (const [index, { label }] of frames.entries()) {
            const across = rect.left < label.right && rect.right > label.left;
            if (across && middle >= label.top - 4 && middle <= label.bottom + 4) on.push(index);
            if (across && rect.top < label.bottom && rect.bottom > label.top) touches.push(index);
        }
    }
    return { count: state.count, value: state.value, focused: state.focused, on, touches };
}

// グループの名前の入力が、グループの index 番目の枠のラベルの所に 1 つ開き (ほかの枠のラベルとは重ならない)、フォーカスがあって、値が value になるまで待つ
async function expectInputAtLabel(page: Page, group: string, index: number, value: string, message?: string): Promise<void> {
    await expect.poll(() => inputAtLabel(page, group), message).toEqual({ count: 1, value, focused: true, on: [index], touches: [index] });
}

async function expectInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(() => visible(page, '#a .mdag-editor-name-input[data-for="group"]').count(), message).toBe(0);
}

// グループの帯が、グループの index 番目の枠の上か下に 20px 以上離れて付くまで待つ
async function expectBarAtFrame(page: Page, group: string, index: number, message?: string): Promise<void> {
    await expect.poll(() => barAtFrame(page, group), message).toEqual({ bars: ['group'], frame: index, gap: true });
}

// groups-cross の sec の枠のうち、鍵のローテーションを囲む枠の番号 (描いた順)
async function keyRotationFrame(page: Page): Promise<number> {
    const { frames } = await drawnOf(page, SEC, CROSS_NODES);
    const index = frames.findIndex((frame) => frame.members.includes(KEY_ROTATION));
    if (index < 0) throw new Error('鍵のローテーションを囲む枠がない');
    return index;
}

test.describe('メンバーが 1 つの所にも枠 (F-02)', () => {
    for (const [surface, name] of SURFACES) {
        test(`@editor ${name}: 離れた 1 つのメンバー (鍵のローテーション) にも、そのノードの箱を囲む枠とラベル (グループの名前) を描く。余白とラベルの置き方は 2 つのメンバーの枠と同じで、枠とラベルの行はほかのノードの箱にもほかの枠にも重ならない (F-02)`, async ({ page }) => {
            const errors = watchErrors(page);
            await open(page);
            await show(page, surface, surface === 'render' ? CROSS_VIEW : CROSS_EDIT);
            // 文書の形の確かめ (ノードの id)
            for (const [id, text] of Object.entries(CROSS_TEXTS)) await expect(page.locator(nodeSelector(Number(id)))).toContainText(text);

            // 枠は 3 つ (カード入力フォームと 3Dセキュア画面、決済APIとトークン管理、鍵のローテーション)。ラベルも 3 つで、どれもグループの名前
            await expect.poll(async () => (await drawnOf(page, SEC, CROSS_NODES)).frames.map((frame) => frame.members).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([[3, 4], [7, 8], [KEY_ROTATION]]);
            const drawn = await drawnOf(page, SEC, CROSS_NODES);
            expect(drawn.labelCount).toBe(3);
            expect(drawn.frames.map((frame) => frame.labelText)).toEqual([SEC_LABEL, SEC_LABEL, SEC_LABEL]);

            const single = drawn.frames.find((frame) => frame.members.length === 1);
            const pairs = drawn.frames.filter((frame) => frame.members.length === 2);
            if (!single) throw new Error('1 つのメンバーの枠がない');
            expect(pairs).toHaveLength(2);
            // 枠はノードの箱を囲む (四辺とも余白がある)
            const margins = marginsOf(single, drawn.boxes);
            for (const margin of margins) expect(margin, `余白 ${JSON.stringify(margins.map(round1))}`).toBeGreaterThan(1);
            // 余白とラベルの置き方は、2 つのメンバーの枠と同じ
            for (const pair of pairs) {
                expect(close(margins, marginsOf(pair, drawn.boxes)), `余白 ${JSON.stringify(margins.map(round1))} / ${JSON.stringify(marginsOf(pair, drawn.boxes).map(round1))}`).toBe(true);
                expect(close(labelOffsetOf(single), labelOffsetOf(pair)), `ラベル ${JSON.stringify(labelOffsetOf(single).map(round1))} / ${JSON.stringify(labelOffsetOf(pair).map(round1))}`).toBe(true);
            }
            // ラベルは枠の上の辺の上
            expect(single.label.bottom).toBeLessThanOrEqual(single.box.top + 1);
            // 枠とラベルの行に、メンバーでないノードの箱が重ならない (上の監視の設定も)
            const area = areaOf(single);
            const intruders = CROSS_NODES.filter((id) => id !== KEY_ROTATION && drawn.boxes[id] !== undefined && overlaps(area, drawn.boxes[id] as Box));
            expect(intruders).toEqual([]);
            // 3 つの枠は、ラベルの行ごと互いに重ならない (メンバーが交わらない)
            for (const [index, frame] of drawn.frames.entries()) {
                for (const other of drawn.frames.slice(index + 1)) expect(overlaps(areaOf(frame), areaOf(other)), `${JSON.stringify(frame.members)} と ${JSON.stringify(other.members)}`).toBe(false);
            }
            expect(errors).toEqual([]);
        });
    }

    test('@editor GUI 編集: 1 つのメンバーの枠のラベルを押すとグループが選ばれ、帯がその枠の上か下に出る (間 20px)。Enter で名前の入力がその枠のラベルの所に開く。ラベルか枠の内側をダブルクリックしても同じ。原文は変わらない (F-02、F-10 と同じ読み方)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await show(page, 'editor', CROSS_EDIT);
        await useSelectTool(page);
        const index = await keyRotationFrame(page);

        await press(page, await labelPoint(page, SEC, index));
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: SEC });
        await expectBarAtFrame(page, SEC, index, 'ラベルを押す');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, SEC, index, SEC_LABEL, 'Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, 'Enter のあとの Esc');

        // ダブルクリックの 1 回目で帯が出るので、ラベルの点は帯が出ている間に選び直す
        const label = await labelPoint(page, SEC, index);
        await pressBlank(page);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'none' });
        await page.mouse.dblclick(label.x, label.y);
        await expectInputAtLabel(page, SEC, index, SEC_LABEL, 'ラベルのダブルクリック');
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: SEC });
        await page.keyboard.press('Escape');
        await expectInputClosed(page, 'ラベルのダブルクリックのあとの Esc');
        await pressBlank(page);

        const inside = await framePoint(page, SEC, index);
        await page.mouse.dblclick(inside.x, inside.y);
        await expectInputAtLabel(page, SEC, index, SEC_LABEL, '枠の内側のダブルクリック');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '枠の内側のダブルクリックのあとの Esc');
        await settle(page);
        expect(await getSource(page)).toBe(CROSS_EDIT);
        expect(errors).toEqual([]);
    });

    for (const [surface, name] of SURFACES) {
        test(`@editor ${name}: 閉じて見えているメンバーが 1 つになった所にも枠を描き、見えているメンバーが 0 の所には描かない。外側の枠の中の 1 つのメンバーの枠は、ラベルの行ごと外側の枠に収まる。boundary: false のグループは 1 つでも描かない。開き直すと戻る (F-02)`, async ({ page }) => {
            const errors = watchErrors(page);
            await open(page);
            await show(page, surface, foldDoc(surface === 'render' ? null : ['mode: edit']));
            await expect(page.locator(nodeSelector(API))).toContainText('API');
            await expect(page.locator(nodeSelector(LEAF))).toContainText('Leaf');

            const opened = async (message: string): Promise<void> => {
                await expect.poll(async () => (await drawnOf(page, 'a', FOLD_NODES)).frames.map((frame) => frame.members), message).toEqual([[DESIGN, SCREEN, API]]);
                await expect.poll(async () => (await drawnOf(page, 'b', FOLD_NODES)).frames.map((frame) => frame.members), message).toEqual([[API]]);
                await expect(page.locator(frameSelector('c')), message).toHaveCount(0);
                const outer = (await drawnOf(page, 'a', FOLD_NODES)).frames[0];
                const inner = (await drawnOf(page, 'b', FOLD_NODES)).frames[0];
                if (!outer || !inner) throw new Error('枠がない');
                expect(inner.labelText, message).toBe('API担当');
                expect(contains(outer.box, areaOf(inner)), `${message}: b の枠がラベルの行ごと a の枠に収まる`).toBe(true);
            };
            await opened('開いているとき');

            // Design を閉じると、a の見えているメンバーは Design だけで、その枠を描く。b (API だけ) は見えているメンバーが 0 で枠なし
            await setFolded(page, [DESIGN]);
            await expect.poll(async () => (await drawnOf(page, 'a', FOLD_NODES)).frames.map((frame) => frame.members)).toEqual([[DESIGN]]);
            await expect(page.locator(frameSelector('b'))).toHaveCount(0);
            await expect(page.locator(frameLabelSelector('b'))).toHaveCount(0);
            await expect(page.locator(frameSelector('c'))).toHaveCount(0);
            const drawn = await drawnOf(page, 'a', FOLD_NODES);
            const folded = drawn.frames[0];
            if (!folded) throw new Error('a の枠がない');
            expect(folded.labelText).toBe('設計チーム');
            expect(folded.label.bottom).toBeLessThanOrEqual(folded.box.top + 1);
            const intruders = FOLD_NODES.filter((id) => id !== DESIGN && drawn.boxes[id] !== undefined && overlaps(areaOf(folded), drawn.boxes[id] as Box));
            expect(intruders).toEqual([]);

            await setFolded(page, []);
            await opened('開き直したあと');
            expect(errors).toEqual([]);
        });
    }
});

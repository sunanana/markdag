// GUI 編集で依頼者が図を触って出した指摘のうち、グループの複数選択と、離れたグループで押した枠に名前の入力と帯を出すことを、
// ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 2 つ以上のグループの選択の値、ノードとグループの種類を混ぜない、凡例の行は修飾キーを見ない、2 つ以上のときの Enter と Esc と閲覧、
// 押した枠を覚える間と落とし方。2 つ以上のグループを選んだときの帯 (「グループ 2 個を選択 / グループ解除」) は出さない (依頼者が断った)。
// 帯は { group } の重ね置きで置き、出口を使わない図は変えない。
// 見た目そのもの (色、薄さの値) は見ない。強調は、ノードの data-faded と、枠 (.mdag-frame) と線 (path.mdag-edge) の算出した opacity が 1 より小さいか
// (薄くしたか) で読む。置き場は、帯と枠の辺の間、名前の入力と枠のラベルの矩形の重なりで読む。
// 反映は expect.poll で待ち、「変わらない」「出ない」「開かない」は描画の数コマと 200ms を待ってから見る
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EdgeTarget, EditOp, EditOutcome, EditSelection, MarkdagDiagram, NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

// 編集の層の選択。2 つ以上のグループは { kind: 'groups', ids } (選んだ順)。markdag/core の EditSelection には足さない (2 つ以上のグループの選択は編集の層だけが持つ)
type Selected = EditSelection | { kind: 'groups'; ids: string[] };

interface ChangeEntry {
    root: string;
    markdown: string;
}

interface SelectionEntry {
    root: string;
    selection: Selected;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // render で描いた閲覧の図
    diagram?: MarkdagDiagram;
    // onChange に届いた原文 (呼ばれた順)
    changes: ChangeEntry[];
    // onSelectionChange に届いた選択 (呼ばれた順)
    selections: SelectionEntry[];
    // render の図のフック beforeSelectGroup と onSelectGroup の呼ばれ方 (呼ばれた順)
    hookLog: string[];
};

const DIST = resolve('dist');

// ノードの複数選択と同じ修飾キー。Ctrl は macOS 以外だけ (macOS の Ctrl +クリックは副ボタンのクリック)
const MODIFIERS: readonly string[] = process.platform === 'darwin' ? ['Shift', 'Meta'] : ['Shift', 'Meta', 'Control'];

// markdag の下に groups と editor を書いた文書。groups の行は groups の下の字下げ (8 桁) からの相対。editor を省くと閲覧だけ
function docWith(body: string[], groups: string[], editor: string[] | null): string {
    const lines = ['---', 'markdag:', '    edgeHighlight: true'];
    if (groups.length > 0) lines.push('    groups:', ...groups.map((line) => `        ${line}`));
    if (editor) lines.push('    editor:', ...editor.map((line) => `        ${line}`));
    return [...lines, '---', '', ...body].join('\n');
}

function groupDef(id: string, label: string, color: string): string[] {
    return [`${id}:`, `    label: ${label}`, `    color: "${color}"`, '    boundary: true'];
}

const EDIT = ['mode: edit'];
const SWITCH_EDIT = ['mode: switch', 'default: edit'];

// グループが 3 つの文書。ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6、Ops 7、Run 8、Watch 9。
// Design と配下がグループ design (設計)、Build と配下が build (実装)、Ops と配下が ops (運用) の枠に入る。ルートはどのグループにも入らない
const BODY3 = ['# Root', '', '## Design %design', '', '- Task A', '- Task B', '', '## Build %build', '', '- Leaf', '', '## Ops %ops', '', '- Run', '- Watch', ''];
const GROUPS3 = [...groupDef('design', '設計', '#3B7DD8'), ...groupDef('build', '実装', '#E8833A'), ...groupDef('ops', '運用', '#2E9E6B')];
const DOC3 = docWith(BODY3, GROUPS3, EDIT);
const DOC3_SWITCH = docWith(BODY3, GROUPS3, SWITCH_EDIT);
const DOC3_VIEW = docWith(BODY3, GROUPS3, null);
const DOC3_VIEW_ONLY = docWith(BODY3, GROUPS3, ['mode: view']);
const TASK_A = 3;
const LEAF = 6;
const RUN = 8;
const ALL_NODES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const REF_TEXTS: Record<number, string> = { 1: 'Root', 2: 'Design', 3: 'Task A', 4: 'Task B', 5: 'Build', 6: 'Leaf', 7: 'Ops', 8: 'Run', 9: 'Watch' };
const GROUP_LABELS: Record<string, string> = { design: '設計', build: '実装', ops: '運用' };
const GROUP_MEMBERS: Record<string, number[]> = { design: [2, 3, 4], build: [5, 6], ops: [7, 8, 9] };
const GROUP_IDS = ['design', 'build', 'ops'];
// 図の線 (木の線だけ。始点と終点)
const TREE_EDGES: Array<[number, number]> = [
    [1, 2],
    [2, 3],
    [2, 4],
    [1, 5],
    [5, 6],
    [1, 7],
    [7, 8],
    [7, 9],
];
// どのグループのメンバーでもない線 (ルートから Ops へ)。2 つ以上を選んでいるときに押す線
const ROOT_TO_OPS: EdgeTarget = { kind: 'tree', source: 1, target: 7 };

// 離れたグループの文書。グループ sec のメンバーは Design の子 2 つと Build の子 2 つで、つながっていないので枠が 2 つ描かれる (描いた順で Task A と Task B の枠が最初)。
// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf A 6、Leaf B 7
const BODY_SPLIT = ['# Root', '', '## Design', '', '- Task A %sec', '- Task B %sec', '', '## Build', '', '- Leaf A %sec', '- Leaf B %sec', ''];
const SEC_LABEL = 'セキュリティ';
const DOC_SPLIT = docWith(BODY_SPLIT, groupDef('sec', SEC_LABEL, '#D64545'), EDIT);
// Leaf A と Leaf B を sec から外した文書 (枠は Task A と Task B の 1 つだけ。ノードの id と refText は DOC_SPLIT と同じ)
const DOC_SPLIT_ONE_FRAME = docWith(
    BODY_SPLIT.map((line) => (line.startsWith('- Leaf') ? line.replace(' %sec', '') : line)),
    groupDef('sec', SEC_LABEL, '#D64545'),
    EDIT,
);
// グループのない同じ本文 (⌘G で 4 つをまとめると、枠が 2 つのグループができる)
const DOC_PLAIN = docWith(
    BODY_SPLIT.map((line) => line.replace(' %sec', '')),
    [],
    EDIT,
);
const SPLIT_MEMBERS: NodeTarget[] = [
    { id: 3, refText: 'Task A' },
    { id: 4, refText: 'Task B' },
    { id: 6, refText: 'Leaf A' },
    { id: 7, refText: 'Leaf B' },
];

// 帯と相手の間 (1 つのノードとグループは 20px)。小数の丸めの分 0.5px の余裕を見る
const BAR_GAP = 20 - 0.5;

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
        target.selections = [];
        target.hookLog = [];
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
            onSelectionChange: (selection) => {
                target.selections.push({ root: 'a', selection: JSON.parse(JSON.stringify(selection)) as Selected });
            },
        };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await zoomToOne(page);
}

// 図を片付けて、同じページで描き直す。onChange と onSelectionChange の記録も空にする
async function remount(page: Page, markdown: string): Promise<void> {
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors.a?.destroy();
        delete target.editors.a;
        target.changes = [];
        target.selections = [];
    });
    await mount(page, markdown);
}

// render の閲覧の図 (出口を使わない図) を描く。フックの beforeSelectGroup と onSelectGroup の呼ばれ方を hookLog に残す
async function renderView(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        target.hookLog = [];
        const note = (context: { event: string; byUser: boolean; group: { id: string } | null }): void => {
            target.hookLog.push(`${context.event}:${context.group?.id ?? 'none'}:${String(context.byUser)}`);
        };
        target.diagram = target.editorHarness.core.render(container, markdown, {
            animate: false,
            hooks: {
                beforeSelectGroup: (context) => {
                    note(context);
                },
                onSelectGroup: (context) => {
                    note(context);
                },
            },
        });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await zoomToOne(page);
}

// 図の倍率を 1 にする (図の領域の中心のまわりで縮める。全体表示は図の全体を中心に置くので、縮めても中ほどに残る)。
// 全体表示の倍率 (この文書では上限の 2 倍) では、右上の凡例のパネルが右上のノードと枠を覆って押せないため
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

// 「変わらない」「出ない」「開かない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const changeLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).changes.map((entry) => entry.markdown));

const selectionLog = (page: Page): Promise<Selected[]> => page.evaluate(() => (window as unknown as EditorWindow).selections.map((entry) => entry.selection));

const hookLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).hookLog);

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const getSelection = async (page: Page): Promise<Selected | undefined> => {
    const selection = await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSelection() as Selected | undefined);
    return selection === undefined ? undefined : normalized(selection);
};

const setMode = (page: Page, mode: 'view' | 'edit'): Promise<boolean> => page.evaluate((mode) => (window as unknown as EditorWindow).editors.a?.setMode(mode) ?? false, mode);

const setSource = async (page: Page, markdown: string): Promise<void> => {
    await page.evaluate((markdown) => void (window as unknown as EditorWindow).editors.a?.setSource(markdown), markdown);
};

const tryEdit = (page: Page, source: string, op: EditOp): Promise<EditOutcome> =>
    page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });

const editedSource = (outcome: EditOutcome): string | null => (outcome.status === 'edited' ? outcome.source : null);

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const bars = (page: Page) => visible(page, '#a .mdag-editor-bar');
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const frameSelector = (group: string): string => `#a .mdag-frame[data-group="${group}"]`;
const frameLabelSelector = (group: string): string => `#a .mdag-frame-label[data-group="${group}"]`;
const PANEL = '#a .mdag-editor-legend';
const groupRowSelector = (group: string): string => `${PANEL} .mdag-editor-legend-row[data-group="${group}"]`;
// 凡例の行の中の名前でない所 (色の四角、数、操作ボタン)
const ROW_PARTS = '.mdag-editor-legend-chip, .mdag-editor-legend-count, .mdag-editor-legend-action';

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

// 線を押す帯 (.mdag-edge-hit) が表に出ている点 (線の中ほどから試す)
async function edgeSpot(page: Page, key: string): Promise<Point> {
    const found = await page.evaluate((key) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const hit = document.querySelector<SVGGeometryElement>(`#a .mdag-edge-hit[data-key="${key}"]`);
        const matrix = hit?.getScreenCTM();
        if (!hit || !matrix) return null;
        const length = hit.getTotalLength();
        const steps = Array.from({ length: 49 }, (_, index) => index + 1).sort((a, b) => Math.abs(a - 25) - Math.abs(b - 25));
        for (const step of steps) {
            const at = hit.getPointAtLength((length * step) / 50);
            const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
            if (inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === hit) return { x: point.x, y: point.y };
        }
        return null;
    }, key);
    if (!found) throw new Error(`線 ${key} の帯の上の点がない`);
    return found;
}

// 凡例の行の名前の文字の上の点 (色の四角、数、操作ボタンの上は除く)
async function rowNamePoint(page: Page, group: string, label: string): Promise<Point> {
    const found = await page.evaluate(
        ({ selector, label, parts }) => {
            const row = [...document.querySelectorAll(selector)].find((item) => item.checkVisibility());
            if (!row) return null;
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
                if (!(text.textContent ?? '').includes(label) || text.parentElement?.closest(parts)) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                for (const rect of range.getClientRects()) {
                    for (const fy of [0.5, 0.3, 0.7]) {
                        for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
                            const x = rect.left + rect.width * fx;
                            const y = rect.top + rect.height * fy;
                            const hit = document.elementFromPoint(x, y);
                            if (hit && row.contains(hit) && !hit.closest(parts)) return { x, y };
                        }
                    }
                }
            }
            return null;
        },
        { selector: groupRowSelector(group), label, parts: ROW_PARTS },
    );
    if (!found) throw new Error(`グループ ${group} の行に名前「${label}」を押せる点がない`);
    return found;
}

// modifier を押したまま点を押す (null なら修飾キーなし)
async function press(page: Page, point: Point, modifier: string | null = null): Promise<void> {
    await page.mouse.move(point.x, point.y);
    if (modifier !== null) await page.keyboard.down(modifier);
    try {
        await page.mouse.down();
        await page.mouse.up();
    } finally {
        if (modifier !== null) await page.keyboard.up(modifier);
    }
}

const pressNode = async (page: Page, id: number, modifier: string | null = null): Promise<void> =>
    press(page, await spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` }), modifier);

const pressBlank = async (page: Page): Promise<void> => press(page, await spot(page, { on: 'blank' }));

// グループの index 番目 (描いた順) の枠の内側 (ノードと線のない所) を押す
const framePoint = (page: Page, group: string, index = 0): Promise<Point> => spot(page, { on: 'element', selector: frameSelector(group), index });
const pressFrame = async (page: Page, group: string, modifier: string | null = null, index = 0): Promise<void> => press(page, await framePoint(page, group, index), modifier);

// グループの index 番目の枠のラベルを押す (帯などが重なっている所は除く)
const labelPoint = (page: Page, group: string, index = 0): Promise<Point> => spot(page, { on: 'element', selector: frameLabelSelector(group), index });
const pressFrameLabel = async (page: Page, group: string, modifier: string | null = null, index = 0): Promise<void> => press(page, await labelPoint(page, group, index), modifier);

const pressEdge = async (page: Page, edge: EdgeTarget): Promise<void> => press(page, await edgeSpot(page, `${edge.kind}:${edge.source}>${edge.target}`));

const pressRow = async (page: Page, group: string, modifier: string | null = null): Promise<void> => press(page, await rowNamePoint(page, group, GROUP_LABELS[group] ?? group), modifier);

// 帯のボタンを押す
async function pressBar(page: Page, command: string): Promise<void> {
    const selector = `#a .mdag-editor-bar-button[data-command="${command}"]`;
    await expect(visible(page, selector)).toHaveCount(1);
    await expect(visible(page, selector)).toBeEnabled();
    await press(page, await spot(page, { on: 'element', selector }));
}

const nodeTarget = (id: number): NodeTarget => ({ id, refText: REF_TEXTS[id] ?? '' });

// 選択をそろえた形 (ノードは id の昇順。グループの並びは選んだ順のまま)
function normalized(selection: Selected): Selected {
    if (selection.kind === 'nodes') return { kind: 'nodes', nodes: [...selection.nodes].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, refText: item.refText })) };
    if (selection.kind === 'groups') return { kind: 'groups', ids: [...selection.ids] };
    return selection;
}

// グループの選択の値 (0 はなし、1 つは { kind: 'group' }、2 つ以上は { kind: 'groups' })
function groupsValue(ids: string[]): Selected {
    if (ids.length === 0) return { kind: 'none' };
    if (ids.length === 1) return { kind: 'group', id: ids[0] ?? '' };
    return { kind: 'groups', ids };
}

const lastSelectionChange = async (page: Page): Promise<Selected | null> => {
    const last = (await selectionLog(page)).at(-1);
    return last === undefined ? null : normalized(last);
};

interface Look {
    // data-selected の付いたノード (昇順)
    marked: number[];
    // 強調から外れたノード (data-faded。昇順)
    fadedNodes: number[];
    // 薄くした枠のグループ (算出した opacity が 1 より小さい .mdag-frame。名前の昇順、重複なし)
    fadedFrames: string[];
    // 薄くした線 (算出した opacity が 1 より小さい path.mdag-edge。キーの昇順)
    fadedEdges: string[];
    // 図の要素の線の強調の目印
    edgeSelected: boolean;
}

// 図の強調の今の形
async function lookOf(page: Page): Promise<Look> {
    return page.evaluate(() => {
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const faded = (element: Element): boolean => parseFloat(getComputedStyle(element).opacity) < 0.99;
        const ids = (selector: string): number[] => [...container.querySelectorAll(selector)].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b);
        return {
            marked: ids('.mdag-node[data-selected]'),
            fadedNodes: ids('.mdag-node[data-faded]'),
            fadedFrames: [...new Set([...container.querySelectorAll('.mdag-frame[data-group]')].filter(faded).map((element) => element.getAttribute('data-group') ?? ''))].sort(),
            fadedEdges: [...container.querySelectorAll('path.mdag-edge[data-key]')]
                .filter(faded)
                .map((element) => element.getAttribute('data-key') ?? '')
                .sort(),
            edgeSelected: container.hasAttribute('data-edge-selected'),
        };
    });
}

// グループが 3 つの文書で、groups を選んで強調しているときの形: どれかのグループのメンバーと、そこに出入りする線と、その線の反対側のノードは残し、
// 選んでいないグループの枠と、どの選んだグループにもつながらないノードと線だけを薄くする。選んでいなければ何も薄くしない
function groupsLook(groups: string[]): Look {
    if (groups.length === 0) return { marked: [], fadedNodes: [], fadedFrames: [], fadedEdges: [], edgeSelected: false };
    const members = new Set(groups.flatMap((group) => GROUP_MEMBERS[group] ?? []));
    const kept = new Set(members);
    const fadedEdges: string[] = [];
    for (const [source, target] of TREE_EDGES) {
        if (members.has(source) || members.has(target)) {
            kept.add(source);
            kept.add(target);
        } else fadedEdges.push(`tree:${source}>${target}`);
    }
    return {
        marked: [],
        fadedNodes: ALL_NODES.filter((id) => !kept.has(id)),
        fadedFrames: GROUP_IDS.filter((group) => !groups.includes(group)).sort(),
        fadedEdges: fadedEdges.sort(),
        edgeSelected: false,
    };
}

interface GroupRowState {
    id: string;
    selected: boolean;
}

// 凡例のパネルのグループの段の見えている行と、選んだ地 (data-selected)
async function groupRowsOf(page: Page): Promise<GroupRowState[]> {
    return page.evaluate((panelSelector) => {
        const panel = [...document.querySelectorAll(panelSelector)].find((item) => item.checkVisibility());
        if (!panel) return [];
        return [...panel.querySelectorAll('.mdag-editor-legend-row[data-group]')]
            .filter((row) => row.checkVisibility())
            .map((row) => ({ id: row.getAttribute('data-group') ?? '', selected: row.hasAttribute('data-selected') && row.getAttribute('data-selected') !== 'false' }));
    }, PANEL);
}

const selectedRows = async (page: Page): Promise<string[]> => (await groupRowsOf(page)).filter((row) => row.selected).map((row) => row.id);

// グループが 3 つの文書で、選んでいるグループが ids (選んだ順) になるまで待つ: getSelection、図の強調 (ノードの印はなく、groupsLook の形)、凡例のパネルの選んだ行
async function expectGroups(page: Page, ids: string[], message?: string): Promise<void> {
    await expect
        .poll(async () => ({ selection: await getSelection(page), look: await lookOf(page), rows: (await selectedRows(page)).sort() }), message)
        .toEqual({ selection: groupsValue(ids), look: groupsLook(ids), rows: [...ids].sort() });
}

// 選んでいるノードが ids になるまで待つ (図の印、getSelection、グループの強調なし)
async function expectNodes(page: Page, ids: number[], message?: string): Promise<void> {
    const nodes = ids.map(nodeTarget).sort((a, b) => a.id - b.id);
    await expect
        .poll(async () => {
            const look = await lookOf(page);
            return { selection: await getSelection(page), marked: look.marked, fadedNodes: look.fadedNodes, fadedFrames: look.fadedFrames, rows: await selectedRows(page) };
        }, message)
        .toEqual({ selection: nodes.length === 0 ? { kind: 'none' } : { kind: 'nodes', nodes }, marked: nodes.map((node) => node.id), fadedNodes: [], fadedFrames: [], rows: [] });
}

// 線が選ばれるまで待つ (getSelection が線、図の要素に data-edge-selected、ノードの印も凡例の選んだ行もない、枠は薄くしない)
async function expectEdge(page: Page, edge: EdgeTarget, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const look = await lookOf(page);
            return { selection: await getSelection(page), marked: look.marked, edgeSelected: look.edgeSelected, rows: await selectedRows(page) };
        }, message)
        .toEqual({ selection: { kind: 'edge', edge }, marked: [], edgeSelected: true, rows: [] });
}

interface BarInfo {
    for: string | null;
    title: string;
    items: string[];
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
                const items = [...bar.querySelectorAll('.mdag-editor-bar-title, .mdag-editor-bar-button')].filter((item) => item.checkVisibility());
                const rect = bar.getBoundingClientRect();
                return {
                    for: bar.getAttribute('data-for'),
                    title: items
                        .filter((item) => item.classList.contains('mdag-editor-bar-title'))
                        .map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim())
                        .join(' '),
                    items: items.map((item) => (item.classList.contains('mdag-editor-bar-title') ? 'title' : (item.getAttribute('data-command') ?? ''))),
                    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
                };
            });
    });
}

// 帯が出ていない (数コマ待ってから)
async function expectNoBar(page: Page, message?: string): Promise<void> {
    await settle(page);
    await expect(bars(page), message).toHaveCount(0);
}

// グループの帯が 1 つ見えていて、中身が 名前の欄、名前、グループ解除、名前の欄に label が入るまで待つ
async function expectGroupBar(page: Page, label: string, message?: string): Promise<void> {
    await expect
        .poll(async () => {
            const shown = await barsOf(page);
            const bar = shown[0];
            if (shown.length !== 1 || !bar) return { count: shown.length };
            return { count: 1, for: bar.for, items: bar.items, titled: bar.title.includes(label) };
        }, message)
        .toEqual({ count: 1, for: 'group', items: ['title', 'rename-group', 'ungroup'], titled: true });
}

// グループのすべての枠の矩形 (描いた順。要素の矩形を読む)
async function frameBoxesOf(page: Page, group: string): Promise<Box[]> {
    return page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)].map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
    }, frameSelector(group));
}

// グループのすべての枠のラベルの矩形 (描いた順)。名前の入力を重ねている間も、ラベルの要素の矩形を読む (見え方によらない)
async function labelBoxesOf(page: Page, group: string): Promise<Box[]> {
    return page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)].map((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
    }, frameLabelSelector(group));
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface BarAtFrame {
    // 見えている帯の data-for
    bars: Array<string | null>;
    // 帯がいちばん近くで上か下に付いている枠の番号 (描いた順)。どの枠の上にも下にもなければ null
    frame: number | null;
    // その枠との間が 20px 以上なら true、足りなければ測った値の文
    gap: true | string | null;
}

// 帯が 1 つ出ていれば、グループのどの枠の上か下に付いているか。帯が枠の左右の中ほどに掛かり、帯の下の辺が枠の上の辺より上 (か帯の上の辺が枠の下の辺より下) の
// 枠のうち、間がいちばん小さいもの (帯は枠の上、入らなければ下に、間 20px で置く決まりと同じ読み方)
async function barAtFrame(page: Page, group: string): Promise<BarAtFrame> {
    const shown = await barsOf(page);
    const bar = shown[0];
    if (shown.length !== 1 || !bar) return { bars: shown.map((item) => item.for), frame: null, gap: null };
    let best: { frame: number; gap: number } | null = null;
    for (const [index, box] of (await frameBoxesOf(page, group)).entries()) {
        const middle = (box.left + box.right) / 2;
        if (bar.rect.left > middle || bar.rect.right < middle) continue;
        const gap = bar.rect.bottom <= box.top + 1 ? box.top - bar.rect.bottom : bar.rect.top >= box.bottom - 1 ? bar.rect.top - box.bottom : null;
        if (gap !== null && (best === null || gap < best.gap)) best = { frame: index, gap };
    }
    if (best === null) return { bars: [bar.for], frame: null, gap: null };
    return { bars: [bar.for], frame: best.frame, gap: best.gap >= BAR_GAP ? true : `間 ${round1(best.gap)}px` };
}

// グループの帯が、グループの index 番目の枠の上か下に 20px 以上離れて付くまで待つ
async function expectBarAtFrame(page: Page, group: string, index: number, message?: string): Promise<void> {
    await expect.poll(() => barAtFrame(page, group), message).toEqual({ bars: ['group'], frame: index, gap: true });
}

interface InputAtLabel {
    // 見えているグループの名前の入力 (.mdag-editor-name-input[data-for="group"]) の数
    count: number;
    value: string | null;
    focused: boolean;
    // 入力が「ラベルの所」にあるラベルの番号 (入力の矩形がラベルの矩形と左右で重なり、入力の上下の中ほどがラベルの上下の範囲 (4px まで) にある)
    on: number[];
    // 入力の矩形と重なるラベルの番号
    touches: number[];
}

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
    const labels = await labelBoxesOf(page, group);
    const rect = state.rect;
    const on: number[] = [];
    const touches: number[] = [];
    if (rect !== null) {
        const middle = (rect.top + rect.bottom) / 2;
        for (const [index, label] of labels.entries()) {
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

// グループの名前の入力が閉じるまで待つ
async function expectInputClosed(page: Page, message?: string): Promise<void> {
    await expect.poll(() => visible(page, '#a .mdag-editor-name-input[data-for="group"]').count(), message).toBe(0);
}

// 名前の入力 (ノードとグループのどちらも) が開いていない (数コマ待ってから)
async function expectNoNameInput(page: Page, message?: string): Promise<void> {
    await settle(page);
    await expect(visible(page, '#a .mdag-editor-name-input'), message).toHaveCount(0);
}

// 名前の入力の値を全部選んで text を打つ
async function replaceName(page: Page, text: string): Promise<void> {
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.type(text);
    await expect.poll(async () => (await inputAtLabel(page, 'sec')).value).toBe(text);
}

// 原文と onChange が変わらない (数コマ待ってから)
async function expectSourceStill(page: Page, source: string, changes: string[], message?: string): Promise<void> {
    await settle(page);
    expect(await getSource(page), message).toBe(source);
    expect(await changeLog(page), message).toEqual(changes);
}

test.describe('グループの複数選択 (F-01)', () => {
    test('@editor 選択の道具で、Shift / ⌘ (/ Ctrl) を押しながら枠かラベルを押すと、そのグループを選択に足す。何も選んでいなければその 1 つ、1 つ選んでいれば 2 つになり、getSelection と onSelectionChange は { kind: "groups", ids } (選んだ順)。両方の枠とメンバー、出入りする線とその反対側のノードは薄くならず、選んでいないグループの枠と、どちらにもつながらないノードと線だけが薄くなる。凡例のパネルの両方の行が選んだ地になる (F-01)', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        await open(page);
        // 空振りの防ぎ: 1 つのグループの強調の読み方は、今の図と同じ
        await mount(page, DOC3);
        await useSelectTool(page);
        await pressFrame(page, 'design');
        await expectGroups(page, ['design'], '修飾キーなしの 1 つ');

        for (const modifier of MODIFIERS) {
            // 何も選んでいないところから、枠とラベルで足す
            await remount(page, DOC3);
            await useSelectTool(page);
            await pressFrame(page, 'design', modifier);
            await expectGroups(page, ['design'], `${modifier}: 何もないところから枠を足す`);
            await expect.poll(() => lastSelectionChange(page), modifier).toEqual({ kind: 'group', id: 'design' });
            await pressFrameLabel(page, 'build', modifier);
            await expectGroups(page, ['design', 'build'], `${modifier}: ラベルで足す`);
            await expect.poll(() => lastSelectionChange(page), modifier).toEqual({ kind: 'groups', ids: ['design', 'build'] });

            // 修飾キーなしで選んだ 1 つに、枠で足す (並びは選んだ順)
            await remount(page, DOC3);
            await useSelectTool(page);
            await pressFrame(page, 'build');
            await expectGroups(page, ['build'], `${modifier}: 修飾キーなしで build`);
            await pressFrame(page, 'design', modifier);
            await expectGroups(page, ['build', 'design'], `${modifier}: 枠で足す`);
            await expect.poll(() => selectionLog(page), modifier).toEqual([
                { kind: 'group', id: 'build' },
                { kind: 'groups', ids: ['build', 'design'] },
            ]);
            await expectSourceStill(page, DOC3, [], modifier);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 修飾キーで 3 つめを足すと 3 つを選び、選んでいるグループを修飾キーで押すと外れる (3 → 2 は groups、2 → 1 は { kind: "group" }、1 → 選択なし)。onSelectionChange は変わるたびに 1 回で、最後の値が getSelection と同じ (F-01)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);
        const [first, second] = [MODIFIERS[0] ?? 'Shift', MODIFIERS[1] ?? 'Shift'];

        await pressFrame(page, 'build');
        await expectGroups(page, ['build'], '1 つ');
        await pressFrame(page, 'design', first);
        await expectGroups(page, ['build', 'design'], '2 つ');
        await pressFrameLabel(page, 'ops', second);
        await expectGroups(page, ['build', 'design', 'ops'], '3 つ');
        await pressFrameLabel(page, 'design', first);
        await expectGroups(page, ['build', 'ops'], '3 → 2');
        await pressFrame(page, 'ops', second);
        await expectGroups(page, ['build'], '2 → 1');
        await pressFrame(page, 'build', first);
        await expectGroups(page, [], '1 → なし');

        await expect.poll(() => selectionLog(page)).toEqual([
            { kind: 'group', id: 'build' },
            { kind: 'groups', ids: ['build', 'design'] },
            { kind: 'groups', ids: ['build', 'design', 'ops'] },
            { kind: 'groups', ids: ['build', 'ops'] },
            { kind: 'group', id: 'build' },
            { kind: 'none' },
        ]);
        await expectSourceStill(page, DOC3, []);
    });

    test('@editor 2 つ以上のグループを選んでいるときは帯 (コンテキストメニュー) を出さない (グループ解除のボタンもない)。修飾キーで 1 つに戻すと、残ったグループの帯 (名前の欄、名前、グループ解除) が出る (F-01)', async ({ page }) => {
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);
        const modifier = MODIFIERS[0] ?? 'Shift';

        await pressFrame(page, 'design');
        await expectGroups(page, ['design']);
        await expectGroupBar(page, '設計', '1 つ');
        await pressFrame(page, 'build', modifier);
        await expectGroups(page, ['design', 'build']);
        await expectNoBar(page, '2 つ');
        await expect(visible(page, '#a .mdag-editor-bar-button[data-command="ungroup"]'), '2 つ').toHaveCount(0);
        await pressFrameLabel(page, 'ops', modifier);
        await expectGroups(page, ['design', 'build', 'ops']);
        await expectNoBar(page, '3 つ');

        await pressFrame(page, 'design', modifier);
        await pressFrame(page, 'ops', modifier);
        await expectGroups(page, ['build']);
        await expectGroupBar(page, '実装', '1 つに戻す');
        await expectSourceStill(page, DOC3, []);
    });

    test('@editor 2 つ以上を選んでいるときに、選んでいるうちの 1 つか、選んでいないグループの枠を修飾キーなしで押すと、そのグループ 1 つの選択になり、帯が出る (F-01、5.2 の軸 C)', async ({ page }) => {
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);
        const modifier = MODIFIERS[0] ?? 'Shift';

        await pressFrame(page, 'design');
        await pressFrame(page, 'build', modifier);
        await expectGroups(page, ['design', 'build'], '2 つ');
        await pressFrame(page, 'build');
        await expectGroups(page, ['build'], '選んでいるうちの 1 つを修飾キーなしで');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'group', id: 'build' });
        await expectGroupBar(page, '実装');

        await pressFrame(page, 'design', modifier);
        await expectGroups(page, ['build', 'design'], 'もう 1 度 2 つ');
        await pressFrameLabel(page, 'ops');
        await expectGroups(page, ['ops'], '選んでいないグループのラベルを修飾キーなしで');
        await expectGroupBar(page, '運用');
        await expectSourceStill(page, DOC3, []);
    });

    test('@editor 2 つ以上を選んでいるときにノードを押すとそのノード 1 つ、修飾キー + ノードでもそのノード 1 つ (グループと混ぜない)。何もないところを押すと選択なし、線を押すとその線。どれもグループの強調と凡例の選んだ行が外れる (F-01)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);
        const modifier = MODIFIERS[0] ?? 'Shift';
        const selectTwo = async (message: string): Promise<void> => {
            await pressFrame(page, 'design');
            await pressFrame(page, 'build', modifier);
            await expectGroups(page, ['design', 'build'], message);
        };

        await selectTwo('ノードの前');
        await pressNode(page, RUN);
        await expectNodes(page, [RUN], 'ノード');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'nodes', nodes: [nodeTarget(RUN)] });
        await expect(visible(page, '#a .mdag-editor-bar[data-for="node"]'), 'ノード').toHaveCount(1);

        for (const key of MODIFIERS) {
            await selectTwo(`${key} + ノードの前`);
            await pressNode(page, TASK_A, key);
            await expectNodes(page, [TASK_A], `${key} + ノード`);
            await expect.poll(() => lastSelectionChange(page), key).toEqual({ kind: 'nodes', nodes: [nodeTarget(TASK_A)] });
        }

        await selectTwo('何もないところの前');
        await pressBlank(page);
        await expectNodes(page, [], '何もないところ');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expectNoBar(page, '何もないところ');

        await selectTwo('線の前');
        await pressEdge(page, ROOT_TO_OPS);
        await expectEdge(page, ROOT_TO_OPS, '線');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'edge', edge: ROOT_TO_OPS });
        await expectNoBar(page, '線');
        await expectSourceStill(page, DOC3, []);
        expect(errors).toEqual([]);
    });

    test('@editor 2 つ以上を選んでいるときの Esc で選択なし。Enter では名前の入力 (グループもノードも) が開かず、選択と原文は変わらない (F-01)', async ({ page }) => {
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);
        const modifier = MODIFIERS[0] ?? 'Shift';

        await pressFrame(page, 'design');
        await pressFrameLabel(page, 'ops', modifier);
        await expectGroups(page, ['design', 'ops'], 'Enter の前');
        await page.keyboard.press('Enter');
        await expectNoNameInput(page, 'Enter');
        await expectGroups(page, ['design', 'ops'], 'Enter のあと');
        await expectSourceStill(page, DOC3, [], 'Enter');

        await page.keyboard.press('Escape');
        await expectGroups(page, [], 'Esc');
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });
        await expectNoBar(page, 'Esc');
    });

    test('@editor 2 つ以上を選んでいるときに閲覧へ切り替えると (setMode)、選択が解け、強調と凡例の選んだ行が外れて onSelectionChange が呼ばれる。GUI 編集へ戻っても選択は戻らない (F-01、B-171、5.3)', async ({ page }) => {
        await open(page);
        await mount(page, DOC3_SWITCH);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('edit');
        await useSelectTool(page);
        const modifier = MODIFIERS[0] ?? 'Shift';

        await pressFrame(page, 'design');
        await pressFrame(page, 'build', modifier);
        await expectGroups(page, ['design', 'build']);

        expect(await setMode(page, 'view')).toBe(true);
        await expect.poll(async () => ({ selection: await getSelection(page), look: await lookOf(page), rows: await selectedRows(page) }), '閲覧').toEqual({ selection: { kind: 'none' }, look: groupsLook([]), rows: [] });
        await expect.poll(() => lastSelectionChange(page)).toEqual({ kind: 'none' });

        expect(await setMode(page, 'edit')).toBe(true);
        await settle(page);
        await expectGroups(page, [], 'GUI 編集へ戻る');
        await expectNoBar(page, 'GUI 編集へ戻る');
        await expectSourceStill(page, DOC3_SWITCH, []);
    });

    test('@editor ノード (1 つと 2 つ以上) か線を選んでいるときに、修飾キーを押しながら枠かラベルを押すと、それを解いてそのグループ 1 つだけを選ぶ (種類を混ぜない) (F-01)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);

        for (const modifier of MODIFIERS) {
            await pressNode(page, LEAF);
            await expectNodes(page, [LEAF], `${modifier}: ノード 1 つ`);
            await pressFrame(page, 'design', modifier);
            await expectGroups(page, ['design'], `${modifier}: ノード 1 つから枠`);
            await expect.poll(() => lastSelectionChange(page), modifier).toEqual({ kind: 'group', id: 'design' });

            await pressNode(page, TASK_A);
            await pressNode(page, RUN, modifier);
            await expectNodes(page, [TASK_A, RUN], `${modifier}: ノード 2 つ`);
            await pressFrameLabel(page, 'build', modifier);
            await expectGroups(page, ['build'], `${modifier}: ノード 2 つからラベル`);

            await pressEdge(page, ROOT_TO_OPS);
            await expectEdge(page, ROOT_TO_OPS, `${modifier}: 線`);
            await pressFrame(page, 'ops', modifier);
            await expectGroups(page, ['ops'], `${modifier}: 線から枠`);
            await pressBlank(page);
            await expectNodes(page, [], `${modifier}: 解く`);
        }
        await expectSourceStill(page, DOC3, []);
    });

    test('@editor 凡例のパネルの行の押下は修飾キーを見ない: 1 つ選んでいるときに Shift / ⌘ を押しながら別の行を押すとその 1 つに替わり、2 つ以上を選んでいるときに行を押すと (修飾キーの有無、選んでいる行かによらず) その行のグループ 1 つになる。2 つ以上のときは選んだ行が全部選んだ地 (F-01)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC3);
        await useSelectTool(page);

        for (const modifier of MODIFIERS) {
            await pressRow(page, 'design');
            await expectGroups(page, ['design'], `${modifier}: 行で 1 つ`);
            await pressRow(page, 'build', modifier);
            await expectGroups(page, ['build'], `${modifier}: 修飾キー + 別の行`);

            await pressFrame(page, 'design', modifier);
            await expectGroups(page, ['build', 'design'], `${modifier}: 2 つ`);
            await pressRow(page, 'ops', modifier);
            await expectGroups(page, ['ops'], `${modifier}: 2 つから修飾キー + 選んでいない行`);

            await pressFrame(page, 'design', modifier);
            await expectGroups(page, ['ops', 'design'], `${modifier}: もう 1 度 2 つ`);
            await pressRow(page, 'design');
            await expectGroups(page, ['design'], `${modifier}: 2 つから選んでいる行`);
            await pressBlank(page);
            await expectGroups(page, [], `${modifier}: 解く`);
        }
        await expectSourceStill(page, DOC3, []);
    });

    test('@editor 手のひらでは、修飾キーを押しながら枠かラベルを押してもグループを選ばない (今のまま。B-112)', async ({ page }) => {
        await open(page);
        await mount(page, DOC3);
        await toolButton(page, 'hand').click();
        await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'hand');

        for (const modifier of MODIFIERS) {
            await pressFrame(page, 'design', modifier);
            await pressFrameLabel(page, 'build', modifier);
        }
        await settle(page);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        expect(await lookOf(page)).toEqual(groupsLook([]));
        expect(await selectionLog(page)).toEqual([]);
        await expect(bars(page)).toHaveCount(0);
    });

    test('@editor 閲覧の図 (render、interaction: "view") では、修飾キーを押しながら枠かラベルを押しても 1 つのグループだけを強調し (別の枠で替わる)、同じ枠をもう 1 度で解く。フックの beforeSelectGroup と onSelectGroup は押すたびにそのグループで 1 回ずつ呼ばれる。mountEditor の閲覧でも、編集の層の選択は作らず 1 つだけを強調する (F-01、2.6)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);

        for (const modifier of MODIFIERS) {
            await page.evaluate(() => {
                const target = window as unknown as EditorWindow;
                target.diagram?.destroy();
                delete target.diagram;
            });
            await renderView(page, DOC3_VIEW);
            await pressFrame(page, 'design', modifier);
            await expect.poll(() => lookOf(page), `${modifier}: design`).toEqual(groupsLook(['design']));
            await pressFrameLabel(page, 'build', modifier);
            await expect.poll(() => lookOf(page), `${modifier}: build`).toEqual(groupsLook(['build']));
            await pressFrame(page, 'build', modifier);
            await expect.poll(() => lookOf(page), `${modifier}: 同じ枠で解く`).toEqual(groupsLook([]));
            await expect
                .poll(() => hookLog(page), modifier)
                .toEqual([
                    'beforeSelectGroup:design:true',
                    'onSelectGroup:design:true',
                    'beforeSelectGroup:build:true',
                    'onSelectGroup:build:true',
                    'beforeSelectGroup:none:true',
                    'onSelectGroup:none:true',
                ]);
        }
        await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            target.diagram?.destroy();
            delete target.diagram;
        });

        await mount(page, DOC3_VIEW_ONLY);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getMode())).toBe('view');
        const modifier = MODIFIERS[0] ?? 'Shift';
        await pressFrame(page, 'design', modifier);
        await expect.poll(() => lookOf(page), '閲覧の mountEditor: design').toEqual(groupsLook(['design']));
        await pressFrame(page, 'build', modifier);
        await expect.poll(() => lookOf(page), '閲覧の mountEditor: build').toEqual(groupsLook(['build']));
        await settle(page);
        expect(await getSelection(page)).toEqual({ kind: 'none' });
        expect(await selectionLog(page)).toEqual([]);
        await expect(bars(page)).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});

test.describe('押した枠に名前の入力と帯 (F-10)', () => {
    test('@editor 前提: 枠が 2 つあるグループで、2 つの枠とラベルは離れている (重ならない)', async ({ page }) => {
        await open(page);
        await mount(page, DOC_SPLIT);
        const frames = await frameBoxesOf(page, 'sec');
        const labels = await labelBoxesOf(page, 'sec');
        expect(frames).toHaveLength(2);
        expect(labels).toHaveLength(2);
        const [first, second] = labels as [Box, Box];
        expect(first.bottom < second.top || second.bottom < first.top).toBe(true);
    });

    test('@editor 枠が 2 つあるグループで、2 つめの枠のラベルか内側をダブルクリックすると、名前の入力がその枠のラベルの所に開く (最初の枠のラベルとは重ならない)。最初の枠のラベルなら最初の枠のラベルの所 (F-10)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_SPLIT);
        await useSelectTool(page);

        // ラベルの点は、グループを選んで帯が出ている間も帯に隠れない点にする (ダブルクリックの 1 回目で帯が出るため)
        await pressFrame(page, 'sec', null, 1);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'sec' });
        const second = await labelPoint(page, 'sec', 1);
        await pressBlank(page);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'none' });

        await page.mouse.dblclick(second.x, second.y);
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, '2 つめのラベルのダブルクリック');
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'sec' });
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '2 つめのラベルのあとの Esc');
        await pressBlank(page);

        const inside = await framePoint(page, 'sec', 1);
        await page.mouse.dblclick(inside.x, inside.y);
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, '2 つめの枠の内側のダブルクリック');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '2 つめの枠のあとの Esc');
        await pressBlank(page);

        await pressFrame(page, 'sec', null, 0);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'sec' });
        const first = await labelPoint(page, 'sec', 0);
        await pressBlank(page);
        await page.mouse.dblclick(first.x, first.y);
        await expectInputAtLabel(page, 'sec', 0, SEC_LABEL, '最初のラベルのダブルクリック');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '最初のラベルのあとの Esc');
        await expectSourceStill(page, DOC_SPLIT, []);
        expect(errors).toEqual([]);
    });

    test('@editor 2 つめの枠かラベルを 1 回押すと、グループの帯がその枠の上に出る (間 20px)。そのまま Enter と帯の「名前」でも、名前の入力は 2 つめの枠のラベルの所に開き、Esc で閉じると帯はまたその枠に出る (F-10)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_SPLIT);
        await useSelectTool(page);

        await pressFrame(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1, '2 つめの枠を押す');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, 'Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, 'Enter のあとの Esc');
        await expectBarAtFrame(page, 'sec', 1, 'Enter のあとの Esc');

        await pressBar(page, 'rename-group');
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, '帯の名前');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '帯の名前のあとの Esc');

        await pressBlank(page);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'none' });
        await pressFrameLabel(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1, '2 つめのラベルを押す');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, 'ラベルのあとの Enter');
        await page.keyboard.press('Escape');
        await expectSourceStill(page, DOC_SPLIT, []);
    });

    test('@editor 2 つめの枠で選んで名前を決めると、描き直したあとも帯と名前の入力は 2 つめの枠に出る。外からの差し替えでその番号の枠がなくなると、最初の枠に出る (F-10)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        const renamed = editedSource(await tryEdit(page, DOC_SPLIT, { kind: 'renameGroup', group: 'sec', label: 'セキュリティ確認' }));
        expect(renamed).not.toBeNull();
        await mount(page, DOC_SPLIT);
        await useSelectTool(page);

        await pressFrame(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1);
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL);
        await replaceName(page, 'セキュリティ確認');
        await page.keyboard.press('Enter');
        await expect.poll(() => getSource(page)).toBe(renamed);
        await expectInputClosed(page, '名前を決める');
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'sec' });
        await expectBarAtFrame(page, 'sec', 1, '名前を決めたあと');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 1, 'セキュリティ確認', '名前を決めたあとの Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '名前を決めたあとの Esc');

        await setSource(page, DOC_SPLIT_ONE_FRAME);
        await expect.poll(async () => (await frameBoxesOf(page, 'sec')).length).toBe(1);
        await expect.poll(() => getSelection(page), '差し替えのあとも選んだまま').toEqual({ kind: 'group', id: 'sec' });
        await expectBarAtFrame(page, 'sec', 0, '2 つめの枠がなくなったら最初の枠');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 0, SEC_LABEL, '差し替えのあとの Enter');
        await page.keyboard.press('Escape');
        expect(errors).toEqual([]);
    });

    test('@editor 最初の枠を押したときと、凡例のパネルの行で選んだときは、帯と名前の入力は最初の枠に出る (2 つめの枠で選んで解いたあとも) (F-10)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC_SPLIT);
        await useSelectTool(page);

        await pressFrame(page, 'sec', null, 0);
        await expectBarAtFrame(page, 'sec', 0, '最初の枠を押す');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 0, SEC_LABEL, '最初の枠の Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page);
        // 何も選んでいないところから 2 つめの枠で選ぶ (選んだまま別の枠を押す場面は別のテストで見る)
        await pressBlank(page);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'none' });

        await pressFrame(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1, '2 つめの枠を押す');
        await pressBlank(page);
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'none' });
        await press(page, await rowNamePoint(page, 'sec', SEC_LABEL));
        await expect.poll(() => getSelection(page)).toEqual({ kind: 'group', id: 'sec' });
        await expectBarAtFrame(page, 'sec', 0, '凡例の行');
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 0, SEC_LABEL, '凡例の行の Enter');
        await page.keyboard.press('Escape');
        await expectSourceStill(page, DOC_SPLIT, []);
    });

    test('@editor グループを選んでいるときに同じグループの別の枠かラベルを修飾キーなしで押すと、解かずに選んだまま押した枠に替わる (帯はその枠の上へ動き、Enter の名前の入力もその枠のラベルの所)。同じ枠をもう 1 度押すと解ける (F-10)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC_SPLIT);
        await useSelectTool(page);
        const neverCleared = async (): Promise<boolean> => !(await selectionLog(page)).some((selection) => selection.kind === 'none');

        // 2 つめの枠 → 最初の枠のラベル (選んだまま、帯が最初の枠へ) → Enter → 最初の枠のラベルをもう 1 度で解く。
        // 2 つめの枠の上の帯は最初の枠の内側に重なるので、最初の枠はラベルで押す
        await pressFrame(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1, '2 つめの枠を押す');
        await pressFrameLabel(page, 'sec', null, 0);
        await expectBarAtFrame(page, 'sec', 0, '最初の枠のラベルを押す');
        await expect.poll(() => getSelection(page), '最初の枠のラベルを押したあとも選んだまま').toEqual({ kind: 'group', id: 'sec' });
        expect(await neverCleared(), '最初の枠のラベルを押したあとも選んだまま').toBe(true);
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 0, SEC_LABEL, '最初の枠に替えたあとの Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '最初の枠に替えたあとの Esc');
        await expectBarAtFrame(page, 'sec', 0, '最初の枠に替えたあとの Esc');
        await pressFrameLabel(page, 'sec', null, 0);
        await expect.poll(() => getSelection(page), '最初の枠のラベルをもう 1 度').toEqual({ kind: 'none' });
        await expectNoBar(page, '最初の枠のラベルをもう 1 度');

        // 最初の枠 → 2 つめのラベル (選んだまま、帯が 2 つめの枠へ) → Enter → 2 つめのラベルをもう 1 度で解く
        await pressFrame(page, 'sec', null, 0);
        await expectBarAtFrame(page, 'sec', 0, 'もう 1 度最初の枠を押す');
        const before = (await selectionLog(page)).length;
        await pressFrameLabel(page, 'sec', null, 1);
        await expectBarAtFrame(page, 'sec', 1, '2 つめのラベルを押す');
        await expect.poll(() => getSelection(page), '2 つめのラベルを押したあとも選んだまま').toEqual({ kind: 'group', id: 'sec' });
        expect((await selectionLog(page)).slice(before), '2 つめのラベルを押したあとも選んだまま').not.toContainEqual({ kind: 'none' });
        await page.keyboard.press('Enter');
        await expectInputAtLabel(page, 'sec', 1, SEC_LABEL, '2 つめの枠に替えたあとの Enter');
        await page.keyboard.press('Escape');
        await expectInputClosed(page, '2 つめの枠に替えたあとの Esc');
        await pressFrameLabel(page, 'sec', null, 1);
        await expect.poll(() => getSelection(page), '2 つめのラベルをもう 1 度').toEqual({ kind: 'none' });
        await expectNoBar(page, '2 つめのラベルをもう 1 度');
        await expectSourceStill(page, DOC_SPLIT, []);
        expect(errors).toEqual([]);
    });

    test('@editor ⌘G でまとめて枠が 2 つになったグループの名前の入力は、最初の枠のラベルの所に開く (今のまま) (F-10)', async ({ page }) => {
        await open(page);
        const grouped = editedSource(await tryEdit(page, DOC_PLAIN, { kind: 'groupNodes', nodes: SPLIT_MEMBERS }));
        expect(grouped).not.toBeNull();
        await mount(page, DOC_PLAIN);
        await useSelectTool(page);
        const [head, ...rest] = SPLIT_MEMBERS;
        await pressNode(page, head?.id ?? 0);
        for (const member of rest) await pressNode(page, member.id, 'Shift');
        await expect.poll(async () => (await lookOf(page)).marked).toEqual(SPLIT_MEMBERS.map((member) => member.id));

        await page.keyboard.press('ControlOrMeta+KeyG');
        await expect.poll(() => getSource(page)).toBe(grouped);
        await expect.poll(async () => (await frameBoxesOf(page, 'group1')).length).toBe(2);
        await expectInputAtLabel(page, 'group1', 0, 'グループ 1');
    });
});

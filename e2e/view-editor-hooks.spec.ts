// GUI 編集のための図の出口を、公開の入口から組んだ図で確かめる。
// 前の半分は操作の切り替えと押下の受け口、図の Esc の受け方 (interaction、dragToPan、受け口、data-interaction と data-drag-to-pan、
// 出口を使わない閲覧の図が変わらないこと)。
// 見た目そのもの (色、余白) は見ない。目印 (data- の値、要素の有無と数)、受け口が呼ばれたことと引数、フォーカス、閲覧の挙動を見る。
// 受け口を確かめる図は MarkdagView を直に組む (render は新しい受け口を通さない)。Esc の受け方は render の閲覧の図で確かめる。
// 後ろの半分は読み取りの出口とタグの要素 (onTagClick、onIconSvg、橋渡しの素通し、addHooks、getDocument、branchColors、groupLogo、
// タグと吹き出しの目印、MarkdagDiagram.source)。
// 末尾は選択の印と位置 (setSelection、setDropTarget、nodeRects、ensureVisible、attachOverlay、data-selected、data-drop-target、.mdag-overlays)
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { MarkdagDiagram, MarkdagView, OutlineNode, ViewHooks, ViewOptions } from '../src/index';

interface Entry {
    root: string;
    hook: string;
    id?: number | string | null;
    place?: string;
    key?: string | null;
    target?: string;
    button?: number;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    byUser?: boolean;
    // onIconSvg が呼ばれた時点で、凡例の行と groupLogo の戻り値にロゴの SVG が入っていたか
    legendSvg?: boolean;
    logoSvg?: boolean;
    // onFoldChange の閉じているノード
    folded?: number[];
}

type EditorWindow = Window & {
    harness: Harness;
    views: Record<string, MarkdagView>;
    diagrams: Record<string, MarkdagDiagram>;
    log: Entry[];
    layouts: Record<string, number>;
    // onNodePointerDown の中で、Shift つきの押下の既定の動き (文字の選択) を止めるか
    preventOnShift: boolean;
    pressed: { pointer: PointerEvent | null; mouse: MouseEvent | null };
    // 読み取りの出口: resolveIcon が返した Promise の解決を、テストが決めるまで止めておく
    pending: Array<{ root: string; ref: string; resolve: (svg: string | null) => void }>;
    // 読み取りの出口: addHooks の確かめ。受け口の呼ばれた順 (「出どころ:受け口:引数」)、before 系の戻り値、外す関数
    calls: string[];
    allow: Record<string, boolean>;
    listenersOf: (tag: string) => ViewHooks;
    removers: Record<string, () => void>;
    // 読み取りの出口: render の onChange に届いた原文
    changes: string[];
    // 選択の印と位置: attachOverlay に渡した要素 (名前ごと) と外す関数、要素のクリックの記録、位置を測る補助 (openExits が置く)
    probes: Record<string, HTMLElement>;
    detachers: Record<string, () => void>;
    probeClicks: string[];
    measure: Measure;
};

interface Point {
    x: number;
    y: number;
}

// ノードの id は Root = 1, Design = 2, Task A = 3, Task B = 4, Build = 5, Deep = 6, Leaf = 7。
// Design と配下 (2〜4) がグループ design の枠に、Build と配下 (5〜7) がグループ build の枠に入る (グループを選ぶと、もう一方の枠が薄くなる)。
// Build から Design へ depends の線がある。Task A は詳細とタグを持つタスク
function docOf(highlight: boolean, tagDisplay: 'always' | 'click' = 'always'): string {
    return [
        '---',
        'markdag:',
        `    edgeHighlight: ${String(highlight)}`,
        `    groupHighlight: ${String(highlight)}`,
        '    relations:',
        '        depends:',
        '            - $api --> Design',
        '    groups:',
        '        design:',
        '            label: 設計',
        '            color: "#3B7DD8"',
        '            boundary: true',
        '        build:',
        '            label: 実装',
        '            color: "#D8823B"',
        '            boundary: true',
        '    details:',
        '        display: click',
        '    tags:',
        `        display: ${tagDisplay}`,
        '---',
        '',
        '# Root',
        '',
        '## Design %design',
        '',
        '- [ ] Task A #owner:alice',
        '    > 詳細の文',
        '- [x] Task B',
        '',
        '## Build $api %build',
        '',
        '### Deep',
        '',
        '- Leaf',
        '',
    ].join('\n');
}
// 線と枠の強調を文書が切っている (markdag.edgeHighlight と groupHighlight が false)
const LOCKED = docOf(false);
// 線と枠の強調を文書が使う (true。既定と同じ)
const OPEN = docOf(true);
const DESIGN = 2;
const TASK_A = 3;
const BUILD = 5;
const GROUP = 'design';
// 図 (#a と #b、1000x600) の外の点
const OUTSIDE: Point = { x: 1200, y: 100 };

const node = (root: string, id: number): string => `#${root} .mdag-node[data-id="${id}"]`;
// クリックの受け口 (押下と強調の記録を除いて並びを比べるため)
const CLICKS = ['edgeClick', 'frameClick', 'canvasClick'];

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/harness.html');
    await page.waitForFunction(() => 'harness' in window);
    await page.evaluate(() => {
        const w = window as unknown as EditorWindow;
        w.views = {};
        w.diagrams = {};
        w.log = [];
        w.layouts = {};
        w.preventOnShift = false;
        w.pressed = { pointer: null, mouse: null };
        w.pending = [];
        w.calls = [];
        w.allow = {};
        w.removers = {};
        w.changes = [];
        // addHooks に渡す受け口の一式。tag はコンストラクタの受け口 (ctor) と足した受け口 (add1 ほか) の見分け。
        // before 系は allow[tag] が false のときだけ false を返す
        w.listenersOf = (tag: string): ViewHooks => {
            const call = (text: string): void => void w.calls.push(`${tag}:${text}`);
            return {
                beforeSelectGroup: (id: string | null) => {
                    call(`beforeSelectGroup:${id}`);
                    return w.allow[tag] !== false;
                },
                onSelectGroup: (id: string | null) => call(`onSelectGroup:${id}`),
                beforeDetailsShow: (target: OutlineNode) => {
                    call(`beforeDetailsShow:${target.id}`);
                    return w.allow[tag] !== false;
                },
                onDetailsShow: (target: OutlineNode) => call(`onDetailsShow:${target.id}`),
                onFoldChange: (folded: number[]) => call(`onFoldChange:${folded.join(',')}`),
                onCanvasClick: () => call('onCanvasClick'),
                onTagClick: (target: OutlineNode, key: string, place: string) => call(`onTagClick:${target.id}:${key}:${place}`),
            } as ViewHooks;
        };
    });
}

// MarkdagView を直に組む。スタイルシートはページが読む (MarkdagView は差し込まない)。
// 受け口は全部を受けて記録する。足した受け口と、比べるための今の受け口 (onToggleTask、onSelectEdge ほか)。
// svgs (ref → SVG) は、文書を渡す前に setIconSvg で置き場に入れる (ノードの要素を作るときからロゴが入る)
async function mountView(page: Page, markdown: string, options: Partial<ViewOptions> = {}, root = 'a', svgs: Record<string, string> = {}): Promise<void> {
    if ((await page.locator('link[href="/src/style.css"]').count()) === 0) await page.addStyleTag({ url: '/src/style.css' });
    await page.evaluate(
        ({ markdown, options, root, svgs }) => {
            const w = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error('container is missing');
            const keyOf = (placed: { edge: { kind: string; source: number; target: number } } | null): string | null =>
                placed === null ? null : `${placed.edge.kind}:${placed.edge.source}>${placed.edge.target}`;
            const push = (entry: Omit<Entry, 'root'>): void => void w.log.push({ root, ...entry });
            const keys = (event: MouseEvent) => ({ button: event.button, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey });
            w.views[root]?.destroy();
            w.layouts[root] = 0;
            const hooks: ViewHooks = {
                onNodePointerDown: (target: OutlineNode, event: PointerEvent) => {
                    push({ hook: 'nodePointerDown', id: target.id, ...keys(event) });
                    if (w.preventOnShift && event.shiftKey) event.preventDefault();
                },
                onNodeDoubleClick: (target: OutlineNode, place: string) => push({ hook: 'nodeDoubleClick', id: target.id, place }),
                onEdgeClick: (edge: { edge: { kind: string; source: number; target: number } }) => push({ hook: 'edgeClick', key: keyOf(edge) }),
                onFrameClick: (id: string) => push({ hook: 'frameClick', id }),
                onFrameDoubleClick: (id: string) => push({ hook: 'frameDoubleClick', id }),
                onCanvasPointerDown: (event: PointerEvent, target: { kind: string; id?: string; edge?: { edge: { kind: string; source: number; target: number } } }) =>
                    push({ hook: 'canvasPointerDown', target: target.kind, id: target.id ?? null, key: target.edge ? keyOf(target.edge) : null, button: event.button }),
                onCanvasClick: () => push({ hook: 'canvasClick' }),
                onToggleTask: (target) => push({ hook: 'toggleTask', id: target.id }),
                onNodeClick: (target) => push({ hook: 'nodeClick', id: target.id }),
                onSelectEdge: (edge, byUser) => push({ hook: 'selectEdge', key: keyOf(edge), byUser }),
                onSelectGroup: (id) => push({ hook: 'selectGroup', id }),
                onDetailsShow: (target) => push({ hook: 'detailsShow', id: target.id }),
                onDetailsHide: (target) => push({ hook: 'detailsHide', id: target.id }),
                onLayout: () => void (w.layouts[root] = (w.layouts[root] ?? 0) + 1),
                // 読み取りの出口とタグの受け口
                onTagClick: (target: OutlineNode, key: string, place: string) => push({ hook: 'tagClick', id: target.id, key, place }),
                onIconSvg: (ref: string) => push({ hook: 'iconSvg', key: ref }),
            };
            const view = new w.harness.markdag.MarkdagView(container, hooks);
            view.setOptions({ animate: false, ...options });
            for (const [ref, svg] of Object.entries(svgs)) view.setIconSvg(ref, svg);
            const parsed = w.harness.markdag.parseDocument(markdown);
            view.setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, markdown), true);
            w.views[root] = view;
        },
        { markdown, options, root, svgs },
    );
}

// render の閲覧の図 (受け口は render の既定のまま)
async function renderDiagram(page: Page, markdown: string, root = 'a'): Promise<void> {
    await page.evaluate(
        ({ markdown, root }) => {
            const w = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error('container is missing');
            w.diagrams[root] = w.harness.markdag.render(container, markdown, { animate: false });
            w.views[root] = w.diagrams[root].view;
        },
        { markdown, root },
    );
}

const setOptions = (page: Page, options: Partial<ViewOptions>, root = 'a'): Promise<void> =>
    page.evaluate(({ options, root }) => (window as unknown as EditorWindow).views[root]?.setOptions(options), { options, root });
const selectEdge = (page: Page, key: string | null, root = 'a'): Promise<void> =>
    page.evaluate(({ key, root }) => (window as unknown as EditorWindow).views[root]?.selectEdge(key), { key, root });
const selectGroup = (page: Page, id: string | null, root = 'a'): Promise<void> =>
    page.evaluate(({ id, root }) => (window as unknown as EditorWindow).views[root]?.selectGroup(id), { id, root });
const transformOf = (page: Page, root = 'a') => page.evaluate((root) => (window as unknown as EditorWindow).views[root]?.getTransform(), root);
const logOf = (page: Page, hook?: string): Promise<Entry[]> =>
    page.evaluate((hook) => (window as unknown as EditorWindow).log.filter((entry) => hook === undefined || entry.hook === hook), hook);
const clearLog = (page: Page): Promise<void> => page.evaluate(() => void ((window as unknown as EditorWindow).log.length = 0));
// 「呼ばれない」「変わらない」を確かめる前に、いちばん遅いブラウザでも反映が済む時間を待つ
const settle = (page: Page): Promise<void> => page.waitForTimeout(200);
// 線の data-key (kind:source>target)。prefix に合う最初の線
const edgeKey = (page: Page, prefix: string, root = 'a'): Promise<string> =>
    page.evaluate(
        ({ prefix, root }) => {
            const key = [...document.querySelectorAll<SVGPathElement>(`#${root} path.mdag-edge`)].map((path) => path.dataset.key ?? '').find((key) => key.startsWith(prefix));
            if (!key) throw new Error(`${prefix} の線がない`);
            return key;
        },
        { prefix, root },
    );

type Spot =
    // 要素 (か中の要素) が表に出ている点。step を付けると、そこから step だけ離れた点も同じ要素の上にある点
    | { on: 'element'; selector: string; step?: [number, number] }
    // 要素の中の文字の上の点 (svg と詳細の引用の外)
    | { on: 'text'; selector: string }
    // 図の何もないところ (図の領域そのものが表に出ている点)。step は element と同じ
    | { on: 'blank'; root: string; step?: [number, number] }
    // 線の帯の上の点。step を付けると、帯に沿って 6px 以上離れた 2 つ目の点も返す
    | { on: 'edge'; root: string; key: string; step?: boolean };

// 画面の座標で押せる点を探す。locator.click は要素をスクロールして見せようとし、図はスクロールを戻すので位置がずれる。
// 座標を決めて page.mouse で押す
async function spot(page: Page, target: Spot): Promise<Point & { x2: number; y2: number }> {
    const found = await page.evaluate((target) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        const hitIn = (element: Element, x: number, y: number): boolean => {
            if (!inView(x, y)) return false;
            const hit = document.elementFromPoint(x, y);
            return hit !== null && element.contains(hit);
        };
        const grid = (rect: DOMRect, step: number): Array<{ x: number; y: number }> => {
            const points: Array<{ x: number; y: number }> = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
            // 真ん中に近い点から試す
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        };
        if (target.on === 'element' || target.on === 'blank') {
            const element = target.on === 'element' ? document.querySelector(target.selector) : document.querySelector(`${target.root} > .mdag-viewport`);
            if (!element) return null;
            const area = target.on === 'element' ? element.getBoundingClientRect() : (document.querySelector(target.root)?.getBoundingClientRect() ?? null);
            if (!area) return null;
            const isOn = (x: number, y: number): boolean =>
                target.on === 'element' ? hitIn(element, x, y) : inView(x, y) && document.elementFromPoint(x, y) === element;
            const [dx, dy] = target.step ?? [0, 0];
            const step = target.on === 'element' ? Math.max(2, Math.min(area.width, area.height) / 8) : 16;
            for (const point of grid(area, step)) if (isOn(point.x, point.y) && isOn(point.x + dx, point.y + dy)) return { ...point, x2: point.x + dx, y2: point.y + dy };
            return null;
        }
        if (target.on === 'text') {
            const element = document.querySelector(target.selector);
            if (!element) return null;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let text = walker.nextNode(); text; text = walker.nextNode()) {
                const parent = text.parentElement;
                const content = text.textContent ?? '';
                const start = content.search(/\S/);
                if (!parent || start < 0 || parent.closest('svg, .mdag-details')) continue;
                const range = document.createRange();
                range.setStart(text, start);
                range.setEnd(text, content.trimEnd().length);
                const rect = range.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const hit = document.elementFromPoint(x, y);
                if (inView(x, y) && hit && element.contains(hit) && !hit.closest('svg')) return { x, y, x2: x, y2: y };
            }
            return null;
        }
        const hit = document.querySelector<SVGPathElement>(`${target.root} .mdag-edge-hit[data-key="${target.key}"]`);
        const matrix = hit?.getScreenCTM();
        if (!hit || !matrix) return null;
        const length = hit.getTotalLength();
        const points: Array<{ x: number; y: number }> = [];
        for (let index = 1; index < 50; index++) {
            const at = hit.getPointAtLength((length * index) / 50);
            const screen = new DOMPoint(at.x, at.y).matrixTransform(matrix);
            if (inView(screen.x, screen.y) && document.elementFromPoint(screen.x, screen.y) === hit) points.push({ x: screen.x, y: screen.y });
        }
        // 線の中ほどの点から試す
        const ordered = points.map((point, index) => ({ point, index })).sort((a, b) => Math.abs(a.index - points.length / 2) - Math.abs(b.index - points.length / 2));
        for (const { point } of ordered) {
            if (!target.step) return { ...point, x2: point.x, y2: point.y };
            const far = points.find((other) => Math.hypot(other.x - point.x, other.y - point.y) >= 6 && Math.hypot(other.x - point.x, other.y - point.y) <= 16);
            if (far) return { ...point, x2: far.x, y2: far.y };
        }
        return null;
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

async function press(page: Page, point: Point, button: 'left' | 'middle' | 'right' = 'left'): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button });
    await page.mouse.up({ button });
}

async function drag(page: Page, from: Point, to: Point, button: 'left' | 'middle' = 'left'): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 3 });
    await page.mouse.up({ button });
}

// 強調の様子: 線を選んでいる印、強調から外れたノード
async function highlightOf(page: Page, root = 'a'): Promise<{ edge: boolean; faded: number[] }> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        return {
            edge: container?.hasAttribute('data-edge-selected') ?? false,
            faded: [...(container?.querySelectorAll<HTMLElement>('.mdag-node[data-faded]') ?? [])].map((element) => Number(element.dataset.id)),
        };
    }, root);
}

const popoverOpen = (page: Page, root = 'a'): Promise<boolean> =>
    page.evaluate((root) => {
        const popover = document.querySelector<HTMLElement>(`#${root} .mdag-popover`);
        return popover !== null && !popover.hidden;
    }, root);

// 強調の見た目 (線、縁取り、下線、開閉の円、ノード、枠の薄さと太さ、図の要素の目印)。true の文書と false の文書を比べるのに使う
async function highlightLook(page: Page, root: string): Promise<unknown> {
    return page.evaluate((root) => {
        const container = document.getElementById(root);
        if (!container) throw new Error('container is missing');
        const styles = (selector: string, keyOf: (element: SVGElement | HTMLElement) => string) =>
            [...container.querySelectorAll<SVGElement | HTMLElement>(selector)]
                .map((element) => `${keyOf(element)} opacity=${element.style.opacity} width=${element.style.strokeWidth}`)
                .sort();
        return {
            edgeSelected: container.hasAttribute('data-edge-selected'),
            edges: styles('path.mdag-edge, path.mdag-edge-casing', (element) => `${element.getAttribute('class')} ${element.dataset.key}`),
            underlines: styles('.mdag-underline', (element) => `u${element.dataset.id}`),
            folds: styles('.mdag-fold', (element) => `f${element.dataset.id}`),
            nodes: [...container.querySelectorAll<HTMLElement>('.mdag-node')].map((element) => `${element.dataset.id} faded=${String(element.hasAttribute('data-faded'))} opacity=${element.style.opacity}`),
            frames: [...container.querySelectorAll<SVGElement>('.mdag-frames > *')].map((element) => `${element.getAttribute('class')} opacity=${element.style.opacity}`),
        };
    }, root);
}

// ノード、線、枠、開閉の円の要素の並びと、属性 (位置と大きさと style を除く) とクラス
async function structureOf(page: Page, root = 'a'): Promise<string[]> {
    return page.evaluate((root) => {
        const geometry = new Set(['style', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'width', 'height', 'transform']);
        const container = document.getElementById(root);
        if (!container) throw new Error('container is missing');
        return [...container.querySelectorAll('.mdag-nodes *, .mdag-edges *, .mdag-frames *, .mdag-controls *')].map((element) => {
            const attributes = [...element.attributes]
                .filter((attribute) => !geometry.has(attribute.name))
                .map((attribute) => `${attribute.name}=${attribute.value}`)
                .sort();
            return `${element.tagName.toLowerCase()} ${attributes.join(' ')}`;
        });
    }, root);
}

test.describe('既定の図と切り替えの目印 (段 9、2.4、2.6)', () => {
    test('@editor 既定の図: .markdag に data-interaction と data-drag-to-pan がなく、edgeHighlight: false の文書で線の帯がなく、タグは 1 つずつの要素に分かれない', async ({ page }) => {
        await open(page);
        await renderDiagram(page, LOCKED, 'a');
        await mountView(page, LOCKED, {}, 'b');
        for (const root of ['a', 'b']) {
            const container = page.locator(`#${root}`);
            await expect(container).toHaveClass(/\bmarkdag\b/);
            await expect(container).not.toHaveAttribute('data-interaction');
            await expect(container).not.toHaveAttribute('data-drag-to-pan');
            await expect(page.locator(`#${root} path.mdag-edge`).first()).toBeAttached();
            await expect(page.locator(`#${root} .mdag-edge-hit`)).toHaveCount(0);
            await expect(page.locator(`#${root} .mdag-frames [data-group]`)).toHaveCount(0);
            await expect(page.locator(`#${root} .mdag-tags`)).toHaveCount(1);
            await expect(page.locator(`#${root} .mdag-tags .mdag-tag`)).toHaveCount(0);
        }
    });

    test('@editor 既定の値を明示しても目印は付かず、edit と dragToPan の middle、both で付き、既定に戻すと外れる', async ({ page }) => {
        await open(page);
        await mountView(page, OPEN);
        const container = page.locator('#a');
        await setOptions(page, { interaction: 'view', dragToPan: 'primary' });
        await expect(container).not.toHaveAttribute('data-interaction');
        await expect(container).not.toHaveAttribute('data-drag-to-pan');

        await setOptions(page, { interaction: 'edit' });
        await expect(container).toHaveAttribute('data-interaction', 'edit');
        await setOptions(page, { dragToPan: 'middle' });
        await expect(container).toHaveAttribute('data-drag-to-pan', 'middle');
        await setOptions(page, { dragToPan: 'both' });
        await expect(container).toHaveAttribute('data-drag-to-pan', 'both');
        await expect(container).toHaveAttribute('data-interaction', 'edit');

        await setOptions(page, { interaction: 'view', dragToPan: 'primary' });
        await expect(container).not.toHaveAttribute('data-interaction');
        await expect(container).not.toHaveAttribute('data-drag-to-pan');
    });

    test('@editor interaction を edit にして view に戻すと、ノード、線、枠の要素の並びと属性とクラスが最初と同じ', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED);
        const before = await structureOf(page);
        expect(before.length).toBeGreaterThan(0);

        await setOptions(page, { interaction: 'edit' });
        // edit では文書の指定によらず線の帯と枠の data-group がある (次の段の比べが意味を持つことの確かめ)
        await expect(page.locator('#a .mdag-edge-hit').first()).toBeAttached();
        await expect(page.locator('#a .mdag-frames [data-group]').first()).toBeAttached();

        await setOptions(page, { interaction: 'view' });
        await expect.poll(() => structureOf(page)).toEqual(before);
        await expect(page.locator('#a')).not.toHaveAttribute('data-interaction');
    });
});

test.describe('interaction が edit の線と枠 (段 9、2.1 の (1) と (2)、10.1 の 3)', () => {
    test('@editor edgeHighlight と groupHighlight が false の文書でも、edit では線ごとに帯があり枠に data-group が付く。view では付かない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' }, 'a');
        await mountView(page, LOCKED, {}, 'b');
        const edges = await page.locator('#a path.mdag-edge').count();
        expect(edges).toBeGreaterThan(0);
        await expect(page.locator('#a .mdag-edge-hit')).toHaveCount(edges);
        const key = await edgeKey(page, 'depends:');
        await expect(page.locator(`#a .mdag-edge-hit[data-key="${key}"]`)).toHaveCount(1);
        await expect(page.locator(`#a .mdag-frame[data-group="${GROUP}"]`)).toHaveCount(1);
        await expect(page.locator(`#a .mdag-frame-label[data-group="${GROUP}"]`)).toHaveCount(1);

        await expect(page.locator('#b .mdag-edge-hit')).toHaveCount(0);
        await expect(page.locator('#b .mdag-frame')).toHaveCount(2);
        await expect(page.locator('#b .mdag-frames [data-group]')).toHaveCount(0);
    });

    test('@editor edit の false の文書で selectEdge と selectGroup をした強調の見た目が、true の文書を閲覧で選んだときと同じ', async ({ page }) => {
        await open(page);
        await mountView(page, OPEN, {}, 'a');
        await mountView(page, LOCKED, { interaction: 'edit' }, 'b');
        const key = await edgeKey(page, 'depends:');
        expect(await edgeKey(page, 'depends:', 'b')).toBe(key);

        await selectEdge(page, key, 'a');
        await selectEdge(page, key, 'b');
        const edgeLook = await highlightLook(page, 'a');
        expect((edgeLook as { edgeSelected: boolean }).edgeSelected).toBe(true);
        await expect.poll(() => highlightLook(page, 'b')).toEqual(edgeLook);

        await selectGroup(page, GROUP, 'a');
        await selectGroup(page, GROUP, 'b');
        const groupLook = await highlightLook(page, 'a');
        expect((await highlightOf(page, 'a')).faded.length).toBeGreaterThan(0);
        await expect.poll(() => highlightLook(page, 'b')).toEqual(groupLook);
    });

    test('@editor edit では線、枠、何もないところのクリックで強調が変わらず、onEdgeClick、onFrameClick、onCanvasClick が呼ばれる', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        const depends = await edgeKey(page, 'depends:');
        const tree = await edgeKey(page, `tree:1>${String(BUILD)}`);

        // 何も選んでいないとき: 押しても選ばない
        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        await expect.poll(() => logOf(page, 'edgeClick')).toEqual([{ root: 'a', hook: 'edgeClick', key: depends }]);
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` }));
        await expect.poll(() => logOf(page, 'frameClick')).toEqual([{ root: 'a', hook: 'frameClick', id: GROUP }]);
        await settle(page);
        expect(await highlightOf(page)).toEqual({ edge: false, faded: [] });
        expect(await logOf(page, 'selectEdge')).toEqual([]);
        expect(await logOf(page, 'selectGroup')).toEqual([]);

        // 線を選んでいるとき: ほかの線、同じ線、枠、何もないところを押しても選択はそのまま
        await selectEdge(page, depends);
        const selected = await highlightOf(page);
        expect(selected.edge).toBe(true);
        await clearLog(page);
        await press(page, await spot(page, { on: 'edge', root: '#a', key: tree }));
        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` }));
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await expect.poll(async () => (await logOf(page)).map((entry) => entry.hook).filter((hook) => CLICKS.includes(hook))).toEqual([
            'edgeClick',
            'edgeClick',
            'frameClick',
            'canvasClick',
        ]);
        expect((await logOf(page, 'edgeClick')).map((entry) => entry.key)).toEqual([tree, depends]);
        await settle(page);
        expect(await highlightOf(page)).toEqual(selected);
        expect(await logOf(page, 'selectEdge')).toEqual([]);
        expect(await logOf(page, 'selectGroup')).toEqual([]);

        // グループを選んでいるとき: 枠と何もないところと線を押しても選択はそのまま
        await selectGroup(page, GROUP);
        const grouped = await highlightOf(page);
        expect(grouped.faded.length).toBeGreaterThan(0);
        await clearLog(page);
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame-label[data-group="${GROUP}"]` }));
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        await expect.poll(async () => (await logOf(page)).map((entry) => entry.hook).filter((hook) => CLICKS.includes(hook))).toEqual([
            'frameClick',
            'canvasClick',
            'edgeClick',
        ]);
        await settle(page);
        expect(await highlightOf(page)).toEqual(grouped);
        expect(await logOf(page, 'selectEdge')).toEqual([]);
        expect(await logOf(page, 'selectGroup')).toEqual([]);
    });

    test('@editor view では線と枠と何もないところのクリックで今までどおり選択が変わり、onEdgeClick、onFrameClick、onCanvasClick も呼ばれる', async ({ page }) => {
        await open(page);
        await mountView(page, OPEN);
        const depends = await edgeKey(page, 'depends:');

        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        await expect.poll(() => highlightOf(page)).toMatchObject({ edge: true });
        expect(await logOf(page, 'selectEdge')).toEqual([{ root: 'a', hook: 'selectEdge', key: depends, byUser: true }]);
        expect(await logOf(page, 'edgeClick')).toEqual([{ root: 'a', hook: 'edgeClick', key: depends }]);

        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await expect.poll(() => highlightOf(page)).toEqual({ edge: false, faded: [] });
        expect(await logOf(page, 'canvasClick')).toEqual([{ root: 'a', hook: 'canvasClick' }]);

        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` }));
        await expect.poll(() => logOf(page, 'selectGroup')).toEqual([{ root: 'a', hook: 'selectGroup', id: GROUP }]);
        expect(await logOf(page, 'frameClick')).toEqual([{ root: 'a', hook: 'frameClick', id: GROUP }]);
    });
});

test.describe('図の Esc の受け方 (段 9、2.7、10.3 の A-23)', () => {
    // render の図で、Task A の吹き出しを印の click だけで出したままにし (ポインタは動かさない)、線か枠をメソッドで選ぶ
    async function prepare(page: Page, interaction: 'view' | 'edit', root = 'a', select: 'edge' | 'group' = 'edge'): Promise<void> {
        await renderDiagram(page, OPEN, root);
        if (interaction === 'edit') await setOptions(page, { interaction: 'edit' }, root);
        await page.locator(`${node(root, TASK_A)} .mdag-note-mark`).dispatchEvent('click');
        if (select === 'edge') await selectEdge(page, await edgeKey(page, 'depends:', root), root);
        else await selectGroup(page, GROUP, root);
        expect(await popoverOpen(page, root)).toBe(true);
        const highlight = await highlightOf(page, root);
        expect(select === 'edge' ? highlight.edge : highlight.faded.length > 0).toBe(true);
    }

    async function expectClosed(page: Page, interaction: 'view' | 'edit', root = 'a'): Promise<void> {
        await expect.poll(() => popoverOpen(page, root)).toBe(false);
        // edit では吹き出しだけを閉じ、強調はそのまま
        if (interaction === 'view') await expect.poll(() => highlightOf(page, root)).toEqual({ edge: false, faded: [] });
        else {
            await settle(page);
            expect((await highlightOf(page, root)).edge).toBe(true);
        }
    }

    async function expectUnchanged(page: Page, root = 'a'): Promise<void> {
        await settle(page);
        expect(await popoverOpen(page, root)).toBe(true);
        expect((await highlightOf(page, root)).edge).toBe(true);
    }

    async function focusBody(page: Page): Promise<void> {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(true);
    }

    for (const interaction of ['view', 'edit'] as const) {
        const closes = interaction === 'view' ? '吹き出しが閉じて強調が解ける' : '吹き出しだけが閉じる';

        test(`@editor ${interaction}: フォーカスが body でポインタが図の上なら、Esc で${closes}`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction);
            await focusBody(page);
            const blank = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(blank.x, blank.y);
            await page.keyboard.press('Escape');
            await expectClosed(page, interaction);
        });

        test(`@editor ${interaction}: 図の中の要素にフォーカスがあれば、ポインタが図の外でも Esc で${closes}`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction);
            const blank = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(blank.x, blank.y);
            await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
            await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.focus(), `${node('a', TASK_A)} .mdag-note-mark`);
            expect(await page.evaluate(() => document.getElementById('a')?.contains(document.activeElement) ?? false)).toBe(true);
            await page.keyboard.press('Escape');
            await expectClosed(page, interaction);
        });

        test(`@editor ${interaction}: フォーカスが body でポインタが図の外なら、Esc で何も変わらない`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction);
            await focusBody(page);
            const blank = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(blank.x, blank.y);
            await page.mouse.move(OUTSIDE.x, OUTSIDE.y);
            await page.keyboard.press('Escape');
            await expectUnchanged(page);
        });

        test(`@editor ${interaction}: 図の外の入力欄にフォーカスがあれば、ポインタが図の上でも Esc で何も変わらない`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction);
            await page.evaluate((outside) => {
                const field = document.createElement('textarea');
                field.style.cssText = `position: fixed; left: ${String(outside.x - 100)}px; top: ${String(outside.y - 50)}px; width: 160px; height: 60px;`;
                document.body.append(field);
                field.focus();
            }, OUTSIDE);
            expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
            const blank = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(blank.x, blank.y);
            await page.keyboard.press('Escape');
            await expectUnchanged(page);
        });

        test(`@editor ${interaction}: ポインタがまだ一度も図の上に来ていなければ、Esc で何も変わらない`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction);
            await focusBody(page);
            await page.keyboard.press('Escape');
            await expectUnchanged(page);
        });

        test(`@editor ${interaction}: 同じページの 2 つの図で、ポインタを置いた図の Esc はもう一方の吹き出しと強調を残す`, async ({ page }) => {
            await open(page);
            await prepare(page, interaction, 'a');
            await prepare(page, interaction, 'b');
            await focusBody(page);

            const onA = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(onA.x, onA.y);
            await page.keyboard.press('Escape');
            await expectClosed(page, interaction, 'a');
            await expectUnchanged(page, 'b');

            await page.locator(`${node('a', TASK_A)} .mdag-note-mark`).dispatchEvent('click');
            expect(await popoverOpen(page, 'a')).toBe(true);
            const onB = await spot(page, { on: 'blank', root: '#b' });
            await page.mouse.move(onB.x, onB.y);
            await page.keyboard.press('Escape');
            await expectClosed(page, interaction, 'b');
            await settle(page);
            expect(await popoverOpen(page, 'a')).toBe(true);

            // フォーカスが一方の図の中にあれば、ポインタがもう一方の図の上にあっても、閉じるのはフォーカスのある図だけ
            await page.locator(`${node('b', TASK_A)} .mdag-note-mark`).dispatchEvent('click');
            expect(await popoverOpen(page, 'b')).toBe(true);
            await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)?.focus(), `${node('a', TASK_A)} .mdag-note-mark`);
            await page.mouse.move(onB.x, onB.y);
            await page.keyboard.press('Escape');
            await expect.poll(() => popoverOpen(page, 'a')).toBe(false);
            await settle(page);
            expect(await popoverOpen(page, 'b')).toBe(true);
        });
    }

    test('@editor view: フォーカスが body でポインタが図の上なら、Esc でグループの強調も解ける', async ({ page }) => {
        await open(page);
        await prepare(page, 'view', 'a', 'group');
        await focusBody(page);
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await page.mouse.move(blank.x, blank.y);
        await page.keyboard.press('Escape');
        await expect.poll(() => popoverOpen(page)).toBe(false);
        await expect.poll(() => highlightOf(page)).toEqual({ edge: false, faded: [] });
    });

    test('@editor edit: Esc で吹き出しが閉じても、グループの強調は変わらない', async ({ page }) => {
        await open(page);
        await prepare(page, 'edit', 'a', 'group');
        const grouped = await highlightOf(page);
        await focusBody(page);
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await page.mouse.move(blank.x, blank.y);
        await page.keyboard.press('Escape');
        await expect.poll(() => popoverOpen(page)).toBe(false);
        await settle(page);
        expect(await highlightOf(page)).toEqual(grouped);
    });
});

test.describe('タスクとノードの押下 (段 9、2.1 の (3) と (4)、2.2 の onNodePointerDown、B-010、B-062)', () => {
    test('@editor edit では、タスクの文字と詳細のクリックで onToggleTask が呼ばれず、先頭の状態の絵のクリックで呼ばれる。view では文字でも呼ばれる', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' }, 'a');
        const label = `${node('a', TASK_A)} .mdag-content`;
        await press(page, await spot(page, { on: 'text', selector: label }));
        await setOptions(page, { details: 'always' });
        await press(page, await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-content .mdag-details` }));
        await settle(page);
        expect(await logOf(page, 'toggleTask')).toEqual([]);

        await press(page, await spot(page, { on: 'element', selector: `${label} svg` }));
        await expect.poll(() => logOf(page, 'toggleTask')).toEqual([{ root: 'a', hook: 'toggleTask', id: TASK_A }]);

        await setOptions(page, { interaction: 'view' });
        await clearLog(page);
        await press(page, await spot(page, { on: 'text', selector: label }));
        await expect.poll(() => logOf(page, 'toggleTask')).toEqual([{ root: 'a', hook: 'toggleTask', id: TASK_A }]);
    });

    test('@editor edit では、ノードの箱の主ボタンのドラッグでパンしない。view ではタグの上からのドラッグは今までどおりパンする', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        const before = await transformOf(page);
        for (const from of [await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` }), await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` })]) {
            await drag(page, from, { x: from.x + 80, y: from.y + 50 });
        }
        await settle(page);
        expect(await transformOf(page)).toEqual(before);

        await setOptions(page, { interaction: 'view' });
        const tags = await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` });
        await drag(page, tags, { x: tags.x + 80, y: tags.y + 50 });
        await expect.poll(async () => (await transformOf(page))?.x).not.toBe(before?.x);
    });

    test('@editor edit で dragToPan が middle のとき、ノードの箱の上の中ボタンのドラッグはパンする', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit', dragToPan: 'middle' });
        const tags = await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` });
        let before = await transformOf(page);
        await drag(page, tags, { x: tags.x + 80, y: tags.y + 50 }, 'middle');
        await expect.poll(async () => (await transformOf(page))?.x).not.toBe(before?.x);

        const text = await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` });
        before = await transformOf(page);
        await drag(page, text, { x: text.x + 80, y: text.y + 50 }, 'middle');
        await expect.poll(async () => (await transformOf(page))?.x).not.toBe(before?.x);
    });

    for (const interaction of ['view', 'edit'] as const) {
        test(`@editor ${interaction}: onNodePointerDown がノードの文字と箱 (タグ) の押下で、どのボタンでも呼ばれ、修飾キーが event に入る`, async ({ page }) => {
            await open(page);
            await mountView(page, LOCKED, { interaction });
            const text = await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` });
            const tags = await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` });
            await press(page, text);
            await press(page, tags);
            await press(page, text, 'middle');
            await press(page, text, 'right');
            for (const key of ['Shift', 'Control', 'Meta'] as const) {
                await page.keyboard.down(key);
                await press(page, text);
                await page.keyboard.up(key);
            }
            const plain = { shiftKey: false, ctrlKey: false, metaKey: false };
            await expect
                .poll(() => logOf(page, 'nodePointerDown'))
                .toEqual([
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 0, ...plain },
                    { root: 'a', hook: 'nodePointerDown', id: TASK_A, button: 0, ...plain },
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 1, ...plain },
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 2, ...plain },
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 0, ...plain, shiftKey: true },
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 0, ...plain, ctrlKey: true },
                    { root: 'a', hook: 'nodePointerDown', id: DESIGN, button: 0, ...plain, metaKey: true },
                ]);
            expect(await logOf(page, 'canvasPointerDown')).toEqual([]);
        });

        test(`@editor ${interaction}: onNodePointerDown の中で preventDefault すると、Shift つきのクリックで文字が選ばれない`, async ({ page }) => {
            await open(page);
            await mountView(page, LOCKED, { interaction });
            const caret = await spot(page, { on: 'text', selector: `${node('a', BUILD)} .mdag-content` });
            const text = await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` });
            const shiftClick = async (): Promise<string> => {
                await page.evaluate(() => window.getSelection()?.removeAllRanges());
                await press(page, caret);
                await page.keyboard.down('Shift');
                await press(page, text);
                await page.keyboard.up('Shift');
                await settle(page);
                return page.evaluate(() => window.getSelection()?.toString() ?? '');
            };
            // 閲覧の図では、止めなければ Shift つきのクリックで文字が選ばれる (確かめの前提)
            if (interaction === 'view') expect(await shiftClick()).not.toBe('');
            await page.evaluate(() => void ((window as unknown as EditorWindow).preventOnShift = true));
            expect(await shiftClick()).toBe('');
            expect((await logOf(page, 'nodePointerDown')).some((entry) => entry.id === DESIGN && entry.shiftKey === true)).toBe(true);
        });
    }
});

test.describe('onCanvasPointerDown とクリックの 4px の判定 (段 9、2.2、A-13、B-13)', () => {
    test('@editor edit: 何もないところで blank、枠の内側とラベルで frame、線の帯で edge と一緒に呼ばれ、ノードと開閉の円では呼ばれない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        const depends = await edgeKey(page, 'depends:');
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` }));
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame-label[data-group="${GROUP}"]` }));
        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        const pick = (entry: Entry) => ({ target: entry.target, id: entry.id, key: entry.key });
        await expect.poll(async () => (await logOf(page, 'canvasPointerDown')).map(pick)).toEqual([
            { target: 'blank', id: null, key: null },
            { target: 'frame', id: GROUP, key: null },
            { target: 'frame', id: GROUP, key: null },
            { target: 'edge', id: null, key: depends },
        ]);

        await clearLog(page);
        await press(page, await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` }));
        await press(page, await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` }));
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-fold[data-id="${String(BUILD)}"]` }));
        await expect.poll(async () => (await logOf(page, 'nodePointerDown')).map((entry) => entry.id).filter((id) => id !== BUILD)).toEqual([DESIGN, TASK_A]);
        await settle(page);
        expect(await logOf(page, 'canvasPointerDown')).toEqual([]);
    });

    test('@editor view: 文書が強調を使う図でも、何もないところ、枠、線の帯の押下で呼ばれる (interaction によらない)', async ({ page }) => {
        await open(page);
        await mountView(page, OPEN);
        const depends = await edgeKey(page, 'depends:');
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await press(page, await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` }));
        await press(page, await spot(page, { on: 'edge', root: '#a', key: depends }));
        await expect.poll(async () => (await logOf(page, 'canvasPointerDown')).map((entry) => entry.target)).toEqual(['blank', 'frame', 'edge']);
    });

    test('@editor edit (dragToPan: middle): 枠、線の帯、何もないところで 4px 以上動かして離すとクリックの受け口は呼ばれず、動かさずに離すと呼ばれる', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit', dragToPan: 'middle' });
        const depends = await edgeKey(page, 'depends:');
        const frame = await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]`, step: [10, 0] });
        const edge = await spot(page, { on: 'edge', root: '#a', key: depends, step: true });
        const blank = await spot(page, { on: 'blank', root: '#a', step: [20, 0] });

        await drag(page, frame, { x: frame.x2, y: frame.y2 });
        await drag(page, edge, { x: edge.x2, y: edge.y2 });
        await drag(page, blank, { x: blank.x2, y: blank.y2 });
        await expect.poll(async () => (await logOf(page, 'canvasPointerDown')).map((entry) => entry.target)).toEqual(['frame', 'edge', 'blank']);
        await settle(page);
        expect(await logOf(page, 'frameClick')).toEqual([]);
        expect(await logOf(page, 'edgeClick')).toEqual([]);
        expect(await logOf(page, 'canvasClick')).toEqual([]);

        await press(page, frame);
        await press(page, edge);
        await press(page, blank);
        await expect.poll(async () => (await logOf(page)).map((entry) => entry.hook).filter((hook) => CLICKS.includes(hook))).toEqual(['frameClick', 'edgeClick', 'canvasClick']);
    });
});

test.describe('dragToPan (段 9、2.1、B-072、B-074、B-075、A-19)', () => {
    async function panned(page: Page, button: 'left' | 'middle'): Promise<boolean> {
        const before = await transformOf(page);
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await drag(page, blank, { x: blank.x + 60, y: blank.y + 40 }, button);
        try {
            await expect.poll(async () => (await transformOf(page))?.x, { timeout: 1500 }).not.toBe(before?.x);
            return true;
        } catch {
            return false;
        }
    }

    async function zooms(page: Page): Promise<void> {
        const before = await transformOf(page);
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.wheel(0, -200);
        await expect.poll(async () => (await transformOf(page))?.k).not.toBe(before?.k);
    }

    // 何もないところの中ボタンの押下で、既定の動き (自動スクロール) を止めたか。pointerdown か mousedown のどちらかで止めていればよい
    async function middlePressPrevented(page: Page): Promise<boolean> {
        await page.evaluate(() => {
            const w = window as unknown as EditorWindow;
            w.pressed = { pointer: null, mouse: null };
            window.addEventListener('pointerdown', (event) => void (w.pressed.pointer = event), { capture: true, once: true });
            window.addEventListener('mousedown', (event) => void (w.pressed.mouse = event), { capture: true, once: true });
        });
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await page.mouse.move(blank.x, blank.y);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.up({ button: 'middle' });
        return page.evaluate(() => {
            const { pointer, mouse } = (window as unknown as EditorWindow).pressed;
            return (pointer?.defaultPrevented ?? false) || (mouse?.defaultPrevented ?? false);
        });
    }

    test('@editor primary (既定): 何もないところの主ボタンのドラッグでパンし、中ボタンではパンせず既定の動きも止めない。ホイールで拡大縮小する', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED);
        expect(await panned(page, 'left')).toBe(true);
        expect(await panned(page, 'middle')).toBe(false);
        expect(await middlePressPrevented(page)).toBe(false);
        await zooms(page);
    });

    test('@editor middle: 何もないところの主ボタンのドラッグでパンせず onCanvasPointerDown が呼ばれ、中ボタンのドラッグでパンする。ホイールで拡大縮小する', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit', dragToPan: 'middle' });
        expect(await panned(page, 'left')).toBe(false);
        expect((await logOf(page, 'canvasPointerDown')).map((entry) => [entry.target, entry.button])).toEqual([['blank', 0]]);
        expect(await panned(page, 'middle')).toBe(true);
        expect(await middlePressPrevented(page)).toBe(true);
        await zooms(page);
    });

    test('@editor both: 何もないところの主ボタンと中ボタンのどちらのドラッグでもパンする。ホイールで拡大縮小する', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit', dragToPan: 'both' });
        expect(await panned(page, 'left')).toBe(true);
        expect(await panned(page, 'middle')).toBe(true);
        expect(await middlePressPrevented(page)).toBe(true);
        await zooms(page);
    });

    test('@editor middle は interaction が view の図でも同じに効く', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { dragToPan: 'middle' });
        expect(await panned(page, 'left')).toBe(false);
        expect(await panned(page, 'middle')).toBe(true);
    });

    test('@editor dragToPan だけを変える setOptions のあとに onLayout が呼ばれない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        await page.waitForTimeout(300);
        const layouts = (): Promise<number> => page.evaluate(() => (window as unknown as EditorWindow).layouts.a ?? 0);
        const before = await layouts();
        expect(before).toBeGreaterThan(0);
        for (const dragToPan of ['middle', 'both', 'primary'] as const) {
            await setOptions(page, { dragToPan });
            await page.waitForTimeout(150);
        }
        expect(await layouts()).toBe(before);
    });
});

test.describe('ダブルクリック (段 9、2.2 の onNodeDoubleClick と onFrameDoubleClick、B-048〜B-052、B-26)', () => {
    test('@editor edit: ラベルで label、ノードの中に開いた詳細で details、吹き出しの詳細で popover と一緒に呼ばれ、図はズームしない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        const before = await transformOf(page);
        const dblclick = async (point: Point): Promise<void> => {
            await page.mouse.move(point.x, point.y);
            await page.mouse.dblclick(point.x, point.y);
        };

        await dblclick(await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` }));
        await expect.poll(() => logOf(page, 'nodeDoubleClick')).toEqual([{ root: 'a', hook: 'nodeDoubleClick', id: DESIGN, place: 'label' }]);

        await page.locator(`${node('a', TASK_A)} .mdag-note-mark`).dispatchEvent('click');
        expect(await popoverOpen(page)).toBe(true);
        await dblclick(await spot(page, { on: 'element', selector: '#a .mdag-popover .mdag-details > p' }));
        await expect.poll(async () => (await logOf(page, 'nodeDoubleClick')).at(-1)).toEqual({ root: 'a', hook: 'nodeDoubleClick', id: TASK_A, place: 'popover' });

        await setOptions(page, { details: 'always' });
        await dblclick(await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-content .mdag-details` }));
        await expect.poll(async () => (await logOf(page, 'nodeDoubleClick')).at(-1)).toEqual({ root: 'a', hook: 'nodeDoubleClick', id: TASK_A, place: 'details' });

        await settle(page);
        expect((await transformOf(page))?.k).toBe(before?.k);
        expect(await logOf(page, 'nodeDoubleClick')).toHaveLength(3);
    });

    test('@editor view でもラベルのダブルクリックで label と一緒に呼ばれ、図はズームしない', async ({ page }) => {
        await open(page);
        await mountView(page, OPEN);
        const before = await transformOf(page);
        const point = await spot(page, { on: 'text', selector: `${node('a', BUILD)} .mdag-content` });
        await page.mouse.dblclick(point.x, point.y);
        await expect.poll(() => logOf(page, 'nodeDoubleClick')).toEqual([{ root: 'a', hook: 'nodeDoubleClick', id: BUILD, place: 'label' }]);
        await settle(page);
        expect((await transformOf(page))?.k).toBe(before?.k);
    });

    test('@editor edit: 枠の内側とラベルのダブルクリックで onFrameDoubleClick が呼ばれ、onNodeDoubleClick は呼ばれない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        for (const selector of [`#a .mdag-frame[data-group="${GROUP}"]`, `#a .mdag-frame-label[data-group="${GROUP}"]`]) {
            const point = await spot(page, { on: 'element', selector });
            await page.mouse.dblclick(point.x, point.y);
        }
        await expect.poll(() => logOf(page, 'frameDoubleClick')).toEqual([
            { root: 'a', hook: 'frameDoubleClick', id: GROUP },
            { root: 'a', hook: 'frameDoubleClick', id: GROUP },
        ]);
        await settle(page);
        expect(await logOf(page, 'nodeDoubleClick')).toEqual([]);
    });

    test('@editor edit: タグの上 (ノードの中と吹き出しの中) のダブルクリックでは onNodeDoubleClick が呼ばれない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' }, 'a');
        const inNode = await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` });
        await page.mouse.dblclick(inNode.x, inNode.y);

        // タグを吹き出しに出す文書 (tags.display: click)
        await mountView(page, docOf(false, 'click'), { interaction: 'edit' }, 'a');
        await page.locator(`${node('a', TASK_A)} .mdag-note-mark`).dispatchEvent('click');
        await expect(page.locator('#a .mdag-popover .mdag-popover-tags')).toBeVisible();
        const inPopover = await spot(page, { on: 'element', selector: '#a .mdag-popover .mdag-popover-tags' });
        await page.mouse.dblclick(inPopover.x, inPopover.y);
        await settle(page);
        expect(await logOf(page, 'nodeDoubleClick')).toEqual([]);

        // 同じ吹き出しの詳細なら呼ばれる (タグだけを外していることの確かめ)
        const details = await spot(page, { on: 'element', selector: '#a .mdag-popover .mdag-details > p:not(.mdag-popover-tags)' });
        await page.mouse.dblclick(details.x, details.y);
        await expect.poll(() => logOf(page, 'nodeDoubleClick')).toEqual([{ root: 'a', hook: 'nodeDoubleClick', id: TASK_A, place: 'popover' }]);
    });

    test('@editor edit: 何もないところのダブルクリックでは、どのダブルクリックの受け口も呼ばれず、図はズームしない', async ({ page }) => {
        await open(page);
        await mountView(page, LOCKED, { interaction: 'edit' });
        const before = await transformOf(page);
        const blank = await spot(page, { on: 'blank', root: '#a' });
        await page.mouse.dblclick(blank.x, blank.y);
        await settle(page);
        expect(await transformOf(page)).toEqual(before);
        expect(await logOf(page, 'nodeDoubleClick')).toEqual([]);
        expect(await logOf(page, 'frameDoubleClick')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// 読み取りの出口とタグの要素

const LOGO_REF = 'simple-icons:github';
// id を持たない SVG (写しごとの id の付け替えが起きないので、凡例の写しと groupLogo の写しを outerHTML で比べられる)
const LOGO_SVG = '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';
const LOGO_SVG_2 = '<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
const SVGS = { [LOGO_REF]: LOGO_SVG };

// ノードの id は前の半分の文書と同じ並び (Root = 1, Design = 2, Task A = 3, Task B = 4, Build = 5, Deep = 6, Leaf = 7)。
// Task A のタグは owner (ロゴなし)、tool (値 gh に SVG のロゴ gh)、prio (キーに絵文字のロゴ fire)。Deep のタグは owner だけ。Leaf は詳細を持つ。
// グループ design は SVG のロゴ (gh)、build は絵文字のロゴ (fire)、plain (Task B) はロゴなし。枝の起点は Design と Build。
// Build から Design へ depends の線がある
function taggedDoc(tagDisplay: 'always' | 'click' = 'always', branches = true): string {
    return [
        '---',
        'markdag:',
        '    icons:',
        `        gh: ${LOGO_REF}`,
        '        fire: "🔥"',
        ...(branches ? ['    branches:', '        - Design', '        - Build'] : []),
        '    relations:',
        '        depends:',
        '            - $api --> Design',
        '    groups:',
        '        design:',
        '            label: 設計',
        '            color: "#3B7DD8"',
        '            boundary: true',
        '            icon: gh',
        '        build:',
        '            label: 実装',
        '            color: "#D8823B"',
        '            boundary: true',
        '            icon: fire',
        '        plain:',
        '            label: 無地',
        '            color: "#888888"',
        '    details:',
        '        display: click',
        '    tags:',
        `        display: ${tagDisplay}`,
        '        keys:',
        '            tool:',
        '                type: string',
        '                icons: { gh: gh }',
        '            prio:',
        '                type: string',
        '                icon: fire',
        '---',
        '',
        '# Root',
        '',
        '## Design %design',
        '',
        '- [ ] Task A #owner:alice #tool:gh #prio:high',
        '    > 詳細の文',
        '- [x] Task B %plain',
        '',
        '## Build $api %build',
        '',
        '### Deep #owner:bob',
        '',
        '- Leaf',
        '    > 葉の詳細',
        '',
    ].join('\n');
}
// タグをノードの中に出す文書
const TAGGED = taggedDoc();
// タグを吹き出しに出す文書 (tags.display: click)
const TAGGED_CLICK = taggedDoc('click');
const DEEP = 6;
const LEAF = 7;
// Task A のタグを分けたときの子の並び (タグの要素の間は空白 1 つの文字)
const SPLIT_TASK_A = ['tag:owner', 'text: ', 'tag:tool', 'text: ', 'tag:prio'];
// 図の出口の 9 つの受け口を記録する名前
const EXIT_HOOKS = ['canvasClick', 'canvasPointerDown', 'edgeClick', 'frameClick', 'frameDoubleClick', 'iconSvg', 'nodeDoubleClick', 'nodePointerDown', 'tagClick'];

interface TagLine {
    // 子の並び。タグの要素は「tag:キー」、ほかの要素は「element:名前」、文字は「text:中身」
    children: string[];
    text: string;
    html: string;
    // タグの要素ごとの中身 (innerHTML)
    parts: string[];
    // ロゴ (.mdag-icon) の数
    icons: number;
}

async function tagLineOf(page: Page, selector: string): Promise<TagLine | null> {
    return page.evaluate((selector) => {
        const line = document.querySelector<HTMLElement>(selector);
        if (!line) return null;
        return {
            children: [...line.childNodes].map((child) => {
                if (!(child instanceof Element)) return `text:${child.textContent ?? ''}`;
                return child.matches('.mdag-tag') ? `tag:${child.getAttribute('data-tag-key') ?? ''}` : `element:${child.tagName.toLowerCase()}`;
            }),
            text: line.textContent ?? '',
            html: line.innerHTML,
            parts: [...line.children].filter((child) => child.matches('.mdag-tag')).map((child) => child.innerHTML),
            icons: line.querySelectorAll('.mdag-icon').length,
        };
    }, selector);
}

// edit で分けたタグの並びが、view で描いた (分けない) 並びと同じ文字と中身を持つ。
// 中身は今のタグ 1 つ分と同じで、タグの間は空白 1 つの文字
function expectSameTags(edit: TagLine | null, view: TagLine | null, children: string[]): void {
    expect(view).not.toBeNull();
    expect(edit).not.toBeNull();
    expect(view?.children.filter((child) => child.startsWith('tag:'))).toEqual([]);
    expect(edit?.children).toEqual(children);
    expect(edit?.text).toBe(view?.text);
    expect(edit?.parts.join(' ')).toBe(view?.html);
    expect(edit?.icons).toBe(view?.icons);
}

// createHookBridge と MarkdagView で組む (render と同じつなぎ方)。resolveIcon は Promise を返し、解決は resolvePending まで止める。
// own が true なら、図の出口の 9 つの受け口をアプリの viewHooks として橋渡しに渡し、view は bridge.viewHooks だけで組む。
// false なら、橋渡しの素通しに頼らずに、onIconSvg だけを view の受け口に直に足す (呼ばれた時点の凡例と groupLogo の様子も記録する)
async function mountBridged(page: Page, markdown: string, options: Partial<ViewOptions> = {}, root = 'a', own = false): Promise<void> {
    if ((await page.locator('link[href="/src/style.css"]').count()) === 0) await page.addStyleTag({ url: '/src/style.css' });
    await page.evaluate(
        ({ markdown, options, root, own }) => {
            const w = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error('container is missing');
            const { markdag } = w.harness;
            const push = (entry: Omit<Entry, 'root'>): void => void w.log.push({ root, ...entry });
            const keyOf = (placed: { edge: { kind: string; source: number; target: number } }): string => `${placed.edge.kind}:${placed.edge.source}>${placed.edge.target}`;
            const exits = {
                onNodePointerDown: (target: OutlineNode) => push({ hook: 'nodePointerDown', id: target.id }),
                onNodeDoubleClick: (target: OutlineNode, place: string) => push({ hook: 'nodeDoubleClick', id: target.id, place }),
                onTagClick: (target: OutlineNode, key: string, place: string) => push({ hook: 'tagClick', id: target.id, key, place }),
                onEdgeClick: (edge: { edge: { kind: string; source: number; target: number } }) => push({ hook: 'edgeClick', key: keyOf(edge) }),
                onFrameClick: (id: string) => push({ hook: 'frameClick', id }),
                onFrameDoubleClick: (id: string) => push({ hook: 'frameDoubleClick', id }),
                onCanvasPointerDown: (_event: PointerEvent, target: { kind: string }) => push({ hook: 'canvasPointerDown', target: target.kind }),
                onCanvasClick: () => push({ hook: 'canvasClick' }),
                onIconSvg: (ref: string) => push({ hook: 'iconSvg', key: ref }),
            } as ViewHooks;
            w.views[root]?.destroy();
            const bridge = markdag.createHookBridge({
                source: () => markdown,
                resolveIcon: (ref: string) => new Promise<string | null>((resolve) => void w.pending.push({ root, ref, resolve })),
                viewHooks: own ? exits : {},
            });
            const hooks = own
                ? bridge.viewHooks
                : ({
                      ...bridge.viewHooks,
                      onIconSvg: (ref: string) => {
                          const legendRow = [...container.querySelectorAll('.mdag-legend li')].find((item) => item.textContent?.includes('設計'));
                          const logo = (w.views[root] as unknown as { groupLogo: (id: string) => Element | null }).groupLogo('design');
                          push({ hook: 'iconSvg', key: ref, legendSvg: legendRow?.querySelector('.mdag-icon svg') != null, logoSvg: logo?.querySelector('svg') != null });
                      },
                  } as ViewHooks);
            const view = new markdag.MarkdagView(container, hooks);
            w.views[root] = view;
            bridge.attach(view);
            view.setOptions({ animate: false, ...options });
            const parsed = markdag.parseDocument(markdown);
            bridge.setDocument(parsed, markdag.buildModel(parsed.nodes, parsed.frontmatter, markdown), true);
        },
        { markdown, options, root, own },
    );
}

// 止めておいた resolveIcon の Promise を全部 svg で解決する。解決した数を返す
const resolvePending = (page: Page, svg: string | null): Promise<number> =>
    page.evaluate((svg) => {
        const pending = (window as unknown as EditorWindow).pending.splice(0);
        for (const item of pending) item.resolve(svg);
        return pending.length;
    }, svg);
const pendingRefs = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as EditorWindow).pending.map((item) => `${item.root}:${item.ref}`));
const setIconSvg = (page: Page, ref: string, svg: string | null, root = 'a'): Promise<void> =>
    page.evaluate(({ ref, svg, root }) => (window as unknown as EditorWindow).views[root]?.setIconSvg(ref, svg), { ref, svg, root });
const openPopover = (page: Page, id: number, root = 'a'): Promise<void> => page.locator(`${node(root, id)} .mdag-note-mark`).dispatchEvent('click');
const setDocumentOf = (page: Page, markdown: string, root = 'a'): Promise<void> =>
    page.evaluate(
        ({ markdown, root }) => {
            const w = window as unknown as EditorWindow;
            const parsed = w.harness.markdag.parseDocument(markdown);
            w.views[root]?.setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, markdown), false);
        },
        { markdown, root },
    );

// branchColors の戻り値。色は凡例の線の style.stroke と同じ読み方 (ブラウザが直した書き方) にそろえる
const branchColorsOf = (page: Page, root = 'a'): Promise<Array<{ id: number; label: string; color: string }>> =>
    page.evaluate((root) => {
        const view = (window as unknown as EditorWindow).views[root] as unknown as { branchColors: () => Array<{ id: number; label: string; color: string }> };
        const probe = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        return view.branchColors().map((branch) => {
            probe.style.stroke = '';
            probe.style.stroke = branch.color;
            return { id: branch.id, label: branch.label, color: probe.style.stroke };
        });
    }, root);

// 図の凡例の行のロゴ (outerHTML) と、groupLogo の戻り値 (outerHTML。null はそのまま)
async function logosOf(page: Page, root = 'a'): Promise<{ legend: Record<string, string | null>; logo: Record<string, string | null> }> {
    return page.evaluate((root) => {
        const view = (window as unknown as EditorWindow).views[root] as unknown as { groupLogo: (id: string) => Element | null };
        const legendIcon = (label: string): string | null =>
            [...document.querySelectorAll(`#${root} .mdag-legend li`)].find((item) => item.textContent?.includes(label))?.querySelector('.mdag-icon')?.outerHTML ?? null;
        const logo = (id: string): string | null => view.groupLogo(id)?.outerHTML ?? null;
        return {
            legend: { design: legendIcon('設計'), build: legendIcon('実装'), plain: legendIcon('無地') },
            logo: { design: logo('design'), build: logo('build'), plain: logo('plain'), unknown: logo('nope') },
        };
    }, root);
}

// addHooks の確かめ: コンストラクタの受け口を listenersOf('ctor') で組む (ctor が false なら受け口なしで組む)
async function mountListened(page: Page, markdown: string, options: Partial<ViewOptions> = {}, root = 'a', ctor = true): Promise<void> {
    if ((await page.locator('link[href="/src/style.css"]').count()) === 0) await page.addStyleTag({ url: '/src/style.css' });
    await page.evaluate(
        ({ markdown, options, root, ctor }) => {
            const w = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error('container is missing');
            w.views[root]?.destroy();
            const view = ctor ? new w.harness.markdag.MarkdagView(container, w.listenersOf('ctor')) : new w.harness.markdag.MarkdagView(container);
            view.setOptions({ animate: false, ...options });
            const parsed = w.harness.markdag.parseDocument(markdown);
            view.setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, markdown), true);
            w.views[root] = view;
        },
        { markdown, options, root, ctor },
    );
}

const addListeners = (page: Page, tag: string, root = 'a'): Promise<void> =>
    page.evaluate(
        ({ tag, root }) => {
            const w = window as unknown as EditorWindow;
            const view = w.views[root] as unknown as { addHooks: (hooks: ViewHooks) => () => void };
            w.removers[tag] = view.addHooks(w.listenersOf(tag));
        },
        { tag, root },
    );
const removeListeners = (page: Page, tag: string): Promise<void> => page.evaluate((tag) => (window as unknown as EditorWindow).removers[tag]?.(), tag);
const setAllow = (page: Page, allow: Record<string, boolean>): Promise<void> => page.evaluate((allow) => void ((window as unknown as EditorWindow).allow = allow), allow);
const allCalls = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as EditorWindow).calls]);
// 受け口の名前 (「出どころ:受け口:引数」の 2 つ目) で絞る
const callsOf = async (page: Page, hook: string): Promise<string[]> => (await allCalls(page)).filter((call) => call.split(':')[1] === hook);
const clearCalls = (page: Page): Promise<void> => page.evaluate(() => void ((window as unknown as EditorWindow).calls.length = 0));
const setFolded = (page: Page, ids: number[], root = 'a'): Promise<void> => page.evaluate(({ ids, root }) => (window as unknown as EditorWindow).views[root]?.setFolded(ids), { ids, root });

// render の図。guard で文書のフック (アプリの hooks) を足す: beforeUpdate は allow.update が false のとき取りやめ、
// beforeSelectGroup は allow.doc が false のとき取りやめ、transform は原文の末尾に見出しを 1 つ足す (transformSource)。
// onChange に届いた原文は changes に残す
async function renderGuarded(page: Page, markdown: string, root = 'a', guard: 'none' | 'beforeUpdate' | 'beforeSelectGroup' | 'transform' = 'none'): Promise<void> {
    await page.evaluate(
        ({ markdown, root, guard }) => {
            const w = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error('container is missing');
            const hooks =
                guard === 'beforeUpdate'
                    ? { beforeUpdate: () => w.allow.update !== false }
                    : guard === 'beforeSelectGroup'
                      ? { beforeSelectGroup: () => w.allow.doc !== false }
                      : guard === 'transform'
                        ? { transformSource: (context: { source: string }) => `${context.source}\n## Extra\n` }
                        : undefined;
            w.diagrams[root] = w.harness.markdag.render(container, markdown, { animate: false, hooks, onChange: (next: string) => void w.changes.push(next) });
            w.views[root] = w.diagrams[root].view;
        },
        { markdown, root, guard },
    );
}
const sourceOf = (page: Page, root = 'a'): Promise<string | undefined> =>
    page.evaluate((root) => ((window as unknown as EditorWindow).diagrams[root] as unknown as { source?: string }).source, root);
const updateDiagram = (page: Page, markdown: string, root = 'a'): Promise<void> =>
    page.evaluate(({ markdown, root }) => void (window as unknown as EditorWindow).diagrams[root]?.update(markdown), { markdown, root });

test.describe('タグを 1 つずつの要素にする (段 10、2.1 の (5)、2.4、2.6、W-6、B-053、B-054、B-26、B-27)', () => {
    test('@editor edit: ノードの中のタグが .mdag-tag[data-tag-key] に分かれ、間は空白 1 つの文字で、文字と中身 (ロゴを含む) は閲覧の図と同じ', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED, { interaction: 'edit' }, 'a', SVGS);
        await mountView(page, TAGGED, {}, 'b', SVGS);
        const view = await tagLineOf(page, `${node('b', TASK_A)} .mdag-tags`);
        expect(view?.icons).toBe(2);
        expectSameTags(await tagLineOf(page, `${node('a', TASK_A)} .mdag-tags`), view, SPLIT_TASK_A);
        expectSameTags(await tagLineOf(page, `${node('a', DEEP)} .mdag-tags`), await tagLineOf(page, `${node('b', DEEP)} .mdag-tags`), ['tag:owner']);

        // ロゴは、そのタグの要素の中にある (値のロゴは SVG、キーのロゴは絵文字)
        const tag = (key: string): string => `${node('a', TASK_A)} .mdag-tags > .mdag-tag[data-tag-key="${key}"]`;
        await expect(page.locator(tag('owner'))).toHaveText('#owner:alice');
        await expect(page.locator(`${tag('tool')} .mdag-icon[data-icon="gh"] svg`)).toHaveCount(1);
        await expect(page.locator(`${tag('prio')} .mdag-icon[data-icon="fire"]`)).toHaveCount(1);
        // タグの要素はタグを持つノードの分だけ (Task A の 3 つと Deep の 1 つ)
        await expect(page.locator('#a .mdag-tag')).toHaveCount(4);
    });

    test('@editor edit: ノードの中のタグのクリックで onTagClick がノード、キー、place node と一緒に呼ばれる。ロゴの上も同じで、ダブルクリックでは 2 回呼ばれる', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED, { interaction: 'edit' }, 'a', SVGS);
        const tag = (id: number, key: string): string => `${node('a', id)} .mdag-tags .mdag-tag[data-tag-key="${key}"]`;
        await press(page, await spot(page, { on: 'element', selector: tag(TASK_A, 'owner') }));
        await press(page, await spot(page, { on: 'element', selector: `${tag(TASK_A, 'tool')} .mdag-icon` }));
        await press(page, await spot(page, { on: 'element', selector: `${tag(TASK_A, 'prio')} .mdag-icon` }));
        await press(page, await spot(page, { on: 'element', selector: tag(DEEP, 'owner') }));
        await expect.poll(() => logOf(page, 'tagClick')).toEqual([
            { root: 'a', hook: 'tagClick', id: TASK_A, key: 'owner', place: 'node' },
            { root: 'a', hook: 'tagClick', id: TASK_A, key: 'tool', place: 'node' },
            { root: 'a', hook: 'tagClick', id: TASK_A, key: 'prio', place: 'node' },
            { root: 'a', hook: 'tagClick', id: DEEP, key: 'owner', place: 'node' },
        ]);

        await page.waitForTimeout(600);
        await clearLog(page);
        const point = await spot(page, { on: 'element', selector: tag(TASK_A, 'tool') });
        await page.mouse.move(point.x, point.y);
        await page.mouse.dblclick(point.x, point.y);
        const twice = { root: 'a', hook: 'tagClick', id: TASK_A, key: 'tool', place: 'node' };
        await expect.poll(() => logOf(page, 'tagClick')).toEqual([twice, twice]);
        await settle(page);
        expect(await logOf(page, 'tagClick')).toHaveLength(2);
        expect(await logOf(page, 'nodeDoubleClick')).toEqual([]);
    });

    test('@editor edit: 吹き出しのタグも .mdag-tag に分かれ (閲覧の吹き出しと同じ文字と中身)、押すと onTagClick が place popover と一緒に呼ばれ、吹き出しは開いたまま', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED_CLICK, {}, 'b', SVGS);
        await openPopover(page, TASK_A, 'b');
        await mountView(page, TAGGED_CLICK, { interaction: 'edit' }, 'a', SVGS);
        await openPopover(page, TASK_A, 'a');
        expect(await popoverOpen(page, 'a')).toBe(true);
        expect(await popoverOpen(page, 'b')).toBe(true);
        const view = await tagLineOf(page, '#b .mdag-popover .mdag-popover-tags');
        expect(view?.icons).toBe(2);
        expectSameTags(await tagLineOf(page, '#a .mdag-popover .mdag-popover-tags'), view, SPLIT_TASK_A);

        const tag = (key: string): string => `#a .mdag-popover .mdag-popover-tags .mdag-tag[data-tag-key="${key}"]`;
        await press(page, await spot(page, { on: 'element', selector: tag('owner') }));
        await press(page, await spot(page, { on: 'element', selector: `${tag('tool')} .mdag-icon` }));
        await expect.poll(() => logOf(page, 'tagClick')).toEqual([
            { root: 'a', hook: 'tagClick', id: TASK_A, key: 'owner', place: 'popover' },
            { root: 'a', hook: 'tagClick', id: TASK_A, key: 'tool', place: 'popover' },
        ]);
        expect(await popoverOpen(page, 'a')).toBe(true);

        // 詳細がなくタグだけの吹き出しも同じ
        await openPopover(page, DEEP, 'a');
        await expect.poll(async () => (await tagLineOf(page, '#a .mdag-popover .mdag-popover-tags'))?.children).toEqual(['tag:owner']);
        await press(page, await spot(page, { on: 'element', selector: tag('owner') }));
        await expect.poll(async () => (await logOf(page, 'tagClick')).at(-1)).toEqual({ root: 'a', hook: 'tagClick', id: DEEP, key: 'owner', place: 'popover' });
    });

    test('@editor 既定と view: タグは分かれず (ロゴのあるタグと吹き出しのタグも)、タグを押しても onTagClick は呼ばれない', async ({ page }) => {
        await open(page);
        for (const options of [{}, { interaction: 'view' as const }]) {
            await mountView(page, TAGGED, options, 'a', SVGS);
            await expect(page.locator(`${node('a', TASK_A)} .mdag-tags .mdag-icon`)).toHaveCount(2);
            await expect(page.locator('#a .mdag-tag')).toHaveCount(0);
            await press(page, await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tags` }));

            await mountView(page, TAGGED_CLICK, options, 'a', SVGS);
            await openPopover(page, TASK_A, 'a');
            expect(await popoverOpen(page, 'a')).toBe(true);
            await expect(page.locator('#a .mdag-popover .mdag-popover-tags .mdag-icon')).toHaveCount(2);
            await expect(page.locator('#a .mdag-tag')).toHaveCount(0);
            await press(page, await spot(page, { on: 'element', selector: '#a .mdag-popover .mdag-popover-tags' }));
        }
        await settle(page);
        expect(await logOf(page, 'tagClick')).toEqual([]);
    });

    test('@editor interaction を切り替えると、描いてあるノードと開いている吹き出しのタグを作り直し、view に戻すと最初と同じ中身になる', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED, {}, 'a', SVGS);
        await mountView(page, TAGGED_CLICK, {}, 'b', SVGS);
        await openPopover(page, TASK_A, 'b');
        const nodeLine = `${node('a', TASK_A)} .mdag-tags`;
        const popoverLine = '#b .mdag-popover .mdag-popover-tags';
        const before = { node: await tagLineOf(page, nodeLine), popover: await tagLineOf(page, popoverLine) };

        await setOptions(page, { interaction: 'edit' }, 'a');
        await setOptions(page, { interaction: 'edit' }, 'b');
        await expect.poll(async () => (await tagLineOf(page, nodeLine))?.children).toEqual(SPLIT_TASK_A);
        await expect.poll(async () => (await tagLineOf(page, popoverLine))?.children).toEqual(SPLIT_TASK_A);
        expect(await popoverOpen(page, 'b')).toBe(true);
        expectSameTags(await tagLineOf(page, nodeLine), before.node, SPLIT_TASK_A);
        expectSameTags(await tagLineOf(page, popoverLine), before.popover, SPLIT_TASK_A);

        await setOptions(page, { interaction: 'view' }, 'a');
        await setOptions(page, { interaction: 'view' }, 'b');
        await expect.poll(() => tagLineOf(page, nodeLine)).toEqual(before.node);
        await expect.poll(() => tagLineOf(page, popoverLine)).toEqual(before.popover);
    });

    test('@editor resolveIcon が Promise でロゴがあとから届いても、edit のノードのタグは分かれたままロゴが入る。閲覧の図は分かれない (B-27)', async ({ page }) => {
        await open(page);
        await mountBridged(page, TAGGED, { interaction: 'edit' }, 'a');
        await mountBridged(page, TAGGED, {}, 'b');
        expect(await pendingRefs(page)).toEqual([`a:${LOGO_REF}`, `b:${LOGO_REF}`]);
        const line = (root: string): string => `${node(root, TASK_A)} .mdag-tags`;
        // 届く前: 値のロゴ (SVG) はまだなく、キーのロゴ (絵文字) だけ
        expect((await tagLineOf(page, line('b')))?.icons).toBe(1);
        expectSameTags(await tagLineOf(page, line('a')), await tagLineOf(page, line('b')), SPLIT_TASK_A);

        expect(await resolvePending(page, LOGO_SVG)).toBe(2);
        await expect(page.locator(`${line('a')} > .mdag-tag[data-tag-key="tool"] .mdag-icon[data-icon="gh"] svg`)).toHaveCount(1);
        await expect(page.locator(`${line('b')} .mdag-icon[data-icon="gh"] svg`)).toHaveCount(1);
        expect((await tagLineOf(page, line('b')))?.icons).toBe(2);
        expectSameTags(await tagLineOf(page, line('a')), await tagLineOf(page, line('b')), SPLIT_TASK_A);
    });

    test('@editor resolveIcon が Promise で、吹き出しを開いているあいだにロゴが届いても、edit の吹き出しのタグは分かれたままロゴが入る (B-27)', async ({ page }) => {
        await open(page);
        await mountBridged(page, TAGGED_CLICK, { interaction: 'edit' }, 'a');
        await mountBridged(page, TAGGED_CLICK, {}, 'b');
        await openPopover(page, TASK_A, 'a');
        await openPopover(page, TASK_A, 'b');
        const line = (root: string): string => `#${root} .mdag-popover .mdag-popover-tags`;
        expectSameTags(await tagLineOf(page, line('a')), await tagLineOf(page, line('b')), SPLIT_TASK_A);

        expect(await resolvePending(page, LOGO_SVG)).toBe(2);
        await expect(page.locator(`${line('a')} > .mdag-tag[data-tag-key="tool"] .mdag-icon[data-icon="gh"] svg`)).toHaveCount(1);
        await expect(page.locator(`${line('b')} .mdag-icon[data-icon="gh"] svg`)).toHaveCount(1);
        expect(await popoverOpen(page, 'a')).toBe(true);
        expect(await popoverOpen(page, 'b')).toBe(true);
        expectSameTags(await tagLineOf(page, line('a')), await tagLineOf(page, line('b')), SPLIT_TASK_A);
    });
});

test.describe('吹き出しの目印 (段 10、2.4、W-5)', () => {
    for (const interaction of ['view', 'edit'] as const) {
        test(`@editor ${interaction}: 吹き出しを出しているあいだ .mdag-popover の data-id が相手のノードの id で、別のノードに替えると替わり、閉じると外れる`, async ({ page }) => {
            await open(page);
            await mountView(page, TAGGED_CLICK, { interaction }, 'a');
            const popover = page.locator('#a .mdag-popover');
            await expect(popover).toHaveCount(1);
            await expect(popover).not.toHaveAttribute('data-id');

            for (const id of [TASK_A, LEAF, DEEP]) {
                await openPopover(page, id, 'a');
                expect(await popoverOpen(page, 'a')).toBe(true);
                await expect(popover).toHaveAttribute('data-id', String(id));
            }

            // Esc で閉じる (フォーカスはどこにもなく、ポインタは図の上)
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            const blank = await spot(page, { on: 'blank', root: '#a' });
            await page.mouse.move(blank.x, blank.y);
            await page.keyboard.press('Escape');
            await expect.poll(() => popoverOpen(page, 'a')).toBe(false);
            await expect(popover).not.toHaveAttribute('data-id');
        });
    }
});

test.describe('branchColors (段 10、2.3、B-151、W-4)', () => {
    test('@editor branchColors が、凡例の線の色の段と同じ並び、色、名前で起点のノードの id を返し、凡例を作らない図 (legend: false) でも同じ値を返す', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED, {}, 'a');
        await mountView(page, TAGGED, { legend: false, interaction: 'edit' }, 'b');
        await expect(page.locator('#b .mdag-legend li')).toHaveCount(0);
        const legendRows = await page.evaluate(() =>
            [...document.querySelectorAll('#a .mdag-legend li')].flatMap((item) => {
                const line = item.querySelector<SVGLineElement>('svg line');
                return line ? [{ label: item.textContent ?? '', color: line.style.stroke }] : [];
            }),
        );
        expect(legendRows.map((row) => row.label)).toEqual(['Design', 'Build']);

        const colors = await branchColorsOf(page, 'a');
        expect(colors.map(({ label, color }) => ({ label, color }))).toEqual(legendRows);
        expect(colors.map((branch) => branch.id)).toEqual([DESIGN, BUILD]);
        expect(new Set(colors.map((branch) => branch.color)).size).toBe(2);
        expect(await branchColorsOf(page, 'b')).toEqual(colors);

        // 線の色: Build から出る depends の線は、Build の枝の色で描かれている (凡例の「線の色 = 出発ノードの枝の色」)
        const stroke = await page.evaluate(() => document.querySelector<SVGPathElement>('#a path.mdag-edge[data-key="depends:5>2"]')?.style.stroke ?? null);
        expect(stroke).toBe(colors[1]?.color);
    });

    test('@editor branchColors は枝の起点がない文書では空で、文書を差し替えると新しい文書の起点を返す', async ({ page }) => {
        await open(page);
        await mountView(page, taggedDoc('always', false));
        expect(await branchColorsOf(page)).toEqual([]);
        await setDocumentOf(page, TAGGED);
        expect((await branchColorsOf(page)).map((branch) => [branch.id, branch.label])).toEqual([
            [DESIGN, 'Design'],
            [BUILD, 'Build'],
        ]);
    });
});

test.describe('groupLogo と onIconSvg (段 10、2.2、2.3、A-27、B-16、B-148、W-4)', () => {
    test('@editor groupLogo が、icon を書いたグループで図の凡例の行と同じロゴの要素 (SVG と絵文字) を呼ぶたびに新しく作って返し、icon のないグループと知らない id では null', async ({ page }) => {
        await open(page);
        await mountView(page, TAGGED, {}, 'a', SVGS);
        await mountView(page, TAGGED, { legend: false, interaction: 'edit' }, 'b', SVGS);
        const a = await logosOf(page, 'a');
        expect(a.legend.design).toContain('<svg');
        expect(a.legend.build).toContain('🔥');
        expect(a.legend.plain).toBeNull();
        expect(a.logo).toEqual({ design: a.legend.design, build: a.legend.build, plain: null, unknown: null });
        // 凡例を作らない図でも同じロゴを返す
        expect((await logosOf(page, 'b')).logo).toEqual(a.logo);

        const fresh = await page.evaluate(() => {
            const view = (window as unknown as EditorWindow).views.a as unknown as { groupLogo: (id: string) => Element | null };
            const first = view.groupLogo('design');
            const second = view.groupLogo('design');
            return { distinct: first !== null && second !== null && first !== second, connected: (first?.isConnected ?? true) || (second?.isConnected ?? true) };
        });
        expect(fresh).toEqual({ distinct: true, connected: false });
        // 図の凡例のロゴはそのまま (返した要素は凡例から抜いたものではない)
        await expect(page.locator('#a .mdag-legend .mdag-icon')).toHaveCount(2);
    });

    test('@editor resolveIcon が Promise のとき、届く前の groupLogo は SVG のない要素で、届くと凡例と groupLogo を描き直したあとに onIconSvg が ref と一緒に呼ばれる (A-27、B-16)', async ({ page }) => {
        await open(page);
        await mountBridged(page, TAGGED, {}, 'a');
        expect(await pendingRefs(page)).toEqual([`a:${LOGO_REF}`]);
        const before = await page.evaluate(() => {
            const logo = ((window as unknown as EditorWindow).views.a as unknown as { groupLogo: (id: string) => Element | null }).groupLogo('design');
            return { exists: logo !== null, svg: logo?.querySelector('svg') != null };
        });
        expect(before).toEqual({ exists: true, svg: false });
        const emoji = await logosOf(page, 'a');
        expect(emoji.logo.build).toBe(emoji.legend.build);
        expect(await logOf(page, 'iconSvg')).toEqual([]);

        await resolvePending(page, LOGO_SVG);
        await expect.poll(() => logOf(page, 'iconSvg')).toEqual([{ root: 'a', hook: 'iconSvg', key: LOGO_REF, legendSvg: true, logoSvg: true }]);
        const after = await logosOf(page, 'a');
        expect(after.logo.design).toContain('<svg');
        expect(after.logo.design).toBe(after.legend.design);

        // 同じ SVG をもう一度入れても (変わらない) 呼ばれず、違う SVG なら呼ばれる
        await setIconSvg(page, LOGO_REF, LOGO_SVG);
        await settle(page);
        expect(await logOf(page, 'iconSvg')).toHaveLength(1);
        await setIconSvg(page, LOGO_REF, LOGO_SVG_2);
        await expect.poll(async () => (await logOf(page, 'iconSvg')).length).toBe(2);
        const changed = await logosOf(page, 'a');
        expect(changed.logo.design).toContain('M4 4h16v16H4z');
        expect(changed.logo.design).toBe(changed.legend.design);
    });
});

test.describe('getDocument (段 10、2.3)', () => {
    test('@editor getDocument が、setDocument の前は null で、そのあとは最後の setDocument に渡した parsed と model を返す', async ({ page }) => {
        await open(page);
        await page.addStyleTag({ url: '/src/style.css' });
        const result = await page.evaluate(
            ({ first, second }) => {
                const w = window as unknown as EditorWindow;
                const { markdag } = w.harness;
                const container = document.getElementById('a');
                if (!container) throw new Error('container is missing');
                const view = new markdag.MarkdagView(container);
                w.views.a = view;
                const read = (): { parsed: unknown; model: unknown } | null => (view as unknown as { getDocument: () => { parsed: unknown; model: unknown } | null }).getDocument();
                view.setOptions({ animate: false });
                const empty = read();
                const parsed1 = markdag.parseDocument(first);
                const model1 = markdag.buildModel(parsed1.nodes, parsed1.frontmatter, first);
                view.setDocument(parsed1, model1, true);
                const doc1 = read();
                const parsed2 = markdag.parseDocument(second);
                const model2 = markdag.buildModel(parsed2.nodes, parsed2.frontmatter, second);
                view.setDocument(parsed2, model2, false);
                const doc2 = read();
                return { empty, first: doc1?.parsed === parsed1 && doc1?.model === model1, second: doc2?.parsed === parsed2 && doc2?.model === model2 };
            },
            { first: TAGGED, second: OPEN },
        );
        expect(result).toEqual({ empty: null, first: true, second: true });
    });

    test('@editor render の図では、transformSource のあとの文で解析したものを返し、update のあとは新しい文書、beforeUpdate が取りやめたら前のまま', async ({ page }) => {
        await open(page);
        const outline = (root: string) =>
            page.evaluate((root) => {
                const view = (window as unknown as EditorWindow).views[root] as unknown as { getDocument: () => { parsed: { nodes: OutlineNode[] }; model: { groups: Array<{ id: string }>; tagsOf: Map<number, unknown[]> } } | null };
                const doc = view.getDocument();
                if (!doc) return null;
                return {
                    nodes: doc.parsed.nodes.map((item) => item.refText),
                    groups: doc.model.groups.map((group) => group.id),
                    tagged: [...doc.model.tagsOf].filter(([, tags]) => tags.length > 0).map(([id]) => id),
                };
            }, root);
        await renderGuarded(page, TAGGED, 'a', 'transform');
        expect(await outline('a')).toEqual({
            nodes: ['Root', 'Design', 'Task A', 'Task B', 'Build', 'Deep', 'Leaf', 'Extra'],
            groups: ['design', 'build', 'plain'],
            tagged: [TASK_A, DEEP],
        });
        await updateDiagram(page, TAGGED.replace('Task B', 'Task C'), 'a');
        expect((await outline('a'))?.nodes).toEqual(['Root', 'Design', 'Task A', 'Task C', 'Build', 'Deep', 'Leaf', 'Extra']);

        await renderGuarded(page, TAGGED, 'b', 'beforeUpdate');
        const kept = await page.evaluate((next) => {
            const w = window as unknown as EditorWindow;
            const view = w.views.b as unknown as { getDocument: () => { parsed: unknown; model: unknown } | null };
            const before = view.getDocument();
            w.allow = { update: false };
            w.diagrams.b?.update(next);
            const after = view.getDocument();
            return before !== null && after?.parsed === before.parsed && after?.model === before.model;
        }, TAGGED.replace('Task B', 'Task C'));
        expect(kept).toBe(true);
    });
});

test.describe('addHooks (段 10、2.3)', () => {
    test('@editor 足した受け口は、コンストラクタの受け口のあとに足した順で呼ばれ (図の出口の受け口も)、戻り値の関数で外れる', async ({ page }) => {
        await open(page);
        await mountListened(page, TAGGED, { interaction: 'edit' });
        await addListeners(page, 'add1');
        await addListeners(page, 'add2');
        await selectGroup(page, 'design');
        await setFolded(page, [DEEP]);
        await press(page, await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tag[data-tag-key="owner"]` }));
        await expect.poll(() => callsOf(page, 'onTagClick')).toEqual(['ctor:onTagClick:3:owner:node', 'add1:onTagClick:3:owner:node', 'add2:onTagClick:3:owner:node']);
        expect(await callsOf(page, 'beforeSelectGroup')).toEqual(['ctor:beforeSelectGroup:design', 'add1:beforeSelectGroup:design', 'add2:beforeSelectGroup:design']);
        expect(await callsOf(page, 'onSelectGroup')).toEqual(['ctor:onSelectGroup:design', 'add1:onSelectGroup:design', 'add2:onSelectGroup:design']);
        expect(await callsOf(page, 'onFoldChange')).toEqual(['ctor:onFoldChange:6', 'add1:onFoldChange:6', 'add2:onFoldChange:6']);

        await removeListeners(page, 'add1');
        await clearCalls(page);
        await selectGroup(page, 'build');
        await setFolded(page, []);
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await expect.poll(() => callsOf(page, 'onCanvasClick')).toEqual(['ctor:onCanvasClick', 'add2:onCanvasClick']);
        expect(await callsOf(page, 'onSelectGroup')).toEqual(['ctor:onSelectGroup:build', 'add2:onSelectGroup:build']);
        expect(await callsOf(page, 'onFoldChange')).toEqual(['ctor:onFoldChange:', 'add2:onFoldChange:']);
    });

    test('@editor before 系: コンストラクタの受け口が false を返すと足した受け口は呼ばれず、足した受け口が false を返すと取りやめる', async ({ page }) => {
        await open(page);
        await mountListened(page, TAGGED);
        await addListeners(page, 'add');
        const act = async (): Promise<void> => {
            await clearCalls(page);
            await selectGroup(page, 'design');
            await openPopover(page, TASK_A, 'a');
            await settle(page);
        };

        await setAllow(page, { ctor: false });
        await act();
        expect(await allCalls(page)).toEqual(['ctor:beforeSelectGroup:design', 'ctor:beforeDetailsShow:3']);
        expect(await highlightOf(page)).toEqual({ edge: false, faded: [] });
        expect(await popoverOpen(page)).toBe(false);

        await setAllow(page, { add: false });
        await act();
        expect(await allCalls(page)).toEqual(['ctor:beforeSelectGroup:design', 'add:beforeSelectGroup:design', 'ctor:beforeDetailsShow:3', 'add:beforeDetailsShow:3']);
        expect(await highlightOf(page)).toEqual({ edge: false, faded: [] });
        expect(await popoverOpen(page)).toBe(false);

        await setAllow(page, {});
        await act();
        expect(await allCalls(page)).toEqual([
            'ctor:beforeSelectGroup:design',
            'add:beforeSelectGroup:design',
            'ctor:onSelectGroup:design',
            'add:onSelectGroup:design',
            'ctor:beforeDetailsShow:3',
            'add:beforeDetailsShow:3',
            'ctor:onDetailsShow:3',
            'add:onDetailsShow:3',
        ]);
        expect((await highlightOf(page)).faded.length).toBeGreaterThan(0);
        expect(await popoverOpen(page)).toBe(true);
    });

    test('@editor before 系: コンストラクタに受け口がなくても、足した受け口が false を返すと取りやめる', async ({ page }) => {
        await open(page);
        await mountListened(page, TAGGED, {}, 'a', false);
        await addListeners(page, 'add');
        await setAllow(page, { add: false });
        await selectGroup(page, 'design');
        await settle(page);
        expect(await allCalls(page)).toEqual(['add:beforeSelectGroup:design']);
        expect(await highlightOf(page)).toEqual({ edge: false, faded: [] });
    });

    test('@editor destroy で足した受け口が外れる (そのあとのメソッドの呼び出しで呼ばれず、外す関数を呼んでも投げない)', async ({ page }) => {
        await open(page);
        await mountListened(page, TAGGED);
        await addListeners(page, 'add');
        const result = await page.evaluate(() => {
            const w = window as unknown as EditorWindow;
            const view = w.views.a;
            if (!view) throw new Error('view is missing');
            view.destroy();
            w.calls.length = 0;
            for (const act of [() => view.selectGroup('design'), () => view.setFolded([6]), () => view.selectGroup(null)]) {
                try {
                    act();
                } catch {
                    // 片付けたあとの呼び出しが投げるかは見ない (足した受け口が呼ばれないことだけを見る)
                }
            }
            let removeError: string | null = null;
            try {
                w.removers.add?.();
            } catch (error) {
                removeError = String(error);
            }
            return { calls: w.calls.filter((call) => call.startsWith('add:')), removeError };
        });
        expect(result).toEqual({ calls: [], removeError: null });
    });

    test('@editor addHooks に decorateNode を渡しても飾りは足されず、コンストラクタの飾りはそのまま', async ({ page }) => {
        await open(page);
        await page.addStyleTag({ url: '/src/style.css' });
        await page.evaluate(
            ({ markdown, design }) => {
                const w = window as unknown as EditorWindow;
                const container = document.getElementById('a');
                if (!container) throw new Error('container is missing');
                const view = new w.harness.markdag.MarkdagView(container, { decorateNode: (target) => (target.id === design ? { className: 'ctor-deco' } : null) });
                view.setOptions({ animate: false });
                const parsed = w.harness.markdag.parseDocument(markdown);
                view.setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, markdown), true);
                w.views.a = view;
                (view as unknown as { addHooks: (hooks: ViewHooks) => () => void }).addHooks({ decorateNode: () => ({ className: 'added-deco', badge: '足した', title: '足した' }) } as ViewHooks);
                view.refreshDecorations();
            },
            { markdown: TAGGED, design: DESIGN },
        );
        await expect(page.locator(node('a', DESIGN))).toHaveClass(/\bctor-deco\b/);
        await expect(page.locator('#a .added-deco')).toHaveCount(0);
        await expect(page.locator('#a .mdag-badge')).toHaveCount(0);
        await expect(page.locator('#a [title="足した"]')).toHaveCount(0);
    });

    test('@editor render の図の view にも足せ、文書のフックの before 系が取りやめたら足した受け口は呼ばれない', async ({ page }) => {
        await open(page);
        await setAllow(page, { doc: false });
        await renderGuarded(page, TAGGED, 'a', 'beforeSelectGroup');
        await addListeners(page, 'add');
        await selectGroup(page, 'design');
        await settle(page);
        expect(await allCalls(page)).toEqual([]);
        expect(await highlightOf(page)).toEqual({ edge: false, faded: [] });

        await setAllow(page, { doc: true });
        await selectGroup(page, 'design');
        await expect.poll(() => allCalls(page)).toEqual(['add:beforeSelectGroup:design', 'add:onSelectGroup:design']);

        // 図の出口の受け口も足せる (何もないところのクリック)
        await clearCalls(page);
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await expect.poll(() => callsOf(page, 'onCanvasClick')).toEqual(['add:onCanvasClick']);
    });
});

test.describe('createHookBridge の素通し (段 10、2.2)', () => {
    test('@editor createHookBridge の viewHooks に渡した図の出口の 9 つの受け口が、bridge.viewHooks で組んだ図の操作で呼ばれる', async ({ page }) => {
        await open(page);
        await mountBridged(page, TAGGED, { interaction: 'edit' }, 'a', true);
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        const label = await spot(page, { on: 'text', selector: `${node('a', DESIGN)} .mdag-content` });
        await press(page, label);
        await page.waitForTimeout(600);
        await page.mouse.dblclick(label.x, label.y);
        await page.waitForTimeout(600);
        await press(page, await spot(page, { on: 'element', selector: `${node('a', TASK_A)} .mdag-tag[data-tag-key="owner"]` }));
        await press(page, await spot(page, { on: 'edge', root: '#a', key: await edgeKey(page, 'depends:') }));
        const frame = await spot(page, { on: 'element', selector: `#a .mdag-frame[data-group="${GROUP}"]` });
        await page.waitForTimeout(600);
        await page.mouse.move(frame.x, frame.y);
        await page.mouse.dblclick(frame.x, frame.y);
        await setIconSvg(page, LOGO_REF, LOGO_SVG);

        await expect.poll(async () => [...new Set((await logOf(page)).map((entry) => entry.hook))].sort()).toEqual(EXIT_HOOKS);
        const log = await logOf(page);
        expect(log).toContainEqual({ root: 'a', hook: 'nodePointerDown', id: DESIGN });
        expect(log).toContainEqual({ root: 'a', hook: 'nodeDoubleClick', id: DESIGN, place: 'label' });
        expect(log).toContainEqual({ root: 'a', hook: 'tagClick', id: TASK_A, key: 'owner', place: 'node' });
        expect(log).toContainEqual({ root: 'a', hook: 'edgeClick', key: 'depends:5>2' });
        expect(log).toContainEqual({ root: 'a', hook: 'frameClick', id: GROUP });
        expect(log).toContainEqual({ root: 'a', hook: 'frameDoubleClick', id: GROUP });
        expect(log).toContainEqual({ root: 'a', hook: 'canvasPointerDown', target: 'blank' });
        expect(log).toContainEqual({ root: 'a', hook: 'canvasClick' });
        expect(log).toContainEqual({ root: 'a', hook: 'iconSvg', key: LOGO_REF });
    });
});

test.describe('MarkdagDiagram.source (段 10、1.3)', () => {
    test('@editor render の diagram.source が、描いた原文、update のあとの原文、タスクのクリックで書き換えたあとの原文を返す', async ({ page }) => {
        await open(page);
        await renderGuarded(page, TAGGED, 'a');
        expect(await sourceOf(page)).toBe(TAGGED);
        const next = TAGGED.replace('Task B', 'Task C');
        await updateDiagram(page, next);
        expect(await sourceOf(page)).toBe(next);

        // 閲覧の図のタスクの文字のクリックで原文が書き換わる (onChange に届いたものと同じ)
        await press(page, await spot(page, { on: 'text', selector: `${node('a', TASK_A)} .mdag-content` }));
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).changes.length)).toBe(1);
        const changed = await page.evaluate(() => (window as unknown as EditorWindow).changes[0]);
        expect(changed).toContain('- [x] Task A');
        expect(await sourceOf(page)).toBe(changed);
    });

    test('@editor beforeUpdate が取りやめた update のあとは、diagram.source が前の原文のまま', async ({ page }) => {
        await open(page);
        await renderGuarded(page, TAGGED, 'a', 'beforeUpdate');
        const next = TAGGED.replace('Task B', 'Task C');
        await setAllow(page, { update: false });
        await updateDiagram(page, next);
        expect(await sourceOf(page)).toBe(TAGGED);
        await setAllow(page, { update: true });
        await updateDiagram(page, next);
        expect(await sourceOf(page)).toBe(next);
    });

    test('@editor transformSource が描く文を差し替えても、diagram.source は原文のまま', async ({ page }) => {
        await open(page);
        await renderGuarded(page, TAGGED, 'a', 'transform');
        await expect(page.locator('#a .mdag-node')).toHaveCount(8);
        expect(await sourceOf(page)).toBe(TAGGED);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// 選択の印と位置

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}
type Place = 'top' | 'bottom' | 'left' | 'right' | 'top-right' | 'label' | 'cover';
interface AnchorLike {
    target: { node: number } | { nodes: number[] } | { group: string };
    place: Place | Place[];
    gap?: number;
}
// 選択の印と位置の出口のうち、このテストが呼ぶものの形 (ページの中で呼ぶので、使う欄だけを書いた写し)
interface ExitView {
    setSelection(ids: Iterable<number>): void;
    setDropTarget(id: number | null): void;
    nodeRects(ids?: Iterable<number>, options?: { settled?: boolean }): Map<number, Box>;
    ensureVisible(id: number, margin?: number): void;
    attachOverlay(element: HTMLElement, anchor: AnchorLike): () => void;
}
interface ProbeState {
    rect: Box;
    hidden: boolean;
    connected: boolean;
    // 図の要素の直下の重ね置きの層 (.mdag-overlays) の子か
    inLayer: boolean;
    // transform を掛ける前の大きさ (要素に入れた幅と高さ。整数に丸めたもの)
    offsetWidth: number;
    offsetHeight: number;
    // transform を掛ける前のレイアウトの大きさ (getComputedStyle の幅と高さ。小数のまま)。
    // 倍率の比はこちらで見る (整数に丸めた大きさと比べると、丸めのずれが倍率に比例して大きくなる)
    layoutWidth: number;
    layoutHeight: number;
}
// ページの中で位置を測る補助。矩形は全部、図の要素 (#root) の左上からの画面の座標
interface Measure {
    // selector に合う最初の要素の矩形 (なければ null)
    rect(root: string, selector: string): Box | null;
    // selectors に合う要素のうち表に出ているもの (幅か高さがある) を全部囲む矩形 (なければ null)
    around(root: string, selectors: string[]): Box | null;
    probe(root: string, name: string): ProbeState | null;
    // 重ねた要素 name の今の矩形と、相手 (selectors を囲む矩形) に対して place の位置に gap だけ離して置いたときの矩形のずれ
    // (x、y、幅、高さの差のいちばん大きいもの)。要素がない、外れている、hidden、相手が表に出ていないときは 9999
    offset(root: string, name: string, place: Place, selectors: string[], gap: number): number;
    // 表に出ているノードの箱の矩形 (id の順)
    boxes(root: string): Array<[number, Box]>;
    // nodeRects の戻り値 (id の順)。ids が null なら省いて呼ぶ
    rects(root: string, ids: number[] | null, settled: boolean): Array<[number, Box]>;
}
// 重ねた要素と、あるべき位置の相手
interface ProbeCheck {
    name: string;
    place: Place;
    selectors: string[];
    gap?: number;
}

const TASK_B = 4;
// 初めから Design と Build の枝を閉じた文書 (深さ 2 以上の子のあるノードを閉じる)。Task A、Task B、Deep、Leaf の要素はまだ作られない
const LEVELED = OPEN.replace('markdag:\n', 'markdag:\n    initialExpandLevel: 2\n');
// Leaf (7) のない短い文書
const SHORT = ['# Root', '', '## Design', '', '## Build', ''].join('\n');

// グループの枠の有無を分けた文書。
// framed (boundary: true、隣り合う B1 と B2) は枠を 1 つ描く。loose (boundary: false、A1 と A2) は枠を描かない。
// single (boundary: true、子のない A3 だけ) はメンバー 1 つの枠を描く。split (boundary: true、G1 と D1) は別の枝にいて 1 つのまとまりにならないので、
// G1 と D1 の 1 つのメンバーの枠を 1 つずつ描く (描いた順で G1 の枠が先。Gamma か Delta を閉じると見えているメンバー 1 つの枠だけ)。
// single と split の枠は、メンバーが 1 つの所にも枠を描くようにしたときに足した (前は枠を描かなかった)
const GROUPED = [
    '---',
    'markdag:',
    '    groups:',
    '        framed:',
    '            label: 枠あり',
    '            color: "#3B7DD8"',
    '            boundary: true',
    '        loose:',
    '            label: 枠なし',
    '            color: "#D8823B"',
    '            boundary: false',
    '        single:',
    '            label: 一人',
    '            color: "#2E9E5B"',
    '            boundary: true',
    '        split:',
    '            label: 離れ',
    '            color: "#9B59B6"',
    '            boundary: true',
    '---',
    '',
    '# Root',
    '',
    '## Alpha',
    '',
    '- A1 %loose',
    '- A2 %loose',
    '- A3 %single',
    '',
    '## Beta',
    '',
    '- B1 %framed',
    '- B2 %framed',
    '',
    '## Gamma',
    '',
    '- G1 %split',
    '',
    '## Delta',
    '',
    '- D1 %split',
    '',
].join('\n');
// GROUPED の single と split を boundary: false にした写し。枠は framed の 1 つだけで、メンバーが 1 つの所に枠を描く前の GROUPED と同じ図になる
// (ラベルに重ねる確かめの前提。ノードの id は GROUPED と同じ)
const GROUPED_FRAMED_ONLY = GROUPED.replace(
    ['        single:', '            label: 一人', '            color: "#2E9E5B"', '            boundary: true'].join('\n'),
    ['        single:', '            label: 一人', '            color: "#2E9E5B"', '            boundary: false'].join('\n'),
).replace(
    ['        split:', '            label: 離れ', '            color: "#9B59B6"', '            boundary: true'].join('\n'),
    ['        split:', '            label: 離れ', '            color: "#9B59B6"', '            boundary: false'].join('\n'),
);
const ID = { alpha: 2, a1: 3, a2: 4, a3: 5, beta: 6, b1: 7, b2: 8, gamma: 9, g1: 10, delta: 11, d1: 12 } as const;

const boxSel = (id: number, root = 'a'): string => `${node(root, id)} .mdag-box`;
const contentSel = (id: number, root = 'a'): string => `${node(root, id)} .mdag-content`;
const frameSel = (group: string, root = 'a'): string => `#${root} .mdag-frame[data-group="${group}"]`;
const frameLabelSel = (group: string, root = 'a'): string => `#${root} .mdag-frame-label[data-group="${group}"]`;
// グループの枠のうち最初に描いたもの (枠の要素は同じ層に描いた順に並ぶ)
const firstFrameSel = (group: string, root = 'a'): string => `#${root} .mdag-frame[data-group="${group}"]:nth-child(1 of .mdag-frame[data-group="${group}"])`;

// グループの枠ごと (描いた順) に、ids のうち箱が枠の矩形に収まるノード
async function framesAround(page: Page, group: string, ids: number[], root = 'a'): Promise<number[][]> {
    return page.evaluate(
        ({ frame, boxes }) => {
            const inside = (outer: DOMRect, inner: DOMRect): boolean =>
                inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 && inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
            return [...document.querySelectorAll(frame)].map((element) => {
                const outer = element.getBoundingClientRect();
                return boxes.flatMap(([id, selector]) => {
                    const box = document.querySelector(selector)?.getBoundingClientRect();
                    return box && box.width > 0 && inside(outer, box) ? [id] : [];
                });
            });
        },
        { frame: frameSel(group, root), boxes: ids.map((id): [number, string] => [id, boxSel(id, root)]) },
    );
}

const gapBetween = (a: Box, b: Box): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
// 2 つの矩形の並び (id の順) で、同じ id どうしのずれのいちばん大きいもの。id の並びが違えば Infinity
function worst(a: Array<[number, Box]>, b: Array<[number, Box]>): number {
    if (a.length !== b.length || a.some(([id], index) => b[index]?.[0] !== id)) return Infinity;
    return Math.max(
        0,
        ...a.map(([, rect], index) => {
            const other = b[index];
            return other ? gapBetween(rect, other[1]) : Infinity;
        }),
    );
}
const idsOf = (entries: Array<[number, Box]>): number[] => entries.map(([id]) => id);
const rectOfId = (entries: Array<[number, Box]>, id: number): Box | undefined => entries.find(([key]) => key === id)?.[1];

// harness を開き、位置を測る補助と attachOverlay の控えを置く
async function openExits(page: Page): Promise<void> {
    await open(page);
    await page.evaluate(() => {
        const w = window as unknown as EditorWindow;
        w.probes = {};
        w.detachers = {};
        w.probeClicks = [];
        const relative = (root: string, rect: DOMRect): Box => {
            const base = document.getElementById(root)?.getBoundingClientRect();
            if (!base) throw new Error('container is missing');
            return { x: rect.left - base.left, y: rect.top - base.top, width: rect.width, height: rect.height };
        };
        const union = (rects: Box[]): Box | null => {
            if (rects.length === 0) return null;
            const left = Math.min(...rects.map((rect) => rect.x));
            const top = Math.min(...rects.map((rect) => rect.y));
            const right = Math.max(...rects.map((rect) => rect.x + rect.width));
            const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
            return { x: left, y: top, width: right - left, height: bottom - top };
        };
        const rect = (root: string, selector: string): Box | null => {
            const element = document.querySelector(selector);
            return element ? relative(root, element.getBoundingClientRect()) : null;
        };
        const around = (root: string, selectors: string[]): Box | null =>
            union(
                selectors.flatMap((selector) =>
                    [...document.querySelectorAll(selector)].map((element) => relative(root, element.getBoundingClientRect())).filter((box) => box.width > 0 || box.height > 0),
                ),
            );
        const probe = (root: string, name: string): ProbeState | null => {
            const element = w.probes[name];
            if (!element) return null;
            return {
                rect: relative(root, element.getBoundingClientRect()),
                hidden: element.hidden === true,
                connected: element.isConnected,
                inLayer: element.parentElement?.matches(`#${root} > .mdag-overlays`) ?? false,
                offsetWidth: element.offsetWidth,
                offsetHeight: element.offsetHeight,
                layoutWidth: parseFloat(getComputedStyle(element).width),
                layoutHeight: parseFloat(getComputedStyle(element).height),
            };
        };
        const offset = (root: string, name: string, place: Place, selectors: string[], gap: number): number => {
            const state = probe(root, name);
            const target = around(root, selectors);
            if (!state || !state.connected || state.hidden || !target) return 9999;
            const own = state.rect;
            const cx = target.x + target.width / 2;
            const cy = target.y + target.height / 2;
            const at = (x: number, y: number): Box => ({ x, y, width: own.width, height: own.height });
            // top / bottom / left / right: 相手の外の辺の中央に gap だけ離す。top-right: 右上の角に要素の中心。label と cover: 相手の矩形そのもの
            const wanted =
                place === 'top'
                    ? at(cx - own.width / 2, target.y - gap - own.height)
                    : place === 'bottom'
                      ? at(cx - own.width / 2, target.y + target.height + gap)
                      : place === 'left'
                        ? at(target.x - gap - own.width, cy - own.height / 2)
                        : place === 'right'
                          ? at(target.x + target.width + gap, cy - own.height / 2)
                          : place === 'top-right'
                            ? at(target.x + target.width - own.width / 2, target.y - own.height / 2)
                            : target;
            return Math.max(Math.abs(own.x - wanted.x), Math.abs(own.y - wanted.y), Math.abs(own.width - wanted.width), Math.abs(own.height - wanted.height));
        };
        const boxes = (root: string): Array<[number, Box]> =>
            [...document.querySelectorAll<HTMLElement>(`#${root} .mdag-node`)]
                .flatMap((element): Array<[number, Box]> => {
                    const box = element.querySelector('.mdag-box');
                    if (!box) return [];
                    const found = relative(root, box.getBoundingClientRect());
                    return found.width > 0 || found.height > 0 ? [[Number(element.dataset.id), found]] : [];
                })
                .sort((a, b) => a[0] - b[0]);
        const rects = (root: string, ids: number[] | null, settled: boolean): Array<[number, Box]> => {
            const view = w.views[root] as unknown as ExitView;
            const map = settled ? view.nodeRects(ids ?? undefined, { settled: true }) : ids ? view.nodeRects(ids) : view.nodeRects();
            return [...map].map(([id, box]): [number, Box] => [id, { x: box.x, y: box.y, width: box.width, height: box.height }]).sort((a, b) => a[0] - b[0]);
        };
        w.measure = { rect, around, probe, offset, boxes, rects };
    });
}

// asSet なら Set にして渡す (Iterable を受けることの確かめ)
const setSelection = (page: Page, ids: number[], root = 'a', asSet = false): Promise<void> =>
    page.evaluate(({ ids, root, asSet }) => ((window as unknown as EditorWindow).views[root] as unknown as ExitView).setSelection(asSet ? new Set(ids) : ids), { ids, root, asSet });
const setDropTarget = (page: Page, id: number | null, root = 'a'): Promise<void> =>
    page.evaluate(({ id, root }) => ((window as unknown as EditorWindow).views[root] as unknown as ExitView).setDropTarget(id), { id, root });
const ensureVisible = (page: Page, id: number, margin: number | null = null, root = 'a'): Promise<void> =>
    page.evaluate(
        ({ id, margin, root }) => {
            const view = (window as unknown as EditorWindow).views[root] as unknown as ExitView;
            if (margin === null) view.ensureVisible(id);
            else view.ensureVisible(id, margin);
        },
        { id, margin, root },
    );
// data-selected か data-drop-target を持つノードの id (昇順)。要素はあるが閉じた枝の中で隠れているノードも数える
const markedIds = (page: Page, attribute: 'data-selected' | 'data-drop-target', root = 'a'): Promise<number[]> =>
    page.evaluate(
        ({ attribute, root }) => [...document.querySelectorAll<HTMLElement>(`#${root} .mdag-node[${attribute}]`)].map((element) => Number(element.dataset.id)).sort((a, b) => a - b),
        { attribute, root },
    );
const rectsOf = (page: Page, ids: number[] | null = null, settled = false, root = 'a'): Promise<Array<[number, Box]>> =>
    page.evaluate(({ ids, settled, root }) => (window as unknown as EditorWindow).measure.rects(root, ids, settled), { ids, settled, root });
const boxesOf = (page: Page, root = 'a'): Promise<Array<[number, Box]>> => page.evaluate((root) => (window as unknown as EditorWindow).measure.boxes(root), root);
async function boxOf(page: Page, id: number, root = 'a'): Promise<Box> {
    const found = await page.evaluate(({ selector, root }) => (window as unknown as EditorWindow).measure.around(root, [selector]), { selector: boxSel(id, root), root });
    if (!found) throw new Error(`${String(id)} の箱が見えていない`);
    return found;
}
const setTransform = (page: Page, transform: { x: number; y: number; k: number }, root = 'a'): Promise<void> =>
    page.evaluate(({ transform, root }) => (window as unknown as EditorWindow).views[root]?.setTransform(transform), { transform, root });
const panView = (page: Page, dx: number, dy: number, root = 'a'): Promise<void> =>
    page.evaluate(({ dx, dy, root }) => (window as unknown as EditorWindow).views[root]?.panBy(dx, dy), { dx, dy, root });
const zoomView = (page: Page, factor: number, point: Point, root = 'a'): Promise<void> =>
    page.evaluate(({ factor, point, root }) => (window as unknown as EditorWindow).views[root]?.zoomBy(factor, point), { factor, point, root });

interface Destination {
    left?: number;
    right?: number;
    cx?: number;
    top?: number;
    bottom?: number;
    cy?: number;
}
// selectors を囲む矩形が図の要素の上の指定の位置に来るよう、今ある panBy で表示位置を動かす (倍率は変えない)。動かしたあとの矩形を返す
async function moveRect(page: Page, selectors: string[], to: Destination, root = 'a'): Promise<Box> {
    return page.evaluate(
        ({ selectors, to, root }) => {
            const w = window as unknown as EditorWindow;
            const found = w.measure.around(root, selectors);
            if (!found) throw new Error(`見えていない: ${selectors.join(', ')}`);
            const dx =
                to.left !== undefined ? to.left - found.x : to.right !== undefined ? to.right - (found.x + found.width) : to.cx !== undefined ? to.cx - (found.x + found.width / 2) : 0;
            const dy =
                to.top !== undefined ? to.top - found.y : to.bottom !== undefined ? to.bottom - (found.y + found.height) : to.cy !== undefined ? to.cy - (found.y + found.height / 2) : 0;
            w.views[root]?.panBy(dx, dy);
            const moved = w.measure.around(root, selectors);
            if (!moved) throw new Error('動かしたあとに見えない');
            return moved;
        },
        { selectors, to, root },
    );
}
const moveBox = (page: Page, id: number, to: Destination, root = 'a'): Promise<Box> => moveRect(page, [boxSel(id, root)], to, root);

// attachOverlay に名前つきの要素を渡す。size を渡せば要素の幅と高さ (px) をテストが決める (null なら決めない。label と cover は view が決める)。
// 要素のクリックは probeClicks に残す
async function attach(page: Page, name: string, anchor: AnchorLike, size: [number, number] | null = [40, 12], root = 'a'): Promise<void> {
    await page.evaluate(
        ({ name, anchor, size, root }) => {
            const w = window as unknown as EditorWindow;
            const element = document.createElement('div');
            element.dataset.probe = name;
            if (size) {
                element.style.width = `${String(size[0])}px`;
                element.style.height = `${String(size[1])}px`;
            }
            element.addEventListener('click', () => void w.probeClicks.push(name));
            w.probes[name] = element;
            w.detachers[name] = (w.views[root] as unknown as ExitView).attachOverlay(element, anchor);
        },
        { name, anchor, size, root },
    );
}
const detach = (page: Page, name: string): Promise<void> => page.evaluate((name) => (window as unknown as EditorWindow).detachers[name]?.(), name);
const probeOf = (page: Page, name: string, root = 'a'): Promise<ProbeState | null> =>
    page.evaluate(({ name, root }) => (window as unknown as EditorWindow).measure.probe(root, name), { name, root });
const offsetOf = (page: Page, check: ProbeCheck, root = 'a'): Promise<number> =>
    page.evaluate(({ check, root }) => (window as unknown as EditorWindow).measure.offset(root, check.name, check.place, check.selectors, check.gap ?? 0), { check, root });
async function expectPlaced(page: Page, checks: ProbeCheck[], root = 'a'): Promise<void> {
    for (const check of checks) await expect.poll(() => offsetOf(page, check, root), { message: `${check.name} (${check.place})` }).toBeLessThanOrEqual(1);
}
async function expectHidden(page: Page, name: string, hidden: boolean, root = 'a'): Promise<void> {
    await expect.poll(async () => (await probeOf(page, name, root))?.hidden, { message: name }).toBe(hidden);
}
// addHooks で onFoldChange を記録する (hook は foldChange)
const watchFolds = (page: Page, root = 'a'): Promise<void> =>
    page.evaluate((root) => {
        const w = window as unknown as EditorWindow;
        w.views[root]?.addHooks({ onFoldChange: (folded: number[], byUser: boolean) => void w.log.push({ root, hook: 'foldChange', folded, byUser }) });
    }, root);
const foldedOf = (page: Page, root = 'a'): Promise<number[] | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).views[root]?.getFolded(), root);

// 開閉を変えて、動きが終わるまで (900ms) のコマごとに nodeRects と表に出ている箱の矩形を並べて読む。初めの 1 つは開閉を変えた直後、
// そのあとは次のコマを描いたあと (そのコマの描画の更新が済んでからのタスク) に読む
async function sampleRects(page: Page, folded: number[], root = 'a'): Promise<Array<{ rects: Array<[number, Box]>; boxes: Array<[number, Box]> }>> {
    return page.evaluate(
        async ({ folded, root }) => {
            const w = window as unknown as EditorWindow;
            const frames: Array<{ rects: Array<[number, Box]>; boxes: Array<[number, Box]> }> = [];
            w.views[root]?.setFolded(folded);
            const started = performance.now();
            while (performance.now() - started < 900) {
                frames.push({ rects: w.measure.rects(root, null, false), boxes: w.measure.boxes(root) });
                await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            }
            return frames;
        },
        { folded, root },
    );
}
// 開閉を変えて、動きが終わるまで (900ms) のコマごとに、重ねた要素のずれと watch の矩形を読む (描いたコマのあとだけ)
async function sampleOverlays(page: Page, folded: number[], checks: ProbeCheck[], watch: string, root = 'a'): Promise<Array<{ offsets: number[]; watched: Box | null }>> {
    return page.evaluate(
        async ({ folded, checks, watch, root }) => {
            const w = window as unknown as EditorWindow;
            const frames: Array<{ offsets: number[]; watched: Box | null }> = [];
            w.views[root]?.setFolded(folded);
            const started = performance.now();
            while (performance.now() - started < 900) {
                await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
                frames.push({ offsets: checks.map((check) => w.measure.offset(root, check.name, check.place, check.selectors, check.gap ?? 0)), watched: w.measure.around(root, [watch]) });
            }
            return frames;
        },
        { folded, checks, watch, root },
    );
}
// 動きの途中のコマ (watch の矩形が最初のコマとも最後のコマとも 2px より離れている) の数
function movingFrames<T>(frames: T[], watched: (frame: T) => Box | null | undefined): number {
    const first = frames[0] === undefined ? null : watched(frames[0]);
    const last = frames.at(-1) === undefined ? null : watched(frames.at(-1) as T);
    if (!first || !last) return 0;
    return frames.filter((frame) => {
        const box = watched(frame);
        return box !== null && box !== undefined && gapBetween(box, first) > 2 && gapBetween(box, last) > 2;
    }).length;
}

// ノードの要素と箱の中の全部の要素の、袋文字にかかわる計算済みの値
async function haloOf(page: Page, id: number, root = 'a'): Promise<string[]> {
    return page.evaluate(
        ({ id, root }) => {
            const element = document.querySelector(`#${root} .mdag-node[data-id="${String(id)}"]`);
            if (!element) throw new Error('node is missing');
            const names = ['-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order', 'filter', 'color'];
            return [element, ...element.querySelectorAll('*')].map((item) => {
                const style = getComputedStyle(item);
                return `${item.tagName.toLowerCase()}.${item.getAttribute('class') ?? ''} ${names.map((name) => `${name}=${style.getPropertyValue(name)}`).join(' ')}`;
            });
        },
        { id, root },
    );
}

test.describe('選択の印 (段 11、2.3 の setSelection と setDropTarget、2.4、2.6、context 4.2 と 7-18、B-064)', () => {
    test('@editor 出口を呼ばない図には data-selected、data-drop-target、.mdag-overlays がない (render の閲覧の図と edit の図)', async ({ page }) => {
        await open(page);
        await renderDiagram(page, OPEN, 'a');
        await mountView(page, OPEN, { interaction: 'edit' }, 'b');
        for (const root of ['a', 'b']) {
            await expect(page.locator(`#${root} .mdag-node`).first()).toBeAttached();
            await expect(page.locator(`#${root} [data-selected]`)).toHaveCount(0);
            await expect(page.locator(`#${root} [data-drop-target]`)).toHaveCount(0);
            await expect(page.locator(`#${root} .mdag-overlays`)).toHaveCount(0);
        }
    });

    test('@editor setSelection で選んだノードに data-selected が付き、選び直すと前のノードから外れ、空で全部外れて要素が最初と同じに戻る', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        const before = await structureOf(page);

        await setSelection(page, [DESIGN, BUILD]);
        expect(await markedIds(page, 'data-selected')).toEqual([DESIGN, BUILD]);
        await expect(page.locator('#a [data-selected]')).toHaveCount(2);
        await setSelection(page, [TASK_A]);
        expect(await markedIds(page, 'data-selected')).toEqual([TASK_A]);
        // Iterable (Set) も受け、文書にない id は捨てる
        await setSelection(page, [TASK_B, 99], 'a', true);
        expect(await markedIds(page, 'data-selected')).toEqual([TASK_B]);
        await setSelection(page, []);
        expect(await markedIds(page, 'data-selected')).toEqual([]);
        expect(await structureOf(page)).toEqual(before);
    });

    test('@editor 閉じた枝の中でまだ要素のないノードを選んでから開くと、作った要素に data-selected が付き、開く前に選び直して外れたノードには付かない (context 7-18)', async ({ page }) => {
        await openExits(page);
        await mountView(page, LEVELED, { interaction: 'edit' });
        // 文書の形の確かめ: 閉じた枝の中のノードの要素はまだない
        await expect(page.locator(node('a', DESIGN))).toHaveCount(1);
        for (const id of [TASK_A, TASK_B, DEEP, LEAF]) await expect(page.locator(node('a', id))).toHaveCount(0);

        await setSelection(page, [TASK_A, DEEP]);
        expect(await markedIds(page, 'data-selected')).toEqual([]);
        await setSelection(page, [TASK_A, LEAF]);
        await setFolded(page, []);
        await expect(page.locator(node('a', DEEP))).toHaveCount(1);
        await expect.poll(() => markedIds(page, 'data-selected')).toEqual([TASK_A, LEAF]);

        // 要素を作ったあとで閉じた枝の中に入ったノードも、選んでから開くと付いている
        await setFolded(page, [DESIGN]);
        await setSelection(page, [TASK_B]);
        await setFolded(page, []);
        await expect.poll(() => markedIds(page, 'data-selected')).toEqual([TASK_B]);
    });

    test('@editor data-selected と data-drop-target を付けても、ノードの要素と箱の中の要素の -webkit-text-stroke、paint-order、filter、color が付けていないときと同じ (袋文字の規則を変えない)', async ({ page }) => {
        await openExits(page);
        // 詳細をノードの中に開き、状態の絵、文字、詳細、タグを持つ Task A で見る
        await mountView(page, OPEN, { interaction: 'edit', details: 'always' });
        for (const theme of ['light', 'dark'] as const) {
            await setOptions(page, { theme });
            const before = await haloOf(page, TASK_A);
            expect(before.length).toBeGreaterThan(3);

            await setSelection(page, [TASK_A]);
            await expect(page.locator(`${node('a', TASK_A)}[data-selected]`)).toHaveCount(1);
            await settle(page);
            expect(await haloOf(page, TASK_A)).toEqual(before);
            await setSelection(page, []);

            await setDropTarget(page, TASK_A);
            await expect(page.locator(`${node('a', TASK_A)}[data-drop-target]`)).toHaveCount(1);
            await settle(page);
            expect(await haloOf(page, TASK_A)).toEqual(before);
            await setDropTarget(page, null);
        }
    });

    test('@editor setDropTarget で data-drop-target が 1 つだけ付き、付け替えると前から外れ、null で外れる。data-selected とは別に付く', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        const before = await structureOf(page);

        await setDropTarget(page, DESIGN);
        expect(await markedIds(page, 'data-drop-target')).toEqual([DESIGN]);
        await setDropTarget(page, BUILD);
        expect(await markedIds(page, 'data-drop-target')).toEqual([BUILD]);
        await expect(page.locator('#a [data-drop-target]')).toHaveCount(1);

        await setSelection(page, [BUILD, TASK_A]);
        await setDropTarget(page, TASK_A);
        expect(await markedIds(page, 'data-drop-target')).toEqual([TASK_A]);
        expect(await markedIds(page, 'data-selected')).toEqual([TASK_A, BUILD]);
        await setDropTarget(page, null);
        expect(await markedIds(page, 'data-drop-target')).toEqual([]);
        expect(await markedIds(page, 'data-selected')).toEqual([TASK_A, BUILD]);

        await setSelection(page, []);
        expect(await structureOf(page)).toEqual(before);
    });
});

test.describe('nodeRects (段 11、2.3、B-23)', () => {
    test('@editor nodeRects が、見えているノードの箱の getBoundingClientRect から図の要素の左上を引いた矩形と 1px 以内で一致する (パンとズームのあと、ページの左上にない図も)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, {}, 'a');
        await mountView(page, OPEN, { interaction: 'edit' }, 'b');
        const matches = async (root: string): Promise<void> => {
            const boxes = await boxesOf(page, root);
            expect(idsOf(boxes)).toEqual([1, 2, 3, 4, 5, 6, 7]);
            const rects = await rectsOf(page, null, false, root);
            expect(idsOf(rects)).toEqual(idsOf(boxes));
            expect(worst(rects, boxes)).toBeLessThanOrEqual(1);
        };
        for (const root of ['a', 'b']) {
            await matches(root);
            await setTransform(page, { x: 37.5, y: -12.25, k: 1.6 }, root);
            await matches(root);
            await zoomView(page, 0.55, { x: 400, y: 250 }, root);
            await panView(page, -23, 41, root);
            await matches(root);
        }
    });

    test('@editor nodeRects は閉じた枝の中のノードを入れず、ids を渡すとそのうち見えているものだけを返す', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN);
        await setFolded(page, [BUILD]);
        expect(idsOf(await rectsOf(page))).toEqual([1, DESIGN, TASK_A, TASK_B, BUILD]);
        expect(idsOf(await rectsOf(page, [DEEP, LEAF, TASK_A, 99]))).toEqual([TASK_A]);
        expect(await rectsOf(page, [DEEP])).toEqual([]);
        const some = await rectsOf(page, [BUILD, DESIGN]);
        expect(idsOf(some)).toEqual([DESIGN, BUILD]);
        expect(worst(some, (await boxesOf(page)).filter(([id]) => id === DESIGN || id === BUILD))).toBeLessThanOrEqual(1);

        // 初めから閉じた枝の中にあって要素をまだ作っていないノードも入らない
        await mountView(page, LEVELED);
        expect(idsOf(await rectsOf(page))).toEqual([1, DESIGN, BUILD]);
        expect(await rectsOf(page, [TASK_A, LEAF])).toEqual([]);
    });

    test('@editor 動きの途中の nodeRects は、そのとき描いている箱の位置と 1px 以内で一致する', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { animate: true });
        // Deep を閉じると Leaf が消えて Design の枝が動き、開くと Leaf が Deep の位置から出てくる
        for (const folded of [[DEEP], []]) {
            const frames = await sampleRects(page, folded);
            expect(movingFrames(frames, (frame) => rectOfId(frame.boxes, DESIGN))).toBeGreaterThan(0);
            for (const [index, frame] of frames.entries()) {
                expect(idsOf(frame.rects), `コマ ${String(index)}`).toEqual(idsOf(frame.boxes));
                expect(worst(frame.rects, frame.boxes), `コマ ${String(index)}`).toBeLessThanOrEqual(1);
            }
        }
    });

    test('@editor settled を付けると、枝を開いた直後でも、動き終えたあとの矩形と 1px 以内で一致する。直後にパンしても今の表示で返す (B-23)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { animate: true });
        for (const pan of [null, { dx: 40, dy: -25 }]) {
            await setFolded(page, [DEEP]);
            await page.waitForTimeout(700);
            const early = await page.evaluate(
                ({ pan }) => {
                    const w = window as unknown as EditorWindow;
                    w.views.a?.setFolded([]);
                    if (pan) w.views.a?.panBy(pan.dx, pan.dy);
                    return { settled: w.measure.rects('a', null, true), leaf: w.measure.rects('a', [7], true), now: w.measure.rects('a', null, false) };
                },
                { pan },
            );
            await page.waitForTimeout(700);
            const finalBoxes = await boxesOf(page);
            expect(idsOf(finalBoxes)).toEqual([1, 2, 3, 4, 5, 6, 7]);
            expect(idsOf(early.settled)).toEqual(idsOf(finalBoxes));
            expect(worst(early.settled, finalBoxes)).toBeLessThanOrEqual(1);
            expect(worst(early.settled, await rectsOf(page))).toBeLessThanOrEqual(1);
            expect(idsOf(early.leaf)).toEqual([LEAF]);
            // 直後の settled なしの矩形は動き終えたあとと違う (動きの途中で読んだことの確かめ)
            expect(worst(early.now, finalBoxes)).toBeGreaterThan(2);
        }
    });
});

test.describe('ensureVisible (段 11、2.3、B-090)', () => {
    test('@editor ensureVisible: 図の領域の外か端の 24px の内側のノードを、既定の 24px を残して入るいちばん短い距離だけパンし、倍率は変えない', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN);
        const cases: Array<{ to: Destination; edge: (box: Box) => number; want: number; still: 'x' | 'y' }> = [
            // 右の外 → 右の辺が 1000 - 24 に来る。縦は動かさない
            { to: { left: 1150, cy: 300 }, edge: (box) => box.x + box.width, want: 976, still: 'y' },
            // 左の外
            { to: { right: -200, cy: 300 }, edge: (box) => box.x, want: 24, still: 'y' },
            // 見えているが上の辺から 24px 残っていない
            { to: { cx: 500, top: 8 }, edge: (box) => box.y, want: 24, still: 'x' },
            // 下の外
            { to: { cx: 500, top: 700 }, edge: (box) => box.y + box.height, want: 576, still: 'x' },
        ];
        for (const item of cases) {
            await moveBox(page, LEAF, item.to);
            const before = await transformOf(page);
            await ensureVisible(page, LEAF);
            await expect.poll(async () => Math.abs(item.edge(await boxOf(page, LEAF)) - item.want), { message: JSON.stringify(item.to) }).toBeLessThanOrEqual(1);
            const after = await transformOf(page);
            expect(after?.k).toBe(before?.k);
            expect(Math.abs((after?.[item.still] ?? 0) - (before?.[item.still] ?? 0))).toBeLessThanOrEqual(0.5);
        }
    });

    test('@editor ensureVisible: margin を渡すとその幅を残して入る (0 なら図の領域の辺にそろう)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN);
        const k = (await transformOf(page))?.k;

        await moveBox(page, LEAF, { right: -300, bottom: -200 });
        await ensureVisible(page, LEAF, 40);
        await expect
            .poll(async () => {
                const box = await boxOf(page, LEAF);
                return Math.max(Math.abs(box.x - 40), Math.abs(box.y - 40));
            })
            .toBeLessThanOrEqual(1);

        await moveBox(page, LEAF, { left: 1300, top: 900 });
        await ensureVisible(page, LEAF, 0);
        await expect
            .poll(async () => {
                const box = await boxOf(page, LEAF);
                return Math.max(Math.abs(box.x + box.width - 1000), Math.abs(box.y + box.height - 600));
            })
            .toBeLessThanOrEqual(1);
        expect((await transformOf(page))?.k).toBe(k);
    });

    test('@editor ensureVisible: margin を残して収まっているノードでは表示位置が変わらない', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN);
        const cases: Array<{ to: Destination; margin: number | null }> = [
            { to: { cx: 500, cy: 300 }, margin: null },
            // 右の辺から 30px (24px より内側)
            { to: { right: 970, cy: 300 }, margin: null },
            { to: { cx: 500, cy: 300 }, margin: 100 },
        ];
        for (const item of cases) {
            await moveBox(page, LEAF, item.to);
            const before = await transformOf(page);
            await ensureVisible(page, LEAF, item.margin);
            await settle(page);
            expect(await transformOf(page)).toEqual(before);
        }
    });

    for (const animate of [false, true]) {
        const title = animate ? '動きのある図でも、動き終えたあとに' : '開いたあとの位置が';
        test(`@editor ensureVisible: 閉じた枝の中のノードは祖先を開き (onFoldChange は byUser false)、${title} margin を残して入り、倍率は変わらない`, async ({ page }) => {
            await openExits(page);
            await mountView(page, OPEN, { animate });
            await setFolded(page, [BUILD]);
            await page.waitForTimeout(600);
            await watchFolds(page);
            // Build を右の辺の近くに置く。開くと Deep と Leaf は Build の右 (図の領域の外) に出る
            await moveBox(page, BUILD, { right: 990, cy: 300 });
            const k = (await transformOf(page))?.k;

            await ensureVisible(page, LEAF);
            await expect.poll(() => foldedOf(page)).toEqual([]);
            expect(await logOf(page, 'foldChange')).toEqual([{ root: 'a', hook: 'foldChange', folded: [], byUser: false }]);
            await page.waitForTimeout(animate ? 800 : 200);
            const box = await boxOf(page, LEAF);
            expect(Math.min(box.x, box.y, 1000 - (box.x + box.width), 600 - (box.y + box.height))).toBeGreaterThanOrEqual(23);
            // 右の外から入れたので、右の辺が 1000 - 24 (いちばん短い距離)
            expect(Math.abs(box.x + box.width - 976)).toBeLessThanOrEqual(1);
            expect((await transformOf(page))?.k).toBe(k);
        });
    }
});

test.describe('attachOverlay の層と外し方 (段 11、2.3、2.4、2.6)', () => {
    test('@editor .mdag-overlays は attachOverlay を呼ぶまでなく、呼ぶと図の要素の直下に 1 つでき、図の領域と同じ大きさで、渡した要素が入る', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        // ほかの出口を呼んでも作らない
        await setSelection(page, [DESIGN]);
        await setDropTarget(page, BUILD);
        await rectsOf(page);
        await ensureVisible(page, LEAF);
        await settle(page);
        await expect(page.locator('#a .mdag-overlays')).toHaveCount(0);

        await attach(page, 'first', { target: { node: DESIGN }, place: 'top', gap: 6 });
        await expect(page.locator('#a > .mdag-overlays')).toHaveCount(1);
        await attach(page, 'second', { target: { node: BUILD }, place: 'bottom', gap: 6 });
        await expect(page.locator('#a .mdag-overlays')).toHaveCount(1);
        for (const name of ['first', 'second']) {
            const state = await probeOf(page, name);
            expect(state).toMatchObject({ connected: true, inLayer: true, hidden: false });
        }
        const layer = await page.evaluate(() => (window as unknown as EditorWindow).measure.rect('a', '#a > .mdag-overlays'));
        expect(layer).not.toBeNull();
        if (layer) expect(gapBetween(layer, { x: 0, y: 0, width: 1000, height: 600 })).toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('#a > .mdag-overlays') ?? document.body).pointerEvents)).toBe('none');
    });

    test('@editor 重ね置きの層は何もないところの押下を図へ通し、中の要素だけが押下を受ける (図の受け口は呼ばれず、パンもしない)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await attach(page, 'bar', { target: { node: DESIGN }, place: 'top', gap: 8 }, [120, 30]);
        await expectPlaced(page, [{ name: 'bar', place: 'top', selectors: [boxSel(DESIGN)], gap: 8 }]);

        // 層が覆う何もないところは、図の領域が受ける (spot は図の領域が表に出ている点を探す)
        await press(page, await spot(page, { on: 'blank', root: '#a' }));
        await expect.poll(() => logOf(page, 'canvasClick')).toHaveLength(1);

        const bar = await probeOf(page, 'bar');
        const center = { x: (bar?.rect.x ?? 0) + (bar?.rect.width ?? 0) / 2, y: (bar?.rect.y ?? 0) + (bar?.rect.height ?? 0) / 2 };
        expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)?.closest('[data-probe]')?.getAttribute('data-probe') ?? null, center)).toBe('bar');
        await clearLog(page);
        const before = await transformOf(page);
        await press(page, center);
        await expect.poll(() => page.evaluate(() => [...(window as unknown as EditorWindow).probeClicks])).toEqual(['bar']);
        await drag(page, center, { x: center.x + 60, y: center.y + 40 });
        await settle(page);
        expect(await transformOf(page)).toEqual(before);
        expect(await logOf(page, 'canvasPointerDown')).toEqual([]);
        expect(await logOf(page, 'canvasClick')).toEqual([]);
        expect(await logOf(page, 'nodePointerDown')).toEqual([]);
    });

    test('@editor 外す関数で要素が層から外れ、ほかの要素は付いたまま。destroy で全部外れ、そのあと外す関数を呼んでも投げない', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await attach(page, 'one', { target: { node: DESIGN }, place: 'top', gap: 6 });
        await attach(page, 'two', { target: { node: BUILD }, place: 'bottom', gap: 6 });
        const two: ProbeCheck = { name: 'two', place: 'bottom', selectors: [boxSel(BUILD)], gap: 6 };
        await expectPlaced(page, [two]);

        await detach(page, 'one');
        expect((await probeOf(page, 'one'))?.connected).toBe(false);
        expect((await probeOf(page, 'two'))?.connected).toBe(true);
        await panView(page, 30, 20);
        await expectPlaced(page, [two]);
        await detach(page, 'one');

        await page.evaluate(() => (window as unknown as EditorWindow).views.a?.destroy());
        expect((await probeOf(page, 'two'))?.connected).toBe(false);
        await expect(page.locator('#a .mdag-overlays')).toHaveCount(0);
        await detach(page, 'two');
        // 破棄のあとに大きさが変わっても誤りにならない
        await page.evaluate(() => void ((document.getElementById('a') as HTMLElement).style.width = '700px'));
        await settle(page);
        expect(errors).toEqual([]);
    });
});

test.describe('attachOverlay の置き方 (段 11、2.3、6.5、B-011、B-013、B-020、B-051、B-064、B-117)', () => {
    test('@editor { node } の right (子の +) と bottom (兄弟の +)、top、left は、箱の外の辺の中央に gap だけ離れて付く (B-020)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await moveBox(page, DESIGN, { cx: 500, cy: 300 });
        await attach(page, 'child', { target: { node: DESIGN }, place: 'right', gap: 6 }, [16, 16]);
        await attach(page, 'sibling', { target: { node: DESIGN }, place: 'bottom', gap: 6 }, [16, 16]);
        await attach(page, 'above', { target: { node: DESIGN }, place: 'top', gap: 10 }, [48, 14]);
        await attach(page, 'before', { target: { node: DESIGN }, place: 'left', gap: 4 }, [30, 10]);
        await expectPlaced(page, [
            { name: 'child', place: 'right', selectors: [boxSel(DESIGN)], gap: 6 },
            { name: 'sibling', place: 'bottom', selectors: [boxSel(DESIGN)], gap: 6 },
            { name: 'above', place: 'top', selectors: [boxSel(DESIGN)], gap: 10 },
            { name: 'before', place: 'left', selectors: [boxSel(DESIGN)], gap: 4 },
        ]);
    });

    test('@editor top-right は箱の右上の角に要素の中心を置く', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await moveBox(page, TASK_A, { cx: 500, cy: 300 });
        await attach(page, 'corner', { target: { node: TASK_A }, place: 'top-right' }, [14, 14]);
        await attach(page, 'wide', { target: { node: TASK_A }, place: 'top-right' }, [30, 20]);
        await expectPlaced(page, [
            { name: 'corner', place: 'top-right', selectors: [boxSel(TASK_A)] },
            { name: 'wide', place: 'top-right', selectors: [boxSel(TASK_A)] },
        ]);
    });

    test('@editor [top, bottom]: 上に入れば上、図の領域の上に入らなければ下に付き、パンすると選び直す (B-011)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        const top: ProbeCheck = { name: 'bar', place: 'top', selectors: [boxSel(DESIGN)], gap: 6 };
        const bottom: ProbeCheck = { ...top, place: 'bottom' };
        await moveBox(page, DESIGN, { cx: 500, top: 300 });
        await attach(page, 'bar', { target: { node: DESIGN }, place: ['top', 'bottom'], gap: 6 }, [120, 28]);
        await expectPlaced(page, [top]);

        // 上の辺に寄せると、箱の上に 6 + 28 の高さが残らない
        const near = await moveBox(page, DESIGN, { cx: 500, top: 20 });
        expect(near.y - 6 - 28).toBeLessThan(0);
        await expectPlaced(page, [bottom]);

        await moveBox(page, DESIGN, { cx: 500, top: 200 });
        await expectPlaced(page, [top]);
    });

    test('@editor [right, bottom, top]: 右に入れば右、入らなければ下、下にも入らなければ上、どれも入らなければ最初の right (B-117)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await setTransform(page, { x: 0, y: 0, k: 1 });
        const anchor: AnchorLike = { target: { node: DESIGN }, place: ['right', 'bottom', 'top'], gap: 8 };
        const check = (name: string, place: Place): ProbeCheck => ({ name, place, selectors: [boxSel(DESIGN)], gap: 8 });
        await moveBox(page, DESIGN, { cx: 500, cy: 300 });
        await attach(page, 'details', anchor, [160, 60]);
        await expectPlaced(page, [check('details', 'right')]);

        // 右の辺に寄せる: 右に入らず、下なら入る
        let box = await moveBox(page, DESIGN, { right: 880, cy: 300 });
        expect(box.x + box.width + 8 + 160).toBeGreaterThan(1000);
        expect(box.x + box.width / 2 + 80).toBeLessThanOrEqual(1000);
        expect(box.y + box.height + 8 + 60).toBeLessThanOrEqual(600);
        await expectPlaced(page, [check('details', 'bottom')]);

        // 右と下の辺に寄せる: 下にも入らず、上なら入る
        box = await moveBox(page, DESIGN, { right: 880, bottom: 570 });
        expect(box.y + box.height + 8 + 60).toBeGreaterThan(600);
        expect(box.y - 8 - 60).toBeGreaterThanOrEqual(0);
        await expectPlaced(page, [check('details', 'top')]);

        // どれにも入らない大きさ: 最初の right
        box = await moveBox(page, DESIGN, { cx: 500, cy: 300 });
        await attach(page, 'huge', anchor, [600, 400]);
        expect(box.x + box.width + 8 + 600).toBeGreaterThan(1000);
        expect(box.y + box.height + 8 + 400).toBeGreaterThan(600);
        expect(box.y - 8 - 400).toBeLessThan(0);
        await expectPlaced(page, [check('huge', 'right'), check('details', 'right')]);
    });

    test('@editor label: ノードの文字 (.mdag-content) の矩形にそろい、図の倍率が掛かる (要素の幅と高さは図の座標で入り、transform で拡大する。B-013)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        const content = await moveRect(page, [contentSel(TASK_A)], { cx: 500, cy: 300 });
        // 文書の形の確かめ: Task A の箱はタグのぶん文字より広い (箱でなく文字にそろうことを見分けられる)
        expect((await boxOf(page, TASK_A)).width).toBeGreaterThan(content.width + 10);
        await attach(page, 'name', { target: { node: TASK_A }, place: 'label' }, null);
        for (const factor of [1, 2.2, 0.25]) {
            if (factor !== 1) await zoomView(page, factor, { x: 500, y: 300 });
            const k = (await transformOf(page))?.k ?? 1;
            await expectPlaced(page, [{ name: 'name', place: 'label', selectors: [contentSel(TASK_A)] }]);
            const state = await probeOf(page, 'name');
            // 倍率の比は小数のままの大きさで見る (webkit ではタスクのノードの文字の高さが 20.453 など小数になり、整数の offsetHeight と比べると丸めのずれが倍率に比例する)
            expect(Math.abs((state?.rect.width ?? 0) / (state?.layoutWidth || Number.NaN) - k), `k=${String(k)}`).toBeLessThanOrEqual(0.05);
            expect(Math.abs((state?.rect.height ?? 0) / (state?.layoutHeight || Number.NaN) - k), `k=${String(k)}`).toBeLessThanOrEqual(0.05);
        }
    });

    // 文書は、枠が framed の 1 つだけの GROUPED_FRAMED_ONLY (GROUPED ではメンバーが 1 つの所にも枠を描くので、枠が増えて全体表示の倍率が変わる)。
    // 倍率の比は小数のままの大きさで見る。枠のラベル (SVG の text) の高さはブラウザの字の測り方で小数になり (webkit は 11.1875 など)、
    // 整数の offsetHeight と比べると丸めのずれが倍率に比例して上限を越える。確かめたいこと (ラベルの矩形にそろい、倍率が掛かる) と上限は変えていない
    test('@editor { group } の label: 枠のラベルの矩形にそろい、図の倍率が掛かる (B-051)', async ({ page }) => {
        await openExits(page);
        await mountView(page, GROUPED_FRAMED_ONLY, { interaction: 'edit' });
        await expect(page.locator('#a .mdag-frame')).toHaveCount(1);
        await expect(page.locator(frameLabelSel('framed'))).toHaveCount(1);
        await moveRect(page, [frameLabelSel('framed')], { cx: 500, cy: 300 });
        await attach(page, 'group-name', { target: { group: 'framed' }, place: 'label' }, null);
        for (const factor of [1, 2, 0.4]) {
            if (factor !== 1) await zoomView(page, factor, { x: 500, y: 300 });
            const k = (await transformOf(page))?.k ?? 1;
            await expectPlaced(page, [{ name: 'group-name', place: 'label', selectors: [frameLabelSel('framed')] }]);
            const state = await probeOf(page, 'group-name');
            expect(Math.abs((state?.rect.width ?? 0) / (state?.layoutWidth || Number.NaN) - k), `k=${String(k)}`).toBeLessThanOrEqual(0.05);
            expect(Math.abs((state?.rect.height ?? 0) / (state?.layoutHeight || Number.NaN) - k), `k=${String(k)}`).toBeLessThanOrEqual(0.05);
        }
    });

    test('@editor { nodes } の cover: 選んだノードの箱を全部囲む矩形を覆い、倍率は掛からない。label を渡しても cover として扱う (B-064)', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await moveBox(page, TASK_A, { cx: 500, cy: 300 });
        await attach(page, 'bounds', { target: { nodes: [TASK_A, TASK_B] }, place: 'cover' }, null);
        await attach(page, 'bounds-label', { target: { nodes: [DESIGN, LEAF] }, place: 'label' }, null);
        for (const factor of [1, 2, 0.5]) {
            if (factor !== 1) await zoomView(page, factor, { x: 500, y: 300 });
            await expectPlaced(page, [
                { name: 'bounds', place: 'cover', selectors: [boxSel(TASK_A), boxSel(TASK_B)] },
                { name: 'bounds-label', place: 'cover', selectors: [boxSel(DESIGN), boxSel(LEAF)] },
            ]);
            const state = await probeOf(page, 'bounds');
            expect(Math.abs((state?.rect.width ?? 0) - (state?.offsetWidth ?? 0))).toBeLessThanOrEqual(1);
            expect(Math.abs((state?.rect.height ?? 0) - (state?.offsetHeight ?? 0))).toBeLessThanOrEqual(1);
        }
    });
});

test.describe('attachOverlay の追従と隠し方 (段 11、2.3、W-7、A-07、B-12)', () => {
    // 4 つの置き方 (ノードの top、文字の label、ノードの集まりの cover、枠の bottom) の要素
    async function attachFollowers(page: Page): Promise<ProbeCheck[]> {
        await attach(page, 'top', { target: { node: DESIGN }, place: 'top', gap: 6 });
        await attach(page, 'label', { target: { node: TASK_A }, place: 'label' }, null);
        await attach(page, 'cover', { target: { nodes: [TASK_A, TASK_B] }, place: 'cover' }, null);
        await attach(page, 'group', { target: { group: GROUP }, place: 'bottom', gap: 4 });
        return [
            { name: 'top', place: 'top', selectors: [boxSel(DESIGN)], gap: 6 },
            { name: 'label', place: 'label', selectors: [contentSel(TASK_A)] },
            { name: 'cover', place: 'cover', selectors: [boxSel(TASK_A), boxSel(TASK_B)] },
            { name: 'group', place: 'bottom', selectors: [frameSel(GROUP)], gap: 4 },
        ];
    }

    test('@editor パン、ズーム、表示位置の置き換え、図のドラッグとホイールのあとも、重ねた要素が相手に付いてくる', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        const checks = await attachFollowers(page);
        await expectPlaced(page, checks);
        const steps: Array<[string, () => Promise<void>]> = [
            ['panBy', () => panView(page, 45, -30)],
            ['zoomBy', () => zoomView(page, 1.6, { x: 400, y: 300 })],
            ['setTransform', () => setTransform(page, { x: -150, y: -40, k: 1.3 })],
            [
                'drag',
                async () => {
                    const blank = await spot(page, { on: 'blank', root: '#a' });
                    await drag(page, blank, { x: blank.x + 70, y: blank.y + 35 });
                },
            ],
            [
                'wheel',
                async () => {
                    const blank = await spot(page, { on: 'blank', root: '#a' });
                    await page.mouse.move(blank.x, blank.y);
                    await page.mouse.wheel(0, 240);
                },
            ],
        ];
        for (const [name, step] of steps) {
            const before = await transformOf(page);
            await step();
            await expect.poll(() => transformOf(page), { message: name }).not.toEqual(before);
            await expectPlaced(page, checks);
        }
    });

    test('@editor 開閉の動きの途中の毎コマと動き終えたあとも、重ねた要素が相手に付いてくる', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit', animate: true });
        const checks = await attachFollowers(page);
        await expectPlaced(page, checks);
        // Deep を閉じると Leaf が消えて Design の枝が動き、開くと戻る
        for (const folded of [[DEEP], []]) {
            const frames = await sampleOverlays(page, folded, checks, boxSel(DESIGN));
            expect(movingFrames(frames, (frame) => frame.watched)).toBeGreaterThan(0);
            for (const [index, frame] of frames.entries()) expect(Math.max(...frame.offsets), `コマ ${String(index)}: ${frame.offsets.join(', ')}`).toBeLessThanOrEqual(1);
            await expectPlaced(page, checks);
        }
    });

    test('@editor 図の領域の大きさが変わると、重ね置きの層が同じ大きさになり、収まるかの判定をやり直す。相手の箱の大きさが変わっても付いてくる', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await setTransform(page, { x: 0, y: 0, k: 1 });
        const box = await moveBox(page, DESIGN, { right: 780, cy: 300 });
        await attach(page, 'panel', { target: { node: DESIGN }, place: ['right', 'bottom'], gap: 8 }, [120, 40]);
        const right: ProbeCheck = { name: 'panel', place: 'right', selectors: [boxSel(DESIGN)], gap: 8 };
        const layerOf = (): Promise<Box | null> => page.evaluate(() => (window as unknown as EditorWindow).measure.rect('a', '#a > .mdag-overlays'));
        await expectPlaced(page, [right]);

        await page.evaluate(() => void ((document.getElementById('a') as HTMLElement).style.width = '850px'));
        // 幅 850 では右に入らない
        expect(box.x + box.width + 8 + 120).toBeGreaterThan(850);
        await expect.poll(async () => gapBetween((await layerOf()) ?? { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 850, height: 600 })).toBeLessThanOrEqual(1);
        await expectPlaced(page, [{ ...right, place: 'bottom' }]);

        await page.evaluate(() => void ((document.getElementById('a') as HTMLElement).style.width = ''));
        await expect.poll(async () => gapBetween((await layerOf()) ?? { x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 1000, height: 600 })).toBeLessThanOrEqual(1);
        await expectPlaced(page, [right]);

        // 詳細をノードの中に開くと Task A の箱が高くなる
        await attach(page, 'under', { target: { node: TASK_A }, place: 'bottom', gap: 4 }, [30, 10]);
        const under: ProbeCheck = { name: 'under', place: 'bottom', selectors: [boxSel(TASK_A)], gap: 4 };
        await expectPlaced(page, [under]);
        const height = (await boxOf(page, TASK_A)).height;
        await setOptions(page, { details: 'always' });
        await expect.poll(async () => (await boxOf(page, TASK_A)).height).toBeGreaterThan(height + 5);
        await expectPlaced(page, [under]);
    });

    test('@editor 相手のノードが閉じた枝に入ると hidden になり、開くと戻って相手に付く。{ nodes } は全部が閉じた枝に入ると hidden', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await attach(page, 'leaf', { target: { node: LEAF }, place: 'right', gap: 4 }, [20, 20]);
        await attach(page, 'both', { target: { nodes: [DEEP, LEAF] }, place: 'cover' }, null);
        const leaf: ProbeCheck = { name: 'leaf', place: 'right', selectors: [boxSel(LEAF)], gap: 4 };
        const both: ProbeCheck = { name: 'both', place: 'cover', selectors: [boxSel(DEEP), boxSel(LEAF)] };
        await expectPlaced(page, [leaf, both]);

        await setFolded(page, [DEEP]);
        await expectHidden(page, 'leaf', true);
        await setFolded(page, []);
        await expectHidden(page, 'leaf', false);
        await expectPlaced(page, [leaf, both]);

        await setFolded(page, [BUILD]);
        await expectHidden(page, 'leaf', true);
        await expectHidden(page, 'both', true);
        await setFolded(page, []);
        await expectHidden(page, 'leaf', false);
        await expectHidden(page, 'both', false);
        await expectPlaced(page, [leaf, both]);
    });

    test('@editor 相手のノードが文書からなくなると hidden になり、同じ id のノードがある文書に替えると戻る。知らない id は hidden', async ({ page }) => {
        await openExits(page);
        await mountView(page, OPEN, { interaction: 'edit' });
        await attach(page, 'leaf', { target: { node: LEAF }, place: 'right', gap: 4 }, [20, 20]);
        await attach(page, 'nowhere', { target: { node: 99 }, place: 'right', gap: 4 }, [20, 20]);
        const leaf: ProbeCheck = { name: 'leaf', place: 'right', selectors: [boxSel(LEAF)], gap: 4 };
        await expectHidden(page, 'nowhere', true);
        await expectPlaced(page, [leaf]);

        await setDocumentOf(page, SHORT);
        await expect(page.locator(node('a', LEAF))).toHaveCount(0);
        await expectHidden(page, 'leaf', true);

        await setDocumentOf(page, OPEN.replace('- Leaf', '- Leaf renamed'));
        await expect(page.locator(node('a', LEAF))).toContainText('Leaf renamed');
        await expectHidden(page, 'leaf', false);
        await expectPlaced(page, [leaf]);
        await expectHidden(page, 'nowhere', true);
    });

    // 期待を変えた (メンバーが 1 つの所も枠にする): single と split は枠に付く (前は見えているメンバーの全体の矩形)
    test('@editor { group }: 枠を描くグループは枠に付き (子のない 1 つのノードだけのグループ、離れた 1 つのメンバー、見えているメンバーが 1 つの所の枠も。枠が 2 つ以上なら最初に描いた枠)、枠を描かないグループ (boundary: false) は見えているメンバーの全体の矩形に付いて hidden にならない。label は top として扱う (A-07、B-12、F-02)', async ({ page }) => {
        await openExits(page);
        await mountView(page, GROUPED, { interaction: 'edit' });
        // 文書の形の確かめ: ノードの並びと、枠は framed 1 つ、single 1 つ、split 2 つ (G1 の枠が先)
        await expect(page.locator(node('a', ID.a1))).toContainText('A1');
        await expect(page.locator(node('a', ID.d1))).toContainText('D1');
        await expect(page.locator('#a .mdag-frame')).toHaveCount(4);
        await expect(page.locator(frameSel('framed'))).toHaveCount(1);
        await expect(page.locator(frameSel('single'))).toHaveCount(1);
        await expect(page.locator(frameSel('split'))).toHaveCount(2);
        await expect.poll(() => framesAround(page, 'split', [ID.g1, ID.d1])).toEqual([[ID.g1], [ID.d1]]);

        for (const group of ['framed', 'loose', 'single', 'split']) await attach(page, group, { target: { group }, place: 'top', gap: 6 });
        await attach(page, 'loose-label', { target: { group: 'loose' }, place: 'label', gap: 6 });
        const split: ProbeCheck = { name: 'split', place: 'top', selectors: [firstFrameSel('split')], gap: 6 };
        await expectPlaced(page, [
            { name: 'framed', place: 'top', selectors: [frameSel('framed')], gap: 6 },
            { name: 'loose', place: 'top', selectors: [boxSel(ID.a1), boxSel(ID.a2)], gap: 6 },
            { name: 'single', place: 'top', selectors: [frameSel('single')], gap: 6 },
            split,
            { name: 'loose-label', place: 'top', selectors: [boxSel(ID.a1), boxSel(ID.a2)], gap: 6 },
        ]);
        for (const name of ['framed', 'loose', 'single', 'split', 'loose-label']) expect((await probeOf(page, name))?.hidden, name).toBe(false);

        // Gamma を閉じると、split の見えているメンバーは D1 だけで、枠は D1 の 1 つ
        await setFolded(page, [ID.gamma]);
        await expect(page.locator(frameSel('split'))).toHaveCount(1);
        await expect.poll(() => framesAround(page, 'split', [ID.g1, ID.d1])).toEqual([[ID.d1]]);
        await expectPlaced(page, [split]);
        expect((await probeOf(page, 'split'))?.hidden).toBe(false);
    });

    test('@editor { group }: 見えているメンバーがなくなると hidden になり、開くと戻る。知らない id は hidden', async ({ page }) => {
        await openExits(page);
        await mountView(page, GROUPED, { interaction: 'edit' });
        for (const group of ['framed', 'loose', 'split', 'nope']) await attach(page, group, { target: { group }, place: 'top', gap: 6 });
        const framed: ProbeCheck = { name: 'framed', place: 'top', selectors: [frameSel('framed')], gap: 6 };
        const loose: ProbeCheck = { name: 'loose', place: 'top', selectors: [boxSel(ID.a1), boxSel(ID.a2)], gap: 6 };
        await expectHidden(page, 'nope', true);
        await expectPlaced(page, [framed, loose]);

        await setFolded(page, [ID.alpha]);
        await expectHidden(page, 'loose', true);
        await setFolded(page, [ID.beta]);
        await expectHidden(page, 'framed', true);
        await expectHidden(page, 'loose', false);
        await expectPlaced(page, [loose]);

        await setFolded(page, [ID.gamma, ID.delta]);
        await expectHidden(page, 'split', true);
        await setFolded(page, [ID.delta]);
        await expectHidden(page, 'split', false);
        // 期待を変えた (見えているメンバーが 1 つの所も枠にする): G1 の箱ではなく G1 の枠に付く
        await expect(page.locator(frameSel('split'))).toHaveCount(1);
        await expect.poll(() => framesAround(page, 'split', [ID.g1, ID.d1])).toEqual([[ID.g1]]);
        await expectPlaced(page, [{ name: 'split', place: 'top', selectors: [frameSel('split')], gap: 6 }]);

        await setFolded(page, []);
        await expectHidden(page, 'framed', false);
        await expectPlaced(page, [framed, loose]);
        await expectHidden(page, 'nope', true);
    });
});

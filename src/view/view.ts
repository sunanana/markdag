// 図の描画と操作。渡された要素の中に、HTML の絶対配置 (ノード) と SVG (線、枠、開閉の円) で図を組み立てる。
// ノードの実測のサイズを射影と配置に渡し、結果を補間しながら反映する。折りたたみ、ズームとパン、全体表示、
// 詳細の吹き出し、線とグループの強調、凡例を受け持つ。見た目は同梱のスタイルシートが持つ。
// グループの枠は簡易版で、メンバーでないノードが枠の矩形に入り込まないよう、間隔を空けて配置をやり直す (枠の分割は行わない)。
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import type { LayoutInput } from '../layout/input-types';
import { boundsOf, layoutChildrenOf, layoutGraph, MARKMAP_DEFAULTS, type PlacedEdge, type Rect } from '../layout/layout';
import { project, type VisibleGraph } from '../layout/project';
import type { OutlineNode, ParsedDocument } from '../parse/document';
import { computeFrames, countIntruders, frameOutline, frameSpacing, LABEL_HEIGHT, type Frame } from './frames';
import type { HookDecoration } from '../model/hooks';
import type { DisplayMode, GraphModel, TagDisplayMode } from '../model/model';
import { formatTag } from '../model/tags';

// 標準の配置 (レイアウト木 + flextree) の代わりに使う配置。別の方式と見比べるための差し込み口で、
// 兄弟の並びは結果の縦の位置から決め、動きの補間はしない
export type LayoutOverride = (graph: VisibleGraph) => { rects: Map<number, Rect>; edges: PlacedEdge[] };

export interface ViewOptions {
    ignoreProxiedDepends: boolean;
    showGaps: boolean;
    showIds: boolean;
    animate: boolean;
    // 詳細の見せ方。auto は文書の指定 (なければ hover) に従う。それ以外は、見る人の選択を文書の指定より優先する
    details: 'auto' | DisplayMode;
    // 凡例を図の右上に出すか。出す項目は文書の指定に従う
    legend: boolean;
    // 背景の明暗。線の縁取りや吹き出しの色が、これに合わせて変わる
    theme: 'light' | 'dark';
    layoutOverride: LayoutOverride | null;
}

// 配置をやり直すたびに外へ渡す、その時点の結果。指標の計算など、図の外での確認に使う
export interface LayoutSnapshot {
    totalNodes: number;
    visibleNodes: number;
    layoutMs: number;
    excludedEdges: number;
    rects: Map<number, Rect>;
    edges: PlacedEdge[];
    gaps: Map<number, number>;
    graph: VisibleGraph;
}

// 図の表示位置。図の座標の点 (px, py) は、図の領域の左上から (x + px * k, y + py * k) の位置に描かれる
export interface ViewTransform {
    x: number;
    y: number;
    k: number;
}

export interface ViewHooks {
    // タスクのリスト項目がクリックされた。状態は原文が持つので、切り替えは呼び出し側が原文を書き換えて行う
    onToggleTask?: (node: OutlineNode) => void;
    // ノードの文字がクリックされた。asTaskToggle は、そのクリックをタスクの切り替えとして扱ったか。
    // リンクや、自分の操作を持つ入れ子の部分のクリックでは呼ばない
    onNodeClick?: (node: OutlineNode, asTaskToggle: boolean) => void;
    // 開閉の円がクリックされた。folded は切り替えたあとの状態。false を返すと、その開閉を行わない。
    // メソッド (setFolded, expandAll, revealNode ほか) による変更は、この受け口を通らない
    beforeFold?: (node: OutlineNode, folded: boolean) => boolean;
    // 線を選ぶ、または選択を解く直前。解くときの edge は null。false を返すと、選択をそのままにする
    beforeSelectEdge?: (edge: PlacedEdge | null, byUser: boolean) => boolean;
    onSelectEdge?: (edge: PlacedEdge | null, byUser: boolean) => void;
    // グループを選ぶ、または選択を解く直前。解くときの id は null
    beforeSelectGroup?: (id: string | null, byUser: boolean) => boolean;
    onSelectGroup?: (id: string | null, byUser: boolean) => void;
    // 詳細の吹き出しを出す直前。pinned は、印のクリックで出したままにするか。false を返すと出さない
    beforeDetailsShow?: (node: OutlineNode, pinned: boolean, byUser: boolean) => boolean;
    onDetailsShow?: (node: OutlineNode, pinned: boolean, byUser: boolean) => void;
    onDetailsHide?: (node: OutlineNode, pinned: boolean) => void;
    // ノードに足す飾り (クラス、説明、短い文字) を返す。要素を作り直したときと refreshDecorations で呼ぶ
    decorateNode?: (node: OutlineNode) => HookDecoration | null;
    onLayout?: (snapshot: LayoutSnapshot) => void;
    // 枝の開閉が変わった。folded は閉じているノードの id (昇順)。byUser は、見る人の操作 (開閉の円のクリック) によるものか。
    // メソッドの呼び出しによる変更でも呼ぶ (byUser は false)。文書の差し替えで開閉が初期の状態に戻るときは呼ばない
    onFoldChange?: (folded: number[], byUser: boolean) => void;
    // 表示位置が変わった。byUser は、見る人の操作 (ドラッグ、ホイール、ピンチ) によるものか
    onTransform?: (transform: ViewTransform, byUser: boolean) => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const { paddingX } = MARKMAP_DEFAULTS;
const BRANCH_COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
// 枝の指定がある文書で、どの枝にも入らないノードの色。線の色は出発ノードの色なので、その線もこの色になる
const NO_BRANCH_COLOR = 'var(--markdag-edge-tree)';
// 強調した線の太さ。線と、その両端のノードの下線と開閉の円をこの太さでそろえて、1 本につながって見えるようにする
const HIGHLIGHT_WIDTH = 3;
const DURATION = 350;
// 枠のラベルの左端の、枠の左の辺からの距離
const FRAME_LABEL_INSET = 6;
// 枠の張り出しを間隔に反映して配置をやり直す回数の上限。間隔を変えると、枠の張り出しも変わることがある
const MAX_LAYOUT_PASSES = 4;
// focusNode で指定したノードを置く、図の領域の上の位置。左と上にはみ出して描かれる内容も見えるよう、隅から離している
const FOCUS_POINT = { x: 160, y: 120 };

const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, tag);
    if (className) element.setAttribute('class', className);
    return element;
};
const stop = (event: Event): void => event.stopPropagation();

// クリックしても、チェックの切り替えに読み替えてはいけない要素 (それ自身が操作を受けるもの)
const CONTROLS = 'button, input, select, textarea, label, summary, option, video, audio, iframe, [contenteditable], [onclick]';
const INTERACTIVE = `a, ${CONTROLS}`;
const CHECKABLE = 'input[type="checkbox"], input[type="radio"]';

// ノードの文字をクリックしたときに切り替えるチェックボックスを探す。クリックした場所から外側へたどり、
// チェックボックスを 1 つだけ含む最も内側の範囲を採る。2 つ以上ある範囲に達したら、どれのことか決められないのでやめる
function findLoneCheckbox(content: Element, target: Element): HTMLInputElement | null {
    for (let scope: Element | null = target; scope; scope = scope === content ? null : scope.parentElement) {
        const inputs = scope.querySelectorAll<HTMLInputElement>(CHECKABLE);
        if (inputs.length === 1) return inputs[0] ?? null;
        if (inputs.length > 1) return null;
    }
    return null;
}

// クリックした場所を囲む、自分の操作を持つ入れ子の部分 (HTML で直接書いたラジオボタンを囲む div など)。
// area そのものは数えない。area の直下の文字 (タスクのラベル) や、詳細の文のクリックでは null になる。
// リンクは文の中に混ざるものなので、リンクがあるだけの段落は、自分の操作を持つ部分とは見なさない
function findNestedZone(area: Element, target: Element): Element | null {
    for (let scope: Element | null = target; scope && scope !== area; scope = scope.parentElement) {
        if (scope.querySelector(CONTROLS)) return scope;
    }
    return null;
}

// タスクの状態の絵 (内容の先頭の SVG) を除いた内容。タスクを切り替えると絵だけが変わるので、内容が同じかを比べるときに外す
const withoutLeadingIcon = (html: string): string => html.replace(/^<svg[\s\S]*?<\/svg>/, '');
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// これまでに作った図の数。要素の id はページの中で一意でなければならないので、図ごとに違う接頭辞を作るのに使う
let instances = 0;

export class MarkdagView {
    options: ViewOptions = {
        ignoreProxiedDepends: false,
        showGaps: false,
        showIds: false,
        animate: true,
        details: 'auto',
        legend: true,
        theme: 'light',
        layoutOverride: null,
    };

    private readonly viewport: HTMLDivElement;
    private readonly legend: HTMLDivElement;
    // 要素の外 (document) に付けた操作の受け口を、破棄のときにまとめて外す
    private readonly teardown = new AbortController();
    private readonly canvas: HTMLDivElement;
    private readonly frameLayer: SVGSVGElement;
    private readonly edgeLayer: SVGSVGElement;
    private readonly nodeLayer: HTMLDivElement;
    private readonly controlLayer: SVGSVGElement;
    private readonly behavior: ZoomBehavior<HTMLDivElement, unknown>;
    private readonly observer: ResizeObserver;

    private nodes: OutlineNode[] = [];
    private model: GraphModel | null = null;
    private childrenOf = new Map<number, number[]>();
    private colorOf = new Map<number, string>();
    private folded = new Set<number>();
    private initialFolded = new Set<number>();

    // 矢印の marker の id。色ごとに 1 つ作り、文書を切り替えても使い回す。
    // 同じページにほかの図があっても、url(#id) がその図の marker (別の配色) を指さないよう、id に図ごとの接頭辞を付ける
    private markers = new Map<string, string>();
    private readonly markerPrefix = `mdag-${++instances}-arrow-`;
    // 選んでいる関係の線と、その前後の段階 (2 = 選んだ線、1 = 前後につながる線、0 = それ以外)
    private selectedEdge: string | null = null;
    private edgeLevels = new Map<string, number>();
    private nodeLevels = new Map<number, number>();
    // カーソルを重ねている線。押せることが分かるよう、選んだときと同じ太さで描く
    private hoveredEdge: string | null = null;
    // 選んでいるグループ。枠の中のノードと、そこに出入りする線だけを残す。線は太くしない
    private selectedGroup: string | null = null;
    private thicken = false;
    private elements = new Map<number, HTMLDivElement>();
    private boxes = new Map<number, HTMLElement>();
    // ノードに今付けている飾り。付け直すときに前のものを外すために控える
    private decorations = new Map<number, HookDecoration>();
    // 文書の差し替えをまたいで引き継ぐ、ノードの中のチェックボックスの状態 (要素を作ったときに戻す)
    private carriedChecks = new Map<number, boolean[]>();
    private lastSizes = new Map<number, string>();
    private displayed = new Map<number, Rect>();
    private targets = new Map<number, Rect>();
    private gaps = new Map<number, number>();
    private edges: PlacedEdge[] = [];
    private frames: Frame[] = [];
    private graph: VisibleGraph | null = null;
    private animation = 0;
    private updateScheduled = false;

    // 詳細の吹き出し。開いて表示する場合と同じ引用の見た目で、タイトルのすぐ下に重ねて出す (配置は動かさない)。
    // 縮小したときにも読めるよう、キャンバスの外 (最外の要素の直下) に置き、拡大のときだけ図の倍率に合わせる
    private readonly popover: HTMLDivElement;
    private zoomScale = 1;
    private popoverNode: OutlineNode | null = null;
    // 印のクリックで開いた吹き出しは、閉じる操作をするまで出したままにする
    private popoverPinned = false;
    private popoverTimer = 0;
    // 最後に分かっているポインタの位置。描き直しのあとで、ポインタがまだ同じノードの上にあるかを調べるのに使う
    private pointer: { x: number; y: number } | null = null;

    constructor(
        private readonly root: HTMLElement,
        private readonly hooks: ViewHooks = {},
    ) {
        root.innerHTML = '';
        root.classList.add('markdag');
        this.viewport = document.createElement('div');
        this.viewport.className = 'mdag-viewport';
        this.canvas = document.createElement('div');
        this.canvas.className = 'mdag-canvas';
        this.frameLayer = svgElement('svg', 'mdag-frames');
        this.edgeLayer = svgElement('svg', 'mdag-edges');
        this.nodeLayer = document.createElement('div');
        this.nodeLayer.className = 'mdag-nodes';
        this.controlLayer = svgElement('svg', 'mdag-controls');
        this.canvas.append(this.frameLayer, this.edgeLayer, this.nodeLayer, this.controlLayer);
        this.viewport.append(this.canvas);
        this.popover = document.createElement('div');
        this.popover.className = 'mdag-popover';
        this.popover.hidden = true;
        this.popover.addEventListener('pointerenter', () => window.clearTimeout(this.popoverTimer));
        this.popover.addEventListener('pointerleave', () => this.scheduleHidePopover());
        this.legend = document.createElement('div');
        this.legend.className = 'mdag-legend';
        root.append(this.viewport, this.popover, this.legend);
        for (const type of ['pointermove', 'pointerdown'] as const) {
            root.addEventListener(type, (event) => (this.pointer = { x: event.clientX, y: event.clientY }), { capture: true });
        }
        const { signal } = this.teardown;
        document.addEventListener(
            'keydown',
            (event) => {
                if (event.key !== 'Escape') return;
                this.hidePopover();
                this.applySelectGroup(null, true);
                this.applySelectEdge(null, true);
            },
            { signal },
        );
        // 線かグループを選んでいるときに、どれでもないところを押したら選択を解く
        this.viewport.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.mdag-edge-hit, .mdag-box, .mdag-fold, [data-group]')) return;
            this.applySelectGroup(null, true);
            this.applySelectEdge(null, true);
        });
        // グループの枠とラベルのクリック。枠は毎回描き直すので、層でまとめて受ける。
        // 図をドラッグして動かしたときに、離した場所のグループを選んでしまわないようにする
        let framePress: { x: number; y: number } | null = null;
        this.frameLayer.addEventListener('pointerdown', (event) => (framePress = { x: event.clientX, y: event.clientY }));
        this.frameLayer.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-group]') : null;
            const moved = framePress !== null && Math.hypot(event.clientX - framePress.x, event.clientY - framePress.y) > 4;
            framePress = null;
            if (!target || moved) return;
            const id = target.dataset.group ?? null;
            this.applySelectGroup(this.selectedGroup === id ? null : id, true);
        });
        document.addEventListener(
            'pointerdown',
            (event) => {
                const target = event.target instanceof Element ? event.target : null;
                if (this.popoverPinned && !target?.closest('.mdag-popover, .mdag-note-mark')) this.hidePopover();
            },
            { signal },
        );

        this.behavior = zoom<HTMLDivElement, unknown>()
            .scaleExtent([0.05, 8])
            .filter((event: MouseEvent | WheelEvent) => (!event.ctrlKey || event.type === 'wheel') && !event.button)
            .on('zoom', (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
                const { x, y, k } = event.transform;
                this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
                this.zoomScale = k;
                this.positionPopover();
                // メソッドの呼び出しによる変更には、もとになった操作のイベントが付かない
                this.hooks.onTransform?.({ x, y, k }, event.sourceEvent != null);
            });
        select(this.viewport).call(this.behavior).on('dblclick.zoom', null);
        // 画面の外にあるノードの入力欄へフォーカスが移ると、ブラウザが図の領域をスクロールして、ズームとパンの状態と表示がずれる。
        // スクロールの対象にならない overflow: clip を使えないブラウザのために、スクロールされたら元に戻す
        this.viewport.addEventListener('scroll', () => this.viewport.scrollTo(0, 0));

        // サイズの変化は検知にだけ使い、値は配置のやり直しの中で読み直す
        this.observer = new ResizeObserver(() => this.scheduleUpdate());
    }

    // fit が false のとき (編集による再描画) は、今のズームとパンを保つ。
    // 木の形と、文書が指定する初期の開閉の両方が前と同じなら、利用者が変えた開閉の状態も保つ
    setDocument(parsed: ParsedDocument, model: GraphModel, fit = true): void {
        const shown = this.popoverNode ? { id: this.popoverNode.id, pinned: this.popoverPinned } : null;
        this.hidePopover();
        this.hoveredEdge = null;
        const sameShape =
            parsed.nodes.length === this.nodes.length && parsed.nodes.every((node, index) => node.parent === this.nodes[index]?.parent);
        // 強調は、木の形が同じなら保つ。強調したまま中のタスクを切り替えても消えないようにするため
        // (タスクの切り替えは原文の書き換えになり、ここを通る)。残っているかどうかは applyHighlight が確かめる
        if (!sameShape) {
            this.selectedEdge = null;
            this.selectedGroup = null;
        }
        const previousInitial = this.initialFolded;
        const previousFolded = this.folded;
        this.carriedChecks = sameShape ? this.collectChecks(parsed.nodes) : new Map();
        this.observer.disconnect();
        cancelAnimationFrame(this.animation);
        for (const layer of [this.frameLayer, this.controlLayer]) layer.innerHTML = '';
        for (const element of this.edgeLayer.querySelectorAll(':scope > :not(marker)')) element.remove();
        this.nodeLayer.innerHTML = '';
        this.elements.clear();
        this.boxes.clear();
        this.decorations.clear();
        this.lastSizes.clear();
        this.displayed.clear();

        this.nodes = parsed.nodes;
        this.model = model;
        this.childrenOf = new Map(parsed.nodes.map((node) => [node.id, []]));
        for (const node of parsed.nodes) if (node.parent !== null) this.childrenOf.get(node.parent)?.push(node.id);

        const markmapOptions = (parsed.frontmatter.markmap ?? {}) as Record<string, unknown>;
        this.assignColors(Number(markmapOptions.colorFreezeLevel ?? 0));
        this.initialFolded = this.computeInitialFold(Number(markmapOptions.initialExpandLevel ?? -1));
        const sameInitial =
            previousInitial.size === this.initialFolded.size && [...previousInitial].every((id) => this.initialFolded.has(id));
        this.folded = new Set(sameShape && sameInitial && !fit ? previousFolded : this.initialFolded);
        this.applyDetailsMode();
        this.syncLegend();
        this.update(false);
        if (fit) this.fit();

        // 開いていた吹き出しは、同じノードが描き直しのあとにも見えていれば、出したままにする。タスクの項目をクリックすると
        // 原文の書き換えで描き直しになり、そのたびに消えて出直すと、ちらついて見える。隠すのも出し直すのも同じ処理の中なので、
        // 画面には消えた状態が出ない。重ねて開いた吹き出しは、ポインタがまだそのノードの上にあるときだけ残す
        const kept = shown && sameShape ? this.nodes[shown.id - 1] : undefined;
        const hasBody = kept !== undefined && (kept.details !== null || this.tagsInPopover(kept));
        if (kept && hasBody && this.detailsMode() !== 'always' && this.boxes.has(kept.id) && (shown?.pinned || this.isPointerOver(kept.id))) {
            this.showPopover(kept, shown?.pinned ?? false, false);
        }
    }

    // ノードの中に HTML で直接書かれたチェックボックスの状態は、原文ではなく画面の要素だけが持つ。文書を差し替えると
    // 要素を作り直すので、内容が前と同じノードの状態を控えておく。まだ要素を作っていないノードは、前に控えたものを持ち越す
    private collectChecks(next: OutlineNode[]): Map<number, boolean[]> {
        const carried = new Map<number, boolean[]>();
        for (const node of next) {
            const before = this.nodes[node.id - 1];
            if (!before || withoutLeadingIcon(before.html) !== withoutLeadingIcon(node.html) || before.details !== node.details) continue;
            const box = this.boxes.get(node.id);
            const checks = box ? [...box.querySelectorAll<HTMLInputElement>(CHECKABLE)].map((input) => input.checked) : this.carriedChecks.get(node.id);
            if (checks && checks.length > 0) carried.set(node.id, checks);
        }
        return carried;
    }

    private restoreChecks(id: number, box: HTMLElement): void {
        const checks = this.carriedChecks.get(id);
        this.carriedChecks.delete(id);
        const inputs = [...box.querySelectorAll<HTMLInputElement>(CHECKABLE)];
        if (!checks || checks.length !== inputs.length) return;
        inputs.forEach((input, index) => (input.checked = checks[index] ?? input.checked));
    }

    private isPointerOver(id: number): boolean {
        const hit = this.pointer ? document.elementFromPoint(this.pointer.x, this.pointer.y) : null;
        return hit !== null && (this.boxes.get(id)?.contains(hit) ?? false);
    }

    setOptions(options: Partial<ViewOptions>): void {
        this.options = { ...this.options, ...options };
        this.nodeLayer.classList.toggle('show-ids', this.options.showIds);
        this.root.classList.toggle('markdag-dark', this.options.theme === 'dark');
        this.applyDetailsMode();
        this.syncLegend();
        if (this.nodes.length > 0) this.update(this.options.animate);
    }

    // 図を片付ける。要素の外に付けた受け口と、サイズの監視を外し、要素の中身を空にする
    destroy(): void {
        this.teardown.abort();
        this.observer.disconnect();
        cancelAnimationFrame(this.animation);
        window.clearTimeout(this.popoverTimer);
        this.root.innerHTML = '';
    }

    expandAll(): void {
        this.folded.clear();
        this.commitFold(false, this.options.animate);
    }

    resetFold(): void {
        this.folded = new Set(this.initialFolded);
        this.commitFold(false, this.options.animate);
    }

    // 閉じているノードの id (昇順)
    getFolded(): number[] {
        return [...this.folded].sort((a, b) => a - b);
    }

    // 開閉の状態を、指定のとおりに置き換える。今の文書にない id と、子のないノードの id は捨てる。
    // 文書を差し替えると開閉は初期の状態に戻ることがあるので、保っておいた状態を戻すのに使う
    setFolded(ids: Iterable<number>): void {
        const next = new Set([...ids].filter((id) => (this.childrenOf.get(id) ?? []).length > 0));
        if (next.size === this.folded.size && [...next].every((id) => this.folded.has(id))) return;
        this.folded = next;
        this.commitFold(false, this.options.animate);
    }

    // 指定のノードが閉じた枝の中にあれば、見えるところまで祖先を開く。表示位置は動かさない
    revealNode(id: number): void {
        if (this.unfoldAncestors(id)) this.commitFold(false, this.options.animate);
    }

    private unfoldAncestors(id: number): boolean {
        let revealed = false;
        for (let parent = this.nodes[id - 1]?.parent ?? null; parent !== null; parent = this.nodes[parent - 1]?.parent ?? null) {
            revealed = this.folded.delete(parent) || revealed;
        }
        return revealed;
    }

    // 開閉の状態を書き換えたあとに呼ぶ。配置をやり直して、変更を外へ知らせる
    private commitFold(byUser: boolean, animate: boolean): void {
        this.update(animate);
        this.hooks.onFoldChange?.(this.getFolded(), byUser);
    }

    getTransform(): ViewTransform {
        const { x, y, k } = zoomTransform(this.viewport);
        return { x, y, k };
    }

    // 表示位置を、指定のとおりに置き換える (倍率の上限と下限には丸めない)。数値として使えない指定は無視する
    setTransform({ x, y, k }: ViewTransform): void {
        if (![x, y, k].every(Number.isFinite) || k <= 0) return;
        select(this.viewport).call(this.behavior.transform, zoomIdentity.translate(x, y).scale(k));
    }

    // 図を、画面の上の距離 (ピクセル) で動かす
    panBy(dx: number, dy: number): void {
        const { k } = zoomTransform(this.viewport);
        // 移動の指定は図の座標で受け取られる (倍率が掛かる) ので、画面の上の距離になるよう倍率で割る
        select(this.viewport).call(this.behavior.translateBy, dx / k, dy / k);
    }

    // 今の倍率に factor を掛ける。point (図の領域の左上からの位置) にある図の場所は、その位置のまま動かない
    zoomBy(factor: number, point: { x: number; y: number }): void {
        select(this.viewport).call(this.behavior.scaleBy, factor, [point.x, point.y]);
    }

    // 図の内容が占める範囲 (図の座標)。全体表示が収める範囲と同じで、枠の張り出しとラベルの行を含む。
    // 動きの補間の途中でも、動き終えたあとの配置で答える。描くものがなければ null
    contentBounds(): Rect | null {
        if (this.targets.size === 0) return null;
        // 枠はノードの外へ余白のぶん広がり、その上にラベルの行が付くので、図の範囲に含める
        const framed = this.frames.flatMap((frame) => {
            const outline = this.outlineOf(frame, this.targets);
            return outline ? [{ ...outline, y: outline.y - LABEL_HEIGHT, height: outline.height + LABEL_HEIGHT }] : [];
        });
        return boundsOf([...[...this.targets].map(([id, rect]) => this.withGap(id, rect)), ...framed]);
    }

    fit(): void {
        const bounds = this.contentBounds();
        if (!bounds) return;
        const { clientWidth, clientHeight } = this.viewport;
        const k = Math.min(2, (clientWidth * 0.94) / Math.max(bounds.width, 1), (clientHeight * 0.92) / Math.max(bounds.height, 1));
        const x = (clientWidth - bounds.width * k) / 2 - bounds.x * k;
        const y = (clientHeight - bounds.height * k) / 2 - bounds.y * k;
        select(this.viewport).call(this.behavior.transform, zoomIdentity.translate(x, y).scale(k));
    }

    // 指定のノードの箱の左上を、図の領域の決まった位置に置いて、倍率を合わせる。
    // 拡大した状態でも、目的のノードを画面に入れて確かめられるようにするためのもの。閉じた枝の中にあれば、先に開く
    focusNode(id: number, k: number): void {
        // 表示位置をすぐに切り替えるので、開くときの動きは付けない
        if (this.unfoldAncestors(id)) this.commitFold(false, false);
        const rect = this.targets.get(id);
        if (!rect) return;
        const transform = zoomIdentity.translate(FOCUS_POINT.x - (rect.x + paddingX) * k, FOCUS_POINT.y - rect.y * k).scale(k);
        select(this.viewport).call(this.behavior.transform, transform);
    }

    // 描く枠の矩形。見えているメンバーが 1 つだけの枠は、色帯で所属が分かるので描かない
    private outlineOf(frame: Frame, rects: Map<number, Rect>): Rect | null {
        return frame.members.filter((id) => rects.has(id)).length < 2 ? null : frameOutline(frame, rects);
    }

    private withGap(id: number, rect: Rect): Rect {
        const gap = this.gaps.get(id) ?? 0;
        return { ...rect, x: rect.x - gap, width: rect.width + gap };
    }

    // 凡例に出す枝の色と名前。枝は、文書が起点を指定したときだけ出す
    private branchLegend(): Array<{ color: string; label: string }> {
        return (this.model?.branches ?? []).map((id) => ({
            color: this.colorOf.get(id) ?? NO_BRANCH_COLOR,
            label: this.nodes[id - 1]?.refText || `#${id}`,
        }));
    }

    // 凡例を作り直す。出す項目は文書の指定に従い、出すものがなければ要素を空にして隠す
    private syncLegend(): void {
        this.legend.replaceChildren();
        const model = this.model;
        if (!model || !this.options.legend) return;
        // 置く隅は文書の指定に従う。位置そのものはスタイルシートが決める
        this.legend.dataset.position = model.legendPosition;
        const list = document.createElement('ul');
        const branches = model.legend.includes('branches') ? this.branchLegend() : [];
        if (branches.length > 0) {
            const note = document.createElement('li');
            note.className = 'mdag-legend-note';
            note.textContent = '線の色 = 出発ノードの枝の色';
            list.append(note);
        }
        for (const branch of branches) {
            const item = document.createElement('li');
            const sample = svgElement('svg');
            sample.setAttribute('width', '34');
            sample.setAttribute('height', '10');
            const line = svgElement('line', 'mdag-edge');
            for (const [name, value] of Object.entries({ x1: 2, y1: 5, x2: 32, y2: 5 })) line.setAttribute(name, String(value));
            line.style.stroke = branch.color;
            sample.append(line);
            item.append(sample, branch.label);
            list.append(item);
        }
        for (const group of model.legend.includes('groups') ? model.groups : []) {
            const item = document.createElement('li');
            const chip = document.createElement('i');
            chip.className = 'mdag-legend-chip';
            chip.style.background = group.color ?? 'transparent';
            item.append(chip, `${group.label}${group.boundary ? ' (枠あり)' : ''}${group.defined ? '' : ' (定義なし)'}`);
            list.append(item);
        }
        if (list.childElementCount > 0) this.legend.append(list);
    }

    // 文書が枝の起点を指定していれば、起点ごとに色を割り当てて配下に引き継ぐ (起点の中の起点は、そこから別の色になる)。
    // 指定がなければ markmap と同じく、枝の経路を colorFreezeLevel の深さで切った文字列ごとに、出てきた順で色を割り当てる
    private assignColors(freezeLevel: number): void {
        const paths = new Map<number, number[]>();
        const assigned = new Map<string, string>();
        this.colorOf.clear();
        const branches = this.model?.branches ?? [];
        if (branches.length > 0) {
            const ofBranch = new Map(branches.map((id, index) => [id, BRANCH_COLORS[index % BRANCH_COLORS.length] ?? NO_BRANCH_COLOR]));
            // ノードは文書順 (親が先) に並んでいるので、親の色をそのまま引き継げる
            for (const node of this.nodes) {
                const inherited = node.parent === null ? NO_BRANCH_COLOR : (this.colorOf.get(node.parent) ?? NO_BRANCH_COLOR);
                this.colorOf.set(node.id, ofBranch.get(node.id) ?? inherited);
            }
            return;
        }
        for (const node of this.nodes) {
            const path = [...(node.parent === null ? [] : (paths.get(node.parent) ?? [])), node.id];
            paths.set(node.id, path);
            const key = (freezeLevel > 0 ? path.slice(0, freezeLevel) : path).join('.');
            if (!assigned.has(key)) assigned.set(key, BRANCH_COLORS[assigned.size % BRANCH_COLORS.length] ?? '#888');
            this.colorOf.set(node.id, assigned.get(key) ?? '#888');
        }
    }

    private computeInitialFold(expandLevel: number): Set<number> {
        const folded = new Set<number>();
        const foldAllUnder = new Set<number>();
        for (const node of this.nodes) {
            const hasChildren = (this.childrenOf.get(node.id) ?? []).length > 0;
            const inherited = node.parent !== null && foldAllUnder.has(node.parent);
            if (node.foldHint === 2 || inherited) foldAllUnder.add(node.id);
            if (hasChildren && (node.foldHint > 0 || inherited || (expandLevel >= 0 && node.depth >= expandLevel))) folded.add(node.id);
        }
        return folded;
    }

    private scheduleUpdate(): void {
        if (this.updateScheduled) return;
        this.updateScheduled = true;
        requestAnimationFrame(() => {
            this.updateScheduled = false;
            if (this.sizesChanged()) this.update(this.options.animate);
        });
    }

    private visibleIds(): Set<number> {
        const visible = new Set<number>();
        for (const node of this.nodes) {
            if (node.parent === null || (visible.has(node.parent) && !this.folded.has(node.parent))) visible.add(node.id);
        }
        return visible;
    }

    private sizesChanged(): boolean {
        const animated = this.animatedBoxes();
        return [...this.visibleIds()].some((id) => {
            const box = this.boxes.get(id);
            return box !== undefined && this.lastSizes.get(id) !== this.sizeOf(box, animated).join('x');
        });
    }

    // CSS の animation か transition が動いている要素を含むノードの箱
    private animatedBoxes(): Set<Element> {
        const boxes = new Set<Element>();
        for (const animation of this.nodeLayer.getAnimations({ subtree: true })) {
            const box = animation.effect instanceof KeyframeEffect ? animation.effect.target?.closest('.mdag-box') : null;
            if (box) boxes.add(box);
        }
        return boxes;
    }

    // 計測は markmap と同じく、はみ出した内容を含む scrollWidth と scrollHeight (祖先の transform の影響を受けない)。
    // ただし、中の要素が動いているノードは、transform で回転する要素などのはみ出しが読む時刻で変わり、
    // 配置のやり直しのたびに大きさが変わってしまうので、はみ出しを含まない箱そのものの大きさを使う
    private sizeOf(box: HTMLElement, animated: Set<Element>): [number, number] {
        return animated.has(box) ? [box.offsetWidth, box.offsetHeight] : [box.scrollWidth, box.scrollHeight];
    }

    // 閉じていたノードの DOM は、初めて表示されるときに作る。閉じたあとは消さずに display: none で残す
    private ensureElement(node: OutlineNode): HTMLDivElement {
        const existing = this.elements.get(node.id);
        if (existing) return existing;
        const model = this.model;
        const element = document.createElement('div');
        element.className = 'mdag-node';
        element.dataset.id = String(node.id);
        element.dataset.depth = String(node.depth);
        // 原文の行の範囲 (「開始,終了」。0 始まりで、終了の行は含まない)。エディタの行と行き来するための手がかり
        if (node.lines) element.dataset.lines = `${node.lines.start},${node.lines.end}`;
        if (node.milestone) element.dataset.milestone = '';
        if (node.task) element.dataset.task = node.task.checked ? 'done' : 'todo';
        const outer = document.createElement('div');
        outer.className = 'mdag-outer';
        const box = document.createElement('div');
        box.className = 'mdag-box';

        const groupIds = model?.groupsOf.get(node.id) ?? [];
        const defs = groupIds.flatMap((id) => model?.groups.find((group) => group.id === id) ?? []);
        const colored = defs.filter((group) => group.color !== null);
        if (colored.length > 0) {
            const bands = document.createElement('span');
            bands.className = 'mdag-bands';
            for (const group of colored) {
                const band = document.createElement('i');
                band.style.background = group.color ?? '';
                band.title = group.label;
                bands.append(band);
            }
            box.append(bands);
        }
        const content = document.createElement('div');
        content.className = 'mdag-content';
        content.innerHTML = node.html;
        // ノードの中の操作が、パンやダブルクリックでのズームにならないようにする
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) content.addEventListener(type, stop);
        // チェックボックスは、箱だけでなく文字をクリックしても切り替わるようにする
        content.addEventListener('click', (event) => this.handleTextClick(node, content, event));
        // 詳細の引用ブロックは、内容の中の書かれた位置にある。開いて表示する場合はその場に出て、ノードの大きさに含まれるので、
        // 配置もそのぶん広がる。タスクのノードでは、詳細の文のクリックも内容のクリックとして、タスクの切り替えになる
        box.append(content);
        // 色のないグループは、文字のラベルで常に見せる
        const plain = defs.filter((group) => group.color === null).map((group) => `%${group.label}`);
        if (plain.length > 0) {
            const groupLabels = document.createElement('span');
            groupLabels.className = 'mdag-labels';
            groupLabels.textContent = plain.join(' ');
            box.append(groupLabels);
        }
        // タグは本文に書いたとおりに見せる。always ならノードの中、hover と click なら詳細と同じ吹き出しの中 (どちらに出すかは CSS が決める)
        const tags = model?.tagsOf.get(node.id) ?? [];
        if (tags.length > 0) {
            element.dataset.hasTags = '';
            const tagLabels = document.createElement('span');
            tagLabels.className = 'mdag-tags';
            tagLabels.textContent = tags.map(formatTag).join(' ');
            box.append(tagLabels);
        }
        if (node.details !== null) element.dataset.hasDetails = '';
        if (node.details !== null || tags.length > 0) {
            // 詳細とタグはノードには表示せず、印だけを出す。ノードに重ねると吹き出しを出し、印のクリックで出したままにする。
            // 印を出すかどうかは、見せ方に合わせて CSS が決める
            const mark = document.createElement('button');
            mark.type = 'button';
            mark.className = 'mdag-note-mark';
            mark.setAttribute('aria-label', '詳細を表示');
            for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) mark.addEventListener(type, stop);
            mark.addEventListener('click', () => {
                if (this.popoverPinned && this.popoverNode === node) this.hidePopover();
                else this.showPopover(node, true);
            });
            box.append(mark);
            box.addEventListener('pointerenter', () => {
                if (this.popoverPinned || this.popoverTrigger() !== 'hover') return;
                window.clearTimeout(this.popoverTimer);
                this.popoverTimer = window.setTimeout(() => this.showPopover(node, false), 250);
            });
            box.addEventListener('pointerleave', () => this.scheduleHidePopover());
        }
        const badge = document.createElement('span');
        badge.className = 'mdag-id';
        badge.textContent = `#${node.id}`;
        element.append(badge);

        this.applyDecoration(node, element, box);
        this.restoreChecks(node.id, box);
        outer.append(box);
        element.append(outer);
        this.nodeLayer.append(element);
        this.elements.set(node.id, element);
        this.boxes.set(node.id, box);
        this.observer.observe(box);
        return element;
    }

    // 飾りを付け直す。フックの外の状態が変わって、返す飾りが変わったときに呼ぶ
    refreshDecorations(): void {
        for (const [id, element] of this.elements) {
            const node = this.nodes[id - 1];
            const box = this.boxes.get(id);
            if (node && box) this.applyDecoration(node, element, box);
        }
        this.scheduleUpdate();
    }

    // decorateNode が返したものをノードに反映する。前に付けたものは先に外す
    private applyDecoration(node: OutlineNode, element: HTMLElement, box: HTMLElement): void {
        const previous = this.decorations.get(node.id);
        if (previous?.className) element.classList.remove(...previous.className.split(/\s+/).filter(Boolean));
        box.querySelector(':scope > .mdag-badge')?.remove();
        const decoration = this.hooks.decorateNode?.(node) ?? null;
        this.decorations.delete(node.id);
        if (decoration === null) {
            box.removeAttribute('title');
            return;
        }
        this.decorations.set(node.id, decoration);
        if (decoration.className) element.classList.add(...decoration.className.split(/\s+/).filter(Boolean));
        if (decoration.title) box.title = decoration.title;
        else box.removeAttribute('title');
        if (decoration.badge) {
            const badge = document.createElement('span');
            badge.className = 'mdag-badge';
            badge.textContent = decoration.badge;
            box.append(badge);
        }
    }

    // ノードの文字 (内容か、開いて表示した詳細) のクリックを、チェックの切り替えに読み替える。
    // タスクのノードでは、タスクを切り替える。ただし、自分の操作を持つ入れ子の部分の中のクリックは、その部分のものとして扱い、
    // タスクは切り替えない。タスクでないノードでは、HTML で直接書いたチェックボックスを切り替える
    private handleTextClick(node: OutlineNode, area: HTMLElement, event: MouseEvent): void {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(INTERACTIVE) || (window.getSelection()?.toString() ?? '') !== '') return;
        const zone = node.task ? findNestedZone(area, target) : area;
        this.hooks.onNodeClick?.(node, zone === null);
        if (zone === null) this.hooks.onToggleTask?.(node);
        else findLoneCheckbox(zone, target)?.click();
    }

    private detailsMode(): DisplayMode {
        return this.options.details === 'auto' ? (this.model?.detailsMode ?? 'hover') : this.options.details;
    }

    private tagMode(): TagDisplayMode {
        return this.model?.tagDisplay ?? 'always';
    }

    // 吹き出しを出すきっかけ。詳細とタグのどちらかが hover なら、ノードに重ねただけで出す
    private popoverTrigger(): 'hover' | 'click' {
        return this.detailsMode() === 'hover' || this.tagMode() === 'hover' ? 'hover' : 'click';
    }

    // ノードの中に出すのではなく吹き出しに入れるタグがあるか (印を出すかの判断にも使う)
    private tagsInPopover(node: OutlineNode): boolean {
        const mode = this.tagMode();
        return (mode === 'hover' || mode === 'click') && this.detailsMode() !== 'always' && (this.model?.tagsOf.get(node.id)?.length ?? 0) > 0;
    }

    // 見せ方は CSS で切り替える。always ではノードの中の詳細を表示し、印と吹き出しは使わない。タグも同じ仕組みで出し分ける
    private applyDetailsMode(): void {
        this.root.dataset.details = this.detailsMode();
        this.root.dataset.tags = this.tagMode();
        if (this.detailsMode() === 'always') this.hidePopover();
    }

    private showPopover(node: OutlineNode, pinned: boolean, byUser = true): void {
        if (this.hooks.beforeDetailsShow?.(node, pinned, byUser) === false) return;
        window.clearTimeout(this.popoverTimer);
        if (this.popoverNode) this.elements.get(this.popoverNode.id)?.removeAttribute('data-pinned');
        this.popoverNode = node;
        this.popoverPinned = pinned;
        this.elements.get(node.id)?.toggleAttribute('data-pinned', pinned);
        // 開いて表示する場合の詳細と同じ要素を入れて、見た目をそろえる。タグも詳細の一部として、そのあとに並べる
        const body = document.createElement('div');
        body.className = 'mdag-details mdag-content';
        body.innerHTML = node.details ?? '';
        if (this.tagsInPopover(node)) {
            const line = document.createElement('p');
            line.className = 'mdag-popover-tags';
            line.textContent = (this.model?.tagsOf.get(node.id) ?? []).map(formatTag).join(' ');
            body.append(line);
        }
        this.popover.replaceChildren(body);
        this.popover.hidden = false;
        this.positionPopover();
        this.hooks.onDetailsShow?.(node, pinned, byUser);
    }

    private scheduleHidePopover(): void {
        if (this.popoverPinned) return;
        window.clearTimeout(this.popoverTimer);
        this.popoverTimer = window.setTimeout(() => this.hidePopover(), 200);
    }

    private hidePopover(): void {
        window.clearTimeout(this.popoverTimer);
        const shown = this.popoverNode;
        const pinned = this.popoverPinned;
        if (shown) this.elements.get(shown.id)?.removeAttribute('data-pinned');
        this.popoverNode = null;
        this.popoverPinned = false;
        this.popover.hidden = true;
        if (shown) this.hooks.onDetailsHide?.(shown, pinned);
    }

    // タイトルのすぐ下に、タイトルの左端にそろえて置く (開いて表示する場合の詳細と同じ位置)。
    // 下に入りきらなければタイトルの上に置き、左右は図の領域の中に収める
    private positionPopover(): void {
        const content = this.popoverNode ? this.boxes.get(this.popoverNode.id)?.querySelector('.mdag-content') : null;
        if (!content || this.popover.hidden) return;
        const scale = Math.max(1, this.zoomScale);
        const area = this.root.getBoundingClientRect();
        const anchor = content.getBoundingClientRect();
        const width = this.popover.offsetWidth * scale;
        const height = this.popover.offsetHeight * scale;
        const below = anchor.bottom - area.top + 2 * scale;
        const top = below + height <= area.height ? below : Math.max(4, anchor.top - area.top - height - 2 * scale);
        const left = Math.min(Math.max(4, anchor.left - area.left - 7 * scale), Math.max(4, area.width - width - 4));
        this.popover.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
    }

    private update(animate: boolean): void {
        const model = this.model;
        if (!model || this.nodes.length === 0) return;
        const visible = this.visibleIds();
        if (this.popoverNode && !visible.has(this.popoverNode.id)) this.hidePopover();
        for (const node of this.nodes) {
            if (visible.has(node.id)) this.ensureElement(node).style.display = '';
            else {
                const element = this.elements.get(node.id);
                if (element) {
                    element.style.display = 'none';
                    for (const media of element.querySelectorAll<HTMLMediaElement>('video, audio')) media.pause();
                }
            }
        }

        const animated = this.animatedBoxes();
        const input: LayoutInput = {
            name: 'view',
            nodes: this.nodes.map((node) => {
                const box = visible.has(node.id) ? this.boxes.get(node.id) : undefined;
                const [width, height] = box ? this.sizeOf(box, animated) : [0, 0];
                if (box) this.lastSizes.set(node.id, `${width}x${height}`);
                return { id: node.id, label: node.refText, width, height, groups: node.groups };
            }),
            treeEdges: this.nodes.flatMap((node) => (node.parent === null ? [] : [{ source: node.parent, target: node.id }])),
            relations: model.relations,
            suppressRootLine: model.suppressRootLine,
            folded: [...this.folded],
        };

        const started = performance.now();
        const graph = project(input);
        const override = this.options.layoutOverride;
        if (override === null) {
            // 兄弟の縦の並びは配置の前に決まっているので、枠のまとまりを先に作り、枠の余白が入るだけ間隔を空ける
            this.frames = computeFrames(graph, model, layoutChildrenOf(graph));
            // 枠の上下の端は、メンバーの子の列の広がりで決まる。1 回目の配置では、その張り出しが分からないので、隣のメンバーでない
            // ノード (葉や、閉じた枝) が枠の矩形に入り込むことがある。2 回目からは、前回の結果の張り出しのぶんだけ間隔を空ける
            let previous: Map<number, Rect> | undefined;
            for (let pass = 1; ; pass++) {
                const result = layoutGraph(graph, {
                    ...MARKMAP_DEFAULTS,
                    ignoreProxiedDepends: this.options.ignoreProxiedDepends,
                    extraSpacing: frameSpacing(this.frames, previous),
                });
                this.targets = new Map([...result.nodes].map(([id, placed]) => [id, placed.rect]));
                this.gaps = new Map([...result.nodes].map(([id, placed]) => [id, placed.gap]));
                this.edges = result.edges;
                if (countIntruders(this.frames, this.targets) === 0 || pass === MAX_LAYOUT_PASSES) break;
                previous = this.targets;
            }
        } else {
            const result = override(graph);
            this.targets = result.rects;
            this.gaps = new Map();
            this.edges = result.edges;
            // この方式は兄弟の並びを配置の結果で決めるので、枠のまとまりも結果から作る (枠の余白は間隔に反映されない)
            const siblings = new Map<number, number[]>();
            for (const [child, parent] of graph.layoutParent) siblings.set(parent, [...(siblings.get(parent) ?? []), child]);
            for (const list of siblings.values()) list.sort((a, b) => (result.rects.get(a)?.y ?? 0) - (result.rects.get(b)?.y ?? 0));
            this.frames = computeFrames(graph, model, siblings);
        }
        const layoutMs = performance.now() - started;
        this.graph = graph;
        this.syncEdgeElements();
        this.syncControls(graph);

        this.hooks.onLayout?.({
            totalNodes: this.nodes.length,
            visibleNodes: graph.nodes.length,
            layoutMs,
            excludedEdges: graph.edges.filter((edge) => edge.excludedFromLayout).length,
            rects: this.targets,
            edges: this.edges,
            gaps: this.gaps,
            graph,
        });
        this.animateToTargets(animate && override === null && this.displayed.size > 0);
    }

    private edgeKey = (placed: PlacedEdge): string => `${placed.edge.kind}:${placed.edge.source}>${placed.edge.target}`;

    // 矢印の色は線ごとに変わるので、色ごとに marker を作る。色は枝の色の一覧に限られるので、数は増え続けない
    private markerFor(color: string): string {
        let id = this.markers.get(color);
        if (id === undefined) {
            id = `${this.markerPrefix}${this.markers.size}`;
            this.markers.set(color, id);
            const marker = svgElement('marker', 'mdag-arrow');
            marker.id = id;
            marker.setAttribute('viewBox', '0 0 8 8');
            marker.setAttribute('refX', '7');
            marker.setAttribute('refY', '4');
            // 既定の markerUnits は線の太さに比例するので、強調やホバーで矢じりまで大きくなる。
            // 図の座標で固定して、太さ 1.6 の線に付いていたときと同じ大きさのままにする
            marker.setAttribute('markerUnits', 'userSpaceOnUse');
            marker.setAttribute('markerWidth', String(7 * 1.6));
            marker.setAttribute('markerHeight', String(7 * 1.6));
            marker.setAttribute('orient', 'auto');
            const head = svgElement('path');
            head.setAttribute('d', 'M0,0L8,4L0,8z');
            head.style.fill = color;
            marker.append(head);
            this.edgeLayer.prepend(marker);
        }
        return `url(#${id})`;
    }

    private syncEdgeElements(): void {
        const wanted = new Set(this.edges.map(this.edgeKey));
        for (const element of this.edgeLayer.querySelectorAll<SVGElement>('[data-key]')) {
            if (!wanted.has(element.dataset.key ?? '')) element.remove();
        }
        for (const placed of this.edges) {
            const key = this.edgeKey(placed);
            const { edge } = placed;
            const isTree = edge.kind === 'tree';
            let path = this.edgeLayer.querySelector<SVGPathElement>(`path.mdag-edge[data-key="${key}"]`);
            if (!path) {
                path = svgElement('path', 'mdag-edge');
                path.dataset.key = key;
                // 関係の線は、交差したときの上下が分かるように、背景の色で縁取ってから描く。
                // 縁取りは自分より前に描いた線を覆うので、線と対にして、線のすぐ前に置く
                const layers: SVGElement[] = [path];
                if (!isTree) {
                    const casing = svgElement('path', 'mdag-edge-casing');
                    casing.dataset.key = key;
                    layers.unshift(casing);
                }
                // 文書が markdag.edgeHighlight: false を指定していれば、線を選ぶ操作そのものを置かない
                if (this.model?.edgeHighlight !== false) layers.push(this.createEdgeHit(key, placed));
                this.edgeLayer.append(...layers);
            }
            path.dataset.kind = edge.excludedFromLayout ? 'excluded' : edge.kind;
            path.classList.toggle('mdag-layout-link', placed.isLayoutLink);
            // 線の色は出発ノードの色 (枝の色)。木の線だけは、markmap と同じく子ノードの色で描く
            const color = edge.excludedFromLayout ? 'var(--markdag-edge-excluded)' :(this.colorOf.get(isTree ? edge.target : edge.source) ?? NO_BRANCH_COLOR);
            path.style.stroke = color;
            path.style.strokeWidth = isTree ? String(MARKMAP_DEFAULTS.lineWidth(this.nodes[edge.target - 1]?.depth ?? 1)) : '';
            if (!isTree) path.setAttribute('marker-end', this.markerFor(color));

            const members = edge.memberRelationIndexes.length;
            let badge = this.edgeLayer.querySelector<SVGTextElement>(`text[data-key="${key}"]`);
            if (members > 1 && !badge) {
                badge = svgElement('text', 'mdag-edge-badge');
                badge.dataset.key = key;
                this.edgeLayer.append(badge);
            }
            if (badge) {
                badge.style.fill = color;
                badge.textContent = members > 1 ? `×${members}` : '';
            }
        }
        this.applyHighlight();
    }

    // 線をクリックできるようにする帯。細い線は狙いにくいので、線に沿って幅を広げた透明な帯を重ねる。
    // 帯は線の層の中に置くので、ノードの箱 (上の層) と重なったところでは、ノードのクリックが優先される
    private createEdgeHit(key: string, placed: PlacedEdge): SVGPathElement {
        const hit = svgElement('path', 'mdag-edge-hit');
        hit.dataset.key = key;
        const title = svgElement('title');
        const name = (id: number): string => this.nodes[id - 1]?.refText || `#${id}`;
        const kind = placed.edge.kind === 'tree' ? '枝' : placed.edge.kind;
        title.textContent = `${name(placed.edge.source)} → ${name(placed.edge.target)} (${kind})`;
        hit.append(title);
        hit.addEventListener('pointerenter', () => {
            this.hoveredEdge = key;
            this.applyHighlight();
        });
        hit.addEventListener('pointerleave', () => {
            if (this.hoveredEdge !== key) return;
            this.hoveredEdge = null;
            this.applyHighlight();
        });
        // 図をドラッグして動かしたときに、離した場所の線を選んでしまわないようにする
        let down: { x: number; y: number } | null = null;
        hit.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
        hit.addEventListener('click', (event) => {
            const moved = down !== null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
            down = null;
            if (moved) return;
            this.applySelectEdge(this.selectedEdge === key ? null : key, true);
        });
        return hit;
    }

    // 線を選ぶと、その線と、前後につながる線だけを残す。
    // 前 = その線の出発点に入ってくる線、後 = その線の行き先から出ていく線
    selectEdge(key: string | null): void {
        this.applySelectEdge(key, false);
    }

    private applySelectEdge(key: string | null, byUser: boolean): void {
        if (key === this.selectedEdge) return;
        const edge = this.find(key) ?? null;
        if (this.hooks.beforeSelectEdge?.(edge, byUser) === false) return;
        this.selectedEdge = key;
        // 線とグループの強調は同時にかけない。あとから選んだほうだけを残し、外れたほうも解除として知らせる
        const clearedGroup = key !== null && this.selectedGroup !== null;
        if (key !== null) this.selectedGroup = null;
        this.applyHighlight();
        this.hooks.onSelectEdge?.(edge, byUser);
        if (clearedGroup) this.hooks.onSelectGroup?.(null, byUser);
    }

    private find(key: string | null): PlacedEdge | undefined {
        return key === null ? undefined : this.edges.find((placed) => this.edgeKey(placed) === key);
    }

    // グループに属するノードと、そこに出入りする線、その線の反対側のノードに印を付ける。
    // そのグループが今の文書にないときは、何も印を付けずに false を返す
    private markGroup(id: string): boolean {
        const members = new Set<number>();
        for (const [nodeId, ids] of this.model?.groupsOf ?? []) if (ids.includes(id)) members.add(nodeId);
        if (members.size === 0) return false;
        for (const nodeId of members) this.nodeLevels.set(nodeId, 1);
        for (const placed of this.edges) {
            const { source, target } = placed.edge;
            const inside = members.has(source) || members.has(target);
            this.edgeLevels.set(this.edgeKey(placed), inside ? 1 : 0);
            if (!inside) continue;
            this.nodeLevels.set(source, 1);
            this.nodeLevels.set(target, 1);
        }
        return true;
    }

    // 選んだグループの枠の中のノードと、そこに出入りする線、その線の反対側のノードを残す
    selectGroup(id: string | null): void {
        this.applySelectGroup(id, false);
    }

    private applySelectGroup(id: string | null, byUser: boolean): void {
        if (id === this.selectedGroup) return;
        if (this.hooks.beforeSelectGroup?.(id, byUser) === false) return;
        this.selectedGroup = id;
        const clearedEdge = id !== null && this.selectedEdge !== null;
        if (id !== null) this.selectedEdge = null;
        this.applyHighlight();
        this.hooks.onSelectGroup?.(id, byUser);
        if (clearedEdge) this.hooks.onSelectEdge?.(null, byUser);
    }

    private applyHighlight(): void {
        const picked = this.find(this.selectedEdge);
        if (!picked) this.selectedEdge = null;
        this.nodeLevels.clear();
        this.edgeLevels.clear();
        // 選んでいた線やグループが、描き直しのあとにもあるとは限らない。なければ選択を解く
        if (this.selectedGroup !== null && !this.markGroup(this.selectedGroup)) this.selectedGroup = null;
        // 選んでいるときはその線、選んでいないときは重ねている線を、つながりの起点にする。
        // 重ねているだけのときはほかを薄くせず、太さだけを付けるので、押したときの形が先に見える
        const anchor = picked ?? (this.selectedEdge === null && this.selectedGroup === null ? this.find(this.hoveredEdge) : undefined);
        const anchorKey = picked ? this.selectedEdge : this.hoveredEdge;
        // 薄くするのは、線かグループを選んでいるときだけ。重ねているだけでほかを薄くすると、動かすたびに図が明滅する
        const dim = picked !== undefined || this.selectedGroup !== null;
        // 線を太くするのは、線を起点にしたときだけ。グループは範囲が広いので、薄くするだけにする
        this.thicken = anchor !== undefined;
        if (anchor) {
            const { source, target } = anchor.edge;
            // 木の線も前後に含める。ノードへ入ってくる線は、その枝が分かれたところから来る線になる
            for (const placed of this.edges) {
                const key = this.edgeKey(placed);
                const level = key === anchorKey ? 2 : placed.edge.target === source || placed.edge.source === target ? 1 : 0;
                this.edgeLevels.set(key, level);
                // 線に届くまでの線、ノードの下線、出ていく線は 1 本につながって見えるので、ノードの側も同じ強さにする
                if (level === 0) continue;
                for (const id of [placed.edge.source, placed.edge.target]) {
                    this.nodeLevels.set(id, Math.max(this.nodeLevels.get(id) ?? 0, level));
                }
            }
        }

        for (const placed of this.edges) {
            const key = this.edgeKey(placed);
            const level = this.edgeLevels.get(key);
            const isTree = placed.edge.kind === 'tree';
            // 木の線の太さは深さで決まっているので、強調のときだけ下限を上げる
            const base = isTree ? MARKMAP_DEFAULTS.lineWidth(this.nodes[placed.edge.target - 1]?.depth ?? 1) : 1.6;
            const hovered = key === this.hoveredEdge;
            const strong = level === 1 || level === 2;
            // グループを選んだときは、線の太さは変えずに、ほかを薄くするだけにする
            const bold = this.thicken && (strong || hovered);
            const width = bold ? Math.max(HIGHLIGHT_WIDTH, base) : base;
            const path = this.edgeLayer.querySelector<SVGPathElement>(`path.mdag-edge[data-key="${key}"]`);
            const casing = this.edgeLayer.querySelector<SVGPathElement>(`path.mdag-edge-casing[data-key="${key}"]`);
            const badge = this.edgeLayer.querySelector<SVGTextElement>(`text[data-key="${key}"]`);
            if (path) {
                // 残した線は、選んだ線も前後の線も同じ濃さにする。1 本につながって見えるものの途中で濃さが変わらないようにするため。
                // 選んでいないときの木の線は、図の骨組みなので関係の線ほど薄くしない。
                // 薄くした線にカーソルを重ねたときは、太さだけでは分からないので少し濃くする
                const dimmed = hovered && this.thicken ? '0.45' : isTree ? '0.3' : '0.1';
                path.style.opacity = !dim ? '' : strong ? '1' : dimmed;
                path.style.strokeWidth = bold ? String(width) : isTree ? String(base) : '';
            }
            // 薄くした線の縁取りは、残した線を消してしまうので出さない
            if (casing) {
                casing.style.opacity = dim && !strong && !hovered ? '0' : '';
                casing.style.strokeWidth = bold ? String(width + 3.5) : '';
            }
            if (badge) badge.style.opacity = path?.style.opacity ?? '';
        }
        this.applyNodeHighlight();
        this.applyFrameHighlight();
    }

    // 選んだグループ以外の枠を薄くする。枠は描き直しのたびに作り直すので、選択が変わったときにも付け直す。
    // 選んだグループに内包されている (メンバーがすべて選んだグループにも属している) 枠は、中身と一緒に残す
    private applyFrameHighlight(): void {
        const selected = this.selectedGroup;
        const nested = (id: string): boolean => {
            let members = 0;
            for (const ids of this.model?.groupsOf.values() ?? []) {
                if (!ids.includes(id)) continue;
                if (selected !== null && !ids.includes(selected)) return false;
                members++;
            }
            return members > 0;
        };
        for (const element of this.frameLayer.querySelectorAll<SVGElement>('[data-group]')) {
            const id = element.dataset.group ?? '';
            element.style.opacity = selected === null || id === selected || nested(id) ? '' : '0.35';
        }
    }

    // ノードの側の見た目。下線と開閉の円は、線と 1 本につながって見えるので、線と同じ太さと濃さにする。
    // カーソルを重ねている線でも同じで、その両端の下線と円を太くする
    private applyNodeHighlight(): void {
        const dim = this.selectedEdge !== null || this.selectedGroup !== null;
        const hovered = this.thicken ? this.find(this.hoveredEdge) : undefined;
        const touched = new Set(hovered ? [hovered.edge.source, hovered.edge.target] : []);
        for (const [id, element] of this.elements) {
            element.style.opacity = dim && !this.nodeLevels.has(id) ? '0.35' : '';
        }
        const bold = (id: number): boolean => this.thicken && (this.nodeLevels.has(id) || touched.has(id));
        const shade = (id: number): string => {
            if (!dim) return '';
            return this.nodeLevels.has(id) ? '1' : touched.has(id) ? '0.45' : '0.3';
        };
        for (const underline of this.edgeLayer.querySelectorAll<SVGLineElement>('.mdag-underline')) {
            const id = Number(underline.dataset.id);
            const base = MARKMAP_DEFAULTS.lineWidth(this.nodes[id - 1]?.depth ?? 1);
            underline.style.strokeWidth = String(bold(id) ? Math.max(HIGHLIGHT_WIDTH, base) : base);
            underline.style.opacity = shade(id);
        }
        for (const circle of this.controlLayer.querySelectorAll<SVGCircleElement>('circle')) {
            const id = Number(circle.dataset.id);
            circle.style.strokeWidth = bold(id) ? String(HIGHLIGHT_WIDTH) : '';
            circle.style.opacity = shade(id);
        }
    }

    private syncControls(graph: VisibleGraph): void {
        this.controlLayer.innerHTML = '';
        for (const node of graph.nodes) {
            const hidden = (this.childrenOf.get(node.id) ?? []).length;
            if (hidden === 0) continue;
            const circle = svgElement('circle', 'mdag-fold');
            circle.dataset.id = String(node.id);
            circle.setAttribute('r', '6');
            circle.style.stroke = this.colorOf.get(node.id) ?? '';
            if (this.folded.has(node.id)) circle.style.fill = this.colorOf.get(node.id) ?? '';
            for (const type of ['mousedown', 'touchstart', 'dblclick']) circle.addEventListener(type, stop);
            circle.addEventListener('click', () => {
                const closing = !this.folded.has(node.id);
                const outline = this.nodes[node.id - 1];
                if (outline && this.hooks.beforeFold?.(outline, closing) === false) return;
                if (closing) this.folded.add(node.id);
                else this.folded.delete(node.id);
                this.commitFold(true, this.options.animate);
            });
            this.controlLayer.append(circle);
        }
    }

    private animateToTargets(animate: boolean): void {
        cancelAnimationFrame(this.animation);
        const from = new Map<number, Rect>();
        for (const [id, target] of this.targets) {
            const current = this.displayed.get(id);
            if (current) {
                from.set(id, current);
                continue;
            }
            // 新しく現れるノードは、配置上の親の今の位置から出てくる
            const parent = this.graph?.layoutParent.get(id);
            const origin = parent === undefined ? undefined : (this.displayed.get(parent) ?? this.targets.get(parent));
            from.set(id, origin ? { ...target, x: origin.x + origin.width, y: origin.y + origin.height - target.height } : target);
        }
        const started = performance.now();
        const step = (now: number): void => {
            const t = animate ? Math.min(1, (now - started) / DURATION) : 1;
            const eased = ease(t);
            const rects = new Map<number, Rect>();
            for (const [id, target] of this.targets) {
                const start = from.get(id) ?? target;
                rects.set(id, {
                    x: lerp(start.x, target.x, eased),
                    y: lerp(start.y, target.y, eased),
                    width: lerp(start.width, target.width, eased),
                    height: lerp(start.height, target.height, eased),
                });
            }
            this.displayed = rects;
            this.draw(rects, t === 1);
            if (t < 1) this.animation = requestAnimationFrame(step);
        };
        step(started);
    }

    private draw(rects: Map<number, Rect>, settled: boolean): void {
        for (const [id, rect] of rects) {
            const element = this.elements.get(id);
            if (element) element.style.transform = `translate(${rect.x + paddingX}px, ${rect.y}px)`;
        }

        for (const element of this.edgeLayer.querySelectorAll('.mdag-underline')) element.remove();
        for (const [id, rect] of rects) {
            const node = this.nodes[id - 1];
            if (!node || rect.width === 0) continue;
            const underline = svgElement('line', 'mdag-underline');
            underline.dataset.id = String(id);
            underline.setAttribute('x1', String(rect.x));
            underline.setAttribute('x2', String(rect.x + rect.width));
            underline.setAttribute('y1', String(rect.y + rect.height));
            underline.setAttribute('y2', String(rect.y + rect.height));
            underline.style.stroke = this.colorOf.get(id) ?? '';
            underline.style.strokeWidth = String(MARKMAP_DEFAULTS.lineWidth(node.depth));
            this.edgeLayer.prepend(underline);
        }

        for (const placed of this.edges) {
            const key = this.edgeKey(placed);
            const source = rects.get(placed.edge.source);
            const target = rects.get(placed.edge.target);
            // 線と、その縁取りの 2 本 (木の線は縁取りを持たないので 1 本)
            const paths = this.edgeLayer.querySelectorAll<SVGPathElement>(`path[data-key="${key}"]`);
            if (paths.length === 0 || !source || !target) continue;
            const [sx, sy] = [source.x + source.width, source.y + source.height];
            const [tx, ty] = [target.x, target.y + target.height];
            const mx = (sx + tx) / 2;
            const d =
                settled && placed.points
                    ? placed.points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join('')
                    : `M${sx},${sy}C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
            for (const path of paths) path.setAttribute('d', d);
            const badge = this.edgeLayer.querySelector<SVGTextElement>(`text[data-key="${key}"]`);
            badge?.setAttribute('x', String(mx));
            badge?.setAttribute('y', String((sy + ty) / 2 - 4));
        }

        for (const circle of this.controlLayer.querySelectorAll<SVGCircleElement>('circle')) {
            const rect = rects.get(Number(circle.dataset.id));
            if (!rect) continue;
            circle.setAttribute('cx', String(rect.x + rect.width));
            circle.setAttribute('cy', String(rect.y + rect.height));
        }

        this.positionPopover();
        // 下線は毎回作り直すので、選んでいる線に合わせた薄さを付け直す
        this.applyNodeHighlight();

        this.frameLayer.innerHTML = '';
        if (this.options.showGaps) {
            for (const [id, rect] of rects) {
                const gap = this.gaps.get(id) ?? 0;
                if (gap <= 0) continue;
                const overlay = svgElement('rect', 'mdag-gap');
                overlay.setAttribute('x', String(rect.x - gap));
                overlay.setAttribute('y', String(rect.y));
                overlay.setAttribute('width', String(gap));
                overlay.setAttribute('height', String(rect.height));
                this.frameLayer.append(overlay);
            }
        }
        // 枠は最も下の層に置くので、重なったところではノードと線のクリックが優先される
        const clickable = this.model?.groupHighlight !== false;
        for (const frame of this.frames) {
            const outline = this.outlineOf(frame, rects);
            if (!outline) continue;
            const shape = svgElement('rect', 'mdag-frame');
            shape.setAttribute('x', String(outline.x));
            shape.setAttribute('y', String(outline.y));
            shape.setAttribute('width', String(outline.width));
            shape.setAttribute('height', String(outline.height));
            shape.setAttribute('rx', '6');
            shape.style.stroke = frame.group.color ?? '#888';
            shape.style.fill = frame.group.color ?? '#888';
            const label = svgElement('text', 'mdag-frame-label');
            label.setAttribute('x', String(outline.x + FRAME_LABEL_INSET));
            label.setAttribute('y', String(outline.y - 4));
            label.style.fill = frame.group.color ?? '#888';
            label.textContent = frame.group.label;
            if (clickable) for (const element of [shape, label]) element.dataset.group = frame.group.id;
            this.frameLayer.append(shape, label);
        }
        this.applyFrameHighlight();
    }
}

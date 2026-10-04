// 図の描画と操作。渡された要素の中に、HTML の絶対配置 (ノード) と SVG (線、枠、開閉の円) で図を組み立てる。
// ノードの実測のサイズを射影と配置に渡し、結果を補間しながら反映する。折りたたみ、ズームとパン、全体表示、
// 詳細の吹き出し、線とグループの強調、凡例を受け持つ。外の層 (GUI 編集) には、選択の印、ノードの位置、図の上に要素を重ねて
// 相手に付いていかせる重ね置きの層を出す (選択の状態と重ねる要素の中身は外が持つ)。見た目は同梱のスタイルシートが持つ。
// グループの枠は、1 つの矩形のまとまりにできれば箱として置き、枠どうしとメンバーでないノードが重ならないようにする (配置は Rust)。
// まとまりにできない枠だけ、メンバーでないノードが枠の矩形に入り込まないよう、間隔を空けて配置をやり直す (枠の分割は行わない)。
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import type { LayoutInput } from '../layout/input-types';
import { boundsOf, layoutDocument, MARKMAP_DEFAULTS, type PlacedEdge, type Rect } from '../layout/layout';
import { project, type VisibleGraph } from '../layout/project';
import type { OutlineNode, ParsedDocument } from '../parse/document';
import { DEFAULT_TASK_CYCLE, taskMarkOf, type TaskMark } from '../parse/task';
import { frameOutline, LABEL_HEIGHT, projectAndFrames, type Frame } from './frames';
import type { HookDecoration } from '../model/hooks';
import type { DisplayMode, GraphModel, TagDisplayMode } from '../model/model';
import { wrapEmoji } from './emoji';
import { frameLabelParts, groupIconRefs, groupLogoHtml, IconSvgStore, iconMarkHtml, legendLogoHtml, nodeIconRefs, tagLineContent, tagParts, withIconMarks, type IconRenderContext } from './icons';

// 標準の配置 (レイアウト木 + flextree) の代わりに使う配置。別の方式と見比べるための差し込み口で、
// 兄弟の並びは結果の縦の位置から決め、動きの補間はしない
export type LayoutOverride = (graph: VisibleGraph) => { rects: Map<number, Rect>; edges: PlacedEdge[] };

// ノードごとの実効の詳細の見せ方。文書の指定に、薄く表示するノードで「出さない」(never) が加わる
type NodeDetailsMode = DisplayMode | 'never';

// 見る人の操作の解釈。view は閲覧 (今までどおり)。edit は操作の解釈を外 (GUI 編集の層) に任せる形で、
// 文書の強調の指定によらず線と枠を押せるようにし、クリックと Esc では線とグループの強調を変えず (変えるのはメソッドだけ)、
// タスクは先頭の状態の絵のクリックでだけ切り替え、ノードの箱の上の主ボタンの押下をパンにしない
export type ViewInteraction = 'view' | 'edit';
// 何もないところのドラッグでパンするボタン。primary は主ボタン、middle は中ボタンだけ、both は両方。ホイールと指のドラッグはどれでも効く
export type DragToPan = 'primary' | 'middle' | 'both';
// onCanvasPointerDown の押した相手。frame は枠と枠のラベル、edge は線を押す帯
export type CanvasTarget = { kind: 'blank' } | { kind: 'frame'; id: string } | { kind: 'edge'; edge: PlacedEdge };
// addHooks で足せる受け口。decorateNode は足せない (ノードの飾りはアプリとフックのもの)
export type ViewListeners = Omit<ViewHooks, 'decorateNode'>;
// 最後に setDocument で渡された文書 (解析の結果と、それから組み立てたモデル)
export interface ViewDocument {
    parsed: ParsedDocument;
    model: GraphModel;
}
// 枝の起点ごとの線の色。label は起点のノードの名前 (refText、なければ #id)。図の凡例の線の色の段と同じ値
export interface BranchColor {
    id: number;
    label: string;
    color: string;
}
// attachOverlay の相手。node はノードの箱、nodes は見えているノードの箱を全部囲む矩形、
// group はグループの枠 (描いていなければ見えているメンバーの箱を全部囲む矩形)。枠が 2 つ以上あれば frame 番目 (描いた順。
// onFrameClick の frame と同じ数え方) の枠で、省いたときとその番号の枠がないときは最初の枠
export type OverlayTarget = { node: number } | { nodes: number[] } | { group: string; frame?: number };
// top / bottom / left / right: 相手の矩形の外の辺の中央に、gap だけ離して置く。top-right: 右上の角に要素の中心を置く。
// label: ノードの文字か枠のラベルの矩形にそろえ、図の倍率を掛ける (要素の幅と高さは図の座標で入れ、transform で拡大する)。
// nodes では cover、枠を描いていない group では top として扱う。cover: 相手の矩形を覆う (倍率は掛けない)
export type OverlayPlacement = 'top' | 'bottom' | 'left' | 'right' | 'top-right' | 'label' | 'cover';
// place を配列で渡すと、図の領域に収まる最初のものを使う (どれも収まらなければ最初のもの)。gap は画面の px で、省くと 8。
// within は、top と bottom の置き場を左右に収める範囲を返す (置くたびに呼ぶ)。渡すと、top と bottom を範囲に収まるよう左右にずらし、
// 図の領域に上下が収まるかで選ぶ。範囲より広い要素は右の辺を範囲の右にそろえる。null を返すとずらさない
export interface OverlayAnchor {
    target: OverlayTarget;
    place: OverlayPlacement | OverlayPlacement[];
    gap?: number;
    within?: () => OverlaySpan | null;
}
// 重ねた要素を左右に収める範囲。図の領域の左上からの画面の px
export interface OverlaySpan {
    left: number;
    right: number;
}
// 全体表示で避ける、図の領域の辺からの幅 (画面の px)。省いた辺は 0
export interface FitInset {
    left?: number;
    top?: number;
    right?: number;
    bottom?: number;
}
// nodeRects の読み方。settled なら、動きの途中でも動き終えたあとの位置 (配置の目標) を今の表示の変換で返す
export interface NodeRectsOptions {
    settled?: boolean;
}

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
    // 見る人の操作の解釈。切り替えると、線を押す帯と枠の押せる印を作り直す
    interaction: ViewInteraction;
    // 何もないところのドラッグでパンするボタン。これだけを変えるときは配置をやり直さない
    dragToPan: DragToPan;
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
    // タスクのノードがクリックされた。状態は原文が持つので、切り替えは呼び出し側が原文を書き換えて行う。
    // cycle は、文書が決めたクリックで進む記号の順 (toggleTask にそのまま渡せる)
    onToggleTask?: (node: OutlineNode, cycle: readonly TaskMark[]) => void;
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
    // ここから下の押下とクリックの受け口は、interaction によらず呼ぶ。
    // ノードの箱の押下。どのボタンでも、箱の中の伝搬止めより先に呼ぶ。中で preventDefault すると文字の選択などの既定の動きを止められる
    onNodePointerDown?: (node: OutlineNode, event: PointerEvent) => void;
    // ノードの文字 (label)、ノードの中に開いた詳細 (details)、吹き出しの詳細 (popover) のダブルクリック。タグの上では呼ばない。図はズームしない
    onNodeDoubleClick?: (node: OutlineNode, place: 'label' | 'details' | 'popover', event: MouseEvent) => void;
    // タグの要素 (interaction が edit のときだけタグごとに分かれる) のクリック。place はノードの中 (node) か吹き出しの中 (popover)。
    // 押してから 4px 以上動いたら呼ばない。ダブルクリックでは 2 回呼ぶ
    onTagClick?: (node: OutlineNode, key: string, place: 'node' | 'popover', event: MouseEvent) => void;
    // 線を押す帯のクリック。押してから 4px 以上動いたら呼ばない
    onEdgeClick?: (edge: PlacedEdge, event: MouseEvent) => void;
    // 枠と枠のラベルのクリック (4px の判定は線と同じ)。押せる枠 (文書が groupHighlight を切っていないか、interaction が edit) だけ。
    // frame は押した枠が、描いた順でそのグループの何番目の枠か (0 から。枠とそのラベルは同じ番号)
    onFrameClick?: (id: string, event: MouseEvent, frame: number) => void;
    onFrameDoubleClick?: (id: string, event: MouseEvent, frame: number) => void;
    // ノードと開閉の円でない所の押下。パンになる押下でも呼ぶ。押せない枠の内側は何もないところ (blank) になる
    onCanvasPointerDown?: (event: PointerEvent, target: CanvasTarget) => void;
    // 何もないところのクリック。押してから 4px 以上動いたら呼ばない
    onCanvasClick?: (event: MouseEvent) => void;
    // setIconSvg でロゴの SVG の置き場の中身が変わった。図の描き直しのあとに呼ぶ (groupLogo を呼び直すと新しいロゴが入る)
    onIconSvg?: (ref: string) => void;
}

// addHooks で足した受け口との重ね方。どちらも、コンストラクタの受け口、足した順の受け口の順に呼ぶ。
// before は、どれかが false を返したらそこで止めて取りやめる (残りは呼ばない)。on は全部呼ぶ
const LISTENER_KINDS = {
    onToggleTask: 'on',
    onNodeClick: 'on',
    beforeFold: 'before',
    beforeSelectEdge: 'before',
    onSelectEdge: 'on',
    beforeSelectGroup: 'before',
    onSelectGroup: 'on',
    beforeDetailsShow: 'before',
    onDetailsShow: 'on',
    onDetailsHide: 'on',
    onLayout: 'on',
    onFoldChange: 'on',
    onTransform: 'on',
    onNodePointerDown: 'on',
    onNodeDoubleClick: 'on',
    onTagClick: 'on',
    onEdgeClick: 'on',
    onFrameClick: 'on',
    onFrameDoubleClick: 'on',
    onCanvasPointerDown: 'on',
    onCanvasClick: 'on',
    onIconSvg: 'on',
} as const satisfies Record<keyof ViewListeners, 'before' | 'on'>;
type ListenerName = keyof typeof LISTENER_KINDS;
type Listener = (...args: unknown[]) => unknown;

const SVG_NS = 'http://www.w3.org/2000/svg';
const { paddingX } = MARKMAP_DEFAULTS;

// 最初に開いておく深さ (frontmatter の markdag.initialExpandLevel)。整数でない値はスキーマが警告にしているので、指定なしと同じくすべて開く
function initialExpandLevelOf(frontmatter: Record<string, unknown>): number {
    const options = frontmatter.markdag;
    const level = typeof options === 'object' && options !== null ? (options as Record<string, unknown>).initialExpandLevel : undefined;
    return typeof level === 'number' && Number.isInteger(level) ? level : -1;
}

const BRANCH_COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
// 枝の指定がある文書で、どの枝にも入らないノードの色。線の色は出発ノードの色なので、その線もこの色になる
const NO_BRANCH_COLOR = 'var(--markdag-edge-tree)';
// 強調した線の太さ。線と、その両端のノードの下線と開閉の円をこの太さでそろえて、1 本につながって見えるようにする
const HIGHLIGHT_WIDTH = 3;
const DURATION = 350;
// 枠のラベルの左端の、枠の左の辺からの距離
const FRAME_LABEL_INSET = 6;
// focusNode で指定したノードを置く、図の領域の上の位置。左と上にはみ出して描かれる内容も見えるよう、隅から離している
const FOCUS_POINT = { x: 160, y: 120 };

const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K, className?: string): SVGElementTagNameMap[K] => {
    const element = document.createElementNS(SVG_NS, tag);
    if (className) element.setAttribute('class', className);
    return element;
};
const stop = (event: Event): void => event.stopPropagation();
// 押してから離すまでにこれより動いたら、クリックとして扱わない (図のドラッグの終わりで選んでしまわないため)
const CLICK_SLOP = 4;
const movedFrom = (press: { x: number; y: number } | null, event: MouseEvent): boolean =>
    press !== null && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP;

// 重ねた要素と相手の間を省いたときの値 (画面の px)
const OVERLAY_GAP = 8;
// ensureVisible で、図の領域の辺から残す幅を省いたときの値 (画面の px)
const VISIBLE_MARGIN = 24;

// attachOverlay で重ねた要素。hiddenByView は view が相手を見失って hidden にしたか (戻すのは自分で隠したものだけ)。
// sized は view が幅と高さを入れたか (label と cover)。saved は、外すときと自分の大きさで置き直すときに戻す、元の style の値
interface OverlayEntry {
    element: HTMLElement;
    anchor: OverlayAnchor;
    hiddenByView: boolean;
    sized: boolean;
    saved: { width: string; height: string; transform: string };
}
// 重ねた要素を置き直す 1 回分の読み取り。図の領域の画面の矩形、見えているノード、図の倍率
interface OverlayContext {
    origin: DOMRect;
    visible: Set<number>;
    k: number;
}
// 重ねる相手の画面の矩形。label は文字か枠のラベルの矩形で、ないときの label は labelAs の置き方で扱う
interface OverlaySubject {
    rect: Rect;
    label: Rect | null;
    labelAs: 'cover' | 'top';
}

// 要素の画面の矩形を、origin (図の領域の矩形) の左上からの座標にする
const rectWithin = (element: Element, origin: DOMRect): Rect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
};

// 重ねた要素を place に置いたときの画面の矩形。own は要素の大きさ (top、bottom、left、right、top-right で使う)
function overlaySpot(place: OverlayPlacement, subject: OverlaySubject, own: { width: number; height: number }, gap: number): Rect & { place: OverlayPlacement } {
    const { rect } = subject;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    if (place === 'top') return { place, x: cx - own.width / 2, y: rect.y - gap - own.height, ...own };
    if (place === 'bottom') return { place, x: cx - own.width / 2, y: rect.y + rect.height + gap, ...own };
    if (place === 'left') return { place, x: rect.x - gap - own.width, y: cy - own.height / 2, ...own };
    if (place === 'right') return { place, x: rect.x + rect.width + gap, y: cy - own.height / 2, ...own };
    if (place === 'top-right') return { place, x: rect.x + rect.width - own.width / 2, y: rect.y - own.height / 2, ...own };
    if (place === 'label' && subject.label) return { place, ...subject.label };
    return { place: 'cover', ...rect };
}

const finiteOrZero = (value: number | undefined): number => (value !== undefined && Number.isFinite(value) ? value : 0);

// 長さ size の区間 [start, start + size] を [margin, extent - margin] に収める、いちばん短い移動量。収まっていれば 0。
// 収まる幅より長い区間は、始まり (左か上) の辺を margin にそろえる
function shiftInto(start: number, size: number, extent: number, margin: number): number {
    if (start < margin || size > extent - 2 * margin) return margin - start;
    const end = start + size;
    return end > extent - margin ? extent - margin - end : 0;
}

// 幅 width の要素を範囲 span に収める左の辺の位置 (x から、はみ出す分だけずらす)。範囲より広い要素は右の辺を範囲の右にそろえる
function placeInSpan(x: number, width: number, span: OverlaySpan): number {
    if (width > span.right - span.left) return span.right - width;
    return x + shiftInto(x - span.left, width, span.right - span.left, 0);
}

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

// タスクのノードの内容のうち、詳細のブロック以外 (状態の絵と文字) を包む span のクラス。
// 中止の取り消し線を、詳細に及ぼさず文字にだけ引くための入れ物
const TASK_LABEL_CLASS = 'mdag-task-label';

function wrapTaskLabel(content: HTMLElement): void {
    let run: ChildNode[] = [];
    const flush = (): void => {
        const first = run[0];
        if (!first) return;
        const label = document.createElement('span');
        label.className = TASK_LABEL_CLASS;
        first.before(label);
        label.append(...run);
        run = [];
    };
    for (const child of [...content.childNodes]) {
        if (child instanceof Element && child.classList.contains('mdag-details')) flush();
        else run.push(child);
    }
    flush();
}

// クリックした場所を囲む、自分の操作を持つ入れ子の部分 (HTML で直接書いたラジオボタンを囲む div など)。
// area そのものと、タスクの文字を包む span は数えない。area の直下の文字 (タスクのラベル) や、詳細の文のクリックでは null になる。
// リンクは文の中に混ざるものなので、リンクがあるだけの段落は、自分の操作を持つ部分とは見なさない
function findNestedZone(area: Element, target: Element): Element | null {
    for (let scope: Element | null = target; scope && scope !== area && !scope.classList.contains(TASK_LABEL_CLASS); scope = scope.parentElement) {
        if (scope.querySelector(CONTROLS)) return scope;
    }
    return null;
}

// クリックした場所が、タスクの先頭の状態の絵 (タスクの文字を包む span の先頭の SVG) の中か
function onTaskIcon(area: Element, target: Element): boolean {
    const icon = area.querySelector(`:scope > .${TASK_LABEL_CLASS} > svg:first-child`);
    return icon !== null && icon.contains(target);
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
        interaction: 'view',
        dragToPan: 'primary',
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
    // 最後に setDocument で渡された解析の結果 (getDocument が返す。モデルと対で持つ)
    private parsed: ParsedDocument | null = null;
    private model: GraphModel | null = null;
    // addHooks で足した受け口 (足した順)。外すときに見分けられるよう、足すたびに入れ物を作る
    private added: Array<{ listeners: ViewListeners }> = [];
    // コンストラクタの受け口と足した受け口を、受け口ごとに 1 つの呼び先にまとめたもの (読むたびに今の受け口から組む)
    private readonly composed: ViewHooks = this.composeHooks();
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
    // selectGroups で、選んでいるグループ (代表) と一緒に強調している残りのグループ (選んだ順)。代表がないときは空
    private alsoSelectedGroups: string[] = [];
    private thicken = false;
    private elements = new Map<number, HTMLDivElement>();
    // ロゴの SVG の置き場 (ref → SVG)。入っていない ref のロゴは文字のまま描く。入れるのは setIconSvg
    private readonly iconSvgs = new IconSvgStore();
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
    // 一部共有する枠の組で、core が outline の左の辺と右の辺を右へずらした量 (枠ごと)。
    // 描画の毎コマ outline をノードの矩形から作り直すので、配置のたびに core の outline との差を覚えて足す
    private frameShifts = new Map<Frame, { left: number; right: number }>();
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
    // ページの上で最後にポインタが動いた (押された) 位置が、図の要素の上だったか。キーを受けるかの判定に使う
    private pointerOnRoot = false;
    // setSelection で選んだノード。まだ要素のないノードにも、要素を作るときに印を付けるため控える (文書を差し替えると空に戻す)
    private selection = new Set<number>();
    // setDropTarget で印を付けたノード (見えているノードだけ)
    private dropTarget: number | null = null;
    // 描いた枠の要素 (描いた順)。attachOverlay の { group } の相手を読むのに使う。label は枠のラベルの文字とロゴ
    private drawnFrames: Array<{ id: string; outline: SVGElement; label: SVGElement[] }> = [];
    // 重ね置きの層 (attachOverlay が初めて呼ばれたときに作る) と、重ねた要素 (重ねた順)
    private overlayLayer: HTMLDivElement | null = null;
    private overlays: OverlayEntry[] = [];
    // 重ね置きの層 (図の領域と同じ大きさ) と重ねた要素の大きさが変わったら置き直す
    private readonly overlayObserver = new ResizeObserver(() => this.placeOverlays());

    constructor(
        private readonly root: HTMLElement,
        private readonly own: ViewHooks = {},
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
        // 吹き出しの詳細のダブルクリック。タグの行の上では呼ばない
        this.popover.addEventListener('dblclick', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const node = this.popoverNode;
            if (node && target && !target.closest('.mdag-popover-tags')) this.hooks.onNodeDoubleClick?.(node, 'popover', event);
        });
        this.listenTagClicks(this.popover, () => this.popoverNode, 'popover');
        this.legend = document.createElement('div');
        this.legend.className = 'mdag-legend';
        root.append(this.viewport, this.popover, this.legend);
        for (const type of ['pointermove', 'pointerdown'] as const) {
            root.addEventListener(type, (event) => (this.pointer = { x: event.clientX, y: event.clientY }), { capture: true });
        }
        const { signal } = this.teardown;
        // Esc は吹き出しを閉じ、線とグループの強調を解く (GUI 編集では吹き出しだけ)。ページのほかの所で打った Esc は受けない
        document.addEventListener(
            'keydown',
            (event) => {
                if (event.key !== 'Escape' || !this.ownsKeys()) return;
                this.hidePopover();
                if (this.options.interaction === 'edit') return;
                this.applySelectGroup(null, true);
                this.applySelectEdge(null, true);
            },
            { signal },
        );
        for (const type of ['pointermove', 'pointerdown'] as const) {
            document.addEventListener(type, (event) => (this.pointerOnRoot = event.target instanceof Node && this.root.contains(event.target)), { capture: true, signal });
        }
        // 図の領域の押下。押した相手を外へ知らせ、何もないところのクリックの 4px の判定に使う位置を控える。
        // ノードの中の伝搬止めより先に受ける (ノードの上の押下も位置だけは控える)
        let canvasPress: { x: number; y: number } | null = null;
        this.viewport.addEventListener(
            'pointerdown',
            (event) => {
                canvasPress = { x: event.clientX, y: event.clientY };
                const target = this.canvasTargetOf(event.target);
                if (target) this.hooks.onCanvasPointerDown?.(event, target);
            },
            { capture: true },
        );
        // 中ボタンでパンするときは、中ボタンの押下の既定の動き (自動スクロール) を止める
        this.viewport.addEventListener(
            'mousedown',
            (event) => {
                if (event.button === 1 && this.dragToPanAllows('middle')) event.preventDefault();
            },
            { capture: true },
        );
        // 何もないところのクリック。閲覧では、線かグループを選んでいれば選択を解く
        this.viewport.addEventListener('click', (event) => {
            const moved = movedFrom(canvasPress, event);
            canvasPress = null;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.mdag-edge-hit, .mdag-box, .mdag-fold, [data-group]')) return;
            if (this.options.interaction !== 'edit') {
                this.applySelectGroup(null, true);
                this.applySelectEdge(null, true);
            }
            if (!moved) this.hooks.onCanvasClick?.(event);
        });
        // グループの枠とラベルのクリック。枠は毎回描き直すので、層でまとめて受ける。
        // 図をドラッグして動かしたときに、離した場所のグループを選んでしまわないようにする
        let framePress: { x: number; y: number } | null = null;
        this.frameLayer.addEventListener('pointerdown', (event) => (framePress = { x: event.clientX, y: event.clientY }));
        this.frameLayer.addEventListener('click', (event) => {
            const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-group]') : null;
            const moved = movedFrom(framePress, event);
            framePress = null;
            const id = target?.dataset.group;
            if (!target || id === undefined || moved) return;
            if (this.options.interaction !== 'edit') this.applySelectGroup(this.selectedGroup === id ? null : id, true);
            this.hooks.onFrameClick?.(id, event, this.frameIndexOf(target));
        });
        this.frameLayer.addEventListener('dblclick', (event) => {
            const target = event.target instanceof Element ? event.target.closest<SVGElement>('[data-group]') : null;
            const id = target?.dataset.group;
            if (target && id !== undefined) this.hooks.onFrameDoubleClick?.(id, event, this.frameIndexOf(target));
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
            .filter((event: MouseEvent | WheelEvent | TouchEvent) => this.startsPanZoom(event))
            .on('zoom', (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
                const { x, y, k } = event.transform;
                this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
                this.zoomScale = k;
                this.positionPopover();
                this.placeOverlays();
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

    // 受け口の呼び先。足した受け口がなければコンストラクタの受け口そのもの (足さない図の呼び方は今までと同じ)
    private get hooks(): ViewHooks {
        return this.added.length === 0 ? this.own : this.composed;
    }

    // コンストラクタの受け口のあとに呼ぶ受け口を足す。戻り値の関数で外す (何度呼んでもよい)。destroy で全部外れる。
    // decorateNode は渡されても使わない
    addHooks(listeners: ViewListeners): () => void {
        const entry = { listeners };
        this.added = [...this.added, entry];
        return () => {
            this.added = this.added.filter((item) => item !== entry);
        };
    }

    // 受け口ごとに、読んだ時点の受け口から呼び先を組む口を持つ入れ物。decorateNode はコンストラクタのものだけ
    private composeHooks(): ViewHooks {
        const composed: ViewHooks = {};
        for (const name of Object.keys(LISTENER_KINDS) as ListenerName[]) {
            Object.defineProperty(composed, name, { enumerable: true, get: () => this.listenerOf(name) });
        }
        Object.defineProperty(composed, 'decorateNode', { enumerable: true, get: () => this.own.decorateNode?.bind(this.own) });
        return composed;
    }

    // 1 つの受け口の呼び先。どれも持たなければ undefined (呼ばない)。それぞれ持ち主のメソッドとして呼ぶ
    private listenerOf(name: ListenerName): Listener | undefined {
        const owners = [this.own, ...this.added.map((entry) => entry.listeners)].flatMap((holder) => {
            const listener = holder[name];
            return typeof listener === 'function' ? [{ holder, listener: listener as Listener }] : [];
        });
        if (owners.length === 0) return undefined;
        if (LISTENER_KINDS[name] === 'before') return (...args) => owners.every(({ holder, listener }) => listener.apply(holder, args) !== false);
        return (...args) => {
            for (const { holder, listener } of owners) listener.apply(holder, args);
        };
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
            this.alsoSelectedGroups = [];
        }
        const previousInitial = this.initialFolded;
        const previousFolded = this.folded;
        this.carriedChecks = sameShape ? this.collectChecks(parsed.nodes) : new Map();
        // 選択と付け替え先の印は文書ごとのもの。差し替えたら外す (選び直すのは呼び出し側)
        this.selection = new Set();
        this.dropTarget = null;
        this.observer.disconnect();
        cancelAnimationFrame(this.animation);
        for (const layer of [this.frameLayer, this.controlLayer]) layer.innerHTML = '';
        this.drawnFrames = [];
        for (const element of this.edgeLayer.querySelectorAll(':scope > :not(marker)')) element.remove();
        this.nodeLayer.innerHTML = '';
        this.elements.clear();
        this.boxes.clear();
        this.decorations.clear();
        this.lastSizes.clear();
        this.displayed.clear();

        this.nodes = parsed.nodes;
        this.parsed = parsed;
        this.model = model;
        this.childrenOf = new Map(parsed.nodes.map((node) => [node.id, []]));
        for (const node of parsed.nodes) if (node.parent !== null) this.childrenOf.get(node.parent)?.push(node.id);

        this.assignColors();
        this.initialFolded = this.computeInitialFold(initialExpandLevelOf(parsed.frontmatter));
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
        if (kept && this.hasPopoverBody(kept) && this.boxes.has(kept.id) && (shown?.pinned || this.isPointerOver(kept.id))) {
            this.showPopover(kept, shown?.pinned ?? false, false);
        }
        // 描くノードのない文書では描画を通らないので、重ねた要素の相手がなくなったことをここで反映する
        this.placeOverlays();
    }

    // 最後に setDocument で渡された解析の結果とモデル (渡されたものそのもの)。まだ渡されていなければ null
    getDocument(): ViewDocument | null {
        return this.parsed && this.model ? { parsed: this.parsed, model: this.model } : null;
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

    // パンとズームを始める入力か (d3-zoom が押下とホイールのたびに読む)。ホイールはいつでも通す (ctrl つきのピンチを含む)。
    // ctrl つきの押下は通さない。ボタンの押下は dragToPan に従い、指の押下はいつでも通す。
    // GUI 編集では、ノードの箱の上の主ボタンと指の押下はパンにしない (中ボタンは dragToPan に従って通す)
    private startsPanZoom(event: MouseEvent | WheelEvent | TouchEvent): boolean {
        if (event.type === 'wheel') return true;
        if (event.ctrlKey) return false;
        if (event instanceof MouseEvent) {
            if (event.button === 1) return this.dragToPanAllows('middle');
            if (event.button !== 0 || !this.dragToPanAllows('primary')) return false;
        }
        const onBox = event.target instanceof Element && event.target.closest('.mdag-box') !== null;
        return !(onBox && this.options.interaction === 'edit');
    }

    // 何もないところのドラッグでパンするボタンか。middle と both のほかは primary として扱う
    private dragToPanAllows(button: 'primary' | 'middle'): boolean {
        const { dragToPan } = this.options;
        if (dragToPan === 'both') return true;
        return dragToPan === 'middle' ? button === 'middle' : button === 'primary';
    }

    // キーを受けるか。フォーカスが図の要素の中にあるか、フォーカスがどこにもなく (body か null) 最後のポインタの位置が図の上にあるとき。
    // 図の外の入力欄で打ったキーと、同じページのほかの図に向けたキーを受けない
    private ownsKeys(): boolean {
        const active = document.activeElement;
        if (active === null || active === document.body) return this.pointerOnRoot;
        return this.root.contains(active);
    }

    // 図の領域の押下の相手。ノードの箱と開閉の円は null (図の領域の押下として扱わない)。枠は押せるもの (data-group を持つもの) だけ
    private canvasTargetOf(element: EventTarget | null): CanvasTarget | null {
        const target = element instanceof Element ? element : null;
        if (target?.closest('.mdag-box, .mdag-fold')) return null;
        const hit = target?.closest<SVGElement>('.mdag-edge-hit');
        const edge = hit ? this.find(hit.dataset.key ?? null) : undefined;
        if (edge) return { kind: 'edge', edge };
        const id = target?.closest<SVGElement>('[data-group]')?.dataset.group;
        return id === undefined ? { kind: 'blank' } : { kind: 'frame', id };
    }

    // 線を押す帯を置くか。文書が markdag.edgeHighlight: false を指定していれば置かない。GUI 編集では文書の指定によらず置く
    private edgesPressable(): boolean {
        return this.model?.edgeHighlight !== false || this.options.interaction === 'edit';
    }

    // 枠を押せるようにするか (枠の要素に data-group を付けるか)。線の帯と同じく、GUI 編集では文書の指定 (groupHighlight) によらない
    private framesPressable(): boolean {
        return this.model?.groupHighlight !== false || this.options.interaction === 'edit';
    }

    // 操作の切り替えの目印。既定の値 (view と primary) では付けない (閲覧の図の DOM を変えない)
    private applyInteractionMarks(): void {
        if (this.options.interaction === 'edit') this.root.dataset.interaction = 'edit';
        else delete this.root.dataset.interaction;
        const { dragToPan } = this.options;
        if (dragToPan === 'middle' || dragToPan === 'both') this.root.dataset.dragToPan = dragToPan;
        else delete this.root.dataset.dragToPan;
    }

    setOptions(options: Partial<ViewOptions>): void {
        const wasEditing = this.options.interaction === 'edit';
        this.options = { ...this.options, ...options };
        this.applyInteractionMarks();
        // パンのボタンだけの切り替え (道具や Space の切り替えのたびに起きる) では、配置をやり直さない
        const keys = Object.keys(options);
        if (keys.length > 0 && keys.every((key) => key === 'dragToPan')) return;
        this.nodeLayer.classList.toggle('show-ids', this.options.showIds);
        this.root.classList.toggle('markdag-dark', this.options.theme === 'dark');
        this.applyDetailsMode();
        this.syncLegend();
        // タグの分け方は interaction で変わるので、切り替えたら描いてあるタグを作り直す (線の帯と枠は配置のやり直しで作り直す)
        if (wasEditing !== (this.options.interaction === 'edit')) this.refillTags();
        if (this.nodes.length > 0) this.update(this.options.animate);
    }

    // 図を片付ける。要素の外に付けた受け口、addHooks で足した受け口、サイズの監視、重ねた要素を外し、要素の中身を空にする
    destroy(): void {
        this.teardown.abort();
        this.added = [];
        this.observer.disconnect();
        this.overlayObserver.disconnect();
        for (const entry of this.overlays) this.detachOverlay(entry);
        this.overlayLayer = null;
        cancelAnimationFrame(this.animation);
        window.clearTimeout(this.popoverTimer);
        this.root.innerHTML = '';
        // 線を選んでいる目印は図を置いた要素に付けているので、要素を別の用途に使い回しても code の地の透かしが残らないよう外す
        this.root.removeAttribute('data-edge-selected');
        // 操作の切り替えの目印も同じ理由で外す
        this.root.removeAttribute('data-interaction');
        this.root.removeAttribute('data-drag-to-pan');
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

    // 図の内容の全体を図の領域に収める。inset を渡すと、図の領域の辺からその幅を除いた所に収める (収める所が残らなければ図の領域の全体)
    fit(inset: FitInset = {}): void {
        const bounds = this.contentBounds();
        if (!bounds) return;
        const { clientWidth, clientHeight } = this.viewport;
        const left = finiteOrZero(inset.left);
        const top = finiteOrZero(inset.top);
        const width = clientWidth - left - finiteOrZero(inset.right);
        const height = clientHeight - top - finiteOrZero(inset.bottom);
        const room = width > 0 && height > 0 ? { left, top, width, height } : { left: 0, top: 0, width: clientWidth, height: clientHeight };
        const k = Math.min(2, (room.width * 0.94) / Math.max(bounds.width, 1), (room.height * 0.92) / Math.max(bounds.height, 1));
        const x = room.left + (room.width - bounds.width * k) / 2 - bounds.x * k;
        const y = room.top + (room.height - bounds.height * k) / 2 - bounds.y * k;
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

    // 選んだノードに data-selected を付け、ほかのノードから外す。文書にない id は捨てる。
    // 閉じた枝の中でまだ要素のないノードは、要素を作るときに付ける。文書を差し替えると選択は空に戻る
    setSelection(ids: Iterable<number>): void {
        this.selection = new Set([...ids].filter((id) => this.hasNode(id)));
        for (const [id, element] of this.elements) element.toggleAttribute('data-selected', this.selection.has(id));
    }

    // 付け替え先のノードに data-drop-target を付ける (付くのは 1 つだけ。null で外す)。
    // 見えていないノード (閉じた枝の中) には付けず、あとで開いても付けない
    setDropTarget(id: number | null): void {
        if (this.dropTarget !== null) this.elements.get(this.dropTarget)?.removeAttribute('data-drop-target');
        const element = id !== null && this.isShown(id) ? this.elements.get(id) : undefined;
        this.dropTarget = element && id !== null ? id : null;
        element?.toggleAttribute('data-drop-target', true);
    }

    // 見えているノードの箱の矩形。図の領域の左上からの画面の座標 (zoomBy の point と同じ) で、動きの途中は今描いている位置。
    // settled なら、動き終えたあとの位置 (配置の目標) を今の表示の変換で返す。ids を省くと見えている全部。
    // 閉じた枝の中のノードと文書にない id は入れない (図の領域の外へパンしたノードは入れる)
    nodeRects(ids?: Iterable<number>, options: NodeRectsOptions = {}): Map<number, Rect> {
        const visible = this.visibleIds();
        const origin = this.viewport.getBoundingClientRect();
        const { k } = zoomTransform(this.viewport);
        const rects = new Map<number, Rect>();
        for (const id of ids ?? visible) {
            const box = visible.has(id) ? this.boxes.get(id) : undefined;
            if (!box) continue;
            const rect = rectWithin(box, origin);
            // ノードの要素は配置の矩形の位置へ平行移動するだけなので、今の位置と目標の差を倍率で画面の距離にして足す
            const shown = options.settled ? this.displayed.get(id) : undefined;
            const goal = this.targets.get(id);
            if (shown && goal) {
                rect.x += (goal.x - shown.x) * k;
                rect.y += (goal.y - shown.y) * k;
            }
            rects.set(id, rect);
        }
        return rects;
    }

    // ノードを図の領域に入れる。閉じた枝の中なら祖先を開き (onFoldChange は byUser false)、動き終えたあとの位置が
    // 図の領域の辺から margin (画面の px) を残して収まるよう、いちばん短い距離だけパンする。倍率は変えない。収まっていれば動かさない
    ensureVisible(id: number, margin = VISIBLE_MARGIN): void {
        if (!this.hasNode(id)) return;
        if (this.unfoldAncestors(id)) this.commitFold(false, this.options.animate);
        const rect = this.nodeRects([id], { settled: true }).get(id);
        if (!rect) return;
        const keep = Number.isFinite(margin) ? margin : VISIBLE_MARGIN;
        const { width, height } = this.viewport.getBoundingClientRect();
        const dx = shiftInto(rect.x, rect.width, width, keep);
        const dy = shiftInto(rect.y, rect.height, height, keep);
        if (dx !== 0 || dy !== 0) this.panBy(dx, dy);
    }

    // 要素を重ね置きの層に入れ、描画の毎コマ、パンとズーム、図の領域と要素の大きさの変化のたびに anchor の位置へ置く。
    // 相手が見えないか、なくなったら element.hidden を true にし、戻ったら外す。戻り値の関数で外す (何度呼んでもよい)。
    // 外すと、view が書いた style (位置、label と cover の幅と高さ) を元に戻す。同じ要素をもう一度渡すと、前の置き方を外して置き直す
    attachOverlay(element: HTMLElement, anchor: OverlayAnchor): () => void {
        const existing = this.overlays.find((entry) => entry.element === element);
        if (existing) this.detachOverlay(existing);
        const entry: OverlayEntry = {
            element,
            anchor,
            hiddenByView: false,
            sized: false,
            saved: { width: element.style.width, height: element.style.height, transform: element.style.transform },
        };
        this.overlays = [...this.overlays, entry];
        this.ensureOverlayLayer().append(element);
        this.overlayObserver.observe(element);
        this.placeOverlays([entry]);
        return () => this.detachOverlay(entry);
    }

    // 重ね置きの層。図の要素の直下、図の領域のすぐ上に置く。押下は中の要素だけが受ける (見た目はスタイルシート)
    private ensureOverlayLayer(): HTMLDivElement {
        if (this.overlayLayer) return this.overlayLayer;
        const layer = document.createElement('div');
        layer.className = 'mdag-overlays';
        // 図の領域と同じく、中の入力欄へフォーカスが移ってもスクロールされたままにしない
        layer.addEventListener('scroll', () => layer.scrollTo(0, 0));
        this.viewport.after(layer);
        this.overlayObserver.observe(layer);
        this.overlayLayer = layer;
        return layer;
    }

    private detachOverlay(entry: OverlayEntry): void {
        if (!this.overlays.includes(entry)) return;
        this.overlays = this.overlays.filter((item) => item !== entry);
        const { element, saved } = entry;
        this.overlayObserver.unobserve(element);
        if (element.parentElement === this.overlayLayer) element.remove();
        element.style.width = saved.width;
        element.style.height = saved.height;
        element.style.transform = saved.transform;
        if (entry.hiddenByView) element.hidden = false;
    }

    // 重ねた要素を今の相手の位置へ置く。相手の矩形は描いてある要素から読むので、描画とパンとズームのあとに呼ぶ
    private placeOverlays(entries: readonly OverlayEntry[] = this.overlays): void {
        if (entries.length === 0) return;
        const context: OverlayContext = { origin: this.viewport.getBoundingClientRect(), visible: this.visibleIds(), k: zoomTransform(this.viewport).k };
        for (const entry of entries) this.placeOverlay(entry, context);
    }

    private placeOverlay(entry: OverlayEntry, context: OverlayContext): void {
        const { element, anchor } = entry;
        const subject = this.overlaySubjectOf(anchor.target, context);
        if (!subject) {
            if (!element.hidden) {
                element.hidden = true;
                entry.hiddenByView = true;
            }
            return;
        }
        if (entry.hiddenByView) {
            element.hidden = false;
            entry.hiddenByView = false;
        }
        const places = (Array.isArray(anchor.place) ? anchor.place : [anchor.place]).map((place) => (place === 'label' && subject.label === null ? subject.labelAs : place));
        // 要素の大きさで置く候補があれば、view が入れた幅と高さを外してから測る
        if (entry.sized && places.some((place) => place !== 'label' && place !== 'cover')) {
            element.style.width = entry.saved.width;
            element.style.height = entry.saved.height;
            entry.sized = false;
        }
        const own = { width: element.offsetWidth, height: element.offsetHeight };
        const span = anchor.within?.() ?? null;
        const spots = places.map((place) => {
            const spot = overlaySpot(place, subject, own, anchor.gap ?? OVERLAY_GAP);
            if (span === null || (spot.place !== 'top' && spot.place !== 'bottom')) return { ...spot, shifted: false };
            return { ...spot, x: placeInSpan(spot.x, spot.width, span), shifted: true };
        });
        const { width, height } = context.origin;
        // 左右にずらした置き場は、左右をもう範囲に収めてある (範囲より広いものは右にそろえてある) ので、上下だけで選ぶ
        const fits = (item: (typeof spots)[number]): boolean =>
            item.y >= 0 && item.y + item.height <= height && (item.shifted || (item.x >= 0 && item.x + item.width <= width));
        const spot = spots.find(fits) ?? spots[0];
        if (!spot) return;
        const at = `translate(${spot.x}px, ${spot.y}px)`;
        if (spot.place === 'label' || spot.place === 'cover') {
            // label は図の座標の大きさを入れて図の倍率で拡大し、cover は画面の大きさをそのまま入れる
            const scale = spot.place === 'label' ? context.k : 1;
            element.style.width = `${spot.width / scale}px`;
            element.style.height = `${spot.height / scale}px`;
            element.style.transform = spot.place === 'label' ? `${at} scale(${scale})` : at;
            entry.sized = true;
        } else {
            element.style.transform = at;
        }
    }

    // 重ねる相手の画面の矩形。相手が見えない (閉じた枝の中、文書にない、知らない id) ときは null。
    // nodes は見えているものだけを囲む。group は frame 番目の枠 (なければ描いた順で最初の枠。label は枠のラベルの文字とロゴ)、枠がなければ見えているメンバーの箱を囲む
    private overlaySubjectOf(target: OverlayTarget, context: OverlayContext): OverlaySubject | null {
        const { origin, visible } = context;
        const boxRect = (id: number): Rect | null => {
            const box = visible.has(id) ? this.boxes.get(id) : undefined;
            return box ? rectWithin(box, origin) : null;
        };
        if ('node' in target) {
            const rect = boxRect(target.node);
            if (!rect) return null;
            const content = this.boxes.get(target.node)?.querySelector(':scope > .mdag-content');
            return { rect, label: content ? rectWithin(content, origin) : rect, labelAs: 'cover' };
        }
        if ('nodes' in target) {
            const rects = target.nodes.flatMap((id) => boxRect(id) ?? []);
            return rects.length > 0 ? { rect: boundsOf(rects), label: null, labelAs: 'cover' } : null;
        }
        const model = this.model;
        if (!model?.groups.some((group) => group.id === target.group)) return null;
        const frames = this.drawnFrames.filter((item) => item.id === target.group);
        const frame = frames[target.frame ?? 0] ?? frames[0];
        if (frame) return { rect: rectWithin(frame.outline, origin), label: boundsOf(frame.label.map((part) => rectWithin(part, origin))), labelAs: 'top' };
        const members = [...model.groupsOf].flatMap(([id, groups]) => (groups.includes(target.group) ? (boxRect(id) ?? []) : []));
        return members.length > 0 ? { rect: boundsOf(members), label: null, labelAs: 'top' } : null;
    }

    private hasNode(id: number): boolean {
        return Number.isInteger(id) && this.nodes[id - 1]?.id === id;
    }

    // 閉じた枝の中でないか (祖先がどれも閉じていない)
    private isShown(id: number): boolean {
        if (!this.hasNode(id)) return false;
        for (let parent = this.nodes[id - 1]?.parent ?? null; parent !== null; parent = this.nodes[parent - 1]?.parent ?? null) {
            if (this.folded.has(parent)) return false;
        }
        return true;
    }

    // 描く枠の矩形。見えているメンバーが 1 つだけの枠も描き、見えているメンバーがなければ描かない (null)
    private outlineOf(frame: Frame, rects: Map<number, Rect>): Rect | null {
        const outline = frameOutline(frame, rects);
        const shift = this.frameShifts.get(frame);
        if (!outline || !shift) return outline;
        return { ...outline, x: outline.x + shift.left, width: outline.width - shift.left + shift.right };
    }

    // core の outline と、同じ矩形から作った frameOutline の左右の辺の差。差のない枠は持たない
    private static shiftsOf(frames: Array<Frame & { outline: Rect | null }>, rects: Map<number, Rect>): Map<Frame, { left: number; right: number }> {
        const shifts = new Map<Frame, { left: number; right: number }>();
        for (const frame of frames) {
            const base = frameOutline(frame, rects);
            if (!frame.outline || !base) continue;
            const left = frame.outline.x - base.x;
            const right = frame.outline.x + frame.outline.width - (base.x + base.width);
            if (Math.abs(left) > 1e-6 || Math.abs(right) > 1e-6) shifts.set(frame, { left, right });
        }
        return shifts;
    }

    private withGap(id: number, rect: Rect): Rect {
        const gap = this.gaps.get(id) ?? 0;
        return { ...rect, x: rect.x - gap, width: rect.width + gap };
    }

    // 文書が指定した枝の起点 (markdag.branches の順) ごとの線の色と名前。図の凡例の線の色の段もこれを出す。
    // 凡例に枝を出すかの指定 (legend.display) と ViewOptions.legend によらず、描いている枝の色を全部返す
    branchColors(): BranchColor[] {
        return (this.model?.branches ?? []).map((id) => ({
            id,
            label: this.nodes[id - 1]?.refText || `#${id}`,
            color: this.colorOf.get(id) ?? NO_BRANCH_COLOR,
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
        const branches = model.legend.includes('branches') ? this.branchColors() : [];
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
            item.append(chip);
            const logo = legendLogoHtml(group, this.iconContext());
            if (logo !== null) item.insertAdjacentHTML('beforeend', logo);
            item.append(`${group.label}${group.boundary ? ' (枠あり)' : ''}${group.defined ? '' : ' (定義なし)'}`);
            list.append(item);
        }
        if (list.childElementCount > 0) this.legend.append(list);
    }

    // 文書が枝の起点を指定していれば、起点ごとに色を割り当てて配下に引き継ぐ (起点の中の起点は、そこから別の色になる)。
    // 指定がなければ、ノードごとに出てきた順で色を割り当てる
    private assignColors(): void {
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
        this.nodes.forEach((node, index) => this.colorOf.set(node.id, BRANCH_COLORS[index % BRANCH_COLORS.length] ?? '#888'));
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
        if (node.task) {
            element.dataset.task = node.task.state;
            // 順にない状態はクリックで変わらないので、押せる見た目にしない
            if (!this.taskCycle().includes(taskMarkOf(node.task.state))) element.dataset.taskFixed = '';
            if (this.isDimmed(node)) element.dataset.dimmed = '';
        }
        this.applyNodeModes(node, element);
        // 閉じた枝の中にいる間に選ばれていたノードは、見えるようになって要素を作るときに印を付ける
        if (this.selection.has(node.id)) element.toggleAttribute('data-selected', true);
        const outer = document.createElement('div');
        outer.className = 'mdag-outer';
        const box = document.createElement('div');
        box.className = 'mdag-box';
        box.addEventListener('pointerdown', (event) => this.hooks.onNodePointerDown?.(node, event), { capture: true });

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
        content.innerHTML = withIconMarks(node.html, this.iconContext());
        if (node.task) wrapTaskLabel(content);
        wrapEmoji(content);
        // ノードの中の操作が、パンやダブルクリックでのズームにならないようにする
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick']) content.addEventListener(type, this.shieldContent);
        // チェックボックスは、箱だけでなく文字をクリックしても切り替わるようにする
        content.addEventListener('click', (event) => this.handleTextClick(node, content, event));
        content.addEventListener('dblclick', (event) => {
            const onDetails = event.target instanceof Element && event.target.closest('.mdag-details') !== null;
            this.hooks.onNodeDoubleClick?.(node, onDetails ? 'details' : 'label', event);
        });
        // 詳細の引用ブロックは、内容の中の書かれた位置にある。開いて表示する場合はその場に出て、ノードの大きさに含まれるので、
        // 配置もそのぶん広がる。タスクのノードでは、詳細の文のクリックも内容のクリックとして、タスクの切り替えになる
        box.append(content);
        // 色のないグループは、文字のラベルで常に見せる
        const plain = defs.filter((group) => group.color === null).map((group) => `%${group.label}`);
        if (plain.length > 0) {
            const groupLabels = document.createElement('span');
            groupLabels.className = 'mdag-labels';
            groupLabels.textContent = plain.join(' ');
            wrapEmoji(groupLabels);
            box.append(groupLabels);
        }
        // タグは本文に書いたとおりに見せる。always ならノードの中、hover と click なら詳細と同じ吹き出しの中 (どちらに出すかは CSS が決める)
        const tags = model?.tagsOf.get(node.id) ?? [];
        if (tags.length > 0) {
            element.dataset.hasTags = '';
            const tagLabels = document.createElement('span');
            tagLabels.className = 'mdag-tags';
            this.fillTags(tagLabels, node.id);
            this.listenTagClicks(tagLabels, () => node, 'node');
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
                else if (this.hasPopoverBody(node)) this.showPopover(node, true);
            });
            box.append(mark);
            box.addEventListener('pointerenter', () => {
                if (this.popoverPinned || this.popoverTriggerOf(node) !== 'hover' || !this.hasPopoverBody(node)) return;
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

    // ノードの文字の上の押下とダブルクリックを、図の領域 (パンとズーム) へ伝えない。
    // ただし、中ボタンでパンする設定では、文字の上からの中ボタンのドラッグもパンにするので、中ボタンの mousedown は通す
    private readonly shieldContent = (event: Event): void => {
        if (event.type === 'mousedown' && (event as MouseEvent).button === 1 && this.dragToPanAllows('middle')) return;
        event.stopPropagation();
    };

    // ロゴの SVG を入れる (null は引けなかった)。入れたものが変わったら、その ref を使うノードだけロゴを描き直す。
    // 文書を差し替えても置き場は残る (同じ ref をもう一度解決しなくてよい)
    setIconSvg(ref: string, svg: string | null): void {
        if (!this.iconSvgs.set(ref, svg)) return;
        this.redrawLogos(ref);
        // 図の外でロゴを出す側 (凡例のパネルなど) が、描き直したあとの置き場から引き直せるように知らせる
        this.hooks.onIconSvg?.(ref);
    }

    // グループの icon のロゴの要素を、呼ぶたびに新しく作って返す (図の外の凡例のパネル向け。引けたロゴと絵文字は図の凡例の行と同じもの)。
    // SVG がまだ届いていなければ中身のない置き場の要素で、届いたら onIconSvg で知らせる (呼び直すとロゴが入る)。
    // 表にない alias と引けなかった SVG は書いたとおりの文字。icon のないグループと知らない id は null
    groupLogo(id: string): Element | null {
        const group = this.model?.groups.find((item) => item.id === id);
        const html = group ? groupLogoHtml(group, this.iconContext()) : null;
        if (html === null) return null;
        const holder = document.createElement('span');
        holder.innerHTML = html;
        const logo = holder.firstElementChild;
        logo?.remove();
        return logo;
    }

    // その ref のロゴを使う所 (ノード、開いている吹き出し、枠、凡例) を、今の置き場の中身で描き直す
    private redrawLogos(ref: string): void {
        const context = this.iconContext();
        if (!context || !this.model) return;
        for (const [id, element] of this.elements) {
            const node = this.nodes[id - 1];
            if (!node || !nodeIconRefs(node, this.model.tagsOf.get(id) ?? [], this.model).has(ref)) continue;
            this.redrawIconMarks(element.querySelectorAll<HTMLElement>('.mdag-content .mdag-icon[data-icon]'), context);
            const tagLabels = element.querySelector<HTMLElement>('.mdag-tags');
            if (tagLabels) this.fillTags(tagLabels, id);
        }
        // 開いている吹き出しも、同じくその場で差し替える (作り直すと beforeDetailsShow / onDetailsShow がもう一度呼ばれるため)。
        // node.html は詳細の引用ブロックも含むので、nodeIconRefs で詳細の ref も拾える
        const shown = this.popoverNode;
        if (shown && !this.popover.hidden && nodeIconRefs(shown, this.model.tagsOf.get(shown.id) ?? [], this.model).has(ref)) {
            const marks = [...this.popover.querySelectorAll<HTMLElement>('.mdag-details .mdag-icon[data-icon]')].filter((mark) => !mark.closest('.mdag-popover-tags'));
            this.redrawIconMarks(marks, context);
            const line = this.popover.querySelector<HTMLElement>('.mdag-popover-tags');
            if (line) this.fillTags(line, shown.id);
            // ロゴが入ると吹き出しの大きさが変わるので置き直す。下に入りきらなくなると開いたまま上へ跳ぶが、それでよいとしている
            this.positionPopover();
        }
        // 枠と凡例は、そのロゴを使うグループがあるときだけ作り直す。枠は今表示している位置で描き直す
        if (groupIconRefs(this.model).has(ref)) {
            this.syncLegend();
            this.drawFrames(this.displayed);
            // 枠のラベルの幅がロゴのぶん変わるので、枠のラベルに重ねた要素を置き直す
            this.placeOverlays();
        }
        this.scheduleUpdate();
    }

    // 本文の印 (と、前に描いたロゴ) を、今の置き場の中身で描き直す
    private redrawIconMarks(marks: Iterable<HTMLElement>, context: IconRenderContext): void {
        for (const mark of marks) mark.outerHTML = iconMarkHtml(mark.dataset.icon ?? '', context);
    }

    // ロゴを引く文脈。markdag.icons も、ロゴの対応のあるタグのキーも、icon を書いたグループもない文書では null (今までどおり文字だけで描く)
    private iconContext(): IconRenderContext | null {
        const model = this.model;
        if (!model) return null;
        const used = model.icons.aliases.size > 0 || model.tagKeys.some((def) => def.icon !== undefined || def.icons !== undefined) || model.groups.some((group) => group.icon !== undefined);
        if (!used) return null;
        return { icons: model.icons, svgOf: (ref) => this.iconSvgs.get(ref) };
    }

    // タグは書いたとおりの文字で見せ、引けたロゴがあればその前に置く。ロゴがなければ文字だけ (textContent)。
    // ノードの中のタグと、吹き出しのタグの行の両方に使う。GUI 編集 (interaction が edit) では、押したタグが分かるよう
    // タグごとの要素 (.mdag-tag[data-tag-key]) に分ける。並び、間の空白 1 つ、文字とロゴは分けないときと同じ
    private fillTags(tagLabels: HTMLElement, id: number): void {
        const tags = this.model?.tagsOf.get(id) ?? [];
        const tagKeys = this.model?.tagKeys ?? [];
        if (this.options.interaction === 'edit') {
            const elements = tagParts(tags, tagKeys, this.iconContext()).map(({ key, html }) => {
                const tag = document.createElement('span');
                tag.className = 'mdag-tag';
                tag.dataset.tagKey = key;
                tag.innerHTML = html;
                return tag;
            });
            tagLabels.replaceChildren(...elements.flatMap((tag, index) => (index === 0 ? [tag] : [' ', tag])));
        } else {
            const content = tagLineContent(tags, tagKeys, this.iconContext());
            if ('html' in content) tagLabels.innerHTML = content.html;
            else tagLabels.textContent = content.text;
        }
        wrapEmoji(tagLabels);
    }

    // 描いてあるタグ (ノードの中と、開いている吹き出しの中) を、今の interaction の分け方で作り直す
    private refillTags(): void {
        for (const [id, box] of this.boxes) {
            const line = box.querySelector<HTMLElement>(':scope > .mdag-tags');
            if (line) this.fillTags(line, id);
        }
        const shown = this.popoverNode;
        const line = shown && !this.popover.hidden ? this.popover.querySelector<HTMLElement>('.mdag-popover-tags') : null;
        if (shown && line) this.fillTags(line, shown.id);
    }

    // タグの要素のクリックを onTagClick で知らせる (タグが要素に分かれるのは GUI 編集のときだけ)。
    // area はノードの中のタグの行か吹き出しで、相手のノードはクリックの時点で引く。押した所から 4px より動いて離したものはクリックにしない
    private listenTagClicks(area: HTMLElement, nodeOf: () => OutlineNode | null, place: 'node' | 'popover'): void {
        let press: { x: number; y: number } | null = null;
        area.addEventListener('pointerdown', (event) => (press = { x: event.clientX, y: event.clientY }));
        area.addEventListener('click', (event) => {
            const moved = movedFrom(press, event);
            press = null;
            const tag = event.target instanceof Element ? event.target.closest<HTMLElement>('.mdag-tag') : null;
            const node = nodeOf();
            if (moved || !node || this.options.interaction !== 'edit' || !tag || !area.contains(tag)) return;
            if (!tag.parentElement?.matches('.mdag-tags, .mdag-popover-tags')) return;
            this.hooks.onTagClick?.(node, tag.dataset.tagKey ?? '', place, event);
        });
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
    // タスクは切り替えない。タスクでないノードでは、HTML で直接書いたチェックボックスを切り替える。
    // GUI 編集では、タスクを切り替えるのは先頭の状態の絵のクリックだけ (文字と詳細のクリックは編集の操作に使う)
    private handleTextClick(node: OutlineNode, area: HTMLElement, event: MouseEvent): void {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest(INTERACTIVE) || (window.getSelection()?.toString() ?? '') !== '') return;
        const zone = node.task ? findNestedZone(area, target) : area;
        const toggles = zone === null && (this.options.interaction !== 'edit' || onTaskIcon(area, target));
        this.hooks.onNodeClick?.(node, toggles);
        if (toggles) this.hooks.onToggleTask?.(node, this.taskCycle());
        else if (zone !== null) findLoneCheckbox(zone, target)?.click();
    }

    private detailsMode(): DisplayMode {
        return this.options.details === 'auto' ? (this.model?.detailsMode ?? 'hover') : this.options.details;
    }

    private tagMode(): TagDisplayMode {
        return this.model?.tagDisplay ?? 'always';
    }

    private taskCycle(): readonly TaskMark[] {
        return this.model?.taskCycle ?? DEFAULT_TASK_CYCLE;
    }

    // 薄く表示するノードか (文書の markdag.tasks.dim.states にある状態のタスク)
    private isDimmed(node: OutlineNode): boolean {
        return node.task !== null && (this.model?.taskDim.states ?? []).includes(node.task.state);
    }

    // そのノードでの詳細の見せ方。薄く表示するノードでは、文書の markdag.tasks.dim.details が keep でなければそちらに従う
    private detailsModeOf(node: OutlineNode): NodeDetailsMode {
        const override = this.isDimmed(node) ? (this.model?.taskDim.details ?? 'keep') : 'keep';
        return override === 'keep' ? this.detailsMode() : override;
    }

    // そのノードでのタグの見せ方。文書が never なら薄いノードでも出さない (文書が隠したものは出さない)
    private tagModeOf(node: OutlineNode): TagDisplayMode {
        const base = this.tagMode();
        const override = this.isDimmed(node) ? (this.model?.taskDim.tags ?? 'keep') : 'keep';
        return base === 'never' || override === 'keep' ? base : override;
    }

    // 吹き出しを出すきっかけ。詳細とタグのどちらかが hover なら、ノードに重ねただけで出す
    private popoverTriggerOf(node: OutlineNode): 'hover' | 'click' {
        return this.detailsModeOf(node) === 'hover' || this.tagModeOf(node) === 'hover' ? 'hover' : 'click';
    }

    // 吹き出しに入れる詳細があるか (ノードの中に開くのでも、出さないのでもないとき)
    private detailsInPopover(node: OutlineNode): boolean {
        const mode = this.detailsModeOf(node);
        return node.details !== null && (mode === 'hover' || mode === 'click');
    }

    // ノードの中に出すのではなく吹き出しに入れるタグがあるか (印を出すかの判断にも使う)
    private tagsInPopover(node: OutlineNode): boolean {
        const mode = this.tagModeOf(node);
        return (mode === 'hover' || mode === 'click') && this.detailsModeOf(node) !== 'always' && (this.model?.tagsOf.get(node.id)?.length ?? 0) > 0;
    }

    private hasPopoverBody(node: OutlineNode): boolean {
        return this.detailsInPopover(node) || this.tagsInPopover(node);
    }

    // 見せ方は CSS で切り替える。always ではノードの中の詳細を表示し、印と吹き出しは使わない。タグも同じ仕組みで出し分ける。
    // 図の根の属性は文書の指定で、ノードの属性はそのノードでの実効の値 (薄いノードでは文書の指定と違うことがある)
    private applyDetailsMode(): void {
        this.root.dataset.details = this.detailsMode();
        this.root.dataset.tags = this.tagMode();
        for (const [id, element] of this.elements) {
            const node = this.nodes[id - 1];
            if (node) this.applyNodeModes(node, element);
        }
        if (this.popoverNode && !this.hasPopoverBody(this.popoverNode)) this.hidePopover();
    }

    private applyNodeModes(node: OutlineNode, element: HTMLElement): void {
        element.dataset.details = this.detailsModeOf(node);
        element.dataset.tags = this.tagModeOf(node);
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
        // 詳細の :alias: とタグの行のロゴは、ノードの中と同じ描き方で、ここで入れる (引けないものは文字のまま)
        body.innerHTML = this.detailsInPopover(node) ? withIconMarks(node.details ?? '', this.iconContext()) : '';
        if (this.tagsInPopover(node)) {
            const line = document.createElement('p');
            line.className = 'mdag-popover-tags';
            this.fillTags(line, node.id);
            body.append(line);
        }
        this.popover.replaceChildren(body);
        // どのノードの吹き出しかを要素にも示す (見た目と操作は変えない)
        this.popover.dataset.id = String(node.id);
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
        this.popover.removeAttribute('data-id');
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
        const override = this.options.layoutOverride;
        let graph: VisibleGraph;
        if (override === null) {
            // 射影、枠のまとまり、枠の配置は Rust が 1 回の呼び出しで行う。まとまりにできる枠は箱として 1 回で置く。
            // まとまりにできない枠があるときだけ、前回の張り出しのぶんだけ間隔を空けて上限の回数まで配置し直し、入り込みの一番少ない回を採る
            const result = layoutDocument(input, model, { ignoreProxiedDepends: this.options.ignoreProxiedDepends });
            graph = result.graph;
            this.frames = result.frames;
            this.frameShifts = MarkdagView.shiftsOf(result.frames, result.rects);
            this.targets = result.rects;
            this.gaps = result.gaps;
            this.edges = result.edges;
        } else {
            graph = project(input);
            const result = override(graph);
            this.targets = result.rects;
            this.gaps = new Map();
            this.edges = result.edges;
            // この方式は兄弟の並びを配置の結果で決めるので、枠のまとまりも結果から作る (枠の余白は間隔に反映されない)。
            // 並びは射影の結果が要るので、射影と枠の呼び出しを分ける (射影は 2 回行う)
            const siblings = new Map<number, number[]>();
            for (const [child, parent] of graph.layoutParent) siblings.set(parent, [...(siblings.get(parent) ?? []), child]);
            for (const list of siblings.values()) list.sort((a, b) => (result.rects.get(a)?.y ?? 0) - (result.rects.get(b)?.y ?? 0));
            this.frames = projectAndFrames(input, model, siblings).frames;
            this.frameShifts = new Map();
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
        const pressable = this.edgesPressable();
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
                this.edgeLayer.append(...layers);
            }
            // 線を押す帯は線のすぐ後ろに置く。押せるかは文書の指定と interaction で決まり、interaction を切り替えたら足すか外す
            const hit = this.edgeLayer.querySelector<SVGPathElement>(`path.mdag-edge-hit[data-key="${key}"]`);
            if (pressable && !hit) path.after(this.createEdgeHit(key, placed));
            else if (!pressable && hit) {
                hit.remove();
                if (this.hoveredEdge === key) this.hoveredEdge = null;
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
        // 図をドラッグして動かしたときに、離した場所の線を選んでしまわないようにする。GUI 編集では選択を変えず、押したことだけを知らせる
        let down: { x: number; y: number } | null = null;
        hit.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
        hit.addEventListener('click', (event) => {
            const moved = movedFrom(down, event);
            down = null;
            if (moved) return;
            if (this.options.interaction !== 'edit') this.applySelectEdge(this.selectedEdge === key ? null : key, true);
            const current = this.find(key);
            if (current) this.hooks.onEdgeClick?.(current, event);
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
        if (key !== null) {
            this.selectedGroup = null;
            this.alsoSelectedGroups = [];
        }
        this.applyHighlight();
        this.hooks.onSelectEdge?.(edge, byUser);
        if (clearedGroup) this.hooks.onSelectGroup?.(null, byUser);
    }

    private find(key: string | null): PlacedEdge | undefined {
        return key === null ? undefined : this.edges.find((placed) => this.edgeKey(placed) === key);
    }

    // 今の文書でそのグループに属するノードがあるか
    private hasGroupMembers(id: string): boolean {
        for (const ids of this.model?.groupsOf.values() ?? []) if (ids.includes(id)) return true;
        return false;
    }

    // どれかのグループに属するノードと、そこに出入りする線、その線の反対側のノードに印を付ける。
    // どのグループにも属するノードがないときは、何も印を付けずに false を返す
    private markGroups(groups: readonly string[]): boolean {
        const members = new Set<number>();
        for (const [nodeId, ids] of this.model?.groupsOf ?? []) if (ids.some((id) => groups.includes(id))) members.add(nodeId);
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

    // 複数のグループをまとめて強調する (選んだどれかのグループにつながるものを残す)。先頭を代表 (selectGroup の選択) にし、
    // 受け口 (beforeSelectGroup、onSelectGroup) は代表が変わるときだけ代表の id で呼ぶ。[] は selectGroup(null)、1 つは selectGroup(id) と同じ
    selectGroups(ids: readonly string[]): void {
        this.applySelectGroups(ids, false);
    }

    private applySelectGroup(id: string | null, byUser: boolean): void {
        this.applySelectGroups(id === null ? [] : [id], byUser);
    }

    private applySelectGroups(ids: readonly string[], byUser: boolean): void {
        const [id = null, ...rest] = [...new Set(ids)];
        const sameRest = rest.length === this.alsoSelectedGroups.length && rest.every((item, index) => item === this.alsoSelectedGroups[index]);
        if (id === this.selectedGroup) {
            if (sameRest) return;
            this.alsoSelectedGroups = rest;
            this.applyHighlight();
            return;
        }
        if (this.hooks.beforeSelectGroup?.(id, byUser) === false) return;
        this.selectedGroup = id;
        this.alsoSelectedGroups = rest;
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
        // (代表のグループがなくなったら一緒に強調していたものも解き、残りのうちなくなったものは落とす)
        if (this.selectedGroup !== null && !this.hasGroupMembers(this.selectedGroup)) {
            this.selectedGroup = null;
            this.alsoSelectedGroups = [];
        }
        this.alsoSelectedGroups = this.alsoSelectedGroups.filter((id) => this.hasGroupMembers(id));
        if (this.selectedGroup !== null) this.markGroups(this.selectedGroupIds());
        // 選んでいるときはその線、選んでいないときは重ねている線を、つながりの起点にする。
        // 重ねているだけのときはほかを薄くせず、太さだけを付けるので、押したときの形が先に見える
        const anchor = picked ?? (this.selectedEdge === null && this.selectedGroup === null ? this.find(this.hoveredEdge) : undefined);
        const anchorKey = picked ? this.selectedEdge : this.hoveredEdge;
        // 薄くするのは、線かグループを選んでいるときだけ。重ねているだけでほかを薄くすると、動かすたびに図が明滅する
        const dim = picked !== undefined || this.selectedGroup !== null;
        // 線を選んでいる間は図の要素にも示す。code の地をより透かして、強調した線を地の下でもたどれるようにするため (CSS が見る)。
        // グループを選んだときは線を強調せず薄くするだけなので含めない
        this.root.toggleAttribute('data-edge-selected', picked !== undefined);
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

    // 代表と一緒に強調しているグループ (代表が先頭。選んでいなければ空)
    private selectedGroupIds(): string[] {
        return this.selectedGroup === null ? [] : [this.selectedGroup, ...this.alsoSelectedGroups];
    }

    // 選んだグループ以外の枠を薄くする。枠は描き直しのたびに作り直すので、選択が変わったときにも付け直す。
    // 選んだグループに内包されている (メンバーがすべて選んだグループのどれかにも属している) 枠は、中身と一緒に残す
    private applyFrameHighlight(): void {
        const selected = this.selectedGroupIds();
        const nested = (id: string): boolean => {
            let members = 0;
            for (const ids of this.model?.groupsOf.values() ?? []) {
                if (!ids.includes(id)) continue;
                if (selected.length > 0 && !ids.some((group) => selected.includes(group))) return false;
                members++;
            }
            return members > 0;
        };
        for (const element of this.frameLayer.querySelectorAll<SVGElement>('[data-group]')) {
            const id = element.dataset.group ?? '';
            element.style.opacity = selected.length === 0 || selected.includes(id) || nested(id) ? '' : '0.35';
        }
    }

    // 押した枠の要素 (枠か、枠のラベルの文字かロゴ) が、描いた順でそのグループの何番目の枠か。描いた枠の控えにない要素は 0
    private frameIndexOf(element: Element): number {
        const at = this.drawnFrames.findIndex((frame) => frame.outline === element || frame.label.some((part) => part === element));
        const pressed = this.drawnFrames[at];
        if (!pressed) return 0;
        return this.drawnFrames.slice(0, at).filter((frame) => frame.id === pressed.id).length;
    }

    // ノードの側の見た目。下線と開閉の円は、線と 1 本につながって見えるので、線と同じ太さと濃さにする。
    // カーソルを重ねている線でも同じで、その両端の下線と円を太くする
    private applyNodeHighlight(): void {
        const dim = this.selectedEdge !== null || this.selectedGroup !== null;
        const hovered = this.thicken ? this.find(this.hoveredEdge) : undefined;
        const touched = new Set(hovered ? [hovered.edge.source, hovered.edge.target] : []);
        // 強調から外れたノードは data-faded でも示す。薄く表示のノードの色と部品の薄さを、この opacity と重ねないため (CSS が見る)
        for (const [id, element] of this.elements) {
            const faded = dim && !this.nodeLevels.has(id);
            element.style.opacity = faded ? '0.35' : '';
            element.toggleAttribute('data-faded', faded);
        }
        const bold = (id: number): boolean => this.thicken && (this.nodeLevels.has(id) || touched.has(id));
        // 薄く表示するタスクの下線と円は、強調から外れたときと同じ濃さにする
        const shade = (id: number): string => {
            const node = this.nodes[id - 1];
            if (!dim) return node && this.isDimmed(node) ? '0.3' : '';
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
        this.drawFrames(rects);
        // 重ねた要素は、このコマで描いたノードと枠の位置に合わせる (1 コマ遅れない)
        this.placeOverlays();
    }

    // 枠の層 (区切りの帯と、グループの枠とラベル) を描き直す。配置のたびと、枠のロゴの SVG が入ったときに呼ぶ
    private drawFrames(rects: Map<number, Rect>): void {
        this.frameLayer.innerHTML = '';
        this.drawnFrames = [];
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
        const clickable = this.framesPressable();
        const iconContext = this.iconContext();
        for (const frame of this.frames) {
            const outline = this.outlineOf(frame, rects);
            if (!outline) continue;
            const shape = svgElement('rect', 'mdag-frame');
            shape.setAttribute('x', String(outline.x));
            shape.setAttribute('y', String(outline.y));
            shape.setAttribute('width', String(outline.width));
            shape.setAttribute('height', String(outline.height));
            shape.setAttribute('rx', '6');
            const color = frame.group.color ?? '#888';
            shape.style.stroke = color;
            shape.style.fill = color;
            const parts = frameLabelParts(frame.group, outline.x + FRAME_LABEL_INSET, outline.y - 4, color, iconContext);
            const label = svgElement('text', 'mdag-frame-label');
            label.setAttribute('x', String(parts.textX));
            label.setAttribute('y', String(outline.y - 4));
            label.style.fill = color;
            label.textContent = frame.group.label;
            const elements: SVGElement[] = [shape, label];
            if (parts.logo) {
                const logo = svgElement('svg', 'mdag-frame-icon');
                for (const [name, value] of Object.entries({ x: parts.logo.x, y: parts.logo.y, width: parts.logo.size, height: parts.logo.size })) logo.setAttribute(name, String(value));
                logo.dataset.icon = parts.logo.alias;
                logo.dataset.iconColor = parts.logo.color;
                if (parts.logo.paint !== null) logo.style.color = parts.logo.paint;
                logo.innerHTML = parts.logo.svg;
                elements.push(logo);
            }
            if (parts.emoji) {
                const emoji = svgElement('text', 'mdag-frame-icon');
                emoji.setAttribute('x', String(parts.emoji.x));
                emoji.setAttribute('y', String(parts.emoji.y));
                emoji.dataset.icon = parts.emoji.alias;
                emoji.dataset.iconKind = 'emoji';
                emoji.textContent = parts.emoji.text;
                elements.push(emoji);
            }
            if (clickable) for (const element of elements) element.dataset.group = frame.group.id;
            this.frameLayer.append(...elements);
            this.drawnFrames.push({ id: frame.group.id, outline: shape, label: elements.slice(1) });
        }
        this.applyFrameHighlight();
    }
}

// 選んだノードのまわりに出す点とつまみ。1 つを選んでいるときはそのノードの選択の枠の右下の角に線を引く点 (link) を、2 つ以上のときは
// 選んだノードの全体の右に選択全体の点 (join) を 1 つだけ出す。1 つを選んでいるときは、呼ぶ側が求めたものだけ、子を足す + (child。ノードの右の縦の中央) と
// 兄弟を足す + (sibling。ノードの下) も出す。
// + と線を引く点は図の選択の枠 (図の倍率で太る) に合わせて置き、大きさはどの倍率でも画面の px のまま。図の倍率が変わるたびに setZoom で置き場を直す。
// + は丸の縁を選択の枠の線の外側から少し離し、線を引く点は丸の中心を枠の右下の角 (線の中ほど) に置く。縮小して出している + と
// 丸どうしが近づきすぎる倍率では、線を引く点を右下 45° へ必要な分だけずらす (呼ぶ側は点を出すとき、そのノードで出せる + を全部出す。
// + を隠す間は点も隠すので、出し直した点は前と同じ所に出る)。
// 子の +、兄弟の +、線を引く点は、絵のまわりへ広げた当たり判定を持つ (選択の枠の線の外側だけ。広げた所どうしが重なる所は絵に近いほう)。
// 範囲は自分の絵の大きさと、選んだノードの箱の画面の大きさと図の倍率から作り、つまみを出したとき、倍率と箱の大きさが変わったときに作り直す。
// 点とつまみは図の重ね置きの層に置き、相手の位置に合わせるのは図の側 (重ねる口) に任せる。角に置く口はないので、線を引く点は
// ノードの箱を覆う入れ物に入れて、その中で角に置く。
// 押されたことを知らせるだけで、ドラッグと書き換えと、出すかどうか (道具、モード、選んでいるもの、開いている入力、足せるか) は呼ぶ側が決める
import type { OverlayAnchor, OverlayPlacement, OverlayTarget } from '../../core';
import type { Point } from '../navigation';
import { SVG_NS } from './icons';

// ドラッグを始める点
export type DragHandleKind = 'link' | 'join';

// 押すとノードを足すつまみ
export type PlusHandleKind = 'child' | 'sibling';

type HandleKind = DragHandleKind | PlusHandleKind;

interface HandleListeners {
    // 点の主ボタンの押下 (ドラッグを始めるかは呼ぶ側が決める)
    onDragStart(kind: DragHandleKind, event: PointerEvent): void;
    // + の主ボタンのクリック
    onPlus(kind: PlusHandleKind): void;
}

// 選んだノードの箱の画面の大きさ (px)。見えていなければ null
type MeasureBox = (id: number) => { width: number; height: number } | null;

// 当たり判定を広げるつまみ
type HitKind = 'link' | PlusHandleKind;

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

// 角を丸めた矩形 (選択の枠の線の外側)
interface RoundBox extends Box {
    radius: number;
}

// 当たり判定の 1 つ分の長方形
interface HitRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

// 1 行の中の、同じつまみが取る区間
interface HitRun {
    kind: HitKind;
    left: number;
    right: number;
}

// 当たり判定の材料。drawing は絵の外接矩形、area はそれを広げた四角
interface HitSource {
    kind: HitKind;
    drawing: Box;
    area: Box;
}

// 重ねる順 (あとのものが上)
const KINDS: readonly HandleKind[] = ['child', 'sibling', 'link', 'join'];

const PLUS_KINDS: readonly PlusHandleKind[] = ['child', 'sibling'];

// 線を引く点はノードの箱を覆う入れ物ごと重ねる。+ の選択の枠からの離れは setZoom が付けるので、重ねる口の間は 0 にする
const PLACE: Record<HandleKind, OverlayPlacement> = { link: 'cover', join: 'right', child: 'right', sibling: 'bottom' };

// 相手の辺から点までの間 (画面の px)。選択全体の点は、複数の選択の外枠の破線の外に出す
const GAP: Record<HandleKind, number> = { link: 0, join: 12, child: 0, sibling: 0 };

const TITLE: Record<HandleKind, string> = {
    link: 'ドラッグしてほかのノードへ線を引く',
    join: 'ドラッグしてほかのノードへ合流させる',
    child: '子を足す (Tab)',
    sibling: '兄弟を足す',
};

// 図の選択の枠 (選んだノードの箱の outline) の線の内側と外側の、箱の辺からの距離と、線の外側の角の丸み (図の px。画面では図の倍率を掛ける)。
// 図の見た目の値 (選んだ箱の角の丸み 3、outline の離れ 3 と太さ 2) に合わせる
const SELECTION_FRAME = { inner: 3, outer: 5, radius: 8 };

// + の絵 (画面の px)。丸の直径と線の太さ、+ の印の腕の長さ (中心から) と線の太さ
const PLUS = { size: 19.2, ring: 2, arm: 3.5, stroke: 1.5 };
// + の丸の外側の半径
const PLUS_OUTER = PLUS.size / 2;
// + の丸の縁と、選択の枠の線の外側の間 (画面の px)
const PLUS_GAP = 1;

// 線を引く点の絵 (画面の px。丸の中心が原点)。丸は半径 6 の円を太さ 2.4 で描く。線は丸の縁の右下 45° から出て浅く下へ膨らみ、
// 水平に寄って右向きの塗りの三角 (矢尻) で終わる。線は 3 次のベジェ曲線 (始点、制御点 2 つ、終点)、矢尻は三角の頂点
const LINK = {
    radius: 6,
    ring: 2.4,
    tail: [
        [4.24, 4.24],
        [7, 8.8],
        [12.5, 10.5],
        [19.5, 10.5],
    ],
    tailWidth: 2,
    head: [
        [18.5, 13.9],
        [24.5, 10.5],
        [18.5, 7.1],
    ],
    headWidth: 1,
} as const;
// 線を引く点の丸の外側の半径
const LINK_OUTER = LINK.radius + LINK.ring / 2;
// 線を引く点の絵の範囲。丸の中心から左と上へ pad、全体の幅と高さ (矢尻と、乗せたときの拡大が収まる大きさ)
const LINK_VIEW = { pad: 12, width: 48, height: 44 };

// 当たり判定を広げる幅 (画面の px。絵の外接矩形のまわり)
const HIT_EXPAND = 6;
// 当たり判定を作る行の高さの上限 (画面の px)。選択の枠の角の丸みと、広げた四角どうしの分かれ目の傾きをこの細かさで追う
const HIT_ROW = 0.25;
// 行の継ぎ目に、位置の端数の丸めで隙間ができないよう、当たり判定の長方形を下へ重ねる量 (画面の px)
const HIT_SEAM = 0.05;
// 広げた四角が重なり、絵までの距離が同じ所を取る順 (上に重ねるものが先)
const HIT_ORDER: readonly HitKind[] = ['link', 'sibling', 'child'];

// 線を引く点の丸と、出している + の丸の間 (縁から縁。画面の px) の下限。縮小して狭くなる倍率では、点を右下 45° へずらして空ける
const LINK_CLEARANCE = 2;

const EPSILON = 1e-9;

const isPlus = (kind: HandleKind): kind is PlusHandleKind => kind === 'child' || kind === 'sibling';

// 図に重ねる口 (戻り値で外す)
type Attach = (element: HTMLElement, anchor: OverlayAnchor) => () => void;

const pointText = ([x, y]: readonly [number, number]): string => `${x} ${y}`;

// 点のまわり half の正方形
const around = ([x, y]: readonly [number, number], half: number): Box => ({ left: x - half, top: y - half, right: x + half, bottom: y + half });

const unionOf = (boxes: readonly Box[]): Box => ({
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
});

const grow = (box: Box, by: number): Box => ({ left: box.left - by, top: box.top - by, right: box.right + by, bottom: box.bottom + by });

const moveBox = (box: Box, by: Point): Box => ({ left: box.left + by.x, top: box.top + by.y, right: box.right + by.x, bottom: box.bottom + by.y });

// 線を引く点の絵の外接矩形 (丸の中心からの画面の px。線の太さの半分を含む)。曲線は制御点の凸包の中に収まるので、制御点で測る
const LINK_BOUNDS: Box = unionOf([
    around([0, 0], LINK_OUTER),
    ...LINK.tail.map((point) => around(point, LINK.tailWidth / 2)),
    ...LINK.head.map((point) => around(point, LINK.headWidth / 2)),
]);

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Readonly<Record<string, string | number>>): SVGElementTagNameMap[K] {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
}

// + の絵。丸と + の印を 1 つの絵に描き、印を丸のちょうど中心に置く (別々に置くと端数の丸めでずれる)
function plusDrawing(): SVGSVGElement {
    const svg = svgElement('svg', {
        class: 'mdag-editor-plus',
        width: PLUS.size,
        height: PLUS.size,
        viewBox: `${-PLUS_OUTER} ${-PLUS_OUTER} ${PLUS.size} ${PLUS.size}`,
        'aria-hidden': 'true',
        focusable: 'false',
    });
    svg.append(
        svgElement('circle', { class: 'mdag-editor-plus-ring', r: PLUS_OUTER - PLUS.ring / 2, 'stroke-width': PLUS.ring }),
        svgElement('path', { class: 'mdag-editor-plus-mark', d: `M0 ${-PLUS.arm}V${PLUS.arm}M${-PLUS.arm} 0H${PLUS.arm}`, 'stroke-width': PLUS.stroke }),
    );
    return svg;
}

// 線を引く点の絵。丸を線と矢尻の上に重ねて、線の始まりの継ぎ目を隠す。絵は丸の範囲の外へはみ出して描き、乗せたときは丸の中心を止めて拡大する
function linkDrawing(): SVGSVGElement {
    const { pad, width, height } = LINK_VIEW;
    const svg = svgElement('svg', {
        class: 'mdag-editor-link-mark',
        width,
        height,
        viewBox: `${-pad} ${-pad} ${width} ${height}`,
        'aria-hidden': 'true',
        focusable: 'false',
    });
    svg.style.left = svg.style.top = `${LINK_OUTER - pad}px`;
    svg.style.transformOrigin = `${pad}px ${pad}px`;
    const [from, first, second, to] = LINK.tail;
    const [base, tip, back] = LINK.head;
    svg.append(
        svgElement('path', { class: 'mdag-editor-link-tail', d: `M${pointText(from)}C${pointText(first)} ${pointText(second)} ${pointText(to)}`, 'stroke-width': LINK.tailWidth }),
        svgElement('path', { class: 'mdag-editor-link-head', d: `M${pointText(base)}L${pointText(tip)}L${pointText(back)}Z`, 'stroke-width': LINK.headWidth }),
        svgElement('circle', { class: 'mdag-editor-link-dot', r: LINK.radius, 'stroke-width': LINK.ring }),
    );
    return svg;
}

// 線を引く点を、選択の枠の右下の角 corner から右下 45° へずらす量 (横と縦それぞれ。画面の px)。出している + の丸 (中心 pluses) と
// 線を引く点の丸の間が LINK_CLEARANCE 以上になる、いちばん小さい量。間が足りる間は 0 (角のまま)
function linkShift(corner: Point, pluses: readonly Point[]): number {
    const reach = LINK_CLEARANCE + LINK_OUTER + PLUS_OUTER;
    let amount = 0;
    // 丸の中心どうしの距離が reach より短い量の区間 (横と縦に t ずらすと、距離の 2 乗は t の 2 次式) に入っていれば、その区間の終わりへ進める。
    // 進めた先で別の + の区間に入ることがあるので、+ の数だけ繰り返す
    for (let round = 0; round <= pluses.length; round += 1) {
        let moved = false;
        for (const plus of pluses) {
            const dx = plus.x - corner.x;
            const dy = plus.y - corner.y;
            const half = (dx + dy) / 2;
            const discriminant = half * half - (dx * dx + dy * dy - reach * reach) / 2;
            if (discriminant <= 0) continue;
            const root = Math.sqrt(discriminant);
            if (amount > half - root + EPSILON && amount < half + root - EPSILON) {
                amount = half + root;
                moved = true;
            }
        }
        if (!moved) break;
    }
    return amount;
}

// 角を丸めた矩形の、高さ y での横の区間 (かからなければ null)
function spanAt(shape: RoundBox, y: number): [number, number] | null {
    if (y <= shape.top || y >= shape.bottom) return null;
    const { radius } = shape;
    const dy = Math.max(shape.top + radius - y, y - (shape.bottom - radius), 0);
    const inset = radius - Math.sqrt(Math.max(radius * radius - dy * dy, 0));
    return [shape.left + inset, shape.right - inset];
}

// 高さ y の行で、2 つの絵の外接矩形までの距離が等しくなる横の位置。距離の 2 乗は、絵の左右の辺で区切った区間ごとに x の 2 次式になる
function equalDistanceAt(a: HitSource, b: HitSource, ay: number, by: number): number[] {
    const edges = [a.drawing.left, a.drawing.right, b.drawing.left, b.drawing.right].sort((p, q) => p - q);
    const bounds = [-Infinity, ...edges, Infinity];
    // 区間の中での、絵からの横の距離 p x + q の係数
    const linear = (drawing: Box, x: number): [number, number] => (x < drawing.left ? [-1, drawing.left] : x > drawing.right ? [1, -drawing.right] : [0, 0]);
    const found: number[] = [];
    for (let index = 0; index + 1 < bounds.length; index += 1) {
        const low = bounds[index] ?? -Infinity;
        const high = bounds[index + 1] ?? Infinity;
        if (high - low < EPSILON) continue;
        const middle = low === -Infinity ? high - 1 : high === Infinity ? low + 1 : (low + high) / 2;
        const [pa, qa] = linear(a.drawing, middle);
        const [pb, qb] = linear(b.drawing, middle);
        const square = pa * pa - pb * pb;
        const single = 2 * (pa * qa - pb * qb);
        const constant = qa * qa - qb * qb + ay * ay - by * by;
        const roots: number[] = [];
        if (Math.abs(square) < EPSILON) {
            if (Math.abs(single) > EPSILON) roots.push(-constant / single);
        } else {
            const discriminant = single * single - 4 * square * constant;
            if (discriminant >= 0) {
                const root = Math.sqrt(discriminant);
                roots.push((-single - root) / (2 * square), (-single + root) / (2 * square));
            }
        }
        for (const root of roots) if (root > low && root < high) found.push(root);
    }
    return found;
}

// 高さ y の行の、つまみごとの区間。選択の枠の線の内側を除き、その点を含む四角のうち絵の外接矩形までの距離がいちばん近いつまみが取る
function rowRuns(sources: readonly HitSource[], frame: RoundBox, y: number): HitRun[] {
    const active = sources.filter((source) => y > source.area.top && y < source.area.bottom);
    if (active.length === 0) return [];
    const offsets = active.map((source) => Math.max(source.drawing.top - y, 0, y - source.drawing.bottom));
    const inside = spanAt(frame, y);
    const cuts = [...active.flatMap((source) => [source.area.left, source.area.right, source.drawing.left, source.drawing.right]), ...(inside ?? [])];
    for (let first = 0; first < active.length; first += 1) {
        for (let second = first + 1; second < active.length; second += 1) {
            const a = active[first];
            const b = active[second];
            if (a && b) cuts.push(...equalDistanceAt(a, b, offsets[first] ?? 0, offsets[second] ?? 0));
        }
    }
    const left = Math.min(...active.map((source) => source.area.left));
    const right = Math.max(...active.map((source) => source.area.right));
    const xs = cuts.filter((x) => x >= left && x <= right).sort((p, q) => p - q);
    const ownerAt = (x: number): HitKind | null => {
        if (inside && x > inside[0] && x < inside[1]) return null;
        let owner: HitKind | null = null;
        let nearest = Infinity;
        for (const [index, source] of active.entries()) {
            if (x < source.area.left || x > source.area.right) continue;
            const dx = Math.max(source.drawing.left - x, 0, x - source.drawing.right);
            const dy = offsets[index] ?? 0;
            const distance = dx * dx + dy * dy;
            if (distance < nearest - EPSILON) {
                owner = source.kind;
                nearest = distance;
            }
        }
        return owner;
    };
    const runs: HitRun[] = [];
    for (let index = 0; index + 1 < xs.length; index += 1) {
        const from = xs[index] ?? 0;
        const to = xs[index + 1] ?? 0;
        if (to - from < EPSILON) continue;
        const owner = ownerAt((from + to) / 2);
        if (owner === null) continue;
        const last = runs[runs.length - 1];
        if (last && last.kind === owner && Math.abs(last.right - from) < EPSILON) last.right = to;
        else runs.push({ kind: owner, left: from, right: to });
    }
    return runs;
}

const sameRuns = (a: readonly HitRun[], b: readonly HitRun[]): boolean =>
    a.length === b.length && a.every((run, index) => run.kind === b[index]?.kind && Math.abs(run.left - (b[index]?.left ?? 0)) < EPSILON && Math.abs(run.right - (b[index]?.right ?? 0)) < EPSILON);

// 広げた当たり判定を、つまみごとの長方形の並びにする。drawings は出しているつまみの絵の外接矩形、frame は選択の枠の線の外側 (どちらも同じ座標)。
// 行の境目は、四角と絵の上下の辺 (距離の式が変わる所) と選択の枠の上下の辺と角の丸みの始まりで、その間を HIT_ROW 以下の行に割る。
// 区間が前の行と同じなら、前の長方形を下へ伸ばす
function hitRects(drawings: ReadonlyArray<{ kind: HitKind; drawing: Box }>, frame: RoundBox): Map<HitKind, HitRect[]> {
    const sources: HitSource[] = [...drawings]
        .sort((a, b) => HIT_ORDER.indexOf(a.kind) - HIT_ORDER.indexOf(b.kind))
        .map(({ kind, drawing }) => ({ kind, drawing, area: grow(drawing, HIT_EXPAND) }));
    const rects = new Map<HitKind, HitRect[]>(sources.map((source) => [source.kind, []]));
    if (sources.length === 0) return rects;
    const top = Math.min(...sources.map((source) => source.area.top));
    const bottom = Math.max(...sources.map((source) => source.area.bottom));
    const edges = [
        ...sources.flatMap((source) => [source.area.top, source.area.bottom, source.drawing.top, source.drawing.bottom]),
        frame.top,
        frame.bottom,
        frame.top + frame.radius,
        frame.bottom - frame.radius,
    ]
        .filter((y) => y >= top && y <= bottom)
        .sort((a, b) => a - b);
    // 下へ伸ばしている途中の行の区間と、その上の辺
    let open: HitRun[] = [];
    let openTop = top;
    const close = (runs: readonly HitRun[], from: number, to: number): void => {
        for (const run of runs) rects.get(run.kind)?.push({ x: run.left, y: from, width: run.right - run.left, height: to - from + HIT_SEAM });
    };
    for (let index = 0; index + 1 < edges.length; index += 1) {
        const from = edges[index] ?? 0;
        const to = edges[index + 1] ?? 0;
        if (to - from < EPSILON) continue;
        const count = Math.ceil((to - from) / HIT_ROW - EPSILON);
        for (let row = 0; row < count; row += 1) {
            const rowTop = from + ((to - from) * row) / count;
            const rowBottom = from + ((to - from) * (row + 1)) / count;
            const runs = rowRuns(sources, frame, (rowTop + rowBottom) / 2);
            if (sameRuns(open, runs)) continue;
            close(open, openTop, rowTop);
            open = runs;
            openTop = rowTop;
        }
    }
    close(open, openTop, bottom);
    return rects;
}

export class Handles {
    private readonly elements: Record<HandleKind, HTMLDivElement>;
    // 線を引く点を入れて、ノードの箱に重ねる入れ物
    private readonly linkAnchor: HTMLDivElement;
    // 子の +、兄弟の +、線を引く点の、広げた当たり判定の長方形を入れる入れ物
    private readonly hits: Record<HitKind, HTMLDivElement>;
    // 出している点とつまみと、その相手 (同じ相手には重ね直さない。押している途中の点を動かさないため)
    private readonly shown = new Map<HandleKind, { key: string; detach: () => void }>();
    // 線を引く点と + を出している 1 つのノード
    private single: number | null = null;
    // 置き場を合わせた図の倍率
    private zoom = Number.NaN;
    // 線を引く点の置き場と当たり判定を作ったときの、箱の大きさと倍率と出している + (同じなら作り直さない)
    private laidOut = '';

    constructor(
        private readonly attach: Attach,
        private readonly measure: MeasureBox,
        listeners: HandleListeners,
        signal: AbortSignal,
    ) {
        const create = (kind: HandleKind): HTMLDivElement => {
            const element = document.createElement('div');
            element.className = 'mdag-editor-handle';
            element.dataset.handle = kind;
            element.title = TITLE[kind];
            element.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                // 点とつまみの押下で文字を選ばない
                event.preventDefault();
                if (!isPlus(kind)) listeners.onDragStart(kind, event);
            });
            if (isPlus(kind)) {
                element.setAttribute('role', 'button');
                element.setAttribute('aria-label', TITLE[kind]);
                element.append(plusDrawing());
                element.addEventListener('click', (event) => {
                    if (event.button === 0) listeners.onPlus(kind);
                });
            }
            return element;
        };
        this.elements = { link: create('link'), join: create('join'), child: create('child'), sibling: create('sibling') };
        const link = this.elements.link;
        link.style.width = link.style.height = `${LINK_OUTER * 2}px`;
        link.append(linkDrawing());
        this.linkAnchor = document.createElement('div');
        this.linkAnchor.className = 'mdag-editor-handle-anchor';
        this.linkAnchor.append(link);
        const hit = (kind: HitKind): HTMLDivElement => {
            const host = document.createElement('div');
            host.className = 'mdag-editor-handle-hit';
            this.elements[kind].prepend(host);
            return host;
        };
        this.hits = { link: hit('link'), child: hit('child'), sibling: hit('sibling') };
        // 箱の大きさが変わる (描き直しとその動き、倍率) と、図の側が入れ物の大きさを合わせ直すので、そのたびに置き場と当たり判定を合わせる
        const resize = new ResizeObserver(() => this.layout());
        resize.observe(this.linkAnchor);
        signal.addEventListener('abort', () => resize.disconnect(), { once: true });
        this.setZoom(1);
    }

    // 図の倍率 k に合わせて、+ と線を引く点を選択の枠から離す量と、当たり判定を直す
    setZoom(k: number): void {
        if (k === this.zoom || !Number.isFinite(k)) return;
        this.zoom = k;
        const plus = SELECTION_FRAME.outer * k + PLUS_GAP;
        // 図の側は要素の大きさを整数の px で読んで辺の中央にそろえるので、端数の分を戻して丸の中心を辺の中央に合わせる
        const centering = (Math.round(PLUS.size) - PLUS.size) / 2;
        // 離す量は translate で付ける (margin で付けると、図の側の transform と端数の位置が重なり、firefox で中の当たり判定の長方形が細る)
        this.elements.child.style.translate = `${plus}px ${centering}px`;
        this.elements.sibling.style.translate = `${centering}px ${plus}px`;
        this.layout();
    }

    // 選んでいるノードの id に合わせて点を出し (空なら外す)、1 つのときは plus の + も出す。線を引く点をずらす量は plus で決める
    show(ids: readonly number[], plus: readonly PlusHandleKind[] = []): void {
        const wanted = new Map<HandleKind, OverlayTarget>();
        const [first] = ids;
        if (ids.length === 1 && first !== undefined) {
            wanted.set('link', { node: first });
            for (const kind of plus) wanted.set(kind, { node: first });
        } else if (ids.length > 1) {
            wanted.set('join', { nodes: [...ids] });
        }
        this.single = ids.length === 1 && first !== undefined ? first : null;
        const key = ids.join(',');
        for (const kind of KINDS) {
            const shown = this.shown.get(kind);
            const target = wanted.get(kind);
            if (target === undefined) {
                shown?.detach();
                this.shown.delete(kind);
                continue;
            }
            if (shown?.key === key) continue;
            shown?.detach();
            const element = kind === 'link' ? this.linkAnchor : this.elements[kind];
            this.shown.set(kind, { key, detach: this.attach(element, { target, place: PLACE[kind], gap: GAP[kind] }) });
        }
        // すぐあとの押下が広げた範囲に当たるよう、出したのと同じ時に当たり判定を作る
        this.layout();
    }

    hide(): void {
        this.show([]);
    }

    // 線を引く点の置き場 (縮小したときのずらし) と、子の +、兄弟の +、線を引く点の当たり判定を、出している + と
    // 選んだノードの箱の画面の大きさと図の倍率に合わせる。座標は箱の左上からの画面の px
    private layout(): void {
        const id = this.single;
        const size = id === null ? null : this.measure(id);
        const pluses = PLUS_KINDS.filter((kind) => this.shown.has(kind));
        if (size === null) {
            if (this.laidOut !== '') for (const kind of HIT_ORDER) this.paintHits(kind, [], { x: 0, y: 0 });
            this.laidOut = '';
            return;
        }
        const k = this.zoom;
        const key = [size.width, size.height, k, ...pluses].join(',');
        if (key === this.laidOut) return;
        this.laidOut = key;
        const { width, height } = size;
        const outer = SELECTION_FRAME.outer * k;
        const middle = ((SELECTION_FRAME.inner + SELECTION_FRAME.outer) / 2) * k;
        // + の絵の左上 (丸の外接矩形の左上)
        const plusOrigin: Record<PlusHandleKind, Point> = {
            child: { x: width + outer + PLUS_GAP, y: height / 2 - PLUS_OUTER },
            sibling: { x: width / 2 - PLUS_OUTER, y: height + outer + PLUS_GAP },
        };
        const plusCenter = (kind: PlusHandleKind): Point => ({ x: plusOrigin[kind].x + PLUS_OUTER, y: plusOrigin[kind].y + PLUS_OUTER });
        const corner = { x: width + middle, y: height + middle };
        const amount = linkShift(corner, pluses.map(plusCenter));
        const dot = { x: corner.x + amount, y: corner.y + amount };
        this.elements.link.style.left = this.elements.link.style.top = `calc(100% + ${middle + amount - LINK_OUTER}px)`;

        const origins: Record<HitKind, Point> = { ...plusOrigin, link: { x: dot.x - LINK_OUTER, y: dot.y - LINK_OUTER } };
        const drawings = [
            { kind: 'link' as const, drawing: moveBox(LINK_BOUNDS, dot) },
            ...pluses.map((kind) => ({ kind, drawing: { left: plusOrigin[kind].x, top: plusOrigin[kind].y, right: plusOrigin[kind].x + PLUS.size, bottom: plusOrigin[kind].y + PLUS.size } })),
        ];
        const frame = { left: -outer, top: -outer, right: width + outer, bottom: height + outer };
        const radius = Math.min(SELECTION_FRAME.radius * k, (frame.right - frame.left) / 2, (frame.bottom - frame.top) / 2);
        const rects = hitRects(drawings, { ...frame, radius });
        for (const kind of HIT_ORDER) this.paintHits(kind, rects.get(kind) ?? [], origins[kind]);
    }

    // 当たり判定の長方形を、つまみの要素の左上 origin からの位置で置く (要素は使い回す)
    private paintHits(kind: HitKind, rects: readonly HitRect[], origin: Point): void {
        const host = this.hits[kind];
        rects.forEach((rect, index) => {
            const cell = host.children[index] ?? host.appendChild(document.createElement('div'));
            if (cell instanceof HTMLElement) cell.style.cssText = `left: ${rect.x - origin.x}px; top: ${rect.y - origin.y}px; width: ${rect.width}px; height: ${rect.height}px;`;
        });
        while (host.children.length > rects.length) host.lastElementChild?.remove();
    }
}

// 図の上の押下とクリックを、選択と付け替えと線の操作に読み替える: ノードの押下 (修飾キーなしは選ぶ、修飾キーつきは足す・外す)、
// 何もないところのクリック (選択を解く、合流先を選ぶ途中をやめる。押下も何もないところで始まったものだけ)、線のクリック (線を選ぶ)、
// 何もないところ (枠の内側と線の帯の上を含む) からの主ボタンのドラッグ (矩形選択)、ノードからの主ボタンのドラッグ (付け替え)、
// 選んだノードの点からのドラッグ (1 つなら右下の点で線を引く、2 つ以上なら全体の右の点で合流させる)。図の受け口 (view.addHooks に足すもの) を作り、ドラッグの間だけ window の pointermove と pointerup を受ける。
// どのドラッグも 4px より動いてから始め (図のクリックの判定と同じ)、それまでに離したらクリックとして扱う。
// 矩形は離したときに矩形にかかった (箱が一部でも重なる) ノードを知らせる。付け替えは、ポインタに名前の影を付け、ポインタの下のノードを
// 移す先の枠の相手として知らせ、離したときにポインタの下のノード (ノードの外なら null) を知らせる。
// 線を引くドラッグと合流させるドラッグは、始点のそれぞれからポインタへ集まる線を出し、始点でないポインタの下のノードを枠の相手として知らせ、
// 離したときにポインタの下のノード (ノードの外なら null) を知らせる。
// どのドラッグも、pointercancel とウィンドウのフォーカスが外れたときは何も知らせずにやめる。Esc でもやめられる (cancelDrag。矩形は、やめたあとに離したときのクリックでも選択を変えない)。
// 指のドラッグと、手のひらと中ボタンと Space のドラッグは図のパンに任せ、矩形にも付け替えにもしない。
// 修飾キーは Shift と ⌘、macOS 以外では Ctrl も。macOS の Ctrl +クリックはブラウザのメニューを出す副ボタンのクリックなので、選択に使わない。
// どのノードを選ぶか (ルートを入れない決まりなど)、どのノードを動かせて、どこへ枠を出すか、離したら何をするかは知らせた先が決める
import type { EdgeTarget, NodeTarget, OutlineNode, Rect, ViewListeners } from '../core';
import { LinkPreview, type PreviewPoint } from './ui/link-preview';

interface PointerHandlers {
    // 押下を選択に読み替えるか (GUI 編集のとき)
    editing(): boolean;
    // 選択の道具のドラッグ (何もないところからの矩形選択と、ノードからの付け替え) が効くか
    selectDrag(): boolean;
    // 何もないところのクリックを受けるか (選択を解くか、合流先を選ぶ途中をやめる)
    takesBlankClick(): boolean;
    pressNode(node: OutlineNode, additive: boolean): void;
    // 矩形にかかったノードの id (見えているノードの文書の順)
    boxNodes(ids: number[], additive: boolean): void;
    clickBlank(): void;
    // 見えているノードの矩形 (図の領域の左上からの画面の座標)
    nodeRects(): ReadonlyMap<number, Rect>;
    // 押したノードを付け替えで動かすなら、描いている図のそのノード。動かさないノード (ルート、描いている図にないノード) は null
    moveSource(node: OutlineNode): NodeTarget | null;
    // ポインタの下のノードに、移す先の枠を出すか
    canDropOn(source: NodeTarget, id: number): boolean;
    // 移す先の枠を付ける相手を替える (null で外す)
    showDropTarget(id: number | null): void;
    // 付け替えのドラッグを離した。id は離した所のノード (ノードの外なら null)
    dropNode(source: NodeTarget, id: number | null): void;
    // 線のクリック (図の線の種類と両端)
    clickEdge(edge: EdgeTarget): void;
    // 線を引くドラッグ (始点が 1 つ) か合流させるドラッグ (始点が 2 つ以上) を離した。id は離した所のノード (ノードの外なら null)
    linkTo(sources: readonly NodeTarget[], id: number | null): void;
}

// 押してからこれより動いたらドラッグ (図のクリックの判定と同じ)
const CLICK_SLOP = 4;

// 名前の影をポインタから離す量 (画面の px。ポインタの下の移す先の枠を隠さないよう、右下にずらす)
const GHOST_OFFSET = { x: 14, y: 12 };

// ドラッグの共通の欄。押した所と、ドラッグの間だけ付ける window の受け口を外すもの
interface Press {
    pointerId: number;
    start: { x: number; y: number };
    listening: AbortController;
}

interface MarqueeDrag extends Press {
    kind: 'marquee';
    additive: boolean;
    // 4px より動いて矩形を出したら、その要素
    element: HTMLDivElement | null;
}

interface MoveDrag extends Press {
    kind: 'move';
    source: NodeTarget;
    // 4px より動いて影を出したら、その要素
    ghost: HTMLDivElement | null;
    // 移す先の枠を付けているノード
    over: number | null;
}

interface LinkDrag extends Press {
    kind: 'link';
    sources: readonly NodeTarget[];
    // 4px より動いて引く線を出したか
    drawing: boolean;
    // 枠を付けているノード (始点でないポインタの下のノード)
    over: number | null;
}

type Drag = MarqueeDrag | MoveDrag | LinkDrag;

function isApplePlatform(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

// macOS の Ctrl +主ボタン (ブラウザは副ボタンのクリックとして扱う)
function isSecondaryClick(event: MouseEvent): boolean {
    return event.ctrlKey && isApplePlatform();
}

// 選択に足す・外す修飾キーを押しているか
export function isAdditive(event: MouseEvent): boolean {
    return event.shiftKey || event.metaKey || (event.ctrlKey && !isApplePlatform());
}

// 矩形 (l、t、r、b) と箱が一部でも重なるか
function overlaps(rect: Rect, left: number, top: number, right: number, bottom: number): boolean {
    return rect.x < right && rect.x + rect.width > left && rect.y < bottom && rect.y + rect.height > top;
}

function moved(drag: Press, event: PointerEvent): boolean {
    return Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) > CLICK_SLOP;
}

export class PointerInput {
    readonly hooks: ViewListeners;
    private drag: Drag | null = null;
    private readonly preview: LinkPreview;
    // 矩形選択を終えた (Esc でやめた) 直後の何もないところのクリック (押した所の近くで離したとき) で、選んだものを解かない
    private marqueeEnded = false;
    // 直前の押下が何もないところ (枠と線の帯とノードの外) で始まったか。何もないところのクリックはこれが true のときだけ受ける。
    // 押下の中の描き直しで押した要素が外れたときや、ノードの端を押して箱の外の近くで離したときは、
    // 図の領域そのものへクリックが届き、図はそれを何もないところのクリックとして渡すため
    private blankPress = false;

    // layer は矩形、影、引く線を描く入れ物で、図の領域と同じ位置と大きさのもの
    constructor(
        private readonly layer: HTMLElement,
        private readonly handlers: PointerHandlers,
        signal: AbortSignal,
    ) {
        this.preview = new LinkPreview(layer);
        signal.addEventListener('abort', () => this.cancel(), { once: true });
        // 押下ごとに決め直す。図の受け口より先に受け、受け口を通らない押下 (開閉の円、重ね置きの要素、図の外) は何もないところにしない
        document.addEventListener(
            'pointerdown',
            () => {
                this.blankPress = false;
            },
            { capture: true, signal },
        );
        this.hooks = {
            onNodePointerDown: (node, event) => {
                if (!handlers.editing() || event.button !== 0 || isSecondaryClick(event)) return;
                const additive = isAdditive(event);
                // 付け替えを始めるかは押す前の道具で決める (合流先を押すと道具が戻るが、その押下からは付け替えない)
                const drags = !additive && handlers.selectDrag() && event.pointerType !== 'touch';
                // 修飾キーの押下は文字の選択 (Shift で広げるなど) にしない
                if (additive) event.preventDefault();
                handlers.pressNode(node, additive);
                if (!drags) return;
                // 付け替えのドラッグがノードの文字の上を通っても、文字を選ばない (動かさないルートの押下も同じ)
                event.preventDefault();
                const source = handlers.moveSource(node);
                if (source !== null) this.begin({ kind: 'move', ...this.pressOf(event), source, ghost: null, over: null });
            },
            onCanvasPointerDown: (event, target) => {
                this.marqueeEnded = false;
                this.blankPress = target.kind === 'blank';
                if (!handlers.editing() || !handlers.selectDrag() || event.button !== 0 || event.pointerType === 'touch' || isSecondaryClick(event)) return;
                // ドラッグがノードの文字の上を通っても、文字を選ばない
                event.preventDefault();
                this.begin({ kind: 'marquee', ...this.pressOf(event), additive: isAdditive(event), element: null });
            },
            onCanvasClick: (event) => {
                const afterMarquee = this.marqueeEnded;
                const fromBlank = this.blankPress;
                this.marqueeEnded = false;
                this.blankPress = false;
                if (!fromBlank || afterMarquee || !handlers.editing() || !handlers.takesBlankClick() || isAdditive(event) || isSecondaryClick(event)) return;
                handlers.clickBlank();
            },
            onEdgeClick: (edge) => {
                if (handlers.editing()) handlers.clickEdge(edge.edge);
            },
        };
    }

    // 点の押下から、線を引くドラッグ (始点が 1 つ) か合流させるドラッグ (始点が 2 つ以上) を始める
    beginLink(event: PointerEvent, sources: readonly NodeTarget[]): void {
        if (sources.length === 0) return;
        this.begin({ kind: 'link', ...this.pressOf(event), sources: [...sources], drawing: false, over: null });
    }

    // ドラッグの途中なら、何も知らせずにやめる (矩形は選ばず、付け替えは移す先の枠と影を、線は引く線と枠を外す)
    cancel(): void {
        const drag = this.drag;
        if (!drag) return;
        this.drag = null;
        drag.listening.abort();
        if (drag.kind === 'marquee') {
            drag.element?.remove();
            return;
        }
        if (drag.kind === 'move') drag.ghost?.remove();
        else this.preview.hide();
        if (drag.over !== null) this.handlers.showDropTarget(null);
    }

    // 矩形選択のドラッグ (押しただけで、まだ動かしていないものを含む) の途中か
    get marqueeing(): boolean {
        return this.drag?.kind === 'marquee';
    }

    // ドラッグ (押しただけで、まだ動かしていないものを含む) の途中ならやめて true。矩形は選ばず、そのあと離しても何もないところのクリックにしない
    cancelDrag(): boolean {
        if (this.drag === null) return false;
        if (this.drag.kind === 'marquee') this.marqueeEnded = true;
        this.cancel();
        return true;
    }

    private pressOf(event: PointerEvent): Press {
        return { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, listening: new AbortController() };
    }

    private begin(drag: Drag): void {
        this.cancel();
        this.drag = drag;
        const { signal } = drag.listening;
        window.addEventListener(
            'pointermove',
            (move) => {
                if (move.pointerId !== drag.pointerId) return;
                if (drag.kind === 'marquee') this.extend(drag, move);
                else if (drag.kind === 'move') this.carry(drag, move);
                else this.stretch(drag, move);
            },
            { signal },
        );
        window.addEventListener(
            'pointerup',
            (up) => {
                if (up.pointerId !== drag.pointerId) return;
                if (drag.kind === 'marquee') this.finish(drag, up);
                else if (drag.kind === 'move') this.drop(drag, up);
                else this.release(drag, up);
            },
            { signal },
        );
        window.addEventListener(
            'pointercancel',
            (cancel) => {
                if (cancel.pointerId === drag.pointerId) this.cancel();
            },
            { signal },
        );
        // ウィンドウのフォーカスが外れたら (離したことが届かないことがあるので) やめる
        window.addEventListener('blur', () => this.cancel(), { signal });
    }

    // 画面の座標を、図の領域の左上からの座標にする
    private local(event: PointerEvent): { x: number; y: number } {
        const origin = this.layer.getBoundingClientRect();
        return { x: event.clientX - origin.left, y: event.clientY - origin.top };
    }

    // 押した所と今の所を角とする矩形 (図の領域の左上からの座標)
    private areaOf(drag: MarqueeDrag, event: PointerEvent): { left: number; top: number; right: number; bottom: number } {
        const origin = this.layer.getBoundingClientRect();
        return {
            left: Math.min(drag.start.x, event.clientX) - origin.left,
            top: Math.min(drag.start.y, event.clientY) - origin.top,
            right: Math.max(drag.start.x, event.clientX) - origin.left,
            bottom: Math.max(drag.start.y, event.clientY) - origin.top,
        };
    }

    private extend(drag: MarqueeDrag, event: PointerEvent): void {
        if (!drag.element) {
            if (!moved(drag, event)) return;
            drag.element = document.createElement('div');
            drag.element.className = 'mdag-editor-marquee';
            this.layer.append(drag.element);
        }
        const area = this.areaOf(drag, event);
        Object.assign(drag.element.style, {
            left: `${area.left}px`,
            top: `${area.top}px`,
            width: `${area.right - area.left}px`,
            height: `${area.bottom - area.top}px`,
        });
    }

    private finish(drag: MarqueeDrag, event: PointerEvent): void {
        const drawn = drag.element !== null;
        this.cancel();
        if (!drawn) return;
        this.marqueeEnded = true;
        const { left, top, right, bottom } = this.areaOf(drag, event);
        const hits = [...this.handlers.nodeRects()].flatMap(([id, rect]) => (overlaps(rect, left, top, right, bottom) ? [id] : []));
        this.handlers.boxNodes(hits, drag.additive);
    }

    // ポインタの下のノード (図の領域の左上からの座標で、箱の矩形の中)。ノードの外なら null。
    // 図の領域の外も null (パンで領域の外に出ているノードは見えないので、その上で離しても相手にしない)
    private nodeAt(point: { x: number; y: number }): number | null {
        const area = this.layer.getBoundingClientRect();
        if (point.x < 0 || point.y < 0 || point.x > area.width || point.y > area.height) return null;
        for (const [id, rect] of this.handlers.nodeRects()) {
            if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) return id;
        }
        return null;
    }

    // 付け替えのドラッグの途中: 影をポインタに付け、ポインタの下のノードが移せる先なら枠を付ける
    private carry(drag: MoveDrag, event: PointerEvent): void {
        if (!drag.ghost) {
            if (!moved(drag, event)) return;
            drag.ghost = document.createElement('div');
            drag.ghost.className = 'mdag-editor-ghost';
            drag.ghost.textContent = drag.source.refText === '' ? '名前のないノード' : drag.source.refText;
            this.layer.append(drag.ghost);
        }
        const point = this.local(event);
        Object.assign(drag.ghost.style, { left: `${point.x + GHOST_OFFSET.x}px`, top: `${point.y + GHOST_OFFSET.y}px` });
        const id = this.nodeAt(point);
        const over = id !== null && this.handlers.canDropOn(drag.source, id) ? id : null;
        if (over === drag.over) return;
        drag.over = over;
        this.handlers.showDropTarget(over);
    }

    // 付け替えのドラッグを離した: 枠と影を外してから、離した所のノードを知らせる。動かす前 (4px まで) ならクリックなので何もしない
    private drop(drag: MoveDrag, event: PointerEvent): void {
        const started = drag.ghost !== null;
        this.cancel();
        if (started) this.handlers.dropNode(drag.source, this.nodeAt(this.local(event)));
    }

    // 線のドラッグの途中: 始点のそれぞれ (箱の右の辺の中ほど) からポインタへ線を引き、ポインタの下のノードが始点でなければ枠を付ける
    private stretch(drag: LinkDrag, event: PointerEvent): void {
        if (!drag.drawing) {
            if (!moved(drag, event)) return;
            drag.drawing = true;
        }
        const point = this.local(event);
        const rects = this.handlers.nodeRects();
        const starts = drag.sources.flatMap((source): PreviewPoint[] => {
            const rect = rects.get(source.id);
            return rect ? [{ x: rect.x + rect.width, y: rect.y + rect.height / 2 }] : [];
        });
        this.preview.show(starts, point);
        const id = this.nodeAt(point);
        const over = id !== null && !drag.sources.some((source) => source.id === id) ? id : null;
        if (over === drag.over) return;
        drag.over = over;
        this.handlers.showDropTarget(over);
    }

    // 線のドラッグを離した: 引く線と枠を外してから、離した所のノードを知らせる。動かす前 (4px まで) なら何もしない
    private release(drag: LinkDrag, event: PointerEvent): void {
        const started = drag.drawing;
        this.cancel();
        if (started) this.handlers.linkTo(drag.sources, this.nodeAt(this.local(event)));
    }
}

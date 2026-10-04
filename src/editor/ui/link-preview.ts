// 線を引くドラッグと合流させるドラッグの途中に出す、引く線。始点のそれぞれから 1 点 (ポインタ) へ集まる曲線と、その点の印を描く。
// 入れ物は図の領域と同じ位置と大きさの層に置き、座標はその層の左上から測る。押下は受けない (ポインタの下のノードを隠さない)。
// どこから引くか (始点の位置) とどこまで引くかは呼ぶ側が決める
import { SVG_NS } from './icons';

// 曲線を始点から横へ張り出させる最小の量 (px)
const MIN_BEND = 40;

// 終わりの点の印の半径 (px)
const END_RADIUS = 3;

export interface PreviewPoint {
    x: number;
    y: number;
}

export class LinkPreview {
    private readonly element: SVGSVGElement;
    private readonly end: SVGCircleElement;
    private lines: SVGPathElement[] = [];

    constructor(private readonly layer: HTMLElement) {
        this.element = document.createElementNS(SVG_NS, 'svg');
        this.element.setAttribute('class', 'mdag-editor-link-layer');
        this.element.setAttribute('aria-hidden', 'true');
        this.end = document.createElementNS(SVG_NS, 'circle');
        this.end.setAttribute('r', String(END_RADIUS));
        this.element.append(this.end);
    }

    // starts のそれぞれから end へ線を引く (前の線は引き直す)
    show(starts: readonly PreviewPoint[], end: PreviewPoint): void {
        while (this.lines.length < starts.length) {
            const line = document.createElementNS(SVG_NS, 'path');
            line.setAttribute('class', 'mdag-editor-link-preview');
            this.element.insertBefore(line, this.end);
            this.lines.push(line);
        }
        for (const line of this.lines.splice(starts.length)) line.remove();
        for (const [index, start] of starts.entries()) this.lines[index]?.setAttribute('d', curve(start, end));
        this.end.setAttribute('cx', String(end.x));
        this.end.setAttribute('cy', String(end.y));
        if (!this.element.isConnected) this.layer.append(this.element);
    }

    hide(): void {
        for (const line of this.lines) line.remove();
        this.lines = [];
        this.element.remove();
    }
}

// 始点から右へ出て、終わりの点へ横から入る曲線
function curve(start: PreviewPoint, end: PreviewPoint): string {
    const bend = Math.max(MIN_BEND, Math.abs(end.x - start.x) / 2);
    return `M${start.x},${start.y} C${start.x + bend},${start.y} ${end.x - bend},${end.y} ${end.x},${end.y}`;
}

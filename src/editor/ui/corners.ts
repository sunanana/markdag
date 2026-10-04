// 図の領域の 6 つの隅の入れ物 (上下の左、中央、右)。隅に出す部品 (セグメント、凡例のパネル、案内、通知) を置く。
// 同じ隅の中は辺に近い順にセグメント、凡例のパネル、案内、通知と並べる。上の隅は上から下へ、下の隅は下から上へ積む (積む向きは見た目の側)
import type { SegmentPosition } from '../../core';

type CornerItem = 'segment' | 'legend' | 'hint' | 'snackbar';

const CORNERS: readonly SegmentPosition[] = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
// 辺に近い順
const ITEM_ORDER: readonly CornerItem[] = ['segment', 'legend', 'hint', 'snackbar'];

export class Corners {
    private readonly boxes = new Map<SegmentPosition, HTMLDivElement>();
    // 置いた部品の種類 (隅の中の並びを決める)
    private readonly items = new Map<Element, CornerItem>();

    constructor(layer: HTMLElement) {
        for (const corner of CORNERS) {
            const box = document.createElement('div');
            box.className = 'mdag-editor-corner';
            box.dataset.corner = corner;
            layer.append(box);
            this.boxes.set(corner, box);
        }
    }

    // 部品を隅に置く。ほかの隅にあれば移す
    place(element: HTMLElement, corner: SegmentPosition, item: CornerItem): void {
        const box = this.boxes.get(corner);
        if (!box) return;
        this.items.set(element, item);
        const rank = ITEM_ORDER.indexOf(item);
        const after = [...box.children].find((child) => child !== element && ITEM_ORDER.indexOf(this.items.get(child) ?? 'snackbar') > rank);
        box.insertBefore(element, after ?? null);
    }

    // 部品を隅から外す
    remove(element: HTMLElement): void {
        this.items.delete(element);
        element.remove();
    }
}

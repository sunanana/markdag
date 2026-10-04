// グループの色を選ぶカラーピッカー。よく使う 12 色の四角、16 進の入力、ブラウザの色選びを並べ、開いた相手 (凡例の行の色の四角) の下
// (入らなければ上) に、編集の層の中で置く。1 つの要素を使い回し、開いている相手のグループは 1 つだけ。
// 選んだ色を知らせるだけで、書き換えと閉じる時 (同じ四角、外の押下、Esc、選んだあと) は呼ぶ側が決める。
// 16 進は「#」なしも受けて「#」を足し、3 桁と 6 桁を書かれた字のまま受ける (大文字と小文字を直さない)。読めない字は知らせて開いたままにする。
// ブラウザの色選びは選び終えたとき (change) だけ知らせ、選んでいる途中 (input) では知らせない。
// ピッカーの中の Enter と Esc はピッカーのもの (図のキーの操作に渡さない)。変換中 (IME) のキーは入力欄に任せる
import { isComposingKey } from '../keys';

export const COLOR_SWATCHES: readonly string[] = ['#3B7DD8', '#1FA2B8', '#2E9E6B', '#6B8E23', '#E0A100', '#E8833A', '#D64545', '#E0569B', '#8A5FC2', '#8D6E63', '#607D8B', '#9E9E9E'];

// ブラウザの色選びの初めの色 (今の色が 16 進で読めないとき)
const FALLBACK_NATIVE = '#888888';

// 相手との間と、編集の層の辺から離す量 (画面の px)
const GAP = 6;
const EDGE = 6;

// 16 進の色の入力を読む。「#」なしは「#」を足し、3 桁と 6 桁だけを受ける (字はそのまま)。読めなければ null
export function parseHexColor(text: string): string | null {
    const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text.trim());
    return match ? `#${match[1] ?? ''}` : null;
}

// ブラウザの色選びに入れる値 (小文字の 6 桁)。16 進で読めない色は null
function nativeValueOf(color: string | null): string | null {
    const hex = color === null ? null : parseHexColor(color);
    if (hex === null) return null;
    const digits = hex.slice(1).toLowerCase();
    return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits}`;
}

interface ColorPickerHandlers {
    onPick(color: string): void;
    // 16 進の入力が読めない字のまま Enter を押した
    onInvalid(text: string): void;
    // ピッカーの中で Esc を押した
    onCancel(): void;
}

export class ColorPicker {
    readonly element: HTMLDivElement;
    private readonly swatches: HTMLButtonElement[] = [];
    private readonly hex: HTMLInputElement;
    private readonly native: HTMLInputElement;
    // 開いた相手 (色の四角) と、そのグループ
    private anchor: HTMLElement | null = null;
    private group: string | null = null;

    constructor(handlers: ColorPickerHandlers) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-color-picker';
        this.element.setAttribute('role', 'dialog');
        this.element.setAttribute('aria-label', 'グループの色');
        this.element.hidden = true;

        const grid = document.createElement('div');
        grid.className = 'mdag-editor-swatches';
        for (const color of COLOR_SWATCHES) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'mdag-editor-swatch';
            swatch.dataset.color = color;
            swatch.title = color;
            swatch.setAttribute('aria-label', color);
            swatch.style.background = color;
            swatch.addEventListener('click', () => handlers.onPick(color));
            grid.append(swatch);
            this.swatches.push(swatch);
        }

        const line = document.createElement('div');
        line.className = 'mdag-editor-color-line';
        this.hex = document.createElement('input');
        this.hex.type = 'text';
        this.hex.className = 'mdag-editor-hex';
        this.hex.autocomplete = 'off';
        this.hex.spellcheck = false;
        this.hex.maxLength = 7;
        this.hex.placeholder = '#RRGGBB';
        this.hex.setAttribute('aria-label', '16 進の色');
        this.hex.addEventListener('input', () => this.hex.removeAttribute('aria-invalid'));
        this.hex.addEventListener('keydown', (event) => {
            if (isComposingKey(event) || event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            const color = parseHexColor(this.hex.value);
            if (color !== null) {
                handlers.onPick(color);
                return;
            }
            this.hex.setAttribute('aria-invalid', 'true');
            handlers.onInvalid(this.hex.value);
        });
        const other = document.createElement('label');
        other.className = 'mdag-editor-color-native';
        other.title = 'ほかの色を選ぶ';
        this.native = document.createElement('input');
        this.native.type = 'color';
        this.native.addEventListener('change', () => handlers.onPick(this.native.value));
        other.append(this.native, 'その他');
        line.append(this.hex, other);

        this.element.append(grid, line);
        this.element.addEventListener('keydown', (event) => {
            if (isComposingKey(event) || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            handlers.onCancel();
        });
    }

    get isOpen(): boolean {
        return this.group !== null;
    }

    // 開いている相手のグループ (閉じていれば null)
    get openFor(): string | null {
        return this.group;
    }

    // ピッカーの中の要素か
    contains(target: EventTarget | null): boolean {
        return target instanceof Node && this.element.contains(target);
    }

    // 開いた相手 (色の四角) の中の要素か
    isAnchor(target: EventTarget | null): boolean {
        return target instanceof Node && this.anchor !== null && this.anchor.contains(target);
    }

    // layer (編集の層) の中に置き、anchor の下 (入らなければ上) に開く。current はグループの今の色
    open(layer: HTMLElement, anchor: HTMLElement, group: string, current: string | null): void {
        this.anchor = anchor;
        this.group = group;
        for (const swatch of this.swatches) swatch.setAttribute('aria-pressed', String(current !== null && swatch.dataset.color?.toLowerCase() === current.toLowerCase()));
        this.hex.value = current ?? '';
        this.hex.removeAttribute('aria-invalid');
        this.native.value = nativeValueOf(current) ?? FALLBACK_NATIVE;
        if (this.element.parentElement !== layer) layer.append(this.element);
        this.element.hidden = false;
        this.place(layer, anchor);
    }

    close(): void {
        this.anchor = null;
        this.group = null;
        this.element.hidden = true;
    }

    private place(layer: HTMLElement, anchor: HTMLElement): void {
        const area = layer.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        const width = this.element.offsetWidth;
        const height = this.element.offsetHeight;
        let top = rect.bottom - area.top + GAP;
        const above = rect.top - area.top - GAP - height;
        if (top + height > area.height - EDGE && above >= EDGE) top = above;
        const left = Math.max(EDGE, Math.min(rect.left - area.left, area.width - width - EDGE));
        this.element.style.left = `${left}px`;
        this.element.style.top = `${top}px`;
    }
}

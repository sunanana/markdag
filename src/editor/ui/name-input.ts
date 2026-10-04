// 名前の入力 (ノードの名前とグループの名前)。1 行の入力欄で、図に重ねる位置 (ノードの文字か枠のラベルの上) と、決めたあとの書き換えは呼ぶ側が受け持つ。
// 開いている間はフォーカスを持ち、キーを操作として知らせる。ノードの入力は Enter (決めて兄弟)、Tab (決めて子)、Shift+Tab (決めて兄弟)、Esc (やめる)。
// グループの入力は Enter (決める)、Esc (やめる) で、Tab と Shift+Tab は何もしない (フォーカスも動かさない)。
// 変換中 (IME) のキーは操作にしない: isComposing が true か keyCode が 229 のキー (変換を確定したキーが確定のあとに届く形を含む) は入力欄に任せる。
// フォーカスが入力欄の外へ移ったことも知らせる。ただし閉じたあと、図が入力欄を隠したか外したとき、ウィンドウそのもののフォーカスが外れたときは知らせない
// (どれも見る人がほかの所を選んだのではないため)
import { isComposingKey } from '../keys';

// stay は何もしない操作 (キーの既定の動きだけを止める)
export type NameInputAction = 'sibling' | 'child' | 'commit' | 'cancel' | 'stay';

// 名前を入れる相手
export type NameInputFor = 'node' | 'group';

interface NameInputKey {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    keyCode: number;
}

interface NameInputHandlers {
    onAction(action: Exclude<NameInputAction, 'stay'>): void;
    onLeave(): void;
    // Esc でやめるとき、keydown を図へ伝えないか (伝えなければ、図の Esc は吹き出しを閉じない)
    holdsEscape(): boolean;
}

const ARIA_LABEL: Record<NameInputFor, string> = { node: 'ノードの名前', group: 'グループの名前' };

// 入力欄のキーを名前の入力の操作にする。操作にならないキー (文字、矢印、変換中のキーなど) は null
export function nameInputAction(input: NameInputKey, kind: NameInputFor = 'node'): NameInputAction | null {
    if (isComposingKey(input)) return null;
    if (input.metaKey || input.ctrlKey || input.altKey) return null;
    if (input.key === 'Escape') return 'cancel';
    if (input.key === 'Tab') return kind === 'group' ? 'stay' : input.shiftKey ? 'sibling' : 'child';
    if (input.key === 'Enter' && !input.shiftKey) return kind === 'group' ? 'commit' : 'sibling';
    return null;
}

export class NameInput {
    readonly element: HTMLInputElement;
    private opened = false;

    constructor(kind: NameInputFor, handlers: NameInputHandlers) {
        const element = document.createElement('input');
        element.type = 'text';
        element.className = 'mdag-editor-name-input';
        element.dataset.for = kind;
        element.autocomplete = 'off';
        element.spellcheck = false;
        element.setAttribute('aria-label', ARIA_LABEL[kind]);
        element.addEventListener('keydown', (event) => {
            if (!this.opened) return;
            const action = nameInputAction(event, kind);
            if (action === null) return;
            // Tab でフォーカスを動かさない。Enter と Esc もここで受けたことにする
            event.preventDefault();
            if (action === 'cancel' && handlers.holdsEscape()) event.stopPropagation();
            if (action !== 'stay') handlers.onAction(action);
        });
        element.addEventListener('blur', () => {
            if (!this.opened || !element.isConnected || element.hidden) return;
            // ウィンドウのフォーカスが外れただけ (入力欄はページのフォーカスを持ったまま)
            if (document.activeElement === element && !document.hasFocus()) return;
            handlers.onLeave();
        });
        this.element = element;
    }

    get isOpen(): boolean {
        return this.opened;
    }

    get value(): string {
        return this.element.value;
    }

    // 入力欄が今フォーカスを持っているか
    get focused(): boolean {
        return document.activeElement === this.element;
    }

    // 値を入れてフォーカスを移し、値の全部を選ぶ。要素は先に図へ重ねておく
    open(value: string): void {
        this.opened = true;
        this.element.value = value;
        this.element.focus({ preventScroll: true });
        this.element.select();
    }

    // 閉じたことにする (要素を図から外すのは呼ぶ側)。このあとのフォーカスの移動は知らせない
    close(): void {
        this.opened = false;
    }

    // 開いているのにフォーカスを失っていたら戻す
    refocus(): void {
        if (this.opened && !this.focused && this.element.isConnected) this.element.focus({ preventScroll: true });
    }
}

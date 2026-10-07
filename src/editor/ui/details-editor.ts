// 詳細の入力 (複数行)。テキストエリアと保存、やめるのボタンを 1 つの入れ物に並べる。図に重ねる位置と、保存の書き換えは呼ぶ側が受け持つ。
// 開いている間はテキストエリアがフォーカスを持ち、キーを操作として知らせる: 保存のキーの Enter (OS の区分で分ける。mac は ⌘Enter、
// win は Ctrl+Enter。名前の入力の足すキーと同じ)、Esc (やめる)。Enter と Shift+Enter はそのまま改行。ほかの修飾キーの Enter
// (mac の Ctrl、⌥、win の Windows キー、Alt、修飾キー 2 つ以上) は何もしない (保存も改行もしない)。
// Tab と Shift+Tab は何もしない (フォーカスも動かさない)。
// 変換中 (IME) のキーは操作にしない: isComposing が true か keyCode が 229 のキー (変換を確定したキーが確定のあとに届く形を含む) はテキストエリアに任せる。
// ボタンは押してもフォーカスを取らない (テキストエリアに残す)。
// フォーカスが入れ物の外へ移ったことも知らせる。ただし閉じたあと、図が入れ物を隠したか外したとき、ウィンドウそのもののフォーカスが外れたときは知らせない
// (どれも見る人がほかの所を選んだのではないため)
import { enterRole, isComposingKey, type KeyPlatform } from '../keys';

// stay は何もしない操作 (キーの既定の動きだけを止める)
export type DetailsEditorAction = 'save' | 'cancel' | 'stay';

interface DetailsEditorKey {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    keyCode: number;
}

interface DetailsEditorHandlers {
    onAction(action: Exclude<DetailsEditorAction, 'stay'>): void;
    onLeave(): void;
    // Esc でやめるとき、keydown を図へ伝えないか (伝えなければ、図の Esc は吹き出しを閉じない)
    holdsEscape(): boolean;
}

// テキストエリアのキーを詳細の入力の操作にする。操作にならないキー (文字、Enter の改行、矢印、変換中のキーなど) は null。
// platform は保存のキーの区分 (mac は ⌘、win は Ctrl)
export function detailsEditorAction(input: DetailsEditorKey, platform: KeyPlatform): DetailsEditorAction | null {
    if (isComposingKey(input)) return null;
    if (input.key === 'Enter') {
        const role = enterRole(input, platform);
        return role === 'plain' ? null : role === 'add' ? 'save' : 'stay';
    }
    if (input.metaKey || input.ctrlKey || input.altKey) return null;
    if (input.key === 'Escape') return 'cancel';
    if (input.key === 'Tab') return 'stay';
    return null;
}

// 保存のキーの名前 (ボタンの説明に出す)
const SAVE_KEYS: Record<KeyPlatform, string> = { mac: '⌘Enter', win: 'Ctrl+Enter' };

const BUTTONS: ReadonlyArray<{ action: Exclude<DetailsEditorAction, 'stay'>; label: string; title: (platform: KeyPlatform) => string }> = [
    { action: 'cancel', label: 'やめる', title: () => '書いたものを捨てて閉じる (Esc)' },
    { action: 'save', label: '保存', title: (platform) => `保存して閉じる (${SAVE_KEYS[platform]})` },
];

export class DetailsEditor {
    readonly element: HTMLDivElement;
    private readonly field: HTMLTextAreaElement;
    private opened = false;

    // platform は保存のキーの割り当ての区分
    constructor(handlers: DetailsEditorHandlers, platform: KeyPlatform) {
        const element = document.createElement('div');
        element.className = 'mdag-editor-details-editor';
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', '詳細の入力');

        const field = document.createElement('textarea');
        field.rows = 6;
        field.spellcheck = false;
        field.placeholder = '詳細 (行頭の > は要りません)';
        field.setAttribute('aria-label', '詳細');
        field.addEventListener('keydown', (event) => {
            if (!this.opened) return;
            const action = detailsEditorAction(event, platform);
            if (action === null) return;
            event.preventDefault();
            if (action === 'cancel' && handlers.holdsEscape()) event.stopPropagation();
            if (action !== 'stay') handlers.onAction(action);
        });

        const actions = document.createElement('div');
        actions.className = 'mdag-editor-details-actions';
        for (const entry of BUTTONS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mdag-editor-details-button';
            button.dataset.action = entry.action;
            button.title = entry.title(platform);
            button.textContent = entry.label;
            // 押してもテキストエリアのフォーカスを外さない (外へ移ったことにしない)
            button.addEventListener('mousedown', (event) => event.preventDefault());
            button.addEventListener('click', () => {
                if (this.opened) handlers.onAction(entry.action);
            });
            actions.append(button);
        }

        element.append(field, actions);
        element.addEventListener('focusout', (event) => {
            if (!this.opened || !element.isConnected || element.hidden) return;
            const next = event.relatedTarget;
            if (next instanceof Node && element.contains(next)) return;
            // ウィンドウのフォーカスが外れただけ (テキストエリアはページのフォーカスを持ったまま)
            if (!document.hasFocus()) return;
            handlers.onLeave();
        });
        this.element = element;
        this.field = field;
    }

    get isOpen(): boolean {
        return this.opened;
    }

    get value(): string {
        return this.field.value;
    }

    // 入れ物の中 (テキストエリアかボタン) が今フォーカスを持っているか
    get focused(): boolean {
        const active = document.activeElement;
        return active instanceof Node && this.element.contains(active);
    }

    // 値を入れてテキストエリアにフォーカスを移し、カーソルを末尾に置く。要素は先に図へ重ねておく
    open(value: string): void {
        this.opened = true;
        this.field.value = value;
        this.field.focus({ preventScroll: true });
        this.field.setSelectionRange(value.length, value.length);
    }

    // 閉じたことにする (要素を図から外すのは呼ぶ側)。このあとのフォーカスの移動は知らせない
    close(): void {
        this.opened = false;
    }

    // 開いているのにフォーカスを失っていたら戻す
    refocus(): void {
        if (this.opened && document.activeElement !== this.field && this.field.isConnected) this.field.focus({ preventScroll: true });
    }
}

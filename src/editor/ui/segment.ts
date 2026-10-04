// 閲覧と GUI 編集を切り替えるセグメント (2 つのボタン)。押されたモードを知らせるだけで、モードは持たない (今のモードは押された印で見せる)
import type { EditorMode } from '../settings';

const BUTTONS: ReadonlyArray<{ mode: EditorMode; label: string; title: string }> = [
    { mode: 'view', label: '閲覧', title: '図をそのまま見る' },
    { mode: 'edit', label: 'GUI 編集', title: '図を触って Markdown を書き換える' },
];

export class Segment {
    readonly element: HTMLDivElement;
    private readonly buttons = new Map<EditorMode, HTMLButtonElement>();

    constructor(onPick: (mode: EditorMode) => void) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-segment';
        this.element.setAttribute('role', 'group');
        this.element.setAttribute('aria-label', '表示のモード');
        for (const { mode, label, title } of BUTTONS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.mode = mode;
            button.textContent = label;
            button.title = title;
            button.setAttribute('aria-pressed', 'false');
            button.addEventListener('click', () => onPick(mode));
            this.element.append(button);
            this.buttons.set(mode, button);
        }
    }

    // 今のモードのボタンを押された印にする
    show(mode: EditorMode): void {
        for (const [each, button] of this.buttons) button.setAttribute('aria-pressed', String(each === mode));
    }
}

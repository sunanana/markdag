// 図の下の通知 (操作の結果、失敗の理由、案内)。1 つの要素を使い回し、新しい通知は前の通知を置き換える。
// 出してからしばらくすると消える (失敗は長めに出す)。モードによらず出す
export type NoticeKind = 'info' | 'error';

const DURATION: Record<NoticeKind, number> = { info: 3000, error: 5000 };

export class Snackbar {
    readonly element: HTMLDivElement;
    private timer = 0;

    constructor() {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-snackbar';
        this.element.setAttribute('role', 'status');
        this.element.hidden = true;
    }

    show(message: string, kind: NoticeKind = 'info'): void {
        this.element.textContent = message;
        this.element.dataset.kind = kind;
        this.element.hidden = false;
        window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.hide(), DURATION[kind]);
    }

    hide(): void {
        window.clearTimeout(this.timer);
        this.element.hidden = true;
    }

    // 消すまでの待ちを止める (片付けのあとに要素を触らない)
    destroy(): void {
        window.clearTimeout(this.timer);
    }
}

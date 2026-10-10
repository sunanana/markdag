// 選んだノードの左に出すチェック (押すとそのノードをタスクにする)。
// 図の重ね置きの層のほかの部品の下に置き、相手のノードの箱の左の辺の外、上下の中央に重ねる (相手に合わせて置き直すのは図の側の重ねる口)。
// 選択の枠 (図の倍率で太る) の外へ離す量は、図の倍率が変わるたびに setZoom で直す。
// 押されたことを知らせるだけで、出すかどうか (モード、道具、開いている入力、選んでいるノード、タスクにできるか) と書き換えは呼ぶ側が決める
import type { OverlayAnchor } from '../../core';
import { createIcon } from './icons';

// 図に重ねる口 (戻り値で外す)
type Attach = (element: HTMLElement, anchor: OverlayAnchor) => () => void;

// 図の選択の枠の線の外側の、箱の辺からの距離 (図の px。画面では図の倍率を掛ける) と、そこからチェックの要素までの間 (画面の px)。
// 絵は要素の右の辺から約 4px 内 (要素の余白と、絵の四角の外の余白) に描くので、選択の枠と絵の間の見た目の余白は約 4px になる
const SELECTION_OUTER = 5;
const CHECK_GAP = 0;

const TITLE = 'タスクにする';

export class TaskCheck {
    readonly element: HTMLDivElement;
    // 出している相手のノードと、重ねた要素を外す関数
    private shown: { id: number; detach: () => void } | null = null;

    constructor(
        private readonly attach: Attach,
        onPress: (id: number) => void,
        signal: AbortSignal,
    ) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-task-check';
        this.element.title = TITLE;
        this.element.setAttribute('role', 'button');
        this.element.setAttribute('aria-label', TITLE);
        this.element.append(createIcon('taskCheck'));
        this.element.addEventListener('pointerdown', (event) => {
            // チェックの押下で文字を選ばない
            if (event.button === 0) event.preventDefault();
        });
        this.element.addEventListener('click', (event) => {
            if (event.button === 0 && this.shown !== null) onPress(this.shown.id);
        });
        signal.addEventListener('abort', () => this.hide(), { once: true });
        this.setZoom(1);
    }

    // 選択の枠の外へ離す量を図の倍率に合わせる。重ねる口の間は箱の辺からの間だけにし、枠の分は translate で付ける
    // (出したまま倍率が変わっても、重ね直さずに置き場が合う)
    setZoom(k: number): void {
        if (Number.isFinite(k)) this.element.style.translate = `${-SELECTION_OUTER * k}px 0px`;
    }

    // id のノードの左に出す。同じノードには重ね直さない。
    // 重ね置きの層の最初に置き、同じ層のほかの部品 (+、線を引く点、コンテキストメニュー) の下にする
    // (小さい倍率でチェックが + の当たり判定に重なっても、+ の操作を先にする)
    show(id: number): void {
        if (this.shown?.id === id) return;
        this.shown?.detach();
        const detach = this.attach(this.element, { target: { node: id }, place: 'left', gap: CHECK_GAP });
        this.element.parentElement?.prepend(this.element);
        this.shown = { id, detach };
    }

    hide(): void {
        this.shown?.detach();
        this.shown = null;
    }
}

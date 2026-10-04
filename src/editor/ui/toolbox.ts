// 道具箱 (図の領域の左に縦に並ぶボタン)。アイコンの下に名前を出し、今の道具のボタンを押された印にする (合流先を選ぶ途中はどれも押された印にしない)。
// 戻ると進むは、戻せるもの / やり直せるものがなければ押せなくする。
// 「詳細表示」のボタンの右に、詳細の見せ方の選択肢 (常に表示、ホバー時に表示、隠す) を開く。ポインタを乗せて開いたものは、ボタンと選択肢から
// 離れて少し待つと閉じ、押して開いたものは開いたままにして、もう 1 度押すと閉じる。選んだら閉じる。今の見せ方に印 (aria-checked) を付ける。
// 押されたボタンと選ばれた見せ方を知らせるだけで、道具の切り替えや操作はしない (押したあとのフォーカスの戻し先と、
// 選択肢の外の押下と Esc で閉じるかは知らせた側が決める)
import type { DisplayMode } from '../../core';
import type { EditorTool, ToolState } from '../tools';
import { createIcon, type IconName } from './icons';

export type ToolboxItem = 'hand' | 'select' | 'join' | 'group' | 'tag-add' | 'tag-select' | 'details' | 'undo' | 'redo' | 'fit';

interface ToolboxButton {
    item: ToolboxItem;
    label: string;
    icon: IconName;
    title: string;
}

// 並びの順。separator は区切り
const LAYOUT: ReadonlyArray<ToolboxButton | 'separator'> = [
    { item: 'select', label: '選択', icon: 'select', title: '選ぶ・動かす (V)。中ボタンか Space を押しながらのドラッグで画面を動かせる' },
    { item: 'hand', label: '手のひら', icon: 'pan', title: '手のひら: 画面を動かす (H)。選択でも Space を押しながらドラッグで動かせる' },
    { item: 'join', label: '合流', icon: 'join', title: '選んだノードを合流させる。何もないところからドラッグして、2 つ以上を囲んで選んでから' },
    { item: 'group', label: 'グループ', icon: 'group', title: '選んだノードをグループにまとめる (⌘G / Ctrl+G)。何もないところからドラッグして囲んで選んでから' },
    { item: 'tag-add', label: 'タグ追加', icon: 'tag', title: '選んだノードにタグを付ける。キーと値を入れる' },
    { item: 'tag-select', label: 'タグ選択', icon: 'tags', title: '選んだノードに、使っているタグから選んで付ける' },
    { item: 'details', label: '詳細表示', icon: 'details', title: '詳細の見せ方を選ぶ' },
    'separator',
    { item: 'undo', label: '戻る', icon: 'undo', title: '元に戻す (⌘Z / Ctrl+Z)' },
    { item: 'redo', label: '進む', icon: 'redo', title: 'やり直す (⌘⇧Z / Ctrl+Shift+Z)' },
    { item: 'fit', label: 'ズームリセット', icon: 'fit', title: '全体が収まる倍率に戻す' },
];

// 押された印を持つボタン (道具そのもの)。ほかのボタンは押すたびに 1 度働く
const TOOL_ITEMS: readonly ToolboxItem[] = ['select', 'hand'] satisfies readonly EditorTool[];

// 詳細の見せ方の選択肢の並び (隠すは、詳細の印を押したときだけ出す)
const DETAILS_OPTIONS: ReadonlyArray<{ mode: DisplayMode; label: string; title: string }> = [
    { mode: 'always', label: '常に表示', title: 'ノードの中に詳細を開いて出す' },
    { mode: 'hover', label: 'ホバー時に表示', title: 'ノードにポインタを乗せると吹き出しで出す' },
    { mode: 'click', label: '隠す', title: '詳細の印 (i) を押したときだけ吹き出しで出す' },
];

// ポインタで開いた選択肢が、ボタンと選択肢から離れてから閉じるまでの待ち (ミリ秒)
const FLYOUT_CLOSE_DELAY = 300;

// 選択肢の開き方。hover はポインタを乗せて開いた、pinned は押して開いた
type FlyoutState = 'closed' | 'hover' | 'pinned';

export class Toolbox {
    readonly element: HTMLDivElement;
    private readonly buttons = new Map<ToolboxItem, HTMLButtonElement>();
    private readonly flyout: HTMLDivElement;
    private readonly options = new Map<DisplayMode, HTMLButtonElement>();
    private flyoutState: FlyoutState = 'closed';
    private closeTimer = 0;

    constructor(onPress: (item: ToolboxItem) => void, onDetailsMode: (mode: DisplayMode) => void) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-toolbox';
        this.element.setAttribute('role', 'toolbar');
        this.element.setAttribute('aria-orientation', 'vertical');
        this.element.setAttribute('aria-label', '道具');
        for (const entry of LAYOUT) {
            if (entry === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'mdag-editor-toolbox-sep';
                separator.setAttribute('role', 'separator');
                this.element.append(separator);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'mdag-editor-tool';
            button.dataset.tool = entry.item;
            button.title = entry.title;
            if (TOOL_ITEMS.includes(entry.item)) button.setAttribute('aria-pressed', 'false');
            const label = document.createElement('span');
            label.textContent = entry.label;
            button.append(createIcon(entry.icon), label);
            if (entry.item === 'details') this.listenDetailsButton(button);
            button.addEventListener('click', () => onPress(entry.item));
            this.element.append(button);
            this.buttons.set(entry.item, button);
        }
        this.flyout = this.createFlyout(onDetailsMode);
        this.element.append(this.flyout);
    }

    // 今の道具のボタンを押された印にする
    showTool(tool: ToolState): void {
        for (const item of TOOL_ITEMS) this.buttons.get(item)?.setAttribute('aria-pressed', String(item === tool));
    }

    showHistory(canUndo: boolean, canRedo: boolean): void {
        const undo = this.buttons.get('undo');
        const redo = this.buttons.get('redo');
        if (undo) undo.disabled = !canUndo;
        if (redo) redo.disabled = !canRedo;
    }

    // 詳細の見せ方の選択肢のうち、今の見せ方に印を付ける
    showDetailsMode(mode: DisplayMode): void {
        for (const [option, button] of this.options) button.setAttribute('aria-checked', String(option === mode));
    }

    get flyoutOpen(): boolean {
        return this.flyoutState !== 'closed';
    }

    // 選択肢か、それを開く「詳細表示」のボタンの中の要素か
    flyoutContains(target: EventTarget | null): boolean {
        if (!(target instanceof Node)) return false;
        return this.flyout.contains(target) || (this.buttons.get('details')?.contains(target) ?? false);
    }

    closeFlyout(): void {
        window.clearTimeout(this.closeTimer);
        if (this.flyoutState === 'closed') return;
        this.flyoutState = 'closed';
        this.flyout.hidden = true;
        this.buttons.get('details')?.setAttribute('aria-expanded', 'false');
    }

    private createFlyout(onDetailsMode: (mode: DisplayMode) => void): HTMLDivElement {
        const flyout = document.createElement('div');
        flyout.className = 'mdag-editor-flyout';
        flyout.setAttribute('role', 'menu');
        flyout.setAttribute('aria-label', '詳細の見せ方');
        flyout.hidden = true;
        for (const entry of DETAILS_OPTIONS) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'mdag-editor-flyout-item';
            option.dataset.details = entry.mode;
            option.title = entry.title;
            option.setAttribute('role', 'menuitemradio');
            option.setAttribute('aria-checked', 'false');
            option.textContent = entry.label;
            option.addEventListener('click', () => {
                this.closeFlyout();
                onDetailsMode(entry.mode);
            });
            flyout.append(option);
            this.options.set(entry.mode, option);
        }
        flyout.addEventListener('pointerenter', () => window.clearTimeout(this.closeTimer));
        flyout.addEventListener('pointerleave', () => this.scheduleClose());
        return flyout;
    }

    // 「詳細表示」のボタン: ポインタを乗せたら開き (指は除く)、離れたら閉じる予約をする。押したら、押して開いたものなら閉じ、そうでなければ開いたままにする
    private listenDetailsButton(button: HTMLButtonElement): void {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            window.clearTimeout(this.closeTimer);
            if (this.flyoutState === 'closed') this.openFlyout('hover');
        });
        button.addEventListener('pointerleave', () => this.scheduleClose());
        button.addEventListener('click', () => {
            if (this.flyoutState === 'pinned') this.closeFlyout();
            else this.openFlyout('pinned');
        });
    }

    // 選択肢を「詳細表示」のボタンの右に、ボタンの上の辺にそろえて開く
    private openFlyout(state: Exclude<FlyoutState, 'closed'>): void {
        window.clearTimeout(this.closeTimer);
        const button = this.buttons.get('details');
        this.flyoutState = state;
        this.flyout.style.top = `${button?.offsetTop ?? 0}px`;
        this.flyout.hidden = false;
        button?.setAttribute('aria-expanded', 'true');
    }

    // ポインタで開いた選択肢だけ、少し待ってから閉じる (その間にボタンか選択肢へ戻れば閉じない)
    private scheduleClose(): void {
        if (this.flyoutState !== 'hover') return;
        window.clearTimeout(this.closeTimer);
        this.closeTimer = window.setTimeout(() => {
            if (this.flyoutState === 'hover') this.closeFlyout();
        }, FLYOUT_CLOSE_DELAY);
    }
}

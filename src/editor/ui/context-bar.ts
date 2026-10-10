// 選んだノードかグループの近くに出す操作の帯。1 つのノードなら 名前、子の追加、兄弟追加、詳細編集、タグ追加、タグ選択、タスク化、(区切り)、削除、
// 2 つ以上なら 選んだ数、合流ノードを作る、既存のノードへ合流、グループ、タグ追加、タグ選択、タスク化、(区切り)、削除、
// グループなら グループの名前、名前、グループ解除 を並べる。
// ルートには兄弟追加と削除を出さない。1 つのノードのボタンは、原文の事実 (inspectNode の can*) で押せるかを決め、事実がなければどれも押せない。
// タスク化のボタンは、呼ぶ側が渡す状態で名前と絵を「タスク化」と「タスク解除」に替える (1 つでも 2 つ以上でも)。書き換えられるノードがなければ
// 無効の見た目にするが、ほかの押せないボタンと違って押せる (押したら呼ぶ側が書き換えずに理由を知らせる。GUI だけで操作する人に理由を見せるため)。
// 名前が替わってもボタンの幅は変えない (今でない名前を見えない字で同じ所に重ね、2 つの長いほうの幅にする)。
// 押されたボタンを知らせるだけで、操作はしない。帯を図のどこに置くかと、押したあとのフォーカスの戻し先は呼ぶ側が決める
import type { InspectNodeResult } from '../../core';
import { createIcon, type IconName } from './icons';

export type BarCommand = 'rename' | 'child' | 'sibling' | 'details' | 'tag-add' | 'tag-select' | 'task' | 'delete' | 'join-new' | 'join-existing' | 'group' | 'rename-group' | 'ungroup';

// タスク化のボタンの状態。name は名前と絵 (add はタスク化、remove はタスク解除)。enabled は書き換えられるノード
// (タスクにできて読み取りだけのグループに入らない) を選んでいるか (偽なら無効の見た目)
export interface BarTask {
    name: 'add' | 'remove';
    enabled: boolean;
}

// 帯に出すもの。node の facts は選んだノードの原文の事実 (図と原文が合っていなければ null)。group の label はグループの表示の名前
type BarContent = { for: 'node'; root: boolean; facts: InspectNodeResult | null; task: BarTask } | { for: 'nodes'; count: number; task: BarTask } | { for: 'group'; label: string };

type CanFact = 'canRename' | 'canAddChild' | 'canAddSibling' | 'canHaveDetails' | 'canMark' | 'canDelete';

interface BarButton {
    command: BarCommand;
    label: string;
    icon: IconName;
    title: string;
    // 1 つのノードの帯で、押せるかを決める原文の事実
    can?: CanFact;
    // ルートの帯には出さない
    notForRoot?: boolean;
    // タスク化のボタンの名前の状態 (ほかのボタンにはない)
    task?: BarTask['name'];
}

// 並びの順。separator は区切り、task はタスク化のボタン (名前と絵は状態で替わる)
type LayoutEntry = BarButton | 'separator' | 'task';

const NODE_LAYOUT: readonly LayoutEntry[] = [
    { command: 'rename', label: '名前', icon: 'rename', title: '名前を変える', can: 'canRename' },
    { command: 'child', label: '子の追加', icon: 'child', title: '子を足す', can: 'canAddChild' },
    { command: 'sibling', label: '兄弟追加', icon: 'sibling', title: '兄弟を足す', can: 'canAddSibling', notForRoot: true },
    { command: 'details', label: '詳細編集', icon: 'detailsEdit', title: '詳細を書く', can: 'canHaveDetails' },
    { command: 'tag-add', label: 'タグ追加', icon: 'tag', title: 'タグを付ける。キーと値を入れる', can: 'canMark' },
    { command: 'tag-select', label: 'タグ選択', icon: 'tags', title: '使っているタグから選んで付ける', can: 'canMark' },
    'task',
    'separator',
    { command: 'delete', label: '削除', icon: 'trash', title: '配下ごと消す', can: 'canDelete', notForRoot: true },
];

const NODES_LAYOUT: readonly LayoutEntry[] = [
    { command: 'join-new', label: '合流ノードを作る', icon: 'merge', title: '選んだノードから、新しいノードへ合流させる' },
    { command: 'join-existing', label: '既存のノードへ合流', icon: 'join', title: '選んだノードから、次にクリックするノードへ合流させる' },
    { command: 'group', label: 'グループ', icon: 'group', title: '選んだノードをグループにまとめる (⌘G / Ctrl+G)' },
    { command: 'tag-add', label: 'タグ追加', icon: 'tag', title: '選んだノードにタグを付ける' },
    { command: 'tag-select', label: 'タグ選択', icon: 'tags', title: '選んだノードに、使っているタグから選んで付ける' },
    'task',
    'separator',
    { command: 'delete', label: '削除', icon: 'trash', title: '選んだノードを配下ごと消す' },
];

const GROUP_LAYOUT: readonly LayoutEntry[] = [
    { command: 'rename-group', label: '名前', icon: 'rename', title: 'グループの名前を変える (Enter / 枠のラベルのダブルクリック)' },
    { command: 'ungroup', label: 'グループ解除', icon: 'ungroup', title: '枠と印を外す (ノードは残る)' },
];

// タスク化のボタンの、状態ごとの名前と絵 (1 つのノードの帯と 2 つ以上の帯)
const TASK_BUTTONS: Record<'node' | 'nodes', Record<'add' | 'remove', BarButton>> = {
    node: {
        add: { command: 'task', label: 'タスク化', icon: 'task', title: 'タスクにする (X)', task: 'add' },
        remove: { command: 'task', label: 'タスク解除', icon: 'untask', title: 'タスクの印を外す (X)', task: 'remove' },
    },
    nodes: {
        add: { command: 'task', label: 'タスク化', icon: 'task', title: '選んだノードをタスクにする (X)', task: 'add' },
        remove: { command: 'task', label: 'タスク解除', icon: 'untask', title: '選んだノードのタスクの印を外す (X)', task: 'remove' },
    },
};

const ARIA_LABEL: Record<BarContent['for'], string> = { node: '選んだノードの操作', nodes: '選んだノードの操作', group: '選んだグループの操作' };

export class ContextBar {
    readonly element: HTMLDivElement;
    // 今の中身 (並び、押せるか、名前)。同じ中身では組み直さない (押している途中のボタンを消さないため)
    private shown = '';

    constructor(private readonly onCommand: (command: BarCommand) => void) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-bar';
        this.element.setAttribute('role', 'toolbar');
        this.element.setAttribute('aria-label', ARIA_LABEL.node);
    }

    // 中身を組み直す (前と同じ中身なら何もしない)
    show(content: BarContent): void {
        const layout = (content.for === 'node' ? NODE_LAYOUT : content.for === 'nodes' ? NODES_LAYOUT : GROUP_LAYOUT).flatMap((entry): Array<BarButton | 'separator'> => {
            if (entry === 'separator') return [entry];
            if (entry === 'task') return content.for === 'group' ? [] : [TASK_BUTTONS[content.for][content.task.name]];
            return content.for === 'node' && content.root && entry.notForRoot ? [] : [entry];
        });
        const enabled = (entry: BarButton): boolean => {
            if (entry.task !== undefined) return content.for !== 'group' && content.task.enabled;
            return content.for !== 'node' || (entry.can !== undefined && content.facts !== null && content.facts[entry.can]);
        };
        // 先頭の欄 (2 つ以上なら選んだ数、グループなら名前)
        const heading = content.for === 'nodes' ? `${content.count} 個を選択` : content.for === 'group' ? `グループ「${content.label}」` : null;
        const key = [content.for, heading ?? '', ...layout.map((entry) => (entry === 'separator' ? '|' : `${entry.command}:${enabled(entry)}:${entry.label}`))].join(' ');
        if (key === this.shown) return;
        this.shown = key;
        this.element.dataset.for = content.for;
        this.element.setAttribute('aria-label', ARIA_LABEL[content.for]);
        const items: HTMLElement[] = [];
        if (heading !== null) {
            const title = document.createElement('span');
            title.className = 'mdag-editor-bar-title';
            title.textContent = heading;
            items.push(title);
        }
        // 区切りは、あとにボタンが続くときだけ置く
        for (const [index, entry] of layout.entries()) {
            if (entry === 'separator') {
                if (index < layout.length - 1) items.push(this.separator());
                continue;
            }
            items.push(this.button(entry, enabled(entry)));
        }
        this.element.replaceChildren(...items);
    }

    private button(entry: BarButton, enabled: boolean): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mdag-editor-bar-button';
        button.dataset.command = entry.command;
        button.title = entry.title;
        // タスク化のボタンは無効でも押下を受ける (disabled は押下を受けないので、無効は aria-disabled で示す)
        if (entry.task === undefined) button.disabled = !enabled;
        else if (!enabled) button.setAttribute('aria-disabled', 'true');
        const label = document.createElement('span');
        if (entry.task !== undefined) {
            // 今の名前の字に、もう一方の名前を見えない字で重ねる (幅は見た目の側が 2 つの長いほうにそろえる)
            const shown = document.createElement('span');
            shown.textContent = entry.label;
            label.append(shown);
            label.dataset.other = TASK_BUTTONS.node[entry.task === 'add' ? 'remove' : 'add'].label;
            button.dataset.task = entry.task;
        } else label.textContent = entry.label;
        button.append(createIcon(entry.icon), label);
        button.addEventListener('click', () => this.onCommand(entry.command));
        return button;
    }

    private separator(): HTMLDivElement {
        const separator = document.createElement('div');
        separator.className = 'mdag-editor-bar-sep';
        separator.setAttribute('role', 'separator');
        separator.setAttribute('aria-orientation', 'vertical');
        return separator;
    }
}

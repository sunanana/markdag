// 凡例のパネル (線の色・グループ)。見出しと、線の色の段 (枝の起点ごとの線の見本と名前。読み取り専用)、グループの段 (色の四角、ロゴ、名前、
// 入っているノードの数、操作ボタン) を組み立てる。出す段と行の中身、開閉、選んだ行は呼ぶ側が決め、ロゴは図の側から引く。
// 閲覧では見出しに開閉と「新規」のボタンを出さず、行に操作ボタンを置かず、押しても何も知らせない (中身はいつも出したまま)。
// GUI 編集では見出しの押下 (開閉)、見出しの「新規」、行の押下、行のダブルクリック、色の四角、操作ボタン (+、目、ごみ箱) を知らせる。
// 操作ボタンは、ポインタを乗せた行と選んだ行と、枠を隠しているグループの目だけを見せる (見せ方は見た目の側)。+ はノードを選んでいるときだけ押せる。
// 行の中にグループの名前の入力を置ける。置いている間は行を組み直さず (入力を DOM の中で動かすとフォーカスが外れて決まってしまうため)、
// 外したあとに、その間に頼まれた組み直しをまとめて行う。中身が前と同じなら組み直さない (押している途中の行とボタンを替えない)
import type { BranchColor } from '../../core';
import type { LegendContent, LegendGroupRow } from '../legend';
import type { EditorMode } from '../settings';
import { createIcon, SVG_NS } from './icons';

export type LegendAction = 'add' | 'boundary' | 'delete';

interface LegendPanelHandlers {
    // 見出し (「新規」でない所) の押下
    onToggle(): void;
    onNew(): void;
    onRowPress(id: string): void;
    onRowDoubleClick(id: string): void;
    // 色の四角の押下。chip はピッカーを開く相手
    onChip(id: string, chip: HTMLElement): void;
    onAction(id: string, action: LegendAction): void;
}

// グループの行の、あとから変える部品
interface GroupRowParts {
    element: HTMLDivElement;
    name: HTMLSpanElement;
    chip: HTMLElement;
    logo: Element | null;
    add: HTMLButtonElement | null;
}

const TITLE = '線の色・グループ';
const BRANCH_CAPTION = '線の色 = 出発ノードの枝の色';
const GROUP_CAPTION = 'グループ';

const ACTIONS: ReadonlyArray<{ action: LegendAction; title: string }> = [
    { action: 'add', title: '選んだノードをこのグループに入れる' },
    { action: 'boundary', title: '' },
    { action: 'delete', title: 'グループを解除する (枠と印を外す。ノードは残る)' },
];

export class LegendPanel {
    readonly element: HTMLDivElement;
    private readonly newButton: HTMLButtonElement;
    private readonly toggle: HTMLButtonElement;
    private readonly body: HTMLDivElement;
    private readonly rows = new Map<string, GroupRowParts>();
    // 組み立てた中身 (モードとロゴを含む。同じなら組み直さない) と、そのモード
    private builtKey = '';
    private built: { content: LegendContent | null; mode: EditorMode } = { content: null, mode: 'view' };
    // GUI 編集の開閉 (閲覧では中身を出したまま)
    private open = true;
    // 選んでいるグループ (2 つ以上なら全部) と、+ を押せるか
    private selected: readonly string[] = [];
    private canAdd = false;
    // 行の中に置いた要素と、置いている間に頼まれた組み直し
    private hosted: HTMLElement | null = null;
    private pending: { content: LegendContent | null; mode: EditorMode } | null = null;

    constructor(
        private readonly handlers: LegendPanelHandlers,
        private readonly logoOf: (id: string) => Element | null,
    ) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-legend';
        this.element.setAttribute('role', 'region');
        this.element.setAttribute('aria-label', TITLE);
        this.element.hidden = true;

        const head = document.createElement('div');
        head.className = 'mdag-editor-legend-head';
        const title = document.createElement('span');
        title.className = 'mdag-editor-legend-title';
        title.textContent = TITLE;
        this.newButton = document.createElement('button');
        this.newButton.type = 'button';
        this.newButton.className = 'mdag-editor-legend-new';
        this.newButton.title = '選んだノードをグループにまとめる。選んでいなければ、ノードのいないグループを作る';
        const newLabel = document.createElement('span');
        newLabel.textContent = '新規';
        this.newButton.append(createIcon('plus'), newLabel);
        this.toggle = document.createElement('button');
        this.toggle.type = 'button';
        this.toggle.className = 'mdag-editor-legend-toggle';
        this.toggle.title = '開く / 閉じる';
        this.toggle.setAttribute('aria-label', `${TITLE}を開く / 閉じる`);
        this.toggle.append(createIcon('chevronDown'));
        head.append(title, this.newButton, this.toggle);

        this.body = document.createElement('div');
        this.body.className = 'mdag-editor-legend-body';
        this.element.append(head, this.body);
        this.element.addEventListener('click', (event) => this.click(event));
        this.element.addEventListener('dblclick', (event) => this.doubleClick(event));
    }

    // 中身とモードと開閉を出す。content が null ならパネルを隠す。行の中に要素を置いている間は、外したあとに組み直す
    show(content: LegendContent | null, mode: EditorMode, open: boolean): void {
        this.open = open;
        if (this.hosted !== null) {
            this.pending = { content, mode };
            this.applyOpen();
            return;
        }
        this.build(content, mode);
    }

    setOpen(open: boolean): void {
        this.open = open;
        this.applyOpen();
    }

    // 選んでいるグループ (2 つ以上なら全部) の行に印を付け (GUI 編集のときだけ)、+ を押せるかを合わせる
    showSelection(groups: readonly string[], canAdd: boolean): void {
        this.selected = [...groups];
        this.canAdd = canAdd;
        this.applySelection();
    }

    // ロゴを図の側から引き直して差し替える (ロゴの SVG があとから届いたとき)。行は組み直さない
    refreshLogos(): void {
        for (const [id, parts] of this.rows) {
            const logo = this.logoOf(id);
            if (parts.logo !== null && logo !== null) parts.logo.replaceWith(logo);
            else if (parts.logo !== null) parts.logo.remove();
            else if (logo !== null) parts.chip.after(logo);
            parts.logo = logo;
        }
        this.builtKey = this.keyOf(this.built.content, this.built.mode, [...this.rows.values()].map((parts) => parts.logo));
    }

    // グループの行の中に要素 (グループの名前の入力) を置き、名前を隠す。行がなければ置かずに null。戻り値で外す
    host(id: string, element: HTMLElement): (() => void) | null {
        const parts = this.rows.get(id);
        if (!parts) return null;
        this.hosted?.remove();
        parts.name.hidden = true;
        parts.name.after(element);
        this.hosted = element;
        this.reveal(parts.element);
        return () => {
            if (this.hosted !== element) return;
            this.hosted = null;
            element.remove();
            parts.name.hidden = false;
            const pending = this.pending;
            this.pending = null;
            if (pending) this.build(pending.content, pending.mode);
        };
    }

    private build(content: LegendContent | null, mode: EditorMode): void {
        const logos = content?.groups.map((group) => this.logoOf(group.id)) ?? [];
        const key = this.keyOf(content, mode, logos);
        this.built = { content, mode };
        if (key !== this.builtKey) {
            this.builtKey = key;
            this.rows.clear();
            const editing = mode === 'edit';
            this.newButton.hidden = !editing;
            this.toggle.hidden = !editing;
            this.element.hidden = content === null;
            const sections: HTMLElement[] = [];
            for (const section of content?.sections ?? []) {
                if (section === 'branches') sections.push(this.branchSection(content?.branches ?? [], content?.branchGuide ?? false));
                else sections.push(this.groupSection(content?.groups ?? [], logos, editing));
            }
            this.body.replaceChildren(...sections);
        }
        this.applyOpen();
        this.applySelection();
    }

    private keyOf(content: LegendContent | null, mode: EditorMode, logos: ReadonlyArray<Element | null>): string {
        return JSON.stringify([content, mode, logos.map((logo) => logo?.outerHTML ?? null)]);
    }

    private applyOpen(): void {
        const shown = this.built.mode === 'view' || this.open;
        this.element.toggleAttribute('data-open', shown);
        this.toggle.setAttribute('aria-expanded', String(shown));
    }

    private applySelection(): void {
        const editing = this.built.mode === 'edit';
        for (const [id, parts] of this.rows) {
            parts.element.toggleAttribute('data-selected', editing && this.selected.includes(id));
            if (parts.add) parts.add.disabled = !this.canAdd;
        }
    }

    private branchSection(branches: readonly BranchColor[], guide: boolean): HTMLElement {
        const section = this.section('branches', BRANCH_CAPTION);
        for (const branch of branches) {
            const row = document.createElement('div');
            row.className = 'mdag-editor-legend-row';
            const sample = document.createElementNS(SVG_NS, 'svg');
            sample.setAttribute('class', 'mdag-editor-legend-line');
            sample.setAttribute('viewBox', '0 0 28 10');
            sample.setAttribute('aria-hidden', 'true');
            const line = document.createElementNS(SVG_NS, 'line');
            for (const [name, value] of Object.entries({ x1: '1', y1: '5', x2: '27', y2: '5' })) line.setAttribute(name, value);
            line.style.stroke = branch.color;
            sample.append(line);
            row.append(sample, this.nameOf(branch.label));
            section.append(row);
        }
        if (guide) {
            const note = document.createElement('div');
            note.className = 'mdag-editor-legend-guide';
            const key = document.createElement('code');
            key.textContent = 'markdag.branches';
            note.append(key, ' に枝の起点のノードを書くと、枝ごとの線の色がここに出ます');
            section.append(note);
        }
        return section;
    }

    private groupSection(groups: readonly LegendGroupRow[], logos: ReadonlyArray<Element | null>, editing: boolean): HTMLElement {
        const section = this.section('groups', GROUP_CAPTION);
        for (const [index, group] of groups.entries()) {
            const row = document.createElement('div');
            row.className = 'mdag-editor-legend-row';
            row.dataset.group = group.id;
            const chip = document.createElement(editing ? 'button' : 'span');
            chip.className = 'mdag-editor-legend-chip';
            chip.style.background = group.color ?? 'transparent';
            if (chip instanceof HTMLButtonElement) {
                chip.type = 'button';
                chip.title = '色を変える';
                chip.setAttribute('aria-label', `${group.label}の色を変える`);
            }
            const logo = logos[index] ?? null;
            const name = this.nameOf(group.label);
            const count = document.createElement('span');
            count.className = 'mdag-editor-legend-count';
            count.title = '入っているノードの数';
            count.textContent = String(group.count);
            row.append(chip, ...(logo ? [logo] : []), name, count);
            let add: HTMLButtonElement | null = null;
            if (editing) {
                for (const { action, title } of ACTIONS) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'mdag-editor-legend-action';
                    button.dataset.action = action;
                    if (action === 'boundary') {
                        button.title = group.boundary ? '枠を隠す' : '枠を出す';
                        button.setAttribute('aria-pressed', String(group.boundary));
                        button.append(createIcon(group.boundary ? 'eye' : 'eyeOff'));
                    } else {
                        button.title = title;
                        button.append(createIcon(action === 'add' ? 'plus' : 'trash'));
                    }
                    button.setAttribute('aria-label', button.title);
                    if (action === 'add') add = button;
                    row.append(button);
                }
            }
            section.append(row);
            this.rows.set(group.id, { element: row, name, chip, logo, add });
        }
        return section;
    }

    private section(kind: 'branches' | 'groups', caption: string): HTMLDivElement {
        const section = document.createElement('div');
        section.className = 'mdag-editor-legend-section';
        section.dataset.section = kind;
        const head = document.createElement('div');
        head.className = 'mdag-editor-legend-caption';
        head.textContent = caption;
        section.append(head);
        return section;
    }

    private nameOf(label: string): HTMLSpanElement {
        const name = document.createElement('span');
        name.className = 'mdag-editor-legend-name';
        name.textContent = label;
        name.title = label;
        return name;
    }

    // 行がパネルの中のスクロールで隠れていたら、見える所までスクロールする (図の領域とページは動かさない)
    private reveal(row: HTMLElement): void {
        const area = this.body.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        if (rect.top < area.top) this.body.scrollTop -= area.top - rect.top;
        else if (rect.bottom > area.bottom) this.body.scrollTop += rect.bottom - area.bottom;
    }

    private click(event: MouseEvent): void {
        const target = event.target;
        if (this.built.mode !== 'edit' || !(target instanceof Element) || this.hosted?.contains(target)) return;
        if (target.closest('.mdag-editor-legend-new')) {
            this.handlers.onNew();
            return;
        }
        if (target.closest('.mdag-editor-legend-head')) {
            this.handlers.onToggle();
            return;
        }
        const id = this.groupOf(target);
        if (id === null) return;
        const action = target.closest<HTMLButtonElement>('.mdag-editor-legend-action');
        if (action) {
            if (!action.disabled) this.handlers.onAction(id, action.dataset.action as LegendAction);
            return;
        }
        const chip = target.closest<HTMLElement>('.mdag-editor-legend-chip');
        if (chip) this.handlers.onChip(id, chip);
        else this.handlers.onRowPress(id);
    }

    private doubleClick(event: MouseEvent): void {
        const target = event.target;
        if (this.built.mode !== 'edit' || !(target instanceof Element) || this.hosted?.contains(target)) return;
        if (target.closest('.mdag-editor-legend-action, .mdag-editor-legend-chip')) return;
        const id = this.groupOf(target);
        if (id !== null) this.handlers.onRowDoubleClick(id);
    }

    // 押した要素のあるグループの行のグループ
    private groupOf(target: Element): string | null {
        const row = target.closest<HTMLElement>('.mdag-editor-legend-row[data-group]');
        return row !== null && this.body.contains(row) ? (row.dataset.group ?? null) : null;
    }
}

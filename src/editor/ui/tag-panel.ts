// タグのパネル (タグ追加とタグ選択)。1 つの要素を使い回し、開いている種類を data-panel で示す。図に重ねる位置と、付ける・外す書き換えは呼ぶ側が受け持つ。
// タグ追加: キーと値の欄 (キーの欄に候補の一覧)、送るボタン (新規は「追加」、付いているタグの編集は「更新」と「新規に戻る」)、選んだノードに付いているタグの行。
// 行を押すとそのタグの編集にし、行の × でそのキーのタグを外すことを知らせる。Enter (キーの欄でも値の欄でも) と送るボタンで、入れたキーと値を知らせる。
// タグ選択: 絞り込みの欄、最近使ったタグの行、区切り線、登録されているタグの行。行を押すと付け外しを知らせ、絞り込みは入れた文字で行を減らすだけ。
// 行は data-key、data-value (値のないタグは付けない)、data-state (選んだノードの全部に付いている all、一部 some、どれにもない none) を持つ。
// Esc は閉じることを知らせる。変換中 (IME) のキー (isComposing が true か keyCode が 229) は欄に任せる。Tab はブラウザの既定のまま (パネルの中の欄とボタンを動く)。
// ボタンと行を押してもフォーカスを動かさない (欄に残す)
import { isComposingKey } from '../keys';
import { filterTags, tagText, type TagChoice, type TagState } from '../tags';

export type TagPanelKind = 'add' | 'select';

export interface TagRow extends TagChoice {
    state: TagState;
}

// キーの欄の候補の 1 つ
interface TagKeyOption {
    key: string;
    description: string | null;
}

// パネルに出す中身。タグ追加は attached と keys、タグ選択は recent と registered を使う
export interface TagPanelContent {
    attached: readonly TagRow[];
    recent: readonly TagRow[];
    registered: readonly TagRow[];
    keys: readonly TagKeyOption[];
}

interface TagPanelHandlers {
    // タグ追加で送った。editing は編集していたタグ (新規なら null)
    onSubmit(key: string, value: string, editing: TagChoice | null): void;
    // 付いているタグの行の × (そのキーのタグを外す)
    onRemove(tag: TagChoice): void;
    // タグ選択の行 (付け外し)
    onToggle(row: TagRow): void;
    // Esc
    onClose(): void;
    // Esc で閉じるとき、keydown を図へ伝えないか (伝えなければ、図の Esc は吹き出しを閉じない)
    holdsEscape(): boolean;
}

interface TagPanelKey {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    keyCode: number;
}

type TagPanelAction = 'submit' | 'close';

// パネルの中のキーを操作にする。操作にならないキー (文字、Tab、矢印、変換中のキーなど) は null。Enter は修飾キーのないときだけ
export function tagPanelAction(input: TagPanelKey): TagPanelAction | null {
    if (isComposingKey(input)) return null;
    if (input.metaKey || input.ctrlKey || input.altKey) return null;
    if (input.key === 'Escape') return 'close';
    if (input.key === 'Enter' && !input.shiftKey) return 'submit';
    return null;
}

const STATE_LABEL: Record<TagState, string> = { all: '選んだノードの全部に付いている', some: '選んだノードの一部に付いている', none: '付いていない' };
const ARIA_CHECKED: Record<TagState, string> = { all: 'true', some: 'mixed', none: 'false' };

// キーの欄の候補の一覧の id を、ページの中で重ならないようにする連番
let listSerial = 0;

function textField(field: 'key' | 'value', placeholder: string, label: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.field = field;
    input.className = 'mdag-editor-tag-field';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    return input;
}

function actionButton(action: 'add' | 'update' | 'new', label: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mdag-editor-tag-button';
    button.dataset.action = action;
    button.title = title;
    button.textContent = label;
    return button;
}

function block(className: string, text?: string): HTMLDivElement {
    const element = document.createElement('div');
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

// 行の中身の比べ方 (同じなら組み直さない。押している途中の行を消さない)
function rowsKey(rows: readonly TagRow[]): string {
    return JSON.stringify(rows.map((row) => [row.key, row.value, row.state]));
}

export class TagPanel {
    readonly element: HTMLDivElement;
    private readonly keyField: HTMLInputElement;
    private readonly valueField: HTMLInputElement;
    private readonly keyList: HTMLDataListElement;
    private readonly addButton: HTMLButtonElement;
    private readonly updateButton: HTMLButtonElement;
    private readonly newButton: HTMLButtonElement;
    private readonly actions: HTMLDivElement;
    private readonly form: HTMLDivElement;
    private readonly attachedBody: HTMLDivElement;
    private readonly filter: HTMLInputElement;
    private readonly selectBody: HTMLDivElement;
    private opened: TagPanelKind | null = null;
    // 編集している付いているタグ (新規の入力なら null)
    private editingTag: TagChoice | null = null;
    private content: TagPanelContent = { attached: [], recent: [], registered: [], keys: [] };
    // 今描いている行と候補 (同じなら組み直さない)
    private drawn = '';

    constructor(private readonly handlers: TagPanelHandlers) {
        const element = document.createElement('div');
        element.className = 'mdag-editor-tag-panel';
        element.setAttribute('role', 'dialog');

        this.keyField = textField('key', 'キー', 'タグのキー');
        this.valueField = textField('value', '値 (なくてもよい)', 'タグの値');
        this.keyList = document.createElement('datalist');
        listSerial += 1;
        this.keyList.id = `mdag-editor-tag-keys-${listSerial}`;
        this.keyField.setAttribute('list', this.keyList.id);
        const colon = document.createElement('span');
        colon.className = 'mdag-editor-tag-colon';
        colon.textContent = ':';
        const fields = block('mdag-editor-tag-fields');
        fields.append(this.keyField, colon, this.valueField, this.keyList);
        this.addButton = actionButton('add', '追加', '選んだノードにタグを付ける (Enter)');
        this.updateButton = actionButton('update', '更新', '編集しているタグを書き換える (Enter)。キーを変えると、もとのキーのタグは外れる');
        this.newButton = actionButton('new', '新規に戻る', '編集をやめて、新しいタグの入力に戻る');
        this.addButton.addEventListener('click', () => this.submit());
        this.updateButton.addEventListener('click', () => this.submit());
        this.newButton.addEventListener('click', () => {
            if (this.opened === 'add') this.startNew();
        });
        this.actions = block('mdag-editor-tag-actions');
        this.form = block('mdag-editor-tag-form');
        this.form.append(fields, this.actions);
        this.attachedBody = block('mdag-editor-tag-body');

        this.filter = document.createElement('input');
        this.filter.type = 'text';
        this.filter.className = 'mdag-editor-tag-filter';
        this.filter.autocomplete = 'off';
        this.filter.spellcheck = false;
        this.filter.placeholder = '絞り込み';
        this.filter.setAttribute('aria-label', 'タグの絞り込み');
        this.filter.addEventListener('input', () => this.drawRows(true));
        this.selectBody = block('mdag-editor-tag-body');

        element.addEventListener('keydown', (event) => {
            if (this.opened === null) return;
            const action = tagPanelAction(event);
            if (action === null) return;
            if (action === 'close') {
                event.preventDefault();
                if (handlers.holdsEscape()) event.stopPropagation();
                handlers.onClose();
                return;
            }
            // Enter はタグ追加のキーと値の欄だけで送る (ボタンの Enter はボタンを押す。絞り込みの欄では何もしない)
            if (event.target === this.keyField || event.target === this.valueField) {
                event.preventDefault();
                this.submit();
            } else if (event.target === this.filter) event.preventDefault();
        });
        // 欄の外 (ボタン、行、余白) を押してもフォーカスを欄から動かさない
        element.addEventListener('mousedown', (event) => {
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        });
        element.addEventListener('click', (event) => this.pressRow(event));
        this.element = element;
    }

    // 開いている種類 (閉じていれば null)
    get kind(): TagPanelKind | null {
        return this.opened;
    }

    // 編集している付いているタグ (タグ追加の新規の入力と、タグ選択では null)
    get editing(): TagChoice | null {
        return this.opened === 'add' ? this.editingTag : null;
    }

    // パネルの中が今フォーカスを持っているか
    get focused(): boolean {
        const active = document.activeElement;
        return active instanceof Node && this.element.contains(active);
    }

    contains(target: EventTarget | null): boolean {
        return target instanceof Node && this.element.contains(target);
    }

    // 種類を替えて開く (要素は先に図へ重ねておく)。入力と絞り込みを空にし、editing を渡せばそのタグの編集にする。
    // フォーカスはタグ追加ならキーの欄、タグ選択なら絞り込みの欄に置く
    open(kind: TagPanelKind, content: TagPanelContent, editing: TagChoice | null = null): void {
        this.opened = kind;
        this.content = content;
        this.element.dataset.panel = kind;
        this.element.setAttribute('aria-label', kind === 'add' ? 'タグ追加' : 'タグ選択');
        this.filter.value = '';
        if (kind === 'add') this.element.replaceChildren(this.form, this.attachedBody);
        else this.element.replaceChildren(this.filter, this.selectBody);
        this.drawRows(true);
        if (kind === 'add' && editing !== null) this.edit(editing);
        else if (kind === 'add') this.startNew();
        else this.refocus();
    }

    // 中身 (行と候補) を差し替える。入力と絞り込みはそのまま
    show(content: TagPanelContent): void {
        this.content = content;
        this.drawRows(false);
    }

    // 付いているタグの編集にする (キーと値を入れ、送るボタンを「更新」と「新規に戻る」にして、キーの欄にフォーカス)
    edit(tag: TagChoice): void {
        if (this.opened !== 'add') return;
        this.editingTag = { key: tag.key, value: tag.value };
        this.keyField.value = tag.key;
        this.valueField.value = tag.value ?? '';
        this.actions.replaceChildren(this.newButton, this.updateButton);
        this.markEditing();
        this.focusField(this.keyField);
    }

    // 新規の入力に戻す (キーと値を空にし、送るボタンを「追加」にして、キーの欄にフォーカス)
    startNew(): void {
        if (this.opened !== 'add') return;
        this.editingTag = null;
        this.keyField.value = '';
        this.valueField.value = '';
        this.actions.replaceChildren(this.addButton);
        this.markEditing();
        this.focusField(this.keyField);
    }

    // フォーカスをパネルの欄に戻す (すでにパネルの欄にあればそのまま)。タグ追加はキーの欄、タグ選択は絞り込みの欄
    refocus(): void {
        if (this.opened === null || !this.element.isConnected) return;
        const active = document.activeElement;
        if (active === this.keyField || active === this.valueField || active === this.filter) return;
        this.focusField(this.opened === 'add' ? this.keyField : this.filter);
    }

    // 閉じたことにする (要素を図から外すのは呼ぶ側)
    close(): void {
        this.opened = null;
        this.editingTag = null;
        delete this.element.dataset.panel;
    }

    private focusField(field: HTMLInputElement): void {
        if (field.isConnected) field.focus({ preventScroll: true });
    }

    private submit(): void {
        if (this.opened !== 'add') return;
        this.handlers.onSubmit(this.keyField.value, this.valueField.value, this.editingTag);
    }

    // 行の押下。× は外す、それ以外 (行の文字と余白) はタグ追加なら編集、タグ選択なら付け外し
    private pressRow(event: MouseEvent): void {
        if (this.opened === null || !(event.target instanceof Element)) return;
        const rowElement = event.target.closest<HTMLElement>('.mdag-editor-tag-row');
        if (!rowElement || !this.element.contains(rowElement)) return;
        const row = this.rowOf(rowElement);
        if (!row) return;
        if (this.opened === 'select') {
            this.handlers.onToggle(row);
            return;
        }
        if (event.target.closest('[data-action="remove"]')) this.handlers.onRemove({ key: row.key, value: row.value });
        else this.edit(row);
    }

    // 行の要素が指すタグ (今の中身から引く)
    private rowOf(element: HTMLElement): TagRow | null {
        const key = element.dataset.key;
        const value = element.dataset.value ?? null;
        const rows = this.opened === 'add' ? this.content.attached : [...this.content.recent, ...this.content.registered];
        return rows.find((row) => row.key === key && row.value === value) ?? null;
    }

    // 行と候補を描く。force でなければ、前と同じ中身 (と絞り込み) なら組み直さない
    private drawRows(force: boolean): void {
        const filterText = this.filter.value;
        const key = JSON.stringify([this.opened, rowsKey(this.content.attached), rowsKey(this.content.recent), rowsKey(this.content.registered), this.content.keys, filterText]);
        if (!force && key === this.drawn) return;
        this.drawn = key;
        if (this.opened === 'add') this.drawAttached();
        else if (this.opened === 'select') this.drawSelect(filterText);
    }

    private drawAttached(): void {
        this.keyList.replaceChildren(
            ...this.content.keys.map((option) => {
                const item = document.createElement('option');
                item.value = option.key;
                if (option.description !== null) item.label = option.description;
                return item;
            }),
        );
        const rows = this.content.attached;
        if (rows.length === 0) {
            this.attachedBody.replaceChildren();
            return;
        }
        const list = block('mdag-editor-tag-list');
        list.append(...rows.map((row) => this.rowElement(row, true)));
        this.attachedBody.replaceChildren(block('mdag-editor-tag-caption', '付いているタグ (押すと編集)'), list);
        this.markEditing();
    }

    private drawSelect(filterText: string): void {
        const recent = filterTags(this.content.recent, filterText);
        const registered = filterTags(this.content.registered, filterText);
        const parts: HTMLElement[] = [];
        if (recent.length > 0) {
            const list = block('mdag-editor-tag-list');
            list.append(...recent.map((row) => this.rowElement(row, false)));
            parts.push(block('mdag-editor-tag-caption', '最近使ったタグ'), list);
        }
        if (registered.length > 0) {
            if (parts.length > 0) {
                const separator = block('mdag-editor-tag-sep');
                separator.setAttribute('role', 'separator');
                parts.push(separator);
            }
            const list = block('mdag-editor-tag-list');
            list.append(...registered.map((row) => this.rowElement(row, false)));
            parts.push(block('mdag-editor-tag-caption', '登録されているタグ'), list);
        }
        if (parts.length === 0) {
            const nothing = this.content.recent.length + this.content.registered.length === 0 ? 'まだタグがありません (タグ追加で付けられます)' : '当てはまるタグがありません';
            parts.push(block('mdag-editor-tag-empty', nothing));
        }
        this.selectBody.replaceChildren(...parts);
    }

    // 行の要素。removable なら × を付ける (タグ追加の付いているタグ)。タグ選択の行は付いている数の状態を aria-checked でも示す
    private rowElement(row: TagRow, removable: boolean): HTMLDivElement {
        const element = block('mdag-editor-tag-row');
        element.dataset.key = row.key;
        if (row.value !== null) element.dataset.value = row.value;
        element.dataset.state = row.state;
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'mdag-editor-tag-pick';
        pick.textContent = tagText(row);
        if (removable) {
            pick.title = row.state === 'some' ? `押すと編集 (${STATE_LABEL.some})` : '押すと編集';
        } else {
            pick.setAttribute('role', 'menuitemcheckbox');
            pick.setAttribute('aria-checked', ARIA_CHECKED[row.state]);
            pick.title = `${STATE_LABEL[row.state]} (押すたびに付け外し)`;
        }
        element.append(pick);
        if (removable) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'mdag-editor-tag-remove';
            remove.dataset.action = 'remove';
            remove.title = 'このキーのタグを、選んだノードから外す';
            remove.setAttribute('aria-label', '外す');
            remove.textContent = '×';
            element.append(remove);
        }
        return element;
    }

    // 編集している付いているタグの行に印を付ける
    private markEditing(): void {
        const editing = this.editingTag;
        for (const element of this.attachedBody.querySelectorAll<HTMLElement>('.mdag-editor-tag-row')) {
            const match = editing !== null && element.dataset.key === editing.key && (element.dataset.value ?? null) === editing.value;
            element.toggleAttribute('data-editing', match);
        }
    }
}

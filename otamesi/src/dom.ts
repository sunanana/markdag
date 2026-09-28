// 画面の部品。フレームワークは使わず、要素を作る関数と小さな部品だけを置く
import type { TaskState } from 'markdag';
import type { Priority } from './doc';

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string; dataset?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value === undefined || value === null || value === false) continue;
        if (name === 'dataset') Object.assign(element.dataset, value);
        else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
        else if (name === 'value' && 'value' in element) (element as HTMLInputElement).value = String(value);
        else if (value === true) element.setAttribute(name, '');
        else element.setAttribute(name, String(value));
    }
    append(element, children);
    return element;
}

function append(parent: Node, children: Child[]): void {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        if (Array.isArray(child)) append(parent, child);
        else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

export function svg(markup: string, className = 'icon'): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    span.innerHTML = markup;
    return span;
}

// ---- 記号 ----

const STATE_SVG: Record<TaskState, string> = {
    todo: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    doing: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor"/></svg>',
    done: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--on-accent)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    canceled: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--on-accent)" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

export const STATE_LABEL: Record<TaskState, string> = { todo: '未着手', doing: '進行中', done: '完了', canceled: '中止' };
export const PRIORITY_LABEL: Record<Priority, string> = { urgent: '緊急', high: '高', medium: '中', low: '低' };

export function stateIcon(state: TaskState): HTMLElement {
    return svg(STATE_SVG[state], `icon state-icon state-${state}`);
}

export function priorityIcon(priority: Priority | null): HTMLElement {
    if (priority === 'urgent') {
        return svg('<svg viewBox="0 0 16 16" width="16" height="16"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor"/><path d="M8 4.5v4.2M8 11v.3" stroke="var(--on-accent)" stroke-width="1.8" stroke-linecap="round"/></svg>', 'icon priority-icon priority-urgent');
    }
    const level = priority === 'high' ? 3 : priority === 'medium' ? 2 : priority === 'low' ? 1 : 0;
    const bars = [0, 1, 2]
        .map((index) => `<rect x="${2 + index * 4.5}" y="${10 - index * 3}" width="3" height="${4 + index * 3}" rx="1" fill="currentColor" opacity="${index < level ? 1 : 0.28}"/>`)
        .join('');
    return svg(`<svg viewBox="0 0 16 16" width="16" height="16">${bars}</svg>`, `icon priority-icon priority-${priority ?? 'none'}`);
}

const AVATAR_HUES = [236, 190, 28, 150, 350, 275, 48, 210];

export function avatar(name: string | null, size = 20): HTMLElement {
    if (!name) return h('span', { class: 'avatar avatar-empty', style: `--size:${size}px`, title: '担当なし' });
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const hue = AVATAR_HUES[hash % AVATAR_HUES.length];
    return h('span', { class: 'avatar', style: `--size:${size}px;--hue:${hue}`, title: name }, name.slice(0, 1).toUpperCase());
}

export const ICON = {
    plus: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    list: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    board: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="2.5" width="3.4" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    graph: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="3.5" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7.2l5.6-2.8M5.2 8.8l5.6 2.8" stroke="currentColor" stroke-width="1.4"/></svg>',
    markdown: '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 10.2V5.8l1.8 2 1.8-2v4.4M10.8 5.8v4.2M9.3 8.7l1.5 1.5 1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    blocked: '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4 12L12 4" stroke="currentColor" stroke-width="1.6"/></svg>',
    link: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M6.5 9.5l3-3M7 4.8l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    calendar: '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    flag: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 14V2.5M3.5 3h8l-1.8 3 1.8 3h-8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    undo: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M5.5 3.5L2.5 6.5l3 3M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    redo: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M10.5 3.5l3 3-3 3M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    moon: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
    reset: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 2l6.5 11.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5v3.2M8 11.6v.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
};

// ---- 選択メニュー ----

export interface MenuItem {
    label: string;
    icon?: HTMLElement;
    hint?: string;
    checked?: boolean;
    run: () => void;
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
    openMenu?.remove();
    openMenu = null;
}

// anchor の下に選択肢を出す。文字を打つと絞り込み、上下キーと Enter で選べる
export function showMenu(anchor: HTMLElement, items: MenuItem[], options: { filter?: boolean; placeholder?: string } = {}): void {
    closeMenu();
    let active = Math.max(
        0,
        items.findIndex((item) => item.checked),
    );
    let shown = items;
    const list = h('div', { class: 'menu-list', role: 'listbox' });
    const input = options.filter ? h('input', { class: 'menu-filter', placeholder: options.placeholder ?? '絞り込み…', 'aria-label': options.placeholder ?? '絞り込み' }) : null;
    const menu = h('div', { class: 'menu', role: 'menu' }, input, list);
    const draw = () => {
        list.replaceChildren(
            ...shown.map((item, index) =>
                h(
                    'button',
                    {
                        class: `menu-item${index === active ? ' active' : ''}`,
                        type: 'button',
                        role: 'option',
                        'aria-selected': item.checked ? 'true' : 'false',
                        onmouseenter: () => {
                            active = index;
                            for (const [at, element] of [...list.children].entries()) element.classList.toggle('active', at === index);
                        },
                        onclick: () => {
                            closeMenu();
                            item.run();
                        },
                    },
                    item.icon ?? null,
                    h('span', { class: 'menu-label' }, item.label),
                    item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
                    item.checked ? h('span', { class: 'menu-check' }, '✓') : null,
                ),
            ),
        );
        if (shown.length === 0) list.append(h('div', { class: 'menu-empty' }, '該当なし'));
    };
    draw();
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(shown.length, 1);
            draw();
            (list.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const item = shown[active];
            closeMenu();
            item?.run();
        } else if (event.key === 'Escape') {
            event.stopPropagation();
            closeMenu();
            anchor.focus();
        }
    });
    input?.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        shown = items.filter((item) => `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(query));
        active = 0;
        draw();
    });
    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    const below = rect.bottom + 4 + height < window.innerHeight;
    menu.style.left = `${left}px`;
    menu.style.top = `${below ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`;
    openMenu = menu;
    (input ?? (list.children[active] as HTMLElement | undefined))?.focus();
}

document.addEventListener(
    'pointerdown',
    (event) => {
        if (openMenu && !openMenu.contains(event.target as Node)) closeMenu();
    },
    true,
);

// ---- 知らせ ----

export function toast(message: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
    let host = document.querySelector<HTMLElement>('.toasts');
    if (!host) {
        host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
        document.body.append(host);
    }
    const item = h(
        'div',
        { class: `toast toast-${kind}` },
        h('span', null, message),
        action
            ? h(
                  'button',
                  {
                      type: 'button',
                      class: 'toast-action',
                      onclick: () => {
                          action.run();
                          item.remove();
                      },
                  },
                  action.label,
              )
            : null,
    );
    host.append(item);
    setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3500);
}

// ---- 日付 ----

export function today(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function formatDue(due: string): { text: string; tone: 'overdue' | 'soon' | 'normal' } {
    const [year, month, day] = due.split('-').map(Number);
    if (!year || !month || !day) return { text: due, tone: 'normal' };
    const target = Date.UTC(year, month - 1, day);
    const [ty, tm, td] = today().split('-').map(Number);
    const days = Math.round((target - Date.UTC(ty!, tm! - 1, td!)) / 86400000);
    const text = `${month}/${day}`;
    if (days < 0) return { text, tone: 'overdue' };
    if (days <= 7) return { text, tone: 'soon' };
    return { text, tone: 'normal' };
}

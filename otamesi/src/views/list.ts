// リスト: 状態ごとに Issue を並べる
import type { TaskState } from 'markdag';
import type { AppContext } from '../context';
import { type Issue, STATES } from '../doc';
import { avatar, formatDue, h, ICON, PRIORITY_LABEL, priorityIcon, STATE_LABEL, showMenu, stateIcon, svg } from '../dom';
import { chooseOwner, choosePriority, chooseState } from './menus';

const collapsed = new Set<TaskState>(['canceled']);

export function renderList(ctx: AppContext): HTMLElement {
    const issues = ctx.visibleIssues();
    const workspace = ctx.workspace;
    const sections = STATES.filter((state) => ctx.filters.showClosed || state === 'todo' || state === 'doing').map((state) => {
        const rows = issues.filter((issue) => issue.state === state);
        const open = !collapsed.has(state);
        return h(
            'section',
            { class: `list-section state-${state}` },
            h(
                'header',
                { class: 'list-head' },
                h(
                    'button',
                    {
                        type: 'button',
                        class: 'list-toggle',
                        'aria-expanded': String(open),
                        onclick: () => {
                            if (open) collapsed.add(state);
                            else collapsed.delete(state);
                            ctx.setFilters({});
                        },
                    },
                    h('span', { class: `caret${open ? ' open' : ''}` }, '▸'),
                    stateIcon(state),
                    h('span', { class: 'list-head-label' }, STATE_LABEL[state]),
                    h('span', { class: 'count' }, rows.length),
                ),
                state === 'todo' || state === 'doing'
                    ? h('button', { type: 'button', class: 'icon-button', title: `${STATE_LABEL[state]}で作成`, 'aria-label': `${STATE_LABEL[state]}で作成`, onclick: () => ctx.openCreate({ state, projectId: ctx.filters.projectId }) }, svg(ICON.plus))
                    : null,
            ),
            open ? h('div', { class: 'list-rows', role: 'list' }, rows.length === 0 ? h('div', { class: 'list-empty' }, 'なし') : rows.map((issue) => row(ctx, issue))) : null,
        );
    });
    const total = [...workspace.issues.values()].length;
    return h(
        'div',
        { class: 'list' },
        sections,
        issues.length === 0 && total > 0 ? h('p', { class: 'empty-note' }, '絞り込みに合う Issue がありません') : null,
    );
}

function row(ctx: AppContext, issue: Issue): HTMLElement {
    const workspace = ctx.workspace;
    const project = workspace.projects.find((entry) => entry.nodeId === issue.projectId);
    const parent = issue.parentId === null ? undefined : workspace.issues.get(issue.parentId);
    const children = issue.childIds.map((id) => workspace.issues.get(id)).filter((child): child is Issue => child !== undefined);
    const finished = children.filter((child) => child.state === 'done' || child.state === 'canceled').length;
    const blocked = issue.openBlockers.length > 0 && (issue.state === 'todo' || issue.state === 'doing');
    const due = issue.due ? formatDue(issue.due) : null;
    const stop = (run: (event: MouseEvent) => void) => (event: MouseEvent) => {
        event.stopPropagation();
        run(event);
    };
    return h(
        'div',
        {
            class: `row${ctx.selected === issue.nodeId ? ' selected' : ''}${issue.state === 'done' || issue.state === 'canceled' ? ' closed' : ''}`,
            role: 'listitem',
            tabindex: '0',
            dataset: { id: String(issue.nodeId) },
            onclick: () => ctx.select(issue.nodeId),
            onkeydown: (event: KeyboardEvent) => {
                if (event.key === 'Enter') ctx.select(issue.nodeId);
            },
        },
        h(
            'button',
            {
                type: 'button',
                class: 'cell-button',
                title: `優先度: ${issue.priority ? PRIORITY_LABEL[issue.priority] : 'なし'}`,
                'aria-label': '優先度を変える',
                onclick: stop((event) => showMenu(event.currentTarget as HTMLElement, choosePriority(ctx, issue))),
            },
            priorityIcon(issue.priority),
        ),
        h('span', { class: 'row-key' }, issue.key ?? '—'),
        h(
            'button',
            {
                type: 'button',
                class: 'cell-button',
                title: `状態: ${STATE_LABEL[issue.state]}`,
                'aria-label': '状態を変える',
                onclick: stop((event) => showMenu(event.currentTarget as HTMLElement, chooseState(ctx, issue))),
            },
            stateIcon(issue.state),
        ),
        h(
            'span',
            { class: 'row-title' },
            parent ? h('span', { class: 'row-parent' }, `${parent.title} ›`) : null,
            h('span', { class: 'row-title-text' }, issue.title),
        ),
        h(
            'span',
            { class: 'row-meta' },
            blocked
                ? h('span', { class: 'chip chip-blocked', title: `先に終えるもの: ${issue.openBlockers.map((id) => workspace.issues.get(id)?.key).join(', ')}` }, svg(ICON.blocked), '待ち')
                : null,
            issue.blocking.length > 0 ? h('span', { class: 'chip chip-muted', title: 'この Issue を待っている Issue の数' }, svg(ICON.link), issue.blocking.length) : null,
            children.length > 0 ? h('span', { class: 'chip chip-muted', title: 'サブ Issue' }, `${finished}/${children.length}`) : null,
            project ? h('span', { class: 'chip chip-project' }, h('i', { style: `background:${project.color}` }), project.name) : null,
            due ? h('span', { class: `chip chip-due due-${due.tone}`, title: `期日 ${issue.due}` }, svg(ICON.calendar), due.text) : null,
            issue.estimate !== null ? h('span', { class: 'chip chip-estimate', title: '見積もり' }, `${issue.estimate}pt`) : null,
            h(
                'button',
                {
                    type: 'button',
                    class: 'cell-button',
                    'aria-label': '担当を変える',
                    onclick: stop((event) => showMenu(event.currentTarget as HTMLElement, chooseOwner(ctx, issue), { filter: true, placeholder: '担当者…' })),
                },
                avatar(issue.owner),
            ),
        ),
    );
}

// ボード: 状態ごとの列。カードを別の列へドラッグすると、Markdown のタスクの印が変わる
import type { TaskState } from 'markdag';
import type { AppContext } from '../context';
import type { Issue } from '../doc';
import { avatar, formatDue, h, ICON, priorityIcon, STATE_LABEL, showMenu, stateIcon, svg } from '../dom';
import { chooseOwner, choosePriority } from './menus';

const COLUMNS: TaskState[] = ['todo', 'doing', 'done', 'canceled'];

export function renderBoard(ctx: AppContext): HTMLElement {
    const issues = ctx.visibleIssues();
    const columns = COLUMNS.filter((state) => ctx.filters.showClosed || state === 'todo' || state === 'doing');
    return h(
        'div',
        { class: 'board' },
        columns.map((state) => {
            const cards = issues.filter((issue) => issue.state === state);
            const column = h(
                'section',
                {
                    class: `board-column state-${state}`,
                    'aria-label': STATE_LABEL[state],
                    ondragover: (event: DragEvent) => {
                        event.preventDefault();
                        column.classList.add('drop');
                    },
                    ondragleave: (event: DragEvent) => {
                        if (!column.contains(event.relatedTarget as Node)) column.classList.remove('drop');
                    },
                    ondrop: (event: DragEvent) => {
                        event.preventDefault();
                        column.classList.remove('drop');
                        const id = Number(event.dataTransfer?.getData('text/plain'));
                        const issue = ctx.workspace.issues.get(id);
                        if (issue) ctx.setState(issue, state);
                    },
                },
                h(
                    'header',
                    { class: 'board-head' },
                    stateIcon(state),
                    h('span', null, STATE_LABEL[state]),
                    h('span', { class: 'count' }, cards.length),
                    h('span', { class: 'spacer' }),
                    state === 'todo' || state === 'doing'
                        ? h('button', { type: 'button', class: 'icon-button', 'aria-label': `${STATE_LABEL[state]}で作成`, onclick: () => ctx.openCreate({ state, projectId: ctx.filters.projectId }) }, svg(ICON.plus))
                        : null,
                ),
                h('div', { class: 'board-cards' }, cards.map((issue) => card(ctx, issue))),
            );
            return column;
        }),
    );
}

function card(ctx: AppContext, issue: Issue): HTMLElement {
    const workspace = ctx.workspace;
    const project = workspace.projects.find((entry) => entry.nodeId === issue.projectId);
    const parent = issue.parentId === null ? undefined : workspace.issues.get(issue.parentId);
    const blocked = issue.openBlockers.length > 0 && (issue.state === 'todo' || issue.state === 'doing');
    const due = issue.due ? formatDue(issue.due) : null;
    const children = issue.childIds.map((id) => workspace.issues.get(id)).filter((child): child is Issue => child !== undefined);
    const finished = children.filter((child) => child.state === 'done' || child.state === 'canceled').length;
    const stop = (run: (event: MouseEvent) => void) => (event: MouseEvent) => {
        event.stopPropagation();
        run(event);
    };
    return h(
        'article',
        {
            class: `card${ctx.selected === issue.nodeId ? ' selected' : ''}${blocked ? ' blocked' : ''}`,
            draggable: 'true',
            tabindex: '0',
            dataset: { id: String(issue.nodeId) },
            onclick: () => ctx.select(issue.nodeId),
            onkeydown: (event: KeyboardEvent) => {
                if (event.key === 'Enter') ctx.select(issue.nodeId);
            },
            ondragstart: (event: DragEvent) => {
                event.dataTransfer?.setData('text/plain', String(issue.nodeId));
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                (event.currentTarget as HTMLElement).classList.add('dragging');
            },
            ondragend: (event: DragEvent) => (event.currentTarget as HTMLElement).classList.remove('dragging'),
        },
        h('div', { class: 'card-top' }, h('span', { class: 'row-key' }, issue.key ?? '—')),
        parent ? h('div', { class: 'card-parent' }, `${parent.title} ›`) : null,
        h('div', { class: 'card-title' }, issue.title),
        h(
            'div',
            { class: 'card-meta' },
            h(
                'button',
                { type: 'button', class: 'cell-button', 'aria-label': '優先度を変える', onclick: stop((event) => showMenu(event.currentTarget as HTMLElement, choosePriority(ctx, issue))) },
                priorityIcon(issue.priority),
            ),
            blocked ? h('span', { class: 'chip chip-blocked' }, svg(ICON.blocked), '待ち') : null,
            project ? h('span', { class: 'chip chip-project' }, h('i', { style: `background:${project.color}` }), project.name) : null,
            due ? h('span', { class: `chip chip-due due-${due.tone}` }, svg(ICON.calendar), due.text) : null,
            children.length > 0 ? h('span', { class: 'chip chip-muted' }, `${finished}/${children.length}`) : null,
            issue.estimate !== null ? h('span', { class: 'chip chip-estimate' }, `${issue.estimate}pt`) : null,
            h(
                'button',
                {
                    type: 'button',
                    class: 'cell-button card-owner',
                    'aria-label': '担当を変える',
                    onclick: stop((event) => showMenu(event.currentTarget as HTMLElement, chooseOwner(ctx, issue), { filter: true, placeholder: '担当者…' })),
                },
                avatar(issue.owner, 18),
                issue.owner ?? '担当なし',
            ),
        ),
    );
}

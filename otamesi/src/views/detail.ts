// 詳細: 選んだ Issue の題名、説明、属性、依存、サブ Issue。どの変更も Markdown の書き換えになる
import { changeDescription, changeFields, deleteIssue, link, moveToProject, unlink } from '../actions';
import type { AppContext } from '../context';
import type { Issue } from '../doc';
import { avatar, closeMenu, formatDue, h, ICON, type MenuItem, PRIORITY_LABEL, priorityIcon, STATE_LABEL, showMenu, stateIcon, svg } from '../dom';
import { chooseOwner, choosePriority, chooseState } from './menus';

let confirmingDelete: number | null = null;

export function renderDetail(ctx: AppContext, issue: Issue): HTMLElement {
    const workspace = ctx.workspace;
    const project = workspace.projects.find((entry) => entry.nodeId === issue.projectId);
    const parent = issue.parentId === null ? undefined : workspace.issues.get(issue.parentId);
    const lines = workspace.source.split(/\r?\n/).slice(issue.lines.start, issue.lines.end);
    while (lines.length > 1 && lines.at(-1)!.trim() === '') lines.pop();

    const title = h('textarea', {
        class: 'detail-title',
        id: 'detail-title',
        rows: '1',
        'aria-label': 'タイトル',
        value: issue.title,
    });
    const saveTitle = () => {
        const value = title.value.replace(/\s+/g, ' ').trim();
        if (value !== issue.title) ctx.commit(changeFields(workspace, issue, { title: value }));
    };
    title.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            title.blur();
        }
    });
    title.addEventListener('blur', saveTitle);

    const description = h('textarea', {
        class: 'detail-description',
        id: 'detail-description',
        placeholder: '説明を追加… (Markdown の引用 > として保存されます)',
        'aria-label': '説明',
        value: issue.description,
    });
    description.addEventListener('blur', () => ctx.commit(changeDescription(workspace, issue, description.value)));
    description.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) description.blur();
    });
    const grow = (area: HTMLTextAreaElement) => {
        area.style.height = 'auto';
        area.style.height = `${area.scrollHeight}px`;
    };
    for (const area of [title, description]) {
        area.addEventListener('input', () => grow(area));
        requestAnimationFrame(() => grow(area));
    }

    const property = (label: string, value: HTMLElement) => h('div', { class: 'prop' }, h('span', { class: 'prop-label' }, label), value);
    const picker = (content: (HTMLElement | string | null)[], items: () => MenuItem[], filter = false, id?: string) =>
        h(
            'button',
            { type: 'button', class: 'prop-value', id, onclick: (event: MouseEvent) => showMenu(event.currentTarget as HTMLElement, items(), { filter }) },
            ...content,
        );

    const dueInput = h('input', { type: 'date', class: 'prop-date', id: 'detail-due', value: issue.due ?? '', 'aria-label': '期日' });
    dueInput.addEventListener('change', () => ctx.commit(changeFields(workspace, issue, { due: dueInput.value || null })));
    const due = issue.due ? formatDue(issue.due) : null;

    const blocked = issue.openBlockers.length > 0 && (issue.state === 'todo' || issue.state === 'doing');

    return h(
        'aside',
        { class: 'detail', 'aria-label': '詳細' },
        h(
            'header',
            { class: 'detail-head' },
            h(
                'div',
                { class: 'crumbs' },
                project ? h('span', { class: 'chip chip-project' }, h('i', { style: `background:${project.color}` }), project.name) : null,
                parent ? h('button', { type: 'button', class: 'crumb-link', onclick: () => ctx.select(parent.nodeId) }, parent.key ?? parent.title) : null,
                h('span', { class: 'detail-key' }, issue.key ?? 'ID なし'),
            ),
            h('span', { class: 'spacer' }),
            h(
                'button',
                { type: 'button', class: 'icon-button', title: 'Markdown で見る', 'aria-label': 'Markdown で見る', onclick: () => ctx.revealSource(issue.lines.start, issue.ownEnd) },
                svg(ICON.markdown),
            ),
            confirmingDelete === issue.nodeId
                ? h(
                      'span',
                      { class: 'confirm' },
                      '削除しますか？',
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'danger-button',
                              onclick: () => {
                                  confirmingDelete = null;
                                  if (ctx.commit(deleteIssue(workspace, issue), `${issue.key ?? issue.title} を削除しました`)) ctx.select(null);
                              },
                          },
                          '削除',
                      ),
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'ghost-button',
                              onclick: () => {
                                  confirmingDelete = null;
                                  ctx.setFilters({});
                              },
                          },
                          'やめる',
                      ),
                  )
                : h(
                      'button',
                      {
                          type: 'button',
                          class: 'icon-button',
                          title: '削除',
                          'aria-label': '削除',
                          onclick: () => {
                              confirmingDelete = issue.nodeId;
                              ctx.setFilters({});
                          },
                      },
                      svg(ICON.trash),
                  ),
            h('button', { type: 'button', class: 'icon-button', title: '閉じる (Esc)', 'aria-label': '閉じる', onclick: () => ctx.select(null) }, svg(ICON.close)),
        ),
        h(
            'div',
            { class: 'detail-body' },
            title,
            blocked
                ? h(
                      'div',
                      { class: 'notice' },
                      svg(ICON.blocked),
                      h(
                          'span',
                          null,
                          '先に終える Issue があります: ',
                          issue.openBlockers.map((id, index) => {
                              const blocker = workspace.issues.get(id);
                              return [index > 0 ? '、' : '', h('button', { type: 'button', class: 'inline-link', onclick: () => ctx.select(id) }, blocker?.key ?? blocker?.title ?? '')];
                          }),
                          workspace.requireUpstreamDone ? h('small', null, 'markdag.rules の requireUpstreamDone により、終わるまで完了にできません') : null,
                      ),
                  )
                : null,
            description,
            h(
                'div',
                { class: 'props' },
                property('状態', picker([stateIcon(issue.state), STATE_LABEL[issue.state]], () => chooseState(ctx, issue), false, 'detail-state')),
                property('優先度', picker([priorityIcon(issue.priority), issue.priority ? PRIORITY_LABEL[issue.priority] : 'なし'], () => choosePriority(ctx, issue))),
                property('担当', picker([avatar(issue.owner, 18), issue.owner ?? '担当なし'], () => chooseOwner(ctx, issue), true)),
                property(
                    '期日',
                    h(
                        'div',
                        { class: 'prop-inline' },
                        dueInput,
                        due ? h('span', { class: `due-${due.tone} due-note` }, due.tone === 'overdue' ? '期限切れ' : due.tone === 'soon' ? '7 日以内' : '') : null,
                    ),
                ),
                property(
                    '見積もり',
                    picker([issue.estimate === null ? 'なし' : `${issue.estimate} pt`], () => [
                        { label: 'なし', checked: issue.estimate === null, run: () => ctx.commit(changeFields(workspace, issue, { estimate: null })) },
                        ...[1, 2, 3, 5, 8].map((points) => ({
                            label: `${points} pt`,
                            checked: issue.estimate === points,
                            run: () => ctx.commit(changeFields(workspace, issue, { estimate: points })),
                        })),
                    ]),
                ),
                property(
                    'プロジェクト',
                    issue.parentId !== null
                        ? h('span', { class: 'prop-static' }, project?.name ?? '—', h('small', null, '親に従う'))
                        : picker([project ? h('i', { class: 'dot', style: `background:${project.color}` }) : null, project?.name ?? 'なし'], () =>
                              workspace.projects.map((entry) => ({
                                  label: entry.name,
                                  icon: h('i', { class: 'dot', style: `background:${entry.color}` }),
                                  checked: entry.nodeId === issue.projectId,
                                  run: () => ctx.commit(moveToProject(workspace, issue, entry.nodeId), `${entry.name} へ移動しました`),
                              })),
                          ),
                ),
            ),
            relations(ctx, issue),
            subIssues(ctx, issue),
            h(
                'section',
                { class: 'detail-section' },
                h('h3', null, 'Markdown', h('small', null, `${issue.lines.start + 1}–${issue.lines.start + lines.length} 行`)),
                h('pre', { class: 'snippet' }, lines.join('\n')),
            ),
            issue.diagnostics.length > 0
                ? h(
                      'section',
                      { class: 'detail-section' },
                      h('h3', null, '診断'),
                      issue.diagnostics.map((diagnostic) => h('p', { class: `problem-line problem-${diagnostic.severity}` }, `${diagnostic.message}`, diagnostic.hint ? h('small', null, diagnostic.hint) : null)),
                  )
                : null,
        ),
    );
}

function relations(ctx: AppContext, issue: Issue): HTMLElement {
    const workspace = ctx.workspace;
    const candidates = () => [...workspace.issues.values()].filter((other) => other.nodeId !== issue.nodeId && other.key);
    const milestones = workspace.milestones.filter((milestone) => milestone.upstream.includes(issue.nodeId));
    const entry = (other: Issue | undefined, origin: string, remove: () => void) =>
        other
            ? h(
                  'li',
                  { class: 'rel' },
                  stateIcon(other.state),
                  h('button', { type: 'button', class: 'rel-title', onclick: () => ctx.select(other.nodeId) }, h('span', { class: 'row-key' }, other.key ?? ''), other.title),
                  h('code', { class: 'rel-origin', title: 'frontmatter の式' }, origin),
                  h('button', { type: 'button', class: 'icon-button small', 'aria-label': '依存を外す', title: '依存を外す', onclick: remove }, svg(ICON.close)),
              )
            : null;
    const add = (label: string, run: (other: Issue) => void) =>
        h(
            'button',
            {
                type: 'button',
                class: 'add-link',
                onclick: (event: MouseEvent) =>
                    showMenu(
                        event.currentTarget as HTMLElement,
                        candidates().map((other) => ({ label: other.title, hint: other.key ?? '', icon: stateIcon(other.state), run: () => run(other) })),
                        { filter: true, placeholder: 'Issue を検索…' },
                    ),
            },
            svg(ICON.plus),
            label,
        );
    return h(
        'section',
        { class: 'detail-section' },
        h('h3', null, '依存', h('small', null, 'frontmatter の relations.depends')),
        h('h4', null, '先に終える (ブロックされている)'),
        h(
            'ul',
            { class: 'rels' },
            issue.blockedBy.map((edge) => {
                const other = workspace.issues.get(edge.nodeId);
                return entry(other, edge.origin, () => other && ctx.commit(unlink(workspace, other, issue, edge.origin)));
            }),
        ),
        add('ブロックしている Issue を追加', (other) => ctx.commit(link(workspace, other, issue), `${other.key} → ${issue.key} を追加しました`)),
        h('h4', null, 'この Issue を待っている'),
        h(
            'ul',
            { class: 'rels' },
            issue.blocking.map((edge) => {
                const other = workspace.issues.get(edge.nodeId);
                return entry(other, edge.origin, () => other && ctx.commit(unlink(workspace, issue, other, edge.origin)));
            }),
        ),
        add('待っている Issue を追加', (other) => ctx.commit(link(workspace, issue, other), `${issue.key} → ${other.key} を追加しました`)),
        milestones.length > 0
            ? [
                  h('h4', null, 'マイルストーン'),
                  h(
                      'ul',
                      { class: 'rels' },
                      milestones.map((milestone) =>
                          h('li', { class: 'rel' }, svg(ICON.flag), h('button', { type: 'button', class: 'rel-title', onclick: () => ctx.setFilters({ milestoneId: milestone.nodeId, projectId: null }) }, milestone.name)),
                      ),
                  ),
              ]
            : null,
    );
}

function subIssues(ctx: AppContext, issue: Issue): HTMLElement {
    const workspace = ctx.workspace;
    const children = issue.childIds.map((id) => workspace.issues.get(id)).filter((child): child is Issue => child !== undefined);
    return h(
        'section',
        { class: 'detail-section' },
        h('h3', null, 'サブ Issue', children.length > 0 ? h('small', null, `${children.filter((child) => child.state === 'done').length}/${children.length} 完了`) : null),
        h(
            'ul',
            { class: 'rels' },
            children.map((child) =>
                h(
                    'li',
                    { class: 'rel' },
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'cell-button',
                            'aria-label': '状態を変える',
                            onclick: (event: MouseEvent) => showMenu(event.currentTarget as HTMLElement, chooseState(ctx, child)),
                        },
                        stateIcon(child.state),
                    ),
                    h('button', { type: 'button', class: 'rel-title', onclick: () => ctx.select(child.nodeId) }, h('span', { class: 'row-key' }, child.key ?? ''), child.title),
                    avatar(child.owner, 18),
                ),
            ),
        ),
        h(
            'button',
            {
                type: 'button',
                class: 'add-link',
                onclick: () => {
                    closeMenu();
                    ctx.openCreate({ parentId: issue.nodeId, projectId: issue.projectId });
                },
            },
            svg(ICON.plus),
            'サブ Issue を追加',
        ),
    );
}

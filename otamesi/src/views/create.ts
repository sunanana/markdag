// 新しい Issue のダイアログ。作ると、プロジェクトの見出しの下 (サブなら親の項目の下) に 1 行足す
import type { TaskState } from 'markdag';
import { createIssue, type Draft } from '../actions';
import type { AppContext } from '../context';
import { avatar, h, ICON, PRIORITY_LABEL, priorityIcon, STATE_LABEL, showMenu, stateIcon, svg } from '../dom';
import { PRIORITIES, STATES } from '../doc';

export function openCreateDialog(ctx: AppContext, defaults: { projectId?: number | null; parentId?: number | null; state?: TaskState }): void {
    const workspace = ctx.workspace;
    const parent = defaults.parentId == null ? undefined : workspace.issues.get(defaults.parentId);
    const draft: Draft = {
        title: '',
        description: '',
        state: defaults.state ?? 'todo',
        projectId: parent?.projectId ?? defaults.projectId ?? workspace.projects[0]?.nodeId ?? null,
        parentId: parent?.nodeId ?? null,
        owner: null,
        priority: null,
        due: null,
        estimate: null,
    };

    const title = h('input', { class: 'create-title', id: 'create-title', placeholder: 'Issue のタイトル', 'aria-label': 'タイトル', autocomplete: 'off' });
    const description = h('textarea', { class: 'create-description', id: 'create-description', placeholder: '説明 (任意)', 'aria-label': '説明', rows: '3' });
    const due = h('input', { type: 'date', class: 'prop-date', id: 'create-due', 'aria-label': '期日' });
    const preview = h('pre', { class: 'snippet create-preview' });
    const pills = h('div', { class: 'create-pills' });

    const drawPreview = () => {
        draft.title = title.value;
        draft.description = description.value;
        draft.due = due.value || null;
        const result = createIssue(workspace, { ...draft, title: draft.title || 'タイトル' });
        if (!result.ok) {
            preview.textContent = result.reason;
            return;
        }
        // 足される行だけを見せる
        const before = workspace.source.split(/\r?\n/);
        const after = result.source.split(/\r?\n/);
        let start = 0;
        while (start < before.length && before[start] === after[start]) start += 1;
        preview.textContent = after.slice(start, start + after.length - before.length).join('\n');
    };

    const pill = (content: (HTMLElement | string | null)[], items: () => { label: string; icon?: HTMLElement; checked?: boolean; run: () => void }[]) =>
        h('button', { type: 'button', class: 'pill', onclick: (event: MouseEvent) => showMenu(event.currentTarget as HTMLElement, items(), { filter: items().length > 6 }) }, ...content);

    const drawPills = () => {
        const project = workspace.projects.find((entry) => entry.nodeId === draft.projectId);
        pills.replaceChildren(
            pill([stateIcon(draft.state), STATE_LABEL[draft.state]], () =>
                STATES.map((state) => ({ label: STATE_LABEL[state], icon: stateIcon(state), checked: draft.state === state, run: () => update({ state }) })),
            ),
            pill([priorityIcon(draft.priority), draft.priority ? PRIORITY_LABEL[draft.priority] : '優先度'], () => [
                ...PRIORITIES.map((priority) => ({ label: PRIORITY_LABEL[priority], icon: priorityIcon(priority), checked: draft.priority === priority, run: () => update({ priority }) })),
                { label: 'なし', icon: priorityIcon(null), checked: draft.priority === null, run: () => update({ priority: null }) },
            ]),
            pill([avatar(draft.owner, 16), draft.owner ?? '担当'], () => [
                { label: '担当なし', icon: avatar(null, 16), checked: draft.owner === null, run: () => update({ owner: null }) },
                ...workspace.owners.map((owner) => ({ label: owner, icon: avatar(owner, 16), checked: draft.owner === owner, run: () => update({ owner }) })),
            ]),
            pill([draft.estimate === null ? '見積もり' : `${draft.estimate} pt`], () =>
                [null, 1, 2, 3, 5, 8].map((points) => ({ label: points === null ? 'なし' : `${points} pt`, checked: draft.estimate === points, run: () => update({ estimate: points }) })),
            ),
            parent
                ? h('span', { class: 'pill static' }, `親: ${parent.key ?? parent.title}`)
                : pill([project ? h('i', { class: 'dot', style: `background:${project.color}` }) : null, project?.name ?? 'プロジェクト'], () =>
                      workspace.projects.map((entry) => ({
                          label: entry.name,
                          icon: h('i', { class: 'dot', style: `background:${entry.color}` }),
                          checked: entry.nodeId === draft.projectId,
                          run: () => update({ projectId: entry.nodeId }),
                      })),
                  ),
            h('label', { class: 'pill pill-date' }, svg(ICON.calendar), due),
        );
    };

    const update = (change: Partial<Draft>) => {
        Object.assign(draft, change);
        drawPills();
        drawPreview();
        title.focus();
    };

    const close = () => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
    };
    const submit = () => {
        drawPreview();
        const result = createIssue(ctx.workspace, draft);
        if (ctx.commit(result, result.ok ? `${result.key} を作成しました` : undefined) && result.ok) {
            close();
            const id = ctx.workspace.byKey.get(result.key ?? '');
            if (id !== undefined) ctx.select(id);
        }
    };
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !document.querySelector('.menu')) {
            event.stopPropagation();
            close();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.target === title)) {
            event.preventDefault();
            submit();
        }
    };

    for (const input of [title, description, due]) input.addEventListener('input', drawPreview);
    document.addEventListener('keydown', onKey, true);

    const overlay = h(
        'div',
        {
            class: 'overlay',
            onpointerdown: (event: PointerEvent) => {
                if (event.target === overlay) close();
            },
        },
        h(
            'div',
            { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'create-heading' },
            h(
                'header',
                { class: 'dialog-head' },
                h('span', { class: 'chip chip-muted' }, workspace.title),
                h('h2', { id: 'create-heading' }, parent ? 'サブ Issue を作成' : '新しい Issue'),
                h('span', { class: 'spacer' }),
                h('button', { type: 'button', class: 'icon-button', 'aria-label': '閉じる', onclick: close }, svg(ICON.close)),
            ),
            title,
            description,
            pills,
            h('div', { class: 'create-foot' }, h('span', { class: 'create-note' }, '追加される Markdown'), preview),
            h(
                'footer',
                { class: 'dialog-foot' },
                h('span', { class: 'kbd-note' }, h('kbd', null, 'Enter'), ' で作成 ・ ', h('kbd', null, 'Esc'), ' で閉じる'),
                h('span', { class: 'spacer' }),
                h('button', { type: 'button', class: 'ghost-button', onclick: close }, 'キャンセル'),
                h('button', { type: 'button', class: 'primary-button', onclick: submit }, '作成'),
            ),
        ),
    );
    document.body.append(overlay);
    drawPills();
    drawPreview();
    title.focus();
}

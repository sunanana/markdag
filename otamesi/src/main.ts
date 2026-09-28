// otamesi: markdag の Markdown を唯一のデータにしたタスク管理。
// どの画面の操作も Markdown の文字列を書き換え、parseDocument + buildModel で読み直して全画面を描き直す
import { init, type TaskState } from 'markdag';
import { changeState, createProject, type Result } from './actions';
import type { AppContext, Filters, ViewName } from './context';
import { type Issue, PRIORITIES } from './doc';
import { avatar, closeMenu, h, ICON, svg, toast } from './dom';
import sample from './sample.md?raw';
import { type ChangeOrigin, Store } from './store';
import './style.css';
import { renderBoard } from './views/board';
import { openCreateDialog } from './views/create';
import { renderDetail } from './views/detail';
import { GraphPane } from './views/graph';
import { renderList } from './views/list';
import { SourcePane } from './views/source';

const VIEWS: { name: ViewName; label: string; icon: string; key: string }[] = [
    { name: 'list', label: 'リスト', icon: ICON.list, key: '1' },
    { name: 'board', label: 'ボード', icon: ICON.board, key: '2' },
    { name: 'graph', label: 'グラフ', icon: ICON.graph, key: '3' },
    { name: 'source', label: 'Markdown', icon: ICON.markdown, key: '4' },
];

function readSetting(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}
function writeSetting(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 覚えられなくても動く
    }
}

class App implements AppContext {
    view: ViewName = (readSetting('otamesi:view') as ViewName | null) ?? 'list';
    selected: number | null = null;
    filters: Filters = { projectId: null, milestoneId: null, owner: null, query: '', showClosed: true };
    private sidebarOpen = false;
    private readonly graph = new GraphPane(() => this);
    private readonly sourcePane = new SourcePane(() => this);
    private readonly root: HTMLElement;
    private readonly darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    constructor(
        readonly store: Store,
        root: HTMLElement,
    ) {
        this.root = root;
        if (!VIEWS.some((view) => view.name === this.view)) this.view = 'list';
        store.subscribe((_workspace, origin) => this.changed(origin));
        this.darkQuery.addEventListener('change', () => this.render());
        document.addEventListener('keydown', (event) => this.onKey(event));
        const theme = readSetting('otamesi:theme');
        if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
        this.render();
    }

    get workspace() {
        return this.store.workspace;
    }

    private get dark(): boolean {
        const theme = document.documentElement.dataset.theme;
        return theme === 'dark' || (theme !== 'light' && this.darkQuery.matches);
    }

    // ---- AppContext ----

    select(nodeId: number | null): void {
        this.selected = nodeId;
        this.render();
        if (nodeId !== null && this.view === 'graph') this.graph.focus(nodeId);
        if (nodeId !== null) this.root.querySelector(`[data-id="${nodeId}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    setView(view: ViewName): void {
        this.view = view;
        writeSetting('otamesi:view', view);
        this.sidebarOpen = false;
        this.render();
    }

    setFilters(change: Partial<Filters>): void {
        this.filters = { ...this.filters, ...change };
        this.render();
    }

    commit(result: Result, message?: string): boolean {
        if (!result.ok) {
            toast(result.reason, 'error');
            return false;
        }
        if (result.source !== this.store.source) {
            this.store.set(result.source);
            if (message) toast(message, 'info', { label: '元に戻す', run: () => this.store.undo() });
        }
        return true;
    }

    setState(issue: Issue, state: TaskState): void {
        this.commit(changeState(this.workspace, issue, state));
    }

    openCreate(defaults: { projectId?: number | null; parentId?: number | null; state?: TaskState } = {}): void {
        closeMenu();
        openCreateDialog(this, defaults);
    }

    revealSource(line: number, end?: number): void {
        this.setView('source');
        requestAnimationFrame(() => this.sourcePane.reveal(line, end));
    }

    visibleIssues(): Issue[] {
        const { projectId, milestoneId, owner, query } = this.filters;
        const workspace = this.workspace;
        const milestone = milestoneId === null ? undefined : workspace.milestones.find((entry) => entry.nodeId === milestoneId);
        const needle = query.trim().toLowerCase();
        const rank = (issue: Issue) => (issue.priority === null ? PRIORITIES.length : PRIORITIES.indexOf(issue.priority));
        return workspace.order
            .map((id) => workspace.issues.get(id)!)
            .filter((issue) => projectId === null || issue.projectId === projectId)
            .filter((issue) => !milestone || milestone.upstream.includes(issue.nodeId))
            .filter((issue) => owner === null || issue.owner === owner)
            .filter((issue) => needle === '' || `${issue.key ?? ''} ${issue.title} ${issue.description}`.toLowerCase().includes(needle))
            .map((issue, index) => ({ issue, index }))
            .sort((a, b) => rank(a.issue) - rank(b.issue) || a.index - b.index)
            .map(({ issue }) => issue);
    }

    // ---- 変更 ----

    private changed(origin: ChangeOrigin): void {
        if (this.selected !== null && !this.workspace.issues.has(this.selected)) this.selected = null;
        if (this.filters.projectId !== null && !this.workspace.projects.some((project) => project.nodeId === this.filters.projectId)) this.filters.projectId = null;
        if (this.filters.milestoneId !== null && !this.workspace.milestones.some((entry) => entry.nodeId === this.filters.milestoneId)) this.filters.milestoneId = null;
        this.render(origin);
    }

    private onKey(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        const typing = target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === 'z' && !typing) {
            event.preventDefault();
            const done = event.shiftKey ? this.store.redo() : this.store.undo();
            if (!done) toast(event.shiftKey ? 'やり直す操作はありません' : '元に戻す操作はありません');
            return;
        }
        if (typing || mod || event.altKey || document.querySelector('.overlay')) return;
        if (event.key === 'Escape') {
            if (document.querySelector('.menu')) closeMenu();
            else if (this.selected !== null) this.select(null);
            return;
        }
        if (event.key === 'c') {
            event.preventDefault();
            this.openCreate({ projectId: this.filters.projectId });
        } else if (event.key === '/') {
            event.preventDefault();
            this.root.querySelector<HTMLInputElement>('#search')?.focus();
        } else {
            const view = VIEWS.find((entry) => entry.key === event.key);
            if (view) this.setView(view.name);
        }
    }

    // ---- 描画 ----

    render(origin: ChangeOrigin | null = null): void {
        const focused = document.activeElement instanceof HTMLElement && document.activeElement.id ? document.activeElement.id : null;
        const scroll = this.root.querySelector('.main-scroll')?.scrollTop ?? 0;
        const detailScroll = this.root.querySelector('.detail-body')?.scrollTop ?? 0;
        const selected = this.selected === null ? undefined : this.workspace.issues.get(this.selected);
        this.root.className = `app view-${this.view}${selected ? ' has-detail' : ''}${this.sidebarOpen ? ' sidebar-open' : ''}`;

        let content: HTMLElement;
        if (this.view === 'graph') content = this.graph.element;
        else if (this.view === 'source') content = this.sourcePane.element;
        else content = h('div', { class: 'main-scroll' }, this.view === 'board' ? renderBoard(this) : renderList(this));

        this.root.replaceChildren(
            ...[
                this.sidebar(),
                h('main', { class: 'main' }, this.header(), content),
                selected ? renderDetail(this, selected) : null,
            ].filter((element): element is HTMLElement => element !== null),
            h('button', { type: 'button', class: 'scrim', 'aria-label': 'メニューを閉じる', onclick: () => ((this.sidebarOpen = false), this.render()) }),
        );

        if (this.view === 'graph') this.graph.show(this.dark);
        else this.graph.sync();
        if (this.view === 'source') this.sourcePane.show(origin === 'editor');
        const main = this.root.querySelector('.main-scroll');
        if (main) main.scrollTop = scroll;
        const detail = this.root.querySelector('.detail-body');
        if (detail) detail.scrollTop = detailScroll;
        if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
    }

    private sidebar(): HTMLElement {
        const workspace = this.workspace;
        const all = [...workspace.issues.values()];
        const progress = (ids: Issue[]) => {
            const counted = ids.filter((issue) => issue.state !== 'canceled');
            return { done: counted.filter((issue) => issue.state === 'done').length, total: counted.length };
        };
        const nav = (label: string, active: boolean, run: () => void, lead: HTMLElement | null, tail: HTMLElement | string | null = null) =>
            h('button', { type: 'button', class: `nav-item${active ? ' active' : ''}`, 'aria-pressed': String(active), onclick: run }, lead, h('span', { class: 'nav-label' }, label), tail);
        const noFilter = this.filters.projectId === null && this.filters.milestoneId === null && this.filters.owner === null;
        const projectInput = h('input', { class: 'nav-input', id: 'new-project', placeholder: '新しいプロジェクト名 + Enter', 'aria-label': '新しいプロジェクト名' });
        projectInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                if (this.commit(createProject(workspace, projectInput.value), `プロジェクト「${projectInput.value.trim()}」を作成しました`)) projectInput.value = '';
            } else if (event.key === 'Escape') projectInput.blur();
        });
        const diagnostics = workspace.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info');

        return h(
            'nav',
            { class: 'sidebar', 'aria-label': 'ワークスペース' },
            h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, workspace.title.slice(0, 1).toUpperCase()), h('span', { class: 'brand-name' }, workspace.title), h('span', { class: 'brand-sub' }, 'markdag')),
            h(
                'button',
                { type: 'button', class: 'new-issue', onclick: () => this.openCreate({ projectId: this.filters.projectId }) },
                svg(ICON.plus),
                '新しい Issue',
                h('kbd', null, 'C'),
            ),
            h(
                'div',
                { class: 'nav-group' },
                nav('すべての Issue', noFilter, () => this.setFilters({ projectId: null, milestoneId: null, owner: null }), svg(ICON.list), h('span', { class: 'count' }, all.length)),
            ),
            h(
                'div',
                { class: 'nav-group' },
                h('h2', { class: 'nav-title' }, 'プロジェクト'),
                workspace.projects.map((project) => {
                    const { done, total } = progress(all.filter((issue) => issue.projectId === project.nodeId));
                    return nav(
                        project.name,
                        this.filters.projectId === project.nodeId,
                        () => this.setFilters({ projectId: this.filters.projectId === project.nodeId ? null : project.nodeId, milestoneId: null }),
                        h('i', { class: 'dot', style: `background:${project.color}` }),
                        h('span', { class: 'count' }, `${done}/${total}`),
                    );
                }),
                projectInput,
            ),
            workspace.milestones.length > 0
                ? h(
                      'div',
                      { class: 'nav-group' },
                      h('h2', { class: 'nav-title' }, 'マイルストーン'),
                      workspace.milestones.map((milestone) => {
                          const { done, total } = progress(milestone.upstream.map((id) => workspace.issues.get(id)).filter((issue): issue is Issue => issue !== undefined));
                          const ratio = total === 0 ? 0 : done / total;
                          return h(
                              'button',
                              {
                                  type: 'button',
                                  class: `nav-item milestone${this.filters.milestoneId === milestone.nodeId ? ' active' : ''}`,
                                  onclick: () => this.setFilters({ milestoneId: this.filters.milestoneId === milestone.nodeId ? null : milestone.nodeId, projectId: null }),
                              },
                              svg(ICON.flag),
                              h('span', { class: 'nav-label' }, milestone.name),
                              h('span', { class: 'count' }, `${Math.round(ratio * 100)}%`),
                              h('span', { class: 'meter', style: `--ratio:${ratio}` }),
                          );
                      }),
                  )
                : null,
            h(
                'div',
                { class: 'nav-group' },
                h('h2', { class: 'nav-title' }, '担当者'),
                workspace.owners.map((owner) => {
                    const open = all.filter((issue) => issue.owner === owner && (issue.state === 'todo' || issue.state === 'doing')).length;
                    return nav(owner, this.filters.owner === owner, () => this.setFilters({ owner: this.filters.owner === owner ? null : owner }), avatar(owner, 18), h('span', { class: 'count' }, open));
                }),
            ),
            h('span', { class: 'spacer' }),
            h(
                'div',
                { class: 'sidebar-foot' },
                h(
                    'button',
                    { type: 'button', class: `health${diagnostics.length > 0 ? ' bad' : ''}`, onclick: () => this.setView('source'), title: 'markdag の診断' },
                    svg(diagnostics.length > 0 ? ICON.warn : ICON.markdown),
                    diagnostics.length > 0 ? `診断 ${diagnostics.length} 件` : '文書は正常',
                ),
                h(
                    'div',
                    { class: 'foot-tools' },
                    h('button', { type: 'button', class: 'icon-button', title: '元に戻す (⌘Z)', 'aria-label': '元に戻す', onclick: () => this.store.undo() }, svg(ICON.undo)),
                    h('button', { type: 'button', class: 'icon-button', title: 'やり直す (⇧⌘Z)', 'aria-label': 'やり直す', onclick: () => this.store.redo() }, svg(ICON.redo)),
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'icon-button',
                            title: 'テーマを切り替える',
                            'aria-label': 'テーマを切り替える',
                            onclick: () => {
                                const next = this.dark ? 'light' : 'dark';
                                document.documentElement.dataset.theme = next;
                                writeSetting('otamesi:theme', next);
                                this.render();
                            },
                        },
                        svg(ICON.moon),
                    ),
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'icon-button',
                            title: 'サンプルに戻す',
                            'aria-label': 'サンプルに戻す',
                            onclick: () => {
                                this.store.reset();
                                toast('サンプルに戻しました', 'info', { label: '元に戻す', run: () => this.store.undo() });
                            },
                        },
                        svg(ICON.reset),
                    ),
                ),
            ),
        );
    }

    private header(): HTMLElement {
        const workspace = this.workspace;
        const project = workspace.projects.find((entry) => entry.nodeId === this.filters.projectId);
        const milestone = workspace.milestones.find((entry) => entry.nodeId === this.filters.milestoneId);
        const heading = project?.name ?? milestone?.name ?? 'すべての Issue';
        const search = h('input', {
            id: 'search',
            class: 'search-input',
            type: 'search',
            placeholder: '検索  /',
            'aria-label': '検索',
            value: this.filters.query,
        });
        search.addEventListener('input', () => {
            this.filters.query = search.value;
            if (this.view === 'list' || this.view === 'board') this.render();
        });
        const filtering = this.view === 'list' || this.view === 'board';
        return h(
            'header',
            { class: 'topbar' },
            h(
                'button',
                { type: 'button', class: 'icon-button menu-button', 'aria-label': 'メニュー', onclick: () => ((this.sidebarOpen = true), this.render()) },
                svg(ICON.list),
            ),
            h(
                'div',
                { class: 'topbar-title' },
                project ? h('i', { class: 'dot', style: `background:${project.color}` }) : milestone ? svg(ICON.flag) : null,
                h('h1', null, heading),
                this.filters.owner ? h('span', { class: 'chip chip-muted filter-chip' }, avatar(this.filters.owner, 16), this.filters.owner, h('button', { type: 'button', class: 'chip-x', 'aria-label': '担当の絞り込みを外す', onclick: () => this.setFilters({ owner: null }) }, '×')) : null,
            ),
            h(
                'div',
                { class: 'tabs', role: 'tablist' },
                VIEWS.map((view) =>
                    h(
                        'button',
                        { type: 'button', role: 'tab', class: `tab${this.view === view.name ? ' active' : ''}`, 'aria-selected': String(this.view === view.name), title: `${view.label} (${view.key})`, onclick: () => this.setView(view.name) },
                        svg(view.icon),
                        h('span', { class: 'tab-label' }, view.label),
                    ),
                ),
            ),
            h('span', { class: 'spacer' }),
            filtering
                ? h(
                      'label',
                      { class: 'toggle' },
                      h('input', { type: 'checkbox', id: 'show-closed', checked: this.filters.showClosed, onchange: (event: Event) => this.setFilters({ showClosed: (event.target as HTMLInputElement).checked }) }),
                      '完了・中止も表示',
                  )
                : null,
            filtering ? h('div', { class: 'search' }, svg(ICON.search), search) : null,
        );
    }
}

async function start(): Promise<void> {
    const root = document.getElementById('app')!;
    try {
        await init();
    } catch (error) {
        root.replaceChildren(h('div', { class: 'boot-error' }, h('h1', null, 'markdag.wasm を読み込めませんでした'), h('pre', null, String(error))));
        return;
    }
    const store = Store.load(sample);
    new App(store, root);
}

void start();

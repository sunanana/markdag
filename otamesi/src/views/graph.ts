// グラフ: 文書をそのまま markdag の render で描く。依存の線、プロジェクトの枠、マイルストーンが一枚で見える。
// タスクの文字をクリックすると markdag が状態を進め (markdag.rules もここで効く)、onChange で文字列が戻ってくる。
// ノードの右の ID バッジ (decorateNode で付ける) をクリックすると、アプリの詳細を開く
import { type HookApi, type HookModule, type MarkdagDiagram, render } from 'markdag';
import type { AppContext } from '../context';
import { h, ICON, svg, toast } from '../dom';

export class GraphPane {
    readonly element: HTMLElement;
    private readonly canvas: HTMLElement;
    private diagram: MarkdagDiagram | null = null;
    private api: HookApi | null = null;
    private shown = '';
    private dark = false;

    constructor(private readonly ctx: () => AppContext) {
        this.canvas = h('div', { class: 'graph-canvas' });
        // ID バッジのクリックは、ノード (タスクの切り替え) に届く前に捕まえる
        this.canvas.addEventListener(
            'click',
            (event) => {
                const badge = (event.target as Element | null)?.closest('.mdag-badge');
                if (!badge) return;
                event.stopPropagation();
                event.preventDefault();
                const id = Number(badge.closest<HTMLElement>('.mdag-node')?.dataset.id);
                const issue = this.ctx().workspace.issues.get(id);
                if (issue) this.ctx().select(issue.nodeId);
            },
            true,
        );
        this.element = h(
            'div',
            { class: 'graph' },
            this.canvas,
            h(
                'div',
                { class: 'graph-tools' },
                h('button', { type: 'button', class: 'tool-button', onclick: () => this.diagram?.fit() }, '全体を表示'),
                h('button', { type: 'button', class: 'tool-button', onclick: () => this.diagram?.expandAll() }, 'すべて開く'),
                h('button', { type: 'button', class: 'tool-button', onclick: () => this.diagram?.resetFold() }, '初期の開閉'),
            ),
            h(
                'p',
                { class: 'graph-hint' },
                svg(ICON.graph),
                'タスクの文字をクリックで状態を進める / ID をクリックで詳細 / 線をクリックで強調',
            ),
        );
    }

    // 画面に出たとき。初回だけ描き、あとは文字列が変わったときに update する
    show(dark: boolean): void {
        const source = this.ctx().workspace.source;
        if (!this.diagram) {
            this.dark = dark;
            this.shown = source;
            this.diagram = render(this.canvas, source, {
                theme: dark ? 'dark' : 'light',
                hooks: this.hooks(),
                onChange: (markdown) => {
                    this.shown = markdown;
                    this.ctx().store.set(markdown, 'graph');
                    // 描き直しは markdag 側で済んでいる。待ちの印はこちらの読み直しの後で付け直す
                    this.api?.refreshDecorations();
                },
                onDiagnostic: (diagnostic) => {
                    if (diagnostic.code === 'hook-rejected') toast(diagnostic.message.replace(/^.*?:\s*/, ''), 'error');
                },
            });
            return;
        }
        if (dark !== this.dark) {
            this.dark = dark;
            this.diagram.view.setOptions({ theme: dark ? 'dark' : 'light' });
        }
        this.sync();
    }

    // 文字列がほかの画面で変わった
    sync(): void {
        if (!this.diagram) return;
        const source = this.ctx().workspace.source;
        if (source !== this.shown) {
            this.shown = source;
            this.diagram.update(source);
        } else this.api?.refreshDecorations();
    }

    // 詳細を開いたノードを見える所へ寄せる。枝が閉じていれば開き、画面の外なら中央まで動かす (拡大率は変えない)
    focus(nodeId: number): void {
        if (!this.diagram) return;
        this.api?.revealNode(nodeId);
        this.api?.refreshDecorations();
        requestAnimationFrame(() => {
            const box = this.canvas.querySelector(`.mdag-node[data-id="${nodeId}"] .mdag-box`);
            if (!box || !this.diagram) return;
            const node = box.getBoundingClientRect();
            const area = this.canvas.getBoundingClientRect();
            const margin = 48;
            const inside = node.left >= area.left + margin && node.right <= area.right - margin && node.top >= area.top + margin && node.bottom <= area.bottom - margin;
            if (inside) return;
            this.diagram.view.panBy(area.left + area.width / 2 - (node.left + node.width / 2), area.top + area.height / 2 - (node.top + node.height / 2));
        });
    }

    private hooks(): HookModule {
        return {
            onDocument: (context) => {
                this.api = context.api;
            },
            decorateNode: (context) => {
                const ctx = this.ctx();
                const issue = ctx.workspace.issues.get(context.node.id);
                if (!issue || issue.key !== context.node.refId) return null;
                const classes: string[] = [];
                const blocked = issue.openBlockers.length > 0 && (issue.state === 'todo' || issue.state === 'doing');
                if (blocked) classes.push('otm-blocked');
                if (ctx.selected === issue.nodeId) classes.push('otm-selected');
                return {
                    className: classes.join(' '),
                    badge: issue.key ?? '詳細',
                    title: blocked ? `先に終えるもの: ${issue.openBlockers.map((id) => ctx.workspace.issues.get(id)?.key).join(', ')}` : undefined,
                };
            },
        };
    }
}

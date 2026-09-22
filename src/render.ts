// Markdown の文字列を受け取り、渡された要素の中に図を描く。
// 解析、モデルの組み立て、描画をつなぎ、スタイルシートの差し込みと、数式やコードの色付けに要る外部のスタイルシートの読み込みを受け持つ。
// 原文はここが持ち、タスクの項目のクリックでは原文を書き換えて描き直す。変換器は呼び出し側から受け取る。
import type { PlacedEdge } from './layout/layout';
import { createHookDocument, HookRunner, type HookApi, type HookDocument, type HookEdge, type HookEvent, type HookGroup, type HookModule, type ResolvedHook } from './model/hooks';
import { buildModel, type Diagnostic, type GraphModel, type ModelOptions } from './model/model';
import { parseDocument, toggleTask, type ParseOptions } from './parse/document';
import styleSheet from './style.css?inline';
import { MarkdagView, type ViewHooks, type ViewOptions } from './view/view';

export interface RenderOptions extends Partial<ViewOptions>, ParseOptions, ModelOptions, Pick<ViewHooks, 'onFoldChange' | 'onLayout' | 'onTransform'> {
    // 図のスタイルシートを、ページの head に差し込むか。自分でスタイルシートを読み込むページでは false にする
    injectStyle?: boolean;
    // タスクの項目のクリックなどで、原文が書き換わったときに呼ぶ
    onChange?: (markdown: string) => void;
    // 呼び出し側のコードが直接渡すフック。文書の宣言 (markdag.hooks) とは関係なく動き、宣言したフックのあとに呼ばれる
    hooks?: HookModule | HookModule[];
    // フックの実行中に出た診断 (操作の取りやめ、フックの失敗)。描いた時点の診断は update の戻り値と diagnostics が持つ
    onDiagnostic?: (diagnostic: Diagnostic) => void;
    onHookError?: (error: unknown, info: { event: HookEvent; ref: string }) => void;
}

export interface MarkdagDiagram {
    readonly view: MarkdagView;
    // 最後に描いた文書の診断
    readonly diagnostics: Diagnostic[];
    // 文書を差し替えて描き直す。今のズームとパンは保つ
    update(markdown: string): Diagnostic[];
    fit(): void;
    expandAll(): void;
    resetFold(): void;
    destroy(): void;
}

// 原文の 1 行 (0 始まり)。範囲の外は null
const lineAt = (text: string, index: number): string | null => text.split(/\r?\n/)[index] ?? null;

const STYLE_MARK = 'data-markdag-style';
const ASSET_MARK = 'data-markdag-asset';
// 高さのない要素に描くと何も見えないので、そのときに与える高さ
const FALLBACK_HEIGHT = '480px';

function injectStyleSheet(): void {
    if (document.head.querySelector(`style[${STYLE_MARK}]`)) return;
    const style = document.createElement('style');
    style.setAttribute(STYLE_MARK, '');
    style.textContent = styleSheet;
    document.head.append(style);
}

// 数式とコードの色付けのスタイルシートは、文書が使っているときだけ外部から読み込む
function loadStyleUrls(urls: string[]): void {
    for (const url of urls) {
        if (document.head.querySelector(`link[${ASSET_MARK}="${CSS.escape(url)}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.setAttribute(ASSET_MARK, url);
        document.head.append(link);
    }
}

// 診断を、人にも AI にも渡せる文字にする。1 件 1 行で、位置 (行:桁) を付け、直し方の手がかりは次の行に字下げして添える
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
    return diagnostics
        .map((item) => {
            const place = item.at ? `${item.at.line}:${item.at.column} ` : '';
            return `${item.severity} ${item.code} ${place}${item.message}${item.hint ? `\n    ${item.hint}` : ''}`;
        })
        .join('\n');
}

export function render(container: HTMLElement, markdown: string, options: RenderOptions): MarkdagDiagram {
    const { injectStyle = true, onChange, transformer, onFoldChange, onLayout, onTransform, types, hookRefs, hooks, onDiagnostic, onHookError, ...viewOptions } = options;
    if (injectStyle) injectStyleSheet();

    // 文書に書かれたままの原文。タスクの切り替えと update が書き換えるのはこちら
    let source = markdown;
    // transformSource が差し替えたあとの、実際に解析して描いた文。フックがなければ原文と同じ
    let rendered = markdown;
    let diagnostics: Diagnostic[] = [];
    let current: GraphModel | null = null;
    // 最後に描いた文書の窓口。フックに渡すのはこれで、図の内部の構造は渡さない。
    // 最初の transformSource はまだ何も描いていない時点で呼ぶので、空の文書を入れておく
    let hookDoc: HookDocument = createHookDocument({ nodes: [], model: buildModel([], {}), frontmatter: {}, source: () => source, folded: () => [], diagnostics: () => diagnostics });
    // 呼び出し側が直接渡したフックは、文書が宣言したフックのあとに呼ぶ (アプリ側が最後に判断できるようにする)
    const ownHooks: ResolvedHook[] = (Array.isArray(hooks) ? hooks : hooks ? [hooks] : []).map((module, index) => ({ ref: `render の hooks[${index}]`, module }));
    const api: HookApi = {
        focusNode: (id, scale) => view.focusNode(id, scale ?? view.getTransform().k),
        refreshDecorations: () => view.refreshDecorations(),
        revealNode: (id) => view.revealNode(id),
        setFolded: (ids) => view.setFolded(ids),
        getFolded: () => view.getFolded(),
        fit: () => view.fit(),
        getTransform: () => view.getTransform(),
        setTransform: (transform) => view.setTransform(transform),
        update: (next) => {
            source = next;
            draw(false);
            onChange?.(source);
        },
    };
    const runner = new HookRunner({ doc: () => hookDoc, api, onDiagnostic, onError: onHookError });
    // 図の内部の線とグループを、フックに渡す形に直す。端点が今の文書にないものは渡さない
    const hookEdge = (placed: PlacedEdge | null): HookEdge | null => {
        if (placed === null) return null;
        const from = hookDoc.node(placed.edge.source);
        const to = hookDoc.node(placed.edge.target);
        return from && to ? { kind: placed.edge.kind, from, to, proxied: placed.edge.proxied } : null;
    };
    const hookGroup = (id: string | null): HookGroup | null => {
        if (id === null) return null;
        const def = current?.groups.find((group) => group.id === id);
        const members = [...(current?.groupsOf ?? [])].flatMap(([node, ids]) => (ids.includes(id) ? [node] : []));
        return { id, label: def?.label ?? id, color: def?.color ?? null, members };
    };

    const draw = (fit: boolean): Diagnostic[] => {
        // 使うフックは文書の frontmatter が決めるので、まず原文を読んでフックをそろえる
        let parsed = parseDocument(source, { transformer });
        let model = buildModel(parsed.nodes, parsed.frontmatter, source, { types, hookRefs });
        runner.setHooks([...model.hooks.hooks, ...ownHooks], model.hooks.options);
        // transformSource が原文を差し替えたときだけ、差し替えたほうで読み直す
        rendered = runner.transform(source);
        if (rendered !== source) {
            parsed = parseDocument(rendered, { transformer });
            model = buildModel(parsed.nodes, parsed.frontmatter, rendered, { types, hookRefs });
            runner.setHooks([...model.hooks.hooks, ...ownHooks], model.hooks.options);
        }
        // frontmatter に markdag のキーがない文書は markmap と同じ表示になり、タグや $id は文字のまま残る。
        // 書き手が気づけるよう、診断として知らせる
        const notes: Diagnostic[] = parsed.extracted
            ? []
            : [
                  {
                      severity: 'info',
                      code: 'not-extracted',
                      message: 'frontmatter に markdag のキーがないので、タグや $id の抽出は行っていません (markmap と同じ表示)',
                      at: null,
                      hint: null,
                  },
              ];
        loadStyleUrls(parsed.styleUrls);
        diagnostics = [...model.diagnostics, ...notes];
        current = model;
        hookDoc = createHookDocument({
            nodes: parsed.nodes,
            model,
            frontmatter: parsed.frontmatter,
            source: () => source,
            folded: () => view.getFolded(),
            diagnostics: () => diagnostics,
        });
        view.setDocument(parsed, model, fit);
        runner.emit('onDocument', {});
        return diagnostics;
    };

    const view = new MarkdagView(container, {
        onToggleTask: (node) => {
            if (!node.task) return;
            const { line, checked } = node.task;
            // 行は差し替えたほうの文で数えている。原文の同じ行が違う内容なら、書き換える先を決められない
            if (rendered !== source && lineAt(rendered, line) !== lineAt(source, line)) {
                onDiagnostic?.({
                    severity: 'info',
                    code: 'hook-rejected',
                    message: 'transformSource が原文の行をずらしているので、このタスクは切り替えられません',
                    at: null,
                    hint: '原文の行を保ったまま書き換えるか (足すなら末尾に足す)、タスクを切り替えない文書にします',
                });
                return;
            }
            const target = hookDoc.node(node.id);
            if (target && !runner.before('beforeTaskToggle', { node: target, next: !checked, line }, true)) return;
            source = toggleTask(source, line);
            draw(false);
            onChange?.(source);
            const toggled = hookDoc.node(node.id);
            if (toggled) runner.emit('onTaskToggle', { node: toggled, next: !checked, line }, true);
        },
        onNodeClick: (node, asTaskToggle) => {
            const target = hookDoc.node(node.id);
            if (target) runner.emit('onNodeClick', { node: target, asTaskToggle }, true);
        },
        beforeFold: (node, folded) => {
            const target = hookDoc.node(node.id);
            return target === null || runner.before('beforeFold', { node: target, folded }, true);
        },
        beforeSelectEdge: (edge, byUser) => runner.before('beforeSelectEdge', { edge: hookEdge(edge) }, byUser),
        onSelectEdge: (edge, byUser) => runner.emit('onSelectEdge', { edge: hookEdge(edge) }, byUser),
        beforeSelectGroup: (id, byUser) => runner.before('beforeSelectGroup', { group: hookGroup(id) }, byUser),
        onSelectGroup: (id, byUser) => runner.emit('onSelectGroup', { group: hookGroup(id) }, byUser),
        beforeDetailsShow: (node, pinned, byUser) => {
            const target = hookDoc.node(node.id);
            return target === null || runner.before('beforeDetailsShow', { node: target, pinned }, byUser);
        },
        onDetailsShow: (node, pinned, byUser) => {
            const target = hookDoc.node(node.id);
            if (target) runner.emit('onDetailsShow', { node: target, pinned }, byUser);
        },
        onDetailsHide: (node, pinned) => {
            const target = hookDoc.node(node.id);
            if (target) runner.emit('onDetailsHide', { node: target, pinned });
        },
        decorateNode: (node) => {
            const target = hookDoc.node(node.id);
            return target === null ? null : runner.decorate(target);
        },
        onFoldChange: (folded, byUser) => {
            onFoldChange?.(folded, byUser);
            runner.emit('onFoldChange', { folded }, byUser);
        },
        onTransform: (transform, byUser) => {
            onTransform?.(transform, byUser);
            runner.emit('onTransform', { transform }, byUser);
        },
        onLayout: (snapshot) => {
            onLayout?.(snapshot);
            const { totalNodes, visibleNodes, layoutMs, excludedEdges } = snapshot;
            runner.emit('onLayout', { layout: { totalNodes, visibleNodes, layoutMs, excludedEdges } });
        },
    });
    if (container.clientHeight === 0) container.style.height = FALLBACK_HEIGHT;
    view.setOptions(viewOptions);
    draw(true);

    return {
        view,
        get diagnostics() {
            return diagnostics;
        },
        update(next: string) {
            if (!runner.before('beforeUpdate', { next, previous: source })) return diagnostics;
            source = next;
            return draw(false);
        },
        fit: () => view.fit(),
        expandAll: () => view.expandAll(),
        resetFold: () => view.resetFold(),
        destroy: () => {
            runner.emit('onDestroy', {});
            view.destroy();
        },
    };
}

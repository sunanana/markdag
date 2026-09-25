// フックと規則の配線。parseDocument → buildModel → MarkdagView を自分でつなぐアプリ向けに、
// render() の中にあった「view の受け口とフックの呼び出しの橋渡し」を 1 つの部品にしたもの。render() もこれを使う。
// 本文はアプリが持ち、書き換えと描き直しもアプリが行う。ここは、view から来た操作を before 系にかけ、
// アプリの受け口を呼び、on 系で知らせる順序と、フックに渡す文書の写しの作り直しを受け持つ。
import type { PlacedEdge } from './layout/layout';
import { createHookDocument, HookRunner, type HookApi, type HookDocument, type HookEdge, type HookEvent, type HookGroup, type HookModule, type ResolvedHook } from './model/hooks';
import { emptyModel, type Diagnostic, type GraphModel } from './model/model';
import type { OutlineNode, ParsedDocument } from './parse/document';
import { nextTaskMark, taskMarkOf, taskStateOf } from './parse/task';
import type { MarkdagView, ViewHooks } from './view/view';

export interface HookBridgeOptions {
    // 今の本文。アプリが持つ文字列を返す
    source: () => string;
    // フックに見せる診断。省略時は最後に渡した model の diagnostics
    diagnostics?: () => readonly Diagnostic[];
    // アプリ自身のフック。文書が宣言したフック (と rules) のあとに呼ぶ
    hooks?: HookModule | HookModule[];
    // 実行中に出る診断 (取りやめ、失敗)
    onDiagnostic?: (diagnostic: Diagnostic) => void;
    onHookError?: (error: unknown, info: { event: HookEvent; ref: string }) => void;
    // ctx.api.update の宛先。アプリが本文を差し替えて描き直す (setDocument を通す)。省略すると update は使えない
    update?: (markdown: string) => void;
    // アプリ自身の view の受け口。橋渡しのものと合成して、アプリのものを先に呼ぶ。
    // onToggleTask は beforeTaskToggle を通ったときだけ呼ばれ、戻ったあとに onTaskToggle を知らせる
    viewHooks?: ViewHooks;
}

export interface HookBridge {
    // MarkdagView のコンストラクタに渡す受け口。アプリの viewHooks と合成済み
    readonly viewHooks: ViewHooks;
    // view を作ったら 1 回呼ぶ。ctx.api の宛先になる
    attach(view: MarkdagView): void;
    // 解析の前に呼ぶと、transformSource が差し替えた文を返す (フックがなければ source のまま)。
    // 使うフックは model (原文で組み立てたもの) から取る。返った文が違えば、それで解析と組み立てをやり直す
    transform(model: GraphModel, source: string): string;
    // 本文の差し替えの前に呼ぶ。false なら beforeUpdate が取りやめた
    beforeUpdate(next: string): boolean;
    // 文書を描くたびに、view.setDocument の代わりに呼ぶ。フックの入れ替え、文書の写しの作り直し、onDocument の通知を行う
    setDocument(parsed: ParsedDocument, model: GraphModel, fit?: boolean): void;
    // onDestroy を知らせて view を片付ける
    destroy(): void;
}

// 原文の 1 行 (0 始まり)。範囲の外は null
const lineAt = (text: string, index: number): string | null => text.split(/\r?\n/)[index] ?? null;

export function createHookBridge(options: HookBridgeOptions): HookBridge {
    const { source, viewHooks: own = {} } = options;
    let view: MarkdagView | null = null;
    let current: GraphModel | null = null;
    // transformSource が差し替えたあとの、実際に解析して描いた文。フックがなければ原文と同じ
    let rendered = source();
    let transformed: string | null = null;
    // 最後に描いた文書の窓口。最初の transformSource はまだ何も描いていない時点で呼ぶので、空の文書を入れておく。
    // 空のモデルは wasm を呼ばずに作る (wasm の init の前でも橋渡しを作れるように)
    let doc: HookDocument = createHookDocument({ nodes: [], model: emptyModel(), frontmatter: {}, source, folded: () => [], diagnostics: () => [] });
    // アプリが直接渡したフックは、文書が宣言したフックのあとに呼ぶ (アプリが最後に判断できるようにする)
    const ownHooks: ResolvedHook[] = (Array.isArray(options.hooks) ? options.hooks : options.hooks ? [options.hooks] : []).map((module, index) => ({ ref: `アプリの hooks[${index}]`, module }));

    const api: HookApi = {
        focusNode: (id, scale) => view?.focusNode(id, scale ?? view.getTransform().k),
        refreshDecorations: () => view?.refreshDecorations(),
        revealNode: (id) => view?.revealNode(id),
        setFolded: (ids) => view?.setFolded(ids),
        getFolded: () => view?.getFolded() ?? [],
        fit: () => view?.fit(),
        getTransform: () => view?.getTransform() ?? { x: 0, y: 0, k: 1 },
        setTransform: (transform) => view?.setTransform(transform),
        update: (next) => {
            if (options.update) options.update(next);
            else options.onDiagnostic?.({ severity: 'warning', code: 'hook-failed', message: 'このアプリは api.update を受け付けていないので、本文は差し替えません', at: null, hint: 'createHookBridge の update に、本文を差し替えて描き直す関数を渡します' });
        },
    };
    const runner = new HookRunner({ doc: () => doc, api, onDiagnostic: options.onDiagnostic, onError: options.onHookError });
    const setHooks = (model: GraphModel): void => runner.setHooks([...model.hooks.hooks, ...ownHooks], model.hooks.options);

    // 図の内部の線とグループを、フックに渡す形に直す。端点が今の文書にないものは渡さない
    const hookEdge = (placed: PlacedEdge | null): HookEdge | null => {
        if (placed === null) return null;
        const from = doc.node(placed.edge.source);
        const to = doc.node(placed.edge.target);
        return from && to ? { kind: placed.edge.kind, from, to, proxied: placed.edge.proxied } : null;
    };
    const hookGroup = (id: string | null): HookGroup | null => {
        if (id === null) return null;
        const def = current?.groups.find((group) => group.id === id);
        const members = [...(current?.groupsOf ?? [])].flatMap(([node, ids]) => (ids.includes(id) ? [node] : []));
        return { id, label: def?.label ?? id, color: def?.color ?? null, members };
    };
    const nodeOf = (node: OutlineNode) => doc.node(node.id);

    const viewHooks: ViewHooks = {
        onToggleTask: (node, cycle) => {
            if (!node.task) return;
            const { line, state } = node.task;
            const nextMark = nextTaskMark(taskMarkOf(state), cycle);
            // 順にない状態 (中止など) は原文を編集して変えるもので、クリックでは変えない
            if (nextMark === null) {
                options.onDiagnostic?.({
                    severity: 'info',
                    code: 'hook-rejected',
                    message: `「${node.refText}」の状態 [${taskMarkOf(state)}] は、クリックで進む順 (markdag.tasks.cycle) にないので変えられません`,
                    at: null,
                    hint: '原文の記号を書き換えるか、markdag.tasks.cycle にその記号を足します',
                });
                return;
            }
            const nextState = taskStateOf(nextMark);
            // 行は差し替えたほうの文で数えている。原文の同じ行が違う内容なら、書き換える先を決められない
            if (rendered !== source() && lineAt(rendered, line) !== lineAt(source(), line)) {
                options.onDiagnostic?.({
                    severity: 'info',
                    code: 'hook-rejected',
                    message: 'transformSource が原文の行をずらしているので、このタスクは切り替えられません',
                    at: null,
                    hint: '原文の行を保ったまま書き換えるか (足すなら末尾に足す)、タスクを切り替えない文書にします',
                });
                return;
            }
            const target = nodeOf(node);
            if (target && !runner.before('beforeTaskToggle', { node: target, next: nextState === 'done', nextState, line }, true)) return;
            own.onToggleTask?.(node, cycle);
            const toggled = nodeOf(node);
            if (toggled) runner.emit('onTaskToggle', { node: toggled, next: nextState === 'done', nextState, line }, true);
        },
        onNodeClick: (node, asTaskToggle) => {
            own.onNodeClick?.(node, asTaskToggle);
            const target = nodeOf(node);
            if (target) runner.emit('onNodeClick', { node: target, asTaskToggle }, true);
        },
        beforeFold: (node, folded) => {
            if (own.beforeFold?.(node, folded) === false) return false;
            const target = nodeOf(node);
            return target === null || runner.before('beforeFold', { node: target, folded }, true);
        },
        beforeSelectEdge: (edge, byUser) => own.beforeSelectEdge?.(edge, byUser) !== false && runner.before('beforeSelectEdge', { edge: hookEdge(edge) }, byUser),
        onSelectEdge: (edge, byUser) => {
            own.onSelectEdge?.(edge, byUser);
            runner.emit('onSelectEdge', { edge: hookEdge(edge) }, byUser);
        },
        beforeSelectGroup: (id, byUser) => own.beforeSelectGroup?.(id, byUser) !== false && runner.before('beforeSelectGroup', { group: hookGroup(id) }, byUser),
        onSelectGroup: (id, byUser) => {
            own.onSelectGroup?.(id, byUser);
            runner.emit('onSelectGroup', { group: hookGroup(id) }, byUser);
        },
        beforeDetailsShow: (node, pinned, byUser) => {
            if (own.beforeDetailsShow?.(node, pinned, byUser) === false) return false;
            const target = nodeOf(node);
            return target === null || runner.before('beforeDetailsShow', { node: target, pinned }, byUser);
        },
        onDetailsShow: (node, pinned, byUser) => {
            own.onDetailsShow?.(node, pinned, byUser);
            const target = nodeOf(node);
            if (target) runner.emit('onDetailsShow', { node: target, pinned }, byUser);
        },
        onDetailsHide: (node, pinned) => {
            own.onDetailsHide?.(node, pinned);
            const target = nodeOf(node);
            if (target) runner.emit('onDetailsHide', { node: target, pinned });
        },
        decorateNode: (node) => {
            const target = nodeOf(node);
            const decoration = target === null ? null : runner.decorate(target);
            // アプリの飾りは、フックの飾りより優先する
            return own.decorateNode?.(node) ?? decoration;
        },
        onFoldChange: (folded, byUser) => {
            own.onFoldChange?.(folded, byUser);
            runner.emit('onFoldChange', { folded }, byUser);
        },
        onTransform: (transform, byUser) => {
            own.onTransform?.(transform, byUser);
            runner.emit('onTransform', { transform }, byUser);
        },
        onLayout: (snapshot) => {
            own.onLayout?.(snapshot);
            const { totalNodes, visibleNodes, layoutMs, excludedEdges } = snapshot;
            runner.emit('onLayout', { layout: { totalNodes, visibleNodes, layoutMs, excludedEdges } });
        },
    };

    return {
        viewHooks,
        attach: (target) => {
            view = target;
        },
        transform: (model, text) => {
            setHooks(model);
            transformed = runner.transform(text);
            return transformed;
        },
        beforeUpdate: (next) => runner.before('beforeUpdate', { next, previous: source() }),
        setDocument: (parsed, model, fit = true) => {
            setHooks(model);
            // transform を通さずに描いたときは、原文をそのまま描いたことになる
            rendered = transformed ?? source();
            transformed = null;
            current = model;
            doc = createHookDocument({
                nodes: parsed.nodes,
                model,
                frontmatter: parsed.frontmatter,
                source,
                folded: () => view?.getFolded() ?? [],
                diagnostics: () => options.diagnostics?.() ?? model.diagnostics,
            });
            view?.setDocument(parsed, model, fit);
            runner.emit('onDocument', {});
        },
        destroy: () => {
            runner.emit('onDestroy', {});
            view?.destroy();
            view = null;
        },
    };
}

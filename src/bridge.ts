// フックと規則の配線。parseDocument → buildModel → MarkdagView を自分でつなぐアプリ向けに、
// render() の中にあった「view の受け口とフックの呼び出しの橋渡し」を 1 つの部品にしたもの。render() もこれを使う。
// 本文はアプリが持ち、書き換えと描き直しもアプリが行う。ここは、view から来た操作を before 系にかけ、
// アプリの受け口を呼び、on 系で知らせる順序と、フックに渡す文書の写しの作り直しを受け持つ。
// render が使う橋渡し (公開しない) は、いくつかのタスクを印のクリックと同じ確かめで上流から見てから、1 回の書き換えで進める口も持つ
import type { PlacedEdge } from './layout/layout';
import { createHookDocument, HookRunner, upstreamIdsOf, type HookApi, type HookDocument, type HookDocumentInput, type HookEdge, type HookEvent, type HookGroup, type HookModule, type ResolvedHook } from './model/hooks';
import { emptyModel, type Diagnostic, type GraphModel } from './model/model';
import type { OutlineNode, ParsedDocument } from './parse/document';
import { nextTaskMark, taskMarkOf, taskStateOf, type TaskMark, type TaskState } from './parse/task';
import { IconResolution, type IconResolver } from './view/icon-resolver';
import { documentIconRefs } from './view/icons';
import { callAddedToggleTask, type MarkdagView, type ViewHooks } from './view/view';

export interface HookBridgeOptions {
    // 今の本文。アプリが持つ文字列を返す
    source: () => string;
    // フックに見せる診断。省略時は最後に渡した model の diagnostics
    diagnostics?: () => readonly Diagnostic[];
    // アプリ自身のフック。文書が宣言したフック (と rules) のあとに呼ぶ
    hooks?: HookModule | HookModule[];
    // ロゴの SVG を引く関数 (ref は set:name か相対パス)。同期で返せば最初の描画から入り、Promise なら解決後にそのロゴを使う所だけ描き直す。
    // null、SVG として読めない文字列、reject、throw は引けなかった (文字のまま) として、onDiagnostic に icon-unresolved (warning) を知らせる。
    // 同じ ref は 1 度だけ問い合わせる。省くとロゴを引かない (文字のまま)
    resolveIcon?: IconResolver;
    // 実行中に出る診断 (取りやめ、失敗、ロゴの解決の失敗)
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
    // 文書を描くたびに、view.setDocument の代わりに呼ぶ。フックの入れ替え、文書の写しの作り直し、ロゴの問い合わせ、onDocument の通知を行う
    setDocument(parsed: ParsedDocument, model: GraphModel, fit?: boolean): void;
    // onDestroy を知らせて view を片付ける
    destroy(): void;
}

// render が使う橋渡し。公開の HookBridge に、いくつかのタスクをまとめて進める口を足したもの (入口からは出さない。
// 公開の口は render の MarkdagDiagram.toggleTasks)
export interface RenderBridge extends HookBridge {
    // nodes のタスクを、印のクリックと同じ確かめ (クリックで進む順、transformSource の行、beforeTaskToggle) で、relations の上流から
    // 順に見て (上流と下流の関係のないもの同士は文書の順)、全部通れば rewrite を 1 回呼んでから、タスクごとに onTaskToggle を知らせて true。
    // 断られたらそこで確かめをやめ (残りのタスクの beforeTaskToggle は呼ばない)、rewrite を呼ばずに false (知らせは断られた 1 件の理由だけで、
    // 印のクリックと同じく onDiagnostic に出る)。タスクでないノードは飛ばし、タスクがなければ false。
    // 2 つ目からは、前のタスクを進めた結果の文書で確かめる (上流と下流を一緒に進めれば、下流は上流を終えた結果で確かめる)。
    // 最後に、印のクリックと同じく、アプリが view に足した onToggleTask をタスクごとに確かめの順で呼ぶ (進めたときは描き直したあと。
    // 取りやめたときも呼ぶ)
    toggleTasks(nodes: readonly OutlineNode[], cycle: readonly TaskMark[], rewrite: () => void): boolean;
}

// 印のクリックの確かめを通ったタスクの、onTaskToggle に渡す中身
interface TaskToggle {
    nextState: TaskState;
    line: number;
}

// まとめて進めるときに確かめる順。選んだタスクの中で、上流 (markdag.rules の requireUpstreamDone が見るもの) にあるものを先にし、
// 上流と下流の関係のないもの同士は文書の順。どちらの順も満たせない並び (文書の順が 実装、メモ、設計 で 設計 --> 実装) は、
// 選んだタスクの中にまだ確かめていない上流を持たないもののうち、文書で先のものから取る (メモ、設計、実装)。
// relations の循環で取れなくなったら、残りは文書の順。
// 選んだタスクの間の線 (どれがどれの上流か) は 1 回だけ数え、まだ取っていない上流の数と、取れるものを文書の順で出す待ち行列で並べる
function upstreamFirst(doc: HookDocument, nodes: readonly OutlineNode[]): OutlineNode[] {
    const sorted = [...nodes].sort((a, b) => a.id - b.id);
    // 選んだタスクの、文書の順の位置
    const positions = new Map(sorted.map((node, at) => [node.id, at]));
    // downstream[i] は i を上流に持つ選んだタスク (の位置)、waiting[i] は i のまだ取っていない上流の数
    const downstream: number[][] = sorted.map(() => []);
    const waiting = sorted.map((node, at) => {
        let count = 0;
        for (const id of upstreamIdsOf(doc, node.id)) {
            const from = positions.get(id);
            if (from === undefined || from === at) continue;
            downstream[from]?.push(at);
            count += 1;
        }
        return count;
    });
    const ready = new PositionQueue();
    waiting.forEach((count, at) => {
        if (count === 0) ready.push(at);
    });
    const ordered: OutlineNode[] = [];
    const taken = new Set<number>();
    for (let at = ready.pop(); at !== undefined; at = ready.pop()) {
        const node = sorted[at];
        if (node === undefined) continue;
        taken.add(at);
        ordered.push(node);
        for (const next of downstream[at] ?? []) {
            const left = (waiting[next] ?? 0) - 1;
            waiting[next] = left;
            if (left === 0) ready.push(next);
        }
    }
    return taken.size === sorted.length ? ordered : [...ordered, ...sorted.filter((_, at) => !taken.has(at))];
}

// 小さい位置から取り出す待ち行列 (二分ヒープ)。取れるタスクを文書の順に出すのに使う
class PositionQueue {
    private readonly items: number[] = [];

    push(position: number): void {
        const items = this.items;
        let at = items.push(position) - 1;
        while (at > 0) {
            const parent = (at - 1) >> 1;
            const above = items[parent] ?? position;
            if (above <= position) break;
            items[at] = above;
            at = parent;
        }
        items[at] = position;
    }

    // 最も小さい位置。空なら undefined
    pop(): number | undefined {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (top === undefined || last === undefined || items.length === 0) return top;
        let at = 0;
        for (;;) {
            const left = at * 2 + 1;
            if (left >= items.length) break;
            const right = left + 1;
            const child = right < items.length && (items[right] ?? last) < (items[left] ?? last) ? right : left;
            const smaller = items[child] ?? last;
            if (smaller >= last) break;
            items[at] = smaller;
            at = child;
        }
        items[at] = last;
        return top;
    }
}

// 原文の 1 行 (0 始まり)。範囲の外は null
const lineAt = (text: string, index: number): string | null => text.split(/\r?\n/)[index] ?? null;

// 診断の文に出すノードの呼び名。名前 (refText) を持たないノード (1 行目が空の項目など) は $id か「名前のないノード」
function nodeLabel(node: OutlineNode): string {
    if (node.refText) return `「${node.refText}」`;
    return node.refId ? `「$${node.refId}」` : '名前のないノード';
}

export function createHookBridge(options: HookBridgeOptions): HookBridge {
    // まとめて進める口は render だけが使うので、公開の橋渡しからは外す
    const { toggleTasks: _toggleTasks, ...bridge } = createRenderBridge(options);
    return bridge;
}

export function createRenderBridge(options: HookBridgeOptions): RenderBridge {
    const { source, viewHooks: own = {} } = options;
    let view: MarkdagView | null = null;
    let current: GraphModel | null = null;
    // transformSource が差し替えたあとの、実際に解析して描いた文。フックがなければ原文と同じ
    let rendered = source();
    let transformed: string | null = null;
    // 最後に描いた文書の窓口。最初の transformSource はまだ何も描いていない時点で呼ぶので、空の文書を入れておく。
    // 空のモデルは wasm を呼ばずに作る (wasm の init の前でも橋渡しを作れるように)
    let docInput: HookDocumentInput = { nodes: [], model: emptyModel(), frontmatter: {}, source, folded: () => [], diagnostics: () => [] };
    let doc: HookDocument = createHookDocument(docInput);
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
    // 結果は view の置き場へ入れる。view を付ける前に済んだものは attach で入れ直す
    const icons = options.resolveIcon
        ? new IconResolution({ resolve: options.resolveIcon, deliver: (ref, svg) => view?.setIconSvg(ref, svg), onDiagnostic: options.onDiagnostic })
        : null;

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

    // 印のクリックの確かめ: クリックで進む順に今の状態があるか、transformSource が行をずらしていないか、beforeTaskToggle。
    // 通れば onTaskToggle に渡す中身、通らなければ理由を onDiagnostic に知らせて (beforeTaskToggle は HookRunner が知らせる) null
    const taskToggleOf = (node: OutlineNode, cycle: readonly TaskMark[]): TaskToggle | null => {
        if (!node.task) return null;
        const { line, state } = node.task;
        const nextMark = nextTaskMark(taskMarkOf(state), cycle);
        // 順にない状態 (中止など) は原文を編集して変えるもので、クリックでは変えない
        if (nextMark === null) {
            options.onDiagnostic?.({
                severity: 'info',
                code: 'hook-rejected',
                message: `${nodeLabel(node)}の状態 [${taskMarkOf(state)}] は、クリックで進む順 (markdag.tasks.cycle) にないので変えられません`,
                at: null,
                hint: '原文の記号を書き換えるか、markdag.tasks.cycle にその記号を足します',
            });
            return null;
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
            return null;
        }
        const target = nodeOf(node);
        if (target && !runner.before('beforeTaskToggle', { node: target, next: nextState === 'done', nextState, line }, true)) return null;
        return { nextState, line };
    };
    // 書き換えて描き直したあとに、onTaskToggle を知らせる (描き直した文書のそのノード)
    const announceToggle = (node: OutlineNode, toggle: TaskToggle): void => {
        const toggled = nodeOf(node);
        if (toggled) runner.emit('onTaskToggle', { node: toggled, next: toggle.nextState === 'done', nextState: toggle.nextState, line: toggle.line }, true);
    };

    const viewHooks: ViewHooks = {
        onToggleTask: (node, cycle) => {
            const toggle = taskToggleOf(node, cycle);
            if (toggle === null) return;
            own.onToggleTask?.(node, cycle);
            announceToggle(node, toggle);
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
        // 図の出口の受け口 (押下とクリック、ロゴの到着) は、アプリの受け口へそのまま通す。文書のフックの出来事にはしない
        onNodePointerDown: (node, event) => own.onNodePointerDown?.(node, event),
        onNodeDoubleClick: (node, place, event) => own.onNodeDoubleClick?.(node, place, event),
        onTagClick: (node, key, place, event) => own.onTagClick?.(node, key, place, event),
        onEdgeClick: (edge, event) => own.onEdgeClick?.(edge, event),
        onFrameClick: (...args) => own.onFrameClick?.(...args),
        onFrameDoubleClick: (...args) => own.onFrameDoubleClick?.(...args),
        onCanvasPointerDown: (event, target) => own.onCanvasPointerDown?.(event, target),
        onCanvasClick: (event) => own.onCanvasClick?.(event),
        onIconSvg: (ref) => own.onIconSvg?.(ref),
    };

    return {
        viewHooks,
        // 確かめの間だけ、フックに見せる文書を、前のタスクを進めた状態にした写しに替える (原文は 1 回で書き換える)。
        // 断られたらそこでやめ、残りのタスクは確かめない (アプリのフックを余分に呼ばず、知らせは最初に断られた理由だけにする)
        toggleTasks: (nodes, cycle, rewrite) => {
            const drawn = doc;
            const ordered = upstreamFirst(drawn, nodes.filter((node) => node.task !== null));
            const toggles: Array<{ node: OutlineNode; toggle: TaskToggle }> = [];
            try {
                let shown = docInput.nodes;
                for (const node of ordered) {
                    const toggle = taskToggleOf(node, cycle);
                    if (toggle === null) break;
                    toggles.push({ node, toggle });
                    shown = shown.map((item) => (item.id === node.id && item.task ? { ...item, task: { ...item.task, state: toggle.nextState, checked: toggle.nextState === 'done' } } : item));
                    doc = createHookDocument({ ...docInput, nodes: shown });
                }
            } finally {
                doc = drawn;
            }
            const toggled = ordered.length > 0 && toggles.length === ordered.length;
            if (toggled) {
                rewrite();
                for (const { node, toggle } of toggles) announceToggle(node, toggle);
            }
            if (view !== null) for (const node of ordered) callAddedToggleTask(view, node, cycle);
            return toggled;
        },
        attach: (target) => {
            view = target;
            for (const [ref, svg] of icons?.settled() ?? []) target.setIconSvg(ref, svg);
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
            docInput = {
                nodes: parsed.nodes,
                model,
                frontmatter: parsed.frontmatter,
                source,
                folded: () => view?.getFolded() ?? [],
                diagnostics: () => options.diagnostics?.() ?? model.diagnostics,
            };
            doc = createHookDocument(docInput);
            // 同期で返ったロゴは、ここで置き場に入るので最初の描画から入る
            icons?.request(documentIconRefs(parsed.nodes, model));
            view?.setDocument(parsed, model, fit);
            runner.emit('onDocument', {});
        },
        destroy: () => {
            icons?.dispose();
            runner.emit('onDestroy', {});
            view?.destroy();
            view = null;
        },
    };
}

// フックの仕組み。文書 (frontmatter の markdag.hooks) は「どのフックを使うか」を名前で宣言するだけで、
// ファイルの解決と読み込みは呼び出し側が行う。この層は、宣言と渡された実体の突き合わせ、予約された名前の検証、
// 呼び出しの順序と取りやめの扱いを受け持つ。DOM にも view にも依存せず、図への操作は呼び出し側が渡す api 越しに行う。
// フックはページの JS としてそのまま動く。隔離はしていないので、読み込むかどうかの判断は呼び出し側に置く。
import type { RelationKind } from '../layout/input-types';
import type { OutlineNode } from '../parse/document';
import type { TaskState } from '../parse/task';
import type { Diagnostic, GraphModel } from './model';
import { closest, isRecord } from './util';

// 事前に呼ぶフック。false を返すと、その操作を取りやめる
export const BEFORE_HOOKS = ['beforeUpdate', 'beforeTaskToggle', 'beforeFold', 'beforeSelectEdge', 'beforeSelectGroup', 'beforeDetailsShow'] as const;
// 事後に呼ぶフック。戻り値は見ない
export const ON_HOOKS = [
    'onDocument',
    'onNodeClick',
    'onTaskToggle',
    'onFoldChange',
    'onSelectEdge',
    'onSelectGroup',
    'onDetailsShow',
    'onDetailsHide',
    'onTransform',
    'onLayout',
    'onDestroy',
] as const;

// 値を返すフック。図に反映するものをデータで返す (DOM は触らせない)
export const VALUE_HOOKS = ['transformSource', 'decorateNode'] as const;

export type BeforeHookEvent = (typeof BEFORE_HOOKS)[number];
export type OnHookEvent = (typeof ON_HOOKS)[number];
export type ValueHookEvent = (typeof VALUE_HOOKS)[number];
export type HookEvent = BeforeHookEvent | OnHookEvent | ValueHookEvent;

// フックのファイルが export してよい名前。これ以外の名前の関数は、書き間違いとして警告にする
export const HOOK_EVENTS: HookEvent[] = [...BEFORE_HOOKS, ...ON_HOOKS, ...VALUE_HOOKS];

const isBeforeEvent = (event: HookEvent): event is BeforeHookEvent => (BEFORE_HOOKS as readonly string[]).includes(event);

// フックの中から起こした変更で、さらにフックが動くときの入れ子の上限。超えたら打ち切る
const MAX_DEPTH = 4;

// 図の表示位置 (view の ViewTransform と同じ形)
export interface HookTransform {
    x: number;
    y: number;
    k: number;
}

// 配置のやり直し 1 回分の数値。内部の構造 (矩形や見えているグラフ) は渡さない
export interface HookLayoutInfo {
    totalNodes: number;
    visibleNodes: number;
    layoutMs: number;
    excludedEdges: number;
}

// フックに見せるノード。内部の OutlineNode そのものではなく、書き換えても図に影響しない写し。
// html を渡さないのは、フックから DOM の文字列をいじる動機を作らないため
export interface HookNode {
    id: number;
    refId: string | null;
    // 参照用のテキスト (1 行目の、装飾を除いた文字)
    text: string;
    depth: number;
    parent: number | null;
    children: readonly number[];
    // 継承を解決したあとのグループ
    groups: readonly string[];
    tags: ReadonlyArray<{ key: string; values: readonly string[] }>;
    task: { checked: boolean; state: TaskState; line: number } | null;
    milestone: boolean;
    lines: { start: number; end: number } | null;
    // 今の開閉の状態。閉じているノード自身は見えている (配下が見えなくなる)
    readonly folded: boolean;
    readonly visible: boolean;
}

// フックに見せる線。端点は、そのとき図に見えているノード (閉じた枝の中の端点は代表ノードに置き換わる)
export interface HookEdge {
    // tree はツリーの親子の線、それ以外は relations で足した線
    kind: 'tree' | RelationKind;
    from: HookNode;
    to: HookNode;
    // 閉じた枝のせいで、端点のどちらかが代表ノードに置き換わっているか
    proxied: boolean;
}

export interface HookGroup {
    id: string;
    label: string;
    color: string | null;
    // 属するノード (継承したものを含む)
    members: readonly number[];
}

export interface HookTraversal {
    // 直接つながるものだけでなく、たどれるものをすべて返す
    transitive?: boolean;
    // ツリーの親子の線も含める。既定は relations で足した線だけ
    tree?: boolean;
}

export interface HookDocument {
    // 今の原文
    readonly source: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    node(id: number): HookNode | null;
    nodes(): readonly HookNode[];
    // relations で足した線をさかのぼる/たどる。ツリーの親子は node.parent と node.children で引く
    upstream(id: number, options?: HookTraversal): readonly HookNode[];
    downstream(id: number, options?: HookTraversal): readonly HookNode[];
    // 最後に描いた時点の診断
    readonly diagnostics: readonly Diagnostic[];
}

// フックから図に返せる操作。ここから起こした変更では before 系は呼ばれず、on 系は byHook: true で呼ばれる
export interface HookApi {
    focusNode(id: number, scale?: number): void;
    // decorateNode をもう一度呼んで、ノードの飾りを付け直す。フックの外の状態が変わったときに使う
    refreshDecorations(): void;
    revealNode(id: number): void;
    setFolded(ids: readonly number[]): void;
    getFolded(): number[];
    fit(): void;
    getTransform(): HookTransform;
    setTransform(transform: HookTransform): void;
    // 原文の差し替え。呼び出し側の onChange にも伝わる
    update(markdown: string): void;
}

export interface HookContextBase {
    event: HookEvent;
    // 見る人の操作によるものか。メソッドの呼び出しによる変更では false
    byUser: boolean;
    // フックの中から起こした変更によるものか
    byHook: boolean;
    doc: HookDocument;
    api: HookApi;
    // frontmatter の markdag.hooks.options
    options: Readonly<Record<string, unknown>>;
    // 取りやめる理由を残す。before 系で false を返すときに添える
    reject(message: string): void;
}

export interface DocumentHookContext extends HookContextBase {
    event: 'onDocument';
}

export interface UpdateHookContext extends HookContextBase {
    event: 'beforeUpdate';
    next: string;
    previous: string;
}

export interface TaskToggleHookContext extends HookContextBase {
    event: 'beforeTaskToggle' | 'onTaskToggle';
    node: HookNode;
    // 切り替えたあとに完了になるか (nextState が done のこと)
    next: boolean;
    // 切り替えたあとの状態
    nextState: TaskState;
    // 原文での行 (0 始まり)
    line: number;
}

export interface FoldHookContext extends HookContextBase {
    event: 'onFoldChange';
    // 閉じているノードの id (昇順)
    folded: readonly number[];
}

export interface FoldToggleHookContext extends HookContextBase {
    event: 'beforeFold';
    node: HookNode;
    // 切り替えたあとの状態。true なら閉じる
    folded: boolean;
}

export interface NodeClickHookContext extends HookContextBase {
    event: 'onNodeClick';
    node: HookNode;
    // そのクリックをタスクの切り替えとして扱ったか
    asTaskToggle: boolean;
}

export interface EdgeSelectHookContext extends HookContextBase {
    event: 'beforeSelectEdge' | 'onSelectEdge';
    // 選択を解くときは null
    edge: HookEdge | null;
}

export interface GroupSelectHookContext extends HookContextBase {
    event: 'beforeSelectGroup' | 'onSelectGroup';
    // 選択を解くときは null
    group: HookGroup | null;
}

export interface DetailsHookContext extends HookContextBase {
    event: 'beforeDetailsShow' | 'onDetailsShow' | 'onDetailsHide';
    node: HookNode;
    // 印のクリックで出したままにするもの (出すときは出し方、閉じるときは閉じたものの出し方)
    pinned: boolean;
}

export interface TransformHookContext extends HookContextBase {
    event: 'onTransform';
    transform: HookTransform;
}

export interface LayoutHookContext extends HookContextBase {
    event: 'onLayout';
    layout: HookLayoutInfo;
}

export interface DestroyHookContext extends HookContextBase {
    event: 'onDestroy';
}

export interface SourceHookContext extends HookContextBase {
    event: 'transformSource';
    // ここまでのフックが差し替えた結果 (最初のフックには文書に書かれたままの原文が入る)
    source: string;
}

export interface DecorateHookContext extends HookContextBase {
    event: 'decorateNode';
    node: HookNode;
}

// decorateNode が返すもの。どれも省ける
export interface HookDecoration {
    // ノードの要素 (.mdag-node) に足すクラス。空白で区切って複数書ける
    className?: string;
    // ノードの箱に付ける説明 (title 属性)
    title?: string;
    // ノードの中に出す短い文字。タグと同じ並びに出る
    badge?: string;
}

export interface HookContexts {
    beforeUpdate: UpdateHookContext;
    beforeTaskToggle: TaskToggleHookContext;
    beforeFold: FoldToggleHookContext;
    beforeSelectEdge: EdgeSelectHookContext;
    beforeSelectGroup: GroupSelectHookContext;
    beforeDetailsShow: DetailsHookContext;
    onDocument: DocumentHookContext;
    onNodeClick: NodeClickHookContext;
    onTaskToggle: TaskToggleHookContext;
    onFoldChange: FoldHookContext;
    onSelectEdge: EdgeSelectHookContext;
    onSelectGroup: GroupSelectHookContext;
    onDetailsShow: DetailsHookContext;
    onDetailsHide: DetailsHookContext;
    onTransform: TransformHookContext;
    onLayout: LayoutHookContext;
    onDestroy: DestroyHookContext;
    transformSource: SourceHookContext;
    decorateNode: DecorateHookContext;
}

export type HookContext<E extends HookEvent = HookEvent> = HookContexts[E];

// 発火点ごとの、フックが返せるもの。null は undefined と同じで「何もしない」
type HookResult<E extends HookEvent> = E extends BeforeHookEvent ? boolean | void | null : E extends 'transformSource' ? string | void | null : E extends 'decorateNode' ? HookDecoration | void | null : void;

// フックのファイル 1 つ。予約された名前の関数だけが拾われる
export type HookModule = {
    [E in HookEvent]?: (context: HookContexts[E]) => HookResult<E>;
};

// 発火点ごとに、共通の部分に足して渡すもの
type HookFields<E extends HookEvent> = Omit<HookContexts[E], keyof HookContextBase>;

// 宣言と実体が結びついたフック 1 つ。ref は診断に出す出どころの名前
export interface ResolvedHook {
    ref: string;
    module: HookModule;
}

export interface ResolvedHooks {
    // 宣言の順に並ぶ
    hooks: ResolvedHook[];
    // frontmatter の markdag.hooks.options
    options: Record<string, unknown>;
}

export interface HookIssue {
    severity: Diagnostic['severity'];
    code: string;
    message: string;
    hint: string | null;
    // frontmatter の中の場所 (呼び出し側が位置に直す)
    path: Array<string | number> | null;
}

// frontmatter の markdag.hooks と、呼び出し側が渡したモジュールを突き合わせる。
// 形と型の誤りはスキーマがすでに警告にしているので、ここでは読めるものだけを拾う
export function resolveHooks(raw: unknown, provided: Record<string, unknown> | undefined): ResolvedHooks & { issues: HookIssue[] } {
    const issues: HookIssue[] = [];
    const declared = isRecord(raw) ? raw : {};
    const options = isRecord(declared.options) ? declared.options : {};
    const single = typeof declared.$ref === 'string';
    const refs = single ? [declared.$ref as string] : Array.isArray(declared.$ref) ? declared.$ref.filter((item): item is string => typeof item === 'string') : [];
    const hooks: ResolvedHook[] = [];
    refs.forEach((ref, index) => {
        const path = single ? ['markdag', 'hooks', '$ref'] : ['markdag', 'hooks', '$ref', index];
        const loaded = provided?.[ref];
        if (!isRecord(loaded)) {
            // TypeScript のフックは markdag では変換しないので、読み込む側に変換器が要ることを添える
            const typescript = /\.[cm]?tsx?$/.test(ref) ? '。.ts は markdag では変換しないので、読み込む側で JavaScript にしてから渡します (変換器がなければ .js で書きます)' : '';
            // hookRefs を渡していないアプリはフックを読み込まない方針なので、文書の誤りではなく知らせるだけにする。
            // 渡しているのに見つからない、または読めなかったものは、書き手が直せる問題として警告にする
            issues.push({
                severity: provided === undefined ? 'info' : 'warning',
                code: 'hooks-unresolved',
                message: `markdag.hooks.$ref「${ref}」は読み込まれていないので、このフックは動きません`,
                hint:
                    provided === undefined
                        ? `このアプリはフックを読み込みません (markdag.rules ならコードなしで効きます)${typescript}`
                        : loaded === undefined
                          ? `呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ)${typescript}`
                          : `モジュールとして読めるか (名前付きの export があるか) 確かめます${typescript}`,
                path,
            });
            return;
        }
        hooks.push({ ref, module: pickHooks(ref, loaded, issues, path) });
    });
    return { hooks, options, issues };
}

// モジュールの export から、予約された名前の関数だけを取り出す。
// 書き間違いを黙って落とすと「フックが動かない」だけが残るので、拾えなかった関数は警告にする
function pickHooks(ref: string, loaded: Record<string, unknown>, issues: HookIssue[], path: Array<string | number>): HookModule {
    const module: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(loaded)) {
        if ((HOOK_EVENTS as string[]).includes(name)) {
            if (typeof value === 'function') module[name] = value;
            else {
                issues.push({
                    severity: 'warning',
                    code: 'hook-invalid-export',
                    message: `${ref} の「${name}」は関数ではないので、フックとして呼びません`,
                    hint: `export function ${name}(ctx) { ... } の形で書きます`,
                    path,
                });
            }
            continue;
        }
        if (name === 'default') {
            issues.push({
                severity: 'warning',
                code: 'hook-unknown-export',
                message: `${ref} の default export は拾いません`,
                hint: `フックは名前付きで export します (${HOOK_EVENTS.slice(0, 3).join(', ')} など)`,
                path,
            });
            continue;
        }
        // 関数でない export は、フックが内部で使う定数と区別できないので黙って見送る
        if (typeof value !== 'function') continue;
        const near = closest(name, HOOK_EVENTS);
        issues.push({
            severity: 'warning',
            code: 'hook-unknown-export',
            message: `${ref} の「${name}」は予約された名前ではないので、フックとして呼びません`,
            hint: near === null ? `予約された名前だけが呼ばれます (${HOOK_EVENTS.slice(0, 6).join(', ')} ほか)` : `「${near}」の書き間違いなら直します`,
            path,
        });
    }
    return module as HookModule;
}

// 組み込みの規則 (frontmatter の markdag.rules) から作ったフック。groups は readonlyGroups に書かれた名前
export interface RulesModule {
    module: HookModule;
    groups: string[];
}

// そのノード自身と祖先に入ってくる線をさかのぼって、終わっていない (未完了か作業中の) タスクを集める。中止は終わった扱いで、下流を塞がない。
// relations の線は見出しに引かれていることが多いので、配下の項目から見るには祖先の分も見る
export function unfinishedUpstream(doc: HookDocument, node: HookNode): HookNode[] {
    const found = new Map<number, HookNode>();
    for (let current: HookNode | null = node; current !== null; current = current.parent === null ? null : doc.node(current.parent)) {
        for (const upstream of doc.upstream(current.id, { transitive: true })) {
            if (upstream.task !== null && (upstream.task.state === 'todo' || upstream.task.state === 'doing')) found.set(upstream.id, upstream);
        }
    }
    return [...found.values()];
}

// frontmatter の markdag.rules を、組み込みのフックにする。コードを書かずに使える規則で、
// 文書が宣言したフックより先に評価する。何も有効になっていなければ null
export function rulesModule(raw: unknown): RulesModule | null {
    if (!isRecord(raw)) return null;
    const taskToggle = isRecord(raw.taskToggle) ? raw.taskToggle : {};
    const fold = isRecord(raw.fold) ? raw.fold : {};
    const requireUpstreamDone = taskToggle.requireUpstreamDone === true;
    const readonlyGroups = Array.isArray(taskToggle.readonlyGroups) ? taskToggle.readonlyGroups.filter((item): item is string => typeof item === 'string') : [];
    const module: HookModule = {};
    if (requireUpstreamDone || readonlyGroups.length > 0) {
        module.beforeTaskToggle = (context) => {
            const locked = readonlyGroups.find((name) => context.node.groups.includes(name));
            if (locked !== undefined) {
                context.reject(`「${locked}」のノードのタスクは切り替えられません`);
                return false;
            }
            // 完了にするときだけ検査する。外すほうは止めない (取り消しまで塞ぐと、間違えたときに直せなくなる)。作業中に進むのも止めない
            if (!requireUpstreamDone || context.nextState !== 'done') return;
            const blockers = unfinishedUpstream(context.doc, context.node);
            if (blockers.length === 0) return;
            context.reject(`先に終えるもの: ${blockers.map((node) => node.text).join('、')}`);
            return false;
        };
    }
    if (fold.keepMilestonesOpen === true) {
        module.beforeFold = (context) => {
            if (!context.folded || !context.node.milestone) return;
            context.reject(`${context.node.text} はマイルストーンなので閉じません`);
            return false;
        };
    }
    return Object.keys(module).length === 0 ? null : { module, groups: readonlyGroups };
}

export interface HookDocumentInput {
    nodes: OutlineNode[];
    model: GraphModel;
    frontmatter: Record<string, unknown>;
    source: () => string;
    folded: () => Iterable<number>;
    diagnostics: () => readonly Diagnostic[];
}

// フックに渡す文書の窓口。ノードの写しは求められたときに作り、開閉の状態は読むたびに今の値を見る
export function createHookDocument(input: HookDocumentInput): HookDocument {
    const byId = new Map(input.nodes.map((node) => [node.id, node]));
    const children = new Map<number, number[]>();
    for (const node of input.nodes) {
        if (node.parent === null) continue;
        const list = children.get(node.parent) ?? [];
        list.push(node.id);
        children.set(node.parent, list);
    }
    const relationsForward = new Map<number, number[]>();
    const relationsBackward = new Map<number, number[]>();
    const link = (map: Map<number, number[]>, from: number, to: number): void => {
        const list = map.get(from);
        if (list) list.push(to);
        else map.set(from, [to]);
    };
    for (const relation of input.model.relations) {
        link(relationsForward, relation.source, relation.target);
        link(relationsBackward, relation.target, relation.source);
    }
    const foldedIds = (): Set<number> => new Set(input.folded());

    const view = (node: OutlineNode): HookNode => ({
        id: node.id,
        refId: node.refId,
        text: node.refText,
        depth: node.depth,
        parent: node.parent,
        children: children.get(node.id) ?? [],
        groups: input.model.groupsOf.get(node.id) ?? node.groups,
        tags: (input.model.tagsOf.get(node.id) ?? node.tags).map((tag) => ({ key: tag.key, values: [...tag.values] })),
        task: node.task === null ? null : { checked: node.task.checked, state: node.task.state, line: node.task.line },
        milestone: node.milestone,
        lines: node.lines === null ? null : { ...node.lines },
        get folded() {
            return foldedIds().has(node.id);
        },
        get visible() {
            const closed = foldedIds();
            for (let current = byId.get(node.id)?.parent ?? null; current !== null; current = byId.get(current)?.parent ?? null) {
                if (closed.has(current)) return false;
            }
            return true;
        },
    });

    const walk = (start: number, options: HookTraversal | undefined, relations: Map<number, number[]>, treeOf: (node: OutlineNode) => number[]): HookNode[] => {
        const found: number[] = [];
        const seen = new Set([start]);
        const queue = [start];
        for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
            const node = byId.get(current);
            const next = [...(relations.get(current) ?? []), ...(options?.tree && node ? treeOf(node) : [])];
            for (const id of next) {
                if (seen.has(id)) continue;
                seen.add(id);
                found.push(id);
                if (options?.transitive) queue.push(id);
            }
        }
        return found.flatMap((id) => {
            const node = byId.get(id);
            return node ? [view(node)] : [];
        });
    };

    return {
        get source() {
            return input.source();
        },
        get frontmatter() {
            return input.frontmatter;
        },
        get diagnostics() {
            return input.diagnostics();
        },
        node: (id) => {
            const node = byId.get(id);
            return node ? view(node) : null;
        },
        nodes: () => input.nodes.map(view),
        upstream: (id, options) => walk(id, options, relationsBackward, (node) => (node.parent === null ? [] : [node.parent])),
        downstream: (id, options) => walk(id, options, relationsForward, (node) => children.get(node.id) ?? []),
    };
}

export interface HookHost {
    doc(): HookDocument;
    api: HookApi;
    // 実行中に出た診断 (取りやめ、失敗)。描いた時点の診断とは別の経路で渡す
    onDiagnostic?: (diagnostic: Diagnostic) => void;
    onError?: (error: unknown, info: { event: HookEvent; ref: string }) => void;
}

// フックの呼び出し。宣言の順に呼び、before 系は最初に false が返った時点で打ち切る。
// フックが投げた例外はそのフックだけを飛ばして続ける (図が丸ごと止まるより、連携 1 つが効かないほうがまし)
export class HookRunner {
    private hooks: ResolvedHook[] = [];
    private options: Readonly<Record<string, unknown>> = {};
    private depth = 0;
    // 1 回の描画の中で失敗した decorateNode の出どころ。ノードごとに呼ぶので、同じ失敗を繰り返さないよう以後は飛ばす
    private failedDecorators = new Set<string>();

    constructor(private readonly host: HookHost) {}

    // 文書を描くたびに呼ぶ。失敗したフックの記録もここで消える (次の描画では、また 1 回だけ試す)
    setHooks(hooks: ResolvedHook[], options: Record<string, unknown>): void {
        this.hooks = hooks;
        this.options = options;
        this.failedDecorators.clear();
    }

    before<E extends BeforeHookEvent>(event: E, fields: HookFields<E>, byUser = false): boolean {
        return this.run(event, fields, byUser);
    }

    emit<E extends OnHookEvent>(event: E, fields: HookFields<E>, byUser = false): void {
        this.run(event, fields, byUser);
    }

    // 解析の前に原文を差し替える。フックは宣言の順につながり、次のフックには前の結果が渡る
    transform(source: string): string {
        const targets = this.targetsOf('transformSource');
        if (targets.length === 0 || this.tooDeep('transformSource')) return source;
        let text = source;
        this.depth += 1;
        try {
            for (const hook of targets) {
                const result = this.invoke('transformSource', hook, this.build('transformSource', { source: text }, false));
                if (!result.called || result.value === undefined || result.value === null) continue;
                if (typeof result.value === 'string') text = result.value;
                else this.report('warning', 'hook-failed', `${hook.ref} の transformSource が文字列ではなく ${typeof result.value} を返しました`, '差し替えないときは何も返しません');
            }
        } finally {
            this.depth -= 1;
        }
        return text;
    }

    // ノード 1 つの飾り。複数のフックが返したものは重ね、クラスは並べ、ほかはあとのフックが勝つ。
    // 失敗したフックは、その描画では 1 回だけ知らせて、残りのノードでは呼ばない (1 つ目で壊れているものは残りでも壊れているため)
    decorate(node: HookNode): HookDecoration | null {
        const targets = this.targetsOf('decorateNode').filter((hook) => !this.failedDecorators.has(hook.ref));
        if (targets.length === 0 || this.tooDeep('decorateNode')) return null;
        const context = this.build('decorateNode', { node }, false);
        const merged: HookDecoration = {};
        let found = false;
        this.depth += 1;
        try {
            for (const hook of targets) {
                const result = this.invoke('decorateNode', hook, context);
                if (!result.called) {
                    this.failedDecorators.add(hook.ref);
                    continue;
                }
                if (result.value === undefined || result.value === null) continue;
                if (!isRecord(result.value)) {
                    this.failedDecorators.add(hook.ref);
                    this.report('warning', 'hook-failed', `${hook.ref} の decorateNode が ${typeof result.value} を返しました`, '{ className, title, badge } のいずれかを持つ値を返すか、何も返しません。この描画では、このフックの飾りは以後付けません');
                    continue;
                }
                const { className, title, badge } = result.value as HookDecoration;
                if (typeof className === 'string') merged.className = merged.className === undefined ? className : `${merged.className} ${className}`;
                if (typeof title === 'string') merged.title = title;
                if (typeof badge === 'string') merged.badge = badge;
                found = true;
            }
        } finally {
            this.depth -= 1;
        }
        return found ? merged : null;
    }

    private run<E extends HookEvent>(event: E, fields: HookFields<E>, byUser: boolean): boolean {
        const targets = this.targetsOf(event);
        if (targets.length === 0) return true;
        // フックの中から起こした変更を、もう一度取りやめの判断にかけない (同じ操作を二度止める形になるため)
        if (this.depth > 0 && isBeforeEvent(event)) return true;
        if (this.tooDeep(event)) return true;
        const rejection: { reason: string | null } = { reason: null };
        const context = this.build(event, fields, byUser, rejection);
        this.depth += 1;
        try {
            for (const hook of targets) {
                const result = this.invoke(event, hook, context);
                if (!result.called || !isBeforeEvent(event)) continue;
                if (result.value === false) {
                    this.report('info', 'hook-rejected', `${hook.ref} の ${event} が操作を取りやめました${rejection.reason === null ? '' : `: ${rejection.reason}`}`, null);
                    return false;
                }
                if (result.value !== undefined && result.value !== null && result.value !== true) {
                    this.report('warning', 'hook-failed', `${hook.ref} の ${event} が ${typeof result.value} を返しました。取りやめるなら false を返します`, '続けるときは何も返しません');
                }
            }
        } finally {
            this.depth -= 1;
        }
        return true;
    }

    private targetsOf(event: HookEvent): ResolvedHook[] {
        return this.hooks.filter((hook) => typeof hook.module[event] === 'function');
    }

    private tooDeep(event: HookEvent): boolean {
        if (this.depth < MAX_DEPTH) return false;
        this.report('warning', 'hook-failed', `フックの入れ子が深くなりすぎたので、${event} から先は呼びません (上限 ${MAX_DEPTH})`, 'フックの中から呼ぶ api が、同じフックを呼び戻していないか確かめます');
        return true;
    }

    private build<E extends HookEvent>(event: E, fields: HookFields<E>, byUser: boolean, rejection: { reason: string | null } = { reason: null }): HookContexts[E] {
        return {
            ...fields,
            event,
            byUser,
            byHook: this.depth > 0,
            doc: this.host.doc(),
            api: this.host.api,
            options: this.options,
            reject: (message: string) => {
                rejection.reason = message;
            },
        } as unknown as HookContexts[E];
    }

    // 例外を投げたフックは、そのフックだけを飛ばす (called は、値を受け取れたか)
    private invoke<E extends HookEvent>(event: E, hook: ResolvedHook, context: HookContexts[E]): { called: boolean; value: unknown } {
        const called = hook.module[event] as ((context: HookContexts[E]) => unknown) | undefined;
        if (typeof called !== 'function') return { called: false, value: undefined };
        try {
            return { called: true, value: called(context) };
        } catch (error) {
            this.host.onError?.(error, { event, ref: hook.ref });
            const perNode = event === 'decorateNode' ? 'この描画では、このフックの飾りは以後付けません' : null;
            this.report('warning', 'hook-failed', `${hook.ref} の ${event} が例外を投げたので、このフックは飛ばしました: ${messageOf(error)}`, perNode);
            return { called: false, value: undefined };
        }
    }

    private report(severity: Diagnostic['severity'], code: string, message: string, hint: string | null): void {
        this.host.onDiagnostic?.({ severity, code, message, at: null, hint });
    }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// model 層の包み。frontmatter の markdag の下の指定をノードの木に対して解決し、検査するのは Rust (wasm の build_model) が行う。
// ここは境界の結果を公開の GraphModel に組み直す: 配列の組を Map に戻し、Rust が宣言と突き合わせたフック (hooks.declared) に
// 呼び出し側が渡したモジュールの実際の関数を取り付け、markdag.rules の設定 (hooks.rules) から組み込みのフックの関数を作る。
// フックのモジュールは JSON にできないので、境界へは export の名前と「関数か」だけを送る (HookSpec)。
// wasm を init する前に呼ぶと WasmNotReadyError を投げる。空のモデル (emptyModel) だけは init の前でも作れる。
import type { LayoutInputRelation } from '../layout/input-types';
import { decorateParsed, rememberWrittenFrontmatter, writtenFrontmatterOf, type NodeTag, type OutlineNode, type ParsedDocument, type RawParsedDocument, type SourcePosition } from '../parse/document';
import { DEFAULT_TASK_CYCLE, type TaskMark, type TaskState } from '../parse/task';
import { callJson, callJsonKeeping, isWellFormedText, markUndefined, RawJson } from '../wasm/boundary';
import { rulesModule, type HookModule, type ResolvedHook, type ResolvedHooks } from './hooks';
import type { TagKeyDef } from './tags';
import { isRecord } from './util';

export type { SourcePosition } from '../parse/document';

export interface Diagnostic {
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    // 原文での位置 (frontmatter の指定か、本文のタグ)。場所を特定できなかったものは null
    at: SourcePosition | null;
    // 直し方の手がかり (近い名前、書き方の例)
    hint: string | null;
}

export interface GroupDef {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
    // frontmatter の markdag.groups に定義があるか (定義のないグループは文字ラベルになる)
    defined: boolean;
}

// ノードに添えるもの (詳細、タグ) の見せ方。always = 最初からノードの中に出す。hover = ノードに重ねたときに出す。click = 印のクリックで出す
export type DisplayMode = 'always' | 'hover' | 'click';

// タグの見せ方。出さない (never) を選べる点だけが詳細と違う
export type TagDisplayMode = DisplayMode | 'never';

// 薄く表示するタスクのノードでの、詳細とタグの見せ方。keep = 文書の指定のまま。never = 出さない (吹き出しも印もなし)
export type DimDisplayMode = 'keep' | 'hover' | 'click' | 'never';

// 薄く表示するタスクの状態と、そのノードでの詳細とタグの見せ方 (frontmatter の markdag.tasks.dim)
export interface TaskDimOptions {
    states: TaskState[];
    details: DimDisplayMode;
    tags: DimDisplayMode;
}

// 凡例に出す項目。groups はグループの色とラベル、branches は枝の色と起点の名前
export type LegendItem = 'groups' | 'branches';
export const DEFAULT_LEGEND: LegendItem[] = ['groups', 'branches'];

// 凡例を置く、図の領域の隅。先頭が既定
export type LegendPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export interface GraphModel {
    // 文書 (frontmatter の markdag.details.display) が指定する詳細の見せ方。指定がなければ null
    detailsMode: DisplayMode | null;
    // 凡例に出す項目 (frontmatter の markdag.legend.display)。空なら凡例を出さない
    legend: LegendItem[];
    // 凡例を置く隅 (frontmatter の markdag.legend.position)
    legendPosition: LegendPosition;
    // 線をクリックして、その線と前後につながる線だけを残す操作を使えるか (frontmatter の markdag.edgeHighlight)
    edgeHighlight: boolean;
    // グループの枠をクリックして、そのグループのノードと線だけを残す操作を使えるか (frontmatter の markdag.groupHighlight)
    groupHighlight: boolean;
    // 色を分ける単位にする枝の起点 (frontmatter の markdag.branches)。書かれた順で、色もこの順に割り当てる。
    // 空なら、色はノードごとに出てきた順で決める
    branches: number[];
    relations: LayoutInputRelation[];
    suppressRootLine: number[];
    groups: GroupDef[];
    // ノードごとの所属。groups の定義順、そのあとに定義のないグループを書かれた順
    groupsOf: Map<number, string[]>;
    // タグの見せ方 (frontmatter の markdag.tags.display)。指定がなければ always
    tagDisplay: TagDisplayMode;
    // ノードごとのタグ (そのノードに書かれたものだけ、書かれた順。配下には継承しない)
    tagsOf: Map<number, NodeTag[]>;
    // キーごとの解決済みの定義 (frontmatter の markdag.tags.keys と markdag.types)。定義のないキーは入らない
    tagKeys: TagKeyDef[];
    // タスクのクリックで進む記号の順 (frontmatter の markdag.tasks.cycle)。指定がなければ未完了と完了の行き来
    taskCycle: TaskMark[];
    // 薄く表示するタスクの状態と、そのノードでの詳細とタグの見せ方 (frontmatter の markdag.tasks.dim)。指定がなければ何も薄くしない
    taskDim: TaskDimOptions;
    // 文書が宣言し (frontmatter の markdag.hooks)、呼び出し側が渡したフック。宣言の順に並ぶ
    hooks: ResolvedHooks;
    diagnostics: Diagnostic[];
}

export interface ModelOptions {
    // markdag.types.$ref で参照したファイルの中身。$ref に書いた文字列をキーに、YAML を読んだ値 (読めなければ null) を渡す。
    // markdag はファイルを読まないので、呼び出し側が読む
    types?: Record<string, unknown>;
    // markdag.hooks.$ref で参照したモジュール。$ref に書いた文字列をキーに、import した結果を渡す。
    // types と違って中身はコードなので、読み込むかどうかの判断も呼び出し側に置く (markdag は import も eval もしない)
    hookRefs?: Record<string, unknown>;
}

// 境界に送る、呼び出し側が渡したフックのモジュールの形。文書が宣言した ref ごとに、export の名前と関数かどうか (Object.entries の順)。
// 値が record でないもの (null を含む) は invalid。値が undefined の ref は入れない (「渡したが見つからない」になる)
type HookSpecEntry = { kind: 'module'; exports: Array<[string, boolean]> } | { kind: 'invalid' };

// 境界の build_model が返すモデル。Map は配列の組、フックは関数を持たない宣言と設定
interface RawGraphModel extends Omit<GraphModel, 'groupsOf' | 'tagsOf' | 'hooks'> {
    groupsOf: Array<[number, string[]]>;
    tagsOf: Array<[number, NodeTag[]]>;
    hooks: {
        declared: Array<{ ref: string; exports: string[] }>;
        options: Record<string, unknown>;
        rules: { requireUpstreamDone: boolean; readonlyGroups: string[]; keepMilestonesOpen: boolean } | null;
    };
}

// ref ごとの HookSpecEntry。値が undefined なら入れない (「渡したが見つからない」になる)
function hookSpecEntryOf(loaded: unknown): HookSpecEntry | undefined {
    if (loaded === undefined) return undefined;
    return isRecord(loaded) ? { kind: 'module', exports: Object.entries(loaded).map(([name, value]) => [name, typeof value === 'function']) } : { kind: 'invalid' };
}

// hookRefs を渡していない (undefined) ことと、渡したが空 (null を含む) ことは診断が違うので、前者だけを null にする。
// 規則書 2.1 の obj[k] の行に従い、hookRefs は自分の持つキーだけで引く (Object.prototype の名前の値は拾わない)。
// 結果は Object.fromEntries で組む (代入だと ref が __proto__ のときに prototype を差し替えてしまい、自分の持つ __proto__ のキーが消える)
function hookSpecOf(hookRefs: Record<string, unknown> | null | undefined, refs: Iterable<string>): Record<string, HookSpecEntry> | null {
    if (hookRefs === undefined) return null;
    const entries: Array<[string, HookSpecEntry]> = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        if (seen.has(ref) || hookRefs === null || !Object.hasOwn(hookRefs, ref)) continue;
        seen.add(ref);
        const entry = hookSpecEntryOf(hookRefs[ref]);
        if (entry !== undefined) entries.push([ref, entry]);
    }
    return Object.fromEntries(entries);
}

// 文書が宣言したフックの ref (frontmatter の markdag.hooks.$ref の文字列、配列なら文字列の要素)。
// Rust の resolve_hooks が拾うものと同じ。途中の欄も自分の持つキーだけを見る (境界の JSON に載るのは自分の持つキーだけなので)
function declaredHookRefs(frontmatter: Record<string, unknown>): string[] {
    const own = (record: unknown, key: string): unknown => (isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined);
    const declared = own(own(own(frontmatter, 'markdag'), 'hooks'), '$ref');
    if (typeof declared === 'string') return [declared];
    return Array.isArray(declared) ? declared.filter((item): item is string => typeof item === 'string') : [];
}

// renderDocument は frontmatter を Rust が読むので、宣言した ref を先に知れない (JS で YAML を読むか呼び出しを 2 回に分けるしかない)。
// 宣言の ref は Rust が読んだ YAML の文字列で、境界で toWellFormed を当てた原文から来るので孤立したサロゲートを持たない。
// そこで hookRefs の自分の持つキー (列挙できないものも含む。hasOwn と同じ範囲) のうち孤立したサロゲートのないものを送る。
// Rust は宣言した ref だけを引くので、結果は buildModel(parsed.nodes, parsed.frontmatter, …) と同じになる。
// 孤立したサロゲートのキーを除くのは、境界の toWellFormed で U+FFFD のキーと重なり、宣言した ref の値を上書きしないようにするため。
// 残る違いは、宣言にないモジュールの値と export もここで読むこと (読むと例外を投げる getter を置いた hookRefs だけで表に出る)
function wellFormedOwnKeys(hookRefs: Record<string, unknown> | null | undefined): string[] {
    return hookRefs === null || hookRefs === undefined ? [] : Object.getOwnPropertyNames(hookRefs).filter(isWellFormedText);
}

// Rust が拾った export の名前に、モジュールの実際の関数を取り付ける。組み込みの規則は、宣言したフックより先に評価する
function resolvedHooksOf(raw: RawGraphModel['hooks'], hookRefs: Record<string, unknown> | null | undefined): ResolvedHooks {
    const declared: ResolvedHook[] = raw.declared.map(({ ref, exports }) => {
        const loaded = (hookRefs ?? {})[ref] as Record<string, unknown>;
        return { ref, module: Object.fromEntries(exports.map((name) => [name, loaded[name]])) as HookModule };
    });
    const rules =
        raw.rules === null
            ? null
            : rulesModule({ taskToggle: { requireUpstreamDone: raw.rules.requireUpstreamDone, readonlyGroups: raw.rules.readonlyGroups }, fold: { keepMilestonesOpen: raw.rules.keepMilestonesOpen } });
    return { hooks: rules === null ? declared : [{ ref: 'markdag.rules', module: rules.module }, ...declared], options: raw.options };
}

function graphModelOf(raw: RawGraphModel, hookRefs: Record<string, unknown> | null | undefined): GraphModel {
    return {
        detailsMode: raw.detailsMode,
        legend: raw.legend,
        legendPosition: raw.legendPosition,
        edgeHighlight: raw.edgeHighlight,
        groupHighlight: raw.groupHighlight,
        branches: raw.branches,
        relations: raw.relations,
        suppressRootLine: raw.suppressRootLine,
        groups: raw.groups,
        groupsOf: new Map(raw.groupsOf),
        tagDisplay: raw.tagDisplay,
        tagsOf: new Map(raw.tagsOf),
        tagKeys: raw.tagKeys,
        taskCycle: raw.taskCycle,
        taskDim: raw.taskDim,
        hooks: resolvedHooksOf(raw.hooks, hookRefs),
        diagnostics: raw.diagnostics,
    };
}

// frontmatter の形と型だけを検べる入口。原文を渡すと、診断に frontmatter での位置が付く
export function checkFrontmatter(frontmatter: Record<string, unknown>, markdown?: string): Diagnostic[] {
    return callJson<Diagnostic[]>('check_frontmatter', { frontmatter: markUndefined(frontmatter), source: markdown ?? null });
}

export function buildModel(nodes: OutlineNode[], frontmatter: Record<string, unknown>, markdown?: string, extra: ModelOptions = {}): GraphModel {
    // parseDocument の結果の frontmatter なら、YAML に書かれた順のまま送る (groups の並びが renderDocument の経路とそろう。A-215 (4))
    const written = writtenFrontmatterOf(frontmatter);
    const sent = written === null ? markUndefined(frontmatter) : new RawJson(written);
    const raw = callJson<RawGraphModel>('build_model', { nodes, frontmatter: sent, source: markdown ?? null, types: markUndefined(extra.types ?? null), hooks: hookSpecOf(extra.hookRefs, declaredHookRefs(frontmatter)) });
    return graphModelOf(raw, extra.hookRefs);
}

// 解析とモデルの組み立てを 1 回の呼び出しで行う (render と、原文から描く単体 HTML。設計文書 (b) の N+1 を避ける経路)。
// 結果は parseDocument と buildModel(parsed.nodes, parsed.frontmatter, source, extra) を続けて呼んだものと同じ
export function renderDocument(source: string, extra: ModelOptions = {}): { parsed: ParsedDocument; model: GraphModel } {
    const { value: raw, raw: frontmatterText } = callJsonKeeping<{ parsed: RawParsedDocument; model: RawGraphModel }>(
        'render_document',
        { source, types: markUndefined(extra.types ?? null), hooks: hookSpecOf(extra.hookRefs, wellFormedOwnKeys(extra.hookRefs)) },
        'frontmatter',
    );
    const parsed = decorateParsed(raw.parsed);
    rememberWrittenFrontmatter(parsed.frontmatter, frontmatterText);
    return { parsed, model: graphModelOf(raw.model, extra.hookRefs) };
}

// 空の文書 (ノードも frontmatter もない) のモデル。buildModel([], {}) と同じ値を wasm を呼ばずに作る (init の前に createHookBridge を作れるように)
export function emptyModel(): GraphModel {
    return {
        detailsMode: null,
        legend: [...DEFAULT_LEGEND],
        legendPosition: 'top-right',
        edgeHighlight: true,
        groupHighlight: true,
        branches: [],
        relations: [],
        suppressRootLine: [],
        groups: [],
        groupsOf: new Map(),
        tagDisplay: 'always',
        tagsOf: new Map(),
        tagKeys: [],
        taskCycle: [...DEFAULT_TASK_CYCLE],
        taskDim: { states: [], details: 'keep', tags: 'keep' },
        hooks: { hooks: [], options: {} },
        diagnostics: [],
    };
}

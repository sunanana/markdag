// 単体の HTML に埋め込んだ素材 (解析結果か原文、型定義、フックのソース、表示の指定、開閉の状態) から、要素の中に図を組み立てる。
// 書き出した HTML の script から呼ぶためのものだが、アプリが書き出す前の確認に同じ素材で呼んでもよい。
// 解析結果を受けたときはモデルの組み立てだけを行い、原文だけのときは解析から行う (どちらも Rust (wasm) を呼ぶので、先に init を待つ)。
// タスクの切り替えは、書き換えた原文の保存先がないので既定では受け付けない。scratch を選ぶとページの中だけで切り替わる
// (解析結果の上で状態と記号を差し替えて描き直す。開き直すと書き出したときの状態に戻る)。
import { createHookBridge } from '../bridge';
import type { HookModule } from '../model/hooks';
import { buildModel, renderDocument, type Diagnostic, type GraphModel } from '../model/model';
import { replaceLeadingMark, toggleTask, type OutlineNode, type ParsedDocument, type TaskMark, type TransformerLike } from '../parse/document';
import { nextTaskMark, taskMarkOf, taskStateOf } from '../parse/task';
import { MarkdagView, type ViewHooks, type ViewOptions, type ViewTransform } from '../view/view';

// 開いた先で効く表示の指定。見る人が変えられるものだけで、配置の差し替えのような関数は持てない
export type StandaloneViewOptions = Partial<Pick<ViewOptions, 'theme' | 'details' | 'legend' | 'animate'>>;

// タスクのクリックの扱い。readonly は何も変えない。scratch はページの中だけで切り替わり、保存はしない
export type StandaloneTasks = 'readonly' | 'scratch';

export interface StandaloneState {
    // 折りたたんでいるノードの id (view.getFolded() の値)。省略すると文書の初期状態
    folded?: number[];
    // ズームとパン。省略すると全体を収める。コンテナの寸法に依存するので、同じ寸法で開く当てがあるときだけ渡す
    transform?: ViewTransform;
}

// HTML に JSON で埋める素材。関数や Map を含まないので、そのまま JSON.stringify できる
export interface StandaloneData {
    // 解析結果。あれば解析をせずに描く。呼び出し側は、画像の URL の書き換えなどを済ませてから渡す
    parsed?: ParsedDocument;
    // 原文。parsed がなければこれを解析する。parsed があるときは診断の位置付けとフックに見せる原文に使うだけで、省略できる
    source?: string;
    // markdag.types.$ref の解決結果 (書かれたパスをキーにした、YAML を読んだ値)
    types?: Record<string, unknown>;
    // markdag.hooks.$ref の解決結果を、モジュールのソース文字列で渡す (書かれたパスをキーにする)。
    // 開いたときにモジュールとして読み込む。省略すると、フックは読み込まない (markdag.rules は効く)
    hookScripts?: Record<string, string>;
    view?: StandaloneViewOptions;
    state?: StandaloneState;
    // 既定は readonly
    tasks?: StandaloneTasks;
}

export interface StandaloneDiagram {
    readonly view: MarkdagView;
    // 描いた文書の診断。フックのソースを読み込めなかったときの診断も含む
    readonly diagnostics: Diagnostic[];
    destroy(): void;
}

export interface MountOptions {
    /** @deprecated 解析は Rust で行うので、渡しても使いません */
    transformer?: TransformerLike;
}

// 高さのない要素に描くと何も見えないので、そのときに与える高さ
const FALLBACK_HEIGHT = '480px';
// タスクの切り替えを止めるフック。文書が宣言したフックのあとに呼ばれるので、文書の側の判断は先に済んでいる
const READ_ONLY_TASKS: HookModule = { beforeTaskToggle: () => false };

// フックのソースを blob の URL からモジュールとして読み込む。読めなかったものは null にして、その理由を診断で返す
// (null は hooks-unresolved の警告になるので、書き手にはフックが動いていないことが伝わる)
async function importHookScripts(scripts: Record<string, string>): Promise<{ refs: Record<string, unknown>; diagnostics: Diagnostic[] }> {
    const refs: Record<string, unknown> = {};
    const diagnostics: Diagnostic[] = [];
    await Promise.all(
        Object.entries(scripts).map(async ([ref, code]) => {
            const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            try {
                // 印は、利用者のバンドラが式の import を自分の読み込みに置き換えないためのもの (webpack は置き換えると blob の URL を読めない)
                refs[ref] = { ...((await import(/* @vite-ignore */ /* webpackIgnore: true */ url)) as Record<string, unknown>) };
            } catch (error) {
                refs[ref] = null;
                diagnostics.push({
                    severity: 'warning',
                    code: 'hook-failed',
                    message: `markdag.hooks.$ref「${ref}」のソースをモジュールとして読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`,
                    at: null,
                    hint: '自己完結した JavaScript のモジュール (他のファイルを import しないもの) を渡します',
                });
            } finally {
                URL.revokeObjectURL(url);
            }
        }),
    );
    return { refs, diagnostics };
}

// 解析結果の上でタスクを 1 つ進める。原文を解析し直せないので、そのノードの状態と先頭の記号だけを差し替えた解析結果を返す。
// 進められない (順にない状態) なら null
function toggleParsedTask(parsed: ParsedDocument, id: number, cycle: readonly TaskMark[]): ParsedDocument | null {
    const target = parsed.nodes.find((node) => node.id === id);
    if (!target?.task) return null;
    const next = nextTaskMark(taskMarkOf(target.task.state), cycle);
    if (next === null) return null;
    const state = taskStateOf(next);
    const toggled: OutlineNode = { ...target, task: { line: target.task.line, state, checked: state === 'done' }, html: replaceLeadingMark(target.html, state, parsed.taskIcons) };
    return { ...parsed, nodes: parsed.nodes.map((node) => (node.id === id ? toggled : node)) };
}

export async function mountStandalone(container: HTMLElement, data: StandaloneData, options: MountOptions = {}): Promise<StandaloneDiagram> {
    const fromSource = data.parsed === undefined;
    if (fromSource && data.source === undefined) throw new Error('parsed か source のどちらかが要ります');
    const tasks: StandaloneTasks = data.tasks ?? 'readonly';

    const loaded = data.hookScripts ? await importHookScripts(data.hookScripts) : null;
    const hookRefs = loaded?.refs;
    // 解析結果を受けた経路では、タスクの切り替えのたびに差し替える
    let parsed = data.parsed;
    const hasSource = data.source !== undefined;
    let source = data.source ?? '';
    let diagnostics: Diagnostic[] = [];

    const viewHooks: ViewHooks =
        tasks === 'scratch'
            ? {
                  // 橋渡しが順と規則とフックを確かめたあとに呼ばれる。原文があれば原文も進めて、フックに見せる文と行をそろえる
                  onToggleTask: (node, cycle) => {
                      if (!node.task) return;
                      if (parsed) {
                          const next = toggleParsedTask(parsed, node.id, cycle);
                          if (next === null) return;
                          parsed = next;
                      }
                      if (hasSource || fromSource) source = toggleTask(source, node.task.line, cycle);
                      draw(false);
                  },
              }
            : {};
    const bridge = createHookBridge({
        source: () => source,
        diagnostics: () => diagnostics,
        hooks: tasks === 'readonly' ? READ_ONLY_TASKS : undefined,
        // 原文を解析し直せるときだけ、フックからの本文の差し替えを受ける
        update: fromSource
            ? (next) => {
                  source = next;
                  draw(false);
              }
            : undefined,
        viewHooks,
    });

    const extra = { types: data.types, hookRefs };
    const draw = (fit: boolean): void => {
        let current: ParsedDocument;
        let model: GraphModel;
        if (parsed) {
            current = parsed;
            model = buildModel(parsed.nodes, parsed.frontmatter, hasSource ? source : undefined, extra);
        } else {
            // 解析と組み立ては 1 回の呼び出し。transformSource が原文を差し替えたときだけ、差し替えたほうで読み直す
            ({ parsed: current, model } = renderDocument(source, extra));
            const rendered = bridge.transform(model, source);
            if (rendered !== source) ({ parsed: current, model } = renderDocument(rendered, extra));
        }
        diagnostics = [...model.diagnostics, ...(loaded?.diagnostics ?? [])];
        bridge.setDocument(current, model, fit);
    };

    const view = new MarkdagView(container, bridge.viewHooks);
    bridge.attach(view);
    container.dataset.tasks = tasks;
    if (container.clientHeight === 0) container.style.height = FALLBACK_HEIGHT;
    // 開閉の復元と最初の位置決めは動かさずに済ませ、そのあとで指定どおりの動きに戻す
    view.setOptions({ ...data.view, animate: false });
    draw(false);
    if (data.state?.folded) view.setFolded(data.state.folded);
    if (data.state?.transform) view.setTransform(data.state.transform);
    else view.fit();
    view.setOptions({ animate: data.view?.animate ?? true });

    return {
        view,
        get diagnostics() {
            return diagnostics;
        },
        destroy: () => bridge.destroy(),
    };
}

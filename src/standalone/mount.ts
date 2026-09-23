// 単体の HTML に埋め込んだ素材 (解析結果か原文、型定義、フックのソース、表示の指定、開閉の状態) から、要素の中に図を組み立てる。
// 書き出した HTML の script から呼ぶためのものだが、アプリが書き出す前の確認に同じ素材で呼んでもよい。
// 解析結果を受けたときは変換器なしで描く (markmap-lib を含まないランタイムで足りる)。原文だけのときは変換器で解析する。
// タスクの切り替えは、書き換えた原文の保存先がないので受け付けない (クリックしても変わらない)。
import { createHookBridge } from '../bridge';
import type { HookModule } from '../model/hooks';
import { buildModel, type Diagnostic } from '../model/model';
import { parseDocument, type ParsedDocument, type TransformerLike } from '../parse/document';
import { MarkdagView, type ViewOptions, type ViewTransform } from '../view/view';

// 開いた先で効く表示の指定。見る人が変えられるものだけで、配置の差し替えのような関数は持てない
export type StandaloneViewOptions = Partial<Pick<ViewOptions, 'theme' | 'details' | 'legend' | 'animate'>>;

export interface StandaloneState {
    // 折りたたんでいるノードの id (view.getFolded() の値)。省略すると文書の初期状態
    folded?: number[];
    // ズームとパン。省略すると全体を収める。コンテナの寸法に依存するので、同じ寸法で開く当てがあるときだけ渡す
    transform?: ViewTransform;
}

// HTML に JSON で埋める素材。関数や Map を含まないので、そのまま JSON.stringify できる
export interface StandaloneData {
    // 解析結果。あれば変換器なしで描く。呼び出し側は、画像の URL の書き換えなどを済ませてから渡す
    parsed?: ParsedDocument;
    // 原文。parsed がなければこれを変換器で解析する。parsed があるときは診断の位置付けに使うだけで、省略できる
    source?: string;
    // markdag.types.$ref の解決結果 (書かれたパスをキーにした、YAML を読んだ値)
    types?: Record<string, unknown>;
    // markdag.hooks.$ref の解決結果を、モジュールのソース文字列で渡す (書かれたパスをキーにする)。
    // 開いたときにモジュールとして読み込む。省略すると、フックは読み込まない (markdag.rules は効く)
    hookScripts?: Record<string, string>;
    view?: StandaloneViewOptions;
    state?: StandaloneState;
}

export interface StandaloneDiagram {
    readonly view: MarkdagView;
    // 描いた文書の診断。フックのソースを読み込めなかったときの診断も含む
    readonly diagnostics: Diagnostic[];
    destroy(): void;
}

export interface MountOptions {
    // 原文だけを受けたときに解析に使う変換器
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
                refs[ref] = { ...((await import(/* @vite-ignore */ url)) as Record<string, unknown>) };
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

export async function mountStandalone(container: HTMLElement, data: StandaloneData, options: MountOptions = {}): Promise<StandaloneDiagram> {
    const { transformer } = options;
    const fromSource = data.parsed === undefined;
    if (fromSource && data.source === undefined) throw new Error('parsed か source のどちらかが要ります');
    if (fromSource && transformer === undefined) throw new Error('原文だけを描くには変換器が要ります (markdag/core では transformer を渡します)');

    const loaded = data.hookScripts ? await importHookScripts(data.hookScripts) : null;
    const hookRefs = loaded?.refs;
    let source = data.source ?? '';
    let diagnostics: Diagnostic[] = [];

    const bridge = createHookBridge({
        source: () => source,
        diagnostics: () => diagnostics,
        hooks: READ_ONLY_TASKS,
        // 原文を解析し直せるときだけ、フックからの本文の差し替えを受ける
        update: fromSource
            ? (next) => {
                  source = next;
                  draw(false);
              }
            : undefined,
    });

    const build = (parsed: ParsedDocument, text: string | undefined) => buildModel(parsed.nodes, parsed.frontmatter, text, { types: data.types, hookRefs });
    const draw = (fit: boolean): void => {
        let parsed = data.parsed ?? parseDocument(source, { transformer: transformer as TransformerLike });
        let model = build(parsed, data.source);
        if (fromSource) {
            // transformSource が原文を差し替えたときだけ、差し替えたほうで読み直す
            const rendered = bridge.transform(model, source);
            if (rendered !== source) {
                parsed = parseDocument(rendered, { transformer: transformer as TransformerLike });
                model = build(parsed, rendered);
            }
        }
        diagnostics = [...model.diagnostics, ...(loaded?.diagnostics ?? [])];
        bridge.setDocument(parsed, model, fit);
    };

    const view = new MarkdagView(container, bridge.viewHooks);
    bridge.attach(view);
    container.dataset.tasks = 'readonly';
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

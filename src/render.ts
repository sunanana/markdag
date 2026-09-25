// Markdown の文字列を受け取り、渡された要素の中に図を描く。
// 解析、モデルの組み立て、描画をつなぎ、スタイルシートの差し込みと、数式やコードの色付けに要る外部のスタイルシートの読み込みを受け持つ。
// 原文はここが持ち、タスクの項目のクリックでは原文を書き換えて描き直す。解析とモデルの組み立ては Rust (wasm) を呼ぶので、先に init を待つ。
import { createHookBridge } from './bridge';
import type { HookEvent, HookModule } from './model/hooks';
import { renderDocument, type Diagnostic, type ModelOptions } from './model/model';
import { toggleTask, type ParsedDocument, type ParseOptions } from './parse/document';
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

// 描いたあとに、文書が使うのにページにない飾りのライブラリ (KaTeX、highlight.js) を読む関数。読めて描き直すべきなら true で解決する。
// 既定の入口だけが渡す。CDN から読む部品はその入口のファイルだけに入れ、markdag/core と単体 HTML のランタイムの成果物には入れない
// (zu は markdag/core の成果物に CDN の読み込みの経路がないことを確かめている)
export type DecoratorLoader = (parsed: ParsedDocument) => Promise<boolean>;

// markdag/core の入口の render。数式とコードの飾りは、ページにある KaTeX と highlight.js だけを使う (外部から JS を読まない)
export function render(container: HTMLElement, markdown: string, options: RenderOptions = {}): MarkdagDiagram {
    return renderWith(container, markdown, options, null);
}

// render の本体。loadDecorators を渡すと (既定の入口)、描いたあとに飾りのライブラリを読み、読めたら描き直す (A-194 (2))。null なら読まない
export function renderWith(container: HTMLElement, markdown: string, options: RenderOptions, loadDecorators: DecoratorLoader | null): MarkdagDiagram {
    // transformer は Rust 化の前の名残で、使わない (view の指定に紛れ込まないよう取り除く)
    const { injectStyle = true, onChange, transformer: _transformer, onFoldChange, onLayout, onTransform, types, hookRefs, hooks, onDiagnostic, onHookError, ...viewOptions } = options;
    if (injectStyle) injectStyleSheet();

    // 文書に書かれたままの原文。タスクの切り替えと update が書き換えるのはこちら
    let source = markdown;
    let diagnostics: Diagnostic[] = [];
    // フックと規則の配線は橋渡しに任せ、ここは本文の持ち主として書き換えと描き直しを受け持つ
    const bridge = createHookBridge({
        source: () => source,
        diagnostics: () => diagnostics,
        hooks,
        onDiagnostic,
        onHookError,
        update: (next) => {
            source = next;
            draw(false);
            onChange?.(source);
        },
        viewHooks: {
            onToggleTask: (node, cycle) => {
                if (!node.task) return;
                source = toggleTask(source, node.task.line, cycle);
                draw(false);
                onChange?.(source);
            },
            onFoldChange,
            onTransform,
            onLayout,
        },
    });

    let destroyed = false;
    const draw = (fit: boolean): Diagnostic[] => {
        // 使うフックは文書の frontmatter が決めるので、まず原文を読んでフックをそろえる (解析と組み立ては 1 回の呼び出し)
        let { parsed, model } = renderDocument(source, { types, hookRefs });
        // transformSource が原文を差し替えたときだけ、差し替えたほうで読み直す
        const rendered = bridge.transform(model, source);
        if (rendered !== source) ({ parsed, model } = renderDocument(rendered, { types, hookRefs }));
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
        bridge.setDocument(parsed, model, fit);
        if (loadDecorators !== null) {
            // 読めたら今の原文で描き直す (ズームとパンは保つ)。読み終える前に文書が差し替わっていても、描くのは最新の原文
            void loadDecorators(parsed)
                .then((loaded) => {
                    if (loaded && !destroyed) redraw();
                })
                .catch((error: unknown) => console.error('markdag: 飾りのライブラリを読めませんでした', error));
        }
        return diagnostics;
    };

    // 飾りを読めたあとの描き直し。呼び出し元の try の外で走るので、誤り (配置の誤りなど) はここで捕まえて console.error に出し、
    // 今の図と診断を残す (捕まえない Promise の拒否にしない)
    const redraw = (): void => {
        const previous = diagnostics;
        try {
            draw(false);
        } catch (error) {
            diagnostics = previous;
            console.error('markdag: 飾りを読んだあとの描き直しに失敗しました。今の図を残します', error);
        }
    };

    const view = new MarkdagView(container, bridge.viewHooks);
    bridge.attach(view);
    if (container.clientHeight === 0) container.style.height = FALLBACK_HEIGHT;
    view.setOptions(viewOptions);
    draw(true);

    return {
        view,
        get diagnostics() {
            return diagnostics;
        },
        update(next: string) {
            if (!bridge.beforeUpdate(next)) return diagnostics;
            source = next;
            return draw(false);
        },
        fit: () => view.fit(),
        expandAll: () => view.expandAll(),
        resetFold: () => view.resetFold(),
        destroy: () => {
            destroyed = true;
            bridge.destroy();
        },
    };
}

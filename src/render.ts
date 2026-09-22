// Markdown の文字列を受け取り、渡された要素の中に図を描く。
// 解析、モデルの組み立て、描画をつなぎ、スタイルシートの差し込みと、数式やコードの色付けに要る外部のスタイルシートの読み込みを受け持つ。
// 原文はここが持ち、タスクの項目のクリックでは原文を書き換えて描き直す。変換器は呼び出し側から受け取る。
import { createHookBridge } from './bridge';
import type { HookEvent, HookModule } from './model/hooks';
import { buildModel, type Diagnostic, type ModelOptions } from './model/model';
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
            onToggleTask: (node) => {
                if (!node.task) return;
                source = toggleTask(source, node.task.line);
                draw(false);
                onChange?.(source);
            },
            onFoldChange,
            onTransform,
            onLayout,
        },
    });

    const draw = (fit: boolean): Diagnostic[] => {
        // 使うフックは文書の frontmatter が決めるので、まず原文を読んでフックをそろえる
        let parsed = parseDocument(source, { transformer });
        let model = buildModel(parsed.nodes, parsed.frontmatter, source, { types, hookRefs });
        // transformSource が原文を差し替えたときだけ、差し替えたほうで読み直す
        const rendered = bridge.transform(model, source);
        if (rendered !== source) {
            parsed = parseDocument(rendered, { transformer });
            model = buildModel(parsed.nodes, parsed.frontmatter, rendered, { types, hookRefs });
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
        bridge.setDocument(parsed, model, fit);
        return diagnostics;
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
        destroy: () => bridge.destroy(),
    };
}

// Markdown の文字列を受け取り、渡された要素の中に図を描く。
// 解析、モデルの組み立て、描画をつなぎ、スタイルシートの差し込みと、数式やコードの色付けに要る外部のスタイルシートの読み込みを受け持つ。
// 原文はここが持ち、タスクの項目のクリックでは原文を書き換えて描き直す。変換器は呼び出し側から受け取る。
import { buildModel, type Diagnostic, type ModelOptions } from './model/model';
import { parseDocument, toggleTask, type ParseOptions } from './parse/document';
import styleSheet from './style.css?inline';
import { MarkdagView, type ViewHooks, type ViewOptions } from './view/view';

export interface RenderOptions extends Partial<ViewOptions>, ParseOptions, ModelOptions, Pick<ViewHooks, 'onFoldChange' | 'onTransform'> {
    // 図のスタイルシートを、ページの head に差し込むか。自分でスタイルシートを読み込むページでは false にする
    injectStyle?: boolean;
    // タスクの項目のクリックなどで、原文が書き換わったときに呼ぶ
    onChange?: (markdown: string) => void;
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
    const { injectStyle = true, onChange, transformer, onFoldChange, onTransform, types, ...viewOptions } = options;
    if (injectStyle) injectStyleSheet();

    let source = markdown;
    let diagnostics: Diagnostic[] = [];
    const draw = (fit: boolean): Diagnostic[] => {
        const parsed = parseDocument(source, { transformer });
        const model = buildModel(parsed.nodes, parsed.frontmatter, source, { types });
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
        view.setDocument(parsed, model, fit);
        diagnostics = [...model.diagnostics, ...notes];
        return diagnostics;
    };

    const view = new MarkdagView(container, {
        onToggleTask: (node) => {
            if (!node.task) return;
            source = toggleTask(source, node.task.line);
            draw(false);
            onChange?.(source);
        },
        onFoldChange,
        onTransform,
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
            source = next;
            return draw(false);
        },
        fit: () => view.fit(),
        expandAll: () => view.expandAll(),
        resetFold: () => view.resetFold(),
        destroy: () => view.destroy(),
    };
}

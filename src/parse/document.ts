// parse 層の包み。Markdown をノードの木にする解析は Rust (wasm の parse_document) が行い、ここは境界の結果を公開の形に直す:
// 数式とコードの印 (features) を外部のスタイルシートの URL (styleUrls) に直して欄を消し、ページに KaTeX と highlight.js があれば
// 印の要素に飾り (組版と色付け) を当てる。変換器 (markmap-lib) は使わない。wasm を init する前に呼ぶと WasmNotReadyError を投げる。
import { callJson } from '../wasm/boundary';
import type { TaskState } from './task';

export { DEFAULT_TASK_CYCLE, isTaskMark, nextTaskMark, TASK_MARKS, TASK_STATES, taskMarkOf, taskStateOf, toggleTask } from './task';
export type { TaskMark, TaskState } from './task';

// 原文での位置。行と桁は 1 始まりで、桁と長さは文字数で数える
export interface SourcePosition {
    line: number;
    column: number;
    length: number;
}

// ノードに付けたタグ 1 つ。`#キー:値` の値は , で区切って複数書ける。`#キー` だけなら値は空
export interface NodeTag {
    key: string;
    values: string[];
    // 原文での印の位置 (`#キー:値` の全体)。同じキーを 1 行に 2 回書いたときは最初のもの
    at: SourcePosition;
}

export interface OutlineNode {
    // 文書順 (深さ優先の先行順) の連番。ルートが 1
    id: number;
    parent: number | null;
    // ルートが 1
    depth: number;
    // ノードの内容。詳細の引用ブロックは、書かれた位置に印 (クラス mdag-details) を付けて残してある
    html: string;
    // relations と groups から参照するときに照合する文字列 (1 行目の、装飾を除いた文字)
    refText: string;
    refId: string | null;
    // 1 行目の末尾に `%名前` で付けた、そのノード自身のグループ (配下への継承は model 層が解決する)
    groups: string[];
    // 1 行目の末尾に `#キー:値` で付けたタグ。配下には継承しない
    tags: NodeTag[];
    milestone: boolean;
    // Markdown のコメントによる折りたたみの指定。1 = そのノード、2 = 配下もすべて
    foldHint: number;
    // 原文での行の範囲 (0 始まり。end の行は含まない)。原文の行に対応しないノードは null
    lines: { start: number; end: number } | null;
    // タスク (`- [ ]`, `## [/]` など) の場合の、原文での行 (0 始まり) と状態。checked は state が done のこと。それ以外は null
    task: { line: number; state: TaskState; checked: boolean } | null;
    // リスト項目の中に Markdown の引用ブロック (`>`) で書かれた詳細の HTML (複数あれば、つなげたもの)。吹き出しで見せるのに使う。
    // ノードの中に開いて見せるときは、html に残した引用ブロックを、書かれた位置でそのまま見せる
    details: string | null;
}

export interface ParsedDocument {
    nodes: OutlineNode[];
    frontmatter: Record<string, unknown>;
    // frontmatter に markdag のキーがあり、タグなどの抽出を行ったか
    extracted: boolean;
    // 数式やコードの色付けに必要な、外部のスタイルシートの URL
    styleUrls: string[];
    // 状態ごとの記号の絵。Rust の解析は常に返す (null は Rust 化の前の、記号を絵にしない変換器の名残)。
    // 原文を解析し直さずに記号だけを差し替える場面 (単体の HTML でのタスクの切り替え) で使う
    taskIcons: TaskIcons | null;
}

// Markdown をノードの木にする変換器の形。Rust 化の前は parseDocument に渡していた。今は使わない (型を import している利用者のために残す)
/** @deprecated 解析は Rust で行うので、変換器は使いません */
export interface TransformerLike {
    transform(markdown: string): { root: unknown; features: unknown; frontmatter?: unknown };
    getUsedAssets(features: unknown): { styles?: Array<{ type: string; data: unknown }> };
}

export interface ParseOptions {
    /** @deprecated 解析は Rust で行うので、渡しても使いません */
    transformer?: TransformerLike;
}

// 状態ごとの記号の絵 (SVG)
export type TaskIcons = Record<TaskState, string>;

// 文書が数式やコードを含むか (境界の ParsedDocument の features)
interface ParsedFeatures {
    math: boolean;
    code: boolean;
}

// 境界の parse_document と render_document が返す解析の結果。styleUrls の代わりに features を持つ
export type RawParsedDocument = Omit<ParsedDocument, 'styleUrls'> & { features: ParsedFeatures };

// 数式とコードの色付けのスタイルシート。Rust 化の前の変換器 (markmap-lib の katex と hljs のプラグイン) が返していた URL と同じもの (決定 12)。
// 順も変換器のプラグインの順 (数式が先)
export const MATH_STYLE_URL = 'https://cdn.jsdelivr.net/npm/katex@0.16.18/dist/katex.min.css';
export const CODE_STYLE_URL = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/default.min.css';

const styleUrlsOf = (features: ParsedFeatures): string[] => [...(features.math ? [MATH_STYLE_URL] : []), ...(features.code ? [CODE_STYLE_URL] : [])];

// ページに読み込まれた KaTeX と highlight.js (グローバル変数)。どちらもなければ印のまま (TeX の原文と色なしのコード) で返す。
// 変換器を使っていたころも、ページに KaTeX がなければ TeX の原文のまま返していた (migration/judge/accepted.md の 10 行目)
interface KatexLike {
    renderToString(tex: string, options: { displayMode: boolean; throwOnError: boolean }): string;
}
interface HljsLike {
    getLanguage(name: string): unknown;
    highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}
const globalOf = <T>(name: string, method: string): T | null => {
    const value = (globalThis as Record<string, unknown>)[name];
    return value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)[method] === 'function' ? (value as T) : null;
};

// 文書が使う飾りのうち、ページにまだライブラリがないもの (styleUrls で文書が数式やコードを使うかを見る)
export function missingDecorators(parsed: Pick<ParsedDocument, 'styleUrls'>): { math: boolean; code: boolean } {
    return {
        math: parsed.styleUrls.includes(MATH_STYLE_URL) && globalOf<KatexLike>('katex', 'renderToString') === null,
        code: parsed.styleUrls.includes(CODE_STYLE_URL) && globalOf<HljsLike>('hljs', 'highlight') === null,
    };
}

// 印の要素の中身は Rust が & < > " だけを文字参照にして書いている
const unescapeHtml = (text: string): string => text.replace(/&(amp|lt|gt|quot);/g, (_whole, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[name] ?? '');

const MATH_MARK = /<(span|div) class="(mdag-math|mdag-math-block)">([^<]*)<\/\1>/g;
const CODE_MARK = /<code class="language-([^"]*)">([^<]*)<\/code>/g;

// ノードの html (と詳細) の数式とコードの印に、ページにある KaTeX と highlight.js で飾りを当てる。文字列の変換だけで DOM は触らない
function decorateHtml(html: string, katex: KatexLike | null, hljs: HljsLike | null): string {
    let result = html;
    if (katex !== null) {
        result = result.replace(MATH_MARK, (_whole, tag: string, kind: string, tex: string) => {
            const rendered = katex.renderToString(unescapeHtml(tex), { displayMode: kind === 'mdag-math-block', throwOnError: false });
            return `<${tag} class="${kind}">${rendered}</${tag}>`;
        });
    }
    if (hljs !== null) {
        result = result.replace(CODE_MARK, (whole, language: string, code: string) => {
            const name = unescapeHtml(language);
            if (!hljs.getLanguage(name)) return whole;
            return `<code class="language-${language}">${hljs.highlight(unescapeHtml(code), { language: name, ignoreIllegals: true }).value}</code>`;
        });
    }
    return result;
}

// 境界の解析の結果を公開の ParsedDocument にする。parse_document と render_document の両方の結果にこれを当てる (設計文書 (c))
export function decorateParsed(raw: RawParsedDocument): ParsedDocument {
    const { features, ...rest } = raw;
    const katex = features.math ? globalOf<KatexLike>('katex', 'renderToString') : null;
    const hljs = features.code ? globalOf<HljsLike>('hljs', 'highlight') : null;
    const nodes =
        katex === null && hljs === null
            ? rest.nodes
            : rest.nodes.map((node) => ({
                  ...node,
                  html: decorateHtml(node.html, katex, hljs),
                  details: node.details === null ? null : decorateHtml(node.details, katex, hljs),
              }));
    // 欄の順は Rust 化の前の parseDocument が返したものに合わせる (nodes、frontmatter、extracted、taskIcons、styleUrls)
    return { nodes, frontmatter: rest.frontmatter, extracted: rest.extracted, taskIcons: rest.taskIcons, styleUrls: styleUrlsOf(features) };
}

// options は Rust 化の前の変換器の指定の名残で、使わない
export function parseDocument(source: string, _options?: ParseOptions): ParsedDocument {
    return decorateParsed(callJson<RawParsedDocument>('parse_document', { source }));
}

// ノードの内容の先頭にある状態の記号を、別の状態のものに差し替える。絵なら絵、文字のままなら文字を差し替え、どちらでもなければそのまま。
// 原文を解析し直せない場面 (単体の HTML) で、タスクの状態だけを進めるのに使う
export function replaceLeadingMark(html: string, state: TaskState, icons: TaskIcons | null): string {
    return callJson<{ html: string }>('replace_leading_mark', { html, state, icons }).html;
}

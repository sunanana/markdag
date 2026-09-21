// parse 層 (簡易版)。Markdown を変換器 (markmap-lib の Transformer と同じ形のもの) でノードの木にし、markdag の付加情報
// (タグ、$id、参照用のテキスト、マイルストーン、詳細) を取り出す。markdown-it のトークンの段階では加工せず、原文の行を前処理してから変換し、
// 行番号でノードに対応づける (順序付きリストの番号、全角スペースの警告などは扱わない)。
// 変換器は呼び出し側から受け取り、ここでは特定の変換器を import しない (利用者が自分の構成の変換器に差し替えられるようにするため)。
// HTML の読み取りに DOMParser を使うので、ブラウザで動かす。

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
    tags: string[];
    milestone: boolean;
    // Markdown のコメントによる折りたたみの指定。1 = そのノード、2 = 配下もすべて
    foldHint: number;
    // 原文での行の範囲 (0 始まり。end の行は含まない)。変換器が行を付けなかったノードは null
    lines: { start: number; end: number } | null;
    // タスクのリスト項目 (`- [ ]`, `- [x]`) の場合の、原文での行 (0 始まり) と状態。それ以外は null
    task: { line: number; checked: boolean } | null;
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
}

// Markdown をノードの木にする変換器に求める形。markmap-lib の Transformer がこれに当てはまる。
// frontmatter を読むプラグインと、ノードに原文の行を付けるプラグインを含むこと。
// 行が付かないと、タグ、$id、タスク、行の範囲のどれもノードに対応づけられず、黙って抜け落ちる
export interface TransformerLike {
    transform(markdown: string): { root: unknown; features: unknown; frontmatter?: unknown };
    getUsedAssets(features: unknown): { styles?: Array<{ type: string; data: unknown }> };
}

export interface ParseOptions {
    transformer: TransformerLike;
}

interface MarkmapNode {
    content: string;
    children?: MarkmapNode[];
    payload?: { lines?: string; fold?: number; tag?: string };
}

interface LineAnnotation {
    tags: string[];
    refId: string | null;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\n---\r?\n/;
const HEADING = /^#{1,6}[ \t]+\S/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/;
const FENCE = /^[ \t]*(```|~~~)/;
const TASK_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[( |x|X)\][ \t]/;
// 見出しのタスク (`## [ ] 名前`)。下線で書く見出しは、行が状態の記号から始まる。見出しと分かっている行にだけ使う
const TASK_HEADING = /^[ \t]*(?:#{1,6}[ \t]+)?\[( |x|X)\][ \t]/;
// 大文字で書かれた完了の記号と、その前に置かれた行頭の記号 (リストの記号か、見出しの #)
const UPPER_MARK = /^([ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|#{1,6}[ \t]+)?)\[X\](?=[ \t])/;
const SETEXT_UNDERLINE = /^[ \t]{0,3}(?:=+|-+)[ \t]*\r?$/;
const TRAILING_TOKEN = /[ \t]+(#[\p{L}\p{N}_-]+|\$[A-Za-z][A-Za-z0-9_-]*)[ \t]*$/u;

// 本文の行 (frontmatter とコードブロックの中を除く) を、1 行ずつ書き換える。行数は変えない
function rewriteBodyLines(source: string, rewrite: (line: string, index: number, lines: string[]) => string): string {
    const frontmatterLines = (FRONTMATTER.exec(source)?.[0].split('\n').length ?? 1) - 1;
    let inFence = false;
    return source
        .split('\n')
        .map((line, index, lines) => {
            if (index < frontmatterLines) return line;
            if (FENCE.test(line)) inFence = !inFence;
            return inFence ? line : rewrite(line, index, lines);
        })
        .join('\n');
}

// 完了の記号の大文字 (`[X]`) を、小文字にそろえる。変換器が絵にするのは小文字だけで、大文字は文字のまま残るため。
// 文字数も行数も変えない
function normalizeTaskMarks(source: string): string {
    return rewriteBodyLines(source, (line, index, lines) => {
        const match = UPPER_MARK.exec(line);
        if (!match) return line;
        // 行頭の記号がない行は、下線で書く見出し (次の行が === か ---) のときだけがタスク
        if ((match[1] ?? '').trim() === '' && !SETEXT_UNDERLINE.test(lines[index + 1] ?? '')) return line;
        return line.replace('[X]', '[x]');
    });
}

// 見出しとリスト項目の 1 行目の末尾から、`#タグ` と `$id` を取り除く。行数は変えない
function stripAnnotations(source: string): { text: string; annotations: Map<number, LineAnnotation> } {
    const annotations = new Map<number, LineAnnotation>();
    const text = rewriteBodyLines(source, (line, index) => {
        if (!(HEADING.test(line) || LIST_ITEM.test(line))) return line;

        const annotation: LineAnnotation = { tags: [], refId: null };
        // 改行が CRLF の文書では、行の終わりに \r が残る。末尾の照合の邪魔になるので外しておき、最後に戻す
        const carriage = line.endsWith('\r') ? '\r' : '';
        let rest = carriage === '' ? line : line.slice(0, -1);
        for (let match = TRAILING_TOKEN.exec(rest); match; match = TRAILING_TOKEN.exec(rest)) {
            const token = match[1] ?? '';
            // 数字だけの名前 (Issue #123 など) はタグにしない。$id は 1 つまで
            if (token.startsWith('#') && /^#\d+$/.test(token)) break;
            if (token.startsWith('$') && annotation.refId !== null) break;
            if (token.startsWith('#')) annotation.tags.unshift(token.slice(1));
            else annotation.refId = token.slice(1);
            rest = rest.slice(0, match.index);
        }
        if (annotation.tags.length > 0 || annotation.refId !== null) annotations.set(index, annotation);
        return rest + carriage;
    });
    return { text, annotations };
}

const normalize = (text: string): string => text.normalize('NFC').replace(/[ \t\n]+/g, ' ').trim();

// 1 行目 (最初の <br> より前) の、装飾と状態の記号を除いた文字と、全体が 1 つの太字で包まれているか
function describeFirstLine(html: string): { refText: string; milestone: boolean } {
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
    for (const svg of body.querySelectorAll('svg')) svg.remove();
    const firstBreak = body.querySelector('br');
    if (firstBreak) {
        const range = body.ownerDocument.createRange();
        range.setStartBefore(firstBreak);
        range.setEndAfter(body.lastChild ?? firstBreak);
        range.deleteContents();
    }
    const meaningful = [...body.childNodes].filter((node) => normalize(node.textContent ?? '') !== '');
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    return {
        refText: normalize(body.textContent ?? ''),
        milestone: only !== undefined && only.nodeType === Node.ELEMENT_NODE && (only as Element).tagName === 'STRONG',
    };
}

// 詳細の引用ブロックに付ける印 (クラス)。描画の側は、この印で詳細を隠したり、その場に開いて見せたりする
const DETAILS_CLASS = 'mdag-details';

// ノードの内容から、詳細 (Markdown の引用ブロック) を見分ける。引用ブロックは書かれた位置に残して印だけを付け (html)、
// 参照用のテキストを取り出すための、詳細を除いた内容 (plain) と、詳細だけをまとめたもの (details) も返す。
// HTML のタグで直接書いた blockquote は、変換時に付く行番号の属性を持たないので対象にならず、内容として表示される
function splitDetails(html: string): { html: string; plain: string; details: string | null } {
    if (!html.includes('<blockquote')) return { html, plain: html, details: null };
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
    const quotes = [...body.querySelectorAll(':scope > blockquote[data-lines]')];
    if (quotes.length === 0) return { html, plain: html, details: null };
    for (const quote of quotes) quote.classList.add(DETAILS_CLASS);
    const marked = body.innerHTML.trim();
    for (const quote of quotes) quote.remove();
    return { html: marked, plain: body.innerHTML.trim(), details: quotes.map((quote) => quote.innerHTML.trim()).join('\n') };
}

// 変換器がノードに付けた行の範囲 (「開始,終了」の文字) を読む
function lineRange(lines: string | undefined): OutlineNode['lines'] {
    const [start, end] = (lines ?? '').split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
    return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
}

// タスクになるのは、リスト項目と見出し。どちらも 1 行目が状態の記号 (`[ ]`, `[x]`, `[X]`) から始まるもの
function taskAt(sourceLines: string[], line: number, tag: string | undefined): OutlineNode['task'] {
    const pattern = tag === 'li' ? TASK_ITEM : /^h[1-6]$/.test(tag ?? '') ? TASK_HEADING : null;
    const mark = pattern?.exec(sourceLines[line] ?? '')?.[1];
    return mark === undefined ? null : { line, checked: mark !== ' ' };
}

interface MarkIcons {
    todo: string;
    done: string;
}

const LEADING_ICON = /^<svg[\s\S]*?<\/svg>/;
const LEADING_MARK = /^\[( |x)\] /;
const markIcons = new WeakMap<TransformerLike, MarkIcons | null>();

// 変換器が状態の記号の代わりに描く絵。小さな文書を変換して、その結果から取り出す (絵そのものを、ここに持たずに済ませる)。
// 記号を絵にしない構成の変換器では null
function markIconsOf(transformer: TransformerLike): MarkIcons | null {
    const known = markIcons.get(transformer);
    if (known !== undefined) return known;
    const root = transformer.transform('# a\n\n## [ ] b\n\n## [x] c\n').root as MarkmapNode;
    const [todo, done] = (root.children ?? []).map((child) => LEADING_ICON.exec(child.content)?.[0]);
    const icons = todo !== undefined && done !== undefined ? { todo, done } : null;
    markIcons.set(transformer, icons);
    return icons;
}

// 文書の最初のブロックが見出しのとき、変換器はその見出しの状態の記号を絵にせず、文字のまま残す。
// ほかのタスクと見た目も参照用のテキストもそろうよう、残った記号を同じ絵に置き換える
function drawLeadingMark(html: string, transformer: TransformerLike): string {
    const mark = LEADING_MARK.exec(html)?.[1];
    const icons = mark === undefined ? null : markIconsOf(transformer);
    return mark === undefined || icons === null ? html : html.replace(LEADING_MARK, () => `${mark === ' ' ? icons.todo : icons.done} `);
}

// タスクのリスト項目の状態を、原文の上で反転する。原文にない行を指定されたら、何も変えない
export function toggleTask(source: string, line: number): string {
    const lines = source.split('\n');
    const current = lines[line];
    if (current === undefined) return source;
    lines[line] = current.replace(/\[( |x|X)\]/, (_, mark: string) => (mark === ' ' ? '[x]' : '[ ]'));
    return lines.join('\n');
}

export function parseDocument(original: string, { transformer }: ParseOptions): ParsedDocument {
    // 行と桁は変えないので、このあとの行番号は原文のものとしてそのまま使える
    const source = normalizeTaskMarks(original);
    const probe = transformer.transform(source);
    // frontmatter は「キー: 値」の形でない文書もある (一覧や文字列だけ)。形が違うことの診断は model 層が出すので、
    // ここでは抽出をしない判断にだけ使う
    const frontmatter = (probe.frontmatter ?? {}) as Record<string, unknown>;
    const isMapping = typeof frontmatter === 'object' && frontmatter !== null && !Array.isArray(frontmatter);
    const extracted = isMapping && ['relations', 'groups', 'markdag'].some((key) => key in frontmatter);

    const { text, annotations } = extracted ? stripAnnotations(source) : { text: source, annotations: new Map() };
    const result = extracted ? transformer.transform(text) : probe;
    const assets = transformer.getUsedAssets(result.features);

    const sourceLines = source.split('\n');
    const nodes: OutlineNode[] = [];
    const visit = (node: MarkmapNode, parent: number | null, depth: number): void => {
        const id = nodes.length + 1;
        const lines = lineRange(node.payload?.lines);
        const startLine = lines?.start ?? Number.NaN;
        const annotation = annotations.get(startLine);
        const task = taskAt(sourceLines, startLine, node.payload?.tag);
        const content = task === null ? node.content : drawLeadingMark(node.content, transformer);
        const { html, plain, details } = extracted ? splitDetails(content) : { html: content, plain: content, details: null };
        const firstLine = describeFirstLine(plain);
        const title = typeof frontmatter.title === 'string' ? frontmatter.title : '';
        nodes.push({
            id,
            parent,
            depth,
            html,
            refText: firstLine.refText || (parent === null ? normalize(title) : ''),
            refId: annotation?.refId ?? null,
            tags: annotation?.tags ?? [],
            milestone: extracted && firstLine.milestone,
            foldHint: node.payload?.fold ?? 0,
            lines,
            task,
            details,
        });
        for (const child of node.children ?? []) visit(child, id, depth + 1);
    };
    visit(result.root as MarkmapNode, null, 1);

    return {
        nodes,
        frontmatter,
        extracted,
        styleUrls: (assets.styles ?? []).flatMap((item) => {
            const href = item.type === 'stylesheet' && typeof item.data === 'object' && item.data !== null ? (item.data as { href?: unknown }).href : null;
            return typeof href === 'string' ? [href] : [];
        }),
    };
}

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
    // リスト項目の中に Markdown の引用ブロック (`>`) で書かれた詳細の HTML。ノードには表示せず、求められたときに見せる
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
const TRAILING_TOKEN = /[ \t]+(#[\p{L}\p{N}_-]+|\$[A-Za-z][A-Za-z0-9_-]*)[ \t]*$/u;

// 見出しとリスト項目の 1 行目の末尾から、`#タグ` と `$id` を取り除く。行数は変えない
function stripAnnotations(source: string): { text: string; annotations: Map<number, LineAnnotation> } {
    const annotations = new Map<number, LineAnnotation>();
    const frontmatterLines = (FRONTMATTER.exec(source)?.[0].split('\n').length ?? 1) - 1;
    let inFence = false;
    const lines = source.split('\n').map((line, index) => {
        if (index < frontmatterLines) return line;
        if (FENCE.test(line)) inFence = !inFence;
        if (inFence || !(HEADING.test(line) || LIST_ITEM.test(line))) return line;

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
    return { text: lines.join('\n'), annotations };
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

// ノードの内容から、詳細 (Markdown の引用ブロック) を切り離す。
// HTML のタグで直接書いた blockquote は、変換時に付く行番号の属性を持たないので対象にならず、内容として表示される
function splitDetails(html: string): { html: string; details: string | null } {
    if (!html.includes('<blockquote')) return { html, details: null };
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
    const quotes = [...body.querySelectorAll(':scope > blockquote[data-lines]')];
    if (quotes.length === 0) return { html, details: null };
    for (const quote of quotes) quote.remove();
    return { html: body.innerHTML.trim(), details: quotes.map((quote) => quote.innerHTML.trim()).join('\n') };
}

// 変換器がノードに付けた行の範囲 (「開始,終了」の文字) を読む
function lineRange(lines: string | undefined): OutlineNode['lines'] {
    const [start, end] = (lines ?? '').split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
    return start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
}

function taskAt(sourceLines: string[], line: number): OutlineNode['task'] {
    const mark = TASK_ITEM.exec(sourceLines[line] ?? '')?.[1];
    return mark === undefined ? null : { line, checked: mark !== ' ' };
}

// タスクのリスト項目の状態を、原文の上で反転する。原文にない行を指定されたら、何も変えない
export function toggleTask(source: string, line: number): string {
    const lines = source.split('\n');
    const current = lines[line];
    if (current === undefined) return source;
    lines[line] = current.replace(/\[( |x|X)\]/, (_, mark: string) => (mark === ' ' ? '[x]' : '[ ]'));
    return lines.join('\n');
}

export function parseDocument(source: string, { transformer }: ParseOptions): ParsedDocument {
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
        const { html, details } = extracted ? splitDetails(node.content) : { html: node.content, details: null };
        const firstLine = describeFirstLine(html);
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
            task: taskAt(sourceLines, node.payload?.tag === 'li' ? startLine : Number.NaN),
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

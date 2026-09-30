// 図の側の操作 (ノードの追加、削除、名前の変更、付け替え、線の追加と削除) を、原文の Markdown の書き換えとして行う。
// どの操作も、今の原文と、その原文を解析した結果 (ParsedDocument と GraphModel) を受け取り、書き換えたあとの原文を返す純粋な関数。
// 本文は行単位で書き換え、frontmatter は markdag.relations などのブロックを行で探して、そこへ項目を足し引きする (YAML を丸ごと書き直さない)。
// 試作なので、書き換えられない形 (flow 形式の YAML など) に当たったら、原文を変えずに理由を返す。
import type { GraphModel } from '../src/model/model';
import type { OutlineNode, ParsedDocument } from '../src/parse/document';

export interface EditContext {
    source: string;
    parsed: ParsedDocument;
    model: GraphModel;
}

// 操作の結果。ok が false なら原文は変わらず、message に理由が入る。
// focusLine は、書き換えたあとの原文で選んでおきたいノードの 1 行目 (0 始まり)。focusId はノードの id がそのまま使えるとき
export type EditResult =
    | { ok: true; source: string; focusLine?: number; focusId?: number; message?: string }
    | { ok: false; message: string };

export const NEW_LABEL = '新しいノード';

const HEADING = /^(#{1,6})([ \t]+)(.*)$/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const TASK = /^\[([ xX/-])\][ \t]+/;
const MARK = /[ \t]+([%#$][^\s]+)$/;

// ノードの 1 行目を分解したもの。prefix + task + text + marks でもとの行に戻る
export interface FirstLine {
    kind: 'heading' | 'list';
    level: number;
    // リストの字下げ (見出しは空)
    indent: string;
    // 見出しの # か、リストの印 (-, *, 1. など)
    marker: string;
    // prefix は字下げ + 印 + 空白。本文の書き出しの桁は prefix.length
    prefix: string;
    task: string;
    text: string;
    marks: string;
    eol: string;
}

export function parseFirstLine(raw: string): FirstLine | null {
    const eol = raw.endsWith('\r') ? '\r' : '';
    const line = eol ? raw.slice(0, -1) : raw;
    let kind: FirstLine['kind'];
    let indent = '';
    let marker: string;
    let prefix: string;
    let rest: string;
    let level = 0;
    const heading = HEADING.exec(line);
    const list = heading ? null : LIST.exec(line);
    if (heading) {
        kind = 'heading';
        marker = heading[1] ?? '#';
        level = marker.length;
        prefix = marker + (heading[2] ?? ' ');
        rest = heading[3] ?? '';
    } else if (list) {
        kind = 'list';
        indent = list[1] ?? '';
        marker = list[2] ?? '-';
        prefix = indent + marker + (list[3] || ' ');
        rest = list[4] ?? '';
    } else {
        return null;
    }
    const task = TASK.exec(rest)?.[0] ?? '';
    rest = rest.slice(task.length);
    let marks = '';
    for (let found = MARK.exec(rest); found && found.index > 0; found = MARK.exec(rest)) {
        marks = found[0] + marks;
        rest = rest.slice(0, found.index);
    }
    return { kind, level, indent, marker, prefix, task, text: rest, marks, eol };
}

const joinFirstLine = (parts: FirstLine): string => parts.prefix + parts.task + parts.text + parts.marks + parts.eol;

// ---- 木の形 --------------------------------------------------------------------------------------------------------

// ルートが原文の見出しでない (文書に h1 が 1 つでない) ときは、ルートは原文の行を持たない仮のノードとして扱う
function isVirtualRoot(nodes: OutlineNode[], node: OutlineNode, lines: string[]): boolean {
    if (node.parent !== null) return false;
    if (!node.lines) return true;
    const first = lines[node.lines.start] ?? '';
    if (!HEADING.test(first.replace(/\r$/, ''))) return true;
    return nodes.some((other) => other.id !== node.id && other.lines?.start === node.lines?.start);
}

// 配下 (自分は含まない)。id は深さ優先の先行順なので、配下は自分のすぐ後ろに続く
function descendantsOf(nodes: OutlineNode[], node: OutlineNode): OutlineNode[] {
    const result: OutlineNode[] = [];
    for (let index = node.id; index < nodes.length; index++) {
        const next = nodes[index];
        if (!next || next.depth <= node.depth) break;
        result.push(next);
    }
    return result;
}

const childrenOf = (nodes: OutlineNode[], node: OutlineNode): OutlineNode[] => nodes.filter((other) => other.parent === node.id);

// 配下のノードの行のうち、いちばん後ろの行の次
function subtreeEnd(nodes: OutlineNode[], node: OutlineNode): number {
    let end = node.lines?.end ?? 0;
    for (const child of descendantsOf(nodes, node)) end = Math.max(end, child.lines?.end ?? 0);
    return end;
}

// 配下のあとで、次のノードが始まる行 (なければ原文の終わり)
function followingStart(nodes: OutlineNode[], node: OutlineNode, total: number): number {
    const after = descendantsOf(nodes, node).at(-1)?.id ?? node.id;
    for (let index = after; index < nodes.length; index++) {
        const start = nodes[index]?.lines?.start;
        if (start !== undefined) return start;
    }
    return total;
}

// ノードとその配下が原文で占める行の範囲。見出しは、次のノードまでの段落も含める (見出しの下の段落はノードにならないため)
function blockOf(nodes: OutlineNode[], node: OutlineNode, lines: string[]): { start: number; end: number } {
    const start = node.lines?.start ?? 0;
    const first = parseFirstLine(lines[start] ?? '');
    const end = first?.kind === 'heading' ? followingStart(nodes, node, lines.length) : subtreeEnd(nodes, node);
    return { start, end: trimBlankTail(lines, start + 1, end) };
}

// 範囲の末尾の空行を外した終わり (start より前には戻らない)
function trimBlankTail(lines: string[], start: number, end: number): number {
    let result = end;
    while (result > start && (lines[result - 1] ?? '').trim() === '') result--;
    return result;
}

// 本文の書き出し (frontmatter の直後の行)
function bodyStart(lines: string[]): number {
    const range = frontmatterRange(lines);
    return range ? range.close + 1 : 0;
}

// リストの入れ子の字下げの幅。原文の入れ子から読み、なければ 4
function indentUnit(lines: string[], body: number): number {
    let previous: number | null = null;
    for (let index = body; index < lines.length; index++) {
        const list = LIST.exec((lines[index] ?? '').replace(/\r$/, ''));
        if (!list) continue;
        const indent = (list[1] ?? '').length;
        if (previous !== null && indent > previous) return indent - previous;
        previous = indent;
    }
    return 4;
}

// 子を足すときの 1 行目の形。子がいれば最後の子にそろえ、いなければ親の形から決める
interface LineShape {
    kind: 'heading' | 'list';
    level: number;
    indent: string;
    marker: string;
    task: boolean;
}

function shapeOf(first: FirstLine): LineShape {
    return { kind: first.kind, level: first.level, indent: first.indent, marker: first.marker, task: first.task !== '' };
}

function nextMarker(marker: string): string {
    const ordered = /^(\d+)([.)])$/.exec(marker);
    return ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker;
}

function childShape(nodes: OutlineNode[], parent: OutlineNode, lines: string[]): LineShape {
    const last = childrenOf(nodes, parent).at(-1);
    const lastFirst = last?.lines ? parseFirstLine(lines[last.lines.start] ?? '') : null;
    if (lastFirst) return { ...shapeOf(lastFirst), marker: nextMarker(lastFirst.marker) };
    if (isVirtualRoot(nodes, parent, lines)) return { kind: 'list', level: 0, indent: '', marker: '-', task: false };
    const first = parent.lines ? parseFirstLine(lines[parent.lines.start] ?? '') : null;
    if (!first) return { kind: 'list', level: 0, indent: '', marker: '-', task: false };
    if (first.kind === 'heading') {
        return first.level < 6 ? { kind: 'heading', level: first.level + 1, indent: '', marker: '#'.repeat(first.level + 1), task: false } : { kind: 'list', level: 0, indent: '', marker: '-', task: false };
    }
    const unit = Math.max(indentUnit(lines, bodyStart(lines)), first.prefix.length - first.indent.length);
    const bullet = /^[-*+]$/.test(first.marker) ? first.marker : '-';
    return { kind: 'list', level: 0, indent: first.indent + ' '.repeat(unit), marker: bullet, task: false };
}

const formatShape = (shape: LineShape, text: string): string =>
    shape.kind === 'heading' ? `${'#'.repeat(shape.level)} ${shape.task ? '[ ] ' : ''}${text}` : `${shape.indent}${shape.marker} ${shape.task ? '[ ] ' : ''}${text}`;

// 子を差し込む行。見出しは配下の段落のあとまで、リストは配下の最後の項目のあと
function childInsertAt(nodes: OutlineNode[], parent: OutlineNode, lines: string[]): number {
    if (isVirtualRoot(nodes, parent, lines)) return trimBlankTail(lines, bodyStart(lines), lines.length);
    return blockOf(nodes, parent, lines).end;
}

const isBlockStart = (line: string): boolean => {
    const plain = line.replace(/\r$/, '');
    return plain.trim() === '' || HEADING.test(plain) || LIST.test(plain);
};

// 行を差し込む。リスト項目の直後に段落が続くと、その段落が項目に吸い込まれる (遅延継続行) ので、間に空行を入れる。
// 見出しをリスト項目や段落のすぐ後ろに差し込むときは、読みやすさのため間に空行を入れる (見出しの直後なら詰めたまま)
function insertLines(lines: string[], at: number, inserted: string[]): number {
    const next = lines[at];
    const previous = at > 0 ? (lines[at - 1] ?? '') : '';
    const head = HEADING.test(inserted[0] ?? '') && previous.trim() !== '' && !HEADING.test(previous) ? [''] : [];
    const tail = next !== undefined && !isBlockStart(next) ? [''] : [];
    lines.splice(at, 0, ...head, ...inserted, ...tail);
    return at + head.length;
}

function nodeById(ctx: EditContext, id: number): OutlineNode | null {
    return ctx.parsed.nodes[id - 1] ?? null;
}

const splitLines = (source: string): string[] => source.split('\n');

// ---- ノードの追加 --------------------------------------------------------------------------------------------------

export function addChild(ctx: EditContext, parentId: number, label = NEW_LABEL): EditResult {
    const lines = splitLines(ctx.source);
    const parent = nodeById(ctx, parentId);
    if (!parent) return { ok: false, message: 'ノードが見つかりません' };
    const shape = childShape(ctx.parsed.nodes, parent, lines);
    const at = childInsertAt(ctx.parsed.nodes, parent, lines);
    const line = insertLines(lines, at, [formatShape(shape, label)]);
    return { ok: true, source: lines.join('\n'), focusLine: line };
}

export function addSibling(ctx: EditContext, id: number, label = NEW_LABEL): EditResult {
    const lines = splitLines(ctx.source);
    const node = nodeById(ctx, id);
    if (!node) return { ok: false, message: 'ノードが見つかりません' };
    const parent = node.parent === null ? null : nodeById(ctx, node.parent);
    if (!parent) return addChild(ctx, id, label);
    const first = node.lines ? parseFirstLine(lines[node.lines.start] ?? '') : null;
    if (!first) return addChild(ctx, parent.id, label);
    const shape = { ...shapeOf(first), marker: nextMarker(first.marker) };
    const at = blockOf(ctx.parsed.nodes, node, lines).end;
    const line = insertLines(lines, at, [formatShape(shape, label)]);
    return { ok: true, source: lines.join('\n'), focusLine: line };
}

// ---- 名前の変更 ----------------------------------------------------------------------------------------------------

// 名前の変更で書き換える、1 行目の本文 (印とタスクの記号を除いた部分)
export function labelOf(source: string, node: OutlineNode): string | null {
    if (!node.lines) return null;
    const first = parseFirstLine(splitLines(source)[node.lines.start] ?? '');
    return first ? first.text : null;
}

// 1 行目の本文を差し替える。refText が変わると relations の参照が外れるので、reparse で新しい refText を得て、参照も書き換える
export function renameNode(ctx: EditContext, id: number, text: string, reparse: (source: string) => ParsedDocument): EditResult {
    const lines = splitLines(ctx.source);
    const node = nodeById(ctx, id);
    if (!node?.lines) return { ok: false, message: 'このノードは名前を変えられません' };
    const first = parseFirstLine(lines[node.lines.start] ?? '');
    if (!first) return { ok: false, message: 'このノードは名前を変えられません (1 行目が見出しでもリストでもない)' };
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    if (clean === first.text) return { ok: false, message: '' };
    lines[node.lines.start] = joinFirstLine({ ...first, text: clean });
    let source = lines.join('\n');
    const before = node.refText;
    const after = reparse(source).nodes[id - 1]?.refText;
    const unique = ctx.parsed.nodes.filter((other) => other.refText === before).length === 1;
    if (before && after && before !== after && unique) {
        source = rewriteRefs(source, (segment) => (segment === before ? after : segment));
    }
    return { ok: true, source, focusId: id };
}

// ---- 削除 ----------------------------------------------------------------------------------------------------------

export function deleteNode(ctx: EditContext, id: number): EditResult {
    const lines = splitLines(ctx.source);
    const node = nodeById(ctx, id);
    if (!node) return { ok: false, message: 'ノードが見つかりません' };
    if (isVirtualRoot(ctx.parsed.nodes, node, lines) || node.parent === null) return { ok: false, message: 'ルートは消せません' };
    if (!node.lines) return { ok: false, message: 'このノードは原文の行を持ちません' };
    const block = blockOf(ctx.parsed.nodes, node, lines);
    // 消す範囲のあとの空行が 2 つ重なるなら 1 つ詰める
    let end = block.end;
    if ((lines[block.start - 1] ?? 'x').trim() === '' && (lines[end] ?? 'x').trim() === '') end++;
    lines.splice(block.start, end - block.start);
    let source = lines.join('\n');

    // 消したノードを指す relations の項目を外す
    const gone = [node, ...descendantsOf(ctx.parsed.nodes, node)];
    const refs = new Set<string>();
    for (const item of gone) {
        if (item.refId) refs.add(`$${item.refId}`);
        const unique = item.refText !== '' && ctx.parsed.nodes.filter((other) => other.refText === item.refText).length === 1;
        if (unique) refs.add(item.refText);
    }
    const { source: cleaned, removed } = removeRelationsReferring(source, refs);
    source = cleaned;
    const parentLine = node.parent !== null ? nodeById(ctx, node.parent)?.lines?.start : undefined;
    const message = removed > 0 ? `このノードを指していた関係を ${removed} 件外しました` : undefined;
    return { ok: true, source, focusLine: parentLine !== undefined && parentLine < block.start ? parentLine : undefined, message };
}

// ---- 付け替え (ドラッグでほかのノードの下へ移す) ------------------------------------------------------------------

export function moveNode(ctx: EditContext, id: number, newParentId: number): EditResult {
    const lines = splitLines(ctx.source);
    const nodes = ctx.parsed.nodes;
    const node = nodeById(ctx, id);
    const target = nodeById(ctx, newParentId);
    if (!node?.lines || !target) return { ok: false, message: 'ノードが見つかりません' };
    if (node.parent === null) return { ok: false, message: 'ルートは動かせません' };
    if (node.parent === target.id) return { ok: false, message: '' };
    if (target.id === node.id || descendantsOf(nodes, node).some((item) => item.id === target.id)) return { ok: false, message: '自分の配下には移せません' };

    const block = blockOf(nodes, node, lines);
    const shape = childShape(nodes, target, lines);
    const emitted = emitSubtree(nodes, node, lines, block, shape, indentUnit(lines, bodyStart(lines)));
    let at = childInsertAt(nodes, target, lines);
    if (at > block.start && at < block.end) return { ok: false, message: '移す先を決められません' };
    // 先に移す先へ差し込み、あとから元の範囲を消す (差し込む位置が前なら、元の範囲はその分うしろへずれる)
    let removeStart = block.start;
    let removeEnd = block.end;
    if ((lines[removeStart - 1] ?? 'x').trim() === '' && (lines[removeEnd] ?? 'x').trim() === '') removeEnd++;
    const inserted = insertLinesCounted(lines, at, emitted);
    if (at <= block.start) {
        removeStart += inserted;
        removeEnd += inserted;
    }
    lines.splice(removeStart, removeEnd - removeStart);
    if (at > block.start) at -= removeEnd - removeStart;
    return { ok: true, source: lines.join('\n'), focusLine: at };
}

function insertLinesCounted(lines: string[], at: number, inserted: string[]): number {
    const before = lines.length;
    insertLines(lines, at, inserted);
    return lines.length - before;
}

// 移すノードとその配下を、新しい位置の形で書き直す。見出しで書くなら配下の見出しは 1 段ずつ下げ、6 段を超えたらリストにする。
// リストで書くなら配下もすべてリストの入れ子にする。項目の 2 行目以降 (詳細の引用など) は、新しい本文の桁に字下げし直す
function emitSubtree(nodes: OutlineNode[], root: OutlineNode, lines: string[], block: { start: number; end: number }, shape: LineShape, unit: number): string[] {
    const inBlock = new Set([root, ...descendantsOf(nodes, root)].map((item) => item.id));
    const out: string[] = [];
    const emit = (node: OutlineNode, as: LineShape): void => {
        if (!node.lines) return;
        const first = parseFirstLine(lines[node.lines.start] ?? '');
        if (!first) return;
        const prefix = as.kind === 'heading' ? `${'#'.repeat(as.level)} ` : `${as.indent}${as.marker} `;
        out.push(prefix + first.task + first.text + first.marks + first.eol);
        // 自分の行の 2 行目以降と、見出しなら次の子までの段落
        const children = childrenOf(nodes, node).filter((child) => inBlock.has(child.id));
        const ownEnd = first.kind === 'heading' ? (children[0]?.lines?.start ?? (node === root ? block.end : followingStart(nodes, node, lines.length))) : node.lines.end;
        const rest = lines.slice(node.lines.start + 1, Math.min(ownEnd, block.end));
        const trimmed = rest.slice(0, trimBlankTail(rest, 0, rest.length));
        if (trimmed.length > 0) {
            if (as.kind === 'list' && first.kind === 'list') {
                // リストからリストへは、字下げの差だけずらす (本文の桁からの相対の字下げを保つ)
                const delta = as.indent.length - first.indent.length;
                for (const line of trimmed) out.push(line.trim() === '' ? line : delta >= 0 ? ' '.repeat(delta) + line : line.slice(Math.min(-delta, indentOf(line))));
            } else {
                const oldIndent = Math.min(...trimmed.filter((line) => line.trim() !== '').map(indentOf));
                const newIndent = as.kind === 'list' ? ' '.repeat(prefix.length) : '';
                if (as.kind === 'list' && first.kind === 'heading') out.push('');
                for (const line of trimmed) out.push(line.trim() === '' ? line : newIndent + line.slice(Math.min(oldIndent, indentOf(line))));
            }
        }
        for (const child of children) {
            const childFirst = child.lines ? parseFirstLine(lines[child.lines.start] ?? '') : null;
            let next: LineShape;
            if (as.kind === 'heading' && childFirst?.kind === 'heading' && as.level < 6) {
                next = { kind: 'heading', level: as.level + 1, indent: '', marker: '#'.repeat(as.level + 1), task: false };
            } else if (as.kind === 'heading') {
                next = { kind: 'list', level: 0, indent: '', marker: childFirst?.kind === 'list' && /^[-*+]$/.test(childFirst.marker) ? childFirst.marker : '-', task: false };
            } else {
                const width = Math.max(unit, prefix.length - as.indent.length);
                const marker = childFirst?.kind === 'list' ? childFirst.marker : '-';
                next = { kind: 'list', level: 0, indent: as.indent + ' '.repeat(width), marker, task: false };
            }
            emit(child, next);
        }
    };
    emit(root, shape);
    return out;
}

// ---- frontmatter ---------------------------------------------------------------------------------------------------

function frontmatterRange(lines: string[]): { open: number; close: number } | null {
    if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return null;
    for (let index = 1; index < lines.length; index++) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        if (line === '---' || line === '...') return { open: 0, close: index };
    }
    return null;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isNeutral = (line: string): boolean => line.trim() === '' || line.trimStart().startsWith('#');

// YAML のブロック形式のキー。line はキーの行、indent はキーの字下げ、end は値のブロックの終わり (次の同じか浅い字下げの行)、
// inline はキーと同じ行に書いた値 (コメントを除く)
interface YamlBlock {
    line: number;
    indent: number;
    end: number;
    inline: string;
}

function findKey(lines: string[], from: number, to: number, indent: number | null, key: string): YamlBlock | null {
    let childIndent = indent;
    for (let index = from; index < to; index++) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        if (isNeutral(line)) continue;
        const current = indentOf(line);
        if (childIndent === null) childIndent = current;
        if (current !== childIndent) continue;
        const match = /^\s*(["']?)([^"':#]+?)\1\s*:(?:\s+(.*))?$/.exec(line);
        if (!match || match[2] !== key) continue;
        const inline = (match[3] ?? '').replace(/(^|\s+)#.*$/, '').trim();
        // 値のブロックは、キーより深い行と、キーと同じ字下げのシーケンスの項目 (key:\n- a の形) が続くところまで
        let last = index + 1;
        for (let end = index + 1; end < to; end++) {
            const next = (lines[end] ?? '').replace(/\r$/, '');
            if (isNeutral(next)) continue;
            const depth = indentOf(next);
            if (depth < current || (depth === current && !next.trimStart().startsWith('- '))) break;
            last = end + 1;
        }
        return { line: index, indent: current, end: last, inline };
    }
    return null;
}

// ブロックの子の字下げ (最初の子の行の字下げ)。子がなければ null
function childIndentOf(lines: string[], block: YamlBlock): number | null {
    for (let index = block.line + 1; index < block.end; index++) {
        const line = (lines[index] ?? '').replace(/\r$/, '');
        if (!isNeutral(line)) return indentOf(line);
    }
    return null;
}

// markdag の下の、指定の道筋のブロックを探す
function findPath(lines: string[], path: string[]): YamlBlock | null {
    const range = frontmatterRange(lines);
    if (!range) return null;
    let block: YamlBlock | null = null;
    let from = range.open + 1;
    let to = range.close;
    let indent: number | null = 0;
    for (const key of path) {
        block = findKey(lines, from, to, indent, key);
        if (!block) return null;
        from = block.line + 1;
        to = block.end;
        indent = null;
    }
    return block;
}

// YAML の平の文字列として書けなければ、二重引用符で囲む
function yamlScalar(value: string): string {
    return /^[\s\[\]{}&*!|>'"%@`#,?:-]|: | #|\s$|^$/.test(value) ? JSON.stringify(value) : value;
}

function unquote(value: string): string {
    const trimmed = value.replace(/\s+#.*$/, '').trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            return JSON.parse(trimmed) as string;
        } catch {
            return trimmed.slice(1, -1);
        }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
    return trimmed;
}

// relations の 1 つの記述を、段 (--> で区切った部分) と項 (& で区切った部分) に分ける
function termsOf(expression: string): string[][] {
    return expression.split(/\s+-->\s+/).map((segment) => segment.split(/\s+&\s+/).map((term) => term.trim()));
}

const formatTerms = (segments: string[][]): string => segments.map((segment) => segment.join(' & ')).join(' --> ');

// markdag.relations の下の項目の行 (kind ごと)
interface RelationItem {
    kind: string;
    line: number;
    indent: string;
    value: string;
}

function relationItems(lines: string[]): RelationItem[] {
    const relations = findPath(lines, ['markdag', 'relations']);
    if (!relations) return [];
    const items: RelationItem[] = [];
    for (const kind of ['fork', 'join', 'chain', 'depends']) {
        const block = findKey(lines, relations.line + 1, relations.end, childIndentOf(lines, relations), kind);
        if (!block) continue;
        for (let index = block.line + 1; index < block.end; index++) {
            const match = /^(\s*)- (.*)$/.exec((lines[index] ?? '').replace(/\r$/, ''));
            if (match) items.push({ kind, line: index, indent: match[1] ?? '', value: unquote(match[2] ?? '') });
        }
    }
    return items;
}

// branches と groups.*.members の項目の行
function referenceListItems(lines: string[]): Array<{ line: number; indent: string; value: string }> {
    const items: Array<{ line: number; indent: string; value: string }> = [];
    const collect = (block: YamlBlock | null): void => {
        if (!block) return;
        for (let index = block.line + 1; index < block.end; index++) {
            const match = /^(\s*)- (.*)$/.exec((lines[index] ?? '').replace(/\r$/, ''));
            if (match) items.push({ line: index, indent: match[1] ?? '', value: unquote(match[2] ?? '') });
        }
    };
    collect(findPath(lines, ['markdag', 'branches']));
    const groups = findPath(lines, ['markdag', 'groups']);
    if (groups) {
        for (let index = groups.line + 1; index < groups.end; index++) {
            if (/^\s*members:\s*$/.test((lines[index] ?? '').replace(/\r$/, ''))) {
                collect(findKey(lines, index, groups.end, indentOf(lines[index] ?? ''), 'members'));
            }
        }
    }
    return items;
}

// 参照の道筋 (A/B/*) の各部分を書き換える
function rewriteRefs(source: string, rename: (segment: string) => string): string {
    const lines = splitLines(source);
    const mapTerm = (term: string): string =>
        term
            .split('/')
            .map((segment) => rename(segment))
            .join('/');
    for (const item of relationItems(lines)) {
        const next = formatTerms(termsOf(item.value).map((segment) => segment.map(mapTerm)));
        if (next !== item.value) lines[item.line] = `${item.indent}- ${yamlScalar(next)}`;
    }
    for (const item of referenceListItems(lines)) {
        const next = mapTerm(item.value);
        if (next !== item.value) lines[item.line] = `${item.indent}- ${yamlScalar(next)}`;
    }
    return lines.join('\n');
}

function removeRelationsReferring(source: string, refs: Set<string>): { source: string; removed: number } {
    const lines = splitLines(source);
    const doomed = relationItems(lines)
        .filter((item) => termsOf(item.value).some((segment) => segment.some((term) => term.split('/').some((part) => refs.has(part)))))
        .map((item) => item.line);
    for (const line of doomed.reverse()) lines.splice(line, 1);
    if (doomed.length > 0) pruneEmptyRelations(lines);
    return { source: lines.join('\n'), removed: doomed.length };
}

// 項目がなくなった relations の kind のキーを外す (値が null のキーは relation-not-string になるため)。kind が 1 つもなくなれば relations も外す
function pruneEmptyRelations(lines: string[]): void {
    const relations = findPath(lines, ['markdag', 'relations']);
    if (!relations || relations.inline !== '') return;
    const kindIndent = childIndentOf(lines, relations);
    for (const kind of ['depends', 'chain', 'join', 'fork']) {
        const block = kindIndent === null ? null : findKey(lines, relations.line + 1, relations.end, kindIndent, kind);
        if (!block || block.inline !== '') continue;
        const hasItem = lines.slice(block.line + 1, block.end).some((line) => /^\s*- /.test(line));
        if (!hasItem) lines.splice(block.line, block.end - block.line);
    }
    const after = findPath(lines, ['markdag', 'relations']);
    if (after && childIndentOf(lines, after) === null) lines.splice(after.line, after.end - after.line);
}

// ---- 線の追加 ------------------------------------------------------------------------------------------------------

// ノードを relations から指す書き方。$id があればそれ、名前が一意ならその名前、親/名前 で一意ならそれ。
// どれもだめなら 1 行目の末尾に $id を足して、それで指す (lines を書き換える)
function referenceFor(ctx: EditContext, lines: string[], node: OutlineNode): string | null {
    if (node.refId) return `$${node.refId}`;
    const nodes = ctx.parsed.nodes;
    if (node.refText && !node.refText.includes('/') && nodes.filter((other) => other.refText === node.refText).length === 1) return node.refText;
    const parent = node.parent === null ? null : nodes[node.parent - 1];
    if (parent?.refText && node.refText && !node.refText.includes('/')) {
        const same = nodes.filter((other) => other.refText === node.refText && other.parent !== null && nodes[other.parent - 1]?.refText === parent.refText);
        if (same.length === 1) return `${parent.refText}/${node.refText}`;
    }
    if (!node.lines) return null;
    const first = parseFirstLine(lines[node.lines.start] ?? '');
    if (!first) return null;
    const taken = new Set(nodes.map((other) => other.refId));
    let id = node.id;
    while (taken.has(`n${id}`)) id++;
    lines[node.lines.start] = joinFirstLine({ ...first, marks: `${first.marks} $n${id}` });
    return `$n${id}`;
}

// markdag.relations.<kind> の末尾に項目を足す。道筋のキーがなければ作る
function appendRelation(lines: string[], kind: string, expression: string): boolean {
    const item = yamlScalar(expression);
    let range = frontmatterRange(lines);
    if (!range) {
        lines.splice(0, 0, '---', 'markdag:', '    relations:', `        ${kind}:`, `            - ${item}`, '---', '');
        return true;
    }
    const markdag = findPath(lines, ['markdag']);
    if (!markdag) {
        lines.splice(range.close, 0, 'markdag:', '    relations:', `        ${kind}:`, `            - ${item}`);
        return true;
    }
    if (markdag.inline !== '' && markdag.inline !== '~' && markdag.inline !== 'null') return false;
    const unit = childIndentOf(lines, markdag) ?? 4;
    const pad = (depth: number): string => ' '.repeat(unit * depth);
    const relations = findPath(lines, ['markdag', 'relations']);
    if (!relations) {
        lines.splice(markdag.end, 0, `${pad(1)}relations:`, `${pad(2)}${kind}:`, `${pad(3)}- ${item}`);
        return true;
    }
    if (relations.inline !== '') return false;
    const kindIndent = childIndentOf(lines, relations) ?? relations.indent + unit;
    const block = findKey(lines, relations.line + 1, relations.end, kindIndent, kind);
    if (!block) {
        lines.splice(relations.end, 0, `${' '.repeat(kindIndent)}${kind}:`, `${' '.repeat(kindIndent + unit)}- ${item}`);
        return true;
    }
    if (block.inline !== '') return false;
    const itemIndent = childIndentOf(lines, block) ?? block.indent + unit;
    lines.splice(block.end, 0, `${' '.repeat(itemIndent)}- ${item}`);
    range = frontmatterRange(lines);
    return range !== null;
}

export function addRelation(ctx: EditContext, sourceId: number, targetId: number, kind = 'depends'): EditResult {
    if (sourceId === targetId) return { ok: false, message: '同じノードには線を引けません' };
    const exists = ctx.model.relations.some((relation) => relation.source === sourceId && relation.target === targetId);
    if (exists) return { ok: false, message: 'その線はもうあります' };
    const lines = splitLines(ctx.source);
    const from = nodeById(ctx, sourceId);
    const to = nodeById(ctx, targetId);
    if (!from || !to) return { ok: false, message: 'ノードが見つかりません' };
    // 本文の行 ($id を足す) を先に書き換え、そのあとで frontmatter に足す (frontmatter を足すと本文の行がずれるため)
    const a = referenceFor(ctx, lines, from);
    const b = referenceFor(ctx, lines, to);
    if (!a || !b) return { ok: false, message: 'このノードは relations から指せません' };
    if (!appendRelation(lines, kind, `${a} --> ${b}`)) return { ok: false, message: 'frontmatter の markdag.relations が flow 形式などで、書き足せません' };
    return { ok: true, source: lines.join('\n') };
}

// ---- 合流 (複数のノードから 1 つへ) -----------------------------------------------------------------------------

// target から (木の親子と relations をたどって) 届くノード。ここにある始点から target へ線を引くと閉路になる
function reachableFrom(ctx: EditContext, target: number): Set<number> {
    const next = new Map<number, number[]>();
    const push = (from: number, to: number): void => {
        const list = next.get(from);
        if (list) list.push(to);
        else next.set(from, [to]);
    };
    for (const node of ctx.parsed.nodes) if (node.parent !== null) push(node.parent, node.id);
    for (const relation of ctx.model.relations) push(relation.source, relation.target);
    const seen = new Set<number>([target]);
    const stack = [target];
    while (stack.length > 0) {
        for (const id of next.get(stack.pop() ?? 0) ?? []) {
            if (!seen.has(id)) {
                seen.add(id);
                stack.push(id);
            }
        }
    }
    return seen;
}

// sources のそれぞれから target へ合流する線を足す。始点が 2 つ以上なら join (`a & b --> t`)、1 つなら depends。
// target から届く始点 (線を引くと閉路になる) と、もう線のある始点は外し、外した数を知らせる
export function addJoin(ctx: EditContext, sources: number[], target: number): EditResult {
    const to = nodeById(ctx, target);
    if (!to) return { ok: false, message: 'ノードが見つかりません' };
    const reachable = reachableFrom(ctx, target);
    const unique = [...new Set(sources)];
    const cyclic = unique.filter((id) => reachable.has(id));
    const existing = unique.filter((id) => !reachable.has(id) && ctx.model.relations.some((relation) => relation.source === id && relation.target === target));
    const kept = unique.filter((id) => !cyclic.includes(id) && !existing.includes(id));
    if (kept.length === 0) {
        return { ok: false, message: cyclic.length > 0 ? '合流先の後ろにあるノードからは、線を引けません (循環になる)' : 'その線はもうあります' };
    }
    const lines = splitLines(ctx.source);
    const refs: string[] = [];
    for (const id of kept) {
        const node = nodeById(ctx, id);
        const ref = node ? referenceFor(ctx, lines, node) : null;
        if (!ref) return { ok: false, message: `「${node?.refText ?? id}」は relations から指せません` };
        refs.push(ref);
    }
    const b = referenceFor(ctx, lines, to);
    if (!b) return { ok: false, message: '合流先は relations から指せません' };
    const kind = refs.length >= 2 ? 'join' : 'depends';
    if (!appendRelation(lines, kind, `${refs.join(' & ')} --> ${b}`)) return { ok: false, message: 'frontmatter の markdag.relations が flow 形式などで、書き足せません' };
    const skipped = [
        cyclic.length > 0 ? `循環になる ${cyclic.length} 個` : '',
        existing.length > 0 ? `線のある ${existing.length} 個` : '',
    ].filter(Boolean);
    const message = `${refs.length} 個から「${to.refText}」へ合流する線を足しました${skipped.length > 0 ? ` (${skipped.join('、')}は外しました)` : ''}`;
    return { ok: true, source: lines.join('\n'), focusId: target, message };
}

// 新しい合流先のノードを作り、sources から合流させる。合流先は、始点のうち文書でいちばん後ろのものが入っている
// 最上位の枝のすぐ後ろに、最上位の兄弟として置く (最上位のノードへの relations の線は、始点の後ろに並べて描かれる)
export function addJoinNode(ctx: EditContext, sources: number[], label: string, contextOf: (source: string) => EditContext): EditResult {
    const nodes = ctx.parsed.nodes;
    if (sources.length === 0) return { ok: false, message: '合流させるノードを選んでください' };
    let top = nodeById(ctx, Math.max(...sources));
    if (!top || top.parent === null) return { ok: false, message: 'ルートからは合流できません' };
    while (top.parent !== null && nodes[top.parent - 1]?.parent !== null) top = nodes[top.parent - 1] ?? top;
    const inserted = addSibling(ctx, top.id, label);
    if (!inserted.ok) return inserted;
    // 足したノードより後ろのノードは id が 1 つずれるので、relations ごと読み直してから線を足す。
    // 合流先は始点より後ろに足すので、始点の id は変わらない
    const next = contextOf(inserted.source);
    const created = next.parsed.nodes.find((node) => node.lines?.start === inserted.focusLine);
    if (!created) return { ok: false, message: '合流先のノードを作れませんでした' };
    const joined = addJoin(next, sources, created.id);
    if (!joined.ok) return joined;
    // frontmatter に行が増えると本文の行がずれるので、選び直しは id で行う (frontmatter の変更では id は変わらない)
    return { ok: true, source: joined.source, focusId: created.id, message: joined.message };
}

// ---- 線の削除と向きの反転 ------------------------------------------------------------------------------------------

export interface EdgeRef {
    kind: string;
    source: number;
    target: number;
}

export function parseEdgeKey(key: string): EdgeRef | null {
    const match = /^([a-z]+):(\d+)>(\d+)$/.exec(key);
    return match ? { kind: match[1] ?? '', source: Number(match[2]), target: Number(match[3]) } : null;
}

// 線のもとになった relations の記述と、同じ記述から生まれたほかの線
function originOf(ctx: EditContext, edge: EdgeRef): { origin: string; group: Array<{ source: number; target: number }>; index: number; item: RelationItem } | null {
    const relation = ctx.model.relations.find((item) => item.kind === edge.kind && item.source === edge.source && item.target === edge.target);
    if (!relation) return null;
    const group = ctx.model.relations.filter((item) => item.kind === relation.kind && item.origin === relation.origin);
    const item = relationItems(splitLines(ctx.source)).find((candidate) => candidate.kind === relation.kind && candidate.value === relation.origin);
    if (!item) return null;
    return { origin: relation.origin, group, index: group.indexOf(relation), item };
}

export function deleteEdge(ctx: EditContext, edge: EdgeRef): EditResult {
    if (edge.kind === 'tree') return { ok: false, message: '木の線は親子の関係です。ノードをほかのノードへドラッグして付け替えてください' };
    const found = originOf(ctx, edge);
    if (!found) return { ok: false, message: 'この線のもとになった記述が見つかりません' };
    const lines = splitLines(ctx.source);
    const { group, index, item } = found;
    const segments = termsOf(item.value);
    const hasGlob = segments.some((segment) => segment.some((term) => term.includes('*')));
    let replacement: string[] | null = null;
    let message: string | undefined;

    if (group.length === 1) {
        replacement = [];
    } else if (!hasGlob && segments.every((segment) => segment.length === 1) && group.length === segments.length - 1) {
        // A --> B --> C の途中の線を消すと、前後の 2 つの chain に分かれる
        const left = segments.slice(0, index + 1);
        const right = segments.slice(index + 1);
        replacement = [left, right].filter((part) => part.length >= 2).map((part) => formatTerms(part));
        message = 'chain を線の前後で分けました';
    } else if (!hasGlob && segments.length === 2) {
        // A --> x & y (fork) や a & b --> C (join) は、多いほうの側から項を 1 つ外す
        const [head = [], tail = []] = segments;
        if (head.length === 1 && tail.length === group.length) {
            replacement = [formatTerms([head, tail.filter((_, position) => position !== index)])];
        } else if (tail.length === 1 && head.length === group.length) {
            replacement = [formatTerms([head.filter((_, position) => position !== index), tail])];
        }
    }
    if (replacement === null) {
        // X/* などの展開から生まれた線は、記述を外して、残りの線を 1 本ずつの depends に書き直す
        const rest = group.filter((_, position) => position !== index);
        const refs = rest.map((pair) => {
            const a = nodeById(ctx, pair.source);
            const b = nodeById(ctx, pair.target);
            return a && b ? [referenceFor(ctx, lines, a), referenceFor(ctx, lines, b)] : [null, null];
        });
        if (refs.some(([a, b]) => !a || !b)) return { ok: false, message: 'この線だけを外す書き方にできません' };
        lines.splice(item.line, 1);
        for (const [a, b] of refs) appendRelation(lines, 'depends', `${a} --> ${b}`);
        pruneEmptyRelations(lines);
        return { ok: true, source: lines.join('\n'), message: `「${item.value}」を外し、残りの ${rest.length} 本を depends に書き直しました` };
    }
    lines.splice(item.line, 1, ...replacement.map((expression) => `${item.indent}- ${yamlScalar(expression)}`));
    pruneEmptyRelations(lines);
    return { ok: true, source: lines.join('\n'), message };
}

export function reverseEdge(ctx: EditContext, edge: EdgeRef): EditResult {
    if (edge.kind === 'tree') return { ok: false, message: '木の線は向きを変えられません' };
    const found = originOf(ctx, edge);
    if (!found) return { ok: false, message: 'この線のもとになった記述が見つかりません' };
    if (found.group.length !== 1) return { ok: false, message: '1 つの記述から何本も生まれた線は、向きを変えられません' };
    const lines = splitLines(ctx.source);
    const reversed = formatTerms(termsOf(found.item.value).reverse());
    lines[found.item.line] = `${found.item.indent}- ${yamlScalar(reversed)}`;
    return { ok: true, source: lines.join('\n') };
}

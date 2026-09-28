// Markdown の書き換え。どれも (元の文字列, ...) => 新しい文字列 の純粋な関数で、DOM も markdag の状態も持たない。
// 行番号は markdag の OutlineNode と同じ 0 始まり。書き換えたあとは必ず parseDocument し直す前提なので、
// 1 回の呼び出しでは 1 か所だけを変える。
import { formatTag, type TaskMark } from 'markdag';
import { isMap, isScalar, isSeq, parseDocument as parseYaml, type Document, YAMLMap, YAMLSeq } from 'yaml';

export interface TagInput {
    key: string;
    values: string[];
}

interface Lines {
    lines: string[];
    eol: string;
}

function split(source: string): Lines {
    return { lines: source.split(/\r?\n/), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

function join({ lines, eol }: Lines): string {
    return lines.join(eol);
}

// リスト項目か見出しの先頭と、タスクの印。`- [ ] `、`1. [x] `、`## [/] `
const TASK_HEAD = /^(\s*(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)\[([ xX/-])\]\s?/;
const ITEM_HEAD = /^(\s*(?:[-*+]|\d+[.)])\s+|#{1,6}\s+)/;
// 行末の印。%group、$id、#key、#key:value、#key:"a b"
const TRAILING_MARK = /\s+(%[\p{L}\p{N}_-]+|\$[A-Za-z][A-Za-z0-9_-]*|#[\p{L}\p{N}_-]+(?::(?:"(?:[^"\\]|\\.)*"|[^\s"]\S*))?)$/u;

export interface FirstLine {
    head: string;
    mark: TaskMark | null;
    title: string;
    groups: string[];
    id: string | null;
}

// ノードの 1 行目を、先頭 (インデントと記号)、タスクの印、題名、行末の印に分ける。
// タグは markdag が読んだもの (OutlineNode.tags) を使うので、ここでは読み捨てる
export function readFirstLine(line: string): FirstLine {
    const task = TASK_HEAD.exec(line);
    const plain = task ? null : ITEM_HEAD.exec(line);
    const head = task ? task[1]! : (plain?.[1] ?? '');
    const mark = task ? (task[2]!.toLowerCase() as TaskMark) : null;
    let rest = line.slice(task ? task[0].length : head.length);
    const groups: string[] = [];
    let id: string | null = null;
    for (let found = TRAILING_MARK.exec(rest); found; found = TRAILING_MARK.exec(rest)) {
        const token = found[1]!;
        if (token.startsWith('%')) groups.unshift(token.slice(1));
        else if (token.startsWith('$')) id = token.slice(1);
        rest = rest.slice(0, found.index);
    }
    return { head, mark, title: rest.trim(), groups, id };
}

function writeFirstLine(first: FirstLine, tags: TagInput[]): string {
    const parts = [first.title];
    for (const group of first.groups) parts.push(`%${group}`);
    for (const tag of tags) parts.push(formatTag(tag));
    if (first.id) parts.push(`$${first.id}`);
    const mark = first.mark === null ? '' : `[${first.mark}] `;
    return `${first.head}${mark}${parts.join(' ')}`;
}

// タスクの印だけを差し替える。markdag の toggleTask は cycle の次へ進めるだけなので、任意の状態へ飛ぶときはこちら
export function setTaskMark(source: string, line: number, mark: TaskMark): string {
    const doc = split(source);
    const text = doc.lines[line];
    if (text === undefined) return source;
    const found = TASK_HEAD.exec(text);
    if (!found) return source;
    doc.lines[line] = `${found[1]}[${mark}] ${text.slice(found[0].length)}`;
    return join(doc);
}

// 題名とタグを書き直す。グループの印と $id はそのまま残す
export function setFirstLine(source: string, line: number, change: { title?: string; tags: TagInput[] }): string {
    const doc = split(source);
    const text = doc.lines[line];
    if (text === undefined) return source;
    const first = readFirstLine(text);
    if (change.title !== undefined) first.title = change.title.replace(/\s+/g, ' ').trim() || first.title;
    doc.lines[line] = writeFirstLine(first, change.tags.filter((tag) => tag.key !== ''));
    return join(doc);
}

function indentOf(line: string): string {
    return /^\s*/.exec(line)?.[0] ?? '';
}

// 説明 (項目の 2 行目以降の引用) を書き直す。ownEnd は子の項目が始まる行 (子がなければノードの終わり)
export function setDescription(source: string, line: number, ownEnd: number, text: string): string {
    const doc = split(source);
    const first = doc.lines[line];
    if (first === undefined) return source;
    const indent = `${indentOf(first)}    `;
    const kept: string[] = [];
    for (let at = line + 1; at < ownEnd; at += 1) {
        const current = doc.lines[at] ?? '';
        if (!/^\s*>/.test(current)) kept.push(current);
    }
    // 末尾の空行は子の項目や次の見出しとの区切りなので、引用の後ろに残す
    const body = text
        .replace(/\r\n/g, '\n')
        .trim()
        .split('\n')
        .filter((_, index, all) => all.length > 1 || all[0] !== '');
    const quote = body.map((row) => (row.trim() === '' ? `${indent}>` : `${indent}> ${row}`));
    doc.lines.splice(line + 1, ownEnd - line - 1, ...quote, ...kept);
    return join(doc);
}

// 範囲の末尾にある空行を除いた位置。項目を足すとき、見出しとの間の空行の手前に入れるために使う
function trimBlankEnd(lines: string[], start: number, end: number): number {
    let at = end;
    while (at > start && (lines[at - 1] ?? '').trim() === '') at -= 1;
    return at;
}

export interface NewItem {
    mark: TaskMark;
    title: string;
    tags: TagInput[];
    id: string | null;
    description: string;
}

function itemLines(item: NewItem, indent: string): string[] {
    const first = writeFirstLine({ head: `${indent}- `, mark: item.mark, title: item.title.trim(), groups: [], id: item.id }, item.tags);
    const quote = item.description
        .trim()
        .split(/\r?\n/)
        .filter((row) => row.trim() !== '')
        .map((row) => `${indent}    > ${row}`);
    return [first, ...quote];
}

// start 以降 end までの範囲の最後 (末尾の空行の手前) に項目を足す
export function insertItem(source: string, start: number, end: number, indent: string, item: NewItem): string {
    const doc = split(source);
    const at = trimBlankEnd(doc.lines, start, Math.min(end, doc.lines.length));
    doc.lines.splice(at, 0, ...itemLines(item, indent));
    return join(doc);
}

// ノードの範囲を消す。後ろの空行は残す (見出しとの区切りだったかもしれないので)
export function removeRange(source: string, start: number, end: number): string {
    const doc = split(source);
    const stop = trimBlankEnd(doc.lines, start, end);
    doc.lines.splice(start, Math.max(stop - start, 1));
    return join(doc);
}

// 項目 (と配下) を別の見出しの下へ動かす。インデントは移動先の最上位に合わせる
export function moveRange(source: string, start: number, end: number, target: { start: number; end: number }): string {
    const doc = split(source);
    const stop = trimBlankEnd(doc.lines, start, end);
    const block = doc.lines.slice(start, stop);
    const base = indentOf(block[0] ?? '').length;
    const moved = block.map((row) => (row.trim() === '' ? row : row.slice(Math.min(base, indentOf(row).length))));
    // 先に消すと移動先の行番号がずれるので、移動先が後ろなら差し引く
    let at = trimBlankEnd(doc.lines, target.start, Math.min(target.end, doc.lines.length));
    doc.lines.splice(start, stop - start);
    if (at > start) at -= stop - start;
    doc.lines.splice(at, 0, ...moved);
    return join(doc);
}

// 本文の末尾に見出しを足す
export function appendHeading(source: string, text: string): string {
    const doc = split(source);
    const end = trimBlankEnd(doc.lines, 0, doc.lines.length);
    doc.lines.splice(end, doc.lines.length - end, '', text, '');
    return join(doc);
}

// ---- frontmatter ----

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// frontmatter を yaml の Document として書き換える。コメントと書き方 (引用符、[ ] の並び) は残る
export function editFrontmatter(source: string, edit: (doc: Document) => void): string {
    const found = FRONT.exec(source);
    const doc = parseYaml(found ? found[1]! : '');
    if (doc.errors.length > 0) throw new Error('frontmatter の YAML が読めないので、書き換えられません');
    if (!isMap(doc.contents)) doc.contents = new YAMLMap() as never;
    edit(doc);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const text = doc.toString({ indent: 4, flowCollectionPadding: false, lineWidth: 0 }).replace(/\n$/, '').replace(/\n/g, eol);
    const head = `---${eol}${text}${eol}---${eol}`;
    return found ? head + source.slice(found[0].length) : `${head}${eol}${source}`;
}

function seqAt(doc: Document, path: string[]): YAMLSeq {
    const current = doc.getIn(path, true);
    if (isSeq(current)) return current;
    const seq = new YAMLSeq();
    doc.setIn(path, seq);
    return seq;
}

function scalarText(item: unknown): string {
    return isScalar(item) ? String(item.value) : String(item);
}

// 「from が終わってから to」の線を depends に足す
export function addDependency(source: string, from: string, to: string): string {
    return editFrontmatter(source, (doc) => {
        const seq = seqAt(doc, ['markdag', 'relations', 'depends']);
        const expression = `$${from} --> $${to}`;
        if (!seq.items.some((item) => scalarText(item) === expression)) seq.add(doc.createNode(expression));
    });
}

const RELATION_KINDS = ['chain', 'join', 'fork', 'depends'] as const;

// 式の項が $id だけのときに、from --> to の 1 本だけを取り除く。
// 取り除けた (または式ごと消した) ら新しい文字列、書き方が複雑で扱えなければ null
export function removeRelation(source: string, origin: string, from: string, to: string): string | null {
    let done = false;
    const next = editFrontmatter(source, (doc) => {
        for (const kind of RELATION_KINDS) {
            const seq = doc.getIn(['markdag', 'relations', kind], true);
            if (!isSeq(seq)) continue;
            const index = seq.items.findIndex((item) => scalarText(item) === origin);
            if (index < 0) continue;
            const stages = origin.split(/\s+-->\s+/).map((stage) => stage.split(/\s+&\s+/).map((term) => term.trim()));
            if (!stages.every((stage) => stage.every((term) => /^\$[A-Za-z][A-Za-z0-9_-]*$/.test(term)))) return;
            const replaced = dropEdge(stages, `$${from}`, `$${to}`);
            if (replaced === null) return;
            seq.items.splice(index, 1, ...replaced.map((expression) => doc.createNode(expression)));
            done = true;
            return;
        }
    });
    return done ? next : null;
}

// A & B --> C や A --> B --> C から 1 本の線を抜いた残りの式。扱えない形 (A & B --> C & D) なら null
function dropEdge(stages: string[][], from: string, to: string): string[] | null {
    const write = (part: string[][]) => part.map((stage) => stage.join(' & ')).join(' --> ');
    for (let at = 0; at + 1 < stages.length; at += 1) {
        const left = stages[at]!;
        const right = stages[at + 1]!;
        if (!left.includes(from) || !right.includes(to)) continue;
        if (left.length === 1 && right.length === 1) {
            // 連なりはそこで二つに切る。項が一つだけになった側は式にならないので捨てる
            return [stages.slice(0, at + 1), stages.slice(at + 1)].filter((part) => part.length >= 2).map(write);
        }
        if (stages.length !== 2) return null;
        if (right.length === 1) left.splice(left.indexOf(from), 1);
        else if (left.length === 1) right.splice(right.indexOf(to), 1);
        else return null;
        return [write(stages)];
    }
    return null;
}

// $id を含む式をすべて消す (その Issue を消したとき)
export function removeRelationsOf(source: string, ids: string[]): string {
    const pattern = new RegExp(`(^|[\\s&])\\$(${ids.map((id) => id.replace(/[-]/g, '\\-')).join('|')})(?=$|\\s)`);
    return editFrontmatter(source, (doc) => {
        for (const kind of RELATION_KINDS) {
            const seq = doc.getIn(['markdag', 'relations', kind], true);
            if (!isSeq(seq)) continue;
            seq.items = seq.items.filter((item) => !pattern.test(scalarText(item)));
        }
    });
}

// プロジェクト (グループ) を frontmatter に足す。branches があればそこにも足して、線の色を分ける
export function addGroup(source: string, id: string, label: string, color: string): string {
    return editFrontmatter(source, (doc) => {
        const group = doc.createNode({ label, color, boundary: true });
        doc.setIn(['markdag', 'groups', id], group);
        const branches = doc.getIn(['markdag', 'branches'], true);
        if (isSeq(branches)) branches.add(doc.createNode(label));
    });
}

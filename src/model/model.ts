// model 層 (簡易版)。frontmatter の markdag の下の relations と groups を、ノードの木に対して解決する。
// frontmatter の形と型の検査は同梱の JSON Schema の 1 枚が出どころで、この層はそれに続けて、
// 木やグラフを見ないと決まらない検査 (参照の解決、式の形、閉路) だけを行う。DOM には依存しない。
// 簡易版なので、(X) の枝の枠は未対応で X 自身として扱う。全角スペースの警告は出さない。
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Pair } from 'yaml';
import type { LayoutInputRelation, RelationKind } from '../layout/input-types';
import type { NodeTag, OutlineNode, SourcePosition } from '../parse/document';
import { DEFAULT_TASK_CYCLE, isTaskMark, taskStateOf, type TaskMark, type TaskState } from '../parse/task';
import schemaSource from './frontmatter.schema.json';
import { resolveHooks, rulesModule, type ResolvedHooks } from './hooks';
import { lintTags, resolveTagKeys, type TagKeyDef, type TagLintOptions, type TypeSource } from './tags';
import { closest, isRecord } from './util';

export type { SourcePosition } from '../parse/document';

export interface Diagnostic {
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    // 原文での位置 (frontmatter の指定か、本文のタグ)。場所を特定できなかったものは null
    at: SourcePosition | null;
    // 直し方の手がかり (近い名前、書き方の例)
    hint: string | null;
}

export interface GroupDef {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
    // frontmatter の markdag.groups に定義があるか (定義のないグループは文字ラベルになる)
    defined: boolean;
}

// ノードに添えるもの (詳細、タグ) の見せ方。always = 最初からノードの中に出す。hover = ノードに重ねたときに出す。click = 印のクリックで出す
export type DisplayMode = 'always' | 'hover' | 'click';
export const DISPLAY_MODES: DisplayMode[] = ['always', 'hover', 'click'];

// タグの見せ方。出さない (never) を選べる点だけが詳細と違う
export type TagDisplayMode = DisplayMode | 'never';
export const TAG_DISPLAY_MODES: TagDisplayMode[] = [...DISPLAY_MODES, 'never'];

// 薄く表示するタスクのノードでの、詳細とタグの見せ方。keep = 文書の指定のまま。never = 出さない (吹き出しも印もなし)
export type DimDisplayMode = 'keep' | 'hover' | 'click' | 'never';
export const DIM_DISPLAY_MODES: DimDisplayMode[] = ['keep', 'hover', 'click', 'never'];

// 薄く表示するタスクの状態と、そのノードでの詳細とタグの見せ方 (frontmatter の markdag.tasks.dim)
export interface TaskDimOptions {
    states: TaskState[];
    details: DimDisplayMode;
    tags: DimDisplayMode;
}

// 凡例に出す項目。groups はグループの色とラベル、branches は枝の色と起点の名前
export type LegendItem = 'groups' | 'branches';
export const DEFAULT_LEGEND: LegendItem[] = ['groups', 'branches'];

// 凡例を置く、図の領域の隅。先頭が既定
export type LegendPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
export const LEGEND_POSITIONS: LegendPosition[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];

export interface GraphModel {
    // 文書 (frontmatter の markdag.details.display) が指定する詳細の見せ方。指定がなければ null
    detailsMode: DisplayMode | null;
    // 凡例に出す項目 (frontmatter の markdag.legend.display)。空なら凡例を出さない
    legend: LegendItem[];
    // 凡例を置く隅 (frontmatter の markdag.legend.position)
    legendPosition: LegendPosition;
    // 線をクリックして、その線と前後につながる線だけを残す操作を使えるか (frontmatter の markdag.edgeHighlight)
    edgeHighlight: boolean;
    // グループの枠をクリックして、そのグループのノードと線だけを残す操作を使えるか (frontmatter の markdag.groupHighlight)
    groupHighlight: boolean;
    // 色を分ける単位にする枝の起点 (frontmatter の markdag.branches)。書かれた順で、色もこの順に割り当てる。
    // 空なら、色は markmap と同じ colorFreezeLevel で決める
    branches: number[];
    relations: LayoutInputRelation[];
    suppressRootLine: number[];
    groups: GroupDef[];
    // ノードごとの所属。groups の定義順、そのあとに定義のないグループを書かれた順
    groupsOf: Map<number, string[]>;
    // タグの見せ方 (frontmatter の markdag.tags.display)。指定がなければ always
    tagDisplay: TagDisplayMode;
    // ノードごとのタグ (そのノードに書かれたものだけ、書かれた順。配下には継承しない)
    tagsOf: Map<number, NodeTag[]>;
    // キーごとの解決済みの定義 (frontmatter の markdag.tags.keys と markdag.types)。定義のないキーは入らない
    tagKeys: TagKeyDef[];
    // タスクのクリックで進む記号の順 (frontmatter の markdag.tasks.cycle)。指定がなければ未完了と完了の行き来
    taskCycle: TaskMark[];
    // 薄く表示するタスクの状態と、そのノードでの詳細とタグの見せ方 (frontmatter の markdag.tasks.dim)。指定がなければ何も薄くしない
    taskDim: TaskDimOptions;
    // 文書が宣言し (frontmatter の markdag.hooks)、呼び出し側が渡したフック。宣言の順に並ぶ
    hooks: ResolvedHooks;
    diagnostics: Diagnostic[];
}

export interface ModelOptions {
    // markdag.types.$ref で参照したファイルの中身。$ref に書いた文字列をキーに、YAML を読んだ値 (読めなければ null) を渡す。
    // markdag はファイルを読まないので、呼び出し側が読む
    types?: Record<string, unknown>;
    // markdag.hooks.$ref で参照したモジュール。$ref に書いた文字列をキーに、import した結果を渡す。
    // types と違って中身はコードなので、読み込むかどうかの判断も呼び出し側に置く (markdag は import も eval もしない)
    hookRefs?: Record<string, unknown>;
}

interface Selector {
    ref: string;
    scope: 'self' | 'leaves' | 'all' | 'branch';
}

const KINDS: RelationKind[] = ['fork', 'join', 'chain', 'depends'];
const ARROW = /[ \t]+-->[ \t]+/;
const AMPERSAND = /[ \t]+&[ \t]+/;

const normalize = (text: string): string => text.normalize('NFC').replace(/[ \t]+/g, ' ').trim();

// 参照の経路を「/」で区切る。直前が「\」の「/」は区切りにしない。
// 正規表現の後読みで書けるが、後読みを読めない古いブラウザではモジュール全体が構文エラーになるので、使わない
function splitPath(ref: string): string[] {
    const segments: string[] = [];
    let current = '';
    [...ref].forEach((char, index, chars) => {
        if (char === '/' && chars[index - 1] !== '\\') {
            segments.push(current);
            current = '';
        } else current += char;
    });
    return [...segments, current];
}

// frontmatter の中での場所を指す道すじ。文字はマップのキー、数はならびの添字
type SourcePath = ReadonlyArray<string | number>;

// スカラだけでなく、ならびの中の写像やならびも位置を持つ
const rangeStartOf = (node: unknown): number | undefined =>
    isScalar(node) || isMap(node) || isSeq(node) ? node.range?.[0] : undefined;

// frontmatter の切り出しは、実際に値を読む側 (markmap) と同じ判定にそろえる
const FRONTMATTER_OPEN = /^---\r?\n/;
const FRONTMATTER_CLOSE = /\n---\r?\n/;

// 原文の frontmatter を位置付きで解析して、診断が指す場所を原文の行と桁で返す。
// 場所は道すじ (パス) で指定する。解析できない frontmatter では位置を返さないだけで、例外は投げない
class FrontmatterLocator {
    // frontmatter の本体 (--- の内側)。位置の添字は、すべてこの文字列の上で数える
    private readonly body: string = '';
    // 本体の行番号を、原文の行番号に直すための差
    private readonly lineOffset: number = 0;
    private readonly lineCounter = new LineCounter();
    private readonly doc: Document.Parsed | null = null;

    constructor(source: string | undefined) {
        const text = source ?? '';
        const open = FRONTMATTER_OPEN.exec(text);
        const close = open ? FRONTMATTER_CLOSE.exec(text) : null;
        if (!open || !close) return;
        const start = open[0].length;
        // CRLF の文書では、閉じの --- の手前に \r が 1 つ残る。YAML の誤りと見なされるので落とす (前の位置はずれない)
        this.body = text.slice(start, Math.max(start, close.index)).replace(/\r$/, '');
        this.lineOffset = text.slice(0, start).split('\n').length - 1;
        try {
            this.doc = parseDocument(this.body, { lineCounter: this.lineCounter });
        } catch {
            // 壊れた frontmatter。値を読む側も読めていないので、位置なしで続ける
            this.doc = null;
        }
    }

    // YAML として読めなかった誤り。markmap は読めない frontmatter を丸ごと捨てるので、ここでしか気づけない
    syntaxErrors(): Array<{ message: string; at: SourcePosition | null }> {
        return (this.doc?.errors ?? []).map((error) => ({
            // メッセージに付く英語の位置と原文の抜き書きは、こちらが行と桁と編集欄の印で出すので落とす
            message: error.message.replace(/\s*at line \d+, column \d+[\s\S]*$/, ''),
            at: this.spanOfLine(error.pos[0]),
        }));
    }

    // 値の位置。inner を渡すと、その語が値の原文にちょうど 1 回あるときに限って、その語だけを指す。
    // 値が空 (「color: #D64545」のように # から先がコメントになった場合) は、キーから行末までを指す
    value(path: SourcePath, inner?: string | null): SourcePosition | null {
        const node = this.nodeAt(path);
        if (isScalar(node) && node.range) {
            const [start, end] = node.range;
            const raw = this.body.slice(start, end);
            const found = inner ? raw.indexOf(inner) : -1;
            // 同じ語が式に 2 回出るとき (A --> A など) は、どちらか分からないので式の全体を指す
            if (inner && found >= 0 && raw.indexOf(inner, found + 1) < 0) return this.at(start + found, [...inner].length);
            // 折り返しのスカラ (|- や >-) は、記号の行ではなく中身の 1 行目を指す
            if (/^[|>]/.test(raw)) {
                const body = this.body.indexOf('\n', start);
                if (body >= 0 && body < end) return this.spanOfLine(body + 1);
            }
            const span = this.spanFrom(start, end);
            if (span) return span;
        }
        return this.fallback(path, node);
    }

    // キーの位置。path の最後がキーの名前で、その前は親のキー
    key(path: SourcePath): SourcePosition | null {
        const key = this.pairAt(path)?.key;
        return isScalar(key) && key.range ? this.spanFrom(key.range[0], key.range[1]) : null;
    }

    // 値を指せないときの逃げ道。印が 0 幅にならないよう、指せる場所を順に試す。
    // キーから行末、値の始まりから行末 (ならびの中の写像やならびもここで指せる)、その行の字のある範囲、最後に親のキー
    private fallback(path: SourcePath, node: unknown): SourcePosition | null {
        const key = this.pairAt(path)?.key;
        const starts = [isScalar(key) ? key.range?.[0] : undefined, rangeStartOf(node)];
        for (const start of starts) {
            const span = start === undefined ? null : (this.spanFrom(start) ?? this.spanOfLine(start));
            if (span) return span;
        }
        return path.length > 1 ? this.key(path.slice(0, -1)) : null;
    }

    // 本体の中の添字を、原文での位置に直す。yaml が返す桁は UTF-16 の数なので、桁は文字数で数え直す
    private at(offset: number, length: number): SourcePosition {
        const { line } = this.lineCounter.linePos(offset);
        const start = this.lineCounter.lineStarts[line - 1] ?? 0;
        return { line: line + this.lineOffset, column: [...this.body.slice(start, offset)].length + 1, length };
    }

    // その行の、字のある範囲を指す。値が空で指す場所がないとき (ならびの「-」だけの行など) の最後の逃げ道
    private spanOfLine(offset: number): SourcePosition | null {
        const lineStart = this.body.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
        const wrapped = this.body.indexOf('\n', lineStart);
        const line = this.body.slice(lineStart, wrapped < 0 ? this.body.length : wrapped).trimEnd();
        const indent = line.length - line.trimStart().length;
        return line.length <= indent ? null : this.at(lineStart + indent, [...line.slice(indent)].length);
    }

    // offset から、その行の終わり (または limit) までを指す。SourcePosition は 1 行しか表せないので、印は 1 行に収める
    private spanFrom(offset: number, limit?: number): SourcePosition | null {
        const wrapped = this.body.indexOf('\n', offset);
        const lineEnd = wrapped < 0 ? this.body.length : wrapped;
        const text = this.body.slice(offset, Math.min(limit ?? lineEnd, lineEnd)).trimEnd();
        return text === '' ? null : this.at(offset, [...text].length);
    }

    private nodeAt(path: SourcePath): unknown {
        let node: unknown = this.doc?.contents ?? undefined;
        for (const step of path) {
            if (isMap(node)) node = this.pairOf(node, step)?.value;
            else if (isSeq(node) && typeof step === 'number') node = node.items[step];
            else return undefined;
            if (node === undefined) return undefined;
        }
        return node;
    }

    private pairAt(path: SourcePath): Pair<unknown, unknown> | undefined {
        return path.length === 0 ? undefined : this.pairOf(this.nodeAt(path.slice(0, -1)), path[path.length - 1] ?? '');
    }

    // YAML はキーを数や真偽値に直す (groups の 2024 など) ので、名前は文字にして突き合わせる。
    // この事情で doc.getIn は使えず、items を自分でたどる
    private pairOf(node: unknown, name: string | number): Pair<unknown, unknown> | undefined {
        if (!isMap(node)) return undefined;
        return node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(name));
    }
}

// frontmatter の形と型の検証。出どころは frontmatter.schema.json の 1 枚だけで、診断のコード (x-code)、
// 重大度 (x-severity)、直し方の手がかり (x-hint) もスキーマが持つ。見るキーワードは type, enum, const, pattern,
// minLength, items, properties, additionalProperties, uniqueItems, oneOf, $ref (#/$defs/ のみ) に限る
type Schema = Record<string, unknown>;

const SCHEMA: Schema = schemaSource;

// 破られた制約 1 つ。path は誤りのある値の場所 (位置の解決にそのまま渡す)、schema はその制約を書いた部分スキーマ
interface SchemaIssue {
    path: SourcePath;
    schema: Schema;
    keyword: string;
    value: unknown;
    // additionalProperties の違反での、知らないキーと、そこに書けるキーの一覧。
    // そのキーが下の階層に書くはずのものなら、under に置き場所 (そこからの親のキーの道すじ) が入る
    unknown?: { key: string; known: string[]; under?: string[] };
}

const IS_TYPE: Record<string, (value: unknown) => boolean> = {
    object: isRecord,
    array: (value) => Array.isArray(value),
    string: (value) => typeof value === 'string',
    boolean: (value) => typeof value === 'boolean',
    number: (value) => typeof value === 'number' && Number.isFinite(value),
    integer: (value) => typeof value === 'number' && Number.isInteger(value),
    null: (value) => value === null,
};

const TYPE_LABELS: Record<string, string> = {
    object: 'キーと値の組',
    array: '一覧',
    string: '文字列',
    boolean: '真偽値',
    number: '数値',
    integer: '整数',
    null: '空',
};

// 診断に書き添える値。長いものは途中で切る
const asText = (value: unknown): string => {
    const shown = [...(JSON.stringify(value) ?? String(value))];
    return shown.length > 40 ? `${shown.slice(0, 40).join('')}…` : shown.join('');
};

// そこに書けるキーの一覧。markmap のように多いものは途中までにする
const asList = (names: string[]): string => {
    const kept = names.filter((name, index) => names.slice(0, index).join(', ').length + name.length <= 48);
    return kept.length === names.length ? names.join(', ') : `${kept.join(', ')} ほか`;
};

// $ref の先。$ref は type や items の兄弟に置けるので、1 つの値に制約を 2 段 (型と形) で掛けられる
function refTarget(schema: Schema): Schema | null {
    const ref = schema.$ref;
    const found = typeof ref === 'string' && isRecord(SCHEMA.$defs) ? SCHEMA.$defs[ref.replace('#/$defs/', '')] : undefined;
    return isRecord(found) ? found : null;
}

// type に書かれた型の一覧。type は 1 つの名前か、名前の一覧 (どれかに合えばよい。値が空でもよいキーに null を並べる)
const typesOf = (schema: Schema): string[] =>
    typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.map(String) : [];

// oneOf の枝は値の型で選ぶので、枝の型を $ref の先まで見て取り出す
function typeOf(schema: Schema): string {
    if (typeof schema.type === 'string') return schema.type;
    const target = refTarget(schema);
    return target ? typeOf(target) : '';
}

function propertiesOf(schema: Schema | null): Record<string, unknown> {
    if (!schema) return {};
    return { ...propertiesOf(refTarget(schema)), ...(isRecord(schema.properties) ? schema.properties : {}) };
}

// そのスキーマより下の階層に書くキーと、その置き場所 (そこからの親のキーの道すじ)。properties と $ref の先だけをたどり、
// 名前が決まっていないキー (additionalProperties) の下は見ない。同じ名前が 2 か所にあれば、先に見つけたほうを取る
function ownersOf(schema: Schema, path: string[] = [], into = new Map<string, string[]>()): Map<string, string[]> {
    for (const [name, sub] of Object.entries(propertiesOf(schema))) {
        if (!isRecord(sub)) continue;
        if (path.length > 0 && !into.has(name)) into.set(name, path);
        ownersOf(sub, [...path, name], into);
    }
    return into;
}

// 置き場所の手がかり。親のキーの道すじを、上から順に作る言い方にする
function placementHint(parents: string[], key: string): string {
    const [first = '', ...rest] = parents;
    const chain = rest.length === 0 ? `${first}: の行を作り` : `${first}: の下に ${rest.map((name) => `${name}:`).join(' を作り、さらにその下に ')} を作り`;
    return `${chain}、その下に字下げして ${key}: を書きます`;
}

function check(value: unknown, schema: Schema, path: SourcePath, issues: SchemaIssue[]): void {
    const target = refTarget(schema);
    if (target) check(value, target, path, issues);
    const add = (keyword: string, extra: Partial<SchemaIssue> = {}): void => {
        issues.push({ path, schema, keyword, value, ...extra });
    };
    // 型が違えば、その先の制約は見ない (同じ値に 2 つ診断を出さない)
    const types = typesOf(schema);
    if (types.length > 0 && !types.some((type) => IS_TYPE[type]?.(value) ?? true)) return add('type');
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) add('enum');
    if ('const' in schema && schema.const !== value) add('const');
    if (typeof value === 'string') {
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) add('pattern');
        if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) add('minLength');
    }
    if (Array.isArray(schema.oneOf)) {
        const branch = schema.oneOf.filter(isRecord).find((candidate) => IS_TYPE[typeOf(candidate)]?.(value) === true);
        if (branch) check(value, branch, path, issues);
        else add('oneOf');
    }
    if (Array.isArray(value)) {
        const seen = new Set<string>();
        value.forEach((item, index) => {
            if (isRecord(schema.items)) check(item, schema.items, [...path, index], issues);
            const same = JSON.stringify(item ?? null);
            // 重なりは、2 つ目以降の項目の位置で知らせる
            if (schema.uniqueItems === true && seen.has(same)) issues.push({ path: [...path, index], schema, keyword: 'uniqueItems', value: item });
            seen.add(same);
        });
    }
    if (isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {};
        for (const [key, child] of Object.entries(value)) {
            if (isRecord(properties[key])) check(child, properties[key], [...path, key], issues);
            else if (isRecord(schema.additionalProperties)) check(child, schema.additionalProperties, [...path, key], issues);
            else if (schema.additionalProperties === false) {
                add('additionalProperties', { value: child, unknown: { key, known: Object.keys(properties), under: ownersOf(schema).get(key) } });
            }
        }
    }
}

// 破られたキーワードごとの文面。値の書き方そのものは hint (スキーマの x-hint) に任せ、ここでは何が違うかだけを書く。
// pattern は形の名前をスキーマの description から取る
function messageOf({ schema, keyword, unknown }: SchemaIssue, label: string, shown: string): string {
    const choices = Array.isArray(schema.enum) ? schema.enum : [];
    const branches = (Array.isArray(schema.oneOf) ? schema.oneOf : []).filter(isRecord);
    if (unknown) return `${label} のキー「${unknown.key}」は使えません (${asList(unknown.known)})`;
    // 空でもよいキーの「空」は、書き方の案内には出さない
    const typeLabels = typesOf(schema).filter((type) => type !== 'null').map((type) => TYPE_LABELS[type] ?? '');
    if (keyword === 'type') return `${label} は${typeLabels.join('か')}で書きます${shown}`;
    if (keyword === 'enum') return `${label} に指定できるのは ${choices.join(', ')} です${shown}`;
    if (keyword === 'const') return `${label} に指定できるのは ${asText(schema.const)} です${shown}`;
    if (keyword === 'pattern') return `${label} は「${String(schema.description ?? '')}」の形で書きます${shown}`;
    if (keyword === 'minLength') return `${label} が空です`;
    if (keyword === 'uniqueItems') return `${label} は前にも書かれています${shown}`;
    return `${label} には ${branches.map((branch) => TYPE_LABELS[typeOf(branch)] ?? '').join('、')} のどれかを書きます${shown}`;
}

// 破られた制約を、画面が使う診断に直す。位置はスキーマの中の場所 (パス) から引き、コードと重大度と手がかりは、
// その制約を書いた部分スキーマから取る。知らないキーと使えない値には、近い名前を手がかりにする
function toDiagnostic(issue: SchemaIssue, locator: FrontmatterLocator): Diagnostic {
    const { schema, keyword, value, unknown } = issue;
    // 場所の呼び名。先頭の「.」は落とす。最上位そのものが相手のときは frontmatter と呼ぶ
    const label = issue.path.map((step) => (typeof step === 'number' ? `[${step}]` : `.${step}`)).join('').slice(1) || 'frontmatter';
    // 下の階層に書くはずのキーは、知らないキーではなく置き場所の違いとして知らせる
    if (unknown?.under) {
        return {
            severity: 'warning',
            code: 'option-misplaced',
            message: `${label} のキー「${unknown.key}」は、${label}.${unknown.under.join('.')} の下に書いてください。この位置では無視します`,
            at: locator.key([...issue.path, unknown.key]),
            hint: placementHint(unknown.under, unknown.key),
        };
    }
    const choices = Array.isArray(schema.enum) ? schema.enum : [];
    const near = unknown
        ? closest(unknown.key, unknown.known)
        : keyword === 'enum' && typeof value === 'string'
          ? closest(value, choices.map(String))
          : null;
    return {
        severity: (schema['x-severity'] as Diagnostic['severity'] | undefined) ?? 'warning',
        code: (schema['x-code'] as string | undefined) ?? (unknown ? 'option-unknown' : 'option-invalid'),
        // markmap-lib が読めない値を undefined に直したものは、原文の値を書き添えられない
        message: messageOf(issue, label, value === undefined ? '' : ` (${asText(value)})`),
        at: unknown ? locator.key([...issue.path, unknown.key]) : locator.value(issue.path),
        hint: near !== null ? `もしかして「${near}」` : ((schema['x-hint'] as string | undefined) ?? null),
    };
}

function schemaDiagnostics(frontmatter: Record<string, unknown>, locator: FrontmatterLocator): Diagnostic[] {
    const issues: SchemaIssue[] = [];
    check(frontmatter, SCHEMA, [], issues);
    const diagnostics = issues.map((issue) => toDiagnostic(issue, locator));
    // 最上位は、markmap が任意のキー (title など) を許すので閉じられない。代わりに、下の階層に書くはずのキーと、
    // スキーマが知っているキーの書き間違いらしい名前だけを、ここで拾う
    const rootProperties = propertiesOf(SCHEMA);
    const rootNames = Object.keys(rootProperties);
    const owner = ownersOf(SCHEMA);
    for (const key of Object.keys(frontmatter)) {
        if (key in rootProperties) continue;
        const parent = owner.get(key);
        // 下の階層に書くはずのキーの書き間違い (relation など) も、ここで拾って置き場所ごと手がかりにする
        const near = parent === undefined ? closest(key, [...rootNames, ...owner.keys()]) : null;
        const nearParent = near === null ? undefined : owner.get(near);
        if (parent !== undefined) {
            diagnostics.push({
                severity: 'warning',
                code: 'option-misplaced',
                message: `「${key}」は frontmatter の ${parent.join('.')} の下に書いてください。この位置では無視します`,
                at: locator.key([key]),
                hint: placementHint(parent, key),
            });
        } else if (near !== null) {
            diagnostics.push({
                severity: 'warning',
                code: 'option-unknown',
                message: `frontmatter のキー「${key}」は、markdag が読むキー (${asList(rootNames)}) のどれでもありません`,
                at: locator.key([key]),
                hint: nearParent === undefined ? `もしかして「${near}」` : `もしかして「${near}」(${nearParent.join('.')} の下に書きます)`,
            });
        }
    }
    // 画面は上から順に読むので、frontmatter に書かれた順に並べる (位置の分からないものは最後)
    return diagnostics.sort((a, b) =>
        a.at && b.at ? a.at.line - b.at.line || a.at.column - b.at.column : (a.at ? 0 : 1) - (b.at ? 0 : 1),
    );
}

// frontmatter の形と型だけを検べる入口。原文を渡すと、診断に frontmatter での位置が付く
export function checkFrontmatter(frontmatter: Record<string, unknown>, markdown?: string): Diagnostic[] {
    return schemaDiagnostics(frontmatter, new FrontmatterLocator(markdown));
}

class Resolver {
    private readonly byId = new Map<number, OutlineNode>();
    private readonly children = new Map<number, number[]>();
    // 前方一致で解決した参照。書き間違いでも名前の一部が一致すれば通ってしまうので、呼び出し側が診断に出す
    private prefixMatched: Array<{ ref: string; text: string }> = [];

    constructor(private readonly nodes: OutlineNode[]) {
        for (const node of nodes) {
            this.byId.set(node.id, node);
            this.children.set(node.id, []);
        }
        for (const node of nodes) if (node.parent !== null) this.children.get(node.parent)?.push(node.id);
    }

    // 直前の解決で前方一致になった参照を取り出して、記録を空にする
    takePrefixMatches(): Array<{ ref: string; text: string }> {
        const matched = this.prefixMatched;
        this.prefixMatched = [];
        return matched;
    }

    childrenOf(id: number): number[] {
        return this.children.get(id) ?? [];
    }

    descendants(id: number): number[] {
        return this.childrenOf(id).flatMap((child) => [child, ...this.descendants(child)]);
    }

    ancestors(id: number): OutlineNode[] {
        const chain: OutlineNode[] = [];
        for (let parent = this.byId.get(id)?.parent ?? null; parent !== null; parent = this.byId.get(parent)?.parent ?? null) {
            const node = this.byId.get(parent);
            if (node) chain.unshift(node);
        }
        return chain;
    }

    parseSelector(raw: string): Selector {
        let text = raw.trim();
        if (text.startsWith('(') && text.endsWith(')')) return { ref: text.slice(1, -1).trim(), scope: 'branch' };
        if (/^\(.*\)\/\*\*?$/.test(text)) {
            throw new SelectorError('relation-syntax', `括弧と /* は組み合わせられません: ${raw}`, raw.trim(), '枝の枠でまとめるか配下に展開するかの、どちらかにします');
        }
        let scope: Selector['scope'] = 'self';
        if (text.endsWith('/**')) [text, scope] = [text.slice(0, -3), 'all'];
        else if (text.endsWith('/*')) [text, scope] = [text.slice(0, -2), 'leaves'];
        if (text.trim() === '') throw new SelectorError('relation-syntax', `参照が空です: ${raw}`, raw.trim());
        return { ref: text.trim(), scope };
    }

    // 完全一致を優先し、なければ前方一致。祖先のセグメントは、この順に並ぶ祖先がいるものだけを残す
    resolveRef(ref: string): number {
        if (/^\$[A-Za-z][A-Za-z0-9_-]*$/.test(ref)) {
            const found = this.nodes.filter((node) => node.refId === ref.slice(1));
            if (found.length === 1 && found[0]) return found[0].id;
            const near = closest(ref, this.nodes.flatMap((node) => (node.refId === null ? [] : [`$${node.refId}`])));
            throw new SelectorError(
                found.length === 0 ? 'ref-not-found' : 'ref-ambiguous',
                `${ref} が${found.length === 0 ? '見つかりません' : '複数あります'}`,
                ref,
                found.length === 0 ? (near === null ? '本文のノードの行末に $id を書くと、その名前で指せます' : `もしかして「${near}」`) : '同じ $id を 2 つ以上のノードに書かないようにします',
            );
        }
        const segments = splitPath(ref).map((segment) => normalize(segment.replace(/\\([/($])/g, '$1')));
        const last = segments[segments.length - 1] ?? '';
        const ancestorSegments = segments.slice(0, -1);
        const matches = (text: string, segment: string, exact: boolean): boolean =>
            text !== '' && (exact ? text === segment : text.startsWith(segment));
        const hasAncestors = (node: OutlineNode): boolean => {
            let chain = this.ancestors(node.id);
            for (const segment of ancestorSegments) {
                const exact = this.nodes.some((candidate) => candidate.refText === segment);
                const index = chain.findIndex((ancestor) => matches(ancestor.refText, segment, exact));
                if (index < 0) return false;
                chain = chain.slice(index + 1);
            }
            return true;
        };
        for (const exact of [true, false]) {
            const found = this.nodes.filter((node) => matches(node.refText, last, exact) && hasAncestors(node));
            if (found.length === 1 && found[0]) {
                if (!exact) this.prefixMatched.push({ ref, text: found[0].refText });
                return found[0].id;
            }
            if (found.length > 1) {
                throw new SelectorError(
                    'ref-ambiguous',
                    `「${ref}」に一致するノードが ${found.length} 個あります (${found.map((node) => node.refText).join('、')})`,
                    ref,
                    '親のノードを付けて「親/子」と書くか、指したいノードの行末に $id を付けると 1 つに絞れます',
                );
            }
        }
        const near = closest(last, this.nodes.map((node) => node.refText));
        throw new SelectorError(
            'ref-not-found',
            `「${ref}」に一致するノードがありません`,
            ref,
            near === null ? 'ノードの 1 行目の文字を、先頭から書きます (装飾とタグは除いた文字)' : `もしかして「${near}」`,
        );
    }

    expand(selector: Selector): number[] {
        const id = this.resolveRef(selector.ref);
        if (selector.scope === 'self' || selector.scope === 'branch') return [id];
        if (selector.scope === 'all') return [id, ...this.descendants(id)];
        const leaves = this.descendants(id).filter((descendant) => this.childrenOf(descendant).length === 0);
        if (leaves.length === 0) {
            throw new SelectorError('selector-empty', `「${selector.ref}/*」は、配下にノードがないので展開できません`, selector.ref, 'このノード自身を指すなら、末尾の /* を外します');
        }
        return leaves;
    }
}

class SelectorError extends Error {
    constructor(
        readonly code: string,
        message: string,
        // 原文の中でこの誤りが指す語と、直し方の手がかり
        readonly ref: string | null = null,
        readonly hint: string | null = null,
    ) {
        super(message);
    }
}

function checkShape(kind: RelationKind, terms: Array<{ selectors: Selector[]; ids: number[] }>): string | null {
    const first = terms[0];
    const last = terms[terms.length - 1];
    if (!first || !last) return null;
    if (kind === 'join' && !(terms.length === 2 && last.ids.length === 1 && (first.ids.length >= 2 || first.selectors.every((s) => s.scope === 'branch')))) {
        return 'join は「2 ノード以上 --> 1 ノード」の形を想定しています';
    }
    if (kind === 'fork' && !(terms.length === 2 && first.ids.length === 1 && last.ids.length >= 2)) {
        return 'fork は「1 ノード --> 2 ノード以上」の形を想定しています';
    }
    if (kind === 'chain' && !terms.every((term) => term.selectors.length === 1 && ['self', 'branch'].includes(term.selectors[0]?.scope ?? ''))) {
        return 'chain は、すべての項が 1 ノードの形を想定しています';
    }
    return null;
}

export function buildModel(nodes: OutlineNode[], frontmatter: Record<string, unknown>, markdown?: string, extra: ModelOptions = {}): GraphModel {
    const diagnostics: Diagnostic[] = [];
    const resolver = new Resolver(nodes);
    const locator = new FrontmatterLocator(markdown);
    // YAML として読めない frontmatter は、値を読む側 (markmap) が丸ごと捨てるので、指定が何も効かない。
    // 位置付きの解析はその誤りを見ているので、ここで知らせる
    for (const error of locator.syntaxErrors()) {
        diagnostics.push({
            severity: 'error',
            code: 'yaml-syntax',
            message: `frontmatter を YAML として読めません: ${error.message}`,
            at: error.at,
            hint: 'この frontmatter は丸ごと無視されるので、markdag の指定は何も効きません',
        });
    }
    // frontmatter の形と型はスキーマ 1 枚が出どころ。ここから下では、木やグラフを見ないと決まらない検査だけを行う
    diagnostics.push(...schemaDiagnostics(frontmatter, locator));
    const report = (severity: Diagnostic['severity'], code: string, message: string, extra: { at?: SourcePosition | null; hint?: string | null } = {}): void => {
        diagnostics.push({ severity, code, message, at: extra.at ?? null, hint: extra.hint ?? null });
    };
    // 前方一致で解決した参照を知らせる。名前を書き誤っても、先頭が一致すればそのまま通ってしまうため
    const reportPrefixMatches = (context: string, locate: (ref: string) => SourcePosition | null): void => {
        for (const { ref, text } of resolver.takePrefixMatches()) {
            report('info', 'ref-prefix', `${context}: 「${ref}」は前方一致で「${text}」に解決しました`, {
                at: locate(ref),
                hint: `書き間違いなら「${text}」に直します`,
            });
        }
    };

    // 閉路の検査に使うグラフ。ツリーのエッジを入れておき、relations を記述順に足していく
    const successors = new Map<number, number[]>(nodes.map((node) => [node.id, []]));
    const existing = new Set<string>();
    for (const node of nodes) {
        if (node.parent === null) continue;
        successors.get(node.parent)?.push(node.id);
        existing.add(`${node.parent}>${node.id}`);
    }
    const reaches = (from: number, to: number): boolean => {
        const seen = new Set([from]);
        const stack = [from];
        for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
            if (current === to) return true;
            for (const next of successors.get(current) ?? []) {
                if (!seen.has(next)) {
                    seen.add(next);
                    stack.push(next);
                }
            }
        }
        return false;
    };
    const name = (id: number): string => nodes[id - 1]?.refText || `#${id}`;

    // markdag の指定はすべて markdag キーの下にある。知らないキー、使えない値、markdag の外に置かれた指定は、どれもスキーマが警告にしている
    const options = isRecord(frontmatter.markdag) ? frontmatter.markdag : {};

    const relations: LayoutInputRelation[] = [];
    let warnedBranch = false;
    // 写像でない relations、文字列でない式、--> のない式は、どれもスキーマが警告にしている
    for (const [key, value] of Object.entries(isRecord(options.relations) ? options.relations : {})) {
        if (!KINDS.includes(key as RelationKind)) continue;
        const kind = key as RelationKind;
        const list: unknown[] = Array.isArray(value) ? value : [value];
        for (const [index, expression] of list.entries()) {
            if (typeof expression !== 'string') continue;
            const parts = expression.split(ARROW);
            if (parts.length < 2) continue;
            // 一覧で書かれたときは添字まで、1 つだけ書かれたときはキーまでが、この式の道すじ
            const path = Array.isArray(value) ? ['markdag', 'relations', key, index] : ['markdag', 'relations', key];
            const place = (ref?: string | null): SourcePosition | null => locator.value(path, ref);
            try {
                const terms = parts.map((part) => {
                    const selectors = part.split(AMPERSAND).map((raw) => resolver.parseSelector(raw));
                    return { selectors, ids: [...new Set(selectors.flatMap((selector) => resolver.expand(selector)))] };
                });
                if (!warnedBranch && terms.some((term) => term.selectors.some((selector) => selector.scope === 'branch'))) {
                    warnedBranch = true;
                    report('warning', 'not-supported', '(X) の枝の枠は未対応です。X 自身から線を出します', { at: place() });
                }
                const shape = checkShape(kind, terms);
                if (shape) report('warning', 'shape-mismatch', `「${expression}」: ${shape}`, { at: place() });

                terms.slice(1).forEach((term, index) => {
                    for (const source of terms[index]?.ids ?? []) {
                        for (const target of term.ids) {
                            const label = `${name(source)} --> ${name(target)}`;
                            if (source === target) {
                                report('error', 'self-loop', `始点と終点が同じです: ${label}`, { at: place(name(source)) });
                            } else if (existing.has(`${source}>${target}`)) {
                                report('warning', 'duplicate-edge', `同じ線がすでにあります: ${label}`, {
                                    at: place(name(target)),
                                    hint: 'この向きの線はすでにあります。重なった指定を消せます',
                                });
                            } else if (reaches(target, source)) {
                                report('error', 'cycle', `閉路になるので追加しません: ${label}`, {
                                    at: place(name(target)),
                                    hint: `「${name(target)}」から「${name(source)}」へ、すでに道があります。向きを入れ替えるか、この指定を消します`,
                                });
                            } else {
                                existing.add(`${source}>${target}`);
                                successors.get(source)?.push(target);
                                relations.push({ kind, source, target, origin: expression });
                            }
                        }
                    }
                });
            } catch (error) {
                if (!(error instanceof SelectorError)) throw error;
                report('error', error.code, `「${expression}」: ${error.message}`, { at: place(error.ref), hint: error.hint });
            } finally {
                reportPrefixMatches(`「${expression}」`, place);
            }
        }
    }

    const topLevel = new Set(nodes.filter((node) => node.depth === 2).map((node) => node.id));
    const suppressRootLine = [...new Set(relations.map((relation) => relation.target))]
        .filter((id) => topLevel.has(id))
        .sort((a, b) => a - b);

    // groups: 本文の %名前、members の指定、祖先からの継承の 3 つを合わせる
    const groups: GroupDef[] = [];
    const direct = new Map<number, Set<string>>(nodes.map((node) => [node.id, new Set(node.groups)]));
    for (const [id, raw] of Object.entries(isRecord(options.groups) ? options.groups : {})) {
        const def = isRecord(raw) ? raw : {};
        groups.push({
            id,
            label: typeof def.label === 'string' ? def.label : id,
            color: typeof def.color === 'string' ? def.color : null,
            boundary: def.boundary === true,
            defined: true,
        });
        const members: unknown[] = Array.isArray(def.members) ? def.members : [];
        for (const [index, member] of members.entries()) {
            // 文字列でない要素と空の要素はスキーマが警告にしているので、同じ誤りを二重に出さない
            if (typeof member !== 'string' || member.trim() === '') continue;
            const memberPlace = (ref?: string | null): SourcePosition | null => locator.value(['markdag', 'groups', id, 'members', index], ref);
            try {
                const selector = resolver.parseSelector(member);
                if (selector.scope === 'branch') throw new SelectorError('group-invalid', 'members に (X) は書けません', member, '括弧を外して書きます');
                for (const nodeId of resolver.expand(selector)) direct.get(nodeId)?.add(id);
            } catch (error) {
                if (!(error instanceof SelectorError)) throw error;
                report('warning', error.code, `markdag.groups.${id}.members「${String(member)}」: ${error.message}`, {
                    at: memberPlace(error.ref),
                    hint: error.hint,
                });
            } finally {
                reportPrefixMatches(`markdag.groups.${id}.members`, memberPlace);
            }
        }
    }
    for (const node of nodes) {
        for (const name of node.groups) {
            if (!groups.some((group) => group.id === name)) {
                groups.push({ id: name, label: name, color: null, boundary: false, defined: false });
            }
        }
    }
    const order = new Map(groups.map((group, index) => [group.id, index]));
    const groupsOf = new Map<number, string[]>();
    for (const node of nodes) {
        const inherited = node.parent === null ? [] : (groupsOf.get(node.parent) ?? []);
        const all = new Set([...inherited, ...(direct.get(node.id) ?? [])]);
        groupsOf.set(node.id, [...all].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
    }

    // tags: 定義なしで使え、配下には継承しない。見せ方は文書がまとめて決める (キーごとの指定はない)
    const tagOptionsRaw = isRecord(options.tags) ? options.tags : {};
    const tagDisplay = TAG_DISPLAY_MODES.includes(tagOptionsRaw.display as TagDisplayMode) ? (tagOptionsRaw.display as TagDisplayMode) : 'always';
    const tagsOf = new Map<number, NodeTag[]>();
    for (const node of nodes) {
        tagsOf.set(
            node.id,
            node.tags.map((tag) => ({ key: tag.key, values: [...tag.values], at: { ...tag.at } })),
        );
    }

    // types と tags.keys: 型をキーごとの定義に解決し、本文のタグを検査する。$ref のファイルは呼び出し側が読んで extra.types に渡す
    const typesRaw = isRecord(options.types) ? options.types : {};
    const refs = typeof typesRaw.$ref === 'string' ? [typesRaw.$ref] : Array.isArray(typesRaw.$ref) ? typesRaw.$ref.filter((item): item is string => typeof item === 'string') : [];
    const sources: TypeSource[] = [];
    let unresolved = false;
    refs.forEach((ref, index) => {
        const loaded = extra.types?.[ref];
        if (isRecord(loaded)) {
            sources.push({ label: ref, defs: loaded, path: null });
            return;
        }
        unresolved = true;
        report('warning', 'types-unresolved', `markdag.types.$ref「${ref}」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)`, {
            at: locator.value(Array.isArray(typesRaw.$ref) ? ['markdag', 'types', '$ref', index] : ['markdag', 'types', '$ref']),
            hint: loaded === undefined ? '呼び出し側が読んで buildModel の types に渡します (npm run check は文書の場所からの相対で読みます)' : 'ファイルが YAML のキーと値の組として読めるか確かめます',
        });
    });
    const { $ref: _ref, ...ownTypes } = typesRaw;
    sources.push({ label: 'markdag.types', defs: ownTypes, path: ['markdag', 'types'] });
    const resolved = resolveTagKeys(sources, isRecord(tagOptionsRaw.keys) ? tagOptionsRaw.keys : {}, ['markdag', 'tags', 'keys'], unresolved);
    const lint: TagLintOptions = { severity: tagOptionsRaw.lint === 'error' ? 'error' : 'warning', unknownKey: tagOptionsRaw.unknownKey === 'deny' ? 'deny' : 'allow' };
    for (const issue of [...resolved.issues, ...lintTags(nodes, resolved.keys, lint)]) {
        diagnostics.push({ severity: issue.severity, code: issue.code, message: issue.message, at: issue.at ?? (issue.path ? locator.value(issue.path) : null), hint: issue.hint });
    }

    // hooks: 文書は使うフックの名前だけを宣言し、実体は呼び出し側が渡す。ここでは宣言と実体を突き合わせて診断を出す
    const hooks = resolveHooks(options.hooks, extra.hookRefs);
    for (const issue of hooks.issues) {
        report(issue.severity, issue.code, issue.message, { at: issue.path ? locator.value(issue.path) : null, hint: issue.hint });
    }
    // rules: コードを書かずに使える規則。組み込みのフックにして、宣言したフックより先に評価する
    const rules = rulesModule(options.rules);
    (rules?.groups ?? []).forEach((name, index) => {
        if (groups.some((group) => group.id === name)) return;
        report('warning', 'option-invalid', `markdag.rules.taskToggle.readonlyGroups: グループ「${name}」は、この文書のどのノードにも付いていません`, {
            at: locator.value(['markdag', 'rules', 'taskToggle', 'readonlyGroups', index]),
            hint: closest(name, groups.map((group) => group.id)) === null ? '本文で %名前 を付けるか、markdag.groups に定義します' : `もしかして「${closest(name, groups.map((group) => group.id)) ?? ''}」`,
        });
    });
    const allHooks = rules === null ? hooks.hooks : [{ ref: 'markdag.rules', module: rules.module }, ...hooks.hooks];

    const detailsOptions = isRecord(options.details) ? options.details : {};
    const detailsMode: DisplayMode | null = DISPLAY_MODES.includes(detailsOptions.display as DisplayMode) ? (detailsOptions.display as DisplayMode) : null;
    // tasks: クリックで進む順と、薄く表示する状態。使えない値は指定なしとして扱う (診断はスキーマの検証が出す)。
    // 順は 2 つ以上でないと進めないので、それだけはここで知らせる
    const taskOptions = isRecord(options.tasks) ? options.tasks : {};
    const cycleRaw = Array.isArray(taskOptions.cycle) ? taskOptions.cycle : null;
    const cycleMarks = [...new Set((cycleRaw ?? []).filter(isTaskMark))];
    if (cycleRaw !== null && cycleRaw.length < 2) {
        report('warning', 'option-invalid', 'markdag.tasks.cycle: クリックで進む順は、記号を 2 つ以上並べます', {
            at: locator.value(['markdag', 'tasks', 'cycle']),
            hint: "未完了と完了の行き来なら書かずに済みます。作業中を挟むなら [' ', '/', 'x'] と書きます",
        });
    }
    const taskCycle: TaskMark[] = cycleMarks.length >= 2 ? cycleMarks : [...DEFAULT_TASK_CYCLE];
    const dimRaw = Array.isArray(taskOptions.dim) ? { states: taskOptions.dim } : isRecord(taskOptions.dim) ? taskOptions.dim : {};
    const dimMode = (value: unknown): DimDisplayMode => (DIM_DISPLAY_MODES.includes(value as DimDisplayMode) ? (value as DimDisplayMode) : 'keep');
    const taskDim: TaskDimOptions = {
        states: [...new Set((Array.isArray(dimRaw.states) ? dimRaw.states : []).filter(isTaskMark).map(taskStateOf))],
        details: dimMode(dimRaw.details),
        tags: dimMode(dimRaw.tags),
    };
    // edgeHighlight: false と書いたときだけ、線をクリックしての強調を使えなくする
    const edgeHighlight = options.edgeHighlight !== false;
    const groupHighlight = options.groupHighlight !== false;

    // legend.display: false で凡例を出さない。一覧で項目を選ぶ (書かれた順ではなく、既定の並び順で出す)。
    // legend.position: 凡例を置く隅。どちらも、使えない値は指定なしとして扱う (診断はスキーマの検証が出す)
    const legendOptions = isRecord(options.legend) ? options.legend : {};
    const wanted = legendOptions.display;
    const legend = wanted === false ? [] : Array.isArray(wanted) ? DEFAULT_LEGEND.filter((item) => wanted.includes(item)) : DEFAULT_LEGEND;
    const legendPosition = LEGEND_POSITIONS.find((position) => position === legendOptions.position) ?? 'top-right';

    // branches: 色を分ける単位を、著者が起点のノードで指定する。起点の配下は起点の色になり、起点の中の起点はそこから別の色になる。
    // 書かれていないノードには色を付けない (このキーのない文書は、今までどおり colorFreezeLevel で色が決まる)
    const branches: number[] = [];
    // 同じ表記の重なりはスキーマが拾うので、ここでは別の表記で同じノードを指した場合だけを警告にする
    const branchOf = new Map<number, string>();
    const items: unknown[] = Array.isArray(options.branches) ? options.branches : [];
    for (const [index, item] of items.entries()) {
        // 文字列でない要素と空の要素はスキーマが警告にしているので、同じ誤りを二重に出さない
        if (typeof item !== 'string' || item.trim() === '') continue;
        const branchPlace = (ref?: string | null): SourcePosition | null => locator.value(['markdag', 'branches', index], ref);
        try {
            const selector = resolver.parseSelector(item);
            if (selector.scope !== 'self') {
                throw new SelectorError(
                    'option-invalid',
                    `「${item}」は 1 ノードの指定ではありません。枝の起点は 1 ノードで指定します ((X), /*, /** は使えません)`,
                    item,
                    `配下をまとめて 1 色にするなら「${selector.ref}」だけを書きます (配下は起点の色を引き継ぎます)`,
                );
            }
            const id = resolver.resolveRef(selector.ref);
            const written = branchOf.get(id);
            // 同じ表記の 2 度書きはスキーマが拾うので、ここでは黙って読み飛ばす
            if (written === item) continue;
            if (written !== undefined) {
                throw new SelectorError('option-invalid', `「${item}」は「${written}」と同じノードで、すでに枝の起点になっています`, item, 'この行は消せます');
            }
            branchOf.set(id, item);
            branches.push(id);
        } catch (error) {
            if (!(error instanceof SelectorError)) throw error;
            report('warning', error.code, `markdag.branches: ${error.message}`, { at: branchPlace(error.ref), hint: error.hint });
        } finally {
            reportPrefixMatches('markdag.branches', branchPlace);
        }
    }

    return {
        detailsMode,
        legend,
        legendPosition,
        edgeHighlight,
        groupHighlight,
        branches,
        relations,
        suppressRootLine,
        groups,
        groupsOf,
        tagDisplay,
        tagsOf,
        tagKeys: resolved.keys,
        taskCycle,
        taskDim,
        hooks: { hooks: allHooks, options: hooks.options },
        diagnostics,
    };
}

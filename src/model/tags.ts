// タグの型と検査 (linter)。frontmatter の markdag.types (名前付きの型) と markdag.tags.keys (キーごとの定義) を、
// キーごとに「基底の型 + 重ねた制約」の平らな形に解決し、本文のタグをそれに当てて診断の元 (issue) を出す。
// 編集側に候補を出す関数もここに置く。DOM にも frontmatter の位置の解決にも依存せず、入力は JSON で表せる値だけにする
// (将来サーバー側に移せるようにするため)。frontmatter の中の位置は、呼び出し側が path から引く。
import type { NodeTag, OutlineNode, SourcePosition } from '../parse/document';
import { closest, isRecord } from './util';

export const PRIMITIVES = ['string', 'number', 'integer', 'boolean', 'enum', 'date', 'datetime', 'time', 'duration', 'nodeId'] as const;
export type Primitive = (typeof PRIMITIVES)[number];

// 1 つの値の形。基底の型と、その型に効く制約を重ねたもの
export interface TagValueType {
    primitive: Primitive;
    values?: string[];
    patterns?: string[];
    minLength?: number;
    maxLength?: number;
    min?: number | string;
    max?: number | string;
}

// キー 1 つの、解決済みの定義。値はどれかの形に合えば通る
export interface TagKeyDef {
    key: string;
    alternatives: TagValueType[];
    multiple: boolean;
    unique: boolean;
    description: string | null;
}

// frontmatter の中での場所を指す道すじ。文字はマップのキー、数はならびの添字
export type SourcePath = Array<string | number>;

// 型の定義の出どころ 1 つ。文書の frontmatter なら path があり、$ref で読んだファイルなら path は null で label がファイル名
export interface TypeSource {
    label: string;
    defs: Record<string, unknown>;
    path: SourcePath | null;
}

export interface TagIssue {
    severity: 'warning' | 'error' | 'info';
    code: string;
    message: string;
    hint: string | null;
    // frontmatter の中の場所 (呼び出し側が位置に直す)
    path: SourcePath | null;
    // 本文のタグの位置
    at: SourcePosition | null;
}

export interface TagLintOptions {
    severity: 'warning' | 'error';
    unknownKey: 'allow' | 'deny';
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DURATION = /^(\d+(?:\.\d+)?)([mhdw])$/;
const NODE_ID = /^\$[A-Za-z][A-Za-z0-9_-]*$/;
const DURATION_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 };

// 制約ごとに、それが効く基底の型
const CONSTRAINT_TARGETS: Record<string, Primitive[]> = {
    values: ['enum'],
    pattern: ['string'],
    minLength: ['string'],
    maxLength: ['string'],
    min: ['number', 'integer', 'date', 'datetime', 'time', 'duration'],
    max: ['number', 'integer', 'date', 'datetime', 'time', 'duration'],
};

const isPrimitive = (name: string): name is Primitive => (PRIMITIVES as readonly string[]).includes(name);

function validDate(year: number, month: number, day: number): boolean {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// 値がその型の書き方に合っているか (範囲と enum の候補は見ない)
function wellFormed(primitive: Primitive, value: string): boolean {
    switch (primitive) {
        case 'string':
        case 'enum':
            return true;
        case 'number':
            return NUMBER.test(value) && Number.isFinite(Number(value));
        case 'integer':
            return INTEGER.test(value);
        case 'boolean':
            return value === 'true' || value === 'false';
        case 'date': {
            const match = DATE.exec(value);
            return match !== null && validDate(Number(match[1]), Number(match[2]), Number(match[3]));
        }
        case 'datetime': {
            const match = DATETIME.exec(value);
            if (!match) return false;
            const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
            const zone = match[7] ?? 'Z';
            const [zoneHour, zoneMinute] = zone === 'Z' ? [0, 0] : zone.slice(1).split(':').map(Number);
            return validDate(Number(match[1]), Number(match[2]), Number(match[3])) && hour < 24 && minute < 60 && second < 60 && (zoneHour ?? 0) < 24 && (zoneMinute ?? 0) < 60;
        }
        case 'time': {
            const match = TIME.exec(value);
            return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
        }
        case 'duration':
            return DURATION.test(value);
        case 'nodeId':
            return NODE_ID.test(value);
    }
}

// 範囲の比較に使う数。書き方に合っていない値では null
function ordinal(primitive: Primitive, value: string | number): number | null {
    if (typeof value === 'number') return primitive === 'number' || primitive === 'integer' ? value : null;
    if (!wellFormed(primitive, value)) return null;
    switch (primitive) {
        case 'number':
        case 'integer':
            return Number(value);
        case 'date': {
            const match = DATE.exec(value);
            return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
        }
        case 'datetime': {
            const match = DATETIME.exec(value);
            if (!match) return null;
            const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));
            const zone = match[7];
            if (!zone || zone === 'Z') return base;
            const [hour = 0, minute = 0] = zone.slice(1).split(':').map(Number);
            return base - (zone.startsWith('-') ? -1 : 1) * (hour * 60 + minute) * 60000;
        }
        case 'time': {
            const match = TIME.exec(value);
            return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) : null;
        }
        case 'duration': {
            const match = DURATION.exec(value);
            return match ? Number(match[1]) * (DURATION_MINUTES[match[2] ?? 'm'] ?? 1) : null;
        }
        default:
            return null;
    }
}

// 型の書き方の説明 (診断の文面に使う)
const FORMS: Record<Primitive, string> = {
    string: '文字列',
    number: '数値',
    integer: '整数',
    boolean: 'true か false のどちらか',
    enum: '決まった値',
    date: 'YYYY-MM-DD の日付',
    datetime: 'YYYY-MM-DDTHH:MM の日時 (秒と時差は任意)',
    time: 'HH:MM の時刻',
    duration: '30m / 2h / 3d / 1w のような期間',
    nodeId: '$名前 (行末に $名前 を付けたノード)',
};

function describe(type: TagValueType): string {
    if (type.primitive === 'enum') return `${(type.values ?? []).join(' / ')} のどれか`;
    const limits: string[] = [];
    if (type.patterns) limits.push(`${type.patterns.map((pattern) => `「${pattern}」`).join(' と ')} に合う`);
    if (type.minLength !== undefined) limits.push(`${type.minLength} 文字以上`);
    if (type.maxLength !== undefined) limits.push(`${type.maxLength} 文字以下`);
    if (type.min !== undefined) limits.push(`${type.min} 以上`);
    if (type.max !== undefined) limits.push(`${type.max} 以下`);
    return limits.length === 0 ? FORMS[type.primitive] : `${FORMS[type.primitive]} (${limits.join('、')})`;
}

// タグを本文に書いた形に戻す。空白や , を含む値は " で囲む
export function formatTag({ key, values }: Pick<NodeTag, 'key' | 'values'>): string {
    if (values.length === 0) return `#${key}`;
    return `#${key}:${values.map((value) => (/[\s,"]/.test(value) ? `"${value}"` : value)).join(',')}`;
}

interface NamedType {
    def: Record<string, unknown>;
    path: SourcePath | null;
    label: string;
}

// 定義の置き場所 1 つ (名前付きの型か、キーのインラインの定義)
interface Place {
    path: SourcePath | null;
    label: string;
}

// frontmatter の types と tags.keys を、キーごとの平らな定義に解決する。
// refsUnresolved は、$ref を読めなかったときに真にする。読めなかったファイルがどの名前を上書きするか分からないので、
// 名前で指した型は (知っている名前でも) 黙って捨て、そのキーは検査しない。組み込みの型を直接書いたキーは検査する
export function resolveTagKeys(sources: TypeSource[], rawKeys: Record<string, unknown>, keysPath: SourcePath, refsUnresolved: boolean): { keys: TagKeyDef[]; issues: TagIssue[] } {
    const issues: TagIssue[] = [];
    const warn = (code: string, message: string, hint: string | null, path: SourcePath | null): void => {
        issues.push({ severity: 'warning', code, message, hint, path, at: null });
    };

    // 出どころの順に重ねる。あとの出どころが同じ名前を上書きする
    const named = new Map<string, NamedType>();
    for (const source of sources) {
        for (const [name, raw] of Object.entries(source.defs)) {
            const path = source.path ? [...source.path, name] : null;
            const label = source.path ? [...source.path, name].join('.') : `${source.label} の ${name}`;
            if (name === '$ref') {
                // 参照は文書の frontmatter にだけ書ける。読んだファイルの中の $ref は追わない
                if (source.path === null) warn('type-invalid', `${source.label} の中の $ref は読みません (参照は文書の frontmatter にだけ書けます)`, 'ファイルには型の定義だけを書きます', null);
                continue;
            }
            if (isPrimitive(name)) {
                warn('type-reserved', `${label} は組み込みの型と同じ名前なので定義できません`, '別の名前にします', path);
                continue;
            }
            if (!isRecord(raw)) {
                // 文書の中の形の誤りはスキーマが知らせている。ファイルの中のものは、ここでしか気づけない
                if (source.path === null) warn('type-invalid', `${label} は、type と制約をキーと値の組で書きます`, null, null);
                continue;
            }
            named.set(name, { def: raw, path, label });
        }
    }

    // 型の指定 (名前 1 つか一覧) を、基底の型と制約の一覧に解決する。chain は自分に戻る参照を見つけるため
    const resolveSpec = (spec: unknown, chain: string[], place: Place): TagValueType[] => {
        const names = spec === undefined || spec === null ? ['string'] : Array.isArray(spec) ? spec : [spec];
        const alternatives: TagValueType[] = [];
        for (const name of names) {
            if (typeof name !== 'string') {
                if (place.path === null) warn('type-invalid', `${place.label} の type は型の名前を文字列で書きます`, null, null);
                continue;
            }
            if (isPrimitive(name)) {
                alternatives.push({ primitive: name });
                continue;
            }
            if (refsUnresolved) continue;
            const found = named.get(name);
            if (!found) {
                const near = closest(name, [...PRIMITIVES, ...named.keys()]);
                warn('type-unknown', `${place.label} の型「${name}」は、組み込みの型にも markdag.types にもありません`, near === null ? `組み込みの型は ${PRIMITIVES.join(', ')} です` : `もしかして「${near}」`, place.path ? [...place.path, 'type'] : null);
                continue;
            }
            if (chain.includes(name)) {
                warn('type-cycle', `型「${name}」の定義が自分自身に戻っています (${[...chain, name].join(' → ')})`, '型の type には、自分より基底の型を書きます', found.path ? [...found.path, 'type'] : null);
                continue;
            }
            alternatives.push(...applyConstraints(found.def, resolveSpec(found.def.type, [...chain, name], found), found));
        }
        return alternatives;
    };

    // 定義に書かれた制約を、それが効く型に重ねる。効く型が 1 つもなければ知らせて捨てる
    const applyConstraints = (def: Record<string, unknown>, base: TagValueType[], place: Place): TagValueType[] => {
        const result = base.map((type) => ({ ...type, values: type.values && [...type.values], patterns: type.patterns && [...type.patterns] }));
        for (const [constraint, targets] of Object.entries(CONSTRAINT_TARGETS)) {
            const value = def[constraint];
            if (value === undefined || value === null) continue;
            const at = place.path ? [...place.path, constraint] : null;
            const applicable = result.filter((type) => targets.includes(type.primitive) && boundFits(constraint, type.primitive, value));
            if (applicable.length === 0) {
                const kinds = [...new Set(result.map((type) => type.primitive))];
                const wrongBound = (constraint === 'min' || constraint === 'max') && result.some((type) => targets.includes(type.primitive));
                warn(
                    'type-invalid',
                    wrongBound
                        ? `${place.label} の ${constraint} は、${kinds.join(', ')} の型では${kinds.some((kind) => kind === 'number' || kind === 'integer') ? '数値' : 'その型と同じ書き方の文字列'}で書きます`
                        : `${place.label} の ${constraint} は ${targets.join(', ')} の型にだけ書けます (この型は ${kinds.join(', ') || 'なし'})`,
                    null,
                    at,
                );
                continue;
            }
            if (constraint === 'pattern' && typeof value === 'string') {
                try {
                    new RegExp(value, 'u');
                } catch {
                    warn('type-invalid', `${place.label} の pattern「${value}」は正規表現として読めません`, 'JavaScript の正規表現の文法で書きます', at);
                    continue;
                }
            }
            for (const type of applicable) stack(type, constraint, value);
        }
        return result;
    };

    const keys: TagKeyDef[] = [];
    for (const [key, raw] of Object.entries(rawKeys)) {
        const def = isRecord(raw) ? raw : {};
        const place: Place = { path: [...keysPath, key], label: [...keysPath, key].join('.') };
        const alternatives = applyConstraints(def, resolveSpec(def.type, [], place), place).filter((type) => {
            if (type.primitive !== 'enum' || (type.values && type.values.length > 0)) return true;
            warn('type-invalid', `${place.label} は enum なので values (許す値の一覧) が要ります`, 'values: の下に、許す値を「- high」の形で 1 行ずつ並べます', [...place.path ?? [], 'values']);
            return false;
        });
        keys.push({
            key,
            alternatives,
            multiple: def.multiple === true,
            unique: def.unique === true,
            description: typeof def.description === 'string' ? def.description : null,
        });
    }
    return { keys, issues };
}

// min と max は、number と integer には数値、日付や時間にはその型の書き方の文字列だけが効く
function boundFits(constraint: string, primitive: Primitive, value: unknown): boolean {
    if (constraint !== 'min' && constraint !== 'max') return true;
    if (primitive === 'number' || primitive === 'integer') return typeof value === 'number';
    return typeof value === 'string' && wellFormed(primitive, value);
}

// 制約を重ねる。狭める方向にだけ効き、values は置き換える
function stack(type: TagValueType, constraint: string, value: unknown): void {
    if (constraint === 'values' && Array.isArray(value)) type.values = value.map(String);
    else if (constraint === 'pattern' && typeof value === 'string') type.patterns = [...(type.patterns ?? []), value];
    else if (constraint === 'minLength' && typeof value === 'number') type.minLength = Math.max(type.minLength ?? value, value);
    else if (constraint === 'maxLength' && typeof value === 'number') type.maxLength = Math.min(type.maxLength ?? value, value);
    else if ((constraint === 'min' || constraint === 'max') && (typeof value === 'number' || typeof value === 'string')) {
        const current = type[constraint];
        const next = ordinal(type.primitive, value) ?? 0;
        const known = current === undefined ? null : (ordinal(type.primitive, current) ?? 0);
        const tighter = known === null || (constraint === 'min' ? next > known : next < known);
        if (tighter) type[constraint] = value;
    }
}

interface Rejection {
    reason: string;
    hint: string | null;
}

// 値が 1 つの形に合わない理由。合えば null
function reject(type: TagValueType, value: string, nodes: OutlineNode[]): Rejection | null {
    const { primitive } = type;
    if (primitive === 'enum') {
        const values = type.values ?? [];
        if (values.includes(value)) return null;
        const near = closest(value, values);
        return { reason: `${values.join(' / ')} のどれかで書きます`, hint: near === null ? null : `もしかして「${near}」` };
    }
    if (primitive === 'string') {
        for (const pattern of type.patterns ?? []) {
            if (!new RegExp(pattern, 'u').test(value)) return { reason: `「${pattern}」の形に合いません`, hint: null };
        }
        const length = [...value].length;
        if (type.minLength !== undefined && length < type.minLength) return { reason: `${type.minLength} 文字以上で書きます`, hint: null };
        if (type.maxLength !== undefined && length > type.maxLength) return { reason: `${type.maxLength} 文字以下で書きます`, hint: null };
        return null;
    }
    if (!wellFormed(primitive, value)) return { reason: `${FORMS[primitive]}で書きます`, hint: null };
    if (primitive === 'nodeId') {
        const found = nodes.filter((node) => node.refId === value.slice(1));
        if (found.length === 1) return null;
        if (found.length === 0) {
            const near = closest(value, nodes.flatMap((node) => (node.refId === null ? [] : [`$${node.refId}`])));
            return { reason: `${value} を持つノードがありません`, hint: near === null ? '行末に $名前 を付けたノードを指します' : `もしかして「${near}」` };
        }
        return { reason: `${value} を持つノードが ${found.length} 個あります`, hint: '同じ $id を 2 つ以上のノードに書かないようにします' };
    }
    const position = ordinal(primitive, value);
    if (position !== null) {
        const low = type.min === undefined ? null : ordinal(primitive, type.min);
        const high = type.max === undefined ? null : ordinal(primitive, type.max);
        if (low !== null && position < low) return { reason: `${type.min} 以上で書きます`, hint: null };
        if (high !== null && position > high) return { reason: `${type.max} 以下で書きます`, hint: null };
    }
    return null;
}

// 本文のタグを、解決済みのキーの定義に当てる。定義のないキーは unknownKey が deny のときだけ知らせる
export function lintTags(nodes: OutlineNode[], keys: TagKeyDef[], options: TagLintOptions): TagIssue[] {
    const issues: TagIssue[] = [];
    const byKey = new Map(keys.map((def) => [def.key, def]));
    const report = (code: string, message: string, hint: string | null, at: SourcePosition): void => {
        issues.push({ severity: options.severity, code, message, hint, path: null, at });
    };
    // unique のキーの、値ごとの出現
    const seen = new Map<string, Array<{ node: OutlineNode; tag: NodeTag }>>();

    for (const node of nodes) {
        for (const tag of node.tags) {
            const name = `「${node.refText}」の ${formatTag(tag)}`;
            const def = byKey.get(tag.key);
            if (!def) {
                if (options.unknownKey === 'deny') {
                    const near = closest(tag.key, [...byKey.keys()]);
                    report('tag-unknown-key', `${name} は、markdag.tags.keys に定義のないキーです`, near === null ? 'keys に定義するか、unknownKey を allow にします' : `もしかして「${near}」`, tag.at);
                }
                continue;
            }
            // 型を解決できなかったキーは検査しない (理由は解決のときに知らせている)
            if (def.alternatives.length === 0) continue;
            if (tag.values.length === 0) {
                if (!def.alternatives.some((type) => type.primitive === 'boolean')) {
                    report('tag-missing-value', `${name} には値が要ります (${def.alternatives.map(describe).join('、')})`, `#${tag.key}:値 の形で書きます`, tag.at);
                }
                continue;
            }
            if (tag.values.length > 1 && !def.multiple) {
                report('tag-multiple', `${name} は値を 1 つだけ書くキーです`, `複数の値を許すなら markdag.tags.keys.${tag.key} に multiple: true を書きます`, tag.at);
            }
            for (const value of tag.values) {
                const rejections = def.alternatives.map((type) => reject(type, value, nodes));
                if (rejections.every((rejection) => rejection !== null)) {
                    const [first] = rejections;
                    const single = def.alternatives.length === 1 && first;
                    report(
                        'tag-type',
                        single ? `${name}: ${first.reason}` : `${name} の「${value}」は ${def.alternatives.map(describe).join('、')} のどれにも合いません`,
                        rejections.find((rejection) => rejection?.hint)?.hint ?? null,
                        tag.at,
                    );
                }
                if (def.unique) {
                    const slot = `${tag.key}\u0000${value}`;
                    seen.set(slot, [...(seen.get(slot) ?? []), { node, tag }]);
                }
            }
        }
    }

    // 同じ値が複数のノードにあれば、すべての箇所に知らせ、ほかの箇所の行を添える
    for (const entries of seen.values()) {
        if (entries.length < 2) continue;
        for (const entry of entries) {
            const others = entries.filter((other) => other !== entry).map((other) => `${other.tag.at.line} 行目`);
            report('tag-unique', `「${entry.node.refText}」の ${formatTag(entry.tag)} は、ほかのノードにも書かれています (${others.join('、')})`, 'unique のキーなので、値を変えるか片方を消します', entry.tag.at);
        }
    }
    return issues;
}

// 編集側の候補: キーの名前 (入力途中の文字で絞る)
export function suggestTagKeys(keys: TagKeyDef[], prefix = ''): Array<{ key: string; description: string | null }> {
    return keys.filter((def) => def.key.startsWith(prefix)).map(({ key, description }) => ({ key, description }));
}

// 編集側の候補: そのキーの値。enum の values と boolean の true / false だけが候補になる
export function suggestTagValues(keys: TagKeyDef[], key: string, prefix = ''): string[] {
    const def = keys.find((item) => item.key === key);
    if (!def) return [];
    const candidates = def.alternatives.flatMap((type) => (type.primitive === 'enum' ? (type.values ?? []) : type.primitive === 'boolean' ? ['true', 'false'] : []));
    return [...new Set(candidates)].filter((value) => value.startsWith(prefix));
}

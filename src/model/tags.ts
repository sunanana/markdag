// タグの型と検査 (linter) の包み。markdag.types と markdag.tags.keys の解決と本文のタグの検査は Rust (build_model の中) が行う。
// ここには公開の型と、編集側に候補を出す関数 (Rust を呼ぶ) と、タグを本文の形に戻す formatTag (JS の写し) を置く。
// formatTag は view がノードごと・タグごとに呼ぶので、wasm を呼ばない写しにする (設計文書 (b) の N+1 を避ける行)
import type { NodeTag, SourcePosition } from '../parse/document';
import { callJson } from '../wasm/boundary';

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

// タグを本文に書いた形に戻す。空白や , を含む値は " で囲む (Rust の format_tag と同じ)
export function formatTag({ key, values }: Pick<NodeTag, 'key' | 'values'>): string {
    if (values.length === 0) return `#${key}`;
    return `#${key}:${values.map((value) => (/[\s,"]/.test(value) ? `"${value}"` : value)).join(',')}`;
}

// 編集側の候補: キーの名前 (入力途中の文字で絞る)
export function suggestTagKeys(keys: TagKeyDef[], prefix = ''): Array<{ key: string; description: string | null }> {
    return callJson<Array<{ key: string; description: string | null }>>('suggest_tag_keys', { tagKeys: keys, prefix });
}

// 編集側の候補: そのキーの値。enum の values と boolean の true / false だけが候補になる
export function suggestTagValues(keys: TagKeyDef[], key: string, prefix = ''): string[] {
    return callJson<string[]>('suggest_tag_values', { tagKeys: keys, key, prefix });
}

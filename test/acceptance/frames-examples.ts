// グループの枠の受け入れの例 (testdata/acceptance/frames/) を読む道具。vitest と playwright の両方から使う (Node の側だけで動く)。
// 例のファイルは読むだけで書き換えない。期待はテストのコードに写さず、expect.yaml から読む。
// 照らし方は例を書き起こした道具と同じ定義: オブジェクトは期待に書いた欄だけ、配列は全体 (長さと並び) を比べる。
// 照合は「食い違いの一覧」を返し、どちらの試験の道具でも expect(problems).toEqual([]) で落とせるようにする。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// MARKDAG_FRAMES_ACCEPTANCE で別の置き場 (例を写して期待を変えた一時の置き場など) を指せる。試験が見ていない欄がないかを確かめるため
export const ACCEPTANCE_ROOT = process.env.MARKDAG_FRAMES_ACCEPTANCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../testdata/acceptance/frames');

export type Surface = 'library' | 'screen' | 'standalone';

export interface FramesExample {
    id: string;
    surface: Surface;
    name: string;
    dir: string;
    input: string;
    spec: Record<string, any>;
}

export function listExamples(surface: Surface): FramesExample[] {
    const base = join(ACCEPTANCE_ROOT, surface);
    return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'expect.yaml')))
        .map((entry) => entry.name)
        .sort()
        .map((name) => {
            const dir = join(base, name);
            return {
                id: `${surface}/${name}`,
                surface,
                name,
                dir,
                input: readFileSync(join(dir, 'input.md'), 'utf8'),
                spec: (parseYaml(readFileSync(join(dir, 'expect.yaml'), 'utf8')) ?? {}) as Record<string, any>,
            };
        });
}

export function readExampleFile(example: FramesExample, relative: string): string {
    const path = resolve(example.dir, relative);
    if (!existsSync(path)) throw new Error(`${example.id}: ${relative} がない`);
    return readFileSync(path, 'utf8');
}

// 例の説明の欄 (kind、checks、combos、decisions、status) と、機械で判定しない欄 (look) はテストにしない
export const SPEC_KEYS = ['kind', 'checks', 'combos', 'decisions', 'status', 'look', 'call', 'render', 'steps', 'expect'] as const;
export const CALL_KEYS = ['api', 'actions', 'cli', 'state_folded'] as const;
export const LIBRARY_EXPECT_KEYS = ['diagnostics', 'visible', 'frames', 'unframed', 'overlap', 'intrusions', 'sides', 'edges', 'clearance'] as const;

// 知らない欄が期待にあれば落とす (新しい欄を黙って見逃さないため)
export function unknownKeys(values: Record<string, unknown> | undefined, known: readonly string[], label: string): string[] {
    const extra = Object.keys(values ?? {}).filter((key) => !known.includes(key));
    return extra.length === 0 ? [] : [`${label}: テストが読まない欄がある: ${extra.join(', ')}`];
}

// 長さを比べるときに許す誤差 (測り方の 0.5px と同じ)。数は整数なので、数を比べるときには効かない
const TOLERANCE = 0.5;

// 期待 (expect) の各欄が測った値に含まれるか。オブジェクトは書いた欄だけ、配列は全体を比べる。message_has は message の一部。
// 名前が _min で終わる欄は下限: 末尾を除いた欄の測った値が、期待 − 許す誤差以上であること (right_min は right を見る)
export function compare(expected: unknown, actual: unknown, path: string, problems: string[] = []): string[] {
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual) || actual.length !== expected.length) {
            problems.push(`${path}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
            return problems;
        }
        expected.forEach((item, index) => compare(item, actual[index], `${path}[${index}]`, problems));
        return problems;
    }
    if (expected !== null && typeof expected === 'object') {
        if (actual === null || typeof actual !== 'object') {
            problems.push(`${path}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
            return problems;
        }
        const record = actual as Record<string, unknown>;
        for (const [key, value] of Object.entries(expected)) {
            if (key === 'message_has') {
                if (!String(record.message ?? '').includes(String(value))) problems.push(`${path}.message: 「${value}」を含まない (${record.message})`);
                continue;
            }
            if (key.endsWith('_min') && typeof value === 'number') {
                const base = key.slice(0, -'_min'.length);
                const got = record[base];
                if (typeof got !== 'number' || got < value - TOLERANCE) problems.push(`${path}.${base}: 期待 ${value} 以上 / 実際 ${JSON.stringify(got)}`);
                continue;
            }
            compare(value, record[key], `${path}.${key}`, problems);
        }
        return problems;
    }
    if (typeof expected === 'number' && typeof actual === 'number') {
        if (Math.abs(expected - actual) > TOLERANCE) problems.push(`${path}: 期待 ${expected} / 実際 ${actual}`);
        return problems;
    }
    if (expected !== actual) problems.push(`${path}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
    return problems;
}

// 公開の Diagnostic を期待の形 (code、severity、at は「行:桁+長さ」、message) にする
export interface DiagnosticLike {
    code: string;
    severity: string;
    message: string;
    at: { line: number; column: number; length: number } | null;
}

export const diagnosticsOf = (list: readonly DiagnosticLike[]): Array<{ code: string; severity: string; at: string | null; message: string }> =>
    list.map((item) => ({ code: item.code, severity: item.severity, at: item.at ? `${item.at.line}:${item.at.column}+${item.at.length}` : null, message: item.message }));

// ノードの名前は refText。同じ refText が 2 つ以上あれば「親/子」 (ページの中の測り方と同じ定義)
export interface NamedNode {
    id: number;
    parent: number | null;
    refText: string;
}

export function namer(nodes: readonly NamedNode[]): { name: (id: number) => string; idOf: (text: string) => number | undefined } {
    const count = new Map<string, number>();
    for (const node of nodes) count.set(node.refText, (count.get(node.refText) ?? 0) + 1);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const name = (id: number): string => {
        const node = byId.get(id);
        if (!node) return `#${id}`;
        if (count.get(node.refText) === 1) return node.refText;
        const parent = node.parent === null ? undefined : byId.get(node.parent);
        return parent ? `${parent.refText}/${node.refText}` : node.refText;
    };
    const idOf = (text: string): number | undefined => nodes.find((node) => name(node.id) === text)?.id;
    return { name, idOf };
}

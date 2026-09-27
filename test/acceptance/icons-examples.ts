// アイコン機能の受け入れの例 (testdata/acceptance/icons/) を読む道具。vitest と playwright の両方から使う (Node の側だけで動く)。
// 例のファイルは読むだけで書き換えない。期待はテストのコードに写さず、expect.yaml から読む。
// 期待の照合は「食い違いの一覧」を返す形にして、どちらの試験の道具でも expect(problems).toEqual([]) で落とせるようにする。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// 例の置き場。MARKDAG_ICONS_ACCEPTANCE で別の場所 (例を写して期待を変えた一時の置き場など) を指せる。試験が何も見ていない欄がないかを確かめるため
export const ACCEPTANCE_ROOT = process.env.MARKDAG_ICONS_ACCEPTANCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../testdata/acceptance/icons');

export type Surface = 'library' | 'cli' | 'screen';

export interface IconExample {
    id: string;
    surface: Surface;
    name: string;
    dir: string;
    input: string;
    spec: Record<string, any>;
}

export function listExamples(surface: Surface): IconExample[] {
    const base = join(ACCEPTANCE_ROOT, surface);
    return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'expect.yaml')))
        .map((entry) => entry.name)
        .sort()
        .map((name) => {
            const dir = join(base, name);
            const inputPath = join(dir, 'input.md');
            return {
                id: `${surface}/${name}`,
                surface,
                name,
                dir,
                input: existsSync(inputPath) ? readFileSync(inputPath, 'utf8') : '',
                spec: (parseYaml(readFileSync(join(dir, 'expect.yaml'), 'utf8')) ?? {}) as Record<string, any>,
            };
        });
}

export const readExampleFile = (example: IconExample, relative: string): string | null => {
    const path = resolve(example.dir, relative);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

// 文書の frontmatter を、試験対象の解析を通さずに読む ($ref の一覧を知るため)
export function frontmatterOf(markdown: string): Record<string, any> {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
    return match ? ((parseYaml(match[1] ?? '') ?? {}) as Record<string, any>) : {};
}

// markdag.icons.$ref に書いた文字列をキーに、例のディレクトリからの相対で YAML を読んだ値 (読めなければ null)
export function iconRefsOf(example: IconExample): Record<string, unknown> {
    const declared = frontmatterOf(example.input)?.markdag?.icons?.$ref;
    const refs: string[] = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((item): item is string => typeof item === 'string') : [];
    const loaded: Record<string, unknown> = {};
    for (const ref of refs) {
        const text = readExampleFile(example, ref);
        loaded[ref] = text === null ? null : (parseYaml(text) ?? null);
    }
    return loaded;
}

// call.icons の欄が「渡さない」で始まれば渡さない。それ以外は $ref の中身を読んで渡す
export const passesIcons = (example: IconExample): boolean => {
    const text = example.spec.call?.icons;
    return !(typeof text === 'string' && text.startsWith('渡さない'));
};

// ---- resolver の欄 ----

// ページへ渡せる形にした resolveIcon の振る舞い。content は SVG の中身か文字列 (null は null を返す)
export type ResolverBehavior =
    | { how: 'sync'; content: string | null }
    | { how: 'promise'; content: string | null; delay: number }
    | { how: 'reject'; reason: string }
    | { how: 'throw'; reason: string };

const isSvgPath = (value: string): boolean => value.endsWith('.svg');

function behaviorOf(example: IconExample, value: unknown): ResolverBehavior {
    const contentOf = (item: unknown): string | null => {
        if (item === null || item === undefined) return null;
        const text = String(item);
        if (!isSvgPath(text)) return text;
        const content = readExampleFile(example, text);
        if (content === null) throw new Error(`${example.id}: resolver のファイル ${text} がない`);
        return content;
    };
    if (value === null || typeof value === 'string') return { how: 'sync', content: contentOf(value) };
    const spec = value as Record<string, unknown>;
    if ('sync' in spec) return { how: 'sync', content: contentOf(spec.sync) };
    if ('promise' in spec) return { how: 'promise', content: contentOf(spec.promise), delay: typeof spec.delay_ms === 'number' ? spec.delay_ms : 0 };
    if ('reject' in spec) return { how: 'reject', reason: String(spec.reject) };
    if ('throw' in spec) return { how: 'throw', reason: String(spec.throw) };
    throw new Error(`${example.id}: resolver の振る舞いを読めない: ${JSON.stringify(value)}`);
}

// call.resolver (library) か render.resolver (screen) を、ref → 振る舞いにする。"*" はそのまま残す
export function resolverOf(example: IconExample): Record<string, ResolverBehavior> | null {
    const spec = (example.spec.call?.resolver ?? example.spec.render?.resolver ?? null) as Record<string, unknown> | null;
    if (spec === null) return null;
    return Object.fromEntries(Object.entries(spec).map(([ref, value]) => [ref, behaviorOf(example, value)]));
}

// ---- 照合 ----

export interface DiagnosticLike {
    severity: string;
    code: string;
    message: string;
    hint: string | null;
    at: { line: number; column: number; length: number } | null;
}

const asList = (value: unknown): string[] => (value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]);

function diagnosticMatches(actual: DiagnosticLike, expected: unknown): boolean {
    if (typeof expected === 'string') return actual.code === expected;
    const want = expected as Record<string, unknown>;
    for (const key of Object.keys(want)) if (!['code', 'severity', 'at', 'message_has', 'hint_has'].includes(key)) throw new Error(`診断の期待に知らない欄: ${key}`);
    if (want.code !== undefined && actual.code !== want.code) return false;
    if (want.severity !== undefined && actual.severity !== want.severity) return false;
    if ('at' in want) {
        const at = actual.at ? `${actual.at.line}:${actual.at.column}+${actual.at.length}` : null;
        if (at !== want.at) return false;
    }
    if (!asList(want.message_has).every((part) => actual.message.includes(part))) return false;
    if (!asList(want.hint_has).every((part) => (actual.hint ?? '').includes(part))) return false;
    return true;
}

// 診断の全件の照合 (件数も一致、順は問わない)。期待 1 件に実際の 1 件を割り当てられるかを後戻りつきで探す
export function matchDiagnostics(actual: DiagnosticLike[], expected: unknown[], label = 'diagnostics'): string[] {
    const fits = expected.map((want) => actual.map((item) => diagnosticMatches(item, want)));
    const used = new Set<number>();
    const assign = (index: number): boolean => {
        if (index === expected.length) return true;
        for (let candidate = 0; candidate < actual.length; candidate++) {
            if (used.has(candidate) || !fits[index]?.[candidate]) continue;
            used.add(candidate);
            if (assign(index + 1)) return true;
            used.delete(candidate);
        }
        return false;
    };
    if (actual.length === expected.length && assign(0)) return [];
    const shown = actual.map((item) => `${item.severity} ${item.code} ${item.at ? `${item.at.line}:${item.at.column}+${item.at.length}` : '位置なし'} ${item.message} / ${item.hint ?? ''}`);
    return [`${label}: 期待 ${JSON.stringify(expected)} に合わない。実際: ${JSON.stringify(shown)}`];
}

// 並びを問わない ref の一覧 (各 1 回)
export function matchAsked(actual: string[], expected: unknown, label: string): string[] {
    const want = asList(expected).sort();
    const got = [...actual].sort();
    return JSON.stringify(want) === JSON.stringify(got) ? [] : [`${label}: 期待 ${JSON.stringify(want)}、実際 ${JSON.stringify(got)}`];
}

// 期待の欄のうち、テストにしない欄 (機械で判定しない所と、例の説明)
export const NOT_CHECKED = new Set(['look', 'kind', 'checks']);

// 知らない欄が期待にあれば落とす (新しい欄を黙って見逃さないため)
export function unknownKeys(values: Record<string, unknown>, known: readonly string[], label: string): string[] {
    const extra = Object.keys(values).filter((key) => !known.includes(key));
    return extra.length === 0 ? [] : [`${label}: テストが読まない欄がある: ${extra.join(', ')}`];
}

// library の例の開き方。DOM を使う例 (render、createHookBridge + MarkdagView、単体 HTML を開く) はブラウザ (playwright) で回す
export type LibraryMode = 'model' | 'standalone-build' | 'render' | 'bridge' | 'standalone-open';

export function libraryModeOf(example: IconExample): LibraryMode {
    const api = String(example.spec.call?.api ?? '');
    if (api.includes('buildStandaloneHtml') && api.includes('開く')) return 'standalone-open';
    if (api.includes('buildStandaloneHtml')) return 'standalone-build';
    if (api.includes('createHookBridge')) return 'bridge';
    if (/\brender\(/.test(api)) return 'render';
    if (api.includes('parseDocument') && api.includes('buildModel')) return 'model';
    throw new Error(`${example.id}: call.api の開き方を読めない: ${api}`);
}

export const BROWSER_LIBRARY_MODES: readonly LibraryMode[] = ['render', 'bridge', 'standalone-open'];

// 単体 HTML の <script id="markdag-data" type="application/json"> の中身
export function embeddedDataOf(html: string): Record<string, unknown> {
    const raw = /<script id="markdag-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (raw === undefined) throw new Error('単体 HTML に素材の script がない');
    return JSON.parse(raw) as Record<string, unknown>;
}

// call.icons (単体 HTML に渡す ref → SVG) の欄を中身にする。.svg で終わる値は例のディレクトリからのファイル、それ以外は文字列そのもの
export function standaloneIconsOf(example: IconExample): Record<string, string> | undefined {
    const icons = example.spec.call?.icons;
    if (!icons || typeof icons !== 'object') return undefined;
    const result: Record<string, string> = {};
    for (const [ref, value] of Object.entries(icons as Record<string, unknown>)) {
        const text = String(value);
        const content = isSvgPath(text) ? readExampleFile(example, text) : text;
        if (content === null) throw new Error(`${example.id}: icons のファイル ${text} がない`);
        result[ref] = content;
    }
    return result;
}

// 編集の層 (markdag/editor) をあとで別のパッケージに切り出せるようにする決まりを、ソースのファイルを読むだけで確かめる。
// (a) 編集の層 (src/editor/ の下と入口 src/editor.ts) が読むのは、編集の層の中と markdag/core の入口 (src/core.ts) だけ。型の import も同じ
// (b) 本体の残り (src/ のほかのファイル) は編集の層を読まない (向きは編集の層 → 本体の一方だけ)
// (c) 編集の層は CSS を読まない (`.css` と `?inline` の指定子がない)
// (d) 編集の層の文字列にある mdag- で始まる語は、自分で作る要素 (mdag-editor と mdag-editor-*) か、公開の目印だけ
// ほかに package.json の exports (markdag/editor の入口) と、スタイルシートの編集の層の区画 (mdag-editor- の規則はそこだけ) を見る。
// 配布物 (dist/editor.js、dist/types/editor.d.ts、CDN の JS が入っていないこと) はビルドのあとにしかないので、e2e の側 (編集の層の土台のテスト) で見る
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const EDITOR_DIR = join(SRC, 'editor');
const EDITOR_ENTRY = join(SRC, 'editor.ts');
// markdag/core の入口 (拡張子を除いた形で比べる)
const CORE_ENTRY = join(SRC, 'core');

// 図の出口の公開の目印のうち、mdag- で始まるクラス (.mdag-node[data-selected]、.mdag-node[data-drop-target]、
// .mdag-tag[data-tag-key]、.mdag-popover[data-id]、.mdag-overlays)。.markdag[data-interaction] と [data-drag-to-pan] は mdag- の語を持たない
const PUBLIC_MARKERS = ['mdag-node', 'mdag-tag', 'mdag-popover', 'mdag-overlays'];

const EDITOR_SECTION = '/* ---- 編集の層 (markdag/editor) ---- */';

function tsFilesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .flatMap((name) => {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) return tsFilesUnder(path);
            return name.endsWith('.ts') ? [path] : [];
        })
        .sort();
}

const editorFiles = (): string[] => [...(existsSync(EDITOR_ENTRY) ? [EDITOR_ENTRY] : []), ...tsFilesUnder(EDITOR_DIR)];
const isEditorFile = (file: string): boolean => file === EDITOR_ENTRY || file.startsWith(EDITOR_DIR + sep);
const rel = (file: string): string => relative(ROOT, file).split(sep).join('/');

// コメントを除く。文字列とテンプレートの中の // と /* は残す (SVG の名前空間の URL など)。
// 引用符の文字列は行をまたがないので、正規表現の中の引用符で読み違えても、その行の終わりで戻る
function stripComments(code: string): string {
    let out = '';
    let index = 0;
    while (index < code.length) {
        const char = code[index];
        const next = code[index + 1];
        if (char === '/' && next === '/') {
            while (index < code.length && code[index] !== '\n') index += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            const end = code.indexOf('*/', index + 2);
            index = end < 0 ? code.length : end + 2;
            out += ' ';
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            let end = index + 1;
            while (end < code.length && code[end] !== char && (char === '`' || code[end] !== '\n')) end += code[end] === '\\' ? 2 : 1;
            out += code.slice(index, end + 1);
            index = end + 1;
            continue;
        }
        out += char;
        index += 1;
    }
    return out;
}

// import と export の指定子 (`from '...'`、`import '...'`、`import('...')`)。式の import は検められないので `<式: ...>` として返す
function specifiersOf(file: string): string[] {
    const code = stripComments(readFileSync(file, 'utf8'));
    const found: string[] = [];
    for (const match of code.matchAll(/\bfrom\s*(['"])([^'"\n]+)\1/g)) found.push(match[2] ?? '');
    for (const match of code.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) found.push(match[2] ?? '');
    for (const match of code.matchAll(/\bimport\s*\(\s*(?:(['"`])([^'"`\n]+)\1\s*[,)]|([^\s'"`)][^)\n]*))/g)) found.push(match[2] ?? `<式: ${match[3] ?? ''}>`);
    return found;
}

// 相対の指定子が指すファイル (拡張子と問い合わせを除いた絶対パス)。パッケージ名の指定子は null
function targetOf(file: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    return resolve(dirname(file), specifier.split('?')[0] ?? '').replace(/\.(ts|js|mjs)$/, '');
}

describe('編集の層の import の向き (design.md 1.4)', () => {
    it('編集の層のファイルがある (入口 src/editor.ts と src/editor/ の下)', () => {
        expect(existsSync(EDITOR_ENTRY)).toBe(true);
        expect(tsFilesUnder(EDITOR_DIR).length).toBeGreaterThan(0);
        // 入口は src/editor/ の下のファイルを読む (中身は src/editor/ に置く)
        expect(specifiersOf(EDITOR_ENTRY).some((specifier) => targetOf(EDITOR_ENTRY, specifier)?.startsWith(EDITOR_DIR + sep) === true)).toBe(true);
    });

    it('(a) 編集の層が読むのは、編集の層の中と markdag/core の入口 (src/core.ts) だけ。型の import とパッケージ名の指定子も同じ', () => {
        const files = editorFiles();
        expect(files.length).toBeGreaterThan(1);
        const all = files.flatMap((file) => specifiersOf(file).map((specifier) => ({ file, specifier })));
        expect(all.length).toBeGreaterThan(0);
        const outside = all
            .filter(({ file, specifier }) => {
                const target = targetOf(file, specifier);
                return target === null || !(target === CORE_ENTRY || target.startsWith(EDITOR_DIR + sep));
            })
            .map(({ file, specifier }) => `${rel(file)}: ${specifier}`);
        expect(outside).toEqual([]);
    });

    it('(b) src/ の残りのファイルは編集の層 (src/editor/ と src/editor.ts、markdag/editor) を読まない', () => {
        const others = tsFilesUnder(SRC).filter((file) => !isEditorFile(file));
        expect(others.length).toBeGreaterThan(0);
        const inward = others
            .flatMap((file) => specifiersOf(file).map((specifier) => ({ file, specifier })))
            .filter(({ file, specifier }) => {
                if (specifier === 'markdag/editor' || specifier.startsWith('markdag/editor/')) return true;
                const target = targetOf(file, specifier);
                return target !== null && (target === EDITOR_DIR || target.startsWith(EDITOR_DIR + sep));
            })
            .map(({ file, specifier }) => `${rel(file)}: ${specifier}`);
        expect(inward).toEqual([]);
    });

    it('(c) 編集の層に `.css` と `?inline` の指定子がない (見た目は本体のスタイルシートの区画に置く)', () => {
        const files = editorFiles();
        expect(files.length).toBeGreaterThan(1);
        const css = files
            .flatMap((file) => specifiersOf(file).map((specifier) => ({ file, specifier })))
            .filter(({ specifier }) => /\.css$/.test(specifier.split('?')[0] ?? '') || specifier.includes('?inline'))
            .map(({ file, specifier }) => `${rel(file)}: ${specifier}`);
        expect(css).toEqual([]);
    });

    it('(d) 編集の層の文字列にある mdag- で始まる語は、mdag-editor と mdag-editor-* か、公開の目印 (2.4 の表) だけ', () => {
        const files = editorFiles();
        expect(files.length).toBeGreaterThan(1);
        const words = files.flatMap((file) => [...stripComments(readFileSync(file, 'utf8')).matchAll(/(?<![A-Za-z0-9_$])mdag-[A-Za-z0-9-]*/g)].map((match) => ({ file, word: match[0] })));
        // セグメントと隅の入れ物の要素を作るので、語がないことはない
        expect(words.length).toBeGreaterThan(0);
        const allowed = (word: string): boolean => word === 'mdag-editor' || word.startsWith('mdag-editor-') || PUBLIC_MARKERS.includes(word);
        expect(words.filter(({ word }) => !allowed(word)).map(({ file, word }) => `${rel(file)}: ${word}`)).toEqual([]);
    });
});

describe('入口の公開とスタイルシートの区画 (design.md 1.4、6.1)', () => {
    it('package.json の exports に "./editor" がある (types、development、import、default の 4 つ。"./core" と同じ形)', () => {
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, Record<string, string> | string> };
        const editor = pkg.exports['./editor'];
        expect(editor).toEqual({ types: './dist/types/editor.d.ts', development: './dist/editor.dev.js', import: './dist/editor.js', default: './dist/editor.js' });
        // 条件の並び (types が先) も "./core" と同じ
        expect(Object.keys(editor as Record<string, string>)).toEqual(Object.keys(pkg.exports['./core'] as Record<string, string>));
    });

    it('編集の層の見た目は src/style.css の末尾の「編集の層」の区画にあり、区画の外に mdag-editor と data-editor- の規則がない (1.4 の 3、6.1)', () => {
        const lines = readFileSync(join(SRC, 'style.css'), 'utf8').split('\n');
        const starts = lines.flatMap((line, index) => (line.trim() === EDITOR_SECTION ? [index] : []));
        expect(starts).toHaveLength(1);
        const start = starts[0] ?? 0;
        const before = lines.slice(0, start).join('\n');
        expect(before.match(/mdag-editor|data-editor-/g) ?? []).toEqual([]);
        // 区画には編集の層の規則がある
        expect(lines.slice(start).join('\n')).toMatch(/\.mdag-editor\b/);
    });
});

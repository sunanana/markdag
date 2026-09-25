// markdag の文書を検査して、診断を 1 件 1 行の文字で出す。誤り (error) が 1 件でもあれば、終了コードを 1 にする。
// 解析とモデルの組み立ては wasm で動き DOM が要らないので、ビルド済みの ES モジュールの入口を Node で読み、init を待ってから使う。
// 診断は render が描く前に出すものと同じ組み立て (解析と組み立て、transformSource のフック、markdag のキーがない文書の知らせ) にする。
// 配置と描画は DOM が要るので行わない (描画の途中の例外はここでは見つからない)。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { parse as parseYaml } from 'yaml';

import type * as Markdag from '../src/index';

// frontmatter の markdag の下の $ref を、書かれた順に取り出す
function refsOf(markdown: string, key: 'types' | 'hooks'): string[] {
    const body = /^---\r?\n([\s\S]*?)\n---\r?\n/.exec(markdown)?.[1];
    let frontmatter: unknown;
    try {
        frontmatter = body === undefined ? undefined : parseYaml(body);
    } catch {
        return [];
    }
    const raw = (frontmatter as { markdag?: Record<string, { $ref?: unknown } | undefined> } | undefined)?.markdag?.[key]?.$ref;
    return typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

// markdag.types.$ref が指すファイルを、文書の場所からの相対で読む。
// ライブラリはファイルを読まないので、この CLI が読んで渡す。読めないものは null にして、ライブラリが警告にする
function loadTypeRefs(file: string, markdown: string): Record<string, unknown> {
    const loaded: Record<string, unknown> = {};
    for (const ref of refsOf(markdown, 'types')) {
        try {
            loaded[ref] = parseYaml(readFileSync(resolve(dirname(file), ref), 'utf8'));
        } catch {
            loaded[ref] = null;
        }
    }
    return loaded;
}

// markdag.hooks.$ref が指すモジュールの中身。文書が指すコードをそのまま実行することになるので、
// --hooks を付けたときだけ読む。付けなければ hookRefs を渡さず、ライブラリが hooks-unresolved を info で知らせる。
// TypeScript で書かれたものは vite の変換器 (oxc) で JavaScript にする (型の検査はしない。型だけの import は外れる)
async function loadHookSources(file: string, markdown: string): Promise<Array<{ ref: string; code: string | null }>> {
    const sources: Array<{ ref: string; code: string | null }> = [];
    for (const ref of refsOf(markdown, 'hooks')) {
        const path = resolve(dirname(file), ref);
        let text: string;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            sources.push({ ref, code: null });
            continue;
        }
        if (!/\.[cm]?tsx?$/.test(path)) {
            sources.push({ ref, code: text });
            continue;
        }
        try {
            sources.push({ ref, code: (await transformWithOxc(text, path)).code });
        } catch (error) {
            console.error(`フックを変換できませんでした: ${ref}: ${error instanceof Error ? error.message : String(error)}`);
            sources.push({ ref, code: null });
        }
    }
    return sources;
}

// フックのモジュールを読む。Node では data: の URL から import する (TypeScript は loadHookSources で JavaScript にしてある)
async function importHooks(sources: Array<{ ref: string; code: string | null }>): Promise<Record<string, unknown>> {
    const loaded: Record<string, unknown> = {};
    for (const { ref, code } of sources) {
        if (code === null) {
            loaded[ref] = null;
            continue;
        }
        try {
            loaded[ref] = { ...((await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<string, unknown>) };
        } catch (error) {
            loaded[ref] = null;
            // 読めなかった理由は診断には入らない (ライブラリは理由を知らない) ので、ここで出す
            console.error(`フックを読み込めませんでした: ${ref}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return loaded;
}

// render の描く前の段と同じ順で診断を集める。view を渡さないので、橋渡しは配置と描画のフックを呼ばない
function diagnose(markdag: typeof Markdag, source: string, types: Record<string, unknown>, hookRefs: Record<string, unknown> | undefined): Markdag.Diagnostic[] {
    // render が内部で使う解析と組み立ての 1 回の呼び出しは公開していないので、同じ結果になる parseDocument と buildModel を続けて呼ぶ
    const read = (text: string) => {
        const parsed = markdag.parseDocument(text);
        return { parsed, model: markdag.buildModel(parsed.nodes, parsed.frontmatter, text, { types, hookRefs }) };
    };
    const bridge = markdag.createHookBridge({ source: () => source });
    let { parsed, model } = read(source);
    const rendered = bridge.transform(model, source);
    if (rendered !== source) ({ parsed, model } = read(rendered));
    bridge.setDocument(parsed, model);
    bridge.destroy();
    const notes: Markdag.Diagnostic[] = parsed.extracted
        ? []
        : [
              {
                  severity: 'info',
                  code: 'not-extracted',
                  message: 'frontmatter に markdag のキーがないので、タグや $id の抽出は行っていません (markmap と同じ表示)',
                  at: null,
                  hint: null,
              },
          ];
    return [...model.diagnostics, ...notes];
}

const entry = fileURLToPath(new URL('../dist/markdag.js', import.meta.url));
const wasm = fileURLToPath(new URL('../dist/markdag.wasm', import.meta.url));
const args = process.argv.slice(2);
const withHooks = args.includes('--hooks');
const file = args.filter((argument) => !argument.startsWith('--')).at(-1) ?? '';
if (!file.endsWith('.md') || !existsSync(file)) {
    console.error('usage: npm run check -- [--hooks] path/to/document.md');
    process.exit(2);
}
if (!existsSync(entry) || !existsSync(wasm)) {
    console.error('dist/markdag.js or dist/markdag.wasm is missing. Run `npm run build` first.');
    process.exit(2);
}

// vite-node の変換を通さず、配布物をそのまま Node の import で読む (dist の import.meta.url が dist を指すように)
const markdag = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as typeof Markdag;
await markdag.init();
const markdown = readFileSync(file, 'utf8');
const hookRefs = withHooks ? await importHooks(await loadHookSources(file, markdown)) : undefined;
const diagnostics = diagnose(markdag, markdown, loadTypeRefs(file, markdown), hookRefs);
const text = markdag.formatDiagnostics(diagnostics);
console.log(text === '' ? 'no diagnostics' : text);
process.exitCode = diagnostics.some((item) => item.severity === 'error') ? 1 : 0;

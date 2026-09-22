// markdag の文書を検査して、診断を 1 件 1 行の文字で出す。誤り (error) が 1 件でもあれば、終了コードを 1 にする。
// 本文の解析に DOM が要るので、ビルド済みのライブラリ (script タグ 1 本で動く版) を、画面を出さないブラウザに読み込んで動かす。
// 図も実際に描くので、描画の途中で例外になる文書も、ここで見つかる。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { transformWithOxc } from 'vite';
import { parse as parseYaml } from 'yaml';

interface ReportedDiagnostic {
    severity: 'error' | 'warning' | 'info';
}
interface MarkdagGlobal {
    render(container: HTMLElement, markdown: string, options: { types: Record<string, unknown>; hookRefs: Record<string, unknown> }): { diagnostics: ReportedDiagnostic[] };
    formatDiagnostics(diagnostics: ReportedDiagnostic[]): string;
}

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
// --hooks を付けたときだけ読む。付けなければ、ライブラリが hooks-unresolved の警告を出す。
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

const bundle = fileURLToPath(new URL('../dist/markdag.iife.js', import.meta.url));
const args = process.argv.slice(2);
const withHooks = args.includes('--hooks');
const file = args.filter((argument) => !argument.startsWith('--')).at(-1) ?? '';
if (!file.endsWith('.md') || !existsSync(file)) {
    console.error('usage: npm run check -- [--hooks] path/to/document.md');
    process.exit(2);
}
if (!existsSync(bundle)) {
    console.error('dist/markdag.iife.js is missing. Run `npm run build` first.');
    process.exit(2);
}

const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    await page.setContent('<div id="diagram" style="width: 1200px; height: 800px"></div>');
    await page.addScriptTag({ path: bundle });
    const markdown = readFileSync(file, 'utf8');
    if (withHooks) {
        const failures = await page.evaluate(async (sources) => {
            // 動的 import はこの CLI をまとめる側に書き換えられたくないので、文字列から関数を作って呼ぶ
            const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<Record<string, unknown>>;
            const loaded: Record<string, unknown> = {};
            const errors: string[] = [];
            for (const { ref, code } of sources) {
                if (code === null) {
                    loaded[ref] = null;
                    continue;
                }
                const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
                try {
                    loaded[ref] = { ...(await importModule(url)) };
                } catch (error) {
                    loaded[ref] = null;
                    errors.push(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            (window as unknown as { hookRefs: Record<string, unknown> }).hookRefs = loaded;
            return errors;
        }, await loadHookSources(file, markdown));
        // 読めなかった理由は診断には入らない (ライブラリは理由を知らない) ので、ここで出す
        for (const failure of failures) console.error(`フックを読み込めませんでした: ${failure}`);
    }
    const result = await page.evaluate(
        ({ source, types }) => {
            const { render, formatDiagnostics } = (window as unknown as { markdag: MarkdagGlobal }).markdag;
            const container = document.getElementById('diagram');
            if (!container) throw new Error('container is missing');
            const hookRefs = (window as unknown as { hookRefs?: Record<string, unknown> }).hookRefs ?? {};
            const { diagnostics } = render(container, source, { types, hookRefs });
            return { text: formatDiagnostics(diagnostics), errors: diagnostics.filter((item) => item.severity === 'error').length };
        },
        { source: markdown, types: loadTypeRefs(file, markdown) },
    );
    console.log(result.text === '' ? 'no diagnostics' : result.text);
    process.exitCode = result.errors > 0 ? 1 : 0;
} finally {
    await browser.close();
}

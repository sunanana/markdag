// ライブラリの配布物を dist/ に作る。
// ES モジュール版は依存を外に出し (使う側のバンドラが解決する)、IIFE 版は依存をすべて含めて script タグ 1 本で動くようにする。
// 依存を外に出すかどうかは出力の形ごとに変えられないので、ビルドを 2 回に分ける。
// スタイルシートと frontmatter のスキーマは、単体でも参照できるよう、そのままの形でも置く。
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const dependencies = Object.keys(pkg.dependencies ?? {});

const shared: InlineConfig = {
    configFile: false,
    logLevel: 'warn',
    // 依存の中に残る Node.js 向けの分岐を、ブラウザで動く形に固定する
    define: { 'process.env.NODE_ENV': '"production"' },
};

rmSync(here('../dist/'), { recursive: true, force: true });

// ES モジュール版の入口は 2 つ (既定の入口と、変換器を利用者が渡す入口)。共通の部分は、両方から読む別のファイルに分かれる
await build({
    ...shared,
    build: {
        outDir: here('../dist/'),
        emptyOutDir: false,
        minify: false,
        lib: {
            entry: { markdag: here('../src/index.ts'), core: here('../src/core.ts') },
            formats: ['es'],
            fileName: (_format, entryName) => `${entryName}.js`,
        },
        rollupOptions: {
            external: (id) => dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
            output: { chunkFileNames: 'chunks/[name].js' },
        },
    },
});

// 変換器を渡す入口からたどれる範囲に、既定の変換器のライブラリの import が残っていないことを確かめる。
// 残っていると、利用者の成果物に既定の構成 (外部から部品を読み込む) が黙って入り込む
function bareImportsFrom(entry: string, seen = new Set<string>()): Set<string> {
    const bare = new Set<string>();
    if (seen.has(entry)) return bare;
    seen.add(entry);
    for (const [, specifier = ''] of readFileSync(entry, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)) {
        if (!specifier.startsWith('.')) bare.add(specifier);
        else for (const found of bareImportsFrom(join(dirname(entry), specifier), seen)) bare.add(found);
    }
    return bare;
}
const leaked = [...bareImportsFrom(here('../dist/core.js'))].filter((name) => name === 'markmap-lib' || name.startsWith('markmap-lib/'));
if (leaked.length > 0) throw new Error(`dist/core.js から ${leaked.join(', ')} の import に届く`);

await build({
    ...shared,
    build: {
        outDir: here('../dist/'),
        emptyOutDir: false,
        minify: true,
        lib: { entry: here('../src/index.ts'), formats: ['iife'], name: 'markdag', fileName: () => 'markdag.iife.js' },
    },
});

copyFileSync(here('../src/style.css'), here('../dist/style.css'));
copyFileSync(here('../src/model/frontmatter.schema.json'), here('../dist/frontmatter.schema.json'));
console.log('dist/ を書き出した');

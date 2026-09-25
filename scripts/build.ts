// ライブラリの配布物を dist/ に作る。
// ES モジュール版は依存を外に出し (使う側のバンドラが解決する)、IIFE 版は依存をすべて含めて script タグ 1 本で動くようにする。
// 依存を外に出すかどうかは出力の形ごとに変えられないので、ビルドを 2 回に分ける。
// スタイルシートと frontmatter のスキーマは、単体でも参照できるよう、そのままの形でも置く。
// 単体の HTML を書き出す入口は、外部と通信しない入口の IIFE 版とスタイルシートを焼き込んだ ES モジュールにするので、IIFE 版のあとに作る。
// wasm は cargo で作って dist/ に写す。JS の成果物より先に作り、IIFE 版には base64 で焼き込む (ES モジュール版は隣の markdag.wasm を読む)。
// ES モジュール版には、焼き込んだ wasm を init の既定にする開発用の入口 (*.dev.js) も添える。
import { copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig, type Plugin } from 'vite';
import { buildWasm, DIST_WASM } from './wasm';

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

// wasm は JS より先に作る (あとで IIFE に焼き込むため)。dist/ を空にしたあとに写す
buildWasm();

// IIFE 版の init が source なしで読む wasm。焼き込みの置き場のモジュール (中身は null) を、base64 の文字列を持つものに差し替える
const EMBEDDED_MODULE = here('../src/wasm/embedded.ts');
const embeddedWasm = readFileSync(DIST_WASM).toString('base64');
const embedWasm: Plugin = {
    name: 'markdag-embed-wasm',
    enforce: 'pre',
    load(id) {
        if (id.split('?')[0] !== EMBEDDED_MODULE) return null;
        return `export const EMBEDDED_WASM = ${JSON.stringify(embeddedWasm)};`;
    },
};
function expectEmbedded(file: string): void {
    const code = readFileSync(here(`../dist/${file}`), 'utf8');
    if (!code.includes(embeddedWasm)) throw new Error(`dist/${file} に wasm が焼き込まれていない`);
}

// ES モジュール版の入口は 2 つ (既定の入口と、外部と通信しない入口)。共通の部分は、両方から読む別のファイルに分かれる
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

await build({
    ...shared,
    plugins: [embedWasm],
    build: {
        outDir: here('../dist/'),
        emptyOutDir: false,
        minify: true,
        lib: { entry: here('../src/index.ts'), formats: ['iife'], name: 'markdag', fileName: () => 'markdag.iife.js' },
    },
});
expectEmbedded('markdag.iife.js');

// 外部と通信しない入口の IIFE 版。CDN から script を読まないので、解析結果を埋めた単体の HTML はこれで動く
await build({
    ...shared,
    plugins: [embedWasm],
    build: {
        outDir: here('../dist/'),
        emptyOutDir: false,
        minify: true,
        lib: { entry: here('../src/core.ts'), formats: ['iife'], name: 'markdag', fileName: () => 'markdag.core.iife.js' },
    },
});
expectEmbedded('markdag.core.iife.js');

// script タグに埋めたとき、閉じタグは文字の置き換えで逃がせるが、`<!--` のあとに `<script` が続くコードは逃がせない。
// 埋める側で断るより先に、ここで気づけるようにする
const coreRuntime = readFileSync(here('../dist/markdag.core.iife.js'), 'utf8');
if (/<!--[\s\S]*<script/i.test(coreRuntime)) throw new Error('dist/markdag.core.iife.js に「<!--」と「<script」が続けて現れるので、HTML に埋め込めない');

// 単体の HTML を書き出す入口。上の IIFE 版とスタイルシートを文字として焼き込むので、利用者のバンドラには何も求めない
await build({
    ...shared,
    build: {
        outDir: here('../dist/'),
        emptyOutDir: false,
        minify: false,
        lib: { entry: here('../src/standalone.ts'), formats: ['es'], fileName: () => 'standalone.js' },
    },
});

// 入口の init の既定の wasm の場所。src では `new URL(/* @vite-ignore */ './markdag.wasm', import.meta.url)` と書いて、
// このビルドが (まだ入口の隣にない) wasm を解決しようとして `'' + import.meta.url` に書き換えるのを止めている。
// 配布物では印のコメントを外し、利用者のバンドラ (Vite、webpack 5) が markdag.wasm を成果物に写す目印の形
// `new URL('./markdag.wasm', import.meta.url)` にそろえる (A-198)
const WASM_URL_IN_SOURCE = /new URL\(\s*\/\* @vite-ignore \*\/\s*(["'])\.\/markdag\.wasm\1,\s*import\.meta\.url\s*\)/g;
for (const entry of ['markdag.js', 'core.js', 'standalone.js']) {
    const path = here(`../dist/${entry}`);
    const code = readFileSync(path, 'utf8');
    const rewritten = code.replace(WASM_URL_IN_SOURCE, 'new URL("./markdag.wasm", import.meta.url)');
    if (rewritten === code) throw new Error(`dist/${entry} に入口の init の wasm の場所 (new URL('./markdag.wasm', import.meta.url)) が見つからない`);
    writeFileSync(path, rewritten);
}

// 開発用の ES モジュールの入口 (A-198)。package.json の exports の development の条件が指す。
// 利用者の開発サーバー (Vite の依存の事前バンドルなど) は入口のファイルを動かすので隣の markdag.wasm を見失う。
// 開発用の入口は、焼き込んだ wasm を init の既定にして、設定なしで動くようにする。
// 中身は既定の入口をそのまま読み直す薄い包みで、既定の入口 (と共有のチャンク) は 1 バイトも変えない。
// 焼き込みは 3 つの入口で共有する 1 つのファイルに置く (本番ビルドの利用者は development の条件を通らないので、これを読まない)
const DEV_WASM_MODULE = 'chunks/wasm-embedded.js';
writeFileSync(
    here(`../dist/${DEV_WASM_MODULE}`),
    `// markdag.wasm を base64 で焼き込んだもの。開発用の入口 (*.dev.js) の init が source なしのときに読む
const base64 = ${JSON.stringify(embeddedWasm)};
export function embeddedWasm() {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
`,
);
const DEV_ENTRIES = [
    ['markdag.dev.js', 'markdag.js'],
    ['core.dev.js', 'core.js'],
    ['standalone.dev.js', 'standalone.js'],
] as const;
for (const [devEntry, entry] of DEV_ENTRIES) {
    writeFileSync(
        here(`../dist/${devEntry}`),
        `// ./${entry} の開発用の入口。init の source を省くと、隣の markdag.wasm ではなく焼き込んだ wasm を読む (A-198)
import { init as initWith, isReady } from './${entry}';
import { embeddedWasm } from './${DEV_WASM_MODULE}';
export * from './${entry}';
export function init(source) {
	if (source !== undefined) return initWith(source);
	return isReady() ? Promise.resolve() : initWith(embeddedWasm());
}
`,
    );
}

// CDN から JS を読む部品 (数式とコードの飾りのライブラリ) は既定の入口 (dist/markdag.js と dist/markdag.iife.js) だけに入れる。
// markdag/core の入口が読むファイル (dist/core.js と共有のチャンク、開発用の入口と焼き込みの wasm を含む)、core の IIFE 版、単体の HTML の入口に入ると、
// 外部と通信しない約束の入口に読み込みの経路が残る (zu は markdag/core の成果物に jsdelivr の JS がないことを確かめている)。
// スタイルシートの URL (katex.min.css など) はリンクを足すだけの別の経路なので、ここでは見ない
const CDN_SCRIPT = /https:\/\/cdn\.jsdelivr\.net\/[^"'`\s]*\.js\b/;
const coreOutputs = ['core.js', 'core.dev.js', 'markdag.core.iife.js', 'standalone.js', 'standalone.dev.js', ...readdirSync(here('../dist/chunks/')).map((name) => `chunks/${name}`)];
for (const file of coreOutputs) {
    const found = readFileSync(here(`../dist/${file}`), 'utf8').match(CDN_SCRIPT);
    if (found) throw new Error(`dist/${file} に CDN から JS を読む経路 (${found[0]}) が入っている`);
}

copyFileSync(here('../src/style.css'), here('../dist/style.css'));
copyFileSync(here('../src/model/frontmatter.schema.json'), here('../dist/frontmatter.schema.json'));
console.log('dist/ を書き出した');

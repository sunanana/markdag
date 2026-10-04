// エディタを、開くだけで動く 1 枚の HTML に書き出す (npm run editor:build)。
// wasm は base64 で焼き込み (editor/wasm-source.ts を差し替える)、JS とスタイルシートは HTML の中に入れる。
// 先に npm run build で dist/markdag.wasm を作っておく
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const OUT = here('./dist/');
const WASM_SOURCE_MODULE = here('./wasm-source.ts');

const wasm = readFileSync(here('../dist/markdag.wasm')).toString('base64');
const embedWasm: Plugin = {
    name: 'markdag-editor-embed-wasm',
    enforce: 'pre',
    load(id) {
        if (id.split('?')[0] !== WASM_SOURCE_MODULE) return null;
        return `const WASM = ${JSON.stringify(wasm)};
export const wasmSource = () => Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));`;
    },
};

rmSync(OUT, { recursive: true, force: true });
const work = here('./dist/.work/');
await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [embedWasm],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
        outDir: work,
        emptyOutDir: true,
        minify: true,
        target: 'es2022',
        lib: { entry: here('./main.ts'), formats: ['es'], fileName: () => 'board.js' },
        rollupOptions: { output: { codeSplitting: false } },
    },
});

const files = readdirSync(work);
if (files.length !== 1) throw new Error(`1 つの JS にまとまらなかった: ${files.join(', ')}`);
const script = readFileSync(`${work}board.js`, 'utf8').replace(/<\/script/gi, '<\\/script')
    // 境界の置き換え文字 (U+FFFD) は文字列の中にだけ出てくる。載せる先が原文の置き換え文字を壊れた文字として拒むので、エスケープで書く
    .replace(/\uFFFD/g, '\\uFFFD');
const html = readFileSync(here('./index.html'), 'utf8').replace('<script type="module" src="./main.ts"></script>', () => `<script type="module">${script}</script>`);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}markdag-board.html`, html);
// Artifact に載せる形。載せる側が doctype と head と body を包むので、title とアプリの要素と script だけを書く
writeFileSync(`${OUT}markdag-board.artifact.html`, `<title>markdag Board</title>\n<div id="app"></div>\n<script type="module">${script}</script>\n`);
rmSync(work, { recursive: true, force: true });
console.log(`editor/dist/markdag-board.html を書き出した (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

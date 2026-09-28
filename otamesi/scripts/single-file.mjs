// vite build の出力 (dist/) を、スクリプトとスタイルを埋め込んだ 1 枚の HTML (dist/otamesi.html) にまとめる。
// markdag の開発用の入口は markdag.wasm を base64 で持っているので、この 1 枚だけで開ける
import { readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
let html = await readFile(new URL('index.html', dist), 'utf8');

const scripts = [...html.matchAll(/<script type="module" crossorigin src="\/?([^"]+)"><\/script>/g)];
const styles = [...html.matchAll(/<link rel="stylesheet" crossorigin href="\/?([^"]+)">/g)];
for (const [tag, path] of styles) {
    const css = await readFile(new URL(path, dist), 'utf8');
    html = html.replace(tag, () => `<style>\n${css}</style>`);
}
for (const [tag, path] of scripts) {
    const js = (await readFile(new URL(path, dist), 'utf8')).replace(/<\/script/gi, '<\\/script');
    // 本文の後ろで動かす (type="module" と同じ順になるように)
    html = html.replace(tag, '').replace('</body>', () => `<script type="module">\n${js}</script>\n</body>`);
}
await writeFile(new URL('otamesi.html', dist), html);
console.log(`dist/otamesi.html ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);

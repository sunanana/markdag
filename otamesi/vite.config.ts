import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    root: here('.'),
    // リポジトリの dist を使う。開発用の入口は markdag.wasm を埋め込んでいるので、wasm の置き場所を気にしなくてよい
    // (先にリポジトリの直下で npm run build が要る)
    resolve: { alias: [{ find: /^markdag$/, replacement: here('../dist/markdag.dev.js') }] },
    build: { outDir: here('dist'), emptyOutDir: true, chunkSizeWarningLimit: 8000 },
    server: { host: true },
    test: { include: ['test/**/*.test.ts'], environment: 'node', root: here('.') },
});

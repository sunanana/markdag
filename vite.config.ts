import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Playwright の spec を Vitest が拾わないよう、対象を単体テストの置き場に限定する
        include: ['test/**/*.test.ts'],
        environment: 'node',
        // 包みは wasm の init を待ってから使う。global-setup で wasm を作り、setup で各ファイルの前に init する
        globalSetup: ['test/global-setup.ts'],
        setupFiles: ['test/setup.ts'],
    },
});

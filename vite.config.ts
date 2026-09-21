import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Playwright の spec を Vitest が拾わないよう、対象を単体テストの置き場に限定する
        include: ['test/**/*.test.ts'],
        environment: 'node',
    },
});

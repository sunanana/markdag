import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
    testDir: '.',
    // 単体テスト (*.test.ts) は Vitest の担当なので、Playwright は *.spec.ts だけを拾う
    testMatch: ['spike/**/*.spec.ts', 'e2e/**/*.spec.ts'],
    outputDir: 'test-results',
    fullyParallel: true,
    reporter: 'line',
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1280, height: 800 },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ],
    // 開発サーバの起動と停止は Playwright に任せる (テストのあとにプロセスを残さないため)
    webServer: {
        command: `npx vite --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/e2e/harness.html`,
        reuseExistingServer: false,
        timeout: 60_000,
    },
});

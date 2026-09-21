// markdag の文書を検査して、診断を 1 件 1 行の文字で出す。誤り (error) が 1 件でもあれば、終了コードを 1 にする。
// 本文の解析に DOM が要るので、ビルド済みのライブラリ (script タグ 1 本で動く版) を、画面を出さないブラウザに読み込んで動かす。
// 図も実際に描くので、描画の途中で例外になる文書も、ここで見つかる。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

interface ReportedDiagnostic {
    severity: 'error' | 'warning' | 'info';
}
interface MarkdagGlobal {
    render(container: HTMLElement, markdown: string): { diagnostics: ReportedDiagnostic[] };
    formatDiagnostics(diagnostics: ReportedDiagnostic[]): string;
}

const bundle = fileURLToPath(new URL('../dist/markdag.iife.js', import.meta.url));
const file = process.argv.at(-1) ?? '';
if (!file.endsWith('.md') || !existsSync(file)) {
    console.error('usage: npm run check -- path/to/document.md');
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
    const result = await page.evaluate((markdown) => {
        const { render, formatDiagnostics } = (window as unknown as { markdag: MarkdagGlobal }).markdag;
        const container = document.getElementById('diagram');
        if (!container) throw new Error('container is missing');
        const { diagnostics } = render(container, markdown);
        return { text: formatDiagnostics(diagnostics), errors: diagnostics.filter((item) => item.severity === 'error').length };
    }, readFileSync(file, 'utf8'));
    console.log(result.text === '' ? 'no diagnostics' : result.text);
    process.exitCode = result.errors > 0 ? 1 : 0;
} finally {
    await browser.close();
}

// 単体 HTML を開いたときの icon-unresolved。焼き込んだ表にない ref は解決に失敗した扱いで、diagram.diagnostics に warning が 1 件ずつ入る。
// icons を焼き込んでいない (resolver がない) ときは出さない。公開の入口 (dist/standalone.js の buildStandaloneHtml) だけを呼ぶ
import { expect, test, type Page } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { buildStandaloneHtml as BuildStandaloneHtml, init as Init } from '../src/standalone';

const DIST = resolve('dist/standalone.js');
const CIRCLE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
const SOURCE = ['---', 'markdag:', '    icons:', '        logo: ./logo.svg', '        gh: simple-icons:github', '        rocket: 🚀', '---', '', '# R', '', '## :logo: 焼き込んだロゴ', '- [ ] :gh: 焼き込んでいない set:name', '- [ ] :rocket: 絵文字', ''].join('\n');

async function build(options: Parameters<typeof BuildStandaloneHtml>[0]): Promise<string> {
    if (!existsSync(DIST)) throw new Error('dist/standalone.js がない (npm run build を先に実行する)');
    const { buildStandaloneHtml, init } = (await import(pathToFileURL(DIST).href)) as { buildStandaloneHtml: typeof BuildStandaloneHtml; init: typeof Init };
    await init();
    return buildStandaloneHtml(options);
}

async function openDiagnostics(page: Page, html: string, name: string): Promise<Array<{ severity: string; code: string; at: unknown; message: string }>> {
    const file = test.info().outputPath(`${name}.html`);
    writeFileSync(file, html);
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => 'markdagStandalone' in window && document.querySelector('.mdag-node') !== null);
    return page.evaluate(() =>
        ((window as any).markdagStandalone.diagnostics as any[]).map(({ severity, code, at, message }) => ({ severity, code, at, message })),
    );
}

test('焼き込んだ表にない ref は warning を 1 件、表にある ref と絵文字は出さない', async ({ page }) => {
    const diagnostics = await openDiagnostics(page, await build({ source: SOURCE, icons: { './logo.svg': CIRCLE } }), 'missing-ref');
    const unresolved = diagnostics.filter((item) => item.code === 'icon-unresolved');
    expect(unresolved.map((item) => `${item.severity} ${item.at === null ? 'null' : 'at'}`)).toEqual(['warning null']);
    expect(unresolved[0]?.message).toContain('simple-icons:github');
});

test('icons を焼き込んでいなければ icon-unresolved を出さない', async ({ page }) => {
    const diagnostics = await openDiagnostics(page, await build({ source: SOURCE }), 'no-icons');
    expect(diagnostics.filter((item) => item.code === 'icon-unresolved')).toEqual([]);
});

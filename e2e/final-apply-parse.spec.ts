// 最後の関門で決まった解析の読み方 (records/final-apply/plan.md の 5、9、10) が閲覧の図に出ることを、ブラウザで確かめる。
// 見出しの詳細の印と吹き出し、リストだけの文書の最初の項目の枠とタグの位置、" で囲んだタグの見え方を見る。
// 解析は dist/markdag.wasm (npm run build が書き出す) を読む。見た目そのもの (色、余白、影) は見ない。
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { MarkdagDiagram } from '../src/index';

type TestWindow = Window & { harness: Harness; diagram: MarkdagDiagram };

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

test.beforeAll(() => {
    if (!existsSync(join(resolve('dist'), 'markdag.wasm'))) throw new Error('dist/markdag.wasm がない (npm run build を先に実行する)');
});

async function renderDoc(page: Page, markdown: string): Promise<void> {
    await page.goto('/e2e/harness.html');
    await page.waitForFunction(() => 'harness' in window);
    await page.evaluate((source) => {
        const target = window as unknown as TestWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('container is missing');
        target.diagram = target.harness.markdag.render(container, source, { animate: false });
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
}

const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;

async function boxOf(page: Page, selector: string): Promise<Box> {
    const box = await page.evaluate((selector) => {
        const element = [...document.querySelectorAll(selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }, selector);
    if (!box) throw new Error(`${selector} が見えていない`);
    return box;
}

const contains = (outer: Box, inner: Box): boolean => outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
const apart = (a: Box, b: Box): boolean => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;

// ノードごとの、見えているタグの文字 (ノードの id → .mdag-tags の文字)
async function shownTags(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
        const entries: Array<[string, string]> = [];
        for (const node of document.querySelectorAll<HTMLElement>('#a .mdag-node')) {
            const found = node.querySelector<HTMLElement>('.mdag-tags');
            if (!found || getComputedStyle(found).display === 'none') continue;
            entries.push([node.dataset.id ?? '', found.textContent ?? '']);
        }
        return Object.fromEntries(entries);
    });
}

// 描いている文書のモデルの groupsOf (グループに入っているノードだけ、id の昇順)
async function groupMembers(page: Page): Promise<Array<[number, string[]]>> {
    return page.evaluate(() => {
        const model = (window as unknown as TestWindow).diagram.view.getDocument()?.model;
        if (!model) return [];
        return [...model.groupsOf]
            .filter(([, ids]) => ids.length > 0)
            .map(([id, ids]): [number, string[]] => [id, [...ids]])
            .sort((a, b) => a[0] - b[0]);
    });
}

test.describe('見出しの詳細 (plan.md の 10)', () => {
    // 1 計画 / 2 設計 (見出しのすぐ下に引用) / 3 実装 (詳細なし)
    const DOC = ['---', 'markdag:', '---', '', '# 計画', '', '## 設計', '', '> 画面の案をまとめる', '', '## 実装', ''].join('\n');

    test('見出しのすぐ下の引用があると、見出しに詳細の印 (i) が出て、印を押すと吹き出しに詳細が出る', async ({ page }) => {
        await renderDoc(page, DOC);
        await expect(page.locator(nodeSelector(2))).toHaveAttribute('data-has-details', '');
        const mark = page.locator(`${nodeSelector(2)} .mdag-note-mark`);
        await expect(mark).toBeVisible();
        const popover = page.locator('#a .mdag-popover');
        await expect(popover).toBeHidden();
        await mark.click();
        await expect(popover).toBeVisible();
        await expect(popover).toContainText('画面の案をまとめる');
        // 詳細のない見出しには印が出ない
        await expect(page.locator(`${nodeSelector(3)} .mdag-note-mark`)).toHaveCount(0);
    });

    test('変えない: 段落のあとの引用しかない見出しには、詳細の印が出ない', async ({ page }) => {
        await renderDoc(page, ['---', 'markdag:', '---', '', '# 計画', '', '## 設計', '', '段落', '', '> 引用', ''].join('\n'));
        await expect(page.locator(nodeSelector(2))).toBeVisible();
        await expect(page.locator(`${nodeSelector(2)} .mdag-note-mark`)).toHaveCount(0);
    });
});

test.describe('リストだけの文書の最初の項目の印 (plan.md の 5。B-107 / B-135)', () => {
    // 1 入れ物 (ルート) / 2 設計 / 3 実装 / 4 テスト
    const GROUPED = ['---', 'markdag:', '    groups:', '        画面班:', '            label: 画面班', '            color: "#3B7DD8"', '            boundary: true', '---', '', '- 設計 %画面班', '- 実装', '- テスト', ''].join('\n');

    test('最初の項目に %グループ を書くと、グループに入るのは最初の項目だけで、枠はその項目を囲み、2 つ目からの項目は枠の外', async ({ page }) => {
        await renderDoc(page, GROUPED);
        await expect.poll(() => groupMembers(page)).toEqual([[2, ['画面班']]]);
        await expect(page.locator('#a .mdag-frame[data-group="画面班"]')).toHaveCount(1);
        const frame = await boxOf(page, '#a .mdag-frame[data-group="画面班"]');
        expect(contains(frame, await boxOf(page, `${nodeSelector(2)} .mdag-box`)), '設計の箱が枠の中').toBe(true);
        expect(apart(frame, await boxOf(page, `${nodeSelector(3)} .mdag-box`)), '実装の箱は枠と重ならない').toBe(true);
        expect(apart(frame, await boxOf(page, `${nodeSelector(4)} .mdag-box`)), 'テストの箱は枠と重ならない').toBe(true);
    });

    test('最初の項目に #タグ を書くと、タグは最初の項目にだけ出て、入れ物の丸には出ない', async ({ page }) => {
        await renderDoc(page, ['---', 'markdag:', '---', '', '- 設計 #担当:山田', '- 実装', '- テスト', ''].join('\n'));
        await expect(page.locator(nodeSelector(2))).toBeVisible();
        expect(await shownTags(page)).toEqual({ '2': '#担当:山田' });
    });
});

test.describe('" で囲んだタグの見え方 (plan.md の 9。B-134、細部 13)', () => {
    // 1 R / 2 a / 3 b / 4 c / 5 d
    const DOC = ['---', 'markdag:', '---', '', '# R', '', '- a #"s.a":"x y"', '- b #owner:alice,"山田 太郎"', '- c #note:"say \\"hi\\""', '- d #"a:b":c', ''].join('\n');

    test('囲んだキー、囲んだ値の並び、囲みの中の逃がしを書いたタグは、ノードの中に書き出しの規則の形 (要る所だけ囲み、" と \\ を逃がす) で出る', async ({ page }) => {
        await renderDoc(page, DOC);
        await expect(page.locator(nodeSelector(5))).toBeVisible();
        expect(await shownTags(page)).toEqual({
            '2': '#"s.a":"x y"',
            '3': '#owner:alice,"山田 太郎"',
            '4': '#note:"say \\"hi\\""',
            '5': '#"a:b":c',
        });
    });
});

// ライブラリの公開の API を、実際のブラウザで確かめる。解析は DOM を使い、描画はノードの実測のサイズを使うので、単体テストでは確かめられない。
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { MarkdagDiagram } from '../src/index';

interface HookLog {
    fold: Array<{ folded: number[]; byUser: boolean }>;
    transform: Array<{ x: number; y: number; k: number; byUser: boolean }>;
}
type TestWindow = Window & { harness: Harness; diagram: MarkdagDiagram; second: MarkdagDiagram; log: HookLog };

// ノードの id は文書順で、Root = 1, Design = 2, Task A = 3, Task B = 4, Build = 5, Deep = 6, Leaf = 7
const DOC = [
    '---',
    'markdag:',
    'relations:',
    '    depends:',
    '        - $api --> Design',
    '---',
    '',
    '# Root',
    '',
    '## Design #design',
    '',
    '- [ ] Task A',
    '- [x] Task B',
    '',
    '## Build $api',
    '',
    '### Deep',
    '',
    '- Leaf',
    '',
].join('\n');

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/harness.html');
    await page.waitForFunction(() => 'harness' in window);
}

async function renderFirst(page: Page): Promise<void> {
    await open(page);
    await page.evaluate((markdown) => {
        const target = window as unknown as TestWindow;
        const log: HookLog = { fold: [], transform: [] };
        const container = document.getElementById('a');
        if (!container) throw new Error('container is missing');
        target.log = log;
        target.diagram = target.harness.markdag.render(container, markdown, {
            animate: false,
            onFoldChange: (folded, byUser) => log.fold.push({ folded, byUser }),
            onTransform: (transform, byUser) => log.transform.push({ ...transform, byUser }),
        });
    }, DOC);
}

test.describe('解析', () => {
    test('ノードに原文の行の範囲が付き、値のない markdag のキーだけでも抽出が有効になる', async ({ page }) => {
        await open(page);
        const parsed = await page.evaluate((markdown) => (window as unknown as TestWindow).harness.markdag.parseDocument(markdown), DOC);
        expect(parsed.extracted).toBe(true);
        expect(parsed.nodes.map((node) => node.refText)).toEqual(['Root', 'Design', 'Task A', 'Task B', 'Build', 'Deep', 'Leaf']);
        expect(parsed.nodes.map((node) => node.lines?.start)).toEqual([7, 9, 11, 12, 14, 16, 18]);
        for (const node of parsed.nodes) expect(node.lines?.end).toBeGreaterThan(node.lines?.start ?? Number.NaN);
        expect(parsed.nodes[1]?.tags).toEqual(['design']);
        expect(parsed.nodes[4]?.refId).toBe('api');
        expect(parsed.nodes[2]?.task).toEqual({ line: 11, checked: false });
    });

    test('改行が CRLF の文書でも、タグと $id を同じように取り出す', async ({ page }) => {
        await open(page);
        const [lf, crlf] = await page.evaluate(
            (sources) => sources.map((source) => (window as unknown as TestWindow).harness.markdag.parseDocument(source).nodes),
            [DOC, DOC.replace(/\n/g, '\r\n')],
        );
        expect(crlf?.[1]?.tags).toEqual(['design']);
        expect(crlf?.[1]?.refText).toBe('Design');
        expect(crlf?.[4]?.refId).toBe('api');
        expect(crlf).toEqual(lf);
    });

    test('変換器を渡す入口は、渡された変換器で既定の入口と同じ結果を返す', async ({ page }) => {
        await open(page);
        const [viaDefault, viaCore] = await page.evaluate((markdown) => {
            const { markdag, core, createTransformer } = (window as unknown as TestWindow).harness;
            return [markdag.parseDocument(markdown), core.parseDocument(markdown, { transformer: createTransformer() })];
        }, DOC);
        expect(viaCore).toEqual(viaDefault);
    });

    test('変換器を渡す入口で、プラグインを必要なものだけにした変換器を使って図を描ける', async ({ page }) => {
        await open(page);
        const diagnostics = await page.evaluate((markdown) => {
            const { core, createTransformer } = (window as unknown as TestWindow).harness;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            return core.render(container, markdown, { transformer: createTransformer(), animate: false }).diagnostics;
        }, DOC);
        expect(diagnostics).toEqual([]);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        await expect(page.locator('#a .mdag-node[data-id="3"]')).toHaveAttribute('data-task', 'todo');
        // チェックボックスのプラグインは、状態の記号を SVG の絵で描く
        await expect(page.locator('#a .mdag-node[data-id="3"] .mdag-content svg')).toHaveCount(1);
    });
});

test.describe('図の操作', () => {
    test('値のない markdag のキーだけの文書に、警告を出さない', async ({ page }) => {
        await renderFirst(page);
        const diagnostics = await page.evaluate(() => (window as unknown as TestWindow).diagram.diagnostics);
        expect(diagnostics).toEqual([]);
    });

    test('表示位置を読み、置き換え、画面の上の距離で動かし、指定の点を中心に倍率を変えられる', async ({ page }) => {
        await renderFirst(page);
        const result = await page.evaluate(() => {
            const { view } = (window as unknown as TestWindow).diagram;
            view.setTransform({ x: 10, y: 20, k: 2 });
            const replaced = view.getTransform();
            view.panBy(30, -40);
            const panned = view.getTransform();
            view.zoomBy(1.5, { x: 100, y: 100 });
            const zoomed = view.getTransform();
            view.setTransform({ x: Number.NaN, y: 0, k: 1 });
            const canvas = document.querySelector<HTMLElement>('#a .mdag-canvas');
            return { replaced, panned, zoomed, afterInvalid: view.getTransform(), style: canvas?.style.transform };
        });
        expect(result.replaced).toEqual({ x: 10, y: 20, k: 2 });
        expect(result.panned).toEqual({ x: 40, y: -20, k: 2 });
        // (100, 100) にあった図の点 (30, 60) が、倍率 3 でも同じ位置に残る
        expect(result.zoomed.k).toBeCloseTo(3);
        expect(result.zoomed.x).toBeCloseTo(10);
        expect(result.zoomed.y).toBeCloseTo(-80);
        expect(result.afterInvalid).toEqual(result.zoomed);
        expect(result.style).toBe(`translate(${result.zoomed.x}px, ${result.zoomed.y}px) scale(${result.zoomed.k})`);
    });

    test('表示位置の変化を知らせ、見る人の操作によるものかを見分けられる', async ({ page }) => {
        await renderFirst(page);
        await page.evaluate(() => (window as unknown as TestWindow).diagram.view.panBy(5, 5));
        const byMethod = await page.evaluate(() => (window as unknown as TestWindow).log.transform);
        expect(byMethod.length).toBeGreaterThan(0);
        expect(byMethod.every((entry) => !entry.byUser)).toBe(true);

        await page.mouse.move(500, 300);
        await page.mouse.wheel(0, -120);
        await expect.poll(() => page.evaluate(() => (window as unknown as TestWindow).log.transform.at(-1)?.byUser)).toBe(true);
        const last = await page.evaluate(() => {
            const target = window as unknown as TestWindow;
            return { logged: target.log.transform.at(-1), current: target.diagram.view.getTransform() };
        });
        expect(last.logged).toEqual({ ...last.current, byUser: true });
    });

    test('開閉の状態を読み、置き換えられる。今の文書にない id と、子のないノードの id は捨てる', async ({ page }) => {
        await renderFirst(page);
        const result = await page.evaluate(() => {
            const target = window as unknown as TestWindow;
            const { view } = target.diagram;
            const initial = view.getFolded();
            view.setFolded([5, 2, 3, 999]);
            const replaced = view.getFolded();
            const hidden = document.querySelector<HTMLElement>('#a .mdag-node[data-id="3"]')?.style.display;
            const calls = target.log.fold.length;
            view.setFolded([2, 5]);
            return { initial, replaced, hidden, calls, callsAfterSame: target.log.fold.length, last: target.log.fold.at(-1) };
        });
        expect(result.initial).toEqual([]);
        expect(result.replaced).toEqual([2, 5]);
        expect(result.hidden).toBe('none');
        expect(result.last).toEqual({ folded: [2, 5], byUser: false });
        expect(result.callsAfterSame).toBe(result.calls);
    });

    test('閉じた枝の中のノードを、表示位置を動かさずに見えるようにできる', async ({ page }) => {
        await renderFirst(page);
        const result = await page.evaluate(() => {
            const target = window as unknown as TestWindow;
            const { view } = target.diagram;
            view.setFolded([1, 5, 6]);
            const before = view.getTransform();
            view.revealNode(7);
            const shown = document.querySelector<HTMLElement>('#a .mdag-node[data-id="7"]')?.style.display;
            return { folded: view.getFolded(), before, after: view.getTransform(), shown, last: target.log.fold.at(-1) };
        });
        expect(result.folded).toEqual([]);
        expect(result.shown).toBe('');
        expect(result.after).toEqual(result.before);
        expect(result.last).toEqual({ folded: [], byUser: false });
    });

    test('開閉の円のクリックは、見る人の操作として知らせる。文書の差し替えでは知らせない', async ({ page }) => {
        await renderFirst(page);
        await page.locator('#a .mdag-fold[data-id="2"]').click();
        const afterClick = await page.evaluate(() => (window as unknown as TestWindow).log.fold);
        expect(afterClick).toEqual([{ folded: [2], byUser: true }]);

        const afterUpdate = await page.evaluate((markdown) => {
            const target = window as unknown as TestWindow;
            target.diagram.update(markdown.replace('Task A', 'Task A2'));
            return { calls: target.log.fold.length, folded: target.diagram.view.getFolded() };
        }, DOC);
        expect(afterUpdate).toEqual({ calls: 1, folded: [2] });
    });

    test('ノードの要素に、原文の行の範囲が付く', async ({ page }) => {
        await renderFirst(page);
        await expect(page.locator('#a .mdag-node[data-id="3"]')).toHaveAttribute('data-lines', /^11,\d+$/);
    });

    test('図の内容の範囲は、全体表示が収める範囲と同じ', async ({ page }) => {
        await renderFirst(page);
        const { bounds, transform } = await page.evaluate(() => {
            const { view } = (window as unknown as TestWindow).diagram;
            view.fit();
            return { bounds: view.contentBounds(), transform: view.getTransform() };
        });
        if (!bounds) throw new Error('bounds is missing');
        const k = Math.min(2, (1000 * 0.94) / bounds.width, (600 * 0.92) / bounds.height);
        expect(transform.k).toBeCloseTo(k);
        expect(transform.x).toBeCloseTo((1000 - bounds.width * k) / 2 - bounds.x * k);
        expect(transform.y).toBeCloseTo((600 - bounds.height * k) / 2 - bounds.y * k);
    });

    test('同じページに図が 2 つあっても、矢印の marker の id が重ならず、線は自分の図の marker を指す', async ({ page }) => {
        await renderFirst(page);
        const result = await page.evaluate((markdown) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('b');
            if (!container) throw new Error('container is missing');
            target.second = target.harness.markdag.render(container, markdown, { animate: false, theme: 'dark' });
            const inspect = (selector: string) => {
                const root = document.querySelector(selector);
                const ids = [...(root?.querySelectorAll('marker') ?? [])].map((marker) => marker.id);
                const used = [...(root?.querySelectorAll('[marker-end]') ?? [])].map((path) => path.getAttribute('marker-end') ?? '');
                return { ids, used };
            };
            return { a: inspect('#a'), b: inspect('#b') };
        }, DOC);
        expect(result.a.ids.length).toBeGreaterThan(0);
        expect(result.b.ids.length).toBeGreaterThan(0);
        expect(new Set([...result.a.ids, ...result.b.ids]).size).toBe(result.a.ids.length + result.b.ids.length);
        for (const diagram of [result.a, result.b]) {
            expect(diagram.used.length).toBeGreaterThan(0);
            for (const reference of diagram.used) expect(diagram.ids.map((id) => `url(#${id})`)).toContain(reference);
        }
    });
});

// ライブラリの公開の API を、実際のブラウザで確かめる。解析は DOM を使い、描画はノードの実測のサイズを使うので、単体テストでは確かめられない。
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { Diagnostic, HookModule, MarkdagDiagram, OutlineNode } from '../src/index';

interface HookLog {
    fold: Array<{ folded: number[]; byUser: boolean }>;
    transform: Array<{ x: number; y: number; k: number; byUser: boolean }>;
}
type TestWindow = Window & { harness: Harness; diagram: MarkdagDiagram; second: MarkdagDiagram; log: HookLog };

// ノードの id は文書順で、Root = 1, Design = 2, Task A = 3, Task B = 4, Build = 5, Deep = 6, Leaf = 7
const DOC = [
    '---',
    'markdag:',
    '    relations:',
    '        depends:',
    '            - $api --> Design',
    '---',
    '',
    '# Root',
    '',
    '## Design %design',
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
        expect(parsed.nodes[1]?.groups).toEqual(['design']);
        expect(parsed.nodes[4]?.refId).toBe('api');
        expect(parsed.nodes[2]?.task).toEqual({ line: 11, checked: false });
    });

    test('改行が CRLF の文書でも、タグと $id を同じように取り出す', async ({ page }) => {
        await open(page);
        const [lf, crlf] = await page.evaluate(
            (sources) => sources.map((source) => (window as unknown as TestWindow).harness.markdag.parseDocument(source).nodes),
            [DOC, DOC.replace(/\n/g, '\r\n')],
        );
        expect(crlf?.[1]?.groups).toEqual(['design']);
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

// ノードの id は、Root = 1, Heading task = 2, Upper = 3, Lower = 4, plain = 5, Setext = 6, leaf = 7
const TASKS = [
    '---',
    'markdag:',
    '---',
    '',
    '# [x] Root',
    '',
    '## [ ] Heading task %tag',
    '',
    '- [X] Upper',
    '- [x] Lower',
    '- plain',
    '',
    '[X] Setext',
    '---',
    '',
    '- leaf',
    '',
].join('\n');

test.describe('タスク', () => {
    test('見出しもタスクになり、大文字の記号、文書の最初の見出し、下線で書く見出しでも同じ絵と参照用のテキストになる', async ({ page }) => {
        await open(page);
        const nodes = await page.evaluate((markdown) => (window as unknown as TestWindow).harness.markdag.parseDocument(markdown).nodes, TASKS);
        expect(nodes.map((node) => node.refText)).toEqual(['Root', 'Heading task', 'Upper', 'Lower', 'plain', 'Setext', 'leaf']);
        expect(nodes.map((node) => node.task)).toEqual([
            { line: 4, checked: true },
            { line: 6, checked: false },
            { line: 8, checked: true },
            { line: 9, checked: true },
            null,
            { line: 12, checked: true },
            null,
        ]);
        expect(nodes[1]?.groups).toEqual(['tag']);
        for (const node of nodes) expect(node.html.startsWith('<svg')).toBe(node.task !== null);
        // 完了の絵は、大文字でも、最初の見出しでも、ほかの完了のタスクと同じ
        const iconOf = (html: string | undefined): string => /^<svg[\s\S]*?<\/svg>/.exec(html ?? '')?.[0] ?? '';
        expect(iconOf(nodes[0]?.html)).toBe(iconOf(nodes[3]?.html));
        expect(iconOf(nodes[2]?.html)).toBe(iconOf(nodes[3]?.html));
        expect(iconOf(nodes[1]?.html)).not.toBe(iconOf(nodes[3]?.html));
    });

    test('見出しのタスクをクリックすると、原文の見出しの行の記号が切り替わる', async ({ page }) => {
        await open(page);
        await page.evaluate((markdown) => {
            const target = window as unknown as TestWindow & { changes: string[] };
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.changes = [];
            target.diagram = target.harness.markdag.render(container, markdown, { animate: false, onChange: (next) => target.changes.push(next) });
        }, TASKS);
        const heading = page.locator('#a .mdag-node[data-id="2"]');
        await expect(heading).toHaveAttribute('data-task', 'todo');
        await heading.locator('.mdag-content').click();
        await expect(heading).toHaveAttribute('data-task', 'done');
        const changes = await page.evaluate(() => (window as unknown as TestWindow & { changes: string[] }).changes);
        expect(changes).toEqual([TASKS.replace('## [ ] Heading task', '## [x] Heading task')]);

        // 大文字で書かれた記号も、クリックで未完了に戻せる
        await page.locator('#a .mdag-node[data-id="3"] .mdag-content').click();
        const last = await page.evaluate(() => (window as unknown as TestWindow & { changes: string[] }).changes.at(-1));
        expect(last).toContain('- [ ] Upper');
    });

    test('HTML で直接書いたチェックボックスの状態は、ほかのタスクの切り替えで描き直しても残り、その内容を書き換えたら戻る', async ({ page }) => {
        const markdown = ['---', 'markdag:', '---', '', '# Root', '', '- <input type="checkbox"> raw', '- [ ] Task', ''].join('\n');
        await open(page);
        await page.evaluate((source) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.diagram = target.harness.markdag.render(container, source, { animate: false });
        }, markdown);
        const raw = page.locator('#a .mdag-node[data-id="2"] input[type="checkbox"]');
        await raw.click();
        await expect(raw).toBeChecked();

        await page.locator('#a .mdag-node[data-id="3"] .mdag-content').click();
        await expect(page.locator('#a .mdag-node[data-id="3"]')).toHaveAttribute('data-task', 'done');
        await expect(raw).toBeChecked();

        await page.evaluate((source) => (window as unknown as TestWindow).diagram.update(source.replace('> raw', '> raw2')), markdown);
        await expect(page.locator('#a .mdag-node[data-id="2"]')).toContainText('raw2');
        await expect(raw).not.toBeChecked();
    });
});

test.describe('凡例', () => {
    const source = (legend: string[]): string =>
        ['---', 'markdag:', ...legend, '    branches:', '        - A', '    groups:', '        team:', '            label: Team', '            color: "#3B7DD8"', '---', '', '# Root', '', '## A %team', '', '## B', ''].join('\n');

    // 図の領域 (1000 x 600) の、どの隅に寄っているか
    async function cornerOf(page: Page, legend: string[]): Promise<string> {
        await open(page);
        return page.evaluate((markdown) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.diagram = target.harness.markdag.render(container, markdown, { animate: false });
            const area = container.getBoundingClientRect();
            const box = container.querySelector('.mdag-legend')?.getBoundingClientRect();
            if (!box || box.width === 0) return 'hidden';
            const vertical = box.top - area.top < area.bottom - box.bottom ? 'top' : 'bottom';
            const horizontal = box.left - area.left < area.right - box.right ? 'left' : 'right';
            return `${vertical}-${horizontal}`;
        }, source(legend));
    }

    test('指定がなければ右上に置く', async ({ page }) => {
        expect(await cornerOf(page, [])).toBe('top-right');
        expect(await cornerOf(page, ['    legend:', '        display:', '            - groups'])).toBe('top-right');
    });

    for (const position of ['top-right', 'top-left', 'bottom-right', 'bottom-left']) {
        test(`position: ${position} で、その隅に置く`, async ({ page }) => {
            expect(await cornerOf(page, ['    legend:', `        position: ${position}`])).toBe(position);
        });
    }

    test('display: false なら、位置の指定があっても凡例を出さない', async ({ page }) => {
        expect(await cornerOf(page, ['    legend:', '        position: bottom-left', '        display: false'])).toBe('hidden');
    });
});

test.describe('詳細を開いて表示するタスクのノード', () => {
    // ノードの id は、Root = 1, 種別の判定 = 2, タスク = 3
    const markdown = [
        '---',
        'markdag:',
        '    details:',
        '        display: always',
        '---',
        '',
        '# Root',
        '',
        '## 種別の判定 $detect',
        '- [ ] 1 本文を新規バッファへ貼る',
        '    > 入力中にプレビューが Markdag の図へ切り替わる。',
        "    <div class=\"nested\">hoge<input type='radio'></div>",
        '',
    ].join('\n');
    const task = '#a .mdag-node[data-id="3"]';

    test.beforeEach(async ({ page }) => {
        await open(page);
        await page.evaluate((source) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.diagram = target.harness.markdag.render(container, source, { animate: false });
        }, markdown);
        await expect(page.locator(task)).toHaveAttribute('data-task', 'todo');
    });

    test('詳細と、そのあとに書いた HTML は、書いた順に上から並ぶ', async ({ page }) => {
        const tops = await page.evaluate((selector) => {
            const top = (part: string): number => document.querySelector(`${selector} ${part}`)?.getBoundingClientRect().top ?? Number.NaN;
            return { label: top('.mdag-content'), details: top('.mdag-details'), nested: top('.nested') };
        }, task);
        expect(tops.label).toBeLessThanOrEqual(tops.details);
        expect(tops.details).toBeLessThan(tops.nested);
    });

    test('詳細は内容の中の書かれた位置に残るが、参照用のテキストには入らず、開いて表示しない見せ方では隠れる', async ({ page }) => {
        const node = await page.evaluate((source) => (window as unknown as TestWindow).harness.markdag.parseDocument(source).nodes[2], markdown);
        expect(node?.html).toMatch(/<blockquote [^>]*class="mdag-details"/);
        expect(node?.html.indexOf('mdag-details')).toBeLessThan(node?.html.indexOf('nested') ?? -1);
        expect(node?.details).toContain('入力中にプレビューが');
        expect(node?.refText).not.toContain('入力中にプレビューが');

        await page.evaluate(() => (window as unknown as TestWindow).diagram.view.setOptions({ details: 'hover' }));
        await expect(page.locator(`${task} .mdag-details`)).toBeHidden();
        await expect(page.locator(`${task} .mdag-note-mark`)).toBeVisible();
    });

    test('詳細の文をクリックしても、ラベルのクリックと同じようにタスクが切り替わる', async ({ page }) => {
        await page.locator(`${task} .mdag-details`).click();
        await expect(page.locator(task)).toHaveAttribute('data-task', 'done');
        // ラベルの文字は、内容の要素の直下にある (状態の絵の右)
        await page.locator(`${task} .mdag-content:not(.mdag-details)`).click({ position: { x: 40, y: 8 } });
        await expect(page.locator(task)).toHaveAttribute('data-task', 'todo');
    });

    test('操作を受ける要素を含む入れ子の部分のクリックでは、タスクは切り替わらない', async ({ page }) => {
        const radio = page.locator(`${task} input[type="radio"]`);
        await page.locator(`${task} .nested`).click({ position: { x: 4, y: 8 } });
        await expect(radio).toBeChecked();
        await expect(page.locator(task)).toHaveAttribute('data-task', 'todo');

        // 入れ子の部分の状態は、そのあとでタスクを切り替えても残る
        await page.locator(`${task} .mdag-details`).click();
        await expect(page.locator(task)).toHaveAttribute('data-task', 'done');
        await expect(radio).toBeChecked();
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

test.describe('グループの印とタグ', () => {
    // ノードの id は、Root = 1, A = 2, B = 3, C = 4, D = 5, E = 6, F = 7, G = 8
    const TAGGED = [
        '---',
        'markdag:',
        '    groups:',
        '        qa:',
        '            label: QA',
        '---',
        '',
        '# Root',
        '',
        '## A %qa #owner:alice,bob #urgent $a',
        '- B #owner:"山田 太郎" #secret:yes',
        '- C Issue #123',
        '- D %50',
        '- E \\%qa',
        '- F #owner:',
        '- G #owner:alice #owner:carol',
        '',
    ].join('\n');

    test('%名前 はグループ、#キー:値 はタグになり、数字だけの名前、値の空いたタグ、\\ を付けた印は文字のまま残る', async ({ page }) => {
        await open(page);
        const parsed = await page.evaluate((markdown) => (window as unknown as TestWindow).harness.markdag.parseDocument(markdown), TAGGED);
        const node = (id: number): OutlineNode | undefined => parsed.nodes[id - 1];
        expect(node(2)?.groups).toEqual(['qa']);
        expect(node(2)?.tags).toEqual([
            { key: 'owner', values: ['alice', 'bob'], at: { line: 10, column: 10, length: 16 } },
            { key: 'urgent', values: [], at: { line: 10, column: 27, length: 7 } },
        ]);
        expect(node(2)?.refId).toBe('a');
        expect(node(2)?.refText).toBe('A');
        // 桁と長さは文字数で数える (全角の文字も 1)
        expect(node(3)?.tags).toEqual([
            { key: 'owner', values: ['山田 太郎'], at: { line: 11, column: 5, length: 14 } },
            { key: 'secret', values: ['yes'], at: { line: 11, column: 20, length: 11 } },
        ]);
        expect(node(3)?.refText).toBe('B');
        expect(node(4)?.tags).toEqual([]);
        expect(node(4)?.refText).toBe('C Issue #123');
        expect(node(5)?.groups).toEqual([]);
        expect(node(5)?.refText).toBe('D %50');
        expect(node(6)?.groups).toEqual([]);
        expect(node(6)?.refText).toBe('E %qa');
        expect(node(7)?.tags).toEqual([]);
        expect(node(7)?.refText).toBe('F #owner:');
        expect(node(8)?.tags).toEqual([{ key: 'owner', values: ['alice', 'carol'], at: { line: 16, column: 5, length: 12 } }]);
    });

    // ノードごとの、色のないグループの文字ラベルと、実際に見えているタグ
    async function labelsOf(page: Page, markdown: string): Promise<{ groups: Record<string, string>; tags: Record<string, string> }> {
        await open(page);
        return page.evaluate((source) => {
            const target = window as unknown as TestWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.diagram = target.harness.markdag.render(container, source, { animate: false });
            const collect = (selector: string, shownOnly: boolean): Record<string, string> => {
                const entries: Array<[string, string]> = [];
                for (const node of container.querySelectorAll<HTMLElement>('.mdag-node')) {
                    const found = node.querySelector<HTMLElement>(selector);
                    if (!found || (shownOnly && getComputedStyle(found).display === 'none')) continue;
                    entries.push([node.dataset.id ?? '', found.textContent ?? '']);
                }
                return Object.fromEntries(entries);
            };
            return { groups: collect('.mdag-labels', false), tags: collect('.mdag-tags', true) };
        }, markdown);
    }

    const ALL_TAGS = { '2': '#owner:alice,bob #urgent', '3': '#owner:"山田 太郎" #secret:yes', '8': '#owner:alice,carol' };

    test('色のないグループとタグは、ノードの中に書いたとおりの文字で出す', async ({ page }) => {
        const { groups, tags } = await labelsOf(page, TAGGED);
        // グループの文字ラベルは、配下にも継承するので全部のノードに出る (ルートを除く)
        expect(groups).toEqual({ '2': '%QA', '3': '%QA', '4': '%QA', '5': '%QA', '6': '%QA', '7': '%QA', '8': '%QA' });
        expect(tags).toEqual(ALL_TAGS);
    });

    const withTagMode = (mode: string): string => TAGGED.replace('markdag:\n', `markdag:\n    tags:\n        display: ${mode}\n`);

    test('markdag.tags.display は、タグの出し方をまとめて決める (グループの文字はいつも出る)', async ({ page }) => {
        // always だけがノードの中に出す。hover と click は詳細と同じ吹き出しに入れるので、ノードの中には出さない
        expect((await labelsOf(page, withTagMode('always'))).tags).toEqual(ALL_TAGS);
        expect((await labelsOf(page, withTagMode('never'))).tags).toEqual({});
        expect((await labelsOf(page, withTagMode('click'))).tags).toEqual({});
        expect((await labelsOf(page, withTagMode('hover'))).tags).toEqual({});
        // グループの文字は、どの見せ方でも出る
        expect(Object.keys((await labelsOf(page, withTagMode('never'))).groups)).toHaveLength(7);
    });

    test('hover と click のタグは、詳細と同じ印と吹き出しに出る (タグだけのノードにも印が出る)', async ({ page }) => {
        await labelsOf(page, withTagMode('click'));
        // 専用の印は作らず、詳細と同じ i の印を使う
        await expect(page.locator('#a .mdag-tag-mark')).toHaveCount(0);
        const node = page.locator('#a .mdag-node[data-id="2"]');
        const popover = page.locator('#a .mdag-popover');
        await expect(popover).toBeHidden();
        await node.locator('.mdag-note-mark').click();
        await expect(popover).toBeVisible();
        await expect(popover).toHaveText('#owner:alice,bob #urgent');
        await node.locator('.mdag-note-mark').click();
        await expect(popover).toBeHidden();
        // タグのないノードには印が出ない
        await expect(page.locator('#a .mdag-node[data-id="4"] .mdag-note-mark')).toBeHidden();
    });

    test('詳細をノードの中に開く文書では、吹き出しを使わないのでタグもノードの中に出る', async ({ page }) => {
        const open = withTagMode('hover').replace('markdag:\n', 'markdag:\n    details:\n        display: always\n');
        expect((await labelsOf(page, open)).tags).toEqual(ALL_TAGS);
        await expect(page.locator('#a .mdag-note-mark').first()).toBeHidden();
    });
});

test.describe('フック', () => {
    // ノードの id は Root = 1, Design = 2, Build = 3
    const GUARDED = ['---', 'markdag:', '    relations:', '        chain:', '            - Design --> Build', '    hooks:', '        $ref: ./guard.hooks.js', '---', '', '# Root', '', '## [ ] Design', '', '## [ ] Build', ''].join('\n');

    interface HookWindow extends TestWindow {
        changes: string[];
        notes: string[];
    }

    // 文書が宣言したフックの実体は、呼び出し側が渡す。ここではテストの中で組み立てて hookRefs に入れる
    async function renderGuarded(page: Page, markdown = GUARDED, pass = true): Promise<void> {
        await open(page);
        await page.evaluate(
            ({ source, withModule }) => {
                const target = window as unknown as HookWindow;
                const container = document.getElementById('a');
                if (!container) throw new Error('container is missing');
                target.changes = [];
                target.notes = [];
                const guard: HookModule = {
                    beforeTaskToggle: (context) => {
                        if (!context.next) return;
                        const blockers = context.doc.upstream(context.node.id).filter((node) => node.task !== null && !node.task.checked);
                        if (blockers.length === 0) return;
                        context.reject(blockers.map((node) => node.text).join(', '));
                        return false;
                    },
                    onTaskToggle: (context) => void target.notes.push(`toggle ${context.node.text} ${String(context.next)} ${String(context.byUser)}`),
                    onDocument: (context) => void target.notes.push(`document ${String(context.doc.nodes().length)}`),
                };
                target.diagram = target.harness.markdag.render(container, source, {
                    animate: false,
                    hookRefs: withModule ? { './guard.hooks.js': guard } : {},
                    onChange: (next) => target.changes.push(next),
                    onDiagnostic: (diagnostic: Diagnostic) => target.notes.push(`${diagnostic.code} ${diagnostic.message}`),
                });
            },
            { source: markdown, withModule: pass },
        );
    }

    const notesOf = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as HookWindow).notes);
    const changesOf = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as HookWindow).changes);

    test('beforeTaskToggle が false を返すと、原文は書き換わらず、取りやめの診断が出る', async ({ page }) => {
        await renderGuarded(page);
        const build = page.locator('#a .mdag-node[data-id="3"]');
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'todo');
        expect(await changesOf(page)).toEqual([]);
        expect(await notesOf(page)).toContain('hook-rejected ./guard.hooks.js の beforeTaskToggle が操作を取りやめました: Design');
    });

    test('上流を終えれば通り、onTaskToggle には切り替えたあとのノードが渡る', async ({ page }) => {
        await renderGuarded(page);
        const design = page.locator('#a .mdag-node[data-id="2"]');
        const build = page.locator('#a .mdag-node[data-id="3"]');
        await design.locator('.mdag-content').click();
        await expect(design).toHaveAttribute('data-task', 'done');
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'done');
        expect(await changesOf(page)).toHaveLength(2);
        const notes = await notesOf(page);
        expect(notes.filter((note) => note.startsWith('toggle'))).toEqual(['toggle Design true true', 'toggle Build true true']);
        // 描き直すたびに onDocument が呼ばれる (最初の描画と、切り替え 2 回)
        expect(notes.filter((note) => note.startsWith('document'))).toEqual(['document 3', 'document 3', 'document 3']);
    });

    // グループ、詳細、折りたためる枝のある文書。id は Root = 1, Design = 2, Child A = 3, Build = 4
    const RICH = [
        '---',
        'markdag:',
        '    groups:',
        '        design:',
        '            label: 設計',
        '            color: "#3B7DD8"',
        '            boundary: true',
        '    details:',
        '        display: click',
        '---',
        '',
        '# Root',
        '',
        '## Design %design',
        '',
        '- Child A',
        '    > 詳細の文',
        '',
        '## Build',
        '',
    ].join('\n');

    // こちらは呼び出し側が直接渡すフック (文書には宣言がない)
    async function renderWatched(page: Page): Promise<void> {
        await open(page);
        await page.evaluate((source) => {
            const target = window as unknown as HookWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.changes = [];
            target.notes = [];
            const watch: HookModule = {
                onNodeClick: (context) => void target.notes.push(`click ${context.node.text} ${String(context.asTaskToggle)}`),
                beforeFold: (context) => {
                    target.notes.push(`fold ${context.node.text} ${String(context.folded)}`);
                    return false;
                },
                onSelectGroup: (context) => void target.notes.push(`group ${context.group?.id ?? 'none'} ${String(context.group?.members.length ?? 0)}`),
                beforeDetailsShow: (context) => {
                    target.notes.push(`details ${context.node.text} ${String(context.pinned)}`);
                    return false;
                },
            };
            target.diagram = target.harness.markdag.render(container, source, { animate: false, hooks: watch });
        }, RICH);
    }

    test('beforeFold が false を返すと、開閉の円をクリックしても枝は閉じない', async ({ page }) => {
        await renderWatched(page);
        const child = page.locator('#a .mdag-node[data-id="3"]');
        await expect(child).toBeVisible();
        await page.locator('#a .mdag-fold[data-id="2"]').click();
        await expect(child).toBeVisible();
        expect(await notesOf(page)).toContain('fold Design true');
    });

    test('グループの選択、詳細の取りやめ、ノードのクリックがフックに届く', async ({ page }) => {
        await renderWatched(page);
        // 枠のラベルは 1px の SVG の層に描かれていて、クリックの前に層をスクロールしようとするブラウザがある。
        // 図はスクロールされると元に戻すので、click では位置がずれる。ここでは click のイベントだけを送る
        await page.locator('#a .mdag-frame-label[data-group="design"]').dispatchEvent('click');
        // Design とその配下の Child A が、このグループのメンバー
        expect(await notesOf(page)).toContain('group design 2');

        await page.locator('#a .mdag-node[data-id="3"] .mdag-note-mark').click();
        await expect(page.locator('#a .mdag-popover')).toBeHidden();
        expect(await notesOf(page)).toContain('details Child A true');

        // タスクでないノードのクリックは、切り替えとしては扱われない
        await page.locator('#a .mdag-node[data-id="4"] .mdag-content').click();
        expect(await notesOf(page)).toContain('click Build false');
    });

    // コードを書かずに使う規則だけの文書。id は Root = 1, Design = 2, Build = 3
    const RULED = ['---', 'markdag:', '    relations:', '        chain:', '            - Design --> Build', '    rules:', '        taskToggle:', '            requireUpstreamDone: true', '---', '', '# Root', '', '## [ ] Design', '', '## [ ] Build', ''].join('\n');

    test('markdag.rules だけで、フックのファイルなしに上流の完了を求められる', async ({ page }) => {
        await renderGuarded(page, RULED, false);
        const design = page.locator('#a .mdag-node[data-id="2"]');
        const build = page.locator('#a .mdag-node[data-id="3"]');
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'todo');
        expect(await notesOf(page)).toContain('hook-rejected markdag.rules の beforeTaskToggle が操作を取りやめました: 先に終えるもの: Design');

        await design.locator('.mdag-content').click();
        await expect(design).toHaveAttribute('data-task', 'done');
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'done');
    });

    test('transformSource で足したノードに、decorateNode の飾りが付く', async ({ page }) => {
        await open(page);
        await page.evaluate((source) => {
            const target = window as unknown as HookWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.changes = [];
            target.notes = [];
            const extend: HookModule = {
                transformSource: (context) => `${context.source}## Extra\n`,
                decorateNode: (context) => (context.node.text === 'Extra' ? { className: 'added', title: 'フックが足したノード', badge: '自動' } : undefined),
            };
            target.diagram = target.harness.markdag.render(container, source, { animate: false, hooks: extend, onChange: (next) => target.changes.push(next) });
        }, ['---', 'markdag:', '---', '', '# Root', '', '## [ ] Design', ''].join('\n'));

        const extra = page.locator('#a .mdag-node[data-id="3"]');
        await expect(extra).toHaveClass(/added/);
        await expect(extra.locator('.mdag-badge')).toHaveText('自動');
        await expect(extra.locator('.mdag-box')).toHaveAttribute('title', 'フックが足したノード');
        // 足したのは末尾なので、もとからある行の番号は変わらず、タスクは切り替えられる
        await page.locator('#a .mdag-node[data-id="2"] .mdag-content').click();
        await expect(page.locator('#a .mdag-node[data-id="2"]')).toHaveAttribute('data-task', 'done');
        // 書き戻すのは原文のほうで、フックが足した行は入らない
        expect(await changesOf(page)).toEqual([['---', 'markdag:', '---', '', '# Root', '', '## [x] Design', ''].join('\n')]);
    });

    test('render を使わない経路でも、createHookBridge で規則とフックが効き、アプリの受け口も呼ばれる', async ({ page }) => {
        await open(page);
        await page.evaluate((source) => {
            const target = window as unknown as HookWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('container is missing');
            target.changes = [];
            target.notes = [];
            const { core } = target.harness;
            const transformer = target.harness.createTransformer();
            // 本文はアプリ (このテスト) が持つ
            let text = source;
            const draw = (fit: boolean): void => {
                const parsed = core.parseDocument(text, { transformer });
                const model = core.buildModel(parsed.nodes, parsed.frontmatter, text);
                bridge.setDocument(parsed, model, fit);
            };
            const bridge = core.createHookBridge({
                source: () => text,
                onDiagnostic: (diagnostic) => target.notes.push(`${diagnostic.code} ${diagnostic.message}`),
                hooks: { onTaskToggle: (context) => void target.notes.push(`toggle ${context.node.text} ${String(context.next)}`) },
                viewHooks: {
                    onToggleTask: (node) => {
                        if (!node.task) return;
                        text = core.toggleTask(text, node.task.line);
                        target.changes.push(text);
                        draw(false);
                    },
                },
            });
            const view = new core.MarkdagView(container, bridge.viewHooks);
            view.setOptions({ animate: false });
            bridge.attach(view);
            draw(true);
        }, RULED);
        const design = page.locator('#a .mdag-node[data-id="2"]');
        const build = page.locator('#a .mdag-node[data-id="3"]');
        // 規則が止めるときは、アプリの onToggleTask は呼ばれない
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'todo');
        expect(await notesOf(page)).toContain('hook-rejected markdag.rules の beforeTaskToggle が操作を取りやめました: 先に終えるもの: Design');
        expect(await changesOf(page)).toEqual([]);
        // 通るときは、アプリが書き換えて描き直したあとに onTaskToggle が来る
        await design.locator('.mdag-content').click();
        await expect(design).toHaveAttribute('data-task', 'done');
        expect(await changesOf(page)).toHaveLength(1);
        expect(await notesOf(page)).toContain('toggle Design true');
    });

    test('宣言だけでモジュールが渡されていなければ、フックは動かず警告になる', async ({ page }) => {
        await renderGuarded(page, GUARDED, false);
        const codes = await page.evaluate(() => (window as unknown as HookWindow).diagram.diagnostics.map((item) => item.code));
        expect(codes).toEqual(['hooks-unresolved']);
        const build = page.locator('#a .mdag-node[data-id="3"]');
        await build.locator('.mdag-content').click();
        await expect(build).toHaveAttribute('data-task', 'done');
    });
});

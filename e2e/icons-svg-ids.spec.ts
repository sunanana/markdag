// 同じ SVG (グラデーションと clipPath を持つもの) を本文、詳細 (吹き出し)、タグ、枠のラベル、凡例に置いたときの id。
// 写しごとに id が一意で、見えている写しの塗りと切り抜きの参照が自分の写しの中を指すこと。
// 公開の入口 (render) だけを呼ぶ
import { expect, test, type Page } from '@playwright/test';

const REF = 'simple-icons:grad';
const GRADIENT = [
    '<svg viewBox="0 0 24 24">',
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
    '<clipPath id="c"><rect width="24" height="24" rx="4"/></clipPath></defs>',
    '<path d="M0 0h24v24H0z" fill="url(#g)" clip-path="url(#c)"/>',
    '</svg>',
].join('');

const SOURCE = [
    '---',
    'markdag:',
    '    icons:',
    `        grad: { ref: ${REF}, color: original }`,
    '    details:',
    '        display: hover',
    '    tags:',
    '        keys:',
    '            tool:',
    '                type: string',
    '                icons: { grad: grad }',
    '    groups:',
    '        infra:',
    '            label: インフラ',
    '            color: "#d9822b"',
    '            boundary: true',
    '            icon: grad',
    '---',
    '',
    '# R',
    '',
    '## クラスタ %infra',
    '- [ ] :grad: 本文のロゴ',
    '    > 詳細の :grad:',
    '- [ ] タグ #tool:grad',
    '',
].join('\n');

interface Copy {
    place: string;
    visible: boolean;
    ids: string[];
    // 塗りと切り抜きの計算値が指す id と、その id の要素が自分の写しの中にあるか
    paints: Array<{ id: string; own: boolean }>;
}

async function copies(page: Page): Promise<Copy[]> {
    return page.evaluate(() => {
        const container = document.querySelector('#a')!;
        const roots = [...container.querySelectorAll<SVGSVGElement>('.mdag-icon > svg, svg.mdag-frame-icon > svg')];
        const placeOf = (root: Element): string => {
            if (root.closest('.mdag-popover')) return 'popover';
            if (root.closest('.mdag-legend')) return 'legend';
            if (root.closest('svg.mdag-frame-icon')) return 'frame';
            if (root.closest('.mdag-tags')) return 'tag';
            if (root.closest('.mdag-details')) return 'node-details';
            return 'body';
        };
        const target = (value: string): string | null => /url\(\s*["']?#([^"')\s]+)/.exec(value)?.[1] ?? null;
        return roots.map((root) => {
            const shape = root.querySelector('path')!;
            const style = getComputedStyle(shape);
            const paints = [style.fill, style.clipPath].flatMap((value) => {
                const id = target(value);
                return id === null ? [] : [{ id, own: root.contains(document.getElementById(id)) }];
            });
            return {
                place: placeOf(root),
                visible: root.checkVisibility() && root.getBoundingClientRect().width > 0,
                ids: [...root.querySelectorAll('[id]')].map((element) => element.id),
                paints,
            };
        });
    });
}

async function hoverNode(page: Page, text: string): Promise<void> {
    const point = await page.evaluate((text) => {
        const node = [...document.querySelectorAll('#a .mdag-node')].find((item) => item.textContent?.includes(text));
        const box = node?.querySelector('.mdag-box');
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        for (const fy of [0.5, 0.2, 0.8]) {
            for (const fx of [0.8, 0.5, 0.95, 0.2]) {
                const x = rect.left + rect.width * fx;
                const y = rect.top + rect.height * fy;
                const hit = document.elementFromPoint(x, y);
                if (hit && box.contains(hit)) return { x, y };
            }
        }
        return null;
    }, text);
    if (!point) throw new Error(`「${text}」のノードに重ねられる点がない`);
    await page.mouse.move(point.x, point.y);
}

test('同じ SVG の写しは id が一意で、見えている写しの塗りと切り抜きは自分の写しの中を指す', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/icons-harness.html');
    await page.waitForFunction(() => 'harness' in window && 'iconsProbe' in window);
    await page.evaluate(
        ({ source, ref, svg }) => {
            const w = window as any;
            w.diagram = w.harness.markdag.render(document.getElementById('a'), source, {
                animate: false,
                resolveIcon: (asked: string) => (asked === ref ? svg : null),
            });
        },
        { source: SOURCE, ref: REF, svg: GRADIENT },
    );
    await page.waitForTimeout(100);
    await hoverNode(page, '本文のロゴ');
    await page.waitForTimeout(400);

    const seen = await copies(page);
    const places = seen.map((copy) => copy.place);
    for (const place of ['body', 'popover', 'tag', 'frame', 'legend']) expect(places, JSON.stringify(places)).toContain(place);
    expect(seen.filter((copy) => copy.place === 'popover').every((copy) => copy.visible), JSON.stringify(seen)).toBe(true);

    const ids = seen.flatMap((copy) => copy.ids);
    expect(ids.length).toBe(seen.length * 2);
    expect(new Set(ids).size, JSON.stringify(ids)).toBe(ids.length);
    const onPage = await page.evaluate((ids) => ids.map((id) => document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length), ids);
    expect(onPage.every((count) => count === 1)).toBe(true);

    const visible = seen.filter((copy) => copy.visible);
    expect(visible.length).toBeGreaterThanOrEqual(5);
    for (const copy of visible) {
        expect(copy.paints, JSON.stringify(copy)).toHaveLength(2);
        for (const paint of copy.paints) expect(paint.own, JSON.stringify(copy)).toBe(true);
    }
    expect(errors).toEqual([]);
});

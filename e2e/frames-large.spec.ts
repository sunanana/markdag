// 大きな文書 (230〜270 ノード、3 段の入れ子の枠、relations の合流あり) を実際のブラウザで描き、枠が崩れていないかを確かめる。
// 描画はノードの実測のサイズを使うので、単体テストの概算のサイズでは確かめられない。確かめること:
// - 枠の矩形に、そのグループのメンバーでないノードが入らない
// - 枠のラベルの文字に、ノードが重ならない。ラベルは、かかった枠の中に収まる (辺をまたがない)
// - 重なる枠は、どちらかがもう一方を含む (入れ子)。ラベルどうしも重ならない
// 開いた状態と、見出しをいくつか閉じた状態の 3 通りで確かめる
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Harness } from './harness';

type TestWindow = Window & { harness: Harness };

const SAMPLES = ['huge-org', 'huge-regions', 'huge-portfolio'];

for (const name of SAMPLES) {
    test(`${name}: 枠にメンバーでないノードが入らず、枠は入れ子か離れている`, async ({ page }) => {
        const text = readFileSync(new URL(`../editor/samples/${name}.md`, import.meta.url), 'utf8');
        await page.setViewportSize({ width: 1800, height: 1100 });
        await page.goto('/e2e/harness.html');
        await page.waitForFunction(() => 'harness' in window);
        const result = await page.evaluate(async (source) => {
            const { markdag } = (window as unknown as TestWindow).harness;
            const element = document.getElementById('a') as HTMLElement;
            element.style.width = '1800px';
            element.style.height = '1100px';
            (document.getElementById('b') as HTMLElement).style.display = 'none';
            const diagram = markdag.render(element, source, { animate: false });
            const parsed = markdag.parseDocument(source);
            const model = markdag.buildModel(parsed.nodes, parsed.frontmatter);
            const context = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
            type Box = { left: number; right: number; top: number; bottom: number };
            const tolerance = 0.5;
            const overlaps = (a: Box, b: Box): boolean =>
                a.left < b.right - tolerance && b.left < a.right - tolerance && a.top < b.bottom - tolerance && b.top < a.bottom - tolerance;
            const inside = (a: Box, b: Box): boolean =>
                a.left >= b.left - tolerance && a.top >= b.top - tolerance && a.right <= b.right + tolerance && a.bottom <= b.bottom + tolerance;
            const check = (): { frames: number; problems: string[] } => {
                const frames = [...element.querySelectorAll<SVGElement>('.mdag-frame[data-group]')]
                    .map((frame) => ({ group: frame.dataset.group ?? '', box: frame.getBoundingClientRect() as Box }))
                    .filter((frame) => frame.box.right > frame.box.left);
                // ラベルは、文字の実際のインクの範囲で見る (getBoundingClientRect はフォントの行送りまで含み、枠より大きくなる)
                const labels = [...element.querySelectorAll<SVGTextElement>('.mdag-frame-label[data-group]')].map((label) => {
                    const style = getComputedStyle(label);
                    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                    const metrics = context.measureText(label.textContent ?? '');
                    const box = label.getBoundingClientRect();
                    const matrix = label.getScreenCTM() as DOMMatrix;
                    const scale = matrix.d;
                    const baseline = matrix.f + Number(label.getAttribute('y')) * scale;
                    return {
                        group: label.dataset.group ?? '',
                        box: { left: box.left, right: box.right, top: baseline - metrics.actualBoundingBoxAscent * scale, bottom: baseline + metrics.actualBoundingBoxDescent * scale },
                    };
                });
                const nodes = [...element.querySelectorAll<HTMLElement>('.mdag-node')]
                    .map((node) => ({ id: Number(node.dataset.id), box: (node.querySelector('.mdag-box') as HTMLElement).getBoundingClientRect() as Box }))
                    .filter((node) => node.box.right > node.box.left && node.box.bottom > node.box.top);
                const problems: string[] = [];
                for (const frame of frames) {
                    for (const node of nodes) {
                        if (overlaps(node.box, frame.box) && !(model.groupsOf.get(node.id) ?? []).includes(frame.group)) {
                            problems.push(`ノード ${parsed.nodes[node.id - 1]?.refText} が枠 ${frame.group} に入っている`);
                        }
                    }
                }
                for (const label of labels) {
                    for (const node of nodes) if (overlaps(node.box, label.box)) problems.push(`ノード ${parsed.nodes[node.id - 1]?.refText} がラベル ${label.group} に重なる`);
                    for (const frame of frames) if (frame.group !== label.group && overlaps(label.box, frame.box) && !inside(label.box, frame.box)) problems.push(`ラベル ${label.group} が枠 ${frame.group} の辺をまたぐ`);
                }
                for (const [index, a] of frames.entries()) {
                    for (const b of frames.slice(index + 1)) {
                        if (overlaps(a.box, b.box) && !inside(a.box, b.box) && !inside(b.box, a.box)) problems.push(`枠 ${a.group} と ${b.group} が交わる`);
                    }
                }
                for (const [index, a] of labels.entries()) {
                    for (const b of labels.slice(index + 1)) if (overlaps(a.box, b.box)) problems.push(`ラベル ${a.group} と ${b.group} が重なる`);
                }
                return { frames: frames.length, problems };
            };
            const hasChildren = (id: number): boolean => parsed.nodes.some((node) => node.parent === id);
            const open = check();
            diagram.view.setFolded(parsed.nodes.filter((node) => node.depth === 3 && hasChildren(node.id)).filter((_, index) => index % 3 === 0).map((node) => node.id));
            const foldedSome = check();
            diagram.view.setFolded(parsed.nodes.filter((node) => node.depth === 2 && hasChildren(node.id)).filter((_, index) => index % 2 === 1).map((node) => node.id));
            const foldedMore = check();
            return { diagnostics: diagram.diagnostics.filter((item) => item.code !== 'not-extracted').length, nodes: parsed.nodes.length, open, foldedSome, foldedMore };
        }, text);
        expect(result.diagnostics).toBe(0);
        expect(result.nodes).toBeGreaterThan(220);
        expect(result.open.frames).toBeGreaterThan(40);
        expect(result.open.problems).toEqual([]);
        expect(result.foldedSome.problems).toEqual([]);
        expect(result.foldedMore.problems).toEqual([]);
    });
}

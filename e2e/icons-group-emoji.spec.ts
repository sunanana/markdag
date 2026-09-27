// グループの icon に絵文字の alias を書いたとき、枠のラベルの前と凡例の行にその絵文字が見えること。
// 絵文字は解決しない (resolveIcon に問い合わせない)。公開の入口 (render) だけを呼ぶ
import { expect, test } from '@playwright/test';

const SOURCE = [
    '---',
    'markdag:',
    '    icons:',
    '        fire: "🔥"',
    '    groups:',
    '        hot:',
    '            label: ホット',
    '            color: "#d9822b"',
    '            boundary: true',
    '            icon: fire',
    '---',
    '',
    '# R',
    '',
    '## クラスタ %hot',
    '- [ ] 中身',
    '',
].join('\n');

test('グループの icon の絵文字の alias を、枠のラベルの前と凡例に出す', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/icons-harness.html');
    await page.waitForFunction(() => 'harness' in window);
    const asked = await page.evaluate((source) => {
        const w = window as any;
        const asked: string[] = [];
        w.diagram = w.harness.markdag.render(document.getElementById('a'), source, {
            animate: false,
            resolveIcon: (ref: string) => {
                asked.push(ref);
                return null;
            },
        });
        return asked;
    }, SOURCE);
    await page.waitForTimeout(100);

    const seen = await page.evaluate(() => {
        const container = document.querySelector('#a')!;
        const label = [...container.querySelectorAll<SVGTextElement>('text.mdag-frame-label')].find((item) => item.textContent === 'ホット');
        const emoji = container.querySelector<SVGTextElement>('text.mdag-frame-icon[data-icon-kind="emoji"]');
        const labelBox = label?.getBoundingClientRect();
        const emojiBox = emoji?.getBoundingClientRect();
        const legendItem = [...container.querySelectorAll('.mdag-legend li')].find((item) => item.textContent?.includes('ホット'));
        const legendEmoji = legendItem?.querySelector<HTMLElement>('.mdag-icon[data-icon-kind="emoji"]');
        const chip = legendItem?.querySelector('.mdag-legend-chip');
        // 前後は字の送り幅 (SVG の座標の始点 + getComputedTextLength) で比べる。firefox の getBoundingClientRect は
        // 文字の箱にはみ出しの余白を足すので、絵文字とラベルの箱が見た目は離れていても重なって出る
        const emojiRight = emoji && emoji.getNumberOfChars() > 0 ? emoji.getStartPositionOfChar(0).x + emoji.getComputedTextLength() : null;
        const labelLeft = label && label.getNumberOfChars() > 0 ? label.getStartPositionOfChar(0).x : null;
        return {
            frameText: emoji?.textContent ?? null,
            frameGroup: emoji?.dataset.group ?? null,
            frameVisible: emoji ? emoji.checkVisibility() && (emojiBox?.width ?? 0) > 0 : false,
            beforeLabel: emojiRight !== null && labelLeft !== null ? emojiRight <= labelLeft : false,
            sameLine: labelBox && emojiBox ? Math.abs(emojiBox.top + emojiBox.height / 2 - (labelBox.top + labelBox.height / 2)) < 6 : false,
            legendText: legendEmoji?.textContent ?? null,
            legendVisible: legendEmoji ? legendEmoji.checkVisibility() && legendEmoji.getBoundingClientRect().width > 0 : false,
            afterChip: chip && legendEmoji ? chip.nextElementSibling === legendEmoji : false,
        };
    });
    expect(seen).toEqual({
        frameText: '🔥',
        frameGroup: 'hot',
        frameVisible: true,
        beforeLabel: true,
        sameLine: true,
        legendText: '🔥',
        legendVisible: true,
        afterChip: true,
    });
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
});

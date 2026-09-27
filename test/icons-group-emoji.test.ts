// グループの icon に絵文字の alias を書いたときの枠のラベルと凡例。絵文字は解決せず、その文字をそのまま出す
import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src/model/model';
import { FRAME_ICON_GAP, FRAME_ICON_SIZE, frameLabelParts, groupIconRefs, groupLogo, IconSvgStore, legendLogoHtml, type IconRenderContext } from '../src/view/icons';

const SOURCE = [
    '---',
    'markdag:',
    '    icons:',
    '        color: mono',
    '        fire: "🔥"',
    '        mono_fire: { ref: "🔥", color: original }',
    '    groups:',
    '        hot: { label: Hot, color: "#d9822b", boundary: true, icon: fire }',
    '        colored: { label: Colored, color: "#4285f4", boundary: true, icon: mono_fire }',
    '---',
    '# R',
    '## A %hot',
    '## C %colored',
].join('\n');

function contextOf(): { model: ReturnType<typeof renderDocument>['model']; context: IconRenderContext; asked: string[] } {
    const { model } = renderDocument(SOURCE);
    const store = new IconSvgStore();
    const asked: string[] = [];
    return {
        model,
        asked,
        context: {
            icons: model.icons,
            svgOf: (ref) => {
                asked.push(ref);
                return store.get(ref);
            },
        },
    };
}

const groupOf = (model: ReturnType<typeof renderDocument>['model'], id: string) => model.groups.find((group) => group.id === id) ?? { icon: undefined };

describe('グループの icon の絵文字の alias', () => {
    it('モデルは診断なしで alias を載せる', () => {
        const { model } = contextOf();
        expect(groupOf(model, 'hot').icon).toBe('fire');
        expect(model.diagnostics.filter((item) => item.code === 'icon-invalid')).toEqual([]);
    });

    it('groupLogo は絵文字の文字を返し、SVG を引かない', () => {
        const { model, context, asked } = contextOf();
        expect(groupLogo(groupOf(model, 'hot'), context)).toMatchObject({ kind: 'emoji', alias: 'fire', text: '🔥' });
        expect(asked).toEqual([]);
    });

    it('枠のラベルは絵文字を文字の左に置き、ロゴと同じだけ文字を右にずらす', () => {
        const { model, context } = contextOf();
        const parts = frameLabelParts(groupOf(model, 'hot'), 100, 50, '#d9822b', context);
        expect(parts.textX).toBe(100 + FRAME_ICON_SIZE + FRAME_ICON_GAP);
        expect(parts.logo).toBeNull();
        expect(parts.emoji).toEqual({ x: 100, y: 50, alias: 'fire', text: '🔥' });
    });

    it('凡例は本文と同じ絵文字の span (色の印を付けない)', () => {
        const { model, context } = contextOf();
        expect(legendLogoHtml(groupOf(model, 'hot'), context)).toBe('<span class="mdag-icon" data-icon="fire" data-icon-kind="emoji">🔥</span>');
    });

    it('alias ごとの color を書いても、絵文字には色の規則を当てない', () => {
        const { model, context } = contextOf();
        const html = legendLogoHtml(groupOf(model, 'colored'), context) ?? '';
        expect(html).not.toContain('data-icon-color');
        expect(html).toContain('data-icon-kind="emoji"');
        const parts = frameLabelParts(groupOf(model, 'colored'), 0, 20, '#4285f4', context);
        expect(parts.logo).toBeNull();
        expect(parts.emoji).toMatchObject({ text: '🔥' });
    });

    it('文脈がなければ出さず、文字もずれない', () => {
        const { model } = contextOf();
        expect(frameLabelParts(groupOf(model, 'hot'), 100, 50, '#d9822b', null)).toEqual({ textX: 100, logo: null });
        expect(legendLogoHtml(groupOf(model, 'hot'), null)).toBeNull();
    });

    it('絵文字は問い合わせる ref に入れない', () => {
        const { model } = contextOf();
        expect([...groupIconRefs(model)]).toEqual([]);
    });
});

// 同じ SVG を複数の場所に置いたときの id。写しごとに id を付け直し、同じ写しの中の参照 (url(#id)、href="#id") を合わせる。
// 置き場の SVG の文字列は共有したまま、ページに入れる HTML を作るたびに付け直す
import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src/model/model';
import { frameLabelParts, iconMarkHtml, IconSvgStore, legendLogoHtml, sanitizeSvg, tagsHtml, type IconRenderContext } from '../src/view/icons';

const GRADIENT = [
    '<svg viewBox="0 0 24 24">',
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
    '<clipPath id="c"><rect width="24" height="24" rx="4"/></clipPath></defs>',
    '<path id="p" d="M0 0h24v24H0z" fill="url(#g)" clip-path="url(#c)"/><use href="#p"/>',
    '</svg>',
].join('');
const PLAIN = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

const source = [
    '---',
    'markdag:',
    '    icons:',
    '        grad: { ref: simple-icons:grad, color: original }',
    '    tags:',
    '        keys:',
    '            tool:',
    '                type: string',
    '                icons: { grad: grad }',
    '    groups:',
    '        infra:',
    '            label: インフラ',
    '            icon: grad',
    '---',
    '# R',
    '## A %infra #tool:grad',
].join('\n');

function contextOf(svg: string): { model: ReturnType<typeof renderDocument>['model']; context: IconRenderContext; store: IconSvgStore } {
    const { model } = renderDocument(source);
    const store = new IconSvgStore();
    store.set('simple-icons:grad', svg);
    return { model, store, context: { icons: model.icons, svgOf: (ref) => store.get(ref) } };
}

const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1] ?? '');

// 写しの中の参照先の id。url(#id) (引用符つきを含む) と href / xlink:href の #id
const refsOf = (html: string): string[] => [
    ...[...html.matchAll(/url\(\s*(?:"|'|&quot;)?#([^"')\s&]+)/g)].map((match) => match[1] ?? ''),
    ...[...html.matchAll(/\s(?:xlink:)?href="#([^"]*)"/g)].map((match) => match[1] ?? ''),
];

// 付け直したあとの id を、元の名前に戻した文字 (付け直した名前は写しの id の並びから引く)
function withOriginalIds(html: string, originals: string[]): string {
    const renamed = idsOf(html);
    expect(renamed).toHaveLength(originals.length);
    return renamed.reduce((text, id, index) => text.split(id).join(`{${originals[index]}}`), html);
}

describe('同じ SVG の写しごとの id', () => {
    it('同じ SVG を 2 回入れると id が重ならず、それぞれの参照が自分の写しの id を指す', () => {
        const { context } = contextOf(GRADIENT);
        const first = iconMarkHtml('grad', context);
        const second = iconMarkHtml('grad', context);
        const firstIds = idsOf(first);
        const secondIds = idsOf(second);
        expect(firstIds).toHaveLength(3);
        expect(secondIds).toHaveLength(3);
        expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
        expect(refsOf(first).length).toBe(3);
        for (const ref of refsOf(first)) expect(firstIds).toContain(ref);
        for (const ref of refsOf(second)) expect(secondIds).toContain(ref);
    });

    it('付け直すのは id と参照だけで、ほかは消毒したあとの SVG のまま', () => {
        const { context } = contextOf(GRADIENT);
        const html = iconMarkHtml('grad', context);
        const clean = sanitizeSvg(GRADIENT) ?? '';
        expect(withOriginalIds(html, ['g', 'c', 'p'])).toBe(
            `<span class="mdag-icon" data-icon="grad" data-icon-color="original" role="img" title=":grad:" aria-label=":grad:">${clean
                .replace('id="g"', 'id="{g}"')
                .replace('id="c"', 'id="{c}"')
                .replace('id="p"', 'id="{p}"')
                .replace('url(#g)', 'url(#{g})')
                .replace('url(#c)', 'url(#{c})')
                .replace('href="#p"', 'href="#{p}"')}</span>`,
        );
    });

    it('参照の書き方の各形 (属性の url()、引用符つきの url()、空白入りの url()、style の中の url()、href、xlink:href) を合わせる', () => {
        const svg = [
            '<svg viewBox="0 0 24 24" xmlns:xlink="http://www.w3.org/1999/xlink">',
            '<defs><linearGradient id="a"/><mask id="m"/><filter id="f"/><marker id="k"/><clipPath id="c"/><path id="p" d="M0 0"/></defs>',
            '<path d="M0 0" fill="url(#a)" stroke="url(#a)" mask="url(#m)" filter="url(#f)" marker-end="url(#k)" clip-path="url(#c)"/>',
            `<path d="M1 1" fill='url("#a")' stroke="url('#a')" clip-path="url( #c )"/>`,
            '<path d="M2 2" style="fill: url(#a); stroke:url(\'#a\')"/>',
            '<use href="#p"/><use xlink:href="#p"/>',
            '</svg>',
        ].join('');
        const { context } = contextOf(svg);
        const html = withOriginalIds(iconMarkHtml('grad', context), ['a', 'm', 'f', 'k', 'c', 'p']);
        expect(html).toContain('<path d="M0 0" fill="url(#{a})" stroke="url(#{a})" mask="url(#{m})" filter="url(#{f})" marker-end="url(#{k})" clip-path="url(#{c})"/>');
        expect(html).toContain('<path d="M1 1" fill="url(&quot;#{a}&quot;)" stroke="url(\'#{a}\')" clip-path="url( #{c} )"/>');
        expect(html).toContain('<path d="M2 2" style="fill: url(#{a}); stroke:url(\'#{a}\')"/>');
        expect(html).toContain('<use href="#{p}"/><use xlink:href="#{p}"/>');
    });

    it('ルートの fill に書いた一重引用符の url() も、包む g に移したあとで写しの id に合わせる', () => {
        const svg = `<svg viewBox="0 0 24 24" fill="url('#g')"><linearGradient id="g"/><path d="M0 0h24v24H0z"/></svg>`;
        const { context } = contextOf(svg);
        const html = withOriginalIds(iconMarkHtml('grad', context), ['g']);
        expect(html).toContain(`<g fill="url('#{g}')"><linearGradient id="{g}"/>`);
    });

    it('空白や ) を含む id も、引用符つきの url() を閉じの引用符まで id として読んで合わせる', () => {
        const svg = [
            '<svg viewBox="0 0 24 24">',
            '<linearGradient id="a b"/><linearGradient id="a)b"/>',
            `<rect fill="url('#a b')" stroke='url("#a b")'/><rect fill="url( '#a)b' )"/>`,
            '<use href="#a b"/>',
            '</svg>',
        ].join('');
        const { context } = contextOf(svg);
        const html = withOriginalIds(iconMarkHtml('grad', context), ['a b', 'a)b']);
        expect(html).toContain(`<rect fill="url('#{a b}')" stroke="url(&quot;#{a b}&quot;)"/>`);
        expect(html).toContain(`<rect fill="url( '#{a)b}' )"/>`);
        expect(html).toContain('<use href="#{a b}"/>');
    });

    it('空の id は付け直さず、href="#" と url(#) も元のまま (付け直す前と同じ描画)', () => {
        const svg = '<svg viewBox="0 0 24 24"><linearGradient id=""/><use href="#"/><rect fill="url(#)" stroke="url(\'#\')"/></svg>';
        const { context } = contextOf(svg);
        const html = iconMarkHtml('grad', context);
        expect(html).toContain(`${sanitizeSvg(svg)}</span>`);
        const mixed = '<svg viewBox="0 0 24 24"><linearGradient id=""/><linearGradient id="x"/><use href="#"/><rect fill="url(#x)"/></svg>';
        const withX = withOriginalIds(iconMarkHtml('grad', contextOf(mixed).context).replace(' id=""', ' data-empty=""'), ['x']);
        expect(withX).toContain('<linearGradient data-empty=""/><linearGradient id="{x}"/><use href="#"/><rect fill="url(#{x})"/>');
    });

    it('写しの中にない id への参照は変えない', () => {
        const svg = '<svg viewBox="0 0 24 24"><linearGradient id="a"/><path d="M0 0" fill="url(#a)" stroke="url(#elsewhere)"/><use href="#elsewhere"/></svg>';
        const { context } = contextOf(svg);
        const html = withOriginalIds(iconMarkHtml('grad', context), ['a']);
        expect(html).toContain('fill="url(#{a})" stroke="url(#elsewhere)"/><use href="#elsewhere"/>');
    });

    it('同じ id が写しの中に 2 つあれば同じ名前に付け直す', () => {
        const svg = '<svg viewBox="0 0 24 24"><linearGradient id="a"/><linearGradient id="a"/><path d="M0 0" fill="url(#a)"/></svg>';
        const { context } = contextOf(svg);
        const ids = idsOf(iconMarkHtml('grad', context));
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(ids[1]);
    });

    it('付け直した id は SVG の id として正しい文字だけ (元の id に空白や記号があっても)', () => {
        const svg = '<svg viewBox="0 0 24 24"><linearGradient id="9 a:b.c"/><linearGradient id="x"/><path d="M0 0" fill="url(#x)"/></svg>';
        const { context } = contextOf(svg);
        for (const id of idsOf(iconMarkHtml('grad', context))) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
    });

    it('本文の印、タグ、枠のラベル、凡例のロゴは、どれも別の写し (id が重ならない)', () => {
        const { model, context } = contextOf(GRADIENT);
        const group = model.groups.find((item) => item.id === 'infra') ?? { icon: undefined };
        const copies = [
            iconMarkHtml('grad', context),
            tagsHtml([{ key: 'tool', values: ['grad'] }], model.tagKeys, context) ?? '',
            frameLabelParts(group, 0, 20, '#888', context).logo?.svg ?? '',
            legendLogoHtml(group, context) ?? '',
        ];
        const all = copies.flatMap(idsOf);
        expect(all).toHaveLength(12);
        expect(new Set(all).size).toBe(12);
        for (const copy of copies) for (const ref of refsOf(copy)) expect(idsOf(copy)).toContain(ref);
    });

    it('置き場の SVG は付け直さない (写しを作るたびに付け直す)', () => {
        const { store, context } = contextOf(GRADIENT);
        iconMarkHtml('grad', context);
        expect(store.get('simple-icons:grad')).toBe(sanitizeSvg(GRADIENT));
        expect(idsOf(store.get('simple-icons:grad') ?? '')).toEqual(['g', 'c', 'p']);
    });

    it('id を持たない SVG は今と同じ出力', () => {
        const { context } = contextOf(PLAIN);
        expect(iconMarkHtml('grad', context)).toBe(
            `<span class="mdag-icon" data-icon="grad" data-icon-color="original" role="img" title=":grad:" aria-label=":grad:">${PLAIN}</span>`,
        );
    });
});

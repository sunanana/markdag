// 本文とタグのロゴの描画 (HTML の組み立て)。SVG は描画の側の置き場から引き、引けないものは文字のまま残す
import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src/model/model';
import { documentIconRefs, FRAME_ICON_GAP, FRAME_ICON_SIZE, frameLabelParts, groupIconRefs, IconSvgStore, legendLogoHtml, nodeIconRefs, renderIconMarks, sanitizeSvg, tagLineContent, tagsHtml, withIconMarks, type IconRenderContext } from '../src/view/icons';

const GITHUB = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const SENTRY = '<svg viewBox="0 0 24 24"><path d="M1 1h2v2H1z"/></svg>';

const source = (color = 'mono'): string =>
    [
        '---',
        'markdag:',
        '    icons:',
        `        color: ${color}`,
        '        github: simple-icons:github',
        '        sentry: simple-icons:sentry',
        '        vm: { ref: ./azure/vm.svg, color: original }',
        '        rocket: "🚀"',
        '    tags:',
        '        keys:',
        '            tool:',
        '                multiple: true',
        '                icons: { github: github, sentry: sentry, rocket: rocket }',
        '            oncall:',
        '                type: boolean',
        '                icon: sentry',
        '---',
        '# R',
        '## :github: Push',
        '## :rocket: Release',
        '## :vm: VM',
        '## A #tool:sentry,jira,github #oncall',
    ].join('\n');

function contextOf(markdown: string, svgs: Record<string, string>): { model: ReturnType<typeof renderDocument>['model']; parsed: ReturnType<typeof renderDocument>['parsed']; context: IconRenderContext } {
    const { parsed, model } = renderDocument(markdown);
    const store = new IconSvgStore();
    for (const [ref, svg] of Object.entries(svgs)) store.set(ref, svg);
    return { parsed, model, context: { icons: model.icons, svgOf: (ref) => store.get(ref) } };
}

const htmlOf = (parsed: ReturnType<typeof renderDocument>['parsed'], id: number): string => parsed.nodes[id - 1]?.html ?? '';

describe('本文の :alias: のロゴ', () => {
    it('SVG が引けたら印をロゴに差し替え、文書の色 (mono) を付ける', () => {
        const { parsed, context } = contextOf(source(), { 'simple-icons:github': GITHUB });
        expect(renderIconMarks(htmlOf(parsed, 2), context)).toBe(
            `<span class="mdag-icon" data-icon="github" data-icon-color="mono" role="img" title=":github:" aria-label=":github:">${GITHUB}</span> Push`,
        );
    });

    it('SVG が引けなければ (未解決と失敗のどちらも) 印の文字のまま', () => {
        const pending = contextOf(source(), {});
        expect(renderIconMarks(htmlOf(pending.parsed, 2), pending.context)).toBe(htmlOf(pending.parsed, 2));
        const { parsed, model } = renderDocument(source());
        const store = new IconSvgStore();
        store.set('simple-icons:github', null);
        expect(renderIconMarks(htmlOf(parsed, 2), { icons: model.icons, svgOf: (ref) => store.get(ref) })).toBe(
            '<span class="mdag-icon" data-icon="github">:github:</span> Push',
        );
    });

    it('絵文字の alias は解決せず、その文字を出す', () => {
        const { parsed, context } = contextOf(source(), {});
        expect(renderIconMarks(htmlOf(parsed, 3), context)).toBe('<span class="mdag-icon" data-icon="rocket" data-icon-kind="emoji">🚀</span> Release');
    });

    it('文書の色が original ならそれを付け、alias ごとの color は文書の色より優先', () => {
        const svgs = { 'simple-icons:github': GITHUB, './azure/vm.svg': SENTRY };
        const mono = contextOf(source('mono'), svgs);
        expect(renderIconMarks(htmlOf(mono.parsed, 4), mono.context)).toContain('data-icon-color="original"');
        const original = contextOf(source('original'), svgs);
        expect(renderIconMarks(htmlOf(original.parsed, 2), original.context)).toContain('data-icon="github" data-icon-color="original"');
    });

    it('icons を書いていない文書の HTML は変わらない', () => {
        const { parsed, model } = renderDocument('# R\n## :github: Push');
        const html = htmlOf(parsed, 2);
        expect(html).not.toContain('mdag-icon');
        expect(renderIconMarks(html, { icons: model.icons, svgOf: () => GITHUB })).toBe(html);
    });
});

describe('タグのロゴ', () => {
    it('キーの印、値の順のロゴ、書いたとおりの文字の順に並べる。対応表にない値は文字だけ', () => {
        const { model, context } = contextOf(source(), { 'simple-icons:github': GITHUB, 'simple-icons:sentry': SENTRY });
        const logo = (alias: string, svg: string): string => `<span class="mdag-icon" data-icon="${alias}" data-icon-color="mono" role="img">${svg}</span>`;
        expect(tagsHtml(model.tagsOf.get(5) ?? [], model.tagKeys, context)).toBe(
            `${logo('sentry', SENTRY)}${logo('github', GITHUB)}#tool:sentry,jira,github ${logo('sentry', SENTRY)}#oncall`,
        );
    });

    it('引けたロゴだけを出し、1 つも引けなければ null (文字だけで描く)', () => {
        const partial = contextOf(source(), { 'simple-icons:github': GITHUB });
        const html = tagsHtml(partial.model.tagsOf.get(5) ?? [], partial.model.tagKeys, partial.context) ?? '';
        expect(html.match(/data-icon="[a-z]+"/g)).toEqual(['data-icon="github"']);
        expect(html).toContain('#tool:sentry,jira,github #oncall');
        const none = contextOf(source(), {});
        expect(tagsHtml(none.model.tagsOf.get(5) ?? [], none.model.tagKeys, none.context)).toBeNull();
    });

    it('絵文字の値のロゴは文字で出し、文字は書いたとおりにエスケープする', () => {
        const { model, context } = contextOf(source(), {});
        const tags = [{ key: 'tool', values: ['rocket', 'a<b'] }];
        expect(tagsHtml(tags, model.tagKeys, context)).toBe('<span class="mdag-icon" data-icon="rocket" data-icon-kind="emoji">🚀</span>#tool:rocket,a&lt;b');
    });
});

describe('描き直しに使う ref の一覧', () => {
    it('ノードと文書が使う ref。絵文字は含めない', () => {
        const { parsed, model } = renderDocument(source());
        expect([...nodeIconRefs(parsed.nodes[1] ?? { html: '' }, [], model)]).toEqual(['simple-icons:github']);
        expect([...nodeIconRefs(parsed.nodes[2] ?? { html: '' }, [], model)]).toEqual([]);
        expect([...nodeIconRefs(parsed.nodes[4] ?? { html: '' }, model.tagsOf.get(5) ?? [], model)]).toEqual(['simple-icons:sentry', 'simple-icons:github']);
        expect([...documentIconRefs(parsed.nodes, model)].sort()).toEqual(['./azure/vm.svg', 'simple-icons:github', 'simple-icons:sentry']);
    });
});

describe('SVG の置き場とサニタイズ', () => {
    it('置き場は入れたものが変わったときだけ true を返す', () => {
        const store = new IconSvgStore();
        expect(store.get('a:b')).toBeUndefined();
        expect(store.set('a:b', null)).toBe(true);
        expect(store.set('a:b', null)).toBe(false);
        expect(store.set('a:b', GITHUB)).toBe(true);
        expect(store.set('a:b', GITHUB)).toBe(false);
        expect(store.get('a:b')).toBe(GITHUB);
        expect(store.set('a:b', 'not svg')).toBe(true);
        expect(store.get('a:b')).toBeNull();
    });

    it('script、style、on* 属性、外への href、title を落とし、ルートの大きさを外す', () => {
        const dirty = [
            '<?xml version="1.0"?><!-- c -->',
            '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" class="x" onload="alert(1)">',
            '<title>Logo</title><style>body{display:none}</style><script>alert(1)</script>',
            '<a href="javascript:alert(1)"><path onclick="x()" d="M0 0"/></a>',
            '<use href="#p"/><image xlink:href="https://example.com/t.png"/>',
            '<set attributeName="href" to="javascript:x"/>',
            '</svg>',
        ].join('');
        expect(sanitizeSvg(dirty)).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><g><path d="M0 0"/></g><use href="#p"/><image/></svg>');
    });

    it('ルートの fill は中身を包む g に移し、svg 1 つでないものは null', () => {
        expect(sanitizeSvg('<svg viewBox="0 0 1 1" fill="#f00"><path d="M0 0"/></svg>')).toBe('<svg viewBox="0 0 1 1"><g fill="#f00"><path d="M0 0"/></g></svg>');
        expect(sanitizeSvg('<img src=x onerror=alert(1)>')).toBeNull();
        expect(sanitizeSvg('<svg></svg><script>alert(1)</script>')).toBeNull();
    });

    // 属性の区切りが空白でない書き方 (HTML の構文解析は引用符の直後や / のあとにも次の属性を作る) と、分けて書いた script
    it('引用符や / の直後の on* 属性と、除去で組み上がる script を残さない', () => {
        const cases: Array<[string, string]> = [
            ['<svg viewBox="0 0 1 1"><img src="x"onerror="alert(1)"></svg>', '<svg viewBox="0 0 1 1"></svg>'],
            ['<svg viewBox="0 0 1 1"><rect width="1"height="1"onmouseover="alert(1)"/></svg>', '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>'],
            ['<svg viewBox="0 0 1 1"><rect/onmouseover="alert(1)"/></svg>', '<svg viewBox="0 0 1 1"><rect/></svg>'],
            ['<svg xmlns="http://www.w3.org/2000/svg"onload="alert(1)"><path d="M0 0"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
        ];
        for (const [input, output] of cases) expect(sanitizeSvg(input), input).toBe(output);
        const split = sanitizeSvg('<svg viewBox="0 0 1 1"><scr<script>ipt>alert(1)</scr<script>ipt></svg>');
        expect(split).not.toMatch(/<script/i);
        expect(split).not.toContain('alert');
    });

    it('外へ読みに行く href、src、style と属性の url()、svg の後ろの要素を残さない', () => {
        const cases: Array<[string, string | null]> = [
            ['<svg viewBox="0 0 1 1"><image x="0"href="https://example.com/t.png"/></svg>', '<svg viewBox="0 0 1 1"><image x="0"/></svg>'],
            ['<svg viewBox="0 0 1 1"><img src="https://example.com/p.png"></svg>', '<svg viewBox="0 0 1 1"></svg>'],
            ['<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.com/x.svg#a)"/></svg>', '<svg viewBox="0 0 1 1"><rect/></svg>'],
            ['<svg viewBox="0 0 1 1"><rect fill="url(https://example.com/x.svg#a)"/></svg>', '<svg viewBox="0 0 1 1"><rect/></svg>'],
            ['<svg viewBox="0 0 1 1"></svg><img src="https://example.com/p.png"><svg></svg>', null],
            // 文書の中を指す url(#id) と href="#id" は残す
            ['<svg viewBox="0 0 1 1"><rect style="fill:url(#g)" fill="url( \'#g\' )"/><use href="#p"/></svg>', '<svg viewBox="0 0 1 1"><rect style="fill:url(#g)" fill="url( \'#g\' )"/><use href="#p"/></svg>'],
        ];
        for (const [input, output] of cases) expect(sanitizeSvg(input), input).toBe(output);
    });

    it('許可していない要素は中身ごと落とし、許可した要素の中の文字は残す', () => {
        expect(sanitizeSvg('<svg viewBox="0 0 1 1"><foo><path d="M0 0"/></foo><text x="0">a &amp; b</text></svg>')).toBe('<svg viewBox="0 0 1 1"><text x="0">a &amp; b</text></svg>');
        expect(sanitizeSvg('<svg viewBox="0 0 1 1"><p>x</p><path d="M1 1"/></svg>')).toBe('<svg viewBox="0 0 1 1"><path d="M1 1"/></svg>');
        expect(sanitizeSvg('<svg viewBox="0 0 1 1"><foo><g><path d="M0 0"/></g></foo><g><path d="M1 1"/></svg>')).toBe('<svg viewBox="0 0 1 1"><g><path d="M1 1"/></g></svg>');
    });
});

describe('グループの枠のラベルと凡例のロゴ', () => {
    const AWS = '<svg viewBox="0 0 24 24"><path fill="#f90" d="M0 0h24v24H0z"/></svg>';
    const groupSource = (color = 'mono'): string =>
        [
            '---',
            'markdag:',
            '    icons:',
            `        color: ${color}`,
            '        aws: simple-icons:amazonaws',
            '        gcp: { ref: logos:google-cloud, color: original }',
            '    groups:',
            '        aws: { label: AWS, color: "#d9822b", boundary: true, icon: aws }',
            '        gcp: { label: GCP, color: "#4285f4", boundary: true, icon: gcp }',
            '        plain: { label: Plain, color: "#888888", boundary: true }',
            '---',
            '# R',
            '## A %aws',
            '## B %gcp',
            '## C %plain',
        ].join('\n');
    const groupOf = (model: ReturnType<typeof renderDocument>['model'], id: string) => model.groups.find((group) => group.id === id) ?? { icon: undefined };

    it('SVG が引けたら、枠のラベルの前にロゴを置き、文字をロゴの幅と間だけ右にずらす (mono はグループの色)', () => {
        const { model, context } = contextOf(groupSource(), { 'simple-icons:amazonaws': AWS });
        const parts = frameLabelParts(groupOf(model, 'aws'), 100, 50, '#d9822b', context);
        expect(parts.textX).toBe(100 + FRAME_ICON_SIZE + FRAME_ICON_GAP);
        expect(parts.logo).toMatchObject({ x: 100, size: 14, alias: 'aws', color: 'mono', paint: '#d9822b' });
        expect(parts.logo?.y).toBe(50 - 4 - 7);
        expect(parts.logo?.svg).toContain('<path');
    });

    it('SVG が引けない (未解決と失敗)、icon がない、文脈がないときはロゴなしで、文字はずれない', () => {
        const pending = contextOf(groupSource(), {});
        expect(frameLabelParts(groupOf(pending.model, 'aws'), 100, 50, '#d9822b', pending.context)).toEqual({ textX: 100, logo: null });
        const failed = contextOf(groupSource(), {});
        const store = new IconSvgStore();
        store.set('simple-icons:amazonaws', null);
        expect(frameLabelParts(groupOf(failed.model, 'aws'), 100, 50, '#d9822b', { icons: failed.model.icons, svgOf: (ref) => store.get(ref) }).logo).toBeNull();
        const { model, context } = contextOf(groupSource(), { 'simple-icons:amazonaws': AWS });
        expect(frameLabelParts(groupOf(model, 'plain'), 100, 50, '#888888', context)).toEqual({ textX: 100, logo: null });
        expect(frameLabelParts(groupOf(model, 'aws'), 100, 50, '#d9822b', null)).toEqual({ textX: 100, logo: null });
        expect(legendLogoHtml(groupOf(pending.model, 'aws'), pending.context)).toBeNull();
        expect(legendLogoHtml(groupOf(model, 'plain'), context)).toBeNull();
    });

    it('original (文書の色か alias ごとの color) は元の色のままで、塗る色を持たない', () => {
        const { model, context } = contextOf(groupSource('original'), { 'simple-icons:amazonaws': AWS, 'logos:google-cloud': AWS });
        expect(frameLabelParts(groupOf(model, 'aws'), 0, 20, '#d9822b', context).logo).toMatchObject({ color: 'original', paint: null });
        const mono = contextOf(groupSource(), { 'logos:google-cloud': AWS });
        expect(frameLabelParts(groupOf(mono.model, 'gcp'), 0, 20, '#4285f4', mono.context).logo).toMatchObject({ color: 'original', paint: null });
    });

    it('凡例のロゴは色の印を付けた span (mono の色は CSS が薄い色にする)', () => {
        const { model, context } = contextOf(groupSource(), { 'simple-icons:amazonaws': AWS, 'logos:google-cloud': AWS });
        const html = legendLogoHtml(groupOf(model, 'aws'), context) ?? '';
        expect(html.startsWith('<span class="mdag-icon" data-icon="aws" data-icon-color="mono" role="img">')).toBe(true);
        expect(html).toContain('<path');
        expect(legendLogoHtml(groupOf(model, 'gcp'), context)).toContain('data-icon-color="original"');
    });

    it('グループのロゴの ref を集める', () => {
        const { model } = renderDocument(groupSource());
        expect([...groupIconRefs(model)].sort()).toEqual(['logos:google-cloud', 'simple-icons:amazonaws']);
    });
});

describe('吹き出しの中の詳細とタグの行のロゴ', () => {
    const popoverSource = [
        '---',
        'markdag:',
        '    icons:',
        '        github: simple-icons:github',
        '        sentry: simple-icons:sentry',
        '    tags:',
        '        keys:',
        '            tool:',
        '                multiple: true',
        '                icons: { github: github }',
        '---',
        '# R',
        '- A #tool:github,jira',
        '    > :sentry: で見る',
    ].join('\n');
    const detailsOf = (parsed: ReturnType<typeof renderDocument>['parsed']): string => parsed.nodes[1]?.details ?? '';

    it('詳細の :alias: は、引けたら本文と同じロゴ (1em の span、mono) にする', () => {
        const { parsed, context } = contextOf(popoverSource, { 'simple-icons:sentry': SENTRY });
        const html = withIconMarks(detailsOf(parsed), context);
        expect(html).toContain(`<span class="mdag-icon" data-icon="sentry" data-icon-color="mono" role="img" title=":sentry:" aria-label=":sentry:">${SENTRY}</span> で見る`);
        expect(html).toBe(renderIconMarks(detailsOf(parsed), context));
    });

    it('詳細の :alias: は、引けない (未解決と失敗) か文脈がなければ文字のまま', () => {
        const pending = contextOf(popoverSource, {});
        expect(withIconMarks(detailsOf(pending.parsed), pending.context)).toBe(detailsOf(pending.parsed));
        const store = new IconSvgStore();
        store.set('simple-icons:sentry', null);
        expect(withIconMarks(detailsOf(pending.parsed), { icons: pending.model.icons, svgOf: (ref) => store.get(ref) })).toBe(detailsOf(pending.parsed));
        expect(detailsOf(pending.parsed)).toContain('<span class="mdag-icon" data-icon="sentry">:sentry:</span>');
        const plain = renderDocument('# R\n- A\n    > :sentry: で見る');
        expect(withIconMarks(detailsOf(plain.parsed), null)).toBe(detailsOf(plain.parsed));
    });

    it('タグの行は、引けたらノードの中のタグと同じ HTML (ロゴ + 書いたとおりの文字)', () => {
        const { model, context } = contextOf(popoverSource, { 'simple-icons:github': GITHUB });
        const tags = model.tagsOf.get(2) ?? [];
        expect(tagLineContent(tags, model.tagKeys, context)).toEqual({
            html: `<span class="mdag-icon" data-icon="github" data-icon-color="mono" role="img">${GITHUB}</span>#tool:github,jira`,
        });
        expect(tagLineContent(tags, model.tagKeys, context)).toEqual({ html: tagsHtml(tags, model.tagKeys, context) });
    });

    it('タグの行は、1 つも引けないか文脈がなければ書いたとおりの文字', () => {
        const { model, context } = contextOf(popoverSource, {});
        const tags = model.tagsOf.get(2) ?? [];
        expect(tagLineContent(tags, model.tagKeys, context)).toEqual({ text: '#tool:github,jira' });
        const plain = renderDocument('---\nmarkdag:\n    tags: {}\n---\n# R\n- A #x:1 #y');
        expect(tagLineContent(plain.model.tagsOf.get(2) ?? [], plain.model.tagKeys, null)).toEqual({ text: '#x:1 #y' });
    });

    it('詳細にだけ書いた alias の ref も、そのノードの描き直しの対象に入る', () => {
        const { parsed, model } = renderDocument(popoverSource);
        expect([...nodeIconRefs(parsed.nodes[1] ?? { html: '' }, model.tagsOf.get(2) ?? [], model)].sort()).toEqual(['simple-icons:github', 'simple-icons:sentry']);
    });
});

// 置き場の変わり方。IconSvgStore と sanitizeSvg の呼び方の今の振る舞いを固定する
describe('SVG の置き場の変わり方', () => {
    const DIRTY = '<svg width="24" height="24" onload="x()"><path d="M0 0"/></svg>';

    it('入れるときに sanitizeSvg を通し、通したあとの文字で変化を判定する', () => {
        const store = new IconSvgStore();
        expect(store.set('a:b', DIRTY)).toBe(true);
        expect(store.get('a:b')).toBe(sanitizeSvg(DIRTY));
        expect(store.get('a:b')).toBe('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>');
        expect(store.set('a:b', DIRTY)).toBe(false);
        expect(store.set('a:b', sanitizeSvg(DIRTY) ?? '')).toBe(false);
    });

    it('読めない文字列は null と同じ。未入力から入れると true、null のところへ入れると false', () => {
        const store = new IconSvgStore();
        expect(store.set('a:b', 'not svg')).toBe(true);
        expect(store.get('a:b')).toBeNull();
        expect(store.set('a:b', 'still not svg')).toBe(false);
        expect(store.set('a:b', null)).toBe(false);
        expect(store.set('a:b', GITHUB)).toBe(true);
        expect(store.set('a:b', 'not svg')).toBe(true);
        expect(store.get('a:b')).toBeNull();
    });

    it('ref ごとに別で、clear で未入力に戻る', () => {
        const store = new IconSvgStore();
        store.set('a:b', GITHUB);
        expect(store.get('a:c')).toBeUndefined();
        expect(store.set('a:c', GITHUB)).toBe(true);
        store.clear();
        expect(store.get('a:b')).toBeUndefined();
        expect(store.set('a:b', null)).toBe(true);
    });
});

// ref の集め方の細部 (「絵文字でなければ足す」と「タグのキーを引く」の 2 か所ずつの式)
describe('ref の集め方の細部', () => {
    const tagSource = [
        '---',
        'markdag:',
        '    icons:',
        '        a: set:a',
        '        b: ./b.svg',
        '        k: set:k',
        '        smile: "😀"',
        '    tags:',
        '        keys:',
        '            tool:',
        '                multiple: true',
        '                icon: k',
        '                icons: { x: b, y: a, z: smile, w: nope }',
        '            flag:',
        '                type: boolean',
        '                icon: smile',
        '    groups:',
        '        g1: { icon: a }',
        '        g2: { icon: logos:aws }',
        '        g3: { icon: smile }',
        '        g4: { icon: azure }',
        '        g5: { label: G5 }',
        '---',
        '# R',
        '## :a: :b: :a: :smile: :nope: A #tool:y,x,z,w,v #flag #other:x %g1 %g2 %g3 %g4 %g5',
        '## B #tool',
    ].join('\n');

    it('ノードの ref は本文の印が先、次にタグ (キーの印、値の順)。重なりは 1 つ、絵文字と表にない alias は入れない', () => {
        const { parsed, model } = renderDocument(tagSource);
        expect([...nodeIconRefs(parsed.nodes[1] ?? { html: '' }, model.tagsOf.get(2) ?? [], model)]).toEqual(['set:a', './b.svg', 'set:k']);
        // 値のないタグもキーの印は付く
        expect([...nodeIconRefs(parsed.nodes[2] ?? { html: '' }, model.tagsOf.get(3) ?? [], model)]).toEqual(['set:k']);
        expect([...nodeIconRefs({ html: '' }, [{ key: 'other', values: ['x'] }], model)]).toEqual([]);
    });

    it('グループの ref は alias を表で引き、なければ : を含む名前。絵文字、表にない alias、icon のないグループは入れない', () => {
        const { model } = renderDocument(tagSource);
        expect([...groupIconRefs(model)]).toEqual(['set:a', 'logos:aws']);
    });

    it('文書の ref はノードの順に集めてからグループ', () => {
        const { parsed, model } = renderDocument(tagSource);
        expect([...documentIconRefs(parsed.nodes, model)]).toEqual(['set:a', './b.svg', 'set:k', 'logos:aws']);
    });

    it('タグの並びは、定義のないキーのタグを文字だけで出し、キーの印と値のロゴを引けた分だけ付ける', () => {
        const { model, context } = contextOf(tagSource, { 'set:k': GITHUB, './b.svg': SENTRY });
        const logo = (alias: string, svg: string): string => `<span class="mdag-icon" data-icon="${alias}" data-icon-color="mono" role="img">${svg}</span>`;
        const emoji = '<span class="mdag-icon" data-icon="smile" data-icon-kind="emoji">😀</span>';
        expect(tagsHtml(model.tagsOf.get(2) ?? [], model.tagKeys, context)).toBe(
            `${logo('k', GITHUB)}${logo('b', SENTRY)}${emoji}#tool:y,x,z,w,v ${emoji}#flag #other:x`,
        );
        expect(tagsHtml([{ key: 'other', values: ['x'] }], model.tagKeys, context)).toBeNull();
    });
});

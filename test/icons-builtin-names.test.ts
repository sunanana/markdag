// 利用者が書いた名前 (タグの値、alias、グループ名、単体 HTML の icons の ref) が Object の組み込みの名前でも落ちないことを固定する単体テスト。
// 表は自分の持つキーだけで引くので、書いていない組み込みの名前はロゴにならず文字のまま。Rust と TS の ref の一致は testdata/unit/icons/refs.json の共有の例で見る
import { describe, expect, it } from 'vitest';
import { iconDefOf, renderDocument, type IconTable } from '../src/model/model';
import type { TagKeyDef } from '../src/model/tags';
import { renderStandalonePage, DATA_ID, type StandaloneRuntime } from '../src/standalone/page';
import { documentIconRefs, groupLogo, iconMarkHtml, legendLogoHtml, nodeIconRefs, tagLineContent, tagsHtml } from '../src/view/icons';

const BUILTINS = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
const SVG = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const table: IconTable = { color: 'mono', aliases: new Map([['a', { kind: 'path', ref: './a.svg' }]]) };
// どの ref にも SVG を返す (ロゴが付くなら必ず付く)
const context = { icons: table, svgOf: () => SVG };
const toolKey: TagKeyDef = { key: 'tool', type: 'string', multiple: true, icons: { x: 'a' } } as unknown as TagKeyDef;

describe('タグの値が Object の組み込みの名前 (TS の tagAliases)', () => {
    it.each(BUILTINS)('#tool:%s は例外にならず、ロゴは付かず文字のまま', (value) => {
        const tags = [{ key: 'tool', values: [value] }];
        expect(tagsHtml(tags, [toolKey], context)).toBeNull();
        expect(tagLineContent(tags, [toolKey], context)).toEqual({ text: `#tool:${value}` });
        expect([...nodeIconRefs({ html: '' }, tags, { icons: table, tagKeys: [toolKey] })]).toEqual([]);
    });

    it('組み込みの名前と並べた書いてある値は、今までどおりロゴになる', () => {
        const tags = [{ key: 'tool', values: [...BUILTINS, 'x'] }];
        expect(tagsHtml(tags, [toolKey], context)).toContain('data-icon="a"');
        expect([...nodeIconRefs({ html: '' }, tags, { icons: table, tagKeys: [toolKey] })]).toEqual(['./a.svg']);
    });

    it('icons に組み込みの名前を自分のキーとして書けば、その値は引ける', () => {
        const own = { key: 'tool', type: 'string', multiple: true, icons: JSON.parse('{"__proto__":"a","constructor":"a"}') as Record<string, string> } as unknown as TagKeyDef;
        expect(tagsHtml([{ key: 'tool', values: ['__proto__'] }], [own], context)).toContain('data-icon="a"');
        expect(tagsHtml([{ key: 'tool', values: ['constructor'] }], [own], context)).toContain('data-icon="a"');
        expect(tagsHtml([{ key: 'tool', values: ['toString'] }], [own], context)).toBeNull();
    });

    it('文書から組み立てたモデルでも documentIconRefs が例外にならない', () => {
        const source = ['---', 'markdag:', '  icons:', '    a: ./a.svg', '  tags:', '    keys:', '      tool:', '        multiple: true', '        icons: { x: a }', '---', '# R', `## A #tool:${BUILTINS.join(',')}`, ''].join('\n');
        const { parsed, model } = renderDocument(source);
        expect([...documentIconRefs(parsed.nodes, model)]).toEqual([]);
    });
});

describe('alias とグループの icon が表にない Object の組み込みの名前', () => {
    it.each(BUILTINS)('%s は iconDefOf で null、本文の印は文字のまま、グループのロゴもない', (name) => {
        expect(iconDefOf(table, name)).toBeNull();
        expect(iconMarkHtml(name, context)).toBe(`<span class="mdag-icon" data-icon="${name}">:${name}:</span>`);
        expect(groupLogo({ icon: name }, context)).toBeNull();
        expect(legendLogoHtml({ icon: name }, context)).toBeNull();
    });
});

describe('単体 HTML の icons の ref が Object の組み込みの名前', () => {
    const RUNTIME: StandaloneRuntime = { script: 'var markdag = { mountStandalone() {} };', style: '' };
    const embedded = (html: string): Record<string, unknown> => {
        const match = new RegExp(`<script id="${DATA_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
        return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
    };

    it('自分の持つキーとして渡した組み込みの名前の ref も、ほかの ref と同じに埋める', () => {
        const icons = JSON.parse(JSON.stringify(Object.fromEntries([...BUILTINS, './a.svg'].map((ref) => [ref, SVG])))) as Record<string, string>;
        const html = renderStandalonePage({ source: '# R\n', icons }, RUNTIME);
        const baked = embedded(html).icons as Record<string, unknown>;
        expect(Object.keys(baked)).toEqual([...BUILTINS, './a.svg']);
        for (const ref of [...BUILTINS, './a.svg']) expect(Object.hasOwn(baked, ref) && typeof baked[ref], ref).toBe('string');
    });

    it('渡していない組み込みの名前は埋めない', () => {
        const html = renderStandalonePage({ source: '# R\n', icons: { './a.svg': SVG } }, RUNTIME);
        expect(Object.keys(embedded(html).icons as Record<string, unknown>)).toEqual(['./a.svg']);
    });
});

// 単体 HTML に焼き込むロゴ。埋める前の sanitize、渡さない ref は文字のまま、開いたときの同期の resolver (DOM を使わない所まで)
import { describe, expect, it, vi } from 'vitest';
import { createHookBridge } from '../src/bridge';
import { renderDocument } from '../src/model/model';
import { bakedIconResolver } from '../src/standalone/mount';
import { DATA_ID, renderStandalonePage, type StandaloneRuntime } from '../src/standalone/page';
import type { MarkdagView } from '../src/view/view';

const RUNTIME: StandaloneRuntime = { script: 'var markdag = { mountStandalone() {} };', style: '.markdag { color: red; }' };
const GITHUB = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

function embeddedData(html: string): Record<string, unknown> {
    const match = new RegExp(`<script id="${DATA_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
    if (!match) throw new Error('埋め込んだ JSON が見つからない');
    return JSON.parse(match[1] ?? '') as Record<string, unknown>;
}

const doc = (body: string[]): string =>
    ['---', 'markdag:', '    icons:', '        gh: ./logos/github.svg', '        k8s: simple-icons:kubernetes', '        rocket: "🚀"', '---', '# R', ...body].join('\n');

describe('buildStandaloneHtml の icons', () => {
    it('渡したロゴを素材の最後に埋める。ロゴの表 (iconAliases) も埋める', () => {
        const html = renderStandalonePage({ source: '# a', tasks: 'scratch', icons: { './logos/github.svg': GITHUB }, iconAliases: { './team.yaml': { gh: './logos/github.svg' } } }, RUNTIME);
        const data = embeddedData(html);
        expect(Object.keys(data)).toEqual(['source', 'tasks', 'iconAliases', 'icons']);
        expect(data.icons).toEqual({ './logos/github.svg': GITHUB });
        expect(data.iconAliases).toEqual({ './team.yaml': { gh: './logos/github.svg' } });
    });

    it('埋める前に sanitizeSvg を通し、SVG として読めないものは落とす', () => {
        const dirty = '<?xml version="1.0"?><svg width="24" height="24" onload="alert(1)"><script>alert(2)</script><title>t</title><path d="M0 0"/></svg>';
        const html = renderStandalonePage({ source: '# a', icons: { './a.svg': dirty, './b.svg': 'not an svg', './c.svg': GITHUB } }, RUNTIME);
        const icons = embeddedData(html).icons as Record<string, string>;
        expect(Object.keys(icons)).toEqual(['./a.svg', './c.svg']);
        expect(icons['./a.svg']).toBe('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>');
        expect(html).not.toContain('alert');
    });

    // library/standalone-build の html_lacks: [alert] と同じ確かめ方で、属性の区切りが空白でない書き方と外への読み込みを見る
    it('属性の区切りが空白でない on* 属性、分けて書いた script、外への読み込みも埋める前に落とす', () => {
        const inputs = [
            '<svg viewBox="0 0 1 1"><img src="x"onerror="alert(1)"></svg>',
            '<svg viewBox="0 0 1 1"><rect width="1"height="1"onmouseover="alert(1)"/></svg>',
            '<svg viewBox="0 0 1 1"><rect/onmouseover="alert(1)"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"onload="alert(1)"><path d="M0 0"/></svg>',
            '<svg viewBox="0 0 1 1"><scr<script>ipt>alert(1)</scr<script>ipt></svg>',
            '<svg viewBox="0 0 1 1"><image x="0"href="https://example.com/t.png"/></svg>',
            '<svg viewBox="0 0 1 1"><img src="https://example.com/p.png"></svg>',
            '<svg viewBox="0 0 1 1"><rect style="fill:url(https://example.com/x.svg#a)"/></svg>',
            '<svg viewBox="0 0 1 1"></svg><img src="https://example.com/p.png"><svg></svg>',
        ];
        const html = renderStandalonePage({ source: '# a', icons: Object.fromEntries(inputs.map((svg, index) => [`./${index}.svg`, svg])) }, RUNTIME);
        expect(html).not.toContain('alert');
        expect(html).not.toContain('example.com');
    });

    it('icons を渡さなければ素材の欄は増えない', () => {
        const data = embeddedData(renderStandalonePage({ source: '# a' }, RUNTIME));
        expect(Object.keys(data)).toEqual(['source']);
    });
});

describe('mountStandalone の焼き込んだロゴの resolver', () => {
    it('表にある ref は同期で SVG、ない ref (set:name を含む) と Object の組み込みの名前は null', () => {
        const resolve = bakedIconResolver({ './logos/github.svg': GITHUB });
        expect(resolve).toBeDefined();
        expect(resolve?.('./logos/github.svg')).toBe(GITHUB);
        expect(resolve?.('simple-icons:kubernetes')).toBeNull();
        expect(resolve?.('constructor')).toBeNull();
        expect(resolve?.('__proto__')).toBeNull();
        expect(bakedIconResolver(undefined)).toBeUndefined();
    });

    it('橋渡しに渡すと最初の setDocument の前にロゴが入り、渡されない ref は文字のまま (null) になる。診断は出さない', () => {
        const calls: string[] = [];
        const view = {
            setIconSvg: (ref: string, svg: string | null) => calls.push(`icon ${ref} ${svg === null ? 'null' : 'svg'}`),
            setDocument: () => calls.push('document'),
            destroy: () => {},
        } as unknown as MarkdagView;
        const onDiagnostic = vi.fn();
        const bridge = createHookBridge({ source: () => '', onDiagnostic, resolveIcon: bakedIconResolver({ './logos/github.svg': GITHUB }) });
        bridge.attach(view);
        const { parsed, model } = renderDocument(doc(['## :gh: Push', '## :k8s: Deploy', '## :rocket: Release']));
        bridge.setDocument(parsed, model);
        expect(calls).toEqual(['icon ./logos/github.svg svg', 'icon simple-icons:kubernetes null', 'document']);
        expect(onDiagnostic).not.toHaveBeenCalled();
    });
});

// 焼き込んだ表の引き方の細部 (自分の持つキーだけを見る判定)
describe('bakedIconResolver の引き方', () => {
    it('自分の持つキーで値が文字列のものだけを返し、それ以外は null。SVG として読めるかはここでは見ない', () => {
        const icons = { './a.svg': GITHUB, './b.svg': 3, './c.svg': null, hasOwnProperty: '<svg></svg>', './empty.svg': '', './text.svg': 'not svg' } as unknown as Record<string, string>;
        const resolve = bakedIconResolver(icons);
        expect(resolve?.('./a.svg')).toBe(GITHUB);
        expect(resolve?.('./b.svg')).toBeNull();
        expect(resolve?.('./c.svg')).toBeNull();
        expect(resolve?.('hasOwnProperty')).toBe('<svg></svg>');
        expect(resolve?.('./empty.svg')).toBe('');
        expect(resolve?.('./text.svg')).toBe('not svg');
        for (const name of ['toString', 'valueOf', 'isPrototypeOf', './missing.svg', '']) expect(resolve?.(name), name).toBeNull();
    });

    it('原型のないオブジェクトと継承した値も同じ判定。空の表でも resolver を返す', () => {
        const bare = Object.assign(Object.create(null) as Record<string, string>, { './a.svg': GITHUB });
        expect(bakedIconResolver(bare)?.('./a.svg')).toBe(GITHUB);
        const inherited = Object.create({ './a.svg': GITHUB }) as Record<string, string>;
        expect(bakedIconResolver(inherited)?.('./a.svg')).toBeNull();
        const empty = bakedIconResolver({});
        expect(empty).toBeTypeOf('function');
        expect(empty?.('./a.svg')).toBeNull();
    });

    it('返すのは同期の値で、Promise を返さない', () => {
        const value = bakedIconResolver({ './a.svg': GITHUB })?.('./a.svg');
        expect(typeof value).toBe('string');
    });
});

// 単体の HTML の骨組み。DOM を使わない部分 (埋め込みと逃がし方) を確かめる。開いたときの動きは e2e が見る
import { describe, expect, it } from 'vitest';
import type { ParsedDocument } from '../src/parse/document';
import { CONTAINER_CLASS, DATA_ID, renderStandalonePage, type StandaloneRuntime } from '../src/standalone/page';

const RUNTIME: StandaloneRuntime = { script: 'var markdag = { mountStandalone() {} };', style: '.markdag { color: red; }' };

const PARSED: ParsedDocument = {
    nodes: [
        { id: 1, parent: null, depth: 1, html: '<p>Root &lt;b&gt;</p>', refText: 'Root <b>', refId: null, groups: [], tags: [], milestone: false, foldHint: 0, lines: { start: 3, end: 4 }, task: null, details: null },
        { id: 2, parent: 1, depth: 2, html: '<p>Child</p>', refText: 'Child', refId: null, groups: [], tags: [], milestone: false, foldHint: 0, lines: { start: 5, end: 6 }, task: { line: 5, state: 'todo', checked: false }, details: null },
    ],
    frontmatter: { markdag: {} },
    extracted: true,
    styleUrls: [],
};

// ページに埋めた JSON を、開いたときと同じように読み戻す
function embeddedData(html: string): unknown {
    const match = new RegExp(`<script id="${DATA_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
    if (!match) throw new Error('埋め込んだ JSON が見つからない');
    return JSON.parse(match[1] ?? '');
}

describe('renderStandalonePage', () => {
    it('解析結果と状態を JSON で埋め、ランタイムとスタイルシートを入れる', () => {
        const html = renderStandalonePage({ parsed: PARSED, title: 'A & B', state: { folded: [1] }, view: { theme: 'dark' }, types: { './t.yaml': { x: 1 } } }, RUNTIME);
        expect(html.startsWith('<!doctype html>\n<html>\n')).toBe(true);
        expect(html).toContain('<title>A &amp; B</title>');
        expect(html).toContain(`<style>\n${RUNTIME.style}\n</style>`);
        expect(html).toContain(`<script>\n${RUNTIME.script}\n</script>`);
        expect(html).toContain(`<div class="${CONTAINER_CLASS}"></div>`);
        expect(html).toContain('markdag.mountStandalone(');
        expect(embeddedData(html)).toEqual({ parsed: PARSED, state: { folded: [1] }, view: { theme: 'dark' }, types: { './t.yaml': { x: 1 } } });
    });

    it('埋めた JSON の中の < はタグとして読まれない形にする', () => {
        const html = renderStandalonePage({ parsed: PARSED, source: '</script><script>alert(1)</script>' }, RUNTIME);
        const [, body = ''] = new RegExp(`<script id="${DATA_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html) ?? [];
        expect(body).not.toContain('<');
        expect(embeddedData(html)).toMatchObject({ source: '</script><script>alert(1)</script>' });
    });

    it('ランタイムと追加の CSS の中の閉じタグを逃がす', () => {
        const html = renderStandalonePage({ parsed: PARSED, css: ['.a::after { content: "</style>"; }'], runtime: { script: 'var s = "</script>";' } }, RUNTIME);
        expect(html).toContain('var s = "<\\/script>";');
        expect(html).toContain('content: "<\\/style>";');
        expect(html).not.toContain(RUNTIME.script);
    });

    it('lang、コンテナのクラス、追加の CSS、head の追加を、指定したときだけ入れる', () => {
        const plain = renderStandalonePage({ parsed: PARSED }, RUNTIME);
        expect(plain).toContain('<html>\n');
        expect(plain.match(/<style>/g)).toHaveLength(2);

        const html = renderStandalonePage({ parsed: PARSED, lang: 'ja', containerClass: ' zu-markdag  print ', css: ['.markdag { --markdag-bg: #000; }', '.b {}'], head: '<meta name="color-scheme" content="dark">' }, RUNTIME);
        expect(html).toContain('<html lang="ja">');
        expect(html).toContain(`<div class="${CONTAINER_CLASS} zu-markdag print"></div>`);
        // 追加の CSS はランタイムのものと骨組みのものより後
        const styles = [...html.matchAll(/<style>\n([\s\S]*?)\n<\/style>/g)].map((match) => match[1]);
        expect(styles).toHaveLength(3);
        expect(styles[0]).toBe(RUNTIME.style);
        expect(styles[1]).toContain(`.${CONTAINER_CLASS} { width: 100%; height: 100vh; height: 100dvh; }`);
        expect(styles[2]).toBe('.markdag { --markdag-bg: #000; }\n.b {}');
        expect(html).toContain('<meta name="color-scheme" content="dark">\n</head>');
    });

    it('解析結果も原文もないとき、逃がせないランタイムのときは断る', () => {
        expect(() => renderStandalonePage({}, RUNTIME)).toThrow('parsed か source');
        expect(() => renderStandalonePage({ source: '# a' }, RUNTIME)).not.toThrow();
        expect(() => renderStandalonePage({ parsed: PARSED, runtime: { script: 'var a = 1; /* <!-- */ var b = "<script>";' } }, RUNTIME)).toThrow('埋め込めません');
        expect(() => renderStandalonePage({ parsed: PARSED, runtime: { script: 'var a = "<!--";' } }, RUNTIME)).not.toThrow();
    });
});

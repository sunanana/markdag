// 数式とコードの飾りのライブラリを CDN から読む判断 (A-194 (2))。読み込みは差し替え、実際の通信はしない
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CODE_SCRIPT_INTEGRITY,
    CODE_SCRIPT_URL,
    loadDecorators,
    loadScriptTag,
    MATH_SCRIPT_INTEGRITY,
    MATH_SCRIPT_URL,
    overrideScriptIntegrity,
    resetDecoratorLoads,
    scriptIntegrityOf,
} from '../src/parse/decorators';
import { CODE_STYLE_URL, MATH_STYLE_URL } from '../src/parse/document';

const both = { styleUrls: [MATH_STYLE_URL, CODE_STYLE_URL] };
const katex = { renderToString: (tex: string) => tex };
const hljs = { getLanguage: () => true, highlight: (code: string) => ({ value: code }) };

describe('loadDecorators', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        resetDecoratorLoads();
    });

    it('足りないライブラリの URL だけを読み、使えるようになったら true', async () => {
        const load = vi.fn(async (url: string) => {
            if (url === MATH_SCRIPT_URL) vi.stubGlobal('katex', katex);
            if (url === CODE_SCRIPT_URL) vi.stubGlobal('hljs', hljs);
        });
        await expect(loadDecorators(both, load)).resolves.toBe(true);
        expect(load.mock.calls.map(([url]) => url)).toEqual([MATH_SCRIPT_URL, CODE_SCRIPT_URL]);
        // もうページにあるので読まない
        await expect(loadDecorators(both, load)).resolves.toBe(false);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('文書が使わない飾りと、ページにすでにあるライブラリは読まない', async () => {
        const load = vi.fn(async () => undefined);
        await expect(loadDecorators({ styleUrls: [] }, load)).resolves.toBe(false);
        vi.stubGlobal('katex', katex);
        await expect(loadDecorators({ styleUrls: [MATH_STYLE_URL] }, load)).resolves.toBe(false);
        expect(load).not.toHaveBeenCalled();
    });

    it('読めなかったら false で、同じ URL を読み直さない', async () => {
        const load = vi.fn(async () => {
            throw new Error('offline');
        });
        await expect(loadDecorators(both, load)).resolves.toBe(false);
        await expect(loadDecorators(both, load)).resolves.toBe(false);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('読み終えても定義されなければ描き直さない', async () => {
        await expect(loadDecorators({ styleUrls: [CODE_STYLE_URL] }, async () => undefined)).resolves.toBe(false);
    });

    it('同じ URL を並んで読むときは 1 回にまとめる', async () => {
        let finish = (): void => undefined;
        const load = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        vi.stubGlobal('hljs', hljs);
                        resolve();
                    };
                }),
        );
        const code = { styleUrls: [CODE_STYLE_URL] };
        const first = loadDecorators(code, load);
        const second = loadDecorators(code, load);
        finish();
        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(load).toHaveBeenCalledTimes(1);
    });
});

// document を持たない環境なので、loadScriptTag が触る分だけの偽の document を置く
interface FakeScript {
    src: string;
    async: boolean;
    integrity: string;
    crossOrigin: string | null;
    attributes: Record<string, string>;
    listeners: Record<string, () => void>;
}

function stubDocument(): FakeScript[] {
    const appended: FakeScript[] = [];
    vi.stubGlobal('document', {
        createElement: () => {
            const script: FakeScript = { src: '', async: false, integrity: '', crossOrigin: null, attributes: {}, listeners: {} };
            return Object.assign(script, {
                setAttribute: (name: string, value: string) => {
                    script.attributes[name] = value;
                },
                addEventListener: (type: string, listener: () => void) => {
                    script.listeners[type] = listener;
                },
            });
        },
        head: { append: (script: FakeScript) => appended.push(script) },
    });
    return appended;
}

describe('loadScriptTag の SRI (A-204)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        resetDecoratorLoads();
    });

    it('KaTeX と highlight.js の script に固定の integrity と crossorigin="anonymous" を付ける', async () => {
        const appended = stubDocument();
        const loaded = Promise.all([loadScriptTag(MATH_SCRIPT_URL), loadScriptTag(CODE_SCRIPT_URL)]);
        expect(appended.map(({ src, integrity, crossOrigin }) => ({ src, integrity, crossOrigin }))).toEqual([
            { src: MATH_SCRIPT_URL, integrity: MATH_SCRIPT_INTEGRITY, crossOrigin: 'anonymous' },
            { src: CODE_SCRIPT_URL, integrity: CODE_SCRIPT_INTEGRITY, crossOrigin: 'anonymous' },
        ]);
        for (const script of appended) script.listeners.load?.();
        await loaded;
    });

    it('integrity は sha384 の 1 つだけ', () => {
        for (const value of [MATH_SCRIPT_INTEGRITY, CODE_SCRIPT_INTEGRITY]) expect(value).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    });

    it('照合に失敗した script は error になり、読めなかったものとして扱う (読み直さない)', async () => {
        const appended = stubDocument();
        const load = vi.fn(loadScriptTag);
        const result = loadDecorators({ styleUrls: [MATH_STYLE_URL] }, load);
        // ブラウザは integrity が合わない本文を実行せず、error を出す
        appended[0]?.listeners.error?.();
        await expect(result).resolves.toBe(false);
        await expect(loadDecorators({ styleUrls: [MATH_STYLE_URL] }, load)).resolves.toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
        expect(appended).toHaveLength(1);
    });

    it('試験用の上書きは reset で消え、固定の値に戻る', () => {
        overrideScriptIntegrity(MATH_SCRIPT_URL, 'sha384-override');
        expect(scriptIntegrityOf(MATH_SCRIPT_URL)).toBe('sha384-override');
        resetDecoratorLoads();
        expect(scriptIntegrityOf(MATH_SCRIPT_URL)).toBe(MATH_SCRIPT_INTEGRITY);
        expect(scriptIntegrityOf('https://example.com/other.js')).toBeUndefined();
    });
});

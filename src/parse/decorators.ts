// 数式とコードの飾りのライブラリ (KaTeX と highlight.js) を CDN から読む。既定の入口 (markdag) の render だけが使い (import するのもその入口だけ)、
// markdag/core の入口と単体 HTML のランタイムは読まない (外部と通信しない)。
// URL は旧実装の変換器 (markmap-lib のブラウザ版の katex と hljs のプラグイン) が読んでいた preloadScripts と同じ版。
// 旧実装は読み終えるのを待つだけだったが、ここでは読めたら呼び出し側が描き直す (A-194 (2))。
import { missingDecorators, type ParsedDocument } from './document';

export const MATH_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/katex@0.16.18/dist/katex.min.js';
export const CODE_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js';

// SRI (A-204)。上の URL が返すファイルそのものの sha384 (CDN の本文と npm の同じ版の tarball の中のファイルが一致することを確かめて取った)。
// CDN の中身が変わるとブラウザが実行を断り、読めなかったときと同じく図は印のまま残る。
// 版を変えるときは新しいファイルから取り直す: curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A
export const MATH_SCRIPT_INTEGRITY = 'sha384-v6mkHYHfY/4BWq54f7lQAdtIsoZZIByznQ3ZqN38OL4KCsrxo31SLlPiak7cj/Mg';
export const CODE_SCRIPT_INTEGRITY = 'sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU';

const PINNED_INTEGRITY: Readonly<Record<string, string>> = {
    [MATH_SCRIPT_URL]: MATH_SCRIPT_INTEGRITY,
    [CODE_SCRIPT_URL]: CODE_SCRIPT_INTEGRITY,
};

// 試験で差し替えた本文を通すための上書き。公開の入口からは触れない
const integrityOverrides = new Map<string, string>();

export function scriptIntegrityOf(url: string): string | undefined {
    return integrityOverrides.get(url) ?? PINNED_INTEGRITY[url];
}

// 試験用: URL の integrity を差し替える
export function overrideScriptIntegrity(url: string, integrity: string): void {
    integrityOverrides.set(url, integrity);
}

// URL の JS を読み、読めたら解決する。試験では差し替える
export type ScriptLoader = (url: string) => Promise<void>;

const ASSET_MARK = 'data-markdag-asset';

export const loadScriptTag: ScriptLoader = (url) =>
    new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        const integrity = scriptIntegrityOf(url);
        if (integrity !== undefined) {
            // SRI の照合には CORS の要求が要る (jsDelivr は Access-Control-Allow-Origin: * を返す)。
            // 照合に失敗すると実行されずに error が来るので、読めなかったときと同じ扱いになる
            script.integrity = integrity;
            script.crossOrigin = 'anonymous';
        }
        script.setAttribute(ASSET_MARK, url);
        script.addEventListener('load', () => resolve());
        script.addEventListener('error', () => reject(new Error(`markdag: ${url} を読めませんでした`)));
        document.head.append(script);
    });

// URL ごとの読み込み。同じページで 1 度だけ読み、失敗しても読み直さない (描くたびに外部へ通信しないため)
const loads = new Map<string, Promise<void>>();

// 文書が使うのにページにない飾りのライブラリを読む。読み終えて、足りなかった飾りのどれかが使えるようになったら true (描き直す合図)。
// 読めなかったときは false で、図は印のまま (TeX の原文と色なしのコード)
export async function loadDecorators(parsed: Pick<ParsedDocument, 'styleUrls'>, load: ScriptLoader = loadScriptTag): Promise<boolean> {
    const before = missingDecorators(parsed);
    const urls = [...(before.math ? [MATH_SCRIPT_URL] : []), ...(before.code ? [CODE_SCRIPT_URL] : [])];
    if (urls.length === 0) return false;
    await Promise.all(
        urls.map((url) => {
            let loading = loads.get(url);
            if (loading === undefined) {
                loading = load(url);
                loads.set(url, loading);
            }
            return loading.catch(() => undefined);
        }),
    );
    const after = missingDecorators(parsed);
    return (before.math && !after.math) || (before.code && !after.code);
}

// 試験用: 読み込みの記録と integrity の上書きを消す
export function resetDecoratorLoads(): void {
    loads.clear();
    integrityOverrides.clear();
}

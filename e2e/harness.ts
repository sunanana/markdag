// e2e の土台。ライブラリの 2 つの入口と、変換器の代わり (Rust 化の前に利用者が渡していたもの) を、テストから page.evaluate で使えるように window に置く。
import * as core from '../src/core';
import * as markdag from '../src/index';
import type { TransformerLike } from '../src/parse/document';
import { overrideScriptIntegrity } from '../src/parse/decorators';

export interface Harness {
    markdag: typeof markdag;
    core: typeof core;
    // Rust 化の前に利用者が渡していた変換器の代わり。解析は Rust で行い、渡された変換器は使わない (ParseOptions.transformer は非推奨) ので、
    // 呼ばれたら投げる形にして「渡しても使われない」ことも確かめる (markmap-lib は依存から外した)
    createTransformer: () => TransformerLike;
    // CDN の script の integrity を差し替える口。page.route で返す差し替えの本文を SRI の照合に通すために使う
    overrideScriptIntegrity: typeof overrideScriptIntegrity;
}

// 解析と組み立ては wasm なので、init を待ってから window に置く (試験は harness が置かれるのを待ってから同期の関数を呼ぶ)。
// 開発サーバーでは src/ の入口の隣に .wasm がないので、npm run build (または npm run build:wasm) が書き出す dist/markdag.wasm を読む。
// 2 つの入口は開発サーバーでは同じ境界のモジュールを共有するので、init は 1 回で足りる
await markdag.init(new URL('/dist/markdag.wasm', location.href));

(window as unknown as { harness: Harness }).harness = {
    markdag,
    core,
    createTransformer: () => ({
        transform: () => {
            throw new Error('変換器は使わない (解析は Rust で行う)');
        },
        getUsedAssets: () => {
            throw new Error('変換器は使わない (解析は Rust で行う)');
        },
    }),
    overrideScriptIntegrity,
};

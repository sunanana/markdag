// GUI 編集の e2e の土台。ビルドした配布物の markdag/editor と markdag/core を、テストから page.evaluate で使えるように window に置く
// (配布物は npm run build で作る。playwright の前に回す)。
// markdag/editor は init を出さないので、wasm は markdag/core の init で 1 回待つ。2 つの入口は同じ ES のビルドで境界の状態を共有するので、
// それで足りる (共有していなければ mountEditor が WasmNotReadyError を投げて、テストが落ちる)。
// 型は src の入口から引く (配布物の型はビルドのあとにしかできない)
import type * as Core from '../src/core';
import type * as Editor from '../src/editor';

export interface EditorHarness {
    core: typeof Core;
    editor: typeof Editor;
}

// 場所は変数で渡す (文字のまま書くと、型の検査が配布物のファイルを探しに行く)
const CORE_URL: string = '/dist/core.js';
const EDITOR_URL: string = '/dist/editor.js';
const core = (await import(/* @vite-ignore */ CORE_URL)) as typeof Core;
const editor = (await import(/* @vite-ignore */ EDITOR_URL)) as typeof Editor;
await core.init(new URL('/dist/markdag.wasm', location.href));

(window as unknown as { editorHarness: EditorHarness }).editorHarness = { core, editor };

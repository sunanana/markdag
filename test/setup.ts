// 各試験ファイルの前に wasm の init を待つ。包み (parseDocument など) は init の前に呼ぶと WasmNotReadyError を投げるため。
// 読むのは global-setup が作った cargo の出力 (配布物の dist/markdag.wasm は古いことがある)。
// init の前の振る舞いを見る試験は、自分で reset してから確かめる。
import { fileURLToPath } from 'node:url';
import { initFromFile } from '../src/wasm/node';

await initFromFile(fileURLToPath(new URL('../target/wasm32-unknown-unknown/release/markdag_wasm.wasm', import.meta.url)));

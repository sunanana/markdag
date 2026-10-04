// エディタが読む wasm の場所。開発サーバーでは npm run build が書き出す dist/markdag.wasm を読む。
// 1 枚の HTML に書き出すとき (editor/build.ts) は、このモジュールを wasm の中身を焼き込んだものに差し替える
import type { WasmSource } from '../src/core';

export const wasmSource = (): WasmSource => new URL('/dist/markdag.wasm', location.href);

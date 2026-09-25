// wasm だけを作り直す入口 (npm run build:wasm)
import { buildWasm } from './wasm';

const built = buildWasm();
console.log(`${built.path} を書き出した (${built.bytes} バイト)`);

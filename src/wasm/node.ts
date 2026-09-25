// Node 向けの入口。ファイルから .wasm を読んで init する。ブラウザの成果物には入れない (node:fs を使うため)。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { init } from './boundary';

// 配布物 (dist) を先に、次に cargo の出力を探す。どちらもなければ build:wasm を促す
function defaultWasmPath(): string {
    const candidates = [new URL('../../dist/markdag.wasm', import.meta.url), new URL('../../target/wasm32-unknown-unknown/release/markdag_wasm.wasm', import.meta.url)].map((url) => fileURLToPath(url));
    const found = candidates.find((path) => existsSync(path));
    if (found === undefined) throw new Error(`markdag: .wasm が見つかりません。npm run build:wasm を先に実行してください (探した場所: ${candidates.join(', ')})`);
    return found;
}

export async function initFromFile(path: string = defaultWasmPath()): Promise<void> {
    await init(await readFile(path));
}

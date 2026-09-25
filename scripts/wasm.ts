// wasm の成果物を cargo で作り、配布物 (dist/) に写す。ビルドの script と、wasm だけを作り直す入口の両方から呼ぶ。
// cargo の出力の場所と dist での名前はここだけが知る。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const CARGO_OUTPUT = here('../target/wasm32-unknown-unknown/release/markdag_wasm.wasm');
export const DIST_WASM = here('../dist/markdag.wasm');

export function buildWasm(): { path: string; bytes: number } {
    const result = spawnSync('cargo', ['build', '-p', 'markdag-wasm', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: here('..'), stdio: 'inherit' });
    if (result.error) throw new Error(`cargo を起動できない: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`cargo build が ${result.status} で終わった`);
    mkdirSync(here('../dist/'), { recursive: true });
    copyFileSync(CARGO_OUTPUT, DIST_WASM);
    return { path: DIST_WASM, bytes: statSync(DIST_WASM).size };
}

// 試験の前に wasm を cargo で作り直す (Rust の変更が配布物に写っていなくても、試験は今の Rust を読む)。
// 作った .wasm は各試験ファイルの setup (init を待つ側) が読む。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const built = spawnSync('cargo', ['build', '-q', '-p', 'markdag-wasm', '--target', 'wasm32-unknown-unknown', '--release'], { cwd: root, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`cargo build が失敗した:\n${built.stderr}`);
}

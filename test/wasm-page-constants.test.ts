// 単体 HTML のページの中の名前 (図を置く要素のクラス、素材を埋める script の id、図の窓口を置く window の名前) は、
// ページを組み立てる Rust の定数が正本で、TS は同じ値を定数として残している (A-188 (1))。両者がずれていないことを見る。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTAINER_CLASS, DATA_ID, DIAGRAM_GLOBAL, renderStandalonePage } from '../src/standalone/page';

const PAGE_RS = fileURLToPath(new URL('../crates/markdag-core/src/standalone/page.rs', import.meta.url));

function rustConstant(source: string, name: string): string | undefined {
    return new RegExp(`pub const ${name}: &str = "([^"]*)";`).exec(source)?.[1];
}

describe('単体 HTML のページの中の名前', () => {
    it('TS の定数は Rust の定数と同じ値', () => {
        const source = readFileSync(PAGE_RS, 'utf8');
        expect(rustConstant(source, 'CONTAINER_CLASS')).toBe(CONTAINER_CLASS);
        expect(rustConstant(source, 'DATA_ID')).toBe(DATA_ID);
        expect(rustConstant(source, 'DIAGRAM_GLOBAL')).toBe(DIAGRAM_GLOBAL);
    });

    it('Rust が組み立てたページは TS の定数の名前で要素と素材と窓口を置く', () => {
        const html = renderStandalonePage({ source: '# a' }, { script: 'var markdag = {};', style: '' });
        expect(html).toContain(`<div class="${CONTAINER_CLASS}"></div>`);
        expect(html).toContain(`<script id="${DATA_ID}" type="application/json">`);
        expect(html).toContain(`document.querySelector('.${CONTAINER_CLASS}')`);
        expect(html).toContain(`document.getElementById('${DATA_ID}')`);
        expect(html).toContain(`window.${DIAGRAM_GLOBAL} = diagram;`);
    });
});

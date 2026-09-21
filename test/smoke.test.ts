import { hierarchy } from 'd3-hierarchy';
import { describe, expect, it } from 'vitest';

interface Outline {
    name: string;
    children?: Outline[];
}

describe('smoke', () => {
    it('ESM の依存を import して、型検査つきのテストを実行できる', () => {
        const outline: Outline = { name: 'root', children: [{ name: 'a' }, { name: 'b' }] };
        const names = hierarchy(outline)
            .descendants()
            .map((node) => node.data.name);
        expect(names).toEqual(['root', 'a', 'b']);
    });
});

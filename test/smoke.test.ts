import { zoomIdentity } from 'd3-zoom';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
    it('ESM の依存を import して、型検査つきのテストを実行できる', () => {
        const transform = zoomIdentity.translate(10, 20).scale(2);
        expect({ x: transform.x, y: transform.y, k: transform.k }).toEqual({ x: 10, y: 20, k: 2 });
        expect(transform.apply([1, 1])).toEqual([12, 22]);
    });
});

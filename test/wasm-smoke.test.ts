import { beforeAll, describe, expect, it } from 'vitest';
import { callJson, echo, isReady, ping, reset, version, WasmNotReadyError } from '../src/wasm';
import { initFromFile } from '../src/wasm/node';

describe('wasm の境界', () => {
    it('init の前に呼ぶと分かる誤りになる', () => {
        reset();
        expect(isReady()).toBe(false);
        expect(() => ping(1)).toThrow(WasmNotReadyError);
        expect(() => callJson('parse_document', { source: '' })).toThrow(WasmNotReadyError);
    });

    describe('init のあと', () => {
        beforeAll(async () => {
            await initFromFile();
        });

        it('Node から ping を呼べる', () => {
            expect(isReady()).toBe(true);
            expect(ping(41)).toBe(42);
        });

        it('中核の crate の版を UTF-8 で受け取る', () => {
            expect(version()).toMatch(/^\d+\.\d+\.\d+$/);
        });

        it('JSON を線形メモリに置いて呼び、返った (ptr, len) を読める', () => {
            const input = { text: '日本語と絵文字 🐈 と "引用"', list: [1, 2.5, null, true], nested: { empty: {} } };
            expect(echo(input)).toEqual(input);
        });

        it('大きい値でも memory の伸びに追従する', () => {
            const big = { text: 'あ'.repeat(200_000) };
            expect(echo(big).text.length).toBe(200_000);
        });

        it('Node から parse_document を呼べる', () => {
            const parsed = callJson<{ nodes: Array<{ refText: string }>; extracted: boolean }>('parse_document', { source: '# 根\n\n## 子\n' });
            expect(parsed.nodes.map((node) => node.refText)).toEqual(['根', '子']);
            expect(parsed.extracted).toBe(false);
        });
    });
});

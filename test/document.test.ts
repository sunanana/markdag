import { describe, expect, it } from 'vitest';
import { toggleTask } from '../src/parse/document';

describe('タスクの状態の反転', () => {
    it('指定の行の記号だけを反転し、ほかの行と改行 (CRLF) はそのまま残す', () => {
        const source = '# root\r\n- [ ] A\r\n- [x] B\r\n';
        expect(toggleTask(source, 1)).toBe('# root\r\n- [x] A\r\n- [x] B\r\n');
        expect(toggleTask(source, 2)).toBe('# root\r\n- [ ] A\r\n- [ ] B\r\n');
    });

    it('原文にない行を指定されたら、何も変えない (行を増やさない)', () => {
        const source = '# root\n- [ ] A';
        expect(toggleTask(source, 5)).toBe(source);
        expect(toggleTask(source, -1)).toBe(source);
    });
});

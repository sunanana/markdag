import { describe, expect, it } from 'vitest';
import { toggleTask } from '../src/parse/document';
import { nextTaskMark, taskMarkAt, taskStateOf } from '../src/parse/task';

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

describe('クリックで進む順', () => {
    it('順を渡すと左から右へ進み、右端の次は左端に戻る。大文字の X は完了として読む', () => {
        const cycle = [' ', '/', 'x'] as const;
        expect(toggleTask('- [ ] A', 0, cycle)).toBe('- [/] A');
        expect(toggleTask('- [/] A', 0, cycle)).toBe('- [x] A');
        expect(toggleTask('- [x] A', 0, cycle)).toBe('- [ ] A');
        expect(toggleTask('- [X] A', 0, cycle)).toBe('- [ ] A');
    });

    it('順にない状態の行は変えない (既定の順では作業中と中止がそれにあたる)', () => {
        expect(toggleTask('- [-] A', 0)).toBe('- [-] A');
        expect(toggleTask('- [/] A', 0)).toBe('- [/] A');
        expect(toggleTask('- [-] A', 0, [' ', '-', 'x'])).toBe('- [x] A');
        expect(nextTaskMark('-', [' ', 'x'])).toBeNull();
        expect(nextTaskMark('x', [' ', 'x'])).toBe(' ');
    });

    it('見出し、下線で書く見出し、番号付きの項目でも、行頭の記号だけを書き換える', () => {
        expect(toggleTask('## [ ] A [ ] b', 0)).toBe('## [x] A [ ] b');
        expect(toggleTask('[x] Setext', 0)).toBe('[ ] Setext');
        expect(toggleTask('1. [ ] A', 0)).toBe('1. [x] A');
    });
});

describe('行頭の記号の読み取り', () => {
    it('4 つの記号を状態にし、知らない記号や、記号のあとに空白のない行はタスクにしない', () => {
        expect(taskMarkAt('- [/] A', 'item')).toBe('/');
        expect(taskMarkAt('  * [-] A', 'item')).toBe('-');
        expect(taskMarkAt('## [X] A', 'heading')).toBe('x');
        expect(taskMarkAt('[-] Setext', 'heading')).toBe('-');
        expect(taskMarkAt('[-] plain', 'item')).toBeNull();
        expect(taskMarkAt('- [?] A', 'item')).toBeNull();
        expect(taskMarkAt('- [x]A', 'item')).toBeNull();
        expect(['/', '-', ' ', 'x'].map((mark) => taskStateOf(mark as '/' | '-' | ' ' | 'x'))).toEqual(['doing', 'canceled', 'todo', 'done']);
    });
});

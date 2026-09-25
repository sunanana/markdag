import { describe, expect, it } from 'vitest';
import { parseDocument, toggleTask } from '../src/parse/document';
import { nextTaskMark, taskMarkOf, taskStateOf } from '../src/parse/task';

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
    // 1 行から記号を読む関数 (taskMarkAt) は Rust にだけある (A-189。同じ 7 行をそのまま渡す試験は crates/markdag-core/src/parse/task.rs の
    // task_mark_at_reads_four_marks)。ここでは公開の parseDocument が項目と見出しの行から読んだ状態 (記号に直したもの) で見る
    const markOf = (source: string, refText: string) => {
        const node = parseDocument(source).nodes.find((candidate) => candidate.refText === refText);
        if (!node) throw new Error(`ノードがない: ${refText}`);
        return node.task === null ? null : taskMarkOf(node.task.state);
    };

    it('4 つの記号を状態にし、知らない記号や、記号のあとに空白のない行はタスクにしない', () => {
        expect(markOf('# root\n- [/] A', 'A')).toBe('/');
        expect(markOf('# root\n- a\n  * [-] A', 'A')).toBe('-');
        expect(markOf('# root\n## [X] A', 'A')).toBe('x');
        expect(markOf('# root\n\n[-] Setext\n---\n', 'Setext')).toBe('-');
        // 項目の行頭でない行 (項目の続きの段落) の記号はタスクにしない
        expect(markOf('# root\n- a\n\n  [-] plain', 'a')).toBeNull();
        expect(markOf('# root\n- [?] A', '[?] A')).toBeNull();
        expect(markOf('# root\n- [x]A', '[x]A')).toBeNull();
        expect(['/', '-', ' ', 'x'].map((mark) => taskStateOf(mark as '/' | '-' | ' ' | 'x'))).toEqual(['doing', 'canceled', 'todo', 'done']);
    });
});

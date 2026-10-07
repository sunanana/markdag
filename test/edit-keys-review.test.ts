// GUI 編集のキーの手直しのレビューで「直す」と決めた指摘 (records/fix.md) のうち、原文の書き換えの層のものを、公開の入口 (markdag/core) の
// editSource から、直す前に落ちるテストとして書く。期待は spec.md と fix.md の理由から書く (Rust の edit_keys_review と同じ指摘を wasm 経由で見る)。
// - A-08 / B-12: 桁が増えて子の字下げを書き直すとき、字下げのない怠惰な続きの行はずらさない (U7-digits)
// - B-04: 見出しのない文書のルートの名前 (title) は、項目の名前の変更で通る名前を断らず、図の名前は項目と同じ読み方になる
// - B-10: 日付の形の名前も、title にほかの値と同じ決まりで書く (引用符で囲まない。0.12.0 の書き方)。
//   引用符を付けて書く直しは、関門の答え (修正案 K-008、2026-10-07) で取り消した
// - B-11: 先頭に BOM のある文書でも、最初の見出しの上に足せる
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

const NEW = '新しいノード';

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

function expectTarget(source: string, [id, refText]: [number, string]): void {
    expect(nodeOf(source, id).refText, `id ${id}: ${JSON.stringify(source)}`).toBe(refText);
}

function editedSource(outcome: core.EditOutcome): string {
    expect(outcome.status, JSON.stringify(outcome)).toBe('edited');
    return outcome.status === 'edited' ? outcome.source : '';
}

function addSiblingBefore(source: string, node: [number, string]): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'addSiblingBefore', node: { id: node[0], refText: node[1] }, label: NEW });
}

function renameNode(source: string, node: [number, string], label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'renameNode', node: { id: node[0], refText: node[1] }, label });
}

const eight = (prefix: string): string => Array.from({ length: 8 }, (_, index) => `${index + 1}. ${prefix}${index + 1}\n`).join('');

describe('A-08 / B-12: 桁が増えて子の字下げを書き直すとき、字下げのない怠惰な続きの行はずらさない', () => {
    it('詳細の行は 3 から 4 に書き直し、そのあとの怠惰な続きの行 (lazy memo) は書き換えない (A-08)', () => {
        const source = `---\nmarkdag:\n---\n# R\n${eight('n')}9. n9\n   > memo line1\nlazy memo\n`;
        const shifted = Array.from({ length: 8 }, (_, index) => `${index + 2}. n${index + 1}\n`).join('');
        const after = `---\nmarkdag:\n---\n# R\n1. ${NEW}\n${shifted}10. n9\n    > memo line1\nlazy memo\n`;
        expect(editedSource(addSiblingBefore(source, [2, '1. n1']))).toBe(after);
    });

    it('詳細と子 (- c) は 10. の子のままになるよう書き直し、あいだの怠惰な続きの行は書き換えない (B-12)', () => {
        const source = `# A\n${eight('i')}9. i9\n   > detail\nlazy continuation\n   - c\n`;
        const after = `# A\n${eight('i')}9. ${NEW}\n10. i9\n    > detail\nlazy continuation\n    - c\n`;
        const c = core.parseDocument(after).nodes.find((node) => node.refText === 'c');
        expect(c && nodeOf(after, c.parent!).refText, '期待の文書').toBe('10. i9');
        expect(editedSource(addSiblingBefore(source, [10, '9. i9']))).toBe(after);
    });
});

describe('B-04: ルートのタイトルの名前の変更は、項目なら通る名前を断らない', () => {
    const names = ['新しい  題', 'Release <v2>', 'a &lt; b', '<b>x</b>', 'a<br>b', 'x\ty'];
    // 項目 a の名前を name に変えたときの図の名前
    const itemRefText = (name: string): string => nodeOf(editedSource(renameNode('# R\n- a\n- b\n', [2, 'a'], name)), 2).refText;

    it.each(names)('「%s」: title に書き、図の名前は同じ名前を項目に付けたときと同じ', (name) => {
        const source = '---\ntitle: T\n---\n- 甲\n- 乙\n';
        const outcome = renameNode(source, [1, 'T'], name);
        const after = editedSource(outcome);
        expect(nodeOf(after, 1).refText).toBe(itemRefText(name));
        expect(after.endsWith('---\n- 甲\n- 乙\n'), after).toBe(true);
    });
});

describe('B-10: 日付の形の名前も、title に引用符なしで書く (0.12.0 の書き方。K-008)', () => {
    it.each([
        ['title がある', '---\ntitle: T\n---\n- a\n- b\n', 'T'],
        ['title がない frontmatter', '---\nmarkdag:\n    tasks: scratch\n---\n- a\n- b\n', ''],
        ['frontmatter がない', '- a\n- b\n', ''],
    ])('%s文書', (_, source, title) => {
        const after = editedSource(renameNode(source, [1, title], '2026-10-06'));
        const lines = after.split('\n').filter((line) => line.startsWith('title:'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toBe('title: 2026-10-06');
        expect(nodeOf(after, 1).refText).toBe('2026-10-06');
    });
});

describe('B-11: 先頭に BOM のある文書でも、最初の見出しの上に足せる', () => {
    it('BOM は先頭に 1 つだけ残り、足した見出しは A の前に読まれる (空行の置き方は決めていないので、空でない行を見る)', () => {
        const source = '﻿# A\n# B\n';
        const after = editedSource(addSiblingBefore(source, [2, 'A']));
        expect(after.startsWith('﻿'), JSON.stringify(after)).toBe(true);
        expect(after.split('﻿')).toHaveLength(2);
        expect(
            after
                .replace('﻿', '')
                .split('\n')
                .filter((line) => line.trim() !== ''),
        ).toEqual([`# ${NEW}`, '# A', '# B']);
        expect(core.parseDocument(after).nodes.filter((node) => node.parent === 1).map((node) => node.refText)).toEqual([NEW, 'A', 'B']);
    });
});

// GUI 編集のキーの手直しで、例の承認 (2026-10-06) に依頼者が今の作りと違う答えをした挙動のうち、原文の書き換えのものを、
// 公開の入口 (markdag/core) の editSource と inspectNode から、直す前に落ちるテストとして書く。期待は決まった挙動から書く。
// - ルートのタイトル: 見出しのない文書のルート (原文の本文に行を持たず、名前は frontmatter の title) の名前を変えられる。
//   名前の入力の初めの値は今の title。決めた名前を title に書き、title がなければ足す (frontmatter がなければ作る)
// - U7-first: 連番のリストで先頭を消すか外へ移したときは、消す前の始まりの番号から振り直す
// - U7-digits: 番号の桁が増えて子の字下げが足りなくなるときは、子が子のままになるだけ字下げを書き直す。
//   足りているときと、桁が減るときは字下げを変えない
// 指すノードは操作の前に parseDocument で確かめ、期待の文書は比べる前にねらいの名前と親子で読まれることを確かめる
// (期待の書き誤りを、直す前の赤の確認で見分けるため)
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

type Target = [number, string];

const NEW = '新しいノード';
const TITLE = '新しい題';

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

// 名前が refText のノード (文書で 1 つ)
function named(source: string, refText: string): core.OutlineNode {
    const found = core.parseDocument(source).nodes.filter((node) => node.refText === refText);
    if (found.length !== 1) throw new Error(`名前 ${refText} のノードが ${found.length} 個: ${JSON.stringify(source)}`);
    return found[0]!;
}

// 名前が child のノードの親の名前
function parentName(source: string, child: string): string {
    const parent = named(source, child).parent;
    if (parent === null) throw new Error(`${child} に親がない: ${JSON.stringify(source)}`);
    return nodeOf(source, parent).refText;
}

const childrenOf = (source: string, parent: number): string[] =>
    core
        .parseDocument(source)
        .nodes.filter((node) => node.parent === parent)
        .map((node) => node.refText);

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
function expectTarget(source: string, [id, refText]: Target): void {
    expect(nodeOf(source, id).refText, `id ${id}: ${JSON.stringify(source)}`).toBe(refText);
}

const nodeTarget = ([id, refText]: Target): core.NodeTarget => ({ id, refText });

const selected = ([id, refText]: Target): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

function renameNode(source: string, node: Target, label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'renameNode', node: nodeTarget(node), label });
}

function addSibling(source: string, node: Target): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'addSibling', node: nodeTarget(node), label: NEW });
}

function addSiblingBefore(source: string, node: Target): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'addSiblingBefore', node: nodeTarget(node), label: NEW });
}

function deleteNodes(source: string, ...nodes: Target[]): core.EditOutcome {
    for (const node of nodes) expectTarget(source, node);
    return core.editSource(source, { kind: 'deleteNodes', nodes: nodes.map(nodeTarget) });
}

function moveNode(source: string, node: Target, parent: Target): core.EditOutcome {
    expectTarget(source, node);
    expectTarget(source, parent);
    return core.editSource(source, { kind: 'moveNode', node: nodeTarget(node), parent: nodeTarget(parent) });
}

// 書き換えたあとの原文 (書き換えなければ落とす)
function editedSource(outcome: core.EditOutcome): string {
    expect(outcome.status, JSON.stringify(outcome)).toBe('edited');
    return outcome.status === 'edited' ? outcome.source : '';
}

// 足した結果の全体 (select と rename は足したノード、notes は空) と、足したノードの親
function expectAdded(outcome: core.EditOutcome, after: string, added: Target, parent: number): void {
    expect(nodeOf(after, added[0]).refText, `期待の文書: ${JSON.stringify(after)}`).toBe(added[1]);
    expect(nodeOf(after, added[0]).parent, `期待の文書: ${JSON.stringify(after)}`).toBe(parent);
    expect(outcome).toEqual({ status: 'edited', source: after, select: selected(added), rename: { kind: 'node', node: nodeTarget(added) }, notes: [] });
}

// 書き換えた結果の全体: select は 1 つのノード、rename は null、notes は空
function expectRewritten(outcome: core.EditOutcome, after: string, chosen: Target): void {
    expect(nodeOf(after, chosen[0]).refText, `期待の文書: ${JSON.stringify(after)}`).toBe(chosen[1]);
    expect(outcome).toEqual({ status: 'edited', source: after, select: selected(chosen), rename: null, notes: [] });
}

// frontmatter の中の行 (開きと閉じの --- を除く) と本文。frontmatter がなければ null
function splitFrontmatter(text: string): { inner: string[]; body: string } | null {
    const lines = text.split('\n');
    if (lines[0] !== '---') return null;
    const close = lines.indexOf('---', 1);
    if (close < 0) return null;
    return { inner: lines.slice(1, close), body: lines.slice(close + 1).join('\n') };
}

describe('ルートのタイトル: 見出しのない文書のルートの名前を変えられる (名前は frontmatter の title)', () => {
    it('名前を変えられ、名前の入力の初めの値は今の title (なければ空)。ルートが容器のものと容器でないもの', () => {
        const cases: Array<[string, string]> = [
            ['---\ntitle: リストだけ\n---\n- 甲\n- 乙\n', 'リストだけ'],
            ['- 甲\n- 乙\n', ''],
            ['---\ntitle: T\n---\n- a\n\n1. b\n', 'T'],
            ['- a\n\n1. b\n', ''],
        ];
        for (const [source, title] of cases) {
            expectTarget(source, [1, title]);
            const facts = core.inspectNode(source, { id: 1, refText: title });
            expect(facts?.canRename, JSON.stringify(source)).toBe(true);
            expect(facts?.label, JSON.stringify(source)).toBe(title);
        }
    });

    it('title があれば、その値だけを書き換える。選ぶのはルート (新しい名前)', () => {
        const cases: Array<[string, string, string]> = [
            ['---\ntitle: リストだけ\n---\n- 甲\n- 乙\n', 'リストだけ', `---\ntitle: ${TITLE}\n---\n- 甲\n- 乙\n`],
            ['---\ntitle: T\n---\n- a\n\n1. b\n', 'T', `---\ntitle: ${TITLE}\n---\n- a\n\n1. b\n`],
            ['---\nmarkdag:\n    tasks: scratch\ntitle: T\n---\n- 甲\n- 乙\n', 'T', `---\nmarkdag:\n    tasks: scratch\ntitle: ${TITLE}\n---\n- 甲\n- 乙\n`],
        ];
        for (const [source, title, after] of cases) expectRewritten(renameNode(source, [1, title], TITLE), after, [1, TITLE]);
    });

    it('frontmatter に title がなければ足す (置き場は決めていないので、最上位に 1 行増えて、ほかの行と本文が変わらないことを見る)', () => {
        expect(editedSource(renameNode('---\n---\n- 甲\n- 乙\n', [1, ''], TITLE))).toBe(`---\ntitle: ${TITLE}\n---\n- 甲\n- 乙\n`);

        const source = '---\nmarkdag:\n    tasks: scratch\n---\n- 甲\n- 乙\n';
        const outcome = renameNode(source, [1, ''], TITLE);
        const after = editedSource(outcome);
        const parts = splitFrontmatter(after);
        expect(parts, after).not.toBeNull();
        expect(parts?.body).toBe('- 甲\n- 乙\n');
        expect(parts?.inner.filter((line) => line === `title: ${TITLE}`)).toHaveLength(1);
        expect(parts?.inner.filter((line) => line !== `title: ${TITLE}`)).toEqual(['markdag:', '    tasks: scratch']);
        expect(nodeOf(after, 1).refText).toBe(TITLE);
        expect(outcome.status === 'edited' ? outcome.select : null).toEqual(selected([1, TITLE]));
    });

    it('frontmatter がなければ文書の先頭に作って title を書く (閉じの --- のあとの空行はあってもなくてもよい)', () => {
        for (const body of ['- 甲\n- 乙\n', '- a\n\n1. b\n']) {
            const outcome = renameNode(body, [1, ''], TITLE);
            const after = editedSource(outcome);
            expect([`---\ntitle: ${TITLE}\n---\n\n${body}`, `---\ntitle: ${TITLE}\n---\n${body}`]).toContain(after);
            expect(nodeOf(after, 1).refText).toBe(TITLE);
            expect(outcome.status === 'edited' ? outcome.select : null).toEqual(selected([1, TITLE]));
        }
    });

    it('YAML の素の値では別の値に読まれる名前も、図の名前がその名前になる', () => {
        for (const name of ['注意: 重要', '#1 案', '0']) {
            const after = editedSource(renameNode('---\ntitle: T\n---\n- a\n- b\n', [1, 'T'], name));
            expect(nodeOf(after, 1).refText, after).toBe(name);
            expect(core.parseDocument(after).frontmatter, after).toMatchObject({ title: name });
        }
    });

    it('今と同じ名前は原文を変えず、空の名前は断る (ほかのノードの名前の変更と同じ)', () => {
        const source = '---\ntitle: T\n---\n- a\n- b\n';
        expect(renameNode(source, [1, 'T'], 'T')).toMatchObject({ status: 'unchanged', reason: { code: 'same-name' } });
        expect(renameNode(source, [1, 'T'], '')).toMatchObject({ status: 'refused', reason: { code: 'empty-name' } });
        expect(renameNode('- a\n- b\n', [1, ''], '')).toMatchObject({ status: 'unchanged', reason: { code: 'same-name' } });
    });
});

const steps = (marker: (index: number) => string, tail = ''): string =>
    `# 手順\n\n## 作業\n${['停止', '更新', '再開'].map((name, index) => `${marker(index)} ${name}\n`).join('')}${tail}`;

// [区切り, 始まりの番号]
const STARTS: Array<['.' | ')', number]> = [
    ['.', 1],
    ['.', 3],
    [')', 1],
];

describe('U7-first: 連番のリストで先頭を消すか外へ移したときは、消す前の始まりの番号から振り直す', () => {
    it('先頭を消す (1 から、3 から、区切りが「)」)。選ぶのは親', () => {
        // 1 手順 / 2 作業 / 3 停止 / 4 更新 / 5 再開
        for (const [delimiter, start] of STARTS) {
            const source = steps((index) => `${start + index}${delimiter}`);
            const after = `# 手順\n\n## 作業\n${start}${delimiter} 更新\n${start + 1}${delimiter} 再開\n`;
            expect(childrenOf(after, 2), after).toEqual([`${start}. 更新`, `${start + 1}. 再開`]);
            expectRewritten(deleteNodes(source, [3, `${start}. 停止`]), after, [2, '作業']);
        }
    });

    it('先頭を含めてまとめて消しても、始まりの番号から 1 回で振り直す', () => {
        const source = '# 手順\n\n## 作業\n1. 停止\n2. 更新\n3. 確認\n4. 再開\n';
        expectRewritten(deleteNodes(source, [3, '1. 停止'], [4, '2. 更新']), '# 手順\n\n## 作業\n1. 確認\n2. 再開\n', [2, '作業']);
        expectRewritten(deleteNodes(source, [3, '1. 停止'], [5, '3. 確認']), '# 手順\n\n## 作業\n1. 更新\n2. 再開\n', [2, '作業']);
    });

    it('先頭をリストの外へ移す (別の見出しの子、同じリストの 2 つ目の項目の子)。選ぶのは動かしたノード', () => {
        for (const [delimiter, start] of STARTS) {
            const source = steps((index) => `${start + index}${delimiter}`, '\n## 後で\n- 記録\n');
            // 1 手順 / 2 作業 / 3 停止 / 4 更新 / 5 再開 / 6 後で / 7 記録
            const after = `# 手順\n\n## 作業\n${start}${delimiter} 更新\n${start + 1}${delimiter} 再開\n\n## 後で\n- 記録\n- 停止\n`;
            expect(nodeOf(after, 7).parent).toBe(5);
            expectRewritten(moveNode(source, [3, `${start}. 停止`], [6, '後で']), after, [7, '停止']);
        }
        const after = '# 手順\n\n## 作業\n1. 更新\n    - 停止\n2. 再開\n';
        expect(nodeOf(after, 4).parent).toBe(3);
        expectRewritten(moveNode(steps((index) => `${index + 1}.`), [3, '1. 停止'], [4, '2. 更新']), after, [4, '停止']);
    });

    it('容器と 1 行目を分け合う最初の項目 (見出しの下に種類の違うリストが 2 つ。A-01) を消すか移す', () => {
        // 1 R / 2 容器 / 3 p / 4 q / 5 容器 / 6 a / 7 b / 8 c
        const source = '# R\n- p\n- q\n\n1. a\n2. b\n3. c\n';
        expectRewritten(deleteNodes(source, [6, '1. a']), '# R\n- p\n- q\n\n1. b\n2. c\n', [5, '']);
        const moved = '# R\n- p\n- q\n\n1. b\n    - a\n2. c\n';
        expect(nodeOf(moved, 7).parent).toBe(6);
        expectRewritten(moveNode(source, [6, '1. a'], [7, '2. b']), moved, [7, 'a']);
    });
});

const HEAD = '# 手順\n\n## 作業\n';
const numbered = (names: string[]): string => names.map((name, index) => `${index + 1}. ${name}\n`).join('');
const EIGHT = numbered(['一', '二', '三', '四', '五', '六', '七', '八']);

describe('U7-digits: 番号の桁が変わるときの子の字下げ', () => {
    // 9. 九 (id 11) の上に足す操作と、8. 八 (id 10) の下に足す操作。どちらも九は 10. になり、足したノードは 9. で id 11
    const addBeforeNine = (source: string): core.EditOutcome[] => [addSiblingBefore(source, [11, '9. 九']), addSibling(source, [10, '8. 八'])];

    it('9. が 10. になって字下げ 3 の子が足りなくなるときは、子のままになるよう 4 に書き直す (孫と詳細も同じだけ)', () => {
        const cases: Array<[string, string]> = [
            ['   - 細目\n', '    - 細目\n'],
            ['   > 詳細\n   - 細目\n     - 孫\n', '    > 詳細\n    - 細目\n      - 孫\n'],
        ];
        for (const [underNine, underTen] of cases) {
            const source = `${HEAD}${EIGHT}9. 九\n${underNine}`;
            expect(parentName(source, '細目')).toBe('9. 九');
            const after = `${HEAD}${EIGHT}9. ${NEW}\n10. 九\n${underTen}`;
            expect(parentName(after, '細目'), after).toBe('10. 九');
            for (const outcome of addBeforeNine(source)) expectAdded(outcome, after, [11, `9. ${NEW}`], 2);
        }
    });

    it('字下げ 4 以上の子は 10. の子のまま読めるので、字下げを変えない', () => {
        for (const under of ['    - 細目\n', '      - 細目\n', '    - 細目\n      - 孫\n', '    > 詳細\n    - 細目\n']) {
            const source = `${HEAD}${EIGHT}9. 九\n${under}`;
            expect(parentName(source, '細目')).toBe('9. 九');
            const after = `${HEAD}${EIGHT}9. ${NEW}\n10. 九\n${under}`;
            expect(parentName(after, '細目'), after).toBe('10. 九');
            for (const outcome of addBeforeNine(source)) expectAdded(outcome, after, [11, `9. ${NEW}`], 2);
        }
    });

    it('10. が 9. になるとき (途中の項目を消すか外へ移す) は、字下げを減らさない', () => {
        const all = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        const rest = ['一', '三', '四', '五', '六', '七', '八', '九', '十'];
        for (const under of ['    - 細目\n', '    > 詳細\n    - 細目\n      - 孫\n']) {
            const source = `${HEAD}${numbered(all)}${under}`;
            expect(parentName(source, '細目')).toBe('10. 十');
            const after = `${HEAD}${numbered(rest)}${under}`;
            expect(parentName(after, '細目'), after).toBe('9. 十');
            expectRewritten(deleteNodes(source, [4, '2. 二']), after, [2, '作業']);

            const withLater = `${HEAD}${numbered(all)}${under}\n## 後で\n- 記録\n`;
            const moved = `${HEAD}${numbered(rest)}${under}\n## 後で\n- 記録\n- 二\n`;
            expect(parentName(moved, '細目'), moved).toBe('9. 十');
            expectRewritten(moveNode(withLater, [4, '2. 二'], [named(withLater, '後で').id, '後で']), moved, [named(moved, '二').id, '二']);
        }
    });

    it('3 桁: 99. が 100. になるとき、字下げ 4 の子は 5 に書き直し、字下げ 5 の子はそのまま。100. が 99. に戻るときも 5 のまま', () => {
        // 1 手順 / 2 作業 / 3 a / 4 b / 5 c
        const cases: Array<[string, string]> = [
            ['    - c\n', '     - c\n'],
            ['     - c\n', '     - c\n'],
        ];
        for (const [under99, under100] of cases) {
            const source = `${HEAD}98. a\n99. b\n${under99}`;
            const after = `${HEAD}98. a\n99. ${NEW}\n100. b\n${under100}`;
            expect(parentName(after, 'c'), after).toBe('100. b');
            expectAdded(addSiblingBefore(source, [4, '99. b']), after, [4, `99. ${NEW}`], 2);
        }
        const after = `${HEAD}98. a\n99. c\n     - d\n`;
        expect(parentName(after, 'd'), after).toBe('99. c');
        expectRewritten(deleteNodes(`${HEAD}98. a\n99. b\n100. c\n     - d\n`, [4, '99. b']), after, [2, '作業']);
    });
});

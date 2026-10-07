// 番号付きリストの番号の振り直しのうち、2 つ以上の項目が全部同じ番号で書かれたリスト (「1. 1. 1.」「3. 3. 3.」「1) 1) 1)」。
// 番号を表示に任せる書き方) を、足す (下、上、子)、移す (入れる、出す)、消す (1 つ、先頭、まとめて) のどの操作のあとも
// 全部同じ番号のまま書くことを、公開の入口 (markdag/core) の editSource から、直す前に落ちるテストとして書く。
// 連番のリストと項目が 1 つのリストは今の振り直しのまま。図のノードの名前 (refText) はどちらでも最初の番号から数えた番号。
// 指すノードは操作の前に parseDocument で確かめ、期待の文書は比べる前に数えた番号の名前で読まれることを確かめる
// (期待の書き誤りを、直す前の赤の確認で見分けるため)
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

type Target = [number, string];

const NEW = '新しいノード';

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
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

function addChild(source: string, parent: Target): core.EditOutcome {
    expectTarget(source, parent);
    return core.editSource(source, { kind: 'addChild', parent: nodeTarget(parent), label: NEW });
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

const selected = ([id, refText]: Target): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

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

function expectMoved(outcome: core.EditOutcome, after: string, moved: Target, parent: number): void {
    expect(nodeOf(after, moved[0]).parent, `期待の文書: ${JSON.stringify(after)}`).toBe(parent);
    expectRewritten(outcome, after, moved);
}

// 全部の項目に書く番号と区切り。図の名前は、この番号から数えた番号と . (区切りが ) でも .)
type Same = { number: number; delimiter: '.' | ')' };

const DOT: Same = { number: 1, delimiter: '.' };
const THREE: Same = { number: 3, delimiter: '.' };
const PAREN: Same = { number: 1, delimiter: ')' };

// 字下げ indent で、名前ごとに 1 行の項目を全部同じ番号で書く
const items = (list: Same, names: string[], indent = ''): string => names.map((name) => `${indent}${list.number}${list.delimiter} ${name}\n`).join('');

// リストの position 番目 (0 始まり) の項目の図の名前
const counted = (list: Same, position: number, name: string): string => `${list.number + position}. ${name}`;

// 期待の文書で、親 parent の子がそのリストの項目だけで、名前が数えた番号で読まれる
function expectCounted(after: string, parent: number, list: Same, names: string[]): void {
    expect(childrenOf(after, parent), `期待の文書の図の名前: ${JSON.stringify(after)}`).toEqual(names.map((name, position) => counted(list, position, name)));
}

describe('editSource: 全部同じ番号の番号付きリストは、どの操作のあとも全部同じ番号のまま', () => {
    it('下に足す (addSibling): 途中の項目の下と最後の項目の下。足した項目も同じ番号 (1. 1. 1.)', () => {
        // 1 R / 2 a / 3 b / 4 c
        const source = `# R\n${items(DOT, ['a', 'b', 'c'])}`;
        const middle = `# R\n${items(DOT, ['a', 'b', NEW, 'c'])}`;
        expectCounted(middle, 1, DOT, ['a', 'b', NEW, 'c']);
        expectAdded(addSibling(source, [3, '2. b']), middle, [4, `3. ${NEW}`], 1);
        const last = `# R\n${items(DOT, ['a', 'b', 'c', NEW])}`;
        expectCounted(last, 1, DOT, ['a', 'b', 'c', NEW]);
        expectAdded(addSibling(source, [4, '3. c']), last, [5, `4. ${NEW}`], 1);
    });

    it('上に足す (addSiblingBefore): 途中の項目の上と先頭の項目の上 (3. 3. 3.)', () => {
        // 1 R / 2「3. a」/ 3「4. b」/ 4「5. c」
        const source = `# R\n${items(THREE, ['a', 'b', 'c'])}`;
        const middle = `# R\n${items(THREE, ['a', NEW, 'b', 'c'])}`;
        expectCounted(middle, 1, THREE, ['a', NEW, 'b', 'c']);
        expectAdded(addSiblingBefore(source, [3, '4. b']), middle, [3, `4. ${NEW}`], 1);
        const first = `# R\n${items(THREE, [NEW, 'a', 'b', 'c'])}`;
        expectCounted(first, 1, THREE, [NEW, 'a', 'b', 'c']);
        expectAdded(addSiblingBefore(source, [2, '3. a']), first, [2, `3. ${NEW}`], 1);
    });

    it('子を足す (addChild): 見出しの子のリストと、項目の子の入れ子のリストの末尾 (1) 1) 1))', () => {
        const source = `# R\n${items(PAREN, ['a', 'b', 'c'])}`;
        const after = `# R\n${items(PAREN, ['a', 'b', 'c', NEW])}`;
        expectCounted(after, 1, PAREN, ['a', 'b', 'c', NEW]);
        expectAdded(addChild(source, [1, 'R']), after, [5, `4. ${NEW}`], 1);
        // 1 R / 2 x / 3 a / 4 b
        const nested = `# R\n- x\n${items(PAREN, ['a', 'b'], '    ')}`;
        const nestedAfter = `# R\n- x\n${items(PAREN, ['a', 'b', NEW], '    ')}`;
        expectCounted(nestedAfter, 2, PAREN, ['a', 'b', NEW]);
        expectAdded(addChild(nested, [2, 'x']), nestedAfter, [5, `3. ${NEW}`], 2);
    });

    it('移して入れる (moveNode): ほかの所からそのリストへ移すと末尾に同じ番号で書く (1. 1. 1.)', () => {
        // 1 R / 2 A / 3 a / 4 b / 5 c / 6 B / 7 y
        const source = `# R\n## A\n${items(DOT, ['a', 'b', 'c'])}## B\n- y\n`;
        const after = `# R\n## A\n${items(DOT, ['a', 'b', 'c', 'y'])}## B\n`;
        expectCounted(after, 2, DOT, ['a', 'b', 'c', 'y']);
        expectMoved(moveNode(source, [7, 'y'], [2, 'A']), after, [6, '4. y'], 2);
        // 全部同じ番号のリストどうし: 1 R / 2 A / 3 a / 4 b / 5 B / 6 x / 7 y / 8 z。移す先も移す元も同じ番号のまま
        const between = `# R\n## A\n${items(DOT, ['a', 'b'])}## B\n${items(DOT, ['x', 'y', 'z'])}`;
        const betweenAfter = `# R\n## A\n${items(DOT, ['a', 'b', 'y'])}## B\n${items(DOT, ['x', 'z'])}`;
        expectCounted(betweenAfter, 2, DOT, ['a', 'b', 'y']);
        expectCounted(betweenAfter, 6, DOT, ['x', 'z']);
        expectMoved(moveNode(between, [7, '2. y'], [2, 'A']), betweenAfter, [5, '3. y'], 2);
    });

    it('移して出す (moveNode): 途中の項目と先頭の項目をリストの外へ移しても、残りは同じ番号のまま (3. 3. 3.)', () => {
        // 1 R / 2 A / 3 x / 4 B / 5「3. a」/ 6「4. b」/ 7「5. c」
        const source = `# R\n## A\n- x\n## B\n${items(THREE, ['a', 'b', 'c'])}`;
        const middle = `# R\n## A\n- x\n- b\n## B\n${items(THREE, ['a', 'c'])}`;
        expectCounted(middle, 5, THREE, ['a', 'c']);
        expectMoved(moveNode(source, [6, '4. b'], [2, 'A']), middle, [4, 'b'], 2);
        const first = `# R\n## A\n- x\n- a\n## B\n${items(THREE, ['b', 'c'])}`;
        expectCounted(first, 5, THREE, ['b', 'c']);
        expectMoved(moveNode(source, [5, '3. a'], [2, 'A']), first, [4, 'a'], 2);
    });

    it('消す (deleteNodes): 途中の項目と先頭の項目を消しても、残りは同じ番号のまま (1) 1) 1) と 3. 3. 3.)', () => {
        for (const list of [PAREN, THREE]) {
            const source = `# R\n${items(list, ['a', 'b', 'c'])}`;
            const middle = `# R\n${items(list, ['a', 'c'])}`;
            expectCounted(middle, 1, list, ['a', 'c']);
            expectRewritten(deleteNodes(source, [3, counted(list, 1, 'b')]), middle, [1, 'R']);
            const first = `# R\n${items(list, ['b', 'c'])}`;
            expectCounted(first, 1, list, ['b', 'c']);
            expectRewritten(deleteNodes(source, [2, counted(list, 0, 'a')]), first, [1, 'R']);
        }
    });

    it('まとめて消す (deleteNodes): 1 つのリストの 2 つと、2 つのリストの 1 つずつ (1. 1. 1.)', () => {
        // 1 R / 2 a / 3 b / 4 c / 5 d。先頭の a と途中の c
        const source = `# R\n${items(DOT, ['a', 'b', 'c', 'd'])}`;
        const after = `# R\n${items(DOT, ['b', 'd'])}`;
        expectCounted(after, 1, DOT, ['b', 'd']);
        expectRewritten(deleteNodes(source, [4, '3. c'], [2, '1. a']), after, [1, 'R']);
        // 1 R / 2 A / 3 a / 4 b / 5 c / 6 B / 7 x / 8 y / 9 z。選ぶのは文書順で最初の b の親 A
        const two = `# R\n## A\n${items(DOT, ['a', 'b', 'c'])}## B\n${items(DOT, ['x', 'y', 'z'])}`;
        const twoAfter = `# R\n## A\n${items(DOT, ['a', 'c'])}## B\n${items(DOT, ['x', 'z'])}`;
        expectCounted(twoAfter, 2, DOT, ['a', 'c']);
        expectCounted(twoAfter, 5, DOT, ['x', 'z']);
        expectRewritten(deleteNodes(two, [8, '2. y'], [4, '2. b']), twoAfter, [2, 'A']);
    });

    it('連番のリストと項目が 1 つのリストは今のまま振り直す (足したら後ろが + 1、消したら詰める。「1.」の下に足すと「1. 2.」)', () => {
        const source = '# R\n1. a\n2. b\n3. c\n';
        expectAdded(addSiblingBefore(source, [3, '2. b']), '# R\n1. a\n2. 新しいノード\n3. b\n4. c\n', [3, `2. ${NEW}`], 1);
        expectAdded(addSibling(source, [3, '2. b']), '# R\n1. a\n2. b\n3. 新しいノード\n4. c\n', [4, `3. ${NEW}`], 1);
        expectRewritten(deleteNodes(source, [3, '2. b']), '# R\n1. a\n2. c\n', [1, 'R']);
        expectRewritten(deleteNodes('# R\n1) a\n2) b\n3) c\n4) d\n', [4, '3. c'], [3, '2. b']), '# R\n1) a\n2) d\n', [1, 'R']);
        expectAdded(addSibling('# R\n1. a\n', [2, '1. a']), '# R\n1. a\n2. 新しいノード\n', [3, `2. ${NEW}`], 1);
        expectAdded(addChild('# R\n1. a\n', [1, 'R']), '# R\n1. a\n2. 新しいノード\n', [3, `2. ${NEW}`], 1);
        expectAdded(addSibling('# R\n3. a\n', [2, '3. a']), '# R\n3. a\n4. 新しいノード\n', [3, `4. ${NEW}`], 1);
    });
});

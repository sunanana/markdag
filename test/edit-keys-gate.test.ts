// GUI 編集のキーの手直しの最後の関門で、依頼者が修正案 (amendments.md) に答えた挙動 (2026-10-07) のうち、原文の書き換えのものを、
// 公開の入口 (markdag/core) の editSource と inspectNode から、直す前に落ちるテストとして書く (Rust の edit_keys_gate と同じ答えを wasm 経由で見る)。
// 期待は答えから書き、今の書き換えの出力はなぞらない。
// - K-002 (a): BOM で始まる文書でも、番号付きリストの最初の項目の番号を読み、足す・消す・移したあとの番号を、BOM のない文書と同じく
//   振り直す (BOM は先頭に残る)
// - K-004 (b): 末尾に足す操作 (子を足す、移して入れる、合流で末尾に足す) でも、原文の番号がずれた番号付きリストは全体を図の番号にそろえる。
//   連番のリストは続きの番号、全部同じ番号のリストは同じ番号のまま
// - K-005 (b): 見出しのない文書のルートの名前の入力 (inspectNode の label) は、原文の title の文字のまま (書式の記法を含む) で開き、
//   少し直して決めても書式が残る。label のまま決めると原文を変えない。title が文字でないときと title がないときは、今までどおり図の名前で開く
// - K-008 (0.12.0 に戻す): 日付の形の値は、グループの名前も引用符で囲まずに書く (title は edit-keys-review の B-10 が見る)。
//   yes / no / on / off などは今までどおり囲む
// 指すノードは操作の前に parseDocument で確かめ、期待の文書は比べる前にねらいの名前で読まれることを確かめる
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

type Target = [number, string];

const NEW = '新しいノード';
const JOINED = '合流点';
const BOM = '﻿';

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

const selected = ([id, refText]: Target): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

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

function joinIntoNew(source: string, ...sources: Target[]): core.EditOutcome {
    for (const node of sources) expectTarget(source, node);
    return core.editSource(source, { kind: 'joinIntoNew', sources: sources.map(nodeTarget), label: JOINED });
}

function renameNode(source: string, node: Target, label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'renameNode', node: nodeTarget(node), label });
}

function inspected(source: string, node: Target): core.InspectNodeResult {
    expectTarget(source, node);
    const facts = core.inspectNode(source, nodeTarget(node));
    if (facts === null) throw new Error(`inspectNode が null: ${JSON.stringify(source)}`);
    return facts;
}

// 書き換えたあとの原文 (書き換えなければ落とす)
function editedSource(outcome: core.EditOutcome): string {
    expect(outcome.status, JSON.stringify(outcome)).toBe('edited');
    return outcome.status === 'edited' ? outcome.source : '';
}

// 書き換えた結果: 原文の全体、select が 1 つのノード、notes が空。rename は足す操作なら足したノード、ほかは null
function expectResult(outcome: core.EditOutcome, expected: string, chosen: Target, adds: boolean): void {
    expect(nodeOf(expected, chosen[0]).refText, `期待の文書: ${JSON.stringify(expected)}`).toBe(chosen[1]);
    expect(editedSource(outcome)).toBe(expected);
    if (outcome.status !== 'edited') return;
    expect(outcome.select).toEqual(selected(chosen));
    expect(outcome.rename).toEqual(adds ? { kind: 'node', node: { id: chosen[0], refText: chosen[1] } } : null);
    expect(outcome.notes).toEqual([]);
}

// frontmatter の閉じの --- のあとの本文
const bodyOf = (text: string): string => text.split('---\n').at(-1) ?? '';

describe('K-002: BOM で始まる文書でも、BOM のない文書と同じく番号を振り直す (BOM は残る)', () => {
    // BOM のないリストだけの文書。1 (容器) / 2 a / 3 b / 4 c
    const LIST = '1. a\n2. b\n3. c\n';
    const cases: Array<[string, (source: string) => core.EditOutcome, string, Target, boolean]> = [
        ['上に足す', (source) => addSiblingBefore(source, [3, '2. b']), `1. a\n2. ${NEW}\n3. b\n4. c\n`, [3, `2. ${NEW}`], true],
        ['下に足す', (source) => addSibling(source, [3, '2. b']), `1. a\n2. b\n3. ${NEW}\n4. c\n`, [4, `3. ${NEW}`], true],
        ['消す', (source) => deleteNodes(source, [3, '2. b']), '1. a\n2. c\n', [1, ''], false],
        ['移す (c の子へ)', (source) => moveNode(source, [3, '2. b'], [4, '3. c']), '1. a\n2. c\n    - b\n', [4, 'b'], false],
    ];

    it.each(cases)('%s: BOM のない文書の振り直し (対照) と同じ原文の先頭に BOM が 1 つ', (_, apply, expected, chosen, adds) => {
        expectResult(apply(LIST), expected, chosen, adds);
        const after = `${BOM}${expected}`;
        const outcome = apply(`${BOM}${LIST}`);
        expect(editedSource(outcome).split(BOM)).toHaveLength(2);
        expectResult(outcome, after, chosen, adds);
    });

    it('1 以外から始まるリストも、BOM の付いた最初の項目の番号 (3) から数えて振り直す', () => {
        for (const prefix of ['', BOM]) {
            const source = `${prefix}3. a\n4. b\n5. c\n`;
            expect(childrenOf(source, 1)).toEqual(['3. a', '4. b', '5. c']);
            expectResult(deleteNodes(source, [3, '4. b']), `${prefix}3. a\n4. c\n`, [1, ''], false);
            expectResult(addSiblingBefore(source, [3, '4. b']), `${prefix}3. a\n4. ${NEW}\n5. b\n6. c\n`, [3, `4. ${NEW}`], true);
        }
    });
});

describe('K-004: 番号のずれたリストの末尾に足すと、全体を図の番号にそろえる', () => {
    it.each([
        ['1. 5. 6.', '# R\n1. a\n5. b\n6. c\n', [1, 'R'], `# R\n1. a\n2. b\n3. c\n4. ${NEW}\n`, [5, `4. ${NEW}`]],
        ['区切りが「)」', '# R\n1) a\n5) b\n6) c\n', [1, 'R'], `# R\n1) a\n2) b\n3) c\n4) ${NEW}\n`, [5, `4. ${NEW}`]],
        ['3 から始まる (図は 3. 4. 5.)', '# R\n3. a\n7. b\n8. c\n', [1, 'R'], `# R\n3. a\n4. b\n5. c\n6. ${NEW}\n`, [5, `6. ${NEW}`]],
        ['入れ子のリスト', '# R\n- a\n    1. a1\n    5. a2\n    6. a3\n- b\n', [2, 'a'], `# R\n- a\n    1. a1\n    2. a2\n    3. a3\n    4. ${NEW}\n- b\n`, [6, `4. ${NEW}`]],
    ] satisfies Array<[string, string, Target, string, Target]>)('子を足す (%s)', (_, source, parent, expected, added) => {
        expect(nodeOf(expected, added[0]).parent, '期待の文書').toBe(parent[0]);
        expectResult(addChild(source, parent), expected, added, true);
    });

    it('移して入れる: 番号のずれたリストの末尾へ移すと、前の項目も図の番号に書き直す', () => {
        // 1 R / 2 作業 / 3 a / 4 b / 5 c / 6 後で / 7 x / 8 y
        const source = '# R\n\n## 作業\n1. a\n5. b\n6. c\n\n## 後で\n- x\n- y\n';
        const expected = '# R\n\n## 作業\n1. a\n2. b\n3. c\n4. x\n\n## 後で\n- y\n';
        expect(childrenOf(expected, 2), '期待の文書').toEqual(['1. a', '2. b', '3. c', '4. x']);
        expectResult(moveNode(source, [7, 'x'], [2, '作業']), expected, [6, '4. x'], false);
    });

    it('合流で末尾に足す: 始点の枝がリストの入れ物なら最後の項目に足し、前の項目も図の番号にそろえる (本文だけを比べる)', () => {
        // 1 R / 2 入れ物 / 3 p / 4 q / 5 入れ物 / 6 a / 7 b / 8 c
        const source = '---\nmarkdag:\n---\n# R\n- p\n- q\n\n1. a\n5. b\n6. c\n';
        const outcome = joinIntoNew(source, [6, '1. a'], [7, '2. b']);
        const after = editedSource(outcome);
        expect(bodyOf(after)).toBe(`# R\n- p\n- q\n\n1. a\n2. b\n3. c\n4. ${JOINED}\n`);
        expect(childrenOf(after, 5)).toEqual(['1. a', '2. b', '3. c', `4. ${JOINED}`]);
        if (outcome.status === 'edited') expect(outcome.select).toEqual(selected([9, `4. ${JOINED}`]));
    });

    it('今の決まりのまま: 連番のリストは続きの番号、全部同じ番号のリストは同じ番号で末尾に足す', () => {
        for (const [a, b, c, n] of [
            ['1', '2', '3', '4'],
            ['1', '1', '1', '1'],
        ]) {
            const listed = `# R\n${a}. a\n${b}. b\n${c}. c\n`;
            expectResult(addChild(listed, [1, 'R']), `${listed}${n}. ${NEW}\n`, [5, `4. ${NEW}`], true);
            const moved = `# R\n\n## 作業\n${a}. a\n${b}. b\n${c}. c\n\n## 後で\n- x\n- y\n`;
            expectResult(moveNode(moved, [7, 'x'], [2, '作業']), `# R\n\n## 作業\n${a}. a\n${b}. b\n${c}. c\n${n}. x\n\n## 後で\n- y\n`, [6, '4. x'], false);
            const joined = `---\nmarkdag:\n---\n# R\n- p\n- q\n\n${a}. a\n${b}. b\n${c}. c\n`;
            expect(bodyOf(editedSource(joinIntoNew(joined, [6, '1. a'], [7, '2. b'])))).toBe(`# R\n- p\n- q\n\n${a}. a\n${b}. b\n${c}. c\n${n}. ${JOINED}\n`);
        }
    });
});

describe('K-005: ルートのタイトルの名前の入力は、原文の title の文字のまま (書式の記法を含む) で開く', () => {
    // (原文, ルートの refText, 名前の入力の初めの値 = 原文の title の文字)
    const titles: Array<[string, string, string]> = [
        ['---\ntitle: <b>計画</b>\n---\n- 甲\n- 乙\n', '計画', '<b>計画</b>'],
        ['---\ntitle: "<b>計画</b> &amp; 実行"\n---\n- 甲\n- 乙\n', '計画 & 実行', '<b>計画</b> &amp; 実行'],
        ["---\ntitle: '**計画**'\n---\n- 甲\n- 乙\n", '**計画**', '**計画**'],
        ['---\ntitle: <i>計画</i>\n---\n- a\n\n1. b\n', '計画', '<i>計画</i>'],
    ];

    it.each(titles)('%j: label は原文の title の文字', (source, root, written) => {
        const facts = inspected(source, [1, root]);
        expect(facts.canRename).toBe(true);
        expect(facts.label).toBe(written);
    });

    it('label の末尾に「書」を足して決めると、title は <b>計画</b>書 (書式が残る。図の名前は「計画書」)', () => {
        const source = '---\ntitle: <b>計画</b>\n---\n- 甲\n- 乙\n';
        const { label } = inspected(source, [1, '計画']);
        expectResult(renameNode(source, [1, '計画'], `${label}書`), '---\ntitle: <b>計画</b>書\n---\n- 甲\n- 乙\n', [1, '計画書'], false);
    });

    it('引用符で書いた title も、label の末尾に「!」を足して決めると書式と文字参照が残る (引用符の有無は見ない)', () => {
        const source = '---\ntitle: "<b>計画</b> &amp; 実行"\n---\n- 甲\n- 乙\n';
        const { label } = inspected(source, [1, '計画 & 実行']);
        const after = editedSource(renameNode(source, [1, '計画 & 実行'], `${label}!`));
        expect(core.parseDocument(after).frontmatter.title).toBe('<b>計画</b> &amp; 実行!');
        expect(nodeOf(after, 1).refText).toBe('計画 & 実行!');
        expect(after.endsWith('---\n- 甲\n- 乙\n'), after).toBe(true);
    });

    it.each(titles)('%j: label のまま決めると原文を変えない (same-name。項目と同じ)', (source, root) => {
        const { label } = inspected(source, [1, root]);
        const outcome = renameNode(source, [1, root], label);
        expect(outcome.status, JSON.stringify(outcome)).toBe('unchanged');
        if (outcome.status === 'unchanged') expect(outcome.reason?.code).toBe('same-name');
    });

    // レビューの G-03 で足した見張り。(frontmatter の中身 (null なら frontmatter を書かない), 図の名前)
    it.each([
        ['title: 42', '42'],
        ['title: 0x1F', '31'],
        ['title: true', 'true'],
        ['title: [a, b]', 'a,b'],
        ['title: null', ''],
        ['title:', ''],
        ['markdag:', ''],
        [null, ''],
    ] satisfies Array<[string | null, string]>)('title が文字でないか、ない (%s): 今までどおり label は図の名前 (%j) で、label のまま決めると原文を変えない', (inner, name) => {
        for (const body of ['- 甲\n- 乙\n', '- a\n\n1. b\n']) {
            const source = inner === null ? body : `---\n${inner}\n---\n${body}`;
            const facts = inspected(source, [1, name]);
            expect(facts.canRename, source).toBe(true);
            expect(facts.label, source).toBe(name);
            const outcome = renameNode(source, [1, name], name);
            expect(outcome.status, JSON.stringify(outcome)).toBe('unchanged');
            if (outcome.status === 'unchanged') expect(outcome.reason?.code).toBe('same-name');
        }
    });
});

describe('K-008: 日付の形の値は、グループの名前も引用符で囲まずに書く (0.12.0 の書き方)', () => {
    // 1 R / 2 a (g1)
    const GROUPED = '---\nmarkdag:\n    groups:\n        g1:\n            label: 準備\n---\n# R\n- a %g1\n';

    // グループ g1 の名前を label に変えたあとの label の行。読んだ名前はその名前
    function labelLine(label: string): string {
        const after = editedSource(core.editSource(GROUPED, { kind: 'renameGroup', group: 'g1', label }));
        const lines = after.split('\n').filter((line) => line.trimStart().startsWith('label:'));
        expect(lines, after).toHaveLength(1);
        const groups = (core.parseDocument(after).frontmatter.markdag as { groups: Record<string, { label: unknown }> }).groups;
        expect(groups.g1?.label, after).toBe(label);
        return lines[0]!;
    }

    it.each(['2026-10-06', '2026-10-06T09:30:00', '2026-10-06 09:30:00'])('%s は引用符なしで書く', (label) => {
        expect(labelLine(label)).toBe(`            label: ${label}`);
    });

    it.each(['yes', 'no', 'on', 'off'])('今までどおり: %s はグループの名前も title も引用符で囲む', (word) => {
        expect([`            label: "${word}"`, `            label: '${word}'`]).toContain(labelLine(word));
        const after = editedSource(renameNode('---\ntitle: T\n---\n- a\n- b\n', [1, 'T'], word));
        expect([`title: "${word}"`, `title: '${word}'`]).toContain(after.split('\n')[1]);
        expect(nodeOf(after, 1).refText).toBe(word);
    });
});

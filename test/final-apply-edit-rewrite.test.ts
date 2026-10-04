// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 6、7、8、10、11、12、13、14、15) を、公開の入口 (markdag/core) から、
// 直す前に落ちるテストとして書く。細かい形は Rust の tests/final_apply_edit_rewrite.rs が見て、ここは境界を通した代表の形を見る。
// 原文の書き方の都合で断っていた操作を、原文を書き直して通す (scope.md の「最後の関門 GUI の操作の方針」)。書き直して通したことは
// 新しい note で知らせない (細部 28)。断るままのもの (ambiguous-reference、frontmatter-invalid、block-node、名前が変わる 2 行以上の
// 下線の見出し、書き直せないフロー形式) は守りのテストで見る。変えない挙動 (今も通り、直したあとも通るもの) は、名前に「変えない」と書いた
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

const MD = '---\nmarkdag:\n---\n';
const BOM = '\u{feff}';

type Target = [number, string];

const nodeTargets = (nodes: Target[]): core.NodeTarget[] => nodes.map(([id, refText]) => ({ id, refText }));
const target = ([id, refText]: Target): core.NodeTarget => ({ id, refText });

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
function checked(source: string, nodes: Target[]): core.NodeTarget[] {
    for (const [id, refText] of nodes) expect(nodeOf(source, id).refText, JSON.stringify(source)).toBe(refText);
    return nodeTargets(nodes);
}

function modelOf(source: string): core.GraphModel {
    const parsed = core.parseDocument(source);
    return core.buildModel(parsed.nodes, parsed.frontmatter, source);
}

const diagnosticCodes = (source: string): string[] => modelOf(source).diagnostics.map((item) => item.code);
const refTexts = (source: string): Array<[number, number | null, string]> => core.parseDocument(source).nodes.map((node) => [node.id, node.parent, node.refText]);
const selected = (...nodes: Target[]): core.EditSelection => ({ kind: 'nodes', nodes: nodeTargets(nodes) });
const drawn = (source: number, targetId: number): core.EditSelection => ({ kind: 'edge', edge: { kind: 'depends', source, target: targetId } });
// path は frontmatter の道すじか null (比べない)
const reasonOf = (code: core.EditReasonCode): unknown => expect.objectContaining({ code, message: expect.stringMatching(/\S/) });
const refused = (code: core.EditReasonCode): unknown => ({ status: 'refused', reason: reasonOf(code) });
const inspected = (source: string, node: Target): core.InspectNodeResult | null => core.inspectNode(source, target(node));

function edited(outcome: core.EditOutcome): Extract<core.EditOutcome, { status: 'edited' }> {
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome;
}

const noteCodes = (outcome: core.EditOutcome): string[] => edited(outcome).notes.map((note) => note.code).sort();

// 原文を解析し直したモデルの relations に、from から to への kind の線が出て、線と参照と YAML の診断がない
function expectEdge(source: string, from: number, to: number, kind: core.RelationKind): void {
    const model = modelOf(source);
    expect(model.relations, JSON.stringify(source)).toContainEqual(expect.objectContaining({ source: from, target: to, kind }));
    const broken = model.diagnostics.filter((item) => /^(ref-|relation-|yaml-|option-)/.test(item.code) || item.code === 'group-invalid');
    expect(broken.map((item) => item.code), JSON.stringify(source)).toEqual([]);
}

// 新しいグループ group1 の定義 (字下げの幅 4)
const GROUP1 = '        group1:\n            label: グループ 1\n            color: "#3B7DD8"\n            boundary: true\n';

describe('B-115: 組でないグループの定義を組に書き直す (plan.md の 6、細部 7)', () => {
    const body = '\n# 計画\n\n- 設計 %dev\n- 実装\n- テスト\n';
    const doc = (definition: string): string => `---\nmarkdag:\n    groups:\n${definition}---\n${body}`;

    it('dev: 開発 の名前を変えると、dev: の下に label の組で書き、凡例は書いた名前になって group-invalid は消える (b115 の頁の案 (a))', () => {
        const source = doc('        dev: 開発\n');
        expect(diagnosticCodes(source)).toContain('group-invalid');
        const after = doc('        dev:\n            label: 開発班\n');
        expect(modelOf(after).groups.map((group) => [group.id, group.label])).toEqual([['dev', '開発班']]);
        expect(diagnosticCodes(after)).not.toContain('group-invalid');
        expect(core.editSource(source, { kind: 'renameGroup', group: 'dev', label: '開発班' })).toEqual({ status: 'edited', source: after, select: { kind: 'group', id: 'dev' }, rename: null, notes: [] });
    });

    it('一覧と複数行の文字の定義も、色と枠を書くときに組に書き直す (消える値は知らせない)', () => {
        expect(edited(core.editSource(doc('        dev:\n            - a\n            - b\n'), { kind: 'setGroupColor', group: 'dev', color: '#D64545' })).source).toBe(doc('        dev:\n            color: "#D64545"\n'));
        const boundary = core.editSource(doc('        dev: |\n            開発\n            班\n'), { kind: 'setGroupBoundary', group: 'dev', boundary: true });
        expect(edited(boundary).source).toBe(doc('        dev:\n            boundary: true\n'));
        expect(noteCodes(boundary)).toEqual([]);
    });

    it('変えない: 別名 (*x) と、groups そのものが写像でない (スカラ、一覧) ときは frontmatter-not-map', () => {
        for (const frontmatter of ['x: &x 開発\nmarkdag:\n    groups:\n        dev: *x\n', 'markdag:\n    groups: 設計\n', 'markdag:\n    groups:\n        - dev\n']) {
            expect(core.editSource(`---\n${frontmatter}---\n${body}`, { kind: 'renameGroup', group: 'dev', label: '開発班' }), frontmatter).toEqual(refused('frontmatter-not-map'));
        }
    });
});

describe('B-121: 怠惰な続きの行も詳細として扱う (plan.md の 7、細部 8、9)', () => {
    const head = '---\nmarkdag:\n    details:\n        display: always\n---\n\n# 計画\n\n';
    const source = `${head}- 設計\n    > 画面の案\n    続きの行\n- 実装\n`;

    it('詳細の入力の初めの値 (inspectNode の details) は、図と同じく続きの行も入れた 2 行', () => {
        expect(nodeOf(source, 2).details).toContain('続きの行');
        expect(inspected(source, [2, '設計'])?.details).toBe('画面の案\n続きの行');
    });

    it('保存すると、続きの行を含む詳細の行を全部外し、入力の行ごとに > を付けて書く', () => {
        expect(core.editSource(source, { kind: 'setDetails', node: target([2, '設計']), text: '画面の案を直した' })).toEqual({
            status: 'edited',
            source: `${head}- 設計\n    > 画面の案を直した\n- 実装\n`,
            select: selected([2, '設計']),
            rename: null,
            notes: [],
        });
        expect(edited(core.editSource(source, { kind: 'setDetails', node: target([2, '設計']), text: '' })).source).toBe(`${head}- 設計\n- 実装\n`);
    });

    it('続きの行を含む詳細は、中身を変えずに保存しても > を補って書き直す (図の詳細は変わらない)。続きの行を含まない詳細は unchanged (改めた細部 9。D-081)', () => {
        const filled = `${head}- 設計\n    > 画面の案\n    > 続きの行\n- 実装\n`;
        expect(nodeOf(filled, 2).details).toBe(nodeOf(source, 2).details);
        expect(core.editSource(source, { kind: 'setDetails', node: target([2, '設計']), text: '画面の案\n続きの行' })).toEqual({
            status: 'edited',
            source: filled,
            select: selected([2, '設計']),
            rename: null,
            notes: [],
        });
        expect(core.editSource(filled, { kind: 'setDetails', node: target([2, '設計']), text: '画面の案\n続きの行' })).toEqual({ status: 'unchanged', reason: { code: 'nothing-to-change', message: expect.stringMatching(/\S/), path: null } });
    });
});

describe('B-096: 最上位の枝がリストの入れ物なら、そのリストの最後に合流ノードを足す (plan.md の 8、細部 10〜12)', () => {
    const source = '---\nmarkdag:\n---\n\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n- 公開\n- 運用\n';

    it('最後の始点 (公開) を含む最上位の枝は入れ物なので、運用のあとに項目として足し、join を書いて新しいノードの名前の入力を開く (b096 の頁の案)', () => {
        const after = '---\nmarkdag:\n    relations:\n        join:\n            - 設計 & 公開 --> 合流\n---\n\n# 計画\n\n- 設計\n- 実装\n\n段落\n\n- 公開\n- 運用\n- 合流\n';
        expectEdge(after, 3, 8, 'join');
        expectEdge(after, 6, 8, 'join');
        expect(core.editSource(source, { kind: 'joinIntoNew', sources: checked(source, [[3, '設計'], [6, '公開']]), label: '合流' })).toEqual({
            status: 'edited',
            source: after,
            select: selected([8, '合流']),
            rename: { kind: 'node', node: { id: 8, refText: '合流' } },
            notes: [],
        });
    });

    it('変えない: 最上位の枝が表・コード・画像なら block-node', () => {
        const blocks = `${MD}# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nx\n~~~\n`;
        expect(core.editSource(blocks, { kind: 'joinIntoNew', sources: checked(blocks, [[2, ''], [3, '']]), label: '合流' })).toEqual(refused('block-node'));
    });
});

describe('見出しの詳細を書く (plan.md の 10、細部 16、メインの決定の細部 18)', () => {
    it('見出しも詳細を持てる (canHaveDetails)。すぐ下の引用が詳細', () => {
        const source = `${MD}# R\n## 設計\n> 詳細\n\n- 子\n`;
        expect(inspected(source, [2, '設計'])).toMatchObject({ kind: 'heading', canHaveDetails: true, details: '詳細' });
    });

    it('見出しの行のすぐ次に字下げなしの > で書き、すぐ次の行が空でなければ空行を 1 つはさむ。空の入力は外す', () => {
        const source = `${MD}# R\n## A\n- a\n`;
        const after = `${MD}# R\n## A\n> d\n\n- a\n`;
        expect(core.editSource(source, { kind: 'setDetails', node: target([2, 'A']), text: 'd' })).toEqual({ status: 'edited', source: after, select: selected([2, 'A']), rename: null, notes: [] });
        expect(inspected(after, [2, 'A'])?.details).toBe('d');
        expect(edited(core.editSource(after, { kind: 'setDetails', node: target([2, 'A']), text: '' })).source).toBe(`${MD}# R\n## A\n\n- a\n`);
    });

    it('詳細だけを持つ項目を付け替えで見出しにするときは、詳細を見出しの詳細として書く。続きの段落を持つ項目は今のまま heading-details', () => {
        const source = `${MD}# R\n## A\n## B\n- y\n    > 詳細\n`;
        const after = `${MD}# R\n## A\n\n### y\n> 詳細\n\n## B\n`;
        expect(core.editSource(source, { kind: 'moveNode', node: target([4, 'y']), parent: target([2, 'A']) })).toEqual({ status: 'edited', source: after, select: selected([3, 'y']), rename: null, notes: [] });
        expect(inspected(after, [3, 'y'])).toMatchObject({ kind: 'heading', details: '詳細' });
        expect(core.editSource('# R\n## A\n### A1\n## B\n- y\n\n  続き\n', { kind: 'moveNode', node: target([5, 'y']), parent: target([2, 'A']) })).toEqual(refused('heading-details'));
    });
});

describe('marker-line: 下線の見出しと字下げした見出しを ATX の見出しに書き直す (plan.md の 11、細部 19)', () => {
    const source = `${MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n`;

    it('タグを付けると、下線の見出しと行頭に空白のある見出しを同じ段の ATX の見出しにしてから書く。名前と木の形は変わらない', () => {
        const after = `${MD}# R\n\n## 設計 #k:v\n\n- 画面\n\n## 実装 #k:v\n`;
        expect(refTexts(after)).toEqual(refTexts(source));
        expect(inspected(source, [2, '設計'])?.canMark).toBe(true);
        expect(
            core.editSource(source, {
                kind: 'setTag',
                nodes: checked(source, [
                    [2, '設計'],
                    [4, '実装'],
                ]),
                key: 'k',
                value: 'v',
                replaceKey: null,
            }),
        ).toEqual({ status: 'edited', source: after, select: selected([2, '設計'], [4, '実装']), rename: null, notes: [] });
    });

    it('まとめると %group1 を書き、$n の要る参照は $n1 を書く', () => {
        expect(edited(core.editSource(source, { kind: 'groupNodes', nodes: checked(source, [[2, '設計']]) })).source).toBe(`---\nmarkdag:\n    groups:\n${GROUP1}---\n# R\n\n## 設計 %group1\n\n- 画面\n\n ## 実装\n`);
        const twice = `${MD}# R\n\n設計\n---\n\n- 画面\n\n設計\n---\n\n- API\n`;
        const outcome = core.editSource(twice, { kind: 'addRelation', from: checked(twice, [[2, '設計']])[0] as core.NodeTarget, to: target([5, 'API']) });
        expect(edited(outcome).source).toBe('---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n');
        expect(noteCodes(outcome)).toEqual(['id-added']);
    });

    it('変えない: 本文が 2 行の下線の見出しは、つなぐと名前が「設計」から「設計 の続き」に変わるので marker-line で、canMark は false', () => {
        const two = `${MD}# R\n\n設計\nの続き\n---\n\n- 画面\n`;
        expect(core.editSource(two, { kind: 'setTag', nodes: checked(two, [[2, '設計']]), key: 'k', value: 'v', replaceKey: null })).toEqual(refused('marker-line'));
        expect(inspected(two, [2, '設計'])).toMatchObject({ kind: 'heading', canMark: false });
    });

    it('本文が印に読める字で終わる見出し (設計 #k) は、ATX に書き直すときに \\#k と逃がして名前を変えない。名前の入力の初めの値に \\ は出ない。canMark は true', () => {
        const source = `${MD}# R\n\n設計 #k\n---\n\n- 画面\n`;
        expect(inspected(source, [2, '設計 #k'])).toMatchObject({ kind: 'heading', canMark: true });
        const after = `${MD}# R\n\n## 設計 \\#k #x:v\n\n- 画面\n`;
        expect(refTexts(after)).toEqual(refTexts(source));
        expect(nodeOf(after, 2).tags.map((tag) => [tag.key, tag.values])).toEqual([['x', ['v']]]);
        expect(inspected(after, [2, '設計 #k'])?.label).toBe('設計 #k');
        expect(core.editSource(source, { kind: 'setTag', nodes: checked(source, [[2, '設計 #k']]), key: 'x', value: 'v', replaceKey: null })).toEqual({
            status: 'edited',
            source: after,
            select: selected([2, '設計 #k']),
            rename: null,
            notes: [],
        });
        const indented = `${MD}# R\n\n ## 実装 #k\n\n- 画面\n`;
        expect(edited(core.editSource(indented, { kind: 'groupNodes', nodes: checked(indented, [[2, '実装 #k']]) })).source).toBe(`---\nmarkdag:\n    groups:\n${GROUP1}---\n# R\n\n## 実装 \\#k %group1\n\n- 画面\n`);
    });
});

describe('flow-style: フロー形式のブロックを字下げの形に書き直す (plan.md の 12、細部 20、21)', () => {
    const body = '# R\n- a\n- b\n- c\n';

    it('書く道すじを含むいちばん外のフロー形式のブロックを、中の値ごと字下げの形に書き直してから書く。読み直した値は変わらない', () => {
        const source = `---\nmarkdag: { legend: { display: false } }\n---\n${body}`;
        const after = `---\nmarkdag:\n    legend:\n        display: false\n    relations:\n        depends:\n            - a --> b\n---\n${body}`;
        expectEdge(after, 2, 3, 'depends');
        expect(core.parseDocument(after).frontmatter.markdag).toMatchObject({ legend: { display: false } });
        expect(core.editSource(source, { kind: 'addRelation', from: target([2, 'a']), to: target([3, 'b']) })).toEqual({ status: 'edited', source: after, select: drawn(2, 3), rename: null, notes: [] });
        const groups = `---\nmarkdag:\n    groups: {}\n---\n${body}`;
        expect(edited(core.editSource(groups, { kind: 'groupNodes', nodes: [target([2, 'a'])] })).source).toBe(`---\nmarkdag:\n    groups:\n${GROUP1}---\n# R\n- a %group1\n- b\n- c\n`);
    });

    it('変えない: コメントやアンカーのあるフロー形式は flow-style、YAML の誤りは frontmatter-invalid', () => {
        for (const frontmatter of ['markdag:\n    relations:\n        depends: [\n            a --> c, # メモ\n        ]\n', 'markdag:\n    relations: &r { depends: [a --> c] }\n']) {
            expect(core.editSource(`---\n${frontmatter}---\n${body}`, { kind: 'addRelation', from: target([2, 'a']), to: target([3, 'b']) }), frontmatter).toEqual(refused('flow-style'));
        }
        expect(core.editSource(`---\nmarkdag:\n    groups: [\n---\n${body}`, { kind: 'groupNodes', nodes: [target([2, 'a'])] })).toEqual(refused('frontmatter-invalid'));
    });
});

describe('block-scalar: | や > の relations の値を - の一覧に書き直す (plan.md の 13、細部 22)', () => {
    it('空でない行ごとに 1 項目の一覧に書き直してから足す (2 行の値は今は 1 つの式に読まれて線にならない)', () => {
        const source = '---\nmarkdag:\n    relations:\n        depends: |\n            a --> b\n            b --> c\n---\n# R\n- a\n- b\n- c\n- d\n';
        expect(diagnosticCodes(source)).toContain('ref-not-found');
        const after = '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n            - c --> d\n---\n# R\n- a\n- b\n- c\n- d\n';
        expectEdge(after, 2, 3, 'depends');
        expectEdge(after, 4, 5, 'depends');
        expect(core.editSource(source, { kind: 'addRelation', from: target([4, 'c']), to: target([5, 'd']) })).toEqual({ status: 'edited', source: after, select: drawn(4, 5), rename: null, notes: [] });
    });
});

describe('line-endings: 単独の \\r を文書の改行にそろえる (plan.md の 14、細部 23)', () => {
    it('文書の最初の \\n の改行 (\\n がなければ \\n) に、文書の中の単独の \\r を全部置き換えてから書く', () => {
        expect(edited(core.editSource('# R\n- a\r- b\n', { kind: 'renameNode', node: target([2, 'a']), label: 'x' })).source).toBe('# R\n- x\n- b\n');
        expect(edited(core.editSource('# R\r\n- a\r- b\r\n', { kind: 'renameNode', node: target([2, 'a']), label: 'x' })).source).toBe('# R\r\n- x\r\n- b\r\n');
        expect(edited(core.editSource('# R\r- a\r- b', { kind: 'renameNode', node: target([2, 'a']), label: 'x' })).source).toBe('# R\n- x\n- b');
        const outcome = core.editSource(`${MD}# R\n- a\n- b\r- c\n`, { kind: 'groupNodes', nodes: [target([2, 'a'])] });
        expect(edited(outcome).source).toBe(`---\nmarkdag:\n    groups:\n${GROUP1}---\n# R\n- a %group1\n- b\n- c\n`);
        expect(noteCodes(outcome)).toEqual([]);
    });

    it('操作が何も変えないときは、そろえるだけの書き換えもしない', () => {
        expect(core.editSource('# R\n- a\r- b\n', { kind: 'renameNode', node: target([2, 'a']), label: 'a' })).toEqual({ status: 'unchanged', reason: { code: 'same-name', message: expect.stringMatching(/\S/), path: null } });
    });
});

describe('bom: BOM のすぐあとが --- の行の文書は BOM を外してから書く (plan.md の 15、細部 24)', () => {
    it('markdag: を足す操作は BOM を外し、その frontmatter に書く。note は bom-removed', () => {
        const source = `${BOM}---\nmarkdag:\n---\n# R\n- a\n`;
        expect(core.editSource(source, { kind: 'groupNodes', nodes: checked(source, [[2, 'a']]) })).toEqual({
            status: 'edited',
            source: `---\nmarkdag:\n    groups:\n${GROUP1}---\n# R\n- a %group1\n`,
            select: { kind: 'group', id: 'group1' },
            rename: { kind: 'group', id: 'group1' },
            notes: [expect.objectContaining({ code: 'bom-removed' })],
        });
        const titled = core.editSource(`${BOM}---\ntitle: T\n---\n# R\n- a\n`, { kind: 'setTag', nodes: [target([2, 'a'])], key: 'k', value: 'v', replaceKey: null });
        expect(edited(titled).source).toBe('---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n');
        expect(noteCodes(titled)).toEqual(['bom-removed', 'markdag-added']);
    });

    it('変えない: markdag: を足さない操作では BOM を行頭のまま残す', () => {
        expect(edited(core.editSource(`${BOM}---\ntitle: T\n---\n# R\n- a\n`, { kind: 'renameNode', node: target([2, 'a']), label: 'x' })).source).toBe(`${BOM}---\ntitle: T\n---\n# R\n- x\n`);
    });
});

describe('断るままのもの (scope.md の「最後の関門 原文の都合で断る 4、5、8」)', () => {
    it('変えない: 同じ $id が 2 つで名前でも決まらないノードは ambiguous-reference、表とコードと画像は block-node', () => {
        const ambiguous = `${MD}# 計画\n\n- 設計 $x\n- 設計 $x\n- 実装\n`;
        expect(core.editSource(ambiguous, { kind: 'addRelation', from: checked(ambiguous, [[4, '実装']])[0] as core.NodeTarget, to: target([3, '設計']) })).toEqual(refused('ambiguous-reference'));
        const table = `${MD}# 計画\n\n## 設計\n\n| 画面 | 担当 |\n| --- | --- |\n| 一覧 | 山田 |\n`;
        expect(core.editSource(table, { kind: 'addChild', parent: target([3, '']), label: 'x' })).toEqual(refused('block-node'));
        expect(core.editSource(table, { kind: 'setTag', nodes: [target([3, ''])], key: 'k', value: null, replaceKey: null })).toEqual(refused('block-node'));
    });
});

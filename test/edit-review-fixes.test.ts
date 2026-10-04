// GUI 編集の差分のレビューで確かめた指摘 (今直すと仕分けたもの) を、公開の入口 (markdag/core) の editSource と inspectNode から、
// 直す前に落ちるテストとして書く。容器と 1 行目を分け合う最初の項目の削除と付け替え (容器が残る形) と canMark、
// 名前の変更の追随で区切りに化ける名前、付け替えでのコードブロックの中身、選び方に読める名前 (x/*、x/**) の参照、
// BOM で始まる 1 行目の名前、式 1 つのスカラを一覧に書き直すときの行末のコメント。
// 期待の文書は、比べる前に parseDocument と buildModel で読み方 (ノードの親子、コードの中身、線) を確かめる
// (期待の書き誤りを、直す前の赤の確認で見分けるため)
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

type Target = [number, string];
type Edited = Extract<core.EditOutcome, { status: 'edited' }>;

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

function nodeNamed(source: string, refText: string): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.refText === refText);
    if (node === undefined) throw new Error(`${refText} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
function expectTarget(source: string, [id, refText]: Target): void {
    expect(nodeOf(source, id).refText, `id ${id}: ${JSON.stringify(source)}`).toBe(refText);
}

const nodeTarget = ([id, refText]: Target): core.NodeTarget => ({ id, refText });

function rename(source: string, node: Target, label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'renameNode', node: nodeTarget(node), label });
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

function inspect(source: string, node: Target): core.InspectNodeResult {
    expectTarget(source, node);
    const result = core.inspectNode(source, nodeTarget(node));
    if (result === null) throw new Error(`${JSON.stringify(node)} の inspectNode がない: ${JSON.stringify(source)}`);
    return result;
}

function edited(outcome: core.EditOutcome): Edited {
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome;
}

const reason = (code: core.EditReasonCode): unknown => ({ code, message: expect.stringMatching(/\S/), path: null });
const refused = (code: core.EditReasonCode): unknown => ({ status: 'refused', reason: reason(code) });
const unchanged = (code: core.EditReasonCode): unknown => ({ status: 'unchanged', reason: reason(code) });
const selected = ([id, refText]: Target): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

// 書き換えた結果: 原文の全体、select が 1 つのノード (書き換えたあとの原文を解析し直した id と refText)、rename は null、notes は空
function expectRewritten(outcome: core.EditOutcome, expected: string, chosen: Target): void {
    expect(outcome).toEqual({ status: 'edited', source: expected, select: selected(chosen), rename: null, notes: [] });
    expect(nodeOf(expected, chosen[0]).refText).toBe(chosen[1]);
}

// 線 (kind、始点、終点) の並びを整えたもの。名前を変えてもノードの id は変わらないので、id のまま比べる
function relationsOf(source: string): string[] {
    const parsed = core.parseDocument(source);
    return core
        .buildModel(parsed.nodes, parsed.frontmatter, source)
        .relations.map((edge) => `${edge.kind}:${edge.source}>${edge.target}`)
        .sort();
}

function diagnosticsOf(source: string): string[] {
    const parsed = core.parseDocument(source);
    return core
        .buildModel(parsed.nodes, parsed.frontmatter, source)
        .diagnostics.map((item) => `${item.code}:${item.message}`)
        .sort();
}

// ノードの html の中のコードブロックの中身 (<code …> と </code> の間)
function codeOf(html: string): string | null {
    const match = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html);
    return match?.[1] ?? null;
}

describe('レビューの指摘 A-01 / B-02: 容器と 1 行目を分け合う最初の項目の削除と付け替え (容器が残る形)', () => {
    // design 3.5 の削除の既定と behaviors B-038、B-055: 断るのは「容器がなくなるか、ルートが置き換わる」形だけ (G-008、G-010 は項目 2 つ)

    it('項目 3 つ以上のリストの最初の項目を消すと書き換え、選ぶのは消したノードの親 (ルートなら id 1、見出しの下なら容器)', () => {
        const cases: Array<[string, Target, string, Target]> = [
            ['- a\n- b\n- c\n', [2, 'a'], '- b\n- c\n', [1, '']],
            ['---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n', [2, 'a'], '---\ntitle: 手順\nmarkdag:\n---\n- b\n- c\n', [1, '手順']],
            ['- a\n    - a1\n- b\n- c\n', [2, 'a'], '- b\n- c\n', [1, '']],
            ['# R\n- p\n- q\n\n1. a\n2. b\n3. c\n', [6, '1. a'], '# R\n- p\n- q\n\n2. b\n3. c\n', [5, '']],
            ['# R\n\n- a\n- b\n- c\n\n1. p\n2. q\n', [3, 'a'], '# R\n\n- b\n- c\n\n1. p\n2. q\n', [2, '']],
        ];
        for (const [source, node, expected, chosen] of cases) expectRewritten(deleteNodes(source, node), expected, chosen);
    });

    it('項目 3 つ以上のリストの最初の項目を付け替えると書き換え、選ぶのは動かしたノード', () => {
        const cases: Array<[string, Target, Target, string, Target, number]> = [
            ['- a\n- b\n- c\n', [2, 'a'], [3, 'b'], '- b\n    - a\n- c\n', [3, 'a'], 2],
            ['---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n', [2, 'a'], [4, 'c'], '---\ntitle: 手順\nmarkdag:\n---\n- b\n- c\n    - a\n', [4, 'a'], 3],
            ['- a\n    - a1\n- b\n- c\n', [2, 'a'], [4, 'b'], '- b\n    - a\n        - a1\n- c\n', [3, 'a'], 2],
            ['# R\n\n- a\n- b\n- c\n\n1. p\n2. q\n', [3, 'a'], [4, 'b'], '# R\n\n- b\n    - a\n- c\n\n1. p\n2. q\n', [4, 'a'], 3],
            ['# R\n- p\n- q\n\n1. a\n2. b\n3. c\n', [6, '1. a'], [7, '2. b'], '# R\n- p\n- q\n\n2. b\n    - a\n3. c\n', [7, 'a'], 6],
        ];
        for (const [source, node, parent, expected, moved, newParent] of cases) {
            expectRewritten(moveNode(source, node, parent), expected, moved);
            expect(nodeOf(expected, moved[0]).parent, expected).toBe(newParent);
        }
    });

    it('項目 2 つのリストは、1 つ消すか動かすと容器がなくなるので今までどおり structure-changed (G-008、G-010)', () => {
        expect(deleteNodes('- a\n- b\n', [2, 'a'])).toEqual(refused('structure-changed'));
        expect(deleteNodes('---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n', [2, 'a'])).toEqual(refused('structure-changed'));
        expect(deleteNodes('# R\n\n- a\n- b\n\n1. c\n2. d\n', [3, 'a'])).toEqual(refused('structure-changed'));
        expect(moveNode('- a\n- b\n', [2, 'a'], [3, 'b'])).toEqual(refused('structure-changed'));
    });
});

describe('レビューの指摘 A-06: 容器と 1 行目を分け合う項目の canMark', () => {
    // design 3.8: canMark は「1 行目に印を書けるか」で、編集の層は can* で帯のボタンを押せなくする。
    // 容器は分け合う行の印 (グループ、タグ、$id) を読まず、印は最初の項目だけのもの (plan.md の 5、B-107 / B-135) なので、
    // 最初の項目も 2 つ目からの項目と同じく印を書け、タグとグループは最初の項目だけに付く (deviations.md の D-034)

    it('リストだけの文書の最初の項目と、見出しの下の容器の最初の項目も canMark が true (名前、詳細、子と兄弟も true)', () => {
        const firstItems: Array<[string, Target]> = [
            ['- a\n- b\n- c\n', [2, 'a']],
            ['---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n', [2, 'a']],
            ['- a\n- b\n', [2, 'a']],
            ['# R\n\n- a\n- b\n\n1. c\n2. d\n', [3, 'a']],
            ['# R\n\n- a\n- b\n\n1. c\n2. d\n', [6, '1. c']],
        ];
        for (const [source, node] of firstItems) {
            expect(inspect(source, node), `${JSON.stringify(source)} の ${node[1]}`).toMatchObject({
                kind: 'item',
                canMark: true,
                canRename: true,
                canHaveDetails: true,
                canAddChild: true,
                canAddSibling: true,
            });
        }
    });

    it('2 つ目からの項目と、容器のない所の項目は canMark が true', () => {
        const markable: Array<[string, Target]> = [
            ['- a\n- b\n- c\n', [3, 'b']],
            ['---\ntitle: 手順\nmarkdag:\n---\n- a\n- b\n- c\n', [4, 'c']],
            ['# R\n\n- a\n- b\n\n1. c\n2. d\n', [4, 'b']],
            ['# R\n\n- a\n- b\n\n1. c\n2. d\n', [7, '2. d']],
            ['# R\n- a\n    - a1\n- b\n', [3, 'a1']],
            ['# R\n- a\n- b\n', [2, 'a']],
        ];
        for (const [source, node] of markable) expect(inspect(source, node).canMark, `${JSON.stringify(source)} の ${node[1]}`).toBe(true);
    });

    it('その項目へのタグとグループは書き換え、解析し直すと印は最初の項目だけが読む (容器は読まない)', () => {
        // 1 容器 (ルート) / 2 a / 3 b / 4 c
        const source = '---\nmarkdag:\n---\n- a\n- b\n- c\n';
        expectTarget(source, [2, 'a']);

        const tagged = '---\nmarkdag:\n---\n- a #k\n- b\n- c\n';
        expectRewritten(core.editSource(source, { kind: 'setTag', nodes: [{ id: 2, refText: 'a' }], key: 'k', value: null, replaceKey: null }), tagged, [2, 'a']);
        expect(nodeOf(tagged, 1).tags.map((tag) => tag.key), '容器').toEqual([]);
        expect(nodeOf(tagged, 2).tags.map((tag) => tag.key), 'a').toEqual(['k']);

        const grouped = '---\nmarkdag:\n    groups:\n        group1:\n            label: グループ 1\n            color: "#3B7DD8"\n            boundary: true\n---\n- a %group1\n- b\n- c\n';
        expect(core.editSource(source, { kind: 'groupNodes', nodes: [{ id: 2, refText: 'a' }] })).toEqual({
            status: 'edited',
            source: grouped,
            select: { kind: 'group', id: 'group1' },
            rename: { kind: 'group', id: 'group1' },
            notes: [],
        });
        expect(nodeOf(grouped, 1).groups, '容器').toEqual([]);
        expect(nodeOf(grouped, 2).groups, 'a').toEqual(['group1']);
    });
});

describe('レビューの指摘 B-01: 名前の変更の追随で、新しい名前の端が --> か &', () => {
    // design 3.6 の名前の変更の追随: 名前を変えるノードに解決した区間を、書き換えたあとの原文での参照の書き方に置き換える
    // (書いた参照がねらいのノードを指す)。書き方 ("…" で囲むか $n で指すか) は決めず、線が同じ相手で残り、診断が増えないことを見る
    const relationsDocument = (relations: string): string => `---\nmarkdag:\n  relations:\n${relations}---\n# R\n- a\n- b\n- c\n- d\n- e\n`;
    const documents = [
        relationsDocument('    depends:\n      - a --> b\n      - c --> a\n'),
        relationsDocument('    join:\n      - a & c --> d\n      - b & c --> a\n'),
        relationsDocument('    chain:\n      - c --> a --> b\n      - e --> d --> a\n'),
        relationsDocument('    fork:\n      - a --> b & c\n      - d --> e & a\n'),
    ];
    const labels = ['x -->', 'x &', '--> y', '& y', '-->', '&', 'x --> y', 'x & y'];

    it('depends、join、chain、fork のどの位置のノードを、端が区切りの名前に変えても、線が同じ相手で残り診断が増えない', () => {
        const failures: string[] = [];
        let checked = 0;
        for (const source of documents) {
            const relations = relationsOf(source);
            expect(relations.length, source).toBeGreaterThan(0);
            const diagnostics = diagnosticsOf(source);
            expect(diagnostics, source).toEqual([]);
            for (const name of ['a', 'b', 'c', 'd', 'e']) {
                const id = nodeNamed(source, name).id;
                for (const label of labels) {
                    checked += 1;
                    const outcome = rename(source, [id, name], label);
                    if (outcome.status !== 'edited') {
                        failures.push(`${name} → ${JSON.stringify(label)}: ${JSON.stringify(outcome)}`);
                        continue;
                    }
                    const renamed = nodeOf(outcome.source, id).refText;
                    const afterRelations = relationsOf(outcome.source);
                    const afterDiagnostics = diagnosticsOf(outcome.source);
                    if (renamed !== label || JSON.stringify(afterRelations) !== JSON.stringify(relations) || JSON.stringify(afterDiagnostics) !== JSON.stringify(diagnostics)) {
                        failures.push(`${name} → ${JSON.stringify(label)}: 名前 ${JSON.stringify(renamed)}、線 ${JSON.stringify(afterRelations)}、診断 ${JSON.stringify(afterDiagnostics)}\n${outcome.source}`);
                    }
                }
            }
        }
        expect(checked).toBe(160);
        expect(failures, `${failures.length} / ${checked} 件で線が変わった`).toEqual([]);
    });
});

describe('レビューの指摘 B-05: 付け替えで内容の桁が変わっても、コードブロックの中身を書き直さない', () => {
    // design 3.5 の付け替え (2 行目以降は相対の字下げを保つ) と字下げの書き方 (行の中身のタブは変えない)。
    // 書き直すのは元の内容の桁までの字下げで、それより深い所の字 (タブと空白) は原文のまま残す

    it('リストの項目をリストの項目の下へ (深くする、浅くする): フェンスの中の行頭のタブを残す', () => {
        const source = '---\nmarkdag:\n---\n# R\n- a\n  ```make\n  build:\n  \tgcc x.c\n  ```\n- b\n';
        const expected = '---\nmarkdag:\n---\n# R\n- b\n    - a\n      ```make\n      build:\n      \tgcc x.c\n      ```\n';
        expect(codeOf(nodeNamed(source, 'a').html)).toBe('build:\n\tgcc x.c\n');
        expect(codeOf(nodeNamed(expected, 'a').html)).toBe('build:\n\tgcc x.c\n');
        expectRewritten(moveNode(source, [2, 'a'], [3, 'b']), expected, [3, 'a']);

        const nested = '---\nmarkdag:\n---\n# R\n- a\n    - b\n      ```make\n      build:\n      \tgcc x.c\n      ```\n- c\n';
        const raised = '---\nmarkdag:\n---\n# R\n- a\n- c\n- b\n  ```make\n  build:\n  \tgcc x.c\n  ```\n';
        expect(codeOf(nodeNamed(nested, 'b').html)).toBe('build:\n\tgcc x.c\n');
        expect(codeOf(nodeNamed(raised, 'b').html)).toBe('build:\n\tgcc x.c\n');
        expectRewritten(moveNode(nested, [3, 'b'], [1, 'R']), raised, [4, 'b']);
    });

    it('見出しをリストの項目の下へ (コードは項目の続きの行になる): フェンスの中の行頭のタブを残す', () => {
        const source = '---\nmarkdag:\n---\n# R\n\n## A\n\n- t\n\n## H\n\n```py\ndef f():\n\treturn 1\n```\n';
        const expected = '---\nmarkdag:\n---\n# R\n\n## A\n\n- t\n    - H\n\n      ```py\n      def f():\n      \treturn 1\n      ```\n';
        expect(codeOf(nodeOf(source, 5).html)).toBe('def f():\n\treturn 1\n');
        expect(codeOf(nodeNamed(expected, 'H').html)).toBe('def f():\n\treturn 1\n');
        expectRewritten(moveNode(source, [4, 'H'], [3, 't']), expected, [4, 'H']);
    });

    it('対照: 空白だけで字下げしたコードは今も中身が変わらない', () => {
        const source = '---\nmarkdag:\n---\n# R\n- a\n  ~~~\n  x\n      y\n  ~~~\n- b\n';
        const expected = '---\nmarkdag:\n---\n# R\n- b\n    - a\n      ~~~\n      x\n          y\n      ~~~\n';
        expectRewritten(moveNode(source, [2, 'a'], [3, 'b']), expected, [3, 'a']);
        expect(codeOf(nodeNamed(expected, 'a').html)).toBe('x\n    y\n');
    });
});

describe('レビューの指摘 B-06: 参照されているノードの名前を x/* や x/** にする', () => {
    // design 3.6 の参照の書き方の (4): 名前でも親/名前でも決まらなければ、1 行目の末尾に $n を足して指す (線を引く操作と同じ)。
    // ambiguous-reference は $id を持つノードだけ

    it('断らずに書き換え、notes に id-added、線は同じ相手で残る', () => {
        const documents = [
            '---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n',
            '---\nmarkdag:\n  relations:\n    join:\n      - a & c --> b\n---\n# R\n- a\n- b\n- c\n',
        ];
        for (const source of documents) {
            const relations = relationsOf(source);
            expect(relations.length, source).toBeGreaterThan(0);
            for (const label of ['x/*', 'x/**']) {
                const outcome = edited(rename(source, [2, 'a'], label));
                expect(outcome.notes.map((note) => note.code), label).toContain('id-added');
                expect(nodeOf(outcome.source, 2).refText).toBe(label);
                expect(relationsOf(outcome.source), outcome.source).toEqual(relations);
                expect(diagnosticsOf(outcome.source), outcome.source).toEqual([]);
            }
        }
    });

    it('$id を持つノードは 2 つ目の $id を書けないので、今までどおり ambiguous-reference', () => {
        const source = '---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a $dup\n- b\n- c $dup\n';
        expect(relationsOf(source)).toEqual(['depends:2>3']);
        for (const label of ['x/*', 'x/**']) expect(rename(source, [2, 'a'], label)).toEqual(refused('ambiguous-reference'));
    });
});

describe('レビューの指摘 B-07: BOM で始まる文書の 1 行目のノード', () => {
    // design 3.8: label は図の名前と同じ文字 (BOM と行頭の記号を入れない)。3.1: BOM は 1 行目の中身として扱う (名前ではない)。
    // 名前の変更は BOM を行頭に残して書き換える
    const B = '﻿';
    // 原文、ノード、label、名前を X にしたあとの原文、そのあとの refText
    const cases: Array<[string, Target, string, string, string]> = [
        [`${B}# R\n- a\n`, [1, 'R'], 'R', `${B}# X\n- a\n`, 'X'],
        [`${B}- a\n- b\n- c\n`, [2, 'a'], 'a', `${B}- X\n- b\n- c\n`, 'X'],
        [`${B}R\n=\n- a\n`, [1, 'R'], 'R', `${B}X\n=\n- a\n`, 'X'],
        [`${B}1. a\n2. b\n3. c\n`, [2, '1. a'], 'a', `${B}1. X\n2. b\n3. c\n`, '1. X'],
        [`${B}## [ ] R\n- a\n`, [1, 'R'], 'R', `${B}## [ ] X\n- a\n`, 'X'],
        [`${B}- a\n`, [1, 'a'], 'a', `${B}- X\n`, 'X'],
    ];

    it('inspectNode の label に BOM と行頭の記号が入らない', () => {
        for (const [source, node, label] of cases) expect(inspect(source, node).label, JSON.stringify(source)).toBe(label);
    });

    it('名前を変えると BOM を行頭に残して書き換え、label のまま決めると unchanged (same-name)', () => {
        for (const [source, node, label, expected, renamed] of cases) {
            expectRewritten(rename(source, node, 'X'), expected, [node[0], renamed]);
            expect(rename(source, node, label), JSON.stringify(source)).toEqual(unchanged('same-name'));
        }
    });
});

describe('レビューの指摘 B-09: 式 1 つのスカラを一覧に書き直すときの行末のコメント', () => {
    // design 4.2: 名前の追随、削除の追随、参照の守りも、線を引く操作と同じ 2 行の形にする (もとの式の文字は変えない)。
    // 4.8: 範囲の外のコメントは残る。線を引く操作は、キーの行の後ろのコメントを項目の行の末尾に移す
    const source = '---\nmarkdag:\n  relations:\n    depends: a --> b  # メモ\n---\n# R\n- a\n- b\n- c\n';

    it('対照: 線を引く操作はコメントを項目の行に残す (今の振る舞い)', () => {
        const outcome = edited(core.editSource(source, { kind: 'addRelation', from: { id: 3, refText: 'b' }, to: { id: 4, refText: 'c' } }));
        expect(outcome.source).toBe('---\nmarkdag:\n  relations:\n    depends:\n      - a --> b  # メモ\n      - b --> c\n---\n# R\n- a\n- b\n- c\n');
    });

    it('名前の変更の追随', () => {
        const expected = '---\nmarkdag:\n  relations:\n    depends:\n      - x --> b  # メモ\n---\n# R\n- x\n- b\n- c\n';
        expect(relationsOf(expected)).toEqual(['depends:2>3']);
        expect(edited(rename(source, [2, 'a'], 'x')).source).toBe(expected);
    });

    it('参照の守り (同じ名前の兄弟を足すと名前の参照が決まらなくなり、$n1 で書き直す)', () => {
        const expected = '---\nmarkdag:\n  relations:\n    depends:\n      - $n1 --> b  # メモ\n---\n# R\n- a $n1\n- a\n- b\n- c\n';
        expect(relationsOf(expected)).toEqual(['depends:2>4']);
        expectTarget(source, [2, 'a']);
        expect(edited(core.editSource(source, { kind: 'addSibling', node: { id: 2, refText: 'a' }, label: 'a' })).source).toBe(expected);
    });

    it('削除の追随 (chain の末尾の項を外して書き直す)', () => {
        const chain = '---\nmarkdag:\n  relations:\n    chain: a --> b --> c --> d  # メモ\n---\n# R\n- a\n- b\n- c\n- d\n';
        const expected = '---\nmarkdag:\n  relations:\n    chain:\n      - a --> b --> c  # メモ\n---\n# R\n- a\n- b\n- c\n';
        expect(relationsOf(expected)).toEqual(['chain:2>3', 'chain:3>4']);
        expect(edited(deleteNodes(chain, [5, 'd'])).source).toBe(expected);
    });
});

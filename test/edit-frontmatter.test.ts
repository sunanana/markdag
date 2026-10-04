// GUI 編集の frontmatter の書き換え (書き換えの土台と線を引く addRelation、合流と参照の追随、グループの書き換え) の、
// 公開の入口 (markdag/core) からのテスト。CRLF、単独の \r、BOM、stale-node、JSON の形、参照の書き方と数え方の原文、
// frontmatter の足し方と消し方を見る。
// 書き換えたあとの原文の全体と、引いた線が書き換えたあとの原文のモデル (buildModel) の relations に出ることを見る。
// 期待の文書は、比べる前に parseDocument と buildModel で「線が depends として出て、参照と YAML の診断がない」ことを確かめ、
// 指すノードは操作の前に原文の parseDocument で id と refText を確かめる (期待の書き誤りを、実装の前の赤の確認で見分けるため)
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '../src/core';

const MD = '---\nmarkdag:\n---\n';
// frontmatter のない文書と `markdag:` だけの文書に a --> b を引いたときに作る frontmatter (字下げの幅は 4)
const CREATED_AB = '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n';

type Target = [number, string];
type Edited = Extract<core.EditOutcome, { status: 'edited' }>;

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

// 指すノードが、原文の解析でその id と refText を持つ (テストの文書の書き誤りを、操作の前に見つける)
function expectTarget(source: string, [id, refText]: Target): void {
    expect(nodeOf(source, id).refText, JSON.stringify(source)).toBe(refText);
}

const addRelationUnchecked = (source: string, [fromId, fromRef]: Target, [toId, toRef]: Target): core.EditOutcome =>
    core.editSource(source, { kind: 'addRelation', from: { id: fromId, refText: fromRef }, to: { id: toId, refText: toRef } });

function addRelation(source: string, from: Target, to: Target): core.EditOutcome {
    expectTarget(source, from);
    expectTarget(source, to);
    return addRelationUnchecked(source, from, to);
}

function edited(outcome: core.EditOutcome): Edited {
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome;
}

// 線と参照と frontmatter の形の誤りの診断 (引いた線が解決できなかった、YAML として読めない、スキーマに合わない)
const isBrokenRelationDiagnostic = (code: string): boolean =>
    code.startsWith('ref-') || code.startsWith('relation-') || code.startsWith('yaml-') || code.startsWith('option-') || code === 'cycle';

// 原文を解析し直したモデルの relations に、from から to への depends の線が出て、線と参照と YAML の診断がない
function expectRelationResolves(source: string, from: number, to: number): void {
    const parsed = core.parseDocument(source);
    const model = core.buildModel(parsed.nodes, parsed.frontmatter, source);
    expect(model.relations, JSON.stringify(source)).toContainEqual(expect.objectContaining({ source: from, target: to, kind: 'depends' }));
    const broken = model.diagnostics.filter((item) => isBrokenRelationDiagnostic(item.code)).map((item) => `${item.code}: ${item.message}`);
    expect(broken, JSON.stringify(source)).toEqual([]);
}

// 原文の markdag.relations.depends を YAML として読み直した値
function dependsOf(source: string): unknown {
    const markdag = core.parseDocument(source).frontmatter.markdag as { relations?: { depends?: unknown } } | null | undefined;
    return markdag?.relations?.depends;
}

// 引いた線を選ぶ
const drawnEdge = (source: number, target: number): core.EditSelection => ({ kind: 'edge', edge: { kind: 'depends', source, target } });

function noteCodes(outcome: Edited): core.EditNoteCode[] {
    for (const note of outcome.notes) expect(note.message, JSON.stringify(outcome)).toMatch(/\S/);
    return outcome.notes.map((note) => note.code).sort();
}

// 線を引いた結果: 書き換えたあとの原文の全体、select が引いた線 (書き換えたあとの原文の id)、rename が null。
// notes を渡せば、その code がちょうどそれだけ (並びは問わない)
function expectDrawn(source: string, from: Target, to: Target, expected: string, notes?: core.EditNoteCode[]): Edited {
    expectRelationResolves(expected, from[0], to[0]);
    const outcome = edited(addRelation(source, from, to));
    expect(outcome.source, JSON.stringify(source)).toBe(expected);
    expect(outcome.select).toEqual(drawnEdge(from[0], to[0]));
    expect(outcome.rename).toBeNull();
    if (notes !== undefined) expect(noteCodes(outcome)).toEqual([...notes].sort());
    return outcome;
}

// 行末の空白を比べない (`markdag: ~` の値の範囲を消したあとの `markdag: ` の空白は、約束にしない)
const withoutTrailingSpaces = (text: string): string =>
    text
        .split('\n')
        .map((line) => line.replace(/ +$/, ''))
        .join('\n');

function expectRefused(outcome: core.EditOutcome, code: core.EditReasonCode, path?: string): void {
    expect(outcome.status, JSON.stringify(outcome)).toBe('refused');
    if (outcome.status !== 'refused') return;
    // 断るときは原文を返さない
    expect(Object.keys(outcome).sort()).toEqual(['reason', 'status']);
    expect(outcome.reason.code, JSON.stringify(outcome)).toBe(code);
    expect(outcome.reason.message).toMatch(/\S/);
    if (path !== undefined) expect(outcome.reason.path, JSON.stringify(outcome)).toBe(path);
}

function thrown(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('投げるはず');
}

// 本文 (1 R / 2〜8 記号を含む名前 / 9 b) と、escape_segment と同じ規則で逃がした参照
const SYMBOL_BODY = '# R\n- A --> B\n- R & D\n- "引用"\n- #1 案\n- 注意: 重要\n- 入/出力\n- (仮) 案\n- b\n';
const SYMBOL_REFS: Array<[number, string, string]> = [
    [2, 'A --> B', '"A --> B"'],
    [3, 'R & D', '"R & D"'],
    [4, '"引用"', String.raw`"\"引用\""`],
    [5, '#1 案', '#1 案'],
    [6, '注意: 重要', '注意: 重要'],
    [7, '入/出力', String.raw`入\/出力`],
    [8, '(仮) 案', String.raw`\(仮) 案`],
];

describe('editSource の addRelation (GUI 編集の段 5: frontmatter の書き換えの土台と線を引く)', () => {
    it('型: addRelation の op と、引いた線を選ぶ EditSelection の形', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'addRelation' }>>().toEqualTypeOf<{ kind: 'addRelation'; from: core.NodeTarget; to: core.NodeTarget }>();
        expectTypeOf<Extract<core.EditSelection, { kind: 'edge' }>>().toEqualTypeOf<{ kind: 'edge'; edge: core.EdgeTarget }>();
    });

    describe('frontmatter と markdag: を作る (B-017、B-125、design.md 4.3)', () => {
        it('frontmatter のない文書に frontmatter、markdag、relations、depends を作り、もとの 1 行目が空でなければ空行をはさむ (frontmatter-added)', () => {
            const outcome = expectDrawn('# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b\n`);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
            expect(noteCodes(outcome)).not.toContain('bom-removed');
            // もとの 1 行目が空なら空行を足さない。改行で終わらない文書の終わり方は変わらない
            expectDrawn('\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b\n`);
            expectDrawn('# R\n- a\n- b', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b`);
            // CRLF の文書では足す行に \r を付ける
            expectDrawn('# R\r\n- a\r\n- b\r\n', [2, 'a'], [3, 'b'], '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n\r\n# R\r\n- a\r\n- b\r\n');
        });

        it('markdag キーのない frontmatter は最上位の写像の末尾に markdag: を足し、空の frontmatter はその間に入れる (markdag-added)', () => {
            expectDrawn('---\ntitle: T\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n', ['markdag-added']);
            expectDrawn('---\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}# R\n- a\n- b\n`, ['markdag-added']);
        });

        it('markdag: だけ (Null) の文書はキーの行のあとに子の行を入れる。兄弟のキーがあっても、relations: だけでも同じ', () => {
            expectDrawn(`${MD}# R\n- a\n- b\n`, [2, 'a'], [3, 'b'], `${CREATED_AB}# R\n- a\n- b\n`, []);
            expectDrawn('---\nmarkdag:\ntitle: T\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\ntitle: T\n---\n# R\n- a\n- b\n', []);
            expectDrawn('---\nmarkdag:\n    relations:\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}# R\n- a\n- b\n`, []);
        });

        it('値の字がある null (markdag: ~、markdag: null、relations: ~) は値の範囲を消して続ける (B-20。行末の空白は比べない)', () => {
            for (const source of ['---\nmarkdag: ~\n---\n# R\n- a\n- b\n', '---\nmarkdag: null\n---\n# R\n- a\n- b\n', '---\nmarkdag:\n    relations: ~\n---\n# R\n- a\n- b\n']) {
                const expected = `${CREATED_AB}# R\n- a\n- b\n`;
                expectRelationResolves(expected, 2, 3);
                const outcome = edited(addRelation(source, [2, 'a'], [3, 'b']));
                expect(withoutTrailingSpaces(outcome.source), JSON.stringify(source)).toBe(expected);
                expect(outcome.select).toEqual(drawnEdge(2, 3));
                expect(outcome.rename).toBeNull();
                expect(noteCodes(outcome)).toEqual([]);
            }
        });
    });

    describe('depends に足す (B-017、B-20、design.md 4.2)', () => {
        it('relations があって depends がない文書は、relations の末尾に depends: と項目を足す (式 1 つのほかの kind は書き直さない)', () => {
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
                [],
            );
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        chain: a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        chain: a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
            );
        });

        it('既存の depends の最後の項目のすぐあとに足し、あとに続くキーの並びは変えない', () => {
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n    edgeHighlight: true\n---\n# R\n- a\n- b\n- c\n',
                [2, 'a'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - a --> c\n    edgeHighlight: true\n---\n# R\n- a\n- b\n- c\n',
                [],
            );
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n        chain:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
                [2, 'a'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - a --> c\n        chain:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
            );
            // 文書で後ろのノードから前のノードへの線も、引いた向きのまま書く
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n',
                [4, 'c'],
                [2, 'a'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - c --> a\n---\n# R\n- a\n- b\n- c\n',
            );
        });

        it('式 1 つの depends (depends: a --> b) は、キーの行と「- もとの式」の 2 行に書き直してから足す', () => {
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        depends: a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
                [],
            );
            expectDrawn(
                '---\nmarkdag:\n  relations:\n    depends: a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n      - b --> c\n---\n# R\n- a\n- b\n- c\n',
            );
        });

        it('depends の値が複数行のスカラ (| と >) なら、中身の空でない行ごとに 1 項目の - の一覧に書き直してから足す (D-060)', () => {
            for (const indicator of ['|', '>-']) {
                const source = `---\nmarkdag:\n    relations:\n        depends: ${indicator}\n            a --> b\n---\n# R\n- a\n- b\n- c\n`;
                expectDrawn(source, [3, 'b'], [4, 'c'], '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n---\n# R\n- a\n- b\n- c\n', []);
            }
        });
    });

    describe('同じノードと、もうある線 (B-018)', () => {
        it('同じノードへの線は same-node (markdag キーや frontmatter のない文書でも何も足さない)', () => {
            for (const source of [`${MD}# R\n- a\n- b\n`, '---\ntitle: T\n---\n# R\n- a\n- b\n', '# R\n- a\n- b\n']) {
                expectRefused(addRelation(source, [2, 'a'], [2, 'a']), 'same-node');
            }
        });

        it('もうある線は edge-exists: depends の一覧と式 1 つ、chain、fork、join が展開した同じ向きの線', () => {
            const cases: Array<[string, Target, Target]> = [
                ['        depends:\n            - a --> b\n', [2, 'a'], [3, 'b']],
                ['        depends: a --> b\n', [2, 'a'], [3, 'b']],
                ['        chain:\n            - a --> b --> c\n', [3, 'b'], [4, 'c']],
                ['        fork:\n            - a --> b & c\n', [2, 'a'], [4, 'c']],
                ['        join:\n            - a & b --> c\n', [3, 'b'], [4, 'c']],
            ];
            for (const [relations, from, to] of cases) {
                expectRefused(addRelation(`---\nmarkdag:\n    relations:\n${relations}---\n# R\n- a\n- b\n- c\n`, from, to), 'edge-exists');
            }
        });
    });

    describe('参照の書き方 (B-019、design.md 3.6)', () => {
        it('$id が文書で 1 つなら $id、$id が重複しても名前が 1 つなら名前、名前が 2 つなら 親/名前', () => {
            expectDrawn(`${MD}# R\n- a $x\n- b\n`, [2, 'a'], [3, 'b'], '---\nmarkdag:\n    relations:\n        depends:\n            - $x --> b\n---\n# R\n- a $x\n- b\n', []);
            expectDrawn(`${MD}# R\n- p $d\n- q $d\n- b\n`, [2, 'p'], [4, 'b'], '---\nmarkdag:\n    relations:\n        depends:\n            - p --> b\n---\n# R\n- p $d\n- q $d\n- b\n', []);
            expectDrawn(`${MD}# R\n## A\n- x\n## B\n- x\n`, [3, 'x'], [5, 'x'], '---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n---\n# R\n## A\n- x\n## B\n- x\n', []);
        });

        it('名前でも 親/名前 でも決まらないノードは、1 行目の末尾に $n<使われていない最小の番号> を足してそれで指す (id-added)', () => {
            const source = `${MD}# R\n## A\n- x\n- x\n## B\n- y\n`;
            expectDrawn(source, [4, 'x'], [6, 'y'], '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> y\n---\n# R\n## A\n- x\n- x $n1\n## B\n- y\n', ['id-added']);
            expectDrawn(source, [6, 'y'], [3, 'x'], '---\nmarkdag:\n    relations:\n        depends:\n            - y --> $n1\n---\n# R\n## A\n- x $n1\n- x\n## B\n- y\n', ['id-added']);
            // 使われている $n1 と $n3 は飛ばして $n2。印のある行は印の並びの末尾に足す
            expectDrawn(
                `${MD}# R\n## A\n- x\n- x #k\n## B\n- y $n1\n- z $n3\n`,
                [4, 'x'],
                [7, 'z'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - $n2 --> $n3\n---\n# R\n## A\n- x\n- x #k $n2\n## B\n- y $n1\n- z $n3\n',
                ['id-added'],
            );
        });

        it('$id が重複していて名前でも 親/名前 でも決まらないノードは ambiguous-reference', () => {
            const source = `${MD}# R\n## A\n- x $d\n- x $d\n## B\n- y\n`;
            expectRefused(addRelation(source, [4, 'x'], [6, 'y']), 'ambiguous-reference');
            expectRefused(addRelation(source, [6, 'y'], [3, 'x']), 'ambiguous-reference');
        });

        it('$n が要るのに 1 行目のない、行を持たないルート (title なし) と ul と ol の容器は no-source-line', () => {
            // 1 ルート / 2 ul / 3 a / 4 b / 5 ol / 6「1. c」/ 7「2. d」
            const source = `${MD}- a\n- b\n\n1. c\n2. d\n`;
            expectRefused(addRelation(source, [1, ''], [6, '1. c']), 'no-source-line');
            expectRefused(addRelation(source, [3, 'a'], [5, '']), 'no-source-line');
            expectRefused(addRelation(source, [2, ''], [7, '2. d']), 'no-source-line');
        });

        it('$n が要る下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから $n を足す (D-047)', () => {
            const setext = `${MD}# R\n\n設計\n---\n\n- 画面\n\n設計\n---\n\n- API\n`;
            expectDrawn(setext, [2, '設計'], [5, 'API'], '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n', ['id-added']);
            expectDrawn(setext, [3, '画面'], [4, '設計'], '---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> $n1\n---\n# R\n\n設計\n---\n\n- 画面\n\n## 設計 $n1\n\n- API\n', ['id-added']);
            expectDrawn(
                `${MD}# R\n\n ## 実装\n\n- 画面\n\n ## 実装\n\n- API\n`,
                [2, '実装'],
                [5, 'API'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 実装 $n1\n\n- 画面\n\n ## 実装\n\n- API\n',
                ['id-added'],
            );
        });

        it('行を持たないルートでも、title が文書で 1 つなら名前で指す', () => {
            expectDrawn(
                '---\ntitle: T\nmarkdag:\n---\n- a\n    - c\n\n1. b\n',
                [1, 'T'],
                [3, 'c'],
                '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - T --> c\n---\n- a\n    - c\n\n1. b\n',
            );
        });

        it('-->、&、" を含む名前、# で始まる名前、: を含む名前の参照が、YAML として読み直して「参照 --> 参照」の式になる (4.6)', () => {
            const source = `${MD}${SYMBOL_BODY}`;
            for (const [id, name, reference] of SYMBOL_REFS) {
                const cases: Array<[Target, Target, string]> = [
                    [[id, name], [9, 'b'], `${reference} --> b`],
                    [[9, 'b'], [id, name], `b --> ${reference}`],
                ];
                for (const [from, to, expression] of cases) {
                    const outcome = edited(addRelation(source, from, to));
                    expect(dependsOf(outcome.source), JSON.stringify(outcome.source)).toEqual([expression]);
                    expectRelationResolves(outcome.source, from[0], to[0]);
                    expect(outcome.select).toEqual(drawnEdge(from[0], to[0]));
                    // 足すのは frontmatter の 3 行 (relations、depends、項目) だけで、本文は変わらない
                    expect(outcome.source.startsWith('---\nmarkdag:\n    relations:\n        depends:\n            - '), outcome.source).toBe(true);
                    expect(outcome.source.endsWith(`\n---\n${SYMBOL_BODY}`), outcome.source).toBe(true);
                    expect(outcome.source.split('\n').length).toBe(source.split('\n').length + 3);
                }
            }
        });
    });

    describe('数え方の原文 (A-12、design.md 3.6、4.3)', () => {
        it('markdag キーのない文書は markdag: を足したあとの名前で指し、読み方が変わったノードの数を markdag-added の message に添える', () => {
            const expected = '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - API --> 画面\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n';
            const outcome = expectDrawn('---\ntitle: T\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n', [2, 'API #draft'], [3, '画面 %ui'], expected, ['markdag-added']);
            // 読み方が変わるのは API (タグ draft) と 画面 (グループ ui) の 2 つ。数字だけの #12 は印に読まれない
            expect(outcome.notes.find((note) => note.code === 'markdag-added')?.message).toContain('2');
            expect(nodeOf(expected, 2)).toMatchObject({ refText: 'API', tags: [{ key: 'draft' }] });
            expect(nodeOf(expected, 3)).toMatchObject({ refText: '画面', groups: ['ui'] });
            expect(nodeOf(expected, 4).refText).toBe('Issue #12');
        });

        it('足す前は別の名前でも、足したあとに同じ名前になるノードは $n で指す', () => {
            expectDrawn(
                '---\ntitle: T\n---\n# R\n- API #draft\n- API\n- 画面\n',
                [2, 'API #draft'],
                [4, '画面'],
                '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> 画面\n---\n# R\n- API #draft $n1\n- API\n- 画面\n',
                ['id-added', 'markdag-added'],
            );
        });

        it('frontmatter のない文書 (A-12 の再現の形) も、足したあとの名前で指す', () => {
            const outcome = expectDrawn('# R\n- API #draft\n- 画面\n', [2, 'API #draft'], [3, '画面'], '---\nmarkdag:\n    relations:\n        depends:\n            - API --> 画面\n---\n\n# R\n- API #draft\n- 画面\n');
            expect(noteCodes(outcome)).toContain('frontmatter-added');
        });
    });

    describe('BOM (A-02、B-04、design.md 3.1、4.3)', () => {
        it('BOM で始まる文書は BOM を外して frontmatter を作る (bom-removed)', () => {
            const outcome = expectDrawn('﻿# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b\n`);
            expect(noteCodes(outcome)).toEqual(expect.arrayContaining(['bom-removed', 'frontmatter-added']));
        });

        it('BOM のすぐあとが --- の行の文書は、BOM を外してその frontmatter に書く (markdag キーがなければ足す。D-070)', () => {
            expectDrawn('\u{feff}---\nmarkdag:\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], `${CREATED_AB}# R\n- a\n- b\n`, ['bom-removed']);
            expectDrawn(
                '\u{feff}---\ntitle: T\n---\n# R\n- a\n- b\n',
                [2, 'a'],
                [3, 'b'],
                '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n',
                ['bom-removed', 'markdag-added'],
            );
        });
    });

    describe('書き足せない frontmatter (B-002、design.md 4.2、4.4)', () => {
        const body = '# R\n- a\n- b\n- c\n';

        it('足す先がフロー形式なら、書く道すじを含むいちばん外のフロー形式のブロックを字下げの形に書き直してから足す (D-054)', () => {
            const ab = 'markdag:\n    relations:\n        depends:\n            - a --> b\n';
            const cases: Array<[string, Target, Target, string]> = [
                ['markdag: {}\n', [2, 'a'], [3, 'b'], ab],
                ['markdag:\n    relations: {}\n', [2, 'a'], [3, 'b'], ab],
                ['markdag:\n    relations:\n        depends: []\n', [2, 'a'], [3, 'b'], ab],
                ['markdag:\n    relations:\n        depends: [a --> b]\n', [3, 'b'], [4, 'c'], 'markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n'],
                [
                    'markdag:\n    relations:\n        depends: [\n            a --> b,\n            b --> c,\n          ]\n',
                    [2, 'a'],
                    [4, 'c'],
                    'markdag:\n    relations:\n        depends:\n            - a --> b\n            - b --> c\n            - a --> c\n',
                ],
                // フロー形式の中のフロー形式は、いちばん外 (markdag の値) から書き直す
                ['markdag: { relations: { depends: [a --> c] } }\n', [2, 'a'], [3, 'b'], 'markdag:\n    relations:\n        depends:\n            - a --> c\n            - a --> b\n'],
                // frontmatter の全体がフロー形式
                ['{markdag: {}}\n', [2, 'a'], [3, 'b'], ab],
            ];
            for (const [frontmatter, from, to, written] of cases) {
                expectDrawn(`---\n${frontmatter}---\n${body}`, from, to, `---\n${written}---\n${body}`, []);
            }
            expectDrawn(`---\n{title: T}\n---\n${body}`, [2, 'a'], [3, 'b'], `---\ntitle: T\n${ab}---\n${body}`, ['markdag-added']);
        });

        it('YAML として読めない frontmatter は frontmatter-invalid', () => {
            for (const frontmatter of ['markdag:\n    relations: "x\n', 'markdag:\nmarkdag:\n']) {
                expectRefused(addRelation(`---\n${frontmatter}---\n${body}`, [2, 'a'], [3, 'b']), 'frontmatter-invalid');
            }
        });

        it('道すじの途中が写像でない (スカラ、ブロックの一覧、別名) か、最上位が写像でない (一覧、文字列) なら frontmatter-not-map', () => {
            for (const frontmatter of [
                'markdag: true\n',
                'markdag: 設定\n',
                'markdag:\n    relations: a --> b\n',
                'markdag:\n    relations:\n        - a --> b\n',
                'x: &a\n    edgeHighlight: true\nmarkdag: *a\n',
                '- a\n',
                'hello\n',
            ]) {
                expectRefused(addRelation(`---\n${frontmatter}---\n${body}`, [3, 'b'], [4, 'c']), 'frontmatter-not-map');
            }
        });
    });

    describe('字下げ、コメント、数字に見えるキー、CRLF (design.md 4.5、4.8、4.9)', () => {
        it('字下げが 2 の frontmatter と 4 の frontmatter で、足した行がそれぞれの字下げ', () => {
            expectDrawn(
                '---\nmarkdag:\n  relations:\n    chain:\n      - a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n  relations:\n    chain:\n      - a --> b\n    depends:\n      - b --> c\n---\n# R\n- a\n- b\n- c\n',
            );
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n---\n# R\n- a\n- b\n- c\n',
                [3, 'b'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        chain:\n            - a --> b\n        depends:\n            - b --> c\n---\n# R\n- a\n- b\n- c\n',
            );
            // 新しく作る階層の幅は frontmatter の行の字下げのうち最小の正の値 (2)
            expectDrawn('---\nmarkdag:\n  edgeHighlight: true\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], '---\nmarkdag:\n  edgeHighlight: true\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n');
            expectDrawn('---\nfoo:\n  bar: 1\nmarkdag:\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], '---\nfoo:\n  bar: 1\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n');
            expectDrawn(
                '---\ntitle: T\nfoo:\n  bar: 1\n---\n# R\n- a\n- b\n',
                [2, 'a'],
                [3, 'b'],
                '---\ntitle: T\nfoo:\n  bar: 1\nmarkdag:\n  relations:\n    depends:\n      - a --> b\n---\n# R\n- a\n- b\n',
                ['markdag-added'],
            );
            // 一覧の項目は既存の項目の字下げ (キーと同じ桁の「- 」) にそろえる
            expectDrawn(
                '---\nmarkdag:\n    relations:\n        depends:\n        - a --> b\n---\n# R\n- a\n- b\n- c\n',
                [2, 'a'],
                [4, 'c'],
                '---\nmarkdag:\n    relations:\n        depends:\n        - a --> b\n        - a --> c\n---\n# R\n- a\n- b\n- c\n',
            );
        });

        it('コメントの行は残り、足した行のあとに続く。字下げしたコメントは幅に数えない', () => {
            expectDrawn(
                '---\n# 先頭のコメント\nmarkdag:\n    # relations の前のコメント\n    relations:\n        depends:\n            - a --> b # 行末のコメント\n            # 項目のあとのコメント\n    # markdag の終わりのコメント\n---\n# R\n- a\n- b\n- c\n',
                [2, 'a'],
                [4, 'c'],
                '---\n# 先頭のコメント\nmarkdag:\n    # relations の前のコメント\n    relations:\n        depends:\n            - a --> b # 行末のコメント\n            - a --> c\n            # 項目のあとのコメント\n    # markdag の終わりのコメント\n---\n# R\n- a\n- b\n- c\n',
            );
            expectDrawn(
                '---\ntitle: T\n  # 字下げしたコメント\n# 終わりのコメント\n---\n# R\n- a\n- b\n',
                [2, 'a'],
                [3, 'b'],
                '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n  # 字下げしたコメント\n# 終わりのコメント\n---\n# R\n- a\n- b\n',
            );
        });

        it('数字に見えるキー (2024) の写像にも足せる', () => {
            expectDrawn('---\n2024: 年\n---\n# R\n- a\n- b\n', [2, 'a'], [3, 'b'], '---\n2024: 年\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n', ['markdag-added']);
            expectDrawn(
                '---\nmarkdag:\n    groups:\n        2024:\n            label: 年\n---\n# R\n- a\n- b\n',
                [2, 'a'],
                [3, 'b'],
                '---\nmarkdag:\n    groups:\n        2024:\n            label: 年\n    relations:\n        depends:\n            - a --> b\n---\n# R\n- a\n- b\n',
            );
        });

        it('CRLF の frontmatter は足す行と書き直す行の末尾に \\r を付け、$n を足す本文の行も \\r を残す', () => {
            expectDrawn(
                '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n',
                [2, 'a'],
                [4, 'c'],
                '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n            - a --> c\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n',
            );
            expectDrawn('---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n', [2, 'a'], [3, 'b'], '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n');
            expectDrawn('---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n- b\r\n', [2, 'a'], [3, 'b'], '---\r\ntitle: T\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n');
            expectDrawn(
                '---\r\nmarkdag:\r\n    relations:\r\n        depends: a --> b\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n',
                [3, 'b'],
                [4, 'c'],
                '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - a --> b\r\n            - b --> c\r\n---\r\n# R\r\n- a\r\n- b\r\n- c\r\n',
            );
            expectDrawn(
                '---\r\nmarkdag:\r\n---\r\n# R\r\n## A\r\n- x\r\n- x\r\n## B\r\n- y\r\n',
                [4, 'x'],
                [6, 'y'],
                '---\r\nmarkdag:\r\n    relations:\r\n        depends:\r\n            - $n1 --> y\r\n---\r\n# R\r\n## A\r\n- x\r\n- x $n1\r\n## B\r\n- y\r\n',
            );
        });
    });

    describe('包みと、古いノードと行の数え方 (design.md 3.1〜3.3)', () => {
        it('splice は書き換えた行だけを含む: 書き換えない行の対になっていないサロゲートが原文のまま残る', () => {
            expectDrawn(
                `${MD}# R\n## A\n- x\n- x\n## B\n- y\n- c \ud800\n`,
                [4, 'x'],
                [6, 'y'],
                '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> y\n---\n# R\n## A\n- x\n- x $n1\n## B\n- y\n- c \ud800\n',
            );
            expectDrawn('# R\n- a\n- b\n- \udc00\n', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b\n- \udc00\n`);
        });

        it('refText が違う NodeTarget と、その id のノードがない NodeTarget は stale-node', () => {
            const source = `${MD}# R\n- a\n- b\n`;
            expectRefused(addRelationUnchecked(source, [2, 'x'], [3, 'b']), 'stale-node');
            expectRefused(addRelationUnchecked(source, [2, 'a'], [99, 'b']), 'stale-node');
            expectRefused(addRelationUnchecked(source, [Number.NaN, 'a'], [3, 'b']), 'stale-node');
        });

        it('単独の \\r を含む文書は、文書の最初の改行 (\\n) にそろえてから足す (D-065)', () => {
            const outcome = expectDrawn('# R\n- a\n- b\r- c\n', [2, 'a'], [3, 'b'], `${CREATED_AB}\n# R\n- a\n- b\n- c\n`);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
            expectDrawn(`${MD}# R\n- a\n- b\r- c\n`, [2, 'a'], [3, 'b'], `${CREATED_AB}# R\n- a\n- b\n- c\n`, []);
        });

        it('欄の型の違う addRelation は MarkdagError (invalid-input)', () => {
            const bad: unknown[] = [
                { kind: 'addRelation', from: { id: 2, refText: 'a' } },
                { kind: 'addRelation', from: 2, to: { id: 3, refText: 'b' } },
                { kind: 'addRelation', from: { id: 2, refText: 'a' }, to: { id: 3 } },
            ];
            for (const op of bad) {
                const error = thrown(() => core.editSource(`${MD}# R\n- a\n- b\n`, op as core.EditOp));
                expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
                expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
            }
        });
    });
});

// ==== 合流と参照の追随 ====
// ノードの対応と EditNote、joinInto と joinIntoNew、addRelation の cycle、名前の変更の追随、参照の守り、削除の追随、合流の規則。
// 削除の追随の例は、依頼者が触って決めた比べの頁の 4 つの文書をそのまま使う。
// Rust の書き換えのテストの合流と参照の追随と同じ文書と期待で、書き換えたあとの原文の全体、モデル (buildModel) の relations の線、
// notes を見る。期待の文書は比べる前に「ねらいの線がねらいの kind で出て、線と参照と YAML の診断がない」ことを確かめる

type Kind = core.GraphModel['relations'][number]['kind'];
// 線 1 本: [始点、終点、relations の kind]
type Edge = [number, number, Kind];

// 新しい合流先の仮の名前 (呼び出し側が label で渡す)
const JOINED = '合流点';

const nodeTarget = ([id, refText]: Target): core.NodeTarget => ({ id, refText });

// 指すノードを原文の解析で確かめてから NodeTarget にする
function checkedTargets(source: string, nodes: Target[]): core.NodeTarget[] {
    return nodes.map((node) => {
        expectTarget(source, node);
        return nodeTarget(node);
    });
}

function joinInto(source: string, sources: Target[], target: Target): core.EditOutcome {
    const checked = checkedTargets(source, sources);
    expectTarget(source, target);
    return core.editSource(source, { kind: 'joinInto', sources: checked, target: nodeTarget(target) });
}

const joinIntoNew = (source: string, sources: Target[], label: string): core.EditOutcome =>
    core.editSource(source, { kind: 'joinIntoNew', sources: checkedTargets(source, sources), label });

function renameNode(source: string, node: Target, label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'renameNode', node: nodeTarget(node), label });
}

const deleteNodes = (source: string, nodes: Target[]): core.EditOutcome => core.editSource(source, { kind: 'deleteNodes', nodes: checkedTargets(source, nodes) });

function addChild(source: string, parent: Target, label: string): core.EditOutcome {
    expectTarget(source, parent);
    return core.editSource(source, { kind: 'addChild', parent: nodeTarget(parent), label });
}

function addSibling(source: string, node: Target, label: string): core.EditOutcome {
    expectTarget(source, node);
    return core.editSource(source, { kind: 'addSibling', node: nodeTarget(node), label });
}

function moveNode(source: string, node: Target, parent: Target): core.EditOutcome {
    expectTarget(source, node);
    expectTarget(source, parent);
    return core.editSource(source, { kind: 'moveNode', node: nodeTarget(node), parent: nodeTarget(parent) });
}

function modelOf(source: string): core.GraphModel {
    const parsed = core.parseDocument(source);
    return core.buildModel(parsed.nodes, parsed.frontmatter, source);
}

// 線と参照と YAML の診断に、式の形の違い、重なった線、自分への線、展開できない X/*、members の誤りを足したもの
const isBrokenDiagnostic = (code: string): boolean =>
    isBrokenRelationDiagnostic(code) || ['shape-mismatch', 'duplicate-edge', 'self-loop', 'selector-empty', 'group-invalid'].includes(code);

const brokenOf = (model: core.GraphModel): string[] => model.diagnostics.filter((item) => isBrokenDiagnostic(item.code)).map((item) => `${item.code}: ${item.message}`);

// 原文を解析し直したモデルの relations に、これらの線がその kind で出て、壊れた線と参照の診断がない
function expectEdges(source: string, edges: Edge[]): void {
    const model = modelOf(source);
    for (const [from, to, kind] of edges) {
        expect(model.relations, JSON.stringify(source)).toContainEqual(expect.objectContaining({ source: from, target: to, kind }));
    }
    expect(brokenOf(model), JSON.stringify(source)).toEqual([]);
}

function expectNoEdge(source: string, from: number, to: number): void {
    expect(
        modelOf(source).relations.filter((relation) => relation.source === from && relation.target === to),
        JSON.stringify(source),
    ).toEqual([]);
}

const selectedNode = (chosen: Target): core.EditSelection => ({ kind: 'nodes', nodes: [nodeTarget(chosen)] });
const renameOf = (chosen: Target): core.EditRename => ({ kind: 'node', node: nodeTarget(chosen) });

// 書き換えた結果: 原文の全体と、select が 1 つのノード (書き換えたあとの原文の id と refText)、
// rename がそのノードか null
function expectRewritten(source: string, outcome: core.EditOutcome, expected: string, chosen: Target, rename: boolean): Edited {
    expectTarget(expected, chosen);
    const result = edited(outcome);
    expect(result.source, JSON.stringify(source)).toBe(expected);
    expect(result.select).toEqual(selectedNode(chosen));
    expect(result.rename).toEqual(rename ? renameOf(chosen) : null);
    return result;
}

const noteCount = (outcome: Edited, code: core.EditNoteCode): number | undefined => outcome.notes.find((note) => note.code === code)?.count;

// 原文の markdag.relations.<kind> を YAML として読み直した値
function relationsOf(source: string, kind: Kind): unknown {
    const markdag = core.parseDocument(source).frontmatter.markdag as { relations?: Record<string, unknown> } | null | undefined;
    return markdag?.relations?.[kind];
}

// 閉じの --- の行のあとの本文
function bodyOf(text: string): string {
    const lines = text.split('\n');
    expect(lines[0], JSON.stringify(text)).toBe('---');
    const close = lines.indexOf('---', 1);
    expect(close, JSON.stringify(text)).toBeGreaterThan(0);
    return lines.slice(close + 1).join('\n');
}

// 本文の行から、行末の ` $n<番号>` を外したもの ($n の番号の振り方は比べない)
const bodyWithoutNMarks = (text: string): string =>
    bodyOf(text)
        .split('\n')
        .map((line) => line.replace(/ \$n\d+$/, ''))
        .join('\n');

// 削除の追随で直した relations の項目 1 つの通知: message は「kind「直す前の項目」」で始まり、
// 同じ kind に残した項目を「」で囲んで含み、phrases の句 (移した depends の項目、外した理由) を含む
interface Fixed {
    kind: Kind;
    before: string;
    after: string[];
    phrases: string[];
}

const SIDE_EMPTIED = ['を外した', '片側の項が全部なくなった'];
const CHAIN_GONE = ['を外した', '2 つ以上つながる所が残らない'];

// relations-removed は直した項目ごとに 1 つ (count は 1)
function expectRelationsRemoved(outcome: Edited, expected: Fixed[]): void {
    const notes = outcome.notes.filter((note) => note.code === 'relations-removed');
    expect(notes, JSON.stringify(outcome.notes)).toHaveLength(expected.length);
    for (const fixed of expected) {
        const head = `${fixed.kind}「${fixed.before}」`;
        const note = notes.find((item) => item.message.startsWith(head));
        expect(note, `${head} で始まる relations-removed: ${JSON.stringify(outcome.notes)}`).toBeDefined();
        if (note === undefined) continue;
        expect(note.count).toBe(1);
        for (const after of fixed.after) expect(note.message).toContain(`「${after}」`);
        for (const phrase of fixed.phrases) expect(note.message).toContain(phrase);
    }
}

// 削除の結果: 原文の全体、select が最初に消したノードの親、rename が null、notes が直した項目ごとの relations-removed だけ
function expectDeleted(source: string, outcome: core.EditOutcome, expected: string, parent: Target, fixed: Fixed[]): Edited {
    const result = expectRewritten(source, outcome, expected, parent, false);
    expect(noteCodes(result)).toEqual(fixed.map(() => 'relations-removed'));
    expectRelationsRemoved(result, fixed);
    return result;
}

// 1 R / 2 a / 3 a1 / 4 a2 / 5 b / 6 c。relations は a1 --> b と b --> c
const CYCLE_SOURCE = '---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n';
// 1 R / 2 設計 / 3 実装 / 4 テスト / 5 リリース
const JOIN_BODY = '# R\n- 設計\n- 実装\n- テスト\n- リリース\n';
// 1 R / 2 設計 / 3 画面 (設計の子) / 4 実装 / 5 テスト / 6 リリース
const REACH_BODY = '# R\n- 設計\n    - 画面\n- 実装\n- テスト\n- リリース\n';
// 1 R / 2 a / 3 a1 / 4 b / 5 c
const JOIN_NEW_BODY = '# R\n- a\n    - a1\n- b\n- c\n';
// 1 R / 2 設計 / 3 画面 / 4 API / 5 実装 / 6 DB / 7 移行 / 8 テスト
const JOIN_NEW_HEADINGS = '# R\n## 設計\n- 画面\n- API\n## 実装\n- DB\n    - 移行\n## テスト\n';
// 1 R / 2 設計 / 3 API / 4 画面 / 5 結合 / 6 公開 / 7 運用 / 8 保守 / 9 監視
const RENAME_BODY = '# R\n- 設計\n    - API\n- 画面\n- 結合\n- 公開\n- 運用\n- 保守\n- 監視\n';
// API を指す relations (4 つの kind)、branches、members。join と fork は 親/名前 で指す
const renameFrontmatter = (api: string): string =>
    `---\nmarkdag:\n    relations:\n        depends:\n            - ${api} --> 公開\n        chain:\n            - 画面 --> ${api} --> 結合\n        join:\n            - 画面 & 設計/${api} --> 運用\n        fork:\n            - 設計/${api} --> 保守 & 監視\n    branches:\n        - ${api}\n    groups:\n        back:\n            members:\n                - ${api}\n---\n`;

// 比べの頁の 1. chain: 1 停止の手順 / 2 画面を切替 / 3 バッチ停止 / 4 書き込み停止 / 5 バックアップ
const DEMO_CHAIN = '---\nmarkdag:\n    relations:\n        chain:\n            - 画面を切替 --> バッチ停止 --> 書き込み停止 --> バックアップ\n---\n\n# 停止の手順\n- 画面を切替\n- バッチ停止\n- 書き込み停止\n- バックアップ\n';
// 比べの頁の 2. join: 1 開発 / 2 企画 / 3 設計 / 4 実装 / 5 テスト / 6 リリース
const DEMO_JOIN = '---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n        join:\n            - 設計 & 実装 & テスト --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- 実装\n- テスト\n- リリース\n';
// 比べの頁の 3. fork と chain: 1 作る / 2 決定 / 3 画面 / 4 API / 5 DB / 6 結合テスト / 7 公開
const DEMO_FORK = '---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 画面 & API & DB\n        chain:\n            - API --> 結合テスト --> 公開\n---\n\n# 作る\n- 決定\n- 画面\n- API\n- DB\n- 結合テスト\n- 公開\n';
// 比べの頁の 4. 配下ごとの削除と 調査/*: 1 企画 / 2 調査 / 3 インタビュー / 4 競合の比較 / 5 アンケート / 6 まとめ / 7 設計
const DEMO_SUBTREE = '---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        depends:\n            - インタビュー --> 設計\n            - まとめ --> 設計\n---\n\n# 企画\n## 調査\n- インタビュー\n- 競合の比較\n- アンケート\n## まとめ\n## 設計\n';

describe('editSource の合流と参照の追随 (GUI 編集の段 6)', () => {
    it('型: joinInto と joinIntoNew の op の形と、断る理由の cycle (design.md 3.3)', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'joinInto' }>>().toEqualTypeOf<{ kind: 'joinInto'; sources: core.NodeTarget[]; target: core.NodeTarget }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'joinIntoNew' }>>().toEqualTypeOf<{ kind: 'joinIntoNew'; sources: core.NodeTarget[]; label: string }>();
        expectTypeOf<'cycle'>().toExtend<core.EditReasonCode>();
    });

    describe('addRelation の cycle (design.md 3.4。引く線が閉路を作るなら断る)', () => {
        it('閉路を作らない線 (同じ向きの道がもうある線、子でない子孫への線) は今までどおり引ける', () => {
            expectDrawn(CYCLE_SOURCE, [3, 'a1'], [6, 'c'], '---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n            - a1 --> c\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n', []);
            expectDrawn(CYCLE_SOURCE, [2, 'a'], [4, 'a2'], '---\nmarkdag:\n    relations:\n        depends:\n            - a1 --> b\n            - b --> c\n            - a --> a2\n---\n# R\n- a\n    - a1\n        - a2\n- b\n- c\n', []);
        });

        it('終点から始点へ relations か木の親子 (か両方) をたどって届く線は cycle で断り、frontmatter も作らない', () => {
            // relations で届く (c --> b、c --> a1)、木の親子で届く (a1 --> a、a2 --> a)、両方で届く (b --> a。a → a1 → b)
            const cases: Array<[Target, Target]> = [
                [[6, 'c'], [5, 'b']],
                [[6, 'c'], [3, 'a1']],
                [[3, 'a1'], [2, 'a']],
                [[4, 'a2'], [2, 'a']],
                [[5, 'b'], [2, 'a']],
            ];
            for (const [from, to] of cases) expectRefused(addRelation(CYCLE_SOURCE, from, to), 'cycle');
            for (const source of ['---\ntitle: T\n---\n# R\n- a\n    - a1\n', '# R\n- a\n    - a1\n']) {
                expectRefused(addRelation(source, [3, 'a1'], [2, 'a']), 'cycle');
            }
        });
    });

    describe('既存のノードへの合流 (joinInto。B-095、B-099、B-101〜B-104、design.md 3.7)', () => {
        it('始点が 2 つ以上なら join に「始点 & 始点 --> 合流先」を 1 行足し、合流先を選ぶ (名前の入力は開かない)', () => {
            const expected = `---\nmarkdag:\n    relations:\n        join:\n            - 設計 & 実装 & テスト --> リリース\n---\n${JOIN_BODY}`;
            expectEdges(expected, [
                [2, 5, 'join'],
                [3, 5, 'join'],
                [4, 5, 'join'],
            ]);
            const source = `${MD}${JOIN_BODY}`;
            const outcome = expectRewritten(source, joinInto(source, [[2, '設計'], [3, '実装'], [4, 'テスト']], [5, 'リリース']), expected, [5, 'リリース'], false);
            expect(outcome.notes).toEqual([]);
        });

        it('既存の join の一覧の最後の項目のすぐあとに足し、あとに続くキーの並びは変えない', () => {
            // 1 R / 2 企画 / 3 設計 / 4 実装 / 5 テスト / 6 リリース
            const body = '# R\n- 企画\n- 設計\n- 実装\n- テスト\n- リリース\n';
            const source = `---\nmarkdag:\n    relations:\n        join:\n            - 企画 & 設計 --> 実装\n        depends:\n            - 企画 --> 設計\n---\n${body}`;
            const expected = `---\nmarkdag:\n    relations:\n        join:\n            - 企画 & 設計 --> 実装\n            - 実装 & テスト --> リリース\n        depends:\n            - 企画 --> 設計\n---\n${body}`;
            expectEdges(expected, [
                [2, 4, 'join'],
                [3, 4, 'join'],
                [2, 3, 'depends'],
                [4, 6, 'join'],
                [5, 6, 'join'],
            ]);
            const outcome = expectRewritten(source, joinInto(source, [[4, '実装'], [5, 'テスト']], [6, 'リリース']), expected, [6, 'リリース'], false);
            expect(outcome.notes).toEqual([]);
        });

        it('同じ名前の始点は 親/名前 で指す (B-019)', () => {
            // 1 R / 2 A / 3 画面 / 4 B / 5 画面 / 6 C / 7 公開
            const body = '# R\n## A\n- 画面\n## B\n- 画面\n## C\n- 公開\n';
            const expected = `---\nmarkdag:\n    relations:\n        join:\n            - A/画面 & B/画面 --> 公開\n---\n${body}`;
            expectEdges(expected, [
                [3, 7, 'join'],
                [5, 7, 'join'],
            ]);
            const source = `${MD}${body}`;
            expectRewritten(source, joinInto(source, [[3, '画面'], [5, '画面']], [7, '公開']), expected, [7, '公開'], false);
        });

        it('合流先へもう線がある始点 (depends、join、fork が展開した線) を外して sources-existing に数え、残りが 1 つなら depends に書く', () => {
            const cases: Array<[string, Target[], string, number]> = [
                ['        depends:\n            - 設計 --> リリース\n', [[2, '設計'], [3, '実装']], '        depends:\n            - 設計 --> リリース\n            - 実装 --> リリース\n', 3],
                ['        join:\n            - 設計 & 実装 --> リリース\n', [[3, '実装'], [4, 'テスト']], '        join:\n            - 設計 & 実装 --> リリース\n        depends:\n            - テスト --> リリース\n', 4],
                ['        fork:\n            - 設計 --> 実装 & リリース\n', [[2, '設計'], [4, 'テスト']], '        fork:\n            - 設計 --> 実装 & リリース\n        depends:\n            - テスト --> リリース\n', 4],
            ];
            for (const [relations, sources, written, remaining] of cases) {
                const source = `---\nmarkdag:\n    relations:\n${relations}---\n${JOIN_BODY}`;
                const expected = `---\nmarkdag:\n    relations:\n${written}---\n${JOIN_BODY}`;
                expectEdges(expected, [[remaining, 5, 'depends']]);
                const outcome = expectRewritten(source, joinInto(source, sources, [5, 'リリース']), expected, [5, 'リリース'], false);
                expect(noteCodes(outcome)).toEqual(['sources-existing']);
                expect(noteCount(outcome, 'sources-existing')).toBe(1);
            }
        });

        it('木の親から子への線もある線として外す', () => {
            // 1 R / 2 設計 / 3 画面 / 4 実装
            const body = '# R\n- 設計\n    - 画面\n- 実装\n';
            const expected = `---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> 画面\n---\n${body}`;
            expectEdges(expected, [[4, 3, 'depends']]);
            const source = `${MD}${body}`;
            const outcome = expectRewritten(source, joinInto(source, [[2, '設計'], [4, '実装']], [3, '画面']), expected, [3, '画面'], false);
            expect(noteCodes(outcome)).toEqual(['sources-existing']);
        });

        it('循環になる始点と線のある始点を両方外し、残りが 2 つなら join に書く。数は分けて出す (B-104)', () => {
            // 1 R / 2 設計 / 3 実装 / 4 テスト / 5 リリース / 6 告知 (リリースの子)
            const body = '# R\n- 設計\n- 実装\n- テスト\n- リリース\n    - 告知\n';
            const source = `---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> リリース\n---\n${body}`;
            const expected = `---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> リリース\n        join:\n            - 実装 & テスト --> リリース\n---\n${body}`;
            expectEdges(expected, [
                [2, 5, 'depends'],
                [3, 5, 'join'],
                [4, 5, 'join'],
            ]);
            const outcome = expectRewritten(
                source,
                joinInto(
                    source,
                    [
                        [2, '設計'],
                        [3, '実装'],
                        [4, 'テスト'],
                        [6, '告知'],
                    ],
                    [5, 'リリース'],
                ),
                expected,
                [5, 'リリース'],
                false,
            );
            expect(noteCodes(outcome)).toEqual(['sources-cycle', 'sources-existing']);
            expect(noteCount(outcome, 'sources-cycle')).toBe(1);
            expect(noteCount(outcome, 'sources-existing')).toBe(1);
        });

        it('合流先から木の親子と relations をたどって届く始点を外し、sources-cycle に数える (B-102)', () => {
            // 木の親子で届く (設計 → 画面)
            let source = `${MD}${REACH_BODY}`;
            let expected = `---\nmarkdag:\n    relations:\n        join:\n            - 実装 & テスト --> 設計\n---\n${REACH_BODY}`;
            expectEdges(expected, [
                [4, 2, 'join'],
                [5, 2, 'join'],
            ]);
            let outcome = expectRewritten(source, joinInto(source, [[3, '画面'], [4, '実装'], [5, 'テスト']], [2, '設計']), expected, [2, '設計'], false);
            expect(noteCodes(outcome)).toEqual(['sources-cycle']);
            expect(noteCount(outcome, 'sources-cycle')).toBe(1);
            // relations を 2 本たどって届く (リリース → 実装 → テスト)。残りの 1 つは depends の末尾
            source = `---\nmarkdag:\n    relations:\n        depends:\n            - リリース --> 実装\n            - 実装 --> テスト\n---\n${REACH_BODY}`;
            expected = `---\nmarkdag:\n    relations:\n        depends:\n            - リリース --> 実装\n            - 実装 --> テスト\n            - 画面 --> リリース\n---\n${REACH_BODY}`;
            expectEdges(expected, [
                [6, 4, 'depends'],
                [4, 5, 'depends'],
                [3, 6, 'depends'],
            ]);
            outcome = expectRewritten(source, joinInto(source, [[3, '画面'], [5, 'テスト']], [6, 'リリース']), expected, [6, 'リリース'], false);
            expect(noteCodes(outcome)).toEqual(['sources-cycle']);
            // 木の親子と relations の両方をたどって届く (設計 → 画面 → テスト)
            source = `---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> テスト\n---\n${REACH_BODY}`;
            expected = `---\nmarkdag:\n    relations:\n        depends:\n            - 画面 --> テスト\n            - 実装 --> 設計\n---\n${REACH_BODY}`;
            expectEdges(expected, [
                [3, 5, 'depends'],
                [4, 2, 'depends'],
            ]);
            outcome = expectRewritten(source, joinInto(source, [[4, '実装'], [5, 'テスト']], [2, '設計']), expected, [2, '設計'], false);
            expect(noteCodes(outcome)).toEqual(['sources-cycle']);
        });

        it('全部の始点が外れたら all-sources-skipped で断り、原文を変えない (frontmatter のない文書でも何も作らない)', () => {
            expectRefused(
                joinInto(`---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> リリース\n            - テスト --> リリース\n---\n${REACH_BODY}`, [[4, '実装'], [5, 'テスト']], [6, 'リリース']),
                'all-sources-skipped',
            );
            expectRefused(joinInto(`---\nmarkdag:\n    relations:\n        depends:\n            - 実装 --> 設計\n---\n${REACH_BODY}`, [[3, '画面'], [4, '実装']], [2, '設計']), 'all-sources-skipped');
            expectRefused(joinInto('# R\n- 設計\n    - 画面\n    - API\n', [[3, '画面'], [4, 'API']], [2, '設計']), 'all-sources-skipped');
        });
    });

    describe('新しい合流先への合流 (joinIntoNew。B-094〜B-098、design.md 3.7)', () => {
        it('いちばん後ろの始点を含む最上位の枝のすぐあとに最上位の兄弟として足し、join を書き、select と rename が新しいノード', () => {
            const source = `${MD}${JOIN_NEW_BODY}`;
            // いちばん後ろの始点 b は最上位の枝そのもの
            let expected = '---\nmarkdag:\n    relations:\n        join:\n            - a1 & b --> 合流点\n---\n# R\n- a\n    - a1\n- b\n- 合流点\n- c\n';
            expectEdges(expected, [
                [3, 5, 'join'],
                [4, 5, 'join'],
            ]);
            let outcome = expectRewritten(source, joinIntoNew(source, [[3, 'a1'], [4, 'b']], JOINED), expected, [5, JOINED], true);
            expect(outcome.notes).toEqual([]);
            // いちばん後ろの始点 a1 は枝 a の中: a のブロック (入れ子の a1 を含む) のすぐあと
            expected = '---\nmarkdag:\n    relations:\n        join:\n            - a & a1 --> 合流点\n---\n# R\n- a\n    - a1\n- 合流点\n- b\n- c\n';
            expectEdges(expected, [
                [2, 4, 'join'],
                [3, 4, 'join'],
            ]);
            outcome = expectRewritten(source, joinIntoNew(source, [[2, 'a'], [3, 'a1']], JOINED), expected, [4, JOINED], true);
            expect(outcome.notes).toEqual([]);
        });

        it('渡した順でなく文書の順でいちばん後ろの始点で場所を決め、見出しの兄弟は前後に空行をはさむ (始点の並びは比べない)', () => {
            const source = `${MD}${JOIN_NEW_HEADINGS}`;
            const outcome = edited(joinIntoNew(source, [[7, '移行'], [3, '画面']], JOINED));
            expect(bodyOf(outcome.source)).toBe('# R\n## 設計\n- 画面\n- API\n## 実装\n- DB\n    - 移行\n\n## 合流点\n\n## テスト\n');
            expect([['画面 & 移行 --> 合流点'], ['移行 & 画面 --> 合流点']]).toContainEqual(relationsOf(outcome.source, 'join'));
            expectEdges(outcome.source, [
                [3, 8, 'join'],
                [7, 8, 'join'],
            ]);
            expect(outcome.select).toEqual(selectedNode([8, JOINED]));
            expect(outcome.rename).toEqual(renameOf([8, JOINED]));
            expect(outcome.notes).toEqual([]);
        });

        it('始点が 2 つ未満なら too-few-sources (B-098)', () => {
            const source = `${MD}${JOIN_NEW_BODY}`;
            expectRefused(joinIntoNew(source, [[4, 'b']], JOINED), 'too-few-sources');
            expectRefused(joinIntoNew(source, [], JOINED), 'too-few-sources');
        });

        it('frontmatter のない文書は frontmatter、markdag、relations、join を作ってから書く', () => {
            const expected = '---\nmarkdag:\n    relations:\n        join:\n            - a & b --> 合流点\n---\n\n# R\n- a\n- b\n- 合流点\n';
            expectEdges(expected, [
                [2, 4, 'join'],
                [3, 4, 'join'],
            ]);
            const source = '# R\n- a\n- b\n';
            const outcome = expectRewritten(source, joinIntoNew(source, [[2, 'a'], [3, 'b']], JOINED), expected, [4, JOINED], true);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
        });

        it('合流を 2 回続けて「合流点」が 2 つになっても、前の join は前の合流点を指したまま解決できる (参照の守り。A-09)', () => {
            // 1 R / 2 a / 3 b / 4 c / 5 d
            const source = `${MD}# R\n- a\n- b\n- c\n- d\n`;
            const first = '---\nmarkdag:\n    relations:\n        join:\n            - a & b --> 合流点\n---\n# R\n- a\n- b\n- 合流点\n- c\n- d\n';
            expectEdges(first, [
                [2, 4, 'join'],
                [3, 4, 'join'],
            ]);
            expectRewritten(source, joinIntoNew(source, [[2, 'a'], [3, 'b']], JOINED), first, [4, JOINED], true);
            // 2 回目は 7 に足す。合流点 も R/合流点 も 2 つに当たるので、前の合流点は $n で指すように書き直す ($n の番号は比べない)
            const outcome = edited(joinIntoNew(first, [[5, 'c'], [6, 'd']], JOINED));
            expect(bodyWithoutNMarks(outcome.source)).toBe('# R\n- a\n- b\n- 合流点\n- c\n- d\n- 合流点\n');
            expectEdges(outcome.source, [
                [2, 4, 'join'],
                [3, 4, 'join'],
                [5, 7, 'join'],
                [6, 7, 'join'],
            ]);
            expect(relationsOf(outcome.source, 'join')).toHaveLength(2);
            expect(outcome.select).toEqual(selectedNode([7, JOINED]));
            expect(outcome.rename).toEqual(renameOf([7, JOINED]));
            expect(noteCodes(outcome)).toEqual(expect.arrayContaining(['refs-rewritten', 'id-added']));
        });

        it('欄の型の違う joinInto と joinIntoNew は MarkdagError (invalid-input)', () => {
            const bad: unknown[] = [
                { kind: 'joinInto', sources: [{ id: 2, refText: 'a' }] },
                { kind: 'joinInto', sources: { id: 2, refText: 'a' }, target: { id: 4, refText: 'c' } },
                { kind: 'joinIntoNew', sources: [{ id: 2, refText: 'a' }] },
                { kind: 'joinIntoNew', sources: [{ id: 2 }], label: JOINED },
            ];
            for (const op of bad) {
                const error = thrown(() => core.editSource(`${MD}# R\n- a\n- b\n- c\n`, op as core.EditOp));
                expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
                expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
            }
        });
    });

    describe('名前の変更の追随 (B-035、B-08、design.md 3.6)', () => {
        it('relations (4 つの kind)、branches、members の参照が追う。親/名前 は最後の区間を書き直し、祖先の区間は残す', () => {
            const edges: Edge[] = [
                [3, 6, 'depends'],
                [4, 3, 'chain'],
                [3, 5, 'chain'],
                [4, 7, 'join'],
                [3, 7, 'join'],
                [3, 8, 'fork'],
                [3, 9, 'fork'],
            ];
            const source = `${renameFrontmatter('API')}${RENAME_BODY}`;
            expectEdges(source, edges);
            const expected = `${renameFrontmatter('API サーバー')}${RENAME_BODY.replace('    - API\n', '    - API サーバー\n')}`;
            expectEdges(expected, edges);
            const model = modelOf(expected);
            expect(model.branches).toEqual([3]);
            expect(model.groupsOf.get(3)).toContain('back');
            expectRewritten(source, renameNode(source, [3, 'API'], 'API サーバー'), expected, [3, 'API サーバー'], false);
        });

        it('親/名前 の祖先の区間と X/* の X も追う', () => {
            // 1 R / 2 設計 / 3 画面 / 4 API / 5 結合 / 6 公開
            const body = '# R\n- 設計\n    - 画面\n    - API\n- 結合\n- 公開\n';
            const source = `---\nmarkdag:\n    relations:\n        join:\n            - 設計/* --> 公開\n        depends:\n            - 設計/API --> 結合\n    branches:\n        - 設計\n---\n${body}`;
            const expected = `---\nmarkdag:\n    relations:\n        join:\n            - 基本設計/* --> 公開\n        depends:\n            - 基本設計/API --> 結合\n    branches:\n        - 基本設計\n---\n${body.replace('- 設計\n', '- 基本設計\n')}`;
            const edges: Edge[] = [
                [3, 6, 'join'],
                [4, 6, 'join'],
                [4, 5, 'depends'],
            ];
            expectEdges(source, edges);
            expectEdges(expected, edges);
            expect(modelOf(expected).branches).toEqual([2]);
            expectRewritten(source, renameNode(source, [2, '設計'], '基本設計'), expected, [2, '基本設計'], false);
        });

        it('式 1 つのスカラは 2 行の形に書き直し、--> を含む新しい名前は "…" で囲んだ参照を YAML の値の書き方で書く', () => {
            let source = '---\nmarkdag:\n    relations:\n        depends: API --> 公開\n---\n# R\n- API\n- 公開\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - API サーバー --> 公開\n---\n# R\n- API サーバー\n- 公開\n';
            expectEdges(expected, [[2, 3, 'depends']]);
            expectRewritten(source, renameNode(source, [2, 'API'], 'API サーバー'), expected, [2, 'API サーバー'], false);
            // 引用符の付け方は比べず、YAML として読み直した式を比べる
            source = '---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n---\n# R\n- API\n- 公開\n';
            const outcome = edited(renameNode(source, [2, 'API'], 'A --> B'));
            expect(bodyOf(outcome.source)).toBe('# R\n- A --> B\n- 公開\n');
            expect(dependsOf(outcome.source)).toEqual(['"A --> B" --> 公開']);
            expectEdges(outcome.source, [[2, 3, 'depends']]);
        });

        it('同じ名前が 2 つの文書で 親/名前 で指したノードの名前を変えても追い (B-08)、解決できなかった参照は変えない', () => {
            // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 z
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n            - x --> z\n            - 存在しない --> z\n---\n# R\n## A\n- x\n## B\n- x\n## C\n- z\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/y\n            - x --> z\n            - 存在しない --> z\n---\n# R\n## A\n- x\n## B\n- y\n## C\n- z\n';
            const model = modelOf(expected);
            expect(model.relations).toContainEqual(expect.objectContaining({ source: 3, target: 5, kind: 'depends' }));
            expect(model.relations).toContainEqual(expect.objectContaining({ source: 3, target: 7, kind: 'depends' }));
            expect(model.diagnostics.filter((item) => isBrokenDiagnostic(item.code)).map((item) => item.code)).toEqual(['ref-not-found']);
            expectRewritten(source, renameNode(source, [5, 'x'], 'y'), expected, [5, 'y'], false);
        });

        it('追う参照がフロー形式のブロックにあれば、字下げの形に書き直してから追う (細部 21。D-056)', () => {
            const cases: Array<[string, string]> = [
                ['markdag:\n    relations:\n        depends: [API --> 公開]\n', 'markdag:\n    relations:\n        depends:\n            - API サーバー --> 公開\n'],
                ['markdag:\n    branches: [API]\n', 'markdag:\n    branches:\n        - API サーバー\n'],
            ];
            for (const [frontmatter, written] of cases) {
                const source = `---\n${frontmatter}---\n# R\n- API\n- 公開\n`;
                const result = expectRewritten(source, renameNode(source, [2, 'API'], 'API サーバー'), `---\n${written}---\n# R\n- API サーバー\n- 公開\n`, [2, 'API サーバー'], false);
                expect(noteCodes(result)).toEqual([]);
            }
        });
    });

    describe('参照の守り (A-09、A-10、A-11、B-03、design.md 3.6)', () => {
        it('名前の変更で既存の名前と同じにしても、その名前を指していた参照は前のノードを指すように書き直る (A-09)', () => {
            // 1 R / 2 A / 3 設計 / 4 B / 5 実装 / 6 C / 7 公開
            const body = '# R\n## A\n- 設計\n## B\n- 実装\n## C\n- 公開\n';
            const renamedBody = '# R\n## A\n- 設計\n## B\n- 設計\n## C\n- 公開\n';
            let source = `---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n---\n${body}`;
            let expected = `---\nmarkdag:\n    relations:\n        depends:\n            - A/設計 --> 公開\n---\n${renamedBody}`;
            expectEdges(expected, [[3, 7, 'depends']]);
            let outcome = expectRewritten(source, renameNode(source, [5, '実装'], '設計'), expected, [5, '設計'], false);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
            expect(noteCount(outcome, 'refs-rewritten')).toBe(1);
            // 名前を変えるノードを指す参照 (追随) と前の名前を指す参照 (守り) が、どちらも 親/名前 になる
            source = `---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n            - 実装 --> 公開\n---\n${body}`;
            expected = `---\nmarkdag:\n    relations:\n        depends:\n            - A/設計 --> 公開\n            - B/設計 --> 公開\n---\n${renamedBody}`;
            expectEdges(expected, [
                [3, 7, 'depends'],
                [5, 7, 'depends'],
            ]);
            outcome = expectRewritten(source, renameNode(source, [5, '実装'], '設計'), expected, [5, '設計'], false);
            expect(noteCodes(outcome)).toContain('refs-rewritten');
            // 親/名前 でも決まらなければ、前のノードの 1 行目に $n を足す。1 R / 2 設計 / 3 実装 / 4 公開
            source = '---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> 公開\n---\n# R\n- 設計\n- 実装\n- 公開\n';
            expected = '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> 公開\n---\n# R\n- 設計 $n1\n- 設計\n- 公開\n';
            expectEdges(expected, [[2, 4, 'depends']]);
            outcome = expectRewritten(source, renameNode(source, [3, '実装'], '設計'), expected, [3, '設計'], false);
            expect(noteCodes(outcome)).toEqual(['id-added', 'refs-rewritten']);
        });

        it('番号付きのリストの先頭に兄弟を足すと、後ろの項目を名前で指す参照が新しい番号に書き直る (A-10)', () => {
            // 1 R / 2 手順 / 3「1. 準備」/ 4「2. 確認」/ 5 公開 → 足したあと 4「2. 新しいノード」/ 5「3. 確認」/ 6 公開
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - 2. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 確認\n## 公開\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 新しいノード\n2. 確認\n## 公開\n';
            expectEdges(source, [[4, 5, 'depends']]);
            expectEdges(expected, [[5, 6, 'depends']]);
            const outcome = expectRewritten(source, addSibling(source, [3, '1. 準備'], '新しいノード'), expected, [4, '2. 新しいノード'], true);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
            expect(noteCount(outcome, 'refs-rewritten')).toBe(1);
        });

        it('同じ名前の項目のある番号付きのリストでも、線が足した項目へ付け替わらない (B-03)', () => {
            // 1 R / 2 手順 / 3「1. 確認」/ 4「2. 確認」/ 5 公開 → 足したあと 4「2. 確認」(足した項目) / 5「3. 確認」/ 6 公開
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - 2. 確認 --> 公開\n---\n# R\n## 手順\n1. 確認\n2. 確認\n## 公開\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 確認\n2. 確認\n2. 確認\n## 公開\n';
            expectEdges(source, [[4, 5, 'depends']]);
            expectEdges(expected, [[5, 6, 'depends']]);
            expectNoEdge(expected, 4, 6);
            const outcome = expectRewritten(source, addSibling(source, [3, '1. 確認'], '確認'), expected, [4, '2. 確認'], true);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
        });

        it('番号付きのリストの途中を消すと、消したノードを指していない後ろの項目の参照を書き直す', () => {
            // 1 R / 2 手順 / 3「1. 準備」/ 4「2. 確認」/ 5「3. 公開」/ 6 まとめ → 消したあと 4「2. 公開」/ 5 まとめ
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - 3. 公開 --> まとめ\n---\n# R\n## 手順\n1. 準備\n2. 確認\n3. 公開\n## まとめ\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - 2. 公開 --> まとめ\n---\n# R\n## 手順\n1. 準備\n3. 公開\n## まとめ\n';
            expectEdges(source, [[5, 6, 'depends']]);
            expectEdges(expected, [[4, 5, 'depends']]);
            const outcome = expectRewritten(source, deleteNodes(source, [[4, '2. 確認']]), expected, [2, '手順'], false);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
        });

        it('親/名前 で指したノードを付け替えると、新しい場所での書き方に書き直す (A-11)', () => {
            // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 y → 付け替えたあと 1 R / 2 A / 3 B / 4 x / 5 C / 6 y / 7 x
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - A/x --> B/x\n---\n# R\n## A\n- x\n## B\n- x\n## C\n- y\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - C/x --> B/x\n---\n# R\n## A\n## B\n- x\n## C\n- y\n- x\n';
            expectEdges(source, [[3, 5, 'depends']]);
            expectEdges(expected, [[7, 4, 'depends']]);
            const outcome = expectRewritten(source, moveNode(source, [3, 'x'], [6, 'C']), expected, [7, 'x'], false);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
        });

        it('名前の重なるノードを足すと、前のノードを 親/名前 で指すように書き直す', () => {
            // 1 R / 2 設計 / 3 API / 4 実装 / 5 公開 → 足したあと 5 API (実装の子) / 6 公開
            const source = '---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n---\n# R\n- 設計\n    - API\n- 実装\n- 公開\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - 設計/API --> 公開\n---\n# R\n- 設計\n    - API\n- 実装\n    - API\n- 公開\n';
            expectEdges(expected, [[3, 6, 'depends']]);
            const outcome = expectRewritten(source, addChild(source, [4, '実装'], 'API'), expected, [5, 'API'], true);
            expect(noteCodes(outcome)).toEqual(['refs-rewritten']);
        });

        it('守りで書き直す参照がフロー形式のブロックにあれば、字下げの形に書き直してから書き直す (細部 21。D-056)', () => {
            const source = '---\nmarkdag:\n    relations:\n        depends: [2. 確認 --> 公開]\n---\n# R\n## 手順\n1. 準備\n2. 確認\n## 公開\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - 3. 確認 --> 公開\n---\n# R\n## 手順\n1. 準備\n2. 新しいノード\n2. 確認\n## 公開\n';
            expectEdges(expected, [[5, 6, 'depends']]);
            const result = expectRewritten(source, addSibling(source, [3, '1. 準備'], '新しいノード'), expected, [4, '2. 新しいノード'], true);
            expect(noteCodes(result)).toEqual(['refs-rewritten']);
        });

        it('守りの書き直しに $n が要るとき、下線の見出しは ATX の見出しに書き直してから $n を足し (D-047)、行を持たないルートは no-source-line で断る', () => {
            // 1 R / 2 設計 (下線) / 3 画面 / 4 実装 (下線) / 5 API。名前を変えた 4 は下線の見出しのまま
            let source = '---\nmarkdag:\n    relations:\n        depends:\n            - 設計 --> API\n---\n# R\n\n設計\n---\n\n- 画面\n\n実装\n---\n\n- API\n';
            expectEdges(source, [[2, 5, 'depends']]);
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - $n1 --> API\n---\n# R\n\n## 設計 $n1\n\n- 画面\n\n設計\n---\n\n- API\n';
            expectEdges(expected, [[2, 5, 'depends']]);
            const result = expectRewritten(source, renameNode(source, [4, '実装'], '設計'), expected, [4, '設計'], false);
            expect(noteCodes(result)).toEqual(['id-added', 'refs-rewritten']);
            // 1 T (行を持たないルート) / 2 a / 3 c
            source = '---\ntitle: T\nmarkdag:\n    relations:\n        depends:\n            - T --> c\n---\n- a\n    - c\n\n1. b\n';
            expectEdges(source, [[1, 3, 'depends']]);
            expectRefused(addChild(source, [2, 'a'], 'T'), 'no-source-line');
        });
    });

    describe('削除の追随 (B-039、design.md 3.6。10.3 の A-03 で決まった規則)', () => {
        it('chain は消したノードの前後で分け、2 つ以上つながる所だけを残す (比べの頁の 1. chain)', () => {
            const before = '画面を切替 --> バッチ停止 --> 書き込み停止 --> バックアップ';
            expectEdges(DEMO_CHAIN, [
                [2, 3, 'chain'],
                [3, 4, 'chain'],
                [4, 5, 'chain'],
            ]);
            // 途中の「バッチ停止」を消すと、前は 1 つだけなので残らない
            let expected = '---\nmarkdag:\n    relations:\n        chain:\n            - 書き込み停止 --> バックアップ\n---\n\n# 停止の手順\n- 画面を切替\n- 書き込み停止\n- バックアップ\n';
            expectEdges(expected, [[3, 4, 'chain']]);
            expectDeleted(DEMO_CHAIN, deleteNodes(DEMO_CHAIN, [[3, 'バッチ停止']]), expected, [1, '停止の手順'], [{ kind: 'chain', before, after: ['書き込み停止 --> バックアップ'], phrases: [] }]);
            // 端の「バックアップ」を消すと、残りの 3 つはつながったまま
            expected = '---\nmarkdag:\n    relations:\n        chain:\n            - 画面を切替 --> バッチ停止 --> 書き込み停止\n---\n\n# 停止の手順\n- 画面を切替\n- バッチ停止\n- 書き込み停止\n';
            expectEdges(expected, [
                [2, 3, 'chain'],
                [3, 4, 'chain'],
            ]);
            expectDeleted(DEMO_CHAIN, deleteNodes(DEMO_CHAIN, [[5, 'バックアップ']]), expected, [1, '停止の手順'], [{ kind: 'chain', before, after: ['画面を切替 --> バッチ停止 --> 書き込み停止'], phrases: [] }]);
        });

        it('2 つ以上つながる所が残らない chain は項目ごと外し、空になった relations のキーも外す (markdag キーは残す)', () => {
            const source = '---\nmarkdag:\n    relations:\n        chain:\n            - a --> b --> c\n---\n# R\n- a\n- b\n- c\n';
            const expected = '---\nmarkdag:\n---\n# R\n- a\n- c\n';
            expectEdges(expected, []);
            expectDeleted(source, deleteNodes(source, [[3, 'b']]), expected, [1, 'R'], [{ kind: 'chain', before: 'a --> b --> c', after: [], phrases: CHAIN_GONE }]);
        });

        it('join は当たる項だけを外し、始点が 1 つになったら depends の末尾に移して join のキーを外す (比べの頁の 2. join)', () => {
            expectEdges(DEMO_JOIN, [
                [2, 3, 'depends'],
                [3, 6, 'join'],
                [4, 6, 'join'],
                [5, 6, 'join'],
            ]);
            const first = '---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n        join:\n            - 設計 & テスト --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- テスト\n- リリース\n';
            expectEdges(first, [
                [2, 3, 'depends'],
                [3, 5, 'join'],
                [4, 5, 'join'],
            ]);
            expectDeleted(DEMO_JOIN, deleteNodes(DEMO_JOIN, [[4, '実装']]), first, [1, '開発'], [{ kind: 'join', before: '設計 & 実装 & テスト --> リリース', after: ['設計 & テスト --> リリース'], phrases: [] }]);
            const second = '---\nmarkdag:\n    relations:\n        depends:\n            - 企画 --> 設計\n            - 設計 --> リリース\n---\n\n# 開発\n- 企画\n- 設計\n- リリース\n';
            expectEdges(second, [
                [2, 3, 'depends'],
                [3, 4, 'depends'],
            ]);
            expectDeleted(first, deleteNodes(first, [[4, 'テスト']]), second, [1, '開発'], [
                { kind: 'join', before: '設計 & テスト --> リリース', after: [], phrases: ['depends「設計 --> リリース」', '始点が 1 つになった'] },
            ]);
        });

        it('fork と chain に出てくるノードを消すと両方の項が外れ、通知は項目ごと。fork の終点が 1 つになれば depends に移す (比べの頁の 3.)', () => {
            expectEdges(DEMO_FORK, [
                [2, 3, 'fork'],
                [2, 4, 'fork'],
                [2, 5, 'fork'],
                [4, 6, 'chain'],
                [6, 7, 'chain'],
            ]);
            const chain: Fixed = { kind: 'chain', before: 'API --> 結合テスト --> 公開', after: ['結合テスト --> 公開'], phrases: [] };
            let expected = '---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 画面 & DB\n        chain:\n            - 結合テスト --> 公開\n---\n\n# 作る\n- 決定\n- 画面\n- DB\n- 結合テスト\n- 公開\n';
            expectEdges(expected, [
                [2, 3, 'fork'],
                [2, 4, 'fork'],
                [5, 6, 'chain'],
            ]);
            expectDeleted(DEMO_FORK, deleteNodes(DEMO_FORK, [[4, 'API']]), expected, [1, '作る'], [{ kind: 'fork', before: '決定 --> 画面 & API & DB', after: ['決定 --> 画面 & DB'], phrases: [] }, chain]);
            // 1 回で 2 つを消すと fork の終点が 1 つになり、depends を relations の末尾に作って移す
            expected = '---\nmarkdag:\n    relations:\n        chain:\n            - 結合テスト --> 公開\n        depends:\n            - 決定 --> 画面\n---\n\n# 作る\n- 決定\n- 画面\n- 結合テスト\n- 公開\n';
            expectEdges(expected, [
                [4, 5, 'chain'],
                [2, 3, 'depends'],
            ]);
            expectDeleted(
                DEMO_FORK,
                deleteNodes(DEMO_FORK, [
                    [4, 'API'],
                    [5, 'DB'],
                ]),
                expected,
                [1, '作る'],
                [{ kind: 'fork', before: '決定 --> 画面 & API & DB', after: [], phrases: ['depends「決定 --> 画面」', '終点が 1 つになった'] }, chain],
            );
        });

        it('X/* と X/** は X そのものが消えたときだけ当たる (比べの頁の 4. 配下ごとの削除と 調査/*)', () => {
            expectEdges(DEMO_SUBTREE, [
                [3, 6, 'join'],
                [4, 6, 'join'],
                [5, 6, 'join'],
                [3, 7, 'depends'],
                [6, 7, 'depends'],
            ]);
            const interview: Fixed = { kind: 'depends', before: 'インタビュー --> 設計', after: [], phrases: SIDE_EMPTIED };
            // 子のインタビューを消しても 調査/* --> まとめ は残り、インタビュー --> 設計 は片側の項が全部なくなるので外す
            let expected = '---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        depends:\n            - まとめ --> 設計\n---\n\n# 企画\n## 調査\n- 競合の比較\n- アンケート\n## まとめ\n## 設計\n';
            expectEdges(expected, [
                [3, 5, 'join'],
                [4, 5, 'join'],
                [5, 6, 'depends'],
            ]);
            expectDeleted(DEMO_SUBTREE, deleteNodes(DEMO_SUBTREE, [[3, 'インタビュー']]), expected, [2, '調査'], [interview]);
            // 調査 (見出し。配下ごと) を消すと 調査/* --> まとめ も外れ、空になった join のキーも外す
            expected = '---\nmarkdag:\n    relations:\n        depends:\n            - まとめ --> 設計\n---\n\n# 企画\n## まとめ\n## 設計\n';
            expectEdges(expected, [[2, 3, 'depends']]);
            expectDeleted(DEMO_SUBTREE, deleteNodes(DEMO_SUBTREE, [[2, '調査']]), expected, [1, '企画'], [{ kind: 'join', before: '調査/* --> まとめ', after: [], phrases: SIDE_EMPTIED }, interview]);
            // X/**。1 企画 / 2 決定 / 3 調査 / 4 インタビュー / 5 アンケート
            const source = '---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 調査/**\n---\n# 企画\n- 決定\n- 調査\n    - インタビュー\n    - アンケート\n';
            expected = '---\nmarkdag:\n    relations:\n        fork:\n            - 決定 --> 調査/**\n---\n# 企画\n- 決定\n- 調査\n    - アンケート\n';
            expectEdges(expected, [
                [2, 3, 'fork'],
                [2, 4, 'fork'],
            ]);
            expectDeleted(source, deleteNodes(source, [[4, 'インタビュー']]), expected, [3, '調査'], []);
            expected = '---\nmarkdag:\n---\n# 企画\n- 決定\n';
            expectEdges(expected, []);
            expectDeleted(source, deleteNodes(source, [[3, '調査']]), expected, [1, '企画'], [{ kind: 'fork', before: '決定 --> 調査/**', after: [], phrases: SIDE_EMPTIED }]);
        });

        it('始点か終点が 1 つになっても、その項が X/* なら depends に移さず同じ kind に残す', () => {
            // 1 企画 / 2 決定 / 3 画面 / 4 メモ / 5 調査 / 6 インタビュー / 7 アンケート / 8 まとめ
            const source = '---\nmarkdag:\n    relations:\n        join:\n            - 調査/* & メモ --> まとめ\n        fork:\n            - 決定 --> 画面 & 調査/*\n---\n# 企画\n- 決定\n- 画面\n- メモ\n- 調査\n    - インタビュー\n    - アンケート\n- まとめ\n';
            const expected = '---\nmarkdag:\n    relations:\n        join:\n            - 調査/* --> まとめ\n        fork:\n            - 決定 --> 調査/*\n---\n# 企画\n- 決定\n- 調査\n    - インタビュー\n    - アンケート\n- まとめ\n';
            expectEdges(source, [
                [6, 8, 'join'],
                [7, 8, 'join'],
                [4, 8, 'join'],
                [2, 3, 'fork'],
                [2, 6, 'fork'],
                [2, 7, 'fork'],
            ]);
            expectEdges(expected, [
                [4, 6, 'join'],
                [5, 6, 'join'],
                [2, 4, 'fork'],
                [2, 5, 'fork'],
            ]);
            const outcome = expectDeleted(
                source,
                deleteNodes(source, [
                    [3, '画面'],
                    [4, 'メモ'],
                ]),
                expected,
                [1, '企画'],
                [
                    { kind: 'join', before: '調査/* & メモ --> まとめ', after: ['調査/* --> まとめ'], phrases: [] },
                    { kind: 'fork', before: '決定 --> 画面 & 調査/*', after: ['決定 --> 調査/*'], phrases: [] },
                ],
            );
            for (const note of outcome.notes) expect(note.message).not.toContain('depends');
        });

        it('項目がなくなった kind と relations のキーは外し、branches と members の項目は外さない', () => {
            let source = '---\nmarkdag:\n    relations:\n        depends:\n            - API --> 公開\n    branches:\n        - API\n    groups:\n        back:\n            members:\n                - API\n---\n# R\n- API\n- 公開\n';
            let expected = '---\nmarkdag:\n    branches:\n        - API\n    groups:\n        back:\n            members:\n                - API\n---\n# R\n- 公開\n';
            expectDeleted(source, deleteNodes(source, [[2, 'API']]), expected, [1, 'R'], [{ kind: 'depends', before: 'API --> 公開', after: [], phrases: SIDE_EMPTIED }]);
            // 式 1 つのスカラの kind も 1 項目の一覧として扱い、外れたらキーごと外す。markdag のほかのキーは残る
            source = '---\nmarkdag:\n    relations:\n        depends: 設計 --> リリース\n    edgeHighlight: true\n---\n# R\n- 設計\n- リリース\n';
            expected = '---\nmarkdag:\n    edgeHighlight: true\n---\n# R\n- リリース\n';
            expectEdges(expected, []);
            expectDeleted(source, deleteNodes(source, [[2, '設計']]), expected, [1, 'R'], [{ kind: 'depends', before: '設計 --> リリース', after: [], phrases: SIDE_EMPTIED }]);
        });

        it('書き換える前に解決できなかった項 (2 つに当たる名前、ない名前) は当てず、当たる項のない項目は変えない', () => {
            // 1 R / 2 A / 3 x / 4 B / 5 x / 6 C / 7 公開
            const frontmatter = '---\nmarkdag:\n    relations:\n        depends:\n            - x --> 公開\n            - 存在しない --> 公開\n---\n';
            const source = `${frontmatter}# R\n## A\n- x\n## B\n- x\n## C\n- 公開\n`;
            expectDeleted(source, deleteNodes(source, [[3, 'x']]), `${frontmatter}# R\n## A\n## B\n- x\n## C\n- 公開\n`, [2, 'A'], []);
        });

        it('式 1 つのスカラを直すときは、キーの行と「- 直した式」の 2 行の形にする (字下げは frontmatter の幅)', () => {
            const afterBody = '# R\n- 設計\n- テスト\n- リリース\n';
            const cases: Array<[string, string]> = [
                [
                    `---\nmarkdag:\n    relations:\n        join: 設計 & 実装 & テスト --> リリース\n---\n${JOIN_BODY}`,
                    `---\nmarkdag:\n    relations:\n        join:\n            - 設計 & テスト --> リリース\n---\n${afterBody}`,
                ],
                [`---\nmarkdag:\n  relations:\n    join: 設計 & 実装 & テスト --> リリース\n---\n${JOIN_BODY}`, `---\nmarkdag:\n  relations:\n    join:\n      - 設計 & テスト --> リリース\n---\n${afterBody}`],
            ];
            for (const [source, expected] of cases) {
                expectEdges(expected, [
                    [2, 4, 'join'],
                    [3, 4, 'join'],
                ]);
                expectDeleted(source, deleteNodes(source, [[3, '実装']]), expected, [1, 'R'], [{ kind: 'join', before: '設計 & 実装 & テスト --> リリース', after: ['設計 & テスト --> リリース'], phrases: [] }]);
            }
        });

        it('分けた chain の項目は、もとの項目の位置にもとの順で並べる', () => {
            // 1 R / 2 a / 3 b / 4 c / 5 d / 6 e / 7 p / 8 q / 9 x / 10 y → 消したあと 4 d / 5 e / 6 p / 7 q / 8 x / 9 y
            const body = '# R\n- a\n- b\n- c\n- d\n- e\n- p\n- q\n- x\n- y\n';
            const source = `---\nmarkdag:\n    relations:\n        chain:\n            - x --> y\n            - a --> b --> c --> d --> e\n            - p --> q\n---\n${body}`;
            const expected = `---\nmarkdag:\n    relations:\n        chain:\n            - x --> y\n            - a --> b\n            - d --> e\n            - p --> q\n---\n${body.replace('- c\n', '')}`;
            expectEdges(expected, [
                [8, 9, 'chain'],
                [2, 3, 'chain'],
                [4, 5, 'chain'],
                [6, 7, 'chain'],
            ]);
            expectDeleted(source, deleteNodes(source, [[4, 'c']]), expected, [1, 'R'], [{ kind: 'chain', before: 'a --> b --> c --> d --> e', after: ['a --> b', 'd --> e'], phrases: [] }]);
        });

        it('join の始点が 1 つになり depends がなければ relations の末尾に作る。同じ項目の 2 つの項を 1 回で消しても通知は 1 つ', () => {
            // 1 R / 2 a / 3 b / 4 c / 5 d / 6 x / 7 y / 8 z
            const source = '---\nmarkdag:\n    relations:\n        join:\n            - a & b & c --> d\n        chain:\n            - x --> y --> z\n---\n# R\n- a\n- b\n- c\n- d\n- x\n- y\n- z\n';
            const expected = '---\nmarkdag:\n    relations:\n        chain:\n            - x --> y --> z\n        depends:\n            - c --> d\n---\n# R\n- c\n- d\n- x\n- y\n- z\n';
            expectEdges(expected, [
                [4, 5, 'chain'],
                [5, 6, 'chain'],
                [2, 3, 'depends'],
            ]);
            expectDeleted(
                source,
                deleteNodes(source, [
                    [2, 'a'],
                    [3, 'b'],
                ]),
                expected,
                [1, 'R'],
                [{ kind: 'join', before: 'a & b & c --> d', after: [], phrases: ['depends「c --> d」', '始点が 1 つになった'] }],
            );
        });

        it('直す項目がフロー形式なら字下げの形に書き直してから外し、移す先の depends が複数行のスカラなら - の一覧に書き直してから足す (D-056)', () => {
            const flow = '---\nmarkdag:\n    relations:\n        depends: [a --> b]\n---\n# R\n- a\n- b\n';
            expectDeleted(flow, deleteNodes(flow, [[2, 'a']]), '---\nmarkdag:\n---\n# R\n- b\n', [1, 'R'], [{ kind: 'depends', before: 'a --> b', after: [], phrases: SIDE_EMPTIED }]);
            const scalar = '---\nmarkdag:\n    relations:\n        depends: |\n            x --> y\n        join:\n            - a & b --> c\n---\n# R\n- a\n- b\n- c\n- x\n- y\n';
            const expected = '---\nmarkdag:\n    relations:\n        depends:\n            - x --> y\n            - b --> c\n---\n# R\n- b\n- c\n- x\n- y\n';
            expectEdges(expected, [
                [4, 5, 'depends'],
                [2, 3, 'depends'],
            ]);
            expectDeleted(scalar, deleteNodes(scalar, [[2, 'a']]), expected, [1, 'R'], [{ kind: 'join', before: 'a & b --> c', after: [], phrases: ['depends「b --> c」', '始点が 1 つになった'] }]);
        });
    });
});

// ==== グループの書き換え ====
// JSON の形、グループの操作と断る理由と飛ばすノード、%印と印を書ける行、frontmatter の書き換えの方式、グループの 6 色の値。
// Rust の書き換えのテストのグループの書き換えと同じ文書と期待で、書き換えたあとの原文の全体と、モデル (buildModel) の groups と
// groupsOf を見る。期待の文書は比べる前に「groups と groupsOf がねらいどおりで、壊れた診断がない」ことを確かめる

// 新しいグループの色。group<番号> は番号から 1 を引いた位置の色で、6 色を巡る
const GROUP_COLORS = ['#3B7DD8', '#2E9E6B', '#E8833A', '#8A5FC2', '#D64545', '#E0A100'];
function colorOf(number: number): string {
    const color = GROUP_COLORS[(number - 1) % GROUP_COLORS.length];
    if (color === undefined) throw new Error(`group${number} の色がない`);
    return color;
}

// 新しいグループ group<番号> の定義の行 (label、color、boundary の順)。key はグループのキーの字下げ、child は中のキーの字下げ
const newGroupLines = (number: number, key: string, child: string): string =>
    `${key}group${number}:\n${child}label: グループ ${number}\n${child}color: "${colorOf(number)}"\n${child}boundary: true\n`;
// 字下げの幅が 4 の frontmatter の markdag.groups の下に足す定義
const newGroup = (number: number): string => newGroupLines(number, '        ', '            ');
// markdag の下に groups のキーと新しい定義を作るときの行 (幅 4)
const newGroups = (number: number): string => `    groups:\n${newGroup(number)}`;

const groupNodesUnchecked = (source: string, nodes: Target[]): core.EditOutcome => core.editSource(source, { kind: 'groupNodes', nodes: nodes.map(nodeTarget) });
const groupNodes = (source: string, nodes: Target[]): core.EditOutcome => core.editSource(source, { kind: 'groupNodes', nodes: checkedTargets(source, nodes) });
const addToGroupUnchecked = (source: string, group: string, nodes: Target[]): core.EditOutcome =>
    core.editSource(source, { kind: 'addToGroup', group, nodes: nodes.map(nodeTarget) });
const addToGroup = (source: string, group: string, nodes: Target[]): core.EditOutcome =>
    core.editSource(source, { kind: 'addToGroup', group, nodes: checkedTargets(source, nodes) });
const defineGroup = (source: string): core.EditOutcome => core.editSource(source, { kind: 'defineGroup' });
const renameGroup = (source: string, group: string, label: string): core.EditOutcome => core.editSource(source, { kind: 'renameGroup', group, label });
const setGroupColor = (source: string, group: string, color: string): core.EditOutcome => core.editSource(source, { kind: 'setGroupColor', group, color });
const setGroupBoundary = (source: string, group: string, boundary: boolean): core.EditOutcome => core.editSource(source, { kind: 'setGroupBoundary', group, boundary });
const ungroup = (source: string, group: string): core.EditOutcome => core.editSource(source, { kind: 'ungroup', group });

// モデルのグループ 1 つ (icon は見ない)
interface GroupRow {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
    defined: boolean;
}

// 定義のあるグループ
const definedGroup = (id: string, label: string, color: string | null, boundary: boolean): GroupRow => ({ id, label, color, boundary, defined: true });
// 本文の %印だけで使われている、定義のないグループ (文字のラベル)
const undefinedGroup = (id: string): GroupRow => ({ id, label: id, color: null, boundary: false, defined: false });
// groupNodes と defineGroup が作る group<番号>
const createdGroup = (number: number): GroupRow => ({ id: `group${number}`, label: `グループ ${number}`, color: colorOf(number), boundary: true, defined: true });

// 原文を解析し直したモデルの groups (定義の順、そのあとに定義のないグループを書かれた順) と、ノードごとの所属 (groupsOf) が
// このとおりで、壊れた診断 (YAML、スキーマ、group-invalid、参照) がない
function expectGroups(source: string, groups: GroupRow[], members: Array<[number, string[]]>): void {
    const model = modelOf(source);
    expect(
        model.groups.map(({ id, label, color, boundary, defined }) => ({ id, label, color, boundary, defined })),
        JSON.stringify(source),
    ).toEqual(groups);
    for (const [id, names] of members) expect(model.groupsOf.get(id) ?? [], `id ${id} の所属: ${JSON.stringify(source)}`).toEqual(names);
    expect(brokenOf(model), JSON.stringify(source)).toEqual([]);
}

const groupSelected = (id: string): core.EditSelection => ({ kind: 'group', id });

// グループを書き換えた結果: 原文の全体、select がそのグループ、rename がそのグループか null
function expectGroupEdited(source: string, outcome: core.EditOutcome, expected: string, group: string, rename: boolean): Edited {
    const result = edited(outcome);
    expect(result.source, JSON.stringify(source)).toBe(expected);
    expect(result.select).toEqual(groupSelected(group));
    expect(result.rename).toEqual(rename ? { kind: 'group', id: group } : null);
    return result;
}

// addToGroup の結果: 原文の全体、select が渡した同じノード、rename が null
function expectNodesKept(source: string, outcome: core.EditOutcome, expected: string, nodes: Target[]): Edited {
    const result = edited(outcome);
    expect(result.source, JSON.stringify(source)).toBe(expected);
    expect(result.select).toEqual({ kind: 'nodes', nodes: nodes.map(nodeTarget) });
    expect(result.rename).toBeNull();
    return result;
}

// グループ解除の結果: 原文の全体、選択を解き (select が none)、rename が null
function expectUngrouped(source: string, outcome: core.EditOutcome, expected: string): Edited {
    const result = edited(outcome);
    expect(result.source, JSON.stringify(source)).toBe(expected);
    expect(result.select).toEqual({ kind: 'none' });
    expect(result.rename).toBeNull();
    return result;
}

// 変えない (unchanged) とその理由
function expectUnchanged(outcome: core.EditOutcome, code: core.EditReasonCode): void {
    expect(outcome.status, JSON.stringify(outcome)).toBe('unchanged');
    if (outcome.status !== 'unchanged') return;
    expect(outcome.reason?.code, JSON.stringify(outcome)).toBe(code);
    expect(outcome.reason?.message).toMatch(/\S/);
}

// 1 R / 2 a / 3 a1 / 4 a2 / 5 b / 6 c
const GROUP_NESTED = '# R\n- a\n    - a1\n        - a2\n- b\n- c\n';
// 1 R / 2 設計 (下線の見出し) / 3 画面 / 4 実装 (行頭に空白のある ATX の見出し)
const GROUP_UNMARKABLE = '# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n';
// 1 R / 2 ul / 3 a / 4 b / 5 ol / 6「1. c」/ 7「2. d」
const GROUP_LISTS = '# R\n\n- a\n- b\n\n1. c\n2. d\n';
// 1 R / 2 表 / 3 コード / 4 画像
const GROUP_BLOCKS = '# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n';
// 定義 g (label G) だけの frontmatter
const DEFINED_G = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n';
// group1 の label がブロックスカラで、あとに group2 の定義が続く文書 (ブロックスカラの最後の行と次のキーの行を取り違えない)
const BLOCK_LABEL = '---\nmarkdag:\n    groups:\n        group1:\n            label: |\n                設計の\n                まとまり\n        group2:\n            label: 実装\n---\n# R\n\n- a %group1\n- b %group2\n';

describe('editSource のグループの書き換え (GUI 編集の段 7)', () => {
    it('型: グループの 7 つの操作の op と、グループを選ぶ EditSelection と EditRename の形 (design.md 3.3)', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'groupNodes' }>>().toEqualTypeOf<{ kind: 'groupNodes'; nodes: core.NodeTarget[] }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'defineGroup' }>>().toEqualTypeOf<{ kind: 'defineGroup' }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'addToGroup' }>>().toEqualTypeOf<{ kind: 'addToGroup'; group: string; nodes: core.NodeTarget[] }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'renameGroup' }>>().toEqualTypeOf<{ kind: 'renameGroup'; group: string; label: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'setGroupColor' }>>().toEqualTypeOf<{ kind: 'setGroupColor'; group: string; color: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'setGroupBoundary' }>>().toEqualTypeOf<{ kind: 'setGroupBoundary'; group: string; boundary: boolean }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'ungroup' }>>().toEqualTypeOf<{ kind: 'ungroup'; group: string }>();
        expectTypeOf<Extract<core.EditSelection, { kind: 'group' }>>().toEqualTypeOf<{ kind: 'group'; id: string }>();
        expectTypeOf<Extract<NonNullable<core.EditRename>, { kind: 'group' }>>().toEqualTypeOf<{ kind: 'group'; id: string }>();
        expectTypeOf<'group-unknown' | 'group-label-empty' | 'color-invalid'>().toExtend<core.EditReasonCode>();
    });

    describe('groupNodes: 印の付け方と飛ばすノード (B-106、B-107、B-110、design.md 3.4、3.5)', () => {
        it('1 つだけ選んでいてもまとめ、1 行目の末尾に %group1、markdag.groups に定義を足し、select と rename がそのグループ', () => {
            // 1 R / 2 a / 3 b
            let source = `${MD}# R\n- a\n- b\n`;
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [
                [1, []],
                [2, ['group1']],
                [3, []],
            ]);
            const outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual([]);
            // 見出しにも 1 行目の末尾に付け、配下は印を引き継ぐ。1 R / 2 A / 3 x / 4 B
            source = `${MD}# R\n## A\n- x\n## B\n`;
            expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n## A %group1\n- x\n## B\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, ['group1']],
                [4, []],
            ]);
            expectGroupEdited(source, groupNodes(source, [[2, 'A']]), expected, 'group1', true);
        });

        it('選んだノードの子孫には印を付けない (渡した順によらない。見出しの配下の項目も子孫)', () => {
            const source = `${MD}${GROUP_NESTED}`;
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n    - a1\n        - a2\n- b %group1\n- c\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, ['group1']],
                [4, ['group1']],
                [5, ['group1']],
                [6, []],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [2, 'a'],
                    [3, 'a1'],
                    [4, 'a2'],
                    [5, 'b'],
                ]),
                expected,
                'group1',
                true,
            );
            expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n    - a1\n        - a2\n- b\n- c\n`;
            expectGroups(expected, [createdGroup(1)], [
                [4, ['group1']],
                [5, []],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [4, 'a2'],
                    [2, 'a'],
                ]),
                expected,
                'group1',
                true,
            );
            // 1 R / 2 A / 3 x / 4 y / 5 B / 6 z
            const headings = `${MD}# R\n## A\n- x\n- y\n## B\n- z\n`;
            expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n## A %group1\n- x\n- y\n## B\n- z %group1\n`;
            expectGroups(expected, [createdGroup(1)], [
                [3, ['group1']],
                [5, []],
                [6, ['group1']],
            ]);
            expectGroupEdited(
                headings,
                groupNodes(headings, [
                    [2, 'A'],
                    [3, 'x'],
                    [6, 'z'],
                ]),
                expected,
                'group1',
                true,
            );
        });

        it('ルートには付けず、一緒に選んだノードはまとめる。ルートだけなら root で断る (行を持たないルート、リストだけの文書の容器も)', () => {
            let source = `${MD}# R\n- a\n- b\n`;
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [
                [1, []],
                [2, ['group1']],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [1, 'R'],
                    [2, 'a'],
                ]),
                expected,
                'group1',
                true,
            );
            expectRefused(groupNodes(source, [[1, 'R']]), 'root');
            // 行を持たないルート (title の T) も飛ばす (no-source-line にしない)。1 T / 2 a / 3「1. b」
            source = '---\ntitle: T\nmarkdag:\n---\n- a\n\n1. b\n';
            expected = `---\ntitle: T\nmarkdag:\n${newGroups(1)}---\n- a %group1\n\n1. b\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, []],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [1, 'T'],
                    [2, 'a'],
                ]),
                expected,
                'group1',
                true,
            );
            expectRefused(groupNodes(source, [[1, 'T']]), 'root');
            // リストだけの文書のルート (容器)。最初の項目 a の行は容器の 1 行目と同じで、容器も a の印を読むので、2 つ目の項目で見る
            source = `${MD}- a\n- b\n`;
            expected = `---\nmarkdag:\n${newGroups(1)}---\n- a\n- b %group1\n`;
            expectGroups(expected, [createdGroup(1)], [
                [1, []],
                [2, []],
                [3, ['group1']],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [1, ''],
                    [3, 'b'],
                ]),
                expected,
                'group1',
                true,
            );
            expectRefused(groupNodes(source, [[1, '']]), 'root');
        });

        it('新しい印は既存の印の並び (タグ、ほかのグループ、$id) の末尾に空白 1 つで足し、タスクの項目にも付ける (design.md 3.5)', () => {
            // 1 R / 2 a / 3 b / 4 c / 5 d
            const source = `${MD}# R\n- a #k:v\n- [ ] b\n- c %g\n- d $x\n`;
            const expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a #k:v %group1\n- [ ] b %group1\n- c %g %group1\n- d $x %group1\n`;
            expectGroups(expected, [createdGroup(1), undefinedGroup('g')], [
                [2, ['group1']],
                [3, ['group1']],
                [4, ['group1', 'g']],
                [5, ['group1']],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [2, 'a'],
                    [3, 'b'],
                    [4, 'c'],
                    [5, 'd'],
                ]),
                expected,
                'group1',
                true,
            );
        });
    });

    describe('groupNodes: 名前の番号と定義の足し方 (B-108、B-109、B-125、design.md 4.2、4.3、4.5)', () => {
        it('名前は使われていない最小の group<番号> で、定義と本文の印の両方を見る (B-108)', () => {
            const group1 = '---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n';
            // 定義に group1
            let source = `${group1}---\n# R\n- a %group1\n- b\n`;
            let expected = `${group1}${newGroup(2)}---\n# R\n- a %group1\n- b %group2\n`;
            expectGroups(expected, [definedGroup('group1', '設計', null, false), createdGroup(2)], [
                [2, ['group1']],
                [3, ['group2']],
            ]);
            expectGroupEdited(source, groupNodes(source, [[3, 'b']]), expected, 'group2', true);
            // 本文の印にだけ group1
            source = `${MD}# R\n- a %group1\n- b\n`;
            expected = `---\nmarkdag:\n${newGroups(2)}---\n# R\n- a %group1\n- b %group2\n`;
            expectGroups(expected, [createdGroup(2), undefinedGroup('group1')], [
                [2, ['group1']],
                [3, ['group2']],
            ]);
            expectGroupEdited(source, groupNodes(source, [[3, 'b']]), expected, 'group2', true);
            // 定義の group1 と本文の印の group2 の両方を避ける
            source = `${group1}---\n# R\n- a %group2\n- b\n`;
            expected = `${group1}${newGroup(3)}---\n# R\n- a %group2\n- b %group3\n`;
            expectGroups(expected, [definedGroup('group1', '設計', null, false), createdGroup(3), undefinedGroup('group2')], [
                [2, ['group2']],
                [3, ['group3']],
            ]);
            expectGroupEdited(source, groupNodes(source, [[3, 'b']]), expected, 'group3', true);
            // 空いている番号を使う。定義が group2 だけなら group1 を groups の末尾に足す (並び替えない)
            const group2 = '---\nmarkdag:\n    groups:\n        group2:\n            label: 実装\n';
            source = `${group2}---\n# R\n- a\n- b %group2\n`;
            expected = `${group2}${newGroup(1)}---\n# R\n- a %group1\n- b %group2\n`;
            expectGroups(expected, [definedGroup('group2', '実装', null, false), createdGroup(1)], [
                [2, ['group1']],
                [3, ['group2']],
            ]);
            expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            // 本文の印の group1 と group3 の間の group2
            source = `${MD}# R\n- a %group1\n- b %group3\n- c\n`;
            expected = `---\nmarkdag:\n${newGroups(2)}---\n# R\n- a %group1\n- b %group3\n- c %group2\n`;
            expectGroups(expected, [createdGroup(2), undefinedGroup('group1'), undefinedGroup('group3')], [[4, ['group2']]]);
            expectGroupEdited(source, groupNodes(source, [[4, 'c']]), expected, 'group2', true);
        });

        it('color は番号から 1 を引いた位置の色で、6 色を巡る (group6 は 6 色目、group7 は 1 色目、group8 は 2 色目)', () => {
            expect([colorOf(6), colorOf(7), colorOf(8)]).toEqual([GROUP_COLORS[5], GROUP_COLORS[0], GROUP_COLORS[1]]);
            const cases: Array<[number, number]> = [
                [5, 6],
                [6, 7],
                [7, 8],
            ];
            for (const [used, number] of cases) {
                // 1 R / 2〜(used + 1) が %group1〜%group<used> の項目 / 最後が b
                const marks = Array.from({ length: used }, (_, index) => `- a${index + 1} %group${index + 1}\n`).join('');
                const source = `${MD}# R\n${marks}- b\n`;
                const id = `group${number}`;
                const expected = `---\nmarkdag:\n${newGroups(number)}---\n# R\n${marks}- b %${id}\n`;
                const b = used + 2;
                expectGroups(expected, [createdGroup(number), ...Array.from({ length: used }, (_, index) => undefinedGroup(`group${index + 1}`))], [[b, [id]]]);
                expectGroupEdited(source, groupNodes(source, [[b, 'b']]), expected, id, true);
            }
        });

        it('frontmatter、markdag、groups がなければ作る (frontmatter-added、markdag-added。B-109、design.md 4.3)', () => {
            // frontmatter がない: 先頭に作り、閉じの --- のあとに空行
            let source = '# R\n- a\n- b\n';
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            let outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
            // markdag キーがない frontmatter: 最上位の写像の末尾に markdag: を足す
            source = '---\ntitle: T\n---\n# R\n- a\n- b\n';
            expected = `---\ntitle: T\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
            // 空の frontmatter はその間に入れる
            source = '---\n---\n# R\n- a\n- b\n';
            expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
            // groups がない markdag: 写像の末尾 (relations のあと) に groups を作る
            const relations = '---\nmarkdag:\n    relations:\n        depends:\n            - a --> b\n';
            source = `${relations}---\n# R\n- a\n- b\n`;
            expected = `${relations}${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual([]);
            // markdag のあとに兄弟のキーがあっても、markdag の写像の末尾に足す
            source = '---\nmarkdag:\n    edgeHighlight: true\ntitle: T\n---\n# R\n- a\n- b\n';
            expected = `---\nmarkdag:\n    edgeHighlight: true\n${newGroups(1)}title: T\n---\n# R\n- a %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
        });

        it('markdag キーのない文書では markdag: を足してから印を付ける (`API #draft` はタグのあとに %group1。B-125)', () => {
            // 1 R / 2「API #draft」(markdag キーのない原文の refText) / 3 b
            const source = '---\ntitle: T\n---\n# R\n- API #draft\n- b\n';
            const expected = `---\ntitle: T\nmarkdag:\n${newGroups(1)}---\n# R\n- API #draft %group1\n- b\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, []],
            ]);
            expect(nodeOf(expected, 2).refText).toBe('API');
            const outcome = expectGroupEdited(source, groupNodes(source, [[2, 'API #draft']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
        });

        it('字下げが 2 の frontmatter はその字下げで足し、コメントの行は足した行のあとに残り、CRLF の文書は \\r を付ける (design.md 4.5、4.8、4.9)', () => {
            // 既存のグループのキーの字下げで足し、中は +2
            let source = '---\nmarkdag:\n  groups:\n    g:\n      label: G\n---\n# R\n- a %g\n- b\n';
            let expected = `---\nmarkdag:\n  groups:\n    g:\n      label: G\n${newGroupLines(1, '    ', '      ')}---\n# R\n- a %g\n- b %group1\n`;
            expectGroups(expected, [definedGroup('g', 'G', null, false), createdGroup(1)], [
                [2, ['g']],
                [3, ['group1']],
            ]);
            expectGroupEdited(source, groupNodes(source, [[3, 'b']]), expected, 'group1', true);
            // groups を新しく作る階層も、frontmatter の最小の字下げ (2) で作る
            source = '---\nmarkdag:\n  edgeHighlight: true\n---\n# R\n- a\n';
            expected = `---\nmarkdag:\n  edgeHighlight: true\n  groups:\n${newGroupLines(1, '    ', '      ')}---\n# R\n- a %group1\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            // groups の最後の値のあとのコメントの行は足した行のあとに残り、値の行末のコメントも残る
            const head = '---\nmarkdag:\n    groups:\n        g:\n            label: G # 設計\n';
            const tail = '        # 終わりのコメント\n---\n';
            source = `${head}${tail}# R\n- a %g\n- b\n`;
            expected = `${head}${newGroup(1)}${tail}# R\n- a %g\n- b %group1\n`;
            expectGroups(expected, [definedGroup('g', 'G', null, false), createdGroup(1)], [[3, ['group1']]]);
            expectGroupEdited(source, groupNodes(source, [[3, 'b']]), expected, 'group1', true);
            // CRLF の文書は足す行と印を付けた行の末尾に \r
            source = '---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n';
            expected = `---\r\nmarkdag:\r\n${newGroups(1).replaceAll('\n', '\r\n')}---\r\n# R\r\n- a %group1\r\n- b\r\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, []],
            ]);
            expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
        });

        it('BOM で始まる文書は BOM を外して frontmatter を作り (bom-removed)、BOM のすぐあとが --- の行の文書も BOM を外してその frontmatter に書く (D-070)', () => {
            const source = '\u{feff}# R\n- a\n';
            const expected = `---\nmarkdag:\n${newGroups(1)}---\n\n# R\n- a %group1\n`;
            expectGroups(expected, [createdGroup(1)], [[2, ['group1']]]);
            const outcome = expectGroupEdited(source, groupNodes(source, [[2, 'a']]), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual(expect.arrayContaining(['bom-removed', 'frontmatter-added']));
            const fenced = '\u{feff}---\nmarkdag:\n---\n# R\n- a\n- b\n';
            const fencedExpected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n`;
            expectGroups(fencedExpected, [createdGroup(1)], [[2, ['group1']]]);
            expect(noteCodes(expectGroupEdited(fenced, groupNodes(fenced, [[2, 'a']]), fencedExpected, 'group1', true))).toEqual(['bom-removed']);
        });
    });

    describe('groupNodes: 断る (B-05、A-01、B-02、B-002、design.md 3.2、3.4、4.4)', () => {
        it('下線の見出しと行頭に空白のある ATX の見出しは ATX の見出しに書き直してから印を付ける (D-047)。印を書けないノードを含めてまとめると全体を断る: 容器は no-source-line、表とコードと画像は block-node', () => {
            let source = `${MD}${GROUP_UNMARKABLE}`;
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n\n## 設計 %group1\n\n- 画面\n\n ## 実装\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, ['group1']],
                [4, []],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [2, '設計'],
                    [3, '画面'],
                ]),
                expected,
                'group1',
                true,
            );
            expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n\n設計\n---\n\n- 画面 %group1\n\n## 実装 %group1\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, []],
                [3, ['group1']],
                [4, ['group1']],
            ]);
            expectGroupEdited(
                source,
                groupNodes(source, [
                    [3, '画面'],
                    [4, '実装'],
                ]),
                expected,
                'group1',
                true,
            );
            source = `${MD}${GROUP_LISTS}`;
            expectRefused(
                groupNodes(source, [
                    [5, ''],
                    [3, 'a'],
                ]),
                'no-source-line',
            );
            expectRefused(groupNodes(source, [[2, '']]), 'no-source-line');
            source = `${MD}${GROUP_BLOCKS}`;
            for (const id of [2, 3, 4]) expectRefused(groupNodes(source, [[id, '']]), 'block-node');
        });

        it('足す先がフロー形式なら字下げの形に書き直してから足し (D-054)、YAML の誤りは frontmatter-invalid、道すじの途中が写像でなければ frontmatter-not-map', () => {
            const body = '# R\n- a\n- b\n';
            for (const [frontmatter, written] of [
                ['markdag: {}\n', `markdag:\n${newGroups(1)}`],
                ['markdag:\n    groups: {}\n', `markdag:\n${newGroups(1)}`],
                ['markdag:\n    groups: { g: { label: G } }\n', `markdag:\n    groups:\n        g:\n            label: G\n${newGroup(1)}`],
            ]) {
                const source = `---\n${frontmatter}---\n${body}`;
                expect(noteCodes(expectGroupEdited(source, groupNodes(source, [[2, 'a']]), `---\n${written}---\n# R\n- a %group1\n- b\n`, 'group1', true))).toEqual([]);
            }
            for (const frontmatter of ['markdag:\n    groups: "x\n', 'markdag:\nmarkdag:\n']) {
                expectRefused(groupNodes(`---\n${frontmatter}---\n${body}`, [[2, 'a']]), 'frontmatter-invalid');
            }
            for (const frontmatter of ['markdag: true\n', 'markdag:\n    groups: 設計\n', 'markdag:\n    groups:\n        - g\n']) {
                expectRefused(groupNodes(`---\n${frontmatter}---\n${body}`, [[2, 'a']]), 'frontmatter-not-map');
            }
        });

        it('refText が違うか id のノードがなければ stale-node。単独の \\r を含む文書は、文書の最初の改行にそろえてからまとめる (D-065)', () => {
            const source = `${MD}# R\n- a\n- b\n`;
            expectRefused(groupNodesUnchecked(source, [[2, 'x']]), 'stale-node');
            expectRefused(
                groupNodesUnchecked(source, [
                    [2, 'a'],
                    [99, 'b'],
                ]),
                'stale-node',
            );
            for (const [lone, expected] of [
                ['# R\n- a\n- b\r- c\n', `---\nmarkdag:\n${newGroups(1)}---\n\n# R\n- a %group1\n- b\n- c\n`],
                [`${MD}# R\n- a\n- b\r- c\n`, `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a %group1\n- b\n- c\n`],
            ] as const) {
                expectGroupEdited(lone, groupNodes(lone, [[2, 'a']]), expected, 'group1', true);
            }
        });

        it('欄の型の違うグループの操作は MarkdagError (invalid-input)', () => {
            const node = { id: 2, refText: 'a' };
            const bad: unknown[] = [
                { kind: 'groupNodes' },
                { kind: 'groupNodes', nodes: node },
                { kind: 'addToGroup', nodes: [node] },
                { kind: 'addToGroup', group: 1, nodes: [node] },
                { kind: 'renameGroup', group: 'g' },
                { kind: 'setGroupColor', group: 'g', color: 3 },
                { kind: 'setGroupBoundary', group: 'g', boundary: 'true' },
                { kind: 'ungroup' },
            ];
            for (const op of bad) {
                const error = thrown(() => core.editSource(`${MD}# R\n- a %g\n`, op as core.EditOp));
                expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
                expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
            }
        });
    });

    describe('defineGroup: 定義だけのグループ (B-168、design.md 3.4)', () => {
        it('メンバーのいないグループを作り、select と rename がそのグループ。本文は変えない。名前の番号は本文の印と定義を避ける', () => {
            let source = `${MD}# R\n- a\n`;
            let expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a\n`;
            expectGroups(expected, [createdGroup(1)], [
                [1, []],
                [2, []],
            ]);
            const outcome = expectGroupEdited(source, defineGroup(source), expected, 'group1', true);
            expect(noteCodes(outcome)).toEqual([]);
            source = `${MD}# R\n- a %group1\n`;
            expected = `---\nmarkdag:\n${newGroups(2)}---\n# R\n- a %group1\n`;
            expectGroups(expected, [createdGroup(2), undefinedGroup('group1')], [[2, ['group1']]]);
            expectGroupEdited(source, defineGroup(source), expected, 'group2', true);
            const group1 = '---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n';
            source = `${group1}---\n# R\n- a\n`;
            expected = `${group1}${newGroup(2)}---\n# R\n- a\n`;
            expectGroups(expected, [definedGroup('group1', '設計', null, false), createdGroup(2)], [[2, []]]);
            expectGroupEdited(source, defineGroup(source), expected, 'group2', true);
        });

        it('frontmatter や markdag キーがなければ作る (frontmatter-added、markdag-added)', () => {
            let source = '# R\n- a\n';
            let outcome = expectGroupEdited(source, defineGroup(source), `---\nmarkdag:\n${newGroups(1)}---\n\n# R\n- a\n`, 'group1', true);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
            source = '---\ntitle: T\n---\n# R\n- a\n';
            outcome = expectGroupEdited(source, defineGroup(source), `---\ntitle: T\nmarkdag:\n${newGroups(1)}---\n# R\n- a\n`, 'group1', true);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
        });

        it('足す先がフロー形式なら字下げの形に書き直してから足し、BOM のすぐあとが --- なら BOM を外してから足す (bom-removed)。YAML の誤りは frontmatter-invalid (D-055)', () => {
            const expected = `---\nmarkdag:\n${newGroups(1)}---\n# R\n- a\n`;
            for (const frontmatter of ['markdag: {}\n', 'markdag:\n    groups: {}\n']) {
                const source = `---\n${frontmatter}---\n# R\n- a\n`;
                expect(noteCodes(expectGroupEdited(source, defineGroup(source), expected, 'group1', true))).toEqual([]);
            }
            expectRefused(defineGroup('---\nmarkdag:\n    groups: "x\n---\n# R\n- a\n'), 'frontmatter-invalid');
            const fenced = '\u{feff}---\nmarkdag:\n---\n# R\n- a\n';
            expect(noteCodes(expectGroupEdited(fenced, defineGroup(fenced), expected, 'group1', true))).toEqual(['bom-removed']);
        });
    });

    describe('addToGroup: あとから入れる (B-163、design.md 3.4、3.5)', () => {
        it('定義だけのグループに選んだノードを入れる: 1 行目の末尾に %印、frontmatter は変えない。select は同じノード、rename は null', () => {
            // 1 R / 2 a / 3 b / 4 c
            const frontmatter = `---\nmarkdag:\n${newGroups(1)}---\n`;
            const source = `${frontmatter}# R\n- a\n- b\n- c\n`;
            const expected = `${frontmatter}# R\n- a %group1\n- b\n- c %group1\n`;
            expectGroups(expected, [createdGroup(1)], [
                [2, ['group1']],
                [3, []],
                [4, ['group1']],
            ]);
            const nodes: Target[] = [
                [2, 'a'],
                [4, 'c'],
            ];
            const outcome = expectNodesKept(source, addToGroup(source, 'group1', nodes), expected, nodes);
            expect(noteCodes(outcome)).toEqual([]);
        });

        it('本文の印だけのグループにも入れられる。見出しは 1 行目の末尾に付けて配下が引き継ぎ、印のある行は印の並びの末尾に足す', () => {
            // 1 R / 2 A / 3 a / 4 B / 5 x / 6 C / 7 y
            const source = `${MD}# R\n## A\n- a %g\n## B\n- x\n## C\n- y #k\n`;
            let expected = `${MD}# R\n## A\n- a %g\n## B %g\n- x\n## C\n- y #k\n`;
            expectGroups(expected, [undefinedGroup('g')], [
                [3, ['g']],
                [4, ['g']],
                [5, ['g']],
                [7, []],
            ]);
            expectNodesKept(source, addToGroup(source, 'g', [[4, 'B']]), expected, [[4, 'B']]);
            expected = `${MD}# R\n## A\n- a %g\n## B\n- x\n## C\n- y #k %g\n`;
            expectGroups(expected, [undefinedGroup('g')], [
                [5, []],
                [7, ['g']],
            ]);
            expectNodesKept(source, addToGroup(source, 'g', [[7, 'y']]), expected, [[7, 'y']]);
        });

        it('もう入っているノード (印、祖先の印、members)、選んだノードの子孫、ルートには付けない。付けるノードが残らなければ nothing-to-change', () => {
            // 1 R / 2 a %g / 3 a1 / 4 b / 5 b1 / 6 c / 7 d (members で g)
            const frontmatter = '---\nmarkdag:\n    groups:\n        g:\n            members:\n                - d\n---\n';
            const source = `${frontmatter}# R\n- a %g\n    - a1\n- b\n    - b1\n- c\n- d\n`;
            expectGroups(source, [definedGroup('g', 'g', null, false)], [
                [2, ['g']],
                [3, ['g']],
                [4, []],
                [7, ['g']],
            ]);
            const skipped: Target[][] = [
                [[2, 'a']],
                [[3, 'a1']],
                [[7, 'd']],
                [[1, 'R']],
                [
                    [1, 'R'],
                    [2, 'a'],
                    [3, 'a1'],
                    [7, 'd'],
                ],
            ];
            for (const nodes of skipped) expectUnchanged(addToGroup(source, 'g', nodes), 'nothing-to-change');
            // まとめて渡すと b と c だけに付ける (b1 は b の子孫)
            const expected = `${frontmatter}# R\n- a %g\n    - a1\n- b %g\n    - b1\n- c %g\n- d\n`;
            expectGroups(expected, [definedGroup('g', 'g', null, false)], [
                [4, ['g']],
                [5, ['g']],
                [6, ['g']],
                [7, ['g']],
            ]);
            const result = edited(
                addToGroup(source, 'g', [
                    [1, 'R'],
                    [2, 'a'],
                    [3, 'a1'],
                    [4, 'b'],
                    [5, 'b1'],
                    [6, 'c'],
                    [7, 'd'],
                ]),
            );
            expect(result.source).toBe(expected);
            expect(result.rename).toBeNull();
        });

        it('ないグループは group-unknown。下線の見出しと行頭に空白のある ATX の見出しは ATX の見出しに書き直してから印を付ける (D-047)。印を書けないノードを含めると全体を断る (no-source-line、block-node)。古いノードは stale-node', () => {
            expectRefused(addToGroup(`${MD}# R\n- a %g\n- b\n`, 'h', [[3, 'b']]), 'group-unknown');
            let source = `${DEFINED_G}${GROUP_UNMARKABLE}`;
            let expected = `${DEFINED_G}# R\n\n## 設計 %g\n\n- 画面\n\n ## 実装\n`;
            expectGroups(expected, [definedGroup('g', 'G', null, false)], [
                [2, ['g']],
                [3, ['g']],
                [4, []],
            ]);
            const nodes: Target[] = [
                [3, '画面'],
                [2, '設計'],
            ];
            expectNodesKept(source, addToGroup(source, 'g', nodes), expected, nodes);
            expected = `${DEFINED_G}# R\n\n設計\n---\n\n- 画面\n\n## 実装 %g\n`;
            expectGroups(expected, [definedGroup('g', 'G', null, false)], [[4, ['g']]]);
            expectNodesKept(source, addToGroup(source, 'g', [[4, '実装']]), expected, [[4, '実装']]);
            source = `${DEFINED_G}${GROUP_LISTS}`;
            expectRefused(
                addToGroup(source, 'g', [
                    [3, 'a'],
                    [5, ''],
                ]),
                'no-source-line',
            );
            source = `${DEFINED_G}${GROUP_BLOCKS}`;
            for (const id of [2, 3, 4]) expectRefused(addToGroup(source, 'g', [[id, '']]), 'block-node');
            expectRefused(addToGroupUnchecked(`${DEFINED_G}# R\n- a\n`, 'g', [[2, 'x']]), 'stale-node');
        });
    });

    describe('renameGroup: 名前の変更 (B-115、B-09、design.md 3.4、4.2、4.6)', () => {
        it('label の値の範囲だけを書き換え、行末のコメントと、ほかのキーとグループは残す。select はグループ、rename は null', () => {
            const source = '---\nmarkdag:\n    groups:\n        g:\n            label: 旧 # メモ\n            color: "#3B7DD8"\n        h:\n            label: H\n---\n# R\n- a %g\n- b %h\n';
            const expected = '---\nmarkdag:\n    groups:\n        g:\n            label: 設計の範囲 # メモ\n            color: "#3B7DD8"\n        h:\n            label: H\n---\n# R\n- a %g\n- b %h\n';
            expectGroups(expected, [definedGroup('g', '設計の範囲', '#3B7DD8', false), definedGroup('h', 'H', null, false)], [
                [2, ['g']],
                [3, ['h']],
            ]);
            const outcome = expectGroupEdited(source, renameGroup(source, 'g', '設計の範囲'), expected, 'g', false);
            expect(noteCodes(outcome)).toEqual([]);
        });

        it('YAML でそのまま書けない名前は "…" で囲み、中に " があれば \'…\' で囲む (design.md 4.6)', () => {
            const source = `${DEFINED_G}# R\n- a %g\n`;
            const cases: Array<[string, string]> = [
                ['設計: 実装', '"設計: 実装"'],
                ['#1 案', '"#1 案"'],
                ['a # b', '"a # b"'],
                ['- 項目', '"- 項目"'],
                ['yes', '"yes"'],
                ['true', '"true"'],
                ['123', '"123"'],
                ['"引用"', `'"引用"'`],
            ];
            for (const [label, written] of cases) {
                const expected = `---\nmarkdag:\n    groups:\n        g:\n            label: ${written}\n---\n# R\n- a %g\n`;
                expectGroups(expected, [definedGroup('g', label, null, false)], [[2, ['g']]]);
                expectGroupEdited(source, renameGroup(source, 'g', label), expected, 'g', false);
            }
        });

        it('定義がなければ label だけの定義を足し (groups がなければ作る)、定義に label がなければその写像の末尾に足す', () => {
            let source = `${MD}# R\n- a %g\n`;
            let expected = '---\nmarkdag:\n    groups:\n        g:\n            label: 設計\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', '設計', null, false)], [[2, ['g']]]);
            const outcome = expectGroupEdited(source, renameGroup(source, 'g', '設計'), expected, 'g', false);
            expect(noteCodes(outcome)).toEqual([]);
            // ほかのグループの定義があれば groups の末尾に足す
            let head = '---\nmarkdag:\n    groups:\n        h:\n            label: H\n';
            source = `${head}---\n# R\n- a %g\n- b %h\n`;
            expected = `${head}        g:\n            label: 設計\n---\n# R\n- a %g\n- b %h\n`;
            expectGroups(expected, [definedGroup('h', 'H', null, false), definedGroup('g', '設計', null, false)], [
                [2, ['g']],
                [3, ['h']],
            ]);
            expectGroupEdited(source, renameGroup(source, 'g', '設計'), expected, 'g', false);
            // 定義に label がない
            head = '---\nmarkdag:\n    groups:\n        g:\n            color: "#3B7DD8"\n';
            source = `${head}---\n# R\n- a %g\n`;
            expected = `${head}            label: 設計\n---\n# R\n- a %g\n`;
            expectGroups(expected, [definedGroup('g', '設計', '#3B7DD8', false)], [[2, ['g']]]);
            expectGroupEdited(source, renameGroup(source, 'g', '設計'), expected, 'g', false);
        });

        it('空の名前は group-label-empty、ないグループは group-unknown、同じ名前は same-name で変えない。定義がフロー形式なら字下げの形に書き直してから書き換える (D-054)', () => {
            const source = `${DEFINED_G}# R\n- a %g\n`;
            for (const label of ['', '   ']) expectRefused(renameGroup(source, 'g', label), 'group-label-empty');
            expectRefused(renameGroup(source, 'h', '設計'), 'group-unknown');
            expectUnchanged(renameGroup(source, 'g', 'G'), 'same-name');
            const expected = '---\nmarkdag:\n    groups:\n        g:\n            label: 設計\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', '設計', null, false)], [[2, ['g']]]);
            for (const frontmatter of ['markdag:\n    groups:\n        g: { label: G }\n', 'markdag:\n    groups: { g: { label: G } }\n']) {
                const flow = `---\n${frontmatter}---\n# R\n- a %g\n`;
                expectGroupEdited(flow, renameGroup(flow, 'g', '設計'), expected, 'g', false);
            }
        });

        it('label がブロックスカラ (| と >-) なら組の行を 1 行の label に置き換え、あとに続く group2 の組は変えない (B-09)', () => {
            const expected = '---\nmarkdag:\n    groups:\n        group1:\n            label: 設計\n        group2:\n            label: 実装\n---\n# R\n\n- a %group1\n- b %group2\n';
            expectGroups(expected, [definedGroup('group1', '設計', null, false), definedGroup('group2', '実装', null, false)], [
                [2, ['group1']],
                [3, ['group2']],
            ]);
            for (const source of [BLOCK_LABEL, BLOCK_LABEL.replace('label: |', 'label: >-')]) {
                expectGroupEdited(source, renameGroup(source, 'group1', '設計'), expected, 'group1', false);
            }
        });
    });

    describe('setGroupColor と setGroupBoundary: 色と枠の有無 (B-160、B-164、design.md 3.4、4.2)', () => {
        it('color の値の範囲を "#RRGGBB" で書き換え (引用符のない色の名前も)、なければ写像の末尾に足し、定義がなければ color だけの定義を足す', () => {
            let source = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: "#3B7DD8" # 青\n            boundary: true\n---\n# R\n- a %g\n';
            let expected = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: "#D64545" # 青\n            boundary: true\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'G', '#D64545', true)], [[2, ['g']]]);
            const outcome = expectGroupEdited(source, setGroupColor(source, 'g', '#D64545'), expected, 'g', false);
            expect(noteCodes(outcome)).toEqual([]);
            source = '---\nmarkdag:\n    groups:\n        g:\n            color: red\n---\n# R\n- a %g\n';
            expected = '---\nmarkdag:\n    groups:\n        g:\n            color: "#D64545"\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'g', '#D64545', false)], []);
            expectGroupEdited(source, setGroupColor(source, 'g', '#D64545'), expected, 'g', false);
            source = `${DEFINED_G}# R\n- a %g\n`;
            expected = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: "#D64545"\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'G', '#D64545', false)], []);
            expectGroupEdited(source, setGroupColor(source, 'g', '#D64545'), expected, 'g', false);
            source = `${MD}# R\n- a %g\n`;
            expected = '---\nmarkdag:\n    groups:\n        g:\n            color: "#D64545"\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'g', '#D64545', false)], [[2, ['g']]]);
            expectGroupEdited(source, setGroupColor(source, 'g', '#D64545'), expected, 'g', false);
        });

        it('色の書き方の誤りは color-invalid、ないグループは group-unknown。定義がフロー形式なら字下げの形に書き直してから足す (D-054)', () => {
            const source = `${DEFINED_G}# R\n- a %g\n`;
            for (const color of ['', '#12345', '#GGGGGG', '青', 'rgb(1, 2']) expectRefused(setGroupColor(source, 'g', color), 'color-invalid');
            expectRefused(setGroupColor(source, 'h', '#D64545'), 'group-unknown');
            const flow = '---\nmarkdag:\n    groups:\n        g: { label: G }\n---\n# R\n- a %g\n';
            const expected = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: "#D64545"\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'G', '#D64545', false)], [[2, ['g']]]);
            expectGroupEdited(flow, setGroupColor(flow, 'g', '#D64545'), expected, 'g', false);
        });

        it('boundary の値を書き換え (true と false)、なければ写像の末尾に足し、定義がなければ boundary だけの定義を足す。ないグループは group-unknown、フロー形式は字下げの形に書き直してから足す (D-054)', () => {
            const frame = (boundary: string): string => `---\nmarkdag:\n    groups:\n        g:\n            label: G\n            boundary: ${boundary}\n---\n# R\n- a %g\n`;
            expectGroups(frame('false'), [definedGroup('g', 'G', null, false)], [[2, ['g']]]);
            expectGroups(frame('true'), [definedGroup('g', 'G', null, true)], [[2, ['g']]]);
            const outcome = expectGroupEdited(frame('true'), setGroupBoundary(frame('true'), 'g', false), frame('false'), 'g', false);
            expect(noteCodes(outcome)).toEqual([]);
            expectGroupEdited(frame('false'), setGroupBoundary(frame('false'), 'g', true), frame('true'), 'g', false);
            let source = `${DEFINED_G}# R\n- a %g\n`;
            expectGroupEdited(source, setGroupBoundary(source, 'g', true), frame('true'), 'g', false);
            source = `${MD}# R\n- a %g\n`;
            const expected = '---\nmarkdag:\n    groups:\n        g:\n            boundary: true\n---\n# R\n- a %g\n';
            expectGroups(expected, [definedGroup('g', 'g', null, true)], [[2, ['g']]]);
            expectGroupEdited(source, setGroupBoundary(source, 'g', true), expected, 'g', false);
            expectRefused(setGroupBoundary(source, 'h', true), 'group-unknown');
            const flow = '---\nmarkdag:\n    groups:\n        g: { label: G }\n---\n# R\n- a %g\n';
            expectGroupEdited(flow, setGroupBoundary(flow, 'g', true), frame('true'), 'g', false);
        });
    });

    describe('ungroup: グループ解除 (B-116、B-09、design.md 3.4、4.7)', () => {
        it('全部のノードの印と定義を外し、空になった groups のキーも外す (markdag キーは残す)。ノードとほかの印は残り、選択を解く', () => {
            const source = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            color: "#3B7DD8"\n            boundary: true\n---\n# R\n- a %g\n    - a1\n- b #k %g $x\n- c\n';
            const expected = '---\nmarkdag:\n---\n# R\n- a\n    - a1\n- b #k $x\n- c\n';
            expectGroups(expected, [], [
                [2, []],
                [3, []],
                [4, []],
            ]);
            const outcome = expectUngrouped(source, ungroup(source, 'g'), expected);
            expect(noteCodes(outcome)).toEqual([]);
        });

        it('ほかのグループの定義と印と groups のキーは残り、印が 2 つの行は外したグループの印だけを外す。markdag のほかのキーも残る', () => {
            const source = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n        h:\n            label: H\n---\n# R\n- a %g %h\n- b %h\n';
            let expected = '---\nmarkdag:\n    groups:\n        h:\n            label: H\n---\n# R\n- a %h\n- b %h\n';
            expectGroups(expected, [definedGroup('h', 'H', null, false)], [
                [2, ['h']],
                [3, ['h']],
            ]);
            expectUngrouped(source, ungroup(source, 'g'), expected);
            expected = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n# R\n- a %g\n- b\n';
            expectGroups(expected, [definedGroup('g', 'G', null, false)], [
                [2, ['g']],
                [3, []],
            ]);
            expectUngrouped(source, ungroup(source, 'h'), expected);
            const withKeys = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n    edgeHighlight: true\n---\n# R\n## A %g\n- x\n';
            expected = '---\nmarkdag:\n    edgeHighlight: true\n---\n# R\n## A\n- x\n';
            expectGroups(expected, [], [
                [2, []],
                [3, []],
            ]);
            expectUngrouped(withKeys, ungroup(withKeys, 'g'), expected);
        });

        it('本文の印だけのグループは印だけを外し、定義だけのグループ (members を含む) は定義の組を外す。CRLF の文書', () => {
            let source = `${MD}# R\n- a %g\n- b %g\n`;
            let expected = `${MD}# R\n- a\n- b\n`;
            expectGroups(expected, [], [
                [2, []],
                [3, []],
            ]);
            expectUngrouped(source, ungroup(source, 'g'), expected);
            source = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n            members:\n                - a\n---\n# R\n- a\n- b\n';
            expectGroups(source, [definedGroup('g', 'G', null, false)], [[2, ['g']]]);
            expectUngrouped(source, ungroup(source, 'g'), '---\nmarkdag:\n---\n# R\n- a\n- b\n');
            source = '---\r\nmarkdag:\r\n    groups:\r\n        g:\r\n            label: G\r\n---\r\n# R\r\n- a %g\r\n- b\r\n';
            expected = '---\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n- b\r\n';
            expectGroups(expected, [], [[2, []]]);
            expectUngrouped(source, ungroup(source, 'g'), expected);
        });

        it('label をブロックスカラで書いたグループを解除しても、あとに続く group2 の定義が残る (B-09)', () => {
            const expected = '---\nmarkdag:\n    groups:\n        group2:\n            label: 実装\n---\n# R\n\n- a\n- b %group2\n';
            expectGroups(expected, [definedGroup('group2', '実装', null, false)], [
                [2, []],
                [3, ['group2']],
            ]);
            expectUngrouped(BLOCK_LABEL, ungroup(BLOCK_LABEL, 'group1'), expected);
        });

        it('ないグループは group-unknown。外す定義がフロー形式でも、印と定義を外す (空になった groups のキーも外す。細部 21。D-056)', () => {
            expectRefused(ungroup(`${DEFINED_G}# R\n- a %g\n`, 'h'), 'group-unknown');
            const expected = '---\nmarkdag:\n---\n# R\n- a\n';
            expectGroups(expected, [], [[2, []]]);
            for (const frontmatter of ['markdag:\n    groups:\n        g: { label: G }\n', 'markdag:\n    groups: { g: { label: G } }\n']) {
                const source = `---\n${frontmatter}---\n# R\n- a %g\n`;
                expect(noteCodes(expectUngrouped(source, ungroup(source, 'g'), expected))).toEqual([]);
            }
        });
    });
});

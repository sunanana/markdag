// GUI 編集の本文の書き換え (書き換えの土台と名前の変更、子と兄弟の追加、ノードの削除と付け替えの本文の部分、詳細とタグの書き換え) の、
// 公開の入口 (markdag/core) の editSource と inspectNode からのテスト。
// Rust の結果が境界を通って公開の型の形で届くことと、包みの受け持ち (splices を原文の行に当てる、行末の \r と
// 対になっていないサロゲートを原文のまま保つ、読めない入力は MarkdagError) を見る。選び直しは parseDocument で確かめる
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '../src/core';
import * as markdag from '../src/index';

const MD = '---\nmarkdag:\n---\n';

// 1 R / 2 h (タスクの見出し、印つき) / 3 印と詳細と子のあるタスクの項目 (refText は「太字 と code」) / 4 c
const MARKED = `${MD}# R\n\n## [x] h #k %g $hid\n- [ ] **太字** と \`code\` #k:v %g $id\n    > 1 行目\n    >\n    > **3** 行目\n    - c\n`;
// 見出しの下に種類の違うリストが 2 つ (edge-nested-lists の形)。2 は ul、5 は ol の容器 (refText は空) で、
// 容器の lines.start は最初の項目 (3 a、6「1. c」) の行と同じ
const NESTED_LISTS = '# R\n\n- a\n- b\n\n1. c\n2. d\n';
// 1 R / 2 表 / 3 コード / 4 画像
const BLOCKS = `${MD}# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n`;
// 見出しがなく最上位のブロックが 2 つ: ルート (refText は title) は lines が null
const LINELESS = '---\ntitle: T\nmarkdag:\n---\n- a\n\n1. b\n';
// リストだけの文書: ルートは ul の容器で、lines.start は最初の項目の行と同じ
const LIST_ROOT_TITLED = '---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n';
const LIST_ROOT = '- a\n- b\n';
// 1 R / 2 下線の見出し「設計」/ 3 画面 / 4 行頭に空白のある ATX の見出し「実装」
const UNMARKABLE = `${MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n`;

type Edited = Extract<core.EditOutcome, { status: 'edited' }>;

const rename = (source: string, id: number, refText: string, label: string): core.EditOutcome =>
    core.editSource(source, { kind: 'renameNode', node: { id, refText }, label });

function edited(outcome: core.EditOutcome): Edited {
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome;
}

const renamed = (source: string, id: number, refText: string, label: string): string => edited(rename(source, id, refText, label)).source;

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

const lineOf = (source: string, index: number): string => source.split('\n')[index] ?? '';

function withLine(source: string, index: number, text: string): string {
    const lines = source.split('\n');
    lines[index] = text;
    return lines.join('\n');
}

const reason = (code: core.EditReasonCode): unknown => ({ code, message: expect.stringMatching(/\S/), path: null });
const refused = (code: core.EditReasonCode): unknown => ({ status: 'refused', reason: reason(code) });
const unchanged = (code: core.EditReasonCode): unknown => ({ status: 'unchanged', reason: reason(code) });
const selected = (id: number, refText: string): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

const renamedTo = (source: string, select: core.EditSelection): unknown => ({ status: 'edited', source, select, rename: null, notes: [] });

function firstLineBlocks(source: string): core.Diagnostic[] {
    const parsed = core.parseDocument(source);
    return core.buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics.filter((item) => item.code === 'block-on-first-line');
}

// select のノードが、書き換えたあとの原文を parseDocument した同じ id のノードの refText と一致する
function expectSelectMatchesReparse(outcome: core.EditOutcome): void {
    const { source, select } = edited(outcome);
    expect(select.kind).toBe('nodes');
    if (select.kind !== 'nodes') return;
    expect(select.nodes.length).toBeGreaterThan(0);
    for (const chosen of select.nodes) expect(nodeOf(source, chosen.id).refText).toBe(chosen.refText);
}

function expectPlainName(source: string, id: number, label: string): void {
    const node = nodeOf(source, id);
    const where = `${JSON.stringify(label)}: ${JSON.stringify(source)}`;
    expect(node.refText, where).toBe(label);
    expect(node.tags, where).toEqual([]);
    expect(node.groups, where).toEqual([]);
    expect(node.refId, where).toBeNull();
    expect(node.task, where).toBeNull();
}

// can* の並び: canRename、canDelete、canMove、canHaveDetails、canAddChild、canAddSibling、canMark、canToggleTask
type Can = [boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean];
const ITEM: Can = [true, true, true, true, true, true, true, true];
// 見出しも詳細を持てる (最後の関門 原文の都合で断る 6。D-039)
const HEADING: Can = [true, true, true, true, true, true, true, true];
const ROOT_HEADING: Can = [true, false, false, true, true, true, true, true];
// 下線の見出しと行頭に空白のある ATX の見出しは、印を書く前に ATX の見出しに書き直すので印を書ける (最後の関門 原文の都合で断る 1。D-039)
const UNMARKABLE_HEADING: Can = [true, true, true, true, true, true, true, true];
const CONTAINER: Can = [false, true, false, false, true, false, false, false];
const BLOCK: Can = [false, true, true, false, false, false, false, false];
// 行を持たないルートの名前は frontmatter の title なので、名前を変えられる (例の承認のルートのタイトル)
const LINELESS_ROOT: Can = [true, false, false, false, true, true, false, false];

function inspected(id: number, kind: core.InspectNodeResult['kind'], label: string, details: string | null, task: boolean, can: Can): core.InspectNodeResult {
    const [canRename, canDelete, canMove, canHaveDetails, canAddChild, canAddSibling, canMark, canToggleTask] = can;
    return { id, kind, label, details, task, canRename, canDelete, canMove, canHaveDetails, canAddChild, canAddSibling, canMark, canToggleTask };
}

function thrown(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('投げるはず');
}

// 名前と、項目の 1 行目に書く逃がしたあとの本文
const ITEM_ESCAPES: Array<[string, string]> = [
    ['#todo', String.raw`\#todo`],
    ['Issue #frontend', String.raw`Issue \#frontend`],
    ['%g', String.raw`\%g`],
    ['$id', String.raw`\$id`],
    ['a #x #y', String.raw`a #x \#y`],
    ['# x', String.raw`\# x`],
    ['> x', String.raw`\> x`],
    ['- x', String.raw`\- x`],
    ['* x', String.raw`\* x`],
    ['+ x', String.raw`\+ x`],
    ['1. x', String.raw`1\. x`],
    ['1) x', String.raw`1\) x`],
    ['---', String.raw`\---`],
    ['***', String.raw`\***`],
    ['```js', '\\```js'],
    ['~~~', String.raw`\~~~`],
    ['<div>', String.raw`\<div>`],
    ['<!-- c -->', String.raw`\<!-- c -->`],
    ['[ ] x', String.raw`\[ ] x`],
    ['[x] x', String.raw`\[x] x`],
    ['[X] x', String.raw`\[X] x`],
    ['[/] x', String.raw`\[/] x`],
    ['[-] x', String.raw`\[-] x`],
];

describe('editSource と inspectNode (GUI 編集の段 2: 書き換えの土台と名前の変更)', () => {
    it('型: editSource と inspectNode と書き換えの型が markdag/core と markdag の入口から同じ名前で出る', () => {
        expectTypeOf(core.editSource).toEqualTypeOf<(source: string, op: core.EditOp) => core.EditOutcome>();
        expectTypeOf(core.inspectNode).toEqualTypeOf<(source: string, node: core.NodeTarget) => core.InspectNodeResult | null>();
        expectTypeOf<core.NodeTarget>().toEqualTypeOf<{ id: number; refText: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'renameNode' }>>().toEqualTypeOf<{ kind: 'renameNode'; node: core.NodeTarget; label: string }>();
        expectTypeOf<Extract<core.EditSelection, { kind: 'nodes' }>>().toEqualTypeOf<{ kind: 'nodes'; nodes: core.NodeTarget[] }>();
        expectTypeOf<core.EditRename>().toEqualTypeOf<{ kind: 'node'; node: core.NodeTarget } | { kind: 'group'; id: string } | null>();
        expectTypeOf<core.EditNoteCode>().toEqualTypeOf<
            'relations-removed' | 'refs-rewritten' | 'sources-cycle' | 'sources-existing' | 'id-added' | 'markdag-added' | 'frontmatter-added' | 'bom-removed'
        >();
        expectTypeOf<core.EditNote>().toEqualTypeOf<{ code: core.EditNoteCode; count: number; message: string }>();
        expectTypeOf<core.EditReasonCode>().toEqualTypeOf<
            | 'stale-node'
            | 'no-source-line'
            | 'block-node'
            | 'marker-line'
            | 'root'
            | 'heading-details'
            | 'empty-name'
            | 'move-into-self'
            | 'structure-changed'
            | 'same-node'
            | 'edge-exists'
            | 'cycle'
            | 'ambiguous-reference'
            | 'too-few-sources'
            | 'all-sources-skipped'
            | 'tag-key-invalid'
            | 'group-unknown'
            | 'group-label-empty'
            | 'color-invalid'
            | 'flow-style'
            | 'block-scalar'
            | 'frontmatter-invalid'
            | 'frontmatter-not-map'
            // line-endings と bom はどの操作からも出なくなったので型から外した (D-080)
            | 'same-name'
            | 'already-child'
            | 'nothing-to-change'
        >();
        expectTypeOf<core.EditReason>().toEqualTypeOf<{ code: core.EditReasonCode; message: string; path: string | null }>();
        expectTypeOf<core.EditOutcome>().toEqualTypeOf<
            | { status: 'edited'; source: string; select: core.EditSelection; rename: core.EditRename; notes: core.EditNote[] }
            | { status: 'unchanged'; reason: core.EditReason | null }
            | { status: 'refused'; reason: core.EditReason }
        >();
        expectTypeOf<core.InspectNodeResult>().toEqualTypeOf<{
            id: number;
            kind: 'heading' | 'item' | 'root' | 'list' | 'block';
            label: string;
            details: string | null;
            task: boolean;
            canRename: boolean;
            canDelete: boolean;
            canMove: boolean;
            canHaveDetails: boolean;
            canAddChild: boolean;
            canAddSibling: boolean;
            canMark: boolean;
            canToggleTask: boolean;
        }>();
        expectTypeOf(markdag.editSource).toEqualTypeOf(core.editSource);
        expectTypeOf(markdag.inspectNode).toEqualTypeOf(core.inspectNode);
        expectTypeOf<markdag.EditOp>().toEqualTypeOf<core.EditOp>();
        expectTypeOf<markdag.NodeTarget>().toEqualTypeOf<core.NodeTarget>();
        expectTypeOf<markdag.EditOutcome>().toEqualTypeOf<core.EditOutcome>();
        expectTypeOf<markdag.EditSelection>().toEqualTypeOf<core.EditSelection>();
        expectTypeOf<markdag.EditRename>().toEqualTypeOf<core.EditRename>();
        expectTypeOf<markdag.EditNote>().toEqualTypeOf<core.EditNote>();
        expectTypeOf<markdag.EditReason>().toEqualTypeOf<core.EditReason>();
        expectTypeOf<markdag.InspectNodeResult>().toEqualTypeOf<core.InspectNodeResult>();
    });

    it('markdag/core と markdag の入口から同じ editSource と inspectNode が出る', () => {
        expect(typeof core.editSource).toBe('function');
        expect(typeof core.inspectNode).toBe('function');
        expect(markdag.editSource).toBe(core.editSource);
        expect(markdag.inspectNode).toBe(core.inspectNode);
    });

    describe('名前の変更 (renameNode)', () => {
        it('1 行目の本文だけを変え、字下げ、タスクの記号、%、#、$ の印を残す', () => {
            const source = `${MD}# R #top\n## [x] h #k %g $hid\n- [ ] a #k:v %g $id\n\t- [/] b #k\n`;
            const cases: Array<[number, string, string, number, string]> = [
                [1, 'R', 'S', 3, '# S #top'],
                [2, 'h', 'y', 4, '## [x] y #k %g $hid'],
                [3, 'a', 'x', 5, '- [ ] x #k:v %g $id'],
                [4, 'b', 'z', 6, '\t- [/] z #k'],
            ];
            for (const [id, refText, label, line, text] of cases) {
                const after = withLine(source, line, text);
                expect(rename(source, id, refText, label)).toEqual(renamedTo(after, selected(id, label)));
                const before = nodeOf(source, id);
                const node = nodeOf(after, id);
                expect(node.tags).toEqual(before.tags.map((tag) => ({ ...tag, at: expect.anything() })));
                expect(node.groups).toEqual(before.groups);
                expect(node.refId).toBe(before.refId);
                expect(node.task?.state).toBe(before.task?.state);
            }
            // 番号付きの項目は頭の番号とタスクの記号を残す
            const numbered = `${MD}# R\n- a\n    1. [-] b #k\n`;
            expect(lineOf(renamed(numbered, 3, nodeOf(numbered, 3).refText, 'z'), 5)).toBe('    1. [-] z #k');
            // markdag キーのない文書では末尾の #… も本文なので置き換わる
            expect(renamed('# R\n- a #k %g\n', 2, 'a #k %g', 'x')).toBe('# R\n- x\n');
        });

        it('CRLF の文書で書き換えた行の \\r を残し、ほかの行は変えない', () => {
            expect(renamed('# R\r\n- a\r\n- b\r\n', 2, 'a', 'x')).toBe('# R\r\n- x\r\n- b\r\n');
            expect(renamed('---\r\nmarkdag:\r\n---\r\n# R\r\n- [ ] a #k\r\n- b\r\n', 2, 'a', 'x')).toBe('---\r\nmarkdag:\r\n---\r\n# R\r\n- [ ] x #k\r\n- b\r\n');
            // 改行で終わらない文書の最後の行には \r を付けない
            expect(renamed('# R\r\n- a', 2, 'a', 'x')).toBe('# R\r\n- x');
            // 改行のない文書は LF として扱う
            expect(renamed('# R\n- a', 2, 'a', 'x')).toBe('# R\n- x');
            // 入力の改行は空白になり、行末の \r だけが残る
            expect(renamed('# R\r\n- a\r\n', 2, 'a', 'x\r\ny')).toBe('# R\r\n- x y\r\n');
        });

        it('単独の \\r を含む文書は、文書の最初の改行にそろえてから書き換える (D-064)', () => {
            for (const [source, after] of [
                ['# R\n- a\r- b\n', '# R\n- x\n- b\n'],
                ['# R\r\n- a\r- b\r\n', '# R\r\n- x\r\n- b\r\n'],
            ] as const) {
                expect(nodeOf(source, 2).refText).toBe('a');
                const outcome = rename(source, 2, 'a', 'x');
                expect(outcome).toEqual(renamedTo(after, selected(2, 'x')));
                expectSelectMatchesReparse(outcome);
            }
        });

        it('splice は書き換えた行だけを含む: 書き換えない行の対になっていないサロゲートが原文のまま残る', () => {
            // 境界に送る文字列では U+FFFD に置き換わるので、Rust が原文の全体を返すと、ほかの行の字が変わる
            const source = '# R\n- a\n- b \ud800 c\n- \udc00\n';
            const outcome = rename(source, 2, 'a', 'x');
            expect(edited(outcome).source).toBe('# R\n- x\n- b \ud800 c\n- \udc00\n');
            expectSelectMatchesReparse(outcome);
            const crlf = '# R\r\n- \udbff\r\n- a\r\n';
            expect(renamed(crlf, 3, 'a', 'x')).toBe('# R\r\n- \udbff\r\n- x\r\n');
        });

        it('入力の改行 (\\r\\n、\\r、\\n、U+2028、U+2029) は空白にして前後の空白を外し、同じ名前なら unchanged (same-name)', () => {
            const source = '# R\n- a\n';
            expect(renamed(source, 2, 'a', 'x\r\ny\rz\nw v u')).toBe('# R\n- x y z w v u\n');
            expect(renamed(source, 2, 'a', '  x \n')).toBe('# R\n- x\n');
            expect(renamed(source, 2, 'a', '\r\nx y\r\n')).toBe('# R\n- x y\n');
            // 書いた名前で以後の書き換えが line-endings で断られない
            expect(renamed(renamed(source, 2, 'a', 'x\ry'), 2, 'x y', 'z')).toBe('# R\n- z\n');

            expect(rename(source, 2, 'a', 'a')).toEqual(unchanged('same-name'));
            expect(rename(source, 2, 'a', ' a\n')).toEqual(unchanged('same-name'));
            expect(rename(`${MD}# R\n- [ ] a #k\n`, 2, 'a', 'a')).toEqual(unchanged('same-name'));
            // 逃がしたあとの本文が今の本文と同じ
            expect(rename('# R\n- 1\\. 準備\n', 2, '1. 準備', '1. 準備')).toEqual(unchanged('same-name'));
        });

        it('項目の名前の印とブロックの書き始めを逃がし、解析し直した名前が入れた名前と同じ (markdag キーのない文書でも)', () => {
            const marked = `${MD}# R\n- a\n- b\n`;
            for (const [label, body] of ITEM_ESCAPES) {
                const outcome = rename(marked, 2, 'a', label);
                const after = withLine(marked, 4, `- ${body}`);
                expect(outcome, label).toEqual(renamedTo(after, selected(2, label)));
                expectPlainName(after, 2, label);
                expect(core.parseDocument(after).nodes.map((node) => node.refText)).toEqual(['R', label, 'b']);
                expect(firstLineBlocks(after), label).toEqual([]);
            }
            // markdag キーのない文書でも同じに逃がす。あとで markdag: が足されても読み方が変わらない
            const plain = '# R\n- a\n- b\n';
            for (const [label, body] of ITEM_ESCAPES) {
                const after = renamed(plain, 2, 'a', label);
                expect(after, label).toBe(withLine(plain, 1, `- ${body}`));
                expectPlainName(after, 2, label);
                expectPlainName(`${MD}${after}`, 2, label);
                expect(firstLineBlocks(`${MD}${after}`), label).toEqual([]);
            }
        });

        it('見出しの名前の逃がし: 閉じの記号に読まれる末尾の # の並びと、印とブロックの書き始め', () => {
            const cases: Array<[string, string]> = [
                ['Issue #', String.raw`Issue \#`],
                ['a ##', String.raw`a \##`],
                ['#todo', String.raw`\#todo`],
                ['Issue #frontend', String.raw`Issue \#frontend`],
                ['# x', String.raw`\# x`],
                ['1. x', String.raw`1\. x`],
                ['- x', String.raw`\- x`],
            ];
            for (const prefix of [MD, '']) {
                const source = `${prefix}# R\n## h\n`;
                const line = prefix.split('\n').length;
                for (const [label, body] of cases) {
                    const after = renamed(source, 2, 'h', label);
                    expect(after, label).toBe(withLine(source, line, `## ${body}`));
                    expectPlainName(after, 2, label);
                    expect(firstLineBlocks(after), label).toEqual([]);
                }
                const after = renamed(source, 1, 'R', 'Issue #');
                expect(after).toBe(withLine(source, line - 1, String.raw`# Issue \#`));
                expectPlainName(after, 1, 'Issue #');
            }
        });

        it('数字だけの #12 は印にならないので逃がさない', () => {
            for (const prefix of [MD, '']) {
                const source = `${prefix}# R\n- a\n`;
                const line = prefix.split('\n').length;
                for (const label of ['Issue #12', '#12']) {
                    const after = renamed(source, 2, 'a', label);
                    expect(after, label).toBe(withLine(source, line, `- ${label}`));
                    expectPlainName(after, 2, label);
                }
            }
        });

        it('印もタスクの記号もないノードも、空の名前は empty-name で断り、原文を返さない (D-031)', () => {
            const source = '# R\n- a\n- b\n';
            for (const label of ['', '   ', '\r\n']) expect(rename(source, 3, 'b', label), JSON.stringify(label)).toEqual(refused('empty-name'));
            // markdag キーのない文書の末尾の #… (印でなく本文) だけの名前も同じ
            expect(rename('# R\n- a #k\n- b\n', 2, 'a #k', '')).toEqual(refused('empty-name'));
        });

        it('空の名前: 印かタスクの記号のあるノードと、1 行目のすぐ次が空行で続きのある項目は empty-name', () => {
            for (const source of [`${MD}# R\n- [ ] a\n- b\n`, `${MD}# R\n- a #k\n- b\n`, `${MD}# R\n- a %g\n- b\n`, `${MD}# R\n- a $id\n- b\n`, '# R\n- [ ] a\n- b\n']) {
                expect(rename(source, 2, 'a', ''), source).toEqual(refused('empty-name'));
            }
            // 空の 1 行目で始まる項目は空行を 1 つしか持てず、続き (子、詳細、段落) が項目から外れる
            for (const rest of ['    - x', '    > d', '    続き']) {
                const source = `${MD}# R\n- A\n\n${rest}\n- B\n`;
                expect(rename(source, 2, 'A', ''), rest).toEqual(refused('empty-name'));
            }
        });

        it('段落の直後の項目を空にしても、ほかのノードと同じく empty-name で断り、原文を返さない (D-031)', () => {
            const source = `${MD}# R\n\n前置きの段落\n- a\n    - c\n`;
            expect(nodeOf(source, 2).refText).toBe('a');
            expect(rename(source, 2, 'a', '')).toEqual(refused('empty-name'));
        });

        it('行を持たないルートは title を書き換え (例の承認のルートのタイトル)、容器は no-source-line、表とコードと画像は block-node', () => {
            for (const [source, refText] of [
                [LINELESS, 'T'],
                [LIST_ROOT_TITLED, '手順'],
                [LIST_ROOT, ''],
            ] as const) {
                expect(rename(source, 1, refText, 'x').status, source).toBe('edited');
            }
            for (const id of [2, 5]) expect(rename(NESTED_LISTS, id, '', 'x'), `容器 ${id}`).toEqual(refused('no-source-line'));
            for (const id of [2, 3, 4]) expect(rename(BLOCKS, id, '', 'x'), `表とコードと画像 ${id}`).toEqual(refused('block-node'));
        });

        it('refText が違う NodeTarget と、その id のノードがない NodeTarget は stale-node', () => {
            expect(rename(NESTED_LISTS, 3, 'b', 'x')).toEqual(refused('stale-node'));
            expect(rename(NESTED_LISTS, 99, 'a', 'x')).toEqual(refused('stale-node'));
            expect(rename(NESTED_LISTS, 0, '', 'x')).toEqual(refused('stale-node'));
            // label (Markdown の記法) は refText ではない
            expect(rename(MARKED, 3, '**太字** と `code`', 'x')).toEqual(refused('stale-node'));
            // id は数として届く (js_f64)。整数でない数と有限でない数は、どのノードの id でもない
            for (const id of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1]) {
                expect(rename(NESTED_LISTS, id, 'a', 'x'), String(id)).toEqual(refused('stale-node'));
            }
        });

        it('select は書き換えたあとの原文を parseDocument した id と refText に一致する', () => {
            // 容器と同じ行から始まる最初の項目: 容器でなく項目を選ぶ
            const nested = rename(NESTED_LISTS, 3, 'a', 'x');
            expect(nested).toEqual(renamedTo('# R\n\n- x\n- b\n\n1. c\n2. d\n', selected(3, 'x')));
            expectSelectMatchesReparse(nested);
            const after = edited(nested).source;
            expect(nodeOf(after, 2).lines?.start).toBe(nodeOf(after, 3).lines?.start);

            // リストだけの文書: ルート (容器) と最初の項目が同じ行
            const listRoot = rename(LIST_ROOT, 2, 'a', 'x');
            expect(listRoot).toEqual(renamedTo('- x\n- b\n', selected(2, 'x')));
            expectSelectMatchesReparse(listRoot);

            // 番号付きの項目の refText は頭の番号を含むので、入れた名前でなく解析し直した値を返す
            const numbered = rename('# R\n1. a\n2. b\n', 3, '2. b', 'x');
            expect(numbered).toEqual(renamedTo('# R\n1. a\n2. x\n', selected(3, '2. x')));
            expectSelectMatchesReparse(numbered);

            const escaped = rename(`${MD}# R\n- a\n- b\n`, 2, 'a', '#todo');
            expect(edited(escaped).select).toEqual(selected(2, '#todo'));
            expectSelectMatchesReparse(escaped);
        });
    });

    describe('inspectNode', () => {
        it('見出しと項目: label は Markdown の記法を残して行頭の記号とタスクの記号と末尾の印を外し、details は > を外す。見出しも詳細を持てる (D-039)', () => {
            expect(core.inspectNode(MARKED, { id: 1, refText: 'R' })).toEqual(inspected(1, 'heading', 'R', null, false, ROOT_HEADING));
            expect(core.inspectNode(MARKED, { id: 2, refText: 'h' })).toEqual(inspected(2, 'heading', 'h', null, true, HEADING));
            expect(core.inspectNode(MARKED, { id: 3, refText: '太字 と code' })).toEqual(inspected(3, 'item', '**太字** と `code`', '1 行目\n\n**3** 行目', true, ITEM));
            expect(core.inspectNode(MARKED, { id: 4, refText: 'c' })).toEqual(inspected(4, 'item', 'c', null, false, ITEM));
        });

        it('容器 (ul / ol) と、表とコードと画像を見分ける', () => {
            for (const [id, itemId, itemRef] of [
                [2, 3, 'a'],
                [5, 6, '1. c'],
            ] as const) {
                expect(core.inspectNode(NESTED_LISTS, { id, refText: '' }), `容器 ${id}`).toEqual(inspected(id, 'list', '', null, false, CONTAINER));
                // 同じ 1 行目の最初の項目は容器でなく項目
                expect(core.inspectNode(NESTED_LISTS, { id: itemId, refText: itemRef })?.kind).toBe('item');
            }
            for (const id of [2, 3, 4]) {
                expect(core.inspectNode(BLOCKS, { id, refText: '' }), `表とコードと画像 ${id}`).toEqual(inspected(id, 'block', '', null, false, BLOCK));
            }
        });

        it('行を持たないルートと、リストだけの文書のルート (容器)', () => {
            expect(core.inspectNode(LINELESS, { id: 1, refText: 'T' })).toEqual(inspected(1, 'root', 'T', null, false, LINELESS_ROOT));
            // ルートなので消せず動かせない。名前 (title) は変えられ、名前の入力の初めの値は今の title。兄弟 (canAddSibling) はここでは見ない
            for (const [source, refText] of [
                [LIST_ROOT_TITLED, '手順'],
                [LIST_ROOT, ''],
            ] as const) {
                expect(core.inspectNode(source, { id: 1, refText }), source).toMatchObject({
                    id: 1,
                    kind: 'list',
                    label: refText,
                    details: null,
                    task: false,
                    canRename: true,
                    canDelete: false,
                    canMove: false,
                    canHaveDetails: false,
                    canAddChild: true,
                    canMark: false,
                });
            }
        });

        it('下線の見出しと行頭に空白のある ATX の見出しも canMark が true (印を書く前に ATX の見出しに書き直す。D-039)', () => {
            expect(core.inspectNode(UNMARKABLE, { id: 1, refText: 'R' })).toEqual(inspected(1, 'heading', 'R', null, false, ROOT_HEADING));
            expect(core.inspectNode(UNMARKABLE, { id: 2, refText: '設計' })).toEqual(inspected(2, 'heading', '設計', null, false, UNMARKABLE_HEADING));
            expect(core.inspectNode(UNMARKABLE, { id: 3, refText: '画面' })).toEqual(inspected(3, 'item', '画面', null, false, ITEM));
            expect(core.inspectNode(UNMARKABLE, { id: 4, refText: '実装' })).toEqual(inspected(4, 'heading', '実装', null, false, UNMARKABLE_HEADING));
        });

        it('markdag キーのない文書では末尾の #… も label に入る', () => {
            const source = '# R\n- Issue #123 fix #urgent\n- [ ] a #k\n';
            expect(core.inspectNode(source, { id: 2, refText: 'Issue #123 fix #urgent' })).toEqual(inspected(2, 'item', 'Issue #123 fix #urgent', null, false, ITEM));
            expect(core.inspectNode(source, { id: 3, refText: 'a #k' })).toEqual(inspected(3, 'item', 'a #k', null, true, ITEM));
            // 対照: markdag キーのある文書では #urgent はタグ (数字だけの #123 は名前に残る)
            expect(core.inspectNode(`${MD}# R\n- Issue #123 fix #urgent\n`, { id: 2, refText: 'Issue #123 fix' })).toEqual(inspected(2, 'item', 'Issue #123 fix', null, false, ITEM));
        });

        it('id のノードがないか refText が違えば null', () => {
            expect(core.inspectNode(NESTED_LISTS, { id: 99, refText: 'a' })).toBeNull();
            expect(core.inspectNode(NESTED_LISTS, { id: 0, refText: '' })).toBeNull();
            expect(core.inspectNode(NESTED_LISTS, { id: 3, refText: 'b' })).toBeNull();
            expect(core.inspectNode(MARKED, { id: 3, refText: '**太字** と `code`' })).toBeNull();
            for (const id of [Number.NaN, Number.NEGATIVE_INFINITY, 3.5]) {
                expect(core.inspectNode(NESTED_LISTS, { id, refText: 'a' }), String(id)).toBeNull();
            }
        });
    });

    it('知らない kind の op と欄の型の違いは MarkdagError (invalid-input)', () => {
        const source = '# R\n- a\n';
        const badOps: unknown[] = [
            { kind: 'nope' },
            { kind: 'nope', node: { id: 2, refText: 'a' }, label: 'x' },
            { kind: 'renameNode', node: { id: 2, refText: 'a' }, label: 1 },
            { kind: 'renameNode', node: { id: 2 }, label: 'x' },
            { kind: 'renameNode', node: { id: '2', refText: 'a' }, label: 'x' },
        ];
        for (const op of badOps) {
            const error = thrown(() => core.editSource(source, op as core.EditOp));
            expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
            expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
        }
        for (const node of [{ id: 2 }, { id: '2', refText: 'a' }, { refText: 'a' }]) {
            const error = thrown(() => core.inspectNode(source, node as unknown as core.NodeTarget));
            expect(error, JSON.stringify(node)).toBeInstanceOf(core.MarkdagError);
            expect(error).toMatchObject({ code: 'invalid-input', functionName: 'inspect_node' });
        }
        // 誤りのあとも同じ境界で呼べる
        expect(renamed(source, 2, 'a', 'x')).toBe('# R\n- x\n');
    });
});

// ---- 子と兄弟の追加 (addChild と addSibling。子の形、位置、兄弟、字下げ、空行) ----

// 足したノードの仮の名前。呼び出し側が label で渡す
const NEW = '新しいノード';

// 見出しのない文書で最上位のリストが 2 つ (どちらも項目が 2 つ)。ルート「T」は lines が null で、子は ul (2) と ol (5) の容器
const LINELESS_LISTS = '---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n';
// 1 Root / 2 設計 / 3 画面。Root と設計は下線の見出し
const SETEXT = `${MD}Root\n====\n\n設計\n----\n- 画面\n`;
// 項目の字下げがタブの文書。ルートは lines が null (1)、2 x / 3 y / 4「100. a」
const TABBED = `${MD}- x\n\t- y\n100. a\n`;
// 1 R / 2 a。a の中のフェンスは閉じているので、次の「本文」は a の続きでなく R の下の段落
const FENCED_ITEM = '# R\n- a\n\n  ~~~\n  x\n  ~~~\n本文\n';

const addChild = (source: string, id: number, refText: string, label: string = NEW): core.EditOutcome =>
    core.editSource(source, { kind: 'addChild', parent: { id, refText }, label });
const addSibling = (source: string, id: number, refText: string, label: string = NEW): core.EditOutcome =>
    core.editSource(source, { kind: 'addSibling', node: { id, refText }, label });

// 足した結果の全体: select と rename は足したノード、notes は空
const added = (source: string, id: number, refText: string): unknown => ({
    status: 'edited',
    source,
    select: selected(id, refText),
    rename: { kind: 'node', node: { id, refText } },
    notes: [],
});

// 原文の全体と、select が書き換えたあとの原文を parseDocument した id と refText に一致すること、足したノードの親
function expectAdded(outcome: core.EditOutcome, after: string, [id, refText]: [number, string], parent: number): void {
    expect(outcome).toEqual(added(after, id, refText));
    expectSelectMatchesReparse(outcome);
    expect(nodeOf(after, id).parent, after).toBe(parent);
}

describe('editSource の addChild と addSibling (GUI 編集の段 3: 子と兄弟の追加)', () => {
    it('型: addChild と addSibling の op の形', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'addChild' }>>().toEqualTypeOf<{ kind: 'addChild'; parent: core.NodeTarget; label: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'addSibling' }>>().toEqualTypeOf<{ kind: 'addSibling'; node: core.NodeTarget; label: string }>();
    });

    describe('子の形 (B-021)', () => {
        it('子のない見出しの子は 1 段下の ATX の見出し、6 段の見出しの子はリストの項目', () => {
            expectAdded(addChild('# R\n', 1, 'R'), '# R\n\n## 新しいノード\n', [2, NEW], 1);
            expectAdded(addChild('# R\n## A\n### C\n', 3, 'C'), '# R\n## A\n### C\n\n#### 新しいノード\n', [4, NEW], 3);
            expectAdded(addChild('# R\n###### F\n', 2, 'F'), '# R\n###### F\n- 新しいノード\n', [3, NEW], 2);
            // 段落があれば段落のあと
            expectAdded(addChild('# R\n###### F\n本文\n', 2, 'F'), '# R\n###### F\n本文\n- 新しいノード\n', [3, NEW], 2);
        });

        it('子のない項目の子は入れ子の項目: 字下げは入れ子の差の最小 (なければ 4) で、内容の桁より小さければ内容の桁', () => {
            expectAdded(addChild('# R\n- a\n- b\n', 2, 'a'), '# R\n- a\n    - 新しいノード\n- b\n', [3, NEW], 2);
            const source = '# R\n## A\n- x\n  - y\n## B\n10. a\n';
            expectAdded(addChild(source, 4, 'y'), '# R\n## A\n- x\n  - y\n    - 新しいノード\n## B\n10. a\n', [5, NEW], 4);
            expectAdded(addChild(source, 6, '10. a'), '# R\n## A\n- x\n  - y\n## B\n10. a\n    - 新しいノード\n', [7, NEW], 6);
            // 空白の文書の `100. a` の子は内容の桁 5 (4 では a の段落の続きになる)
            expectAdded(addChild('# R\n100. a\n', 2, '100. a'), '# R\n100. a\n     - 新しいノード\n', [3, NEW], 2);
        });

        it('子がいれば最後の子の形: 見出しの段、字下げと印、番号付きは次の番号と区切り、タスクは [ ]', () => {
            expectAdded(addChild('# R\n## A\n### a1\n## B\n', 1, 'R'), '# R\n## A\n### a1\n## B\n\n## 新しいノード\n', [5, NEW], 1);
            expectAdded(addChild('# R\n## A\n- x\n    > 詳細\n- y\n\n## B\n', 2, 'A'), '# R\n## A\n- x\n    > 詳細\n- y\n- 新しいノード\n\n## B\n', [5, NEW], 2);
            expectAdded(addChild('# R\n## A\n- x\n  - y\n## B\n10. a\n', 3, 'x'), '# R\n## A\n- x\n  - y\n  - 新しいノード\n## B\n10. a\n', [5, NEW], 3);
            expectAdded(addChild('# R\n* a\n* b\n', 1, 'R'), '# R\n* a\n* b\n* 新しいノード\n', [4, NEW], 1);
            expectAdded(addChild('# R\n- a\n    + x\n', 2, 'a'), '# R\n- a\n    + x\n    + 新しいノード\n', [4, NEW], 2);
            // 番号付きの refText は解析し直した値 (頭の番号を含み、区切りは . になる)
            expectAdded(addChild('# R\n1. a\n2. b\n', 1, 'R'), '# R\n1. a\n2. b\n3. 新しいノード\n', [4, '3. 新しいノード'], 1);
            expectAdded(addChild('# R\n1) a\n2) b\n', 1, 'R'), '# R\n1) a\n2) b\n3) 新しいノード\n', [4, '3. 新しいノード'], 1);
            expectAdded(addChild('# R\n- a\n    1. x\n    2. y\n', 2, 'a'), '# R\n- a\n    1. x\n    2. y\n    3. 新しいノード\n', [5, '3. 新しいノード'], 2);
            expectAdded(addChild('# R\n- [x] a\n', 1, 'R'), '# R\n- [x] a\n- [ ] 新しいノード\n', [3, NEW], 1);
            expectAdded(addChild('# R\n- a\n    1. [/] x\n', 2, 'a'), '# R\n- a\n    1. [/] x\n    2. [ ] 新しいノード\n', [4, '2. 新しいノード'], 2);
        });

        it('最後の子が容器なら容器の最後の項目の形で容器のリストの末尾。表かコードなら見出しが前の子を捨てるので structure-changed', () => {
            expectAdded(addChild(NESTED_LISTS, 1, 'R'), '# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n', [8, '3. 新しいノード'], 5);
            expectAdded(addChild(NESTED_LISTS, 2, ''), '# R\n\n- a\n- b\n- 新しいノード\n\n1. c\n2. d\n', [5, NEW], 2);
            expectAdded(addChild(NESTED_LISTS, 5, ''), '# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n', [8, '3. 新しいノード'], 5);
            // 子のないときの形 (`## 新しいノード`) で書くと、解析は表とコードを子にしなくなる。書き換えたあとの確かめが止める
            for (const source of ['# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', '# R\n\n~~~js\nx\n~~~\n']) {
                expect(core.parseDocument(source).nodes).toHaveLength(2);
                expect(addChild(source, 1, 'R'), source).toEqual(refused('structure-changed'));
            }
        });

        it('下線の見出しの兄弟と子は ATX の見出しで足す (A-24)', () => {
            const after = `${MD}Root\n====\n\n設計\n----\n- 画面\n\n## 新しいノード\n`;
            expectAdded(addSibling(SETEXT, 2, '設計'), after, [4, NEW], 1);
            expectAdded(addChild(SETEXT, 1, 'Root'), after, [4, NEW], 1);
            expectAdded(addSibling(SETEXT, 1, 'Root'), after, [4, NEW], 1);
            expectAdded(addChild(SETEXT, 2, '設計'), `${MD}Root\n====\n\n設計\n----\n- 画面\n- 新しいノード\n`, [4, NEW], 2);
            expectAdded(addChild('Root\n====\n', 1, 'Root'), 'Root\n====\n\n## 新しいノード\n', [2, NEW], 1);
        });
    });

    describe('子を足す位置 (B-022)', () => {
        it('見出しは配下の段落のあと、項目は詳細と入れ子と続きの段落のあと (末尾の空行の前)', () => {
            expectAdded(addChild('# R\n\n## A\n本文の段落\n\n## B\n', 2, 'A'), '# R\n\n## A\n本文の段落\n\n### 新しいノード\n\n## B\n', [3, NEW], 2);
            expectAdded(
                addChild('# R\n- x\n    > 詳細\n    - x1\n        - x2\n- y\n', 2, 'x'),
                '# R\n- x\n    > 詳細\n    - x1\n        - x2\n    - 新しいノード\n- y\n',
                [5, NEW],
                2,
            );
            expectAdded(addChild('# R\n- a\n\n  続き\n\n- b\n', 2, 'a'), '# R\n- a\n\n  続き\n    - 新しいノード\n\n- b\n', [3, NEW], 2);
        });

        it('行を持たないルートとリストだけの文書のルートは本文の末尾に最上位の項目', () => {
            expectAdded(addChild(LINELESS_LISTS, 1, 'T'), '---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n', [8, '3. 新しいノード'], 5);
            expectAdded(addChild(LIST_ROOT, 1, ''), '- a\n- b\n- 新しいノード\n', [4, NEW], 1);
            expectAdded(addChild(LIST_ROOT_TITLED, 1, '手順'), '---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n- 新しいノード\n', [4, NEW], 1);
        });
    });

    describe('兄弟 (B-023)', () => {
        it('自分のブロックのあとに同じ形: 見出しの段、字下げと印、番号付きは自分の番号 + 1 (後ろの兄弟は振り直す)、タスクは [ ]', () => {
            expectAdded(addSibling('# R\n## A\n### a1\n\n## B\n', 2, 'A'), '# R\n## A\n### a1\n\n## 新しいノード\n\n## B\n', [4, NEW], 1);
            const nested = '# R\n- x\n    > 詳細\n    - x1\n- y\n';
            expectAdded(addSibling(nested, 2, 'x'), '# R\n- x\n    > 詳細\n    - x1\n- 新しいノード\n- y\n', [4, NEW], 1);
            expectAdded(addSibling(nested, 3, 'x1'), '# R\n- x\n    > 詳細\n    - x1\n    - 新しいノード\n- y\n', [4, NEW], 2);
            expectAdded(addSibling('# R\n1. a\n2. b\n3. c\n', 2, '1. a'), '# R\n1. a\n2. 新しいノード\n3. b\n4. c\n', [3, '2. 新しいノード'], 1);
            expectAdded(addSibling('# R\n1) a\n2) b\n', 3, '2. b'), '# R\n1) a\n2) b\n3) 新しいノード\n', [4, '3. 新しいノード'], 1);
            expectAdded(addSibling('# R\n- [/] a\n- b\n', 2, 'a'), '# R\n- [/] a\n- [ ] 新しいノード\n- b\n', [3, NEW], 1);
            expectAdded(addSibling('# R\n1. [-] a\n', 2, '1. [-] a'), '# R\n1. [-] a\n2. [ ] 新しいノード\n', [3, '2. 新しいノード'], 1);
            expectAdded(addSibling('# R\n## [x] h\n', 2, 'h'), '# R\n## [x] h\n\n## [ ] 新しいノード\n', [3, NEW], 1);
            // 容器の中の項目の兄弟は同じ容器のリストに入る
            expectAdded(addSibling(NESTED_LISTS, 3, 'a'), '# R\n\n- a\n- 新しいノード\n- b\n\n1. c\n2. d\n', [4, NEW], 2);
            expectAdded(addSibling(NESTED_LISTS, 7, '2. d'), '# R\n\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n', [8, '3. 新しいノード'], 5);
        });

        it('ルートの兄弟は子: ルートだけの文書、項目 1 つだけの文書、行を持たないルート、ルートでもある容器', () => {
            expectAdded(addSibling('# R\n- a\n', 1, 'R'), '# R\n- a\n- 新しいノード\n', [3, NEW], 1);
            expectAdded(addSibling('# R\n', 1, 'R'), '# R\n\n## 新しいノード\n', [2, NEW], 1);
            // 項目 1 つだけの文書はルートがその項目
            expect(core.parseDocument('- a\n').nodes.map((node) => [node.id, node.parent, node.refText])).toEqual([[1, null, 'a']]);
            expectAdded(addSibling('- a\n', 1, 'a'), '- a\n    - 新しいノード\n', [2, NEW], 1);
            expectAdded(addSibling(LINELESS_LISTS, 1, 'T'), '---\ntitle: T\n---\n- a\n- b\n\n1. c\n2. d\n3. 新しいノード\n', [8, '3. 新しいノード'], 5);
            // ルートでもある容器はルートの規則が勝つ
            for (const [source, refText, after] of [
                [LIST_ROOT, '', '- a\n- b\n- 新しいノード\n'],
                [LIST_ROOT_TITLED, '手順', '---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装\n- 新しいノード\n'],
            ] as const) {
                expect(core.inspectNode(source, { id: 1, refText })?.canAddSibling, source).toBe(true);
                expectAdded(addSibling(source, 1, refText), after, [4, NEW], 1);
            }
        });
    });

    it('断る: 容器の兄弟は no-source-line、表とコードと画像の子と兄弟は block-node、古い NodeTarget は stale-node。単独の \\r は文書の最初の改行にそろえてから足す (D-064)', () => {
        for (const id of [2, 5]) expect(addSibling(NESTED_LISTS, id, ''), `容器 ${id}`).toEqual(refused('no-source-line'));
        for (const id of [2, 3, 4]) {
            expect(addChild(BLOCKS, id, ''), `表とコードと画像 ${id}`).toEqual(refused('block-node'));
            expect(addSibling(BLOCKS, id, ''), `表とコードと画像 ${id}`).toEqual(refused('block-node'));
        }
        for (const [source, id, refText] of [
            [NESTED_LISTS, 3, 'b'],
            [NESTED_LISTS, 99, 'a'],
            [NESTED_LISTS, 0, ''],
            [MARKED, 3, '**太字** と `code`'],
            [NESTED_LISTS, Number.NaN, 'a'],
            [NESTED_LISTS, 2.5, 'a'],
        ] as const) {
            expect(addChild(source, id, refText), `${id} ${refText}`).toEqual(refused('stale-node'));
            expect(addSibling(source, id, refText), `${id} ${refText}`).toEqual(refused('stale-node'));
        }
        for (const [source, nl] of [
            ['# R\n- a\r- b\n', '\n'],
            ['# R\r\n- a\r- b\r\n', '\r\n'],
        ] as const) {
            expect(nodeOf(source, 2).refText).toBe('a');
            const lines = (...items: string[]): string => items.map((line) => `${line}${nl}`).join('');
            expectAdded(addChild(source, 2, 'a'), lines('# R', '- a', '    - 新しいノード', '- b'), [3, NEW], 2);
            expectAdded(addChild(source, 1, 'R'), lines('# R', '- a', '- b', '- 新しいノード'), [4, NEW], 1);
            expectAdded(addSibling(source, 2, 'a'), lines('# R', '- a', '- 新しいノード', '- b'), [3, NEW], 1);
        }
    });

    it('空行 (B-024): 段落の前に項目を足すと空行をはさみ、見出しを段落かリストの直後に足すと前後に空行をはさむ (重ねない)', () => {
        expectAdded(addSibling(FENCED_ITEM, 2, 'a'), '# R\n- a\n\n  ~~~\n  x\n  ~~~\n- 新しいノード\n\n本文\n', [3, NEW], 1);
        expectAdded(addChild(FENCED_ITEM, 2, 'a'), '# R\n- a\n\n  ~~~\n  x\n  ~~~\n    - 新しいノード\n\n本文\n', [3, NEW], 2);
        expectAdded(addSibling('# R\n## A\n本文\n## B\n', 2, 'A'), '# R\n## A\n本文\n\n## 新しいノード\n\n## B\n', [3, NEW], 1);
        expectAdded(addSibling('# R\n## A\n- x\n- y\n## B\n', 2, 'A'), '# R\n## A\n- x\n- y\n\n## 新しいノード\n\n## B\n', [5, NEW], 1);
        expectAdded(addSibling('# R\n\n## A\n\n- x\n\n## B\n', 2, 'A'), '# R\n\n## A\n\n- x\n\n## 新しいノード\n\n## B\n', [4, NEW], 1);
    });

    it('タブで字下げした文書: 4 桁ごとのタブと残りの空白で書き、`100. a` の子は内容の桁 5 に届いて a の子になる (B-22)', () => {
        expectAdded(addChild(TABBED, 4, '100. a'), `${MD}- x\n\t- y\n100. a\n\t - 新しいノード\n`, [5, NEW], 4);
        expectAdded(addChild(TABBED, 3, 'y'), `${MD}- x\n\t- y\n\t\t- 新しいノード\n100. a\n`, [4, NEW], 3);
        const after = `${MD}- x\n\t- y\n\t- 新しいノード\n100. a\n`;
        expectAdded(addChild(TABBED, 2, 'x'), after, [4, NEW], 2);
        expectAdded(addSibling(TABBED, 3, 'y'), after, [4, NEW], 2);
    });

    it('CRLF の文書は足す行に \\r を付け、文書の終わり方 (改行で終わるか) を変えない。CRLF で改行で終わらない文書に 2 回続けて足せる (A-04)', () => {
        expectAdded(addSibling('# R\r\n- a\r\n- b\r\n', 2, 'a'), '# R\r\n- a\r\n- 新しいノード\r\n- b\r\n', [3, NEW], 1);
        expectAdded(addChild('# R\r\n', 1, 'R'), '# R\r\n\r\n## 新しいノード\r\n', [2, NEW], 1);
        expectAdded(addChild('# R\n- a\n', 1, 'R'), '# R\n- a\n- 新しいノード\n', [3, NEW], 1);
        expectAdded(addChild('# R\n- a', 1, 'R'), '# R\n- a\n- 新しいノード', [3, NEW], 1);
        expectAdded(addChild('# R', 1, 'R'), '# R\n\n## 新しいノード', [2, NEW], 1);
        expectAdded(addSibling('# R\r\n## A', 2, 'A'), '# R\r\n## A\r\n\r\n## 新しいノード', [3, NEW], 1);
        const once = addChild('# R\r\n- a', 1, 'R');
        expectAdded(once, '# R\r\n- a\r\n- 新しいノード', [3, NEW], 1);
        const onceSource = edited(once).source;
        expectAdded(addChild(onceSource, 1, 'R'), '# R\r\n- a\r\n- 新しいノード\r\n- 新しいノード', [4, NEW], 1);
        // 足したあとに開く名前の入力の決定 (renameNode) も line-endings で断られない
        expect(renamed(onceSource, 3, NEW, 'b')).toBe('# R\r\n- a\r\n- b');
        // 書き換えない行の対になっていないサロゲートは原文のまま (splice は足した行と書き換えた行だけ)
        expectAdded(addSibling('# R\n- a\n- b \ud800 c\n', 2, 'a'), '# R\n- a\n- 新しいノード\n- b \ud800 c\n', [3, NEW], 1);
    });

    it('select と rename は足したノードで、行を持たないルートや容器のある文書でも容器でなく足した項目を指す (B-004、B-025、B-01)', () => {
        const cases: Array<[core.EditOutcome, number, string]> = [
            [addSibling(NESTED_LISTS, 3, 'a'), 4, NEW],
            [addChild(NESTED_LISTS, 1, 'R'), 8, '3. 新しいノード'],
            [addChild(LINELESS_LISTS, 1, 'T'), 8, '3. 新しいノード'],
            [addChild(LIST_ROOT, 1, ''), 4, NEW],
            [addSibling(LIST_ROOT, 2, 'a'), 3, NEW],
            [addSibling('- a\n', 1, 'a'), 2, NEW],
        ];
        for (const [outcome, id, refText] of cases) {
            const result = edited(outcome);
            expect(result.select).toEqual(selected(id, refText));
            expect(result.rename).toEqual({ kind: 'node', node: { id, refText } });
            expect(result.notes).toEqual([]);
            expectSelectMatchesReparse(outcome);
            expect(core.inspectNode(result.source, { id, refText })?.kind, result.source).toBe('item');
        }
    });

    it('足す操作の label にも名前の行の規則 (改行は空白、前後の空白を外す) と逃がしを当てる (3.5 の名前の行)', () => {
        const source = `${MD}# R\n- a\n`;
        expectAdded(addChild(source, 2, 'a', '#todo'), `${MD}# R\n- a\n    - \\#todo\n`, [3, '#todo'], 2);
        expectAdded(addSibling(source, 2, 'a', ' x\ny '), `${MD}# R\n- a\n- x y\n`, [3, 'x y'], 1);
        expectAdded(addChild(`${MD}# R\n`, 1, 'R', 'Issue #'), `${MD}# R\n\n## Issue \\#\n`, [2, 'Issue #'], 1);
    });
});

// ---- 子を足せない所と、足すと読み方が変わる文書 (最後の子が表、コード、画像の見出し、新しい容器、空の文書、題だけの文書) ----

// 1 R / 2 A / 3 表、コード、画像 (A の子) / 4 B
const HEADING_WITH_BLOCKS = [
    '# R\n## A\n\n| a | b |\n| - | - |\n| 1 | 2 |\n## B\n',
    '# R\n## A\n\n~~~js\nx\n~~~\n## B\n',
    '# R\n## A\n\n![img](x.png)\n## B\n',
] as const;

describe('editSource の addChild と addSibling (GUI 編集の段 3: メインが足した既定)', () => {
    it('見出しの最後の子が表、コード、画像なら canAddChild は false で、addChild は structure-changed (兄弟は足せる)。見出しの canHaveDetails は true (D-079)', () => {
        for (const source of HEADING_WITH_BLOCKS) {
            expect(nodeOf(source, 3).parent, source).toBe(2);
            expect(core.inspectNode(source, { id: 2, refText: 'A' }), source).toEqual(inspected(2, 'heading', 'A', null, false, [true, true, true, true, false, true, true, true]));
            expect(addChild(source, 2, 'A'), source).toEqual(refused('structure-changed'));
        }
        const level6 = '# R\n###### F\n\n~~~\nx\n~~~\n';
        expect(core.inspectNode(level6, { id: 2, refText: 'F' })?.canAddChild).toBe(false);
        expect(addChild(level6, 2, 'F')).toEqual(refused('structure-changed'));
        expect(core.inspectNode(BLOCKS, { id: 1, refText: 'R' })?.canAddChild).toBe(false);
        expect(addChild(BLOCKS, 1, 'R')).toEqual(refused('structure-changed'));
        const after = '# R\n## A\n\n~~~js\nx\n~~~\n\n## 新しいノード\n\n## B\n';
        expectAdded(addSibling(HEADING_WITH_BLOCKS[1], 2, 'A'), after, [4, NEW], 1);
        expect(nodeOf(after, 3).parent).toBe(2);
    });

    it('足すと新しい容器ができて触らない項目の親が変わる文書は structure-changed (容器を飛ばして比べない)', () => {
        const source = '# R\n\n- a\n\n1. c\n2. d\n';
        expect(nodeOf(source, 2).parent).toBe(1);
        expect(addSibling(source, 2, 'a')).toEqual(refused('structure-changed'));
        expect(nodeOf(LINELESS, 3).parent).toBe(1);
        expect(addChild(LINELESS, 1, 'T')).toEqual(refused('structure-changed'));
        expect(addSibling(LINELESS, 1, 'T')).toEqual(refused('structure-changed'));
        expect(addSibling(LINELESS, 2, 'a')).toEqual(refused('structure-changed'));
        expect(addSibling(LINELESS, 3, '1. b')).toEqual(refused('structure-changed'));
        expect(addSibling(TABBED, 4, '100. a')).toEqual(refused('structure-changed'));
    });

    it('空の文書 (title もない) への子と兄弟は edited で、足した項目がルートになり id 1 を選ぶ', () => {
        for (const [source, after] of [
            ['', '- 新しいノード\n'],
            [MD, `${MD}- 新しいノード\n`],
        ] as const) {
            expect(core.parseDocument(source).nodes.map((node) => [node.id, node.parent, node.refText])).toEqual([[1, null, '']]);
            for (const outcome of [addChild(source, 1, ''), addSibling(source, 1, '')]) {
                expect(outcome, source).toEqual(added(after, 1, NEW));
                expectSelectMatchesReparse(outcome);
                expect(core.parseDocument(after).nodes.map((node) => [node.id, node.parent, node.refText])).toEqual([[1, null, NEW]]);
            }
        }
    });

    it('frontmatter の title だけがある文書への子と兄弟は、title が名前から消えるので structure-changed', () => {
        for (const source of ['---\ntitle: T\n---\n', '---\ntitle: T\nmarkdag:\n---\n']) {
            expect(core.parseDocument(source).nodes.map((node) => [node.id, node.parent, node.refText])).toEqual([[1, null, 'T']]);
            expect(addChild(source, 1, 'T'), source).toEqual(refused('structure-changed'));
            expect(addSibling(source, 1, 'T'), source).toEqual(refused('structure-changed'));
        }
    });
});

// ---- ノードの削除と付け替え (deleteNodes と moveNode。削除、付け替え、字下げの書き方) ----
// 本文の書き換えだけを見る (relations の追随は frontmatter の書き換えのテストが見る)。文書は frontmatter に relations を持たない

type Target = [number, string];

const deleteNodes = (source: string, ...nodes: Target[]): core.EditOutcome =>
    core.editSource(source, { kind: 'deleteNodes', nodes: nodes.map(([id, refText]) => ({ id, refText })) });
const moveNode = (source: string, [id, refText]: Target, [parentId, parentRefText]: Target): core.EditOutcome =>
    core.editSource(source, { kind: 'moveNode', node: { id, refText }, parent: { id: parentId, refText: parentRefText } });

// 書き換えた結果の全体: select は 1 つのノード、rename は null、notes は空。
// select は書き換えたあとの原文を parseDocument した id と refText に一致する
function expectRewritten(outcome: core.EditOutcome, after: string, [id, refText]: Target): void {
    expect(outcome).toEqual({ status: 'edited', source: after, select: selected(id, refText), rename: null, notes: [] });
    expectSelectMatchesReparse(outcome);
}

// 付け替えた結果: 上に加えて、動かしたノードの親が移す先
function expectMoved(outcome: core.EditOutcome, after: string, moved: Target, parent: number): void {
    expectRewritten(outcome, after, moved);
    expect(nodeOf(after, moved[0]).parent, after).toBe(parent);
}

const detailsOf = (source: string, id: number, refText: string): string | null | undefined => core.inspectNode(source, { id, refText })?.details;

// 1 R / 2 A / 3 x / 4 B / 5 C
const MOVES = '# R\n## A\n- x\n## B\n### C\n';

describe('editSource の deleteNodes と moveNode (GUI 編集の段 4: ノードの削除と付け替え)', () => {
    it('型: deleteNodes と moveNode の op の形', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'deleteNodes' }>>().toEqualTypeOf<{ kind: 'deleteNodes'; nodes: core.NodeTarget[] }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'moveNode' }>>().toEqualTypeOf<{ kind: 'moveNode'; node: core.NodeTarget; parent: core.NodeTarget }>();
    });

    describe('削除 (B-038、B-040、B-041)', () => {
        it('リストの項目は詳細と入れ子ごと消し、選ぶのは親。番号付きは残った兄弟の番号を振り直し、文書の終わり方は変えない', () => {
            expectRewritten(deleteNodes('# R\n- a\n    > 詳細\n    - a1\n        - a2\n- b\n', [2, 'a']), '# R\n- b\n', [1, 'R']);
            expectRewritten(deleteNodes(`${MD}# R\n- a\n- b\n`, [3, 'b']), `${MD}# R\n- a\n`, [1, 'R']);
            const numbered = deleteNodes('# R\n1. a\n2. b\n3. c\n', [3, '2. b']);
            expectRewritten(numbered, '# R\n1. a\n2. c\n', [1, 'R']);
            expect(nodeOf(edited(numbered).source, 3).refText).toBe('2. c');
            expectRewritten(deleteNodes('# R\n- a\n- b', [3, 'b']), '# R\n- a', [1, 'R']);
        });

        it('見出しは文書順で次の配下でないノードの前まで (配下の段落、リスト、コード) を消し、末尾の空行は残す', () => {
            expectRewritten(deleteNodes('# R\n## A\n段落\n- a1\n## B\n', [2, 'A']), '# R\n## B\n', [1, 'R']);
            expectRewritten(deleteNodes('# R\n## A\n\n段落\n\n~~~\nx\n~~~\n\n## B\n本文\n', [2, 'A']), '# R\n\n## B\n本文\n', [1, 'R']);
            expectRewritten(deleteNodes('# R\n## A\n### A1\n本文\n## B\n', [3, 'A1']), '# R\n## A\n## B\n', [2, 'A']);
            expectRewritten(deleteNodes('# R\n## A\n- x\n## B\n本文\n', [4, 'B']), '# R\n## A\n- x\n', [1, 'R']);
        });

        it('消したあとに続いた空行は 1 つにする', () => {
            expectRewritten(deleteNodes('# R\n\n## A\n\n段落\n\n## B\n', [2, 'A']), '# R\n\n## B\n', [1, 'R']);
            expectRewritten(deleteNodes('# R\n\n- a\n\n- b\n\n- c\n', [3, 'b']), '# R\n\n- a\n\n- c\n', [1, 'R']);
        });

        it('複数を 1 回で消す: 配下に含まれるノードと同じノードを重ねて渡しても 1 回だけ消え、選ぶのは文書順で最初に消したノードの親', () => {
            const source = '# R\n- a\n    - a1\n- b\n- c\n';
            expectRewritten(deleteNodes(source, [5, 'c'], [2, 'a']), '# R\n- b\n', [1, 'R']);
            expectRewritten(deleteNodes(source, [3, 'a1'], [2, 'a'], [2, 'a']), '# R\n- b\n- c\n', [1, 'R']);
            const twoParents = '# R\n## A\n- x\n- y\n## B\n- z\n';
            expectRewritten(deleteNodes(twoParents, [6, 'z'], [4, 'y']), '# R\n## A\n- x\n## B\n', [2, 'A']);
            expectRewritten(deleteNodes(twoParents, [5, 'B'], [3, 'x']), '# R\n## A\n- y\n', [2, 'A']);
        });

        it('親が行を持たないルートなら id 1 を選ぶ (A-17、B-21)', () => {
            expectRewritten(deleteNodes('---\ntitle: T\n---\n## A\n## B\n## C\n', [3, 'B']), '---\ntitle: T\n---\n## A\n## C\n', [1, 'T']);
            expectRewritten(deleteNodes('# A\n# B\n# C\n', [3, 'B']), '# A\n# C\n', [1, '']);
            expectRewritten(deleteNodes('# R\n- a\n    - a1\n    - a2\n', [4, 'a2']), '# R\n- a\n    - a1\n', [2, 'a']);
        });

        it('容器はリストの行の全体を消し、表とコードと画像は消せる', () => {
            expectRewritten(deleteNodes('# R\n\n- a\n- b\n\n1. c\n2. d\n\n- e\n- f\n', [2, '']), '# R\n\n1. c\n2. d\n\n- e\n- f\n', [1, 'R']);
            expectRewritten(deleteNodes(BLOCKS, [2, '']), `${MD}# R\n\n~~~js\nconst x = 1;\n~~~\n\n![img](x.png)\n`, [1, 'R']);
            expectRewritten(deleteNodes(BLOCKS, [3, '']), `${MD}# R\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![img](x.png)\n`, [1, 'R']);
            expectRewritten(deleteNodes(`${MD}# R\n\n![img](x.png)\n\n~~~js\nx\n~~~\n`, [2, '']), `${MD}# R\n\n~~~js\nx\n~~~\n`, [1, 'R']);
        });

        it('ルートは root で断る (ほかのノードと一緒に渡しても全体を断る)', () => {
            expect(deleteNodes('# R\n- a\n', [1, 'R'])).toEqual(refused('root'));
            expect(deleteNodes(LINELESS, [1, 'T'])).toEqual(refused('root'));
            expect(deleteNodes(LIST_ROOT, [1, ''])).toEqual(refused('root'));
            expect(deleteNodes('- a\n', [1, 'a'])).toEqual(refused('root'));
            expect(deleteNodes('# R\n- a\n', [2, 'a'], [1, 'R'])).toEqual(refused('root'));
        });

        it('容器がなくなって触らない項目の親が変わる削除と、ルートが置き換わる削除は structure-changed', () => {
            expect(nodeOf(NESTED_LISTS, 4).parent).toBe(2);
            expect(deleteNodes(NESTED_LISTS, [3, 'a'])).toEqual(refused('structure-changed'));
            expect(deleteNodes(NESTED_LISTS, [2, ''])).toEqual(refused('structure-changed'));
            expect(deleteNodes(LIST_ROOT, [2, 'a'])).toEqual(refused('structure-changed'));
            expect(deleteNodes(LIST_ROOT_TITLED, [2, '設計'])).toEqual(refused('structure-changed'));
            expect(deleteNodes('# A\n# B\n', [3, 'B'])).toEqual(refused('structure-changed'));
        });

        it('古い NodeTarget (どれか 1 つでも) は stale-node。単独の \\r は文書の最初の改行にそろえてから消す (D-064)', () => {
            const source = '# R\n- a\n- b\n';
            for (const nodes of [[[2, 'b']], [[99, 'a']], [[0, '']], [[2, 'a'], [3, 'x']], [[Number.NaN, 'a']], [[2.5, 'a']]] as Target[][]) {
                expect(deleteNodes(source, ...nodes), JSON.stringify(nodes)).toEqual(refused('stale-node'));
            }
            expect(deleteNodes(MARKED, [3, '**太字** と `code`'])).toEqual(refused('stale-node'));
            for (const [lone, after] of [
                ['# R\n- a\r- b\n- c\n', '# R\n- a\n- b\n'],
                ['# R\r\n- a\r- b\r\n- c\r\n', '# R\r\n- a\r\n- b\r\n'],
            ] as const) {
                expect(nodeOf(lone, 4).refText).toBe('c');
                expectRewritten(deleteNodes(lone, [4, 'c']), after, [1, 'R']);
            }
        });

        it('CRLF の文書は \\r を保ち、\\r だけの行も空行として詰める。改行で終わらない CRLF の文書の最後のブロックを消すと新しい最後の行の \\r を外す', () => {
            expectRewritten(deleteNodes('# R\r\n- a\r\n    - a1\r\n- b\r\n', [2, 'a']), '# R\r\n- b\r\n', [1, 'R']);
            expectRewritten(deleteNodes('# R\r\n\r\n## A\r\n\r\n段落\r\n\r\n## B\r\n', [2, 'A']), '# R\r\n\r\n## B\r\n', [1, 'R']);
            // 新しい最後の行の \r を外して改行で終わらない形を保つ。続けて書き換えても line-endings にならない
            const once = deleteNodes('# R\r\n- a\r\n- b', [3, 'b']);
            expectRewritten(once, '# R\r\n- a', [1, 'R']);
            expect(renamed(edited(once).source, 2, 'a', 'x')).toBe('# R\r\n- x');
            expectRewritten(deleteNodes(edited(once).source, [2, 'a']), '# R', [1, 'R']);
        });
    });

    describe('付け替え (B-055〜B-057)', () => {
        it('リストの項目を、子がリストの見出しの下へ移すと、配下と詳細が付いてきて字下げが合う。タスクは状態を保つ', () => {
            const withDetails = moveNode('# R\n## A\n- x\n## B\n- y\n    > 詳細\n    - y1\n        - y2\n', [5, 'y'], [2, 'A']);
            const after = '# R\n## A\n- x\n- y\n    > 詳細\n    - y1\n        - y2\n## B\n';
            expectMoved(withDetails, after, [4, 'y'], 2);
            expect(detailsOf(after, 4, 'y')).toBe('詳細');
            expect(nodeOf(after, 6).parent).toBe(5);
            // 2 行目以降は、元の 1 行目の内容の桁からの相対の字下げを保つ
            const outdented = moveNode('# R\n## A\n- x\n## B\n- y\n    - y1\n        > y1 の詳細\n        - y2\n', [6, 'y1'], [2, 'A']);
            const outdentedAfter = '# R\n## A\n- x\n- y1\n    > y1 の詳細\n    - y2\n## B\n- y\n';
            expectMoved(outdented, outdentedAfter, [4, 'y1'], 2);
            expect(detailsOf(outdentedAfter, 4, 'y1')).toBe('y1 の詳細');
            expect(nodeOf(outdentedAfter, 5).parent).toBe(4);
            expectMoved(moveNode('# R\n## A\n- x\n## B\n- [/] y\n', [5, 'y'], [2, 'A']), '# R\n## A\n- x\n- [/] y\n## B\n', [4, 'y'], 2);
        });

        it('項目の下へは入れ子の項目 (前へも後ろへも)、祖先の見出しへ上げる、深くすると詳細と子も同じだけ字下げする', () => {
            expectMoved(moveNode('# R\n- a\n- b\n', [2, 'a'], [3, 'b']), '# R\n- b\n    - a\n', [3, 'a'], 2);
            expectMoved(moveNode('# R\n- a\n- b\n', [3, 'b'], [2, 'a']), '# R\n- a\n    - b\n', [3, 'b'], 2);
            expectMoved(moveNode('# R\n## B\n- y\n    - y1\n', [4, 'y1'], [2, 'B']), '# R\n## B\n- y\n- y1\n', [4, 'y1'], 2);
            const deeper = '# R\n- a\n    - a1\n        - b\n            > b の詳細\n            - b1\n';
            expectMoved(moveNode('# R\n- a\n    - a1\n- b\n    > b の詳細\n    - b1\n', [4, 'b'], [3, 'a1']), deeper, [4, 'b'], 3);
            expect(detailsOf(deeper, 4, 'b')).toBe('b の詳細');
            expect(nodeOf(deeper, 5).parent).toBe(4);
        });

        it('番号付き: 番号付きのリストへは最後の番号 + 1 (区切りを保つ)、番号付きの項目は移す先の形になり、残った番号は振り直す', () => {
            expectMoved(moveNode('# R\n## A\n1. a\n2. b\n## B\n- y\n', [6, 'y'], [2, 'A']), '# R\n## A\n1. a\n2. b\n3. y\n## B\n', [5, '3. y'], 2);
            expectMoved(moveNode('# R\n## A\n1) a\n2) b\n## B\n- y\n', [6, 'y'], [2, 'A']), '# R\n## A\n1) a\n2) b\n3) y\n## B\n', [5, '3. y'], 2);
            const fromNumbered = '# R\n## A\n- x\n- b\n## B\n1. a\n2. c\n';
            expectMoved(moveNode('# R\n## A\n- x\n## B\n1. a\n2. b\n3. c\n', [6, '2. b'], [2, 'A']), fromNumbered, [4, 'b'], 2);
            expect(nodeOf(fromNumbered, 7).refText).toBe('2. c');
            expectMoved(moveNode('# R\n1. a\n2. b\n', [3, '2. b'], [2, '1. a']), '# R\n1. a\n    - b\n', [3, 'b'], 2);
        });

        it('詳細だけを持つ項目を、子のない見出しか最後の子が見出しの見出しの下へ移すと、### y と見出しの詳細 > 詳細 に書く。続きの段落を持つ項目は heading-details (A-08、B-10、D-078)', () => {
            expectMoved(moveNode('# R\n## A\n## B\n- y\n    > 詳細\n', [4, 'y'], [2, 'A']), '# R\n## A\n\n### y\n> 詳細\n\n## B\n', [3, 'y'], 2);
            const marked = `${MD}# R\n## A\n\n### y\n> 詳細\n\n## B\n`;
            expectMoved(moveNode(`${MD}# R\n## A\n## B\n- y\n    > 詳細\n`, [4, 'y'], [2, 'A']), marked, [3, 'y'], 2);
            expect(detailsOf(marked, 3, 'y')).toBe('詳細');
            for (const source of ['# R\n## A\n### A1\n## B\n- y\n\n  続き\n', '# R\n## A\n### A1\n## B\n- y\n  続き\n']) {
                expect(nodeOf(source, 5).refText).toBe('y');
                expect(moveNode(source, [5, 'y'], [2, 'A']), source).toEqual(refused('heading-details'));
            }
        });

        it('詳細も続きもない項目は見出しになる (段は移す先 + 1、前後に空行をはさむ)', () => {
            const after = '# R\n## A\n\n### y\n\n## B\n- z\n';
            expectMoved(moveNode('# R\n## A\n## B\n- y\n- z\n', [4, 'y'], [2, 'A']), after, [3, 'y'], 2);
            expect(core.inspectNode(after, { id: 3, refText: 'y' })?.kind).toBe('heading');
            expectMoved(moveNode('# R\n## A\n### A1\n## B\n- y\n- z\n', [5, 'y'], [2, 'A']), '# R\n## A\n### A1\n\n### y\n\n## B\n- z\n', [4, 'y'], 2);
        });

        it('見出しをリストの項目の下へ移すと、配下の見出しも入れ子の項目、段落は続きの行、すぐ下の引用は詳細になる', () => {
            const poc = '# Root\n## A\n- x\n    > 詳細\n- y\n    - B\n        - C\n';
            expectMoved(moveNode('# Root\n## A\n- x\n    > 詳細\n- y\n## B\n### C\n', [5, 'B'], [4, 'y']), poc, [5, 'B'], 4);
            expect(nodeOf(poc, 6).parent).toBe(5);
            const paragraphs = '# R\n## A\n- y\n    - B\n\n      本文\n\n        - C\n\n          C の本文\n';
            expectMoved(moveNode('# R\n## A\n- y\n## B\n\n本文\n\n### C\n\nC の本文\n', [4, 'B'], [3, 'y']), paragraphs, [4, 'B'], 3);
            expect(core.parseDocument(paragraphs).nodes.map((node) => [node.id, node.parent, node.refText])).toEqual([
                [1, null, 'R'],
                [2, 1, 'A'],
                [3, 2, 'y'],
                [4, 3, 'B'],
                [5, 4, 'C'],
            ]);
            const quoted = `${MD}# R\n## A\n- y\n    - B\n      > 引用\n`;
            expectMoved(moveNode(`${MD}# R\n## A\n- y\n## B\n> 引用\n`, [4, 'B'], [3, 'y']), quoted, [4, 'B'], 3);
            expect(detailsOf(quoted, 4, 'B')).toBe('引用');
            // 移す先が見出しでも、最後の子が項目ならリストで書く
            expectMoved(moveNode('# R\n## A\n- x\n## C\n', [4, 'C'], [2, 'A']), '# R\n## A\n- x\n- C\n', [4, 'C'], 2);
        });

        it('見出しを見出しの下へ移すと段をずらし、7 段以上になる配下はリストになる。下線の見出しは ATX で書いて下線の行を消す (A-24)', () => {
            const overflow = '# R\n## Q\n### Q1\n#### Q2\n\n##### P\n###### P1\n- P2\n    - P3\n';
            expectMoved(moveNode('# R\n## P\n### P1\n#### P2\n##### P3\n## Q\n### Q1\n#### Q2\n', [2, 'P'], [8, 'Q2']), overflow, [5, 'P'], 4);
            expect(core.parseDocument(overflow).nodes.slice(5).map((node) => [node.id, node.parent, node.refText])).toEqual([
                [6, 5, 'P1'],
                [7, 6, 'P2'],
                [8, 7, 'P3'],
            ]);
            const raised = '# R\n## A\n## B\n\n## A1\n### A11\n本文\n';
            expectMoved(moveNode('# R\n## A\n### A1\n#### A11\n本文\n## B\n', [3, 'A1'], [1, 'R']), raised, [4, 'A1'], 1);
            expect(nodeOf(raised, 5).parent).toBe(4);
            const setext = '# R\n## A\n\n### 設計\n- 画面\n';
            expectMoved(moveNode('# R\n## A\n設計\n----\n- 画面\n', [3, '設計'], [2, 'A']), setext, [3, '設計'], 2);
            expect(nodeOf(setext, 4).parent).toBe(3);
        });

        it('断る: 自分と配下へは move-into-self、ルートは root、容器は no-source-line、表とコードと画像は項目の下へも子にするのも block-node', () => {
            expect(moveNode(MOVES, [4, 'B'], [4, 'B'])).toEqual(refused('move-into-self'));
            expect(moveNode(MOVES, [4, 'B'], [5, 'C'])).toEqual(refused('move-into-self'));
            expect(moveNode(MOVES, [1, 'R'], [3, 'x'])).toEqual(refused('root'));
            expect(moveNode(LINELESS, [1, 'T'], [2, 'a'])).toEqual(refused('root'));
            expect(moveNode(LIST_ROOT, [1, ''], [2, 'a'])).toEqual(refused('root'));
            expect(moveNode(NESTED_LISTS, [2, ''], [7, '2. d'])).toEqual(refused('no-source-line'));
            expect(moveNode(NESTED_LISTS, [5, ''], [3, 'a'])).toEqual(refused('no-source-line'));
            for (const block of ['| a | b |\n| - | - |\n| 1 | 2 |', '~~~js\nx\n~~~', '![img](x.png)']) {
                const source = `# R\n## A\n- x\n## B\n\n${block}\n`;
                expect(nodeOf(source, 5).parent, source).toBe(4);
                expect(moveNode(source, [5, ''], [3, 'x']), source).toEqual(refused('block-node'));
                expect(moveNode(source, [3, 'x'], [5, '']), source).toEqual(refused('block-node'));
            }
        });

        it('すでにその親の子なら unchanged (already-child)', () => {
            expect(moveNode(MOVES, [3, 'x'], [2, 'A'])).toEqual(unchanged('already-child'));
            expect(moveNode(MOVES, [5, 'C'], [4, 'B'])).toEqual(unchanged('already-child'));
            expect(moveNode(MOVES, [2, 'A'], [1, 'R'])).toEqual(unchanged('already-child'));
        });

        it('古い NodeTarget (動かすノードか移す先) は stale-node。単独の \\r は文書の最初の改行にそろえてから動かす (D-064)', () => {
            expect(moveNode(MOVES, [3, 'y'], [2, 'A'])).toEqual(refused('stale-node'));
            expect(moveNode(MOVES, [3, 'x'], [99, 'A'])).toEqual(refused('stale-node'));
            expect(moveNode(MOVES, [3, 'x'], [4, 'A'])).toEqual(refused('stale-node'));
            expect(moveNode(MOVES, [Number.NaN, 'x'], [2, 'A'])).toEqual(refused('stale-node'));
            for (const [lone, after] of [
                ['# R\n- a\r- b\n- c\n', '# R\n- a\n    - c\n- b\n'],
                ['# R\r\n- a\r- b\r\n- c\r\n', '# R\r\n- a\r\n    - c\r\n- b\r\n'],
            ] as const) {
                expectMoved(moveNode(lone, [4, 'c'], [2, 'a']), after, [3, 'c'], 2);
            }
        });

        it('タブで字下げした文書: 書き直す行の字下げは 4 桁ごとのタブと残りの空白で、行の中身のタブは変えない (A-25)', () => {
            const after = `${MD}- x\n100. a\n\t - y\n\t\t > 詳細\tタブ\n`;
            expectMoved(moveNode(`${MD}- x\n\t- y\n\t\t> 詳細\tタブ\n100. a\n`, [3, 'y'], [4, '100. a']), after, [4, 'y'], 3);
            expect(detailsOf(after, 4, 'y')).toBe('詳細\tタブ');
        });

        it('CRLF の文書は書き直す行とはさむ空行に \\r を付け、改行で終わらない文書の末尾へ移すときも最後のブロックを動かすときも単独の \\r を作らない', () => {
            expectMoved(moveNode('# R\r\n## A\r\n- x\r\n## B\r\n- y\r\n    > 詳細\r\n', [5, 'y'], [2, 'A']), '# R\r\n## A\r\n- x\r\n- y\r\n    > 詳細\r\n## B\r\n', [4, 'y'], 2);
            expectMoved(moveNode('# R\r\n## A\r\n## B\r\n- y\r\n- z\r\n', [4, 'y'], [2, 'A']), '# R\r\n## A\r\n\r\n### y\r\n\r\n## B\r\n- z\r\n', [3, 'y'], 2);
            // 末尾へ移す: 前の最後の行とはさむ空行に \r を付け、移した最後の行には付けない。子のない見出しの下なので x は見出しで書く
            expectMoved(moveNode('# R\r\n## A\r\n- x\r\n## B', [3, 'x'], [4, 'B']), '# R\r\n## A\r\n## B\r\n\r\n### x', [4, 'x'], 3);
            // 最後のブロックを動かすと、新しい最後の行の \r を外し、動かした行には \r を付ける
            const moved = moveNode('# R\r\n## A\r\n- x\r\n## B\r\n- y', [5, 'y'], [2, 'A']);
            expectMoved(moved, '# R\r\n## A\r\n- x\r\n- y\r\n## B', [4, 'y'], 2);
            // 続けて書き換えても line-endings にならない (最後の行の名前の変更、最後のブロックの削除)
            expect(renamed(edited(moved).source, 5, 'B', 'C')).toBe('# R\r\n## A\r\n- x\r\n- y\r\n## C');
            expectRewritten(deleteNodes(edited(moved).source, [5, 'B']), '# R\r\n## A\r\n- x\r\n- y', [1, 'R']);
        });
    });

    it('splice は書き換えた行だけを含む: 書き換えない行の対になっていないサロゲートが原文のまま残る', () => {
        const source = '# R\n- a\n- b \ud800 c\n- d\n';
        expectRewritten(deleteNodes(source, [2, 'a']), '# R\n- b \ud800 c\n- d\n', [1, 'R']);
        expectMoved(moveNode(source, [4, 'd'], [2, 'a']), '# R\n- a\n    - d\n- b \ud800 c\n', [3, 'd'], 2);
    });

    it('欄の型の違う deleteNodes と moveNode は MarkdagError (invalid-input)', () => {
        const source = '# R\n- a\n';
        const badOps: unknown[] = [
            { kind: 'deleteNodes' },
            { kind: 'deleteNodes', nodes: { id: 2, refText: 'a' } },
            { kind: 'deleteNodes', nodes: [{ id: 2 }] },
            { kind: 'moveNode', node: { id: 2, refText: 'a' } },
            { kind: 'moveNode', node: { id: 2, refText: 'a' }, parent: 'R' },
        ];
        for (const op of badOps) {
            const error = thrown(() => core.editSource(source, op as core.EditOp));
            expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
            expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
        }
    });
});

// ---- 詳細とタグの書き換え (setDetails、setTag、removeTag、toggleTag。詳細と 1 行目の印、markdag: を足す) ----
// 期待の文書は、比べる前に parseDocument と inspectNode と buildModel で詳細とタグ (解析のノードの details と tags、モデルの tagsOf) を
// 確かめ、指すノードは操作の前に原文の parseDocument で id と refText を確かめる (期待の書き誤りを、実装の前の赤の確認で見分けるため)

// 指すノードが、原文の解析でその id と refText を持つ
function expectTarget(source: string, [id, refText]: Target): void {
    expect(nodeOf(source, id).refText, `id ${id}: ${JSON.stringify(source)}`).toBe(refText);
}

const nodeTargets = (nodes: Target[]): core.NodeTarget[] => nodes.map(([id, refText]) => ({ id, refText }));

const setDetailsUnchecked = (source: string, [id, refText]: Target, text: string): core.EditOutcome =>
    core.editSource(source, { kind: 'setDetails', node: { id, refText }, text });
function setDetails(source: string, node: Target, text: string): core.EditOutcome {
    expectTarget(source, node);
    return setDetailsUnchecked(source, node, text);
}
const setTagUnchecked = (source: string, nodes: Target[], key: string, value: string | null, replaceKey: string | null = null): core.EditOutcome =>
    core.editSource(source, { kind: 'setTag', nodes: nodeTargets(nodes), key, value, replaceKey });
function setTag(source: string, nodes: Target[], key: string, value: string | null, replaceKey: string | null = null): core.EditOutcome {
    for (const node of nodes) expectTarget(source, node);
    return setTagUnchecked(source, nodes, key, value, replaceKey);
}
const removeTagUnchecked = (source: string, nodes: Target[], key: string): core.EditOutcome =>
    core.editSource(source, { kind: 'removeTag', nodes: nodeTargets(nodes), key });
function removeTag(source: string, nodes: Target[], key: string): core.EditOutcome {
    for (const node of nodes) expectTarget(source, node);
    return removeTagUnchecked(source, nodes, key);
}
const toggleTagUnchecked = (source: string, nodes: Target[], key: string, value: string | null): core.EditOutcome =>
    core.editSource(source, { kind: 'toggleTag', nodes: nodeTargets(nodes), key, value });
function toggleTag(source: string, nodes: Target[], key: string, value: string | null): core.EditOutcome {
    for (const node of nodes) expectTarget(source, node);
    return toggleTagUnchecked(source, nodes, key, value);
}

function modelOf(source: string): core.GraphModel {
    const parsed = core.parseDocument(source);
    return core.buildModel(parsed.nodes, parsed.frontmatter, source);
}

// 期待の文書で、そのノードの詳細がこれ (inspectNode の details。なければ null) で、解析のノードの details (HTML) にもあるか
function expectDetailsIn(source: string, [id, refText]: Target, details: string | null): void {
    const where = JSON.stringify(source);
    expect(detailsOf(source, id, refText), where).toBe(details);
    const html = nodeOf(source, id).details;
    if (details === null) {
        expect(html, where).toBeNull();
        return;
    }
    expect(html, where).not.toBeNull();
    // 記法を含まない行は、HTML にもその字のまま入る
    for (const line of details.split('\n').filter((item) => /^[\p{L}\p{N} ]+$/u.test(item))) expect(html, where).toContain(line);
}

type TagRow = [string, string[]];

// 期待の文書で、そのノードのタグが解析 (OutlineNode.tags) とモデルの tagsOf の両方でこれで、タグの診断 (tag-) がない
function expectTagsIn(source: string, id: number, tags: TagRow[]): void {
    const where = JSON.stringify(source);
    expect(
        nodeOf(source, id).tags.map((tag): TagRow => [tag.key, tag.values]),
        where,
    ).toEqual(tags);
    const model = modelOf(source);
    expect((model.tagsOf.get(id) ?? []).map((tag): TagRow => [tag.key, tag.values]), where).toEqual(tags);
    expect(model.diagnostics.filter((item) => item.code.startsWith('tag-')).map((item) => `${item.code}: ${item.message}`), where).toEqual([]);
}

const nodesSelected = (nodes: Target[]): core.EditSelection => ({ kind: 'nodes', nodes: nodeTargets(nodes) });

// 書き換えた結果: 原文の全体、select が同じノード (書き換えたあとの原文を parseDocument した id と refText)、rename は null。
// notes は呼ぶ側が見る
function expectNodesRewritten(outcome: core.EditOutcome, after: string, nodes: Target[]): Edited {
    const result = edited(outcome);
    expect(result.source).toBe(after);
    expect(result.select).toEqual(nodesSelected(nodes));
    expect(result.rename).toBeNull();
    expectSelectMatchesReparse(outcome);
    return result;
}

// markdag キーのある文書の書き換え: 結果の全体 (notes は空)
function expectSameNodes(outcome: core.EditOutcome, after: string, nodes: Target[]): void {
    expect(outcome).toEqual({ status: 'edited', source: after, select: nodesSelected(nodes), rename: null, notes: [] });
    expectSelectMatchesReparse(outcome);
}

// 詳細を書いた結果: 期待の文書の詳細を先に確かめてから、書き換える (markdag キーのある文書なので notes は空)
function expectDetailsSet(source: string, node: Target, text: string, after: string, details: string | null): void {
    expectDetailsIn(after, node, details);
    expectSameNodes(setDetails(source, node, text), after, [node]);
}

function noteCodes(outcome: Edited): core.EditNoteCode[] {
    for (const note of outcome.notes) expect(note.message, JSON.stringify(outcome)).toMatch(/\S/);
    return outcome.notes.map((note) => note.code).sort();
}

const noteOf = (outcome: Edited, code: core.EditNoteCode): core.EditNote | undefined => outcome.notes.find((note) => note.code === code);

// markdag キーのない文書で、末尾の印に読める名前のノード (API #draft、画面 %ui) が 2 つ。数字だけの #12 は印に読まれない
const UNEXTRACTED = '---\ntitle: T\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n- b\n';
// markdag.tags.keys に、値を 1 つしか持てない priority と、複数の値を持てる owner の定義がある
const TAG_KEYS = '---\nmarkdag:\n    tags:\n        keys:\n            priority:\n                type: enum\n                values: [high, low]\n            owner:\n                type: string\n                multiple: true\n---\n';
const CRLF_MD = '---\r\nmarkdag:\r\n---\r\n';
// 前後の空白と先頭の # を 1 つ外したあとに空になるキー (書けないのはこれだけ)
const INVALID_KEYS = ['', ' ', '#', ' # '];
// 空白、:、#、%、$、"、, を含むキーと、書く印 (値 v)。" で囲み、囲みの中の " は \" と逃がす (B-134)
const QUOTED_KEYS: Array<[string, string]> = [
    ['a b', '#"a b":v'],
    ['a\tb', '#"a\tb":v'],
    ['a:b', '#"a:b":v'],
    ['a#b', '#"a#b":v'],
    ['a%b', '#"a%b":v'],
    ['a$b', '#"a$b":v'],
    ['a"b', '#"a\\"b":v'],
    ['a,b', '#"a,b":v'],
];

describe('editSource の setDetails、setTag、removeTag、toggleTag (GUI 編集の段 8: 詳細とタグの書き換え)', () => {
    it('型: setDetails、setTag、removeTag、toggleTag の op の形', () => {
        expectTypeOf<Extract<core.EditOp, { kind: 'setDetails' }>>().toEqualTypeOf<{ kind: 'setDetails'; node: core.NodeTarget; text: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'setTag' }>>().toEqualTypeOf<{
            kind: 'setTag';
            nodes: core.NodeTarget[];
            key: string;
            value: string | null;
            replaceKey: string | null;
        }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'removeTag' }>>().toEqualTypeOf<{ kind: 'removeTag'; nodes: core.NodeTarget[]; key: string }>();
        expectTypeOf<Extract<core.EditOp, { kind: 'toggleTag' }>>().toEqualTypeOf<{ kind: 'toggleTag'; nodes: core.NodeTarget[]; key: string; value: string | null }>();
    });

    describe('詳細を読み、書き換える (B-118、B-121、B-19)', () => {
        it('書いてある詳細を > を外して読み、引用の行を置き換える。複数行は行ごとに >、空の行は > だけ', () => {
            const source = `${MD}# R\n- a\n    > 古い詳細\n    - c\n- b\n`;
            expectDetailsIn(source, [2, 'a'], '古い詳細');
            expectDetailsSet(source, [2, 'a'], '新しい詳細', `${MD}# R\n- a\n    > 新しい詳細\n    - c\n- b\n`, '新しい詳細');
            expectDetailsSet(source, [2, 'a'], '1 行目\n\n**3** 行目', `${MD}# R\n- a\n    > 1 行目\n    >\n    > **3** 行目\n    - c\n- b\n`, '1 行目\n\n**3** 行目');
            // 複数行の詳細を 1 行に置き換える
            const multi = `${MD}# R\n- a\n    > 1 行目\n    >\n    > 3 行目\n    - c\n`;
            expectDetailsIn(multi, [2, 'a'], '1 行目\n\n3 行目');
            expectDetailsSet(multi, [2, 'a'], '1 行', `${MD}# R\n- a\n    > 1 行\n    - c\n`, '1 行');
            // 1 行目と詳細の間の空行は残し、引用の行だけを置き換える
            const loose = `${MD}# R\n- a\n\n    > 古い\n    - c\n`;
            expectDetailsIn(loose, [2, 'a'], '古い');
            expectDetailsSet(loose, [2, 'a'], '新しい', `${MD}# R\n- a\n\n    > 新しい\n    - c\n`, '新しい');
        });

        it('入力の \\r\\n、\\r、\\n、U+2028、U+2029 はどれも行の区切り', () => {
            const source = `${MD}# R\n- a\n`;
            expectDetailsSet(source, [2, 'a'], 'u\r\nv\rw\nx y z', `${MD}# R\n- a\n    > u\n    > v\n    > w\n    > x\n    > y\n    > z\n`, 'u\nv\nw\nx\ny\nz');
            for (const text of ['x\r\n\r\ny', 'x\r\ry', 'x  y']) {
                expectDetailsSet(source, [2, 'a'], text, `${MD}# R\n- a\n    > x\n    >\n    > y\n`, 'x\n\ny');
            }
        });

        it('書く行が今の詳細の行と同じなら nothing-to-change で変えない (改行の種類の違い、詳細のないノードを空にするのも)', () => {
            const source = `${MD}# R\n- a\n    > x\n    >\n    > y\n- b\n`;
            expectDetailsIn(source, [2, 'a'], 'x\n\ny');
            expect(setDetails(source, [2, 'a'], 'x\n\ny')).toEqual(unchanged('nothing-to-change'));
            expect(setDetails(source, [2, 'a'], 'x\r\n\r\ny')).toEqual(unchanged('nothing-to-change'));
            expect(setDetails(source, [3, 'b'], '')).toEqual(unchanged('nothing-to-change'));
        });
    });

    describe('詳細を足す位置と外し方 (B-122、B-123)', () => {
        it('詳細がなければ 1 行目 (と続く同じ段落の行) のあと、最初の子の前に足す', () => {
            const source = `${MD}# R\n- a\n    - c\n- b\n`;
            expectDetailsSet(source, [2, 'a'], 'd', `${MD}# R\n- a\n    > d\n    - c\n- b\n`, 'd');
            expectDetailsSet(source, [4, 'b'], 'd', `${MD}# R\n- a\n    - c\n- b\n    > d\n`, 'd');
            expectDetailsSet(`${MD}# R\n- a\n    - b\n        - c\n`, [3, 'b'], 'd', `${MD}# R\n- a\n    - b\n        > d\n        - c\n`, 'd');
            // タスクの記号と末尾の印のある 1 行目は変えない
            const marked = `${MD}# R\n- [ ] a #k %g $id\n    > d\n- b\n`;
            expectTagsIn(marked, 2, [['k', []]]);
            expectDetailsSet(`${MD}# R\n- [ ] a #k %g $id\n- b\n`, [2, 'a'], 'd', marked, 'd');
            // 1 行目に続く同じ段落の行のあと
            expectDetailsSet(`${MD}# R\n- a\n  続き\n    - c\n`, [2, 'a'], 'd', `${MD}# R\n- a\n  続き\n    > d\n    - c\n`, 'd');
            // 1 行目と最初の子の間に空行があっても 1 行目のすぐあと (空行は子の前に残る)
            expectDetailsSet(`${MD}# R\n- a\n\n    - c\n`, [2, 'a'], 'd', `${MD}# R\n- a\n    > d\n\n    - c\n`, 'd');
            // 改行で終わらない文書は終わらないまま
            expectDetailsSet(`${MD}# R\n- a`, [2, 'a'], 'd', `${MD}# R\n- a\n    > d`, 'd');
        });

        it('引用の行の字下げは子の項目の字下げ (入れ子の差の最小、なければ 4、内容の桁より浅くしない)', () => {
            expectDetailsSet(`${MD}# R\n- x\n  - y\n`, [2, 'x'], 'd', `${MD}# R\n- x\n  > d\n  - y\n`, 'd');
            expectDetailsSet(`${MD}# R\n1. a\n2. b\n`, [2, '1. a'], 'd', `${MD}# R\n1. a\n    > d\n2. b\n`, 'd');
            expectDetailsSet(`${MD}# R\n100. a\n`, [2, '100. a'], 'd', `${MD}# R\n100. a\n     > d\n`, 'd');
        });

        it('空にすると引用の行を消す。改行で終わらない文書は終わらないまま', () => {
            expectDetailsSet(`${MD}# R\n- a\n    > x\n    >\n    > y\n    - c\n- b\n`, [2, 'a'], '', `${MD}# R\n- a\n    - c\n- b\n`, null);
            expectDetailsSet(`${MD}# R\n- a\n    > x`, [2, 'a'], '', `${MD}# R\n- a`, null);
        });
    });

    describe('詳細を書けないノード (B-124、A-01、B-02、3.1、3.2)', () => {
        it('見出しも詳細を持ち、見出しの行のすぐ次に字下げなしの > で書く (markdag キーのない文書は markdag: を足す。D-041)。行を持たないルートと容器は no-source-line、表とコードと画像は block-node', () => {
            const source = `${MD}# R\n## A\n- a\n`;
            expectDetailsSet(source, [1, 'R'], 'd', `${MD}# R\n> d\n\n## A\n- a\n`, 'd');
            expectDetailsSet(source, [2, 'A'], 'd', `${MD}# R\n## A\n> d\n\n- a\n`, 'd');
            expectDetailsSet(UNMARKABLE, [2, '設計'], 'd', `${MD}# R\n\n設計\n---\n> d\n\n- 画面\n\n ## 実装\n`, 'd');
            expectDetailsSet(UNMARKABLE, [4, '実装'], 'd', `${MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n> d\n`, 'd');
            const created = '---\nmarkdag:\n---\n\n# R\n## A\n> d\n';
            expectDetailsIn(created, [2, 'A'], 'd');
            expect(noteCodes(expectNodesRewritten(setDetails('# R\n## A\n', [2, 'A'], 'd'), created, [[2, 'A']]))).toContain('frontmatter-added');
            expect(setDetails(LINELESS, [1, 'T'], 'd')).toEqual(refused('no-source-line'));
            expect(setDetails(LIST_ROOT_TITLED, [1, '手順'], 'd')).toEqual(refused('no-source-line'));
            expect(setDetails(LIST_ROOT, [1, ''], 'd')).toEqual(refused('no-source-line'));
            for (const id of [2, 5]) expect(setDetails(NESTED_LISTS, [id, ''], 'd')).toEqual(refused('no-source-line'));
            for (const id of [2, 3, 4]) expect(setDetails(BLOCKS, [id, ''], 'd')).toEqual(refused('block-node'));
        });

        it('古い NodeTarget は stale-node。単独の \\r を含む文書は、文書の最初の改行にそろえてから書く (D-064)', () => {
            const source = `${MD}# R\n- a\n- b\n`;
            expect(setDetailsUnchecked(source, [2, 'b'], 'd')).toEqual(refused('stale-node'));
            expect(setDetailsUnchecked(source, [99, 'a'], 'd')).toEqual(refused('stale-node'));
            expect(setDetailsUnchecked(source, [Number.NaN, 'a'], 'd')).toEqual(refused('stale-node'));
            expect(setDetailsUnchecked(MARKED, [3, '**太字** と `code`'], 'd')).toEqual(refused('stale-node'));
            for (const [lone, after] of [
                ['# R\n- a\r- b\n', '---\nmarkdag:\n---\n\n# R\n- a\n    > d\n- b\n'],
                ['# R\r\n- a\r- b\r\n', '---\r\nmarkdag:\r\n---\r\n\r\n# R\r\n- a\r\n    > d\r\n- b\r\n'],
            ] as const) {
                expectDetailsIn(after, [2, 'a'], 'd');
                expect(noteCodes(expectNodesRewritten(setDetails(lone, [2, 'a'], 'd'), after, [[2, 'a']]))).toContain('frontmatter-added');
            }
        });
    });

    describe('詳細の markdag: を足す (B-125、A-12、design.md 4.3)', () => {
        it('markdag キーのない frontmatter には markdag: を足し (markdag-added)、frontmatter がなければ作る (frontmatter-added)', () => {
            const titled = '---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n';
            expectDetailsIn(titled, [2, 'a'], 'd');
            let outcome = expectNodesRewritten(setDetails('---\ntitle: T\n---\n# R\n- a\n', [2, 'a'], 'd'), titled, [[2, 'a']]);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
            outcome = expectNodesRewritten(setDetails('---\n---\n# R\n- a\n', [2, 'a'], 'd'), '---\nmarkdag:\n---\n# R\n- a\n    > d\n', [[2, 'a']]);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
            const created = '---\nmarkdag:\n---\n\n# R\n- a\n    > d\n';
            expectDetailsIn(created, [2, 'a'], 'd');
            outcome = expectNodesRewritten(setDetails('# R\n- a\n', [2, 'a'], 'd'), created, [[2, 'a']]);
            expect(noteCodes(outcome)).toContain('frontmatter-added');
        });

        it('名前の読み方が変わるノードの数 (API #draft と 画面 %ui の 2) を markdag-added の message に添え、選ぶのは書き換えたあとのノード', () => {
            const after = '---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft\n    > d\n- 画面 %ui\n- Issue #12\n- b\n';
            expectDetailsIn(after, [2, 'API'], 'd');
            expectTagsIn(after, 2, [['draft', []]]);
            let outcome = expectNodesRewritten(setDetails(UNEXTRACTED, [2, 'API #draft'], 'd'), after, [[2, 'API']]);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
            expect(noteOf(outcome, 'markdag-added')?.message).toContain('2');
            const afterB = '---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft\n- 画面 %ui\n- Issue #12\n- b\n    > d\n';
            expectDetailsIn(afterB, [5, 'b'], 'd');
            outcome = expectNodesRewritten(setDetails(UNEXTRACTED, [5, 'b'], 'd'), afterB, [[5, 'b']]);
            expect(noteOf(outcome, 'markdag-added')?.message).toContain('2');
        });

        it('先頭の BOM は外して frontmatter を作り (bom-removed)、BOM のすぐあとが --- の行の文書も BOM を外してその frontmatter に書く (D-069)', () => {
            const after = '---\nmarkdag:\n---\n\n# R\n- a\n    > d\n';
            expectDetailsIn(after, [2, 'a'], 'd');
            const outcome = expectNodesRewritten(setDetails('﻿# R\n- a\n', [2, 'a'], 'd'), after, [[2, 'a']]);
            expect(noteCodes(outcome)).toEqual(expect.arrayContaining(['bom-removed', 'frontmatter-added']));
            const titled = '---\ntitle: T\nmarkdag:\n---\n# R\n- a\n    > d\n';
            expectDetailsIn(titled, [2, 'a'], 'd');
            expect(noteCodes(expectNodesRewritten(setDetails('\u{feff}---\ntitle: T\n---\n# R\n- a\n', [2, 'a'], 'd'), titled, [[2, 'a']]))).toEqual(['bom-removed', 'markdag-added']);
        });
    });

    describe('詳細の CRLF とタブ', () => {
        it('CRLF の文書は足す行に \\r を付け、改行で終わらない文書では単独の \\r を作らない', () => {
            const source = `${CRLF_MD}# R\r\n- a\r\n    - c\r\n`;
            expectDetailsSet(source, [2, 'a'], 'x\ny', `${CRLF_MD}# R\r\n- a\r\n    > x\r\n    > y\r\n    - c\r\n`, 'x\ny');
            const written = `${CRLF_MD}# R\r\n- a\r\n    > 古い\r\n- b\r\n`;
            expectDetailsSet(written, [2, 'a'], '新しい', `${CRLF_MD}# R\r\n- a\r\n    > 新しい\r\n- b\r\n`, '新しい');
            expectDetailsSet(written, [2, 'a'], '', `${CRLF_MD}# R\r\n- a\r\n- b\r\n`, null);
            expectDetailsSet(`${CRLF_MD}# R\r\n- a`, [2, 'a'], 'x', `${CRLF_MD}# R\r\n- a\r\n    > x`, 'x');
            expectDetailsSet(`${CRLF_MD}# R\r\n- a\r\n    > x`, [2, 'a'], '', `${CRLF_MD}# R\r\n- a`, null);
            const titled = '---\r\ntitle: T\r\nmarkdag:\r\n---\r\n# R\r\n- a\r\n    > x\r\n';
            expectDetailsIn(titled, [2, 'a'], 'x');
            const outcome = expectNodesRewritten(setDetails('---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n', [2, 'a'], 'x'), titled, [[2, 'a']]);
            expect(noteCodes(outcome)).toEqual(['markdag-added']);
        });

        it('タブを使う文書は引用の行の字下げを 4 桁ごとのタブと残りの空白で書き、詳細の中のタブは字のまま (B-22、A-25)', () => {
            expectDetailsSet(TABBED, [3, 'y'], 'd', `${MD}- x\n\t- y\n\t\t> d\n100. a\n`, 'd');
            expectDetailsSet(TABBED, [2, 'x'], 'd', `${MD}- x\n\t> d\n\t- y\n100. a\n`, 'd');
            expectDetailsSet(TABBED, [4, '100. a'], 'd', `${MD}- x\n\t- y\n100. a\n\t > d\n`, 'd');
            expectDetailsSet(`${MD}- x\n\t- y\n\t\t> 古い\n100. a\n`, [3, 'y'], 'a\tb', `${MD}- x\n\t- y\n\t\t> a\tb\n100. a\n`, 'a\tb');
        });
    });

    describe('タグを付ける (B-135、B-136)', () => {
        it('既存の印の並びの末尾に空白 1 つで足し、%、$ の印とタスクの記号は残す (見出し、ルート、番号付き、タブの字下げの項目も)', () => {
            const after = `${MD}# R\n- a #k:v\n`;
            expectTagsIn(after, 2, [['k', ['v']]]);
            expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', 'v'), after, [[2, 'a']]);
            const marked = `${MD}# R\n- [ ] a %g $id #k:v\n`;
            expectTagsIn(marked, 2, [['k', ['v']]]);
            expect(nodeOf(marked, 2)).toMatchObject({ groups: ['g'], refId: 'id', task: expect.anything() });
            expectSameNodes(setTag(`${MD}# R\n- [ ] a %g $id\n`, [[2, 'a']], 'k', 'v'), marked, [[2, 'a']]);
            const source = `${MD}# R\n## A %g\n1. b\n\t- c\n`;
            const cases: Array<[Target, number, string]> = [
                [[1, 'R'], 3, '# R #k:v'],
                [[2, 'A'], 4, '## A %g #k:v'],
                [[3, '1. b'], 5, '1. b #k:v'],
                [[4, 'c'], 6, '\t- c #k:v'],
            ];
            for (const [node, line, text] of cases) {
                const written = withLine(source, line, text);
                expectTagsIn(written, node[0], [['k', ['v']]]);
                expectSameNodes(setTag(source, [node], 'k', 'v'), written, [node]);
            }
            const issue = `${MD}# R\n- Issue #12 #k:v\n`;
            expectTagsIn(issue, 2, [['k', ['v']]]);
            expectSameNodes(setTag(`${MD}# R\n- Issue #12\n`, [[2, 'Issue #12']], 'k', 'v'), issue, [[2, 'Issue #12']]);
        });

        it('同じキーのタグはその位置で置き換える (値のないタグと複数の値も、見出しも)', () => {
            const after = `${MD}# R\n- a #x:1 #k:new %g $id\n`;
            expectTagsIn(after, 2, [['x', ['1']], ['k', ['new']]]);
            expectSameNodes(setTag(`${MD}# R\n- a #x:1 #k:old %g $id\n`, [[2, 'a']], 'k', 'new'), after, [[2, 'a']]);
            const cases: Array<[string, string | null, string, TagRow[]]> = [
                ['- a #k %g', 'v', '- a #k:v %g', [['k', ['v']]]],
                ['- a #k:v %g', null, '- a #k %g', [['k', []]]],
                ['- a #k:alice,bob %g', 'carol', '- a #k:carol %g', [['k', ['carol']]]],
            ];
            for (const [line, value, written, tags] of cases) {
                const expected = `${MD}# R\n${written}\n`;
                expectTagsIn(expected, 2, tags);
                expectSameNodes(setTag(`${MD}# R\n${line}\n`, [[2, 'a']], 'k', value), expected, [[2, 'a']]);
            }
            const heading = `${MD}# R\n## A #k:2\n`;
            expectTagsIn(heading, 2, [['k', ['2']]]);
            expectSameNodes(setTag(`${MD}# R\n## A #k:1\n`, [[2, 'A']], 'k', '2'), heading, [[2, 'A']]);
        });
    });

    describe('タグの書き方とキーの形 (B-134、B-140、B-19)', () => {
        it('値のないタグは #キー、空白 (タブ、全角の空白も) か , を含む値は "…" で囲む (formatTag と同じ)', () => {
            const cases: Array<[string | null, string, TagRow[]]> = [
                [null, '#flag', [['flag', []]]],
                ['a b', '#flag:"a b"', [['flag', ['a b']]]],
                ['a,b', '#flag:"a,b"', [['flag', ['a,b']]]],
                ['a\tb', '#flag:"a\tb"', [['flag', ['a\tb']]]],
                ['a　b', '#flag:"a　b"', [['flag', ['a　b']]]],
                ['2026-10-01', '#flag:2026-10-01', [['flag', ['2026-10-01']]]],
            ];
            for (const [value, mark, tags] of cases) {
                const after = `${MD}# R\n- a ${mark}\n`;
                expectTagsIn(after, 2, tags);
                expect(core.formatTag({ key: 'flag', values: value === null ? [] : [value] })).toBe(mark);
                expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'flag', value), after, [[2, 'a']]);
            }
        });

        it('値の改行 (\\r\\n、\\r、\\n、U+2028、U+2029) は空白 1 つ', () => {
            const after = `${MD}# R\n- a #k:"x y"\n`;
            expectTagsIn(after, 2, [['k', ['x y']]]);
            for (const value of ['x\r\ny', 'x\ry', 'x\ny', 'x y', 'x y']) expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', value), after, [[2, 'a']]);
            const three = `${MD}# R\n- a #k:"x y z"\n`;
            expectTagsIn(three, 2, [['k', ['x y z']]]);
            expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', 'x\r\ny\rz'), three, [[2, 'a']]);
        });

        it('キーの前後の空白と先頭の # を外す', () => {
            for (const key of [' k ', '#k', ' #k ', '\tk\t']) expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), `${MD}# R\n- a #k:v\n`, [[2, 'a']]);
        });

        it('外したあとに空のキーだけは tag-key-invalid。空白、:、#、%、$、"、, を含むキーは " で囲んで書く (setTag と toggleTag。D-074)', () => {
            for (const key of INVALID_KEYS) {
                expect(setTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), JSON.stringify(key)).toEqual(refused('tag-key-invalid'));
                expect(toggleTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), JSON.stringify(key)).toEqual(refused('tag-key-invalid'));
            }
            for (const [key, mark] of QUOTED_KEYS) {
                const after = `${MD}# R\n- a ${mark}\n`;
                expectTagsIn(after, 2, [[key, ['v']]]);
                expectSameNodes(setTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), after, [[2, 'a']]);
                expectSameNodes(toggleTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), after, [[2, 'a']]);
            }
        });
    });

    describe('キーを変える編集とタグを外す (B-138、B-139)', () => {
        it('キーを変える編集はもとのキーのタグを外し、もとのキーのないノードには足すだけ。replaceKey が同じキーなら値を置き換える', () => {
            const after = `${MD}# R\n- a %g #new:v\n- b #new:v\n`;
            expectTagsIn(after, 2, [['new', ['v']]]);
            expectTagsIn(after, 3, [['new', ['v']]]);
            expectSameNodes(setTag(`${MD}# R\n- a %g #old:v\n- b\n`, [[2, 'a'], [3, 'b']], 'new', 'v', 'old'), after, [[2, 'a'], [3, 'b']]);
            const same = `${MD}# R\n- a #k:2 %g\n`;
            expectTagsIn(same, 2, [['k', ['2']]]);
            expectSameNodes(setTag(`${MD}# R\n- a #k:1 %g\n`, [[2, 'a']], 'k', '2', 'k'), same, [[2, 'a']]);
        });

        it('removeTag はそのキーのタグを選んだノードから外し、ほかの印は空白 1 つの並びで残す。行末に空白を残さない', () => {
            const after = `${MD}# R\n- a #x:1 %g $id\n- b\n- c\n`;
            expectTagsIn(after, 2, [['x', ['1']]]);
            expectTagsIn(after, 3, []);
            const nodes: Target[] = [[2, 'a'], [3, 'b'], [4, 'c']];
            expectSameNodes(removeTag(`${MD}# R\n- a #x:1 #k:v %g $id\n- b #k\n- c\n`, nodes, 'k'), after, nodes);
            const cases: Array<[string, string]> = [
                ['- a #owner:alice,bob %g', '- a %g'],
                ['- a %g #owner:alice', '- a %g'],
                ['- [x] a #owner', '- [x] a'],
            ];
            for (const [line, written] of cases) {
                expectSameNodes(removeTag(`${MD}# R\n${line}\n`, [[2, 'a']], 'owner'), `${MD}# R\n${written}\n`, [[2, 'a']]);
            }
            expectSameNodes(removeTag(`${MD}# R\n## A #k:v\n`, [[2, 'A']], 'k'), `${MD}# R\n## A\n`, [[2, 'A']]);
        });

        it('どのノードにもそのキーがなければ nothing-to-change (markdag キーのない文書の末尾の #k は名前の一部)', () => {
            expect(removeTag(`${MD}# R\n- a #x:1\n- b\n`, [[2, 'a'], [3, 'b']], 'k')).toEqual(unchanged('nothing-to-change'));
            expect(removeTag('# R\n- a #k\n', [[2, 'a #k']], 'k')).toEqual(unchanged('nothing-to-change'));
        });
    });

    describe('一覧での付け外し (B-144〜B-146)', () => {
        it('全部に付いていれば外し、そうでなければ付いていないノードに足す (値のないタグも、空白を含む値は "…")', () => {
            const nodes: Target[] = [[2, 'a'], [3, 'b']];
            expectSameNodes(toggleTag(`${MD}# R\n- a\n- b\n`, nodes, 'k', 'v'), `${MD}# R\n- a #k:v\n- b #k:v\n`, nodes);
            const some = `${MD}# R\n- a #k:v %g\n- b #k:v\n`;
            expectTagsIn(some, 3, [['k', ['v']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a #k:v %g\n- b\n`, nodes, 'k', 'v'), some, nodes);
            const all = `${MD}# R\n- a %g\n- b #x:1\n`;
            expectTagsIn(all, 2, []);
            expectTagsIn(all, 3, [['x', ['1']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a #k:v %g\n- b #x:1 #k:v\n`, nodes, 'k', 'v'), all, nodes);
            expectSameNodes(toggleTag(`${MD}# R\n- a #done\n- b\n`, nodes, 'done', null), `${MD}# R\n- a #done\n- b #done\n`, nodes);
            expectSameNodes(toggleTag(`${MD}# R\n- a #done\n- b #done\n`, nodes, 'done', null), `${MD}# R\n- a\n- b\n`, nodes);
            const spaced = `${MD}# R\n- a #k:"x y"\n`;
            expectTagsIn(spaced, 2, [['k', ['x y']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', 'x y'), spaced, [[2, 'a']]);
        });

        it('同じキーに別の値があれば、定義がないか multiple: true のキーは , で足し、そうでなければ置き換える (B-145)', () => {
            const added = `${MD}# R\n- a #owner:alice,bob %g\n`;
            expectTagsIn(added, 2, [['owner', ['alice', 'bob']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a #owner:alice %g\n`, [[2, 'a']], 'owner', 'bob'), added, [[2, 'a']]);
            for (const key of ['owner', 'reviewer']) {
                const after = `${TAG_KEYS}# R\n- a #${key}:alice,bob\n`;
                expectTagsIn(after, 2, [[key, ['alice', 'bob']]]);
                expectSameNodes(toggleTag(`${TAG_KEYS}# R\n- a #${key}:alice\n`, [[2, 'a']], key, 'bob'), after, [[2, 'a']]);
            }
            const replaced = `${TAG_KEYS}# R\n- a #priority:low %g\n`;
            expectTagsIn(replaced, 2, [['priority', ['low']]]);
            expect(modelOf(replaced).tagKeys.map(({ key, multiple }) => [key, multiple])).toEqual([
                ['priority', false],
                ['owner', true],
            ]);
            expectSameNodes(toggleTag(`${TAG_KEYS}# R\n- a #priority:high %g\n`, [[2, 'a']], 'priority', 'low'), replaced, [[2, 'a']]);
            // 一部のノードにだけその値があるときは、ないノードに足す (もうあるノードは変えない)
            const nodes: Target[] = [[2, 'a'], [3, 'b']];
            const many = `${MD}# R\n- a #owner:alice,bob\n- b #owner:carol,alice\n`;
            expectTagsIn(many, 3, [['owner', ['carol', 'alice']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a #owner:alice,bob\n- b #owner:carol\n`, nodes, 'owner', 'alice'), many, nodes);
            const single = `${TAG_KEYS}# R\n- a #priority:low\n- b #priority:low\n`;
            expectTagsIn(single, 3, [['priority', ['low']]]);
            expectSameNodes(toggleTag(`${TAG_KEYS}# R\n- a #priority:low\n- b #priority:high\n`, nodes, 'priority', 'low'), single, nodes);
        });

        it('全部にその値があれば外し、値がほかにもあればその値だけ、なくなればキーごと外す (B-146)', () => {
            const nodes: Target[] = [[2, 'a'], [3, 'b']];
            const after = `${MD}# R\n- a #owner:bob %g\n- b\n`;
            expectTagsIn(after, 2, [['owner', ['bob']]]);
            expectTagsIn(after, 3, []);
            expectSameNodes(toggleTag(`${MD}# R\n- a #owner:alice,bob %g\n- b #owner:alice\n`, nodes, 'owner', 'alice'), after, nodes);
            const middle = `${MD}# R\n- a #owner:alice,carol\n`;
            expectTagsIn(middle, 2, [['owner', ['alice', 'carol']]]);
            expectSameNodes(toggleTag(`${MD}# R\n- a #owner:alice,bob,carol\n`, [[2, 'a']], 'owner', 'bob'), middle, [[2, 'a']]);
        });
    });

    describe('複数のノードと、印を書けないノード (B-004、B-05、A-01、B-02、3.1、3.2)', () => {
        it('選んだノードの全部に 1 回の書き換えで付け、外し、付け外しし、select は同じノード', () => {
            const source = `${MD}# R\n## A\n- [ ] a %g\n- b\n`;
            const after = `${MD}# R #k:v\n## A #k:v\n- [ ] a %g #k:v\n- b #k:v\n`;
            const nodes: Target[] = [[1, 'R'], [2, 'A'], [3, 'a'], [4, 'b']];
            for (const [id] of nodes) expectTagsIn(after, id, [['k', ['v']]]);
            expectSameNodes(setTag(source, nodes, 'k', 'v'), after, nodes);
            expectSameNodes(removeTag(after, nodes, 'k'), source, nodes);
            expectSameNodes(toggleTag(after, nodes, 'k', 'v'), source, nodes);
        });

        it('下線の見出しと行頭に空白のある ATX の見出しは、同じ段の ATX の見出しに書き直してから印を書く。removeTag は印を書かないので見出しを書き直さない (D-047)', () => {
            const tagged = `${MD}# R\n\n設計\n---\n\n- 画面 #k\n\n ## 実装\n`;
            for (const [nodes, after] of [
                [
                    [
                        [2, '設計'],
                        [3, '画面'],
                    ],
                    `${MD}# R\n\n## 設計 #k:v\n\n- 画面 #k:v\n\n ## 実装\n`,
                ],
                [
                    [
                        [3, '画面'],
                        [4, '実装'],
                    ],
                    `${MD}# R\n\n設計\n---\n\n- 画面 #k:v\n\n## 実装 #k:v\n`,
                ],
            ] as Array<[Target[], string]>) {
                for (const [id] of nodes) expectTagsIn(after, id, [['k', ['v']]]);
                expectSameNodes(setTag(UNMARKABLE, nodes, 'k', 'v'), after, nodes);
                expectSameNodes(toggleTag(UNMARKABLE, nodes, 'k', 'v'), after, nodes);
                expectSameNodes(removeTag(tagged, nodes, 'k'), `${MD}# R\n\n設計\n---\n\n- 画面\n\n ## 実装\n`, nodes);
            }
        });

        it('行を持たないルートと容器を含めると no-source-line、表とコードと画像を含めると block-node (外す操作も)', () => {
            const nested = `${MD}# R\n\n- a\n- b #k\n\n1. c\n2. d #k\n`;
            const cases: Array<[string, Target[]]> = [
                ['---\ntitle: T\nmarkdag:\n---\n- a #k\n\n1. b\n', [[2, 'a'], [1, 'T']]],
                ['---\ntitle: 手順\nmarkdag:\n---\n- 設計\n- 実装 #k\n', [[3, '実装'], [1, '手順']]],
                [nested, [[4, 'b'], [2, '']]],
                [nested, [[7, '2. d'], [5, '']]],
            ];
            for (const [source, nodes] of cases) {
                expect(setTag(source, nodes, 'k', 'v')).toEqual(refused('no-source-line'));
                expect(toggleTag(source, nodes, 'k', 'v')).toEqual(refused('no-source-line'));
                expect(removeTag(source, nodes, 'k')).toEqual(refused('no-source-line'));
            }
            const blocks = `${MD}# R #k\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~~js\nx\n~~~\n\n![img](x.png)\n`;
            for (const id of [2, 3, 4]) {
                const nodes: Target[] = [[1, 'R'], [id, '']];
                expect(setTag(blocks, nodes, 'k', 'v')).toEqual(refused('block-node'));
                expect(toggleTag(blocks, nodes, 'k', 'v')).toEqual(refused('block-node'));
                expect(removeTag(blocks, nodes, 'k')).toEqual(refused('block-node'));
            }
        });

        it('どれか 1 つでも古い NodeTarget なら stale-node。単独の \\r を含む文書は、文書の最初の改行にそろえてから書く (D-064)', () => {
            const source = `${MD}# R\n- a #k\n- b\n`;
            for (const nodes of [[[2, 'b']], [[99, 'a']], [[2, 'a'], [3, 'x']], [[Number.NaN, 'a']]] as Target[][]) {
                expect(setTagUnchecked(source, nodes, 'k', 'v')).toEqual(refused('stale-node'));
                expect(removeTagUnchecked(source, nodes, 'k')).toEqual(refused('stale-node'));
                expect(toggleTagUnchecked(source, nodes, 'k', 'v')).toEqual(refused('stale-node'));
            }
            for (const [lone, head, nl] of [
                [`${MD}# R\n- a #k\n- b\r- c\n`, MD, '\n'],
                [`${CRLF_MD}# R\r\n- a #k\r\n- b\r- c\r\n`, CRLF_MD, '\r\n'],
            ] as const) {
                const doc = (a: string): string => `${head}# R${nl}${a}${nl}- b${nl}- c${nl}`;
                expectSameNodes(setTag(lone, [[2, 'a']], 'k', 'v'), doc('- a #k:v'), [[2, 'a']]);
                expectSameNodes(removeTag(lone, [[2, 'a']], 'k'), doc('- a'), [[2, 'a']]);
                expectSameNodes(toggleTag(lone, [[2, 'a']], 'k', 'v'), doc('- a #k:v'), [[2, 'a']]);
            }
        });
    });

    describe('タグの markdag: を足す、CRLF (B-125、A-12、design.md 4.3、3.1)', () => {
        it('setTag と toggleTag は markdag キーのない frontmatter に markdag: を足し (markdag-added)、frontmatter がなければ作る (frontmatter-added)', () => {
            const titled = '---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n';
            expectTagsIn(titled, 2, [['k', ['v']]]);
            for (const run of [() => setTag('---\ntitle: T\n---\n# R\n- a\n', [[2, 'a']], 'k', 'v'), () => toggleTag('---\ntitle: T\n---\n# R\n- a\n', [[2, 'a']], 'k', 'v')]) {
                expect(noteCodes(expectNodesRewritten(run(), titled, [[2, 'a']]))).toEqual(['markdag-added']);
            }
            const created = '---\nmarkdag:\n---\n\n# R\n- a #k:v\n';
            expectTagsIn(created, 2, [['k', ['v']]]);
            for (const run of [() => setTag('# R\n- a\n', [[2, 'a']], 'k', 'v'), () => toggleTag('# R\n- a\n', [[2, 'a']], 'k', 'v')]) {
                expect(noteCodes(expectNodesRewritten(run(), created, [[2, 'a']]))).toContain('frontmatter-added');
            }
        });

        it('markdag: を足すと API #draft は名前 API とタグ draft に読まれ、そのあとに足す。読み方が変わるノードの数 2 を message に添える', () => {
            const after = '---\ntitle: T\nmarkdag:\n---\n# R\n- API #draft #owner:me\n- 画面 %ui\n- Issue #12\n- b\n';
            expectTagsIn(after, 2, [['draft', []], ['owner', ['me']]]);
            for (const run of [() => setTag(UNEXTRACTED, [[2, 'API #draft']], 'owner', 'me'), () => toggleTag(UNEXTRACTED, [[2, 'API #draft']], 'owner', 'me')]) {
                const outcome = expectNodesRewritten(run(), after, [[2, 'API']]);
                expect(noteCodes(outcome)).toEqual(['markdag-added']);
                expect(noteOf(outcome, 'markdag-added')?.message).toContain('2');
            }
        });

        it('先頭の BOM は外して frontmatter を作り (bom-removed)、BOM のすぐあとが --- の行の文書も BOM を外してその frontmatter に書く (D-069)', () => {
            const after = '---\nmarkdag:\n---\n\n# R\n- a #k:v\n';
            expectTagsIn(after, 2, [['k', ['v']]]);
            for (const run of [() => setTag('﻿# R\n- a\n', [[2, 'a']], 'k', 'v'), () => toggleTag('﻿# R\n- a\n', [[2, 'a']], 'k', 'v')]) {
                expect(noteCodes(expectNodesRewritten(run(), after, [[2, 'a']]))).toEqual(expect.arrayContaining(['bom-removed', 'frontmatter-added']));
            }
            const fenced = '\u{feff}---\ntitle: T\n---\n# R\n- a\n';
            const titled = '---\ntitle: T\nmarkdag:\n---\n# R\n- a #k:v\n';
            expectTagsIn(titled, 2, [['k', ['v']]]);
            for (const run of [() => setTag(fenced, [[2, 'a']], 'k', 'v'), () => toggleTag(fenced, [[2, 'a']], 'k', 'v')]) {
                expect(noteCodes(expectNodesRewritten(run(), titled, [[2, 'a']]))).toEqual(['bom-removed', 'markdag-added']);
            }
        });

        it('CRLF の文書は書き換えた 1 行目の行末の \\r を残し、改行で終わらない最後の行には付けない。CRLF の frontmatter に markdag: を足す', () => {
            const source = `${CRLF_MD}# R\r\n- a %g\r\n- b #k:v\r\n`;
            expectSameNodes(setTag(source, [[2, 'a']], 'k', 'x\r\ny'), `${CRLF_MD}# R\r\n- a %g #k:"x y"\r\n- b #k:v\r\n`, [[2, 'a']]);
            expectSameNodes(removeTag(source, [[3, 'b']], 'k'), `${CRLF_MD}# R\r\n- a %g\r\n- b\r\n`, [[3, 'b']]);
            expectSameNodes(
                toggleTag(source, [[2, 'a'], [3, 'b']], 'k', 'v'),
                `${CRLF_MD}# R\r\n- a %g #k:v\r\n- b #k:v\r\n`,
                [[2, 'a'], [3, 'b']],
            );
            expectSameNodes(setTag(`${CRLF_MD}# R\r\n- a`, [[2, 'a']], 'k', 'v'), `${CRLF_MD}# R\r\n- a #k:v`, [[2, 'a']]);
            const titled = '---\r\ntitle: T\r\nmarkdag:\r\n---\r\n# R\r\n- a #k:v\r\n';
            expectTagsIn(titled, 2, [['k', ['v']]]);
            expect(noteCodes(expectNodesRewritten(setTag('---\r\ntitle: T\r\n---\r\n# R\r\n- a\r\n', [[2, 'a']], 'k', 'v'), titled, [[2, 'a']]))).toEqual(['markdag-added']);
        });
    });

    it('splice は書き換えた行だけを含む: 書き換えない行の対になっていないサロゲートが原文のまま残る', () => {
        const source = `${MD}# R\n- a\n- b \ud800 c\n- d\n`;
        expectSameNodes(setDetails(source, [2, 'a'], 'x'), `${MD}# R\n- a\n    > x\n- b \ud800 c\n- d\n`, [[2, 'a']]);
        expectSameNodes(setTag(source, [[2, 'a'], [4, 'd']], 'k', 'v'), `${MD}# R\n- a #k:v\n- b \ud800 c\n- d #k:v\n`, [[2, 'a'], [4, 'd']]);
    });

    it('欄の型の違う setDetails、setTag、removeTag、toggleTag は MarkdagError (invalid-input)', () => {
        const source = '# R\n- a\n';
        const node = { id: 2, refText: 'a' };
        const badOps: unknown[] = [
            { kind: 'setDetails', node },
            { kind: 'setDetails', node, text: 1 },
            { kind: 'setDetails', nodes: [node], text: 'd' },
            { kind: 'setTag', nodes: node, key: 'k', value: 'v', replaceKey: null },
            { kind: 'setTag', nodes: [node], value: 'v', replaceKey: null },
            { kind: 'setTag', nodes: [node], key: 'k', value: 1, replaceKey: null },
            { kind: 'setTag', nodes: [node], key: 'k', value: 'v', replaceKey: 1 },
            { kind: 'removeTag', nodes: [{ id: 2 }], key: 'k' },
            { kind: 'removeTag', nodes: [node], key: 1 },
            { kind: 'toggleTag', nodes: [node], value: 'v' },
            { kind: 'toggleTag', nodes: [node], key: 'k', value: true },
        ];
        for (const op of badOps) {
            const error = thrown(() => core.editSource(source, op as core.EditOp));
            expect(error, JSON.stringify(op)).toBeInstanceOf(core.MarkdagError);
            expect(error).toMatchObject({ code: 'invalid-input', functionName: 'edit_source' });
        }
    });
});

// ---- 名前の入力の初めの値から、markdag が足す \ を外す ----
// 名前の入力を開き直したときの初めの値 (inspectNode の label) には、名前の変更で markdag が足す \ (末尾の印に化ける語、ブロックに化ける書き始め、
// タスクの記号に化ける書き始め、見出しの閉じの記号) を出さない。その値のまま決めても原文は変わらない (二重に逃がさない)。
// 原文に人が書いた \ のうち、markdag が足すのと同じ所のものも同じ扱い。markdag が足さない所の \ (行の途中の \# など) は入力欄に
// そのまま出す。そちらは、その値のまま決めても図の名前が変わらないことを見る

// 依頼者の言葉の例と、項目で逃がす種類ごとの名前 (ITEM_ESCAPES の名前を全部)
const ITEM_NAMES_ESCAPED_BY_RENAME = ['設計 #a', 'C# と F# の比較 #draft', '1. はじめに', ...ITEM_ESCAPES.map(([label]) => label)];
// 見出しで逃がす種類ごとの名前 (閉じの記号、印、ブロックの書き始め)
const HEADING_NAMES_ESCAPED_BY_RENAME = ['設計 #a', 'Issue #', 'a ##', '#todo', 'Issue #frontend', '# x', '1. はじめに', '- x'];

// 原文に人が書いた \ のうち、markdag が名前の変更で足すのと同じ所のもの: [原文、id、refText (= 入力欄に出す値)]
const HAND_WRITTEN_SAME_PLACE: Array<[string, number, string]> = [
    [`${MD}# R\n- 設計 \\#a\n`, 2, '設計 #a'],
    ['# R\n- 設計 \\#a\n', 2, '設計 #a'],
    [`${MD}# R\n- C# と F# の比較 \\#draft\n`, 2, 'C# と F# の比較 #draft'],
    [`${MD}# R\n- \\#todo #k\n`, 2, '#todo'],
    [`${MD}# R\n- [ ] \\#todo\n`, 2, '#todo'],
    [`${MD}# R\n- \\%g\n`, 2, '%g'],
    [`${MD}# R\n- \\$id\n`, 2, '$id'],
    [`${MD}# R\n- 1\\. はじめに\n`, 2, '1. はじめに'],
    [`${MD}# R\n- \\# x\n`, 2, '# x'],
    [`${MD}# R\n- \\> x\n`, 2, '> x'],
    [`${MD}# R\n- \\[ ] x\n`, 2, '[ ] x'],
    [`${MD}# R\n## Issue \\#\n`, 2, 'Issue #'],
    [`${MD}# R\n## 1\\. はじめに\n`, 2, '1. はじめに'],
    ['---\r\nmarkdag:\r\n---\r\n# R\r\n- 設計 \\#a\r\n', 2, '設計 #a'],
];

function labelOf(source: string, id: number, refText: string): string {
    const result = core.inspectNode(source, { id, refText });
    if (result === null) throw new Error(`id ${id} の「${refText}」がない: ${JSON.stringify(source)}`);
    return result.label;
}

describe('inspectNode の label (名前の入力の初めの値) に、名前の変更で markdag が足す \\ を出さない (整える 名前の入力の \\)', () => {
    it('項目の名前を変えたあと開き直すと、label は入れた名前 (図の名前) のまま。逃がしの種類ごと、markdag キーのある文書とない文書', () => {
        for (const prefix of [MD, '']) {
            const source = `${prefix}# R\n- a\n- b\n`;
            const line = prefix.split('\n').length;
            for (const name of ITEM_NAMES_ESCAPED_BY_RENAME) {
                const after = renamed(source, 2, 'a', name);
                // markdag が \ を足した例であること
                expect(lineOf(after, line), name).toContain('\\');
                expect(nodeOf(after, 2).refText, after).toBe(name);
                expect(labelOf(after, 2, name), after).toBe(name);
            }
        }
    });

    it('見出しの名前を変えたあと開き直しても同じ (閉じの記号、印、ブロックの書き始め。ルートの見出しも)', () => {
        for (const prefix of [MD, '']) {
            const source = `${prefix}# R\n## h\n`;
            const line = prefix.split('\n').length;
            for (const name of HEADING_NAMES_ESCAPED_BY_RENAME) {
                const after = renamed(source, 2, 'h', name);
                expect(lineOf(after, line), name).toContain('\\');
                expect(labelOf(after, 2, name), after).toBe(name);
            }
            const after = renamed(source, 1, 'R', 'Issue #');
            expect(labelOf(after, 1, 'Issue #'), after).toBe('Issue #');
        }
    });

    it('タスクの記号と印のある項目、番号付きの項目、CRLF の文書、足す操作の仮の名前でも、足した \\ を出さない', () => {
        const task = renamed(`${MD}# R\n- [ ] a #k\n`, 2, 'a', '#todo');
        expect(lineOf(task, 4)).toBe(String.raw`- [ ] \#todo #k`);
        expect(labelOf(task, 2, '#todo')).toBe('#todo');

        // 番号付きの項目: label は頭の番号を除いた名前 (refText は頭の番号を含む)
        const numbered = renamed(`${MD}# R\n1. a\n2. b\n`, 2, '1. a', '1. はじめに');
        expect(lineOf(numbered, 4)).toBe(String.raw`1. 1\. はじめに`);
        expect(labelOf(numbered, 2, nodeOf(numbered, 2).refText)).toBe('1. はじめに');

        // CRLF の文書: label に \ も \r も入らない
        const crlf = renamed('# R\r\n- a\r\n', 2, 'a', '設計 #a');
        expect(crlf).toBe('# R\r\n- 設計 \\#a\r\n');
        expect(labelOf(crlf, 2, '設計 #a')).toBe('設計 #a');

        const child = edited(addChild(`${MD}# R\n- a\n`, 2, 'a', '#todo')).source;
        expect(child).toBe(`${MD}# R\n- a\n    - \\#todo\n`);
        expect(labelOf(child, 3, '#todo')).toBe('#todo');
    });

    it('原文に人が書いた \\ のうち、markdag が足すのと同じ所のものも label に出さない', () => {
        for (const [source, id, name] of HAND_WRITTEN_SAME_PLACE) {
            expect(nodeOf(source, id).refText, source).toBe(name);
            expect(labelOf(source, id, name), source).toBe(name);
        }
    });

    it('開き直した値 (label) のまま決めても原文は変わらない (unchanged、same-name。二重に逃がさない)。図の名前で決めても同じ', () => {
        const cases: Array<[string, number, string]> = [...HAND_WRITTEN_SAME_PLACE];
        for (const prefix of [MD, '']) {
            for (const name of ITEM_NAMES_ESCAPED_BY_RENAME) cases.push([renamed(`${prefix}# R\n- a\n- b\n`, 2, 'a', name), 2, name]);
            for (const name of HEADING_NAMES_ESCAPED_BY_RENAME) cases.push([renamed(`${prefix}# R\n## h\n`, 2, 'h', name), 2, name]);
        }
        for (const [source, id, refText] of cases) {
            expect(rename(source, id, refText, labelOf(source, id, refText)), source).toEqual(unchanged('same-name'));
            expect(rename(source, id, refText, refText), source).toEqual(unchanged('same-name'));
        }
    });

    it('markdag が足さない所の \\ と Markdown の記法: 開き直した値のまま決めても、図の名前 (refText) と印は変わらない', () => {
        const sources: Array<[string, string]> = [
            [`${MD}# R\n- 設計 \\#a の説明\n`, '設計 #a の説明'],
            [`${MD}# R\n- a \\* b #k\n`, 'a * b'],
            [`${MD}# R\n- \\*\\*x\\*\\*\n`, '**x**'],
            [`${MD}# R\n- C\\# と F\\# の比較 \\#draft\n`, 'C# と F# の比較 #draft'],
            [`${MD}# R\n- **太字** と \`code\` %g\n`, '太字 と code'],
        ];
        for (const [source, refText] of sources) {
            const before = nodeOf(source, 2);
            expect(before.refText, source).toBe(refText);
            const outcome = rename(source, 2, refText, labelOf(source, 2, refText));
            if (outcome.status === 'unchanged') {
                expect(outcome, source).toEqual(unchanged('same-name'));
                continue;
            }
            const after = edited(outcome);
            const node = nodeOf(after.source, 2);
            expect(node.refText, after.source).toBe(refText);
            expect(node.tags, after.source).toEqual(before.tags);
            expect(node.groups, after.source).toEqual(before.groups);
            expect(after.select, after.source).toEqual(selected(2, refText));
        }
    });
});

describe('名前の入力の \\ のメインの決定 (整える 名前の入力の \\ の 1 と 3)', () => {
    it('markdag が足さない所に人が書いた \\ は label にそのまま出す。外すのは名前の変更で足すのと同じ所のものだけ (決定 1 の (a))', () => {
        const cases: Array<[string, string, string]> = [
            [`${MD}# R\n- 設計 \\#a の説明\n`, '設計 #a の説明', String.raw`設計 \#a の説明`],
            ['# R\n- 設計 \\#a の説明\n', '設計 #a の説明', String.raw`設計 \#a の説明`],
            [`${MD}# R\n- a \\* b #k\n`, 'a * b', String.raw`a \* b`],
            [`${MD}# R\n- \\*\\*x\\*\\*\n`, '**x**', String.raw`\*\*x\*\*`],
            // 行の途中の \# は残し、末尾の印に化ける語の \ だけを外す
            [`${MD}# R\n- C\\# と F\\# の比較 \\#draft\n`, 'C# と F# の比較 #draft', String.raw`C\# と F\# の比較 #draft`],
        ];
        for (const [source, refText, label] of cases) {
            expect(nodeOf(source, 2).refText, source).toBe(refText);
            expect(labelOf(source, 2, refText), source).toBe(label);
        }
    });

    it('名前の入力を開いて何も変えずに決めたときは、markdag キーのない文書でも原文を変えない (- a #k を - a \\#k にしない。決定 3)', () => {
        // markdag キーのない文書は印を読まないので、末尾の #k などは名前の一部: [原文、id、refText = label]
        const cases: Array<[string, number, string]> = [
            ['# R\n- a #k\n', 2, 'a #k'],
            ['# R\n- Issue #123 fix #urgent\n', 2, 'Issue #123 fix #urgent'],
            ['# R\n- a #k:v\n', 2, 'a #k:v'],
            ['# R\n- a %g\n', 2, 'a %g'],
            ['# R\n- a $id\n', 2, 'a $id'],
            ['# R\n- [ ] a #k\n', 2, 'a #k'],
            ['# R\n## h #k\n', 2, 'h #k'],
            ['# R\r\n- a #k\r\n', 2, 'a #k'],
        ];
        for (const [source, id, name] of cases) {
            expect(nodeOf(source, id).refText, source).toBe(name);
            const label = labelOf(source, id, name);
            expect(label, source).toBe(name);
            expect(rename(source, id, name, label), source).toEqual(unchanged('same-name'));
        }
        // markdag キーのある文書では #k と %g は印で、label は印を除いた名前。何も変えずに決めても原文は変わらない
        const marked = `${MD}# R\n## h %g\n- a #k\n`;
        expect(labelOf(marked, 2, 'h')).toBe('h');
        expect(rename(marked, 2, 'h', 'h')).toEqual(unchanged('same-name'));
        expect(labelOf(marked, 3, 'a')).toBe('a');
        expect(rename(marked, 3, 'a', 'a')).toEqual(unchanged('same-name'));
    });

    it('名前を変えたときは、markdag キーのない文書でもある文書でも今までどおり逃がす', () => {
        expect(renamed('# R\n- a #k\n', 2, 'a #k', 'b #k')).toBe('# R\n- b \\#k\n');
        expect(renamed('# R\n- a #k\n', 2, 'a #k', 'a #k #m')).toBe('# R\n- a #k \\#m\n');
        expect(renamed('# R\n## h #k\n', 2, 'h #k', 'h #j')).toBe('# R\n## h \\#j\n');
        expect(renamed(`${MD}# R\n- a #k\n`, 2, 'a', 'b #c')).toBe(`${MD}# R\n- b \\#c #k\n`);
    });
});

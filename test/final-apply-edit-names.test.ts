// 最後の関門で決まった書き換えの直し (records/final-apply/plan.md の 1、9、16) を、公開の入口 (markdag/core) から、
// 直す前に落ちるテストとして書く。細かい形は Rust の tests/final_apply_edit_names.rs が見て、ここは境界を通した代表の形を見る。
// formatTag は JS の写し (wasm を呼ばない) なので、空の値の囲み方は Rust の format_tag とは別に見る。
// 1. AM-06: 名前の逃がしを行の全体 (行頭の印、名前、後ろの印) で決め、断らずに書く。足す操作の名前も同じ。名前の入力の初めの値に足した \ を出さない (細部 1、2)
// 2. B-134: タグのキーと値は要るときだけ " で囲み、" と \ を逃がして書く。タグの操作は空のキーのほかは断らない。空の値は "" と囲む (細部 13)
// 3. empty-name: どのノードも名前を空にできない。理由の文は「名前を空にできません」だけ。今の名前が空なら same-name が先。
//    足す操作の空の名前は断らない (細部 25、26)
// 変えない挙動 (今も通り、直したあとも通るもの) は、名前に「変えない」と書いた
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

const MD = '---\nmarkdag:\n---\n';
const EMPTY_NAME_MESSAGE = '名前を空にできません';

type Target = [number, string];
type TagRow = [string, string[]];

const nodeTargets = (nodes: Target[]): core.NodeTarget[] => nodes.map(([id, refText]) => ({ id, refText }));

const rename = (source: string, id: number, refText: string, label: string): core.EditOutcome =>
    core.editSource(source, { kind: 'renameNode', node: { id, refText }, label });
const setTag = (source: string, nodes: Target[], key: string, value: string | null, replaceKey: string | null = null): core.EditOutcome =>
    core.editSource(source, { kind: 'setTag', nodes: nodeTargets(nodes), key, value, replaceKey });
const toggleTag = (source: string, nodes: Target[], key: string, value: string | null): core.EditOutcome =>
    core.editSource(source, { kind: 'toggleTag', nodes: nodeTargets(nodes), key, value });

function editedSource(outcome: core.EditOutcome): string {
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome.source;
}

function nodeOf(source: string, id: number): core.OutlineNode {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない: ${JSON.stringify(source)}`);
    return node;
}

const lineOf = (source: string, index: number): string => source.split('\n')[index] ?? '';
const tagRows = (node: core.OutlineNode): TagRow[] => node.tags.map((tag) => [tag.key, tag.values]);
const selected = (id: number, refText: string): core.EditSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

function inspected(source: string, id: number, refText: string): core.InspectNodeResult {
    const result = core.inspectNode(source, { id, refText });
    if (result === null) throw new Error(`id ${id} の「${refText}」がない: ${JSON.stringify(source)}`);
    return result;
}

describe('AM-06: 名前の逃がしを行の全体で決め、断らずに書く', () => {
    // records/final-gate/am06/index.html の表の 4 例: (本文の行、新しい名前、書く行、種類)
    const cases: Array<[string, string, string, core.InspectNodeResult['kind']]> = [
        ['- 設計 %画面班', '[x]', '- \\[x] %画面班', 'item'],
        ['## 設計 ##', '[ ]', '## \\[ ] ##', 'heading'],
        ['- 設計', '--', '- \\--', 'item'],
        ['* 設計', '**', '* \\**', 'item'],
    ];

    it('記号だけの名前が行頭の印や後ろの印と合わさる行は、要る所に \\ を置いて書き、名前は入れたとおりの文字 (タスクにならない) で、種類は変わらない', () => {
        for (const [line, name, written, kind] of cases) {
            const source = `${MD}# R\n${line}\n`;
            const outcome = rename(source, 2, '設計', name);
            expect(outcome, line).toEqual({ status: 'edited', source: `${MD}# R\n${written}\n`, select: selected(2, name), rename: null, notes: [] });
            const after = editedSource(outcome);
            expect(nodeOf(after, 2).refText, line).toBe(name);
            expect(nodeOf(after, 2).task, line).toBeNull();
            expect(core.parseDocument(after).nodes.length, line).toBe(2);
            expect(inspected(after, 2, name).kind, line).toBe(kind);
        }
        expect(nodeOf(`${MD}# R\n- \\[x] %画面班\n`, 2).groups).toEqual(['画面班']);
    });

    it('タスクの記号だけの名前と後ろの印 (%、#、$) の行、印を外すと区切り線になる行、CRLF の行と markdag キーのない文書も同じ', () => {
        const rows: Array<[string, string, string, string]> = [
            [`${MD}# R\n- 設計 #k:v\n`, '[x]', '- \\[x] #k:v', `${MD}# R\n- \\[x] #k:v\n`],
            [`${MD}# R\n- 設計 $d\n`, '[ ]', '- \\[ ] $d', `${MD}# R\n- \\[ ] $d\n`],
            [`${MD}# R\n## 設計 #k\n`, '[x]', '## \\[x] #k', `${MD}# R\n## \\[x] #k\n`],
            [`${MD}# R\n- 設計 %g\n`, '--', '- \\-- %g', `${MD}# R\n- \\-- %g\n`],
            [`${MD}# R\n* 設計 %g\n`, '**', '* \\** %g', `${MD}# R\n* \\** %g\n`],
            ['---\r\nmarkdag:\r\n---\r\n# R\r\n- 設計 %画面班\r\n', '[x]', '- \\[x] %画面班\r', '---\r\nmarkdag:\r\n---\r\n# R\r\n- \\[x] %画面班\r\n'],
            ['# R\n- 設計\n', '--', '- \\--', '# R\n- \\--\n'],
        ];
        for (const [source, name, line, after] of rows) {
            const written = editedSource(rename(source, 2, '設計', name));
            expect(written, line).toBe(after);
            expect(nodeOf(written, 2).refText, line).toBe(name);
            expect(nodeOf(written, 2).task, line).toBeNull();
        }
    });

    it('名前の入力の初めの値 (inspectNode の label) に、行の全体の逃がしが足した \\ を出さない。その値のまま決めたら same-name', () => {
        const rows: Array<[string, string]> = [
            ['- \\[x] %画面班', '[x]'],
            ['## \\[ ] ##', '[ ]'],
            ['- \\--', '--'],
            ['* \\**', '**'],
            ['- \\-- %g', '--'],
        ];
        for (const [line, name] of rows) {
            const source = `${MD}# R\n${line}\n`;
            expect(nodeOf(source, 2).refText, line).toBe(name);
            expect(inspected(source, 2, name).label, line).toBe(name);
            expect(rename(source, 2, name, name), line).toEqual({ status: 'unchanged', reason: { code: 'same-name', message: expect.stringMatching(/\S/), path: null } });
        }
    });

    it('足す操作 (addSibling、addChild、joinIntoNew) の名前にも行の全体の逃がしを当てる (細部 2)', () => {
        const sibling = editedSource(core.editSource(`${MD}# R\n- a\n`, { kind: 'addSibling', node: { id: 2, refText: 'a' }, label: '--' }));
        expect(sibling).toBe(`${MD}# R\n- a\n- \\--\n`);
        expect(nodeOf(sibling, 3).refText).toBe('--');
        const star = editedSource(core.editSource(`${MD}# R\n* a\n`, { kind: 'addSibling', node: { id: 2, refText: 'a' }, label: '**' }));
        expect(star).toBe(`${MD}# R\n* a\n* \\**\n`);
        const child = editedSource(core.editSource(`${MD}# R\n- a\n    - b\n`, { kind: 'addChild', parent: { id: 2, refText: 'a' }, label: '--' }));
        expect(child).toBe(`${MD}# R\n- a\n    - b\n    - \\--\n`);
        const joined = editedSource(
            core.editSource(`${MD}# R\n- a\n- b\n`, {
                kind: 'joinIntoNew',
                sources: [
                    { id: 2, refText: 'a' },
                    { id: 3, refText: 'b' },
                ],
                label: '--',
            }),
        );
        expect(joined.endsWith('# R\n- a\n- b\n- \\--\n'), joined).toBe(true);
        expect(nodeOf(joined, 4).refText).toBe('--');
    });

    it('変えない (細部 1): 今の名前だけの逃がしは残し、名前のとおりに読まれる行には \\ を足さない', () => {
        const rows: Array<[string, string, string, string]> = [
            ['- 設計', '設計', '[x]', '- [x]'],
            ['## 設計', '設計', '[ ]', '## [ ]'],
            ['+ 設計', '設計', '--', '+ --'],
            ['- 設計', '設計', '__', '- __'],
            ['- 設計', '設計', '- -', '- \\- -'],
            ['- 設計 %g', '設計', '#todo', '- \\#todo %g'],
            ['- [ ] 設計 %g', '設計', '[x]', '- [ ] [x] %g'],
        ];
        for (const [line, refText, name, written] of rows) {
            const after = editedSource(rename(`${MD}# R\n${line}\n`, 2, refText, name));
            expect(lineOf(after, 4), `${line} → ${name}`).toBe(written);
        }
    });
});

describe('B-134: タグのキーと値の書き出し (要るときだけ囲み、" と \\ を逃がす)', () => {
    // 囲みが要るキーと、書く印 (値 v)
    const quotedKeys: Array<[string, string]> = [
        ['a.b', '#"a.b":v'],
        ['s.a', '#"s.a":v'],
        ['123', '#"123":v'],
        ['a b', '#"a b":v'],
        ['a:b', '#"a:b":v'],
        ['a,b', '#"a,b":v'],
        ['a"b', '#"a\\"b":v'],
        ['a\\b', '#"a\\\\b":v'],
    ];

    it('キーに使えない字のあるキーも tag-key-invalid で断らず、" で囲んで書く。読み直すと入れたとおりのキー (setTag と toggleTag)', () => {
        for (const [key, mark] of quotedKeys) {
            for (const outcome of [setTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), toggleTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v')]) {
                const after = editedSource(outcome);
                expect(after, key).toBe(`${MD}# R\n- a ${mark}\n`);
                expect(tagRows(nodeOf(after, 2)), key).toEqual([[key, ['v']]]);
            }
        }
        // 値のないタグ、キーと値の両方を囲む、キーの前後の空白と先頭の # を外す
        expect(editedSource(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 's.a', null))).toBe(`${MD}# R\n- a #"s.a"\n`);
        expect(editedSource(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'a b', 'x y'))).toBe(`${MD}# R\n- a #"a b":"x y"\n`);
        expect(editedSource(setTag(`${MD}# R\n- a\n`, [[2, 'a']], ' #a.b ', 'v'))).toBe(`${MD}# R\n- a #"a.b":v\n`);
    });

    it('キーを変える編集は、もとのキーも新しいキーも囲みが要るキーでよい', () => {
        expect(editedSource(setTag(`${MD}# R\n- a #"a.b":v %g\n`, [[2, 'a']], 'x', 'v', 'a.b'))).toBe(`${MD}# R\n- a #x:v %g\n`);
        expect(editedSource(setTag(`${MD}# R\n- a #x:v %g\n`, [[2, 'a']], 'a.b', 'v', 'x'))).toBe(`${MD}# R\n- a #"a.b":v %g\n`);
    });

    it('変えない: 前後の空白と先頭の # を外して空になるキーだけは tag-key-invalid', () => {
        for (const key of ['', ' ', '#', ' # ', '\u3000']) {
            expect(setTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), JSON.stringify(key)).toMatchObject({ status: 'refused', reason: { code: 'tag-key-invalid' } });
            expect(toggleTag(`${MD}# R\n- a\n`, [[2, 'a']], key, 'v'), JSON.stringify(key)).toMatchObject({ status: 'refused', reason: { code: 'tag-key-invalid' } });
        }
    });

    it('" や \\ のある値は囲んで逃がし、空白や , を含む値も囲んで今の値に足す (解析を直したので今も通る)', () => {
        const values: Array<[string, string]> = [
            ['say "hi"', '#k:"say \\"hi\\""'],
            ['a\\b', '#k:"a\\\\b"'],
            ['a\\"b', '#k:"a\\\\\\"b"'],
        ];
        for (const [value, mark] of values) {
            const after = editedSource(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', value));
            expect(after, value).toBe(`${MD}# R\n- a ${mark}\n`);
            expect(tagRows(nodeOf(after, 2)), value).toEqual([['k', [value]]]);
        }
        const added: Array<[string, string]> = [
            ['山田 太郎', '#k:alice,"山田 太郎"'],
            ['a,b', '#k:alice,"a,b"'],
            ['say "hi"', '#k:alice,"say \\"hi\\""'],
        ];
        for (const [value, mark] of added) {
            const after = editedSource(toggleTag(`${MD}# R\n- a #k:alice\n`, [[2, 'a']], 'k', value));
            expect(after, value).toBe(`${MD}# R\n- a ${mark}\n`);
            expect(tagRows(nodeOf(after, 2)), value).toEqual([['k', ['alice', value]]]);
        }
    });

    it('空の値は "" と囲む: #k:"" を読んで書き戻しても #k:"" のまま (toggleTag で値を足す、外す)', () => {
        const rows: Array<[string, string, string, TagRow]> = [
            ['#k:""', 'b', '#k:"",b', ['k', ['', 'b']]],
            ['#k:"",b', 'b', '#k:""', ['k', ['']]],
            ['#"a.b":""', 'b', '#"a.b":"",b', ['a.b', ['', 'b']]],
        ];
        for (const [mark, value, written, row] of rows) {
            const key = row[0];
            const after = editedSource(toggleTag(`${MD}# R\n- a ${mark}\n`, [[2, 'a']], key, value));
            expect(after, mark).toBe(`${MD}# R\n- a ${written}\n`);
            expect(tagRows(nodeOf(after, 2)), mark).toEqual([row]);
        }
        // 変えない: setTag の空の値は値のないタグ
        expect(editedSource(setTag(`${MD}# R\n- a\n`, [[2, 'a']], 'k', ''))).toBe(`${MD}# R\n- a #k\n`);
    });

    it('formatTag (JS の写し) も空の値を "" と囲み、項目の 1 行目に書いて読み直すと同じキーと値', () => {
        const format = (key: string, values: string[]): string => core.formatTag({ key, values });
        expect(format('k', [''])).toBe('#k:""');
        expect(format('k', ['', 'b'])).toBe('#k:"",b');
        expect(format('k', ['a', ''])).toBe('#k:a,""');
        expect(format('a.b', [''])).toBe('#"a.b":""');
        expect(format('k', [])).toBe('#k');
        for (const values of [[''], ['', 'b'], ['a', '']]) {
            const mark = format('k', values);
            expect(tagRows(nodeOf(`${MD}# R\n- a ${mark}\n`, 2)), mark).toEqual([['k', values]]);
        }
    });
});

describe('empty-name: どのノードも名前を空にできない', () => {
    // (原文、id、refText、場合の名前)
    const nodes: Array<[string, number, string, string]> = [
        ['# R\n- a\n- b\n', 3, 'b', '印もタスクの記号もない項目'],
        [`${MD}# R\n- [ ] a\n- b\n`, 2, 'a', 'タスクの項目'],
        [`${MD}# R\n- a %g\n- b\n`, 2, 'a', '末尾の印のある項目'],
        [`${MD}# R\n- A\n\n    - x\n- B\n`, 2, 'A', '1 行目のすぐ次が空行で続きのある項目'],
        [`${MD}# R\n\n前置きの段落\n- a\n    - c\n`, 2, 'a', '段落の直後の項目'],
        ['# R\n## a\n- x\n- y\n', 2, 'a', '子のある見出し'],
        [`${MD}# R\n- a\n`, 1, 'R', 'ルートの見出し'],
        [`${MD}# R\n\n設計\n---\n- a\n`, 2, '設計', '下線の見出し'],
        [`${MD}# R\n1. a\n2. b\n`, 2, '1. a', '番号付きの項目'],
        ['# R\r\n- a\r\n- b\r\n', 3, 'b', 'CRLF の文書の項目'],
    ];

    it('空の名前 (空白と改行だけも) は、ノードの種類とタスクの記号と末尾の印によらず empty-name で、理由の文は「名前を空にできません」だけ', () => {
        for (const [source, id, refText, label] of nodes) {
            expect(nodeOf(source, id).refText, label).toBe(refText);
            for (const name of ['', '   ', '\r\n']) {
                expect(rename(source, id, refText, name), `${label} ${JSON.stringify(name)}`).toEqual({ status: 'refused', reason: { code: 'empty-name', message: EMPTY_NAME_MESSAGE, path: null } });
            }
        }
    });

    it('変えない (細部 26): 今の名前が空のノードを空のまま決めたら、空の判定より先に same-name', () => {
        for (const source of ['# R\n-\n- b\n', `${MD}# R\n- %g\n- b\n`]) {
            expect(nodeOf(source, 2).refText).toBe('');
            for (const name of ['', '  ']) {
                expect(rename(source, 2, '', name), source).toEqual({ status: 'unchanged', reason: { code: 'same-name', message: expect.stringMatching(/\S/), path: null } });
            }
        }
    });

    it('変えない (細部 25): 足す操作の空の名前は断らず、空の本文を書く', () => {
        expect(editedSource(core.editSource(`${MD}# R\n- a\n`, { kind: 'addSibling', node: { id: 2, refText: 'a' }, label: '' }))).toBe(`${MD}# R\n- a\n-\n`);
        const joined = core.editSource(`${MD}# R\n## a\n## b\n`, {
            kind: 'joinIntoNew',
            sources: [
                { id: 2, refText: 'a' },
                { id: 3, refText: 'b' },
            ],
            label: '',
        });
        expect(joined.status).toBe('edited');
        expect(nodeOf(editedSource(joined), 4).refText).toBe('');
    });
});

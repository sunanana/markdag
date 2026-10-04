// 最後の関門で決まった解析の読み方 (records/final-apply/plan.md の 5、9、10) を、公開の入口 (markdag/core) から、
// 直す前に落ちるテストとして書く。formatTag は JS の写し (wasm を呼ばない) なので Rust の format_tag とは別に見る。
// parseDocument と buildModel は wasm の境界を通した結果を、代表の形だけ見る (細かい形は Rust の tests/final_apply_parse.rs が見る)。
// 1. リストの入れ物と最初の項目が分け合う 1 行目の印は、最初の項目だけのもの (B-107 / B-135)
// 2. タグのキーを " で囲む書き方、囲んだ値を , で並べる、囲みの中の \" と \\ の逃がし、tags.keys の数字のキー、formatTag の囲み方 (B-134、細部 13、14)
// 3. 見出しの行のあと、空行だけをはさんで続く引用を、その見出しの詳細にする (細部 15、17)
// 変えない挙動 (今も通り、直したあとも通るもの) は、名前に「変えない」と書いた
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';

const MD = '---\nmarkdag:\n---\n';

type TagRow = [string, string[]];

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

const tagRows = (node: core.OutlineNode): TagRow[] => node.tags.map((tag) => [tag.key, tag.values]);

// 項目 1 つの文書の a (id 2) のタグ
const itemTags = (marks: string): TagRow[] => tagRows(nodeOf(`${MD}# R\n- a ${marks}\n`, 2));

// 詳細の 1 つの段落: 原文で line と同じ行 (0 始まりの行の添字) の段落を、項目の詳細と同じ形 (data-lines を持つ p) で書いたもの
function quoteParagraph(source: string, line: string, inner: string): string {
    const index = source.split('\n').indexOf(line);
    if (index < 0) throw new Error(`${line} の行がない: ${JSON.stringify(source)}`);
    return `<p data-lines="${index},${index + 1}">${inner}</p>`;
}

describe('リストの入れ物と最初の項目が分け合う 1 行目の印 (B-107 / B-135)', () => {
    // リストだけの文書: 1 入れ物 (ルート) / 2 設計 / 3 実装 / 4 テスト
    const listOnly = (marks: string): string => `${MD}- 設計 ${marks}\n- 実装\n- テスト\n`;

    it('リストだけの文書の最初の項目の %グループ、#タグ、$id は最初の項目だけが読み、入れ物は読まない', () => {
        const source = listOnly('%画面班 #担当:山田 $design');
        const container = nodeOf(source, 1);
        const first = nodeOf(source, 2);
        expect(first.refText).toBe('設計');
        expect({ groups: container.groups, tags: tagRows(container), refId: container.refId }, '入れ物').toEqual({ groups: [], tags: [], refId: null });
        expect({ groups: first.groups, tags: tagRows(first), refId: first.refId }, '設計').toEqual({ groups: ['画面班'], tags: [['担当', ['山田']]], refId: 'design' });
    });

    it('見出しの下にリストが 2 つあるとき、各リストの入れ物も最初の項目の印を読まない', () => {
        // 1 R / 2 入れ物 / 3 a / 4 b / 5 番号の入れ物 / 6「1. c」/ 7「2. d」
        const source = `${MD}# R\n\n- a %g\n- b\n\n1. c #k:v\n2. d\n`;
        expect(nodeOf(source, 3).refText).toBe('a');
        expect(nodeOf(source, 2).groups, '入れ物').toEqual([]);
        expect(nodeOf(source, 3).groups, 'a').toEqual(['g']);
        expect(tagRows(nodeOf(source, 5)), '番号の入れ物').toEqual([]);
        expect(tagRows(nodeOf(source, 6)), '1. c').toEqual([['k', ['v']]]);
    });

    it('リストだけの文書の最初の項目のグループは、その項目と子だけに入り、2 つ目からの項目と入れ物には入らない (buildModel の groupsOf)', () => {
        const source = '---\nmarkdag:\n    groups:\n        画面班:\n            label: 画面班\n---\n- 設計 %画面班\n    - 画面\n- 実装\n- テスト\n';
        const parsed = core.parseDocument(source);
        const model = core.buildModel(parsed.nodes, parsed.frontmatter, source);
        const groups = (id: number): string[] => [...(model.groupsOf.get(id) ?? [])];
        expect(nodeOf(source, 3).refText).toBe('画面');
        expect([1, 2, 3, 4, 5].map(groups)).toEqual([[], ['画面班'], ['画面班'], [], []]);
    });
});

describe('タグのキーと値の囲み (B-134、細部 14)', () => {
    it('" で囲んだキー: #"s.a"、#"s.a":x、#"s.a":"x y" (キーと値の両方を囲める)', () => {
        expect(itemTags('#"s.a"')).toEqual([['s.a', []]]);
        expect(itemTags('#"s.a":x')).toEqual([['s.a', ['x']]]);
        expect(itemTags('#"s.a":"x y"')).toEqual([['s.a', ['x y']]]);
    });

    it('囲んだキーの中の空白 (全角も)、:、,、%、#、$ はただの字で、区切りは囲みの外の最初の :', () => {
        expect(itemTags('#"a b"')).toEqual([['a b', []]]);
        expect(itemTags('#"a　b"')).toEqual([['a　b', []]]);
        expect(itemTags('#"a:b":c')).toEqual([['a:b', ['c']]]);
        for (const key of ['a,b', '%x', '#x', '$x']) expect(itemTags(`#"${key}"`), key).toEqual([[key, []]]);
    });

    it('#"123" はキー 123。囲まない #123 は今と同じく文字 (変えない側も見る)', () => {
        expect(itemTags('#"123"')).toEqual([['123', []]]);
        expect(itemTags('#123')).toEqual([]);
        expect(nodeOf(`${MD}# R\n- a #123\n`, 2).refText).toBe('a #123');
    });

    it('#"owner" と #owner は同じキーで、値をつなぐ', () => {
        expect(itemTags('#"owner":x #owner:y')).toEqual([['owner', ['x', 'y']]]);
    });

    it('囲んだ値も , で並べられる (囲んだ値と囲まない値をどちらの順でも)', () => {
        expect(itemTags('#owner:alice,"山田 太郎"')).toEqual([['owner', ['alice', '山田 太郎']]]);
        expect(itemTags('#owner:"山田 太郎",alice')).toEqual([['owner', ['山田 太郎', 'alice']]]);
    });

    it('囲みの中の \\" は "、\\\\ は \\、ほかの \\x は 2 字のまま (キーも値も)', () => {
        expect(itemTags('#note:"say \\"hi\\""')).toEqual([['note', ['say "hi"']]]);
        expect(itemTags('#k:"a\\\\b"')).toEqual([['k', ['a\\b']]]);
        expect(itemTags('#k:"a\\xb"')).toEqual([['k', ['a\\xb']]]);
        expect(itemTags('#"a\\"b"')).toEqual([['a"b', []]]);
        expect(itemTags('#"a\\\\b"')).toEqual([['a\\b', []]]);
    });

    it('閉じていない囲みは印にしない (\\" で終わる囲みも閉じていない)', () => {
        for (const marks of ['#"a', '#k:"a', '#k:"a\\"', '#"a\\"']) expect(itemTags(marks), marks).toEqual([]);
    });

    it('変えない: #"" は文字、\\#"s.a" は逃がしで文字、囲まない値の \\ は逃がしにしない', () => {
        expect(itemTags('#""')).toEqual([]);
        expect(itemTags('\\#"s.a"')).toEqual([]);
        expect(nodeOf(`${MD}# R\n- a \\#"s.a"\n`, 2).refText).toBe('a #"s.a"');
        expect(itemTags('#k:a\\b')).toEqual([['k', ['a\\b']]]);
    });
});

describe('tags.keys の数字だけのキー (B-134)', () => {
    const withKey = (key: string, type: string, marks: string, lint = ''): string =>
        `---\nmarkdag:\n    tags:\n${lint}        keys:\n            ${key}:\n                type: ${type}\n---\n# R\n- a ${marks}\n`;

    it('変えない: 囲まない 123: も "123": も、tagKeys のキーは文字の「123」', () => {
        for (const key of ['123', '"123"']) {
            const source = withKey(key, 'string', '');
            const parsed = core.parseDocument(source);
            expect(core.buildModel(parsed.nodes, parsed.frontmatter, source).tagKeys.map((def) => def.key), key).toEqual(['123']);
        }
    });

    it('#"123":x は tags.keys の 123 に当たり、unknownKey: deny でも tag-unknown-key にならない (tagsOf にキー 123)', () => {
        for (const key of ['123', '"123"']) {
            const source = withKey(key, 'string', '#"123":x', '        unknownKey: deny\n');
            const parsed = core.parseDocument(source);
            const model = core.buildModel(parsed.nodes, parsed.frontmatter, source);
            expect((model.tagsOf.get(2) ?? []).map((tag): TagRow => [tag.key, tag.values]), key).toEqual([['123', ['x']]]);
            expect(model.diagnostics.map((item) => item.code), key).not.toContain('tag-unknown-key');
        }
    });

    it('#"123":abc は type: number の 123 の検査を受け、tag-type の文の中のタグも囲んだ形', () => {
        const source = withKey('123', 'number', '#"123":abc');
        const parsed = core.parseDocument(source);
        const found = core.buildModel(parsed.nodes, parsed.frontmatter, source).diagnostics.filter((item) => item.code === 'tag-type');
        expect(found).toHaveLength(1);
        expect(found[0]?.at).toEqual({ line: 9, column: 5, length: 10 });
        expect(found[0]?.message).toContain('#"123":abc');
    });
});

describe('タグを文字に戻す formatTag (JS の写し。細部 13)', () => {
    const format = (key: string, values: string[] = []): string => core.formatTag({ key, values });

    it('キーに文字、数字、_、- の外の字があれば " で囲む', () => {
        const cases: Array<[string, string]> = [
            ['s.a', '#"s.a"'],
            ['a b', '#"a b"'],
            ['a　b', '#"a　b"'],
            ['a:b', '#"a:b"'],
            ['a,b', '#"a,b"'],
            ['%x', '#"%x"'],
            ['#x', '#"#x"'],
            ['$x', '#"$x"'],
        ];
        for (const [key, mark] of cases) expect(format(key), key).toBe(mark);
        expect(format('s.a', ['x'])).toBe('#"s.a":x');
    });

    it('数字だけのキーは囲む', () => {
        expect(format('123')).toBe('#"123"');
        expect(format('123', ['x'])).toBe('#"123":x');
    });

    it('変えない: 文字、数字、_、- だけで数字だけでないキーは囲まない (全角数字だけのキーも、解析が印に読むので囲まない)', () => {
        for (const key of ['owner', '担当', 'a_b-c', 'a1', '１２３']) {
            expect(format(key), key).toBe(`#${key}`);
            expect(format(key, ['v']), key).toBe(`#${key}:v`);
        }
    });

    it('囲んだキーの中の " は \\"、\\ は \\\\ と書く', () => {
        expect(format('a"b')).toBe('#"a\\"b"');
        expect(format('a\\b')).toBe('#"a\\\\b"');
    });

    it('\\ を含む値は囲み、囲んだ値の中の " は \\"、\\ は \\\\ と書く', () => {
        expect(format('k', ['a\\b'])).toBe('#k:"a\\\\b"');
        expect(format('note', ['say "hi"'])).toBe('#note:"say \\"hi\\""');
        expect(format('k', ['a\\"b'])).toBe('#k:"a\\\\\\"b"');
    });

    it('変えない: 要らない値は囲まない (#owner:alice は今のまま)', () => {
        expect(format('owner', ['alice'])).toBe('#owner:alice');
        expect(format('owner', ['alice', '山田 太郎'])).toBe('#owner:alice,"山田 太郎"');
    });

    it('書き出した形を項目の 1 行目に書いて parseDocument で読み直すと、同じキーと値になる', () => {
        const tags: TagRow[] = [
            ['s.a', []],
            ['s.a', ['x y']],
            ['a b', ['v']],
            ['a:b', ['c']],
            ['123', ['x']],
            ['a,b', []],
            ['a"b', []],
            ['a\\b', []],
            ['note', ['say "hi"']],
            ['k', ['a\\b']],
            ['k', ['a\\']],
            ['owner', ['alice', '山田 太郎', 'a,b']],
        ];
        const failures: string[] = [];
        for (const [key, values] of tags) {
            const mark = format(key, values);
            const read = itemTags(mark);
            if (JSON.stringify(read) !== JSON.stringify([[key, values]])) failures.push(`${JSON.stringify([key, values])} → ${mark} → ${JSON.stringify(read)}`);
        }
        expect(failures).toEqual([]);
    });
});

describe('見出しの詳細 (細部 15、17)', () => {
    it('見出しのすぐ下 (空行をはさんでもよい) の引用は、その見出しの詳細 (項目の詳細と同じ形)', () => {
        for (const gap of ['', '\n', '\n\n']) {
            const source = `${MD}# R\n\n## 設計\n${gap}> 詳細\n\n- 子\n`;
            expect(nodeNamed(source, '設計').details, JSON.stringify(gap)).toBe(quoteParagraph(source, '> 詳細', '詳細'));
        }
    });

    it('見出しの html の引用に詳細の印 (mdag-details) が付き、名前は見出しの行のまま', () => {
        const source = `${MD}# R\n\n## 設計\n\n> 詳細\n`;
        const heading = nodeNamed(source, '設計');
        expect(heading.html).toMatch(/<blockquote [^>]*class="mdag-details"/);
        expect(heading.refText).toBe('設計');
    });

    it('続く引用は 2 つ以上でもつなげ、段落が先に来たあとの引用は詳細にしない', () => {
        const two = `${MD}# R\n\n## 設計\n\n> 一つ目\n\n> 二つ目\n`;
        expect(nodeNamed(two, '設計').details).toBe(`${quoteParagraph(two, '> 一つ目', '一つ目')}\n${quoteParagraph(two, '> 二つ目', '二つ目')}`);
        const cut = `${MD}# R\n\n## 設計\n\n> 一つ目\n\n段落\n\n> 二つ目\n`;
        expect(nodeNamed(cut, '設計').details).toBe(quoteParagraph(cut, '> 一つ目', '一つ目'));
    });

    it('変えない: 段落、リスト、表、コード、HTML のブロック、コメントだけの行、区切り線のあとの引用は詳細にしない', () => {
        const blocks: Array<[string, string]> = [
            ['段落', '段落\n'],
            ['リスト', '- 子\n'],
            ['表', '| a |\n| - |\n| 1 |\n'],
            ['コード', '~~~\ncode\n~~~\n'],
            ['HTML のブロック', '<div>html</div>\n'],
            ['コメントだけの行', '<!-- メモ -->\n'],
            ['区切り線', '***\n'],
        ];
        for (const [name, block] of blocks) expect(nodeNamed(`${MD}# R\n\n## 設計\n\n${block}\n> 引用\n`, '設計').details, name).toBeNull();
    });

    it('変えない: 見出しの lines は見出しの行だけで、見出しの下の段落は読まない', () => {
        const source = `${MD}# R\n\n## 設計\n\n> 詳細\n`;
        const line = source.split('\n').indexOf('## 設計');
        expect(nodeNamed(source, '設計').lines).toEqual({ start: line, end: line + 1 });
        expect(nodeNamed(`${MD}# R\n\n## 設計\n\n段落\n`, '設計').html).toBe('設計');
    });
});

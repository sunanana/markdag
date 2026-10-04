// タグのパネルの行の部品 (DOM を使わない) のうち、絞り込み、選んだノードに付いているタグ、並びのまとめ、入れたキーと値の整え方を確かめる。
// 行はキーと値の組 (値のないタグは value null)。本文に書く形は #キー か #キー:値。絞り込みは入れた文字を含む行だけを出す。
// 入れたキーと値は書き換えの側と同じ規則で整える: キーは前後の空白と先頭の # を外し、値は改行 (5 種類) を空白にして前後の空白を外し、空なら値なし。
// 整えた組は、書き換えのあとに解析で読み戻すタグと同じになる
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';
import type { GraphModel, NodeTag } from '../src/core';
import { attachedTags, filterTags, mergeTags, sameTag, tagChoiceOf, tagText, type TagChoice } from '../src/editor/tags';

const choice = (key: string, value: string | null = null): TagChoice => Object.freeze({ key, value });
const tag = (key: string, values: string[] = []): NodeTag => Object.freeze({ key, values: Object.freeze([...values]) as string[], at: Object.freeze({ line: 1, column: 1, length: 1 }) });
const model = (tagsOf: Array<[number, NodeTag[]]>): Pick<GraphModel, 'tagsOf'> => Object.freeze({ tagsOf: new Map(tagsOf) });

const ROWS: readonly TagChoice[] = Object.freeze([choice('owner', 'alice'), choice('owner', 'bob'), choice('prio', 'high'), choice('team', 'core'), choice('urgent')]);

describe('本文に書く形と同じタグか', () => {
    it('値のあるタグは #キー:値、値のないタグは #キー', () => {
        expect(tagText(choice('owner', 'alice'))).toBe('#owner:alice');
        expect(tagText(choice('urgent'))).toBe('#urgent');
    });

    it('キーと値の両方が同じなら同じタグ。値のないタグと値のあるタグは別', () => {
        expect(sameTag(choice('owner', 'alice'), choice('owner', 'alice'))).toBe(true);
        expect(sameTag(choice('owner', 'alice'), choice('owner', 'bob'))).toBe(false);
        expect(sameTag(choice('owner'), choice('owner', 'alice'))).toBe(false);
        expect(sameTag(choice('owner'), choice('owner'))).toBe(true);
    });
});

describe('絞り込み (B-147)', () => {
    it('空の絞り込みは全部の行を出す (並びはそのまま)', () => {
        expect(filterTags(ROWS, '')).toEqual(ROWS);
    });

    it('キーか値に入れた文字を含む行だけを出す', () => {
        expect(filterTags(ROWS, 'owner')).toEqual([choice('owner', 'alice'), choice('owner', 'bob')]);
        expect(filterTags(ROWS, 'ali')).toEqual([choice('owner', 'alice')]);
        expect(filterTags(ROWS, 'urg')).toEqual([choice('urgent')]);
        expect(filterTags(ROWS, 'zzz')).toEqual([]);
    });

    it('本文に書く形 (#キー:値) の文字でも絞り込める', () => {
        expect(filterTags(ROWS, '#prio')).toEqual([choice('prio', 'high')]);
        expect(filterTags(ROWS, 'owner:b')).toEqual([choice('owner', 'bob')]);
    });

    it('行の欄を保ったまま新しい並びを返し、渡した並びは変えない', () => {
        const rows = Object.freeze([{ key: 'k', value: 'v', state: 'all' as const }, { key: 'x', value: null, state: 'none' as const }]);
        const filtered = filterTags(rows, 'k');
        expect(filtered).toEqual([{ key: 'k', value: 'v', state: 'all' }]);
        expect(filterTags(rows, '')).not.toBe(rows);
    });
});

describe('選んだノードに付いているタグ (タグ追加のパネルの行。B-137)', () => {
    it('キーと値の組ごとに 1 行。値のないタグは value null、同じ組は 1 行', () => {
        const tags = model([
            [2, [tag('owner', ['alice', 'bob']), tag('urgent')]],
            [3, [tag('owner', ['alice']), tag('prio', ['high'])]],
        ]);
        const rows = attachedTags(tags, [2, 3]);
        expect(rows).toHaveLength(4);
        expect(rows).toEqual(expect.arrayContaining([choice('owner', 'alice'), choice('owner', 'bob'), choice('urgent'), choice('prio', 'high')]));
    });

    it('選んだノードに付いていないタグと、選んでいないノードのタグは出さない', () => {
        const tags = model([
            [2, [tag('owner', ['alice'])]],
            [3, [tag('prio', ['high'])]],
        ]);
        expect(attachedTags(tags, [2])).toEqual([choice('owner', 'alice')]);
        expect(attachedTags(tags, [4])).toEqual([]);
        expect(attachedTags(tags, [])).toEqual([]);
    });

    it('1 つのノードでは書いた順', () => {
        const tags = model([[2, [tag('prio', ['high']), tag('owner', ['bob', 'alice'])]]]);
        expect(attachedTags(tags, [2])).toEqual([choice('prio', 'high'), choice('owner', 'bob'), choice('owner', 'alice')]);
    });
});

describe('並びのまとめ (登録されているタグと最近使ったタグ。B-143)', () => {
    it('重なりを除き、キー、値の順に並べる。同じキーでは値のない行が先', () => {
        const merged = mergeTags([choice('team', 'core'), choice('owner', 'bob')], [choice('owner', 'bob'), choice('owner'), choice('owner', 'alice')]);
        expect(merged).toEqual([choice('owner'), choice('owner', 'alice'), choice('owner', 'bob'), choice('team', 'core')]);
    });

    it('渡した並びは変えない', () => {
        const first = Object.freeze([choice('b'), choice('a')]);
        expect(mergeTags(first)).toEqual([choice('a'), choice('b')]);
        expect(first).toEqual([choice('b'), choice('a')]);
    });
});

describe('入れたキーと値の整え方 (B-134、B-140、design 3.5)', () => {
    it('キーは前後の空白と先頭の # を外す', () => {
        expect(tagChoiceOf('owner', 'alice')).toEqual(choice('owner', 'alice'));
        expect(tagChoiceOf('  #owner  ', 'alice')).toEqual(choice('owner', 'alice'));
        expect(tagChoiceOf('#prio', null)).toEqual(choice('prio'));
    });

    it('値は改行 (\\r\\n、\\r、\\n、U+2028、U+2029) を空白 1 つにし、前後の空白を外す。空なら値なし', () => {
        expect(tagChoiceOf('k', 'a\r\nb\rc\nd\u2028e\u2029f')).toEqual(choice('k', 'a b c d e f'));
        expect(tagChoiceOf('k', '  山田 太郎  ')).toEqual(choice('k', '山田 太郎'));
        expect(tagChoiceOf('k', '   ')).toEqual(choice('k'));
        expect(tagChoiceOf('k', '')).toEqual(choice('k'));
        expect(tagChoiceOf('k', null)).toEqual(choice('k'));
    });

    it('整えた組は、そのキーと値でタグを付けた原文を解析して読み戻すタグと同じ', () => {
        const source = '---\nmarkdag:\n---\n# R\n- a\n';
        const inputs: Array<[string, string | null]> = [
            ['owner', 'alice'],
            ['  #owner  ', '  alice  '],
            ['owner', '山田 太郎'],
            ['owner', 'a,b'],
            ['owner', 'x\r\ny'],
            ['owner', 'x\u2028y'],
            ['prio', null],
            ['prio', '   '],
            ['\u3000due\u3000', '\u3000明日\u3000'],
        ];
        for (const [key, value] of inputs) {
            const outcome = core.editSource(source, { kind: 'setTag', nodes: [{ id: 2, refText: 'a' }], key, value, replaceKey: null });
            if (outcome.status !== 'edited') throw new Error(`${JSON.stringify([key, value])}: ${JSON.stringify(outcome)}`);
            const read = core.parseDocument(outcome.source).nodes[1]?.tags ?? [];
            const expected = tagChoiceOf(key, value);
            expect(read.map((item) => ({ key: item.key, values: item.values })), JSON.stringify([key, value])).toEqual([{ key: expected.key, values: expected.value === null ? [] : [expected.value] }]);
        }
    });
});

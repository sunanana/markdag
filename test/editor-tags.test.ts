// タグのパネルに出す中身の部品 (DOM を使わない) を確かめる。
// 登録されているタグ、付いている数の状態 (toggleTag の付いているかの見方と同じ)、最近使ったタグ (編集の層が mount の間だけ覚える) を見る。
// パネルの開閉、行の押下、絞り込みの欄、置き場、キーの候補は DOM の受け持ちなので e2e のタグのテストで確かめる。
// 部品の形 (このテストが確かめる約束):
//     interface TagChoice { key: string; value: string | null }
//         タグ選択の 1 行。値のないタグ (#キー) と markdag.tags.keys のキーは value が null
//     type TagState = 'all' | 'some' | 'none'
//     registeredTags(model: Pick<GraphModel, 'tagsOf' | 'tagKeys'>): TagChoice[]
//         登録されているタグ: 文書で使われているタグ (値ごとに 1 行。値のないタグは value null) と、markdag.tags.keys のキー (value null)。
//         同じキーと値は 1 行。並びはキー、値の順 (文書に書いた順によらない)
//     tagState(model: Pick<GraphModel, 'tagsOf'>, nodes: readonly number[], tag: TagChoice): TagState
//         選んだノードのうち、そのタグを持つノードの数の状態。全部なら all、一部なら some、どれも持たない (選んでいない) なら none。
//         value のある行は、そのキーにその値があるノードを数える。value が null の行は、そのキーのタグがあるノードを数える (値は問わない。
//         toggleTag の値のない付け外しと同じ見方。全部にあれば押すとキーごと外れる)。tagsOf にないノードはタグを持たない
//     rememberTag(recent: readonly TagChoice[], tag: TagChoice): TagChoice[]
//         付けたタグを最近使ったタグの先頭に置いた新しい並びを返す。同じキーと値は前のものを外し、3 つまで覚える (古いものから落とす)
// 行のオブジェクトの欄は上の欄だけを見る (ほかの欄を足してもよい)。値の並べ方は ASCII の小文字だけで確かめる (日本語と大文字の並べ方は決めない)
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '../src/core';
import type { GraphModel, NodeTag, TagKeyDef } from '../src/core';
import { registeredTags, rememberTag, tagState, type TagChoice, type TagState } from '../src/editor/tags';

type TagsModel = Pick<GraphModel, 'tagsOf' | 'tagKeys'>;

// 部品が入力を書き換えないよう、凍らせて渡す
const tag = (key: string, values: string[] = []): NodeTag => Object.freeze({ key, values: Object.freeze([...values]) as string[], at: Object.freeze({ line: 1, column: 1, length: 1 }) });

const keyDef = (key: string, multiple = false): TagKeyDef =>
    Object.freeze({ key, alternatives: Object.freeze([Object.freeze({ primitive: 'string' as const })]) as TagKeyDef['alternatives'], multiple, unique: false, description: null });

function model(tagsOf: Array<[number, NodeTag[]]>, tagKeys: TagKeyDef[] = []): TagsModel {
    return Object.freeze({ tagsOf: new Map(tagsOf.map(([id, tags]) => [id, Object.freeze([...tags]) as NodeTag[]])), tagKeys: Object.freeze([...tagKeys]) as TagKeyDef[] });
}

const choice = (key: string, value: string | null = null): TagChoice => Object.freeze({ key, value });

// 行のうち、上の約束の欄だけを取り出す
const picked = (rows: readonly TagChoice[]): TagChoice[] => rows.map(({ key, value }) => ({ key, value }));

// ノードは 1〜6。書いた順はキーと値の順と違えてある (並べ直すことを見るため)。
// 2 は prio:high と owner:bob、3 は owner:alice,bob (複数の値)、4 は値のない urgent、5 は team:core、6 は team:core と prio:low
const TAGS_OF: Array<[number, NodeTag[]]> = [
    [1, []],
    [2, [tag('prio', ['high']), tag('owner', ['bob'])]],
    [3, [tag('owner', ['alice', 'bob'])]],
    [4, [tag('urgent')]],
    [5, [tag('team', ['core'])]],
    [6, [tag('team', ['core']), tag('prio', ['low'])]],
];

const USED: TagChoice[] = [
    { key: 'owner', value: 'alice' },
    { key: 'owner', value: 'bob' },
    { key: 'prio', value: 'high' },
    { key: 'prio', value: 'low' },
    { key: 'team', value: 'core' },
    { key: 'urgent', value: null },
];

describe('登録されているタグ (registeredTags。B-143)', () => {
    it('文書で使われているタグを値ごとに 1 行にし (複数の値のタグは値ごと、値のないタグは value null)、同じキーと値は 1 行にまとめ、キー、値の順に並べる', () => {
        expect(picked(registeredTags(model(TAGS_OF)))).toEqual(USED);
    });

    it('markdag.tags.keys のキー (文書で使われていないもの) も value null の 1 行で入り、キーの順に混ざる', () => {
        const rows = registeredTags(model(TAGS_OF, [keyDef('status'), keyDef('area', true)]));
        expect(picked(rows)).toEqual([{ key: 'area', value: null }, ...USED.slice(0, 4), { key: 'status', value: null }, ...USED.slice(4)]);
    });

    it('タグもキーの定義もない文書では空', () => {
        expect(registeredTags(model([[1, []]]))).toEqual([]);
        expect(registeredTags(model([]))).toEqual([]);
    });

    it('値のないタグの value は null で、空の文字ではない', () => {
        const urgent = registeredTags(model(TAGS_OF)).find((row: TagChoice) => row.key === 'urgent');
        expect(urgent?.value).toBeNull();
    });

    it('描いた文書のモデル (parseDocument と buildModel) からも同じ形で作れる (タグのある文書と markdag.tags.keys)', () => {
        const source = [
            '---',
            'markdag:',
            '    tags:',
            '        keys:',
            '            status:',
            '                type: string',
            '---',
            '# Root',
            '',
            '- Task A #team:core #prio:high #owner:alice',
            '- Task B #team:core #owner:bob',
            '- Task C',
            '- Leaf #team:core #owner:alice #prio:low #urgent',
            '',
        ].join('\n');
        const parsed = core.parseDocument(source);
        const built = core.buildModel(parsed.nodes, parsed.frontmatter, source);
        expect(picked(registeredTags(built))).toEqual([
            { key: 'owner', value: 'alice' },
            { key: 'owner', value: 'bob' },
            { key: 'prio', value: 'high' },
            { key: 'prio', value: 'low' },
            { key: 'status', value: null },
            { key: 'team', value: 'core' },
            { key: 'urgent', value: null },
        ]);
    });
});

describe('付いている数の状態 (tagState。B-144)', () => {
    const tagsModel = model(TAGS_OF);

    it('値のある行: 選んだノードの全部にそのキーと値があれば all、一部なら some、どれにもなければ none (複数の値のタグは値ごとに見る)', () => {
        const nodes = [2, 3];
        expect(tagState(tagsModel, nodes, choice('owner', 'bob'))).toBe('all');
        expect(tagState(tagsModel, nodes, choice('owner', 'alice'))).toBe('some');
        expect(tagState(tagsModel, nodes, choice('prio', 'high'))).toBe('some');
        expect(tagState(tagsModel, nodes, choice('prio', 'low'))).toBe('none');
        expect(tagState(tagsModel, nodes, choice('team', 'core'))).toBe('none');
    });

    it('同じキーでも値が違えば持たない数に入る (owner:bob の行に、owner:alice だけのノードは数えない)', () => {
        const only = model([...TAGS_OF, [7, [tag('owner', ['alice'])]]]);
        expect(tagState(only, [3, 7], choice('owner', 'alice'))).toBe('all');
        expect(tagState(only, [3, 7], choice('owner', 'bob'))).toBe('some');
        expect(tagState(only, [7], choice('owner', 'bob'))).toBe('none');
    });

    it('値のない行 (value null): そのキーのタグがあるノードを数える (値は問わない)', () => {
        expect(tagState(tagsModel, [4], choice('urgent'))).toBe('all');
        expect(tagState(tagsModel, [3, 4], choice('urgent'))).toBe('some');
        expect(tagState(tagsModel, [2, 3], choice('owner'))).toBe('all');
        expect(tagState(tagsModel, [2, 4], choice('owner'))).toBe('some');
        expect(tagState(tagsModel, [1, 5], choice('status'))).toBe('none');
    });

    it('ノードが 1 つなら all か none。選んでいなければ none。tagsOf にないノードはタグを持たない', () => {
        expect(tagState(tagsModel, [5], choice('team', 'core'))).toBe('all');
        expect(tagState(tagsModel, [1], choice('team', 'core'))).toBe('none');
        expect(tagState(tagsModel, [], choice('team', 'core'))).toBe('none');
        expect(tagState(tagsModel, [99], choice('team', 'core'))).toBe('none');
        expect(tagState(tagsModel, [5, 99], choice('team', 'core'))).toBe('some');
    });
});

describe('最近使ったタグ (rememberTag。B-142)', () => {
    const owner = choice('owner', 'alice');
    const prio = choice('prio', 'high');
    const team = choice('team', 'core');
    const urgent = choice('urgent');

    it('付けたタグを先頭に置き、新しい順に並べる', () => {
        const first = rememberTag([], owner);
        expect(picked(first)).toEqual([owner]);
        const second = rememberTag(first, prio);
        expect(picked(second)).toEqual([prio, owner]);
        expect(picked(rememberTag(second, urgent))).toEqual([urgent, prio, owner]);
    });

    it('3 つまで覚え、4 つ目を付けると一番古いものが落ちる', () => {
        expect(picked(rememberTag([urgent, prio, owner], team))).toEqual([team, urgent, prio]);
    });

    it('もう覚えているタグを付けると、前のものを外して先頭に移す (同じタグが 2 行にならない)', () => {
        expect(picked(rememberTag([urgent, prio, owner], owner))).toEqual([owner, urgent, prio]);
        expect(picked(rememberTag([urgent, prio, owner], choice('urgent')))).toEqual([urgent, prio, owner]);
    });

    it('同じキーでも値が違えば別のタグ。値のないタグと値のあるタグも別', () => {
        expect(picked(rememberTag([owner], choice('owner', 'bob')))).toEqual([choice('owner', 'bob'), owner]);
        expect(picked(rememberTag([urgent], choice('urgent', 'yes')))).toEqual([choice('urgent', 'yes'), urgent]);
    });

    it('渡した並びを書き換えず、新しい並びを返す', () => {
        const recent = Object.freeze([prio, owner]) as readonly TagChoice[];
        const next = rememberTag(recent, team);
        expect(next).not.toBe(recent);
        expect(picked(recent)).toEqual([prio, owner]);
    });
});

describe('型', () => {
    it('部品の形', () => {
        // { key, value } だけのオブジェクトを渡せ、key と value を読める
        expectTypeOf<{ key: string; value: string | null }>().toExtend<TagChoice>();
        expectTypeOf<TagChoice>().toExtend<{ key: string; value: string | null }>();
        expectTypeOf<TagState>().toEqualTypeOf<'all' | 'some' | 'none'>();
        expectTypeOf(registeredTags).parameters.toEqualTypeOf<[TagsModel]>();
        expectTypeOf(registeredTags).returns.toEqualTypeOf<TagChoice[]>();
        expectTypeOf(tagState).parameters.toEqualTypeOf<[Pick<GraphModel, 'tagsOf'>, readonly number[], TagChoice]>();
        expectTypeOf(tagState).returns.toEqualTypeOf<TagState>();
        expectTypeOf(rememberTag).parameters.toEqualTypeOf<[readonly TagChoice[], TagChoice]>();
        expectTypeOf(rememberTag).returns.toEqualTypeOf<TagChoice[]>();
        // 描いた文書のモデルをそのまま渡せる
        expectTypeOf<GraphModel>().toExtend<TagsModel>();
    });
});

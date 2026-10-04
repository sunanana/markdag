// 凡例のパネル (線の色・グループ) の中身の組み立て (DOM を使わない部品) を確かめる。
// 初めの開閉と閲覧での出し方、線の色の段は 1 行に 1 つ、を見る。「出すが最初は閉じる」の指定は持たない (依頼者の決め)。
// 開閉の操作、行のボタン、ロゴ、隅、カラーピッカー、名前の入力は DOM の受け持ちなので e2e の凡例のパネルのテストで確かめる。
// 部品の形 (このテストが確かめる約束):
//     type LegendSection = 'branches' | 'groups'
//     interface LegendGroupRow { id: string; label: string; color: string | null; boundary: boolean; count: number }
//         count はそのグループに入っているノードの数 (model.groupsOf でそのグループを持つノードの数。配下を含む)
//     interface LegendContent {
//         sections: LegendSection[]      出す段 (上から順。線の色が上、グループが下)
//         branches: BranchColor[]        線の色の段の行 (branchColors の並び。段を出さないときは空)
//         groups: LegendGroupRow[]       グループの段の行 (model.groups の並び。段を出さないときは空)
//         branchGuide: boolean           線の色の段に markdag.branches の書き方を案内するか
//     }
//     legendContent(model: Pick<GraphModel, 'groups' | 'groupsOf' | 'legend'>, branches: readonly BranchColor[], mode: EditorMode): LegendContent | null
//         閲覧: 出す段は legend.display (model.legend) に従い、中身のない段は出さない。出す段がなければ null (パネルを出さない)。案内はしない。
//         GUI 編集: 段は指定によらず両方。起点がなければ (branches が空) 案内する。null にはしない
//     initialLegendOpen(display: readonly LegendItem[]): boolean
//         GUI 編集で始めるときと、出す指定が変わったときの開閉。legend.display が false (model.legend が空) なら閉じる、そうでなければ開く
//     sameLegendDisplay(a: readonly LegendItem[], b: readonly LegendItem[]): boolean
//         出す指定が前の描画から変わったか (変わったときだけ開閉を初めの状態に戻す) の比べ方。出す項目が同じなら並びによらず同じ
// 行のオブジェクトの欄は上の欄だけを見る (ほかの欄を足してもよい)
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { BranchColor, GraphModel, GroupDef, LegendItem } from '../src/core';
import { initialLegendOpen, legendContent, sameLegendDisplay, type LegendContent, type LegendGroupRow, type LegendSection } from '../src/editor/legend';
import type { EditorMode } from '../src/editor/settings';

type LegendModel = Pick<GraphModel, 'groups' | 'groupsOf' | 'legend'>;

const group = (id: string, label: string, color: string | null, boundary: boolean, defined = true): GroupDef => Object.freeze({ id, label, color, boundary, defined });

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。Design と配下が design、Build と配下が build に入る。
// Task B には定義のないグループ loose も付いている。empty は定義だけでノードがいない
const GROUPS: readonly GroupDef[] = Object.freeze([
    group('design', '設計', '#3B7DD8', true),
    group('build', '実装', '#E8833A', false),
    group('empty', '空', null, false),
    group('loose', 'loose', null, false, false),
]);
const GROUPS_OF: ReadonlyMap<number, string[]> = new Map([
    [1, []],
    [2, ['design']],
    [3, ['design']],
    [4, ['design', 'loose']],
    [5, ['build']],
    [6, ['build']],
]);
const BRANCHES: readonly BranchColor[] = Object.freeze([Object.freeze({ id: 2, label: 'Design', color: '#d9480f' }), Object.freeze({ id: 5, label: 'Build', color: '#2b8a3e' })]);

const EXPECTED_GROUP_ROWS: LegendGroupRow[] = [
    { id: 'design', label: '設計', color: '#3B7DD8', boundary: true, count: 3 },
    { id: 'build', label: '実装', color: '#E8833A', boundary: false, count: 2 },
    { id: 'empty', label: '空', color: null, boundary: false, count: 0 },
    { id: 'loose', label: 'loose', color: null, boundary: false, count: 1 },
];

// 部品が入力を書き換えないよう、凍らせて渡す
function model(legend: LegendItem[], groups: readonly GroupDef[] = GROUPS, groupsOf: ReadonlyMap<number, string[]> = GROUPS_OF): LegendModel {
    return Object.freeze({ groups: groups as GroupDef[], groupsOf: groupsOf as Map<number, string[]>, legend: Object.freeze([...legend]) as LegendItem[] });
}

const BOTH: LegendItem[] = ['groups', 'branches'];

// 中身のうち、上の約束の欄だけを取り出す
function picked(content: LegendContent | null): { sections: LegendSection[]; branches: BranchColor[]; groups: LegendGroupRow[]; branchGuide: boolean } | null {
    if (content === null) return null;
    return {
        sections: [...content.sections],
        branches: content.branches.map(({ id, label, color }) => ({ id, label, color })),
        groups: content.groups.map(({ id, label, color, boundary, count }) => ({ id, label, color, boundary, count })),
        branchGuide: content.branchGuide,
    };
}

describe('閲覧のパネルの中身 (legendContent の view。5.2 の軸 F の閲覧の出し方、B-153、B-154)', () => {
    it('指定がなければ (groups と branches)、上が線の色、下がグループの 2 段。線の色の行は branchColors の並び、グループの行は model.groups の並び。案内はしない (B-150、B-154)', () => {
        expect(picked(legendContent(model(BOTH), BRANCHES, 'view'))).toEqual({ sections: ['branches', 'groups'], branches: [...BRANCHES], groups: EXPECTED_GROUP_ROWS, branchGuide: false });
    });

    it('段の上下は、display に書いた並びによらず、線の色が上でグループが下 (B-150)', () => {
        expect(legendContent(model(['branches', 'groups']), BRANCHES, 'view')?.sections).toEqual(['branches', 'groups']);
        expect(legendContent(model(['groups', 'branches']), BRANCHES, 'view')?.sections).toEqual(['branches', 'groups']);
    });

    it('出す段は display の指定どおりで、出さない段の行は空 (B-154)', () => {
        expect(picked(legendContent(model(['groups']), BRANCHES, 'view'))).toEqual({ sections: ['groups'], branches: [], groups: EXPECTED_GROUP_ROWS, branchGuide: false });
        expect(picked(legendContent(model(['branches']), BRANCHES, 'view'))).toEqual({ sections: ['branches'], branches: [...BRANCHES], groups: [], branchGuide: false });
    });

    it('legend.display が false (model.legend が空) なら null で、パネルごと出さない (B-153)', () => {
        expect(legendContent(model([]), BRANCHES, 'view')).toBeNull();
    });

    it('中身のない段は出さない。起点がなければグループの段だけで案内もしない。グループがなければ線の色の段だけ。どちらもなければ null (B-154、10.2 の B-151)', () => {
        expect(picked(legendContent(model(BOTH), [], 'view'))).toEqual({ sections: ['groups'], branches: [], groups: EXPECTED_GROUP_ROWS, branchGuide: false });
        expect(picked(legendContent(model(BOTH, [], new Map([[1, []]])), BRANCHES, 'view'))).toEqual({ sections: ['branches'], branches: [...BRANCHES], groups: [], branchGuide: false });
        expect(legendContent(model(BOTH, [], new Map([[1, []]])), [], 'view')).toBeNull();
        // 出す段に選んだ段が空なら、ほかの段に中身があっても出さない
        expect(legendContent(model(['branches']), [], 'view')).toBeNull();
        expect(legendContent(model(['groups'], [], new Map([[1, []]])), BRANCHES, 'view')).toBeNull();
    });
});

describe('GUI 編集のパネルの中身 (legendContent の edit。B-151、B-156)', () => {
    it('段は legend.display の指定によらず両方 (線の色が上、グループが下)。行は全部出す (B-156)', () => {
        for (const legend of [BOTH, ['groups'], ['branches'], []] as LegendItem[][]) {
            expect(picked(legendContent(model(legend), BRANCHES, 'edit')), JSON.stringify(legend)).toEqual({
                sections: ['branches', 'groups'],
                branches: [...BRANCHES],
                groups: EXPECTED_GROUP_ROWS,
                branchGuide: false,
            });
        }
    });

    it('起点がなければ、線の色の段に markdag.branches の書き方を案内する (行はない) (B-151、10.2 の B-151)', () => {
        for (const legend of [BOTH, ['groups'], []] as LegendItem[][]) {
            expect(picked(legendContent(model(legend), [], 'edit')), JSON.stringify(legend)).toEqual({ sections: ['branches', 'groups'], branches: [], groups: EXPECTED_GROUP_ROWS, branchGuide: true });
        }
    });

    it('グループも起点もない文書でも、両方の段を出す (null にしない)', () => {
        expect(picked(legendContent(model(BOTH, [], new Map([[1, []]])), [], 'edit'))).toEqual({ sections: ['branches', 'groups'], branches: [], groups: [], branchGuide: true });
    });
});

describe('グループの行 (B-162)', () => {
    it('ノードの数は、そのグループを持つノード (配下を含む。model.groupsOf) の数。定義だけのグループは 0、定義のないグループも行になる', () => {
        const rows = legendContent(model(BOTH), BRANCHES, 'edit')?.groups ?? [];
        expect(rows.map((row) => [row.id, row.count])).toEqual([
            ['design', 3],
            ['build', 2],
            ['empty', 0],
            ['loose', 1],
        ]);
    });

    it('ノードを足すと数が増える (同じ部品に描き直したあとのモデルを渡す)', () => {
        const added = new Map(GROUPS_OF);
        added.set(6, ['build', 'design']);
        const rows = legendContent(model(BOTH, GROUPS, added), BRANCHES, 'edit')?.groups ?? [];
        expect(rows.find((row) => row.id === 'design')?.count).toBe(4);
        expect(rows.find((row) => row.id === 'build')?.count).toBe(2);
    });

    it('名前、色、枠の有無は model.groups のまま (色のないグループは null)', () => {
        const rows = legendContent(model(BOTH), BRANCHES, 'view')?.groups ?? [];
        expect(rows.map(({ id, label, color, boundary }) => ({ id, label, color, boundary }))).toEqual(EXPECTED_GROUP_ROWS.map(({ id, label, color, boundary }) => ({ id, label, color, boundary })));
    });
});

describe('開閉の初めの状態 (initialLegendOpen、sameLegendDisplay。5.2 の軸 F、B-157、Q6)', () => {
    it('legend.display が false (model.legend が空) なら閉じて、出す指定なら開いて始める。「出すが最初は閉じる」の指定はない (B-157、Q6)', () => {
        expect(initialLegendOpen([])).toBe(false);
        expect(initialLegendOpen(['groups', 'branches'])).toBe(true);
        expect(initialLegendOpen(['groups'])).toBe(true);
        expect(initialLegendOpen(['branches'])).toBe(true);
    });

    it('出す指定が変わったかは出す項目で比べ、並びは見ない (B-157)', () => {
        expect(sameLegendDisplay(['groups', 'branches'], ['groups', 'branches'])).toBe(true);
        expect(sameLegendDisplay(['groups', 'branches'], ['branches', 'groups'])).toBe(true);
        expect(sameLegendDisplay([], [])).toBe(true);
        expect(sameLegendDisplay(['groups', 'branches'], ['groups'])).toBe(false);
        expect(sameLegendDisplay(['groups'], ['branches'])).toBe(false);
        expect(sameLegendDisplay(['groups'], [])).toBe(false);
        expect(sameLegendDisplay([], ['branches'])).toBe(false);
    });
});

describe('部品の形', () => {
    it('入力を書き換えない (凍らせた入力で投げない)。呼ぶたびに同じ答え', () => {
        const input = model(BOTH);
        const first = picked(legendContent(input, BRANCHES, 'edit'));
        expect(picked(legendContent(input, BRANCHES, 'edit'))).toEqual(first);
        expect([...input.groupsOf]).toEqual([...GROUPS_OF]);
    });

    it('型: 引数と戻り値', () => {
        expectTypeOf(legendContent).parameters.toEqualTypeOf<[LegendModel, readonly BranchColor[], EditorMode]>();
        expectTypeOf(legendContent).returns.toEqualTypeOf<LegendContent | null>();
        expectTypeOf(initialLegendOpen).parameters.toEqualTypeOf<[readonly LegendItem[]]>();
        expectTypeOf(initialLegendOpen).returns.toEqualTypeOf<boolean>();
        expectTypeOf(sameLegendDisplay).returns.toEqualTypeOf<boolean>();
        expectTypeOf<LegendSection>().toEqualTypeOf<'branches' | 'groups'>();
    });
});

import { describe, expect, it } from 'vitest';
import type { NodeTag, OutlineNode } from '../src/parse/document';
import { buildModel, checkFrontmatter } from '../src/model/model';
import { suggestTagKeys, suggestTagValues } from '../src/model/tags';

// [参照用のテキスト, 親の位置 (0 始まり。ルートは null), グループ, $id, タグ]
type Row = [string, number | null, string[]?, string?, NodeTag[]?];

function outline(rows: Row[]): OutlineNode[] {
    const nodes: OutlineNode[] = [];
    rows.forEach(([refText, parentIndex, groups, refId, tags], index) => {
        const parent = parentIndex === null ? null : (nodes[parentIndex] ?? null);
        nodes.push({
            id: index + 1,
            parent: parent?.id ?? null,
            depth: (parent?.depth ?? 0) + 1,
            html: refText,
            refText,
            refId: refId ?? null,
            groups: groups ?? [],
            tags: tags ?? [],
            milestone: false,
            foldHint: 0,
            lines: null,
            task: null,
            details: null,
        });
    });
    return nodes;
}

// fixture の「新機能エピック」と同じ木
const EPIC = outline([
    ['新機能エピック', null],
    ['仕様策定', 0],
    ['画面開発', 1, ['frontend']],
    ['一覧画面', 2],
    ['登録画面', 2],
    ['API開発', 1, ['backend']],
    ['登録API POST /items', 5],
    ['削除API DELETE /items/:id', 5],
    ['一覧取得API GET /items', 5],
    ['開発完了', 0],
    ['リリース準備', 0],
    ['デプロイ手順の確認', 10, ['backend']],
    ['ロールバック手順の確認', 10, ['backend']],
    ['受け入れテスト', 10, ['qa']],
    ['リリースノート作成', 0],
    ['リリース', 0],
    ['効果測定', 0, ['backend', 'frontend']],
]);

const EPIC_FRONTMATTER = {
    markdag: {
        relations: {
            join: ['仕様策定/* --> 開発完了'],
            chain: ['開発完了 --> リリース準備 --> リリースノート作成 --> リリース --> 効果測定'],
            depends: ['登録API --> 登録画面'],
        },
        groups: {
            backend: { label: 'バックエンド', color: '#D64545', boundary: true },
            frontend: { label: 'フロントエンド', color: '#3B7DD8', boundary: true },
            qa: { label: 'QA', color: '#E0A100' },
        },
    },
};

const pairs = (model: ReturnType<typeof buildModel>, kind: string): string[] =>
    model.relations.filter((relation) => relation.kind === kind).map((relation) => `${relation.source}>${relation.target}`);

describe('model 層', () => {
    it('「新機能エピック」の relations を、手で書き起こしたエッジと同じに展開する', () => {
        const model = buildModel(EPIC, EPIC_FRONTMATTER);
        expect(model.diagnostics).toEqual([
            {
                severity: 'info',
                code: 'ref-prefix',
                message: '「登録API --> 登録画面」: 「登録API」は前方一致で「登録API POST /items」に解決しました',
                at: null,
                hint: '書き間違いなら「登録API POST /items」に直します',
            },
        ]);
        expect(pairs(model, 'join')).toEqual(['4>10', '5>10', '7>10', '8>10', '9>10']);
        expect(pairs(model, 'chain')).toEqual(['10>11', '11>15', '15>16', '16>17']);
        // 「登録API」は前方一致、「リリース」は完全一致が優先される
        expect(pairs(model, 'depends')).toEqual(['7>5']);
        expect(model.suppressRootLine).toEqual([10, 11, 15, 16, 17]);
    });

    it('グループの所属は配下に継承し、groups の定義順に並べる', () => {
        const model = buildModel(EPIC, EPIC_FRONTMATTER);
        expect(model.groupsOf.get(7)).toEqual(['backend']);
        expect(model.groupsOf.get(4)).toEqual(['frontend']);
        expect(model.groupsOf.get(17)).toEqual(['backend', 'frontend']);
        expect(model.groupsOf.get(2)).toEqual([]);
    });

    it('$id、パス、& を解決する', () => {
        const nodes = outline([
            ['root', null],
            ['A', 0],
            ['確認', 1],
            ['B', 0],
            ['確認', 3],
            ['C', 0, [], 'goal'],
        ]);
        const model = buildModel(nodes, { markdag: { relations: { join: ['A/確認 & B/確認 --> $goal'] } } });
        expect(model.diagnostics).toEqual([]);
        expect(pairs(model, 'join')).toEqual(['3>6', '5>6']);
    });

    it('詳細の見せ方は frontmatter の markdag.details.display で指定でき、使えない値は警告にして指定なしとして扱う', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).detailsMode).toBeNull();
        expect(buildModel(nodes, { markdag: { details: {} } }).detailsMode).toBeNull();
        expect(buildModel(nodes, { markdag: { details: { display: 'always' } } }).detailsMode).toBe('always');
        const invalid = buildModel(nodes, { markdag: { details: { display: 'open' } } });
        expect(invalid.detailsMode).toBeNull();
        expect(invalid.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
    });

    it('凡例に出す項目は frontmatter の markdag.legend.display で指定でき、指定がなければグループと枝を出す', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).legend).toEqual(['groups', 'branches']);
        expect(buildModel(nodes, { markdag: { legend: {} } }).legend).toEqual(['groups', 'branches']);
        expect(buildModel(nodes, { markdag: { legend: { display: true } } }).legend).toEqual(['groups', 'branches']);
        expect(buildModel(nodes, { markdag: { legend: { display: false } } }).legend).toEqual([]);
        expect(buildModel(nodes, { markdag: { legend: { display: ['branches'] } } }).legend).toEqual(['branches']);

        const unknown = buildModel(nodes, { markdag: { legend: { display: ['groups', 'lines'] } } });
        expect(unknown.legend).toEqual(['groups']);
        expect(unknown.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        const wrongType = buildModel(nodes, { markdag: { legend: { display: 'all' } } });
        expect(wrongType.legend).toEqual(['groups', 'branches']);
        expect(wrongType.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
    });

    it('凡例を置く隅は frontmatter の markdag.legend.position で指定でき、指定がなければ右上に置く', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).legendPosition).toBe('top-right');
        expect(buildModel(nodes, { markdag: { legend: { display: ['groups'] } } }).legendPosition).toBe('top-right');
        for (const position of ['top-right', 'top-left', 'bottom-right', 'bottom-left']) {
            const model = buildModel(nodes, { markdag: { legend: { position } } });
            expect(model.legendPosition).toBe(position);
            expect(model.diagnostics).toEqual([]);
        }

        const invalid = buildModel(nodes, { markdag: { legend: { position: 'bottom-rigth' } } });
        expect(invalid.legendPosition).toBe('top-right');
        expect(invalid.diagnostics[0]).toMatchObject({
            code: 'option-invalid',
            message: 'markdag.legend.position に指定できるのは top-right, top-left, bottom-right, bottom-left です ("bottom-rigth")',
        });
        expect(invalid.diagnostics[0]?.hint).toContain('bottom-right');
    });

    it('一覧や真偽値を legend に直接書く前の形は、警告にして指定なしとして扱う', () => {
        const nodes = outline([['root', null]]);
        for (const old of [false, ['branches']]) {
            const model = buildModel(nodes, { markdag: { legend: old } });
            expect(model.legend).toEqual(['groups', 'branches']);
            expect(model.legendPosition).toBe('top-right');
            expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
            expect(model.diagnostics[0]?.message).toContain('markdag.legend はキーと値の組で書きます');
            expect(model.diagnostics[0]?.hint).toContain('display');
        }
        const unknownKey = buildModel(nodes, { markdag: { legend: { pos: 'top-left' } } });
        expect(unknownKey.diagnostics.map((item) => item.code)).toEqual(['option-unknown']);
    });

    it('線をクリックしての強調は frontmatter の markdag.edgeHighlight で切れる (既定は使える)', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).edgeHighlight).toBe(true);
        expect(buildModel(nodes, { markdag: {} }).edgeHighlight).toBe(true);
        expect(buildModel(nodes, { markdag: { edgeHighlight: true } }).edgeHighlight).toBe(true);
        expect(buildModel(nodes, { markdag: { edgeHighlight: false } }).edgeHighlight).toBe(false);
        // 真偽値でない値はスキーマが警告にして、指定なしと同じ扱いにする
        const invalid = buildModel(nodes, { markdag: { edgeHighlight: 'no' } });
        expect(invalid.edgeHighlight).toBe(true);
        expect(invalid.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
    });

    it('グループの枠をクリックしての強調は frontmatter の markdag.groupHighlight で切れる (既定は使える)', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).groupHighlight).toBe(true);
        expect(buildModel(nodes, { markdag: { groupHighlight: true } }).groupHighlight).toBe(true);
        expect(buildModel(nodes, { markdag: { groupHighlight: false } }).groupHighlight).toBe(false);
        const invalid = buildModel(nodes, { markdag: { groupHighlight: 'no' } });
        expect(invalid.groupHighlight).toBe(true);
        expect(invalid.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
    });

    it('色を分ける枝の起点は frontmatter の markdag.branches で指定でき、1 ノードでない指定と解決できない指定は警告にする', () => {
        const nodes = outline([
            ['root', null],
            ['A', 0],
            ['確認', 1],
            ['B', 0],
        ]);
        expect(buildModel(nodes, {}).branches).toEqual([]);
        expect(buildModel(nodes, { markdag: { branches: ['B', 'A/確認'] } }).branches).toEqual([4, 3]);

        const invalid = buildModel(nodes, { markdag: { branches: ['A/*', '(B)', 'C', 3, 'B', 'B'] } });
        expect(invalid.branches).toEqual([4]);
        // 先の 2 件はスキーマが出すもの (文字列でない項目と、同じ項目の重なり)。あとの 3 件は木を見ないと決まらないもの
        expect(invalid.diagnostics.map((item) => item.code)).toEqual([
            'option-invalid',
            'option-invalid',
            'option-invalid',
            'option-invalid',
            'ref-not-found',
        ]);
        expect(invalid.diagnostics[4]?.message).toBe('markdag.branches: 「C」に一致するノードがありません');
        const wrongType = buildModel(nodes, { markdag: { branches: 'A' } });
        expect(wrongType.branches).toEqual([]);
        expect(wrongType.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
    });

    it('名前の先頭だけが一致した参照は、書き間違いに気づけるよう参考の診断に出す', () => {
        const nodes = outline([
            ['root', null],
            ['リリース', 0],
            ['開発', 0],
        ]);
        const model = buildModel(nodes, { markdag: { branches: ['リリー'], relations: { chain: ['開発 --> リリース'] } } });
        expect(model.branches).toEqual([2]);
        expect(model.diagnostics).toEqual([
            {
                severity: 'info',
                code: 'ref-prefix',
                message: 'markdag.branches: 「リリー」は前方一致で「リリース」に解決しました',
                at: null,
                hint: '書き間違いなら「リリース」に直します',
            },
        ]);
    });

    it('原文を渡すと、診断に frontmatter での位置と、近い名前の手がかりが付く', () => {
        const nodes = outline([
            ['root', null],
            ['リリース', 0],
            ['開発', 0],
        ]);
        const markdown = ['---', 'markdag:', '    branches:', '        - 開発', '        - リリーズ', '---', '', '# root'].join('\n');
        const model = buildModel(nodes, { markdag: { branches: ['開発', 'リリーズ'] } }, markdown);
        expect(model.branches).toEqual([3]);
        expect(model.diagnostics).toEqual([
            {
                severity: 'warning',
                code: 'ref-not-found',
                message: 'markdag.branches: 「リリーズ」に一致するノードがありません',
                at: { line: 5, column: 11, length: 4 },
                hint: 'もしかして「リリース」',
            },
        ]);
    });

    it('式の中の参照は、その語が式に 1 つだけあるときはその桁を指す', () => {
        const nodes = outline([
            ['root', null],
            ['開発', 0],
            ['リリース', 0],
        ]);
        const markdown = ['---', 'markdag:', '    relations:', '        chain:', '            - 開発 --> リリーズ', '---', '', '# root'].join('\n');
        const model = buildModel(nodes, { markdag: { relations: { chain: ['開発 --> リリーズ'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.at)).toEqual([{ line: 5, column: 22, length: 4 }]);
    });

    it('markdag の下の知らないキーと、markdag の外に置かれた指定を警告にする', () => {
        const nodes = outline([['root', null]]);
        const unknown = buildModel(nodes, { markdag: { branch: ['A'] } });
        expect(unknown.diagnostics.map((item) => item.code)).toEqual(['option-unknown']);
        const misplaced = buildModel(nodes, { branches: ['A'], relations: { chain: ['A --> B'] }, markdag: {} });
        expect(misplaced.branches).toEqual([]);
        expect(misplaced.relations).toEqual([]);
        expect(misplaced.diagnostics.map((item) => item.code)).toEqual(['option-misplaced', 'option-misplaced']);
    });

    it('あいまいな参照、見つからない参照、閉路、未知のキーを診断にして、描画は続けられる形で返す', () => {
        const nodes = outline([
            ['root', null],
            ['A', 0],
            ['確認', 1],
            ['B', 0],
            ['確認', 3],
        ]);
        const model = buildModel(nodes, {
            markdag: {
                relations: {
                    depends: ['確認 --> A', 'なし --> A', 'A --> B', 'B --> A', 'A -> B'],
                    flow: ['A --> B'],
                },
            },
        });
        // 形と型の検査 (--> のない式、知らないキー) が先に並び、そのあとに木とグラフを見る検査が続く
        expect(model.diagnostics.map((item) => item.code)).toEqual([
            'relation-syntax',
            'relation-unknown-key',
            'ref-ambiguous',
            'ref-not-found',
            'cycle',
        ]);
        expect(pairs(model, 'depends')).toEqual(['2>4']);
    });
});

// 位置は frontmatter を位置付きで解析して求めるので、同じ語が複数あっても書かれた場所で一意に決まる
describe('診断が指す frontmatter での位置', () => {
    const doc = (...lines: string[]): string => [...lines, '---', '', '# root'].join('\n');
    const places = (model: ReturnType<typeof buildModel>) => model.diagnostics.map((item) => item.at);

    it('一覧の項目は添字で見分けるので、同じ式が別の行にも含まれるときに行を取り違えない', () => {
        const nodes = outline([['root', null], ['X', 0], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - X --> A --> B', '            - A --> B');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['X --> A --> B', 'A --> B'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['duplicate-edge']);
        // 「A --> B」は 5 行目にも含まれるが、指すのは 2 個目の項目が書かれた 6 行目
        expect(places(model)).toEqual([{ line: 6, column: 21, length: 1 }]);
    });

    it('桁は文字数で数えるので、絵文字のある行でもずれない。引用符の内側の語も指せる', () => {
        const nodes = outline([['root', null], ['🎨設計', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - "🎨設計 --> 実装"');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['🎨設計 --> 実装'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['ref-not-found']);
        expect(places(model)).toEqual([{ line: 5, column: 24, length: 2 }]);
    });

    it('式の全体を指すときは、書かれたまま引用符も含めて指す', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - "A -> B"');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['A -> B'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-syntax']);
        expect(places(model)).toEqual([{ line: 5, column: 15, length: 8 }]);
    });

    it('# がコメントになって値が空になった行は、キーから行末までを指す', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        fork: #A --> B');
        const model = buildModel(nodes, { markdag: { relations: { fork: null } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-not-string']);
        expect(places(model)).toEqual([{ line: 4, column: 9, length: 14 }]);
    });

    it('ならびの項目が空になった行は、その項目の位置から行末までを指す', () => {
        const nodes = outline([['root', null]]);
        const markdown = doc('---', 'markdag:', '    legend:', '        display:', '            - groups', '            - #branches');
        const model = buildModel(nodes, { markdag: { legend: { display: ['groups', null] } } }, markdown);
        expect(model.legend).toEqual(['groups']);
        expect(places(model)).toEqual([{ line: 6, column: 15, length: 9 }]);
    });

    it('文字列でない項目にも位置が付く', () => {
        const nodes = outline([['root', null]]);
        const markdown = doc('---', 'markdag:', '    branches:', '        - 3');
        const model = buildModel(nodes, { markdag: { branches: [3] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 1 }]);
    });

    it('ならびの項目が写像やならびでも、親のキーではなくその項目の行を指す', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - A --> B', '            - A: B');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['A --> B', { A: 'B' }] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-not-string']);
        expect(places(model)).toEqual([{ line: 6, column: 15, length: 4 }]);
    });

    it('ならびの項目に何も書かれていない行は、その行の「-」を指す', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const markdown = doc('---', 'markdag:', '    branches:', '        - A', '        -');
        const model = buildModel(nodes, { markdag: { branches: ['A', null] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        expect(places(model)).toEqual([{ line: 5, column: 9, length: 1 }]);
    });

    it('折り返しのスカラは、記号の行ではなく中身の行を指す', () => {
        const nodes = outline([['root', null]]);
        const markdown = doc('---', 'markdag:', '    details: |-', '        always');
        const model = buildModel(nodes, { markdag: { details: 'always' } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        expect(places(model)).toEqual([{ line: 4, column: 9, length: 6 }]);
    });

    it('空の項目は、スキーマと参照の解決で二重に報告しない', () => {
        const nodes = outline([['root', null]]);
        const markdown = doc('---', 'markdag:', '    branches:', '        - ""');
        const model = buildModel(nodes, { markdag: { branches: [''] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 2 }]);
    });

    it('入れ子の同じ名前のキーを取り違えない', () => {
        const nodes = outline([['root', null]]);
        const markdown = doc('---', 'markdag:', '    groups:', '        design:', '            label: 設計', '    label: x');
        const model = buildModel(nodes, { markdag: { groups: { design: { label: '設計' } }, label: 'x' } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-unknown']);
        expect(places(model)).toEqual([{ line: 6, column: 5, length: 5 }]);
    });

    it('複数行のスカラでも、語が書かれた行を指す', () => {
        const nodes = outline([['root', null], ['開発', 0], ['リリース', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - >-', '              開発 -->', '              リリーズ');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['開発 --> リリーズ'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['ref-not-found']);
        expect(places(model)).toEqual([{ line: 7, column: 15, length: 4 }]);
    });

    it('本文の中に --- があっても、最初の閉じまでを frontmatter として数える', () => {
        const nodes = outline([['root', null], ['リリース', 0]]);
        const markdown = [doc('---', 'markdag:', '    branches:', '        - リリーズ'), '', '---', '', '## x'].join('\n');
        const model = buildModel(nodes, { markdag: { branches: ['リリーズ'] } }, markdown);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 4 }]);
    });

    it('同じ語が式に 2 回出るときは、どちらか決められないので式の全体を指す', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const markdown = doc('---', 'markdag:', '    relations:', '        depends:', '            - A --> A');
        const model = buildModel(nodes, { markdag: { relations: { depends: ['A --> A'] } } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['self-loop']);
        expect(places(model)).toEqual([{ line: 5, column: 15, length: 7 }]);
    });

    it('改行が CRLF でも同じ位置になる', () => {
        const nodes = outline([['root', null], ['X', 0], ['A', 0], ['B', 0]]);
        const lines = ['---', 'markdag:', '    relations:', '        depends:', '            - X --> A --> B', '            - A --> B', '            - "A -> B"', '---', '', '# root'];
        const frontmatter = { markdag: { relations: { depends: ['X --> A --> B', 'A --> B', 'A -> B'] } } };
        // スキーマが出す 7 行目の診断が先、グラフを見る 6 行目の診断があと
        const expected = [{ line: 7, column: 15, length: 8 }, { line: 6, column: 21, length: 1 }];
        expect(places(buildModel(nodes, frontmatter, lines.join('\n')))).toEqual(expected);
        expect(places(buildModel(nodes, frontmatter, lines.join('\r\n')))).toEqual(expected);
    });

    // 値を読む側 (markmap) は、YAML として読めない frontmatter を丸ごと捨てて何も知らせない。
    // 位置付きの解析はその誤りを見ているので、位置付きのエラーにして気づけるようにする
    it('frontmatter が壊れていたら、位置付きのエラーにして、例外にせず続ける', () => {
        const nodes = outline([['root', null], ['リリース', 0]]);
        const broken: Array<[string, boolean]> = [
            [doc('---', 'markdag:', '\tbranches:', '        - リリーズ'), true],
            [doc('---', 'markdag:', '    branches:', '        - "リリーズ'), true],
            [doc('---', 'markdag:', '  branches:', '        - リリーズ', '   details: click'), true],
            [doc('---', 'markdag: @reserved'), true],
            // 空の frontmatter と frontmatter のない文書は、YAML としては壊れていない
            [doc('---'), false],
            ['# root', false],
        ];
        for (const [markdown, broken_] of broken) {
            const model = buildModel(nodes, { markdag: { branches: ['リリーズ'] } }, markdown);
            expect(model.diagnostics.map((item) => item.code)).toEqual(broken_ ? ['yaml-syntax', 'ref-not-found'] : ['ref-not-found']);
            if (broken_) expect(model.diagnostics[0]?.at).not.toBeNull();
        }
    });
});

// 形と型の検査は frontmatter.schema.json の 1 枚が出どころで、コード (x-code)、重大度 (x-severity)、
// 手がかり (x-hint) もスキーマが持つ。ここでは、スキーマの読み方 ($ref、oneOf、既定のコード) を確かめる
describe('frontmatter の形と型の検証', () => {
    const codes = (frontmatter: Record<string, unknown>): string[] => checkFrontmatter(frontmatter).map((item) => item.code);
    const first = (frontmatter: Record<string, unknown>) => checkFrontmatter(frontmatter)[0];

    it('正しく書かれた frontmatter には、何も言わない', () => {
        expect(checkFrontmatter(EPIC_FRONTMATTER)).toEqual([]);
        expect(
            checkFrontmatter({
                title: '小さな DAG',
                markmap: { colorFreezeLevel: 2, color: ['#2980b9'] },
                markdag: {
                    relations: { fork: ['企画 --> 設計/*'], depends: '画面設計 --> API設計' },
                    groups: { design: { label: '設計チーム', color: '#3B7DD8', boundary: true, members: ['画面設計'] } },
                    tags: { display: 'never' },
                    details: { display: 'always' },
                    legend: { position: 'bottom-left', display: false },
                    branches: ['企画', '実装'],
                },
            }),
        ).toEqual([]);
    });

    it('コードと重大度はスキーマが決め、書いていなければ警告の option-invalid / option-unknown にする', () => {
        // relations の下は、その式を描けなくなる誤りなので error
        expect(first({ markdag: { relations: ['A --> B'] } })).toMatchObject({ severity: 'error', code: 'relation-syntax' });
        expect(first({ markdag: { relations: { fork: [3] } } })).toMatchObject({ severity: 'error', code: 'relation-not-string' });
        expect(first({ markdag: { relations: { fork: ['A -> B'] } } })).toMatchObject({ severity: 'error', code: 'relation-syntax' });
        expect(first({ markdag: { relations: { flow: ['A --> B'] } } })).toMatchObject({ severity: 'warning', code: 'relation-unknown-key' });
        expect(first({ markdag: { groups: { a: { color: 3 } } } })).toMatchObject({ severity: 'warning', code: 'group-invalid' });
        expect(first({ markdag: { tags: { display: 'yes' } } })).toMatchObject({ severity: 'warning', code: 'option-invalid' });
        expect(first({ markdag: { tags: { displa: true } } })).toMatchObject({ severity: 'warning', code: 'option-unknown', hint: 'もしかして「display」' });
        expect(first({ markdag: { branches: 'A' } })).toMatchObject({ severity: 'warning', code: 'option-invalid' });
        expect(first({ markdag: { branch: ['A'] } })).toMatchObject({ severity: 'warning', code: 'option-unknown' });
    });

    it('$ref を type の兄弟に置いた制約は、型と形の 2 段で効く', () => {
        // 文字列でない式 (expression の type) と、--> のない式 (その $ref の先の arrow の pattern) を区別する
        expect(first({ markdag: { relations: { fork: [3] } } })?.hint).toBe('「A --> B: C」のように「: 」を含む式は、行全体を "…" で囲みます');
        expect(first({ markdag: { relations: { fork: ['A -> B'] } } })?.hint).toMatch(/半角の空白で挟んだ --> で結びます/);
        // 一覧の型 (branches の type) と、重なり (その $ref の先の noDuplicates の uniqueItems) も同じ
        expect(codes({ markdag: { branches: 'A' } })).toEqual(['option-invalid']);
        expect(first({ markdag: { branches: ['A', 'B', 'A'] } })).toMatchObject({
            code: 'option-invalid',
            message: 'markdag.branches[2] は前にも書かれています ("A")',
            hint: '同じ行が 2 回あります。重なった行は消せます',
        });
    });

    it('oneOf は値の型で枝を選び、どの枝の型にも合わなければ oneOf を書いた位置の手がかりを出す', () => {
        // 一覧の枝が選ばれるので、項目ごとの手がかりになる
        expect(first({ markdag: { legend: { display: ['groups', 'lines'] } } })).toMatchObject({
            message: 'markdag.legend.display[1] に指定できるのは groups, branches です ("lines")',
            hint: '凡例に出せるのは groups と branches です',
        });
        // 真偽値の枝が選ばれるので、何も言わない
        expect(codes({ markdag: { legend: { display: true } } })).toEqual([]);
        expect(codes({ markdag: { legend: { display: false } } })).toEqual([]);
        // 文字列は真偽値でも一覧でもないので、display そのものの手がかりを出す
        expect(first({ markdag: { legend: { display: 'all' } } })).toMatchObject({
            message: 'markdag.legend.display には 真偽値、一覧 のどれかを書きます ("all")',
            hint: '凡例を出さないなら false、項目を選ぶなら一覧で書きます',
        });
    });

    it('知らないキーと使えない値には、近い名前を手がかりにする', () => {
        expect(first({ markdag: { relations: { chian: ['A --> B'] } } })?.hint).toBe('もしかして「chain」');
        expect(first({ markdag: { branch: ['A'] } })?.hint).toBe('もしかして「branches」');
        expect(first({ markdag: { groups: { a: { colour: '#fff' } } } })?.hint).toBe('もしかして「color」');
        expect(first({ markdag: { details: { display: 'hoverr' } } })?.hint).toBe('もしかして「hover」');
        // 近い名前がなければ、スキーマの手がかりをそのまま出す
        expect(first({ markdag: { details: { display: 'open' } } })?.hint).toBe('always は最初から開いて表示、hover はノードに重ねる、click は印のクリックです');
    });

    it('下の階層に書くはずのキーは、知らないキーではなく置き場所の違いとして知らせる', () => {
        expect(first({ markdag: { fork: ['A --> B'] } })).toMatchObject({
            code: 'option-misplaced',
            message: 'markdag のキー「fork」は、markdag.relations の下に書いてください。この位置では無視します',
            hint: 'relations: の行を作り、その下に字下げして fork: を書きます',
        });
        expect(first({ markdag: { position: 'top-left' } })?.message).toBe('markdag のキー「position」は、markdag.legend の下に書いてください。この位置では無視します');
        // 0.2 までの書き方 (最上位の relations と groups) も、置き場所の違いになる
        expect(first({ relations: { fork: ['A --> B'] } })).toMatchObject({
            code: 'option-misplaced',
            message: '「relations」は frontmatter の markdag の下に書いてください。この位置では無視します',
            hint: 'markdag: の行を作り、その下に字下げして relations: を書きます',
        });
        expect(first({ fork: 'A --> B' })?.hint).toBe('markdag: の下に relations: を作り、その下に字下げして fork: を書きます');
        // 書き間違いの近い名前が下の階層のキーなら、置き場所も添える
        expect(first({ relation: { fork: ['A --> B'] } })?.hint).toBe('もしかして「relations」(markdag の下に書きます)');
    });

    it('診断の位置は、スキーマの中の場所から原文の行と桁で引く', () => {
        const markdown = ['---', 'markdag:', '    details: always', '    branches:', '        - A', '        - A', '---', '', '# root'].join('\n');
        expect(checkFrontmatter({ markdag: { details: 'always', branches: ['A', 'A'] } }, markdown).map((item) => item.at)).toEqual([
            { line: 3, column: 14, length: 6 },
            { line: 6, column: 11, length: 1 },
        ]);
    });
});

// 診断のうち、形と型だけで決まるもの。これまでは黙って無視されるか、意図と違う結果になっていた
describe('黙って無視されていた書き方を、スキーマが警告にする', () => {
    const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ['グループの色が引用符なしで、# 以降がコメントになった', { markdag: { groups: { a: { color: null } } } }, ['group-invalid']],
        ['グループの色が文字列でない', { markdag: { groups: { a: { color: 123456 } } } }, ['group-invalid']],
        ['グループの色が CSS の色の形でない', { markdag: { groups: { a: { color: 'まっか' } } } }, ['group-invalid']],
        ['グループの色の 16 進の桁数が足りない', { markdag: { groups: { a: { color: '#D6454' } } } }, ['group-invalid']],
        ['題が文字列でない', { title: 123 }, ['option-invalid']],
        ['グループのラベルが文字列でない', { markdag: { groups: { a: { label: 2025 } } } }, ['group-invalid']],
        ['グループのラベルが空', { markdag: { groups: { a: { label: '' } } } }, ['group-invalid']],
        ['枠の指定が真偽値でない (yes は YAML では文字列)', { markdag: { groups: { a: { boundary: 'yes' } } } }, ['group-invalid']],
        ['メンバーを一覧にしていない', { markdag: { groups: { a: { members: 'A' } } } }, ['group-invalid']],
        ['メンバーが文字列でない', { markdag: { groups: { a: { members: [3] } } } }, ['group-invalid']],
        ['グループの中の知らないキー', { markdag: { groups: { a: { colour: '#fff', member: ['A'] } } } }, ['group-invalid', 'group-invalid']],
        ['解決されずに残ったマージキー', { markdag: { groups: { a: { '<<': { color: '#fff' } } } } }, ['group-invalid']],
        ['グループの定義が写像でない', { markdag: { groups: { a: 'なにか' } } }, ['group-invalid']],
        ['グループの定義が一覧 (members: の書き忘れ)', { markdag: { groups: { a: ['A', 'B'] } } }, ['group-invalid']],
        ['groups が一覧', { markdag: { groups: ['a', 'b'] } }, ['group-invalid']],
        ['groups が文字列', { markdag: { groups: 'abc' } }, ['group-invalid']],
        ['markdag が文字列', { markdag: 'abc' }, ['option-invalid']],
        ['凡例の項目が重なっている', { markdag: { legend: { display: ['groups', 'groups'] } } }, ['option-invalid']],
        ['最上位のキーが大文字違い', { Markdag: { details: { display: 'always' } } }, ['option-unknown']],
        ['relations の書き間違いを最上位に置いた', { relation: { fork: ['A --> B'] } }, ['option-unknown']],
        ['markmap のオプションを最上位に置いた', { colorFreezeLevel: 2 }, ['option-misplaced']],
        ['relations を最上位に置いた (0.2 までの書き方)', { relations: { fork: ['A --> B'] } }, ['option-misplaced']],
        ['groups を最上位に置いた (0.2 までの書き方)', { groups: { a: { color: '#fff' } } }, ['option-misplaced']],
        ['relations のキーを最上位に置いた', { fork: 'A --> B' }, ['option-misplaced']],
        ['relations のキーを markdag の直下に置いた', { markdag: { fork: ['A --> B'] } }, ['option-misplaced']],
        ['legend のキーを markdag の直下に置いた', { markdag: { position: 'top-left' } }, ['option-misplaced']],
        ['markdag のキーを markmap の下に置いた', { markmap: { markdag: { details: { display: 'always' } } } }, ['option-unknown']],
        ['markmap の数値に文字列を書いた', { markmap: { nodeMinHeight: '20' } }, ['option-invalid']],
        ['markmap の真偽値に文字列を書いた (逆の意味になる)', { markmap: { autoFit: 'no' } }, ['option-invalid']],
        ['markmap の深さに数でない文字列を書いた', { markmap: { colorFreezeLevel: 'abc' } }, ['option-invalid']],
        ['markmap の知らないキー', { markmap: { colorFreeze: 2 } }, ['option-unknown']],
        // markmap-lib は読めない値を undefined に直してしまうので、原文の値は診断に書き添えられない
        ['markmap-lib が読めずに消した値', { markmap: { initialExpandLevel: undefined } }, ['option-invalid']],
        ['markmap の色が文字列でも一覧でもない', { markmap: { color: undefined } }, ['option-invalid']],
        ['title など markmap 側のキーは、最上位にあってもよい', { title: 'x', author: 'y' }, []],
        // markmap-lib が読んで使うキーと、CSS の色として読める書き方は、弾かない
        ['markmap.htmlParser は markmap-lib が読むので通す', { markmap: { htmlParser: { selector: 'h1,h2' } } }, []],
        ['frontmatter がキーと値の組でない', 'abc' as unknown as Record<string, unknown>, ['option-invalid']],
        ['グループの色に 8 桁の 16 進', { markdag: { groups: { a: { color: '#3B7DD880' } } } }, []],
        ['グループの色に色の名前', { markdag: { groups: { a: { color: 'steelblue' } } } }, []],
        ['グループの色に関数の書き方', { markdag: { groups: { a: { color: 'rgb(59, 125, 216)' } } } }, []],
    ];

    for (const [label, frontmatter, expected] of cases) {
        it(label, () => {
            expect(checkFrontmatter(frontmatter).map((item) => item.code)).toEqual(expected);
        });
    }

    it('relations が写像でないときに、添字をキーと取り違えた警告を出さない', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const model = buildModel(nodes, { markdag: { relations: 'A --> B' } });
        expect(model.relations).toEqual([]);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-syntax']);
    });

    it('groups が一覧のときに、添字を名前にしたグループを作らない', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const model = buildModel(nodes, { markdag: { groups: ['a', 'b'] } });
        expect(model.groups).toEqual([]);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['group-invalid']);
    });

    it('markdag が一覧のときに、添字をキーと取り違えた警告を出さない', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const model = buildModel(nodes, { markdag: ['A'] });
        expect(model.branches).toEqual([]);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-invalid']);
        expect(model.diagnostics[0]?.message).toBe('markdag はキーと値の組で書きます (["A"])');
    });

    it('値を書かずに markdag のキーだけを置いた文書には、何も言わない (オプションは既定のまま)', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const model = buildModel(nodes, { markdag: null });
        expect(model.diagnostics).toEqual([]);
        expect(model.detailsMode).toBeNull();
        expect(model.edgeHighlight).toBe(true);
    });
});

describe('参照の経路の区切り', () => {
    it('「\\/」と書いた「/」は区切りにせず、名前の一部として照合する', () => {
        const nodes = outline([
            ['root', null],
            ['入出力', 0],
            ['I/O', 1],
            ['完了', 0],
        ]);
        const model = buildModel(nodes, { markdag: { relations: { depends: ['入出力/I\\/O --> 完了'] } } });
        expect(model.diagnostics).toEqual([]);
        expect(pairs(model, 'depends')).toEqual(['3>4']);
    });
});

// 位置は本文の行だけを見分ければよいので、行ごとに同じ桁で作る
const AT = (line: number): NodeTag['at'] => ({ line, column: 10, length: 8 });

describe('タグ', () => {
    const tag = (key: string, ...values: string[]): NodeTag => ({ key, values, at: AT(0) });
    // 1 root / 2 A (owner, urgent) / 3 B (A の子。何も書いていない) / 4 C (グループ backend と、同じ名前の値のないタグ)
    const TREE = outline([
        ['root', null],
        ['A', 0, [], undefined, [tag('owner', 'alice'), tag('urgent')]],
        ['B', 1],
        ['C', 0, ['backend'], undefined, [tag('backend'), tag('status', 'doing', 'review')]],
    ]);

    it('タグは書いたノードだけが持ち、配下には継承しない', () => {
        const model = buildModel(TREE, { markdag: {} });
        expect(model.tagsOf.get(2)).toEqual([tag('owner', 'alice'), tag('urgent')]);
        expect(model.tagsOf.get(3)).toEqual([]);
        expect(model.tagsOf.get(4)).toEqual([tag('backend'), tag('status', 'doing', 'review')]);
        expect(model.diagnostics).toEqual([]);
    });

    it('タグの見せ方は frontmatter の markdag.tags.display でまとめて決まる (既定は always)', () => {
        expect(buildModel(TREE, { markdag: {} }).tagDisplay).toBe('always');
        for (const mode of ['always', 'hover', 'click', 'never']) {
            expect(buildModel(TREE, { markdag: { tags: { display: mode } } }).tagDisplay).toBe(mode);
        }
        const hidden = buildModel(TREE, { markdag: { tags: { display: 'never' } } });
        expect(hidden.tagDisplay).toBe('never');
        // 出さないだけで、タグそのものは持ったまま
        expect(hidden.tagsOf.get(2)).toEqual([tag('owner', 'alice'), tag('urgent')]);
        expect(hidden.diagnostics).toEqual([]);
    });

    it('グループと同じ名前のタグを書いても、タグはタグのままで、グループの所属は %名前 だけで決まる', () => {
        const model = buildModel(TREE, { markdag: { groups: { backend: { label: 'Backend' } } } });
        expect(model.diagnostics).toEqual([]);
        expect(model.tagsOf.get(4)).toEqual([tag('backend'), tag('status', 'doing', 'review')]);
        expect(model.groupsOf.get(4)).toEqual(['backend']);
    });
});

describe('タグの型と検査', () => {
    const tag = (key: string, line: number, ...values: string[]): NodeTag => ({ key, values, at: AT(line) });
    // 1 root / 2 A (正しい値) / 3 B (誤った値) / 4 C ($api。id は D と重なる) / 5 D
    const DOC = outline([
        ['root', null],
        ['A', 0, [], undefined, [tag('priority', 2, 'high'), tag('estimate', 2, '3.5'), tag('due', 2, '2026-10-01'), tag('urgent', 2)]],
        ['B', 0, [], undefined, [tag('priority', 3, 'hgih'), tag('estimate', 3, 'abc'), tag('due', 3, '2026-13-01'), tag('urgent', 3, 'yes')]],
        ['C', 0, [], 'api', [tag('id', 4, 'T-1'), tag('blockedBy', 4, '$api'), tag('owner', 4, 'alice', 'bob')]],
        ['D', 0, [], undefined, [tag('id', 5, 'T-1'), tag('blockedBy', 5, '$missing'), tag('owner', 5, 'carol')]],
    ]);
    const KEYS = {
        priority: { type: 'enum', values: ['high', 'medium', 'low'], description: '優先度' },
        estimate: { type: 'number', min: 0 },
        due: { type: 'date' },
        urgent: { type: 'boolean' },
        id: { type: 'string', pattern: '^T-\\d+$', unique: true },
        blockedBy: { type: 'nodeId' },
        owner: { type: 'string', multiple: true },
    };
    const found = (model: ReturnType<typeof buildModel>) => model.diagnostics.map((item) => [item.code, item.severity, item.at?.line ?? null, item.message, item.hint]);

    it('値を型に当てて、合わないものだけを本文の行つきで知らせる (既定は warning)', () => {
        const model = buildModel(DOC, { markdag: { tags: { keys: KEYS } } });
        expect(found(model)).toEqual([
            ['tag-type', 'warning', 3, '「B」の #priority:hgih: high / medium / low のどれかで書きます', 'もしかして「high」'],
            ['tag-type', 'warning', 3, '「B」の #estimate:abc: 数値で書きます', null],
            ['tag-type', 'warning', 3, '「B」の #due:2026-13-01: YYYY-MM-DD の日付で書きます', null],
            ['tag-type', 'warning', 3, '「B」の #urgent:yes: true か false のどちらかで書きます', null],
            ['tag-type', 'warning', 5, '「D」の #blockedBy:$missing: $missing を持つノードがありません', '行末に $名前 を付けたノードを指します'],
            ['tag-unique', 'warning', 4, '「C」の #id:T-1 は、ほかのノードにも書かれています (5 行目)', 'unique のキーなので、値を変えるか片方を消します'],
            ['tag-unique', 'warning', 5, '「D」の #id:T-1 は、ほかのノードにも書かれています (4 行目)', 'unique のキーなので、値を変えるか片方を消します'],
        ]);
        // 検査しても、タグは書いたまま残る
        expect(model.tagsOf.get(3)?.map((item) => item.values)).toEqual([['hgih'], ['abc'], ['2026-13-01'], ['yes']]);
    });

    it('lint: error で重大度が変わり、unknownKey: deny で定義のないキーも知らせる', () => {
        const model = buildModel(outline([['root', null], ['A', 0, [], undefined, [tag('onwer', 2, 'alice'), tag('memo', 2, 'x')]]]), {
            markdag: { tags: { lint: 'error', unknownKey: 'deny', keys: { owner: { type: 'string' } } } },
        });
        expect(found(model)).toEqual([
            ['tag-unknown-key', 'error', 2, '「A」の #onwer:alice は、markdag.tags.keys に定義のないキーです', 'もしかして「owner」'],
            ['tag-unknown-key', 'error', 2, '「A」の #memo:x は、markdag.tags.keys に定義のないキーです', 'keys に定義するか、unknownKey を allow にします'],
        ]);
        // 定義がなく allow (既定) なら何も言わない
        expect(buildModel(DOC, { markdag: {} }).diagnostics).toEqual([]);
    });

    it('値の数を見る: 値なしは boolean だけが許され、複数の値は multiple のキーだけが許される', () => {
        const model = buildModel(outline([['root', null], ['A', 0, [], undefined, [tag('due', 2), tag('urgent', 2), tag('due', 2, '2026-10-01', '2026-10-02')]]]), {
            markdag: { tags: { keys: { due: { type: 'date' }, urgent: { type: 'boolean' } } } },
        });
        // 同じキーを 1 行に 2 回書いたものは parse 層でつながるが、ここでは別々のタグとして渡している
        expect(model.diagnostics.map((item) => [item.code, item.message])).toEqual([
            ['tag-missing-value', '「A」の #due には値が要ります (YYYY-MM-DD の日付)'],
            ['tag-multiple', '「A」の #due:2026-10-01,2026-10-02 は値を 1 つだけ書くキーです'],
        ]);
    });

    it('名前付きの型は制約を足すだけで派生でき、type の一覧はどれかに合えば通る', () => {
        const doc = outline([
            ['root', null],
            ['A', 0, [], undefined, [tag('id', 2, 'JIRA-12'), tag('priority', 2, '3'), tag('priority', 2, 'high')]],
            ['B', 0, [], undefined, [tag('id', 3, 'ABC-12'), tag('priority', 3, '9'), tag('priority', 3, 'medium')]],
        ]);
        const model = buildModel(doc, {
            markdag: {
                types: {
                    ticket: { type: 'string', pattern: '^[A-Z]+-\\d+$' },
                    jira: { type: 'ticket', pattern: '^JIRA-' },
                    level: { type: 'integer', min: 1, max: 5 },
                },
                tags: { keys: { id: { type: 'jira' }, priority: { type: ['level', 'enum'], values: ['high', 'low'], multiple: true } } },
            },
        });
        expect(model.tagKeys).toEqual([
            { key: 'id', alternatives: [{ primitive: 'string', patterns: ['^[A-Z]+-\\d+$', '^JIRA-'] }], multiple: false, unique: false, description: null },
            { key: 'priority', alternatives: [{ primitive: 'integer', min: 1, max: 5 }, { primitive: 'enum', values: ['high', 'low'] }], multiple: true, unique: false, description: null },
        ]);
        expect(model.diagnostics.map((item) => [item.code, item.at?.line, item.message])).toEqual([
            ['tag-type', 3, '「B」の #id:ABC-12: 「^JIRA-」の形に合いません'],
            ['tag-type', 3, '「B」の #priority:9 の「9」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません'],
            ['tag-type', 3, '「B」の #priority:medium の「medium」は 整数 (1 以上、5 以下)、high / low のどれか のどれにも合いません'],
        ]);
    });

    it('型の定義の誤りは、位置つきで知らせて、そのキーの検査をやめる', () => {
        const doc = outline([['root', null], ['A', 0, [], undefined, [tag('a', 2, 'x'), tag('b', 2, 'x'), tag('c', 2, 'x')]]]);
        const markdown = [
            '---',
            'markdag:',
            '    types:',
            '        loop:',
            '            type: loop',
            '        string:',
            '            type: string',
            '        bad:',
            '            type: number',
            '            pattern: x',
            '            min: "1"',
            '    tags:',
            '        keys:',
            '            a:',
            '                type: strng',
            '            b:',
            '                type: loop',
            '            c:',
            '                type: enum',
            '---',
            '',
            '# root',
            '',
            '## A #a:x #b:x #c:x',
            '',
        ].join('\n');
        const model = buildModel(doc, { markdag: { types: { loop: { type: 'loop' }, string: { type: 'string' }, bad: { type: 'number', pattern: 'x', min: '1' } }, tags: { keys: { a: { type: 'strng' }, b: { type: 'loop' }, c: { type: 'enum' } } } } }, markdown);
        expect(model.diagnostics.map((item) => [item.code, item.at?.line, item.message, item.hint])).toEqual([
            ['type-reserved', 6, 'markdag.types.string は組み込みの型と同じ名前なので定義できません', '別の名前にします'],
            ['type-unknown', 15, 'markdag.tags.keys.a の型「strng」は、組み込みの型にも markdag.types にもありません', 'もしかして「string」'],
            ['type-cycle', 5, '型「loop」の定義が自分自身に戻っています (loop → loop)', '型の type には、自分より基底の型を書きます'],
            // values の行はないので、キーの行を指す
            ['type-invalid', 18, 'markdag.tags.keys.c は enum なので values (許す値の一覧) が要ります', 'values: の下に、許す値を「- high」の形で 1 行ずつ並べます'],
        ]);
        // 使われていない型 (bad) の誤りは、使われたときに知らせる
        const used = buildModel(doc, { markdag: { types: { bad: { type: 'number', pattern: 'x', min: '1' } }, tags: { keys: { a: { type: 'bad' } } } } }, markdown);
        expect(used.diagnostics.map((item) => [item.code, item.message])).toEqual([
            ['type-invalid', 'markdag.types.bad の pattern は string の型にだけ書けます (この型は number)'],
            ['type-invalid', 'markdag.types.bad の min は、number の型では数値で書きます'],
            ['tag-type', '「A」の #a:x: 数値で書きます'],
        ]);
    });

    it('$ref で読んだ型は一覧の順に重ねて後勝ちにし、文書の types がさらに優先する。読めなければ warning にして、その型を使うキーは検査しない', () => {
        const doc = outline([['root', null], ['A', 0, [], undefined, [tag('p', 2, '4')]]]);
        const frontmatter = (own: Record<string, unknown> = {}) => ({ markdag: { types: { $ref: ['./a.yaml', './b.yaml'], ...own }, tags: { keys: { p: { type: 'level' } } } } });
        const loaded = { './a.yaml': { level: { type: 'integer', max: 3 } }, './b.yaml': { level: { type: 'integer', max: 5 } } };
        expect(buildModel(doc, frontmatter(), undefined, { types: loaded }).diagnostics).toEqual([]);
        expect(buildModel(doc, frontmatter({ level: { type: 'integer', max: 2 } }), undefined, { types: loaded }).diagnostics.map((item) => item.code)).toEqual(['tag-type']);
        const unresolved = buildModel(doc, frontmatter(), undefined, { types: { './a.yaml': loaded['./a.yaml'] } });
        expect(unresolved.diagnostics.map((item) => [item.code, item.message])).toEqual([
            ['types-unresolved', 'markdag.types.$ref「./b.yaml」を読めなかったので、その中の型は使えません (その型を使うキーは検査しません)'],
        ]);
        // 読めたほうの定義 (max: 3) には合わないが、読めなかった側で上書きされるかもしれないので黙って通す
        expect(buildModel(doc, frontmatter(), undefined, { types: { './b.yaml': null } }).diagnostics.map((item) => item.code)).toEqual(['types-unresolved', 'types-unresolved']);
        // 組み込みの型を直接書いたキーは、読めなくても検査する
        const direct = buildModel(doc, { markdag: { types: { $ref: './a.yaml' }, tags: { keys: { p: { type: 'integer', max: 3 } } } } });
        expect(direct.diagnostics.map((item) => item.code)).toEqual(['types-unresolved', 'tag-type']);
    });

    it('日時、時刻、期間は書き方と範囲を見る', () => {
        const doc = outline([
            ['root', null],
            ['A', 0, [], undefined, [tag('start', 2, '2026-10-01T09:30'), tag('at', 2, '17:59:30'), tag('est', 2, '1.5d'), tag('start', 2, '2026-10-01 09:30+09:00')]],
            ['B', 0, [], undefined, [tag('start', 3, '2026-09-30T23:59'), tag('at', 3, '18:01'), tag('est', 3, '3d'), tag('est', 3, '2 days')]],
        ]);
        const model = buildModel(doc, { markdag: { tags: { keys: { start: { type: 'datetime', min: '2026-10-01T00:00' }, at: { type: 'time', max: '18:00' }, est: { type: 'duration', max: '2d' } } } } });
        expect(model.diagnostics.map((item) => [item.at?.line, item.message])).toEqual([
            [3, '「B」の #start:2026-09-30T23:59: 2026-10-01T00:00 以上で書きます'],
            [3, '「B」の #at:18:01: 18:00 以下で書きます'],
            [3, '「B」の #est:3d: 2d 以下で書きます'],
            [3, '「B」の #est:"2 days": 30m / 2h / 3d / 1w のような期間で書きます'],
        ]);
    });

    it('編集側の候補は、キーの名前と、enum と boolean の値だけを出す', () => {
        const model = buildModel(DOC, { markdag: { tags: { keys: KEYS } } });
        expect(suggestTagKeys(model.tagKeys, 'p')).toEqual([{ key: 'priority', description: '優先度' }]);
        expect(suggestTagKeys(model.tagKeys).map((item) => item.key)).toEqual(['priority', 'estimate', 'due', 'urgent', 'id', 'blockedBy', 'owner']);
        expect(suggestTagValues(model.tagKeys, 'priority', 'h')).toEqual(['high']);
        expect(suggestTagValues(model.tagKeys, 'urgent')).toEqual(['true', 'false']);
        expect(suggestTagValues(model.tagKeys, 'due')).toEqual([]);
        expect(suggestTagValues(model.tagKeys, 'nothing')).toEqual([]);
    });

    it('types と tags.keys の形はスキーマが検査する', () => {
        const codes = (frontmatter: Record<string, unknown>) => checkFrontmatter(frontmatter).map((item) => [item.code, item.hint]);
        expect(codes({ markdag: { types: { a: { type: 3 } } } })).toEqual([['type-invalid', '「type: string」のように 1 つ書くか、「- enum」の形で 1 行ずつ並べます']]);
        expect(codes({ markdag: { types: { a: { typo: 'x' } } } })).toEqual([['type-invalid', 'もしかして「type」']]);
        expect(codes({ markdag: { tags: { keys: { a: { multiple: 'yes' } } } } })).toEqual([['type-invalid', 'true か false と書きます。yes は YAML では文字列になります']]);
        expect(codes({ markdag: { tags: { lint: 'warn' } } })).toEqual([['option-invalid', 'warning か error と書きます']]);
        expect(codes({ markdag: { tags: { unknownKey: 'denny' } } })).toEqual([['option-invalid', 'もしかして「deny」']]);
        expect(codes({ markdag: { types: { $ref: 3 } } })).toEqual([['option-invalid', '「$ref: ./types.yaml」のように文書からの相対パスを書くか、「- ./a.yaml」の形で 1 行ずつ並べます']]);
        expect(codes({ markdag: { types: { $ref: './t.yaml', a: { type: ['string', 'number'], min: 1, values: ['x'], pattern: 'y' } }, tags: { lint: 'error', unknownKey: 'deny', keys: { a: { type: 'a', multiple: true, unique: true, description: 'd' } } } } })).toEqual([]);
    });
});

describe('タスクの設定', () => {
    it('クリックで進む順は markdag.tasks.cycle で指定でき、指定がなければ未完了と完了の行き来', () => {
        expect(buildModel(EPIC, {}).taskCycle).toEqual([' ', 'x']);
        expect(buildModel(EPIC, { markdag: { tasks: { cycle: [' ', '/', 'x'] } } }).taskCycle).toEqual([' ', '/', 'x']);
        // 知らない記号と重複はスキーマが知らせ、ここでは読み飛ばす
        const wrong = buildModel(EPIC, { markdag: { tasks: { cycle: [' ', '?', 'x', 'x'] } } });
        expect(wrong.taskCycle).toEqual([' ', 'x']);
        expect(wrong.diagnostics.map((item) => [item.code, item.message])).toEqual([
            ['option-invalid', 'markdag.tasks.cycle[3] は前にも書かれています ("x")'],
            ['option-invalid', "markdag.tasks.cycle[1] に指定できるのは  , /, x, - です (\"?\")"],
        ]);
        // 1 つでは進めないので、既定に戻して知らせる
        const single = buildModel(EPIC, { markdag: { tasks: { cycle: ['x'] } } });
        expect(single.taskCycle).toEqual([' ', 'x']);
        expect(single.diagnostics.map((item) => [item.code, item.message])).toEqual([['option-invalid', 'markdag.tasks.cycle: クリックで進む順は、記号を 2 つ以上並べます']]);
    });

    it('薄く表示する状態は markdag.tasks.dim で指定でき、一覧だけでも、詳細とタグの見せ方を添えても書ける', () => {
        expect(buildModel(EPIC, {}).taskDim).toEqual({ states: [], details: 'keep', tags: 'keep' });
        expect(buildModel(EPIC, { markdag: { tasks: { dim: ['x', '-'] } } }).taskDim).toEqual({ states: ['done', 'canceled'], details: 'keep', tags: 'keep' });
        expect(buildModel(EPIC, { markdag: { tasks: { dim: { states: ['-'], details: 'hover', tags: 'never' } } } }).taskDim).toEqual({ states: ['canceled'], details: 'hover', tags: 'never' });
        const wrong = buildModel(EPIC, { markdag: { tasks: { dim: { states: ['x'], details: 'always' } } } });
        expect(wrong.taskDim).toEqual({ states: ['done'], details: 'keep', tags: 'keep' });
        expect(wrong.diagnostics.map((item) => [item.code, item.message])).toEqual([['option-invalid', 'markdag.tasks.dim.details に指定できるのは keep, hover, click, never です ("always")']]);
    });
});

import { describe, expect, it } from 'vitest';
import type { OutlineNode } from '../src/parse/document';
import { buildModel, checkFrontmatter } from '../src/model/model';

// [参照用のテキスト, 親の位置 (0 始まり。ルートは null), タグ, $id]
type Row = [string, number | null, string[]?, string?];

function outline(rows: Row[]): OutlineNode[] {
    const nodes: OutlineNode[] = [];
    rows.forEach(([refText, parentIndex, tags, refId], index) => {
        const parent = parentIndex === null ? null : (nodes[parentIndex] ?? null);
        nodes.push({
            id: index + 1,
            parent: parent?.id ?? null,
            depth: (parent?.depth ?? 0) + 1,
            html: refText,
            refText,
            refId: refId ?? null,
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
        const model = buildModel(nodes, { relations: { join: ['A/確認 & B/確認 --> $goal'] } });
        expect(model.diagnostics).toEqual([]);
        expect(pairs(model, 'join')).toEqual(['3>6', '5>6']);
    });

    it('詳細の見せ方は frontmatter の markdag.details で指定でき、使えない値は警告にして指定なしとして扱う', () => {
        const nodes = outline([['root', null]]);
        expect(buildModel(nodes, {}).detailsMode).toBeNull();
        expect(buildModel(nodes, { markdag: { details: 'open' } }).detailsMode).toBe('open');
        const invalid = buildModel(nodes, { markdag: { details: 'always' } });
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
        const model = buildModel(nodes, { markdag: { branches: ['リリー'] }, relations: { chain: ['開発 --> リリース'] } });
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
        const markdown = ['---', 'relations:', '    chain:', '        - 開発 --> リリーズ', '---', '', '# root'].join('\n');
        const model = buildModel(nodes, { relations: { chain: ['開発 --> リリーズ'] } }, markdown);
        expect(model.diagnostics.map((item) => item.at)).toEqual([{ line: 4, column: 18, length: 4 }]);
    });

    it('markdag の下の知らないキーと、markdag の外に置かれた指定を警告にする', () => {
        const nodes = outline([['root', null]]);
        const unknown = buildModel(nodes, { markdag: { branch: ['A'] } });
        expect(unknown.diagnostics.map((item) => item.code)).toEqual(['option-unknown']);
        const misplaced = buildModel(nodes, { branches: ['A'], markdag: {} });
        expect(misplaced.branches).toEqual([]);
        expect(misplaced.diagnostics.map((item) => item.code)).toEqual(['option-misplaced']);
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
            relations: {
                depends: ['確認 --> A', 'なし --> A', 'A --> B', 'B --> A', 'A -> B'],
                flow: ['A --> B'],
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
        const markdown = doc('---', 'relations:', '    depends:', '        - X --> A --> B', '        - A --> B');
        const model = buildModel(nodes, { relations: { depends: ['X --> A --> B', 'A --> B'] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['duplicate-edge']);
        // 「A --> B」は 4 行目にも含まれるが、指すのは 2 個目の項目が書かれた 5 行目
        expect(places(model)).toEqual([{ line: 5, column: 17, length: 1 }]);
    });

    it('桁は文字数で数えるので、絵文字のある行でもずれない。引用符の内側の語も指せる', () => {
        const nodes = outline([['root', null], ['🎨設計', 0]]);
        const markdown = doc('---', 'relations:', '    depends:', '        - "🎨設計 --> 実装"');
        const model = buildModel(nodes, { relations: { depends: ['🎨設計 --> 実装'] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['ref-not-found']);
        expect(places(model)).toEqual([{ line: 4, column: 20, length: 2 }]);
    });

    it('式の全体を指すときは、書かれたまま引用符も含めて指す', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'relations:', '    depends:', '        - "A -> B"');
        const model = buildModel(nodes, { relations: { depends: ['A -> B'] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-syntax']);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 8 }]);
    });

    it('# がコメントになって値が空になった行は、キーから行末までを指す', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const markdown = doc('---', 'relations:', '    fork: #A --> B');
        const model = buildModel(nodes, { relations: { fork: null } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-not-string']);
        expect(places(model)).toEqual([{ line: 3, column: 5, length: 14 }]);
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
        const markdown = doc('---', 'relations:', '    depends:', '        - A --> B', '        - A: B');
        const model = buildModel(nodes, { relations: { depends: ['A --> B', { A: 'B' }] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-not-string']);
        expect(places(model)).toEqual([{ line: 5, column: 11, length: 4 }]);
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
        const markdown = doc('---', 'groups:', '    design:', '        label: 設計', 'markdag:', '    label: x');
        const model = buildModel(nodes, { groups: { design: { label: '設計' } }, markdag: { label: 'x' } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['option-unknown']);
        expect(places(model)).toEqual([{ line: 6, column: 5, length: 5 }]);
    });

    it('複数行のスカラでも、語が書かれた行を指す', () => {
        const nodes = outline([['root', null], ['開発', 0], ['リリース', 0]]);
        const markdown = doc('---', 'relations:', '    depends:', '        - >-', '          開発 -->', '          リリーズ');
        const model = buildModel(nodes, { relations: { depends: ['開発 --> リリーズ'] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['ref-not-found']);
        expect(places(model)).toEqual([{ line: 6, column: 11, length: 4 }]);
    });

    it('本文の中に --- があっても、最初の閉じまでを frontmatter として数える', () => {
        const nodes = outline([['root', null], ['リリース', 0]]);
        const markdown = [doc('---', 'markdag:', '    branches:', '        - リリーズ'), '', '---', '', '## x'].join('\n');
        const model = buildModel(nodes, { markdag: { branches: ['リリーズ'] } }, markdown);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 4 }]);
    });

    it('同じ語が式に 2 回出るときは、どちらか決められないので式の全体を指す', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const markdown = doc('---', 'relations:', '    depends:', '        - A --> A');
        const model = buildModel(nodes, { relations: { depends: ['A --> A'] } }, markdown);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['self-loop']);
        expect(places(model)).toEqual([{ line: 4, column: 11, length: 7 }]);
    });

    it('改行が CRLF でも同じ位置になる', () => {
        const nodes = outline([['root', null], ['X', 0], ['A', 0], ['B', 0]]);
        const lines = ['---', 'relations:', '    depends:', '        - X --> A --> B', '        - A --> B', '        - "A -> B"', '---', '', '# root'];
        const frontmatter = { relations: { depends: ['X --> A --> B', 'A --> B', 'A -> B'] } };
        // スキーマが出す 6 行目の診断が先、グラフを見る 5 行目の診断があと
        const expected = [{ line: 6, column: 11, length: 8 }, { line: 5, column: 17, length: 1 }];
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
                relations: { fork: ['企画 --> 設計/*'], depends: '画面設計 --> API設計' },
                markdag: { details: 'open', legend: { position: 'bottom-left', display: false }, branches: ['企画', '実装'] },
                groups: { design: { label: '設計チーム', color: '#3B7DD8', boundary: true, members: ['画面設計'] } },
            }),
        ).toEqual([]);
    });

    it('コードと重大度はスキーマが決め、書いていなければ警告の option-invalid / option-unknown にする', () => {
        // relations の下は、その式を描けなくなる誤りなので error
        expect(first({ relations: ['A --> B'] })).toMatchObject({ severity: 'error', code: 'relation-syntax' });
        expect(first({ relations: { fork: [3] } })).toMatchObject({ severity: 'error', code: 'relation-not-string' });
        expect(first({ relations: { fork: ['A -> B'] } })).toMatchObject({ severity: 'error', code: 'relation-syntax' });
        expect(first({ relations: { flow: ['A --> B'] } })).toMatchObject({ severity: 'warning', code: 'relation-unknown-key' });
        expect(first({ groups: { a: { color: 3 } } })).toMatchObject({ severity: 'warning', code: 'group-invalid' });
        expect(first({ markdag: { branches: 'A' } })).toMatchObject({ severity: 'warning', code: 'option-invalid' });
        expect(first({ markdag: { branch: ['A'] } })).toMatchObject({ severity: 'warning', code: 'option-unknown' });
    });

    it('$ref を type の兄弟に置いた制約は、型と形の 2 段で効く', () => {
        // 文字列でない式 (expression の type) と、--> のない式 (その $ref の先の arrow の pattern) を区別する
        expect(first({ relations: { fork: [3] } })?.hint).toBe('「A --> B: C」のように「: 」を含む式は、行全体を "…" で囲みます');
        expect(first({ relations: { fork: ['A -> B'] } })?.hint).toMatch(/半角の空白で挟んだ --> で結びます/);
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
        expect(first({ relations: { chian: ['A --> B'] } })?.hint).toBe('もしかして「chain」');
        expect(first({ markdag: { branch: ['A'] } })?.hint).toBe('もしかして「branches」');
        expect(first({ groups: { a: { colour: '#fff' } } })?.hint).toBe('もしかして「color」');
        expect(first({ markdag: { details: 'hoverr' } })?.hint).toBe('もしかして「hover」');
        // 近い名前がなければ、スキーマの手がかりをそのまま出す
        expect(first({ markdag: { details: 'always' } })?.hint).toBe('click は印のクリック、hover はノードに重ねる、open は最初から開いて表示します');
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
        ['グループの色が引用符なしで、# 以降がコメントになった', { groups: { a: { color: null } } }, ['group-invalid']],
        ['グループの色が文字列でない', { groups: { a: { color: 123456 } } }, ['group-invalid']],
        ['グループの色が CSS の色の形でない', { groups: { a: { color: 'まっか' } } }, ['group-invalid']],
        ['グループの色の 16 進の桁数が足りない', { groups: { a: { color: '#D6454' } } }, ['group-invalid']],
        ['題が文字列でない', { title: 123 }, ['option-invalid']],
        ['グループのラベルが文字列でない', { groups: { a: { label: 2025 } } }, ['group-invalid']],
        ['グループのラベルが空', { groups: { a: { label: '' } } }, ['group-invalid']],
        ['枠の指定が真偽値でない (yes は YAML では文字列)', { groups: { a: { boundary: 'yes' } } }, ['group-invalid']],
        ['メンバーを一覧にしていない', { groups: { a: { members: 'A' } } }, ['group-invalid']],
        ['メンバーが文字列でない', { groups: { a: { members: [3] } } }, ['group-invalid']],
        ['グループの中の知らないキー', { groups: { a: { colour: '#fff', member: ['A'] } } }, ['group-invalid', 'group-invalid']],
        ['解決されずに残ったマージキー', { groups: { a: { '<<': { color: '#fff' } } } }, ['group-invalid']],
        ['グループの定義が写像でない', { groups: { a: 'なにか' } }, ['group-invalid']],
        ['グループの定義が一覧 (members: の書き忘れ)', { groups: { a: ['A', 'B'] } }, ['group-invalid']],
        ['groups が一覧', { groups: ['a', 'b'] }, ['group-invalid']],
        ['groups が文字列', { groups: 'abc' }, ['group-invalid']],
        ['markdag が文字列', { markdag: 'abc' }, ['option-invalid']],
        ['凡例の項目が重なっている', { markdag: { legend: { display: ['groups', 'groups'] } } }, ['option-invalid']],
        ['最上位のキーが大文字違い', { Markdag: { details: 'open' } }, ['option-unknown']],
        ['最上位のキーの書き間違い', { relation: { fork: ['A --> B'] } }, ['option-unknown']],
        ['markmap のオプションを最上位に置いた', { colorFreezeLevel: 2 }, ['option-misplaced']],
        ['relations のキーを最上位に置いた', { fork: 'A --> B' }, ['option-misplaced']],
        ['markdag のキーを markmap の下に置いた', { markmap: { markdag: { details: 'open' } } }, ['option-unknown']],
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
        ['グループの色に 8 桁の 16 進', { groups: { a: { color: '#3B7DD880' } } }, []],
        ['グループの色に色の名前', { groups: { a: { color: 'steelblue' } } }, []],
        ['グループの色に関数の書き方', { groups: { a: { color: 'rgb(59, 125, 216)' } } }, []],
    ];

    for (const [label, frontmatter, expected] of cases) {
        it(label, () => {
            expect(checkFrontmatter(frontmatter).map((item) => item.code)).toEqual(expected);
        });
    }

    it('relations が写像でないときに、添字をキーと取り違えた警告を出さない', () => {
        const nodes = outline([['root', null], ['A', 0], ['B', 0]]);
        const model = buildModel(nodes, { relations: 'A --> B' });
        expect(model.relations).toEqual([]);
        expect(model.diagnostics.map((item) => item.code)).toEqual(['relation-syntax']);
    });

    it('groups が一覧のときに、添字を名前にしたグループを作らない', () => {
        const nodes = outline([['root', null], ['A', 0]]);
        const model = buildModel(nodes, { groups: ['a', 'b'] });
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
        const model = buildModel(nodes, { relations: { depends: ['入出力/I\\/O --> 完了'] } });
        expect(model.diagnostics).toEqual([]);
        expect(pairs(model, 'depends')).toEqual(['3>4']);
    });
});

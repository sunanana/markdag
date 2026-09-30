// 図の側の編集 (editor/ops.ts) が、原文を狙いどおりに書き換えるかを、書き換えたあとの原文を解析し直して確かめる
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { addChild, addJoin, addJoinNode, addRelation, addSibling, deleteEdge, deleteNode, moveNode, renameNode, reverseEdge, type EditContext, type EditResult } from '../editor/ops';
import { buildModel } from '../src/model/model';
import { parseDocument } from '../src/parse/document';

const contextOf = (source: string): EditContext => {
    const parsed = parseDocument(source);
    return { source, parsed, model: buildModel(parsed.nodes, parsed.frontmatter) };
};
const sourceOf = (result: EditResult): string => {
    if (!result.ok) throw new Error(`操作が失敗した: ${result.message}`);
    return result.source;
};
const byName = (ctx: EditContext, name: string): number => {
    const found = ctx.parsed.nodes.filter((node) => node.refText === name);
    if (found.length !== 1) throw new Error(`${name} が ${found.length} 個ある`);
    return found[0]!.id;
};
const errorsOf = (source: string): string[] =>
    contextOf(source)
        .model.diagnostics.filter((item) => item.severity !== 'info')
        .map((item) => `${item.code} ${item.message}`);
const edgesOf = (source: string): string[] => {
    const ctx = contextOf(source);
    const name = (id: number): string => ctx.parsed.nodes[id - 1]?.refText ?? '?';
    return ctx.model.relations.map((relation) => `${name(relation.source)}>${name(relation.target)}`).sort();
};
const parentOf = (source: string, name: string): string | null => {
    const ctx = contextOf(source);
    const node = ctx.parsed.nodes[byName(ctx, name) - 1]!;
    return node.parent === null ? null : (ctx.parsed.nodes[node.parent - 1]?.refText ?? null);
};

const NOTATION = readFileSync(new URL('../docs/examples/notation.md', import.meta.url), 'utf8');

const SIMPLE = `---
markdag:
    relations:
        depends:
            - x --> C
---
# Root

## A
- x
    > 詳細
- y

## B
### C
`;

describe('ノードの追加', () => {
    test('見出しの子は 1 段下の見出し、リストの子は入れ子の項目になる', () => {
        const ctx = contextOf(SIMPLE);
        const underC = sourceOf(addChild(ctx, byName(ctx, 'C'), 'D'));
        expect(underC).toContain('### C\n#### D\n');
        expect(parentOf(underC, 'D')).toBe('C');
        const underX = sourceOf(addChild(ctx, byName(ctx, 'x'), 'x1'));
        expect(underX).toContain('- x\n    > 詳細\n    - x1\n- y');
        expect(parentOf(underX, 'x1')).toBe('x');
    });

    test('子がいれば最後の子の形にそろえる (A の子はリスト)', () => {
        const ctx = contextOf(SIMPLE);
        const next = sourceOf(addChild(ctx, byName(ctx, 'A'), 'z'));
        expect(next).toContain('- y\n- z\n');
        expect(parentOf(next, 'z')).toBe('A');
    });

    test('兄弟は配下のあとに同じ形で足す', () => {
        const ctx = contextOf(SIMPLE);
        const next = sourceOf(addSibling(ctx, byName(ctx, 'A'), 'A2'));
        expect(next).toContain('- y\n\n## A2\n');
        expect(parentOf(next, 'A2')).toBe('Root');
        const task = contextOf(NOTATION);
        const after = sourceOf(addSibling(task, byName(task, '登録フォーム'), '確認画面'));
        expect(after).toContain('    > 送信先は登録API。入力の誤りは、その項目のすぐ下に出す。\n- [ ] 確認画面\n');
        expect(errorsOf(after)).toEqual([]);
    });

    test('見出しの下の段落のあとに空行をはさんで足し、段落を項目に吸い込ませない', () => {
        const source = '# R\n\n## A\n本文の段落\n\n## B\n';
        const ctx = contextOf(source);
        const next = sourceOf(addChild(ctx, byName(ctx, 'A'), 'a1'));
        expect(next).toBe('# R\n\n## A\n本文の段落\n\n### a1\n\n## B\n');
    });

    test('h1 のない文書のルートに足すと、文書の末尾に最上位の項目が増える', () => {
        const ctx = contextOf('- a\n- b\n');
        const next = sourceOf(addChild(ctx, 1, 'c'));
        expect(next).toBe('- a\n- b\n- c\n');
    });
});

describe('名前の変更', () => {
    test('印とタスクの記号を残して本文だけを変え、relations の参照も追う', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(renameNode(ctx, byName(ctx, '登録API'), '登録エンドポイント', parseDocument));
        expect(next).toContain('- [/] 登録エンドポイント #owner:alice,bob');
        expect(next).toContain('- 登録エンドポイント --> 登録フォーム');
        expect(errorsOf(next)).toEqual([]);
    });

    test('branches と 親/子 の参照も書き換える', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(renameNode(ctx, byName(ctx, '検証'), 'QA', parseDocument));
        expect(next).toContain('- 設計 --> 実装 --> QA --> $release');
        expect(next).toContain('- フロントエンド/テスト & バックエンド/テスト --> QA');
        expect(next).toContain('        - QA\n');
        expect(errorsOf(next)).toEqual([]);
    });
});

describe('削除', () => {
    test('配下ごと消し、消したノードを指す relations も外す', () => {
        const ctx = contextOf(NOTATION);
        const result = deleteNode(ctx, byName(ctx, 'バックエンド'));
        const next = sourceOf(result);
        expect(next).not.toContain('- 登録API --> 登録フォーム');
        expect(next).not.toContain('バックエンド');
        expect(next).not.toContain('join:');
        expect(errorsOf(next)).toEqual([]);
        expect(result.ok && result.message).toContain('2 件');
    });

    test('見出しは次の見出しまでの段落も消す', () => {
        const ctx = contextOf('# R\n## A\n段落\n- a1\n## B\n');
        expect(sourceOf(deleteNode(ctx, byName(ctx, 'A')))).toBe('# R\n## B\n');
    });
});

describe('付け替え', () => {
    test('リストの項目を見出しの下へ移すと、配下と詳細も付いてくる', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(moveNode(ctx, byName(ctx, '登録フォーム'), byName(ctx, '検証')));
        expect(parentOf(next, '登録フォーム')).toBe('検証');
        expect(next).toContain('- [ ] 登録フォーム #owner:alice #priority:high\n    > 送信先は登録API。入力の誤りは、その項目のすぐ下に出す。\n\n## **公開**');
        expect(errorsOf(next)).toEqual([]);
    });

    test('見出しをリストの項目の下へ移すと、配下の見出しも入れ子の項目になる', () => {
        const ctx = contextOf(SIMPLE);
        const next = sourceOf(moveNode(ctx, byName(ctx, 'B'), byName(ctx, 'y')));
        expect(next).toContain('- y\n    - B\n        - C\n');
        expect(parentOf(next, 'B')).toBe('y');
        expect(parentOf(next, 'C')).toBe('B');
    });

    test('自分の配下には移せない', () => {
        const ctx = contextOf(SIMPLE);
        expect(moveNode(ctx, byName(ctx, 'B'), byName(ctx, 'C')).ok).toBe(false);
    });
});

describe('線', () => {
    test('線を引くと depends に足す。frontmatter がなければ作る', () => {
        const ctx = contextOf('# R\n## A\n## B\n');
        const next = sourceOf(addRelation(ctx, byName(ctx, 'A'), byName(ctx, 'B')));
        expect(next.startsWith('---\nmarkdag:\n    relations:\n        depends:\n            - A --> B\n---\n')).toBe(true);
        expect(edgesOf(next)).toEqual(['A>B']);
    });

    test('既存の depends の末尾に足す。同じ名前のノードは 親/名前 で指す', () => {
        const ctx = contextOf(NOTATION);
        const tests = ctx.parsed.nodes.filter((node) => node.refText === 'テスト');
        const next = sourceOf(addRelation(ctx, tests[0]!.id, byName(ctx, '受入テスト')));
        expect(next).toContain('            - 登録API --> 登録フォーム\n            - フロントエンド/テスト --> 受入テスト\n');
        expect(errorsOf(next)).toEqual([]);
    });

    test('1 本だけの記述は行ごと消す', () => {
        const ctx = contextOf(SIMPLE);
        const next = sourceOf(deleteEdge(ctx, { kind: 'depends', source: byName(ctx, 'x'), target: byName(ctx, 'C') }));
        expect(next).not.toContain('x --> C');
        expect(next.startsWith('---\nmarkdag:\n---\n')).toBe(true);
        expect(edgesOf(next)).toEqual([]);
        expect(errorsOf(next)).toEqual([]);
    });

    test('chain の途中の線を消すと 2 つに分かれる', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(deleteEdge(ctx, { kind: 'chain', source: byName(ctx, '実装'), target: byName(ctx, '検証') }));
        expect(next).toContain('            - 設計 --> 実装\n            - 検証 --> $release\n');
        expect(errorsOf(next)).toEqual([]);
    });

    test('join の 1 本を消すと項を 1 つ外す', () => {
        const ctx = contextOf(NOTATION);
        const tests = ctx.parsed.nodes.filter((node) => node.refText === 'テスト');
        const next = sourceOf(deleteEdge(ctx, { kind: 'join', source: tests[1]!.id, target: byName(ctx, '検証') }));
        expect(next).toContain('- フロントエンド/テスト --> 検証');
        expect(edgesOf(next)).not.toContain('テスト>検証'.repeat(2));
        expect(contextOf(next).model.relations.filter((relation) => relation.kind === 'join')).toHaveLength(1);
    });

    test('X/* から生まれた 1 本を消すと、残りを depends に書き直す', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(deleteEdge(ctx, { kind: 'fork', source: byName(ctx, '要件定義'), target: byName(ctx, '画面設計') }));
        expect(next).not.toContain('$req --> 設計/*');
        expect(next).toContain('- $req --> API設計');
        expect(edgesOf(next)).toContain('要件定義>API設計');
        expect(edgesOf(next)).not.toContain('要件定義>画面設計');
        expect(errorsOf(next)).toEqual([]);
    });

    test('木の線は消せない', () => {
        const ctx = contextOf(SIMPLE);
        expect(deleteEdge(ctx, { kind: 'tree', source: byName(ctx, 'B'), target: byName(ctx, 'C') }).ok).toBe(false);
    });

    test('向きを変える', () => {
        const ctx = contextOf(NOTATION);
        const next = sourceOf(reverseEdge(ctx, { kind: 'depends', source: byName(ctx, '登録API'), target: byName(ctx, '登録フォーム') }));
        expect(next).toContain('- 登録フォーム --> 登録API');
    });
});

describe('合流', () => {
    const TREE = `# 計画

## 設計
- 画面
- API
- データ

## 実装
- 画面の実装
- APIの実装

## リリース
`;

    test('複数のノードから既存のノードへ、1 本の join で合流させる', () => {
        const ctx = contextOf(TREE);
        const result = addJoin(ctx, [byName(ctx, '画面'), byName(ctx, 'API'), byName(ctx, 'データ')], byName(ctx, 'リリース'));
        const next = sourceOf(result);
        expect(next.startsWith('---\nmarkdag:\n    relations:\n        join:\n            - 画面 & API & データ --> リリース\n---\n')).toBe(true);
        expect(edgesOf(next)).toEqual(['API>リリース', 'データ>リリース', '画面>リリース']);
        expect(errorsOf(next)).toEqual([]);
        // 合流先を選んだままにする
        expect(result.ok && result.focusId).toBe(contextOf(next).parsed.nodes.find((node) => node.refText === 'リリース')?.id);
    });

    test('循環になる始点と、線のある始点は外し、残りが 1 つなら depends にする', () => {
        const first = contextOf(TREE);
        const withEdge = sourceOf(addJoin(first, [byName(first, '画面'), byName(first, 'API')], byName(first, 'リリース')));
        const ctx = contextOf(withEdge);
        // 画面からリリースへはもう線がある
        const result = addJoin(ctx, [byName(ctx, '画面'), byName(ctx, 'データ')], byName(ctx, 'リリース'));
        const next = sourceOf(result);
        expect(next).toContain('        depends:\n            - データ --> リリース\n');
        expect(result.ok && result.message).toContain('線のある 1 個');
        // 画面は設計の配下 (設計から木の線で届く) なので、画面から設計へ線を引くと循環になる
        const back = addJoin(ctx, [byName(ctx, '画面')], byName(ctx, '設計'));
        expect(back.ok).toBe(false);
        expect(!back.ok && back.message).toContain('循環');
    });

    test('合流先のノードを作ると、始点のいちばん後ろの枝のすぐ後ろに最上位のノードとして足す', () => {
        const ctx = contextOf(TREE);
        const result = addJoinNode(ctx, [byName(ctx, 'API'), byName(ctx, '画面の実装'), byName(ctx, 'APIの実装')], '結合テスト', contextOf);
        const next = sourceOf(result);
        expect(next).toContain('- APIの実装\n\n## 結合テスト\n\n## リリース');
        expect(next).toContain('            - API & 画面の実装 & APIの実装 --> 結合テスト\n');
        expect(parentOf(next, '結合テスト')).toBe('計画');
        expect(edgesOf(next)).toEqual(['API>結合テスト', 'APIの実装>結合テスト', '画面の実装>結合テスト']);
        expect(errorsOf(next)).toEqual([]);
        const created = contextOf(next).parsed.nodes.find((node) => node.refText === '結合テスト');
        expect(result.ok && result.focusId).toBe(created?.id);
    });

    test('同じ名前のノードは 親/名前 で指す', () => {
        const ctx = contextOf(NOTATION);
        const tests = ctx.parsed.nodes.filter((node) => node.refText === 'テスト').map((node) => node.id);
        const next = sourceOf(addJoinNode(ctx, tests, '結合確認', contextOf));
        expect(next).toContain('            - フロントエンド/テスト & バックエンド/テスト --> 結合確認\n');
        expect(errorsOf(next)).toEqual([]);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { BEFORE_HOOKS, createHookDocument, HOOK_EVENTS, HookRunner, ON_HOOKS, resolveHooks, rulesModule, VALUE_HOOKS, type HookApi, type HookDocument, type HookModule } from '../src/model/hooks';
import { buildModel, type Diagnostic } from '../src/model/model';
import type { OutlineNode } from '../src/parse/document';

// [参照用のテキスト, 親の位置 (0 始まり。ルートは null), タスクの状態 (タスクでなければ undefined), そのほかの欄]
type Row = [string, number | null, boolean?, Partial<OutlineNode>?];

function outline(rows: Row[]): OutlineNode[] {
    const nodes: OutlineNode[] = [];
    rows.forEach(([refText, parentIndex, checked, extra], index) => {
        const parent = parentIndex === null ? null : (nodes[parentIndex] ?? null);
        nodes.push({
            id: index + 1,
            parent: parent?.id ?? null,
            depth: (parent?.depth ?? 0) + 1,
            html: refText,
            refText,
            refId: null,
            groups: [],
            tags: [],
            milestone: false,
            foldHint: 0,
            lines: { start: index, end: index + 1 },
            task: checked === undefined ? null : { line: index, checked },
            details: null,
            ...extra,
        });
    });
    return nodes;
}

const NODES = outline([
    ['リリース計画', null],
    ['設計', 0, false],
    ['画面設計', 1, false],
    ['実装', 0, false],
    ['テスト', 0, false],
    ['受け入れの確認', 4, false],
]);

const FRONTMATTER = { markdag: { relations: { chain: ['設計 --> 実装 --> テスト'] } } };

// マイルストーンとグループのある小さな文書 (規則の確認に使う)
const MARKED = outline([['計画', null], ['公開', 0, undefined, { milestone: true }], ['連絡', 1, false, { groups: ['fixed'] }]]);

function documentOf(folded: number[] = [], nodes: OutlineNode[] = NODES, frontmatter: Record<string, unknown> = FRONTMATTER): HookDocument {
    const model = buildModel(nodes, frontmatter);
    return createHookDocument({
        nodes,
        model,
        frontmatter,
        source: () => '# リリース計画\n',
        folded: () => folded,
        diagnostics: () => model.diagnostics,
    });
}

const texts = (nodes: readonly { text: string }[]): string[] => nodes.map((node) => node.text);

function runnerOf(modules: Array<[string, HookModule]>, doc: HookDocument = documentOf()): { runner: HookRunner; api: HookApi; diagnostics: Diagnostic[]; errors: unknown[] } {
    const diagnostics: Diagnostic[] = [];
    const errors: unknown[] = [];
    const api: HookApi = {
        focusNode: () => undefined,
        refreshDecorations: () => undefined,
        revealNode: () => undefined,
        setFolded: () => undefined,
        getFolded: () => [],
        fit: () => undefined,
        getTransform: () => ({ x: 0, y: 0, k: 1 }),
        setTransform: () => undefined,
        update: () => undefined,
    };
    const runner = new HookRunner({
        doc: () => doc,
        api,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        onError: (error) => errors.push(error),
    });
    runner.setHooks(
        modules.map(([ref, module]) => ({ ref, module })),
        { strict: true },
    );
    return { runner, api, diagnostics, errors };
}

const taskFields = { node: documentOf().node(4)!, next: true, line: 3 };

describe('フックの宣言の解決', () => {
    it('hookRefs を渡さないアプリでは、フックは動かないと info で知らせる', () => {
        const resolved = resolveHooks({ $ref: './flow.hooks.js' }, undefined);
        expect(resolved.hooks).toEqual([]);
        expect(resolved.issues).toEqual([
            {
                severity: 'info',
                code: 'hooks-unresolved',
                message: 'markdag.hooks.$ref「./flow.hooks.js」は読み込まれていないので、このフックは動きません',
                hint: 'このアプリはフックを読み込みません (markdag.rules ならコードなしで効きます)',
                path: ['markdag', 'hooks', '$ref'],
            },
        ]);
    });

    it('hookRefs を渡しているのに見つからないモジュールは警告にする', () => {
        const resolved = resolveHooks({ $ref: ['./a.hooks.js', './b.hooks.js'] }, { './b.hooks.js': null });
        expect(resolved.issues.map((issue) => [issue.severity, issue.hint])).toEqual([
            ['warning', '呼び出し側が import して render の hookRefs に渡します (信頼できる文書のときだけ)'],
            ['warning', 'モジュールとして読めるか (名前付きの export があるか) 確かめます'],
        ]);
    });

    it('.ts の $ref が未解決なら、読み込む側で変換する必要があることを添える', () => {
        const resolved = resolveHooks({ $ref: './flow.hooks.ts' }, undefined);
        expect(resolved.issues[0]?.hint).toContain('.ts は markdag では変換しないので、読み込む側で JavaScript にしてから渡します');
    });

    it('一覧で書いた $ref は、書かれた順に並び、位置は添字で指す', () => {
        const resolved = resolveHooks({ $ref: ['./a.hooks.js', './b.hooks.js'] }, { './a.hooks.js': { onDocument: () => undefined } });
        expect(resolved.hooks.map((hook) => hook.ref)).toEqual(['./a.hooks.js']);
        expect(resolved.issues.map((issue) => issue.path)).toEqual([['markdag', 'hooks', '$ref', 1]]);
    });

    it('予約された名前の関数だけを拾い、拾えなかった export は警告にする', () => {
        const resolved = resolveHooks(
            { $ref: './flow.hooks.js', options: { strict: true } },
            {
                './flow.hooks.js': {
                    beforeTaskToggle: () => false,
                    beforeTaskTogle: () => false,
                    onDocument: 'yes',
                    LIMIT: 3,
                    default: () => undefined,
                },
            },
        );
        expect(Object.keys(resolved.hooks[0]?.module ?? {})).toEqual(['beforeTaskToggle']);
        expect(resolved.options).toEqual({ strict: true });
        expect(resolved.issues.map((issue) => [issue.code, issue.hint])).toEqual([
            ['hook-unknown-export', '「beforeTaskToggle」の書き間違いなら直します'],
            ['hook-invalid-export', 'export function onDocument(ctx) { ... } の形で書きます'],
            ['hook-unknown-export', 'フックは名前付きで export します (beforeUpdate, beforeTaskToggle, beforeFold など)'],
        ]);
    });

    it('buildModel は、宣言と渡されたモジュールを突き合わせて診断に出す', () => {
        const frontmatter = { markdag: { hooks: { $ref: './flow.hooks.js' } } };
        const withModule = buildModel(NODES, frontmatter, undefined, { hookRefs: { './flow.hooks.js': { onDocument: () => undefined } } });
        expect(withModule.hooks.hooks.map((hook) => hook.ref)).toEqual(['./flow.hooks.js']);
        expect(withModule.diagnostics).toEqual([]);

        const withoutModule = buildModel(NODES, frontmatter);
        expect(withoutModule.hooks.hooks).toEqual([]);
        expect(withoutModule.diagnostics.map((item) => [item.severity, item.code])).toEqual([['info', 'hooks-unresolved']]);
    });
});

describe('フックに渡す文書', () => {
    it('upstream と downstream は relations の線をたどり、tree でツリーの親子も含める', () => {
        const doc = documentOf();
        expect(texts(doc.upstream(5))).toEqual(['実装']);
        expect(texts(doc.upstream(5, { transitive: true }))).toEqual(['実装', '設計']);
        expect(texts(doc.downstream(2, { transitive: true }))).toEqual(['実装', 'テスト']);
        expect(texts(doc.upstream(3))).toEqual([]);
        expect(texts(doc.upstream(3, { tree: true }))).toEqual(['設計']);
        expect(texts(doc.upstream(5, { tree: true, transitive: true }))).toEqual(['実装', 'リリース計画', '設計']);
    });

    it('ノードの写しは、開閉の状態を読むたびに今の値を返す', () => {
        const doc = documentOf([2]);
        expect(doc.node(2)).toMatchObject({ id: 2, text: '設計', parent: 1, children: [3], folded: true, visible: true, task: { checked: false, line: 1 } });
        expect(doc.node(3)).toMatchObject({ folded: false, visible: false });
        expect(doc.node(99)).toBeNull();
        expect(doc.nodes()).toHaveLength(6);
    });
});

describe('フックの呼び出し', () => {
    it('before が false を返すと、その操作を取りやめ、後続のフックは呼ばない', () => {
        const second = vi.fn();
        const { runner, diagnostics } = runnerOf([
            [
                './a.hooks.js',
                {
                    beforeTaskToggle: (ctx) => {
                        ctx.reject('上流が未完です');
                        return false;
                    },
                },
            ],
            ['./b.hooks.js', { beforeTaskToggle: second }],
        ]);
        expect(runner.before('beforeTaskToggle', taskFields, true)).toBe(false);
        expect(second).not.toHaveBeenCalled();
        expect(diagnostics).toEqual([
            {
                severity: 'info',
                code: 'hook-rejected',
                message: './a.hooks.js の beforeTaskToggle が操作を取りやめました: 上流が未完です',
                at: null,
                hint: null,
            },
        ]);
    });

    it('何も返さないフックは素通りさせ、宣言の順に呼ぶ', () => {
        const order: string[] = [];
        const { runner, diagnostics } = runnerOf([
            ['./a.hooks.js', { beforeTaskToggle: () => void order.push('a') }],
            ['./b.hooks.js', { beforeTaskToggle: () => void order.push('b') }],
        ]);
        expect(runner.before('beforeTaskToggle', taskFields, true)).toBe(true);
        expect(order).toEqual(['a', 'b']);
        expect(diagnostics).toEqual([]);
    });

    it('フックが渡される文脈には、発火点と操作のきっかけが入る', () => {
        const seen: unknown[] = [];
        const { runner } = runnerOf([['./a.hooks.js', { onTaskToggle: (ctx) => void seen.push({ event: ctx.event, byUser: ctx.byUser, byHook: ctx.byHook, options: ctx.options, node: ctx.node.text }) }]]);
        runner.emit('onTaskToggle', taskFields, true);
        expect(seen).toEqual([{ event: 'onTaskToggle', byUser: true, byHook: false, options: { strict: true }, node: '実装' }]);
    });

    it('取りやめは、タスクの切り替え以外の発火点でも同じように効く', () => {
        const { runner, diagnostics } = runnerOf([['./a.hooks.js', { beforeSelectGroup: (ctx) => ctx.group?.id !== 'locked', beforeDetailsShow: () => false }]]);
        expect(runner.before('beforeSelectGroup', { group: { id: 'design', label: '設計', color: null, members: [2] } }, true)).toBe(true);
        expect(runner.before('beforeSelectGroup', { group: { id: 'locked', label: '固定', color: null, members: [] } }, true)).toBe(false);
        expect(runner.before('beforeDetailsShow', { node: taskFields.node, pinned: true }, true)).toBe(false);
        expect(diagnostics.map((item) => item.code)).toEqual(['hook-rejected', 'hook-rejected']);
    });

    it('予約された名前は、事前に呼ぶもの、事後に呼ぶもの、値を返すものの合計', () => {
        expect(HOOK_EVENTS).toHaveLength(BEFORE_HOOKS.length + ON_HOOKS.length + VALUE_HOOKS.length);
        expect(HOOK_EVENTS.filter((event) => event.startsWith('before'))).toEqual([...BEFORE_HOOKS]);
    });

    it('フックが投げた例外は、そのフックだけを飛ばして続ける', () => {
        const later = vi.fn();
        const { runner, diagnostics, errors } = runnerOf([
            [
                './a.hooks.js',
                {
                    onDocument: () => {
                        throw new Error('壊れています');
                    },
                },
            ],
            ['./b.hooks.js', { onDocument: later }],
        ]);
        runner.emit('onDocument', {});
        expect(later).toHaveBeenCalledOnce();
        expect(errors).toHaveLength(1);
        expect(diagnostics.map((item) => [item.severity, item.code, item.message])).toEqual([['warning', 'hook-failed', './a.hooks.js の onDocument が例外を投げたので、このフックは飛ばしました: 壊れています']]);
    });

    it('フックの中から起こした変更では、取りやめの判断をもう一度行わない', () => {
        const guard = vi.fn(() => false as const);
        const results: boolean[] = [];
        const { runner, api } = runnerOf([
            ['./a.hooks.js', { beforeUpdate: guard }],
            ['./b.hooks.js', { onDocument: (ctx) => ctx.api.update('# 次\n') }],
        ]);
        // 図の側と同じように、api.update は差し替えの前に beforeUpdate を通す
        api.update = (next) => void results.push(runner.before('beforeUpdate', { next, previous: '# 今\n' }));
        runner.emit('onDocument', {});
        expect(guard).not.toHaveBeenCalled();
        expect(results).toEqual([true]);
        // フックの外から呼べば、いつもどおり取りやめられる
        expect(runner.before('beforeUpdate', { next: '# 次\n', previous: '# 今\n' })).toBe(false);
        expect(guard).toHaveBeenCalledOnce();
    });
});

describe('組み込みの規則 (markdag.rules)', () => {
    const rulesOf = (raw: unknown, doc?: HookDocument) => {
        const rules = rulesModule(raw);
        if (rules === null) throw new Error('規則が有効になっていません');
        return runnerOf([['markdag.rules', rules.module]], doc);
    };

    it('requireUpstreamDone は、祖先に入ってくる線もさかのぼって止める', () => {
        const { runner, diagnostics } = rulesOf({ taskToggle: { requireUpstreamDone: true } });
        const doc = documentOf();
        // 受け入れの確認 (テストの配下)。線は見出しに引かれているので、祖先の上流を見て止まる
        expect(runner.before('beforeTaskToggle', { node: doc.node(6)!, next: true, line: 5 }, true)).toBe(false);
        expect(diagnostics[0]?.message).toContain('先に終えるもの: 実装、設計');
        // 画面設計 (設計の配下) は上流がないので通る
        expect(runner.before('beforeTaskToggle', { node: doc.node(3)!, next: true, line: 2 }, true)).toBe(true);
        // 外すほうは止めない
        expect(runner.before('beforeTaskToggle', { node: doc.node(6)!, next: false, line: 5 }, true)).toBe(true);
    });

    it('readonlyGroups は、そのグループのノードの切り替えを止める', () => {
        const doc = documentOf([], MARKED, {});
        const { runner, diagnostics } = rulesOf({ taskToggle: { readonlyGroups: ['fixed'] } }, doc);
        expect(runner.before('beforeTaskToggle', { node: doc.node(3)!, next: true, line: 2 }, true)).toBe(false);
        expect(diagnostics[0]?.message).toContain('「fixed」のノードのタスクは切り替えられません');
    });

    it('keepMilestonesOpen は、マイルストーンの枝だけを閉じさせない', () => {
        const doc = documentOf([], MARKED, {});
        const { runner } = rulesOf({ fold: { keepMilestonesOpen: true } }, doc);
        expect(runner.before('beforeFold', { node: doc.node(2)!, folded: true }, true)).toBe(false);
        // 開くほうと、マイルストーンでないノードは通る
        expect(runner.before('beforeFold', { node: doc.node(2)!, folded: false }, true)).toBe(true);
        expect(runner.before('beforeFold', { node: doc.node(1)!, folded: true }, true)).toBe(true);
    });

    it('規則は、文書が宣言したフックより先に呼ばれる', () => {
        const frontmatter = { markdag: { rules: { fold: { keepMilestonesOpen: true } }, hooks: { $ref: './a.hooks.js' } } };
        const model = buildModel(NODES, frontmatter, undefined, { hookRefs: { './a.hooks.js': { onDocument: () => undefined } } });
        expect(model.hooks.hooks.map((hook) => hook.ref)).toEqual(['markdag.rules', './a.hooks.js']);
    });

    it('何も有効にしていない rules は、フックを足さない', () => {
        expect(rulesModule({ taskToggle: { requireUpstreamDone: false } })).toBeNull();
        expect(buildModel(NODES, { markdag: { rules: {} } }).hooks.hooks).toEqual([]);
    });

    it('readonlyGroups に書いた名前が文書になければ警告する', () => {
        const model = buildModel(NODES, { markdag: { rules: { taskToggle: { readonlyGroups: ['fixed'] } } } });
        expect(model.diagnostics.map((item) => [item.code, item.message])).toEqual([
            ['option-invalid', 'markdag.rules.taskToggle.readonlyGroups: グループ「fixed」は、この文書のどのノードにも付いていません'],
        ]);
    });
});

describe('値を返すフック', () => {
    it('transformSource は宣言の順につながり、次のフックには前の結果が渡る', () => {
        const { runner } = runnerOf([
            ['./a.hooks.js', { transformSource: (context) => `${context.source}\n<!-- a -->` }],
            ['./b.hooks.js', { transformSource: (context) => `${context.source}\n<!-- b -->` }],
        ]);
        expect(runner.transform('# 見出し')).toBe('# 見出し\n<!-- a -->\n<!-- b -->');
    });

    it('transformSource が何も返さなければそのまま、文字列以外なら警告する', () => {
        const { runner, diagnostics } = runnerOf([
            ['./a.hooks.js', { transformSource: () => undefined }],
            ['./b.hooks.js', { transformSource: () => 42 as unknown as string }],
        ]);
        expect(runner.transform('# 見出し')).toBe('# 見出し');
        expect(diagnostics.map((item) => [item.code, item.message])).toEqual([['hook-failed', './b.hooks.js の transformSource が文字列ではなく number を返しました']]);
    });

    it('decorateNode はクラスを並べ、説明と短い文字はあとのフックが勝つ', () => {
        const { runner } = runnerOf([
            ['./a.hooks.js', { decorateNode: () => ({ className: 'blocked', title: 'a', badge: '1' }) }],
            ['./b.hooks.js', { decorateNode: (context) => (context.node.id === 4 ? { className: 'late', title: 'b' } : undefined) }],
        ]);
        const doc = documentOf();
        expect(runner.decorate(doc.node(4)!)).toEqual({ className: 'blocked late', title: 'b', badge: '1' });
        expect(runner.decorate(doc.node(2)!)).toEqual({ className: 'blocked', title: 'a', badge: '1' });
    });

    it('飾りを返すフックがなければ null', () => {
        const { runner } = runnerOf([['./a.hooks.js', { onDocument: () => undefined }]]);
        expect(runner.decorate(documentOf().node(2)!)).toBeNull();
    });
});

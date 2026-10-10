// GUI 編集のタスク化 / タスク解除の、DOM を使わない部品の単体テスト。期待は spec.md の「案 2: X キー」「2 つ以上を選んだとき」「案 3」
// 「タスクにできるノード」と承認した受け入れの例 (screen/task-*) から書き、部品の中身はなぞらない。
// - X キー (commandForKey): 修飾キーなしの X と大文字の X (CapsLock) だけをタスク化 / 解除の命令にする。⌘X、Ctrl+X、Alt+X、Shift+X は命令にしない
//   (ブラウザの切り取りなどのまま)。mac と win で同じ
// - 選んだノードの決まり (taskPlan): タスクにできるものだけを見て、1 つでもタスクでないものがあればタスク化 (書くのはタスクでないものだけ)、
//   全部タスクならタスク解除。タスクにできないノードはスキップの数に数え、読み取りだけのグループのノードはスキップしてグループを控え、
//   タスク化か解除かは残りで決める。残りがなければ書き換えない (null)
// - 読み取りだけのグループのノードだけのとき (lockedTaskOf): しようとした操作 (1 つでもタスクでないものがあればタスク化、全部タスクなら解除) と、そのグループ
// - 読み取りだけのグループの引き方 (taskLocksOf): 文書の markdag.rules.taskToggle.readonlyGroups と、親から受け継いだ所属 (0.12.1 の規則と同じ)
// - タスクにできるか (canBeTask): 自分の行を持つ見出しと項目。名前が空の項目、表、コード、リストの入れ物、自分の行を持たないルートはできない
// - ノードの左のチェックを出すノードの条件 (選んだ 1 つが、タスクにできて、タスクでなく、読み取りだけのグループに入らない)
// - 操作の組み立て (toggleTaskMarkOp) と、EditOp の型が markdag と markdag/core の入口から同じ形で出ること
// 帯のボタン、ヒント、命令の部品 (書き換えとスナックバーの文) は editor-tasks-ui、原文の書き換えの形は Rust の edit_task_mark が受け持つ。
// 道具、入力、閲覧、2 つ以上を選んだときにチェックを出さないことと、キーを受ける条件 (mount の振り分け) は e2e の受け入れの例が受け持つ
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '../src/core';
import type { EditOp as CoreEditOp, NodeTarget, ViewDocument } from '../src/core';
import type { EditOp as MainEditOp } from '../src/index';
import { toggleTaskMarkOp } from '../src/editor/commands';
import { commandForKey, type KeyInput, type KeyPlatform } from '../src/editor/keys';
import { blockedAdding, canBeTask, lockedTaskOf, taskLocksOf, taskPlan, type TaskFacts } from '../src/editor/tasks';

type Modifiers = Partial<Omit<KeyInput, 'key'>>;

const input = (key: string, modifiers: Modifiers = {}): KeyInput => Object.freeze({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

const label = (modifiers: Modifiers): string => Object.entries(modifiers).flatMap(([name, on]) => (on ? [name.replace('Key', '')] : [])).join('+') || 'なし';

const PLATFORMS: readonly KeyPlatform[] = ['mac', 'win'];

describe('X キー (commandForKey): spec.md「案 2: X キー」', () => {
    for (const platform of PLATFORMS) {
        it(`${platform}: 修飾キーなしの X と大文字の X (CapsLock) はタスク化 / 解除の命令`, () => {
            expect(commandForKey(input('x'), platform)).toBe('task');
            expect(commandForKey(input('X'), platform)).toBe('task');
        });

        it(`${platform}: ⌘X、Ctrl+X、Alt+X、Shift+X と、それらを組み合わせたものは命令にしない (ブラウザの切り取りなどのまま)`, () => {
            // screen/task-key-x-ignored の Shift+X、⌘X、Ctrl+X、Alt+X は何もせず既定の動きを止めない
            const modifierSets: readonly Modifiers[] = [
                { shiftKey: true },
                { metaKey: true },
                { ctrlKey: true },
                { altKey: true },
                { metaKey: true, shiftKey: true },
                { ctrlKey: true, shiftKey: true },
                { altKey: true, shiftKey: true },
                { metaKey: true, ctrlKey: true },
                { ctrlKey: true, altKey: true },
            ];
            for (const modifiers of modifierSets) {
                for (const key of ['x', 'X']) {
                    expect(commandForKey(input(key, modifiers), platform), `${label(modifiers)} + ${key}`).toBeNull();
                }
            }
        });
    }

    it('X のほかの 1 文字のキーの命令は変わらない (D は詳細、T はタグ追加、Shift つきも同じ)', () => {
        // X だけが Shift を見て外す。D と T は 0.12.1 のまま
        for (const platform of PLATFORMS) {
            expect(commandForKey(input('d'), platform)).toBe('details');
            expect(commandForKey(input('D', { shiftKey: true }), platform)).toBe('details');
            expect(commandForKey(input('t'), platform)).toBe('tag-add');
            expect(commandForKey(input('T', { shiftKey: true }), platform)).toBe('tag-add');
        }
    });
});

// 事実を引く文書。ノード: 1 引っ越し / 2 準備 / 3 見積もりを取る / 4 [ ] 荷造りの箱を買う / 5 [x] 新居を決める / 6 名前が空の項目 /
// 7 名前が `[ ] 逃がした名前` の項目 / 8 決まったこと (%lock) / 9 [x] 業者を決める / 10 日取りを決める / 11 固めたこと (%fix) / 12 会場を決める /
// 13 費用 / 14 表 / 15 下線の見出し / 16 [/] 下線の見出しの子。決まったことと固めたことの子は、親から所属を受け継ぐ
const LOCKED = [
    '---',
    'markdag:',
    '    groups:',
    '        lock:',
    '            label: 確定済み',
    '        fix:',
    '            label: 固定',
    '    rules:',
    '        taskToggle:',
    '            readonlyGroups: [lock, fix]',
    '---',
    '',
    '# 引っ越し',
    '',
    '## 準備',
    '- 見積もりを取る',
    '- [ ] 荷造りの箱を買う',
    '- [x] 新居を決める',
    '- ',
    '- \\[ ] 逃がした名前',
    '',
    '## 決まったこと %lock',
    '- [x] 業者を決める',
    '- 日取りを決める',
    '',
    '## 固めたこと %fix',
    '- 会場を決める',
    '',
    '## 費用',
    '',
    '| 項目 | 金額 |',
    '| --- | --- |',
    '| 運送 | 50000 |',
    '',
    '片付け',
    '---',
    '',
    '- [/] 掃除',
    '',
].join('\n');

function viewDocument(source: string): ViewDocument {
    const parsed = core.parseDocument(source);
    return { parsed, model: core.buildModel(parsed.nodes, parsed.frontmatter, source) };
}

const DOC = viewDocument(LOCKED);

function target(refText: string): NodeTarget {
    const found = DOC.parsed.nodes.filter((node) => node.refText === refText);
    if (found.length !== 1) throw new Error(`「${refText}」のノードが 1 つ: ${found.length}`);
    const [node] = found;
    return { id: node!.id, refText: node!.refText };
}

function byId(id: number): NodeTarget {
    const node = DOC.parsed.nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない`);
    return { id, refText: node.refText };
}

const factsOf = (node: NodeTarget): TaskFacts | null => core.inspectNode(LOCKED, node);
const lockOf = taskLocksOf(DOC);
const NO_LOCK = taskLocksOf(null);

const ESTIMATE = target('見積もりを取る');
const BOXES = target('荷造りの箱を買う');
const HOUSE = target('新居を決める');
const EMPTY = byId(6);
const ESCAPED = target('[ ] 逃がした名前');
const DECIDED = target('決まったこと');
const MOVERS = target('業者を決める');
const DATE = target('日取りを決める');
const FIXED = target('固めたこと');
const VENUE = target('会場を決める');
const COST = target('費用');
const TABLE = byId(14);
const SETEXT = target('片付け');
const CLEAN = target('掃除');
const ROOT = target('引っ越し');

// written の比べ方 (並びは問わない)
const ids = (nodes: readonly NodeTarget[]): number[] => nodes.map((node) => node.id).sort((a, b) => a - b);

describe('文書の前提', () => {
    it('事実を引く文書のノードは、名前と種類とタスクの状態が意図どおり', () => {
        expect(EMPTY.refText).toBe('');
        expect(factsOf(EMPTY)?.kind).toBe('item');
        expect(factsOf(TABLE)?.kind).toBe('block');
        expect(factsOf(SETEXT)?.kind).toBe('heading');
        expect(factsOf(CLEAN)?.task).toBe(true);
        expect(factsOf(MOVERS)?.task).toBe(true);
        expect(factsOf(DATE)?.task).toBe(false);
        expect(DOC.parsed.nodes).toHaveLength(16);
    });
});

describe('タスクにできるか (canBeTask): spec.md「タスクにできるノード」', () => {
    it('自分の行を持つ見出し (ルートと下線の見出しを含む) と項目はできる。タスクのものも、名前が `[ ]` の項目もできる', () => {
        for (const node of [ROOT, COST, SETEXT, ESTIMATE, BOXES, HOUSE, ESCAPED, CLEAN]) expect(canBeTask(factsOf(node)), node.refText).toBe(true);
    });

    it('名前が空の項目、表はできない。事実がない (図と原文が合わない) ノードもできない', () => {
        // 名前が空の項目は記号を付けると名前が `[ ]` の項目に読まれるため (例の承認の関門 9/17 の c)
        expect(canBeTask(factsOf(EMPTY))).toBe(false);
        expect(canBeTask(factsOf(TABLE))).toBe(false);
        expect(canBeTask(null)).toBe(false);
    });

    it('リストの入れ物、コード、自分の行を持たないルートはできない', () => {
        const containers = '# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n';
        const container = core.parseDocument(containers).nodes.find((node) => node.refText === '赤')!.parent!;
        expect(canBeTask(core.inspectNode(containers, { id: container, refText: '' }))).toBe(false);

        const code = '# R\n\n## 控え\n\n```\nmemo\n```\n';
        const block = core.parseDocument(code).nodes.find((node) => node.parent === 2)!;
        expect(canBeTask(core.inspectNode(code, { id: block.id, refText: block.refText }))).toBe(false);

        const titled = '---\ntitle: 買い物リスト\n---\n\n- 牛乳\n';
        expect(canBeTask(core.inspectNode(titled, { id: 1, refText: '買い物リスト' }))).toBe(false);

        const listOnly = '- 牛乳\n- 卵\n';
        const root = core.parseDocument(listOnly).nodes.find((node) => node.parent === null)!;
        expect(canBeTask(core.inspectNode(listOnly, { id: root.id, refText: root.refText }))).toBe(false);
    });
});

describe('選んだノードの決まり (taskPlan): spec.md「2 つ以上を選んだとき」', () => {
    it('タスクでないノード 1 つはタスク化、タスクのノード 1 つはタスク解除 (状態によらない)', () => {
        expect(taskPlan([ESTIMATE], factsOf, lockOf)).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 0, locked: [] });
        expect(taskPlan([BOXES], factsOf, lockOf)).toMatchObject({ adding: false, written: [BOXES], skipped: 0, locked: [] });
        expect(taskPlan([HOUSE], factsOf, lockOf)).toMatchObject({ adding: false, written: [HOUSE] });
        expect(taskPlan([CLEAN], factsOf, lockOf)).toMatchObject({ adding: false, written: [CLEAN] });
    });

    it('1 つでもタスクでないものがあればタスク化で、書くのはタスクでないものだけ (タスクのものは状態のまま。変異 M04 の決まり)', () => {
        const plan = taskPlan([BOXES, ESTIMATE, HOUSE, SETEXT], factsOf, lockOf);
        expect(plan?.adding).toBe(true);
        expect(ids(plan?.written ?? [])).toEqual(ids([ESTIMATE, SETEXT]));
        expect(plan?.skipped).toBe(0);
    });

    it('全部タスクならタスク解除で、全部を書く', () => {
        const plan = taskPlan([BOXES, HOUSE, CLEAN], factsOf, lockOf);
        expect(plan?.adding).toBe(false);
        expect(ids(plan?.written ?? [])).toEqual(ids([BOXES, HOUSE, CLEAN]));
    });

    it('タスクにできないノード (表、名前が空の項目) はスキップの数に数え、タスク化か解除かはタスクにできるものだけで決める', () => {
        expect(taskPlan([ESTIMATE, TABLE], factsOf, lockOf)).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 1, locked: [] });
        expect(taskPlan([EMPTY, ESTIMATE], factsOf, lockOf)).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 1 });
        // 表とタスクだけなら「全部タスク」でタスク解除
        expect(taskPlan([TABLE, HOUSE], factsOf, lockOf)).toMatchObject({ adding: false, written: [HOUSE], skipped: 1 });
    });

    it('タスクにできるノードがなければ null (書き換えない)', () => {
        expect(taskPlan([], factsOf, lockOf)).toBeNull();
        expect(taskPlan([TABLE], factsOf, lockOf)).toBeNull();
        expect(taskPlan([EMPTY], factsOf, lockOf)).toBeNull();
        expect(taskPlan([TABLE, EMPTY], factsOf, lockOf)).toBeNull();
        expect(taskPlan([ESTIMATE], () => null, lockOf)).toBeNull();
    });

    it('U2: 読み取りだけのグループのノードはタスク化もタスク解除もせずスキップし、グループをノードごとに控える。書くのは残りだけ (変異 M07 の決まり)', () => {
        const plan = taskPlan([ESTIMATE, DATE], factsOf, lockOf);
        expect(plan).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 0, locked: ['lock'] });
        // 親の見出し (グループの印を持つノード) そのものも読み取りだけ
        expect(taskPlan([ESTIMATE, DECIDED], factsOf, lockOf)).toMatchObject({ written: [ESTIMATE], locked: ['lock'] });
    });

    it('U2: タスク化か解除かは、スキップするノードを除いた残りで決める (screen/task-readonly-skip の「荷造りの箱を買う」と「日取りを決める」)', () => {
        // 読み取りだけの「日取りを決める」はタスクでないが、残りの「荷造りの箱を買う」が全部タスクなのでタスク解除
        expect(taskPlan([BOXES, DATE], factsOf, lockOf)).toMatchObject({ adding: false, written: [BOXES], skipped: 0, locked: ['lock'] });
    });

    it('U2: タスクにできないノードと読み取りだけのグループのノードは、別々に数える。グループが 2 つでもノードごとに控える', () => {
        expect(taskPlan([ESTIMATE, MOVERS, TABLE], factsOf, lockOf)).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 1, locked: ['lock'] });
        const plan = taskPlan([ESTIMATE, MOVERS, DATE, VENUE], factsOf, lockOf);
        expect(plan).toMatchObject({ adding: true, written: [ESTIMATE], skipped: 0 });
        expect([...(plan?.locked ?? [])].sort()).toEqual(['fix', 'lock', 'lock']);
    });

    it('U2: 選んだものが全部読み取りだけのグループのノード (かタスクにできないノード) なら null (書き換えない)', () => {
        expect(taskPlan([DATE], factsOf, lockOf)).toBeNull();
        expect(taskPlan([MOVERS, DATE], factsOf, lockOf)).toBeNull();
        expect(taskPlan([MOVERS, TABLE], factsOf, lockOf)).toBeNull();
    });

    it('読み取りだけのグループがない文書 (引き方を渡さないとき) は、グループのノードもふつうに書く', () => {
        expect(taskPlan([DATE], factsOf)).toMatchObject({ adding: true, written: [DATE], locked: [] });
        expect(taskPlan([MOVERS, DATE], factsOf, NO_LOCK)).toMatchObject({ adding: true, written: [DATE] });
    });
});

describe('読み取りだけのグループのノードだけのとき (lockedTaskOf): 無効のボタンの名前と断る文の操作', () => {
    it('1 つでもタスクでないものがあればタスク化、全部タスクならタスク解除 (screen/task-readonly-refused の名前)', () => {
        expect(lockedTaskOf([MOVERS], factsOf, lockOf)).toEqual({ group: 'lock', adding: false });
        expect(lockedTaskOf([DATE], factsOf, lockOf)).toEqual({ group: 'lock', adding: true });
        expect(lockedTaskOf([MOVERS, DATE], factsOf, lockOf)).toEqual({ group: 'lock', adding: true });
        expect(lockedTaskOf([VENUE], factsOf, lockOf)).toEqual({ group: 'fix', adding: true });
    });

    it('タスクにできないノードと一緒でも、読み取りだけのグループのノードで決める。タスクにできないノードだけなら null', () => {
        expect(lockedTaskOf([TABLE, MOVERS], factsOf, lockOf)).toEqual({ group: 'lock', adding: false });
        expect(lockedTaskOf([TABLE], factsOf, lockOf)).toBeNull();
        expect(lockedTaskOf([ESTIMATE], factsOf, lockOf)).toBeNull();
    });
});

describe('読み取りだけのグループの引き方 (taskLocksOf)', () => {
    it('印のあるノードと、親から所属を受け継いだノードが入る。ほかのノードは null', () => {
        expect(lockOf(DECIDED)).toBe('lock');
        expect(lockOf(MOVERS)).toBe('lock');
        expect(lockOf(DATE)).toBe('lock');
        expect(lockOf(FIXED)).toBe('fix');
        expect(lockOf(VENUE)).toBe('fix');
        for (const node of [ROOT, ESTIMATE, BOXES, TABLE, SETEXT, CLEAN]) expect(lockOf(node), node.refText).toBeNull();
    });

    it('readonlyGroups がない文書と、文書がないときは、どのノードも null', () => {
        const plain = viewDocument(LOCKED.replace('            readonlyGroups: [lock, fix]\n', '            requireUpstreamDone: true\n'));
        const locks = taskLocksOf(plain);
        for (const node of [DECIDED, MOVERS, DATE, VENUE]) expect(locks(node)).toBeNull();
        expect(NO_LOCK(DATE)).toBeNull();
    });
});

describe('ノードの左のチェックを出すノード: spec.md「案 3」(選んだ 1 つが、タスクにできて、タスクでなく、読み取りだけのグループに入らない)', () => {
    // 道具、入力、閲覧、2 つ以上の選択は mount が見る (e2e の screen/task-check と task-check-hidden)
    const shows = (node: NodeTarget): boolean => {
        const facts = factsOf(node);
        return canBeTask(facts) && !facts.task && lockOf(node) === null;
    };

    it('タスクでない項目と見出し (ルート、下線の見出し) と、名前が `[ ]` の項目には出す', () => {
        for (const node of [ESTIMATE, ROOT, COST, SETEXT, ESCAPED]) expect(shows(node), node.refText).toBe(true);
    });

    it('タスクのノード (状態によらない)、表、名前が空の項目、読み取りだけのグループのノードには出さない (screen/task-check)', () => {
        for (const node of [BOXES, HOUSE, CLEAN, TABLE, EMPTY, DATE, MOVERS, DECIDED, VENUE]) expect(shows(node), `${node.id}`).toBe(false);
    });

    it('出すノード 1 つの決まりはタスク化で、そのノードだけを書く (チェックは解除をしない。押したらタスク化だけ)', () => {
        for (const node of [ESTIMATE, ROOT, SETEXT, ESCAPED]) expect(taskPlan([node], factsOf, lockOf)).toMatchObject({ adding: true, written: [node] });
    });
});

describe('1 行目が文章でない項目と、外すと HTML のブロックとして読まれるタスク (レビューの B-01、A-02、B-02、B-03、A-01)', () => {
    // markdag キーのない文書。2 [ ] <div>d</div> の下線の見出し (外すと HTML のブロックが下線の行を飲み込む) / 3 a (印のあとの空白が 5 つ) /
    // 4 見出しの項目 / 5 1 行目が空で 2 行目に名前 / 6 b / 7 [x] c
    const PLAIN = '# R\n\n[ ] <div>d</div>\n---\n\n-     a\n- # 見出し\n-\n  空のあと\n- b\n- [x] c\n';
    const plainOf = (node: NodeTarget): TaskFacts | null => core.inspectNode(PLAIN, node);
    const plain = (id: number): NodeTarget => {
        const node = core.parseDocument(PLAIN).nodes.find((item) => item.id === id);
        if (node === undefined) throw new Error(`id ${id} のノードがない`);
        return { id, refText: node.refText };
    };
    const [HTML, CODE, HEADING, SECOND_LINE, B, C] = [2, 3, 4, 5, 6, 7].map(plain) as [NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget];

    it('文書の前提: 図の名前があり、1 行目が文章でない 3 つはタスクでなく、外すと HTML になるノードはタスク', () => {
        expect([CODE, HEADING, SECOND_LINE, B, C, HTML].map((node) => node.refText)).toEqual(['a', '見出し', '空のあと', 'b', 'c', 'd']);
        for (const node of [CODE, HEADING, SECOND_LINE]) expect(plainOf(node)?.task, node.refText).toBe(false);
        expect(plainOf(HTML)?.task).toBe(true);
    });

    it('1 行目が文章でない項目はタスクにできない (チェックを出さない、帯のボタンは無効)。事実の canToggleTask が false', () => {
        for (const node of [CODE, HEADING, SECOND_LINE]) {
            expect(plainOf(node)?.canToggleTask, node.refText).toBe(false);
            expect(canBeTask(plainOf(node)), node.refText).toBe(false);
            expect(taskPlan([node], plainOf), node.refText).toBeNull();
        }
    });

    it('外すと HTML のブロックとして読まれるタスクは、タスクとして数えるが外せない (1 つだけなら書き換えない)', () => {
        expect(plainOf(HTML)?.canToggleTask).toBe(false);
        expect(canBeTask(plainOf(HTML))).toBe(true);
        expect(taskPlan([HTML], plainOf)).toBeNull();
    });

    it('2 つ以上なら、そのノードだけをスキップの数に数え、残りを書く (全体を断らない)', () => {
        expect(taskPlan([CODE, HEADING, SECOND_LINE, B], plainOf)).toMatchObject({ adding: true, written: [B], skipped: 3, locked: [] });
        // 外せないタスクとタスクなら、外せるタスクだけを外す
        expect(taskPlan([HTML, C], plainOf)).toMatchObject({ adding: false, written: [C], skipped: 1, locked: [] });
        // タスクでないノードがあればタスク化で、外せないタスクは状態のまま (スキップに数えない)
        expect(taskPlan([HTML, B], plainOf)).toMatchObject({ adding: true, written: [B], skipped: 0, locked: [] });
    });

    it('書き換えられるノードがないときにしようとした操作 (blockedAdding): 外せないタスクならタスク解除、タスクにできない項目ならタスク化', () => {
        expect(blockedAdding([HTML], plainOf, NO_LOCK)).toBe(false);
        expect(blockedAdding([CODE], plainOf, NO_LOCK)).toBe(true);
        expect(blockedAdding([CODE, HTML], plainOf, NO_LOCK)).toBe(false);
        // 読み取りだけのグループのノードがあれば、そのノードで決める (lockedTaskOf と同じ)
        expect(blockedAdding([MOVERS], factsOf, lockOf)).toBe(false);
        expect(blockedAdding([DATE], factsOf, lockOf)).toBe(true);
        expect(blockedAdding([TABLE], factsOf, lockOf)).toBe(true);
    });
});

describe('1 行目が文章でない項目は markdag キーの有無によらず、名前が HTML のブロックで始まる項目はその例外', () => {
    // markdag キーのある文書。2 1. a (番号付きのリストで始まる) / 3 b (印のあとの空白が 5 つ) / 4 # c (見出しで始まる) / 5 <div>d</div> /
    // 6 [ ] <div>e</div> / 7 f
    const KEYED = '---\nmarkdag:\n---\n# R\n\n- 1. a\n-     b\n- # c\n- <div>d</div>\n- [ ] <div>e</div>\n- f\n';
    // markdag キーのない文書。2 d (<div>d</div>) / 3 [ ] e (<div>e</div>) / 4 f
    const PLAIN = '# R\n\n- <div>d</div>\n- [ ] <div>e</div>\n- f\n';
    const factsIn = (source: string) => (node: NodeTarget): TaskFacts | null => core.inspectNode(source, node);
    const nodeIn = (source: string, id: number): NodeTarget => {
        const node = core.parseDocument(source).nodes.find((item) => item.id === id);
        if (node === undefined) throw new Error(`id ${id} のノードがない`);
        return { id, refText: node.refText };
    };
    const [NUMBERED, CODE, HEADING, DIV, DIV_TASK, F] = [2, 3, 4, 5, 6, 7].map((id) => nodeIn(KEYED, id)) as [NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget];

    it('文書の前提: キーのある文書は 1 行目を文字として読み、名前に記号を含む', () => {
        expect([NUMBERED, CODE, HEADING, DIV, DIV_TASK, F].map((node) => node.refText)).toEqual(['1. a', 'b', '# c', '<div>d</div>', '<div>e</div>', 'f']);
        expect([2, 3].map((id) => nodeIn(PLAIN, id).refText)).toEqual(['d', 'e']);
    });

    it('キーのある文書でも、1 行目が文章でない項目はタスクにできない (チェックを出さない、帯のボタンは無効)。事実の canToggleTask が false', () => {
        for (const node of [NUMBERED, CODE, HEADING]) {
            expect(factsIn(KEYED)(node)?.canToggleTask, node.refText).toBe(false);
            expect(canBeTask(factsIn(KEYED)(node)), node.refText).toBe(false);
            expect(taskPlan([node], factsIn(KEYED)), node.refText).toBeNull();
            expect(blockedAdding([node], factsIn(KEYED), NO_LOCK), node.refText).toBe(true);
        }
        expect(taskPlan([NUMBERED, CODE, HEADING, F], factsIn(KEYED))).toMatchObject({ adding: true, written: [F], skipped: 3, locked: [] });
    });

    it('名前が HTML のブロックで始まる項目は、キーの有無によらずタスク化もタスク解除もできる', () => {
        for (const [source, plain, task] of [
            [KEYED, DIV, DIV_TASK],
            [PLAIN, nodeIn(PLAIN, 2), nodeIn(PLAIN, 3)],
        ] as const) {
            expect(factsIn(source)(plain)?.canToggleTask, source).toBe(true);
            expect(taskPlan([plain], factsIn(source)), source).toMatchObject({ adding: true, written: [plain], skipped: 0 });
            expect(factsIn(source)(task)?.canToggleTask, source).toBe(true);
            expect(taskPlan([task], factsIn(source)), source).toMatchObject({ adding: false, written: [task], skipped: 0 });
        }
    });
});

describe('操作の組み立てと型', () => {
    it('toggleTaskMarkOp は選んだノードの id と refText だけを写した toggleTaskMark の操作', () => {
        const extra = { id: 3, refText: '見積もりを取る', note: 'x' } as NodeTarget;
        const op = toggleTaskMarkOp([extra, TABLE]);
        expect(op).toEqual({ kind: 'toggleTaskMark', nodes: [{ id: 3, refText: '見積もりを取る' }, TABLE] });
        expect(op.kind === 'toggleTaskMark' && op.nodes[0]).not.toBe(extra);
    });

    it('型: toggleTaskMark の操作は markdag と markdag/core の入口から同じ形で出る', () => {
        expectTypeOf<Extract<CoreEditOp, { kind: 'toggleTaskMark' }>>().toEqualTypeOf<{ kind: 'toggleTaskMark'; nodes: NodeTarget[] }>();
        expectTypeOf<Extract<MainEditOp, { kind: 'toggleTaskMark' }>>().toEqualTypeOf<{ kind: 'toggleTaskMark'; nodes: NodeTarget[] }>();
    });

    it('組み立てた操作は書き換えの入口が読める (どちらの向きも 1 回で、名前と id は変わらない)', () => {
        const source = '# R\n- a\n- [x] b\n';
        const marked = core.editSource(source, toggleTaskMarkOp([{ id: 2, refText: 'a' }, { id: 3, refText: 'b' }]));
        expect(marked).toMatchObject({ status: 'edited', source: '# R\n- [ ] a\n- [x] b\n', rename: null });
        const unmarked = core.editSource('# R\n- [ ] a\n- [x] b\n', toggleTaskMarkOp([{ id: 2, refText: 'a' }, { id: 3, refText: 'b' }]));
        expect(unmarked).toMatchObject({ status: 'edited', source: '# R\n- a\n- b\n', rename: null });
    });
});

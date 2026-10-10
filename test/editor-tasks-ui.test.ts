// GUI 編集のタスク化 / タスク解除の、帯のボタン、ヒント、命令の部品 (書き換えとスナックバーの文) の単体テスト。期待は spec.md の「案 1」「案 2」「案 3」
// 「2 つ以上を選んだとき」「書き換えのあと」と承認した受け入れの例 (screen/task-*) から書き、部品の中身はなぞらない。
// - 帯 (ContextBar): タスクのボタンはタグ選択のあと、区切りと削除の前 (ルートでは最後)。グループの帯には出さない。名前は「タスク化」/「タスク解除」、
//   title に X。今でない名前も見えない字でボタンに持ち、名前が替わっても幅を変えない。無効は押せない見た目でも押下を受け、押されたことを知らせる。
//   名前だけが替わっても組み直す
// - ヒント (Hint): ノード 1 つと 2 つ以上の行に「X タスク化 / 解除」。「Space タスクを進める」は残す。ほかの選び方、道具、入力の行には出さない
// - 命令の部品 (EditCommands): 1 回の操作で原文の書き換えも履歴も 1 つ、選んでいたものは選んだまま、図を動かさない。
//   スナックバーの文 (タスク化、解除、数、スキップの括弧書き、断る文)。読み取りだけのグループのノードは操作に渡さずにスキップし (U2)、全部なら
//   しようとした操作に合う理由で断る。ノードの左のチェックはそのノード 1 つだけをタスク化し、タスクのノードと読み取りだけのグループのノードには何もしない
// DOM の層は、部品が作る要素のための小さな作り物 (この中の FakeElement) を document に差し込んで動かす。図の側 (view) は描いた文書を返すだけの作り物、
// 原文の持ち主は本物の EditorSource に、原文を差し替えるだけの図の作り物をつなぐ。帯を置く位置 (押した直後に保つ) と、キーとチェックを受ける条件は
// mount が受け持つので e2e の受け入れの例 (screen/task-bar-hold、task-check、task-key-x-*) が見る
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/core';
import type { Diagnostic, EditOp, MarkdagDiagram, NodeTarget, ViewDocument } from '../src/core';
import { EditCommands, editedNotice } from '../src/editor/commands';
import { nodesSelection, selectedNodes, type EditorSelection } from '../src/editor/selection';
import { EditorSource } from '../src/editor/source';
import { ContextBar } from '../src/editor/ui/context-bar';
import { Hint } from '../src/editor/ui/hint';
import type { NoticeKind } from '../src/editor/ui/snackbar';

// ---- 部品が作る要素の作り物 ----

class FakeText {
    constructor(readonly data: string) {}

    get textContent(): string {
        return this.data;
    }
}

type FakeChild = FakeElement | FakeText;

class FakeElement {
    readonly childNodes: FakeChild[] = [];
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, string> = {};
    className = '';
    title = '';
    type = '';
    disabled = false;
    hidden = false;
    value = '';
    private readonly attributes = new Map<string, string>();
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(readonly tagName: string) {}

    get textContent(): string {
        return this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(text: string) {
        this.childNodes.length = 0;
        this.childNodes.push(new FakeText(String(text)));
    }

    get children(): FakeElement[] {
        return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
    }

    get isConnected(): boolean {
        return false;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, String(value));
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    hasAttribute(name: string): boolean {
        return this.attributes.has(name);
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    append(...nodes: Array<FakeChild | string>): void {
        for (const node of nodes) this.childNodes.push(typeof node === 'string' ? new FakeText(node) : node);
    }

    replaceChildren(...nodes: Array<FakeChild | string>): void {
        this.childNodes.length = 0;
        this.append(...nodes);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    removeEventListener(): void {}

    contains(node: unknown): boolean {
        return node === this || this.children.some((child) => child.contains(node));
    }

    click(): void {
        for (const listener of this.listeners.get('click') ?? []) listener({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }

    focus(): void {}

    blur(): void {}
}

const fakeDocument = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) => new FakeElement(tagName),
    createTextNode: (text: string) => new FakeText(text),
    activeElement: null,
    hasFocus: () => false,
};

beforeEach(() => {
    vi.stubGlobal('document', fakeDocument);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const fake = (element: unknown): FakeElement => element as FakeElement;

// ---- 帯 ----

const example = (path: string): string => readFileSync(new URL(`../testdata/acceptance/gui-editor/${path}`, import.meta.url), 'utf8');

const ITEM_DOC = '# 引っ越し\n\n## 準備\n- 見積もりを取る\n';
const ITEM_FACTS = core.inspectNode(ITEM_DOC, { id: 3, refText: '見積もりを取る' });

// 帯の並び: ボタンは data-command、区切りは sep、先頭の欄は title
function layoutOf(bar: ContextBar): string[] {
    return fake(bar.element).children.map((item) => (item.className === 'mdag-editor-bar-sep' ? 'sep' : item.className === 'mdag-editor-bar-title' ? 'title' : (item.dataset.command ?? '?')));
}

function taskButton(bar: ContextBar): FakeElement {
    const found = fake(bar.element).children.filter((item) => item.dataset.command === 'task');
    expect(found).toHaveLength(1);
    return found[0]!;
}

// ボタンの名前の入れ物 (絵のあと)
function labelOf(button: FakeElement): FakeElement {
    const label = button.children.find((child) => child.tagName === 'span');
    if (label === undefined) throw new Error('名前の入れ物がない');
    return label;
}

describe('帯のタスクのボタン (ContextBar): spec.md「案 1」', () => {
    it('ノード 1 つの帯: タグ選択のあと、区切りと削除の前に出る (screen/select-node-bar、task-bar-one)', () => {
        const bar = new ContextBar(() => {});
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: true } });
        expect(layoutOf(bar)).toEqual(['rename', 'child', 'sibling', 'details', 'tag-add', 'tag-select', 'task', 'sep', 'delete']);
    });

    it('ルートの帯: 兄弟追加と削除がないので、タスクのボタンが最後 (区切りもない)', () => {
        const bar = new ContextBar(() => {});
        const facts = core.inspectNode(ITEM_DOC, { id: 1, refText: '引っ越し' });
        bar.show({ for: 'node', root: true, facts, task: { name: 'add', enabled: true } });
        expect(layoutOf(bar)).toEqual(['rename', 'child', 'details', 'tag-add', 'tag-select', 'task']);
    });

    it('2 つ以上の帯: タグ選択のあと、区切りと削除の前に出る (screen/multi-select、task-bar-mixed)', () => {
        const bar = new ContextBar(() => {});
        bar.show({ for: 'nodes', count: 3, task: { name: 'add', enabled: true } });
        expect(layoutOf(bar)).toEqual(['title', 'join-new', 'join-existing', 'group', 'tag-add', 'tag-select', 'task', 'sep', 'delete']);
    });

    it('グループの帯には出さない', () => {
        const bar = new ContextBar(() => {});
        bar.show({ for: 'group', label: '組' });
        expect(layoutOf(bar)).toEqual(['title', 'rename-group', 'ungroup']);
    });

    it('名前は状態で「タスク化」と「タスク解除」。どちらも title に X を書く (ノード 1 つと 2 つ以上)', () => {
        for (const content of [
            { for: 'node', root: false, facts: ITEM_FACTS },
            { for: 'nodes', count: 2 },
        ] as const) {
            const bar = new ContextBar(() => {});
            bar.show({ ...content, task: { name: 'add', enabled: true } });
            expect(labelOf(taskButton(bar)).textContent, content.for).toBe('タスク化');
            expect(taskButton(bar).title, content.for).toContain('(X)');
            bar.show({ ...content, task: { name: 'remove', enabled: true } });
            expect(labelOf(taskButton(bar)).textContent, content.for).toBe('タスク解除');
            expect(taskButton(bar).title, content.for).toContain('(X)');
        }
    });

    it('名前が替わっても幅を変えない: 今でない名前を見えない字でボタンに持つ (2 つの名前の長いほうの幅。変異 M08)', () => {
        const bar = new ContextBar(() => {});
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: true } });
        expect(labelOf(taskButton(bar)).dataset.other).toBe('タスク解除');
        bar.show({ for: 'nodes', count: 2, task: { name: 'remove', enabled: true } });
        expect(labelOf(taskButton(bar)).dataset.other).toBe('タスク化');
        // 見えない字は見た目の側が同じ所に重ねて、場所だけを取る
        const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
        const rules = css.split('}').filter((rule) => rule.includes('[data-command="task"]') && rule.includes('attr(data-other)'));
        expect(rules.some((rule) => rule.includes('visibility: hidden'))).toBe(true);
    });

    it('名前だけが替わっても組み直す (押して「タスク化」から「タスク解除」に替わる)', () => {
        const bar = new ContextBar(() => {});
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: true } });
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'remove', enabled: true } });
        expect(labelOf(taskButton(bar)).textContent).toBe('タスク解除');
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: true } });
        expect(labelOf(taskButton(bar)).textContent).toBe('タスク化');
    });

    it('書き換えられるノードがなければ無効の見た目 (aria-disabled) にするが、押下は受けて押されたことを知らせる (押したら理由を出すため)', () => {
        const pressed: string[] = [];
        const bar = new ContextBar((command) => pressed.push(command));
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'remove', enabled: false } });
        const button = taskButton(bar);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.disabled).toBe(false);
        expect(labelOf(button).textContent).toBe('タスク解除');
        button.click();
        expect(pressed).toEqual(['task']);

        bar.show({ for: 'nodes', count: 2, task: { name: 'add', enabled: false } });
        expect(taskButton(bar).getAttribute('aria-disabled')).toBe('true');
        taskButton(bar).click();
        expect(pressed).toEqual(['task', 'task']);
    });

    it('有効なら無効の見た目にしない。無効から有効に替わると組み直す', () => {
        const pressed: string[] = [];
        const bar = new ContextBar((command) => pressed.push(command));
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: false } });
        bar.show({ for: 'node', root: false, facts: ITEM_FACTS, task: { name: 'add', enabled: true } });
        const button = taskButton(bar);
        expect(button.hasAttribute('aria-disabled')).toBe(false);
        expect(button.disabled).toBe(false);
        button.click();
        expect(pressed).toEqual(['task']);
    });

    it('自分の行を持たないルートでは、タスクのボタンは無効の見た目で、ほかのボタンは原文の事実のまま (screen/task-not-taskable の「買い物リスト」)', () => {
        const titled = '---\ntitle: 買い物リスト\n---\n\n- 牛乳\n- 卵\n';
        const facts = core.inspectNode(titled, { id: 1, refText: '買い物リスト' });
        const bar = new ContextBar(() => {});
        bar.show({ for: 'node', root: true, facts, task: { name: 'add', enabled: false } });
        expect(layoutOf(bar)).toEqual(['rename', 'child', 'details', 'tag-add', 'tag-select', 'task']);
        const buttons = fake(bar.element).children;
        const off = buttons.filter((button) => button.disabled || button.getAttribute('aria-disabled') === 'true').map((button) => button.dataset.command);
        expect(off).toEqual(['details', 'tag-add', 'tag-select', 'task']);
    });
});

// ---- ヒント ----

describe('図の下の案内 (Hint): spec.md「案 2」の「X タスク化 / 解除」', () => {
    it('ノード 1 つと 2 つ以上の行に「X タスク化 / 解除」が入り、X はキーの見た目。「Space タスクを進める」は残す', () => {
        for (const selection of ['node', 'nodes'] as const) {
            const hint = new Hint('mac');
            hint.show('select', selection);
            const text = fake(hint.element).textContent;
            expect(text, selection).toContain('X タスク化 / 解除');
            expect(text, selection).toContain('Space タスクを進める');
            const keys = fake(hint.element).children.filter((child) => child.tagName === 'kbd').map((child) => child.textContent);
            expect(keys, selection).toContain('X');
        }
    });

    it('win の区分でも同じ', () => {
        const hint = new Hint('win');
        hint.show('select', 'node');
        expect(fake(hint.element).textContent).toContain('X タスク化 / 解除');
    });

    it('何も選んでいない、線、グループのとき、手のひら、合流先を選ぶ途中、入力が開いているときは出さない', () => {
        const cases: Array<[Parameters<Hint['show']>[0], Parameters<Hint['show']>[1], Parameters<Hint['show']>[2]]> = [
            ['select', 'none', null],
            ['select', 'edge', null],
            ['select', 'group', null],
            ['select', 'groups', null],
            ['hand', 'node', null],
            ['join-target', 'nodes', null],
            ['select', 'node', 'node'],
            ['select', 'node', 'details'],
            ['select', 'node', 'tag-add'],
            ['select', 'nodes', 'tag-select'],
        ];
        for (const [tool, selection, input] of cases) {
            const hint = new Hint('mac');
            hint.show(tool, selection, input);
            expect(fake(hint.element).textContent, `${tool} ${selection} ${input}`).not.toContain('タスク化');
        }
    });
});

// ---- 命令の部品 ----

type Notice = { text: string; kind: NoticeKind };

// 命令の部品の持ち主の作り物。原文は本物の EditorSource が持ち、図の作り物は原文を差し替えるだけ。図の側は今の原文を解析した文書を返す
function harness(markdown: string, selected: readonly NodeTarget[]) {
    let selection: EditorSelection = nodesSelection(selected);
    const notices: Notice[] = [];
    const ensureVisible = vi.fn();
    const diagram = {
        source: markdown,
        diagnostics: [] as Diagnostic[],
        update(next: string): Diagnostic[] {
            this.source = next;
            return [];
        },
    };
    const source = new EditorSource(markdown, {
        selection: () => selection,
        onRedrawn: () => {},
        onNotice: (text, kind) => notices.push({ text, kind }),
    });
    source.attach(diagram as unknown as MarkdagDiagram);
    let drawn: { source: string; document: ViewDocument } | null = null;
    const getDocument = (): ViewDocument => {
        if (drawn === null || drawn.source !== diagram.source) {
            const parsed = core.parseDocument(diagram.source);
            drawn = { source: diagram.source, document: { parsed, model: core.buildModel(parsed.nodes, parsed.frontmatter, diagram.source) } };
        }
        return drawn.document;
    };
    const host = {
        view: { getDocument, ensureVisible },
        source,
        keyPlatform: 'mac',
        editing: () => true,
        selection: () => selection,
        select: (next: EditorSelection) => {
            selection = next;
        },
        pressedFrame: () => null,
        notice: (text: string, kind: NoticeKind) => notices.push({ text, kind }),
        focusContainer: () => {},
        onInputChange: () => {},
        onInputCancel: () => {},
        popoverPinned: () => false,
        attachToLegend: () => null,
        area: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) }),
    };
    const commands = new EditCommands(host as unknown as ConstructorParameters<typeof EditCommands>[0]);
    return {
        commands,
        source,
        notices,
        ensureVisible,
        text: (): string => diagram.source,
        selected: (): NodeTarget[] => [...selectedNodes(selection)],
        lastNotice: (): Notice | undefined => notices[notices.length - 1],
    };
}

function nodeOf(source: string, refText: string): NodeTarget {
    const found = core.parseDocument(source).nodes.filter((node) => node.refText === refText);
    if (found.length !== 1) throw new Error(`「${refText}」のノードが 1 つ: ${found.length}`);
    return { id: found[0]!.id, refText };
}

function nodeById(source: string, id: number): NodeTarget {
    const node = core.parseDocument(source).nodes.find((item) => item.id === id);
    if (node === undefined) throw new Error(`id ${id} のノードがない`);
    return { id, refText: node.refText };
}

const info = (text: string): Notice => ({ text, kind: 'info' });
const error = (text: string): Notice => ({ text, kind: 'error' });

describe('命令の部品のタスク化 / 解除 (帯と X): spec.md「書き換えのあと」', () => {
    const MIXED = example('screen/task-bar-mixed/input.md');

    it('1 つでもタスクでないものがあればそれだけをタスク化し、スナックバーは書き換えた数で決める。続けて当てると全部外す (screen/task-bar-mixed)', () => {
        const picked = ['見積もりを取る', '荷造りの箱を買う', '新居を決める'].map((name) => nodeOf(MIXED, name));
        const h = harness(MIXED, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(example('screen/task-bar-mixed/after-add.md'));
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました'));
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(example('screen/task-bar-mixed/after-remove.md'));
        expect(h.lastNotice()).toEqual(info('3 個のノードのタスクを解除しました'));
    });

    it('1 回の操作で原文の書き換えも履歴も 1 つ: 2 つ以上を書いても、元に戻すの 1 回で全部が戻る (変異 M15)', () => {
        const picked = ['見積もりを取る', '荷造りの箱を買う', '新居を決める'].map((name) => nodeOf(MIXED, name));
        const h = harness(MIXED, picked);
        h.commands.toggleTaskMark(picked);
        h.commands.toggleTaskMark(picked);
        expect(h.source.undo()).toBe(true);
        expect(h.text()).toBe(example('screen/task-bar-mixed/after-add.md'));
        expect(h.source.undo()).toBe(true);
        expect(h.text()).toBe(MIXED);
        expect(h.source.canUndo).toBe(false);
    });

    it('選んでいたものは選んだまま、図は動かさない (ノード 1 つでも)', () => {
        const one = nodeOf(MIXED, '見積もりを取る');
        const h = harness(MIXED, [one]);
        h.commands.toggleTaskMark([one]);
        expect(h.selected()).toEqual([one]);
        const picked = ['見積もりを取る', '不用品を処分する'].map((name) => nodeOf(MIXED, name));
        const many = harness(MIXED, picked);
        many.commands.toggleTaskMark(picked);
        expect(many.selected()).toEqual(picked);
        expect(h.ensureVisible).not.toHaveBeenCalled();
        expect(many.ensureVisible).not.toHaveBeenCalled();
    });

    it('スナックバーの文: 1 つは名前、2 つ以上は数。タスク化と解除で文を替える (spec.md の文と screen/task-key-x)', () => {
        const source = '# 引っ越し\n\n## 準備\n- 見積もりを取る\n- 荷造りの箱を買う\n- 不用品を処分する\n- [x] 新居を決める\n';
        const three = ['見積もりを取る', '荷造りの箱を買う', '不用品を処分する'].map((name) => nodeOf(source, name));
        const h = harness(source, three);
        h.commands.toggleTaskMark(three);
        expect(h.lastNotice()).toEqual(info('3 個のノードをタスク化しました'));
        h.commands.toggleTaskMark(three);
        expect(h.lastNotice()).toEqual(info('3 個のノードのタスクを解除しました'));
        const house = nodeOf(source, '新居を決める');
        h.commands.toggleTaskMark([house]);
        expect(h.lastNotice()).toEqual(info('「新居を決める」のタスクを解除しました'));
        const root = nodeOf(source, '引っ越し');
        h.commands.toggleTaskMark([root]);
        expect(h.lastNotice()).toEqual(info('「引っ越し」をタスク化しました'));
        expect(h.text().startsWith('# [ ] 引っ越し\n')).toBe(true);
    });

    it('タスクにできないノードはスキップし、括弧書きで数を足す (screen/task-not-taskable、task-empty-name)', () => {
        const notTaskable = example('screen/task-not-taskable/input.md');
        const picked = [nodeOf(notTaskable, '見積もりを取る'), nodeById(notTaskable, 5)];
        const h = harness(notTaskable, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(example('screen/task-not-taskable/after-add.md'));
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました (タスクにできない 1 個はスキップしました)'));
        expect(h.selected()).toEqual(picked);

        const emptyName = example('screen/task-empty-name/input.md');
        const both = [nodeById(emptyName, 3), nodeOf(emptyName, '名前のある項目')];
        const e = harness(emptyName, both);
        e.commands.toggleTaskMark(both);
        expect(e.text()).toBe(example('screen/task-empty-name/after-named.md'));
        expect(e.lastNotice()).toEqual(info('「名前のある項目」をタスク化しました (タスクにできない 1 個はスキップしました)'));
    });

    it('タスクにできるノードを 1 つも選んでいなければ、原文を変えずに「このノードはタスクにできません」(表、表とコード、自分の行を持たないルート)', () => {
        const notTaskable = example('screen/task-not-taskable/input.md');
        for (const picked of [[nodeById(notTaskable, 5)], [nodeById(notTaskable, 5), nodeById(notTaskable, 7)]]) {
            const h = harness(notTaskable, picked);
            h.commands.toggleTaskMark(picked);
            expect(h.text()).toBe(notTaskable);
            expect(h.lastNotice()).toEqual(error('このノードはタスクにできません'));
            expect(h.source.canUndo).toBe(false);
        }
        const titled = example('screen/task-not-taskable/title-root.md');
        const root = nodeOf(titled, '買い物リスト');
        const t = harness(titled, [root]);
        t.commands.toggleTaskMark([root]);
        expect(t.text()).toBe(titled);
        expect(t.lastNotice()).toEqual(error('このノードはタスクにできません'));
    });

    it('名前が空の項目だけなら、原文を変えずに名前を付けるよう知らせる (screen/task-empty-name)', () => {
        const emptyName = example('screen/task-empty-name/input.md');
        const empty = nodeById(emptyName, 3);
        const h = harness(emptyName, [empty]);
        h.commands.toggleTaskMark([empty]);
        expect(h.text()).toBe(emptyName);
        expect(h.lastNotice()).toEqual(error('名前が空の項目はタスクにできません。先に名前を付けてください'));
    });

    it('名前が空のタスクの項目の解除は「[ ]」の名前で知らせ、もう一度でタスク化 (screen/task-unmark-empty-name)', () => {
        const source = '# 買い物\n\n## 準備\n- [ ] \n- 名前のある項目\n';
        const empty = nodeById(source, 3);
        expect(empty.refText).toBe('[ ]');
        const h = harness(source, [empty]);
        h.commands.toggleTaskMark([empty]);
        expect(h.text()).toBe('# 買い物\n\n## 準備\n- \\[ ]\n- 名前のある項目\n');
        expect(h.lastNotice()).toEqual(info('「[ ]」のタスクを解除しました'));
        expect(h.selected()).toEqual([empty]);
        h.commands.toggleTaskMark([empty]);
        expect(h.text()).toBe('# 買い物\n\n## 準備\n- [ ] \\[ ]\n- 名前のある項目\n');
        expect(h.lastNotice()).toEqual(info('「[ ]」をタスク化しました'));
    });

    it('文書の先頭の BOM を外して 1 行目を書いても、スナックバーは BOM のない文書と同じ文 (screen/task-bom-first-line)', () => {
        const bom = example('screen/task-bom-first-line/input.md');
        const first = nodeOf(bom, '一行目の項目');
        const h = harness(bom, [first]);
        h.commands.toggleTaskMark([first]);
        expect(h.text()).toBe(example('screen/task-bom-first-line/after-first.md'));
        expect(h.lastNotice()).toEqual(info('「一行目の項目」をタスク化しました'));
        h.commands.toggleTaskMark([first]);
        expect(h.text()).toBe(example('screen/task-bom-first-line/after-first-unmark.md'));
        expect(h.lastNotice()).toEqual(info('「一行目の項目」のタスクを解除しました'));
        expect(h.notices.every((notice) => !notice.text.includes('BOM'))).toBe(true);
    });

    it('U2: 上流の完了を求める規則 (requireUpstreamDone) は当てない', () => {
        const source = '---\nmarkdag:\n    rules:\n        taskToggle:\n            requireUpstreamDone: true\n    relations:\n        depends:\n            - 設計 --> 実装\n---\n\n# R\n\n## 作業\n- [ ] 設計\n- 実装\n';
        const build = nodeOf(source, '実装');
        const h = harness(source, [build]);
        h.commands.toggleTaskMark([build]);
        expect(h.text()).toContain('- [ ] 実装\n');
        expect(h.lastNotice()).toEqual(info('「実装」をタスク化しました'));
    });
});

describe('命令の部品の読み取りだけのグループ (U2): spec.md「2 つ以上を選んだとき」', () => {
    const SKIP = example('screen/task-readonly-skip/input.md');
    const REFUSED = example('screen/task-readonly-refused/input.md');

    it('読み取りだけのグループのノードは操作に渡さずにスキップし、ふつうのノードだけを書く。括弧書きは表示の名前 (変異 M07)', () => {
        const picked = [nodeOf(SKIP, '見積もりを取る'), nodeOf(SKIP, '日取りを決める')];
        const h = harness(SKIP, picked);
        h.commands.toggleTaskMark(picked);
        // 読み取りだけの「日取りを決める」(タスクでない) には書かない
        expect(h.text()).toBe(example('screen/task-readonly-skip/after-add.md'));
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました (読み取り専用のグループ「確定済み」のノード 1 個はスキップしました)'));
        expect(h.selected()).toEqual(picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(SKIP);
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」のタスクを解除しました (読み取り専用のグループ「確定済み」のノード 1 個はスキップしました)'));
    });

    it('タスク化か解除かはスキップしたノードを除いた残りで決める (読み取りだけのタスクでないノードがあっても解除)', () => {
        const picked = [nodeOf(SKIP, '荷造りの箱を買う'), nodeOf(SKIP, '日取りを決める')];
        const h = harness(SKIP, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(example('screen/task-readonly-skip/after-remove.md'));
        expect(h.lastNotice()).toEqual(info('「荷造りの箱を買う」のタスクを解除しました (読み取り専用のグループ「確定済み」のノード 1 個はスキップしました)'));
    });

    it('タスクにできないノードと一緒の括弧書きと、グループが 2 つの括弧書き', () => {
        const withTable = [nodeOf(SKIP, '見積もりを取る'), nodeOf(SKIP, '業者を決める'), nodeById(SKIP, 11)];
        const h = harness(SKIP, withTable);
        h.commands.toggleTaskMark(withTable);
        expect(h.text()).toBe(example('screen/task-readonly-skip/after-add.md'));
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました (タスクにできない 1 個と、読み取り専用のグループ「確定済み」のノード 1 個はスキップしました)'));

        const twoGroups = ['見積もりを取る', '業者を決める', '日取りを決める', '会場を決める'].map((name) => nodeOf(SKIP, name));
        const g = harness(SKIP, twoGroups);
        g.commands.toggleTaskMark(twoGroups);
        expect(g.text()).toBe(example('screen/task-readonly-skip/after-add.md'));
        expect(g.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました (読み取り専用のグループ「確定済み」「固定」のノード 3 個はスキップしました)'));
    });

    it('全部が読み取りだけのグループのノードなら、原文を変えずに、しようとした操作に合う理由を出す (screen/task-readonly-refused)', () => {
        const cases: Array<[string[], string]> = [
            [['業者を決める'], '「確定済み」のグループは読み取り専用のため、タスク解除できません'],
            [['日取りを決める'], '「確定済み」のグループは読み取り専用のため、タスク化できません'],
            [['業者を決める', '日取りを決める'], '「確定済み」のグループは読み取り専用のため、タスク化できません'],
        ];
        for (const [names, text] of cases) {
            const picked = names.map((name) => nodeOf(REFUSED, name));
            const h = harness(REFUSED, picked);
            h.commands.toggleTaskMark(picked);
            expect(h.text(), names.join()).toBe(REFUSED);
            expect(h.lastNotice(), names.join()).toEqual(error(text));
            expect(h.source.canUndo).toBe(false);
        }
    });

    it('タスクにできないノードと一緒でも、読み取りだけのグループの理由を先に出す', () => {
        const picked = [nodeOf(REFUSED, '業者を決める'), nodeById(REFUSED, 6)];
        const h = harness(REFUSED, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(REFUSED);
        expect(h.notices).toEqual([error('「確定済み」のグループは読み取り専用のため、タスク解除できません')]);
    });

    it('グループに表示の名前 (label) がなければ id で出す', () => {
        const source = '---\nmarkdag:\n    groups:\n        lock:\n            color: "#D64545"\n    rules:\n        taskToggle:\n            readonlyGroups: [lock]\n---\n\n# R\n\n## 決まったこと %lock\n- 日取りを決める\n';
        const picked = [nodeOf(source, '日取りを決める')];
        const h = harness(source, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe(source);
        expect(h.lastNotice()).toEqual(error('「lock」のグループは読み取り専用のため、タスク化できません'));
    });
});

describe('命令の部品の、1 行目が文章でない項目と外すと HTML のブロックとして読まれるタスク (レビューの B-01、A-02、B-02、B-03、A-01)', () => {
    const NOT_TEXT = '1 行目が文章でない項目はタスクにできません';
    const HTML_AFTER_UNMARK = 'タスクの記号を外すと HTML として読まれるため、タスク解除できません';

    it('1 行目が文章でない項目だけなら、原文を変えずに理由を出す。番号付きの項目のコードの中に記号を書かない (B-01)。1 行目が空で 2 行目に名前のある項目に名前が空とは言わない (B-03)', () => {
        const sources = ['# R\n\n1.     a\n2. b\n', '# R\n\n-     a\n- b\n', '# R\n\n-\t\ta\n- b\n', '# R\n\n- # a\n- b\n', '# R\n\n- > a\n- b\n', '# R\n\n1. - a\n2. b\n', '# R\n\n-\n  a\n- b\n'];
        for (const source of sources) {
            const node = nodeById(source, 2);
            const h = harness(source, [node]);
            h.commands.toggleTaskMark([node]);
            expect(h.text(), JSON.stringify(source)).toBe(source);
            expect(h.notices, JSON.stringify(source)).toEqual([error(NOT_TEXT)]);
            expect(h.source.canUndo, JSON.stringify(source)).toBe(false);
        }
    });

    it('2 つ以上なら、1 行目が文章でない項目だけをスキップし、括弧書きに数える (全体を断らない)', () => {
        const source = '# R\n\n1. a\n2.     b\n3. # c\n4. d\n';
        const picked = [2, 3, 4, 5].map((id) => nodeById(source, id));
        const h = harness(source, picked);
        h.commands.toggleTaskMark(picked);
        expect(h.text()).toBe('# R\n\n1. [ ] a\n2.     b\n3. # c\n4. [ ] d\n');
        expect(h.lastNotice()).toEqual(info('2 個のノードをタスク化しました (タスクにできない 2 個はスキップしました)'));
        expect(h.selected()).toEqual(picked);
    });

    it('外すと HTML のブロックとして読まれて見出しでなくなるタスク (下線の見出し) だけなら、原文を変えずに理由を出す。`\\` で HTML を文字に変えない (A-01)', () => {
        for (const source of ['# R\n\n[x] <div>a</div>\n---\n', '# R\n\n[ ] <div> a\n---\n', '---\nmarkdag:\n---\n# R\n\n[x] <div>a</div>\n---\n']) {
            const node = nodeById(source, 2);
            const h = harness(source, [node]);
            h.commands.toggleTaskMark([node]);
            expect(h.text(), JSON.stringify(source)).toBe(source);
            expect(h.notices, JSON.stringify(source)).toEqual([error(HTML_AFTER_UNMARK)]);
        }
    });

    it('外せないタスクとほかのタスクなら外せるものだけを外してスキップに数え、タスクでないノードがあればタスク化で外せないタスクは状態のまま', () => {
        const source = '# R\n\n[ ] <div>a</div>\n---\n\n- [x] b\n- c\n';
        const unmark = [nodeById(source, 2), nodeById(source, 3)];
        const h = harness(source, unmark);
        h.commands.toggleTaskMark(unmark);
        expect(h.text()).toBe('# R\n\n[ ] <div>a</div>\n---\n\n- b\n- c\n');
        expect(h.lastNotice()).toEqual(info('「b」のタスクを解除しました (タスクにできない 1 個はスキップしました)'));

        const mark = [nodeById(source, 2), nodeById(source, 4)];
        const m = harness(source, mark);
        m.commands.toggleTaskMark(mark);
        expect(m.text()).toBe('# R\n\n[ ] <div>a</div>\n---\n\n- [x] b\n- [ ] c\n');
        expect(m.lastNotice()).toEqual(info('「c」をタスク化しました'));
    });

    it('ATX の見出しの HTML で始まる名前のタスクは、`\\` を足さずに外す', () => {
        const source = '# R\n\n## [x] <div>a</div>\n';
        const node = nodeById(source, 2);
        const h = harness(source, [node]);
        h.commands.toggleTaskMark([node]);
        expect(h.text()).toBe('# R\n\n## <div>a</div>\n');
        expect(h.lastNotice()).toEqual(info('「a」のタスクを解除しました'));
    });

    it('ノードの左のチェック (markTask) は、1 行目が文章でない項目には何もしない', () => {
        for (const source of ['# R\n\n1.     a\n2. b\n', '# R\n\n-\n  a\n- b\n']) {
            const node = nodeById(source, 2);
            const h = harness(source, [node]);
            h.commands.markTask(node);
            expect(h.text(), JSON.stringify(source)).toBe(source);
            expect(h.notices, JSON.stringify(source)).toEqual([]);
        }
    });
});

describe('ノードの左のチェック (markTask): spec.md「案 3」(タスク化だけ)', () => {
    const CHECK = example('screen/task-check/input.md');

    it('押したノード 1 つだけをタスク化し、選んでいるものは変えない。図は動かさない (screen/task-check)', () => {
        const other = nodeOf(CHECK, '不用品を処分する');
        const pressed = nodeOf(CHECK, '見積もりを取る');
        const h = harness(CHECK, [other]);
        h.commands.markTask(pressed);
        expect(h.text()).toBe(CHECK.replace('\n- 見積もりを取る\n', '\n- [ ] 見積もりを取る\n'));
        expect(h.lastNotice()).toEqual(info('「見積もりを取る」をタスク化しました'));
        expect(h.selected()).toEqual([other]);
        expect(h.ensureVisible).not.toHaveBeenCalled();
        expect(h.source.undo()).toBe(true);
        expect(h.text()).toBe(CHECK);
    });

    it('タスクのノードには何もしない (チェックは解除をしない。変異 M16)', () => {
        for (const name of ['荷造りの箱を買う', '新居を決める']) {
            const task = nodeOf(CHECK, name);
            const h = harness(CHECK, [task]);
            h.commands.markTask(task);
            expect(h.text(), name).toBe(CHECK);
            expect(h.notices, name).toEqual([]);
            expect(h.source.canUndo, name).toBe(false);
        }
    });

    it('U2: 読み取りだけのグループのノードには何もしない', () => {
        const locked = nodeOf(CHECK, '日取りを決める');
        const h = harness(CHECK, [locked]);
        h.commands.markTask(locked);
        expect(h.text()).toBe(CHECK);
        expect(h.source.canUndo).toBe(false);
    });

    it('先頭に BOM のある文書の 1 行目も、BOM を外してタスク化する (screen/task-bom-first-line のチェックの段)', () => {
        const bom = example('screen/task-bom-first-line/input.md');
        const first = nodeOf(bom, '一行目の項目');
        const h = harness(bom, [first]);
        h.commands.markTask(first);
        expect(h.text()).toBe(example('screen/task-bom-first-line/after-first.md'));
        expect(h.lastNotice()).toEqual(info('「一行目の項目」をタスク化しました'));
    });
});

describe('命令の部品の、markdag キーのある文書の 1 行目が文章でない項目と、HTML で始まる名前の項目', () => {
    const NOT_TEXT = '1 行目が文章でない項目はタスクにできません';
    const KEYED = '---\nmarkdag:\n---\n';

    it('キーのある文書でも、1 行目が文章でない項目だけなら、原文を変えずに理由を出す (記号を番号付きのリストや見出しの前、コードの中に書かない)', () => {
        for (const item of ['- 1. a', '-     a', '- # a', '- > a', '1.     a']) {
            const source = `${KEYED}# R\n\n${item}\n- b\n`;
            const node = nodeById(source, 2);
            const h = harness(source, [node]);
            h.commands.toggleTaskMark([node]);
            expect(h.text(), JSON.stringify(source)).toBe(source);
            expect(h.notices, JSON.stringify(source)).toEqual([error(NOT_TEXT)]);
            expect(h.source.canUndo, JSON.stringify(source)).toBe(false);
        }
    });

    it('キーのある文書のノードの左のチェック (markTask) も、1 行目が文章でない項目には何もしない', () => {
        const source = `${KEYED}# R\n\n- # a\n- b\n`;
        const node = nodeById(source, 2);
        const h = harness(source, [node]);
        h.commands.markTask(node);
        expect(h.text()).toBe(source);
        expect(h.notices).toEqual([]);
    });

    it('名前が HTML のブロックで始まる項目は、キーの有無によらず `\\` を足さずにタスク化とタスク解除を行き来する', () => {
        for (const [head, name] of [
            ['', 'a'],
            [KEYED, '<div>a</div>'],
        ] as const) {
            const source = `${head}# R\n\n- <div>a</div>\n- b\n`;
            const node = nodeById(source, 2);
            const h = harness(source, [node]);
            h.commands.toggleTaskMark([node]);
            expect(h.text(), head).toBe(`${head}# R\n\n- [ ] <div>a</div>\n- b\n`);
            expect(h.lastNotice(), head).toEqual(info(`「${name}」をタスク化しました`));
            h.commands.toggleTaskMark([node]);
            expect(h.text(), head).toBe(source);
            expect(h.lastNotice(), head).toEqual(info(`「${name}」のタスクを解除しました`));
        }
    });
});

describe('frontmatter を作る操作で文書の先頭の BOM を外したときのスナックバー', () => {
    // 詳細を書く、タグを付ける、線を引くなどで frontmatter を新しく作るとき、書き換えの層は BOM を外して知らせ (bom-removed) を返す。
    // GUI 編集のスナックバーには出さない (使う人が意識するものではないので、BOM のない文書と同じ文にする)
    const BOM = '\u{feff}';
    const SOURCE = `${BOM}# R\n\n- a\n- b\n`;
    const A = { id: 2, refText: 'a' };
    const B = { id: 3, refText: 'b' };

    it('操作ごとの文に BOM のことを出さず、BOM のない文書と同じ文。書き換えの結果の notes には bom-removed が残る', () => {
        const ops: EditOp[] = [
            { kind: 'setDetails', node: A, text: 'メモ' },
            { kind: 'setTag', nodes: [A], key: 'k', value: 'v', replaceKey: null },
            { kind: 'addRelation', from: A, to: B },
            { kind: 'groupNodes', nodes: [A, B] },
        ];
        for (const op of ops) {
            const edited = core.editSource(SOURCE, op);
            const plain = core.editSource(SOURCE.slice(BOM.length), op);
            if (edited.status !== 'edited' || plain.status !== 'edited') throw new Error(`${op.kind} は書き換えるはず`);
            expect(edited.notes.map((note) => note.code), op.kind).toContain('bom-removed');
            const text = editedNotice(op, edited, [], { groupLabel: 'グループ 1' });
            expect(text, op.kind).not.toContain('BOM');
            expect(text, op.kind).toBe(editedNotice(op, plain, [], { groupLabel: 'グループ 1' }));
        }
    });

    it('線を引く命令で frontmatter を作ったときのスナックバーにも出さない', () => {
        const h = harness(SOURCE, [A]);
        h.commands.addRelation(A, B);
        expect(h.text().startsWith(BOM)).toBe(false);
        expect(h.notices.length).toBeGreaterThan(0);
        expect(h.notices.every((notice) => !notice.text.includes('BOM')), JSON.stringify(h.notices)).toBe(true);
    });
});

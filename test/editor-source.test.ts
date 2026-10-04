// 原文の窓口と履歴 (DOM を使わない部品) を、図の代わりの偽物で確かめる。
// アプリの差し替え (setSource) は履歴に 1 つ積み、アプリの onChange を呼ばない。編集の層の操作の書き換え、元に戻す / やり直す、
// 図の側の変更 (タスクの印、フックの api.update) は onChange を呼ぶ。beforeUpdate が取りやめたら原文も履歴も変えず、操作のときは通知する。
// 断られた操作と失敗した操作は理由を error の通知に出し、原文を変えない。履歴は原文と選択の組で、上限は 200。
// 片付けたあとは最後の原文を返し、ほかは何もしない
import { describe, expect, it } from 'vitest';
import type { Diagnostic, EditOutcome, MarkdagDiagram } from '../src/core';
import type { EditorSelection } from '../src/editor/selection';
import { EditorSource, type EditAttempt, type Redraw } from '../src/editor/source';

// 図の代わり。cancel が true を返す原文は beforeUpdate が取りやめたものとして原文を変えない
function fakeDiagram(initial: string, cancel: (next: string) => boolean = () => false): { diagram: MarkdagDiagram; updates: string[]; set: (text: string) => void } {
    let source = initial;
    const updates: string[] = [];
    const diagram = {
        get source(): string {
            return source;
        },
        get diagnostics(): Diagnostic[] {
            return [];
        },
        update(markdown: string): Diagnostic[] {
            updates.push(markdown);
            if (!cancel(markdown)) source = markdown;
            return [];
        },
    } as unknown as MarkdagDiagram;
    return { diagram, updates, set: (text) => (source = text) };
}

interface Recorded {
    redraws: Redraw[];
    notices: Array<[string, string]>;
    changes: string[];
    historyChanges: number;
}

function sourceOf(initial: string, options: { cancel?: (next: string) => boolean; selection?: () => EditorSelection } = {}) {
    const recorded: Recorded = { redraws: [], notices: [], changes: [], historyChanges: 0 };
    let selection: EditorSelection = { kind: 'none' };
    const subject = new EditorSource(initial, {
        selection: options.selection ?? (() => selection),
        onRedrawn: (redraw) => recorded.redraws.push(redraw),
        onNotice: (message, kind) => recorded.notices.push([message, kind]),
        onChange: (markdown) => recorded.changes.push(markdown),
        onHistoryChange: () => {
            recorded.historyChanges += 1;
        },
    });
    const fake = fakeDiagram(initial, options.cancel);
    subject.attach(fake.diagram);
    return { subject, recorded, fake, select: (next: EditorSelection) => (selection = next) };
}

const edited = (source: string): EditOutcome => ({ status: 'edited', source, select: { kind: 'none' }, rename: null, notes: [] });
const refused = (message: string): EditOutcome => ({ status: 'refused', reason: { code: 'root', message, path: null } });
const nodeSelection = (id: number, refText: string): EditorSelection => ({ kind: 'nodes', nodes: [{ id, refText }] });

describe('アプリの差し替え (setSource。B-005)', () => {
    it('描き直し、履歴に 1 つ積む。アプリの onChange は呼ばない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        subject.replace('# B\n');
        expect(fake.updates).toEqual(['# B\n']);
        expect(subject.source).toBe('# B\n');
        expect(subject.canUndo).toBe(true);
        expect(recorded.redraws).toEqual([{ cause: 'replace' }]);
        expect(recorded.changes).toEqual([]);
    });

    it('beforeUpdate が取りやめたら、原文も履歴も変えず、描き直したことも知らせない', () => {
        const { subject, recorded } = sourceOf('# A\n', { cancel: () => true });
        subject.replace('# B\n');
        expect(subject.source).toBe('# A\n');
        expect(subject.canUndo).toBe(false);
        expect(recorded.redraws).toEqual([]);
        expect(recorded.changes).toEqual([]);
    });

    it('差し替えも元に戻すで戻る (B-008)', () => {
        const { subject, recorded } = sourceOf('# A\n');
        subject.replace('# B\n');
        expect(subject.undo()).toBe(true);
        expect(subject.source).toBe('# A\n');
        expect(recorded.changes).toEqual(['# A\n']);
    });
});

describe('編集の層の操作の書き換え (B-001〜B-003)', () => {
    it('書き換えたら描き直し、履歴に積んでから選び直しを呼び、アプリに新しい原文を知らせる', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        const settled: EditOutcome[] = [];
        const outcome = edited('# A\n- x\n');
        expect(subject.apply(outcome, (result) => settled.push(result))).toBe('edited');
        expect(fake.updates).toEqual(['# A\n- x\n']);
        expect(subject.source).toBe('# A\n- x\n');
        expect(subject.canUndo).toBe(true);
        expect(recorded.redraws).toEqual([{ cause: 'edit' }]);
        expect(settled).toEqual([outcome]);
        expect(recorded.changes).toEqual(['# A\n- x\n']);
        expect(recorded.notices).toEqual([]);
    });

    it('断られたら理由を error の通知に出し、原文も履歴も変えない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        const settled: EditOutcome[] = [];
        expect(subject.apply(refused('ルートは消せません'), (result) => settled.push(result))).toBe('refused');
        expect(recorded.notices).toEqual([['ルートは消せません', 'error']]);
        expect(fake.updates).toEqual([]);
        expect(subject.canUndo).toBe(false);
        expect(settled).toEqual([]);
        expect(recorded.changes).toEqual([]);
    });

    it('書き換えに失敗したとき (入力が読めない、wasm の誤り) も error の通知に出し、原文を変えない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        const failed: EditAttempt = { status: 'failed', message: '書き換えに失敗しました (x)' };
        expect(subject.apply(failed, () => undefined)).toBe('refused');
        expect(recorded.notices).toEqual([['書き換えに失敗しました (x)', 'error']]);
        expect(fake.updates).toEqual([]);
    });

    it('変えない結果 (unchanged) は描き直さず、履歴にも積まない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        const settled: EditOutcome[] = [];
        const unchanged: EditOutcome = { status: 'unchanged', reason: { code: 'same-name', message: '名前が今と同じです', path: null } };
        expect(subject.apply(unchanged, (result) => settled.push(result))).toBe('unchanged');
        expect(fake.updates).toEqual([]);
        expect(subject.canUndo).toBe(false);
        expect(settled).toEqual([]);
        expect(recorded.changes).toEqual([]);
        expect(recorded.notices.filter(([, kind]) => kind === 'error')).toEqual([]);
    });

    it('beforeUpdate が取りやめたら、原文も履歴も変えず、取りやめたことを error の通知に出す (B-001)', () => {
        const { subject, recorded } = sourceOf('# A\n', { cancel: () => true });
        const settled: EditOutcome[] = [];
        expect(subject.apply(edited('# A\n- x\n'), (result) => settled.push(result))).toBe('cancelled');
        expect(subject.source).toBe('# A\n');
        expect(subject.canUndo).toBe(false);
        expect(settled).toEqual([]);
        expect(recorded.changes).toEqual([]);
        expect(recorded.notices).toHaveLength(1);
        expect(recorded.notices[0]?.[1]).toBe('error');
    });
});

describe('元に戻す / やり直す (B-008、B-009。原文と選択の組。design 5.1)', () => {
    it('戻すと前の原文を描き直し、その原文を描いていたときの選択を返し、アプリに知らせる', () => {
        const { subject, recorded, select } = sourceOf('# A\n');
        select(nodeSelection(1, 'A'));
        subject.apply(edited('# A\n- x\n'), () => undefined);
        select(nodeSelection(2, 'x'));
        expect(subject.undo()).toBe(true);
        expect(subject.source).toBe('# A\n');
        expect(recorded.redraws.at(-1)).toEqual({ cause: 'history', restored: nodeSelection(1, 'A') });
        expect(recorded.changes.at(-1)).toBe('# A\n');
        expect(subject.canRedo).toBe(true);
        // やり直すと戻す前の原文と、戻す前の選択
        select({ kind: 'none' });
        expect(subject.redo()).toBe(true);
        expect(subject.source).toBe('# A\n- x\n');
        expect(recorded.redraws.at(-1)).toEqual({ cause: 'history', restored: nodeSelection(2, 'x') });
        expect(recorded.changes.at(-1)).toBe('# A\n- x\n');
    });

    it('戻すものもやり直すものもなければ false で、何もしない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        expect(subject.undo()).toBe(false);
        expect(subject.redo()).toBe(false);
        expect(fake.updates).toEqual([]);
        expect(recorded.redraws).toEqual([]);
        expect(recorded.changes).toEqual([]);
    });

    it('beforeUpdate が元に戻すを取りやめたら false で、原文も履歴も変えない', () => {
        let blocked = false;
        const { subject } = sourceOf('# A\n', { cancel: () => blocked });
        subject.apply(edited('# B\n'), () => undefined);
        blocked = true;
        expect(subject.undo()).toBe(false);
        expect(subject.source).toBe('# B\n');
        expect(subject.canUndo).toBe(true);
        expect(subject.canRedo).toBe(false);
        blocked = false;
        expect(subject.undo()).toBe(true);
        expect(subject.source).toBe('# A\n');
    });

    it('戻したあとに新しく書き換えると、やり直せるものはなくなる', () => {
        const { subject } = sourceOf('# A\n');
        subject.apply(edited('# B\n'), () => undefined);
        subject.undo();
        subject.apply(edited('# C\n'), () => undefined);
        expect(subject.canRedo).toBe(false);
        expect(subject.redo()).toBe(false);
        expect(subject.undo()).toBe(true);
        expect(subject.source).toBe('# A\n');
    });

    it('戻せるのは新しいほうから 200 回まで', () => {
        const { subject } = sourceOf('0');
        for (let index = 1; index <= 205; index += 1) subject.apply(edited(String(index)), () => undefined);
        let undone = 0;
        while (subject.undo()) undone += 1;
        expect(undone).toBe(200);
        expect(subject.source).toBe('5');
    });

    it('戻せるものとやり直せるものが変わったら知らせる', () => {
        const { subject, recorded } = sourceOf('# A\n');
        subject.apply(edited('# B\n'), () => undefined);
        const afterApply = recorded.historyChanges;
        expect(afterApply).toBeGreaterThan(0);
        subject.undo();
        expect(recorded.historyChanges).toBeGreaterThan(afterApply);
    });
});

describe('図の側の変更 (タスクの印、フックの api.update。B-010)', () => {
    it('図が原文を変えたら、変わる前の原文と選択を履歴に積み、描き直したことと新しい原文を知らせる', () => {
        const { subject, recorded, fake, select } = sourceOf('- [ ] a\n');
        select(nodeSelection(1, 'a'));
        fake.set('- [x] a\n');
        subject.changedByView('- [x] a\n');
        expect(recorded.redraws).toEqual([{ cause: 'view' }]);
        expect(recorded.changes).toEqual(['- [x] a\n']);
        expect(subject.canUndo).toBe(true);
        // その書き換えも元に戻すで戻る
        expect(subject.undo()).toBe(true);
        expect(subject.source).toBe('- [ ] a\n');
        expect(recorded.redraws.at(-1)).toEqual({ cause: 'history', restored: nodeSelection(1, 'a') });
    });
});

describe('片付けたあと (design 1.2 の破棄)', () => {
    it('最後の原文を返し、差し替え、操作、元に戻すは何もしない', () => {
        const { subject, recorded, fake } = sourceOf('# A\n');
        subject.apply(edited('# B\n'), () => undefined);
        subject.release();
        const updates = fake.updates.length;
        const changes = recorded.changes.length;
        expect(subject.source).toBe('# B\n');
        subject.replace('# C\n');
        expect(subject.apply(edited('# D\n'), () => undefined)).not.toBe('edited');
        expect(subject.undo()).toBe(false);
        expect(subject.redo()).toBe(false);
        expect(subject.canUndo).toBe(false);
        subject.changedByView('# E\n');
        expect(fake.updates).toHaveLength(updates);
        expect(recorded.changes).toHaveLength(changes);
        expect(subject.source).toBe('# B\n');
    });

    it('片付けたあとに図の原文が変わっても、片付けたときの原文を返す', () => {
        const { subject, fake } = sourceOf('# A\n');
        subject.release();
        fake.set('# Z\n');
        expect(subject.source).toBe('# A\n');
    });
});

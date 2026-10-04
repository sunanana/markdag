// 原文の持ち主の窓口。原文そのものは render が持ち (タスクの印とフックの api.update で書き換えて描き直す)、ここはその出入りと履歴を受け持つ。
// アプリからの差し替え (setSource) と編集の層の操作の書き換え (editSource の結果) は render の update に渡し、beforeUpdate が取りやめたか
// (原文が前のままか) を確かめる。操作の書き換えが断られたときと取りやめられたときは、原文を変えずにそのことを通知に出す。
// 図の側の操作で原文が変わったこと (render の onChange) を受け、描き直したことを編集の層に、新しい原文をアプリに知らせる。
// 原文が変わるたびに変わる前の原文とそのときの選択を組で履歴に積み、元に戻す / やり直すで履歴の原文を描き直して、組の選択を編集の層へ返す
// (これも図の側の変更としてアプリに知らせる)。
// 片付けたあとは最後の原文と診断を返すだけで、差し替えも知らせもしない
import type { Diagnostic, EditOutcome, MarkdagDiagram } from '../core';
import { EditHistory } from './history';
import type { EditorSelection } from './selection';
import type { NoticeKind } from './ui/snackbar';

// 描き直した理由。edit は編集の層の操作 (選び直しは操作の結果で行う)、view は図の側の操作 (タスクの印、フックの api.update)、
// replace はアプリの差し替え、history は元に戻す / やり直す (restored は履歴から戻した選択)
export type Redraw = { cause: 'edit' | 'view' | 'replace' } | { cause: 'history'; restored: EditorSelection };

interface SourceListeners {
    // 今の選択 (原文と組で履歴に積む)
    selection: () => EditorSelection;
    // 原文が変わって図を描き直した
    onRedrawn: (redraw: Redraw) => void;
    // 操作の書き換えが通らなかったことの通知
    onNotice: (message: string, kind: NoticeKind) => void;
    // 図の側の操作、編集の層の操作、元に戻す / やり直すで原文が変わった。setSource では呼ばない
    onChange?: (markdown: string) => void;
    // 戻せるものかやり直せるものが変わったかもしれない
    onHistoryChange?: () => void;
}

// 書き換えた結果 (editSource の edited)
export type EditedOutcome = Extract<EditOutcome, { status: 'edited' }>;

// 操作の書き換えの試み。failed は editSource が投げた (入力の形が読めない、wasm の誤り) ときで、message はその文
export type EditAttempt = EditOutcome | { status: 'failed'; message: string };

// 操作の書き換えを当てた結果。cancelled は beforeUpdate が取りやめたとき。refused は断られたか、書き換えに失敗したとき
export type ApplyStatus = 'edited' | 'unchanged' | 'refused' | 'cancelled';

const CANCELLED_NOTICE = 'フック (beforeUpdate) が書き換えを取りやめたので、原文は変わっていません';

// 履歴の 1 つ分。原文と、その原文を描いていたときの選択
interface HistoryEntry {
    source: string;
    selection: EditorSelection;
}

export class EditorSource {
    private diagram: MarkdagDiagram | null = null;
    private released = false;
    // 片付けたあとに返す、最後の原文と診断
    private kept: { source: string; diagnostics: Diagnostic[] };
    private readonly history = new EditHistory<HistoryEntry>();
    // 最後に描いた原文。図の側の操作の知らせが届いた時点では render の原文がもう新しいので、変わる前の原文をここで控える
    private drawn: string;

    constructor(
        markdown: string,
        private readonly listeners: SourceListeners,
    ) {
        this.kept = { source: markdown, diagnostics: [] };
        this.drawn = markdown;
    }

    // render の onChange に渡す受け口
    readonly changedByView = (markdown: string): void => {
        if (this.released) return;
        const before = this.drawn;
        this.drawn = markdown;
        // render を組み立てている途中 (図を受け取る前) の変更は、組み立てたあとに読む文書に入っている。元に戻す相手にもしない
        if (this.diagram !== null) {
            if (before !== markdown) this.history.push({ source: before, selection: this.listeners.selection() });
            this.listeners.onRedrawn({ cause: 'view' });
            this.listeners.onHistoryChange?.();
        }
        this.listeners.onChange?.(markdown);
    };

    attach(diagram: MarkdagDiagram): void {
        this.diagram = diagram;
        this.drawn = diagram.source;
    }

    get source(): string {
        return this.diagram !== null && !this.released ? this.diagram.source : this.kept.source;
    }

    get diagnostics(): Diagnostic[] {
        return this.diagram !== null && !this.released ? this.diagram.diagnostics : this.kept.diagnostics;
    }

    get canUndo(): boolean {
        return !this.released && this.history.canUndo;
    }

    get canRedo(): boolean {
        return !this.released && this.history.canRedo;
    }

    // アプリからの差し替え。今と同じ原文なら何もしない (描き直さず、履歴にも積まない)。
    // beforeUpdate が取りやめたら原文も図も履歴も前のままで、編集の層には知らせない
    replace(markdown: string): Diagnostic[] {
        const diagram = this.diagram;
        if (diagram === null || this.released) return this.kept.diagnostics;
        const before = diagram.source;
        if (markdown === before) return diagram.diagnostics;
        const diagnostics = diagram.update(markdown);
        if (diagram.source !== markdown) return diagnostics;
        this.drawn = markdown;
        this.history.push({ source: before, selection: this.listeners.selection() });
        this.listeners.onRedrawn({ cause: 'replace' });
        this.listeners.onHistoryChange?.();
        return diagnostics;
    }

    // 編集の層の操作の書き換え (今の原文に editSource を当てた結果) を受け取る。
    // edited は書き換えたあとの原文で描き直し、変わる前の原文と選択を履歴に積んでから、settle (選び直しと名前の入力) を呼び、アプリに知らせる。
    // 断られた (失敗を含む) ときは理由を、beforeUpdate が取りやめたときはそのことを通知し、原文も履歴も変えない。変えない (unchanged) ときは何もしない
    apply(attempt: EditAttempt, settle: (edited: EditedOutcome) => void): ApplyStatus {
        const diagram = this.diagram;
        if (diagram === null || this.released) return 'refused';
        if (attempt.status === 'failed') {
            this.listeners.onNotice(attempt.message, 'error');
            return 'refused';
        }
        if (attempt.status === 'refused') {
            this.listeners.onNotice(attempt.reason.message, 'error');
            return 'refused';
        }
        if (attempt.status === 'unchanged') return 'unchanged';
        const before = diagram.source;
        diagram.update(attempt.source);
        if (diagram.source !== attempt.source) {
            this.listeners.onNotice(CANCELLED_NOTICE, 'error');
            return 'cancelled';
        }
        this.drawn = attempt.source;
        this.history.push({ source: before, selection: this.listeners.selection() });
        this.listeners.onRedrawn({ cause: 'edit' });
        settle(attempt);
        // settle の中でアプリの受け口が片付けたら、そのあとは知らせない
        if (this.released) return 'edited';
        this.listeners.onHistoryChange?.();
        this.listeners.onChange?.(attempt.source);
        return 'edited';
    }

    // 戻したら true。戻すものがないか、beforeUpdate が取りやめたら false で、原文も履歴も変えない
    undo(): boolean {
        return this.travel('undo');
    }

    // やり直したら true。やり直すものがないか、beforeUpdate が取りやめたら false で、原文も履歴も変えない
    redo(): boolean {
        return this.travel('redo');
    }

    // 片付ける前に、最後の原文と診断を控えて受け付けを止める
    release(): void {
        if (this.released) return;
        this.kept = { source: this.source, diagnostics: this.diagnostics };
        this.released = true;
    }

    private travel(direction: 'undo' | 'redo'): boolean {
        const diagram = this.diagram;
        if (diagram === null || this.released) return false;
        const current: HistoryEntry = { source: diagram.source, selection: this.listeners.selection() };
        const target = direction === 'undo' ? this.history.undo(current) : this.history.redo(current);
        if (target === null) return false;
        diagram.update(target.source);
        if (diagram.source !== target.source) {
            // 取りやめられたので、動かした履歴を逆向きに 1 つ動かして元に戻す
            if (direction === 'undo') this.history.redo(target);
            else this.history.undo(target);
            return false;
        }
        this.drawn = target.source;
        this.listeners.onRedrawn({ cause: 'history', restored: target.selection });
        this.listeners.onHistoryChange?.();
        this.listeners.onChange?.(target.source);
        return true;
    }
}

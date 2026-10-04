// 編集の層の元に戻す / やり直すの履歴 (DOM を使わない部品) を確かめる。
// 履歴は原文と選択の組で、上限は 200。足したばかりのノードの名前の入力を Esc でやめて足す前に戻したことも、元に戻すと同じ扱い。
// 部品の形 (このテストが確かめる約束):
//     class EditHistory<T>
//         constructor()                  上限は 200
//         canUndo: boolean (読むだけ)     戻せるものがある (道具箱の「戻る」を押せる)
//         canRedo: boolean (読むだけ)     やり直せるものがある (道具箱の「進む」を押せる)
//         push(before: T): void          変える前の状態を積み、やり直せるものを捨てる。上限を超えたら古いものから捨てる
//         undo(current: T): T | null     戻す先の状態を返し、今の状態をやり直せるものに積む。戻すものがなければ null で何も変えない
//         redo(current: T): T | null     やり直す先の状態を返し、今の状態を戻せるものに積む。やり直すものがなければ null で何も変えない
//     T (原文と選択の組) は編集の層が決める。部品は中身を読まず、書き換えない
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MarkdagEditor } from '../src/editor';
import { EditHistory } from '../src/editor/history';

interface State {
    readonly source: string;
    readonly selection: readonly number[];
}

// 部品が状態を書き換えないよう、凍らせて渡す (書き換えると strict mode で投げる)
const state = (index: number): State => Object.freeze({ source: `# v${index}\n`, selection: Object.freeze([index]) });

const flags = (history: EditHistory<State>): { canUndo: boolean; canRedo: boolean } => ({ canUndo: history.canUndo, canRedo: history.canRedo });

describe('元に戻す / やり直すの履歴', () => {
    it('作ったばかりの履歴は戻すものもやり直すものもなく、undo と redo は null を返して何も変えない (B-081)', () => {
        const history = new EditHistory<State>();
        expect(flags(history)).toEqual({ canUndo: false, canRedo: false });
        expect(history.undo(state(0))).toBeNull();
        expect(history.redo(state(0))).toBeNull();
        expect(flags(history)).toEqual({ canUndo: false, canRedo: false });
    });

    it('積んだ状態を新しい順に戻し、戻すときに渡した今の状態を、戻した逆の順にやり直す (B-008、B-009)', () => {
        const history = new EditHistory<State>();
        // v0 → v1 → v2 → v3 と 3 回変えた
        for (const index of [0, 1, 2]) history.push(state(index));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });

        expect(history.undo(state(3))).toEqual(state(2));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: true });
        expect(history.undo(state(2))).toEqual(state(1));
        expect(history.undo(state(1))).toEqual(state(0));
        expect(flags(history)).toEqual({ canUndo: false, canRedo: true });
        expect(history.undo(state(0))).toBeNull();
        expect(flags(history)).toEqual({ canUndo: false, canRedo: true });

        expect(history.redo(state(0))).toEqual(state(1));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: true });
        expect(history.redo(state(1))).toEqual(state(2));
        expect(history.redo(state(2))).toEqual(state(3));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });
        expect(history.redo(state(3))).toBeNull();
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });

        // やり直したものは、もう 1 度戻せる
        expect(history.undo(state(3))).toEqual(state(2));
    });

    it('戻すのとやり直すのを繰り返すと、同じ 2 つの状態を行き来する', () => {
        const history = new EditHistory<State>();
        history.push(state(0));
        for (let round = 0; round < 3; round++) {
            expect(history.undo(state(1))).toEqual(state(0));
            expect(history.redo(state(0))).toEqual(state(1));
        }
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });
    });

    it('戻したあとに新しく積むと、やり直せるものはなくなり、戻す先は積んだ状態からたどる', () => {
        const history = new EditHistory<State>();
        history.push(state(0));
        history.push(state(1));
        expect(history.undo(state(2))).toEqual(state(1));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: true });

        // v1 に戻した所から v4 へ変えた
        history.push(state(1));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });
        expect(history.redo(state(4))).toBeNull();
        expect(history.undo(state(4))).toEqual(state(1));
        expect(history.undo(state(1))).toEqual(state(0));
        expect(history.undo(state(0))).toBeNull();
    });

    it('上限は 200: 250 回積むと、戻せるのは新しい 200 回分で、古い 50 回分は捨てる (10.2 の B-008)', () => {
        const history = new EditHistory<State>();
        // v0 → v1 → … → v250 と 250 回変えた
        for (let index = 0; index < 250; index++) history.push(state(index));
        const undone: string[] = [];
        let current = state(250);
        for (let step = 0; step < 300; step++) {
            const previous = history.undo(current);
            if (previous === null) break;
            undone.push(previous.source);
            current = previous;
        }
        expect(undone).toHaveLength(200);
        expect(undone[0]).toBe(state(249).source);
        expect(undone[199]).toBe(state(50).source);
        expect(flags(history)).toEqual({ canUndo: false, canRedo: true });
    });

    it('上限まで戻したあとも、やり直すと捨てていない 200 回分を全部たどり直せる', () => {
        const history = new EditHistory<State>();
        for (let index = 0; index < 250; index++) history.push(state(index));
        let current = state(250);
        for (let previous = history.undo(current); previous !== null; previous = history.undo(current)) current = previous;
        expect(current).toEqual(state(50));

        const redone: string[] = [];
        for (let next = history.redo(current); next !== null; next = history.redo(current)) {
            redone.push(next.source);
            current = next;
        }
        expect(redone).toEqual(Array.from({ length: 200 }, (_, offset) => state(51 + offset).source));
        expect(current).toEqual(state(250));
        expect(flags(history)).toEqual({ canUndo: true, canRedo: false });
    });

    it('上限ちょうど (200 回) なら 1 つも捨てない', () => {
        const history = new EditHistory<State>();
        for (let index = 0; index < 200; index++) history.push(state(index));
        let current = state(200);
        let count = 0;
        for (let previous = history.undo(current); previous !== null; previous = history.undo(current)) {
            current = previous;
            count += 1;
        }
        expect(count).toBe(200);
        expect(current).toEqual(state(0));
    });

    it('型: 状態の型を引き継ぎ、undo と redo は状態か null を返す', () => {
        expectTypeOf<EditHistory<State>['push']>().parameters.toEqualTypeOf<[State]>();
        expectTypeOf<EditHistory<State>['undo']>().toEqualTypeOf<(current: State) => State | null>();
        expectTypeOf<EditHistory<State>['redo']>().toEqualTypeOf<(current: State) => State | null>();
        expectTypeOf<EditHistory<State>['canUndo']>().toEqualTypeOf<boolean>();
        expectTypeOf<EditHistory<State>['canRedo']>().toEqualTypeOf<boolean>();
    });

    it('型: MarkdagEditor の undo と redo は引数を取らず、戻した / やり直したかを返す (1.2)', () => {
        expectTypeOf<MarkdagEditor['undo']>().toEqualTypeOf<() => boolean>();
        expectTypeOf<MarkdagEditor['redo']>().toEqualTypeOf<() => boolean>();
    });
});

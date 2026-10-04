// 元に戻す / やり直すの履歴 (DOM を使わない)。積む状態の中身 (原文と選択の組) は編集の層が決め、ここは読まず書き換えない。
// 変える前の状態を積み、戻すときは今の状態をやり直す側へ、やり直すときは戻す側へ移す。
// 新しく積むとやり直せるものを捨て、戻せるものが上限を超えたら古いものから捨てる
const LIMIT = 200;

export class EditHistory<T> {
    // 戻す先 (古い順) と、やり直す先 (戻した逆の順に取り出す)
    private past: T[] = [];
    private future: T[] = [];

    // 戻せるものがある (道具箱の「戻る」を押せる)
    get canUndo(): boolean {
        return this.past.length > 0;
    }

    // やり直せるものがある (道具箱の「進む」を押せる)
    get canRedo(): boolean {
        return this.future.length > 0;
    }

    push(before: T): void {
        this.past.push(before);
        if (this.past.length > LIMIT) this.past.splice(0, this.past.length - LIMIT);
        this.future = [];
    }

    // 戻すものがなければ null で何も変えない
    undo(current: T): T | null {
        if (this.past.length === 0) return null;
        const previous = this.past.pop() as T;
        this.future.push(current);
        return previous;
    }

    // やり直すものがなければ null で何も変えない
    redo(current: T): T | null {
        if (this.future.length === 0) return null;
        const next = this.future.pop() as T;
        this.past.push(current);
        return next;
    }
}

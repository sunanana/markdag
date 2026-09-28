// 文書 (Markdown の文字列) を一つだけ持ち、変わるたびに読み直して知らせる。取り消しとやり直し、ブラウザへの保存もここ
import { readWorkspace, type Workspace } from './doc';

const STORAGE_KEY = 'otamesi:source';
const HISTORY_LIMIT = 200;

export type ChangeOrigin = 'app' | 'graph' | 'editor' | 'history' | 'load';
type Listener = (workspace: Workspace, origin: ChangeOrigin) => void;

export class Store {
    workspace: Workspace;
    private past: string[] = [];
    private future: string[] = [];
    private listeners = new Set<Listener>();

    constructor(
        source: string,
        readonly sample: string,
    ) {
        this.workspace = readWorkspace(source);
    }

    static load(sample: string): Store {
        let saved: string | null = null;
        try {
            saved = localStorage.getItem(STORAGE_KEY);
        } catch {
            // 保存できない環境 (プライベートウィンドウなど) ではサンプルから始める
        }
        return new Store(saved ?? sample, sample);
    }

    get source(): string {
        return this.workspace.source;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // 文字列を差し替える。同じなら何もしない
    set(source: string, origin: ChangeOrigin = 'app'): void {
        if (source === this.source) return;
        if (origin !== 'history') {
            this.past.push(this.source);
            if (this.past.length > HISTORY_LIMIT) this.past.shift();
            this.future = [];
        }
        this.apply(source, origin);
    }

    // 書き換え関数を今の文字列に当てる。例外は呼び出し側 (画面) で知らせる
    edit(change: (source: string) => string): void {
        this.set(change(this.source));
    }

    undo(): boolean {
        const previous = this.past.pop();
        if (previous === undefined) return false;
        this.future.push(this.source);
        this.apply(previous, 'history');
        return true;
    }

    redo(): boolean {
        const next = this.future.pop();
        if (next === undefined) return false;
        this.past.push(this.source);
        this.apply(next, 'history');
        return true;
    }

    reset(): void {
        this.set(this.sample, 'load');
    }

    private apply(source: string, origin: ChangeOrigin): void {
        this.workspace = readWorkspace(source);
        try {
            localStorage.setItem(STORAGE_KEY, source);
        } catch {
            // 保存できなくても画面はそのまま使える
        }
        for (const listener of this.listeners) listener(this.workspace, origin);
    }
}

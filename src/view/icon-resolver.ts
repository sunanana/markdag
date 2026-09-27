// 呼び出し側の resolveIcon への問い合わせと、その結果の控え。文書が使うロゴの ref を受け取り、まだ聞いていない ref だけを問い合わせる。
// 同期で返った SVG はその場で、Promise は解決したときに deliver へ渡す (受け取る側は描画の置き場で、入ったロゴを使う所だけ描き直す)。
// null は「引けなかった」(文字のまま)。reject と同期の throw も「引けなかった」として渡し、icon-unresolved (info) を知らせる。
// 同じ ref は 1 度だけ問い合わせる (引けなかったものも聞き直さない)。DOM を使わないので、単体テストから直接呼べる
import type { Diagnostic } from '../model/model';
import { messageOf } from '../model/util';

// ref は文書に書いたとおりの set:name か相対パス。戻り値は SVG の文字列。絵文字の alias は渡さない
export type IconResolver = (ref: string) => string | null | Promise<string | null>;

export interface IconResolutionOptions {
    resolve: IconResolver;
    // 結果の受け取り先。null は引けなかった
    deliver: (ref: string, svg: string | null) => void;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
}

type Entry = { state: 'pending' } | { state: 'settled'; svg: string | null };

// 文字列でないもの (undefined など) は、引けなかったものとして扱う
const svgOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

export class IconResolution {
    private readonly entries = new Map<string, Entry>();
    private disposed = false;

    constructor(private readonly options: IconResolutionOptions) {}

    // 文書が使う ref を渡す。まだ聞いていない ref だけを問い合わせる
    request(refs: Iterable<string>): void {
        for (const ref of refs) {
            if (this.disposed) return;
            if (this.entries.has(ref)) continue;
            this.ask(ref);
        }
    }

    // 解決の済んだ ref と結果。受け取り先を後から用意したとき (view を後で付けたとき) に入れ直すのに使う
    settled(): Array<[string, string | null]> {
        return [...this.entries].flatMap(([ref, entry]) => (entry.state === 'settled' ? [[ref, entry.svg] as [string, string | null]] : []));
    }

    // 片付けたあとに届いた結果は捨てる
    dispose(): void {
        this.disposed = true;
    }

    private ask(ref: string): void {
        let result: unknown;
        try {
            result = this.options.resolve(ref);
        } catch (error) {
            this.fail(ref, error);
            return;
        }
        if (!isThenable(result)) {
            this.settle(ref, svgOrNull(result));
            return;
        }
        this.entries.set(ref, { state: 'pending' });
        // 問い合わせ中に文書が差し替わってその ref を使わなくなっても、結果は置き場に入れるだけ (描き直す所がなければ何もしない)
        Promise.resolve(result).then(
            (svg) => this.settle(ref, svgOrNull(svg)),
            (error: unknown) => this.fail(ref, error),
        );
    }

    private settle(ref: string, svg: string | null): void {
        this.entries.set(ref, { state: 'settled', svg });
        if (this.disposed) return;
        this.options.deliver(ref, svg);
    }

    // 引けなかった ref は、一時的な失敗 (ネットワーク) でも聞き直さない (文書を差し替えても、同じ ref は失敗のまま)。
    // 描画は文字のまま続くので重大度は info
    private fail(ref: string, error: unknown): void {
        this.settle(ref, null);
        if (this.disposed) return;
        this.options.onDiagnostic?.({
            severity: 'info',
            code: 'icon-unresolved',
            message: `ロゴ「${ref}」を resolveIcon で引けなかったので、文字のまま描きます (${messageOf(error)})`,
            at: null,
            hint: 'resolveIcon が SVG の文字列を返すか確かめます。引けないと分かっている ref は null を返すと、この診断は出ません',
        });
    }
}

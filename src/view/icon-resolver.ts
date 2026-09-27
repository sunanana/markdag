// 呼び出し側の resolveIcon への問い合わせと、その結果の控え。文書が使うロゴの ref を受け取り、まだ聞いていない ref だけを問い合わせる。
// 同期で返った SVG はその場で、Promise は解決したときに deliver へ渡す (受け取る側は描画の置き場で、入ったロゴを使う所だけ描き直す)。
// 引けなかったとき (null、SVG として読めない文字列、reject、同期の throw) はロゴを文字のままにし、icon-unresolved (warning) を知らせる。
// 読めない文字列は置き場がサニタイズで落とすものと同じ判定で見分け、文字列そのものは置き場へ渡す (落とすのは置き場の役目)。
// 同じ ref は 1 度だけ問い合わせる (引けなかったものも聞き直さない)。DOM を使わないので、単体テストから直接呼べる
import type { Diagnostic } from '../model/model';
import { messageOf } from '../model/util';
import { sanitizeSvg } from './icons';

// ref は文書に書いたとおりの set:name か相対パス。戻り値は SVG の文字列。絵文字の alias は渡さない
export type IconResolver = (ref: string) => string | null | Promise<string | null>;

export interface IconResolutionOptions {
    resolve: IconResolver;
    // 結果の受け取り先。null は引けなかった
    deliver: (ref: string, svg: string | null) => void;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
}

type Entry = { state: 'pending' } | { state: 'settled'; svg: string | null };

// 引けなかった理由。診断の文と手がかりを分ける
type Failure = { kind: 'null'; value: null | undefined } | { kind: 'unreadable'; value: unknown } | { kind: 'error'; error: unknown };

// 文字列でないもの (undefined など) は、引けなかったものとして扱う
const svgOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

// 戻り値が使えるロゴにならないときの理由。使えるなら null
function failureOf(value: unknown): Failure | null {
    if (value === null || value === undefined) return { kind: 'null', value };
    if (typeof value !== 'string' || sanitizeSvg(value) === null) return { kind: 'unreadable', value };
    return null;
}

// 例外の理由の文。文字にできない値 (Object.create(null) など) でも描画を止めないよう、固定の文にする
function reasonOf(error: unknown): string {
    try {
        return messageOf(error);
    } catch {
        return '文字にできない値';
    }
}

function unresolvedDiagnostic(ref: string, failure: Failure): Diagnostic {
    const base = { severity: 'warning', code: 'icon-unresolved' } as const;
    switch (failure.kind) {
        case 'null':
            return {
                ...base,
                message: `ロゴ「${ref}」を resolveIcon が返さなかった (${String(failure.value)}) ので、文字のまま描きます`,
                at: null,
                hint: 'ref の書き間違い (set の名前、ファイルのパス) がないか、resolveIcon がこの ref の SVG の文字列を返すか確かめます。単体 HTML では、書き出すときの icons にこの ref の SVG を入れます',
            };
        case 'unreadable':
            return {
                ...base,
                message: `ロゴ「${ref}」の resolveIcon の戻り値を SVG として読めなかったので、文字のまま描きます (${typeof failure.value === 'string' ? '<svg> の要素 1 つではありません' : `文字列でない値: ${typeof failure.value}`})`,
                at: null,
                hint: '<svg> の要素 1 つだけの文字列を返します (前後に別の要素がある、閉じていない、HTML など SVG でないものは読めません)',
            };
        case 'error':
            return {
                ...base,
                message: `ロゴ「${ref}」を resolveIcon で引けなかったので、文字のまま描きます (例外: ${reasonOf(failure.error)})`,
                at: null,
                hint: 'resolveIcon が例外を投げずに (Promise なら reject せずに) SVG の文字列を返すか確かめます。一時的な失敗でも、同じ ref は聞き直しません',
            };
    }
}

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
            this.fail(ref, { kind: 'error', error });
            return;
        }
        if (!isThenable(result)) {
            this.finish(ref, result);
            return;
        }
        this.entries.set(ref, { state: 'pending' });
        // 問い合わせ中に文書が差し替わってその ref を使わなくなっても、結果は置き場に入れるだけ (描き直す所がなければ何もしない)
        Promise.resolve(result).then(
            (value) => this.finish(ref, value),
            (error: unknown) => this.fail(ref, { kind: 'error', error }),
        );
    }

    private settle(ref: string, svg: string | null): void {
        this.entries.set(ref, { state: 'settled', svg });
        if (this.disposed) return;
        this.options.deliver(ref, svg);
    }

    // 戻り値で済んだとき。使えないロゴは、渡したうえで失敗として知らせる
    private finish(ref: string, value: unknown): void {
        const failure = failureOf(value);
        this.settle(ref, svgOrNull(value));
        if (failure) this.report(ref, failure);
    }

    // 例外で済んだとき。引けなかった ref は、一時的な失敗 (ネットワーク) でも聞き直さない (文書を差し替えても、同じ ref は失敗のまま)
    private fail(ref: string, failure: Failure): void {
        this.settle(ref, null);
        this.report(ref, failure);
    }

    // resolver を渡したのに引けなかったので warning (描画は文字のまま続く)。片付けたあとは知らせない
    private report(ref: string, failure: Failure): void {
        if (this.disposed) return;
        this.options.onDiagnostic?.(unresolvedDiagnostic(ref, failure));
    }
}

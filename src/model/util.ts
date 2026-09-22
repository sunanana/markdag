// model 層で共有する小さな道具。値の形の判定と、書き間違いに近い候補の探索
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// 2 つの文字列の編集距離 (文字単位)。隣り合う 2 文字の入れ替え (chain と chian) も 1 回と数える
export function editDistance(a: string[], b: string[]): number {
    let beforePrevious: number[] = [];
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            let best = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, (beforePrevious[j - 2] ?? 0) + 1);
            current[j] = best;
        }
        beforePrevious = previous;
        previous = current;
    }
    return previous[b.length] ?? 0;
}

// 書き間違いらしい入力に対して、いちばん近い候補を 1 つ返す。離れた候補しかなければ null
export function closest(input: string, candidates: string[]): string | null {
    const source = [...input];
    const limit = source.length <= 2 ? 1 : Math.max(1, Math.floor(source.length / 3));
    let best: { text: string; score: number } | null = null;
    for (const candidate of new Set(candidates)) {
        if (candidate === input || candidate === '') continue;
        const score = editDistance(source, [...candidate]);
        if (score <= limit && (best === null || score < best.score)) best = { text: candidate, score };
    }
    return best?.text ?? null;
}

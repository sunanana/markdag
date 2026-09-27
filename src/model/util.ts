// model 層と描画の部品で共有する小さな道具。値の形の判定と、例外の理由の文
export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// 投げられた値の理由の文。Error なら message、それ以外は String() の文字
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

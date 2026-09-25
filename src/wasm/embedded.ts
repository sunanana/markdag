// 配布物に焼き込んだ wasm (base64)。IIFE の配布物だけ、ビルドの台本がこのモジュールを中身つきに差し替える
// (script タグ 1 本の利用者と単体 HTML は、隣に .wasm を置けず import.meta.url もないため)。
// ES モジュールの配布物と開発中は null で、入口の init は入口の隣の markdag.wasm を読む (A-198)
export const EMBEDDED_WASM: string | null = null;

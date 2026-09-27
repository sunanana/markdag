// 図を「単体で開ける HTML」の文字列にする包み。ページの組み立て (骨組み、逃がし方、起動の script) は Rust (wasm の standalone_page) が行い、
// JS と CLI (markdag html) で同じ HTML を出す (A-017)。ページの文字列の正本は Rust の側にある。DOM を触らないので Node でも動く (init のあと)。
// ランタイム (script タグ 1 本で動く版) とスタイルシートをページに埋め、図の素材は JSON で埋めて、開いたときに組み立てる。
// 外部を読みに行くものはページに入れない。画像や書体の同梱は、呼び出し側が素材 (parsed の html、css) に済ませて渡す。
// ロゴは呼び出し側が解決した SVG を素材の icons で渡す (画像の data: URI 化と同じく、呼び出し側が済ませる)。
import { callJson } from '../wasm/boundary';
import { sanitizeSvg } from '../view/icons';
import type { StandaloneData } from './mount';

export interface StandaloneRuntime {
    // ランタイムのコード。グローバル markdag を定義する IIFE
    script: string;
    style: string;
}

export interface StandaloneOptions extends StandaloneData {
    title?: string;
    // html 要素の lang。省略すると付けない
    lang?: string;
    // 図を置く要素に足すクラス。呼び出し側のスタイルシートが詳細度を稼ぐのに使う
    containerClass?: string;
    // 追加のスタイルシート。ランタイムのものより後に入るので、同じ詳細度なら勝つ。色の変数の上書き、@font-face、数式やコードの色付けの CSS など
    css?: string[];
    // head の末尾に入れる HTML (meta など)。そのまま入るので、呼び出し側が正しい HTML を渡す
    head?: string;
    // 埋めるランタイムを差し替える (原文だけを渡すときは、変換器を含む版が要る)
    runtime?: Partial<StandaloneRuntime>;
}

// ページの中の名前。Rust の側と同じ値 (単体 HTML の試験が、ページの中にこの名前があることを見る)
export const CONTAINER_CLASS = 'mdag-standalone';
export const DATA_ID = 'markdag-data';
// 開いたときの図の窓口を置く window の名前
export const DIAGRAM_GLOBAL = 'markdagStandalone';

// 焼き込む前にロゴを sanitizeSvg に通す。SVG として読めないものは落とす (開いたページでは文字のまま)。
// 開いたときにも描画の側がもう一度通すので、ここは埋める中身を減らし、script などをページに持ち込まないためのもの
// CLI の html (Rust) は埋める前に通さず、読んだ SVG をそのまま埋める (開いたときの 1 回だけ通る)。
// そのため同じ SVG でも JS と CLI で埋める文字列が違う。
// 結果は Object.fromEntries で組む (代入だと ref が __proto__ のときに原型を差し替えてしまい、その ref が落ちる)
function sanitizeIcons(icons: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!icons) return undefined;
    const sanitized: Array<[string, string]> = [];
    for (const [ref, svg] of Object.entries(icons)) {
        const clean = typeof svg === 'string' ? sanitizeSvg(svg) : null;
        if (clean !== null) sanitized.push([ref, clean]);
    }
    return Object.fromEntries(sanitized);
}

// 素材 (HTML に JSON で埋めるもの) とページの指定を分けて渡す。素材は書かれた欄の順に Rust が JSON にする。
// 組み立てられないとき (parsed も source もない、埋め込めないランタイム) は、Rust の文面の MarkdagError (code は standalone-error) を投げる
export function renderStandalonePage(options: StandaloneOptions, defaults: StandaloneRuntime): string {
    const { parsed, source, types, hookScripts, view, state, tasks, iconAliases, icons, title, lang, containerClass, css, head, runtime } = options;
    return callJson<string>('standalone_page', {
        runtime: defaults.script,
        css: defaults.style,
        data: { parsed, source, types, hookScripts, view, state, tasks, iconAliases, icons: sanitizeIcons(icons) },
        options: { title, lang, containerClass, css, head, runtime },
    });
}

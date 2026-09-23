// 図を「単体で開ける HTML」の文字列にする。DOM を触らないので Node でも動く。
// ランタイム (script タグ 1 本で動く版) とスタイルシートをページに埋め、図の素材は JSON で埋めて、開いたときに組み立てる。
// 外部を読みに行くものはページに入れない。画像や書体の同梱は、呼び出し側が素材 (parsed の html、css) に済ませて渡す。
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

const DEFAULT_TITLE = 'markdag';
export const CONTAINER_CLASS = 'mdag-standalone';
export const DATA_ID = 'markdag-data';

// ページの骨組みの CSS。図を置く要素が画面いっぱいになるようにする。色は図のスタイルシートと css が決める
const BASE_STYLE = ['html, body { margin: 0; height: 100%; }', `.${CONTAINER_CLASS} { width: 100%; height: 100vh; height: 100dvh; }`].join('\n');

// 開いたときに図を組み立てる。診断は見せる場所がないので開発者ツールに出し、図の窓口も開発者ツールから触れるように window に置く
export const DIAGRAM_GLOBAL = 'markdagStandalone';
const BOOT = [
    `markdag.mountStandalone(document.querySelector('.${CONTAINER_CLASS}'), JSON.parse(document.getElementById('${DATA_ID}').textContent)).then((diagram) => {`,
    `    window.${DIAGRAM_GLOBAL} = diagram;`,
    '    if (diagram.diagnostics.length > 0) console.warn(markdag.formatDiagnostics(diagram.diagnostics));',
    '});',
].join('\n');

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// script の中の閉じタグで script が途中で終わらないようにする。`<!--` のあとに `<script` があると閉じタグの扱いが変わり、
// 文字の置き換えでは直せないので、そのコードは埋められないものとして断る
function embedScript(code: string): string {
    if (/<!--[\s\S]*<script/i.test(code)) throw new Error('script の中に「<!--」と「<script」が続けて現れるので、HTML に埋め込めません');
    return code.replace(/<\/script/gi, '<\\/script');
}

// style の中の閉じタグも同じ。CSS では `\/` は `/` なので、置き換えても意味は変わらない
const embedStyle = (css: string): string => css.replace(/<\/style/gi, '<\\/style');

// JSON を script に埋める。`<` を逃がしておけば、中身が何であれタグとして読まれない (JSON.parse はそのまま読める)
const embedJson = (value: unknown): string =>
    JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderStandalonePage(options: StandaloneOptions, defaults: StandaloneRuntime): string {
    const { parsed, source, types, hookScripts, view, state, tasks, title = DEFAULT_TITLE, lang, containerClass, css = [], head = '', runtime = {} } = options;
    if (parsed === undefined && source === undefined) throw new Error('parsed か source のどちらかが要ります');
    const data: StandaloneData = { parsed, source, types, hookScripts, view, state, tasks };
    const script = runtime.script ?? defaults.script;
    const style = runtime.style ?? defaults.style;
    const classes = [CONTAINER_CLASS, ...(containerClass ?? '').split(/\s+/).filter((name) => name !== '')].join(' ');

    return [
        '<!doctype html>',
        lang === undefined ? '<html>' : `<html lang="${escapeHtml(lang)}">`,
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(title)}</title>`,
        `<style>\n${embedStyle(style)}\n</style>`,
        `<style>\n${BASE_STYLE}\n</style>`,
        ...(css.length > 0 ? [`<style>\n${embedStyle(css.join('\n'))}\n</style>`] : []),
        ...(head === '' ? [] : [head]),
        '</head>',
        '<body>',
        `<div class="${escapeHtml(classes)}"></div>`,
        `<script id="${DATA_ID}" type="application/json">${embedJson(data)}</script>`,
        `<script>\n${embedScript(script)}\n</script>`,
        `<script>\n${BOOT}\n</script>`,
        '</body>',
        '</html>',
        '',
    ].join('\n');
}

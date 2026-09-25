// 単体 HTML のページの組み立ての場面の一覧。期待値 (旧実装の出力を写したファイル) を書き出す側と、Rust の写しと比べる試験の両方がこれを使う。
// 場面ごとに、ページの指定 (options) と、既定のランタイム (runtime) を持つ。runtime が 'dist' のものは、旧実装の配布物のランタイム
// (Rust 化の前に写した markdag.core.iife.js) とスタイルシートを既定にした場面 (旧実装の buildStandaloneHtml にあたる)
import type { StandaloneOptions, StandaloneRuntime } from '../../../src/standalone/page';

export const FAKE_RUNTIME: StandaloneRuntime = { script: 'var markdag = { mountStandalone() {} };', style: '.markdag { color: red; }' };

// 逃がし方を突く文字列: 閉じタグ (大文字を含む)、コメントの開始、行の区切りの U+2028 / U+2029、C0 の制御文字、DEL、
// サロゲートの対 (絵文字)、HTML の特別な文字、JSON の逃がし (`"` `\` `/`)、BOM と全角空白、
// 閉じタグの後ろが空白やタブ、改行を挟んだコメントの開始、ASCII に畳まれない U+017F (ſ)
export const ADVERSARIAL = [
    '</script><script>alert(1)</script>',
    '</SCRIPT></Style><!-- <script> -->',
    'a b c',
    Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join('') + '\u007f\u0085',
    '😀𠮷\u{10ffff}',
    '& < > " \' &amp;',
    '"\\/\\u003c',
    '﻿　  ',
    '',
    '</script </script\t</SCRIPT\n',
    '<!--\n<script',
    '</ſcript> <!--<ſcript ſ',
];

export interface StandaloneCase {
    label: string;
    options: StandaloneOptions;
    runtime: StandaloneRuntime | 'dist';
}

export interface CorpusDocument {
    // コーパスのファイル名 (.md つき)
    name: string;
    source: string;
    // wasm の parse_document の結果 (素材の中身は組み立てでは読まないので、出どころは問わない。期待値の側に写して固定する)
    parsed: NonNullable<StandaloneOptions['parsed']>;
}

// コーパスの文書を原文だけ、解析結果だけ、両方と型とフックと表示の指定で埋める。それぞれ仮のランタイムと配布物のランタイムで
export function corpusCases(documents: CorpusDocument[], types: Record<string, unknown>): StandaloneCase[] {
    return documents.flatMap(({ name, source, parsed }) => {
        const variants: Array<[string, StandaloneOptions]> = [
            ['source', { source }],
            ['parsed', { parsed }],
            [
                'full',
                {
                    parsed,
                    source,
                    types,
                    hookScripts: { './ok.hooks.js': 'export function beforeTaskToggle() { return "</script>"; }', './b.js': source },
                    view: { theme: 'dark', details: 'click', legend: true, animate: false } as StandaloneOptions['view'],
                    state: { folded: [1, 3], transform: { x: 0.1 + 0.2, y: -0, k: 1e-7 } },
                    tasks: 'scratch',
                    title: name,
                    lang: 'ja',
                    containerClass: ' zu-markdag  print ',
                    css: ['.markdag { --markdag-bg: #000; }', '.a::after { content: "</style>"; }'],
                    head: '<meta name="color-scheme" content="dark">',
                },
            ],
        ];
        return variants.flatMap(([variant, options]): StandaloneCase[] => [
            { label: `${name} (${variant}, 仮のランタイム)`, options, runtime: FAKE_RUNTIME },
            { label: `${name} (${variant}, 配布物のランタイム)`, options, runtime: 'dist' },
        ]);
    });
}

// 逃がし方を突く文字列を、素材、題、lang、クラス、CSS、head、ランタイムのどこかに入れる
export function adversarialCases(): StandaloneCase[] {
    return ADVERSARIAL.flatMap((text, index): StandaloneCase[] => {
        const label = `文字列 ${index}`;
        return [
            { label: `${label} 素材`, options: { source: text, parsed: { nodes: [], frontmatter: { [text]: text }, extracted: false, styleUrls: [text], taskIcons: null } as never }, runtime: FAKE_RUNTIME },
            { label: `${label} ページの指定`, options: { source: 'x', title: text, lang: text, containerClass: text, head: text, css: [text, text] }, runtime: FAKE_RUNTIME },
            { label: `${label} スタイル`, options: { source: 'x', runtime: { style: text } }, runtime: FAKE_RUNTIME },
            { label: `${label} 既定のランタイム`, options: { source: 'x' }, runtime: { script: `var s = ${JSON.stringify(text)};`, style: text } },
        ];
    });
}

// 数とキーの順 (JSON.stringify と同じに書くか)
export function numberCases(): StandaloneCase[] {
    const numbers = [0, -0, 1, -1, 0.1 + 0.2, 1e-6, 1e-7, 5e-7, 1e20, 1e21, 2 ** 53, 2 ** 53 + 2, 2 ** 64, 1.7976931348623157e308, 5e-324, 123456789.125, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    // 整数に見えるキー (配列の添字の形) は JS では数の昇順に先頭へ出る。01 と 4294967295 は添字の形でない
    const keyed = JSON.parse('{"b":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6,"a":7,"__proto__":8,"0":9}') as Record<string, unknown>;
    const marks = { $number: 'NaN' };
    const objectMark = { $object: [['k', 1]] };
    return [
        { label: '数とキー', options: { source: 'x', types: { numbers, keyed, marks, objectMark, nested: [[[{}]], [], null, true, false] } }, runtime: FAKE_RUNTIME },
        { label: 'parsed が null', options: { parsed: null as never }, runtime: FAKE_RUNTIME },
    ];
}

// 断る場面と、断らない境目 (`<script` が `<!--` より前にしかない)
export const SCRIPT_FIRST_LABEL = '<script> が <!-- より前だけ';
export function refusalCases(): StandaloneCase[] {
    return [
        { label: '素材なし', options: {}, runtime: FAKE_RUNTIME },
        { label: '素材が undefined', options: { parsed: undefined, source: undefined, title: 'x' }, runtime: FAKE_RUNTIME },
        { label: '埋め込めないランタイム', options: { source: 'x', runtime: { script: 'var a = 1; /* <!-- */ var b = "<SCRIPT>";' } }, runtime: FAKE_RUNTIME },
        { label: 'コメントだけ', options: { source: 'x', runtime: { script: 'var a = "<!--";' } }, runtime: FAKE_RUNTIME },
        { label: SCRIPT_FIRST_LABEL, options: { source: 'x', runtime: { script: 'var a = "<script>"; /* <!-- */' } }, runtime: FAKE_RUNTIME },
    ];
}

// 対になっていないサロゲート。旧実装はそのまま逃がして埋め、Rust の包みは U+FFFD に置き換えてから渡す
export const LONE_SURROGATE = 'a\ud800b';
// String.prototype.toWellFormed の写し (tsconfig の lib に es2024 がないため。対になっていないサロゲートを U+FFFD に)
export const toWellFormed = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
export function surrogateCases(): StandaloneCase[] {
    return [
        { label: 'サロゲート (そのまま)', options: { source: LONE_SURROGATE }, runtime: FAKE_RUNTIME },
        { label: 'サロゲート (置き換えたあと)', options: { source: toWellFormed(LONE_SURROGATE) }, runtime: FAKE_RUNTIME },
    ];
}

// ページを、起動の script の中身とそれ以外に分ける。起動の中身には `<script>` が現れないので、最後の `<script>\n` からが起動
const BOOT_OPEN = '<script>\n';
const BOOT_CLOSE = '\n</script>\n</body>\n</html>\n';
export function splitBoot(html: string): { page: string; boot: string } {
    const start = html.lastIndexOf(BOOT_OPEN);
    if (start < 0 || !html.endsWith(BOOT_CLOSE)) throw new Error('起動の script がページの末尾にない');
    return { page: `${html.slice(0, start)}${BOOT_OPEN}(起動)${BOOT_CLOSE}`, boot: html.slice(start + BOOT_OPEN.length, html.length - BOOT_CLOSE.length) };
}

// 配布物のランタイムとスタイルシートは大きいので、期待値のファイルでは埋めた位置を印に置き換えて持つ (1 字も違わないことは sha256 で見る)。
// 埋めた形 (閉じタグの逃がし) は旧実装の embedScript / embedStyle と同じ置き換え。それぞれちょうど 1 回現れなければ印にしない
export const RUNTIME_MARK = '(配布物のランタイム)';
export const STYLE_MARK = '(配布物のスタイルシート)';
export function markDist(page: string, dist: StandaloneRuntime): string {
    const script = dist.script.replace(/<\/script/gi, '<\\/script');
    const style = dist.style.replace(/<\/style/gi, '<\\/style');
    const once = (text: string, part: string, mark: string): string => (text.split(part).length === 2 ? text.replace(part, () => mark) : text);
    return once(once(page, script, RUNTIME_MARK), style, STYLE_MARK);
}

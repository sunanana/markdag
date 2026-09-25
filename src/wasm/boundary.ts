// JS と wasm の境界のレイヤー。wasm の読み込みと初期化、初期化前の呼び出しの検出、
// JSON の値と UTF-8 のバイト列の変換 (有限でない数と利用者のオブジェクトの印を含む)、
// `{ ok } | { error }` の封筒を値か MarkdagError にすること、異常終了 (trap) のあとの立て直しを 1 箇所で受け持つ。
// 包み (parse / model / layout の TS) はこのファイルの関数だけを呼び、wasm の export や線形メモリには触らない。
// Map の組み直しなど契約の形を知る変換は包みが行い、ここは JSON の値の受け渡しと誤りだけを扱う。
// 呼び出しは文書 1 つにつき 1 回のように大きな単位でまとめ、ノードごとに往復しない。
import { callBytes, exportName, hasFunction, type JsonFunction, readPanicMessage, takeBytes, unpack, type WasmExports } from './abi';
import { EMBEDDED_WASM } from './embedded';

export type WasmSource = BufferSource | WebAssembly.Module | Response | string | URL;

export class WasmNotReadyError extends Error {
    constructor() {
        super('markdag: wasm が初期化されていません。先に await init() を呼んでください');
        this.name = 'WasmNotReadyError';
    }
}

// wasm の呼び出しが異常終了した (Rust の panic か、それ以外の trap)。インスタンスは作り直してあるので、次の呼び出しはそのまま行える
export class WasmTrapError extends Error {
    readonly functionName: string;
    readonly panicMessage: string;

    constructor(functionName: string, panicMessage: string, cause: unknown) {
        const detail = panicMessage !== '' ? panicMessage : cause instanceof Error ? cause.message : String(cause);
        super(`markdag: wasm の ${functionName} が異常終了しました (${detail})`);
        this.name = 'WasmTrapError';
        this.functionName = functionName;
        this.panicMessage = panicMessage;
        this.cause = cause;
    }
}

// wasm の関数が `{ error: { code, message } }` を返した (入力の JSON が契約に合わない、配置の誤りなど)。
// code は境界の誤りの種類: invalid-input (入力の JSON を読めない)、layout-error (配置の層の誤り)、standalone-error (単体 HTML を組み立てられない)、output (出力を JSON にできない)
export class MarkdagError extends Error {
    readonly code: string;
    readonly functionName: string;

    constructor(functionName: string, code: string, message: string) {
        super(message);
        this.name = 'MarkdagError';
        this.code = code;
        this.functionName = functionName;
    }
}

let compiled: WebAssembly.Module | null = null;
let current: WasmExports | null = null;
// 読み込みの途中の init。並んで呼ばれた init が同じ読み込みを待つようにする
let pending: Promise<void> | null = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// file: の URL は fetch で読めない (Node) ので、ファイルとして読む。node:fs はブラウザの成果物に入れないよう、名前を変数にして実行時に読む
const NODE_FS = 'node:fs/promises';

function fileUrlOf(source: string | URL): URL | null {
    if (source instanceof URL) return source.protocol === 'file:' ? source : null;
    return source.startsWith('file:') ? new URL(source) : null;
}

async function compile(source: WasmSource): Promise<WebAssembly.Module> {
    if (source instanceof WebAssembly.Module) return source;
    if (typeof source === 'string' || source instanceof URL) {
        const file = fileUrlOf(source);
        if (file !== null) {
            const { readFile } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ NODE_FS)) as { readFile(path: URL): Promise<Uint8Array<ArrayBuffer>> };
            return WebAssembly.compile(await readFile(file));
        }
        return WebAssembly.compileStreaming(fetch(source));
    }
    if (source instanceof Response) return WebAssembly.compileStreaming(source);
    return WebAssembly.compile(source);
}

// import は 0 個。Rust から JS を呼ぶ口を持たない
function instantiate(module: WebAssembly.Module): WasmExports {
    return new WebAssembly.Instance(module, {}).exports as unknown as WasmExports;
}

// 1 回だけ待つ。2 回目以降は同じインスタンスを使う (別の wasm に替えたいときは reset を先に呼ぶ)。
// 読み込みに失敗したら、次の init でやり直せるようにする
export async function init(source: WasmSource): Promise<void> {
    if (current !== null) return;
    pending ??= compile(source).then(
        (module) => {
            compiled = module;
            current = instantiate(module);
        },
        (error: unknown) => {
            pending = null;
            throw error;
        },
    );
    await pending;
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

// 入口 (index、core、standalone) の init。source を省くと、配布物に焼き込んだ wasm があればそれを、なければ
// 入口のファイルと同じ場所の markdag.wasm (locate が返す URL) を読む。
// locate は入口に `new URL('./markdag.wasm', import.meta.url)` のリテラルで書く (バンドラが wasm を写す目印。A-198)。
// IIFE の配布物は import.meta がない (import.meta.url が undefined で new URL が投げる) 代わりに wasm を焼き込んである
const DEFAULT_WASM = 'markdag.wasm';
export function initFromEntry(source: WasmSource | undefined, locate: () => URL): Promise<void> {
    if (source !== undefined) return init(source);
    if (EMBEDDED_WASM !== null) return current !== null ? Promise.resolve() : init(decodeBase64(EMBEDDED_WASM));
    let url: URL;
    try {
        url = locate();
    } catch {
        return Promise.reject(new Error(`markdag: この配布物では ${DEFAULT_WASM} の場所が分からないので、init に .wasm の URL かバイト列を渡してください`));
    }
    return init(url);
}

export function isReady(): boolean {
    return current !== null;
}

export function reset(): void {
    compiled = null;
    current = null;
    pending = null;
}

function exportsOrThrow(): WasmExports {
    if (current === null) throw new WasmNotReadyError();
    return current;
}

// wasm の呼び出しの中で投げられた例外は種類を問わず trap として扱う (RuntimeError のほか、深い再帰の RangeError なども)。
// 手順: 作り直す前に古いインスタンスから panic の文面を読む → 同じモジュールから作り直す → WasmTrapError を投げる。
// trap した呼び出しの入力は free しない (アロケータの状態が信用できないので、インスタンスごと捨てる)
function guard<T>(name: string, run: (exports: WasmExports) => T): T {
    const exports = exportsOrThrow();
    try {
        return run(exports);
    } catch (error) {
        let panicMessage = '';
        try {
            panicMessage = readPanicMessage(exports);
        } catch {
            // 文面を読めなくても立て直しは続ける (既定の文面は WasmTrapError が cause から作る)
        }
        if (compiled !== null) current = instantiate(compiled);
        throw new WasmTrapError(name, panicMessage, error);
    }
}

// 線形メモリの今の大きさ (バイト)。memory は伸びるだけで縮まない。作り直しの閾値を設けるときと、試験で釣り合いを見るときに使う
export function memoryBytes(): number {
    return exportsOrThrow().memory.buffer.byteLength;
}

export function ping(n: number): number {
    return guard('ping', (exports) => exports.mdag_ping(n));
}

export function version(): string {
    return guard('version', (exports) => decoder.decode(takeBytes(exports, unpack(exports.mdag_version()))));
}

// ---- 有限でない数と利用者のオブジェクトの印 (規則書 4 章と A-044。Rust の JsValue / js_f64 の serde と同じ判定) ----
// JSON.stringify と serde_json はどちらも NaN と Infinity を null にするので、`{ "$number": "NaN" | "Infinity" | "-Infinity" }` で運ぶ。
// 利用者のオブジェクトで、undefined でない欄が 1 つだけでそのキーが $number か $object のものは、印と取り違えないよう
// `{ "$object": [[キー, 値]] }` に包む。-0 は運ばない (JSON.stringify と同じく 0 になる)。Map や Date は JSON.stringify のまま。
// 包みは契約の形を見ずにすべてのオブジェクトにかける。Rust は利用者の値 (JsValue) と、利用者がキーを決める写像 (types と hooks) の
// 両方で包みを外すので、欄の名前が固定の構造体を除くすべての位置で判定がそろう (欄の名前が $number / $object の構造体はない)

const NON_FINITE: Record<string, number> = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY };

// ---- undefined の印 (A-197) ----
// 利用者の値 (Rust の JsValue の位置: frontmatter、types の値) の undefined は `{ "$undefined": true }` で運ぶ。
// JSON.stringify はオブジェクトの欄の undefined を落とし、配列の undefined と穴を null にするが、旧実装は値をメモリのまま渡していたので
// undefined の欄は残り、配列の要素も undefined のままだった。その振る舞い (診断の「原文の値を書き添えない」など) を保つための印。
// 構造体の欄 (Option) は印を読めないので、印を付けるのは包みが markUndefined で指定した JsValue の位置だけ (境界はすべての値にはかけない)。
// 戻りの向きは Rust が JsValue の位置でだけ印を書くので、reviveMarks はどこでも戻してよい。
// 印は同じ 1 つのオブジェクトで、replaceMarks と reviveMarks は同一性で見分ける (利用者の `{ "$undefined": ... }` の 1 欄のオブジェクトは $object に包む)
const UNDEFINED_KEY = '$undefined';
const UNDEFINED_MARK: Readonly<Record<string, unknown>> = Object.freeze({ [UNDEFINED_KEY]: true });
const MARK_KEYS = new Set(['$number', '$object', UNDEFINED_KEY]);

function isOwnPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value) as unknown;
    return (proto === Object.prototype || proto === null) && typeof (value as { toJSON?: unknown }).toJSON !== 'function';
}

// 利用者の値の写しを作り、オブジェクトの欄と配列の要素の undefined (配列の穴も) を印に置き換える。最上位の undefined はそのまま。
// 素のオブジェクトと配列だけをたどる (Date や Map など JSON.stringify が toJSON や {} にするものは触らない)。
// 循環していれば写さずに元の値を残し、JSON.stringify に同じ TypeError を投げさせる
export function markUndefined(value: unknown): unknown {
    const ancestors = new Set<object>();
    const walk = (item: unknown): unknown => {
        if (item === undefined) return UNDEFINED_MARK;
        const isArray = Array.isArray(item);
        if (!isArray && !isOwnPlainObject(item)) return item;
        if (ancestors.has(item as object)) return item;
        ancestors.add(item as object);
        const copied = isArray
            ? Array.from({ length: (item as unknown[]).length }, (_, index) => walk((item as unknown[])[index]))
            : Object.fromEntries(Object.keys(item as Record<string, unknown>).map((key) => [key, walk((item as Record<string, unknown>)[key])]));
        ancestors.delete(item as object);
        return copied;
    };
    return value === undefined ? undefined : walk(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 対になっていないサロゲート。serde_json は `\ud800` の逃がしを読めない (invalid-input) ので、送る文字列とキーは U+FFFD に置き換える
// (String.prototype.toWellFormed と同じ。tsconfig の lib に es2024 がないので写しを持つ)。原文を返す関数 (toggle_task) は書き換えた行だけを返し、
// 包みが原文に継ぎ足すので、置き換えが効くのはその行の中だけ (A-186)
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const toWellFormed = (text: string): string => text.replace(new RegExp(LONE_SURROGATE, 'g'), '\ufffd');
// 境界で書き換えられない文字列か (対になっていないサロゲートを含まない)
export const isWellFormedText = (text: string): boolean => !LONE_SURROGATE.test(text);

// JSON.stringify の replacer。返したオブジェクトの欄には replacer がもう一度かかるが、そのオブジェクト自身にはかからないので、包みが二重にならない。
// 文字列は toWellFormed を当てる (包みごとに当て忘れないよう、ここで 1 度に当てる。A-177 の追記の問い)
export function replaceMarks(_key: string, value: unknown): unknown {
    if (value === UNDEFINED_MARK) return value;
    if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
    if (typeof value === 'string') return toWellFormed(value);
    if (isPlainRecord(value)) {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined);
        const [only] = keys;
        if (keys.length === 1 && only !== undefined && MARK_KEYS.has(only)) return { $object: [[only, value[only]]] };
        if (keys.some((key) => LONE_SURROGATE.test(key))) return Object.fromEntries(keys.map((key) => [toWellFormed(key), value[key]]));
    }
    return value;
}

// JSON.parse の reviver。内側から順に呼ばれるので、包みの中の値はすでに戻っている。
// undefined の印は、reviver が undefined を返すと欄が消えるので、印をいったん UNDEFINED_MARK にし、親を戻すときに親の欄と要素を undefined にする
// (欄は残り、配列の長さも変わらない)。封筒 (最上位) はオブジェクトなので、最上位に印が残ることはない
export function reviveMarks(_key: string, value: unknown): unknown {
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) if (value[index] === UNDEFINED_MARK) value[index] = undefined;
        return value;
    }
    if (!isPlainRecord(value)) return value;
    const keys = Object.keys(value);
    for (const name of keys) if (value[name] === UNDEFINED_MARK) value[name] = undefined;
    if (keys.length !== 1) return value;
    if (keys[0] === UNDEFINED_KEY && value[UNDEFINED_KEY] === true) return UNDEFINED_MARK;
    const label = value.$number;
    if (keys[0] === '$number' && typeof label === 'string' && Object.hasOwn(NON_FINITE, label)) return NON_FINITE[label];
    const pairs = value.$object;
    if (keys[0] === '$object' && Array.isArray(pairs) && pairs.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string')) {
        return Object.fromEntries(pairs as Array<[string, unknown]>);
    }
    return value;
}

type Envelope = { ok: unknown } | { error: { code: string; message: string } };

// Rust が書いた JSON の文字をそのまま送り返す値 (A-215 (4))。JSON.parse は整数に見えるキーを先頭へ並べ直すので、
// 書かれた順を保ちたい値 (解析の結果の frontmatter) は受けたときの文字を持っておき、送るときにその文字を埋める
export class RawJson {
    constructor(readonly text: string) {}
}

// 入力を JSON の文字にする。RawJson は印の変換を通さず、持っている文字をそのまま埋める
function stringifyInput(input: unknown): string {
    const raws: string[] = [];
    const nonce = Math.random().toString(36).slice(2);
    const token = (index: number): string => `\u0000markdag-raw-${nonce}-${index}\u0000`;
    const text = JSON.stringify(input, (key, value: unknown) => {
        if (value instanceof RawJson) return token(raws.push(value.text) - 1);
        return replaceMarks(key, value);
    });
    return raws.reduce((result, raw, index) => result.replace(JSON.stringify(token(index)), () => raw), text);
}

// JSON の文字の start から始まる値 1 つの終わりの位置 (Rust の書く詰めた JSON を読む)
function endOfJsonValue(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (char === '\\') index += 1;
            else if (char === '"') {
                inString = false;
                if (depth === 0) return index + 1;
            }
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth += 1;
        else if (char === '}' || char === ']') {
            depth -= 1;
            if (depth === 0) return index + 1;
            if (depth < 0) return index;
        } else if (depth === 0 && char === ',') return index;
    }
    return text.length;
}

// JSON の値を渡して JSON の値を受ける。包みが使うのはこの関数だけ。
// 戻りの封筒が error なら MarkdagError を投げ、ok なら中身を返す (印は数とオブジェクトに戻してある)
export function callJson<T>(name: JsonFunction, input: unknown): T {
    return callJsonKeeping<T>(name, input, null).value;
}

// callJson と同じ。加えて、戻りの中で最初に出る欄 field の値の JSON の文字 (Rust が書いたまま) を返す。欄がなければ null。
// 欄の名前は、それより前の値の中にキーとして出てこないものに限る (文字列の中の " は \" になっているので、キーとしてだけ一致する)
export function callJsonKeeping<T>(name: JsonFunction, input: unknown, field: string | null): { value: T; raw: string | null } {
    const text = callJsonText(name, stringifyInput(input));
    const envelope = JSON.parse(text, reviveMarks) as Envelope;
    if ('error' in envelope) throw new MarkdagError(name, envelope.error.code, envelope.error.message);
    let raw: string | null = null;
    if (field !== null) {
        const key = `${JSON.stringify(field)}:`;
        const at = text.indexOf(key);
        if (at >= 0) {
            const start = at + key.length;
            raw = text.slice(start, endOfJsonValue(text, start));
        }
    }
    return { value: envelope.ok as T, raw };
}

// 印の変換と封筒の解釈を通さずに、JSON の文字列を渡して封筒の JSON の文字列を受ける (試験で Rust の書いた JSON と比べるため)
export function callJsonText(name: JsonFunction, input: string): string {
    const exports = exportsOrThrow();
    if (!hasFunction(exports, name)) throw new Error(`markdag: wasm に ${exportName(name)} がありません`);
    const bytes = encoder.encode(input);
    return decoder.decode(guard(name, (live) => callBytes(live, name, bytes)));
}

// 受け取ったバイト列をそのまま返す mdag_echo の往復 (疎通の確認用。封筒も印も通さない)
export function echo<T>(input: T): T {
    const bytes = encoder.encode(JSON.stringify(input));
    const output = guard('echo', (exports) => callBytes(exports, 'echo', bytes));
    return JSON.parse(decoder.decode(output)) as T;
}

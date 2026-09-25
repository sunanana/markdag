// wasm の呼び出し規約。境界のレイヤーのうち「関数の名前」「値の詰め方」「線形メモリの読み書き」だけを持つ。
// 依頼者のフレームワークで置き換える箇所はここに閉じ、他のファイルはこの型と関数だけを見る。
// 今の規約: export はすべて mdag_ で始まる。バイト列は mdag_alloc で取った場所に書き、
// 戻りのバイト列は u64 (上位 32 bit が ptr、下位 32 bit が len) で受け、読み終えたら mdag_free で返す。
// 包みと境界のレイヤーは論理名 ('parse_document') で呼び、mdag_ を付けるのはこのファイルだけ。

// JSON を受けて `{ ok } | { error }` の JSON を返す関数の論理名 (設計文書 (b) の表)
export type JsonFunction =
    | 'parse_document'
    | 'build_model'
    | 'check_frontmatter'
    | 'render_document'
    | 'layout_document'
    | 'project_and_frames'
    | 'project'
    | 'toggle_task'
    | 'next_task_mark'
    | 'replace_leading_mark'
    | 'suggest_tag_keys'
    | 'suggest_tag_values'
    | 'standalone_page';

// 封筒に包まずバイト列をそのまま返す関数 (疎通の確認用)
export type RawFunction = 'echo';

type BytesExport = (ptr: number, len: number) => bigint;

export interface WasmExports {
    memory: WebAssembly.Memory;
    mdag_alloc(len: number): number;
    mdag_free(ptr: number, len: number): void;
    mdag_ping(n: number): number;
    mdag_version(): bigint;
    // 最後の panic の文面。静的な緩衝を指すので free しない
    mdag_last_panic(): bigint;
    [name: `mdag_${string}`]: unknown;
}

export interface Slice {
    ptr: number;
    len: number;
}

export function exportName(name: string): `mdag_${string}` {
    return `mdag_${name}`;
}

export function hasFunction(exports: WasmExports, name: string): boolean {
    return typeof exports[exportName(name)] === 'function';
}

// wasm の i32 と i64 は JS に符号つきで届く。線形メモリの場所は 2 GiB を越えうるので、場所は必ず符号なしに読み直す
export function unsignedPtr(value: number): number {
    return value >>> 0;
}

export function unpack(packed: bigint): Slice {
    const bits = BigInt.asUintN(64, packed);
    return { ptr: Number(bits >> 32n), len: Number(bits & 0xffff_ffffn) };
}

// JS から wasm へ。取った場所は呼んだ側 (callBytes) が mdag_free で返す
export function writeBytes(exports: WasmExports, bytes: Uint8Array): Slice {
    const ptr = unsignedPtr(exports.mdag_alloc(bytes.length));
    new Uint8Array(exports.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
}

// wasm から JS へ。memory.buffer は呼び出しの中で伸びて差し替わることがあるので、呼び出しの後に取り直して写す
export function takeBytes(exports: WasmExports, slice: Slice): Uint8Array {
    const copy = new Uint8Array(exports.memory.buffer, slice.ptr, slice.len).slice();
    exports.mdag_free(slice.ptr, slice.len);
    return copy;
}

// 静的な緩衝を読む (free しない)。trap したインスタンスからも読めるように、呼び出しと読み取りだけを行う
export function readPanicMessage(exports: WasmExports): string {
    const { ptr, len } = unpack(exports.mdag_last_panic());
    if (len === 0) return '';
    return new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len));
}

// バイト列を渡してバイト列を受ける 1 回の呼び出し。入力の場所は呼び出しが戻ってから返す。
// 呼び出しの中で trap したときは返さない (アロケータの状態が信用できず、インスタンスごと捨てるため)
export function callBytes(exports: WasmExports, name: JsonFunction | RawFunction, input: Uint8Array): Uint8Array {
    const run = exports[exportName(name)] as BytesExport;
    const arg = writeBytes(exports, input);
    const packed = run(arg.ptr, arg.len);
    exports.mdag_free(arg.ptr, arg.len);
    return takeBytes(exports, unpack(packed));
}

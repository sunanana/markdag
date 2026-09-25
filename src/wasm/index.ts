// wasm の入口。ブラウザは URL か埋め込みのバイト列で init し、Node は ./node の initFromFile で init する。
export {
    callJson,
    callJsonText,
    echo,
    init,
    isReady,
    MarkdagError,
    memoryBytes,
    ping,
    reset,
    reviveMarks,
    replaceMarks,
    version,
    WasmNotReadyError,
    WasmTrapError,
    type WasmSource,
} from './boundary';
export type { JsonFunction } from './abi';

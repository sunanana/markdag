// 図を「単体で開ける HTML」として書き出す入口。ランタイムとスタイルシートをビルド時に焼き込んでいるので、
// 呼び出し側のバンドラに何も求めない。ページの組み立ては Rust (wasm) を呼ぶので、使う前に init を待つ
// (この入口は既定の入口と別にまとめられ、wasm の状態を共有しないので、既定の入口の init では足りない)。
import coreRuntime from '../dist/markdag.core.iife.js?raw';
import style from './style.css?inline';
import { renderStandalonePage, type StandaloneOptions } from './standalone/page';
import { initFromEntry, type WasmSource } from './wasm/boundary';

export type { StandaloneData, StandaloneDiagram, StandaloneState, StandaloneTasks, StandaloneViewOptions } from './standalone/mount';
export type { StandaloneOptions, StandaloneRuntime } from './standalone/page';
export { isReady, MarkdagError, WasmNotReadyError, WasmTrapError } from './wasm/boundary';
export type { WasmSource } from './wasm/boundary';

// source を省くと、この入口のファイルと同じ場所の markdag.wasm を読む (Node では file: の URL をファイルとして読む)
export function init(source?: WasmSource): Promise<void> {
    // new URL の引数はこのリテラルの形のまま書く。利用者のバンドラ (Vite、webpack 5) はこの形を見つけたときだけ markdag.wasm を成果物に写す。
    // @vite-ignore はこのパッケージのビルドが書き換えないための印で、配布物ではビルドの台本が外す (A-198)
    return initFromEntry(source, () => new URL(/* @vite-ignore */ './markdag.wasm', import.meta.url));
}

export function buildStandaloneHtml(options: StandaloneOptions): string {
    return renderStandalonePage(options, { script: coreRuntime, style });
}

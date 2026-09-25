// 外部と通信しない入口。Rust 化の前は変換器 (markmap-lib) を利用者が渡す入口だった。今は解析を Rust で行うので既定の入口と同じものを公開し、
// 違いは入口のファイルの場所 (init が既定で読む markdag.wasm の場所) だけ。数式とコードの飾りは、ページにある KaTeX と highlight.js だけを使う。
import { initFromEntry, type WasmSource } from './wasm/boundary';

export { createHookBridge } from './bridge';
export type { HookBridge, HookBridgeOptions } from './bridge';
export { HOOK_EVENTS } from './model/hooks';
export type { BeforeHookEvent, HookApi, HookContext, HookContexts, HookDecoration, HookDocument, HookEdge, HookEvent, HookGroup, HookLayoutInfo, HookModule, HookNode, HookTransform, HookTraversal, OnHookEvent, ResolvedHook, ResolvedHooks, ValueHookEvent } from './model/hooks';
export { buildModel, checkFrontmatter } from './model/model';
export type { Diagnostic, DimDisplayMode, DisplayMode, GraphModel, GroupDef, LegendItem, LegendPosition, ModelOptions, SourcePosition, TagDisplayMode, TaskDimOptions } from './model/model';
export { formatTag, PRIMITIVES, suggestTagKeys, suggestTagValues } from './model/tags';
export type { Primitive, TagKeyDef, TagValueType } from './model/tags';
export { DEFAULT_TASK_CYCLE, isTaskMark, nextTaskMark, parseDocument, replaceLeadingMark, TASK_MARKS, TASK_STATES, taskMarkOf, taskStateOf, toggleTask } from './parse/document';
export type { NodeTag, OutlineNode, ParsedDocument, ParseOptions, TaskIcons, TaskMark, TaskState, TransformerLike } from './parse/document';
export { formatDiagnostics, render } from './render';
export type { MarkdagDiagram, RenderOptions } from './render';
export type { Rect } from './layout/layout';
export { mountStandalone } from './standalone/mount';
export type { MountOptions, StandaloneData, StandaloneDiagram, StandaloneState, StandaloneTasks, StandaloneViewOptions } from './standalone/mount';
export { MarkdagView } from './view/view';
export type { LayoutOverride, LayoutSnapshot, ViewHooks, ViewOptions, ViewTransform } from './view/view';
export { isReady, MarkdagError, WasmNotReadyError, WasmTrapError } from './wasm/boundary';
export type { WasmSource } from './wasm/boundary';

// wasm の読み込み。解析、モデルの組み立て、配置は Rust (wasm) を呼ぶので、使う前に 1 度だけ await init() を待つ。
// 待つ前に呼ぶと WasmNotReadyError を投げる (createHookBridge と、wasm を呼ばない写しの関数 (formatTag、formatDiagnostics、taskMarkOf など) は待たずに使える)。
// source を省くと、この入口のファイルと同じ場所の markdag.wasm を読む (Node では file: の URL をファイルとして読む)。
// IIFE の配布物 (script タグ 1 本の版) は wasm を焼き込んであるので、source なしでそれを読む
export function init(source?: WasmSource): Promise<void> {
    // new URL の引数はこのリテラルの形のまま書く。利用者のバンドラ (Vite、webpack 5) はこの形を見つけたときだけ markdag.wasm を成果物に写す。
    // @vite-ignore はこのパッケージのビルドが書き換えないための印で、配布物ではビルドの台本が外す (A-198)
    return initFromEntry(source, () => new URL(/* @vite-ignore */ './markdag.wasm', import.meta.url));
}

// 公開の既定の入口。変換器を渡す入口と同じものを公開し、解析と描画は、変換器の指定がなければ markmap-lib の標準の構成で補う。
import { defaultTransformer } from './parse/default-transformer';
import { parseDocument as parseWith, type ParsedDocument, type ParseOptions } from './parse/document';
import { render as renderWith, type MarkdagDiagram, type RenderOptions as RequiredRenderOptions } from './render';
import { mountStandalone as mountWith, type MountOptions, type StandaloneData, type StandaloneDiagram } from './standalone/mount';

export { createHookBridge } from './bridge';
export type { HookBridge, HookBridgeOptions } from './bridge';
export { HOOK_EVENTS } from './model/hooks';
export type { BeforeHookEvent, HookApi, HookContext, HookContexts, HookDecoration, HookDocument, HookEdge, HookEvent, HookGroup, HookLayoutInfo, HookModule, HookNode, HookTransform, HookTraversal, OnHookEvent, ResolvedHook, ResolvedHooks, ValueHookEvent } from './model/hooks';
export { buildModel, checkFrontmatter } from './model/model';
export type { Diagnostic, DimDisplayMode, DisplayMode, GraphModel, GroupDef, LegendItem, LegendPosition, ModelOptions, SourcePosition, TagDisplayMode, TaskDimOptions } from './model/model';
export { formatTag, PRIMITIVES, suggestTagKeys, suggestTagValues } from './model/tags';
export type { Primitive, TagKeyDef, TagValueType } from './model/tags';
export { DEFAULT_TASK_CYCLE, isTaskMark, nextTaskMark, replaceLeadingMark, TASK_MARKS, TASK_STATES, taskMarkOf, taskStateOf, toggleTask } from './parse/document';
export type { NodeTag, OutlineNode, ParsedDocument, ParseOptions, TaskIcons, TaskMark, TaskState, TransformerLike } from './parse/document';
export { formatDiagnostics } from './render';
export type { MarkdagDiagram } from './render';
export type { Rect } from './layout/layout';
export type { MountOptions, StandaloneData, StandaloneDiagram, StandaloneState, StandaloneTasks, StandaloneViewOptions } from './standalone/mount';
export { MarkdagView } from './view/view';
export type { LayoutOverride, LayoutSnapshot, ViewHooks, ViewOptions, ViewTransform } from './view/view';

export type RenderOptions = Omit<RequiredRenderOptions, 'transformer'> & Partial<ParseOptions>;

export function parseDocument(source: string, options: Partial<ParseOptions> = {}): ParsedDocument {
    return parseWith(source, { transformer: options.transformer ?? defaultTransformer() });
}

export function render(container: HTMLElement, markdown: string, options: RenderOptions = {}): MarkdagDiagram {
    return renderWith(container, markdown, { ...options, transformer: options.transformer ?? defaultTransformer() });
}

// 変換器は、原文だけを受けたときにだけ要る (解析結果を受けたときは markmap-lib を動かさない)
export function mountStandalone(container: HTMLElement, data: StandaloneData, options: MountOptions = {}): Promise<StandaloneDiagram> {
    return mountWith(container, data, { transformer: options.transformer ?? (data.parsed === undefined ? defaultTransformer() : undefined) });
}

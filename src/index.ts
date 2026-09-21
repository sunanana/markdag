// 公開の既定の入口。変換器を渡す入口と同じものを公開し、解析と描画は、変換器の指定がなければ markmap-lib の標準の構成で補う。
import { defaultTransformer } from './parse/default-transformer';
import { parseDocument as parseWith, type ParsedDocument, type ParseOptions } from './parse/document';
import { render as renderWith, type MarkdagDiagram, type RenderOptions as RequiredRenderOptions } from './render';

export { buildModel, checkFrontmatter } from './model/model';
export type { DetailsMode, Diagnostic, GraphModel, GroupDef, LegendItem, LegendPosition, SourcePosition } from './model/model';
export { toggleTask } from './parse/document';
export type { OutlineNode, ParsedDocument, ParseOptions, TransformerLike } from './parse/document';
export { formatDiagnostics } from './render';
export type { MarkdagDiagram } from './render';
export type { Rect } from './layout/layout';
export { MarkdagView } from './view/view';
export type { LayoutOverride, LayoutSnapshot, ViewHooks, ViewOptions, ViewTransform } from './view/view';

export type RenderOptions = Omit<RequiredRenderOptions, 'transformer'> & Partial<ParseOptions>;

export function parseDocument(source: string, options: Partial<ParseOptions> = {}): ParsedDocument {
    return parseWith(source, { transformer: options.transformer ?? defaultTransformer() });
}

export function render(container: HTMLElement, markdown: string, options: RenderOptions = {}): MarkdagDiagram {
    return renderWith(container, markdown, { ...options, transformer: options.transformer ?? defaultTransformer() });
}

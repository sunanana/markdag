// GUI 編集の入口 (markdag/editor)。markdag/core の render で描いた図の上に編集の層を載せる。
// init は出さない: wasm は markdag/core (か markdag) の init で待ってから mountEditor を呼ぶ (入口どうしは同じビルドで wasm の状態を共有する)。
// 編集の層は本体の公開の入口 (markdag/core) だけを読むので、あとで別のパッケージに切り出せる
export { mountEditor } from './editor/mount';
export type { EditorOptions, MarkdagEditor } from './editor/mount';
export type { EditorSelection } from './editor/selection';
export type { EditorMode, EditorModeOption } from './editor/settings';

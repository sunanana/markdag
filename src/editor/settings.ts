// 閲覧と GUI 編集のどちらで図を出すかの決め方 (DOM を使わない)。
// 文書の markdag.editor と mount のオプションの mode から、mode の設定、始めるモード、セグメントを出す隅を決める。
// mount の mode は文書の mode だけを上書きし、default と segment はいつも文書の指定に従う。
// 文書の指定が前の描画から変わったか (変わったときだけモードを合わせ直す) の比べ方もここに置く
import type { EditorModeSetting, EditorSettings, SegmentPosition } from '../core';

// 図の今のモード
export type EditorMode = 'view' | 'edit';
// mount のオプションの mode。document は文書の markdag.editor.mode に従う。それ以外は文書の mode を上書きする
export type EditorModeOption = 'document' | EditorModeSetting;

export interface ModeRule {
    // mount の mode で上書きしたあとの mode の設定。switch のときだけ見る人とアプリがモードを切り替えられる
    setting: EditorModeSetting;
    // 始めるモード。文書の指定が変わって合わせ直すときもこのモードに戻す
    initial: EditorMode;
    // セグメントを出す隅。出さないときは null
    segment: SegmentPosition | null;
}

// 図に文書がまだないときに使う指定。GraphModel.editor の既定 (markdag.editor を書いていない文書) と同じ値
export const FALLBACK_EDITOR_SETTINGS: EditorSettings = { mode: 'view', default: 'view', segment: { display: true, position: 'top-left' } };

export function resolveModeRule(option: EditorModeOption, editor: EditorSettings): ModeRule {
    // 型の外の値 (JS から渡された知らない文字) は document として扱う
    const setting = option === 'view' || option === 'edit' || option === 'switch' ? option : editor.mode;
    if (setting !== 'switch') return { setting, initial: setting, segment: null };
    return { setting, initial: editor.default, segment: editor.segment.display ? editor.segment.position : null };
}

// 値を埋めたあとの文書の指定を欄ごとに比べる。既定の値を書き足しただけなら同じ
export function sameEditorSettings(a: EditorSettings, b: EditorSettings): boolean {
    return a.mode === b.mode && a.default === b.default && a.segment.display === b.segment.display && a.segment.position === b.segment.position;
}

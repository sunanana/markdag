// 図を「単体で開ける HTML」として書き出す入口。ランタイム (変換器を含まない版) とスタイルシートをビルド時に焼き込んでいるので、
// 呼び出し側のバンドラに何も求めない。解析結果 (parsed) を渡すのが基本で、原文だけを渡すときは変換器を含むランタイムを runtime で差し替える。
import coreRuntime from '../dist/markdag.core.iife.js?raw';
import style from './style.css?inline';
import { renderStandalonePage, type StandaloneOptions } from './standalone/page';

export type { StandaloneData, StandaloneDiagram, StandaloneState, StandaloneTasks, StandaloneViewOptions } from './standalone/mount';
export type { StandaloneOptions, StandaloneRuntime } from './standalone/page';

export function buildStandaloneHtml(options: StandaloneOptions): string {
    return renderStandalonePage(options, { script: coreRuntime, style });
}

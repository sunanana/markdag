// 編集の層のモードの決め方と、
// 入口 markdag/editor の形を確かめる。
// モードの決め方は DOM を使わない部品を直に呼ぶ (テストは編集の層の中を直に読んでよい)。部品の形 (このテストが確かめる約束):
//     resolveModeRule(option: EditorModeOption, editor: EditorSettings): { setting: EditorModeSetting; initial: EditorMode; segment: SegmentPosition | null }
//         setting は mount の mode で上書きしたあとの mode の設定、initial は始める (文書の指定が変わって合わせ直す) モード、
//         segment はセグメントを出す隅 (出さないときは null)
//     sameEditorSettings(a: EditorSettings, b: EditorSettings): boolean
//         値を埋めたあとの文書の指定を欄ごとに比べる (同じなら合わせ直さない)
// 型のテスト (expectTypeOf) は実行では何もしない。型の検査は tsc (npm run typecheck) が行う
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Diagnostic, EditorModeSetting, EditorSettings, MarkdagView, RenderOptions, SegmentPosition } from '../src/core';
import * as entry from '../src/editor';
import type { EditorMode, EditorModeOption, EditorOptions, MarkdagEditor } from '../src/editor';
import { resolveModeRule, sameEditorSettings } from '../src/editor/settings';

const MODE_SETTINGS: EditorModeSetting[] = ['view', 'edit', 'switch'];
const STARTS: EditorMode[] = ['view', 'edit'];
const POSITIONS: SegmentPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'];
// markdag.editor を書いていない文書の値 (GraphModel.editor の既定)
const DEFAULT_SETTINGS: EditorSettings = { mode: 'view', default: 'view', segment: { display: true, position: 'top-left' } };

// 部品が引数を書き換えないよう、凍らせて渡す
const frozen = (settings: EditorSettings): EditorSettings => Object.freeze({ ...settings, segment: Object.freeze({ ...settings.segment }) });

// 文書の指定の全部の組み合わせ (3 × 2 × 2 × 6 = 72 通り)
function allSettings(): EditorSettings[] {
    return MODE_SETTINGS.flatMap((mode) =>
        STARTS.flatMap((start) => [true, false].flatMap((display) => POSITIONS.map((position) => frozen({ mode, default: start, segment: { display, position } })))),
    );
}

// モードの決め方 (mount の mode が文書の mode だけを上書きする) をそのまま書いた期待
function expectedRule(option: EditorModeOption, editor: EditorSettings): { setting: EditorModeSetting; initial: EditorMode; segment: SegmentPosition | null } {
    const setting = option === 'document' ? editor.mode : option;
    if (setting !== 'switch') return { setting, initial: setting, segment: null };
    return { setting, initial: editor.default, segment: editor.segment.display ? editor.segment.position : null };
}

const label = (option: EditorModeOption, editor: EditorSettings): string => `${option} × ${JSON.stringify(editor)}`;

describe('モードの決め方 (resolveModeRule)', () => {
    it('markdag.editor を書いていない文書 (既定の値) は閲覧だけで、セグメントを出さない (B-175)', () => {
        expect(resolveModeRule('document', frozen(DEFAULT_SETTINGS))).toEqual({ setting: 'view', initial: 'view', segment: null });
    });

    it('文書の mode が view か edit なら、そのモードだけでセグメントを出さない。default と segment は使わない (B-173、B-174、B-180)', () => {
        const cases = allSettings().filter((editor) => editor.mode !== 'switch');
        expect(cases).toHaveLength(48);
        for (const editor of cases) {
            expect(resolveModeRule('document', editor), label('document', editor)).toEqual({ setting: editor.mode, initial: editor.mode, segment: null });
        }
    });

    it('文書の mode が switch なら default のモードで始め、segment.display が true のときだけ segment.position の隅にセグメントを出す (B-174、B-179〜B-181)', () => {
        const cases = allSettings().filter((editor) => editor.mode === 'switch');
        expect(cases).toHaveLength(24);
        for (const editor of cases) {
            expect(resolveModeRule('document', editor), label('document', editor)).toEqual({
                setting: 'switch',
                initial: editor.default,
                segment: editor.segment.display ? editor.segment.position : null,
            });
        }
    });

    it('mount の mode (view、edit、switch) は文書の mode だけを上書きし、default と segment はいつも文書の指定 (B-183)', () => {
        for (const option of ['view', 'edit', 'switch'] as const) {
            for (const editor of allSettings()) expect(resolveModeRule(option, editor), label(option, editor)).toEqual(expectedRule(option, editor));
        }
    });

    it('上書きの例: 文書の edit を view で閲覧だけに、文書の switch を edit で GUI 編集だけに、既定の文書を switch で左上のセグメントつきにする (B-183)', () => {
        expect(resolveModeRule('view', frozen({ mode: 'edit', default: 'edit', segment: { display: true, position: 'top-right' } }))).toEqual({ setting: 'view', initial: 'view', segment: null });
        expect(resolveModeRule('edit', frozen({ mode: 'switch', default: 'view', segment: { display: true, position: 'bottom-center' } }))).toEqual({
            setting: 'edit',
            initial: 'edit',
            segment: null,
        });
        expect(resolveModeRule('switch', frozen(DEFAULT_SETTINGS))).toEqual({ setting: 'switch', initial: 'view', segment: 'top-left' });
        expect(resolveModeRule('switch', frozen({ mode: 'view', default: 'edit', segment: { display: false, position: 'bottom-right' } }))).toEqual({
            setting: 'switch',
            initial: 'edit',
            segment: null,
        });
    });
});

describe('文書の指定の比べ方 (sameEditorSettings)', () => {
    it('値が同じなら、別のオブジェクトでも欄の並びが違っても同じ (B-176。合わせ直さない)', () => {
        for (const editor of allSettings()) {
            const reordered: EditorSettings = { segment: { position: editor.segment.position, display: editor.segment.display }, default: editor.default, mode: editor.mode };
            expect(sameEditorSettings(editor, reordered), JSON.stringify(editor)).toBe(true);
            expect(sameEditorSettings(reordered, editor), JSON.stringify(editor)).toBe(true);
        }
    });

    it('mode、default、segment.display、segment.position のどれか 1 つでも違えば違う (B-176。合わせ直す)', () => {
        const all = allSettings();
        const equal = (a: EditorSettings, b: EditorSettings): boolean =>
            a.mode === b.mode && a.default === b.default && a.segment.display === b.segment.display && a.segment.position === b.segment.position;
        let differing = 0;
        for (const a of all) {
            for (const b of all) {
                expect(sameEditorSettings(a, b), `${JSON.stringify(a)} と ${JSON.stringify(b)}`).toBe(equal(a, b));
                if (!equal(a, b)) differing += 1;
            }
        }
        expect(differing).toBe(72 * 71);
    });
});

// EditorOptions のうち render から受け取る欄
type RenderKeys = 'theme' | 'animate' | 'injectStyle' | 'types' | 'icons' | 'resolveIcon' | 'hookRefs' | 'hooks' | 'onDiagnostic' | 'onHookError' | 'onFoldChange' | 'onTransform' | 'onLayout';
// EditorOptions と MarkdagEditor の欄の全部。これ以外の欄 (編集できる範囲、凡例の初めの開閉、モードの記憶、selectAtLine、getModeSetting) は持たない
type DesignedOptionKeys = RenderKeys | 'mode' | 'onChange' | 'onModeChange' | 'onSelectionChange';
type DesignedEditorKeys = 'view' | 'diagnostics' | 'getSource' | 'setSource' | 'getMode' | 'setMode' | 'getSelection' | 'undo' | 'redo' | 'setTheme' | 'fit' | 'destroy';

describe('入口 markdag/editor の形 (design.md 1.2)', () => {
    it('入口は mountEditor だけを出し、init を出さない (init は markdag/core の入口で待つ)', () => {
        expect(Object.keys(entry).sort()).toEqual(['mountEditor']);
        expect(typeof entry.mountEditor).toBe('function');
    });

    it('型: mountEditor の署名と、モードの型', () => {
        expectTypeOf(entry.mountEditor).toEqualTypeOf<(container: HTMLElement, markdown: string, options?: EditorOptions) => MarkdagEditor>();
        expectTypeOf<EditorMode>().toEqualTypeOf<'view' | 'edit'>();
        expectTypeOf<EditorModeOption>().toEqualTypeOf<'document' | 'view' | 'edit' | 'switch'>();
    });

    it('型: EditorOptions は設計の欄だけを持ち、編集できる範囲、凡例の初めの開閉、モードの記憶の欄がない (B-184〜B-186)', () => {
        expectTypeOf<Exclude<keyof EditorOptions, DesignedOptionKeys>>().toEqualTypeOf<never>();
        // render から受け取る欄は render と同じ型
        expectTypeOf<Pick<EditorOptions, RenderKeys>>().toEqualTypeOf<Pick<RenderOptions, RenderKeys>>();
        expectTypeOf<EditorOptions['mode']>().toEqualTypeOf<EditorModeOption | undefined>();
        expectTypeOf<EditorOptions['onChange']>().toEqualTypeOf<((markdown: string) => void) | undefined>();
        expectTypeOf<EditorOptions['onModeChange']>().toEqualTypeOf<((mode: EditorMode, byUser: boolean) => void) | undefined>();
        // どの欄も省ける
        expectTypeOf<Record<never, never>>().toExtend<EditorOptions>();
    });

    it('型: MarkdagEditor は設計のメソッドだけを持ち、selectAtLine と getModeSetting がない (10.1 の 1)', () => {
        expectTypeOf<Exclude<keyof MarkdagEditor, DesignedEditorKeys>>().toEqualTypeOf<never>();
        expectTypeOf<MarkdagEditor>().not.toHaveProperty('selectAtLine');
        expectTypeOf<MarkdagEditor>().not.toHaveProperty('getModeSetting');
        expectTypeOf<MarkdagEditor['view']>().toEqualTypeOf<MarkdagView>();
        expectTypeOf<MarkdagEditor['diagnostics']>().toEqualTypeOf<Diagnostic[]>();
        expectTypeOf<MarkdagEditor['getSource']>().toEqualTypeOf<() => string>();
        expectTypeOf<MarkdagEditor['setSource']>().toEqualTypeOf<(markdown: string) => Diagnostic[]>();
        expectTypeOf<MarkdagEditor['getMode']>().toEqualTypeOf<() => EditorMode>();
        expectTypeOf<MarkdagEditor['setMode']>().toEqualTypeOf<(mode: EditorMode) => boolean>();
        expectTypeOf<MarkdagEditor['setTheme']>().toEqualTypeOf<(theme: 'light' | 'dark') => void>();
        expectTypeOf<MarkdagEditor['fit']>().toEqualTypeOf<() => void>();
        expectTypeOf<MarkdagEditor['destroy']>().toEqualTypeOf<() => void>();
    });
});

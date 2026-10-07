// 入力とパネルの中のキーを操作に読み替える部品と、カラーピッカーの 16 進の読み方 (どれも DOM を使わない) を確かめる。
// 名前の入力 (ノード) は Enter で決め、足すキーの Enter (mac は ⌘Enter、win は Ctrl+Enter) と Shift+Enter で決めて兄弟を下に足し、
// 移るキーの Enter (mac は Ctrl+Enter、win は Alt+Enter) で決めて下の兄弟へ移り、Tab で決めて子、Shift+Tab で決めて親へ移り、Esc でやめる。
// グループの名前の入力は Enter で決め、Esc でやめ、Tab は何もしない。詳細の入力は Enter が改行、保存のキーの Enter (mac は ⌘Enter、
// win は Ctrl+Enter) で保存、Esc でやめる。
// タグのパネルは Enter で付け、Esc で閉じ、Tab はブラウザの既定。どの入力でも、変換中 (isComposing か keyCode 229) のキーは操作にしない。
// カラーピッカーの色は、よく使う 12 色と 16 進の入力。選べる色は、グループの色の書き換えがそのまま書ける
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';
import { COLOR_SWATCHES, parseHexColor } from '../src/editor/ui/color-picker';
import { detailsEditorAction } from '../src/editor/ui/details-editor';
import type { KeyPlatform } from '../src/editor/keys';
import { nameInputAction } from '../src/editor/ui/name-input';
import { tagPanelAction } from '../src/editor/ui/tag-panel';

interface Key {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    keyCode: number;
}

const KEY_CODES: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, a: 65, ArrowDown: 40, ' ': 32 };

function key(name: string, modifiers: Partial<Key> = {}): Key {
    return { key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, keyCode: KEY_CODES[name] ?? 0, ...modifiers };
}

// 変換中のキー: isComposing が true のものと、変換を確定したキーが確定のあとに届く形 (keyCode 229)
function composing(name: string): Key[] {
    return [key(name, { isComposing: true }), key(name, { keyCode: 229 }), key(name, { isComposing: true, keyCode: 229 })];
}

// 何もしない (操作にしない、か、キーの既定の動きだけを止める)
const IGNORED = [null, 'stay'];

// Enter の修飾キーの割り当ての区分。修飾キーのない Enter、Tab、Esc、文字は、どの区分でも同じ
const PLATFORMS: readonly KeyPlatform[] = ['mac', 'win'];

describe('名前の入力 (ノード) のキー (軸 D の名前の入力。B-027、B-029〜B-032)', () => {
    it('Enter は決める、Tab は決めて子、Shift+Tab は決めて親へ、Esc はやめる (mac と win で同じ)', () => {
        for (const platform of PLATFORMS) {
            expect(nameInputAction(key('Enter'), 'node', platform), platform).toBe('commit');
            expect(nameInputAction(key('Tab'), 'node', platform), platform).toBe('child');
            expect(nameInputAction(key('Tab', { shiftKey: true }), 'node', platform), platform).toBe('parent');
            expect(nameInputAction(key('Escape'), 'node', platform), platform).toBe('cancel');
        }
    });

    it('⌘Enter と Ctrl+Enter: mac は ⌘ で決めて兄弟を下に、Ctrl で決めて下の兄弟へ。win は Ctrl で決めて兄弟を下に、Windows キーは何もしない', () => {
        expect(nameInputAction(key('Enter', { metaKey: true }), 'node', 'mac')).toBe('sibling');
        expect(nameInputAction(key('Enter', { ctrlKey: true }), 'node', 'mac')).toBe('next');
        expect(nameInputAction(key('Enter', { ctrlKey: true }), 'node', 'win')).toBe('sibling');
        expect(IGNORED).toContain(nameInputAction(key('Enter', { metaKey: true }), 'node', 'win'));
    });

    it('文字、空白、矢印は入力欄に任せる', () => {
        for (const platform of PLATFORMS) for (const name of ['a', ' ', 'ArrowDown']) expect(nameInputAction(key(name), 'node', platform)).toBeNull();
    });

    it('変換中の Enter、Tab、Esc は操作にしない (B-15)', () => {
        for (const platform of PLATFORMS) {
            for (const name of ['Enter', 'Tab', 'Escape']) for (const input of composing(name)) expect(nameInputAction(input, 'node', platform), JSON.stringify(input)).toBeNull();
        }
    });
});

describe('グループの名前の入力のキー (軸 D のグループの名前の入力。B-161)', () => {
    it('Enter は決め、Esc はやめ、Tab と Shift+Tab は何もしない', () => {
        for (const platform of PLATFORMS) {
            expect(nameInputAction(key('Enter'), 'group', platform), platform).toBe('commit');
            expect(nameInputAction(key('Escape'), 'group', platform), platform).toBe('cancel');
            expect(IGNORED).toContain(nameInputAction(key('Tab'), 'group', platform));
            expect(IGNORED).toContain(nameInputAction(key('Tab', { shiftKey: true }), 'group', platform));
            expect(IGNORED).toContain(nameInputAction(key('Enter', { metaKey: true }), 'group', platform));
        }
    });

    it('変換中のキーは操作にしない', () => {
        for (const platform of PLATFORMS) {
            for (const name of ['Enter', 'Tab', 'Escape']) for (const input of composing(name)) expect(nameInputAction(input, 'group', platform), JSON.stringify(input)).toBeNull();
        }
    });
});

describe('詳細の入力のキー (軸 D の詳細の入力。B-119、B-120)', () => {
    it('保存のキーは OS で分ける: mac は ⌘Enter で保存し Ctrl+Enter は何もしない、win は Ctrl+Enter で保存し Windows キー+Enter は何もしない。Esc は保存せずにやめる', () => {
        expect(detailsEditorAction(key('Enter', { metaKey: true }), 'mac')).toBe('save');
        expect(IGNORED).toContain(detailsEditorAction(key('Enter', { ctrlKey: true }), 'mac'));
        expect(detailsEditorAction(key('Enter', { ctrlKey: true }), 'win')).toBe('save');
        expect(IGNORED).toContain(detailsEditorAction(key('Enter', { metaKey: true }), 'win'));
        for (const platform of PLATFORMS) expect(detailsEditorAction(key('Escape'), platform), platform).toBe('cancel');
    });

    it('Enter と Shift+Enter は改行 (テキストエリアに任せる)', () => {
        for (const platform of PLATFORMS) {
            expect(detailsEditorAction(key('Enter'), platform), platform).toBeNull();
            expect(detailsEditorAction(key('Enter', { shiftKey: true }), platform), platform).toBeNull();
        }
    });

    it('Tab と Shift+Tab は何もしない。文字と矢印はテキストエリアに任せる', () => {
        for (const platform of PLATFORMS) {
            expect(IGNORED).toContain(detailsEditorAction(key('Tab'), platform));
            expect(IGNORED).toContain(detailsEditorAction(key('Tab', { shiftKey: true }), platform));
            for (const name of ['a', ' ', 'ArrowDown']) expect(detailsEditorAction(key(name), platform)).toBeNull();
        }
    });

    it('変換中の ⌘Enter、Enter、Esc は操作にしない', () => {
        for (const platform of PLATFORMS) {
            for (const input of [...composing('Enter'), ...composing('Escape'), key('Enter', { metaKey: true, isComposing: true }), key('Enter', { ctrlKey: true, keyCode: 229 })]) {
                expect(detailsEditorAction(input, platform), JSON.stringify(input)).toBeNull();
            }
        }
    });
});

describe('タグのパネルのキー (軸 D のタグのパネル。B-132、B-133)', () => {
    it('Enter は付け、Esc は閉じる', () => {
        expect(tagPanelAction(key('Enter'))).toBe('submit');
        expect(tagPanelAction(key('Escape'))).toBe('close');
    });

    it('Tab はブラウザの既定 (パネルの中の欄とボタンを動く)。⌘Enter と文字は操作にしない', () => {
        expect(tagPanelAction(key('Tab'))).toBeNull();
        expect(tagPanelAction(key('Tab', { shiftKey: true }))).toBeNull();
        expect(tagPanelAction(key('Enter', { metaKey: true }))).toBeNull();
        for (const name of ['a', ' ', 'ArrowDown']) expect(tagPanelAction(key(name))).toBeNull();
    });

    it('変換中の Enter と Esc は操作にしない', () => {
        for (const input of [...composing('Enter'), ...composing('Escape')]) expect(tagPanelAction(input), JSON.stringify(input)).toBeNull();
    });
});

const DEFINED = '---\nmarkdag:\n    groups:\n        g:\n            label: G\n---\n# R\n- a %g\n';

function writtenColor(color: string): string | null {
    const outcome = core.editSource(DEFINED, { kind: 'setGroupColor', group: 'g', color });
    if (outcome.status !== 'edited') return null;
    const line = outcome.source.split('\n').find((text) => text.trimStart().startsWith('color:'));
    return line?.trim() ?? null;
}

describe('カラーピッカーの色 (B-159、B-160)', () => {
    it('よく使う色は 12 色で、重ならず、どれも 6 桁の 16 進', () => {
        expect(COLOR_SWATCHES).toHaveLength(12);
        expect(new Set(COLOR_SWATCHES).size).toBe(12);
        for (const color of COLOR_SWATCHES) expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('16 進の入力は 3 桁と 6 桁を # 付きの色にする', () => {
        expect(parseHexColor('#3B7DD8')).toBe('#3B7DD8');
        expect(parseHexColor('#abc')).toBe('#abc');
        for (const color of COLOR_SWATCHES) expect(parseHexColor(color)).toBe(color);
    });

    it('16 進で読めない入力は null', () => {
        for (const text of ['', '#', '#12', '#12345', '#1234567', '#ggg', 'red', '# 123456']) expect(parseHexColor(text), text).toBeNull();
    });

    it('よく使う色と 16 進の入力で決めた色は、グループの色として引用符で囲んでそのまま書ける (design 4.6)', () => {
        const picked = [...COLOR_SWATCHES, '#abc', 'abc', '#ABCDEF', ' #123456 '].map((text) => parseHexColor(text)).filter((color): color is string => color !== null);
        expect(picked.length).toBeGreaterThanOrEqual(13);
        for (const color of picked) expect(writtenColor(color), color).toBe(`color: "${color}"`);
    });
});

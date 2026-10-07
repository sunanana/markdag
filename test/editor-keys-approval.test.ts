// GUI 編集のキーの手直しで、例の承認 (2026-10-06) に依頼者が今の作りと違う答えをした挙動のうち、キーの読み分け (DOM を使わない部品) を、
// 直す前に落ちるテストとして書く。期待は決まった挙動から書く。
// - S-15: Shift を押している間の Space は、押す順によらずタスクの印を進めない。Space を先に押してから Shift を押したとき
//   (S-14。押している間のほかのキーで止める) は今のまま。
//   道具の部品が「押して離す押し方」を持つので、Space を押したときの修飾キーを道具に渡す形を約束にする:
//       Tools.holdSpace(input?: { shiftKey: boolean })   Shift を押したまま押した Space は、離しても押して離す押し方にしない
//   (input を渡さない呼び出しは今までどおり Shift なしと同じ)
// - S-20: 詳細の入力の保存も OS の区分で分ける。mac は ⌘Enter だけ、win は Ctrl+Enter だけ。保存にならない方の修飾キーの Enter は
//   何もしない (操作にしないか、既定の動きだけを止める)。区分は名前の入力 (nameInputAction) と同じく呼ぶ側が渡す形を約束にする:
//       detailsEditorAction(input, platform: KeyPlatform)
// 今の部品の型は引数を受けないので、約束の形の関数の型で呼ぶ (型の検査は直したあとの形でも通る)
import { describe, expect, it } from 'vitest';
import type { KeyPlatform } from '../src/editor/keys';
import { Tools } from '../src/editor/tools';
import { detailsEditorAction, type DetailsEditorAction } from '../src/editor/ui/details-editor';

interface SpaceInput {
    shiftKey: boolean;
}

interface Key {
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    keyCode: number;
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27 };

function key(name: string, modifiers: Partial<Key> = {}): Key {
    return { key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, keyCode: KEY_CODES[name] ?? 0, ...modifiers };
}

// 約束の形 (区分を受ける) の詳細の入力のキーの読み分け
const detailsAction = detailsEditorAction as unknown as (input: Key, platform: KeyPlatform) => DetailsEditorAction | null;

// 何もしない (操作にしない、か、キーの既定の動きだけを止める)
const IGNORED = [null, 'stay'];

const PLATFORMS: readonly KeyPlatform[] = ['mac', 'win'];

// Space の押し方を道具に通し、離したときに押して離す押し方だったか (タスクの印を進めるか) を返す
function tapped(steps: (tools: Tools, hold: (input?: SpaceInput) => void) => void): boolean {
    const tools = new Tools(() => {});
    const hold = (tools.holdSpace as unknown as (input?: SpaceInput) => void).bind(tools);
    steps(tools, hold);
    return tools.releaseSpace();
}

describe('S-15: Shift を押している間の Space は、押す順によらずタスクの印を進めない', () => {
    it('Shift を押したまま押した Space は、離しても押して離す押し方にならない', () => {
        expect(tapped((_, hold) => hold({ shiftKey: true }))).toBe(false);
    });

    it('Shift を押したまま押し続けた Space (キーの繰り返しの押下) も同じ', () => {
        expect(
            tapped((_, hold) => {
                hold({ shiftKey: true });
                hold({ shiftKey: true });
            }),
        ).toBe(false);
    });

    it('今のまま: Shift なしで押して離せば押して離す押し方 (input を渡さない呼び出しも同じ)', () => {
        expect(tapped((_, hold) => hold({ shiftKey: false }))).toBe(true);
        expect(tapped((_, hold) => hold())).toBe(true);
    });

    it('今のまま (S-14): Space を先に押してから Shift などのほかのキーを押したら、離しても押して離す押し方にならない', () => {
        expect(
            tapped((tools, hold) => {
                hold({ shiftKey: false });
                tools.interruptSpace();
            }),
        ).toBe(false);
    });

    it('Shift つきで押して離したあと、Shift なしで押し直せば押して離す押し方になる (前の押し方を持ち越さない)', () => {
        const tools = new Tools(() => {});
        const hold = (tools.holdSpace as unknown as (input?: SpaceInput) => void).bind(tools);
        hold({ shiftKey: true });
        expect(tools.releaseSpace()).toBe(false);
        hold({ shiftKey: false });
        expect(tools.releaseSpace()).toBe(true);
    });
});

describe('S-20: 詳細の入力の保存のキーを OS の区分で分ける (mac は ⌘Enter だけ、win は Ctrl+Enter だけ)', () => {
    it('mac は ⌘Enter で保存し、Ctrl+Enter は何もしない', () => {
        expect(detailsAction(key('Enter', { metaKey: true }), 'mac')).toBe('save');
        expect(IGNORED).toContain(detailsAction(key('Enter', { ctrlKey: true }), 'mac'));
    });

    it('win は Ctrl+Enter で保存し、Windows キー+Enter は何もしない', () => {
        expect(detailsAction(key('Enter', { ctrlKey: true }), 'win')).toBe('save');
        expect(IGNORED).toContain(detailsAction(key('Enter', { metaKey: true }), 'win'));
    });

    it('保存のキーのほかに修飾キーを押した Enter (mac の ⌘Ctrl+Enter、win の Ctrl+Windows キー+Enter と Ctrl+Alt+Enter) は保存しない', () => {
        expect(IGNORED).toContain(detailsAction(key('Enter', { metaKey: true, ctrlKey: true }), 'mac'));
        expect(IGNORED).toContain(detailsAction(key('Enter', { metaKey: true, altKey: true }), 'mac'));
        expect(IGNORED).toContain(detailsAction(key('Enter', { ctrlKey: true, metaKey: true }), 'win'));
        expect(IGNORED).toContain(detailsAction(key('Enter', { ctrlKey: true, altKey: true }), 'win'));
    });

    it('今のまま: Enter と Shift+Enter は改行 (テキストエリアに任せる)、Esc はやめる、変換中の保存のキーは操作にしない (mac と win で同じ)', () => {
        for (const platform of PLATFORMS) {
            expect(detailsAction(key('Enter'), platform), platform).toBeNull();
            expect(detailsAction(key('Enter', { shiftKey: true }), platform), platform).toBeNull();
            expect(detailsAction(key('Escape'), platform), platform).toBe('cancel');
            expect(detailsAction(key('Enter', { metaKey: true, isComposing: true }), platform), platform).toBeNull();
            expect(detailsAction(key('Enter', { ctrlKey: true, keyCode: 229 }), platform), platform).toBeNull();
        }
    });
});

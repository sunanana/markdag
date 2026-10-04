// 図のキーと命令の表 (DOM を使わない)。押されたキーと修飾キーから、編集の層の命令を引く。
// キーを受けるかの判定 (フォーカスとポインタの位置) と、Space を押している間のパンは表の外で受け持つ。
// ⌘ と Ctrl は同じに扱い (OS で分けない)、文字は大文字と小文字を区別しない (CapsLock で Shift なしの大文字が来るため)
import type { ArrowKey } from './navigation';

export interface KeyInput {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

// cancel は選択を解く。rename は選んだノードの名前の入力を開き、add-child は選んだノードに子を足す。delete は選んだノードを配下ごと消す。
// join は選んだノードから新しいノードへ合流させる。group は選んだノードをグループにまとめる (ブラウザの検索より先に受ける)。
// details は選んだノードの詳細の入力を開く。tag-add は選んだノードのタグ追加のパネルを開く。
// hand と select はその道具に替える (名前は道具と同じ)。
// 矢印キーは選ぶノードを移す命令で、名前はキーと同じ (どこへ移すかは並びの部品が決める)
export type KeyCommand = 'undo' | 'redo' | 'cancel' | 'rename' | 'add-child' | 'delete' | 'join' | 'group' | 'details' | 'tag-add' | 'hand' | 'select' | ArrowKey;

const ARROW_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] satisfies readonly ArrowKey[];

// 変換中 (IME) のキーか。isComposing が true か keyCode が 229 のキー (変換を確定したキーが確定のあとに届く形を含む)。
// 変換中のキーはどの操作にもせず、入力欄に任せる
export function isComposingKey(input: { isComposing: boolean; keyCode: number }): boolean {
    return input.isComposing || input.keyCode === 229;
}

// 命令にならないキーは null
export function commandForKey(input: KeyInput): KeyCommand | null {
    if (input.altKey) return null;
    if (!(input.metaKey || input.ctrlKey)) {
        if (input.key === 'Escape') return 'cancel';
        // Shift+Enter と Shift+Tab は命令にしない (Shift+Tab で兄弟を足すのは名前の入力の中だけ)
        if (input.key === 'Enter') return input.shiftKey ? null : 'rename';
        if (input.key === 'Tab') return input.shiftKey ? null : 'add-child';
        if (input.key === 'Delete' || input.key === 'Backspace') return 'delete';
        if (input.key.toLowerCase() === 'j') return 'join';
        if (input.key.toLowerCase() === 'd') return 'details';
        if (input.key.toLowerCase() === 't') return 'tag-add';
        if (input.key.toLowerCase() === 'h') return 'hand';
        if (input.key.toLowerCase() === 'v') return 'select';
        return ARROW_KEYS.includes(input.key) ? (input.key as ArrowKey) : null;
    }
    const key = input.key.toLowerCase();
    if (key === 'z') return input.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !input.shiftKey) return 'redo';
    if (key === 'g' && !input.shiftKey) return 'group';
    return null;
}

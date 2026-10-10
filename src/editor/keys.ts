// 図のキーと命令の表 (DOM を使わない)。押されたキーと修飾キーから、編集の層の命令を引く。
// キーを受けるかの判定 (フォーカスとポインタの位置) と、Space を押している間のパンと、押して離したときのタスクの印は表の外で受け持つ。
// ⌘ と Ctrl は同じに扱い、文字は大文字と小文字を区別しない (CapsLock で Shift なしの大文字が来るため)。
// Enter の修飾キーだけは OS の区分 (mac と win) で役を分ける (兄弟を足すキーと兄弟へ移るキー)。区分は呼ぶ側が渡す
import type { ArrowKey } from './navigation';

export interface KeyInput {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

// Enter の修飾キーの割り当ての区分。mac は macOS と iOS、win はそのほか (Windows、Linux など)
export type KeyPlatform = 'mac' | 'win';

// Enter の修飾キーの役。plain は修飾キーなし (Shift は数えない)、add は兄弟を足すキー (mac は ⌘、win は Ctrl)、
// step は兄弟へ移るキー (mac は Ctrl、win は Alt)
export type EnterRole = 'plain' | 'add' | 'step';

// cancel は選択を解く。rename は選んだノードの名前の入力を開き、add-child は選んだノードに子を足す。
// add-sibling と add-sibling-before は選んだノードの兄弟を下 (あと) と上 (前) に足し、rename-parent、rename-previous、rename-next は
// 親、書いた順で 1 つ上の兄弟、1 つ下の兄弟を選んでその名前の入力を開く。delete は選んだノードを配下ごと消す。
// join は選んだノードから新しいノードへ合流させる。group は選んだノードをグループにまとめる (ブラウザの検索より先に受ける)。
// details は選んだノードの詳細の入力を開く。tag-add は選んだノードのタグ追加のパネルを開く。
// task は選んだノードのタスク化か解除 (Shift つきは命令にしない)。
// hand と select はその道具に替える (名前は道具と同じ)。
// 矢印キーは選ぶノードを移す命令で、名前はキーと同じ (どこへ移すかは並びの部品が決める)
export type KeyCommand = 'undo' | 'redo' | 'cancel' | 'rename' | 'add-child' | 'add-sibling' | 'add-sibling-before' | 'rename-parent' | 'rename-previous' | 'rename-next' | 'delete' | 'join' | 'group' | 'details' | 'tag-add' | 'task' | 'hand' | 'select' | ArrowKey;

const ARROW_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] satisfies readonly ArrowKey[];

type ModifierKey = 'metaKey' | 'ctrlKey' | 'altKey';

const MODIFIER_KEYS: readonly ModifierKey[] = ['metaKey', 'ctrlKey', 'altKey'];

// 区分ごとの、兄弟を足すキーと兄弟へ移るキー。残りの 1 つ (mac の ⌥、win の Windows キー) は Enter と押しても何もしない
const ENTER_ROLES: Record<KeyPlatform, Record<'add' | 'step', ModifierKey>> = {
    mac: { add: 'metaKey', step: 'ctrlKey' },
    win: { add: 'ctrlKey', step: 'altKey' },
};

// 変換中 (IME) のキーか。isComposing が true か keyCode が 229 のキー (変換を確定したキーが確定のあとに届く形を含む)。
// 変換中のキーはどの操作にもせず、入力欄に任せる
export function isComposingKey(input: { isComposing: boolean; keyCode: number }): boolean {
    return input.isComposing || input.keyCode === 229;
}

// Enter と押した修飾キーの役。使わない修飾キー (mac の ⌥、win の Windows キー) と、修飾キーを 2 つ以上 (Shift は数えない) 押したものは null
export function enterRole(input: KeyInput, platform: KeyPlatform): EnterRole | null {
    const pressed = MODIFIER_KEYS.filter((name) => input[name]);
    const [only] = pressed;
    if (only === undefined) return 'plain';
    if (pressed.length > 1) return null;
    const roles = ENTER_ROLES[platform];
    return only === roles.add ? 'add' : only === roles.step ? 'step' : null;
}

// 選んでいるときの Enter の命令。Shift で上向き (上に足す、上の兄弟へ)。修飾キーなしの Shift+Enter は下に足す
function enterCommand(role: EnterRole | null, shift: boolean): KeyCommand | null {
    if (role === 'plain') return shift ? 'add-sibling' : 'rename';
    if (role === 'add') return shift ? 'add-sibling-before' : 'add-sibling';
    if (role === 'step') return shift ? 'rename-previous' : 'rename-next';
    return null;
}

// 命令にならないキーは null。platform は Enter の修飾キーの役だけに使う (ほかのキーは OS によらない)
export function commandForKey(input: KeyInput, platform: KeyPlatform): KeyCommand | null {
    // Enter は修飾キーの役で読む (win の移るキーは Alt なので、Alt つきのキーを捨てる前に読む)
    if (input.key === 'Enter') return enterCommand(enterRole(input, platform), input.shiftKey);
    if (input.altKey) return null;
    if (!(input.metaKey || input.ctrlKey)) {
        if (input.key === 'Escape') return 'cancel';
        if (input.key === 'Tab') return input.shiftKey ? 'rename-parent' : 'add-child';
        if (input.key === 'Delete' || input.key === 'Backspace') return 'delete';
        if (input.key.toLowerCase() === 'j') return 'join';
        if (input.key.toLowerCase() === 'd') return 'details';
        if (input.key.toLowerCase() === 't') return 'tag-add';
        if (input.key.toLowerCase() === 'x') return input.shiftKey ? null : 'task';
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

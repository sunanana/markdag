// 図の下の操作の案内。今の道具と選んでいるもので使える操作とキーを 1 行で出す (手のひらでは選んでいるものによらず道具の案内)。
// 合流先を選ぶ途中は、もとの道具によらずその案内を出す。
// 名前の入力 (ノードかグループ)、詳細の入力、タグのパネルが開いている間は、道具によらず入力の中のキーの案内を出す。
// Enter の修飾キー (兄弟を足すキーと兄弟へ移るキー、詳細の入力の保存のキー) は、OS の区分 (mac か win) の割り当てだけを出す。
// キーの名前はキーの見た目の要素に入れ、文は文字として入れる (文字列の HTML を差し込まない)
import type { KeyPlatform } from '../keys';
import type { ToolState } from '../tools';
import type { NameInputFor } from './name-input';

// OS の区分ごとのキーの名前
type KeyNames = Readonly<Record<KeyPlatform, string>>;

// 案内の 1 つ分。文字列はそのまま、key はキーの名前として出し、keys はその区分のキーの名前を出す
type HintPart = string | { key: string } | { keys: KeyNames };

// 兄弟を下に足す (詳細の入力では保存する)、上に足す、下の兄弟へ移る、上の兄弟へ移る Enter
const ADD_ENTER: KeyNames = { mac: '⌘Enter', win: 'Ctrl+Enter' };
const ADD_BEFORE_ENTER: KeyNames = { mac: 'Shift+⌘Enter', win: 'Shift+Ctrl+Enter' };
const NEXT_ENTER: KeyNames = { mac: 'Ctrl+Enter', win: 'Alt+Enter' };
const PREVIOUS_ENTER: KeyNames = { mac: 'Shift+Ctrl+Enter', win: 'Shift+Alt+Enter' };

// 選んでいるもの: なし、ノード 1 つ、ノード 2 つ以上、線、グループ 1 つ、グループ 2 つ以上
export type HintSelection = 'none' | 'node' | 'nodes' | 'edge' | 'group' | 'groups';

// 開いている入力: 名前の入力 (ノードかグループ)、詳細の入力、タグのパネル (タグ追加かタグ選択)
export type HintInput = NameInputFor | 'details' | 'tag-add' | 'tag-select';

const HAND: readonly HintPart[] = ['手のひら: ドラッグで画面を動かす / ホイールで拡大縮小 ', { key: 'V' }, ' で選択に切り替える'];

const SELECT: Record<HintSelection, readonly HintPart[]> = {
    none: ['何もないところからドラッグで範囲選択 / ', { key: 'Space' }, '+ドラッグで図を動かす ', { key: 'H' }, ' 手のひらに切り替える'],
    node: [
        { key: 'Enter' },
        ' 名前 ',
        { keys: ADD_ENTER },
        '/',
        { key: 'Shift+Enter' },
        ' 兄弟を下に足す ',
        { keys: ADD_BEFORE_ENTER },
        ' 兄弟を上に足す ',
        { key: 'Tab' },
        ' 子を足す ',
        { keys: NEXT_ENTER },
        '/',
        { keys: PREVIOUS_ENTER },
        ' 下 / 上の兄弟の名前へ ',
        { key: 'Shift+Tab' },
        ' 親の名前へ ',
        { key: 'Space' },
        ' タスクを進める ',
        { key: 'D' },
        ' 詳細 ',
        { key: 'T' },
        ' タグ ',
        { key: 'Del' },
        ' 削除 ',
        { key: '←' },
        { key: '→' },
        { key: '↑' },
        { key: '↓' },
        ' 選ぶノードを移す ',
        { key: 'Esc' },
        ' 選択を解く / 右と下の + で子と兄弟を足す / ドラッグでほかのノードの下へ / 右下の点をほかのノードへドラッグで線を引く / 何もないところからドラッグで囲んで複数選ぶ',
    ],
    nodes: [
        { key: 'J' },
        ' 合流ノードを作る ',
        { key: '⌘G' },
        '/',
        { key: 'Ctrl+G' },
        ' グループにまとめる ',
        { key: 'T' },
        ' タグ ',
        { key: 'Space' },
        ' タスクを進める ',
        { key: 'Shift' },
        '+クリックで 1 つずつ足す・外す ',
        { key: 'Del' },
        ' 削除 ',
        { key: 'Esc' },
        ' 選択を解く / 右の点をほかのノードへドラッグでそこへ合流',
    ],
    edge: [{ key: 'Esc' }, ' 選択を解く / 同じ線をもう 1 度押しても解ける'],
    group: [
        { key: 'Enter' },
        ' 名前 ',
        { key: 'Esc' },
        ' 選択を解く / 枠のラベルをダブルクリックでも名前を変えられる / 同じ枠をもう 1 度押しても解ける / ',
        { key: 'Shift' },
        '+クリックでほかのグループを足す',
    ],
    groups: [{ key: 'Shift' }, '+クリックでグループを足す・外す ', { key: 'Esc' }, ' 選択を解く / 枠を押すとそのグループだけを選ぶ'],
};

const JOIN_TARGET: readonly HintPart[] = ['合流させる先のノードをクリック ', { key: 'Esc' }, ' でやめる / 何もないところを押してもやめる'];

const INPUTS: Record<HintInput, readonly HintPart[]> = {
    node: [
        { key: 'Enter' },
        ' 決める ',
        { keys: ADD_ENTER },
        '/',
        { key: 'Shift+Enter' },
        ' 決めて兄弟を下に足す ',
        { keys: ADD_BEFORE_ENTER },
        ' 決めて兄弟を上に足す ',
        { key: 'Tab' },
        ' 決めて子を足す ',
        { keys: NEXT_ENTER },
        '/',
        { keys: PREVIOUS_ENTER },
        ' 決めて下 / 上の兄弟へ ',
        { key: 'Shift+Tab' },
        ' 決めて親へ ',
        { key: 'Esc' },
        ' やめる',
    ],
    group: [{ key: 'Enter' }, ' 決める ', { key: 'Esc' }, ' やめる'],
    details: [{ keys: ADD_ENTER }, ' 保存 ', { key: 'Esc' }, ' やめる ', { key: 'Enter' }, ' 改行 / 外を押しても保存'],
    'tag-add': [{ key: 'Enter' }, ' 付ける ', { key: 'Tab' }, ' 欄を移る ', { key: 'Esc' }, ' 閉じる / 付いているタグを押すと編集、× で外す'],
    'tag-select': ['行を押すたびに付け外し / 文字を入れて絞り込む ', { key: 'Esc' }, ' 閉じる'],
};

export class Hint {
    readonly element: HTMLDivElement;
    private shown: readonly HintPart[] | null = null;

    // platform は、Enter の修飾キーを出す OS の区分
    constructor(private readonly platform: KeyPlatform) {
        this.element = document.createElement('div');
        this.element.className = 'mdag-editor-hint';
    }

    // input は開いている入力 (開いていなければ null)
    show(tool: ToolState, selection: HintSelection, input: HintInput | null = null): void {
        const parts = input !== null ? INPUTS[input] : tool === 'join-target' ? JOIN_TARGET : tool === 'hand' ? HAND : SELECT[selection];
        if (parts === this.shown) return;
        this.shown = parts;
        this.element.replaceChildren(
            ...parts.map((part) => {
                if (typeof part === 'string') return document.createTextNode(part);
                const key = document.createElement('kbd');
                key.textContent = 'key' in part ? part.key : part.keys[this.platform];
                return key;
            }),
        );
    }
}

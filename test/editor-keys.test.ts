// 図のキーと命令の表 (DOM を使わない部品) を確かめる。
// 元に戻す / やり直す (⌘Z、⌘Shift+Z、⌘Y と Ctrl の同じキー) と、入れないキー (F、C、L) を見る。
// ほかの操作のキー (選択、名前、追加、削除、合流、グループ、詳細、タグ、道具の H と V、矢印) は e2e で確かめる。
// 部品の形 (このテストが確かめる約束):
//     interface KeyInput { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
//         KeyboardEvent をそのまま渡せる形
//     type KeyPlatform = 'mac' | 'win'
//         Enter の修飾キーの割り当ての区分。mac は macOS と iOS、win はそのほか
//     commandForKey(input: KeyInput, platform: KeyPlatform): KeyCommand | null
//         命令にならないキーは null。KeyCommand は少なくとも 'undo' と 'redo' を持つ (ほかの命令はここでは並べない)。
//         platform は Enter の修飾キーの役だけに使い、ここで見るキーは mac と win で同じ
// キーを受けるかの判定 (フォーカスとポインタ) と、Space を押している間のパンは表の外 (e2e で確かめる)
import { describe, expect, expectTypeOf, it } from 'vitest';
import { commandForKey, type KeyCommand, type KeyInput, type KeyPlatform } from '../src/editor/keys';

type Modifiers = Partial<Omit<KeyInput, 'key'>>;

// 表が入力を書き換えないよう、凍らせて渡す
const input = (key: string, modifiers: Modifiers = {}): KeyInput => Object.freeze({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

const label = (key: string, modifiers: Modifiers): string =>
    [...Object.entries(modifiers).flatMap(([name, on]) => (on ? [name.replace('Key', '')] : [])), JSON.stringify(key)].join('+');

// ⌘ と Ctrl のどちらでも同じ (OS で分けない)
const COMMAND_MODIFIERS: Modifiers[] = [{ metaKey: true }, { ctrlKey: true }];

// Enter のほかのキーは OS の区分によらないので、どの区分でも同じ答えを見る
const PLATFORMS: readonly KeyPlatform[] = ['mac', 'win'];

describe('キーと命令の表', () => {
    it('⌘Z と Ctrl+Z は元に戻す。key の大文字と小文字によらない (CapsLock では Shift なしで "Z" が来る) (B-008)', () => {
        for (const platform of PLATFORMS) {
            for (const modifiers of COMMAND_MODIFIERS) {
                for (const key of ['z', 'Z']) expect(commandForKey(input(key, modifiers), platform), `${platform} ${label(key, modifiers)}`).toBe('undo');
            }
        }
    });

    it('⌘⇧Z と Ctrl+Shift+Z はやり直す。key の大文字と小文字によらない (B-009)', () => {
        for (const platform of PLATFORMS) {
            for (const base of COMMAND_MODIFIERS) {
                const modifiers = { ...base, shiftKey: true };
                for (const key of ['z', 'Z']) expect(commandForKey(input(key, modifiers), platform), `${platform} ${label(key, modifiers)}`).toBe('redo');
            }
        }
    });

    it('⌘Y と Ctrl+Y もやり直す (10.2 の B-009)', () => {
        for (const platform of PLATFORMS) {
            for (const modifiers of COMMAND_MODIFIERS) {
                for (const key of ['y', 'Y']) expect(commandForKey(input(key, modifiers), platform), `${platform} ${label(key, modifiers)}`).toBe('redo');
            }
        }
    });

    it('⌘ も Ctrl もない Z と Y は、Shift つきでも命令にならない', () => {
        for (const platform of PLATFORMS) {
            for (const modifiers of [{}, { shiftKey: true }]) {
                for (const key of ['z', 'Z', 'y', 'Y']) expect(commandForKey(input(key, modifiers), platform), `${platform} ${label(key, modifiers)}`).toBeNull();
            }
        }
    });

    it('N、C、L、F は命令にならない。ノードを足す道具と線を引く道具は作らず、F のズームリセットのキーは入れない (B-092、B-093、10.1 の 1)', () => {
        for (const platform of PLATFORMS) {
            for (const modifiers of [{}, { shiftKey: true }]) {
                for (const key of ['n', 'N', 'c', 'C', 'l', 'L', 'f', 'F']) expect(commandForKey(input(key, modifiers), platform), `${platform} ${label(key, modifiers)}`).toBeNull();
            }
        }
    });

    it('型: KeyboardEvent をそのまま渡せ、戻り値は命令か null。命令に undo と redo がある', () => {
        expectTypeOf<KeyboardEvent>().toExtend<KeyInput>();
        expectTypeOf(commandForKey).parameters.toEqualTypeOf<[KeyInput, KeyPlatform]>();
        expectTypeOf(commandForKey).returns.toEqualTypeOf<KeyCommand | null>();
        expectTypeOf<'undo' | 'redo'>().toExtend<KeyCommand>();
    });
});

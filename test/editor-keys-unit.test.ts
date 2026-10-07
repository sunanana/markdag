// GUI 編集のキーの手直しの、DOM を使わない部品の単体テスト。期待は spec.md の「決まったキー」「挙動の細部」「例の承認で決めたこと」から書き、
// 部品の中身はなぞらない。ほかのファイルが見ている所は重ねない (Shift を押したままの Space と詳細の入力の保存のキーは editor-keys-approval、
// Enter のほかのキーの ⌘ と Ctrl は editor-keys、名前の入力の Enter と Tab の基本は editor-input-keys)。
// - 選択中の Enter (commandForKey) と名前の入力の Enter (nameInputAction) の、mac と win の表の全部 (Shift つき、使わない修飾キー、2 つ以上の修飾キー)
// - グループの名前の入力の Enter (修飾キーつきは全部 stay)
// - OS の判定 (isApplePlatform。navigator.platform だけを見る)
// - 移る先 (outlineTarget。書いた順の親と上下の兄弟、端では回らない) と、飛ばす相手 (名前を持たないリストの入れ物) の見分けに使う種類
// - Space の押して離す (Tools。ポインタの押下、キーの繰り返し、合流先を選ぶ途中)
// - まとめて進める (render の橋渡しの toggleTasks。relations の上流から確かめ (関係のないもの同士は文書の順。K-003)、全部通れば 1 回だけ書き換え、
//   1 つでも断られたらそこで確かめをやめて書き換えない (K-006))
// DOM の層 (mount のキーの振り分けと OS の判定の当て方、render の書き換えと onChange、名前の入力中の移る操作の順) は e2e が受け持つ
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '../src/core';
import { createRenderBridge } from '../src/bridge';
import { commandForKey, enterRole, type KeyCommand, type KeyInput, type KeyPlatform } from '../src/editor/keys';
import { outlineTarget, type OutlineStep } from '../src/editor/navigation';
import { isApplePlatform } from '../src/editor/pointer';
import { Tools } from '../src/editor/tools';
import { nameInputAction, type NameInputAction } from '../src/editor/ui/name-input';
import type { HookModule } from '../src/model/hooks';
import { buildModel } from '../src/model/model';
import { parseDocument, type OutlineNode } from '../src/parse/document';

type Modifiers = Partial<Omit<KeyInput, 'key'>>;

const input = (key: string, modifiers: Modifiers = {}): KeyInput => Object.freeze({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

// 名前の入力のキー (変換中でない)
const typed = (key: string, modifiers: Modifiers = {}) => ({ ...input(key, modifiers), isComposing: false, keyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : 0 });

const label = (modifiers: Modifiers): string => Object.entries(modifiers).flatMap(([name, on]) => (on ? [name.replace('Key', '')] : [])).join('+') || 'なし';

const PLATFORMS: readonly KeyPlatform[] = ['mac', 'win'];

// 区分ごとの、足すキー、移るキー、使わないキー (spec.md の「修飾キーの役」)
const ROLES: Record<KeyPlatform, { add: Modifiers; step: Modifiers; unused: Modifiers }> = {
    mac: { add: { metaKey: true }, step: { ctrlKey: true }, unused: { altKey: true } },
    win: { add: { ctrlKey: true }, step: { altKey: true }, unused: { metaKey: true } },
};

// 修飾キーを 2 つ以上押したもの (⌘ / Windows キー、Ctrl、⌥ / Alt のうち 2 つ以上。Shift は数えない)
const TWO_OR_MORE: readonly Modifiers[] = [
    { metaKey: true, ctrlKey: true },
    { metaKey: true, altKey: true },
    { ctrlKey: true, altKey: true },
    { metaKey: true, ctrlKey: true, altKey: true },
];

describe('選択中の Enter (commandForKey): spec.md の「ノードを 1 つ選んでいるとき」の表', () => {
    // [修飾キー, Shift なし, Shift つき]
    const table = (platform: KeyPlatform): Array<[string, Modifiers, KeyCommand | null, KeyCommand | null]> => [
        ['修飾キーなし', {}, 'rename', 'add-sibling'],
        ['足すキー', ROLES[platform].add, 'add-sibling', 'add-sibling-before'],
        ['移るキー', ROLES[platform].step, 'rename-next', 'rename-previous'],
        ['使わないキー', ROLES[platform].unused, null, null],
    ];

    for (const platform of PLATFORMS) {
        it(`${platform}: Enter は名前の入力、足すキーは兄弟を下 (Shift で上) に足す、移るキーは下 (Shift で上) の兄弟へ、使わないキーは何もしない`, () => {
            for (const [name, modifiers, plain, shifted] of table(platform)) {
                expect(commandForKey(input('Enter', modifiers), platform), `${platform} ${name}+Enter`).toBe(plain);
                expect(commandForKey(input('Enter', { ...modifiers, shiftKey: true }), platform), `${platform} Shift+${name}+Enter`).toBe(shifted);
            }
        });

        it(`${platform}: 修飾キーを 2 つ以上押した Enter は、Shift のあるなしによらず何もしない`, () => {
            for (const modifiers of TWO_OR_MORE) {
                expect(commandForKey(input('Enter', modifiers), platform), `${platform} ${label(modifiers)}`).toBeNull();
                expect(commandForKey(input('Enter', { ...modifiers, shiftKey: true }), platform), `${platform} Shift+${label(modifiers)}`).toBeNull();
            }
        });
    }

    it('mac の ⌘Enter と win の Ctrl+Enter は同じ役 (足す)、mac の Ctrl+Enter と win の Alt+Enter は同じ役 (移る)。区分が違えば同じキーでも役が違う', () => {
        expect(commandForKey(input('Enter', { ctrlKey: true }), 'mac')).toBe('rename-next');
        expect(commandForKey(input('Enter', { ctrlKey: true }), 'win')).toBe('add-sibling');
        expect(commandForKey(input('Enter', { metaKey: true }), 'mac')).toBe('add-sibling');
        expect(commandForKey(input('Enter', { metaKey: true }), 'win')).toBeNull();
        expect(commandForKey(input('Enter', { altKey: true }), 'mac')).toBeNull();
        expect(commandForKey(input('Enter', { altKey: true }), 'win')).toBe('rename-next');
    });

    it('enterRole: 修飾キーの役を区分ごとに読む (Shift は数えない)', () => {
        for (const platform of PLATFORMS) {
            expect(enterRole(input('Enter'), platform)).toBe('plain');
            expect(enterRole(input('Enter', { shiftKey: true }), platform)).toBe('plain');
            expect(enterRole(input('Enter', ROLES[platform].add), platform)).toBe('add');
            expect(enterRole(input('Enter', { ...ROLES[platform].step, shiftKey: true }), platform)).toBe('step');
            expect(enterRole(input('Enter', ROLES[platform].unused), platform)).toBeNull();
            for (const modifiers of TWO_OR_MORE) expect(enterRole(input('Enter', modifiers), platform), `${platform} ${label(modifiers)}`).toBeNull();
        }
    });
});

describe('選択中の Tab と、Enter のほかのキー', () => {
    it('Tab は子を足し、Shift+Tab は親の名前の入力へ (mac と win で同じ)', () => {
        for (const platform of PLATFORMS) {
            expect(commandForKey(input('Tab'), platform)).toBe('add-child');
            expect(commandForKey(input('Tab', { shiftKey: true }), platform)).toBe('rename-parent');
        }
    });

    it('Alt つきの Enter のほかのキーは命令にしない (win の Alt は Enter の移るキーにだけ使う)', () => {
        for (const platform of PLATFORMS) {
            for (const key of ['Tab', 'Escape', 'Delete', 'j', 'd', 't', 'h', 'v', 'z', 'g', 'ArrowDown']) {
                expect(commandForKey(input(key, { altKey: true }), platform), `${platform} Alt+${key}`).toBeNull();
                expect(commandForKey(input(key, { altKey: true, shiftKey: true }), platform), `${platform} Shift+Alt+${key}`).toBeNull();
            }
        }
    });

    it('Enter のほかの修飾キーなしのキーは、mac と win で同じ命令', () => {
        const keys = ['Escape', 'Tab', 'Delete', 'Backspace', 'j', 'J', 'd', 't', 'h', 'v', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', ' '];
        for (const key of keys) expect(commandForKey(input(key), 'mac'), key).toBe(commandForKey(input(key), 'win'));
        expect(commandForKey(input('g', { metaKey: true }), 'mac')).toBe('group');
        expect(commandForKey(input('g', { ctrlKey: true }), 'win')).toBe('group');
    });
});

describe('名前の入力 (ノード) の Enter (nameInputAction): spec.md の「ノードの名前の入力中」の表', () => {
    const table = (platform: KeyPlatform): Array<[string, Modifiers, NameInputAction | null, NameInputAction | null]> => [
        ['修飾キーなし', {}, 'commit', 'sibling'],
        ['足すキー', ROLES[platform].add, 'sibling', 'sibling-before'],
        ['移るキー', ROLES[platform].step, 'next', 'previous'],
        // 何もしない (入力欄に任せる)
        ['使わないキー', ROLES[platform].unused, null, null],
    ];

    for (const platform of PLATFORMS) {
        it(`${platform}: Enter は決めるだけ、Shift+Enter と足すキーは決めて下に足す、Shift と足すキーは上に足す、移るキーは下 (Shift で上) の兄弟へ`, () => {
            for (const [name, modifiers, plain, shifted] of table(platform)) {
                expect(nameInputAction(typed('Enter', modifiers), 'node', platform), `${platform} ${name}+Enter`).toBe(plain);
                expect(nameInputAction(typed('Enter', { ...modifiers, shiftKey: true }), 'node', platform), `${platform} Shift+${name}+Enter`).toBe(shifted);
            }
        });

        it(`${platform}: 修飾キーを 2 つ以上押した Enter は、Shift のあるなしによらず入力欄に任せる`, () => {
            for (const modifiers of TWO_OR_MORE) {
                expect(nameInputAction(typed('Enter', modifiers), 'node', platform), `${platform} ${label(modifiers)}`).toBeNull();
                expect(nameInputAction(typed('Enter', { ...modifiers, shiftKey: true }), 'node', platform), `${platform} Shift+${label(modifiers)}`).toBeNull();
            }
        });
    }
});

describe('グループの名前の入力の Enter: spec.md の「グループの名前の入力中」の表と S-10、S-11 (今のまま)', () => {
    it('修飾キーも Shift もない Enter だけが決める。Shift+Enter と修飾キーつきの Enter (どの割り当ても、2 つ以上も) は何もしない (既定の動きを止める)', () => {
        for (const platform of PLATFORMS) {
            expect(nameInputAction(typed('Enter'), 'group', platform)).toBe('commit');
            const modifiersList: Modifiers[] = [{ shiftKey: true }, ROLES[platform].add, ROLES[platform].step, ROLES[platform].unused, ...TWO_OR_MORE];
            for (const modifiers of modifiersList) {
                expect(nameInputAction(typed('Enter', modifiers), 'group', platform), `${platform} ${label(modifiers)}`).toBe('stay');
                expect(nameInputAction(typed('Enter', { ...modifiers, shiftKey: true }), 'group', platform), `${platform} Shift+${label(modifiers)}`).toBe('stay');
            }
            expect(nameInputAction(typed('Tab'), 'group', platform)).toBe('stay');
            expect(nameInputAction(typed('Tab', { shiftKey: true }), 'group', platform)).toBe('stay');
        }
    });
});

describe('OS の判定 (isApplePlatform): navigator.platform だけを見る', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('Mac、iPhone、iPad、iPod を含めば mac (true)、Windows と Linux と空は win (false)', () => {
        for (const platform of ['MacIntel', 'MacPPC', 'Macintosh', 'iPhone', 'iPad', 'iPod', 'iPhone Simulator']) {
            vi.stubGlobal('navigator', { platform });
            expect(isApplePlatform(), platform).toBe(true);
        }
        for (const platform of ['Win32', 'Win64', 'Linux x86_64', 'Linux armv8l', 'X11', '']) {
            vi.stubGlobal('navigator', { platform });
            expect(isApplePlatform(), platform).toBe(false);
        }
    });

    it('userAgentData.platform は読まない (Chromium の "macOS" と答えが割れるため。spec.md の「そのほか」)', () => {
        vi.stubGlobal('navigator', { platform: 'Win32', userAgentData: { platform: 'macOS' } });
        expect(isApplePlatform()).toBe(false);
        vi.stubGlobal('navigator', { platform: 'MacIntel', userAgentData: { platform: 'Windows' } });
        expect(isApplePlatform()).toBe(true);
    });

    it('navigator のない所 (サーバーの描画など) では win (false) で、投げない', () => {
        vi.stubGlobal('navigator', undefined);
        expect(isApplePlatform()).toBe(false);
    });
});

// 移る先の文書。1 計画 / 2 準備 / 3 調べる / 4 決める / 5 書く / 6 作業 / 7 1. 停止 / 8 2. 更新 / 9 確認 / 10 a / 11 a1 / 12 a2 / 13 b
const OUTLINE = ['# 計画', '', '## 準備', '- 調べる', '- 決める', '- 書く', '', '## 作業', '1. 停止', '2. 更新', '', '## 確認', '- a', '    - a1', '    - a2', '- b', ''].join('\n');

describe('移る先 (outlineTarget): 書いた順の親と、同じ親の子の 1 つ前と 1 つ後。端では回らない', () => {
    const nodes = core.parseDocument(OUTLINE).nodes;
    const id = (name: string): number => {
        const found = nodes.filter((node) => node.refText === name);
        if (found.length !== 1) throw new Error(`名前 ${name} のノードが ${found.length} 個`);
        return found[0]!.id;
    };
    const step = (move: OutlineStep, from: string): string | null => {
        const target = outlineTarget(move, id(from), nodes);
        return target === null ? null : (nodes.find((node) => node.id === target)?.refText ?? `#${target}`);
    };

    it('下の兄弟は 1 つ後 (2 つ後ではない)、上の兄弟は 1 つ前', () => {
        expect(step('next', '調べる')).toBe('決める');
        expect(step('next', '決める')).toBe('書く');
        expect(step('previous', '書く')).toBe('決める');
        expect(step('previous', '決める')).toBe('調べる');
        expect(step('next', '1. 停止')).toBe('2. 更新');
    });

    it('最後の兄弟の下と最初の兄弟の上は、移る先がない (反対の端へ回らない)', () => {
        expect(step('next', '書く')).toBeNull();
        expect(step('previous', '調べる')).toBeNull();
        expect(step('next', '2. 更新')).toBeNull();
        expect(step('previous', '1. 停止')).toBeNull();
        expect(step('next', '確認')).toBeNull();
        expect(step('previous', '準備')).toBeNull();
    });

    it('兄弟は同じ親の子だけ: 見出しの兄弟はあいだの子を飛ばし、入れ子の最後の子の下は親の兄弟へ出ない', () => {
        expect(step('next', '準備')).toBe('作業');
        expect(step('next', '作業')).toBe('確認');
        expect(step('previous', '確認')).toBe('作業');
        expect(step('next', 'a1')).toBe('a2');
        expect(step('next', 'a2')).toBeNull();
        expect(step('previous', 'a1')).toBeNull();
        expect(step('next', 'a')).toBe('b');
    });

    it('親は書いた順の親。ルートの親はない。兄弟のない子は上下に移る先がない', () => {
        expect(step('parent', '調べる')).toBe('準備');
        expect(step('parent', 'a1')).toBe('a');
        expect(step('parent', '準備')).toBe('計画');
        expect(step('parent', '計画')).toBeNull();
        const single = core.parseDocument('# R\n- only\n').nodes;
        expect(outlineTarget('next', 2, single)).toBeNull();
        expect(outlineTarget('previous', 2, single)).toBeNull();
    });

    it('文書にない id は移る先がない', () => {
        for (const move of ['parent', 'previous', 'next'] as const) expect(outlineTarget(move, 999, nodes), move).toBeNull();
    });

    it('親へ移るときに飛ばす相手 (S-13 の残り): 見出しの下のリストの入れ物は名前を持たず (list)、名前を変えられない。その上の見出しと、リストだけの文書のルート (title) は変えられる', () => {
        const lists = '# 二つのリスト\n\n- 赤\n- 青\n\n1. 一号\n2. 二号\n';
        const parsed = core.parseDocument(lists).nodes;
        const red = parsed.find((node) => node.refText === '赤')!;
        const container = parsed.find((node) => node.id === outlineTarget('parent', red.id, parsed))!;
        expect(container.refText).toBe('');
        expect(core.inspectNode(lists, { id: container.id, refText: '' })).toMatchObject({ kind: 'list', canRename: false });
        expect(container.parent).toBe(1);
        expect(core.inspectNode(lists, { id: 1, refText: '二つのリスト' })).toMatchObject({ kind: 'heading', canRename: true });
        const listRoot = '---\ntitle: リストだけ\n---\n- 甲\n- 乙\n';
        expect(core.inspectNode(listRoot, { id: 1, refText: 'リストだけ' })).toMatchObject({ canRename: true, label: 'リストだけ' });
    });
});

describe('Space の押して離す (Tools): タスクの印を進めるのは、ポインタもほかのキーも押さずに離したときだけ', () => {
    const fresh = (): Tools => new Tools(() => {});

    it('押している間にポインタを押したら (Space+ドラッグを含む)、離しても進めない。次に押し直せば、また押して離す押し方になる', () => {
        const tools = fresh();
        tools.holdSpace({ shiftKey: false });
        tools.interruptSpace();
        expect(tools.releaseSpace()).toBe(false);
        tools.holdSpace({ shiftKey: false });
        expect(tools.releaseSpace()).toBe(true);
    });

    it('押したままのキーの繰り返し (2 回目からの押下) は押して離す押し方を始め直さない: 途中で止めたら、繰り返しが来ても進めない', () => {
        const tools = fresh();
        tools.holdSpace({ shiftKey: false });
        tools.holdSpace({ shiftKey: false });
        expect(tools.releaseSpace(), '繰り返しだけ').toBe(true);
        tools.holdSpace({ shiftKey: false });
        tools.interruptSpace();
        tools.holdSpace({ shiftKey: false });
        expect(tools.releaseSpace(), '止めたあとの繰り返し').toBe(false);
    });

    it('合流先を選ぶ途中 (S-18): 押して離しても進めない (図を動かすだけ)。途中をやめたあとは進める', () => {
        const tools = fresh();
        tools.startJoin();
        tools.holdSpace({ shiftKey: false });
        expect(tools.dragToPan).toBe('both');
        expect(tools.releaseSpace()).toBe(false);
        expect(tools.state).toBe('join-target');
        tools.endJoin();
        tools.holdSpace({ shiftKey: false });
        expect(tools.releaseSpace()).toBe(true);
    });

    it('押している間に合流先を選ぶ途中になったら、離しても進めない', () => {
        const tools = fresh();
        tools.holdSpace({ shiftKey: false });
        tools.startJoin();
        expect(tools.releaseSpace()).toBe(false);
    });

    it('押していないときの離し (ウィンドウのフォーカスが外れたときの 2 回目など) と、閲覧へ切り替えた (reset) あとの離しは進めない', () => {
        const tools = fresh();
        expect(tools.releaseSpace()).toBe(false);
        tools.holdSpace({ shiftKey: false });
        expect(tools.releaseSpace()).toBe(true);
        expect(tools.releaseSpace()).toBe(false);
        tools.holdSpace({ shiftKey: false });
        tools.reset();
        expect(tools.releaseSpace()).toBe(false);
    });
});

// markdag.rules で上流が終わるまで進められないタスク (設計 --> 実装 --> 検証) と、ほかのタスク (メモ、読み取りだけの組の 固定)
function rulesDoc(): string {
    return [
        '---',
        'markdag:',
        '    rules:',
        '        taskToggle:',
        '            requireUpstreamDone: true',
        '            readonlyGroups: [lock]',
        '    groups:',
        '        lock:',
        '            label: 固定の組',
        '    relations:',
        '        chain:',
        '            - 設計 --> 実装 --> 検証',
        '---',
        '',
        '# リリース',
        '',
        '- [ ] 設計',
        '- [ ] 実装',
        '- [ ] 検証',
        '- [ ] メモ',
        '- [ ] 固定 %lock',
        '- 説明',
        '',
    ].join('\n');
}

interface BridgeRun {
    toggled: boolean;
    rewrites: number;
    announced: string[];
    diagnostics: string[];
}

// 描いた文書で橋渡しを作り、名前の順 (文書の順) に並べたノードをまとめて進める
function toggleTogether(names: string[], hooks?: HookModule): BridgeRun {
    const source = rulesDoc();
    const diagnostics: string[] = [];
    const announced: string[] = [];
    const own: HookModule = { ...hooks, onTaskToggle: (context) => void announced.push(context.node.text) };
    const bridge = createRenderBridge({ source: () => source, hooks: own, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code) });
    const parsed = parseDocument(source);
    const model = buildModel(parsed.nodes, parsed.frontmatter, source);
    bridge.setDocument(parsed, model);
    const wanted = new Set(names);
    const nodes: OutlineNode[] = parsed.nodes.filter((node) => wanted.has(node.refText));
    expect(nodes.map((node) => node.refText)).toEqual(names);
    let rewrites = 0;
    const toggled = bridge.toggleTasks(nodes, model.taskCycle, () => {
        rewrites += 1;
    });
    return { toggled, rewrites, announced, diagnostics };
}

describe('まとめて進める (render の橋渡しの toggleTasks): 全部通れば 1 回で書き換え、1 つでも断られたら何もしない (U3、U6、S-17)', () => {
    it('ほかの規則のないタスク 2 つは、書き換えを 1 回だけ呼び、タスクごとに onTaskToggle を知らせる', () => {
        const run = toggleTogether(['設計', 'メモ']);
        expect(run).toEqual({ toggled: true, rewrites: 1, announced: ['設計', 'メモ'], diagnostics: [] });
    });

    it('上流と下流 (設計と実装) を一緒に進めると、前のタスクを進めた結果で次を確かめるので両方進む (S-17)', () => {
        expect(toggleTogether(['設計', '実装'])).toEqual({ toggled: true, rewrites: 1, announced: ['設計', '実装'], diagnostics: [] });
        expect(toggleTogether(['設計', '実装', '検証'])).toEqual({ toggled: true, rewrites: 1, announced: ['設計', '実装', '検証'], diagnostics: [] });
    });

    it('1 つでも進められなければ (上流が終わっていない検証、読み取りだけの組の固定)、書き換えも知らせも出さず、理由を onDiagnostic の hook-rejected で出す (U6)', () => {
        for (const names of [['設計', '検証'], ['実装'], ['メモ', '固定'], ['設計', '実装', '固定']]) {
            const run = toggleTogether(names);
            expect(run.toggled, names.join('、')).toBe(false);
            expect(run.rewrites, names.join('、')).toBe(0);
            expect(run.announced, names.join('、')).toEqual([]);
            expect(run.diagnostics.length, names.join('、')).toBeGreaterThan(0);
            expect(new Set(run.diagnostics), names.join('、')).toEqual(new Set(['hook-rejected']));
        }
    });

    it('アプリの beforeTaskToggle が 1 つでも断れば、書き換えない', () => {
        const run = toggleTogether(['設計', 'メモ'], { beforeTaskToggle: (context) => (context.node.text === 'メモ' ? false : undefined) });
        expect(run.toggled).toBe(false);
        expect(run.rewrites).toBe(0);
        expect(run.announced).toEqual([]);
    });

    it('タスクでないノードは飛ばす。タスクがなければ何もしない (書き換えも知らせもしない)', () => {
        expect(toggleTogether(['メモ', '説明'])).toEqual({ toggled: true, rewrites: 1, announced: ['メモ'], diagnostics: [] });
        expect(toggleTogether(['説明'])).toEqual({ toggled: false, rewrites: 0, announced: [], diagnostics: [] });
        expect(toggleTogether([])).toEqual({ toggled: false, rewrites: 0, announced: [], diagnostics: [] });
    });
});

// GUI 編集のための図の出口の受け口のうち DOM の要らない所: createHookBridge が、アプリの viewHooks に渡した図の出口の受け口
// を、受け取った引数のまま通すこと。文書のフックの出来事は足さない。
// 図の操作から呼ばれることは e2e の図の出口のテストが確かめる
import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHookBridge } from '../src/bridge';
import { HOOK_EVENTS, type HookModule } from '../src/model/hooks';
import { buildModel } from '../src/model/model';
import { parseDocument } from '../src/parse/document';
import type { ViewHooks } from '../src/view/view';

const NAMES = [
    'onNodePointerDown',
    'onNodeDoubleClick',
    'onTagClick',
    'onEdgeClick',
    'onFrameClick',
    'onFrameDoubleClick',
    'onCanvasPointerDown',
    'onCanvasClick',
    'onIconSvg',
] as const;
type Name = (typeof NAMES)[number];
type Listener = (...args: unknown[]) => unknown;

// 受け口ごとに渡す引数。中身は使わず、同じものがそのまま届くかだけを見る
const node = { id: 3, refText: 'Task A' };
const edge = { edge: { kind: 'depends', source: 5, target: 2 } };
const pointer = { type: 'pointerdown', button: 0 };
const mouse = { type: 'click', button: 0 };
const ARGS: Record<Name, unknown[]> = {
    onNodePointerDown: [node, pointer],
    onNodeDoubleClick: [node, 'popover', mouse],
    onTagClick: [node, 'owner', 'popover', mouse],
    onEdgeClick: [edge, mouse],
    onFrameClick: ['design', mouse],
    onFrameDoubleClick: ['design', mouse],
    onCanvasPointerDown: [pointer, { kind: 'frame', id: 'design' }],
    onCanvasClick: [mouse],
    onIconSvg: ['simple-icons:github'],
};

const spies = (): Record<Name, Mock> => Object.fromEntries(NAMES.map((name) => [name, vi.fn()])) as Record<Name, Mock>;
const listenerOf = (hooks: ViewHooks, name: Name): unknown => (hooks as Record<string, unknown>)[name];

describe('createHookBridge は図の出口の受け口をそのまま通す (段 10、design.md 2.2)', () => {
    it.each(NAMES)('%s: アプリの受け口を、受け取った引数のまま 1 回呼び、ほかの受け口は呼ばない', (name) => {
        const own = spies();
        const bridge = createHookBridge({ source: () => '', viewHooks: own as unknown as ViewHooks });
        const listener = listenerOf(bridge.viewHooks, name);
        expect(typeof listener).toBe('function');
        (listener as Listener)(...ARGS[name]);

        expect(own[name]).toHaveBeenCalledTimes(1);
        const received = own[name].mock.calls[0] ?? [];
        expect(received).toHaveLength(ARGS[name].length);
        received.forEach((arg, index) => expect(arg).toBe(ARGS[name][index]));
        for (const other of NAMES) if (other !== name) expect(own[other]).not.toHaveBeenCalled();
    });

    it('アプリが省いた受け口は、bridge.viewHooks から呼んでも投げない', () => {
        const bridge = createHookBridge({ source: () => '' });
        for (const name of NAMES) {
            const listener = listenerOf(bridge.viewHooks, name);
            if (listener !== undefined) expect(() => (listener as Listener)(...ARGS[name])).not.toThrow();
        }
    });

    it('通すときに、文書のフック (アプリの hooks を含む) の出来事を呼ばない', () => {
        const source = ['---', 'markdag:', '    groups:', '        design:', '            label: 設計', '---', '', '# Root', '', '## Design %design', ''].join('\n');
        const module = Object.fromEntries(HOOK_EVENTS.map((event) => [event, vi.fn()])) as unknown as Record<string, Mock>;
        const own = spies();
        const bridge = createHookBridge({ source: () => source, hooks: module as unknown as HookModule, viewHooks: own as unknown as ViewHooks });
        const parsed = parseDocument(source);
        bridge.setDocument(parsed, buildModel(parsed.nodes, parsed.frontmatter, source));
        for (const spy of Object.values(module)) spy.mockClear();

        for (const name of NAMES) (listenerOf(bridge.viewHooks, name) as Listener)(...ARGS[name]);
        for (const name of NAMES) expect(own[name]).toHaveBeenCalledTimes(1);
        for (const [event, spy] of Object.entries(module)) expect(spy, event).not.toHaveBeenCalled();
    });
});

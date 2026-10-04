// GUI 編集の編集の層の土台 (入口 markdag/editor、mountEditor、モード、セグメント) を、ビルドした配布物で確かめる。
// mountEditor と MarkdagEditor と EditorOptions、モードの決め方、init を出さないこと、数式とコードの飾り、破棄の順、
// 編集の層の切り出しの決まり (読むのは markdag/core だけ)、interaction の切り替え、隅の規則を見る。
// 見た目そのもの (色、余白) は見ない。目印 (mdag-editor-* の要素の有無と数、data-corner、セグメントのボタンの data-mode と aria-pressed、
// .markdag の data-editor-mode と data-interaction)、onChange と onModeChange の呼ばれ方、モードの決まり方、destroy のあとの片付けを見る。
// 反映は expect.poll で待ち、「呼ばれない」「変わらない」は描画の数コマと 200ms を待ってから見る
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { SegmentPosition } from '../src/core';
import type { EditorMode, EditorModeOption, EditorOptions, MarkdagEditor } from '../src/editor';
import type { buildStandaloneHtml as BuildStandaloneHtml, init as Init } from '../src/standalone';

type Entry = { root: string; kind: 'change'; markdown: string } | { root: string; kind: 'mode'; mode: EditorMode; byUser: boolean };

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    // onChange と onModeChange に届いたもの (呼ばれた順)
    log: Entry[];
    // アプリの onLayout が呼ばれた回数 (図ごと)
    layouts: Record<string, number>;
    // 受け口の控え (instrumentListeners が置く)
    listenerPhase: number;
    leftovers: (phase: number) => string[];
};

const DIST = resolve('dist');
// 配布物の CDN の JS の経路 (ビルドの台本の確かめと同じ形)
const CDN_SCRIPT = /https:\/\/cdn\.jsdelivr\.net\/[^"'`\s]*\.js\b/g;
const POSITIONS: SegmentPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center'];

// ノードは Root 1、Design 2、Task A 3 (未完了のタスク)、Task B 4、Build 5、Leaf 6
const BODY = ['# Root', '', '## Design', '', '- [ ] Task A', '- [x] Task B', '', '## Build', '', '- Leaf', ''];
// ほかの行 (木の形は同じ) を変えた本文
const BODY_EDITED = BODY.map((line) => (line === '- Leaf' ? '- Leaf (edited)' : line));
// ノードを 1 つ足した本文 (7 ノード)
const BODY_MORE = [...BODY.slice(0, -1), '- Leaf 2', ''];
// Task A の印を進めた本文 (タスクの既定の巡りは ' ' → 'x')
const BODY_TOGGLED = BODY.map((line) => (line === '- [ ] Task A' ? '- [x] Task A' : line));
// frontmatter のない文書 (markdag のキーもない)
const PLAIN = BODY.join('\n');

// markdag.editor を書いた文書。editor の行は markdag.editor の下の字下げ (8 桁) からの相対で書く。null なら markdag.editor を書かない
function docWith(editor: string[] | null, body: string[] = BODY): string {
    const lines = editor === null ? [] : ['    editor:', ...editor.map((line) => `        ${line}`)];
    return ['---', 'markdag:', '    edgeHighlight: true', ...lines, '---', '', ...body].join('\n');
}

const SWITCH = ['mode: switch'];

interface ModeState {
    mode: EditorMode;
    // .markdag (図を置いた要素) の data-editor-mode と data-interaction
    editorMode: string | null;
    interaction: string | null;
    // .mdag-editor-segment の数と、入っている隅の入れ物の data-corner
    segments: number;
    corner: string | null;
    // セグメントのボタンの data-mode → aria-pressed
    pressed: Record<string, string | null> | null;
}

const VIEW_ONLY: ModeState = { mode: 'view', editorMode: 'view', interaction: null, segments: 0, corner: null, pressed: null };
const EDIT_ONLY: ModeState = { mode: 'edit', editorMode: 'edit', interaction: 'edit', segments: 0, corner: null, pressed: null };
// セグメントを出している図。interaction は GUI 編集で edit、閲覧では付かない
const withSegment = (mode: EditorMode, corner: SegmentPosition = 'top-left'): ModeState => ({
    mode,
    editorMode: mode,
    interaction: mode === 'edit' ? 'edit' : null,
    segments: 1,
    corner,
    pressed: { view: String(mode === 'view'), edit: String(mode === 'edit') },
});

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        const target = window as unknown as EditorWindow;
        target.editors = {};
        target.log = [];
        target.layouts = {};
    });
}

interface MountSpec {
    root?: 'a' | 'b';
    mode?: EditorModeOption;
    // beforeUpdate のフックで原文の差し替えを取りやめる
    cancelUpdate?: boolean;
}

async function mount(page: Page, markdown: string, spec: MountSpec = {}): Promise<void> {
    await page.evaluate(
        ({ markdown, root, mode, cancelUpdate }) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById(root);
            if (!container) throw new Error(`#${root} がない`);
            const options: EditorOptions = {
                animate: false,
                onChange: (next) => {
                    target.log.push({ root, kind: 'change', markdown: next });
                },
                onModeChange: (next, byUser) => {
                    target.log.push({ root, kind: 'mode', mode: next, byUser });
                },
                onLayout: () => {
                    target.layouts[root] = (target.layouts[root] ?? 0) + 1;
                },
            };
            if (mode !== null) options.mode = mode;
            if (cancelUpdate) options.hooks = { beforeUpdate: () => false };
            target.editors[root] = target.editorHarness.editor.mountEditor(container, markdown, options);
        },
        { markdown, root: spec.root ?? 'a', mode: spec.mode ?? null, cancelUpdate: spec.cancelUpdate ?? false },
    );
}

async function stateOf(page: Page, root = 'a'): Promise<ModeState> {
    return page.evaluate((root) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById(root);
        if (!container) throw new Error(`#${root} がない`);
        const segments = container.querySelectorAll('.mdag-editor-segment');
        const segment = segments[0];
        return {
            mode: target.editors[root]?.getMode() ?? 'view',
            editorMode: container.getAttribute('data-editor-mode'),
            interaction: container.getAttribute('data-interaction'),
            segments: segments.length,
            corner: segment?.closest('.mdag-editor-corner')?.getAttribute('data-corner') ?? null,
            pressed: segment ? Object.fromEntries([...segment.querySelectorAll('[data-mode]')].map((button) => [button.getAttribute('data-mode') ?? '', button.getAttribute('aria-pressed')])) : null,
        };
    }, root);
}

const modeLog = (page: Page, root = 'a'): Promise<Array<{ mode: EditorMode; byUser: boolean }>> =>
    page.evaluate((root) => (window as unknown as EditorWindow).log.flatMap((entry) => (entry.root === root && entry.kind === 'mode' ? [{ mode: entry.mode, byUser: entry.byUser }] : [])), root);

const changeLog = (page: Page, root = 'a'): Promise<string[]> =>
    page.evaluate((root) => (window as unknown as EditorWindow).log.flatMap((entry) => (entry.root === root && entry.kind === 'change' ? [entry.markdown] : [])), root);

const setMode = (page: Page, mode: EditorMode, root = 'a'): Promise<boolean> =>
    page.evaluate(({ mode, root }) => (window as unknown as EditorWindow).editors[root]?.setMode(mode) ?? false, { mode, root });

const setSource = (page: Page, markdown: string, root = 'a'): Promise<string[]> =>
    page.evaluate(({ markdown, root }) => ((window as unknown as EditorWindow).editors[root]?.setSource(markdown) ?? []).map((item) => item.code), { markdown, root });

const getSource = (page: Page, root = 'a'): Promise<string | undefined> => page.evaluate((root) => (window as unknown as EditorWindow).editors[root]?.getSource(), root);

const segmentButton = (page: Page, mode: EditorMode, root = 'a') => page.locator(`#${root} .mdag-editor-segment [data-mode="${mode}"]`);

// 「呼ばれない」「変わらない」を見る前に、描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

// 配布物の入口から、相対の import (静的と式) でたどれるファイル (dist からの相対のパス)
function reachable(entries: string[]): string[] {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
        const file = queue.shift() ?? '';
        if (seen.has(file)) continue;
        seen.add(file);
        const code = readFileSync(join(DIST, file), 'utf8');
        for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\1/g)) {
            const next = relative(DIST, resolve(dirname(join(DIST, file)), (match[2] ?? '').split('?')[0] ?? ''));
            queue.push(next.split(sep).join('/'));
        }
    }
    return [...seen].sort();
}

const cdnScriptsIn = (files: string[]): string[] => files.flatMap((file) => [...readFileSync(join(DIST, file), 'utf8').matchAll(CDN_SCRIPT)].map((match) => `${file}: ${match[0]}`));

// document、window、図を置く要素 (#a と #b) に付いた受け口を控える。ページのスクリプトより先に動かす (addInitScript)。
// 控えには付けたときの listenerPhase を残し、leftovers(phase) はその段で付けて外れていないものを「相手 種類 (capture)」で返す。
// 外れたことは removeEventListener と、signal の abort と、once の発火で知る
function instrumentListeners(): void {
    type ListenerRecord = { target: string; type: string; capture: boolean; listener: unknown; phase: number; removed: boolean };
    const records: ListenerRecord[] = [];
    const target = window as unknown as { listenerPhase: number; leftovers: (phase: number) => string[] };
    target.listenerPhase = 0;
    const labelOf = (item: EventTarget): string | null => {
        if (item === window) return 'window';
        if (item === document) return 'document';
        if (item instanceof Element && (item.id === 'a' || item.id === 'b')) return `#${item.id}`;
        return null;
    };
    const captureOf = (options: unknown): boolean => (typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture));
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        const label = labelOf(this);
        if (label !== null && listener !== null) {
            const capture = captureOf(options);
            const active = records.some((item) => !item.removed && item.target === label && item.type === type && item.capture === capture && item.listener === listener);
            if (!active) {
                const record: ListenerRecord = { target: label, type, capture, listener, phase: target.listenerPhase, removed: false };
                records.push(record);
                const signal = typeof options === 'object' ? options.signal : undefined;
                if (signal?.aborted) record.removed = true;
                else if (signal) add.call(signal, 'abort', () => (record.removed = true));
                if (typeof options === 'object' && options.once) add.call(this, type, () => (record.removed = true), { once: true, capture });
            }
        }
        return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        const label = labelOf(this);
        if (label !== null) {
            const capture = captureOf(options);
            for (const item of records) if (!item.removed && item.target === label && item.type === type && item.capture === capture && item.listener === listener) item.removed = true;
        }
        return remove.call(this, type, listener, options);
    };
    target.leftovers = (phase: number) =>
        records
            .filter((item) => item.phase === phase && !item.removed)
            .map((item) => `${item.target} ${item.type}${item.capture ? ' capture' : ''}`)
            .sort();
}

test.describe('入口と配布物 (design.md 1.2、1.4、10.1 の 8)', () => {
    test('@editor 入口 markdag/editor (配布物の editor.js と editor.dev.js) は mountEditor だけを出し、init を出さない', async ({ page }) => {
        await open(page);
        const keys = await page.evaluate(async () => {
            const target = window as unknown as EditorWindow;
            const devUrl: string = '/dist/editor.dev.js';
            const dev = (await import(/* @vite-ignore */ devUrl)) as Record<string, unknown>;
            return { entry: Object.keys(target.editorHarness.editor).sort(), dev: Object.keys(dev).sort(), type: typeof target.editorHarness.editor.mountEditor };
        });
        expect(keys).toEqual({ entry: ['mountEditor'], dev: ['mountEditor'], type: 'function' });
    });

    test('@editor 配布物に editor.js、editor.dev.js、types/editor.d.ts ができ、editor の入口からたどれるファイルに CDN から JS を読む経路がない', () => {
        for (const file of ['editor.js', 'editor.dev.js', 'types/editor.d.ts']) expect(existsSync(join(DIST, file)), file).toBe(true);
        expect(readFileSync(join(DIST, 'types/editor.d.ts'), 'utf8')).toMatch(/\bmountEditor\b/);
        const files = reachable(['editor.js', 'editor.dev.js']);
        expect(files).toEqual(expect.arrayContaining(['editor.js', 'editor.dev.js']));
        expect(cdnScriptsIn(files)).toEqual([]);
        // 調べ方が効いていることの確かめ: 既定の入口 (飾りのライブラリを CDN から読む) では経路が見つかる
        expect(cdnScriptsIn(reachable(['markdag.js'])).length).toBeGreaterThan(0);
    });

    test('@editor 数式とコードを使う文書でも、閲覧と GUI 編集のどちらでも CDN から KaTeX と highlight.js を読まない', async ({ page }) => {
        const requested: string[] = [];
        await page.route('https://cdn.jsdelivr.net/**', (route) => {
            requested.push(route.request().url());
            return route.abort();
        });
        await open(page);
        const doc = ['---', 'markdag:', '    editor:', '        mode: switch', '---', '', '# Root', '', '- Math $a^2$', '- Code', '', '  ```js', '  const x = 1;', '  ```', ''].join('\n');
        await mount(page, doc);
        await expect(page.locator('#a .mdag-node')).toHaveCount(3);
        await settle(page);
        expect(await setMode(page, 'edit')).toBe(true);
        await settle(page);
        expect(requested.filter((url) => new URL(url).pathname.endsWith('.js'))).toEqual([]);
        await expect(page.locator('script[data-markdag-asset]')).toHaveCount(0);
    });
});

test.describe('モードの決め方 (B-173〜B-175、B-177、B-180、B-181)', () => {
    test('@editor markdag.editor のない文書は閲覧だけで、セグメントがない。setMode は false で何もせず、mount でも onModeChange は呼ばれない (B-175)', async ({ page }) => {
        await open(page);
        await mount(page, PLAIN, { root: 'a' });
        await mount(page, docWith(null), { root: 'b' });
        for (const root of ['a', 'b']) {
            expect(await stateOf(page, root), root).toEqual(VIEW_ONLY);
            expect(await setMode(page, 'edit', root), root).toBe(false);
        }
        await settle(page);
        for (const root of ['a', 'b']) {
            expect(await stateOf(page, root), root).toEqual(VIEW_ONLY);
            expect(await modeLog(page, root), root).toEqual([]);
        }
    });

    test('@editor mode: view は閲覧だけ、mode: edit は GUI 編集だけで、default と segment を書いてもセグメントがない。setMode は false で何もしない (B-173、B-180、2.1)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(['mode: view', 'default: edit', 'segment:', '    display: true', '    position: top-right']), { root: 'a' });
        await mount(page, docWith(['mode: edit', 'default: view', 'segment:', '    position: bottom-left']), { root: 'b' });
        expect(await stateOf(page, 'a')).toEqual(VIEW_ONLY);
        expect(await stateOf(page, 'b')).toEqual(EDIT_ONLY);
        expect(await setMode(page, 'edit', 'a')).toBe(false);
        expect(await setMode(page, 'view', 'b')).toBe(false);
        await settle(page);
        expect(await stateOf(page, 'a')).toEqual(VIEW_ONLY);
        expect(await stateOf(page, 'b')).toEqual(EDIT_ONLY);
        expect(await modeLog(page, 'a')).toEqual([]);
        expect(await modeLog(page, 'b')).toEqual([]);
    });

    test('@editor markdag.editor の値の誤りは既定 (閲覧だけ) になり、diagnostics は render と同じ診断を持つ (B-177、1.2)', async ({ page }) => {
        await open(page);
        const doc = docWith(['mode: other']);
        await mount(page, doc);
        expect(await stateOf(page)).toEqual(VIEW_ONLY);
        const diagnostics = await page.evaluate((doc) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('b');
            if (!container) throw new Error('#b がない');
            const rendered = target.editorHarness.core.render(container, doc, { animate: false });
            const describe = (items: Array<{ severity: string; code: string; message: string }>): string[] => items.map((item) => `${item.severity} ${item.code} ${item.message}`);
            const result = { editor: describe(target.editors.a?.diagnostics ?? []), render: describe(rendered.diagnostics) };
            rendered.destroy();
            return result;
        }, doc);
        expect(diagnostics.editor).toEqual(diagnostics.render);
        expect(diagnostics.editor.some((line) => line.includes('option-invalid'))).toBe(true);
    });

    test('@editor mode: switch は default のモードで始まり、segment.display が true (既定) ならセグメントがある (B-174、B-179、B-180)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH), { root: 'a' });
        await mount(page, docWith(['mode: switch', 'default: edit']), { root: 'b' });
        expect(await stateOf(page, 'a')).toEqual(withSegment('view'));
        expect(await stateOf(page, 'b')).toEqual(withSegment('edit'));
        await settle(page);
        expect(await modeLog(page, 'a')).toEqual([]);
        expect(await modeLog(page, 'b')).toEqual([]);
    });

    test('@editor mode: switch で segment.display が false ならセグメントがなく、アプリは setMode で切り替えられる (B-180)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(['mode: switch', 'default: edit', 'segment:', '    display: false']));
        expect(await stateOf(page)).toEqual(EDIT_ONLY);
        expect(await setMode(page, 'view')).toBe(true);
        await expect.poll(() => stateOf(page)).toEqual(VIEW_ONLY);
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => stateOf(page)).toEqual(EDIT_ONLY);
        expect(await modeLog(page)).toEqual([
            { mode: 'view', byUser: false },
            { mode: 'edit', byUser: false },
        ]);
    });

    test('@editor segment.position の 6 か所で、セグメントが data-corner の入れ物に入る。隅の入れ物は 6 つ (B-181、6.4)', async ({ page }) => {
        for (const position of POSITIONS) {
            await open(page);
            await mount(page, docWith(['mode: switch', 'segment:', `    position: ${position}`]));
            expect(await stateOf(page), position).toEqual(withSegment('view', position));
            const layer = await page.evaluate(() => {
                const container = document.getElementById('a');
                return {
                    layers: container?.querySelectorAll('.mdag-editor').length ?? 0,
                    corners: [...(container?.querySelectorAll('.mdag-editor .mdag-editor-corner') ?? [])].map((corner) => corner.getAttribute('data-corner')).sort(),
                    segmentInLayer: container?.querySelector('.mdag-editor .mdag-editor-segment') !== null,
                };
            });
            expect(layer, position).toEqual({ layers: 1, corners: [...POSITIONS].sort(), segmentInLayer: true });
        }
    });
});

test.describe('閲覧と GUI 編集の切り替え (B-169、B-179、B-180、5.2 の軸 A)', () => {
    test('@editor セグメントを押すとモードが替わり、onModeChange が byUser true で呼ばれる。今のモードのボタンを押しても呼ばれない', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await segmentButton(page, 'edit').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit'));
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: true }]);

        await segmentButton(page, 'edit').click();
        await settle(page);
        expect(await stateOf(page)).toEqual(withSegment('edit'));
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: true }]);

        await segmentButton(page, 'view').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('view'));
        expect(await modeLog(page)).toEqual([
            { mode: 'edit', byUser: true },
            { mode: 'view', byUser: true },
        ]);
    });

    test('@editor setMode は switch のとき切り替えて true を返し、セグメントの押された印も替わる。onModeChange は byUser false で、同じモードへの setMode では呼ばれない (B-180)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit'));
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: false }]);

        await setMode(page, 'edit');
        await settle(page);
        expect(await stateOf(page)).toEqual(withSegment('edit'));
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: false }]);

        expect(await setMode(page, 'view')).toBe(true);
        await expect.poll(() => stateOf(page)).toEqual(withSegment('view'));
        expect(await modeLog(page)).toEqual([
            { mode: 'edit', byUser: false },
            { mode: 'view', byUser: false },
        ]);
    });
});

test.describe('文書の markdag.editor が変わったとき (B-176)', () => {
    test('@editor ほかの行を変えても、値を埋めると同じ指定を書き足しても、選んだモードは戻らない (setSource)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await segmentButton(page, 'edit').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit'));

        const edited = docWith(SWITCH, BODY_EDITED);
        await setSource(page, edited);
        expect(await getSource(page)).toBe(edited);
        await settle(page);
        expect(await stateOf(page)).toEqual(withSegment('edit'));

        // 既定の値 (default: view、segment.display: true、segment.position: top-left) を書き足しても、埋めたあとの指定は同じ
        await setSource(page, docWith(['mode: switch', 'default: view', 'segment:', '    display: true', '    position: top-left'], BODY_EDITED));
        await settle(page);
        expect(await stateOf(page)).toEqual(withSegment('edit'));
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: true }]);
    });

    test('@editor 閲覧でタスクの文字を押すとほかの行が変わり、onChange が 1 回呼ばれて getSource が同じ原文を返す。選んだモードは戻らない', async ({ page }) => {
        await open(page);
        const editor = ['mode: switch', 'default: edit'];
        await mount(page, docWith(editor));
        await segmentButton(page, 'view').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('view'));

        await page.locator('#a .mdag-node[data-id="3"] .mdag-content').click();
        const toggled = docWith(editor, BODY_TOGGLED);
        await expect.poll(() => changeLog(page)).toEqual([toggled]);
        expect(await getSource(page)).toBe(toggled);
        await settle(page);
        expect(await stateOf(page)).toEqual(withSegment('view'));
        expect(await modeLog(page)).toEqual([{ mode: 'view', byUser: true }]);
    });

    test('@editor markdag.editor を変えたときだけ合わせ直す: mode の設定と default に戻り、セグメントも指定に合わせ、onModeChange は byUser false', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await segmentButton(page, 'edit').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit'));

        // segment.position だけを変えても指定が変わったので、default (view) に戻ってセグメントが移る
        await setSource(page, docWith(['mode: switch', 'segment:', '    position: bottom-right']));
        await expect.poll(() => stateOf(page)).toEqual(withSegment('view', 'bottom-right'));

        await setSource(page, docWith(['mode: switch', 'default: edit', 'segment:', '    position: bottom-right']));
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit', 'bottom-right'));

        await setSource(page, docWith(['mode: view']));
        await expect.poll(() => stateOf(page)).toEqual(VIEW_ONLY);
        expect(await setMode(page, 'edit')).toBe(false);

        await setSource(page, docWith(['mode: edit']));
        await expect.poll(() => stateOf(page)).toEqual(EDIT_ONLY);

        await setSource(page, docWith(['mode: switch', 'segment:', '    display: false']));
        await expect.poll(() => stateOf(page)).toEqual(VIEW_ONLY);

        // markdag.editor を消すと既定 (閲覧だけ)。モードは閲覧のままなので onModeChange は呼ばれない
        await setSource(page, docWith(null));
        await settle(page);
        expect(await stateOf(page)).toEqual(VIEW_ONLY);
        expect(await setMode(page, 'edit')).toBe(false);

        expect(await modeLog(page)).toEqual([
            { mode: 'edit', byUser: true },
            { mode: 'view', byUser: false },
            { mode: 'edit', byUser: false },
            { mode: 'view', byUser: false },
            { mode: 'edit', byUser: false },
            { mode: 'view', byUser: false },
        ]);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor 合わせ直したモードが今のモードと同じなら onModeChange は呼ばれない', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await setSource(page, docWith(['mode: switch', 'segment:', '    position: top-center']));
        await expect.poll(() => stateOf(page)).toEqual(withSegment('view', 'top-center'));
        await settle(page);
        expect(await modeLog(page)).toEqual([]);
    });
});

test.describe('mount の mode の上書き (B-183、scope.md Q4)', () => {
    test('@editor mount の mode: view は文書の edit と switch を上書きして閲覧だけにする', async ({ page }) => {
        await open(page);
        await mount(page, docWith(['mode: edit']), { root: 'a', mode: 'view' });
        await mount(page, docWith(['mode: switch', 'default: edit']), { root: 'b', mode: 'view' });
        for (const root of ['a', 'b']) {
            expect(await stateOf(page, root), root).toEqual(VIEW_ONLY);
            expect(await setMode(page, 'edit', root), root).toBe(false);
        }
        await settle(page);
        for (const root of ['a', 'b']) expect(await stateOf(page, root), root).toEqual(VIEW_ONLY);
    });

    test('@editor mount の mode: edit は文書の指定を上書きして GUI 編集だけにする', async ({ page }) => {
        await open(page);
        await mount(page, docWith(null), { root: 'a', mode: 'edit' });
        await mount(page, docWith(SWITCH), { root: 'b', mode: 'edit' });
        for (const root of ['a', 'b']) {
            expect(await stateOf(page, root), root).toEqual(EDIT_ONLY);
            expect(await setMode(page, 'view', root), root).toBe(false);
        }
        await settle(page);
        for (const root of ['a', 'b']) expect(await stateOf(page, root), root).toEqual(EDIT_ONLY);
    });

    test('@editor mount の mode: switch は mode だけを上書きし、文書の default と segment で始める', async ({ page }) => {
        await open(page);
        await mount(page, docWith(null), { root: 'a', mode: 'switch' });
        await mount(page, docWith(['mode: view', 'default: edit', 'segment:', '    position: bottom-center']), { root: 'b', mode: 'switch' });
        expect(await stateOf(page, 'a')).toEqual(withSegment('view', 'top-left'));
        expect(await stateOf(page, 'b')).toEqual(withSegment('edit', 'bottom-center'));

        await open(page);
        await mount(page, docWith(['mode: edit', 'segment:', '    display: false']), { mode: 'switch' });
        expect(await stateOf(page)).toEqual(VIEW_ONLY);
        expect(await setMode(page, 'edit')).toBe(true);
        await expect.poll(() => stateOf(page)).toEqual(EDIT_ONLY);
    });

    test('@editor mount の mode を省くか document にすると、文書の指定に従う', async ({ page }) => {
        await open(page);
        await mount(page, docWith(['mode: switch', 'default: edit']), { root: 'a' });
        await mount(page, docWith(['mode: switch', 'default: edit']), { root: 'b', mode: 'document' });
        expect(await stateOf(page, 'a')).toEqual(withSegment('edit'));
        expect(await stateOf(page, 'b')).toEqual(withSegment('edit'));
    });

    test('@editor 上書きしていても、文書の markdag.editor が変わったときだけ合わせ直す', async ({ page }) => {
        await open(page);
        await mount(page, docWith(null), { root: 'a', mode: 'switch' });
        await mount(page, docWith(null), { root: 'b', mode: 'edit' });
        await segmentButton(page, 'edit', 'a').click();
        await expect.poll(() => stateOf(page, 'a')).toEqual(withSegment('edit'));

        await setSource(page, docWith(null, BODY_EDITED), 'a');
        await settle(page);
        expect(await stateOf(page, 'a')).toEqual(withSegment('edit'));

        // 文書の mode は上書きで使わないが、指定が変わったので default (view) に戻り、セグメントは文書の隅へ移る
        await setSource(page, docWith(['mode: view', 'segment:', '    position: top-right']), 'a');
        await expect.poll(() => stateOf(page, 'a')).toEqual(withSegment('view', 'top-right'));
        expect(await modeLog(page, 'a')).toEqual([
            { mode: 'edit', byUser: true },
            { mode: 'view', byUser: false },
        ]);

        await setSource(page, docWith(SWITCH), 'b');
        await settle(page);
        expect(await stateOf(page, 'b')).toEqual(EDIT_ONLY);
        expect(await modeLog(page, 'b')).toEqual([]);
    });
});

test.describe('原文の差し替え (1.2 の setSource と onChange)', () => {
    test('@editor setSource は原文を差し替えて描き直し、getSource が返す。onChange は呼ばれず、戻り値は diagnostics と同じ', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        const next = docWith(SWITCH, BODY_MORE);
        const returned = await setSource(page, next);
        await expect(page.locator('#a .mdag-node')).toHaveCount(7);
        expect(await getSource(page)).toBe(next);
        expect(returned).toEqual(await page.evaluate(() => ((window as unknown as EditorWindow).editors.a?.diagnostics ?? []).map((item) => item.code)));
        await settle(page);
        expect(await changeLog(page)).toEqual([]);
    });

    test('@editor beforeUpdate が取りやめた setSource は原文を変えず、描き直さず、モードも合わせ直さない', async ({ page }) => {
        await open(page);
        const first = docWith(SWITCH);
        await mount(page, first, { cancelUpdate: true });
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        await setSource(page, docWith(['mode: edit'], BODY_MORE));
        await settle(page);
        expect(await getSource(page)).toBe(first);
        await expect(page.locator('#a .mdag-node')).toHaveCount(6);
        expect(await stateOf(page)).toEqual(withSegment('view'));
        expect(await changeLog(page)).toEqual([]);
        expect(await modeLog(page)).toEqual([]);
    });
});

test.describe('destroy (1.2 の破棄の順、A-22、B-24)', () => {
    test('@editor destroy のあと container に編集の層の要素がなく、2 回呼んでも誤りにならない。getSource は最後の原文を返し、ほかのメソッドは何もしない', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await open(page);
        await mount(page, docWith(SWITCH));
        await segmentButton(page, 'edit').click();
        await expect.poll(() => stateOf(page)).toEqual(withSegment('edit'));
        const last = docWith(SWITCH, BODY_EDITED);
        await setSource(page, last);

        const result = await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            const editor = target.editors.a;
            const container = document.getElementById('a');
            if (!editor || !container) throw new Error('図がない');
            editor.destroy();
            const after = {
                layers: container.querySelectorAll('.mdag-editor').length,
                parts: container.querySelectorAll('[class*="mdag-editor"]').length,
                tabindex: container.getAttribute('tabindex'),
            };
            let second = 'ok';
            try {
                editor.destroy();
            } catch (error) {
                second = String(error);
            }
            let calls = 'ok';
            let switched: boolean | null = null;
            try {
                editor.setSource('# Other\n');
                switched = editor.setMode('view');
            } catch (error) {
                calls = String(error);
            }
            return { after, second, calls, switched, source: editor.getSource(), nodes: container.querySelectorAll('.mdag-node').length };
        });
        expect(result).toEqual({ after: { layers: 0, parts: 0, tabindex: null }, second: 'ok', calls: 'ok', switched: false, source: last, nodes: 0 });
        await settle(page);
        // 片付けたあとのタイマーが編集の層の要素を作り直さない
        await expect(page.locator('#a [class*="mdag-editor"]')).toHaveCount(0);
        expect(await modeLog(page)).toEqual([{ mode: 'edit', byUser: true }]);
        expect(await changeLog(page)).toEqual([]);
        expect(errors).toEqual([]);
    });

    test('@editor destroy のあと、編集の層が document、window、container に付けた受け口が残らない (render だけの図を destroy したときと同じ)', async ({ page }) => {
        await page.addInitScript(instrumentListeners);
        await open(page);
        // 比べる相手: render だけの図を描いて片付けたあとに残る受け口
        await page.evaluate(async (doc) => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            target.listenerPhase = 1;
            const diagram = target.editorHarness.core.render(container, doc, { animate: false });
            await new Promise((resolve) => setTimeout(resolve, 200));
            diagram.destroy();
            target.listenerPhase = 0;
        }, docWith(SWITCH));

        await page.evaluate(() => {
            (window as unknown as EditorWindow).listenerPhase = 2;
        });
        await mount(page, docWith(SWITCH));
        await page.mouse.move(500, 300);
        await segmentButton(page, 'edit').click();
        await page.mouse.move(520, 320);
        await page.keyboard.press('Escape');
        await setMode(page, 'view');
        await page.mouse.move(1200, 750);
        await settle(page);
        await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            target.editors.a?.destroy();
            target.listenerPhase = 0;
        });
        await settle(page);
        const leftovers = await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            return { render: target.leftovers(1), editor: target.leftovers(2) };
        });
        expect(leftovers.editor).toEqual(leftovers.render);
    });

    test('@editor container の幅を変えた同じタスクの中で destroy しても、そのあとアプリの onLayout が呼ばれない (A-22、B-24)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).layouts.a ?? 0)).toBeGreaterThan(0);
        await settle(page);
        const atDestroy = await page.evaluate(() => {
            const target = window as unknown as EditorWindow;
            const container = document.getElementById('a');
            if (!container) throw new Error('#a がない');
            container.style.width = '700px';
            target.editors.a?.destroy();
            return target.layouts.a ?? 0;
        });
        await settle(page);
        await settle(page);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).layouts.a ?? 0)).toBe(atDestroy);
    });

    test('@editor ノードの大きさが変わって図が描き直しを予約した直後に destroy しても、そのあとアプリの onLayout が呼ばれない (A-22、B-24)', async ({ page }) => {
        await open(page);
        await mount(page, docWith(SWITCH));
        await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).layouts.a ?? 0)).toBeGreaterThan(0);
        await settle(page);
        // 図はノードの箱の大きさを監視し、変わると次のコマで配置をやり直す (destroy はその予約を止めない)。
        // ノードの文字の要素の幅を広げ、図の監視が予約したのと同じコマの監視の呼び出し (あとから作った監視なので図の監視のあと) で destroy する
        const atDestroy = await page.evaluate(
            () =>
                new Promise<number>((resolve) => {
                    const target = window as unknown as EditorWindow;
                    const content = document.querySelector<HTMLElement>('#a .mdag-node[data-id="1"] .mdag-content');
                    if (!content) throw new Error('ノードの文字がない');
                    let first = true;
                    const observer = new ResizeObserver(() => {
                        if (first) {
                            first = false;
                            setTimeout(() => (content.style.minWidth = `${content.getBoundingClientRect().width + 200}px`), 0);
                            return;
                        }
                        observer.disconnect();
                        target.editors.a?.destroy();
                        resolve(target.layouts.a ?? 0);
                    });
                    observer.observe(content);
                }),
        );
        await settle(page);
        await settle(page);
        expect(await page.evaluate(() => (window as unknown as EditorWindow).layouts.a ?? 0)).toBe(atDestroy);
    });
});

// 単体 HTML: markdag.editor を書いた文書と、同じ行の数で markdag.editor の代わりに空行を置いた文書を比べる
const STANDALONE_EDITOR = ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '        default: edit', '        segment:', '            position: top-center', '---', '', ...BODY].join('\n');
const STANDALONE_PLAIN = ['---', 'markdag:', '    edgeHighlight: true', '', '', '', '', '', '---', '', ...BODY].join('\n');

// 図の要素の中身。配置の図形の id に付く図ごとの番号は、図を作った順で変わるので揃える
const normalized = (html: string): string => html.replace(/mdag-\d+-/g, 'mdag-#-');

test.describe('単体 HTML (B-187)', () => {
    test('@editor mountStandalone は markdag.editor を書いた文書でも、書いていない文書と同じ図を描き、編集の層を作らない', async ({ page }) => {
        await open(page);
        const result = await page.evaluate(
            async ({ withEditor, plain }) => {
                const { core } = (window as unknown as EditorWindow).editorHarness;
                const a = document.getElementById('a');
                const b = document.getElementById('b');
                if (!a || !b) throw new Error('図を置く要素がない');
                const first = await core.mountStandalone(a, { source: withEditor, view: { animate: false } });
                const second = await core.mountStandalone(b, { source: plain, view: { animate: false } });
                await new Promise((resolve) => setTimeout(resolve, 300));
                const result = {
                    a: a.innerHTML,
                    b: b.innerHTML,
                    nodes: a.querySelectorAll('.mdag-node').length,
                    editorParts: a.querySelectorAll('[class*="mdag-editor"]').length,
                    marks: [a.getAttribute('data-editor-mode'), a.getAttribute('data-interaction')],
                    diagnostics: first.diagnostics.map((item) => item.code),
                };
                first.destroy();
                second.destroy();
                return result;
            },
            { withEditor: STANDALONE_EDITOR, plain: STANDALONE_PLAIN },
        );
        expect(result.nodes).toBe(6);
        expect(result.editorParts).toBe(0);
        expect(result.marks).toEqual([null, null]);
        expect(result.diagnostics).toEqual([]);
        expect(normalized(result.a)).toBe(normalized(result.b));
    });

    test('@editor buildStandaloneHtml の HTML は markdag.editor を書いた文書でも、書いていない文書と同じ図を開き、編集の層を作らない', async ({ page }) => {
        const { buildStandaloneHtml, init } = (await import(pathToFileURL(join(DIST, 'standalone.js')).href)) as { buildStandaloneHtml: typeof BuildStandaloneHtml; init: typeof Init };
        await init();
        const opened: Array<{ html: string; nodes: number; editorParts: number; marks: Array<string | null> }> = [];
        for (const [name, source] of [
            ['with-editor', STANDALONE_EDITOR],
            ['plain', STANDALONE_PLAIN],
        ] as const) {
            const file = test.info().outputPath(`${name}.html`);
            writeFileSync(file, buildStandaloneHtml({ source, view: { animate: false } }));
            await page.goto(pathToFileURL(file).href);
            await page.waitForFunction(() => 'markdagStandalone' in window);
            await settle(page);
            opened.push(
                await page.evaluate(() => {
                    const container = document.querySelector('.mdag-standalone');
                    if (!container) throw new Error('図を置く要素がない');
                    return {
                        html: container.innerHTML,
                        nodes: container.querySelectorAll('.mdag-node').length,
                        editorParts: document.querySelectorAll('[class*="mdag-editor"]').length,
                        marks: [container.getAttribute('data-editor-mode'), container.getAttribute('data-interaction')],
                    };
                }),
            );
        }
        const [withEditor, plain] = opened;
        expect(withEditor?.nodes).toBe(6);
        expect(withEditor?.editorParts).toBe(0);
        expect(withEditor?.marks).toEqual([null, null]);
        expect(normalized(withEditor?.html ?? '')).toBe(normalized(plain?.html ?? ''));
    });
});

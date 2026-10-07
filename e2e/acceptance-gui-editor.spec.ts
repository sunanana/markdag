// GUI 編集の受け入れテスト (ブラウザの面)。置き場の例を 1 件ずつ回す (テストの名前は 面/名前)。
// - screen の例: GUI 編集で開いた図に steps を通し、期待のある段ごとに見えるもの (目印の有無と数、data- の値、選択、開いている入力、フォーカス、原文) を照らす。
//   操作は playwright のマウスとキー (page.mouse と page.keyboard)。段の順と待ちと照らし方は例の読み方の部品、押す点を探すことと見えるものを読むことは
//   ページの中の部品が受け持つ (どちらも確認ページと同じ定義)。変換 (例の requires の ime) は chromium の CDP で起こし、ほかのブラウザではその例を飛ばす
// - frontmatter の例の screen の欄 (mount した図のモード、セグメントの隅、道具箱があるか)。診断と読んだ設定は vitest の受け入れテストが照らす
// 公開の入口 (配布物の markdag/editor と markdag/core) だけを呼ぶ。期待は expect.yaml から読み、ここに写さない。先に npm run build
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { MarkdagEditor } from '../src/editor';
import type * as GuiEditorPage from '../test/acceptance/gui-editor-page';
import type { ScreenProbe } from '../test/acceptance/gui-editor-page';
import {
    CommandDriver,
    GUI_OS_PLATFORM,
    failuresOf,
    inputOf,
    listGuiExamples,
    mountModeOf,
    osOf,
    requirementsOf,
    rowsOf,
    runScreenSteps,
    specProblems,
    type DriveCommand,
    type GuiExample,
    type ScreenSession,
} from '../test/acceptance/gui-editor-examples';

type TestWindow = Window & {
    editorHarness: EditorHarness;
    guiEditorPage?: typeof GuiEditorPage;
    guiEditor?: MarkdagEditor;
    guiScreen?: ScreenProbe;
};

// 例を書き起こした確認ページ (1920x1080 の窓) の図の領域と同じ大きさと置き場。下の端は窓より少し下まで続く
const VIEWPORT = { width: 1920, height: 1080 };
const AREA = { left: 427, top: 72, width: 993, height: 1040 };
// 図の外の入力欄 (例の outside の相手) の置き場。確認ページでは右の横の欄にある
const OUTSIDE = { left: 1440, top: 120, width: 240, height: 24 };
const PAGE_PART = '/test/acceptance/gui-editor-page.ts';

test.use({ viewport: VIEWPORT });

test.beforeAll(() => {
    if (!existsSync(resolve('dist/editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

// 配布物の markdag/editor で例の input.md を開き、ページの中の部品を置く。開いたあとは確認ページと同じく、字体を待ってから全体表示にする。
// 開く前に navigator.platform を例の OS の区分 (書いていなければ mac) に見せかける (GUI 編集は開くときに Enter の修飾キーの割り当てを決めるため)
async function openExample(page: Page, example: GuiExample): Promise<void> {
    await page.addInitScript((platform) => Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform, configurable: true }), GUI_OS_PLATFORM[osOf(example)]);
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.addScriptTag({ type: 'module', content: `import * as part from '${PAGE_PART}'; window.guiEditorPage = part;` });
    await page.waitForFunction(() => 'guiEditorPage' in window);
    await page.evaluate(
        async ({ source, mode, area, outside }) => {
            const target = window as unknown as TestWindow;
            for (const id of ['a', 'b']) document.getElementById(id)?.style.setProperty('display', 'none');
            const place = (element: HTMLElement, rect: typeof area): void => {
                Object.assign(element.style, { position: 'absolute', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
                document.body.append(element);
            };
            const container = document.createElement('div');
            place(container, area);
            const input = document.createElement('input');
            input.setAttribute('aria-label', '図の外の入力欄');
            place(input, outside);
            // 確認ページの既定 (暗い背景) と同じ
            const editor = target.editorHarness.editor.mountEditor(container, source, { mode, animate: false, theme: 'dark' });
            target.guiEditor = editor;
            target.guiScreen = target.guiEditorPage!.createScreenProbe({ container, editor: () => target.guiEditor ?? null, outside: () => input });
            await document.fonts.ready;
            await new Promise((done) => window.setTimeout(done, 300));
            editor.fit();
        },
        { source: inputOf(example), mode: mountModeOf(example), area: AREA, outside: OUTSIDE },
    );
}

// ページの例外とコンソールの誤り (例を通している間に出たもの)
function pageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`ページの例外: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`コンソールの誤り: ${message.text()}`);
    });
    return errors;
}

// 変換中のキー。Chromium の IME と同じく keyCode 229 で送る (Input.imeSetComposition で変換を始めていれば isComposing も true)
async function pressComposing(client: CDPSession, key: string): Promise<void> {
    const event = { key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 };
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

// 運び手の命令を、本物のマウスとキーにする。変換 (compose と composeKey) は chromium の CDP で起こす
const driveWith = (page: Page) => {
    let client: CDPSession | null = null;
    const cdp = async (): Promise<CDPSession> => (client ??= await page.context().newCDPSession(page));
    return async (command: DriveCommand): Promise<void> => {
        if (command.op === 'move') await page.mouse.move(command.x, command.y, { steps: command.steps });
        else if (command.op === 'down') await page.mouse.down({ button: command.button });
        else if (command.op === 'up') await page.mouse.up({ button: command.button });
        else if (command.op === 'click') {
            if (command.count === 2) await page.mouse.dblclick(command.x, command.y, { button: command.button });
            else await page.mouse.click(command.x, command.y, { button: command.button });
        } else if (command.op === 'keyDown') await page.keyboard.down(command.key);
        else if (command.op === 'keyUp') await page.keyboard.up(command.key);
        else if (command.op === 'press') await page.keyboard.press(command.key);
        else if (command.op === 'type') await page.keyboard.type(command.text);
        else if (command.op === 'wheel') await page.mouse.wheel(command.dx, command.dy);
        else if (command.op === 'compose') {
            // 変換を確定するときは insertText (compositionend が届く)。変換中は imeSetComposition (カーソルは変換中の文字の末尾)
            if (command.commit) await (await cdp()).send('Input.insertText', { text: command.text });
            else await (await cdp()).send('Input.imeSetComposition', { text: command.text, selectionStart: command.text.length, selectionEnd: command.text.length });
        } else if (command.op === 'composeKey') await pressComposing(await cdp(), command.key);
    };
};

// 段の通し方が求めることを、ページの中の部品 (window.guiScreen) の呼び出しにする。待ちの ms だけはこちらで待つ
async function sessionOf(page: Page, ime: boolean): Promise<ScreenSession> {
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
    return {
        driver: new CommandDriver('playwright のマウスとキー', driveWith(page), ime),
        mac,
        pointOf: (target) => page.evaluate((target) => (window as unknown as TestWindow).guiScreen!.pointOf(target), target),
        focusOn: (target) => page.evaluate((target) => (window as unknown as TestWindow).guiScreen!.focusOn(target), target),
        beginStep: () => page.evaluate(() => (window as unknown as TestWindow).guiScreen!.beginStep()),
        marqueeOf: (refs) => page.evaluate((refs) => (window as unknown as TestWindow).guiScreen!.marqueeOf(refs), refs),
        blankSpot: () => page.evaluate(() => (window as unknown as TestWindow).guiScreen!.blankSpot()),
        setSource: async (text) => {
            const arrived = await page.evaluate((text) => {
                const editor = (window as unknown as TestWindow).guiEditor!;
                editor.setSource(text);
                return editor.getSource() === text;
            }, text);
            if (!arrived) throw new Error('原文の差し替えが図に届きませんでした');
        },
        setMode: (mode) => page.evaluate((mode) => (window as unknown as TestWindow).guiScreen!.setMode(mode), mode),
        callApi: (name) => page.evaluate((name) => (window as unknown as TestWindow).guiScreen!.callApi(name), name),
        blurWindow: () => page.evaluate(() => (window as unknown as TestWindow).guiScreen!.blurWindow()),
        settle: (ms) => page.evaluate((ms) => (window as unknown as TestWindow).guiEditorPage!.settle(ms), ms),
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        transform: () => page.evaluate(() => (window as unknown as TestWindow).guiScreen!.transform()),
        observe: (before, extra) => page.evaluate(({ before, extra }) => (window as unknown as TestWindow).guiScreen!.observe(before, extra), { before, extra }),
    };
}

test.describe('受け入れの例 @editor: screen', () => {
    const examples = listGuiExamples('screen');
    test('@editor screen の例が 64 件ある', () => {
        expect(examples.length).toBe(64);
    });
    for (const example of examples) {
        test(`@editor ${example.id} (${example.spec.kind})`, async ({ page, browserName }) => {
            test.setTimeout(120_000);
            test.skip(requirementsOf(example).includes('ime') && browserName !== 'chromium', '変換 (requires の ime) は chromium の CDP (Input.imeSetComposition) で起こす');
            expect(specProblems(example)).toEqual([]);
            const errors = pageErrors(page);
            await openExample(page, example);
            const run = await runScreenSteps(example, await sessionOf(page, browserName === 'chromium'));
            const stopped = run.error === null ? [] : [`${run.failedStep ?? '開いたところ'} で止まった: ${run.error}`];
            const skipped = run.skipped === null ? [] : [`飛ばした: ${run.skipped}`];
            expect([...stopped, ...skipped, ...failuresOf(run.rows), ...errors], `${example.id} の通した段: ${run.trace.join(' / ')}`).toEqual([]);
        });
    }
});

test.describe('受け入れの例 @editor: frontmatter (mount した図のモードとセグメント)', () => {
    const examples = listGuiExamples('frontmatter');
    test('@editor frontmatter の例が 9 件ある', () => {
        expect(examples.length).toBe(9);
    });
    for (const example of examples) {
        test(`@editor ${example.id} (${example.spec.kind})`, async ({ page }) => {
            expect(specProblems(example)).toEqual([]);
            const wanted = example.spec.expect?.screen;
            expect(wanted, `${example.id} の expect に screen の欄がない`).toBeDefined();
            const errors = pageErrors(page);
            await openExample(page, example);
            const summary = await page.evaluate(() => (window as unknown as TestWindow).guiScreen!.summary());
            expect([...failuresOf(rowsOf('', { screen: wanted }, { screen: summary }, example.files)), ...errors]).toEqual([]);
        });
    }
});

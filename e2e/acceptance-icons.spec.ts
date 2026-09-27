// アイコン機能の受け入れテスト (ブラウザの面)。testdata/acceptance/icons/ の例を 1 件ずつ回す。
// - screen の例 (11 件): render で描き、DOM と計算値を見る
// - library の例のうち DOM を使うもの (render、createHookBridge + MarkdagView、単体 HTML を開く): DOM を使わない例は test/acceptance-icons.test.ts
// - cli の例の opened の欄 (markdag html が書いた HTML を開いたとき): バイナリは cargo test --workspace が作った target/debug/markdag
// 公開の入口 (harness の markdag、dist/standalone.js、CLI のバイナリ) だけを呼ぶ。期待は expect.yaml から読み、ここに写さない。
// look の欄 (機械で判定しない所) はテストにしない
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from './harness';
import type { IconsProbe, MarkInfo, ProbeBehavior } from './icons-probe';
import type { Diagnostic, MarkdagDiagram } from '../src/index';
import type { buildStandaloneHtml as BuildStandaloneHtml, init as Init } from '../src/standalone';
import {
    BROWSER_LIBRARY_MODES,
    iconRefsOf,
    libraryModeOf,
    listExamples,
    matchAsked,
    matchDiagnostics,
    passesIcons,
    readExampleFile,
    resolverOf,
    standaloneIconsOf,
    unknownKeys,
    type IconExample,
} from '../test/acceptance/icons-examples';

type TestWindow = Window & { harness: Harness; iconsProbe: IconsProbe; diagram: MarkdagDiagram };

interface Snapshot {
    asked: string[];
    marks: MarkInfo[];
    counts: { tag_logos: number; frame_logos: number; legend_logos: number };
    diagnostics: Diagnostic[];
    onDiagnostic: Diagnostic[];
}

const DIST = resolve('dist/standalone.js');
const CLI = resolve('target/debug/markdag');

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/icons-harness.html');
    await page.waitForFunction(() => 'harness' in window && 'iconsProbe' in window);
}

// ---- 照合 ----

// body_marks の map 形 (alias → svg か文字)。同じ alias の印がすべてその様子であること
function checkBodyMarkMap(marks: MarkInfo[], want: Record<string, string>, label: string): string[] {
    const problems: string[] = [];
    for (const [alias, expected] of Object.entries(want)) {
        const found = marks.filter((mark) => mark.alias === alias);
        if (found.length === 0) problems.push(`${label}.${alias}: 印がない`);
        for (const mark of found) {
            const actual = mark.svg ? 'svg' : mark.text;
            if (actual !== expected) problems.push(`${label}.${alias}: 期待 ${JSON.stringify(expected)}、実際 ${JSON.stringify(actual)}`);
        }
    }
    return problems;
}

// right_after_render などの欄 (body_marks、tag_logos、frame_logos、legend_logos)
function checkView(snapshot: Snapshot, want: Record<string, any>, label: string): string[] {
    const problems = unknownKeys(want, ['body_marks', 'tag_logos', 'frame_logos', 'legend_logos'], label);
    if (want.body_marks !== undefined) problems.push(...checkBodyMarkMap(snapshot.marks, want.body_marks, `${label}.body_marks`));
    for (const key of ['tag_logos', 'frame_logos', 'legend_logos'] as const) {
        if (want[key] !== undefined && snapshot.counts[key] !== want[key]) problems.push(`${label}.${key}: 期待 ${want[key]}、実際 ${snapshot.counts[key]}`);
    }
    return problems;
}

// ---- library: render / createHookBridge ----

async function snapshot(page: Page, root = '#a'): Promise<Snapshot> {
    return page.evaluate((selector) => {
        const target = window as unknown as TestWindow;
        const container = document.querySelector(selector)!;
        const probe = target.iconsProbe;
        return {
            asked: [...probe.asked],
            marks: probe.bodyMarks(container),
            counts: probe.counts(container),
            diagnostics: target.diagram ? [...target.diagram.diagnostics] : [],
            onDiagnostic: [...probe.diagnostics],
        };
    }, root);
}

async function settled(page: Page): Promise<void> {
    await page.evaluate(() => (window as unknown as TestWindow).iconsProbe.settled());
}

// render(container, 文書, { icons, resolveIcon, onDiagnostic }) を呼び、戻った直後の様子を返す
async function renderInPage(page: Page, source: string, icons: Record<string, unknown> | null, resolver: Record<string, ProbeBehavior> | null): Promise<Snapshot> {
    await page.evaluate(
        ({ source, icons, resolver }) => {
            const target = window as unknown as TestWindow;
            target.diagram?.destroy();
            target.iconsProbe.reset();
            const container = document.getElementById('a')!;
            target.diagram = target.harness.markdag.render(container, source, {
                ...(icons === null ? {} : { icons }),
                ...(resolver === null ? {} : { resolveIcon: target.iconsProbe.resolver(resolver) }),
                onDiagnostic: target.iconsProbe.onDiagnostic,
            });
        },
        { source, icons, resolver },
    );
    // render が戻った直後 (同じタスクの中) の様子は、次の evaluate までに Promise が済まない (待ちは 50ms 以上) ので、ここで読んでよい
    return snapshot(page);
}

async function runRender(page: Page, example: IconExample): Promise<string[]> {
    const want = example.spec.expect as Record<string, any>;
    const problems = unknownKeys(
        want,
        ['asked', 'right_after_render', 'after_settled', 'diagnostics', 'onDiagnostic', 'asked_after_render', 'asked_after_update_same', 'asked_after_update_new', 'with_icons', 'without_icons'],
        'expect',
    );
    const resolver = resolverOf(example);
    const icons = passesIcons(example) && Object.keys(iconRefsOf(example)).length > 0 ? iconRefsOf(example) : null;

    // with_icons / without_icons: icons と resolveIcon を渡す場合と、どちらも渡さない場合
    for (const [key, passing] of [
        ['with_icons', true],
        ['without_icons', false],
    ] as const) {
        const part = want[key] as Record<string, any> | undefined;
        if (part === undefined) continue;
        problems.push(...unknownKeys(part, ['diagnostics', 'asked', 'body_marks'], key));
        await renderInPage(page, example.input, passing ? icons : null, passing ? resolver : null);
        await settled(page);
        const after = await snapshot(page);
        if (part.diagnostics !== undefined) problems.push(...matchDiagnostics(after.diagnostics, part.diagnostics, `${key}.diagnostics`));
        if (part.asked !== undefined) problems.push(...matchAsked(after.asked, part.asked, `${key}.asked`));
        if (part.body_marks !== undefined) problems.push(...checkBodyMarkMap(after.marks, part.body_marks, `${key}.body_marks`));
    }
    if (want.with_icons !== undefined || want.without_icons !== undefined) return problems;

    const first = await renderInPage(page, example.input, icons, resolver);
    if (want.right_after_render !== undefined) problems.push(...checkView(first, want.right_after_render, 'right_after_render'));
    await settled(page);
    if (want.asked_after_render !== undefined) problems.push(...matchAsked((await snapshot(page)).asked, want.asked_after_render, 'asked_after_render'));

    // call.api に書いた update の順に描き直す。同じ文書なら asked_after_update_same、別の文書なら asked_after_update_new を見る
    const api = String(example.spec.call?.api ?? '');
    for (const [, file] of api.matchAll(/update\(([^)]+)\)/g)) {
        const name = (file ?? '').trim();
        const source = name === 'input.md' ? example.input : readExampleFile(example, name);
        if (source === null) throw new Error(`${example.id}: ${name} がない`);
        await page.evaluate((next) => (window as unknown as TestWindow).diagram.update(next), source);
        await settled(page);
        const key = name === 'input.md' ? 'asked_after_update_same' : 'asked_after_update_new';
        if (want[key] !== undefined) problems.push(...matchAsked((await snapshot(page)).asked, want[key], key));
    }

    const last = await snapshot(page);
    if (want.asked !== undefined) problems.push(...matchAsked(last.asked, want.asked, 'asked'));
    if (want.after_settled !== undefined) problems.push(...checkView(last, want.after_settled, 'after_settled'));
    if (want.diagnostics !== undefined) problems.push(...matchDiagnostics(last.diagnostics, want.diagnostics));
    if (want.onDiagnostic !== undefined) problems.push(...matchDiagnostics(last.onDiagnostic, want.onDiagnostic, 'onDiagnostic'));
    return problems;
}

async function runBridge(page: Page, example: IconExample): Promise<string[]> {
    const want = example.spec.expect as Record<string, any>;
    const problems = unknownKeys(want, ['asked', 'right_after_setDocument', 'after_settled', 'onDiagnostic'], 'expect');
    // createHookBridge({ source, resolveIcon }) → new MarkdagView(container, bridge.viewHooks) → bridge.attach(view) → bridge.setDocument(parsed, model, true)
    await page.evaluate(
        ({ source, resolver }) => {
            const target = window as unknown as TestWindow;
            const { markdag } = target.harness;
            target.iconsProbe.reset();
            const container = document.getElementById('a')!;
            const bridge = markdag.createHookBridge({ source: () => source, resolveIcon: target.iconsProbe.resolver(resolver), onDiagnostic: target.iconsProbe.onDiagnostic });
            const view = new markdag.MarkdagView(container, bridge.viewHooks);
            bridge.attach(view);
            const parsed = markdag.parseDocument(source);
            bridge.setDocument(parsed, markdag.buildModel(parsed.nodes, parsed.frontmatter, source), true);
        },
        { source: example.input, resolver: resolverOf(example) ?? {} },
    );
    const first = await snapshot(page);
    if (want.right_after_setDocument !== undefined) problems.push(...checkView(first, want.right_after_setDocument, 'right_after_setDocument'));
    await settled(page);
    const last = await snapshot(page);
    if (want.asked !== undefined) problems.push(...matchAsked(last.asked, want.asked, 'asked'));
    if (want.after_settled !== undefined) problems.push(...checkView(last, want.after_settled, 'after_settled'));
    if (want.onDiagnostic !== undefined) problems.push(...matchDiagnostics(last.onDiagnostic, want.onDiagnostic, 'onDiagnostic'));
    return problems;
}

// ---- 単体 HTML を開く (library/standalone-mount と cli の opened) ----

async function openStandalone(page: Page, html: string, want: Record<string, any>, label: string): Promise<string[]> {
    const problems = unknownKeys(want, ['body_marks', 'frame_logos', 'tag_logos', 'legend_logos', 'requests'], label);
    const file = test.info().outputPath(`${label.replace(/[^\w-]/g, '_')}.html`);
    writeFileSync(file, html);
    const url = pathToFileURL(file).href;
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto(url);
    await page.waitForFunction(() => 'markdagStandalone' in window && document.querySelector('.mdag-node') !== null);
    // 単体 HTML のページには試験の道具がないので、読むのはここで直接行う
    const view = await page.evaluate(() => {
        const root = document.querySelector('.mdag-standalone') ?? document.body;
        const marks = [...root.querySelectorAll<HTMLElement>('.mdag-node .mdag-content .mdag-icon[data-icon]')].map((mark) => ({ alias: mark.dataset.icon ?? '', svg: mark.querySelector('svg') !== null, text: mark.textContent ?? '' }));
        return {
            marks,
            counts: {
                tag_logos: root.querySelectorAll('.mdag-node .mdag-tags svg').length,
                frame_logos: root.querySelectorAll('svg.mdag-frame-icon').length,
                legend_logos: root.querySelectorAll('.mdag-legend .mdag-icon svg').length,
            },
        };
    });
    const others = requested.filter((item) => item !== url && !item.startsWith('data:') && !item.startsWith('blob:'));
    if (want.requests !== undefined && others.length !== want.requests) problems.push(`${label}.requests: 期待 ${want.requests}、実際 ${others.length} (${others.join(', ')})`);
    const { requests: _requests, ...rest } = want;
    problems.push(...checkView({ asked: [], marks: view.marks as MarkInfo[], counts: view.counts, diagnostics: [], onDiagnostic: [] }, rest, label));
    return problems;
}

async function buildWithDist(options: Parameters<typeof BuildStandaloneHtml>[0]): Promise<string> {
    if (!existsSync(DIST)) throw new Error('dist/standalone.js がない (npm run build を先に実行する)');
    const { buildStandaloneHtml, init } = (await import(pathToFileURL(DIST).href)) as { buildStandaloneHtml: typeof BuildStandaloneHtml; init: typeof Init };
    await init();
    return buildStandaloneHtml(options);
}

async function runStandaloneOpen(page: Page, example: IconExample): Promise<string[]> {
    const html = await buildWithDist({ source: example.input, ...(standaloneIconsOf(example) === undefined ? {} : { icons: standaloneIconsOf(example) }) });
    return openStandalone(page, html, example.spec.expect as Record<string, any>, example.name);
}

// ---- screen ----

const nodeLabel = (text: string): string => text.replace(/\s*\(.*$/, '').trim();

async function hoverNode(page: Page, text: string): Promise<void> {
    const index = await page.evaluate((name) => (window as unknown as TestWindow).iconsProbe.nodeIndex(document.getElementById('a')!, name), text);
    if (index < 0) throw new Error(`ノード「${text}」が見つからない`);
    await page.locator('#a .mdag-node').nth(index).locator('.mdag-box').hover();
}

async function popoverOf(page: Page): Promise<ReturnType<IconsProbe['popover']>> {
    return page.evaluate(() => (window as unknown as TestWindow).iconsProbe.popover(document.getElementById('a')!));
}

function checkMarkFields(mark: MarkInfo | undefined, want: Record<string, any>, label: string): string[] {
    if (!mark) return [`${label}: 印がない`];
    const problems = unknownKeys(want, ['node', 'in', 'icon', 'kind', 'svg', 'text', 'title', 'aria_label', 'role', 'color', 'size', 'font_size', 'svg_html'], label);
    const fields: Array<[string, unknown, unknown]> = [
        ['icon', want.icon, mark.alias],
        ['kind', want.kind, mark.kind],
        ['svg', want.svg, mark.svg],
        ['text', want.text, mark.text],
        ['title', want.title, mark.title],
        ['aria_label', want.aria_label, mark.ariaLabel],
        ['role', want.role, mark.role],
        ['color', want.color, mark.color],
        ['size', want.size, mark.size],
        ['font_size', want.font_size, mark.fontSize],
        ['svg_html', want.svg_html, mark.svgHtml],
    ];
    for (const [name, expected, actual] of fields) {
        if (!(name in want)) continue;
        if (expected !== actual) problems.push(`${label}.${name}: 期待 ${JSON.stringify(expected)}、実際 ${JSON.stringify(actual)}`);
    }
    if (want.node !== undefined && !mark.node.includes(want.node)) problems.push(`${label}.node: 「${want.node}」が「${mark.node}」にない`);
    if (want.node !== undefined || want.in !== undefined) {
        const inDetails = want.in === 'details';
        if (mark.inDetails !== inDetails) problems.push(`${label}.in: 期待 ${want.in ?? '本文'}、実際 ${mark.inDetails ? 'details' : '本文'}`);
    }
    return problems;
}

function checkMarkList(marks: MarkInfo[], want: Array<Record<string, any>>, label: string): string[] {
    if (marks.length !== want.length) return [`${label}: 件数 期待 ${want.length}、実際 ${marks.length} (${JSON.stringify(marks.map((mark) => `${mark.alias}@${mark.node}`))})`];
    return want.flatMap((item, index) => checkMarkFields(marks[index], item, `${label}[${index}]`));
}

function checkPopover(popover: Awaited<ReturnType<typeof popoverOf>>, want: Record<string, any>, label: string): string[] {
    const problems = unknownKeys(want, ['details', 'tag_line', 'popover_hidden'], label);
    if (want.popover_hidden !== undefined && popover.hidden !== want.popover_hidden) problems.push(`${label}.popover_hidden: 期待 ${want.popover_hidden}、実際 ${popover.hidden}`);
    if (want.details !== undefined || want.tag_line !== undefined) {
        if (popover.hidden) problems.push(`${label}: 吹き出しが開いていない`);
    }
    if (want.details !== undefined) problems.push(...checkMarkList(popover.details, want.details, `${label}.details`));
    if (want.tag_line === null && popover.tagLine !== null) problems.push(`${label}.tag_line: 期待 なし、実際 ${JSON.stringify(popover.tagLine)}`);
    if (want.tag_line) {
        const line = want.tag_line as Record<string, any>;
        problems.push(...unknownKeys(line, ['logos', 'text', 'logo_size', 'title'], `${label}.tag_line`));
        if (!popover.tagLine) problems.push(`${label}.tag_line: タグの行がない`);
        else {
            if (line.logos !== undefined && JSON.stringify(popover.tagLine.logos) !== JSON.stringify(line.logos)) problems.push(`${label}.tag_line.logos: 期待 ${JSON.stringify(line.logos)}、実際 ${JSON.stringify(popover.tagLine.logos)}`);
            if (line.text !== undefined && popover.tagLine.text !== line.text) problems.push(`${label}.tag_line.text: 期待 ${JSON.stringify(line.text)}、実際 ${JSON.stringify(popover.tagLine.text)}`);
            for (const mark of popover.tagLine.logoInfo) {
                if (line.logo_size !== undefined && mark.size !== line.logo_size) problems.push(`${label}.tag_line.logo_size: 期待 ${line.logo_size}、実際 ${mark.size}`);
                if ('title' in line && mark.title !== line.title) problems.push(`${label}.tag_line.title: 期待 ${line.title}、実際 ${mark.title}`);
            }
        }
    }
    return problems;
}

const SCREEN_KEYS = [
    'diagnostics',
    'onDiagnostic',
    'body_marks',
    'node_text_has',
    'body',
    'tag',
    'frame',
    'legend',
    'frames',
    'click_frame_logo',
    'icon_elements',
    'tags',
    'tag_logo',
    'frame_label_dx',
    'node_tags_display',
    'before',
    'after',
    'untouched',
    'after_leave',
    'svg_ids',
];

async function runScreen(page: Page, example: IconExample): Promise<string[]> {
    const want = example.spec.expect as Record<string, any>;
    const actionKeys = Object.keys(want).filter((key) => /^(hover|click)_/.test(key) && key !== 'click_frame_logo');
    const problems = unknownKeys(want, [...SCREEN_KEYS, ...actionKeys], 'expect');
    const options = (example.spec.render?.options ?? {}) as Record<string, unknown>;
    problems.push(...unknownKeys(options, ['onDiagnostic'], 'render.options'));
    await page.evaluate(
        ({ source, resolver, withDiagnostic }) => {
            const target = window as unknown as TestWindow;
            target.iconsProbe.reset();
            target.diagram = target.harness.markdag.render(document.getElementById('a')!, source, {
                resolveIcon: target.iconsProbe.resolver(resolver),
                ...(withDiagnostic ? { onDiagnostic: target.iconsProbe.onDiagnostic } : {}),
            });
        },
        { source: example.input, resolver: resolverOf(example) ?? {}, withDiagnostic: 'onDiagnostic' in options },
    );
    await settled(page);
    // 配置の動き (350ms) が済むのを待つ
    await page.waitForTimeout(500);

    const read = <T,>(fn: (probe: IconsProbe, root: HTMLElement) => T): Promise<T> =>
        page.evaluate(`(${fn.toString()})(window.iconsProbe, document.getElementById('a'))`) as Promise<T>;

    const state = await snapshot(page);
    if (want.diagnostics !== undefined) problems.push(...matchDiagnostics(state.diagnostics, want.diagnostics));
    if (want.body_marks !== undefined) problems.push(...checkMarkList(state.marks, want.body_marks, 'body_marks'));
    if (want.node_text_has !== undefined) {
        const texts = await read((probe, root) => probe.nodeTexts(root));
        for (const part of want.node_text_has as string[]) if (!texts.some((text) => text.includes(part))) problems.push(`node_text_has: 「${part}」を含むノードがない (${JSON.stringify(texts)})`);
    }
    // 図の中の id を持つ要素の数と、重なりがないこと (同じ SVG の写しごとの id の付け直し)
    if (want.svg_ids !== undefined) {
        problems.push(...unknownKeys(want.svg_ids, ['count', 'unique'], 'svg_ids'));
        const ids = await read((_probe, root) => [...root.querySelectorAll('[id]')].map((element) => element.id));
        if (want.svg_ids.count !== undefined && ids.length !== want.svg_ids.count) problems.push(`svg_ids.count: 期待 ${want.svg_ids.count}、実際 ${ids.length} (${JSON.stringify(ids)})`);
        if (want.svg_ids.unique === true && new Set(ids).size !== ids.length) problems.push(`svg_ids.unique: id が重なる (${JSON.stringify(ids)})`);
    }
    if (want.icon_elements !== undefined) {
        const count = await read((_probe, root) => root.querySelectorAll('.mdag-icon, .mdag-frame-icon').length);
        if (count !== want.icon_elements) problems.push(`icon_elements: 期待 ${want.icon_elements}、実際 ${count}`);
    }

    // 色 (2 色のロゴの円の塗りとチェックの線)
    for (const where of ['body', 'tag', 'frame', 'legend'] as const) {
        const items = want[where] as Array<Record<string, any>> | undefined;
        // legend の欄は 2 通り: 色の見本 (circle_fill など) と、凡例の行 (group で探す。下で見る)
        if (items === undefined || items.some((item) => 'group' in item)) continue;
        const paints = await page.evaluate(
            ({ where, aliases }) => {
                const probe = (window as unknown as TestWindow).iconsProbe;
                const root = document.getElementById('a')!;
                const pick = (alias: string | null, index: number): Element | null => {
                    if (where === 'body') return [...root.querySelectorAll(`.mdag-node .mdag-content .mdag-icon[data-icon="${alias}"]`)].find((mark) => !mark.closest('.mdag-details')) ?? null;
                    if (where === 'tag') return root.querySelector(`.mdag-node .mdag-tags .mdag-icon[data-icon="${alias}"]`);
                    if (where === 'frame') return root.querySelectorAll('svg.mdag-frame-icon')[index] ?? null;
                    return root.querySelectorAll('.mdag-legend .mdag-icon')[index] ?? null;
                };
                return aliases.map((alias, index) => probe.paints(pick(alias, index)));
            },
            { where, aliases: items.map((item) => (item.icon as string | undefined) ?? null) },
        );
        items.forEach((item, index) => {
            const actual = paints[index];
            problems.push(...unknownKeys(item, ['icon', 'color', 'circle_fill', 'check_stroke'], `${where}[${index}]`));
            if (!actual) {
                problems.push(`${where}[${index}]: ロゴがない`);
                return;
            }
            for (const key of ['color', 'circle_fill', 'check_stroke'] as const) {
                if (item[key] !== undefined && actual[key] !== item[key]) problems.push(`${where}[${index}].${key}: 期待 ${item[key]}、実際 ${actual[key]}`);
            }
        });
    }

    if (want.frames !== undefined || want.frame_label_dx !== undefined || want.click_frame_logo !== undefined) {
        const frames = await read((probe, root) => probe.frames(root));
        for (const [index, item] of ((want.frames ?? []) as Array<Record<string, any>>).entries()) {
            const label = `frames[${index}]`;
            problems.push(...unknownKeys(item, ['group', 'logo', 'label_dx', 'logo_y_from_label'], label));
            const frame = frames.find((entry) => entry.group === item.group);
            if (!frame) {
                problems.push(`${label}: グループ ${item.group} の枠がない`);
                continue;
            }
            if (item.label_dx !== undefined && frame.labelX - frame.rectX !== item.label_dx) problems.push(`${label}.label_dx: 期待 ${item.label_dx}、実際 ${frame.labelX - frame.rectX}`);
            if (item.logo === null && frame.logo !== null) problems.push(`${label}.logo: 期待 なし、実際あり`);
            if (item.logo) {
                problems.push(...unknownKeys(item.logo, ['dx', 'width', 'height', 'color', 'title'], `${label}.logo`));
                if (!frame.logo) problems.push(`${label}.logo: ロゴがない`);
                else {
                    const logo = frame.logo;
                    const actual: Record<string, unknown> = { dx: logo.x - frame.rectX, width: logo.width, height: logo.height, color: logo.color, title: logo.title };
                    for (const key of Object.keys(item.logo)) if (actual[key] !== item.logo[key]) problems.push(`${label}.logo.${key}: 期待 ${JSON.stringify(item.logo[key])}、実際 ${JSON.stringify(actual[key])}`);
                    if (item.logo_y_from_label !== undefined && logo.y - frame.labelY !== item.logo_y_from_label) problems.push(`${label}.logo_y_from_label: 期待 ${item.logo_y_from_label}、実際 ${logo.y - frame.labelY}`);
                }
            }
        }
        if (want.frame_label_dx !== undefined) {
            if (frames.length === 0) problems.push('frame_label_dx: 枠がない');
            for (const frame of frames) if (frame.labelX - frame.rectX !== want.frame_label_dx) problems.push(`frame_label_dx: 期待 ${want.frame_label_dx}、実際 ${frame.labelX - frame.rectX}`);
        }
        if (want.click_frame_logo !== undefined) {
            // 薄くならないロゴつきの枠 (1 つ) のロゴをクリックする
            const dimmed = (want.click_frame_logo.dimmed ?? []) as string[];
            problems.push(...unknownKeys(want.click_frame_logo, ['dimmed'], 'click_frame_logo'));
            const clicked = frames.filter((frame) => frame.logo !== null && !dimmed.includes(frame.group ?? ''));
            if (clicked.length !== 1) problems.push(`click_frame_logo: クリックするロゴを 1 つに決められない (${clicked.map((frame) => frame.group).join(', ')})`);
            else {
                await page.locator(`#a svg.mdag-frame-icon[data-group="${clicked[0]!.group}"]`).click();
                const after = await read((probe, root) => probe.frames(root));
                for (const frame of after) {
                    const faded = frame.opacity === '0.35';
                    if (faded !== dimmed.includes(frame.group ?? '')) problems.push(`click_frame_logo: ${frame.group} のラベルの薄さ 期待 ${dimmed.includes(frame.group ?? '') ? '薄い' : 'そのまま'}、実際 ${frame.opacity || 'そのまま'}`);
                }
            }
        }
    }

    if (want.legend !== undefined && (want.legend as Array<Record<string, any>>).some((item) => 'group' in item)) {
        const legend = await read((probe, root) => probe.legend(root));
        for (const [index, item] of (want.legend as Array<Record<string, any>>).entries()) {
            const label = `legend[${index}]`;
            problems.push(...unknownKeys(item, ['group', 'order', 'chip', 'logo_size', 'title'], label));
            const entry = legend.find((row) => row.text.includes(item.group));
            if (!entry) {
                problems.push(`${label}: 「${item.group}」の行がない`);
                continue;
            }
            if (item.order !== undefined && JSON.stringify(entry.order) !== JSON.stringify(item.order)) problems.push(`${label}.order: 期待 ${JSON.stringify(item.order)}、実際 ${JSON.stringify(entry.order)}`);
            if (item.chip !== undefined && entry.chip !== item.chip) problems.push(`${label}.chip: 期待 ${item.chip}、実際 ${entry.chip}`);
            if (item.logo_size !== undefined && entry.logoSize !== item.logo_size) problems.push(`${label}.logo_size: 期待 ${item.logo_size}、実際 ${entry.logoSize}`);
            if ('title' in item && entry.title !== item.title) problems.push(`${label}.title: 期待 ${item.title}、実際 ${entry.title}`);
        }
    }

    if (want.tags !== undefined || want.tag_logo !== undefined || want.node_tags_display !== undefined) {
        const tags = await read((probe, root) => probe.tags(root));
        if (want.tags !== undefined) {
            const items = want.tags as Array<string | Record<string, any>>;
            if (tags.length !== items.length) problems.push(`tags: 件数 期待 ${items.length}、実際 ${tags.length}`);
            items.forEach((item, index) => {
                const actual = tags[index];
                if (!actual) return;
                if (typeof item === 'string') {
                    // 文字だけのタグ (.mdag-tags の innerHTML がそのまま文字)
                    if (actual.html !== item) problems.push(`tags[${index}]: 期待 ${JSON.stringify(item)}、実際 ${JSON.stringify(actual.html)}`);
                    return;
                }
                problems.push(...unknownKeys(item, ['logos', 'text'], `tags[${index}]`));
                if (item.logos !== undefined && JSON.stringify(actual.logos) !== JSON.stringify(item.logos)) problems.push(`tags[${index}].logos: 期待 ${JSON.stringify(item.logos)}、実際 ${JSON.stringify(actual.logos)}`);
                if (item.text !== undefined && actual.text !== item.text) problems.push(`tags[${index}].text: 期待 ${JSON.stringify(item.text)}、実際 ${JSON.stringify(actual.text)}`);
            });
        }
        if (want.tag_logo !== undefined) {
            problems.push(...unknownKeys(want.tag_logo, ['size', 'color', 'title'], 'tag_logo'));
            const logos = tags.flatMap((entry) => entry.logoInfo);
            if (logos.length === 0) problems.push('tag_logo: タグのロゴがない');
            for (const logo of logos) problems.push(...checkMarkFields(logo, want.tag_logo, `tag_logo(${logo.alias})`));
        }
        if (want.node_tags_display !== undefined) {
            if (tags.length === 0) problems.push('node_tags_display: ノードのタグがない');
            for (const entry of tags) if (entry.display !== want.node_tags_display) problems.push(`node_tags_display: 期待 ${want.node_tags_display}、実際 ${entry.display} (${entry.node})`);
        }
    }

    // 操作 (actions) を順に行い、hover_<名前> / after_leave / click_<名前> / before / after を見る
    const actions = (example.spec.actions ?? []) as Array<Record<string, string>>;
    let leaveChecked = false;
    let hovered: string | null = null;
    const checkLeave = async (): Promise<void> => {
        if (leaveChecked || want.after_leave === undefined) return;
        leaveChecked = true;
        await page.mouse.move(1200, 100);
        await page.waitForTimeout(350);
        problems.push(...checkPopover(await popoverOf(page), want.after_leave, 'after_leave'));
    };
    for (const action of actions) {
        problems.push(...unknownKeys(action, ['hover', 'click', 'call'], 'actions[]'));
        if (action.hover !== undefined) {
            hovered = nodeLabel(action.hover);
            await hoverNode(page, hovered);
            await page.waitForTimeout(350);
            const key = `hover_${hovered}`;
            if (want[key] !== undefined) problems.push(...checkPopover(await popoverOf(page), want[key], key));
            continue;
        }
        await checkLeave();
        if (action.click !== undefined) {
            const match = /^(.*?) の \.mdag-note-mark$/.exec(action.click);
            if (!match?.[1]) throw new Error(`${example.id}: click の指定を読めない: ${action.click}`);
            const index = await page.evaluate((name) => (window as unknown as TestWindow).iconsProbe.nodeIndex(document.getElementById('a')!, name), match[1]);
            await page.locator('#a .mdag-node').nth(index).locator('.mdag-note-mark').click();
            await page.waitForTimeout(100);
            const key = `click_${match[1]}`;
            if (want[key] !== undefined) problems.push(...checkPopover(await popoverOf(page), want[key], key));
            continue;
        }
        if (action.call !== undefined) {
            const match = /view\.setIconSvg\("([^"]+)",\s*(\S+\.svg)/.exec(action.call);
            if (!match?.[1] || !match[2]) throw new Error(`${example.id}: call の指定を読めない: ${action.call}`);
            const svg = readExampleFile(example, match[2]);
            const untouched = want.untouched as string | undefined;
            const shapes = async () => ({
                node_logos: hovered === null ? [] : await page.evaluate((name) => (window as unknown as TestWindow).iconsProbe.nodeLogoShapes(document.getElementById('a')!, name), hovered),
                frame: (await read((probe, root) => probe.frames(root))).flatMap((frame) => (frame.logo ? [frame.logo.shape] : [])),
                legend: (await read((probe, root) => probe.legend(root))).flatMap((row) => (row.shape === null ? [] : [row.shape])),
                popover: (await popoverOf(page)).shapes,
                popover_hidden: (await popoverOf(page)).hidden,
            });
            const compare = (actual: Record<string, unknown>, expected: Record<string, unknown> | undefined, label: string): void => {
                if (expected === undefined) return;
                problems.push(...unknownKeys(expected, ['node_logos', 'frame', 'legend', 'popover', 'popover_hidden'], label));
                for (const key of Object.keys(expected)) if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) problems.push(`${label}.${key}: 期待 ${JSON.stringify(expected[key])}、実際 ${JSON.stringify(actual[key])}`);
            };
            compare(await shapes(), want.before, 'before');
            if (untouched !== undefined) {
                await page.evaluate((alias) => {
                    (window as unknown as { kept: Element | null }).kept = document.querySelector(`#a .mdag-node .mdag-content .mdag-icon[data-icon="${alias}"] svg`);
                }, untouched);
            }
            await page.evaluate(({ ref, svg }) => (window as unknown as TestWindow).diagram.view.setIconSvg(ref, svg), { ref: match[1], svg });
            await page.waitForTimeout(100);
            compare(await shapes(), want.after, 'after');
            if (untouched !== undefined) {
                const same = await page.evaluate((alias) => {
                    const kept = (window as unknown as { kept: Element | null }).kept;
                    return kept !== null && kept.isConnected && kept === document.querySelector(`#a .mdag-node .mdag-content .mdag-icon[data-icon="${alias}"] svg`);
                }, untouched);
                if (!same) problems.push(`untouched: ${untouched} のロゴの要素が作り直された`);
            }
            continue;
        }
    }
    await checkLeave();
    for (const key of actionKeys) {
        const name = key.replace(/^(hover|click)_/, '');
        const done = actions.some((action) => (action.hover !== undefined && nodeLabel(action.hover) === name) || (action.click ?? '').startsWith(`${name} の`));
        if (!done) problems.push(`${key}: actions にその操作がない`);
    }
    if (want.onDiagnostic !== undefined) problems.push(...matchDiagnostics((await snapshot(page)).onDiagnostic, want.onDiagnostic, 'onDiagnostic'));
    return problems;
}

// ---- 試験 ----

test.describe('受け入れの例: library (DOM を使う例)', () => {
    const examples = listExamples('library').filter((example) => BROWSER_LIBRARY_MODES.includes(libraryModeOf(example)));

    for (const example of examples) {
        test(`${example.id} (${example.spec.kind})`, async ({ page }) => {
            expect(unknownKeys(example.spec, ['kind', 'checks', 'call', 'expect'], example.id)).toEqual([]);
            const mode = libraryModeOf(example);
            if (mode !== 'standalone-open') await open(page);
            const problems = mode === 'render' ? await runRender(page, example) : mode === 'bridge' ? await runBridge(page, example) : await runStandaloneOpen(page, example);
            expect(problems).toEqual([]);
        });
    }
});

test.describe('受け入れの例: screen', () => {
    for (const example of listExamples('screen')) {
        test(`${example.id} (${example.spec.kind})`, async ({ page }) => {
            expect(unknownKeys(example.spec, ['kind', 'checks', 'render', 'actions', 'expect', 'look'], example.id)).toEqual([]);
            await open(page);
            expect(await runScreen(page, example)).toEqual([]);
        });
    }
});

test.describe('受け入れの例: cli の opened (書いた HTML を開く)', () => {
    const steps = listExamples('cli').flatMap((example) => {
        const list = example.spec.commands ?? [{ command: example.spec.command, expect: example.spec.expect }];
        return (list as Array<{ command: string; expect: Record<string, any> }>).filter((step) => step.expect?.opened !== undefined).map((step) => ({ example, step }));
    });

    for (const { example, step } of steps) {
        test(`${example.id} の opened (${example.spec.kind})`, async ({ page }) => {
            if (!existsSync(CLI)) throw new Error('target/debug/markdag がない (cargo test --workspace を先に実行する)');
            const words = step.command.trim().split(/\s+/).slice(1);
            const out = test.info().outputPath('out.html');
            mkdirSync(dirname(out), { recursive: true });
            const args = words.map((word, index) => (words[index - 1] === '-o' ? out : word));
            const ran = spawnSync(CLI, args, { cwd: example.dir, encoding: 'utf8' });
            expect(ran.status, ran.stderr).toBe(0);
            expect(await openStandalone(page, readFileSync(out, 'utf8'), step.expect.opened, `${example.name}-opened`)).toEqual([]);
        });
    }
});

// 受け入れの例 screen/unresolved-and-sanitize (script や onload は取り除いて描く) と library/standalone-mount (ネットワークに出ない) に準じた回帰。
// 属性の区切りが空白でない書き方、分けて書いた script、外への読み込みを resolveIcon が返しても、alert も外への要求も出ない
test.describe('回帰: ロゴの SVG の sanitize (画面に入れたあと)', () => {
    const dirty: Record<string, string> = {
        'a:onerror': '<svg viewBox="0 0 1 1"><img src="x"onerror="alert(1)"></svg>',
        'a:rect': '<svg viewBox="0 0 1 1"><rect width="1"height="1"onmouseover="alert(1)"/></svg>',
        'a:slash': '<svg viewBox="0 0 1 1"><rect/onload="alert(1)"/></svg>',
        'a:root': '<svg xmlns="http://www.w3.org/2000/svg"onload="alert(1)"><path d="M0 0"/></svg>',
        'a:split': '<svg viewBox="0 0 1 1"><scr<script>ipt>alert(1)</scr<script>ipt></svg>',
        'a:image': '<svg viewBox="0 0 1 1"><image x="0"href="https://example.com/t.png"/></svg>',
        'a:img': '<svg viewBox="0 0 1 1"><img src="https://example.com/p.png"></svg>',
        'a:style': '<svg viewBox="0 0 1 1"><rect width="1" height="1" style="fill:url(https://example.com/x.svg#a)"/></svg>',
        'a:after': '<svg viewBox="0 0 1 1"></svg><img src="https://example.com/p.png"><svg></svg>',
    };
    const aliases = Object.keys(dirty).map((ref) => ref.slice(2));
    const source = ['---', 'markdag:', '    icons:', ...aliases.map((alias) => `        ${alias}: a:${alias}`), '---', '# R', ...aliases.map((alias) => `## :${alias}: ${alias}`)].join('\n');

    test('alert が出ず、ページのほかに要求が出ない', async ({ page }) => {
        const dialogs: string[] = [];
        page.on('dialog', (dialog) => {
            dialogs.push(dialog.message());
            void dialog.dismiss();
        });
        await open(page);
        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        const resolver = Object.fromEntries(Object.entries(dirty).map(([ref, svg]) => [ref, { how: 'sync', content: svg } as ProbeBehavior]));
        const result = await renderInPage(page, source, null, resolver);
        await settled(page);
        await page.locator('#a .mdag-node').nth(1).locator('.mdag-box').hover();
        await page.waitForTimeout(300);
        expect(dialogs).toEqual([]);
        expect(requested).toEqual([]);
        // SVG として読めるものはロゴになり、svg の後ろに要素が続くものは文字のまま
        const drawn = Object.fromEntries(result.marks.map((mark) => [mark.alias, mark.svg]));
        expect(drawn).toEqual({ onerror: true, rect: true, slash: true, root: true, split: true, image: true, img: true, style: true, after: false });
        const html = await page.evaluate(() => document.getElementById('a')!.innerHTML);
        expect(html).not.toMatch(/on(error|load|mouseover)=|<script|<img|example\.com/i);
    });
});

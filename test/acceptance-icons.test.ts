// アイコン機能の受け入れテスト (library の面のうち DOM を使わない例)。testdata/acceptance/icons/library/ の例を 1 件ずつ回す。
// 公開の入口 (src/index の parseDocument と buildModel、src/standalone の buildStandaloneHtml) だけを呼ぶ。
// DOM を使う例 (render、createHookBridge + MarkdagView、単体 HTML を開く) は e2e/acceptance-icons.spec.ts が回す。
// 例を足せば試験も増える。期待は expect.yaml から読み、ここに写さない
import { describe, expect, it } from 'vitest';
import { buildModel, parseDocument, type GraphModel, type OutlineNode } from '../src/index';
import { buildStandaloneHtml } from '../src/standalone';
import {
    BROWSER_LIBRARY_MODES,
    embeddedDataOf,
    iconRefsOf,
    libraryModeOf,
    listExamples,
    matchDiagnostics,
    passesIcons,
    standaloneIconsOf,
    unknownKeys,
    type IconExample,
} from './acceptance/icons-examples';

const EXAMPLES = listExamples('library');

const marksOf = (html: string | null): string[] => [...(html ?? '').matchAll(/<span class="mdag-icon" data-icon="([^"]+)"/g)].map((match) => match[1] ?? '');

function checkModel(example: IconExample, nodes: OutlineNode[], model: GraphModel): string[] {
    const want = example.spec.expect as Record<string, any>;
    const problems = unknownKeys(want, ['diagnostics', 'icons', 'tagKeys', 'groups', 'nodes'], 'expect');
    if (want.diagnostics !== undefined) problems.push(...matchDiagnostics(model.diagnostics, want.diagnostics));
    if (want.icons !== undefined) {
        problems.push(...unknownKeys(want.icons, ['color', 'aliases'], 'icons'));
        if (want.icons.color !== undefined && model.icons.color !== want.icons.color) problems.push(`icons.color: 期待 ${want.icons.color}、実際 ${model.icons.color}`);
        if (want.icons.aliases !== undefined) {
            // 並びも含めて全件
            const actual = [...model.icons.aliases].map(([name, def]) => [name, { kind: def.kind, ref: def.ref, ...(def.color === undefined ? {} : { color: def.color }) }]);
            const expected = Object.entries(want.icons.aliases as Record<string, unknown>);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`icons.aliases: 期待 ${JSON.stringify(expected)}、実際 ${JSON.stringify(actual)}`);
        }
    }
    for (const [key, fields] of Object.entries((want.tagKeys ?? {}) as Record<string, Record<string, unknown>>)) {
        const def = model.tagKeys.find((item) => item.key === key);
        if (!def) {
            problems.push(`tagKeys.${key}: キーがない`);
            continue;
        }
        problems.push(...unknownKeys(fields, ['icons', 'icon'], `tagKeys.${key}`));
        for (const field of ['icons', 'icon'] as const) {
            if (!(field in fields)) continue;
            // null は欄がないこと
            const actual = def[field] === undefined ? null : def[field];
            if (JSON.stringify(actual) !== JSON.stringify(fields[field])) problems.push(`tagKeys.${key}.${field}: 期待 ${JSON.stringify(fields[field])}、実際 ${JSON.stringify(actual)}`);
        }
    }
    for (const [id, icon] of Object.entries((want.groups ?? {}) as Record<string, unknown>)) {
        const group = model.groups.find((item) => item.id === id);
        if (!group) {
            problems.push(`groups.${id}: グループがない`);
            continue;
        }
        const actual = group.icon === undefined ? null : group.icon;
        if (actual !== icon) problems.push(`groups.${id}.icon: 期待 ${JSON.stringify(icon)}、実際 ${JSON.stringify(actual)}`);
    }
    for (const wanted of (want.nodes ?? []) as Array<Record<string, any>>) {
        problems.push(...unknownKeys(wanted, ['refText', 'marks', 'details_marks', 'html_has', 'milestone', 'tags'], 'nodes[]'));
        const found = nodes.filter((node) => node.refText === wanted.refText);
        const label = `nodes「${wanted.refText}」`;
        if (found.length !== 1) {
            problems.push(`${label}: refText の一致するノードが ${found.length} 件 (実際の refText: ${JSON.stringify(nodes.map((node) => node.refText))})`);
            continue;
        }
        const node = found[0]!;
        if (wanted.marks !== undefined && JSON.stringify(marksOf(node.html)) !== JSON.stringify(wanted.marks)) problems.push(`${label}.marks: 期待 ${JSON.stringify(wanted.marks)}、実際 ${JSON.stringify(marksOf(node.html))}`);
        if (wanted.details_marks !== undefined && JSON.stringify(marksOf(node.details)) !== JSON.stringify(wanted.details_marks)) {
            problems.push(`${label}.details_marks: 期待 ${JSON.stringify(wanted.details_marks)}、実際 ${JSON.stringify(marksOf(node.details))}`);
        }
        if (wanted.html_has !== undefined && !node.html.includes(wanted.html_has)) problems.push(`${label}.html_has: ${JSON.stringify(wanted.html_has)} が html ${JSON.stringify(node.html)} にない`);
        if (wanted.milestone !== undefined && node.milestone !== wanted.milestone) problems.push(`${label}.milestone: 期待 ${wanted.milestone}、実際 ${node.milestone}`);
        if (wanted.tags !== undefined) {
            const actual = (model.tagsOf.get(node.id) ?? []).map((tag) => ({ key: tag.key, values: tag.values }));
            if (JSON.stringify(actual) !== JSON.stringify(wanted.tags)) problems.push(`${label}.tags: 期待 ${JSON.stringify(wanted.tags)}、実際 ${JSON.stringify(actual)}`);
        }
    }
    return problems;
}

function runModel(example: IconExample): string[] {
    const parsed = parseDocument(example.input);
    const model = buildModel(parsed.nodes, parsed.frontmatter, example.input, passesIcons(example) ? { icons: iconRefsOf(example) } : {});
    return checkModel(example, parsed.nodes, model);
}

// 素材の欄の照合。keys は並びも一致、icons_keys は並びを問わない、icons と iconAliases は書いた ref の値が一致
function checkEmbedded(data: Record<string, unknown>, want: Record<string, any>, label: string): string[] {
    const problems = unknownKeys(want, ['keys', 'icons_keys', 'icons', 'iconAliases'], label);
    if (want.keys !== undefined && JSON.stringify(Object.keys(data)) !== JSON.stringify(want.keys)) problems.push(`${label}.keys: 期待 ${JSON.stringify(want.keys)}、実際 ${JSON.stringify(Object.keys(data))}`);
    const icons = (data.icons ?? {}) as Record<string, unknown>;
    if (want.icons_keys !== undefined && JSON.stringify(Object.keys(icons).sort()) !== JSON.stringify([...want.icons_keys].sort())) {
        problems.push(`${label}.icons_keys: 期待 ${JSON.stringify(want.icons_keys)}、実際 ${JSON.stringify(Object.keys(icons))}`);
    }
    for (const [ref, svg] of Object.entries((want.icons ?? {}) as Record<string, unknown>)) {
        if (icons[ref] !== svg) problems.push(`${label}.icons["${ref}"]: 期待 ${JSON.stringify(svg)}、実際 ${JSON.stringify(icons[ref])}`);
    }
    if (want.iconAliases !== undefined && JSON.stringify(data.iconAliases) !== JSON.stringify(want.iconAliases)) {
        problems.push(`${label}.iconAliases: 期待 ${JSON.stringify(want.iconAliases)}、実際 ${JSON.stringify(data.iconAliases)}`);
    }
    return problems;
}

function runStandaloneBuild(example: IconExample): string[] {
    const want = example.spec.expect as Record<string, any>;
    const problems = unknownKeys(want, ['embedded', 'html_lacks', 'without_icons', 'empty_icons'], 'expect');
    const refs = iconRefsOf(example);
    // 例の呼び方どおりに組む: 渡す欄は call に書いたもの (iconAliases は $ref の中身、icons は ref → SVG)
    const withCall = (): string =>
        buildStandaloneHtml({
            source: example.input,
            ...(example.spec.call?.iconAliases !== undefined ? { iconAliases: refs } : {}),
            ...(standaloneIconsOf(example) !== undefined ? { icons: standaloneIconsOf(example) } : {}),
        });
    if (want.embedded !== undefined || want.html_lacks !== undefined) {
        const html = withCall();
        if (want.embedded !== undefined) problems.push(...checkEmbedded(embeddedDataOf(html), want.embedded, 'embedded'));
        for (const word of (want.html_lacks ?? []) as string[]) if (html.includes(word)) problems.push(`html_lacks: HTML に ${word} がある`);
    }
    if (want.without_icons !== undefined) problems.push(...checkEmbedded(embeddedDataOf(buildStandaloneHtml({ source: example.input })), want.without_icons, 'without_icons'));
    if (want.empty_icons !== undefined) problems.push(...checkEmbedded(embeddedDataOf(buildStandaloneHtml({ source: example.input, icons: {} })), want.empty_icons, 'empty_icons'));
    return problems;
}

describe('受け入れの例: library (DOM を使わない例)', () => {
    it('library の DOM を使わない例が 27 件ある', () => {
        expect(EXAMPLES.length).toBe(27);
    });

    for (const example of EXAMPLES) {
        const mode = libraryModeOf(example);
        if (BROWSER_LIBRARY_MODES.includes(mode)) continue;
        it(`${example.id} (${example.spec.kind})`, () => {
            expect(unknownKeys(example.spec, ['kind', 'checks', 'call', 'expect'], example.id)).toEqual([]);
            const problems = mode === 'model' ? runModel(example) : runStandaloneBuild(example);
            expect(problems).toEqual([]);
        });
    }
});

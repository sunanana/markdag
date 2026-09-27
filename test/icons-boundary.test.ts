// アイコン機能の境界 (Rust と TS が同じ形を出し入れする所) の一致を固定する単体テスト。
// 入力と期待値は testdata/unit/icons/ の JSON で、Rust の側 (crates/markdag-core/tests/icons_boundary.rs、crates/markdag-cli/tests/html.rs) も同じファイルを読む。
// source は行の配列で、"\n" でつないで末尾に "\n" を足したものを原文にする。provided は markdag.icons.$ref の中身 (ModelOptions.icons)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel, iconDefOf, renderDocument, type IconDef, type IconTable } from '../src/model/model';
import { suggestTagKeys, suggestTagValues } from '../src/model/tags';
import { parseDocument, ICON_MARK } from '../src/parse/document';
import { DATA_ID, renderStandalonePage } from '../src/standalone/page';
import { documentIconRefs, iconMarkHtml, IconSvgStore, renderIconMarks } from '../src/view/icons';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(`../testdata/unit/icons/${name}`, import.meta.url)), 'utf8')) as T;

interface Case {
    name: string;
    source: string[];
    provided?: Record<string, unknown>;
}

const sourceOf = (item: Pick<Case, 'source'>): string => `${item.source.join('\n')}\n`;

const emptyContext = { icons: { color: 'mono', aliases: new Map() } as IconTable, svgOf: () => undefined };

describe('本文の印の要素 (Rust の render_icon_mark、TS の ICON_MARK と plainMark)', () => {
    const marks = fixture<{ source: string[]; marks: Array<{ alias: string; html: string }>; texts: string[] }>('marks.json');
    const { parsed } = renderDocument(sourceOf(marks));
    const html = parsed.nodes.map((node) => node.html).join('\n');

    it('解析が書いた印の要素は共有の文字列と同じで、それ以外の :word: は文字のまま', () => {
        for (const mark of marks.marks) expect(html).toContain(mark.html);
        for (const text of marks.texts) expect(html).toContain(text);
    });

    it('TS の ICON_MARK は解析が書いた印の要素すべてに当たり、1 番の組が alias', () => {
        expect([...html.matchAll(ICON_MARK)].map(([whole, alias]) => [whole, alias])).toEqual(marks.marks.map((mark) => [mark.html, mark.alias]));
    });

    it('引けない印 (表にない、SVG がまだない、引けなかった) を描く plainMark は、解析が書いた要素と同じ文字列', () => {
        const store = new IconSvgStore();
        store.set('./a.svg', null);
        const table: IconTable = { color: 'mono', aliases: new Map([['a', { kind: 'path', ref: './a.svg' }]]) };
        for (const mark of marks.marks) {
            expect(iconMarkHtml(mark.alias, emptyContext)).toBe(mark.html);
            expect(iconMarkHtml(mark.alias, { icons: table, svgOf: () => undefined })).toBe(mark.html);
            expect(iconMarkHtml(mark.alias, { icons: table, svgOf: (ref) => store.get(ref) })).toBe(mark.html);
        }
        expect(renderIconMarks(html, emptyContext)).toBe(html);
    });

    it('ICON_MARK は属性と中身の alias が違う要素、属性の並びやクラスの違う要素に当たらない', () => {
        for (const other of [
            '<span class="mdag-icon" data-icon="a">:b:</span>',
            '<span data-icon="a" class="mdag-icon">:a:</span>',
            '<span class="mdag-icon x" data-icon="a">:a:</span>',
            '<span class="mdag-icon" data-icon="A">:A:</span>',
        ]) {
            expect([...other.matchAll(ICON_MARK)]).toEqual([]);
        }
    });
});

describe('文書が描くのに要る ref (Rust の document_icon_defs と TS の documentIconRefs)', () => {
    const cases = fixture<Array<Case & { refs: string[] }>>('refs.json');

    it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
        const { parsed, model } = renderDocument(sourceOf(item), { icons: item.provided });
        expect([...documentIconRefs(parsed.nodes, model)]).toEqual(item.refs);
        // buildModel の経路 (解析と組み立てを分けて呼ぶ) でも同じ
        const split = parseDocument(sourceOf(item));
        expect([...documentIconRefs(split.nodes, buildModel(split.nodes, split.frontmatter, sourceOf(item), { icons: item.provided }))]).toEqual(item.refs);
    });
});

describe('名前の引き方 (Rust の icon_def_of と TS の iconDefOf)', () => {
    // Rust の icon_uses の単体テストと同じ表と答え
    it('表の alias が先、なければ : を含む名前を set:name とみなす', () => {
        const icons: IconTable = {
            color: 'mono',
            aliases: new Map<string, IconDef>([
                ['gh', { kind: 'path', ref: './github.svg' }],
                ['fire', { kind: 'emoji', ref: '🔥' }],
                ['k8s', { kind: 'set', ref: 'simple-icons:kubernetes', color: 'original' }],
            ]),
        };
        const cases: Array<[string, IconDef | null]> = [
            ['gh', { kind: 'path', ref: './github.svg' }],
            ['fire', { kind: 'emoji', ref: '🔥' }],
            ['k8s', { kind: 'set', ref: 'simple-icons:kubernetes', color: 'original' }],
            ['logos:aws', { kind: 'set', ref: 'logos:aws' }],
            ['Not:A:Set', { kind: 'set', ref: 'Not:A:Set' }],
            ['nope', null],
            ['', null],
        ];
        for (const [name, expected] of cases) expect(iconDefOf(icons, name), name).toEqual(expected);
    });

    it('wasm が返した表から引いても同じ', () => {
        const { model } = renderDocument(['---', 'markdag:', '  icons:', '    gh: ./github.svg', '    fire: "🔥"', '    k8s: { ref: simple-icons:kubernetes, color: original }', '---', '# R'].join('\n'));
        expect(iconDefOf(model.icons, 'k8s')).toEqual({ kind: 'set', ref: 'simple-icons:kubernetes', color: 'original' });
        expect(iconDefOf(model.icons, 'gh')).toEqual({ kind: 'path', ref: './github.svg' });
        expect(Object.keys(iconDefOf(model.icons, 'gh') ?? {})).toEqual(['kind', 'ref']);
        expect(iconDefOf(model.icons, 'logos:aws')).toEqual({ kind: 'set', ref: 'logos:aws' });
        expect(iconDefOf(model.icons, 'nope')).toBeNull();
    });
});

describe('GraphModel.icons と TagKeyDef / GroupDef の欄 (Rust の JSON と TS の包み)', () => {
    type TableCase = Case & {
        icons: { color: string; aliases: Array<[string, IconDef]> } | null;
        tagKeys?: Record<string, { icons: Record<string, string> | null; icon: string | null }>;
        groups?: Record<string, string | null>;
    };
    const cases = fixture<TableCase[]>('tables.json');

    it.each(cases.map((item) => [item.name, item] as const))('%s', (_name, item) => {
        const { model } = renderDocument(sourceOf(item), { icons: item.provided });
        // Rust が欄を省いたときは既定の表 (mono、空の Map) で埋める
        expect(model.icons).toEqual({ color: item.icons?.color ?? 'mono', aliases: new Map(item.icons?.aliases ?? []) });
        expect([...model.icons.aliases.keys()]).toEqual((item.icons?.aliases ?? []).map(([alias]) => alias));
        for (const [key, fields] of Object.entries(item.tagKeys ?? {})) {
            const def = model.tagKeys.find((entry) => entry.key === key);
            expect(def, key).toBeDefined();
            if (fields.icons === null) expect(Object.hasOwn(def ?? {}, 'icons'), `${key}.icons`).toBe(false);
            else expect(def?.icons).toEqual(fields.icons);
            if (fields.icon === null) expect(Object.hasOwn(def ?? {}, 'icon'), `${key}.icon`).toBe(false);
            else expect(def?.icon).toBe(fields.icon);
        }
        for (const [id, icon] of Object.entries(item.groups ?? {})) {
            const group = model.groups.find((entry) => entry.id === id);
            expect(group, id).toBeDefined();
            if (icon === null) expect(Object.hasOwn(group ?? {}, 'icon'), id).toBe(false);
            else expect(group?.icon).toBe(icon);
        }
    });

    it('icons と icon を持つタグのキーの定義を、そのまま候補の問い合わせに戻せる', () => {
        const source = ['---', 'markdag:', '  icons:', '    gh: simple-icons:github', '  tags:', '    keys:', '      tool:', '        type: enum', '        values: [git, svn]', '        description: 道具', '        icons: { git: gh }', '        icon: gh', '---', '# R'].join('\n');
        const { model } = renderDocument(source);
        const plain = renderDocument(source.replace('        icons: { git: gh }\n        icon: gh\n', '')).model;
        expect(model.tagKeys[0]?.icons).toEqual({ git: 'gh' });
        expect(suggestTagKeys(model.tagKeys)).toEqual(suggestTagKeys(plain.tagKeys));
        expect(suggestTagValues(model.tagKeys, 'tool')).toEqual(['git', 'svn']);
        expect(suggestTagValues(model.tagKeys, 'tool', 's')).toEqual(['svn']);
    });

    // 境界の包みが印に使う名前 ($object など) を利用者がタグの値に書いても、wasm の側で包みを外して読める
    it.each(['$object', '$number', '$undefined'])('icons のキーが %s 1 つでも、候補の問い合わせに戻せる', (mark) => {
        const source = ['---', 'markdag:', '  icons:', '    gh: simple-icons:github', '  tags:', '    keys:', '      tool:', '        type: string', '        description: 道具', '        icons:', `          ${mark}: gh`, '---', '# R', `- n #tool:${mark}`].join('\n');
        const { model } = renderDocument(source);
        expect(model.tagKeys[0]?.icons).toEqual({ [mark]: 'gh' });
        expect(suggestTagKeys(model.tagKeys)).toEqual([{ key: 'tool', description: '道具' }]);
        expect(suggestTagValues(model.tagKeys, 'tool')).toEqual([]);
    });
});

describe('ModelOptions.icons の渡し方 (キーなし、undefined、null で icons-unresolved の手がかりを分ける)', () => {
    const source = ['---', 'markdag:', '  icons:', '    $ref: ./team.yaml', '---', '# R'].join('\n');
    const NOT_PASSED = '呼び出し側が読んで buildModel の icons に渡します (npm run check は文書の場所からの相対で読みます)';
    const UNREADABLE = 'ファイルが YAML のキーと値の組 (alias: 値) として読めるか確かめます';
    const hints = (extra: Parameters<typeof renderDocument>[1]): Array<[string, string | null]> =>
        renderDocument(source, extra).model.diagnostics.map((item) => [item.code, item.hint]);

    it('icons を渡さない、undefined、キーのない表、値が undefined は「渡していない」', () => {
        for (const extra of [{}, { icons: undefined }, { icons: {} }, { icons: { './team.yaml': undefined } }, { icons: { './other.yaml': {} } }]) {
            expect(hints(extra), JSON.stringify(extra)).toEqual([['icons-unresolved', NOT_PASSED]]);
        }
    });

    it('値が null やオブジェクトでない値は「読めなかった」、オブジェクトなら表に入る', () => {
        for (const value of [null, 'text', 3, ['a']]) {
            expect(hints({ icons: { './team.yaml': value } }), JSON.stringify(value)).toEqual([['icons-unresolved', UNREADABLE]]);
        }
        const { model } = renderDocument(source, { icons: { './team.yaml': { gh: 'simple-icons:github' } } });
        expect(model.diagnostics).toEqual([]);
        expect([...model.icons.aliases.keys()]).toEqual(['gh']);
    });

    it('buildModel の経路でも同じ', () => {
        const parsed = parseDocument(source);
        const codes = (icons: Record<string, unknown> | undefined) => buildModel(parsed.nodes, parsed.frontmatter, source, { icons }).diagnostics.map((item) => item.hint);
        expect(codes(undefined)).toEqual([NOT_PASSED]);
        expect(codes({ './team.yaml': null })).toEqual([UNREADABLE]);
        expect(codes({ './team.yaml': { gh: 'simple-icons:github' } })).toEqual([]);
    });
});

describe('単体 HTML の素材の欄の順 (Rust の DATA_KEYS、TS の renderStandalonePage)', () => {
    const order = fixture<string[]>('data-keys.json');
    const runtime = { script: 'var markdag = {};', style: '' };
    const embedded = (html: string): Record<string, unknown> => {
        const match = new RegExp(`<script id="${DATA_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
        return JSON.parse(match?.[1] ?? 'null') as Record<string, unknown>;
    };

    it('すべての欄を渡すと共有の順に並ぶ', () => {
        const { parsed } = renderDocument('# a');
        const html = renderStandalonePage(
            {
                icons: { './a.svg': '<svg viewBox="0 0 1 1"></svg>' },
                iconAliases: { './team.yaml': { a: './a.svg' } },
                tasks: 'scratch',
                state: { folded: [] },
                view: { theme: 'dark' },
                hookScripts: { './h.js': 'export default {}' },
                types: { './t.yaml': {} },
                source: '# a',
                parsed,
                title: 'T',
            },
            runtime,
        );
        expect(Object.keys(embedded(html))).toEqual(order);
    });

    it('渡さない欄と undefined の欄は足さず、残りは同じ順', () => {
        const html = renderStandalonePage({ icons: { './a.svg': '<svg></svg>' }, source: '# a', types: undefined, iconAliases: { './t.yaml': {} } }, runtime);
        const keys = Object.keys(embedded(html));
        expect(keys).toEqual(['source', 'iconAliases', 'icons']);
        expect(keys).toEqual(order.filter((key) => keys.includes(key)));
    });
});

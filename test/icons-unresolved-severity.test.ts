// icon-unresolved の重さ。resolveIcon を渡して解決を試み、失敗したとき (null、SVG として読めない文字列、throw、reject) は warning を ref ごとに 1 度。
// resolveIcon を渡していないときは診断を出さない。単体 HTML の焼き込んだ表にない ref (組み込みの名前を含む) も、解決に失敗した扱いで warning
import { describe, expect, it, vi } from 'vitest';
import { createHookBridge } from '../src/bridge';
import type { Diagnostic } from '../src/model/model';
import { renderDocument } from '../src/model/model';
import { bakedIconResolver } from '../src/standalone/mount';
import { IconResolution, type IconResolver } from '../src/view/icon-resolver';
import type { MarkdagView } from '../src/view/view';

const GITHUB = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(resolve: IconResolver) {
    const delivered: Array<[string, string | null]> = [];
    const diagnostics: Diagnostic[] = [];
    const resolution = new IconResolution({ resolve, deliver: (ref, svg) => delivered.push([ref, svg]), onDiagnostic: (item) => diagnostics.push(item) });
    return { resolution, delivered, diagnostics };
}

const fakeView = () => ({ setIconSvg: () => {}, setDocument: () => {}, destroy: () => {} }) as unknown as MarkdagView;

const doc = (body: string[]): string =>
    ['---', 'markdag:', '    icons:', '        gh: ./logos/github.svg', '        k8s: simple-icons:kubernetes', '        rocket: "🚀"', '---', '# R', ...body].join('\n');

// 失敗の形ごとの resolver と、文で見分ける言葉
const FAILURES: Array<{ name: string; resolve: IconResolver; says: string[] }> = [
    { name: '同期で null', resolve: () => null, says: ['返さなかった', 'null'] },
    { name: 'Promise が null', resolve: () => Promise.resolve(null), says: ['返さなかった', 'null'] },
    { name: '同期で読めない文字列', resolve: () => 'not svg', says: ['SVG として読めなかった'] },
    { name: 'Promise が読めない文字列', resolve: () => Promise.resolve('<div>x</div>'), says: ['SVG として読めなかった'] },
    {
        name: '同期の throw',
        resolve: () => {
            throw new Error('boom');
        },
        says: ['例外', 'boom'],
    },
    { name: 'reject', resolve: () => Promise.reject(new Error('offline')), says: ['例外', 'offline'] },
];

describe('resolveIcon を渡して解決に失敗したときの icon-unresolved', () => {
    it.each(FAILURES)('$name は warning を 1 度出し、文字のまま (null か読めない文字列) を渡す', async ({ resolve, says }) => {
        const { resolution, delivered, diagnostics } = setup(resolve);
        resolution.request(['simple-icons:nope']);
        await flush();
        resolution.request(['simple-icons:nope']);
        await flush();
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ severity: 'warning', code: 'icon-unresolved', at: null });
        expect(Object.keys(diagnostics[0] ?? {})).toEqual(['severity', 'code', 'message', 'at', 'hint']);
        for (const word of ['simple-icons:nope', ...says]) expect(diagnostics[0]?.message).toContain(word);
        expect(delivered).toHaveLength(1);
    });

    it('失敗の形 (null / 読めない / 例外) ごとに文と手がかりが違う', async () => {
        const kinds = [FAILURES[0], FAILURES[2], FAILURES[4]].map((item) => item?.resolve as IconResolver);
        const seen: Diagnostic[] = [];
        for (const resolve of kinds) {
            const { resolution, diagnostics } = setup(resolve);
            resolution.request(['a:x']);
            await flush();
            seen.push(...diagnostics);
        }
        expect(new Set(seen.map((item) => item.message)).size).toBe(3);
        expect(new Set(seen.map((item) => item.hint)).size).toBe(3);
    });

    it('undefined や文字列でない値で済んでも warning (null と読めないの扱い)', async () => {
        const values: Record<string, unknown> = { 'a:undefined': undefined, 'a:number': 3, 'a:object': { svg: GITHUB } };
        const { resolution, diagnostics } = setup((ref) => Promise.resolve(values[ref] as string));
        resolution.request(Object.keys(values));
        await flush();
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved', 'warning icon-unresolved', 'warning icon-unresolved']);
    });

    it('読める SVG なら診断を出さない', async () => {
        const { resolution, diagnostics } = setup((ref) => (ref === 'a:sync' ? GITHUB : Promise.resolve(GITHUB)));
        resolution.request(['a:sync', 'a:promise']);
        await flush();
        expect(diagnostics).toEqual([]);
    });

    it('片付けたあとに null で済んでも診断を出さない', async () => {
        const { resolution, diagnostics } = setup(() => Promise.resolve(null));
        resolution.request(['a:x']);
        resolution.dispose();
        await flush();
        expect(diagnostics).toEqual([]);
    });

    it('橋渡しでも null と読めない文字列は onDiagnostic に warning を 1 度ずつ (文書を差し替えても出し直さない)', () => {
        const diagnostics: Diagnostic[] = [];
        const bridge = createHookBridge({
            source: () => '',
            onDiagnostic: (item) => diagnostics.push(item),
            resolveIcon: (ref) => (ref === './logos/github.svg' ? 'not svg' : null),
        });
        bridge.attach(fakeView());
        const first = renderDocument(doc(['## :gh: Push', '## :k8s: Deploy', '## :rocket: Release']));
        bridge.setDocument(first.parsed, first.model);
        const second = renderDocument(doc(['## :gh: Push', '## :k8s: Deploy again']));
        bridge.setDocument(second.parsed, second.model);
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved', 'warning icon-unresolved']);
    });
});

describe('文字にできない例外の値', () => {
    const UNPRINTABLE = 'ロゴ「a:x」を resolveIcon で引けなかったので、文字のまま描きます (例外: 文字にできない値)';

    it.each([
        {
            name: '同期の throw',
            resolve: (() => {
                throw Object.create(null);
            }) as IconResolver,
        },
        { name: 'reject', resolve: (() => Promise.reject(Object.create(null))) as IconResolver },
    ])('$name でも止まらず、固定の文の warning を出してほかの ref を続ける', async ({ resolve }) => {
        const asked: string[] = [];
        const { resolution, delivered, diagnostics } = setup((ref) => {
            asked.push(ref);
            return ref === 'a:x' ? resolve(ref) : GITHUB;
        });
        expect(() => resolution.request(['a:x', 'b:y'])).not.toThrow();
        await flush();
        expect(asked).toEqual(['a:x', 'b:y']);
        // reject は b:y (同期) のあとに届くので、順は見ない
        expect(new Map(delivered)).toEqual(
            new Map([
                ['a:x', null],
                ['b:y', GITHUB],
            ]),
        );
        expect(diagnostics.map((item) => [item.severity, item.code, item.message, item.at])).toEqual([['warning', 'icon-unresolved', UNPRINTABLE, null]]);
    });

    it('橋渡しでも文書を描く (setDocument が view まで届く)', () => {
        const diagnostics: Diagnostic[] = [];
        const setDocument = vi.fn();
        const view = { setIconSvg: () => {}, setDocument, destroy: () => {} } as unknown as MarkdagView;
        const bridge = createHookBridge({
            source: () => '',
            onDiagnostic: (item) => diagnostics.push(item),
            resolveIcon: () => {
                throw Object.create(null);
            },
        });
        bridge.attach(view);
        const { parsed, model } = renderDocument(doc(['## :gh: Push']));
        expect(() => bridge.setDocument(parsed, model)).not.toThrow();
        expect(setDocument).toHaveBeenCalled();
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved']);
    });
});

describe('resolveIcon を渡していないとき', () => {
    it('橋渡しは問い合わせず、診断も出さない (今までどおり)', () => {
        const onDiagnostic = vi.fn();
        const bridge = createHookBridge({ source: () => '', onDiagnostic });
        bridge.attach(fakeView());
        const { parsed, model } = renderDocument(doc(['## :gh: Push', '## :k8s: Deploy']));
        bridge.setDocument(parsed, model);
        expect(onDiagnostic).not.toHaveBeenCalled();
    });

    it('単体 HTML に icons がなければ resolver を作らない (解決を試みないので診断もない)', () => {
        expect(bakedIconResolver(undefined)).toBeUndefined();
    });
});

describe('単体 HTML の焼き込んだ表にない ref', () => {
    it('表にない set:name は warning を 1 度、表にある ref と絵文字は出さない', () => {
        const diagnostics: Diagnostic[] = [];
        const bridge = createHookBridge({ source: () => '', onDiagnostic: (item) => diagnostics.push(item), resolveIcon: bakedIconResolver({ './logos/github.svg': GITHUB }) });
        bridge.attach(fakeView());
        const { parsed, model } = renderDocument(doc(['## :gh: Push', '## :k8s: Deploy', '## :rocket: Release']));
        bridge.setDocument(parsed, model);
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved']);
        expect(diagnostics[0]?.message).toContain('simple-icons:kubernetes');
    });

    // 文書の alias は set:name か相対パスなので、組み込みの名前の ref は resolver を直接呼んだときだけ届く
    it('組み込みの名前の ref は表を引かず、表にない ref と同じく warning', () => {
        const { resolution, diagnostics } = setup(bakedIconResolver({ './a.svg': GITHUB }) as IconResolver);
        resolution.request(['constructor', '__proto__', 'toString', './a.svg']);
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved', 'warning icon-unresolved', 'warning icon-unresolved']);
        expect(diagnostics.map((item) => item.message).join('\n')).not.toContain('./a.svg');
    });

    it('空の表でも、使った ref は warning', () => {
        const diagnostics: Diagnostic[] = [];
        const bridge = createHookBridge({ source: () => '', onDiagnostic: (item) => diagnostics.push(item), resolveIcon: bakedIconResolver({}) });
        bridge.attach(fakeView());
        const { parsed, model } = renderDocument(doc(['## :gh: Push']));
        bridge.setDocument(parsed, model);
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['warning icon-unresolved']);
    });
});

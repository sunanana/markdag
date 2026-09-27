// resolveIcon への問い合わせ。同期と Promise、引けなかったとき (null、reject、throw)、同じ ref の控え、文書の差し替えで新しい ref だけ聞くこと
import { describe, expect, it, vi } from 'vitest';
import { createHookBridge } from '../src/bridge';
import type { Diagnostic } from '../src/model/model';
import { renderDocument } from '../src/model/model';
import { IconResolution, type IconResolver } from '../src/view/icon-resolver';
import type { MarkdagView } from '../src/view/view';

const GITHUB = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

function setup(resolve: IconResolver) {
    const delivered: Array<[string, string | null]> = [];
    const diagnostics: Diagnostic[] = [];
    const resolution = new IconResolution({ resolve, deliver: (ref, svg) => delivered.push([ref, svg]), onDiagnostic: (item) => diagnostics.push(item) });
    return { resolution, delivered, diagnostics };
}

// 未処理の Promise の then を回し切る
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('IconResolution', () => {
    it('同期で返った SVG は request の中で渡す', () => {
        const { resolution, delivered, diagnostics } = setup(() => GITHUB);
        resolution.request(['simple-icons:github']);
        expect(delivered).toEqual([['simple-icons:github', GITHUB]]);
        expect(diagnostics).toEqual([]);
    });

    it('Promise は解決したときに渡す', async () => {
        let finish: (svg: string) => void = () => {};
        const { resolution, delivered } = setup(() => new Promise<string>((resolve) => (finish = resolve)));
        resolution.request(['simple-icons:github']);
        expect(delivered).toEqual([]);
        finish(GITHUB);
        await flush();
        expect(delivered).toEqual([['simple-icons:github', GITHUB]]);
    });

    it('null は引けなかったとして渡し、診断は出さない (同期と Promise)', async () => {
        const { resolution, delivered, diagnostics } = setup((ref) => (ref === 'a:sync' ? null : Promise.resolve(null)));
        resolution.request(['a:sync', 'a:async']);
        await flush();
        expect(delivered).toEqual([
            ['a:sync', null],
            ['a:async', null],
        ]);
        expect(diagnostics).toEqual([]);
    });

    it('reject は引けなかったとして渡し、icon-unresolved (info) を知らせる', async () => {
        const { resolution, delivered, diagnostics } = setup(() => Promise.reject(new Error('404')));
        resolution.request(['simple-icons:nope']);
        await flush();
        expect(delivered).toEqual([['simple-icons:nope', null]]);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({ severity: 'info', code: 'icon-unresolved', at: null });
        expect(diagnostics[0]?.message).toContain('simple-icons:nope');
        expect(diagnostics[0]?.message).toContain('404');
    });

    it('同期の throw でも止まらず、ほかの ref の問い合わせを続ける', () => {
        const { resolution, delivered, diagnostics } = setup((ref) => {
            if (ref === 'a:bad') throw new Error('boom');
            return GITHUB;
        });
        expect(() => resolution.request(['a:bad', 'a:good'])).not.toThrow();
        expect(delivered).toEqual([
            ['a:bad', null],
            ['a:good', GITHUB],
        ]);
        expect(diagnostics.map((item) => item.code)).toEqual(['icon-unresolved']);
    });

    it('文字列でない戻り値は引けなかったとして扱う', () => {
        const { resolution, delivered } = setup(() => undefined as unknown as string);
        resolution.request(['a:x']);
        expect(delivered).toEqual([['a:x', null]]);
    });

    it('同じ ref は 1 度だけ問い合わせる (問い合わせ中も、済んだあとも、失敗したあとも)', async () => {
        const resolve = vi.fn((ref: string) => (ref === 'a:bad' ? Promise.reject(new Error('x')) : Promise.resolve(GITHUB)));
        const { resolution } = setup(resolve);
        resolution.request(['a:ok', 'a:bad']);
        resolution.request(['a:ok', 'a:bad']);
        await flush();
        resolution.request(['a:ok', 'a:bad']);
        expect(resolve).toHaveBeenCalledTimes(2);
    });

    it('片付けたあとに届いた結果は渡さない', async () => {
        const { resolution, delivered, diagnostics } = setup((ref) => (ref === 'a:ok' ? Promise.resolve(GITHUB) : Promise.reject(new Error('x'))));
        resolution.request(['a:ok', 'a:bad']);
        resolution.dispose();
        await flush();
        expect(delivered).toEqual([]);
        expect(diagnostics).toEqual([]);
    });

    it('settled は解決の済んだものだけを返す', async () => {
        const { resolution } = setup((ref) => (ref === 'a:sync' ? GITHUB : new Promise<string>(() => {})));
        resolution.request(['a:sync', 'a:pending']);
        await flush();
        expect(resolution.settled()).toEqual([['a:sync', GITHUB]]);
    });
});

// ロゴの解決の、未問い合わせ (R0) と解決待ち (R1) での出来事を、部品 (IconResolution) の側から細かく固定する
describe('IconResolution の戻り方ごとの控えと診断', () => {
    const UNRESOLVED_HINT = 'resolveIcon が SVG の文字列を返すか確かめます。引けないと分かっている ref は null を返すと、この診断は出ません';

    it('失敗の診断は文面と手がかりまで決まっていて、理由は Error なら message、それ以外は String() の文字', async () => {
        const reasons: unknown[] = [new Error('404'), new TypeError('bad type'), new Error(''), 'text', 42, null, undefined, { toString: () => 'custom' }];
        for (const reason of reasons) {
            const sync = setup(() => {
                throw reason;
            });
            sync.resolution.request(['a:x']);
            const rejected = setup(() => Promise.reject(reason));
            rejected.resolution.request(['a:x']);
            await flush();
            const text = reason instanceof Error ? reason.message : String(reason);
            const expected: Diagnostic = {
                severity: 'info',
                code: 'icon-unresolved',
                message: `ロゴ「a:x」を resolveIcon で引けなかったので、文字のまま描きます (${text})`,
                at: null,
                hint: UNRESOLVED_HINT,
            };
            expect(sync.diagnostics, String(text)).toEqual([expected]);
            expect(rejected.diagnostics, String(text)).toEqual([expected]);
            expect(Object.keys(sync.diagnostics[0] ?? {})).toEqual(['severity', 'code', 'message', 'at', 'hint']);
            expect(sync.delivered).toEqual([['a:x', null]]);
            expect(rejected.delivered).toEqual([['a:x', null]]);
        }
    });

    it('Promise が文字列でない値で済んだら null を渡し、読めない文字列はそのまま渡す (読めるかは置き場が決める)。診断は出さない', async () => {
        const values: Record<string, unknown> = { 'a:undefined': undefined, 'a:number': 3, 'a:object': { svg: GITHUB }, 'a:broken': 'not svg' };
        const { resolution, delivered, diagnostics } = setup((ref) => Promise.resolve(values[ref] as string));
        resolution.request(Object.keys(values));
        await flush();
        expect(delivered).toEqual([
            ['a:undefined', null],
            ['a:number', null],
            ['a:object', null],
            ['a:broken', 'not svg'],
        ]);
        expect(diagnostics).toEqual([]);
    });

    it('同期で返った読めない文字列もそのまま渡す', () => {
        const { resolution, delivered } = setup(() => 'not svg');
        resolution.request(['a:x']);
        expect(delivered).toEqual([['a:x', 'not svg']]);
        expect(resolution.settled()).toEqual([['a:x', 'not svg']]);
    });

    it('Promise でない thenable も待つ', async () => {
        let finish: (svg: string) => void = () => {};
        const thenable = { then: (resolve: (svg: string) => void) => (finish = resolve) };
        const { resolution, delivered } = setup(() => thenable as unknown as Promise<string>);
        resolution.request(['a:x']);
        expect(delivered).toEqual([]);
        expect(resolution.settled()).toEqual([]);
        // Promise.resolve が then を呼ぶのは次の microtask
        await flush();
        finish(GITHUB);
        await flush();
        expect(delivered).toEqual([['a:x', GITHUB]]);
    });

    it('then を持たないオブジェクトは Promise とみなさず、文字列でないので null', () => {
        const { resolution, delivered } = setup(() => ({ then: 'no' }) as unknown as string);
        resolution.request(['a:x']);
        expect(delivered).toEqual([['a:x', null]]);
    });

    it('1 回の request に同じ ref が並んでも 1 度だけ問い合わせ、渡すのも 1 度', () => {
        const resolve = vi.fn(() => GITHUB);
        const { resolution, delivered } = setup(resolve);
        resolution.request(['a:x', 'a:x', 'a:y', 'a:x']);
        expect(resolve.mock.calls).toEqual([['a:x'], ['a:y']]);
        expect(delivered).toEqual([
            ['a:x', GITHUB],
            ['a:y', GITHUB],
        ]);
    });

    it('onDiagnostic がなくても失敗で止まらない', async () => {
        const delivered: Array<[string, string | null]> = [];
        const resolution = new IconResolution({ resolve: (ref) => (ref === 'a:sync' ? (() => { throw new Error('x'); })() : Promise.reject(new Error('y'))), deliver: (ref, svg) => delivered.push([ref, svg]) });
        expect(() => resolution.request(['a:sync', 'a:async'])).not.toThrow();
        await flush();
        expect(delivered).toEqual([
            ['a:sync', null],
            ['a:async', null],
        ]);
    });

    it('片付けたあとは問い合わせない。片付ける前に聞いた結果は控えには入るが渡さない (R6×A7)', async () => {
        const resolve = vi.fn((ref: string) => (ref === 'a:late' ? Promise.resolve(GITHUB) : GITHUB));
        const { resolution, delivered, diagnostics } = setup(resolve);
        resolution.request(['a:late']);
        resolution.dispose();
        resolution.request(['a:new']);
        await flush();
        expect(resolve.mock.calls).toEqual([['a:late']]);
        expect(delivered).toEqual([]);
        expect(diagnostics).toEqual([]);
        expect(resolution.settled()).toEqual([['a:late', GITHUB]]);
    });

    it('settled は問い合わせた順 (済んだ順ではない) で、失敗は null', async () => {
        let finishFirst: (svg: string) => void = () => {};
        const { resolution } = setup((ref) => {
            if (ref === 'a:first') return new Promise<string>((resolve) => (finishFirst = resolve));
            if (ref === 'a:bad') throw new Error('x');
            return GITHUB;
        });
        resolution.request(['a:first', 'a:bad', 'a:sync']);
        expect(resolution.settled()).toEqual([
            ['a:bad', null],
            ['a:sync', GITHUB],
        ]);
        finishFirst(SENTRY_SVG);
        await flush();
        expect(resolution.settled()).toEqual([
            ['a:first', SENTRY_SVG],
            ['a:bad', null],
            ['a:sync', GITHUB],
        ]);
    });
});

const SENTRY_SVG = '<svg viewBox="0 0 24 24"><path d="M1 1h2v2H1z"/></svg>';

const doc = (body: string[]): string =>
    ['---', 'markdag:', '    icons:', '        github: simple-icons:github', '        sentry: simple-icons:sentry', '        aws: simple-icons:aws', '        rocket: "🚀"', '---', '# R', ...body].join('\n');

// 呼ばれた順を控える view の代役 (橋渡しが呼ぶ setIconSvg と setDocument だけ)
function fakeView() {
    const calls: string[] = [];
    const view = {
        setIconSvg: (ref: string, svg: string | null) => calls.push(`icon ${ref} ${svg === null ? 'null' : 'svg'}`),
        setDocument: () => calls.push('document'),
        destroy: () => {},
    };
    return { calls, view: view as unknown as MarkdagView };
}

describe('橋渡しの resolveIcon', () => {
    const draw = (bridge: ReturnType<typeof createHookBridge>, markdown: string) => {
        const { parsed, model } = renderDocument(markdown);
        bridge.setDocument(parsed, model);
    };

    it('同期で返ったロゴは setDocument の前に置き場へ入れる。絵文字の alias は問い合わせない', () => {
        const resolve = vi.fn((_ref: string) => GITHUB);
        const { calls, view } = fakeView();
        const bridge = createHookBridge({ source: () => '', resolveIcon: resolve });
        bridge.attach(view);
        draw(bridge, doc(['## :github: Push', '## :rocket: Release']));
        expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['simple-icons:github']);
        expect(calls).toEqual(['icon simple-icons:github svg', 'document']);
    });

    it('文書を差し替えたときは新しく出てきた ref だけ問い合わせる', () => {
        const resolve = vi.fn((_ref: string) => GITHUB);
        const { view } = fakeView();
        const bridge = createHookBridge({ source: () => '', resolveIcon: resolve });
        bridge.attach(view);
        draw(bridge, doc(['## :github: Push', '## :sentry: Watch']));
        draw(bridge, doc(['## :github: Push', '## :aws: Deploy']));
        expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['simple-icons:github', 'simple-icons:sentry', 'simple-icons:aws']);
    });

    it('問い合わせ中に文書が差し替わって使われなくなった ref も、届いたら置き場に入れるだけ', async () => {
        let finish: (svg: string) => void = () => {};
        const { calls, view } = fakeView();
        const bridge = createHookBridge({ source: () => '', resolveIcon: () => new Promise<string>((resolve) => (finish = resolve)) });
        bridge.attach(view);
        draw(bridge, doc(['## :sentry: Watch']));
        draw(bridge, doc(['## Plain']));
        finish(GITHUB);
        await flush();
        expect(calls).toEqual(['document', 'document', 'icon simple-icons:sentry svg']);
    });

    it('reject と throw は onDiagnostic に知らせ、描画は止めない', async () => {
        const diagnostics: Diagnostic[] = [];
        const { calls, view } = fakeView();
        const bridge = createHookBridge({
            source: () => '',
            onDiagnostic: (item) => diagnostics.push(item),
            resolveIcon: (ref) => {
                if (ref === 'simple-icons:github') throw new Error('sync');
                return Promise.reject(new Error('async'));
            },
        });
        bridge.attach(view);
        expect(() => draw(bridge, doc(['## :github: Push', '## :sentry: Watch']))).not.toThrow();
        await flush();
        expect(calls).toEqual(['icon simple-icons:github null', 'document', 'icon simple-icons:sentry null']);
        expect(diagnostics.map((item) => `${item.severity} ${item.code}`)).toEqual(['info icon-unresolved', 'info icon-unresolved']);
    });

    it('view を付ける前に済んだ結果は attach で入れる', () => {
        const { calls, view } = fakeView();
        const bridge = createHookBridge({ source: () => '', resolveIcon: () => GITHUB });
        draw(bridge, doc(['## :github: Push']));
        bridge.attach(view);
        expect(calls).toEqual(['icon simple-icons:github svg']);
    });

    // attach (A13) と destroy (A14) の出来事。配線 (attach、setDocument、destroy) の今の振る舞いを固定する
    it('別の view を付けると、済んだ結果 (SVG、null、失敗) を入れ直す。失敗の診断は出し直さない (R2 R3 R4 × A13)', async () => {
        const diagnostics: Diagnostic[] = [];
        const bridge = createHookBridge({
            source: () => '',
            onDiagnostic: (item) => diagnostics.push(item),
            resolveIcon: (ref) => {
                if (ref === 'simple-icons:github') return GITHUB;
                if (ref === 'simple-icons:sentry') return null;
                return Promise.reject(new Error('x'));
            },
        });
        const first = fakeView();
        bridge.attach(first.view);
        draw(bridge, doc(['## :github: :sentry: :aws: A']));
        await flush();
        const second = fakeView();
        bridge.attach(second.view);
        expect(second.calls).toEqual(['icon simple-icons:github svg', 'icon simple-icons:sentry null', 'icon simple-icons:aws null']);
        expect(diagnostics.map((item) => item.code)).toEqual(['icon-unresolved']);
    });

    it('解決待ちの間に付け替えると、済んだ結果は今付いている view にだけ届く (R1 × A13)', async () => {
        let finish: (svg: string) => void = () => {};
        const bridge = createHookBridge({ source: () => '', resolveIcon: () => new Promise<string>((resolve) => (finish = resolve)) });
        const first = fakeView();
        bridge.attach(first.view);
        draw(bridge, doc(['## :github: A']));
        const second = fakeView();
        bridge.attach(second.view);
        finish(GITHUB);
        await flush();
        expect(first.calls).toEqual(['document']);
        expect(second.calls).toEqual(['icon simple-icons:github svg']);
    });

    it('destroy のあとに届いた結果と失敗は捨て、そのあとの setDocument は問い合わせない (R1 × A14、R6 × A1 A7 A9)', async () => {
        const finishers: Array<() => void> = [];
        const diagnostics: Diagnostic[] = [];
        const resolve = vi.fn((ref: string) =>
            new Promise<string>((ok, fail) => finishers.push(() => (ref === 'simple-icons:github' ? ok(GITHUB) : fail(new Error('x'))))),
        );
        const bridge = createHookBridge({ source: () => '', onDiagnostic: (item) => diagnostics.push(item), resolveIcon: resolve });
        const { calls, view } = fakeView();
        bridge.attach(view);
        draw(bridge, doc(['## :github: :sentry: A']));
        bridge.destroy();
        for (const finish of finishers) finish();
        await flush();
        draw(bridge, doc(['## :aws: A']));
        expect(resolve).toHaveBeenCalledTimes(2);
        expect(calls).toEqual(['document']);
        expect(diagnostics).toEqual([]);
    });

    it('今の挙動: destroy のあとに attach すると、destroy の前に済んだ結果を新しい view に入れる', () => {
        const bridge = createHookBridge({ source: () => '', resolveIcon: () => GITHUB });
        bridge.attach(fakeView().view);
        draw(bridge, doc(['## :github: A']));
        bridge.destroy();
        const next = fakeView();
        bridge.attach(next.view);
        expect(next.calls).toEqual(['icon simple-icons:github svg']);
    });

    it('絵文字の alias だけ、または icons のない文書では問い合わせない', () => {
        const resolve = vi.fn((_ref: string) => GITHUB);
        const bridge = createHookBridge({ source: () => '', resolveIcon: resolve });
        bridge.attach(fakeView().view);
        draw(bridge, doc(['## :rocket: A']));
        draw(bridge, '# R\n## :github: A');
        expect(resolve).not.toHaveBeenCalled();
    });

    it('resolveIcon を渡さなければ置き場に何も入れない', () => {
        const { calls, view } = fakeView();
        const bridge = createHookBridge({ source: () => '' });
        bridge.attach(view);
        draw(bridge, doc(['## :github: Push']));
        expect(calls).toEqual(['document']);
    });
});

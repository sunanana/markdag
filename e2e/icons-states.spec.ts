// アイコン機能の状態遷移のテスト。2 つの状態機械 (図 1 ロゴ 1 つの解決、図 2 吹き出しとロゴ) の、状態 × 出来事のマスを確かめる。
// 網羅の基準: すべての状態に入る、すべての遷移 (「→ 次の状態」のマス) を通る、各状態で起きてはいけない出来事 (「無視」のマス) を試す。
// 「無視 (起きない)」のマスは、その状態では出来事が起こりえないので試さない。振る舞いをまだ決めていないマスは今の挙動を確かめ、分類を「今の挙動」にする。
// テストの名前の先頭がマス (例: 「図1 R0×A2」)。1 つのテストが複数のマスを確かめるときは「・」で並べる。
//
// 図 1 (ref ごとのロゴの解決) の状態:
//     R0 未問い合わせ、R1 解決待ち、R2 解決済み (SVG あり)、R3 引けなかった (null など、診断なし)、
//     R4 失敗 (icon-unresolved を 1 度出した)、R5 外から入れた (setIconSvg、未問い合わせ)、R6 片付け済み
// 図 1 の出来事:
//     A1 文書にその ref がある setDocument。A2〜A6 はそのときの resolveIcon の戻り方 (A2 同期で読める SVG、
//     A3 同期で null か文字列でない値、A4 同期で読めない文字列、A5 同期で throw、A6 Promise)。
//     A7〜A9 はその Promise の結果 (A7 読める SVG、A8 null か文字列でない値か読めない文字列、A9 reject)。
//     A10 文書の差し替えでその ref を使う所がなくなる、A11 setIconSvg(ref, 読める SVG)、A12 setIconSvg(ref, null か読めない文字列)、
//     A13 bridge.attach(view)、A14 bridge.destroy()
// 図 2 (吹き出しとロゴ。X は吹き出しの中身を持つノード) の状態:
//     Q0 閉じている、Q1 開く待ち、Q2 開いている・重ね・文字あり、Q3 開いている・重ね・ロゴ済み、
//     Q4 開いている・固定・文字あり、Q5 開いている・固定・ロゴ済み、Q6 片付け済み
//     (文字あり: 吹き出しが使う ref のどれかの置き場に SVG がない。ロゴ済み: すべてに SVG がある)
// 図 2 の出来事:
//     B1 X に重ねる、B2 開く待ちの 250ms が経つ、B3 ノードと吹き出しから離れて 200ms 経つ、B4 X の印をクリック、
//     B5 別のノード Y に重ねて 250ms 経つ、B6 Y の印をクリック、B7 吹き出しと印の外を押す、B8 Escape、
//     B9 吹き出しが使う ref の置き場が SVG に変わる、B10 同じく null に変わる、B11 置き場が変わらないか吹き出しが使わない ref、
//     B12 文書の差し替えで開き直す条件に当たる (木の形が同じで、X に中身があって表示されていて、固定かポインタが X の上)、
//     B13 それ以外の差し替え、B14 X が見えなくなるか中身がなくなる、B15 destroy
//
// 公開の入口 (render、createHookBridge、MarkdagView、view.setIconSvg、destroy) だけを呼ぶ。ロゴは受け入れの例の assets の自作の図形
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ProbeBehavior } from './icons-probe';

const asset = (name: string): string => readFileSync(resolve('testdata/acceptance/icons/assets', name), 'utf8');
const CIRCLE = asset('circle.svg');
const SQUARE = asset('square.svg');
const TRIANGLE = asset('triangle.svg');

const GH = 'simple-icons:github';
const K8S = 'simple-icons:kubernetes';

const FRONT = ['---', 'markdag:', '    icons:', `        gh: ${GH}`, `        k8s: ${K8S}`];

// 図 1 の文書。WITH は ref (GH) を本文で使い、WITHOUT と WITHOUT2 は使わない (alias の表は同じ)
const FIG1_WITH = [...FRONT, '---', '', '# R', '', '## :gh: A', '- [ ] B', ''].join('\n');
const FIG1_WITH2 = [...FRONT, '---', '', '# R', '', '## :gh: A (書き換え)', '- [ ] B', ''].join('\n');
const FIG1_WITHOUT = [...FRONT, '---', '', '# R', '', '## A', '- [ ] B', ''].join('\n');
const FIG1_WITHOUT2 = [...FRONT, '---', '', '# R', '', '## A2', '- [ ] B', ''].join('\n');

// 図 2 の文書。ノードの id は R = 1, P = 2, X = 3, Y = 4, Z = 5。X の詳細は GH、Y の詳細は K8S を使う
const FIG2_BODY = ['# R', '', '## P', '- [ ] X ノード', '    > 詳細の :gh:', '- [ ] Y ノード', '    > 詳細の :k8s:', '- [ ] Z ノード'];
const FIG2 = [...FRONT, '    details:', '        display: hover', '---', '', ...FIG2_BODY, ''].join('\n');
// 木の形が同じ (ノードの数と親が同じ) 差し替え
const FIG2_SAME_SHAPE = FIG2.replace('X ノード', 'X ノード (書き換え)');
// 木の形が変わる差し替え
const FIG2_OTHER_SHAPE = FIG2.replace('- [ ] Z ノード', '- [ ] Z ノード\n- [ ] W ノード');
const X = 3;
const Y = 4;
const P = 2;

type Behaviors = Record<string, ProbeBehavior>;
const sync = (content: string | null): ProbeBehavior => ({ how: 'sync', content });
const MANUAL: ProbeBehavior = { how: 'manual' };
const THROW: ProbeBehavior = { how: 'throw', reason: 'boom' };

interface Look {
    asked: string[];
    diagnostics: string[];
    // 本文の :gh: の様子。ロゴなら図形の名前 (circle / rect / path)、文字なら 'text'、印がなければ 'none'
    gh: string;
    empty: boolean;
    popover: { hidden: boolean; pinned: number[]; marks: string[] };
    hooks: { show: number; hide: number; destroy: number };
    errors: string[];
}

async function open(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/icons-harness.html');
    await page.waitForFunction(() => 'harness' in window && 'iconsProbe' in window);
    return errors;
}

// render で描く。フックの onDetailsShow / onDetailsHide / onDestroy の回数を数える
async function draw(page: Page, source: string, resolver: Behaviors): Promise<void> {
    await page.evaluate(
        ({ source, resolver }) => {
            const w = window as any;
            w.iconsProbe.reset();
            w.hookLog = { show: 0, hide: 0, destroy: 0 };
            w.diagram = w.harness.markdag.render(document.getElementById('a'), source, {
                animate: false,
                resolveIcon: w.iconsProbe.resolver(resolver),
                onDiagnostic: w.iconsProbe.onDiagnostic,
                hooks: {
                    onDetailsShow: () => w.hookLog.show++,
                    onDetailsHide: () => w.hookLog.hide++,
                    onDestroy: () => w.hookLog.destroy++,
                },
            });
        },
        { source, resolver },
    );
    await page.waitForTimeout(50);
}

async function look(page: Page, errors: string[], root = '#a'): Promise<Look> {
    const seen = await page.evaluate((selector) => {
        const w = window as any;
        const container = document.querySelector(selector)!;
        const shape = (element: Element | null): string => {
            if (!element) return 'none';
            const svg = element.querySelector('svg');
            return svg ? (svg.querySelector('circle, rect, path')?.tagName.toLowerCase() ?? 'svg') : 'text';
        };
        const body = [...container.querySelectorAll('.mdag-node .mdag-content .mdag-icon[data-icon="gh"]')].find((mark) => !mark.closest('.mdag-details')) ?? null;
        const popover = container.querySelector<HTMLElement>('.mdag-popover');
        return {
            asked: [...w.iconsProbe.asked],
            diagnostics: w.iconsProbe.diagnostics.map((item: any) => `${item.severity} ${item.code} ${item.at === null ? 'null' : 'at'}`),
            gh: shape(body),
            empty: container.innerHTML === '',
            popover: {
                hidden: popover === null || popover.hidden === true,
                pinned: [...container.querySelectorAll<HTMLElement>('.mdag-node[data-pinned]')].map((node) => Number(node.dataset.id)),
                marks: popover && !popover.hidden ? [...popover.querySelectorAll<HTMLElement>('.mdag-icon[data-icon]')].map((mark) => `${mark.dataset.icon}=${shape(mark)}`) : [],
            },
            hooks: { ...(w.hookLog ?? { show: 0, hide: 0, destroy: 0 }) },
        };
    }, root);
    return { ...seen, errors: [...errors] };
}

const update = (page: Page, source: string): Promise<unknown> => page.evaluate((next) => (window as any).diagram.update(next), source);
const setIcon = (page: Page, ref: string, svg: string | null): Promise<unknown> => page.evaluate(({ ref, svg }) => (window as any).diagram.view.setIconSvg(ref, svg), { ref, svg });
const settle = async (page: Page, ref: string, value: unknown, reject = false): Promise<void> => {
    await page.evaluate(({ ref, value, reject }) => (window as any).iconsProbe.settle(ref, value, reject), { ref, value, reject });
    await page.waitForTimeout(30);
};
const destroy = (page: Page): Promise<unknown> => page.evaluate(() => (window as any).diagram.destroy());

// 図 2 の操作
const boxOf = (page: Page, id: number) => page.locator(`#a .mdag-node[data-id="${id}"] .mdag-box`);
const markOf = (page: Page, id: number) => page.locator(`#a .mdag-node[data-id="${id}"] .mdag-note-mark`);
// B1: ポインタを X に重ねる (本物のポインタを動かす)
// 吹き出しが重なって覆っている所を避け、ノードの箱が表に出ている点を探してそこへ動かす
async function hover(page: Page, id: number): Promise<void> {
    const point = await page.evaluate((id) => {
        const box = document.querySelector(`#a .mdag-node[data-id="${id}"] .mdag-box`);
        if (!box) return null;
        const rect = box.getBoundingClientRect();
        for (const fy of [0.5, 0.2, 0.8, 0.05, 0.95]) {
            for (const fx of [0.5, 0.2, 0.8, 0.05, 0.95]) {
                const x = rect.left + rect.width * fx;
                const y = rect.top + rect.height * fy;
                const hit = document.elementFromPoint(x, y);
                if (hit && box.contains(hit)) return { x, y };
            }
        }
        return null;
    }, id);
    if (!point) throw new Error(`ノード ${id} の箱に重ねられる点がない`);
    await page.mouse.move(point.x, point.y);
}
// 重ねたまま、もう一度 pointerenter だけを送る (ポインタを動かさずに B1 を起こす)
const reenter = (page: Page, id: number): Promise<void> => boxOf(page, id).dispatchEvent('pointerenter');
// B3: ノードと吹き出しから離す
const leave = async (page: Page): Promise<void> => {
    await page.mouse.move(1200, 100);
};
// B4 / B6: 印をクリック (ポインタを動かさずに click だけを送る。重ねた扱いにしない)
const clickMark = (page: Page, id: number): Promise<void> => markOf(page, id).dispatchEvent('click');
// B7: 吹き出しと印の外を押す (ポインタは動かさない)
const pressOutside = (page: Page): Promise<unknown> => page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
const escape = (page: Page): Promise<void> => page.keyboard.press('Escape');
const wait = (page: Page, ms = 350): Promise<void> => page.waitForTimeout(ms);
// 要素の作り直しのあとにブラウザが送り直す pointerenter は、すぐとは限らない (webkit は 200ms ほど遅れることがある)。
// その送り直しから開く待ちの 250ms が経つまでを待つ
const RESENT_ENTER_WAIT = 700;
// 吹き出しの中身の要素 (作り直したかを見るために印を付ける)
const tagPopoverBody = (page: Page): Promise<unknown> => page.evaluate(() => ((document.querySelector('#a .mdag-popover > *') as any).__kept = true));
const popoverBodyKept = (page: Page): Promise<boolean> => page.evaluate(() => (document.querySelector('#a .mdag-popover > *') as any)?.__kept === true);

// 状態に入る (図 2)。gh は Q2 / Q4 (文字あり) なら manual、Q3 / Q5 (ロゴ済み) なら同期の円
async function enterQ(page: Page, state: 'Q0' | 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6'): Promise<void> {
    const logo = state === 'Q3' || state === 'Q5';
    await draw(page, FIG2, { [GH]: logo ? sync(CIRCLE) : MANUAL, [K8S]: sync(SQUARE) });
    if (state === 'Q1') await hover(page, X);
    if (state === 'Q2' || state === 'Q3') {
        await hover(page, X);
        await wait(page);
    }
    if (state === 'Q4' || state === 'Q5') await clickMark(page, X);
    if (state === 'Q6') {
        await hover(page, X);
        await wait(page);
        await destroy(page);
    }
}

// 吹き出しの状態の見方
const closed = (seen: Look): void => expect(seen.popover.hidden, JSON.stringify(seen.popover)).toBe(true);
function openAt(seen: Look, id: number, pinned: boolean, marks: string[]): void {
    expect(seen.popover.hidden).toBe(false);
    expect(seen.popover.pinned).toEqual(pinned ? [id] : []);
    expect(seen.popover.marks).toEqual(marks);
}
const X_TEXT = ['gh=text'];
const X_LOGO = ['gh=circle'];
const Y_LOGO = ['k8s=rect'];

interface Case {
    cells: string;
    kind: '遷移' | '無視' | '今の挙動';
    title: string;
    run: (page: Page, errors: string[]) => Promise<void>;
}

// ---- 図 1 ロゴ 1 つ (ref ごと) の解決 ----

// R5 (外から入れた、未問い合わせ) に入る。文書は GH を使わない
async function enterR5(page: Page, svg: string | null, resolver: Behaviors): Promise<void> {
    await draw(page, FIG1_WITHOUT, resolver);
    await setIcon(page, GH, svg);
}

// 置き場の値を見る: GH を使う文書にして、問い合わせは manual で済ませないまま (済むまでは置き場の値で描く)
async function storeShownAs(page: Page, errors: string[]): Promise<string> {
    await update(page, FIG1_WITH);
    return (await look(page, errors)).gh;
}

const FIG1: Case[] = [
    // A1
    {
        cells: '図1 R0×A1',
        kind: '遷移',
        title: '文書に ref が現れると resolveIcon を 1 度呼ぶ',
        run: async (page, errors) => {
            await draw(page, FIG1_WITHOUT, { [GH]: sync(CIRCLE) });
            expect((await look(page, errors)).asked).toEqual([]);
            await update(page, FIG1_WITH);
            expect((await look(page, errors)).asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R1×A1',
        kind: '遷移',
        title: '解決待ちの ref が再び現れても聞き直さず、文字のまま待つ',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await update(page, FIG1_WITH2);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([GH]);
            expect(seen.gh).toBe('text');
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('circle');
        },
    },
    {
        cells: '図1 R2×A1',
        kind: '遷移',
        title: '解決済みの ref は聞き直さず、差し替えた文書の最初の描画からロゴ',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            const shown = await page.evaluate((next) => {
                const w = window as any;
                w.diagram.update(next);
                const mark = document.querySelector('#a .mdag-node .mdag-content .mdag-icon[data-icon="gh"]');
                return mark?.querySelector('svg circle') ? 'circle' : 'text';
            }, FIG1_WITH2);
            expect(shown).toBe('circle');
            expect((await look(page, errors)).asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R3×A1',
        kind: '遷移',
        title: '引けなかった ref は聞き直さず文字のまま',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(null) });
            await update(page, FIG1_WITH2);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([GH]);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual([]);
        },
    },
    {
        cells: '図1 R4×A1',
        kind: '遷移',
        title: '失敗した ref は聞き直さず、診断も出し直さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: THROW });
            await update(page, FIG1_WITH2);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([GH]);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R5×A1・R5×A3',
        kind: '今の挙動',
        title: '外から入れた ref が文書に現れると問い合わせ、null の結果で外の値を上書きする',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: sync(null) });
            await update(page, FIG1_WITH);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([GH]);
            expect(seen.gh).toBe('text');
        },
    },
    {
        cells: '図1 R6×A1・R6×A10',
        kind: '無視',
        title: '片付けたあとの文書の差し替え (ref が現れる・消える) では問い合わせない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITHOUT, { [GH]: sync(CIRCLE) });
            await destroy(page);
            await update(page, FIG1_WITH);
            await update(page, FIG1_WITHOUT2);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([]);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // A2〜A6 (R0 と R5 でだけ起きる)
    {
        cells: '図1 R0×A2',
        kind: '遷移',
        title: '同期で SVG → 最初の描画からロゴ',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            const seen = await look(page, errors);
            expect(seen.gh).toBe('circle');
            expect(seen.diagnostics).toEqual([]);
        },
    },
    {
        cells: '図1 R0×A3',
        kind: '遷移',
        title: '同期で null か文字列でない値 → 文字のまま、診断なし',
        run: async (page, errors) => {
            for (const behavior of [sync(null), { how: 'sync' } as ProbeBehavior]) {
                await draw(page, FIG1_WITH, { [GH]: behavior });
                const seen = await look(page, errors);
                expect(seen.gh).toBe('text');
                expect(seen.diagnostics).toEqual([]);
            }
        },
    },
    {
        cells: '図1 R0×A4',
        kind: '遷移',
        title: '同期で SVG として読めない文字列 → 文字のまま、診断なし',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync('not an svg') });
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual([]);
        },
    },
    {
        cells: '図1 R0×A5',
        kind: '遷移',
        title: '同期で throw → 文字のまま、onDiagnostic に icon-unresolved (info、位置なし)。ほかの ref は続く',
        run: async (page, errors) => {
            await draw(page, [...FRONT, '---', '', '# R', '', '## :gh: A', '- [ ] :k8s: B', ''].join('\n'), { [GH]: THROW, [K8S]: sync(SQUARE) });
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
            expect(await page.locator('#a .mdag-icon[data-icon="k8s"] svg rect').count()).toBe(1);
        },
    },
    {
        cells: '図1 R0×A6',
        kind: '遷移',
        title: 'Promise → 最初の描画は文字 (解決待ち)',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R5×A2',
        kind: '今の挙動',
        title: '外から入れた値を、同期の SVG の結果で上書きする',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: sync(CIRCLE) });
            expect(await storeShownAs(page, errors)).toBe('circle');
        },
    },
    {
        cells: '図1 R5×A4',
        kind: '今の挙動',
        title: '外から入れた値を、読めない文字列の結果 (null) で上書きする',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: sync('not an svg') });
            expect(await storeShownAs(page, errors)).toBe('text');
            expect((await look(page, errors)).diagnostics).toEqual([]);
        },
    },
    {
        cells: '図1 R5×A5',
        kind: '今の挙動',
        title: '外から入れた値を、throw の結果 (null) で上書きし、診断を出す',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: THROW });
            expect(await storeShownAs(page, errors)).toBe('text');
            expect((await look(page, errors)).diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R5×A6',
        kind: '今の挙動',
        title: 'Promise が済むまでは外の値のまま、済むと上書きする',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: MANUAL });
            expect(await storeShownAs(page, errors)).toBe('path');
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('circle');
        },
    },
    // A7〜A9
    {
        cells: '図1 R1×A7',
        kind: '遷移',
        title: 'Promise が SVG で済むと、その ref のロゴだけ描き直す',
        run: async (page, errors) => {
            await draw(page, [...FRONT, '---', '', '# R', '', '## :gh: A', '- [ ] :k8s: B', ''].join('\n'), { [GH]: MANUAL, [K8S]: sync(SQUARE) });
            await page.evaluate(() => ((document.querySelector('#a .mdag-icon[data-icon="k8s"] svg') as any).__kept = true));
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('circle');
            expect(await page.evaluate(() => (document.querySelector('#a .mdag-icon[data-icon="k8s"] svg') as any).__kept === true)).toBe(true);
        },
    },
    {
        cells: '図1 R1×A8',
        kind: '遷移',
        title: 'Promise が null、文字列でない値、読めない文字列で済む → 文字のまま、診断なし',
        run: async (page, errors) => {
            for (const value of [null, 42, 'not an svg']) {
                await draw(page, FIG1_WITH, { [GH]: MANUAL });
                await settle(page, GH, value);
                const seen = await look(page, errors);
                expect(seen.gh).toBe('text');
                expect(seen.diagnostics).toEqual([]);
            }
        },
    },
    {
        cells: '図1 R1×A9',
        kind: '遷移',
        title: 'Promise が reject → 文字のまま、onDiagnostic に icon-unresolved (info)',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await settle(page, GH, 'offline', true);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R1×A14・R6×A7',
        kind: '遷移',
        title: '解決待ちのまま片付けると、あとで届いた SVG は捨てる',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await destroy(page);
            await settle(page, GH, CIRCLE);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    {
        cells: '図1 R6×A8',
        kind: '遷移',
        title: '片付けたあとに null で済んでも捨てる',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await destroy(page);
            await settle(page, GH, null);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.diagnostics).toEqual([]);
            expect(seen.errors).toEqual([]);
        },
    },
    {
        cells: '図1 R6×A9',
        kind: '遷移',
        title: '片付けたあとの reject は捨て、診断も出さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await destroy(page);
            await settle(page, GH, 'offline', true);
            const seen = await look(page, errors);
            expect(seen.diagnostics).toEqual([]);
            expect(seen.errors).toEqual([]);
        },
    },
    // A10
    {
        cells: '図1 R0×A10',
        kind: '無視',
        title: '問い合わせていない ref を使わない文書への差し替えでは何も起きない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITHOUT, { [GH]: sync(CIRCLE) });
            await update(page, FIG1_WITHOUT2);
            expect((await look(page, errors)).asked).toEqual([]);
        },
    },
    {
        cells: '図1 R1×A10',
        kind: '遷移',
        title: '解決待ちの ref を使わない文書にしても、結果は置き場に入り、再び現れたときは聞き直さずロゴ',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await update(page, FIG1_WITHOUT);
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('none');
            await update(page, FIG1_WITH);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('circle');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R2×A10',
        kind: '遷移',
        title: '解決済みの ref を使わない文書にしても置き場に残る',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            await update(page, FIG1_WITHOUT);
            await update(page, FIG1_WITH);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('circle');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R3×A10',
        kind: '遷移',
        title: '引けなかった ref を使わない文書にしても、戻したときに聞き直さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(null) });
            await update(page, FIG1_WITHOUT);
            await update(page, FIG1_WITH);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R4×A10',
        kind: '遷移',
        title: '失敗した ref を使わない文書にしても、戻したときに聞き直さず診断も出し直さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: THROW });
            await update(page, FIG1_WITHOUT);
            await update(page, FIG1_WITH);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.asked).toEqual([GH]);
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R5×A10',
        kind: '遷移',
        title: '外から入れた値は、ref を使わない文書の差し替えをまたいで置き場に残る',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: MANUAL });
            await update(page, FIG1_WITHOUT2);
            expect(await storeShownAs(page, errors)).toBe('path');
        },
    },
    // A11
    {
        cells: '図1 R0×A11',
        kind: '遷移',
        title: '問い合わせていない ref に外から SVG を入れると置き場に入る (文書に現れると問い合わせる)',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: MANUAL });
            expect((await look(page, errors)).asked).toEqual([]);
            expect(await storeShownAs(page, errors)).toBe('path');
            expect((await look(page, errors)).asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R1×A11',
        kind: '今の挙動',
        title: '解決待ちの間に外から入れた SVG は描かれ、Promise が済むとその結果で上書きされる',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await setIcon(page, GH, TRIANGLE);
            expect((await look(page, errors)).gh).toBe('path');
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('circle');
        },
    },
    {
        cells: '図1 R2×A11',
        kind: '遷移',
        title: '解決済みのロゴに外から別の SVG を入れると差し替え、同じ SVG なら何もしない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            await setIcon(page, GH, TRIANGLE);
            expect((await look(page, errors)).gh).toBe('path');
            await page.evaluate(() => ((document.querySelector('#a .mdag-icon[data-icon="gh"] svg') as any).__kept = true));
            await setIcon(page, GH, TRIANGLE);
            expect(await page.evaluate(() => (document.querySelector('#a .mdag-icon[data-icon="gh"] svg') as any).__kept === true)).toBe(true);
        },
    },
    {
        cells: '図1 R3×A11',
        kind: '遷移',
        title: '引けなかった ref に外から SVG を入れるとロゴになり、聞き直さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(null) });
            await setIcon(page, GH, TRIANGLE);
            await update(page, FIG1_WITH2);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('path');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R4×A11',
        kind: '遷移',
        title: '失敗した ref に外から SVG を入れるとロゴになる。診断は取り消さない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: THROW });
            await setIcon(page, GH, TRIANGLE);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('path');
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R5×A11',
        kind: '遷移',
        title: '外から入れた値を外から差し替える',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: MANUAL });
            await setIcon(page, GH, SQUARE);
            expect(await storeShownAs(page, errors)).toBe('rect');
        },
    },
    {
        cells: '図1 R6×A11',
        kind: '今の挙動',
        title: '片付けたあとの外からの SVG は誤りなく戻り、画面には出ない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            await destroy(page);
            await setIcon(page, GH, TRIANGLE);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // A12
    {
        cells: '図1 R0×A12',
        kind: '遷移',
        title: '問い合わせていない ref に外から null を入れると置き場に null (文書に現れると問い合わせる)',
        run: async (page, errors) => {
            await enterR5(page, null, { [GH]: MANUAL });
            expect(await storeShownAs(page, errors)).toBe('text');
            expect((await look(page, errors)).asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R1×A12',
        kind: '今の挙動',
        title: '解決待ちの間に外から入れた null は、Promise が済むとその結果で上書きされる',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: MANUAL });
            await setIcon(page, GH, null);
            expect((await look(page, errors)).gh).toBe('text');
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors)).gh).toBe('circle');
        },
    },
    {
        cells: '図1 R2×A12',
        kind: '遷移',
        title: '解決済みのロゴに外から null か読めない文字列を入れると文字に戻る',
        run: async (page, errors) => {
            for (const value of [null, 'not an svg']) {
                await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
                await setIcon(page, GH, value);
                expect((await look(page, errors)).gh).toBe('text');
            }
        },
    },
    {
        cells: '図1 R3×A12',
        kind: '遷移',
        title: '引けなかった ref に外から null を入れても何もしない (印の要素は作り直さない)',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(null) });
            await page.evaluate(() => ((document.querySelector('#a .mdag-icon[data-icon="gh"]') as any).__kept = true));
            await setIcon(page, GH, null);
            expect(await page.evaluate(() => (document.querySelector('#a .mdag-icon[data-icon="gh"]') as any).__kept === true)).toBe(true);
            expect((await look(page, errors)).gh).toBe('text');
        },
    },
    {
        cells: '図1 R4×A12',
        kind: '遷移',
        title: '失敗した ref に外から null を入れても何もしない',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: THROW });
            await page.evaluate(() => ((document.querySelector('#a .mdag-icon[data-icon="gh"]') as any).__kept = true));
            await setIcon(page, GH, null);
            expect(await page.evaluate(() => (document.querySelector('#a .mdag-icon[data-icon="gh"]') as any).__kept === true)).toBe(true);
            const seen = await look(page, errors);
            expect(seen.gh).toBe('text');
            expect(seen.diagnostics).toEqual(['info icon-unresolved null']);
        },
    },
    {
        cells: '図1 R5×A12',
        kind: '遷移',
        title: '外から入れた SVG を外から null にする',
        run: async (page, errors) => {
            await enterR5(page, TRIANGLE, { [GH]: MANUAL });
            await setIcon(page, GH, null);
            expect(await storeShownAs(page, errors)).toBe('text');
        },
    },
    {
        cells: '図1 R6×A12',
        kind: '今の挙動',
        title: '片付けたあとの外からの null は誤りなく戻る',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            await destroy(page);
            await setIcon(page, GH, null);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // A14 (R1 は上の R1×A14・R6×A7)
    ...(['R0', 'R2', 'R3', 'R4', 'R5'] as const).map(
        (state): Case => ({
            cells: `図1 ${state}×A14`,
            kind: '遷移',
            title: '片付けると図が消え、onDestroy が 1 度呼ばれる',
            run: async (page, errors) => {
                if (state === 'R5') await enterR5(page, TRIANGLE, { [GH]: MANUAL });
                else await draw(page, state === 'R0' ? FIG1_WITHOUT : FIG1_WITH, { [GH]: state === 'R2' ? sync(CIRCLE) : state === 'R3' ? sync(null) : state === 'R4' ? THROW : sync(CIRCLE) });
                await destroy(page);
                const seen = await look(page, errors);
                expect(seen.empty).toBe(true);
                expect(seen.hooks.destroy).toBe(1);
                expect(seen.errors).toEqual([]);
            },
        }),
    ),
    {
        cells: '図1 R6×A14',
        kind: '無視',
        title: 'もう一度片付けても誤りにならず、問い合わせもしない (onDestroy のフックはもう一度呼ばれる)',
        run: async (page, errors) => {
            await draw(page, FIG1_WITH, { [GH]: sync(CIRCLE) });
            await destroy(page);
            await destroy(page);
            const seen = await look(page, errors);
            expect(seen.asked).toEqual([GH]);
            expect(seen.hooks.destroy).toBe(2);
            expect(seen.errors).toEqual([]);
        },
    },
];

// A13 は view を付け替えるので、createHookBridge + MarkdagView で描く。#a が前の view、#b が新しい view
async function bridgeDraw(page: Page, resolver: Behaviors): Promise<void> {
    await page.evaluate(
        ({ resolver }) => {
            const w = window as any;
            const { markdag } = w.harness;
            w.iconsProbe.reset();
            w.source = '';
            w.bridge = markdag.createHookBridge({ source: () => w.source, resolveIcon: w.iconsProbe.resolver(resolver), onDiagnostic: w.iconsProbe.onDiagnostic });
            w.views = [new markdag.MarkdagView(document.getElementById('a'), w.bridge.viewHooks), new markdag.MarkdagView(document.getElementById('b'), w.bridge.viewHooks)];
            w.bridge.attach(w.views[0]);
            w.show = (source: string) => {
                w.source = source;
                const parsed = markdag.parseDocument(source);
                w.bridge.setDocument(parsed, markdag.buildModel(parsed.nodes, parsed.frontmatter, source), true);
            };
        },
        { resolver },
    );
}
const bridgeShow = (page: Page, source: string): Promise<unknown> => page.evaluate((next) => (window as any).show(next), source);
const attachSecond = (page: Page): Promise<unknown> => page.evaluate(() => (window as any).bridge.attach((window as any).views[1]));

const FIG1_ATTACH: Case[] = [
    {
        cells: '図1 R0×A13',
        kind: '無視',
        title: '問い合わせていない ref は、view を付け替えても渡すものがない',
        run: async (page, errors) => {
            await bridgeDraw(page, { [GH]: sync(CIRCLE) });
            await bridgeShow(page, FIG1_WITHOUT);
            await attachSecond(page);
            const seen = await look(page, errors, '#b');
            expect(seen.asked).toEqual([]);
            expect(seen.errors).toEqual([]);
        },
    },
    {
        cells: '図1 R1×A13',
        kind: '遷移',
        title: '解決待ちの間に view を付け替えると、済んだ結果は今付いている view に届く',
        run: async (page, errors) => {
            await bridgeDraw(page, { [GH]: MANUAL });
            await bridgeShow(page, FIG1_WITH);
            await attachSecond(page);
            await bridgeShow(page, FIG1_WITH);
            await settle(page, GH, CIRCLE);
            expect((await look(page, errors, '#b')).gh).toBe('circle');
            expect((await look(page, errors, '#a')).gh).toBe('text');
            expect((await look(page, errors)).asked).toEqual([GH]);
        },
    },
    ...(
        [
            ['R2', sync(CIRCLE), 'circle', []],
            ['R3', sync(null), 'text', []],
            ['R4', THROW, 'text', ['info icon-unresolved null']],
        ] as const
    ).map(
        ([state, behavior, shown, diagnostics]): Case => ({
            cells: `図1 ${state}×A13`,
            kind: '遷移',
            title: '済んだ結果は、付け替えた view の置き場に入れ直す (聞き直さない、診断も出し直さない)',
            run: async (page, errors) => {
                await bridgeDraw(page, { [GH]: behavior });
                await bridgeShow(page, FIG1_WITH);
                await attachSecond(page);
                await bridgeShow(page, FIG1_WITH);
                const seen = await look(page, errors, '#b');
                expect(seen.gh).toBe(shown);
                expect(seen.asked).toEqual([GH]);
                expect(seen.diagnostics).toEqual([...diagnostics]);
            },
        }),
    ),
    {
        cells: '図1 R5×A13',
        kind: '今の挙動',
        title: '前の view に外から入れた値は、付け替えた view に移らない (R0 と同じ)',
        run: async (page, errors) => {
            await bridgeDraw(page, { [GH]: MANUAL });
            await bridgeShow(page, FIG1_WITHOUT);
            await page.evaluate((svg) => (window as any).views[0].setIconSvg('simple-icons:github', svg), TRIANGLE);
            await attachSecond(page);
            await bridgeShow(page, FIG1_WITH);
            const seen = await look(page, errors, '#b');
            expect(seen.gh).toBe('text');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        cells: '図1 R6×A13',
        kind: '今の挙動',
        title: '片付けたあとの attach でも、済んだ結果を新しい view の置き場に入れる',
        run: async (page, errors) => {
            await bridgeDraw(page, { [GH]: sync(CIRCLE) });
            await bridgeShow(page, FIG1_WITH);
            await page.evaluate(() => (window as any).bridge.destroy());
            await attachSecond(page);
            // 新しい view に直接描いて、置き場の中身を見る
            await page.evaluate((source) => {
                const w = window as any;
                const parsed = w.harness.markdag.parseDocument(source);
                w.views[1].setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, source));
            }, FIG1_WITH);
            const seen = await look(page, errors, '#b');
            expect(seen.gh).toBe('circle');
            expect(seen.asked).toEqual([GH]);
        },
    },
    {
        // R1×A14 で片付けたあと、R6×A13 で新しい view を付けてから A7 が届く順。橋渡しの view が新しい view を指すので、捨てる判定がないと届いてしまう
        cells: '図1 R6×A7 (attach のあと)',
        kind: '遷移',
        title: '解決待ちのまま片付け、新しい view を付けてから Promise が済んでも、結果は捨てる (新しい view は文字のまま、聞き直さない)',
        run: async (page, errors) => {
            await bridgeDraw(page, { [GH]: MANUAL });
            await bridgeShow(page, FIG1_WITH);
            await page.evaluate(() => (window as any).bridge.destroy());
            await attachSecond(page);
            await page.evaluate((source) => {
                const w = window as any;
                const parsed = w.harness.markdag.parseDocument(source);
                w.views[1].setDocument(parsed, w.harness.markdag.buildModel(parsed.nodes, parsed.frontmatter, source));
            }, FIG1_WITH);
            await settle(page, GH, CIRCLE);
            const seen = await look(page, errors, '#b');
            expect(seen.gh).toBe('text');
            expect(seen.asked).toEqual([GH]);
            expect(seen.diagnostics).toEqual([]);
            expect(seen.errors).toEqual([]);
        },
    },
];

// ---- 図 2 吹き出しとロゴ ----

const FIG2_CASES: Case[] = [
    // B1
    {
        cells: '図2 Q0×B1・Q1×B2 (Q3 へ)',
        kind: '遷移',
        title: '重ねると開く待ちになり、250ms で開く (ロゴ済み)',
        run: async (page, errors) => {
            await draw(page, FIG2, { [GH]: sync(CIRCLE), [K8S]: sync(SQUARE) });
            await hover(page, X);
            closed(await look(page, errors));
            await wait(page);
            openAt(await look(page, errors), X, false, X_LOGO);
        },
    },
    {
        cells: '図2 Q1×B1',
        kind: '遷移',
        title: '開く待ちの間にもう一度重ねても開く待ちのまま、あとで開く',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await reenter(page, X);
            closed(await look(page, errors));
            await wait(page);
            openAt(await look(page, errors), X, false, X_TEXT);
        },
    },
    {
        cells: '図2 Q2×B1・Q2×B2',
        kind: '遷移',
        title: '開いている (文字あり) ノードにもう一度重ねると、250ms 後に作り直す (onDetailsShow がもう一度呼ばれる)',
        run: async (page, errors) => {
            await enterQ(page, 'Q2');
            await tagPopoverBody(page);
            await reenter(page, X);
            expect(await popoverBodyKept(page)).toBe(true);
            await wait(page);
            const seen = await look(page, errors);
            openAt(seen, X, false, X_TEXT);
            expect(await popoverBodyKept(page)).toBe(false);
            expect(seen.hooks.show).toBe(2);
        },
    },
    {
        cells: '図2 Q3×B1・Q3×B2',
        kind: '遷移',
        title: '開いている (ロゴ済み) ノードにもう一度重ねると、250ms 後に作り直す',
        run: async (page, errors) => {
            await enterQ(page, 'Q3');
            await tagPopoverBody(page);
            await reenter(page, X);
            await wait(page);
            const seen = await look(page, errors);
            openAt(seen, X, false, X_LOGO);
            expect(await popoverBodyKept(page)).toBe(false);
            expect(seen.hooks.show).toBe(2);
        },
    },
    ...(['Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B1・${state}×B5`,
            kind: '無視',
            title: '固定中は、同じノードや別のノードに重ねても開き直さない',
            run: async (page, errors) => {
                await enterQ(page, state);
                await tagPopoverBody(page);
                await reenter(page, X);
                await hover(page, Y);
                await wait(page);
                const seen = await look(page, errors);
                openAt(seen, X, true, state === 'Q4' ? X_TEXT : X_LOGO);
                expect(await popoverBodyKept(page)).toBe(true);
                expect(seen.hooks.show).toBe(1);
            },
        }),
    ),
    {
        cells: '図2 Q6×B1・Q6×B2・Q6×B3・Q6×B5',
        kind: '無視',
        title: '片付けたあとは重ねても離しても何も出ない (待っていたタイマーも止まっている)',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await hover(page, X);
            await destroy(page);
            await wait(page);
            await page.mouse.move(300, 300);
            await leave(page);
            await wait(page);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.hooks.show).toBe(0);
            expect(seen.errors).toEqual([]);
        },
    },
    // B2 (Q1 から Q2 へ)
    {
        cells: '図2 Q1×B2 (Q2 へ)',
        kind: '遷移',
        title: '開く待ちの 250ms が経つと、置き場に SVG のない ref があれば文字ありで開く',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await wait(page);
            openAt(await look(page, errors), X, false, X_TEXT);
        },
    },
    // B3
    {
        cells: '図2 Q0×B3',
        kind: '無視',
        title: '閉じているときに離れても何も起きない',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await leave(page);
            await wait(page);
            const seen = await look(page, errors);
            closed(seen);
            expect(seen.hooks.hide).toBe(0);
        },
    },
    {
        cells: '図2 Q1×B3',
        kind: '遷移',
        title: '開く待ちの間に離れると開かずに終わる',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await leave(page);
            await wait(page);
            const seen = await look(page, errors);
            closed(seen);
            expect(seen.hooks.show).toBe(0);
        },
    },
    ...(['Q2', 'Q3'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B3`,
            kind: '遷移',
            title: '重ねて開いた吹き出しは、離れて 200ms で閉じる (onDetailsHide)',
            run: async (page, errors) => {
                await enterQ(page, state);
                await leave(page);
                await wait(page);
                const seen = await look(page, errors);
                closed(seen);
                expect(seen.hooks.hide).toBe(1);
            },
        }),
    ),
    ...(['Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B3`,
            kind: '無視',
            title: '固定中は離れても閉じない',
            run: async (page, errors) => {
                await enterQ(page, state);
                await hover(page, X);
                await leave(page);
                await wait(page);
                openAt(await look(page, errors), X, true, state === 'Q4' ? X_TEXT : X_LOGO);
            },
        }),
    ),
    // B4
    {
        cells: '図2 Q0×B4 (Q4 へ)',
        kind: '遷移',
        title: '閉じているときに印をクリックすると固定で開く (文字あり)',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await clickMark(page, X);
            openAt(await look(page, errors), X, true, X_TEXT);
        },
    },
    {
        cells: '図2 Q0×B4 (Q5 へ)',
        kind: '遷移',
        title: '閉じているときに印をクリックすると固定で開く (ロゴ済み)',
        run: async (page, errors) => {
            await draw(page, FIG2, { [GH]: sync(CIRCLE) });
            await clickMark(page, X);
            openAt(await look(page, errors), X, true, X_LOGO);
        },
    },
    {
        cells: '図2 Q1×B4',
        kind: '遷移',
        title: '開く待ちの間に印をクリックすると、タイマーを止めて固定で開く',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await clickMark(page, X);
            await wait(page);
            const seen = await look(page, errors);
            openAt(seen, X, true, X_TEXT);
            expect(seen.hooks.show).toBe(1);
        },
    },
    ...(
        [
            ['Q2', X_TEXT],
            ['Q3', X_LOGO],
        ] as const
    ).map(
        ([state, marks]): Case => ({
            cells: `図2 ${state}×B4`,
            kind: '遷移',
            title: '重ねて開いた吹き出しの印をクリックすると固定に切り替える',
            run: async (page, errors) => {
                await enterQ(page, state);
                await clickMark(page, X);
                const seen = await look(page, errors);
                openAt(seen, X, true, [...marks]);
                expect(seen.hooks.show).toBe(2);
            },
        }),
    ),
    ...(['Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B4`,
            kind: '遷移',
            title: '固定中に同じ印をクリックすると閉じる',
            run: async (page, errors) => {
                await enterQ(page, state);
                await clickMark(page, X);
                const seen = await look(page, errors);
                closed(seen);
                expect(seen.popover.pinned).toEqual([]);
                expect(seen.hooks.hide).toBe(1);
            },
        }),
    ),
    {
        cells: '図2 Q6×B4・Q6×B6',
        kind: '無視',
        title: '片付けたあとは、外れた印をクリックしても画面に何も出ない',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            const marks = [await markOf(page, X).elementHandle(), await markOf(page, Y).elementHandle()];
            await destroy(page);
            for (const mark of marks) await mark?.dispatchEvent('click');
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // B5
    ...(['Q0', 'Q1', 'Q2', 'Q3'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B5`,
            kind: '遷移',
            title: '別のノード Y に重ねて 250ms で Y の吹き出しに切り替える',
            run: async (page, errors) => {
                await enterQ(page, state);
                await hover(page, Y);
                await wait(page);
                openAt(await look(page, errors), Y, false, Y_LOGO);
            },
        }),
    ),
    // B6
    ...(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B6`,
            kind: '遷移',
            title: '別のノード Y の印をクリックすると Y を固定で開く',
            run: async (page, errors) => {
                await enterQ(page, state);
                await clickMark(page, Y);
                await wait(page);
                openAt(await look(page, errors), Y, true, Y_LOGO);
            },
        }),
    ),
    // B7
    ...(['Q0', 'Q1', 'Q2', 'Q3'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B7`,
            kind: '無視',
            title: '固定していないときに外を押しても閉じない',
            run: async (page, errors) => {
                await enterQ(page, state);
                await pressOutside(page);
                if (state === 'Q1') await wait(page);
                const seen = await look(page, errors);
                if (state === 'Q0') closed(seen);
                else openAt(seen, X, false, state === 'Q3' ? X_LOGO : X_TEXT);
            },
        }),
    ),
    ...(['Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B7`,
            kind: '遷移',
            title: '固定中に外を押すと閉じる',
            run: async (page, errors) => {
                await enterQ(page, state);
                await pressOutside(page);
                closed(await look(page, errors));
            },
        }),
    ),
    {
        cells: '図2 Q6×B7・Q6×B8',
        kind: '無視',
        title: '片付けたあとの外を押す・Escape は受け口が外れていて何も起きない',
        run: async (page, errors) => {
            await enterQ(page, 'Q5');
            await destroy(page);
            await pressOutside(page);
            await escape(page);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.hooks.hide).toBe(0);
            expect(seen.errors).toEqual([]);
        },
    },
    // B8
    {
        cells: '図2 Q0×B8',
        kind: '無視',
        title: '閉じているときの Escape は何も起きない',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await escape(page);
            const seen = await look(page, errors);
            closed(seen);
            expect(seen.hooks.hide).toBe(0);
        },
    },
    ...(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B8`,
            kind: '遷移',
            title: 'Escape で閉じる (開く待ちならタイマーを止める)',
            run: async (page, errors) => {
                await enterQ(page, state);
                await escape(page);
                await wait(page);
                closed(await look(page, errors));
            },
        }),
    ),
    // B9
    {
        cells: '図2 Q0×B9',
        kind: '無視',
        title: '閉じているときにロゴが届いても閉じたまま (次に開くときに使う)',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await settle(page, GH, CIRCLE);
            closed(await look(page, errors));
            await clickMark(page, X);
            openAt(await look(page, errors), X, true, X_LOGO);
        },
    },
    {
        cells: '図2 Q1×B9',
        kind: '遷移',
        title: '開く待ちの間にロゴが届くと、開くときにロゴを使う',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await settle(page, GH, CIRCLE);
            closed(await look(page, errors));
            await wait(page);
            openAt(await look(page, errors), X, false, X_LOGO);
        },
    },
    {
        cells: '図2 Q2×B9',
        kind: '遷移',
        title: '開いている (文字あり) 吹き出しにロゴが届くと、開いたままその場で差し替える',
        run: async (page, errors) => {
            await enterQ(page, 'Q2');
            await tagPopoverBody(page);
            await settle(page, GH, CIRCLE);
            const seen = await look(page, errors);
            openAt(seen, X, false, X_LOGO);
            expect(await popoverBodyKept(page)).toBe(true);
            expect(seen.hooks.show).toBe(1);
        },
    },
    {
        cells: '図2 Q3×B9',
        kind: '遷移',
        title: '開いている (ロゴ済み) 吹き出しのロゴを別の SVG に差し替える',
        run: async (page, errors) => {
            await enterQ(page, 'Q3');
            await setIcon(page, GH, TRIANGLE);
            openAt(await look(page, errors), X, false, ['gh=path']);
        },
    },
    {
        cells: '図2 Q4×B9',
        kind: '遷移',
        title: '固定 (文字あり) の吹き出しにロゴが届くと、固定のまま差し替える',
        run: async (page, errors) => {
            await enterQ(page, 'Q4');
            await settle(page, GH, CIRCLE);
            openAt(await look(page, errors), X, true, X_LOGO);
        },
    },
    {
        cells: '図2 Q5×B9',
        kind: '遷移',
        title: '固定 (ロゴ済み) の吹き出しのロゴを別の SVG に差し替える',
        run: async (page, errors) => {
            await enterQ(page, 'Q5');
            await setIcon(page, GH, TRIANGLE);
            openAt(await look(page, errors), X, true, ['gh=path']);
        },
    },
    {
        cells: '図2 Q6×B9・Q6×B10',
        kind: '今の挙動',
        title: '開いたまま片付けたあとの setIconSvg は誤りなく戻り、画面には出ない',
        run: async (page, errors) => {
            await enterQ(page, 'Q6');
            await setIcon(page, GH, TRIANGLE);
            await setIcon(page, GH, null);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // B10
    {
        cells: '図2 Q0×B10',
        kind: '無視',
        title: '閉じているときに使う ref が null になっても閉じたまま',
        run: async (page, errors) => {
            await draw(page, FIG2, { [GH]: sync(CIRCLE) });
            await setIcon(page, GH, null);
            closed(await look(page, errors));
        },
    },
    {
        cells: '図2 Q1×B10',
        kind: '遷移',
        title: '開く待ちの間に使う ref が null になると、開くときは文字',
        run: async (page, errors) => {
            await draw(page, FIG2, { [GH]: sync(CIRCLE) });
            await hover(page, X);
            await setIcon(page, GH, null);
            closed(await look(page, errors));
            await wait(page);
            openAt(await look(page, errors), X, false, X_TEXT);
        },
    },
    ...(
        [
            ['Q2', false],
            ['Q3', false],
            ['Q4', true],
            ['Q5', true],
        ] as const
    ).map(
        ([state, pinned]): Case => ({
            cells: `図2 ${state}×B10`,
            kind: '遷移',
            title: '開いている吹き出しの使う ref が null になると、開いたまま文字 (ロゴなら文字に戻す)',
            run: async (page, errors) => {
                await enterQ(page, state);
                await setIcon(page, GH, null);
                openAt(await look(page, errors), X, pinned, X_TEXT);
            },
        }),
    ),
    // B11
    ...(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B11`,
            kind: '無視',
            title: '吹き出しが使わない ref か、置き場の変わらない setIconSvg では吹き出しに触らない',
            run: async (page, errors) => {
                await enterQ(page, state);
                const before = state === 'Q6' ? null : await look(page, errors);
                const opened = before !== null && !before.popover.hidden;
                if (opened) await tagPopoverBody(page);
                // 吹き出しが使わない ref と、今の置き場と同じ値
                await setIcon(page, 'simple-icons:unused', TRIANGLE);
                if (state === 'Q3' || state === 'Q5') await setIcon(page, GH, CIRCLE);
                if (state === 'Q1') await wait(page);
                const seen = await look(page, errors);
                if (state === 'Q6') {
                    expect(seen.empty).toBe(true);
                    expect(seen.errors).toEqual([]);
                    return;
                }
                if (state === 'Q0') closed(seen);
                else openAt(seen, X, state === 'Q4' || state === 'Q5', state === 'Q3' || state === 'Q5' ? X_LOGO : X_TEXT);
                if (opened) expect(await popoverBodyKept(page)).toBe(true);
            },
        }),
    ),
    // B12
    {
        cells: '図2 Q0×B12',
        kind: '遷移',
        title: '閉じているときの差し替え (形が同じ) は閉じたまま',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await update(page, FIG2_SAME_SHAPE);
            closed(await look(page, errors));
        },
    },
    {
        cells: '図2 Q1×B12',
        kind: '遷移',
        title: '開く待ちの間の差し替えはタイマーを止めるが、ポインタが上にあればブラウザが pointerenter を送り直し、250ms 後に開く',
        run: async (page, errors) => {
            await enterQ(page, 'Q1');
            await update(page, FIG2_SAME_SHAPE);
            const now = await look(page, errors);
            closed(now);
            expect(now.hooks.show).toBe(0);
            await wait(page, RESENT_ENTER_WAIT);
            const later = await look(page, errors);
            openAt(later, X, false, X_TEXT);
            expect(later.hooks.show).toBe(1);
        },
    },
    ...(
        [
            ['Q2', false, X_TEXT],
            ['Q3', false, X_LOGO],
            ['Q4', true, X_TEXT],
            ['Q5', true, X_LOGO],
        ] as const
    ).map(
        ([state, pinned, marks]): Case => ({
            cells: `図2 ${state}×B12`,
            kind: '遷移',
            title: '形が同じ差し替えでは、固定かポインタが上にあれば吹き出しを作り直して開いたまま',
            run: async (page, errors) => {
                await enterQ(page, state);
                if (!pinned) await hover(page, X);
                await tagPopoverBody(page);
                await update(page, FIG2_SAME_SHAPE);
                const seen = await look(page, errors);
                openAt(seen, X, pinned, [...marks]);
                expect(await popoverBodyKept(page)).toBe(false);
                expect(seen.hooks.show).toBe(2);
            },
        }),
    ),
    ...(
        [
            ['Q2', X_TEXT],
            ['Q3', X_LOGO],
        ] as const
    ).map(
        ([state, marks]): Case => ({
            cells: `図2 ${state}×B12`,
            kind: '遷移',
            title: 'ポインタが上にあるときの形が同じ差し替えは、すぐ作り直したあと、ブラウザが送り直す pointerenter で 250ms 後にもう一度作り直す',
            run: async (page, errors) => {
                await enterQ(page, state);
                await hover(page, X);
                await update(page, FIG2_SAME_SHAPE);
                const now = await look(page, errors);
                openAt(now, X, false, [...marks]);
                expect(now.hooks.show).toBe(2);
                expect(now.hooks.hide).toBe(1);
                await tagPopoverBody(page);
                await wait(page, RESENT_ENTER_WAIT);
                const later = await look(page, errors);
                openAt(later, X, false, [...marks]);
                expect(await popoverBodyKept(page)).toBe(false);
                expect(later.hooks.show).toBe(3);
                expect(later.hooks.hide).toBe(1);
            },
        }),
    ),
    {
        cells: '図2 Q6×B12・Q6×B13',
        kind: '無視',
        title: '片付けたあとの差し替えは view に届かない',
        run: async (page, errors) => {
            await enterQ(page, 'Q6');
            await update(page, FIG2_SAME_SHAPE);
            await update(page, FIG2_OTHER_SHAPE);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // B13
    ...(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B13`,
            kind: '遷移',
            title: '形の変わる差し替えでは閉じる (開いていれば onDetailsHide)',
            run: async (page, errors) => {
                await enterQ(page, state);
                await update(page, FIG2_OTHER_SHAPE);
                await wait(page);
                const seen = await look(page, errors);
                closed(seen);
                expect(seen.hooks.hide).toBe(state === 'Q0' || state === 'Q1' ? 0 : 1);
            },
        }),
    ),
    // B14
    {
        cells: '図2 Q0×B14',
        kind: '無視',
        title: '閉じているときに畳んでも何も起きない',
        run: async (page, errors) => {
            await enterQ(page, 'Q0');
            await page.evaluate((id) => (window as any).diagram.view.setFolded([id]), P);
            await wait(page);
            closed(await look(page, errors));
        },
    },
    {
        cells: '図2 Q1×B14',
        kind: '今の挙動',
        title: '開く待ちの間に畳まれても、タイマーが残って隠れたノードの吹き出しを開く',
        run: async (page, errors) => {
            // 本物のポインタで重ねると、畳んだときにブラウザが pointerleave を送って開く待ちが閉じる待ちに置き換わる。
            // ポインタを動かさずに pointerenter だけを送り、畳む操作 (view.setFolded) だけが起きた場合を見る
            await enterQ(page, 'Q0');
            await reenter(page, X);
            await page.evaluate((id) => (window as any).diagram.view.setFolded([id]), P);
            await wait(page);
            const seen = await look(page, errors);
            expect(seen.popover.hidden).toBe(false);
            expect(await page.locator(`#a .mdag-node[data-id="${X}"]`).isHidden()).toBe(true);
        },
    },
    ...(['Q2', 'Q3', 'Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B14`,
            kind: '遷移',
            title: 'X が畳まれて見えなくなると閉じる',
            run: async (page, errors) => {
                await enterQ(page, state);
                await page.evaluate((id) => (window as any).diagram.view.setFolded([id]), P);
                await wait(page);
                const seen = await look(page, errors);
                closed(seen);
                expect(seen.hooks.hide).toBe(1);
            },
        }),
    ),
    {
        cells: '図2 Q2×B14 (見せ方の変更)',
        kind: '遷移',
        title: '見せ方の変更 (setOptions) で吹き出しの中身がなくなると閉じる',
        run: async (page, errors) => {
            await enterQ(page, 'Q2');
            await page.evaluate(() => (window as any).diagram.view.setOptions({ details: 'always' }));
            await wait(page);
            closed(await look(page, errors));
        },
    },
    {
        cells: '図2 Q6×B14',
        kind: '無視',
        title: '片付けたあとに畳んでも誤りにならない',
        run: async (page, errors) => {
            await enterQ(page, 'Q6');
            await page.evaluate((id) => (window as any).diagram.view.setFolded([id]), P);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.errors).toEqual([]);
        },
    },
    // B15
    ...(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(
        (state): Case => ({
            cells: `図2 ${state}×B15`,
            kind: '遷移',
            title: '片付けると吹き出しごと消え、onDetailsHide は呼ばない (開く待ちのタイマーも止める)',
            run: async (page, errors) => {
                await enterQ(page, state);
                await destroy(page);
                await wait(page);
                const seen = await look(page, errors);
                expect(seen.empty).toBe(true);
                expect(seen.hooks.hide).toBe(0);
                expect(seen.hooks.show).toBe(state === 'Q0' || state === 'Q1' ? 0 : 1);
                expect(seen.errors).toEqual([]);
            },
        }),
    ),
    {
        cells: '図2 Q6×B15',
        kind: '無視',
        title: 'もう一度片付けても誤りにならない',
        run: async (page, errors) => {
            await enterQ(page, 'Q6');
            await destroy(page);
            const seen = await look(page, errors);
            expect(seen.empty).toBe(true);
            expect(seen.hooks.hide).toBe(0);
            expect(seen.errors).toEqual([]);
        },
    },
];

for (const [title, cases] of [
    ['状態遷移 図 1 ロゴ 1 つの解決', [...FIG1, ...FIG1_ATTACH]],
    ['状態遷移 図 2 吹き出しとロゴ', FIG2_CASES],
] as const) {
    test.describe(title, () => {
        for (const item of cases) {
            test(`${item.cells} (${item.kind}): ${item.title}`, async ({ page }) => {
                const errors = await open(page);
                await item.run(page, errors);
            });
        }
    });
}

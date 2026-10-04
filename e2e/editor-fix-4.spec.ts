// GUI 編集で依頼者が図を触って出した指摘のうち、子の +、兄弟の +、線を引く点の当たり判定を広げることと、
// 縮小したときに線を引く点を右下へずらすことを、ビルドした配布物の markdag/editor で確かめる。
// 決まったこと: 当たり判定は選択の枠の線の外側にだけ、絵のまわりに 6px 広げ、広げた所どうしが重なる所は絵に近いほうが取る。
// 子のあるノードの開閉の丸と重なる所は + と線を引く点を先にする。+ と点はどの倍率でも画面の大きさのまま。線を引く点はふだん
// 選択の枠の右下の角に置き、子の + か兄弟の + との丸どうしの間が 2px 未満になる倍率では、2px 以上になるまで右下 45° へずらす。
// 見た目そのもの (丸と + の大きさの値、色、形) は見ない。見るのは、押した所で起きる操作、点の上で反応するつまみ、
// 乗せたときのカーソルと強調の有無、丸どうしの間と置き場の関係、どの倍率でも丸の画面の大きさが同じこと。
// 絵の外接矩形は、つまみ (.mdag-editor-handle[data-handle]) の中の SVG の図形のうち、塗りか線のあるものの範囲 (線の太さの半分を含む)。
// 点の上で反応するつまみは、その点の要素 (elementFromPoint) が入っているつまみの data-handle で読む
// (広げた範囲もつまみの要素の中に置く前提。比べの頁の見本と同じ測り方)。
// 選択の枠は、選んだノードの箱 (.mdag-box) の outline。線の内側と外側は箱の辺から outline-offset × 倍率と
// (outline-offset + outline-width) × 倍率、外側の角の丸みは (border-radius + outline-offset + outline-width) × 倍率。
// 丸は、つまみの中の最初の SVG の circle (半径は線の外側まで)。
// 反映は expect.poll で待つ
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { EditorHarness } from './editor-harness';
import type { EditOp, NodeTarget } from '../src/core';
import type { EditorOptions, MarkdagEditor } from '../src/editor';

type HandleKind = 'child' | 'sibling' | 'link';
// 点で反応するつまみ (つまみでなければ none)
type Owner = HandleKind | 'none';
// 決まりから見た、点で反応するはずのもの。境目の近くで決めない点は skip
type Expected = Owner | 'skip';
type Direction = 'right' | 'left' | 'up' | 'down';

interface Point {
    x: number;
    y: number;
}

interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface Circle {
    cx: number;
    cy: number;
    r: number;
}

// 当たり判定の決まり。絵の外接矩形を expand 広げた四角。外接矩形の外 near までは必ず反応し、far より外は反応しない。
// 境目の近くは決めない。点で読むのは点を中心にした 1px の四角に掛かる要素 (chromium のマウスも同じ) なので、その分 (0.5px) と、
// 作りが範囲を細かい格子で割り当てたときの丸めの分を見る: near と far は 6px の境目から内へ 0.5px と外へ 1px、
// frameBand は選択の枠の線の外側の境目からの距離、tieBand は 2 つの四角が重なる所の、絵の外接矩形までの距離の差
interface HitRules {
    expand: number;
    near: number;
    far: number;
    frameBand: number;
    tieBand: number;
}

const HIT_RULES: HitRules = { expand: 6, near: 5.5, far: 7, frameBand: 1, tieBand: 1.5 };

// chromium 以外のブラウザ (サブピクセルの当たり判定と置き場の丸めが違う) では、境目のまわりをもう 1px 決めない
const engineSlack = (): number => (test.info().project.name === 'chromium' ? 0 : 1);

const hitRules = (): HitRules => {
    const slack = engineSlack();
    return { ...HIT_RULES, far: HIT_RULES.far + slack, frameBand: HIT_RULES.frameBand + slack, tieBand: HIT_RULES.tieBand + slack };
};

interface HitScene {
    k: number;
    box: Box;
    // 選択の枠の線の内側と外側の、箱の辺からの距離と、外側の角の丸み (画面の px)
    frame: { inner: number; outer: number; radius: number };
    // 絵の外接矩形 (画面の座標)
    drawings: Partial<Record<HandleKind, Box>>;
    // 丸 (画面の座標)
    circles: Partial<Record<HandleKind, Circle>>;
    // 選んだノードの開閉の丸 (子がなければ null)
    fold: Circle | null;
}

interface Survey {
    k: number;
    counts: Record<Expected, number>;
    mismatchCount: number;
    // 合わなかった点の例 (箱の右下の角からの位置)
    mismatches: string[];
    // 2 つ以上の広げた四角が重なる所で、決まりから取るものが決まり、そのとおりだった点の数 (組ごと)
    overlaps: Record<string, number>;
    // 開閉の丸の上で、つまみか点が取るはずの点のうち、そのとおりだった数と合わなかった数
    fold: { handled: number; mismatched: number } | null;
}

interface SidePoint extends Point {
    expected: Expected;
    // 絵の外接矩形を広げた形での、いちばん近い絵までの距離と、選択の枠の線の外側からの距離 (内側は負)
    nearest: number;
    frame: number;
}

// ページの中に置く測りの道具
interface Probe {
    scene(id: number): HitScene;
    expected(scene: HitScene, x: number, y: number): Expected;
    actual(x: number, y: number): string;
    survey(id: number, step: number): Survey;
    side(id: number, kind: HandleKind, direction: Direction, distance: number): SidePoint;
    cursorAt(x: number, y: number): string;
    // つまみの丸の塗り (乗せたときの強調を読む)
    ringFill(kind: HandleKind): string | null;
    // 開閉の丸の上で、決まりから kind が取る点のうち、開閉の丸の中心にいちばん近い点
    foldPoint(id: number, kind: HandleKind): Point | null;
}

type EditorWindow = Window & {
    editorHarness: EditorHarness;
    editors: Record<string, MarkdagEditor>;
    fix4Probe: Probe;
};

const DIST = resolve('dist');

// markdag.editor を書いた文書。markdag の行は markdag の下の字下げ (4 桁) からの相対
function docWith(body: string[]): string {
    return ['---', 'markdag:', '    edgeHighlight: true', '    editor:', '        mode: edit', '---', '', ...body].join('\n');
}

// ノードは Root 1、Design 2、Task A 3、Task B 4、Build 5、Leaf 6。図は左から右へ広がり、Task A と Task B は縦に並ぶ。
// 子のあるノード (Root、Design、Build) には開閉の丸がある。どのノードも 1 行 (箱の高さは倍率 1 で 20px。依頼者の見本と同じ)
const BODY = ['# Root', '', '## Design', '', '- Task A', '- Task B', '', '## Build', '', '- Leaf', ''];
const DESIGN = 2;
const TASK_A = 3;
const TASK_B = 4;
const LEAF = 6;
const LABELS: Record<number, string> = { 2: 'Design', 3: 'Task A', 4: 'Task B', 6: 'Leaf' };

const DOC = docWith(BODY);

// 足したノードの仮の名前
const NEW = '新しいノード';

// 線を引く点の丸と子の + か兄弟の + の丸の間 (縁から縁)。2px 以上になるまでずらす。測りの丸めの分 0.1px の余裕を見る。
// ずらしたときは必要な分だけ (間が max まで、ずらす量が要る量から over まで)
const LINK_GAP = { goal: 2, min: 1.9, max: 3, over: 1 };
// ずらす向きは右下 45° (横と縦のずれの差)
const DIAGONAL_SLACK = 0.5;
// 角のままとみなす余裕 (丸の中心が選択の枠の線の内側から外側までの範囲。editor-fix-1 と同じ読み方)
const CORNER_SLACK = 1;
// 角に置いたときの間がこの幅の中なら、ずらしてもずらさなくてもよい (測りの丸め)
const DECIDE_BAND = 0.1;
// 依頼者の見本の値 (1 行のノード、子の + との間で決まる。横と縦それぞれの px)。要る量の測り方の確かめに使う
const REFERENCE_SHIFT: ReadonlyArray<{ zoom: number; shift: number }> = [
    { zoom: 1, shift: 2.4 },
    { zoom: 0.6, shift: 10.4 },
    { zoom: 0.4, shift: 13.1 },
];
const REFERENCE_SLACK = 0.3;
// 乗せたときの丸の大きくなり方と中心の動き (editor-fix-1 と同じ)
const HOVER_GROWTH = 1.05;
const HOVER_SHIFT = 1;
// 倍率を変えても同じとみなす丸の半径の差
const SIZE_SLACK = 0.1;

// 確かめる図の倍率。fit は全体表示 (開いたとき。この文書と図の領域では上限の 2 倍)。1.122 は依頼者の見本で開いた直後の倍率
const ZOOMS_F16 = ['fit', 1.2, 1.122, 1, 0.8, 0.6, 0.4] as const;
type Zoom = 'fit' | number;
// 角に置くと丸どうしの間が 2px 未満になる倍率 (1 行のノードで、子の + との間で決まる)
const SHIFTED_ZOOMS: readonly Zoom[] = [1, 0.8, 0.6, 0.4];
// 依頼者の見本と同じ 1 行のノードの箱の高さ (倍率 1)。ブラウザの字の幅と高さが違って箱が違うときは、見本の値と倍率の分け方は確かめない
const ONE_LINE_HEIGHT = 20;

// ポインタを図の外へ逃がす所 (図の領域 #a は 1000×600)
const AWAY: Point = { x: 1200, y: 700 };

// 子のないノード (Task A、Leaf) と子のあるノード (Design)
const NODES = [
    { id: TASK_A, name: 'Task A (子なし)' },
    { id: LEAF, name: 'Leaf (子なし)' },
    { id: DESIGN, name: 'Design (子あり)' },
] as const;

test.beforeAll(() => {
    if (!existsSync(join(DIST, 'editor.js'))) throw new Error('dist/editor.js がない (npm run build を先に実行する)');
});

function watchErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return errors;
}

// ページの中に測りの道具を置く (引数のほかは外の値を使わない)
function installProbe(rules: HitRules): void {
    const KINDS: readonly HandleKind[] = ['child', 'sibling', 'link'];
    const container = document.getElementById('a');
    if (!container) throw new Error('#a がない');
    const target = window as unknown as EditorWindow;

    const handleOf = (kind: HandleKind): Element | null =>
        [...container.querySelectorAll(`.mdag-editor-handle[data-handle="${kind}"]`)].find((element) => element.checkVisibility()) ?? null;
    const painted = (value: string, opacity: string): boolean => value !== 'none' && value !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(value) && parseFloat(opacity) > 0;

    // 絵の外接矩形: 塗りか線のある SVG の図形の範囲 (線の太さの半分を含む)。図形は長さに沿って点を取る
    const drawingOf = (handle: Element): Box | null => {
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const shape of handle.querySelectorAll<SVGGeometryElement>('circle, ellipse, path, line, polyline, polygon, rect')) {
            const style = getComputedStyle(shape);
            if (style.visibility !== 'visible' || style.display === 'none' || parseFloat(style.opacity) === 0) continue;
            const fill = painted(style.fill, style.fillOpacity);
            const stroke = painted(style.stroke, style.strokeOpacity) && parseFloat(style.strokeWidth) > 0;
            if (!fill && !stroke) continue;
            const matrix = shape.getScreenCTM();
            if (!matrix) continue;
            const half = stroke ? (parseFloat(style.strokeWidth) * Math.hypot(matrix.a, matrix.b)) / 2 : 0;
            const total = shape.getTotalLength();
            const count = 240;
            for (let index = 0; index <= count; index += 1) {
                const local = shape.getPointAtLength((total * index) / count);
                const point = new DOMPoint(local.x, local.y).matrixTransform(matrix);
                left = Math.min(left, point.x - half);
                top = Math.min(top, point.y - half);
                right = Math.max(right, point.x + half);
                bottom = Math.max(bottom, point.y + half);
            }
        }
        return Number.isFinite(left) ? { left, top, right, bottom } : null;
    };

    // SVG の図形の矩形 (getBoundingClientRect) に線の太さを含めるブラウザ (firefox) か。線のある丸で確かめる
    const strokeInBounds = ((): boolean => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '40');
        svg.setAttribute('height', '40');
        svg.style.cssText = 'position: fixed; left: 0; top: 0;';
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '20');
        circle.setAttribute('cy', '20');
        circle.setAttribute('r', '10');
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'black');
        circle.setAttribute('stroke-width', '4');
        svg.append(circle);
        document.body.append(svg);
        const width = circle.getBoundingClientRect().width;
        svg.remove();
        return width > 22;
    })();

    // 要素そのものか中の最初の SVG の circle。半径は線の外側まで (画面の px。乗せたときの拡大などの CSS の変形も含める)
    const circleOf = (root: Element): Circle | null => {
        const circle = root instanceof SVGCircleElement ? root : root.querySelector('circle');
        if (!circle) return null;
        const bounds = circle.getBoundingClientRect();
        if (bounds.width === 0) return null;
        const style = getComputedStyle(circle);
        const stroke = style.stroke === 'none' ? 0 : parseFloat(style.strokeWidth) || 0;
        const radius = circle.r.baseVal.value;
        const scale = bounds.width / (2 * radius + (strokeInBounds ? stroke : 0));
        return { cx: bounds.left + bounds.width / 2, cy: bounds.top + bounds.height / 2, r: (radius + stroke / 2) * scale };
    };

    const scene = (id: number): HitScene => {
        const box = container.querySelector<HTMLElement>(`.mdag-node[data-id="${id}"] .mdag-box`);
        const view = target.editors.a?.view;
        if (!box || !view) throw new Error(`ノード ${id} の箱か図がない`);
        const rect = box.getBoundingClientRect();
        const k = view.getTransform().k;
        const style = getComputedStyle(box);
        const offset = parseFloat(style.outlineOffset) || 0;
        const width = style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0;
        const radius = parseFloat(style.borderTopLeftRadius) || 0;
        const drawings: Partial<Record<HandleKind, Box>> = {};
        const circles: Partial<Record<HandleKind, Circle>> = {};
        for (const kind of KINDS) {
            const handle = handleOf(kind);
            if (!handle) continue;
            const drawing = drawingOf(handle);
            if (drawing) drawings[kind] = drawing;
            const circle = circleOf(handle);
            if (circle) circles[kind] = circle;
        }
        const fold = container.querySelector(`.mdag-fold[data-id="${id}"]`);
        return {
            k,
            box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            frame: { inner: offset * k, outer: (offset + width) * k, radius: (radius + offset + width) * k },
            drawings,
            circles,
            fold: fold ? circleOf(fold) : null,
        };
    };

    // 選択の枠の線の外側の角を丸めた矩形からの距離 (内側は負)
    const frameDistance = (current: HitScene, x: number, y: number): number => {
        const { box, frame } = current;
        const left = box.left - frame.outer;
        const top = box.top - frame.outer;
        const right = box.right + frame.outer;
        const bottom = box.bottom + frame.outer;
        const radius = Math.min(frame.radius, (right - left) / 2, (bottom - top) / 2);
        const qx = Math.abs(x - (left + right) / 2) - ((right - left) / 2 - radius);
        const qy = Math.abs(y - (top + bottom) / 2) - ((bottom - top) / 2 - radius);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    };

    // 絵の外接矩形からの距離。inf は四角を広げた形 (広げた四角に入るか)、euc はふつうの距離 (どちらが近いか)
    const distances = (current: HitScene, x: number, y: number): Array<{ kind: HandleKind; inf: number; euc: number }> =>
        KINDS.flatMap((kind) => {
            const drawing = current.drawings[kind];
            if (!drawing) return [];
            const dx = Math.max(drawing.left - x, 0, x - drawing.right);
            const dy = Math.max(drawing.top - y, 0, y - drawing.bottom);
            return [{ kind, inf: Math.max(dx, dy), euc: Math.hypot(dx, dy) }];
        });

    // 決まり: 絵の外接矩形を広げた四角から、選択の枠の線の上と内側を除き、重なる所は絵の外接矩形に近いほうが取る。
    // 選択の枠の線の上と内側は、絵そのものの所 (今の当たり判定) を見ない
    const expected = (current: HitScene, x: number, y: number): Expected => {
        const all = distances(current, x, y);
        const inFrame = frameDistance(current, x, y);
        if (inFrame < rules.frameBand) {
            if (inFrame > -rules.frameBand) return 'skip';
            if (all.some((item) => item.inf < rules.frameBand)) return 'skip';
            return 'none';
        }
        const near = all.filter((item) => item.inf <= rules.far);
        if (near.length === 0) return 'none';
        const byEuc = [...near].sort((a, b) => a.euc - b.euc);
        const byInf = [...near].sort((a, b) => a.inf - b.inf);
        const [best, second] = byEuc;
        if (!best || byInf[0]?.kind !== best.kind || best.inf > rules.near) return 'skip';
        if (second && (second.euc - best.euc < rules.tieBand || second.inf - best.inf < rules.tieBand)) return 'skip';
        return best.kind;
    };

    // 点 (x, y) で読む要素。elementFromPoint が渡した点から右下の 1px の四角に掛かる要素を返すブラウザ (chromium、webkit) では、
    // 点を中心にした四角になるよう 0.5px 戻す。点そのものの要素を返すブラウザ (firefox) では戻さない。どちらかは小さな要素で確かめる
    const offset = ((): number => {
        const sample = document.createElement('div');
        sample.style.cssText = 'position: fixed; left: 10.5px; top: 10.5px; width: 4px; height: 4px; z-index: 2147483647;';
        document.body.append(sample);
        const square = document.elementFromPoint(9.75, 12) === sample;
        sample.remove();
        return square ? 0.5 : 0;
    })();
    const elementAt = (x: number, y: number): Element | null => document.elementFromPoint(x - offset, y - offset);

    const actual = (x: number, y: number): string => {
        const handle = elementAt(x, y)?.closest('.mdag-editor-handle');
        return handle && container.contains(handle) ? (handle.getAttribute('data-handle') ?? 'none') : 'none';
    };

    const round = (value: number): number => Math.round(value * 10) / 10;

    const survey = (id: number, step: number): Survey => {
        const current = scene(id);
        const drawings = Object.values(current.drawings);
        const counts: Record<Expected, number> = { child: 0, sibling: 0, link: 0, none: 0, skip: 0 };
        const overlaps: Record<string, number> = {};
        const fold = current.fold ? { handled: 0, mismatched: 0 } : null;
        const mismatches: string[] = [];
        let mismatchCount = 0;
        if (drawings.length === 0) return { k: current.k, counts, mismatchCount, mismatches, overlaps, fold };
        const pad = rules.far + 2;
        const area = container.getBoundingClientRect();
        const left = Math.max(area.left + 1, Math.min(...drawings.map((item) => item.left)) - pad);
        const top = Math.max(area.top + 1, Math.min(...drawings.map((item) => item.top)) - pad);
        const right = Math.min(area.right - 1, innerWidth - 1, Math.max(...drawings.map((item) => item.right)) + pad);
        const bottom = Math.min(area.bottom - 1, innerHeight - 1, Math.max(...drawings.map((item) => item.bottom)) + pad);
        for (let y = Math.floor(top) + step / 2; y < bottom; y += step) {
            for (let x = Math.floor(left) + step / 2; x < right; x += step) {
                const want = expected(current, x, y);
                counts[want] += 1;
                if (want === 'skip') continue;
                const got = actual(x, y);
                const ok = got === want;
                if (!ok) {
                    mismatchCount += 1;
                    if (mismatches.length < 8) mismatches.push(`箱の右下から (${round(x - current.box.right)}, ${round(y - current.box.bottom)}) 期待 ${want} 実際 ${got}`);
                }
                if (want === 'none') continue;
                const inside = distances(current, x, y)
                    .filter((item) => item.inf <= rules.expand)
                    .map((item) => item.kind)
                    .sort();
                if (inside.length >= 2 && ok) {
                    const key = inside.join('+');
                    overlaps[key] = (overlaps[key] ?? 0) + 1;
                }
                if (fold && current.fold && Math.hypot(x - current.fold.cx, y - current.fold.cy) < current.fold.r - 0.5) {
                    if (ok) fold.handled += 1;
                    else fold.mismatched += 1;
                }
            }
        }
        return { k: current.k, counts, mismatchCount, mismatches, overlaps, fold };
    };

    const side = (id: number, kind: HandleKind, direction: Direction, distance: number): SidePoint => {
        const current = scene(id);
        const drawing = current.drawings[kind];
        if (!drawing) throw new Error(`${kind} の絵がない`);
        const cx = (drawing.left + drawing.right) / 2;
        const cy = (drawing.top + drawing.bottom) / 2;
        const point =
            direction === 'right'
                ? { x: drawing.right + distance, y: cy }
                : direction === 'left'
                  ? { x: drawing.left - distance, y: cy }
                  : direction === 'up'
                    ? { x: cx, y: drawing.top - distance }
                    : { x: cx, y: drawing.bottom + distance };
        return {
            ...point,
            expected: expected(current, point.x, point.y),
            nearest: Math.min(...distances(current, point.x, point.y).map((item) => item.inf)),
            frame: frameDistance(current, point.x, point.y),
        };
    };

    const cursorAt = (x: number, y: number): string => {
        const element = elementAt(x, y);
        return element ? getComputedStyle(element).cursor : '';
    };

    const ringFill = (kind: HandleKind): string | null => {
        const circle = handleOf(kind)?.querySelector('circle');
        return circle ? getComputedStyle(circle).fill : null;
    };

    const foldPoint = (id: number, kind: HandleKind): Point | null => {
        const current = scene(id);
        const fold = current.fold;
        if (!fold) return null;
        let best: Point | null = null;
        let bestDistance = Infinity;
        for (let y = fold.cy - fold.r; y <= fold.cy + fold.r; y += 0.25) {
            for (let x = fold.cx - fold.r; x <= fold.cx + fold.r; x += 0.25) {
                const distance = Math.hypot(x - fold.cx, y - fold.cy);
                if (distance > fold.r - rules.frameBand || distance >= bestDistance) continue;
                if (expected(current, x, y) !== kind) continue;
                best = { x, y };
                bestDistance = distance;
            }
        }
        return best;
    };

    target.fix4Probe = { scene, expected, actual, survey, side, cursorAt, ringFill, foldPoint };
}

async function open(page: Page): Promise<void> {
    await page.goto('/e2e/editor-harness.html');
    await page.waitForFunction(() => 'editorHarness' in window);
    await page.evaluate(() => {
        (window as unknown as EditorWindow).editors = {};
    });
}

async function mount(page: Page, markdown: string): Promise<void> {
    await page.evaluate((markdown) => {
        const target = window as unknown as EditorWindow;
        const container = document.getElementById('a');
        if (!container) throw new Error('#a がない');
        const options: EditorOptions = { animate: false };
        target.editors.a = target.editorHarness.editor.mountEditor(container, markdown, options);
    }, markdown);
    await expect(page.locator('#a .mdag-node').first()).toBeVisible();
    await settle(page);
    await page.evaluate(installProbe, hitRules());
}

// 描画の数コマと少しの時間を待つ
async function settle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))));
}

const getSource = (page: Page): Promise<string | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.getSource());

const toolButton = (page: Page, tool: string) => page.locator(`#a .mdag-editor-tool[data-tool="${tool}"]`);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });
const nodeSelector = (id: number): string => `#a .mdag-node[data-id="${id}"]`;
const handleSelector = (kind: HandleKind): string => `#a .mdag-editor-handle[data-handle="${kind}"]`;
const previews = (page: Page) => visible(page, '#a .mdag-editor-link-preview');
const nameInputs = (page: Page) => visible(page, '#a .mdag-editor-name-input');

async function useSelectTool(page: Page): Promise<void> {
    await toolButton(page, 'select').click();
    await expect(page.locator('#a')).toHaveAttribute('data-editor-tool', 'select');
}

// 見えている要素の矩形 (画面の座標)
async function rectsOf(page: Page, selector: string): Promise<Box[]> {
    return page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)]
            .filter((element) => element.checkVisibility())
            .map((element) => {
                const rect = element.getBoundingClientRect();
                return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
            });
    }, selector);
}

async function nodeBox(page: Page, id: number): Promise<Box> {
    const [box] = await rectsOf(page, `${nodeSelector(id)} .mdag-box`);
    if (!box) throw new Error(`ノード ${id} の箱がない`);
    return box;
}

type Spot =
    // 図の何もないところ (図の領域そのものが表に出ている点)
    | { on: 'blank' }
    // 要素 (か中の要素) が表に出ている点
    | { on: 'element'; selector: string };

// 画面の座標で押せる点を探す (図の領域はスクロールを戻すので、locator.click ではなく座標を決めて page.mouse で押す)
async function spot(page: Page, target: Spot): Promise<Point> {
    const found = await page.evaluate((target) => {
        const inView = (x: number, y: number): boolean => x >= 2 && y >= 2 && x < innerWidth - 2 && y < innerHeight - 2;
        // 真ん中に近い点から試す
        const grid = (rect: DOMRect, step: number): Array<{ x: number; y: number }> => {
            const points: Array<{ x: number; y: number }> = [];
            for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
        };
        if (target.on === 'blank') {
            const container = document.getElementById('a');
            const viewport = container?.querySelector(':scope > .mdag-viewport');
            if (!container || !viewport) return null;
            return grid(container.getBoundingClientRect(), 16).find((point) => inView(point.x, point.y) && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
        }
        const element = [...document.querySelectorAll(target.selector)].find((item) => item.checkVisibility());
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return (
            grid(rect, Math.max(1, Math.min(rect.width, rect.height) / 8)).find((point) => {
                const hit = inView(point.x, point.y) ? document.elementFromPoint(point.x, point.y) : null;
                return hit !== null && element.contains(hit);
            }) ?? null
        );
    }, target);
    if (!found) throw new Error(`押せる点がない: ${JSON.stringify(target)}`);
    return found;
}

async function press(page: Page, point: Point): Promise<void> {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.up();
}

const boxPoint = (page: Page, id: number): Promise<Point> => spot(page, { on: 'element', selector: `${nodeSelector(id)} .mdag-box` });

async function pressNode(page: Page, id: number): Promise<void> {
    await press(page, await boxPoint(page, id));
}

// 主ボタンを押したまま points を順に通って離す。at はそれぞれの点に着いたときに呼ぶ
async function dragThrough(page: Page, from: Point, points: Point[], at?: (index: number) => Promise<void>): Promise<void> {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    try {
        for (const [index, point] of points.entries()) {
            await page.mouse.move(point.x, point.y, { steps: 6 });
            if (at) await at(index);
        }
    } finally {
        await page.mouse.up();
    }
}

const markedIds = (page: Page): Promise<number[]> =>
    page.evaluate(() => [...document.querySelectorAll('#a .mdag-node[data-selected]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b));

const dropTargetIds = (page: Page): Promise<number[]> =>
    page.evaluate(() => [...document.querySelectorAll('#a .mdag-node[data-drop-target]')].map((element) => Number(element.getAttribute('data-id'))).sort((a, b) => a - b));

// 図を、画面の上の距離で動かす
const panBy = (page: Page, dx: number, dy: number): Promise<void> => page.evaluate(({ dx, dy }) => (window as unknown as EditorWindow).editors.a?.view.panBy(dx, dy), { dx, dy });

// 矩形 (画面の座標) の中心が図の領域の中心に来るよう、図を動かす
async function centerOn(page: Page, box: Box): Promise<void> {
    const [area] = await rectsOf(page, '#a');
    if (!area) throw new Error('#a がない');
    await panBy(page, (area.left + area.right) / 2 - (box.left + box.right) / 2, (area.top + area.bottom) / 2 - (box.top + box.bottom) / 2);
}

// ノードを図の領域の中心に置き、図の倍率を zoom にする (fit なら全体表示にしてから中心に置く)
async function zoomOn(page: Page, id: number, zoom: Zoom): Promise<void> {
    if (zoom === 'fit') {
        await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        await settle(page);
        await centerOn(page, await nodeBox(page, id));
        return;
    }
    await centerOn(page, await nodeBox(page, id));
    await page.evaluate((k) => {
        const view = (window as unknown as EditorWindow).editors.a?.view;
        const container = document.getElementById('a');
        if (!view || !container) throw new Error('#a の図がない');
        view.zoomBy(k / view.getTransform().k, { x: container.clientWidth / 2, y: container.clientHeight / 2 });
    }, zoom);
    await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.view.getTransform().k)).toBeCloseTo(zoom, 3);
}

// 選んだノードのつまみと点が出るまで待つ (ここで使うノードはどれもルートでない)
async function expectHandles(page: Page, message?: string): Promise<void> {
    await expect(visible(page, handleSelector('child')), message).toHaveCount(1);
    await expect(visible(page, handleSelector('sibling')), message).toHaveCount(1);
    await expect(visible(page, handleSelector('link')), message).toHaveCount(1);
}

const sceneOf = (page: Page, id: number): Promise<HitScene> => page.evaluate((id) => (window as unknown as EditorWindow).fix4Probe.scene(id), id);

// つまみと点の置き場が落ち着く (続けて 2 回読んで同じ) まで待つ
async function waitStill(page: Page, id: number): Promise<void> {
    const key = async (): Promise<string> => {
        const scene = await sceneOf(page, id);
        return JSON.stringify([scene.box, scene.drawings, scene.circles], (_, value: unknown) => (typeof value === 'number' ? Math.round(value * 10) / 10 : value));
    };
    let last = await key();
    for (let round = 0; round < 30; round += 1) {
        await page.waitForTimeout(80);
        const now = await key();
        if (now === last) return;
        last = now;
    }
    throw new Error(`ノード ${id} のつまみと点が落ち着かない`);
}

// 選択の道具でノード id を選び (選んでいなければ)、ノードを図の中心に置いて倍率を zoom にし、ポインタを図の外へ逃がす
async function prepare(page: Page, id: number, zoom: Zoom, message?: string): Promise<void> {
    await expect(nameInputs(page), message).toHaveCount(0);
    const marked = await markedIds(page);
    if (marked.length !== 1 || marked[0] !== id) {
        await pressNode(page, id);
        await expect.poll(() => markedIds(page), message).toEqual([id]);
    }
    await expectHandles(page, message);
    await zoomOn(page, id, zoom);
    await page.mouse.move(AWAY.x, AWAY.y);
    await settle(page);
    await waitStill(page, id);
}

// 選んだノードの絵の外接矩形の辺から direction へ distance 離れた点。決まりから反応するはずのものが want でなければ (none なら、どの絵からも
// 6.5px 以上離れて選択の枠の外になければ)、測り方の前提が崩れている
async function sidePoint(page: Page, id: number, kind: HandleKind, direction: Direction, distance: number, want: Owner): Promise<Point> {
    const point = await page.evaluate(({ id, kind, direction, distance }) => (window as unknown as EditorWindow).fix4Probe.side(id, kind, direction, distance), { id, kind, direction, distance });
    const ok = want === 'none' ? point.nearest >= HIT_RULES.far - 0.5 && point.frame >= HIT_RULES.frameBand : point.expected === want;
    if (!ok) throw new Error(`${kind} の ${direction} ${distance}px の点は、決まりから ${point.expected} (${want} のはず。測り方の前提が崩れている)`);
    return { x: point.x, y: point.y };
}

// 測りの点に、マウスを置く座標。chromium のマウスは渡した点から右下の 1px の四角に掛かる要素に届くので、測りの点を中心にするよう 0.5px 戻す
// (webkit と firefox はマウスの座標を整数に切り捨てる。押す点は境目から 1px 以上離して選ぶ)
const pointer = (point: Point): Point => ({ x: point.x - 0.5, y: point.y - 0.5 });

const ownerAt = (page: Page, point: Point): Promise<string> => page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix4Probe.actual(x, y), point);

const target = (id: number): NodeTarget => ({ id, refText: LABELS[id] ?? '' });

// 配布物の editSource で同じ書き換えをした原文 (期待の原文)
async function edited(page: Page, source: string, op: EditOp): Promise<string> {
    const outcome = await page.evaluate(({ source, op }) => (window as unknown as EditorWindow).editorHarness.core.editSource(source, op), { source, op });
    if (outcome.status !== 'edited') throw new Error(`書き換えられない: ${JSON.stringify(outcome)}`);
    return outcome.source;
}

const callUndo = (page: Page): Promise<boolean | undefined> => page.evaluate(() => (window as unknown as EditorWindow).editors.a?.undo());

// 確かめた結果。よければ true、だめなら測った値の文 (失敗の差分に値が出るように)
const verdict = (ok: boolean, detail: string): true | string => (ok ? true : detail);

const round1 = (value: number): number => Math.round(value * 10) / 10;

// 2 つの丸の間 (縁から縁。負なら重なる)
const gapBetween = (a: Circle, b: Circle): number => Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;

// 線を引く点の置き場を測った値
interface LinkPlacement {
    k: number;
    // 選択の枠の右下の角 (線の中ほど) と、線を引く点の丸の中心のそこからのずれ
    corner: Point;
    dx: number;
    dy: number;
    // 線を引く点の丸を角に置いたときと、今の、子の + と兄弟の + との間のうち小さいほう
    cornerGap: number;
    gap: number;
    // 角から右下 45° へ、間が 2px 以上になるまでに要るずらす量 (横と縦それぞれ)
    needed: number;
    // 丸の中心が選択の枠の線の内側から外側までの範囲に入っている (角のまま)
    atCorner: boolean;
}

async function linkPlacement(page: Page, id: number): Promise<LinkPlacement> {
    const scene = await sceneOf(page, id);
    const { box, frame, circles, k } = scene;
    const link = circles.link;
    const pluses = [circles.child, circles.sibling].filter((circle): circle is Circle => circle !== undefined);
    if (!link || pluses.length === 0) throw new Error(`ノード ${id}: 線を引く点か + の丸がない`);
    const middle = (frame.inner + frame.outer) / 2;
    const corner = { x: box.right + middle, y: box.bottom + middle };
    const gapAt = (cx: number, cy: number): number => Math.min(...pluses.map((plus) => gapBetween(plus, { cx, cy, r: link.r })));
    let needed = Infinity;
    for (let t = 0; t <= 100; t += 0.05) {
        if (gapAt(corner.x + t, corner.y + t) >= LINK_GAP.goal) {
            needed = t;
            break;
        }
    }
    const within = (value: number): boolean => value >= frame.inner - CORNER_SLACK && value <= frame.outer + CORNER_SLACK;
    return {
        k,
        corner,
        dx: link.cx - corner.x,
        dy: link.cy - corner.y,
        cornerGap: gapAt(corner.x, corner.y),
        gap: gapAt(link.cx, link.cy),
        needed,
        atCorner: within(link.cx - box.right) && within(link.cy - box.bottom),
    };
}

// 線を引く点の丸の中心の、選んだノードの箱の右下の角からの位置と図の倍率 (画面の px)。点が出ていなければ null
async function linkOffset(page: Page, id: number): Promise<{ k: number; dx: number; dy: number } | null> {
    const scene = await sceneOf(page, id);
    const link = scene.circles.link;
    return link ? { k: scene.k, dx: link.cx - scene.box.right, dy: link.cy - scene.box.bottom } : null;
}

// 縮小して線を引く点をずらしている間に開くもの。開くキーと、開いたことを読む要素
const OPENERS = {
    name: { label: '名前の入力', key: 'Enter', selector: '#a .mdag-editor-name-input' },
    details: { label: '詳細の入力', key: 'd', selector: '#a .mdag-editor-details-editor' },
    tags: { label: 'タグのパネル', key: 't', selector: '#a .mdag-editor-tag-panel' },
} as const;
type Opener = keyof typeof OPENERS;

// 線を引く点が開く前と同じ所にあるか (箱の右下の角からの位置の差が横と縦とも 1px 以内で、倍率が同じ)
const SAME_PLACE = 1;
function samePlace(before: { k: number; dx: number; dy: number }, now: { k: number; dx: number; dy: number } | null): true | string {
    if (now === null) return '線を引く点が出ていない';
    return verdict(
        Math.abs(now.dx - before.dx) <= SAME_PLACE && Math.abs(now.dy - before.dy) <= SAME_PLACE && Math.abs(now.k - before.k) < 1e-6,
        `箱の右下の角からの位置 (${round1(now.dx)}, ${round1(now.dy)})px (開く前は (${round1(before.dx)}, ${round1(before.dy)})px、k ${now.k})`,
    );
}

// 置き場が決まりどおりか。角のままでよい倍率では角のまま、ずらす倍率では右下 45° へ必要な分だけずらす (どちらの場合も間は 1.9px 以上)
function placementVerdict(placement: LinkPlacement): { place: true | string; gap: true | string } {
    const values = `k ${round1(placement.k * 1000) / 1000}、角に置いたときの間 ${round1(placement.cornerGap)}px、今の間 ${round1(placement.gap)}px、角からのずれ dx ${round1(placement.dx)}px dy ${round1(placement.dy)}px、要るずらす量 ${round1(placement.needed)}px`;
    const shifted = (): boolean => {
        const t = (placement.dx + placement.dy) / 2;
        return Math.abs(placement.dx - placement.dy) <= DIAGONAL_SLACK && t > 0 && t <= placement.needed + LINK_GAP.over && placement.gap <= LINK_GAP.max;
    };
    let place: boolean;
    if (placement.cornerGap >= LINK_GAP.goal + DECIDE_BAND) place = placement.atCorner;
    else if (placement.cornerGap < LINK_GAP.goal - DECIDE_BAND) place = shifted();
    else place = placement.atCorner || shifted();
    return { place: verdict(place, values), gap: verdict(placement.gap >= LINK_GAP.min, values) };
}

test.describe('+ と線を引く点の当たり判定 (F-12)', () => {
    test('@editor 子の + の絵の外接矩形の外 1〜5.5px (選択の枠の外) を押すと子を足す。6.5px より外 (8px) を押しても足さない (倍率 1、子のないノード)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const added = await edited(page, DOC, { kind: 'addChild', parent: target(TASK_A), label: NEW });
        const near: Array<[Direction, number]> = [
            ['right', 1],
            ['right', 3],
            ['right', 5.5],
            ['up', 3],
        ];
        for (const [direction, distance] of near) {
            const label = `子の + の ${direction} ${distance}px`;
            await prepare(page, TASK_A, 1, label);
            const point = await sidePoint(page, TASK_A, 'child', direction, distance, 'child');
            await press(page, pointer(point));
            await expect.poll(() => getSource(page), label).toBe(added);
            await page.keyboard.press('Escape');
            await expect.poll(() => getSource(page), `${label} の Esc`).toBe(DOC);
        }
        const far: Array<[Direction, number]> = [
            ['right', 8],
            ['up', 8],
        ];
        for (const [direction, distance] of far) {
            const label = `子の + の ${direction} ${distance}px`;
            await prepare(page, TASK_A, 1, label);
            const point = await sidePoint(page, TASK_A, 'child', direction, distance, 'none');
            await press(page, pointer(point));
            await settle(page);
            expect(await getSource(page), label).toBe(DOC);
            await expect(nameInputs(page), label).toHaveCount(0);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 兄弟の + の絵の外接矩形の外 1〜5.5px (選択の枠の外) を押すと兄弟を足す。6.5px より外 (8px) を押しても足さない (倍率 1、子のないノード)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const added = await edited(page, DOC, { kind: 'addSibling', node: target(TASK_A), label: NEW });
        const near: Array<[Direction, number]> = [
            ['down', 1],
            ['down', 3],
            ['down', 5.5],
            ['left', 3],
        ];
        for (const [direction, distance] of near) {
            const label = `兄弟の + の ${direction} ${distance}px`;
            await prepare(page, TASK_A, 1, label);
            const point = await sidePoint(page, TASK_A, 'sibling', direction, distance, 'sibling');
            await press(page, pointer(point));
            await expect.poll(() => getSource(page), label).toBe(added);
            await page.keyboard.press('Escape');
            await expect.poll(() => getSource(page), `${label} の Esc`).toBe(DOC);
        }
        const far: Array<[Direction, number]> = [
            ['down', 8],
            ['left', 8],
        ];
        for (const [direction, distance] of far) {
            const label = `兄弟の + の ${direction} ${distance}px`;
            await prepare(page, TASK_A, 1, label);
            const point = await sidePoint(page, TASK_A, 'sibling', direction, distance, 'none');
            await press(page, pointer(point));
            await settle(page);
            expect(await getSource(page), label).toBe(DOC);
            await expect(nameInputs(page), label).toHaveCount(0);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 線を引く点の絵 (丸と線と矢尻) の外接矩形の外 1〜5.5px (選択の枠の外) からほかのノードへドラッグすると線を引く (倍率 1 と、点をずらす 0.6)。6.5px より外 (8px) からのドラッグでは引く線が出ない', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const linked = await edited(page, DOC, { kind: 'addRelation', from: target(TASK_A), to: target(LEAF) });
        const near: Array<[Zoom, Direction, number]> = [
            [1, 'right', 1],
            [1, 'right', 3],
            [1, 'right', 5.5],
            [1, 'down', 3],
            [0.6, 'right', 3],
        ];
        for (const [zoom, direction, distance] of near) {
            const label = `倍率 ${zoom} の線を引く点の ${direction} ${distance}px`;
            await prepare(page, TASK_A, zoom, label);
            const from = await sidePoint(page, TASK_A, 'link', direction, distance, 'link');
            const leaf = await boxPoint(page, LEAF);
            await dragThrough(page, pointer(from), [leaf], async () => {
                await expect(previews(page), `${label} のドラッグの途中の引く線`).toHaveCount(1);
            });
            await expect.poll(() => getSource(page), label).toBe(linked);
            expect(await callUndo(page), `${label} の元に戻す`).toBe(true);
            await expect.poll(() => getSource(page), `${label} の元に戻す`).toBe(DOC);
        }
        const far: Array<[Direction, number]> = [
            ['right', 8],
            ['down', 8],
        ];
        for (const [direction, distance] of far) {
            const label = `線を引く点の ${direction} ${distance}px`;
            await prepare(page, TASK_A, 1, label);
            const from = pointer(await sidePoint(page, TASK_A, 'link', direction, distance, 'none'));
            await page.mouse.move(from.x, from.y);
            await page.mouse.down();
            try {
                await page.mouse.move(from.x + 30, from.y + 30, { steps: 6 });
                await settle(page);
                await expect(previews(page), label).toHaveCount(0);
            } finally {
                await page.mouse.up();
            }
            await settle(page);
            expect(await getSource(page), label).toBe(DOC);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 選んだノードのまわりの点で反応するつまみが決まりどおり: 絵の外接矩形の外 5.5px まではそのつまみ、7px より外はつまみでない (間は点を読む 1px の四角と丸めの分)。選択の枠の線の上と内側はつまみでない。2 つの四角が重なる所は絵に近いほう。開閉の丸の上も決まりどおりつまみと点が取る (子のないノードと子のあるノード。倍率は全体表示、1、0.6、0.4)', async ({ page }) => {
        test.setTimeout(120_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const measures: string[] = [];
        for (const { id, name } of NODES) {
            for (const zoom of ['fit', 1, 0.6, 0.4] as const) {
                const label = `${name} 倍率 ${zoom}`;
                await prepare(page, id, zoom, label);
                await expect
                    .poll(async () => {
                        const survey = await page.evaluate((id) => (window as unknown as EditorWindow).fix4Probe.survey(id, 1), id);
                        const { counts } = survey;
                        const summary = `k ${round1(survey.k * 1000) / 1000}、点の数 ${JSON.stringify(counts)}、重なる所 ${JSON.stringify(survey.overlaps)}、開閉の丸 ${JSON.stringify(survey.fold)}`;
                        return {
                            // 空振りの防ぎ: どのつまみにも、つまみでない所にも、決まりから決まった点が十分ある
                            covered: verdict(counts.child >= 100 && counts.sibling >= 100 && counts.link >= 100 && counts.none >= 100, summary),
                            matched: verdict(survey.mismatchCount === 0, `合わない点 ${survey.mismatchCount} (例: ${survey.mismatches.join('、')})。${summary}`),
                            // 倍率 1 では、子の + と線を引く点の広げた四角が重なる (絵に近いほうが取る所がある)
                            overlap: zoom === 1 ? verdict((survey.overlaps['child+link'] ?? 0) > 0, `子の + と線を引く点の重なる所で決まった点がない。${summary}`) : true,
                            // 子のあるノードでは、開閉の丸の上につまみか点が取るはずの所があり、全部そのとおり
                            fold: survey.fold ? verdict(survey.fold.handled > 0 && survey.fold.mismatched === 0, `開閉の丸 ${JSON.stringify(survey.fold)}`) : true,
                        };
                    }, label)
                    .toEqual({ covered: true, matched: true, overlap: true, fold: true });
                const survey = await page.evaluate((id) => (window as unknown as EditorWindow).fix4Probe.survey(id, 1), id);
                measures.push(`${label} (k ${round1(survey.k * 1000) / 1000}): 点の数 ${JSON.stringify(survey.counts)} 重なる所 ${JSON.stringify(survey.overlaps)} 開閉の丸 ${JSON.stringify(survey.fold)}`);
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        for (const line of measures) console.log(`fix-4 survey: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-4 survey', description })));
    });

    test('@editor 選択の枠の線の上、線と箱の間、箱の中では、つまみと点が反応しない。そこを押しても子も兄弟も足さず、箱の中を押すと選んだまま、箱の中からのドラッグは付け替えのドラッグ (移す先の枠が付き、引く線は出ない) (倍率は全体表示と 1)', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const zoom of ['fit', 1] as const) {
            const label = `倍率 ${zoom}`;
            await prepare(page, TASK_A, zoom, label);
            const scene = await sceneOf(page, TASK_A);
            const { box, frame } = scene;
            const midX = (box.left + box.right) / 2;
            const midY = (box.top + box.bottom) / 2;
            const width = box.right - box.left;
            const height = box.bottom - box.top;
            // 箱の辺からの距離: 線の上 (内側寄り、中ほど、外側の境目から 1px 内。外側の境目に近すぎる点は読まない)、線と箱の間、箱の中
            const onLine = [frame.inner + 0.5, (frame.inner + frame.outer) / 2, frame.outer - 1].filter((offset) => offset <= frame.outer - HIT_RULES.frameBand - engineSlack());
            const offsets = [...(onLine.length > 0 ? onLine : [frame.inner]), frame.inner / 2, -1.5];
            const points: Array<Point & { at: string }> = [];
            for (const offset of offsets) {
                for (const along of [-0.25, 0, 0.25]) {
                    points.push({ x: box.right + offset, y: midY + along * height, at: `右の辺から ${round1(offset)}px (縦 ${along})` });
                    points.push({ x: midX + along * width, y: box.bottom + offset, at: `下の辺から ${round1(offset)}px (横 ${along})` });
                }
            }
            await expect
                .poll(async () => {
                    const wrong: string[] = [];
                    for (const point of points) {
                        const owner = await ownerAt(page, point);
                        if (owner !== 'none') wrong.push(`${point.at}: ${owner}`);
                    }
                    return wrong;
                }, label)
                .toEqual([]);
        }

        // 線の上 (右の辺と下の辺の中ほど) を押しても足さない
        for (const at of ['right', 'bottom'] as const) {
            const label = `倍率 1 の選択の枠の線の上 (${at})`;
            await prepare(page, TASK_A, 1, label);
            const { box, frame } = await sceneOf(page, TASK_A);
            const middle = Math.max(frame.inner, Math.min((frame.inner + frame.outer) / 2, frame.outer - HIT_RULES.frameBand - engineSlack()));
            const point = at === 'right' ? { x: box.right + middle, y: (box.top + box.bottom) / 2 } : { x: (box.left + box.right) / 2, y: box.bottom + middle };
            expect(await ownerAt(page, point), label).toBe('none');
            await press(page, pointer(point));
            await settle(page);
            expect(await getSource(page), label).toBe(DOC);
            await expect(nameInputs(page), label).toHaveCount(0);
        }

        // 箱の中 (右の辺の内側 1.5px) を押すと選んだまま
        await prepare(page, TASK_A, 1, '箱の中を押す');
        const inside = await sceneOf(page, TASK_A);
        const insidePoint = { x: inside.box.right - 1.5, y: (inside.box.top + inside.box.bottom) / 2 };
        expect(await ownerAt(page, insidePoint), '箱の中を押す').toBe('none');
        await press(page, pointer(insidePoint));
        await settle(page);
        expect(await markedIds(page), '箱の中を押す').toEqual([TASK_A]);
        expect(await getSource(page), '箱の中を押す').toBe(DOC);
        await expect(nameInputs(page), '箱の中を押す').toHaveCount(0);

        // 箱の中 (右の辺と下の辺の内側 2px) からのドラッグは付け替えのドラッグ。何もないところで離して付け替えない
        for (const at of ['right', 'bottom'] as const) {
            const label = `箱の中 (${at} の辺の内側) からのドラッグ`;
            await prepare(page, TASK_A, 1, label);
            const { box } = await sceneOf(page, TASK_A);
            const from = at === 'right' ? { x: box.right - 2, y: (box.top + box.bottom) / 2 } : { x: (box.left + box.right) / 2, y: box.bottom - 2 };
            expect(await ownerAt(page, from), label).toBe('none');
            const leaf = await boxPoint(page, LEAF);
            const blank = await spot(page, { on: 'blank' });
            await dragThrough(page, pointer(from), [leaf, blank], async (index) => {
                if (index !== 0) return;
                await expect.poll(() => dropTargetIds(page), `${label}: Leaf の上`).toEqual([LEAF]);
                await expect(previews(page), `${label}: Leaf の上`).toHaveCount(0);
            });
            await settle(page);
            expect(await getSource(page), label).toBe(DOC);
        }
        expect(errors).toEqual([]);
    });

    test('@editor 広げた範囲 (絵の外接矩形の外 3px) に乗せると、絵の上に乗せたときと同じカーソル (+ は pointer) と強調になる: + は丸の塗りが変わり、線を引く点は丸の中心を止めて大きくなる (1.05 倍以上)。離すと戻る (倍率 1)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        await prepare(page, TASK_A, 1);

        for (const [kind, direction] of [
            ['child', 'right'],
            ['sibling', 'down'],
        ] as const) {
            const ringFill = (): Promise<string | null> => page.evaluate((kind) => (window as unknown as EditorWindow).fix4Probe.ringFill(kind), kind);
            const scene = await sceneOf(page, TASK_A);
            const drawing = scene.drawings[kind];
            if (!drawing) throw new Error(`${kind} の絵がない`);
            const center = { x: (drawing.left + drawing.right) / 2, y: (drawing.top + drawing.bottom) / 2 };
            const normal = await ringFill();
            // 絵の上に乗せたときのカーソルと塗り
            await page.mouse.move(pointer(center).x, pointer(center).y);
            await expect.poll(ringFill, `${kind} の絵の上`).not.toBe(normal);
            const hovered = await ringFill();
            const cursor = await page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix4Probe.cursorAt(x, y), center);
            expect(cursor, `${kind} の絵の上のカーソル`).toBe('pointer');
            await page.mouse.move(AWAY.x, AWAY.y);
            await expect.poll(ringFill, `${kind} から離した`).toBe(normal);

            const point = await sidePoint(page, TASK_A, kind, direction, 3, kind);
            await page.mouse.move(pointer(point).x, pointer(point).y);
            await expect
                .poll(
                    async () => ({
                        owner: await ownerAt(page, point),
                        cursor: await page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix4Probe.cursorAt(x, y), point),
                        fill: await ringFill(),
                    }),
                    `${kind} の ${direction} 3px に乗せた`,
                )
                .toEqual({ owner: kind, cursor: 'pointer', fill: hovered });
            await page.mouse.move(AWAY.x, AWAY.y);
            await expect.poll(ringFill, `${kind} の ${direction} 3px から離した`).toBe(normal);
        }

        // 線を引く点
        const before = (await sceneOf(page, TASK_A)).circles.link;
        if (!before) throw new Error('線を引く点の丸がない');
        const dotCursor = await page.evaluate(({ cx, cy }) => (window as unknown as EditorWindow).fix4Probe.cursorAt(cx, cy), before);
        const point = await sidePoint(page, TASK_A, 'link', 'right', 3, 'link');
        await page.mouse.move(pointer(point).x, pointer(point).y);
        await expect
            .poll(async () => {
                const after = (await sceneOf(page, TASK_A)).circles.link;
                if (!after) return 'なくなった';
                const ratio = after.r / before.r;
                const shift = Math.hypot(after.cx - before.cx, after.cy - before.cy);
                return {
                    owner: await ownerAt(page, point),
                    cursor: await page.evaluate(({ x, y }) => (window as unknown as EditorWindow).fix4Probe.cursorAt(x, y), point),
                    grown: verdict(ratio >= HOVER_GROWTH, `直径の比 ${Math.round(ratio * 100) / 100}`),
                    still: verdict(shift <= HOVER_SHIFT, `中心の動き ${round1(shift)}px`),
                };
            }, '線を引く点の right 3px に乗せた')
            .toEqual({ owner: 'link', cursor: dotCursor, grown: true, still: true });
        await page.mouse.move(AWAY.x, AWAY.y);
        await expect
            .poll(async () => {
                const after = (await sceneOf(page, TASK_A)).circles.link;
                return after ? round1(after.r) : null;
            }, '線を引く点から離した')
            .toBe(round1(before.r));
    });

    test('@editor 子のあるノードの開閉の丸と重なる所は + と線を引く点が取る: 開閉の丸の上の子の + が取る所を押すと子を足して開閉しない。線を引く点が取る所からドラッグすると線を引く (倍率 1、Design)', async ({ page }) => {
        test.setTimeout(60_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const added = await edited(page, DOC, { kind: 'addChild', parent: target(DESIGN), label: NEW });
        const linked = await edited(page, DOC, { kind: 'addRelation', from: target(DESIGN), to: target(LEAF) });

        await prepare(page, DESIGN, 1, '子の +');
        const childPoint = await page.evaluate((id) => (window as unknown as EditorWindow).fix4Probe.foldPoint(id, 'child'), DESIGN);
        if (!childPoint) throw new Error('開閉の丸の上に、決まりから子の + が取る点がない');
        expect(await ownerAt(page, childPoint), '開閉の丸の上の子の + が取る所').toBe('child');
        await press(page, pointer(childPoint));
        await expect.poll(() => getSource(page), '開閉の丸の上の子の + が取る所').toBe(added);
        // 開閉していない: Design の子 (Task A と Task B) は見えたまま
        await expect(visible(page, nodeSelector(TASK_A)), '開閉の丸の上の子の + が取る所').toHaveCount(1);
        await expect(visible(page, nodeSelector(TASK_B)), '開閉の丸の上の子の + が取る所').toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect.poll(() => getSource(page), '子の + の Esc').toBe(DOC);

        await prepare(page, DESIGN, 1, '線を引く点');
        const linkPoint = await page.evaluate((id) => (window as unknown as EditorWindow).fix4Probe.foldPoint(id, 'link'), DESIGN);
        if (!linkPoint) throw new Error('開閉の丸の上に、決まりから線を引く点が取る点がない');
        const leaf = await boxPoint(page, LEAF);
        expect(await ownerAt(page, linkPoint), '開閉の丸の上の線を引く点が取る所').toBe('link');
        await dragThrough(page, pointer(linkPoint), [leaf], async () => {
            await expect(previews(page), '開閉の丸の上の線を引く点が取る所からのドラッグ').toHaveCount(1);
        });
        await expect.poll(() => getSource(page), '開閉の丸の上の線を引く点が取る所からのドラッグ').toBe(linked);
        await expect(visible(page, nodeSelector(TASK_A)), '線を引いたあと').toHaveCount(1);
        expect(await callUndo(page)).toBe(true);
        await expect.poll(() => getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });
});

test.describe('縮小したときの線を引く点 (F-16)', () => {
    test('@editor 線を引く点は、角に置くと子の + か兄弟の + との丸どうしの間が 2px 未満になる倍率 (1、0.8、0.6、0.4) では、右下 45° へ間が 2px 以上になるまでずらし (ずらしすぎない: 間は 3px まで)、ずらさなくてよい倍率 (全体表示、1.2、1.122) では選択の枠の右下の角のまま (子のないノードと子のあるノード)', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        const measures: string[] = [];
        for (const { id, name } of NODES) {
            const shiftedZooms: Zoom[] = [];
            const needs = new Map<Zoom, number>();
            let oneLine = false;
            for (const zoom of ZOOMS_F16) {
                const label = `${name} 倍率 ${zoom}`;
                await prepare(page, id, zoom, label);
                await expect.poll(async () => placementVerdict(await linkPlacement(page, id)), label).toEqual({ place: true, gap: true });
                const placement = await linkPlacement(page, id);
                if (placement.cornerGap < LINK_GAP.goal) shiftedZooms.push(zoom);
                needs.set(zoom, placement.needed);
                if (zoom === 1) {
                    const { box } = await sceneOf(page, id);
                    oneLine = Math.abs(box.bottom - box.top - ONE_LINE_HEIGHT) <= 0.5;
                }
                measures.push(
                    `${label} (k ${round1(placement.k * 1000) / 1000}): 角に置いたときの間 ${round1(placement.cornerGap)}px、要るずらす量 ${round1(placement.needed)}px、角からのずれ dx ${round1(placement.dx)}px dy ${round1(placement.dy)}px、今の間 ${round1(placement.gap)}px`,
                );
            }
            // 空振りの防ぎ: ずらす倍率とずらさない倍率の両方を確かめている
            expect(shiftedZooms, `${name} の、角に置くと間が 2px 未満になる倍率`).toEqual(expect.arrayContaining([0.6, 0.4]));
            expect(shiftedZooms, `${name} の、角に置くと間が 2px 未満になる倍率`).not.toContain('fit');
            if (oneLine) {
                // 依頼者の見本と同じ 1 行の箱: ずらす倍率の分け方と、要るずらす量 (測り方の確かめ。子の + との間で決まる) が見本と同じ
                expect(shiftedZooms, `${name} の、角に置くと間が 2px 未満になる倍率`).toEqual([...SHIFTED_ZOOMS]);
                for (const reference of REFERENCE_SHIFT) {
                    const needed = needs.get(reference.zoom) ?? Infinity;
                    expect(Math.abs(needed - reference.shift), `${name} 倍率 ${reference.zoom} の要るずらす量 ${round1(needed)}px (見本 ${reference.shift}px)`).toBeLessThanOrEqual(REFERENCE_SLACK);
                }
            } else {
                test.info().annotations.push({ type: 'fix-4 note', description: `${name}: 倍率 1 の箱の高さが ${ONE_LINE_HEIGHT}px でないので、見本の値と倍率の分け方は確かめていない` });
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        for (const line of measures) console.log(`fix-4 measure: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-4 measure', description })));
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });

    test('@editor 子の +、兄弟の +、線を引く点の丸の画面の大きさは、どの倍率でも同じ (倍率 1 と比べて半径の差 0.1px まで。倍率は全体表示、3、1.2、1、0.6、0.4。子のないノードと子のあるノード)', async ({ page }) => {
        test.setTimeout(90_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const id of [TASK_A, DESIGN]) {
            await prepare(page, id, 1, `${LABELS[id]} 倍率 1`);
            const base = (await sceneOf(page, id)).circles;
            if (!base.child || !base.sibling || !base.link) throw new Error(`${LABELS[id]}: つまみか点の丸がない`);
            for (const zoom of ['fit', 3, 1.2, 0.6, 0.4] as const) {
                const label = `${LABELS[id]} 倍率 ${zoom}`;
                await prepare(page, id, zoom, label);
                await expect
                    .poll(async () => {
                        const circles = (await sceneOf(page, id)).circles;
                        const same = (kind: HandleKind): true | string => {
                            const now = circles[kind];
                            const was = base[kind];
                            if (!now || !was) return '丸がない';
                            return verdict(Math.abs(now.r - was.r) <= SIZE_SLACK, `半径 ${round1(now.r * 10) / 10}px (倍率 1 では ${round1(was.r * 10) / 10}px)`);
                        };
                        return { child: same('child'), sibling: same('sibling'), link: same('link') };
                    }, label)
                    .toEqual({ child: true, sibling: true, link: true });
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
    });

    test('@editor ずらした線を引く点にポインタを乗せると、丸の中心を止めて大きくなる (1.05 倍以上、中心の動き 1px 以内)。離すと戻る (倍率 0.6 と 0.4)', async ({ page }) => {
        test.setTimeout(60_000);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        for (const { id, name } of NODES) {
            for (const zoom of [0.6, 0.4] as const) {
                const label = `${name} 倍率 ${zoom}`;
                await prepare(page, id, zoom, label);
                await expect.poll(async () => placementVerdict(await linkPlacement(page, id)), label).toEqual({ place: true, gap: true });
                const before = (await sceneOf(page, id)).circles.link;
                if (!before) throw new Error(`${label}: 線を引く点の丸がない`);
                expect(await ownerAt(page, { x: before.cx, y: before.cy }), `${label}: 丸の中心の上`).toBe('link');
                await page.mouse.move(pointer({ x: before.cx, y: before.cy }).x, pointer({ x: before.cx, y: before.cy }).y);
                await expect
                    .poll(async () => {
                        const after = (await sceneOf(page, id)).circles.link;
                        if (!after) return 'なくなった';
                        const ratio = after.r / before.r;
                        const shift = Math.hypot(after.cx - before.cx, after.cy - before.cy);
                        return {
                            grown: verdict(ratio >= HOVER_GROWTH, `直径の比 ${Math.round(ratio * 100) / 100}`),
                            still: verdict(shift <= HOVER_SHIFT, `中心の動き ${round1(shift)}px`),
                        };
                    }, `${label} 乗せた`)
                    .toEqual({ grown: true, still: true });
                await page.mouse.move(AWAY.x, AWAY.y);
                await expect
                    .poll(async () => {
                        const after = (await sceneOf(page, id)).circles.link;
                        return after ? round1(after.r) : null;
                    }, `${label} 離した`)
                    .toBe(round1(before.r));
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
    });
    test('@editor 線を引く点をずらしている倍率 (0.6 と 0.4) で、名前の入力、詳細の入力、タグのパネルを開いている間は線を引く点が見えず (触る F-17)、閉じると開く前と同じ置き場に戻る (+ を隠している間も、そのノードで出せる + でずらす量を決める。開く前と閉じたあとで丸の中心が 1px 以内。子のないノードと子のあるノード) (G-038)', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = watchErrors(page);
        await open(page);
        await mount(page, DOC);
        await useSelectTool(page);
        // 子のないノード (Leaf。項目なので詳細の入力も開ける) と子のあるノード (Design。見出しなので詳細の入力は開けない)
        const scenes: ReadonlyArray<{ id: number; name: string; openers: readonly Opener[] }> = [
            { id: LEAF, name: 'Leaf (子なし)', openers: ['name', 'details', 'tags'] },
            { id: DESIGN, name: 'Design (子あり)', openers: ['name', 'tags'] },
        ];
        const measures: string[] = [];
        for (const { id, name, openers } of scenes) {
            for (const zoom of [0.6, 0.4] as const) {
                for (const opener of openers) {
                    const { label: what, key, selector } = OPENERS[opener];
                    const label = `${name} 倍率 ${zoom} の${what}`;
                    await prepare(page, id, zoom, label);
                    // 空振りの防ぎ: 開く前に、線を引く点を角からずらしている
                    await expect.poll(async () => placementVerdict(await linkPlacement(page, id)), `${label} を開く前`).toEqual({ place: true, gap: true });
                    expect((await linkPlacement(page, id)).cornerGap, `${label} を開く前の、角に置いたときの間`).toBeLessThan(LINK_GAP.goal);
                    const before = await linkOffset(page, id);
                    if (!before) throw new Error(`${label}: 開く前に線を引く点が出ていない`);

                    await page.evaluate(() => document.getElementById('a')?.focus({ preventScroll: true }));
                    await page.keyboard.press(key);
                    await expect(visible(page, selector), `${label} を開いた`).toHaveCount(1);
                    // 開いている間は線を引く点を隠す (帯と子の +、兄弟の + と同じ)
                    await expect.poll(() => linkOffset(page, id), `${label} を開いている間の線を引く点`).toBeNull();
                    await settle(page);
                    expect(await linkOffset(page, id), `${label} を開いている間の線を引く点 (数コマあと)`).toBeNull();
                    await expect(visible(page, selector), `${label} を開いたまま`).toHaveCount(1);

                    await page.keyboard.press('Escape');
                    await expect(visible(page, selector), `${label} を閉じた`).toHaveCount(0);
                    await settle(page);
                    await expect.poll(async () => samePlace(before, await linkOffset(page, id)), `${label} を閉じたあと`).toBe(true);
                    measures.push(`${label}: 開く前の位置 (${round1(before.dx)}, ${round1(before.dy)})px、開いている間の線を引く点は出ていない`);
                }
            }
            await page.evaluate(() => (window as unknown as EditorWindow).editors.a?.fit());
        }
        for (const line of measures) console.log(`fix-4 G-038: ${line}`);
        test.info().annotations.push(...measures.map((description) => ({ type: 'fix-4 G-038', description })));
        expect(await getSource(page)).toBe(DOC);
        expect(errors).toEqual([]);
    });
});

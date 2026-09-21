// グループの枠の計算 (簡易版)。枠を持つグループごとに、見えているメンバーのまとまりを作り、入れ子の深さを決める。
// ラベルは枠の外側 (上の辺のすぐ上) に、左の角にそろえて置く。
// 入れ子の外側の枠は、内側の枠より一回り大きくして、枠の線とラベルが重ならないようにする。
// 枠の中に見えてよいのはメンバーだけにする。枠はメンバーの子の列の広がりで上下に張り出すので、隣のメンバーでないノード
// (閉じた枝など) がその下に入り込まないよう、張り出しのぶんだけ間隔を空ける。張り出しは配置の結果で決まるので、配置は 2 回以上行う。
import { boundsOf, type Rect } from '../layout/layout';
import type { VisibleGraph } from '../layout/project';
import type { GraphModel, GroupDef } from '../model/model';

export interface Frame {
    group: GroupDef;
    members: number[];
    // 内側に含む枠の段数。内側に枠がなければ 0
    level: number;
}

export interface FramePadding {
    top: number;
    side: number;
    bottom: number;
}

const BASE_PADDING = 8;
// ラベルの行の高さ
export const LABEL_HEIGHT = 14;
// 入れ子の 1 段ごとに、外側の枠を広げる幅。四辺とも同じにして、内側の枠との間隔をそろえる。
// 上側では、内側の枠のラベルの行 (内側の枠の上の辺のすぐ上) がこの幅の中に入るので、ラベルの行が収まる大きさにしている
const NEST_STEP = BASE_PADDING + LABEL_HEIGHT;

export function framePadding(level: number): FramePadding {
    const side = BASE_PADDING + level * NEST_STEP;
    return { top: side, side, bottom: side };
}

// 枠の外の隣のノードとの間に空ける幅。上側は、枠の上の辺の上に置くラベルの行が入るだけ、枠の余白より広い
export function frameClearance(level: number): FramePadding {
    const padding = framePadding(level);
    return { ...padding, top: padding.top + LABEL_HEIGHT };
}

export function frameRect(bounds: Rect, level: number): Rect {
    const padding = framePadding(level);
    return {
        x: bounds.x - padding.side,
        y: bounds.y - padding.top,
        width: bounds.width + padding.side * 2,
        height: bounds.height + padding.top + padding.bottom,
    };
}

// siblingOrder は、配置上の親ごとの、子の上から下への並び
export function computeFrames(
    graph: VisibleGraph,
    model: Pick<GraphModel, 'groups' | 'groupsOf'>,
    siblingOrder: Map<number, number[]>,
): Frame[] {
    const frames: Frame[] = [];
    for (const group of model.groups.filter((candidate) => candidate.boundary)) {
        const members = graph.nodes.filter((node) => (model.groupsOf.get(node.id) ?? []).includes(group.id)).map((node) => node.id);
        const memberSet = new Set(members);
        const leader = new Map<number, number>(members.map((id) => [id, id]));
        const find = (id: number): number => {
            let root = id;
            while (leader.get(root) !== root) root = leader.get(root) ?? root;
            return root;
        };
        const union = (a: number, b: number): void => void leader.set(find(a), find(b));

        // まとまりの条件: ツリーの線で直接つながっている、または、同じ配置上の親の下で縦に隣り合っている
        for (const node of graph.nodes) {
            if (node.treeParent !== null && memberSet.has(node.id) && memberSet.has(node.treeParent)) union(node.id, node.treeParent);
        }
        for (const siblings of siblingOrder.values()) {
            siblings.forEach((id, index) => {
                const next = siblings[index + 1];
                if (next !== undefined && memberSet.has(id) && memberSet.has(next)) union(id, next);
            });
        }
        const components = new Map<number, number[]>();
        for (const id of members) components.set(find(id), [...(components.get(find(id)) ?? []), id]);
        // メンバーが 1 つだけのまとまりは、色帯で所属が分かるので枠にしない
        for (const component of components.values()) if (component.length >= 2) frames.push({ group, members: component, level: 0 });
    }

    // 入れ子の判定: 相手のメンバーをすべて含む枠が外側。メンバーが同じなら、groups で先に定義されたほうを外側にする
    const order = new Map(model.groups.map((group, index) => [group.id, index]));
    const sets = new Map(frames.map((frame) => [frame, new Set(frame.members)]));
    const contains = (outer: Frame, inner: Frame): boolean =>
        outer !== inner &&
        inner.members.every((id) => sets.get(outer)?.has(id)) &&
        (outer.members.length > inner.members.length || (order.get(outer.group.id) ?? 0) < (order.get(inner.group.id) ?? 0));
    const levels = new Map<Frame, number>();
    const levelOf = (frame: Frame): number => {
        const known = levels.get(frame);
        if (known !== undefined) return known;
        const inner = frames.filter((candidate) => contains(frame, candidate));
        const level = inner.length === 0 ? 0 : 1 + Math.max(...inner.map(levelOf));
        levels.set(frame, level);
        return level;
    };
    for (const frame of frames) frame.level = levelOf(frame);
    // 外側の枠から先に描く
    return frames.sort((a, b) => b.level - a.level);
}

// メンバーの外接矩形に余白を足した、枠の矩形。矩形のあるメンバーが 1 つもなければ null
export function frameOutline(frame: Frame, rects: Map<number, Rect>): Rect | null {
    const inside = frame.members.flatMap((id) => rects.get(id) ?? []);
    return inside.length === 0 ? null : frameRect(boundsOf(inside), frame.level);
}

// 枠の矩形に重なっている、メンバーでないノードの数。配置をやり直しても入り込みが残っているかを確かめるのに使う
export function countIntruders(frames: Frame[], rects: Map<number, Rect>): number {
    let count = 0;
    for (const frame of frames) {
        const outline = frameOutline(frame, rects);
        if (!outline) continue;
        for (const [id, rect] of rects) {
            const overlaps = rect.x < outline.x + outline.width && rect.x + rect.width > outline.x && rect.y < outline.y + outline.height && rect.y + rect.height > outline.y;
            if (overlaps && rect.width > 0 && rect.height > 0 && !frame.members.includes(id)) count++;
        }
    }
    return count;
}

// 兄弟方向に隣り合う 2 ノード (upper が上、lower が下) の間に足す間隔。片方だけを囲む枠が、2 つの間に収まるだけ空ける。
// 上のノードを囲む枠は下へ、下のノードを囲む枠は上へ (ラベルの行も含めて) 張り出す。張り出しの大きさは、
// rects (前回の配置の結果) があればそこから求める。なければ、枠の余白のぶんだけを見込む。
// 相手のノードが枠の横の範囲の外にあるときは、縦にどこへ置いても枠の矩形には入らないので、その枠のぶんは空けない。
// 空けると、枠の右にある収束先 (外側の枠の下の端まで離そうとする) などで、図が縦に大きく広がってしまう
export function frameSpacing(frames: Frame[], rects?: Map<number, Rect>): (upper: number, lower: number) => number {
    const framesOf = new Map<number, Frame[]>();
    for (const frame of frames) for (const id of frame.members) framesOf.set(id, [...(framesOf.get(id) ?? []), frame]);
    const outlines = new Map(frames.map((frame) => [frame, rects ? frameOutline(frame, rects) : null]));

    // 枠 frame が、その中の inside から、枠の外の outside の側へ張り出している幅
    const overhang = (frame: Frame, inside: number, outside: number, side: 'top' | 'bottom'): number => {
        const [outline, rect, other] = [outlines.get(frame), rects?.get(inside), rects?.get(outside)];
        if (!outline || !rect || !other) return frameClearance(frame.level)[side];
        if (other.x >= outline.x + outline.width || other.x + other.width <= outline.x) return 0;
        return side === 'top' ? rect.y - outline.y + LABEL_HEIGHT : outline.y + outline.height - (rect.y + rect.height);
    };
    return (upper, lower) => {
        const onlyUpper = (framesOf.get(upper) ?? []).filter((frame) => !frame.members.includes(lower));
        const onlyLower = (framesOf.get(lower) ?? []).filter((frame) => !frame.members.includes(upper));
        return (
            Math.max(0, ...onlyUpper.map((frame) => overhang(frame, upper, lower, 'bottom'))) +
            Math.max(0, ...onlyLower.map((frame) => overhang(frame, lower, upper, 'top')))
        );
    };
}

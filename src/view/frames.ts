// グループの枠の包み。枠を持つグループごとの見えているメンバーのまとまりと入れ子の深さ (computeFrames) は Rust が行い、
// view の配置では layoutDocument が配置と一緒に返す。配置を利用者の関数 (layoutOverride) に任せる経路は projectAndFrames を使う。
// ラベルは枠の外側 (上の辺のすぐ上) に、左の角にそろえて置く。入れ子の外側の枠は、内側の枠より一回り大きくする。
// 枠の矩形と余白の関数 (frameOutline など) は描画とアニメーションの毎コマで使うので、wasm を呼ばない写しを JS に残す (Rust と同じ値)。
import { boundsOf, type Rect } from '../layout/layout';
import type { LayoutInput } from '../layout/input-types';
import { visibleGraphOf, type RawVisibleGraph, type VisibleGraph } from '../layout/project';
import type { GraphModel, GroupDef } from '../model/model';
import { callJson } from '../wasm/boundary';

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

// メンバーの外接矩形に余白を足した、枠の矩形。矩形のあるメンバーが 1 つもなければ null
export function frameOutline(frame: Frame, rects: Map<number, Rect>): Rect | null {
    const inside = frame.members.flatMap((id) => rects.get(id) ?? []);
    return inside.length === 0 ? null : frameRect(boundsOf(inside), frame.level);
}

// 射影と、枠のまとまりを 1 回の呼び出しで作る (layoutOverride の経路。配置の繰り返しは行わないので、枠の余白は間隔に入らない)。
// siblingOrder は、配置上の親ごとの、子の上から下への並び
export function projectAndFrames(input: LayoutInput, model: Pick<GraphModel, 'groups' | 'groupsOf'>, siblingOrder: Map<number, number[]>): { graph: VisibleGraph; frames: Frame[] } {
    const raw = callJson<{ graph: RawVisibleGraph; frames: Frame[] }>('project_and_frames', { input, groups: model.groups, groupsOf: [...model.groupsOf], siblingOrder: [...siblingOrder] });
    return { graph: visibleGraphOf(raw.graph), frames: raw.frames };
}


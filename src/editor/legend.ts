// 凡例のパネル (線の色・グループ) に出す中身の組み立て (DOM を使わない)。
// 出す段 (線の色が上、グループが下)、線の色の段の行 (枝の起点ごとの名前と色)、グループの段の行 (名前、色、枠の有無、入っているノードの数)、
// 起点がないときに markdag.branches の書き方を案内するかを、文書のモデルとモードから決める。
// 閲覧は文書の legend.display に従い、中身のない段は出さない (出す段がなければパネルごと出さない)。GUI 編集は指定によらず両方の段を出す。
// GUI 編集で始めるときの開閉と、文書の出す指定が前の描画から変わったか (変わったときだけ開閉を初めの状態に戻す) の比べ方もここに置く。
// 行の見せ方 (ロゴ、操作ボタン、選んだ行の印) と開閉の状態の持ち主は画面の側
import type { BranchColor, GraphModel, LegendItem } from '../core';
import type { EditorMode } from './settings';

export type LegendSection = 'branches' | 'groups';

export interface LegendGroupRow {
    id: string;
    label: string;
    color: string | null;
    boundary: boolean;
    // そのグループを持つノード (配下を含む) の数。定義だけのグループは 0
    count: number;
}

export interface LegendContent {
    // 出す段 (上から順)
    sections: LegendSection[];
    // 線の色の段の行 (枝の起点の並び。段を出さないときは空)
    branches: BranchColor[];
    // グループの段の行 (文書のグループの並び。段を出さないときは空)
    groups: LegendGroupRow[];
    // 線の色の段に markdag.branches の書き方を案内するか (GUI 編集で起点がないとき)
    branchGuide: boolean;
}

// 段の上下の並び (文書の legend.display に書いた並びによらない)
const SECTION_ORDER: readonly LegendSection[] = ['branches', 'groups'];

export function legendContent(model: Pick<GraphModel, 'groups' | 'groupsOf' | 'legend'>, branches: readonly BranchColor[], mode: EditorMode): LegendContent | null {
    const counts = new Map<string, number>();
    for (const ids of model.groupsOf.values()) for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const branchRows = branches.map(({ id, label, color }) => ({ id, label, color }));
    const groupRows = model.groups.map(({ id, label, color, boundary }) => ({ id, label, color, boundary, count: counts.get(id) ?? 0 }));
    if (mode === 'edit') return { sections: [...SECTION_ORDER], branches: branchRows, groups: groupRows, branchGuide: branchRows.length === 0 };
    const filled: Record<LegendSection, boolean> = { branches: branchRows.length > 0, groups: groupRows.length > 0 };
    const sections = SECTION_ORDER.filter((section) => model.legend.includes(section) && filled[section]);
    if (sections.length === 0) return null;
    return {
        sections,
        branches: sections.includes('branches') ? branchRows : [],
        groups: sections.includes('groups') ? groupRows : [],
        branchGuide: false,
    };
}

// GUI 編集で始めるときと、出す指定が変わったときの開閉。legend.display が false (出す項目がない) なら閉じ、そうでなければ開く
export function initialLegendOpen(display: readonly LegendItem[]): boolean {
    return display.length > 0;
}

// 出す指定が同じか。出す項目で比べ、並びは見ない
export function sameLegendDisplay(a: readonly LegendItem[], b: readonly LegendItem[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((item) => right.has(item));
}

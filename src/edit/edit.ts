// 原文の書き換えの包み。GUI 編集の操作 (editSource) と読むだけの問い合わせ (inspectNode) は Rust (wasm の edit_source と
// inspect_node) が行い、ここは境界の結果を公開の形に直す: Rust は書き換えた行の差し替えの列だけを返すので、原文の行に継ぎ足す
// (書き換えない行と、境界を越えられない字 (対になっていないサロゲート) を原文のまま保つ)。
// 操作の失敗 (断る、変えない) は戻り値の status で返す。入力の形が読めないときは MarkdagError を投げる。
// wasm を init する前に呼ぶと WasmNotReadyError を投げる。
import type { RelationKind } from '../layout/input-types';
import { callJson } from '../wasm/boundary';

// 書き換えが指すノード。id と refText は描いている解析の結果 (view.getDocument()) のもの。
// 原文を解析し直して、同じ id のノードがないか refText が違えば stale-node で断る
export interface NodeTarget {
    id: number;
    refText: string;
}

// 選んだ線。kind が tree の線は木の親子 (source が親)
export interface EdgeTarget {
    kind: 'tree' | RelationKind;
    source: number;
    target: number;
}

export type EditOp =
    | { kind: 'addChild'; parent: NodeTarget; label: string }
    | { kind: 'addSibling'; node: NodeTarget; label: string }
    | { kind: 'addSiblingBefore'; node: NodeTarget; label: string }
    | { kind: 'renameNode'; node: NodeTarget; label: string }
    | { kind: 'deleteNodes'; nodes: NodeTarget[] }
    | { kind: 'moveNode'; node: NodeTarget; parent: NodeTarget }
    | { kind: 'setDetails'; node: NodeTarget; text: string }
    | { kind: 'setTag'; nodes: NodeTarget[]; key: string; value: string | null; replaceKey: string | null }
    | { kind: 'removeTag'; nodes: NodeTarget[]; key: string }
    | { kind: 'toggleTag'; nodes: NodeTarget[]; key: string; value: string | null }
    | { kind: 'addToGroup'; group: string; nodes: NodeTarget[] }
    | { kind: 'addRelation'; from: NodeTarget; to: NodeTarget }
    | { kind: 'joinInto'; sources: NodeTarget[]; target: NodeTarget }
    | { kind: 'joinIntoNew'; sources: NodeTarget[]; label: string }
    | { kind: 'groupNodes'; nodes: NodeTarget[] }
    | { kind: 'defineGroup' }
    | { kind: 'renameGroup'; group: string; label: string }
    | { kind: 'setGroupColor'; group: string; color: string }
    | { kind: 'setGroupBoundary'; group: string; boundary: boolean }
    | { kind: 'ungroup'; group: string };

// 書き換えたあとに選ぶもの。ノードは書き換えたあとの原文を解析し直した id と refText
export type EditSelection = { kind: 'none' } | { kind: 'nodes'; nodes: NodeTarget[] } | { kind: 'edge'; edge: EdgeTarget } | { kind: 'group'; id: string };

// 書き換えたあとに、すぐ名前の入力を開く相手
export type EditRename = { kind: 'node'; node: NodeTarget } | { kind: 'group'; id: string } | null;

export type EditNoteCode = 'relations-removed' | 'refs-rewritten' | 'sources-cycle' | 'sources-existing' | 'id-added' | 'markdag-added' | 'frontmatter-added' | 'bom-removed';

// 書き換えに添える知らせ。message は日本語の 1 文
export interface EditNote {
    code: EditNoteCode;
    count: number;
    message: string;
}

export type EditReasonCode =
    | 'stale-node'
    | 'no-source-line'
    | 'block-node'
    | 'marker-line'
    | 'root'
    | 'heading-details'
    | 'empty-name'
    | 'move-into-self'
    | 'structure-changed'
    | 'same-node'
    | 'edge-exists'
    | 'cycle'
    | 'ambiguous-reference'
    | 'too-few-sources'
    | 'all-sources-skipped'
    | 'tag-key-invalid'
    | 'group-unknown'
    | 'group-label-empty'
    | 'color-invalid'
    | 'flow-style'
    | 'block-scalar'
    | 'frontmatter-invalid'
    | 'frontmatter-not-map'
    // 変えない (unchanged) ときの理由
    | 'same-name'
    | 'already-child'
    | 'nothing-to-change';

// 断るか変えない理由。message は日本語の 1 文。path は frontmatter の道すじ (本文の書き換えでは null)
export interface EditReason {
    code: EditReasonCode;
    message: string;
    path: string | null;
}

// editSource の戻り値。edited の source は書き換えたあとの原文の全体
export type EditOutcome =
    | { status: 'edited'; source: string; select: EditSelection; rename: EditRename; notes: EditNote[] }
    | { status: 'unchanged'; reason: EditReason | null }
    | { status: 'refused'; reason: EditReason };

export interface InspectNodeResult {
    id: number;
    // root は原文の行を持たないルート、list は容器 (ul / ol)、block は表とコードと画像
    kind: 'heading' | 'item' | 'root' | 'list' | 'block';
    // 名前の入力の初めの値。1 行目の本文の原文 (行頭の記号、タスクの記号、末尾の印を除いた文字。Markdown の記法はそのまま) から、
    // 名前の変更で markdag が足すのと同じ所の \ を外したもの (図の名前と同じ文字。markdag が足さない所の \ は残す)。
    // このまま renameNode に渡すと原文は変わらない。markdag キーのない文書では末尾の印も含む。名前を変えられないノードでは空
    label: string;
    // 詳細 (項目の直下の引用) の原文。なければ null
    details: string | null;
    task: boolean;
    canRename: boolean;
    canDelete: boolean;
    canMove: boolean;
    canHaveDetails: boolean;
    // 子と兄弟を足せるか
    canAddChild: boolean;
    canAddSibling: boolean;
    // 1 行目に印 (%、#、$) を書けるか (タグ、グループ、$n の参照)
    canMark: boolean;
}

// 境界の戻り値。splices は書き換える前の原文の行の添字で、start の昇順、重ならない。lines は行末の \n を含まない
interface LineSplice {
    start: number;
    deleteCount: number;
    lines: string[];
}

type EditSourceResult =
    | { status: 'edited'; splices: LineSplice[]; select: EditSelection; rename: EditRename; notes: EditNote[] }
    | { status: 'unchanged'; reason: EditReason | null }
    | { status: 'refused'; reason: EditReason };

// 原文に操作を当てる。書き換えたら書き換えたあとの原文と選び直すもの、そうでなければ変えない理由か断る理由
export function editSource(source: string, op: EditOp): EditOutcome {
    const result = callJson<EditSourceResult>('edit_source', { source, op });
    if (result.status !== 'edited') return result;
    const { splices, select, rename, notes } = result;
    return { status: 'edited', source: spliced(source, splices), select, rename, notes };
}

// ノードの種類、名前の入力の初めの値、詳細の原文と、そのノードにできる操作。
// id のノードがないか refText が違えば null (図と原文が合っていない。古い id で別のノードのことを返さない)
export function inspectNode(source: string, node: NodeTarget): InspectNodeResult | null {
    return callJson<InspectNodeResult | null>('inspect_node', { source, node });
}

// 差し替えを原文の行に当てる。差し替えない行は原文の文字列のまま (境界で置き換わる字を戻す)
function spliced(source: string, splices: LineSplice[]): string {
    const lines = source.split('\n');
    const out: string[] = [];
    let next = 0;
    for (const splice of splices) {
        for (; next < splice.start && next < lines.length; next += 1) out.push(lines[next] as string);
        for (const line of splice.lines) out.push(line);
        next = splice.start + splice.deleteCount;
    }
    for (; next < lines.length; next += 1) out.push(lines[next] as string);
    return out.join('\n');
}

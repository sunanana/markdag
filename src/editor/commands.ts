// 名前、子、兄弟、削除、付け替え、線を引く、合流、グループ (まとめる、作る、入れる、名前、色、枠の有無、解除)、詳細、タグ (付ける、外す、付け外し) の操作の命令。
// 命令を editSource の操作に組み立てて今の原文に当て、結果を原文の持ち主に渡す。
// 書き換えのあとは、結果の選び直し (select) と名前の入力の相手 (rename) を、描き直した図の同じ id のノードの refText と比べてから使う
// (合わなければ使わずに、そのことを結果の通知に足す。フックの transformSource が行をずらす文書)。選ぶノードと名前の入力の相手は図の領域に見せる。
// ただし選び直すノード (グループにまとめたときはまとめたノード) が 2 つ以上なら、どの操作でも図を動かさない (パンも開閉もしない。holdsView)。
// 引いた線とグループを選ぶときは、描き直した文書にその線とグループがあるかを確かめる。
// 名前の入力を 1 つずつ (ノードとグループ) 持ち、どちらか 1 つだけを開く: 開く (既存のノードかグループと、足したばかりのノードかまとめたばかりのグループ)、
// 決める (入力中の Enter、修飾キーつきの Enter、Tab、Shift+Tab、外へ移ったとき、閲覧へ切り替えるとき)、
// やめる (Esc。足したばかり、まとめたばかりなら元に戻すと同じく前に戻す)。入力中のキーは、決めたあとに兄弟 (下か上) か子を足すか、
// 親か書いた順の上下の兄弟の名前の入力へ移る。入力中のキーで名前を決められなかったら、入力を開いたままにする (ノードは続けて足さず、移らない)。
// 移る先がなければ、決めずに入力を開いたままにする。
// 詳細の入力を 1 つ持ち、選んだノードの右 (入らなければ下、下にも入らなければ上) に重ねる: 開く (詳細を書けるノードだけ)、
// 保存する (保存のキーの Enter (mac は ⌘Enter、win は Ctrl+Enter) と保存のボタン、外へ移ったとき、閲覧へ切り替えるとき)、やめる (Esc とやめるのボタン)。
// 保存のボタンとキーで保存できなかったら、入力を開いたままにする。名前の入力と詳細の入力は同時に 1 つだけ開き、ほかの命令の前に決める。
// グループの名前の入力は、図の上なら枠があれば枠のラベルの上 (枠が 2 つ以上なら、持ち主が覚えている押した枠。なければ最初の枠。
// 2 つ以上のノードをまとめたばかりなら、図を動かさずに見えている枠)、なければメンバーの全体の上に重ね (置き分けは図の側の重ねる口)、
// 凡例のパネルから開いたときとメンバーのいないグループは、凡例のパネルのそのグループの行の中に置く。
// タグのパネル (タグ追加かタグ選択) を 1 つ持ち、選んだノード (全体) の右 (入らなければ下) に重ねる: 開く (名前の入力と詳細の入力を決めてから。
// ノードが 1 つで印を書けなければ開かずに理由を知らせる)、中身を今の文書と選択に合わせる、閉じる。パネルの操作は選んだノードの全部に 1 回の書き換えで当て
// (付いているタグの編集はそのタグを持つノードに当てる)、書き換えのあとも選んだノードと並びはそのまま、パネルは開いたままにする。
// 2 つ以上を選んでいるときは、パネルを開くときもタグの操作のあとも図を動かさない (1 つなら選んだノードを見える所へ動かす。holdsView)。
// 付けたタグ (タグ追加、更新、タグ選択で付けた) を最近使ったタグとして覚える (この部品がある間だけ)。
// タグ選択で開いてから出した登録されているタグは、付け外しでどのノードにも残らなくなっても、開いている間は行を出し続ける。
// 開くか、足すか、閉じるかの判断と、図とのやりとり (重ねる位置、選択、通知、フォーカス) は持ち主 (CommandHost) を通す
import {
    editSource,
    inspectNode,
    type EditOp,
    type EditSelection,
    type InspectNodeResult,
    type MarkdagView,
    type NodeTarget,
    type OutlineNode,
    type OverlayPlacement,
    type Rect,
} from '../core';
import type { KeyPlatform } from './keys';
import { outlineTarget, type OutlineStep } from './navigation';
import { drawnParts, keepDrawn, nodesSelection, sameSelection, selectedNodes, targetOf, type DrawnParts, type EditorSelection } from './selection';
import type { ApplyStatus, EditAttempt, EditedOutcome, EditorSource } from './source';
import { attachedTags, hasTag, mergeTags, registeredTags, rememberTag, tagChoiceOf, tagState, tagText, type TagChoice } from './tags';
import { DetailsEditor, type DetailsEditorAction } from './ui/details-editor';
import type { HintInput } from './ui/hint';
import { NameInput, type NameInputAction, type NameInputFor } from './ui/name-input';
import type { NoticeKind } from './ui/snackbar';
import { TagPanel, type TagPanelContent, type TagPanelKind, type TagRow } from './ui/tag-panel';

// 足したノードの仮の名前 (足したあとすぐ、全部を選んだ名前の入力を開く)
export const NEW_NODE_LABEL = '新しいノード';

// 新しい合流先の仮の名前 (合流したあとすぐ、全部を選んだ名前の入力を開く)
export const JOIN_NODE_LABEL = '合流点';

// 選んだノードに足すもの。sibling は兄弟を下 (あと) に、sibling-before は上 (前) に足す。ルートの兄弟は子として足す
type AddKind = 'child' | 'sibling' | 'sibling-before';

// 名前を決めるきっかけ。key は入力中のキー (Enter、修飾キーつきの Enter、Tab、Shift+Tab。決められなければ入力を開いたまま)。
// leave はフォーカスが入力の外へ移ったか、入力の外を押したとき。switch は閲覧へ切り替えるとき (どちらも決められなくても閉じる)
type CommitCause = 'key' | 'leave' | 'switch';

// 詳細を保存するきっかけ。save は保存のキーの Enter と保存のボタン (保存できなければ入力を開いたまま)。
// leave と switch は名前と同じ (保存できなくても閉じる)
type DetailsCommitCause = 'save' | 'leave' | 'switch';

interface CommandHost {
    readonly view: MarkdagView;
    readonly source: EditorSource;
    // 名前の入力と詳細の入力の Enter の修飾キーの割り当ての区分 (GUI 編集を開くときに 1 回見分けたもの)
    readonly keyPlatform: KeyPlatform;
    // GUI 編集か (閲覧では選び直さず、名前の入力も開かない)
    editing(): boolean;
    selection(): EditorSelection;
    // 選び直す (描き直しで図が外した印も付け直す)
    select(next: EditorSelection): void;
    // そのグループを選んだときに押した枠 (描いた順の番号)。覚えていなければ null
    pressedFrame(id: string): number | null;
    notice(message: string, kind: NoticeKind): void;
    focusContainer(): void;
    // 名前の入力か詳細の入力かタグのパネルが開いたか閉じた
    onInputChange(): void;
    // 名前の入力か詳細の入力をやめた。入力の Esc は図に伝えないことがあるので、同時に開いているカラーピッカーと詳細表示の選択肢はここで閉じる
    onInputCancel(): void;
    // 印のクリックで出したままにした吹き出しがあるか。あれば入力とパネルの Esc を図へ伝えない (その吹き出しを閉じない)。
    // ホバーで出た吹き出しは、今までどおり入力の Esc で一緒に閉じる
    popoverPinned(): boolean;
    // 凡例のパネルのグループの行の中に要素 (グループの名前の入力) を置く。置けなければ null。戻り値で外す
    attachToLegend(id: string, element: HTMLElement): (() => void) | null;
    // 図の領域の画面の矩形
    area(): DOMRect;
}

// グループの名前の入力を開く所。diagram は図の上、legend は凡例のパネルの行の中
type GroupNamePlace = 'diagram' | 'legend';

// 開いている名前の入力。fresh は足したばかりのノードか、まとめたばかりのグループ。detach は図に重ねた入力欄を外す
type Naming = { kind: 'node'; target: NodeTarget; fresh: boolean; detach: () => void } | { kind: 'group'; id: string; fresh: boolean; detach: () => void };

// 開いている詳細の入力。detach は図に重ねた入れ物を外す
interface DetailsEditing {
    target: NodeTarget;
    detach: () => void;
}

// 開いているタグのパネル。detach は図に重ねたパネルを外す。shown はタグ選択で開いてから出した登録されているタグ
interface Tagging {
    kind: TagPanelKind;
    detach: () => void;
    shown: TagChoice[];
}

// 書き換えた結果の文に添えるもの。groupLabel はグループの操作の文に出す名前、tagAdded はタグ選択の付け外しで付けたか
interface NoticeContext {
    groupLabel?: string;
    tagAdded?: boolean;
}

// 名前を決めた結果。決めたら、決めたあとのノード (図と合わなければ null)
type Committed = { done: false } | { done: true; node: NodeTarget | null };

const MISMATCH_SELECT = '図と原文が合っていないので、書き換えたあとのノードや線を選べません (名前の入力も開きません)';
const MISMATCH_RENAME = '図と原文が合っておらず、このノードが原文に見つからないので、名前を変えられません (描き直してからやり直してください)';
const MISSING_GROUP = '図と原文が合っておらず、このグループが原文に見つからないので、名前を変えられません (描き直してからやり直してください)';

const CANNOT_RENAME: Record<InspectNodeResult['kind'], string> = {
    root: 'このノードは原文に名前の行を持たないので、名前を変えられません',
    list: 'このノードはリストの入れ物で、原文に名前の行を持たないので、名前を変えられません',
    block: '表、コード、画像のノードは名前を変えられません',
    heading: 'このノードは名前を変えられません',
    item: 'このノードは名前を変えられません',
};

const MISMATCH_DETAILS = '図と原文が合っておらず、このノードが原文に見つからないので、詳細を書けません (描き直してからやり直してください)';

const CANNOT_DETAILS: Record<InspectNodeResult['kind'], string> = {
    heading: 'この見出しには詳細を書けません',
    root: 'このノードは原文に自分の行を持たないので、詳細を書けません',
    list: 'このノードはリストの入れ物で、原文に自分の行を持たないので、詳細を書けません',
    block: '表、コード、画像のノードには詳細を書けません',
    item: 'このノードには詳細を書けません',
};

// 詳細の入力を重ねる所 (図の領域に入る最初のもの)
const DETAILS_PLACES: OverlayPlacement[] = ['right', 'bottom', 'top'];

const MISMATCH_TAGS = '図と原文が合っておらず、このノードが原文に見つからないので、タグを付けられません (描き直してからやり直してください)';

const CANNOT_MARK: Record<InspectNodeResult['kind'], string> = {
    heading: 'この見出しにはタグを書けません',
    root: 'このノードは原文に自分の行を持たないので、タグを書けません',
    list: 'このノードはリストの入れ物で、原文に自分の行を持たないので、タグを書けません',
    block: '表、コード、画像のノードにはタグを書けません',
    item: 'このノードにはタグを書けません',
};

// タグのパネルを重ねる所 (図の領域に入る最初のもの)。2 つ以上のときは外枠の破線の外に離す
const TAG_PANEL_PLACES: OverlayPlacement[] = ['right', 'bottom'];
const TAG_PANEL_GAP = 8;
const TAG_PANEL_GAP_AROUND_BOUNDS = 12;

const TAG_OPS: ReadonlySet<EditOp['kind']> = new Set(['setTag', 'removeTag', 'toggleTag']);

// 図を動かさないか (AM-07 と細部 3 の 1 つの決まり)。相手のノード (タグのパネルを開くときは選んでいるノード、書き換えたあとは選び直すノード、
// グループにまとめたあとはまとめたノード) が 2 つ以上なら、見える所へ動かさない (ensureVisible を呼ばず、パンも開閉もしない)。1 つなら今までどおり動かす
function holdsView(count: number): boolean {
    return count >= 2;
}

// まとめたグループに入ったノードのうち、選んだもの (選んだ順)。ルートと、ほかの選んだノードの配下は書き換えの側が飛ばすので入れない
// (メンバーは親のグループを受け継ぐので、飛ばした配下もメンバーに入っている)
function groupedOf(picked: readonly NodeTarget[], members: ReadonlySet<number>, nodes: readonly Pick<OutlineNode, 'id' | 'parent'>[]): NodeTarget[] {
    const ids = new Set(picked.map((node) => node.id));
    const parents = new Map(nodes.map((node) => [node.id, node.parent]));
    const underPicked = (id: number): boolean => {
        for (let parent = parents.get(id) ?? null; parent !== null; parent = parents.get(parent) ?? null) if (ids.has(parent)) return true;
        return false;
    };
    return picked.filter((node) => members.has(node.id) && !underPicked(node.id));
}

// 矩形が図の領域 (幅 width、高さ height) に一部でも入っているか
const overlapsArea = (rect: Rect, width: number, height: number): boolean => rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < width && rect.y < height;

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// 名前の入力の操作のうち、移る操作の移る先 (移る操作でなければ null)
function outlineStepOf(action: Exclude<NameInputAction, 'stay'>): OutlineStep | null {
    return action === 'parent' || action === 'previous' || action === 'next' ? action : null;
}

// 子か兄弟 (下か上) を足す操作。ルートの兄弟は子として足す (ルートには兄弟がいない)
export function addNodeOp(kind: AddKind, node: NodeTarget, root: boolean): EditOp {
    if (kind === 'child' || root) return { kind: 'addChild', parent: node, label: NEW_NODE_LABEL };
    if (kind === 'sibling-before') return { kind: 'addSiblingBefore', node, label: NEW_NODE_LABEL };
    return { kind: 'addSibling', node, label: NEW_NODE_LABEL };
}

export function renameNodeOp(node: NodeTarget, label: string): EditOp {
    return { kind: 'renameNode', node, label };
}

export function deleteNodesOp(nodes: readonly NodeTarget[]): EditOp {
    return { kind: 'deleteNodes', nodes: nodes.map((node) => ({ id: node.id, refText: node.refText })) };
}

export function moveNodeOp(node: NodeTarget, parent: NodeTarget): EditOp {
    return { kind: 'moveNode', node, parent };
}

export function addRelationOp(from: NodeTarget, to: NodeTarget): EditOp {
    return { kind: 'addRelation', from: copyTarget(from), to: copyTarget(to) };
}

export function joinIntoOp(sources: readonly NodeTarget[], target: NodeTarget): EditOp {
    return { kind: 'joinInto', sources: sources.map(copyTarget), target: copyTarget(target) };
}

export function joinIntoNewOp(sources: readonly NodeTarget[]): EditOp {
    return { kind: 'joinIntoNew', sources: sources.map(copyTarget), label: JOIN_NODE_LABEL };
}

export function groupNodesOp(nodes: readonly NodeTarget[]): EditOp {
    return { kind: 'groupNodes', nodes: nodes.map(copyTarget) };
}

export function renameGroupOp(group: string, label: string): EditOp {
    return { kind: 'renameGroup', group, label };
}

export function ungroupOp(group: string): EditOp {
    return { kind: 'ungroup', group };
}

export function addToGroupOp(group: string, nodes: readonly NodeTarget[]): EditOp {
    return { kind: 'addToGroup', group, nodes: nodes.map(copyTarget) };
}

export function defineGroupOp(): EditOp {
    return { kind: 'defineGroup' };
}

export function setGroupColorOp(group: string, color: string): EditOp {
    return { kind: 'setGroupColor', group, color };
}

export function setGroupBoundaryOp(group: string, boundary: boolean): EditOp {
    return { kind: 'setGroupBoundary', group, boundary };
}

export function setDetailsOp(node: NodeTarget, text: string): EditOp {
    return { kind: 'setDetails', node: copyTarget(node), text };
}

export function setTagOp(nodes: readonly NodeTarget[], key: string, value: string | null, replaceKey: string | null): EditOp {
    return { kind: 'setTag', nodes: nodes.map(copyTarget), key, value, replaceKey };
}

export function removeTagOp(nodes: readonly NodeTarget[], key: string): EditOp {
    return { kind: 'removeTag', nodes: nodes.map(copyTarget), key };
}

export function toggleTagOp(nodes: readonly NodeTarget[], tag: TagChoice): EditOp {
    return { kind: 'toggleTag', nodes: nodes.map(copyTarget), key: tag.key, value: tag.value };
}

function copyTarget(node: NodeTarget): NodeTarget {
    return { id: node.id, refText: node.refText };
}

// result が order と同じノードを選ぶなら、order の並びで result の refText のものにする (違うノードなら result のまま)
function inOrderOf(order: EditorSelection, result: EditSelection): EditorSelection {
    const before = selectedNodes(order);
    const after = selectedNodes(result);
    if (before.length === 0 || before.length !== after.length) return result;
    const byId = new Map(after.map((node) => [node.id, node]));
    const nodes = before.flatMap((node) => byId.get(node.id) ?? []);
    return nodes.length === after.length ? nodesSelection(nodes) : result;
}

// 付け替えのドラッグで、移す先の枠を出す相手か。動かすノード自身、その配下、もとの親 (すでにその子) には出さない
// (離したときの結果は書き換えの操作が決める: 配下は理由を知らせ、もとの親は何もしない)
export function isDropCandidate(nodes: readonly Pick<OutlineNode, 'id' | 'parent'>[], source: number, target: number): boolean {
    const parents = new Map(nodes.map((node) => [node.id, node.parent]));
    if (!parents.has(source) || !parents.has(target) || parents.get(source) === target) return false;
    for (let id: number | null | undefined = target; id !== null && id !== undefined; id = parents.get(id)) if (id === source) return false;
    return true;
}

// 今の原文に操作を当てる。editSource が投げたら (入力の形が読めない、wasm の誤り) failed にする
export function attemptEdit(source: string, op: EditOp): EditAttempt {
    try {
        return editSource(source, op);
    } catch (error) {
        return { status: 'failed', message: `書き換えに失敗しました (${error instanceof Error ? error.message : String(error)})` };
    }
}

// 通知の文の中のノードの呼び方 (名前が空なら「ノード」)
function nameOf(node: NodeTarget): string {
    return node.refText === '' ? 'ノード' : `「${node.refText}」`;
}

// 通知の文の中のグループの呼び方 (名前が分からなければ「グループ」だけ)
function groupNameOf(label: string): string {
    return label === '' ? 'グループ' : `グループ「${label}」`;
}

// 通知の文の中のタグを付けたノードの呼び方 (1 つなら名前、2 つ以上なら数)
function nodesNameOf(nodes: readonly NodeTarget[]): string {
    const [only] = nodes;
    return nodes.length === 1 && only !== undefined ? nameOf(only) : `選んだ ${nodes.length} 個のノード`;
}

// 通知の文の中のタグ (本文に書く形)
function tagNameOf(key: string, value: string | null): string {
    return tagText(tagChoiceOf(key, value));
}

// 書き換えた操作の結果の文 (1 行。書き換えに添えた知らせ (削除で直した relations の項目ごとの文など) を続ける)。
// context.groupLabel はグループの操作で文に出す名前 (まとめる、作る、名前の変更は書き換えたあとの名前、ほかは書き換える前の名前)
export function editedNotice(op: EditOp, edited: EditedOutcome, extra: readonly string[] = [], context: NoticeContext = {}): string {
    const groupLabel = context.groupLabel ?? '';
    let head: string;
    if (op.kind === 'addChild') head = '子を足しました';
    else if (op.kind === 'addSibling' || op.kind === 'addSiblingBefore') head = '兄弟を足しました';
    else if (op.kind === 'renameNode') {
        // 名前を空にする変更は書き換えの側が断る。書いた名前の refText が空に読まれたときは名前を出さない
        const name = selectedNodes(edited.select)[0]?.refText ?? op.label.trim();
        head = name === '' ? '名前を変えました' : `名前を「${name}」にしました`;
    } else if (op.kind === 'deleteNodes') {
        const [only] = op.nodes;
        head = op.nodes.length === 1 && only !== undefined ? `${nameOf(only)}を消しました` : `選んだ ${op.nodes.length} 個のノードを消しました`;
    } else if (op.kind === 'moveNode') head = `${nameOf(op.node)}を${nameOf(op.parent)}の下へ移しました`;
    else if (op.kind === 'addRelation') head = `${nameOf(op.from)}から${nameOf(op.to)}へ線を引きました`;
    else if (op.kind === 'joinInto') {
        // 外した始点の数は書き換えの知らせ (sources-cycle と sources-existing) の数
        const skipped = edited.notes.reduce((sum, note) => (note.code === 'sources-cycle' || note.code === 'sources-existing' ? sum + note.count : sum), 0);
        head = `${op.sources.length - skipped} 個のノードを${nameOf(op.target)}へ合流させました`;
    } else if (op.kind === 'joinIntoNew') head = `選んだ ${op.sources.length} 個のノードを新しいノード「${op.label}」へ合流させました`;
    else if (op.kind === 'groupNodes') head = `選んだノードを${groupNameOf(groupLabel)}にまとめました`;
    else if (op.kind === 'renameGroup') head = `グループの名前を「${groupLabel === '' ? op.label.trim() : groupLabel}」にしました`;
    else if (op.kind === 'ungroup') head = `${groupNameOf(groupLabel)}を解除しました`;
    else if (op.kind === 'addToGroup') head = `選んだノードを${groupNameOf(groupLabel)}に入れました`;
    else if (op.kind === 'defineGroup') head = `${groupNameOf(groupLabel)}を作りました`;
    else if (op.kind === 'setGroupColor') head = `${groupNameOf(groupLabel)}の色を ${op.color} にしました`;
    else if (op.kind === 'setGroupBoundary') head = `${groupNameOf(groupLabel)}の枠を${op.boundary ? '出しました' : '隠しました'}`;
    else if (op.kind === 'setDetails') head = `${nameOf(op.node)}の詳細を${op.text.trim() === '' ? '外しました' : '書きました'}`;
    else if (op.kind === 'setTag') {
        const replaced = op.replaceKey === null ? null : tagChoiceOf(op.replaceKey, null).key;
        const tag = tagNameOf(op.key, op.value);
        head = replaced !== null && replaced !== tagChoiceOf(op.key, null).key ? `${nodesNameOf(op.nodes)}の #${replaced} を ${tag} に改めました` : `${nodesNameOf(op.nodes)}に ${tag} を付けました`;
    } else if (op.kind === 'removeTag') head = `${nodesNameOf(op.nodes)}から #${tagChoiceOf(op.key, null).key} を外しました`;
    else if (op.kind === 'toggleTag') {
        const tag = tagNameOf(op.key, op.value);
        head = context.tagAdded === false ? `${nodesNameOf(op.nodes)}から ${tag} を外しました` : `${nodesNameOf(op.nodes)}に ${tag} を付けました`;
    } else head = '原文を書き換えました';
    return [head, ...extra, ...edited.notes.map((note) => note.message)].join('。');
}

export class EditCommands {
    private readonly inputs: Record<NameInputFor, NameInput>;
    private naming: Naming | null = null;
    private readonly detailsEditor: DetailsEditor;
    private details: DetailsEditing | null = null;
    private readonly tagPanel: TagPanel;
    private tagging: Tagging | null = null;
    // 最近使ったタグ (新しい順)
    private recentTags: TagChoice[] = [];
    // 書き換えを当てている間 (図の描き直しのあいだに入力欄のフォーカスが動いても、外へ移ったことにしない)
    private applying = false;

    constructor(private readonly host: CommandHost) {
        const create = (kind: NameInputFor): NameInput =>
            new NameInput(
                kind,
                {
                    onAction: (action) => this.act(action),
                    onLeave: () => {
                        if (!this.applying) this.commit('leave');
                    },
                    holdsEscape: () => this.host.popoverPinned(),
                },
                this.host.keyPlatform,
            );
        this.inputs = { node: create('node'), group: create('group') };
        this.detailsEditor = new DetailsEditor(
            {
                onAction: (action) => this.actDetails(action),
                onLeave: () => {
                    if (!this.applying) this.commitDetails('leave');
                },
                holdsEscape: () => this.host.popoverPinned(),
            },
            this.host.keyPlatform,
        );
        this.tagPanel = new TagPanel({
            onSubmit: (key, value, editing) => this.submitTag(key, value, editing),
            onRemove: (tag) => this.removeTag(tag),
            onToggle: (row) => this.toggleTag(row),
            onClose: () => this.closeTags(true),
            holdsEscape: () => this.host.popoverPinned(),
        });
    }

    get isNaming(): boolean {
        return this.naming !== null;
    }

    // 開いている名前の入力の相手の種類 (開いていなければ null)
    get namingKind(): NameInputFor | null {
        return this.naming?.kind ?? null;
    }

    // 名前の入力か詳細の入力が開いているか (開いている間は、入力がフォーカスを持つ)
    get isInputOpen(): boolean {
        return this.naming !== null || this.details !== null;
    }

    // 開いている入力 (名前の入力の相手の種類、詳細の入力か、タグのパネル。開いていなければ null)
    get inputKind(): HintInput | null {
        if (this.details !== null) return 'details';
        if (this.naming !== null) return this.naming.kind;
        return this.tagging === null ? null : this.tagging.kind === 'add' ? 'tag-add' : 'tag-select';
    }

    // 開いているタグのパネルの種類 (開いていなければ null)
    get tagPanelKind(): TagPanelKind | null {
        return this.tagging?.kind ?? null;
    }

    // タグのパネルの中の要素か
    tagPanelContains(target: EventTarget | null): boolean {
        return this.tagPanel.contains(target);
    }

    // 名前の入力か詳細の入力の中の要素か
    contains(target: EventTarget | null): boolean {
        return target instanceof Node && (this.inputs.node.element.contains(target) || this.inputs.group.element.contains(target) || this.detailsEditor.element.contains(target));
    }

    // 既存のノードの名前の入力を開く。名前を変えられないノードと、図と原文が合っていないノードでは開かずに理由を知らせる
    rename(node: NodeTarget): void {
        if (!this.leaveInputs()) return;
        this.openName(node, false);
    }

    // 子か兄弟 (下か上) を足し、足したノードの名前の入力を開く
    add(kind: AddKind, node: NodeTarget): void {
        if (!this.leaveInputs()) return;
        if (!this.isDrawn(node)) return;
        this.addTo(kind, node);
    }

    // node から step の先 (親か、書いた順で 1 つ上か下の兄弟) を選び、その名前の入力を開く。移る先がなければ何もしない。
    // 親へ移るときは、名前を持たないリストの入れ物 (ルートでないもの) を飛ばして、その上のノードへ移る (行を持たないルートは名前が title なので移る)。
    // 名前を変えられないノードでは、選んで見える所へ動かし、開かずに理由を知らせる (名前の入力と同じ)
    renameToward(step: OutlineStep, node: NodeTarget): void {
        if (!this.leaveInputs()) return;
        const target = this.stepTarget(step, node.id);
        if (target === null || !this.host.editing()) return;
        this.host.select(nodesSelection([target]));
        // 選び直しの知らせ (onSelectionChange) の中でアプリが片付けたら、見せるのも名前の入力もやめる
        if (!this.host.editing()) return;
        this.host.view.ensureVisible(target.id);
        this.openName(target, false);
    }

    // ノードを配下ごと 1 回の書き換えで消す (配下に含まれるノードは上のノードと一緒に消える)。
    // 選び直すのは最初に消したノード (文書の順) の親。ルートを含む削除は断られて理由が出る
    deleteNodes(nodes: readonly NodeTarget[]): void {
        if (!this.leaveInputs()) return;
        if (nodes.length === 0) return;
        this.run(deleteNodesOp(nodes));
    }

    // ノードを配下ごと、移す先の最後の子へ付け替え、動かしたノードを選ぶ。断られたら理由が出て、すでにその親の子なら何もしない
    moveNode(node: NodeTarget, parent: NodeTarget): void {
        if (!this.leaveInputs()) return;
        this.run(moveNodeOp(node, parent));
    }

    // from から to へ線を引き (markdag.relations の depends)、引いた線を選ぶ。同じノードへの線ともうある線は断られて理由が出る
    addRelation(from: NodeTarget, to: NodeTarget): void {
        if (!this.leaveInputs()) return;
        this.run(addRelationOp(from, to));
    }

    // 始点から既存のノードへ合流させ (合流先へもう線がある始点と、線を引くと閉路になる始点は外す)、合流先を選ぶ。
    // 始点が全部外れたら断られて理由が出る
    joinInto(sources: readonly NodeTarget[], target: NodeTarget): void {
        if (!this.leaveInputs()) return;
        this.run(joinIntoOp(sources, target));
    }

    // 始点から新しいノード (仮の名前) へ合流させ、新しいノードを選んでその名前の入力を開く
    joinIntoNew(sources: readonly NodeTarget[]): void {
        if (!this.leaveInputs()) return;
        this.run(joinIntoNewOp(sources));
    }

    // 選んだノードを 1 つのグループにまとめ (新しいグループの名前と定義を足す)、グループを選んでその名前の入力を開く。
    // ルートと、選んだノードの配下のノードは書き換えの側が飛ばす。印を書けないノードを含むと断られて理由が出る
    groupNodes(nodes: readonly NodeTarget[]): void {
        if (!this.leaveInputs()) return;
        if (nodes.length === 0) return;
        this.run(groupNodesOp(nodes));
    }

    // 既存のグループの名前の入力を、図の上か凡例のパネルの行の中に開く。図と原文が合っていないグループでは開かずに理由を知らせる
    renameGroup(id: string, place: GroupNamePlace = 'diagram'): void {
        if (!this.leaveInputs()) return;
        this.openGroupName(id, false, place);
    }

    // メンバーのいないグループ (定義だけ) を作り、グループを選んで、凡例のパネルの行の中に名前の入力を開く
    defineGroup(): void {
        if (!this.leaveInputs()) return;
        this.run(defineGroupOp());
    }

    // 選んだノードを既存のグループに入れる (もう入っているノード、選んだノードの配下、ルートは書き換えの側が飛ばす)。ノードは選んだまま。
    // 入れるノードがなければ (もう入っているなど) 書き換えずにその理由を知らせる
    addToGroup(id: string, nodes: readonly NodeTarget[]): void {
        if (!this.leaveInputs()) return;
        if (nodes.length === 0) return;
        this.run(addToGroupOp(id, nodes), this.groupLabel(id), true);
    }

    // グループの色を書き換え (定義がなければ足す)、グループを選ぶ。今と同じ色なら何もしない。色の書き方の誤りは断られて理由が出る
    setGroupColor(id: string, color: string): void {
        if (!this.leaveInputs()) return;
        this.run(setGroupColorOp(id, color), this.groupLabel(id));
    }

    // グループの枠の有無を書き換え (定義がなければ足す)、グループを選ぶ
    setGroupBoundary(id: string, boundary: boolean): void {
        if (!this.leaveInputs()) return;
        this.run(setGroupBoundaryOp(id, boundary), this.groupLabel(id));
    }

    // グループを解く (ノードの印と定義を外し、ノードは残す)。選択は解ける
    ungroup(id: string): void {
        if (!this.leaveInputs()) return;
        this.run(ungroupOp(id), this.groupLabel(id));
    }

    // 選んだノードの詳細の入力を、ノードの右 (入らなければ下、下にも入らなければ上) に開く。名前の入力が開いていれば名前を決めてから開く。
    // 詳細を書けないノードと、図と原文が合っていないノードでは開かずに理由を知らせる
    openDetails(node: NodeTarget): void {
        let target = node;
        if (this.naming !== null) {
            const committed = this.commit('leave');
            if (!committed.done) return;
            // 名前を変えたノードそのものなら、変えたあとの名前で指す
            if (committed.node !== null && committed.node.id === target.id) target = committed.node;
        }
        if (this.details !== null && !this.commitDetails('leave')) return;
        let facts: InspectNodeResult | null;
        try {
            facts = inspectNode(this.host.source.source, target);
        } catch {
            facts = null;
        }
        if (facts === null) {
            this.host.notice(MISMATCH_DETAILS, 'error');
            return;
        }
        if (!facts.canHaveDetails) {
            this.host.notice(CANNOT_DETAILS[facts.kind], 'error');
            return;
        }
        this.host.view.ensureVisible(target.id);
        const detach = this.host.view.attachOverlay(this.detailsEditor.element, { target: { node: target.id }, place: DETAILS_PLACES });
        this.details = { target, detach };
        this.detailsEditor.open(facts.details ?? '');
        this.host.onInputChange();
    }

    // 開いている名前の入力を、入れた名前で決めて閉じる。決められなかったら (断られた、取りやめられた) 理由を知らせて false
    commitName(cause: Exclude<CommitCause, 'key'>): boolean {
        return this.commit(cause).done;
    }

    // 開いている詳細の入力を、入れた詳細で保存して閉じる (保存のボタンとキーで保存できなければ開いたまま)。
    // 保存できなかったら (断られた、取りやめられた) 理由を知らせて false。保存のボタンとキーのあとはフォーカスを図の要素へ戻す
    commitDetails(cause: DetailsCommitCause): boolean {
        const editing = this.details;
        if (editing === null) return true;
        const op = setDetailsOp(editing.target, this.detailsEditor.value);
        this.applying = true;
        let status: ApplyStatus;
        try {
            status = this.host.source.apply(attemptEdit(this.host.source.source, op), (edited) => {
                this.settle(op, edited);
            });
        } finally {
            this.applying = false;
        }
        const saved = status === 'edited' || status === 'unchanged';
        if (!saved && cause === 'save' && this.details === editing) {
            // 入れた詳細のまま開いておく (やめるか、直して保存し直す)
            this.detailsEditor.refocus();
            return false;
        }
        this.closeDetails(cause === 'save');
        return saved;
    }

    // 開いている入力 (名前か詳細) を、入れたもので決めて閉じる。決められなかったら false
    commitInput(cause: Exclude<CommitCause, 'key'>): boolean {
        if (this.naming !== null) return this.commit(cause).done;
        return this.commitDetails(cause);
    }

    // 開いている入力 (名前か詳細) を保存せずに閉じる
    closeInput(): void {
        this.closeName();
        this.closeDetails();
    }

    // 名前の入力を保存せずに閉じる。入力欄がフォーカスを持っていたら図の要素へ戻す (キーの操作を続けられるように)
    closeName(): void {
        const naming = this.naming;
        if (naming === null) return;
        const input = this.inputs[naming.kind];
        const hadFocus = input.focused;
        this.naming = null;
        input.close();
        naming.detach();
        if (hadFocus) this.host.focusContainer();
        this.host.onInputChange();
    }

    // 詳細の入力を保存せずに閉じる。入れ物の中にフォーカスがあったか toContainer なら、図の要素へフォーカスを戻す
    closeDetails(toContainer = false): void {
        const editing = this.details;
        if (editing === null) return;
        const hadFocus = this.detailsEditor.focused;
        this.details = null;
        this.detailsEditor.close();
        editing.detach();
        if (hadFocus || toContainer) this.host.focusContainer();
        this.host.onInputChange();
    }

    // 片付け。入力を保存せずに閉じ、タグのパネルも閉じる (フォーカスは動かさない)
    destroy(): void {
        const naming = this.naming;
        const editing = this.details;
        const tagging = this.tagging;
        this.naming = null;
        this.details = null;
        this.tagging = null;
        this.inputs.node.close();
        this.inputs.group.close();
        this.detailsEditor.close();
        this.tagPanel.close();
        naming?.detach();
        editing?.detach();
        tagging?.detach();
    }

    // 選んだノードのタグのパネルを開く (開いていれば開き直す)。名前の入力と詳細の入力は先に決めて閉じ、決められなければ開かない。
    // ノードを選んでいなければ開かない。ノードが 1 つで印を書けないか、図と原文が合っていなければ、開かずに理由を知らせる。
    // ノードが 1 つなら見える所へ動かしてから開き、2 つ以上なら図を動かさない (見えていないノードがあってもパンも開閉もしない)。
    // edit を渡すと、タグ追加をそのタグの編集で開く
    openTags(kind: TagPanelKind, edit: TagChoice | null = null): boolean {
        if (!this.leaveInputs()) return false;
        const nodes = selectedNodes(this.host.selection());
        const [only] = nodes;
        if (only === undefined || !this.host.editing()) return false;
        if (nodes.length === 1) {
            let facts: InspectNodeResult | null;
            try {
                facts = inspectNode(this.host.source.source, only);
            } catch {
                facts = null;
            }
            if (facts === null || !facts.canMark) {
                this.host.notice(facts === null ? MISMATCH_TAGS : CANNOT_MARK[facts.kind], 'error');
                return false;
            }
        }
        this.tagging?.detach();
        if (!holdsView(nodes.length)) this.host.view.ensureVisible(only.id);
        const ids = nodes.map((node) => node.id);
        const detach = this.host.view.attachOverlay(this.tagPanel.element, {
            target: nodes.length === 1 ? { node: only.id } : { nodes: ids },
            place: TAG_PANEL_PLACES,
            gap: nodes.length === 1 ? TAG_PANEL_GAP : TAG_PANEL_GAP_AROUND_BOUNDS,
        });
        const tagging: Tagging = { kind, detach, shown: [] };
        this.tagging = tagging;
        this.tagPanel.open(kind, this.tagContent(tagging, ids), edit);
        this.host.onInputChange();
        return true;
    }

    // 選んでいるノード 1 つの、付いているタグ (キー) の編集を開く (値が 2 つ以上なら最初の値)。
    // 同じタグの編集をもう開いていれば、そのまま (入れかけのものを残す)
    editTag(node: NodeTarget, key: string): void {
        const tag = this.host.view.getDocument()?.model.tagsOf.get(node.id)?.find((item) => item.key === key);
        if (!tag) return;
        const editing = this.tagPanel.editing;
        const nodes = selectedNodes(this.host.selection());
        if (this.tagging?.kind === 'add' && editing?.key === key && nodes.length === 1 && nodes[0]?.id === node.id) {
            this.tagPanel.refocus();
            return;
        }
        this.openTags('add', { key, value: tag.values[0] ?? null });
    }

    // タグのパネルを閉じる。パネルの中にフォーカスがあったか toContainer なら、図の要素へフォーカスを戻す
    closeTags(toContainer = false): void {
        const tagging = this.tagging;
        if (tagging === null) return;
        const hadFocus = this.tagPanel.focused;
        this.tagging = null;
        this.tagPanel.close();
        tagging.detach();
        if (hadFocus || toContainer) this.host.focusContainer();
        this.host.onInputChange();
    }

    // タグのパネルの中身を、描いている文書と今の選択に合わせる (ノードを選んでいなければ閉じる)
    refreshTags(): void {
        const tagging = this.tagging;
        if (tagging === null) return;
        const ids = selectedNodes(this.host.selection()).map((node) => node.id);
        if (ids.length === 0) {
            this.closeTags();
            return;
        }
        this.tagPanel.show(this.tagContent(tagging, ids));
    }

    // タグのパネルの欄にフォーカスを戻す
    focusTagPanel(): void {
        if (this.tagging !== null) this.tagPanel.refocus();
    }

    // ほかの命令の前に、開いている入力を外へ移ったときと同じく決める。決められなかったら false (命令はしない)
    private leaveInputs(): boolean {
        if (this.naming !== null && !this.commit('leave').done) return false;
        return this.commitDetails('leave');
    }

    // 詳細の入力の保存のキーの Enter と保存のボタンは保存し、Esc とやめるのボタンは保存せずに閉じる (選択はそのまま)。
    // どちらも閉じたらフォーカスを図の要素へ戻す
    private actDetails(action: Exclude<DetailsEditorAction, 'stay'>): void {
        if (this.details === null) return;
        if (action === 'save') this.commitDetails('save');
        else {
            this.closeDetails(true);
            this.host.onInputCancel();
        }
    }

    // ノードの名前の入力中のキーは、名前を決めてから足す (兄弟を下か上、子) か、親か書いた順の上下の兄弟の名前の入力へ移る。
    // 移る先がなければ、決めずに入力を開いたままにする。決めるだけのキー (Enter) とグループの名前の入力中の Enter は名前を決める。
    // Esc はやめる (足したばかりのノードとまとめたばかりのグループは、元に戻すと同じく前の原文と選択に戻す)
    private act(action: Exclude<NameInputAction, 'stay'>): void {
        const naming = this.naming;
        if (naming === null) return;
        if (action === 'cancel') {
            this.closeName();
            this.host.onInputCancel();
            if (naming.fresh) this.host.source.undo();
            return;
        }
        const step = outlineStepOf(action);
        if (naming.kind === 'node' && step !== null && this.stepTarget(step, naming.target.id) === null) return;
        const committed = this.commit('key');
        if (naming.kind === 'group' || action === 'commit') return;
        if (!committed.done || committed.node === null || !this.host.editing()) return;
        // 名前を変えると refText が変わるので、移る先は描き直した文書で引き直す (id は変わらない)
        if (step !== null) this.renameToward(step, committed.node);
        else if (action === 'child' || action === 'sibling' || action === 'sibling-before') this.addTo(action, committed.node);
    }

    private commit(cause: CommitCause): Committed {
        const naming = this.naming;
        if (naming === null) return { done: true, node: null };
        const input = this.inputs[naming.kind];
        const op = naming.kind === 'node' ? renameNodeOp(naming.target, input.value) : renameGroupOp(naming.id, input.value);
        const settled: { node: NodeTarget | null } = { node: null };
        this.applying = true;
        let status: ApplyStatus;
        try {
            status = this.host.source.apply(attemptEdit(this.host.source.source, op), (edited) => {
                settled.node = this.settle(op, edited);
            });
        } finally {
            this.applying = false;
        }
        if (status === 'refused' || status === 'cancelled') {
            // 入力中のキーで決められなかったときは、入れた名前のまま入力を開いておく (やめるか、直して決め直す)
            if (cause === 'key' && this.naming === naming) {
                input.refocus();
                return { done: false };
            }
            this.closeName();
            return { done: false };
        }
        this.closeName();
        if (naming.kind === 'group') return { done: true, node: null };
        // 名前が同じ (書き換えない) なら、決める前のノードのまま
        return { done: true, node: status === 'edited' ? settled.node : naming.target };
    }

    private addTo(kind: AddKind, node: NodeTarget): void {
        this.run(addNodeOp(kind, node, this.isRoot(node.id)));
    }

    // タグ追加の送り (Enter、「追加」、「更新」)。新規は選んだノードの全部に、編集はそのタグを持つノードに付ける (キーを変えたらもとのキーを外す)。
    // 付けたら最近使ったタグに覚え、付けたか変えなかったら新規の入力に戻す。断られたら入れたものを残して欄にフォーカスを戻す
    private submitTag(key: string, value: string, editing: TagChoice | null): void {
        if (this.tagging === null) return;
        const nodes = this.tagTargets(editing);
        const tag = tagChoiceOf(key, value);
        const replaceKey = editing !== null && editing.key !== tag.key ? editing.key : null;
        const status = this.runTags(setTagOp(nodes, key, value === '' ? null : value, replaceKey));
        if (status === 'edited') this.recentTags = rememberTag(this.recentTags, tag);
        if (status === 'edited' || status === 'unchanged') this.tagPanel.startNew();
        else this.tagPanel.refocus();
    }

    // 付いているタグの × 。そのキーのタグを選んだノードの全部から外す。編集していたタグなら新規の入力に戻す
    private removeTag(tag: TagChoice): void {
        if (this.tagging === null) return;
        const status = this.runTags(removeTagOp(selectedNodes(this.host.selection()), tag.key));
        if (status === 'edited' && this.tagPanel.editing?.key === tag.key) this.tagPanel.startNew();
        else this.tagPanel.refocus();
    }

    // タグ選択の行の付け外し。選んだノードの全部に付いていれば外し、そうでなければ付ける。付けたら最近使ったタグに覚える
    private toggleTag(row: TagRow): void {
        if (this.tagging === null) return;
        const adding = row.state !== 'all';
        const tag: TagChoice = { key: row.key, value: row.value };
        const status = this.runTags(toggleTagOp(selectedNodes(this.host.selection()), tag), { tagAdded: adding });
        if (status === 'edited' && adding) {
            this.recentTags = rememberTag(this.recentTags, tag);
            // 最近使ったタグの行を出し直す (描き直しで中身を合わせたあとに覚えたため)
            this.refreshTags();
        }
        this.tagPanel.refocus();
    }

    // タグの書き換えを当てる相手。編集しているタグがあれば、選んだノードのうちそのタグを持つもの (なければ全部)
    private tagTargets(editing: TagChoice | null): readonly NodeTarget[] {
        const nodes = selectedNodes(this.host.selection());
        const model = this.host.view.getDocument()?.model;
        if (editing === null || !model) return nodes;
        const carrying = nodes.filter((node) => hasTag(model, node.id, editing));
        return carrying.length > 0 ? carrying : nodes;
    }

    // タグの操作を当てる。変えない (unchanged) ときはその理由を知らせる
    private runTags(op: EditOp, context: NoticeContext = {}): ApplyStatus {
        if (!this.host.editing()) return 'refused';
        const attempt = attemptEdit(this.host.source.source, op);
        if (attempt.status === 'unchanged' && attempt.reason !== null) this.host.notice(attempt.reason.message, 'info');
        return this.host.source.apply(attempt, (edited) => {
            this.settle(op, edited, context);
        });
    }

    // タグのパネルの中身。タグ追加は選んだノードに付いているタグとキーの候補、タグ選択は最近使ったタグと登録されているタグ
    // (開いてから出したものも残す)。行には選んだノードのうちそのタグを持つ数の状態を添える
    private tagContent(tagging: Tagging, ids: readonly number[]): TagPanelContent {
        const model = this.host.view.getDocument()?.model;
        if (!model) return { attached: [], recent: [], registered: [], keys: [] };
        const registered = registeredTags(model);
        const rows = (tags: readonly TagChoice[]): TagRow[] => tags.map((tag) => ({ key: tag.key, value: tag.value, state: tagState(model, ids, tag) }));
        if (tagging.kind === 'select') tagging.shown = mergeTags(tagging.shown, registered);
        const keys = [...new Set(registered.map((tag) => tag.key))].map((key) => ({ key, description: model.tagKeys.find((def) => def.key === key)?.description ?? null }));
        return {
            attached: tagging.kind === 'add' ? rows(attachedTags(model, ids)) : [],
            recent: tagging.kind === 'select' ? rows(this.recentTags) : [],
            registered: tagging.kind === 'select' ? rows(tagging.shown) : [],
            keys,
        };
    }

    // 操作を今の原文に当て、書き換えたら選び直す (名前の入力を開くかは結果の rename で決まる)。
    // groupLabel は通知に出すグループの名前のうち、書き換える前に読んでおくもの (選んだグループの名前)。
    // tellUnchanged なら、変えない (unchanged) ときにその理由を知らせる
    private run(op: EditOp, groupLabel?: string, tellUnchanged = false): void {
        const attempt = attemptEdit(this.host.source.source, op);
        if (tellUnchanged && attempt.status === 'unchanged' && attempt.reason !== null) this.host.notice(attempt.reason.message, 'info');
        this.host.source.apply(attempt, (edited) => {
            this.settle(op, edited, { groupLabel });
        });
    }

    // 書き換えて描き直したあと: 結果の通知、選び直し、選んだノードを見せる、名前の入力 (ノードかグループ) を開く。
    // タグの操作は、選んでいたノードの並びのまま選び直す (結果の select の refText を使う)。
    // 選び直したノードが 2 つ以上なら、どの操作でも図を動かさない (holdsView。凡例の + の addToGroup とタグの操作)。
    // グループにまとめたときは、まとめたノード (操作の nodes の並び) をグループの名前の入力に渡す。
    // 選び直したノードが 1 つなら返す (入力中の Enter / Tab で続けて足す相手)
    private settle(op: EditOp, edited: EditedOutcome, context: NoticeContext = {}): NodeTarget | null {
        const drawn = drawnParts(this.host.view.getDocument());
        const wanted = TAG_OPS.has(op.kind) ? inOrderOf(this.host.selection(), edited.select) : edited.select;
        const select = keepDrawn(wanted, drawn);
        const rename = edited.rename;
        const mismatch = !sameSelection(select, wanted) || (rename !== null && !this.renameDrawn(rename, drawn));
        const named = context.groupLabel ?? (edited.select.kind === 'group' ? this.groupLabel(edited.select.id) : '');
        this.host.notice(editedNotice(op, edited, mismatch ? [MISMATCH_SELECT] : [], { ...context, groupLabel: named }), 'info');
        if (!this.host.editing()) return null;
        if (mismatch) {
            // 図と合わない選び直しは使わず、今の選択のうち描き直した図に残るものを選んだままにする
            this.host.select(keepDrawn(this.host.selection(), drawn));
            return null;
        }
        this.host.select(select);
        // 選び直しの知らせ (onSelectionChange) の中でアプリが片付けたら、見せるのも名前の入力もやめる
        if (!this.host.editing()) return null;
        const chosen = selectedNodes(select);
        const [only] = chosen;
        if (only !== undefined && !holdsView(chosen.length)) this.host.view.ensureVisible(only.id);
        if (rename?.kind === 'node') this.openName(rename.node, true);
        else if (rename?.kind === 'group') this.openGroupName(rename.id, true, 'diagram', op.kind === 'groupNodes' ? op.nodes : []);
        return chosen.length === 1 ? (chosen[0] ?? null) : null;
    }

    // 名前の入力の相手が描き直した図にあるか (ノードは同じ id で同じ refText、グループは同じ名前)
    private renameDrawn(rename: NonNullable<EditedOutcome['rename']>, drawn: DrawnParts): boolean {
        return rename.kind === 'node' ? this.isDrawn(rename.node) : drawn.groups.includes(rename.id);
    }

    private openName(target: NodeTarget, fresh: boolean): boolean {
        let facts: InspectNodeResult | null;
        try {
            facts = inspectNode(this.host.source.source, target);
        } catch {
            facts = null;
        }
        if (facts === null) {
            this.host.notice(MISMATCH_RENAME, 'error');
            return false;
        }
        if (!facts.canRename) {
            this.host.notice(CANNOT_RENAME[facts.kind], 'error');
            return false;
        }
        if (this.naming !== null) this.closeName();
        this.host.view.ensureVisible(target.id);
        const input = this.inputs.node;
        const detach = this.host.view.attachOverlay(input.element, { target: { node: target.id }, place: 'label' });
        this.naming = { kind: 'node', target, fresh, detach };
        input.open(facts.label);
        this.host.onInputChange();
        return true;
    }

    // グループの名前の入力を開く。図の上なら、枠があれば枠のラベルの上 (押した枠を覚えていればその枠、なければ最初の枠)、
    // なければ見えているメンバーの全体の上に重ねる。押した枠を覚えていなければ、先に最初のメンバー (文書の順) を見せる
    // (覚えていれば見せない。押した枠は押したときに見えていて、ほかの枠のメンバーを見せると押した枠が外れることがあるため)。
    // picked はまとめたばかりのグループ (fresh) の、選んでいたノード (選んだ順)。まとめたノードが 2 つ以上なら図を動かさず (holdsView)、
    // 名前の入力が図の領域に収まる枠のラベルに置く (attachToShownFrame)。収まる枠がなければ、今までどおり最初のメンバーを見せて最初の枠に置く。
    // 凡例のパネルから開いたときと、メンバーのいないグループ (図の上に置き場がない) は、凡例のパネルのそのグループの行の中に置く (置けなければ開かない)
    private openGroupName(id: string, fresh: boolean, place: GroupNamePlace = 'diagram', picked: readonly NodeTarget[] = []): boolean {
        const document = this.host.view.getDocument();
        const group = document?.model.groups.find((item) => item.id === id);
        if (!document || !group) {
            this.host.notice(MISSING_GROUP, 'error');
            return false;
        }
        const members = [...document.model.groupsOf].flatMap(([node, groups]) => (groups.includes(id) ? [node] : [])).sort((a, b) => a - b);
        const [first] = members;
        if (this.naming !== null) this.closeName();
        const input = this.inputs.group;
        let detach: (() => void) | null;
        if (place === 'legend' || first === undefined) {
            detach = this.host.attachToLegend(id, input.element);
        } else {
            const frame = this.host.pressedFrame(id);
            const grouped = fresh && frame === null ? groupedOf(picked, new Set(members), document.parsed.nodes) : [];
            detach = holdsView(grouped.length) ? this.attachToShownFrame(id, input.element, grouped, members.length) : null;
            if (detach === null) {
                if (frame === null) this.host.view.ensureVisible(first);
                detach = this.host.view.attachOverlay(input.element, { target: frame === null ? { group: id } : { group: id, frame }, place: 'label' });
            }
        }
        if (detach === null) return false;
        this.naming = { kind: 'group', id, fresh, detach };
        input.open(group.label);
        this.host.onInputChange();
        return true;
    }

    // まとめたばかりのグループの名前の入力を、図を動かさずに、図の領域に収まる枠のラベルの所に置く。試す枠の順は、
    // まとめたノードのうち図の領域に見えているものを囲む枠 (描いた順)、見えているものがなければ最後に選んだものから順に囲む枠、そのあと残りの枠 (描いた順)。
    // 置いた入力の矩形が図の領域に収まる最初の枠に置いて外す関数を返し、どの枠でも収まらなければ置かずに null
    private attachToShownFrame(id: string, element: HTMLElement, grouped: readonly NodeTarget[], limit: number): (() => void) | null {
        const area = this.host.area();
        const frames = this.frameRects(id, limit, area);
        const rects = this.host.view.nodeRects(grouped.map((node) => node.id));
        const frameOf = (node: NodeTarget): number => {
            const rect = rects.get(node.id);
            if (!rect) return -1;
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            return frames.findIndex((frame) => x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height);
        };
        const shown = grouped.filter((node) => {
            const rect = rects.get(node.id);
            return rect !== undefined && overlapsArea(rect, area.width, area.height);
        });
        const first = shown.length > 0 ? shown.map(frameOf).sort((a, b) => a - b) : [...grouped].reverse().map(frameOf);
        const order = [...new Set([...first.filter((index) => index >= 0), ...frames.keys()])];
        for (const frame of order) {
            const detach = this.host.view.attachOverlay(element, { target: { group: id, frame }, place: 'label' });
            const box = element.getBoundingClientRect();
            if (!element.hidden && box.left >= area.left && box.top >= area.top && box.right <= area.right && box.bottom <= area.bottom) return detach;
            detach();
        }
        return null;
    }

    // グループの枠の矩形 (描いた順。図の領域の左上からの画面の座標)。図の側は枠の矩形を読む口を持たないので、見えない要素を枠に重ねて (cover) 測る。
    // 図の側は無い番号の枠を最初の枠に落とすので、最初の枠と同じ矩形になった番号で数え終える (枠は見えているメンバーごとにしかできないので、多くても limit 個)。
    // 枠を描いていないグループは、見えているメンバーの全体の矩形 1 つになる
    private frameRects(id: string, limit: number, area: DOMRect): Rect[] {
        const probe = document.createElement('div');
        probe.style.visibility = 'hidden';
        const frames: Rect[] = [];
        for (let frame = 0; frame < limit; frame += 1) {
            const detach = this.host.view.attachOverlay(probe, { target: { group: id, frame }, place: 'cover' });
            const box = probe.hidden ? null : probe.getBoundingClientRect();
            detach();
            if (box === null) break;
            const rect = { x: box.left - area.left, y: box.top - area.top, width: box.width, height: box.height };
            const [head] = frames;
            if (head !== undefined && sameRect(head, rect)) break;
            frames.push(rect);
        }
        return frames;
    }

    // 描いている文書のグループの名前 (表示の名前。グループがなければ空)
    private groupLabel(id: string): string {
        return this.host.view.getDocument()?.model.groups.find((group) => group.id === id)?.label ?? '';
    }

    // 描いている図に、同じ id で同じ refText のノードがあるか
    private isDrawn(target: NodeTarget): boolean {
        return this.host.view.getDocument()?.parsed.nodes.some((node) => node.id === target.id && node.refText === target.refText) ?? false;
    }

    private isRoot(id: number): boolean {
        return this.host.view.getDocument()?.parsed.nodes.find((node) => node.id === id)?.parent === null;
    }

    // 描いている図で、id のノードから step の先のノード (書いた順の親か兄弟)。親は、名前を持たないリストの入れ物を飛ばしたその上。なければ null
    private stepTarget(step: OutlineStep, id: number): NodeTarget | null {
        const nodes = this.host.view.getDocument()?.parsed.nodes ?? [];
        const nodeOf = (target: number | null): OutlineNode | undefined => (target === null ? undefined : nodes.find((item) => item.id === target));
        let node = nodeOf(outlineTarget(step, id, nodes));
        while (step === 'parent' && node !== undefined && node.parent !== null && this.isListContainer(node)) node = nodeOf(node.parent);
        return node ? targetOf(node) : null;
    }

    // リストの入れ物 (容器。原文に名前の行を持たないノード) か
    private isListContainer(node: OutlineNode): boolean {
        try {
            return inspectNode(this.host.source.source, targetOf(node))?.kind === 'list';
        } catch {
            return false;
        }
    }
}

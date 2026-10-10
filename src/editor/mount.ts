// GUI 編集の組み立てと片付け。markdag/core の render で図を描き、その上に編集の層 (隅の入れ物、セグメント、道具箱、案内、通知、操作の帯) を載せる。
// 閲覧と GUI 編集のモードを持ち、図の操作の解釈 (interaction)、パンのボタン (dragToPan)、図の要素の目印 (data-editor-mode、data-editor-tool) を
// モードと道具に合わせる。モードは文書の markdag.editor と mount の mode で決め、文書の markdag.editor が前の描画から変わったときだけ合わせ直す
// (ほかの行の変更では、見る人やアプリが選んだモードを戻さない)。
// 選択 (GUI 編集のときだけ) を持ち、図の選択の印、操作の帯、複数の選択の外枠、案内に反映する。図を描き直したら、同じ id で refText も同じノードだけを
// 選んだままにし、元に戻す / やり直すでは履歴の選択に戻す。閲覧へ切り替えると選択を解く。
// 操作の帯は道具箱の右から図の領域の右の端の手前までに収まるよう左右にずらし、名前の入力、詳細の入力、タグのパネルを開いている間は出さない。
// 全体表示 (GUI 編集で開いた直後、道具箱のズームリセット、fit) は、GUI 編集では道具箱と左の隅のセグメントを避けた所に収める (閲覧では図の領域の全体)。
// 閲覧から GUI 編集へ移るときは、見る人がまだ図を動かしていなければ (最後の全体表示のままなら) GUI 編集の全体表示にし直す。
// 操作の命令 (名前、子、兄弟、削除、合流、詳細) を帯のボタン、道具箱、キー (Enter、修飾キーつきの Enter、Shift+Enter、Tab、Shift+Tab、Delete / Backspace、J、D)、
// ノードの文字と詳細のダブルクリックから受けて命令の部品に渡す。Enter の修飾キーの割り当て (兄弟を足すキーと兄弟へ移るキー) は、開くときに 1 回見分けた
// OS の区分 (mac か win) で決める。Space を押して、ポインタもほかのキーも押さずに離したら、選んだノードのうちタスクのものの印をまとめて 1 つ進める
// (図の側の口で、印のクリックと同じ確かめを全部に当て、1 回の書き換えにする。履歴も 1 つ)。
// 帯の「タスク化」/「タスク解除」と X で、選んだノードのタスクの記号を付けるか外す (何も選んでいなければ案内を出す)。帯のボタンの名前と押せるかは
// 選んだノードの原文の事実と読み取りだけのグループで決め、事実は同じ原文のあいだ控えて引き直さない。書き換えられるノードがなければ帯のボタンは
// 無効の見た目のまま押せ、押すと X と同じく書き換えずに理由を出す。帯のタスクのボタンを押した直後は、ノードの箱の幅が変わっても帯を画面の上で
// 同じ左右の位置に保ち、次に帯を置き直すとき (帯のほかのボタンを押したときを含む) に選んだノードの中央へ戻す。X とチェックでは保たない。
// X はドラッグの途中と合流先を選ぶ途中には受けない (押し間違いでドラッグと合流先を選ぶ途中をやめないため)。
// 選択の道具でノードを 1 つだけ選んでいて、そのノードがタスクにできてまだタスクでなく、読み取りだけのグループに入らなければ、ノードの左にチェックを出し、
// 押したらそのノードをタスクにする (選択は変えない)。点と + と同じく、入力とパネルを開いている間、手のひら、合流先を選ぶ途中、閲覧では出さない。
// 選んだノードが閉じた枝の中に隠れたら (枝を閉じたとき、外からの差し替えで開閉が文書の初めの状態に戻ったとき)、そのノードを選択から外す
// (2 つ以上なら隠れたものだけ。もう一度開いても選び直さない)。見えないノードを選んだままにすると、キーの操作が見えないノードに当たるため。
// 選んだグループのメンバーが全部隠れたとき、選んだ線の片方の端が隠れたときも同じく外す。名前の入力と詳細の入力を開いている間に相手が隠れたら、
// 外を押したときと同じく入れたもので決めて閉じてから外す (見えない入力を残さない。図は動かさず、閉じた枝は閉じたまま)。
// 道具は道具箱と H (手のひら) / V (選択) で替える (合流先を選ぶ途中ならやめてから替える)。最初の道具は選択。
// 編集の層の操作と元に戻す / やり直すで原文を書き換えても、関係のない閉じた枝は閉じたままにする。
// 選択の道具でのノードのドラッグは、ポインタの下の移せる先に枠を出し、離した所のノードへの付け替えの命令にする (ノードの外なら案内)。
// 選択の道具で選んだノードに点を出し (1 つなら選択の枠の右下の角に線を引く点、2 つ以上なら全体の右に選択全体の点)、点のドラッグを離した所のノードへの
// 線を引く命令か合流の命令にする (ノードの外なら案内)。1 つのノードには子を足す + (右) と兄弟を足す + (下) も出し、押したら足して名前の入力を開く
// (名前の入力、詳細の入力、タグのパネルが開いている間と、原文の事実で足せないものと、ルートの兄弟は出さない)。帯の「既存のノードへ合流」は合流先を選ぶ途中にし、次に押したノードへ合流させる
// (何もないところを押すとやめ、Esc はやめて選択も解く。始点が変わる (選択が変わる、描き直す) ときもやめる)。
// 線のクリックで線を選び (同じ線ならやめる)、選んだ線は図の線の強調で示す (帯は出さない。線は消さない)。
// 選択の道具での枠とラベルのクリックでグループを選び (同じ枠ならやめ、同じグループの別の枠なら選んだまま押した枠に替える)、
// 修飾キーつきのクリックでグループを足す・外す (2 つ以上を選べる。ノードか線を選んでいればそれを解く)。選んだグループは図のグループの強調で示し、
// 1 つだけならグループの帯も出す (2 つ以上では出さない)。枠を押して選んだグループは押した枠を覚え (そのグループ 1 つの選択の間だけ)、
// 帯とグループの名前の入力をその枠に重ねる。
// 枠とラベルのダブルクリック (道具によらない)、Enter、帯の「名前」でグループの名前の入力を開く。⌘G / Ctrl+G、道具箱と帯の「グループ」で
// 選んだノードをグループにまとめ、帯の「グループ解除」でグループを解く。
// 帯の「詳細編集」、D、ノードの中と吹き出しの詳細のダブルクリック (道具によらない) で、そのノードを選んで詳細の入力を開く
// (D はノードを 1 つだけ選んでいるときだけ。ほかは案内を出す)。
// 名前の入力と詳細の入力は、外を押したら押したものの操作より先に決め、閲覧へ切り替えるとき (セグメント、setMode) は決めて閉じ、
// 外からの原文の差し替えと元に戻す / やり直すでは保存せずに閉じる。
// 帯と道具箱の「タグ追加」「タグ選択」と T で、選んだノードのタグのパネルを開く (何も選んでいなければ案内を出す)。選択の道具で修飾キーなしに
// ノードの中か吹き出しのタグを押すと、そのノードを選んで押したタグの編集を開く (手のひらでは選ぶだけ)。パネルは選んでいるノードが変わる、Esc、
// 何もないところの押下 (選択は残す)、元に戻す / やり直す、外からの原文の差し替え、閲覧への切り替えで閉じる。
// 道具箱の詳細表示の選択肢で選んだ見せ方を、GUI 編集の間の図の詳細の見せ方にする (最初はホバー時に表示。原文は変えない)。
// 閲覧では文書の指定に戻し、GUI 編集に戻ると選んだ見せ方に戻す。選択肢は外の押下、Esc、閲覧への切り替えで閉じる。
// 図の側の凡例は作らず、凡例のパネル (線の色・グループ) を文書の legend.position の隅に出す。閲覧では文書の legend.display に従って中身を出したままにし、
// GUI 編集では両方の段を出して見出しで開閉する (GUI 編集に入ったときと、文書の出す指定が変わったときに初めの開閉に戻す)。
// パネルの行の押下でグループを 1 つ選び (道具と修飾キーによらない)、行の名前のダブルクリックで行の中に名前の入力を開き、行の操作ボタン、色の四角のカラーピッカー、
// 見出しの「新規」をグループの操作の命令にする。カラーピッカーは同じ四角、外の押下、Esc、閲覧への切り替え、描き直しで閉じる。
// キーは document で受け、フォーカスが図の要素の中にあるか、フォーカスがどこにもなくポインタが図の上にあるときだけ、GUI 編集で処理する
// (ページのほかの入力欄や、同じページのほかの図に向けたキーを受けない)。閲覧では同じときに、GUI 編集で削除になるキーの既定の動き
// (前のページへ戻るなど) だけを止めて何もしない (GUI 編集で何も選んでいないときと同じ。ほかのキーは受けない)。
// アプリの受け口 (onLayout、onTransform、onFoldChange) は包んで render に渡し、片付けたあとは呼ばない
// (図の片付けは、大きさの監視が予約した描き直しを止めないため)
import {
    inspectNode,
    render,
    type Diagnostic,
    type DisplayMode,
    type DragToPan,
    type EdgeTarget,
    type EditorSettings,
    type InspectNodeResult,
    type LegendItem,
    type LegendPosition,
    type MarkdagView,
    type NodeTarget,
    type OutlineNode,
    type OverlayAnchor,
    type OverlaySpan,
    type OverlayTarget,
    type RenderOptions,
    type SegmentPosition,
    type ViewOptions,
    type ViewTransform,
} from '../core';
import { EditCommands, isDropCandidate } from './commands';
import { carriedFolds } from './folds';
import { commandForKey, isComposingKey, type KeyCommand, type KeyPlatform } from './keys';
import { initialLegendOpen, legendContent, sameLegendDisplay } from './legend';
import { arrowTarget, startNode, type ArrowKey, type Point } from './navigation';
import { isAdditive, isApplePlatform, PointerInput } from './pointer';
import {
    addNodes,
    drawnParts,
    edgeKeyOf,
    edgeSelection,
    groupSelection,
    keepDrawn,
    lastSelectedNode,
    NO_SELECTION,
    nodesSelection,
    sameNodeSet,
    sameSelection,
    selectedEdge,
    selectedGroup,
    selectedGroups,
    selectedNodes,
    targetOf,
    toggleGroup,
    toggleNode,
    withoutFolded,
    type EditorSelection,
} from './selection';
import { FALLBACK_EDITOR_SETTINGS, resolveModeRule, sameEditorSettings, type EditorMode, type EditorModeOption, type ModeRule } from './settings';
import { EditorSource, type Redraw } from './source';
import { blockedAdding, taskLocksOf, taskPlan } from './tasks';
import { Tools } from './tools';
import { ColorPicker } from './ui/color-picker';
import { ContextBar, type BarCommand, type BarTask } from './ui/context-bar';
import { Corners } from './ui/corners';
import { Handles, type DragHandleKind, type PlusHandleKind } from './ui/handles';
import { Hint, type HintSelection } from './ui/hint';
import { LegendPanel, type LegendAction } from './ui/legend-panel';
import { Segment } from './ui/segment';
import { Snackbar } from './ui/snackbar';
import type { TagPanelKind } from './ui/tag-panel';
import { TaskCheck } from './ui/task-check';
import { Toolbox, type ToolboxItem } from './ui/toolbox';

// render から受け取るオプション。legend と details は編集の層が決めるので受け取らない (図の側の凡例は作らず、凡例のパネルを出す)
type RenderKeys = 'theme' | 'animate' | 'injectStyle' | 'types' | 'icons' | 'resolveIcon' | 'hookRefs' | 'hooks' | 'onDiagnostic' | 'onHookError' | 'onFoldChange' | 'onTransform' | 'onLayout';

export interface EditorOptions extends Pick<RenderOptions, RenderKeys> {
    // 既定は document (文書の markdag.editor.mode に従う)。view、edit、switch は文書の mode だけを上書きする
    mode?: EditorModeOption;
    // 図の側の操作で原文が変わった (GUI 編集の操作で原文が変わったとき、元に戻す / やり直す、タスクの印、Space でタスクを進めたとき、フックの api.update)。
    // setSource では呼ばない
    onChange?: (markdown: string) => void;
    // 閲覧と GUI 編集が切り替わった。byUser はセグメントを押したときだけ true。mount では呼ばない (初めのモードは getMode で読む)
    onModeChange?: (mode: EditorMode, byUser: boolean) => void;
    // 選んでいるものが変わった (描き直したあとの選び直しと、閲覧へ切り替えて解いたときを含む)。mount では呼ばない
    onSelectionChange?: (selection: EditorSelection) => void;
}

export interface MarkdagEditor {
    readonly view: MarkdagView;
    // 最後に描いた文書の診断 (render の diagnostics と同じ)
    readonly diagnostics: Diagnostic[];
    getSource(): string;
    // アプリが原文を差し替える。履歴に 1 つ積み、onChange は呼ばない。今と同じ原文なら何もしない。beforeUpdate が取りやめたら原文を変えない
    setSource(markdown: string): Diagnostic[];
    getMode(): EditorMode;
    // mode の設定が switch のときだけ切り替えて true。switch でなければ何もせず false
    setMode(mode: EditorMode): boolean;
    // 選んでいるもの (閲覧では選択なし)。ノードは図の id と refText。グループは 1 つなら { kind: 'group' }、2 つ以上なら { kind: 'groups' } (選んだ順)
    getSelection(): EditorSelection;
    // 元に戻す / やり直す。モードによらず効き、原文が変われば onChange を呼ぶ。戻すもの / やり直すものがなければ false
    undo(): boolean;
    redo(): boolean;
    setTheme(theme: 'light' | 'dark'): void;
    // 全体表示。GUI 編集では道具箱と左の隅のセグメントを避けた所に収め (ズームリセットと同じ)、閲覧では図の領域の全体に収める
    fit(): void;
    // 編集の層の要素、図に重ねた帯と外枠、図の要素に付けた目印と tabindex、document と window と図の要素と図に足した受け口、通知の待ちを外し、
    // アプリの受け口の包みを止めてから、render の destroy を呼ぶ。2 回目以降は何もしない
    destroy(): void;
}

// ノードを 1 つ選んでいるときだけ受けるキーの命令 (ボタンの上では受けない。グループを選んでいるときは rename だけを受ける)
const NODE_KEY_COMMANDS: ReadonlySet<KeyCommand> = new Set(['rename', 'add-child', 'add-sibling', 'add-sibling-before', 'rename-parent', 'rename-previous', 'rename-next']);

// 包まずにそのまま render に渡すオプション
const PASSED_OPTIONS = ['theme', 'animate', 'injectStyle', 'types', 'icons', 'resolveIcon', 'hookRefs', 'hooks', 'onDiagnostic', 'onHookError'] as const satisfies ReadonlyArray<RenderKeys>;

// ノードを選んでいないときに、グループにまとめる操作 (⌘G / Ctrl+G、道具箱) を求めたときの案内
const GROUP_IDLE_NOTICE = '何もないところからドラッグしてノードを囲むと、選んだノードをグループにまとめます';

// ノードを選んでいないときに、タグのパネル (T、道具箱) を求めたときの案内
const TAG_PICK_NOTICE = 'タグを付けるノードを選んでください (クリック、または何もないところからドラッグで囲む)';

// 選んだノードに働く道具を、何も選んでいないときに押したときの案内
const IDLE_NOTICES: Partial<Record<ToolboxItem, string>> = {
    join: '何もないところからドラッグして 2 つ以上を囲むと、選んだノードを新しいノードへ合流させます',
    group: GROUP_IDLE_NOTICE,
};

// ノードを選んでいないときに、タスク化か解除 (X) を求めたときの案内
const TASK_PICK_NOTICE = 'タスク化するノードを選んでください (クリック、または何もないところからドラッグで囲む)';

// ノードを 1 つだけ選んでいないときに、D で詳細の入力を求めたときの案内
const DETAILS_PICK_NOTICE = '詳細を書くノードを 1 つだけ選んでから D を押してください (クリックで選ぶ)';

// GUI 編集で最初に使う詳細の見せ方 (文書の指定によらない)
const INITIAL_DETAILS: DisplayMode = 'hover';

// 操作の帯と相手の間 (画面の px)。2 つ以上を選んだときは、全体の外枠の破線の外にさらに離す
const BAR_GAP = 20;
const BAR_GAP_AROUND_BOUNDS = 24;
// 操作の帯と、道具箱の右の辺と図の領域の右の辺の間 (画面の px。帯はこの間に収まるよう左右にずれる)
const BAR_EDGE = 8;
// GUI 編集の全体表示で、道具箱とセグメントの右の辺から空ける幅 (画面の px)
const FIT_GAP = 8;

// ルートを修飾キーで選択に足そうとしたときの理由 (ルートは複数の選択の操作 (合流など) に使えない)
const ROOT_NOTICE = 'ルートは合流の始点にできません';

// 付け替えのドラッグをノードの外で離したときの案内
const DROP_OUTSIDE_NOTICE = 'ほかのノードの上で離すと、その下へ移ります';

// 線を引くドラッグと合流させるドラッグをノードの外で離したときの案内
const LINK_OUTSIDE_NOTICE = 'ほかのノードの上で離すと、そのノードへ線を引きます';
const JOIN_OUTSIDE_NOTICE = 'ほかのノードの上で離すと、そのノードへ合流させます';

// 合流先に始点のノードを選んだときの案内 (合流先を選ぶ途中は続ける)
const JOIN_SOURCE_NOTICE = '合流させるノード (始点) は合流先にできません。ほかのノードを選んでください';

// 2 つ未満の選択で、新しいノードへの合流を J で求めたときの理由
const JOIN_FEW_NOTICE = '何もないところからドラッグして、合流させるノードを 2 つ以上囲んでください';

// カラーピッカーの 16 進の入力が読めないときの理由
const HEX_INVALID_NOTICE = '16 進の色は #RGB か #RRGGBB の形で入れてください (# は省けます)';


const sameTransform = (a: ViewTransform, b: ViewTransform): boolean => a.k === b.k && a.x === b.x && a.y === b.y;

// 帯を画面の上で保つ左の位置 (図の領域の左上からの画面の px) と、保つのをやめるかを比べる、押した書き換えのあとの原文、図の表示位置、
// 図の領域の幅、閉じた枝。after は押している途中は null (その間の描き直しでは保ったままにする)
interface BarHold {
    left: number;
    after: { source: string; transform: ViewTransform; areaWidth: number; folded: string } | null;
}

// undefined の欄を落とす (render は渡された欄で図の指定を上書きするので、undefined を渡すと既定の値が消える)
function definedOnly<T extends object>(value: Record<string, unknown>): T {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

// 文字を打つ要素 (中のキーは要素のもの。編集の層の命令にしない)
function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
    return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'reset', 'submit', 'image', 'range', 'color', 'file'].includes(target.type);
}

export function mountEditor(container: HTMLElement, markdown: string, options: EditorOptions = {}): MarkdagEditor {
    const modeOption: EditorModeOption = options.mode ?? 'document';
    const onModeChange = options.onModeChange;
    let destroyed = false;
    // 文書の markdag.editor (値を埋めたもの) と、それと mount の mode から決めた決まり
    let settings: EditorSettings = FALLBACK_EDITOR_SETTINGS;
    let rule: ModeRule = resolveModeRule(modeOption, settings);
    let mode: EditorMode = rule.initial;
    // 図に渡している操作の解釈、パンのボタン、詳細の見せ方 (render の既定は view、primary、auto)
    let applied: { interaction: EditorMode; dragToPan: DragToPan; details: ViewOptions['details'] } = { interaction: 'view', dragToPan: 'primary', details: 'auto' };
    // 詳細表示の選択肢で選んだ見せ方 (GUI 編集の間だけ図に渡す。mount の間は閲覧をはさんでも覚えておく)
    let detailsChoice: DisplayMode = INITIAL_DETAILS;
    let segment: Segment | null = null;
    // セグメントを置いている隅 (出していなければ null)
    let segmentCorner: SegmentPosition | null = null;
    // ページの上で最後にポインタが動いた (押された) 位置が、図の要素の上だったか
    let pointerOnContainer = false;
    // 最後のポインタの位置 (画面の座標)。ポインタがウィンドウの外へ出たら null
    let pointerAt: Point | null = null;
    // ポインタのボタンを押しているか (最後に受けたポインタの出来事の buttons で見る)
    let pointerHeld = false;
    // 選んでいるもの (閲覧ではいつも選択なし)
    let selection: EditorSelection = NO_SELECTION;
    // グループ 1 つを枠かラベルの押下で選んだ (かダブルクリックで名前の入力を開いた) ときの、そのグループと押した枠 (描いた順の番号)。
    // そのグループ 1 つの選択の間だけ覚え、帯とグループの名前の入力をその枠に重ねる
    let pressedFrame: { group: string; frame: number } | null = null;
    // 操作の帯と複数の選択の外枠を、図の重ね置きの層から外す
    let detachBar: (() => void) | null = null;
    let detachBounds: (() => void) | null = null;
    // 帯を重ねている相手 (同じ相手なら重ね直さない。押している途中のボタンを動かさないため) と、重ねたときの置き方 (保つのをやめてすぐ置き直すときに使う)
    let barTarget = '';
    let barAnchor: OverlayAnchor | null = null;
    // 帯のタスク化のボタンを押した直後に、帯を画面の上で保っている左右の位置 (保っていなければ null)
    let barHold: BarHold | null = null;
    // 図の線の強調に渡している、選んだ線のキー (GUI 編集で線を選んでいるときだけ。閲覧の図の線の選択には触らない)
    let edgeShown: string | null = null;
    // 図のグループの強調を渡しているか (GUI 編集でグループを選んでいるときだけ。閲覧の図のグループの選択には触らない)
    let groupShown = false;
    // 合流先を選ぶ途中の、合流させるノード (始点)
    let joinSources: readonly NodeTarget[] = [];
    // 選択の道具で修飾キーなしにノードを押して選んだ (合流先にしたのでない) ときのそのノード。続くタグのクリックで、そのタグの編集を開く
    let tagPress: number | null = null;
    // 何もないところの押下でタグのパネルを閉じた (続くクリックで選択を解かない)
    let blankClosedTags = false;
    // 図の吹き出しを、印のクリックで出したままにしているか
    let popoverPinned = false;
    // 最後に全体表示した (render が描いたときと fitView) 直後の表示位置。今の表示位置がこれと同じなら、見る人はまだ図を動かしていない
    let fittedAt: ViewTransform | null = null;
    // 凡例のパネルの開閉 (GUI 編集のときだけ使う。閲覧では中身を出したまま)
    let legendOpen = true;
    // 最後に描いた文書の凡例の出す指定 (変わったときだけ開閉を初めの状態に戻す) と、パネルを置いている隅
    let legendDisplay: readonly LegendItem[] | null = null;
    let legendCorner: LegendPosition | null = null;
    // ノードの原文の事実 (inspectNode) の控えと、それを読んだ原文 (原文が変わったら捨てる)
    let factsSource: string | null = null;
    const factsCache = new Map<string, InspectNodeResult | null>();
    // 書き換えと元に戻す / やり直すの描き直しの途中で、枝の開閉を置き直しているか (閉じていた枝を閉じたままにする、戻したノードを見せるために開く)。
    // その間の開閉の変化では選択を外さない (選び直しはそのあとに描き直した文書で行う)
    let refolding = false;
    // document、window、図の要素に付けた受け口をまとめて外す
    const teardown = new AbortController();

    // 片付けたあとはアプリの受け口を呼ばない
    function whileMounted<A extends unknown[]>(listener: ((...args: A) => void) | undefined): ((...args: A) => void) | undefined {
        if (!listener) return undefined;
        return (...args: A) => {
            if (!destroyed) listener(...args);
        };
    }

    // Enter の修飾キーの割り当ての区分は、開くときに 1 回だけ見分ける
    const keyPlatform: KeyPlatform = isApplePlatform() ? 'mac' : 'win';
    // 編集の層の部品は図を描く前に作る (図を描く途中の知らせでも部品がある)。要素は図を描いたあとに置く
    const tools = new Tools(showTools);
    const toolbox = new Toolbox(pressToolbox, chooseDetailsMode);
    toolbox.showDetailsMode(detailsChoice);
    const hint = new Hint(keyPlatform);
    const snackbar = new Snackbar();
    const bar = new ContextBar(pressBar);
    const bounds = document.createElement('div');
    bounds.className = 'mdag-editor-selection-bounds';
    const source = new EditorSource(markdown, {
        selection: () => selection,
        onRedrawn: redrawn,
        onNotice: (message, kind) => snackbar.show(message, kind),
        onChange: options.onChange,
        onHistoryChange: showHistory,
        beforeRedraw: keepFolds,
    });
    const diagram = render(
        container,
        markdown,
        definedOnly<RenderOptions>({
            ...Object.fromEntries(PASSED_OPTIONS.map((key) => [key, options[key]])),
            onChange: source.changedByView,
            legend: false,
            onLayout: whileMounted(options.onLayout),
            onTransform: whileMounted(options.onTransform),
            onFoldChange: whileMounted(options.onFoldChange),
        }),
    );
    source.attach(diagram);
    const { view } = diagram;
    fittedAt = view.getTransform();
    const commands = new EditCommands({
        view,
        source,
        keyPlatform,
        editing: () => !destroyed && mode === 'edit',
        selection: () => selection,
        select: (next) => select(next, true),
        pressedFrame: (id) => (pressedFrame !== null && pressedFrame.group === id ? pressedFrame.frame : null),
        notice: (message, kind) => snackbar.show(message, kind),
        focusContainer,
        onInputChange: showInputs,
        onInputCancel: () => {
            closePicker();
            toolbox.closeFlyout();
        },
        popoverPinned: () => popoverPinned,
        attachToLegend,
        // 編集の層は図の領域と同じ位置と大きさ
        area: () => layer.getBoundingClientRect(),
    });

    // 編集の層の要素は図の要素の中の最後に置く (図の領域、吹き出し、凡例のあと)
    const layer = document.createElement('div');
    layer.className = 'mdag-editor';
    container.append(layer);
    const corners = new Corners(layer);
    const legend = new LegendPanel(
        {
            onToggle: toggleLegend,
            onNew: pressLegendNew,
            onRowPress: pressLegendRow,
            onRowDoubleClick: doubleClickLegendRow,
            onChip: pressLegendChip,
            onAction: pressLegendAction,
        },
        (id) => view.groupLogo(id),
    );
    const picker = new ColorPicker({
        onPick: pickColor,
        onInvalid: () => snackbar.show(HEX_INVALID_NOTICE, 'error'),
        onCancel: () => closePicker(),
    });
    layer.append(toolbox.element);
    corners.place(hint.element, 'bottom-center', 'hint');
    corners.place(snackbar.element, 'bottom-center', 'snackbar');
    showHistory();
    // 図の上の押下とクリックを選択に読み替える (矩形は編集の層に描く。編集の層は図の領域と同じ位置と大きさ)
    const pointer = new PointerInput(
        layer,
        {
            editing: () => !destroyed && mode === 'edit',
            selectDrag: () => tools.selectDrag,
            takesBlankClick: () => tools.joining || tools.tool === 'select',
            pressNode,
            boxNodes,
            clickBlank,
            nodeRects: () => view.nodeRects(),
            moveSource,
            canDropOn: (source, id) => isDropCandidate(view.getDocument()?.parsed.nodes ?? [], source.id, id),
            showDropTarget: (id) => view.setDropTarget(id),
            dropNode,
            clickEdge,
            linkTo,
        },
        teardown.signal,
    );
    // 選んだノードの点 (押したら線を引くドラッグか合流させるドラッグを始める) と、子と兄弟を足す + (押したら足して名前の入力を開く)。
    // 置き場と広げた当たり判定は選択の枠 (選んだノードの箱) に合わせるので、図の倍率が変わるたびに直す
    const handles = new Handles(
        (element, anchor) => view.attachOverlay(element, anchor),
        (id) => view.nodeRects([id]).get(id) ?? null,
        { onDragStart: pressHandle, onPlus: pressPlus },
        teardown.signal,
    );
    handles.setZoom(view.getTransform().k);
    // 選んだノードがタスクでないときの、ノードの左のチェック。置き場は選択の枠に合わせるので、図の倍率が変わるたびに直す
    const taskCheck = new TaskCheck((element, anchor) => view.attachOverlay(element, anchor), pressTaskCheck, teardown.signal);
    taskCheck.setZoom(view.getTransform().k);
    const removeHooks = view.addHooks({
        ...pointer.hooks,
        onTransform: (transform) => {
            handles.setZoom(transform.k);
            taskCheck.setZoom(transform.k);
        },
        // 枝を閉じて隠れた選んだノードは選択から外す (描き直しの途中の開閉の置き直しでは外さない)
        onFoldChange: () => {
            if (!refolding) dropFolded();
        },
        onCanvasPointerDown: (event, target) => {
            pressCanvas(event.button === 0 && target.kind === 'blank');
            pointer.hooks.onCanvasPointerDown?.(event, target);
        },
        onNodeDoubleClick: doubleClickNode,
        onTagClick: clickTag,
        onFrameClick: clickFrame,
        onFrameDoubleClick: (id, _event, frame) => doubleClickFrame(id, frame),
        // ロゴの SVG があとから届いたら、凡例のパネルの行のロゴを引き直す
        onIconSvg: () => legend.refreshLogos(),
        onDetailsShow: (_node, pinned) => {
            popoverPinned = pinned;
        },
        onDetailsHide: () => {
            popoverPinned = false;
        },
    });

    // 図の要素にフォーカスを置けるようにする (もとから tabindex があればそのまま使い、片付けでも触らない)
    const addedTabIndex = !container.hasAttribute('tabindex');
    if (addedTabIndex) container.tabIndex = -1;
    listenInput(teardown.signal);

    settings = documentSettings();
    rule = resolveModeRule(modeOption, settings);
    mode = rule.initial;
    placeSegment(rule.segment);
    showMode();
    // render が図の領域の全体に収めた表示を、GUI 編集で開いたときは道具箱とセグメントを避けた全体表示に置き直す
    if (mode === 'edit') fitView();

    // 最後に描いた文書の markdag.editor (transformSource のあとの文で解析したもの)
    function documentSettings(): EditorSettings {
        return view.getDocument()?.model.editor ?? FALLBACK_EDITOR_SETTINGS;
    }

    // 図の操作の解釈、パンのボタン、詳細の見せ方を、今のモードと道具と選んだ見せ方に合わせる (変わったものだけを渡す)。
    // 閲覧の詳細の見せ方は文書の指定 (auto)
    function applyViewOptions(): void {
        const editing = mode === 'edit';
        const next: typeof applied = { interaction: mode, dragToPan: editing ? tools.dragToPan : 'primary', details: editing ? detailsChoice : 'auto' };
        const changes: Partial<ViewOptions> = {};
        if (next.interaction !== applied.interaction) changes.interaction = next.interaction;
        if (next.dragToPan !== applied.dragToPan) changes.dragToPan = next.dragToPan;
        if (next.details !== applied.details) changes.details = next.details;
        applied = next;
        // 詳細の見せ方を替えるとノードの大きさが変わるので、帯を保つのをやめる
        if (changes.details !== undefined) barHold = null;
        if (Object.keys(changes).length > 0) view.setOptions(changes);
    }

    // 今の道具 (合流先を選ぶ途中を含む) を図の要素の目印、道具箱の押された印、案内、点、パンのボタンに反映する。閲覧では道具の目印を付けない
    function showTools(): void {
        if (destroyed) return;
        if (mode === 'edit') container.dataset.editorTool = tools.state;
        else delete container.dataset.editorTool;
        toolbox.showTool(tools.state);
        showHint();
        showHandles();
        showTaskCheck();
        applyViewOptions();
    }

    function showHint(): void {
        const count = selectedNodes(selection).length;
        const selected: HintSelection =
            selection.kind === 'edge' || selection.kind === 'group' || selection.kind === 'groups' ? selection.kind : count === 0 ? 'none' : count === 1 ? 'node' : 'nodes';
        hint.show(tools.state, selected, commands.inputKind);
    }

    // 選んだノードの点と + は、GUI 編集の選択の道具のときだけ出す (手のひらと、合流先を選ぶ途中では出さない)。
    // 名前の入力か詳細の入力かタグのパネルが開いている間は、帯と同じく点も + も全部隠す。点を出すときはそのノードで出せる + を
    // 全部出すので、線を引く点をずらす量は出せる + で決まり、閉じて出し直した点は開く前と同じ所に出る
    function showHandles(): void {
        const ids = mode === 'edit' && tools.state === 'select' && commands.inputKind === null ? selectedNodes(selection).map((target) => target.id) : [];
        handles.show(ids, ids.length === 1 ? plusKinds() : []);
    }

    // 選んでいる 1 つのノードで出せる + 。原文の事実で足せないもの (図と原文が合っていなければどちらも) と、ルートの兄弟は出さない
    function plusKinds(): PlusHandleKind[] {
        const node = singleNode();
        if (node === null) return [];
        const facts = inspectNode(source.source, node);
        if (facts === null) return [];
        const root = view.getDocument()?.parsed.nodes.find((item) => item.id === node.id)?.parent === null;
        const kinds: PlusHandleKind[] = [];
        if (facts.canAddChild) kinds.push('child');
        if (facts.canAddSibling && !root) kinds.push('sibling');
        return kinds;
    }

    // 選んだ線を図の線の強調で示し、線を選んでいなければ編集の層が付けた強調を外す
    function showEdge(): void {
        const edge = mode === 'edit' ? selectedEdge(selection) : null;
        const key = edge === null ? null : edgeKeyOf(edge);
        if (key !== null) view.selectEdge(key);
        else if (edgeShown !== null) view.selectEdge(null);
        edgeShown = key;
    }

    // 選んだグループ (2 つ以上なら全部) を図のグループの強調で示し、グループを選んでいなければ編集の層が付けた強調を外す
    // (図は描き直しで木の形が変わると強調を外すので、選んでいる間は毎回渡し直す。同じグループの並びなら図は何もしない)
    function showGroup(): void {
        const ids = mode === 'edit' ? selectedGroups(selection) : [];
        if (ids.length > 0) view.selectGroups(ids);
        else if (groupShown) view.selectGroup(null);
        groupShown = ids.length > 0;
    }

    // 今のモードを図の要素の目印、セグメントの押された印、道具箱と案内の有無、凡例のパネル、図の詳細の見せ方に反映する。閲覧では道具を最初の道具 (選択) に戻し
    // (合流先を選ぶ途中もやめる)、ドラッグの途中をやめて選択を解き、カラーピッカーと詳細表示の選択肢を閉じる。GUI 編集では、閲覧のあいだに見る人が図で選んだ線と
    // グループの強調を外し (編集の層の選択にない強調を残さない)、凡例のパネルの開閉を初めの状態に戻す
    function showMode(): void {
        container.dataset.editorMode = mode;
        const editing = mode === 'edit';
        toolbox.element.hidden = !editing;
        hint.element.hidden = !editing;
        segment?.show(mode);
        followLegendDisplay();
        if (!editing) {
            commands.closeInput();
            commands.closeTags();
            closePicker();
            toolbox.closeFlyout();
            tools.reset();
            pointer.cancel();
            select(NO_SELECTION);
        } else {
            if (edgeShown === null) view.selectEdge(null);
            if (!groupShown) view.selectGroup(null);
            legendOpen = initialLegendOpen(legendDisplay ?? []);
        }
        showLegend();
        showTools();
    }

    // 文書の凡例の出す指定 (legend.display) が前の描画から変わったら、凡例のパネルの開閉を初めの状態に戻す
    function followLegendDisplay(): void {
        const display = view.getDocument()?.model.legend ?? [];
        if (legendDisplay !== null && !sameLegendDisplay(display, legendDisplay)) legendOpen = initialLegendOpen(display);
        legendDisplay = [...display];
    }

    // 凡例のパネルを、描いている文書、モード、開閉、選択に合わせる。隅は変わったときだけ置き直す
    // (同じ隅でも置き直すと、行の中の名前の入力がフォーカスを失って決まってしまうため)
    function showLegend(): void {
        const model = view.getDocument()?.model;
        legend.show(model ? legendContent(model, view.branchColors(), mode) : null, mode, legendOpen);
        if (model && model.legendPosition !== legendCorner) {
            corners.place(legend.element, model.legendPosition, 'legend');
            legendCorner = model.legendPosition;
        }
        showLegendSelection();
    }

    // 凡例のパネルの選んだ行の印 (グループを 2 つ以上選んでいれば全部の行) と、+ を押せるか (ノードを 1 つ以上選んでいるときだけ)
    function showLegendSelection(): void {
        const editing = mode === 'edit';
        legend.showSelection(editing ? selectedGroups(selection) : [], editing && selectedNodes(selection).length > 0);
    }

    function openLegend(): void {
        if (legendOpen) return;
        legendOpen = true;
        legend.setOpen(true);
    }

    // 凡例のパネルの見出しの押下 (GUI 編集のときだけ届く)。開閉を切り替える
    function toggleLegend(): void {
        if (destroyed || mode !== 'edit') return;
        legendOpen = !legendOpen;
        legend.setOpen(legendOpen);
        focusContainer();
    }

    // 見出しの「新規」。パネルが閉じていれば開いてから、ノードを選んでいればグループにまとめ、選んでいなければメンバーのいないグループを作る
    // (どちらも作ったグループの名前の入力が開く)
    function pressLegendNew(): void {
        if (destroyed || mode !== 'edit') return;
        endJoin();
        openLegend();
        const nodes = selectedNodes(selection);
        if (nodes.length > 0) commands.groupNodes(nodes);
        else commands.defineGroup();
        returnFocus();
    }

    // 凡例のパネルの行の押下 (道具と修飾キーによらない)。そのグループ 1 つを選んでいれば選択を解き、そうでなければ
    // (2 つ以上を選んでいてその中のグループの行を押したときも) そのグループ 1 つを選ぶ。押した枠は覚えない (帯は最初の枠)
    function pressLegendRow(id: string): void {
        if (destroyed || mode !== 'edit' || !hasGroup(id)) return;
        pressedFrame = null;
        select(selectedGroup(selection) === id ? NO_SELECTION : groupSelection(id));
    }

    // 凡例のパネルの行のダブルクリック (道具によらない)。そのグループを選んで、行の中に名前の入力を開く
    function doubleClickLegendRow(id: string): void {
        if (destroyed || mode !== 'edit' || !hasGroup(id)) return;
        pressedFrame = null;
        select(groupSelection(id));
        commands.renameGroup(id, 'legend');
    }

    // 凡例のパネルの行の操作ボタン。+ は選んでいるノードをそのグループに入れ、目は枠の有無を切り替え、ごみ箱はグループを解く
    function pressLegendAction(id: string, action: LegendAction): void {
        if (destroyed || mode !== 'edit' || !hasGroup(id)) return;
        endJoin();
        if (action === 'add') {
            const nodes = selectedNodes(selection);
            if (nodes.length > 0) commands.addToGroup(id, nodes);
        } else if (action === 'boundary') {
            const group = view.getDocument()?.model.groups.find((item) => item.id === id);
            if (group) commands.setGroupBoundary(id, !group.boundary);
        } else commands.ungroup(id);
        returnFocus();
    }

    // 色の四角の押下。そのグループのカラーピッカーを開いていれば閉じ、そうでなければ四角の近くに開く
    function pressLegendChip(id: string, chip: HTMLElement): void {
        if (destroyed || mode !== 'edit' || !hasGroup(id)) return;
        if (picker.openFor === id) closePicker();
        else picker.open(layer, chip, id, view.getDocument()?.model.groups.find((group) => group.id === id)?.color ?? null);
        focusContainer();
    }

    // カラーピッカーで色を選んだ。ピッカーを閉じてから、そのグループの色を書き換える
    function pickColor(color: string): void {
        const id = picker.openFor;
        closePicker();
        if (id !== null && !destroyed && mode === 'edit') commands.setGroupColor(id, color);
    }

    // カラーピッカーを閉じる。中にフォーカスがあれば図の要素へ戻す
    function closePicker(): void {
        if (!picker.isOpen) return;
        const active = document.activeElement;
        picker.close();
        if (active instanceof Node && picker.contains(active)) focusContainer();
    }

    // 凡例のパネルのグループの行の中に、グループの名前の入力を置く (パネルが閉じていれば開く)
    function attachToLegend(id: string, element: HTMLElement): (() => void) | null {
        if (destroyed || mode !== 'edit') return null;
        openLegend();
        return legend.host(id, element);
    }

    // 名前の入力か詳細の入力かタグのパネルが開いたか閉じた。名前の入力か詳細の入力が開いたらタグのパネルを閉じ (同時に 1 つだけ)、
    // 案内と、点と + と、帯 (どれも入力とパネルが開いている間は出さない) を合わせる
    function showInputs(): void {
        if (commands.isInputOpen) commands.closeTags();
        showHint();
        showHandles();
        showTaskCheck();
        showBar();
    }

    // ボタンやキーの操作のあとのフォーカスの戻し先。名前の入力か詳細の入力が開いていればそのまま、タグのパネルが開いていればパネルの欄、
    // そうでなければ図の要素
    function returnFocus(): void {
        if (commands.isInputOpen) return;
        if (commands.tagPanelKind !== null) commands.focusTagPanel();
        else focusContainer();
    }

    // 元に戻す / やり直す。タグのパネルは先に閉じる
    function travel(direction: 'undo' | 'redo'): boolean {
        commands.closeTags();
        return direction === 'undo' ? source.undo() : source.redo();
    }

    function showHistory(): void {
        if (!destroyed) toolbox.showHistory(source.canUndo, source.canRedo);
    }

    // save は閲覧へ切り替えるときに、開いている入力 (名前か詳細) を決めるか (セグメントと setMode)。決められなくても閉じて切り替える。
    // 文書の指定の変更では保存せずに閉じる
    function switchTo(next: EditorMode, byUser: boolean, save: boolean): void {
        if (next === mode) return;
        if (next === 'view') {
            if (save) commands.commitInput('switch');
            else commands.closeInput();
            // 決めた名前か詳細の書き換えで文書の指定が変わり、もう切り替わっていることがある
            if (next === mode) return;
        }
        mode = next;
        showMode();
        // 閲覧から GUI 編集へ移るとき、見る人がまだ図を動かしていなければ (全体表示のまま)、道具箱とセグメントを避けた全体表示にし直す
        if (mode === 'edit' && fittedAt !== null && sameTransform(view.getTransform(), fittedAt)) fitView();
        onModeChange?.(mode, byUser);
    }

    // セグメントを隅に出す (null なら外す)
    function placeSegment(corner: SegmentPosition | null): void {
        segmentCorner = corner;
        if (corner === null) {
            if (segment) corners.remove(segment.element);
            segment = null;
            return;
        }
        if (!segment) {
            segment = new Segment((picked) => switchTo(picked, true, true));
            segment.show(mode);
        }
        corners.place(segment.element, corner, 'segment');
    }

    // 編集の層の操作か元に戻す / やり直すで原文を差し替える前に、閉じている枝を控える。返す関数は描き直したあとに、控えた枝のうち
    // 書き換えたあとの文書に残るものを閉じたままにし、ほかは開く (図は木の形が変わると開閉を文書の初めの閉じ方に戻すため。
    // 関係のない閉じた枝を開かず、開いていた枝を閉じない。閉じた枝が 1 つもなくても置き直す)。
    // 足したノードと戻したノードを見せるために開くのは、そのあとの選び直しが行う
    function keepFolds(): () => void {
        const before = view.getDocument()?.parsed.nodes ?? [];
        const folded = view.getFolded();
        return () => refold(() => view.setFolded(carriedFolds(before, folded, view.getDocument()?.parsed.nodes ?? [])));
    }

    // 描き直しの途中の開閉の置き直し (この間の開閉の変化では選択を外さない)
    function refold(change: () => void): void {
        refolding = true;
        try {
            change();
        } finally {
            refolding = false;
        }
    }

    // 選んだもののうち、閉じた枝の中に隠れたものを選択から外す (閉じた枝そのものは見えているので選んだまま。グループはメンバーが全部隠れたら、
    // 線は片方の端が隠れたら外す)。開いている名前の入力か詳細の入力の相手が外れるなら、先に入れたもので決めて閉じる
    function dropFolded(): void {
        if (destroyed || mode !== 'edit') return;
        const shown = (): EditorSelection => {
            const drawn = view.getDocument();
            return withoutFolded(selection, drawn?.parsed.nodes ?? [], view.getFolded(), drawn?.model.groupsOf ?? new Map());
        };
        if (commands.isInputOpen && !sameSelection(shown(), selection)) {
            // 入力の欄が相手と一緒に隠れてフォーカスが頁の body へ外れていたら、決めたあとは図の要素へ戻す (キーの操作を続けられるように)。
            // アプリのほかの要素にあるフォーカスは動かさない
            const lost = (): boolean => document.activeElement === null || document.activeElement === document.body;
            const inside = lost() || commands.contains(document.activeElement);
            commands.commitInput('hidden');
            if (inside && lost() && !destroyed) focusContainer();
        }
        if (destroyed || mode !== 'edit') return;
        select(shown());
    }

    // 原文が変わって描き直したあと (図は選択の印を外している)。矩形選択の途中をやめ、外からの差し替えと元に戻す / やり直すでは
    // 名前の入力と詳細の入力を保存せずに閉じ (前の原文で入れたものを新しい原文に当てない)、モードを合わせ直してから、
    // 履歴から戻した選択か今の選択のうち、描き直した図に同じ id と refText で残るノードを選び直す。
    // 編集の層の操作の書き換えでは、選び直しと名前の入力は操作の結果で命令の部品が行う
    function redrawn(redraw: Redraw): void {
        if (destroyed) return;
        pointer.cancel();
        // チェックの相手は前の原文のノードなので消す (選び直しで出し直す)
        taskCheck.hide();
        // 合流させる始点は前の原文のノードなので、合流先を選ぶ途中をやめる
        endJoin();
        // 色の四角は組み直すので、カラーピッカーを閉じる
        closePicker();
        if (redraw.cause !== 'edit') {
            commands.closeInput();
            commands.closeTags();
        }
        followLegendDisplay();
        followDocument();
        showLegend();
        if (redraw.cause === 'edit') {
            commands.refreshTags();
            return;
        }
        const drawn = drawnParts(view.getDocument());
        select(mode === 'edit' ? keepDrawn(redraw.cause === 'history' ? redraw.restored : selection, drawn) : NO_SELECTION, true);
        // 元に戻す / やり直すで選び直したノードは、閉じた枝の中に隠さない (祖先を開く。図は動かさない)。
        // 閉じた枝は書き換える前のまま閉じておくので、戻したノードが見えないまま選ばれて、消せてしまわないように
        if (redraw.cause === 'history') {
            if (destroyed) return;
            refold(() => {
                for (const node of selectedNodes(selection)) view.revealNode(node.id);
            });
            return;
        }
        // 外からの差し替えと図の側の書き換え (フック) で木の形が変わると、図は開閉を文書の初めの状態に戻し、そのことを知らせない。
        // 閉じた枝に隠れた選んだノードは、枝を閉じたときと同じく選択から外す
        dropFolded();
    }

    // 文書の markdag.editor が変わったときだけ、mode の設定と default に合わせ直す
    function followDocument(): void {
        const next = documentSettings();
        if (sameEditorSettings(next, settings)) return;
        settings = next;
        rule = resolveModeRule(modeOption, settings);
        placeSegment(rule.segment);
        switchTo(rule.initial, false, false);
    }

    function focusContainer(): void {
        container.focus({ preventScroll: true });
    }

    // 選んでいるものを替える。変わったときと redraw のとき (図が印を外したとき) に見せ方を合わせ、変わったときだけアプリに知らせる。
    // 選択が変わったら (合流させる始点が変わるので) 合流先を選ぶ途中をやめ、選んでいるノードが変わったらタグのパネルを閉じる
    // (同じノードの refText と並びだけが変わったときは閉じない)。押した枠のグループ 1 つの選択でなくなったら、押した枠を忘れる
    function select(next: EditorSelection, redraw = false): void {
        if (destroyed) return;
        const changed = !sameSelection(next, selection);
        if (!changed && !redraw) return;
        const sameNodes = sameNodeSet(next, selection);
        selection = next;
        if (pressedFrame !== null && selectedGroup(selection) !== pressedFrame.group) pressedFrame = null;
        if (changed) endJoin();
        if (changed && !sameNodes) commands.closeTags();
        showSelection();
        if (changed) options.onSelectionChange?.(structuredClone(selection));
    }

    // 選んだノードの印、選んだ線とグループの強調、凡例のパネルの選んだ行、操作の帯と 2 つ以上の外枠、点、案内
    function showSelection(): void {
        view.setSelection(selectedNodes(selection).map((target) => target.id));
        commands.refreshTags();
        showLegendSelection();
        showEdge();
        showGroup();
        showHint();
        showHandles();
        showTaskCheck();
        showBar();
    }

    // 操作の帯 (1 つならノードの上、入らなければ下。2 つ以上なら全体の上。グループ 1 つなら枠の上 (押した枠を覚えていればその枠、なければ最初の枠。
    // 枠がなければメンバーの全体の上)、入らなければ下。線とグループ 2 つ以上では出さない) と、2 つ以上の外枠。
    // 名前の入力 (グループの名前も)、詳細の入力、タグのパネルを開いている間は帯を外し (外枠は出したまま)、閉じたら重ね直す
    // (隠したまま重ねておくと、出し直した最初のコマで幅 0 で測った置き場に出るため)
    function showBar(): void {
        const targets = selectedNodes(selection);
        const ids = targets.map((target) => target.id);
        const first = targets[0];
        const group = mode === 'edit' ? selectedGroup(selection) : null;
        const covered = commands.inputKind !== null;
        if (group !== null) {
            detachBounds?.();
            detachBounds = null;
            if (covered) {
                removeBar();
                return;
            }
            bar.show({ for: 'group', label: groupLabel(group) });
            const frame = pressedFrame?.group === group ? pressedFrame.frame : null;
            attachBar(frame === null ? { group } : { group, frame }, `group:${group}:${frame ?? 0}`, BAR_GAP);
            return;
        }
        if (first === undefined) {
            hideBar();
            return;
        }
        let target: OverlayTarget;
        if (targets.length === 1) {
            target = { node: first.id };
            detachBounds?.();
            detachBounds = null;
        } else {
            target = { nodes: ids };
            detachBounds = view.attachOverlay(bounds, { target, place: 'cover' });
        }
        if (covered) {
            removeBar();
            return;
        }
        if (targets.length === 1) {
            const node = view.getDocument()?.parsed.nodes.find((item) => item.id === first.id);
            bar.show({ for: 'node', root: node?.parent === null, facts: factsOf(first), task: barTask(targets) });
        } else bar.show({ for: 'nodes', count: targets.length, task: barTask(targets) });
        // 2 つ以上のときは外枠の破線の外に離す
        attachBar(target, ids.join(','), targets.length === 1 ? BAR_GAP : BAR_GAP_AROUND_BOUNDS);
    }

    // ノードの原文の事実。同じ原文のあいだは控えを使う (帯とチェックは、選択と描き直しとポインタの移動のたびに引くため)。
    // 図と原文が合わないノードと、書き換えの入口が投げたときは null
    function factsOf(node: NodeTarget): InspectNodeResult | null {
        const current = source.source;
        if (factsSource !== current) {
            factsCache.clear();
            factsSource = current;
        }
        const key = `${node.id}\n${node.refText}`;
        const cached = factsCache.get(key);
        if (cached !== undefined) return cached;
        let facts: InspectNodeResult | null;
        try {
            facts = inspectNode(current, node);
        } catch {
            facts = null;
        }
        factsCache.set(key, facts);
        return facts;
    }

    // 帯のタスク化のボタンの状態: 選んだノードのうちタスクにできて読み取りだけのグループに入らないものに、1 つでもタスクでないものがあればタスク化、
    // 全部タスクならタスク解除。書けるノードがなければ (読み取りだけのグループのノード、タスクにできないノード、記号を外せないタスクだけなら) 無効。
    // 無効の名前は、しようとする操作 (押したときと X の断る文に合わせる。読み取りだけのグループのノードがあればそれで決め、外せないタスクならタスク解除)。
    // 2 つ以上を選んだ帯でも、ノードごとに原文を解析し直して事実を引く (同じ原文と同じノードは控えを使う)。数百個を囲んで選んでも出るまで 0.3 秒ほどなので、軽くする作りは入れない
    function barTask(nodes: readonly NodeTarget[]): BarTask {
        const lockOf = taskLocksOf(view.getDocument());
        const plan = taskPlan(nodes, factsOf, lockOf);
        if (plan !== null) return { name: plan.adding ? 'add' : 'remove', enabled: true };
        return { name: blockedAdding(nodes, factsOf, lockOf) ? 'add' : 'remove', enabled: false };
    }

    // 帯を相手の上 (入らなければ下) に重ね、左右は道具箱の右から図の右の端の手前までに収める。
    // 同じ相手には重ね直さない (図は描き直しのたびに置き直す。押している途中のボタンを動かさない)
    function attachBar(target: OverlayTarget, key: string, gap: number): void {
        if (detachBar !== null && key === barTarget) return;
        detachBar?.();
        barHold = null;
        barAnchor = { target, place: ['top', 'bottom'], gap, within: barSpan };
        detachBar = view.attachOverlay(bar.element, barAnchor);
        barTarget = key;
    }

    // 帯を左右に収める範囲 (図の領域の左上からの画面の px。編集の層は図の領域と同じ位置と大きさ)。
    // 帯を保っている間は、保つ位置にちょうど帯の幅だけの範囲 (図の側はそこへ帯をずらす)
    function barSpan(): OverlaySpan {
        const area = layer.getBoundingClientRect();
        const held = heldBarSpan(area.width);
        if (held !== null) return held;
        const left = toolbox.element.hidden ? 0 : toolbox.element.getBoundingClientRect().right - area.left;
        return { left: left + BAR_EDGE, right: area.width - BAR_EDGE };
    }

    // 帯のタスク化のボタンを押した直後に保つ範囲。押した書き換えのあとに、原文 (ほかの書き換え、X とチェック、元に戻す)、図の表示位置 (パンとズーム)、
    // 図の領域の幅、閉じた枝のどれかが変わったら、保つのをやめて null (図の側が置き直すこの呼び出しから、選んだノードの左右の中央に戻る)。
    // ほかに、選択が変わる、入力とパネルを開く、詳細の見せ方を替える、帯のタスクのボタンのほかのボタンを押すときも保つのをやめる。
    // 保つのは左右の位置だけで、上下は今までどおりノードの上か下に合わせる
    function heldBarSpan(areaWidth: number): OverlaySpan | null {
        const hold = barHold;
        if (hold === null) return null;
        const after = hold.after;
        if (after !== null && (after.source !== source.source || !sameTransform(after.transform, view.getTransform()) || after.areaWidth !== areaWidth || after.folded !== view.getFolded().join(','))) {
            barHold = null;
            return null;
        }
        return { left: hold.left, right: hold.left + bar.element.offsetWidth };
    }

    // 帯のタスク化のボタン。押した直後は、ノードの箱の幅が変わっても (□ が付くか外れる) 帯を画面の上で同じ左右の位置に保ち、
    // 押したボタンをポインタの下に残す (続けて押せば元に戻せる)。次に帯を置き直すときは選んだノードの左右の中央に戻る。
    // X キーとノードの左のチェックで替えたときは保たない (原文が変わるので、描き直しで中央に置き直す)。
    // 無効の見た目のボタンは書き換えずに理由を出すだけなので、帯の置き方を変えない
    function pressBarTask(): void {
        if (!barTask(selectedNodes(selection)).enabled) {
            taskSelected();
            return;
        }
        const area = layer.getBoundingClientRect();
        barHold = detachBar !== null && !bar.element.hidden ? { left: bar.element.getBoundingClientRect().left - area.left, after: null } : null;
        taskSelected();
        if (barHold !== null) barHold = { ...barHold, after: { source: source.source, transform: view.getTransform(), areaWidth: layer.getBoundingClientRect().width, folded: view.getFolded().join(',') } };
    }

    // 帯を保つのをやめる。帯を出していれば、図の側の次の置き直しを待たずに今の相手の左右の中央へ置き直す
    // (箱の大きさも原文も変えない操作では、図の側が置き直さないため)
    function releaseBarHold(): void {
        if (barHold === null) return;
        barHold = null;
        if (detachBar !== null && barAnchor !== null) detachBar = view.attachOverlay(bar.element, barAnchor);
    }

    function removeBar(): void {
        detachBar?.();
        detachBar = null;
        barTarget = '';
        barAnchor = null;
        barHold = null;
    }

    // 帯と 2 つ以上の外枠を外す
    function hideBar(): void {
        removeBar();
        detachBounds?.();
        detachBounds = null;
    }

    // 全体表示。GUI 編集では、道具箱と左の隅のセグメントを避けた所 (右の辺から FIT_GAP 離す) に収める (凡例のパネル、案内、通知は避けない)。
    // 閲覧では図の側の全体表示 (図の領域の全体) のまま
    function fitView(): void {
        if (mode !== 'edit') view.fit();
        else {
            const area = layer.getBoundingClientRect();
            const blockers = [toolbox.element, ...(segment !== null && segmentCorner !== null && segmentCorner.endsWith('-left') ? [segment.element] : [])];
            const right = Math.max(0, ...blockers.filter((element) => !element.hidden).map((element) => element.getBoundingClientRect().right - area.left));
            view.fit(right > 0 ? { left: right + FIT_GAP } : {});
        }
        fittedAt = view.getTransform();
    }

    // 描いている文書のグループの表示の名前 (なければグループの名前そのもの)
    function groupLabel(id: string): string {
        return view.getDocument()?.model.groups.find((group) => group.id === id)?.label ?? id;
    }

    // 描いている文書にそのグループがあるか
    function hasGroup(id: string): boolean {
        return view.getDocument()?.model.groups.some((group) => group.id === id) ?? false;
    }

    // ノードの押下。修飾キーなしはそのノードだけを選び、修飾キーつきは足す・外す (ルートは足さずに理由を知らせ、選んでいたルートは外す)。
    // 押したノードが描いている図にない (押下の受け口より先に名前を決めて描き直した) ときは、描き直した図の同じ id で同じ refText のノードを押したことにする
    // 合流先を選ぶ途中は、修飾キーによらず押したノードを合流先にする
    function pressNode(node: OutlineNode, additive: boolean): void {
        tagPress = null;
        if (!isDrawn(targetOf(node))) return;
        if (tools.joining) {
            chooseJoinTarget(targetOf(node));
            return;
        }
        if (!additive) {
            select(nodesSelection([targetOf(node)]));
            if (tools.tool === 'select') tagPress = node.id;
            return;
        }
        if (node.parent === null) {
            snackbar.show(ROOT_NOTICE, 'error');
            return;
        }
        select(toggleNode(withoutRoot(selection), targetOf(node)));
    }

    // 矩形にかかったノード (ルートを除く)。修飾キーつきは今の選択に足し、なしは置き換える
    function boxNodes(ids: number[], additive: boolean): void {
        const nodes = view.getDocument()?.parsed.nodes ?? [];
        const targets = ids.flatMap((id) => {
            const node = nodes.find((item) => item.id === id);
            return node && node.parent !== null ? [targetOf(node)] : [];
        });
        select(additive ? addNodes(withoutRoot(selection), targets) : nodesSelection(targets));
    }

    // 付け替えのドラッグで動かすノード。ルートは動かさず、描いている図にないノード (押下の受け口より先に名前を決めて描き直した) も動かさない
    function moveSource(node: OutlineNode): NodeTarget | null {
        const target = targetOf(node);
        return node.parent !== null && isDrawn(target) ? target : null;
    }

    // 付け替えのドラッグを離した。ノードの外なら案内し、動かしたノード自身の上なら何もしない。
    // ほかのノードなら付け替えの命令にする (配下は理由が出て、もとの親は何もしない。どちらも命令の結果で決まる)
    function dropNode(source: NodeTarget, id: number | null): void {
        if (destroyed || mode !== 'edit') return;
        if (id === null) {
            snackbar.show(DROP_OUTSIDE_NOTICE, 'info');
            return;
        }
        if (id === source.id) return;
        const parent = view.getDocument()?.parsed.nodes.find((node) => node.id === id);
        if (parent) commands.moveNode(source, targetOf(parent));
    }

    // 線のクリック。同じ線をもう 1 度押したら選択を解き、そうでなければその線を選ぶ (道具によらない)
    function clickEdge(edge: EdgeTarget): void {
        if (destroyed || mode !== 'edit') return;
        const current = selectedEdge(selection);
        select(current !== null && edgeKeyOf(current) === edgeKeyOf(edge) ? NO_SELECTION : edgeSelection(edge));
    }

    // 枠かラベルのクリック (frame は押した枠の番号)。選択の道具で:
    // 修飾キーつきなら、グループを選んでいれば足す・外し (2 つ以上を選べる)、そうでなければ (ノードか線を選んでいても) そのグループだけを選ぶ。
    // 修飾キーなしなら、そのグループ 1 つを選んでいるとき、覚えている枠 (なければ最初の枠) と同じ枠なら選択を解き、別の枠なら選んだまま押した枠に替える。
    // そうでなければ (2 つ以上を選んでいてその中のグループを押したときも) そのグループ 1 つを選ぶ。
    // グループ 1 つを選んだ押下は押した枠を覚える。合流先を選ぶ途中は、選択が変わるのでやめる。手のひらでは選ばず、合流先を選ぶ途中なら何もないところと同じくやめる
    function clickFrame(id: string, event: MouseEvent, frame: number): void {
        if (destroyed || mode !== 'edit') return;
        if (tools.tool !== 'select') {
            if (tools.joining) endJoin();
            return;
        }
        if (!hasGroup(id)) return;
        const additive = isAdditive(event);
        if (additive && selectedGroups(selection).length > 0) {
            select(toggleGroup(selection, id));
            return;
        }
        if (!additive && selectedGroup(selection) === id) {
            const current = pressedFrame?.group === id ? pressedFrame.frame : 0;
            if (current === frame) {
                select(NO_SELECTION);
                return;
            }
            pressedFrame = { group: id, frame };
            showSelection();
            return;
        }
        pressedFrame = { group: id, frame };
        select(groupSelection(id));
    }

    // 枠かラベルのダブルクリック (frame は押した枠の番号)。道具によらず、そのグループを選んで押した枠を覚え、その枠のラベルに名前の入力を開く
    function doubleClickFrame(id: string, frame: number): void {
        if (destroyed || mode !== 'edit' || !hasGroup(id)) return;
        pressedFrame = { group: id, frame };
        select(groupSelection(id));
        commands.renameGroup(id);
    }

    // 選んでいるノードをグループにまとめる (1 つでもまとめる)。ノードを選んでいなければ (グループや線の選択を含む) 選び方を案内する
    function groupSelected(): void {
        const nodes = mode === 'edit' ? selectedNodes(selection) : [];
        if (nodes.length === 0) snackbar.show(GROUP_IDLE_NOTICE, 'info');
        else commands.groupNodes(nodes);
    }

    // 選んでいるノードのタスク化か解除 (帯の「タスク化」/「タスク解除」と X)。ノードを選んでいなければ (グループや線の選択を含む) 選び方を案内する
    function taskSelected(): void {
        if (destroyed || mode !== 'edit') return;
        const nodes = selectedNodes(selection);
        if (nodes.length === 0) snackbar.show(TASK_PICK_NOTICE, 'info');
        else commands.toggleTaskMark(nodes);
    }

    // 何もないところのクリック。合流先を選ぶ途中ならやめ (選択は残す)、押下でタグのパネルを閉じたなら選択を残し、そうでなければ選択を解く
    function clickBlank(): void {
        const closedTags = blankClosedTags;
        blankClosedTags = false;
        if (tools.joining) endJoin();
        else if (!closedTags) select(NO_SELECTION);
    }

    // 図の領域の押下 (ノードと開閉の円の外)。何もないところの主ボタンの押下なら、タグのパネルを閉じる (選択は残す)
    function pressCanvas(blank: boolean): void {
        blankClosedTags = false;
        if (destroyed || mode !== 'edit' || !blank || commands.tagPanelKind === null) return;
        commands.closeTags();
        blankClosedTags = true;
    }

    // 選んでいるノードのタグのパネルを開く。何も選んでいなければ (グループや線の選択を含む) 選び方を案内する
    function openTagPanel(kind: TagPanelKind): void {
        if (destroyed || mode !== 'edit') return;
        if (selectedNodes(selection).length === 0) snackbar.show(TAG_PICK_NOTICE, 'info');
        else commands.openTags(kind);
    }

    // タグの要素のクリック。吹き出しのタグは押下の受け口を通らないので、ここでノードの押下と同じく選ぶ。
    // 選択の道具で修飾キーなしにそのノードだけを選んだ押下なら、押したタグの編集を開く (手のひら、修飾キー、合流先を選ぶ途中は選ぶだけ)
    function clickTag(node: OutlineNode, key: string, place: 'node' | 'popover', event: MouseEvent): void {
        if (destroyed || mode !== 'edit') return;
        if (place === 'popover') pressNode(node, isAdditive(event));
        const pressed = tagPress;
        tagPress = null;
        if (pressed !== node.id || !isDrawn(targetOf(node))) return;
        commands.editTag(targetOf(node), key);
    }

    // 点の押下。選択の道具で、点に合う数のノードを選んでいるときだけドラッグを始める
    function pressHandle(kind: DragHandleKind, event: PointerEvent): void {
        if (destroyed || mode !== 'edit' || !tools.selectDrag) return;
        const nodes = selectedNodes(selection);
        if (kind === 'link' ? nodes.length !== 1 : nodes.length < 2) return;
        pointer.beginLink(event, nodes);
    }

    // + のクリック。選択の道具でノードを 1 つだけ選んでいるときだけ、そのノードに子か兄弟を足して名前の入力を開く (帯の子と兄弟と同じ命令)。
    // 足せなければ理由が出て、フォーカスは図の要素へ戻す
    function pressPlus(kind: PlusHandleKind): void {
        if (destroyed || mode !== 'edit' || tools.state !== 'select') return;
        const node = singleNode();
        if (node === null) return;
        commands.add(kind, node);
        returnFocus();
    }

    // ノードの左のチェックの押下。選択の道具のときだけ、そのノード 1 つをタスクにする (選んでいるものは変えない)。フォーカスは図の要素へ戻す
    function pressTaskCheck(id: number): void {
        if (destroyed || mode !== 'edit' || tools.state !== 'select') return;
        const node = view.getDocument()?.parsed.nodes.find((item) => item.id === id);
        if (node) commands.markTask(targetOf(node));
        returnFocus();
    }

    // ノードの左のチェック。点と + と同じとき (GUI 編集の選択の道具で、入力とパネルを開いていない) に、ノードを 1 つだけ選んでいて、
    // そのノード 1 つのねらいがタスク化 (タスクにできてまだタスクでなく、読み取りだけのグループに入らない。押したときの命令の部品と同じ決まり) なら、
    // そのノードの左に出す。Space を押している間 (図を動かす途中) とドラッグの途中も、点と + と同じく出したまま
    function showTaskCheck(): void {
        const node = mode === 'edit' && tools.state === 'select' && commands.inputKind === null ? singleNode() : null;
        if (node !== null && taskPlan([node], factsOf, taskLocksOf(view.getDocument()))?.adding === true) taskCheck.show(node.id);
        else taskCheck.hide();
    }

    // 点のドラッグを離した。ノードの外なら案内する。始点が 1 つなら離したノードへ線を引き (同じノードは理由が出る)、
    // 2 つ以上なら離したノードへ合流させる (始点のノードは合流先にしない)
    function linkTo(sources: readonly NodeTarget[], id: number | null): void {
        if (destroyed || mode !== 'edit') return;
        const joining = sources.length > 1;
        if (id === null) {
            snackbar.show(joining ? JOIN_OUTSIDE_NOTICE : LINK_OUTSIDE_NOTICE, 'info');
            return;
        }
        const node = view.getDocument()?.parsed.nodes.find((item) => item.id === id);
        if (!node) return;
        const [from] = sources;
        if (!joining) {
            if (from !== undefined) commands.addRelation(from, targetOf(node));
            return;
        }
        if (sources.some((source) => source.id === id)) {
            snackbar.show(JOIN_SOURCE_NOTICE, 'info');
            return;
        }
        commands.joinInto(sources, targetOf(node));
    }

    // 選んでいる 2 つ以上のノードを始点にして、合流先を選ぶ途中にする
    function startJoin(): void {
        const nodes = selectedNodes(selection);
        if (nodes.length < 2) return;
        joinSources = nodes;
        tools.startJoin();
    }

    // 合流先を選ぶ途中をやめて、もとの道具に戻す
    function endJoin(): void {
        joinSources = [];
        tools.endJoin();
    }

    // 合流先を選ぶ途中にノードを押した。始点のノードなら知らせて途中を続け、そうでなければもとの道具に戻してから合流させる
    // (断られたら理由が出て、始点を選んだまま)
    function chooseJoinTarget(target: NodeTarget): void {
        const sources = joinSources;
        if (sources.some((source) => source.id === target.id)) {
            snackbar.show(JOIN_SOURCE_NOTICE, 'info');
            return;
        }
        endJoin();
        commands.joinInto(sources, target);
    }

    // 選んでいる 2 つ以上のノードから新しいノードへ合流させる。2 つ未満なら何もせず false
    function joinNew(): boolean {
        const nodes = mode === 'edit' ? selectedNodes(selection) : [];
        if (nodes.length < 2) return false;
        commands.joinIntoNew(nodes);
        return true;
    }

    // 選んでいるノードを配下ごと消す (2 つ以上でも 1 回の書き換え)。何も選んでいなければ何もしない
    function deleteSelected(): void {
        const nodes = mode === 'edit' ? selectedNodes(selection) : [];
        if (nodes.length > 0) commands.deleteNodes(nodes);
    }

    // ノードの文字のダブルクリックは、そのノードだけを選んで名前の入力を開く。ノードの中に開いた詳細と吹き出しの詳細のダブルクリックは、
    // そのノードだけを選んで詳細の入力を開く (道具によらない)
    function doubleClickNode(node: OutlineNode, place: 'label' | 'details' | 'popover'): void {
        if (destroyed || mode !== 'edit') return;
        const target = targetOf(node);
        if (!isDrawn(target)) return;
        select(nodesSelection([target]));
        if (place === 'label') commands.rename(target);
        else commands.openDetails(target);
    }

    // D。ノードを 1 つだけ選んでいれば詳細の入力を開き (書けないノードは理由が出る)、そうでなければ (何も選んでいない、2 つ以上、グループ、線) 案内を出す
    function editDetails(): void {
        const node = singleNode();
        if (node === null) snackbar.show(DETAILS_PICK_NOTICE, 'info');
        else commands.openDetails(node);
    }

    // 詳細表示の選択肢で見せ方を選んだ (選択肢は道具箱が閉じる)。GUI 編集の間の図の詳細の見せ方にし、フォーカスを図の要素へ戻す
    function chooseDetailsMode(next: DisplayMode): void {
        if (destroyed || mode !== 'edit') return;
        detailsChoice = next;
        toolbox.showDetailsMode(next);
        applyViewOptions();
        focusContainer();
    }

    // 描いている図に、同じ id で同じ refText のノードがあるか
    function isDrawn(target: { id: number; refText: string }): boolean {
        return view.getDocument()?.parsed.nodes.some((node) => node.id === target.id && node.refText === target.refText) ?? false;
    }

    // 選んでいるノードが 1 つならそのノード
    function singleNode(): NodeTarget | null {
        const nodes = selectedNodes(selection);
        return nodes.length === 1 ? (nodes[0] ?? null) : null;
    }

    // 選択からルートを外す (ルートは複数の選択に入れない)
    function withoutRoot(current: EditorSelection): EditorSelection {
        const nodes = view.getDocument()?.parsed.nodes ?? [];
        return nodesSelection(selectedNodes(current).filter((target) => nodes.find((node) => node.id === target.id)?.parent !== null));
    }

    // 矢印キー。何も選んでいなければカーソルにいちばん近いノード (カーソルがウィンドウの外ならルート) を選ぶ。
    // 選んでいれば最後に選んだノードから動き、1 つの選択にする。動く前に、選んだノードが閉じた枝の中なら開き (閉じた枝に隠れた選んだノードは
    // 選択から外すので、ふつうは開くものはない)、→ ではそのノードの枝も開く。
    // 並びは動き終えたあとの位置で決め、選んだノードが図の領域の外なら見える所まで動かす
    function moveSelection(key: ArrowKey): void {
        const nodes = view.getDocument()?.parsed.nodes;
        if (!nodes) return;
        const from = lastSelectedNode(selection);
        let next: number | null;
        if (from === null) {
            next = startNode(pointerInArea(), nodes, view.nodeRects());
        } else {
            view.revealNode(from.id);
            if (key === 'ArrowRight' && view.getFolded().includes(from.id)) view.setFolded(view.getFolded().filter((id) => id !== from.id));
            next = arrowTarget(key, from.id, nodes, view.nodeRects(undefined, { settled: true }));
        }
        const node = next === null ? undefined : nodes.find((item) => item.id === next);
        if (!node) return;
        select(nodesSelection([targetOf(node)]));
        view.ensureVisible(node.id);
    }

    // 最後のポインタの位置を、図の領域の左上からの座標にする (編集の層は図の領域と同じ位置と大きさ)
    function pointerInArea(): Point | null {
        if (pointerAt === null) return null;
        const origin = layer.getBoundingClientRect();
        return { x: pointerAt.x - origin.left, y: pointerAt.y - origin.top };
    }

    // 操作の帯のボタン。名前、子の追加、兄弟追加、詳細編集は選んだノード (1 つ) に、削除、合流、グループ、タグ追加、タグ選択、タスク化は選んだノードの全部に、
    // グループの名前とグループ解除は選んだグループに当てる。
    // 合流先を選ぶ途中なら、やめてからボタンの操作をする。名前の入力か詳細の入力かタグのパネルを開いたらフォーカスはその中に置き、そうでなければ図の要素へ戻す
    function pressBar(command: BarCommand): void {
        if (destroyed) return;
        // タスクのボタンのほかは (これから足すボタンも)、押したら必ず帯を保つのをやめる
        if (command !== 'task') releaseBarHold();
        endJoin();
        const node = mode === 'edit' ? singleNode() : null;
        const group = mode === 'edit' ? selectedGroup(selection) : null;
        if (command === 'delete') deleteSelected();
        else if (command === 'join-new') joinNew();
        else if (command === 'join-existing') {
            if (mode === 'edit') startJoin();
        } else if (command === 'group') groupSelected();
        else if (command === 'rename-group' || command === 'ungroup') {
            if (group !== null) {
                if (command === 'rename-group') commands.renameGroup(group);
                else commands.ungroup(group);
            }
        } else if (command === 'tag-add' || command === 'tag-select') openTagPanel(command === 'tag-add' ? 'add' : 'select');
        else if (command === 'task') pressBarTask();
        else if (node !== null) {
            if (command === 'rename') commands.rename(node);
            else if (command === 'child' || command === 'sibling') commands.add(command, node);
            else if (command === 'details') commands.openDetails(node);
        }
        returnFocus();
    }

    // 道具箱のボタン。合流先を選ぶ途中なら、やめてからボタンの操作をする。合流は 2 つ以上を選んでいれば新しいノードへ合流させ、
    // グループはノードを選んでいればまとめ、タグ追加とタグ選択はノードを選んでいればタグのパネルを開き、そうでなければ選び方を案内する。
    // 詳細表示は選択肢の開閉だけ (道具箱が受け持つ)。元に戻すとやり直すは、タグのパネルを閉じてから行う。
    // 押したあとはフォーカスを図の要素へ戻す (ボタンにフォーカスの枠を残さない。名前の入力を開いたら入力に、タグのパネルが開いていればパネルの欄に置く)
    function pressToolbox(item: ToolboxItem): void {
        if (destroyed || mode !== 'edit') return;
        endJoin();
        if (item === 'hand' || item === 'select') tools.pick(item);
        else if (item === 'undo' || item === 'redo') travel(item);
        else if (item === 'fit') fitView();
        else if (item === 'group') groupSelected();
        else if (item === 'tag-add' || item === 'tag-select') openTagPanel(item === 'tag-add' ? 'add' : 'select');
        else if (item !== 'details' && (item !== 'join' || !joinNew())) {
            const notice = IDLE_NOTICES[item];
            if (notice) snackbar.show(notice, 'info');
        }
        returnFocus();
    }

    // キーを受けるか。フォーカスが図の要素の中にあるか、フォーカスがどこにもなく (body か null) 最後のポインタの位置が図の上にあるとき
    function ownsKeys(): boolean {
        const active = document.activeElement;
        if (active === null || active === document.body) return pointerOnContainer;
        return container.contains(active);
    }

    function keyDown(event: KeyboardEvent): void {
        // Space を押している間にほかのキーを押したら、Space を離してもタスクの印を進めない (どこに向けたキーでも)
        if (event.key !== ' ') tools.interruptSpace();
        // 変換中 (IME) のキーは何にも使わない。タグのパネルの中のキーはパネルのもの
        if (destroyed || isComposingKey(event) || !ownsKeys() || commands.tagPanelContains(event.target)) return;
        // 閲覧はキーの操作を切る。削除になるキーは既定の動きだけを止める (文字を打つ要素の上を除く)
        if (mode !== 'edit') {
            if (commandForKey(event, keyPlatform) === 'delete' && !isTextEntry(event.target)) event.preventDefault();
            return;
        }
        // カラーピッカーか詳細表示の選択肢を開いている間の Esc は、それを閉じるだけ (選択を解かない)
        if (event.key === 'Escape' && (picker.isOpen || toolbox.flyoutOpen)) {
            event.preventDefault();
            closePicker();
            toolbox.closeFlyout();
            return;
        }
        if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
            // ボタンと文字を打つ要素の Space はその要素のもの (押す、空白を打つ)
            if (event.target instanceof HTMLButtonElement || isTextEntry(event.target)) return;
            // ページをスクロールさせない。押している間はパンし、ほかを押さずに離したらタスクの印を進める (keyUp。Shift つきは進めない)
            event.preventDefault();
            tools.holdSpace(event);
            // ポインタを押したまま (ドラッグや矩形選択の途中) 押した Space は、離してもタスクの印を進めない
            if (pointerHeld) tools.interruptSpace();
            return;
        }
        // 矩形選択の途中の Esc は、修飾キー (⌘、Ctrl など) を押していても矩形をやめる (表では命令にならない組み合わせも受ける)
        const command = event.key === 'Escape' && pointer.marqueeing ? 'cancel' : commandForKey(event, keyPlatform);
        if (command === null || isTextEntry(event.target)) return;
        if (NODE_KEY_COMMANDS.has(command)) {
            // ボタンの Enter (押す) と Tab / Shift+Tab (フォーカスの移動) はボタンのもの。ノードを 1 つ選んでいるときだけ受ける。
            // グループを選んでいるときは Enter だけを受けて、グループの名前の入力を開く
            if (event.target instanceof HTMLButtonElement) return;
            const group = selectedGroup(selection);
            if (group !== null && command === 'rename') {
                event.preventDefault();
                commands.renameGroup(group);
                return;
            }
            const node = singleNode();
            if (node === null) {
                // 何かを選んでいる (ノード 1 つ以外: 2 つ以上、グループ、線、合流先を選ぶ途中) ときの Tab と Shift+Tab は、何もせず、
                // フォーカスも図の外へ動かさない。ノードを 2 つ以上選んでいる (合流先を選ぶ途中を含む) ときは、Enter と修飾キーつきの
                // Enter も何もせず、既定の動きを止める (選択中のキーをブラウザに流さない)。何も選んでいないときはブラウザの既定のまま。
                // グループと線を選んでいるときの Shift+Enter と修飾キーつきの Enter は、既定の動きを止めない
                const tabs = command === 'add-child' || command === 'rename-parent';
                if ((tabs && selection.kind !== 'none') || selectedNodes(selection).length > 1) event.preventDefault();
                return;
            }
            event.preventDefault();
            if (command === 'rename') commands.rename(node);
            else if (command === 'add-child') commands.add('child', node);
            else if (command === 'add-sibling') commands.add('sibling', node);
            else if (command === 'add-sibling-before') commands.add('sibling-before', node);
            else if (command === 'rename-parent') commands.renameToward('parent', node);
            else if (command === 'rename-previous') commands.renameToward('previous', node);
            else if (command === 'rename-next') commands.renameToward('next', node);
            return;
        }
        // 矢印キーでページをスクロールさせない。⌘G / Ctrl+G ではブラウザの検索を出さない
        event.preventDefault();
        // キーの操作のあとに、道具箱と帯のボタンにフォーカスの枠を残さない (帯は選択が変わると組み直すので、操作の前に見ておく)
        const active = document.activeElement;
        const onButton = active instanceof Node && (toolbox.element.contains(active) || bar.element.contains(active));
        if (command === 'undo' || command === 'redo') travel(command);
        // 付け替えと線と矩形選択のドラッグの途中の Esc はドラッグをやめるだけ (選択は解かない)。合流先を選ぶ途中なら、やめて選択も解く。
        // タグのパネルを開いているなら、パネルを閉じるだけ (選択は解かない)
        else if (command === 'cancel') {
            if (!pointer.cancelDrag()) {
                endJoin();
                if (commands.tagPanelKind !== null) commands.closeTags(true);
                else select(NO_SELECTION);
            }
        } else if (command === 'hand' || command === 'select') {
            // 合流先を選ぶ途中ならやめてから替える。Space の押下は保つ (押している間のパンは続く)
            endJoin();
            tools.pick(command);
        } else if (command === 'delete') deleteSelected();
        else if (command === 'details') editDetails();
        else if (command === 'tag-add') openTagPanel('add');
        // ドラッグの途中と合流先を選ぶ途中の X は受けない (どちらも続ける。D と T は受ける)
        else if (command === 'task') {
            if (!pointer.dragging && !tools.joining) taskSelected();
        } else if (command === 'join') {
            if (!joinNew()) snackbar.show(JOIN_FEW_NOTICE, 'error');
        } else if (command === 'group') groupSelected();
        else if (command === 'ArrowLeft' || command === 'ArrowRight' || command === 'ArrowUp' || command === 'ArrowDown') moveSelection(command);
        // 名前の入力か詳細の入力かタグのパネルを開いたら、フォーカスはその中に置いたままにする
        if (onButton) returnFocus();
    }

    // Space を離したら、どこで離しても (ポインタが図の外へ出ていても) パンをやめる。押してから、ポインタもほかのキーも押さずに離したら、
    // 選んだノードのうちタスクのものの印を進める
    function keyUp(event: KeyboardEvent): void {
        if (event.key !== ' ' || destroyed) return;
        if (tools.releaseSpace() && mode === 'edit') toggleSelectedTasks();
    }

    // 選んだノードのうち、描いている図に同じ id と refText で残るタスクのものの印を、図の側の口でまとめて 1 つ進める
    // (印のクリックと同じ確かめを relations の上流から当て、断られたらそこでやめて何も変えない。理由はアプリの onDiagnostic に出る)。
    // タスクを選んでいなければ何もしない
    function toggleSelectedTasks(): void {
        const nodes = view.getDocument()?.parsed.nodes ?? [];
        const ids = selectedNodes(selection).flatMap((target) => (nodes.some((node) => node.id === target.id && node.refText === target.refText && node.task !== null) ? [target.id] : []));
        if (ids.length > 0) diagram.toggleTasks(ids);
    }

    function listenInput(signal: AbortSignal): void {
        document.addEventListener('keydown', keyDown, { signal });
        document.addEventListener('keyup', keyUp, { signal });
        // ウィンドウのフォーカスが外れたら、Space を離したことにする (離したときの keyup が届かないため)
        window.addEventListener(
            'blur',
            (event) => {
                if (event.target === window) tools.releaseSpace();
            },
            { signal },
        );
        for (const type of ['pointermove', 'pointerdown'] as const) {
            document.addEventListener(
                type,
                (event) => {
                    pointerOnContainer = event.target instanceof Node && container.contains(event.target);
                    pointerAt = { x: event.clientX, y: event.clientY };
                },
                { capture: true, signal },
            );
        }
        // Space を押している間にポインタを押したら (Space+ドラッグのパンを含む)、離してもタスクの印を進めない
        document.addEventListener('pointerdown', () => tools.interruptSpace(), { capture: true, signal });
        // ボタンを離した所がウィンドウの外で pointerup が届かなくても、次にポインタが動いたときの buttons で戻る
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
            document.addEventListener(
                type,
                (event) => {
                    pointerHeld = type !== 'pointercancel' && event.buttons !== 0;
                },
                { capture: true, signal },
            );
        }
        // ポインタがウィンドウの外へ出た (行き先の要素がない)。指は離すたびに出ていくので数えない
        document.addEventListener(
            'pointerout',
            (event) => {
                if (event.relatedTarget === null && event.pointerType !== 'touch') pointerAt = null;
            },
            { capture: true, signal },
        );
        // カラーピッカーの外 (開いた色の四角を除く) と、詳細表示の選択肢の外 (開くボタンを除く) を押したら閉じる。ページの図の外の押下も同じ
        document.addEventListener(
            'pointerdown',
            (event) => {
                if (picker.isOpen && !picker.contains(event.target) && !picker.isAnchor(event.target)) closePicker();
                if (toolbox.flyoutOpen && !toolbox.flyoutContains(event.target)) toolbox.closeFlyout();
            },
            { capture: true, signal },
        );
        // 名前の入力か詳細の入力の外を主ボタンで押したら、押したものの操作 (選択、帯のボタン、セグメントなど) より先に、入れたもので決める。
        // ページのほかの所 (原文の欄など) にフォーカスが残ったまま図を押したら、フォーカスを図へ移す (キーがほかの所に入らないように)
        container.addEventListener(
            'pointerdown',
            (event) => {
                if (event.button === 0 && commands.isInputOpen && !commands.contains(event.target)) commands.commitInput('leave');
                const active = document.activeElement;
                if (!(active instanceof Node && container.contains(active))) focusContainer();
            },
            { capture: true, signal },
        );
    }

    return {
        get view() {
            return view;
        },
        get diagnostics() {
            return source.diagnostics;
        },
        getSource: () => source.source,
        setSource: (next) => (destroyed ? source.diagnostics : source.replace(next)),
        getMode: () => mode,
        getSelection: () => structuredClone(selection),
        setMode: (next) => {
            if (destroyed || rule.setting !== 'switch' || (next !== 'view' && next !== 'edit')) return false;
            switchTo(next, false, true);
            return true;
        },
        undo: () => !destroyed && travel('undo'),
        redo: () => !destroyed && travel('redo'),
        setTheme: (theme) => {
            if (!destroyed) view.setOptions({ theme });
        },
        fit: () => {
            if (!destroyed) fitView();
        },
        destroy: () => {
            if (destroyed) return;
            // 開いている名前の入力と詳細の入力を保存せずに閉じる
            commands.destroy();
            picker.close();
            toolbox.closeFlyout();
            // ここから先はアプリの受け口の包みも、原文の変更の知らせも止まる
            destroyed = true;
            // 通知の待ちと、document、window、図の要素に付けた受け口 (矩形選択の途中を含む) を外す
            snackbar.destroy();
            teardown.abort();
            // 図に足した受け口と、重ねた帯と外枠と点と、選択の印を外す
            removeHooks();
            detachBar?.();
            detachBounds?.();
            handles.hide();
            taskCheck.hide();
            barTarget = '';
            view.setSelection([]);
            // 編集の層の要素と、図の要素に付けた目印と tabindex を外す
            segment = null;
            segmentCorner = null;
            legendCorner = null;
            layer.remove();
            container.removeAttribute('data-editor-mode');
            container.removeAttribute('data-editor-tool');
            if (addedTabIndex) container.removeAttribute('tabindex');
            // 最後の原文と診断を控えてから図を片付ける
            source.release();
            diagram.destroy();
        },
    };
}

// 図の側から Markdown を書き換える試作のエディタ (ホワイトボード風)。
// 左に原文、右に markdag の図を置き、図の上の操作 (ノードの追加、削除、名前の変更、ドラッグでの付け替え、線の追加と削除) を
// editor/ops.ts の書き換えで原文に反映して描き直す。原文を直接書き換えても図が追う。
import notationSample from '../docs/examples/notation.md?raw';
import groupsCross from './samples/groups-cross.md?raw';
import groupsLeavesColors from './samples/groups-leaves-colors.md?raw';
import groupsNested from './samples/groups-nested.md?raw';
import groupsPhases from './samples/groups-phases.md?raw';
import groupsSiblings from './samples/groups-siblings.md?raw';
import dagCrossTeam from './samples/dag-cross-team.md?raw';
import dagDiamond from './samples/dag-diamond.md?raw';
import dagEpic from './samples/dag-epic.md?raw';
import dagRunbookDb from './samples/dag-runbook-db.md?raw';
import dagRunbookK8s from './samples/dag-runbook-k8s.md?raw';
import hugeOrg from './samples/huge-org.md?raw';
import hugePortfolio from './samples/huge-portfolio.md?raw';
import hugeRegions from './samples/huge-regions.md?raw';
import { buildModel, formatDiagnostics, init, parseDocument, render, type Diagnostic, type MarkdagDiagram, type OutlineNode } from '../src/core';
import styleText from './editor.css?inline';
import * as ops from './ops';
import { wasmSource } from './wasm-source';

const SIMPLE_SAMPLE = `---
markdag:
    relations:
        depends:
            - 調査 --> 設計
            - 実装 --> テスト
    groups:
        dev:
            label: 開発
            color: "#3B7DD8"
            boundary: true
        test:
            label: テスト
            color: "#E0A100"
            boundary: true
---

# 企画

## 調査
- ユーザーインタビュー
- 競合の比較

## 設計
- 画面
- API

## 実装 %dev
- フロントエンド
- バックエンド

## テスト %test
- 単体テスト
- 結合テスト
`;

const EMPTY_SAMPLE = `# 新しいボード
`;

const SAMPLES: Record<string, { label: string; text: string }> = {
    simple: { label: '小さな例', text: SIMPLE_SAMPLE },
    notation: { label: '記法の例 (notation.md)', text: notationSample },
    groupsNested: { label: 'グループ 1: 入れ子の枠', text: groupsNested },
    groupsSiblings: { label: 'グループ 2: 隣り合う兄弟だけの枠', text: groupsSiblings },
    groupsCross: { label: 'グループ 3: 枝をまたぐグループ', text: groupsCross },
    groupsPhases: { label: 'グループ 4: 工程の枠を chain でつなぐ', text: groupsPhases },
    groupsLeavesColors: { label: 'グループ 5: 葉だけの指定と色だけのグループ', text: groupsLeavesColors },
    dagEpic: { label: 'DAG 1: エピックの企画からリリースまで', text: dagEpic },
    dagDiamond: { label: 'DAG 2: 広げて絞る (全社 SSO 移行)', text: dagDiamond },
    dagRunbookDb: { label: 'DAG 3: 手順書 DB アップグレード', text: dagRunbookDb },
    dagCrossTeam: { label: 'DAG 4: 複数チームの依存 (アプリ刷新)', text: dagCrossTeam },
    dagRunbookK8s: { label: 'DAG 5: 手順書 Kubernetes 移行', text: dagRunbookK8s },
    hugeOrg: { label: '超大規模 1: 部門 > チーム > 機能 (239 ノード)', text: hugeOrg },
    hugeRegions: { label: '超大規模 2: リージョン > 層 > 部品の手順書 (265 ノード)', text: hugeRegions },
    hugePortfolio: { label: '超大規模 3: 事業部 > プロダクト > エピック (231 ノード)', text: hugePortfolio },
    empty: { label: '空のボード', text: EMPTY_SAMPLE },
};

// join は「既存のノードへ合流」で、合流先のノードを選んでいるところ
// pan は手のひら。ドラッグで図を動かす (選ぶ道具でも Space を押している間と中ボタンのドラッグは動かす)
type Tool = 'select' | 'pan' | 'connect' | 'join';
// nodes は範囲選択 (何もないところからのドラッグ) か Shift / Ctrl / ⌘ クリックで 2 つ以上選んだとき (選んだ順)
// group はグループの枠 (またはそのラベル) を押したとき。id は markdag.groups のキー
type Selection = { type: 'node'; id: number } | { type: 'nodes'; ids: number[] } | { type: 'edge'; key: string } | { type: 'group'; id: string } | null;

// ショートカットの表記 (Mac は ⌘、それ以外は Ctrl)
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const ICONS = {
    select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z"/></svg>',
    pan: '<svg viewBox="0 0 24 24"><path d="M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L3.5 13a1.5 1.5 0 012.3-1.9L8 13"/></svg>',
    connect: '<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><path d="M7 17C12 16 12 8 17 7"/><path d="M14 5l3 2-2 3"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12h-2" transform="translate(0 -6)"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12h2" transform="translate(0 -6)"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    child: '<svg viewBox="0 0 24 24"><path d="M4 6h6M10 6v12h4M10 12h4"/><rect x="15" y="10" width="5" height="4" rx="1"/><rect x="15" y="16" width="5" height="4" rx="1"/></svg>',
    sibling: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="6" rx="1.5"/><path d="M12 13v7M8.5 16.5h7"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/></svg>',
    reverse: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>',
    group: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2" stroke-dasharray="3 2.5"/><rect x="6.5" y="9" width="6" height="4" rx="1"/><rect x="11.5" y="14" width="6" height="3.5" rx="1"/></svg>',
    ungroup: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2" stroke-dasharray="3 2.5"/><path d="M8 9l8 7M16 9l-8 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    tag: '<svg viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/><path d="M15 3v4M13 5h4"/></svg>',
    tags: '<svg viewBox="0 0 24 24"><path d="M3 11V4h7l9 9-7 7z"/><circle cx="7" cy="8" r="1.3"/><path d="M13 4l9 9-6 6"/></svg>',
    note: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    join: '<svg viewBox="0 0 24 24"><path d="M3 5c6 0 7 7 12 7M3 19c6 0 7-7 12-7M3 12h12"/><path d="M15 9l4 3-4 3"/><circle cx="20.5" cy="12" r="1.2"/></svg>',
    merge: '<svg viewBox="0 0 24 24"><path d="M3 5c6 0 7 7 12 7M3 19c6 0 7-7 12-7"/><rect x="15" y="9" width="6" height="6" rx="1.5"/></svg>',
};

// ---- 画面の組み立て ----------------------------------------------------------------------------------------------

const style = document.createElement('style');
style.textContent = styleText;
document.head.append(style);

const app = document.getElementById('app') ?? document.body;
app.innerHTML = `
<div class="ed-app">
    <header class="ed-top">
        <div class="ed-brand">markdag Board<small>図を触ると Markdown が書き換わる試作</small></div>
        <select class="ed-sample" aria-label="サンプル"></select>
        <div class="ed-spacer"></div>
        <button class="ed-btn ed-toggle-md" aria-pressed="true" title="原文の欄を出す / 隠す">Markdown</button>
        <button class="ed-btn ed-copy" title="原文をクリップボードへ">コピー</button>
        <button class="ed-btn ed-download" title="原文を .md で保存">保存</button>
        <button class="ed-btn ed-theme" title="明暗の切り替え">ライト</button>
    </header>
    <main class="ed-main" data-md="shown">
        <section class="ed-side">
            <div class="ed-side-head"><span>MARKDOWN</span><span class="ed-lines"></span></div>
            <div class="ed-md"><div class="ed-mirror" aria-hidden="true"></div><textarea spellcheck="false" wrap="off" aria-label="Markdown の原文"></textarea></div>
            <div class="ed-diag"></div>
        </section>
        <section class="ed-stage" data-tool="select">
            <div class="ed-canvas-host"></div>
            <div class="ed-overlay">
                <svg class="ed-wire" style="display:none"><path/><circle r="4"/></svg>
                <div class="ed-target" hidden></div>
                <div class="ed-sel" hidden></div>
                <div class="ed-multi"></div>
                <div class="ed-group-box" hidden></div>
                <div class="ed-marquee" hidden></div>
                <div class="ed-handle ed-handle-connect" title="ドラッグしてほかのノードへ線を引く" hidden></div>
                <div class="ed-handle ed-handle-add ed-handle-child" title="子を足す (Tab)" hidden>+</div>
                <div class="ed-handle ed-handle-add ed-handle-sibling" title="兄弟を足す (Enter)" hidden>+</div>
                <div class="ed-ctx" hidden></div>
                <div class="ed-tag-panel" hidden></div>
                <div class="ed-details-editor" hidden>
                    <div class="ed-details-head"><span>詳細</span><b></b></div>
                    <textarea spellcheck="false" rows="6" placeholder="詳細を書く (Markdown が使える)"></textarea>
                    <div class="ed-details-foot"><span></span><button class="ed-details-cancel">やめる</button><button class="ed-details-save">保存</button></div>
                </div>
            </div>
            <nav class="ed-tools" aria-label="道具">
                <button class="ed-tool" data-tool="select" title="選ぶ・動かす (V)。何もないところからドラッグで範囲選択">${ICONS.select}<span>選択</span></button>
                <button class="ed-tool" data-tool="pan" title="図を動かす (H)。選択でも Space を押しながらドラッグで動かせる">${ICONS.pan}<span>パン</span></button>
                <button class="ed-tool ed-join-tool" title="選んだノードを合流させる (J)。何もないところからドラッグして、2 つ以上を囲んで選んでから">${ICONS.join}<span>合流</span></button>
                <button class="ed-tool ed-group-tool" title="選んだノードをグループにまとめる (${MOD}G)。何もないところからドラッグして囲んで選んでから">${ICONS.group}<span>グループ</span></button>
                <button class="ed-tool ed-tag-new-tool" title="選んだノードにタグを付ける (T)。キーと値を入れる">${ICONS.tag}<span>タグ追加</span></button>
                <button class="ed-tool ed-tag-pick-tool" title="選んだノードに、使っているタグから選んで付ける">${ICONS.tags}<span>タグ選択</span></button>
                <div class="ed-details-mode">
                    <button class="ed-tool ed-details-tool" title="詳細の見せ方を選ぶ" aria-haspopup="menu" aria-expanded="false">${ICONS.eye}<span>詳細表示</span></button>
                    <div class="ed-flyout" role="menu" hidden>
                        <div class="ed-flyout-title">詳細の見せ方</div>
                        <button role="menuitemradio" data-mode="always">常に表示<small>ノードの中に開いて出す</small></button>
                        <button role="menuitemradio" data-mode="hover">ホバー時に表示<small>ノードに重ねると吹き出しで出す</small></button>
                        <button role="menuitemradio" data-mode="click">隠す<small>i を押したときだけ出す</small></button>
                    </div>
                </div>
                <hr>
                <button class="ed-tool ed-undo" title="元に戻す (Ctrl+Z)">${ICONS.undo}<span>戻る</span></button>
                <button class="ed-tool ed-redo" title="やり直す (Ctrl+Shift+Z)">${ICONS.redo}<span>進む</span></button>
                <button class="ed-tool ed-fit" title="全体が収まる倍率に戻す (F)">${ICONS.fit}<span>ズームリセット</span></button>
            </nav>
            <div class="ed-groups"></div>
            <div class="ed-hint"></div>
            <div class="ed-toast" hidden></div>
        </section>
    </main>
</div>`;

const $ = <T extends Element>(selector: string): T => {
    const found = app.querySelector<T>(selector);
    if (!found) throw new Error(`${selector} がない`);
    return found;
};
const main = $<HTMLElement>('.ed-main');
const stage = $<HTMLElement>('.ed-stage');
const host = $<HTMLDivElement>('.ed-canvas-host');
const textarea = $<HTMLTextAreaElement>('.ed-md textarea');
const mirror = $<HTMLDivElement>('.ed-mirror');
const diagBox = $<HTMLDivElement>('.ed-diag');
const linesLabel = $<HTMLSpanElement>('.ed-lines');
const selFrame = $<HTMLDivElement>('.ed-sel');
const multiLayer = $<HTMLDivElement>('.ed-multi');
const marqueeBox = $<HTMLDivElement>('.ed-marquee');
const groupBox = $<HTMLDivElement>('.ed-group-box');
const targetFrame = $<HTMLDivElement>('.ed-target');
const connectHandle = $<HTMLDivElement>('.ed-handle-connect');
const childHandle = $<HTMLDivElement>('.ed-handle-child');
const siblingHandle = $<HTMLDivElement>('.ed-handle-sibling');
const ctxBar = $<HTMLDivElement>('.ed-ctx');
const wire = $<SVGSVGElement>('.ed-wire');
const hint = $<HTMLDivElement>('.ed-hint');
const toast = $<HTMLDivElement>('.ed-toast');
const sampleSelect = $<HTMLSelectElement>('.ed-sample');
const undoButton = $<HTMLButtonElement>('.ed-undo');
const redoButton = $<HTMLButtonElement>('.ed-redo');
const themeButton = $<HTMLButtonElement>('.ed-theme');

for (const [key, sample] of Object.entries(SAMPLES)) sampleSelect.add(new Option(sample.label, key));

// ---- 状態 --------------------------------------------------------------------------------------------------------

let source = SIMPLE_SAMPLE;
let ctx: ops.EditContext;
let diagram: MarkdagDiagram;
let selection: Selection = null;
let tool: Tool = 'select';
let theme: 'dark' | 'light' = 'dark';
const undoStack: string[] = [];
const redoStack: string[] = [];
// 線を引く道具で、1 回目のクリックで選んだ始点
let connectFrom: number | null = null;
// 「既存のノードへ合流」で、合流させるノード
let joinSources: number[] = [];
// 名前を入力している欄。ノードの名前か、グループの名前 (枠のラベル)
type RenameTarget = { type: 'node'; id: number } | { type: 'group'; id: string };
let renaming: { target: RenameTarget; input: HTMLInputElement } | null = null;
// 詳細を書いているノード
let detailsEditing: number | null = null;
// 詳細の見せ方 (常に表示 / ホバー時に表示 / 隠す = i を押したときだけ)
type DetailsMode = 'always' | 'hover' | 'click';
let detailsMode: DetailsMode = 'hover';

function contextOf(text: string): ops.EditContext {
    const parsed = parseDocument(text);
    return { source: text, parsed, model: buildModel(parsed.nodes, parsed.frontmatter) };
}

const nodeOf = (id: number): OutlineNode | undefined => ctx.parsed.nodes[id - 1];
const boxOf = (id: number): HTMLElement | null => host.querySelector<HTMLElement>(`.mdag-node[data-id="${id}"] .mdag-box`);
const nameOf = (id: number): string => nodeOf(id)?.refText || `#${id}`;
const isVisible = (element: Element | null): element is HTMLElement => element instanceof HTMLElement && element.offsetParent !== null;

// ---- 原文の反映 --------------------------------------------------------------------------------------------------

interface CommitOptions {
    focusLine?: number;
    focusId?: number;
    message?: string;
    rename?: boolean;
    // 図はもう新しい原文で描いてある (タスクの切り替え)
    drawn?: boolean;
    // 原文の欄の入力から来た (欄の中身を書き換えない)
    fromText?: boolean;
    undo?: boolean;
    // 複数選択を解かない (id の変わらない書き換え)
    keep?: boolean;
}

function commit(next: string, options: CommitOptions = {}): void {
    if (next === source && !options.rename) return;
    const previous = source;
    if (next !== source && options.undo !== false) {
        undoStack.push(source);
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
    }
    source = next;
    try {
        ctx = contextOf(next);
    } catch (error) {
        showToast(`解析できませんでした: ${String(error)}`, 'error');
        return;
    }
    let diagnostics: Diagnostic[] = diagram.diagnostics;
    if (!options.drawn) {
        try {
            diagnostics = diagram.update(next);
        } catch (error) {
            showToast(`描けませんでした: ${String(error)}`, 'error');
        }
    }
    // 選んでいたものを、書き換えたあとの原文で選び直す
    if (options.focusId !== undefined) selection = { type: 'node', id: options.focusId };
    else if (options.focusLine !== undefined) {
        const found = ctx.parsed.nodes.find((node) => node.lines?.start === options.focusLine);
        selection = found ? { type: 'node', id: found.id } : null;
    } else if (selection?.type === 'node' && !nodeOf(selection.id)) selection = null;
    // 複数選択は、書き換えで id がずれるので解く
    else if (selection?.type === 'nodes' && !options.keep) selection = null;
    else if (selection?.type === 'edge' && !host.querySelector(`.mdag-edge[data-key="${CSS.escape(selection.key)}"]`)) selection = null;
    else if (selection?.type === 'group' && !ctx.model.groups.some((group) => group.id === (selection as { id: string }).id)) selection = null;
    if (selection?.type === 'node') diagram.view.revealNode(selection.id);
    if (selection?.type !== 'edge') diagram.view.selectEdge(null);
    diagram.view.selectGroup(selection?.type === 'group' ? selection.id : null);
    renderContextBar();
    updateHint();

    if (!options.fromText) writeText(next, changedLines(previous, next));
    else renderMirror(changedLines(previous, next));
    showDiagnostics(diagnostics);
    updateUndoButtons();
    if (options.message) showToast(options.message);
    if (tagPanel.mode !== null) renderTagPanel();
    renderGroupList();
    if (options.rename && selection?.type === 'node') {
        const id = selection.id;
        requestAnimationFrame(() => startRename(id, true, true));
    }
}

function apply(result: ops.EditResult, options: Omit<CommitOptions, 'focusLine' | 'focusId' | 'message'> = {}): boolean {
    if (!result.ok) {
        if (result.message) showToast(result.message, 'error');
        return false;
    }
    commit(result.source, { ...options, focusLine: result.focusLine, focusId: result.focusId, message: result.message });
    return true;
}

function undo(): void {
    const previous = undoStack.pop();
    if (previous === undefined) return;
    redoStack.push(source);
    commit(previous, { undo: false });
}

function redo(): void {
    const next = redoStack.pop();
    if (next === undefined) return;
    undoStack.push(source);
    commit(next, { undo: false });
}

function updateUndoButtons(): void {
    undoButton.disabled = undoStack.length === 0;
    redoButton.disabled = redoStack.length === 0;
}

// ---- 原文の欄 ----------------------------------------------------------------------------------------------------

// 書き換えたあとの行のうち、前の原文にない行 (行の LCS から外れたもの)
function changedLines(before: string, after: string): Set<number> {
    const a = before.split('\n');
    const b = after.split('\n');
    const changed = new Set<number>();
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);
    if (midA.length * midB.length > 4_000_000) {
        for (let index = 0; index < midB.length; index++) changed.add(head + index);
        return changed;
    }
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
        for (let j = midB.length - 1; j >= 0; j--) {
            table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }
    let i = 0;
    let j = 0;
    while (j < midB.length) {
        if (i < midA.length && midA[i] === midB[j]) {
            i++;
            j++;
        } else if (i < midA.length && table[i + 1]![j]! >= table[i]![j + 1]!) i++;
        else {
            changed.add(head + j);
            j++;
        }
    }
    return changed;
}

let flashLines = new Set<number>();

function writeText(text: string, changed: Set<number>): void {
    textarea.value = text;
    renderMirror(changed);
    const first = Math.min(...changed);
    if (Number.isFinite(first)) scrollTextTo(first);
}

function scrollTextTo(line: number): void {
    const top = line * 20;
    if (top < textarea.scrollTop + 20 || top > textarea.scrollTop + textarea.clientHeight - 60) textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 3);
    syncMirrorScroll();
}

function renderMirror(changed: Set<number> = new Set()): void {
    flashLines = changed;
    const lines = textarea.value.split('\n');
    const selected = selectedLines();
    mirror.replaceChildren(
        ...lines.map((line, index) => {
            const row = document.createElement('div');
            row.textContent = line || ' ';
            if (selected.some((range) => index >= range.start && index < range.end)) row.className = 'is-selected';
            if (flashLines.has(index)) row.classList.add('is-flash');
            return row;
        }),
    );
    linesLabel.textContent = `${lines.length} 行`;
    syncMirrorScroll();
}

// 選んだノードの行だけを塗り直す (変わった行の点滅は残す)
function paintSelectedLines(): void {
    const ranges = selectedLines();
    [...mirror.children].forEach((row, index) => row.classList.toggle('is-selected', ranges.some((range) => index >= range.start && index < range.end)));
}

function selectedIds(): number[] {
    if (selection?.type === 'node') return [selection.id];
    if (selection?.type === 'nodes') return selection.ids;
    return [];
}

function selectedLines(): Array<{ start: number; end: number }> {
    return selectedIds().flatMap((id) => nodeOf(id)?.lines ?? []);
}

function syncMirrorScroll(): void {
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
}

function showDiagnostics(diagnostics: Diagnostic[]): void {
    const shown = diagnostics.filter((item) => item.code !== 'not-extracted');
    diagBox.textContent = shown.length === 0 ? '診断なし' : formatDiagnostics(shown);
    diagBox.dataset.level = shown.some((item) => item.severity === 'error') ? 'error' : shown.some((item) => item.severity === 'warning') ? 'warning' : 'none';
}

let textTimer = 0;
textarea.addEventListener('input', () => {
    renderMirror(flashLines);
    window.clearTimeout(textTimer);
    textTimer = window.setTimeout(() => commit(textarea.value, { fromText: true }), 250);
});
textarea.addEventListener('scroll', syncMirrorScroll);
// 原文の欄でカーソルを置いた行のノードを、図の側でも選ぶ
const selectFromCaret = (): void => {
    const line = textarea.value.slice(0, textarea.selectionStart).split('\n').length - 1;
    const node = [...ctx.parsed.nodes].reverse().find((item) => item.lines && line >= item.lines.start && line < item.lines.end);
    if (node && node.parent !== null) select({ type: 'node', id: node.id }, false);
};
textarea.addEventListener('click', selectFromCaret);
textarea.addEventListener('keyup', (event) => {
    if (event.key.startsWith('Arrow')) selectFromCaret();
});

// ---- 選択 --------------------------------------------------------------------------------------------------------

function select(next: Selection, scrollText = true): void {
    const before = selectedIds().join(',');
    selection = next;
    if (tagPanel.mode !== null && selectedIds().join(',') !== before) closeTagPanel();
    if (next?.type === 'edge') diagram.view.selectEdge(next.key);
    else diagram.view.selectEdge(null);
    diagram.view.selectGroup(next?.type === 'group' ? next.id : null);
    paintSelectedLines();
    const lines = selectedLines()[0];
    if (lines && scrollText) scrollTextTo(lines.start);
    renderContextBar();
    updateHint();
    renderGroupList();
}

// Shift / Ctrl / ⌘ クリックで、選択にノードを足す (選んであれば外す)
function toggleNode(id: number): void {
    const ids = selectedIds();
    const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
    select(next.length === 0 ? null : next.length === 1 ? { type: 'node', id: next[0] ?? id } : { type: 'nodes', ids: next });
}

// 選んだノードを、新しく作る合流先へ合流させる。合流先はすぐ名前を入れられるようにする
function joinIntoNewNode(): void {
    const ids = selectedIds();
    if (ids.length < 2) {
        showToast('何もないところからドラッグして、合流させるノードを 2 つ以上囲んでください', 'error');
        return;
    }
    apply(ops.addJoinNode(ctx, ids, '合流点', contextOf), { rename: true });
}

// 選んだノードを、次にクリックする既存のノードへ合流させる
function startJoinToExisting(): void {
    joinSources = selectedIds();
    if (joinSources.length === 0) return;
    setTool('join');
}

// 複数のノードを消す。後ろのノードから消せば、前のノードの id は変わらない。1 回の取り消しで戻せるよう、まとめて反映する
function deleteNodes(ids: number[]): void {
    let current = ctx;
    let removed = 0;
    for (const id of [...ids].sort((a, b) => b - a)) {
        const result = ops.deleteNode(current, id);
        if (!result.ok) continue;
        current = contextOf(result.source);
        removed++;
    }
    if (removed === 0) {
        showToast('消せるノードがありません', 'error');
        return;
    }
    select(null);
    commit(current.source, { message: `${removed} 個のノードを消しました` });
}

function renderContextBar(): void {
    ctxBar.innerHTML = '';
    const button = (icon: string, label: string, title: string, run: () => void, danger = false): HTMLButtonElement => {
        const element = document.createElement('button');
        element.innerHTML = `${icon}<span>${label}</span>`;
        element.title = title;
        if (danger) element.className = 'is-danger';
        element.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        ctxBar.append(element);
        return element;
    };
    const separator = (): void => {
        const line = document.createElement('span');
        line.className = 'ed-ctx-sep';
        ctxBar.append(line);
    };
    if (selection?.type === 'node') {
        const id = selection.id;
        const isRoot = nodeOf(id)?.parent === null;
        button(ICONS.rename, '名前', '名前を変える (F2 / ダブルクリック)', () => startRename(id, false));
        button(ICONS.child, '子', '子を足す (Tab)', () => apply(ops.addChild(ctx, id), { rename: true }));
        if (!isRoot) button(ICONS.sibling, '兄弟', '兄弟を足す (名前の入力中に Enter)', () => apply(ops.addSibling(ctx, id), { rename: true }));
        const canWrite = ops.detailsOf(ctx, id) !== null;
        const note = button(ICONS.note, '詳細編集', canWrite ? '詳細を書く (D)' : '詳細はリスト項目にだけ書けます (見出しには書けません)', () => openDetailsEditor(id));
        note.disabled = !canWrite;
        button(ICONS.tag, 'タグ追加', 'タグを付ける (T)。キーと値を入れる', () => openTagPanel('new'));
        button(ICONS.tags, 'タグ選択', '使っているタグから選んで付ける', () => openTagPanel('pick'));
        if (!isRoot) {
            separator();
            button(ICONS.trash, '削除', '配下ごと消す (Delete)', () => apply(ops.deleteNode(ctx, id)), true);
        }
    } else if (selection?.type === 'nodes') {
        const ids = selection.ids;
        const label = document.createElement('span');
        label.style.cssText = 'align-self:center;padding:0 8px;font-size:12px;color:var(--ed-muted)';
        label.textContent = `${ids.length} 個を選択`;
        ctxBar.append(label);
        separator();
        button(ICONS.merge, '合流ノードを作る', '選んだノードから、新しいノードへ合流させる (J)', joinIntoNewNode);
        button(ICONS.join, '既存のノードへ合流', '選んだノードから、次にクリックするノードへ合流させる', startJoinToExisting);
        button(ICONS.group, 'グループ', `選んだノードをグループにまとめる (${MOD}G)`, groupSelection);
        button(ICONS.tag, 'タグ追加', '選んだノードにタグを付ける (T)', () => openTagPanel('new'));
        button(ICONS.tags, 'タグ選択', '選んだノードに、使っているタグから選んで付ける', () => openTagPanel('pick'));
        separator();
        button(ICONS.trash, '削除', '選んだノードを配下ごと消す (Delete)', () => deleteNodes(ids), true);
    } else if (selection?.type === 'group') {
        const id = selection.id;
        const label = document.createElement('span');
        label.style.cssText = 'align-self:center;padding:0 8px;font-size:12px;color:var(--ed-muted)';
        label.textContent = `グループ「${ctx.model.groups.find((group) => group.id === id)?.label ?? id}」`;
        ctxBar.append(label);
        separator();
        button(ICONS.rename, '名前', 'グループの名前を変える (Enter / ダブルクリック)', () => startGroupRename(id));
        button(ICONS.ungroup, 'グループ解除', '枠と印を外す (ノードは残る)', () => {
            if (apply(ops.ungroup(ctx, id))) select(null);
        }, true);
    } else if (selection?.type === 'edge') {
        const edge = ops.parseEdgeKey(selection.key);
        if (!edge) return;
        const label = document.createElement('span');
        label.style.cssText = 'align-self:center;padding:0 8px;font-size:12px;color:var(--ed-muted)';
        label.textContent = `${nameOf(edge.source)} → ${nameOf(edge.target)} (${edge.kind === 'tree' ? '親子' : edge.kind})`;
        ctxBar.append(label);
        if (edge.kind !== 'tree') {
            separator();
            button(ICONS.reverse, '反転', '向きを変える', () => apply(ops.reverseEdge(ctx, edge)));
            button(ICONS.trash, '削除', '線を消す (Delete)', () => apply(ops.deleteEdge(ctx, edge)), true);
        }
    }
}

// 全体を表示する。小さな図を大きくしすぎないよう倍率を抑え、左の道具箱に重ならないよう少し右へずらす
function fitView(): void {
    diagram.fit();
    const { k } = diagram.view.getTransform();
    const limit = 1.1;
    if (k > limit) diagram.view.zoomBy(limit / k, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
    diagram.view.panBy(48, 0);
}

function setTool(next: Tool): void {
    tool = next;
    connectFrom = null;
    if (next !== 'join') joinSources = [];
    stage.dataset.tool = next;
    for (const button of app.querySelectorAll<HTMLButtonElement>('.ed-tool[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === next));
    updateHint();
}

function updateHint(): void {
    const k = (key: string): string => `<kbd>${key}</kbd>`;
    let text: string;
    if (tool === 'join') text = `${joinSources.length} 個のノードを合流させる先のノードをクリック ${k('Esc')} でやめる`;
    else if (tool === 'connect') text = connectFrom === null ? '線の始点のノードをクリック (またはノードからドラッグ)' : `「${nameOf(connectFrom)}」から線を引く先のノードをクリック ${k('Esc')} でやめる`;
    else if (tool === 'pan') text = `ドラッグで図を動かす / ホイールで拡大縮小 ${k('V')} で選ぶ道具へ`;
    else if (renaming?.target.type === 'node') text = `${k('Enter')} 決めて兄弟を足す ${k('Tab')} 決めて子を足す ${k('Esc')} やめる`;
    else if (renaming) text = `${k('Enter')} 決める ${k('Esc')} やめる`;
    else if (tagPanel.mode === 'new') text = `キーと値を入れて ${k('Enter')} で付ける / 付いているタグを押すと編集 ${k('Esc')} 閉じる`;
    else if (tagPanel.mode === 'pick') text = `押すたびに付け外し (複数選べる) ${k('Esc')} 閉じる`;
    else if (detailsEditing !== null) text = `${k(`${MOD}Enter`)} 詳細を保存 ${k('Esc')} やめる / 行頭の > は自動で付く`;
    else if (selection?.type === 'node') text = `${k('Enter')} 名前 ${k('Tab')} 子 ${k('D')} 詳細 ${k('T')} タグ ${k('Del')} 削除 / ドラッグでほかのノードの下へ 何もないところからドラッグで囲んで複数選ぶ`;
    else if (selection?.type === 'group') text = `${k('Enter')} グループの名前を変える / 枠のラベルをダブルクリックでも変えられる`;
    else if (selection?.type === 'nodes') text = `${k('J')} 合流ノードを作る ${k(`${MOD}G`)} グループにまとめる / 右の点をほかのノードへドラッグでそこへ合流 ${k('Del')} 削除`;
    else if (selection?.type === 'edge') text = `${k('Del')} 線を削除`;
    else text = `何もないところからドラッグで範囲選択 / ${k('Space')}+ドラッグで図を動かす / 右の点をドラッグで線を引く ${k('Tab')} で子を足す`;
    hint.innerHTML = text;
}

let toastTimer = 0;
function showToast(message: string, level: 'info' | 'error' = 'info'): void {
    toast.textContent = message;
    toast.dataset.level = level;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), level === 'error' ? 4200 : 2600);
}

// ---- 名前の変更 --------------------------------------------------------------------------------------------------

// fresh は、足したばかりのノードの名前を入れるとき。Esc でやめたら、足す前に戻す (仮の名前のノードを残さない)
function startRename(id: number, selectAll: boolean, fresh = false): void {
    const node = nodeOf(id);
    const label = node ? ops.labelOf(source, node) : null;
    if (label === null) {
        showToast('このノードは名前を変えられません', 'error');
        return;
    }
    openRename({ type: 'node', id }, label, selectAll, fresh);
}

// グループの名前 (枠のラベルと凡例に出る label) を変える
function startGroupRename(id: string): void {
    const group = ctx.model.groups.find((item) => item.id === id);
    if (!group) return;
    openRename({ type: 'group', id }, group.label, true);
}

function openRename(target: RenameTarget, label: string, selectAll: boolean, fresh = false): void {
    finishRename(false);
    const input = document.createElement('input');
    input.className = 'ed-rename';
    if (target.type === 'group') input.classList.add('is-group');
    input.value = label;
    stage.append(input);
    renaming = { target, input };
    positionRename();
    input.focus();
    if (selectAll) input.select();
    else input.setSelectionRange(label.length, label.length);
    updateHint();
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            // ノードの名前は、決めたらそのまま兄弟 (ルートなら子) を足して書き続ける
            event.preventDefault();
            finishRename(true);
            if (target.type === 'node' && selection?.type === 'node') {
                const current = selection.id;
                apply(nodeOf(current)?.parent === null ? ops.addChild(ctx, current) : ops.addSibling(ctx, current), { rename: true });
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finishRename(false);
            if (fresh) undo();
        } else if (event.key === 'Tab' && target.type === 'node') {
            // 名前を決めて、そのまま子 (Shift なら兄弟) を足して書き続ける
            event.preventDefault();
            finishRename(true);
            if (selection?.type === 'node') {
                const current = selection.id;
                apply(event.shiftKey ? ops.addSibling(ctx, current) : ops.addChild(ctx, current), { rename: true });
            }
        }
    });
    input.addEventListener('blur', () => finishRename(true));
}

function finishRename(save: boolean): void {
    if (!renaming) return;
    const { target, input } = renaming;
    renaming = null;
    input.remove();
    if (save) {
        const result = target.type === 'node' ? ops.renameNode(ctx, target.id, input.value, parseDocument) : ops.renameGroup(ctx, target.id, input.value);
        if (result.ok) {
            apply(result);
            if (target.type === 'group') select({ type: 'group', id: target.id }, false);
        } else if (result.message) showToast(result.message, 'error');
    }
    updateHint();
    stage.focus({ preventScroll: true });
}

function positionRename(): void {
    if (!renaming) return;
    const { target, input } = renaming;
    const stageRect = stage.getBoundingClientRect();
    const k = diagram.view.getTransform().k;
    if (target.type === 'group') {
        // 枠のラベルの上に重ねる。ラベルの字の大きさ (11px) に倍率を掛ける
        const label = host.querySelector(`.mdag-frame-label[data-group="${CSS.escape(target.id)}"]`);
        if (!label) return;
        const rect = label.getBoundingClientRect();
        input.style.left = `${rect.left - stageRect.left - 8}px`;
        input.style.top = `${rect.top - stageRect.top + rect.height / 2 - (14 * k + 8) / 2}px`;
        input.style.width = `${Math.max(160, rect.width + 60)}px`;
        input.style.fontSize = `${Math.max(12, 11 * k)}px`;
        input.style.lineHeight = `${Math.max(14, 14 * k)}px`;
        return;
    }
    const box = boxOf(target.id);
    if (!isVisible(box)) return;
    const rect = box.getBoundingClientRect();
    input.style.left = `${rect.left - stageRect.left - 8}px`;
    input.style.top = `${rect.top - stageRect.top + rect.height / 2 - (20 * k + 8) / 2}px`;
    input.style.width = `${Math.max(160, rect.width + 40)}px`;
    input.style.fontSize = `${16 * k}px`;
    input.style.lineHeight = `${20 * k}px`;
}

// ---- 詳細の入力 --------------------------------------------------------------------------------------------------

const detailsEditor = $<HTMLDivElement>('.ed-details-editor');
const detailsText = detailsEditor.querySelector('textarea') as HTMLTextAreaElement;

function openDetailsEditor(id: number): void {
    const text = ops.detailsOf(ctx, id);
    if (text === null) {
        showToast('詳細はリスト項目にだけ書けます (見出しには書けません)', 'error');
        return;
    }
    finishRename(true);
    detailsEditing = id;
    (detailsEditor.querySelector('.ed-details-head b') as HTMLElement).textContent = nameOf(id);
    (detailsEditor.querySelector('.ed-details-foot span') as HTMLElement).textContent = `${MOD}Enter で保存 / Esc でやめる`;
    detailsText.value = text;
    detailsEditor.hidden = false;
    positionDetailsEditor();
    detailsText.focus();
    detailsText.setSelectionRange(text.length, text.length);
    updateHint();
}

function closeDetailsEditor(save: boolean): void {
    if (detailsEditing === null) return;
    const id = detailsEditing;
    detailsEditing = null;
    detailsEditor.hidden = true;
    if (save) {
        const result = ops.setDetails(ctx, id, detailsText.value);
        if (result.ok) apply(result);
        else if (result.message) showToast(result.message, 'error');
    }
    updateHint();
    stage.focus({ preventScroll: true });
}

// ノードの右に置く。右に入らなければノードの下 (下にも入らなければ上) に置き、図の領域の中に収める
function positionDetailsEditor(): void {
    if (detailsEditing === null) return;
    const box = boxOf(detailsEditing);
    if (!isVisible(box)) return;
    placeNear(detailsEditor, localRect(box));
}

// 浮かせる入力欄を、rect (図の領域の座標) の右に置く。右に入らなければ下、下にも入らなければ上に置き、図の領域の中に収める
function placeNear(element: HTMLElement, rect: DOMRect): void {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const clampX = (x: number): number => Math.min(Math.max(8, x), stage.clientWidth - width - 8);
    const clampY = (y: number): number => Math.min(Math.max(8, y), stage.clientHeight - height - 8);
    if (rect.right + 14 + width <= stage.clientWidth - 8) place(element, rect.right + 14, clampY(rect.top - 8));
    else if (rect.bottom + 12 + height <= stage.clientHeight - 8) place(element, clampX(rect.left), rect.bottom + 12);
    else place(element, clampX(rect.left), clampY(rect.top - height - 12));
}

detailsText.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        closeDetailsEditor(true);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeDetailsEditor(false);
    }
});
// 入力欄の外へフォーカスが移ったら保存する (保存とやめるのボタンは、それぞれの動きに任せる)
detailsEditor.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && detailsEditor.contains(next)) return;
    window.setTimeout(() => {
        if (detailsEditing !== null && !detailsEditor.contains(document.activeElement)) closeDetailsEditor(true);
    }, 0);
});
detailsEditor.querySelector('.ed-details-save')?.addEventListener('click', () => closeDetailsEditor(true));
detailsEditor.querySelector('.ed-details-cancel')?.addEventListener('click', () => closeDetailsEditor(false));
for (const type of ['pointerdown', 'click', 'dblclick'] as const) detailsEditor.addEventListener(type, (event) => event.stopPropagation());

// ---- タグ --------------------------------------------------------------------------------------------------------
// new はタグの新規作成 (キーと値の入力。付いているタグを押すと、その編集になる)。pick は付いているタグの一覧から選ぶ。
// どちらも選んでいるノード (複数可) に付ける。一覧は複数選べ、押すたびに付け外しする

const tagPanelElement = $<HTMLDivElement>('.ed-tag-panel');
const tagPanel: { mode: 'new' | 'pick' | null; editingKey: string | null; filter: string } = { mode: null, editingKey: null, filter: '' };
const RECENT_KEY = 'markdag-board.recent-tags';
let recentTags: string[] = [];
try {
    const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (Array.isArray(stored)) recentTags = stored.filter((item): item is string => typeof item === 'string').slice(0, 3);
} catch {
    recentTags = [];
}

function rememberTag(tag: ops.TagValue): void {
    const text = ops.tagText(tag);
    recentTags = [text, ...recentTags.filter((item) => item !== text)].slice(0, 3);
    try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(recentTags));
    } catch {
        // 保存できない環境では、このページを開いている間だけ覚える
    }
}

const parseTagText = (text: string): ops.TagValue => {
    const at = text.indexOf(':');
    return at < 0 ? { key: text, value: null } : { key: text.slice(0, at), value: text.slice(at + 1) };
};
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// editingKey を渡すと、そのキーのタグの編集で開く (ノードのタグを押したとき)
function openTagPanel(mode: 'new' | 'pick', editingKey: string | null = null): void {
    if (selectedIds().length === 0) {
        showToast('タグを付けるノードを選んでください (クリック、または何もないところからドラッグで囲む)');
        return;
    }
    closeDetailsEditor(true);
    finishRename(true);
    tagPanel.mode = mode;
    tagPanel.editingKey = editingKey;
    tagPanel.filter = '';
    tagPanelElement.hidden = false;
    renderTagPanel();
    positionTagPanel();
    tagPanelElement.querySelector<HTMLInputElement>(mode === 'pick' ? '.ed-tag-filter' : editingKey === null ? '.ed-tag-key' : '.ed-tag-value')?.focus();
    updateHint();
}

function closeTagPanel(): void {
    if (tagPanel.mode === null) return;
    tagPanel.mode = null;
    tagPanelElement.hidden = true;
    updateHint();
}

function positionTagPanel(): void {
    if (tagPanel.mode === null) return;
    let union: DOMRect | null = null;
    for (const id of selectedIds()) {
        const box = boxOf(id);
        if (!isVisible(box)) continue;
        const rect = localRect(box);
        union = union === null ? rect : unionRect(union, rect);
    }
    if (union) placeNear(tagPanelElement, union);
}

// 選んだノードの全部に付いていれば 'all'、一部なら 'some'
function tagState(tag: ops.TagValue): 'all' | 'some' | 'none' {
    const ids = selectedIds();
    const has = ids.filter((id) => ops.hasTag(ctx, id, tag)).length;
    return has === 0 ? 'none' : has === ids.length ? 'all' : 'some';
}

function applyTag(tag: ops.TagValue, previousKey: string | null = null): void {
    if (apply(ops.setTag(ctx, selectedIds(), tag, previousKey), { keep: true })) rememberTag(tag);
}

function renderTagPanel(): void {
    const ids = selectedIds();
    if (tagPanel.mode === null || ids.length === 0) return;
    const target = ids.length === 1 ? `「${escapeHtml(nameOf(ids[0] ?? 0))}」` : `${ids.length} 個のノード`;
    // 選んだノードに付いているタグ (どれかに付いていれば出す)
    const attached = new Map<string, ops.TagValue>();
    for (const id of ids) for (const tag of ops.tagsOfNode(ctx, id)) attached.set(ops.tagText(tag), tag);
    const chips = [...attached.values()]
        .map((tag) => `<span class="ed-chip" data-tag="${escapeHtml(ops.tagText(tag))}"><button class="ed-chip-edit" title="このタグを編集">#${escapeHtml(ops.tagText(tag))}</button><button class="ed-chip-remove" title="外す" aria-label="外す">×</button></span>`)
        .join('');
    if (tagPanel.mode === 'new') {
        const keys = [...new Set(ops.registeredTags(ctx).map((tag) => tag.key))];
        const editing = tagPanel.editingKey;
        const current = editing === null ? null : (attached.get([...attached.keys()].find((text) => parseTagText(text).key === editing) ?? '') ?? null);
        tagPanelElement.innerHTML = `
            <div class="ed-panel-head"><span>${editing === null ? 'タグの新規作成' : 'タグの編集'}</span><b>${target}</b></div>
            ${chips ? `<div class="ed-chips">${chips}</div>` : '<div class="ed-panel-empty">付いているタグはありません</div>'}
            <div class="ed-tag-form">
                <label><span>キー</span><input class="ed-tag-key" list="ed-tag-keys" placeholder="owner" value="${escapeHtml(current?.key ?? '')}"></label>
                <label><span>値 (なくてもよい)</span><input class="ed-tag-value" placeholder="alice" value="${escapeHtml(current?.value ?? '')}"></label>
                <datalist id="ed-tag-keys">${keys.map((key) => `<option value="${escapeHtml(key)}">`).join('')}</datalist>
            </div>
            <div class="ed-panel-foot"><span>Enter で${editing === null ? '追加' : '更新'} / Esc で閉じる</span>${editing === null ? '' : '<button class="ed-tag-cancel-edit">新規に戻る</button>'}<button class="ed-panel-primary ed-tag-submit">${editing === null ? '追加' : '更新'}</button></div>`;
    } else {
        const all = ops.registeredTags(ctx);
        const filter = tagPanel.filter.trim().toLowerCase();
        const match = (tag: ops.TagValue): boolean => filter === '' || ops.tagText(tag).toLowerCase().includes(filter);
        const recent = recentTags.map(parseTagText).filter(match);
        const row = (tag: ops.TagValue): string => {
            const state = tagState(tag);
            return `<button class="ed-tag-row" role="menuitemcheckbox" aria-checked="${state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}" data-tag="${escapeHtml(ops.tagText(tag))}"><i></i><span>#${escapeHtml(ops.tagText(tag))}</span></button>`;
        };
        const listed = all.filter(match);
        tagPanelElement.innerHTML = `
            <div class="ed-panel-head"><span>タグを選択</span><b>${target}</b></div>
            <input class="ed-tag-filter" placeholder="絞り込み" value="${escapeHtml(tagPanel.filter)}">
            <div class="ed-tag-section">最近使ったタグ</div>
            ${recent.length > 0 ? `<div class="ed-tag-list">${recent.map(row).join('')}</div>` : '<div class="ed-panel-empty">まだありません</div>'}
            <hr>
            <div class="ed-tag-section">登録されているタグ</div>
            <div class="ed-tag-list">${listed.length > 0 ? listed.map(row).join('') : '<div class="ed-panel-empty">タグがありません。「タグ追加」で作れます</div>'}</div>
            <div class="ed-panel-foot"><span>押すたびに付け外し (複数選べる)</span><button class="ed-panel-primary ed-tag-close">閉じる</button></div>`;
    }
}

function submitTagForm(): void {
    const key = tagPanelElement.querySelector<HTMLInputElement>('.ed-tag-key')?.value ?? '';
    const value = tagPanelElement.querySelector<HTMLInputElement>('.ed-tag-value')?.value ?? '';
    const tag = ops.normalizeTag(key, value);
    if (!tag) {
        showToast('キーを入れてください (空白と : # % $ " , は使えません)', 'error');
        return;
    }
    const previousKey = tagPanel.editingKey;
    tagPanel.editingKey = null;
    applyTag(tag, previousKey);
    renderTagPanel();
    tagPanelElement.querySelector<HTMLInputElement>('.ed-tag-key')?.focus();
}

tagPanelElement.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const chip = target.closest<HTMLElement>('.ed-chip');
    if (target.closest('.ed-chip-remove') && chip?.dataset.tag) {
        apply(ops.removeTag(ctx, selectedIds(), parseTagText(chip.dataset.tag).key), { keep: true });
    } else if (target.closest('.ed-chip-edit') && chip?.dataset.tag) {
        tagPanel.mode = 'new';
        tagPanel.editingKey = parseTagText(chip.dataset.tag).key;
        renderTagPanel();
        tagPanelElement.querySelector<HTMLInputElement>('.ed-tag-value')?.focus();
    } else if (target.closest('.ed-tag-cancel-edit')) {
        tagPanel.editingKey = null;
        renderTagPanel();
    } else if (target.closest('.ed-tag-submit')) {
        submitTagForm();
    } else if (target.closest('.ed-tag-close')) {
        closeTagPanel();
    } else {
        const row = target.closest<HTMLElement>('.ed-tag-row');
        if (!row?.dataset.tag) return;
        // 全部に付いていれば外し、そうでなければ付ける。同じキーの別の値は、足していく (複数の値を持てるキーのとき)
        const tag = parseTagText(row.dataset.tag);
        if (row.getAttribute('aria-checked') === 'true') apply(ops.removeTagValue(ctx, selectedIds(), tag), { keep: true });
        else if (apply(ops.addTagValue(ctx, selectedIds(), tag), { keep: true })) rememberTag(tag);
    }
});
tagPanelElement.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeTagPanel();
        stage.focus({ preventScroll: true });
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && tagPanel.mode === 'new') {
        event.preventDefault();
        submitTagForm();
    }
});
tagPanelElement.addEventListener('input', (event) => {
    if (!(event.target instanceof HTMLInputElement) || !event.target.classList.contains('ed-tag-filter')) return;
    tagPanel.filter = event.target.value;
    const caret = event.target.selectionStart;
    renderTagPanel();
    const filter = tagPanelElement.querySelector<HTMLInputElement>('.ed-tag-filter');
    filter?.focus();
    if (caret !== null) filter?.setSelectionRange(caret, caret);
});
for (const type of ['pointerdown', 'dblclick'] as const) tagPanelElement.addEventListener(type, (event) => event.stopPropagation());

// ---- ノードの部分 (ラベル、詳細、タグ) の押し分け -----------------------------------------------------------------
// 詳細とタグの吹き出しは図の側が 1 つだけ持ち、どのノードのものかを外へ出さないので、最後にポインタが乗ったノードで見る

let hoveredNode: number | null = null;
host.addEventListener('pointerover', (event) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('.mdag-node') : null;
    if (element && host.contains(element)) hoveredNode = Number(element.dataset.id);
});

// 押した位置にあるタグのキー。タグの並びは 1 つの文字列なので、押した文字の位置から、その位置を含む #... の塊を探す
function tagKeyAt(element: Element, x: number, y: number): string | null {
    const text = element.textContent ?? '';
    let offset: number | null = null;
    const range = document.caretRangeFromPoint?.(x, y);
    if (range && element.contains(range.startContainer)) {
        const before = document.createRange();
        before.setStart(element, 0);
        before.setEnd(range.startContainer, range.startOffset);
        offset = before.toString().length;
    }
    const tokens = [...text.matchAll(/#(?:[^\s"]|"[^"]*")+/g)];
    const token = offset === null ? tokens[0] : (tokens.find((match) => offset !== null && match.index <= offset && offset <= match.index + match[0].length) ?? tokens[0]);
    return token ? (token[0].slice(1).split(':')[0] ?? null) : null;
}

// ノードのタグを押したら、そのノードを選び、押したタグの編集を開く
function editTagAt(id: number, element: Element, event: MouseEvent): void {
    if (!nodeOf(id)) return;
    select({ type: 'node', id }, false);
    const key = tagKeyAt(element, event.clientX, event.clientY);
    openTagPanel('new', key !== null && ops.tagsOfNode(ctx, id).some((tag) => tag.key === key) ? key : null);
}

// ---- グループの一覧 (右上。図の側の凡例の代わりに出し、編集もできるようにする) ---------------------------------------

const groupList = $<HTMLDivElement>('.ed-groups');
let groupListRenaming: string | null = null;
let groupListCollapsed = false;

function renderGroupList(): void {
    if (!ctx) return;
    const ids = selectedIds();
    const counts = new Map<string, number>();
    for (const groups of ctx.model.groupsOf.values()) for (const id of groups) counts.set(id, (counts.get(id) ?? 0) + 1);
    const rows = ctx.model.groups
        .map((group) => {
            const color = group.color ?? '#888888';
            const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#888888';
            const selected = selection?.type === 'group' && selection.id === group.id;
            const name =
                groupListRenaming === group.id
                    ? `<input class="ed-group-input" value="${escapeHtml(group.label)}" aria-label="グループの名前">`
                    : `<span class="ed-group-name" title="ダブルクリックで名前を変える">${escapeHtml(group.label)}</span>`;
            return `<div class="ed-group-row${selected ? ' is-selected' : ''}" data-group="${escapeHtml(group.id)}">
                <label class="ed-group-color" title="色を変える" style="--swatch:${escapeHtml(color)}"><input type="color" value="${hex}"></label>
                ${name}
                <span class="ed-group-count" title="入っているノードの数">${counts.get(group.id) ?? 0}</span>
                <button class="ed-group-add" title="選んだノードをこのグループに入れる" ${ids.length === 0 ? 'disabled' : ''}>${ICONS.plus}</button>
                <button class="ed-group-frame" title="枠を出す / 出さない" aria-pressed="${group.boundary}">枠</button>
                <button class="ed-group-rename" title="名前を変える">${ICONS.rename}</button>
                <button class="ed-group-delete" title="グループを解く (ノードは残る)">${ICONS.trash}</button>
            </div>`;
        })
        .join('');
    groupList.classList.toggle('is-collapsed', groupListCollapsed);
    groupList.innerHTML = `
        <div class="ed-groups-head">
            <button class="ed-groups-toggle" title="一覧を畳む / 開く" aria-expanded="${!groupListCollapsed}">${ICONS.group}<span>グループ</span><small>${ctx.model.groups.length}</small></button>
            <button class="ed-groups-new" title="新しいグループを作る (選んだノードがあれば入れる)">${ICONS.plus}<span>新規</span></button>
        </div>
        <div class="ed-groups-list">${rows || '<div class="ed-panel-empty">グループはまだありません</div>'}</div>`;
    const input = groupList.querySelector<HTMLInputElement>('.ed-group-input');
    if (input && document.activeElement !== input) {
        input.focus();
        input.select();
    }
}

function finishGroupListRename(save: boolean): void {
    const id = groupListRenaming;
    if (id === null) return;
    const value = groupList.querySelector<HTMLInputElement>('.ed-group-input')?.value ?? '';
    groupListRenaming = null;
    if (save) {
        const result = ops.renameGroup(ctx, id, value);
        if (result.ok) apply(result, { keep: true });
        else if (result.message) showToast(result.message, 'error');
    }
    renderGroupList();
}

groupList.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.ed-groups-toggle')) {
        groupListCollapsed = !groupListCollapsed;
        renderGroupList();
        return;
    }
    if (target.closest('.ed-groups-new')) {
        if (selectedIds().length > 0) {
            groupSelection();
            return;
        }
        const result = ops.defineGroup(ctx);
        if (apply(result) && result.ok && result.groupId) {
            groupListRenaming = result.groupId;
            renderGroupList();
        }
        return;
    }
    const row = target.closest<HTMLElement>('.ed-group-row');
    const id = row?.dataset.group;
    if (!row || !id || target.closest('.ed-group-input, .ed-group-color')) return;
    const group = ctx.model.groups.find((item) => item.id === id);
    if (target.closest('.ed-group-add')) apply(ops.addToGroup(ctx, selectedIds(), id), { keep: true });
    else if (target.closest('.ed-group-frame')) apply(ops.setGroupField(ctx, id, 'boundary', !(group?.boundary ?? false)), { keep: true });
    else if (target.closest('.ed-group-rename')) {
        groupListRenaming = id;
        renderGroupList();
    } else if (target.closest('.ed-group-delete')) {
        if (apply(ops.ungroup(ctx, id)) && selection?.type === 'group' && selection.id === id) select(null);
    } else if (event.detail >= 2 && target.closest('.ed-group-name')) {
        // 名前のダブルクリックで名前を変える。1 回目のクリックで一覧を描き直すので、dblclick ではなくクリックの回数で見る
        groupListRenaming = id;
        renderGroupList();
    } else if (event.detail < 2) select(selection?.type === 'group' && selection.id === id ? null : { type: 'group', id });
});
groupList.addEventListener('dblclick', (event) => event.stopPropagation());
groupList.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (!(event.target instanceof HTMLInputElement) || !event.target.classList.contains('ed-group-input') || event.isComposing) return;
    if (event.key === 'Enter') {
        event.preventDefault();
        finishGroupListRename(true);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        finishGroupListRename(false);
    }
});
groupList.addEventListener('focusout', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.classList.contains('ed-group-input') && groupListRenaming !== null) finishGroupListRename(true);
});
groupList.addEventListener('change', (event) => {
    const input = event.target instanceof HTMLInputElement && event.target.type === 'color' ? event.target : null;
    const id = input?.closest<HTMLElement>('.ed-group-row')?.dataset.group;
    if (input && id) apply(ops.setGroupField(ctx, id, 'color', input.value), { keep: true });
});
for (const type of ['pointerdown', 'mousedown', 'wheel'] as const) groupList.addEventListener(type, (event) => event.stopPropagation());

// ---- 詳細の見せ方 ------------------------------------------------------------------------------------------------

const detailsModeBox = $<HTMLDivElement>('.ed-details-mode');
const detailsModeButton = $<HTMLButtonElement>('.ed-details-tool');
const flyout = $<HTMLDivElement>('.ed-flyout');
const DETAILS_MODE_LABEL: Record<DetailsMode, string> = { always: '常に表示', hover: 'ホバー時に表示', click: '隠す' };
let flyoutPinned = false;
let flyoutTimer = 0;

function setFlyout(open: boolean): void {
    window.clearTimeout(flyoutTimer);
    flyout.hidden = !open;
    detailsModeButton.setAttribute('aria-expanded', String(open));
    if (!open) flyoutPinned = false;
}

function setDetailsMode(next: DetailsMode, announce = true): void {
    detailsMode = next;
    for (const item of flyout.querySelectorAll<HTMLButtonElement>('[data-mode]')) item.setAttribute('aria-checked', String(item.dataset.mode === next));
    detailsModeButton.title = `詳細の見せ方: ${DETAILS_MODE_LABEL[next]}`;
    diagram.view.setOptions({ details: next });
    if (announce) showToast(`詳細を「${DETAILS_MODE_LABEL[next]}」にしました`);
}

// ホバーで開き、離れたら少し待って閉じる。クリックで開いたままにする (もう 1 度押すか、外を押すと閉じる)
detailsModeBox.addEventListener('pointerenter', () => setFlyout(true));
detailsModeBox.addEventListener('pointerleave', () => {
    if (flyoutPinned) return;
    flyoutTimer = window.setTimeout(() => setFlyout(false), 220);
});
detailsModeButton.addEventListener('click', () => {
    if (flyoutPinned) setFlyout(false);
    else {
        setFlyout(true);
        flyoutPinned = true;
    }
});
for (const item of flyout.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    item.addEventListener('click', () => {
        setDetailsMode(item.dataset.mode as DetailsMode);
        setFlyout(false);
        item.blur();
    });
}
document.addEventListener('pointerdown', (event) => {
    if (!flyout.hidden && event.target instanceof Node && !detailsModeBox.contains(event.target)) setFlyout(false);
});

// 選んだノードをグループにまとめ、すぐグループの名前を入れられるようにする
function groupSelection(): void {
    const ids = selectedIds();
    if (ids.length === 0) {
        showToast('グループにするノードを選んでください (何もないところからドラッグで囲む)', 'error');
        return;
    }
    const result = ops.addGroup(ctx, ids);
    if (!apply(result) || !result.ok || !result.groupId) return;
    const id = result.groupId;
    select({ type: 'group', id }, false);
    // 枠は配置のあとに描かれるので、次のコマで名前の欄を出す
    requestAnimationFrame(() => requestAnimationFrame(() => startGroupRename(id)));
}

// ---- 重ねる印 (選んだ枠、つまみ、操作の帯) の位置合わせ。配置のアニメーションに付いていくよう、毎コマ合わせる ---------

function localRect(element: Element): DOMRect {
    const stageRect = stage.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return new DOMRect(rect.left - stageRect.left, rect.top - stageRect.top, rect.width, rect.height);
}

function place(element: HTMLElement, x: number, y: number): void {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
}

function positionOverlay(): void {
    const box = selection?.type === 'node' ? boxOf(selection.id) : null;
    const showNode = isVisible(box) && !drag;
    selFrame.hidden = !showNode;
    childHandle.hidden = !showNode || tool !== 'select';
    siblingHandle.hidden = !showNode || tool !== 'select' || nodeOf(selection?.type === 'node' ? selection.id : 0)?.parent === null;
    let anchor: DOMRect | null = null;
    let connectAt: { x: number; y: number } | null = null;
    if (showNode && box) {
        const rect = localRect(box);
        anchor = rect;
        Object.assign(selFrame.style, { left: `${rect.left - 5}px`, top: `${rect.top - 4}px`, width: `${rect.width + 10}px`, height: `${rect.height + 8}px` });
        // 右下には開閉の円が来るので、つまみは右上に並べる
        connectAt = { x: rect.right + 7, y: rect.top };
        place(childHandle, rect.right + 30, rect.top);
        place(siblingHandle, rect.left + rect.width / 2, rect.bottom + 18);
    }
    // 複数選択は、選んだノードごとに細い枠を出し、全体を 1 つの枠で囲む。線を引くつまみは全体の枠の右端の中ほどに置く
    const multi = selection?.type === 'nodes' && (!drag || drag.kind === 'connect') ? selection.ids : [];
    while (multiLayer.children.length < multi.length) {
        const frame = document.createElement('div');
        frame.className = 'ed-sel ed-sel-item';
        multiLayer.append(frame);
    }
    let union: DOMRect | null = null;
    [...multiLayer.children].forEach((child, index) => {
        const frame = child as HTMLElement;
        const id = multi[index];
        const found = id === undefined ? null : boxOf(id);
        frame.hidden = !isVisible(found);
        if (frame.hidden || !found) return;
        const rect = localRect(found);
        Object.assign(frame.style, { left: `${rect.left - 5}px`, top: `${rect.top - 4}px`, width: `${rect.width + 10}px`, height: `${rect.height + 8}px` });
        union = union === null ? rect : unionRect(union, rect);
    });
    // forEach の中で書き換えるので、TypeScript は null のままと見なす
    const groupRect = union as DOMRect | null;
    groupBox.hidden = groupRect === null || multi.length < 2;
    if (groupRect && !groupBox.hidden) {
        const pad = 10;
        Object.assign(groupBox.style, { left: `${groupRect.left - pad}px`, top: `${groupRect.top - pad}px`, width: `${groupRect.width + pad * 2}px`, height: `${groupRect.height + pad * 2}px` });
    }
    if (groupRect && !drag && !marquee) {
        anchor = new DOMRect(groupRect.left - 10, groupRect.top - 10, groupRect.width + 20, groupRect.height + 20);
        connectAt = { x: groupRect.right + 10, y: groupRect.top + groupRect.height / 2 };
    }
    connectHandle.hidden = connectAt === null || tool !== 'select';
    if (connectAt) place(connectHandle, connectAt.x, connectAt.y);
    if (selection?.type === 'edge') {
        const path = host.querySelector(`path.mdag-edge[data-key="${CSS.escape(selection.key)}"]`);
        if (path) anchor = localRect(path);
    }
    if (selection?.type === 'group') {
        // 帯は枠のラベルより上に出す (ラベルは枠の上の辺の外に描かれる)
        const frame = host.querySelector(`.mdag-frame[data-group="${CSS.escape(selection.id)}"]`);
        const label = host.querySelector(`.mdag-frame-label[data-group="${CSS.escape(selection.id)}"]`);
        if (frame) anchor = label ? unionRect(localRect(frame), localRect(label)) : localRect(frame);
    }
    ctxBar.hidden = anchor === null || drag !== null || renaming !== null || marquee !== null || detailsEditing !== null || tagPanel.mode !== null;
    positionDetailsEditor();
    positionTagPanel();
    if (anchor && !ctxBar.hidden) {
        const width = ctxBar.offsetWidth;
        const x = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), stage.clientWidth - width - 8);
        const above = anchor.top - ctxBar.offsetHeight - 14;
        place(ctxBar, x, above > 8 ? above : anchor.bottom + (selection?.type === 'node' ? 34 : 12));
    }
    positionRename();
    requestAnimationFrame(positionOverlay);
}

function unionRect(a: DOMRect, b: DOMRect): DOMRect {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return new DOMRect(left, top, Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
}

// ---- ドラッグ (線を引く / ほかのノードの下へ移す) -----------------------------------------------------------------

interface Drag {
    kind: 'connect' | 'move';
    from: number;
    // 線を引くときの始点。複数選択から引くと 2 つ以上になり、離したノードへ合流させる
    sources: number[];
    start: { x: number; y: number };
    active: boolean;
    target: number | null;
    ghost: HTMLDivElement | null;
    pointerId: number;
}
let drag: Drag | null = null;
let suppressClick = false;
// 何もないところからのドラッグの範囲選択。base は選択に足すとき (Shift / Ctrl / ⌘) に、それまで選んでいたノード
let marquee: { start: { x: number; y: number }; base: number[]; pointerId: number; moved: boolean } | null = null;

function nodeIdAt(x: number, y: number): number | null {
    const hit = document.elementFromPoint(x, y);
    const element = hit?.closest<HTMLElement>('.mdag-node');
    return element && host.contains(element) ? Number(element.dataset.id) : null;
}

function beginDrag(kind: Drag['kind'], from: number, event: PointerEvent, sources: number[] = [from]): void {
    drag = { kind, from, sources, start: { x: event.clientX, y: event.clientY }, active: kind === 'connect', target: null, ghost: null, pointerId: event.pointerId };
    if (kind === 'connect') stage.classList.add('is-dragging');
}

function moveDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
        if (Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 6) return;
        drag.active = true;
        stage.classList.add('is-dragging');
        const ghost = document.createElement('div');
        ghost.className = 'ed-ghost';
        ghost.textContent = nameOf(drag.from);
        stage.append(ghost);
        drag.ghost = ghost;
    }
    const stageRect = stage.getBoundingClientRect();
    const x = event.clientX - stageRect.left;
    const y = event.clientY - stageRect.top;
    if (drag.ghost) place(drag.ghost, x, y);
    const over = nodeIdAt(event.clientX, event.clientY);
    drag.target = over !== null && over !== drag.from && !drag.sources.includes(over) ? over : null;
    const targetBox = drag.target !== null ? boxOf(drag.target) : null;
    targetFrame.hidden = !targetBox;
    if (targetBox) {
        const rect = localRect(targetBox);
        Object.assign(targetFrame.style, { left: `${rect.left - 5}px`, top: `${rect.top - 4}px`, width: `${rect.width + 10}px`, height: `${rect.height + 8}px` });
    }
    if (drag.kind === 'connect') {
        const tx = targetBox ? localRect(targetBox).left - 4 : x;
        const ty = targetBox ? localRect(targetBox).top + localRect(targetBox).height / 2 : y;
        // 1 つからなら右上のつまみから、複数からならそれぞれの右端の中ほどから、1 点へ集まる線を引く
        const starts = drag.sources.flatMap((id) => {
            const found = boxOf(id);
            if (!isVisible(found)) return [];
            const rect = localRect(found);
            return drag && drag.sources.length === 1 ? [{ x: rect.right + 7, y: rect.top }] : [{ x: rect.right + 2, y: rect.top + rect.height / 2 }];
        });
        const paths = wire.querySelectorAll('path');
        for (let index = paths.length; index < starts.length; index++) wire.insertBefore(document.createElementNS('http://www.w3.org/2000/svg', 'path'), wire.querySelector('circle'));
        wire.querySelectorAll('path').forEach((path, index) => {
            const start = starts[index];
            if (!start) {
                path.setAttribute('d', '');
                return;
            }
            const bend = Math.max(40, Math.abs(tx - start.x) / 2);
            path.setAttribute('d', `M${start.x},${start.y} C${start.x + bend},${start.y} ${tx - bend},${ty} ${tx},${ty}`);
        });
        wire.style.display = '';
        const dot = wire.querySelector('circle');
        dot?.setAttribute('cx', String(tx));
        dot?.setAttribute('cy', String(ty));
    }
}

function endDrag(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const finished = drag;
    drag = null;
    finished.ghost?.remove();
    wire.style.display = 'none';
    targetFrame.hidden = true;
    stage.classList.remove('is-dragging');
    if (!finished.active) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    if (finished.target === null) {
        if (finished.kind === 'move') showToast('ほかのノードの上で離すと、その下へ移ります');
        return;
    }
    if (finished.kind === 'connect' && finished.sources.length > 1) {
        apply(ops.addJoin(ctx, finished.sources, finished.target));
    } else if (finished.kind === 'connect') {
        if (apply(ops.addRelation(ctx, finished.from, finished.target))) selectNewEdge(finished.from, finished.target);
    } else {
        apply(ops.moveNode(ctx, finished.from, finished.target), {});
    }
}

function selectNewEdge(from: number, to: number): void {
    const key = [...host.querySelectorAll<SVGPathElement>('path.mdag-edge')].map((path) => path.dataset.key ?? '').find((candidate) => candidate.endsWith(`:${from}>${to}`) && !candidate.startsWith('tree:'));
    if (key) select({ type: 'edge', key });
    showToast(`「${nameOf(from)}」→「${nameOf(to)}」を depends に足しました`);
}

// 図の中のクリックの前に受ける (タスクの切り替えや、図のパンより先に)
stage.addEventListener(
    'pointerdown',
    (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        // 詳細の入力欄の外を押したら保存して閉じる (範囲選択やドラッグで既定の動作を止めると、フォーカスが移らず focusout が来ない)
        if (detailsEditing !== null && !target.closest('.ed-details-editor')) closeDetailsEditor(true);
        if (tagPanel.mode !== null && !target.closest('.ed-tag-panel, .ed-tools')) closeTagPanel();
        if (target.closest('.ed-groups')) return;
        if (renaming) return;
        // 原文の欄などにフォーカスが残ったままだと、Backspace や Enter がそちらへ入るので、キャンバスへ移す
        // (ノードのドラッグで pointerdown の既定の動作を止めるため、ブラウザはフォーカスを移さない)
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused !== stage && !stage.contains(focused)) stage.focus({ preventScroll: true });
        // 中ボタンのドラッグは、どの道具でも図を動かす (d3-zoom は左ボタンしか受けない)
        if (event.button === 1) {
            event.preventDefault();
            panning = { last: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId };
            stage.classList.add('is-panning');
            return;
        }
        if (event.button !== 0) return;
        // 手のひらの道具と Space を押している間は、図のパンに任せる
        if (tool === 'pan' || spaceHeld) return;
        if (target === connectHandle && selection?.type === 'node') {
            event.preventDefault();
            event.stopPropagation();
            beginDrag('connect', selection.id, event);
            return;
        }
        if (target === connectHandle && selection?.type === 'nodes') {
            event.preventDefault();
            event.stopPropagation();
            beginDrag('connect', selection.ids[selection.ids.length - 1] ?? 0, event, selection.ids);
            return;
        }
        const box = target.closest('.mdag-box');
        const element = box?.closest<HTMLElement>('.mdag-node');
        if (!box || !element) {
            // 何もないところからのドラッグは、範囲で選ぶ。指でのドラッグは図のパンのままにする
            if (tool === 'select' && event.pointerType !== 'touch' && target.closest('.mdag-viewport') && !target.closest('.mdag-fold, .mdag-legend, .mdag-popover, .mdag-note-mark, a')) {
                event.preventDefault();
                event.stopPropagation();
                const additive = event.shiftKey || event.metaKey || event.ctrlKey;
                marquee = { start: { x: event.clientX, y: event.clientY }, base: additive ? selectedIds() : [], pointerId: event.pointerId, moved: false };
            }
            return;
        }
        if (target.closest('a, .mdag-note-mark, input, button')) return;
        const id = Number(element.dataset.id);
        // Shift / Ctrl / ⌘ を押しながらのクリックは選択に足すだけにする (ドラッグで付け替えず、文字の選択も広げない)
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            event.preventDefault();
            window.getSelection()?.removeAllRanges();
            return;
        }
        if (tool === 'connect') {
            event.preventDefault();
            beginDrag('connect', connectFrom ?? id, event);
        } else if (tool === 'select' && nodeOf(id)?.parent !== null) {
            event.preventDefault();
            beginDrag('move', id, event);
        }
    },
    { capture: true },
);
// 範囲選択と中ボタンのパンの間は、d3-zoom のパン (mousedown で始まる) を止める
stage.addEventListener(
    'mousedown',
    (event) => {
        if (marquee || panning) event.stopPropagation();
    },
    { capture: true },
);

function moveMarquee(event: PointerEvent): void {
    if (!marquee || event.pointerId !== marquee.pointerId) return;
    if (!marquee.moved && Math.hypot(event.clientX - marquee.start.x, event.clientY - marquee.start.y) < 4) return;
    marquee.moved = true;
    const stageRect = stage.getBoundingClientRect();
    const left = Math.min(marquee.start.x, event.clientX);
    const top = Math.min(marquee.start.y, event.clientY);
    const right = Math.max(marquee.start.x, event.clientX);
    const bottom = Math.max(marquee.start.y, event.clientY);
    marqueeBox.hidden = false;
    Object.assign(marqueeBox.style, { left: `${left - stageRect.left}px`, top: `${top - stageRect.top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    // 範囲にかかったノードを、選んでいたノードの後ろに足す (ルートは合流の始点にならないので外す)
    const hits = [...host.querySelectorAll<HTMLElement>('.mdag-node')]
        .filter((element) => {
            const found = element.querySelector('.mdag-box');
            if (!isVisible(found)) return false;
            const rect = found.getBoundingClientRect();
            return rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
        })
        .map((element) => Number(element.dataset.id))
        .filter((id) => nodeOf(id)?.parent !== null && !marquee?.base.includes(id))
        .sort((a, b) => a - b);
    const ids = [...marquee.base, ...hits];
    selection = ids.length === 0 ? null : ids.length === 1 ? { type: 'node', id: ids[0] ?? 0 } : { type: 'nodes', ids };
}

function endMarquee(event: PointerEvent): void {
    if (!marquee || event.pointerId !== marquee.pointerId) return;
    const finished = marquee;
    marquee = null;
    marqueeBox.hidden = true;
    if (!finished.moved) return;
    suppressClick = true;
    window.setTimeout(() => (suppressClick = false), 0);
    select(selection);
}

let panning: { last: { x: number; y: number }; pointerId: number } | null = null;
let spaceHeld = false;

function setSpaceHeld(next: boolean): void {
    spaceHeld = next;
    stage.classList.toggle('is-space', next);
}

window.addEventListener('pointermove', (event) => {
    moveDrag(event);
    moveMarquee(event);
    if (panning && event.pointerId === panning.pointerId) {
        diagram.view.panBy(event.clientX - panning.last.x, event.clientY - panning.last.y);
        panning.last = { x: event.clientX, y: event.clientY };
    }
});
window.addEventListener('pointerup', (event) => {
    endDrag(event);
    endMarquee(event);
    if (panning && event.pointerId === panning.pointerId) {
        panning = null;
        stage.classList.remove('is-panning');
    }
});
// 中ボタンの押し下げでブラウザの自動スクロールが始まらないようにする
stage.addEventListener('auxclick', (event) => event.button === 1 && event.preventDefault());
window.addEventListener('pointercancel', (event) => {
    if (marquee && event.pointerId === marquee.pointerId) {
        marquee = null;
        marqueeBox.hidden = true;
    }
    if (drag && event.pointerId === drag.pointerId) {
        drag.ghost?.remove();
        drag = null;
        wire.style.display = 'none';
        targetFrame.hidden = true;
        stage.classList.remove('is-dragging');
    }
});

// タスクの状態の絵 (ノードの内容の先頭の SVG) か
const isTaskIcon = (target: Element): boolean => {
    const svg = target.closest('svg');
    return svg !== null && svg.parentElement?.classList.contains('mdag-task-label') === true && svg.parentElement.firstElementChild === svg;
};

stage.addEventListener(
    'click',
    (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest('.ed-tools, .ed-ctx, .ed-handle, .ed-rename, .ed-toast, .ed-details-editor, .ed-tag-panel, .ed-groups')) return;
        if (suppressClick) {
            event.stopPropagation();
            return;
        }
        // 吹き出しの中: タグを押したらタグの編集。それ以外は図に任せる (選択は変えない)
        const popover = target.closest('.mdag-popover');
        if (popover) {
            const tags = target.closest('.mdag-popover-tags');
            if (tags && hoveredNode !== null && tool === 'select') {
                event.stopPropagation();
                editTagAt(hoveredNode, tags, event);
            }
            return;
        }
        const box = target.closest('.mdag-box');
        const element = box?.closest<HTMLElement>('.mdag-node');
        if (box && element) {
            const id = Number(element.dataset.id);
            if (target.closest('a, .mdag-note-mark')) return;
            // ノードの中のタグを押したら、そのタグの編集を開く
            const tags = target.closest('.mdag-tags');
            if (tags && tool === 'select' && !(event.shiftKey || event.metaKey || event.ctrlKey)) {
                event.stopPropagation();
                editTagAt(id, tags, event);
                return;
            }
            // タスクの絵のクリックは図に任せる (状態が進み、onChange で原文が届く)。それ以外のクリックは選ぶだけにする
            if (!isTaskIcon(target)) event.stopPropagation();
            if (tool === 'join') {
                const sources = joinSources;
                setTool('select');
                apply(ops.addJoin(ctx, sources, id));
            } else if (tool === 'select' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
                if (nodeOf(id)?.parent === null) showToast('ルートは合流の始点にできません', 'error');
                else toggleNode(id);
            } else if (tool === 'connect') {
                // クリックだけで引く (ドラッグせずに離した) とき
                if (connectFrom === null) {
                    connectFrom = id;
                    select({ type: 'node', id });
                    updateHint();
                } else if (connectFrom !== id) {
                    const from = connectFrom;
                    setTool('select');
                    if (apply(ops.addRelation(ctx, from, id))) selectNewEdge(from, id);
                }
            } else {
                select({ type: 'node', id });
            }
            return;
        }
        const hit = target.closest<SVGElement>('.mdag-edge-hit');
        if (hit?.dataset.key) {
            const key = hit.dataset.key;
            // 図の側でも選択が切り替わる (同じ線をもう 1 度押すと解く)
            window.setTimeout(() => select(selection?.type === 'edge' && selection.key === key ? null : { type: 'edge', key }), 0);
            return;
        }
        // グループの枠かラベルを押したら、グループを選ぶ (同じ枠をもう 1 度押すと解く。図の側の強調も同じように切り替わる)
        const frame = target.closest<SVGElement>('.mdag-frames [data-group]');
        if (frame?.dataset.group && tool === 'select') {
            const id = frame.dataset.group;
            window.setTimeout(() => select(selection?.type === 'group' && selection.id === id ? null : { type: 'group', id }), 0);
            return;
        }
        if (target.closest('.mdag-fold, [data-group]')) return;
        if (tool === 'connect' || tool === 'join') setTool('select');
        // Shift / Ctrl / ⌘ を押しながら何もないところを押しても、選んだものは解かない
        if ((event.shiftKey || event.metaKey || event.ctrlKey) && tool === 'select') return;
        if (tool === 'pan') return;
        select(null);
    },
    { capture: true },
);

stage.addEventListener(
    'dblclick',
    (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest('.ed-tools, .ed-ctx, .ed-handle, .ed-rename, .ed-details-editor, .ed-tag-panel, .ed-groups')) return;
        event.stopPropagation();
        // ダブルクリックした部分で分ける。詳細 (ノードの中に開いたものと吹き出しの中のもの) は詳細の編集、
        // タグはタグの編集、それ以外のノードの部分はラベル (名前) の変更、グループの枠かラベルならグループの名前の変更。
        // 何もないところのダブルクリックでは何もしない (図のズームもしない)
        const popover = target.closest('.mdag-popover');
        if (popover) {
            if (hoveredNode === null || !nodeOf(hoveredNode)) return;
            const id = hoveredNode;
            const tags = target.closest('.mdag-popover-tags');
            if (tags) editTagAt(id, tags, event);
            else if (target.closest('.mdag-details')) {
                select({ type: 'node', id }, false);
                openDetailsEditor(id);
            }
            return;
        }
        const element = target.closest('.mdag-box')?.closest<HTMLElement>('.mdag-node');
        const frame = target.closest<SVGElement>('.mdag-frames [data-group]');
        if (element) {
            const id = Number(element.dataset.id);
            const tags = target.closest('.mdag-tags');
            if (tags) editTagAt(id, tags, event);
            else if (target.closest('.mdag-details')) {
                select({ type: 'node', id }, false);
                openDetailsEditor(id);
            } else startRename(id, false);
        } else if (frame?.dataset.group) {
            const id = frame.dataset.group;
            select({ type: 'group', id }, false);
            startGroupRename(id);
        }
    },
    { capture: true },
);

connectHandle.addEventListener('click', (event) => event.stopPropagation());
childHandle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (selection?.type === 'node') apply(ops.addChild(ctx, selection.id), { rename: true });
});
siblingHandle.addEventListener('click', (event) => {
    event.stopPropagation();
    if (selection?.type === 'node') apply(ops.addSibling(ctx, selection.id), { rename: true });
});

// ---- キーボード --------------------------------------------------------------------------------------------------

// マウスカーソルの位置。ウィンドウの外へ出たら null にする (矢印キーで最初に選ぶノードを決めるのに使う)
let pointerAt: { x: number; y: number } | null = null;
window.addEventListener('pointermove', (event) => (pointerAt = { x: event.clientX, y: event.clientY }), { capture: true });
document.documentElement.addEventListener('mouseleave', () => (pointerAt = null));

// 描いてあるノードのうち、点にいちばん近いもの (箱の中なら距離 0)
function nearestNode(point: { x: number; y: number }): number | null {
    let best: { id: number; distance: number } | null = null;
    for (const element of host.querySelectorAll<HTMLElement>('.mdag-node')) {
        const found = element.querySelector('.mdag-box');
        if (!isVisible(found)) continue;
        const rect = found.getBoundingClientRect();
        const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
        const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
        const distance = Math.hypot(dx, dy);
        if (!best || distance < best.distance) best = { id: Number(element.dataset.id), distance };
    }
    return best?.id ?? null;
}

// ノードを画面の上の並び (上から下、同じ高さなら左から右) にそろえる。描いていないノードがあれば文書の順のまま
function inScreenOrder(nodes: OutlineNode[]): OutlineNode[] {
    const rects = nodes.map((node) => {
        const found = boxOf(node.id);
        return isVisible(found) ? found.getBoundingClientRect() : null;
    });
    if (rects.some((rect) => rect === null)) return nodes;
    return nodes
        .map((node, index) => ({ node, rect: rects[index] as DOMRect }))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map((item) => item.node);
}

// 矢印キーで選ぶノードを移す。左は親、右は子のいちばん上、上下は兄弟 (端では反対の端へ回る)。
// 何も選んでいなければ、マウスカーソルにいちばん近いノード (カーソルがウィンドウの外ならルート) を選ぶ
function moveSelection(key: string): void {
    const current = selection?.type === 'node' ? selection.id : selection?.type === 'nodes' ? (selection.ids[selection.ids.length - 1] ?? null) : null;
    const node = current === null ? undefined : nodeOf(current);
    if (!node) {
        const root = ctx.parsed.nodes.find((item) => item.parent === null);
        const start = (pointerAt && nearestNode(pointerAt)) ?? root?.id;
        if (start !== undefined) select({ type: 'node', id: start });
        return;
    }
    let next: OutlineNode | undefined;
    if (key === 'ArrowLeft') next = node.parent === null ? undefined : nodeOf(node.parent);
    else if (key === 'ArrowRight') next = inScreenOrder(ctx.parsed.nodes.filter((other) => other.parent === node.id))[0];
    else {
        const siblings = inScreenOrder(ctx.parsed.nodes.filter((other) => other.parent === node.parent));
        const index = siblings.indexOf(node);
        if (siblings.length > 1) next = siblings[(index + (key === 'ArrowDown' ? 1 : -1) + siblings.length) % siblings.length];
    }
    if (!next) return;
    const id = next.id;
    diagram.view.revealNode(id);
    select({ type: 'node', id });
    // 選んだノードが画面の外なら、見える所まで図を動かす (畳んだ枝を開いたときは配置が変わるので、次のコマで測る)
    requestAnimationFrame(() => scrollIntoView(id));
}

function scrollIntoView(id: number): void {
    const found = boxOf(id);
    if (!isVisible(found)) return;
    const rect = found.getBoundingClientRect();
    const view = stage.getBoundingClientRect();
    const margin = 48;
    const dx = rect.left < view.left + margin ? view.left + margin - rect.left : rect.right > view.right - margin ? view.right - margin - rect.right : 0;
    const dy = rect.top < view.top + margin ? view.top + margin - rect.top : rect.bottom > view.bottom - margin ? view.bottom - margin - rect.bottom : 0;
    if (dx !== 0 || dy !== 0) diagram.view.panBy(dx, dy);
}

document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'g') {
        // ブラウザの「次を検索」より先に受ける
        event.preventDefault();
        groupSelection();
        return;
    }
    if (mod || event.altKey) return;
    const nodeId = selection?.type === 'node' ? selection.id : null;
    switch (event.key) {
        case 'Tab':
            if (nodeId === null) return;
            event.preventDefault();
            apply(ops.addChild(ctx, nodeId), { rename: true });
            break;
        case 'Enter':
            // 選んだノードの名前の入力へ入る (入力中の Enter は、決めて兄弟を足す)
            if (selection?.type === 'group') {
                event.preventDefault();
                startGroupRename(selection.id);
                break;
            }
            if (nodeId === null) return;
            event.preventDefault();
            startRename(nodeId, false);
            break;
        case 'F2':
            if (nodeId === null) return;
            event.preventDefault();
            startRename(nodeId, false);
            break;
        case 'Delete':
        case 'Backspace':
            event.preventDefault();
            if (nodeId !== null) apply(ops.deleteNode(ctx, nodeId));
            else if (selection?.type === 'nodes') deleteNodes(selection.ids);
            else if (selection?.type === 'edge') {
                const edge = ops.parseEdgeKey(selection.key);
                if (edge) apply(ops.deleteEdge(ctx, edge));
            }
            break;
        case 't':
        case 'T':
            if (selectedIds().length === 0) return;
            event.preventDefault();
            openTagPanel('new');
            break;
        case 'd':
        case 'D':
            if (nodeId === null) return;
            event.preventDefault();
            openDetailsEditor(nodeId);
            break;
        case 'Escape':
            setFlyout(false);
            closeTagPanel();
            setTool('select');
            select(null);
            break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
            event.preventDefault();
            moveSelection(event.key);
            break;
        case 'v':
        case 'V':
            setTool('select');
            break;
        case 'h':
        case 'H':
            setTool('pan');
            break;
        case ' ':
            event.preventDefault();
            if (!event.repeat) setSpaceHeld(true);
            break;
        case 'c':
        case 'C':
        case 'l':
        case 'L':
            setTool('connect');
            if (nodeId !== null) connectFrom = nodeId;
            updateHint();
            break;
        case 'j':
        case 'J':
            joinIntoNewNode();
            break;
        case 'f':
        case 'F':
            fitView();
            break;
        default:
            return;
    }
    // キーで操作したら、道具箱のボタンに残ったフォーカスの枠を消す (今の道具の強調だけを見せる)
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('.ed-tools')) focused.blur();
});

document.addEventListener('keyup', (event) => {
    if (event.key === ' ') setSpaceHeld(false);
});
window.addEventListener('blur', () => setSpaceHeld(false));

// ---- 上の帯と道具箱 ----------------------------------------------------------------------------------------------

for (const button of app.querySelectorAll<HTMLButtonElement>('.ed-tool[data-tool]')) {
    button.addEventListener('click', () => setTool((button.dataset.tool ?? 'select') as Tool));
}
// 道具箱のボタンは押したあとフォーカスを外す。残すと、あとでキーで道具を替えたときに、
// 押された道具とは別のボタンにフォーカスの枠が出て、どちらが今の道具か分かりにくい
for (const button of app.querySelectorAll<HTMLButtonElement>('.ed-tool')) button.addEventListener('click', () => button.blur());
$('.ed-join-tool').addEventListener('click', () => {
    if (selectedIds().length >= 2) joinIntoNewNode();
    else showToast('何もないところからドラッグして 2 つ以上を囲むと、選んだノードを新しいノードへ合流させます');
});
$('.ed-tag-new-tool').addEventListener('click', () => openTagPanel('new'));
$('.ed-tag-pick-tool').addEventListener('click', () => openTagPanel('pick'));
$('.ed-group-tool').addEventListener('click', () => {
    if (selectedIds().length >= 1) groupSelection();
    else showToast('何もないところからドラッグしてノードを囲むと、選んだノードをグループにまとめます');
});
undoButton.addEventListener('click', undo);
redoButton.addEventListener('click', redo);
$('.ed-fit').addEventListener('click', fitView);

sampleSelect.addEventListener('change', () => {
    const sample = SAMPLES[sampleSelect.value];
    if (!sample) return;
    select(null);
    commit(sample.text);
    fitView();
});

const toggleMd = $<HTMLButtonElement>('.ed-toggle-md');
toggleMd.addEventListener('click', () => {
    const shown = main.dataset.md !== 'shown';
    main.dataset.md = shown ? 'shown' : 'hidden';
    toggleMd.setAttribute('aria-pressed', String(shown));
});

$('.ed-copy').addEventListener('click', () => {
    // クリップボードに書けない環境では、原文の欄を全部選んで、手でコピーしてもらう
    const fallback = (): void => {
        main.dataset.md = 'shown';
        textarea.focus();
        textarea.select();
        showToast('原文を選択しました。Ctrl+C (⌘C) でコピーしてください');
    };
    try {
        navigator.clipboard.writeText(source).then(() => showToast('原文をコピーしました'), fallback);
    } catch {
        fallback();
    }
});

// 埋め込まれたページ (iframe) ではダウンロードが止められるので、保存のボタンを出さない
const downloadButton = $<HTMLButtonElement>('.ed-download');
if (window.self !== window.top) downloadButton.hidden = true;
downloadButton.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([source], { type: 'text/markdown' }));
    link.download = 'board.md';
    link.click();
    URL.revokeObjectURL(link.href);
});

function applyTheme(next: 'dark' | 'light'): void {
    theme = next;
    document.documentElement.dataset.theme = next;
    themeButton.textContent = next === 'dark' ? 'ライト' : 'ダーク';
    diagram?.view.setOptions({ theme: next });
}
themeButton.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));

// ---- 起動 --------------------------------------------------------------------------------------------------------

await init(wasmSource());
ctx = contextOf(source);
// ページを置く側が明暗を決めていればそれに従い、決めていなければ暗い配色で始める
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
diagram = render(host, source, {
    theme,
    details: detailsMode,
    // タスクの絵のクリックで原文が書き換わった
    onChange: (next) => commit(next, { drawn: true }),
});
stage.tabIndex = -1;
textarea.value = source;
renderMirror();
showDiagnostics(diagram.diagnostics);
setTool('select');
setDetailsMode(detailsMode, false);
renderGroupList();
updateUndoButtons();
fitView();
requestAnimationFrame(positionOverlay);

// 図の側から Markdown を書き換える試作のエディタ (ホワイトボード風)。
// 左に原文、右に markdag の図を置き、図の上の操作 (ノードの追加、削除、名前の変更、ドラッグでの付け替え、線の追加と削除) を
// editor/ops.ts の書き換えで原文に反映して描き直す。原文を直接書き換えても図が追う。
import notationSample from '../docs/examples/notation.md?raw';
import groupsCross from './samples/groups-cross.md?raw';
import groupsLeavesColors from './samples/groups-leaves-colors.md?raw';
import groupsNested from './samples/groups-nested.md?raw';
import groupsPhases from './samples/groups-phases.md?raw';
import groupsSiblings from './samples/groups-siblings.md?raw';
import { buildModel, formatDiagnostics, init, parseDocument, render, type Diagnostic, type MarkdagDiagram, type OutlineNode } from '../src/core';
import styleText from './editor.css?inline';
import * as ops from './ops';
import { wasmSource } from './wasm-source';

const SIMPLE_SAMPLE = `---
markdag:
    relations:
        depends:
            - 調査 --> 設計
---

# 企画

## 調査
- ユーザーインタビュー
- 競合の比較

## 設計
- 画面
- API

## 実装
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
    empty: { label: '空のボード', text: EMPTY_SAMPLE },
};

type Tool = 'select' | 'connect' | 'add';
type Selection = { type: 'node'; id: number } | { type: 'edge'; key: string } | null;

const ICONS = {
    select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z"/></svg>',
    connect: '<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><path d="M7 17C12 16 12 8 17 7"/><path d="M14 5l3 2-2 3"/></svg>',
    add: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M12 9v6M9 12h6"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 12h-2" transform="translate(0 -6)"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 12h2" transform="translate(0 -6)"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    child: '<svg viewBox="0 0 24 24"><path d="M4 6h6M10 6v12h4M10 12h4"/><rect x="15" y="10" width="5" height="4" rx="1"/><rect x="15" y="16" width="5" height="4" rx="1"/></svg>',
    sibling: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="6" rx="1.5"/><path d="M12 13v7M8.5 16.5h7"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/></svg>',
    reverse: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>',
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
                <div class="ed-handle ed-handle-connect" title="ドラッグしてほかのノードへ線を引く" hidden></div>
                <div class="ed-handle ed-handle-add ed-handle-child" title="子を足す (Tab)" hidden>+</div>
                <div class="ed-handle ed-handle-add ed-handle-sibling" title="兄弟を足す (Enter)" hidden>+</div>
                <div class="ed-ctx" hidden></div>
            </div>
            <nav class="ed-tools" aria-label="道具">
                <button class="ed-tool" data-tool="select" title="選ぶ・動かす (V)">${ICONS.select}</button>
                <button class="ed-tool" data-tool="connect" title="線を引く (C)">${ICONS.connect}</button>
                <button class="ed-tool" data-tool="add" title="ノードを足す (N)">${ICONS.add}</button>
                <hr>
                <button class="ed-tool ed-undo" title="元に戻す (Ctrl+Z)">${ICONS.undo}</button>
                <button class="ed-tool ed-redo" title="やり直す (Ctrl+Shift+Z)">${ICONS.redo}</button>
                <button class="ed-tool ed-fit" title="全体を表示 (F)">${ICONS.fit}</button>
            </nav>
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
let renaming: { id: number; input: HTMLInputElement } | null = null;

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
    else if (selection?.type === 'edge' && !host.querySelector(`.mdag-edge[data-key="${CSS.escape(selection.key)}"]`)) selection = null;
    if (selection?.type === 'node') diagram.view.revealNode(selection.id);
    if (selection?.type !== 'edge') diagram.view.selectEdge(null);

    if (!options.fromText) writeText(next, changedLines(previous, next));
    else renderMirror(changedLines(previous, next));
    showDiagnostics(diagnostics);
    updateUndoButtons();
    if (options.message) showToast(options.message);
    if (options.rename && selection?.type === 'node') {
        const id = selection.id;
        requestAnimationFrame(() => startRename(id, true));
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
            if (selected && index >= selected.start && index < selected.end) row.className = 'is-selected';
            if (flashLines.has(index)) row.classList.add('is-flash');
            return row;
        }),
    );
    linesLabel.textContent = `${lines.length} 行`;
    syncMirrorScroll();
}

// 選んだノードの行だけを塗り直す (変わった行の点滅は残す)
function paintSelectedLines(): void {
    const selected = selectedLines();
    [...mirror.children].forEach((row, index) => row.classList.toggle('is-selected', selected !== null && index >= selected.start && index < selected.end));
}

function selectedLines(): { start: number; end: number } | null {
    if (selection?.type !== 'node') return null;
    return nodeOf(selection.id)?.lines ?? null;
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
    selection = next;
    if (next?.type === 'edge') diagram.view.selectEdge(next.key);
    else diagram.view.selectEdge(null);
    paintSelectedLines();
    const lines = selectedLines();
    if (lines && scrollText) scrollTextTo(lines.start);
    renderContextBar();
    updateHint();
}

function renderContextBar(): void {
    ctxBar.innerHTML = '';
    const button = (icon: string, label: string, title: string, run: () => void, danger = false): void => {
        const element = document.createElement('button');
        element.innerHTML = `${icon}<span>${label}</span>`;
        element.title = title;
        if (danger) element.className = 'is-danger';
        element.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        ctxBar.append(element);
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
        if (!isRoot) button(ICONS.sibling, '兄弟', '兄弟を足す (Enter)', () => apply(ops.addSibling(ctx, id), { rename: true }));
        button(ICONS.connect, '線', 'ここから線を引く (次にクリックしたノードへ)', () => {
            setTool('connect');
            connectFrom = id;
            updateHint();
        });
        if (!isRoot) {
            separator();
            button(ICONS.trash, '削除', '配下ごと消す (Delete)', () => apply(ops.deleteNode(ctx, id)), true);
        }
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
    diagram.view.panBy(28, 0);
}

function setTool(next: Tool): void {
    tool = next;
    connectFrom = null;
    stage.dataset.tool = next;
    for (const button of app.querySelectorAll<HTMLButtonElement>('.ed-tool[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === next));
    updateHint();
}

function updateHint(): void {
    const k = (key: string): string => `<kbd>${key}</kbd>`;
    let text: string;
    if (tool === 'connect') text = connectFrom === null ? '線の始点のノードをクリック (またはノードからドラッグ)' : `「${nameOf(connectFrom)}」から線を引く先のノードをクリック ${k('Esc')} でやめる`;
    else if (tool === 'add') text = 'ノードをクリックで子を足す / 何もないところをクリックで最上位に足す';
    else if (selection?.type === 'node') text = `${k('Tab')} 子 ${k('Enter')} 兄弟 ${k('F2')} 名前 ${k('Del')} 削除 ${k('←↑↓→')} 移動 / ドラッグでほかのノードの下へ`;
    else if (selection?.type === 'edge') text = `${k('Del')} 線を削除`;
    else text = `クリックで選ぶ / ダブルクリックでノードを足す / ノードの右の点をドラッグで線を引く ${k('Ctrl+Z')} 戻す`;
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

function startRename(id: number, selectAll: boolean): void {
    finishRename(false);
    const node = nodeOf(id);
    const label = node ? ops.labelOf(source, node) : null;
    if (label === null) {
        showToast('このノードは名前を変えられません', 'error');
        return;
    }
    const input = document.createElement('input');
    input.className = 'ed-rename';
    input.value = label;
    stage.append(input);
    renaming = { id, input };
    positionRename();
    input.focus();
    if (selectAll) input.select();
    else input.setSelectionRange(label.length, label.length);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            finishRename(true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finishRename(false);
        } else if (event.key === 'Tab') {
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
    const { id, input } = renaming;
    renaming = null;
    input.remove();
    if (save) {
        const result = ops.renameNode(ctx, id, input.value, parseDocument);
        if (result.ok) apply(result);
        else if (result.message) showToast(result.message, 'error');
    }
    stage.focus({ preventScroll: true });
}

function positionRename(): void {
    if (!renaming) return;
    const box = boxOf(renaming.id);
    if (!isVisible(box)) return;
    const stageRect = stage.getBoundingClientRect();
    const rect = box.getBoundingClientRect();
    const k = diagram.view.getTransform().k;
    const input = renaming.input;
    input.style.left = `${rect.left - stageRect.left - 8}px`;
    input.style.top = `${rect.top - stageRect.top + rect.height / 2 - (20 * k + 8) / 2}px`;
    input.style.width = `${Math.max(160, rect.width + 40)}px`;
    input.style.fontSize = `${16 * k}px`;
    input.style.lineHeight = `${20 * k}px`;
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
    connectHandle.hidden = !showNode || tool !== 'select';
    childHandle.hidden = !showNode || tool !== 'select';
    siblingHandle.hidden = !showNode || tool !== 'select' || nodeOf(selection?.type === 'node' ? selection.id : 0)?.parent === null;
    let anchor: DOMRect | null = null;
    if (showNode && box) {
        const rect = localRect(box);
        anchor = rect;
        Object.assign(selFrame.style, { left: `${rect.left - 5}px`, top: `${rect.top - 4}px`, width: `${rect.width + 10}px`, height: `${rect.height + 8}px` });
        // 右下には開閉の円が来るので、つまみは右上に並べる
        place(connectHandle, rect.right + 7, rect.top);
        place(childHandle, rect.right + 30, rect.top);
        place(siblingHandle, rect.left + rect.width / 2, rect.bottom + 18);
    }
    if (selection?.type === 'edge') {
        const path = host.querySelector(`path.mdag-edge[data-key="${CSS.escape(selection.key)}"]`);
        if (path) anchor = localRect(path);
    }
    ctxBar.hidden = anchor === null || drag !== null || renaming !== null;
    if (anchor && !ctxBar.hidden) {
        const width = ctxBar.offsetWidth;
        const x = Math.min(Math.max(8, anchor.left + anchor.width / 2 - width / 2), stage.clientWidth - width - 8);
        const above = anchor.top - ctxBar.offsetHeight - 14;
        place(ctxBar, x, above > 8 ? above : anchor.bottom + (selection?.type === 'node' ? 34 : 12));
    }
    positionRename();
    fitView();
requestAnimationFrame(positionOverlay);
}

// ---- ドラッグ (線を引く / ほかのノードの下へ移す) -----------------------------------------------------------------

interface Drag {
    kind: 'connect' | 'move';
    from: number;
    start: { x: number; y: number };
    active: boolean;
    target: number | null;
    ghost: HTMLDivElement | null;
    pointerId: number;
}
let drag: Drag | null = null;
let suppressClick = false;

function nodeIdAt(x: number, y: number): number | null {
    const hit = document.elementFromPoint(x, y);
    const element = hit?.closest<HTMLElement>('.mdag-node');
    return element && host.contains(element) ? Number(element.dataset.id) : null;
}

function beginDrag(kind: Drag['kind'], from: number, event: PointerEvent): void {
    drag = { kind, from, start: { x: event.clientX, y: event.clientY }, active: kind === 'connect', target: null, ghost: null, pointerId: event.pointerId };
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
    drag.target = over !== null && over !== drag.from ? over : null;
    const targetBox = drag.target !== null ? boxOf(drag.target) : null;
    targetFrame.hidden = !targetBox;
    if (targetBox) {
        const rect = localRect(targetBox);
        Object.assign(targetFrame.style, { left: `${rect.left - 5}px`, top: `${rect.top - 4}px`, width: `${rect.width + 10}px`, height: `${rect.height + 8}px` });
    }
    if (drag.kind === 'connect') {
        const fromBox = boxOf(drag.from);
        if (!fromBox) return;
        const rect = localRect(fromBox);
        const sx = rect.right + 7;
        const sy = rect.top;
        const tx = targetBox ? localRect(targetBox).left - 4 : x;
        const ty = targetBox ? localRect(targetBox).top + localRect(targetBox).height / 2 : y;
        const bend = Math.max(40, Math.abs(tx - sx) / 2);
        wire.style.display = '';
        wire.querySelector('path')?.setAttribute('d', `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`);
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
    if (finished.kind === 'connect') {
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
        if (!target || event.button !== 0 || renaming) return;
        if (target === connectHandle && selection?.type === 'node') {
            event.preventDefault();
            event.stopPropagation();
            beginDrag('connect', selection.id, event);
            return;
        }
        const box = target.closest('.mdag-box');
        const element = box?.closest<HTMLElement>('.mdag-node');
        if (!box || !element || target.closest('a, .mdag-note-mark, input, button')) return;
        const id = Number(element.dataset.id);
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
window.addEventListener('pointermove', moveDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', (event) => {
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
        if (!target || target.closest('.ed-tools, .ed-ctx, .ed-handle, .ed-rename, .ed-toast')) return;
        if (suppressClick) {
            event.stopPropagation();
            return;
        }
        const box = target.closest('.mdag-box');
        const element = box?.closest<HTMLElement>('.mdag-node');
        if (box && element) {
            const id = Number(element.dataset.id);
            if (target.closest('a, .mdag-note-mark')) return;
            // タスクの絵のクリックは図に任せる (状態が進み、onChange で原文が届く)。それ以外のクリックは選ぶだけにする
            if (!isTaskIcon(target)) event.stopPropagation();
            if (tool === 'add') {
                apply(ops.addChild(ctx, id), { rename: true });
                setTool('select');
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
        if (target.closest('.mdag-fold, [data-group]')) return;
        if (tool === 'add') {
            apply(ops.addChild(ctx, 1), { rename: true });
            setTool('select');
            return;
        }
        if (tool === 'connect') setTool('select');
        select(null);
    },
    { capture: true },
);

stage.addEventListener(
    'dblclick',
    (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || target.closest('.ed-tools, .ed-ctx, .ed-handle, .ed-rename')) return;
        event.stopPropagation();
        const element = target.closest('.mdag-box')?.closest<HTMLElement>('.mdag-node');
        if (element) startRename(Number(element.dataset.id), false);
        else if (!target.closest('.mdag-edge-hit, .mdag-fold')) apply(ops.addChild(ctx, 1), { rename: true });
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

function moveSelection(key: string): void {
    if (selection?.type !== 'node') {
        const first = ctx.parsed.nodes[0];
        if (first) select({ type: 'node', id: first.id });
        return;
    }
    const node = nodeOf(selection.id);
    if (!node) return;
    const siblings = ctx.parsed.nodes.filter((other) => other.parent === node.parent);
    const index = siblings.indexOf(node);
    let next: OutlineNode | undefined;
    if (key === 'ArrowLeft') next = node.parent === null ? undefined : nodeOf(node.parent);
    else if (key === 'ArrowRight') next = ctx.parsed.nodes.find((other) => other.parent === node.id);
    else if (key === 'ArrowUp') next = siblings[index - 1];
    else if (key === 'ArrowDown') next = siblings[index + 1];
    if (next) {
        diagram.view.revealNode(next.id);
        select({ type: 'node', id: next.id });
    }
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
    if (mod || event.altKey) return;
    const nodeId = selection?.type === 'node' ? selection.id : null;
    switch (event.key) {
        case 'Tab':
            if (nodeId === null) return;
            event.preventDefault();
            apply(ops.addChild(ctx, nodeId), { rename: true });
            break;
        case 'Enter':
            if (nodeId === null) return;
            event.preventDefault();
            apply(nodeOf(nodeId)?.parent === null ? ops.addChild(ctx, nodeId) : ops.addSibling(ctx, nodeId), { rename: true });
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
            else if (selection?.type === 'edge') {
                const edge = ops.parseEdgeKey(selection.key);
                if (edge) apply(ops.deleteEdge(ctx, edge));
            }
            break;
        case 'Escape':
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
        case 'c':
        case 'C':
        case 'l':
        case 'L':
            setTool('connect');
            if (nodeId !== null) connectFrom = nodeId;
            updateHint();
            break;
        case 'n':
        case 'N':
            setTool('add');
            break;
        case 'f':
        case 'F':
            fitView();
            break;
        default:
            return;
    }
});

// ---- 上の帯と道具箱 ----------------------------------------------------------------------------------------------

for (const button of app.querySelectorAll<HTMLButtonElement>('.ed-tool[data-tool]')) {
    button.addEventListener('click', () => setTool((button.dataset.tool ?? 'select') as Tool));
}
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
    details: 'hover',
    // タスクの絵のクリックで原文が書き換わった
    onChange: (next) => commit(next, { drawn: true }),
});
stage.tabIndex = -1;
textarea.value = source;
renderMirror();
showDiagnostics(diagram.diagnostics);
setTool('select');
updateUndoButtons();
fitView();
requestAnimationFrame(positionOverlay);

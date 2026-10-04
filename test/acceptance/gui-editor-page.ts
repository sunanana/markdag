// GUI 編集の受け入れの例のうち、図を開いたページの中でしかできないことを受け持つ部品 (screen の面と、frontmatter の面の mount した図)。
// 例の書き方の押す相手 ({ node: 名前 } など) を画面の押せる点にし、段のあとに見えるもの (目印の有無と数、data- の値、選択、開いている入力、
// フォーカス、原文) を期待と同じ形の値で読む。座標、色、画像は読まない。図の API を呼ぶのは、例の段が求めるとき (setMode、undo など) だけ。
// 見た目の規則のうち、依頼者が照らすと決めた 2 つだけは読む: 隅の部品 (セグメントと凡例のパネル) が実際に寄っている隅 (座標は返さず隅の名前)、
// 選んだノードの箱に枠 (outline) が出ているか (有無だけ。色と太さは見ない)。
// 確認ページと e2e のページの両方が読む。ページの開発サーバーに依存を探させないよう、型のほかは何も import しない。
// 名前の引き方 (nodeOf) と押す相手の書き方 (describeTarget) は、ページの外 (例の読み方の部品) からも使うので、読み込んだだけでは DOM に触らない
import type { OutlineNode } from '../../src/core';
import type { EditorMode, MarkdagEditor } from '../../src/editor';

export interface Point {
    x: number;
    y: number;
}

// 例の書き方の押す相手 ({ node: 名前 }、{ blank: true }、{ legend_row: グループ } など)
export type Target = Record<string, unknown>;

export interface TransformLike {
    k: number;
    x: number;
    y: number;
}

export interface PageContext {
    container: HTMLElement;
    editor(): MarkdagEditor | null;
    // 図の外の入力欄 (フォーカスを図の外へ移す相手)
    outside(): HTMLElement;
}

// ---- ノードの名前 ----

// 名前 (refText) で 1 つに決まるノード。「親/名前」は親の名前で絞る。{ id } は id のまま
export function nodeOf(nodes: readonly OutlineNode[], ref: unknown): OutlineNode {
    if (ref !== null && typeof ref === 'object' && typeof (ref as { id?: unknown }).id === 'number') {
        const found = nodes.find((node) => node.id === (ref as { id: number }).id);
        if (!found) throw new Error(`id ${(ref as { id: number }).id} のノードがありません`);
        return found;
    }
    const text = String(ref);
    let candidates = nodes.filter((node) => node.refText === text);
    if (candidates.length === 0 && text.includes('/')) {
        const at = text.lastIndexOf('/');
        const parentName = text.slice(0, at);
        const name = text.slice(at + 1);
        candidates = nodes.filter((node) => node.refText === name && nodes.find((item) => item.id === node.parent)?.refText === parentName);
    }
    if (candidates.length === 0) throw new Error(`ノード「${text}」がありません`);
    if (candidates.length > 1) throw new Error(`ノード「${text}」が ${candidates.length} 個あります (親/名前 で書く)`);
    return candidates[0] as OutlineNode;
}

export function describeTarget(target: unknown): string {
    if (target === null || typeof target !== 'object') return String(target);
    return Object.entries(target as Record<string, unknown>)
        .map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(' ');
}

// ---- 待ち ----

export const frame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()));

// 段のあとの待ち: 描画の 2 コマと ms
export const settle = async (ms = 150): Promise<void> => {
    await frame();
    await frame();
    await new Promise((done) => window.setTimeout(done, ms));
};

// ---- 見えるもの ----

const visible = (element: Element | null | undefined): element is Element =>
    Boolean(element) && (element as Element).isConnected && (element as Element).checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true } as CheckVisibilityOptions);

const allVisible = (root: ParentNode, selector: string): Element[] => [...root.querySelectorAll(selector)].filter(visible);

// 箱が図の領域のどの隅に寄っているか (top-left など。左右の差が 2px 以内なら中央の center)。上下と左右それぞれ、箱の辺と図の領域の辺の近い方
function placeOf(container: HTMLElement, element: Element | undefined): string | null {
    if (!element) return null;
    const area = container.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const left = box.left - area.left;
    const right = area.right - box.right;
    const vertical = box.top - area.top <= area.bottom - box.bottom ? 'top' : 'bottom';
    const horizontal = Math.abs(left - right) <= 2 ? 'center' : left < right ? 'left' : 'right';
    return `${vertical}-${horizontal}`;
}

// 枠 (outline) が出ているか。線の種類が none でなく、太さがある
function outlined(element: Element | null): boolean {
    if (!element) return false;
    const style = getComputedStyle(element);
    return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
}

// 名前 (refText) と id。描いている文書から引く
function namesOf(editor: MarkdagEditor): { nodes: readonly OutlineNode[]; name(id: number): string; id(ref: unknown): number } {
    const nodes = editor.view.getDocument()?.parsed.nodes ?? [];
    return {
        nodes,
        name: (id) => {
            const found = nodes.find((node) => node.id === id);
            return found === undefined ? `#${id}` : found.refText === '' ? `(id ${id})` : found.refText;
        },
        id: (ref) => nodeOf(nodes, ref).id,
    };
}

const selectionText = (editor: MarkdagEditor, name: (id: number) => string): string => {
    const selection = editor.getSelection();
    if (selection.kind === 'none') return 'none';
    if (selection.kind === 'nodes') return `nodes:${[...selection.nodes].sort((a, b) => a.id - b.id).map((node) => name(node.id)).join(',')}`;
    if (selection.kind === 'edge') return `edge:${selection.edge.kind}:${name(selection.edge.source)}>${name(selection.edge.target)}`;
    if (selection.kind === 'group') return `group:${selection.id}`;
    return `groups:${selection.ids.join(',')}`;
};

// 開いている入力とパネル (なければ none。2 つ以上なら + でつなぐ)
function inputOf(container: HTMLElement): string {
    const open: string[] = [];
    for (const element of allVisible(container, '.mdag-editor-name-input') as HTMLElement[]) {
        if (element.dataset.for === 'group') open.push(element.closest('.mdag-editor-legend') ? 'group-name-legend' : 'group-name');
        else open.push('name');
    }
    if (allVisible(container, '.mdag-editor-details-editor').length > 0) open.push('details');
    for (const element of allVisible(container, '.mdag-editor-tag-panel') as HTMLElement[]) open.push(`tag-${element.dataset.panel ?? ''}`);
    if (allVisible(container, '.mdag-editor-color-picker').length > 0) open.push('picker');
    if (allVisible(container, '.mdag-editor-flyout').length > 0) open.push('flyout');
    return open.length > 0 ? open.join('+') : 'none';
}

function focusOf(ctx: PageContext): string {
    const active = document.activeElement;
    const { container } = ctx;
    if (active === null || active === document.body) return 'body';
    if (active === ctx.outside()) return 'outside';
    if (!(active instanceof HTMLElement || active instanceof SVGElement)) return 'page';
    if (active.matches('.mdag-editor-name-input')) return `name-input:${active.closest('.mdag-editor-legend') ? 'legend' : (active.dataset.for ?? '')}`;
    if (active.closest('.mdag-editor-details-editor')) return 'details';
    if (active.matches('.mdag-editor-tag-field')) return `tag-${active.dataset.field ?? ''}`;
    if (active.matches('.mdag-editor-tag-filter')) return 'tag-filter';
    if (active.matches('.mdag-editor-hex')) return 'hex';
    if (active === container) return 'diagram';
    if (container.contains(active)) {
        if (active.matches('.mdag-editor-tool')) return `tool:${active.dataset.tool ?? ''}`;
        if (active.matches('.mdag-editor-bar-button')) return `bar:${active.dataset.command ?? ''}`;
        return `diagram:${active.tagName.toLowerCase()}`;
    }
    return 'page';
}

// 段のあとの見えるもの。照らすのは期待に書いた欄だけ (照らす側が選ぶ)
function observe(ctx: PageContext, before: TransformLike | null, extra: Record<string, unknown>): Record<string, unknown> {
    const { container } = ctx;
    const editor = ctx.editor();
    const out: Record<string, unknown> = { ...extra, layer: container.querySelector('.mdag-editor') !== null, editor_mode: container.dataset.editorMode ?? null };
    if (!editor) return out;
    try {
        return observeEditor(ctx, editor, before, out);
    } catch (error) {
        // 片付けたあと (destroy) の図は読めない欄がある。読めるものだけを返す
        let source: string | null = null;
        try {
            source = editor.getSource();
        } catch {
            source = null;
        }
        return { ...out, source, observe_error: error instanceof Error ? error.message : String(error) };
    }
}

function observeEditor(ctx: PageContext, editor: MarkdagEditor, before: TransformLike | null, out: Record<string, unknown>): Record<string, unknown> {
    const { container } = ctx;
    const names = namesOf(editor);
    const transform = editor.view.getTransform();
    const segment = allVisible(container, '.mdag-editor-segment')[0];
    const toolbox = allVisible(container, '.mdag-editor-toolbox')[0];
    const tools = toolbox ? (allVisible(toolbox, '.mdag-editor-tool') as HTMLElement[]) : [];
    const bar = allVisible(container, '.mdag-editor-bar')[0] as HTMLElement | undefined;
    const snackbar = allVisible(container, '.mdag-editor-snackbar')[0] as HTMLElement | undefined;
    const hint = allVisible(container, '.mdag-editor-hint')[0];
    const legend = allVisible(container, '.mdag-editor-legend')[0] as HTMLElement | undefined;
    const tagPanel = allVisible(container, '.mdag-editor-tag-panel')[0] as HTMLElement | undefined;
    const nameInput = allVisible(container, '.mdag-editor-name-input')[0] as HTMLInputElement | undefined;
    const detailsField = allVisible(container, '.mdag-editor-details-editor textarea')[0] as HTMLTextAreaElement | undefined;
    const frames: Record<string, number> = {};
    for (const element of container.querySelectorAll<SVGElement>('.mdag-frame[data-group]')) {
        const id = element.dataset.group ?? '';
        frames[id] = (frames[id] ?? 0) + 1;
    }
    const nodeIds = (selector: string): number[] =>
        [...container.querySelectorAll<HTMLElement>(selector)].map((element) => Number(element.dataset.id)).sort((a, b) => a - b);
    const edgeName = (key: string): string => {
        const match = /^([^:]+):(\d+)>(\d+)$/.exec(key);
        return match ? `${match[1]}:${names.name(Number(match[2]))}>${names.name(Number(match[3]))}` : key;
    };
    Object.assign(out, {
        mode: editor.getMode(),
        tool: container.dataset.editorTool ?? null,
        drag_to_pan: container.dataset.dragToPan ?? null,
        segment: segment ? ((segment.closest('.mdag-editor-corner') as HTMLElement | null)?.dataset.corner ?? null) : null,
        segment_place: placeOf(container, segment),
        segment_pressed: segment ? ((segment.querySelector('button[aria-pressed="true"]') as HTMLElement | null)?.dataset.mode ?? null) : null,
        toolbox: toolbox ? tools.map((tool) => tool.dataset.tool ?? '') : null,
        toolbox_labels: toolbox ? tools.map((tool) => tool.textContent?.trim() ?? '') : null,
        tool_pressed: tools.filter((tool) => tool.getAttribute('aria-pressed') === 'true').map((tool) => tool.dataset.tool ?? ''),
        tool_disabled: tools.filter((tool) => (tool as HTMLButtonElement).disabled).map((tool) => tool.dataset.tool ?? ''),
        selection: selectionText(editor, names.name),
        selected: nodeIds('.mdag-node[data-selected]').map(names.name),
        selected_outline: nodeIds('.mdag-node[data-selected]')
            .filter((id) => outlined(container.querySelector(`.mdag-node[data-id="${id}"] .mdag-box`)))
            .map(names.name),
        faded: container.querySelectorAll('.mdag-node[data-faded]').length,
        faded_nodes: nodeIds('.mdag-node[data-faded]').map(names.name),
        edge_selected: container.hasAttribute('data-edge-selected'),
        bar: bar?.dataset.for ?? 'none',
        bar_title: bar ? (bar.querySelector('.mdag-editor-bar-title')?.textContent ?? null) : null,
        bar_buttons: bar ? [...bar.querySelectorAll<HTMLButtonElement>('.mdag-editor-bar-button')].map((button) => `${button.dataset.command ?? ''}${button.disabled ? '(off)' : ''}`) : [],
        handles: (allVisible(container, '.mdag-editor-handle') as HTMLElement[]).map((handle) => handle.dataset.handle ?? '').sort(),
        bounds: allVisible(container, '.mdag-editor-selection-bounds').length,
        input: inputOf(container),
        input_value: nameInput ? nameInput.value : detailsField ? detailsField.value : null,
        focus: focusOf(ctx),
        notice: snackbar ? { kind: snackbar.dataset.kind ?? null, text: snackbar.textContent ?? '' } : null,
        hint: hint ? (hint.textContent ?? '') : null,
        source: editor.getSource(),
        nodes: nodeIds('.mdag-node[data-id]').map(names.name),
        frames,
        edges: [...new Set([...container.querySelectorAll<SVGElement>('path.mdag-edge[data-key]')].map((path) => path.dataset.key ?? ''))].filter((key) => !key.startsWith('tree:')).map(edgeName).sort(),
        drop_target: nodeIds('.mdag-node[data-drop-target]').map(names.name)[0] ?? null,
        marquee: allVisible(container, '.mdag-editor-marquee').length > 0,
        link_preview: allVisible(container, '.mdag-editor-link-preview').length > 0,
        details_display: container.dataset.details ?? null,
        popover: allVisible(container, '.mdag-popover').length > 0,
        legend: legend ? ((legend.closest('.mdag-editor-corner') as HTMLElement | null)?.dataset.corner ?? null) : null,
        legend_place: placeOf(container, legend),
        legend_open: legend ? legend.hasAttribute('data-open') : null,
        legend_sections: legend ? [...legend.querySelectorAll<HTMLElement>('.mdag-editor-legend-section')].filter(visible).map((section) => section.dataset.section ?? '') : [],
        legend_rows: legend ? [...legend.querySelectorAll<HTMLElement>('.mdag-editor-legend-row[data-group]')].map((row) => row.dataset.group ?? '') : [],
        legend_counts: legend ? Object.fromEntries([...legend.querySelectorAll<HTMLElement>('.mdag-editor-legend-row[data-group]')].map((row) => [row.dataset.group ?? '', Number(row.querySelector('.mdag-editor-legend-count')?.textContent ?? 'NaN')])) : {},
        legend_names: legend ? Object.fromEntries([...legend.querySelectorAll<HTMLElement>('.mdag-editor-legend-row[data-group]')].map((row) => [row.dataset.group ?? '', row.querySelector('.mdag-editor-legend-name')?.textContent ?? ''])) : {},
        legend_selected: legend ? [...legend.querySelectorAll<HTMLElement>('.mdag-editor-legend-row[data-selected]')].map((row) => row.dataset.group ?? '') : [],
        legend_actions: legend ? legend.querySelectorAll('.mdag-editor-legend-action').length : 0,
        legend_actions_shown: legend ? allVisible(legend, '.mdag-editor-legend-action').length : 0,
        legend_toggle: legend ? visible(legend.querySelector('.mdag-editor-legend-toggle')) : false,
        legend_new: legend ? visible(legend.querySelector('.mdag-editor-legend-new')) : false,
        tag_rows: tagPanel
            ? [...tagPanel.querySelectorAll<HTMLElement>('.mdag-editor-tag-row')].map((row) => `${row.dataset.key ?? ''}${row.dataset.value === undefined ? '' : `:${row.dataset.value}`}=${row.dataset.state ?? ''}${row.hasAttribute('data-editing') ? '*' : ''}`)
            : [],
        tag_fields: tagPanel ? Object.fromEntries([...tagPanel.querySelectorAll<HTMLInputElement>('.mdag-editor-tag-field')].map((field) => [field.dataset.field ?? '', field.value])) : null,
        moved: before !== null && (Math.abs(before.k - transform.k) > 1e-3 || Math.abs(before.x - transform.x) > 0.5 || Math.abs(before.y - transform.y) > 0.5),
        zoomed: before !== null && Math.abs(before.k - transform.k) > 1e-3,
    });
    return out;
}

// frontmatter の例で、mount した図のモードとセグメント (置いた隅と、実際に寄っている隅) と道具箱
export function screenSummary(ctx: Pick<PageContext, 'container' | 'editor'>): Record<string, unknown> {
    const { container } = ctx;
    const editor = ctx.editor();
    const segment = allVisible(container, '.mdag-editor-segment')[0];
    return {
        mode: editor?.getMode() ?? null,
        segment: segment ? ((segment.closest('.mdag-editor-corner') as HTMLElement | null)?.dataset.corner ?? null) : null,
        segment_place: placeOf(container, segment),
        toolbox: allVisible(container, '.mdag-editor-toolbox').length > 0,
    };
}

// ---- 押す点 ----

// 画面の中で押せる点。element の中 (exclude に当たる要素の上は除く) で、要素が表に出ている点を、真ん中に近い順に探す
function spotIn(element: Element, exclude: string | null): Point | null {
    const rect = element.getBoundingClientRect();
    const step = Math.max(1, Math.min(rect.width, rect.height) / 8);
    const points: Point[] = [];
    for (let y = rect.top + step / 2; y < rect.bottom; y += step) for (let x = rect.left + step / 2; x < rect.right; x += step) points.push({ x, y });
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    const inView = (point: Point): boolean => point.x >= 2 && point.y >= 2 && point.x < innerWidth - 2 && point.y < innerHeight - 2;
    return (
        points.find((point) => {
            const hit = inView(point) ? document.elementFromPoint(point.x, point.y) : null;
            return hit !== null && element.contains(hit) && !(exclude && hit.closest(exclude));
        }) ?? null
    );
}

// 相手が窓の下の端より下にあれば、ページ (document) だけをスクロールして窓に入れる (図の領域が窓より少し下まで続くことがあり、
// 下の隅の凡例のパネルを閉じると見出しが窓の外に出る)。図の要素の中のスクロールは動かさない
function revealInPage(element: Element): void {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > innerHeight - 2) window.scrollBy(0, rect.bottom - innerHeight + 4);
    else if (rect.top < 2) window.scrollBy(0, rect.top - 4);
}

// 図の領域そのものが表に出ている点 (何もないところ)。near があれば、そのノードの近くから探す
function blankSpot(container: HTMLElement, near: DOMRect | null): Point | null {
    const viewport = container.querySelector(':scope > .mdag-viewport');
    const rect = container.getBoundingClientRect();
    const points: Point[] = [];
    for (let y = rect.top + 8; y < rect.bottom; y += 16) for (let x = rect.left + 8; x < rect.right; x += 16) points.push({ x, y });
    const cx = near ? near.left + near.width / 2 : rect.left + rect.width / 2;
    const cy = near ? near.top + near.height / 2 : rect.top + rect.height / 2;
    points.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    return points.find((point) => point.x < innerWidth - 2 && point.y < innerHeight - 2 && document.elementFromPoint(point.x, point.y) === viewport) ?? null;
}

// 線の当たりの帯が表に出ている点 (線の中ほどから)
function edgeSpot(container: HTMLElement, key: string): Point | null {
    const hit = container.querySelector<SVGPathElement>(`.mdag-edge-hit[data-key="${key}"]`);
    const matrix = hit?.getScreenCTM();
    if (!hit || !matrix) return null;
    const length = hit.getTotalLength();
    const order = Array.from({ length: 49 }, (_, index) => index + 1).sort((a, b) => Math.abs(a - 25) - Math.abs(b - 25));
    for (const step of order) {
        const at = hit.getPointAtLength((length * step) / 50);
        const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
        if (point.x >= 2 && point.y >= 2 && point.x < innerWidth - 2 && point.y < innerHeight - 2 && document.elementFromPoint(point.x, point.y) === hit) return { x: point.x, y: point.y };
    }
    return null;
}

// 例の書き方の相手 ({ node: 名前 } など) を、画面の押せる点にする
function pointOf(ctx: PageContext, editor: MarkdagEditor, target: Target): Point {
    const { container } = ctx;
    const names = namesOf(editor);
    const nodeSelector = (ref: unknown): string => `.mdag-node[data-id="${names.id(ref)}"]`;
    const inside = (selector: string, exclude: string | null = null, index = 0): Point => {
        const element = allVisible(container, selector)[index];
        if (!element) throw new Error(`押す相手が見えていません: ${describeTarget(target)} (${selector})`);
        revealInPage(element);
        const point = spotIn(element, exclude);
        if (!point) throw new Error(`押せる点がありません: ${describeTarget(target)}`);
        return point;
    };
    if ('node' in target) return inside(`${nodeSelector(target.node)} .mdag-box`, '.mdag-tags, .mdag-task-label > svg');
    if ('label' in target) return inside(`${nodeSelector(target.label)} .mdag-content`, '.mdag-tags, .mdag-details, .mdag-task-label > svg');
    if ('details' in target) return inside(`${nodeSelector(target.details)} .mdag-content .mdag-details`);
    if ('popover_details' in target) return inside('.mdag-popover .mdag-details');
    if ('tag' in target) {
        const spec = target.tag as { node: unknown; key: string };
        return inside(`${nodeSelector(spec.node)} .mdag-tag[data-tag-key="${spec.key}"]`);
    }
    if ('popover_tag' in target) return inside(`.mdag-popover .mdag-tag[data-tag-key="${String(target.popover_tag)}"]`);
    if ('task' in target) return inside(`${nodeSelector(target.task)} .mdag-content > .mdag-task-label > svg:first-child`);
    if ('fold' in target) return inside(`circle.mdag-fold[data-id="${names.id(target.fold)}"]`);
    if ('blank' in target) {
        const near = typeof target.blank === 'string' ? (container.querySelector(`${nodeSelector(target.blank)} .mdag-box`)?.getBoundingClientRect() ?? null) : null;
        const point = blankSpot(container, near);
        if (!point) throw new Error('何もないところが見つかりません');
        return point;
    }
    if ('frame' in target) return inside(`.mdag-frame[data-group="${String(target.frame)}"]`, null, Number(target.index ?? 0));
    if ('frame_label' in target) return inside(`.mdag-frame-label[data-group="${String(target.frame_label)}"]`, null, Number(target.index ?? 0));
    if ('edge' in target) {
        const match = /^([^:]+):(.+)>(.+)$/.exec(String(target.edge));
        if (!match) throw new Error(`線の書き方が読めません: ${String(target.edge)} (種類:始点>終点)`);
        const key = `${match[1]}:${names.id(match[2])}>${names.id(match[3])}`;
        const point = edgeSpot(container, key);
        if (!point) throw new Error(`線 ${String(target.edge)} の押せる点がありません`);
        return point;
    }
    if ('tool' in target) return inside(`.mdag-editor-tool[data-tool="${String(target.tool)}"]`);
    if ('bar' in target) return inside(`.mdag-editor-bar-button[data-command="${String(target.bar)}"]`);
    if ('handle' in target) return inside(`.mdag-editor-handle[data-handle="${String(target.handle)}"]`);
    if ('segment' in target) return inside(`.mdag-editor-segment button[data-mode="${String(target.segment)}"]`);
    if ('legend_row' in target) return inside(`.mdag-editor-legend-row[data-group="${String(target.legend_row)}"] .mdag-editor-legend-name`);
    if ('legend_chip' in target) return inside(`.mdag-editor-legend-row[data-group="${String(target.legend_chip)}"] .mdag-editor-legend-chip`);
    if ('legend_action' in target) {
        const [group, action] = target.legend_action as [string, string];
        const row = container.querySelector(`.mdag-editor-legend-row[data-group="${group}"]`);
        const button = row?.querySelector(`.mdag-editor-legend-action[data-action="${action}"]`);
        if (!button) throw new Error(`凡例の行 ${group} のボタン ${action} がありません`);
        const point = visible(button) ? spotIn(button, null) : null;
        if (!point) throw new Error(`凡例の行 ${group} のボタン ${action} が見えていません (行を選ぶと出る)`);
        return point;
    }
    if ('legend_new' in target) return inside('.mdag-editor-legend-new');
    if ('legend_head' in target) return inside('.mdag-editor-legend-title');
    if ('swatch' in target) return inside('.mdag-editor-color-picker .mdag-editor-swatch', null, Number(target.swatch));
    if ('hex' in target) return inside('.mdag-editor-color-picker .mdag-editor-hex');
    if ('flyout' in target) return inside(`.mdag-editor-flyout [data-details="${String(target.flyout)}"]`);
    if ('tag_field' in target) return inside(`.mdag-editor-tag-panel .mdag-editor-tag-field[data-field="${String(target.tag_field)}"]`);
    if ('tag_button' in target) return inside(`.mdag-editor-tag-panel [data-action="${String(target.tag_button)}"]`);
    if ('tag_row' in target) {
        const [key, value] = String(target.tag_row).split(':');
        return inside(`.mdag-editor-tag-panel .mdag-editor-tag-row[data-key="${key}"]${value === undefined ? ':not([data-value])' : `[data-value="${value}"]`} .mdag-editor-tag-pick`);
    }
    if ('tag_remove' in target) return inside(`.mdag-editor-tag-panel .mdag-editor-tag-row[data-key="${String(target.tag_remove)}"] .mdag-editor-tag-remove`);
    if ('details_button' in target) return inside(`.mdag-editor-details-editor [data-action="${String(target.details_button)}"]`);
    if ('outside' in target) {
        const point = spotIn(ctx.outside(), null);
        if (!point) throw new Error('図の外の入力欄が見えていません');
        return point;
    }
    throw new Error(`押す相手の書き方が読めません: ${describeTarget(target)}`);
}

// 矩形選択の始まりと終わり (名前のノードの箱を囲む。始まりは右上、終わりは左下)
function marqueeOf(container: HTMLElement, editor: MarkdagEditor, refs: unknown[]): { start: Point; end: Point } {
    const names = namesOf(editor);
    const boxes = refs.map((ref) => {
        const box = container.querySelector(`.mdag-node[data-id="${names.id(ref)}"] .mdag-box`);
        if (!box) throw new Error(`ノード「${String(ref)}」の箱が見えていません`);
        return box.getBoundingClientRect();
    });
    return {
        start: { x: Math.max(...boxes.map((box) => box.right)) + 12, y: Math.min(...boxes.map((box) => box.top)) - 3 },
        end: { x: Math.min(...boxes.map((box) => box.left)) - 8, y: Math.max(...boxes.map((box) => box.bottom)) + 4 },
    };
}

// ---- 段から使う口 ----

// 例の段が図に求めること (押す点を探す、見えるものを読む、図の API を呼ぶ)。戻り値はページの外へ渡せる値だけ
export interface ScreenProbe {
    pointOf(target: Target): Point;
    marqueeOf(refs: unknown[]): { start: Point; end: Point };
    // 図の真ん中に近い、何もないところ (なければ null)
    blankSpot(): Point | null;
    setMode(mode: EditorMode): boolean;
    // undo と redo は戻り値、fit と destroy は null
    callApi(name: string): unknown;
    blurWindow(): void;
    // 図の表示位置と倍率 (片付けたあとは null)
    transform(): TransformLike | null;
    observe(before: TransformLike | null, extra: Record<string, unknown>): Record<string, unknown>;
    summary(): Record<string, unknown>;
}

export function createScreenProbe(ctx: PageContext): ScreenProbe {
    const editor = (): MarkdagEditor => {
        const current = ctx.editor();
        if (!current) throw new Error('図がありません');
        return current;
    };
    return {
        pointOf: (target) => pointOf(ctx, editor(), target),
        marqueeOf: (refs) => marqueeOf(ctx.container, editor(), refs),
        blankSpot: () => blankSpot(ctx.container, null),
        setMode: (mode) => editor().setMode(mode),
        callApi: (name) => {
            const current = editor();
            if (name === 'undo') return current.undo();
            if (name === 'redo') return current.redo();
            if (name === 'fit') current.fit();
            else if (name === 'destroy') current.destroy();
            else throw new Error(`api ${name} は使えません (undo、redo、fit、destroy)`);
            return null;
        },
        blurWindow: () => {
            window.dispatchEvent(new Event('blur'));
        },
        transform: () => {
            try {
                const current = ctx.editor()?.view.getTransform();
                return current ? { k: current.k, x: current.x, y: current.y } : null;
            } catch {
                return null;
            }
        },
        observe: (before, extra) => observe(ctx, before, extra),
        summary: () => screenSummary(ctx),
    };
}

// アイコン機能の受け入れテストと状態遷移のテストが、ページの中で使う道具。icons-harness.html が harness.ts と一緒に読む。
// 例の resolver の欄どおりに振る舞う resolveIcon を作り、問い合わせと診断を控える。描いた DOM からロゴの様子を読み出す。
// 読み出すだけで、図には触らない (期待との照合はテストの側で行う)
import type { Diagnostic, IconResolver } from '../src/index';

export type ProbeBehavior =
    | { how: 'sync'; content: string | null }
    | { how: 'promise'; content: string | null; delay: number }
    | { how: 'reject'; reason: string }
    | { how: 'throw'; reason: string }
    // 状態遷移のテスト用: テストが後から settle を呼ぶまで済まない Promise
    | { how: 'manual' };

export interface MarkInfo {
    node: string;
    alias: string;
    svg: boolean;
    text: string;
    kind: string | null;
    color: string | null;
    role: string | null;
    title: string | null;
    ariaLabel: string | null;
    size: string | null;
    fontSize: string;
    inDetails: boolean;
    svgHtml: string | null;
    shape: string | null;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ノードの文字 (ロゴと印を除いたもの)。ノードの指定は、この文字の部分一致で行う
function nodeTextOf(node: Element): string {
    const content = node.querySelector('.mdag-content');
    if (!content) return '';
    const copy = content.cloneNode(true) as Element;
    for (const mark of copy.querySelectorAll('.mdag-icon')) mark.remove();
    return collapse(copy.textContent ?? '');
}

const shapeOf = (svg: Element | null): string | null => svg?.querySelector('circle, rect, path, polygon')?.tagName.toLowerCase() ?? null;

function markInfo(mark: HTMLElement, node: string): MarkInfo {
    const svg = mark.querySelector('svg');
    return {
        node,
        alias: mark.dataset.icon ?? '',
        svg: svg !== null,
        text: mark.textContent ?? '',
        kind: mark.dataset.iconKind ?? null,
        color: mark.dataset.iconColor ?? null,
        role: mark.getAttribute('role'),
        title: mark.getAttribute('title') ?? svg?.querySelector('title')?.textContent ?? null,
        ariaLabel: mark.getAttribute('aria-label'),
        size: svg ? getComputedStyle(svg).width : null,
        fontSize: getComputedStyle(mark).fontSize,
        inDetails: mark.closest('.mdag-details') !== null,
        svgHtml: svg ? mark.innerHTML : null,
        shape: shapeOf(svg),
    };
}

export class IconsProbe {
    asked: string[] = [];
    diagnostics: Diagnostic[] = [];
    private pending = 0;
    private manual = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

    reset(): void {
        this.asked = [];
        this.diagnostics = [];
        this.pending = 0;
        this.manual.clear();
    }

    readonly onDiagnostic = (diagnostic: Diagnostic): void => {
        this.diagnostics.push(diagnostic);
    };

    // ref → 振る舞い。欄にない ref は "*" に従い、"*" もなければ同期で null
    resolver(spec: Record<string, ProbeBehavior>): IconResolver {
        return (ref) => {
            this.asked.push(ref);
            const behavior = spec[ref] ?? spec['*'] ?? { how: 'sync', content: null };
            switch (behavior.how) {
                case 'sync':
                    return behavior.content;
                case 'throw':
                    throw new Error(behavior.reason);
                case 'reject':
                    return this.track(Promise.reject(new Error(behavior.reason)));
                case 'promise':
                    return this.track(new Promise<string | null>((resolve) => window.setTimeout(() => resolve(behavior.content), behavior.delay)));
                case 'manual':
                    return this.track(new Promise<string | null>((resolve, reject) => this.manual.set(ref, { resolve: resolve as (value: unknown) => void, reject })));
            }
        };
    }

    // manual の Promise を済ませる。value が Error なら reject
    settle(ref: string, value: unknown, reject = false): void {
        const entry = this.manual.get(ref);
        if (!entry) throw new Error(`manual の問い合わせがない: ${ref}`);
        this.manual.delete(ref);
        if (reject) entry.reject(new Error(String(value)));
        else entry.resolve(value);
    }

    private track<T>(promise: Promise<T>): Promise<T> {
        this.pending++;
        const done = (): void => {
            window.setTimeout(() => this.pending--, 0);
        };
        promise.then(done, done);
        return promise;
    }

    // Promise がすべて済み、描き直しが終わるまで待つ
    async settled(): Promise<void> {
        while (this.pending > 0) await new Promise((resolve) => window.setTimeout(resolve, 10));
        await frames(3);
    }

    // ノードの本文の印 (.mdag-node の .mdag-content の中) を文書の順に
    bodyMarks(root: Element): MarkInfo[] {
        return [...root.querySelectorAll<HTMLElement>('.mdag-node')].flatMap((node) => {
            const text = nodeTextOf(node);
            return [...node.querySelectorAll<HTMLElement>('.mdag-content .mdag-icon[data-icon]')].map((mark) => markInfo(mark, text));
        });
    }

    counts(root: Element): { tag_logos: number; frame_logos: number; legend_logos: number } {
        return {
            tag_logos: root.querySelectorAll('.mdag-node .mdag-tags svg').length,
            frame_logos: root.querySelectorAll('svg.mdag-frame-icon').length,
            legend_logos: root.querySelectorAll('.mdag-legend .mdag-icon svg').length,
        };
    }

    nodeTexts(root: Element): string[] {
        return [...root.querySelectorAll('.mdag-node')].map(nodeTextOf);
    }

    // 文字の部分一致でノードを探す (見えているノードの中から、最初のもの)。見つからなければ -1
    nodeIndex(root: Element, text: string): number {
        return [...root.querySelectorAll<HTMLElement>('.mdag-node')].findIndex((node) => nodeTextOf(node).includes(text));
    }

    tags(root: Element): Array<{ node: string; logos: string[]; text: string; html: string; display: string; logoInfo: MarkInfo[] }> {
        return [...root.querySelectorAll<HTMLElement>('.mdag-node')].flatMap((node) => {
            const tags = node.querySelector<HTMLElement>('.mdag-tags');
            if (!tags) return [];
            const text = nodeTextOf(node);
            const logos = [...tags.querySelectorAll<HTMLElement>('.mdag-icon[data-icon]')];
            return [{ node: text, logos: logos.map((mark) => mark.dataset.icon ?? ''), text: tags.textContent ?? '', html: tags.innerHTML, display: getComputedStyle(tags).display, logoInfo: logos.map((mark) => markInfo(mark, text)) }];
        });
    }

    // 2 色のロゴの円の塗りとチェックの線の計算値
    paints(element: Element | null): { color: string | null; circle_fill: string | null; check_stroke: string | null } | null {
        if (!element) return null;
        const circle = element.querySelector('circle');
        const check = element.querySelector('path');
        return {
            color: (element as HTMLElement).dataset.iconColor ?? null,
            circle_fill: circle ? getComputedStyle(circle).fill : null,
            check_stroke: check ? getComputedStyle(check).stroke : null,
        };
    }

    frames(root: Element): Array<{ group: string | null; rectX: number; labelX: number; labelY: number; label: string; logo: { x: number; y: number; width: number; height: number; color: string; title: string | null; shape: string | null } | null; opacity: string }> {
        const layer = root.querySelector('svg.mdag-frames');
        if (!layer) return [];
        const rects = [...layer.querySelectorAll<SVGRectElement>('rect.mdag-frame')];
        const labels = [...layer.querySelectorAll<SVGTextElement>('text.mdag-frame-label')];
        const logos = [...layer.querySelectorAll<SVGSVGElement>('svg.mdag-frame-icon')];
        return rects.map((rect, index) => {
            const group = rect.dataset.group ?? null;
            const label = group === null ? labels[index] : labels.find((item) => item.dataset.group === group);
            const logo = group === null ? null : (logos.find((item) => item.dataset.group === group) ?? null);
            return {
                group,
                rectX: Number(rect.getAttribute('x')),
                labelX: Number(label?.getAttribute('x')),
                labelY: Number(label?.getAttribute('y')),
                label: label?.textContent ?? '',
                opacity: label?.style.opacity ?? '',
                logo: logo
                    ? {
                          x: Number(logo.getAttribute('x')),
                          y: Number(logo.getAttribute('y')),
                          width: Number(logo.getAttribute('width')),
                          height: Number(logo.getAttribute('height')),
                          color: getComputedStyle(logo).color,
                          title: logo.getAttribute('title') ?? logo.querySelector('title')?.textContent ?? null,
                          shape: shapeOf(logo),
                      }
                    : null,
            };
        });
    }

    legend(root: Element): Array<{ text: string; order: string[]; chip: string | null; logoSize: string | null; title: string | null; shape: string | null }> {
        return [...root.querySelectorAll<HTMLElement>('.mdag-legend li')].map((item) => {
            const chip = item.querySelector<HTMLElement>('.mdag-legend-chip');
            const logo = item.querySelector<HTMLElement>('.mdag-icon');
            const svg = logo?.querySelector('svg') ?? null;
            const background = chip ? getComputedStyle(chip).backgroundColor : null;
            return {
                text: item.textContent ?? '',
                order: [...item.children].map((child) => (child.classList.contains('mdag-legend-chip') ? 'chip' : child.classList.contains('mdag-icon') ? 'logo' : child.tagName.toLowerCase())),
                chip: background === 'rgba(0, 0, 0, 0)' ? 'transparent' : background,
                logoSize: svg ? getComputedStyle(svg).width : null,
                title: logo ? (logo.getAttribute('title') ?? svg?.querySelector('title')?.textContent ?? null) : null,
                shape: shapeOf(svg),
            };
        });
    }

    popover(root: Element): { hidden: boolean; details: MarkInfo[]; tagLine: { logos: string[]; text: string; logoInfo: MarkInfo[] } | null; shapes: Array<string | null> } {
        const popover = root.querySelector<HTMLElement>('.mdag-popover');
        if (!popover) return { hidden: true, details: [], tagLine: null, shapes: [] };
        const line = popover.querySelector<HTMLElement>('.mdag-popover-tags');
        const details = [...popover.querySelectorAll<HTMLElement>('.mdag-icon[data-icon]')].filter((mark) => !mark.closest('.mdag-popover-tags'));
        const lineMarks = line ? [...line.querySelectorAll<HTMLElement>('.mdag-icon[data-icon]')] : [];
        return {
            hidden: popover.hidden === true,
            details: details.map((mark) => markInfo(mark, '')),
            tagLine: line ? { logos: lineMarks.map((mark) => mark.dataset.icon ?? ''), text: line.textContent ?? '', logoInfo: lineMarks.map((mark) => markInfo(mark, '')) } : null,
            shapes: [...popover.querySelectorAll('svg')].map((svg) => shapeOf(svg)),
        };
    }

    // ノードの本文 (詳細を除く) とタグのロゴの図形
    nodeLogoShapes(root: Element, text: string): Array<string | null> {
        const node = [...root.querySelectorAll<HTMLElement>('.mdag-node')].find((item) => nodeTextOf(item).includes(text));
        if (!node) return [];
        const body = [...node.querySelectorAll<HTMLElement>('.mdag-content .mdag-icon')].filter((mark) => !mark.closest('.mdag-details'));
        const tags = [...node.querySelectorAll<HTMLElement>('.mdag-tags .mdag-icon')];
        return [...body, ...tags].flatMap((mark) => {
            const svg = mark.querySelector('svg');
            return svg ? [shapeOf(svg)] : [];
        });
    }
}

export const frames = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};

(window as unknown as { iconsProbe: IconsProbe }).iconsProbe = new IconsProbe();

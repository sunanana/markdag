// Markdown: データそのもの。打った内容は少し待ってから読み直し、markdag の診断を下に並べる
import type { Diagnostic } from 'markdag';
import type { AppContext } from '../context';
import { h, ICON, svg } from '../dom';

const SEVERITY_LABEL: Record<Diagnostic['severity'], string> = { error: 'エラー', warning: '警告', info: '情報' };

export class SourcePane {
    readonly element: HTMLElement;
    private readonly editor: HTMLTextAreaElement;
    private readonly gutter: HTMLElement;
    private readonly problems: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly ctx: () => AppContext) {
        this.editor = h('textarea', {
            class: 'source-editor',
            id: 'source-editor',
            spellcheck: 'false',
            wrap: 'off',
            'aria-label': 'Markdown',
        });
        this.gutter = h('div', { class: 'source-gutter', 'aria-hidden': 'true' });
        this.problems = h('div', { class: 'source-problems' });
        this.editor.addEventListener('input', () => {
            this.drawGutter();
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => this.flush(), 350);
        });
        this.editor.addEventListener('blur', () => this.flush());
        this.editor.addEventListener('scroll', () => {
            this.gutter.scrollTop = this.editor.scrollTop;
        });
        this.editor.addEventListener('keydown', (event) => {
            // Tab は字下げ (リストの入れ子) に使う
            if (event.key !== 'Tab') return;
            event.preventDefault();
            const { selectionStart, selectionEnd, value } = this.editor;
            this.editor.value = `${value.slice(0, selectionStart)}    ${value.slice(selectionEnd)}`;
            this.editor.selectionStart = this.editor.selectionEnd = selectionStart + 4;
            this.editor.dispatchEvent(new Event('input'));
        });
        this.element = h(
            'div',
            { class: 'source' },
            h('div', { class: 'source-body' }, this.gutter, this.editor),
            this.problems,
        );
    }

    private flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.ctx().store.set(this.editor.value, 'editor');
    }

    // 文字列がほかの画面で変わったときは差し替える。自分が打った分は、カーソルを動かさないようそのまま
    show(fromEditor = false): void {
        const workspace = this.ctx().workspace;
        if (!fromEditor && this.editor.value !== workspace.source) {
            const { scrollTop } = this.editor;
            this.editor.value = workspace.source;
            this.editor.scrollTop = scrollTop;
            this.drawGutter();
        }
        this.drawProblems(workspace.diagnostics);
    }

    reveal(line: number, end = line + 1): void {
        const rows = this.editor.value.split('\n');
        const start = rows.slice(0, line).reduce((sum, row) => sum + row.length + 1, 0);
        const stop = rows.slice(0, Math.max(end, line + 1)).reduce((sum, row) => sum + row.length + 1, 0) - 1;
        this.editor.focus();
        this.editor.setSelectionRange(start, stop);
        const height = parseFloat(getComputedStyle(this.editor).lineHeight) || 20;
        this.editor.scrollTop = Math.max(0, line * height - this.editor.clientHeight / 3);
    }

    private drawGutter(): void {
        const count = this.editor.value.split('\n').length;
        if (this.gutter.childElementCount === count) return;
        this.gutter.replaceChildren(...Array.from({ length: count }, (_, index) => h('div', null, index + 1)));
        this.gutter.scrollTop = this.editor.scrollTop;
    }

    private drawProblems(diagnostics: Diagnostic[]): void {
        if (diagnostics.length === 0) {
            this.problems.replaceChildren(h('p', { class: 'source-ok' }, '診断なし。markdag はこの文書を問題なく読めています'));
            return;
        }
        this.problems.replaceChildren(
            ...diagnostics.map((diagnostic) =>
                h(
                    'button',
                    {
                        type: 'button',
                        class: `problem problem-${diagnostic.severity}`,
                        onclick: () => {
                            if (diagnostic.at) this.reveal(diagnostic.at.line - 1);
                        },
                    },
                    svg(ICON.warn),
                    h('span', { class: 'problem-where' }, diagnostic.at ? `${diagnostic.at.line} 行` : '—'),
                    h('span', { class: 'problem-severity' }, SEVERITY_LABEL[diagnostic.severity]),
                    h('span', { class: 'problem-text' }, diagnostic.message, diagnostic.hint ? h('small', null, diagnostic.hint) : null),
                    h('code', null, diagnostic.code),
                ),
            ),
        );
    }
}

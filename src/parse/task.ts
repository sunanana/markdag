// タスクの状態の記法。行頭の `[ ]` (未完了), `[/]` (作業中), `[x]` (完了), `[-]` (中止) を状態として読み、
// クリックでの切り替えを原文の上で行う。切り替えの順 (cycle) は文書の frontmatter が決め、既定は未完了と完了の行き来。
// DOM に依存しないので、model 層からも使える

export const TASK_MARKS = [' ', '/', 'x', '-'] as const;
export type TaskMark = (typeof TASK_MARKS)[number];
export type TaskState = 'todo' | 'doing' | 'done' | 'canceled';
export const TASK_STATES: readonly TaskState[] = ['todo', 'doing', 'done', 'canceled'];

const STATE_OF: Record<TaskMark, TaskState> = { ' ': 'todo', '/': 'doing', x: 'done', '-': 'canceled' };
const MARK_OF: Record<TaskState, TaskMark> = { todo: ' ', doing: '/', done: 'x', canceled: '-' };

// 指定がないときにクリックで進む順。右端の次は左端に戻る
export const DEFAULT_TASK_CYCLE: readonly TaskMark[] = [' ', 'x'];

export const isTaskMark = (value: unknown): value is TaskMark => typeof value === 'string' && (TASK_MARKS as readonly string[]).includes(value);
export const taskStateOf = (mark: TaskMark): TaskState => STATE_OF[mark];
export const taskMarkOf = (state: TaskState): TaskMark => MARK_OF[state];

// 行頭の記号。大文字の X は完了として読む。リスト項目は行頭の記号のあと、見出しは # のあと。
// 下線で書く見出しは行が記号から始まるので、見出しと分かっている行にだけ使う
const LIST_PREFIX = String.raw`[ \t]*(?:[-*+]|\d+[.)])[ \t]+`;
const HEADING_PREFIX = String.raw`[ \t]*(?:#{1,6}[ \t]+)?`;
const MARK = String.raw`\[( |x|X|\/|-)\](?=[ \t])`;
const TASK_ITEM = new RegExp(`^${LIST_PREFIX}${MARK}`);
const TASK_HEADING = new RegExp(`^${HEADING_PREFIX}${MARK}`);
// 切り替えで書き換える記号。リスト項目でも見出しでも、行頭の印のすぐあとにある
const TASK_LINE = new RegExp(`^((?:${LIST_PREFIX})|(?:${HEADING_PREFIX}))${MARK}`);

// 原文の 1 行から状態の記号を読む。タスクでなければ null
export function taskMarkAt(line: string, kind: 'item' | 'heading'): TaskMark | null {
    const raw = (kind === 'item' ? TASK_ITEM : TASK_HEADING).exec(line)?.[1];
    return raw === undefined ? null : raw === 'X' ? 'x' : (raw as TaskMark);
}

// クリックで次に進む記号。今の記号が順の中になければ null (その状態はクリックで変えない)
export function nextTaskMark(current: TaskMark, cycle: readonly TaskMark[]): TaskMark | null {
    const index = cycle.indexOf(current);
    return index < 0 ? null : (cycle[(index + 1) % cycle.length] ?? null);
}

// タスクの行の状態を、原文の上で順の次に進める。原文にない行や、順にない状態の行は、何も変えない
export function toggleTask(source: string, line: number, cycle: readonly TaskMark[] = DEFAULT_TASK_CYCLE): string {
    const lines = source.split('\n');
    const current = lines[line];
    if (current === undefined) return source;
    lines[line] = current.replace(TASK_LINE, (whole, prefix: string, raw: string) => {
        const next = nextTaskMark(raw === 'X' ? 'x' : (raw as TaskMark), cycle);
        return next === null ? whole : `${prefix}[${next}]`;
    });
    return lines.join('\n');
}

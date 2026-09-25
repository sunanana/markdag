// タスクの状態の記法。行頭の `[ ]` (未完了), `[/]` (作業中), `[x]` (完了), `[-]` (中止) を状態として読み、
// クリックでの切り替えを原文の上で行う。切り替えの順 (cycle) は文書の frontmatter が決め、既定は未完了と完了の行き来。
// 切り替え (nextTaskMark、toggleTask) は Rust (wasm) を呼ぶ包み。定数と 1 行の変換は JS に写しを残す (wasm を呼ばない。設計文書 (c))
import { callJson } from '../wasm/boundary';

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

// クリックで次に進む記号。今の記号が順の中になければ null (その状態はクリックで変えない)
export function nextTaskMark(current: TaskMark, cycle: readonly TaskMark[]): TaskMark | null {
    return callJson<{ mark: TaskMark | null }>('next_task_mark', { mark: current, cycle }).mark;
}

// タスクの行の状態を、原文の上で順の次に進める。原文にない行や、順にない状態の行は、何も変えない。
// Rust は書き換えた 1 行だけを返すので、原文のその行だけを差し替える (他の行と、境界を越えられない文字を原文のまま保つ)
export function toggleTask(source: string, line: number, cycle: readonly TaskMark[] = DEFAULT_TASK_CYCLE): string {
    const changed = callJson<{ line: number; text: string } | null>('toggle_task', { source, line, cycle });
    if (changed === null) return source;
    const lines = source.split('\n');
    lines[changed.line] = changed.text;
    return lines.join('\n');
}

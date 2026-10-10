// タスク化とタスク解除の決まり (DOM を使わない)。選んだノードの原文の事実 (inspectNode) から、記号を付けられるタスクでないノードとタスク
// (記号を外せないタスクも) だけを見て、1 つでもタスクでないものがあればタスク化 (書くのはタスクでないもの)、全部タスクならタスク解除 (外せるもの全部) にする。
// 書けるかは書き換えの層が決めた事実 (canToggleTask) を見る。書き換えの操作 (toggleTaskMark) と同じ決まりで、帯の名前と押せるか、通知の文、ノードの左のチェックが使う。
// タスクにできないノードと、タスク解除で外せないタスクはスキップする数に数える。読み取りだけのグループ (文書の markdag.rules.taskToggle.readonlyGroups。組み込みの規則と同じく読む)
// に入るノードは、タスク化もタスク解除もせずにスキップし、タスク化か解除かは残りで決める (書き換えの層は規則を見ないので、呼ぶ側が操作に渡さない)。
// 残りがなければ、しようとした操作は読み取りだけのグループのノードで決める (帯の無効のボタンの名前と、断る文を同じにするため)
import type { InspectNodeResult, NodeTarget, ViewDocument } from '../core';

// 原文の事実のうち、タスクにできるかとタスクかを決めるもの
export type TaskFacts = Pick<InspectNodeResult, 'kind' | 'task' | 'canToggleTask'>;

// ノードが入る読み取りだけのグループ (readonlyGroups の並びで最初のもの)。どれにも入らなければ null
export type TaskLockOf = (node: NodeTarget) => string | null;

// 書き換えのねらい。adding はタスク化 (偽ならタスク解除)、written は記号を書くか外すノード (選んだ順)、skipped はタスクにできないか、タスク解除で記号を外せずにスキップするノードの数、
// locked は読み取りだけのグループに入っていてスキップするノードの、そのグループ (ノードごと、選んだ順)
export interface TaskPlan {
    adding: boolean;
    written: NodeTarget[];
    skipped: number;
    locked: string[];
}

// 書き換えられるノードがないときに、読み取りだけのグループのノードでしようとした操作。group は最初のそのノードが入るグループ、
// adding はタスク化 (そのノードに 1 つでもタスクでないものがある。偽なら全部タスクでタスク解除)
export interface LockedTask {
    group: string;
    adding: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const NO_LOCK: TaskLockOf = () => null;

// タスク化かタスク解除かを決めるのに見るノードか: 記号を付けられるタスクでないノードと、タスク (記号を外せないタスクも、タスクとして数える)。
// 名前が空の項目と 1 行目が文章でない項目はタスクにできない (書き換えの層はそれぞれの理由で断る)。図と原文が合わない (事実がない) ノードは見ない
export function canBeTask(facts: TaskFacts | null): facts is TaskFacts {
    return facts !== null && (facts.kind === 'heading' || facts.kind === 'item') && (facts.task || facts.canToggleTask);
}

// 選んだノードのタスク化かタスク解除のねらい。読み取りだけのグループに入らないノードに、書けるもの (付けられるタスクでないノードか、
// タスク解除なら外せるタスク) がなければ null。タスク化のときのタスクは状態のままで、スキップに数えない
export function taskPlan(nodes: readonly NodeTarget[], factsOf: (node: NodeTarget) => TaskFacts | null, lockOf: TaskLockOf = NO_LOCK): TaskPlan | null {
    const taskable: Array<{ node: NodeTarget; facts: TaskFacts }> = [];
    const locked: string[] = [];
    for (const node of nodes) {
        const facts = factsOf(node);
        if (!canBeTask(facts)) continue;
        const group = lockOf(node);
        if (group !== null) locked.push(group);
        else taskable.push({ node, facts });
    }
    const adding = taskable.some((item) => !item.facts.task);
    const written = taskable.filter((item) => (adding ? !item.facts.task : item.facts.canToggleTask)).map((item) => item.node);
    if (written.length === 0) return null;
    return {
        adding,
        written,
        skipped: nodes.length - locked.length - (adding ? taskable.length : written.length),
        locked,
    };
}

// 書き換えられるノードがないときにしようとした操作 (帯の無効のボタンの名前と、断る文の操作をそろえる)。真ならタスク化、偽ならタスク解除。
// 読み取りだけのグループのノードがあればそのノードで決め、なければタスク (記号を外せないタスク) を選んでいればタスク解除、ほかはタスク化
export function blockedAdding(nodes: readonly NodeTarget[], factsOf: (node: NodeTarget) => TaskFacts | null, lockOf: TaskLockOf): boolean {
    const locked = lockedTaskOf(nodes, factsOf, lockOf);
    if (locked !== null) return locked.adding;
    return !nodes.some((node) => canBeTask(factsOf(node)));
}

// nodes のうちタスクにできて読み取りだけのグループに入るノードでしようとした操作。そういうノードがなければ null
// (タスクにできないノードはグループに入っていても見ない)
export function lockedTaskOf(nodes: readonly NodeTarget[], factsOf: (node: NodeTarget) => TaskFacts | null, lockOf: TaskLockOf): LockedTask | null {
    let group: string | null = null;
    let adding = false;
    for (const node of nodes) {
        const facts = factsOf(node);
        if (!canBeTask(facts)) continue;
        const found = lockOf(node);
        if (found === null) continue;
        group ??= found;
        if (!facts.task) adding = true;
    }
    return group === null ? null : { group, adding };
}

// 文書の frontmatter の markdag.rules.taskToggle.readonlyGroups (文字列の要素だけ)
function readonlyGroupsOf(frontmatter: Record<string, unknown>): string[] {
    const markdag = frontmatter.markdag;
    const rules = isRecord(markdag) ? markdag.rules : undefined;
    const taskToggle = isRecord(rules) ? rules.taskToggle : undefined;
    const groups = isRecord(taskToggle) ? taskToggle.readonlyGroups : undefined;
    return Array.isArray(groups) ? groups.filter((item): item is string => typeof item === 'string') : [];
}

// 描いている文書で、ノードが入る読み取りだけのグループを引く関数。所属は親から受け継いだものを含む (組み込みの規則と同じ)。
// 文書がないか、読み取りだけのグループがなければ、どのノードも null
export function taskLocksOf(document: ViewDocument | null): TaskLockOf {
    if (!document) return NO_LOCK;
    const readonly = readonlyGroupsOf(document.parsed.frontmatter);
    if (readonly.length === 0) return NO_LOCK;
    return (node) => {
        const groups = document.model.groupsOf.get(node.id) ?? document.parsed.nodes.find((item) => item.id === node.id)?.groups ?? [];
        return readonly.find((name) => groups.includes(name)) ?? null;
    };
}

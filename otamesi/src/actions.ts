// 画面からの操作を、文字列の書き換え (edit.ts) に置き換える。できない操作は理由を返す
import { type TaskState, taskMarkOf } from 'markdag';
import { type Issue, nextKey, type Priority, readWorkspace, tagsOf, type Workspace } from './doc';
import {
    addDependency,
    addGroup,
    appendHeading,
    insertItem,
    moveRange,
    removeRange,
    removeRelation,
    removeRelationsOf,
    setDescription,
    setFirstLine,
    setTaskMark,
} from './edit';

export type Result = { ok: true; source: string; key?: string } | { ok: false; reason: string };

function describe(workspace: Workspace, ids: number[]): string {
    return ids
        .map((id) => workspace.issues.get(id))
        .map((issue) => (issue ? `${issue.key ?? ''} ${issue.title}`.trim() : ''))
        .filter(Boolean)
        .join('、');
}

// markdag.rules.taskToggle.requireUpstreamDone と同じ判断を、リストとボードの操作にも当てる
export function changeState(workspace: Workspace, issue: Issue, state: TaskState): Result {
    if (issue.state === state) return { ok: true, source: workspace.source };
    if (state === 'done' && workspace.requireUpstreamDone && issue.openBlockers.length > 0) {
        return { ok: false, reason: `先に終えるもの: ${describe(workspace, issue.openBlockers)}` };
    }
    return { ok: true, source: setTaskMark(workspace.source, issue.line, taskMarkOf(state)) };
}

export interface Fields {
    title?: string;
    owner?: string | null;
    priority?: Priority | null;
    due?: string | null;
    estimate?: number | null;
}

export function changeFields(workspace: Workspace, issue: Issue, fields: Fields): Result {
    const next = { ...issue, ...fields };
    if (fields.title !== undefined && fields.title.trim() === '') return { ok: false, reason: 'タイトルは空にできません' };
    return { ok: true, source: setFirstLine(workspace.source, issue.line, { title: fields.title, tags: tagsOf(next) }) };
}

export function changeDescription(workspace: Workspace, issue: Issue, text: string): Result {
    if (text.trim() === issue.description.trim()) return { ok: true, source: workspace.source };
    return { ok: true, source: setDescription(workspace.source, issue.line, issue.ownEnd, text) };
}

export interface Draft {
    title: string;
    description: string;
    state: TaskState;
    projectId: number | null;
    parentId: number | null;
    owner: string | null;
    priority: Priority | null;
    due: string | null;
    estimate: number | null;
}

export function createIssue(workspace: Workspace, draft: Draft): Result {
    if (draft.title.trim() === '') return { ok: false, reason: 'タイトルを入れてください' };
    const key = nextKey(workspace);
    const item = {
        mark: taskMarkOf(draft.state),
        title: draft.title,
        tags: tagsOf({ ...draft, otherTags: [] }),
        id: key,
        description: draft.description,
    };
    const parent = draft.parentId === null ? undefined : workspace.issues.get(draft.parentId);
    if (parent) {
        return { ok: true, key, source: insertItem(workspace.source, parent.lines.start, parent.lines.end, `${parent.indent}    `, item) };
    }
    const project = workspace.projects.find((entry) => entry.nodeId === draft.projectId) ?? workspace.projects[0];
    if (!project) return { ok: false, reason: '先にプロジェクトを作ってください' };
    return { ok: true, key, source: insertItem(workspace.source, project.range.start, project.range.end, '', item) };
}

export function deleteIssue(workspace: Workspace, issue: Issue): Result {
    // 配下の Issue の ID も、線の式から消す
    const keys: string[] = [];
    const collect = (id: number) => {
        const current = workspace.issues.get(id);
        if (!current) return;
        if (current.key) keys.push(current.key);
        current.childIds.forEach(collect);
    };
    collect(issue.nodeId);
    let source = removeRange(workspace.source, issue.lines.start, issue.lines.end);
    if (keys.length > 0) source = removeRelationsOf(source, keys);
    return { ok: true, source };
}

export function moveToProject(workspace: Workspace, issue: Issue, projectId: number): Result {
    if (issue.parentId !== null) return { ok: false, reason: 'サブ Issue は親と同じプロジェクトに置かれます' };
    if (issue.projectId === projectId) return { ok: true, source: workspace.source };
    const project = workspace.projects.find((entry) => entry.nodeId === projectId);
    if (!project) return { ok: false, reason: 'プロジェクトが見つかりません' };
    return { ok: true, source: moveRange(workspace.source, issue.lines.start, issue.lines.end, project.range) };
}

// from が終わってから to。ID のない Issue には線を引けない
export function link(workspace: Workspace, from: Issue, to: Issue): Result {
    if (!from.key || !to.key) return { ok: false, reason: 'ID ($OTM-n) のない Issue には依存を付けられません' };
    if (from.nodeId === to.nodeId) return { ok: false, reason: '自分自身には依存を付けられません' };
    const source = addDependency(workspace.source, from.key, to.key);
    // markdag は輪になる線を捨てて cycle を報告する。そうなる線は付けない
    const loops = (text: string) => readWorkspace(text).diagnostics.filter((d) => d.code === 'cycle' || d.code === 'self-loop').length;
    if (source !== workspace.source && loops(source) > loops(workspace.source)) {
        return { ok: false, reason: `輪になるので付けられません (${from.key} はすでに ${to.key} を待っています)` };
    }
    return { ok: true, source };
}

export function unlink(workspace: Workspace, from: Issue, to: Issue, origin: string): Result {
    if (!from.key || !to.key) return { ok: false, reason: 'ID のない Issue の線は Markdown で編集してください' };
    const source = removeRelation(workspace.source, origin, from.key, to.key);
    if (source === null) return { ok: false, reason: `「${origin}」は組み合わせた式なので、Markdown で編集してください` };
    return { ok: true, source };
}

const PROJECT_COLORS = ['#4CB782', '#D6457A', '#9A6DD7', '#C9A227', '#3F8FD6', '#7A8B99'];

export function createProject(workspace: Workspace, name: string): Result {
    const label = name.trim();
    if (label === '') return { ok: false, reason: 'プロジェクト名を入れてください' };
    if (workspace.projects.some((project) => project.name === label)) return { ok: false, reason: '同じ名前のプロジェクトがあります' };
    const used = new Set(workspace.model.groups.map((group) => group.id));
    let index = workspace.projects.length + 1;
    while (used.has(`p${index}`)) index += 1;
    const id = `p${index}`;
    const color = PROJECT_COLORS[(workspace.projects.length - 3 + PROJECT_COLORS.length * 4) % PROJECT_COLORS.length]!;
    // 見出しは本文の末尾に足す。プロジェクトの範囲は次の見出しまでなので、マイルストーンの後ろでも困らない
    const source = appendHeading(addGroup(workspace.source, id, label, color), `## ${label.replace(/\s+/g, ' ')} %${id}`);
    return { ok: true, source };
}

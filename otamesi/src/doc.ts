// Markdown を markdag で読み、タスク管理の言葉 (Issue、プロジェクト、マイルストーン) に組み替える。
// ここで作るものはすべて読み取り専用。書き換えは edit.ts で文字列に対して行い、もう一度ここを通す
import { buildModel, type Diagnostic, type GraphModel, type OutlineNode, parseDocument, type ParsedDocument, type TaskState } from 'markdag';
import { readFirstLine } from './edit';

export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATES: TaskState[] = ['doing', 'todo', 'done', 'canceled'];
// 本文の書き方と、画面に出す名前・既定値の対応
export const KNOWN_TAGS = ['owner', 'priority', 'due', 'estimate'] as const;

export interface Project {
    nodeId: number;
    name: string;
    groupId: string | null;
    color: string;
    line: number;
    // 見出しから次の見出しの手前まで。Issue を足すときの範囲
    range: { start: number; end: number };
}

export interface Milestone {
    nodeId: number;
    key: string | null;
    name: string;
    // このマイルストーンへ線が入ってくる Issue (推移的にたどる)
    upstream: number[];
}

export interface Issue {
    nodeId: number;
    key: string | null;
    title: string;
    state: TaskState;
    line: number;
    lines: { start: number; end: number };
    // 子の項目が始まる行。説明を書き直す範囲の終わり
    ownEnd: number;
    indent: string;
    projectId: number | null;
    parentId: number | null;
    childIds: number[];
    owner: string | null;
    priority: Priority | null;
    due: string | null;
    estimate: number | null;
    // 上の四つ以外のタグ。書き戻すときに残す
    otherTags: { key: string; values: string[] }[];
    description: string;
    // relations の線。自分に直接入ってくる / 自分から出ていく Issue
    blockedBy: { nodeId: number; origin: string }[];
    blocking: { nodeId: number; origin: string }[];
    // まだ終わっていない上流 (祖先に入る線も、推移的にたどる)。markdag の requireUpstreamDone と同じ見方
    openBlockers: number[];
    diagnostics: Diagnostic[];
}

export interface Workspace {
    source: string;
    parsed: ParsedDocument;
    model: GraphModel;
    title: string;
    issues: Map<number, Issue>;
    // 文書の順
    order: number[];
    byKey: Map<string, number>;
    projects: Project[];
    milestones: Milestone[];
    owners: string[];
    prefix: string;
    requireUpstreamDone: boolean;
    diagnostics: Diagnostic[];
}

const PALETTE = ['#5E6AD2', '#26B5CE', '#F2994A', '#4CB782', '#EB5757', '#BB87FC', '#F2C94C', '#95A2B3'];

function tagValue(node: OutlineNode, key: string): string | null {
    return node.tags.find((tag) => tag.key === key)?.values[0] ?? null;
}

function isPriority(value: string | null): value is Priority {
    return value !== null && (PRIORITIES as readonly string[]).includes(value);
}

function readDescription(lines: string[], from: number, to: number): string {
    const rows: string[] = [];
    for (let at = from; at < to; at += 1) {
        const found = /^\s*>\s?(.*)$/.exec(lines[at] ?? '');
        if (found) rows.push(found[1]!);
    }
    return rows.join('\n').trim();
}

function enumValues(model: GraphModel, key: string): string[] {
    const def = model.tagKeys.find((entry) => entry.key === key);
    return (def?.alternatives ?? []).flatMap((alternative) => alternative.values ?? []);
}

function frontmatterFlag(frontmatter: Record<string, unknown>): boolean {
    const markdag = frontmatter.markdag as { rules?: { taskToggle?: { requireUpstreamDone?: unknown } } } | undefined;
    return markdag?.rules?.taskToggle?.requireUpstreamDone === true;
}

export function readWorkspace(source: string): Workspace {
    const parsed = parseDocument(source);
    const model = buildModel(parsed.nodes, parsed.frontmatter, source);
    const lines = source.split(/\r?\n/);
    const nodes = new Map(parsed.nodes.map((node) => [node.id, node]));
    const groupColor = new Map(model.groups.map((group) => [group.id, group]));

    // 上流と下流 (relations の線だけ)
    const incoming = new Map<number, { nodeId: number; origin: string }[]>();
    const outgoing = new Map<number, { nodeId: number; origin: string }[]>();
    for (const relation of model.relations) {
        incoming.set(relation.target, [...(incoming.get(relation.target) ?? []), { nodeId: relation.source, origin: relation.origin }]);
        outgoing.set(relation.source, [...(outgoing.get(relation.source) ?? []), { nodeId: relation.target, origin: relation.origin }]);
    }
    const upstreamOf = (start: number[]): Set<number> => {
        const seen = new Set<number>();
        const stack = [...start];
        while (stack.length > 0) {
            const id = stack.pop()!;
            for (const edge of incoming.get(id) ?? []) {
                if (seen.has(edge.nodeId)) continue;
                seen.add(edge.nodeId);
                stack.push(edge.nodeId);
            }
        }
        return seen;
    };

    // プロジェクト: 深さ 2 の見出しでマイルストーンでないもの。範囲は次の深さ 2 の見出しまで
    const headings = parsed.nodes.filter((node) => node.depth === 2 && node.task === null && node.lines !== null);
    const projects: Project[] = [];
    const milestones: Milestone[] = [];
    headings.forEach((node, index) => {
        const next = headings[index + 1];
        if (node.milestone) {
            milestones.push({
                nodeId: node.id,
                key: node.refId,
                name: node.refText,
                upstream: [...upstreamOf([node.id])].filter((id) => nodes.get(id)?.task),
            });
            return;
        }
        const groupId = model.groupsOf.get(node.id)?.[0] ?? null;
        const group = groupId === null ? undefined : groupColor.get(groupId);
        projects.push({
            nodeId: node.id,
            name: node.refText,
            groupId,
            color: group?.color ?? PALETTE[projects.length % PALETTE.length]!,
            line: node.lines!.start,
            range: { start: node.lines!.start, end: next?.lines?.start ?? lines.length },
        });
    });

    const issues = new Map<number, Issue>();
    const order: number[] = [];
    const byKey = new Map<string, number>();
    const diagnosticsByLine = new Map<number, Diagnostic[]>();
    for (const diagnostic of model.diagnostics) {
        if (!diagnostic.at) continue;
        const line = diagnostic.at.line - 1;
        diagnosticsByLine.set(line, [...(diagnosticsByLine.get(line) ?? []), diagnostic]);
    }

    for (const node of parsed.nodes) {
        if (!node.task || !node.lines) continue;
        let projectId: number | null = null;
        let parentId: number | null = null;
        for (let up = node.parent === null ? undefined : nodes.get(node.parent); up; up = up.parent === null ? undefined : nodes.get(up.parent)) {
            if (parentId === null && up.task) parentId = up.id;
            if (projects.some((project) => project.nodeId === up!.id)) {
                projectId = up.id;
                break;
            }
        }
        const children = parsed.nodes.filter((child) => child.parent === node.id);
        const firstChild = children.find((child) => child.lines !== null);
        const ownEnd = firstChild?.lines?.start ?? node.lines.end;
        const first = readFirstLine(lines[node.task.line] ?? '');
        const priority = tagValue(node, 'priority');
        const estimate = Number(tagValue(node, 'estimate'));

        // 祖先に入る線も上流として見る (見出しに引いた線は配下の項目を待たせる)
        const chain: number[] = [];
        for (let up: OutlineNode | undefined = node; up; up = up.parent === null ? undefined : nodes.get(up.parent)) chain.push(up.id);
        const openBlockers = [...upstreamOf(chain)].filter((id) => {
            const task = nodes.get(id)?.task;
            return task !== undefined && task !== null && (task.state === 'todo' || task.state === 'doing');
        });

        const issue: Issue = {
            nodeId: node.id,
            key: node.refId,
            title: first.title || node.refText,
            state: node.task.state,
            line: node.task.line,
            lines: node.lines,
            ownEnd,
            indent: /^\s*/.exec(lines[node.task.line] ?? '')?.[0] ?? '',
            projectId,
            parentId,
            childIds: children.filter((child) => child.task).map((child) => child.id),
            owner: tagValue(node, 'owner'),
            priority: isPriority(priority) ? priority : null,
            due: tagValue(node, 'due'),
            estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null,
            otherTags: node.tags.filter((tag) => !(KNOWN_TAGS as readonly string[]).includes(tag.key)).map(({ key, values }) => ({ key, values })),
            description: readDescription(lines, node.lines.start + 1, ownEnd),
            blockedBy: (incoming.get(node.id) ?? []).filter((edge) => nodes.get(edge.nodeId)?.task),
            blocking: (outgoing.get(node.id) ?? []).filter((edge) => nodes.get(edge.nodeId)?.task),
            openBlockers,
            diagnostics: diagnosticsByLine.get(node.task.line) ?? [],
        };
        issues.set(node.id, issue);
        order.push(node.id);
        if (node.refId) byKey.set(node.refId, node.id);
    }

    // 担当者: 型で決めた一覧と、本文に書かれている名前
    const owners = new Set(enumValues(model, 'owner'));
    for (const issue of issues.values()) if (issue.owner) owners.add(issue.owner);

    // ID の接頭辞: いちばん多く使われているもの
    const counts = new Map<string, number>();
    for (const key of byKey.keys()) {
        const found = /^([A-Za-z]+)-\d+$/.exec(key);
        if (found) counts.set(found[1]!, (counts.get(found[1]!) ?? 0) + 1);
    }
    const prefix = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTM';

    return {
        source,
        parsed,
        model,
        title: parsed.nodes[0]?.refText ?? 'Workspace',
        issues,
        order,
        byKey,
        projects,
        milestones,
        owners: [...owners],
        prefix,
        requireUpstreamDone: frontmatterFlag(parsed.frontmatter),
        diagnostics: model.diagnostics,
    };
}

export function nextKey(workspace: Workspace): string {
    let max = 0;
    for (const key of workspace.byKey.keys()) {
        const found = new RegExp(`^${workspace.prefix}-(\\d+)$`).exec(key);
        if (found) max = Math.max(max, Number(found[1]));
    }
    return `${workspace.prefix}-${max + 1}`;
}

// 書き戻すときのタグの並び。担当、優先度、期日、見積もり、その他
export function tagsOf(issue: Pick<Issue, 'owner' | 'priority' | 'due' | 'estimate' | 'otherTags'>): { key: string; values: string[] }[] {
    const tags: { key: string; values: string[] }[] = [];
    if (issue.owner) tags.push({ key: 'owner', values: [issue.owner] });
    if (issue.priority) tags.push({ key: 'priority', values: [issue.priority] });
    if (issue.due) tags.push({ key: 'due', values: [issue.due] });
    if (issue.estimate !== null) tags.push({ key: 'estimate', values: [String(issue.estimate)] });
    return [...tags, ...issue.otherTags];
}

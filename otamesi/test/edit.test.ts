import { readFileSync } from 'node:fs';
import { init } from 'markdag';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextKey, readWorkspace, tagsOf } from '../src/doc';
import { addDependency, addGroup, appendHeading, insertItem, moveRange, readFirstLine, removeRange, removeRelation, removeRelationsOf, setDescription, setFirstLine, setTaskMark } from '../src/edit';

const sample = readFileSync(new URL('../src/sample.md', import.meta.url), 'utf8');

beforeAll(async () => {
    await init();
});

function issue(source: string, key: string) {
    const workspace = readWorkspace(source);
    const found = workspace.issues.get(workspace.byKey.get(key)!);
    if (!found) throw new Error(`no ${key}`);
    return { workspace, issue: found };
}

describe('readWorkspace', () => {
    it('Issue、プロジェクト、マイルストーンに組み替える', () => {
        const workspace = readWorkspace(sample);
        expect(workspace.diagnostics).toEqual([]);
        expect(workspace.projects.map((project) => project.name)).toEqual(['Web アプリ', 'API', 'インフラ']);
        expect(workspace.milestones.map((milestone) => milestone.key)).toEqual(['beta']);
        expect(workspace.issues.size).toBe(13);
        expect(workspace.prefix).toBe('OTM');
        expect(nextKey(workspace)).toBe('OTM-14');
        expect(workspace.owners).toEqual(['sato', 'suzuki', 'tanaka', 'yamada']);
    });

    it('上流の終わっていないタスクを、祖先の分も含めて集める', () => {
        const { workspace, issue: signup } = issue(sample, 'OTM-5');
        expect(signup.blockedBy.map((edge) => workspace.issues.get(edge.nodeId)?.key)).toEqual(['OTM-2']);
        expect(signup.openBlockers.map((id) => workspace.issues.get(id)?.key)).toEqual(['OTM-2']);
        // 子の項目は親に入る線を受け継ぐ
        const child = workspace.issues.get(workspace.byKey.get('OTM-11')!)!;
        expect(child.parentId).toBe(signup.nodeId);
        expect(child.openBlockers.map((id) => workspace.issues.get(id)?.key)).toEqual(['OTM-2']);
        expect(signup.description).toBe('入力エラーは各フィールドの直下に出す');
        expect(signup.priority).toBe('high');
        expect(signup.estimate).toBe(5);
    });
});

describe('edit', () => {
    it('1 行目を印、題名、グループ、ID に分ける', () => {
        expect(readFirstLine('    - [/] 作業 名 %web #owner:"a b" #urgent $OTM-3')).toEqual({
            head: '    - ',
            mark: '/',
            title: '作業 名',
            groups: ['web'],
            id: 'OTM-3',
        });
    });

    it('状態、題名、タグを書き換える', () => {
        const { issue: target } = issue(sample, 'OTM-4');
        let next = setTaskMark(sample, target.line, '/');
        expect(issue(next, 'OTM-4').issue.state).toBe('doing');
        next = setFirstLine(next, target.line, { title: '一覧画面', tags: tagsOf({ ...target, owner: 'yamada', due: null }) });
        const after = issue(next, 'OTM-4').issue;
        expect(after.title).toBe('一覧画面');
        expect(after.owner).toBe('yamada');
        expect(after.due).toBeNull();
        expect(next.split('\n')[target.line]).toBe('- [/] 一覧画面 #owner:yamada #priority:medium #estimate:5 $OTM-4');
    });

    it('説明を書き換えても子の項目は残る', () => {
        const { issue: target } = issue(sample, 'OTM-5');
        const next = setDescription(sample, target.line, target.ownEnd, '1 行目\n\n2 行目');
        const after = issue(next, 'OTM-5');
        expect(after.issue.description).toBe('1 行目\n\n2 行目');
        expect(after.issue.childIds).toHaveLength(2);
        expect(after.workspace.diagnostics).toEqual([]);
        const cleared = setDescription(next, after.issue.line, after.issue.ownEnd, '');
        expect(issue(cleared, 'OTM-5').issue.description).toBe('');
    });

    it('プロジェクトの末尾に Issue を足し、消せる', () => {
        const workspace = readWorkspace(sample);
        const api = workspace.projects[1]!;
        const next = insertItem(sample, api.range.start, api.range.end, '', {
            mark: ' ',
            title: '新しい作業',
            tags: [{ key: 'priority', values: ['high'] }],
            id: nextKey(workspace),
            description: 'メモ',
        });
        const added = issue(next, 'OTM-14');
        expect(added.issue.projectId).toBe(api.nodeId);
        expect(added.issue.description).toBe('メモ');
        expect(added.workspace.diagnostics).toEqual([]);
        const removed = readWorkspace(removeRange(next, added.issue.lines.start, added.issue.lines.end));
        expect(removed.byKey.has('OTM-14')).toBe(false);
        expect(removed.projects.map((project) => project.name)).toEqual(['Web アプリ', 'API', 'インフラ']);
    });

    it('子の項目を足す', () => {
        const { workspace, issue: parent } = issue(sample, 'OTM-2');
        const next = insertItem(sample, parent.lines.start, parent.lines.end, `${parent.indent}    `, {
            mark: ' ',
            title: 'トークンの有効期限',
            tags: [],
            id: nextKey(workspace),
            description: '',
        });
        expect(issue(next, 'OTM-14').issue.parentId).toBe(parent.nodeId);
    });

    it('別のプロジェクトへ動かす', () => {
        const { workspace, issue: target } = issue(sample, 'OTM-5');
        const infra = workspace.projects[2]!;
        const next = moveRange(sample, target.lines.start, target.lines.end, infra.range);
        const moved = issue(next, 'OTM-5');
        expect(moved.issue.projectId).toBe(moved.workspace.projects[2]!.nodeId);
        expect(moved.issue.childIds).toHaveLength(2);
        expect(moved.workspace.diagnostics).toEqual([]);
    });

    it('依存を足し、外す', () => {
        let next = addDependency(sample, 'OTM-1', 'OTM-13');
        expect(next).toContain('            - $OTM-1 --> $OTM-13\n');
        expect(next).toContain("cycle: [' ', '/', 'x']");
        expect(next).toContain('color: "#5E6AD2"');
        let target = issue(next, 'OTM-13');
        expect(target.issue.blockedBy.map((edge) => target.workspace.issues.get(edge.nodeId)?.key)).toEqual(['OTM-1']);
        next = removeRelation(next, '$OTM-1 --> $OTM-13', 'OTM-1', 'OTM-13')!;
        target = issue(next, 'OTM-13');
        expect(target.issue.blockedBy).toEqual([]);
        // join の式からは 1 項だけ抜く
        next = removeRelation(next, '$OTM-5 & $OTM-4 & $OTM-9 --> $beta', 'OTM-4', 'beta')!;
        expect(next).toContain('- $OTM-5 & $OTM-9 --> $beta');
        expect(readWorkspace(next).milestones[0]!.upstream).toHaveLength(4);
    });

    it('Issue を消すとき、その ID を含む式も消す', () => {
        const next = removeRelationsOf(sample, ['OTM-2']);
        const front = next.slice(0, next.indexOf('\n---\n'));
        expect(front).not.toContain('$OTM-2');
        expect(front).toContain('$OTM-3 --> $OTM-4');
        expect(front).toContain('$OTM-9 --> $OTM-8');
    });

    it('プロジェクトを足す', () => {
        let next = addGroup(sample, 'p4', 'モバイル', '#4CB782');
        next = appendHeading(next, '## モバイル %p4');
        const workspace = readWorkspace(next);
        expect(workspace.diagnostics).toEqual([]);
        expect(workspace.projects.at(-1)).toMatchObject({ name: 'モバイル', groupId: 'p4', color: '#4CB782' });
    });
});

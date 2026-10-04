// 操作の命令のうち DOM を使わない部品を確かめる: 操作の組み立て、付け替えの移す先の枠を出す相手、
// editSource を当てる試み (読めない入力は失敗として返す)、書き換えた結果の通知の文 (承認した受け入れの例の文)。
// 仮の名前は、足したノードが「新しいノード」、新しい合流先が「合流点」。ルートの兄弟は子として足す
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';
import type { EditOp, NodeTarget } from '../src/core';
import {
    JOIN_NODE_LABEL,
    NEW_NODE_LABEL,
    addNodeOp,
    addRelationOp,
    addToGroupOp,
    attemptEdit,
    defineGroupOp,
    deleteNodesOp,
    editedNotice,
    groupNodesOp,
    isDropCandidate,
    joinIntoNewOp,
    joinIntoOp,
    moveNodeOp,
    removeTagOp,
    renameGroupOp,
    renameNodeOp,
    setDetailsOp,
    setGroupBoundaryOp,
    setGroupColorOp,
    setTagOp,
    toggleTagOp,
    ungroupOp,
} from '../src/editor/commands';
import type { EditedOutcome } from '../src/editor/source';

const example = (path: string): string => readFileSync(new URL(`../testdata/acceptance/gui-editor/${path}`, import.meta.url), 'utf8');

// 1 計画 / 2 設計 (%g1、label 設計) / 3 画面 / 4 API / 5 実装 / 6 フロント / 7 バック / 8 公開。depends 画面 → 公開
const BASE = example('screen/join-existing/input.md');

function target(source: string, refText: string): NodeTarget {
    const node = core.parseDocument(source).nodes.find((item) => item.refText === refText);
    if (node === undefined) throw new Error(`「${refText}」のノードがない`);
    return { id: node.id, refText: node.refText };
}

function editedBy(source: string, op: EditOp): EditedOutcome {
    const outcome = core.editSource(source, op);
    if (outcome.status !== 'edited') throw new Error(`書き換えるはず: ${JSON.stringify(outcome)}`);
    return outcome;
}

const n = (id: number, refText: string): NodeTarget => ({ id, refText });

describe('操作の組み立て (design 3.3)', () => {
    it('仮の名前は「新しいノード」と「合流点」', () => {
        expect(NEW_NODE_LABEL).toBe('新しいノード');
        expect(JOIN_NODE_LABEL).toBe('合流点');
    });

    it('子と兄弟の追加は仮の名前で足し、ルートの兄弟は子として足す (B-023)', () => {
        expect(addNodeOp('child', n(2, 'a'), false)).toEqual({ kind: 'addChild', parent: n(2, 'a'), label: '新しいノード' });
        expect(addNodeOp('sibling', n(2, 'a'), false)).toEqual({ kind: 'addSibling', node: n(2, 'a'), label: '新しいノード' });
        expect(addNodeOp('sibling', n(1, 'R'), true)).toEqual({ kind: 'addChild', parent: n(1, 'R'), label: '新しいノード' });
        expect(addNodeOp('child', n(1, 'R'), true)).toEqual({ kind: 'addChild', parent: n(1, 'R'), label: '新しいノード' });
    });

    it('新しい合流先への合流は仮の名前「合流点」で作る (B-097)', () => {
        expect(joinIntoNewOp([n(2, 'a'), n(3, 'b')])).toEqual({ kind: 'joinIntoNew', sources: [n(2, 'a'), n(3, 'b')], label: '合流点' });
    });

    it('どの操作も design 3.3 の欄だけを持つ', () => {
        const a = n(2, 'a');
        const b = n(3, 'b');
        const cases: Array<[EditOp, EditOp]> = [
            [renameNodeOp(a, 'x'), { kind: 'renameNode', node: a, label: 'x' }],
            [deleteNodesOp([a, b]), { kind: 'deleteNodes', nodes: [a, b] }],
            [moveNodeOp(a, b), { kind: 'moveNode', node: a, parent: b }],
            [addRelationOp(a, b), { kind: 'addRelation', from: a, to: b }],
            [joinIntoOp([a, b], n(4, 'c')), { kind: 'joinInto', sources: [a, b], target: n(4, 'c') }],
            [groupNodesOp([a, b]), { kind: 'groupNodes', nodes: [a, b] }],
            [renameGroupOp('g', 'G'), { kind: 'renameGroup', group: 'g', label: 'G' }],
            [ungroupOp('g'), { kind: 'ungroup', group: 'g' }],
            [addToGroupOp('g', [a]), { kind: 'addToGroup', group: 'g', nodes: [a] }],
            [defineGroupOp(), { kind: 'defineGroup' }],
            [setGroupColorOp('g', '#123456'), { kind: 'setGroupColor', group: 'g', color: '#123456' }],
            [setGroupBoundaryOp('g', false), { kind: 'setGroupBoundary', group: 'g', boundary: false }],
            [setDetailsOp(a, 'd'), { kind: 'setDetails', node: a, text: 'd' }],
            [setTagOp([a, b], 'k', null, 'old'), { kind: 'setTag', nodes: [a, b], key: 'k', value: null, replaceKey: 'old' }],
            [setTagOp([a], 'k', 'v', null), { kind: 'setTag', nodes: [a], key: 'k', value: 'v', replaceKey: null }],
            [removeTagOp([a], 'k'), { kind: 'removeTag', nodes: [a], key: 'k' }],
            [toggleTagOp([a, b], { key: 'k', value: null }), { kind: 'toggleTag', nodes: [a, b], key: 'k', value: null }],
            [toggleTagOp([a], { key: 'k', value: 'v' }), { kind: 'toggleTag', nodes: [a], key: 'k', value: 'v' }],
        ];
        for (const [built, expected] of cases) expect(built, expected.kind).toStrictEqual(expected);
    });

    it('組み立てた操作は、どれも書き換えの入口が読める (失敗にならない)', () => {
        const [screen, api, front, back, release] = ['画面', 'API', 'フロント', 'バック', '公開'].map((name) => target(BASE, name)) as [NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget];
        const ops: EditOp[] = [
            addNodeOp('child', api, false),
            addNodeOp('sibling', api, false),
            addNodeOp('sibling', target(BASE, '計画'), true),
            renameNodeOp(api, 'サーバー'),
            deleteNodesOp([front, back]),
            moveNodeOp(back, target(BASE, '設計')),
            addRelationOp(api, front),
            joinIntoOp([front, back], release),
            joinIntoNewOp([api, back]),
            groupNodesOp([front, back]),
            renameGroupOp('g1', '基本設計'),
            ungroupOp('g1'),
            addToGroupOp('g1', [front]),
            defineGroupOp(),
            setGroupColorOp('g1', '#2E9E6B'),
            setGroupBoundaryOp('g1', false),
            setDetailsOp(screen, 'メモ'),
            setTagOp([screen, api], 'prio', 'high', null),
            removeTagOp([screen], 'owner'),
            toggleTagOp([screen, api], { key: 'owner', value: 'alice' }),
        ];
        for (const op of ops) {
            const attempt = attemptEdit(BASE, op);
            expect(attempt.status, `${op.kind}: ${JSON.stringify(attempt)}`).toBe('edited');
        }
    });
});

describe('付け替えの移す先の枠を出す相手 (B-055、B-057)', () => {
    const nodes = core.parseDocument(BASE).nodes;
    const id = (refText: string): number => target(BASE, refText).id;

    it('ほかの枝のノードと、祖先 (今の親でないもの) には出す', () => {
        expect(isDropCandidate(nodes, id('画面'), id('実装'))).toBe(true);
        expect(isDropCandidate(nodes, id('画面'), id('フロント'))).toBe(true);
        expect(isDropCandidate(nodes, id('画面'), id('計画'))).toBe(true);
        expect(isDropCandidate(nodes, id('設計'), id('公開'))).toBe(true);
    });

    it('自分、自分の配下、今の親 (すでにその子) には出さない', () => {
        expect(isDropCandidate(nodes, id('画面'), id('画面'))).toBe(false);
        expect(isDropCandidate(nodes, id('設計'), id('画面'))).toBe(false);
        expect(isDropCandidate(nodes, id('設計'), id('API'))).toBe(false);
        expect(isDropCandidate(nodes, id('画面'), id('設計'))).toBe(false);
        expect(isDropCandidate(nodes, id('設計'), id('計画'))).toBe(false);
    });
});

describe('書き換えの試み (design 3.3 の失敗の返し方)', () => {
    it('書き換えた結果、断った結果、変えない結果はそのまま返す', () => {
        const api = target(BASE, 'API');
        expect(attemptEdit(BASE, renameNodeOp(api, 'サーバー'))).toEqual(core.editSource(BASE, renameNodeOp(api, 'サーバー')));
        const root = deleteNodesOp([target(BASE, '計画')]);
        expect(attemptEdit(BASE, root)).toMatchObject({ status: 'refused', reason: { code: 'root' } });
        expect(attemptEdit(BASE, renameNodeOp(api, 'API'))).toMatchObject({ status: 'unchanged', reason: { code: 'same-name' } });
    });

    it('入力の形が読めない操作は投げずに失敗として返し、理由の文を持つ', () => {
        for (const op of [{ kind: 'unknownOp' }, { kind: 'renameNode', node: { id: 'x', refText: 1 }, label: 'a' }] as unknown as EditOp[]) {
            const attempt = attemptEdit(BASE, op);
            expect(attempt.status).toBe('failed');
            if (attempt.status === 'failed') expect(attempt.message).toMatch(/\S/);
        }
    });
});

describe('書き換えた結果の通知の文 (B-003。承認した受け入れの例の文)', () => {
    it('1 つのノードを消したときは名前、2 つ以上は数 (screen/delete-undo-redo、screen/multi-select)', () => {
        const one = deleteNodesOp([target(BASE, 'バック')]);
        expect(editedNotice(one, editedBy(BASE, one))).toBe('「バック」を消しました');
        const two = deleteNodesOp([target(BASE, 'フロント'), target(BASE, 'バック')]);
        expect(editedNotice(two, editedBy(BASE, two))).toBe('選んだ 2 個のノードを消しました');
    });

    it('消して relations を直したときは、直した項目ごとの文を続ける (screen/delete-undo-redo)', () => {
        const source = example('screen/delete-undo-redo/after-delete.md');
        const op = deleteNodesOp([target(source, '画面')]);
        expect(editedNotice(op, editedBy(source, op))).toBe('「画面」を消しました。depends「画面 --> 公開」を外した (片側の項が全部なくなった)');
    });

    it('既存のノードへの合流は合わせた数、外した始点があればその知らせを続ける (screen/join-existing)', () => {
        const op = joinIntoOp([target(BASE, 'フロント'), target(BASE, 'バック')], target(BASE, '公開'));
        expect(editedNotice(op, editedBy(BASE, op))).toBe('2 個のノードを「公開」へ合流させました');
        const source = example('screen/join-existing/after-join.md');
        const again = joinIntoOp([target(source, '画面'), target(source, 'API')], target(source, '公開'));
        expect(editedNotice(again, editedBy(source, again))).toBe('1 個のノードを「公開」へ合流させました。合流先へもう線がある始点が 1 個あったので外しました');
    });

    it('線を引いたときは始点と終点の名前 (screen/link-drag-and-edge)', () => {
        const op = addRelationOp(target(BASE, 'API'), target(BASE, 'フロント'));
        expect(editedNotice(op, editedBy(BASE, op))).toBe('「API」から「フロント」へ線を引きました');
    });

    it('グループの操作はグループの名前 (screen/legend-panel、screen/group-frame-select)', () => {
        const color = setGroupColorOp('g1', '#2E9E6B');
        expect(editedNotice(color, editedBy(BASE, color), [], { groupLabel: '設計' })).toBe('グループ「設計」の色を #2E9E6B にしました');
        const ungroup = ungroupOp('g1');
        expect(editedNotice(ungroup, editedBy(BASE, ungroup), [], { groupLabel: '設計' })).toBe('グループ「設計」を解除しました');
    });

    it('どの操作の文も 1 行', () => {
        const [screen, api, front, back, release] = ['画面', 'API', 'フロント', 'バック', '公開'].map((name) => target(BASE, name)) as [NodeTarget, NodeTarget, NodeTarget, NodeTarget, NodeTarget];
        const ops: EditOp[] = [
            addNodeOp('child', api, false),
            addNodeOp('sibling', api, false),
            renameNodeOp(api, 'サーバー'),
            renameNodeOp(front, 'フロントエンド'),
            deleteNodesOp([screen]),
            moveNodeOp(back, target(BASE, '設計')),
            addRelationOp(api, front),
            joinIntoOp([front, back], release),
            joinIntoNewOp([api, back]),
            groupNodesOp([front, back]),
            renameGroupOp('g1', '基本設計'),
            ungroupOp('g1'),
            addToGroupOp('g1', [front]),
            defineGroupOp(),
            setGroupColorOp('g1', '#2E9E6B'),
            setGroupBoundaryOp('g1', false),
            setDetailsOp(screen, '1 行目\n2 行目'),
            setTagOp([screen, api], 'prio', 'high', null),
            removeTagOp([screen], 'owner'),
            toggleTagOp([screen, api], { key: 'owner', value: 'alice' }),
        ];
        for (const op of ops) {
            const text = editedNotice(op, editedBy(BASE, op), [], { groupLabel: '設計' });
            expect(text, op.kind).toMatch(/\S/);
            expect(text, op.kind).not.toMatch(/[\r\n\u2028\u2029]/);
        }
    });
});

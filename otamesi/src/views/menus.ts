// 状態、優先度、担当の選択肢。リスト、ボード、詳細で同じものを使う
import { changeFields } from '../actions';
import type { AppContext } from '../context';
import { type Issue, PRIORITIES, STATES } from '../doc';
import { avatar, type MenuItem, PRIORITY_LABEL, priorityIcon, STATE_LABEL, stateIcon } from '../dom';

export function chooseState(ctx: AppContext, issue: Issue): MenuItem[] {
    return STATES.map((state) => ({
        label: STATE_LABEL[state],
        icon: stateIcon(state),
        checked: issue.state === state,
        run: () => ctx.setState(issue, state),
    }));
}

export function choosePriority(ctx: AppContext, issue: Issue): MenuItem[] {
    return [
        ...PRIORITIES.map((priority) => ({
            label: PRIORITY_LABEL[priority],
            hint: priority,
            icon: priorityIcon(priority),
            checked: issue.priority === priority,
            run: () => ctx.commit(changeFields(ctx.workspace, issue, { priority })),
        })),
        { label: 'なし', icon: priorityIcon(null), checked: issue.priority === null, run: () => ctx.commit(changeFields(ctx.workspace, issue, { priority: null })) },
    ];
}

export function chooseOwner(ctx: AppContext, issue: Issue): MenuItem[] {
    return [
        { label: '担当なし', icon: avatar(null, 18), checked: issue.owner === null, run: () => ctx.commit(changeFields(ctx.workspace, issue, { owner: null })) },
        ...ctx.workspace.owners.map((owner) => ({
            label: owner,
            icon: avatar(owner, 18),
            checked: issue.owner === owner,
            run: () => ctx.commit(changeFields(ctx.workspace, issue, { owner })),
        })),
    ];
}

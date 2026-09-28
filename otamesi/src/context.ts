// 各画面が受け取るもの。状態 (何を選んでいるか、どう絞り込んでいるか) と、操作の入口
import type { TaskState } from 'markdag';
import type { Result } from './actions';
import type { Issue, Workspace } from './doc';
import type { Store } from './store';

export type ViewName = 'list' | 'board' | 'graph' | 'source';

export interface Filters {
    projectId: number | null;
    milestoneId: number | null;
    owner: string | null;
    query: string;
    showClosed: boolean;
}

export interface AppContext {
    store: Store;
    readonly workspace: Workspace;
    readonly view: ViewName;
    readonly selected: number | null;
    readonly filters: Filters;
    select(nodeId: number | null): void;
    setView(view: ViewName): void;
    setFilters(change: Partial<Filters>): void;
    // Result を反映する。失敗なら理由を知らせて false
    commit(result: Result, message?: string): boolean;
    setState(issue: Issue, state: TaskState): void;
    openCreate(defaults?: { projectId?: number | null; parentId?: number | null; state?: TaskState }): void;
    // Markdown の画面でその行を選ぶ
    revealSource(line: number, end?: number): void;
    visibleIssues(): Issue[];
}

// タグのパネルに出す中身の組み立て (DOM を使わない)。登録されているタグ (文書で使われているタグと markdag.tags.keys のキー)、
// 選んだノードに付いているタグ、選んだノードのうちそのタグを持つ数の状態、最近使ったタグの並び、絞り込み、入れたキーと値の整え方を受け持つ。
// タグの 1 行はキーと値の組 (値のないタグとキーの定義の行は value が null) で、複数の値のタグは値ごとに 1 行にする。
// 並べ方は文字の符号の順 (地域の並べ方によらない)。行の文字は本文に書く形 (formatTag と同じ囲みと逃がし) にする。
// 最近使ったタグを覚えておく期間 (mount の間) と、行の見せ方は呼ぶ側が受け持つ
import { formatTag, type GraphModel } from '../core';

// タグの 1 行。値のないタグ (#キー) と markdag.tags.keys のキーは value が null
export interface TagChoice {
    key: string;
    value: string | null;
}

export type TagState = 'all' | 'some' | 'none';

// 最近使ったタグを覚える数 (タグ選択の上に出す数と同じ)
const RECENT_LIMIT = 3;

// 入れた値の改行 (名前の行と同じ 5 種類) は空白 1 つにする
const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

export function sameTag(a: TagChoice, b: TagChoice): boolean {
    return a.key === b.key && a.value === b.value;
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

// キー、値の順。同じキーではキーだけの行 (value null) を値の行の前に置く
function compareTags(a: TagChoice, b: TagChoice): number {
    const byKey = compareText(a.key, b.key);
    if (byKey !== 0) return byKey;
    if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? -1 : 1;
    return compareText(a.value, b.value);
}

// 重なりを除いて、キー、値の順に並べた新しい並び
export function mergeTags(...lists: ReadonlyArray<readonly TagChoice[]>): TagChoice[] {
    const rows: TagChoice[] = [];
    for (const list of lists) for (const tag of list) if (!rows.some((row) => sameTag(row, tag))) rows.push({ key: tag.key, value: tag.value });
    return rows.sort(compareTags);
}

// 文書で使われているタグ (値ごとに 1 行。値のないタグは value null) と、markdag.tags.keys のキー (value null)。同じキーと値は 1 行
export function registeredTags(model: Pick<GraphModel, 'tagsOf' | 'tagKeys'>): TagChoice[] {
    const used: TagChoice[] = [];
    for (const tags of model.tagsOf.values()) {
        for (const tag of tags) {
            if (tag.values.length === 0) used.push({ key: tag.key, value: null });
            else for (const value of tag.values) used.push({ key: tag.key, value });
        }
    }
    return mergeTags(
        used,
        model.tagKeys.map((def) => ({ key: def.key, value: null })),
    );
}

// ノードがそのタグを持つか。value のある行はそのキーにその値があること、value null の行はそのキーのタグがあること (値は問わない)
export function hasTag(model: Pick<GraphModel, 'tagsOf'>, id: number, tag: TagChoice): boolean {
    return (model.tagsOf.get(id) ?? []).some((item) => item.key === tag.key && (tag.value === null || item.values.includes(tag.value)));
}

// 選んだノードのうちそのタグを持つ数の状態。全部なら all、一部なら some、どれも持たない (選んでいない) なら none
export function tagState(model: Pick<GraphModel, 'tagsOf'>, nodes: readonly number[], tag: TagChoice): TagState {
    const count = nodes.filter((id) => hasTag(model, id, tag)).length;
    return count === 0 ? 'none' : count === nodes.length ? 'all' : 'some';
}

// 選んだノードに付いているタグ (キーと値の組ごとに 1 行)。ノードは文書の順、タグは書いた順、値は値の順に並べ、同じ組は最初のものだけを残す
export function attachedTags(model: Pick<GraphModel, 'tagsOf'>, nodes: readonly number[]): TagChoice[] {
    const rows: TagChoice[] = [];
    const push = (tag: TagChoice): void => {
        if (!rows.some((row) => sameTag(row, tag))) rows.push(tag);
    };
    for (const id of [...nodes].sort((a, b) => a - b)) {
        for (const tag of model.tagsOf.get(id) ?? []) {
            if (tag.values.length === 0) push({ key: tag.key, value: null });
            else for (const value of tag.values) push({ key: tag.key, value });
        }
    }
    return rows;
}

// 付けたタグを先頭に置いた新しい並び。同じキーと値は前のものを外し、3 つまで覚える (古いものから落とす)
export function rememberTag(recent: readonly TagChoice[], tag: TagChoice): TagChoice[] {
    return [{ key: tag.key, value: tag.value }, ...recent.filter((item) => !sameTag(item, tag))].slice(0, RECENT_LIMIT);
}

// 本文に書く形の文字 (#キー か #キー:値)。キーと値は要るときだけ " で囲み、囲みの中の " と \ を逃がす (解析が同じキーと値に読み戻す形)。
// 行の文字と絞り込みに使う
export function tagText(tag: TagChoice): string {
    return formatTag({ key: tag.key, values: tag.value === null ? [] : [tag.value] });
}

// 絞り込み: 行の文字 (囲みと逃がしを含む #キー:値) に、入れた文字 (前後の空白を除く) を大文字と小文字によらず含む行だけ。空なら全部
export function filterTags<T extends TagChoice>(rows: readonly T[], text: string): T[] {
    const needle = text.trim().toLowerCase();
    return needle === '' ? [...rows] : rows.filter((row) => tagText(row).toLowerCase().includes(needle));
}

// 入れたキーと値を、書き換えの側と同じ規則で整えた組。キーは前後の空白と先頭の # を 1 つ外し、値は改行を空白にして前後の空白を外す (空なら null)。
// 書けるキーかは確かめない (書き換えの側が断る)
export function tagChoiceOf(key: string, value: string | null): TagChoice {
    const trimmed = key.trim();
    const text = (value ?? '').replace(LINE_BREAKS, ' ').trim();
    return { key: trimmed.startsWith('#') ? trimmed.slice(1) : trimmed, value: text === '' ? null : text };
}

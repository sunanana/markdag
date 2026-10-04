// 最後の関門で決まった編集の層の直しのうち、DOM を使わない部品を、直す前に落ちるテストとして書く。
// タグのパネルの行の文字 (tagText。plan.md の 9 の編集の層): キーと値を要るときだけ " で囲み、囲みの中の " と \ を逃がす。
// 解析と formatTag と同じ規則で、行の文字をそのまま本文のタグとして書けば同じキーと値に読まれる。囲まなくてよいタグと絞り込みは今と同じ (守り)
import { describe, expect, it } from 'vitest';
import * as core from '../src/core';
import { filterTags, tagText, type TagChoice } from '../src/editor/tags';

const choice = (key: string, value: string | null = null): TagChoice => Object.freeze({ key, value });

// 囲みと逃がしの要るタグと、行の文字 (formatTag と同じ形)
const QUOTED: Array<[TagChoice, string]> = [
    [choice('a b', 'x'), String.raw`#"a b":x`],
    [choice('owner', '山田 太郎'), String.raw`#owner:"山田 太郎"`],
    [choice('owner', 'a,b'), String.raw`#owner:"a,b"`],
    [choice('note', 'say "hi"'), String.raw`#note:"say \"hi\""`],
    [choice('path', 'C:\\dir'), String.raw`#path:"C:\\dir"`],
    [choice('k', ''), String.raw`#k:""`],
    [choice('123'), String.raw`#"123"`],
    [choice('a"b'), String.raw`#"a\"b"`],
    [choice('s.a', 'v'), String.raw`#"s.a":v`],
    [choice('a:b', 'c'), String.raw`#"a:b":c`],
];

// 囲まなくてよいタグ (今と同じ形)
const PLAIN: Array<[TagChoice, string]> = [
    [choice('owner', 'alice'), '#owner:alice'],
    [choice('urgent'), '#urgent'],
    [choice('prio-1', 'a_b'), '#prio-1:a_b'],
    [choice('担当', '山田'), '#担当:山田'],
];

describe('タグのパネルの行の文字 (plan.md の 9 の編集の層)', () => {
    it('キーと値を要るときだけ " で囲み、囲みの中の " と \\ を逃がす (formatTag と同じ形)', () => {
        for (const [tag, text] of QUOTED) {
            expect(tagText(tag), JSON.stringify(tag)).toBe(text);
            expect(tagText(tag), JSON.stringify(tag)).toBe(core.formatTag({ key: tag.key, values: tag.value === null ? [] : [tag.value] }));
        }
    });

    it('行の文字をそのまま本文のタグとして書くと、解析は同じキーと値に読む', () => {
        for (const [tag] of [...QUOTED, ...PLAIN]) {
            const source = ['---', 'markdag:', '---', '', '# R', '', `- a ${tagText(tag)}`, ''].join('\n');
            const node = core.parseDocument(source).nodes[1];
            expect(node?.refText, JSON.stringify(tag)).toBe('a');
            expect(
                node?.tags.map((item) => ({ key: item.key, values: item.values })),
                JSON.stringify(tag),
            ).toEqual([{ key: tag.key, values: tag.value === null ? [] : [tag.value] }]);
        }
    });

    it('守り: 囲まなくてよいタグは今と同じ (#キー か #キー:値)', () => {
        for (const [tag, text] of PLAIN) expect(tagText(tag), JSON.stringify(tag)).toBe(text);
    });

    it('守り: 絞り込みは、キーと値の中の字 (囲みの外の字) で当たる', () => {
        const rows = [choice('owner', '山田 太郎'), choice('a b', 'x'), choice('owner', 'alice')];
        expect(filterTags(rows, '山田')).toEqual([choice('owner', '山田 太郎')]);
        expect(filterTags(rows, 'alice')).toEqual([choice('owner', 'alice')]);
        expect(filterTags(rows, 'owner')).toEqual([choice('owner', '山田 太郎'), choice('owner', 'alice')]);
    });
});

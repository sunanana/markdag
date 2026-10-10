// GUI 編集の受け入れテスト (data と frontmatter の面)。置き場の例を 1 件ずつ回す (テストの名前は 面/名前)。
// 公開の入口 (markdag/core の editSource、parseDocument、buildModel) だけを呼ぶ。期待は expect.yaml から読み、ここに写さない。
// - data: input.md に op (ノードは名前で書いたもの) を editSource で当て、状態、書き換えたあとの原文、選び直すもの、名前の入力の相手、知らせ、断る理由を照らす
// - frontmatter: input.md の診断 (severity と code を出る順に全部) と、読んだ markdag.editor を照らす。
//   mount した図のモードとセグメントと道具箱 (expect の screen の欄) は DOM が要るので、e2e の受け入れテストが同じ例をブラウザで照らす
import { describe, expect, it } from 'vitest';
import { buildModel, editSource, parseDocument } from '../src/core';
import { editOpOf, failuresOf, frontmatterOutcomeOf, inputOf, listGuiExamples, outcomeOf, rowsOf, specProblems, type GuiExample } from './acceptance/gui-editor-examples';

const DATA = listGuiExamples('data');
const FRONTMATTER = listGuiExamples('frontmatter');

function runData(example: GuiExample): string[] {
    const input = inputOf(example);
    if (!example.spec.op) return ['expect.yaml に op がありません'];
    const outcome = editSource(input, editOpOf(example.spec.op, parseDocument(input).nodes));
    return failuresOf(rowsOf('', example.spec.expect ?? {}, outcomeOf(outcome, parseDocument), example.files));
}

function runFrontmatter(example: GuiExample): string[] {
    const input = inputOf(example);
    const parsed = parseDocument(input);
    const model = buildModel(parsed.nodes, parsed.frontmatter, input);
    const { screen: _screen, ...expected } = example.spec.expect ?? {};
    return failuresOf(rowsOf('', expected, frontmatterOutcomeOf(model), example.files));
}

describe('受け入れの例 @editor: data', () => {
    it('@editor data の例が 76 件ある', () => {
        expect(DATA.length).toBe(76);
    });

    for (const example of DATA) {
        it(`@editor ${example.id} (${example.spec.kind})`, () => {
            expect(specProblems(example)).toEqual([]);
            expect(runData(example)).toEqual([]);
        });
    }
});

describe('受け入れの例 @editor: frontmatter (診断と読んだ設定)', () => {
    it('@editor frontmatter の例が 9 件ある', () => {
        expect(FRONTMATTER.length).toBe(9);
    });

    for (const example of FRONTMATTER) {
        it(`@editor ${example.id} (${example.spec.kind})`, () => {
            expect(specProblems(example)).toEqual([]);
            expect(runFrontmatter(example)).toEqual([]);
        });
    }
});

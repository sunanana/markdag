// グループの枠の受け入れテスト (library の面のうち、配置の実測の要らない欄)。testdata/acceptance/frames/library/ の例を 1 件ずつ回す。
// 公開の入口 (src/index の parseDocument と buildModel) だけを呼ぶ。期待は expect.yaml から読み、ここに写さない。
// 枠の矩形、入り込み、sides、visible、edges、clearance は描いた図の実測が要るので、e2e/acceptance-frames.spec.ts が同じ例をブラウザで回す。
// ここで確かめるのは:
// - diagnostics: buildModel の診断 (render の diagram.diagnostics は、フックのない文書では buildModel の診断と同じ)
// - グループのメンバー: 期待の frames の members と unframed に書いたノードが、そのグループを groupsOf に持ち、
//   そのグループが boundary: true であること (枠を読む前提。どのノードがどの枠に入るかは配置で決まるのでブラウザの側)
import { describe, expect, it } from 'vitest';
import { buildModel, parseDocument } from '../src/index';
import { CALL_KEYS, compare, diagnosticsOf, LIBRARY_EXPECT_KEYS, listExamples, namer, SPEC_KEYS, unknownKeys, type FramesExample } from './acceptance/frames-examples';

const EXAMPLES = listExamples('library');

function checkMembership(example: FramesExample): string[] {
    const parsed = parseDocument(example.input);
    const model = buildModel(parsed.nodes, parsed.frontmatter, example.input);
    const want = example.spec.expect as Record<string, any>;
    const problems: string[] = [];
    if (want.diagnostics !== undefined) compare(want.diagnostics, diagnosticsOf(model.diagnostics), 'expect.diagnostics', problems);
    const { idOf } = namer(parsed.nodes);
    const boundary = new Set(model.groups.filter((group) => group.boundary).map((group) => group.id));
    const checkMember = (group: string, text: string, label: string): void => {
        const id = idOf(text);
        if (id === undefined) {
            problems.push(`${label}: ノード「${text}」がない`);
            return;
        }
        if (!(model.groupsOf.get(id) ?? []).includes(group)) problems.push(`${label}: 「${text}」の groupsOf ${JSON.stringify(model.groupsOf.get(id) ?? [])} に ${group} がない`);
    };
    for (const [index, frame] of ((want.frames ?? []) as Array<{ group: string; members: string[] }>).entries()) {
        const label = `expect.frames[${index}]`;
        if (!boundary.has(frame.group)) problems.push(`${label}: グループ ${frame.group} が boundary: true でない`);
        for (const text of frame.members) checkMember(frame.group, text, `${label}.members`);
    }
    for (const [group, texts] of Object.entries((want.unframed ?? {}) as Record<string, string[]>)) {
        if (!boundary.has(group)) problems.push(`expect.unframed.${group}: boundary: true でない`);
        for (const text of texts) checkMember(group, text, `expect.unframed.${group}`);
    }
    return problems;
}

describe('受け入れの例 @frames: library (配置の実測の要らない欄)', () => {
    it('@frames library の例が 27 件ある', () => {
        expect(EXAMPLES.length).toBe(27);
    });

    for (const example of EXAMPLES) {
        it(`@frames ${example.id} (${example.spec.kind})`, () => {
            expect([
                ...unknownKeys(example.spec, SPEC_KEYS, example.id),
                ...unknownKeys(example.spec.call, CALL_KEYS, `${example.id}.call`),
                ...unknownKeys(example.spec.expect, LIBRARY_EXPECT_KEYS, `${example.id}.expect`),
            ]).toEqual([]);
            expect(checkMembership(example)).toEqual([]);
        });
    }
});

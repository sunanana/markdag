// GUI 編集のキーの手直しの最後の関門で、依頼者が修正案 (amendments.md) に答えた挙動 (2026-10-07) のうち、まとめて進める口 (render の橋渡しの
// toggleTasks) のものを、直す前に落ちるテストとして書く。期待は答えから書く。
// - K-006 (b): まとめて進めるとき、確かめの順で 1 つ目が断られたら、そこで確かめをやめる。断られたあとのタスクの beforeTaskToggle
//   (アプリのフック) は呼ばず、知らせ (onDiagnostic の hook-rejected) は最初に断られた 1 件の理由だけ。原文は書き換えない
// 確かめの順 (K-003: relations の上流が先、関係のないもの同士は文書の順) をどこで決めるかは約束にしないので、ここで渡すタスクは、
// relations のないものか、文書の順と上流と下流の順が同じものだけにする (順の違う文書は e2e の editor-keys-gate が公開の口で見る)
import { describe, expect, it } from 'vitest';
import { createRenderBridge } from '../src/bridge';
import type { HookModule } from '../src/model/hooks';
import { buildModel } from '../src/model/model';
import { parseDocument, type OutlineNode } from '../src/parse/document';

interface BridgeRun {
    toggled: boolean;
    rewrites: number;
    // アプリの beforeTaskToggle が呼ばれたタスク (呼ばれた順)
    asked: string[];
    // onTaskToggle で知らされたタスク
    announced: string[];
    // onDiagnostic に届いた診断 (code と message)
    diagnostics: Array<{ code: string; message: string }>;
}

// 描いた文書で橋渡しを作り、名前の順 (文書の順) に並べたノードをまとめて進める。reject の名前のタスクは、アプリの beforeTaskToggle が
// 「<名前> を断る」の理由で断る
function toggleTogether(source: string, names: string[], reject: string[] = []): BridgeRun {
    const asked: string[] = [];
    const announced: string[] = [];
    const diagnostics: BridgeRun['diagnostics'] = [];
    const app: HookModule = {
        beforeTaskToggle: (context) => {
            asked.push(context.node.text);
            if (!reject.includes(context.node.text)) return undefined;
            context.reject(`${context.node.text} を断る`);
            return false;
        },
        onTaskToggle: (context) => void announced.push(context.node.text),
    };
    const bridge = createRenderBridge({ source: () => source, hooks: app, onDiagnostic: (diagnostic) => diagnostics.push({ code: diagnostic.code, message: diagnostic.message }) });
    const parsed = parseDocument(source);
    const model = buildModel(parsed.nodes, parsed.frontmatter, source);
    bridge.setDocument(parsed, model);
    const wanted = new Set(names);
    const nodes: OutlineNode[] = parsed.nodes.filter((node) => wanted.has(node.refText));
    expect(nodes.map((node) => node.refText)).toEqual(names);
    let rewrites = 0;
    const toggled = bridge.toggleTasks(nodes, model.taskCycle, () => {
        rewrites += 1;
    });
    return { toggled, rewrites, asked, announced, diagnostics };
}

// relations のないタスク 3 つ (marks は 点検、報告、片付け の印)。1 確認 / 2 点検 / 3 報告 / 4 片付け
const tasks = (marks: [string, string, string] = [' ', ' ', ' ']): string => `# 確認\n\n- [${marks[0]}] 点検\n- [${marks[1]}] 報告\n- [${marks[2]}] 片付け\n`;

// markdag.rules で上流が終わるまで進められないタスク (設計 --> 実装 --> 検証。文書の順と上流と下流の順が同じ)
const RULES = [
    '---',
    'markdag:',
    '    rules:',
    '        taskToggle:',
    '            requireUpstreamDone: true',
    '    relations:',
    '        chain:',
    '            - 設計 --> 実装 --> 検証',
    '---',
    '',
    '# リリース',
    '',
    '- [ ] 設計',
    '- [ ] 実装',
    '- [ ] 検証',
    '',
].join('\n');

describe('K-006: まとめて進めるとき、1 つ目が断られたらそこで確かめをやめ、その理由だけを知らせる', () => {
    it('アプリのフックが 2 つ目 (報告) を断ると、3 つ目 (片付け) の beforeTaskToggle は呼ばない。知らせは報告の理由の 1 件', () => {
        const run = toggleTogether(tasks(), ['点検', '報告', '片付け'], ['報告', '片付け']);
        expect(run.toggled).toBe(false);
        expect(run.rewrites).toBe(0);
        expect(run.announced).toEqual([]);
        expect(run.asked).toEqual(['点検', '報告']);
        expect(run.diagnostics.map((item) => item.code)).toEqual(['hook-rejected']);
        expect(run.diagnostics[0]?.message).toContain('報告 を断る');
    });

    it('アプリのフックが 1 つ目 (点検) を断ると、ほかのタスクの beforeTaskToggle は呼ばない', () => {
        const run = toggleTogether(tasks(), ['点検', '報告', '片付け'], ['点検']);
        expect(run).toMatchObject({ toggled: false, rewrites: 0, announced: [], asked: ['点検'] });
        expect(run.diagnostics.map((item) => item.code)).toEqual(['hook-rejected']);
        expect(run.diagnostics[0]?.message).toContain('点検 を断る');
    });

    it('クリックで進む順にない状態 ([-] 中止) で断られたときも、そこでやめる。知らせは最初の 1 件 (報告) だけ', () => {
        const run = toggleTogether(tasks([' ', '-', '-']), ['点検', '報告', '片付け']);
        expect(run).toMatchObject({ toggled: false, rewrites: 0, announced: [], asked: ['点検'] });
        expect(run.diagnostics.map((item) => item.code)).toEqual(['hook-rejected']);
        expect(run.diagnostics[0]?.message).toContain('「報告」');
    });

    it('markdag.rules が 1 つ目 (実装) を断ると、検証は確かめない。知らせは実装の理由 (先に終えるもの: 設計) の 1 件', () => {
        const run = toggleTogether(RULES, ['実装', '検証']);
        expect(run).toMatchObject({ toggled: false, rewrites: 0, announced: [], asked: [] });
        expect(run.diagnostics.map((item) => item.code)).toEqual(['hook-rejected']);
        expect(run.diagnostics[0]?.message).toContain('先に終えるもの: 設計');
        expect(run.diagnostics[0]?.message).not.toContain('実装、');
    });

    it('今のまま: 全部通れば書き換えは 1 回で、アプリの beforeTaskToggle はタスクごとに 1 回、知らせはない', () => {
        const run = toggleTogether(tasks(), ['点検', '報告', '片付け']);
        expect(run).toEqual({ toggled: true, rewrites: 1, asked: ['点検', '報告', '片付け'], announced: ['点検', '報告', '片付け'], diagnostics: [] });
    });
});

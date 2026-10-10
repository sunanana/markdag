// GUI 編集の受け入れの例 (置き場の <面>/<名前>/ の input.md、expect.yaml、期待の原文や差し替える原文の .md) を読み、期待と実際を照らす部品。
// vitest と playwright (Node の側) と確認ページ (ブラウザ) が同じ定義を使う。例のファイルは読むだけで書き換えない。期待はテストのコードに写さず、expect.yaml から読む。
// 面は 3 つ: data は markdag/core の editSource を原文に当てた結果、frontmatter は markdag.editor の診断と読んだ設定 (と mount した図のモードとセグメント)、
// screen は GUI 編集で開いた図に steps を順に通した、段ごとの見えるもの。
// 照らし方: オブジェクトは期待に書いた欄だけ、配列は数と並び、{ contains: … } は文字列に含むか、.md で終わる文字列は例のディレクトリのその原文の全文。
// 照らした結果は欄ごとの行 (段、欄、期待、実際、食い違い) で返し、どの道具でも食い違いの一覧で落とせるようにする。
// screen の段の通し方 (操作の順、修飾キー、段のあとの待ち) もここに置き、押す点を探すことと見えるものを読むことはページの側の部品に任せる。
// 運び手に特別な力が要る例 (requires。変換を起こす ime など) は、その力のない運び手では通さずに飛ばした理由を返す
import { parse as parseYaml } from 'yaml';
import type { EditOp, EditOutcome, GraphModel, NodeTarget, OutlineNode } from '../../src/core';
import type { EditorModeOption } from '../../src/editor';
import { describeTarget, nodeOf, type Point, type Target, type TransformLike } from './gui-editor-page';

export const GUI_SURFACES = ['data', 'frontmatter', 'screen'] as const;
export type GuiSurface = (typeof GUI_SURFACES)[number];

// ---- 期待の形 ----

export interface GuiSpec {
    // 正常、境界、誤り
    kind?: string;
    // 未決の印 (状態の組み合わせで決まっていない所の番号と、例を書き起こすときに気づいた未決の番号)。期待は今の振る舞い
    undecided?: string[];
    // 承認の関門で決まった未決の印 (番号は undecided と同じ)。期待は決まった振る舞い
    decided?: string[];
    checks?: string;
    // 人への注 (ページの自動の再現で通らない段の理由など)
    note?: string;
    // screen: 例を通すのに運び手に要る力 (GUI_REQUIREMENTS)。力のない運び手 (ほかのブラウザ、確認ページの合成の出来事) では飛ばす
    requires?: string[];
    // screen: 例の OS の区分 (GUI_OS。書かなければ mac)。Enter の修飾キーの割り当てが mac と win で違うため。
    // 運び手はページを開く前に navigator をその OS に見せかける。見せかけられない運び手 (確認ページ) は、書いた区分とページの区分が違えば飛ばす
    os?: string;
    behaviors?: string[];
    states?: string[];
    decisions?: string[];
    // screen: mount のオプションの mode (書かなければ document)
    mount?: { mode?: EditorModeOption };
    // data: editSource の操作。ノードは id と refText の代わりに名前で書く
    op?: Record<string, unknown>;
    // screen: 操作の列
    steps?: GuiStep[];
    // data と frontmatter の期待 (DataExpect、FrontmatterExpect)
    expect?: Record<string, unknown>;
    look?: string[];
}

// screen の段。操作 (GUI_ACTIONS のどれか 1 つ) と、段のあとの期待 (ScreenObserved の欄)
export type GuiStep = Record<string, unknown> & { expect?: Record<string, unknown>; note?: string };

// data の期待 (editSource の結果を、ノードは名前にしたもの)
export interface DataExpect {
    status: 'edited' | 'unchanged' | 'refused';
    // 書き換えたあとの原文のファイル名 (全文が同じか)
    source?: string;
    select?: { kind: 'none' } | { kind: 'nodes'; nodes: string[] } | { kind: 'edge'; edge: { kind: string; source: string; target: string } } | { kind: 'group'; id: string };
    // すぐ名前の入力を開く相手
    rename?: { kind: 'node'; node: string } | { kind: 'group'; id: string } | null;
    notes?: Array<{ code: string; count: number }>;
    // 断るか変えない理由の code
    reason?: string | null;
}

// frontmatter の期待
export interface FrontmatterExpect {
    // input.md の診断を出る順に全部
    diagnostics?: Array<{ severity: string; code: string; line?: number | null }>;
    // 読んだ markdag.editor (model.editor)
    editor?: { mode?: string; default?: string; segment?: { display?: boolean; position?: string } };
    // mount した図のモード、セグメントの隅 (data-corner と、箱が実際に寄っている隅)、道具箱があるか (DOM が要る)
    screen?: { mode?: string; segment?: string | null; segment_place?: string | null; toolbox?: boolean };
}

export const SPEC_KEYS = ['kind', 'checks', 'note', 'requires', 'os', 'behaviors', 'states', 'decisions', 'undecided', 'decided', 'look', 'mount', 'op', 'steps', 'expect'] as const;
export const DATA_EXPECT_KEYS = ['status', 'source', 'select', 'rename', 'notes', 'reason'] as const;
export const FRONTMATTER_EXPECT_KEYS = ['diagnostics', 'editor', 'screen'] as const;
export const GUI_ACTIONS = [
    'click',
    'dblclick',
    'hover',
    'down',
    'move',
    'up',
    'drag',
    'marquee',
    'pan',
    'wheel',
    'key',
    'keydown',
    'keyup',
    'type',
    'compose',
    'compose_key',
    'set_source',
    'set_mode',
    'set_folded',
    'api',
    'wait',
    'blur_window',
    'focus',
] as const;
export const GUI_APIS = ['undo', 'redo', 'fit', 'destroy'] as const;
// 運び手に要る力。ime は変換 (日本語の入力の変換中の文字と、変換中のキー) を起こせること。chromium の CDP の運び手だけが持つ
export const GUI_REQUIREMENTS = ['ime'] as const;
export type GuiRequirement = (typeof GUI_REQUIREMENTS)[number];
// 例の OS の区分。mac は macOS と iOS (navigator.platform が Mac、iPhone、iPad)、win はそれ以外。GUI 編集の見分けと同じ
export const GUI_OS = ['mac', 'win'] as const;
export type GuiOs = (typeof GUI_OS)[number];
// 運び手が見せかける navigator.platform の値
export const GUI_OS_PLATFORM: Record<GuiOs, string> = { mac: 'MacIntel', win: 'Win32' };
// 例の OS の区分 (書いていなければ mac)
export const osOf = (example: GuiExample): GuiOs => (example.spec.os === 'win' ? 'win' : 'mac');
// 力が要る操作
const ACTION_REQUIREMENTS: Partial<Record<(typeof GUI_ACTIONS)[number], GuiRequirement>> = { compose: 'ime', compose_key: 'ime' };
const STEP_KEYS = [...GUI_ACTIONS, 'mod', 'button', 'expect', 'note'] as const;
// screen の段のあとに読む欄 (ページの側の部品が読むものと、set_mode と api の戻り値の returned)
export const SCREEN_OBSERVED_KEYS = [
    'returned',
    'layer',
    'editor_mode',
    'mode',
    'tool',
    'drag_to_pan',
    'segment',
    'segment_place',
    'segment_pressed',
    'toolbox',
    'toolbox_labels',
    'tool_pressed',
    'tool_disabled',
    'selection',
    'selected',
    'selected_outline',
    'faded',
    'faded_nodes',
    'edge_selected',
    'bar',
    'bar_title',
    'bar_buttons',
    'bar_labels',
    'bar_titles',
    'bar_widths',
    'bar_moved',
    'bar_resized',
    'bar_centered',
    'task_check',
    'handles',
    'bounds',
    'input',
    'input_value',
    'focus',
    'notice',
    'hint',
    'source',
    'nodes',
    'frames',
    'edges',
    'drop_target',
    'marquee',
    'link_preview',
    'details_display',
    'popover',
    'legend',
    'legend_place',
    'legend_open',
    'legend_sections',
    'legend_rows',
    'legend_counts',
    'legend_names',
    'legend_selected',
    'legend_actions',
    'legend_actions_shown',
    'legend_toggle',
    'legend_new',
    'tag_rows',
    'tag_fields',
    'folded',
    'key_prevented',
    'moved',
    'zoomed',
] as const;

// ---- 例を読む ----

export interface GuiExample {
    // <面>/<名前>
    id: string;
    surface: GuiSurface;
    name: string;
    dir: string;
    spec: GuiSpec;
    expectText: string;
    // 例のディレクトリの .md (名前 → 中身)。input.md と、期待の原文 (expected.md など) と、差し替える原文
    files: Map<string, string>;
    // expect.yaml を読めなかった理由 (読めたら null)
    parseError: string | null;
}

// 置き場からの相対のパス (<面>/<名前>/<ファイル>) → 中身、から例を組む。読む元 (Node のファイル、ページの開発サーバー) によらない。
// 読めない expect.yaml は、その例だけを「通せない」にする (ほかの例は読める)
export function guiExamplesFrom(files: Record<string, string>, root: string): GuiExample[] {
    return Object.entries(files)
        .flatMap(([path, text]) => {
            const match = /^([^/]+)\/([^/]+)\/expect\.yaml$/.exec(path);
            const surface = match?.[1] as GuiSurface | undefined;
            const name = match?.[2];
            if (!surface || !name || !GUI_SURFACES.includes(surface)) return [];
            const prefix = `${surface}/${name}/`;
            const markdown = new Map<string, string>();
            for (const [file, content] of Object.entries(files)) {
                const rest = file.startsWith(prefix) ? file.slice(prefix.length) : null;
                if (rest !== null && !rest.includes('/') && rest.endsWith('.md')) markdown.set(rest, content);
            }
            let spec: GuiSpec;
            let parseError: string | null = null;
            try {
                spec = (parseYaml(text) ?? {}) as GuiSpec;
            } catch (error) {
                spec = {};
                parseError = `expect.yaml を読めません: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
            }
            return [{ id: `${surface}/${name}`, surface, name, dir: `${root}/${surface}/${name}`, spec, expectText: text, files: markdown, parseError }];
        })
        .sort((a, b) => GUI_SURFACES.indexOf(a.surface) - GUI_SURFACES.indexOf(b.surface) || a.name.localeCompare(b.name));
}

// Node (vitest と playwright) で置き場のファイルを読む。ページでは呼ばない (確認ページは開発サーバーが渡す中身を guiExamplesFrom に渡す)。
// MARKDAG_GUI_EDITOR_ACCEPTANCE で別の置き場 (例を写して期待を変えた一時の置き場など) を指せる。試験が見ていない欄がないかを確かめるため
export function listGuiExamples(surface?: GuiSurface): GuiExample[] {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const url = process.getBuiltinModule('node:url');
    const root = process.env.MARKDAG_GUI_EDITOR_ACCEPTANCE ?? path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../testdata/acceptance/gui-editor');
    const files: Record<string, string> = {};
    for (const name of GUI_SURFACES) {
        const base = path.join(root, name);
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(base, entry.name);
            for (const file of fs.readdirSync(dir)) {
                if (file === 'expect.yaml' || file.endsWith('.md')) files[`${name}/${entry.name}/${file}`] = fs.readFileSync(path.join(dir, file), 'utf8');
            }
        }
    }
    const examples = guiExamplesFrom(files, root);
    return surface === undefined ? examples : examples.filter((example) => example.surface === surface);
}

export function inputOf(example: GuiExample): string {
    if (example.parseError) throw new Error(example.parseError);
    const input = example.files.get('input.md');
    if (input === undefined) throw new Error('input.md がありません');
    return input;
}

// 知らない欄が例にあれば挙げる (新しい欄を黙って見逃さないため)
export function unknownKeys(values: object | undefined | null, known: readonly string[], label: string): string[] {
    const extra = Object.keys(values ?? {}).filter((key) => !known.includes(key));
    return extra.length === 0 ? [] : [`${label}: テストが読まない欄がある: ${extra.join(', ')}`];
}

// 例を通すのに運び手に要る力 (requires に書いたもの)
export const requirementsOf = (example: GuiExample): string[] => (Array.isArray(example.spec.requires) ? example.spec.requires.map(String) : []);

// 運び手が持たない力 (要る力のうち)
export const missingRequirements = (example: GuiExample, driver: Pick<Driver, 'ime'>): string[] => requirementsOf(example).filter((item) => item === 'ime' && !driver.ime);

// 例の欄のうち、試験の道具が読まない欄
export function specProblems(example: GuiExample): string[] {
    if (example.parseError) return [`${example.id}: ${example.parseError}`];
    const { spec } = example;
    const problems = unknownKeys(spec, SPEC_KEYS, example.id);
    const requires = requirementsOf(example);
    const unknownRequires = requires.filter((item) => !(GUI_REQUIREMENTS as readonly string[]).includes(item));
    if (unknownRequires.length > 0) problems.push(`${example.id}.requires: テストが知らない力: ${unknownRequires.join(', ')}`);
    if (spec.os !== undefined && !(GUI_OS as readonly string[]).includes(String(spec.os))) problems.push(`${example.id}.os: テストが知らない OS の区分: ${String(spec.os)}`);
    if (example.surface === 'data') problems.push(...unknownKeys(spec.expect, DATA_EXPECT_KEYS, `${example.id}.expect`));
    if (example.surface === 'frontmatter') problems.push(...unknownKeys(spec.expect, FRONTMATTER_EXPECT_KEYS, `${example.id}.expect`));
    if (example.surface === 'screen') {
        for (const [index, step] of (spec.steps ?? []).entries()) {
            const label = `${example.id} の段 ${index + 1}`;
            problems.push(...unknownKeys(step, STEP_KEYS, label), ...unknownKeys(step.expect, SCREEN_OBSERVED_KEYS, `${label}.expect`));
            if (GUI_ACTIONS.filter((action) => action in step).length > 1) problems.push(`${label}: 操作が 2 つ以上ある`);
            const needed = GUI_ACTIONS.flatMap((action) => {
                const item = ACTION_REQUIREMENTS[action];
                return action in step && item ? [item] : [];
            });
            for (const item of needed) if (!requires.includes(item)) problems.push(`${label}: 操作に要る力 ${item} が requires にない`);
        }
    }
    return problems;
}

// ---- 照らし合わせ ----

export interface GuiRow {
    // 段の番号と操作 (data と frontmatter は空)
    step: string;
    field: string;
    expected: unknown;
    actual: unknown;
    problems: string[];
}

const shortOf = (value: unknown): string => {
    const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

// 期待に書いた欄だけを照らす。オブジェクトは書いた欄だけ、配列は長さと並び、{ contains } は文字列に含むか
export function compare(expected: unknown, actual: unknown, path: string, problems: string[], files: Map<string, string>): void {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
        const entries = Object.entries(expected as Record<string, unknown>);
        if (entries.length === 1 && entries[0]?.[0] === 'contains') {
            const wanted = entries[0][1];
            const parts = Array.isArray(wanted) ? wanted : [wanted];
            if (typeof actual !== 'string') problems.push(`${path}: 文字列ではありません (${JSON.stringify(actual)})`);
            else for (const part of parts) if (!actual.includes(String(part))) problems.push(`${path}: 「${String(part)}」を含みません`);
            return;
        }
        if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
            problems.push(`${path}: 期待はオブジェクト、実際は ${JSON.stringify(actual)}`);
            return;
        }
        for (const [key, value] of entries) compare(value, (actual as Record<string, unknown>)[key], `${path}.${key}`, problems, files);
        return;
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) {
            problems.push(`${path}: 期待は配列、実際は ${JSON.stringify(actual)}`);
            return;
        }
        if (expected.length !== actual.length) problems.push(`${path}: 数が違います (期待 ${expected.length}、実際 ${actual.length})`);
        expected.forEach((item, index) => compare(item, actual[index], `${path}[${index}]`, problems, files));
        return;
    }
    const wanted = typeof expected === 'string' && /\.md$/.test(expected) && files.has(expected) ? files.get(expected) : expected;
    const got = actual === undefined ? null : actual;
    if (wanted !== got) problems.push(`${path}: 期待 ${shortOf(expected)}、実際 ${shortOf(got)}`);
}

// 期待の欄ごとに 1 行
export function rowsOf(step: string, expected: Record<string, unknown>, actual: Record<string, unknown>, files: Map<string, string>): GuiRow[] {
    return Object.entries(expected).map(([field, value]) => {
        const problems: string[] = [];
        compare(value, actual[field], field, problems, files);
        return { step, field, expected: value, actual: actual[field] ?? null, problems };
    });
}

// 食い違いの一覧 (段があれば段の番号と操作を前に付ける。欄の名前は食い違いの文の先頭)
export function failuresOf(rows: readonly GuiRow[]): string[] {
    if (rows.length === 0) return ['照らす欄がない'];
    return rows.flatMap((row) => row.problems.map((problem) => (row.step ? `${row.step}: ${problem}` : problem)));
}

// ---- data ----

const NODE_FIELDS = ['parent', 'node', 'from', 'to', 'target'] as const;
const NODES_FIELDS = ['nodes', 'sources'] as const;

const targetOf = (node: OutlineNode): NodeTarget => ({ id: node.id, refText: node.refText });

// 例の op (ノードは名前) を、input.md の解析のノードで editSource の操作にする
export function editOpOf(spec: Record<string, unknown>, nodes: readonly OutlineNode[]): EditOp {
    const op: Record<string, unknown> = { ...spec };
    for (const field of NODE_FIELDS) if (field in op) op[field] = targetOf(nodeOf(nodes, op[field]));
    for (const field of NODES_FIELDS) if (Array.isArray(op[field])) op[field] = (op[field] as unknown[]).map((ref) => targetOf(nodeOf(nodes, ref)));
    // 省いた欄は既定 (タグの値なし、置き換えるキーなし)
    if (op.kind === 'setTag') {
        op.value ??= null;
        op.replaceKey ??= null;
    }
    if (op.kind === 'toggleTag') op.value ??= null;
    return op as EditOp;
}

// editSource の結果を、期待と同じ形 (ノードは名前) にする。名前は書き換えたあとの原文を parse で解析して引く
export function outcomeOf(outcome: EditOutcome, parse: (source: string) => { nodes: readonly OutlineNode[] }): Record<string, unknown> {
    if (outcome.status !== 'edited') return { status: outcome.status, reason: outcome.reason?.code ?? null };
    const nodes = parse(outcome.source).nodes;
    const name = (id: number): string => nodes.find((node) => node.id === id)?.refText ?? `#${id}`;
    const { select, rename } = outcome;
    const selected =
        select.kind === 'nodes'
            ? { kind: 'nodes', nodes: select.nodes.map((node) => node.refText) }
            : select.kind === 'edge'
              ? { kind: 'edge', edge: { kind: select.edge.kind, source: name(select.edge.source), target: name(select.edge.target) } }
              : select.kind === 'group'
                ? { kind: 'group', id: select.id }
                : { kind: 'none' };
    return {
        status: 'edited',
        source: outcome.source,
        select: selected,
        rename: rename === null ? null : rename.kind === 'node' ? { kind: 'node', node: rename.node.refText } : { kind: 'group', id: rename.id },
        notes: outcome.notes.map((note) => ({ code: note.code, count: note.count })),
    };
}

// ---- frontmatter ----

// 診断 (severity、code、行) と読んだ markdag.editor
export function frontmatterOutcomeOf(model: Pick<GraphModel, 'diagnostics' | 'editor'>): Record<string, unknown> {
    return {
        diagnostics: model.diagnostics.map((item) => ({ severity: item.severity, code: item.code, line: item.at === null ? null : item.at.line })),
        editor: model.editor,
    };
}

// mount のオプションの mode (書いていなければ document)
export const mountModeOf = (example: GuiExample): EditorModeOption => example.spec.mount?.mode ?? 'document';

// ---- screen: 操作の運び手 ----

export type MouseButtonName = 'left' | 'middle' | 'right';

export interface Driver {
    readonly name: string;
    // 変換 (compose と composeKey) を起こせるか
    readonly ime: boolean;
    move(x: number, y: number, steps?: number): Promise<void>;
    down(button?: MouseButtonName): Promise<void>;
    up(button?: MouseButtonName): Promise<void>;
    click(x: number, y: number, count?: number, button?: MouseButtonName): Promise<void>;
    keyDown(key: string): Promise<void>;
    keyUp(key: string): Promise<void>;
    press(combo: string): Promise<void>;
    type(text: string): Promise<void>;
    // 変換中の文字を入れる (commit なら変換を確定して入れる)
    compose(text: string, commit: boolean): Promise<void>;
    // 変換中のキー (日本語の入力が送る形。keyCode 229)
    composeKey(key: string): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
    // 押したままのキーとボタンを離す (例の終わりに。次の例へ持ち越さない)
    releaseAll(): Promise<void>;
    // 最後に動かしたポインタの位置 (画面の座標)
    position(): { x: number; y: number };
}

// 運び手の命令。playwright の側で page.mouse と page.keyboard の呼び出しにする (キーの名前と組み合わせは playwright の書き方)
export type DriveCommand =
    | { op: 'move'; x: number; y: number; steps: number }
    | { op: 'down' | 'up'; button: MouseButtonName }
    | { op: 'click'; x: number; y: number; count: number; button: MouseButtonName }
    | { op: 'keyDown' | 'keyUp' | 'press'; key: string }
    | { op: 'type'; text: string }
    | { op: 'compose'; text: string; commit: boolean }
    | { op: 'composeKey'; key: string }
    | { op: 'wheel'; dx: number; dy: number };

// 操作を命令にして drive に渡す運び手。押したままのキーとボタンと、ポインタの位置を控える
export class CommandDriver implements Driver {
    private readonly keys = new Set<string>();
    private readonly buttons = new Set<MouseButtonName>();
    private at = { x: 0, y: 0 };
    constructor(
        readonly name: string,
        private readonly drive: (command: DriveCommand) => Promise<void>,
        // drive が compose と composeKey を受けられるか
        readonly ime = false,
    ) {}
    position = (): { x: number; y: number } => ({ ...this.at });
    move = (x: number, y: number, steps = 1): Promise<void> => {
        this.at = { x, y };
        return this.drive({ op: 'move', x, y, steps });
    };
    down = (button: MouseButtonName = 'left'): Promise<void> => {
        this.buttons.add(button);
        return this.drive({ op: 'down', button });
    };
    up = (button: MouseButtonName = 'left'): Promise<void> => {
        this.buttons.delete(button);
        return this.drive({ op: 'up', button });
    };
    click = (x: number, y: number, count = 1, button: MouseButtonName = 'left'): Promise<void> => {
        this.at = { x, y };
        return this.drive({ op: 'click', x, y, count, button });
    };
    keyDown = (key: string): Promise<void> => {
        this.keys.add(key);
        return this.drive({ op: 'keyDown', key });
    };
    keyUp = (key: string): Promise<void> => {
        this.keys.delete(key);
        return this.drive({ op: 'keyUp', key });
    };
    press = (combo: string): Promise<void> => this.drive({ op: 'press', key: combo });
    type = (text: string): Promise<void> => this.drive({ op: 'type', text });
    compose = (text: string, commit: boolean): Promise<void> => this.drive({ op: 'compose', text, commit });
    composeKey = (key: string): Promise<void> => this.drive({ op: 'composeKey', key });
    wheel = (dx: number, dy: number): Promise<void> => this.drive({ op: 'wheel', dx, dy });
    async releaseAll(): Promise<void> {
        for (const button of [...this.buttons]) await this.up(button);
        for (const key of [...this.keys]) await this.keyUp(key);
    }
}

// ---- screen: 段を通す ----

// 図を開いたページの側にしかできないこと。確認ページはその場で呼び、e2e はページの中の部品を page.evaluate で呼ぶ
export interface ScreenSession {
    readonly driver: Driver;
    // 修飾キーの ControlOrMeta を Meta にするか (ページの navigator.platform が Mac)
    readonly mac: boolean;
    pointOf(target: Target): Promise<Point>;
    // 押さずにフォーカスを置く (例の focus の段。Tab でボタンへ移るかはブラウザの設定によるので、その準備に使う)
    focusOn(target: Target): Promise<void>;
    // 段の始まりを知らせる (key_prevented の欄が見るキーを、その段で押したものだけにする)
    beginStep(): Promise<void>;
    marqueeOf(refs: unknown[]): Promise<{ start: Point; end: Point }>;
    blankSpot(): Promise<Point | null>;
    // 原文を外から差し替え、図に届くのを待つ
    setSource(text: string): Promise<void>;
    setMode(mode: 'view' | 'edit'): Promise<boolean>;
    // 閉じた枝をアプリのメソッド (図の setFolded) で名前の並びのとおりに置き換える (開閉の丸を押さずに閉じる。入力を開いたままでも閉じる)
    setFolded(refs: unknown[]): Promise<void>;
    callApi(name: (typeof GUI_APIS)[number]): Promise<unknown>;
    blurWindow(): Promise<void>;
    // ページの描画の 2 コマと ms を待つ
    settle(ms?: number): Promise<void>;
    sleep(ms: number): Promise<void>;
    transform(): Promise<TransformLike | null>;
    observe(before: TransformLike | null, extra: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ScreenRun {
    // 通した段
    trace: string[];
    rows: GuiRow[];
    // 通せなかった理由と、そのときの段 (通せたら null)
    error: string | null;
    failedStep: string | null;
    // 運び手に要る力がなくて通さなかった理由 (通したら null)
    skipped: string | null;
}

const modsOf = (step: GuiStep): string[] => (Array.isArray(step.mod) ? (step.mod as string[]) : typeof step.mod === 'string' ? [step.mod] : []);
const buttonOf = (step: GuiStep): MouseButtonName => (step.button === 'middle' || step.button === 'right' ? step.button : 'left');
const actionOf = (step: GuiStep): string | null => GUI_ACTIONS.find((action) => action in step) ?? null;

export function stepLabel(index: number, step: GuiStep): string {
    const action = actionOf(step);
    if (action === null) return `段 ${index + 1} (測るだけ)`;
    const value = step[action];
    const mods = modsOf(step);
    const body = typeof value === 'object' && value !== null ? describeTarget(value) : String(value);
    return `段 ${index + 1} ${action} ${body}${mods.length > 0 ? ` (${mods.join('+')})` : ''}${step.button ? ` (${String(step.button)})` : ''}`;
}

async function withMods(session: ScreenSession, mods: string[], body: () => Promise<void>): Promise<void> {
    const { driver } = session;
    const keyOf = (mod: string): string => (mod === 'ControlOrMeta' ? (session.mac ? 'Meta' : 'Control') : mod);
    for (const mod of mods) await driver.keyDown(keyOf(mod));
    try {
        await body();
    } finally {
        for (const mod of [...mods].reverse()) await driver.keyUp(keyOf(mod));
    }
}

async function blankOrThrow(session: ScreenSession): Promise<Point> {
    const start = await session.blankSpot();
    if (!start) throw new Error('何もないところが見つかりません');
    return start;
}

// 段を 1 つ通す。戻り値は段のあとに読む値に足すもの (set_mode と api の戻り値)
async function runStep(session: ScreenSession, example: GuiExample, step: GuiStep): Promise<Record<string, unknown>> {
    const { driver } = session;
    const action = actionOf(step);
    const mods = modsOf(step);
    const button = buttonOf(step);
    if (action === 'click' || action === 'dblclick') {
        const point = await session.pointOf(step[action] as Target);
        await withMods(session, mods, () => driver.click(point.x, point.y, action === 'dblclick' ? 2 : 1, button));
    } else if (action === 'move' && Array.isArray((step.move as { by?: unknown }).by)) {
        // { by: [dx, dy] } は今のポインタの位置から動かす (押したままのドラッグを続ける)
        const [dx, dy] = (step.move as { by: [number, number] }).by;
        await driver.move(driver.position().x + dx, driver.position().y + dy, 6);
    } else if (action === 'hover' || action === 'move') {
        const point = await session.pointOf(step[action] as Target);
        await driver.move(point.x, point.y, 6);
        // 吹き出しは乗せてから 250ms 待って出るので、乗せたあとは長めに待つ
        if (action === 'hover') await session.sleep(350);
    } else if (action === 'down') {
        const point = await session.pointOf(step.down as Target);
        await driver.move(point.x, point.y);
        await withMods(session, mods, () => driver.down(button));
    } else if (action === 'up') {
        if (step.up !== true) {
            const point = await session.pointOf(step.up as Target);
            await driver.move(point.x, point.y, 6);
        }
        await driver.up(button);
    } else if (action === 'drag') {
        const spec = step.drag as { from: Target; to: Target; release?: boolean };
        const from = await session.pointOf(spec.from);
        await driver.move(from.x, from.y);
        await withMods(session, mods, async () => {
            await driver.down(button);
            const to = await session.pointOf(spec.to);
            await driver.move(to.x, to.y, 10);
            if (spec.release !== false) await driver.up(button);
        });
    } else if (action === 'marquee') {
        // [名前, …] か { nodes: [名前, …], release: false } (離さずに止める。あとの up: true で離す)
        const spec = Array.isArray(step.marquee) ? { nodes: step.marquee as unknown[], release: true } : (step.marquee as { nodes: unknown[]; release?: boolean });
        const { start, end } = await session.marqueeOf(spec.nodes);
        await driver.move(start.x, start.y);
        await withMods(session, mods, async () => {
            await driver.down('left');
            await driver.move(end.x, end.y, 10);
            if (spec.release !== false) await driver.up('left');
        });
    } else if (action === 'pan') {
        const spec = (step.pan ?? {}) as { dx?: number; dy?: number; release?: boolean };
        const start = await blankOrThrow(session);
        await driver.move(start.x, start.y);
        await driver.down(button);
        await driver.move(start.x + (spec.dx ?? 60), start.y + (spec.dy ?? 40), 8);
        if (spec.release !== false) await driver.up(button);
    } else if (action === 'wheel') {
        const spec = (step.wheel ?? {}) as { dy?: number };
        const start = await blankOrThrow(session);
        await driver.move(start.x, start.y);
        await driver.wheel(0, spec.dy ?? -240);
    } else if (action === 'key') {
        await driver.press(String(step.key));
    } else if (action === 'keydown') {
        await driver.keyDown(String(step.keydown));
    } else if (action === 'keyup') {
        await driver.keyUp(String(step.keyup));
    } else if (action === 'type') {
        await driver.type(String(step.type));
    } else if (action === 'compose') {
        // 文字列は変換中の文字、{ commit: 文字 } は変換を確定してその文字を入れる
        const spec = step.compose;
        if (spec !== null && typeof spec === 'object') await driver.compose(String((spec as { commit?: unknown }).commit ?? ''), true);
        else await driver.compose(String(spec), false);
    } else if (action === 'compose_key') {
        await driver.composeKey(String(step.compose_key));
    } else if (action === 'set_source') {
        const file = String(step.set_source);
        const text = example.files.get(file);
        if (text === undefined) throw new Error(`${file} がありません`);
        await session.setSource(text);
    } else if (action === 'set_mode') {
        const returned = await session.setMode(step.set_mode === 'edit' ? 'edit' : 'view');
        await session.settle();
        return { returned };
    } else if (action === 'set_folded') {
        if (!Array.isArray(step.set_folded)) throw new Error('set_folded は閉じるノードの名前の並びで書きます');
        await session.setFolded(step.set_folded);
    } else if (action === 'api') {
        const name = String(step.api);
        const known = GUI_APIS.find((item) => item === name);
        if (!known) throw new Error(`api ${name} は使えません (undo、redo、fit、destroy)`);
        const returned = await session.callApi(known);
        await session.settle();
        return { returned };
    } else if (action === 'wait') {
        await session.sleep(Number(step.wait));
    } else if (action === 'blur_window') {
        await session.blurWindow();
    } else if (action === 'focus') {
        await session.focusOn(step.focus as Target);
    }
    await session.settle();
    return {};
}

// 開いた図に例の steps を順に通し、期待のある段ごとに見えるものを照らす
export async function runScreenSteps(example: GuiExample, session: ScreenSession): Promise<ScreenRun> {
    const trace: string[] = [];
    const rows: GuiRow[] = [];
    const steps = example.spec.steps ?? [];
    let current: string | null = null;
    const missing = missingRequirements(example, session.driver);
    if (missing.length > 0) {
        return { trace, rows, error: null, failedStep: null, skipped: `運び手 (${session.driver.name}) に要る力がない: ${missing.join(', ')} (変換は chromium の CDP で起こす)` };
    }
    // OS の区分を書いた例は、ページの区分と同じときだけ通す (navigator を見せかけられない確認ページで、別の OS の割り当てを押さないため)
    if (example.spec.os !== undefined && (osOf(example) === 'mac') !== session.mac) {
        return { trace, rows, error: null, failedStep: null, skipped: `例の OS の区分 (${osOf(example)}) とページの区分 (${session.mac ? 'mac' : 'win'}) が違う (e2e は navigator を見せかけて通す)` };
    }
    try {
        if (example.parseError) throw new Error(example.parseError);
        await session.settle(200);
        for (const [index, step] of steps.entries()) {
            const label = stepLabel(index, step);
            current = label;
            await session.beginStep();
            const before = await session.transform();
            const extra = await runStep(session, example, step);
            trace.push(label);
            if (step.expect) rows.push(...rowsOf(label, step.expect, await session.observe(before, extra), example.files));
        }
        return { trace, rows, error: null, failedStep: null, skipped: null };
    } catch (error) {
        return { trace, rows, error: error instanceof Error ? error.message : String(error), failedStep: current, skipped: null };
    } finally {
        await session.driver.releaseAll().catch(() => undefined);
    }
}

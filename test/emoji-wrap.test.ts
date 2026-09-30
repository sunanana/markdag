// 描画の側で絵文字を span.mdag-emoji に囲む処理 (wrapEmoji) の境界。期待は「入力の HTML と、囲んだあとの HTML」の組で書く。
// 決まり: 色つきの絵文字として描かれる並びだけを 1 つずつ囲む。文字の形で出る記号 (©、™、®、U+FE0F のない ☀ ♥) と数字や # だけの字は囲まない。
// code、pre、kbd、mark の中も囲む (F3-3)。ロゴの印と数式の中は囲まない。HTML のエスケープされた文字と属性は変えない。
// 単体テストの環境は node で DOM を持たないので、wrapEmoji が使う DOM の範囲だけを持つ小さな偽物をこのファイルに置く。
// HTML の読み書きはブラウザの innerHTML と同じ規則 (文字は & < > を、属性は & " をエスケープする) にしてある。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMOJI_CLASS, wrapEmoji } from '../src/view/emoji';

const SHOW_TEXT = 4;
const VOID_ELEMENTS = new Set(['br', 'img', 'input', 'hr']);

abstract class FakeNode {
    parentNode: FakeElement | null = null;
    abstract readonly nodeType: number;
    abstract get textContent(): string;

    get parentElement(): FakeElement | null {
        return this.parentNode;
    }

    replaceWith(...nodes: FakeNode[]): void {
        const parent = this.parentNode;
        if (!parent) throw new Error('replaceWith on a detached node');
        const index = parent.childNodes.indexOf(this);
        for (const node of nodes) node.parentNode = parent;
        parent.childNodes.splice(index, 1, ...nodes);
        this.parentNode = null;
    }
}

class FakeText extends FakeNode {
    readonly nodeType = 3;
    constructor(public data: string) {
        super();
    }
    get textContent(): string {
        return this.data;
    }
}

class FakeElement extends FakeNode {
    readonly nodeType = 1;
    childNodes: FakeNode[] = [];
    attributes: Array<[string, string]> = [];
    constructor(public readonly localName: string) {
        super();
    }

    get textContent(): string {
        return this.childNodes.map((child) => child.textContent).join('');
    }
    set textContent(value: string) {
        for (const child of this.childNodes) child.parentNode = null;
        this.childNodes = [];
        if (value !== '') this.append(new FakeText(value));
    }

    get className(): string {
        return this.getAttribute('class') ?? '';
    }
    set className(value: string) {
        this.setAttribute('class', value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.find(([key]) => key === name)?.[1] ?? null;
    }
    setAttribute(name: string, value: string): void {
        const found = this.attributes.find(([key]) => key === name);
        if (found) found[1] = value;
        else this.attributes.push([name, value]);
    }

    append(...nodes: FakeNode[]): void {
        for (const node of nodes) {
            node.parentNode = this;
            this.childNodes.push(node);
        }
    }

    contains(node: FakeNode | null): boolean {
        for (let at = node; at; at = at.parentNode) if (at === this) return true;
        return false;
    }

    // wrapEmoji の読み飛ばしの一覧に出る形 (要素の名前と .class の , 区切り) だけを読む。ほかの形は黙って外さないよう投げる
    matches(selector: string): boolean {
        return selector.split(',').some((part) => {
            const simple = part.trim();
            if (/^[a-z][a-z0-9]*$/.test(simple)) return this.localName === simple;
            if (/^\.[\w-]+$/.test(simple)) return this.className.split(/\s+/).includes(simple.slice(1));
            throw new Error(`the fake DOM does not read the selector: ${simple}`);
        });
    }

    closest(selector: string): FakeElement | null {
        for (let at: FakeElement | null = this; at; at = at.parentNode) if (at.matches(selector)) return at;
        return null;
    }
}

// 文書順で次のノード (root の中だけ)
function following(node: FakeNode, root: FakeElement): FakeNode | null {
    if (node instanceof FakeElement && node.childNodes.length > 0) return node.childNodes[0] ?? null;
    for (let at: FakeNode | null = node; at && at !== root; at = at.parentNode) {
        const siblings = at.parentNode?.childNodes ?? [];
        const next = siblings[siblings.indexOf(at) + 1];
        if (next) return next;
    }
    return null;
}

const fakeDocument = {
    createElement: (name: string) => new FakeElement(name),
    createTextNode: (data: string) => new FakeText(data),
    createTreeWalker(root: FakeElement, whatToShow: number) {
        if (whatToShow !== SHOW_TEXT) throw new Error(`the fake DOM only walks text nodes: ${whatToShow}`);
        let current: FakeNode = root;
        return {
            nextNode(): FakeNode | null {
                for (let at = following(current, root); at; at = following(at, root)) {
                    current = at;
                    if (at instanceof FakeText) return at;
                }
                return null;
            },
        };
    },
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
        if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16));
        if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
        const found = ENTITIES[name];
        if (found === undefined) throw new Error(`unknown entity: ${whole}`);
        return found;
    });
}

// 試験の入力に使う範囲の HTML (開き、閉じ、空要素、引用符つきの属性、文字) だけを読む
function parseHtml(html: string): FakeElement {
    const root = new FakeElement('div');
    let open = root;
    let consumed = 0;
    for (const token of html.matchAll(/<\/([a-z][a-z0-9]*)>|<([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>|([^<]+)/gy)) {
        const [whole, closing, opening, attributes, text] = token;
        consumed += whole.length;
        if (closing !== undefined) {
            if (open.localName !== closing || !open.parentNode) throw new Error(`unbalanced </${closing}> in ${html}`);
            open = open.parentNode;
        } else if (opening !== undefined) {
            const element = new FakeElement(opening);
            for (const [, name, value] of (attributes ?? '').matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) element.setAttribute(name ?? '', decode(value ?? ''));
            open.append(element);
            if (!VOID_ELEMENTS.has(opening)) open = element;
        } else if (text !== undefined) {
            open.append(new FakeText(decode(text)));
        }
    }
    if (consumed !== html.length || open !== root) throw new Error(`the fake DOM could not read: ${html}`);
    return root;
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escapeAttribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

function serialize(node: FakeNode): string {
    if (node instanceof FakeText) return escapeText(node.data);
    if (!(node instanceof FakeElement)) throw new Error('unknown node');
    const attributes = node.attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
    if (VOID_ELEMENTS.has(node.localName)) return `<${node.localName}${attributes}>`;
    return `<${node.localName}${attributes}>${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

const innerHtml = (root: FakeElement): string => root.childNodes.map(serialize).join('');

function wrapped(html: string): string {
    const root = parseHtml(html);
    wrapEmoji(root as unknown as HTMLElement);
    return innerHtml(root);
}

const W = (emoji: string): string => `<span class="${EMOJI_CLASS}">${emoji}</span>`;

const VS16 = '\u{FE0F}';
const VS15 = '\u{FE0E}';
const ZWJ = '\u{200D}';
const FAMILY = `👨${ZWJ}👩${ZWJ}👧`;
const TECHNOLOGIST = `🧑🏽${ZWJ}💻`;
const RAINBOW_FLAG = `🏳${VS16}${ZWJ}🌈`;
const HEART_ON_FIRE = `❤${VS16}${ZWJ}🔥`;
const ENGLAND = '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

interface Case {
    name: string;
    input: string;
    expected: string;
}

// 決まりの境界。名前の先頭の番号は依頼者の決めた境界の並び
const CASES: Case[] = [
    { name: '1 行頭', input: '<p>🎉 始める</p>', expected: `<p>${W('🎉')} 始める</p>` },
    { name: '1 行頭 (改行のあとの 2 行目)', input: '<p>一行目<br>🎉 二行目</p>', expected: `<p>一行目<br>${W('🎉')} 二行目</p>` },
    { name: '2 行の途中', input: '<p>急ぎ 🔥 直す</p>', expected: `<p>急ぎ ${W('🔥')} 直す</p>` },
    { name: '2 行の途中 (前後に空白なし)', input: '<p>急ぎ🔥直す</p>', expected: `<p>急ぎ${W('🔥')}直す</p>` },
    { name: '2 行末', input: '<p>済み ✅</p>', expected: `<p>済み ${W('✅')}</p>` },
    { name: '3 2 つ続く (同じ字)', input: '<p>✅✅ 済み</p>', expected: `<p>${W('✅')}${W('✅')} 済み</p>` },
    { name: '3 2 つ続く (違う字)', input: '<p>🎉🔥 祝う</p>', expected: `<p>${W('🎉')}${W('🔥')} 祝う</p>` },
    { name: '4 ZWJ の並び (家族) は 1 つの span', input: `<p>${FAMILY} 家族</p>`, expected: `<p>${W(FAMILY)} 家族</p>` },
    { name: '4 ZWJ の並び (肌の色 + ZWJ)', input: `<p>${TECHNOLOGIST} 開発</p>`, expected: `<p>${W(TECHNOLOGIST)} 開発</p>` },
    { name: '4 ZWJ の並び (U+FE0F + ZWJ)', input: `<p>${RAINBOW_FLAG} ${HEART_ON_FIRE}</p>`, expected: `<p>${W(RAINBOW_FLAG)} ${W(HEART_ON_FIRE)}</p>` },
    { name: '4 ZWJ の並びの後ろに別の絵文字', input: `<p>${FAMILY}🎉</p>`, expected: `<p>${W(FAMILY)}${W('🎉')}</p>` },
    { name: '5 国旗は 2 字で 1 つの span', input: '<p>🇯🇵 日本</p>', expected: `<p>${W('🇯🇵')} 日本</p>` },
    { name: '5 国旗が 2 つ続くと 2 つの span', input: '<p>🇯🇵🇺🇸</p>', expected: `<p>${W('🇯🇵')}${W('🇺🇸')}</p>` },
    { name: '6 肌の色の修飾子は前の字と 1 つの span', input: '<p>👍🏽 いいね</p>', expected: `<p>${W('👍🏽')} いいね</p>` },
    { name: '6 肌の色の修飾子 (文字の見た目が既定の字 ☝ に付く)', input: '<p>☝🏽 一つ</p>', expected: `<p>${W('☝🏽')} 一つ</p>` },
    { name: '7 キーキャップ (#)', input: `<p>#${VS16}⃣ 番号</p>`, expected: `<p>${W(`#${VS16}⃣`)} 番号</p>` },
    { name: '7 キーキャップ (数字)', input: `<p>1${VS16}⃣ 一つ目 2${VS16}⃣ 二つ目</p>`, expected: `<p>${W(`1${VS16}⃣`)} 一つ目 ${W(`2${VS16}⃣`)} 二つ目</p>` },
    { name: '8 U+FE0F なしの ☀ ♥ は囲まない', input: '<p>☀ 晴れ ♥ 好き</p>', expected: '<p>☀ 晴れ ♥ 好き</p>' },
    { name: '8 U+FE0F 付きの ☀️ ♥️ は囲む', input: `<p>☀${VS16} 晴れ ♥${VS16} 好き</p>`, expected: `<p>${W(`☀${VS16}`)} 晴れ ${W(`♥${VS16}`)} 好き</p>` },
    { name: '8 U+FE0E (文字の見た目の指定) 付きは囲まない', input: `<p>☀${VS15} 晴れ ✅${VS15} 済み</p>`, expected: `<p>☀${VS15} 晴れ ✅${VS15} 済み</p>` },
    { name: '9 code の中も囲む', input: '<p><code>🎉 x</code> 🎉</p>', expected: `<p><code>${W('🎉')} x</code> ${W('🎉')}</p>` },
    { name: '9 pre の中も囲む', input: '<pre><code>🔥 = 1</code></pre><pre>✅ 直書き</pre>', expected: `<pre><code>${W('🔥')} = 1</code></pre><pre>${W('✅')} 直書き</pre>` },
    { name: '9 kbd の中も囲む', input: '<p><kbd>🔥</kbd> を押す</p>', expected: `<p><kbd>${W('🔥')}</kbd> を押す</p>` },
    { name: '9 code の中の入れ子の要素も囲む', input: '<p><code><b>🎉</b></code></p>', expected: `<p><code><b>${W('🎉')}</b></code></p>` },
    {
        name: '9 code の中の ZWJ の並びと国旗は 1 つずつの span (© は囲まない)',
        input: `<p><code>${FAMILY}🇯🇵🇺🇸 © x</code></p>`,
        expected: `<p><code>${W(FAMILY)}${W('🇯🇵')}${W('🇺🇸')} © x</code></p>`,
    },
    {
        name: '9 mark と kbd の中の肌の色とキーキャップ (U+FE0F なしの ☀ は囲まない)',
        input: `<p><mark>👍🏽 ☀ 済み</mark> <kbd>1${VS16}⃣</kbd></p>`,
        expected: `<p><mark>${W('👍🏽')} ☀ 済み</mark> <kbd>${W(`1${VS16}⃣`)}</kbd></p>`,
    },
    { name: '10 © ™ ® は囲まない', input: '<p>© 2026 ACME™ 登録® 済み</p>', expected: '<p>© 2026 ACME™ 登録® 済み</p>' },
    { name: '10 © に U+FE0F が付けば囲む', input: `<p>©${VS16} 表記</p>`, expected: `<p>${W(`©${VS16}`)} 表記</p>` },
    { name: '11 数字や # や * だけは囲まない', input: '<p>#1 の 123 と * と # と #urgent</p>', expected: '<p>#1 の 123 と * と # と #urgent</p>' },
    {
        name: '12 エスケープされた文字は変わらない',
        input: '<p>a &amp; b &lt;x&gt; 🎉 &amp;amp;</p>',
        expected: `<p>a &amp; b &lt;x&gt; ${W('🎉')} &amp;amp;</p>`,
    },
    {
        name: '12 タグの属性の中は囲まない (リンクの中の文字は囲む)',
        input: '<p><a href="https://example.com/?q=🎉&amp;x=&quot;1&quot;" title="🔥 急ぎ">🔥 リンク</a> <img src="x.png" alt="🎉"></p>',
        expected: `<p><a href="https://example.com/?q=🎉&amp;x=&quot;1&quot;" title="🔥 急ぎ">${W('🔥')} リンク</a> <img src="x.png" alt="🎉"></p>`,
    },
];

// 前の直し (fix-1) で決めて依頼者が確かめた、そのほかの境界
const MORE_CASES: Case[] = [
    { name: 'mark の中も囲む (mark は色で薄くなる)', input: '<p><mark>🎉</mark></p>', expected: `<p><mark>${W('🎉')}</mark></p>` },
    { name: 'ロゴの印 (.mdag-icon) の中は囲まない', input: '<p><span class="mdag-icon" data-icon-kind="emoji">🚀</span> 公開</p>', expected: '<p><span class="mdag-icon" data-icon-kind="emoji">🚀</span> 公開</p>' },
    { name: '数式 (.mdag-math) の中は囲まない', input: '<p><span class="mdag-math">✅</span></p>', expected: '<p><span class="mdag-math">✅</span></p>' },
    { name: 'タグの並びの旗 (イングランド) は 1 つの span', input: `<p>${ENGLAND} 旗</p>`, expected: `<p>${W(ENGLAND)} 旗</p>` },
    { name: '色のないグループの文字ラベル', input: `<span class="mdag-labels">%🔥急ぎ %${FAMILY}家族 %©表記</span>`, expected: `<span class="mdag-labels">%${W('🔥')}急ぎ %${W(FAMILY)}家族 %©表記</span>` },
    { name: '絵文字のない文字は変えない', input: '<p>ただの文字 <b>太字</b></p>', expected: '<p>ただの文字 <b>太字</b></p>' },
    // 決まりになかった形。依頼者が今の挙動のまま固定すると決めた
    { name: 'U+FE0F のないキーキャップ (1⃣) は囲む', input: '<p>1⃣ 一つ目</p>', expected: `<p>${W('1⃣')} 一つ目</p>` },
    { name: '単独の肌の色の修飾子は囲まない', input: '<p>🏽 だけ</p>', expected: '<p>🏽 だけ</p>' },
    { name: '組になっていない Regional Indicator は囲まない', input: '<p>🇯 だけ</p>', expected: '<p>🇯 だけ</p>' },
];

describe('wrapEmoji (本文、タグ、グループの文字ラベルの絵文字を span で囲む)', () => {
    beforeAll(() => {
        vi.stubGlobal('document', fakeDocument);
        vi.stubGlobal('NodeFilter', { SHOW_TEXT });
    });
    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('偽物の DOM は入力の HTML を読み書きして元に戻す (試験の道具の確かめ)', () => {
        for (const item of [...CASES, ...MORE_CASES]) expect(innerHtml(parseHtml(item.input)), item.name).toBe(item.input);
    });

    it.each(CASES)('決まりの境界: $name', ({ input, expected }) => {
        expect(wrapped(input)).toBe(expected);
    });

    it.each(MORE_CASES)('そのほかの境界: $name', ({ input, expected }) => {
        expect(wrapped(input)).toBe(expected);
    });

    it('囲んでも文字 (textContent) は変わらない', () => {
        for (const item of [...CASES, ...MORE_CASES]) {
            const root = parseHtml(item.input);
            const before = root.textContent;
            wrapEmoji(root as unknown as HTMLElement);
            expect(root.textContent, item.name).toBe(before);
        }
    });

    it('渡した要素そのものが code でも中を囲む', () => {
        const root = parseHtml('<code>🎉</code>');
        const code = root.childNodes[0] as FakeElement;
        wrapEmoji(code as unknown as HTMLElement);
        expect(innerHtml(root)).toBe(`<code>${W('🎉')}</code>`);
    });

    it('渡した要素そのものが数式 (.mdag-math) なら中を囲まない', () => {
        const root = parseHtml('<span class="mdag-math">🎉</span>');
        const math = root.childNodes[0] as FakeElement;
        wrapEmoji(math as unknown as HTMLElement);
        expect(innerHtml(root)).toBe('<span class="mdag-math">🎉</span>');
    });
});

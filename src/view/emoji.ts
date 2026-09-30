// 本文、タグ、色のないグループの文字ラベルに直接書いた絵文字を span (EMOJI_CLASS) で囲む。絵文字の字形は自分の色を持ち、文字の色を変えても薄くならないので、
// 薄く表示するノードで CSS が opacity を当てるための目印にする。解析が書いた HTML は変えず、描画の側で DOM にだけ足す。
// 囲むのは色つきの絵文字として描かれる並び (絵文字の既定の見た目の字、U+FE0F を付けた字、肌の色、ZWJ の並び、国旗、キーキャップ) で、
// ©、™ のような文字の見た目が既定の字は文字の色で薄くなるので囲まない (囲むと色と opacity で二重に薄くなる)。
// コード (code、pre、kbd) と mark の中も囲む。これらは要素の opacity ではなく字 (と地) の色で薄くなるので、中の絵文字も囲まないと薄くならない。
// ロゴの印 (自分の opacity で薄くなる) と数式の中は囲まない
export const EMOJI_CLASS = 'mdag-emoji';

const EMOJI =
    /[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|︎|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*/gu;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const MAYBE_EMOJI = /[\u{1F1E6}-\u{1F1FF}⃣\p{Extended_Pictographic}]/u;
const SKIP = 'samp, svg, math, script, style, textarea, .mdag-icon, .mdag-math, .mdag-math-block';

const drawnAsEmoji = (match: string): boolean =>
    !match.includes('︎') && ([...match].length > 1 || EMOJI_PRESENTATION.test(match));

export function wrapEmoji(root: HTMLElement): void {
    if (!MAYBE_EMOJI.test(root.textContent ?? '')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const skipped = node.parentElement?.closest(SKIP);
        if (skipped && root.contains(skipped)) continue;
        texts.push(node as Text);
    }
    for (const text of texts) {
        const value = text.data;
        const pieces: Node[] = [];
        let last = 0;
        for (const found of value.matchAll(EMOJI)) {
            if (!drawnAsEmoji(found[0])) continue;
            if (found.index > last) pieces.push(document.createTextNode(value.slice(last, found.index)));
            const span = document.createElement('span');
            span.className = EMOJI_CLASS;
            span.textContent = found[0];
            pieces.push(span);
            last = found.index + found[0].length;
        }
        if (pieces.length === 0) continue;
        if (last < value.length) pieces.push(document.createTextNode(value.slice(last)));
        text.replaceWith(...pieces);
    }
}

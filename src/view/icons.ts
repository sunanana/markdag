// ロゴの描画の部品。本文の印 (ICON_MARK) とタグを、呼び出し側が解決した SVG でロゴにする HTML を作る。
// SVG の実体は IconSvgStore が持ち (ref → SVG の文字列 | null)、引けないロゴは書いたとおりの文字のまま残す。
// 絵文字の alias は解決せず、その文字をそのまま出す。DOM を使わない文字列の処理にして、単体テストから直接呼べるようにしている。
import type { GraphModel, GroupDef, IconColor, IconDef, IconTable } from '../model/model';
import { iconDefOf } from '../model/model';
import { formatTag, type TagKeyDef } from '../model/tags';
import { ICON_MARK, type NodeTag, type OutlineNode } from '../parse/document';

// 描画の側が SVG を引く口。ref (set:name か相対パス) → SVG の文字列。
// null は「引けなかった」(解決に失敗した、または呼び出し側が返さなかった)、undefined は「まだ入っていない」(解決の前か途中)。
// どちらも文字のまま描く。入れるときにサニタイズするので、get が返すものはそのまま埋め込んでよい
export class IconSvgStore {
    private readonly svgs = new Map<string, string | null>();

    get(ref: string): string | null | undefined {
        return this.svgs.get(ref);
    }

    // 入れた結果が前と変わったら true (描き直しの要否に使う)
    set(ref: string, svg: string | null): boolean {
        const next = svg === null ? null : sanitizeSvg(svg);
        if (this.svgs.has(ref) && this.svgs.get(ref) === next) return false;
        this.svgs.set(ref, next);
        return true;
    }

    clear(): void {
        this.svgs.clear();
    }
}

export interface IconRenderContext {
    icons: IconTable;
    svgOf: (ref: string) => string | null | undefined;
}

const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

const colorOf = (def: IconDef, icons: IconTable): IconColor => def.color ?? icons.color;

// ロゴ 1 つの中身。絵文字はその文字、それ以外は引けた SVG。引けなければ null
function logoBody(def: IconDef, context: IconRenderContext): { html: string; color: IconColor | null } | null {
    if (def.kind === 'emoji') return { html: escapeHtml(def.ref), color: null };
    const svg = context.svgOf(def.ref);
    return svg ? { html: svgCopy(svg), color: colorOf(def, context.icons) } : null;
}

// ロゴの要素。data-icon-color は SVG のときだけ付け、絵文字には付けない (CSS はこれで大きさと色を当てる)
function logoSpan(alias: string, body: { html: string; color: IconColor | null }, label: string | null): string {
    const color = body.color === null ? ' data-icon-kind="emoji"' : ` data-icon-color="${body.color}" role="img"`;
    const titled = label === null ? '' : ` title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"`;
    return `<span class="mdag-icon" data-icon="${alias}"${color}${titled}>${body.html}</span>`;
}

const plainMark = (alias: string): string => `<span class="mdag-icon" data-icon="${alias}">:${alias}:</span>`;

// 本文の印 1 つの HTML。引けたらロゴ、引けなければ解析が書いた印のまま (中身は :alias: の文字)
export function iconMarkHtml(alias: string, context: IconRenderContext): string {
    const def = context.icons.aliases.get(alias);
    const body = def ? logoBody(def, context) : null;
    return body ? logoSpan(alias, body, body.color === null ? null : `:${alias}:`) : plainMark(alias);
}

// ノードの HTML の中の印を、引けるものだけロゴに差し替える。印のない HTML はそのまま返す
export function renderIconMarks(html: string, context: IconRenderContext): string {
    if (!html.includes('mdag-icon')) return html;
    return html.replace(ICON_MARK, (_whole, alias: string) => iconMarkHtml(alias, context));
}

// ノードの本文と吹き出しの詳細に共通の入口。文脈がない (ロゴを使わない) 文書では HTML をそのまま返す
export function withIconMarks(html: string, context: IconRenderContext | null): string {
    return context ? renderIconMarks(html, context) : html;
}

// タグのキーの定義。定義のないキーは undefined
const keyDefOf = (tagKeys: TagKeyDef[], key: string): TagKeyDef | undefined => tagKeys.find((item) => item.key === key);

// 問い合わせる ref の一覧に足す。絵文字は解決しないので入れない
function addResolvableRef(refs: Set<string>, def: IconDef | null | undefined): void {
    if (def && def.kind !== 'emoji') refs.add(def.ref);
}

// タグ 1 つに付けるロゴの alias。キーの印 (icon) が先、値の印 (icons) が値の順。
// icon と icons を両方書いたキーでは、値のロゴがあってもキーの印を出す。
// icons は自分の持つキーだけで引く (値が constructor や __proto__ でも Object の原型のものを拾わない。Rust の IndexMap と同じ結果)
function tagAliases(tag: Pick<NodeTag, 'key' | 'values'>, def: TagKeyDef | undefined): string[] {
    if (!def) return [];
    const aliases = def.icon === undefined ? [] : [def.icon];
    for (const value of tag.values) {
        const alias = def.icons !== undefined && Object.hasOwn(def.icons, value) ? def.icons[value] : undefined;
        if (alias !== undefined) aliases.push(alias);
    }
    return aliases;
}

// タグの並びの HTML。各タグは「ロゴ (引けた分だけ) + 書いたとおりの文字」で、タグの間は空白 1 つ。
// ロゴが 1 つも引けなければ null を返し、呼び出し側は今までどおり文字だけ (textContent) で描く
export function tagsHtml(tags: Array<Pick<NodeTag, 'key' | 'values'>>, tagKeys: TagKeyDef[], context: IconRenderContext): string | null {
    let drawn = false;
    const parts = tags.map((tag) => {
        const logos = tagAliases(tag, keyDefOf(tagKeys, tag.key)).flatMap((alias) => {
            const icon = iconDefOf(context.icons, alias);
            const body = icon ? logoBody(icon, context) : null;
            return body ? [logoSpan(alias, body, null)] : [];
        });
        if (logos.length > 0) drawn = true;
        return logos.join('') + escapeHtml(formatTag(tag));
    });
    return drawn ? parts.join(' ') : null;
}

// タグの並びの中身。ノードの中のタグと吹き出しのタグの行に共通の入口。
// ロゴが引けたら HTML、1 つも引けないか文脈がなければ書いたとおりの文字 (呼び出し側は textContent で入れる)
export function tagLineContent(
    tags: Array<Pick<NodeTag, 'key' | 'values'>>,
    tagKeys: TagKeyDef[],
    context: IconRenderContext | null,
): { html: string } | { text: string } {
    const html = context ? tagsHtml(tags, tagKeys, context) : null;
    return html === null ? { text: tags.map(formatTag).join(' ') } : { html };
}

// ノードの描画に使う ref (本文の印とタグ)。ref の SVG が入ったときに、描き直すノードを選ぶのに使う
export function nodeIconRefs(node: Pick<OutlineNode, 'html'>, tags: Array<Pick<NodeTag, 'key' | 'values'>>, model: Pick<GraphModel, 'icons' | 'tagKeys'>): Set<string> {
    const refs = new Set<string>();
    for (const [, alias] of node.html.matchAll(ICON_MARK)) addResolvableRef(refs, model.icons.aliases.get(alias ?? ''));
    for (const tag of tags) {
        for (const alias of tagAliases(tag, keyDefOf(model.tagKeys, tag.key))) addResolvableRef(refs, iconDefOf(model.icons, alias));
    }
    return refs;
}

// グループのロゴ (枠のラベルと凡例に出す)。絵文字の alias は本文と同じく解決せず、その文字を出す (mono / original の色の規則も当てない)。
// icon がない、表にない alias、SVG が引けないときは null (ロゴなしで今までどおり描く)
export type GroupLogo =
    | { kind: 'svg'; alias: string; ref: string; svg: string; color: IconColor }
    | { kind: 'emoji'; alias: string; text: string };

export function groupLogo(group: Pick<GroupDef, 'icon'>, context: IconRenderContext): GroupLogo | null {
    if (group.icon === undefined) return null;
    const def = iconDefOf(context.icons, group.icon);
    if (!def) return null;
    if (def.kind === 'emoji') return { kind: 'emoji', alias: group.icon, text: def.ref };
    const svg = context.svgOf(def.ref);
    return svg ? { kind: 'svg', alias: group.icon, ref: def.ref, svg: svgCopy(svg), color: colorOf(def, context.icons) } : null;
}

// 枠のラベルのロゴの大きさと、ロゴと文字の間
export const FRAME_ICON_SIZE = 14;
export const FRAME_ICON_GAP = 4;

// 枠のラベルの並び。ラベルは SVG の <text> なので、ロゴは同じ SVG の中の入れ子の <svg> として文字の左に置き、文字を右にずらす。
// x はラベルの左端、baseline は文字のベースライン。ロゴは 11px の文字の中ほどに縦の中心を合わせる。
// paint は mono のときに塗る色 (グループの色)。original は SVG に書かれた色のままなので null
// 絵文字の alias は logo ではなく emoji に入り、ラベルと同じベースラインの <text> として描く。文字のずらし幅はロゴと同じ。
// emoji は絵文字のときだけ持つ (ほかのときはキーごとない)
// 本文のロゴと違い、ツールチップ (title) と aria-label を付けない (すぐ右に名前の文字があるため)
export interface FrameLabelParts {
    textX: number;
    logo: { x: number; y: number; size: number; alias: string; svg: string; color: IconColor; paint: string | null } | null;
    emoji?: { x: number; y: number; alias: string; text: string };
}

export function frameLabelParts(group: Pick<GroupDef, 'icon'>, x: number, baseline: number, groupColor: string, context: IconRenderContext | null): FrameLabelParts {
    const logo = context ? groupLogo(group, context) : null;
    if (!logo) return { textX: x, logo: null };
    const textX = x + FRAME_ICON_SIZE + FRAME_ICON_GAP;
    if (logo.kind === 'emoji') return { textX, logo: null, emoji: { x, y: baseline, alias: logo.alias, text: logo.text } };
    return {
        textX,
        logo: {
            x,
            y: baseline - 4 - FRAME_ICON_SIZE / 2,
            size: FRAME_ICON_SIZE,
            alias: logo.alias,
            svg: logo.svg,
            color: logo.color,
            paint: logo.color === 'mono' ? groupColor : null,
        },
    };
}

// 凡例の項目に、色チップの隣 (名前の前) に置くロゴの HTML。mono の色 (薄い色) は CSS が決める。絵文字は本文と同じ文字の span。引けなければ null
// 色のないグループでも、ロゴがあるときにチップ (透明の四角) を省かない
export function legendLogoHtml(group: Pick<GroupDef, 'icon'>, context: IconRenderContext | null): string | null {
    const logo = context ? groupLogo(group, context) : null;
    if (!logo) return null;
    return logo.kind === 'emoji'
        ? logoSpan(logo.alias, { html: escapeHtml(logo.text), color: null }, null)
        : logoSpan(logo.alias, { html: logo.svg, color: logo.color }, null);
}

// グループのロゴが使う ref。ref の SVG が入ったときに、枠と凡例を描き直すかを決めるのに使う
export function groupIconRefs(model: Pick<GraphModel, 'icons' | 'groups'>): Set<string> {
    const refs = new Set<string>();
    for (const group of model.groups) addResolvableRef(refs, group.icon === undefined ? null : iconDefOf(model.icons, group.icon));
    return refs;
}

// 文書が描くのに要る ref の全体 (本文、タグ、グループ)。呼び出し側が resolver に問い合わせる一覧に使う
export function documentIconRefs(nodes: Array<Pick<OutlineNode, 'id' | 'html'>>, model: Pick<GraphModel, 'icons' | 'tagKeys' | 'tagsOf' | 'groups'>): Set<string> {
    const refs = new Set<string>();
    for (const node of nodes) for (const ref of nodeIconRefs(node, model.tagsOf.get(node.id) ?? [], model)) refs.add(ref);
    for (const ref of groupIconRefs(model)) refs.add(ref);
    return refs;
}

// 受け取った SVG を、ページに埋め込んでよい形にする。<svg> の要素 1 つでなければ null。
// 字句に分けて、許可した要素と属性だけで書き直す (許可リスト)。DOM を使わないので、ブラウザでも node でも同じ結果になる。
// 属性の区切りは HTML の構文解析と同じに読む (引用符の直後や / のあとにも次の属性ができる)。
// 落とすもの: XML 宣言、DOCTYPE、コメント、CDATA、許可していない要素 (中身ごと。script、style、title、foreignObject、
// アニメーション、HTML の要素など)、許可していない属性 (on* を含む)、# で始まらない href、外を指す url() などの関数を含む属性、
// 文字参照か CSS のエスケープを含む属性 (url( を隠せるため)。a 要素は g に置き換える。
// ルートの width、height、class、style、id は外し (大きさは CSS が決める)、viewBox がなければ width と height から作る。
// ルートの fill は中身を包む g に移す (CSS でルートの fill を決めても、書かれた色が残るように)。g の fill もほかの属性と同じ書き方 (" だけを &quot;) にする
export function sanitizeSvg(input: string): string | null {
    const tokens = svgTokens(input.replace(/\r\n?/g, '\n'));
    let index = 0;
    const skipTrivia = (): void => {
        while (index < tokens.length) {
            const token = tokens[index];
            if (token?.type === 'text' ? token.text.trim() !== '' : token?.type !== 'other') return;
            index += 1;
        }
    };
    skipTrivia();
    const root = tokens[index];
    if (root?.type !== 'start' || root.name.toLowerCase() !== 'svg' || root.selfClosing) return null;
    index += 1;

    let inner = '';
    // 開いている要素。dropped は中身ごと落とすもの (その中は書かない)、written は開きのタグを書いたか
    const open: Array<{ name: string; out: string; dropped: boolean; written: boolean }> = [];
    const dropping = (): boolean => open.some((element) => element.dropped);
    const close = (from: number): void => {
        for (const element of open.splice(from).reverse()) if (element.written) inner += `</${element.out}>`;
    };
    let closed = false;
    for (; index < tokens.length && !closed; index += 1) {
        const token = tokens[index];
        if (!token) break;
        if (token.type === 'text') {
            if (!dropping()) inner += token.text.replace(/</g, '&lt;');
        } else if (token.type === 'start') {
            const lower = token.name.toLowerCase();
            const allowed = SVG_ELEMENTS.has(lower) || lower === 'a';
            const out = lower === 'a' ? 'g' : token.name;
            const selfClosing = token.selfClosing || (!allowed && HTML_VOID.has(lower));
            const written = allowed && !dropping();
            if (written) inner += `<${out}${attributesHtml(token.attributes, false)}${token.selfClosing ? '/>' : '>'}`;
            if (!selfClosing) open.push({ name: lower, out, dropped: !allowed, written });
        } else if (token.type === 'end') {
            const lower = token.name.toLowerCase();
            const at = open.map((element) => element.name).lastIndexOf(lower);
            if (at >= 0) close(at);
            else if (lower === 'svg') {
                // ルートの閉じ。開いたままの要素はここで閉じる
                close(0);
                closed = true;
            }
        }
    }
    if (!closed) return null;
    skipTrivia();
    if (index < tokens.length) return null;

    const rootAttributes = root.attributes.filter((attribute) => safeAttribute(attribute));
    const read = (name: string): string | null => rootAttributes.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value ?? null;
    const width = read('width');
    const height = read('height');
    const fill = read('fill');
    const kept = rootAttributes.filter((attribute) => !ROOT_DROPPED.has(attribute.name.toLowerCase()));
    let attrs = attributesHtml(kept, true);
    if (read('viewBox') === null && width !== null && height !== null && /^[\d.]+(px)?$/.test(width) && /^[\d.]+(px)?$/.test(height)) {
        attrs += ` viewBox="0 0 ${parseFloat(width)} ${parseFloat(height)}"`;
    }
    return fill === null ? `<svg${attrs}>${inner}</svg>` : `<svg${attrs}><g fill="${fill.replace(/"/g, '&quot;')}">${inner}</g></svg>`;
}

// 写しの id の接頭辞に使う連番。ページの中の写しごとに一意にする
let svgCopyCount = 0;

// 消毒したあとの SVG を、ページに入れる写し 1 つにする。同じ SVG を複数の場所に置くと中の id (グラデーション、clipPath など) が重なり、
// url(#id) や href="#id" が別の写し (表示されていない吹き出しの中など) を指して塗りが消えることがあるため、写しごとに id を付け直す。
// 付け直した id は `mdag-svg<連番>-<写しの中の順>` (元の id の文字は使わない)。合わせる参照は、同じ写しの中の id を指す
// 属性の値の url(#id) (引用符つきと style の中を含む) と href / xlink:href の #id。写しの中にない id への参照は変えない。
// 引用符つきの url() は閉じの引用符までを id として読む (空白や ) を含む id も合わせる)。空の id は付け直さない (href="#" が何も指さないまま)。
// id を持たない SVG はそのまま返す。置き場の文字列は変えない (呼び出し側は、写しを作るたびにこれを通す)
export function svgCopy(svg: string): string {
    const tokens = svgTokens(svg);
    const renamed = new Map<string, string>();
    const prefix = `mdag-svg${svgCopyCount + 1}-`;
    for (const token of tokens) {
        if (token.type !== 'start') continue;
        for (const attribute of token.attributes) {
            if (attribute.name.toLowerCase() === 'id' && attribute.value !== null && attribute.value !== '' && !renamed.has(attribute.value)) renamed.set(attribute.value, `${prefix}${renamed.size}`);
        }
    }
    if (renamed.size === 0) return svg;
    svgCopyCount += 1;
    const rewrite = (name: string, value: string): string => {
        if (name === 'id') return renamed.get(value) ?? value;
        if (name === 'href' || name === 'xlink:href') return value.startsWith('#') && renamed.has(value.slice(1)) ? `#${renamed.get(value.slice(1))}` : value;
        // 消毒したあとの値の中の引用符は ' か &quot; (" は &quot; に書き直されている)
        return value.replace(
            /url\(\s*(?:'#([^']*)'|&quot;#((?:(?!&quot;).)*)&quot;|#([^"')\s&]+))\s*\)/gi,
            (whole, single: string | undefined, double: string | undefined, bare: string | undefined) => {
                const id = single ?? double ?? bare ?? '';
                const next = renamed.get(id);
                return next === undefined ? whole : whole.replace(`#${id}`, `#${next}`);
            },
        );
    };
    // 消毒したあとの SVG は文字、開きのタグ (属性は二重引用符)、閉じのタグだけなので、同じ書き方で組み直せば付け直した所のほかは元と同じ文字になる
    return tokens
        .map((token) => {
            if (token.type === 'text') return token.text;
            if (token.type === 'end') return `</${token.name}>`;
            if (token.type === 'other') return '';
            const attrs = token.attributes
                .map((attribute) => (attribute.value === null ? ` ${attribute.name}` : ` ${attribute.name}="${rewrite(attribute.name.toLowerCase(), attribute.value)}"`))
                .join('');
            return `<${token.name}${attrs}${token.selfClosing ? '/>' : '>'}`;
        })
        .join('');
}

// 描いてよい SVG の要素 (名前は小文字で比べる)。a は g に置き換えて通す
const SVG_ELEMENTS = new Set([
    'svg', 'g', 'defs', 'desc', 'metadata', 'symbol', 'use', 'switch', 'view',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'image',
    'text', 'tspan', 'textpath',
    'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
    'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix', 'fediffuselighting',
    'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
    'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset', 'fepointlight',
    'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
]);

// 描いてよい属性 (名前は小文字で比べる)。href と xlink:href は # で始まるものだけ別に通す
const SVG_ATTRIBUTES = new Set([
    'xmlns', 'xmlns:xlink', 'xml:space', 'xml:lang', 'lang', 'version', 'id', 'class', 'style',
    'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'fx', 'fy', 'fr', 'd', 'points', 'pathlength', 'transform', 'transform-origin', 'overflow', 'display', 'visibility',
    'opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'vector-effect', 'paint-order',
    'color', 'color-interpolation', 'color-interpolation-filters', 'shape-rendering', 'image-rendering', 'text-rendering',
    'clip-path', 'clip-rule', 'clippathunits', 'mask', 'maskunits', 'maskcontentunits', 'filter', 'filterunits',
    'primitiveunits', 'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'markerunits', 'refx',
    'refy', 'orient', 'gradientunits', 'gradienttransform', 'spreadmethod', 'offset', 'stop-color', 'stop-opacity',
    'patternunits', 'patterncontentunits', 'patterntransform', 'font-family', 'font-size', 'font-style', 'font-weight',
    'font-variant', 'font-stretch', 'letter-spacing', 'word-spacing', 'text-anchor', 'text-decoration',
    'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'writing-mode', 'direction', 'dx', 'dy', 'rotate',
    'textlength', 'lengthadjust', 'startoffset', 'method', 'spacing', 'side', 'path', 'in', 'in2', 'result', 'mode',
    'operator', 'k1', 'k2', 'k3', 'k4', 'type', 'values', 'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent',
    'stddeviation', 'edgemode', 'kernelmatrix', 'kernelunitlength', 'order', 'divisor', 'bias', 'targetx', 'targety',
    'preservealpha', 'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent', 'lighting-color',
    'azimuth', 'elevation', 'z', 'pointsatx', 'pointsaty', 'pointsatz', 'limitingconeangle', 'scale',
    'xchannelselector', 'ychannelselector', 'flood-color', 'flood-opacity', 'radius', 'basefrequency', 'numoctaves',
    'seed', 'stitchtiles', 'systemlanguage', 'role', 'aria-hidden', 'aria-label', 'focusable',
]);

// 属性の値に書いてよい関数。url() は文書の中 (#id) を指すものだけ通す
const SAFE_FUNCTIONS = new Set([
    'url', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'var', 'calc',
    'min', 'max', 'clamp', 'matrix', 'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'rotate',
    'skewx', 'skewy', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity',
    'saturate', 'sepia',
]);

const ROOT_DROPPED = new Set(['width', 'height', 'class', 'style', 'fill', 'id']);

// HTML で閉じのタグを持たない要素。落とすときに、後ろを中身として飲み込まないように使う
const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

interface SvgAttribute {
    name: string;
    // 値を書いていない属性は null。引用符の中身か、引用符なしの値 (文字参照は読まない)
    value: string | null;
}

type SvgToken =
    | { type: 'text'; text: string }
    | { type: 'start'; name: string; selfClosing: boolean; attributes: SvgAttribute[] }
    | { type: 'end'; name: string }
    // コメント、DOCTYPE、XML 宣言、CDATA など書き出さないもの
    | { type: 'other' };

function safeAttribute(attribute: SvgAttribute): boolean {
    const name = attribute.name.toLowerCase();
    const value = attribute.value ?? '';
    if (name === 'href' || name === 'xlink:href') return value.startsWith('#') && !/[&\\]/.test(value);
    if (!SVG_ATTRIBUTES.has(name)) return false;
    if (/[&\\]/.test(value)) return false;
    for (const match of value.matchAll(/([a-z-]+)\(/gi)) {
        const fn = (match[1] ?? '').toLowerCase();
        if (!SAFE_FUNCTIONS.has(fn)) return false;
        if (fn === 'url' && !/^\s*["']?#/.test(value.slice((match.index ?? 0) + match[0].length))) return false;
    }
    return true;
}

// 通す属性を ` name="value"` の並びにする。同じ名前は最初のものだけ (HTML の構文解析と同じ)
function attributesHtml(attributes: SvgAttribute[], vetted: boolean): string {
    const seen = new Set<string>();
    let out = '';
    for (const attribute of attributes) {
        const lower = attribute.name.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        if (!vetted && !safeAttribute(attribute)) continue;
        out += attribute.value === null ? ` ${attribute.name}` : ` ${attribute.name}="${attribute.value.replace(/"/g, '&quot;')}"`;
    }
    return out;
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f';

// HTML の字句の規則 (データの状態) で、文字、開きのタグ、閉じのタグ、書き出さないものに分ける
function svgTokens(input: string): SvgToken[] {
    const tokens: SvgToken[] = [];
    let text = '';
    const flush = (): void => {
        if (text !== '') tokens.push({ type: 'text', text });
        text = '';
    };
    let at = 0;
    while (at < input.length) {
        const lt = input.indexOf('<', at);
        if (lt < 0) {
            text += input.slice(at);
            break;
        }
        text += input.slice(at, lt);
        const next = input[lt + 1];
        if (input.startsWith('<!--', lt)) {
            const close = input.indexOf('-->', lt + 4);
            flush();
            tokens.push({ type: 'other' });
            at = close < 0 ? input.length : close + 3;
        } else if (input.startsWith('<![CDATA[', lt)) {
            const close = input.indexOf(']]>', lt + 9);
            flush();
            tokens.push({ type: 'other' });
            at = close < 0 ? input.length : close + 3;
        } else if (next === '!' || next === '?' || (next === '/' && !/[A-Za-z]/.test(input[lt + 2] ?? ''))) {
            const close = input.indexOf('>', lt + 2);
            flush();
            tokens.push({ type: 'other' });
            at = close < 0 ? input.length : close + 1;
        } else if (next !== undefined && /[A-Za-z]/.test(next)) {
            flush();
            const tag = readTag(input, lt + 1);
            if (!tag) {
                at = input.length;
                break;
            }
            tokens.push(tag.token);
            at = tag.next;
        } else if (next === '/') {
            flush();
            const tag = readTag(input, lt + 2);
            if (!tag) {
                at = input.length;
                break;
            }
            if (tag.token.type === 'start') tokens.push({ type: 'end', name: tag.token.name });
            at = tag.next;
        } else {
            text += '<';
            at = lt + 1;
        }
    }
    flush();
    return tokens;
}

// start は名前の最初の字の位置。終わりの > がなければ null (閉じていないタグは捨てる)
function readTag(input: string, start: number): { token: SvgToken; next: number } | null {
    let at = start;
    const stopsName = (c: string | undefined): boolean => c === undefined || isSpace(c) || c === '/' || c === '>';
    while (!stopsName(input[at])) at += 1;
    const name = input.slice(start, at);
    const attributes: SvgAttribute[] = [];
    let selfClosing = false;
    for (;;) {
        while (isSpace(input[at])) at += 1;
        const c = input[at];
        if (c === undefined) return null;
        if (c === '>') return { token: { type: 'start', name, selfClosing, attributes }, next: at + 1 };
        if (c === '/') {
            at += 1;
            selfClosing = input[at] === '>';
            continue;
        }
        selfClosing = false;
        const nameStart = at;
        at += 1;
        while (input[at] !== undefined && !isSpace(input[at]) && input[at] !== '/' && input[at] !== '>' && input[at] !== '=') at += 1;
        const attributeName = input.slice(nameStart, at);
        let after = at;
        while (isSpace(input[after])) after += 1;
        if (input[after] !== '=') {
            attributes.push({ name: attributeName, value: null });
            continue;
        }
        at = after + 1;
        while (isSpace(input[at])) at += 1;
        const quote = input[at];
        if (quote === '"' || quote === "'") {
            const close = input.indexOf(quote, at + 1);
            if (close < 0) return null;
            attributes.push({ name: attributeName, value: input.slice(at + 1, close) });
            at = close + 1;
        } else {
            const valueStart = at;
            while (input[at] !== undefined && !isSpace(input[at]) && input[at] !== '>') at += 1;
            attributes.push({ name: attributeName, value: input.slice(valueStart, at) });
        }
    }
}

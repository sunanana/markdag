// 線の下の文字の受け入れテストがページに入れる測り方 (window.edgeTextProbe)。例を書き起こした確認ページと同じ定義で測る。
// 測るのは計算済みのスタイルの欄と、図やノードに付く data 属性だけ。色は値を写さず、基準のノードの同じ部品と「同じ / 違う」で比べる。
// 地の不透明さ (地の色の α) は、依頼者が割合を値で決めたので値で見る。
// Playwright の addScriptTag でそのまま入れるため、TypeScript ではなく素の script にしてある (変換を通さない)
window.edgeTextProbe = (function createEdgeTextProbe() {
    // 部品の名前 → ノードの要素の中のセレクタ。詳細の部品のほかは、開いた詳細の中の要素を拾わない
    const PARTS = {
        本文: '.mdag-content',
        タスクの文字: '.mdag-task-label',
        印: '.mdag-task-label > svg',
        詳細: '.mdag-details',
        詳細のリンク: '.mdag-details a',
        詳細の入れ子の項目: '.mdag-details li li',
        タグ: '.mdag-tags',
        ラベル: '.mdag-labels',
        ラベルの絵文字: '.mdag-labels .mdag-emoji',
        リンク: '.mdag-content a',
        'リンクの中の code': '.mdag-content a code',
        code: '.mdag-content code',
        mark: '.mdag-content mark',
        'pre の中の code': '.mdag-content pre > code',
        打ち消し: '.mdag-content s',
        ins: '.mdag-content ins',
        '詳細の del': '.mdag-details del',
        '詳細の u': '.mdag-details u',
        絵文字: '.mdag-content .mdag-emoji',
        'code の中の絵文字': '.mdag-content :not(pre) > code .mdag-emoji',
        'mark の中の絵文字': '.mdag-content mark .mdag-emoji',
        'pre の中の絵文字': '.mdag-content pre .mdag-emoji',
        別名: '.mdag-icon[data-icon-kind="emoji"]',
        'ロゴ mono': '.mdag-icon[data-icon-color="mono"]',
        'ロゴ original': '.mdag-icon[data-icon-color="original"]',
        バッジ: '.mdag-badge',
        '◆': '.mdag-content::before',
        // 完了で opacity 0.35 にする部品の残り (F5-1)。詳細の印は詳細をノードの中に開かないときだけ出る。画像とチェックボックスは詳細に HTML で書いたもの
        色の帯: '.mdag-bands',
        詳細の印: '.mdag-note-mark',
        詳細の画像: '.mdag-details img',
        詳細のチェックボックス: '.mdag-details input',
    };
    const NODE_FIELDS = ['opacity', '薄く表示', '強調から外れた'];
    const PART_FIELDS = ['色', '地', '地の不透明さ', 'opacity', '文字の縁', 'paint-order', '影の縁', '線', '線の色'];
    // expect.<段階> の下でこの名前の項目は、ノードではなく図の要素 (.markdag) の欄を書く
    const DIAGRAM_KEY = '図';
    const DIAGRAM_FIELDS = ['線を選んでいる'];

    const alphaOf = (text) => (text === undefined ? 1 : text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text));
    const parseColor = (text) => {
        let match = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
        if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), alphaOf(match[4])];
        match = text.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
        if (match) return [Number(match[1]) * 255, Number(match[2]) * 255, Number(match[3]) * 255, alphaOf(match[4])];
        return null;
    };
    const sameColor = (a, b) => {
        const x = parseColor(a);
        const y = parseColor(b);
        if (!x || !y) return a === b;
        return x.every((value, index) => Math.abs(value - y[index]) <= (index === 3 ? 0.01 : 0.6));
    };
    // 数は小数の誤差を許し、ほかは文字として同じか
    const matches = (expected, actual) => {
        if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) <= 0.005;
        if (Array.isArray(expected) && Array.isArray(actual)) return JSON.stringify(expected) === JSON.stringify(actual);
        return String(expected) === String(actual);
    };
    const isTable = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

    // 描いた図の要素。screen は render に渡した #diagram (render がその要素に .markdag を付ける)、standalone は .mdag-standalone の中
    const root = () => {
        const container = document.getElementById('diagram');
        const found = container ? (container.querySelector('.markdag') ?? container) : (document.querySelector('.mdag-standalone .markdag') ?? document.querySelector('.mdag-standalone'));
        if (!found) throw new Error('図の要素 (.markdag) がない');
        return found;
    };

    // 図の背景の色 (--markdag-bg) を、図の要素の中に置いた要素の color で読む
    const background = () => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--markdag-bg)';
        root().append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
    };

    // 本文の文字 (改行と空白をまとめた textContent、詳細を除く) が needle で始まるノード。ちょうど 1 つでなければ誤り
    const node = (needle) => {
        const found = [...root().querySelectorAll('.mdag-node')].filter((element) => {
            const content = element.querySelector('.mdag-content');
            const clone = content?.cloneNode(true);
            clone?.querySelector('.mdag-details')?.remove();
            return (clone?.textContent ?? '').replace(/\s+/g, ' ').trim().startsWith(needle);
        });
        if (found.length !== 1) throw new Error(`本文が「${needle}」で始まるノードが ${found.length} 個ある (1 個のはず)`);
        return found[0];
    };

    const partElement = (owner, part) => {
        const selector = PARTS[part];
        if (selector === undefined) throw new Error(`知らない部品: ${part} (使える部品: ノード、${Object.keys(PARTS).join('、')})`);
        const [base, pseudo] = selector.split('::');
        const inDetails = part.startsWith('詳細');
        const element = [...owner.querySelectorAll(base)].find((candidate) => inDetails || candidate.closest('.mdag-details') === null);
        return element ? { element, pseudo: pseudo ? `::${pseudo}` : null } : null;
    };

    const colorName = (value, bg) => {
        if (sameColor(value, bg)) return '背景';
        const parsed = parseColor(value);
        if (parsed && parsed[3] === 0) return '透明';
        return `その他 (${value})`;
    };

    const nodeFields = (element) => ({
        opacity: Number(getComputedStyle(element).opacity),
        薄く表示: element.hasAttribute('data-dimmed'),
        強調から外れた: element.hasAttribute('data-faded'),
    });

    const diagramFields = () => ({ 線を選んでいる: root().hasAttribute('data-edge-selected') });

    const partFields = (owner, part, reference) => {
        const found = partElement(owner, part);
        if (!found) return null;
        const bg = background();
        const style = getComputedStyle(found.element, found.pseudo);
        const filter = style.filter;
        const shadows = filter === 'none' ? [] : filter.match(/drop-shadow\([^()]*(?:\([^()]*\)[^()]*)*\)/g) ?? [];
        const shadowColors = shadows.map((shadow) => shadow.match(/(?:rgba?|color)\([^()]*\)/)?.[0] ?? '');
        let color = '基準なし';
        let ground = '基準なし';
        const refFound = reference ? partElement(reference, part) : null;
        if (refFound) {
            const refStyle = getComputedStyle(refFound.element, refFound.pseudo);
            color = sameColor(style.color, refStyle.color) ? '同じ' : '違う';
            ground = sameColor(style.backgroundColor, refStyle.backgroundColor) ? '同じ' : '違う';
        }
        const groundColor = parseColor(style.backgroundColor);
        return {
            色: color,
            地: ground,
            地の不透明さ: groundColor ? Math.round(groundColor[3] * 1000) / 1000 : `その他 (${style.backgroundColor})`,
            opacity: Number(style.opacity),
            文字の縁: `${style.webkitTextStrokeWidth} ${colorName(style.webkitTextStrokeColor, bg)}`,
            'paint-order': style.paintOrder,
            影の縁: shadows.length === 0 ? (filter === 'none' ? 'なし' : `その他 (${filter})`) : `drop-shadow ${shadows.length} ${shadowColors.every((c) => sameColor(c, bg)) ? '背景' : '背景以外'}`,
            線: style.textDecorationLine,
            線の色: sameColor(style.textDecorationColor, style.color) ? '文字の色' : colorName(style.textDecorationColor, bg),
        };
    };

    // 段階 1 つ分の期待 (expect.<段階>) を測り、欄ごとの行 (期待、実際、一致) を返す
    const measure = (step, expected, defaultReference) => {
        if (!isTable(expected)) throw new Error(`expect に段階「${step}」がない`);
        const rows = [];
        for (const [needle, parts] of Object.entries(expected)) {
            if (!isTable(parts)) throw new Error(`expect.${step}.${needle} は部品の表で書く`);
            if (needle === DIAGRAM_KEY) {
                const actualAll = diagramFields();
                for (const [field, value] of Object.entries(parts)) {
                    const known = DIAGRAM_FIELDS.includes(field);
                    const actual = known ? actualAll[field] : `知らない欄 (使える欄: ${DIAGRAM_FIELDS.join('、')})`;
                    rows.push({ step, node: DIAGRAM_KEY, part: '', field, expected: value, actual, match: known && matches(value, actual) });
                }
                continue;
            }
            const owner = node(needle);
            const refNeedle = typeof parts.reference === 'string' ? parts.reference : defaultReference;
            const reference = refNeedle ? node(refNeedle) : null;
            for (const [part, fields] of Object.entries(parts)) {
                if (part === 'reference') continue;
                if (!isTable(fields)) throw new Error(`expect.${step}.${needle}.${part} は欄の表で書く`);
                const allowed = part === 'ノード' ? NODE_FIELDS : PART_FIELDS;
                const actualAll = part === 'ノード' ? nodeFields(owner) : partFields(owner, part, reference);
                for (const [field, value] of Object.entries(fields)) {
                    const known = allowed.includes(field);
                    const actual = !known ? `知らない欄 (使える欄: ${allowed.join('、')})` : actualAll === null ? '部品なし' : actualAll[field];
                    rows.push({ step, node: needle, part, field, expected: value, actual, match: known && actualAll !== null && matches(value, actual) });
                }
            }
        }
        return rows;
    };

    // ポインタを置く点 (ページの座標)。リンクの上で :hover の色が変わらないよう、箱の左端寄りを指す
    const point = (needle) => {
        const rect = node(needle).querySelector('.mdag-box').getBoundingClientRect();
        return { x: rect.left + 3, y: rect.top + rect.height / 2 };
    };

    const hovered = (needle) => node(needle).matches(':hover');

    // 線 (relations の線の当たりの帯) を、両端のノードの本文で選んでクリックする
    const clickEdge = (text) => {
        const [from, to] = text.split('-->').map((side) => side.trim());
        if (!from || !to) throw new Error(`click_edge は「元 --> 先」で書く: ${text}`);
        const source = node(from).dataset.id;
        const target = node(to).dataset.id;
        const hit = [...root().querySelectorAll('path.mdag-edge-hit')].find((path) => (path.dataset.key ?? '').endsWith(`:${source}>${target}`));
        if (!hit) throw new Error(`線がない: ${text} (${source} > ${target})`);
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
    };

    return { measure, matches, point, hovered, clickEdge };
})();

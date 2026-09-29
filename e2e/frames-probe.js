// グループの枠の受け入れテストがページに入れる測り方 (window.framesProbe)。例を書き起こした道具と同じ定義で測る。
// library は図の座標 (rect.mdag-frame の属性と onLayout の rects)、screen と standalone は画面の px (getBoundingClientRect)。
// 枠のメンバーは公開面から導く: 枠のグループ (rect の data-group) を buildModel の groupsOf に持つ、見えているノードのうち、枠の矩形に重なるもの。
// Playwright の addScriptTag でそのまま入れるため、TypeScript ではなく素の script にしてある (変換を通さない)
window.framesProbe = (function createFramesProbe() {
    const TOLERANCE = 0.5;
    const overlaps = (a, b) => a.left < b.right - TOLERANCE && b.left < a.right - TOLERANCE && a.top < b.bottom - TOLERANCE && b.top < a.bottom - TOLERANCE;
    const inside = (a, b) => a.left >= b.left - TOLERANCE && a.top >= b.top - TOLERANCE && a.right <= b.right + TOLERANCE && a.bottom <= b.bottom + TOLERANCE;
    const box = (x, y, width, height) => ({ left: x, top: y, right: x + width, bottom: y + height });
    const side = (r, f) => {
        if (overlaps(r, f)) return '中';
        if (r.left >= f.right - TOLERANCE) return '右';
        if (r.right <= f.left + TOLERANCE) return '左';
        if (r.top >= f.bottom - TOLERANCE) return '下';
        return '上';
    };
    // 名前は refText。同じ refText が 2 つ以上あれば「親/子」
    const namer = (parsed) => {
        const count = new Map();
        for (const node of parsed.nodes) count.set(node.refText, (count.get(node.refText) ?? 0) + 1);
        const byId = new Map(parsed.nodes.map((node) => [node.id, node]));
        const name = (id) => {
            const node = byId.get(id);
            if (!node) return `#${id}`;
            if (count.get(node.refText) === 1) return node.refText;
            const parent = byId.get(node.parent);
            return parent ? `${parent.refText}/${node.refText}` : node.refText;
        };
        const idOf = (text) => parsed.nodes.find((node) => name(node.id) === text)?.id;
        return { name, idOf };
    };
    const diagnosticsOf = (list) =>
        list.map((item) => ({ code: item.code, severity: item.severity, at: item.at ? `${item.at.line}:${item.at.column}+${item.at.length}` : null, message: item.message }));

    const round = (value) => Math.round(value * 100) / 100;

    // frames: [{ group, box }]、nodes: [{ id, box }]。メンバー、入れ子、重なり、入り込みを出す
    // unit は図の座標 1 あたりの長さ (library は 1、screen と standalone は画面の倍率)。edges と clearance は図の座標に直して出す
    const analyze = (frames, nodes, model, name, withSides, unit = 1) => {
        const groupsOf = (id) => model.groupsOf.get(id) ?? [];
        // メンバーは文書の順 (id の昇順)。枠はグループの定義の順、同じグループの中は最初のメンバーの順に並べる (描いた要素の順に左右されない)
        nodes = [...nodes].sort((a, b) => a.id - b.id);
        const groupOrder = model.groups.map((group) => group.id);
        const described = frames.map((frame) => {
            const members = nodes.filter((node) => groupsOf(node.id).includes(frame.group) && overlaps(node.box, frame.box)).map((node) => node.id);
            return { ...frame, members };
        });
        described.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || (a.members[0] ?? 0) - (b.members[0] ?? 0));
        // 同じグループの枠が 2 つ以上あれば `グループ[最初のメンバー]` (sides と同じ呼び方)
        const keyOf = (frame) => (described.filter((f) => f.group === frame.group).length > 1 ? `${frame.group}[${name(frame.members[0])}]` : frame.group);
        const out = described.map((frame) => ({
            group: frame.group,
            members: frame.members.map(name),
            inside: described.filter((other) => other !== frame && inside(frame.box, other.box) && !inside(other.box, frame.box)).map((other) => other.group),
        }));
        let intrusions = 0;
        const intruders = [];
        for (const frame of described) {
            for (const node of nodes) {
                if (groupsOf(node.id).includes(frame.group)) continue;
                if (overlaps(node.box, frame.box)) {
                    intrusions += 1;
                    intruders.push(`${name(node.id)}→${frame.group}`);
                }
            }
        }
        let disjoint = 0;
        let crossing = 0;
        const pairs = [];
        // 交差する組 (crossing) ごとに、後の枠 (frame) の左右の辺が先の枠 (against) の辺からどれだけずれたか
        const edges = [];
        for (let i = 0; i < described.length; i += 1) {
            for (let j = i + 1; j < described.length; j += 1) {
                const a = described[i];
                const b = described[j];
                if (!overlaps(a.box, b.box) || inside(a.box, b.box) || inside(b.box, a.box)) continue;
                const shared = a.members.some((id) => b.members.includes(id));
                if (shared) {
                    crossing += 1;
                    edges.push({ frame: keyOf(b), against: keyOf(a), left: round((b.box.left - a.box.left) / unit), right: round((b.box.right - a.box.right) / unit) });
                } else disjoint += 1;
                pairs.push(`${a.group}×${b.group}(${shared ? '共有' : '交わらない'})`);
            }
        }
        const boundaryGroups = model.groups.filter((group) => group.boundary).map((group) => group.id);
        const unframed = {};
        for (const group of boundaryGroups) {
            const left = nodes.filter((node) => groupsOf(node.id).includes(group) && !described.some((frame) => frame.group === group && frame.members.includes(node.id)));
            if (left.length > 0) unframed[group] = left.map((node) => name(node.id));
        }
        const result = { frames: out, unframed, overlap: { disjoint, crossing }, intrusions, edges };
        if (pairs.length > 0) result.crossing_pairs = pairs;
        if (intruders.length > 0) result.intruders = intruders;
        if (withSides) {
            const sides = {};
            // clearance: ノードの箱と、メンバーでない枠の辺の間の空き (右: ノードの左の端 − 枠の右の辺、ほかの向きも同じく外向きを正)
            const clearance = {};
            for (const node of nodes) {
                const entry = {};
                const gaps = {};
                for (const frame of described) {
                    // その枠のメンバーだけを除く (同じグループの別の枠に対する位置も出す)
                    if (frame.members.includes(node.id)) continue;
                    const key = keyOf(frame);
                    entry[key] = side(node.box, frame.box);
                    gaps[key] = {
                        right: round((node.box.left - frame.box.right) / unit),
                        left: round((frame.box.left - node.box.right) / unit),
                        below: round((node.box.top - frame.box.bottom) / unit),
                        above: round((frame.box.top - node.box.bottom) / unit),
                    };
                }
                if (Object.keys(entry).length > 0) {
                    sides[name(node.id)] = entry;
                    clearance[name(node.id)] = gaps;
                }
            }
            result.sides = sides;
            result.clearance = clearance;
        }
        return result;
    };

    // 図の座標: rect.mdag-frame の属性と onLayout の rects
    const measureLibrary = (element, snapshot, model, name) => {
        const frames = [...element.querySelectorAll('rect.mdag-frame')].map((rect) => ({
            group: rect.dataset.group ?? '',
            box: box(Number(rect.getAttribute('x')), Number(rect.getAttribute('y')), Number(rect.getAttribute('width')), Number(rect.getAttribute('height'))),
        }));
        const nodes = [...snapshot.rects].filter(([, r]) => r.width > 0 && r.height > 0).map(([id, r]) => ({ id, box: box(r.x, r.y, r.width, r.height) }));
        return { visible: nodes.length, ...analyze(frames, nodes, model, name, true) };
    };

    // 画面の px: getBoundingClientRect。ラベルは文字のインクの範囲 (e2e/frames-large.spec.ts と同じ測り方)
    const measureScreen = (element, model, name) => {
        const context = document.createElement('canvas').getContext('2d');
        const frames = [...element.querySelectorAll('rect.mdag-frame')]
            .map((rect) => ({ group: rect.dataset.group ?? '', box: rect.getBoundingClientRect() }))
            .filter((frame) => frame.box.right > frame.box.left);
        const labels = [...element.querySelectorAll('text.mdag-frame-label')].map((label) => {
            // 単体 HTML を iframe で開いたときは、その文書の窓の getComputedStyle で読む
            const style = (label.ownerDocument.defaultView ?? window).getComputedStyle(label);
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const metrics = context.measureText(label.textContent ?? '');
            const r = label.getBoundingClientRect();
            const matrix = label.getScreenCTM();
            const baseline = matrix.f + Number(label.getAttribute('y')) * matrix.d;
            return { group: label.dataset.group ?? '', box: { left: r.left, right: r.right, top: baseline - metrics.actualBoundingBoxAscent * matrix.d, bottom: baseline + metrics.actualBoundingBoxDescent * matrix.d } };
        });
        const nodes = [...element.querySelectorAll('.mdag-node')]
            .map((node) => ({ id: Number(node.dataset.id), box: node.querySelector('.mdag-box').getBoundingClientRect() }))
            .filter((node) => node.box.right > node.box.left && node.box.bottom > node.box.top);
        // 図の座標 1 あたりの画面の px (枠の rect の変換の倍率。枠がなければ 1)
        const firstFrame = element.querySelector('rect.mdag-frame');
        const unit = firstFrame?.getScreenCTM()?.a ?? 1;
        const result = analyze(frames, nodes, model, name, true, unit);
        const on_node = [];
        const crosses_frame = [];
        const on_label = [];
        const wider_than_frame = [];
        const beyond_members = [];
        labels.forEach((label, index) => {
            for (const node of nodes) if (overlaps(node.box, label.box)) on_node.push(`${label.group}:${name(node.id)}`);
            for (const frame of frames) if (frame.group !== label.group && overlaps(label.box, frame.box) && !inside(label.box, frame.box)) crosses_frame.push(`${label.group}:${frame.group}`);
            for (const other of labels.slice(index + 1)) if (overlaps(label.box, other.box)) on_label.push(`${label.group}:${other.group}`);
            const own = frames[index];
            if (own && label.box.right > own.box.right + TOLERANCE) wider_than_frame.push(label.group);
            // ラベルの右端が、その枠のメンバーの箱の右端より右にある (枠がラベルのぶん広がっている)
            const memberBoxes = own ? nodes.filter((node) => (model.groupsOf.get(node.id) ?? []).includes(own.group) && overlaps(node.box, own.box)).map((node) => node.box.right) : [];
            if (memberBoxes.length > 0 && label.box.right > Math.max(...memberBoxes) + TOLERANCE) beyond_members.push(label.group);
        });
        return { visible: nodes.length, ...result, labels: { count: labels.length, on_node, crosses_frame, on_label, wider_than_frame, beyond_members } };
    };

    return { namer, diagnosticsOf, measureLibrary, measureScreen };
})();

// 規則 (markdag.rules) が止めているものを、見た目でも分かるようにするフック。
// markdag はこのファイルを読み込まない。読み込んで render に渡すのは呼び出し側 (アプリか npm run check -- --hooks)。
// 予約された名前で export した関数だけが呼ばれる。

// そのノード自身と祖先に入ってくる線をさかのぼって、終わっていないタスクを集める。
// upstream がたどるのは relations の線だけなので、線が親 (見出し) に引かれている場合、
// 配下の項目から見るには祖先の分も見る必要がある
/**
 * @param {import('markdag').HookDocument} doc
 * @param {import('markdag').HookNode} node
 * @returns {import('markdag').HookNode[]}
 */
function blockersOf(doc, node) {
    const found = new Map();
    for (let current = node; current !== null; current = current.parent === null ? null : doc.node(current.parent)) {
        for (const upstream of doc.upstream(current.id, { transitive: true })) {
            if (upstream.task !== null && !upstream.task.checked) found.set(upstream.id, upstream);
        }
    }
    return [...found.values()];
}

/** @type {import('markdag').HookModule['decorateNode']} */
export function decorateNode(ctx) {
    if (ctx.node.task === null || ctx.node.task.checked) return;
    const blockers = blockersOf(ctx.doc, ctx.node);
    if (blockers.length === 0) return;
    return { className: 'waiting', badge: '待ち', title: `先に終えるもの: ${blockers.map((node) => node.text).join('、')}` };
}

/** @type {import('markdag').HookModule['onTaskToggle']} */
export function onTaskToggle(ctx) {
    const tasks = ctx.doc.nodes().filter((node) => node.task !== null);
    console.log(`[task-guard] ${tasks.filter((node) => node.task?.checked).length}/${tasks.length} 完了`);
}

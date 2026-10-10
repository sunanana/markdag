// 編集の層のボタンの絵 (道具箱、操作の帯、凡例のパネル、ノードの左のチェック)。どれも 24 四方の座標の線画で、色と線の太さは見た目の側で決める
// (矢尻のように塗る所だけ、塗りを文字の色 (currentColor) にする)。
// 絵は要素を組み立てて作る (文字列の HTML を差し込まない)
type Shape = readonly ['path' | 'rect' | 'circle', Readonly<Record<string, string>>];

// 編集の層が組み立てる SVG の要素の名前空間
export const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_BOX = '0 0 24 24';

// 詳細の絵の上の箱。詳細表示と詳細編集で同じ箱を使う
const DETAILS_BOX = ['rect', { x: '3', y: '2.5', width: '18', height: '6.5', rx: '2' }] as const satisfies Shape;

const ICONS = {
    select: [['path', { d: 'M5 3l14 8-6 1.5L10 19z' }]],
    pan: [['path', { d: 'M8 12V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L3.5 13a1.5 1.5 0 012.3-1.9L8 13' }]],
    // 戻るは、U を左に倒した形 (上の辺が右で丸く折り返して下の辺へ戻る) の上の辺の左端に、左向きの塗りの三角。進むはその左右反転
    undo: [
        ['path', { d: 'M8 6.5h7a5.5 5.5 0 010 11H6' }],
        ['path', { d: 'M3.5 6.5L8.5 3v7z', fill: 'currentColor' }],
    ],
    redo: [
        ['path', { d: 'M8 6.5h7a5.5 5.5 0 010 11H6', transform: 'matrix(-1 0 0 1 24 0)' }],
        ['path', { d: 'M3.5 6.5L8.5 3v7z', fill: 'currentColor', transform: 'matrix(-1 0 0 1 24 0)' }],
    ],
    fit: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    rename: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }]],
    // 子の追加は箱の右に +、兄弟追加は箱の下に同じ大きさの + (どちらも + を丸で囲まない)
    child: [
        ['rect', { x: '2', y: '8', width: '8', height: '8', rx: '2' }],
        ['path', { d: 'M16.5 8.5V15.5M13 12H20' }],
    ],
    sibling: [
        ['rect', { x: '5', y: '4', width: '14', height: '6', rx: '1.5' }],
        ['path', { d: 'M12 13v7M8.5 16.5h7' }],
    ],
    trash: [['path', { d: 'M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13' }]],
    chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
    group: [
        ['rect', { x: '3', y: '5', width: '18', height: '15', rx: '2', 'stroke-dasharray': '3 2.5' }],
        ['rect', { x: '6.5', y: '9', width: '6', height: '4', rx: '1' }],
        ['rect', { x: '11.5', y: '14', width: '6', height: '3.5', rx: '1' }],
    ],
    ungroup: [
        ['rect', { x: '3', y: '5', width: '18', height: '15', rx: '2', 'stroke-dasharray': '3 2.5' }],
        ['path', { d: 'M8 9l8 7M16 9l-8 7' }],
    ],
    // タスク化は角を丸めた四角にチェック。タスク解除はタスク化と同じ四角とチェックを両方破線にした形 (× は削除に見えるので使わない。
    // チェックが実線のノードの左のチェックとは、チェックの線で見分ける)
    task: [
        ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3.5' }],
        ['path', { d: 'M7.5 12.5l3 3 6-7' }],
    ],
    untask: [
        ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3.5', 'stroke-dasharray': '3 2.5' }],
        ['path', { d: 'M7.5 12.5l3 3 6-7', 'stroke-dasharray': '2 2.2' }],
    ],
    // ノードの左のチェック。タスク化の絵の四角を破線にした形 (押すとそこにタスクの印が付く)
    taskCheck: [
        ['rect', { x: '3.5', y: '3.5', width: '17', height: '17', rx: '3.5', 'stroke-dasharray': '3 2.5' }],
        ['path', { d: 'M7.5 12.5l3 3 6-7' }],
    ],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    tag: [
        ['path', { d: 'M3 12V4h8l10 10-8 8z' }],
        ['circle', { cx: '7.5', cy: '8.5', r: '1.4' }],
        ['path', { d: 'M15 3v4M13 5h4' }],
    ],
    tags: [
        ['path', { d: 'M3 11V4h7l9 9-7 7z' }],
        ['circle', { cx: '7', cy: '8', r: '1.3' }],
        ['path', { d: 'M13 4l9 9-6 6' }],
    ],
    // 詳細: 上に角を丸めた箱、その下に左の縦線と横線 3 本 (3 本めが短い)。詳細編集はその右下に名前の鉛筆を半分にして重ね、鉛筆にかかる横線を短くする
    details: [DETAILS_BOX, ['path', { d: 'M5 12.5V20.5M8.5 12.5H20.5M8.5 16.5H20.5M8.5 20.5H15' }]],
    detailsEdit: [
        DETAILS_BOX,
        ['path', { d: 'M5 12.5V20.5M8.5 12.5H20.5M8.5 16.5H15.5M8.5 20.5H12' }],
        ['path', { d: 'M14.5 22L16.5 22L22 16.5L20 14.5L14.5 20Z' }],
    ],
    eyeOff: [
        ['path', { d: 'M3 3l18 18' }],
        ['path', { d: 'M10.6 5.1A10.8 10.8 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4' }],
        ['path', { d: 'M9.9 9.9a3 3 0 004.2 4.2' }],
    ],
    eye: [
        ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }],
        ['circle', { cx: '12', cy: '12', r: '3' }],
    ],
    // 合流: 左の 2 つの箱から右へ伸びた線が、図の線と同じ柔らかい曲線で 1 本に合わさり、右の箱へつながる
    join: [
        ['rect', { x: '2', y: '3.5', width: '6', height: '4.5', rx: '1' }],
        ['rect', { x: '2', y: '16', width: '6', height: '4.5', rx: '1' }],
        ['path', { d: 'M8 5.75C11.5 5.75 11 12 14.5 12M8 18.25C11.5 18.25 11 12 14.5 12H16' }],
        ['rect', { x: '16', y: '9', width: '6', height: '6', rx: '1.5' }],
    ],
    merge: [
        ['path', { d: 'M3 5c6 0 7 7 12 7M3 19c6 0 7-7 12-7' }],
        ['rect', { x: '15', y: '9', width: '6', height: '6', rx: '1.5' }],
    ],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;

// 絵の要素を新しく作る (同じ絵を 2 か所に置くときは 2 度呼ぶ)。読み上げでは名前の文字に任せるので隠す
export function createIcon(name: IconName): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', VIEW_BOX);
    svg.setAttribute('class', 'mdag-editor-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tag, attributes] of ICONS[name] as readonly Shape[]) {
        const shape = document.createElementNS(SVG_NS, tag);
        for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
        svg.append(shape);
    }
    return svg;
}

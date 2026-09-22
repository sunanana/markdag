// 射影と配置に渡す入力の形。折りたたみの前のモデル全体と、閉じているノードの一覧を持つ。
// 見えているグラフへの射影 (代表ノードと代理エッジ) は、入力を受け取る側で行う。

export type RelationKind = 'fork' | 'join' | 'chain' | 'depends';

export interface LayoutInputNode {
    // 文書順 (深さ優先の先行順) の連番。ルートが 1
    id: number;
    label: string;
    // ノード本体の大きさ。余白や線の太さは含まない
    width: number;
    height: number;
    // Markdown に書かれた、そのノード自身のグループ (継承は解決していない)
    groups: string[];
}

export interface LayoutInputEdge {
    source: number;
    target: number;
}

export interface LayoutInputRelation extends LayoutInputEdge {
    kind: RelationKind;
    // 展開する前の relations の記述。1 つの記述から複数のエッジが生まれる場合は同じ値になる
    origin: string;
}

export interface LayoutInput {
    name: string;
    // 文書順に並ぶ。兄弟の並びはこの順で決まる
    nodes: LayoutInputNode[];
    // Markdown のツリーの親子
    treeEdges: LayoutInputEdge[];
    relations: LayoutInputRelation[];
    // ルートからの線を抑制するトップレベルノード
    suppressRootLine: number[];
    // 閉じているノード。配下は見えているグラフから外れる
    folded: number[];
}

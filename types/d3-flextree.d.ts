// d3-flextree は型定義を同梱していないため、このプロジェクトで使う範囲の API だけを宣言する。
// x は兄弟方向、y は深さ方向。size は [兄弟方向の大きさ, 深さ方向の大きさ]。
declare module 'd3-flextree' {
    export interface FlexTreeExtents {
        top: number;
        bottom: number;
        left: number;
        right: number;
    }

    // 葉の children は undefined ではなく null になる (d3-hierarchy の HierarchyNode と違う点)
    export interface FlexTreeNode<Datum> {
        data: Datum;
        parent: FlexTreeNode<Datum> | null;
        children: FlexTreeNode<Datum>[] | null;
        depth: number;
        height: number;
        x: number;
        y: number;
        readonly size: [number, number];
        readonly xSize: number;
        readonly ySize: number;
        readonly top: number;
        readonly bottom: number;
        readonly left: number;
        readonly right: number;
        readonly extents: FlexTreeExtents;
        readonly nodeExtents: FlexTreeExtents;
        readonly nodes: FlexTreeNode<Datum>[];
        readonly hasChildren: boolean;
        readonly noChildren: boolean;
        each(callback: (node: FlexTreeNode<Datum>) => void): this;
        eachBefore(callback: (node: FlexTreeNode<Datum>) => void): this;
        eachAfter(callback: (node: FlexTreeNode<Datum>) => void): this;
        descendants(): FlexTreeNode<Datum>[];
        ancestors(): FlexTreeNode<Datum>[];
        leaves(): FlexTreeNode<Datum>[];
        links(): Array<{ source: FlexTreeNode<Datum>; target: FlexTreeNode<Datum> }>;
    }

    export type FlexTreeNodeSize<Datum> =
        | [number, number]
        | ((node: FlexTreeNode<Datum>) => [number, number]);

    export type FlexTreeSpacing<Datum> =
        | number
        | ((a: FlexTreeNode<Datum>, b: FlexTreeNode<Datum>) => number);

    export interface FlexTreeOptions<Datum> {
        children?: (data: Datum) => Datum[] | null | undefined;
        nodeSize?: FlexTreeNodeSize<Datum>;
        spacing?: FlexTreeSpacing<Datum>;
    }

    export interface FlexTreeLayout<Datum> {
        (tree: FlexTreeNode<Datum>): FlexTreeNode<Datum>;
        nodeSize(): FlexTreeNodeSize<Datum>;
        nodeSize(size: FlexTreeNodeSize<Datum>): this;
        spacing(): FlexTreeSpacing<Datum>;
        spacing(spacing: FlexTreeSpacing<Datum>): this;
        children(): (data: Datum) => Datum[] | null | undefined;
        children(children: (data: Datum) => Datum[] | null | undefined): this;
        hierarchy(
            data: Datum,
            children?: (data: Datum) => Datum[] | null | undefined,
        ): FlexTreeNode<Datum>;
        dump(tree: FlexTreeNode<Datum>): string;
    }

    export function flextree<Datum>(options?: FlexTreeOptions<Datum>): FlexTreeLayout<Datum>;
    export namespace flextree {
        const version: string;
    }
}

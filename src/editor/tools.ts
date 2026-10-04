// GUI 編集の道具 (DOM を使わない)。今の道具と、Space を押しているかと、合流先を選ぶ途中かを持ち、何もないところのドラッグでパンするボタンを決める。
// 手のひらは主ボタンと中ボタン、選択と合流先を選ぶ途中は中ボタンだけ、Space を押している間は両方でパンする。
// 選択の道具で Space を押していない間だけ、何もないところの主ボタンのドラッグを矩形選択に、ノードの主ボタンのドラッグを付け替えに、
// 点のドラッグを線を引くか合流させるドラッグにする。
// 合流先を選ぶ途中は道具の上に重なる一時の状態で、終わると選んでいた道具 (もとの道具) に戻る。合流させる始点は呼ぶ側が持つ。
// 最初の道具は選択。閲覧では道具を使わない (パンのボタンは図の既定) ので、閲覧へ切り替えるときは最初の道具に戻し、合流先を選ぶ途中もやめる
import type { DragToPan } from '../core';

export type EditorTool = 'hand' | 'select';

// 図の要素の目印と案内に出す道具の状態。join-target は合流先を選ぶ途中
export type ToolState = EditorTool | 'join-target';

export const DEFAULT_TOOL: EditorTool = 'select';

export class Tools {
    private current: EditorTool = DEFAULT_TOOL;
    // Space を押している間 (キーを離すか、ウィンドウのフォーカスが外れるまで)
    private spaceHeld = false;
    private joiningTarget = false;

    // 道具か Space の押下か合流先を選ぶ途中かが変わったときに呼ぶ
    constructor(private readonly onChange: () => void) {}

    // 選んでいる道具 (合流先を選ぶ途中は、終わったあとに戻る道具)
    get tool(): EditorTool {
        return this.current;
    }

    get state(): ToolState {
        return this.joiningTarget ? 'join-target' : this.current;
    }

    // 合流先を選ぶ途中か
    get joining(): boolean {
        return this.joiningTarget;
    }

    get dragToPan(): DragToPan {
        if (this.spaceHeld) return 'both';
        return this.current === 'hand' && !this.joiningTarget ? 'both' : 'middle';
    }

    // 選択の道具のドラッグ (何もないところからの矩形選択、ノードからの付け替え、点からの線と合流) が効くか
    // (選択の道具で、Space を押しておらず、合流先を選ぶ途中でないとき)
    get selectDrag(): boolean {
        return this.current === 'select' && !this.spaceHeld && !this.joiningTarget;
    }

    // 道具を替える (合流先を選ぶ途中ならやめる)
    pick(tool: EditorTool): void {
        this.set(tool, this.spaceHeld, false);
    }

    holdSpace(): void {
        this.set(this.current, true, this.joiningTarget);
    }

    releaseSpace(): void {
        this.set(this.current, false, this.joiningTarget);
    }

    // 合流先を選ぶ途中にする
    startJoin(): void {
        this.set(this.current, this.spaceHeld, true);
    }

    // 合流先を選ぶ途中をやめて、もとの道具に戻る
    endJoin(): void {
        this.set(this.current, this.spaceHeld, false);
    }

    // 最初の道具に戻し、Space の押下と合流先を選ぶ途中も解く
    reset(): void {
        this.set(DEFAULT_TOOL, false, false);
    }

    private set(tool: EditorTool, spaceHeld: boolean, joining: boolean): void {
        if (tool === this.current && spaceHeld === this.spaceHeld && joining === this.joiningTarget) return;
        this.current = tool;
        this.spaceHeld = spaceHeld;
        this.joiningTarget = joining;
        this.onChange();
    }
}

// GUI 編集の道具 (DOM を使わない)。今の道具と、Space を押しているかと、合流先を選ぶ途中かを持ち、何もないところのドラッグでパンするボタンを決める。
// Space を押してから、ポインタもほかのキーも押さずに離したか (選んだタスクの印を進める押し方) も持つ。Shift を押したまま押した Space、
// 押したままの繰り返しで初めて受けた Space、合流先を選ぶ途中の Space は、この押し方にしない (図を動かすだけ)。
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
    // Space を押してから、ポインタもほかのキーも押していないか。道具の見た目は変えないので onChange は呼ばない
    private spaceTap = false;
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

    // Space を押した。押していなかったときだけ、押して離す押し方の途中にする (押し続けたときの 2 回目の押下では始め直さない)。
    // Shift を押したまま押した Space は、押して離す押し方にしない (Space を先に押してから Shift を押したときと同じ。押す順によらない)。
    // 押したままの繰り返し (repeat) で初めて受けた Space も、押して離す押し方にしない (最初の押下を図の外で押している)
    holdSpace(input?: { shiftKey: boolean; repeat?: boolean }): void {
        if (!this.spaceHeld) this.spaceTap = !(input?.shiftKey ?? false) && !(input?.repeat ?? false);
        this.set(this.current, true, this.joiningTarget);
    }

    // Space を押している間にポインタかほかのキー (Shift などの修飾キーも) を押した (離してもタスクの印を進めない)。
    // ポインタを押さずに動かしただけでは呼ばない
    interruptSpace(): void {
        this.spaceTap = false;
    }

    // Space を離した (ウィンドウのフォーカスが外れたときも呼ぶ)。押してから、ポインタもほかのキーも押さずに離したら true。
    // 合流先を選ぶ途中は、Space は図を動かすだけなので false
    releaseSpace(): boolean {
        const tapped = this.spaceHeld && this.spaceTap && !this.joiningTarget;
        this.spaceTap = false;
        this.set(this.current, false, this.joiningTarget);
        return tapped;
    }

    // 合流先を選ぶ途中にする
    startJoin(): void {
        this.set(this.current, this.spaceHeld, true);
    }

    // 合流先を選ぶ途中をやめて、もとの道具に戻る
    endJoin(): void {
        this.set(this.current, this.spaceHeld, false);
    }

    // 最初の道具に戻し、Space の押下 (押して離す押し方の途中も) と合流先を選ぶ途中も解く
    reset(): void {
        this.spaceTap = false;
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

// GUI 編集の道具 (DOM を使わない部品) を、道具の状態と Space の押下の遷移ごとに確かめる。
// 道具は選択と手のひら、合流先を選ぶ途中は道具に重なる一時の状態で、終わるともとの道具に戻る。最初の道具は選択。
// パンのボタン: 手のひら both、選択 middle、Space を押している間 both、合流先を選ぶ途中 middle (Space を押していれば both)。
// 選択の道具のドラッグ (矩形選択、付け替え、線と合流) は、選択の道具で Space を押しておらず、合流先を選ぶ途中でないときだけ。
// 状態が変わったときだけ知らせる
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL, Tools } from '../src/editor/tools';

function tools(): { tools: Tools; changes: () => number } {
    let count = 0;
    const subject = new Tools(() => {
        count += 1;
    });
    return { tools: subject, changes: () => count };
}

function snapshot(subject: Tools): { tool: string; state: string; joining: boolean; dragToPan: string; selectDrag: boolean } {
    return { tool: subject.tool, state: subject.state, joining: subject.joining, dragToPan: subject.dragToPan, selectDrag: subject.selectDrag };
}

describe('最初の道具 (B-078、触る F-04)', () => {
    it('最初は選択の道具で、パンは中ボタンだけ。選択の道具のドラッグが効く', () => {
        const { tools: subject, changes } = tools();
        expect(DEFAULT_TOOL).toBe('select');
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        expect(changes()).toBe(0);
    });
});

describe('道具を替える (軸 B の b1、b2、b4、b5)', () => {
    it('手のひらは主ボタンでもパンし、選択の道具のドラッグは効かない (B1.b2、B1.b4)', () => {
        const { tools: subject, changes } = tools();
        subject.pick('hand');
        expect(snapshot(subject)).toEqual({ tool: 'hand', state: 'hand', joining: false, dragToPan: 'both', selectDrag: false });
        expect(changes()).toBe(1);
        subject.pick('select');
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        expect(changes()).toBe(2);
    });

    it('今の道具を選び直しても何も変わらず、知らせない (B1.b1、B2.b2)', () => {
        const { tools: subject, changes } = tools();
        subject.pick('select');
        expect(changes()).toBe(0);
        subject.pick('hand');
        subject.pick('hand');
        expect(changes()).toBe(1);
    });
});

describe('Space の押下 (表 S、B-073)', () => {
    it('選択の道具で Space を押している間は主ボタンでもパンし、矩形選択にしない。離すと戻る (S1.s1、S2.s7、S2.s3)', () => {
        const { tools: subject, changes } = tools();
        subject.holdSpace();
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'both', selectDrag: false });
        subject.releaseSpace();
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        expect(changes()).toBe(2);
    });

    it('押し続けたときの 2 回目の押下と、押していないときの離しは何も変えない (S2.s1、S1.s3)', () => {
        const { tools: subject, changes } = tools();
        subject.releaseSpace();
        expect(changes()).toBe(0);
        subject.holdSpace();
        subject.holdSpace();
        expect(changes()).toBe(1);
        expect(subject.dragToPan).toBe('both');
    });

    it('手のひらで Space を押しても離しても、パンのボタンは both のまま (B2.b8)', () => {
        const { tools: subject } = tools();
        subject.pick('hand');
        subject.holdSpace();
        expect(subject.dragToPan).toBe('both');
        subject.releaseSpace();
        expect(subject.dragToPan).toBe('both');
        expect(subject.tool).toBe('hand');
    });

    it('Space を押している間に道具を替えても、離すまで both (S2.s5)', () => {
        const { tools: subject } = tools();
        subject.pick('hand');
        subject.holdSpace();
        subject.pick('select');
        expect(subject.tool).toBe('select');
        expect(subject.dragToPan).toBe('both');
        expect(subject.selectDrag).toBe(false);
        subject.releaseSpace();
        expect(subject.dragToPan).toBe('middle');
        expect(subject.selectDrag).toBe(true);
    });
});

describe('合流先を選ぶ途中 (軸 B の B3。B-099)', () => {
    it('選択の道具から始めると、パンは中ボタンだけで、選択の道具のドラッグも効かない。やめると選択に戻る (B1.b7、B3.b10、B3.b12)', () => {
        const { tools: subject, changes } = tools();
        subject.startJoin();
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'join-target', joining: true, dragToPan: 'middle', selectDrag: false });
        subject.endJoin();
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        expect(changes()).toBe(2);
    });

    it('手のひらから始めると、もとの道具 (手のひら) を覚え、途中はパンが中ボタンだけ、やめると手のひらに戻る (B2.b7)', () => {
        const { tools: subject } = tools();
        subject.pick('hand');
        subject.startJoin();
        expect(snapshot(subject)).toEqual({ tool: 'hand', state: 'join-target', joining: true, dragToPan: 'middle', selectDrag: false });
        subject.endJoin();
        expect(snapshot(subject)).toEqual({ tool: 'hand', state: 'hand', joining: false, dragToPan: 'both', selectDrag: false });
    });

    it('途中で道具を替えると、途中をやめてから替える (B3.b1、B3.b2、B3.b4、B3.b5)', () => {
        const { tools: subject } = tools();
        subject.pick('hand');
        subject.startJoin();
        subject.pick('select');
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        subject.startJoin();
        subject.pick('hand');
        expect(snapshot(subject)).toEqual({ tool: 'hand', state: 'hand', joining: false, dragToPan: 'both', selectDrag: false });
    });

    it('途中で今の道具を選んでも、途中をやめる (B3.b1 の選択の道具から始めた場合)', () => {
        const { tools: subject } = tools();
        subject.startJoin();
        subject.pick('select');
        expect(subject.joining).toBe(false);
        expect(subject.state).toBe('select');
    });

    it('途中の Space は途中のまま、押している間だけ主ボタンでもパンする (B3.b8)', () => {
        const { tools: subject } = tools();
        subject.startJoin();
        subject.holdSpace();
        expect(subject.state).toBe('join-target');
        expect(subject.dragToPan).toBe('both');
        subject.releaseSpace();
        expect(subject.state).toBe('join-target');
        expect(subject.dragToPan).toBe('middle');
    });

    it('途中で始め直しても途中のまま (B3.b7)', () => {
        const { tools: subject, changes } = tools();
        subject.startJoin();
        subject.startJoin();
        expect(subject.state).toBe('join-target');
        expect(changes()).toBe(1);
    });
});

describe('閲覧へ切り替える (軸 B の b16、表 S の s6、design 5.3)', () => {
    it('最初の道具 (選択) に戻し、Space の押下と合流先を選ぶ途中も解く', () => {
        const { tools: subject, changes } = tools();
        subject.pick('hand');
        subject.holdSpace();
        subject.startJoin();
        const before = changes();
        subject.reset();
        expect(snapshot(subject)).toEqual({ tool: 'select', state: 'select', joining: false, dragToPan: 'middle', selectDrag: true });
        expect(changes()).toBe(before + 1);
    });

    it('もう最初の状態なら何も変えず、知らせない', () => {
        const { tools: subject, changes } = tools();
        subject.reset();
        expect(changes()).toBe(0);
    });
});

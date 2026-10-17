import { describe, expect, it } from 'vitest';
import {
  BIG_STEPS,
  clickSteps,
  EDIT_HOLD_MS,
  EDIT_MOVE_PX,
  isHot,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  repeatSteps,
  SCRUB_PX,
  type StepSpec,
  scrubSteps,
  sentAfterProps,
  stepBy,
  stepFree,
  stepKey,
  stepOrigin,
  stepperJump,
  stepperKey,
  stepperMove,
  wheelStep,
} from '../../ui/view/stepper';

/** #81: ステッパーの規則（段の整数で ±、step の小数桁で丸める、範囲で止める、既定でなければ hot）。 */
const DAYS: StepSpec = { min: 0, max: 30, step: 1, def: 0 };
const TENTH: StepSpec = { min: 0, max: 1, step: 0.1, def: 0.5 };
const SIGMA: StepSpec = { min: -40, max: 40, step: 0.5, def: 0 };

describe('stepBy', () => {
  it('±1 段', () => {
    expect(stepBy(DAYS, 3, 1)).toBe(4);
    expect(stepBy(DAYS, 3, -1)).toBe(2);
    expect(stepBy(SIGMA, 0, -1)).toBe(-0.5);
  });

  it('範囲の端で止まる', () => {
    expect(stepBy(DAYS, 30, 1)).toBe(30);
    expect(stepBy(DAYS, 0, -1)).toBe(0);
    expect(stepBy(TENTH, 1, 1)).toBe(1);
    expect(stepBy(SIGMA, -40, -1)).toBe(-40);
    expect(stepBy(DAYS, 29, 5)).toBe(30);
  });

  it('0.1 刻みで 0.2 から + → 0.3 ちょうど（浮動小数の誤差を出さない）', () => {
    expect(stepBy(TENTH, 0.2, 1)).toBe(0.3);
    expect(stepBy(TENTH, 0.3, 1)).toBe(0.4);
    expect(stepBy(TENTH, 0.7, -1)).toBe(0.6);
    let v = 0;
    for (let i = 0; i < 10; i++) v = stepBy(TENTH, v, 1);
    expect(v).toBe(1);
  });

  it('段に乗っていない値は近い段に寄せてから動かす', () => {
    expect(stepBy(DAYS, 2.4, 1)).toBe(3);
    expect(stepBy(TENTH, 0.2000000001, 1)).toBe(0.3);
  });
});

describe('isHot / stepKey', () => {
  it('既定値と違えば hot（誤差は段の 1e-9 以内を同じとみなす）', () => {
    expect(isHot(DAYS, 0)).toBe(false);
    expect(isHot(DAYS, 1)).toBe(true);
    expect(isHot(TENTH, 0.5)).toBe(false);
    expect(isHot(TENTH, 0.1 + 0.4)).toBe(false);
    expect(isHot(TENTH, 0.6)).toBe(true);
  });

  it('↑ で +1、↓ で −1、ほかは 0', () => {
    expect(stepKey('ArrowUp')).toBe(1);
    expect(stepKey('ArrowDown')).toBe(-1);
    expect(stepKey('ArrowLeft')).toBe(0);
    expect(stepKey('Enter')).toBe(0);
  });
});

/** #83: スクラブ・ホイール・キー・Shift の大きな段・端数を保つ段・長押しの連続（AC-2）。 */
describe('#83 AC-2 ステッパーの操作の規則', () => {
  it('(a) スクラブ: 押した位置からの移動量 ÷ 8px の整数部。DOM は累計の差だけ動かす', () => {
    expect(SCRUB_PX).toBe(8);
    expect(scrubSteps(7)).toBe(0);
    expect(scrubSteps(8)).toBe(1);
    // 差分だけ動かす: 0 → +8（+1）→ +23（計 +2、差 +1）→ +15（計 +1、差 −1）
    let applied = 0;
    const moves: number[] = [];
    for (const dx of [7, 8, 23, 15]) {
      const total = scrubSteps(dx);
      moves.push(total - applied);
      applied = total;
    }
    expect(moves).toEqual([0, 1, 1, -1]);
    expect(applied).toBe(1);
    // 押し直して −8px → −1
    expect(scrubSteps(-8)).toBe(-1);
    expect(scrubSteps(-7)).toBe(0);
  });

  it('(b) ホイール: 上（deltaY < 0）で +1、下で −1、0・非有限は 0', () => {
    expect(wheelStep(-100)).toBe(1);
    expect(wheelStep(-0.5)).toBe(1);
    expect(wheelStep(53)).toBe(-1);
    expect(wheelStep(0)).toBe(0);
    expect(wheelStep(Number.NaN)).toBe(0);
  });

  it('(c) キー: ↑ / → +1、↓ / ← −1、Shift + 矢印・PageUp / PageDown ±10、Home / End、R、+ / − は扱わない', () => {
    expect(stepperKey('ArrowUp', false)).toEqual({ n: 1 });
    expect(stepperKey('ArrowRight', false)).toEqual({ n: 1 });
    expect(stepperKey('ArrowDown', false)).toEqual({ n: -1 });
    expect(stepperKey('ArrowLeft', false)).toEqual({ n: -1 });
    expect(stepperKey('ArrowUp', true)).toEqual({ n: 10 });
    expect(stepperKey('ArrowRight', true)).toEqual({ n: 10 });
    expect(stepperKey('ArrowDown', true)).toEqual({ n: -10 });
    expect(stepperKey('ArrowLeft', true)).toEqual({ n: -10 });
    expect(stepperKey('PageUp', false)).toEqual({ n: 10 });
    expect(stepperKey('PageDown', false)).toEqual({ n: -10 });
    expect(stepperKey('Home', false)).toEqual({ to: 'min' });
    expect(stepperKey('End', false)).toEqual({ to: 'max' });
    expect(stepperKey('r', false)).toEqual({ to: 'def' });
    expect(stepperKey('R', true)).toEqual({ to: 'def' });
    for (const k of ['+', '-', '−', '=', 'Enter', ' ', 'a', '0'])
      expect(stepperKey(k, false)).toBeNull();
    expect(stepperJump(SIGMA, 'min')).toBe(-40);
    expect(stepperJump(SIGMA, 'max')).toBe(40);
    expect(stepperJump(TENTH, 'def')).toBe(0.5);
  });

  it('(d) Shift + クリックは 10 段、範囲で止まる', () => {
    expect(BIG_STEPS).toBe(10);
    expect(clickSteps(false)).toBe(1);
    expect(clickSteps(true)).toBe(10);
    expect(stepperMove(DAYS, 3, clickSteps(true), false)).toBe(13);
    expect(stepperMove(DAYS, 25, clickSteps(true), false)).toBe(30);
    expect(stepperMove(SIGMA, 0, -clickSteps(true), false)).toBe(-5);
    expect(stepperMove(TENTH, 0.5, clickSteps(true), false)).toBe(1);
  });

  it('(e) 端数を保つ段（d）: 4.27 + 1 → 5.27、−5 → 0、上限 30 で 29.5 + 1 → 30', () => {
    expect(stepFree(DAYS, 4.27, 1)).toBe(5.27);
    // −1 は浮動小数の誤差が出る（#82 の stageKey の [ と同じ演算なので同じ値）
    expect(stepFree(DAYS, 4.27, -1)).toBeCloseTo(3.27, 12);
    expect(stepFree(DAYS, 4.27, -5)).toBe(0);
    expect(stepFree(DAYS, 29.5, 1)).toBe(30);
    expect(stepperMove(DAYS, 4.27, 1, true)).toBe(5.27);
    // 寄せる段（keepFraction なし）は格子に乗る
    expect(stepperMove(DAYS, 4.27, 1, false)).toBe(5);
  });

  it('(f) 長押しの連続: 待ちより前は 1、待ちの後は間隔ごとに +1（単調）', () => {
    expect(REPEAT_DELAY_MS).toBe(400);
    expect(REPEAT_INTERVAL_MS).toBe(80);
    expect(repeatSteps(0)).toBe(1);
    expect(repeatSteps(REPEAT_DELAY_MS - 1)).toBe(1);
    expect(repeatSteps(REPEAT_DELAY_MS)).toBe(2);
    expect(repeatSteps(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS - 1)).toBe(2);
    expect(repeatSteps(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS)).toBe(3);
    expect(repeatSteps(2000)).toBe(22);
    let prev = 0;
    for (let t = 0; t <= 3000; t += 7) {
      const n = repeatSteps(t);
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n).toBeGreaterThan(0);
      prev = n;
    }
  });

  it('数値入力の長押しは 450ms・6px（舞台のジェスチャーと同じ値）', () => {
    expect(EDIT_HOLD_MS).toBe(450);
    expect(EDIT_MOVE_PX).toBe(6);
  });
});

/**
 * #83 レビュー B-2: ステッパーの外の操作（リセット・プリセット・評価時刻のチップ）で値が送る前の値に戻っても、
 * 次の段・数値入力の初期値は今の props の値から作る（古い送った値を使わない）。部品の起点の規則を描画の列で再現する。
 */
describe('#83 B-2 段の起点は今の props の値', () => {
  /** 部品と同じ手順: 送る → 描画（props が変わる）→ … */
  function sim(spec: StepSpec, value0: number, keepFraction = false) {
    let value = value0;
    let sent: number | null = null;
    const origin = () => stepOrigin(null, sent, value);
    return {
      plus() {
        const v = stepperMove(spec, origin(), 1, keepFraction);
        sent = v; // onChange(v)
        return v;
      },
      render(next: number) {
        sent = sentAfterProps(sent, value, next);
        value = next;
      },
      origin,
    };
  }

  it('Δσ: [＋] 0.5 → リセット 0 → [＋] は 0.5（1 ではない）、数値入力の初期値は 0', () => {
    const s = sim(SIGMA, 0);
    s.render(s.plus()); // 0.5 が届く
    s.render(0); // リセット
    expect(s.origin()).toBe(0);
    expect(s.plus()).toBe(0.5);
  });

  it('ΔX（%）・Δs: [＋] → プリセット → [＋] はプリセットの値から 1 段', () => {
    const dX: StepSpec = { min: -40, max: 20, step: 0.5, def: 0 };
    const s = sim(dX, 0);
    s.render(s.plus());
    s.render(-10); // 急落
    expect(s.plus()).toBe(-9.5);
    const skew: StepSpec = { min: -5, max: 5, step: 0.5, def: 0 };
    const k = sim(skew, 0);
    k.render(k.plus());
    k.render(0); // リセット
    expect(k.origin()).toBe(0);
  });

  it('d: 入力 5.5 → 評価時刻のチップ 29.7597… → 起点は 29.7597…（[＋] で上限 30 に止まる）', () => {
    const s = sim(DAYS, 0, true);
    s.render(5.5);
    s.render(29.759722);
    expect(s.origin()).toBe(29.759722);
    expect(s.plus()).toBe(30);
  });

  it('β: [＋] 1.1 → 外で 1 に戻る → [＋] は 1.1', () => {
    const beta: StepSpec = { min: 0, max: 10, step: 0.1, def: 1 };
    const s = sim(beta, 1);
    s.render(s.plus());
    s.render(1);
    expect(s.plus()).toBe(1.1);
  });

  it('props が届く前の連続の操作は送った値から（段を落とさない）。届いたら props から', () => {
    const s = sim(SIGMA, 0);
    s.plus(); // 0.5 を送ったがまだ描画されていない
    expect(s.origin()).toBe(0.5);
    expect(s.plus()).toBe(1);
    s.render(1);
    expect(s.origin()).toBe(1);
    // 同じ値の描画（props が変わらない）では sent を保つ
    expect(sentAfterProps(1.5, 1, 1)).toBe(1.5);
    expect(sentAfterProps(1.5, 1, 1.5)).toBeNull();
    expect(stepOrigin(2, 1.5, 1)).toBe(2);
  });
});

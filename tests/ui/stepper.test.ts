import { describe, expect, it } from 'vitest';
import { isHot, type StepSpec, stepBy, stepKey } from '../../ui/view/stepper';

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

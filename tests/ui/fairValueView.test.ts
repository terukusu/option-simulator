import { describe, expect, it } from 'vitest';
import {
  FAIR_POSITION_LABEL,
  fairPriceRound,
  fairPriceText,
  fairViewOf,
} from '../../ui/view/fairValue';

/** #264: 理論価格の表示の文字列（架空の値） */
describe('理論価格の表示（fairViewOf）', () => {
  it('桁: 小数 1 桁に丸めた値が 100 未満なら小数 1 桁、以上は整数（99.96 は 100）', () => {
    expect(fairPriceText(9.64)).toBe('9.6');
    expect(fairPriceText(99.94)).toBe('99.9');
    expect(fairPriceText(99.96)).toBe('100');
    expect(fairPriceText(1925.6)).toBe('1,926');
  });

  it('#266: AI の値（fairPriceRound）は画面の文字（fairPriceText）と同じ桁。100 円の境の前後', () => {
    const cases: [number, number][] = [
      [9.64, 9.6],
      [99.94, 99.9],
      [99.95, 100],
      [99.96, 100],
      [100, 100],
      [100.4, 100],
      [100.5, 101],
      [1925.6, 1926],
    ];
    for (const [x, want] of cases) {
      expect(fairPriceRound(x)).toBe(want);
      expect(fairPriceRound(x)).toBe(Number(fairPriceText(x).replace(/,/g, '')));
    }
  });

  it('全文は価格・使った IV・気配の中の位置・外挿の順', () => {
    const v = fairViewOf({ price: 10, iv: 0.589, mark: 'interpolated' }, 7, 13);
    expect(v).toEqual({
      price: '10.0',
      iv: '58.9',
      position: '気配の中ほど',
      extrapolated: false,
      label: '理論価格 10.0（IV 58.9・気配の中ほど）',
    });
    const w = fairViewOf({ price: 4.2, iv: 0.7, mark: 'extrapolated' }, null, null);
    expect(w?.label).toBe('理論価格 4.2（IV 70.0・外挿）');
    expect(w?.position).toBeNull();
    expect(fairViewOf(null, 7, 13)).toBeNull();
    expect(FAIR_POSITION_LABEL.middle).toBe('気配の中ほど');
  });
});

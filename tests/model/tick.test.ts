import { describe, expect, it } from 'vitest';
import { optionTick, roundFuturePrice, roundOptionPrice, shiftOptionTicks } from '../../model/tick';

describe('呼値の丸め（300 円以下 1 円、300 円超 5 円）', () => {
  it('呼値の単位', () => {
    expect(optionTick(1)).toBe(1);
    expect(optionTick(300)).toBe(1);
    expect(optionTick(300.5)).toBe(5);
    expect(optionTick(2000)).toBe(5);
  });

  it.each([
    [0.4, 0],
    [0.5, 1],
    [12.49, 12],
    [299.6, 300],
    [300, 300],
    [302.4, 300],
    [302.5, 305],
    [1987.4, 1985],
    [1987.5, 1990],
    [-3, 0],
  ])('nearest: %d → %d', (p, want) => {
    expect(roundOptionPrice(p)).toBe(want);
  });

  it('down / up', () => {
    expect(roundOptionPrice(304.9, 'down')).toBe(300);
    expect(roundOptionPrice(300.1, 'up')).toBe(305);
    expect(roundOptionPrice(12.01, 'up')).toBe(13);
    expect(roundOptionPrice(305, 'down')).toBe(305);
    expect(roundOptionPrice(305, 'up')).toBe(305);
  });

  it('呼値 n 本ずらす（300 円の境界をまたぐ）', () => {
    expect(shiftOptionTicks(299, 2)).toBe(305);
    expect(shiftOptionTicks(305, -2)).toBe(299);
    expect(shiftOptionTicks(2, -5)).toBe(0);
  });

  it('先物（ラージ 10 円、ミニ 5 円）', () => {
    expect(roundFuturePrice(67883, 'fut_large')).toBe(67880);
    expect(roundFuturePrice(67883, 'fut_mini')).toBe(67885);
    expect(roundFuturePrice(67881, 'fut_mini', 'down')).toBe(67880);
  });
});

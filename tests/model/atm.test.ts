import { describe, expect, it } from 'vitest';
import { atmReference, findAtm } from '../../model/atm';
import type { StrikeRow } from '../../model/types';

const row = (
  k: number,
  c: [number | null, number | null] = [null, null],
  p: [number | null, number | null] = [null, null],
): StrikeRow => ({ k, call: { bid: c[0], ask: c[1] }, put: { bid: p[0], ask: p[1] } });

describe('ATM の判定（5.9）', () => {
  const rows = [67500, 67625, 67750, 67875, 68000].map((k) => row(k));

  it('基準価格に最も近い行使価格', () => {
    expect(findAtm(rows, 67810)?.k).toBe(67750);
    expect(findAtm(rows, 67820)?.k).toBe(67875);
    expect(findAtm(rows, 60000)?.k).toBe(67500);
    expect(findAtm(rows, 67810)).toMatchObject({
      reference: 67810,
      distance: 60,
      tieBreak: 'none',
    });
  });

  it('同距離は |C_mid − P_mid| が小さい方', () => {
    const tie = [row(40000, [30, 32], [10, 12]), row(41000, [20, 22], [18, 20])];
    expect(findAtm(tie, 40500)).toMatchObject({ k: 41000, tieBreak: 'pcp' });
    const tie2 = [row(40000, [20, 22], [19, 21]), row(41000, [30, 32], [10, 12])];
    expect(findAtm(tie2, 40500)).toMatchObject({ k: 40000, tieBreak: 'pcp' });
  });

  it('同距離で気配が無い行があれば低い方', () => {
    const tie = [row(40000, [null, 32], [10, 12]), row(41000, [20, 22], [18, 20])];
    expect(findAtm(tie, 40500)).toMatchObject({ k: 40000, tieBreak: 'lower' });
    expect(findAtm([row(41000), row(40000)], 40500)).toMatchObject({ k: 40000, tieBreak: 'lower' });
  });

  it('行が無い・基準価格が有限でなければ null', () => {
    expect(findAtm([], 67810)).toBeNull();
    expect(findAtm(rows, Number.NaN)).toBeNull();
  });

  it('基準 A は先物、B は合成先物。B が決まらなければ A にフォールバック', () => {
    expect(atmReference('A', { future: 67880, synthetic: 67810 })).toEqual({
      basis: 'A',
      price: 67880,
      fellBack: false,
    });
    expect(atmReference('B', { future: 67880, synthetic: 67810 })).toEqual({
      basis: 'B',
      price: 67810,
      fellBack: false,
    });
    expect(atmReference('B', { future: 67880, synthetic: Number.NaN })).toEqual({
      basis: 'B',
      price: 67880,
      fellBack: true,
    });
    expect(atmReference('B', { future: null, synthetic: null }).price).toBeNull();
    expect(atmReference('A', { future: null, synthetic: 67810 }).price).toBeNull();
  });
});

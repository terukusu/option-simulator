import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { type AtmBasis, findAtm } from '../../model';
import { buildChainJson, type ChainSpec, SPECS } from '../../scripts/synthBoard';
import { atmStrike, boardModel } from '../../ui/view/board';
import { axisValue, smileModel } from '../../ui/view/smile';

/**
 * AC-7: ATM の基準 A / B の切替（AC20 の画面部分）。基準価格を 3 通りに変えた合成の板
 * （真の F と先物価格をずらす。値は架空）× 基準 A / B の 6 ケースで、板の強調行とスマイルの
 * ATM 縦線の K が findAtm の結果と一致する。
 */
const latest = SPECS.find((s) => s.name === 'latest') as ChainSpec;

function shifted(dF: number, dFuture: number): ChainSpec {
  return {
    ...latest,
    future: { ...latest.future, price: (latest.future.price as number) + dFuture },
    months: latest.months.map((m) => ({ ...m, F: m.F + dF })),
  };
}

const CASES: Array<[string, ChainSpec]> = [
  ['そのまま', latest],
  ['F +190・先物 −260', shifted(190, -260)],
  ['F −440・先物 +330', shifted(-440, 330)],
];

describe.each(CASES)('ATM の基準の切替（%s）', (_name, spec) => {
  const chain = normalizeChain(buildChainJson(spec));

  it.each<AtmBasis>(['A', 'B'])('基準 %s: 板の強調行とスマイルの縦線 = findAtm', (basis) => {
    for (const month of chain.months) {
      const ref = month.atm[basis].reference.price;
      expect(ref).not.toBeNull();
      const expected = findAtm(month.rows, ref as number)?.k;
      expect(expected).toBeDefined();
      const board = boardModel(chain, month, basis);
      expect(board.atmK).toBe(expected);
      for (const axis of ['k', 'moneyness', 'delta'] as const) {
        const smile = smileModel(month, basis, axis);
        expect(smile.atmK).toBe(expected);
        const info = month.strikes.find((s) => s.k === expected);
        expect(info).toBeDefined();
        if (!info) continue;
        expect(smile.atmX).toBe(axisValue(month, basis, axis, info));
      }
    }
  });
});

describe('A ↔ B の切替で強調行と縦線が追随する', () => {
  it('A と B で ATM が違う板で、両方が切り替わる', () => {
    // 先物を 1,000 円上にずらすと A の ATM は B と違う行になる
    const chain = normalizeChain(buildChainJson(shifted(0, 1000)));
    const month = chain.months[0];
    expect(month).toBeDefined();
    if (!month) return;
    const a = atmStrike(month, 'A');
    const b = atmStrike(month, 'B');
    expect(a).not.toBe(b);
    expect(boardModel(chain, month, 'A').atmK).toBe(a);
    expect(boardModel(chain, month, 'B').atmK).toBe(b);
    expect(smileModel(month, 'A', 'k').atmX).toBe(a);
    expect(smileModel(month, 'B', 'k').atmX).toBe(b);
  });
});

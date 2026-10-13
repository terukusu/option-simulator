import { describe, expect, it } from 'vitest';
import { deltaHedge, HEDGE_PER_LOT, hedgeLots } from '../../model';
import { rng } from '../support/synthChain';

/**
 * #19 AC-1・AC-2: デルタヘッジの枚数（設計 5.8・M11・M12）。値は架空。
 *
 * 文献値は該当しない（Black-76 等の価格モデルを使わない、丸めだけの算術）。参照値は手計算:
 * 枚数 = round((目標 − 現在) / 1 枚の Δ)、残り = 現在 + 枚数 × 1 枚の Δ − 目標（ラージ換算）。
 * 1 枚の Δ（ラージ換算）= 乗数 / 1,000: ミニ 100 / 1,000 = 0.1、ラージ 1、マイクロ 10 / 1,000 = 0.01。
 */

const EPS = 1e-9;

describe('1 枚あたりの Δ（ラージ換算）', () => {
  it('ミニ 0.1・ラージ 1・マイクロ 0.01（乗数 / 1,000）', () => {
    expect(HEDGE_PER_LOT).toEqual({ mini: 0.1, large: 1, micro: 0.01 });
  });
});

describe('枚数の例（AC-1。手計算の参照値）', () => {
  it('現在 −0.08・目標 0 → ミニ +1 枚・残り +0.02、ラージ 0 枚・残り −0.08（マイクロ併記なし）', () => {
    const h = deltaHedge(-0.08, 0);
    expect(h).not.toBeNull();
    if (!h) return;
    // (0 − (−0.08)) / 0.1 = 0.8 → 1 枚、残り −0.08 + 0.1 − 0 = +0.02
    expect(h.mini.lots).toBe(1);
    expect(h.mini.residual).toBeCloseTo(0.02, 12);
    // 0.08 / 1 → 0 枚、残り −0.08
    expect(h.large.lots).toBe(0);
    expect(h.large.residual).toBeCloseTo(-0.08, 12);
    expect(h.micro).toBeNull();
    expect(h.diff).toBeCloseTo(0.08, 12);
  });

  it('現在 +0.03・目標 0 → ミニ 0 枚・マイクロ −3 枚を併記（残り 0）', () => {
    const h = deltaHedge(0.03, 0);
    if (!h) throw new Error('null');
    // −0.03 / 0.1 = −0.3 → 0 枚
    expect(h.mini.lots).toBe(0);
    expect(h.mini.residual).toBeCloseTo(0.03, 12);
    // −0.03 / 0.01 = −3（浮動小数では −2.9999… になるのを 1e-9 の格子で −3 に）
    expect(h.micro?.lots).toBe(-3);
    expect(Math.abs(h.micro?.residual ?? 1)).toBeLessThan(1e-12);
  });

  it('現在 +0.03・目標 +0.5 → ミニ +5 枚・残り +0.03', () => {
    const h = deltaHedge(0.03, 0.5);
    if (!h) throw new Error('null');
    // (0.5 − 0.03) / 0.1 = 4.7 → 5 枚、残り 0.03 + 0.5 − 0.5 = +0.03
    expect(h.mini.lots).toBe(5);
    expect(h.mini.residual).toBeCloseTo(0.03, 12);
    expect(h.large.lots).toBe(0);
    expect(h.micro).toBeNull();
  });

  it('ちょうど半分: 現在 −0.05・目標 0 → ミニ +1 枚・残り +0.05、求め直す（現在 +0.05）と 0 枚', () => {
    const h = hedgeLots(-0.05, 0, 0.1);
    // 0.05 / 0.1 = 0.5000000000000001 → 1e-9 の格子で 0.5 → +∞ 側で 1
    expect(h?.lots).toBe(1);
    expect(h?.residual).toBeCloseTo(0.05, 12);
    const again = hedgeLots(-0.05 + 1 * 0.1, 0, 0.1);
    // −0.05 / 0.1 = −0.5 → +∞ 側で −0 → 0（−0 にしない）
    expect(again?.lots).toBe(0);
    expect(Object.is(again?.lots, -0)).toBe(false);
    expect(deltaHedge(0.05, 0)?.mini.lots).toBe(0);
  });

  it('現在 = 目標なら全商品 0 枚・残り 0（マイクロも 0 枚）', () => {
    const h = deltaHedge(0.37, 0.37);
    if (!h) throw new Error('null');
    expect([h.mini.lots, h.large.lots, h.micro?.lots]).toEqual([0, 0, 0]);
    expect(h.mini.residual).toBe(0);
  });

  it('非有限・1 枚の Δ ≤ 0 は null（NaN・例外を出さない）', () => {
    for (const [c, t, p] of [
      [Number.NaN, 0, 0.1],
      [0, Number.NaN, 0.1],
      [Number.POSITIVE_INFINITY, 0, 0.1],
      [0, Number.NEGATIVE_INFINITY, 0.1],
      [0, 0, 0],
      [0, 0, -0.1],
      [0, 0, Number.NaN],
    ] as const) {
      expect(hedgeLots(c, t, p)).toBeNull();
    }
    expect(deltaHedge(Number.NaN, 0)).toBeNull();
    expect(deltaHedge(0, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('|差| が大きくても有限（目標 ±1,000 と大きなポジション）', () => {
    const h = deltaHedge(-12_345.678, 1000);
    if (!h) throw new Error('null');
    expect(Number.isInteger(h.mini.lots)).toBe(true);
    expect(h.mini.lots).toBe(133_457);
    expect(Math.abs(h.mini.residual)).toBeLessThanOrEqual(0.05 + EPS);
  });
});

describe('性質（AC-2。種つき乱数 1,000 ケース + ちょうど半分）', () => {
  const r = rng(19);
  const cases: Array<[number, number]> = [];
  for (let i = 0; i < 1000; i++) {
    // 現在 ±50（ラージ換算）、目標 ±5。1/4 はちょうど半分（ミニの 0.05 の奇数倍の差）にする
    const target = Math.round((r() * 10 - 5) * 100) / 100;
    const current =
      i % 4 === 0
        ? target + (2 * Math.floor(r() * 200) - 199) * 0.05
        : (r() * 100 - 50) * (r() < 0.5 ? 1 : 0.01);
    cases.push([current, target]);
  }

  it('枚数は整数（−0 なし）、|残り| ≤ 1 枚の Δ / 2 + 1e-9、残り = 現在 + 枚数 × 1 枚の Δ − 目標', () => {
    for (const [c, t] of cases) {
      const h = deltaHedge(c, t);
      if (!h) throw new Error(`null: ${c} ${t}`);
      const lines = [
        [h.mini, HEDGE_PER_LOT.mini],
        [h.large, HEDGE_PER_LOT.large],
        ...(h.micro ? [[h.micro, HEDGE_PER_LOT.micro] as const] : []),
      ] as const;
      for (const [l, per] of lines) {
        expect(Number.isInteger(l.lots)).toBe(true);
        expect(Object.is(l.lots, -0)).toBe(false);
        expect(l.perLot).toBe(per);
        expect(Math.abs(l.residual)).toBeLessThanOrEqual(per / 2 + EPS);
        expect(l.residual).toBeCloseTo(c + l.lots * per - t, 12);
      }
      // マイクロはミニが 0 枚のときだけ
      expect(h.micro !== null).toBe(h.mini.lots === 0);
    }
  });

  it('足した後にもう一度求めると 0 枚（ミニ・ラージ・マイクロ）', () => {
    for (const [c, t] of cases) {
      for (const per of [HEDGE_PER_LOT.mini, HEDGE_PER_LOT.large, HEDGE_PER_LOT.micro]) {
        const h = hedgeLots(c, t, per);
        if (!h) throw new Error('null');
        expect(hedgeLots(c + h.lots * per, t, per)?.lots).toBe(0);
      }
    }
  });

  it('ちょうど半分のケースを含み、枚数は整数演算の四捨五入（+∞ 側）と一致', () => {
    // 参照: 値を 1e-4 単位の整数にして、ミニ（0.1 = 1,000 単位）の枚数を整数だけで求める。
    // 差 D（整数）、1 枚 P = 1,000 として round half up = floor((2D + P) / (2P))（実装の浮動小数・格子と独立）
    const P = 1000;
    let halves = 0;
    for (const [c, t] of cases) {
      const D = Math.round(t * 1e4) - Math.round(c * 1e4);
      // 1e-4 単位に載らないケース（乱数の現在）は対象外
      if (Math.abs(t - c - D / 1e4) > 1e-9) continue;
      const want = Math.floor((2 * D + P) / (2 * P));
      if ((2 * D) % (2 * P) === P || (2 * D) % (2 * P) === -P) halves++;
      expect(hedgeLots(c, t, HEDGE_PER_LOT.mini)?.lots).toBe(want || 0);
    }
    expect(halves).toBeGreaterThanOrEqual(200);
  });

  it('符号の対称性: lots(−差) は −lots(差) か −lots(差) + 1（半分だけ +∞ 側のため）', () => {
    for (const [c, t] of cases) {
      const a = hedgeLots(c, t, 0.1)?.lots as number;
      const b = hedgeLots(-c, -t, 0.1)?.lots as number;
      expect([-a, -a + 1]).toContain(b);
    }
  });
});

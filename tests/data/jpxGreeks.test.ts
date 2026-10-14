/**
 * JPX グリークの単位の換算と AC7 の照合（設計 5.6「JPX グリークの単位」・2.2 AC7。#37）。
 * 値はすべて合成（Black-76 から JPX の単位で作った架空の値）。実データは tests/data/jpxGreeksLocal.test.ts（手元だけ）。
 */
import { describe, expect, it } from 'vitest';
import {
  AC7_TOLERANCE,
  ac7Check,
  compareAc7,
  isFreshJpx,
  JPX_FRESH_MINUTES,
  jpxDisplayGreeks,
} from '../../data/jpxGreeks';
import { buildMarketContext } from '../../data/legs';
import { normalizeChain } from '../../data/normalize';
import { black76Greeks, black76Price } from '../../model/black76';
import { evaluatePosition, type Leg, preparePosition } from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { DAY_MS } from '../../model/time';
import { fixture } from '../support/fixtures';
import { rng } from '../support/synthChain';

const R = 0.005;

/** JPX の単位（原資産 1 単位・1 円・1 暦日・IV 1pt、乗数なし）の値を Black-76 から作る */
function jpxUnits(type: 'call' | 'put', F: number, K: number, T: number, sigma: number) {
  const g = black76Greeks(type, F, K, T, sigma, R);
  return { delta: g.delta, gamma: g.gamma, theta: g.theta / 365, vega: g.vega / 100 };
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe('jpxDisplayGreeks（JPX の単位 → 5.6 の表示単位）', () => {
  it('合成の 300 ケースで model/ の displayGreeks（足の IV = JPX の IV）と相対 1e-9 で一致する（種 37）', () => {
    const rand = rng(37);
    for (let i = 0; i < 300; i++) {
      const F = 40_000 + rand() * 40_000;
      const K = Math.round((F * Math.exp(-0.4 + rand() * 0.65)) / 125) * 125;
      const days = 1 + rand() * 89;
      const sigma = 0.1 + rand() * 0.8;
      const type = rand() < 0.5 ? 'call' : 'put';
      const side = rand() < 0.5 ? 'buy' : 'sell';
      const qty = 1 + Math.floor(rand() * 20);
      const T = days / 365;
      const ctx = {
        evalTime: 0,
        r: R,
        x0: F,
        options: { M: { sqTime: days * DAY_MS, forward: F, smile: null } },
        futures: {},
      };
      const leg: Leg = {
        kind: 'option',
        product: 'op_large',
        type,
        expiry: 'M',
        strike: K,
        side,
        qty,
        entry: black76Price(type, F, K, T, sigma, R),
        iv: sigma,
      };
      const app = evaluatePosition(preparePosition([leg], ctx), ZERO_SCENARIO, ctx).total;
      const jpx = jpxDisplayGreeks(jpxUnits(type, F, K, T, sigma), { side, qty });
      expect(jpx).not.toBeNull();
      if (jpx === null) continue;
      for (const key of [
        'deltaLarge',
        'deltaMini',
        'gammaPer100',
        'thetaPerDay',
        'vegaPerPt',
      ] as const) {
        if (!close(jpx[key], app[key])) {
          throw new Error(`${key}: ケース ${i} で ${jpx[key]} ≠ ${app[key]}`);
        }
      }
    }
  });

  it('架空の値: 買い 1 枚は乗数 1,000 を掛け、売り 2 枚は符号を反転して 2 倍', () => {
    const g = { delta: 0.5, gamma: 0.0001, theta: -20, vega: 60 };
    expect(jpxDisplayGreeks(g, { side: 'buy', qty: 1 })).toEqual({
      deltaLarge: 0.5,
      deltaMini: 5,
      gammaPer100: 0.01,
      thetaPerDay: -20_000,
      vegaPerPt: 60_000,
    });
    const sell = jpxDisplayGreeks({ ...g, delta: -0.25 }, { side: 'sell', qty: 2 });
    expect(sell?.deltaLarge).toBeCloseTo(0.5, 12);
    expect(sell?.deltaMini).toBeCloseTo(5, 12);
    expect(sell?.thetaPerDay).toBe(40_000);
    expect(sell?.vegaPerPt).toBe(-120_000);
    // 乗数を変えると（ミニ OP 相当 100）ラージ換算は 1/10
    expect(jpxDisplayGreeks(g, { side: 'buy', qty: 1, multiplier: 100 })?.deltaLarge).toBe(0.05);
  });

  it('JPX のグリークが欠けた足・枚数が不正な足は null（例外・NaN を出さない）', () => {
    const g = { delta: 0.5, gamma: 0, theta: -20, vega: 60 };
    for (const key of ['delta', 'gamma', 'theta', 'vega'] as const) {
      expect(jpxDisplayGreeks({ ...g, [key]: null }, { side: 'buy', qty: 1 })).toBeNull();
      expect(jpxDisplayGreeks({ ...g, [key]: Number.NaN }, { side: 'buy', qty: 1 })).toBeNull();
    }
    expect(jpxDisplayGreeks(g, { side: 'buy', qty: 0 })).toBeNull();
    expect(jpxDisplayGreeks(g, { side: 'buy', qty: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('isFreshJpx（約定時刻が新しい JPX グリークだけを照合に使う）', () => {
  const snap = Date.parse('2026-10-13T21:31:00+09:00');
  const side = (t: string | null) => ({ price_time: t, delta: 0.3 });
  it(`約定から ${JPX_FRESH_MINUTES} 分以内は新しい、それより古い・未来・時刻なしは新しくない`, () => {
    expect(isFreshJpx(side('2026-10-13T21:31:00+09:00'), snap)).toBe(true);
    expect(isFreshJpx(side('2026-10-13T21:26:00+09:00'), snap)).toBe(true);
    expect(isFreshJpx(side('2026-10-13T21:25:59+09:00'), snap)).toBe(false);
    expect(isFreshJpx(side('2026-10-13T21:32:00+09:00'), snap)).toBe(false);
    expect(isFreshJpx(side(null), snap)).toBe(false);
    expect(isFreshJpx({ price_time: '2026-10-13T21:30:00+09:00', delta: null }, snap)).toBe(false);
    expect(isFreshJpx(side('2026-10-13T21:20:00+09:00'), snap, 15)).toBe(true);
  });
});

describe('compareAc7（AC7 の閾値）', () => {
  const pair = (aD: number, jD: number, aV: number, jV: number) => ({
    app: { deltaLarge: aD, vegaPerPt: aV },
    jpx: { deltaLarge: jD, vegaPerPt: jV },
  });
  it('合計の差が gross × 5% 以内なら ok、超えれば ng（Δ と V を別々に判定）', () => {
    // gross Δ = 1.0、gross V = 100,000 → 許容 0.05 と 5,000
    const ok = compareAc7([pair(0.519, 0.5, 48_000, 50_000), pair(-0.47, -0.5, 56_900, 50_000)]);
    expect(ok.delta.limit).toBeCloseTo(0.05, 12);
    expect(ok.vega.limit).toBeCloseTo(5_000, 9);
    expect(ok.delta.diff).toBeCloseTo(0.049, 12);
    expect(ok.vega.diff).toBeCloseTo(4_900, 6);
    expect(ok.ok).toBe(true);
    const ngDelta = compareAc7([pair(0.56, 0.5, 50_000, 50_000), pair(-0.5, -0.5, 50_000, 50_000)]);
    expect(ngDelta.delta.ok).toBe(false);
    expect(ngDelta.vega.ok).toBe(true);
    expect(ngDelta.ok).toBe(false);
    const ngVega = compareAc7([pair(0.5, 0.5, 55_100, 50_000), pair(-0.5, -0.5, 50_000, 50_000)]);
    expect(ngVega.vega.ok).toBe(false);
  });

  it('売りと買いで打ち消し合っても gross で判定し、小さい組は下限（Δ 0.01 枚・V 10 円）で判定する', () => {
    const c = compareAc7([pair(0.3, 0.3, 30_000, 30_000), pair(-0.29, -0.3, -30_000, -30_000)]);
    expect(c.delta.jpx).toBeCloseTo(0, 12);
    expect(c.delta.gross).toBeCloseTo(0.6, 12);
    expect(c.ok).toBe(true);
    const small = compareAc7([pair(0.009, 0.001, 9, 1)]);
    expect(small.delta.limit).toBe(AC7_TOLERANCE.deltaFloor);
    expect(small.vega.limit).toBe(AC7_TOLERANCE.vegaFloor);
    expect(small.ok).toBe(true);
  });

  it('足が 0 本・非有限は ok にならない', () => {
    expect(compareAc7([]).ok).toBe(false);
    expect(compareAc7([pair(Number.NaN, 0.5, 1, 1)]).ok).toBe(false);
  });
});

describe('ac7Check（板から足を組んで照合する）', () => {
  // 合成の板のグリークは JPX と同じ単位（Γ の丸めだけ違う）で、スナップショット時刻の F・生成の IV で付けてある
  const chain = normalizeChain(fixture('latest'));
  const ctx = buildMarketContext(chain);

  it('合成の板（約定時刻の制限を外す）で全限月・2 つの組が閾値内', () => {
    const res = ac7Check(chain, ctx, { minutes: 24 * 60 });
    expect(res.length).toBe(chain.months.length * 2);
    for (const r of res) {
      expect(r.comparison.legs).toBeGreaterThanOrEqual(2);
      expect(r.comparison.ok, `${r.month} ${r.book}`).toBe(true);
    }
  });

  it('V の単位を取り違える（IV 1.00 あたり = 100 倍）と ng になる', () => {
    const wrong = structuredClone(fixture('latest'));
    for (const m of wrong.months)
      for (const row of m.rows)
        for (const s of [row.call, row.put]) if (s.vega !== null) s.vega *= 100; // IV 1.00 あたりと誤る
    const res = ac7Check(normalizeChain(wrong), buildMarketContext(normalizeChain(wrong)), {
      minutes: 24 * 60,
    });
    // 売買交互の組は合計が打ち消し合うので尺度の誤りに鈍い。尺度はすべて買いの組で検出する
    const allBuy = res.filter((r) => r.book === 'all_buy');
    expect(allBuy.length).toBe(chain.months.length);
    expect(allBuy.every((r) => !r.comparison.vega.ok)).toBe(true);
  });

  it('新しい約定が無い板（既定の 5 分）は組を出さない', () => {
    const old = structuredClone(fixture('latest'));
    for (const m of old.months)
      for (const row of m.rows)
        for (const s of [row.call, row.put])
          if (s.price_time !== null) s.price_time = '2026-10-13T09:00:00+09:00';
    expect(ac7Check(normalizeChain(old), buildMarketContext(normalizeChain(old)))).toEqual([]);
  });
});

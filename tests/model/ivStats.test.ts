/**
 * #138・#158 AC1: IV と原資産の動きの統計（model/ivStats.ts）。定義どおりか（性質テスト）と、既知の値を埋めた合成の列
 * からの回復（スパイク・β・HV）。限月交代と欠けた日は data/atmDaily.ts の atmMoves（ツールと同じ組み方）で確かめる。
 * 値はすべて架空（IV 15〜30% 前後・F 30,000 前後）。
 */
import { describe, expect, it } from 'vitest';
import { type AtmDailyDay, atmMoves } from '../../data/atmDaily';
import {
  HV_DAYS_PER_YEAR,
  ivBeta,
  ivSpikes,
  lowBefore,
  percentileRank,
  quantilesOf,
  realizedVol,
  regressionSlope,
  rollingVol,
  sortedFinite,
} from '../../model/ivStats';
import { quantile } from '../../model/technicals';
import { rng } from '../support/synthChain';

/** 標準正規（Box–Muller。種つき） */
function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

describe('分位', () => {
  it('経験分布の順位 = v 以下の個数 / n × 100（種つき 200 ケース）', () => {
    const r = rng(138);
    for (let c = 0; c < 200; c++) {
      const n = 1 + Math.floor(r() * 60);
      // 同じ値を含む（整数に丸める）
      const xs = Array.from({ length: n }, () => Math.round(10 + r() * 20));
      const s = sortedFinite(xs);
      const v = Math.round(5 + r() * 30);
      const want = (xs.filter((x) => x <= v).length / n) * 100;
      expect(percentileRank(s, v)).toBeCloseTo(want, 12);
      // 単調非減少
      expect(percentileRank(s, v + 1) as number).toBeGreaterThanOrEqual(want);
    }
  });

  it('端: 空・全部より小さい・全部以上・全部同じ値・有限でない値', () => {
    expect(percentileRank([], 1)).toBeNull();
    expect(percentileRank([1, 2, 3], 0.5)).toBe(0);
    expect(percentileRank([1, 2, 3], 3)).toBe(100);
    expect(percentileRank([2, 2, 2, 2], 2)).toBe(100);
    expect(percentileRank([2, 2, 2, 2], 1.99)).toBe(0);
    expect(percentileRank([1, 2], Number.NaN)).toBeNull();
    expect(sortedFinite([3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2])).toEqual([1, 2, 3]);
  });

  it('分位点の要約は線形補間の quantile と同じ', () => {
    const s = sortedFinite([20, 10, 30, 40, 50]);
    const q = quantilesOf(s);
    expect(q).toEqual({ n: 5, min: 10, p10: 14, p25: 20, p50: 30, p75: 40, p90: 46, max: 50 });
    expect(q.p90).toBe(quantile(s, 0.9));
    expect(quantilesOf([])).toEqual({
      n: 0,
      min: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      max: null,
    });
  });
});

describe('スパイクの回復', () => {
  /** 平らな地合い（15 と 14.8 の交互）に、決まった形のスパイクを埋めた列 */
  function series() {
    const iv: number[] = [];
    const flat = (k: number) => {
      for (let i = 0; i < k; i++) iv.push(i % 2 === 0 ? 15 : 14.8);
    };
    flat(20);
    // しきい値未満の揺れ（14.8 → 19 = +28.4%）: 数えない
    iv.push(19, 17, 15);
    flat(15);
    // 1 回目: 起点 21（14.8 × 1.3 = 19.24 以上）、山 24（起点の 2 行後）、半分戻し 19.4 以下、9 割戻し 15.72 以下
    // （境の値ちょうどを避ける = 浮動小数の丸めに依らない）
    const s1 = iv.length;
    iv.push(21, 22.5, 24, 23, 21, 19.3, 17, 16, 15.7);
    flat(20);
    // 2 回目: 起点で山（起点 20、そのまま下がる）、9 割戻しは無いまま 3 回目の前に地合いが上がる
    const s2 = iv.length;
    iv.push(20, 18, 17.3, 17, 16.9);
    for (let i = 0; i < 12; i++) iv.push(16.9);
    // 3 回目: 戻し切っていない（ongoing）
    const s3 = iv.length;
    iv.push(23, 25, 26, 24.5);
    return { iv, s1, s2, s3 };
  }

  it('回数・起点 / 山の位置・山までの日数・半分戻し / 9 割戻しまでの日数をちょうど回復する', () => {
    const { iv, s1, s2, s3 } = series();
    const eps = ivSpikes(iv, 0.3);
    expect(eps.length).toBe(3);
    const [a, b, c] = eps;
    expect(a).toEqual({
      start: s1,
      base: 14.8,
      peak: s1 + 2,
      half: s1 + 5,
      retrace90: s1 + 8,
      ongoing: false,
    });
    // 2 回目: 起点の最低は直前 10 行（地合い 14.8 と 15）、起点 = 山、半分戻し 17.3（≤ 14.8 + 0.5 × 5.2 = 17.4）
    expect(b?.start).toBe(s2);
    expect(b?.peak).toBe(s2);
    expect(b?.half).toBe(s2 + 2);
    // 9 割戻し 15.32 以下には届かない
    expect(b?.retrace90).toBeNull();
    expect(b?.ongoing).toBe(false);
    // 3 回目は起点の最低 16.9（直前 10 行）、山 26、半分戻し（21.45 以下）が無い
    expect(c).toEqual({
      start: s3,
      base: 16.9,
      peak: s3 + 2,
      half: null,
      retrace90: null,
      ongoing: true,
    });
  });

  it('しきい値を上げると小さい回は数えない・平らな列と短い列は 0 回・NaN を返さない', () => {
    const { iv } = series();
    // +55%: 1 回目の山 24 / 14.8 = +62% だけ（起点は山の行）。2 回目 20 / 14.8 = +35%、3 回目 26 / 16.9 = +54% は数えない
    const big = ivSpikes(iv, 0.55);
    expect(big.map((e) => [e.base, e.start, e.peak])).toEqual([[14.8, big[0]?.peak, big[0]?.peak]]);
    expect(iv[big[0]?.peak as number]).toBe(24);
    expect(ivSpikes(Array(50).fill(20), 0.1)).toEqual([]);
    expect(ivSpikes([10, 30, 10], 0.3)).toEqual([]);
    expect(ivSpikes(iv, 0)).toEqual([]);
    expect(lowBefore([1, 2, 3], 2)).toBeNull();
    expect(lowBefore([3, 1, 2, 9], 3, 3)).toBe(1);
    expect(lowBefore([3, 1, 2, 9], 3, 2)).toBe(1);
    expect(lowBefore([3, 1, Number.NaN, 9], 3, 3)).toBeNull();
    // 種つきの乱れた列でも、位置は列の中・順序は start ≤ peak < half ≤ retrace90
    const r = rng(7);
    for (let c = 0; c < 50; c++) {
      const xs: number[] = [];
      let v = 18;
      for (let i = 0; i < 300; i++) {
        v = Math.max(8, v + 0.15 * (18 - v) + 2 * gauss(r) + (r() < 0.02 ? 8 : 0));
        xs.push(v);
      }
      for (const e of ivSpikes(xs, 0.25)) {
        expect(e.start).toBeLessThanOrEqual(e.peak);
        expect(Number.isFinite(e.base)).toBe(true);
        if (e.half !== null) expect(e.half).toBeGreaterThan(e.peak);
        if (e.retrace90 !== null) expect(e.retrace90).toBeGreaterThanOrEqual(e.half as number);
        expect(e.peak).toBeLessThan(xs.length);
      }
    }
  });
});

describe('β の回復', () => {
  it('下げ・上げで傾きの違う合成の 2 日の動き（雑音つき）から β を ±0.05 で回復する', () => {
    for (const [bd, bu, seed] of [
      [1.4, 0.5, 1],
      [0.8, 0.8, 2],
      [2.0, 0.2, 3],
    ] as const) {
      const r = rng(seed);
      const pts = Array.from({ length: 600 }, () => {
        const dx = (r() * 12 - 6) / 100;
        const b = dx < 0 ? bd : bu;
        return { dx, ivPt: -b * dx * 100 + 0.3 * gauss(r) };
      });
      const beta = ivBeta(pts, 20);
      expect(Math.abs((beta.down as number) - bd)).toBeLessThan(0.05);
      expect(Math.abs((beta.up as number) - bu)).toBeLessThan(0.05);
      expect(beta.nDown + beta.nUp).toBe(600);
    }
    // 全体: 1 本の傾き β = 1.1
    const r = rng(9);
    const one = Array.from({ length: 500 }, () => {
      const dx = (r() * 10 - 5) / 100;
      return { dx, ivPt: -1.1 * dx * 100 + 0.2 * gauss(r) };
    });
    expect(Math.abs((ivBeta(one).all as number) - 1.1)).toBeLessThan(0.05);
  });

  it('向き: 下げで IV が上がると正（シナリオの β と同じ）・件数不足と分散 0 は null', () => {
    const b = ivBeta([
      { dx: -0.02, ivPt: 2 },
      { dx: -0.01, ivPt: 1 },
      { dx: 0.01, ivPt: -0.5 },
      { dx: 0.03, ivPt: -1.5 },
    ]);
    expect(b.down).toBeCloseTo(1, 12);
    expect(b.up).toBeCloseTo(0.5, 12);
    expect(ivBeta([{ dx: -0.01, ivPt: 1 }], 2).down).toBeNull();
    expect(ivBeta([], 2).all).toBeNull();
    expect(regressionSlope([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(regressionSlope([1, 2, 3], [2, 4, 6])).toBeCloseTo(2, 12);
    // 21 組未満は minN = 20 で null にならない境界: 20 組なら値
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      dx: -(i + 1) / 1000,
      ivPt: (i + 1) / 10,
    }));
    expect(ivBeta(twenty, 20).down).toBeCloseTo(1, 12);
    expect(ivBeta(twenty.slice(1), 20).down).toBeNull();
  });
});

describe('HV の回復', () => {
  it('±a の交互の対数変化から HV = a·sqrt(245) を 1e-9 で', () => {
    for (const a of [0.005, 0.01, 0.023]) {
      const rets = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? a : -a));
      for (const n of [5, 20, 60]) {
        expect(
          Math.abs((realizedVol(rets, n) as number) - a * Math.sqrt(HV_DAYS_PER_YEAR)),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('最後の n 本だけを使う・本数不足・有限でない値は null・rollingVol は位置ごとの realizedVol', () => {
    const rets = [0.1, 0.1, 0.01, -0.01, 0.01, -0.01];
    expect(realizedVol(rets, 4) as number).toBeCloseTo(0.01 * Math.sqrt(245), 12);
    expect(realizedVol(rets, 7)).toBeNull();
    expect(realizedVol([0.01, Number.NaN], 2)).toBeNull();
    const roll = rollingVol(rets, 4);
    expect(roll.slice(0, 3)).toEqual([null, null, null]);
    expect(roll[5]).toBe(realizedVol(rets, 4));
    expect(roll[3]).toBe(realizedVol(rets.slice(0, 4), 4));
  });
});

describe('限月交代と欠けた日', () => {
  const NOV = '2026-11-12';
  const DEC = '2026-12-10';
  const JAN = '2027-01-14';
  const d = (
    date: string,
    iv: number,
    f1: number,
    l1: string,
    f2: number | null,
    l2: string | null,
  ) =>
    ({
      d: date,
      t: Date.parse(`${date}T06:00:00Z`) / 1000,
      iv,
      f1,
      l1,
      f2,
      l2,
    }) satisfies AtmDailyDay;
  // 11/12 が 11 月限の最終日。11/13 から 1 限月は 12 月限（12 月限の F は 11 月限より 1% 高い架空の値）
  const days: AtmDailyDay[] = [
    d('2026-11-10', 20, 30000, NOV, 30300, DEC),
    d('2026-11-11', 20, 30000, NOV, 30300, DEC),
    d('2026-11-12', 20, 30000, NOV, 30300, DEC),
    d('2026-11-13', 20, 30300, DEC, 30500, JAN),
    // 11/16（月）が欠けた
    d('2026-11-17', 21, 30300, DEC, 30500, JAN),
    d('2026-11-18', 21, 30603, DEC, 30805, JAN),
  ];

  it('交代の日の 1 日の変化は前の日の 2 限月と比べる（交代の差 +1% を HV に入れない）・欠けた日の組は作らない', () => {
    const ones = atmMoves(days, new Set<string>(), 1);
    expect(ones.map((m) => `${m.d0}→${m.d1}`)).toEqual([
      '2026-11-10→2026-11-11',
      '2026-11-11→2026-11-12',
      '2026-11-12→2026-11-13',
      '2026-11-17→2026-11-18',
    ]);
    // 11/12 → 11/13: f1(11/13) 30,300 / f2(11/12) 30,300 − 1 = 0（1 限月どうしなら +1%）
    expect(ones[2]?.dx).toBe(0);
    expect(ones[3]?.dx).toBeCloseTo(0.01, 12);
    const rets = ones.map((m) => Math.log(1 + m.dx));
    // 最後の 4 本 = 0, 0, 0, ln(1.01)
    expect(realizedVol(rets, 4) as number).toBeCloseTo(
      Math.sqrt((245 / 4) * Math.log(1.01) ** 2),
      12,
    );
  });

  it('2 限月が無い日を跨ぐ組は作らない', () => {
    const broken = days.map((x) => (x.d === '2026-11-12' ? { ...x, f2: null, l2: null } : x));
    const ones = atmMoves(broken, new Set<string>(), 1);
    expect(ones.some((m) => m.d0 === '2026-11-12')).toBe(false);
  });
});

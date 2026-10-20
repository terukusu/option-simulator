/**
 * テクニカル指標（#200。model/technicals.ts）。参照値は定義どおりの素朴な実装（Python 3。別に書いた計算）で求めた値と、
 * 手計算の小さな例。値はすべて架空。
 *
 * 定義（テストが固定するもの）:
 * - RSI(14): J. Welles Wilder Jr.（1978）の平滑。最初の 14 個の変化の上げ・下げの単純平均、以後 avg = (avg·13 + x) / 14、
 *   RSI = 100 − 100 / (1 + 平均の上げ / 平均の下げ)
 * - MACD(12, 26, 9): Gerald Appel。EMA12 − EMA26、シグナル = MACD の EMA9、ヒストグラム = MACD − シグナル。
 *   EMA は α = 2 / (n + 1)、最初の n 個の単純平均で始める（TA-Lib と同じ）
 * - ストキャスティクス(14, 3, 3): George Lane のスロー。生の %K = 100·(C − LL14) / (HH14 − LL14)、
 *   スロー %K = 生の %K の SMA3、%D = スロー %K の SMA3
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_RATE_MIN_N,
  barsInZone,
  baseRate,
  DEFAULT_TECH_PARAMS,
  ema,
  indicators,
  isTechParams,
  isTechParamValue,
  macd,
  quantile,
  rsi,
  sinceCross,
  sma,
  stochastic,
  zoneOf,
} from '../../model/technicals';

// 架空の足（Python の参照と同じ式: c = round((30000 + 200 sin(i/3) + 15 i) / 5) · 5、h = c + 10 + (37 i mod 40)、
// l = c − 10 − (53 i mod 35)）
const N = 45;
const C = Array.from(
  { length: N },
  (_, i) => Math.round((30000 + 200 * Math.sin(i / 3) + 15 * i) / 5) * 5,
);
const BARS = C.map((c, i) => ({ h: c + 10 + ((i * 37) % 40), l: c - 10 - ((i * 53) % 35), c }));

/** 決まった疑似乱数（線形合同法。テストの再現のため） */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function randomWalk(n: number, seed: number) {
  const r = lcg(seed);
  let c = 30000;
  return Array.from({ length: n }, () => {
    c = Math.max(1000, c + (r() - 0.5) * 400);
    const h = c + r() * 100;
    const l = c - r() * 100;
    return { h, l, c };
  });
}

describe('入力の写し（Python の参照と同じ足）', () => {
  it('先頭・末尾の値', () => {
    expect(C.slice(0, 5)).toEqual([30000, 30080, 30155, 30215, 30255]);
    expect(C.at(-1)).toBe(30835);
    expect(BARS[1]).toEqual({ h: 30127, l: 30052, c: 30080 });
  });
});

describe('SMA・EMA', () => {
  it('手計算: SMA3 と EMA3（α = 0.5、最初の 3 個の平均で始める）', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([2, 4, 6, 12], 3)).toEqual([null, null, 4, 8]);
  });
  it('先頭の null は飛ばし、窓に null があれば SMA は null', () => {
    expect(ema([null, null, 3, 3, 3, 9], 3)).toEqual([null, null, null, null, 3, 6]);
    expect(sma([1, null, 3, 4, 5], 2)).toEqual([null, null, null, 3.5, 4.5]);
  });
});

describe('RSI（Wilder）', () => {
  it('手計算: 期間 2', () => {
    // 変化 +1, +1, −1: 最初の平均 上げ 1・下げ 0 → 100、次は 上げ 0.5・下げ 0.5 → 50
    expect(rsi([1, 2, 3, 2], 2)).toEqual([null, null, 100, 50]);
  });
  it('参照値（Python）', () => {
    const r = rsi(C);
    expect(r.findIndex((v) => v !== null)).toBe(14);
    expect(r[14]).toBeCloseTo(50.92592593, 6);
    expect(r[20]).toBeCloseTo(74.42214395, 6);
    expect(r[30]).toBeCloseTo(55.28497689, 6);
    expect(r[44]).toBeCloseTo(79.88009482, 6);
  });
  it('一定の値は 50、上げだけは 100、下げだけは 0', () => {
    expect(rsi(new Array(20).fill(100)).at(-1)).toBe(50);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i)).at(-1)).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i)).at(-1)).toBe(0);
  });
  it('性質: どの乱歩でも 0〜100', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const v of rsi(randomWalk(300, seed).map((b) => b.c))) {
        if (v === null) continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('MACD（12, 26, 9）', () => {
  it('参照値（Python）', () => {
    const m = macd(C);
    expect(m.macd.findIndex((v) => v !== null)).toBe(25);
    expect(m.signal.findIndex((v) => v !== null)).toBe(33);
    expect(m.macd[25]).toBeCloseTo(153.3831663, 6);
    expect(m.macd[30]).toBeCloseTo(112.1220822, 6);
    expect(m.macd[44]).toBeCloseTo(151.4266199, 6);
    expect(m.signal[33]).toBeCloseTo(120.37068181, 6);
    expect(m.signal[40]).toBeCloseTo(89.88043828, 6);
    expect(m.hist[33]).toBeCloseTo(-51.27961055, 6);
    expect(m.hist[44]).toBeCloseTo(31.03313605, 6);
  });
  it('性質: 一定の値は MACD・シグナル・ヒストが 0、ヒスト = MACD − シグナル', () => {
    const flat = macd(new Array(60).fill(28000));
    expect(flat.macd.at(-1)).toBeCloseTo(0, 9);
    expect(flat.hist.at(-1)).toBeCloseTo(0, 9);
    const m = macd(randomWalk(200, 7).map((b) => b.c));
    for (let i = 0; i < 200; i++) {
      const a = m.macd[i];
      const s = m.signal[i];
      if (a === null || s === null || a === undefined || s === undefined) continue;
      expect(m.hist[i]).toBeCloseTo(a - s, 9);
    }
  });
  it('性質: 値を定数倍すると MACD も定数倍（尺度に比例）', () => {
    const c = randomWalk(120, 3).map((b) => b.c);
    const a = macd(c).macd.at(-1) as number;
    const b = macd(c.map((v) => v * 2)).macd.at(-1) as number;
    expect(b).toBeCloseTo(2 * a, 6);
  });
});

describe('スロー・ストキャスティクス（14, 3, 3）', () => {
  it('参照値（Python）', () => {
    const s = stochastic(BARS);
    expect(s.k.findIndex((v) => v !== null)).toBe(15);
    expect(s.d.findIndex((v) => v !== null)).toBe(17);
    expect(s.k[15]).toBeCloseTo(12.6746507, 6);
    expect(s.k[20]).toBeCloseTo(85.06295974, 6);
    expect(s.k[44]).toBeCloseTo(93.04262529, 6);
    expect(s.d[17]).toBeCloseTo(21.32401863, 6);
    expect(s.d[30]).toBeCloseTo(73.81179405, 6);
    expect(s.d[44]).toBeCloseTo(93.39838726, 6);
  });
  it('性質: 0〜100、高安の幅が 0 なら 50', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = stochastic(randomWalk(200, seed));
      for (const v of [...s.k, ...s.d]) {
        if (v === null) continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    const flat = stochastic(new Array(20).fill({ h: 100, l: 100, c: 100 }));
    expect(flat.d.at(-1)).toBe(50);
  });
});

describe('先読みしない（途中までの足の値 = 全部の足の同じ位置の値）', () => {
  it('RSI・MACD・ストキャス', () => {
    const bars = randomWalk(150, 11);
    const all = indicators(bars);
    const part = indicators(bars.slice(0, 100));
    for (let i = 0; i < 100; i++) {
      expect(part.rsi[i]).toBe(all.rsi[i]);
      expect(part.macd.hist[i]).toBe(all.macd.hist[i]);
      expect(part.stoch.k[i]).toBe(all.stoch.k[i]);
      expect(part.stoch.d[i]).toBe(all.stoch.d[i]);
    }
  });
});

describe('状態', () => {
  it('ゾーンと続いた本数', () => {
    expect(zoneOf(70, 70, 30)).toBe('high');
    expect(zoneOf(30, 70, 30)).toBe('low');
    expect(zoneOf(50, 70, 30)).toBe('mid');
    expect(zoneOf(null, 70, 30)).toBeNull();
    expect(barsInZone([null, 50, 75, 80, 72], 4, 70, 30)).toBe(3);
    expect(barsInZone([null, 50, 75, 80, 72], 1, 70, 30)).toBe(1);
    expect(barsInZone([null, 50], 0, 70, 30)).toBe(0);
  });
  it('交差から何本目（交差の足 = 1）', () => {
    const a = [null, 1, 2, 3, 2, 1];
    const b = [null, 2, 2, 2, 2, 2];
    expect(sinceCross(a, b, 3)).toEqual({ above: true, bars: 2, crossed: true });
    expect(sinceCross(a, b, 5)).toEqual({ above: false, bars: 1, crossed: true });
    expect(sinceCross(a, b, 1)).toEqual({ above: false, bars: 1, crossed: false });
    expect(sinceCross(a, b, 0)).toBeNull();
  });
});

describe('基準率', () => {
  it('分位（線形補間）', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1, 12);
    expect(quantile([5], 0.9)).toBe(5);
  });
  it('手計算: 窓を重ねない・最後の使える足まで', () => {
    // 1 本ごとに +1%（複利）: どの窓も 2 本先 = 2.01%
    const c = Array.from({ length: 11 }, (_, i) => 100 * 1.01 ** i);
    const r = baseRate(c, 2, 9, () => true);
    // j = 0, 2, 4, 6（j + 2 ≤ 9）→ 4 件
    expect(r.n).toBe(4);
    expect(r.median).toBeCloseTo(2.01, 9);
    expect(r.insufficient).toBe(true);
    // 条件: 偶数の位置だけでも窓は重ならない（j = 0, 2, 4, 6）。奇数だけ → 1, 3, 5, 7
    expect(baseRate(c, 2, 9, (j) => j % 2 === 1).n).toBe(4);
    // 条件に合う足が続くとき、窓の中の足は飛ばす（j = 0 を採ったら 1 は見ない）
    expect(baseRate(c, 3, 10, (j) => j <= 1).n).toBe(1);
  });
  it('分布: 中央値・p10・p90 と件数の下限', () => {
    // 騰落率が −2, −1, 0, 1, 2 % を繰り返す（1 本先）
    const c: number[] = [100];
    const steps = [-2, -1, 0, 1, 2];
    for (let i = 0; i < 40; i++)
      c.push((c.at(-1) as number) * (1 + (steps[i % 5] as number) / 100));
    const r = baseRate(c, 1, 40, () => true);
    expect(r.n).toBe(40);
    expect(r.median).toBeCloseTo(0, 9);
    expect(r.p10).toBeCloseTo(-2, 9);
    expect(r.p90).toBeCloseTo(2, 9);
    expect(r.insufficient).toBe(false);
    expect(BASE_RATE_MIN_N).toBe(20);
  });
  it('valid が false の窓（限月交代をまたぐ）は除いて数え、次の足を見る', () => {
    const c = Array.from({ length: 11 }, (_, i) => 100 + i);
    // 窓 [j, j+2] が 4〜5 の間をまたぐなら除く（4 と 5 の間で交代）
    const m = (i: number) => (i <= 4 ? 'a' : 'b');
    const r = baseRate(
      c,
      2,
      10,
      () => true,
      (a, b) => m(a) === m(b),
    );
    // j = 0（0→2）採る、2（2→4）採る、4（4→6）除く、5（5→7）採る、7（7→9）採る、9 は 11 > 10
    expect(r.n).toBe(4);
    expect(r.excluded).toBe(1);
  });
  it('未来の値で条件を決めない: 条件は j までで、結果は j + N の値だけ', () => {
    const c = [100, 110, 90, 120, 80];
    // 最後の足（確定前）は使わない: lastUsable = 3 → j + 1 ≤ 3
    const r = baseRate(c, 1, 3, () => true);
    expect(r.n).toBe(3);
  });
});

describe('期間（#205）', () => {
  const bars = Array.from({ length: 120 }, (_, i) => {
    const c = 30000 + 200 * Math.sin(i / 5) + 3 * i;
    return { h: c + 30, l: c - 30, c };
  });
  it('indicators は渡した期間で計算し、params に写す。既定は DEFAULT_TECH_PARAMS', () => {
    const p = {
      rsi: 9,
      macdFast: 8,
      macdSlow: 21,
      macdSignal: 5,
      stochK: 9,
      stochSmooth: 1,
      stochD: 4,
    };
    const ind = indicators(bars, p);
    const closes = bars.map((b) => b.c);
    expect(ind.params).toEqual(p);
    expect(ind.rsi).toEqual(rsi(closes, 9));
    expect(ind.macd).toEqual(macd(closes, 8, 21, 5));
    expect(ind.stoch).toEqual(stochastic(bars, 9, 1, 4));
    expect(indicators(bars).params).toEqual(DEFAULT_TECH_PARAMS);
    // 最初の値の位置が期間で動く（RSI(9) は index 9 から）
    expect(ind.rsi[8]).toBeNull();
    expect(ind.rsi[9]).not.toBeNull();
  });
  it('isTechParams: 範囲内の整数で MACD は短期 < 長期', () => {
    expect(isTechParams(DEFAULT_TECH_PARAMS)).toBe(true);
    expect(isTechParams({ ...DEFAULT_TECH_PARAMS, macdFast: 26 })).toBe(false);
    expect(isTechParams({ ...DEFAULT_TECH_PARAMS, rsi: 101 })).toBe(false);
    expect(isTechParams({ ...DEFAULT_TECH_PARAMS, stochD: 0 })).toBe(false);
    expect(isTechParams({ ...DEFAULT_TECH_PARAMS, rsi: 9.5 })).toBe(false);
    expect(isTechParams(null)).toBe(false);
    expect(isTechParamValue('stochSmooth', 1)).toBe(true);
    expect(isTechParamValue('rsi', 1)).toBe(false);
  });
});

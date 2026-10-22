import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import { fairPosition, isTightNode, smileFairIvs, smileFairValue } from '../../model/fairValue';
import { buildSmile, PiecewiseLinearSmile, type SmileFit, type SmileNode } from '../../model/smile';
import { optionTick, roundOptionPrice, shiftOptionTicks } from '../../model/tick';
import { makeStrikes, rng, synthChain } from '../support/synthChain';

/** 架空の値（#264）。 */
const F = 67810;
const T = 30.5 / 365;
const R = 0.005;

function node(k: number, iv: number, fwd: number, over: Partial<SmileNode> = {}): SmileNode {
  return {
    k,
    x: Math.log(k / fwd),
    iv,
    type: k < fwd ? 'put' : 'call',
    source: 'mid',
    bidIv: iv - 0.005,
    askIv: iv + 0.005,
    midIv: iv,
    bandWidth: 0.01,
    unstable: false,
    ...over,
  };
}

/** 節点だけの SmileFit（smile は使わない = smileFairValue は nodes から作り直す） */
function fitOf(nodes: SmileNode[]): SmileFit {
  return { smile: null as never, nodes };
}

describe('理論価格（smileFairValue、#264）', () => {
  // Hull『Options, Futures, and Other Derivatives』Black's model の数値例
  // （F0 = 20, K = 20, r = 9%, σ = 25%, T = 4 か月 → put = 1.12）。周りの節点の IV がどれも 25% なら同じ値
  it('文献値: 平らな 25% の節点の間（K = F）で Hull の put = 1.12', () => {
    const f = 20;
    const fit = fitOf([node(18, 0.25, f), node(22, 0.25, f)]);
    const v = smileFairValue(fit, f, 4 / 12, 0.09, 20, 'put');
    expect(v?.price).toBeCloseTo(1.12, 2);
    expect(v?.iv).toBeCloseTo(0.25, 12);
    expect(v?.mark).toBe('interpolated');
  });

  it('総分散を x で線形に補間した IV で Black-76（既存の式だけ）', () => {
    const a = node(60000, 0.3, F);
    const b = node(62000, 0.26, F);
    const k = 61000;
    const x = Math.log(k / F);
    const t = (x - a.x) / (b.x - a.x);
    const w = a.iv ** 2 * T * (1 - t) + b.iv ** 2 * T * t;
    const iv = Math.sqrt(w / T);
    const v = smileFairValue(fitOf([a, b]), F, T, R, k, 'put');
    expect(v?.iv).toBeCloseTo(iv, 12);
    expect(v?.price).toBeCloseTo(black76Price('put', F, k, T, iv, R), 9);
  });

  it('その行自身・広い行・片側・不安定の節点は使わない（その行の気配を動かしても値が変わらない）', () => {
    const base = [node(60000, 0.3, F), node(62000, 0.26, F)];
    const k = 61000;
    const ref = smileFairValue(fitOf(base), F, T, R, k, 'put');
    const variants: SmileNode[] = [
      node(k, 0.6, F), // その行（どんな IV でも）
      node(60500, 0.9, F, { bidIv: 0.8, askIv: 1.0 }), // 広い（IV の差 20pt）
      node(61500, 0.9, F, { source: 'ask', bidIv: null }), // ask だけ
      node(60800, 0.9, F, { unstable: true }), // 不安定
    ];
    for (const extra of variants) {
      const v = smileFairValue(fitOf([...base, extra]), F, T, R, k, 'put');
      expect(v?.price).toBeCloseTo(ref?.price as number, 9);
    }
  });

  it('狭い節点の外側は外挿、2 本未満・F / T / K が不正なら null', () => {
    const fit = fitOf([node(60000, 0.3, F), node(62000, 0.26, F), node(64000, 0.23, F)]);
    expect(smileFairValue(fit, F, T, R, 55000, 'put')?.mark).toBe('extrapolated');
    expect(smileFairValue(fit, F, T, R, 66000, 'put')?.mark).toBe('extrapolated');
    expect(smileFairValue(fit, F, T, R, 61000, 'put')?.mark).toBe('interpolated');
    // 端の節点の行は自身を除くので、残りの外側 = 外挿
    expect(smileFairValue(fit, F, T, R, 60000, 'put')?.mark).toBe('extrapolated');
    expect(
      smileFairValue(fitOf([node(60000, 0.3, F), node(61000, 0.28, F)]), F, T, R, 60000, 'put'),
    ).toBeNull();
    expect(smileFairValue(null, F, T, R, 61000, 'put')).toBeNull();
    expect(smileFairValue(fit, Number.NaN, T, R, 61000, 'put')).toBeNull();
    expect(smileFairValue(fit, F, 0, R, 61000, 'put')).toBeNull();
    expect(smileFairValue(fit, F, T, R, 0, 'put')).toBeNull();
  });

  it('isTightNode: 5pt ちょうどは狭い、超えると広い', () => {
    expect(isTightNode(node(60000, 0.3, F, { bidIv: 0.275, askIv: 0.325 }))).toBe(true);
    expect(isTightNode(node(60000, 0.3, F, { bidIv: 0.27, askIv: 0.33 }))).toBe(false);
  });

  it('性質（種 7・合成の板 20 枚）: 有限で正、put と call は同じ IV で PCP を満たす', () => {
    const rand = rng(7);
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const f = 60000 + Math.floor(rand() * 15000);
      const t = (5 + rand() * 80) / 365;
      const { rows } = synthChain({ F: f, T: t, r: R, seed: 100 + i });
      const fit = buildSmile(rows, f, t, R);
      for (const row of rows) {
        const p = smileFairValue(fit, f, t, R, row.k, 'put');
        const c = smileFairValue(fit, f, t, R, row.k, 'call');
        if (!p || !c) continue;
        n++;
        expect(Number.isFinite(p.price) && p.price > 0).toBe(true);
        expect(Number.isFinite(c.price) && c.price > 0).toBe(true);
        expect(c.iv).toBe(p.iv);
        expect(c.price - p.price).toBeCloseTo(Math.exp(-R * t) * (f - row.k), 6);
      }
    }
    expect(n).toBeGreaterThan(500);
  });
});

describe('合成の板での回復（遠い OTM の安い put、#264 AC1）', () => {
  // 周りの行は呼値 1 本のスプレッド（気配の狭い行）。真の価格 ≈ 10 円の遠い OTM の put を選び、
  // その行の気配だけを bid 2 呼値下・ask 7 呼値上に広げる（mid が真の価格からずれる。値は架空）
  const { rows, trueVol } = synthChain({
    F,
    T,
    r: R,
    seed: 21,
    spreadTicks: [1, 1],
    strikes: makeStrikes(F, 0.65),
  });
  const target = rows
    .filter((r) => r.k < F * 0.85)
    .map((r) => ({
      k: r.k,
      theo: black76Price('put', F, r.k, T, trueVol.get(r.k) as number, R),
    }))
    .reduce((best, r) => (Math.abs(r.theo - 10) < Math.abs(best.theo - 10) ? r : best));

  it('対象の行は真の価格が一桁〜十数円', () => {
    expect(target.theo).toBeGreaterThan(5);
    expect(target.theo).toBeLessThan(20);
  });

  it('気配を非対称に広げても、理論価格は真の価格から ±呼値以内（補間）', () => {
    const p = roundOptionPrice(target.theo);
    const wide = rows.map((r) =>
      r.k === target.k
        ? { ...r, put: { bid: shiftOptionTicks(p, -2), ask: shiftOptionTicks(p, 7), last: null } }
        : r,
    );
    const fit = buildSmile(wide, F, T, R);
    const v = smileFairValue(fit, F, T, R, target.k, 'put');
    expect(v).not.toBeNull();
    expect(v?.mark).toBe('interpolated');
    expect(Math.abs((v?.price as number) - target.theo)).toBeLessThanOrEqual(
      optionTick(target.theo),
    );
    // 広げた行の mid は真の価格から呼値より離れている（mid では足りないケース）
    const q = wide.find((r) => r.k === target.k)?.put;
    const mid = ((q?.bid as number) + (q?.ask as number)) / 2;
    expect(Math.abs(mid - target.theo)).toBeGreaterThan(optionTick(target.theo));
    // 位置: 理論価格は bid 寄り（mid より下）
    expect(fairPosition(v?.price as number, q?.bid ?? null, q?.ask ?? null)).toBe('near_bid');
    // 広げる前の板でも同じ値（その行の気配は使わない）
    const v0 = smileFairValue(buildSmile(rows, F, T, R), F, T, R, target.k, 'put');
    expect(v0?.price).toBeCloseTo(v?.price as number, 9);
  });

  it('気配の狭い行より外の翼（ask だけ・不安定）では外挿の印', () => {
    const fit = buildSmile(rows, F, T, R);
    const tight = (fit?.nodes ?? []).filter((n) => isTightNode(n)).map((n) => n.k);
    const lowest = Math.min(...tight);
    const out = rows.find((r) => r.k < lowest);
    expect(out).toBeDefined();
    expect(smileFairValue(fit, F, T, R, out?.k as number, 'put')?.mark).toBe('extrapolated');
  });
});

describe('板の全行を 1 回で（smileFairIvs）', () => {
  it('種 9・合成の板 10 枚: 1 本ずつその行を除いて作り直した値と一致（節点の端・内側・節点でない行）', () => {
    const rand = rng(9);
    for (let i = 0; i < 10; i++) {
      const f = 62000 + Math.floor(rand() * 10000);
      const t = (3 + rand() * 60) / 365;
      const { rows } = synthChain({
        F: f,
        T: t,
        r: R,
        seed: 300 + i,
        strikes: makeStrikes(f, 0.6),
      });
      const fit = buildSmile(rows, f, t, R);
      const ks = rows.map((r) => r.k);
      const got = smileFairIvs(fit, f, t, ks);
      ks.forEach((k, j) => {
        // 参照: その行を除いた狭い節点で作り直す（素朴な実装）
        const nodes = (fit?.nodes ?? []).filter((n) => n.k !== k && isTightNode(n));
        const want =
          nodes.length < 2
            ? null
            : new PiecewiseLinearSmile(
                nodes.map((n) => ({ x: n.x, w: n.iv * n.iv * t })),
                t,
                'slope',
                2,
                f,
              );
        const x = Math.log(k / f);
        if (!want) expect(got[j]).toBeNull();
        else {
          expect(got[j]?.iv).toBeCloseTo(want.sigma(x), 12);
          expect(got[j]?.mark).toBe(
            want.mark(x) === 'extrapolated' ? 'extrapolated' : 'interpolated',
          );
        }
      });
    }
  });

  it('外挿の行（翼）: 有限・正で、put は K に増加・call は K に減少（#1 の指摘。値の正しさは保証しない）', () => {
    const { rows } = synthChain({ F, T, r: R, seed: 21, strikes: makeStrikes(F, 0.65, 0.4) });
    const fit = buildSmile(rows, F, T, R);
    const ks = rows.map((r) => r.k);
    const ivs = smileFairIvs(fit, F, T, ks);
    // 狭い節点でない行（同じ 1 本のスマイル）。端の狭い節点の行はその行を除いた別の 1 本なので並びの比較から外す
    const tight = new Set((fit?.nodes ?? []).filter((n) => isTightNode(n)).map((n) => n.k));
    const ext = ks
      .map((k, j) => ({ k, f: ivs[j] }))
      .filter((e) => e.f?.mark === 'extrapolated' && !tight.has(e.k));
    const left = ext.filter((e) => e.k < F);
    const right = ext.filter((e) => e.k > F);
    expect(left.length).toBeGreaterThan(1);
    expect(right.length).toBeGreaterThan(1);
    const price = (e: (typeof ext)[number], type: 'put' | 'call') =>
      black76Price(type, F, e.k, T, e.f?.iv as number, R);
    for (let i = 1; i < left.length; i++) {
      const a = price(left[i - 1] as (typeof ext)[number], 'put');
      const b = price(left[i] as (typeof ext)[number], 'put');
      expect(a > 0 && Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(a);
    }
    for (let i = 1; i < right.length; i++) {
      const a = price(right[i - 1] as (typeof ext)[number], 'call');
      const b = price(right[i] as (typeof ext)[number], 'call');
      expect(b > 0 && Number.isFinite(a)).toBe(true);
      expect(b).toBeLessThanOrEqual(a);
    }
  });
});

describe('fairPosition', () => {
  it('両側気配: 1/3・2/3 で区切る', () => {
    expect(fairPosition(5, 7, 13)).toBe('below_bid');
    expect(fairPosition(7, 7, 13)).toBe('near_bid');
    expect(fairPosition(9, 7, 13)).toBe('near_bid');
    expect(fairPosition(10, 7, 13)).toBe('middle');
    expect(fairPosition(11, 7, 13)).toBe('near_ask');
    expect(fairPosition(13, 7, 13)).toBe('near_ask');
    expect(fairPosition(13.1, 7, 13)).toBe('above_ask');
  });
  it('片側だけ・気配なし', () => {
    expect(fairPosition(5, null, 13)).toBe('below_ask');
    expect(fairPosition(14, null, 13)).toBe('above_ask');
    expect(fairPosition(8, 7, null)).toBe('above_bid');
    expect(fairPosition(6, 7, null)).toBe('below_bid');
    expect(fairPosition(6, null, null)).toBeNull();
    expect(fairPosition(6, 0, null)).toBeNull();
  });
});

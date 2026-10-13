import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import { impliedVol } from '../../model/iv';
import {
  buildNode,
  buildSmile,
  checkArbitrage,
  PiecewiseLinearSmile,
  smileAtStrikes,
} from '../../model/smile';
import { synthChain } from '../support/synthChain';

const F = 67810;
const T = 30.5 / 365;
const R = 0.005;

describe('スマイル（OTM 側・総分散の区分線形、AC4）', () => {
  const dropped = [66750, 69125];
  const { rows, trueVol } = synthChain({ F, T, r: R, seed: 11, drop: dropped });
  const fit = buildSmile(rows, F, T, R);

  it('OTM 側の行だけを節点にする（K < F は put、K > F は call）', () => {
    expect(fit).not.toBeNull();
    for (const n of fit?.nodes ?? []) expect(n.type).toBe(n.k < F ? 'put' : 'call');
  });

  it('ATM ±10% の気配のある行は補間なし（節点）で、IV = mid の IV', () => {
    const ks = rows.map((r) => r.k).filter((k) => Math.abs(k / F - 1) <= 0.1);
    const out = smileAtStrikes(fit as NonNullable<typeof fit>, ks, F);
    for (const s of out) {
      if (dropped.includes(s.k)) continue;
      expect(s.mark).toBe('node');
      const row = rows.find((r) => r.k === s.k);
      const q = s.k < F ? row?.put : row?.call;
      const mid = ((q?.bid ?? 0) + (q?.ask ?? 0)) / 2;
      const iv = impliedVol(s.k < F ? 'put' : 'call', mid, F, s.k, T, R);
      expect(iv.ok && Math.abs(iv.sigma - s.iv)).toBeLessThan(1e-12);
      // 真の IV とは呼値丸め・スプレッドの分だけずれる（ATM ±10% では 0.5pt 以内）
      expect(Math.abs(s.iv - (trueVol.get(s.k) ?? 0))).toBeLessThan(0.005);
    }
  });

  it('欠損行には「補間」の印、節点の外には「外挿」の印', () => {
    const out = smileAtStrikes(fit as NonNullable<typeof fit>, [...dropped, 10000, 120000], F);
    expect(out.map((o) => o.mark)).toEqual([
      'interpolated',
      'interpolated',
      'extrapolated',
      'extrapolated',
    ]);
    for (const o of out) expect(Number.isFinite(o.iv)).toBe(true);
  });

  it('補間後に K 単調性とバタフライ ≥ 0（丸めない板。板の行使価格 + 細かい格子）', () => {
    const exact = synthChain({ F, T, r: R, exactHalfSpread: 2, drop: dropped });
    const ef = buildSmile(exact.rows, F, T, R);
    expect(ef).not.toBeNull();
    const smile = (ef as NonNullable<typeof ef>).smile;
    expect(
      checkArbitrage(
        smile,
        exact.rows.map((r) => r.k),
        F,
        T,
        R,
      ),
    ).toEqual([]);
    const fine = Array.from({ length: 480 }, (_, i) => 30000 + i * 125);
    expect(checkArbitrage(smile, fine, F, T, R)).toEqual([]);
  });

  it('呼値で丸めた板は mid 自体が凸性を崩すので、検査が違反を見つけて印にできる', () => {
    const smile = (fit as NonNullable<typeof fit>).smile;
    const v = checkArbitrage(
      smile,
      rows.map((r) => r.k),
      F,
      T,
      R,
    );
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(Number.isFinite(x.amount) && x.amount > 0).toBe(true);
  });

  it('ask ≤ 5 円・帯 5pt 超の行は不安定として節点から外す', () => {
    const unstable = fit?.nodes.filter((n) => n.unstable) ?? [];
    expect(unstable.length).toBeGreaterThan(0);
    for (const n of unstable) {
      const row = rows.find((r) => r.k === n.k);
      const q = n.type === 'put' ? row?.put : row?.call;
      expect((q?.ask ?? 0) <= 5 || (n.bandWidth ?? 1) > 0.05).toBe(true);
      expect(fit?.smile.mark(n.x)).not.toBe('node');
    }
  });

  it('節点の IV の優先順位: mid → 片側 → 約定', () => {
    const k = 64000;
    const p = black76Price('put', F, k, T, 0.29, R);
    const both = buildNode(k, 'put', { bid: Math.round(p) - 5, ask: Math.round(p) + 5 }, F, T, R);
    expect(both?.source).toBe('mid');
    const bidOnly = buildNode(k, 'put', { bid: Math.round(p), ask: null }, F, T, R);
    expect(bidOnly?.source).toBe('bid');
    const askOnly = buildNode(k, 'put', { bid: null, ask: Math.round(p) }, F, T, R);
    expect(askOnly?.source).toBe('ask');
    const trade = buildNode(k, 'put', { bid: null, ask: null, last: Math.round(p) }, F, T, R);
    expect(trade?.source).toBe('trade');
    expect(buildNode(k, 'put', { bid: null, ask: null }, F, T, R)).toBeNull();
  });
});

describe('翼の外挿（Lee の傾き ≤ 2 にクランプ）', () => {
  const T1 = 0.1;
  it('端の区間の傾きで延ばし、|傾き| が 2 を超えるときは 2 に', () => {
    // 左端の傾き −3（クランプされて −2）、右端の傾き +0.5
    const steep = new PiecewiseLinearSmile(
      [
        { x: -0.2, w: 0.31 },
        { x: -0.1, w: 0.01 },
        { x: 0.1, w: 0.01 },
        { x: 0.2, w: 0.06 },
      ],
      T1,
    );
    expect(steep.totalVariance(-0.3)).toBeCloseTo(0.31 + 2 * 0.1, 12);
    expect(steep.totalVariance(0.4)).toBeCloseTo(0.06 + 0.5 * 0.2, 12);
    expect(steep.mark(-0.3)).toBe('extrapolated');
    expect(steep.mark(-0.1)).toBe('node');
    expect(steep.mark(0)).toBe('interpolated');
  });

  it('w が翼で減る向きの傾きは水平に（総分散が負にならない）、水平モードも選べる', () => {
    const s = new PiecewiseLinearSmile(
      [
        { x: -0.1, w: 0.01 },
        { x: 0, w: 0.02 },
        { x: 0.1, w: 0.015 },
      ],
      T1,
    );
    expect(s.totalVariance(-1)).toBeCloseTo(0.01, 12);
    expect(s.totalVariance(1)).toBeCloseTo(0.015, 12);
    const flat = new PiecewiseLinearSmile(
      [
        { x: -0.1, w: 0.03 },
        { x: 0, w: 0.02 },
      ],
      T1,
      'flat',
    );
    expect(flat.totalVariance(-2)).toBeCloseTo(0.03, 12);
    const one = new PiecewiseLinearSmile([{ x: 0, w: 0.02 }], T1);
    expect(one.sigma(0.5)).toBeCloseTo(Math.sqrt(0.2), 12);
  });

  it('補間は総分散 w = σ²T で線形', () => {
    const s = new PiecewiseLinearSmile(
      [
        { x: 0, w: 0.04 * T1 },
        { x: 0.2, w: 0.09 * T1 },
      ],
      T1,
    );
    expect(s.sigma(0.1)).toBeCloseTo(Math.sqrt(0.065), 12);
  });
});

describe('裁定の検査が違反を見つける', () => {
  it('総分散が急に落ちる（凹な折れ）とバタフライ違反', () => {
    const T1 = 30 / 365;
    const s = new PiecewiseLinearSmile(
      [
        { x: -0.05, w: 0.5 * 0.5 * T1 },
        { x: 0, w: 0.1 * 0.1 * T1 },
        { x: 0.05, w: 0.5 * 0.5 * T1 },
      ],
      T1,
    );
    const ks = Array.from({ length: 41 }, (_, i) => 64000 + i * 200);
    const v = checkArbitrage(s, ks, 67810, T1, 0.005);
    expect(v.length).toBeGreaterThan(0);
  });
});

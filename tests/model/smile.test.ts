import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import { isTightNode } from '../../model/fairValue';
import { impliedVol } from '../../model/iv';
import {
  atTheForwardNode,
  buildNode,
  buildSmile,
  checkArbitrage,
  PiecewiseLinearSmile,
  type SmileNode,
  smileAtStrikes,
  WING_FIT_WIDTH,
  wingMonotoneBound,
  wingRegressionSlope,
} from '../../model/smile';
import { makeStrikes, rng, synthChain } from '../support/synthChain';

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
        exact.rows,
      ),
    ).toEqual([]);
    const fine = Array.from({ length: 480 }, (_, i) => 30000 + i * 125);
    expect(checkArbitrage(smile, fine, F, T, R)).toEqual([]);
  });

  it('呼値で丸めた板: 許容（bid–ask 幅の和の半分）を超える違反の印は全行の 3% 未満', () => {
    for (const seed of [1, 2, 3, 4, 5, 11]) {
      const chain = synthChain({ F, T, r: R, seed });
      const f = buildSmile(chain.rows, F, T, R);
      if (!f) throw new Error('スマイルが作れない');
      const ks = chain.rows.map((r) => r.k);
      const v = checkArbitrage(f.smile, ks, F, T, R, chain.rows);
      expect(v.length).toBeLessThan(ks.length * 0.03);
      for (const x of v) expect(x.amount).toBeGreaterThan(x.allowance);
    }
  });

  it('わざと崩した行（OTM の put の気配を +150 円）は検出される', () => {
    for (const seed of [1, 2, 3]) {
      const bad = 66000;
      const chain = synthChain({ F, T, r: R, seed });
      const broken = chain.rows.map((r) =>
        r.k === bad
          ? { ...r, put: { bid: (r.put.bid ?? 0) + 150, ask: (r.put.ask ?? 0) + 150, last: null } }
          : r,
      );
      const f = buildSmile(broken, F, T, R);
      if (!f) throw new Error('スマイルが作れない');
      const v = checkArbitrage(
        f.smile,
        broken.map((r) => r.k),
        F,
        T,
        R,
        broken,
      );
      expect(v.some((x) => x.kind === 'butterfly' && x.k === bad)).toBe(true);
    }
  });

  it('K = F の行: 安定な側だけで平均（片側だけ安定ならその側、両方不安定なら平均して不安定）', () => {
    const node = (type: 'call' | 'put', iv: number, unstable: boolean) => ({
      k: F,
      x: 0,
      iv,
      type,
      source: 'mid' as const,
      bidIv: null,
      askIv: null,
      midIv: iv,
      bandWidth: 0.001,
      unstable,
    });
    expect(atTheForwardNode(node('call', 0.24, false), node('put', 0.26, false))).toMatchObject({
      iv: 0.25,
      unstable: false,
    });
    expect(atTheForwardNode(node('call', 0.24, true), node('put', 0.26, false))).toMatchObject({
      iv: 0.26,
      type: 'put',
      unstable: false,
    });
    expect(atTheForwardNode(node('call', 0.24, false), node('put', 0.26, true))).toMatchObject({
      iv: 0.24,
      type: 'call',
      unstable: false,
    });
    expect(atTheForwardNode(node('call', 0.24, true), node('put', 0.26, true))).toMatchObject({
      iv: 0.25,
      unstable: true,
    });
    expect(atTheForwardNode(null, node('put', 0.26, true))?.type).toBe('put');
    expect(atTheForwardNode(null, null)).toBeNull();
    // 板から: F と同じ行使価格の行があると、その行が節点になる
    const chain = synthChain({ F: 67750, T, r: R, seed: 2 });
    const f = buildSmile(chain.rows, 67750, T, R);
    expect(f?.nodes.filter((n) => n.k === 67750).length).toBe(1);
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
  it('端の区間の傾きで延ばし、|傾き| を Lee の上限 2 と端の点での K 単調性の上限でクランプ', () => {
    const steep = new PiecewiseLinearSmile(
      [
        { x: -0.2, w: 1.5 },
        { x: -0.1, w: 1.2 },
        { x: 0.1, w: 0.01 },
        { x: 0.2, w: 0.06 },
      ],
      T1,
    );
    // 左端の傾き −3 → Lee の上限 2 でクランプ（この点の単調性の上限は 2 より大きい）
    expect(wingMonotoneBound(-0.2, 1.5, 'left')).toBeGreaterThan(2);
    expect(steep.totalVariance(-0.3)).toBeCloseTo(1.5 + 2 * 0.1, 12);
    // 右端の傾き 0.5 → 端の点で call が K に増加しない上限（約 0.33）でクランプ
    const cap = wingMonotoneBound(0.2, 0.06, 'right');
    expect(cap).toBeLessThan(0.5);
    expect(steep.totalVariance(0.4)).toBeCloseTo(0.06 + cap * 0.2, 12);
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

describe('翼の傾きは翼の側の複数の節点の回帰（#268）', () => {
  // Hull『Options, Futures, and Other Derivatives』Black's model の数値例
  // （F0 = 20, K = 20, r = 9%, σ = 25%, T = 4 か月 → put = 1.12）。両翼に平らな 25% の節点を 4 本ずつ置くと、
  // 回帰の傾きは 0 で翼も 25%（外挿の位置でも Black-76 の 25% の値）
  it('文献値: 平らな 25% の節点で Hull の put = 1.12、翼（外挿）も σ = 25%', () => {
    const f = 20;
    const t = 4 / 12;
    const r = 0.09;
    const ks = [16, 17, 18, 19, 20, 21, 22, 23, 24];
    const s = new PiecewiseLinearSmile(
      ks.map((k) => ({ x: Math.log(k / f), w: 0.25 * 0.25 * t })),
      t,
    );
    expect(black76Price('put', f, 20, t, s.sigma(0), r)).toBeCloseTo(1.12, 2);
    expect(Math.abs(black76Price('put', f, 20, t, s.sigma(0), r) - 1.12)).toBeLessThan(0.005);
    for (const k of [10, 12, 14, 26, 30, 40]) {
      const x = Math.log(k / f);
      expect(s.mark(x)).toBe('extrapolated');
      expect(s.sigma(x)).toBeCloseTo(0.25, 12);
    }
  });

  // 左翼: x < 0 で左端 −0.30 から 0.2 以内の 4 本（−0.05 は 0.25 離れているので外す）。
  // 右翼: x > 0 の 3 本（x = 0 と左側の節点は使わない）。手計算の最小二乗の傾き:
  // 左 Σdx·dw / Σdx² = −0.13、右 0.000063 / 0.0026 = 63/2600
  const pts = [
    { x: -0.3, w: 0.04 },
    { x: -0.25, w: 0.031 },
    { x: -0.2, w: 0.026 },
    { x: -0.15, w: 0.02 },
    { x: -0.05, w: 0.012 },
    { x: 0, w: 0.01 },
    { x: 0.05, w: 0.0062 },
    { x: 0.1, w: 0.0071 },
    { x: 0.12, w: 0.008 },
  ];
  const xs = pts.map((p) => p.x);
  const ws = pts.map((p) => p.w);

  it('範囲（翼の側・端から |Δx| ≤ 0.2）の節点の最小二乗の傾き', () => {
    expect(WING_FIT_WIDTH).toBe(0.2);
    expect(wingRegressionSlope(xs, ws, 'left')).toBeCloseTo(-0.13, 12);
    expect(wingRegressionSlope(xs, ws, 'right')).toBeCloseTo(63 / 2600, 12);
    // 端の 2 本の傾き（今まで）は −0.18 / 0.045 で、回帰とは違う
    expect(
      ((ws[1] as number) - (ws[0] as number)) / ((xs[1] as number) - (xs[0] as number)),
    ).toBeCloseTo(-0.18, 12);
    // 範囲の外・反対側の節点をどう動かしても変わらない
    const moved = ws.map((w, i) =>
      (xs[i] as number) >= -0.05 && (xs[i] as number) <= 0 ? w * 3 : w,
    );
    expect(wingRegressionSlope(xs, moved, 'left')).toBeCloseTo(-0.13, 12);
    expect(wingRegressionSlope(xs, moved, 'right')).toBeCloseTo(63 / 2600, 12);
    // スマイルの翼は端の節点から回帰の傾きで延ばす（補間と連続。クランプは効かない大きさ）
    const T1 = 0.1;
    const s = new PiecewiseLinearSmile(pts, T1);
    expect(-0.13).toBeGreaterThan(-wingMonotoneBound(-0.3, 0.04, 'left'));
    expect(63 / 2600).toBeLessThan(wingMonotoneBound(0.12, 0.008, 'right'));
    expect(s.totalVariance(-0.5)).toBeCloseTo(0.04 + 0.13 * 0.2, 12);
    expect(s.totalVariance(0.3)).toBeCloseTo(0.008 + (63 / 2600) * 0.18, 12);
    expect(s.totalVariance(-0.3)).toBeCloseTo(0.04, 12);
    expect(s.totalVariance(0.12)).toBeCloseTo(0.008, 12);
  });

  it('範囲の節点が 2 本未満なら端の 2 本の傾き、節点 1 本以下は 0', () => {
    // 右翼の側（x > 0）が 1 本だけ → 端の 2 本（x = 0 と 0.1）
    const one = [-0.2, -0.1, 0, 0.1];
    const w1 = [0.03, 0.02, 0.01, 0.014];
    expect(wingRegressionSlope(one, w1, 'right')).toBeCloseTo(0.04, 12);
    // 左翼の端から 0.2 以内の節点が端だけ → 端の 2 本
    const far = [-0.6, -0.1, 0.1];
    const w2 = [0.05, 0.02, 0.02];
    expect(wingRegressionSlope(far, w2, 'left')).toBeCloseTo(-0.06, 12);
    // 範囲が 2 本ちょうどなら回帰 = 端の 2 本
    expect(wingRegressionSlope([-0.2, -0.1, 0.05], [0.03, 0.02, 0.01], 'left')).toBeCloseTo(
      -0.1,
      12,
    );
    expect(wingRegressionSlope([0.1], [0.01], 'left')).toBe(0);
    expect(wingRegressionSlope([], [], 'right')).toBe(0);
  });

  it('回帰の傾きにもクランプ（翼で w が減る向きは水平・Lee の 2・端の点の K 単調性）', () => {
    const T1 = 0.1;
    // 左翼の回帰が正（w が左で減る）→ 水平
    const down = new PiecewiseLinearSmile(
      [
        { x: -0.3, w: 0.01 },
        { x: -0.2, w: 0.015 },
        { x: -0.1, w: 0.02 },
        { x: 0.1, w: 0.02 },
      ],
      T1,
    );
    expect(down.totalVariance(-1)).toBeCloseTo(0.01, 12);
    // 左翼の回帰が −3 → Lee の 2
    const steep = new PiecewiseLinearSmile(
      [
        { x: -0.3, w: 1.5 },
        { x: -0.2, w: 1.2 },
        { x: -0.1, w: 0.9 },
        { x: 0.1, w: 0.1 },
      ],
      T1,
    );
    expect(wingMonotoneBound(-0.3, 1.5, 'left')).toBeGreaterThan(2);
    expect(steep.totalVariance(-0.4)).toBeCloseTo(1.5 + 2 * 0.1, 12);
    // 右翼の回帰 0.5 → 端の点の K 単調性の上限（2 より小さい）
    const right = new PiecewiseLinearSmile(
      [
        { x: -0.1, w: 0.02 },
        { x: 0.1, w: 0.01 },
        { x: 0.15, w: 0.035 },
        { x: 0.2, w: 0.06 },
      ],
      T1,
    );
    expect(
      wingRegressionSlope([-0.1, 0.1, 0.15, 0.2], [0.02, 0.01, 0.035, 0.06], 'right'),
    ).toBeCloseTo(0.5, 12);
    const cap = wingMonotoneBound(0.2, 0.06, 'right');
    expect(cap).toBeLessThan(0.5);
    expect(right.totalVariance(0.4)).toBeCloseTo(0.06 + cap * 0.2, 12);
  });

  // 端の節点の折れ: 回帰の傾きは端から 0.2 の弦の傾きなので、凸なスマイルでは端の区間の傾きより小さく、端の節点で
  // w がわずかに凹に折れる（丸めない板で 50〜100 円刻みのバタフライが最小 −0.12 円程度）。検査の許容（bid–ask 幅の和の半分）より
  // ずっと小さいので、厳密な ≥ 0 ではなく半呼値（−0.5 円）と checkArbitrage の違反 0 で確かめる
  it('性質（種 5・丸めない板 20 枚・満期 3〜90 日）: 翼を含む細かい格子で call は K に非増加・put は非減少・バタフライは半呼値より上で検査の違反 0、有限・正', () => {
    const rand = rng(5);
    for (let i = 0; i < 20; i++) {
      const f = 55000 + Math.floor(rand() * 20000);
      const t = (3 + rand() * 87) / 365;
      const r = 0.005;
      const { rows } = synthChain({
        F: f,
        T: t,
        r,
        exactHalfSpread: 0.5,
        strikes: makeStrikes(f, 0.6, 0.3),
      });
      const fit = buildSmile(rows, f, t, r);
      if (!fit) throw new Error('スマイルが作れない');
      // 板の外（0.2F〜1.8F）まで 100 円刻み
      const ks = Array.from({ length: Math.floor((1.6 * f) / 100) }, (_, j) => 0.2 * f + j * 100);
      const call = ks.map((k) =>
        black76Price('call', f, k, t, fit.smile.sigma(Math.log(k / f)), r),
      );
      const put = ks.map((k) => black76Price('put', f, k, t, fit.smile.sigma(Math.log(k / f)), r));
      // 破れた所を集めて最後に 1 回で確かめる（expect を格子の点ごとに呼ぶと遅い）
      const bad: string[] = [];
      let minFly = 0;
      for (let j = 0; j < ks.length; j++) {
        const c = call[j] as number;
        const p = put[j] as number;
        if (!(Number.isFinite(c) && Number.isFinite(p) && c >= 0 && p >= 0)) bad.push(`価格 ${j}`);
        if (j === 0) continue;
        if (c > (call[j - 1] as number) + 1e-9) bad.push(`call 単調 ${j}`);
        if (p < (put[j - 1] as number) - 1e-9) bad.push(`put 単調 ${j}`);
        if (j + 1 < ks.length) {
          minFly = Math.min(minFly, (call[j - 1] as number) - 2 * c + (call[j + 1] as number));
        }
      }
      expect(bad).toEqual([]);
      expect(minFly).toBeGreaterThanOrEqual(-0.5);
      expect(checkArbitrage(fit.smile, ks, f, t, r)).toEqual([]);
    }
  });
});

describe('合成の板: 翼の回帰は端の 2 本より真の価格に近い（#268。#264 のレビューの例）', () => {
  const F0 = 67810;
  /** 今までの翼（端の 2 本の傾き。クランプは同じ）。比べるための参照 */
  function twoPointWing(pts: { x: number; w: number }[], T1: number) {
    const n = pts.length;
    const p0 = pts[0] as { x: number; w: number };
    const p1 = pts[1] as { x: number; w: number };
    const pm = pts[n - 2] as { x: number; w: number };
    const pn = pts[n - 1] as { x: number; w: number };
    const sL = (p1.w - p0.w) / (p1.x - p0.x);
    const sR = (pn.w - pm.w) / (pn.x - pm.x);
    const lc = Math.min(2, wingMonotoneBound(p0.x, p0.w, 'left'));
    const rc = Math.min(2, wingMonotoneBound(pn.x, pn.w, 'right'));
    const left = Math.min(0, Math.max(sL, -lc));
    const right = Math.max(0, Math.min(sR, rc));
    return (x: number) =>
      Math.sqrt(Math.max(x <= p0.x ? p0.w + left * (x - p0.x) : pn.w + right * (x - pn.x), 0) / T1);
  }

  interface Stats {
    err: number[];
    outside: number;
    quoted: number;
    fly: number;
  }
  const quantile = (v: number[], q: number) =>
    [...v].sort((a, b) => a - b)[Math.floor(v.length * q)] as number;

  /** 翼の側 side の、節点より外の行（真の価格 0.05 円以上）で 2 つの翼を比べる */
  function compare(days: number[], side: 'left' | 'right', which: 'fair' | 'smile') {
    const out = {
      two: { err: [], outside: 0, quoted: 0, fly: 0 } as Stats,
      reg: { err: [], outside: 0, quoted: 0, fly: 0 } as Stats,
    };
    for (const d of days) {
      const T1 = d / 365;
      for (let seed = 1; seed <= 30; seed++) {
        const { rows, trueVol } = synthChain({
          F: F0,
          T: T1,
          r: R,
          seed,
          strikes: makeStrikes(F0, 0.65),
        });
        const fit = buildSmile(rows, F0, T1, R);
        if (!fit) continue;
        const nodes: SmileNode[] = fit.nodes.filter((n) =>
          which === 'fair' ? isTightNode(n) : !n.unstable,
        );
        if (nodes.length < 2) continue;
        const pts = nodes.map((n) => ({ x: n.x, w: n.iv * n.iv * T1 }));
        const reg = new PiecewiseLinearSmile(pts, T1);
        const two = twoPointWing(pts, T1);
        const end = (side === 'right' ? nodes[nodes.length - 1] : nodes[0]) as SmileNode;
        const ext = rows.filter((r) => (side === 'right' ? r.k > end.k : r.k < end.k));
        const type = side === 'right' ? 'call' : 'put';
        for (const [name, sigma] of [
          ['two', two],
          ['reg', (x: number) => reg.sigma(x)],
        ] as const) {
          const st = out[name];
          for (const r of ext) {
            const truth = black76Price(type, F0, r.k, T1, trueVol.get(r.k) as number, R);
            if (truth < 0.05) continue;
            const p = black76Price(type, F0, r.k, T1, sigma(Math.log(r.k / F0)), R);
            st.err.push(Math.abs(p - truth));
            const q = type === 'call' ? r.call : r.put;
            if (q.ask !== null) {
              st.quoted++;
              if (p > q.ask || (q.bid !== null && p < q.bid)) st.outside++;
            }
          }
          // 端の節点と外の行の call の凸性（バタフライ < 0 の件数）
          const ks = [...ext.map((r) => r.k), end.k].sort((a, b) => a - b);
          const c = ks.map((k) =>
            black76Price('call', F0, k, T1, k === end.k ? end.iv : sigma(Math.log(k / F0)), R),
          );
          for (let j = 1; j + 1 < ks.length; j++) {
            const lam =
              ((ks[j + 1] as number) - (ks[j] as number)) /
              ((ks[j + 1] as number) - (ks[j - 1] as number));
            const fly =
              lam * (c[j - 1] as number) + (1 - lam) * (c[j + 1] as number) - (c[j] as number);
            if (fly < -1e-6) st.fly++;
          }
        }
      }
    }
    return out;
  }

  const cases = [
    {
      name: 'call の翼・3〜8 日・理論価格（気配の狭い節点）',
      days: [3, 5, 8],
      side: 'right',
      which: 'fair',
      maxOutside: 0.03,
    },
    {
      name: 'call の翼・3〜8 日・今のスマイル（安定な節点）',
      days: [3, 5, 8],
      side: 'right',
      which: 'smile',
      maxOutside: 0.1,
    },
    {
      name: 'put の翼・30 日・理論価格',
      days: [30],
      side: 'left',
      which: 'fair',
      maxOutside: 0.03,
    },
    {
      name: 'put の翼・30 日・今のスマイル',
      days: [30],
      side: 'left',
      which: 'smile',
      maxOutside: 0.2,
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: 誤差の中央値・p90、気配の外の割合、バタフライ < 0 がどれも小さい`, () => {
      const { two, reg } = compare([...c.days], c.side, c.which);
      expect(reg.err.length).toBeGreaterThan(500);
      expect(reg.err.length).toBe(two.err.length);
      // 中央値・p90 とも端の 2 本の半分未満
      expect(quantile(reg.err, 0.5)).toBeLessThan(quantile(two.err, 0.5) / 2);
      expect(quantile(reg.err, 0.9)).toBeLessThan(quantile(two.err, 0.9) / 2);
      // 気配の外: 端の 2 本は 18〜41%、回帰は 1 割前後以下
      expect(two.outside / two.quoted).toBeGreaterThan(0.15);
      expect(reg.outside / reg.quoted).toBeLessThan(c.maxOutside);
      expect(reg.outside).toBeLessThan(two.outside / 2);
      // 凹（バタフライ < 0）: 端の 2 本は数百件、回帰は 0
      expect(two.fly).toBeGreaterThan(100);
      expect(reg.fly).toBe(0);
    });
  }
});

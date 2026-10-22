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
  type Smile,
  type SmileNode,
  smileAtStrikes,
  WING_FIT_WIDTH,
  WING_KINK_YEN,
  wingKinkBound,
  wingMonotoneBound,
  wingRegressionSlope,
} from '../../model/smile';
import { makeStrikes, makeSvi, rng, type SviParams, synthChain } from '../support/synthChain';

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

  // 端の節点の折れ: 回帰の傾きは範囲の平均的な傾きなので、凸なスマイルでは端の区間の傾きより緩く、端の節点で w が
  // わずかに凹に折れる。その不足は端の区間の間隔の格子で WING_KINK_YEN（1 円）以下に抑える（下の「端の節点の折れの下限」）。
  // 丸めない板では下限は効かず（折れが小さい）、100 円刻みの C₀ − 2C₁ + C₂ の最小は −0.12 円（種 5 の 20 枚で観測）。
  // 観測に近い −0.15 円で固定し、checkArbitrage（許容 = 幅の和の半分）の違反 0 も確かめる
  it('性質（種 5・丸めない板 20 枚・満期 3〜90 日）: 翼を含む細かい格子で call は K に非増加・put は非減少・端の折れの C₀ − 2C₁ + C₂ ≥ −0.15 円で検査の違反 0、有限・正', () => {
    const rand = rng(5);
    let minFly = 0;
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
      expect(checkArbitrage(fit.smile, ks, f, t, r)).toEqual([]);
    }
    expect(minFly).toBeGreaterThanOrEqual(-0.15);
    expect(minFly).toBeLessThan(0);
  });

  // 端の節点の折れの下限（#268 のレビュー）: 翼の傾きが端の区間の傾きより Δs 緩いと、端の節点で ∂C/∂K が
  // φ(d₂)·Δs / (2√w) だけ下に跳ぶ。下限は「端の区間の間隔 h（円）の格子で (C₀ + C₂)/2 − C₁ の不足 ≈ h × 跳び / 2 ≤ 1 円」（1:−2:1 では 2 円）
  it('端の節点の折れの下限: 回帰が緩すぎると端の区間の傾き − wingKinkBound に止め、跳びは数値微分と一致', () => {
    const T1 = 5 / 365;
    const f = 60000;
    // 右翼: 端の区間（0.03 → 0.04）が急で、範囲の回帰は緩い（端の 1 本だけ IV が高い。丸めの雑音の形）
    const pts = [
      { x: -0.04, w: 0.0016 },
      { x: -0.02, w: 0.0012 },
      { x: 0, w: 0.001 },
      { x: 0.01, w: 0.00095 },
      { x: 0.02, w: 0.0009 },
      { x: 0.03, w: 0.00088 },
      { x: 0.04, w: 0.00105 },
    ];
    const xs = pts.map((p) => p.x);
    const ws = pts.map((p) => p.w);
    const seg = (0.00105 - 0.00088) / 0.01;
    const reg = wingRegressionSlope(xs, ws, 'right');
    const h = f * (Math.exp(0.04) - Math.exp(0.03));
    const bound = wingKinkBound(0.04, 0.00105, (2 * WING_KINK_YEN) / h);
    expect(reg).toBeLessThan(seg - bound);
    const cap = wingMonotoneBound(0.04, 0.00105, 'right');
    expect(seg - bound).toBeLessThan(cap);
    const s = new PiecewiseLinearSmile(pts, T1, 'slope', 2, f);
    const want = seg - bound;
    expect(s.totalVariance(0.1)).toBeCloseTo(0.00105 + want * 0.06, 12);
    // F を渡さなければ下限なし（回帰の傾き）
    expect(new PiecewiseLinearSmile(pts, T1).totalVariance(0.1)).toBeCloseTo(
      0.00105 + Math.max(0, reg) * 0.06,
      12,
    );
    // ∂C/∂K の跳び（端の節点の左右の数値微分の差）は 2 × 1 円 / h、間隔 h の格子の (C₀ + C₂)/2 − C₁ の不足は 1 円
    const kn = f * Math.exp(0.04);
    const c = (k: number) => black76Price('call', f, k, T1, s.sigma(Math.log(k / f)), 0);
    const e = 0.01;
    const jump = (c(kn) - c(kn - e)) / e - (c(kn + e) - c(kn)) / e;
    expect(jump).toBeCloseTo((2 * WING_KINK_YEN) / h, 4);
    // 折れの無い参照（端の区間の傾きのまま延ばす）と比べた (C₀ + C₂)/2 − C₁ の不足は一次の近似で h × 跳び / 2 = 1 円。
    // 外側ほど ∂C/∂w が小さいので実際はそれ以下（この例で 0.71 円）
    const ref = new PiecewiseLinearSmile([...pts, { x: 0.3, w: 0.00105 + seg * 0.26 }], T1);
    const cRef = (k: number) => black76Price('call', f, k, T1, ref.sigma(Math.log(k / f)), 0);
    const fly = (k: (v: number) => number) => (k(kn - h) + k(kn + h)) / 2 - k(kn);
    const deficit = fly(cRef) - fly(c);
    expect(deficit).toBeGreaterThan(0.6 * WING_KINK_YEN);
    expect(deficit).toBeLessThanOrEqual(WING_KINK_YEN);
    // 回帰が端の区間より急なら下限は効かない（左翼。凸の向き）
    expect(wingKinkBound(-0.04, 0.0016, 0)).toBe(0);
  });
});

// 種 40 の合成の板を何百枚も作るので 1 件 1〜5 秒かかる（既定の 5 秒では負荷の高いときに落ちる）
describe('合成の板: 翼の回帰は端の 2 本より真の価格に近い（#268。#264 のレビューの例）', {
  timeout: 60_000,
}, () => {
  const F0 = 67810;
  type Pt = { x: number; w: number };
  /** 今までの翼（端の 2 本の傾き。クランプは同じ）。比べるための参照 */
  class TwoPointWing implements Smile {
    private readonly inner: PiecewiseLinearSmile;
    private readonly left: number;
    private readonly right: number;
    private readonly p0: Pt;
    private readonly pn: Pt;
    constructor(
      pts: Pt[],
      readonly T: number,
    ) {
      this.inner = new PiecewiseLinearSmile(pts, T);
      const n = pts.length;
      const p0 = pts[0] as Pt;
      const p1 = pts[1] as Pt;
      const pm = pts[n - 2] as Pt;
      const pn = pts[n - 1] as Pt;
      this.p0 = p0;
      this.pn = pn;
      const lc = Math.min(2, wingMonotoneBound(p0.x, p0.w, 'left'));
      const rc = Math.min(2, wingMonotoneBound(pn.x, pn.w, 'right'));
      this.left = Math.min(0, Math.max((p1.w - p0.w) / (p1.x - p0.x), -lc));
      this.right = Math.max(0, Math.min((pn.w - pm.w) / (pn.x - pm.x), rc));
    }
    totalVariance(x: number): number {
      if (x <= this.p0.x) return Math.max(this.p0.w + this.left * (x - this.p0.x), 0);
      if (x >= this.pn.x) return Math.max(this.pn.w + this.right * (x - this.pn.x), 0);
      return this.inner.totalVariance(x);
    }
    sigma(x: number): number {
      return Math.sqrt(this.totalVariance(x) / this.T);
    }
    mark(x: number) {
      return this.inner.mark(x);
    }
  }
  const METHODS = {
    two: (pts: Pt[], T1: number): Smile => new TwoPointWing(pts, T1),
    reg: (pts: Pt[], T1: number): Smile => new PiecewiseLinearSmile(pts, T1, 'slope', 2, F0),
    flat: (pts: Pt[], T1: number): Smile => new PiecewiseLinearSmile(pts, T1, 'flat'),
  };
  type Name = keyof typeof METHODS;

  interface Stats {
    err: number[];
    outside: number;
    quoted: number;
    fly: number;
    /** 外挿の傾きが 0 でない（水平でない）板の数 */
    sloped: number;
  }
  const quantile = (v: number[], q: number) =>
    [...v].sort((a, b) => a - b)[Math.floor(v.length * q)] as number;

  /** 翼の側 side の、節点より外の行（真の価格 0.05 円以上）で翼の延ばし方を比べる（種 1〜40）。同じ引数は 1 回だけ数える */
  const memo = new Map<string, Record<Name, Stats>>();
  function compare(
    days: readonly number[],
    side: 'left' | 'right',
    which: 'fair' | 'smile',
    svi?: (T: number) => SviParams,
    high = 0.25,
  ) {
    const key = `${days.join(',')}|${side}|${which}|${svi ? 'up' : ''}|${high}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const out = compareRaw(days, side, which, svi, high);
    memo.set(key, out);
    return out;
  }
  function compareRaw(
    days: readonly number[],
    side: 'left' | 'right',
    which: 'fair' | 'smile',
    svi?: (T: number) => SviParams,
    high = 0.25,
  ) {
    const out = {} as Record<Name, Stats>;
    for (const name of Object.keys(METHODS) as Name[]) {
      out[name] = { err: [], outside: 0, quoted: 0, fly: 0, sloped: 0 };
    }
    for (const d of days) {
      const T1 = d / 365;
      for (let seed = 1; seed <= 40; seed++) {
        const { rows, trueVol } = synthChain({
          F: F0,
          T: T1,
          r: R,
          seed,
          strikes: makeStrikes(F0, 0.65, high),
          ...(svi && { svi: svi(T1) }),
        });
        const fit = buildSmile(rows, F0, T1, R);
        if (!fit) continue;
        const nodes: SmileNode[] = fit.nodes.filter((n) =>
          which === 'fair' ? isTightNode(n) : !n.unstable,
        );
        if (nodes.length < 2) continue;
        const pts = nodes.map((n) => ({ x: n.x, w: n.iv * n.iv * T1 }));
        const end = (side === 'right' ? nodes[nodes.length - 1] : nodes[0]) as SmileNode;
        const ext = rows.filter((r) => (side === 'right' ? r.k > end.k : r.k < end.k));
        const type = side === 'right' ? 'call' : 'put';
        for (const name of Object.keys(METHODS) as Name[]) {
          const smile = METHODS[name](pts, T1);
          const st = out[name];
          const xe = Math.log(end.k / F0);
          const away = side === 'right' ? 0.1 : -0.1;
          if (Math.abs(smile.totalVariance(xe + away) - end.iv * end.iv * T1) > 1e-12) st.sloped++;
          for (const r of ext) {
            const truth = black76Price(type, F0, r.k, T1, trueVol.get(r.k) as number, R);
            if (truth < 0.05) continue;
            const p = black76Price(type, F0, r.k, T1, smile.sigma(Math.log(r.k / F0)), R);
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
            black76Price(
              'call',
              F0,
              k,
              T1,
              k === end.k ? end.iv : smile.sigma(Math.log(k / F0)),
              R,
            ),
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

  const days38 = [3, 4, 5, 6, 7, 8];
  const skewUp = (T1: number) => makeSvi(T1, 0.25, 0.7, Math.log(0.6), -0.3);
  // 理論価格（気配の狭い節点）は回帰がほぼそのまま効く。今のスマイル（安定な節点。片側の気配の行も入る）は端の区間が
  // 急なことが多く、折れの下限（1 円）で端の 2 本の傾きに寄る分だけ改善が小さい（p90 はほぼ変わらない）
  const cases = [
    {
      name: 'call の翼・3〜8 日・理論価格（気配の狭い節点）',
      days: days38,
      side: 'right',
      which: 'fair',
      maxOutside: 0.03,
    },
    {
      name: 'call の翼・3〜8 日・今のスマイル（安定な節点）',
      days: days38,
      side: 'right',
      which: 'smile',
      maxOutside: 0.2,
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
      maxOutside: 0.3,
    },
    {
      name: 'call の翼・3〜8 日・理論価格・右翼が上がるスマイル（ρ −0.3・call 50% まで）',
      days: days38,
      side: 'right',
      which: 'fair',
      maxOutside: 0.03,
      svi: skewUp,
      high: 0.5,
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: 誤差の中央値・p90、気配の外の割合、バタフライ < 0 が端の 2 本より小さい`, () => {
      const { two, reg } = compare(
        c.days,
        c.side,
        c.which,
        'svi' in c ? c.svi : undefined,
        'high' in c ? c.high : undefined,
      );
      const fair = c.which === 'fair';
      expect(reg.err.length).toBeGreaterThan(500);
      expect(reg.err.length).toBe(two.err.length);
      expect(quantile(reg.err, 0.5)).toBeLessThan(quantile(two.err, 0.5) / 2);
      expect(quantile(reg.err, 0.9)).toBeLessThan(quantile(two.err, 0.9) * (fair ? 0.5 : 1));
      // 気配の外: 端の 2 本は 18〜41%
      expect(two.outside / two.quoted).toBeGreaterThan(0.15);
      expect(reg.outside / reg.quoted).toBeLessThan(c.maxOutside);
      expect(reg.outside).toBeLessThan(two.outside * (fair ? 0.5 : 0.6));
      // 凹（バタフライ < 0）: 端の 2 本は数百件。理論価格では 0、今のスマイルでも半分未満
      expect(two.fly).toBeGreaterThan(100);
      if (fair) expect(reg.fly).toBe(0);
      else expect(reg.fly).toBeLessThan(two.fly / 2);
    });
  }

  // 既定の合成のスマイル（ρ −0.7）では右翼の範囲が ATM 側の下りを含み、回帰の傾きが ≤ 0 → 水平になる（call の上の 2 場面は
  // 実質「水平」）。右翼が上がるスマイルでは回帰が水平と別の値になり、中央値で水平より良いことを固定する
  it('右翼が上がるスマイル（ρ −0.3）: 回帰の傾きは 0 でなく（水平と別）、誤差の中央値は水平以下', () => {
    // 既定のスマイルでは回帰はほぼ水平（傾きが付くのは折れの下限が効いた少数の板だけ）
    const def = compare(days38, 'right', 'fair');
    expect(def.reg.sloped).toBeLessThanOrEqual(10);
    const up = compare(days38, 'right', 'fair', skewUp, 0.5);
    expect(up.reg.sloped).toBeGreaterThan(50);
    expect(up.flat.sloped).toBe(0);
    expect(quantile(up.reg.err, 0.5)).toBeLessThanOrEqual(quantile(up.flat.err, 0.5));
  });

  // 呼値で丸めた板の裁定の検査（checkArbitrage。許容 = 幅の和の半分）の印は、端の 2 本の翼より増えない（折れの下限 1 円）。
  // 下限なしの回帰では端の節点の凹の折れで 80 枚あたり 0〜6 件増えた（#268 のレビュー）
  it('丸めた板（種 40 × 行使価格 2 種 × 満期 7 種）: 裁定の印の数が端の 2 本より増えない', () => {
    const days = [2, 3, 5, 8, 15, 30, 60];
    let two = 0;
    let reg = 0;
    let free = 0;
    for (const d of days) {
      const T1 = d / 365;
      for (let seed = 1; seed <= 40; seed++) {
        for (const strikes of [makeStrikes(F0, 0.65), makeStrikes(F0)]) {
          const { rows } = synthChain({ F: F0, T: T1, r: R, seed, strikes });
          const fit = buildSmile(rows, F0, T1, R);
          if (!fit) continue;
          const pts = fit.nodes
            .filter((n) => !n.unstable)
            .map((n) => ({ x: n.x, w: n.iv * n.iv * T1 }));
          const ks = rows.map((r) => r.k);
          const marks = (s: Smile) => checkArbitrage(s, ks, F0, T1, R, rows).length;
          two += marks(METHODS.two(pts, T1));
          reg += marks(fit.smile);
          free += marks(new PiecewiseLinearSmile(pts, T1));
        }
      }
    }
    expect(reg).toBeLessThanOrEqual(two);
    // 下限が効いている（下限なしでは増える）ことも固定
    expect(free).toBeGreaterThan(two);
  });
});

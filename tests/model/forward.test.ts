import { describe, expect, it } from 'vitest';
import { buildBoxes, estimateForward } from '../../model/forward';
import { synthChain } from '../support/synthChain';

// 架空の板: F* = 67,810（1 限月、T = 30.5 日）、67,885（2 限月、T = 58.5 日）
const CASES = [
  { F: 67810, T: 30.5 / 365 },
  { F: 67885, T: 58.5 / 365 },
  { F: 52345, T: 9 / 365 },
];
const R = 0.005;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

describe('F の推定（PCP の無裁定の箱、AC5）', () => {
  it.each(CASES)('通常の板（呼値 1〜3 本のスプレッド）から F* = $F を ±10 円で回復', ({ F, T }) => {
    for (const seed of SEEDS) {
      const { rows } = synthChain({ F, T, r: R, seed });
      // 窓の中心は先物価格（限月違いで 150 円ずれている想定）
      const est = estimateForward(rows, T, R, F + 150, F + 150);
      expect(est.method).not.toBe('future_fallback');
      expect(Math.abs(est.forward - F)).toBeLessThanOrEqual(10);
      expect(est.uncertainty).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([500, -500])('外れ値（1 ペアだけ %d 円ずらす）を除いて ±10 円', (shift) => {
    const { F, T } = CASES[0] as (typeof CASES)[number];
    for (const seed of SEEDS) {
      const { rows } = synthChain({ F, T, r: R, seed, outlier: { k: 68000, shift } });
      const est = estimateForward(rows, T, R, F, F + 150);
      expect(est.outliers.map((b) => b.k)).toContain(68000);
      expect(est.used.map((b) => b.k)).not.toContain(68000);
      expect(Math.abs(est.forward - F)).toBeLessThanOrEqual(10);
    }
  });

  it('広いスプレッド（ATM ±5% で片側 12〜18 呼値 = 120〜180 円）でも ±30 円', () => {
    for (const { F, T } of CASES) {
      for (const seed of SEEDS) {
        const { rows } = synthChain({ F, T, r: R, seed, atmSpreadTicks: [12, 18] });
        const est = estimateForward(rows, T, R, F - 200, F - 200);
        expect(Math.abs(est.forward - F)).toBeLessThanOrEqual(30);
      }
    }
  });

  it('広いスプレッド + 外れ値でも ±30 円', () => {
    const { F, T } = CASES[0] as (typeof CASES)[number];
    for (const seed of SEEDS) {
      const { rows } = synthChain({
        F,
        T,
        r: R,
        seed,
        atmSpreadTicks: [12, 18],
        outlier: { k: 67500, shift: 500 },
      });
      const est = estimateForward(rows, T, R, F, F);
      expect(Math.abs(est.forward - F)).toBeLessThanOrEqual(30);
    }
  });

  it('箱は真の F を含む（生成器の bid ≤ 理論価格 ≤ ask の確認）', () => {
    const { F, T } = CASES[0] as (typeof CASES)[number];
    const { rows } = synthChain({ F, T, r: R, seed: 3 });
    const boxes = buildBoxes(rows, T, R, F, 0.04);
    expect(boxes.length).toBeGreaterThan(20);
    for (const b of boxes) {
      expect(b.lo).toBeLessThanOrEqual(F + 1e-6);
      expect(b.hi).toBeGreaterThanOrEqual(F - 1e-6);
    }
  });

  it('交差が空なら幅の逆数で重み付けした中央値', () => {
    // 箱を手で作る（r = 0）: 幅 2 円の箱を F0 − 8〜−6 と F0 + 4〜+6 に交互に置くと交差は空
    const F0 = 60000;
    const offsets = [-8, 4, -8, 4, -8, 4, 4];
    const rows = offsets.map((o, i) => {
      const k = 59750 + i * 125;
      const c = F0 - k + 1000 + o + 2; // 箱 = [F0 + o, F0 + o + 2]
      return { k, call: { bid: c - 1, ask: c }, put: { bid: 1000, ask: 1001 } };
    });
    const est = estimateForward(rows, 0.1, 0, F0, null);
    expect(est.method).toBe('weighted_median');
    expect(est.forward).toBeGreaterThanOrEqual(F0 - 8);
    expect(est.forward).toBeLessThanOrEqual(F0 + 6);
    expect(est.uncertainty).toBeGreaterThan(0);
  });

  it('ペアが 5 組未満なら先物にフォールバック', () => {
    const { F, T } = CASES[0] as (typeof CASES)[number];
    const { rows } = synthChain({ F, T, r: R, seed: 1 });
    const near = rows.filter((r) => Math.abs(r.k - F) < 300);
    const est = estimateForward(near, T, R, F, 67880);
    expect(est.method).toBe('future_fallback');
    expect(est.forward).toBe(67880);
    expect(estimateForward([], T, R, F, null).forward).toBeNaN();
  });
});

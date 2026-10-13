import { describe, expect, it } from 'vitest';
import { black76Price, discountedIntrinsic } from '../../model/black76';
import { impliedVol, ivResolutionBand } from '../../model/iv';
import { T_MIN_YEARS } from '../../model/time';
import { rng } from '../support/synthChain';

describe('IV 逆算（Newton + 二分法）', () => {
  it('価格 → IV → 価格のラウンドトリップが 0.01 円（AC3）、σ は 1e-6', () => {
    const rand = rng(7);
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const F = 20000 + rand() * 80000;
      const K = F * (0.5 + rand() * 0.9);
      const T = (0.5 + rand() * 364) / 365;
      const s = 0.05 + rand() * 1.45;
      const r = rand() * 0.02;
      const type = rand() < 0.5 ? 'call' : 'put';
      const price = black76Price(type, F, K, T, s, r);
      // 時間価値が実質 0（価格が割引本源的価値と浮動小数で区別できない）なら解なしが正しい
      if (price - discountedIntrinsic(type, F, K, T, r) < 1e-7) continue;
      const res = impliedVol(type, price, F, K, T, r);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(Math.abs(black76Price(type, F, K, T, res.sigma, r) - price)).toBeLessThan(0.01);
      // ベガが十分あるところでは σ 自体も 1e-6 で戻る
      if (price > 1) expect(Math.abs(res.sigma - s)).toBeLessThan(1e-6);
      n++;
    }
    expect(n).toBeGreaterThan(1500);
  });

  it('割引本源的価値以下・上限以上・T ≤ T_min は解なし', () => {
    const F = 67810;
    const T = 30 / 365;
    const intrinsic = discountedIntrinsic('call', F, 60000, T, 0.005);
    expect(impliedVol('call', intrinsic, F, 60000, T, 0.005)).toEqual({
      ok: false,
      reason: 'below_intrinsic',
    });
    expect(impliedVol('call', intrinsic - 1, F, 60000, T, 0.005)).toEqual({
      ok: false,
      reason: 'below_intrinsic',
    });
    expect(impliedVol('call', F, F, 60000, T, 0.005)).toEqual({ ok: false, reason: 'above_upper' });
    expect(impliedVol('put', 70000, F, 70000, T, 0.005)).toEqual({
      ok: false,
      reason: 'above_upper',
    });
    expect(impliedVol('put', 100, F, 60000, T_MIN_YEARS, 0.005)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(impliedVol('put', 100, F, 60000, 0, 0.005)).toEqual({ ok: false, reason: 'expired' });
    expect(impliedVol('put', Number.NaN, F, 60000, T, 0.005)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('ファー OTM の 1 円・極端な IV でも解ける', () => {
    const F = 67810;
    const T = 30.5 / 365;
    for (const [k, p] of [
      [40000, 1],
      [40000, 5],
      [30000, 1],
      [85000, 1],
    ] as const) {
      const type = k < F ? 'put' : 'call';
      const res = impliedVol(type, p, F, k, T, 0.005);
      expect(res.ok).toBe(true);
      if (res.ok)
        expect(Math.abs(black76Price(type, F, k, T, res.sigma, 0.005) - p)).toBeLessThan(1e-6);
    }
  });
});

describe('IV の分解能の帯（価格 ±0.5 円）', () => {
  const F = 67810;
  const T = 30.5 / 365;
  it('ATM は帯が狭く、ファー OTM の数円は広い', () => {
    const atm = ivResolutionBand(
      'call',
      black76Price('call', F, 67750, T, 0.25, 0.005),
      F,
      67750,
      T,
      0.005,
    );
    expect(atm).not.toBeNull();
    expect((atm?.width ?? 1) * 100).toBeLessThan(0.05);
    // 呼値 1 円が IV で数 pt に当たる（設計 4.4: ask ≤ 20 円で 1〜3pt、1 円の行はさらに広い）
    const wing = ivResolutionBand('put', 1, F, 40000, T, 0.005);
    expect(wing).not.toBeNull();
    expect((wing?.width ?? 0) * 100).toBeGreaterThan(4);
    const wing3 = ivResolutionBand('put', 3, F, 42000, T, 0.005);
    expect((wing3?.width ?? 0) * 100).toBeGreaterThan(1);
    expect(wing?.lo).toBeLessThan(wing?.hi ?? 0);
  });

  it('価格 − 0.5 が本源的価値を割る行は下端 0（帯は σ まるごと）', () => {
    const band = ivResolutionBand('put', 0.3, F, 40000, T, 0.005);
    expect(band?.lo).toBe(0);
    expect(Number.isFinite(band?.hi ?? Number.NaN)).toBe(true);
  });
});

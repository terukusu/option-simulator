import { describe, expect, it } from 'vitest';
import {
  clampViewport,
  clipSegment,
  type Domain,
  extent,
  linear,
  niceTicks,
  panBy,
  pinchViewport,
  pixelToValue,
  wheelFactor,
  zoom,
  zoomAt,
} from '../../ui/chart/scale';

describe('scale（グラフの座標の純関数）', () => {
  it('linear: domain → range（逆向きの range も可）、幅 0 は中央', () => {
    const f = linear([0, 10], [100, 0]);
    expect(f(0)).toBe(100);
    expect(f(10)).toBe(0);
    expect(f(2.5)).toBe(75);
    expect(linear([5, 5], [0, 200])(123)).toBe(100);
  });

  it('niceTicks: 1・2・5 の刻みで範囲内', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(47_750, 87_875, 5)).toEqual([50_000, 60_000, 70_000, 80_000]);
    const t = niceTicks(-0.123, 0.31, 5);
    expect(t).toEqual([-0.1, 0, 0.1, 0.2, 0.3]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });

  it('extent: 有限値だけ', () => {
    expect(extent([3, Number.NaN, -1, Number.POSITIVE_INFINITY, 2])).toEqual([-1, 3]);
    expect(extent([])).toBeNull();
  });

  describe('zoom（ボタンの拡大・縮小）', () => {
    const full = [0, 1000] as const;
    it('中心を固定して幅を倍率倍', () => {
      expect(zoom([200, 600], 0.5, full)).toEqual([300, 500]);
      expect(zoom([300, 500], 2, full)).toEqual([200, 600]);
    });
    it('全域の外に出ない（平行移動）・全域より広げない', () => {
      expect(zoom([0, 200], 2, full)).toEqual([0, 400]);
      expect(zoom([800, 1000], 2, full)).toEqual([600, 1000]);
      expect(zoom([0, 1000], 2, full)).toEqual([0, 1000]);
    });
    it('最小幅で止まる', () => {
      expect(zoom([400, 600], 0.1, full, 50)).toEqual([475, 525]);
    });
  });

  it('clipSegment: x で切って y を線形補間、範囲外は null', () => {
    expect(clipSegment(0, 0, 10, 100, 5, 20)).toEqual([5, 50, 10, 100]);
    expect(clipSegment(10, 100, 0, 0, 5, 20)).toEqual([10, 100, 5, 50]);
    expect(clipSegment(0, 0, 10, 100, 2, 4)).toEqual([2, 20, 4, 40]);
    expect(clipSegment(0, 0, 10, 100, 11, 20)).toBeNull();
  });

  describe('拡大・パン・ピンチ（#11 AC-4。損益グラフとスマイルで共用）', () => {
    const full: Domain = [30_000, 90_000];
    const range: Domain = [50, 1050];
    const minWidth = 250;
    const inFull = (d: Domain) => {
      expect(d[0]).toBeGreaterThanOrEqual(full[0]);
      expect(d[1]).toBeLessThanOrEqual(full[1]);
      expect(d[1] - d[0]).toBeGreaterThanOrEqual(minWidth - 1e-9);
    };

    it('clampViewport: 幅を [最小幅, 全幅] に収め、全域の外に出ない。幅が収まっていれば端を保つ', () => {
      expect(clampViewport([40_000, 50_000], full, minWidth)).toEqual([40_000, 50_000]);
      expect(clampViewport([20_000, 25_000], full, minWidth)).toEqual([30_000, 35_000]);
      expect(clampViewport([85_000, 95_000], full, minWidth)).toEqual([80_000, 90_000]);
      expect(clampViewport([0, 200_000], full, minWidth)).toEqual(full);
      expect(clampViewport([50_000, 50_010], full, minWidth)).toEqual([49_880, 50_130]);
      expect(clampViewport([Number.NaN, 1], full, minWidth)).toEqual(full);
    });

    it('zoomAt: 倍率 1.1 の拡大を 10 回 → 幅は単調に減り、カーソル位置の値の画素は不変（1e-6 px）', () => {
      let v: Domain = [40_000, 80_000];
      const px = 300;
      const anchor = pixelToValue(v, range, px);
      let prevWidth = v[1] - v[0];
      for (let i = 0; i < 10; i++) {
        v = zoomAt(v, 1 / 1.1, anchor, full, minWidth);
        const w = v[1] - v[0];
        expect(w).toBeLessThan(prevWidth);
        prevWidth = w;
        expect(Math.abs(linear(v, range)(anchor) - px)).toBeLessThan(1e-6);
        inFull(v);
      }
      for (let i = 0; i < 10; i++) {
        v = zoomAt(v, 1.1, anchor, full, minWidth);
        const w = v[1] - v[0];
        expect(w).toBeGreaterThan(prevWidth);
        prevWidth = w;
        expect(Math.abs(linear(v, range)(anchor) - px)).toBeLessThan(1e-6);
      }
    });

    it('縮小を繰り返すと全域でちょうど止まり、拡大を繰り返すと最小幅で止まる', () => {
      let v: Domain = [55_000, 60_000];
      for (let i = 0; i < 60; i++) v = zoomAt(v, 1.1, 57_000, full, minWidth);
      expect(v).toEqual(full);
      for (let i = 0; i < 200; i++) v = zoomAt(v, 1 / 1.1, 41_234, full, minWidth);
      expect(v[1] - v[0]).toBeCloseTo(minWidth, 9);
      inFull(v);
      // 最小幅に当たっても anchor の値は表示範囲に残る
      expect(v[0]).toBeLessThanOrEqual(41_234);
      expect(v[1]).toBeGreaterThanOrEqual(41_234);
      for (let i = 0; i < 40; i++) v = zoom(v, 2, full, minWidth);
      expect(v).toEqual(full);
    });

    it('panBy: 幅を保ち、全域の外に出ない', () => {
      expect(panBy([40_000, 50_000], 5_000, full)).toEqual([45_000, 55_000]);
      expect(panBy([40_000, 50_000], -50_000, full)).toEqual([30_000, 40_000]);
      expect(panBy([40_000, 50_000], 1e9, full)).toEqual([80_000, 90_000]);
      expect(panBy(full, 1_000, full)).toEqual(full);
    });

    it('pinchViewport: 2 本の指の下の値が現在の画素に来る（1e-6 px）', () => {
      const start: Domain = [50_000, 70_000];
      const a0 = 400;
      const b0 = 600;
      const va = pixelToValue(start, range, a0);
      const vb = pixelToValue(start, range, b0);
      for (const [a1, b1] of [
        [350, 650], // 開く = 拡大
        [450, 550], // 閉じる = 縮小
        [500, 760], // 開きつつ右へ
      ] as const) {
        const v = pinchViewport(start, [a0, b0], [a1, b1], range, full, minWidth);
        const sx = linear(v, range);
        expect(Math.abs(sx(va) - a1)).toBeLessThan(1e-6);
        expect(Math.abs(sx(vb) - b1)).toBeLessThan(1e-6);
        inFull(v);
      }
    });

    it('pinchViewport: 全域・最小幅で収まり、指が重なればパン', () => {
      const start: Domain = [50_000, 70_000];
      const wide = pinchViewport(start, [400, 600], [499, 501], range, full, minWidth);
      expect(wide).toEqual(full);
      const narrow = pinchViewport(start, [500, 501], [0, 1000], range, full, minWidth);
      expect(narrow[1] - narrow[0]).toBeCloseTo(minWidth, 6);
      inFull(narrow);
      // 間隔 1px 未満 → 中点の移動だけ（右へ 100px = 値は左へ 2,000）
      const pan = pinchViewport(start, [500, 500.5], [600, 600.5], range, full, minWidth);
      expect(pan[0]).toBeCloseTo(48_000, 6);
      expect(pan[1]).toBeCloseTo(68_000, 6);
    });

    it('wheelFactor: 下へ = 縮小（> 1）、上へ = 拡大（< 1）、[0.5, 2] に収める、行・ページの単位', () => {
      expect(wheelFactor(100, 0, 800)).toBeCloseTo(Math.exp(0.2), 12);
      expect(wheelFactor(-100, 0, 800)).toBeCloseTo(Math.exp(-0.2), 12);
      expect(wheelFactor(3, 1, 800)).toBeCloseTo(Math.exp(48 * 0.002), 12);
      expect(wheelFactor(1, 2, 800)).toBe(2);
      expect(wheelFactor(-10_000, 0, 800)).toBe(0.5);
      expect(wheelFactor(Number.NaN, 0, 800)).toBe(1);
    });
  });
});

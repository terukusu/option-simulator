import { describe, expect, it } from 'vitest';
import { clipSegment, extent, linear, niceTicks, zoom } from '../../ui/chart/scale';

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
});

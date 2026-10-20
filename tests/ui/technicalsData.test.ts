/** #200 AC7: AI のツール technicals の読み込み（ui/components/technicalsData.ts）。偽の読み込み関数（通信しない）。値は架空 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtmIvLoadOptions, AtmIvSource, FutBar, FutureBarsData } from '../../data';
import {
  clearTechnicalsCache,
  loadTechnicalsData,
  TECH_CACHE_MS,
  techLeftRange,
} from '../../ui/components/technicalsData';
import { IV_CHUNK_DAYS } from '../../ui/view/ivLoad';

const DAY = 86400;
const RIGHT_START = Date.UTC(2026, 9, 14) / 1000 - 365 * DAY;

function fake(failLeft = false, failRight = false) {
  const calls: { tf: AtmIvSource; range: AtmIvLoadOptions['range'] | null }[] = [];
  const bar = (t: number): FutBar => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, m: '2026-12' });
  const loader = async (tf: AtmIvSource, opts: AtmIvLoadOptions = {}): Promise<FutureBarsData> => {
    calls.push({ tf, range: opts.range ?? null });
    if (opts.range && failLeft) throw new Error('left');
    if (!opts.range && failRight) throw new Error('right');
    const start = opts.range
      ? opts.range.start
      : tf === '1d'
        ? RIGHT_START
        : RIGHT_START + 305 * DAY;
    return { tf, start, end: start + DAY, lastAt: null, bars: [bar(start + 3600)] };
  };
  return { calls, loader };
}

beforeEach(() => clearTechnicalsCache());

describe('読む範囲（先物推移の画面と同じ = サーバーのキャッシュを共有）', () => {
  it('右端の 1 回分 + その左の 1 回分（日足 365 日・1 時間足 60 日）', async () => {
    const f = fake();
    const d = await loadTechnicalsData('/api/future_bars', f.loader, 0);
    expect(f.calls.map((c) => [c.tf, c.range === null])).toEqual([
      ['1d', true],
      ['1h', true],
      ['1d', false],
      ['1h', false],
    ]);
    expect(f.calls[2]?.range).toEqual(techLeftRange(RIGHT_START, '1d'));
    expect(techLeftRange(RIGHT_START, '1d')).toEqual({
      start: RIGHT_START - IV_CHUNK_DAYS['1d'] * DAY,
      end: RIGHT_START,
    });
    // 左と右をつなぐ（時刻の昇順）
    expect(d.daily).toHaveLength(2);
    expect((d.daily[0] as FutBar).t).toBeLessThan((d.daily[1] as FutBar).t);
  });
});

describe('覚え（10 分）', () => {
  it('10 分以内は読み直さない、過ぎたら読み直す', async () => {
    const f = fake();
    await loadTechnicalsData('/api/future_bars', f.loader, 0);
    await loadTechnicalsData('/api/future_bars', f.loader, TECH_CACHE_MS - 1);
    expect(f.calls).toHaveLength(4);
    await loadTechnicalsData('/api/future_bars', f.loader, TECH_CACHE_MS);
    expect(f.calls).toHaveLength(8);
  });
  it('左が読めなければ右端だけ、右端が読めなければ失敗（覚えない）', async () => {
    const left = fake(true);
    const d = await loadTechnicalsData('/a', left.loader, 0);
    expect(d.daily).toHaveLength(1);
    const right = fake(false, true);
    await expect(loadTechnicalsData('/b', right.loader, 0)).rejects.toThrow();
    const ok = fake();
    await loadTechnicalsData('/b', ok.loader, 1);
    expect(ok.calls).toHaveLength(4);
  });
});

/** #138・#158 AC3: AI のツール iv_stats の読み込み（ui/components/ivStatsData.ts）。偽の読み込み関数（通信しない）。値は架空 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AtmDailyData, AtmIvData } from '../../data';
import {
  clearIvStatsCache,
  IV_STATS_CACHE_MS,
  type IvStatsLoaders,
  ivNowOf,
  loadIvStatsData,
} from '../../ui/components/ivStatsData';

const DAILY: AtmDailyData = {
  start: '2010-01-01',
  end: '2026-10-14',
  days: [
    { d: '2026-10-13', t: 1_760_335_200, iv: 20, f1: 30000, l1: '2026-11-12', f2: null, l2: null },
  ],
};
const IV: AtmIvData = {
  tf: '1h',
  start: 1_760_000_000,
  end: 1_760_400_000,
  lastAt: 1_760_386_000,
  bars: [
    { t: 1_760_380_000, o: 20, h: 21, l: 19, c: 20.5 },
    { t: 1_760_383_600, o: 20.5, h: 22, l: 20, c: 21.7 },
  ],
};

function fake(failDaily = false, failIv = false) {
  const calls: string[] = [];
  const loaders: IvStatsLoaders = {
    daily: async (endpoint) => {
      calls.push(`daily ${endpoint}`);
      if (failDaily) throw new Error('daily');
      return DAILY;
    },
    iv: async (endpoint) => {
      calls.push(`iv ${endpoint}`);
      if (failIv) throw new Error('iv');
      return IV;
    },
  };
  return { calls, loaders };
}

beforeEach(() => clearIvStatsCache());

describe('iv_stats の読み込み', () => {
  it('日次の値と 1 時間足の右端を 1 回ずつ読み、今の値 = 最後の足の終値', async () => {
    const f = fake();
    const d = await loadIvStatsData('/api/atm_daily', '/api/atm_iv', f.loaders, 0);
    expect(f.calls).toEqual(['daily /api/atm_daily', 'iv /api/atm_iv']);
    // 今の値の時刻は値の時刻（lastAt。最後の足の中）。1 時間足は近似のために渡す
    expect(d).toEqual({
      days: DAILY.days,
      now: { t: 1_760_386_000, iv: 21.7 },
      hourly: [
        { t: 1_760_380_000, c: 20.5 },
        { t: 1_760_383_600, c: 21.7 },
      ],
    });
  });

  it('10 分は読み直さない・過ぎたら読み直す・口が違えば別に覚える', async () => {
    const f = fake();
    await loadIvStatsData('/api/atm_daily', '/api/atm_iv', f.loaders, 0);
    await loadIvStatsData('/api/atm_daily', '/api/atm_iv', f.loaders, IV_STATS_CACHE_MS - 1);
    expect(f.calls.length).toBe(2);
    await loadIvStatsData('/api/atm_daily', '/api/atm_iv', f.loaders, IV_STATS_CACHE_MS);
    expect(f.calls.length).toBe(4);
    await loadIvStatsData('/fixtures/atm_daily', '/fixtures/atm_iv', f.loaders, IV_STATS_CACHE_MS);
    expect(f.calls.slice(4)).toEqual(['daily /fixtures/atm_daily', 'iv /fixtures/atm_iv']);
  });

  it('今の IV が読めなければ now = null で日次の値だけ返す', async () => {
    const f = fake(false, true);
    const d = await loadIvStatsData('/api/atm_daily', '/api/atm_iv', f.loaders, 0);
    expect(d).toEqual({ days: DAILY.days, now: null, hourly: [] });
  });

  it('日次の値が読めなければ失敗し、覚えずに次で読み直す', async () => {
    const bad = fake(true);
    await expect(loadIvStatsData('/api/atm_daily', '/api/atm_iv', bad.loaders, 0)).rejects.toThrow(
      'daily',
    );
    const good = fake();
    const d = await loadIvStatsData('/api/atm_daily', '/api/atm_iv', good.loaders, 1);
    expect(good.calls.length).toBe(2);
    expect(d.days.length).toBe(1);
  });

  it('足の無い応答の今の値は null・lastAt が最後の足の外なら足の始まり', () => {
    expect(ivNowOf({ ...IV, bars: [] })).toBeNull();
    expect(ivNowOf({ ...IV, lastAt: null })).toEqual({ t: 1_760_383_600, iv: 21.7 });
    expect(ivNowOf({ ...IV, lastAt: 1_760_383_600 + 3600 })).toEqual({
      t: 1_760_383_600,
      iv: 21.7,
    });
  });
});

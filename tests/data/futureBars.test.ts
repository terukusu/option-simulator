import { describe, expect, it } from 'vitest';
import { ChainLoadError, loadFutureBars } from '../../data/adapter';
import { futureBarsUrl, validateFutureBarsJson } from '../../data/futureBars';
import {
  atmIvQuery,
  SYNTH_FUT_LAST_AT,
  SYNTH_FUT_ROLL_JUMP,
  SYNTH_IV_NOW,
  synthFutureBars,
} from '../../scripts/devFixtures.mjs';

/**
 * #190 AC-6: `/api/future_bars` の JSON の検証と読み込み（data/futureBars.ts・data/adapter.ts の loadFutureBars）。
 * 値は架空（先物 30,000 円前後）。dev の合成の応答（scripts/devFixtures.mjs の synthFutureBars）がこの検証に通り、
 * 既定の 1 時間足の範囲に限月交代を 1 回含むことも確かめる。
 */

const ok = {
  schema_version: 1,
  tf: '1h',
  start: '2026-08-14T09:00:00+09:00',
  end: '2026-10-13T21:31:00+09:00',
  last_at: '2026-10-13T21:29:00+09:00',
  bars: [
    { t: '2026-09-10T16:00:00+09:00', o: 30010, h: 30050, l: 29990, c: 30000, m: '2026-09' },
    { t: '2026-09-10T17:00:00+09:00', o: 30100, h: 30120, l: 30080.5, c: 30110, m: '2026-12' },
  ],
};

describe('validateFutureBarsJson', () => {
  it('正しい応答 → 時刻を UNIX 秒にし、限月 m を運ぶ', () => {
    const r = validateFutureBarsJson(ok, '1h');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lastAt).toBe(Date.parse('2026-10-13T12:29:00Z') / 1000);
    expect(r.value.bars).toEqual([
      {
        t: Date.parse('2026-09-10T07:00:00Z') / 1000,
        o: 30010,
        h: 30050,
        l: 29990,
        c: 30000,
        m: '2026-09',
      },
      {
        t: Date.parse('2026-09-10T08:00:00Z') / 1000,
        o: 30100,
        h: 30120,
        l: 30080.5,
        c: 30110,
        m: '2026-12',
      },
    ]);
  });

  it('last_at が null・足が 0 本でも通る', () => {
    const r = validateFutureBarsJson({ ...ok, last_at: null, bars: [] }, '1h');
    expect(r.ok && r.value.lastAt === null && r.value.bars.length === 0).toBe(true);
  });

  const bar = ok.bars[0] as (typeof ok.bars)[number];
  it.each([
    ['版が違う', { ...ok, schema_version: 2 }, '$.schema_version'],
    ['足が要求と違う', { ...ok, tf: '1d' }, '$.tf'],
    ['m が無い', { ...ok, bars: [{ ...bar, m: undefined }] }, '$.bars[0].m'],
    ['m が四半期でない', { ...ok, bars: [{ ...bar, m: '2026-10' }] }, '$.bars[0].m'],
    ['m の形が違う', { ...ok, bars: [{ ...bar, m: '2026/09' }] }, '$.bars[0].m'],
    ['t が昇順でない', { ...ok, bars: [ok.bars[1], ok.bars[0]] }, '$.bars[1].t'],
    ['l ≤ o, c ≤ h でない', { ...ok, bars: [{ ...bar, h: 30000.5, c: 30060 }] }, '$.bars[0]'],
    ['値が正でない', { ...ok, bars: [{ ...bar, o: 0, l: 0 }] }, '$.bars[0].l'],
  ])('%s → 失敗（%s）', (_, json, path) => {
    const r = validateFutureBarsJson(json, '1h');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith(path))).toBe(true);
  });
});

describe('loadFutureBars', () => {
  it('既定は同一オリジンの /api/future_bars（パラメータは /api/atm_iv と同じ）', async () => {
    const urls: string[] = [];
    const data = await loadFutureBars('1h', {
      range: { start: Date.UTC(2026, 7, 1) / 1000, end: Date.UTC(2026, 8, 1) / 1000 },
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(ok), { status: 200 });
      },
    });
    expect(urls).toEqual([
      '/api/future_bars?tf=1h&start=2026-08-01T00%3A00%3A00Z&end=2026-09-01T00%3A00%3A00Z',
    ]);
    expect(data.bars.map((b) => b.m)).toEqual(['2026-09', '2026-12']);
    expect(futureBarsUrl('/fixtures/future_bars', '1m')).toBe('/fixtures/future_bars?tf=1m');
  });

  it('壊れた JSON・検証の失敗は ChainLoadError（本文は入れない）', async () => {
    const bad = await loadFutureBars('1h', {
      fetch: async () => new Response('{', { status: 200 }),
    }).catch((e) => e);
    expect(bad).toBeInstanceOf(ChainLoadError);
    const invalid = await loadFutureBars('1h', {
      fetch: async () => new Response(JSON.stringify({ ...ok, tf: '1m' }), { status: 200 }),
    }).catch((e) => e);
    expect(invalid).toBeInstanceOf(ChainLoadError);
    expect(String(invalid.message)).toContain('先物推移');
  });
});

describe('dev の合成の応答（scripts/devFixtures.mjs の synthFutureBars。架空の値）', () => {
  it.each(['1m', '1h', '1d'] as const)('%s の右端の 1 回分が検証に通る', (tf) => {
    const r = validateFutureBarsJson(synthFutureBars(tf), tf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bars.length).toBeGreaterThan(20);
    expect(r.value.lastAt).toBe(SYNTH_FUT_LAST_AT);
    expect(r.value.end).toBe(SYNTH_IV_NOW);
  });

  it('既定の 1 時間足の範囲に限月交代が 1 回（取引最終日の 17:00、跳びは架空の 0.3% 前後）', () => {
    const r = validateFutureBarsJson(synthFutureBars('1h'), '1h');
    if (!r.ok) throw new Error('invalid');
    const rolls = r.value.bars.flatMap((b, i) => {
      const prev = r.value.bars[i - 1];
      return prev && prev.m !== b.m ? [{ prev, b }] : [];
    });
    expect(rolls).toHaveLength(1);
    const { prev, b } = rolls[0] as (typeof rolls)[number];
    expect([prev.m, b.m]).toEqual(['2026-09', '2026-12']);
    expect(new Date(b.t * 1000).toISOString()).toBe('2026-09-10T08:00:00.000Z'); // 17:00 JST
    expect(Math.abs(b.o / prev.c - 1 - SYNTH_FUT_ROLL_JUMP)).toBeLessThan(0.003);
  });

  it('範囲の検査は /fixtures/atm_iv と同じ', () => {
    expect(atmIvQuery('/fixtures/future_bars?tf=1h')).toEqual({ tf: '1h', range: null });
    expect(atmIvQuery('/fixtures/future_bars?tf=5m')).toBeNull();
    expect(synthFutureBars('5m')).toBeNull();
  });
});

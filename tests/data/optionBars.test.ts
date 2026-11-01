import { describe, expect, it } from 'vitest';
import { ChainLoadError, loadOptionBars } from '../../data/adapter';
import { optionBarsUrl, validateOptionBarsJson } from '../../data/optionBars';
import {
  optionBarsQuery,
  SYNTH_OPT_NOQUOTE_DAY,
  synthOptionBars,
} from '../../scripts/devFixtures.mjs';

/**
 * #319 AC 4: `/api/option_bars` の JSON の検証と読み込み（data/optionBars.ts・data/adapter.ts の loadOptionBars）。
 * 値は架空。dev の合成の応答（scripts/devFixtures.mjs の synthOptionBars）がこの検証に通り、気配の無い足・約定・
 * bid_iv だけ欠けた足を含むことも確かめる。
 */

const KEY = { ltd: '2026-11-12', k: 30000, type: 'put' as const };
const bar = (t: string, over: Record<string, unknown> = {}) => ({
  t,
  o: 100,
  h: 110,
  l: 95,
  c: 105,
  bid: 100,
  ask: 110,
  bid_iv: 20,
  ask_iv: 21,
  trade: null,
  trade_iv: null,
  ...over,
});
const ok = {
  schema_version: 1,
  tf: '1h',
  ltd: '2026-11-12',
  k: 30000,
  type: 'put',
  last_at: '2026-10-13T20:59:00+09:00',
  bars: [
    bar('2026-10-13T19:00:00+09:00'),
    bar('2026-10-13T20:00:00+09:00', {
      o: null,
      h: null,
      l: null,
      c: null,
      bid: null,
      ask: null,
      bid_iv: null,
      ask_iv: null,
      trade: 104,
      trade_iv: 20.5,
    }),
  ],
};

describe('validateOptionBarsJson', () => {
  it('正しい応答 → 時刻を UNIX 秒にし、気配の無い足は null のまま運ぶ', () => {
    const r = validateOptionBarsJson(ok, '1h', KEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lastAt).toBe(Date.parse('2026-10-13T11:59:00Z') / 1000);
    expect(r.value.bars[0]).toEqual({
      t: Date.parse('2026-10-13T10:00:00Z') / 1000,
      o: 100,
      h: 110,
      l: 95,
      c: 105,
      bid: 100,
      ask: 110,
      bidIv: 20,
      askIv: 21,
      trade: null,
      tradeIv: null,
    });
    expect(r.value.bars[1]?.o).toBeNull();
    expect(r.value.bars[1]?.trade).toBe(104);
    expect(r.value).toMatchObject({ tf: '1h', ...KEY });
  });

  it('版・足・銘柄が要求と違えば拒否', () => {
    expect(validateOptionBarsJson({ ...ok, schema_version: 2 }, '1h', KEY).ok).toBe(false);
    expect(validateOptionBarsJson(ok, '1d', KEY).ok).toBe(false);
    expect(validateOptionBarsJson(ok, '1h', { ...KEY, k: 30125 }).ok).toBe(false);
    expect(validateOptionBarsJson(ok, '1h', { ...KEY, type: 'call' }).ok).toBe(false);
    expect(validateOptionBarsJson(ok, '1h', { ...KEY, ltd: '2026-12-10' }).ok).toBe(false);
    expect(validateOptionBarsJson(null, '1h', KEY).ok).toBe(false);
    expect(validateOptionBarsJson([], '1h', KEY).ok).toBe(false);
  });

  it('時刻のオフセットが無い・昇順でない・重複は拒否', () => {
    const noOffset = { ...ok, bars: [bar('2026-10-13T19:00:00')] };
    expect(validateOptionBarsJson(noOffset, '1h', KEY).ok).toBe(false);
    expect(validateOptionBarsJson({ ...ok, last_at: '2026-10-13T20:59:00' }, '1h', KEY).ok).toBe(
      false,
    );
    const desc = { ...ok, bars: [ok.bars[1], ok.bars[0]] };
    expect(validateOptionBarsJson(desc, '1h', KEY).ok).toBe(false);
    const dup = { ...ok, bars: [ok.bars[0], ok.bars[0]] };
    const r = validateOptionBarsJson(dup, '1h', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('昇順でない・重複');
  });

  it('値の形: o・h・l・c は 4 つそろう・l ≤ o, c ≤ h、bid ≤ ask の組、正の数か null、気配も約定も無い足は拒否', () => {
    const t = '2026-10-13T19:00:00+09:00';
    const bad = [
      bar(t, { o: null }),
      bar(t, { l: 101 }),
      bar(t, { bid: 120, ask: 110 }),
      bar(t, { bid: null }),
      bar(t, { ask_iv: 0 }),
      bar(t, { trade: -1 }),
      bar(t, { c: Number.NaN }),
      bar(t, { o: null, h: null, l: null, c: null, bid: null, ask: null }),
    ];
    for (const b of bad) {
      expect(validateOptionBarsJson({ ...ok, bars: [b] }, '1h', KEY).ok, JSON.stringify(b)).toBe(
        false,
      );
    }
    // IV は片方ずつ null を許す
    expect(validateOptionBarsJson({ ...ok, bars: [bar(t, { bid_iv: null })] }, '1h', KEY).ok).toBe(
      true,
    );
  });

  it('エラーは 50 件で打ち切る', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      bar(`2026-10-13T19:${String(i % 60).padStart(2, '0')}:00`),
    );
    const r = validateOptionBarsJson({ ...ok, bars: many }, '1h', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(50);
  });
});

describe('optionBarsUrl', () => {
  it('4 つのパラメータだけ（符号化する）', () => {
    expect(optionBarsUrl('/api/option_bars', '1d', KEY)).toBe(
      '/api/option_bars?ltd=2026-11-12&k=30000&type=put&tf=1d',
    );
  });
});

describe('loadOptionBars', () => {
  const fetchOf = (status: number, body: string) => async (url: string) => {
    calls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      type: 'basic',
      text: async () => body,
    } as unknown as Response;
  };
  let calls: string[] = [];

  it('読んで検証する（既定の口は /api/option_bars）', async () => {
    calls = [];
    const r = await loadOptionBars('1h', KEY, { fetch: fetchOf(200, JSON.stringify(ok)) });
    expect(r.bars).toHaveLength(2);
    expect(calls).toEqual(['/api/option_bars?ltd=2026-11-12&k=30000&type=put&tf=1h']);
  });

  it('503・壊れた JSON は ChainLoadError（本文を入れない）', async () => {
    await expect(
      loadOptionBars('1h', KEY, { fetch: fetchOf(503, '{"error":"unavailable"}') }),
    ).rejects.toBeInstanceOf(ChainLoadError);
    await expect(loadOptionBars('1h', KEY, { fetch: fetchOf(200, '{') })).rejects.toBeInstanceOf(
      ChainLoadError,
    );
  });
});

describe('dev の合成の応答（synthOptionBars）', () => {
  it('1h・1d とも検証に通り、気配の無い足・約定・bid_iv だけ欠けた足を含む', () => {
    for (const tf of ['1h', '1d'] as const) {
      const key = { ltd: '2026-11-12', k: 67000, type: 'put' as const };
      const r = validateOptionBarsJson(synthOptionBars(key.ltd, key.k, key.type, tf), tf, key);
      expect(r.ok, tf).toBe(true);
      if (!r.ok) continue;
      expect(r.value.bars.length).toBeGreaterThan(tf === '1h' ? 200 : 15);
      expect(r.value.bars.some((b) => b.trade !== null)).toBe(true);
      if (tf === '1h') {
        const day = Date.parse(`${SYNTH_OPT_NOQUOTE_DAY}T12:00:00+09:00`) / 1000;
        expect(r.value.bars.some((b) => b.o === null && Math.abs(b.t - day) < 6 * 3600)).toBe(true);
        expect(r.value.bars.some((b) => b.o !== null && b.bidIv === null)).toBe(true);
      }
    }
  });

  it('要求の検査はサーバーと同じ（形が違えば null）', () => {
    expect(optionBarsQuery('/fixtures/option_bars?ltd=2026-11-12&k=67000&type=call&tf=1d')).toEqual(
      { ltd: '2026-11-12', k: 67000, type: 'call', tf: '1d' },
    );
    for (const q of [
      'ltd=2026-02-30&k=1&type=put&tf=1h',
      'ltd=2026-11-12&k=0&type=put&tf=1h',
      'ltd=2026-11-12&k=1&type=P&tf=1h',
      'ltd=2026-11-12&k=1&type=put&tf=5m',
      'ltd=2026-11-12&k=1&k=2&type=put&tf=1h',
    ]) {
      expect(optionBarsQuery(`/fixtures/option_bars?${q}`), q).toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ChainLoadError, loadAtmIv } from '../../data/adapter';
import { type AtmIvSource, atmIvParamTime, atmIvUrl, validateAtmIvJson } from '../../data/atmIv';
import {
  atmIvQuery,
  SYNTH_IV_FIRST,
  SYNTH_IV_LAST_AT,
  SYNTH_IV_NOW,
  synthAtmIv,
} from '../../scripts/devFixtures.mjs';
import { ivLeftRange, ivRangeAt, ivRightRange } from '../../ui/view/ivLoad';

/**
 * #79 段 B: `/api/atm_iv` の JSON の検証と読み込み（data/atmIv.ts・data/adapter.ts の loadAtmIv）。
 * 値は架空（IV 20% 前後）。dev の合成の応答（scripts/devFixtures.mjs の synthAtmIv）がこの検証に通ることも確かめる。
 */

const ok = {
  schema_version: 1,
  tf: '1h',
  start: '2026-08-14T09:00:00+09:00',
  end: '2026-10-13T21:31:00+09:00',
  last_at: '2026-10-13T20:41:00+09:00',
  bars: [
    { t: '2026-10-13T19:00:00+09:00', o: 20.1, h: 20.5, l: 19.9, c: 20.2 },
    { t: '2026-10-13T20:00:00+09:00', o: 20.2, h: 20.2, l: 20.0, c: 20.0 },
  ],
};

interface Init {
  signal?: AbortSignal;
  cache?: RequestCache;
  redirect?: RequestRedirect;
}

describe('validateAtmIvJson', () => {
  it('正しい応答 → 時刻を UNIX 秒にして返す', () => {
    const r = validateAtmIvJson(ok, '1h');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tf).toBe('1h');
    expect(r.value.start).toBe(Date.parse('2026-08-14T00:00:00Z') / 1000);
    expect(r.value.end).toBe(Date.parse('2026-10-13T12:31:00Z') / 1000);
    expect(r.value.lastAt).toBe(Date.parse('2026-10-13T11:41:00Z') / 1000);
    expect(r.value.bars).toEqual([
      { t: Date.parse('2026-10-13T10:00:00Z') / 1000, o: 20.1, h: 20.5, l: 19.9, c: 20.2 },
      { t: Date.parse('2026-10-13T11:00:00Z') / 1000, o: 20.2, h: 20.2, l: 20.0, c: 20.0 },
    ]);
  });

  it('last_at が null・足が 0 本でも通る', () => {
    const r = validateAtmIvJson({ ...ok, last_at: null, bars: [] }, '1h');
    expect(r.ok && r.value.lastAt === null && r.value.bars.length === 0).toBe(true);
  });

  it.each([
    ['オブジェクトでない', [], '$'],
    ['版が違う', { ...ok, schema_version: 2 }, '$.schema_version'],
    ['足が要求と違う', { ...ok, tf: '1d' }, '$.tf'],
    ['start がオフセットなし', { ...ok, start: '2026-08-14T09:00:00' }, '$.start'],
    ['end ≤ start', { ...ok, end: ok.start }, '$.end'],
    ['last_at が数値', { ...ok, last_at: 0 }, '$.last_at'],
    ['bars が配列でない', { ...ok, bars: {} }, '$.bars'],
    ['値が文字列', { ...ok, bars: [{ ...ok.bars[0], o: '20.1' }] }, '$.bars[0]'],
    ['値が非有限', { ...ok, bars: [{ ...ok.bars[0], h: null }] }, '$.bars[0]'],
    ['h < c', { ...ok, bars: [{ ...ok.bars[0], h: 20.15 }] }, '$.bars[0]'],
    ['l > o', { ...ok, bars: [{ ...ok.bars[0], l: 20.15 }] }, '$.bars[0]'],
    ['t が昇順でない', { ...ok, bars: [ok.bars[1], ok.bars[0]] }, '$.bars[1].t'],
    ['t が重複', { ...ok, bars: [ok.bars[0], ok.bars[0]] }, '$.bars[1].t'],
    ['t が日付だけ', { ...ok, bars: [{ ...ok.bars[0], t: '2026-10-13' }] }, '$.bars[0].t'],
  ])('%s → ok = false（%s）', (_name, v, path) => {
    const r = validateAtmIvJson(v, '1h');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.startsWith(path))).toBe(true);
  });
});

describe('atmIvUrl', () => {
  it('右端は tf だけ、範囲は UTC の Z（秒まで）で start・end', () => {
    expect(atmIvUrl('/api/atm_iv', '1h')).toBe('/api/atm_iv?tf=1h');
    const start = Date.parse('2026-08-15T00:00:00Z') / 1000;
    const end = Date.parse('2026-10-14T00:00:00Z') / 1000;
    expect(atmIvParamTime(start)).toBe('2026-08-15T00:00:00Z');
    expect(atmIvUrl('/fixtures/atm_iv', '1m', { start, end })).toBe(
      '/fixtures/atm_iv?tf=1m&start=2026-08-15T00%3A00%3A00Z&end=2026-10-14T00%3A00%3A00Z',
    );
  });
});

describe('loadAtmIv（/api/atm_iv を読む）', () => {
  it('既定の URL・cache no-cache・redirect manual・signal を渡し、検証して返す', async () => {
    const calls: [string, Init | undefined][] = [];
    const ac = new AbortController();
    const data = await loadAtmIv('1h', {
      signal: ac.signal,
      fetch: async (url, init) => {
        calls.push([url, init]);
        return { ok: true, status: 200, text: async () => JSON.stringify(ok) };
      },
    });
    expect(data.bars).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('/api/atm_iv?tf=1h');
    expect(calls[0]?.[1]).toEqual({ cache: 'no-cache', redirect: 'manual', signal: ac.signal });
  });

  it('endpoint を差し替える（dev の /fixtures/atm_iv）', async () => {
    const calls: string[] = [];
    await loadAtmIv('1d', {
      endpoint: '/fixtures/atm_iv',
      fetch: async (url) => {
        calls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify({ ...ok, tf: '1d' }) };
      },
    });
    expect(calls).toEqual(['/fixtures/atm_iv?tf=1d']);
  });

  it('503・ログイン切れ・壊れた JSON・形の違いは ChainLoadError（応答の本文を出さない）。AbortError はそのまま', async () => {
    const res = (status: number, body: string, type?: string) => async () => ({
      ok: status >= 200 && status < 300,
      status,
      ...(type ? { type } : {}),
      text: async () => body,
    });
    const e503 = await loadAtmIv('1h', { fetch: res(503, 'secret') }).catch((e) => e);
    expect(e503).toBeInstanceOf(ChainLoadError);
    expect(e503.message).toBe('IV 推移を読めない（api: HTTP 503）');
    expect(e503.kind).toBe('http');
    const auth = await loadAtmIv('1h', { fetch: res(0, '', 'opaqueredirect') }).catch((e) => e);
    expect(auth.kind).toBe('auth');
    const broken = await loadAtmIv('1h', { fetch: res(200, '<html>secret') }).catch((e) => e);
    expect(broken.message).toBe('IV 推移の JSON が不正（api）');
    expect(broken.message).not.toMatch(/secret/);
    const shape = await loadAtmIv('1m', { fetch: res(200, JSON.stringify(ok)) }).catch((e) => e);
    expect(shape).toBeInstanceOf(ChainLoadError);
    expect(shape.errors.some((x: string) => x.startsWith('$.tf'))).toBe(true);
    const abort = await loadAtmIv('1h', {
      fetch: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    }).catch((e) => e);
    expect(abort.name).toBe('AbortError');
  });
});

describe('dev の合成の応答（scripts/devFixtures.mjs の synthAtmIv。架空の値）', () => {
  it.each(['1m', '1h', '1d'] as const)(
    '%s の右端の 1 回分が検証に通り、足は表の最後の行まで',
    (tf) => {
      const json = synthAtmIv(tf);
      const r = validateAtmIvJson(json, tf);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.bars.length).toBeGreaterThan(20);
      expect(r.value.lastAt).toBe(SYNTH_IV_LAST_AT);
      expect(r.value.end).toBe(SYNTH_IV_NOW);
      expect(r.value.bars.at(-1)?.t).toBeLessThanOrEqual(SYNTH_IV_LAST_AT + 86400);
      expect(r.value.bars[0]?.t).toBeGreaterThanOrEqual(r.value.start - 86400);
    },
  );

  it('範囲を渡すとその範囲（データの始まりより前は空）・未知の足は null', () => {
    const end = SYNTH_IV_FIRST;
    const json = synthAtmIv('1h', { start: end - 60 * 86400, end });
    const r = validateAtmIvJson(json, '1h');
    expect(r.ok && r.value.bars.length === 0 && r.value.lastAt === null).toBe(true);
    expect(synthAtmIv('5m')).toBeNull();
  });
});

describe('dev の範囲の検査（サーバーの parse_request と同じ。#79 段 C）', () => {
  const D = 86400;
  const day = Math.floor(SYNTH_IV_NOW / D) * D;
  const url = (tf: AtmIvSource, start: number, end: number) =>
    atmIvUrl('/fixtures/atm_iv', tf, { start, end });

  it('UTC の 0 時・最大の日数以下・2010-01-01 以降だけ通る（end は今の UTC の日の翌 0 時に縮める）', () => {
    expect(atmIvQuery(url('1h', day - 100 * D, day))?.range).toEqual({
      start: day - 100 * D,
      end: day,
    });
    expect(atmIvQuery(url('1h', day - 101 * D, day))).toBeNull();
    expect(atmIvQuery(url('1m', day - 3 * D + 3600, day))).toBeNull();
    expect(atmIvQuery(url('1d', day - 399 * D, day + 30 * D))?.range?.end).toBe(day + D);
    expect(
      atmIvQuery(url('1d', Date.UTC(2009, 11, 31) / 1000, Date.UTC(2010, 5, 1) / 1000)),
    ).toBeNull();
    expect(atmIvQuery('/fixtures/atm_iv?tf=1h&start=2026-10-01T00:00:00')).toBeNull();
    expect(atmIvQuery('/fixtures/atm_iv?tf=1h')).toEqual({ tf: '1h', range: null });
  });

  it('画面の追加読み込みの範囲（左・右・足の切替の 1 回分）はこの検査に通る', () => {
    for (const src of ['1m', '1h', '1d'] as const) {
      const e = {
        bars: [],
        start: day - 2 * D,
        end: SYNTH_IV_NOW,
        lastAt: null,
        rightLoaded: true,
        leftDone: false,
        emptyLeft: 0,
      };
      const left = ivLeftRange(e, src);
      if (!left) throw new Error('左の範囲が無い');
      expect(atmIvQuery(url(src, left.start, left.end))).not.toBeNull();
      const right = ivRightRange({ ...e, end: day - D }, src);
      expect(atmIvQuery(url(src, right.start, right.end))).not.toBeNull();
      const at = ivRangeAt(SYNTH_IV_NOW - 40 * D + 777, src);
      expect(atmIvQuery(url(src, at.start, at.end))).not.toBeNull();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  ChainLoadError,
  createBigQueryAdapter,
  createFileAdapter,
  loadNormalizedChain,
} from '../../data/adapter';
import { RAW_FIXTURES } from '../support/fixtures';

const latestText = JSON.stringify(RAW_FIXTURES['latest.json']);

function fakeFetch(status: number, body: string, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}

describe('file アダプタ', () => {
  it('URL から読んで検証する', async () => {
    const calls: string[] = [];
    const a = createFileAdapter({
      url: 'fixtures/synthetic/latest.json',
      fetch: fakeFetch(200, latestText, calls),
    });
    expect(a.kind).toBe('file');
    const json = await a.loadChain({ at: '2026-10-13T00:00:00+09:00' });
    expect(json.snapshot_at).toBe('2026-10-13T21:31:00+09:00');
    // file は at を無視する
    expect(calls).toEqual(['fixtures/synthetic/latest.json']);
  });

  it('ファイル（Blob）から読む', async () => {
    const a = createFileAdapter({ blob: new Blob([latestText]), name: 'dump.json' });
    expect((await a.loadChain()).months.length).toBe(2);
  });

  it('壊れた JSON・HTTP エラー・通信エラーは ChainLoadError（応答の本文は出さない）', async () => {
    const broken = createFileAdapter({ blob: new Blob(['{"schema_version":1}']), name: 'x.json' });
    const e1 = await broken.loadChain().catch((e) => e);
    expect(e1).toBeInstanceOf(ChainLoadError);
    expect(e1.message).toMatch(/板の JSON が不正（x\.json）/);
    expect(e1.errors.length).toBeGreaterThan(0);

    const notFound = createFileAdapter({
      url: 'nope.json',
      fetch: fakeFetch(404, 'secret detail'),
    });
    const e2 = await notFound.loadChain().catch((e) => e);
    expect(e2).toBeInstanceOf(ChainLoadError);
    expect(e2.message).toBe('板を読めない（file: HTTP 404）');
    expect(e2.message).not.toMatch(/secret/);

    const down = createFileAdapter({
      url: 'x.json',
      fetch: async () => {
        throw new TypeError('network');
      },
    });
    await expect(down.loadChain()).rejects.toThrow(/通信エラー/);
  });
});

describe('bigquery アダプタ（ブラウザ側。/api/chain を読む）', () => {
  it('既定の URL と at の付け方', async () => {
    const calls: string[] = [];
    const a = createBigQueryAdapter({ fetch: fakeFetch(200, latestText, calls) });
    expect(a.kind).toBe('bigquery');
    await a.loadChain();
    await a.loadChain({ at: '2026-10-13T15:40:00+09:00' });
    expect(calls).toEqual(['/api/chain', '/api/chain?at=2026-10-13T15%3A40%3A00%2B09%3A00']);
  });

  it('503 は ChainLoadError', async () => {
    const a = createBigQueryAdapter({ fetch: fakeFetch(503, '') });
    await expect(a.loadChain()).rejects.toThrow('板を読めない（api: HTTP 503）');
  });
});

it('読んで正規化まで', async () => {
  const a = createFileAdapter({ blob: new Blob([latestText]) });
  const chain = await loadNormalizedChain(a, { r: 0.004 });
  expect(chain.r).toBe(0.004);
  expect(chain.months.map((m) => m.id)).toEqual(['2026-11', '2026-12']);
});

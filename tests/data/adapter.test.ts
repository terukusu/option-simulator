import { describe, expect, it } from 'vitest';
import {
  ChainLoadError,
  createBigQueryAdapter,
  createFileAdapter,
  loadCalendarJson,
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

/** #34 AC-2: 本番の既定のアダプタ。fetch は偽物、板は合成。 */
describe('bigquery アダプタの応答の扱い（#34）', () => {
  interface Init {
    signal?: AbortSignal;
    cache?: RequestCache;
    redirect?: RequestRedirect;
  }

  function recorder(res: { ok: boolean; status: number; type?: string; body?: string }) {
    const inits: (Init | undefined)[] = [];
    const fetch = async (_url: string, init?: Init) => {
      inits.push(init);
      return {
        ok: res.ok,
        status: res.status,
        ...(res.type !== undefined ? { type: res.type } : {}),
        text: async () => res.body ?? '',
      };
    };
    return { fetch, inits };
  }

  it('(a) 200 の合成の板 → 検証済みの ChainJson', async () => {
    const { fetch } = recorder({ ok: true, status: 200, body: latestText });
    const json = await createBigQueryAdapter({ fetch }).loadChain();
    expect(json.snapshot_at).toBe('2026-10-13T21:31:00+09:00');
    expect(json.reason).toBe('latest');
  });

  it("(b) init は cache: 'no-cache'・redirect: 'manual'（signal も渡す）", async () => {
    const { fetch, inits } = recorder({ ok: true, status: 200, body: latestText });
    const a = createBigQueryAdapter({ fetch });
    await a.loadChain();
    const ctl = new AbortController();
    await a.loadChain({ signal: ctl.signal });
    expect(inits[0]).toEqual({ cache: 'no-cache', redirect: 'manual' });
    expect(inits[1]).toEqual({ cache: 'no-cache', redirect: 'manual', signal: ctl.signal });
  });

  it('file アダプタの init は従来どおり no-store（redirect は既定）', async () => {
    const { fetch, inits } = recorder({ ok: true, status: 200, body: latestText });
    await createFileAdapter({ url: 'x.json', fetch }).loadChain();
    expect(inits[0]).toEqual({ cache: 'no-store' });
  });

  it('(c) 503 → kind http・status 503。応答の本文を含めない', async () => {
    const { fetch } = recorder({ ok: false, status: 503, body: '{"error":"secret detail"}' });
    const e = await createBigQueryAdapter({ fetch })
      .loadChain()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('http');
    expect(e.status).toBe(503);
    expect(e.message).not.toMatch(/secret/);
    expect(e.errors).toEqual([]);
  });

  it.each([
    ['opaqueredirect', { ok: false, status: 0, type: 'opaqueredirect' }],
    ['401', { ok: false, status: 401, body: 'login page' }],
  ])('(d) %s → ログイン切れ（kind auth）', async (_name, res) => {
    const { fetch } = recorder(res);
    const e = await createBigQueryAdapter({ fetch })
      .loadChain()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('auth');
    expect(e.message).not.toMatch(/login page/);
  });

  it('(e) 通信エラー（例外）→ kind network', async () => {
    const a = createBigQueryAdapter({
      fetch: async () => {
        throw new TypeError('Failed to fetch secret-host');
      },
    });
    const e = await a.loadChain().catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('network');
    expect(e.status).toBeNull();
    expect(e.message).not.toMatch(/secret/);
  });

  it('(f) AbortError はそのまま投げる', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const a = createBigQueryAdapter({
      fetch: async () => {
        throw abort;
      },
    });
    await expect(a.loadChain()).rejects.toBe(abort);
  });

  it('(g) 壊れた JSON → kind invalid・検証エラーの明細つき', async () => {
    const { fetch } = recorder({ ok: true, status: 200, body: '{"schema_version":1}' });
    const e = await createBigQueryAdapter({ fetch })
      .loadChain()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('invalid');
    expect(e.status).toBeNull();
    expect(e.errors.length).toBeGreaterThan(0);
  });

  it('ChainLoadError の既定は kind invalid・status null（既存の呼び方の互換）', () => {
    const e = new ChainLoadError('x', ['a']);
    expect(e.kind).toBe('invalid');
    expect(e.status).toBeNull();
    expect(e.errors).toEqual(['a']);
  });
});

/** #39 AC-4: 取引カレンダー（/api/calendar）。fetch は偽物、版は架空（日付は公開の休業日）。 */
describe('loadCalendarJson（/api/calendar を読む）', () => {
  interface Init {
    signal?: AbortSignal;
    cache?: RequestCache;
    redirect?: RequestRedirect;
  }
  const calText = JSON.stringify({
    schema_version: 1,
    source: 'bigquery',
    version_at: '2026-10-14T08:30:00+09:00',
    covered_until: '2027-06-30',
    listed_until: '2027-12-31',
    days: [
      { date: '2026-12-31', is_trading_day: false, status: 'confirmed', name: '年末休業日' },
      { date: '2027-01-01', is_trading_day: false, status: 'planned', name: '元日' },
    ],
  });

  function recorder(res: { ok: boolean; status: number; type?: string; body?: string }) {
    const calls: { url: string; init: Init | undefined }[] = [];
    const fetch = async (url: string, init?: Init) => {
      calls.push({ url, init });
      return {
        ok: res.ok,
        status: res.status,
        ...(res.type !== undefined ? { type: res.type } : {}),
        text: async () => res.body ?? '',
      };
    };
    return { fetch, calls };
  }

  it('(a) 200 → 検証済みの版', async () => {
    const { fetch } = recorder({ ok: true, status: 200, body: calText });
    const json = await loadCalendarJson({ fetch });
    expect(json.covered_until).toBe('2027-06-30');
    expect(json.days.map((d) => d.date)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it("(b) URL は /api/calendar、init は cache: 'no-cache'・redirect: 'manual'（signal も渡す）", async () => {
    const { fetch, calls } = recorder({ ok: true, status: 200, body: calText });
    await loadCalendarJson({ fetch });
    const ctl = new AbortController();
    await loadCalendarJson({ fetch, signal: ctl.signal });
    expect(calls.map((c) => c.url)).toEqual(['/api/calendar', '/api/calendar']);
    expect(calls[0]?.init).toEqual({ cache: 'no-cache', redirect: 'manual' });
    expect(calls[1]?.init).toEqual({ cache: 'no-cache', redirect: 'manual', signal: ctl.signal });
  });

  it('(c) 503 → kind http・status 503。応答の本文を含めない', async () => {
    const { fetch } = recorder({ ok: false, status: 503, body: '{"error":"secret detail"}' });
    const e = await loadCalendarJson({ fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('http');
    expect(e.status).toBe(503);
    expect(e.message).toBe('カレンダーを読めない（api: HTTP 503）');
    expect(e.message).not.toMatch(/secret/);
    expect(e.errors).toEqual([]);
  });

  it.each([
    ['opaqueredirect', { ok: false, status: 0, type: 'opaqueredirect' }],
    ['401', { ok: false, status: 401, body: 'login page' }],
  ])('(d) %s → ログイン切れ（kind auth）', async (_name, res) => {
    const { fetch } = recorder(res);
    const e = await loadCalendarJson({ fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('auth');
    expect(e.message).toBe('ログインが切れた（api）');
    expect(e.message).not.toMatch(/login page/);
  });

  it('(e) 通信エラー（例外）→ kind network', async () => {
    const e = await loadCalendarJson({
      fetch: async () => {
        throw new TypeError('Failed to fetch secret-host');
      },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('network');
    expect(e.message).toBe('カレンダーを読めない（api: 通信エラー）');
    expect(e.message).not.toMatch(/secret/);
  });

  it('(f) AbortError はそのまま投げる', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      loadCalendarJson({
        fetch: async () => {
          throw abort;
        },
      }),
    ).rejects.toBe(abort);
  });

  it.each([
    ['検証に落ちる', '{"schema_version":1}', '$.version_at'],
    ['JSON として解析できない', '<html>login</html>', '$'],
  ])('(g) 壊れた JSON（%s）→ kind invalid・明細つき', async (_name, body, path) => {
    const { fetch } = recorder({ ok: true, status: 200, body });
    const e = await loadCalendarJson({ fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(ChainLoadError);
    expect(e.kind).toBe('invalid');
    expect(e.message).toBe('カレンダーの JSON が不正（api）');
    expect(e.message).not.toMatch(/login/);
    expect(e.errors.some((x: string) => x.startsWith(`${path}:`))).toBe(true);
  });
});

it('読んで正規化まで', async () => {
  const a = createFileAdapter({ blob: new Blob([latestText]) });
  const chain = await loadNormalizedChain(a, { r: 0.004 });
  expect(chain.r).toBe(0.004);
  expect(chain.months.map((m) => m.id)).toEqual(['2026-11', '2026-12']);
});

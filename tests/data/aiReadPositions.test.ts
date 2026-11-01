import { describe, expect, it } from 'vitest';
import {
  AI_READ_POSITIONS_PATH,
  parseReadResult,
  postReadPositions,
  type ReadPositionsRequest,
  type ReadRow,
} from '../../data/aiReadPositions';
import { AiRequestError } from '../../data/aiStream';

/**
 * #318: 建玉の一覧の画像の読み取りの受け口（data/aiReadPositions.ts）。応答の検査は中継
 * （api/src/simulator_api/ai/read_positions.py の check_result）と同じ形。値は架空。
 */

const ROW: ReadRow = {
  product: 'op_large',
  expiry_year: 2026,
  expiry_month: 12,
  type: 'P',
  strike: 60000,
  side: 'sell',
  qty: 2,
  price: 150,
  opened_on: '2026-10-01',
};
const OK = { schema_version: 1, kind: 'positions', rows: [ROW], remaining_usd: 2.5 };
const BODY: ReadPositionsRequest = {
  schema_version: 1,
  image: { media_type: 'image/png', data: 'iVBORw0KGgo=' },
};

describe('parseReadResult', () => {
  it('中継の形をそのまま通す（null の欄も）', () => {
    expect(parseReadResult(OK)).toEqual({ kind: 'positions', rows: [ROW], remaining_usd: 2.5 });
    const nulls = { ...ROW, strike: null, type: null, opened_on: null, expiry_year: null };
    expect(parseReadResult({ ...OK, rows: [nulls] })?.rows[0]).toEqual(nulls);
    expect(parseReadResult({ ...OK, remaining_usd: null })?.remaining_usd).toBeNull();
  });

  it('not_positions は行を持たない', () => {
    expect(parseReadResult({ ...OK, kind: 'not_positions', rows: [] })).toEqual({
      kind: 'not_positions',
      rows: [],
      remaining_usd: 2.5,
    });
  });

  it.each([
    ['知らないキー（行）', { ...OK, rows: [{ ...ROW, name: 'x' }] }],
    ['知らないキー（上）', { ...OK, extra: 1 }],
    ['欄が欠ける', { ...OK, rows: [{ ...ROW, qty: undefined }] }],
    ['型の違い（数に文字列）', { ...OK, rows: [{ ...ROW, qty: '2' }] }],
    ['列挙に無い文字列', { ...OK, rows: [{ ...ROW, side: '売建' }] }],
    ['商品に自由な文字列', { ...OK, rows: [{ ...ROW, product: 'mini_option' }] }],
    ['日付の形でない', { ...OK, rows: [{ ...ROW, opened_on: '10/01' }] }],
    ['整数でない枚数', { ...OK, rows: [{ ...ROW, qty: 1.5 }] }],
    ['行が 21', { ...OK, rows: Array(21).fill(ROW) }],
    ['schema_version', { ...OK, schema_version: 2 }],
    ['kind', { ...OK, kind: 'x' }],
    ['配列でない', [OK]],
  ])('%s → null', (_, v) => {
    expect(parseReadResult(v)).toBeNull();
  });
});

function fakeFetch(res: Response, seen: { url: string; init: RequestInit | undefined }[] = []) {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return res;
  }) as unknown as typeof fetch;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

describe('postReadPositions', () => {
  it('JSON で POST（画像 1 つ・Content-Type・同じオリジン・リダイレクトを追わない）', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const out = await postReadPositions(BODY, undefined, fakeFetch(json(200, OK), seen));
    expect(out.rows).toEqual([ROW]);
    expect(seen[0]?.url).toBe(AI_READ_POSITIONS_PATH);
    const init = seen[0]?.init;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('same-origin');
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual(BODY);
    expect(Object.keys(sent.image)).toEqual(['media_type', 'data']);
  });

  it('口を変えられる（dev の合成の応答）', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    await postReadPositions(BODY, undefined, fakeFetch(json(200, OK), seen), '/fixtures/ai/x');
    expect(seen[0]?.url).toBe('/fixtures/ai/x');
  });

  it('中継の失敗は AiRequestError（code と remaining_usd）', async () => {
    const e = await postReadPositions(
      BODY,
      undefined,
      fakeFetch(json(429, { error: 'budget_exceeded', remaining_usd: 0.1 })),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(AiRequestError);
    expect([e.status, e.code, e.remainingUsd]).toEqual([429, 'budget_exceeded', 0.1]);
    const bad = await postReadPositions(
      BODY,
      undefined,
      fakeFetch(json(502, { error: 'bad_result' })),
    ).catch((x) => x);
    expect(bad.code).toBe('bad_result');
  });

  it('形の違う 200 は bad_result、JSON でない 200 は session_expired、リダイレクトは session_expired', async () => {
    const e1 = await postReadPositions(
      BODY,
      undefined,
      fakeFetch(json(200, { ...OK, extra: 1 })),
    ).catch((x) => x);
    expect(e1.code).toBe('bad_result');
    const e2 = await postReadPositions(
      BODY,
      undefined,
      fakeFetch(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    ).catch((x) => x);
    expect(e2.code).toBe('session_expired');
    const e3 = await postReadPositions(
      BODY,
      undefined,
      fakeFetch(new Response(null, { status: 302 })),
    ).catch((x) => x);
    expect(e3.code).toBe('session_expired');
  });

  it('通信の失敗は network', async () => {
    const f = (async () => {
      throw new TypeError('fail');
    }) as unknown as typeof fetch;
    const e = await postReadPositions(BODY, undefined, f).catch((x) => x);
    expect(e.code).toBe('network');
  });
});

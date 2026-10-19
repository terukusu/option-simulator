import { describe, expect, it } from 'vitest';
import {
  type AiEvent,
  type AiRequest,
  AiRequestError,
  getAiStatus,
  parseSse,
  postAiMessages,
  toAiEvent,
  toAiStatus,
} from '../../data/aiStream';
import { aiErrorText } from '../../ui/view/aiChat';

/**
 * #134 AC7: AI の中継の SSE の解析（data/aiStream.ts）。サーバー（api/src/simulator_api/ai/relay.py）の書き方
 * （`event: <名前>\ndata: <JSON 1 行>\n\n`）と、SSE の仕様の範囲（chunk の境・\r\n・複数行の data・コメント）を確かめる。
 */

const STREAM =
  'event: accepted\ndata: {"remaining_usd":2.79,"limit_usd":3,"counted":true}\n\n' +
  'event: progress\ndata: {"phase":"writing"}\n\n' +
  'event: text\ndata: {"text":"下に弱い"}\n\n' +
  'event: done\ndata: {"stop_reason":"end_turn","content":[{"type":"text","text":"下に弱い"}],"remaining_usd":2.9}\n\n';

/** 文字列を chunk に切って順に流し、全部の件を集める */
function feed(chunks: string[]) {
  let rest = '';
  const out = [];
  for (const c of chunks) {
    const p = parseSse(rest + c);
    rest = p.rest;
    out.push(...p.messages);
  }
  return { out, rest };
}

describe('parseSse', () => {
  it('区切りまでの件を返し、残りを rest に持ち越す', () => {
    const { messages, rest } = parseSse(`${STREAM}event: text\ndata: {"te`);
    expect(messages.map((m) => m.event)).toEqual(['accepted', 'progress', 'text', 'done']);
    expect(rest).toBe('event: text\ndata: {"te');
  });

  it('区切りが chunk をまたいでも同じ結果（1 文字ずつ・任意の位置）', () => {
    const whole = parseSse(STREAM).messages;
    expect(feed(STREAM.split('')).out).toEqual(whole);
    for (const at of [1, 7, 15, 40, STREAM.indexOf('\n\n') + 1, STREAM.length - 1]) {
      expect(feed([STREAM.slice(0, at), STREAM.slice(at)]).out).toEqual(whole);
    }
  });

  it('\\r\\n と \\r の改行。\\r と \\n が chunk に分かれても 1 つの改行', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    const whole = parseSse(STREAM).messages;
    expect(parseSse(crlf).messages).toEqual(whole);
    expect(feed(crlf.split('')).out).toEqual(whole);
    // 末尾の \r は次の chunk を待つ（\r\n の片割れかもしれない）
    expect(parseSse('event: a\rdata: {}\r\revent: b').messages).toEqual([
      { event: 'a', data: '{}' },
    ]);
    // "data: x\r" | "\nevent..." が誤って空行（区切り）にならない
    expect(feed(['event: a\r', '\ndata: {}\r', '\n\r', '\n']).out).toEqual([
      { event: 'a', data: '{}' },
    ]);
  });

  it('複数行の data は \\n でつなぐ・コメント行は飛ばす・event が無ければ message', () => {
    const { messages } = parseSse(': ping\n\nevent: x\ndata: a\ndata: b\n\ndata:c\n\n');
    expect(messages).toEqual([
      { event: 'x', data: 'a\nb' },
      { event: 'message', data: 'c' },
    ]);
  });
});

describe('toAiEvent', () => {
  it('中継のイベントを型に', () => {
    const events = parseSse(STREAM).messages.map(toAiEvent);
    expect(events[0]).toEqual({
      type: 'accepted',
      remaining_usd: 2.79,
      limit_usd: 3,
      counted: true,
    });
    expect(events[1]).toEqual({ type: 'progress', phase: 'writing' });
    expect(events[2]).toEqual({ type: 'text', text: '下に弱い' });
    expect(events[3]).toEqual({
      type: 'done',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '下に弱い' }],
      remaining_usd: 2.9,
    });
    expect(toAiEvent({ event: 'error', data: '{"code":"timeout"}' })).toEqual({
      type: 'error',
      code: 'timeout',
    });
    expect(
      toAiEvent({
        event: 'tool_use',
        data: '{"id":"toolu_1","name":"payoff_at","input":{"x":29000}}',
      }),
    ).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'payoff_at', input: { x: 29000 } });
  });

  it('知らないイベント・壊れた data・形の違いは unknown（飛ばせる）', () => {
    expect(toAiEvent({ event: 'ping', data: '{}' })).toEqual({ type: 'unknown', event: 'ping' });
    expect(toAiEvent({ event: 'text', data: '{nope' })).toEqual({ type: 'unknown', event: 'text' });
    expect(toAiEvent({ event: 'text', data: '{"text":1}' })).toEqual({
      type: 'unknown',
      event: 'text',
    });
    expect(toAiEvent({ event: 'progress', data: '{"phase":"other"}' })).toEqual({
      type: 'unknown',
      event: 'progress',
    });
    expect(toAiEvent({ event: 'done', data: '[]' })).toEqual({ type: 'unknown', event: 'done' });
  });
});

describe('postAiMessages', () => {
  const body: AiRequest = {
    schema_version: 1,
    kind: 'chat',
    context: {
      snapshot: {
        snapshot_at: '2026-10-13T21:45:00+09:00',
        source: 'synthetic',
        delayed_minutes: 15,
      },
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: '弱点は？' }] }],
  };

  it('chunk に分かれた SSE を順にイベントで渡す・JSON で送る', async () => {
    const enc = new TextEncoder().encode(STREAM);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < enc.length; i += 7) c.enqueue(enc.slice(i, i + 7)); // UTF-8 の途中でも切る
        c.close();
      },
    });
    let sent: RequestInit | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = init;
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const got: AiEvent[] = [];
    await postAiMessages(body, (e) => got.push(e), undefined, fetchFn);
    expect(got.map((e) => e.type)).toEqual(['accepted', 'progress', 'text', 'done']);
    if (sent === undefined) throw new Error('fetch が呼ばれていない');
    expect((sent.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(sent.body as string)).toEqual(body);
  });

  it('事前の失敗は AiRequestError（code と残り）', async () => {
    const fetchFn = (async () =>
      new Response('{"error":"budget_exceeded","remaining_usd":0.05}', {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const err = await postAiMessages(body, () => {}, undefined, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect([err.status, err.code, err.remainingUsd]).toEqual([429, 'budget_exceeded', 0.05]);
  });

  // ---- #135 AC5: 終わり方と切断の区別
  const sseRes = (text: string, init: ResponseInit = {}) =>
    new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      ...init,
    });
  const run = async (fetchFn: typeof fetch, signal?: AbortSignal) => {
    const got: AiEvent[] = [];
    const err = await postAiMessages(body, (e) => got.push(e), signal, fetchFn).then(
      () => null,
      (e) => e,
    );
    return { got, err };
  };

  it('done / error の無いまま終わると最後に incomplete を 1 回', async () => {
    const cut = STREAM.slice(0, STREAM.indexOf('event: done'));
    const { got, err } = await run((async () => sseRes(cut)) as unknown as typeof fetch);
    expect(err).toBeNull();
    expect(got.map((e) => e.type)).toEqual(['accepted', 'progress', 'text', 'incomplete']);
    // done があれば incomplete は足さない。error で終わっても足さない
    const ok = await run((async () => sseRes(STREAM)) as unknown as typeof fetch);
    expect(ok.got.at(-1)?.type).toBe('done');
    const errEnd = await run((async () =>
      sseRes(`${cut}event: error\ndata: {"code":"timeout"}\n\n`)) as unknown as typeof fetch);
    expect(errEnd.got.map((e) => e.type).at(-1)).toBe('error');
    expect(errEnd.got.some((e) => e.type === 'incomplete')).toBe(false);
  });

  it('途中で読めなくなったら incomplete（切断）', async () => {
    const enc = new TextEncoder().encode(STREAM.slice(0, 80));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc);
        c.error(new TypeError('network error'));
      },
    });
    const { got, err } = await run(
      (async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })) as unknown as typeof fetch,
    );
    expect(err).toBeNull();
    expect(got.at(-1)).toEqual({ type: 'incomplete' });
  });

  it('IAP のセッション切れ: リダイレクトと SSE でない 200 は session_expired、fetch の失敗は network', async () => {
    let init: RequestInit | undefined;
    const redirect = (async (_u: string, i: RequestInit) => {
      init = i;
      return { type: 'opaqueredirect', status: 0, ok: false } as unknown as Response;
    }) as unknown as typeof fetch;
    const a = await run(redirect);
    expect([a.err?.code, a.err?.status]).toEqual(['session_expired', 0]);
    expect(init?.redirect).toBe('manual');
    const html = (async () =>
      new Response('<html>Sign in</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch;
    const b = await run(html);
    expect(b.err).toBeInstanceOf(AiRequestError);
    expect(b.err.code).toBe('session_expired');
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const c = await run(offline);
    expect([c.err?.code, c.err?.status]).toEqual(['network', 0]);
    // 3 つとも画面の文言が違う（session_expired は再読み込み、network / incomplete は途中で切れた）
    const texts = new Set(['session_expired', 'network', 'incomplete'].map((k) => aiErrorText(k)));
    expect(texts.size).toBe(3);
    expect(aiErrorText('session_expired')).toContain('再読み込み');
    expect(aiErrorText('incomplete')).toContain('途中で切れ');
    expect(aiErrorText('budget_exceeded', 0.05)).toContain('$0.05');
  });

  it('中止（AbortError）はそのまま投げる（network にしない）', async () => {
    const ac = new AbortController();
    const fetchFn = (async (_u: string, i: RequestInit) => {
      ac.abort();
      if (i.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return sseRes(STREAM);
    }) as unknown as typeof fetch;
    const { err } = await run(fetchFn, ac.signal);
    expect(err?.name).toBe('AbortError');
  });

  it('送り先は引数（dev の合成の応答）', async () => {
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      return sseRes(STREAM);
    }) as unknown as typeof fetch;
    await postAiMessages(body, () => {}, undefined, fetchFn, '/fixtures/ai/messages');
    await postAiMessages(body, () => {}, undefined, fetchFn);
    expect(urls).toEqual(['/fixtures/ai/messages', '/api/ai/messages']);
  });
});

describe('getAiStatus', () => {
  const ST = {
    schema_version: 1,
    enabled: true,
    model: 'claude-opus-5-5',
    credential: 'api_key',
    counted: true,
    limit_usd: 3,
    remaining_usd: 2.4,
    resets_at: '2026-10-20T00:00:00+09:00',
  };
  it('形を検査して返す・形の違いは unavailable・HTML は session_expired', async () => {
    const json = (v: unknown) =>
      (async () =>
        new Response(JSON.stringify(v), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })) as unknown as typeof fetch;
    expect(await getAiStatus(json(ST))).toEqual(ST);
    const bad = await getAiStatus(json({ ...ST, enabled: 'yes' })).catch((e) => e);
    expect(bad.code).toBe('unavailable');
    const html = await getAiStatus(
      (async () =>
        new Response('<html/>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof fetch,
    ).catch((e) => e);
    expect(html.code).toBe('session_expired');
    expect(toAiStatus({ ...ST, credential: 'other' })).toBeNull();
    expect(
      toAiStatus({
        ...ST,
        enabled: false,
        model: null,
        credential: null,
        limit_usd: null,
        remaining_usd: null,
        resets_at: null,
      })?.enabled,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type AiEvent,
  type AiRequest,
  AiRequestError,
  parseSse,
  postAiMessages,
  toAiEvent,
} from '../../data/aiStream';

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
});

/**
 * AI の中継（`POST /api/ai/messages` の SSE・`GET /api/ai/status`。#134）のブラウザ側の受け口: 要求・応答の型と、
 * SSE の解析（純関数）。設計 docs/design.md 7.1・13.4、docs/ai-advisor.md 論点 4・6。画面（ボタン・チャット）は #135。
 *
 * - 会話はブラウザが持ち、毎回全部送る（論点 6 = A）。`done` の `content` をそのまま assistant の履歴に足して次に送る
 *   （thinking の署名を含む。変えない）
 * - サーバーは api/src/simulator_api/ai/relay.py。イベントは `accepted` →（`progress` | `thinking` | `text` | `tool_use`）*
 *   → `done` | `error`
 * - 純関数（DOM・通信に依存しない）。`postAiMessages` だけが fetch の薄い包み
 */

export const AI_SCHEMA_VERSION = 1;

export type AiKind = 'chat';

export type AiUserBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: [{ type: 'text'; text: string }];
      is_error?: boolean;
    };

export type AiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type AiMessage =
  | { role: 'user'; content: AiUserBlock[] }
  | { role: 'assistant'; content: AiAssistantBlock[] };

/** 文脈（許可リストの形。サーバーの api/src/simulator_api/ai/allowlist.py が検査する。IV は %） */
export interface AiContext {
  snapshot: {
    snapshot_at: string;
    source: 'bigquery' | 'file' | 'synthetic' | 'manual';
    delayed_minutes: number;
  };
  expiries?: {
    expiry: string;
    sq_date: string;
    t_days: number;
    forward: number;
    atm_k: number;
    atm_iv: number;
    smile: { m: number; iv: number }[];
    rows?: {
      k: number;
      type: 'C' | 'P';
      bid: number | null;
      ask: number | null;
      iv: number | null;
    }[];
  }[];
  position?: {
    legs: {
      product: 'op' | 'fut_large' | 'fut_mini' | 'fut_micro';
      type?: 'C' | 'P';
      expiry: string;
      k?: number;
      side: 'buy' | 'sell';
      qty: number;
      price: number;
    }[];
  };
  scenario?: { days: number; iv_shift_pt: number; x_range: [number, number] };
  capital?: { capital_yen: number; max_loss_yen?: number };
  precomputed?: Record<string, unknown>;
}

export interface AiRequest {
  schema_version: typeof AI_SCHEMA_VERSION;
  kind: AiKind;
  context: AiContext;
  messages: AiMessage[];
}

/** 中継のイベント（知らないイベント・壊れた data は `unknown`） */
export type AiEvent =
  | { type: 'accepted'; remaining_usd: number | null; limit_usd: number | null; counted: boolean }
  | { type: 'progress'; phase: 'thinking' | 'writing' | 'tool' }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'done';
      stop_reason: string | null;
      content: AiAssistantBlock[];
      remaining_usd: number | null;
    }
  | { type: 'error'; code: string }
  | { type: 'unknown'; event: string };

/** `GET /api/ai/status` */
export interface AiStatus {
  schema_version: number;
  enabled: boolean;
  model: string | null;
  credential: 'api_key' | 'oauth_token' | 'wif' | 'fake' | null;
  counted: boolean;
  limit_usd: number | null;
  remaining_usd: number | null;
  resets_at: string | null;
}

/** SSE の 1 件（イベント名と data の行をつないだもの） */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * SSE の解析。`buffer` は前回の `rest` に新しい chunk をつないだもの。区切り（空行）まで届いた分を `messages` に、
 * 残りを `rest` に返す。改行は `\n`・`\r\n`・`\r`。`:` で始まる行はコメント。`data:` が複数行なら `\n` でつなぐ。
 * event が無ければ `message`。data の無い件は捨てる（仕様どおり）。
 */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  // 末尾の \r は次の chunk の \n と組（\r\n）になりうるので、正規化せずに rest へ持ち越す
  const tail = buffer.endsWith('\r') ? '\r' : '';
  const text = (tail ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
  const messages: SseMessage[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf('\n\n', start);
    if (end < 0) break;
    const block = text.slice(start, end);
    start = end + 2;
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) messages.push({ event, data: data.join('\n') });
  }
  return { messages, rest: text.slice(start) + tail };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v));

/** SSE の 1 件 → AiEvent（形が合わなければ unknown） */
export function toAiEvent(m: SseMessage): AiEvent {
  const unknown: AiEvent = { type: 'unknown', event: m.event };
  let d: unknown;
  try {
    d = JSON.parse(m.data);
  } catch {
    return unknown;
  }
  if (!isObj(d)) return unknown;
  switch (m.event) {
    case 'accepted':
      return numOrNull(d.remaining_usd) && numOrNull(d.limit_usd) && typeof d.counted === 'boolean'
        ? {
            type: 'accepted',
            remaining_usd: d.remaining_usd,
            limit_usd: d.limit_usd,
            counted: d.counted,
          }
        : unknown;
    case 'progress':
      return d.phase === 'thinking' || d.phase === 'writing' || d.phase === 'tool'
        ? { type: 'progress', phase: d.phase }
        : unknown;
    case 'thinking':
    case 'text':
      return typeof d.text === 'string' ? { type: m.event, text: d.text } : unknown;
    case 'tool_use':
      return typeof d.id === 'string' && typeof d.name === 'string' && isObj(d.input)
        ? { type: 'tool_use', id: d.id, name: d.name, input: d.input }
        : unknown;
    case 'done':
      return (d.stop_reason === null || typeof d.stop_reason === 'string') &&
        Array.isArray(d.content) &&
        d.content.every(isObj) &&
        numOrNull(d.remaining_usd)
        ? {
            type: 'done',
            stop_reason: d.stop_reason,
            content: d.content as AiAssistantBlock[],
            remaining_usd: d.remaining_usd,
          }
        : unknown;
    case 'error':
      return typeof d.code === 'string' ? { type: 'error', code: d.code } : unknown;
    default:
      return unknown;
  }
}

/** 中継の事前の失敗（JSON の応答）。code は bad_request・forbidden・budget_exceeded など */
export class AiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly remainingUsd: number | null = null,
  ) {
    super(`ai request failed: ${status} ${code}`);
  }
}

/**
 * `POST /api/ai/messages` を送り、イベントを順に `onEvent` に渡す。事前の失敗は AiRequestError。
 * `signal` で止める（中継は切断を受けて送信先を閉じる。費用は予約額のまま数える）。
 */
export async function postAiMessages(
  body: AiRequest,
  onEvent: (e: AiEvent) => void,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchFn('/api/ai/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
    credentials: 'same-origin',
  });
  if (!res.ok || !res.body) {
    let code = 'unavailable';
    let remaining: number | null = null;
    try {
      const j: unknown = await res.json();
      if (isObj(j) && typeof j.error === 'string') code = j.error;
      if (isObj(j) && typeof j.remaining_usd === 'number') remaining = j.remaining_usd;
    } catch {
      // JSON でない応答（IAP の画面など）は unavailable のまま
    }
    throw new AiRequestError(res.status, code, remaining);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseSse(rest + value);
    rest = parsed.rest;
    for (const m of parsed.messages) onEvent(toAiEvent(m));
  }
}

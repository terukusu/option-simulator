/**
 * AI の中継（`POST /api/ai/messages` の SSE・`GET /api/ai/status`。#134）のブラウザ側の受け口: 要求・応答の型と、
 * SSE の解析（純関数）。設計 docs/design.md 7.1・13.4・14 章、docs/ai-advisor.md 論点 4・6。画面は ui/next/regions/AiChat.tsx（#135）。
 *
 * - 会話はブラウザが持ち、毎回全部送る（論点 6 = A）。`done` の `content` をそのまま assistant の履歴に足して次に送る
 *   （thinking の署名を含む。変えない）
 * - サーバーは api/src/simulator_api/ai/relay.py。イベントは `accepted` →（`progress` | `thinking` | `text` | `tool_use`）*
 *   → `done` | `error`
 * - 会話の途中で板・ポジション・シナリオが変わったら、最初の `context` は変えずに新しい user の発言に `context_update` の
 *   block を足す（#135。中継が `<context_update>` の text にして後ろに置く = 前の履歴のバイト列を変えない）
 * - 終わり方（#135）: `done` / `error` の無いまま流れが終わった・途中で読めなくなった → 最後に `incomplete` を 1 回。
 *   IAP のセッション切れ（リダイレクト・`text/event-stream` でない 200）は `AiRequestError(0, 'session_expired')`、
 *   fetch の失敗（TypeError）は `AiRequestError(0, 'network')`。中止（AbortError）はそのまま投げる
 * - 純関数（DOM・通信に依存しない）。`postAiMessages`・`getAiStatus` だけが fetch の薄い包み
 */

export const AI_SCHEMA_VERSION = 1;

/**
 * 定型の種類（diagnose = [このポジションを診断]。#135。ask = 数字・パネルから [AI に聞く]。#136。preset = 定型の質問の
 * チップ。#140）
 */
export type AiKind = 'chat' | 'diagnose' | 'ask' | 'preset';

export type AiUserBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: [{ type: 'text'; text: string }];
      is_error?: boolean;
    }
  /** 会話の途中の文脈の更新（2 件目以降の user の発言・tool_result の後ろに 1 つまで。#135） */
  | { type: 'context_update'; context: AiContext };

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
      /** 建ててから今の板までの暦日（#302。前の板で建てた足だけ） */
      opened_days?: number;
    }[];
    /** 作業中のタブが保有（#302。保有のときだけ true を送る） */
    held?: true;
    /** ほかの保有の数（#302。保有ポジションの一覧の「合計に入れる」行のうち作業中のタブ以外。1 以上のときだけ） */
    other_held?: number;
  };
  scenario?: {
    days: number;
    iv_shift_pt: number;
    x_range: [number, number];
    /** #135 で足した任意のキー（iv_mode が relative なら iv_shift_pt は %） */
    dx_yen?: number;
    skew_pt?: number;
    beta?: number;
    iv_mode?: 'absolute' | 'relative';
  };
  capital?: { capital_yen: number; max_loss_yen?: number };
  /** 利用者が設定に書いた自分の前提（#156。自由記述。中継の上限 1,000 字） */
  profile?: { text: string };
  precomputed?: Record<string, unknown>;
}

export interface AiRequest {
  schema_version: typeof AI_SCHEMA_VERSION;
  kind: AiKind;
  context: AiContext;
  messages: AiMessage[];
  /**
   * [AI に聞く] の場所（#136。kind が ask のときだけ。ui/view/aiAsk.ts の AI_ASK_TOPICS）か定型の ID（#140。kind が
   * preset のときだけ。ui/view/aiPresets.ts の AI_PRESET_IDS）。中継はログ ai_request に出すだけで Anthropic には送らない
   */
  topic?: string;
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
  /** done / error の無いまま流れが終わった・途中で読めなくなった（ブラウザが最後に 1 回足す。#135） */
  | { type: 'incomplete' }
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

/** 既定の口（dev の合成の応答は `/fixtures/ai/…`。ui/components/useAiChat.ts が選ぶ） */
export const AI_MESSAGES_PATH = '/api/ai/messages';
export const AI_STATUS_PATH = '/api/ai/status';

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

/**
 * fetch の包み: リダイレクトは追わない（IAP のセッション切れ = session_expired）、失敗は network。画像の読み取り
 * （data/aiReadPositions.ts。#318）も使う
 */
export async function fetchAi(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: 'manual', credentials: 'same-origin' });
  } catch (e) {
    if (isAbort(e)) throw e;
    // CORS で落ちた IAP のリダイレクト・オフライン・DNS など（本文は持たない）
    throw new AiRequestError(0, 'network');
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new AiRequestError(0, 'session_expired');
  }
  return res;
}

const contentType = (res: Response) => (res.headers.get('Content-Type') ?? '').toLowerCase();

/** 中継の事前の失敗の応答（JSON の error・remaining_usd）→ AiRequestError（画像の読み取りも使う） */
export async function aiFailure(res: Response): Promise<AiRequestError> {
  let code = 'unavailable';
  let remaining: number | null = null;
  try {
    const j: unknown = await res.json();
    if (isObj(j) && typeof j.error === 'string') code = j.error;
    if (isObj(j) && typeof j.remaining_usd === 'number') remaining = j.remaining_usd;
  } catch {
    // JSON でない応答（IAP の画面など）は unavailable のまま
  }
  return new AiRequestError(res.status, code, remaining);
}

/**
 * `POST /api/ai/messages` を送り、イベントを順に `onEvent` に渡す。事前の失敗は AiRequestError
 * （`session_expired`・`network` を含む）。`done` / `error` の無い終わり・途中の読み取りの失敗は最後に `incomplete`。
 * `signal` で止める（中継は切断を受けて送信先を閉じる。費用は予約額のまま数える。AbortError を投げる）。
 */
export async function postAiMessages(
  body: AiRequest,
  onEvent: (e: AiEvent) => void,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
  endpoint: string = AI_MESSAGES_PATH,
): Promise<void> {
  const res = await fetchAi(fetchFn, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok) throw await aiFailure(res);
  if (!contentType(res).startsWith('text/event-stream') || !res.body) {
    // 200 でも SSE でない = IAP のログインの画面など
    throw new AiRequestError(res.status, 'session_expired');
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(rest + value);
      rest = parsed.rest;
      for (const m of parsed.messages) {
        const ev = toAiEvent(m);
        if (ev.type === 'done' || ev.type === 'error') ended = true;
        onEvent(ev);
      }
    }
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw e;
    // 途中で読めなくなった（切断）。下で incomplete
  }
  if (!ended) onEvent({ type: 'incomplete' });
}

/** `GET /api/ai/status` の形の検査（合わなければ null） */
export function toAiStatus(v: unknown): AiStatus | null {
  if (!isObj(v) || typeof v.enabled !== 'boolean' || typeof v.counted !== 'boolean') return null;
  const cred = v.credential;
  const credOk =
    cred === null ||
    cred === 'api_key' ||
    cred === 'oauth_token' ||
    cred === 'wif' ||
    cred === 'fake';
  const strOrNull = (x: unknown) => x === null || typeof x === 'string';
  if (
    !credOk ||
    !strOrNull(v.model) ||
    !strOrNull(v.resets_at) ||
    !numOrNull(v.limit_usd) ||
    !numOrNull(v.remaining_usd) ||
    typeof v.schema_version !== 'number'
  ) {
    return null;
  }
  return {
    schema_version: v.schema_version,
    enabled: v.enabled,
    model: v.model as string | null,
    credential: cred as AiStatus['credential'],
    counted: v.counted,
    limit_usd: v.limit_usd as number | null,
    remaining_usd: v.remaining_usd as number | null,
    resets_at: v.resets_at as string | null,
  };
}

/** `GET /api/ai/status`。失敗は AiRequestError（session_expired・network・unavailable） */
export async function getAiStatus(
  fetchFn: typeof fetch = fetch,
  endpoint: string = AI_STATUS_PATH,
  signal?: AbortSignal,
): Promise<AiStatus> {
  const res = await fetchAi(fetchFn, endpoint, { method: 'GET', signal: signal ?? null });
  if (!res.ok) throw await aiFailure(res);
  if (!contentType(res).startsWith('application/json')) {
    throw new AiRequestError(res.status, 'session_expired');
  }
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    throw new AiRequestError(res.status, 'unavailable');
  }
  const st = toAiStatus(j);
  if (!st) throw new AiRequestError(res.status, 'unavailable');
  return st;
}

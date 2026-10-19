/**
 * AI のチャットの状態と reducer（#135。docs/design.md 14 章、docs/ai-advisor.md 論点 6）。純関数（Preact・DOM・通信に
 * 依存しない）。fetch・sessionStorage・道具の実行の呼び出しは ui/components/useAiChat.ts。
 *
 * - 会話はブラウザが持ち、毎回全部送る（論点 6 = A）。最初の文脈（context）は固定し、板・ポジション・シナリオ・資金が
 *   変わったら（指紋 = canonical JSON の比較）次の発言に context_update の block を足す（前の履歴は変えない = preserved
 *   thinking と prompt caching の前置きを保つ）
 * - 1 回の発言（turn）: begin（押した瞬間に「計算中」）→ send（文脈を作って user の発言を足す）→ イベント →
 *   done（stop_reason が tool_use なら道具の結果を足して次の要求。道具の往復は MAX_TOOL_ROUNDS 回まで）
 * - 失敗・中止: その turn の履歴を戻し（次に送る会話の形を壊さない）、途中までの文と理由を failed に残す（[もう一度]）
 * - 保存: sessionStorage の 1 キー（AI_SESSION_KEY）だけ。タブを閉じたら消える。保存一覧・URL 共有・書き出しには
 *   載せない（オーナー判断 2026-10-19）
 */

import type {
  AiAssistantBlock,
  AiContext,
  AiEvent,
  AiKind,
  AiMessage,
  AiRequest,
  AiStatus,
  AiUserBlock,
} from '../../data/aiStream';

export const AI_SESSION_KEY = 'optsim.ai.v1';
/** [このポジションを診断] の最初の発言（中継の relay.DIAGNOSE_TEXT と同じ文。system prompt の診断の節が参照する） */
export const DIAGNOSE_TEXT = 'このポジションを診断してください。';
/** 中継の上限（allowlist.py の MAX_MESSAGES・MAX_FREE_TEXT_TOTAL・MAX_USER_TEXT） */
export const MAX_MESSAGES = 60;
export const MAX_FREE_TEXT = 100_000;
export const MAX_USER_TEXT = 4_000;
/** 1 回の発言の道具の往復の上限（費用の暴走を止める） */
export const MAX_TOOL_ROUNDS = 4;
/** 上限のこの割合で「長くなりました」 */
export const LONG_RATIO = 0.8;
/** 足の本数の上限（中継の MAX_LEGS） */
export const MAX_AI_LEGS = 20;

export type AiPhase = 'computing' | 'sending' | 'accepted' | 'thinking' | 'writing' | 'tool';

export const PHASE_LABEL: Record<AiPhase, string> = {
  computing: '計算中',
  sending: '送信中',
  accepted: '送信しました',
  thinking: '考え中',
  writing: '書いています',
  tool: '計算中',
};

export interface AiTurn {
  kind: AiKind;
  userText: string;
  phase: AiPhase;
  /** 押した時刻（ms。呼び出し側の時計） */
  startedAt: number;
  /** この要求の考え中の要約・本文（流れの途中） */
  thinking: string;
  text: string;
  /** 道具の往復の回数 */
  rounds: number;
  /** done で stop_reason が tool_use（道具の結果を待つ） */
  awaitingTools: boolean;
  /** 失敗したら戻す前の状態 */
  prev: { context: AiContext | null; lastKey: string | null; length: number };
}

export interface AiFailed {
  kind: AiKind;
  userText: string;
  partial: string;
  code: string;
  remainingUsd: number | null;
}

export interface AiChatState {
  /** 最初の文脈（会話の間は固定） */
  context: AiContext | null;
  /** 最後に送った文脈の指紋 */
  lastKey: string | null;
  messages: AiMessage[];
  turn: AiTurn | null;
  failed: AiFailed | null;
  /** 最後の発言の終わり方の知らせ（refusal・max_tokens・pause_turn・tool_limit。普通に終われば null） */
  stop: string | null;
  /** accepted / done の今日の残り（USD。数えないときは null） */
  remainingUsd: number | null;
}

export const INITIAL_AI_CHAT: AiChatState = {
  context: null,
  lastKey: null,
  messages: [],
  turn: null,
  failed: null,
  stop: null,
  remainingUsd: null,
};

export type AiChatAction =
  | { type: 'begin'; kind: AiKind; text: string; now: number }
  | { type: 'send'; context: AiContext; key: string }
  | { type: 'event'; event: AiEvent }
  | { type: 'toolResults'; blocks: AiUserBlock[] }
  | { type: 'fail'; code: string; remainingUsd?: number | null }
  | { type: 'reset' }
  | { type: 'restore'; saved: SavedAiChat };

const STOP_NOTES = new Set(['refusal', 'max_tokens', 'pause_turn']);

function fail(s: AiChatState, code: string, remainingUsd: number | null = null): AiChatState {
  const t = s.turn;
  if (!t) return s;
  return {
    ...s,
    context: t.prev.context,
    lastKey: t.prev.lastKey,
    messages: s.messages.slice(0, t.prev.length),
    turn: null,
    failed: { kind: t.kind, userText: t.userText, partial: t.text, code, remainingUsd },
    stop: null,
  };
}

function onEvent(s: AiChatState, ev: AiEvent): AiChatState {
  const t = s.turn;
  if (!t) return s;
  switch (ev.type) {
    case 'accepted':
      return { ...s, remainingUsd: ev.remaining_usd, turn: { ...t, phase: 'accepted' } };
    case 'progress':
      return t.phase === ev.phase ? s : { ...s, turn: { ...t, phase: ev.phase } };
    case 'thinking':
      return { ...s, turn: { ...t, thinking: t.thinking + ev.text } };
    case 'text':
      return { ...s, turn: { ...t, text: t.text + ev.text, phase: 'writing' } };
    case 'tool_use':
      return t.phase === 'tool' ? s : { ...s, turn: { ...t, phase: 'tool' } };
    case 'done': {
      const content = ev.content.filter(isAssistantBlock);
      const remainingUsd = ev.remaining_usd ?? s.remainingUsd;
      const wantsTools =
        ev.stop_reason === 'tool_use' && content.some((b) => b.type === 'tool_use');
      if (wantsTools && t.rounds > MAX_TOOL_ROUNDS) {
        // 上限の知らせの後も道具を求めた: その発言の履歴を戻して終える（最後が tool_result の user のまま残すと、
        // 次の発言で user が続き中継が 400 にする）。途中の文と理由（tool_limit）は失敗と同じく残す（[もう一度]）
        return fail({ ...s, remainingUsd }, 'tool_limit', remainingUsd);
      }
      if (content.length === 0) return fail({ ...s, remainingUsd }, 'empty');
      const messages: AiMessage[] = [...s.messages, { role: 'assistant', content }];
      if (wantsTools) {
        return {
          ...s,
          messages,
          remainingUsd,
          turn: { ...t, phase: 'tool', awaitingTools: true },
        };
      }
      const stop =
        ev.stop_reason !== null && STOP_NOTES.has(ev.stop_reason) ? ev.stop_reason : null;
      return { ...s, messages, remainingUsd, turn: null, failed: null, stop };
    }
    case 'error':
      return fail(s, ev.code);
    case 'incomplete':
      return fail(s, 'incomplete');
    case 'unknown':
      return s;
  }
}

const isAssistantBlock = (b: unknown): b is AiAssistantBlock => {
  if (typeof b !== 'object' || b === null) return false;
  const t = (b as { type?: unknown }).type;
  return t === 'text' || t === 'thinking' || t === 'redacted_thinking' || t === 'tool_use';
};

/** 変わらないときは同じ参照を返す */
export function aiChatReduce(s: AiChatState, a: AiChatAction): AiChatState {
  switch (a.type) {
    case 'begin':
      if (s.turn) return s;
      return {
        ...s,
        failed: null,
        stop: null,
        turn: {
          kind: a.kind,
          userText: a.text,
          phase: 'computing',
          startedAt: a.now,
          thinking: '',
          text: '',
          rounds: 0,
          awaitingTools: false,
          prev: { context: s.context, lastKey: s.lastKey, length: s.messages.length },
        },
      };
    case 'send': {
      const t = s.turn;
      if (t?.phase !== 'computing') return s;
      const text: AiUserBlock = { type: 'text', text: t.userText };
      if (s.context === null) {
        return {
          ...s,
          context: a.context,
          lastKey: a.key,
          messages: [...s.messages, { role: 'user', content: [text] }],
          turn: { ...t, phase: 'sending' },
        };
      }
      const content: AiUserBlock[] =
        a.key === s.lastKey ? [text] : [text, { type: 'context_update', context: a.context }];
      return {
        ...s,
        lastKey: a.key,
        messages: [...s.messages, { role: 'user', content }],
        turn: { ...t, phase: 'sending' },
      };
    }
    case 'event':
      return onEvent(s, a.event);
    case 'toolResults': {
      const t = s.turn;
      if (!t?.awaitingTools) return s;
      return {
        ...s,
        messages: [...s.messages, { role: 'user', content: a.blocks }],
        turn: { ...t, awaitingTools: false, rounds: t.rounds + 1, phase: 'sending', text: '' },
      };
    }
    case 'fail':
      return fail(s, a.code, a.remainingUsd ?? null);
    case 'reset':
      return s === INITIAL_AI_CHAT ? s : INITIAL_AI_CHAT;
    case 'restore':
      return {
        ...INITIAL_AI_CHAT,
        context: a.saved.context,
        lastKey: a.saved.lastKey,
        messages: a.saved.messages,
      };
  }
}

/** 今の turn の要求の本文（turn が無い・文脈が無ければ null） */
export function requestOf(s: AiChatState): AiRequest | null {
  if (!s.turn || s.context === null) return null;
  return { schema_version: 1, kind: s.turn.kind, context: s.context, messages: s.messages };
}

/** 最後の assistant の tool_use の block */
export function pendingToolUses(s: AiChatState): Extract<AiAssistantBlock, { type: 'tool_use' }>[] {
  const last = s.messages.at(-1);
  if (last?.role !== 'assistant') return [];
  return last.content.filter(
    (b): b is Extract<AiAssistantBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

/** 道具の上限の知らせ（最後の往復で道具の代わりに返す文） */
export const TOOL_LIMIT_NOTE = '道具の回数の上限です。ここまでの結果で答えてください。';

/**
 * 道具の結果の block（tool_result。失敗は is_error）。上限（rounds ≥ MAX_TOOL_ROUNDS）なら道具を実行せずに
 * `{"error":"tool_limit"}` と知らせの文
 */
export function toolResultBlocks(
  s: AiChatState,
  run: (name: string, input: Record<string, unknown>) => unknown,
): AiUserBlock[] {
  const uses = pendingToolUses(s);
  const limit = (s.turn?.rounds ?? 0) >= MAX_TOOL_ROUNDS;
  const blocks: AiUserBlock[] = uses.map((u) => {
    const r = limit ? { error: 'tool_limit' } : run(u.name, u.input);
    const isError =
      typeof r === 'object' && r !== null && typeof (r as { error?: unknown }).error === 'string';
    const b: AiUserBlock = {
      type: 'tool_result',
      tool_use_id: u.id,
      content: [{ type: 'text', text: JSON.stringify(r) }],
    };
    if (isError) b.is_error = true;
    return b;
  });
  if (limit) blocks.push({ type: 'text', text: TOOL_LIMIT_NOTE });
  return blocks;
}

// ---------------------------------------------------------------- 大きさ・押せない理由

const freeTextOf = (m: AiMessage) =>
  m.content.reduce(
    (n, b) =>
      n + (b.type === 'text' ? b.text.length : b.type === 'thinking' ? b.thinking.length : 0),
    0,
  );

export function chatSize(s: AiChatState): { messages: number; freeText: number } {
  return {
    messages: s.messages.length,
    freeText: s.messages.reduce((n, m) => n + freeTextOf(m), 0),
  };
}

/** 上限の 8 割で「長くなりました」 */
export function nearLimit(s: AiChatState): boolean {
  const z = chatSize(s);
  return z.messages >= MAX_MESSAGES * LONG_RATIO || z.freeText >= MAX_FREE_TEXT * LONG_RATIO;
}

/** これ以上送れない（発言 1 件と道具の往復の分が残らない） */
export function atLimit(s: AiChatState): boolean {
  const z = chatSize(s);
  return (
    z.messages + 1 + 2 * (MAX_TOOL_ROUNDS + 1) > MAX_MESSAGES ||
    z.freeText + MAX_USER_TEXT > MAX_FREE_TEXT
  );
}

export interface AiGate {
  hasChain: boolean;
  /** 評価できる足の本数 */
  legCount: number;
  /** /api/ai/status（null = 読んでいる。error = 読めない） */
  status: AiStatus | null | { error: string };
}

/** [このポジションを診断] が押せない理由（押せるなら null） */
export function diagnoseBlocked(s: AiChatState, g: AiGate): string | null {
  if (!g.hasChain) return '板がありません（板を読んでから押してください）';
  if (g.legCount === 0) return '足がありません（ポジションを組んでから押してください）';
  return commonBlocked(s, g);
}

/** 自由な質問を送れない理由（送れるなら null。空の入力は理由を出さない） */
export function sendBlocked(s: AiChatState, g: AiGate): string | null {
  if (!g.hasChain) return '板がありません（板を読んでから送ってください）';
  return commonBlocked(s, g);
}

function commonBlocked(s: AiChatState, g: AiGate): string | null {
  if (g.legCount > MAX_AI_LEGS) return `足が ${MAX_AI_LEGS} 本を超えると AI に送れません`;
  const st = g.status;
  if (st === null) return 'AI の状態を読んでいます…';
  if ('error' in st) return `AI の状態を読めません（${aiErrorText(st.error)}）`;
  if (!st.enabled) return 'AI は無効です（管理者の設定）';
  if (st.counted && st.remaining_usd !== null && st.remaining_usd <= 0) {
    return '今日の上限に達しました（日付が変わると戻ります）';
  }
  if (s.turn) return '送信中です';
  if (atLimit(s)) return '会話が長くなりました。[新しい会話] で始めてください';
  return null;
}

/** 今日の残りの表示（数えない資格情報は「数えない」） */
export function remainingText(st: AiStatus | null, latest: number | null): string | null {
  if (!st?.enabled) return null;
  if (!st.counted) return '残り: 数えない（Max の利用枠）';
  const rem = latest ?? st.remaining_usd;
  if (rem === null || st.limit_usd === null) return '残り: —';
  return `残り $${rem.toFixed(2)} / $${st.limit_usd.toFixed(2)}`;
}

/** 失敗・終わり方の文言（code は中継の列挙と画面の code） */
export function aiErrorText(code: string, remainingUsd: number | null = null): string {
  switch (code) {
    case 'session_expired':
      return 'ログインの期限が切れた可能性があります。再読み込みしてください';
    case 'network':
      return '接続できませんでした（ネットワーク）。もう一度送ってください';
    case 'incomplete':
      return '応答が途中で切れました（費用は予約額で数えています）';
    case 'budget_exceeded':
      return remainingUsd !== null
        ? `今日の上限に届きます（残り $${remainingUsd.toFixed(2)}）。日付が変わると戻ります`
        : '今日の上限に達しました。日付が変わると戻ります';
    case 'busy':
    case 'rate_limited':
      return '混み合っています。少し待ってから送ってください';
    case 'timeout':
      return '時間内（50 秒）に終わりませんでした。途中までの文を残しています';
    case 'ai_disabled':
      return 'AI は無効です（管理者の設定）';
    case 'aborted':
      return '中止しました';
    case 'no_board':
      return '板がありません（板を読んでから送ってください）';
    case 'bad_request':
      return '送る内容が受け付けられませんでした（形の検査）';
    case 'too_large':
      return '送る内容が大きすぎます。[新しい会話] で始めてください';
    case 'unavailable':
      return 'AI の中継が使えません。少し待ってから送ってください';
    case 'upstream_auth':
      return 'AI の資格情報の設定に問題があります（管理者）';
    case 'upstream_rate_limited':
    case 'upstream_overloaded':
      return 'AI の送信先が混み合っています。少し待ってから送ってください';
    case 'upstream_bad_request':
    case 'bad_tool_input':
      return 'AI の送信先が要求を受け付けませんでした';
    case 'upstream_unavailable':
    case 'upstream_incomplete':
      return 'AI の送信先が応答しません。少し待ってから送ってください';
    case 'empty':
      return '返答が空でした';
    case 'tool_limit':
      return `計算の回数の上限（${MAX_TOOL_ROUNDS} 回）で止めました`;
    case 'refusal':
      return 'AI が答えられない内容でした';
    case 'max_tokens':
      return '長さの上限で切れました';
    case 'pause_turn':
      return '返答が途中で止まりました。続けて送ってください';
    default:
      return `AI を使えませんでした（${code}）`;
  }
}

// ---------------------------------------------------------------- 表示の項目

export type ChatItem =
  | { kind: 'user'; text: string; updated: boolean; key: string }
  | { kind: 'thinking'; text: string; key: string; live: boolean }
  | {
      kind: 'answer';
      text: string;
      key: string;
      live: boolean;
      failed: string | null;
      /** 失敗のときの今日の残り（429 budget_exceeded の残りつきの文言。無ければ null） */
      remainingUsd?: number | null;
    }
  | {
      kind: 'tool';
      key: string;
      name: string;
      input: Record<string, unknown>;
      result: unknown;
      isError: boolean;
    };

const parseJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/** 会話 → 表示の項目（user の吹き出し・考え中・返答・道具のカード。流れの途中・失敗も） */
export function chatItems(s: AiChatState): ChatItem[] {
  const out: ChatItem[] = [];
  const results = new Map<string, { result: unknown; isError: boolean }>();
  for (const m of s.messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        results.set(b.tool_use_id, {
          result: parseJson(b.content[0].text),
          isError: b.is_error === true,
        });
      }
    }
  }
  s.messages.forEach((m, i) => {
    if (m.role === 'user') {
      const text = m.content
        .filter((b) => b.type === 'text' && b.text !== TOOL_LIMIT_NOTE)
        .map((b) => (b as { text: string }).text)
        .join('\n');
      if (text !== '') {
        const updated = m.content.some((b) => b.type === 'context_update');
        out.push({ kind: 'user', text, updated, key: `m${i}` });
      }
      return;
    }
    m.content.forEach((b, j) => {
      const key = `m${i}b${j}`;
      if (b.type === 'thinking' && b.thinking !== '') {
        out.push({ kind: 'thinking', text: b.thinking, key, live: false });
      } else if (b.type === 'text' && b.text !== '') {
        out.push({ kind: 'answer', text: b.text, key, live: false, failed: null });
      } else if (b.type === 'tool_use') {
        const r = results.get(b.id);
        out.push({
          kind: 'tool',
          key,
          name: b.name,
          input: b.input,
          result: r?.result ?? null,
          isError: r?.isError ?? false,
        });
      }
    });
  });
  const t = s.turn;
  if (t) {
    if (t.thinking !== '') {
      out.push({ kind: 'thinking', text: t.thinking, key: 'live-thinking', live: true });
    }
    if (t.text !== '') {
      out.push({ kind: 'answer', text: t.text, key: 'live-text', live: true, failed: null });
    }
  }
  const f = s.failed;
  if (f) {
    out.push({ kind: 'user', text: f.userText, updated: false, key: 'failed-user' });
    out.push({
      kind: 'answer',
      text: f.partial,
      key: 'failed-text',
      live: false,
      failed: f.code,
      remainingUsd: f.remainingUsd,
    });
  }
  return out;
}

/** 照合の値（最初の文脈・文脈の更新・道具の結果） */
export function numberSources(s: AiChatState): unknown[] {
  const out: unknown[] = [];
  if (s.context) out.push(s.context);
  for (const m of s.messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'context_update') out.push(b.context);
      else if (b.type === 'tool_result') out.push(parseJson(b.content[0].text));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 保存（sessionStorage）

export interface SavedAiChat {
  context: AiContext | null;
  lastKey: string | null;
  messages: AiMessage[];
}

/** 書く形（版 1）。turn・failed は書かない */
export function encodeAiChat(s: AiChatState): string {
  return JSON.stringify({ v: 1, context: s.context, lastKey: s.lastKey, messages: s.messages });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validMessage(m: unknown): m is AiMessage {
  if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.content)) {
    return false;
  }
  return m.content.every((b) => isObj(b) && typeof b.type === 'string');
}

/**
 * 読む（JSON でない・版が違う・形が違う → null = 捨てる）。送っている途中で閉じた会話は、最後が user・道具を待つ
 * assistant なら落として、次に送れる形にする
 */
export function decodeAiChat(text: string | null): SavedAiChat | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1) return null;
  const { context, lastKey, messages } = raw;
  if (!(context === null || isObj(context))) return null;
  if (!(lastKey === null || typeof lastKey === 'string')) return null;
  if (!Array.isArray(messages) || !messages.every(validMessage)) return null;
  const ms = [...messages] as AiMessage[];
  let popped = false;
  for (;;) {
    const last = ms.at(-1);
    if (!last) break;
    if (last.role === 'user' || last.content.some((b) => b.type === 'tool_use')) {
      ms.pop();
      popped = true;
    } else break;
  }
  if (ms.length === 0) return { context: null, lastKey: null, messages: [] };
  if (context === null) return null;
  // 落とした発言に文脈の更新があったかもしれない: 指紋を捨てて、次の発言で必ず更新を足す
  return {
    context: context as unknown as AiContext,
    lastKey: popped ? null : (lastKey as string | null),
    messages: ms,
  };
}

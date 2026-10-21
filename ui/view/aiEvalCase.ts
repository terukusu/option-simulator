/**
 * AI の評価に残す会話（#159。EPIC #141 柱 6）。返答の行の [評価に残す] が書き出す JSON の形と、`npm run ai:eval -- --saved`
 * がそれを読んで同じ文脈を作り直す関数。純関数（DOM・通信・時計に依存しない。時刻は引数）。
 *
 * - 書き出すのはブラウザのダウンロードだけ（サーバーに送らない・保存しない）。中身は実際の板を含むので、置き場所は
 *   fixtures/local/ai_eval/cases/（gitignore）
 * - 作り直しの材料（source）: 板の JSON（/api/chain の形 = Chain.json）・作業中のタブの 1 ポジションの文書（ui/persist.ts の
 *   toSaved。版 1）・取引カレンダー（集合を配列で）・証拠金の設定・自分の前提・会話で呼んだときだけ先物の足 / IV の日次の値。
 *   作り直しは画面と同じ関数（normalizeChain → restoreState → loaded → aiEnvFromState）を通す
 * - 発言の列（turns）: messages は kind・topic を持たないので、フックの控え（文 → kind・topic）を使い、無ければ文から推定する
 *   （[このポジションを診断] の文 → diagnose、定型のチップの文 → preset、他は chat）
 */

import { DEFAULT_RATE, normalizeChain } from '../../data';
import type { AiContext, AiKind, AiMessage } from '../../data/aiStream';
import type { Calendar } from '../../data/calendar';
import type { ChainJson } from '../../data/chainTypes';
import {
  isObj,
  readWorkspaceValue,
  restoreState,
  type SavedWorkspaceV1,
  toSaved,
} from '../persist';
import { DEFAULT_MARGIN_PREFS, isAiProfile, isMarginPrefValue, type MarginPrefs } from '../prefs';
import { initialState, reduce, type State } from '../state';
import { type AiChatState, DIAGNOSE_TEXT, numberSources, TOOL_LIMIT_NOTE } from './aiChat';
import { aiEnvFromState } from './aiContext';
import type { IvStatsData } from './aiIvStats';
import { checkNumbers } from './aiNumbers';
import { AI_PRESETS } from './aiPresets';
import type { TechnicalsData } from './aiTechnicals';
import type { AiToolEnv } from './aiTools';

export const AI_EVAL_CASE_KIND = 'optsim.ai_eval_case';
export const AI_EVAL_CASE_VERSION = 1;
/** ボタンの文字 */
export const AI_EVAL_KEEP_LABEL = '評価に残す';
/** メモを聞く文（window.prompt） */
export const AI_EVAL_NOTE_PROMPT =
  '評価に残すメモ（任意。何が違ったか）。この会話を JSON ファイルに保存します（サーバーには送りません）';

/** 1 回の発言（送り直しの単位） */
export interface AiEvalTurn {
  kind: AiKind;
  text: string;
  topic?: string;
}

/** 発言の文 → kind・topic の控え（useAiChat が送るときに書く） */
export type AiTurnLog = ReadonlyMap<string, { kind: AiKind; topic?: string }>;

/** 取引カレンダー（集合を配列にした形） */
export interface AiEvalCalendar {
  ok: boolean;
  holidays: string[];
  non_trading_days: string[];
  covered_until: string | null;
  listed_until: string | null;
  version_at: string | null;
  version_on: string | null;
  origin: Calendar['origin'];
}

/** 文脈の作り直しの材料 */
export interface AiEvalSource {
  board: ChainJson;
  position: SavedWorkspaceV1;
  calendar: AiEvalCalendar;
  margin: MarginPrefs;
  profile?: string;
  technicals?: TechnicalsData;
  iv_stats?: IvStatsData;
}

export interface AiEvalCaseFile {
  kind: typeof AI_EVAL_CASE_KIND;
  v: typeof AI_EVAL_CASE_VERSION;
  saved_at: string;
  note: string;
  turns: AiEvalTurn[];
  /** 最後に送った文脈（最初の文脈か、最後の context_update） */
  context: AiContext | null;
  messages: AiMessage[];
  /** 押した返答（画面と同じ照合: その会話の出所で） */
  answer: { text: string; matched: number; unmatched: string[] };
  source: AiEvalSource;
}

/** 画面の状態 → 作り直しの材料（板が無ければ null。先物の足・IV の日次の値は呼び出し側が足す） */
export function aiEvalSource(
  state: State,
  margin: MarginPrefs,
  profile: string | undefined,
  now: number,
): AiEvalSource | null {
  if (!state.chain) return null;
  const c = state.calendar;
  return {
    board: state.chain.json,
    position: toSaved(state, now),
    calendar: {
      ok: c.ok,
      holidays: [...c.holidays].sort(),
      non_trading_days: [...c.nonTradingDays].sort(),
      covered_until: c.coveredUntil,
      listed_until: c.listedUntil,
      version_at: c.versionAt,
      version_on: c.versionOn,
      origin: c.origin,
    },
    margin: { ...margin },
    ...(profile !== undefined && { profile }),
  };
}

/** 発言の文 → kind・topic（控えが無ければ文から推定） */
export function turnOf(text: string, log?: AiTurnLog): AiEvalTurn {
  const hit = log?.get(text);
  if (hit) return { kind: hit.kind, text, ...(hit.topic !== undefined && { topic: hit.topic }) };
  if (text === DIAGNOSE_TEXT) return { kind: 'diagnose', text };
  const p = AI_PRESETS.find((x) => x.text === text);
  if (p) return { kind: 'preset', text, topic: p.id };
  return { kind: 'chat', text };
}

/** 会話の利用者の発言（ツールの結果・回数の上限の知らせを除く文）→ 発言の列 */
export function userTurns(messages: readonly AiMessage[], log?: AiTurnLog): AiEvalTurn[] {
  const out: AiEvalTurn[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = m.content
      .filter((b) => b.type === 'text' && b.text !== TOOL_LIMIT_NOTE)
      .map((b) => (b as { text: string }).text)
      .join('\n');
    if (text !== '') out.push(turnOf(text, log));
  }
  return out;
}

/** 返答の行の key（ui/view/aiChat.ts の chatItems の `m{i}b{j}`）→ 位置。終わった返答の行だけ */
function answerAt(key: string): { i: number; j: number } | null {
  const m = /^m(\d+)b(\d+)$/.exec(key);
  return m ? { i: Number(m[1]), j: Number(m[2]) } : null;
}

/** 書き出しのファイル名（ローカル時刻。例 ai-eval-20261022-153000.json） */
export function aiEvalFileName(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `ai-eval-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

/**
 * 押した返答（key）までの会話 → 保存の形。返答が見つからない（流れている途中・失敗の行）・発言が無ければ null。
 * 会話は返答を含む message までで切る（後の発言は入れない）
 */
export function aiEvalCase(p: {
  chat: AiChatState;
  answerKey: string;
  source: AiEvalSource;
  note: string;
  now: number;
  log?: AiTurnLog;
}): AiEvalCaseFile | null {
  const at = answerAt(p.answerKey);
  if (!at) return null;
  const msg = p.chat.messages[at.i];
  const block = msg?.role === 'assistant' ? msg.content[at.j] : undefined;
  if (block?.type !== 'text' || block.text === '') return null;
  const messages = p.chat.messages.slice(0, at.i + 1);
  const turns = userTurns(messages, p.log);
  if (turns.length === 0) return null;
  let context = p.chat.context;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) if (b.type === 'context_update') context = b.context;
  }
  const check = checkNumbers(block.text, numberSources({ ...p.chat, messages }));
  return {
    kind: AI_EVAL_CASE_KIND,
    v: AI_EVAL_CASE_VERSION,
    saved_at: new Date(p.now).toISOString(),
    note: p.note,
    turns,
    context,
    messages,
    answer: {
      text: block.text,
      matched: check.matched,
      unmatched: check.tokens.filter((t) => t.status === 'unmatched').map((t) => t.raw),
    },
    source: p.source,
  };
}

/** 会話で呼んだツールの名前（先物の足・IV の日次の値を書き出しに入れるかの判定） */
export function usedTools(messages: readonly AiMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.type === 'tool_use') out.add(b.name);
  }
  return out;
}

// ---------------------------------------------------------------- 読む（ai:eval）

const KINDS: readonly AiKind[] = ['chat', 'diagnose', 'ask', 'preset'];
const strs = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function readTurn(v: unknown): AiEvalTurn | null {
  if (!isObj(v) || typeof v.text !== 'string' || v.text === '') return null;
  if (!KINDS.includes(v.kind as AiKind)) return null;
  if (v.topic !== undefined && typeof v.topic !== 'string') return null;
  return {
    kind: v.kind as AiKind,
    text: v.text,
    ...(typeof v.topic === 'string' && { topic: v.topic }),
  };
}

function readCalendar(v: unknown): AiEvalCalendar | null {
  if (!isObj(v) || typeof v.ok !== 'boolean') return null;
  if (!strs(v.holidays) || !strs(v.non_trading_days)) return null;
  for (const k of ['covered_until', 'listed_until', 'version_at', 'version_on'] as const) {
    if (!strOrNull(v[k])) return null;
  }
  if (v.origin !== 'api' && v.origin !== 'bundled') return null;
  return v as unknown as AiEvalCalendar;
}

function readMargin(v: unknown): MarginPrefs {
  const m: MarginPrefs = { ...DEFAULT_MARGIN_PREFS };
  if (!isObj(v)) return m;
  if (isMarginPrefValue('capitalYen', v.capitalYen) && v.capitalYen > 0) {
    m.capitalYen = v.capitalYen;
  }
  for (const k of ['factorPct', 'rangePct', 'ivUpPct', 'ivDownPct'] as const) {
    if (isMarginPrefValue(k, v[k])) m[k] = v[k];
  }
  if (typeof v.ignoreLongOptions === 'boolean') m.ignoreLongOptions = v.ignoreLongOptions;
  return m;
}

/** JSON.parse した値 → 保存の形（版・種類・欄が違えば null。板・ポジションの中身は作り直しのときに検査する） */
export function readAiEvalCase(raw: unknown): AiEvalCaseFile | null {
  if (!isObj(raw) || raw.kind !== AI_EVAL_CASE_KIND || raw.v !== AI_EVAL_CASE_VERSION) return null;
  if (typeof raw.saved_at !== 'string' || typeof raw.note !== 'string') return null;
  if (!Array.isArray(raw.turns) || raw.turns.length === 0) return null;
  const turns = raw.turns.map(readTurn);
  if (turns.some((t) => t === null)) return null;
  if (!(raw.context === null || isObj(raw.context))) return null;
  if (!Array.isArray(raw.messages)) return null;
  const a = raw.answer;
  if (
    !isObj(a) ||
    typeof a.text !== 'string' ||
    typeof a.matched !== 'number' ||
    !strs(a.unmatched)
  ) {
    return null;
  }
  const s = raw.source;
  if (!isObj(s) || !isObj(s.board) || !isObj(s.position)) return null;
  const calendar = readCalendar(s.calendar);
  if (!calendar) return null;
  if (s.profile !== undefined && !isAiProfile(s.profile)) return null;
  return {
    kind: AI_EVAL_CASE_KIND,
    v: AI_EVAL_CASE_VERSION,
    saved_at: raw.saved_at,
    note: raw.note,
    turns: turns as AiEvalTurn[],
    context: raw.context as AiContext | null,
    messages: raw.messages as AiMessage[],
    answer: { text: a.text, matched: a.matched, unmatched: a.unmatched },
    source: {
      board: s.board as unknown as ChainJson,
      position: s.position as unknown as SavedWorkspaceV1,
      calendar,
      margin: readMargin(s.margin),
      ...(typeof s.profile === 'string' && { profile: s.profile }),
      ...(isObj(s.technicals) && { technicals: s.technicals as unknown as TechnicalsData }),
      ...(isObj(s.iv_stats) && { iv_stats: s.iv_stats as unknown as IvStatsData }),
    },
  };
}

/** 材料 → ツールの環境（画面と同じ組み立て。板・ポジションが読めなければ例外 = 呼び出し側が件の失敗にする） */
export function aiEnvFromCase(src: AiEvalSource): AiToolEnv {
  const cal = src.calendar;
  const calendar: Calendar = {
    ok: cal.ok,
    errors: [],
    holidays: new Set(cal.holidays),
    nonTradingDays: new Set(cal.non_trading_days),
    coveredUntil: cal.covered_until,
    listedUntil: cal.listed_until,
    versionAt: cal.version_at,
    versionOn: cal.version_on,
    origin: cal.origin,
  };
  const chain = normalizeChain(src.board, { r: DEFAULT_RATE });
  const doc = readWorkspaceValue(src.position);
  if (doc.kind !== 'ok') throw new Error(`ポジションの文書を読めない（${doc.kind}）`);
  let s = restoreState({ ...initialState, calendar }, doc.saved);
  s = reduce(s, { type: 'loaded', chain, label: 'saved' });
  const env = aiEnvFromState(s, src.margin, src.profile);
  if (!env) throw new Error('板を読めない');
  return {
    ...env,
    ...(src.technicals && { technicals: src.technicals }),
    ...(src.iv_stats && { ivStats: src.iv_stats }),
  };
}

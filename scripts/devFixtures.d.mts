import type { Plugin } from 'vite';

/** dev サーバーが配る合成の板の名前 */
export const SERVED_FIXTURES: readonly string[];

/** 合成の板を dev サーバーでだけ配る Vite プラグイン（apply: 'serve'） */
export function serveSyntheticFixtures(): Plugin;

/** IV 推移の合成の応答の「今」（UNIX 秒。合成の板 latest の snapshot_at） */
export const SYNTH_IV_NOW: number;
/** 合成の応答の表の最後の行（UNIX 秒） */
export const SYNTH_IV_LAST_AT: number;
/** 合成のデータの始まり（UNIX 秒） */
export const SYNTH_IV_FIRST: number;

/** `/api/atm_iv` と同じ形の合成の応答（架空の値。tf が 1m・1h・1d 以外なら null） */
export function synthAtmIv(
  tf: string,
  range?: { start: number; end: number } | null,
  now?: number,
): {
  schema_version: 1;
  tf: string;
  start: string;
  end: string;
  last_at: string | null;
  bars: { t: string; o: number; h: number; l: number; c: number }[];
} | null;

/** 先物推移の合成の応答の表の最後の行（UNIX 秒。#190） */
export const SYNTH_FUT_LAST_AT: number;
/** 合成の限月交代の跳び（新しい限月 / 古い限月 − 1） */
export const SYNTH_FUT_ROLL_JUMP: number;

/** `/api/future_bars` と同じ形の合成の応答（#190。架空の値。tf が 1m・1h・1d 以外なら null） */
export function synthFutureBars(
  tf: string,
  range?: { start: number; end: number } | null,
  now?: number,
): {
  schema_version: 1;
  tf: string;
  start: string;
  end: string;
  last_at: string | null;
  bars: { t: string; o: number; h: number; l: number; c: number; m: string }[];
} | null;

/** `/fixtures/atm_iv?tf=&start=&end=`（`/fixtures/future_bars` も同じ）の検査（サーバーの parse_request と同じ。形が違えば null = 400） */
export function atmIvQuery(
  url: string,
): { tf: string; range: { start: number; end: number } | null } | null;

/** `/api/atm_daily` と同じ形の合成の応答（#152。架空の値。now の既定は SYNTH_IV_NOW） */
export function synthAtmDaily(now?: number): {
  schema_version: 1;
  start: string;
  end: string;
  days: {
    d: string;
    t: string;
    iv: number;
    f1: number;
    l1: string;
    f2: number | null;
    l2: string | null;
  }[];
};

/** AI の中継の偽の状態（#135。/fixtures/ai/status） */
export const SYNTH_AI_STATUS: {
  schema_version: 1;
  enabled: boolean;
  model: string;
  credential: string;
  counted: boolean;
  limit_usd: number;
  remaining_usd: number;
  resets_at: string;
};
/** 偽の SSE の事象の間隔（ms） */
export const SYNTH_AI_STEP_MS: { thinking: number; writing: number; chunk: number };
/** 偽の返答の組み立て（要求の本文 → 考え中・文・ツール。純関数） */
export function synthAiReply(body: unknown): {
  thinking: string;
  text: string;
  stop: string | null;
  cut?: boolean;
  tool?: { id: string; name: string; input: Record<string, unknown> };
};

/** 画像の読み取りの合成の結果（#318。/fixtures/ai/read_positions） */
export const SYNTH_READ_RESULT: {
  schema_version: 1;
  kind: 'positions';
  rows: {
    product: string;
    expiry_year: number | null;
    expiry_month: number | null;
    type: string | null;
    strike: number | null;
    side: string | null;
    qty: number | null;
    price: number | null;
    opened_on: string | null;
  }[];
  remaining_usd: number;
};
/** 読み取りの合成の応答の待ち（ms） */
export const SYNTH_READ_DELAY_MS: number;

/** 銘柄の推移の合成の気配の無い日（#319。この日の日中は約定だけの足） */
export const SYNTH_OPT_NOQUOTE_DAY: string;

/** `/fixtures/option_bars?ltd=&k=&type=&tf=` の検査（サーバーの parse_request と同じ。形が違えば null = 400） */
export function optionBarsQuery(
  url: string,
): { ltd: string; k: number; type: 'call' | 'put'; tf: '1h' | '1d' } | null;

/** `/api/option_bars` と同じ形の合成の応答（#319。架空の値） */
export function synthOptionBars(
  ltd: string,
  k: number,
  type: 'call' | 'put',
  tf: '1h' | '1d',
  now?: number,
): {
  schema_version: 1;
  tf: string;
  ltd: string;
  k: number;
  type: string;
  last_at: string | null;
  bars: {
    t: string;
    o: number | null;
    h: number | null;
    l: number | null;
    c: number | null;
    bid: number | null;
    ask: number | null;
    bid_iv: number | null;
    ask_iv: number | null;
    trade: number | null;
    trade_iv: number | null;
  }[];
};

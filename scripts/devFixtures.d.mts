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

/** `/fixtures/atm_iv?tf=&start=&end=` の検査（サーバーの parse_request と同じ。形が違えば null = 400） */
export function atmIvQuery(
  url: string,
): { tf: string; range: { start: number; end: number } | null } | null;

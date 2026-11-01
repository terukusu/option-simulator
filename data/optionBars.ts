/**
 * 銘柄の推移（OP の 1 銘柄 = 限月 × 行使価格 × call / put の値段と IV の足。#319）の `/api/option_bars` の JSON の型と
 * 検証。設計 docs/design.md 7.1・13.4。読み込みは data/adapter.ts の loadOptionBars。
 *
 * - 応答: `{ schema_version: 1, tf, ltd, k, type, last_at, bars: [{ t, o, h, l, c, bid, ask, bid_iv, ask_iv, trade,
 *   trade_iv }] }`。時刻は ISO 8601 のオフセット付き、値は円（丸めない）、IV は %。サーバーは
 *   api/src/simulator_api/option_bars.py の option_bars_json
 * - 気配の無い足は o・h・l・c・bid・ask・bid_iv・ask_iv が null、約定の無い足は trade・trade_iv が null（両方無い足は無い）
 * - 画面では時刻を UNIX 秒にして持つ。壊れていれば ok = false（画面は失敗として [再試行] を出す）
 * - 純関数（DOM・通信に依存しない）
 */

import type { OptionType } from '../model';
import { isIsoDate, isIsoInstant } from './calendar';
import type { ValidationResult } from './chainJson';

export const OPTION_BARS_SCHEMA_VERSION = 1;

/** サーバーが返す足（1 時間足・日足） */
export const OPTION_BARS_TFS = ['1h', '1d'] as const;
export type OptionBarsTf = (typeof OPTION_BARS_TFS)[number];

/** 銘柄（要求のキー） */
export interface OptionBarsKey {
  /** 取引最終日（YYYY-MM-DD） */
  ltd: string;
  k: number;
  type: OptionType;
}

/**
 * 足 1 本（t = 足の始まりの UNIX 秒。1d はその取引日の 00:00 JST）。o・h・l・c は気配の mid（4 つとも数か 4 つとも
 * null）、bid・ask は足の終わりの気配（組で数か null）、bidIv・askIv は気配の IV（%。片方ずつ null 可）、trade・tradeIv は
 * 足の中の最後の約定の値段と約定 IV（null 可）
 */
export interface OptBar {
  t: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  bid: number | null;
  ask: number | null;
  bidIv: number | null;
  askIv: number | null;
  trade: number | null;
  tradeIv: number | null;
}

/** 検証済みの応答（時刻は UNIX 秒） */
export interface OptionBarsData extends OptionBarsKey {
  tf: OptionBarsTf;
  /** 表の最後の行の時刻（行が無ければ null） */
  lastAt: number | null;
  /** t の昇順・重複なし */
  bars: OptBar[];
}

const MAX_ERRORS = 50;

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
/** オフセット付きの時刻（isIsoInstant。オフセット無しは端末のタイムゾーンで読まれるので拒否する） */
const instant = isIsoInstant;
const posOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);

/** `/api/option_bars` の JSON の形の検査（tf・銘柄は要求と同じか）。余分なキーは見ない。 */
export function validateOptionBarsJson(
  v: unknown,
  tf: OptionBarsTf,
  key: OptionBarsKey,
): ValidationResult<OptionBarsData> {
  const errors: string[] = [];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: ['$: オブジェクトでない'] };
  }
  const o = v as Record<string, unknown>;
  if (o.schema_version !== OPTION_BARS_SCHEMA_VERSION) {
    add('$.schema_version', `${OPTION_BARS_SCHEMA_VERSION} でない`);
  }
  if (o.tf !== tf) add('$.tf', `要求した足（${tf}）でない`);
  if (!isIsoDate(o.ltd) || o.ltd !== key.ltd) add('$.ltd', '要求した取引最終日でない');
  if (o.k !== key.k) add('$.k', '要求した行使価格でない');
  if (o.type !== key.type) add('$.type', '要求した種別でない');
  let lastAt: number | null = null;
  if (o.last_at !== null) {
    if (instant(o.last_at)) lastAt = seconds(o.last_at);
    else add('$.last_at', 'オフセット付きの ISO 8601 の日時か null でない');
  }
  const bars: OptBar[] = [];
  if (!Array.isArray(o.bars)) add('$.bars', '配列でない');
  else {
    let prev: number | null = null;
    o.bars.forEach((b, i) => {
      const p = `$.bars[${i}]`;
      if (typeof b !== 'object' || b === null || Array.isArray(b)) {
        add(p, 'オブジェクトでない');
        return;
      }
      const x = b as Record<string, unknown>;
      if (!instant(x.t)) {
        add(`${p}.t`, 'オフセット付きの ISO 8601 の日時でない');
        return;
      }
      const t = seconds(x.t);
      if (prev !== null && t <= prev) add(`${p}.t`, '昇順でない・重複');
      prev = t;
      const keys = ['o', 'h', 'l', 'c', 'bid', 'ask', 'bid_iv', 'ask_iv', 'trade', 'trade_iv'];
      const bad = keys.filter((k) => !posOrNull(x[k]));
      if (bad.length > 0) {
        add(p, `${bad.join('・')} が正の数か null でない`);
        return;
      }
      const ohlc = [x.o, x.h, x.l, x.c] as (number | null)[];
      const quoted = ohlc.every((n) => n !== null);
      if (!quoted && !ohlc.every((n) => n === null)) {
        add(p, 'o・h・l・c が 4 つとも数か 4 つとも null でない');
        return;
      }
      if (quoted) {
        const [op, hi, lo, cl] = ohlc as [number, number, number, number];
        if (!(lo <= Math.min(op, cl) && hi >= Math.max(op, cl))) add(p, 'l ≤ o, c ≤ h でない');
      }
      const bid = x.bid as number | null;
      const ask = x.ask as number | null;
      if ((bid === null) !== (ask === null)) add(p, 'bid・ask が組でない');
      else if (bid !== null && ask !== null && bid > ask) add(p, 'bid ≤ ask でない');
      const trade = x.trade as number | null;
      if (!quoted && trade === null) add(p, '気配も約定も無い');
      bars.push({
        t,
        o: ohlc[0] as number | null,
        h: ohlc[1] as number | null,
        l: ohlc[2] as number | null,
        c: ohlc[3] as number | null,
        bid,
        ask,
        bidIv: x.bid_iv as number | null,
        askIv: x.ask_iv as number | null,
        trade,
        tradeIv: x.trade_iv as number | null,
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { tf, ltd: key.ltd, k: key.k, type: key.type, lastAt, bars } };
}

/** `/api/option_bars` の URL（4 つのパラメータだけ）。endpoint は同一オリジンの相対 URL */
export function optionBarsUrl(endpoint: string, tf: OptionBarsTf, key: OptionBarsKey): string {
  const q = new URLSearchParams({ ltd: key.ltd, k: String(key.k), type: key.type, tf });
  return `${endpoint}?${q.toString()}`;
}

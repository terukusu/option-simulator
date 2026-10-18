/**
 * IV 推移（ATM IV の 30 日固定 = optionchan の atm_cm_iv の iv30。#79）の `/api/atm_iv` の JSON の型と検証。
 * 設計 docs/design.md 7.1・13.4。読み込みは data/adapter.ts の loadAtmIv。
 *
 * - 応答: `{ schema_version: 1, tf, start, end, last_at, bars: [{ t, o, h, l, c }] }`（時刻は ISO 8601 のオフセット付き、
 *   値は iv30 の %。丸めない）。サーバーは api/src/simulator_api/atm_iv.py の atm_iv_json
 * - 画面では時刻を UNIX 秒にして持つ（AtmIvData）。壊れていれば ok = false（画面は失敗として [再試行] を出す）
 * - 純関数（DOM・通信に依存しない）
 */

import { isIsoInstant } from './calendar';
import type { ValidationResult } from './chainJson';

export const ATM_IV_SCHEMA_VERSION = 1;

/** サーバーが返す足（5 分・15 分は画面が 1 分から束ねる） */
export const ATM_IV_SOURCES = ['1m', '1h', '1d'] as const;
export type AtmIvSource = (typeof ATM_IV_SOURCES)[number];

/** 足 1 本（t = 足の始まりの UNIX 秒。1d はその取引日の 00:00 JST。値は %） */
export interface IvBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** 検証済みの応答（時刻は UNIX 秒） */
export interface AtmIvData {
  tf: AtmIvSource;
  /** 実際に読んだ範囲 [start, end)（end はサーバーが now に縮めた値） */
  start: number;
  end: number;
  /** 範囲の中の最後の行の時刻（iv30 が NULL の行も含む。行が無ければ null） */
  lastAt: number | null;
  /** t の昇順・重複なし */
  bars: IvBar[];
}

const MAX_ERRORS = 50;

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** `/api/atm_iv` の JSON の形の検査（tf は要求した足と同じか）。余分なキーは見ない。 */
export function validateAtmIvJson(v: unknown, tf: AtmIvSource): ValidationResult<AtmIvData> {
  const errors: string[] = [];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, errors: ['$: オブジェクトでない'] };
  }
  const o = v as Record<string, unknown>;
  if (o.schema_version !== ATM_IV_SCHEMA_VERSION) {
    add('$.schema_version', `${ATM_IV_SCHEMA_VERSION} でない`);
  }
  if (o.tf !== tf) add('$.tf', `要求した足（${tf}）でない`);
  const start = isIsoInstant(o.start) ? seconds(o.start) : null;
  const end = isIsoInstant(o.end) ? seconds(o.end) : null;
  if (start === null) add('$.start', 'ISO 8601 の日時でない');
  if (end === null) add('$.end', 'ISO 8601 の日時でない');
  if (start !== null && end !== null && !(start < end)) add('$.end', 'start より後でない');
  let lastAt: number | null = null;
  if (o.last_at !== null) {
    if (isIsoInstant(o.last_at)) lastAt = seconds(o.last_at);
    else add('$.last_at', 'ISO 8601 の日時か null でない');
  }
  const bars: IvBar[] = [];
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
      if (!isIsoInstant(x.t)) {
        add(`${p}.t`, 'ISO 8601 の日時でない');
        return;
      }
      const t = seconds(x.t);
      const vals = [x.o, x.h, x.l, x.c];
      if (!vals.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        add(p, 'o・h・l・c が有限の数でない');
        return;
      }
      const [op, hi, lo, cl] = vals as [number, number, number, number];
      if (!(lo <= Math.min(op, cl) && hi >= Math.max(op, cl))) add(p, 'l ≤ o, c ≤ h でない');
      if (prev !== null && t <= prev) add(`${p}.t`, '昇順でない・重複');
      prev = t;
      bars.push({ t, o: op, h: hi, l: lo, c: cl });
    });
  }
  if (errors.length > 0 || start === null || end === null) return { ok: false, errors };
  return { ok: true, value: { tf, start, end, lastAt, bars } };
}

/** UNIX 秒 → `/api/atm_iv` のパラメータの時刻（UTC の `Z`。秒まで） */
export function atmIvParamTime(t: number): string {
  return `${new Date(t * 1000).toISOString().slice(0, 19)}Z`;
}

/** `/api/atm_iv` の URL（range なし = 右端の 1 回分）。endpoint は同一オリジンの相対 URL */
export function atmIvUrl(
  endpoint: string,
  tf: AtmIvSource,
  range?: { start: number; end: number },
): string {
  const q = new URLSearchParams({ tf });
  if (range) {
    q.set('start', atmIvParamTime(range.start));
    q.set('end', atmIvParamTime(range.end));
  }
  return `${endpoint}?${q.toString()}`;
}

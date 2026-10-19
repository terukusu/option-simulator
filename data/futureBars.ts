/**
 * 先物推移（日経 225 先物のラージ・期近の現在値の足。#190）の `/api/future_bars` の JSON の型と検証。
 * 設計 docs/design.md 7.1・13.4。読み込みは data/adapter.ts の loadFutureBars。
 *
 * - 応答: `{ schema_version: 1, tf, start, end, last_at, bars: [{ t, o, h, l, c, m }] }`（`/api/atm_iv` と同じ形に
 *   限月 `m`（YYYY-MM。3・6・9・12 月）を足したもの。値は円。丸めない）。サーバーは
 *   api/src/simulator_api/future_bars.py の future_bars_json
 * - 時刻・足・範囲の検査は validateAtmIvJson と同じ（l ≤ o, c ≤ h・t の昇順）。加えて値が正、m の形
 * - 純関数（DOM・通信に依存しない）
 */

import { type AtmIvData, type AtmIvSource, atmIvUrl, type IvBar, validateAtmIvJson } from './atmIv';
import type { ValidationResult } from './chainJson';

/** 先物の足 1 本（m = その足の限月 YYYY-MM。取引カレンダーから求めた期近） */
export interface FutBar extends IvBar {
  m: string;
}

/** 検証済みの応答（時刻は UNIX 秒） */
export interface FutureBarsData extends Omit<AtmIvData, 'bars'> {
  bars: FutBar[];
}

const CONTRACT_RE = /^\d{4}-(03|06|09|12)$/;
const MAX_ERRORS = 50;

/** `/api/future_bars` の JSON の形の検査（tf は要求した足と同じか）。余分なキーは見ない。 */
export function validateFutureBarsJson(
  v: unknown,
  tf: AtmIvSource,
): ValidationResult<FutureBarsData> {
  const base = validateAtmIvJson(v, tf);
  const errors = base.ok ? [] : [...base.errors];
  const add = (path: string, msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(`${path}: ${msg}`);
  };
  const raw = (v as { bars?: unknown } | null)?.bars;
  const ms: string[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((b, i) => {
      if (typeof b !== 'object' || b === null) return;
      const x = b as Record<string, unknown>;
      if (typeof x.m !== 'string' || !CONTRACT_RE.test(x.m)) {
        add(`$.bars[${i}].m`, 'YYYY-MM（3・6・9・12 月）でない');
      }
      if (typeof x.l === 'number' && !(x.l > 0)) add(`$.bars[${i}].l`, '正でない');
      ms.push(String(x.m));
    });
  }
  if (!base.ok || errors.length > 0) return { ok: false, errors };
  const bars = base.value.bars.map((b, i) => ({ ...b, m: ms[i] as string }));
  return { ok: true, value: { ...base.value, bars } };
}

/** `/api/future_bars` の URL（range なし = 右端の 1 回分。パラメータは `/api/atm_iv` と同じ） */
export function futureBarsUrl(
  endpoint: string,
  tf: AtmIvSource,
  range?: { start: number; end: number },
): string {
  return atmIvUrl(endpoint, tf, range);
}

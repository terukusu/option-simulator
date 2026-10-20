/**
 * AI の道具 `technicals`（#200。docs/design.md 13.4・14 章）: 先物（ラージ・期近）の週足・日足・4 時間足のテクニカル
 * 指標（RSI 14・MACD 12・26・9・スロー・ストキャスティクス 14・3・3）の今の値・直近の推移・状態・過去の基準率を返す。
 * 純関数（DOM・通信・時計に依存しない）。指標・束ね・基準率は model/（先物推移の段と同じ計算）。
 *
 * - データ: 先物の日足と 1 時間足（ui/components/technicalsData.ts が /api/future_bars から読んで渡す）。週足は日足、
 *   4 時間足は 1 時間足を model/bars.ts で束ねる（画面の 4 時間足と同じ規則）
 * - 生の足の列は返さない。直近は TECH_RECENT 本の指標の値だけ
 * - 基準率: 今と同じ状態（RSI のゾーン・SO のゾーン・MACD のシグナルと 0 の上下）だった過去の足の、horizon 本先の騰落率
 *   （%）の分布（件数・中央値・p10・p90）。条件なしの全体（all）も並べる。状態はその足までのデータで決まり、窓は重ねない、
 *   最後の足（確定前のことがある）は結果に使わない、今の足自身は入れない（model/technicals.ts の baseRate）。件数 < 20 は
 *   insufficient = true（AI は「サンプル不足」と書く）
 * - 値の丸め: RSI・SO は小数 1 桁、MACD は円の整数、% は小数 1 桁（tools.py の規則）。キーの単位は aiNumbers の規則
 *   （`*_yen` 円、`*_pct` %、`close_x` 原資産の水準）
 */

import type { FutBar } from '../../data';
import {
  barsInZone,
  baseRate,
  type Indicators,
  indicators,
  MACD_FAST,
  MACD_SIGNAL,
  MACD_SLOW,
  RSI_HIGH,
  RSI_LOW,
  RSI_PERIOD,
  resample4h,
  resampleWeekly,
  type Series,
  STOCH_D,
  STOCH_HIGH,
  STOCH_K,
  STOCH_LOW,
  STOCH_SMOOTH,
  sinceCross,
  zoneOf,
} from '../../model';

/** 道具に渡す足（時刻は UNIX 秒。日足は取引日の 00:00 JST） */
export interface TechnicalsData {
  daily: readonly FutBar[];
  hourly: readonly FutBar[];
}

export const TECH_TFS = ['weekly', 'daily', '4h'] as const;
export type TechTf = (typeof TECH_TFS)[number];
export const TECH_INDICATORS = ['rsi', 'macd', 'stoch'] as const;
export type TechIndicator = (typeof TECH_INDICATORS)[number];

/** 基準率の既定の先（本。週足 4 本 ≈ 1 か月、日足 5 本 ≈ 1 週、4 時間足 5 本 ≈ 1 取引日） */
export const TECH_HORIZON: Record<TechTf, number> = { weekly: 4, daily: 5, '4h': 5 };
/** horizon_bars の入力の範囲（tools.py の TECHNICALS_INPUT と同じ） */
export const TECH_HORIZON_RANGE = [1, 20] as const;
/** 直近の値の本数 */
export const TECH_RECENT = 20;

type R = Record<string, unknown>;

const fin = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const round = (v: number | null | undefined, d: number): number | null => {
  if (!fin(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f || 0;
};
const r1 = (v: number | null | undefined) => round(v, 1);
const r0 = (v: number | null | undefined) => round(v, 0);

const JST_S = 9 * 3600;
const pad2 = (n: number) => String(n).padStart(2, '0');
/** 足の時刻（JST。日足・週足は日付、4 時間足は 日付 時:分） */
function timeText(t: number, tf: TechTf): string {
  const d = new Date((t + JST_S) * 1000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return tf === '4h' ? `${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` : day;
}

/** その足の並び（週足 = 日足を束ねる、4 時間足 = 1 時間足を束ねる） */
export function techBars(data: TechnicalsData, tf: TechTf): readonly FutBar[] {
  if (tf === 'weekly') return resampleWeekly(data.daily);
  if (tf === '4h') return resample4h(data.hourly);
  return data.daily;
}

const tail = (s: Series, n: number, fmt: (v: number | null) => number | null) =>
  s.slice(Math.max(0, s.length - n)).map((v) => fmt(v ?? null));

function rateOut(r: ReturnType<typeof baseRate>, condition: string | null): R {
  const out: R = {
    n: r.n,
    median_pct: r1(r.median),
    p10_pct: r1(r.p10),
    p90_pct: r1(r.p90),
    insufficient: r.insufficient,
  };
  if (condition !== null) out.condition = condition;
  return out;
}

const signOf = (v: number | null | undefined) => (fin(v) ? (v >= 0 ? 1 : -1) : 0);

/** 1 つの足の結果 */
export function techFrame(
  bars: readonly FutBar[],
  tf: TechTf,
  kinds: readonly TechIndicator[],
  horizon: number,
  ind: Indicators = indicators(bars),
): R {
  const n = bars.length;
  const last = n - 1;
  const closes = bars.map((b) => b.c);
  // 結果に使う最後の足（最新の足は確定前のことがある）。今の足自身（last）は条件の候補に入れない
  const lastUsable = n - 2;
  const out: R = {
    tf,
    n_bars: n,
    last_t: n > 0 ? timeText((bars[last] as FutBar).t, tf) : null,
    close_x: n > 0 ? r0((bars[last] as FutBar).c) : null,
    horizon_bars: horizon,
  };
  const rates: R = {
    all: rateOut(
      baseRate(closes, horizon, lastUsable, () => true),
      null,
    ),
  };
  if (kinds.includes('rsi')) {
    const z = zoneOf(ind.rsi[last], RSI_HIGH, RSI_LOW);
    out.rsi = {
      rsi: r1(ind.rsi[last]),
      recent: tail(ind.rsi, TECH_RECENT, r1),
      zone: z,
      bars_in_zone: barsInZone(ind.rsi, last, RSI_HIGH, RSI_LOW),
    };
    if (z !== null) {
      const r = baseRate(
        closes,
        horizon,
        lastUsable,
        (j) => zoneOf(ind.rsi[j], RSI_HIGH, RSI_LOW) === z,
      );
      rates.rsi = rateOut(r, `rsi_${z}`);
    }
  }
  if (kinds.includes('macd')) {
    const { macd, signal, hist } = ind.macd;
    const cross = sinceCross(macd, signal, last);
    out.macd = {
      macd_yen: r0(macd[last]),
      signal_yen: r0(signal[last]),
      hist_yen: r0(hist[last]),
      recent_hist_yen: tail(hist, TECH_RECENT, r0),
      above_signal: cross ? cross.above : null,
      bars_since_cross: cross?.crossed ? cross.bars : null,
      above_zero: fin(macd[last]) ? (macd[last] as number) >= 0 : null,
    };
    const hs = signOf(hist[last]);
    const ms = signOf(macd[last]);
    if (hs !== 0 && ms !== 0) {
      const r = baseRate(
        closes,
        horizon,
        lastUsable,
        (j) => signOf(hist[j]) === hs && signOf(macd[j]) === ms,
      );
      const cond = `macd_${hs > 0 ? 'above' : 'below'}_signal_${ms > 0 ? 'above' : 'below'}_zero`;
      rates.macd = rateOut(r, cond);
    }
  }
  if (kinds.includes('stoch')) {
    const { k, d } = ind.stoch;
    const z = zoneOf(k[last], STOCH_HIGH, STOCH_LOW);
    const cross = sinceCross(k, d, last);
    out.stoch = {
      stoch_k: r1(k[last]),
      stoch_d: r1(d[last]),
      recent_k: tail(k, TECH_RECENT, r1),
      zone: z,
      bars_in_zone: barsInZone(k, last, STOCH_HIGH, STOCH_LOW),
      k_above_d: cross ? cross.above : null,
      bars_since_cross: cross?.crossed ? cross.bars : null,
    };
    if (z !== null) {
      const r = baseRate(
        closes,
        horizon,
        lastUsable,
        (j) => zoneOf(k[j], STOCH_HIGH, STOCH_LOW) === z,
      );
      rates.stoch = rateOut(r, `stoch_${z}`);
    }
  }
  out.base_rates = rates;
  return out;
}

const isEnumList = <T extends string>(v: unknown, all: readonly T[]): v is T[] =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= all.length &&
  v.every((x) => typeof x === 'string' && (all as readonly string[]).includes(x));

/** 道具の本体（入力は tool_use の input。データが無ければ no_data） */
export function technicalsTool(
  data: TechnicalsData | null,
  input: Record<string, unknown>,
): R | { error: 'bad_input' | 'out_of_range' | 'no_data' } {
  const known = new Set(['timeframes', 'indicators', 'horizon_bars']);
  if (Object.keys(input).some((k) => !known.has(k))) return { error: 'bad_input' };
  const tfIn = input.timeframes ?? [...TECH_TFS];
  const indIn = input.indicators ?? [...TECH_INDICATORS];
  if (!isEnumList(tfIn, TECH_TFS) || !isEnumList(indIn, TECH_INDICATORS)) {
    return { error: 'bad_input' };
  }
  const h = input.horizon_bars;
  if (h !== undefined) {
    if (typeof h !== 'number' || !Number.isInteger(h)) return { error: 'bad_input' };
    if (h < TECH_HORIZON_RANGE[0] || h > TECH_HORIZON_RANGE[1]) return { error: 'out_of_range' };
  }
  if (!data || (data.daily.length === 0 && data.hourly.length === 0)) return { error: 'no_data' };
  // 並びは TECH_TFS・TECH_INDICATORS の順（重複は 1 つ）
  const tfs = TECH_TFS.filter((t) => tfIn.includes(t));
  const kinds = TECH_INDICATORS.filter((k) => indIn.includes(k));
  return {
    params: {
      rsi: RSI_PERIOD,
      macd: [MACD_FAST, MACD_SLOW, MACD_SIGNAL],
      stoch: [STOCH_K, STOCH_SMOOTH, STOCH_D],
      rsi_zones: [RSI_LOW, RSI_HIGH],
      stoch_zones: [STOCH_LOW, STOCH_HIGH],
    },
    frames: tfs.map((tf) =>
      techFrame(techBars(data, tf), tf, kinds, (h as number | undefined) ?? TECH_HORIZON[tf]),
    ),
  };
}

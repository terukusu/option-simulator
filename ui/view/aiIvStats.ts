/**
 * AI のツール `iv_stats`（#138・#158。docs/design.md 13.4「AI のツール iv_stats」・14 章）: 30 日固定の ATM IV（iv30）の
 * 日次の終値と、同じ限月のフォワードの日次の値（/api/atm_daily）から、今の IV の分位・スパイクと萎み方・2 営業日の
 * 原資産の動きと IV の変化・β の実測・実現ボラ（HV）と IV − HV を返す。
 * 純関数（DOM・通信・時計に依存しない）。統計は model/ivStats.ts、組の作り方は data/atmDaily.ts の atmMoves（追証マップの
 * 過去の点と同じ = 取引カレンダーで n 営業日後、原資産は同じ限月のフォワードどうし、欠けた日は組まない）。
 *
 * - データ: ui/components/ivStatsData.ts が /api/atm_daily（全期間）と /api/atm_iv の 1 時間足の右端（今の値）を読んで渡す。
 *   新しいクエリは無い。生の日次の列は返さない（要約の数字だけ）
 * - 今の値（data.now）: 1 時間足の最後の足の終値が最後の日次の終値より後なら intraday、無い・前なら最後の日次の終値
 *   （daily_close）
 * - 窓: 最後の日次の日から暦日 365 日（1y）・1,095 日（3y）・全期間（all）。d > 最後の日 − 暦日
 * - 変化（level.changes）: 今 − k 行前の日次の終値（intraday なら k = 1 は最後の終値から、daily_close なら最後の終値の
 *   k 行前から）。分位は日次の終値の k 行差の全期間の分布の中で
 * - スパイク: model/ivStats.ts の ivSpikes（直近 10 取引日の最低から spike_rise_pct 以上の上昇が起点）。日数はデータの
 *   ある取引日の行で数える。今がスパイクの中か = 今の値の直近 10 本の終値の最低からの上昇がしきい値以上、または最後の回が
 *   戻し切っていない（ongoing）
 * - 2 日の動き: 区分は dx_from_pct ≤ 変化 < dx_to_pct（開いた端は null）。組は日をずらして重なる（overlapping）
 * - β: 2 日の IV の変化（pt）を原資産の変化（%）に回帰した傾きの符号反転（シナリオの β と同じ向き・単位）
 * - HV: 1 営業日の対数変化（同じ限月どうし）の最後の 5・20・60 本、年 245 取引日。IV − HV はその最後の組の日（as_of_d）の
 *   日次の終値 − HV（今の値ではない = 同じ日どうし）
 * - 値の丸め: % と pt は小数 1 桁、β は小数 2 桁（pt / 1%）、日は整数。キーの単位は aiNumbers の規則（`*_pct` %、`*_pt` pt、
 *   `*days*` 日）。件数が少ない集計は insufficient（スパイク < 5 回、2 日の区分・β < 20 組）
 */

import { type AtmDailyDay, type AtmMove, atmMoves } from '../../data';
import {
  type Holidays,
  HV_DAYS_PER_YEAR,
  ivBeta,
  ivSpikes,
  lowBefore,
  percentileRank,
  quantile,
  quantilesOf,
  rollingVol,
  SPIKE_LOOKBACK,
  sortedFinite,
} from '../../model';
import { fin, r1, r2, round } from './aiRound';

/** ツールに渡すデータ（days は検証済み = d の昇順・重複なし。now は UNIX 秒と %） */
export interface IvStatsData {
  days: readonly AtmDailyDay[];
  now: { t: number; iv: number } | null;
}

export const IV_SECTIONS = ['level', 'spikes', 'moves', 'hv'] as const;
export type IvSection = (typeof IV_SECTIONS)[number];
/** spike_rise_pct の入力の範囲と既定（tools.py の IV_STATS_INPUT と同じ） */
export const IV_SPIKE_RANGE = [10, 100] as const;
export const IV_SPIKE_DEFAULT = 30;
export const IV_WINDOWS = [
  { window: '1y', days: 365 },
  { window: '3y', days: 1095 },
  { window: 'all', days: null },
] as const;
export const IV_CHANGE_DAYS = [1, 5, 20] as const;
/** 返すスパイクの回数（新しい順） */
export const SPIKE_RECENT = 8;
export const SPIKE_MIN_N = 5;
export const AFTER_PEAK_DAYS = [5, 10, 20] as const;
/** 2 日の動きの区分の境（%） */
export const MOVE_EDGES = [-8, -5, -3, -1, 1, 3, 5] as const;
export const MOVE_HORIZON = 2;
export const MOVE_MIN_N = 20;
export const HV_DAYS = [5, 20, 60] as const;

type R = Record<string, unknown>;
const r0 = (v: number | null | undefined) => round(v, 0);
const pctOf = (ratio: number | null | undefined) => (fin(ratio) ? (ratio - 1) * 100 : null);

const JST_S = 9 * 3600;
const pad2 = (n: number) => String(n).padStart(2, '0');
/** UNIX 秒 → JST の `YYYY-MM-DD HH:MM` */
function jstText(t: number): string {
  const d = new Date((t + JST_S) * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** 日付の k 暦日前（YYYY-MM-DD） */
function daysBefore(d: string, k: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) - k * 86_400_000).toISOString().slice(0, 10);
}

interface Now {
  iv: number;
  source: 'intraday' | 'daily_close';
  t: number;
}

function nowOf(data: IvStatsData): Now {
  const last = data.days[data.days.length - 1] as AtmDailyDay;
  const n = data.now;
  if (n && fin(n.iv) && n.iv > 0 && fin(n.t) && n.t > last.t) {
    return { iv: n.iv, source: 'intraday', t: n.t };
  }
  return { iv: last.iv, source: 'daily_close', t: last.t };
}

function level(data: IvStatsData, now: Now): R {
  const days = data.days;
  const n = days.length;
  const lastD = (days[n - 1] as AtmDailyDay).d;
  const windows = IV_WINDOWS.map((w) => {
    const from = w.days === null ? null : daysBefore(lastD, w.days);
    const xs = sortedFinite(days.filter((x) => from === null || x.d > from).map((x) => x.iv));
    const q = quantilesOf(xs);
    return {
      window: w.window,
      n: q.n,
      percentile_pct: r1(percentileRank(xs, now.iv)),
      min_pct: r1(q.min),
      p10_pct: r1(q.p10),
      p25_pct: r1(q.p25),
      p50_pct: r1(q.p50),
      p75_pct: r1(q.p75),
      p90_pct: r1(q.p90),
      max_pct: r1(q.max),
    };
  });
  const iv = days.map((x) => x.iv);
  // 今が日中なら最後の終値が 1 行前（k = 1）、終値なら最後の終値の k 行前
  const offset = now.source === 'intraday' ? 0 : 1;
  const changes = IV_CHANGE_DAYS.map((k) => {
    const i = n - offset - k;
    const base = i >= 0 ? (iv[i] as number) : null;
    const hist: number[] = [];
    for (let j = k; j < n; j++) hist.push((iv[j] as number) - (iv[j - k] as number));
    const sorted = sortedFinite(hist);
    const pt = base === null ? null : now.iv - base;
    return {
      days: k,
      iv_change_pt: r1(pt),
      iv_change_pct: base === null ? null : r1(pctOf(now.iv / base)),
      percentile_pct: pt === null ? null : r1(percentileRank(sorted, pt)),
      n: sorted.length,
    };
  });
  return { windows, changes };
}

function dist(xs: readonly number[], key: 'days' | 'pct', minN: number): R {
  const s = sortedFinite(xs);
  const f = key === 'days' ? r0 : r1;
  return {
    n: s.length,
    [`median_${key}`]: f(quantile(s, 0.5)),
    [`p10_${key}`]: f(quantile(s, 0.1)),
    [`p90_${key}`]: f(quantile(s, 0.9)),
    insufficient: s.length < minN,
  };
}

function spikes(data: IvStatsData, now: Now, risePct: number): R {
  const days = data.days;
  const iv = days.map((x) => x.iv);
  const n = iv.length;
  const rise = risePct / 100;
  const eps = ivSpikes(iv, rise, SPIKE_LOOKBACK);
  // 今の値の直近の最低（今が日中なら最後の 10 本の終値、終値なら最後の終値の前の 10 本）
  const low = lowBefore(iv, now.source === 'intraday' ? n : n - 1, SPIKE_LOOKBACK);
  const nowRise = low !== null && low > 0 ? pctOf(now.iv / low) : null;
  const done = eps.filter((e) => !e.ongoing);
  const lastEp = eps[eps.length - 1];
  const afterPeak = AFTER_PEAK_DAYS.map((k) => {
    const xs: number[] = [];
    for (const e of done) {
      const j = e.peak + k;
      if (j < n) xs.push(pctOf((iv[j] as number) / (iv[e.peak] as number)) as number);
    }
    return { days: k, ...dist(xs, 'pct', SPIKE_MIN_N) };
  });
  const recent = eps
    .slice(-SPIKE_RECENT)
    .reverse()
    .map((e) => ({
      start_d: (days[e.start] as AtmDailyDay).d,
      base_pct: r1(e.base),
      trigger_pct: r1(iv[e.start]),
      peak_d: (days[e.peak] as AtmDailyDay).d,
      peak_pct: r1(iv[e.peak]),
      rise_pct: r1(pctOf((iv[e.peak] as number) / e.base)),
      days_to_peak: e.peak - e.start,
      half_d: e.half === null ? null : (days[e.half] as AtmDailyDay).d,
      days_to_half: e.half === null ? null : e.half - e.peak,
      days_to_90pct: e.retrace90 === null ? null : e.retrace90 - e.peak,
      ongoing: e.ongoing,
    }));
  return {
    rise_threshold_pct: r1(risePct),
    lookback_days: SPIKE_LOOKBACK,
    now_rise_from_low_pct: r1(nowRise),
    now_in_spike: (nowRise !== null && nowRise >= risePct) || lastEp?.ongoing === true,
    n: eps.length,
    summary: {
      days_to_peak: dist(
        done.map((e) => e.peak - e.start),
        'days',
        SPIKE_MIN_N,
      ),
      days_to_half: dist(
        done.map((e) => (e.half as number) - e.peak),
        'days',
        SPIKE_MIN_N,
      ),
      days_to_90pct: dist(
        done.filter((e) => e.retrace90 !== null).map((e) => (e.retrace90 as number) - e.peak),
        'days',
        SPIKE_MIN_N,
      ),
    },
    after_peak: afterPeak,
    recent,
  };
}

/** 区分の番号（0〜7。dx_from_pct ≤ dxPct < dx_to_pct） */
export function moveBucket(dxPct: number): number {
  let i = 0;
  while (i < MOVE_EDGES.length && dxPct >= (MOVE_EDGES[i] as number)) i++;
  return i;
}

function moves(data: IvStatsData, holidays: Holidays): R {
  const ms = atmMoves(data.days, holidays, MOVE_HORIZON);
  const dxs = sortedFinite(ms.map((m) => m.dx * 100));
  const groups: AtmMove[][] = Array.from({ length: MOVE_EDGES.length + 1 }, () => []);
  for (const m of ms) groups[moveBucket(m.dx * 100)]?.push(m);
  const buckets = groups.map((g, i) => {
    const pct = sortedFinite(g.map((m) => pctOf(m.ivRatio) as number));
    const pt = sortedFinite(g.map((m) => m.ivPt));
    return {
      dx_from_pct: i === 0 ? null : (MOVE_EDGES[i - 1] as number),
      dx_to_pct: i === MOVE_EDGES.length ? null : (MOVE_EDGES[i] as number),
      n: g.length,
      iv_change_p5_pct: r1(quantile(pct, 0.05)),
      iv_change_median_pct: r1(quantile(pct, 0.5)),
      iv_change_p95_pct: r1(quantile(pct, 0.95)),
      iv_change_median_pt: r1(quantile(pt, 0.5)),
      insufficient: g.length < MOVE_MIN_N,
    };
  });
  const last = ms[ms.length - 1];
  const lastD = (data.days[data.days.length - 1] as AtmDailyDay).d;
  const from1y = daysBefore(lastD, 365);
  const beta = (window: 'all' | '1y', xs: readonly AtmMove[]) => {
    const b = ivBeta(xs, MOVE_MIN_N);
    return {
      window,
      down_pt: r2(b.down),
      up_pt: r2(b.up),
      all_pt: r2(b.all),
      n_down: b.nDown,
      n_up: b.nUp,
    };
  };
  return {
    horizon_days: MOVE_HORIZON,
    n: ms.length,
    overlapping: true,
    dx_quantiles: {
      p1_pct: r1(quantile(dxs, 0.01)),
      p5_pct: r1(quantile(dxs, 0.05)),
      p50_pct: r1(quantile(dxs, 0.5)),
      p95_pct: r1(quantile(dxs, 0.95)),
      p99_pct: r1(quantile(dxs, 0.99)),
    },
    buckets,
    latest: last
      ? {
          d0: last.d0,
          d1: last.d1,
          dx_pct: r1(last.dx * 100),
          iv_change_pct: r1(pctOf(last.ivRatio)),
          iv_change_pt: r1(last.ivPt),
          bucket: moveBucket(last.dx * 100),
        }
      : null,
    beta: [
      beta('all', ms),
      beta(
        '1y',
        ms.filter((m) => m.d0 > from1y),
      ),
    ],
  };
}

function hv(data: IvStatsData, holidays: Holidays): R {
  const ones = atmMoves(data.days, holidays, 1);
  const rets = ones.map((m) => Math.log(1 + m.dx));
  const last = ones[ones.length - 1];
  const ivAt = last ? last.iv1 : null;
  const windows = HV_DAYS.map((k) => {
    const v = rollingVol(rets, k, HV_DAYS_PER_YEAR).at(-1) ?? null;
    const hvPct = v === null ? null : v * 100;
    return {
      days: k,
      n: Math.min(k, rets.length),
      hv_pct: r1(hvPct),
      iv_minus_hv_pt: hvPct === null || ivAt === null ? null : r1(ivAt - hvPct),
    };
  });
  // IV − HV20 の全期間の分布（各組の d1 で終わる 20 本の HV と、その日の終値）
  const roll = rollingVol(rets, 20, HV_DAYS_PER_YEAR);
  const spreads: number[] = [];
  roll.forEach((v, i) => {
    if (v !== null) spreads.push((ones[i] as AtmMove).iv1 - v * 100);
  });
  const sorted = sortedFinite(spreads);
  const cur = spreads.at(-1);
  return {
    days_per_year: HV_DAYS_PER_YEAR,
    as_of_d: last ? last.d1 : null,
    iv_pct: r1(ivAt),
    windows,
    iv_minus_hv20_percentile_pct: cur === undefined ? null : r1(percentileRank(sorted, cur)),
    iv_minus_hv20_p50_pt: r1(quantile(sorted, 0.5)),
    n_hv20: sorted.length,
  };
}

const isEnumList = <T extends string>(v: unknown, all: readonly T[]): v is T[] =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= all.length &&
  v.every((x) => typeof x === 'string' && (all as readonly string[]).includes(x));

/** ツールの本体（入力は tool_use の input。データが無ければ no_data） */
export function ivStatsTool(
  data: IvStatsData | null,
  holidays: Holidays,
  input: Record<string, unknown>,
): R | { error: 'bad_input' | 'out_of_range' | 'no_data' } {
  const known = new Set(['sections', 'spike_rise_pct']);
  if (Object.keys(input).some((k) => !known.has(k))) return { error: 'bad_input' };
  const secIn = input.sections ?? [...IV_SECTIONS];
  if (!isEnumList(secIn, IV_SECTIONS)) return { error: 'bad_input' };
  const rise = input.spike_rise_pct;
  if (rise !== undefined) {
    if (typeof rise !== 'number' || !Number.isFinite(rise)) return { error: 'bad_input' };
    if (rise < IV_SPIKE_RANGE[0] || rise > IV_SPIKE_RANGE[1]) return { error: 'out_of_range' };
  }
  if (!data || data.days.length === 0) return { error: 'no_data' };
  const secs = IV_SECTIONS.filter((s) => secIn.includes(s));
  const now = nowOf(data);
  const first = data.days[0] as AtmDailyDay;
  const last = data.days[data.days.length - 1] as AtmDailyDay;
  const out: R = {
    data: {
      first_d: first.d,
      last_d: last.d,
      n_days: data.days.length,
      last_close_pct: r1(last.iv),
      now_source: now.source,
      now_at: jstText(now.t),
      iv_now_pct: r1(now.iv),
    },
  };
  if (secs.includes('level')) out.level = level(data, now);
  if (secs.includes('spikes'))
    out.spikes = spikes(data, now, (rise as number | undefined) ?? IV_SPIKE_DEFAULT);
  if (secs.includes('moves')) out.moves = moves(data, holidays);
  if (secs.includes('hv')) out.hv = hv(data, holidays);
  return out;
}

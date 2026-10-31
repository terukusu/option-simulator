/**
 * IV 推移（ATM IV の 30 日固定 = iv30。#79、docs/ui-redesign.md §4.7）の表示モデル（純関数。Preact に依存しない）。
 *
 * - 足: 1 分・5 分・15 分・1 時間（既定）・4 時間・日足。5 分・15 分は 1 分の読み込みから束ねる（resampleBars）。4 時間は
 *   1 時間の読み込みを立会に合わせて束ねる（model/bars.ts の resample4h: 08・12・17・21・01 時に始まる 1 取引日 5 本。#200）
 * - 横軸は足の index（取引の無い時間・休日は詰まる）。表示範囲は index の Domain（ui/chart/scale.ts の規則で拡大・パン）
 * - 欠けで線を切る（lineSegments）: 隣り合う足の間の立会の時間が max(足の長さ, 30 分) 以上なら分ける。立会は
 *   日中 08:45〜15:45・夜間 17:00〜翌 06:00（JST）で、その日（夜間は始まる日）が取引日のときだけ数える。日足は間に
 *   取引日が 1 日でもあれば分ける。取引日 = 土日と取引カレンダーの is_trading_day = false の日以外
 * - 右端の足は進行中（表は直近 1〜2 時間を作り直す）: 右端まで読んであれば最後の 1 本を .progress で描く
 * - 「今」の 1 点（段 C）: 今の板から optionchan と同じ定義で計算した iv30（model/constantMaturity.ts）を、表の最後の行
 *   （応答の last_at の最大）より新しい板のときだけ右端に印で足す（ivNowValue・ivNowPoint）
 * - シナリオの水準（段 C）: 基準（「今」、無ければ最新の足の close）にシナリオの ATM（x_eff = 0）の Δσ + Δσ_β を当てた
 *   水準を横の破線で重ねる（ivScenarioLevel。model/scenario.ts の sigmaAt をそのまま使う）。今の ATM の行使価格の IV
 *   （sticky strike の上の上乗せだけ）で、下げでは ATM が下の行使価格へ移る分（スキューの坂。設計 5.12 の ATM の β）は
 *   足さない（二重に数えない）。ATM IV の線は下げでこれより上に出る
 * - 追加読み込み（段 C）: 端から何本かは ivEdges、読み込みの後に見ている時刻を保つ（右端に付いていれば右端に付いていく）
 *   のは ivFollowViewport。規則は ui/view/ivLoad.ts
 * - 色は持たない（CSS のクラス名だけ）。値は iv30 の %（pt）で小数 2 桁、時刻は JST
 */

import type { AtmIvSource, ChainJson, IvBar } from '../../data';
import {
  type CmMethod,
  constantMaturityIv,
  fourHourStart,
  resample4h,
  type Scenario,
  SIGMA_MIN,
  sigmaAt,
} from '../../model';
import { clampViewport, type Domain, linear, niceTicks, padDomain } from '../chart/scale';
import { DASH, fmtNum } from './format';

export type IvTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type IvMode = 'candle' | 'line';

/** 足の切替（ツールの行の Seg。文字は短く、aria-label に全文） */
export const IV_TFS: readonly { value: IvTf; text: string; label: string }[] = [
  { value: '1m', text: '1分', label: '1 分足' },
  { value: '5m', text: '5分', label: '5 分足' },
  { value: '15m', text: '15分', label: '15 分足' },
  { value: '1h', text: '1時間', label: '1 時間足' },
  { value: '4h', text: '4時間', label: '4 時間足（立会に合わせる）' },
  { value: '1d', text: '日足', label: '日足' },
];
export const IV_DEFAULT_TF: IvTf = '1h';

/** 表示の形（既定はローソク足。オーナー判断 5） */
export const IV_MODES: readonly { value: IvMode; text: string; label: string }[] = [
  { value: 'candle', text: 'ローソク', label: 'ローソク足' },
  { value: 'line', text: '線', label: '折れ線' },
];
export const IV_DEFAULT_MODE: IvMode = 'candle';

/** 足の長さ（秒。4 時間足は名目。夜間の最後の足は 5 時間 = model/bars.ts の fourHourStart） */
export const IV_TF_SECONDS: Record<IvTf, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/** その足を作るためにサーバーから読む足（5 分・15 分は 1 分、4 時間は 1 時間を共有する） */
export function ivSource(tf: IvTf): AtmIvSource {
  return tf === '5m' || tf === '15m' ? '1m' : tf === '4h' ? '1h' : tf;
}

/** 初期表示の本数（ビューアーの initialBars）。右に IV_RIGHT_OFFSET 本の余白 */
export const IV_INITIAL_BARS: Record<IvTf, number> = {
  '1m': 240,
  '5m': 150,
  '15m': 120,
  '1h': 120,
  '4h': 120,
  '1d': 100,
};
export const IV_RIGHT_OFFSET = 3;
/** 表示範囲の最小の幅（本） */
export const IV_MIN_BARS = 10;

/** 欠けの閾値の下限（分）。足の長さがこれより長ければ足の長さ */
export const IV_GAP_MIN_MINUTES = 30;
/** 4 時間足の欠けの閾値（分。足の半分） */
export const IV_GAP_4H_MINUTES = 120;
/** 立会の窓（JST の 0 時からの分。夜間は翌 06:00 = 1800 分まで） */
export const IV_SESSIONS: readonly (readonly [number, number])[] = [
  [8 * 60 + 45, 15 * 60 + 45],
  [17 * 60, 30 * 60],
];

const JST_S = 9 * 3600;
const DAY_S = 86400;

/** UNIX 秒 → JST の暦日の通し番号（1970-01-01 = 0） */
export function jstDayIndex(t: number): number {
  return Math.floor((t + JST_S) / DAY_S);
}

function dayDate(day: number): string {
  return new Date(day * DAY_S * 1000).toISOString().slice(0, 10);
}

/** JST の暦日の通し番号が取引日か（土日と取引の無い平日 = is_trading_day = false の日以外） */
export function isIvTradingDay(day: number, nonTradingDays: ReadonlySet<string>): boolean {
  // 1970-01-01 は木曜（0 = 日曜）
  const wd = (((day + 4) % 7) + 7) % 7;
  if (wd === 0 || wd === 6) return false;
  return !nonTradingDays.has(dayDate(day));
}

/** [t0, t1)（UNIX 秒）に含まれる立会の時間（分） */
export function sessionMinutesBetween(
  t0: number,
  t1: number,
  nonTradingDays: ReadonlySet<string>,
): number {
  if (!(t1 > t0) || !Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  let sum = 0;
  // 夜間は前の日に始まるので 1 日前から見る
  for (let d = jstDayIndex(t0) - 1, last = jstDayIndex(t1); d <= last; d++) {
    if (!isIvTradingDay(d, nonTradingDays)) continue;
    const base = d * DAY_S - JST_S;
    for (const [a, b] of IV_SESSIONS) {
      const lo = Math.max(t0, base + a * 60);
      const hi = Math.min(t1, base + b * 60);
      if (hi > lo) sum += hi - lo;
    }
  }
  return sum / 60;
}

/** 線を分けるか（a・b は隣り合う足。先物の限月交代では分けない = 期近のつなぎ足。#190） */
function isGap(a: IvBar, b: IvBar, tf: IvTf, nonTradingDays: ReadonlySet<string>): boolean {
  if (tf === '1d') {
    for (let d = jstDayIndex(a.t) + 1, end = jstDayIndex(b.t); d < end; d++) {
      if (isIvTradingDay(d, nonTradingDays)) return true;
    }
    return false;
  }
  const sec = IV_TF_SECONDS[tf];
  // 4 時間足は足の半分（日中の後半 3 時間 45 分が欠けても切れるように）
  const limit = tf === '4h' ? IV_GAP_4H_MINUTES : Math.max(sec / 60, IV_GAP_MIN_MINUTES);
  return sessionMinutesBetween(a.t + sec, b.t, nonTradingDays) >= limit;
}

/** 線の区間（index の [最初, 最後] の列。欠けで分ける。足が 0 本なら空） */
export function lineSegments(
  bars: readonly IvBar[],
  tf: IvTf,
  nonTradingDays: ReadonlySet<string>,
): [number, number][] {
  if (bars.length === 0) return [];
  const out: [number, number][] = [];
  let from = 0;
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1] as IvBar;
    const b = bars[i] as IvBar;
    if (isGap(a, b, tf, nonTradingDays)) {
      out.push([from, i - 1]);
      from = i;
    }
  }
  out.push([from, bars.length - 1]);
  return out;
}

/**
 * 1 分足 → 5 分・15 分（UNIX 秒で切る。open / close = 最初 / 最後、high / low = 最大 / 最小）。他のキー（先物の限月 m）は
 * 最後の足の値を運ぶ（限月交代は 17:00 = 5 分・15 分の区切りなので足の中で混ざらない）
 */
export function resampleBars<B extends IvBar>(bars: readonly B[], seconds: number): B[] {
  const out: B[] = [];
  let cur: B | null = null;
  for (const b of bars) {
    const t = Math.floor(b.t / seconds) * seconds;
    if (cur && cur.t === t) {
      const o: number = cur.o;
      const h = Math.max(cur.h, b.h);
      const l = Math.min(cur.l, b.l);
      Object.assign(cur, b, { t, o, h, l });
    } else {
      cur = { ...b, t };
      out.push(cur);
    }
  }
  return out;
}

/** 読んだ足（ivSource の足）から表示する足を作る（4 時間足は立会に合わせる = model/bars.ts の resample4h。#200） */
export function barsForTf<B extends IvBar>(bars: readonly B[], tf: IvTf): readonly B[] {
  if (tf === '4h') return resample4h(bars);
  return tf === '5m' || tf === '15m' ? resampleBars(bars, IV_TF_SECONDS[tf]) : bars;
}

/** 時刻をキーにつなぐ（同じ t は新しい方 = next を使う）。どちらも t の昇順 */
export function mergeBars<B extends IvBar>(prev: readonly B[], next: readonly B[]): B[] {
  const out: B[] = [];
  let i = 0;
  let j = 0;
  while (i < prev.length || j < next.length) {
    const a = prev[i];
    const b = next[j];
    if (b === undefined || (a !== undefined && a.t < b.t)) {
      out.push(a as B);
      i++;
    } else {
      if (a !== undefined && a.t === b.t) i++;
      out.push(b);
      j++;
    }
  }
  return out;
}

/** 全域（index。左の余白 leftSlack 本・右の余白 IV_RIGHT_OFFSET 本）。足が 0 本なら [−0.5, 0.5] */
export function ivFullDomain(n: number, leftSlack = 0): Domain {
  if (n === 0) return [-0.5, 0.5];
  return [-0.5 - leftSlack, n - 0.5 + IV_RIGHT_OFFSET];
}

/** 足を替えても見ていた時間の範囲を保つための控え（時刻。right = 右端の足が見えていた） */
export interface IvKeep {
  from: number;
  to: number;
  right: boolean;
}

/** 今の表示範囲の時刻（足の切替の前に取る）。足が 0 本なら null */
export function ivKeepOf(bars: readonly IvBar[], viewport: Domain): IvKeep | null {
  const n = bars.length;
  if (n === 0) return null;
  const i0 = Math.min(Math.max(Math.ceil(viewport[0]), 0), n - 1);
  const i1 = Math.min(Math.max(Math.floor(viewport[1]), 0), n - 1);
  const a = bars[Math.min(i0, i1)] as IvBar;
  const b = bars[Math.max(i0, i1)] as IvBar;
  return { from: a.t, to: b.t, right: viewport[1] >= n - 1 };
}

/** t 以上の最初の index（無ければ n） */
function lowerBound(bars: readonly IvBar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid] as IvBar).t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 表示範囲（index）: 明示の viewport があればそれを全域に収める、無ければ控え（足の切替の前の時刻の範囲。読んだ範囲と
 * 重なるときだけ）、それも無ければ初期表示（右端から IV_INITIAL_BARS 本 + 右に IV_RIGHT_OFFSET 本）
 */
export function resolveIvViewport(
  bars: readonly IvBar[],
  tf: IvTf,
  viewport: Domain | null,
  keep: IvKeep | null,
  leftSlack = 0,
): Domain {
  const n = bars.length;
  const full = ivFullDomain(n, leftSlack);
  const minWidth = Math.min(IV_MIN_BARS, full[1] - full[0]);
  if (viewport) return clampViewport(viewport, full, minWidth);
  if (keep && n > 0) {
    const sec = IV_TF_SECONDS[tf];
    // from を含む足から、to 以下の最後の足まで
    const lo = lowerBound(bars, keep.from - sec + 1);
    const hi = lowerBound(bars, keep.to + 1) - 1;
    if (lo <= hi && lo < n && hi >= 0) {
      // 右端が見えていたなら右端に付ける（IV 推移 ⇄ 先物の切替で、相手の最後の足が少し古くても最新まで見せる。#190）
      const right = keep.right ? full[1] : hi + 0.5;
      return clampViewport([lo - 0.5, right], full, minWidth);
    }
  }
  return clampViewport([n - IV_INITIAL_BARS[tf] - 0.5, full[1]], full, minWidth);
}

/** 左に読む余地があるときの左の余白（本） */
export const IV_LEFT_SLACK = 10;

/**
 * 読み込みの後の表示範囲（index）: 前の足の並び prev と次 next の共通の足で、見ている時刻が動かないようにずらす
 * （前に足したら足した本数だけ右へ、左を捨てたら捨てた本数だけ左へ）。右端の足が見えていた（viewport[1] ≥ prev の最後）
 * なら右端に付いていく（右に足した本数もずらす）。明示の表示範囲が無い・前の足が無い・共通の時刻が無い（読み済みを
 * 置き換えた）ときは null（初期表示）
 */
export function ivFollowViewport(
  prev: readonly IvBar[],
  next: readonly IvBar[],
  viewport: Domain | null,
): Domain | null {
  if (!viewport || prev.length === 0 || next.length === 0) return null;
  if (prev === next) return viewport;
  const first = next[0] as IvBar;
  const ip = lowerBound(prev, first.t);
  if (ip >= prev.length) return null;
  const t = (prev[ip] as IvBar).t;
  const inx = lowerBound(next, t);
  if (inx >= next.length || (next[inx] as IvBar).t !== t) return null;
  const shift = viewport[1] >= prev.length - 1 ? next.length - prev.length : inx - ip;
  return shift === 0 ? viewport : [viewport[0] + shift, viewport[1] + shift];
}

/** 表示範囲が端から IV_EDGE_BARS 本未満か（左: 左端が最初の足から、右: 右端が最後の足から）。足が 0 本（右端の 1 回分が
 * 空 = 休場・取り込みの停止）なら左だけ（左へ読めるようにする） */
export function ivEdges(
  viewport: Domain,
  n: number,
  edgeBars: number,
): { left: boolean; right: boolean } {
  if (n === 0) return { left: true, right: false };
  return { left: viewport[0] < edgeBars, right: viewport[1] > n - 1 - edgeBars };
}

/** UNIX 秒が属する取引日の 00:00 JST（日足の足の t。サーバーの trading_day と同じ: 17:00 からは次の取引日、土日・休業日は飛ばす） */
export function ivTradingDayStart(t: number, nonTradingDays: ReadonlySet<string>): number {
  let d = jstDayIndex(t + 7 * 3600);
  for (let i = 0; i < 30 && !isIvTradingDay(d, nonTradingDays); i++) d++;
  return d * DAY_S - JST_S;
}

/** 今の板の iv30（「今」の 1 点の値）。t = スナップショットの UNIX 秒 */
export interface IvNowValue {
  t: number;
  iv: number;
  method: CmMethod;
}

/** 今の板（板の JSON の生の気配）から iv30 を計算する（出なければ null） */
export function ivNowValue(
  json: ChainJson,
  nonTradingDays: ReadonlySet<string>,
): IvNowValue | null {
  const at = Date.parse(json.snapshot_at);
  const r = constantMaturityIv(
    at,
    json.months.map((m) => ({ lastTradingDay: m.last_trading_day, rows: m.rows })),
    nonTradingDays,
  );
  return r ? { t: Math.floor(at / 1000), iv: r.iv30, method: r.method } : null;
}

/**
 * 「今」の印の位置（足の index）と値。表の最後の行（lastAt）より新しい板のときだけ（lastAt が無ければ比べない）。
 * 今の足の区間が最後の足と同じならその足の index、違えば n（最後の足の右）。足が無ければ null
 */
export function ivNowPoint(
  now: IvNowValue | null,
  bars: readonly IvBar[],
  tf: IvTf,
  lastAt: number | null,
  nonTradingDays: ReadonlySet<string>,
): { index: number; iv: number } | null {
  const n = bars.length;
  if (!now || n === 0) return null;
  if (lastAt !== null && !(now.t > lastAt)) return null;
  const sec = IV_TF_SECONDS[tf];
  const bucket =
    tf === '1d'
      ? ivTradingDayStart(now.t, nonTradingDays)
      : tf === '4h'
        ? fourHourStart(now.t)
        : Math.floor(now.t / sec) * sec;
  return { index: bucket <= (bars[n - 1] as IvBar).t ? n - 1 : n, iv: now.iv };
}

/**
 * シナリオの水準（pt）: 基準 base（%）にシナリオの ATM（x_eff = 0 = フォワード ATM。スキュー Δs は効かない）の
 * Δσ + Δσ_β を当てた値。absolute は base + Δσ + Δσ_β、relative は base·(1 + Δσ/100) + Δσ_β、下限 σ_min。
 * Δσ_β = β × g(ΔX%)（betaAddPt。今の ATM の行使価格の上乗せ。ATM が移る分は含まない）。
 * ΔX = Δσ = 0（今と同じ）・基準が無い・X₀ が正でなければ null
 */
export function ivScenarioLevel(base: number | null, sc: Scenario, x0: number): number | null {
  if (base === null || !Number.isFinite(base)) return null;
  if (sc.dX === 0 && sc.dSigma === 0) return null;
  if (!(Number.isFinite(x0) && x0 > 0)) return null;
  return sigmaAt(() => base / 100, 1, 1, 1, x0, x0 + sc.dX, sc, SIGMA_MIN) * 100;
}

/** 描画域の余白（px。縦の目盛りは左） */
export const IV_MARGIN = { left: 40, right: 10, top: 10, bottom: 22 } as const;

/**
 * 系列の書式（#190。同じ描画域で IV 推移と先物推移を描く）: 読み取り・縦軸の札の値の書式と、縦の目盛りの列の幅（左の
 * 余白 px）。縦の目盛りのラベルは刻みの桁で決める（どちらも同じ）
 */
export interface IvSeries {
  fmt: (v: number | null | undefined) => string;
  marginLeft: number;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** JST の暦の値 */
function jstParts(t: number) {
  const d = new Date((t + JST_S) * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  };
}

/** 読み取りの時刻（日足は日付、それ以外は 月/日 時:分） */
export function ivTimeText(t: number, tf: IvTf): string {
  const p = jstParts(t);
  if (tf === '1d') return `${p.y}/${pad2(p.m)}/${pad2(p.d)}`;
  return `${pad2(p.m)}/${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}`;
}

/** IV の値（pt。小数 2 桁） */
export const fmtIvPt = (v: number | null | undefined): string => fmtNum(v, 2);

/** IV 推移の系列（既定） */
export const IV_SERIES: IvSeries = { fmt: fmtIvPt, marginLeft: IV_MARGIN.left };

export interface IvReadout {
  time: string;
  o: string;
  h: string;
  l: string;
  c: string;
  /** 右端の進行中の足（確定前） */
  progress: boolean;
}

/** 読み取りの 1 行（カーソルの足。カーソルが無ければ最新の足。足が無ければ —） */
export function ivReadout(
  bars: readonly IvBar[],
  tf: IvTf,
  cursor: number | null,
  rightLoaded: boolean,
  fmt: IvSeries['fmt'] = fmtIvPt,
): IvReadout {
  const n = bars.length;
  const i = cursor === null ? n - 1 : Math.min(Math.max(Math.round(cursor), 0), n - 1);
  const b = bars[i];
  if (!b) return { time: DASH, o: DASH, h: DASH, l: DASH, c: DASH, progress: false };
  return {
    time: ivTimeText(b.t, tf),
    o: fmt(b.o),
    h: fmt(b.h),
    l: fmt(b.l),
    c: fmt(b.c),
    progress: rightLoaded && i === n - 1,
  };
}

/** 横軸の目盛りの候補（細かい方から）。key が変わる足に目盛りを置く */
interface TickRule {
  /** この長さ（秒）以下の足で使う（足 1 本ごとより粗い区切りだけ） */
  maxTf: number;
  key: (t: number) => number;
  label: (t: number, prev: number | null) => string;
}

const hm = (t: number) => {
  const p = jstParts(t);
  return `${pad2(p.hh)}:${pad2(p.mm)}`;
};
const md = (t: number) => {
  const p = jstParts(t);
  return `${p.m}/${p.d}`;
};
/** 日中の目盛り: 日付が変わった足は 月/日、それ以外は 時:分 */
const intraLabel = (t: number, prev: number | null) =>
  prev !== null && jstDayIndex(prev) !== jstDayIndex(t) ? md(t) : hm(t);
const everySec = (s: number) => (t: number) => Math.floor((t + JST_S) / s);
const monthKey = (step: number) => (t: number) => {
  const p = jstParts(t);
  return Math.floor((p.y * 12 + p.m - 1) / step);
};
const monthLabel = (t: number) => {
  const p = jstParts(t);
  return p.m === 1 ? `${p.y}` : `${p.m}月`;
};

const TICK_RULES: readonly TickRule[] = [
  ...[300, 900, 1800, 3600, 7200, 10800, 21600, 43200].map((s) => ({
    maxTf: s / 2,
    key: everySec(s),
    label: intraLabel,
  })),
  { maxTf: DAY_S, key: everySec(DAY_S), label: (t: number) => md(t) },
  {
    maxTf: DAY_S,
    key: (t: number) => Math.floor((jstDayIndex(t) + 3) / 7),
    label: (t: number) => md(t),
  },
  ...[1, 3, 6].map((step) => ({ maxTf: DAY_S, key: monthKey(step), label: monthLabel })),
  { maxTf: DAY_S, key: monthKey(12), label: (t: number) => `${jstParts(t).y}` },
];

/** 目盛りのラベルの推定幅（px。10.5px の等幅の数字 ≈ 6.3px、全角 ≈ 10.5px）。損益グラフの十字線の札も使う（#201） */
export function labelPx(s: string): number {
  let w = 0;
  for (const c of s) w += c.charCodeAt(0) > 255 ? 10.5 : 6.3;
  return w;
}
const TICK_GAP = 14;
/** 区切りを採る条件（間引かずに残る目盛りの割合） */
const TICK_KEEP = 0.7;

export interface IvTick {
  x: number;
  label: string;
}

/** 横軸の目盛り（見えている足の範囲で、ラベルが重ならない最も細かい区切り） */
function xTicksOf(
  bars: readonly IvBar[],
  tf: IvTf,
  i0: number,
  i1: number,
  sx: (v: number) => number,
  widthPx: number,
): IvTick[] {
  if (i1 < i0) return [];
  const sec = IV_TF_SECONDS[tf];
  let last: IvTick[] = [];
  const from = Math.max(i0, 1);
  for (const rule of TICK_RULES) {
    if (rule.maxTf < sec) continue;
    // 区切りの足の index（ラベルは数が入るときだけ作る）
    const at: number[] = [];
    let prevKey = from <= i1 ? rule.key((bars[from - 1] as IvBar).t) : 0;
    for (let i = from; i <= i1; i++) {
      const key = rule.key((bars[i] as IvBar).t);
      if (key !== prevKey) at.push(i);
      prevKey = key;
    }
    // 足は時間が詰まっているので間隔は不揃い（週末・休日の前後は近い）。間引くのが 3 割までの最も細かい区切りを使う
    if (at.length * TICK_GAP > widthPx) continue;
    const ticks = at.map((i) => ({
      x: sx(i),
      label: rule.label((bars[i] as IvBar).t, (bars[i - 1] as IvBar).t),
    }));
    last = dropOverlaps(ticks);
    if (last.length >= ticks.length * TICK_KEEP) return last;
  }
  return last;
}

/** 重なる目盛りを左から間引く */
function dropOverlaps(ticks: IvTick[]): IvTick[] {
  const out: IvTick[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const t of ticks) {
    const half = labelPx(t.label) / 2;
    if (t.x - half < right + TICK_GAP) continue;
    out.push(t);
    right = t.x + half;
  }
  return out;
}

export interface IvCandle {
  /** 足の t（key） */
  t: number;
  x: number;
  /** 実体の左上と大きさ（px） */
  bodyX: number;
  bodyY: number;
  bodyW: number;
  bodyH: number;
  /** ひげ（高値・安値の y） */
  yHigh: number;
  yLow: number;
  /** iv-bar up / down（+ progress） */
  cls: string;
}

export interface IvChartInput {
  bars: readonly IvBar[];
  tf: IvTf;
  mode: IvMode;
  /** 表示範囲（resolveIvViewport の結果） */
  viewport: Domain;
  /** lineSegments の結果 */
  segments: readonly (readonly [number, number])[];
  width: number;
  height: number;
  /** 右端（最新）まで読んである = 最後の足は進行中 */
  rightLoaded: boolean;
  /** 「今」の印（ivNowPoint の結果。無ければ null） */
  now?: { index: number; iv: number } | null;
  /** シナリオの水準（pt。無ければ null） */
  scenario?: number | null;
  /** 系列の書式（無ければ IV_SERIES。縦の目盛りの列の幅に使う） */
  series?: IvSeries;
  /**
   * 価格に重ねる線（#206 先物推移の EMA。足の index ごとの値、無い足は null）。縦軸の範囲には入れない（はみ出しは
   * 描画域の clip で切る = 線の出し入れで軸を動かさない）
   */
  overlays?: readonly IvOverlay[];
}

/** 重ねる線の入力（cls = CSS のクラス。色は CSS だけ。width = 線の太さ px = SVG の stroke-width 属性。#214） */
export interface IvOverlay {
  cls: string;
  values: readonly (number | null)[];
  width?: number;
}

export interface IvChartModel {
  empty: boolean;
  width: number;
  height: number;
  /** 描画域の横の画素範囲 */
  range: Domain;
  yDomain: Domain;
  candles: IvCandle[];
  /** 線（確定した区間。M…L… の path。無ければ空文字） */
  line: string;
  /** 1 本だけの区間の点（path） */
  dots: string;
  /** 右端の進行中の区間（最後の 2 本の間。1 本だけなら点）。無ければ空文字 */
  progress: string;
  xTicks: IvTick[];
  yTicks: { y: number; label: string }[];
  /** 「今」の印の座標（無ければ null） */
  nowPt: { x: number; y: number } | null;
  /** シナリオの水準の横線の y（無ければ null） */
  scenarioY: number | null;
  /** 重ねる線の path（入力の overlays の順。見えている足 + 端の 1 本外だけ。値の無い足で切る。無ければ空文字） */
  overlays: { cls: string; d: string; width?: number }[];
}

/** [i0, i1] の足の安値〜高値（無ければ null） */
function lowHigh(bars: readonly IvBar[], i0: number, i1: number): Domain | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = i0; i <= i1; i++) {
    const b = bars[i] as IvBar;
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** IV 推移の描画の座標（見えている足だけ）。 */
export function ivChartModel(p: IvChartInput): IvChartModel {
  const { bars, viewport, width, height } = p;
  const n = bars.length;
  const left = (p.series ?? IV_SERIES).marginLeft;
  const w = Math.max(width, left + IV_MARGIN.right + 10);
  const h = Math.max(height, IV_MARGIN.top + IV_MARGIN.bottom + 10);
  const range: Domain = [left, w - IV_MARGIN.right];
  const sx = linear(viewport, range);
  // 中心が表示範囲に入る足（線は端の 1 本外まで描いて切る）
  const i0 = Math.max(0, Math.ceil(viewport[0]));
  const i1 = Math.min(n - 1, Math.floor(viewport[1]));
  const seen = lowHigh(bars, i0, i1) ?? lowHigh(bars, 0, n - 1);
  // 縦軸: 見えている足の安値〜高値と、見えている「今」・シナリオの水準
  const now = p.now && p.now.index >= viewport[0] && p.now.index <= viewport[1] ? p.now : null;
  const scenario = p.scenario ?? null;
  let base: Domain | null = seen;
  for (const v of [now?.iv ?? null, scenario]) {
    if (v === null || !Number.isFinite(v)) continue;
    base = base ? [Math.min(base[0], v), Math.max(base[1], v)] : [v, v];
  }
  const yDomain: Domain = base ? padDomain(base, 0.08, 0.25) : [0, 1];
  const sy = linear(yDomain, [h - IV_MARGIN.bottom, IV_MARGIN.top]);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const progressAt = p.rightLoaded && n > 0 ? n - 1 : -1;

  const candles: IvCandle[] = [];
  if (p.mode === 'candle') {
    const perBar = (range[1] - range[0]) / Math.max(viewport[1] - viewport[0], 1e-9);
    const bw = Math.min(Math.max(perBar * 0.7, 1), 14);
    for (let i = i0; i <= i1; i++) {
      const b = bars[i] as IvBar;
      const x = sx(i);
      const yo = sy(b.o);
      const yc = sy(b.c);
      const top = Math.min(yo, yc);
      const up = b.c >= b.o;
      candles.push({
        t: b.t,
        x: r1(x),
        bodyX: r1(x - bw / 2),
        bodyY: r1(top),
        bodyW: r1(bw),
        bodyH: r1(Math.max(Math.abs(yc - yo), 1)),
        yHigh: r1(sy(b.h)),
        yLow: r1(sy(b.l)),
        cls: `iv-bar ${up ? 'up' : 'down'}${i === progressAt ? ' progress' : ''}`,
      });
    }
  }

  let line = '';
  let dots = '';
  let progress = '';
  if (p.mode === 'line') {
    const pt = (i: number) => `${r1(sx(i))} ${r1(sy((bars[i] as IvBar).c))}`;
    const dot = (i: number) => {
      const x = r1(sx(i) - 2);
      const y = r1(sy((bars[i] as IvBar).c));
      return `M${x} ${y}a2 2 0 1 0 4 0a2 2 0 1 0 -4 0`;
    };
    for (const [a, b] of p.segments) {
      // 見えている範囲に掛かる区間だけ（端は 1 本外まで描いて切る）
      if (b < i0 - 1 || a > i1 + 1) continue;
      if (b === progressAt) progress = a === b ? dot(b) : `M${pt(b - 1)}L${pt(b)}`;
      if (a === b) {
        // 1 本だけの区間は点（進行中なら上の progress）
        if (b !== progressAt) dots += dot(a);
        continue;
      }
      const from = Math.max(a, i0 - 1);
      const to = Math.min(b === progressAt ? b - 1 : b, i1 + 1);
      if (to <= from) continue;
      let d = `M${pt(from)}`;
      for (let i = from + 1; i <= to; i++) d += `L${pt(i)}`;
      line += d;
    }
  }

  // 重ねる線（#206）: 見えている足（端は 1 本外まで）を結ぶ。値の無い足（ウォームアップ中）で切る。1 画素に 2 本以上の
  // 足が入るとき（縮小）は 1 画素の列に 1 点（その列の最後の足）= 指標の段のオシレーターの線と同じ規則（1 万本でも 1 フレームの予算に収める）
  const thin = (range[1] - range[0]) / Math.max(viewport[1] - viewport[0], 1e-9) < 1;
  const has = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined && Number.isFinite(v);
  const overlays = (p.overlays ?? []).map((o) => {
    let d = '';
    let pen = false;
    const from = Math.max(0, i0 - 1);
    const to = Math.min(n - 1, i1 + 1);
    for (let i = from; i <= to; i++) {
      const v = o.values[i];
      if (!has(v)) {
        pen = false;
        continue;
      }
      const x = sx(i);
      if (thin && i < to && Math.floor(sx(i + 1)) === Math.floor(x) && has(o.values[i + 1]))
        continue;
      d += `${pen ? 'L' : 'M'}${r1(x)} ${r1(sy(v))}`;
      pen = true;
    }
    return o.width === undefined ? { cls: o.cls, d } : { cls: o.cls, d, width: o.width };
  });

  const yVals = niceTicks(
    yDomain[0],
    yDomain[1],
    Math.min(Math.max(Math.floor(h / 70), 3), 8),
  ).filter((v) => v >= yDomain[0] && v <= yDomain[1]);
  // 刻みの桁（1・2・5 × 10^n）で小数の桁を決める
  const step = yVals.length > 1 ? (yVals[1] as number) - (yVals[0] as number) : 1;
  const yDigits = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const yTicks = yVals.map((v) => ({ y: r1(sy(v)), label: fmtNum(v, yDigits) }));
  const xTicks = xTicksOf(bars, p.tf, i0, i1, sx, range[1] - range[0]).map((t) => ({
    ...t,
    x: r1(t.x),
  }));
  return {
    empty: n === 0,
    width: w,
    height: h,
    range,
    yDomain,
    candles,
    line,
    dots,
    progress,
    xTicks,
    yTicks,
    nowPt: now && n > 0 ? { x: r1(sx(now.index)), y: r1(sy(now.iv)) } : null,
    scenarioY: scenario !== null && Number.isFinite(scenario) && n > 0 ? r1(sy(scenario)) : null,
    overlays,
  };
}

/** 軸の札（塗りの矩形の左上・大きさと文字。px） */
export interface IvTag {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** 十字線（縦線 = カーソルの足の x、横線 = 指 / マウスの高さ）と軸の札（横軸 = 足の時刻、縦軸 = その高さの IV） */
export interface IvCrosshair {
  x: number;
  y: number;
  xTag: IvTag;
  yTag: IvTag;
}

/** 札の高さ（px）と文字の左右の余白の合計（横軸・縦軸） */
export const IV_TAG_H = 15;
export const IV_TAG_PAD_X = 8;
export const IV_TAG_PAD_Y = 6;

export interface IvCrosshairInput {
  bars: readonly IvBar[];
  tf: IvTf;
  viewport: Domain;
  /** カーソルの足の index（無ければ null） */
  cursor: number | null;
  /**
   * 横線の高さ（要素の座標の画素。指 / マウスの縦の位置）。null = 縦の位置が無い（キー , . だけで置いた）ときで、
   * カーソルの足の終値の高さに置く
   */
  y: number | null;
  /** ivChartModel の結果（同じ bars・viewport・幅・高さで作ったもの） */
  model: Pick<IvChartModel, 'empty' | 'width' | 'height' | 'range' | 'yDomain'>;
  /** 縦軸の札の値の書式（無ければ IV の fmtIvPt） */
  fmt?: IvSeries['fmt'];
}

/**
 * カーソルの十字線と軸の札（#130。ivChartModel から分ける = カーソルの移動で 1 万本の座標を作り直さない。O(1)）。
 * 縦線は足に吸着（カーソルの足の x）、横線は足の値に吸着せず指 / マウスの高さ（オーナーの決定 2026-10-18: 足の値は
 * 読み取りの行で分かるので、十字線は任意の水準を調べるのに使う）。横線は描画域の上下の端で止める。
 * 横軸の札の文字 = 読み取りの時刻（ivTimeText）、縦軸の札の文字 = 横線の高さの IV（縦軸の目盛りの逆変換。桁は読み取りの
 * 始・高・安・終と同じ小数 2 桁 = fmtIvPt。任意の水準を測るので目盛りの桁では粗い）。横軸の札は目盛りの行（下の余白）に、縦軸の札は目盛りの列（左の余白。右端 = 描画域の左 − 1）に置き、
 * svg の外へはみ出さないよう端で寄せる。カーソルが無い・足 0 本・カーソルの足が表示範囲（画素の range）の外なら null
 */
export function ivCrosshair(p: IvCrosshairInput): IvCrosshair | null {
  const { bars, model } = p;
  const n = bars.length;
  if (model.empty) return null;
  const c = ivCursorBar(p.cursor, n, p.viewport);
  if (c === null) return null;
  const b = bars[c] as IvBar;
  const { range, width, height } = model;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const x = r1(linear(p.viewport, range)(c));
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(hi, lo));
  const yPx: Domain = [height - IV_MARGIN.bottom, IV_MARGIN.top];
  const y = r1(
    clamp(p.y ?? linear(model.yDomain, yPx)(b.c), IV_MARGIN.top, height - IV_MARGIN.bottom),
  );
  const xText = ivTimeText(b.t, p.tf);
  const xw = r1(Math.min(labelPx(xText) + IV_TAG_PAD_X, width));
  const yText = (p.fmt ?? fmtIvPt)(linear(yPx, model.yDomain)(y));
  const yw = r1(Math.min(labelPx(yText) + IV_TAG_PAD_Y, width));
  const yRight = range[0] - 1;
  return {
    x,
    y,
    xTag: {
      x: r1(clamp(x - xw / 2, 0, width - xw)),
      y: r1(clamp(height - IV_MARGIN.bottom + 3, 0, height - IV_TAG_H)),
      w: xw,
      h: IV_TAG_H,
      text: xText,
    },
    yTag: {
      x: r1(Math.max(0, yRight - yw)),
      y: r1(clamp(y - IV_TAG_H / 2, 0, height - IV_TAG_H)),
      w: yw,
      h: IV_TAG_H,
      text: yText,
    },
  };
}

/**
 * 十字線の足（#227）: カーソルを四捨五入して端の足で止めた index。カーソルが無い・足 0 本・その足が表示範囲（値の座標の
 * viewport。端ちょうどは内）の外なら null。十字線（縦線・横線・札・浮いた読み取り）と読み取りの行は、どれもこの足が
 * あるときだけカーソルの足を使う（パン・拡大で外へ出たら一緒に外す = 縦線が消えて読み取りだけ残る、を作らない）。
 * 十字線は値の座標に残るので、表示範囲に戻せばまた出る（docs/ui-redesign.md §4.1）
 */
export function ivCursorBar(cursor: number | null, n: number, viewport: Domain): number | null {
  if (cursor === null || n === 0 || !Number.isFinite(cursor)) return null;
  const c = Math.min(Math.max(Math.round(cursor), 0), n - 1);
  return c >= viewport[0] && c <= viewport[1] ? c : null;
}

/** 読み取り・段に渡すカーソル（#227）: 十字線の足（ivCursorBar）が表示範囲の内ならカーソルのまま、外なら null */
export function ivCursorShown(cursor: number | null, n: number, viewport: Domain): number | null {
  return ivCursorBar(cursor, n, viewport) === null ? null : cursor;
}

/**
 * , . のキーで 1 本ずつ読む（#227。価格・段で同じ）: 始点は表示範囲の中の足 = 十字線の足（ivCursorBar）、無い・外なら
 * 表示範囲の右端の足（足の並びの外なら最新の足）。dir = −1（,）/ +1（.）。足 0 本なら null
 */
export function ivKeyStep(
  cursor: number | null,
  n: number,
  viewport: Domain,
  dir: -1 | 1,
): number | null {
  if (n === 0) return null;
  const right = Math.min(Math.max(Math.floor(viewport[1]), 0), n - 1);
  const from = ivCursorBar(cursor, n, viewport) ?? right;
  return Math.min(Math.max(from + dir, 0), n - 1);
}

/** 画素（要素の座標）→ 足の index（範囲の外は端の足） */
export function ivIndexAt(x: number, viewport: Domain, range: Domain, n: number): number | null {
  if (n === 0) return null;
  const span = range[1] - range[0];
  if (!(span > 0)) return null;
  const v = viewport[0] + ((x - range[0]) * (viewport[1] - viewport[0])) / span;
  return Math.min(Math.max(Math.round(v), 0), n - 1);
}

/** ⓘ の操作の説明 */
export const IV_HINT =
  'ドラッグ / 1 本指でパン · ホイール / ピンチで拡大 · ダブルタップ / R で初期表示 · ホバー / タップの十字線で足を読む（交点をドラッグで動かす・ほかの所のタップで消す） · , . で 1 本ずつ';
/** ⓘ のデータの説明 */
export const IV_NOTE =
  'ATM IV（30 日固定）= 期近・次限月の ATM の IV を残存 30 日に補間した値（%。モデルの ATM IV とは別の定義）。表は毎時作り直すので、右端の足は確定前（薄く描く）。読むのは開いたとき・⟳・左右の端へパンしたときだけ（トップバーの [最新] では読み直さない）。欠け（立会中に 30 分以上 / 足 1 本以上の空き）で線を切る。● 今 = 今の板から同じ定義で計算した値（表より新しい板のとき）、┄ シナリオ = 今に Δσ と β の上乗せを適用した水準（今の ATM の行使価格の IV。下げで ATM が下の行使価格へ移る分は含まない）';
/** 描画域の名前（role="application"） */
export const IV_PLOT_LABEL = 'IV 推移のグラフ（矢印でパン・+ − で拡大・, . で足を読む）';
/** 1〜5 の行き先の枠の名前（スマイルのパネルで IV 推移を見せているとき） */
export const IV_FOCUS_LABEL = 'IV 推移の図';

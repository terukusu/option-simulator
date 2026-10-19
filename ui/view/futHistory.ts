/**
 * 先物推移（日経 225 先物のラージ・期近の現在値の足。#190、docs/ui-redesign.md §4.8）の表示モデル（純関数。Preact に
 * 依存しない）。描画・足・欠け・読み込みの規則は IV 推移（ui/view/ivHistory.ts・ivLoad.ts）と同じで、ここは先物だけの
 * もの: 円の書式・限月交代の印・「今」の 1 点・読み取りの限月・文言。
 *
 * - 期近のつなぎ足（調整なし。オーナー決定 2026-10-19）: 線は限月交代でも切らずにつなぐ（値は当時の期近の値のまま。
 *   過去の値の調整 = バックアジャストはしない）。ローソクは交代の足が新しい限月の最初の足になるだけ
 * - 限月交代の印: 交代の足の左（x − 半本）に縦の点線（いつも薄く）と札「12月限」（futRollMarks。見えている範囲だけ。
 *   札は前に出した札から FUT_ROLL_LABEL_GAP_PX 以上離れているときだけ = 日足・広い範囲で混まないよう間引く）
 * - 「今」の 1 点: 今の板の先物の値を、表の最後の行（last_at）より新しく、限月が最後の足と同じときだけ（futNowPoint）。
 *   板の限月は板の JSON の contract_month を使わず、足と同じ規則（取引日以後に取引最終日がある最初の四半期限月）で
 *   スナップショットの時刻から求める
 * - 色は持たない（CSS のクラス名だけ）。値は円の整数（桁区切り）、時刻は JST
 */

import type { ChainJson, FutBar } from '../../data';
import { lastTradingDay } from '../../model';
import { type Domain, linear } from '../chart/scale';
import { fmtNum } from './format';
import {
  IV_HINT,
  type IvNowValue,
  type IvReadout,
  type IvSeries,
  type IvTf,
  isIvTradingDay,
  ivNowPoint,
  ivReadout,
  jstDayIndex,
} from './ivHistory';

/** 円の整数（桁区切り） */
export const fmtYen = (v: number | null | undefined): string => fmtNum(v, 0);

/** 先物推移の系列（縦の目盛りの列は「38,500」が収まる幅） */
export const FUT_SERIES: IvSeries = { fmt: fmtYen, marginLeft: 48 };

/** 限月 YYYY-MM → 札の文字（「12月限」） */
export function futContractLabel(m: string): string {
  return `${Number(m.slice(5, 7))}月限`;
}

/** 限月交代の印（px の x と札の文字。label が null = 札を間引いた = 線だけ） */
export interface FutRollMark {
  x: number;
  label: string | null;
}

/** 札を出す間隔の下限（px。札「12月限」の幅 ≈ 40px + 余白）。これより近い交代は線だけ描く */
export const FUT_ROLL_LABEL_GAP_PX = 56;

/**
 * 限月交代の印: 限月が前の足と違う足ごとに、その足の左（index − 0.5）の x と新しい限月の札。表示範囲（index の
 * viewport）の中の交代だけ。札は左から見て、前に出した札の x から FUT_ROLL_LABEL_GAP_PX 未満なら出さない（線だけ）。
 * range = 描画域の横の画素範囲（ivChartModel の range）
 */
export function futRollMarks(
  bars: readonly FutBar[],
  viewport: Domain,
  range: Domain,
): FutRollMark[] {
  const n = bars.length;
  if (n < 2) return [];
  const sx = linear(viewport, range);
  const i0 = Math.max(1, Math.ceil(viewport[0] + 0.5));
  const i1 = Math.min(n - 1, Math.floor(viewport[1] + 0.5));
  const out: FutRollMark[] = [];
  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (let i = i0; i <= i1; i++) {
    const m = (bars[i] as FutBar).m;
    if (m !== (bars[i - 1] as FutBar).m) {
      const x = Math.round(sx(i - 0.5) * 10) / 10;
      const show = x - lastLabelX >= FUT_ROLL_LABEL_GAP_PX;
      if (show) lastLabelX = x;
      out.push({ x, label: show ? futContractLabel(m) : null });
    }
  }
  return out;
}

const DAY_S = 86400;
const QUARTERS = ['03', '06', '09', '12'] as const;

/**
 * UNIX 秒 t の限月（サーバーの front_contract と同じ規則）: t が属する取引日（17:00 からは次の取引日。土日・休業日は
 * 飛ばす）以後に取引最終日がある最初の四半期限月。holidays は SQ の規則の休業日（カレンダーの全行）
 */
export function futContractAt(
  t: number,
  holidays: ReadonlySet<string>,
  nonTradingDays: ReadonlySet<string>,
): string {
  let d = jstDayIndex(t + 7 * 3600);
  for (let i = 0; i < 30 && !isIvTradingDay(d, nonTradingDays); i++) d++;
  const day = new Date(d * DAY_S * 1000).toISOString().slice(0, 10);
  const y0 = Number(day.slice(0, 4));
  for (let y = y0; y <= y0 + 1; y++) {
    for (const m of QUARTERS) {
      if (lastTradingDay(y, Number(m), holidays) >= day) return `${y}-${m}`;
    }
  }
  return `${y0 + 1}-03`;
}

/** 今の板の先物（「今」の 1 点の値）。t = スナップショットの UNIX 秒、m = その時刻の限月 */
export interface FutNowValue {
  t: number;
  price: number;
  m: string;
}

/** 今の板（板の JSON の future）から「今」の値を作る（値が無ければ null） */
export function futNowValue(
  json: ChainJson,
  holidays: ReadonlySet<string>,
  nonTradingDays: ReadonlySet<string>,
): FutNowValue | null {
  const price = json.future.price;
  if (price === null || !(Number.isFinite(price) && price > 0)) return null;
  const t = Math.floor(Date.parse(json.snapshot_at) / 1000);
  if (!Number.isFinite(t)) return null;
  return { t, price, m: futContractAt(t, holidays, nonTradingDays) };
}

/**
 * 「今」の印の位置（足の index）と値: 表の最後の行（lastAt）より新しい板で、限月が最後の足と同じときだけ。位置の規則は
 * IV 推移の ivNowPoint と同じ（今の足の区間が最後の足と同じならその足、違えば最後の足の右）
 */
export function futNowPoint(
  now: FutNowValue | null,
  bars: readonly FutBar[],
  tf: IvTf,
  lastAt: number | null,
  nonTradingDays: ReadonlySet<string>,
): { index: number; iv: number } | null {
  const last = bars.at(-1);
  if (!now || !last || last.m !== now.m) return null;
  const v: IvNowValue = { t: now.t, iv: now.price, method: 'interp' };
  return ivNowPoint(v, bars, tf, lastAt, nonTradingDays);
}

/** 読み取りの 1 行（始・高・安・終は円の整数）と、その足の限月の札 */
export interface FutReadout extends IvReadout {
  contract: string;
}

export function futReadout(
  bars: readonly FutBar[],
  tf: IvTf,
  cursor: number | null,
  rightLoaded: boolean,
): FutReadout {
  const ro = ivReadout(bars, tf, cursor, rightLoaded, fmtYen);
  const n = bars.length;
  const i = cursor === null ? n - 1 : Math.min(Math.max(Math.round(cursor), 0), n - 1);
  const b = bars[i];
  return { ...ro, contract: b ? futContractLabel(b.m) : '' };
}

/** ⓘ の操作の説明（IV 推移と同じ） */
export const FUT_HINT = IV_HINT;
/** ⓘ のデータの説明 */
export const FUT_NOTE =
  'JPX のページから 1 分ごとに取り込んだ現在値（15 分遅れ）から作った足。1 分ごとのスナップショットから作るので、高値・安値は実際の約定の高値・安値より狭いことがある。期近のつなぎ足（調整なし）: 限月交代（SQ の前日の夜間から次の限月）でも線はつなぎ、値は当時の期近の値のまま（過去の値を調整しない）。限月交代は縦の点線（札が混むときは線だけ）。読むのは開いたとき・⟳・左右の端へパンしたときだけ（トップバーの [最新] では読み直さない）。● 今 = 今の板の先物の値（表より新しい板で、限月が同じとき）';
/** 凡例の系列の名前 */
export const FUT_LEGEND = '日経225 先物';
export const FUT_LEGEND_LONG = '（ラージ・期近・円）';
/** 描画域の名前（role="application"） */
export const FUT_PLOT_LABEL = '先物推移のグラフ（矢印でパン・+ − で拡大・, . で足を読む）';
/** 描画域の svg の名前 */
export const FUT_IMG_LABEL = '日経225 先物（ラージ・期近）の推移（縦軸 円）';
/** 1〜5 の行き先の枠の名前（スマイルのパネルで先物推移を見せているとき） */
export const FUT_FOCUS_LABEL = '先物推移の図';

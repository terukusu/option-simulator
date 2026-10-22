/**
 * スマイルに重ねる「売りの効率」の線の表示モデル（純関数。#163、docs/design.md 11 章・docs/ui-redesign.md §4.1）。
 *
 * - 点: 表示中の限月の行使価格ごと（スマイルの IV がある行）に、状態 S で OTM 側（K < F' は put、それ以外は call。
 *   F' = シナリオの点の限月の原資産）の 1 枚の売りの効率（model/sellEfficiency.ts）。横軸の値はスマイルと同じ axisValue。
 *   決まらない行（呼値未満・満期後など）は点を作らず、線はそこで切る
 * - 状態: シナリオの点（X₀ + ΔX・d・Δσ・Δs。β・動き方・IV の入れ方は今のシナリオ）= 証拠金のタイルと同じ点
 *   （d は呼び出し側が clampScenarioDays で最遠の足の SQ に収めて渡す。#260）。
 *   今 = d = ΔX = Δσ = Δs = 0（marginNow と同じ。このとき β・動き方・IV の入れ方は効かない）。h = 板の時刻 + d から
 *   2 営業日後まで
 * - 縦軸: 効率（%）。0 から、表示範囲の中の点（シナリオの点と今）の最大の 1.15 倍まで。右端に目盛り
 * - 読み取り: 縦線に最も近い点の行使価格の「売り K put · プレミアム · 効率」と「証拠金 · Δ（ラージ・ミニ）」
 */

import type { ChainMonth } from '../../data';
import {
  type AtmBasis,
  businessDaysAhead,
  DAY_MS,
  type Holidays,
  MARGIN_HORIZON_BUSINESS_DAYS,
  type MarginParams,
  type MarketContext,
  type ModelSettings,
  type OptionType,
  type Scenario,
  sellEfficiency,
  underlyingAt,
  ZERO_SCENARIO,
} from '../../model';
import { clipSegment, type Domain, linear, niceTicks } from '../chart/scale';
import { fmtNum, fmtSigned } from './format';
import { axisValue, SMILE_MARGIN, type SmileAxis } from './smile';

/** 効率の線の計算に使う市場・設定（useAppController の smileEffBase） */
export interface SmileEffBase {
  ctx: MarketContext;
  settings: ModelSettings;
  params: MarginParams;
  holidays: Holidays;
}

export interface SmileEffPoint {
  k: number;
  /** 限月の行（month.strikes）の位置。隣の行でなければ線を切る */
  i: number;
  /** 横軸の値（スマイルの axisValue） */
  x: number;
  type: OptionType;
  /** プレミアム（円。乗数前） */
  premium: number;
  /** 必要証拠金（概算、円） */
  margin: number;
  /** 効率（%） */
  eff: number;
  deltaLarge: number;
  deltaMini: number;
}

const finite0 = (v: number) => (Number.isFinite(v) ? v : 0);

/**
 * 今のシナリオ（d = ΔX = Δσ = Δs = 0。marginNow と同じ）。このとき β（ΔX = 0）・動き方（F' = F）・IV の入れ方（Δσ = 0）は
 * 価格にも証拠金の格子にも効かないので、今の線はシナリオに依らない
 */
export const EFF_NOW_SCENARIO: Scenario = ZERO_SCENARIO;

/** シナリオの点が今か（d・ΔX・Δσ・Δs が全部 0） */
export function effAtNow(s: Scenario): boolean {
  return (
    finite0(s.days) === 0 && finite0(s.dX) === 0 && finite0(s.dSigma) === 0 && finite0(s.skew) === 0
  );
}

/** 限月の行使価格ごとの効率の点（K の昇順。決まらない行は飛ばす） */
export function smileEffPoints(
  month: ChainMonth,
  basis: AtmBasis,
  axis: SmileAxis,
  base: SmileEffBase,
  scenario: Scenario,
): SmileEffPoint[] {
  const { ctx, settings, params, holidays } = base;
  const days = Math.max(0, finite0(scenario.days));
  const dX = finite0(scenario.dX);
  const x = ctx.x0 + dX;
  if (!(x > 0) || !Number.isFinite(x)) return [];
  const sc: Scenario = { ...scenario, days, dX };
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  // OTM 側は状態 S の限月の原資産 F' で決める（今の F のままだと ΔX で ITM になった売りが線の山になる）
  const Fp = underlyingAt(month.F, ctx.x0, x, settings.basisMode);
  if (!Number.isFinite(Fp)) return [];
  const out: SmileEffPoint[] = [];
  for (let i = 0; i < month.strikes.length; i++) {
    const s = month.strikes[i] as ChainMonth['strikes'][number];
    if (s.smileIv === null) continue;
    const type: OptionType = s.k < Fp ? 'put' : 'call';
    const ax = axisValue(month, basis, axis, s);
    if (ax === null || !Number.isFinite(ax)) continue;
    const r = sellEfficiency(
      {
        expiry: month.id,
        strike: s.k,
        type,
        sigma: s.smileIv,
        x,
        scenario: sc,
        horizonDays,
      },
      ctx,
      settings,
      params,
    );
    if (!r) continue;
    out.push({
      k: s.k,
      i,
      x: ax,
      type,
      premium: r.premium,
      margin: r.margin,
      eff: r.efficiency * 100,
      deltaLarge: r.deltaLarge,
      deltaMini: r.deltaMini,
    });
  }
  return out;
}

/** 縦軸の上端の倍率（表示範囲の最大から） */
export const EFF_TOP_RATIO = 1.15;

/**
 * 縦軸（効率 %）の範囲: 0 〜 表示範囲の中の点の最大 × 1.15（今の線も含める）。点が無い・最大が 0 以下なら null
 */
export function smileEffYDomain(
  lines: ReadonlyArray<readonly SmileEffPoint[] | null>,
  domain: Domain,
): Domain | null {
  const [lo, hi] = domain;
  let max = 0;
  for (const pts of lines) {
    if (!pts) continue;
    for (const p of pts) if (p.x >= lo && p.x <= hi && p.eff > max) max = p.eff;
  }
  return max > 0 ? [0, max * EFF_TOP_RATIO] : null;
}

/** 右端の目盛り（0 を除く 2〜3 本） */
export function smileEffTicks(yDomain: Domain): number[] {
  return niceTicks(yDomain[0], yDomain[1], 3).filter((t) => t > 0 && t <= yDomain[1]);
}

/** 右端の目盛りを描画域の右端の内側に置く幅（px。右の余白 22px には 4 文字の % が入らないため内側に右寄せ・縁取り） */
export const EFF_TICK_INSET_PX = 3;
/** 目盛りを読み取りの行から離す距離（px） */
export const EFF_TICK_CLEAR_PX = 8;

/**
 * 右寄せの読み取り（縦線が左側のとき）と重なる目盛りを外す（読み取りの各行の y から EFF_TICK_CLEAR_PX 未満）。
 * 読み取りが左寄せ・十字線が無いときは readYs を空で渡す
 */
export function effTicksClear<T extends { y: number }>(
  ticks: readonly T[],
  readYs: readonly number[],
): T[] {
  return ticks.filter((t) => readYs.every((y) => Math.abs(t.y - y) >= EFF_TICK_CLEAR_PX));
}

/** 目盛りの文字（整数の %。10 未満で刻みが細かいときは小数 1 桁） */
export function effTickLabel(v: number): string {
  const whole = Math.abs(v - Math.round(v)) < 1e-9;
  return `${fmtNum(v, whole ? 0 : 1)}%`;
}

/** 点を結ぶ線の path（横軸の表示範囲で切る。隣の行どうしだけを結ぶ = 点の無い行で切る） */
export function smileEffPath(
  pts: readonly SmileEffPoint[],
  domain: Domain,
  yDomain: Domain,
  width: number,
  height: number,
): string {
  const M = SMILE_MARGIN;
  const sx = linear(domain, [M.left, width - M.right]);
  const sy = linear(yDomain, [height - M.bottom, M.top]);
  let d = '';
  let last: [number, number] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as SmileEffPoint;
    const b = pts[i] as SmileEffPoint;
    if (b.i !== a.i + 1) {
      last = null;
      continue;
    }
    const c = clipSegment(a.x, a.eff, b.x, b.eff, domain[0], domain[1]);
    if (!c) {
      last = null;
      continue;
    }
    const x1 = sx(c[0]).toFixed(1);
    const y1 = sy(c[1]).toFixed(1);
    const x2 = sx(c[2]).toFixed(1);
    const y2 = sy(c[3]).toFixed(1);
    if (!last || last[0] !== c[0] || last[1] !== c[1]) d += `M${x1} ${y1}`;
    d += `L${x2} ${y2}`;
    last = [c[2], c[3]];
  }
  return d;
}

/** 縦線の横軸の値 x に最も近い点（表示範囲の中。無ければ null） */
export function smileEffNearest(
  pts: readonly SmileEffPoint[],
  x: number,
  domain: Domain,
): SmileEffPoint | null {
  if (!Number.isFinite(x)) return null;
  let best: SmileEffPoint | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of pts) {
    if (p.x < domain[0] || p.x > domain[1]) continue;
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** プレミアムの文字（100 円以上は整数、未満は小数 1 桁） */
function fmtPremium(v: number): string {
  return `${fmtNum(v, v >= 100 ? 0 : 1)} 円`;
}

/** 読み取りの 2 行（最寄りの点の売り。#163） */
export function smileEffReadLines(p: SmileEffPoint): [string, string] {
  return [
    `売り ${fmtNum(p.k, 0)} ${p.type} ${fmtPremium(p.premium)} · 効率 ${fmtNum(p.eff, 1)}%`,
    `証拠金 ${fmtNum(p.margin, 0)} 円 · Δ ${fmtSigned(p.deltaLarge, 2)}（ミニ ${fmtSigned(p.deltaMini, 1)}）`,
  ];
}

/** 読み取りの行の間隔（px） */
export const EFF_READ_LINE_PX = 13;

/**
 * 読み取りの行の y（今の 1 行 + 足す n 行。上から順）。今の読み取りの y0 が上端なら 1 行目を y0 に置いて下へ、下端
 * （タッチで交点をつかみ指が上側）なら最後の行を y0 に置いて上へ積む
 */
export function effReadYs(y0: number, height: number, n: number): number[] {
  const start = y0 > height / 2 ? y0 - n * EFF_READ_LINE_PX : y0;
  return Array.from({ length: n + 1 }, (_, i) => start + i * EFF_READ_LINE_PX);
}

/** ⓘ の説明（効率の定義と注意の 1 行） */
export const SMILE_EFF_HINT =
  '[効率] = 売りの効率の線: 行使価格ごとに OTM 側を 1 枚売ったときの「受け取るプレミアム ÷ 必要証拠金（概算）」（右の目盛り %）。シナリオの点（d・ΔX・Δσ・Δs）で計算し、シナリオの点が今でなければ今の線を薄く重ねる。Δσ を上げると線がどう動くかを見る。十字線で最寄りの行使価格のプレミアム・証拠金・効率・Δ を読む';

/** 注意の 1 行（効率は損失の大きさを表さない） */
export const SMILE_EFF_CAUTION =
  '効率は損失の大きさを表さない: ATM に近い売りは値動きの損失が大きく、遠い OTM の売りは受取が小さいわりに急落で損失と証拠金が何倍にもなりうる。テール表・追証マップと合わせて見る';

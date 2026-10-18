/**
 * 証拠金の概算（#131。設計 docs/design.md 5.10）の画面側の計算の単位（純関数。DOM・時計を読まない）。
 *
 * - 計算は model/margin.ts の marginAt・marginRoom・maxMultiple をそのまま使う（新しい式を作らない）
 * - 状態: 今 = X₀・d = Δσ = Δs = 0（β・動き方・IV の入れ方は今のシナリオのまま）/ シナリオの点 = X₀ + ΔX /
 *   テールの各行 = X₀ × (1 + 下落率)（ΔX 以外はシナリオのまま）。d は損益グラフ・指標と同じく clampDays
 * - h（保有期間の暦日）= S の時点（板の時刻 + d）から 2 営業日後まで（businessDaysAhead。休業日は引数）
 * - 原資産・評価が有限でなければ null（表示は「—」。model は検証済みの値を受ける前提のため、ここで止める）
 * - memo の単位（useAppController）: 今 = 足・板・設定・β / 動き方 / IV の入れ方、シナリオの点 = シナリオ、
 *   テール = ΔX 以外のシナリオ。どれも資金・パラメータ（端末の設定）が変われば作り直す
 *
 * 文字列（タイル・内訳・表）は ui/view/metricsPanel.ts が作る。
 */

import {
  businessDaysAhead,
  DAY_MS,
  type Holidays,
  MARGIN_HORIZON_BUSINESS_DAYS,
  MARGIN_LINE_SAMPLES,
  type MarginParams,
  type MarginResult,
  marginAt,
  marginCallLevels,
  marginRoom,
  maxMultiple,
  premiumSummary,
  type Scenario,
  TAIL_SHOCKS,
} from '../../model';
import { PIN_SETTLE_MS } from '../pins';
import type { MarginPrefs } from '../prefs';
import { clampDays, type PnlBase } from './pnlChart';
import { DX_ABS_MAX, DX_INPUT_MAX_RATIO, DX_INPUT_MIN_RATIO } from './scenario';

/** 端末の設定（% と pt）→ model の単位（小数・倍率） */
export function marginParamsOf(m: MarginPrefs): MarginParams {
  return {
    range: m.rangePct / 100,
    ivUpPt: m.ivUpPt,
    ivDownPt: m.ivDownPt,
    factor: m.factorPct / 100,
  };
}

/** 資金（円）。未設定・0・不正は null */
export function capitalOf(m: MarginPrefs): number | null {
  const c = m.capitalYen;
  return c !== null && Number.isFinite(c) && c > 0 ? c : null;
}

export interface MarginCalc {
  /** 基準原資産 X_S（円） */
  x: number;
  result: MarginResult;
  /** 余力（円）。資金が未設定なら null */
  room: number | null;
  /** 今のポジションの何倍まで余力 ≥ 0 か（Infinity = 上限なし、資金が未設定なら null） */
  multiple: number | null;
}

export interface MarginTailRow {
  shock: number;
  /** X₀ × (1 + 下落率) */
  x: number;
  calc: MarginCalc | null;
}

/** 指標パネル（タイル・内訳・テールの証拠金の表）に渡す形 */
export interface MarginView {
  capital: number | null;
  params: MarginParams;
  now: MarginCalc | null;
  point: MarginCalc | null;
  tail: MarginTailRow[];
}

const finite = (r: MarginResult) =>
  Number.isFinite(r.pfe) &&
  Number.isFinite(r.nov) &&
  Number.isFinite(r.margin) &&
  Number.isFinite(r.futuresPnl) &&
  Number.isFinite(r.settledCash);

/** 状態 S = (x, scenario) の必要証拠金・余力・倍数。x・結果が有限でなければ null */
export function marginCalc(
  base: PnlBase,
  x: number,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): MarginCalc | null {
  if (!Number.isFinite(x) || x <= 0) return null;
  const { legs, ctx, settings } = base;
  const { days } = clampDays(scenario, base.maxDays);
  const sc: Scenario = { ...scenario, days, dX: x - ctx.x0 };
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  const result = marginAt(legs, { x, scenario: sc, horizonDays }, ctx, settings, params);
  if (!finite(result)) return null;
  if (capital === null) return { x, result, room: null, multiple: null };
  const premium = premiumSummary(legs, settings);
  const room = marginRoom(capital, premium, result);
  return {
    x,
    result,
    room: Number.isFinite(room) ? room : null,
    multiple: maxMultiple(capital, premium, result),
  };
}

/** 今（X₀・d = Δσ = Δs = 0。β・動き方・IV の入れ方は今のシナリオのまま） */
export function marginNow(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): MarginCalc | null {
  const sc: Scenario = { ...scenario, days: 0, dX: 0, dSigma: 0, skew: 0 };
  return marginCalc(base, base.ctx.x0, sc, params, capital, holidays);
}

/** シナリオの点（X₀ + ΔX。指標の「指定日 + シナリオ」と同じ点） */
export function marginPoint(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): MarginCalc | null {
  const dX = Number.isFinite(scenario.dX) ? scenario.dX : 0;
  return marginCalc(base, base.ctx.x0 + dX, scenario, params, capital, holidays);
}

/** テール表の各行（X₀ × (1 + 下落率)。ΔX 以外はシナリオのまま。テール表と同じ行） */
export function marginTail(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  shocks: readonly number[] = TAIL_SHOCKS,
): MarginTailRow[] {
  return shocks.map((shock) => {
    const x = base.ctx.x0 * (1 + shock);
    return { shock, x, calc: marginCalc(base, x, scenario, params, capital, holidays) };
  });
}

/** 追証の線: 連続の操作が止まってから作るまでの時間（ms。ピンの線の描き直しの PIN_SETTLE_MS と同じ） */
export const MARGIN_LINE_SETTLE_MS = PIN_SETTLE_MS;
/** 追証の線: 板の全域の外（ΔX の数値欄で行ける範囲）の片側の分割数（行使価格が無く余力が滑らかな側） */
export const MARGIN_LINE_OUTER_SAMPLES = 8;

/**
 * 追証の線の探索範囲（#144 と揃える）: 板の全域（boardFull。分割 MARGIN_LINE_SAMPLES）と、その外で ΔX の数値欄
 * （−99%〜+900%、上限 1e6 円）が届く範囲（片側 MARGIN_LINE_OUTER_SAMPLES）。全域はシナリオ点で広がるが（scenarioFull）、
 * 線の範囲は ΔX に依らない（ΔX で作り直さない）。下端は xLo と 0.01X₀ の大きい方（X > 0）
 */
export function marginLineRanges(
  base: PnlBase,
): Array<{ lo: number; hi: number; samples: number }> {
  const x0 = base.ctx.x0;
  const [bLo, bHi] = base.boardFull;
  const out: Array<{ lo: number; hi: number; samples: number }> = [];
  const lo = Math.max(base.xLo, (1 + DX_INPUT_MIN_RATIO) * x0);
  const hi = x0 + Math.min(DX_INPUT_MAX_RATIO * x0, DX_ABS_MAX);
  if (lo < bLo) out.push({ lo, hi: bLo, samples: MARGIN_LINE_OUTER_SAMPLES });
  out.push({ lo: Math.max(bLo, lo), hi: bHi, samples: MARGIN_LINE_SAMPLES });
  if (hi > bHi) out.push({ lo: bHi, hi, samples: MARGIN_LINE_OUTER_SAMPLES });
  return out.filter((r) => Number.isFinite(r.lo) && Number.isFinite(r.hi) && r.lo < r.hi);
}

/**
 * 追証の線の X（円、1 円に丸め、昇順・重複なし）。scenario は ΔX 以外のシナリオ（ΔX は見ない）、d は clampDays。
 * 資金が未設定・余力がどこでも正・評価が有限でない点は線にしない（[]）
 */
export function marginLine(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): number[] {
  if (capital === null) return [];
  const { legs, ctx, settings } = base;
  const { days } = clampDays(scenario, base.maxDays);
  const sc: Scenario = { ...scenario, days, dX: 0 };
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  const premium = premiumSummary(legs, settings);
  const xs = new Set<number>();
  for (const r of marginLineRanges(base)) {
    const found = marginCallLevels(
      legs,
      sc,
      ctx,
      settings,
      params,
      horizonDays,
      capital,
      premium,
      r,
      r.samples,
    );
    for (const x of found) if (Number.isFinite(x)) xs.add(x);
  }
  return [...xs].sort((a, b) => a - b);
}

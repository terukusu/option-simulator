/**
 * 証拠金の概算（#131。設計 docs/design.md 5.10）の画面側の計算の単位（純関数。DOM・時計を読まない）。
 *
 * - 計算は model/margin.ts の marginAt・marginRoom・maxMultiple をそのまま使う（新しい式を作らない）
 * - 状態: 今 = X₀・d = Δσ = Δs = 0（β・動き方・IV の入れ方は今のシナリオのまま）/ シナリオの点 = X₀ + ΔX /
 *   テールの各行 = X₀ × (1 + 下落率)（ΔX 以外はシナリオのまま）。d は損益グラフ・指標と同じく clampDays
 * - h（保有期間の暦日）= S の時点（板の時刻 + d）から 2 営業日後まで（businessDaysAhead。休業日は引数）
 * - 値洗い（marginMarked）= 板の時刻から S（板の時刻 + d）までに営業日の 15:45 をまたいだか（休業日は h と同じ）。
 *   またいだら余力に先物の評価益も入る（#381）。今（d = 0）はまたがない
 * - 今の必要証拠金は JSCC の計算（#382。model/margin.ts の marginNowJscc。基準日の JSCC の VaR パラメータが読めて、
 *   M の足がそろっていれば）。できなければ格子の概算に戻し、理由を MarginCalc.basis に持つ。シナリオの点が今と同じ
 *   （marginPointAt の 4 つとも 0）なら今の結果をそのまま使う（marginPointOrNow）
 * - それ以外の点・テール・線は、当て直しの r・g（#387。JsccFactorsInput）が読めれば JSCC のシナリオの当て直し
 *   （model/jsccRefit.ts。basis = jscc_refit）、読めない・当て直せなければ格子の概算 + 理由。テール・線は生成器
 *   （1 回の yield = 状態 1 つ）で、画面は操作が止まってから切れごとに回す（useMarginLine）
 * - 原資産・評価が有限でなければ null（表示は「—」。model は検証済みの値を受ける前提のため、ここで止める）
 * - memo の単位（useAppController）: 今 = 足・板・設定・β / 動き方 / IV の入れ方、シナリオの点 = シナリオ、
 *   テール = ΔX 以外のシナリオ。どれも資金・パラメータ（端末の設定）が変われば作り直す
 *
 * 文字列（タイル・内訳・表）は ui/view/metricsPanel.ts が作る。
 */

import type { JsccFactorsInput, JsccFetchReason, JsccInput } from '../../data/jscc';
import {
  businessDaysAhead,
  DAY_MS,
  drainSteps,
  gridRoomEvaluator,
  type Holidays,
  type JsccIneligible,
  jsccEligibility,
  jsccRefitPlan,
  jsccRefitRoomEvaluator,
  MARGIN_HORIZON_BUSINESS_DAYS,
  MARGIN_LINE_SAMPLES,
  type MarginParams,
  type MarginResult,
  marginAt,
  marginAtJsccRefit,
  marginCallLevelsSteps,
  marginMarked,
  marginNowJscc,
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

/** 端末の設定（%）→ model の単位（小数・倍率） */
export function marginParamsOf(m: MarginPrefs): MarginParams {
  return {
    range: m.rangePct / 100,
    ivUp: m.ivUpPct / 100,
    ivDown: m.ivDownPct / 100,
    factor: m.factorPct / 100,
    ignoreLongOptions: m.ignoreLongOptions,
  };
}

/**
 * marginParamsOf の参照を保つ版（#180）: 計算に使う項目（掛け目・幅・IV の上げ / 下げ・買いの OP）が prev と同じなら
 * prev をそのまま返す。資金・許容損失など計算のパラメータでない項目だけを変えても、証拠金・追証マップの入力の参照が
 * 変わらない（= 作り直さない）
 */
export function marginParamsKeep(prev: MarginParams | null, m: MarginPrefs): MarginParams {
  const next = marginParamsOf(m);
  // 全項目を比べる（MarginParams に項目が増えても漏れない）
  const keys = Object.keys(next) as (keyof MarginParams)[];
  if (prev && keys.every((k) => prev[k] === next[k])) return prev;
  return next;
}

/** 資金（円）。未設定・0・不正は null */
export function capitalOf(m: MarginPrefs): number | null {
  const c = m.capitalYen;
  return c !== null && Number.isFinite(c) && c > 0 ? c : null;
}

/** 許容損失（円。追証マップの 2 本目の境目。#180）。未設定・0・不正（古い保存でキーが無い = undefined も）は null */
export function allowedLossOf(m: MarginPrefs): number | null {
  const v = m.allowedLossYen;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** JSCC の計算にできない理由（読み込み + model。none = M の足が無い = 0 円で、印を付けない） */
export type JsccReason = JsccFetchReason | JsccIneligible;

/**
 * 必要証拠金の出どころ（#382）: jscc = JSCC の計算（基準日）、estimate = 格子の概算（reason = 今を JSCC にできなかった
 * 理由。今以外の点・JSCC の入力を渡さない呼び出しは null）
 */
export type MarginBasis =
  | { kind: 'jscc'; businessDate: string }
  | { kind: 'jscc_refit'; businessDate: string }
  | { kind: 'estimate'; reason: JsccReason | null };

const ESTIMATE: MarginBasis = { kind: 'estimate', reason: null };

export interface MarginCalc {
  /** 基準原資産 X_S（円） */
  x: number;
  result: MarginResult;
  basis: MarginBasis;
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

/**
 * シナリオの点の印（#164）の数。d = clampDays、ΔX・Δσ・Δs は有限でなければ 0（marginPoint・metricsModel と同じ扱い）、
 * dXPct = ΔX / X₀ × 100。「今」（marginNow）の条件 = 4 つとも 0
 */
export interface MarginPointAt {
  days: number;
  dX: number;
  dXPct: number;
  dSigma: number;
  /** Δσ の単位（IV の動かし方が relative なら %、absolute なら pt） */
  dSigmaUnit: 'pt' | '%';
  skew: number;
}

/** 指標パネル（タイル・内訳・テールの証拠金の表）に渡す形 */
export interface MarginView {
  capital: number | null;
  params: MarginParams;
  now: MarginCalc | null;
  point: MarginCalc | null;
  /** シナリオの点の位置（タイルの見出しの印・内訳のシナリオ点の行。#164） */
  at: MarginPointAt;
  tail: MarginTailRow[];
  /** テールを作っている間（操作が止まるのを待つ・切れごとに回している。前の行を「計算中…」で出す。#387） */
  tailBusy?: boolean;
  /**
   * 今の状態を当て直した値（#387。今が JSCC の正確な値で r・g があるときだけ。今のすぐ隣の点との跳びの大きさを内訳で
   * 見せる。補正はしない）
   */
  nowRefit?: MarginCalc | null;
}

const finiteOr0 = (v: number) => (Number.isFinite(v) ? v : 0);

/** シナリオの点の位置（#164。今 = 4 つとも 0） */
export function marginPointAt(base: PnlBase, scenario: Scenario): MarginPointAt {
  const days = finiteOr0(clampDays(scenario, base.maxDays).days);
  const dX = finiteOr0(scenario.dX);
  const x0 = base.ctx.x0;
  const dXPct = Number.isFinite(x0) && x0 > 0 ? (dX / x0) * 100 : 0;
  return {
    days,
    dX,
    dXPct,
    dSigma: finiteOr0(scenario.dSigma),
    dSigmaUnit: scenario.ivShift === 'relative' ? '%' : 'pt',
    skew: finiteOr0(scenario.skew),
  };
}

const finite = (r: MarginResult) =>
  Number.isFinite(r.pfe) &&
  Number.isFinite(r.nov) &&
  Number.isFinite(r.margin) &&
  Number.isFinite(r.requirement) &&
  Number.isFinite(r.futuresPnl) &&
  Number.isFinite(r.settledCash);

interface MarginStateAt {
  sc: Scenario;
  horizonDays: number;
  marked: boolean;
}

function stateAt(base: PnlBase, x: number, scenario: Scenario, holidays: Holidays): MarginStateAt {
  const { ctx } = base;
  const { days } = clampDays(scenario, base.maxDays);
  const sc: Scenario = { ...scenario, days, dX: x - ctx.x0 };
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  return { sc, horizonDays, marked: marginMarked(ctx.evalTime, days, holidays) };
}

function calcOf(
  base: PnlBase,
  x: number,
  result: MarginResult,
  capital: number | null,
  basis: MarginBasis,
): MarginCalc | null {
  if (!finite(result)) return null;
  if (capital === null) return { x, result, basis, room: null, multiple: null };
  const premium = premiumSummary(base.legs, base.settings);
  const room = marginRoom(capital, premium, result);
  return {
    x,
    result,
    basis,
    room: Number.isFinite(room) ? room : null,
    multiple: maxMultiple(capital, premium, result),
  };
}

/** 状態 S = (x, scenario) の必要証拠金（格子の概算）・余力・倍数。x・結果が有限でなければ null */
export function marginCalc(
  base: PnlBase,
  x: number,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  basis: MarginBasis = ESTIMATE,
): MarginCalc | null {
  if (!Number.isFinite(x) || x <= 0) return null;
  const { legs, ctx, settings } = base;
  const { sc, horizonDays, marked } = stateAt(base, x, scenario, holidays);
  const result = marginAt(legs, { x, scenario: sc, horizonDays, marked }, ctx, settings, params);
  return calcOf(base, x, result, capital, basis);
}

/**
 * 状態 S = (x, scenario) の必要証拠金を、r・g があれば JSCC のシナリオの当て直しで（#387）、無い・当て直せなければ格子の
 * 概算 + 理由。factors = null（入力なし = AI の提案・形のカードなど）は今までどおりの格子（理由 null）
 */
export function marginCalcAt(
  base: PnlBase,
  x: number,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  factors: JsccFactorsInput | null,
): MarginCalc | null {
  if (factors === null) return marginCalc(base, x, scenario, params, capital, holidays);
  if (!Number.isFinite(x) || x <= 0) return null;
  if (factors.status !== 'ok') {
    return marginCalc(base, x, scenario, params, capital, holidays, {
      kind: 'estimate',
      reason: factors.reason,
    });
  }
  const { legs, ctx, settings } = base;
  const { sc, horizonDays, marked } = stateAt(base, x, scenario, holidays);
  const state = { x, scenario: sc, horizonDays, marked };
  try {
    const r = marginAtJsccRefit(legs, state, ctx, settings, params, factors.data);
    if (r) {
      return calcOf(base, x, r.result, capital, {
        kind: 'jscc_refit',
        businessDate: factors.data.businessDate,
      });
    }
  } catch {
    // 検証済みの応答では起きない（安全な整数を越える和など）。画面を落とさず概算に戻す
    return marginCalc(base, x, scenario, params, capital, holidays, {
      kind: 'estimate',
      reason: 'error',
    });
  }
  const plan = jsccRefitPlan(legs, state, ctx, settings, params, factors.data);
  const reason: JsccReason = plan.ok ? 'missing' : plan.reason;
  return marginCalc(base, x, scenario, params, capital, holidays, { kind: 'estimate', reason });
}

/**
 * 今の状態（marginNow と同じ状態）を当て直した値（#387）。今が JSCC の正確な値で r・g があるときだけ（無ければ null）。
 * 内訳の「今を当て直すと」の行（今のすぐ隣の点との跳びの大きさ）
 */
export function marginNowRefit(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  now: MarginCalc | null,
  factors: JsccFactorsInput | null,
): MarginCalc | null {
  if (now?.basis.kind !== 'jscc' || factors?.status !== 'ok') return null;
  const sc0: Scenario = { ...scenario, days: 0, dX: 0, dSigma: 0, skew: 0 };
  const c = marginCalcAt(base, base.ctx.x0, sc0, params, capital, holidays, factors);
  return c?.basis.kind === 'jscc_refit' ? c : null;
}

/**
 * 今（X₀・d = Δσ = Δs = 0。β・動き方・IV の入れ方は今のシナリオのまま）。jscc を渡せば JSCC の計算（#382）を試し、
 * できなければ格子の概算 + 理由（basis）。jscc を渡さない呼び出し（AI の提案・テンプレートの形）は格子の概算（理由 null）
 */
export function marginNow(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  jscc: JsccInput | null = null,
): MarginCalc | null {
  const sc0: Scenario = { ...scenario, days: 0, dX: 0, dSigma: 0, skew: 0 };
  const x = base.ctx.x0;
  if (jscc === null) return marginCalc(base, x, sc0, params, capital, holidays);
  if (!Number.isFinite(x) || x <= 0) return null;
  if (jscc.status !== 'ok') {
    return marginCalc(base, x, sc0, params, capital, holidays, {
      kind: 'estimate',
      reason: jscc.reason,
    });
  }
  const { legs, ctx, settings } = base;
  const { sc, horizonDays, marked } = stateAt(base, x, sc0, holidays);
  const state = { x, scenario: sc, horizonDays, marked };
  let r: MarginResult | null;
  try {
    r = marginNowJscc(legs, state, ctx, settings, params, jscc.data);
  } catch {
    // 検証済みの応答では起きない（安全な整数を越える和・本数の違いなど）。memo の中で投げて画面を落とさない
    return marginCalc(base, x, sc0, params, capital, holidays, {
      kind: 'estimate',
      reason: 'error',
    });
  }
  if (r !== null) {
    return calcOf(base, x, r, capital, { kind: 'jscc', businessDate: jscc.data.businessDate });
  }
  const e = jsccEligibility(legs, state, ctx, settings, params, jscc.data);
  const reason: JsccReason = e.ok ? 'missing' : e.reason;
  return marginCalc(base, x, sc0, params, capital, holidays, { kind: 'estimate', reason });
}

/** シナリオの点が今と同じ（marginPointAt の 4 つとも 0）か */
export function isNowPoint(at: MarginPointAt): boolean {
  return at.days === 0 && at.dX === 0 && at.dSigma === 0 && at.skew === 0;
}

/**
 * シナリオの点の必要証拠金。点が今と同じなら now（今の結果）をそのまま返す（タイルの値と副題を一致させる。#382）、
 * そうでなければ marginPoint（格子の概算）
 */
export function marginPointOrNow(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  now: MarginCalc | null,
  factors: JsccFactorsInput | null = null,
): MarginCalc | null {
  if (isNowPoint(marginPointAt(base, scenario))) return now;
  return marginPoint(base, scenario, params, capital, holidays, factors);
}

/** シナリオの点（X₀ + ΔX。指標の「指定日 + シナリオ」と同じ点）。factors があれば当て直し（#387） */
export function marginPoint(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  factors: JsccFactorsInput | null = null,
): MarginCalc | null {
  const dX = Number.isFinite(scenario.dX) ? scenario.dX : 0;
  return marginCalcAt(base, base.ctx.x0 + dX, scenario, params, capital, holidays, factors);
}

/** テール表の各行（X₀ × (1 + 下落率)。ΔX 以外はシナリオのまま。テール表と同じ行） */
export function marginTail(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  shocks: readonly number[] = TAIL_SHOCKS,
  factors: JsccFactorsInput | null = null,
): MarginTailRow[] {
  return drainSteps(marginTailSteps(base, scenario, params, capital, holidays, shocks, factors));
}

/** marginTail の生成器版（1 行 = 状態 1 つごとに yield。#387） */
export function* marginTailSteps(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  shocks: readonly number[] = TAIL_SHOCKS,
  factors: JsccFactorsInput | null = null,
): Generator<void, MarginTailRow[], void> {
  const out: MarginTailRow[] = [];
  for (const shock of shocks) {
    const x = base.ctx.x0 * (1 + shock);
    out.push({
      shock,
      x,
      calc: marginCalcAt(base, x, scenario, params, capital, holidays, factors),
    });
    yield;
  }
  return out;
}

/** 追証の線の入力（useMarginLine・保有ポジションの一覧の合計。#302） */
export interface MarginLineInput {
  base: PnlBase;
  /** ΔX 以外のシナリオ（ΔX は見ない） */
  scenario: Scenario;
  params: MarginParams;
  capital: number;
  holidays: Holidays;
  /** 当て直しの r・g（#387。null = 格子） */
  factors?: JsccFactorsInput | null;
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
 * 資金が未設定・余力がどこでも正・評価が有限でない点は線にしない（[]）。factors が ok で今の状態で当て直せれば
 * 当て直しの余力（裾の候補で絞った二分法。結果は全シナリオと同じ。#387）、そうでなければ格子
 */
export function marginLine(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  factors: JsccFactorsInput | null = null,
): number[] {
  return drainSteps(marginLineSteps(base, scenario, params, capital, holidays, factors));
}

/** marginLine の生成器版（1 回の yield = 状態 1 つの評価。画面は切れごとに回す。#387） */
export function* marginLineSteps(
  base: PnlBase,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
  factors: JsccFactorsInput | null = null,
): Generator<void, number[], void> {
  if (capital === null || !Number.isFinite(capital) || capital <= 0) return [];
  const { legs, ctx, settings } = base;
  const { days } = clampDays(scenario, base.maxDays);
  const sc: Scenario = { ...scenario, days, dX: 0 };
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  const marked = marginMarked(ctx.evalTime, days, holidays);
  const premium = premiumSummary(legs, settings);
  const refit =
    factors?.status === 'ok' &&
    jsccRefitPlan(
      legs,
      { x: ctx.x0, scenario: sc, horizonDays, marked },
      ctx,
      settings,
      params,
      factors.data,
    ).ok;
  const ev = refit
    ? jsccRefitRoomEvaluator(
        legs,
        sc,
        ctx,
        settings,
        params,
        horizonDays,
        marked,
        capital,
        premium,
        factors.data,
      )
    : gridRoomEvaluator(legs, sc, ctx, settings, params, horizonDays, marked, capital, premium);
  const xs = new Set<number>();
  for (const r of marginLineRanges(base)) {
    const found = yield* marginCallLevelsSteps(legs, sc, ctx, settings, marked, ev, r, r.samples);
    for (const x of found) if (Number.isFinite(x)) xs.add(x);
  }
  return [...xs].sort((a, b) => a - b);
}

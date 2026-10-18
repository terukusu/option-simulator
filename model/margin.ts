/**
 * 証拠金の概算（格子の最悪値・掛け目）。設計 docs/design.md 5.10。
 *
 * JSCC の VaR 証拠金（HS-ES）の再現ではなく、保守寄りの概算:
 *
 * - 状態 S = (x_S, シナリオ)。格子 = 原資産 x_S × (1 + s·R)（s ∈ MARGIN_PRICE_STEPS）
 *   × IV の平行移動 {+ivUpPt, 0, −ivDownPt}（pt）× 経過 {0, h}（h = S から 2 営業日後までの暦日）
 * - 評価は legValue（Black-76 + シナリオ IV の式 5.4。β 込み）だけ。IV の平行移動は足の σ_base を
 *   x ↦ σ_base(x) + δ に包んで入れる（relative モードでも式を通した後の差がちょうど pt）
 * - M の足 = 生きている足のうち、ignoreLongOptions なら売りの OP と先物だけ（買いの OP で減らさない。
 *   証券会社の扱い。#149）、そうでなければ全部（JSCC の形）
 * - V(S) = Σ_M の足 符号 × 枚数 × 乗数 × 評価価格（建値・手数料を含まない）
 * - PFE = max(0, max_格子 (V(S) − V(格子)))、NOV = Σ_M の足のうち OP 符号 × 枚数 × 乗数 × 評価価格
 * - 必要証拠金 M = k × max(0, PFE − NOV)
 * - 余力 A = 資金 − 支払 + 受取 − 手数料（全足）+ 先物の評価損益（生きている足）+ 決済済みの足の清算額 − M
 *
 * 生きている足 = S の時点で T > 0 の足。S で SQ を過ぎた足は格子・NOV に入れず、清算額だけを余力に入れる
 * （OP は 符号 × 枚数 × 乗数 × 本源的価値、先物は 符号 × 枚数 × 乗数 × (F' − 建値)、F' = X'）。
 * F が決まらない足（no_forward）は入れない。h・休業日・現在時刻は呼び出し側が決めて渡す。
 */

import { findBreakevens } from './pnl';
import {
  legValue,
  type MarketContext,
  type ModelSettings,
  type PremiumSummary,
  type PreparedLeg,
} from './position';
import type { Scenario } from './scenario';

export interface MarginParams {
  /** 原資産の値動き幅 R（小数。0.08 = ±8%） */
  range: number;
  /** IV の上げ幅（pt） */
  ivUpPt: number;
  /** IV の下げ幅（pt） */
  ivDownPt: number;
  /** 掛け目 k（倍率。1.2 = 120%） */
  factor: number;
  /**
   * 買いの OP で証拠金を減らさない（true = M の足は生きている売りの OP と先物だけ。証券会社の扱い。
   * false = 全足で相殺する JSCC の形）。余力の他の項は全足のまま。#149
   */
  ignoreLongOptions: boolean;
}

/** 既定値（仮置き。設定で変えられる。設計 5.10） */
export const DEFAULT_MARGIN_PARAMS: MarginParams = {
  range: 0.08,
  ivUpPt: 8,
  ivDownPt: 4,
  factor: 1.2,
  ignoreLongOptions: true,
};

/** 原資産の格子（R に対する比） */
export const MARGIN_PRICE_STEPS = [-1, -0.5, 0, 0.5, 1] as const;
/** 保有期間（営業日。JSCC の変動日数 2 日に合わせる） */
export const MARGIN_HORIZON_BUSINESS_DAYS = 2;
/** 追証の線の分割数（符号の変化を囲う） */
export const MARGIN_LINE_SAMPLES = 32;

export interface MarginState {
  /** 基準原資産 X_S（円） */
  x: number;
  /** S のシナリオ（d・Δσ・Δs・β・動き方。ΔX は x と同じ点を指す） */
  scenario: Scenario;
  /** h = S の時点から 2 営業日後までの暦日 */
  horizonDays: number;
}

export interface MarginWorst {
  priceStep: number;
  ivPt: number;
  days: number;
}

export interface MarginResult {
  /** S からの損失の最悪値（円、≥ 0） */
  pfe: number;
  /** ネット・オプション価値（円。買い +、売り −） */
  nov: number;
  /** 必要証拠金（概算、円） */
  margin: number;
  /** 生きている先物の足の評価損益（手数料抜き、円） */
  futuresPnl: number;
  /** S で SQ を過ぎた足の清算額（円） */
  settledCash: number;
  /** 損失が最大になった格子の点（M の足が無ければ null） */
  worst: MarginWorst | null;
}

/**
 * IV を pt だけ平行に動かすための σ_base への加算 δ（小数）。absolute は pt / 100、relative は
 * σ' = σ_base × (1 + Δσ/100) + … なので pt / 100 / (1 + Δσ/100)（1 + Δσ/100 ≤ 0.01 なら pt / 100）。
 */
export function marginIvOffset(pt: number, scenario: Scenario): number {
  if (scenario.ivShift !== 'relative') return pt / 100;
  const scale = 1 + scenario.dSigma / 100;
  return scale <= 0.01 ? pt / 100 : pt / 100 / scale;
}

interface IvLayer {
  ivPt: number;
  legs: readonly PreparedLeg[];
}

/** 格子の IV ごとの足の写し（σ_base を包む。0pt は元の足のまま）。 */
function ivLayers(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  params: MarginParams,
): IvLayer[] {
  const shift = (pt: number): IvLayer => {
    if (pt === 0) return { ivPt: 0, legs };
    const d = marginIvOffset(pt, scenario);
    return {
      ivPt: pt,
      legs: legs.map((p) => {
        if (!p.option) return p;
        const base = p.option.sigmaBase;
        return { ...p, option: { ...p.option, sigmaBase: (x: number) => base(x) + d } };
      }),
    };
  };
  return [shift(params.ivUpPt), shift(0), shift(-params.ivDownPt)];
}

function marginOn(
  legs: readonly PreparedLeg[],
  layers: readonly IvLayer[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginResult {
  const sc = state.scenario;
  // M に入れる足（格子の内側では配列の参照だけ）
  const inMargin: boolean[] = [];
  let v0 = 0;
  let nov = 0;
  let futuresPnl = 0;
  let settledCash = 0;
  let anyInMargin = false;
  for (const p of legs) {
    const live = Number.isFinite(p.F) && p.T0 - sc.days / 365 > 0;
    const longOption = p.leg.kind === 'option' && p.sign > 0;
    const counted = live && !(params.ignoreLongOptions && longOption);
    inMargin.push(counted);
    if (!Number.isFinite(p.F)) continue;
    const w = p.sign * p.leg.qty * p.multiplier;
    if (live && !counted) continue; // 生きている買いの OP（オン）: 支払は余力の他の項に入っている
    const v = legValue(p, state.x, sc, ctx, settings);
    if (!live) {
      settledCash += p.leg.kind === 'future' ? w * (v - p.leg.entry) : w * v;
      continue;
    }
    anyInMargin = true;
    v0 += w * v;
    if (p.leg.kind === 'option') nov += w * v;
    else futuresPnl += w * (v - p.leg.entry);
  }
  // M の足が無い = 生きている先物も無い（先物は常に M の足）ので futuresPnl も 0
  if (!anyInMargin) {
    return { pfe: 0, nov: 0, margin: 0, futuresPnl: 0, settledCash, worst: null };
  }
  let maxLoss = Number.NEGATIVE_INFINITY;
  let worst: MarginWorst = { priceStep: 0, ivPt: 0, days: 0 };
  const times = state.horizonDays > 0 ? [0, state.horizonDays] : [0];
  for (const layer of layers) {
    for (const t of times) {
      const scT: Scenario = t === 0 ? sc : { ...sc, days: sc.days + t };
      for (const s of MARGIN_PRICE_STEPS) {
        const x = state.x * (1 + s * params.range);
        let v = 0;
        for (let i = 0; i < layer.legs.length; i++) {
          if (!inMargin[i]) continue;
          const p = layer.legs[i] as PreparedLeg;
          v += p.sign * p.leg.qty * p.multiplier * legValue(p, x, scT, ctx, settings);
        }
        const loss = v0 - v;
        if (loss > maxLoss) {
          maxLoss = loss;
          worst = { priceStep: s, ivPt: layer.ivPt, days: t };
        }
      }
    }
  }
  const pfe = Math.max(0, maxLoss);
  return {
    pfe,
    nov,
    margin: params.factor * Math.max(0, pfe - nov),
    futuresPnl,
    settledCash,
    worst,
  };
}

/** 状態 S の必要証拠金（概算）と、余力に入る先物の評価損益・決済済みの清算額。 */
export function marginAt(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginResult {
  return marginOn(legs, ivLayers(legs, state.scenario, params), state, ctx, settings, params);
}

/** 余力 A = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 + 決済済みの清算額 − 必要証拠金（円）。 */
export function marginRoom(capital: number, premium: PremiumSummary, r: MarginResult): number {
  return (
    capital -
    premium.paid +
    premium.received -
    premium.fees +
    r.futuresPnl +
    r.settledCash -
    r.margin
  );
}

/**
 * 今のポジションの枚数の何倍まで余力 ≥ 0 を保てるか（整数）。全項が枚数に 1 次同次なので
 * A(m) = 資金 + m × s（s = A(1) − 資金）。s ≥ 0 なら上限なし（Infinity）。資金が 0 / 非有限なら null。
 */
export function maxMultiple(
  capital: number,
  premium: PremiumSummary,
  r: MarginResult,
): number | null {
  if (!Number.isFinite(capital) || capital <= 0) return null;
  const s = marginRoom(capital, premium, r) - capital;
  if (s >= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((capital / -s) * (1 + 1e-12));
}

/**
 * 追証の線: シナリオ（ΔX 以外はそのまま）で X だけを動かしたとき余力 A(X) = 0 になる X（1 円に丸め、
 * 昇順）。range を samples 等分して符号の変化を囲い二分法（findBreakevens と同じ作り）。
 * 資金が 0 / 非有限、または余力がどこでも正なら []。
 */
export function marginCallLevels(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  horizonDays: number,
  capital: number,
  premium: PremiumSummary,
  range: { lo: number; hi: number },
  samples: number = MARGIN_LINE_SAMPLES,
): number[] {
  if (!Number.isFinite(capital) || capital <= 0) return [];
  const layers = ivLayers(legs, scenario, params);
  const f = (x: number) =>
    marginRoom(
      capital,
      premium,
      marginOn(
        legs,
        layers,
        { x, scenario: { ...scenario, dX: x - ctx.x0 }, horizonDays },
        ctx,
        settings,
        params,
      ),
    );
  return findBreakevens(f, range.lo, range.hi, samples).sort((a, b) => a - b);
}

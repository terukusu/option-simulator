/**
 * 証拠金の概算（格子の最悪値・掛け目）。設計 docs/design.md 5.10。
 *
 * JSCC の VaR 証拠金（HS-ES）の再現ではなく、証券会社の建てる前の必要委託証拠金に近い物差しの概算
 * （既定は 6 点の答え合わせで決めた。#150）:
 *
 * - 状態 S = (x_S, シナリオ)。格子 = 原資産 x_S × (1 + s·R)（s ∈ MARGIN_PRICE_STEPS）
 *   × IV の倍率 {1 + ivUp, 1, 1 − ivDown} × 経過 {0, h}（h = S から 2 営業日後までの暦日）
 * - IV: 生きている OP の足ごとに状態 S の評価 IV σ_S（legSigma。β・Δσ・Δs・動き方・スマイル込み）を
 *   1 回求め、格子の全点で max(σ_min, σ_S × 倍率) の一定の σ で評価する（格子の原資産の点で β・スマイル・
 *   動き方を足さない）。F'・満期・T ≤ tMin の規則は legValue と同じ（legValueAtSigma）
 * - M の足 = 生きている足のうち、ignoreLongOptions なら売りの OP と先物だけ（買いの OP で減らさない。
 *   証券会社の扱い。#149）、そうでなければ全部（JSCC の形）
 * - V(S) = Σ_M の足 符号 × 枚数 × 乗数 × 評価価格（建値・手数料を含まない）
 * - PFE = max(0, max_格子 (V(S) − V(格子)))、NOV = Σ_M の足のうち OP 符号 × 枚数 × 乗数 × 評価価格
 * - 必要証拠金（概算）= k × PFE（NOV を含まない。証券会社の建てる前の必要委託証拠金と同じ物差し）
 * - 証拠金所要額 = max(0, k × PFE − NOV)（掛け目を NOV に掛けない。負にしない）
 * - 余力 A = 資金 − 支払 + 受取 − 手数料（全足）+ 先物の評価損益（生きている足）+ 決済済みの足の清算額
 *   − 証拠金所要額
 *
 * 生きている足 = S の時点で T > 0 の足。S で SQ を過ぎた足は格子・NOV に入れず、清算額だけを余力に入れる
 * （OP は 符号 × 枚数 × 乗数 × 本源的価値、先物は 符号 × 枚数 × 乗数 × (F' − 建値)、F' = X'）。
 * F が決まらない足（no_forward）は入れない。h・休業日・現在時刻は呼び出し側が決めて渡す。
 */

import { findBreakevens } from './pnl';
import {
  legSigma,
  legValue,
  legValueAtSigma,
  type MarketContext,
  type ModelSettings,
  type PremiumSummary,
  type PreparedLeg,
} from './position';
import type { Scenario } from './scenario';

export interface MarginParams {
  /** 原資産の値動き幅 R（小数。0.05 = ±5%） */
  range: number;
  /** IV の上げ（比率の小数。0.5 = 状態 S の IV の ×1.5） */
  ivUp: number;
  /** IV の下げ（比率の小数。0.25 = 状態 S の IV の ×0.75） */
  ivDown: number;
  /** 掛け目 k（倍率。1 = 100%） */
  factor: number;
  /**
   * 買いの OP で証拠金を減らさない（true = M の足は生きている売りの OP と先物だけ。証券会社の扱い。
   * false = 全足で相殺する JSCC の形）。余力の他の項は全足のまま。#149
   */
  ignoreLongOptions: boolean;
}

/** 既定値（6 点の答え合わせで決めた。設定で変えられる。設計 5.10・#150） */
export const DEFAULT_MARGIN_PARAMS: MarginParams = {
  range: 0.05,
  ivUp: 0.5,
  ivDown: 0.25,
  factor: 1,
  ignoreLongOptions: true,
};

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
  /** IV の倍率（1.5 / 1 / 0.75 など） */
  ivScale: number;
  days: number;
}

export interface MarginResult {
  /** S からの損失の最悪値（円、≥ 0） */
  pfe: number;
  /** ネット・オプション価値（円。買い +、売り −） */
  nov: number;
  /** 必要証拠金（概算、円）= k × PFE（NOV を含まない。タイル・テールの証拠金の表の値） */
  margin: number;
  /** 証拠金所要額（円）= max(0, k × PFE − NOV)（余力・倍数・追証の線はこれ） */
  requirement: number;
  /** 生きている先物の足の評価損益（手数料抜き、円） */
  futuresPnl: number;
  /** S で SQ を過ぎた足の清算額（円） */
  settledCash: number;
  /** 損失が最大になった格子の点（M の足が無ければ null） */
  worst: MarginWorst | null;
}

function marginOn(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginResult {
  const sc = state.scenario;
  // M に入れる足（格子の内側では配列の参照だけ）と、生きている OP の足の状態 S の σ（それ以外は null）
  const inMargin: boolean[] = [];
  const sigmaS: Array<number | null> = [];
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
    sigmaS.push(counted ? legSigma(p, state.x, sc, ctx, settings) : null);
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
    return {
      pfe: 0,
      nov: 0,
      margin: 0,
      requirement: 0,
      futuresPnl: 0,
      settledCash,
      worst: null,
    };
  }
  let maxLoss = Number.NEGATIVE_INFINITY;
  let worst: MarginWorst = { priceStep: 0, ivScale: 1, days: 0 };
  const times = state.horizonDays > 0 ? [0, state.horizonDays] : [0];
  const scales = [1 + params.ivUp, 1, 1 - params.ivDown];
  const sigmas: number[] = new Array(legs.length).fill(0);
  for (const c of scales) {
    for (let i = 0; i < legs.length; i++) {
      const s0 = sigmaS[i];
      if (s0 != null) sigmas[i] = Math.max(settings.sigmaMin, s0 * c);
    }
    for (const t of times) {
      const scT: Scenario = t === 0 ? sc : { ...sc, days: sc.days + t };
      for (const s of MARGIN_PRICE_STEPS) {
        const x = state.x * (1 + s * params.range);
        let v = 0;
        for (let i = 0; i < legs.length; i++) {
          if (!inMargin[i]) continue;
          const p = legs[i] as PreparedLeg;
          const price =
            sigmaS[i] == null
              ? legValue(p, x, scT, ctx, settings)
              : legValueAtSigma(p, x, scT, ctx, settings, sigmas[i] as number);
          v += p.sign * p.leg.qty * p.multiplier * price;
        }
        const loss = v0 - v;
        if (loss > maxLoss) {
          maxLoss = loss;
          worst = { priceStep: s, ivScale: c, days: t };
        }
      }
    }
  }
  const pfe = Math.max(0, maxLoss);
  const margin = params.factor * pfe;
  return {
    pfe,
    nov,
    margin,
    requirement: Math.max(0, margin - nov),
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
  return marginOn(legs, state, ctx, settings, params);
}

/** 余力 A = 資金 − 支払 + 受取 − 手数料 + 先物の評価損益 + 決済済みの清算額 − 証拠金所要額（円）。 */
export function marginRoom(capital: number, premium: PremiumSummary, r: MarginResult): number {
  return (
    capital -
    premium.paid +
    premium.received -
    premium.fees +
    r.futuresPnl +
    r.settledCash -
    r.requirement
  );
}

/**
 * 今のポジションの枚数の何倍まで余力 ≥ 0 を保てるか（整数）。全項が枚数に 1 次同次なので
 * A(m) = 資金 + m × s（s = A(1) − 資金。所要額も max(0, m·a) = m·max(0, a)）。s ≥ 0 なら上限なし（Infinity）。資金が 0 / 非有限なら null。
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
  const f = (x: number) =>
    marginRoom(
      capital,
      premium,
      marginOn(
        legs,
        { x, scenario: { ...scenario, dX: x - ctx.x0 }, horizonDays },
        ctx,
        settings,
        params,
      ),
    );
  return findBreakevens(f, range.lo, range.hi, samples).sort((a, b) => a - b);
}

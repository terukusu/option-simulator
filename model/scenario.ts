/**
 * シナリオ（IV の 1 本の式）と基準原資産 X。設計 docs/design.md 5.4・5.5。
 *
 * - 足 i の原資産: 円モード F_i' = X' + basis_i、% モード F_i' = X' × F_i / X₀（basis_i = F_i − X₀）
 * - x_eff = ln(K / F_eff)。sticky strike は F_eff = F_i、sticky moneyness は F_eff = F_i'
 * - σ_base: 足は σ_anchor + σ_smile(x) − σ_smile(x₀)、足以外は σ_smile(x)
 * - Δσ_total = Δσ + Δσ_β − Δs × x_eff / 0.1（pt）、Δσ_β = β × g(ΔX%)（β は倍率。g は実測の形 = BETA_SHAPE。5.13）
 * - σ' = max(σ_min, σ_base(x_eff) + Δσ_total)
 *
 * ΔX% は評価点の X'（グラフの横軸・テール表の各列）から (X' − X₀) / X₀ × 100 で求める。
 * sticky moneyness で F_i' ≤ 0（#144）は σ' = σ_min（価格は本源的価値で σ に依らない）、x_eff は F_i から。
 */

import type { Smile } from './smile';

export type IvDynamics = 'sticky_strike' | 'sticky_moneyness';
/** IV 平行移動 Δσ の解釈: 絶対（pt を足す）/ 相対（σ_base の % で増減） */
export type IvShiftMode = 'absolute' | 'relative';
export type BasisMode = 'yen' | 'pct';

export interface Scenario {
  /** 経過日数 d（小数可）。T' = T − d / 365 */
  days: number;
  /** 基準原資産の変化 ΔX（円）。シナリオ点 X' = X₀ + ΔX */
  dX: number;
  /** IV 平行移動 Δσ（absolute は pt、relative は %） */
  dSigma: number;
  /** スキュー Δs（pt / moneyness 10%） */
  skew: number;
  /** IV–原資産連動 β（倍率。無次元）。Δσ_β = β × g(ΔX%)。1 = 実測の中央値の形、0 で無効 */
  beta: number;
  ivDynamics: IvDynamics;
  ivShift: IvShiftMode;
}

export const ZERO_SCENARIO: Scenario = {
  days: 0,
  dX: 0,
  dSigma: 0,
  skew: 0,
  beta: 1,
  ivDynamics: 'sticky_strike',
  ivShift: 'absolute',
};

/**
 * β の形 g(ΔX%)（pt）の定数。設計 5.13（形・測り直しの手順・検証の結果）。#306
 *
 * - 下げ（d = −ΔX% > 0）: 区間ごとの傾きの折れ線 g = s1·min(d, 3) + s2·clamp(d − 3, 0, 3) + s3·max(0, d − 6)
 *   を上限 capPt で止める。傾きは pt / 1%（knots は % の下落幅）。0 ≤ s1 ≤ s2 ≤ s3（凸・単調）
 * - 上げ（d < 0）: g = upSlope × d（upSlope ≥ 0。0 = 上げでは IV を動かさない）
 * - s3 は 1 限月の窓（最も深い窓 約 −10%。2 限月は約 −19%）から決めた。それより深い所は s3 で伸ばし、上乗せの合計を
 *   capPt（60pt。仮定）で止める（5.13）
 */
export const BETA_SHAPE = {
  knots: [3, 6],
  slopes: [0.25, 0.9, 4],
  upSlope: 0,
  capPt: 60,
  period: '2018-10〜2026-10',
  measuredOn: '2026-10-31',
  basis: '1 限月・2 営業日・行使価格 0.90F₀ の put・同じ行使価格の IV の変化の中央値',
} as const;

/** β の形 g(ΔX%)（pt）。下げで ≥ 0・単調非減少・連続・capPt 以下。sigmaAt の内側で呼ぶので割り当てしない。 */
export function betaShapePt(dXPct: number): number {
  const d = -dXPct;
  // 上げ（と NaN）: upSlope = 0 なら 0（−0・0 × −∞ = NaN を返さない）
  if (!(d > 0)) return BETA_SHAPE.upSlope === 0 ? 0 : BETA_SHAPE.upSlope * d + 0;
  const k1 = BETA_SHAPE.knots[0];
  const k2 = BETA_SHAPE.knots[1];
  const g =
    BETA_SHAPE.slopes[0] * Math.min(d, k1) +
    BETA_SHAPE.slopes[1] * Math.min(Math.max(d - k1, 0), k2 - k1) +
    BETA_SHAPE.slopes[2] * Math.max(d - k2, 0);
  return Math.min(g, BETA_SHAPE.capPt);
}

/** Δσ_β = β × g(ΔX%)（pt）。β = 0 は 0（連動なし）。 */
export function betaAddPt(dXPct: number, beta: number): number {
  return beta === 0 ? 0 : beta * betaShapePt(dXPct);
}

/** 既定の σ_min = 1% */
export const SIGMA_MIN = 0.01;

/** 急落プリセット（設計 5.4 の例。D13: 値は使いながら調整） */
export const CRASH_PRESETS: ReadonlyArray<{
  label: string;
  dXPct: number;
  dSigma: number;
  skew: number;
}> = [
  { label: '−10% / +20pt / +3', dXPct: -10, dSigma: 20, skew: 3 },
  { label: '−5% / +8pt / +1', dXPct: -5, dSigma: 8, skew: 1 },
  { label: '反発 +5% / −5pt / −1', dXPct: 5, dSigma: -5, skew: -1 },
];

/** プリセットをシナリオに適用する（3 スライダーを同時に設定するだけ。β・d・動き方はそのまま）。 */
export function applyPreset(
  base: Scenario,
  preset: { dXPct: number; dSigma: number; skew: number },
  x0: number,
): Scenario {
  return { ...base, dX: (x0 * preset.dXPct) / 100, dSigma: preset.dSigma, skew: preset.skew };
}

/** 足 i の原資産 F_i'。 */
export function underlyingAt(Fi: number, x0: number, xPrime: number, mode: BasisMode): number {
  return mode === 'yen' ? xPrime + (Fi - x0) : (xPrime * Fi) / x0;
}

/** dF_i' / dX'（Γ の換算に使う）。 */
export function underlyingSlope(Fi: number, x0: number, mode: BasisMode): number {
  return mode === 'yen' ? 1 : Fi / x0;
}

/** σ_base(x) を返す関数。 */
export type SigmaBase = (x: number) => number;

/** 足の σ_base: アンカー IV からの相対シフト。スマイルが無ければ σ_anchor のまま。 */
export function legSigmaBase(
  anchor: number,
  x0: number,
  smile: Smile | null | undefined,
): SigmaBase {
  if (!smile) return () => anchor;
  const s0 = smile.sigma(x0);
  return (x) => anchor + smile.sigma(x) - s0;
}

/** 足以外（板の行・テンプレートの候補）の σ_base = σ_smile。 */
export function boardSigmaBase(smile: Smile): SigmaBase {
  return (x) => smile.sigma(x);
}

export interface ScenarioIvInput {
  sigmaBase: SigmaBase;
  k: number;
  /** 板の F_i */
  Fi: number;
  /** シナリオ後の F_i' */
  FiPrime: number;
  x0: number;
  xPrime: number;
  scenario: Scenario;
  sigmaMin?: number;
}

/** IV の変化量 Δσ_total（pt。absolute のときの Δσ を含む）と x_eff。 */
export function scenarioIvShift(input: ScenarioIvInput): {
  xEff: number;
  shiftPt: number;
  betaPt: number;
} {
  const { k, Fi, FiPrime, x0, xPrime, scenario } = input;
  // F_i' ≤ 0（円モードの basis が負の足を X' ≈ 0 に置いたとき。#144）は ln(K / F') が定義できないので F_i から
  const fEff = scenario.ivDynamics === 'sticky_strike' || !(FiPrime > 0) ? Fi : FiPrime;
  const xEff = Math.log(k / fEff);
  const betaPt = betaAddPt(((xPrime - x0) / x0) * 100, scenario.beta);
  const skewPt = (-scenario.skew * xEff) / 0.1;
  const parallel = scenario.ivShift === 'absolute' ? scenario.dSigma : 0;
  return { xEff, shiftPt: parallel + betaPt + skewPt, betaPt };
}

/** シナリオ後の IV σ'。 */
export function scenarioSigma(input: ScenarioIvInput): number {
  return sigmaAt(
    input.sigmaBase,
    input.k,
    input.Fi,
    input.FiPrime,
    input.x0,
    input.xPrime,
    input.scenario,
    input.sigmaMin ?? SIGMA_MIN,
  );
}

/** scenarioSigma の引数を並べた版（グラフの再サンプリングで割り当てを避ける）。 */
export function sigmaAt(
  sigmaBase: SigmaBase,
  k: number,
  Fi: number,
  FiPrime: number,
  x0: number,
  xPrime: number,
  sc: Scenario,
  sigmaMin: number,
): number {
  const fEff = sc.ivDynamics === 'sticky_strike' ? Fi : FiPrime;
  // F' ≤ 0 の価格は Black-76 の F ≤ 0 の枝（本源的価値）で σ に依らない。ln(K / F') の NaN を返さない（#144）
  if (!(fEff > 0)) return sigmaMin;
  const xEff = Math.log(k / fEff);
  const betaPt = betaAddPt(((xPrime - x0) / x0) * 100, sc.beta);
  const skewPt = (-sc.skew * xEff) / 0.1;
  const base = sigmaBase(xEff);
  const sigma =
    sc.ivShift === 'relative'
      ? base * (1 + sc.dSigma / 100) + (betaPt + skewPt) / 100
      : base + (sc.dSigma + betaPt + skewPt) / 100;
  return Math.max(sigmaMin, sigma);
}

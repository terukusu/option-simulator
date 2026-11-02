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
 * β の形 g(ΔX%)（pt）の定数。設計 5.13（形・角の丸め・測り直しの手順・検証の結果）。#306・#354
 *
 * - 下げ（d = −ΔX% > 0）: 区間ごとの傾きの折れ線 s1·min(d, 3) + s2·clamp(d − 3, 0, 3) + s3·max(0, d − 6)（傾きは
 *   pt / 1%。knots は % の下落幅。0 ≤ s1 ≤ s2 ≤ s3）の角を丸めた形。0 は [0, w₀] の 3 次、−3%・−6% は k ± w で両側の
 *   直線に接する 2 次（折れ線より上 = 損を大きく見る側）、上限は −capRoundFromPct% から接する 2 次で capPt に届く
 *   （−20.275% 以深は capPt）。1 階の微分が連続で、損益曲線に折れ目を出さない
 * - 上げ（d < 0）: g = upSlope × d（upSlope ≥ 0。0 = 上げでは IV を動かさない）
 * - 傾きは 1 限月の窓（最も深い窓 約 −10%）から決めた（#306）。上限 40pt と丸めの始まり −10% は −15% より深い窓の
 *   同じ行使価格の put の IV の上がりの実測から（#354。5.13）
 */
export const BETA_SHAPE = {
  knots: [3, 6],
  slopes: [0.25, 0.9, 4],
  upSlope: 0,
  capPt: 40,
  /** 0 の丸めの幅 w₀（下げ幅 %。[0, w₀] を 3 次でつなぐ） */
  roundZeroPct: 1,
  /** −3%・−6% の丸めの半幅 w（下げ幅 %。k ± w を 2 次でつなぐ） */
  roundKnotPct: 1.5,
  /** 上限の丸めの始まり（下げ幅 %）。半幅は (折れ線が上限に届く点) − これ */
  capRoundFromPct: 10,
  period: '2018-10〜2026-10',
  measuredOn: '2026-10-31',
  basis: '1 限月・2 営業日・行使価格 0.90F₀ の put・同じ行使価格の IV の変化の中央値',
} as const;

// betaShapePt の区間の端と端の値（読み込み時に 1 回だけ導く。関数の中で割り当てない）
const B_K1 = BETA_SHAPE.knots[0];
const B_K2 = BETA_SHAPE.knots[1];
const B_S1 = BETA_SHAPE.slopes[0];
const B_S2 = BETA_SHAPE.slopes[1];
const B_S3 = BETA_SHAPE.slopes[2];
const B_W0 = BETA_SHAPE.roundZeroPct;
const B_W = BETA_SHAPE.roundKnotPct;
const B_C0 = BETA_SHAPE.capRoundFromPct;
const B_CAP = BETA_SHAPE.capPt;
/** 折れ線が上限に届く下げ幅（15.1375%） */
const B_D_CAP = B_K2 + (B_CAP - B_S1 * B_K1 - B_S2 * (B_K2 - B_K1)) / B_S3;
/** 上限の丸めの半幅（5.1375%） */
const B_W_C = B_D_CAP - B_C0;
/** 上限に届く下げ幅（20.275%） */
const B_C_END = B_D_CAP + B_W_C;
const B_G_K1W = B_S1 * (B_K1 - B_W);
const B_G_K2W = B_S1 * B_K1 + B_S2 * (B_K2 - B_W - B_K1);
const B_G_K2 = B_S1 * B_K1 + B_S2 * (B_K2 - B_K1);
const B_G_C0 = B_G_K2 + B_S3 * (B_C0 - B_K2);

/**
 * β の形 g(ΔX%)（pt）。下げで ≥ 0・単調非減少・連続・1 階の微分が連続・capPt 以下。sigmaAt の内側で呼ぶので
 * 割り当てしない（区間の端の値はモジュールの定数）。
 */
export function betaShapePt(dXPct: number): number {
  const d = -dXPct;
  // 上げ（と NaN）: upSlope = 0 なら 0（−0・0 × −∞ = NaN を返さない）
  if (!(d > 0)) return BETA_SHAPE.upSlope === 0 ? 0 : BETA_SHAPE.upSlope * d + 0;
  if (d >= B_C_END) return B_CAP;
  if (d < B_W0) {
    // 3 次エルミート: g(0) = 0・g′(0) = 0・g(w₀) = s1·w₀・g′(w₀) = s1
    const t = d / B_W0;
    return B_S1 * B_W0 * t * t * (2 - t);
  }
  if (d <= B_K1 - B_W) return B_S1 * d;
  if (d < B_K1 + B_W) {
    const u = d - (B_K1 - B_W);
    return B_G_K1W + B_S1 * u + ((B_S2 - B_S1) * u * u) / (4 * B_W);
  }
  if (d <= B_K2 - B_W) return B_S1 * B_K1 + B_S2 * (d - B_K1);
  if (d < B_K2 + B_W) {
    const u = d - (B_K2 - B_W);
    return B_G_K2W + B_S2 * u + ((B_S3 - B_S2) * u * u) / (4 * B_W);
  }
  if (d <= B_C0) return B_G_K2 + B_S3 * (d - B_K2);
  const u = d - B_C0;
  return B_G_C0 + B_S3 * u - (B_S3 * u * u) / (4 * B_W_C);
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

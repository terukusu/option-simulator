/**
 * ポジション（足の集まり）の評価。設計 docs/design.md 5.3〜5.6・5.8。
 *
 * - 足: ラージ OP / ラージ・ミニ・マイクロ先物、限月、売買、枚数、建値、アンカー IV
 * - 指定日の理論損益（シナリオ込み）、満期損益の区分線形の解析解、BEP、テール表
 * - グリークの表示単位: Δ ラージ換算枚数（とミニ換算）、Γ X 100 円あたりの Δ の変化、
 *   Θ 円 / 暦日（買いが負）、V 円 / IV 1pt
 * - 損益 = Σ 枚数 × 乗数 × (評価価格 − 建値) × 売買符号 − 手数料
 */

import {
  black76Greeks,
  black76Price,
  discountedIntrinsic,
  type Greeks,
  type OptionType,
} from './black76';
import { impliedVol } from './iv';
import { type FutureProduct, LARGE_MULTIPLIER, type OptionProduct, PRODUCTS } from './products';
import {
  type BasisMode,
  legSigmaBase,
  type Scenario,
  SIGMA_MIN,
  type SigmaBase,
  scenarioSigma,
  sigmaAt,
  underlyingAt,
  underlyingSlope,
} from './scenario';
import type { Smile } from './smile';
import { T_MIN_YEARS, yearFraction } from './time';

export type Side = 'buy' | 'sell';

export interface OptionLeg {
  kind: 'option';
  product: OptionProduct;
  type: OptionType;
  /** 限月 ID（MarketContext.options のキー） */
  expiry: string;
  strike: number;
  side: Side;
  qty: number;
  /** 建値（既定は買い = ask、売り = bid） */
  entry: number;
  /** 編集した IV（指定すればアンカー IV として使う） */
  iv?: number;
  /** 足を入れたときの板の mid（スプレッドコスト用。無ければ null） */
  mid?: number | null;
}

export interface FutureLeg {
  kind: 'future';
  product: FutureProduct;
  /** 先物の限月 ID（MarketContext.futures のキー） */
  contract: string;
  side: Side;
  qty: number;
  entry: number;
}

export type Leg = OptionLeg | FutureLeg;

export interface OptionExpiryMarket {
  /** SQ 日 09:00 JST の epoch ミリ秒 */
  sqTime: number;
  /** 限月の F_i（板の合成先物、または手入力） */
  forward: number;
  /** その限月のスマイル（板が無ければ null） */
  smile: Smile | null;
}

export interface FutureMarket {
  sqTime: number;
  /** 先物価格（板が無い限月は手入力の初期値。設計 5.7） */
  price: number;
}

export interface MarketContext {
  /** 評価時刻（既定はスナップショット時刻）の epoch ミリ秒 */
  evalTime: number;
  /** 金利（連続複利、既定 0.5%） */
  r: number;
  /** 横軸の基準 X₀ */
  x0: number;
  options: Readonly<Record<string, OptionExpiryMarket>>;
  futures: Readonly<Record<string, FutureMarket>>;
}

export interface ModelSettings {
  basisMode: BasisMode;
  /** 先物の足の basis: 固定（既定）/ 先物の SQ で 0 になるよう線形に減衰 */
  futureBasis: 'fixed' | 'decay';
  sigmaMin: number;
  /** 手数料（1 枚あたり円） */
  feePerLot: number;
  tMin: number;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  basisMode: 'yen',
  futureBasis: 'fixed',
  sigmaMin: SIGMA_MIN,
  feePerLot: 0,
  tMin: T_MIN_YEARS,
};

export type AnchorSource = 'entry' | 'manual' | 'smile' | 'none';

export interface PreparedLeg {
  leg: Leg;
  multiplier: number;
  /** 買い +1、売り −1 */
  sign: 1 | -1;
  /** 足の原資産（板の F_i か先物価格） */
  F: number;
  /** basis_i = F − X₀ */
  basis: number;
  /** 満期（SQ 日 9:00）の epoch ミリ秒 */
  expiryTime: number;
  /** 評価時刻での T */
  T0: number;
  /** オプションの足だけ */
  option?: {
    anchor: number;
    anchorSource: AnchorSource;
    x0: number;
    sigmaBase: SigmaBase;
    /** 建値ずれ = 建値 − アンカー IV の理論価格（価格単位。entry で決まった足は 0） */
    mismatch: number;
  };
}

export const sideSign = (side: Side): 1 | -1 => (side === 'buy' ? 1 : -1);

/** 足を入れた時点の値（アンカー IV・basis）を決める。 */
export function prepareLeg(
  leg: Leg,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): PreparedLeg {
  const multiplier = PRODUCTS[leg.product].multiplier;
  const sign = sideSign(leg.side);
  if (leg.kind === 'future') {
    const m = ctx.futures[leg.contract];
    if (!m) throw new Error(`先物の限月が無い: ${leg.contract}`);
    return {
      leg,
      multiplier,
      sign,
      F: m.price,
      basis: m.price - ctx.x0,
      expiryTime: m.sqTime,
      T0: yearFraction(ctx.evalTime, m.sqTime),
    };
  }
  const m = ctx.options[leg.expiry];
  if (!m) throw new Error(`オプションの限月が無い: ${leg.expiry}`);
  const F = m.forward;
  const T0 = yearFraction(ctx.evalTime, m.sqTime);
  if (!Number.isFinite(F)) {
    // F が決まらない限月（合成も先物も無い）: アンカー IV は決めず、評価は建値のまま（no_forward）
    const anchor = leg.iv ?? settings.sigmaMin;
    return {
      leg,
      multiplier,
      sign,
      F,
      basis: 0,
      expiryTime: m.sqTime,
      T0,
      option: { anchor, anchorSource: 'none', x0: 0, sigmaBase: () => anchor, mismatch: 0 },
    };
  }
  const x0 = Math.log(leg.strike / F);
  let anchor: number;
  let anchorSource: AnchorSource;
  const theo = (s: number) =>
    T0 > settings.tMin
      ? black76Price(leg.type, F, leg.strike, T0, s, ctx.r)
      : discountedIntrinsic(leg.type, F, leg.strike, T0, ctx.r);
  if (leg.iv !== undefined) {
    anchor = leg.iv;
    anchorSource = 'manual';
  } else {
    const res = impliedVol(leg.type, leg.entry, F, leg.strike, T0, ctx.r, { tMin: settings.tMin });
    if (res.ok) {
      anchor = res.sigma;
      anchorSource = 'entry';
    } else if (m.smile) {
      // 建値 ≤ 割引本源的価値など: σ_anchor = σ_smile(x₀)、差は建値ずれとして別に出す
      anchor = m.smile.sigma(x0);
      anchorSource = 'smile';
    } else {
      anchor = settings.sigmaMin;
      anchorSource = 'none';
    }
  }
  const mismatch = anchorSource === 'entry' ? 0 : leg.entry - theo(anchor);
  return {
    leg,
    multiplier,
    sign,
    F,
    basis: F - ctx.x0,
    expiryTime: m.sqTime,
    T0,
    option: { anchor, anchorSource, x0, sigmaBase: legSigmaBase(anchor, x0, m.smile), mismatch },
  };
}

export function preparePosition(
  legs: readonly Leg[],
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): PreparedLeg[] {
  return legs.map((l) => prepareLeg(l, ctx, settings));
}

/** no_forward: 原資産 F が決まらない足（評価は建値のまま、損益は手数料だけ。NaN を広げない） */
export type LegState = 'live' | 'near_expiry' | 'expired' | 'settled_flat' | 'no_forward';

export interface LegEvaluation {
  /** 評価価格（オプションはプレミアム、先物は価格） */
  value: number;
  /** 損益（円、手数料込み） */
  pnl: number;
  /** 使った IV（オプションで live のときだけ） */
  sigma: number | null;
  /** 足の原資産 F_i' */
  underlying: number;
  /** 生のグリーク（原資産 1 単位あたり） */
  greeks: Greeks;
  state: LegState;
}

const NO_GREEKS: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };

function futureValue(
  p: PreparedLeg,
  xPrime: number,
  Tm: number,
  ctx: MarketContext,
  settings: ModelSettings,
) {
  if (Tm <= 0) {
    // 先物の SQ を過ぎた: 先に SQ で決済し、経路は評価値で平らと仮定して F = X'（設計 5.8。単純化）
    return { value: xPrime, state: 'settled_flat' as const };
  }
  const factor = settings.futureBasis === 'decay' && p.T0 > 0 ? Math.min(Tm / p.T0, 1) : 1;
  if (settings.basisMode === 'yen')
    return { value: xPrime + p.basis * factor, state: 'live' as const };
  return { value: xPrime * (1 + (p.F / ctx.x0 - 1) * factor), state: 'live' as const };
}

/** 1 本の足を評価点 X'・シナリオで評価する。 */
export function evaluateLeg(
  p: PreparedLeg,
  xPrime: number,
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): LegEvaluation {
  const T = p.T0 - scenario.days / 365;
  const qtyMult = p.sign * p.leg.qty * p.multiplier;
  const fee = settings.feePerLot * p.leg.qty;
  if (!Number.isFinite(p.F)) {
    return {
      value: p.leg.entry,
      pnl: 0 - fee,
      sigma: null,
      underlying: Number.NaN,
      greeks: NO_GREEKS,
      state: 'no_forward',
    };
  }
  if (p.leg.kind === 'future') {
    const { value, state } = futureValue(p, xPrime, T, ctx, settings);
    return {
      value,
      pnl: qtyMult * (value - p.leg.entry) - fee,
      sigma: null,
      underlying: value,
      greeks: state === 'live' ? { ...NO_GREEKS, delta: 1 } : NO_GREEKS,
      state,
    };
  }
  const leg = p.leg;
  const opt = p.option as NonNullable<PreparedLeg['option']>;
  const Fp = underlyingAt(p.F, ctx.x0, xPrime, settings.basisMode);
  if (T <= 0) {
    // SQ を過ぎた足は満期損益（SQ_i = F_i'）。IV の変化は無視
    const value = leg.type === 'call' ? Math.max(Fp - leg.strike, 0) : Math.max(leg.strike - Fp, 0);
    return {
      value,
      pnl: qtyMult * (value - leg.entry) - fee,
      sigma: null,
      underlying: Fp,
      greeks: NO_GREEKS,
      state: 'expired',
    };
  }
  const sigma = scenarioSigma({
    sigmaBase: opt.sigmaBase,
    k: leg.strike,
    Fi: p.F,
    FiPrime: Fp,
    x0: ctx.x0,
    xPrime,
    scenario,
    sigmaMin: settings.sigmaMin,
  });
  if (T <= settings.tMin) {
    // T' ≤ T_min: 本源的価値。グリークは T_min の値で固定
    const value = discountedIntrinsic(leg.type, Fp, leg.strike, T, ctx.r);
    return {
      value,
      pnl: qtyMult * (value - leg.entry) - fee,
      sigma,
      underlying: Fp,
      greeks: black76Greeks(leg.type, Fp, leg.strike, settings.tMin, sigma, ctx.r),
      state: 'near_expiry',
    };
  }
  const value = black76Price(leg.type, Fp, leg.strike, T, sigma, ctx.r);
  return {
    value,
    pnl: qtyMult * (value - leg.entry) - fee,
    sigma,
    underlying: Fp,
    greeks: black76Greeks(leg.type, Fp, leg.strike, T, sigma, ctx.r),
    state: 'live',
  };
}

/** 足の評価価格だけ（グリークを計算せず、オブジェクトを作らない。evaluateLeg と同じ規則）。 */
export function legValue(
  p: PreparedLeg,
  xPrime: number,
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): number {
  const T = p.T0 - scenario.days / 365;
  const leg = p.leg;
  if (!Number.isFinite(p.F)) return leg.entry;
  if (leg.kind === 'future') {
    if (T <= 0) return xPrime;
    const factor = settings.futureBasis === 'decay' && p.T0 > 0 ? Math.min(T / p.T0, 1) : 1;
    return settings.basisMode === 'yen'
      ? xPrime + p.basis * factor
      : xPrime * (1 + (p.F / ctx.x0 - 1) * factor);
  }
  const Fp = settings.basisMode === 'yen' ? xPrime + p.basis : (xPrime * p.F) / ctx.x0;
  if (T <= 0)
    return leg.type === 'call' ? Math.max(Fp - leg.strike, 0) : Math.max(leg.strike - Fp, 0);
  if (T <= settings.tMin) return discountedIntrinsic(leg.type, Fp, leg.strike, T, ctx.r);
  const opt = p.option as NonNullable<PreparedLeg['option']>;
  const sigma = sigmaAt(
    opt.sigmaBase,
    leg.strike,
    p.F,
    Fp,
    ctx.x0,
    xPrime,
    scenario,
    settings.sigmaMin,
  );
  return black76Price(leg.type, Fp, leg.strike, T, sigma, ctx.r);
}

/** 指定日の理論損益の合計（グラフ・BEP・テール表で使う速い版）。 */
export function theoreticalPnl(
  legs: readonly PreparedLeg[],
  xPrime: number,
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): number {
  let total = 0;
  for (const p of legs) {
    const v = legValue(p, xPrime, scenario, ctx, settings);
    total += p.sign * p.leg.qty * p.multiplier * (v - p.leg.entry) - settings.feePerLot * p.leg.qty;
  }
  return total;
}

// ---------------------------------------------------------------- グリークの表示単位

export interface DisplayGreeks {
  /** Δ（ラージ先物換算の枚数） */
  deltaLarge: number;
  /** Δ（ミニ先物換算の枚数 = ラージ × 10） */
  deltaMini: number;
  /** Γ: X が 100 円動いたときの Δ（ラージ換算）の変化 */
  gammaPer100: number;
  /** Θ: 円 / 暦日（乗数込み。買いが負） */
  thetaPerDay: number;
  /** V: 円 / IV 1pt（乗数込み） */
  vegaPerPt: number;
}

/** ラージ換算の Δ をラージ / ミニ / マイクロ換算の枚数に。 */
export function deltaUnits(deltaLarge: number): { large: number; mini: number; micro: number } {
  return { large: deltaLarge, mini: deltaLarge * 10, micro: deltaLarge * 100 };
}

export function displayGreeks(
  p: PreparedLeg,
  e: LegEvaluation,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): DisplayGreeks {
  const lots = (p.sign * p.leg.qty * p.multiplier) / LARGE_MULTIPLIER;
  const dFdX = underlyingSlope(p.F, ctx.x0, settings.basisMode);
  const deltaLarge = lots * e.greeks.delta;
  return {
    deltaLarge,
    deltaMini: deltaLarge * 10,
    gammaPer100: lots * e.greeks.gamma * dFdX * 100,
    thetaPerDay: (p.sign * p.leg.qty * p.multiplier * e.greeks.theta) / 365,
    vegaPerPt: (p.sign * p.leg.qty * p.multiplier * e.greeks.vega) / 100,
  };
}

export interface PositionEvaluation {
  pnl: number;
  legs: Array<LegEvaluation & { display: DisplayGreeks }>;
  total: DisplayGreeks;
}

/** シナリオ点（X' = X₀ + ΔX）でのポジション全体の評価（足別グリーク・合計）。 */
export function evaluatePosition(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
  xPrime: number = ctx.x0 + scenario.dX,
): PositionEvaluation {
  const total: DisplayGreeks = {
    deltaLarge: 0,
    deltaMini: 0,
    gammaPer100: 0,
    thetaPerDay: 0,
    vegaPerPt: 0,
  };
  let pnl = 0;
  const out = legs.map((p) => {
    const e = evaluateLeg(p, xPrime, scenario, ctx, settings);
    const display = displayGreeks(p, e, ctx, settings);
    pnl += e.pnl;
    total.deltaLarge += display.deltaLarge;
    total.deltaMini += display.deltaMini;
    total.gammaPer100 += display.gammaPer100;
    total.thetaPerDay += display.thetaPerDay;
    total.vegaPerPt += display.vegaPerPt;
    return { ...e, display };
  });
  return { pnl, legs: out, total };
}

// ---------------------------------------------------------------- プレミアム・コスト

export interface PremiumSummary {
  /** 受取（売りの足の建値 × 枚数 × 乗数） */
  received: number;
  /** 支払（買いの足） */
  paid: number;
  /** 受取 − 支払（正なら受取超） */
  net: number;
  /** 手数料の合計（全足） */
  fees: number;
  /** net − オプションの足の手数料 */
  netAfterFees: number;
  /** スプレッドコスト Σ |建値 − mid| 方向込み（建値側が不利なら正）。mid の無い足は除く */
  spreadCost: number;
  /** 建値ずれ（円）Σ (建値 − 理論価格) × 売買符号 × 枚数 × 乗数（不利なら正） */
  entryMismatch: number;
}

export function premiumSummary(
  legs: readonly PreparedLeg[],
  settings: ModelSettings = DEFAULT_SETTINGS,
): PremiumSummary {
  let received = 0;
  let paid = 0;
  let fees = 0;
  let optionFees = 0;
  let spreadCost = 0;
  let entryMismatch = 0;
  for (const p of legs) {
    const fee = settings.feePerLot * p.leg.qty;
    fees += fee;
    if (p.leg.kind !== 'option') continue;
    optionFees += fee;
    const amount = p.leg.entry * p.leg.qty * p.multiplier;
    if (p.sign < 0) received += amount;
    else paid += amount;
    if (p.leg.mid !== undefined && p.leg.mid !== null) {
      spreadCost += (p.leg.entry - p.leg.mid) * p.sign * p.leg.qty * p.multiplier;
    }
    if (p.option) entryMismatch += p.option.mismatch * p.sign * p.leg.qty * p.multiplier;
  }
  return {
    received,
    paid,
    net: received - paid,
    fees,
    netAfterFees: received - paid - optionFees,
    spreadCost,
    entryMismatch,
  };
}

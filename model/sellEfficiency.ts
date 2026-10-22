/**
 * 売りの効率（#163。設計 docs/design.md 11 章）: 1 枚の OP を売ったときの「受け取るプレミアム ÷ 必要証拠金（概算）」。
 *
 * - 足: ラージ OP 1 枚の売り。アンカー IV = 渡した σ（スマイルの IV σ_smile(K)）なので、σ_base = σ_smile（5.4）
 * - 状態 S = (x, シナリオ): プレミアム P = その状態の評価価格（evaluateLeg。Black-76、β・Δσ・Δs・動き方込み）、
 *   必要証拠金 M = marginAt の margin（k × PFE。指標のタイルと同じ物差し。5.10）
 * - 効率 = P × 乗数 / M（小数。0.12 = 12%）。新しい式は作らず、position・margin の関数を呼ぶだけ
 * - 満期を過ぎた・F が決まらない・M ≤ 0・非有限は null
 */

import type { OptionType } from './black76';
import { type MarginParams, marginAt } from './margin';
import {
  displayGreeks,
  evaluateLeg,
  type MarketContext,
  type ModelSettings,
  type OptionLeg,
  type PreparedLeg,
  prepareLeg,
} from './position';
import type { Scenario } from './scenario';

export interface SellEfficiencyInput {
  /** 限月 ID（MarketContext.options のキー） */
  expiry: string;
  strike: number;
  type: OptionType;
  /** アンカー IV（小数。スマイルの IV） */
  sigma: number;
  /** 状態 S の基準原資産 X（円） */
  x: number;
  /** 状態 S のシナリオ（dX は x − X₀ を指す） */
  scenario: Scenario;
  /** 証拠金の保有期間 h（暦日） */
  horizonDays: number;
}

export interface SellEfficiency {
  /** プレミアム（価格。乗数前の円） */
  premium: number;
  /** 必要証拠金（概算、円）= k × PFE */
  margin: number;
  /** 効率 = premium × 乗数 / margin（小数） */
  efficiency: number;
  /** 売り 1 枚の Δ（ラージ換算の枚数・ミニ換算の枚数） */
  deltaLarge: number;
  deltaMini: number;
  /** 状態 S の評価 IV（小数） */
  sigma: number;
}

/** 1 枚の売りの足（建値は使わないので 0。アンカー IV は sigma）。 */
export function sellLeg(
  input: Pick<SellEfficiencyInput, 'expiry' | 'strike' | 'type' | 'sigma'>,
): OptionLeg {
  return {
    kind: 'option',
    product: 'op_large',
    type: input.type,
    expiry: input.expiry,
    strike: input.strike,
    side: 'sell',
    qty: 1,
    entry: 0,
    iv: input.sigma,
  };
}

/** 状態 S での 1 枚の売りの効率（決まらなければ null）。 */
export function sellEfficiency(
  input: SellEfficiencyInput,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): SellEfficiency | null {
  const { strike, sigma, x } = input;
  if (!(strike > 0) || !(sigma > 0) || !(x > 0) || !Number.isFinite(sigma)) return null;
  if (!ctx.options[input.expiry]) return null;
  const p: PreparedLeg = prepareLeg(sellLeg(input), ctx, settings);
  if (!Number.isFinite(p.F)) return null;
  const e = evaluateLeg(p, x, input.scenario, ctx, settings);
  if (e.state !== 'live' && e.state !== 'near_expiry') return null;
  const r = marginAt(
    [p],
    { x, scenario: input.scenario, horizonDays: input.horizonDays },
    ctx,
    settings,
    params,
  );
  const margin = r.margin;
  if (!(margin > 0) || !Number.isFinite(margin) || !Number.isFinite(e.value)) return null;
  const efficiency = (e.value * p.multiplier) / margin;
  if (!Number.isFinite(efficiency)) return null;
  const g = displayGreeks(p, e, ctx, settings);
  return {
    premium: e.value,
    margin,
    efficiency,
    deltaLarge: g.deltaLarge,
    deltaMini: g.deltaMini,
    sigma: e.sigma ?? sigma,
  };
}

/**
 * デルタヘッジのパネルの表示モデル（純関数）。設計 docs/design.md M12・5.8・6.1、AC19、U5（手順 1〜3）。
 *
 * - 評価点: シナリオ適用前（既定）= ポジション一覧の Δ と同じ点（シナリオ 0、X' = X₀）、
 *   シナリオ時点 = 指標のシナリオ点（d は最遠の足の SQ に収めた値、X' = X₀ + ΔX）
 * - 現在の Δ（ラージ換算）は model/ の evaluatePosition の合計。1 枚の Δ は、ヘッジに使う先物の仮の足
 *   （買い 1 枚）を data/ の futureLeg で作り、model/ の evaluateLeg・displayGreeks で同じ評価点で求める
 *   （先物の SQ 以降は Δ 0 になる）。枚数と残りは model/ の deltaHedge
 * - シナリオ時点の 1 枚の Δ の d は、追加した後の指標の d（最遠の足の SQ がヘッジの先物まで延びた値）。
 *   既存の足は収めた d で満期を過ぎているので、d が延びても現在の Δ は変わらない
 * - [追加] は既存の addFutureLeg に渡す入力（商品・限月・売買 = 符号・枚数 = |N|）。枚数は足・シナリオ・
 *   目標が変わるたびに出し直す（これが 5.8 の「再ヘッジ」）
 */

import {
  type BuiltFutureLeg,
  type Chain,
  type FutureLegInput,
  futureLeg,
  monthOf,
} from '../../data';
import {
  type DeltaHedge,
  deltaHedge,
  displayGreeks,
  evaluateLeg,
  evaluatePosition,
  type HedgeLots,
  type Holidays,
  type LegEvaluation,
  type MarketContext,
  type ModelSettings,
  type PreparedLeg,
  prepareLeg,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import { clampDays, daysToExpire, type PnlBase } from './pnlChart';

export type HedgeAt = 'base' | 'scenario';

export interface HedgeSettings {
  /** 目標 Δ（ラージ換算。既定 0） */
  target: number;
  /** 評価点（既定 = シナリオ適用前） */
  at: HedgeAt;
  /** ヘッジに使う先物の限月（null = 板の先物 = 直近四半期限月） */
  contract: string | null;
}

export const DEFAULT_HEDGE: HedgeSettings = { target: 0, at: 'base', contract: null };

/** 目標 Δ の範囲（ラージ換算 ±1,000） */
export const HEDGE_TARGET_MAX = 1000;
/** [追加] できる枚数の上限（足の枚数の上限 parseQty と同じ） */
export const HEDGE_LOTS_MAX = 100_000;

export const HEDGE_AT_LABEL: Record<HedgeAt, string> = {
  base: 'シナリオ適用前',
  scenario: 'シナリオ時点',
};

export type HedgeReason = 'no_price' | 'no_leg' | 'settled' | 'over_limit' | 'no_delta';

export const HEDGE_REASON_LABEL: Record<HedgeReason, string> = {
  no_price: '先物価格が無い（足の追加フォームで建値を入れる）',
  no_leg: 'この限月の先物の足を作れない（限月を選び直す）',
  settled: '評価日がこの先物の SQ 以降（Δ 0）',
  over_limit: '枚数が上限（100,000）を超える',
  no_delta: 'Δ を求められない',
};

export type HedgeProduct = 'fut_mini' | 'fut_large';

export interface HedgeLine {
  product: HedgeProduct;
  /** 枚数（符号つき整数。求められなければ null） */
  lots: number | null;
  /** 追加後の Δ − 目標（ラージ換算） */
  residual: number | null;
  canAdd: boolean;
  /** 追加できない理由（0 枚は理由なし） */
  reason: HedgeReason | null;
  /** [追加] で addFutureLeg に渡す入力（追加できなければ null） */
  input: FutureLegInput | null;
}

export interface HedgeModel {
  at: HedgeAt;
  target: number;
  /** 使う先物の限月（選択が無効なら板の先物） */
  contract: string;
  /** 限月の選択肢（板の先物 + 板の OP の限月。重複除去・昇順） */
  contracts: string[];
  /** 板の先物と限月違い（建値は手入力の扱い = その月の合成先物が初期値） */
  contractManual: boolean;
  /** 足の建値（板の先物価格 / 合成先物。先物価格が無ければ null） */
  entry: number | null;
  /** 評価点の X' と d（暦日） */
  point: { x: number; days: number };
  /** 現在の合計 Δ（求められなければ null） */
  current: { large: number; mini: number } | null;
  lines: HedgeLine[];
  /** ミニが 0 枚のときのマイクロ換算（M11。追加はしない。マイクロも 0 枚なら null） */
  micro: HedgeLots | null;
  /** 全行に共通の理由（先物価格なし・SQ 以降・Δ を求められない） */
  reason: HedgeReason | null;
}

/** 限月の選択肢: 板の先物 + 板の OP の限月（重複除去、昇順）。 */
export function hedgeContracts(chain: Chain): string[] {
  return [...new Set([chain.future.id, ...chain.months.map((m) => m.id)])].sort();
}

/** 選んだ限月（null・選択肢に無い限月は板の先物）。 */
export function hedgeContract(chain: Chain, contract: string | null): string {
  return contract !== null && hedgeContracts(chain).includes(contract) ? contract : chain.future.id;
}

/** ヘッジの足の建値の元（data/legs.ts の futureLeg と同じ規則）が無いか: 板の先物価格、限月違いはその月の合成先物 */
export function hedgePriceMissing(chain: Chain, contract: string): boolean {
  const opt = contract === chain.future.id ? undefined : monthOf(chain, contract);
  const price = opt?.syntheticOk ? opt.F : chain.future.price;
  return price === null || !Number.isFinite(price);
}

export interface HedgeInput {
  chain: Chain;
  /** ポジション一覧と同じ市場（view/position.ts の positionContext） */
  ctx: MarketContext;
  /** 損益グラフ・指標と同じ基礎（評価できる足が無ければ null） */
  base: PnlBase | null;
  settings: ModelSettings;
  scenario: Scenario;
  hedge: HedgeSettings;
  holidays: Holidays;
}

const PRODUCTS: readonly HedgeProduct[] = ['fut_mini', 'fut_large'];

function line(
  product: HedgeProduct,
  h: HedgeLots | null,
  contract: string,
  common: HedgeReason | null,
): HedgeLine {
  if (!h || common) {
    return {
      product,
      lots: null,
      residual: null,
      canAdd: false,
      reason: common ?? 'no_delta',
      input: null,
    };
  }
  const over = Math.abs(h.lots) > HEDGE_LOTS_MAX;
  const canAdd = h.lots !== 0 && !over;
  return {
    product,
    lots: h.lots,
    residual: h.residual,
    canAdd,
    reason: over ? 'over_limit' : null,
    input: canAdd
      ? { product, contract, side: h.lots > 0 ? 'buy' : 'sell', qty: Math.abs(h.lots) }
      : null,
  };
}

/** デルタヘッジのパネルの表示モデル。 */
export function hedgeModel(input: HedgeInput): HedgeModel {
  const { chain, base, scenario, hedge, holidays } = input;
  const ctx = base?.ctx ?? input.ctx;
  const settings = base?.settings ?? input.settings;
  const contract = hedgeContract(chain, hedge.contract);
  const contracts = hedgeContracts(chain);

  // 評価点（シナリオ時点は指標と同じ d・X'）
  const atScenario = hedge.at === 'scenario';
  const maxDays = base?.maxDays ?? 0;
  const days = atScenario ? clampDays(scenario, maxDays).days : 0;
  const dX = atScenario && Number.isFinite(scenario.dX) ? scenario.dX : 0;
  const x = ctx.x0 + dX;
  const sc: Scenario = atScenario ? { ...scenario, days } : ZERO_SCENARIO;

  // 現在の合計 Δ（評価できる足が無ければ 0。ポジション一覧でも F が決まらない足の Δ は 0）
  let currentLarge = 0;
  if (base && base.legs.length > 0) {
    currentLarge = evaluatePosition(base.legs, sc, ctx, settings, x).total.deltaLarge;
  }
  const currentOk = Number.isFinite(currentLarge) && Number.isFinite(x);

  // 1 枚の Δ（仮の足を同じ評価点で評価）
  let reason: HedgeReason | null = currentOk ? null : 'no_delta';
  let contractManual = contract !== chain.future.id;
  let entry: number | null = null;
  const perLot = { mini: 0, large: 0, micro: 0 };
  for (const [key, product] of [
    ['mini', 'fut_mini'],
    ['large', 'fut_large'],
    ['micro', 'fut_micro'],
  ] as const) {
    if (reason) break;
    let built: BuiltFutureLeg;
    try {
      built = futureLeg(chain, { product, contract, side: 'buy', qty: 1 }, holidays);
    } catch {
      // 先物価格が無いときだけ「先物価格が無い」。それ以外は別の固定文言（例外の本文は出さない）
      reason = hedgePriceMissing(chain, contract) ? 'no_price' : 'no_leg';
      break;
    }
    contractManual = built.marks.includes('future_manual');
    entry = built.leg.entry;
    const hctx: MarketContext = {
      ...ctx,
      futures: { ...ctx.futures, [contract]: built.market },
    };
    let e: LegEvaluation;
    let p: PreparedLeg;
    try {
      p = prepareLeg(built.leg, hctx, settings);
      // 追加した後の指標の d（最遠の足の SQ がこの先物まで延びる）
      const want = Number.isFinite(scenario.days) ? Math.max(scenario.days, 0) : 0;
      const hDays = atScenario ? Math.min(want, Math.max(maxDays, daysToExpire(p.T0))) : 0;
      e = evaluateLeg(p, x, { ...sc, days: hDays }, hctx, settings);
    } catch {
      reason = 'no_delta';
      break;
    }
    if (e.state !== 'live') {
      reason = 'settled';
      break;
    }
    perLot[key] = displayGreeks(p, e, hctx, settings).deltaLarge;
  }
  if (reason === 'no_price' || reason === 'no_leg') entry = null;

  const h: DeltaHedge | null = reason ? null : deltaHedge(currentLarge, hedge.target, perLot);
  if (!reason && !h) reason = 'no_delta';
  return {
    at: hedge.at,
    target: hedge.target,
    contract,
    contracts,
    contractManual,
    entry,
    point: { x, days },
    current: currentOk ? { large: currentLarge, mini: currentLarge * 10 } : null,
    lines: PRODUCTS.map((pr) =>
      line(pr, h ? (pr === 'fut_mini' ? h.mini : h.large) : null, contract, reason),
    ),
    // マイクロも 0 枚（足 0 本で目標 0 など）なら併記しない（情報が無い）
    micro: h?.micro && h.micro.lots !== 0 ? h.micro : null,
    reason,
  };
}

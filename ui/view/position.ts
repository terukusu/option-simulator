/**
 * ポジション一覧の表示モデル（純関数）。設計 docs/design.md M3・5.3・5.6・5.7・K6。
 *
 * 評価は model/ の prepareLeg・evaluatePosition（シナリオ 0、X' = X₀）・displayGreeks をそのまま使う。
 * 建値ずれ（円）= シナリオ 0 の理論損益への影響 = −売買の符号 × mismatch × 乗数 × 枚数
 * （theoreticalPnl のシナリオ 0 と一致する。手数料は含めない）。
 */

import {
  buildMarketContext,
  type Calendar,
  type Chain,
  isExpiryConfirmed,
  type LegMark,
  monthOf,
} from '../../data';
import {
  type AnchorSource,
  type AtmBasis,
  type DisplayGreeks,
  evaluatePosition,
  type FutureMarket,
  type LegState,
  type MarketContext,
  type OptionExpiryMarket,
  type PreparedLeg,
  type Product,
  prepareLeg,
  type Side,
  ZERO_SCENARIO,
} from '../../model';
import type { UiLeg } from '../state';
import { fmtDate } from './format';

export const PRODUCT_LABEL: Record<Product, string> = {
  op_large: 'ラージ OP',
  fut_large: 'ラージ先物',
  fut_mini: 'ミニ先物',
  fut_micro: 'マイクロ先物',
};

export const SIDE_LABEL: Record<Side, string> = { buy: '買い', sell: '売り' };

export const LEG_MARK_LABEL: Record<LegMark, string> = {
  no_board: '板なし（手入力）',
  no_quote: '気配なし',
  unstable_iv: 'IV 不安定',
  extrapolated: '外挿',
  interpolated: '補間',
  forward_from_future: 'F は先物で代用',
  future_manual: '建値は手入力（板の先物と限月違い）',
  no_price: '先物価格なし（建値で評価）',
};

/** 建値ずれ（円）を「0」とみなす幅 */
export const MISMATCH_EPS_YEN = 1;

export const MISMATCH_NOTE: Record<AnchorSource, string> = {
  entry: '',
  smile:
    '建値 ≤ 割引本源的価値のためスマイルの IV を使用（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
  manual: 'IV を手で入れた（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
  none: 'IV を建値から求められない（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
};

export interface PositionRow {
  id: number;
  kind: 'option' | 'future';
  product: Product;
  productLabel: string;
  /** 限月（YYYY-MM） */
  month: string;
  /** 'P' / 'C'（先物は null） */
  optionType: 'P' | 'C' | null;
  strike: number | null;
  side: Side;
  sideLabel: string;
  qty: number;
  entry: number;
  /** アンカー IV（小数。先物・評価できない足は null） */
  iv: number | null;
  /** IV を編集した（OptionLeg.iv がある） */
  ivEdited: boolean;
  anchorSource: AnchorSource | null;
  /** 足別グリーク（評価できない足は null） */
  greeks: DisplayGreeks | null;
  /** 建値ずれ（円。先物・評価できない足は null） */
  mismatchYen: number | null;
  /** 建値ずれの注記（|建値ずれ| < 1 円なら null） */
  mismatchNote: string | null;
  marks: LegMark[];
  markLabels: string[];
  /** 警告（不安定な IV など） */
  warnings: string[];
  /** SQ 日（YYYY-MM-DD） */
  sqDate: string;
  /**
   * SQ 日を取引カレンダーから求めた足で、その限月の第 2 金曜が確定の最終日より後（休業日未確定）。
   * 板の限月（板の SQ 日を使う）は false
   */
  calendarUnconfirmed: boolean;
  state: LegState | null;
  /** 評価できない理由（読み直した板に限月が無いなど） */
  error: string | null;
}

export interface PositionModel {
  rows: PositionRow[];
  ctx: MarketContext;
  prepared: PreparedLeg[];
}

/** 足の市場を足した MarketContext（板の限月は板を優先）。 */
export function positionContext(chain: Chain, legs: readonly UiLeg[], basis: AtmBasis) {
  const extraOptions: Record<string, OptionExpiryMarket> = {};
  const extraFutures: Record<string, FutureMarket> = {};
  for (const l of legs) {
    if (l.optionMarket) extraOptions[l.optionMarket.expiry] = l.optionMarket.market;
    if (l.futureMarket) extraFutures[l.futureMarket.contract] = l.futureMarket.market;
  }
  return buildMarketContext(chain, { atmBasis: basis, extraOptions, extraFutures });
}

/** 限月 'YYYY-MM' の第 2 金曜が確定の最終日以前か（形が違えば未確定）。 */
function confirmed(calendar: Calendar, month: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m !== null && isExpiryConfirmed(calendar, Number(m[1]), Number(m[2]));
}

function sqOf(chain: Chain, ui: UiLeg, ctx: MarketContext, calendar: Calendar) {
  const leg = ui.leg;
  if (leg.kind === 'option') {
    const m = monthOf(chain, leg.expiry);
    if (m) return { sqDate: m.sqDate, calendarUnconfirmed: false };
    const mk = ctx.options[leg.expiry];
    return {
      sqDate: fmtDate(mk ? mk.sqTime : null),
      calendarUnconfirmed: !confirmed(calendar, leg.expiry),
    };
  }
  if (leg.contract === chain.future.id) {
    return { sqDate: chain.future.sqDate, calendarUnconfirmed: false };
  }
  const m = monthOf(chain, leg.contract);
  if (m) return { sqDate: m.sqDate, calendarUnconfirmed: false };
  const mk = ctx.futures[leg.contract];
  return {
    sqDate: fmtDate(mk ? mk.sqTime : null),
    calendarUnconfirmed: !confirmed(calendar, leg.contract),
  };
}

const finite = (v: number) => Number.isFinite(v);

export function positionModel(
  chain: Chain,
  legs: readonly UiLeg[],
  basis: AtmBasis,
  calendar: Calendar,
): PositionModel {
  const ctx = positionContext(chain, legs, basis);
  const prepared: Array<PreparedLeg | null> = [];
  const errors: Array<string | null> = [];
  for (const ui of legs) {
    try {
      prepared.push(prepareLeg(ui.leg, ctx));
      errors.push(null);
    } catch {
      prepared.push(null);
      errors.push(
        ui.leg.kind === 'option'
          ? `板に無い限月（${ui.leg.expiry}）。足を消すか板を読み直す`
          : `先物の市場が無い（${ui.leg.contract}）`,
      );
    }
  }
  const ok = prepared.filter((p): p is PreparedLeg => p !== null);
  const evaluation = evaluatePosition(ok, ZERO_SCENARIO, ctx);
  let j = 0;
  const rows = legs.map((ui, i): PositionRow => {
    const leg = ui.leg;
    const p = prepared[i] ?? null;
    const e = p ? evaluation.legs[j++] : undefined;
    const opt = p?.option;
    const mismatchYen =
      p && opt && finite(opt.mismatch)
        ? // || 0: −0 を 0 にする
          -p.sign * opt.mismatch * p.multiplier * leg.qty || 0
        : null;
    const showNote = mismatchYen !== null && Math.abs(mismatchYen) >= MISMATCH_EPS_YEN && opt;
    const g = e?.display ?? null;
    const greeks =
      g &&
      finite(g.deltaLarge) &&
      finite(g.gammaPer100) &&
      finite(g.thetaPerDay) &&
      finite(g.vegaPerPt)
        ? g
        : null;
    const warnings: string[] = [];
    if (ui.marks.includes('unstable_iv')) {
      warnings.push('IV 不安定な行（IV の精度が低い。損益・グリークは目安）');
    }
    if (ui.marks.includes('no_quote')) warnings.push('気配なし（建値は既定の手入力値）');
    const sq = sqOf(chain, ui, ctx, calendar);
    return {
      id: ui.id,
      kind: leg.kind,
      product: leg.product,
      productLabel: PRODUCT_LABEL[leg.product],
      month: leg.kind === 'option' ? leg.expiry : leg.contract,
      optionType: leg.kind === 'option' ? (leg.type === 'put' ? 'P' : 'C') : null,
      strike: leg.kind === 'option' ? leg.strike : null,
      side: leg.side,
      sideLabel: SIDE_LABEL[leg.side],
      qty: leg.qty,
      entry: leg.entry,
      iv: opt && finite(opt.anchor) ? opt.anchor : null,
      ivEdited: leg.kind === 'option' && leg.iv !== undefined,
      anchorSource: opt?.anchorSource ?? null,
      greeks,
      mismatchYen,
      mismatchNote: showNote && opt ? MISMATCH_NOTE[opt.anchorSource] : null,
      marks: ui.marks,
      markLabels: ui.marks.map((m) => LEG_MARK_LABEL[m]),
      warnings,
      sqDate: sq.sqDate,
      calendarUnconfirmed: sq.calendarUnconfirmed,
      state: e?.state ?? null,
      error: errors[i] ?? null,
    };
  });
  return { rows, ctx, prepared: ok };
}

/**
 * 指標とテール表の表示モデル（純関数）。設計 docs/design.md M6・5.6・6.1、AC15 (b)・AC21・AC22、#6。
 *
 * - 単位: 受け払いの合計（受取 + 支払）が 10 万円未満なら円、以上なら千円（固定も可）。金額（損益・プレミアム・
 *   コスト・Θ・V・テール表）に掛け、Δ・Γ には掛けない
 * - 満期: 最大利益・最大損失（解析解。∞ は右端の傾きによる。∞ のときも反対側の有限の値を併記）、BEP（解析解）
 * - 指定日 + シナリオ: シナリオ点 X' = X₀ + ΔX の理論損益・合計グリーク・足別（IV・グリーク・状態）、
 *   BEP（全域を 256 分割で囲って二分法で 1 円）
 * - プレミアム: 受取 / 支払（手数料抜き・込み）、手数料、スプレッドコスト、建値ずれ。支払超（net < 0）なら
 *   掛け金 = 支払 − 受取 + 手数料（全足）と「利益が掛け金の N 倍になる原資産（満期）」N = 1・5・10
 * - テール表: model/ の tailTable（受取超は受取、支払超は掛け金が倍率の基準）
 *
 * 計算は model/ の関数をそのまま使う。評価できない足（F が決まらない限月）は損益グラフと同じく除く（PnlBase）。
 */

import {
  type DisplayGreeks,
  type Extremum,
  evaluatePosition,
  expiryCrossings,
  type LegState,
  type PremiumSummary,
  premiumSummary,
  type Scenario,
  type TailTable,
  tailTable,
  theoreticalBreakevens,
} from '../../model';
import type { MetricsUnitSetting } from '../state';
import { DASH, fmtNum } from './format';
import { clampDays, type PnlBase, THOUSAND_YEN_FROM } from './pnlChart';
import { PRODUCT_LABEL, SIDE_LABEL } from './position';

export type AmountUnit = 'yen' | 'thousand';

export const AMOUNT_UNIT_LABEL: Record<AmountUnit, string> = { yen: '円', thousand: '千円' };

/** 指定日の BEP を探す分割数（全域。設計 5.6・#6） */
export const DATE_BEP_SAMPLES = 256;
/** 「利益が掛け金の N 倍になる原資産」の N */
export const STAKE_MULTIPLES = [1, 5, 10] as const;

/** 単位: 固定ならそれ、自動は受取 + 支払 ≥ 10 万円で千円。 */
export function amountUnit(received: number, paid: number, fixed: MetricsUnitSetting): AmountUnit {
  if (fixed !== 'auto') return fixed;
  return Math.abs(received) + Math.abs(paid) >= THOUSAND_YEN_FROM ? 'thousand' : 'yen';
}

/**
 * 金額の文字列（単位は付けない）。円は整数・桁区切り、千円は ÷1,000（|v| < 10 万円なら小数 1 桁）。
 * ±Infinity は「+∞」「−∞」、NaN・欠損は「—」。signed なら正に + を付ける。
 */
export function fmtAmount(v: number | null | undefined, unit: AmountUnit, signed = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  if (v === Number.POSITIVE_INFINITY) return '+∞';
  if (v === Number.NEGATIVE_INFINITY) return '−∞';
  const s =
    unit === 'yen' ? fmtNum(v, 0) : fmtNum(v / 1000, Math.abs(v) < THOUSAND_YEN_FROM ? 1 : 0);
  if (!signed || s.startsWith('−') || /^0(\.0+)?$/.test(s)) return s;
  return `+${s}`;
}

/** 金額の文字列に付ける単位（— と ∞ には付けない = 空文字）。読み取り・指標・ピンの中身で共用 */
export function amountUnitFor(value: string, unit: string): string {
  return value === DASH || value.endsWith('∞') ? '' : unit;
}

/** 倍率の文字列（×|比|、小数 1 桁。基準が無ければ「—」）。 */
export function fmtRatio(r: number | null): string {
  return r === null || !Number.isFinite(r) ? DASH : `×${fmtNum(Math.abs(r), 1)}`;
}

export interface ExpiryMetrics {
  maxProfit: Extremum;
  maxLoss: Extremum;
  /** 最大利益が +∞ のとき、反対側（折れ点と下端の中）の最大（併記用）。有限なら null */
  profitFinite: Extremum | null;
  /** 最大損失が −∞（call 側）のとき、put 側（折れ点と下端の中）の最小（併記用）。有限なら null */
  lossFinite: Extremum | null;
  /** 横軸の下端（全足の原資産が 0 以上。put 側の最大損失は多くがここ = SQ が下端） */
  xLo: number;
  breakevens: number[];
}

export interface LegMetrics {
  label: string;
  /** シナリオ点の IV（小数。満期・先物・評価できない足は null） */
  sigma: number | null;
  display: DisplayGreeks;
  state: LegState;
  pnl: number;
}

export interface StakeMultiple {
  n: number;
  /** 満期損益 = N × 掛け金 になる X'（1 円。無ければ空） */
  xs: number[];
}

export interface MetricsModel {
  empty: boolean;
  unit: AmountUnit;
  /** 単位を自動で決めた（固定でない） */
  unitAuto: boolean;
  /** 指標に使った d（最遠の足の SQ に収めた値） */
  days: number;
  expiry: ExpiryMetrics;
  scenarioPoint: {
    x: number;
    /** ΔX（X₀ に対する %） */
    dXPct: number;
    pnl: number;
    total: DisplayGreeks;
    legs: LegMetrics[];
  };
  /** 指定日 + シナリオの BEP（全域の中） */
  dateBreakevens: number[];
  premium: PremiumSummary & {
    /** 支払超（net < 0）なら掛け金 = 支払 − 受取 + 手数料（全足）。それ以外は null */
    stake: number | null;
    multiples: StakeMultiple[];
  };
  tail: TailTable;
}

const ZERO_GREEKS: DisplayGreeks = {
  deltaLarge: 0,
  deltaMini: 0,
  gammaPer100: 0,
  thetaPerDay: 0,
  vegaPerPt: 0,
};

function emptyModel(unit: MetricsUnitSetting): MetricsModel {
  return {
    empty: true,
    unit: unit === 'auto' ? 'yen' : unit,
    unitAuto: unit === 'auto',
    days: 0,
    expiry: {
      maxProfit: { value: 0, x: null },
      maxLoss: { value: 0, x: null },
      profitFinite: null,
      lossFinite: null,
      xLo: 0,
      breakevens: [],
    },
    scenarioPoint: { x: Number.NaN, dXPct: 0, pnl: 0, total: ZERO_GREEKS, legs: [] },
    dateBreakevens: [],
    premium: {
      received: 0,
      paid: 0,
      net: 0,
      fees: 0,
      netAfterFees: 0,
      spreadCost: 0,
      entryMismatch: 0,
      stake: null,
      multiples: [],
    },
    tail: { premiumBase: { kind: 'paid', amount: 0 }, rows: [] },
  };
}

function legLabel(p: PnlBase['legs'][number]): string {
  const l = p.leg;
  const side = SIDE_LABEL[l.side];
  if (l.kind === 'future') return `${PRODUCT_LABEL[l.product]} ${l.contract} ${side} ×${l.qty}`;
  return `${l.expiry} ${l.type === 'put' ? 'P' : 'C'} ${fmtNum(l.strike)} ${side} ×${l.qty}`;
}

export interface MetricsInput {
  /** 損益グラフと同じ基礎（足・板が変わったときだけ作る。手数料は base.settings） */
  base: PnlBase | null;
  scenario: Scenario;
  unit: MetricsUnitSetting;
}

/** 指標・テール表の表示モデル。足 0 本・評価できる足が無ければ empty。 */
export function metricsModel(input: MetricsInput): MetricsModel {
  const { base, unit: unitSetting } = input;
  if (!base || base.legs.length === 0) return emptyModel(unitSetting);
  const { legs, ctx, settings, profile } = base;
  const { days } = clampDays(input.scenario, base.maxDays);
  const sc: Scenario = { ...input.scenario, days };
  const dX = Number.isFinite(sc.dX) ? sc.dX : 0;
  const x = ctx.x0 + dX;

  const prem = premiumSummary(legs, settings);
  const unit = amountUnit(prem.received, prem.paid, unitSetting);

  const lossInf = profile.maxLoss.value === Number.NEGATIVE_INFINITY;
  const profitInf = profile.maxProfit.value === Number.POSITIVE_INFINITY;
  const expiry: ExpiryMetrics = {
    maxProfit: profile.maxProfit,
    maxLoss: profile.maxLoss,
    profitFinite: profitInf ? profile.bestAtKinks : null,
    lossFinite: lossInf ? profile.worstAtKinks : null,
    xLo: base.xLo,
    breakevens: profile.breakevens,
  };

  const ev = evaluatePosition(legs, sc, ctx, settings, x);
  const legMetrics = legs.map((p, i): LegMetrics => {
    const e = ev.legs[i] as (typeof ev.legs)[number];
    return { label: legLabel(p), sigma: e.sigma, display: e.display, state: e.state, pnl: e.pnl };
  });

  const stake = prem.net < 0 ? -prem.net + prem.fees : null;
  const multiples: StakeMultiple[] =
    stake !== null && stake > 0
      ? STAKE_MULTIPLES.map((n) => ({ n, xs: expiryCrossings(profile, n * stake) }))
      : [];

  return {
    empty: false,
    unit,
    unitAuto: unitSetting === 'auto',
    days,
    expiry,
    scenarioPoint: {
      x,
      dXPct: (dX / ctx.x0) * 100,
      pnl: ev.pnl,
      total: ev.total,
      legs: legMetrics,
    },
    dateBreakevens: theoreticalBreakevens(
      legs,
      sc,
      ctx,
      // 板の全域（シナリオ点で広げた全域では同じ点数で解像度が落ちる。#144）
      { lo: base.boardFull[0], hi: base.boardFull[1] },
      settings,
      DATE_BEP_SAMPLES,
    ),
    premium: { ...prem, stake, multiples },
    tail: tailTable(legs, sc, ctx, settings),
  };
}

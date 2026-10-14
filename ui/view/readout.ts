/**
 * 読み取りの帯（シナリオ点の値）の表示モデル（純関数）。設計 docs/design.md 6.1・5.6、#52。
 *
 * 損益グラフの直下に出す: 原資産 X_s（ΔX の円と %）、経過日数 d、損益（指定日 + シナリオ・満期・今日）、
 * 合計グリーク（Δ ラージ / ミニ・Γ / 100 円・Θ / 日・V / pt）。値は指標（metricsModel）の
 * 「指定日 + シナリオ」「合計グリーク（シナリオ点）」そのもの。満期・今日だけ追加で評価する
 * （グラフの交点 scenarioMarks と同じ関数）。金額は指標の単位、桁は指標と同じ。
 */

import { type DisplayGreeks, type Scenario, theoreticalPnl } from '../../model';
import { fmtNum, fmtSigned } from './format';
import { AMOUNT_UNIT_LABEL, type AmountUnit, fmtAmount, type MetricsModel } from './metrics';
import { hasDateLine, type PnlBase, todayScenario } from './pnlChart';

export interface ReadoutModel {
  empty: boolean;
  /** X_s = X₀ + ΔX */
  x: number;
  dX: number;
  dXPct: number;
  /** 指標に使った d（上限に収めた値） */
  days: number;
  /** 指定日の線を描く条件（d > 0 または Δσ・Δs ≠ 0） */
  hasDate: boolean;
  pnl: { date: number; expiry: number; today: number };
  greeks: DisplayGreeks;
  unit: AmountUnit;
  unitLabel: string;
  /** 表示の文字列（単位は付けない） */
  text: {
    x: string;
    dX: string;
    dXPct: string;
    days: string;
    pnlDate: string;
    pnlExpiry: string;
    pnlToday: string;
    deltaLarge: string;
    deltaMini: string;
    gamma: string;
    theta: string;
    vega: string;
  };
}

export interface ReadoutInput {
  base: PnlBase | null;
  /** 同じフレームの指標（App で memo したもの） */
  metrics: MetricsModel;
  scenario: Scenario;
}

const ZERO = { deltaLarge: 0, deltaMini: 0, gammaPer100: 0, thetaPerDay: 0, vegaPerPt: 0 };

function emptyReadout(unit: AmountUnit): ReadoutModel {
  return {
    empty: true,
    x: Number.NaN,
    dX: 0,
    dXPct: 0,
    days: 0,
    hasDate: false,
    pnl: { date: 0, expiry: 0, today: 0 },
    greeks: ZERO,
    unit,
    unitLabel: AMOUNT_UNIT_LABEL[unit],
    text: {
      x: '',
      dX: '',
      dXPct: '',
      days: '',
      pnlDate: '',
      pnlExpiry: '',
      pnlToday: '',
      deltaLarge: '',
      deltaMini: '',
      gamma: '',
      theta: '',
      vega: '',
    },
  };
}

/** 帯の表示モデル。足 0 本・評価できる足が無ければ empty。 */
export function readoutModel(input: ReadoutInput): ReadoutModel {
  const { base, metrics, scenario } = input;
  if (!base || base.legs.length === 0 || metrics.empty) return emptyReadout(metrics.unit);
  const { legs, ctx, settings } = base;
  const sp = metrics.scenarioPoint;
  const x = sp.x;
  const dX = x - ctx.x0;
  const expiry = base.expiry(x);
  const today = theoreticalPnl(legs, x, todayScenario(scenario), ctx, settings);
  const u = metrics.unit;
  const g = sp.total;
  return {
    empty: false,
    x,
    dX,
    dXPct: sp.dXPct,
    days: metrics.days,
    hasDate: hasDateLine(scenario, metrics.days),
    pnl: { date: sp.pnl, expiry, today },
    greeks: g,
    unit: u,
    unitLabel: AMOUNT_UNIT_LABEL[u],
    text: {
      x: fmtNum(x),
      dX: fmtSigned(dX, 0),
      dXPct: fmtSigned(sp.dXPct, 1),
      days: String(Math.round(metrics.days * 100) / 100),
      pnlDate: fmtAmount(sp.pnl, u, true),
      pnlExpiry: fmtAmount(expiry, u, true),
      pnlToday: fmtAmount(today, u, true),
      deltaLarge: fmtSigned(g.deltaLarge, 3),
      deltaMini: fmtSigned(g.deltaMini, 2),
      gamma: fmtSigned(g.gammaPer100, 4),
      theta: fmtAmount(g.thetaPerDay, u, true),
      vega: fmtAmount(g.vegaPerPt, u, true),
    },
  };
}

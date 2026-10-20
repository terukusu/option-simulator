/**
 * 損益グラフのシナリオ点 X_s = X₀ + ΔX の縦線と線の交点・金額のラベル（純関数）。設計 docs/design.md 6.1・
 * 13.4、#52。
 *
 * - 交点: 描いている線（満期・指定日 + シナリオ・今日）の X_s での値。満期 = base.expiry(X_s)、
 *   指定日 = theoreticalPnl(X_s, シナリオ（d は上限に収めたもの）)（= 指標の scenarioPoint.pnl）、
 *   今日 = theoreticalPnl(X_s, todayScenario)。ΔX = 0 でも X₀ 上に出す。X_s が表示範囲外なら出さない
 * - ラベル: 「満 / 指 / 今」+ 符号付きの金額 + 単位（指標の単位 5.6。グラフの縦軸の単位とは別）。
 *   交点が縦軸の範囲外なら点を出さず、ラベルを端に寄せて ▲ / ▼ を付ける
 * - 配置（placeLabels）: 中心の間隔 ≥ LABEL_GAP、上下は描画域の内側、横は縦線の右（入らなければ左）
 */

import { type Scenario, theoreticalPnl } from '../../model';
import { type Domain, linear } from '../chart/scale';
import { DASH } from './format';
import { AMOUNT_UNIT_LABEL, type AmountUnit, fmtAmount } from './metrics';
import { type PnlBase, type PnlChartModel, type PnlLineKind, todayScenario } from './pnlChart';

/** ラベルの中心の最小間隔（px） */
export const LABEL_GAP = 13;
/** ラベルの高さ（px。SVG の文字 10px + 余白） */
export const LABEL_H = 12;
/** 縦線からラベルまでの間隔（px） */
export const LABEL_PAD = 4;
/** 文字幅の見積もり（px。SVG の文字 10px。全角・記号は広め） */
export const LABEL_CHAR_PX = 6;
export const LABEL_WIDE_CHAR_PX = 10;

export const KIND_PREFIX: Record<PnlLineKind, string> = { expiry: '満', date: '指', today: '今' };

export type MarkEdge = 'top' | 'bottom';

export interface ScenarioMark {
  kind: PnlLineKind;
  /** 損益（円。model/ の値そのもの） */
  y: number;
  /** 交点の画素（縦軸の範囲外は null = 点を出さない） */
  py: number | null;
  edge: MarkEdge | null;
  text: string;
  labelX: number;
  /** ラベルの中心の y（CSS の dominant-baseline: central） */
  labelY: number;
  anchor: 'start' | 'end';
}

export interface ScenarioMarks {
  /** X_s = X₀ + ΔX */
  x: number;
  /** 縦線の画素 */
  px: number;
  marks: ScenarioMark[];
}

export interface ScenarioMarksInput {
  base: PnlBase | null;
  scenario: Scenario;
  /** 同じフレームのグラフの表示モデル（表示範囲・縦軸・描画域・描いた線と d） */
  chart: Pick<PnlChartModel, 'empty' | 'domain' | 'yDomain' | 'plot' | 'days' | 'lines'>;
  /** 指標の金額の単位（metricsModel の unit） */
  unit: AmountUnit;
}

/** ラベルの文言: [▲▼] + 満 / 指 / 今 + ' ' + 符号付きの金額 + 単位（— や ∞ には単位を付けない）。 */
export function markText(
  kind: PnlLineKind,
  y: number,
  unit: AmountUnit,
  edge: MarkEdge | null,
): string {
  const s = fmtAmount(y, unit, true);
  const arrow = edge === 'top' ? '▲' : edge === 'bottom' ? '▼' : '';
  const u = s === DASH || s.endsWith('∞') ? '' : AMOUNT_UNIT_LABEL[unit];
  return `${arrow}${KIND_PREFIX[kind]} ${s}${u}`;
}

/** ラベルの幅の見積もり（px）。 */
export function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text)
    w += (ch.codePointAt(0) ?? 0) > 0x2000 ? LABEL_WIDE_CHAR_PX : LABEL_CHAR_PX;
  return w;
}

export interface PlacedLabel {
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
}

/**
 * ラベルの配置。py = 交点の画素（範囲外・非有限可。端に寄せる）、px = 縦線の画素。
 * 縦: 中心を [top + H/2, bottom − H/2] に収め、y 順に前方・後方の 2 パスで間隔 LABEL_GAP を確保する
 * （描画域の高さが H + (n − 1) × GAP 以上なら必ず内側に収まる）。横: 縦線の右に入れば右、入らなければ左、
 * 左にも入らなければ描画域の左端から。戻り値は入力の順。
 */
export function placeLabels(
  items: ReadonlyArray<{ py: number; text: string }>,
  plot: { left: number; top: number; width: number; height: number },
  px: number,
): PlacedLabel[] {
  const lo = plot.top + LABEL_H / 2;
  const hi = plot.top + plot.height - LABEL_H / 2;
  const right = plot.left + plot.width;
  const want = items.map((it) => {
    const p = Number.isNaN(it.py) ? (lo + hi) / 2 : it.py;
    return Math.min(Math.max(p, lo), hi);
  });
  const order = want.map((_, i) => i).sort((a, b) => (want[a] as number) - (want[b] as number));
  const ys = order.map((i) => want[i] as number);
  for (let j = 1; j < ys.length; j++) {
    ys[j] = Math.max(ys[j] as number, (ys[j - 1] as number) + LABEL_GAP);
  }
  for (let j = ys.length - 1; j >= 0; j--) {
    const cap = j === ys.length - 1 ? hi : (ys[j + 1] as number) - LABEL_GAP;
    ys[j] = Math.min(ys[j] as number, cap);
  }
  const out = new Array<PlacedLabel>(items.length);
  order.forEach((i, j) => {
    const w = labelWidth((items[i] as { text: string }).text);
    const labelY = ys[j] as number;
    if (px + LABEL_PAD + w <= right) out[i] = { labelX: px + LABEL_PAD, labelY, anchor: 'start' };
    else if (px - LABEL_PAD - w >= plot.left) {
      out[i] = { labelX: px - LABEL_PAD, labelY, anchor: 'end' };
    } else out[i] = { labelX: plot.left, labelY, anchor: 'start' };
  });
  return out;
}

/**
 * 描いている線（満期・指定日・今日）の X での損益（円。NaN は除く。並びは chart.lines の順）。満期 = base.expiry(x)、
 * 指定日 = theoreticalPnl(x, シナリオ（d = chart.days）)、今日 = theoreticalPnl(x, todayScenario)。シナリオ点の交点と
 * 十字線（#201）で共用する。
 */
export function lineValuesAt(
  base: PnlBase,
  scenario: Scenario,
  chart: Pick<PnlChartModel, 'days' | 'lines'>,
  x: number,
): Array<{ kind: PnlLineKind; y: number }> {
  const { legs, ctx, settings } = base;
  const values: Array<{ kind: PnlLineKind; y: number }> = [];
  for (const l of chart.lines) {
    let y: number;
    if (l.kind === 'expiry') y = base.expiry(x);
    else if (l.kind === 'date') {
      y = theoreticalPnl(legs, x, { ...scenario, days: chart.days }, ctx, settings);
    } else y = theoreticalPnl(legs, x, todayScenario(scenario), ctx, settings);
    if (!Number.isNaN(y)) values.push({ kind: l.kind, y });
  }
  return values;
}

/** シナリオ点の交点とラベル。足なし・空・X₀ 不正・X_s が表示範囲外は null。 */
export function scenarioMarks(input: ScenarioMarksInput): ScenarioMarks | null {
  const { base, scenario, chart, unit } = input;
  if (!base || chart.empty) return null;
  const { ctx } = base;
  if (!(Number.isFinite(ctx.x0) && ctx.x0 > 0)) return null;
  const x = ctx.x0 + (Number.isFinite(scenario.dX) ? scenario.dX : 0);
  const [lo, hi] = chart.domain;
  if (!(x >= lo && x <= hi)) return null;
  const { plot, yDomain } = chart;
  const px = linear(chart.domain, [plot.left, plot.left + plot.width])(x);
  const syRaw = linear(yDomain as Domain, [plot.top + plot.height, plot.top]);

  const values = lineValuesAt(base, scenario, chart, x);

  const pre = values.map((v) => {
    const raw = syRaw(v.y);
    const edge: MarkEdge | null =
      raw < plot.top ? 'top' : raw > plot.top + plot.height ? 'bottom' : null;
    return { ...v, raw, edge, text: markText(v.kind, v.y, unit, edge) };
  });
  const placed = placeLabels(
    pre.map((p) => ({ py: p.raw, text: p.text })),
    plot,
    px,
  );
  return {
    x,
    px,
    marks: pre.map((p, i) => ({
      kind: p.kind,
      y: p.y,
      py: p.edge === null ? p.raw : null,
      edge: p.edge,
      text: p.text,
      ...(placed[i] as PlacedLabel),
    })),
  };
}

/**
 * 新しい画面の舞台（損益グラフの描画域・IV レール・時間レール・読み取り）の付属の表示モデル（純関数。#82）。
 * 設計 docs/ui-redesign.md §2・§4.1・§5・§8・§10 段 1 の d / e / f。Preact に依存しない。
 *
 * 線・目盛り・BEP・X₀・シナリオ ATM・ピンの線は pnlChartModel（ui/view/pnlChart.ts）の出力をそのまま使い、
 * ここではその上に描くもの（ハンドル・損益の塗り・足マーカー・ラベルの退避・読み取りの文字列・レール・キー・
 * シート全開のミニの枠）だけを作る。pnlChartModel・scenarioMarks・readoutModel の数値は変えない。
 */

import type { ModelSettings, OptionType, Scenario, Side } from '../../model';
import { type Domain, fitTicks, linear, pixelToValue } from '../chart/scale';
import type { UiLeg } from '../state';
import { DASH, fmtDateTime, fmtSigned } from './format';
import { fmtAmount, type MetricsModel } from './metrics';
import { type FullRow, premiumFullRows } from './metricsPanel';
import {
  axisX,
  INITIAL_PAD_MIN_X0,
  PNL_MARGIN,
  type PnlBase,
  type PnlChartModel,
  type PnlTick,
  X_TICK_OPTIONS,
  xTickLabel,
} from './pnlChart';
import type { ReadoutModel } from './readout';
import {
  daysToTarget,
  type EvalTimeTarget,
  evalInstant,
  sliderSpec,
  stepDXKey,
  stepSlider,
} from './scenario';
import {
  LABEL_GAP,
  LABEL_PAD,
  labelWidth,
  type ScenarioMark,
  type ScenarioMarks,
} from './scenarioMarks';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const f1 = (v: number) => v.toFixed(1);

/** epoch ミリ秒 → JST の MM/DD */
export function fmtMD(t: number): string {
  const s = fmtDateTime(t);
  return s === DASH ? DASH : `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

// ---------------------------------------------------------------- ハンドル

export interface StageHandle {
  /** シナリオ点の縦線の画素（ΔX = 0 なら X₀ の画素） */
  px: number;
  /** ● の縦の画素（指定日の線があればその値、無ければ今日の線。縦軸の外・無ければ null） */
  dotPy: number | null;
  /** 縦線の上端・下端（描画域） */
  top: number;
  bottom: number;
}

/**
 * ハンドル（§8）。ΔX ≠ 0 なら pnlChartModel の scenarioPx、ΔX = 0 なら X₀ の画素（scenarioMarks があるとき =
 * X_s が表示範囲内）。表示範囲の外・空なら null。
 */
export function stageHandle(chart: PnlChartModel, marks: ScenarioMarks | null): StageHandle | null {
  if (chart.empty) return null;
  // scenarioPx が null で marks がある = X_s が範囲内で ΔX = 0（X_s = X₀）
  const px = chart.scenarioPx ?? (marks ? chart.x0Px : null);
  if (px === null) return null;
  const want = chart.lines.some((l) => l.kind === 'date') ? 'date' : 'today';
  const dot = marks?.marks.find((m) => m.kind === want);
  return {
    px,
    dotPy: dot?.py ?? null,
    top: chart.plot.top,
    bottom: chart.plot.top + chart.plot.height,
  };
}

// ---------------------------------------------------------------- 損益の塗り

/**
 * 損益の塗り（§8）: 指定日の線（無ければ今日の線）と 0 の間を、利益側・損失側の 2 本の閉じたパスにする。
 * 0 との交点は線形補間で入れ、縦は描画域に収める。非有限の値でパスを切る。描くものが無ければ空文字。
 */
export function stageFill(chart: PnlChartModel): { gain: string; loss: string } {
  const none = { gain: '', loss: '' };
  if (chart.empty) return none;
  const line =
    chart.lines.find((l) => l.kind === 'date') ?? chart.lines.find((l) => l.kind === 'today');
  if (!line || line.xs.length < 2) return none;
  const { plot } = chart;
  const top = plot.top;
  const bottom = plot.top + plot.height;
  const sx = linear(chart.domain, [plot.left, plot.left + plot.width]);
  const sy = linear(chart.yDomain, [bottom, top]);
  const z = clamp(sy(0), top, bottom);
  const px = line.xs.map((x) => sx(x));
  const py = line.ys.map((y) => (Number.isFinite(y) ? clamp(sy(y), top, bottom) : Number.NaN));
  return { gain: area(px, py, line.ys, z, 1), loss: area(px, py, line.ys, z, -1) };
}

function area(
  px: readonly number[],
  py: readonly number[],
  ys: readonly number[],
  z: number,
  sign: 1 | -1,
): string {
  let d = '';
  let open = false;
  const zs = f1(z);
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i] as number;
    const x = px[i] as number;
    if (!Number.isFinite(y)) {
      if (open) d += `L${f1(px[i - 1] as number)} ${zs}Z`;
      open = false;
      continue;
    }
    const inside = y * sign > 0;
    const prev = i > 0 ? (ys[i - 1] as number) : Number.NaN;
    const prevIn = Number.isFinite(prev) && prev * sign > 0;
    // 0 との交点（前の点と内外が変わったとき）
    let cross: number | null = null;
    if (Number.isFinite(prev) && prevIn !== inside && prev !== y) {
      const x1 = px[i - 1] as number;
      cross = x1 + (x - x1) * (prev / (prev - y));
    }
    if (inside) {
      if (!open) d += `M${f1(cross ?? x)} ${zs}`;
      d += `L${f1(x)} ${f1(py[i] as number)}`;
      open = true;
    } else if (open) {
      d += `L${f1(cross ?? x)} ${zs}Z`;
      open = false;
    }
  }
  if (open) d += `L${f1(px[px.length - 1] as number)} ${zs}Z`;
  return d;
}

// ---------------------------------------------------------------- 足マーカー

export interface LegMarker {
  id: number;
  k: number;
  /** 横軸の画素（描画域の要素の座標。PNL_MARGIN を含む） */
  px: number;
  type: OptionType;
  side: Side;
  qty: number;
  /** 枚数 > 1 なら ×N */
  times: string | null;
  selected: boolean;
  /** 板の OP の足（optionMarket を持たない）だけ行使価格をドラッグで変えられる */
  draggable: boolean;
  /** ▲（call）/ ▼（put）の path */
  path: string;
}

/** マーカーの帯の高さ（横軸の上。px） */
export const MARKER_BAND_PX = 14;

/**
 * 足マーカー（§8）: OP の足ごとに横軸の上の ▲ call / ▼ put。位置は満期の折れ点と同じ写像（axisX）。
 * 先物の足・F が決まらない足・表示範囲の外は出さない。drag 中の足は drag.k の位置に出す。
 */
export function legMarkers(
  legs: readonly UiLeg[],
  base: PnlBase | null,
  chart: PnlChartModel,
  opts: { selected: number | null; drag: { id: number; k: number } | null },
): LegMarker[] {
  if (!base || chart.empty) return [];
  const { plot } = chart;
  const [lo, hi] = chart.domain;
  const sx = linear(chart.domain, [plot.left, plot.left + plot.width]);
  const axisY = plot.top + plot.height;
  const out: LegMarker[] = [];
  for (const ui of legs) {
    const leg = ui.leg;
    if (leg.kind !== 'option') continue;
    const F = base.ctx.options[leg.expiry]?.forward;
    if (F === undefined || !(Number.isFinite(F) && F > 0)) continue;
    const k = opts.drag && opts.drag.id === ui.id ? opts.drag.k : leg.strike;
    const x = axisX(k, F, base.ctx.x0, base.settings);
    if (!(Number.isFinite(x) && x >= lo && x <= hi)) continue;
    const p = sx(x);
    const path =
      leg.type === 'call'
        ? `M${f1(p)} ${f1(axisY - 9)}L${f1(p + 5)} ${f1(axisY - 1)}L${f1(p - 5)} ${f1(axisY - 1)}Z`
        : `M${f1(p)} ${f1(axisY - 1)}L${f1(p + 5)} ${f1(axisY - 9)}L${f1(p - 5)} ${f1(axisY - 9)}Z`;
    out.push({
      id: ui.id,
      k,
      px: p,
      type: leg.type,
      side: leg.side,
      qty: leg.qty,
      times: leg.qty > 1 ? `×${leg.qty}` : null,
      selected: opts.selected === ui.id,
      draggable: ui.optionMarket === undefined,
      path,
    });
  }
  return out;
}

/**
 * 画素 → その限月の板の行使価格（最も近いもの。等距離は小さい方）。画素は描画域の端で止める。
 * 横軸の値 → K は axisX の逆（円: x + (F − X₀)、比率: x · F / X₀）。行が無い・F / X₀ が非有限なら null。
 */
export function strikeAtPx(
  px: number,
  monthRows: readonly { k: number }[],
  F: number,
  x0: number,
  settings: ModelSettings,
  chart: PnlChartModel,
): number | null {
  if (monthRows.length === 0 || !(Number.isFinite(F) && F > 0 && Number.isFinite(x0) && x0 > 0)) {
    return null;
  }
  const { plot } = chart;
  const range: Domain = [plot.left, plot.left + plot.width];
  const x = pixelToValue(chart.domain, range, clamp(px, range[0], range[1]));
  const k = settings.basisMode === 'yen' ? x + (F - x0) : (x * F) / x0;
  if (!Number.isFinite(k)) return null;
  let best: number | null = null;
  for (const r of monthRows) {
    if (
      best === null ||
      Math.abs(r.k - k) < Math.abs(best - k) ||
      (Math.abs(r.k - k) === Math.abs(best - k) && r.k < best)
    ) {
      best = r.k;
    }
  }
  return best;
}

// ---------------------------------------------------------------- 交点のラベルの退避

/** ハンドルからラベルまでの追加の間隔（px。scenarioMarks の LABEL_PAD 4px と合わせて 16px。§8） */
export const STAGE_LABEL_SHIFT = 12;

/** 交点のラベルの文字の大きさ（11px）と、幅の見積もり（10px の labelWidth）の比 */
const MARK_FONT_RATIO = 1.15;
/** ラベルの縦の半分（px。11px の文字 + 余白） */
const MARK_HALF_H = 7;
/** 線・他のラベルを避けるときに試す縦のずれの刻み（px。近い順に描画域の高さまで） */
const MARK_STEP = 9;
/** 元の位置から近いとみなす縦のずれ（px）。この中で見つからなければ、縦線の反対側も同じ近さで試してから遠くへ */
const MARK_NEAR = 45;

/** ラベルが避ける箱（描画域の SVG の座標。IV レールの吹き出しなど、描画域に重なって描くもの） */
export interface MarkObstacle {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface LinePx {
  px: number[];
  py: number[];
}

/** 線（画素の折れ線）が x の範囲 [x0, x1] で縦の範囲 [y0, y1] を通るか */
function lineCrosses(l: LinePx, x0: number, x1: number, y0: number, y1: number): boolean {
  const { px, py } = l;
  // x0 より左の最後の頂点から（px は昇順）
  let lo = 0;
  let hi = px.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((px[mid] as number) <= x0) lo = mid;
    else hi = mid - 1;
  }
  for (let i = lo; i < px.length - 1; i++) {
    const ax = px[i] as number;
    const bx = px[i + 1] as number;
    if (ax > x1) break;
    const ay = py[i] as number;
    const by = py[i + 1] as number;
    if (!(Number.isFinite(ay) && Number.isFinite(by)) || bx < x0 || bx <= ax) continue;
    const at = (x: number) => ay + ((by - ay) * (x - ax)) / (bx - ax);
    const ya = at(Math.max(ax, x0));
    const yb = at(Math.min(bx, x1));
    if (Math.max(ya, yb) >= y0 && Math.min(ya, yb) <= y1) return true;
  }
  return false;
}

/**
 * 交点のラベルの位置（§8）: ハンドルから 16px 離し（各ラベルの x を向きに 12px 足す。描画域から出るならそのまま）、
 * 縦は線（満期・指定日・今日）と他のラベルに重ならない位置を探す。順は (1) 同じ側で元の位置から ±45px（9px 刻み・近い順）
 * (2) 縦線の反対側で同じ範囲 (3) 描画域の高さまで広げて同じ側・反対側を近い順。反対側は描画域に入るときだけ。
 * 見つからなければ他のラベルと重ならない位置、それも無ければ元の位置。文言は同じ（scenarioMarks の出力は変えない）。
 * obstacles（IV レールの吹き出しの箱など）は他のラベルと同じく必ず避ける。
 */
export function stageMarkLabels(
  marks: ScenarioMarks,
  chart: Pick<PnlChartModel, 'plot' | 'lines' | 'domain' | 'yDomain'>,
  obstacles: readonly MarkObstacle[] = [],
): ScenarioMark[] {
  const { plot } = chart;
  const right = plot.left + plot.width;
  const top = plot.top;
  const bottom = plot.top + plot.height;
  /** 縦線の右（start）・左（end）に置いたときの labelX（入らなければ null） */
  const sideX = (m: ScenarioMark, anchor: ScenarioMark['anchor']): number | null => {
    const w = labelWidth(m.text);
    if (anchor === 'start') {
      const x = marks.px + LABEL_PAD + STAGE_LABEL_SHIFT;
      return x + w <= right ? x : null;
    }
    const x = marks.px - LABEL_PAD - STAGE_LABEL_SHIFT;
    return x - w >= plot.left ? x : null;
  };
  const shifted = marks.marks.map((m) => {
    const w = labelWidth(m.text);
    if (m.anchor === 'start') {
      // 描画域の左端からの配置（両側に入らないとき）は動かさない
      if (m.labelX !== marks.px + LABEL_PAD) return m;
      const x = m.labelX + STAGE_LABEL_SHIFT;
      return x + w <= right ? { ...m, labelX: x } : m;
    }
    const x = m.labelX - STAGE_LABEL_SHIFT;
    return x - w >= plot.left ? { ...m, labelX: x } : m;
  });
  const sx = linear(chart.domain, [plot.left, right]);
  const sy = linear(chart.yDomain, [bottom, top]);
  const lines: LinePx[] = chart.lines.map((l) => ({
    px: l.xs.map((x) => sx(x)),
    py: l.ys.map((y) => sy(y)),
  }));
  const span = (labelX: number, anchor: ScenarioMark['anchor'], text: string): [number, number] => {
    const w = labelWidth(text) * MARK_FONT_RATIO;
    return anchor === 'start' ? [labelX, labelX + w] : [labelX - w, labelX];
  };
  const placed: Array<{ x0: number; x1: number; y: number }> = [];
  const clashes = (x0: number, x1: number, y: number) =>
    placed.some((q) => q.x0 < x1 && x0 < q.x1 && Math.abs(q.y - y) < LABEL_GAP) ||
    obstacles.some(
      (o) => o.x0 < x1 && x0 < o.x1 && o.y0 < y + MARK_HALF_H && y - MARK_HALF_H < o.y1,
    );
  const order = shifted
    .map((_, i) => i)
    .sort((a, b) => (shifted[a] as ScenarioMark).labelY - (shifted[b] as ScenarioMark).labelY);
  const out = shifted.slice();
  const lo = top + MARK_HALF_H;
  const hi = bottom - MARK_HALF_H;
  for (const i of order) {
    const m = shifted[i] as ScenarioMark;
    const other: ScenarioMark['anchor'] = m.anchor === 'start' ? 'end' : 'start';
    // 左端からの配置（両側に入らない）は反対側を試さない
    const otherX = m.labelX === plot.left && m.anchor === 'start' ? null : sideX(m, other);
    const sides: Array<{ anchor: ScenarioMark['anchor']; labelX: number }> = [
      { anchor: m.anchor, labelX: m.labelX },
    ];
    if (otherX !== null) sides.push({ anchor: other, labelX: otherX });
    // 縦のずれ: 0, −9, +9, −18, … を描画域の高さまで（描画域に収めた後に同じ値になるものは 1 つに）
    const ds: number[] = [0];
    for (let d = MARK_STEP; d <= Math.max(plot.height, MARK_STEP); d += MARK_STEP) ds.push(-d, d);
    const cands: Array<{ anchor: ScenarioMark['anchor']; labelX: number; y: number }> = [];
    const seen = new Set<string>();
    const push = (s: (typeof sides)[number], d: number) => {
      const y = clamp(m.labelY + d, lo, Math.max(hi, lo));
      const key = `${s.anchor}:${y}`;
      if (seen.has(key)) return;
      seen.add(key);
      cands.push({ ...s, y });
    };
    const near = ds.filter((d) => Math.abs(d) <= MARK_NEAR);
    const far = ds.filter((d) => Math.abs(d) > MARK_NEAR);
    for (const s of sides) for (const d of near) push(s, d);
    for (const d of far) for (const s of sides) push(s, d);
    const ok = (c: (typeof cands)[number], withLines: boolean) => {
      const [x0, x1] = span(c.labelX, c.anchor, m.text);
      if (clashes(x0, x1, c.y)) return false;
      return (
        !withLines ||
        !lines.some((l) => lineCrosses(l, x0, x1, c.y - MARK_HALF_H, c.y + MARK_HALF_H))
      );
    };
    const pick = cands.find((c) => ok(c, true)) ??
      cands.find((c) => c.anchor === m.anchor && ok(c, false)) ?? {
        anchor: m.anchor,
        labelX: m.labelX,
        y: m.labelY,
      };
    const [x0, x1] = span(pick.labelX, pick.anchor, m.text);
    placed.push({ x0, x1, y: pick.y });
    out[i] =
      pick.y === m.labelY && pick.anchor === m.anchor && pick.labelX === m.labelX
        ? m
        : { ...m, labelX: pick.labelX, labelY: pick.y, anchor: pick.anchor };
  }
  return out;
}

// ---------------------------------------------------------------- 描画域の枠（ミニ）

export interface StageFrame {
  plotWidth: number;
  plotHeight: number;
  viewBox: string;
  /** モデルの画素 − offset = 要素の座標 */
  offsetX: number;
  offsetY: number;
}

/**
 * 描画域の枠。通常は PNL_MARGIN を残した描画域、ミニ（シート全開の舞台 92px）は要素の全体を描画域にして、
 * SVG の viewBox の原点を余白の分ずらす（モデルの出力は同じ形のまま）。
 */
export function stageFrame(width: number, height: number, mini: boolean): StageFrame {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  if (mini) {
    return {
      plotWidth: w,
      plotHeight: h,
      viewBox: `${PNL_MARGIN.left} ${PNL_MARGIN.top} ${w} ${h}`,
      offsetX: PNL_MARGIN.left,
      offsetY: PNL_MARGIN.top,
    };
  }
  return {
    plotWidth: Math.max(width - PNL_MARGIN.left - PNL_MARGIN.right, 1),
    plotHeight: Math.max(height - PNL_MARGIN.top - PNL_MARGIN.bottom, 1),
    viewBox: `0 0 ${w} ${h}`,
    offsetX: 0,
    offsetY: 0,
  };
}

// ---------------------------------------------------------------- 空の格子（#111）

/** 足が無い（評価できる足が無い）ときの舞台の格子 */
export interface EmptyStageGrid {
  /** 描画域（pnlChartModel の空のときの plot と同じ） */
  plot: { left: number; top: number; width: number; height: number };
  /** 横軸の目盛り（X₀ があるときだけ。足があるときと同じ規則・書式） */
  xTicks: PnlTick[];
  /** 縦の格子線の x（画素） */
  xLines: number[];
  /** 横の格子線の y（画素。値なしの等間隔） */
  yLines: number[];
  /** 0 の線の y（描画域の縦の中央） */
  zeroPy: number;
}

/** 横の格子の分割数（端を含めて 5 本） */
export const EMPTY_GRID_Y_DIV = 4;
/** X₀ が無いときの縦の格子線のおおよその間隔（px） */
export const EMPTY_GRID_X_GAP_PX = 80;

const finiteSize = (v: number) => (Number.isFinite(v) ? Math.max(v, 1) : 1);

/**
 * 足が無いときの舞台の格子（docs/ui-redesign.md §4.1・変更履歴 #111）。横軸は X₀ ± INITIAL_PAD_MIN_X0·X₀
 * （足を 1 本入れたときの最小の初期幅と同じ）で、目盛りは足があるときと同じ fitTicks・書式。X₀ が決まらない
 * （NaN・0 以下・非有限）ときは文言なしの等間隔の線だけ。縦は値なしの等間隔の線と中央の 0 の線（架空の金額を出さない）。
 * どんな数値でも例外を出さず、すべての画素は描画域の内側。
 */
export function emptyStageGrid(input: {
  x0: number;
  plotWidth: number;
  plotHeight: number;
}): EmptyStageGrid {
  const width = finiteSize(input.plotWidth);
  const height = finiteSize(input.plotHeight);
  const plot = { left: PNL_MARGIN.left, top: PNL_MARGIN.top, width, height };
  const right = plot.left + width;
  const yLines = Array.from(
    { length: EMPTY_GRID_Y_DIV + 1 },
    (_, i) => plot.top + (height * i) / EMPTY_GRID_Y_DIV,
  );
  const zeroPy = plot.top + height / 2;
  const { x0 } = input;
  if (Number.isFinite(x0) && x0 > 0) {
    const pad = x0 * INITIAL_PAD_MIN_X0;
    const lo = x0 - pad;
    const hi = x0 + pad;
    const sx = linear([lo, hi], [plot.left, right]);
    const xTicks = fitTicks(lo, hi, width, xTickLabel, {
      ...X_TICK_OPTIONS,
      widthSample: [lo, hi],
    }).map((v) => ({ v, px: sx(v), label: xTickLabel(v) }));
    return { plot, xTicks, xLines: xTicks.map((t) => t.px), yLines, zeroPy };
  }
  const nx = clamp(Math.round(width / EMPTY_GRID_X_GAP_PX), 2, 12);
  const xLines = Array.from({ length: nx + 1 }, (_, i) => plot.left + (width * i) / nx);
  return { plot, xTicks: [], xLines, yLines, zeroPy };
}

// ---------------------------------------------------------------- 読み取り（大きな数字）

export type BigReadoutKey = 'date' | 'expiry' | 'delta' | 'theta' | 'vega' | 'premium';

export interface BigReadoutItem {
  key: BigReadoutKey;
  /** 出す段階（base = 常に 3 つ、x1 = 舞台の幅 ≥ 480px、x2 = ≥ 600px） */
  tier: 'base' | 'x1' | 'x2';
  hero: boolean;
  label: string;
  value: string;
  /** 値の横に小さく出す単位（無ければ空） */
  unit: string;
  /** 副題（無ければ空） */
  sub: string;
  /** 損益の符号の色（0・欠損は null） */
  tone: 'gain' | 'loss' | null;
  /**
   * 全文（タップ / Enter / Space のポップオーバーの中身。#107）。副題のある項目（date・expiry・delta・premium）だけ。
   * theta・vega・empty は null（押せない）
   */
  full: FullRow[] | null;
}

const toneOf = (s: string): 'gain' | 'loss' | null =>
  s.startsWith('+') ? 'gain' : s.startsWith('−') ? 'loss' : null;

/** 金額に単位を付けるか（— と ∞ には付けない） */
const unitFor = (value: string, unit: string) =>
  value === DASH || value.endsWith('∞') ? '' : unit;

/**
 * 読み取りの 6 項目（§2・§5・§5.2）。値は readoutModel・metricsModel の premium のまま（文字列の丸めだけ）。
 * Δ はラージ 2 桁 + 括弧にミニ 1 桁。表示する個数は CSS（コンテナクエリ）が tier で決める。
 */
export function bigReadout(
  r: ReadoutModel,
  premium: MetricsModel['premium'] | null,
  evalTime: number | null,
  dSigma = 0,
): BigReadoutItem[] {
  const u = r.unitLabel;
  const dateLabel =
    r.hasDate && evalTime !== null && Number.isFinite(evalTime)
      ? `損益 · d ${r.text.days}（${fmtMD(evalInstant(evalTime, r.days))}）`
      : r.hasDate
        ? `損益 · d ${r.text.days}`
        : '損益 · 今日（シナリオ 0）';
  const item = (
    key: BigReadoutKey,
    tier: BigReadoutItem['tier'],
    label: string,
    value: string,
    unit: string,
    sub: string,
    tone: boolean,
    full: FullRow[] | null = null,
  ): BigReadoutItem => ({
    key,
    tier,
    hero: key === 'date',
    label,
    value,
    unit: unitFor(value, unit),
    sub,
    tone: tone ? toneOf(value) : null,
    full,
  });
  /** 見出し + 値（+ 単位）の 1 行目 */
  const head = (label: string, value: string): FullRow => {
    const un = unitFor(value, u);
    return { k: label, v: un ? `${value} ${un}` : value };
  };
  if (r.empty) {
    return [
      item('date', 'base', '損益 · 今日（シナリオ 0）', DASH, '', '', false),
      item('expiry', 'base', '満期（SQ）', DASH, '', '', false),
      item('delta', 'base', 'Δ ラージ(ミニ)', DASH, '', '', false),
      item('theta', 'x1', 'Θ / 日', DASH, '', '', false),
      item('vega', 'x1', 'V / pt', DASH, '', '', false),
      item('premium', 'x2', '受取 − 支払', DASH, '', '', false),
    ];
  }
  const g = r.greeks;
  const sigma = Number.isFinite(dSigma) ? dSigma : 0;
  const prem =
    premium === null
      ? { label: '受取 − 支払', value: DASH, sub: '', full: null }
      : premium.stake !== null
        ? {
            label: '掛け金',
            value: fmtAmount(premium.stake, r.unit),
            sub: `支払 ${fmtAmount(premium.paid, r.unit)}`,
            full: premiumFullRows(premium, r.unit),
          }
        : {
            label: '受取 − 支払',
            value: fmtAmount(premium.net, r.unit, true),
            sub: `受取 ${fmtAmount(premium.received, r.unit)}`,
            full: premiumFullRows(premium, r.unit),
          };
  const deltaValue = `${fmtSigned(g.deltaLarge, 2)} (${fmtSigned(g.deltaMini, 1)})`;
  const gamma = `${fmtSigned(g.gammaPer100, 3)} /100円`;
  return [
    item(
      'date',
      'base',
      dateLabel,
      r.text.pnlDate,
      u,
      // Δσ は全文と IV レールの吹き出しで読む（副題を 1 行に収める。#107）
      `X ${r.text.x} (${r.text.dX}/${r.text.dXPct}%)`,
      true,
      [
        head(dateLabel, r.text.pnlDate),
        { k: 'X', v: r.text.x },
        { k: 'ΔX', v: `${r.text.dX} / ${r.text.dXPct}%` },
        { k: 'Δσ', v: `${fmtSigned(sigma, 1)} pt` },
      ],
    ),
    item('expiry', 'base', '満期（SQ）', r.text.pnlExpiry, u, `今日 ${r.text.pnlToday}`, true, [
      head('満期（SQ）', r.text.pnlExpiry),
      head('今日', r.text.pnlToday),
    ]),
    item('delta', 'base', 'Δ ラージ(ミニ)', deltaValue, '', `Γ ${gamma}`, false, [
      { k: 'Δ ラージ(ミニ)', v: deltaValue },
      { k: 'Γ', v: gamma },
    ]),
    item('theta', 'x1', 'Θ / 日', r.text.theta, u, '', false),
    item('vega', 'x1', 'V / pt', r.text.vega, u, '', false),
    item('premium', 'x2', prem.label, prem.value, u, prem.sub, false, prem.full),
  ];
}

// ---------------------------------------------------------------- キー（描画域にフォーカス）

export type StageKeyResult = { patch: Partial<Scenario> } | { reset: true } | null;

/**
 * 舞台の描画域のキー（§4.1・#82）: ← / → ΔX ∓100 円（Shift ∓1,000。旧画面の , . < > と同じ規則）、
 * ↑ / ↓ Δσ ±0.5pt（sliderSpec('dSigma') の格子と範囲）、[ / ] d ∓1 日（格子に乗せない。0 と上限で止める）、
 * 0 シナリオを 0 に。動かない（端・同じ値）・他のキー（+ − R を含む）は null。
 */
export function stageKey(
  key: string,
  shift: boolean,
  s: Scenario,
  ctx: { x0: number; maxDays: number },
): StageKeyResult {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const k = key === 'ArrowLeft' ? (shift ? '<' : ',') : shift ? '>' : '.';
      const dX = stepDXKey(s.dX, k, ctx.x0);
      return dX === null || dX === s.dX ? null : { patch: { dX } };
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      const spec = sliderSpec('dSigma', { x0: ctx.x0, maxDays: ctx.maxDays, dXUnit: 'yen' });
      const v = stepSlider(spec, s.dSigma, key, false);
      return typeof v !== 'number' || v === s.dSigma ? null : { patch: { dSigma: v } };
    }
    case '[':
    case ']': {
      const max = Number.isFinite(ctx.maxDays) ? ctx.maxDays : 0;
      if (!(max > 0)) return null;
      const cur = clamp(Number.isFinite(s.days) ? s.days : 0, 0, max);
      const days = clamp(cur + (key === ']' ? 1 : -1), 0, max);
      return days === s.days ? null : { patch: { days } };
    }
    case '0':
      return { reset: true };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- レール（段 B）

/** IV レールの上下の余白（px） */
export const IV_RAIL_PAD = 22;
/** 時間レールの左右の余白（px） */
export const TIME_RAIL_PAD = 12;
/** 時間レールの目盛りをタップで拾う幅（左右 px） */
export const TICK_PICK_PX = 10;

const DSIGMA = sliderSpec('dSigma', { x0: 1, maxDays: 0, dXUnit: 'yen' });
const snapHalf = (v: number) => Number((Math.round(v / DSIGMA.step) * DSIGMA.step).toFixed(10));

/** Δσ → IV レールの縦の画素（上端 = +40、下端 = −10）。 */
export function ivRailY(v: number, h: number): number {
  const top = IV_RAIL_PAD;
  const bot = h - IV_RAIL_PAD;
  if (!(bot > top)) return h / 2;
  const c = clamp(Number.isFinite(v) ? v : 0, DSIGMA.min, DSIGMA.max);
  return bot - ((c - DSIGMA.min) / (DSIGMA.max - DSIGMA.min)) * (bot - top);
}

/** IV レールの縦の画素 → Δσ（0.5 の格子・−10〜+40 で止める）。 */
export function ivRailValue(y: number, h: number): number {
  const top = IV_RAIL_PAD;
  const bot = h - IV_RAIL_PAD;
  if (!(bot > top) || !Number.isFinite(y)) return 0;
  const v = DSIGMA.min + ((bot - y) / (bot - top)) * (DSIGMA.max - DSIGMA.min);
  const s = clamp(snapHalf(v), DSIGMA.min, DSIGMA.max);
  return s === 0 ? 0 : s;
}

/** d → 時間レールの横の画素（0 → 左端、maxDays → 右端。maxDays ≤ 0 は左端）。 */
export function timeRailX(d: number, w: number, maxDays: number): number {
  const left = TIME_RAIL_PAD;
  const span = w - 2 * TIME_RAIL_PAD;
  if (!(maxDays > 0) || !(span > 0)) return left;
  return left + (clamp(Number.isFinite(d) ? d : 0, 0, maxDays) / maxDays) * span;
}

/** 時間レールの横の画素 → d（1 日の格子・[0, maxDays] で止める。maxDays の端数は右端でそのまま）。 */
export function timeRailValue(x: number, w: number, maxDays: number): number {
  const span = w - 2 * TIME_RAIL_PAD;
  if (!(maxDays > 0) || !(span > 0) || !Number.isFinite(x)) return 0;
  const raw = ((x - TIME_RAIL_PAD) / span) * maxDays;
  // 右端（とその外）は上限そのもの（最遠の SQ。端数あり）
  return raw >= maxDays ? maxDays : clamp(Math.round(raw), 0, maxDays);
}

export interface TimeRailTick {
  id: string;
  kind: 'last' | 'sq';
  /** その時刻に置く d（daysToTarget。端数あり） */
  days: number;
  x: number;
  /** 限月 + SQ 日（SQ だけ。隣と重なれば null = 点だけ） */
  label: string | null;
  /** 文字の位置（端に入らなければ寄せる） */
  labelX: number;
  anchor: 'start' | 'middle' | 'end';
}

/** 目盛りの文字の間隔（px） */
const TICK_LABEL_GAP = 4;

/**
 * 時間レールの目盛り（§5）: 足の限月ごとの取引最終日（15:45）・SQ（9:00）。d は daysToTarget（評価時刻以前の
 * ものは出さない）。文字は SQ だけ「11月 SQ 11/13」。左から見て前の文字と重なる文字は出さない（点は残す）。
 */
export function timeRailTicks(
  targets: readonly EvalTimeTarget[],
  evalTime: number,
  maxDays: number,
  w: number,
): TimeRailTick[] {
  const out: TimeRailTick[] = [];
  if (!(maxDays > 0)) return out;
  for (const t of targets) {
    const last = daysToTarget(evalTime, t.lastTradeClose, maxDays);
    if (last !== null) {
      const x = timeRailX(last, w, maxDays);
      out.push({
        id: `${t.id}:last`,
        kind: 'last',
        days: last,
        x,
        label: null,
        labelX: x,
        anchor: 'middle',
      });
    }
    const sq = daysToTarget(evalTime, t.sqTime, maxDays);
    if (sq !== null) {
      const x = timeRailX(sq, w, maxDays);
      const month = Number(t.id.slice(5, 7));
      const label = `${Number.isFinite(month) ? month : t.id}月 SQ ${fmtMD(t.sqTime)}`;
      out.push({ id: `${t.id}:sq`, kind: 'sq', days: sq, x, label, labelX: x, anchor: 'middle' });
    }
  }
  out.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  // 文字の位置（端で寄せる）と重なりの省略（左から）
  let prevRight = Number.NEGATIVE_INFINITY;
  for (const tick of out) {
    if (tick.label === null) continue;
    const lw = labelWidth(tick.label);
    let l = tick.x - lw / 2;
    let anchor: TimeRailTick['anchor'] = 'middle';
    let labelX = tick.x;
    if (l < 0) {
      l = Math.max(tick.x - TIME_RAIL_PAD, 0);
      anchor = 'start';
      labelX = l;
    } else if (tick.x + lw / 2 > w) {
      l = Math.min(tick.x + TIME_RAIL_PAD, w) - lw;
      anchor = 'end';
      labelX = l + lw;
    }
    if (l < prevRight + TICK_LABEL_GAP) {
      tick.label = null;
      continue;
    }
    tick.labelX = labelX;
    tick.anchor = anchor;
    prevRight = l + lw;
  }
  return out;
}

/** 時間レールのタップの位置 → d: 目盛りの ±10px なら最も近い目盛りの d（端数あり）、それ以外は 1 日の格子。 */
export function railPick(
  x: number,
  ticks: readonly TimeRailTick[],
  w: number,
  maxDays: number,
): number {
  let best: TimeRailTick | null = null;
  for (const t of ticks) {
    const d = Math.abs(t.x - x);
    if (d <= TICK_PICK_PX && (best === null || d < Math.abs(best.x - x))) best = t;
  }
  return best ? best.days : timeRailValue(x, w, maxDays);
}

const WEEKDAYS = '日月火水木金土';

/**
 * 時間レールの現在値の文言（§5.2）: 「d N 日 · MM/DD HH:mm（曜）」。日時は評価時刻 + d の JST。
 * 評価時刻が無ければ「d N 日」だけ。
 */
export function timeRailText(days: number, evalTime: number | null): string {
  const d = Number.isFinite(days) ? Math.round(days * 100) / 100 : 0;
  if (evalTime === null || !Number.isFinite(evalTime)) return `d ${d} 日`;
  const t = evalInstant(evalTime, Number.isFinite(days) ? days : 0);
  const s = fmtDateTime(t);
  if (s === DASH) return `d ${d} 日`;
  const wd = WEEKDAYS[new Date(t + 9 * 3_600_000).getUTCDay()] ?? '';
  return `d ${d} 日 · ${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11)}（${wd}）`;
}

/**
 * 時間レールの左端の「今 MM/DD」（評価時刻）。目盛りの文字と重なるとき・評価時刻が無いときは null。
 */
export function timeRailNow(
  evalTime: number | null,
  ticks: readonly TimeRailTick[],
): { label: string; x: number } | null {
  if (evalTime === null || !Number.isFinite(evalTime)) return null;
  const label = `今 ${fmtMD(evalTime)}`;
  const x = Math.max(TIME_RAIL_PAD - 6, 0);
  const right = x + labelWidth(label) + TICK_LABEL_GAP;
  for (const t of ticks) {
    if (t.label === null) continue;
    const w = labelWidth(t.label);
    const l =
      t.anchor === 'start' ? t.labelX : t.anchor === 'end' ? t.labelX - w : t.labelX - w / 2;
    if (l < right) return null;
  }
  return { label, x };
}

/** 時間レールの吹き出しの文字（11px）と幅の見積もり（10px の labelWidth）の比・左右の余白（px） */
const BUBBLE_FONT_RATIO = 1.1;
const BUBBLE_PAD = 5;

export interface TimeRailLayout {
  /** 吹き出しの中心と左右の端（レールの座標。文字の行に置き、描画域の目盛りの文字に重ねない） */
  bubble: { x: number; x0: number; x1: number };
  /** 吹き出しと重なる文字を消した目盛り（点は残す） */
  ticks: TimeRailTick[];
  /** 左端の「今 MM/DD」（吹き出しと重なれば null） */
  now: { label: string; x: number } | null;
}

/**
 * 時間レールの文字の行の配置（#82 のレビュー S4）: 現在値の吹き出しはつまみの下の文字の行（目盛りの文字と同じ行）に、
 * つまみの位置を中心にレールの幅の中へ収めて置く。吹き出しと重なる目盛りの文字・「今 MM/DD」は出さない
 * （吹き出しの日時が優先）。描画域（横軸の目盛りの文字）には重ねない。
 */
export function timeRailLayout(
  ticks: readonly TimeRailTick[],
  now: { label: string; x: number } | null,
  kx: number,
  text: string,
  w: number,
): TimeRailLayout {
  const half = (labelWidth(text) * BUBBLE_FONT_RATIO) / 2 + BUBBLE_PAD;
  const x = Math.min(Math.max(kx, half), Math.max(w - half, half));
  const x0 = x - half;
  const x1 = x + half;
  const clear = (l: number, r: number) => r + TICK_LABEL_GAP <= x0 || l - TICK_LABEL_GAP >= x1;
  const out = ticks.map((t) => {
    if (t.label === null) return t;
    const lw = labelWidth(t.label);
    const l =
      t.anchor === 'start' ? t.labelX : t.anchor === 'end' ? t.labelX - lw : t.labelX - lw / 2;
    return clear(l, l + lw) ? t : { ...t, label: null };
  });
  const nowOk = now !== null && clear(now.x, now.x + labelWidth(now.label));
  return { bubble: { x, x0, x1 }, ticks: out, now: nowOk ? now : null };
}

/**
 * IV レールの感度の上限（pt / px。#82 のレビュー）。レールが短い（トラック < 200px）と押した位置の値にすると
 * 1px で 0.25pt を超えて動くので、そのときは押した位置に飛ばさず、縦の移動量 × この値だけ動かす（相対）。
 */
export const IV_RAIL_MAX_RATE = 0.25;

/** レールの高さ h で、押した位置の値にする（絶対）か、移動量で動かす（相対）か */
export function ivRailRelative(h: number): boolean {
  const span = h - 2 * IV_RAIL_PAD;
  return !(span > 0) || (DSIGMA.max - DSIGMA.min) / span > IV_RAIL_MAX_RATE;
}

/** 相対のドラッグ: 押したときの値 v0 から縦の移動量 dy（下向き正）× IV_RAIL_MAX_RATE（0.5 の格子・範囲で止める） */
export function ivRailDragValue(v0: number, dy: number): number {
  const start = Number.isFinite(v0) ? v0 : 0;
  const s = clamp(
    snapHalf(start - (Number.isFinite(dy) ? dy : 0) * IV_RAIL_MAX_RATE),
    DSIGMA.min,
    DSIGMA.max,
  );
  return s === 0 ? 0 : s;
}

/** IV レールの吹き出しの文字（11px）と幅の見積もり（10px の labelWidth）の比・高さ（px） */
const IV_BUBBLE_FONT_RATIO = 1.1;
const IV_BUBBLE_H = 15;

/**
 * IV レールの現在値の吹き出し（「Δσ +2.0pt」）。レールの左に描画域へはみ出して描く。right = 吹き出しの右端と
 * レールの左端の距離（px）、w = 箱の幅、y = 中心。描画域の座標の箱は ivRailObstacle（交点のラベルが避ける）。
 */
export function ivRailBubble(v: number, h: number): { text: string; w: number; y: number } {
  const text = `Δσ ${fmtSigned(Number.isFinite(v) ? v : 0, 1)}pt`;
  return { text, w: labelWidth(text) * IV_BUBBLE_FONT_RATIO + 8, y: ivRailY(v, h) };
}

/** IV レールの吹き出しの箱（描画域の SVG の座標。レールは描画域の要素の右隣・同じ高さ。railLeft = 描画域の要素の幅 + offsetX） */
export function ivRailObstacle(v: number, h: number, railLeft: number): MarkObstacle {
  const b = ivRailBubble(v, h);
  return {
    x0: railLeft - 4 - b.w,
    x1: railLeft - 4,
    y0: b.y - IV_BUBBLE_H / 2,
    y1: b.y + IV_BUBBLE_H / 2,
  };
}

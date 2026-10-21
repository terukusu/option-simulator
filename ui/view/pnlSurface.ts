/**
 * 損益の面（ヒートマップ。docs/ui-redesign.md §6・§8・§11 決定 2。#88 段 A）の表示モデル（純関数）。
 *
 * - 格子: 横 = 線と同じ表示範囲（pnlViewDomain）を nx 等分、縦 = d の 0（下 = 今日）〜 maxDays（上 = 最遠の SQ）を
 *   ny 等分。値はセルの中心の theoreticalPnl（指定日の線と同じ式。新しい計算は無い）
 * - ΔX・d は面の値に効かない（β は評価点ごと）。作り直すのは基礎・表示範囲・Δσ・Δs・β・動き方・ivShift が
 *   変わったときだけ（planSurface）。変わったフレームは粗い格子、止まったら細かい格子で 1 回
 * - 色: 符号で gain / loss の RGB（引数）、不透明度 = A_MAX × (|v| / vmax)^0.6（0 で透明）。ImageData は使わず
 *   Uint8ClampedArray の RGBA を返す（描くのは ui/next/stage/SurfaceCanvas.tsx）
 * - 色の文字列は CSS 変数を getComputedStyle で読んだもの（parseCssColor）。このファイルに色の値を書かない
 * - 面の上のドラッグ（#88 段 B。決定 3）: 指の位置 → (ΔX, d) は surfaceDragPatch（ΔX はハンドルと同じ dXFromAxis、
 *   d は時間レールと同じ規則の surfaceDayAt）。面モードかどうかは surfaceActive
 */

import { type Scenario, theoreticalPnl } from '../../model';
import type { Domain } from '../chart/scale';
import { niceTicks, pixelToValue } from '../chart/scale';
import { PIN_SETTLE_MS } from '../pins';
import { type CrossTagBox, crossTagX, crossTagY } from './crosshair';
import { DASH, fmtNum } from './format';
import { AMOUNT_UNIT_LABEL, type AmountUnit, fmtAmount } from './metrics';
import { clampDays, type PnlBase, type PnlChartModel, pnlViewDomain } from './pnlChart';
import { CROSS_X_STEP, crossX } from './pnlCrosshair';
import { dXFromAxis } from './scenario';
import { labelWidth } from './scenarioMarks';
import type { ChartMode } from './shell';
import { MARKER_BAND_PX as MARKER_BAND, type MarkObstacle, type StageHandle } from './stage';

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** 細かい格子（止まったとき）・粗い格子（入力が変わったフレーム）。§6 */
export const SURFACE_FINE = { nx: 72, ny: 36 } as const;
export const SURFACE_COARSE = { nx: 48, ny: 24 } as const;
/** 入力が変わってから細かい格子にするまでの待ち（ms。ピンの線と同じ値） */
export const SURFACE_SETTLE_MS = PIN_SETTLE_MS;
/** 不透明度の最大（0〜255。試作品の最大 210/255）と濃さの指数 */
export const SURFACE_A_MAX = 210;
export const SURFACE_GAMMA = 0.6;
/** 縦軸の単位 */
export const SURFACE_Y_UNIT = '日';

export type SurfaceRes = 'coarse' | 'fine';
export type Rgb = readonly [number, number, number];
export interface SurfaceColors {
  gain: Rgb;
  loss: Rgb;
}

// ---------------------------------------------------------------- 格子

export interface SurfaceGrid {
  res: SurfaceRes;
  nx: number;
  ny: number;
  lo: number;
  hi: number;
  maxDays: number;
  /** セル (i, j) の値は values[j * nx + i]。j = 0 が d の最小（下）。非有限は NaN */
  values: Float64Array;
  /** 有限の |v| の最大（無ければ 0） */
  vmax: number;
}

/** 面の 1 点の値（円）= 指定日の線と同じ theoreticalPnl(base.legs, x, { ...scenario, days: d }) */
export function surfaceValueAt(base: PnlBase, scenario: Scenario, x: number, d: number): number {
  return theoreticalPnl(base.legs, x, { ...scenario, days: d }, base.ctx, base.settings);
}

/** 格子（base null・maxDays ≤ 0 は null）。scenario の dX・days は値に効かない */
export function surfaceGrid(
  base: PnlBase | null,
  scenario: Scenario,
  viewport: Domain | null,
  res: SurfaceRes,
): SurfaceGrid | null {
  if (!base || !(base.maxDays > 0)) return null;
  const { nx, ny } = res === 'fine' ? SURFACE_FINE : SURFACE_COARSE;
  const [lo, hi] = pnlViewDomain(base, viewport);
  const { maxDays } = base;
  const values = new Float64Array(nx * ny);
  let vmax = 0;
  for (let j = 0; j < ny; j++) {
    const d = (maxDays * (j + 0.5)) / ny;
    for (let i = 0; i < nx; i++) {
      const x = lo + ((hi - lo) * (i + 0.5)) / nx;
      const v = surfaceValueAt(base, scenario, x, d);
      if (Number.isFinite(v)) {
        values[j * nx + i] = v;
        const a = Math.abs(v);
        if (a > vmax) vmax = a;
      } else values[j * nx + i] = Number.NaN;
    }
  }
  return { res, nx, ny, lo, hi, maxDays, values, vmax };
}

// ---------------------------------------------------------------- 粗い / 細かい

export interface SurfaceDeps {
  base: PnlBase;
  lo: number;
  hi: number;
  /** dX = 0・days = 0 に置いたシナリオ（値に効く欄だけを比べる） */
  scenario: Scenario;
}

export interface SurfacePlan {
  deps: SurfaceDeps;
  res: SurfaceRes;
  settle: number;
}

/** 面の値の入力（base null・maxDays ≤ 0 は null） */
export function surfaceDeps(
  base: PnlBase | null,
  scenario: Scenario,
  viewport: Domain | null,
): SurfaceDeps | null {
  if (!base || !(base.maxDays > 0)) return null;
  const [lo, hi] = pnlViewDomain(base, viewport);
  return { base, lo, hi, scenario: { ...scenario, dX: 0, days: 0 } };
}

/** 同じ面になるか（base は参照、lo / hi と scenario の dX・days 以外の欄は ===） */
export function sameSurfaceDeps(a: SurfaceDeps, b: SurfaceDeps): boolean {
  if (a.base !== b.base || a.lo !== b.lo || a.hi !== b.hi) return false;
  const sa = a.scenario as unknown as Record<string, unknown>;
  const sb = b.scenario as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
  for (const k of keys) {
    if (k === 'dX' || k === 'days') continue;
    if (sa[k] !== sb[k]) return false;
  }
  return true;
}

/**
 * 次に作る格子の計画（§6）: 前が無い → 細かい（最初の 1 枚）、入力が変わった → 粗い、同じで粗いまま settle が
 * 進んだ（120ms 止まった）→ 細かい、それ以外 → 前と同じ参照（作り直さない）。
 */
export function planSurface(
  prev: SurfacePlan | null,
  deps: SurfaceDeps | null,
  settle: number,
): SurfacePlan | null {
  if (!deps) return null;
  if (!prev) return { deps, res: 'fine', settle };
  if (!sameSurfaceDeps(prev.deps, deps)) return { deps, res: 'coarse', settle };
  if (prev.res === 'coarse' && settle !== prev.settle) {
    return { deps: prev.deps, res: 'fine', settle };
  }
  return prev;
}

// ---------------------------------------------------------------- 色

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNC = /^rgba?\(([^)]*)\)$/i;

/** 色の文字列（16 進の 3 桁 / 6 桁、rgb の関数形式（空白 / カンマ区切り、4 番目は無視））→ RGB。読めなければ null */
export function parseCssColor(s: string): Rgb | null {
  const t = s.trim();
  const h = HEX.exec(t);
  if (h) {
    const v = h[1] as string;
    const full =
      v.length === 3
        ? v
            .split('')
            .map((c) => c + c)
            .join('')
        : v;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }
  const f = FUNC.exec(t);
  if (!f) return null;
  const parts = (f[1] as string)
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map((p) => {
    if (!/^-?\d+(\.\d+)?%?$/.test(p)) return Number.NaN;
    const n = Number.parseFloat(p);
    return p.endsWith('%') ? (n * 255) / 100 : n;
  });
  if (rgb.some((n) => !Number.isFinite(n))) return null;
  return rgb.map((n) => Math.round(clamp(n, 0, 255))) as unknown as Rgb;
}

/** 不透明度（0〜255 の整数）= round(A_MAX × min(|v| / vmax, 1)^0.6)。vmax < 1 円・非有限は 0 */
export function surfaceAlpha(v: number, vmax: number): number {
  if (!(vmax >= 1) || !Number.isFinite(v)) return 0;
  const t = Math.min(Math.abs(v) / vmax, 1);
  return Math.round(SURFACE_A_MAX * t ** SURFACE_GAMMA);
}

export interface SurfaceImage {
  nx: number;
  ny: number;
  /** RGBA（長さ nx × ny × 4）。行は上から（先頭行 = d の最大、最終行 = d の最小） */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** 格子の色のバッファ。v > 0 → gain、v < 0 → loss、0・NaN → 透明 */
export function surfaceImage(grid: SurfaceGrid, colors: SurfaceColors): SurfaceImage {
  const { nx, ny, values, vmax } = grid;
  const data = new Uint8ClampedArray(nx * ny * 4);
  for (let r = 0; r < ny; r++) {
    const j = ny - 1 - r;
    for (let i = 0; i < nx; i++) {
      const v = values[j * nx + i] as number;
      const a = v === 0 ? 0 : surfaceAlpha(v, vmax);
      if (a === 0) continue;
      const c = v > 0 ? colors.gain : colors.loss;
      const o = (r * nx + i) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = a;
    }
  }
  return { nx, ny, data };
}

// ---------------------------------------------------------------- 縦軸

type Plot = PnlChartModel['plot'];

/** d → 縦の画素（下端 = 0、上端 = maxDays。[0, maxDays] に収める。maxDays ≤ 0 は下端） */
export function surfaceDayPy(d: number, plot: Plot, maxDays: number): number {
  const bottom = plot.top + plot.height;
  if (!(maxDays > 0)) return bottom;
  const c = clamp(Number.isFinite(d) ? d : 0, 0, maxDays);
  return bottom - (c / maxDays) * plot.height;
}

/** 縦の画素 → d（1 日の格子。上端とその外は maxDays そのもの。時間レールの timeRailValue と同じ規則） */
export function surfaceDayAt(py: number, plot: Plot, maxDays: number): number {
  if (!(maxDays > 0) || !(plot.height > 0) || !Number.isFinite(py)) return 0;
  const raw = ((plot.top + plot.height - py) / plot.height) * maxDays;
  return raw >= maxDays ? maxDays : clamp(Math.round(raw), 0, maxDays);
}

export interface SurfaceTick {
  v: number;
  py: number;
  label: string;
}

/** 単位「日」（描画域の左上）と重ならないよう、上端からこの距離（px）より上の目盛りは出さない */
export const SURFACE_TICK_TOP_GAP = 12;

/** 縦の目盛り（0 を含む [0, maxDays] の整数の日。昇順・重複なし。上端の単位にかかる目盛りは除く） */
export function surfaceDayTicks(plot: Plot, maxDays: number): SurfaceTick[] {
  if (!(maxDays > 0)) return [];
  const count = clamp(Math.floor(plot.height / 32), 2, 6);
  const vs = new Set<number>([0]);
  for (const v of niceTicks(0, maxDays, count)) {
    if (Number.isInteger(v) && v >= 0 && v <= maxDays) vs.add(v);
  }
  return [...vs]
    .sort((a, b) => a - b)
    .map((v) => ({ v, py: surfaceDayPy(v, plot, maxDays), label: String(v) }))
    .filter((t) => t.v === 0 || t.py >= plot.top + SURFACE_TICK_TOP_GAP);
}

// ---------------------------------------------------------------- 点とラベル

/** 点からラベルの箱までの間隔（px）・箱の高さ（px）・文字（11px）と幅の見積もり（10px）の比 */
const POINT_GAP = 10;
const POINT_LABEL_H = 14;
const POINT_FONT_RATIO = 1.15;

export interface SurfacePointView {
  px: number;
  py: number;
  /** 描いた d（最遠の SQ に収めたもの） */
  days: number;
  /** 点の損益（円） */
  value: number;
  text: string;
  /** ラベルの位置（text-anchor の側・縦は中心） */
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
  box: MarkObstacle;
}

export interface SurfacePointInput {
  base: PnlBase | null;
  scenario: Scenario;
  chart: PnlChartModel;
  handle: StageHandle | null;
  unit: AmountUnit;
  obstacles?: readonly MarkObstacle[];
}

const overlaps = (a: MarkObstacle, b: MarkObstacle) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** 点のラベルの文言: 金額 + 単位（— / ∞ は単位なし）+ ' · d ' + d（小数 2 桁で丸め） */
export function surfacePointText(value: number, days: number, unit: AmountUnit): string {
  const s = fmtAmount(value, unit, true);
  const u = s === DASH || s.endsWith('∞') ? '' : AMOUNT_UNIT_LABEL[unit];
  return `${s}${u} · d ${Math.round(days * 100) / 100}`;
}

/**
 * シナリオ点（§8）: 横 = ハンドルの画素、縦 = 描いた d の画素。値 = (X₀ + ΔX, d) の theoreticalPnl（読み取りの
 * 「損益 · 指定日」と同じ数）。ラベルは 右上 → 左上 → 右下 → 左下 の順で、描画域の中かつ obstacles と交わらない
 * 最初の位置。どれも無ければ右上を描画域に収めた位置。handle・base が無い・空は null。
 */
export function surfacePoint(input: SurfacePointInput): SurfacePointView | null {
  const { base, scenario, chart, handle, unit } = input;
  if (!base || !handle || chart.empty) return null;
  const { plot } = chart;
  const { days } = clampDays(scenario, base.maxDays);
  const dX = Number.isFinite(scenario.dX) ? scenario.dX : 0;
  const value = surfaceValueAt(base, scenario, base.ctx.x0 + dX, days);
  const px = handle.px;
  const py = surfaceDayPy(days, plot, base.maxDays);
  const text = surfacePointText(value, days, unit);
  const w = labelWidth(text) * POINT_FONT_RATIO;
  const h = POINT_LABEL_H;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const boxAt = (side: 'start' | 'end', up: boolean): MarkObstacle => {
    const x0 = side === 'start' ? px + POINT_GAP : px - POINT_GAP - w;
    const y0 = up ? py - POINT_GAP - h : py + POINT_GAP;
    return { x0, x1: x0 + w, y0, y1: y0 + h };
  };
  const inside = (b: MarkObstacle) =>
    b.x0 >= plot.left && b.x1 <= right && b.y0 >= plot.top && b.y1 <= bottom;
  const obstacles = input.obstacles ?? [];
  const tries: Array<['start' | 'end', boolean]> = [
    ['start', true],
    ['end', true],
    ['start', false],
    ['end', false],
  ];
  let pick: { box: MarkObstacle; anchor: 'start' | 'end' } | null = null;
  for (const [side, up] of tries) {
    const box = boxAt(side, up);
    if (inside(box) && !obstacles.some((o) => overlaps(o, box))) {
      pick = { box, anchor: side };
      break;
    }
  }
  if (!pick) {
    const b = boxAt('start', true);
    const x0 = clamp(b.x0, plot.left, Math.max(plot.left, right - w));
    const y0 = clamp(b.y0, plot.top, Math.max(plot.top, bottom - h));
    pick = { box: { x0, x1: x0 + w, y0, y1: y0 + h }, anchor: 'start' };
  }
  const { box, anchor } = pick;
  return {
    px,
    py,
    days,
    value,
    text,
    labelX: anchor === 'start' ? box.x0 : box.x1,
    labelY: (box.y0 + box.y1) / 2,
    anchor,
    box,
  };
}

// ---------------------------------------------------------------- 凡例

export interface SurfaceLegend {
  long: string;
  short: string;
  /** 「±{vmax}{単位}」（vmax が無い・< 1 円は null） */
  vmax: string | null;
}

export function surfaceLegend(vmax: number | null, unit: AmountUnit): SurfaceLegend {
  return {
    long: '損益の面（横 原資産 · 縦 経過日数）',
    short: '損益の面',
    vmax:
      vmax !== null && Number.isFinite(vmax) && vmax >= 1
        ? `±${fmtAmount(vmax, unit)}${AMOUNT_UNIT_LABEL[unit]}`
        : null,
  };
}

// ---------------------------------------------------------------- 面モードの判定・面の上のドラッグ（段 B）

/** 面モードで描くか（線モード・ミニ・空（評価できる足が無い）は false = 格子を作らない・線モードの表示） */
export function surfaceActive(chart: ChartMode, mini: boolean, empty: boolean): boolean {
  return chart === 'surface' && !mini && !empty;
}

/** この画素未満の動きは「その軸は動いていない」とみなして今の値を保つ（端数の d・格子の外の ΔX を丸めない） */
const SURFACE_KEEP_PX = 0.5;

export interface SurfaceDragInput {
  /** 指の位置（.chart 要素の座標の画素） */
  x: number;
  y: number;
  chart: PnlChartModel;
  /** SVG の座標 − 要素の座標（StageFrame の offsetX / offsetY） */
  offsetX: number;
  offsetY: number;
  x0: number;
  maxDays: number;
  scenario: Scenario;
  /** 今の点の画素（要素の座標。無ければ null） */
  pointPx: { x: number; y: number } | null;
}

/**
 * 面の上の点の位置 → シナリオの patch（§4.1・決定 3）。位置は描画域に収め（軸の文字の上を押しても描画域の端）、
 * ΔX = dXFromAxis（10 円の格子・範囲で止める）、d = surfaceDayAt（1 日の格子・上端とその外は maxDays そのもの）。
 * 軸ごとに、位置が今の点の画素から 0.5px 未満なら今の値を保つ。変わる欄だけ。無ければ null。
 */
export function surfaceDragPatch(input: SurfaceDragInput): { dX?: number; days?: number } | null {
  const { x, y, chart, offsetX, offsetY, x0, maxDays, scenario, pointPx } = input;
  const { plot } = chart;
  const out: { dX?: number; days?: number } = {};
  if (Number.isFinite(x) && !(pointPx && Math.abs(x - pointPx.x) < SURFACE_KEEP_PX)) {
    const range: Domain = [plot.left - offsetX, plot.left + plot.width - offsetX];
    const px = clamp(x, range[0], range[1]);
    const dX = dXFromAxis(pixelToValue(chart.domain, range, px), x0);
    if (dX !== null && dX !== scenario.dX) out.dX = dX;
  }
  if (
    maxDays > 0 &&
    Number.isFinite(y) &&
    !(pointPx && Math.abs(y - pointPx.y) < SURFACE_KEEP_PX)
  ) {
    const py = clamp(y + offsetY, plot.top, plot.top + plot.height);
    const days = surfaceDayAt(py, plot, maxDays);
    if (days !== scenario.days) out.days = days;
  }
  return out.dX === undefined && out.days === undefined ? null : out;
}

// ---------------------------------------------------------------- 十字線（#217。PC のホバーだけ）

/** 面の十字線のカーソル（値の座標: x = 原資産の円、d = 経過日数。1 日の格子・上端は maxDays そのもの） */
export interface SurfaceCursor {
  x: number;
  d: number;
}

export interface SurfaceCrosshair {
  /** X（10 円の格子）・d（1 日の格子） */
  x: number;
  d: number;
  px: number;
  py: number;
  /** (X, d) の損益（円。surfaceValueAt = 指定日の線と同じ評価） */
  value: number;
  xTag: CrossTagBox;
  yTag: CrossTagBox;
  read: { text: string; x: number; y: number; anchor: 'start' | 'end'; box: MarkObstacle };
}

export interface SurfaceCrosshairInput {
  base: PnlBase | null;
  scenario: Scenario;
  chart: PnlChartModel;
  cursor: SurfaceCursor | null;
  unit: AmountUnit;
  /** svg の幅・高さ（札を内側に寄せる） */
  width: number;
  height: number;
  /** 読み取りが避ける箱（点のラベル・IV レールの吹き出し） */
  obstacles?: readonly MarkObstacle[];
}

/** 画素（svg の座標）→ カーソル。描画域の外は null（ホバー。外れて消す） */
export function surfaceCursorAt(
  chart: PnlChartModel,
  maxDays: number,
  sx: number,
  sy: number,
): SurfaceCursor | null {
  if (chart.empty || !(maxDays > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  const { plot } = chart;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  if (sx < plot.left || sx > right || sy < plot.top || sy > bottom) return null;
  return {
    x: pixelToValue(chart.domain, [plot.left, right], sx),
    d: surfaceDayAt(sy, plot, maxDays),
  };
}

/**
 * 面の十字線（#217。docs/ui-redesign.md §4.1）: 縦線 = X（10 円の格子 = ΔX と同じ）、横線 = d（1 日の格子 = 面の点・時間レールと
 * 同じ）。両方の軸が入力の格子なので吸着する。札 = X（円の整数）・d（日）、読み取り = (X, d) の損益（点のラベルと同じ形・指標の単位）を
 * 縦線と反対の側の上端（障害物に重なれば下端）。X が表示範囲の外・maxDays ≤ 0・空は null
 */
export function surfaceCrosshair(p: SurfaceCrosshairInput): SurfaceCrosshair | null {
  const { base, chart, cursor } = p;
  if (!base || chart.empty || !cursor || !(base.maxDays > 0)) return null;
  if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.d)) return null;
  const [lo, hi] = chart.domain;
  if (!(cursor.x >= lo && cursor.x <= hi)) return null;
  const gLo = Math.ceil(lo / CROSS_X_STEP) * CROSS_X_STEP;
  const gHi = Math.floor(hi / CROSS_X_STEP) * CROSS_X_STEP;
  const x = gLo <= gHi ? clamp(crossX(cursor.x), gLo, gHi) : cursor.x;
  const d = clamp(cursor.d, 0, base.maxDays);
  const { plot } = chart;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const px = r1(plot.left + ((x - lo) / (hi - lo)) * plot.width);
  const py = r1(surfaceDayPy(d, plot, base.maxDays));
  const value = surfaceValueAt(base, p.scenario, x, d);
  const text = surfacePointText(value, d, p.unit);
  const w = labelWidth(text) * POINT_FONT_RATIO;
  const h = POINT_LABEL_H;
  const leftSide = px > plot.left + plot.width / 2;
  const x0 = leftSide ? plot.left + 4 : right - 4 - w;
  const at = (y0: number): MarkObstacle => ({ x0, x1: x0 + w, y0, y1: y0 + h });
  const first = at(plot.top + 4);
  const second = at(Math.max(plot.top + 4, bottom - MARKER_BAND - 4 - h));
  const blocked = (b: MarkObstacle) => (p.obstacles ?? []).some((o) => overlaps(o, b));
  const box = blocked(first) && !blocked(second) ? second : first;
  const dText = `${Math.round(d * 100) / 100}日`;
  return {
    x,
    d,
    px,
    py,
    value,
    xTag: crossTagX(fmtNum(x, 0), px, bottom + 3, p.width, p.height),
    yTag: crossTagY(dText, py, plot.left - 1, p.width, p.height),
    read: {
      text,
      x: r1(leftSide ? box.x0 : box.x1),
      y: r1((box.y0 + box.y1) / 2),
      anchor: leftSide ? 'start' : 'end',
      box,
    },
  };
}

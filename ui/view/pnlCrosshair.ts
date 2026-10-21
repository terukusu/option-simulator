/**
 * 損益グラフの十字線（#201。純関数）。設計 docs/ui-redesign.md §4.1・docs/design.md 13.4。
 *
 * - カーソルは値の座標（X = 原資産の円、level = 損益の円）。パン・拡大でも同じ X・損益に残り、X が表示範囲の外なら
 *   十字線なし、損益が縦軸の範囲の外なら横線と縦軸の札なし
 * - 縦線 = X（10 円の格子に丸める）。横線は線に吸着しない（IV 推移の #130 と同じ。任意の水準を調べる）
 * - 線の値は描いている線（満期・指定日・今日）の X での損益（シナリオ点の交点と同じ評価 = lineValuesAt）。
 *   縦軸の範囲の内側なら線の上に点
 * - 横軸の札 = X（円の整数）を目盛りの行に、縦軸の札 = 横線の高さの損益（グラフの縦軸の単位 = 千円 / 円。目盛りと同じく
 *   符号は − だけ）を目盛りの列に。札は IV 推移と同じ大きさ（IV_TAG_H・文字幅の見積もり labelPx）で svg の内側へ寄せる
 * - 読み取り = 線ごとの 1 行（`満 / 指 / 今` + 符号つきの金額 + 単位。単位はグラフの縦軸の単位。範囲外は ▲ / ▼）を
 *   積み上げた箱。縦線と反対の側（左右）の上端。箱が縦線に届き、横線・点を覆うなら下端（足マーカーの帯の上）。箱が障害物
 *   （IV レールの吹き出し・追証の札・交点のラベル）に重なるならもう一方の高さ。タッチで置いた十字線（pinned）は箱の右上に × を出す。
 *   消すのは × を含むほかの所のタップ（#217。移さない）
 */

import type { Scenario } from '../../model';
import { type Domain, linear } from '../chart/scale';
import { fmtNum } from './format';
import { IV_TAG_H, IV_TAG_PAD_X, IV_TAG_PAD_Y, labelPx } from './ivHistory';
import { fmtAmount } from './metrics';
import type { PnlBase, PnlChartModel, PnlLineKind } from './pnlChart';
import { labelWidth, lineValuesAt, type MarkEdge, markText } from './scenarioMarks';
import { MARKER_BAND_PX, type MarkObstacle } from './stage';

/** X の格子（円。ΔX と同じ 10 円） */
export const CROSS_X_STEP = 10;
/** 読み取りの 1 行の高さ（px。11px の文字） */
export const READ_ROW = 14;
/** 読み取りの箱の内側の余白・描画域の端からの距離（px） */
export const READ_PAD = 4;
/** × の幅（px。pinned のとき箱の右に足す） */
export const READ_CLOSE_W = 16;
/** 交点をつかむ距離（px。舞台のハンドルと同じ） */
export const CROSS_GRAB_PX = 14;
/** 11px の文字の幅（labelWidth は 10px の見積もり） */
const READ_FONT_RATIO = 1.1;

/** カーソル（値の座標）。pinned = タッチで置いた（× を出し、交点をつかめる） */
export interface PnlCursor {
  x: number;
  y: number;
  pinned: boolean;
}

export interface CrossTag {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface CrossReadItem {
  kind: PnlLineKind;
  /** 損益（円） */
  value: number;
  text: string;
  /** 文字の中心の y（dominant-baseline: central） */
  y: number;
}

export interface PnlCrosshair {
  /** X（10 円の格子） */
  x: number;
  /** 縦線の画素 */
  px: number;
  /** 横線の損益（円。縦軸の範囲の外なら null） */
  level: number | null;
  /** 横線の画素（level が null なら null） */
  py: number | null;
  xTag: CrossTag;
  yTag: CrossTag | null;
  /** 線の上の点（縦軸の範囲の内側の線だけ） */
  dots: Array<{ kind: PnlLineKind; py: number }>;
  read: {
    items: CrossReadItem[];
    /** 文字の x（anchor の基準） */
    textX: number;
    anchor: 'start' | 'end';
    /** × の中心（pinned のときだけ） */
    close: { x: number; y: number } | null;
    box: MarkObstacle;
  };
}

export interface PnlCrosshairInput {
  base: PnlBase | null;
  scenario: Scenario;
  chart: Pick<PnlChartModel, 'empty' | 'domain' | 'yDomain' | 'yUnit' | 'plot' | 'days' | 'lines'>;
  cursor: PnlCursor | null;
  /** svg の幅・高さ（札を内側に寄せる） */
  width: number;
  height: number;
  /** 読み取りが避ける箱（IV レールの吹き出し・追証の札） */
  obstacles?: readonly MarkObstacle[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(hi, lo));
const overlaps = (a: MarkObstacle, b: MarkObstacle) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** X を 10 円の格子に */
export function crossX(x: number): number {
  return Math.round(x / CROSS_X_STEP) * CROSS_X_STEP;
}

export function pnlCrosshair(p: PnlCrosshairInput): PnlCrosshair | null {
  const { base, chart, cursor } = p;
  if (!base || chart.empty || !cursor) return null;
  if (!Number.isFinite(cursor.x)) return null;
  const [lo, hi] = chart.domain;
  // 外れの判定は丸める前の X。格子は範囲の内側に収める（パンで範囲が格子に乗らないとき端で消えない。範囲の幅は
  // minWidth から 10 円より広い）
  if (!(cursor.x >= lo && cursor.x <= hi)) return null;
  const gLo = Math.ceil(lo / CROSS_X_STEP) * CROSS_X_STEP;
  const gHi = Math.floor(hi / CROSS_X_STEP) * CROSS_X_STEP;
  const x = gLo <= gHi ? clamp(crossX(cursor.x), gLo, gHi) : cursor.x;
  const { plot } = chart;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const px = r1(linear(chart.domain, [plot.left, right])(x));
  const sy = linear(chart.yDomain as Domain, [bottom, plot.top]);
  const [yLo, yHi] = chart.yDomain;
  const inY = Number.isFinite(cursor.y) && cursor.y >= yLo && cursor.y <= yHi;
  const level = inY ? cursor.y : null;
  const py = level === null ? null : r1(clamp(sy(level), plot.top, bottom));
  const unit = chart.yUnit;

  const xText = fmtNum(x, 0);
  const xw = r1(Math.min(labelPx(xText) + IV_TAG_PAD_X, p.width));
  const xTag: CrossTag = {
    x: r1(clamp(px - xw / 2, 0, p.width - xw)),
    y: r1(clamp(bottom + 3, 0, p.height - IV_TAG_H)),
    w: xw,
    h: IV_TAG_H,
    text: xText,
  };
  let yTag: CrossTag | null = null;
  if (level !== null && py !== null) {
    const yText = fmtAmount(level, unit);
    const yw = r1(Math.min(labelPx(yText) + IV_TAG_PAD_Y, p.width));
    yTag = {
      x: r1(Math.max(0, plot.left - 1 - yw)),
      y: r1(clamp(py - IV_TAG_H / 2, 0, p.height - IV_TAG_H)),
      w: yw,
      h: IV_TAG_H,
      text: yText,
    };
  }

  const values = lineValuesAt(base, p.scenario, chart, x);
  const dots: Array<{ kind: PnlLineKind; py: number }> = [];
  const rows = values.map((v) => {
    const raw = sy(v.y);
    const edge: MarkEdge | null = raw < plot.top ? 'top' : raw > bottom ? 'bottom' : null;
    if (edge === null && Number.isFinite(raw)) dots.push({ kind: v.kind, py: r1(raw) });
    return { kind: v.kind, value: v.y, text: markText(v.kind, v.y, unit, edge) };
  });

  // 読み取りの箱: 縦線と反対の側の上端（横線・点が箱の高さに入るなら下端）
  const textW = Math.max(0, ...rows.map((r) => labelWidth(r.text) * READ_FONT_RATIO));
  const boxW = r1(textW + 2 * READ_PAD + (cursor.pinned ? READ_CLOSE_W : 0));
  const boxH = Math.max(rows.length, 1) * READ_ROW + 2 * READ_PAD;
  const leftSide = px > plot.left + plot.width / 2;
  const bx0 = leftSide ? plot.left + READ_PAD : Math.max(plot.left, right - READ_PAD - boxW);
  const topY = plot.top + READ_PAD;
  const bottomY = Math.max(topY, bottom - MARKER_BAND_PX - READ_PAD - boxH);
  const at = (y0: number): MarkObstacle => ({
    x0: r1(bx0),
    x1: r1(bx0 + boxW),
    y0: r1(y0),
    y1: r1(y0 + boxH),
  });
  const ys = [py, ...dots.map((d) => d.py)].filter((v): v is number => v !== null);
  // 箱が縦線の上の点（横線・線の点）を覆うか（箱は縦線と反対の側なので、狭い描画域で縦線まで届くときだけ）
  const covers = (b: MarkObstacle) =>
    px >= b.x0 - READ_PAD &&
    px <= b.x1 + READ_PAD &&
    ys.some((y) => y >= b.y0 - READ_PAD && y <= b.y1 + READ_PAD);
  const blocked = (b: MarkObstacle) => (p.obstacles ?? []).some((o) => overlaps(o, b));
  const first = at(topY);
  const second = at(bottomY);
  let box = covers(first) && !covers(second) ? second : first;
  if (blocked(box)) {
    const other = box === first ? second : first;
    if (!blocked(other) && !covers(other)) box = other;
  }
  const anchor: 'start' | 'end' = leftSide ? 'start' : 'end';
  const textX = leftSide
    ? box.x0 + READ_PAD
    : box.x1 - READ_PAD - (cursor.pinned ? READ_CLOSE_W : 0);
  const items: CrossReadItem[] = rows.map((r, i) => ({
    ...r,
    y: r1(box.y0 + READ_PAD + READ_ROW * i + READ_ROW / 2),
  }));
  return {
    x,
    px,
    level,
    py,
    xTag,
    yTag,
    dots,
    read: {
      items,
      textX: r1(textX),
      anchor,
      close: cursor.pinned
        ? { x: r1(box.x1 - READ_PAD - READ_CLOSE_W / 2), y: r1(box.y0 + READ_PAD + READ_ROW / 2) }
        : null,
      box,
    },
  };
}

/** 交点のラベル（11px の文字。dominant-baseline: central）の箱の見積もり（読み取りの箱の障害物） */
export function markLabelBox(l: {
  text: string;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end';
}): MarkObstacle {
  const w = labelWidth(l.text) * READ_FONT_RATIO;
  const x0 = l.anchor === 'start' ? l.labelX : l.labelX - w;
  return { x0, x1: x0 + w, y0: l.labelY - READ_ROW / 2, y1: l.labelY + READ_ROW / 2 };
}

/**
 * 画素（svg の座標）→ カーソルの値（X・損益）。clampToPlot = 描画域の外は端へ寄せる（交点のドラッグ）。
 * そうでなければ描画域の外は null（ホバー・タップで消す）。
 */
export function pnlCursorAt(
  chart: Pick<PnlChartModel, 'empty' | 'domain' | 'yDomain' | 'plot'>,
  sx: number,
  sy: number,
  clampToPlot: boolean,
): { x: number; y: number } | null {
  if (chart.empty) return null;
  const { plot } = chart;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  if (!clampToPlot && (sx < plot.left || sx > right || sy < plot.top || sy > bottom)) return null;
  const cx = clamp(sx, plot.left, right);
  const cy = clamp(sy, plot.top, bottom);
  return {
    x: linear([plot.left, right], chart.domain)(cx),
    y: linear([bottom, plot.top], chart.yDomain as Domain)(cy),
  };
}

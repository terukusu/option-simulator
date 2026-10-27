/**
 * 追証マップ（#152。設計 docs/design.md 5.11）の画面側の計算の単位と表示モデル（純関数。Preact・DOM に依存しない）。
 *
 * - 入力（holdMapInput）は 板の基礎（pnlBoard）・今のシナリオの d・Δs・IV の動き方・パラメータ・資金・休業日だけ
 *   （ΔX・Δσ・β・ivShift・パン・拡大では変わらない = 作り直さない。B7）
 * - マスの計算は model/holdMap.ts の holdMapColumn（列ごと）。h・premium・d の clampDays はここ（marginCalc と同じ求め方）
 * - 表示: マス 2 色（余力あり / 追証）・境目の線・過去の点（余力ありは丸、追証の側は ×）・今（0%, ×1）の十字・軸の目盛り
 *   （固定の本数の上限）・要約・注記・触った 1 行。座標は SVG の数値の属性と path の d だけ（style を使わない）
 * - 許容損失（#180。設定の資金の次）があれば、2 本目の境目（損益 = −許容損失）・3 色目のマス（許容損失超。追証が優先）・
 *   凡例・見出しの `d 日後` を足す。許容損失は計算の入力に入れない（変えても作り直さず描き直すだけ）
 * - 部品は ui/next/regions/HoldMap.tsx。計算の時機は ui/components/useHoldMap.ts
 */

import type { AtmMove } from '../../data/atmDaily';
import {
  businessDaysAhead,
  DAY_MS,
  type HoldMapAxes,
  type HoldMapCalc,
  type HoldMapCount,
  type Holidays,
  holdMapColumn,
  holdMapContour,
  holdMapCount,
  holdMapLossRooms,
  holdMapPnlColumn,
  holdMapValueAt,
  MARGIN_HORIZON_BUSINESS_DAYS,
  type MarginParams,
  premiumSummary,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import { type CrossTagBox, crossTagX, crossTagY } from './crosshair';
import { fmtNum, fmtSigned } from './format';
import { revealDelta } from './hint';
import { MARGIN_LINE_SETTLE_MS } from './margin';
import { AMOUNT_UNIT_LABEL, type AmountUnit, fmtAmount } from './metrics';
import { clampDays, type PnlBase } from './pnlChart';

export const HOLD_MAP_TITLE = '追証マップ';
export const HOLD_MAP_NO_CAPITAL = '設定で資金を入れてください（⋯ > 設定…）';
export const HOLD_MAP_NO_LEGS = '足を入れるとマップを作る';
export const HOLD_MAP_COMPUTING = '計算中…';
export const HOLD_MAP_LOADING = '過去の値動きを読み込み中…';
export const HOLD_MAP_FAILED = '過去の値動きを読めない';
export const HOLD_MAP_EMPTY = '過去の値動きが無い';
export const HOLD_MAP_RETRY = '再試行';
export const HOLD_MAP_IDLE_READOUT = '点かマスを触ると値を出す（矢印キーでマスを動かす）';
/** 見出しの下の説明の頭（何の図か・軸） */
const CAPTION_HEAD =
  '原資産と IV が同時に動いたときの余力。横 = 原資産の変化（今の X₀ に対する %）、縦 = IV の倍率（足ごとの IV に掛ける）。';
/** 見出しの下の説明の尾 */
const CAPTION_TAIL = '、十字 = 今。β・Δσ は使わない';
/**
 * 見出しの下の説明（#179・#259 H-2: 何の図か・軸・色・線。短くしてマップを上に寄せる。追証の側の注意は
 * HOLD_MAP_CALL_NOTE、過去の点の近似は holdMapNote = どちらも読み取りの下）
 */
export const HOLD_MAP_CAPTION = `${CAPTION_HEAD}色 = 余力あり / 追証（余力 < 0）、線 = 境目${CAPTION_TAIL}`;
/** 読み取りの下の注意（#179 で説明に入れた文を #259 H-2 で移した。マップを出すときは常に） */
export const HOLD_MAP_CALL_NOTE =
  '追証の側（赤）は概算で、実際の追証は引けの清算値で判定（日中に入っても引けで戻れば追証にならない）';
export const HOLD_MAP_PLOT_LABEL = '追証マップ（原資産と IV が同時に動いたときの余力）';
/** 許容損失があるときの凡例（#180。マスの色の 3 区分。追証が優先） */
export const HOLD_MAP_LEGEND: ReadonlyArray<{
  cls: 'hm-ok' | 'hm-loss' | 'hm-call';
  label: string;
}> = [
  { cls: 'hm-ok', label: '許容内' },
  { cls: 'hm-loss', label: '許容損失超' },
  { cls: 'hm-call', label: '追証' },
];

const daysText = (days: number) => fmtNum(days, Number.isInteger(days) ? 0 : 1);

/**
 * 見出し（#180・#259 H-3）: マップを出す（資金・足がある）ときは `追証マップ · d 日後`（余力も損益も d の時点 =
 * シナリオの d。許容損失によらない）、それ以外は `追証マップ`
 */
export function holdMapTitle(days: number, mapShown = true): string {
  return mapShown ? `${HOLD_MAP_TITLE} · ${daysText(days)} 日後` : HOLD_MAP_TITLE;
}

/**
 * 見出しの下の説明（#180・#259 H-1）: 許容損失があれば色の言葉を凡例（許容内 / 許容損失超 / 追証）にそろえ、
 * 2 本の境目の線種を書く
 */
export function holdMapCaption(allowedLoss: number | null): string {
  return allowedLoss === null
    ? HOLD_MAP_CAPTION
    : `${CAPTION_HEAD}色 = 許容内 / 許容損失超 / 追証（余力 < 0）、線 = 境目（実線 = 追証、破線 = d 日後の損益が −許容損失）${CAPTION_TAIL}`;
}

/** 凡例（#180）: 許容損失が無ければ出さない（[]） */
export function holdMapLegend(allowedLoss: number | null): typeof HOLD_MAP_LEGEND {
  return allowedLoss === null ? [] : HOLD_MAP_LEGEND;
}

/** 止まってから作るまでの時間（ms。追証の線の MARGIN_LINE_SETTLE_MS と同じ） */
export const HOLD_MAP_SETTLE_MS = MARGIN_LINE_SETTLE_MS;
/**
 * マスの計算を始めるまでの時間（#176）: 前に見た入力・軸（prev。active でないときも控える）と同じ参照なら 0
 * （開いただけ = 入力が止まっている）、初めて・どちらかが変わったら HOLD_MAP_SETTLE_MS
 */
export function holdMapSettleMs(
  prev: { input: HoldMapInput | null; axes: HoldMapAxes } | null,
  input: HoldMapInput,
  axes: HoldMapAxes,
): number {
  return prev && prev.input === input && prev.axes === axes ? 0 : HOLD_MAP_SETTLE_MS;
}
/** 列ごとの計算の 1 切れの上限（ms。列が単位 = 列の途中では切らない） */
export const HOLD_MAP_SLICE_MS = 8;
/** 点を選ぶ距離（px） */
export const HOLD_MAP_PICK_PX = 14;

export interface HoldMapInput {
  base: PnlBase;
  /** d・Δs・動き方だけを持つシナリオ（holdMapBaseScenario） */
  scenario: Scenario;
  params: MarginParams;
  capital: number;
  holidays: Holidays;
}

/** マップのシナリオの基礎: 今のシナリオの d・Δs・動き方だけ（ΔX・Δσ・β・ivShift は持たない） */
export function holdMapBaseScenario(sc: Scenario): Scenario {
  return {
    ...ZERO_SCENARIO,
    days: sc.days,
    skew: sc.skew,
    ivDynamics: sc.ivDynamics,
    beta: 0,
    ivShift: 'relative',
  };
}

/** マップの入力（板・足が無い・資金が未設定なら null）。scenario は holdMapBaseScenario を通す */
export function holdMapInput(
  base: PnlBase | null,
  scenario: Scenario,
  params: MarginParams,
  capital: number | null,
  holidays: Holidays,
): HoldMapInput | null {
  if (!base || capital === null || base.legs.length === 0) return null;
  return { base, scenario: holdMapBaseScenario(scenario), params, capital, holidays };
}

/** 列の計算の入力（d は clampDays、h は S の時点から 2 営業日後まで。marginCalc と同じ） */
export function holdMapCalcOf(input: HoldMapInput): HoldMapCalc {
  const { base, params, capital, holidays } = input;
  const { legs, ctx, settings } = base;
  const { days } = clampDays(input.scenario, base.maxDays);
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  return {
    legs,
    ctx,
    settings,
    params,
    base: { ...input.scenario, days },
    horizonDays,
    capital,
    premium: premiumSummary(legs, settings),
  };
}

export interface HoldMapResult {
  input: HoldMapInput;
  axes: HoldMapAxes;
  /** rooms[i][j] = (us[i], cs[j]) の余力（円。有限でなければ NaN） */
  rooms: Float64Array[];
  /** pnls[i][j] = (us[i], cs[j]) の損益（円。d の時点。有限でなければ NaN。#180） */
  pnls: Float64Array[];
}

/** マップ全体（余力と損益）を一度に作る（テスト・計測用。画面は useHoldMap が列ごとに回す） */
export function holdMapResultOf(input: HoldMapInput, axes: HoldMapAxes): HoldMapResult {
  const calc = holdMapCalcOf(input);
  return {
    input,
    axes,
    rooms: axes.us.map((_, i) => holdMapColumn(calc, axes, i)),
    pnls: axes.us.map((_, i) => holdMapPnlColumn(calc, axes, i)),
  };
}

// ---- 表示モデル

export type HoldMovesStatus = 'idle' | 'loading' | 'ok' | 'failed';

const M = { left: 36, right: 8, top: 6, bottom: 20 } as const;
/** 高さ = clamp(幅 × 0.72, 200, 300) */
export function holdMapHeight(width: number): number {
  return Math.round(Math.min(300, Math.max(200, width * 0.72)));
}
/** 軸のラベルの間の最小の画素（横・縦） */
const X_LABEL_PX = 44;
const Y_LABEL_PX = 22;
const X_TICK_STEPS = [0.1, 0.2, 0.5, 1] as const;
const Y_TICK_STEPS = [0.5, 1, 2] as const;
export const HOLD_MAP_MAX_X_TICKS = 7;
export const HOLD_MAP_MAX_Y_TICKS = 6;

export interface HoldMapTick {
  /** 画素（横の目盛りは x、縦の目盛りは y） */
  at: number;
  label: string;
}

export interface HoldMapPlot {
  width: number;
  height: number;
  /** 描画域（画素） */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** マス（クラスごとに 1 本の path。許容損失が無ければ 2 種、あれば 3 種） */
  cells: Array<{ cls: 'hm-ok' | 'hm-loss' | 'hm-call'; d: string }>;
  /** 境目の線（空なら線なし） */
  contour: string;
  /** 許容損失の境目の線（損益 = −許容損失。許容損失が無い・線が無ければ空。#180） */
  lossContour: string;
  /** 余力ありの点（丸）・追証の側の点（×） */
  okDots: string;
  callMarks: string;
  /** 今（0%, ×1）の十字（軸の外なら null） */
  now: { x: number; y: number } | null;
  xTicks: HoldMapTick[];
  yTicks: HoldMapTick[];
  count: HoldMapCount;
  /** 点の画素（選ぶ判定用。数えない点は NaN） */
  px: Float64Array;
  py: Float64Array;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function ticks(
  lo: number,
  hi: number,
  steps: readonly number[],
  spanPx: number,
  minPx: number,
  maxCount: number,
): number[] {
  for (const step of steps) {
    const first = Math.ceil(lo / step - 1e-9);
    const last = Math.floor(hi / step + 1e-9);
    const count = last - first + 1;
    const gap = count > 1 ? (spanPx * step) / (hi - lo) : spanPx;
    if (count <= maxCount && gap >= minPx) {
      const out: number[] = [];
      for (let i = first; i <= last; i++) out.push(Math.round(i * step * 1e9) / 1e9);
      return out;
    }
  }
  return [];
}

const pctLabel = (u: number) => `${fmtSigned(u * 100, 0)}%`;
const scaleLabel = (c: number) => `×${fmtNum(c, Number.isInteger(c) ? 0 : 1)}`;

/** マップの座標（u・c → 画素） */
export function holdMapScales(axes: HoldMapAxes, width: number) {
  const { us, cs } = axes;
  const height = holdMapHeight(width);
  const du = us.length > 1 ? (us[1] as number) - (us[0] as number) : 0.02;
  const dc = cs.length > 1 ? (cs[1] as number) - (cs[0] as number) : 0.1;
  const u0 = (us[0] as number) - du / 2;
  const u1 = (us[us.length - 1] as number) + du / 2;
  const c0 = (cs[0] as number) - dc / 2;
  const c1 = (cs[cs.length - 1] as number) + dc / 2;
  const left = M.left;
  const right = Math.max(left + 10, width - M.right);
  const top = M.top;
  const bottom = Math.max(top + 10, height - M.bottom);
  const sx = (u: number) => left + ((u - u0) / (u1 - u0)) * (right - left);
  const sy = (c: number) => bottom - ((c - c0) / (c1 - c0)) * (bottom - top);
  return { height, left, right, top, bottom, du, dc, u0, u1, c0, c1, sx, sy };
}

/** マップの描画（計算が終わったときと幅・点が変わったときだけ作る） */
export function holdMapPlot(
  result: HoldMapResult,
  moves: readonly AtmMove[],
  width: number,
  allowedLoss: number | null = null,
): HoldMapPlot {
  const { axes, rooms, pnls } = result;
  const lossRooms = allowedLoss === null ? null : holdMapLossRooms(pnls, allowedLoss);
  const { us, cs } = axes;
  const s = holdMapScales(axes, width);
  const { sx, sy } = s;
  // マスの境は丸めた画素を隣と共有する（crispEdges で隙間の線を出さない）
  const xEdge = (i: number) => r1(sx((us[i] as number) - s.du / 2));
  const yEdge = (j: number) => r1(sy((cs[j] as number) - s.dc / 2));
  let ok = '';
  let loss = '';
  let call = '';
  for (let i = 0; i < us.length; i++) {
    const col = rooms[i];
    const lossCol = lossRooms?.[i];
    if (!col) continue;
    const x = xEdge(i);
    const w = r1((i + 1 < us.length ? xEdge(i + 1) : r1(s.right)) - x);
    for (let j = 0; j < cs.length; j++) {
      const v = col[j] as number;
      if (!Number.isFinite(v)) continue;
      const yb = yEdge(j);
      const yt = j + 1 < cs.length ? yEdge(j + 1) : r1(s.top);
      const rect = `M${x} ${yt}h${w}v${r1(yb - yt)}h${-w}z`;
      if (v < 0) {
        call += rect;
        continue;
      }
      if (lossCol) {
        // 許容損失があるとき、損益が有限でないマスは許容内とも超とも決めない = 塗らない（余力の NaN と同じ扱い）
        const lv = lossCol[j] as number;
        if (!Number.isFinite(lv)) continue;
        if (lv < 0) {
          loss += rect;
          continue;
        }
      }
      ok += rect;
    }
  }
  const cells: HoldMapPlot['cells'] = [];
  if (ok) cells.push({ cls: 'hm-ok', d: ok });
  if (loss) cells.push({ cls: 'hm-loss', d: loss });
  if (call) cells.push({ cls: 'hm-call', d: call });
  const path = (grid: readonly Float64Array[]) => {
    let d = '';
    for (const [[ua, ca], [ub, cb]] of holdMapContour(axes, grid)) {
      d += `M${r1(sx(ua))} ${r1(sy(ca))}L${r1(sx(ub))} ${r1(sy(cb))}`;
    }
    return d;
  };
  const contour = path(rooms);
  const lossContour = lossRooms ? path(lossRooms) : '';
  const count = holdMapCount(axes, rooms, moves);
  const px = new Float64Array(moves.length).fill(Number.NaN);
  const py = new Float64Array(moves.length).fill(Number.NaN);
  let okDots = '';
  let callMarks = '';
  moves.forEach((mv, k) => {
    if (!count.counted[k]) return;
    const x = sx(mv.dx);
    const y = sy(mv.ivRatio);
    px[k] = x;
    py[k] = y;
    if (count.calls[k]) callMarks += `M${r1(x - 2.5)} ${r1(y - 2.5)}l5 5m0 -5l-5 5`;
    else okDots += `M${r1(x - 1.6)} ${r1(y)}a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0`;
  });
  const inside = 0 >= s.u0 && 0 <= s.u1 && 1 >= s.c0 && 1 <= s.c1;
  const xTicks = ticks(
    us[0] as number,
    us[us.length - 1] as number,
    X_TICK_STEPS,
    sx(us[us.length - 1] as number) - sx(us[0] as number),
    X_LABEL_PX,
    HOLD_MAP_MAX_X_TICKS,
  ).map((u) => ({ at: r1(sx(u)), label: pctLabel(u) }));
  const yTicks = ticks(
    cs[0] as number,
    cs[cs.length - 1] as number,
    Y_TICK_STEPS,
    sy(cs[0] as number) - sy(cs[cs.length - 1] as number),
    Y_LABEL_PX,
    HOLD_MAP_MAX_Y_TICKS,
  ).map((c) => ({ at: r1(sy(c)), label: scaleLabel(c) }));
  return {
    width,
    height: s.height,
    left: s.left,
    right: s.right,
    top: s.top,
    bottom: s.bottom,
    cells,
    contour,
    lossContour,
    okDots,
    callMarks,
    now: inside ? { x: r1(sx(0)), y: r1(sy(1)) } : null,
    xTicks,
    yTicks,
    count,
    px,
    py,
  };
}

/** シナリオの ΔX（X₀ に対する比）の縦の破線の x（描画域の外・0 なら null。ΔX では計算し直さない） */
export function holdMapDxX(axes: HoldMapAxes, width: number, dXRatio: number): number | null {
  if (!Number.isFinite(dXRatio) || dXRatio === 0) return null;
  const s = holdMapScales(axes, width);
  if (dXRatio < s.u0 || dXRatio > s.u1) return null;
  return r1(s.sx(dXRatio));
}

/** 要約: `過去 N 回の 2 営業日の動きのうち M 回が追証の側` */
export function holdMapSummary(count: HoldMapCount): string {
  return `過去 ${count.n} 回の 2 営業日の動きのうち ${count.m} 回が追証の側`;
}

/**
 * 見出しの結論（#274。折りたたみを閉じていても見出しに出す）: マップができていて数えた点が 1 つ以上なら
 * `過去 N 回中 M 回が追証の側`、それ以外は null。数え方は描画域の要約（holdMapPlot の count）と同じ holdMapCount
 */
export function holdMapHeadSummary(
  result: HoldMapResult | null,
  moves: readonly AtmMove[],
): string | null {
  if (!result || moves.length === 0) return null;
  const c = holdMapCount(result.axes, result.rooms, moves);
  return c.n === 0 ? null : `過去 ${c.n} 回中 ${c.m} 回が追証の側`;
}

/** 注記（期間は読んだデータの最初と最後の月。d はマップの日数） */
export function holdMapNote(moves: readonly AtmMove[], days: number): string {
  const first = moves[0];
  const last = moves[moves.length - 1];
  const span = first && last ? `${first.d0.slice(0, 7)}〜${last.d1.slice(0, 7)} の ` : '';
  return `点 = ${span}2 営業日（日中の終値）の原資産と ATM IV（30 日）の倍率。重なりあり・足の IV が同じ倍率で動くと見なした近似。マップの日数はシナリオの d（${daysText(days)} 日）`;
}

export type HoldMapSel = { kind: 'point'; k: number } | { kind: 'cell'; i: number; j: number };

/** 描画域のタップ（要素の座標の画素）: 14px 以内の最も近い点、無ければそのマス。描画域の外は null */
export function holdMapPick(
  plot: HoldMapPlot,
  axes: HoldMapAxes,
  x: number,
  y: number,
): HoldMapSel | null {
  let best = -1;
  let bestD = HOLD_MAP_PICK_PX * HOLD_MAP_PICK_PX;
  for (let k = 0; k < plot.px.length; k++) {
    const dx = (plot.px[k] as number) - x;
    const dy = (plot.py[k] as number) - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best >= 0) return { kind: 'point', k: best };
  return holdMapCellAt(plot, axes, x, y);
}

/** 画素（要素の座標）のマス。描画域の外は null */
export function holdMapCellAt(
  plot: HoldMapPlot,
  axes: HoldMapAxes,
  x: number,
  y: number,
): { kind: 'cell'; i: number; j: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) return null;
  const s = holdMapScales(axes, plot.width);
  const u = s.u0 + ((x - s.left) / (s.right - s.left)) * (s.u1 - s.u0);
  const c = s.c0 + ((s.bottom - y) / (s.bottom - s.top)) * (s.c1 - s.c0);
  const i = Math.min(
    axes.us.length - 1,
    Math.max(0, Math.round((u - (axes.us[0] as number)) / s.du)),
  );
  const j = Math.min(
    axes.cs.length - 1,
    Math.max(0, Math.round((c - (axes.cs[0] as number)) / s.dc)),
  );
  return { kind: 'cell', i, j };
}

/** 矢印キーでマスを 1 つ動かす（端で止まる）。選択が点か無ければ今（0%, ×1）のマスから */
export function holdMapStep(
  sel: HoldMapSel | null,
  axes: HoldMapAxes,
  key: string,
): HoldMapSel | null {
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };
  const step = d[key];
  if (!step) return null;
  if (sel?.kind !== 'cell') {
    const i = axes.us.findIndex((u) => Math.abs(u) < 1e-9);
    const j = axes.cs.findIndex((c) => Math.abs(c - 1) < 1e-9);
    return { kind: 'cell', i: Math.max(0, i), j: Math.max(0, j) };
  }
  return {
    kind: 'cell',
    i: Math.min(axes.us.length - 1, Math.max(0, sel.i + step[0])),
    j: Math.min(axes.cs.length - 1, Math.max(0, sel.j + step[1])),
  };
}

/**
 * 余力と損益の文（#180・#259）: 許容損失が無ければ `余力 … · 追証 / 余力あり · 損益 …`。あれば判定はマスの色と同じ
 * 1 語を最後に（`余力 … · 損益 … · 許容内 / 許容損失超 / 追証`。追証が優先 = 凡例と同じ言葉）
 */
function roomPnlText(
  room: number,
  pnl: number,
  unit: AmountUnit,
  allowedLoss: number | null,
): string {
  const amount = (v: number) => `${fmtAmount(v, unit, true)} ${AMOUNT_UNIT_LABEL[unit]}`;
  const roomOk = Number.isFinite(room);
  const pnlOk = Number.isFinite(pnl);
  const roomS = roomOk ? `余力 ${amount(room)}` : '余力 —';
  const pnlS = pnlOk ? `損益 ${amount(pnl)}` : '損益 —';
  if (allowedLoss === null) {
    return `${roomOk ? `${roomS} · ${room < 0 ? '追証' : '余力あり'}` : roomS} · ${pnlS}`;
  }
  const tag =
    roomOk && room < 0
      ? '追証'
      : roomOk && pnlOk
        ? pnl + allowedLoss < 0
          ? '許容損失超'
          : '許容内'
        : null;
  return `${roomS} · ${pnlS}${tag ? ` · ${tag}` : ''}`;
}

/** 選んだ点・マスの 1 行（余力と、その点の d の時点の損益） */
export function holdMapReadout(
  sel: HoldMapSel | null,
  result: HoldMapResult | null,
  moves: readonly AtmMove[],
  unit: AmountUnit,
  allowedLoss: number | null = null,
): string {
  if (!sel || !result) return HOLD_MAP_IDLE_READOUT;
  const { axes, rooms, pnls } = result;
  if (sel.kind === 'point') {
    const mv = moves[sel.k];
    if (!mv) return HOLD_MAP_IDLE_READOUT;
    const d1 = mv.d1.slice(0, 4) === mv.d0.slice(0, 4) ? mv.d1.slice(5) : mv.d1;
    const room = holdMapValueAt(axes, rooms, mv.dx, mv.ivRatio);
    const pnl = holdMapValueAt(axes, pnls, mv.dx, mv.ivRatio);
    return `${mv.d0} → ${d1} · 原資産 ${fmtSigned(mv.dx * 100, 1)}% · IV ${fmtNum(mv.iv0, 1)} → ${fmtNum(mv.iv1, 1)}%（×${fmtNum(mv.ivRatio, 2)} · ${fmtSigned(mv.ivPt, 1)}pt）· ${roomPnlText(room, pnl, unit, allowedLoss)}`;
  }
  const u = axes.us[sel.i];
  const c = axes.cs[sel.j];
  if (u === undefined || c === undefined) return HOLD_MAP_IDLE_READOUT;
  const v = rooms[sel.i]?.[sel.j] ?? Number.NaN;
  const pnl = pnls[sel.i]?.[sel.j] ?? Number.NaN;
  return `原資産 ${fmtSigned(u * 100, 0)}% · IV ×${fmtNum(c, 1)} · ${roomPnlText(v, pnl, unit, allowedLoss)}`;
}

/** 選んだもの（点 / マス）の印の画素（無ければ null） */
export function holdMapSelMark(
  sel: HoldMapSel | null,
  plot: HoldMapPlot,
  axes: HoldMapAxes,
): { kind: 'point' | 'cell'; x: number; y: number; w: number; h: number } | null {
  if (!sel) return null;
  if (sel.kind === 'point') {
    const x = plot.px[sel.k];
    const y = plot.py[sel.k];
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
      return null;
    return { kind: 'point', x: r1(x), y: r1(y), w: 0, h: 0 };
  }
  const u = axes.us[sel.i];
  const c = axes.cs[sel.j];
  if (u === undefined || c === undefined) return null;
  const s = holdMapScales(axes, plot.width);
  const w = ((s.right - s.left) * s.du) / (s.u1 - s.u0);
  const h = ((s.bottom - s.top) * s.dc) / (s.c1 - s.c0);
  return { kind: 'cell', x: r1(s.sx(u) - w / 2), y: r1(s.sy(c) - h / 2), w: r1(w), h: r1(h) };
}

/**
 * 状態の文（マップの上に出す。無ければ null）。読み込み中・計算中の文は出さない（#174。描画域の枠の中の holdMapWait）
 */
export function holdMapStatusText(o: {
  noLegs: boolean;
  noCapital: boolean;
  movesStatus: HoldMovesStatus;
  movesCount: number;
}): { main: string | null; moves: string | null; retry: boolean } {
  if (o.noLegs) return { main: HOLD_MAP_NO_LEGS, moves: null, retry: false };
  if (o.noCapital) return { main: HOLD_MAP_NO_CAPITAL, moves: null, retry: false };
  if (o.movesStatus === 'failed') return { main: null, moves: HOLD_MAP_FAILED, retry: true };
  if (o.movesStatus === 'ok' && o.movesCount === 0)
    return { main: null, moves: HOLD_MAP_EMPTY, retry: false };
  return { main: null, moves: null, retry: false };
}

/**
 * 待ちの文（#174。描画域の枠の中にスピナーと出す。待っていなければ null）: 過去の値動きの読み込み中（idle / loading。
 * 点が読めると軸が広がって作り直しうるので計算中より先）は HOLD_MAP_LOADING、それ以外で計算中は HOLD_MAP_COMPUTING。
 * 足なし・資金なしはマップを作らないので null
 */
export function holdMapWait(o: {
  noLegs: boolean;
  noCapital: boolean;
  computing: boolean;
  movesStatus: HoldMovesStatus;
}): string | null {
  if (o.noLegs || o.noCapital) return null;
  if (o.movesStatus === 'idle' || o.movesStatus === 'loading') return HOLD_MAP_LOADING;
  return o.computing ? HOLD_MAP_COMPUTING : null;
}

/**
 * 開いたときに枠に入れる範囲（#274。説明を ⓘ に移して見出しの行と描画域が隣り合ったので）: 下端は描画域 + 読み取りが
 * 枠に入れば読み取りの下端、入らなければ描画域の下端。上端は見出しの行から下端までが枠に入れば見出しの行の上端、
 * 入らなければ描画域の上端（描画域の上端を隠さない = holdMapReveal の優先と同じ）
 */
export function holdMapRevealRange(
  headTop: number,
  plotTop: number,
  plotBottom: number,
  readBottom: number,
  hostHeight: number,
): { top: number; bottom: number } {
  const bottom = readBottom - plotTop <= hostHeight ? readBottom : plotBottom;
  return { top: bottom - headTop <= hostHeight ? headTop : plotTop, bottom };
}

/**
 * 開いたときのスクロール（#174）: パネルのスクロール枠（host）の中で、描画域（.hm-plot）の上端 〜 下端が見えるように
 * 動かす量（scrollIntoView の block: 'nearest' 相当。下端のはみ出しだけ、描画域の上端を枠の上端より上に隠さない
 * = ui/view/hint.ts の revealDelta。#274: 範囲が枠に入るのに上端が隠れていれば上へ戻す = 負）と動かし方（prefers-reduced-motion なら即時 auto、それ以外は smooth）。
 * 見出しは描画域と一緒に枠に入るときは残り、入らない（スマホの peek）ときだけ上に送られる
 */
export function holdMapReveal(
  plotTop: number,
  plotBottom: number,
  hostTop: number,
  hostBottom: number,
  reduced: boolean,
): { delta: number; behavior: 'smooth' | 'auto' } {
  // #274: 範囲が枠に入るのに上端が枠の上に隠れている（開いた直後の仮の高さで送りすぎた）ときは上へ戻す（負）
  const up =
    plotTop < hostTop && plotBottom - plotTop <= hostBottom - hostTop ? plotTop - hostTop : 0;
  return {
    delta: up < 0 ? up : revealDelta(plotTop, plotBottom, hostTop, hostBottom),
    behavior: reduced ? 'auto' : 'smooth',
  };
}

// ---------------------------------------------------------------- 十字線（#217）

export interface HoldMapCrosshair {
  /** マスの中心の画素（縦線・横線） */
  x: number;
  y: number;
  xTag: CrossTagBox;
  yTag: CrossTagBox;
  /** 読み取りの 1 行（holdMapReadout のマスと同じ形 = 余力・損益はそのマスの値） */
  readout: string;
}

/**
 * 追証マップの十字線（#217。docs/ui-redesign.md §4.1）: 両方の軸が入力の格子なので、縦線・横線は指 / マウスの下のマスの
 * 中心に吸着する。札 = ΔX%（符号つきの整数 %）・IV の倍率（×小数 1 桁）、読み取り = そのマスの余力。描画域の外・空は null
 */
export function holdMapCrosshair(
  plot: HoldMapPlot,
  result: HoldMapResult,
  x: number,
  y: number,
  moves: readonly AtmMove[],
  unit: AmountUnit,
  allowedLoss: number | null = null,
): HoldMapCrosshair | null {
  const { axes } = result;
  const cell = holdMapCellAt(plot, axes, x, y);
  if (!cell) return null;
  const u = axes.us[cell.i] as number;
  const c = axes.cs[cell.j] as number;
  const s = holdMapScales(axes, plot.width);
  const cx = r1(s.sx(u));
  const cy = r1(s.sy(c));
  return {
    x: cx,
    y: cy,
    xTag: crossTagX(`${fmtSigned(u * 100, 0)}%`, cx, plot.bottom + 2, plot.width, plot.height),
    yTag: crossTagY(`×${fmtNum(c, 1)}`, cy, plot.left - 1, plot.width, plot.height),
    readout: holdMapReadout(cell, result, moves, unit, allowedLoss),
  };
}

/**
 * 損益グラフの表示モデル（純関数）。設計 docs/design.md M4・M10・5.5・5.6、#11。
 *
 * - 横軸 = 基準原資産 X（円モード F_i' = X' + basis_i）。縦軸 = 損益（円）
 * - 線: 満期（SQ。expiryProfile の折れ点を頂点に持つ折れ線 = 解析解。サンプリングしない）、
 *   指定日 + シナリオと今日は横軸 1 画素 1 点で theoreticalPnl を再サンプリング（点数 = 描画幅の
 *   CSS px、2〜2,000）。今日の線 = シナリオ IV を掛けない基準の線（d = Δσ = Δs = 0。β と動き方は
 *   横軸の各点に効く。#6）。指定日の線（シナリオ全体）は d > 0 または Δσ・Δs ≠ 0 のときだけ描く
 *   （そうでなければ今日と重なる）。ΔX は線に効かない（β は評価点 X' ごと）のでシナリオ点の縦線で見せる
 * - 横軸の初期範囲 = X₀・全足の満期の折れ点・満期の BEP の範囲 + 余白 max(幅 × 15%, X₀ × 2%)（#6 で満期の
 *   BEP を追加。指定日の BEP はスライダーで動くので入れない）。全域（縮小の上限）=
 *   板の全限月（F が決まる限月）の行使価格の横軸上の位置 K − basis_i と初期範囲を合わせた範囲で、下端は
 *   X_lo（全足の原資産が 0 以上）。拡大の最小幅 = 板の行使価格の最小刻み × 2（無ければ X₀ × 1%）
 * - 縦軸: 自動（表示範囲内の全線のサンプル値・ピンの線の値（#22）と 0）/ 手動 / プレミアム基準 ±N × |受取 − 支払|
 * - ピン（#22）: 線の値は ui/view/pins.ts が作り（pins）、ここでは縦軸の自動と path だけ。横軸の初期範囲・全域は
 *   今のポジションだけで決める（ピンを外しても範囲が変わらない）
 * - 評価できない足（F が決まらない限月）は線から除く。計算は model/ の関数をそのまま使う
 */

import {
  DEFAULT_SETTINGS,
  type ExpiryProfile,
  expiryPnlFn,
  expiryProfile,
  type MarketContext,
  type ModelSettings,
  type PreparedLeg,
  premiumSummary,
  type Scenario,
  theoreticalPnl,
} from '../../model';
import {
  clampViewport,
  type Domain,
  extent,
  type FitTicksOptions,
  fitTicks,
  linear,
  niceTicks,
  padDomain,
  zoom,
} from '../chart/scale';
import { fmtNum } from './format';

/** 初期範囲の余白（幅に対する割合と、X₀ に対する最小） */
export const INITIAL_PAD_RATIO = 0.15;
export const INITIAL_PAD_MIN_X0 = 0.02;
/** 再サンプリングの点数の上限 */
export const MAX_SAMPLES = 2000;
/** 縦軸の目盛りを千円にする境（5.6 の指標の単位と同じ 10 万円） */
export const THOUSAND_YEN_FROM = 100_000;
/** プレミアム基準の既定の N */
export const DEFAULT_PREMIUM_N = 5;

/** 横軸の目盛りのラベル（円、整数） */
export const xTickLabel = (v: number) => fmtNum(v, 0);
/** 横軸の刻みの候補: 1・2・2.5・5 × 10^n（1 円以上、2.5 は 10 円以上だけ。#55） */
export const X_TICK_OPTIONS: FitTicksOptions = {
  mantissas: [1, 2, 2.5, 5],
  minStepFor: (m) => (m === 2.5 ? 10 : 1),
};

export const PNL_MARGIN = { left: 56, right: 12, top: 10, bottom: 26 } as const;

/** 描画域の高さ（px）: 既定 / 描画域の幅が狭いとき / スマホ（#61） */
export const PNL_HEIGHT = 260;
export const PNL_HEIGHT_NARROW = 220;
export const PNL_HEIGHT_PHONE = 180;
/** この幅（描画域の幅、px）未満を狭いとする */
export const PNL_NARROW_FROM = 560;

/**
 * 描画域の高さ。スマホ（ビューポート < 720px。ui/view/layout.ts の PHONE_QUERY）は 180px にして、
 * 上端に残るドックの下でページをスクロールできる高さを残す。それ以外は描画域の幅 < 560px で 220px、
 * 以上で 260px（#61）。
 */
export function pnlChartHeight(plotWidth: number, phone: boolean): number {
  if (phone) return PNL_HEIGHT_PHONE;
  return plotWidth < PNL_NARROW_FROM ? PNL_HEIGHT_NARROW : PNL_HEIGHT;
}

export type PnlYMode = 'auto' | 'manual' | 'premium';

export interface PnlYSettings {
  mode: PnlYMode;
  /** 手動の範囲（円）。未設定なら null */
  manual: Domain | null;
  /** プレミアム基準の N */
  n: number;
}

export const DEFAULT_PNL_Y: PnlYSettings = { mode: 'auto', manual: null, n: DEFAULT_PREMIUM_N };

/** 板の形（横軸の全域と最小幅に使う部分だけ。ChainMonth がそのまま入る） */
export interface PnlBoard {
  months: ReadonlyArray<{ F: number; rows: ReadonlyArray<{ k: number }> }>;
}

/** 足・板が変わったときだけ作る部分（App で memo）。 */
export interface PnlBase {
  /** 描く足（F が決まる足） */
  legs: PreparedLeg[];
  ctx: MarketContext;
  settings: ModelSettings;
  profile: ExpiryProfile;
  expiry: (x: number) => number;
  /** 受取 − 支払（円） */
  net: number;
  /** 指定日 d の上限（最遠の足の SQ までの暦日） */
  maxDays: number;
  initial: Domain;
  /** 縮小・パンの上限。板の全域（boardFull）に、その外のシナリオ点 X₀ + ΔX を足したもの（#144。withScenarioFull） */
  full: Domain;
  /** 板の全限月の行使価格と初期範囲の全域（pnlDomains が作る。指標の BEP の探索範囲） */
  boardFull: Domain;
  minWidth: number;
  xLo: number;
}

/**
 * 残存 T0（年）の足を満期にする d（暦日）: T0 × 365 を、model の T' = T0 − d / 365 が 0 以下になるまで
 * 1 ulp ずつ上げたもの（浮動小数の端数で T' が正の微小値 = near_expiry に残らないように。差は 1 ms よりずっと小さい）。
 */
export function daysToExpire(T0: number): number {
  let d = T0 * 365;
  for (let i = 0; i < 8 && T0 - d / 365 > 0; i++) {
    d += Math.max(Math.abs(d) * Number.EPSILON, Number.MIN_VALUE);
  }
  return d;
}

/** 指定日 d の上限 = 最遠の足の SQ までの暦日（足 0 本は 0。上限ちょうどで最遠の足が満期になる）。 */
export function maxScenarioDays(prepared: readonly PreparedLeg[]): number {
  let max = 0;
  for (const p of prepared) if (Number.isFinite(p.T0) && p.T0 > max) max = p.T0;
  return max > 0 ? daysToExpire(max) : 0;
}

/** 行使価格 K（限月の F）の横軸上の位置（円: K − (F − X₀)、比率: K · X₀ / F。満期の折れ点・足マーカーと同じ写像）。 */
export function axisX(k: number, F: number, x0: number, settings: ModelSettings): number {
  return settings.basisMode === 'yen' ? k - (F - x0) : (k * x0) / F;
}

/** 横軸の初期範囲・全域・最小幅など（足 0 本・X₀ が決まらなければ null）。 */
export function pnlDomains(
  board: PnlBoard,
  prepared: readonly PreparedLeg[],
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): PnlBase | null {
  const x0 = ctx.x0;
  if (!(Number.isFinite(x0) && x0 > 0)) return null;
  const legs = prepared.filter((p) => Number.isFinite(p.F));
  if (legs.length === 0) return null;
  const profile = expiryProfile(legs, ctx, settings);
  const lo0 = profile.points[0]?.x;
  const xLo = lo0 !== undefined && Number.isFinite(lo0) ? lo0 : 0;

  const core = extent([x0, ...profile.kinks, ...profile.breakevens]) ?? ([x0, x0] as Domain);
  const pad = Math.max((core[1] - core[0]) * INITIAL_PAD_RATIO, x0 * INITIAL_PAD_MIN_X0);
  const initialRaw: Domain = [core[0] - pad, core[1] + pad];

  const boardXs: number[] = [];
  let minGap = Number.POSITIVE_INFINITY;
  for (const m of board.months) {
    if (!(Number.isFinite(m.F) && m.F > 0)) continue;
    let prev: number | null = null;
    for (const r of m.rows) {
      boardXs.push(axisX(r.k, m.F, x0, settings));
      if (prev !== null && r.k > prev && r.k - prev < minGap) minGap = r.k - prev;
      prev = r.k;
    }
  }
  const fullRaw = extent([...boardXs, ...initialRaw]) ?? initialRaw;
  const full: Domain = [Math.max(fullRaw[0], xLo), fullRaw[1]];
  const initial: Domain = [Math.max(initialRaw[0], full[0]), Math.min(initialRaw[1], full[1])];
  const minWidth = Number.isFinite(minGap) ? minGap * 2 : x0 * 0.01;

  return {
    legs,
    ctx,
    settings,
    profile,
    expiry: expiryPnlFn(legs, ctx, settings),
    net: premiumSummary(legs, settings).net,
    maxDays: maxScenarioDays(legs),
    initial,
    full,
    boardFull: full,
    minWidth,
    xLo,
  };
}

/** シナリオ点の外の余白と、広げた全域の端の格子（X₀ に対する割合。#144） */
export const SCENARIO_FULL_PAD_RATIO = 0.05;

/**
 * シナリオ点 X_s = X₀ + ΔX を含む全域（#144）。X_s が板の全域（boardFull）の内側（両端含む）・非有限なら boardFull
 * そのもの（同じ参照）。外なら、その側の端を X_s ∓ 0.05X₀ を 0.05X₀ の格子に外向きに丸めた値へ広げる（0.5% 刻みの
 * 連続の操作で全域が毎段変わらない = 線を作り直すのは格子を跨ぐときだけ）。下端は xLo より下にしない。
 */
export function scenarioFull(base: PnlBase, dX: number): Domain {
  const board = base.boardFull;
  const x0 = base.ctx.x0;
  const xs = x0 + dX;
  if (!Number.isFinite(xs) || (xs >= board[0] && xs <= board[1])) return board;
  const g = SCENARIO_FULL_PAD_RATIO * x0;
  if (!(g > 0)) return board;
  if (xs < board[0]) {
    const lo = Math.max((Math.floor(xs / g) - 1) * g, base.xLo);
    return lo < board[0] ? [lo, board[1]] : board;
  }
  return [board[0], (Math.ceil(xs / g) + 1) * g];
}

/** 全域を差し替えた base（値が同じなら同じ参照。線の memo は base の参照を鍵にする） */
export function withScenarioFull(base: PnlBase, full: Domain): PnlBase {
  return full[0] === base.full[0] && full[1] === base.full[1] ? base : { ...base, full };
}

/**
 * 数値欄で確定した ΔX の点 X_s を見せる表示範囲（#144）。今の表示範囲（全域 = scenarioFull で収めたもの）に X_s が
 * 入っていれば null。X_s が全域の外（xLo より下）・非有限でも null。それ以外は X_s の側の端だけを X_s ∓ 0.05X₀
 * （全域の端まで）に動かし、反対側の端は保つ（広げる）。
 */
export function revealViewport(base: PnlBase, viewport: Domain | null, dX: number): Domain | null {
  const xs = base.ctx.x0 + dX;
  if (!Number.isFinite(xs)) return null;
  const full = scenarioFull(base, dX);
  if (xs < full[0] || xs > full[1]) return null;
  const cur = clampViewport(viewport ?? base.initial, full, base.minWidth);
  if (xs >= cur[0] && xs <= cur[1]) return null;
  const pad = SCENARIO_FULL_PAD_RATIO * base.ctx.x0;
  const next: Domain =
    xs < cur[0] ? [Math.max(xs - pad, full[0]), cur[1]] : [cur[0], Math.min(xs + pad, full[1])];
  return clampViewport(next, full, base.minWidth);
}

export type PnlLineKind = 'expiry' | 'date' | 'today';

export interface PnlLine {
  kind: PnlLineKind;
  xs: number[];
  /** 損益（円。model/ の値そのもの） */
  ys: number[];
  /** SVG の path（画素。縦は描画域の上下 10 倍に収める） */
  d: string;
}

export interface PnlTick {
  v: number;
  /** 画素（横軸は x、縦軸は y） */
  px: number;
  label: string;
}

export interface PnlMarker {
  x: number;
  y: number;
  px: number;
  py: number;
}

export type PnlYUnit = 'yen' | 'thousand';

/** 追証の線の 1 本（縦の破線と札） */
export interface PnlMarginCall {
  x: number;
  px: number;
  /** 札の寄せ: start = 線の右に置く、end = 線の左に置く（描画域の右端に近いとき） */
  anchor: 'start' | 'end';
}

/** 追証の札を線の左へ寄せる、描画域の右端からの距離（px） */
export const MARGIN_CALL_LABEL_PX = 36;

/** ピンの線の入力（ui/view/pins.ts の pinLineData。番号ごとに 1 本） */
export interface PnlPinInput {
  no: number;
  xs: readonly number[];
  ys: readonly number[];
}

/** ピンの線の path */
export interface PnlPinLine {
  no: number;
  /** 右端の点（横は表示範囲の上端。値が無ければ NaN） */
  lastY: number;
  d: string;
}

export interface PnlChartModel {
  empty: boolean;
  /** 表示中の横軸の範囲（全域に収めたもの） */
  domain: Domain;
  full: Domain;
  minWidth: number;
  yDomain: Domain;
  yUnit: PnlYUnit;
  lines: PnlLine[];
  /** ピンの線（#22。入力の順） */
  pins: PnlPinLine[];
  /** 表示範囲内の満期の折れ点 */
  kinks: PnlMarker[];
  /** 表示範囲内の満期の BEP */
  breakevens: PnlMarker[];
  /**
   * 追証の線（#131。設計 5.10）: 表示範囲内の X と画素、札「追証」の寄せ（右端に近ければ左へ）。資金が未設定・
   * 操作中（止まる前）・範囲外は無し
   */
  marginCalls: PnlMarginCall[];
  /** X₀ の縦線の画素（範囲外は null） */
  x0Px: number | null;
  /** シナリオ点 X₀ + ΔX（ΔX ≠ 0 のとき。範囲外・ΔX = 0 は画素 null） */
  scenarioX: number;
  scenarioPx: number | null;
  /**
   * 表示中の限月のシナリオ ATM（#26）。x = 横軸上の位置 K − basis_i（満期の折れ点と同じ写像）。
   * ΔX = 0・無し・F が決まらない・表示範囲外は null
   */
  scenarioAtm: { monthId: string; k: number; x: number; px: number } | null;
  /** 損益 0 の横線の画素（範囲外は null） */
  zeroPy: number | null;
  xTicks: PnlTick[];
  yTicks: PnlTick[];
  /** プレミアム基準を選んだが |受取 − 支払| < 1 円で自動にした */
  premiumFallback: boolean;
  /** 描いた指定日 d（上限に収めた値） */
  days: number;
  daysClamped: boolean;
  maxDays: number;
  /** 描画域（SVG の座標） */
  plot: { left: number; top: number; width: number; height: number };
}

export interface PnlChartInput {
  base: PnlBase | null;
  scenario: Scenario;
  viewport: Domain | null;
  pnlY: PnlYSettings;
  /** 描画域の幅・高さ（CSS px） */
  plotWidth: number;
  plotHeight: number;
  /**
   * 前計算した今日の線の値（todayLine の戻り値。スライダーの操作では今日の線が変わらないので部品が memo する）。
   * 無い・点数が合わなければ自分で作る
   */
  todayYs?: readonly number[] | null;
  /**
   * 前計算した指定日の線の値（dateLine の戻り値。ΔX は線の形に効かないので、長押しドラッグ・ΔX のスライダーでは
   * 作り直さない。#52）。無い・点数が合わなければ自分で作る
   */
  dateYs?: readonly number[] | null;
  /** 表示中の限月のシナリオ ATM（ui/view/scenarioAtm.ts の scenarioAtmMark の K と、その限月の F。#26） */
  scenarioAtm?: { monthId: string; k: number; F: number } | null;
  /** ピンの線の値（#22。表示範囲で作ったもの。縦軸の自動に入れて path にする） */
  pins?: readonly PnlPinInput[];
  /** 追証の線の X（#131。ui/view/margin.ts の marginLine。止まった後の値。操作中・資金なしは空） */
  marginLine?: readonly number[] | undefined;
}

/** 縦軸の目盛りの文言（千円は値 / 1,000。刻みに合わせて小数を出す）。 */
export function fmtPnlTick(v: number, unit: PnlYUnit, step = 0): string {
  const s = unit === 'thousand' ? step / 1000 : step;
  const digits = s > 0 && s < 1 ? Math.min(3, Math.ceil(-Math.log10(s) - 1e-9)) : 0;
  return fmtNum(unit === 'thousand' ? v / 1000 : v, digits);
}

export const Y_UNIT_LABEL: Record<PnlYUnit, string> = { yen: '円', thousand: '千円' };

function emptyModel(input: PnlChartInput): PnlChartModel {
  const w = Math.max(input.plotWidth, 1);
  const h = Math.max(input.plotHeight, 1);
  return {
    empty: true,
    domain: [0, 1],
    full: [0, 1],
    minWidth: 0,
    yDomain: [-1, 1],
    yUnit: 'yen',
    lines: [],
    pins: [],
    kinks: [],
    breakevens: [],
    marginCalls: [],
    x0Px: null,
    scenarioX: Number.NaN,
    scenarioPx: null,
    scenarioAtm: null,
    zeroPy: null,
    xTicks: [],
    yTicks: [],
    premiumFallback: false,
    days: 0,
    daysClamped: false,
    maxDays: input.base?.maxDays ?? 0,
    plot: { left: PNL_MARGIN.left, top: PNL_MARGIN.top, width: w, height: h },
  };
}

const validDomain = (d: Domain | null): d is Domain =>
  d !== null && Number.isFinite(d[0]) && Number.isFinite(d[1]) && d[0] < d[1];

const pt = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/**
 * 折れ線の path（画素）。縦は [yMin, yMax] に収めるが、線分がその境を横切る点を線形補間で求めて頂点に
 * 足すので、境の内側に見える部分は元の折れ線と同じ形になる（端点だけを収めると傾きが変わり、
 * 頂点の少ない満期の線が解析解からずれる）。非有限の y は値の符号の側の境に置く。
 */
export function clippedPath(
  xs: readonly number[],
  ys: readonly number[],
  yMin: number,
  yMax: number,
): string {
  const clamp = (y: number) =>
    Number.isFinite(y) ? Math.min(Math.max(y, yMin), yMax) : y < 0 ? yMin : yMax;
  let d = '';
  for (let i = 0; i < xs.length; i++) {
    const x2 = xs[i] as number;
    const y2 = ys[i] as number;
    if (i > 0) {
      const x1 = xs[i - 1] as number;
      const y1 = ys[i - 1] as number;
      if (Number.isFinite(y1) && Number.isFinite(y2) && y1 !== y2) {
        // 境を横切る点（y1 → y2 の向きの順）
        const ts: number[] = [];
        for (const b of [yMin, yMax]) {
          if ((y1 - b) * (y2 - b) < 0) ts.push((b - y1) / (y2 - y1));
        }
        ts.sort((a, b) => a - b);
        for (const t of ts) d += `L${pt(x1 + (x2 - x1) * t, clamp(y1 + (y2 - y1) * t))}`;
      }
    }
    d += `${i === 0 ? 'M' : 'L'}${pt(x2, clamp(y2))}`;
  }
  return d;
}

/** 今日の線のシナリオ: d = ΔX = Δσ = Δs = 0。β・動き方・IV 平行移動の解釈はシナリオの設定のまま（#6）。 */
export function todayScenario(sc: Scenario): Scenario {
  return { ...sc, days: 0, dX: 0, dSigma: 0, skew: 0 };
}

/** 指定日の線（シナリオ全体）を描くか: d > 0 または Δσ・Δs ≠ 0（#6）。 */
export function hasDateLine(sc: Scenario, days: number): boolean {
  return days > 0 || sc.dSigma !== 0 || sc.skew !== 0;
}

/** 表示範囲（全域・最小幅に収めたもの）。 */
export function pnlViewDomain(base: PnlBase, viewport: Domain | null): Domain {
  return clampViewport(viewport ?? base.initial, base.full, base.minWidth);
}

/** 再サンプリングの横軸（描画幅の CSS px の点、2〜2,000）。 */
export function sampleXs(domain: Domain, plotWidth: number): number[] {
  const [lo, hi] = domain;
  const n = Math.min(Math.max(Math.round(plotWidth), 2), MAX_SAMPLES);
  const xs = new Array<number>(n);
  for (let i = 0; i < n; i++) xs[i] = i === n - 1 ? hi : lo + ((hi - lo) * i) / (n - 1);
  return xs;
}

function sampleLine(base: PnlBase, xs: readonly number[], sc: Scenario): number[] {
  const { legs, ctx, settings } = base;
  return xs.map((x) => theoreticalPnl(legs, x, sc, ctx, settings));
}

/**
 * 今日の線の値（pnlChartModel の todayYs に渡す）。表示範囲・描画幅・β・動き方が変わったときだけ作り直せば
 * よい（d・ΔX・Δσ・Δs のスライダーでは変わらない）。
 */
export function todayLine(
  base: PnlBase | null,
  viewport: Domain | null,
  plotWidth: number,
  scenario: Scenario,
): number[] | null {
  if (!base) return null;
  return sampleLine(
    base,
    sampleXs(pnlViewDomain(base, viewport), plotWidth),
    todayScenario(scenario),
  );
}

/**
 * 指定日の線の値（pnlChartModel の dateYs に渡す。描かない条件・足なしは null）。ΔX は線の形に効かない
 * （β は評価点 X' ごと）ので、ΔX 以外のシナリオ・表示範囲・描画幅が変わったときだけ作り直せばよい（#52）。
 */
export function dateLine(
  base: PnlBase | null,
  viewport: Domain | null,
  plotWidth: number,
  scenario: Scenario,
): number[] | null {
  if (!base) return null;
  const { days } = clampDays(scenario, base.maxDays);
  if (!hasDateLine(scenario, days)) return null;
  return sampleLine(base, sampleXs(pnlViewDomain(base, viewport), plotWidth), {
    ...scenario,
    days,
  });
}

/** パネルの + / − の拡大・縮小（中心固定。×0.8 / ×1.25 はグラフのボタンと同じ）。 */
export function zoomViewport(base: PnlBase, viewport: Domain | null, factor: number): Domain {
  return zoom(pnlViewDomain(base, viewport), factor, base.full, base.minWidth);
}

/** 描く指定日 d（最遠の足の SQ に収める）と、収めたか。 */
export function clampDays(scenario: Scenario, maxDays: number): { days: number; clamped: boolean } {
  const want = Number.isFinite(scenario.days) ? Math.max(scenario.days, 0) : 0;
  return { days: Math.min(want, maxDays), clamped: want > maxDays + 1e-9 };
}

export function pnlChartModel(input: PnlChartInput): PnlChartModel {
  const { base, scenario } = input;
  if (!base) return emptyModel(input);
  const { ctx } = base;
  const domain = pnlViewDomain(base, input.viewport);
  const [lo, hi] = domain;

  // 満期: 頂点 = 表示範囲の両端と範囲内の折れ点
  const ex: number[] = [lo];
  for (const k of base.profile.kinks) if (k > lo && k < hi) ex.push(k);
  ex.push(hi);
  const lines: PnlLine[] = [{ kind: 'expiry', xs: ex, ys: ex.map(base.expiry), d: '' }];

  const xs = sampleXs(domain, input.plotWidth);
  const { days, clamped: daysClamped } = clampDays(scenario, base.maxDays);
  if (hasDateLine(scenario, days)) {
    const preDate = input.dateYs;
    const dateYs =
      preDate && preDate.length === xs.length
        ? [...preDate]
        : sampleLine(base, xs, { ...scenario, days });
    lines.push({ kind: 'date', xs, ys: dateYs, d: '' });
  }
  const pre = input.todayYs;
  const todayYs =
    pre && pre.length === xs.length ? [...pre] : sampleLine(base, xs, todayScenario(scenario));
  lines.push({ kind: 'today', xs, ys: todayYs, d: '' });

  // 縦軸（自動はピンの線も入れる。#22）
  const pinInputs = input.pins ?? [];
  const auto = (): Domain => {
    const e =
      extent([0, ...lines.flatMap((l) => l.ys), ...pinInputs.flatMap((p) => p.ys)]) ??
      ([-1, 1] as Domain);
    return padDomain(e, 0.08, 1);
  };
  let yDomain: Domain;
  let premiumFallback = false;
  const { pnlY } = input;
  if (pnlY.mode === 'manual' && validDomain(pnlY.manual)) yDomain = pnlY.manual;
  else if (pnlY.mode === 'premium') {
    const amp = Math.abs(base.net) * pnlY.n;
    if (Math.abs(base.net) >= 1 && Number.isFinite(amp) && amp > 0) yDomain = [-amp, amp];
    else {
      yDomain = auto();
      premiumFallback = true;
    }
  } else yDomain = auto();

  const left = PNL_MARGIN.left;
  const top = PNL_MARGIN.top;
  const pw = Math.max(input.plotWidth, 1);
  const ph = Math.max(input.plotHeight, 1);
  const sx = linear(domain, [left, left + pw]);
  const syRaw = linear(yDomain, [top + ph, top]);
  const yMin = top - 10 * ph;
  const yMax = top + 11 * ph;
  const sy = (v: number) => {
    const p = syRaw(v);
    return Number.isFinite(p) ? Math.min(Math.max(p, yMin), yMax) : v > 0 ? yMin : yMax;
  };
  for (const l of lines) {
    const px = l.xs.map((x) => sx(x));
    const py = l.ys.map((y) => syRaw(y));
    l.d = clippedPath(px, py, yMin, yMax);
  }
  const pins: PnlPinLine[] = pinInputs.map((p) => ({
    no: p.no,
    lastY: p.ys[p.ys.length - 1] ?? Number.NaN,
    d: clippedPath(
      p.xs.map((x) => sx(x)),
      p.ys.map((y) => syRaw(y)),
      yMin,
      yMax,
    ),
  }));

  const inside = (x: number) => x >= lo && x <= hi;
  const scenarioX = ctx.x0 + (Number.isFinite(scenario.dX) ? scenario.dX : 0);
  const sa = input.scenarioAtm;
  let scenarioAtm: PnlChartModel['scenarioAtm'] = null;
  if (sa && scenario.dX !== 0 && Number.isFinite(sa.k) && Number.isFinite(sa.F) && sa.F > 0) {
    const x = axisX(sa.k, sa.F, ctx.x0, base.settings);
    if (Number.isFinite(x) && inside(x))
      scenarioAtm = { monthId: sa.monthId, k: sa.k, x, px: sx(x) };
  }
  const kinks = base.profile.kinks.filter(inside).map((x) => {
    const y = base.expiry(x);
    return { x, y, px: sx(x), py: sy(y) };
  });
  const breakevens = base.profile.breakevens
    .filter(inside)
    .map((x) => ({ x, y: 0, px: sx(x), py: sy(0) }));
  const callEdge = left + pw - MARGIN_CALL_LABEL_PX;
  const marginCalls: PnlMarginCall[] = (input.marginLine ?? [])
    .filter((x) => Number.isFinite(x) && inside(x))
    .map((x) => {
      const px = sx(x);
      return { x, px, anchor: px > callEdge ? 'end' : 'start' };
    });

  const yUnit: PnlYUnit =
    Math.max(Math.abs(yDomain[0]), Math.abs(yDomain[1])) >= THOUSAND_YEN_FROM ? 'thousand' : 'yen';
  const yt = niceTicks(yDomain[0], yDomain[1], 5);
  const yStep = yt.length > 1 ? (yt[1] as number) - (yt[0] as number) : 0;
  // 横軸はラベルが重ならない範囲で最も細かい刻み（#55）。2.5 は 10 円以上だけ（行使価格の 250 円刻みと揃う）
  const xt = fitTicks(lo, hi, pw, xTickLabel, { ...X_TICK_OPTIONS, widthSample: base.full });

  return {
    empty: false,
    domain,
    full: base.full,
    minWidth: base.minWidth,
    yDomain,
    yUnit,
    lines,
    pins,
    kinks,
    breakevens,
    marginCalls,
    x0Px: inside(ctx.x0) ? sx(ctx.x0) : null,
    scenarioX,
    scenarioPx: scenario.dX !== 0 && inside(scenarioX) ? sx(scenarioX) : null,
    scenarioAtm,
    zeroPy: yDomain[0] <= 0 && yDomain[1] >= 0 ? syRaw(0) : null,
    xTicks: xt.map((v) => ({ v, px: sx(v), label: xTickLabel(v) })),
    yTicks: yt.map((v) => ({ v, px: syRaw(v), label: fmtPnlTick(v, yUnit, yStep) })),
    premiumFallback,
    days,
    daysClamped,
    maxDays: base.maxDays,
    plot: { left, top, width: pw, height: ph },
  };
}

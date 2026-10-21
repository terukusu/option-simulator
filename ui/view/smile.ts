/**
 * スマイルの表示モデル（純関数）。設計 docs/design.md M2・M10（スマイル）・M11・5.3。
 *
 * - 点: OTM 側の節点の bid / ask / mid の IV（不安定な行は × だけ）
 * - 線: 行使価格ごとの σ_smile(K) を結ぶ。両端の行が節点の区間は実線、それ以外（補間・外挿）は点線
 * - 横軸: 行使価格 K / moneyness K / X₀,i − 1 / デルタ（割引前の put 換算 N(−d₁)。0〜1 で、おおむね
 *   K に対して増加。IV の傾きが急な put の深い翼では単調でないことがある = 例外にせずそのまま描く）
 * - 縦軸: IV（%）
 */

import type { ChainMonth, StrikeInfo } from '../../data';
import { type AtmBasis, normCdf, type OptionType } from '../../model';
import { clipSegment, type Domain, extent, linear, padDomain } from '../chart/scale';
import { type CrossTagBox, crossFloatBottom, crossTagX, crossTagY } from './crosshair';
import { fmtNum } from './format';

export type SmileAxis = 'k' | 'moneyness' | 'delta';

export const AXIS_LABEL: Record<SmileAxis, string> = {
  k: '行使価格',
  moneyness: 'moneyness',
  delta: 'デルタ',
};

export type SegmentStyle = 'solid' | 'dotted';
export type PointKind = 'bid' | 'ask' | 'mid';

export interface SmilePoint {
  x: number;
  /** IV（%） */
  iv: number;
  kind: PointKind;
  k: number;
}

export interface SmileSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  style: SegmentStyle;
  /** 区間の両端の行使価格 */
  k1: number;
  k2: number;
}

export interface SmileUnstable {
  x: number;
  iv: number;
  k: number;
}

export interface SmileModel {
  axis: SmileAxis;
  points: SmilePoint[];
  segments: SmileSegment[];
  unstable: SmileUnstable[];
  /** 選択中の基準の市場 ATM の横軸の位置（無い・範囲外なら null） */
  atmX: number | null;
  atmK: number | null;
  /** 表示中の横軸の範囲 */
  domain: Domain;
  /** 横軸の全域（拡大の上限） */
  fullDomain: Domain;
  /** 縦軸（IV %）の範囲 */
  yDomain: Domain;
  /** 拡大の最小幅（行使価格 2 本分） */
  minWidth: number;
  /** 表示範囲内の点・× のある行使価格の横軸の位置（タップで選ぶ候補。K の昇順） */
  strikeXs: Array<{ k: number; x: number }>;
  empty: boolean;
}

/** デルタ軸の値: 割引前の put 換算 N(−d₁)（σ はスマイルの IV）。 */
export function deltaAxisValue(F: number, k: number, T: number, sigma: number): number | null {
  if (!(F > 0) || !(k > 0) || !(T > 0) || !(sigma > 0)) return null;
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / k) + (sd * sd) / 2) / sd;
  const v = normCdf(-d1);
  return Number.isFinite(v) ? v : null;
}

/** 横軸の原点 X₀,i（選択中の基準の基準価格。無ければ F_i）。 */
function axisOriginOf(month: ChainMonth, basis: AtmBasis): number | null {
  const p = month.atm[basis].reference.price;
  if (p !== null && Number.isFinite(p) && p > 0) return p;
  return Number.isFinite(month.F) && month.F > 0 ? month.F : null;
}

/** 行使価格 → 横軸の値（決まらなければ null）。 */
export function axisValue(
  month: ChainMonth,
  basis: AtmBasis,
  axis: SmileAxis,
  info: Pick<StrikeInfo, 'k' | 'smileIv'>,
): number | null {
  if (axis === 'k') return info.k;
  if (axis === 'moneyness') {
    const x0 = axisOriginOf(month, basis);
    return x0 === null ? null : info.k / x0 - 1;
  }
  return info.smileIv === null ? null : deltaAxisValue(month.F, info.k, month.T, info.smileIv);
}

const pct = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v * 100;

const EMPTY_DOMAIN: Domain = [0, 1];

function emptyModel(axis: SmileAxis): SmileModel {
  return {
    axis,
    points: [],
    segments: [],
    unstable: [],
    atmX: null,
    atmK: null,
    domain: EMPTY_DOMAIN,
    fullDomain: EMPTY_DOMAIN,
    yDomain: [0, 100],
    minWidth: 0,
    strikeXs: [],
    empty: true,
  };
}

/** スマイルの表示モデル。viewport を渡すと横軸をその範囲に絞る（線種・× は保つ）。 */
export function smileModel(
  month: ChainMonth,
  basis: AtmBasis,
  axis: SmileAxis,
  viewport?: Domain | null,
): SmileModel {
  if (!month.smile) return emptyModel(axis);
  const xs = month.strikes.map((s) => axisValue(month, basis, axis, s));

  const allPoints: SmilePoint[] = [];
  const allUnstable: SmileUnstable[] = [];
  month.strikes.forEach((s, i) => {
    const x = xs[i];
    const node = s.node;
    if (x === null || x === undefined || !Number.isFinite(x) || !node) return;
    if (node.unstable) {
      const iv = pct(node.iv);
      if (iv !== null) allUnstable.push({ x, iv, k: s.k });
      return;
    }
    const add = (kind: PointKind, v: number | null) => {
      const iv = pct(v);
      if (iv !== null) allPoints.push({ x, iv, kind, k: s.k });
    };
    add('bid', node.bidIv);
    add('ask', node.askIv);
    add('mid', node.midIv);
  });

  const allSegments: SmileSegment[] = [];
  let prev: { x: number; y: number; k: number; node: boolean } | null = null;
  month.strikes.forEach((s, i) => {
    const x = xs[i];
    const y = pct(s.smileIv);
    if (x === null || x === undefined || !Number.isFinite(x) || y === null) {
      prev = null;
      return;
    }
    const cur = { x, y, k: s.k, node: s.mark === 'node' };
    if (prev) {
      allSegments.push({
        x1: prev.x,
        y1: prev.y,
        x2: cur.x,
        y2: cur.y,
        style: prev.node && cur.node ? 'solid' : 'dotted',
        k1: prev.k,
        k2: cur.k,
      });
    }
    prev = cur;
  });

  const full = extent([
    ...allPoints.map((p) => p.x),
    ...allUnstable.map((p) => p.x),
    ...allSegments.flatMap((s) => [s.x1, s.x2]),
  ]);
  if (!full) return emptyModel(axis);

  const sortedX = [
    ...new Set(xs.filter((x): x is number => x !== null && Number.isFinite(x))),
  ].sort((a, b) => a - b);
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sortedX.length; i++) {
    const g = (sortedX[i] as number) - (sortedX[i - 1] as number);
    if (g > 0 && g < minGap) minGap = g;
  }
  const minWidth = Number.isFinite(minGap) ? minGap * 2 : 0;

  const domain: Domain = viewport ?? full;
  const [lo, hi] = domain;
  const inside = (x: number) => x >= lo && x <= hi;
  const points = allPoints.filter((p) => inside(p.x));
  const unstable = allUnstable.filter((p) => inside(p.x));
  const segments: SmileSegment[] = [];
  for (const s of allSegments) {
    const c = clipSegment(s.x1, s.y1, s.x2, s.y2, lo, hi);
    if (c) segments.push({ ...s, x1: c[0], y1: c[1], x2: c[2], y2: c[3] });
  }

  const ys = extent([
    ...points.map((p) => p.iv),
    ...unstable.map((p) => p.iv),
    ...segments.flatMap((s) => [s.y1, s.y2]),
  ]);
  const yDomain = ys ? padDomain(ys, 0.08, 1) : ([0, 100] as Domain);

  const strikeXs: Array<{ k: number; x: number }> = [];
  const seen = new Set<number>();
  for (const p of [...points, ...unstable]) {
    if (seen.has(p.k)) continue;
    seen.add(p.k);
    strikeXs.push({ k: p.k, x: p.x });
  }
  strikeXs.sort((a, b) => a.k - b.k);

  const atmK = month.atm[basis].pick?.k ?? null;
  const atmInfo = atmK === null ? undefined : month.strikes.find((s) => s.k === atmK);
  const atmX = atmInfo ? axisValue(month, basis, axis, atmInfo) : null;

  return {
    axis,
    points,
    segments,
    unstable,
    atmX: atmX !== null && Number.isFinite(atmX) && inside(atmX) ? atmX : null,
    atmK,
    domain,
    fullDomain: full,
    yDomain,
    minWidth,
    strikeXs,
    empty: false,
  };
}

/**
 * 行使価格 k の印（シナリオ ATM の縦線。#26）の横軸の位置。市場 ATM の縦線と同じ axisValue で、
 * k が無い・板に無い・値が決まらない・表示範囲外なら null。
 */
export function smileMarkX(
  model: SmileModel,
  month: ChainMonth,
  basis: AtmBasis,
  axis: SmileAxis,
  k: number | null,
): number | null {
  if (k === null || model.empty) return null;
  const info = month.strikes.find((s) => s.k === k);
  if (!info) return null;
  const x = axisValue(month, basis, axis, info);
  if (x === null || !Number.isFinite(x)) return null;
  return x >= model.domain[0] && x <= model.domain[1] ? x : null;
}

/** タップで選ぶ許容（画素） */
export const PICK_TOLERANCE_PX = 12;

/**
 * 横軸の画素 px に最も近い点・× の行使価格（横軸の画素の差が tolPx 以内。無ければ null）。
 * range は描画域の横の画素範囲。
 */
export function pickStrike(
  model: SmileModel,
  px: number,
  range: Domain,
  tolPx = PICK_TOLERANCE_PX,
): number | null {
  if (model.empty || !Number.isFinite(px)) return null;
  const sx = linear(model.domain, range);
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of model.strikeXs) {
    const d = Math.abs(sx(s.x) - px);
    if (d <= tolPx && d < bestD) {
      best = s.k;
      bestD = d;
    }
  }
  return best;
}

/**
 * タップで選ぶ行使価格（#59）: 最寄りの点（12px 以内）。いま選んでいる点をもう一度タップしたら解除（null）、
 * 点から離れた所のタップも解除。長押しで選んだ選択も離した後は残り、タップで解除する。
 */
export function tapStrike(
  model: SmileModel,
  px: number,
  range: Domain,
  current: number | null,
): number | null {
  const k = pickStrike(model, px, range);
  return k === current ? null : k;
}

/** 表示範囲の中の行使価格（横軸の値の昇順 = 画面の左から）。 */
function visibleStrikes(model: SmileModel): Array<{ k: number; x: number }> {
  const [lo, hi] = model.domain;
  return model.strikeXs.filter((s) => s.x >= lo && s.x <= hi).sort((a, b) => a.x - b.x);
}

/**
 * 長押し・ドラッグで選ぶ行使価格（#57）: 画素 px に最も近い、表示範囲の中の点の行使価格（距離の制限なし。
 * 指が点から離れていても最寄りに吸い付く）。描くものが無い・px が数でなければ null。
 */
export function scrubStrike(model: SmileModel, px: number, range: Domain): number | null {
  if (model.empty || !Number.isFinite(px)) return null;
  const sx = linear(model.domain, range);
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of visibleStrikes(model)) {
    const d = Math.abs(sx(s.x) - px);
    if (d < bestD) {
      best = s.k;
      bestD = d;
    }
  }
  return best;
}

/** キー , . で 1 本、< > で 5 本、選択を画面の左右へ動かす（#57） */
export const SCRUB_KEY_STEPS: Readonly<Record<string, number>> = {
  ',': -1,
  '.': 1,
  '<': -5,
  '>': 5,
};

/**
 * キーで選択を動かした先の行使価格（#57）。表示範囲の中の点を画面の左から並べ、いまの選択から steps 本動かす
 * （端で止まる）。選択が無い・表示範囲の外なら、市場 ATM（無ければ範囲の中央に最も近い点）から始める。
 * 点が無ければ null。
 */
export function stepStrike(
  model: SmileModel,
  current: number | null,
  steps: number,
): number | null {
  const vis = visibleStrikes(model);
  if (model.empty || vis.length === 0) return null;
  let i = current === null ? -1 : vis.findIndex((s) => s.k === current);
  if (i < 0) {
    const atm = model.atmK === null ? -1 : vis.findIndex((s) => s.k === model.atmK);
    if (atm >= 0) return vis[atm]?.k ?? null;
    const mid = (model.domain[0] + model.domain[1]) / 2;
    i = 0;
    for (let j = 1; j < vis.length; j++) {
      if (Math.abs((vis[j] as { x: number }).x - mid) < Math.abs((vis[i] as { x: number }).x - mid))
        i = j;
    }
    return vis[i]?.k ?? null;
  }
  const to = Math.min(Math.max(i + steps, 0), vis.length - 1);
  return vis[to]?.k ?? null;
}

export interface SmilePickRow {
  k: number;
  /** 足の種別（OTM 側。板の bid / ask と同じ規則で足を作る） */
  type: OptionType;
  bid: number | null;
  ask: number | null;
  unstable: boolean;
}

/** 選んだ行使価格の操作行（板に無ければ null）。 */
export function smilePickRow(month: ChainMonth, k: number): SmilePickRow | null {
  const i = month.strikes.findIndex((s) => s.k === k);
  const info = month.strikes[i];
  const row = month.rows[i];
  if (!info || !row) return null;
  const q = row[info.otmType];
  return { k, type: info.otmType, bid: q.bid, ask: q.ask, unstable: info.unstable };
}

/** 横軸の目盛りの文言。デルタは 0.5 未満を「P 0.10」、超を「C 0.10」（= 1 − x）。 */
export function axisTickLabel(axis: SmileAxis, v: number): string {
  if (axis === 'k') return fmtNum(v, 0);
  if (axis === 'moneyness') {
    const p = v * 100;
    const whole = Math.abs(p - Math.round(p)) < 1e-6;
    return `${p > 1e-9 ? '+' : ''}${fmtNum(whole ? Math.round(p) : p, whole ? 0 : 1)}%`;
  }
  if (Math.abs(v - 0.5) < 1e-9) return '0.50';
  return v < 0.5 ? `P ${fmtNum(v, 2)}` : `C ${fmtNum(1 - v, 2)}`;
}

// ---------------------------------------------------------------- 十字線（#217）

/** 描画域の余白（px。market/SmilePlot.tsx の描画と十字線の座標で共用） */
export const SMILE_MARGIN = { left: 38, right: 22, top: 14, bottom: 24 } as const;

/** 十字線のカーソル（値の座標: x = 横軸の値、iv = IV %）。touch = タッチのタップで出した（読み取りを指から離す） */
export interface SmileCursor {
  x: number;
  iv: number;
  touch: boolean;
}

/** 読み取りの頭の横軸の名前（短く） */
const AXIS_SHORT: Record<SmileAxis, string> = { k: 'K', moneyness: 'm', delta: 'Δ' };

/** 十字線の横軸の札の文字（目盛りより 1 桁細かい: K 円の整数、moneyness 小数 2 桁の %、Δ 小数 3 桁） */
export function smileCrossXText(axis: SmileAxis, v: number): string {
  if (axis === 'k') return fmtNum(v, 0);
  if (axis === 'moneyness') {
    const p = v * 100;
    return `${p > 0.0049 ? '+' : ''}${fmtNum(p, 2)}%`;
  }
  return v < 0.5 ? `P ${fmtNum(v, 3)}` : `C ${fmtNum(1 - v, 3)}`;
}

/**
 * 曲線（σ_smile を結んだ線。実線・点線の区間とも）の横軸の値 x での IV（%）。区間の線形補間（描いている線と同じ）。
 * x を含む区間が無い（曲線の外）なら null。Δ 軸で単調でない所は配列の先の区間
 */
export function smileCurveIv(model: SmileModel, x: number): number | null {
  if (model.empty || !Number.isFinite(x)) return null;
  for (const s of model.segments) {
    const lo = Math.min(s.x1, s.x2);
    const hi = Math.max(s.x1, s.x2);
    if (x < lo || x > hi) continue;
    if (hi - lo < 1e-12) return s.y1;
    return s.y1 + ((x - s.x1) * (s.y2 - s.y1)) / (s.x2 - s.x1);
  }
  return null;
}

export interface SmileCrosshair {
  px: number;
  py: number;
  xTag: CrossTagBox;
  yTag: CrossTagBox;
  /** 曲線の IV（%。曲線の外は null）と、その画素（縦軸の範囲の外は null） */
  curveIv: number | null;
  dotPy: number | null;
  /** 読み取り（svg の文字。縦線と反対の側。タッチで指が上側なら下端） */
  read: { text: string; x: number; y: number; anchor: 'start' | 'end' };
}

/**
 * スマイルの十字線（#217。docs/ui-redesign.md §4.1）。縦線 = カーソルの横軸の値（吸着しない）、横線 = カーソルの IV
 * （指 / マウスの高さ。描画域の上下で止める）。札 = 横軸の値・横線の高さの IV（小数 2 桁 = IV 推移と同じ）。読み取り =
 * 横軸の値と曲線の IV。カーソルが表示範囲の外・空なら null
 */
export function smileCrosshair(
  model: SmileModel,
  cursor: SmileCursor | null,
  width: number,
  height: number,
): SmileCrosshair | null {
  if (model.empty || !cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.iv)) {
    return null;
  }
  const [lo, hi] = model.domain;
  if (cursor.x < lo || cursor.x > hi) return null;
  const M = SMILE_MARGIN;
  const left = M.left;
  const right = width - M.right;
  const top = M.top;
  const bottom = height - M.bottom;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const sx = linear(model.domain, [left, right]);
  const sy = linear(model.yDomain, [bottom, top]);
  const px = r1(sx(cursor.x));
  const py = r1(Math.min(Math.max(sy(cursor.iv), top), bottom));
  const level = linear([bottom, top], model.yDomain)(py);
  const xText = smileCrossXText(model.axis, cursor.x);
  const curveIv = smileCurveIv(model, cursor.x);
  const cy = curveIv === null ? null : sy(curveIv);
  const dotPy = cy !== null && cy >= top - 0.5 && cy <= bottom + 0.5 ? r1(cy) : null;
  const text = `${AXIS_SHORT[model.axis]} ${xText} · 曲線 ${curveIv === null ? '—' : `${fmtNum(curveIv, 2)}%`}`;
  const leftSide = px > (left + right) / 2;
  const down = cursor.touch && crossFloatBottom(py, height);
  return {
    px,
    py,
    xTag: crossTagX(xText, px, bottom + 3, width, height),
    yTag: crossTagY(fmtNum(level, 2), py, left - 1, width, height),
    curveIv,
    dotPy,
    read: {
      text,
      x: leftSide ? left + 4 : right - 4,
      y: down ? bottom - 9 : top + 9,
      anchor: leftSide ? 'start' : 'end',
    },
  };
}

/** 画素（要素の座標）→ カーソル（値の座標）。描画域の外は null（ホバー）、clamp なら端へ寄せる（交点のドラッグ） */
export function smileCursorAt(
  model: SmileModel,
  x: number,
  y: number,
  width: number,
  height: number,
  touch: boolean,
  clampToPlot: boolean,
): SmileCursor | null {
  if (model.empty || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const M = SMILE_MARGIN;
  const left = M.left;
  const right = width - M.right;
  const top = M.top;
  const bottom = height - M.bottom;
  if (!clampToPlot && (x < left || x > right || y < top || y > bottom)) return null;
  const cx = Math.min(Math.max(x, left), right);
  const cy = Math.min(Math.max(y, top), bottom);
  return {
    x: linear([left, right], model.domain)(cx),
    iv: linear([bottom, top], model.yDomain)(cy),
    touch,
  };
}

/**
 * 点に吸着したカーソル（#217: タッチのタップで点を選んだとき）: 横軸 = その行使価格の横軸の値、IV = mid の点（無ければ
 * × の点、それも無ければ曲線）の IV。表示範囲に点が無ければ null
 */
export function smileDotCursor(model: SmileModel, k: number, touch: boolean): SmileCursor | null {
  const s = model.strikeXs.find((q) => q.k === k);
  if (!s) return null;
  const iv =
    model.points.find((q) => q.k === k && q.kind === 'mid')?.iv ??
    model.unstable.find((q) => q.k === k)?.iv ??
    model.points.find((q) => q.k === k)?.iv ??
    smileCurveIv(model, s.x);
  return iv === null || iv === undefined ? null : { x: s.x, iv, touch };
}

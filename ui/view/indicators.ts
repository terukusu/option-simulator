/**
 * 先物推移の指標の段（#200。docs/ui-redesign.md §4.8）の表示モデル（純関数。Preact に依存しない）。指標の値は
 * model/technicals.ts の indicators（AI のツール technicals と同じ計算）。ここは段の座標・補助線・見出しの文字だけ。
 *
 * - 段は価格の描画域の下に、同じ表示範囲（index の viewport）・同じ横の画素範囲（左の余白 = 系列の目盛りの列、右 =
 *   IV_MARGIN.right）で描く = パン・拡大・カーソルが価格と揃う。段の高さは既定 IND_PANE_H（#207 で覚えた高さ。縦に狭いと
 *   縮み、下限 IND_PANE_MIN_H が入らない段は隠す = futPaneLayout）
 * - RSI・ストキャスティクスは 0〜100 の固定（補助線 30 / 70・20 / 80）、MACD は見えている足の MACD・シグナル・ヒストの
 *   最小〜最大（0 を含む）で、ヒストは棒（正 / 負）、MACD とシグナルは線
 * - 見出し: 名前とパラメータ（計算に使った期間 = ind.params。#205 で設定から変えられる。例「RSI（14）」）、カーソルの足
 *   （無ければ最新の足）の値
 * - 線は見えている足（端は 1 本外まで）だけ。値の無い足（計算に足りない先頭）で線を切る。色は持たない（CSS のクラス名だけ）
 */

import {
  type Indicators,
  RSI_HIGH,
  RSI_LOW,
  type Series,
  STOCH_HIGH,
  STOCH_LOW,
  type TechParams,
} from '../../model';
import { type Domain, linear, padDomain } from '../chart/scale';
import { crossFloatBottom } from './crosshair';
import { DASH, fmtNum } from './format';
import { IV_MARGIN, IV_TAG_H, IV_TAG_PAD_Y, ivCursorBar, labelPx } from './ivHistory';

export type IndKind = 'rsi' | 'macd' | 'stoch';

/** 段の切替（凡例の行のトグル。文字は短く、aria-label は indKindLabel で期間つきの全文） */
export const IND_KINDS: readonly { value: IndKind; text: string }[] = [
  { value: 'rsi', text: 'RSI' },
  { value: 'macd', text: 'MACD' },
  { value: 'stoch', text: 'SO' },
];

/** 期間の文字（「14」「12・26・9」「14・3・3」。ストキャスティクスは %K・スロー・%D の順） */
export function indParamText(kind: IndKind, p: TechParams): string {
  if (kind === 'rsi') return String(p.rsi);
  if (kind === 'macd') return `${p.macdFast}・${p.macdSlow}・${p.macdSignal}`;
  return `${p.stochK}・${p.stochSmooth}・${p.stochD}`;
}

const IND_NAME: Record<IndKind, string> = {
  rsi: 'RSI',
  macd: 'MACD',
  stoch: 'ストキャスティクス',
};

/** 段の切替の aria-label（例「RSI（14）の段」） */
export function indKindLabel(kind: IndKind, p: TechParams): string {
  return `${IND_NAME[kind]}（${indParamText(kind, p)}）の段`;
}

/** 段の見出しの名前（例「RSI（14）」「SO（14・3・3）」） */
export function indTitle(kind: IndKind, p: TechParams): string {
  return `${IND_KINDS.find((k) => k.value === kind)?.text ?? ''}（${indParamText(kind, p)}）`;
}

/** 段の高さ（px） */
export const IND_PANE_H = 56;
/** 段の高さの下限（px） */
export const IND_PANE_MIN_H = 24;

/** 段の上下の余白（px。上は見出しの行） */
const PAD_TOP = 14;
const PAD_BOTTOM = 4;

export interface IndLine {
  /** CSS のクラス（ind-line main / sub） */
  cls: string;
  d: string;
}

export interface IndGuide {
  y: number;
  /** 縦の目盛りの文字（左の余白） */
  label: string;
  /** 0 の線（MACD）は少し濃く */
  zero: boolean;
}

export interface IndPaneModel {
  kind: IndKind;
  width: number;
  height: number;
  range: Domain;
  guides: IndGuide[];
  lines: IndLine[];
  /** MACD のヒスト（正 / 負の棒を 1 本ずつの path。無ければ空文字） */
  histUp: string;
  histDown: string;
  /** 見出し（名前とパラメータ） */
  title: string;
  /** svg の名前（期間つき） */
  imgLabel: string;
  /** 縦の値の範囲と、それを当てる画素の範囲（[下端, 上端]。十字線の横線の高さ → 値。#207） */
  yDomain: Domain;
  yPx: Domain;
}

/** 段の読み取り（カーソルの縦線の x と、カーソルの足 = 無ければ最新の足の値）。カーソルだけで作り直す（O(1)） */
export interface IndReadout {
  cursorX: number | null;
  values: { k: string; v: string; cls: string }[];
}

export interface IndPaneInput {
  ind: Indicators;
  kind: IndKind;
  /** 足の本数（ind の配列の長さ） */
  n: number;
  viewport: Domain;
  width: number;
  /** 左の余白（価格の系列の目盛りの列。FUT_SERIES.marginLeft） */
  marginLeft: number;
  /** 段の高さ（px。無ければ IND_PANE_H） */
  height?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const at = (s: Series, i: number): number | null => {
  const v = s[i];
  return v === undefined || v === null || !Number.isFinite(v) ? null : v;
};

/**
 * 線の path（値の無い足で切る。i0 − 1〜i1 + 1）。1 画素に 2 本以上の足が入るとき（縮小）は 1 画素の列に 1 点
 * （その列の最後の足）だけ描く = 点の数は描画域の幅まで（1 万本でも 1 フレームの予算に収める。#200 AC7）
 */
function linePath(
  s: Series,
  i0: number,
  i1: number,
  sx: (v: number) => number,
  sy: (v: number) => number,
  thin: boolean,
): string {
  let d = '';
  let pen = false;
  const from = Math.max(i0 - 1, 0);
  const to = Math.min(i1 + 1, s.length - 1);
  for (let i = from; i <= to; i++) {
    const v = at(s, i);
    if (v === null) {
      pen = false;
      continue;
    }
    const x = sx(i);
    // 縮小: 次の足が同じ画素の列で値があるなら、この足は飛ばす（列の最後の足だけ）
    if (thin && i < to && Math.floor(sx(i + 1)) === Math.floor(x) && at(s, i + 1) !== null)
      continue;
    d += `${pen ? 'L' : 'M'}${r1(x)} ${r1(sy(v))}`;
    pen = true;
  }
  return d;
}

const fmt1 = (v: number | null) => (v === null ? DASH : fmtNum(v, 1));
const fmt0 = (v: number | null) => (v === null ? DASH : fmtNum(v, 0));

/** 段の座標（見えている足だけ） */
export function indPaneModel(p: IndPaneInput): IndPaneModel {
  const { ind, kind, n, viewport } = p;
  const left = p.marginLeft;
  const w = Math.max(p.width, left + IV_MARGIN.right + 10);
  const h = Math.max(p.height ?? IND_PANE_H, IND_PANE_MIN_H);
  const range: Domain = [left, w - IV_MARGIN.right];
  const sx = linear(viewport, range);
  const i0 = Math.max(0, Math.ceil(viewport[0]));
  const i1 = Math.min(n - 1, Math.floor(viewport[1]));
  const yPx: Domain = [h - PAD_BOTTOM, PAD_TOP];
  // 1 画素に 2 本以上の足が入る（縮小）
  const thin = (viewport[1] - viewport[0]) / Math.max(range[1] - range[0], 1) >= 2;

  if (kind === 'macd') {
    const { macd, signal, hist } = ind.macd;
    let lo = 0;
    let hi = 0;
    for (let i = i0; i <= i1; i++) {
      for (const s of [macd, signal, hist]) {
        const v = at(s, i);
        if (v === null) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const yDomain: Domain = hi > lo ? padDomain([lo, hi], 0.08, 0) : [-1, 1];
    const sy = linear(yDomain, yPx);
    const perBar = (range[1] - range[0]) / Math.max(viewport[1] - viewport[0], 1e-9);
    const bw = Math.min(Math.max(perBar * 0.6, 1), 10);
    const y0 = r1(sy(0));
    let histUp = '';
    let histDown = '';
    // 縮小（1 画素に 2 本以上）は 1 画素の列に 1 本（その列で絶対値が最大の足）
    let col = Number.NaN;
    let best: number | null = null;
    let bestI = 0;
    const flush = () => {
      if (best === null || best === 0) return;
      const x = r1(sx(bestI) - bw / 2);
      const bar = `M${x} ${y0}V${r1(sy(best))}h${r1(bw)}V${y0}Z`;
      if (best > 0) histUp += bar;
      else histDown += bar;
    };
    for (let i = i0; i <= i1; i++) {
      const v = at(hist, i);
      if (v === null) continue;
      const c = thin ? Math.floor(sx(i)) : i;
      if (c !== col) {
        flush();
        col = c;
        best = v;
        bestI = i;
      } else if (Math.abs(v) > Math.abs(best ?? 0)) {
        best = v;
        bestI = i;
      }
    }
    flush();
    return {
      kind,
      width: w,
      height: h,
      range,
      guides: [{ y: y0, label: '0', zero: true }],
      lines: [
        { cls: 'ind-line main', d: linePath(macd, i0, i1, sx, sy, thin) },
        { cls: 'ind-line sub', d: linePath(signal, i0, i1, sx, sy, thin) },
      ],
      histUp,
      histDown,
      title: indTitle(kind, ind.params),
      imgLabel: indImgLabel(kind, ind.params),
      yDomain,
      yPx,
    };
  }

  const sy = linear([0, 100], yPx);
  const guide = (v: number): IndGuide => ({ y: r1(sy(v)), label: String(v), zero: false });
  if (kind === 'rsi') {
    return {
      kind,
      width: w,
      height: h,
      range,
      guides: [guide(RSI_HIGH), guide(RSI_LOW)],
      lines: [{ cls: 'ind-line main', d: linePath(ind.rsi, i0, i1, sx, sy, thin) }],
      histUp: '',
      histDown: '',
      title: indTitle(kind, ind.params),
      imgLabel: indImgLabel(kind, ind.params),
      yDomain: [0, 100],
      yPx,
    };
  }
  return {
    kind,
    width: w,
    height: h,
    range,
    guides: [guide(STOCH_HIGH), guide(STOCH_LOW)],
    lines: [
      { cls: 'ind-line main', d: linePath(ind.stoch.k, i0, i1, sx, sy, thin) },
      { cls: 'ind-line sub', d: linePath(ind.stoch.d, i0, i1, sx, sy, thin) },
    ],
    histUp: '',
    histDown: '',
    title: indTitle(kind, ind.params),
    imgLabel: indImgLabel(kind, ind.params),
    yDomain: [0, 100],
    yPx,
  };
}

/** 段の読み取り（range は indPaneModel の結果。カーソルの足が描画域の外なら縦線なし、値はその足のまま） */
export function indReadout(
  ind: Indicators,
  kind: IndKind,
  n: number,
  viewport: Domain,
  range: Domain,
  cursor: number | null,
): IndReadout {
  const ci =
    n === 0 ? -1 : cursor === null ? n - 1 : Math.min(Math.max(Math.round(cursor), 0), n - 1);
  // 縦線は十字線の足が表示範囲の内のときだけ（価格の ivCrosshair と同じ判定 = ivCursorBar。#227）
  const shown = ivCursorBar(cursor, n, viewport);
  const cursorX = shown === null ? null : r1(linear(viewport, range)(shown));
  if (kind === 'macd') {
    const { macd, signal, hist } = ind.macd;
    return {
      cursorX,
      values: [
        { k: '', v: fmt0(at(macd, ci)), cls: 'main' },
        { k: 'S', v: fmt0(at(signal, ci)), cls: 'sub' },
        { k: 'H', v: fmt0(at(hist, ci)), cls: 'hist' },
      ],
    };
  }
  if (kind === 'rsi')
    return { cursorX, values: [{ k: '', v: fmt1(at(ind.rsi, ci)), cls: 'main' }] };
  return {
    cursorX,
    values: [
      { k: '%K', v: fmt1(at(ind.stoch.k, ci)), cls: 'main' },
      { k: '%D', v: fmt1(at(ind.stoch.d, ci)), cls: 'sub' },
    ],
  };
}

/** 段の切替の状態を 1 つ反転する（並びは IND_KINDS の順） */
export function toggleInd(shown: readonly IndKind[], kind: IndKind): IndKind[] {
  const has = shown.includes(kind);
  return IND_KINDS.map((k) => k.value).filter((k) => (k === kind ? !has : shown.includes(k)));
}

/** 段の svg の名前（期間は計算に使った値） */
export function indImgLabel(kind: IndKind, p: TechParams): string {
  const head = `${IND_NAME[kind]}（${indParamText(kind, p)}）の推移`;
  if (kind === 'rsi') return `${head}（縦軸 0〜100、補助線 ${RSI_LOW}・${RSI_HIGH}）`;
  if (kind === 'macd') return `${head}（線 = MACD とシグナル、棒 = ヒストグラム。円）`;
  return `${head}（線 = %K と %D、補助線 ${STOCH_LOW}・${STOCH_HIGH}）`;
}

// ---- 段の十字線・高さ・最大化（#207。docs/ui-redesign.md §4.8）

/** 段の上の十字線（触っている段・段の座標の高さ・タッチか） */
export interface IndPaneCursor {
  pane: IndKind;
  y: number;
  touch: boolean;
}

/** 段の十字線の横線と縦軸の札（横線 = 指 / カーソルの高さ。足の値に寄せない） */
export interface IndCross {
  /** 横線の y（段の座標。描画域の上下の端で止める） */
  y: number;
  /** 横線の高さの値（RSI・SO は 0〜100、MACD は円） */
  value: number;
  /** 札の文字（RSI・SO 小数 1 桁、MACD 円の整数） */
  text: string;
  /** 縦軸の札（目盛りの列。右端 = 描画域の左 − 1） */
  tag: { x: number; y: number; w: number; h: number };
}

/** 段の十字線（y = 段の座標の指 / カーソルの高さ。null なら横線なし） */
export function indCrosshair(m: IndPaneModel, y: number | null): IndCross | null {
  if (y === null || !Number.isFinite(y)) return null;
  const top = Math.min(m.yPx[0], m.yPx[1]);
  const bottom = Math.max(m.yPx[0], m.yPx[1]);
  const yc = r1(Math.min(Math.max(y, top), bottom));
  const value = linear(m.yPx, m.yDomain)(yc);
  const text = m.kind === 'macd' ? fmt0(value) : fmt1(value);
  const w = r1(labelPx(text) + IV_TAG_PAD_Y);
  return {
    y: yc,
    value,
    text,
    tag: {
      x: r1(Math.max(0, m.range[0] - 1 - w)),
      y: r1(Math.min(Math.max(yc - IV_TAG_H / 2, 0), Math.max(m.height - IV_TAG_H, 0))),
      w,
      h: IV_TAG_H,
    },
  };
}

/** 段がある間の価格の描画域の高さの下限（px。CSS の .fut-stack:has(.ind-panes) .iv-wrap と同じ） */
export const FUT_PRICE_MIN_H = 56;
/** 覚える段の高さの上限（px。保存の値の検査） */
export const IND_PANE_MAX_H = 2000;

/** 覚えた段の高さ（段ごと px。無い段は既定 IND_PANE_H。端末の設定 = ui/prefs.ts の fut_pane_h_*） */
export type IndPaneHeights = Partial<Record<IndKind, number>>;

/** 保存してよい段の高さか（整数・[IND_PANE_MIN_H, IND_PANE_MAX_H]） */
export function isIndPaneH(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= IND_PANE_MIN_H && v <= IND_PANE_MAX_H;
}

export interface FutPaneSlot {
  kind: IndKind;
  /** 段の高さ（px） */
  h: number;
  /** 段の上端（段の枠 .ind-panes の座標） */
  top: number;
}

export interface FutPaneLayout {
  /** 価格の描画域の高さ（px。最大化中は 0 = 描かない） */
  priceH: number;
  /** 描く段（最大化中はその段だけ） */
  panes: FutPaneSlot[];
  /** 最大化している段（無ければ null） */
  max: IndKind | null;
  /** 高さが足りないので隠した段（出している段の後ろから。最大化中は空） */
  hidden: IndKind[];
}

/**
 * 価格と段の配置（#207）。stackH = 価格と段を包む枠（.fut-stack）の高さ。段は覚えた高さ（無ければ IND_PANE_H）で、
 * 段の和が「枠 − 価格の下限 FUT_PRICE_MIN_H」を超えたら比で縮める（段の下限 IND_PANE_MIN_H。#200 の縮み方と同じ）。
 * **価格が先**: 価格の下限と段の下限が枠に入らないときは、入る数だけ出し、後ろの段を隠す（hidden。0 段もありうる）=
 * 価格と段の和は枠の高さを超えない（下端がはみ出さない）。価格は残り。max が出している段なら、その段が枠の全部
 * （価格・ほかの段は描かない）
 */
export function futPaneLayout(p: {
  stackH: number;
  kinds: readonly IndKind[];
  heights?: IndPaneHeights | null | undefined;
  max: IndKind | null;
}): FutPaneLayout {
  const stackH = Number.isFinite(p.stackH) ? Math.max(Math.floor(p.stackH), 0) : 0;
  if (p.max !== null && p.kinds.includes(p.max)) {
    return { priceH: 0, panes: [{ kind: p.max, h: stackH, top: 0 }], max: p.max, hidden: [] };
  }
  const avail = stackH - FUT_PRICE_MIN_H;
  const fit = Math.min(p.kinds.length, Math.max(Math.floor(avail / IND_PANE_MIN_H), 0));
  const kinds = p.kinds.slice(0, fit);
  const want = kinds.map((k) => {
    const v = p.heights?.[k];
    return isIndPaneH(v) ? v : IND_PANE_H;
  });
  const sum = want.reduce((a, b) => a + b, 0);
  // 縮めるときは下限を守ったうえで、残り（spare）を下限を超える分の比で分ける。端数は最大剰余で配る = 段の和は
  // ちょうど avail（縮めた後の和が枠 − 価格の下限に一致 = 保存の値の逆算 futPaneSave が成り立つ）
  const hs = want.slice();
  if (sum > avail) {
    const spare = Math.max(avail - kinds.length * IND_PANE_MIN_H, 0);
    const extra = want.map((w) => Math.max(w - IND_PANE_MIN_H, 0));
    const over = extra.reduce((a, b) => a + b, 0) || 1;
    const share = extra.map((e) => (e * spare) / over);
    const base = share.map((v) => Math.floor(v));
    let left = spare - base.reduce((a, b) => a + b, 0);
    const order = share
      .map((v, i) => ({ i, r: v - Math.floor(v) }))
      .sort((x, y) => y.r - x.r || x.i - y.i);
    for (const { i } of order) {
      if (left <= 0) break;
      base[i] = (base[i] as number) + 1;
      left--;
    }
    base.forEach((b, i) => {
      hs[i] = IND_PANE_MIN_H + b;
    });
  }
  let top = 0;
  const panes = kinds.map((kind, i) => {
    const h = hs[i] as number;
    const slot = { kind, h, top };
    top += h;
    return slot;
  });
  return {
    priceH: Math.max(stackH - top, 0),
    panes,
    max: null,
    hidden: p.kinds.slice(fit),
  };
}

/**
 * 境目のドラッグ（#207）。border 0 = 価格 | 1 段目（1 段目 = 開始の高さ − dy、価格は残り）、border i = 段 i−1 | 段 i
 * （段 i−1 に dy を足して段 i から引く = 2 段の和を保つ）。下限（価格 FUT_PRICE_MIN_H・段 IND_PANE_MIN_H）で止める。
 * start は押したときに **描いていた** 配置（縮めて描いていればその高さ）。返すのは描いている段すべての高さ（整数 px）で、
 * ドラッグ中の配置はこれをそのまま描く（和は枠 − 価格の下限以下 = futPaneLayout が縮め直さない = 指に 1:1 でつく）。
 * 保存する値は futPaneSave（動かした段だけ）
 */
export function futPaneDrag(
  start: FutPaneLayout,
  border: number,
  dy: number,
  stackH: number,
): IndPaneHeights {
  const hs = start.panes.map((s) => s.h);
  const d = Number.isFinite(dy) ? Math.round(dy) : 0;
  if (border === 0 && hs.length > 0) {
    const others = hs.slice(1).reduce((a, b) => a + b, 0);
    const hi = Math.max(Math.floor(stackH) - FUT_PRICE_MIN_H - others, IND_PANE_MIN_H);
    hs[0] = Math.min(Math.max((hs[0] as number) - d, IND_PANE_MIN_H), hi);
  } else if (border > 0 && border < hs.length) {
    const a = hs[border - 1] as number;
    const b = hs[border] as number;
    const m = Math.min(Math.max(d, IND_PANE_MIN_H - a), b - IND_PANE_MIN_H);
    hs[border - 1] = a + m;
    hs[border] = b - m;
  }
  const out: IndPaneHeights = {};
  start.panes.forEach((s, i) => {
    out[s.kind] = Math.min(hs[i] as number, IND_PANE_MAX_H);
  });
  return out;
}

/**
 * 境目を離したときに保存する高さ（#207）。shown = 離したときに描いていた高さ（futPaneDrag の結果）。**動かした境目の
 * 両側の段だけ**（境目 0 は 1 段目だけ）を書き、その値は「覚えた高さ + この値で futPaneLayout を描き直すと shown と同じ
 * 高さになる」整数（縮めて描いているときは縮める前の高さ = 逆算した値。枠が十分なら shown そのもの）。動かした段だけでは
 * 再現できないとき（縮めて描いている間に境目 0 を動かし、価格の分が変わった = 触っていない段の縮み方も変わる）は、
 * 描いている段すべての shown を書く（描き直しても高さが跳ばない方を取る）
 */
export function futPaneSave(p: {
  stackH: number;
  kinds: readonly IndKind[];
  stored: IndPaneHeights | null | undefined;
  shown: IndPaneHeights;
  border: number;
}): IndPaneHeights {
  const base = futPaneLayout({ stackH: p.stackH, kinds: p.kinds, heights: p.shown, max: null });
  const drawn = base.panes;
  const target = drawn.map((s) => p.shown[s.kind] ?? s.h);
  const moved = (p.border === 0 ? [0] : [p.border - 1, p.border]).filter((i) => i < drawn.length);
  const kindsOf = (is: number[]) => is.map((i) => (drawn[i] as FutPaneSlot).kind);
  const same = (h: IndPaneHeights) => {
    const l = futPaneLayout({
      stackH: p.stackH,
      kinds: p.kinds,
      heights: { ...p.stored, ...h },
      max: null,
    });
    return l.panes.length === drawn.length && l.panes.every((s, i) => s.h === target[i]);
  };
  const all = (): IndPaneHeights => {
    const out: IndPaneHeights = {};
    drawn.forEach((s, i) => {
      out[s.kind] = target[i] as number;
    });
    return out;
  };
  if (moved.length === 0) return all();
  // 推定: 触っていない段の覚えた高さ（無ければ既定）のまま、縮めの比 spare / over を逆にする
  const avail = Math.max(Math.floor(p.stackH) - FUT_PRICE_MIN_H, 0);
  const want = (k: IndKind) => {
    const v = p.stored?.[k];
    return isIndPaneH(v) ? v : IND_PANE_H;
  };
  const fixedA = drawn.reduce(
    (a, s, i) => (moved.includes(i) ? a : a + Math.max(want(s.kind) - IND_PANE_MIN_H, 0)),
    0,
  );
  const spare = avail - drawn.length * IND_PANE_MIN_H;
  const tMoved = moved.reduce((a, i) => a + (target[i] as number) - IND_PANE_MIN_H, 0);
  const est = (i: number) => {
    const t = (target[i] as number) - IND_PANE_MIN_H;
    const rest = spare - tMoved;
    return rest > 0 && fixedA > 0 ? IND_PANE_MIN_H + (t * fixedA) / rest : (target[i] as number);
  };
  const ks = kindsOf(moved);
  const cands = (i: number) => {
    const out = new Set<number>([target[i] as number]);
    const e = Math.round(est(i));
    for (let d = -4; d <= 4; d++) out.add(e + d);
    return [...out].filter((v) => isIndPaneH(v));
  };
  const c0 = cands(moved[0] as number);
  const c1 = moved.length > 1 ? cands(moved[1] as number) : [null];
  for (const a of c0) {
    for (const b of c1) {
      const h: IndPaneHeights = { [ks[0] as IndKind]: a };
      if (b !== null) h[ks[1] as IndKind] = b;
      if (same(h)) return h;
    }
  }
  return all();
}

/** 段の枠の座標 y にある段（無ければ null） */
export function futPaneAt(layout: FutPaneLayout, y: number): FutPaneSlot | null {
  for (const s of layout.panes) if (y >= s.top && y < s.top + s.h) return s;
  return null;
}

/** 境目の名前（aria-label。border 0 = 価格との境目） */
export function indSplitLabel(kinds: readonly IndKind[], border: number): string {
  const name = (k: IndKind | undefined) => (k ? IND_NAME[k] : '');
  const upper = border === 0 ? '価格' : name(kinds[border - 1]);
  return `${upper}と${name(kinds[border])}の段の境目（↑ ↓ で高さ・Enter / ダブルクリックで既定の高さ）`;
}

/** 境目の当たり判定の幅（片側 px。マウス・タッチ。#207 AC1: タッチは ±10px 以上） */
export const SPLIT_HIT_PX = { fine: 5, coarse: 10 } as const;

/**
 * 段の枠の座標 y にある境目（#207。無ければ null）。境目 i は段 i の上端の ±幅（境目 0 = 価格 | 1 段目は上側が価格の
 * 描画域 = y < 0。押下は価格と段を包む枠で取る）。幅はいつも全部（低い 28px の段では帯が段に重なり、帯の中は
 * ドラッグが先、帯の外 = 段の真ん中で十字線・最大化）。近い境目が先。最大化中は無し
 */
export function futSplitAt(layout: FutPaneLayout, y: number, coarse: boolean): number | null {
  if (layout.max !== null || !Number.isFinite(y)) return null;
  const px = coarse ? SPLIT_HIT_PX.coarse : SPLIT_HIT_PX.fine;
  let best: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  layout.panes.forEach((s, i) => {
    const d = Math.abs(y - s.top);
    if (d <= px && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** 高さが足りないので隠した段の知らせ（無ければ null。例「高さが足りないので SO を隠しています」） */
export function indHiddenNote(hidden: readonly IndKind[]): string | null {
  if (hidden.length === 0) return null;
  const names = hidden.map((k) => IND_KINDS.find((x) => x.value === k)?.text ?? k).join('・');
  return `高さが足りないので ${names} を隠しています`;
}

/** スマホ（タッチ）の段の十字線の浮いた読み取り（.ind-float。#207・#227） */
export interface IndFloat {
  /** 段の名前（期間つき） */
  title: string;
  /** 横線の高さの値（縦軸の札と同じ文字） */
  ruler: string;
  /** その足の値（段の見出しと同じ） */
  values: IndReadout['values'];
  /** 枠の下端に置く（指が枠の上 40% にある = crossFloatBottom） */
  bottom: boolean;
}

/**
 * 段の十字線の浮いた読み取り（#227。docs/ui-redesign.md §4.1・§4.8）: タッチで置いた段の十字線の交点を **つかんで動かす間
 * だけ**（held）、触っている段の名前・横線の値・その足の値を指から離れた所（価格と段を包む枠の上端、指が上 40% なら下端）に
 * 出す。離した後（置いたまま）・マウス・段が配置に無い（隠した・ほかの段の最大化）・横線が無い・十字線の足が表示範囲の
 * 外（縦線 cursorX が無い）なら null = 段の中の見出しの値・縦軸の札だけ（PC のホバーと同じ）。
 * models・crosses・readouts は layout.panes と同じ並び
 */
export function indFloat(p: {
  pc: IndPaneCursor | null;
  held: boolean;
  layout: FutPaneLayout;
  models: readonly Pick<IndPaneModel, 'kind' | 'title'>[];
  crosses: readonly (IndCross | null)[];
  readouts: readonly IndReadout[];
  stackH: number;
}): IndFloat | null {
  const { pc } = p;
  if (!pc?.touch || !p.held) return null;
  const i = p.layout.panes.findIndex((s) => s.kind === pc.pane);
  const m = p.models[i];
  const slot = p.layout.panes[i];
  const c = p.crosses[i];
  const ro = p.readouts[i];
  if (i < 0 || !m || !slot || !c || !ro || ro.cursorX === null) return null;
  return {
    title: m.title,
    ruler: c.text,
    values: ro.values,
    bottom: crossFloatBottom(p.layout.priceH + slot.top + pc.y, p.stackH),
  };
}

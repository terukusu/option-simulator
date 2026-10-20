/**
 * 先物推移の指標の段（#200。docs/ui-redesign.md §4.8）の表示モデル（純関数。Preact に依存しない）。指標の値は
 * model/technicals.ts の indicators（AI の道具 technicals と同じ計算）。ここは段の座標・補助線・見出しの文字だけ。
 *
 * - 段は価格の描画域の下に、同じ表示範囲（index の viewport）・同じ横の画素範囲（左の余白 = 系列の目盛りの列、右 =
 *   IV_MARGIN.right）で描く = パン・拡大・カーソルが価格と揃う。段の高さは IND_PANE_H（縦に狭いとき = スマホのシートの
 *   覗く は段の枠の高さを段の数で割った高さ。下限 IND_PANE_MIN_H。indPaneHeight）
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
import { DASH, fmtNum } from './format';
import { IV_MARGIN } from './ivHistory';

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
export const IND_PANE_MIN_H = 28;

/** 段 1 つの高さ: 段の枠の高さ ÷ 段の数を [IND_PANE_MIN_H, IND_PANE_H] に収める */
export function indPaneHeight(boxHeight: number, count: number): number {
  if (!(count > 0) || !Number.isFinite(boxHeight)) return IND_PANE_H;
  return Math.min(IND_PANE_H, Math.max(IND_PANE_MIN_H, Math.floor(boxHeight / count)));
}
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
  const x = cursor === null || n === 0 ? null : r1(linear(viewport, range)(ci));
  const cursorX = x !== null && x >= range[0] && x <= range[1] ? x : null;
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

/**
 * 銘柄の推移（OP の 1 銘柄 = 限月 × 行使価格 × call / put の値段と IV の足。#319。docs/design.md 13.4「銘柄の推移」）の
 * 表示モデル（純関数。Preact・DOM・時刻・乱数に依存しない）。
 *
 * - 描画域は IV 推移・先物推移と同じ（ivChartModel・IvPlot）。値段の段 = 気配の mid のローソク / 線 + bid / ask の帯 +
 *   約定の点 + 建値の線（足の詳細から開いたときだけ）、IV の段 = 気配の IV の線（bid_iv・ask_iv が両方あるときの中値）+
 *   約定 IV の点。2 段は同じ表示範囲・十字線の足を持つ
 * - 気配の無い足（約定だけ）は足の並びに残し（約定の点・読み取りのため）、ローソク・帯・気配の IV の線は描かずに切る
 *   （optPlotBars の skip・optSegments）。逆転した気配はサーバー（api/src/simulator_api/option_bars.py）が気配なしにする
 * - 値段は円（1 枚あたりの値段。乗数を掛けない）、IV は %（pt）。色は持たない（CSS のクラス名だけ）
 */

import type { IvBar, OptBar, OptionBarsKey, OptionBarsTf } from '../../data';
import { type Holidays, lastTradingDay, type OptionType, type Side } from '../../model';
import { DASH, fmtNum, fmtSigned } from './format';
import {
  fmtIvPt,
  type IvBand,
  type IvMarks,
  type IvSeries,
  ivCursorBar,
  ivTimeText,
  lineSegments,
} from './ivHistory';

/** 開いている銘柄（ShellState.opt。保存しない） */
export interface OptTarget extends OptionBarsKey {
  /** 限月（YYYY-MM。見出しの文字） */
  month: string;
  /** 足の詳細から開いたときの建値（円 / 1 枚）と売り買い。板の K から開いたときは無い（建値の線を出さない） */
  entry?: { price: number; side: Side };
}

/** 足の切替（1 時間足・日足。サーバーが返す足そのもの） */
export const OPT_TFS: readonly { value: OptionBarsTf; text: string; label: string }[] = [
  { value: '1h', text: '1時間', label: '1 時間足' },
  { value: '1d', text: '日足', label: '日足' },
];
export const OPT_DEFAULT_TF: OptionBarsTf = '1h';

/** 種別の短い字（見出し） */
const TYPE_MARK: Record<OptionType, string> = { call: 'C', put: 'P' };
const TYPE_TEXT: Record<OptionType, string> = { call: 'call', put: 'put' };

/** 値段（円。整数なら整数、端数があれば小数 1 桁） */
export const fmtOptPrice = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v)
    ? DASH
    : fmtNum(v, Number.isInteger(v) ? 0 : 1);

/** 値段の段の系列（縦の目盛りの列は IV の段とそろえる = 横の画素範囲を同じにする） */
export const OPT_PRICE_SERIES: IvSeries = { fmt: fmtOptPrice, marginLeft: 48 };
/** IV の段の系列 */
export const OPT_IV_SERIES: IvSeries = { fmt: fmtIvPt, marginLeft: 48 };

/** 要求・読み込みのキー（銘柄と足） */
export function optKey(t: OptionBarsKey, tf: OptionBarsTf): string {
  return `${t.ltd}|${t.k}|${t.type}|${tf}`;
}

/** 見出しの副題（例「12月限 30,000 P」。360px の見出しに収まる短さ。年を含む全文は optName） */
export function optTitle(t: OptTarget): string {
  const m = Number(t.month.slice(5, 7));
  return `${Number.isFinite(m) && m > 0 ? `${m}月限` : `${t.month} 限`} ${fmtNum(t.k)} ${TYPE_MARK[t.type]}`;
}

/** 読み上げの名前（例「2026-12 限 30,000 put」） */
export function optName(t: OptTarget): string {
  return `${t.month} 限 ${fmtNum(t.k)} ${TYPE_TEXT[t.type]}`;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * 限月（YYYY-MM）の取引最終日: 板にその限月があれば板の値、無ければ取引カレンダーの休業日から（model の
 * lastTradingDay = SQ の前営業日）。限月の形が違えば null
 */
export function optLtdOf(
  month: string,
  chainMonths: readonly { id: string; lastTradingDay: string }[],
  holidays: Holidays,
): string | null {
  const m = chainMonths.find((x) => x.id === month);
  if (m) return m.lastTradingDay;
  const r = MONTH_RE.exec(month);
  if (!r) return null;
  const mo = Number(r[2]);
  if (mo < 1 || mo > 12) return null;
  return lastTradingDay(Number(r[1]), mo, holidays);
}

/**
 * 足の行（ポジション）→ 推移で開く銘柄（ラージの OP の足だけ。先物・行使価格の無い足・取引最終日が求められない足は
 * null）。建値の線のため建値と売り買いを持つ
 */
export function optTargetOfLeg(
  leg: {
    kind: 'option' | 'future';
    product: string;
    month: string;
    optionType: 'P' | 'C' | null;
    strike: number | null;
    side: Side;
    entry: number;
  },
  ltdOf: (month: string) => string | null,
): OptTarget | null {
  if (leg.kind !== 'option' || leg.product !== 'op_large') return null;
  if (leg.optionType === null || leg.strike === null || !(leg.strike > 0)) return null;
  const ltd = ltdOf(leg.month);
  if (ltd === null) return null;
  const type: OptionType = leg.optionType === 'P' ? 'put' : 'call';
  const t: OptTarget = { month: leg.month, ltd, k: leg.strike, type };
  return Number.isFinite(leg.entry) && leg.entry > 0
    ? { ...t, entry: { price: leg.entry, side: leg.side } }
    : t;
}

/** 推移を開くボタンの名前（板の K のポップオーバー・足の詳細） */
export function optOpenLabel(month: string, k: number, type: OptionType): string {
  return `${month} 限 ${fmtNum(k)} ${TYPE_TEXT[type]} の値段と IV の推移を開く`;
}

/** 描画域の足の並び（値段の段・IV の段）と、描かない足（skip） */
export interface OptPlotBars {
  /** 値段の段（気配ありは mid、気配なしは約定の値段を 4 つに入れて skip） */
  price: IvBar[];
  skip: boolean[];
  /** IV の段（気配の IV の中値。無ければ約定 IV（無ければ NaN）を入れて ivSkip） */
  iv: IvBar[];
  ivSkip: boolean[];
}

const one = (t: number, v: number): IvBar => ({ t, o: v, h: v, l: v, c: v });

/**
 * 気配があるか（mid の 4 つと bid ≤ ask がそろう足）。逆転した気配はサーバーが気配なしにして返すが、ここでも気配なしと
 * して扱う（7.1）
 */
export function optQuoted(b: OptBar): boolean {
  return (
    b.o !== null &&
    b.h !== null &&
    b.l !== null &&
    b.c !== null &&
    b.bid !== null &&
    b.ask !== null &&
    b.bid <= b.ask
  );
}

/** 気配の IV の中値（bid_iv・ask_iv が両方あるときだけ。無ければ null） */
export function optQuoteIv(b: OptBar): number | null {
  return optQuoted(b) && b.bidIv !== null && b.askIv !== null ? (b.bidIv + b.askIv) / 2 : null;
}

export function optPlotBars(bars: readonly OptBar[]): OptPlotBars {
  const price: IvBar[] = [];
  const skip: boolean[] = [];
  const iv: IvBar[] = [];
  const ivSkip: boolean[] = [];
  for (const b of bars) {
    if (optQuoted(b)) {
      price.push({
        t: b.t,
        o: b.o as number,
        h: b.h as number,
        l: b.l as number,
        c: b.c as number,
      });
      skip.push(false);
    } else {
      price.push(one(b.t, b.trade ?? Number.NaN));
      skip.push(true);
    }
    const q = optQuoteIv(b);
    iv.push(one(b.t, q ?? b.tradeIv ?? Number.NaN));
    ivSkip.push(q === null);
  }
  return { price, skip, iv, ivSkip };
}

/**
 * 線の区間（lineSegments の時間の欠けに加えて skip の足で切る。skip の足はどの区間にも入らない）
 */
export function optSegments(
  bars: readonly IvBar[],
  skip: readonly boolean[],
  tf: OptionBarsTf,
  nonTradingDays: ReadonlySet<string>,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of lineSegments(bars, tf, nonTradingDays)) {
    let from = -1;
    for (let i = a; i <= b; i++) {
      if (skip[i]) {
        if (from >= 0) out.push([from, i - 1]);
        from = -1;
      } else if (from < 0) from = i;
    }
    if (from >= 0) out.push([from, b]);
  }
  return out;
}

/** bid / ask の帯（気配の無い足は null = 帯が切れる） */
export function optBand(bars: readonly OptBar[]): IvBand {
  return {
    cls: 'opt-band',
    lo: bars.map((b) => (optQuoted(b) ? b.bid : null)),
    hi: bars.map((b) => (optQuoted(b) ? b.ask : null)),
  };
}

/** 約定の点（値段の段） */
export function optTradeMarks(bars: readonly OptBar[]): IvMarks {
  return { cls: 'opt-trade', values: bars.map((b) => b.trade) };
}

/** 約定 IV の点（IV の段） */
export function optTradeIvMarks(bars: readonly OptBar[]): IvMarks {
  return { cls: 'opt-trade', values: bars.map((b) => b.tradeIv) };
}

/** 建値の線（足の詳細から開いたときだけ。値は足の建値） */
export function optEntryLevel(t: OptTarget | null): { cls: string; value: number } | null {
  const e = t?.entry;
  return e && Number.isFinite(e.price) && e.price > 0 ? { cls: 'opt-entry', value: e.price } : null;
}

/** 読み取り（カーソルの足、無ければ最新の足） */
export interface OptReadout {
  time: string;
  /** 気配の mid の始 / 高 / 安 / 終（気配なしの足は null = 「気配なし」） */
  quote: { o: string; h: string; l: string; c: string } | null;
  /** 売り気配 / 買い気配（「bid / ask」。気配なしは —） */
  bidAsk: string;
  /** 気配の IV（中値。無ければ —） */
  iv: string;
  /** 約定の値段と約定 IV（約定の無い足は null） */
  trade: { price: string; iv: string } | null;
  /** 建値との差（円 / 1 枚の値段の差。売りは符号を反す。建値が無ければ null） */
  vsEntry: string | null;
}

const EMPTY_READOUT: OptReadout = {
  time: DASH,
  quote: null,
  bidAsk: DASH,
  iv: DASH,
  trade: null,
  vsEntry: null,
};

/** 読み取りの足の index（カーソルの足が表示範囲の内ならそれ、無ければ最新の足。足が無ければ null） */
export function optReadoutIndex(
  n: number,
  cursor: number | null,
  viewport: readonly [number, number],
): number | null {
  if (n === 0) return null;
  return ivCursorBar(cursor, n, viewport as [number, number]) ?? n - 1;
}

export function optReadout(
  bars: readonly OptBar[],
  tf: OptionBarsTf,
  index: number | null,
  target: OptTarget | null,
): OptReadout {
  const b = index === null ? undefined : bars[index];
  if (!b) return EMPTY_READOUT;
  const quoted = optQuoted(b);
  const now = quoted ? b.c : b.trade;
  const e = target?.entry;
  const diff =
    e && now !== null && Number.isFinite(e.price)
      ? (now - e.price) * (e.side === 'sell' ? -1 : 1)
      : null;
  return {
    time: ivTimeText(b.t, tf),
    quote: quoted
      ? { o: fmtOptPrice(b.o), h: fmtOptPrice(b.h), l: fmtOptPrice(b.l), c: fmtOptPrice(b.c) }
      : null,
    bidAsk: quoted ? `${fmtOptPrice(b.bid)} / ${fmtOptPrice(b.ask)}` : DASH,
    iv: fmtIvPt(optQuoteIv(b)),
    trade: b.trade !== null ? { price: fmtOptPrice(b.trade), iv: fmtIvPt(b.tradeIv) } : null,
    vsEntry: diff === null ? null : fmtSigned(diff, Number.isInteger(diff) ? 0 : 1),
  };
}

/** 見出しの補足（表の最後の行の時刻。無ければ null） */
export function optLastAtText(lastAt: number | null): string | null {
  if (lastAt === null || !Number.isFinite(lastAt)) return null;
  return `${ivTimeText(lastAt, '1h')} まで`;
}

/** ⓘ の操作の説明 */
export const OPT_HINT =
  'ドラッグ / 1 本指でパン · ホイール / ピンチで拡大 · ダブルタップ / R で初期表示 · ホバー / タップの十字線で足を読む（交点をドラッグで動かす・ほかの所のタップで消す） · , . で 1 本ずつ · × / Esc / 戻るで閉じる';
/** ⓘ のデータの説明 */
export const OPT_NOTE =
  '上の段 = 気配の中値（bid と ask の平均）のローソク / 線と bid〜ask の帯・● 約定の値段・┄ 建値（ポジションの足から開いたとき）。下の段 = 気配の IV（bid IV と ask IV の平均。%）の線と ● 約定 IV。値段は 1 枚あたりの円（乗数を掛けない）。気配の無い足（約定だけ）は線・帯を切り、読み取りに「気配なし」と出す。表は 1 時間ごとに作られるので、右端は 1〜2 時間遅れ（見出しの「… まで」）。読むのは開いたとき・足を替えたとき・⟳ だけ';
/** 描画域の名前（role="application"） */
export const OPT_PLOT_LABEL = '銘柄の値段のグラフ（矢印でパン・+ − で拡大・, . で足を読む）';
export const OPT_IV_PLOT_LABEL = '銘柄の IV のグラフ（矢印でパン・+ − で拡大・, . で足を読む）';
export const OPT_IMG_LABEL = '銘柄の値段の推移（縦軸 円）';
export const OPT_IV_IMG_LABEL = '銘柄の IV の推移（縦軸 IV %）';
/** スクロールする枠の名前 */
export const OPT_FOCUS_LABEL = '銘柄の推移の図';
/** 足 0 本の文言 */
export const OPT_EMPTY_TEXT = 'この銘柄の足はまだありません';

/**
 * 板の JSON（検証済み）を model/ が使う形に正規化する。設計 docs/design.md 5.1・5.3・5.9・7.1。
 *
 * 限月ごとに:
 * - 時間 T（SQ 日 9:00 まで。評価時刻の既定はスナップショット時刻）
 * - F の推定（PCP 合成先物。5 組未満なら先物にフォールバック）
 * - OTM 側のスマイル（節点・補間・外挿の印、IV 不安定の印）と裁定の検査
 * - ATM（基準 A = 直近四半期のラージ先物、B = 限月の合成先物。両方の値を付ける）
 *
 * 計算は model/ の純関数で行い、ここは形の変換と組み立てだけ。
 */

import {
  type ArbitrageViolation,
  type AtmBasis,
  type AtmPick,
  type AtmReference,
  atmReference,
  buildSmile,
  checkArbitrage,
  estimateForward,
  type ForwardEstimate,
  type ForwardOptions,
  findAtm,
  hasTwoSided,
  impliedVol,
  midOf,
  type OptionType,
  type Quote,
  type SmileBuildOptions,
  type SmileFit,
  type SmileMark,
  type SmileNode,
  type StrikeRow,
  smileAtStrikes,
  sqInstant,
  yearFraction,
} from '../model';
import type { ChainJson, ChainMonthJson, ChainReason, ChainSide } from './chainTypes';

/** 金利の既定（連続複利。設計 5.6） */
export const DEFAULT_RATE = 0.005;

export interface NormalizeOptions {
  /** 金利（既定 0.5%） */
  r?: number;
  /** 評価時刻（epoch ミリ秒。既定はスナップショット時刻） */
  evalTime?: number;
  smile?: SmileBuildOptions;
  forward?: ForwardOptions;
}

export type QuoteState = 'two_sided' | 'bid_only' | 'ask_only' | 'none';

export interface SideInfo {
  quote: QuoteState;
  mid: number | null;
  /**
   * 気配の IV（%。表示用）。板が気配の IV を持つ（`Chain.quoteIvProvided`）なら JSON の `bid_iv` / `ask_iv` のまま、
   * 持たない供給元の板なら気配の価格から Black-76（限月の F・T・r）で求めた値（求まらなければ null）。#154
   */
  bidIv: number | null;
  askIv: number | null;
  /**
   * 気配はあるのに JPX の bid_iv / ask_iv が両方とも無い（表示用の印。model/ は価格から IV を求める）。
   * 板が気配の IV を持たない供給元のとき（`Chain.quoteIvProvided` = false）は付けない
   */
  jpxIvMissing: boolean;
}

/** 行使価格ごとの正規化結果（スマイル・印）。 */
export interface StrikeInfo {
  k: number;
  /** OTM 側（K < F は put、それ以外は call） */
  otmType: OptionType;
  /** x = ln(K / F) */
  x: number;
  /** スマイルの IV（小数）。スマイルが作れない限月は null */
  smileIv: number | null;
  /** 節点 / 補間 / 外挿（スマイルが無ければ null） */
  mark: SmileMark | null;
  /** OTM 側の行が IV 不安定（分解能の帯 > 5pt または ask ≤ 5 円） */
  unstable: boolean;
  /** OTM 側の節点（気配・約定から IV が作れなかった行は null） */
  node: SmileNode | null;
  /** 裁定の検査で印が付いた */
  arbitrage: boolean;
  call: SideInfo;
  put: SideInfo;
}

export interface MonthAtm {
  reference: AtmReference;
  pick: AtmPick | null;
}

export interface ChainMonth {
  /** 限月（YYYY-MM）。MarketContext.options のキー */
  id: string;
  lastTradingDay: string;
  sqDate: string;
  /** SQ 日 09:00 JST（epoch ミリ秒） */
  sqTime: number;
  /** 評価時刻から SQ までの年数 */
  T: number;
  /** 先物の限月と同じ限月か（違えば F のフォールバックは「先物（限月違い）」） */
  sameMonthAsFuture: boolean;
  /** model/ の形の板（約定価格は Quote.last） */
  rows: StrikeRow[];
  /** 元の JSON の行（表示用） */
  source: ChainMonthJson['rows'];
  forward: ForwardEstimate;
  /** 合成先物が決まった（false なら F は先物価格へのフォールバック、または NaN） */
  syntheticOk: boolean;
  /** 評価に使う F_i（合成先物、フォールバック時は先物価格。どちらも無ければ NaN） */
  F: number;
  smile: SmileFit | null;
  strikes: StrikeInfo[];
  violations: ArbitrageViolation[];
  /** ATM（5.9）。基準 A / B の両方 */
  atm: { A: MonthAtm; B: MonthAtm };
}

export interface Chain {
  snapshotAt: number;
  /** 元の文字列（表示用） */
  snapshotAtText: string;
  delayedMinutes: number;
  reason: ChainReason;
  source: string | null;
  /**
   * 板が気配の IV（`bid_iv` / `ask_iv`）を持つか（どこか 1 つでも非 null）。持たない供給元の板（docs/data-sources.md）では
   * 「JPX の IV 欠損」の印を出さず、板の IV 列は気配の価格から求める（#154）
   */
  quoteIvProvided: boolean;
  r: number;
  evalTime: number;
  spot: { price: number | null; priceTime: number | null };
  future: {
    price: number | null;
    priceTime: number | null;
    /** YYYY-MM。MarketContext.futures のキー */
    id: string;
    lastTradingDay: string;
    sqDate: string;
    sqTime: number;
  };
  months: ChainMonth[];
  json: ChainJson;
}

function toQuote(s: ChainSide): Quote {
  return { bid: s.bid, ask: s.ask, last: s.price };
}

function quoteState(q: Quote): QuoteState {
  if (hasTwoSided(q)) return 'two_sided';
  const b = q.bid !== null && q.bid > 0;
  const a = q.ask !== null && q.ask > 0;
  if (b && a) return 'none'; // bid > ask（逆転）は使えない気配として扱う
  if (b) return 'bid_only';
  if (a) return 'ask_only';
  return 'none';
}

/** 気配の IV を気配の価格から求める文脈（板が気配の IV を持たないときだけ。持つなら null） */
interface IvFallback {
  F: number;
  T: number;
  r: number;
}

/** 価格 → IV（%）。価格が無い・0 以下・解けなければ null */
function ivPctOf(type: OptionType, price: number | null, k: number, fb: IvFallback): number | null {
  if (price === null || !(price > 0)) return null;
  const res = impliedVol(type, price, fb.F, k, fb.T, fb.r);
  return res.ok ? res.sigma * 100 : null;
}

function sideInfo(
  s: ChainSide,
  type: OptionType,
  k: number,
  fallback: IvFallback | null,
): SideInfo {
  const q = toQuote(s);
  const quote = quoteState(q);
  return {
    quote,
    mid: midOf(q),
    bidIv: fallback ? ivPctOf(type, s.bid, k, fallback) : s.bid_iv,
    askIv: fallback ? ivPctOf(type, s.ask, k, fallback) : s.ask_iv,
    jpxIvMissing: !fallback && quote !== 'none' && s.bid_iv === null && s.ask_iv === null,
  };
}

/** 板のどこかに気配の IV（bid_iv / ask_iv）が 1 つでもあるか */
function hasQuoteIv(json: ChainJson): boolean {
  return json.months.some((m) =>
    m.rows.some(
      (row) =>
        row.call.bid_iv !== null ||
        row.call.ask_iv !== null ||
        row.put.bid_iv !== null ||
        row.put.ask_iv !== null,
    ),
  );
}

function parseInstant(s: string | null): number | null {
  return s === null ? null : Date.parse(s);
}

/** 窓の中心: 先物価格。無ければ |C_mid − P_mid| が最小の行使価格。どちらも無ければ null。 */
function forwardCenter(rows: readonly StrikeRow[], future: number | null): number | null {
  if (future !== null) return future;
  let best: number | null = null;
  let gap = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const c = midOf(row.call);
    const p = midOf(row.put);
    if (c === null || p === null) continue;
    if (Math.abs(c - p) < gap) {
      gap = Math.abs(c - p);
      best = row.k;
    }
  }
  return best;
}

function normalizeMonth(
  m: ChainMonthJson,
  futurePrice: number | null,
  futureId: string,
  evalTime: number,
  r: number,
  opts: NormalizeOptions,
  quoteIvProvided: boolean,
): ChainMonth {
  const sqTime = sqInstant(m.sq_date);
  const T = yearFraction(evalTime, sqTime);
  const rows: StrikeRow[] = m.rows.map((row) => ({
    k: row.k,
    call: toQuote(row.call),
    put: toQuote(row.put),
  }));
  const center = forwardCenter(rows, futurePrice);
  const forward: ForwardEstimate =
    center === null || !(T > 0)
      ? {
          forward: futurePrice ?? Number.NaN,
          uncertainty: Number.NaN,
          method: 'future_fallback',
          used: [],
          outliers: [],
        }
      : estimateForward(rows, T, r, center, futurePrice, opts.forward);
  const syntheticOk = forward.method !== 'future_fallback' && Number.isFinite(forward.forward);
  const F = forward.forward;

  const smile = Number.isFinite(F) && T > 0 ? buildSmile(rows, F, T, r, opts.smile) : null;
  const ks = rows.map((row) => row.k);
  const violations = smile ? checkArbitrage(smile.smile, ks, F, T, r, rows) : [];
  const flagged = new Set(violations.map((v) => v.k));
  const nodeByK = new Map((smile?.nodes ?? []).map((n) => [n.k, n]));
  const ivs = smile ? smileAtStrikes(smile, ks, F) : null;
  // 気配の IV を持たない板: 気配の価格から求める（F が NaN・T が尽きていれば impliedVol が解かない = null）
  const fallback: IvFallback | null = quoteIvProvided ? null : { F, T, r };

  const strikes: StrikeInfo[] = m.rows.map((row, i) => {
    const s = ivs?.[i];
    const node = nodeByK.get(row.k) ?? null;
    return {
      k: row.k,
      otmType: Number.isFinite(F) && row.k < F ? 'put' : 'call',
      x: Number.isFinite(F) ? Math.log(row.k / F) : Number.NaN,
      smileIv: s ? s.iv : null,
      mark: s ? s.mark : null,
      unstable: node?.unstable ?? false,
      node,
      arbitrage: flagged.has(row.k),
      call: sideInfo(row.call, 'call', row.k, fallback),
      put: sideInfo(row.put, 'put', row.k, fallback),
    };
  });

  const atmFor = (basis: AtmBasis): MonthAtm => {
    const reference = atmReference(basis, {
      future: futurePrice,
      synthetic: syntheticOk ? F : null,
    });
    return {
      reference,
      pick: reference.price === null ? null : findAtm(rows, reference.price),
    };
  };

  return {
    id: m.contract_month,
    lastTradingDay: m.last_trading_day,
    sqDate: m.sq_date,
    sqTime,
    T,
    sameMonthAsFuture: m.contract_month === futureId,
    rows,
    source: m.rows,
    forward,
    syntheticOk,
    F,
    smile,
    strikes,
    violations,
    atm: { A: atmFor('A'), B: atmFor('B') },
  };
}

/** 検証済みの板の JSON を正規化する。 */
export function normalizeChain(json: ChainJson, opts: NormalizeOptions = {}): Chain {
  const r = opts.r ?? DEFAULT_RATE;
  const snapshotAt = Date.parse(json.snapshot_at);
  const evalTime = opts.evalTime ?? snapshotAt;
  const fut = json.future;
  const quoteIvProvided = hasQuoteIv(json);
  return {
    snapshotAt,
    snapshotAtText: json.snapshot_at,
    delayedMinutes: json.delayed_minutes,
    reason: json.reason,
    source: json.source ?? null,
    quoteIvProvided,
    r,
    evalTime,
    spot: { price: json.spot.price, priceTime: parseInstant(json.spot.price_time) },
    future: {
      price: fut.price,
      priceTime: parseInstant(fut.price_time),
      id: fut.contract_month,
      lastTradingDay: fut.last_trading_day,
      sqDate: fut.sq_date,
      sqTime: sqInstant(fut.sq_date),
    },
    months: json.months.map((m) =>
      normalizeMonth(m, fut.price, fut.contract_month, evalTime, r, opts, quoteIvProvided),
    ),
    json,
  };
}

/** 限月を ID で引く。 */
export function monthOf(chain: Chain, id: string): ChainMonth | undefined {
  return chain.months.find((m) => m.id === id);
}

/** 横軸の基準 X₀ = 1 限月の基準価格 X₀,1（5.5。基準 A / B に従う。決まらなければ NaN）。 */
export function axisOrigin(chain: Chain, basis: AtmBasis): number {
  const first = chain.months[0];
  if (!first) return chain.future.price ?? Number.NaN;
  return first.atm[basis].reference.price ?? Number.NaN;
}

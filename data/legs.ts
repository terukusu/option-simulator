/**
 * 板・手入力から model/ の足と市場（MarketContext）を作る。設計 docs/design.md 5.3・5.7・5.8・M3。
 *
 * - 板の足: 限月・行使価格・種別・売買を選ぶと建値の既定（買い = ask、売り = bid。D6）と mid を入れる。
 *   片側気配・気配なしの行は建値を手入力にし（既定 = ask − 呼値、無ければスマイルの理論価格）、印を付ける
 * - 手入力の足（板の無い限月。5.7 (a)）: 商品・限月・K・建値・IV を入れた足。SQ 日は暦から求め、
 *   F は先物価格（basis 0）か指定値。「板なし（手入力）」の印
 * - 先物の足: 直近四半期限月は板の先物価格、それ以外の限月は建値を手入力
 *   （初期値はその月のオプションの合成先物、無ければ先物価格）
 *
 * 印は UI が足・グラフ・指標の警告に使う（AC16・AC17）。
 */

import {
  type AtmBasis,
  black76Price,
  buildNode,
  type FutureLeg,
  type FutureMarket,
  type FutureProduct,
  type Holidays,
  type MarketContext,
  monthlyExpiry,
  type OptionExpiryMarket,
  type OptionLeg,
  type OptionType,
  roundOptionPrice,
  type Side,
  shiftOptionTicks,
} from '../model';
import { axisOrigin, type Chain, type ChainMonth, monthOf } from './normalize';

export type LegMark =
  /** 板の無い限月（手入力）。AC17 */
  | 'no_board'
  /** 板の行に両側気配が無い（建値は手入力が要る）。5.3 (ii) */
  | 'no_quote'
  /** 足の側の IV が不安定（分解能の帯 > 5pt または ask ≤ 5 円）。AC16 */
  | 'unstable_iv'
  /** その行使価格のスマイルが外挿（節点の外）。AC16 */
  | 'extrapolated'
  /** その行使価格のスマイルが補間（節点でない） */
  | 'interpolated'
  /** 限月の F が合成先物で決まらず、先物価格で代用（限月違いのことがある） */
  | 'forward_from_future'
  /** 先物の限月が板の先物と違う（建値は手入力） */
  | 'future_manual'
  /** 板に先物価格が無い（夜間の寄り前など）。建値を評価価格に使う */
  | 'no_price';

export interface BuiltLeg<L> {
  leg: L;
  marks: LegMark[];
}

const YM = /^(\d{4})-(\d{2})$/;

function parseYearMonth(id: string): { year: number; month: number } {
  const m = YM.exec(id);
  const month = m ? Number(m[2]) : Number.NaN;
  if (!m || !(month >= 1 && month <= 12)) throw new Error(`限月の形式が不正: ${id}`);
  return { year: Number(m[1]), month };
}

// ---------------------------------------------------------------- 板の足

export interface BoardOptionLegInput {
  expiry: string;
  k: number;
  type: OptionType;
  side: Side;
  qty?: number;
  /** 建値を指定する（省略時は買い = ask、売り = bid。無ければ既定の手入力値） */
  entry?: number;
}

function requireMonth(chain: Chain, id: string): ChainMonth {
  const m = monthOf(chain, id);
  if (!m) throw new Error(`板に無い限月: ${id}`);
  return m;
}

function boardRowOf(chain: Chain, input: BoardOptionLegInput) {
  const month = requireMonth(chain, input.expiry);
  const idx = month.rows.findIndex((r) => r.k === input.k);
  const row = month.rows[idx];
  const info = month.strikes[idx];
  if (!row || !info) throw new Error(`板に無い行使価格: ${input.expiry} ${input.k}`);
  return { month, q: row[input.type], info, sideInfo: info[input.type] };
}

/**
 * 板の行から足だけを作る（印は作らない = IV の逆算をしない。boardOptionLeg の leg と同じ）。
 * 多数の行の建値だけが要るとき（コマンドパレットの足の行。#89）に使う。
 */
export function boardOptionLegOnly(chain: Chain, input: BoardOptionLegInput): OptionLeg {
  const { month, q, sideInfo } = boardRowOf(chain, input);
  let entry: number;
  if (input.entry !== undefined) entry = input.entry;
  else {
    const quoted = input.side === 'buy' ? q.ask : q.bid;
    if (sideInfo.quote === 'two_sided' && quoted !== null) entry = quoted;
    else entry = manualEntryDefault(month, input.k, input.type, q.ask, chain.r);
  }
  return {
    kind: 'option',
    product: 'op_large',
    type: input.type,
    expiry: month.id,
    strike: input.k,
    side: input.side,
    qty: input.qty ?? 1,
    entry,
    mid: sideInfo.mid,
  };
}

/** 板の行から足を作る。 */
export function boardOptionLeg(chain: Chain, input: BoardOptionLegInput): BuiltLeg<OptionLeg> {
  const leg = boardOptionLegOnly(chain, input);
  const { month, q, info, sideInfo } = boardRowOf(chain, input);
  const marks: LegMark[] = [];
  if (sideInfo.quote !== 'two_sided') marks.push('no_quote');

  if (Number.isFinite(month.F) && month.T > 0) {
    // 足の側の行で IV 不安定を判定する（ITM の側も同じ基準）
    // 気配も約定も無く IV が作れない行は「気配なし」だけにする（不安定の印は付けない）
    const node = buildNode(input.k, input.type, q, month.F, month.T, chain.r);
    if (node?.unstable === true) marks.push('unstable_iv');
  }
  if (info.mark === 'extrapolated') marks.push('extrapolated');
  else if (info.mark === 'interpolated') marks.push('interpolated');
  if (!month.syntheticOk) marks.push('forward_from_future');

  return { leg, marks };
}

/**
 * 片側気配・気配なしの行の建値の既定（5.3 (ii)）: ask − 呼値、ask が無ければスマイルの理論価格を呼値で丸めたもの。
 * スマイルも無ければ 0。
 */
export function manualEntryDefault(
  month: ChainMonth,
  k: number,
  type: OptionType,
  ask: number | null,
  r: number,
): number {
  if (ask !== null && ask > 0) return Math.max(shiftOptionTicks(ask, -1), 0);
  if (month.smile && Number.isFinite(month.F) && month.T > 0) {
    const sigma = month.smile.smile.sigma(Math.log(k / month.F));
    return roundOptionPrice(black76Price(type, month.F, k, month.T, sigma, r));
  }
  return 0;
}

// ---------------------------------------------------------------- 手入力の足（板の無い限月）

export interface ManualOptionLegInput {
  /** 商品（オプションは当面ラージだけ。K1） */
  product: 'op_large';
  /** 限月（YYYY-MM） */
  expiry: string;
  type: OptionType;
  k: number;
  side: Side;
  qty?: number;
  /** 建値（円） */
  entry: number;
  /** IV（小数。0.25 = 25%）。アンカー IV として使う */
  iv: number;
  /** その限月の F（省略時は板の先物価格 = basis 0。5.7 (b) と同じ扱い）。板にある限月では指定できない */
  forward?: number;
}

export interface ManualOptionLeg extends BuiltLeg<OptionLeg> {
  /** MarketContext.options に入れる市場（板の限月なら板のもの） */
  market: OptionExpiryMarket;
}

/**
 * 手入力の足。板にある限月なら板の市場を使い（印なし）、板に無い限月は暦から SQ 日を求めて
 * F = forward ?? 先物価格、スマイル無しの市場を作る（「板なし（手入力）」の印）。
 */
export function manualOptionLeg(
  chain: Chain | null,
  input: ManualOptionLegInput,
  holidays: Holidays = [],
): ManualOptionLeg {
  if (!(input.iv > 0) || !Number.isFinite(input.iv)) throw new Error('IV は正の数（小数）');
  if (!(input.k > 0)) throw new Error('行使価格は正の数');
  if (!(input.entry >= 0)) throw new Error('建値は 0 以上');
  const leg: OptionLeg = {
    kind: 'option',
    product: input.product,
    type: input.type,
    expiry: input.expiry,
    strike: input.k,
    side: input.side,
    qty: input.qty ?? 1,
    entry: input.entry,
    iv: input.iv,
    mid: null,
  };
  const onBoard = chain ? monthOf(chain, input.expiry) : undefined;
  if (onBoard) {
    if (input.forward !== undefined) {
      throw new Error(
        `板にある限月（${input.expiry}）の F は板の合成先物を使う（forward は指定できない）`,
      );
    }
    return {
      leg,
      marks: onBoard.syntheticOk ? [] : ['forward_from_future'],
      market: { sqTime: onBoard.sqTime, forward: onBoard.F, smile: onBoard.smile?.smile ?? null },
    };
  }
  const { year, month } = parseYearMonth(input.expiry);
  const e = monthlyExpiry(year, month, holidays);
  const forward = input.forward ?? chain?.future.price ?? Number.NaN;
  const marks: LegMark[] = ['no_board'];
  if (input.forward === undefined) marks.push('forward_from_future');
  return { leg, marks, market: { sqTime: e.sqTime, forward, smile: null } };
}

// ---------------------------------------------------------------- 先物の足

export interface FutureLegInput {
  /** 既定はミニ先物（K6） */
  product?: FutureProduct;
  /** 先物の限月（YYYY-MM。既定は板の先物 = 直近四半期限月） */
  contract?: string;
  side: Side;
  qty?: number;
  /** 建値（省略時は板の先物価格。板に無い限月は初期値 5.7） */
  entry?: number;
}

export interface BuiltFutureLeg extends BuiltLeg<FutureLeg> {
  market: FutureMarket;
}

/** 先物の足（ラージ / ミニ / マイクロ。乗数だけ変わる）。 */
export function futureLeg(
  chain: Chain,
  input: FutureLegInput,
  holidays: Holidays = [],
): BuiltFutureLeg {
  const contract = input.contract ?? chain.future.id;
  const product = input.product ?? 'fut_mini';
  const qty = input.qty ?? 1;
  const marks: LegMark[] = [];
  let sqTime: number;
  let price: number | null;
  if (contract === chain.future.id) {
    sqTime = chain.future.sqTime;
    price = chain.future.price;
  } else {
    // 板に無い先物の限月: 初期値はその月のオプションの合成先物、無ければ先物価格（5.7）。
    // SQ 日は板の限月ならその SQ 日、無ければ暦から
    marks.push('future_manual');
    const opt = monthOf(chain, contract);
    if (opt) sqTime = opt.sqTime;
    else {
      const { year, month } = parseYearMonth(contract);
      sqTime = monthlyExpiry(year, month, holidays).sqTime;
    }
    price = opt?.syntheticOk ? opt.F : chain.future.price;
  }
  if (price === null || !Number.isFinite(price)) {
    // 先物価格が無い: 建値の入力を必須にし、評価価格も建値にする（NaN を出さない）
    if (input.entry === undefined || !Number.isFinite(input.entry)) {
      throw new Error('先物価格が無いので建値の入力が要る');
    }
    marks.push('no_price');
    price = input.entry;
  }
  return {
    leg: { kind: 'future', product, contract, side: input.side, qty, entry: input.entry ?? price },
    marks,
    market: { sqTime, price },
  };
}

// ---------------------------------------------------------------- 市場

export interface MarketContextOptions {
  /** 横軸の基準 X₀ の取り方（既定 B。K7） */
  atmBasis?: AtmBasis;
  /** 手入力の足の市場（板に無い限月を足す。板の限月と重なれば板を優先） */
  extraOptions?: Readonly<Record<string, OptionExpiryMarket>>;
  extraFutures?: Readonly<Record<string, FutureMarket>>;
}

/** 正規化した板から model/ の MarketContext を作る（限月 ID = YYYY-MM）。 */
export function buildMarketContext(chain: Chain, opts: MarketContextOptions = {}): MarketContext {
  const options: Record<string, OptionExpiryMarket> = { ...opts.extraOptions };
  for (const m of chain.months) {
    options[m.id] = { sqTime: m.sqTime, forward: m.F, smile: m.smile?.smile ?? null };
  }
  const futures: Record<string, FutureMarket> = { ...opts.extraFutures };
  // 先物価格が無い板では先物の市場を入れない（足は futureLeg の market を extraFutures で渡す）
  if (chain.future.price !== null) {
    futures[chain.future.id] = { sqTime: chain.future.sqTime, price: chain.future.price };
  }
  return {
    evalTime: chain.evalTime,
    r: chain.r,
    x0: axisOrigin(chain, opts.atmBasis ?? 'B'),
    options,
    futures,
  };
}

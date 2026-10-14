/**
 * JPX 公表のグリーク（板の `delta`〜`vega`）の単位と、5.6 の表示単位への換算・AC7 の照合。
 * 設計 docs/design.md 5.6「JPX グリークの単位」・2.2 AC7。確認日 2026-10-14（#37 の実測）。
 *
 * JPX の値は **ラージ OP 1 枚あたりではなく原資産 1 単位あたり（乗数を含まない）** の Black-76 のグリークで、
 * 約定のあった行だけに、その約定の IV（`iv`）と約定時点の原資産で付く:
 * - delta: ∂V/∂F（call は正、put は負）
 * - gamma: ∂²V/∂F²（原資産 1 円あたり）。**小数 4 桁に丸め**られていて 0 か 0.0001 しか出ない（照合・表示に使わない）
 * - theta: 円 / 暦日（−∂V/∂T ÷ 365。買いが負）
 * - vega: 円 / IV 1pt（∂V/∂σ ÷ 100）
 *
 * 約定から時間が経った行は、値が約定時点のまま（原資産・T が古い）なので、AC7 の照合には約定時刻が
 * スナップショット時刻の `JPX_FRESH_MINUTES` 分以内の行だけを使う。
 */

import {
  type DisplayGreeks,
  evaluatePosition,
  LARGE_MULTIPLIER,
  type MarketContext,
  type OptionType,
  preparePosition,
  type Side,
  ZERO_SCENARIO,
} from '../model';
import type { ChainSide } from './chainTypes';
import { boardOptionLeg } from './legs';
import type { Chain } from './normalize';

/** 単位を実測で確かめた日（#37） */
export const JPX_GREEKS_CHECKED_AT = '2026-10-14';

/** JPX のグリークを「新しい」とみなす、約定時刻からスナップショット時刻までの上限（分） */
export const JPX_FRESH_MINUTES = 5;

/** AC7 の閾値: 合計の差 ≤ max(各足の JPX 値の絶対値の和 × relative, floor) */
export const AC7_TOLERANCE = {
  /** 各足の JPX 値の絶対値の和（gross）に対する比 */
  relative: 0.05,
  /** Δ の下限（ラージ換算の枚数） */
  deltaFloor: 0.01,
  /** V の下限（円 / IV 1pt） */
  vegaFloor: 10,
} as const;

export type JpxGreekValues = Pick<ChainSide, 'delta' | 'gamma' | 'theta' | 'vega'>;

export interface JpxLegSize {
  side: Side;
  /** 枚数（> 0） */
  qty: number;
  /** 乗数（既定はラージ OP の 1,000） */
  multiplier?: number;
}

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);

/**
 * JPX のグリーク（原資産 1 単位あたり）を 5.6 の表示単位（足の枚数・乗数・売買の符号込み）にする。
 * 4 つのどれかが null・非有限なら null。Γ は JPX の丸め（小数 4 桁）のまま換算する（精度は無い）。
 * 基準原資産 X と足の原資産 F の傾きは 1（basis 固定・円モード）とする。
 */
export function jpxDisplayGreeks(g: JpxGreekValues, size: JpxLegSize): DisplayGreeks | null {
  if (!finite(g.delta) || !finite(g.gamma) || !finite(g.theta) || !finite(g.vega)) return null;
  if (!(size.qty > 0) || !Number.isFinite(size.qty)) return null;
  const sign = size.side === 'buy' ? 1 : -1;
  const amount = sign * size.qty * (size.multiplier ?? LARGE_MULTIPLIER);
  const lots = amount / LARGE_MULTIPLIER;
  const deltaLarge = lots * g.delta;
  return {
    deltaLarge,
    deltaMini: deltaLarge * 10,
    gammaPer100: lots * g.gamma * 100,
    thetaPerDay: amount * g.theta,
    vegaPerPt: amount * g.vega,
  };
}

/** JPX のグリークが約定時刻からスナップショット時刻まで `minutes` 分以内か（約定時刻が無ければ false）。 */
export function isFreshJpx(
  side: Pick<ChainSide, 'price_time' | 'delta'>,
  snapshotAt: number,
  minutes: number = JPX_FRESH_MINUTES,
): boolean {
  if (side.delta === null || side.price_time === null) return false;
  const t = Date.parse(side.price_time);
  if (!Number.isFinite(t)) return false;
  const age = snapshotAt - t;
  return age >= 0 && age <= minutes * 60_000;
}

export interface GreekComparison {
  /** アプリの合計（5.6 の単位） */
  app: number;
  /** JPX の値を換算した合計 */
  jpx: number;
  /** 各足の JPX 値の絶対値の和 */
  gross: number;
  /** app − jpx */
  diff: number;
  /** 許容差 = max(gross × relative, floor) */
  limit: number;
  ok: boolean;
}

export interface Ac7Comparison {
  legs: number;
  delta: GreekComparison;
  vega: GreekComparison;
  ok: boolean;
}

export interface Ac7LegPair {
  app: Pick<DisplayGreeks, 'deltaLarge' | 'vegaPerPt'>;
  jpx: Pick<DisplayGreeks, 'deltaLarge' | 'vegaPerPt'>;
}

function compare(app: number, jpx: number, gross: number, floor: number, relative: number) {
  const diff = app - jpx;
  const limit = Math.max(gross * relative, floor);
  return { app, jpx, gross, diff, limit, ok: Number.isFinite(diff) && Math.abs(diff) <= limit };
}

/** AC7: 足ごとのアプリの値と JPX の値（どちらも 5.6 の単位）から、合計 Δ・V を閾値で照合する。足が 0 本なら ok = false。 */
export function compareAc7(
  pairs: readonly Ac7LegPair[],
  tol: { relative: number; deltaFloor: number; vegaFloor: number } = AC7_TOLERANCE,
): Ac7Comparison {
  let aD = 0;
  let jD = 0;
  let gD = 0;
  let aV = 0;
  let jV = 0;
  let gV = 0;
  for (const p of pairs) {
    aD += p.app.deltaLarge;
    jD += p.jpx.deltaLarge;
    gD += Math.abs(p.jpx.deltaLarge);
    aV += p.app.vegaPerPt;
    jV += p.jpx.vegaPerPt;
    gV += Math.abs(p.jpx.vegaPerPt);
  }
  const delta = compare(aD, jD, gD, tol.deltaFloor, tol.relative);
  const vega = compare(aV, jV, gV, tol.vegaFloor, tol.relative);
  return { legs: pairs.length, delta, vega, ok: pairs.length > 0 && delta.ok && vega.ok };
}

export type Ac7Book = 'alternate' | 'all_buy';

export interface Ac7MonthResult {
  month: string;
  book: Ac7Book;
  comparison: Ac7Comparison;
}

/**
 * AC7 の手元照合: 限月ごとに、JPX のグリークが新しい（`isFreshJpx`）行をすべて 1 枚ずつ足にした 2 つの組
 * （売買を K の昇順・call → put の順に交互 / すべて買い）を作り、アプリの指標（建値の既定 = 買い ask・売り bid の
 * アンカー IV、シナリオ 0）と JPX の値の合計を `compareAc7` で照合する。足が `minLegs` 本未満の限月は出さない。
 * 板から足を作れない行（気配が無く建値が決まらない等で例外）は除く。
 */
export function ac7Check(
  chain: Chain,
  ctx: MarketContext,
  opts: { minutes?: number; minLegs?: number } = {},
): Ac7MonthResult[] {
  const minLegs = opts.minLegs ?? 2;
  const out: Ac7MonthResult[] = [];
  for (const m of chain.months) {
    const fresh: Array<{ k: number; type: OptionType; side: ChainSide }> = [];
    for (const row of m.source) {
      for (const type of ['call', 'put'] as const) {
        const s = row[type];
        if (isFreshJpx(s, chain.snapshotAt, opts.minutes)) fresh.push({ k: row.k, type, side: s });
      }
    }
    for (const book of ['alternate', 'all_buy'] as const) {
      const pairs: Ac7LegPair[] = [];
      fresh.forEach((f, i) => {
        const side: Side = book === 'all_buy' || i % 2 === 0 ? 'buy' : 'sell';
        const jpx = jpxDisplayGreeks(f.side, { side, qty: 1 });
        if (jpx === null) return;
        let leg: ReturnType<typeof boardOptionLeg>['leg'];
        try {
          leg = boardOptionLeg(chain, { expiry: m.id, k: f.k, type: f.type, side }).leg;
        } catch {
          return;
        }
        const prepared = preparePosition([leg], ctx);
        const app = evaluatePosition(prepared, ZERO_SCENARIO, ctx).total;
        if (!Number.isFinite(app.deltaLarge) || !Number.isFinite(app.vegaPerPt)) return;
        pairs.push({ app, jpx });
      });
      if (pairs.length >= minLegs) {
        out.push({ month: m.id, book, comparison: compareAc7(pairs) });
      }
    }
  }
  return out;
}

/**
 * JSCC の VaR 証拠金（HS-ES）の計算（純関数。#382・docs/design.md 5.10・ADR-0013）。
 *
 * JSCC が毎営業日に公開する VaR パラメータ（銘柄ごとのシナリオの値 pnl。1 枚あたりの円。先物はシナリオの損益、
 * オプションはシナリオ後の評価額）から、ポートフォリオの VaR 証拠金額を JSCC と同じ手順で求める:
 *
 * - v_j = Σ 銘柄 符号 × 枚数 × pnl_j（pnl は 1 枚あたり = Contract Size を掛けない）
 * - H のシナリオの v の全部と、S のシナリオの v の小さい方から nStress 本を集めて（n 本）昇順に並べ、
 *   小さい方から t = n × q / 10^6 本（q = round((100 − 信頼水準) × 10^4)）の平均（端数の本は按分）の符号を変えたもの
 *   （期待ショートフォール）を円に切り上げる = 符号つきの ES。分子は BigInt の有理数で求める（浮動小数では切り上げで
 *   1 円ずれることがあり、足が多いと 2^53 を超えうる）
 * - VaR 証拠金額 V = max(0, ES, ceil(−NOV_下限))。NOV_清算 = Σ OP 符号 × 枚数 × 清算値段 × Contract Size
 *   （JSCC の仕様: VaR リスク額 = VaR 証拠金額（符号付）+ NOV ≥ 0。1 枚の OP の売りの「清算値段 × Contract Size が
 *   下限」はこの特別な場合）。NOV_下限 = NOV_清算から、取引最終日まで JSCC_NOV_FLOOR_EXEMPT_BUSINESS_DAYS 営業日
 *   以内の OP の足を外したもの（JSCC は SQ 直前の当月限の売りに下限を掛けない。#393）
 *
 * 銘柄のキー（API の i= と同じ）: OP = `NK225E-YYYYMM-C|P-行使価格`、先物 = `NK225F|NK225MF|NK225MCF-YYYYMM`。
 */

import type { Leg } from './position';
import type { FutureProduct } from './products';
import { businessDaysAfter, type Holidays, lastTradingDay } from './time';

/**
 * VaR 証拠金額の下限（ceil(−NOV)）を外す OP の足: 基準日の翌営業日から取引最終日までの営業日数（両端を含む。
 * 取引最終日が翌営業日なら 1。取引最終日が基準日以前なら 0）がこれ以下の限月（#393。暫定）。
 *
 * 根拠: optionchan #171（2025-02-10 以降の全営業日）で、OP の売りの ES が「清算値段 × Contract Size」を下回った
 * 22 件のうち、JSCC が下限を掛けなかった 20 件は当月限で取引最終日まで 1・3 営業日、下限を掛けた 2 件は 1〜2 年先の
 * 限月だった。K が 3 以上・約 250 未満ならどれでも 22 件を説明でき、データからは決まらない。合う中でいちばん小さい
 * 3 にした = 外す足が売りの OP なら下限を残す側（証拠金を大きめに出す側）。外す足が買いの OP なら逆で、外すと
 * NOV_下限が小さく（より負に）なり下限が上がる = K を小さくすると証拠金は小さめに出る（当月限の買い + 遠い限月の売り
 * など）。新しい例が出たら見直す。ポートフォリオで下限を掛けるときの JSCC の挙動（足ごとの判定か）と、祝日取引の日を
 * 営業日に数えるか（取引カレンダーの休業日に入らないので数えている）は分からない（設計 5.10.1・5.10.7・ADR-0013 の追補）
 */
export const JSCC_NOV_FLOOR_EXEMPT_BUSINESS_DAYS = 3;

/** 下限を外す判定に使う日: 基準日（JSCC の営業日。YYYY-MM-DD）と休業日（取引カレンダーの版） */
export interface JsccNovFloorBasis {
  baseDate: string;
  holidays: Holidays;
}

const EXPIRY_ID = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * 限月 expiry（YYYY-MM）の OP の足を、基準日 baseDate の VaR 証拠金額の下限から外すか（取引最終日までの営業日数 ≤ k）。
 * 限月・基準日の形が外れたら false（下限を残す側）
 */
export function jsccNovFloorExempt(
  expiry: string,
  baseDate: string,
  holidays: Holidays,
  k: number = JSCC_NOV_FLOOR_EXEMPT_BUSINESS_DAYS,
): boolean {
  const m = EXPIRY_ID.exec(expiry);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) return false;
  const ltd = lastTradingDay(Number(m[1]), Number(m[2]), holidays);
  return businessDaysAfter(baseDate, ltd, holidays, k) <= k;
}

/** シナリオの並び（pnl の添字の意味）と、集計グループのパラメータ（レコード 0） */
export interface JsccScenarioSet {
  /** 添字ごとに H（ヒストリカル）なら true、S（ストレス）なら false */
  isHist: readonly boolean[];
  /** 信頼水準（%。97.5 など） */
  confidence: number;
  /** S のうち損失の大きい方から使う本数 */
  nStress: number;
}

/** 1 銘柄の行（API の instruments の 1 件） */
export interface JsccInstrument {
  aggregationGroup: string;
  contractSize: number;
  /** 清算値段（OP は NOV_清算に使う。NULL なら null） */
  price: number | null;
  /** シナリオごとの値（1 枚あたりの円。整数）。長さは JsccScenarioSet.isHist と同じ */
  pnl: ArrayLike<number>;
}

/** 基準日の JSCC のデータ（画面が読んだ応答を検証した形） */
export interface JsccData {
  /** JSCC の営業日（YYYY-MM-DD。前営業日の清算値で 1 日固定の、その日） */
  businessDate: string;
  set: JsccScenarioSet;
  /** 銘柄のキー → 行（要求した銘柄のうち行のあったもの） */
  instruments: ReadonlyMap<string, JsccInstrument>;
}

const FUTURE_CODES: Record<FutureProduct, string> = {
  fut_large: 'NK225F',
  fut_mini: 'NK225MF',
  fut_micro: 'NK225MCF',
};

const YM = /^(\d{4})-(\d{2})$/;

function periodCode(id: string): string | null {
  const m = YM.exec(id);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}${m[2]}` : null;
}

/** 足 → 銘柄のキー。限月の形式（YYYY-MM）・行使価格（正の整数 7 桁まで）が外れたら null */
export function jsccKeyOfLeg(leg: Leg): string | null {
  if (leg.kind === 'option') {
    const cp = periodCode(leg.expiry);
    const k = leg.strike;
    if (cp === null || !Number.isInteger(k) || k <= 0 || k > 9_999_999) return null;
    return `NK225E-${cp}-${leg.type === 'call' ? 'C' : 'P'}-${k}`;
  }
  const cp = periodCode(leg.contract);
  return cp === null ? null : `${FUTURE_CODES[leg.product]}-${cp}`;
}

function checkSet(set: JsccScenarioSet, n: number): void {
  if (set.isHist.length !== n) throw new Error('シナリオの本数が並びと違う');
  if (!(set.confidence > 0 && set.confidence < 100)) throw new Error('信頼水準が範囲の外');
  if (!Number.isInteger(set.nStress) || set.nStress < 0) throw new Error('ストレスの本数が不正');
}

/** ceil(num / den)（den > 0） */
function ceilDiv(num: bigint, den: bigint): bigint {
  const q = num / den; // 0 方向に切り捨て
  return num > 0n && q * den !== num ? q + 1n : q;
}

/**
 * 符号つきの ES（円。整数に切り上げ。負 = 裾でも益）。v はシナリオごとのポートフォリオの値（整数）。
 * v が安全な整数でない・長さが並びと違う・H が 0 本・S が nStress 本より少ないと例外。
 */
export function jsccEsSigned(v: ArrayLike<number>, set: JsccScenarioSet): number {
  checkSet(set, v.length);
  let nh = 0;
  let ns = 0;
  for (let j = 0; j < v.length; j++) {
    const x = v[j] as number;
    if (!Number.isSafeInteger(x)) throw new Error('シナリオの値が安全な整数でない');
    if (set.isHist[j]) nh++;
    else ns++;
  }
  if (nh === 0) throw new Error('H のシナリオが無い');
  if (ns < set.nStress) throw new Error('S のシナリオが nStress 本より少ない');
  const hist = new Float64Array(nh);
  const stress = new Float64Array(ns);
  let ih = 0;
  let is = 0;
  for (let j = 0; j < v.length; j++) {
    if (set.isHist[j]) hist[ih++] = v[j] as number;
    else stress[is++] = v[j] as number;
  }
  stress.sort();
  const n = nh + set.nStress;
  const xs = new Float64Array(n);
  xs.set(hist, 0);
  xs.set(stress.subarray(0, set.nStress), nh);
  xs.sort();
  return jsccEsOfSorted(xs, n, set);
}

/**
 * 裾の本数（ES に入る値の数）: k = floor(n·q / 10^6) 本と、端数があれば k + 1 本目（按分）。n = H の本数 + nStress
 */
export function jsccTailCount(n: number, confidence: number): number {
  const q = Math.round((100 - confidence) * 10_000);
  const nq = n * q;
  const k = Math.floor(nq / 1_000_000);
  return nq - k * 1_000_000 > 0 ? k + 1 : k;
}

/**
 * 符号つきの ES（jsccEsSigned の後半）。xs = 集めた n 本（H の全部 + S の小さい方から nStress 本）のうち小さい方から
 * 昇順に、少なくとも jsccTailCount(n) 本（それより後ろは見ない）。n は集めた本数（xs の長さではない）。
 * 当て直しの追証の線が、裾の候補のシナリオだけで評価するのに使う（#387）
 */
export function jsccEsOfSorted(xs: ArrayLike<number>, n: number, set: JsccScenarioSet): number {
  if (!(set.confidence > 0 && set.confidence < 100)) throw new Error('信頼水準が範囲の外');
  if (xs.length < jsccTailCount(n, set.confidence)) throw new Error('裾の本数が足りない');
  const q = Math.round((100 - set.confidence) * 10_000); // 1/10^6 単位の裾の割合
  const nq = n * q; // t × 10^6（2^53 未満）
  const k = Math.floor(nq / 1_000_000);
  let sum = 0n;
  for (let i = 0; i < k; i++) sum += BigInt(xs[i] as number);
  let total = sum * 1_000_000n;
  const frac = nq - k * 1_000_000;
  if (frac > 0) total += BigInt(frac) * BigInt(xs[k] as number);
  // ES = −total / nq（nq > 0: q ≥ 1 は信頼水準 < 100 から）
  return Number(ceilDiv(-total, BigInt(nq)));
}

export interface JsccVarMargin {
  /** 符号つきの ES（円） */
  esSigned: number;
  /** NOV_清算（円。OP の 符号 × 枚数 × 清算値段 × Contract Size の和） */
  novSettle: number;
  /** 下限に使う NOV（円。NOV_清算から floorExempt の OP の足を外した和。#393） */
  novFloor: number;
  /** VaR 証拠金額（円）= max(0, ES, ceil(−NOV_下限)) */
  varMargin: number;
}

/** ポートフォリオの 1 つの足（銘柄の行 × 符号つきの枚数） */
export interface JsccPosition {
  inst: JsccInstrument;
  /** 符号つきの枚数（買い +、売り −。整数） */
  qty: number;
  /** OP なら true（NOV_清算に入る） */
  option: boolean;
  /** OP で、取引最終日が近く VaR 証拠金額の下限から外す足なら true（jsccNovFloorExempt。#393）。省略 = false */
  floorExempt?: boolean;
}

/**
 * ポートフォリオの VaR 証拠金額。足の枚数は整数（でなければ例外）、OP の清算値段が null なら例外
 * （呼び出し側が事前に除く）。足が無ければ 0
 */
export function jsccVarMargin(
  positions: readonly JsccPosition[],
  set: JsccScenarioSet,
): JsccVarMargin {
  const n = set.isHist.length;
  const v = new Float64Array(n);
  let novSettle = 0;
  let novFloor = 0;
  for (const p of positions) {
    if (!Number.isSafeInteger(p.qty)) throw new Error('枚数が整数でない');
    const pnl = p.inst.pnl;
    if (pnl.length !== n) throw new Error('シナリオの本数が並びと違う');
    for (let j = 0; j < n; j++) v[j] = (v[j] as number) + p.qty * (pnl[j] as number);
    if (p.option) {
      const price = p.inst.price;
      if (price === null || !Number.isFinite(price)) throw new Error('清算値段が無い');
      const value = p.qty * price * p.inst.contractSize;
      novSettle += value;
      if (!p.floorExempt) novFloor += value;
    }
  }
  if (positions.length === 0) return { esSigned: 0, novSettle: 0, novFloor: 0, varMargin: 0 };
  const esSigned = jsccEsSigned(v, set);
  // 清算値段 × Contract Size は円の整数（浮動小数の端数を 1e-6 円で吸ってから切り上げる）
  const floor = Math.ceil(-novFloor - 1e-6);
  return { esSigned, novSettle, novFloor, varMargin: Math.max(0, esSigned, floor) };
}

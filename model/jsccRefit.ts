/**
 * JSCC のシナリオの当て直し（純関数。#387・docs/design.md 5.10・ADR-0014）。
 *
 * #382 の「今」は JSCC が公開した基準日の銘柄ごとのシナリオの値（BPF）そのもの。シナリオの点（ΔX・Δσ・d を動かした先）
 * ・テール・追証の線では、その日のシナリオを限月ごとの
 *   r_j = 先物の対数リターン、g_j(z) = 標準化 moneyness z をキーにした IV の対数変化（13 節点の折れ線。節点の外は端の値）
 * に分けたもの（optionchan が毎日当てはめた派生の表。#383 の手順）を、状態 S の各足に当て直す:
 *
 * - F′ = F_S·e^{r_j}、σ′ = max(σ_min, σ_S·exp(g_j(z_S)))、T′ = T_S − h_S（h_S = S から 2 営業日後までの暦日。格子と同じ）
 * - z_S = ln(K / F_S) / (σ_ATM,S·√T_S)。σ_ATM,S = 限月のスマイル（無ければ足の σ の基準）の ATM をシナリオで動かした σ
 * - OP の 1 単位の値 = max(1, round(Black-76))（T′ ≤ tMin は割引本源的価値、T′ ≤ 0 は本源的価値。同じ下限）。
 *   1 枚の値 = 乗数 × 値、先物の 1 枚 = round(乗数 × F_S·(e^{r_j} − 1))（シナリオの損益）。どちらも 1 枚の整数に
 *   符号 × 枚数を掛ける（BPF の pnl は 1 枚あたりの整数 = 今の JSCC の計算と同じ足し方）
 * - v_j の和 → #382 と同じ ES（jsccEsSigned）→ V_S = max(0, ES, ceil(−NOV_S))、必要証拠金 = k·V_S、
 *   所要額 = max(0, k·V_S − NOV_S)。NOV_S・先物の評価損益・清算額・M の足は marginAt と同じ（marginLegs）
 * - g が空の行（先物だけの限月）は IV を動かさない（g = 0）
 *
 * 行の引き方: OP の足 = `NK225E-YYYYMM`、先物の足 = 自分の商品の `NK225F|NK225MF|NK225MCF-YYYYMM` → 同じ限月の NK225E
 * → 同じ限月のほかの先物の順（r は限月で共通 = 相関 ≥ 0.999）。OP の足に NK225E の行が無ければ当て直せない（missing）。
 */

import { black76Price, discountedIntrinsic } from './black76';
import { type JsccScenarioSet, jsccEsOfSorted, jsccEsSigned, jsccTailCount } from './jsccMargin';
import {
  type MarginLegs,
  type MarginParams,
  type MarginResult,
  type MarginState,
  marginLegs,
  marginRoom,
  type RoomEvaluator,
} from './margin';
import {
  legSigma,
  legValue,
  type MarketContext,
  type ModelSettings,
  type PremiumSummary,
  type PreparedLeg,
} from './position';
import type { FutureProduct } from './products';
import { boardSigmaBase, type Scenario, sigmaAt } from './scenario';

/** 節点の数（#383。z ∈ {−5, −4, −3, −2, −1.5, −1, −0.5, 0, 0.5, 1, 1.5, 2, 3}） */
export const JSCC_REFIT_NODE_COUNT = 13;

/** 1 行（商品 × 限月）の r・g */
export interface JsccFactorRow {
  /** シナリオごとの先物の対数リターン（長さ = シナリオの本数） */
  r: Float64Array;
  /** シナリオごとの g の節点の値（長さ = 13 × 本数。g[j·13 + m]）。先物だけの行は null（IV を動かさない） */
  g: Float64Array | null;
}

/** 基準日の r・g（画面が読んだ応答を検証した形） */
export interface JsccFactors {
  businessDate: string;
  set: JsccScenarioSet;
  /** z の節点（昇順 13 個） */
  nodes: readonly number[];
  /** `商品-YYYYMM`（NK225E / NK225F / NK225MF / NK225MCF）→ 行 */
  rows: ReadonlyMap<string, JsccFactorRow>;
}

/** 当て直しにできない理由（none = M の足が無い = 0 円） */
export type JsccRefitIneligible = 'missing' | 'fractional' | 'none';

const FUTURE_CODES: Record<FutureProduct, string> = {
  fut_large: 'NK225F',
  fut_mini: 'NK225MF',
  fut_micro: 'NK225MCF',
};
const OPTION_CODE = 'NK225E';
const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

function periodOf(id: string): string | null {
  const m = YM.exec(id);
  return m ? `${m[1]}${m[2]}` : null;
}

/** 足の行（OP は NK225E、先物は自分の商品 → NK225E → ほかの先物）。無ければ null */
export function jsccFactorRowOf(p: PreparedLeg, f: JsccFactors): JsccFactorRow | null {
  const leg = p.leg;
  if (leg.kind === 'option') {
    const cp = periodOf(leg.expiry);
    return cp === null ? null : (f.rows.get(`${OPTION_CODE}-${cp}`) ?? null);
  }
  const cp = periodOf(leg.contract);
  if (cp === null) return null;
  const order = [FUTURE_CODES[leg.product], OPTION_CODE, ...Object.values(FUTURE_CODES)];
  for (const code of order) {
    const row = f.rows.get(`${code}-${cp}`);
    if (row) return row;
  }
  return null;
}

/** 当て直しの足（状態 S で 1 回決める量） */
interface RefitLeg {
  /** 符号 × 枚数（整数。買い +） */
  q: number;
  /** 乗数 */
  mult: number;
  eR: Float64Array;
  future: boolean;
  /** 状態 S の足の原資産 */
  fS: number;
  // OP だけ
  call: boolean;
  strike: number;
  sigmaS: number;
  /** T′ = T_S − h（年） */
  tPrime: number;
  g: Float64Array | null;
  /** g の節点の添字と重み（z_S は状態で 1 回） */
  m: number;
  wt: number;
}

/** 状態 S で当て直す準備（M の足・NOV・先物の評価損益は marginLegs） */
export interface JsccRefitPlan {
  base: MarginLegs;
  legs: RefitLeg[];
  n: number;
  r: number;
  tMin: number;
  sigmaMin: number;
}

const expCache = new WeakMap<Float64Array, Float64Array>();
function expOf(r: Float64Array): Float64Array {
  let e = expCache.get(r);
  if (!e) {
    e = new Float64Array(r.length);
    for (let j = 0; j < r.length; j++) e[j] = Math.exp(r[j] as number);
    expCache.set(r, e);
  }
  return e;
}

/** z の節点の添字 m と重み（g = (1 − wt)·G[m] + wt·G[m + 1]）。節点の外は端の値 */
export function nodeWeight(z: number, nodes: readonly number[]): { m: number; wt: number } {
  const last = nodes.length - 1;
  if (!(z > (nodes[0] as number))) return { m: 0, wt: 0 };
  if (z >= (nodes[last] as number)) return { m: last - 1, wt: 1 };
  let m = 0;
  while (m < last - 1 && z > (nodes[m + 1] as number)) m++;
  const a = nodes[m] as number;
  const b = nodes[m + 1] as number;
  return { m, wt: (z - a) / (b - a) };
}

/** 状態 S の足の原資産（legValue / legSigma と同じ basis の規則） */
function forwardAt(p: PreparedLeg, x: number, ctx: MarketContext, settings: ModelSettings): number {
  return settings.basisMode === 'yen' ? x + p.basis : (x * p.F) / ctx.x0;
}

/** 限月の ATM の σ（状態 S。スマイル + シナリオの Δσ・β・Δs。スマイルが無ければ足の σ の基準） */
function atmSigmaAt(
  p: PreparedLeg,
  x: number,
  sc: Scenario,
  ctx: MarketContext,
  settings: ModelSettings,
  fS: number,
): number {
  if (p.leg.kind !== 'option') return Number.NaN;
  const smile = ctx.options[p.leg.expiry]?.smile;
  const base = smile
    ? boardSigmaBase(smile)
    : (p.option as NonNullable<PreparedLeg['option']>).sigmaBase;
  return sigmaAt(base, fS, p.F, fS, ctx.x0, x, sc, settings.sigmaMin);
}

/**
 * 状態 S の当て直しの準備。M の足（marginLegs と同じ）すべてに行があり、枚数が整数のときだけ ok。
 * 理由の順は jsccEligibility（#382）と同じ: 枚数が整数でない → fractional、行が無い → missing、M の足が無い → none
 */
export function jsccRefitPlan(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  factors: JsccFactors,
): { ok: true; plan: JsccRefitPlan } | { ok: false; reason: JsccRefitIneligible } {
  const base = marginLegs(legs, state, ctx, settings, params);
  const sc = state.scenario;
  const n = factors.set.isHist.length;
  const out: RefitLeg[] = [];
  let fractional = false;
  let missing = false;
  for (let i = 0; i < legs.length; i++) {
    if (!base.inMargin[i]) continue;
    const p = legs[i] as PreparedLeg;
    if (!Number.isInteger(p.leg.qty)) {
      fractional = true;
      continue;
    }
    const row = jsccFactorRowOf(p, factors);
    if (
      !row ||
      row.r.length !== n ||
      (row.g !== null && row.g.length !== n * JSCC_REFIT_NODE_COUNT)
    ) {
      missing = true;
      continue;
    }
    const q = p.sign * p.leg.qty;
    const mult = p.multiplier;
    const eR = expOf(row.r);
    if (p.leg.kind === 'future') {
      out.push({
        q,
        mult,
        eR,
        future: true,
        fS: legValue(p, state.x, sc, ctx, settings),
        call: false,
        strike: 0,
        sigmaS: 0,
        tPrime: 0,
        g: null,
        m: 0,
        wt: 0,
      });
      continue;
    }
    const fS = forwardAt(p, state.x, ctx, settings);
    const tS = p.T0 - sc.days / 365;
    const sigmaS = legSigma(p, state.x, sc, ctx, settings) ?? settings.sigmaMin;
    const atm = atmSigmaAt(p, state.x, sc, ctx, settings, fS);
    const z = fS > 0 && tS > 0 && atm > 0 ? Math.log(p.leg.strike / fS) / (atm * Math.sqrt(tS)) : 0;
    const { m, wt } = nodeWeight(Number.isFinite(z) ? z : 0, factors.nodes);
    out.push({
      q,
      mult,
      eR,
      future: false,
      fS,
      call: p.leg.type === 'call',
      strike: p.leg.strike,
      sigmaS,
      tPrime: tS - state.horizonDays / 365,
      g: row.g,
      m,
      wt,
    });
  }
  if (fractional) return { ok: false, reason: 'fractional' };
  if (missing) return { ok: false, reason: 'missing' };
  if (out.length === 0) return { ok: false, reason: 'none' };
  return {
    ok: true,
    plan: { base, legs: out, n, r: ctx.r, tMin: settings.tMin, sigmaMin: settings.sigmaMin },
  };
}

/** OP の 1 単位の値（下限 1 円・円に丸める） */
function optionUnit(L: RefitLeg, j: number, plan: JsccRefitPlan): number {
  const F = L.fS * (L.eR[j] as number);
  const T = L.tPrime;
  let v: number;
  if (T <= 0) v = L.call ? Math.max(F - L.strike, 0) : Math.max(L.strike - F, 0);
  else if (T <= plan.tMin) v = discountedIntrinsic(L.call ? 'call' : 'put', F, L.strike, T, plan.r);
  else {
    let s = L.sigmaS;
    if (L.g !== null) {
      const o = j * JSCC_REFIT_NODE_COUNT + L.m;
      const gv = (1 - L.wt) * (L.g[o] as number) + L.wt * (L.g[o + 1] as number);
      s *= Math.exp(gv);
    }
    v = black76Price(L.call ? 'call' : 'put', F, L.strike, T, Math.max(plan.sigmaMin, s), plan.r);
  }
  return Math.max(1, Math.round(v));
}

/** シナリオ j のポートフォリオの値（整数） */
function valueAt(plan: JsccRefitPlan, j: number): number {
  let v = 0;
  for (const L of plan.legs) {
    // 1 枚の値を円の整数にしてから枚数を掛ける（BPF の pnl と同じ = 今の JSCC の計算と同じ足し方）
    v +=
      L.q *
      (L.future
        ? Math.round(L.mult * L.fS * ((L.eR[j] as number) - 1))
        : L.mult * optionUnit(L, j, plan));
  }
  return v;
}

/** 全シナリオの値（整数。長さ = 本数） */
export function jsccRefitVector(plan: JsccRefitPlan): Float64Array {
  const v = new Float64Array(plan.n);
  for (let j = 0; j < plan.n; j++) v[j] = valueAt(plan, j);
  return v;
}

function resultOf(
  plan: JsccRefitPlan,
  state: MarginState,
  params: MarginParams,
  esSigned: number,
  businessDate: string,
): MarginResult {
  const nov = plan.base.nov;
  const varMargin = Math.max(0, esSigned, Math.ceil(-nov - 1e-6));
  const margin = params.factor * varMargin;
  return {
    pfe: varMargin,
    nov,
    margin,
    requirement: Math.max(0, margin - nov),
    futuresPnl: plan.base.futuresPnl,
    futuresMarked: state.marked,
    settledCash: plan.base.settledCash,
    worst: null,
    source: 'jscc_refit',
    jscc: { businessDate, varMargin, esSigned, novSettle: nov },
  };
}

/**
 * 状態 S の必要証拠金を JSCC のシナリオの当て直しで（#387）。当て直せなければ null（理由は jsccRefitPlan）=
 * 呼び出し側が格子の概算に戻す。v はシナリオごとの値（追証の線の裾の候補に使う）
 */
export function marginAtJsccRefit(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  factors: JsccFactors,
): { result: MarginResult; v: Float64Array } | null {
  const planned = jsccRefitPlan(legs, state, ctx, settings, params, factors);
  if (!planned.ok) return null;
  const v = jsccRefitVector(planned.plan);
  const es = jsccEsSigned(v, factors.set);
  return { result: resultOf(planned.plan, state, params, es, factors.businessDate), v };
}

/** 裾の候補（H の小さい方から 4 × 裾の本数 + S の全部）の添字。v の和集合 */
function tailCandidates(vs: readonly Float64Array[], set: JsccScenarioSet): Int32Array {
  const nh = set.isHist.filter(Boolean).length;
  const per = 4 * jsccTailCount(nh + set.nStress, set.confidence);
  const pick = new Set<number>();
  const hist: number[] = [];
  for (let j = 0; j < set.isHist.length; j++) {
    if (set.isHist[j]) hist.push(j);
    else pick.add(j);
  }
  for (const v of vs) {
    const order = [...hist].sort((a, b) => (v[a] as number) - (v[b] as number));
    for (const j of order.slice(0, per)) pick.add(j);
  }
  return Int32Array.from([...pick].sort((a, b) => a - b));
}

/** 候補のシナリオだけの ES（候補に裾が入っている前提。入っていなければ実際より小さい = 呼び出し側が確かめる） */
function esOnCandidates(plan: JsccRefitPlan, idx: Int32Array, set: JsccScenarioSet): number {
  const h: number[] = [];
  const s: number[] = [];
  for (const j of idx) (set.isHist[j] ? h : s).push(valueAt(plan, j));
  s.sort((a, b) => a - b);
  const nh = set.isHist.filter(Boolean).length;
  const xs = [...h, ...s.slice(0, set.nStress)].sort((a, b) => a - b);
  return jsccEsOfSorted(xs, nh + set.nStress, set);
}

/**
 * 追証の線の当て直しの余力の評価（#387）。room は全シナリオで評価し、v を覚える。refine は区間の両端の v の裾の候補だけで
 * 二分法を回し、収束した区間の両端を全シナリオで確かめて符号が違えば採用（同じなら null = 全シナリオでやり直し）。
 * 当て直せない状態（行が無いなど）は余力 NaN（線にしない。呼び出し側が事前に今の状態で確かめる）
 */
export function jsccRefitRoomEvaluator(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  horizonDays: number,
  marked: boolean,
  capital: number,
  premium: PremiumSummary,
  factors: JsccFactors,
): RoomEvaluator {
  const seen = new Map<number, Float64Array>();
  const stateOf = (x: number): MarginState => ({
    x,
    scenario: { ...scenario, dX: x - ctx.x0 },
    horizonDays,
    marked,
  });
  const full = (x: number): number => {
    const r = marginAtJsccRefit(legs, stateOf(x), ctx, settings, params, factors);
    if (!r) return Number.NaN;
    seen.set(x, r.v);
    if (seen.size > 64) seen.delete(seen.keys().next().value as number);
    return marginRoom(capital, premium, r.result);
  };
  return {
    room: full,
    *refine(xa, xb, fa) {
      const va = seen.get(xa);
      const vb = seen.get(xb);
      if (!va || !vb) return null;
      const idx = tailCandidates([va, vb], factors.set);
      const fast = (x: number): number => {
        const st = stateOf(x);
        const planned = jsccRefitPlan(legs, st, ctx, settings, params, factors);
        if (!planned.ok) return Number.NaN;
        const es = esOnCandidates(planned.plan, idx, factors.set);
        return marginRoom(
          capital,
          premium,
          resultOf(planned.plan, st, params, es, factors.businessDate),
        );
      };
      let a = xa;
      let b = xb;
      let ga = fa;
      while (b - a > 0.5) {
        const m = 0.5 * (a + b);
        const gm = fast(m);
        yield;
        if (!Number.isFinite(gm)) return null;
        if (gm === 0) {
          a = m;
          b = m;
          break;
        }
        if (ga * gm < 0) b = m;
        else {
          a = m;
          ga = gm;
        }
      }
      // 確かめ: 全シナリオで両端の符号が違う（か 0）なら、その区間に全シナリオの根がある
      const ra = full(a);
      yield;
      if (a === b) return ra === 0 ? a : null;
      const rb = full(b);
      yield;
      if (ra === 0) return a;
      if (rb === 0) return b;
      return ra * rb < 0 ? 0.5 * (a + b) : null;
    },
  };
}

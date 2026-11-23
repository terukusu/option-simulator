/**
 * 証拠金（今は JSCC の計算・ほかは格子の概算）。設計 docs/design.md 5.10。
 *
 * 今（シナリオ 0）の必要証拠金は JSCC の VaR 証拠金の計算（marginNowJscc・jsccEligibility。model/jsccMargin.ts。#382・
 * ADR-0013）。JSCC のデータが無いときの今と、シナリオの点・テール・追証の線などは、証券会社の建てる前の必要委託証拠金に
 * 近い物差しの格子の概算（既定は 6 点の答え合わせで決めた。#150）:
 *
 * - 状態 S = (x_S, シナリオ)。格子 = 原資産 x_S × (1 + s·R)（s ∈ MARGIN_PRICE_STEPS）
 *   × IV の倍率 {1 + ivUp, 1, 1 − ivDown} × 経過 {0, h}（h = S から 2 営業日後までの暦日）
 * - IV: 生きている OP の足ごとに状態 S の評価 IV σ_S（legSigma。β・Δσ・Δs・動き方・スマイル込み）を
 *   1 回求め、格子の全点で max(σ_min, σ_S × 倍率) の一定の σ で評価する（格子の原資産の点で β・スマイル・
 *   動き方を足さない）。F'・満期・T ≤ tMin の規則は legValue と同じ（legValueAtSigma）
 * - M の足 = 生きている足のうち、ignoreLongOptions なら売りの OP と先物だけ（買いの OP で減らさない。
 *   証券会社の扱い。#149）、そうでなければ全部（JSCC の形）
 * - V(S) = Σ_M の足 符号 × 枚数 × 乗数 × 評価価格（建値・手数料を含まない）
 * - PFE = max(0, max_格子 (V(S) − V(格子)))、NOV = Σ_M の足のうち OP 符号 × 枚数 × 乗数 × 評価価格
 * - 必要証拠金（概算）= k × PFE（NOV を含まない。証券会社の建てる前の必要委託証拠金と同じ物差し）
 * - 証拠金所要額 = max(0, k × PFE − NOV)（掛け目を NOV に掛けない。負にしない）
 * - 余力 A = 資金 − 支払 + 受取 − 手数料（全足）+ 先物の項 + 決済済みの足の清算額 − 証拠金所要額。
 *   先物の項 = S までに値洗い（日中の引け）をまたがなければ min(0, 先物の評価損益（生きている足の合計）)
 *   （評価益は足さない = 証券会社の計算式の拘束金額の先物建玉評価損。#375）、1 回以上またいだら評価損益の
 *   合計をそのまま（最後の値洗いの価格 = S の価格と見なし、値洗いで受入証拠金に入った益も数える。#381・ADR-0012）
 *
 * 生きている足 = S の時点で T > 0 の足。S で SQ を過ぎた足は格子・NOV に入れず、清算額だけを余力に入れる
 * （OP は 符号 × 枚数 × 乗数 × 本源的価値、先物は 符号 × 枚数 × 乗数 × (F' − 建値)、F' = X'）。
 * F が決まらない足（no_forward）は入れない。h・休業日・現在時刻は呼び出し側が決めて渡す。
 */

import { type JsccData, type JsccPosition, jsccKeyOfLeg, jsccVarMargin } from './jsccMargin';
import { findBreakevens } from './pnl';
import {
  legSigma,
  legValue,
  legValueAtSigma,
  type MarketContext,
  type ModelSettings,
  type PremiumSummary,
  type PreparedLeg,
} from './position';
import type { Scenario } from './scenario';
import { crossesDayClose, DAY_MS, type Holidays } from './time';

export interface MarginParams {
  /** 原資産の値動き幅 R（小数。0.05 = ±5%） */
  range: number;
  /** IV の上げ（比率の小数。0.5 = 状態 S の IV の ×1.5） */
  ivUp: number;
  /** IV の下げ（比率の小数。0.25 = 状態 S の IV の ×0.75） */
  ivDown: number;
  /** 掛け目 k（倍率。1 = 100%） */
  factor: number;
  /**
   * 買いの OP で証拠金を減らさない（true = M の足は生きている売りの OP と先物だけ。証券会社の扱い。
   * false = 全足で相殺する JSCC の形）。余力の他の項は全足のまま。#149
   */
  ignoreLongOptions: boolean;
}

/** 既定値（6 点の答え合わせで決めた。設定で変えられる。設計 5.10・#150） */
export const DEFAULT_MARGIN_PARAMS: MarginParams = {
  range: 0.05,
  ivUp: 0.5,
  ivDown: 0.25,
  factor: 1,
  // 既定は全足で相殺する（今の必要証拠金を JSCC の計算にしたので JSCC と同じ形。#382。証券会社によっては
  // 買いの OP で減らさない扱いがあり、設定でオンにできる）
  ignoreLongOptions: false,
};

export const MARGIN_PRICE_STEPS = [-1, -0.5, 0, 0.5, 1] as const;
/** 保有期間（営業日。JSCC の変動日数 2 日に合わせる） */
export const MARGIN_HORIZON_BUSINESS_DAYS = 2;
/** 追証の線の分割数（符号の変化を囲う） */
export const MARGIN_LINE_SAMPLES = 32;

export interface MarginState {
  /** 基準原資産 X_S（円） */
  x: number;
  /** S のシナリオ（d・Δσ・Δs・β・動き方。ΔX は x と同じ点を指す） */
  scenario: Scenario;
  /** h = S の時点から 2 営業日後までの暦日 */
  horizonDays: number;
  /**
   * 今（板の時刻）から S までに値洗い（営業日の 15:45 JST）を 1 回以上またいだか（marginMarked）。true なら余力に
   * 先物の評価損益を益も損も入れる（#381）。false なら評価損だけ（#375）
   */
  marked: boolean;
}

export interface MarginWorst {
  priceStep: number;
  /** IV の倍率（1.5 / 1 / 0.75 など） */
  ivScale: number;
  days: number;
}

export interface MarginResult {
  /** S からの損失の最悪値（円、≥ 0） */
  pfe: number;
  /** ネット・オプション価値（円。買い +、売り −） */
  nov: number;
  /** 必要証拠金（概算、円）= k × PFE（NOV を含まない。タイル・テールの証拠金の表の値） */
  margin: number;
  /** 証拠金所要額（円）= max(0, k × PFE − NOV)（余力・倍数・追証の線はこれ） */
  requirement: number;
  /**
   * 生きている先物の足の評価損益の合計（手数料抜き、円。益も損も）。余力には、値洗いをまたいでいなければ負のときだけ
   * （#375）、またいでいれば益も損も入る（#381）
   */
  futuresPnl: number;
  /** 状態 S が値洗いをまたいだか（MarginState.marked の写し。marginRoom が読む） */
  futuresMarked: boolean;
  /** S で SQ を過ぎた足の清算額（円） */
  settledCash: number;
  /** 損失が最大になった格子の点（M の足が無い・JSCC の計算なら null） */
  worst: MarginWorst | null;
  /** 必要証拠金の出どころ: grid = 格子の概算、jscc = JSCC の VaR 証拠金額（今だけ。#382） */
  source: 'grid' | 'jscc';
  /** JSCC の計算の内訳（source = jscc のときだけ） */
  jscc?: MarginJsccDetail;
}

export interface MarginJsccDetail {
  /** JSCC の営業日（前営業日の清算値で 1 日固定の、その日。YYYY-MM-DD） */
  businessDate: string;
  /** VaR 証拠金額（円）= max(0, ES, ceil(−NOV_清算)) */
  varMargin: number;
  /** 符号つきの ES（円） */
  esSigned: number;
  /** NOV_清算（円。清算値段の NOV） */
  novSettle: number;
}

/** M の足・NOV・先物の評価損益・清算額（格子と JSCC の両方で使う最初のループ） */
interface MarginLegs {
  /** 足ごとに M に入れるか（生きていて、オンなら買いの OP を除く） */
  inMargin: boolean[];
  /** Σ_M 符号 × 枚数 × 乗数 × 評価価格（状態 S） */
  v0: number;
  nov: number;
  futuresPnl: number;
  settledCash: number;
  anyInMargin: boolean;
}

function marginLegs(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginLegs {
  const sc = state.scenario;
  const inMargin: boolean[] = [];
  let v0 = 0;
  let nov = 0;
  let futuresPnl = 0;
  let settledCash = 0;
  let anyInMargin = false;
  for (const p of legs) {
    const live = Number.isFinite(p.F) && p.T0 - sc.days / 365 > 0;
    const longOption = p.leg.kind === 'option' && p.sign > 0;
    const counted = live && !(params.ignoreLongOptions && longOption);
    inMargin.push(counted);
    if (!Number.isFinite(p.F)) continue;
    const w = p.sign * p.leg.qty * p.multiplier;
    if (live && !counted) continue; // 生きている買いの OP（オン）: 支払は余力の他の項に入っている
    const v = legValue(p, state.x, sc, ctx, settings);
    if (!live) {
      settledCash += p.leg.kind === 'future' ? w * (v - p.leg.entry) : w * v;
      continue;
    }
    anyInMargin = true;
    v0 += w * v;
    if (p.leg.kind === 'option') nov += w * v;
    else futuresPnl += w * (v - p.leg.entry);
  }
  return { inMargin, v0, nov, futuresPnl, settledCash, anyInMargin };
}

function emptyResult(state: MarginState, settledCash: number): MarginResult {
  // M の足が無い = 生きている先物も無い（先物は常に M の足）ので futuresPnl も 0
  return {
    pfe: 0,
    nov: 0,
    margin: 0,
    requirement: 0,
    futuresPnl: 0,
    futuresMarked: state.marked,
    settledCash,
    worst: null,
    source: 'grid',
  };
}

function marginOn(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginResult {
  const sc = state.scenario;
  const { inMargin, v0, nov, futuresPnl, settledCash, anyInMargin } = marginLegs(
    legs,
    state,
    ctx,
    settings,
    params,
  );
  if (!anyInMargin) return emptyResult(state, settledCash);
  // 生きている M の OP の足の状態 S の σ（それ以外は null）
  const sigmaS: Array<number | null> = legs.map((p, i) =>
    inMargin[i] ? legSigma(p, state.x, sc, ctx, settings) : null,
  );
  let maxLoss = Number.NEGATIVE_INFINITY;
  let worst: MarginWorst = { priceStep: 0, ivScale: 1, days: 0 };
  const times = state.horizonDays > 0 ? [0, state.horizonDays] : [0];
  const scales = [1 + params.ivUp, 1, 1 - params.ivDown];
  const sigmas: number[] = new Array(legs.length).fill(0);
  for (const c of scales) {
    for (let i = 0; i < legs.length; i++) {
      const s0 = sigmaS[i];
      if (s0 != null) sigmas[i] = Math.max(settings.sigmaMin, s0 * c);
    }
    for (const t of times) {
      const scT: Scenario = t === 0 ? sc : { ...sc, days: sc.days + t };
      for (const s of MARGIN_PRICE_STEPS) {
        const x = state.x * (1 + s * params.range);
        let v = 0;
        for (let i = 0; i < legs.length; i++) {
          if (!inMargin[i]) continue;
          const p = legs[i] as PreparedLeg;
          const price =
            sigmaS[i] == null
              ? legValue(p, x, scT, ctx, settings)
              : legValueAtSigma(p, x, scT, ctx, settings, sigmas[i] as number);
          v += p.sign * p.leg.qty * p.multiplier * price;
        }
        const loss = v0 - v;
        if (loss > maxLoss) {
          maxLoss = loss;
          worst = { priceStep: s, ivScale: c, days: t };
        }
      }
    }
  }
  const pfe = Math.max(0, maxLoss);
  const margin = params.factor * pfe;
  return {
    pfe,
    nov,
    margin,
    requirement: Math.max(0, margin - nov),
    futuresPnl,
    futuresMarked: state.marked,
    settledCash,
    worst,
    source: 'grid',
  };
}

/** 状態 S の必要証拠金（概算）と、余力に入る先物の評価損益（合計）・決済済みの清算額。 */
export function marginAt(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
): MarginResult {
  return marginOn(legs, state, ctx, settings, params);
}

/** JSCC の計算にできない理由（model が決めるもの。none = M の足が無い = 0 円で格子と同じ） */
export type JsccIneligible = 'missing' | 'groups' | 'fractional' | 'none';

type JsccPlan = { ok: true; positions: JsccPosition[] } | { ok: false; reason: JsccIneligible };

function jsccPlan(
  legs: readonly PreparedLeg[],
  inMargin: readonly boolean[],
  data: JsccData,
): JsccPlan {
  const positions: JsccPosition[] = [];
  const groups = new Set<string>();
  let fractional = false;
  for (let i = 0; i < legs.length; i++) {
    if (!inMargin[i]) continue;
    const p = legs[i] as PreparedLeg;
    if (!Number.isInteger(p.leg.qty)) {
      fractional = true;
      continue;
    }
    const key = jsccKeyOfLeg(p.leg);
    const inst = key === null ? undefined : data.instruments.get(key);
    const option = p.leg.kind === 'option';
    if (!inst || (option && (inst.price === null || !Number.isFinite(inst.price)))) {
      return { ok: false, reason: 'missing' };
    }
    groups.add(inst.aggregationGroup);
    positions.push({ inst, qty: p.sign * p.leg.qty, option });
  }
  if (fractional) return { ok: false, reason: 'fractional' };
  if (positions.length === 0) return { ok: false, reason: 'none' };
  if (groups.size > 1) return { ok: false, reason: 'groups' };
  return { ok: true, positions };
}

/**
 * 今のポジションを JSCC の計算にできるか（できなければ理由）。M の足は marginAt と同じ（生きている足、
 * ignoreLongOptions なら買いの OP を除く）。理由の順: 枚数が整数でない足 → fractional、行が無い（キーにできない・
 * OP の清算値段が無い）→ missing、集計グループが 2 つ以上 → groups、M の足が無い → none
 */
export function jsccEligibility(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  data: JsccData,
): { ok: true } | { ok: false; reason: JsccIneligible } {
  const { inMargin } = marginLegs(legs, state, ctx, settings, params);
  const plan = jsccPlan(legs, inMargin, data);
  return plan.ok ? { ok: true } : { ok: false, reason: plan.reason };
}

/**
 * 今の必要証拠金を JSCC の計算で（#382・設計 5.10・ADR-0013）:
 * - 必要証拠金 = k × V（V = VaR 証拠金額。jsccVarMargin）
 * - NOV・先物の評価損益・清算額は marginAt と同じ（今の評価価格。NOV は所要額で 2 回効く = 証券会社の形）
 * - 所要額 = max(0, k × V − NOV)
 * JSCC の計算にできなければ（jsccEligibility）null = 呼び出し側が格子の概算に戻す。state は今（d = 0）を渡す前提
 */
export function marginNowJscc(
  legs: readonly PreparedLeg[],
  state: MarginState,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  data: JsccData,
): MarginResult | null {
  const base = marginLegs(legs, state, ctx, settings, params);
  const plan = jsccPlan(legs, base.inMargin, data);
  if (!plan.ok) return null;
  const { esSigned, novSettle, varMargin } = jsccVarMargin(plan.positions, data.set);
  const margin = params.factor * varMargin;
  return {
    pfe: varMargin,
    nov: base.nov,
    margin,
    requirement: Math.max(0, margin - base.nov),
    futuresPnl: base.futuresPnl,
    futuresMarked: state.marked,
    settledCash: base.settledCash,
    worst: null,
    source: 'jscc',
    jscc: { businessDate: data.businessDate, varMargin, esSigned, novSettle },
  };
}

/**
 * 余力 A = 資金 − 支払 + 受取 − 手数料 + 先物の項 + 決済済みの清算額 − 証拠金所要額（円）。
 * 先物の項（評価損益は生きている先物の足どうしで差し引いた合計）:
 * - 値洗いをまたいでいない（r.futuresMarked = false）: min(0, 評価損益)。評価益は足さない（証券会社の計算式:
 *   余力 = 受入証拠金 − 必要委託証拠金 − 拘束金額、拘束金額の先物建玉評価損 = 前営業日の値洗い価格（当日約定は建値）
 *   からの当日分の損。#375・設計 5.10）
 * - またいだ: 評価損益そのもの（最後の値洗いの価格 = S の価格と見なす近似。値洗いまでの損益は益も損も受入証拠金に
 *   入り、値洗いから S までの当日分は 0。#381・ADR-0012）
 * 受渡の済んだ状態の評価なので、支払・受取・手数料は受入証拠金に入り（拘束金額の買 OP 購入代金・手数料は 0）、
 * 余力 < 0 ⇔ 追加証拠金 > 0（受入証拠金 − 先物の評価損 < 維持証拠金。注文なしで必要委託 = 維持）。
 */
export function marginRoom(capital: number, premium: PremiumSummary, r: MarginResult): number {
  return (
    capital -
    premium.paid +
    premium.received -
    premium.fees +
    (r.futuresMarked ? r.futuresPnl : Math.min(0, r.futuresPnl)) +
    r.settledCash -
    r.requirement
  );
}

/**
 * 今（板の時刻 evalTime）から経過 days 日（暦日。小数可）の状態 S までに値洗い（営業日の 15:45 JST）を 1 回以上
 * またぐか（MarginState.marked。#381）。休業日は保有期間 h と同じ集合を渡す。days ≤ 0・非有限は false。
 */
export function marginMarked(evalTime: number, days: number, holidays: Holidays): boolean {
  if (!Number.isFinite(days) || days <= 0) return false;
  return crossesDayClose(evalTime, evalTime + days * DAY_MS, holidays);
}

/**
 * 今のポジションの枚数の何倍まで余力 ≥ 0 を保てるか（整数）。全項が枚数に 1 次同次なので
 * A(m) = 資金 + m × s（s = A(1) − 資金。所要額も max(0, m·a) = m·max(0, a)、先物の評価損も min(0, m·f) = m·min(0, f)、
 * 値洗いをまたいだ先物の評価損益は m·f）。s ≥ 0 なら上限なし（Infinity）。資金が 0 / 非有限なら null。
 */
export function maxMultiple(
  capital: number,
  premium: PremiumSummary,
  r: MarginResult,
): number | null {
  if (!Number.isFinite(capital) || capital <= 0) return null;
  const s = marginRoom(capital, premium, r) - capital;
  if (s >= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((capital / -s) * (1 + 1e-12));
}

/**
 * 生きている先物の足の評価損益の合計（円）。X に対して 1 次（F' は X + basis か X × 比）なので、追証の線で
 * 余力が折れる点（合計 = 0）を求めるのに使う。marginOn の futuresPnl と同じ足・同じ評価。
 */
function liveFuturesPnl(
  legs: readonly PreparedLeg[],
  x: number,
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings,
): { pnl: number; any: boolean } {
  let pnl = 0;
  let any = false;
  for (const p of legs) {
    if (p.leg.kind !== 'future' || !Number.isFinite(p.F)) continue;
    if (!(p.T0 - scenario.days / 365 > 0)) continue;
    any = true;
    pnl +=
      p.sign * p.leg.qty * p.multiplier * (legValue(p, x, scenario, ctx, settings) - p.leg.entry);
  }
  return { pnl, any };
}

/**
 * 追証の線: シナリオ（ΔX 以外はそのまま）で X だけを動かしたとき余力 A(X) = 0 になる X（1 円に丸め、
 * 昇順）。range を samples 等分して符号の変化を囲い二分法（findBreakevens と同じ作り）。
 * 値洗いをまたがない（marked = false）とき、余力は生きている先物の評価損益の合計 = 0 の X で折れる（評価益を
 * 足さない。#375）ので、その点が range の内側にあれば区間をそこで 2 つに分ける（分割の数は長さに比例して配り、
 * 合計は samples + 1 以下）。先物だけのポジションでは折れ点の両側に 1 つずつ根がありうるので、刻みより近い 2 根を
 * 取りこぼさない。またいだら（marked = true）評価損益をそのまま入れるので折れない（分けない。#381）。
 * 資金が 0 / 非有限、または余力がどこでも正なら []。
 */
export function marginCallLevels(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings,
  params: MarginParams,
  horizonDays: number,
  marked: boolean,
  capital: number,
  premium: PremiumSummary,
  range: { lo: number; hi: number },
  samples: number = MARGIN_LINE_SAMPLES,
): number[] {
  if (!Number.isFinite(capital) || capital <= 0) return [];
  const f = (x: number) =>
    marginRoom(
      capital,
      premium,
      marginOn(
        legs,
        { x, scenario: { ...scenario, dX: x - ctx.x0 }, horizonDays, marked },
        ctx,
        settings,
        params,
      ),
    );
  const { lo, hi } = range;
  if (marked) return findBreakevens(f, lo, hi, samples).sort((a, b) => a - b);
  const g = (x: number) => liveFuturesPnl(legs, x, scenario, ctx, settings);
  const gl = g(lo);
  const gh = g(hi);
  if (
    gl.any &&
    hi > lo &&
    Number.isFinite(gl.pnl) &&
    Number.isFinite(gh.pnl) &&
    gl.pnl * gh.pnl < 0
  ) {
    const kink = lo + ((hi - lo) * gl.pnl) / (gl.pnl - gh.pnl);
    if (kink > lo && kink < hi) {
      const n1 = Math.max(1, Math.round((samples * (kink - lo)) / (hi - lo)));
      const n2 = Math.max(1, samples - n1);
      const xs = [...findBreakevens(f, lo, kink, n1), ...findBreakevens(f, kink, hi, n2)];
      return [...new Set(xs)].sort((a, b) => a - b);
    }
  }
  return findBreakevens(f, lo, hi, samples).sort((a, b) => a - b);
}

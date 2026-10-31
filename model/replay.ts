/**
 * 過去の急落の再生（#307。設計 docs/design.md 5.14）の当て方: 過去の出来事の道筋（data/replay.ts の replayPath）の
 * k 日目を、今のポジションに当てたときの余力・損益。
 *
 * - k 日目の状態 = 原資産 x = X₀(1 + u_k)・経過日数 d_k（今日から k 営業日後までの暦日）・足ごとの ATM の IV の倍率
 *   c_p,k。足の IV は追証マップ（5.11・#305）と同じ「今のスマイル（sticky strike）+ 平行の上乗せ Δ_p」
 *   （holdMapLegsBy）。β・Δσ・Δs は 0、IV の動き方はシナリオの値
 * - c_p,k = termIv(term_k, τ) / termIv(term_0, τ)、τ = 足の k 日目の残存（暦日）。分子と分母で同じ残存 = 同じ残存の
 *   ATM の IV の水準の変化（期間構造の傾きで時間とともに下る分は入れない。今のモデルは時間が進んでも足の σ を動かさない
 *   のと同じ）。どちらかの日の期間構造が無い・値が使えなければ iv30 の比（iv_k / iv_0）に戻す
 * - 最も遠い足の SQ を過ぎた日（d_k > maxDays）は出さない（ended）。全部の足が満期の後は損益が SQ の値で決まり、
 *   その後の原資産の動きを当てると誤りになる。途中で SQ を過ぎた足は今どおり本源的価値
 * - 余力 = 5.10 の marginAt + marginRoom（h = k 日目から 2 営業日後までの暦日）。損益 = theoreticalPnl（手数料込み）。
 *   追証になった日の後も入金して持ち続けた前提（余力は資金 + 損益で計り直すだけ。入金額は足さない）
 *
 * 純関数（DOM・通信・時計に依存しない）。
 */

import { CM_M2_DAYS } from './constantMaturity';
import { holdMapLegsBy, holdMapScenario } from './holdMap';
import { MARGIN_HORIZON_BUSINESS_DAYS, type MarginParams, marginAt, marginRoom } from './margin';
import {
  type MarketContext,
  type ModelSettings,
  type PremiumSummary,
  type PreparedLeg,
  theoreticalPnl,
} from './position';
import { type IvDynamics, ZERO_SCENARIO } from './scenario';
import { businessDaysAhead, DAY_MS, type Holidays } from './time';

/**
 * その日の ATM の期間構造（日中の終値。t は SQ までの暦日、v は ATM IV %）。2 限月が無ければ t2・v2 は null
 */
export interface AtmTerm {
  t1: number;
  v1: number;
  t2: number | null;
  v2: number | null;
}

const usable = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

/**
 * 残存 tauDays（暦日）の ATM IV（%）: 1・2 限月の間は総分散 σ²t の線形補間の √、1 限月より手前は 1 限月、2 限月より
 * 先は 2 限月（2 限月が無ければ 1 限月）。SQ まで CM_M2_DAYS（3 日）未満の 1 限月は使わない（iv30 と同じ。SQ 間際の
 * 跳ねを入れない）= 2 限月だけ。使える値が無い・補間が正でなければ NaN
 */
export function termIv(term: AtmTerm, tauDays: number): number {
  const { t1, v1, t2, v2 } = term;
  const has2 = usable(v2) && t2 !== null && Number.isFinite(t2) && t2 > t1;
  if (!(Number.isFinite(t1) && t1 >= CM_M2_DAYS)) return has2 ? v2 : Number.NaN;
  if (!usable(v1)) return Number.NaN;
  if (!has2 || !(tauDays > t1)) return v1;
  if (tauDays >= (t2 as number)) return v2;
  const w = (tauDays - t1) / ((t2 as number) - t1);
  const total = v1 * v1 * t1 + w * (v2 * v2 * (t2 as number) - v1 * v1 * t1);
  const v = Math.sqrt(total / tauDays);
  return Number.isFinite(v) && v > 0 ? v : Number.NaN;
}

/**
 * 足の残存 tauDays の ATM の IV の倍率（k 日目 / 始まりの日）。両方の日の期間構造から作れなければ iv30 の比。
 * それも作れなければ NaN
 */
export function replayIvRatio(
  term0: AtmTerm | null,
  termK: AtmTerm | null,
  iv0: number,
  ivK: number,
  tauDays: number,
): number {
  if (term0 && termK) {
    const a = termIv(termK, tauDays);
    const b = termIv(term0, tauDays);
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) return a / b;
  }
  const r = ivK / iv0;
  return Number.isFinite(r) && r > 0 ? r : Number.NaN;
}

/** 再生の計算の入力（出来事・日によらない） */
export interface ReplayCalc {
  legs: readonly PreparedLeg[];
  ctx: MarketContext;
  settings: ModelSettings;
  params: MarginParams;
  /** IV の動き方（シナリオの値） */
  dynamics: IvDynamics;
  /** 資金（円、> 0） */
  capital: number;
  premium: PremiumSummary;
  /** 経過日数・h の休業日（追証マップと同じ集合） */
  holidays: Holidays;
  /** 最も遠い足の SQ までの暦日（PnlBase.maxDays） */
  maxDays: number;
}

/** 道筋の 1 日（k = 始まりからの当時の取引日の数、u = 原資産の累積の変化、term・iv = その日の ATM） */
export interface ReplayDayInput {
  k: number;
  u: number;
  term: AtmTerm | null;
  iv: number;
}

export interface ReplayDayResult {
  /** 余力（円。有限でなければ NaN） */
  room: number;
  /** 損益（円。手数料込み。有限でなければ NaN） */
  pnl: number;
  /** 表に出す倍率 = 生きている OP の足のうち SQ が最も近い足の c（無ければ iv30 の比） */
  c: number;
  /** 経過日数 d_k（暦日） */
  days: number;
  /** 最も遠い足の SQ を過ぎた（room・pnl・c は NaN。道筋はここで切る） */
  ended: boolean;
}

/** 足の k 日目の残存（暦日。0 未満は 0） */
const tauOf = (p: PreparedLeg, days: number) => Math.max(0, p.T0 * 365 - days);

/** 道筋の k 日目の余力・損益（day0 = 始まりの日の ATM） */
export function replayDay(
  calc: ReplayCalc,
  day: ReplayDayInput,
  day0: { term: AtmTerm | null; iv: number },
): ReplayDayResult {
  const { legs, ctx, settings, params, dynamics, capital, premium, holidays, maxDays } = calc;
  const days = day.k > 0 ? businessDaysAhead(ctx.evalTime, day.k, holidays) : 0;
  if (days > maxDays + 1e-9) {
    return { room: Number.NaN, pnl: Number.NaN, c: Number.NaN, days, ended: true };
  }
  const cOf = (p: PreparedLeg) =>
    replayIvRatio(day0.term, day.term, day0.iv, day.iv, tauOf(p, days));
  const u = day.u;
  const x = ctx.x0 * (1 + u);
  const scenario = holdMapScenario({ ...ZERO_SCENARIO, days, ivDynamics: dynamics }, u, ctx.x0);
  const legsK = holdMapLegsBy(legs, u, cOf, ctx, settings, dynamics);
  const horizonDays = businessDaysAhead(
    ctx.evalTime + days * DAY_MS,
    MARGIN_HORIZON_BUSINESS_DAYS,
    holidays,
  );
  const room = marginRoom(
    capital,
    premium,
    marginAt(legsK, { x, scenario, horizonDays }, ctx, settings, params),
  );
  const pnl = theoreticalPnl(legsK, x, scenario, ctx, settings);
  let near: PreparedLeg | null = null;
  for (const p of legs) {
    if (p.leg.kind !== 'option' || !(tauOf(p, days) > 0)) continue;
    if (!near || p.expiryTime < near.expiryTime) near = p;
  }
  const c = near ? cOf(near) : replayIvRatio(null, null, day0.iv, day.iv, 0);
  return {
    room: Number.isFinite(room) ? room : Number.NaN,
    pnl: Number.isFinite(pnl) ? pnl : Number.NaN,
    c,
    days,
    ended: false,
  };
}

/** 道筋の要約（添字は渡した行の添字。無ければ null） */
export interface ReplaySummary {
  /** 最初の追証の日（余力 < 0 の最初の行） */
  firstCall: number | null;
  /** 最も足りない額 = 余力の最小（NaN を除く） */
  minRoom: { value: number; index: number } | null;
  /** 最悪の損益（NaN を除く） */
  worstPnl: { value: number; index: number } | null;
  /** 許容損失を超えた最初の行（損益 + 許容損失 < 0。許容損失が無ければ null） */
  firstLoss: number | null;
  /** 終わり（最後の行）の損益（行が無ければ NaN） */
  endPnl: number;
}

export function replaySummary(
  rows: readonly { room: number; pnl: number }[],
  allowedLoss: number | null,
): ReplaySummary {
  let firstCall: number | null = null;
  let firstLoss: number | null = null;
  let minRoom: ReplaySummary['minRoom'] = null;
  let worstPnl: ReplaySummary['worstPnl'] = null;
  rows.forEach((r, i) => {
    if (Number.isFinite(r.room)) {
      if (firstCall === null && r.room < 0) firstCall = i;
      if (!minRoom || r.room < minRoom.value) minRoom = { value: r.room, index: i };
    }
    if (Number.isFinite(r.pnl)) {
      if (!worstPnl || r.pnl < worstPnl.value) worstPnl = { value: r.pnl, index: i };
      if (allowedLoss !== null && firstLoss === null && r.pnl + allowedLoss < 0) firstLoss = i;
    }
  });
  const last = rows[rows.length - 1];
  return { firstCall, minRoom, worstPnl, firstLoss, endPnl: last ? last.pnl : Number.NaN };
}

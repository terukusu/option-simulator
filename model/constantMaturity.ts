/**
 * 30 日固定の ATM IV（iv30）を今の板から計算する（#79 段 C。IV 推移の「今」の 1 点）。設計 docs/design.md 5.9 の注記。
 *
 * optionchan の表 `atm_cm_iv` の iv30 と同じ定義（optionchan `sql/cm/atm_cm.sql` の `-- cm:begin`〜`-- cm:end`。
 * 照合したのは api/contract/optionchan_commit.txt の固定コミット）。シミュレーターのモデルの ATM IV（K7。Black-76 で
 * 逆算したスマイル）とは別の定義なので混ぜない。値は JPX の bid_iv / ask_iv の %（小数にしない）。
 *
 * 1. 使える気配 ok = bid > 0 かつ ask ≥ bid かつ (ask − bid)·2 ≤ 0.3·(ask + bid)。mid = (bid + ask) / 2。
 *    mid IV = ok かつ bid_iv > 0 かつ ask_iv > 0 のとき (bid_iv + ask_iv) / 2
 * 2. 基準 k0 = is_atm の行使価格（call・put どちらかの印。2 本あれば小さい方）。無い限月は F・IV を出さない（順位には数える）
 * 3. 近さの順位: |K − k0|、同じなら K の小さい方（その限月の全行使価格）
 * 4. F = 順位 ≤ 5 で call・put の mid が両方ある K の C_mid − P_mid + K の中央値（偶数個は中央 2 つの平均）。3 本未満なら無し
 * 5. s(K) = 順位 ≤ 9 の K の call・put の mid IV の平均（片方だけならその値）
 * 6. lo = K ≤ F で s のある最大、hi = K > F で s のある最小。iv = s_lo + (s_hi − s_lo)·ln(F / K_lo) / ln(K_hi / K_lo)
 *    （どちらかが無ければ iv は無し。s のある K が 1 本も無ければ F も出さない = SQL の cm_month の行が無い）
 * 7. SQ = 最終取引日の次の営業日（土日・休業日を除く。15 日以内）の 09:00 JST。days = SQ までの秒（切り捨て）/ 86400。
 *    SQ > at の限月を最終取引日の順に 1 限月・2 限月
 * 8. T1 ≥ 30 → σ1（m1）/ T1 ≥ 3 かつ var30 > 0 → √(var30 / 30)（interp）/ T1 < 3 → σ2（m2）。
 *    var30 = ((T2 − 30)·σ1²·T1 + (30 − T1)·σ2²·T2) / (T2 − T1)。CASE の順（T1 ≥ 30 で σ1 が無ければ無し。次を見ない）
 *
 * 純関数（現在時刻を使わない。at は引数）。
 */

/** 気配の片側（板の JSON の ChainSide の一部。値の無いものは null） */
export interface CmSide {
  /** 円 */
  bid: number | null;
  ask: number | null;
  /** % */
  bid_iv: number | null;
  ask_iv: number | null;
  is_atm?: boolean | null;
}

export interface CmMonth {
  /** 取引最終日（YYYY-MM-DD） */
  lastTradingDay: string;
  /** 行使価格の昇順（板の JSON の約束） */
  rows: ReadonlyArray<{ k: number; call: CmSide; put: CmSide }>;
}

export interface CmMonthResult {
  lastTradingDay: string;
  /** SQ までの暦日（小数） */
  days: number;
  /** フォワード（円）。無ければ null */
  forward: number | null;
  /** その限月の ATM IV（%）。無ければ null */
  iv: number | null;
}

export type CmMethod = 'm1' | 'interp' | 'm2';

export interface ConstantMaturityIv {
  /** 30 日固定の ATM IV（%） */
  iv30: number;
  method: CmMethod;
  m1: CmMonthResult;
  m2: CmMonthResult | null;
}

/** 定数（optionchan の README「30 日固定の ATM IV」と同じ） */
export const CM_SPREAD_RATIO = 0.3;
export const CM_FORWARD_STRIKES = 5;
export const CM_FORWARD_MIN = 3;
export const CM_SMILE_STRIKES = 9;
export const CM_TARGET_DAYS = 30;
export const CM_M2_DAYS = 3;
/** SQ を探す日数（最終取引日の翌日から） */
export const CM_SQ_SEARCH_DAYS = 15;

const DAY_MS = 86_400_000;

function ok(s: CmSide): boolean {
  const { bid, ask } = s;
  return (
    bid !== null &&
    ask !== null &&
    bid > 0 &&
    ask >= bid &&
    (ask - bid) * 2 <= CM_SPREAD_RATIO * (ask + bid)
  );
}

const midOf = (s: CmSide): number | null =>
  ok(s) ? ((s.bid as number) + (s.ask as number)) / 2 : null;

function midIvOf(s: CmSide): number | null {
  if (!ok(s)) return null;
  const { bid_iv: b, ask_iv: a } = s;
  return b !== null && a !== null && b > 0 && a > 0 ? (b + a) / 2 : null;
}

/** YYYY-MM-DD → UTC の 0 時の UNIX ミリ秒（壊れていれば NaN） */
function dateMs(d: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : Number.NaN;
}

/** 最終取引日の次の営業日の 09:00 JST（UNIX ミリ秒）。15 日以内に無ければ null */
export function cmSqTime(
  lastTradingDay: string,
  nonTradingDays: ReadonlySet<string>,
): number | null {
  const base = dateMs(lastTradingDay);
  if (!Number.isFinite(base)) return null;
  for (let i = 1; i <= CM_SQ_SEARCH_DAYS; i++) {
    const t = base + i * DAY_MS;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (nonTradingDays.has(new Date(t).toISOString().slice(0, 10))) continue;
    // 09:00 JST = 00:00 UTC
    return t;
  }
  return null;
}

/** 限月の F と ATM IV（k0 が無ければどちらも null） */
export function cmMonthIv(month: CmMonth): { forward: number | null; iv: number | null } {
  let k0: number | null = null;
  for (const r of month.rows) {
    if ((r.call.is_atm === true || r.put.is_atm === true) && (k0 === null || r.k < k0)) k0 = r.k;
  }
  if (k0 === null) return { forward: null, iv: null };
  const base = k0;
  const near = month.rows
    .map((r) => ({
      k: r.k,
      callMid: midOf(r.call),
      putMid: midOf(r.put),
      callIv: midIvOf(r.call),
      putIv: midIvOf(r.put),
    }))
    .sort((a, b) => Math.abs(a.k - base) - Math.abs(b.k - base) || a.k - b.k);

  const xs: number[] = [];
  for (const s of near.slice(0, CM_FORWARD_STRIKES)) {
    if (s.callMid !== null && s.putMid !== null) xs.push(s.callMid - s.putMid + s.k);
  }
  if (xs.length < CM_FORWARD_MIN) return { forward: null, iv: null };
  xs.sort((a, b) => a - b);
  const fwd =
    ((xs[Math.floor((xs.length - 1) / 2)] as number) + (xs[Math.floor(xs.length / 2)] as number)) /
    2;

  let lo: { k: number; s: number } | null = null;
  let hi: { k: number; s: number } | null = null;
  let any = false;
  for (const n of near.slice(0, CM_SMILE_STRIKES)) {
    const s =
      n.callIv !== null && n.putIv !== null ? (n.callIv + n.putIv) / 2 : (n.callIv ?? n.putIv);
    if (s === null) continue;
    any = true;
    if (n.k <= fwd) {
      if (!lo || n.k > lo.k) lo = { k: n.k, s };
    } else if (!hi || n.k < hi.k) hi = { k: n.k, s };
  }
  // s のある K が無ければ SQL の cm_bracket の行が無い = F も出ない
  if (!any) return { forward: null, iv: null };
  if (!lo || !hi) return { forward: fwd, iv: null };
  return {
    forward: fwd,
    iv: lo.s + ((hi.s - lo.s) * Math.log(fwd / lo.k)) / Math.log(hi.k / lo.k),
  };
}

/**
 * 今の板の iv30（at = スナップショットの UNIX ミリ秒）。1 限月が無い・値が出ないときは null。
 */
export function constantMaturityIv(
  at: number,
  months: readonly CmMonth[],
  nonTradingDays: ReadonlySet<string>,
): ConstantMaturityIv | null {
  if (!Number.isFinite(at)) return null;
  const ranked: CmMonthResult[] = [];
  for (const m of months) {
    const sq = cmSqTime(m.lastTradingDay, nonTradingDays);
    if (sq === null || !(sq > at)) continue;
    const { forward, iv } = cmMonthIv(m);
    // TIMESTAMP_DIFF(sq_at, created_at, SECOND) / 86400（秒は切り捨て）
    ranked.push({
      lastTradingDay: m.lastTradingDay,
      days: Math.floor((sq - at) / 1000) / 86400,
      forward,
      iv,
    });
  }
  ranked.sort((a, b) =>
    a.lastTradingDay < b.lastTradingDay ? -1 : a.lastTradingDay > b.lastTradingDay ? 1 : 0,
  );
  const m1 = ranked[0];
  if (!m1) return null;
  const m2 = ranked[1] ?? null;
  const t1 = m1.days;
  if (t1 >= CM_TARGET_DAYS) {
    return m1.iv === null ? null : { iv30: m1.iv, method: 'm1', m1, m2 };
  }
  if (t1 >= CM_M2_DAYS) {
    if (!m2 || m1.iv === null || m2.iv === null || m2.days === t1) return null;
    const s1 = m1.iv;
    const s2 = m2.iv;
    const t2 = m2.days;
    const var30 =
      ((t2 - CM_TARGET_DAYS) * s1 * s1 * t1 + (CM_TARGET_DAYS - t1) * s2 * s2 * t2) / (t2 - t1);
    return var30 > 0 ? { iv30: Math.sqrt(var30 / CM_TARGET_DAYS), method: 'interp', m1, m2 } : null;
  }
  return m2 && m2.iv !== null ? { iv30: m2.iv, method: 'm2', m1, m2 } : null;
}

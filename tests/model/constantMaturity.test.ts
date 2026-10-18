import { describe, expect, it } from 'vitest';
import {
  type CmMonth,
  type CmSide,
  cmMonthIv,
  cmSqTime,
  constantMaturityIv,
} from '../../model/constantMaturity';
import { rng, sviTotalVariance } from '../support/synthChain';
import { synthCmMonth } from '../support/synthIv';

/**
 * #79 段 C（AC7）: 今の板の 30 日固定の ATM IV（model/constantMaturity.ts）。
 *
 * 式の出典 = optionchan `sql/cm/atm_cm.sql` の `-- cm:begin`〜`-- cm:end`（api/contract/optionchan_commit.txt の固定コミット）:
 *   ok = bid > 0 AND ask >= bid AND (ask - bid) * 2 <= 0.3 * (ask + bid)
 *   mid IV = (bid_iv + ask_iv) / 2（ok かつ bid_iv > 0 かつ ask_iv > 0）
 *   k0 = MIN(target_price) WHERE is_atm、rn = ROW_NUMBER() OVER (ORDER BY ABS(k - k0), k)
 *   F = 中央値(C_mid − P_mid + K | rn ≤ 5、両方あり)、3 本以上
 *   s(K) = rn ≤ 9 で (call_iv + put_iv) / 2（片方ならその値）
 *   iv = s_lo + (s_hi − s_lo) · LN(F / K_lo) / LN(K_hi / K_lo)
 *   days = TIMESTAMP_DIFF(sq_at, created_at, SECOND) / 86400、sq_at = 最終取引日の次の営業日の 09:00 JST
 *   var30 = ((T2 − 30)·σ1²·T1 + (30 − T1)·σ2²·T2) / (T2 − T1)
 *   iv30 = CASE WHEN T1 ≥ 30 THEN σ1 WHEN T1 ≥ 3 AND var30 > 0 THEN SQRT(var30 / 30) WHEN T1 < 3 THEN σ2 END
 * 文献値は無い（optionchan の定義の再現）。期待値は上の式から手で計算する。値はすべて架空。
 */

const NONE: ReadonlySet<string> = new Set();
const utc = (iso: string) => Date.parse(iso);

const iv30Of = (d1: number, s1: number, d2: number, s2: number) =>
  Math.sqrt(((d2 - 30) * s1 * s1 * d1 + (30 - d1) * s2 * s2 * d2) / (d2 - d1) / 30);
const logInterp = (f: number, sLo: number, sHi: number, kLo: number, kHi: number) =>
  sLo + ((sHi - sLo) * Math.log(f / kLo)) / Math.log(kHi / kLo);

// ---- optionchan の tests/test_cm_bq.py と同じ固定値の入力（架空。同じ定義の 2 つの実装を同じ入力でそろえる）
const M1 = '2026-11-12'; // SQ 11-13（金）09:00 JST
const M2 = '2026-12-10'; // SQ 12-11（金）09:00 JST
const T0 = utc('2026-10-20T00:00:00Z'); // 10-20 09:00 JST: SQ まで 24 日・52 日
const STRIKES = Array.from({ length: 8 }, (_, i) => 58500 + i * 500);
const ATM = 60000;
const smile1 = (k: number) => 20 + (k - ATM) / 500;
const smile2 = (k: number) => 22 + (k - ATM) / 500;

/** 1 限月分: C − P + K = fwd（put の中値 1000）、mid IV = ivAt(K)、スプレッドは中値の ±10 円・±0.5 */
function monthRows(
  ltd: string,
  fwd: number,
  ivAt: (k: number) => number,
  opt: { badPut?: number; edit?: (k: number, type: 'call' | 'put', s: CmSide) => CmSide } = {},
): CmMonth {
  const side = (k: number, type: 'call' | 'put', mid: number): CmSide => {
    let s: CmSide = {
      bid: mid - 10,
      ask: mid + 10,
      bid_iv: ivAt(k) - 0.5,
      ask_iv: ivAt(k) + 0.5,
      is_atm: k === ATM,
    };
    if (type === 'put' && k === opt.badPut) s = { ...s, bid: 1, bid_iv: 1 };
    return opt.edit ? opt.edit(k, type, s) : s;
  };
  return {
    lastTradingDay: ltd,
    rows: STRIKES.map((k) => ({
      k,
      call: side(k, 'call', 1000 + fwd - k),
      put: side(k, 'put', 1000),
    })),
  };
}

describe('AC7: optionchan の固定値の入力（test_cm_bq.py と同じ）', () => {
  it('F は C − P + K の中央値、log(K/F) の補間、24 日・52 日の総分散の補間（interp）', () => {
    const r = constantMaturityIv(
      T0,
      [monthRows(M1, 60200, smile1, { badPut: ATM }), monthRows(M2, 60300, smile2)],
      NONE,
    );
    const s1 = logInterp(60200, smile1(60000), smile1(60500), 60000, 60500);
    const s2 = logInterp(60300, smile2(60000), smile2(60500), 60000, 60500);
    expect(r?.method).toBe('interp');
    expect([r?.m1.lastTradingDay, r?.m2?.lastTradingDay]).toEqual([M1, M2]);
    expect([r?.m1.days, r?.m2?.days]).toEqual([24, 52]);
    expect([r?.m1.forward, r?.m2?.forward]).toEqual([60200, 60300]);
    expect(r?.m1.iv).toBeCloseTo(s1, 9);
    expect(r?.m2?.iv).toBeCloseTo(s2, 9);
    expect(r?.iv30).toBeCloseTo(iv30Of(24, s1, 52, s2), 9);
  });

  it('スプレッドの条件: 60000 の put の極端な気配（bid 1）は使わない（使わなければ IV は同じ）', () => {
    const clean = constantMaturityIv(
      T0,
      [monthRows(M1, 60200, smile1), monthRows(M2, 60300, smile2)],
      NONE,
    );
    const dirty = constantMaturityIv(
      T0,
      [monthRows(M1, 60200, smile1, { badPut: ATM }), monthRows(M2, 60300, smile2)],
      NONE,
    );
    expect(dirty?.m1.iv).toBeCloseTo(clean?.m1.iv as number, 12);
  });

  it('SQ まで 30 日以上は 1 限月の IV（m1。31 日）', () => {
    const at = utc('2026-10-13T00:00:00Z');
    const r = constantMaturityIv(
      at,
      [monthRows(M1, 60200, smile1), monthRows(M2, 60300, smile2)],
      NONE,
    );
    expect(r?.m1.days).toBe(31);
    expect(r?.method).toBe('m1');
    expect(r?.iv30).toBe(r?.m1.iv);
  });

  it('SQ まで 3 日未満は 2 限月の IV（m2。2 日）。11-13 が休業日なら SQ は 11-16（月）で 5 日 → interp', () => {
    const at = utc('2026-11-11T00:00:00Z');
    const months = [monthRows(M1, 60200, smile1), monthRows(M2, 60300, smile2)];
    const r = constantMaturityIv(at, months, NONE);
    expect(r?.m1.days).toBe(2);
    expect(r?.method).toBe('m2');
    expect(r?.iv30).toBe(r?.m2?.iv);
    const h = constantMaturityIv(at, months, new Set(['2026-11-13']));
    expect(h?.m1.days).toBe(5);
    expect(h?.method).toBe('interp');
  });

  it('1 限月の call に気配が無い → F が出ない → 1 限月の IV・iv30 は null（2 限月だけにはしない）', () => {
    const m1 = monthRows(M1, 60200, smile1, {
      edit: (_k, type, s) => (type === 'call' ? { ...s, bid: 0 } : s),
    });
    const m2 = monthRows(M2, 60300, smile2);
    expect(cmMonthIv(m1)).toEqual({ forward: null, iv: null });
    expect(cmMonthIv(m2).iv).not.toBeNull();
    expect(constantMaturityIv(T0, [m1, m2], NONE)).toBeNull();
  });

  it('F より上に IV のある行使価格が無い → 補間しない（F は出る・IV は null）', () => {
    const m1 = monthRows(M1, 60200, smile1, {
      edit: (k, _type, s) => (k > 60200 ? { ...s, bid_iv: 0 } : s),
    });
    expect(cmMonthIv(m1)).toEqual({ forward: 60200, iv: null });
    expect(constantMaturityIv(T0, [m1, monthRows(M2, 60300, smile2)], NONE)).toBeNull();
  });

  it('SQ を過ぎた限月（10-08 限。SQ 10-09 09:00）は数えない: 10-09 17:00 JST の 1 限月は 11 月限', () => {
    const at = utc('2026-10-09T08:00:00Z');
    const r = constantMaturityIv(
      at,
      [
        monthRows('2026-10-08', 60100, smile1),
        monthRows(M1, 60200, smile1),
        monthRows(M2, 60300, smile2),
      ],
      NONE,
    );
    expect([r?.m1.lastTradingDay, r?.m2?.lastTradingDay]).toEqual([M1, M2]);
  });

  it('1 限月に ATM の印が無くても数える（2 限月を繰り上げない）→ iv30 は null', () => {
    const m1 = monthRows(M1, 60200, smile1, { edit: (_k, _t, s) => ({ ...s, is_atm: false }) });
    expect(cmMonthIv(m1)).toEqual({ forward: null, iv: null });
    expect(constantMaturityIv(T0, [m1, monthRows(M2, 60300, smile2)], NONE)).toBeNull();
  });
});

describe('AC7: 定義の細部（手計算）', () => {
  const flat = (iv: number): CmSide => ({
    bid: 100,
    ask: 110,
    bid_iv: iv - 0.5,
    ask_iv: iv + 0.5,
    is_atm: false,
  });
  const row = (k: number, call: Partial<CmSide>, put: Partial<CmSide> = {}) => ({
    k,
    call: { ...flat(20), ...call },
    put: { ...flat(20), ...put },
  });

  it('F の中央値は偶数個なら中央 2 つの平均。順位 6 以下の行使価格は F に使わない', () => {
    // k0 = 1000。順位: 1000, 990, 1010, 980, 1020（ここまで 5 本）, 970。C − P + K = K + d（put の中値 200）
    const cp = (k: number, d: number, put: Partial<CmSide> = {}) =>
      row(k, { bid: 195 + d, ask: 205 + d, is_atm: k === 1000 }, { bid: 195, ask: 205, ...put });
    const m: CmMonth = {
      lastTradingDay: M1,
      rows: [
        cp(970, 500),
        cp(980, 20),
        cp(990, 0),
        cp(1000, 4),
        cp(1010, -8),
        // 1020 は put の bid が無い（F に使えない）
        cp(1020, 2, { bid: null }),
      ],
    };
    // 使える 4 本: 980 → 1000、990 → 990、1000 → 1004、1010 → 1002 → 中央 2 つ（1000, 1002）の平均
    expect(cmMonthIv(m).forward).toBe(1001);
  });

  it('k0 は印の最小、同じ距離は行使価格の小さい方から数える（順位 9 まで）', () => {
    // 印は 1000 と 1010（小さい方 1000）。F = 1000 + 5 = 1005 → lo 1000・hi 1010
    const rows = Array.from({ length: 21 }, (_, i) => {
      const k = 900 + i * 10;
      return row(
        k,
        {
          bid: 300 - 5,
          ask: 300 + 5,
          bid_iv: 10 + i - 0.5,
          ask_iv: 10 + i + 0.5,
          is_atm: k === 1010,
        },
        {
          bid: 295 - 5,
          ask: 295 + 5,
          bid_iv: 10 + i - 0.5,
          ask_iv: 10 + i + 0.5,
          is_atm: k === 1000,
        },
      );
    });
    const r = cmMonthIv({ lastTradingDay: M1, rows });
    expect(r.forward).toBe(1005);
    // s(1000) = 20、s(1010) = 21
    expect(r.iv).toBeCloseTo(logInterp(1005, 20, 21, 1000, 1010), 12);
    // 順位 9 まで = 960〜1040（同じ距離の 960 が 8 位・1040 が 9 位）。F を 1045 に動かすと F より上に IV のある K が無い
    const far = rows.map((r0) => ({
      ...r0,
      call: { ...r0.call, bid: 340 - 5, ask: 340 + 5 },
    }));
    const r2 = cmMonthIv({ lastTradingDay: M1, rows: far });
    expect(r2.forward).toBe(1045);
    expect(r2.iv).toBeNull();
  });

  it('s(K) は call・put の mid IV の平均（片方だけならその値）', () => {
    // call の中値 110・put の中値 105 → C − P + K = K + 5
    const c = (o: Partial<CmSide> = {}) => ({ bid: 105, ask: 115, ...o });
    const rows = [
      row(990, c({ bid_iv: 18, ask_iv: 20 }), { bid_iv: 22, ask_iv: 24 }),
      row(1000, c({ is_atm: true, bid_iv: 0 }), { bid_iv: 25, ask_iv: 27 }),
      row(1010, c({ bid_iv: 30, ask_iv: 32 }), { bid: 0 }),
      row(1020, c()),
    ];
    // F = 中央値(995, 1005, 1025) = 1005（1010 は put に気配が無い）。s(1000) = 26（put だけ）、s(1010) = 31（call だけ）
    const r = cmMonthIv({ lastTradingDay: M1, rows });
    expect(r.forward).toBe(1005);
    expect(r.iv).toBeCloseTo(logInterp(1005, 26, 31, 1000, 1010), 12);
  });

  it('SQ は最終取引日の次の営業日（土日・休業日を飛ばす）の 09:00 JST、15 日以内に無ければその限月は数えない', () => {
    expect(cmSqTime('2026-11-12', NONE)).toBe(utc('2026-11-13T00:00:00Z'));
    // 金曜 → 月曜
    expect(cmSqTime('2026-11-13', NONE)).toBe(utc('2026-11-16T00:00:00Z'));
    expect(cmSqTime('2026-11-12', new Set(['2026-11-13', '2026-11-16']))).toBe(
      utc('2026-11-17T00:00:00Z'),
    );
    const all = new Set(
      Array.from({ length: 16 }, (_, i) =>
        new Date(utc('2026-11-13T00:00:00Z') + i * 86400000).toISOString().slice(0, 10),
      ),
    );
    expect(cmSqTime('2026-11-12', all)).toBeNull();
    expect(cmSqTime('2026/11/12', NONE)).toBeNull();
    const r = constantMaturityIv(
      T0,
      [
        monthRows(M1, 60200, smile1),
        monthRows(M2, 60300, smile2),
        monthRows('2027-01-14', 60400, smile2),
      ],
      all,
    );
    // 1 限月が数えられない → 12 月限・1 月限が 1・2 限月
    expect([r?.m1.lastTradingDay, r?.m2?.lastTradingDay]).toEqual([M2, '2027-01-14']);
  });

  it('days は秒に切り捨ててから 86400 で割る（ミリ秒は使わない）', () => {
    const at = utc('2026-10-20T00:00:00Z') + 999;
    const r = constantMaturityIv(
      at,
      [monthRows(M1, 60200, smile1), monthRows(M2, 60300, smile2)],
      NONE,
    );
    expect(r?.m1.days).toBe((24 * 86400 - 1) / 86400);
  });

  it('T1 ≥ 30 で σ1 が無ければ null（次の分岐へ落ちない）。interp で 2 限月が無ければ null。限月が無ければ null', () => {
    const at = utc('2026-10-13T00:00:00Z');
    const noAtm = monthRows(M1, 60200, smile1, { edit: (_k, _t, s) => ({ ...s, is_atm: false }) });
    expect(constantMaturityIv(at, [noAtm, monthRows(M2, 60300, smile2)], NONE)).toBeNull();
    expect(constantMaturityIv(T0, [monthRows(M1, 60200, smile1)], NONE)).toBeNull();
    expect(constantMaturityIv(T0, [], NONE)).toBeNull();
    expect(constantMaturityIv(Number.NaN, [monthRows(M1, 60200, smile1)], NONE)).toBeNull();
    // m2 で 2 限月の IV が無ければ null
    const late = utc('2026-11-11T00:00:00Z');
    const m2NoAtm = monthRows(M2, 60300, smile2, {
      edit: (_k, _t, s) => ({ ...s, is_atm: false }),
    });
    expect(constantMaturityIv(late, [monthRows(M1, 60200, smile1), m2NoAtm], NONE)).toBeNull();
  });
});

describe('AC7: 性質（200 ケース）', () => {
  /** 全行使価格で mid IV = sigma の限月（F は 60000） */
  const flatMonth = (ltd: string, sigma: number): CmMonth => monthRows(ltd, 60000, () => sigma);
  const SQ1 = utc('2026-11-13T00:00:00Z');
  const SQ2 = utc('2026-12-11T00:00:00Z');
  const r = rng(79);
  const cases = Array.from({ length: 200 }, () => ({
    s1: 10 + r() * 40,
    s2: 10 + r() * 40,
    // T1 ∈ [3, 30)（T2 = T1 + 28）
    t1: 3 + r() * 27,
  }));

  it('補間の iv30 は σ1 と σ2 の間、同じ σ なら σ、σ を c 倍すると iv30 も c 倍', () => {
    for (const { s1, s2, t1 } of cases) {
      const at = SQ1 - Math.round(t1 * 86400) * 1000;
      const v = constantMaturityIv(at, [flatMonth(M1, s1), flatMonth(M2, s2)], NONE);
      expect(v?.method).toBe('interp');
      const iv = v?.iv30 as number;
      expect(iv).toBeGreaterThanOrEqual(Math.min(s1, s2) - 1e-9);
      expect(iv).toBeLessThanOrEqual(Math.max(s1, s2) + 1e-9);
      const same = constantMaturityIv(at, [flatMonth(M1, s1), flatMonth(M2, s1)], NONE);
      expect(same?.iv30).toBeCloseTo(s1, 9);
      const scaled = constantMaturityIv(
        at,
        [flatMonth(M1, s1 * 1.5), flatMonth(M2, s2 * 1.5)],
        NONE,
      );
      expect(scaled?.iv30).toBeCloseTo(iv * 1.5, 9);
    }
  });

  it('境目で連続: T1 = 30 ちょうどで σ1（m1）、30 日の 1 秒前の補間は σ1 に近い。T1 = 3 の補間と 3 日の 1 秒後の m2 の差は総分散の式どおり', () => {
    for (const { s1, s2 } of cases.slice(0, 50)) {
      const months = [flatMonth(M1, s1), flatMonth(M2, s2)];
      const at30 = SQ1 - 30 * 86400_000;
      const a = constantMaturityIv(at30, months, NONE);
      expect(a?.method).toBe('m1');
      expect(a?.iv30).toBeCloseTo(s1, 9);
      const b = constantMaturityIv(at30 + 1000, months, NONE);
      expect(b?.method).toBe('interp');
      expect(Math.abs((b?.iv30 as number) - s1)).toBeLessThan(1e-3);
      // T1 = 3 は補間（σ2 寄り）、3 日未満は σ2
      const t2 = (SQ2 - (SQ1 - 3 * 86400_000)) / 86400_000;
      const c = constantMaturityIv(SQ1 - 3 * 86400_000, months, NONE);
      expect(c?.method).toBe('interp');
      expect(c?.iv30).toBeCloseTo(iv30Of(3, s1, t2, s2), 9);
      const d = constantMaturityIv(SQ1 - 3 * 86400_000 + 1000, months, NONE);
      expect(d?.method).toBe('m2');
      expect(d?.iv30).toBe(s2);
    }
  });
});

describe('AC7: Black-76 の合成の板からの回復（r = 0、架空の値）', () => {
  const SQ1 = utc('2026-11-13T00:00:00Z');
  const SQ2 = utc('2026-12-11T00:00:00Z');
  const F1 = 41235;
  const F2 = 41310;

  /** at のときの 2 限月の板と、手計算の期待値（F は真の F、s は真の IV の %、lo・hi は F をはさむ行使価格） */
  function build(at: number, atm1 = 0.22, atm2 = 0.24) {
    const d1 = (SQ1 - at) / 86400_000;
    const d2 = (SQ2 - at) / 86400_000;
    const a = synthCmMonth({ lastTradingDay: M1, F: F1, days: d1, atmVol: atm1 });
    const b = synthCmMonth({ lastTradingDay: M2, F: F2, days: d2, atmVol: atm2 });
    const expectIv = (m: typeof a, F: number) => {
      const ks = m.month.rows.map((r) => r.k);
      const lo = Math.max(...ks.filter((k) => k <= F));
      const hi = Math.min(...ks.filter((k) => k > F));
      const v = (k: number) => (m.trueVol.get(k) as number) * 100;
      return logInterp(F, v(lo), v(hi), lo, hi);
    };
    // 真の ATM IV（SVI の x = 0）
    const trueAtm = (m: typeof a, d: number) =>
      Math.sqrt(sviTotalVariance(m.svi, 0) / (d / 365)) * 100;
    return {
      months: [a.month, b.month],
      d1,
      d2,
      s1: expectIv(a, F1),
      s2: expectIv(b, F2),
      atm1: trueAtm(a, d1),
      atm2: trueAtm(b, d2),
    };
  }

  it('T1 = 35 日: m1（F と log 補間の IV を 1e-9 で回復）', () => {
    const at = SQ1 - 35 * 86400_000;
    const c = build(at);
    const r = constantMaturityIv(at, c.months, NONE);
    expect(r?.method).toBe('m1');
    expect(r?.m1.forward).toBeCloseTo(F1, 6);
    expect(r?.m2?.forward).toBeCloseTo(F2, 6);
    expect(r?.iv30).toBeCloseTo(c.s1, 9);
    // 真の ATM IV に近い（行使価格 125 円刻みの補間の誤差だけ）
    expect(Math.abs((r?.iv30 as number) - c.atm1)).toBeLessThan(0.05);
  });

  it('T1 = 12 日: interp（総分散の補間を 1e-9 で回復）', () => {
    const at = SQ1 - 12 * 86400_000;
    const c = build(at);
    const r = constantMaturityIv(at, c.months, NONE);
    expect(r?.method).toBe('interp');
    expect([r?.m1.days, r?.m2?.days]).toEqual([12, 40]);
    expect(r?.m1.iv).toBeCloseTo(c.s1, 9);
    expect(r?.m2?.iv).toBeCloseTo(c.s2, 9);
    expect(r?.iv30).toBeCloseTo(iv30Of(12, c.s1, 40, c.s2), 9);
    expect(Math.abs((r?.iv30 as number) - iv30Of(12, c.atm1, 40, c.atm2))).toBeLessThan(0.05);
  });

  it('T1 = 1.5 日: m2（2 限月の IV を 1e-9 で回復）', () => {
    const at = SQ1 - 1.5 * 86400_000;
    const c = build(at);
    const r = constantMaturityIv(at, c.months, NONE);
    expect(r?.method).toBe('m2');
    expect(r?.m1.days).toBe(1.5);
    expect(r?.iv30).toBeCloseTo(c.s2, 9);
  });

  it('使える気配が無い・F に使える行使価格が 2 本だけ・F をはさむ 2 本が無い・印が無いときは null', () => {
    const at = SQ1 - 35 * 86400_000;
    const c = build(at);
    const [m1, m2] = c.months as [CmMonth, CmMonth];
    const atmK = m1.rows.find((r) => r.call.is_atm)?.k as number;
    const near = [...m1.rows].sort(
      (a, b) => Math.abs(a.k - atmK) - Math.abs(b.k - atmK) || a.k - b.k,
    );
    // 使える気配が無い（スプレッドが中値の 30% を超える）
    const wide: CmMonth = {
      ...m1,
      rows: m1.rows.map((r) => ({ ...r, call: { ...r.call, bid: 1 }, put: { ...r.put, bid: 1 } })),
    };
    expect(constantMaturityIv(at, [wide, m2], NONE)).toBeNull();
    // 近い 5 本のうち 3 本の put を消す → F に使えるのは 2 本
    const drop = new Set(near.slice(0, 3).map((r) => r.k));
    const two: CmMonth = {
      ...m1,
      rows: m1.rows.map((r) =>
        drop.has(r.k) ? { ...r, put: { ...r.put, bid: null, ask: null } } : r,
      ),
    };
    expect(cmMonthIv(two).forward).toBeNull();
    expect(constantMaturityIv(at, [two, m2], NONE)).toBeNull();
    // F より下の IV を消す → lo が無い
    const noLo: CmMonth = {
      ...m1,
      rows: m1.rows.map((r) =>
        r.k <= F1
          ? { ...r, call: { ...r.call, bid_iv: null }, put: { ...r.put, bid_iv: null } }
          : r,
      ),
    };
    expect(cmMonthIv(noLo).iv).toBeNull();
    expect(constantMaturityIv(at, [noLo, m2], NONE)).toBeNull();
    // 印が無い
    const noMark: CmMonth = {
      ...m1,
      rows: m1.rows.map((r) => ({
        ...r,
        call: { ...r.call, is_atm: null },
        put: { ...r.put, is_atm: false },
      })),
    };
    expect(constantMaturityIv(at, [noMark, m2], NONE)).toBeNull();
  });
});

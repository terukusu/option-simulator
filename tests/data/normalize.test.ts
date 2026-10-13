import { describe, expect, it } from 'vitest';
import type { ChainJson } from '../../data/chainJson';
import { axisOrigin, normalizeChain } from '../../data/normalize';
import { findAtm } from '../../model/atm';
import { impliedVol } from '../../model/iv';
import { DAY_MS } from '../../model/time';
import { buildChainJson, SPECS } from '../../scripts/synthBoard';
import { fixture } from '../support/fixtures';

const spec = (name: string) => {
  const s = SPECS.find((x) => x.name === name);
  if (!s) throw new Error(name);
  return s;
};

describe('正規化（合成の固定 JSON）', () => {
  const chain = normalizeChain(fixture('latest'));
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が 2 本ない');

  it('時刻・限月・先物（限月ずれ）', () => {
    expect(chain.snapshotAt).toBe(Date.parse('2026-10-13T21:31:00+09:00'));
    expect(chain.evalTime).toBe(chain.snapshotAt);
    expect(chain.reason).toBe('latest');
    expect(chain.source).toBe('synthetic');
    expect(chain.months.map((m) => m.id)).toEqual(['2026-11', '2026-12']);
    expect(chain.future.id).toBe('2026-12');
    expect(m1.sameMonthAsFuture).toBe(false);
    expect(m2.sameMonthAsFuture).toBe(true);
    // T = SQ 日 9:00 までの暦日（1 限月 30.5 日弱）
    expect((m1.T * 365 * DAY_MS) / DAY_MS).toBeCloseTo(30.479, 2);
    expect(m1.sqTime).toBe(Date.parse('2026-11-13T09:00:00+09:00'));
    expect(chain.future.sqTime).toBe(Date.parse('2026-12-11T09:00:00+09:00'));
  });

  it('限月ごとの F（PCP 合成先物）を生成時の F* から ±10 円で回復', () => {
    const truth = spec('latest').months.map((m) => m.F);
    chain.months.forEach((m, i) => {
      expect(m.syntheticOk).toBe(true);
      expect(Math.abs(m.F - (truth[i] as number))).toBeLessThanOrEqual(10);
    });
  });

  it('model/ の形の板: 約定価格は Quote.last、元の行も残す', () => {
    const i = m1.source.findIndex((r) => r.call.price !== null);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(m1.rows[i]?.call.last).toBe(m1.source[i]?.call.price);
    expect(m1.rows.length).toBe(m1.strikes.length);
  });

  describe('AC4: OTM 側 ATM ±10% は補間なし、欠損行に補間の印、補間後の単調性・バタフライ', () => {
    it.each([0, 1])('限月 %i: 気配のある OTM 側の行は節点で、IV = mid の IV', (mi) => {
      const m = chain.months[mi];
      if (!m) throw new Error();
      let n = 0;
      m.strikes.forEach((s, i) => {
        if (Math.abs(s.k / m.F - 1) > 0.1) return;
        const side = s[s.otmType];
        if (side.quote !== 'two_sided') return;
        n += 1;
        expect(s.mark).toBe('node');
        expect(s.unstable).toBe(false);
        const q = m.rows[i]?.[s.otmType];
        const iv = impliedVol(s.otmType, side.mid as number, m.F, s.k, m.T, chain.r);
        expect(iv.ok && Math.abs(iv.sigma - (s.smileIv as number))).toBeLessThan(1e-12);
        expect(q?.bid).not.toBeNull();
      });
      expect(n).toBeGreaterThan(80);
    });

    it('気配の無い行は「補間」の印（ATM ±10% の中の欠損行を含む）で、IV は有限', () => {
      const missing = m1.strikes.filter((s) => s.call.quote === 'none' && s.put.quote === 'none');
      expect(missing.length).toBeGreaterThanOrEqual(2);
      expect(missing.some((s) => Math.abs(s.k / m1.F - 1) <= 0.1)).toBe(true);
      for (const s of missing) {
        expect(s.mark).toBe('interpolated');
        expect(s.node).toBeNull();
        expect(Number.isFinite(s.smileIv)).toBe(true);
      }
    });

    it('JPX の IV が欠けた行は印が付くが、IV は価格から求めるので節点のまま', () => {
      const missing = m1.strikes.filter((s) => s[s.otmType].jpxIvMissing);
      expect(missing.length).toBe(2);
      for (const s of missing) expect(s.mark).toBe('node');
    });

    it('補間後の裁定の印: 1 限月は無し。2 限月は片側気配が混じる翼（ATM ±20% の外）だけ', () => {
      expect(m1.violations).toEqual([]);
      expect(m2.violations.length).toBeGreaterThan(0);
      for (const v of m2.violations) expect(Math.abs(v.k / m2.F - 1)).toBeGreaterThan(0.2);
      for (const v of m2.violations) {
        expect(m2.strikes.find((s) => s.k === v.k)?.arbitrage).toBe(true);
      }
    });
  });

  describe('AC16: IV 不安定・外挿の印', () => {
    it.each(['latest', 'pre_open'] as const)(
      '%s: 帯 > 5pt または ask ≤ 5 円の行だけが不安定',
      (name) => {
        const c = normalizeChain(fixture(name));
        let unstable = 0;
        for (const m of c.months) {
          m.strikes.forEach((s, i) => {
            if (!s.node) return;
            const ask = m.rows[i]?.[s.otmType].ask ?? null;
            const expected =
              s.node.bandWidth === null || s.node.bandWidth > 0.05 || (ask !== null && ask <= 5);
            expect(s.unstable).toBe(expected);
            if (s.unstable) {
              unstable += 1;
              // 不安定な行は節点から外す（補間か外挿の値になる）
              expect(s.mark).not.toBe('node');
            }
          });
        }
        expect(unstable).toBeGreaterThan(10);
      },
    );

    it('両方の理由（ask ≤ 5 円 / 帯 > 5pt）の不安定行が固定の板にある', () => {
      const all = [...chain.months, ...normalizeChain(fixture('pre_open')).months];
      const byBand = all.flatMap((m) => m.strikes).filter((s) => (s.node?.bandWidth ?? 0) > 0.05);
      expect(byBand.length).toBeGreaterThan(0);
      for (const s of byBand) expect(s.unstable).toBe(true);
      const putWing = m1.strikes.filter((s) => s.otmType === 'put' && s.unstable);
      const callWing = m1.strikes.filter((s) => s.otmType === 'call' && s.unstable);
      expect(putWing.length).toBeGreaterThan(0);
      expect(callWing.length).toBeGreaterThan(0);
    });

    it('安定な節点の外側は「外挿」の印', () => {
      const nodes = m1.strikes.filter((s) => s.mark === 'node');
      const lo = Math.min(...nodes.map((s) => s.k));
      const hi = Math.max(...nodes.map((s) => s.k));
      const ext = m1.strikes.filter((s) => s.mark === 'extrapolated');
      expect(ext.length).toBeGreaterThan(0);
      for (const s of m1.strikes) {
        expect(s.mark === 'extrapolated').toBe(s.k < lo || s.k > hi);
        expect(Number.isFinite(s.smileIv)).toBe(true);
      }
    });
  });

  it('片側気配・気配なしの状態（ask だけの call の翼、2 限月の put の翼）', () => {
    const callAskOnly = m1.strikes.filter((s) => s.k / m1.F - 1 > 0.2);
    expect(callAskOnly.length).toBeGreaterThan(0);
    for (const s of callAskOnly) expect(s.call.quote).toBe('ask_only');
    const wing = m2.strikes.filter((s) => 1 - s.k / m2.F > 0.4);
    const states = new Set(wing.map((s) => s.put.quote));
    expect(states).toEqual(new Set(['two_sided', 'ask_only', 'none']));
  });

  it('夜間の序盤: 行が少なく、建玉は全行 null、スプレッドが広くても F は ±30 円', () => {
    const c = normalizeChain(fixture('night_early'));
    const truth = spec('night_early').months.map((m) => m.F);
    c.months.forEach((m, i) => {
      expect(m.rows.length).toBeLessThan(chain.months[i]?.rows.length ?? 0);
      expect(m.source.every((r) => r.call.positions === null && r.put.positions === null)).toBe(
        true,
      );
      expect(Math.abs(m.F - (truth[i] as number))).toBeLessThanOrEqual(30);
      const atm = m.strikes.find((s) => s.k === m.atm.B.pick?.k);
      expect((atm?.call.mid ?? 0) > 0).toBe(true);
    });
  });

  it('寄り前の API 応答（板寄せ前の最後の板）: reason = pre_open', () => {
    const c = normalizeChain(fixture('pre_open'));
    expect(c.reason).toBe('pre_open');
    expect(c.months.every((m) => m.syntheticOk)).toBe(true);
  });

  it('評価時刻と金利を変えて正規化し直せる', () => {
    const later = normalizeChain(fixture('latest'), {
      r: 0.01,
      evalTime: chain.snapshotAt + DAY_MS,
    });
    expect(later.r).toBe(0.01);
    expect(later.months[0]?.T).toBeCloseTo(m1.T - 1 / 365, 12);
  });
});

describe('壊れた板でも例外を出さない', () => {
  function blank(j: ChainJson, futurePrice: number | null): ChainJson {
    j.future.price = futurePrice;
    for (const m of j.months) {
      for (const r of m.rows) {
        for (const s of [r.call, r.put]) {
          s.bid = null;
          s.ask = null;
          s.price = null;
        }
      }
    }
    return j;
  }

  it('気配も先物も無い（夜間の寄り前の形）: F は NaN、スマイル・ATM は null', () => {
    const c = normalizeChain(blank(fixture('latest'), null));
    for (const m of c.months) {
      expect(Number.isNaN(m.F)).toBe(true);
      expect(m.syntheticOk).toBe(false);
      expect(m.smile).toBeNull();
      expect(m.atm.A.pick).toBeNull();
      expect(m.atm.B.pick).toBeNull();
      expect(m.strikes.every((s) => s.mark === null && s.smileIv === null)).toBe(true);
    }
    expect(Number.isNaN(axisOrigin(c, 'B'))).toBe(true);
  });

  it('気配が無く先物だけある: F は先物へフォールバック、B は A にフォールバック', () => {
    const c = normalizeChain(blank(fixture('latest'), 67880));
    for (const m of c.months) {
      expect(m.F).toBe(67880);
      expect(m.forward.method).toBe('future_fallback');
      expect(m.atm.B.reference.fellBack).toBe(true);
      expect(m.atm.B.pick?.k).toBe(m.atm.A.pick?.k);
      expect(m.atm.A.pick?.k).toBe(67875);
    }
  });
});

describe('ATM の基準 A / B（AC20 のうち model / data で見られる部分）', () => {
  it('基準の価格（先物）を 3 通りに変えると A だけ動き、B は限月ごとの合成先物のまま', () => {
    const base = normalizeChain(fixture('latest'));
    for (const price of [67600, 67880, 68130]) {
      const j = fixture('latest');
      j.future.price = price;
      const c = normalizeChain(j);
      c.months.forEach((m, i) => {
        const strikes = m.rows.map((r) => r.k);
        const nearest = strikes.reduce((a, b) =>
          Math.abs(b - price) < Math.abs(a - price) ? b : a,
        );
        expect(m.atm.A.reference.price).toBe(price);
        expect(m.atm.A.pick?.k).toBe(nearest);
        // F の推定は先物を窓の中心にするだけなので、B は動かない
        expect(m.atm.B.pick?.k).toBe(base.months[i]?.atm.B.pick?.k);
      });
    }
  });

  it('板の F を 3 通りに変えると B が動き、A（先物）は動かない', () => {
    const picksA = new Set<number>();
    const picksB: number[] = [];
    for (const F of [67400, 67810, 68230]) {
      const s = structuredClone(spec('latest'));
      const m0 = s.months[0];
      if (!m0) throw new Error();
      m0.F = F;
      const c = normalizeChain(buildChainJson(s));
      const m = c.months[0];
      if (!m) throw new Error();
      expect(Math.abs(m.F - F)).toBeLessThanOrEqual(10);
      expect(m.atm.B.reference.price).toBe(m.F);
      expect(m.atm.B.pick?.k).toBe(findAtm(m.rows, m.F)?.k);
      picksB.push(m.atm.B.pick?.k as number);
      picksA.add(m.atm.A.pick?.k as number);
    }
    expect(picksB).toEqual([67375, 67750, 68250]);
    expect([...picksA]).toEqual([67875]);
  });

  it('既定の板では 1 限月で A と B の ATM が食い違い、2 限月（先物と同じ限月）は一致', () => {
    const c = normalizeChain(fixture('latest'));
    expect(c.months[0]?.atm.A.pick?.k).toBe(67875);
    expect(c.months[0]?.atm.B.pick?.k).toBe(67750);
    expect(c.months[1]?.atm.A.pick?.k).toBe(c.months[1]?.atm.B.pick?.k);
    expect(axisOrigin(c, 'A')).toBe(67880);
    expect(axisOrigin(c, 'B')).toBe(c.months[0]?.F);
  });

  it('JPX の is_atm は判定に使わない（書き換えても ATM は同じ）', () => {
    const j = fixture('latest');
    for (const m of j.months) for (const r of m.rows) r.call.is_atm = r.put.is_atm = r.k === 50000;
    const c = normalizeChain(j);
    expect(c.months[0]?.atm.B.pick?.k).toBe(67750);
  });
});

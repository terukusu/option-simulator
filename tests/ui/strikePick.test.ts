import { describe, expect, it } from 'vitest';
import { type ChainMonth, normalizeChain } from '../../data';
import { initialState, reduce } from '../../ui/state';
import {
  atmOffsetK,
  atmSigma,
  defaultMonthOf,
  nearestQuoted,
  quotedStrikes,
} from '../../ui/view/strikePick';
import { fixture } from '../support/fixtures';

/**
 * #20: 板の行使価格の選び方（ui/view/strikePick.ts）。AI の提案（#139）から移した関数は aiPropose.test.ts と
 * fixtures/synthetic/ai_tools.json が守る。ここは #20 で足した関数と、一般化した既定の限月。合成の板（架空の値）。
 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months as [ChainMonth, ChainMonth];

describe('atmSigma（σ_ATM,i = ATM の行の OTM 側の節点の mid IV）', () => {
  it.each(['A', 'B'] as const)('基準 %s: ATM の行の node.midIv（小数）', (basis) => {
    for (const m of chain.months) {
      const k = m.atm[basis].pick?.k;
      const info = m.strikes.find((s) => s.k === k);
      const v = atmSigma(m, basis);
      expect(v).toBe(info?.node?.midIv);
      expect(v).toBeGreaterThan(0.05);
      expect(v).toBeLessThan(1);
    }
  });

  it('節点が無い・mid IV が無い・ATM が無いなら null（スマイルの補間値へ逃がさない）', () => {
    const k = m2.atm.B.pick?.k;
    const noNode: ChainMonth = {
      ...m2,
      strikes: m2.strikes.map((s) => (s.k === k ? { ...s, node: null } : s)),
    };
    expect(atmSigma(noNode, 'B')).toBeNull();
    const noMid: ChainMonth = {
      ...m2,
      strikes: m2.strikes.map((s) =>
        s.k === k && s.node ? { ...s, node: { ...s.node, midIv: null } } : s,
      ),
    };
    expect(atmSigma(noMid, 'B')).toBeNull();
    const noAtm: ChainMonth = { ...m2, atm: { ...m2.atm, B: { ...m2.atm.B, pick: null } } };
    expect(atmSigma(noAtm, 'B')).toBeNull();
  });
});

describe('nearestQuoted（目標に最も近い両気配の行。同じ距離は OTM の遠い方）', () => {
  it('put・below: K ≤ 上限の両気配の put で |K − 目標| が最小', () => {
    const x0 = m2.F;
    for (const level of [x0 - 1_000, x0 - 2_437, x0 - 5_000, x0 - 30_000]) {
      const k = nearestQuoted(m2, 'put', level, 'below', x0);
      const cands = quotedStrikes(m2, 'put').filter((x) => x <= x0);
      const best = Math.min(...cands.map((x) => Math.abs(x - level)));
      expect(k).not.toBeNull();
      expect(Math.abs((k as number) - level)).toBe(best);
      expect(m2.strikes.find((s) => s.k === k)?.put.quote).toBe('two_sided');
    }
  });

  it('同じ距離: put は低い K、call は高い K', () => {
    // 行の間の真ん中（両隣が同じ距離。行使価格は 125 円刻みの所で）
    const ks = quotedStrikes(m2, 'put');
    const i = ks.findIndex((x, j) => j > 0 && x - (ks[j - 1] as number) === 125 && x < m2.F);
    const lo = ks[i - 1] as number;
    const hi = ks[i] as number;
    expect(nearestQuoted(m2, 'put', (lo + hi) / 2, null)).toBe(lo);
    const cs = quotedStrikes(m2, 'call');
    const j = cs.findIndex((x, n) => n > 0 && x - (cs[n - 1] as number) === 125 && x > m2.F);
    const clo = cs[j - 1] as number;
    const chi = cs[j] as number;
    expect(nearestQuoted(m2, 'call', (clo + chi) / 2, null)).toBe(chi);
  });

  it('call・above: 上限より下は選ばない。水準が有限でなければ null', () => {
    const x0 = m2.F;
    const k = nearestQuoted(m2, 'call', x0 - 3_000, 'above', x0);
    expect(k).not.toBeNull();
    expect(k as number).toBeGreaterThanOrEqual(x0);
    expect(nearestQuoted(m2, 'call', Number.NaN, 'above', x0)).toBeNull();
    expect(nearestQuoted(m2, 'put', x0, 'below', Number.NaN)).toBeNull();
  });
});

describe('atmOffsetK（ATM から板の行で n 本）', () => {
  it('0 本 = ATM、+1 / −1 = 隣の行、範囲外・行に無い K は null', () => {
    const atm = m1.atm.B.pick?.k as number;
    const ks = m1.rows.map((r) => r.k);
    const i = ks.indexOf(atm);
    expect(atmOffsetK(m1, atm, 0)).toBe(atm);
    expect(atmOffsetK(m1, atm, 1)).toBe(ks[i + 1]);
    expect(atmOffsetK(m1, atm, -2)).toBe(ks[i - 2]);
    expect(atmOffsetK(m1, atm, 10_000)).toBeNull();
    expect(atmOffsetK(m1, atm + 1, 0)).toBeNull();
    expect(atmOffsetK(m1, null, 0)).toBeNull();
  });
});

describe('defaultMonthOf（足の最初の OP の限月 → 残存 2 日以上の最初の限月）', () => {
  it('足 0 本は残存 2 日以上の最初の限月、OP の足があればその限月', () => {
    expect(defaultMonthOf(chain, [])?.id).toBe(m1.id);
    const s = reduce(reduce(initialState, { type: 'loaded', chain, label: 'latest' }), {
      type: 'addBoardLeg',
      expiry: m2.id,
      k: m2.atm.B.pick?.k as number,
      optionType: 'call',
      side: 'sell',
    });
    expect(s.legs).toHaveLength(1);
    expect(defaultMonthOf(chain, s.legs)?.id).toBe(m2.id);
  });

  it('スマイル・F の無い限月は選ばない（全部無ければ null）', () => {
    const broken = {
      ...chain,
      months: chain.months.map((m) => ({ ...m, smile: null, F: Number.NaN })),
    };
    expect(defaultMonthOf(broken, [])).toBeNull();
    const firstBroken = {
      ...chain,
      months: chain.months.map((m, i) => (i === 0 ? { ...m, smile: null } : m)),
    };
    expect(defaultMonthOf(firstBroken, [])?.id).toBe(m2.id);
  });
});

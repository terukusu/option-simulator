import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  DEFAULT_SETTINGS,
  expiryPnl,
  type Leg,
  type ModelSettings,
  preparePosition,
  type Scenario,
  theoreticalPnl,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import {
  amountUnit,
  fmtAmount,
  fmtRatio,
  type MetricsModel,
  metricsModel,
} from '../../ui/view/metrics';
import { type PnlBase, pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { extremeBases, nonFinitePaths } from '../support/extremeScenarios';
import { fixture } from '../support/fixtures';
import { M1, M2, makeMarket } from '../support/market';

/** #6 AC-1〜AC-3・AC-6〜AC-8: 指標とテール表の表示モデル。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = (c: Chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'latest' });

function baseOfState(s: State): PnlBase {
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

function metricsOf(s: State): { base: PnlBase; m: MetricsModel } {
  const base = baseOfState(s);
  return { base, m: metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit }) };
}

const add = (
  expiry: string,
  k: number,
  optionType: 'put' | 'call',
  side: 'buy' | 'sell',
): Action => ({
  type: 'addBoardLeg',
  expiry,
  k,
  optionType,
  side,
});

describe('板から入れた直後（AC-1 = AC21）', () => {
  // 両側気配があり建値 > 割引本源的価値の足（OTM の bid 売り・ask 買い、2 限月を含む）
  const s = run(
    loaded(chain),
    add(m1.id, 64_000, 'put', 'sell'),
    add(m1.id, 71_000, 'call', 'buy'),
    add(m2.id, 62_000, 'put', 'buy'),
    add(m2.id, 73_000, 'call', 'sell'),
  );

  it('シナリオ 0・d = 0 のシナリオ点の理論損益は 0 円（|値| < 1 円）', () => {
    expect(s.legs.length).toBe(4);
    expect(s.legs.every((l) => !l.marks.includes('no_quote'))).toBe(true);
    const { base, m } = metricsOf(s);
    expect(m.empty).toBe(false);
    expect(m.scenarioPoint.x).toBe(base.ctx.x0);
    expect(Math.abs(m.scenarioPoint.pnl)).toBeLessThan(1);
    // 足はすべて建値から IV が決まる（建値ずれ 0）
    expect(base.legs.every((p) => p.option?.anchorSource === 'entry')).toBe(true);
  });

  it('スプレッドコスト（建値 − mid、不利なら正）と建値ずれは別の欄', () => {
    const { m } = metricsOf(s);
    let want = 0;
    for (const l of s.legs) {
      if (l.leg.kind !== 'option' || l.leg.mid == null) continue;
      want += (l.leg.entry - l.leg.mid) * (l.leg.side === 'buy' ? 1 : -1) * l.leg.qty * 1000;
    }
    expect(want).toBeGreaterThan(0);
    expect(m.premium.spreadCost).toBeCloseTo(want, 9);
    expect(m.premium.entryMismatch).toBeCloseTo(0, 6);
    // 建値ずれのある足（建値 ≤ 割引本源的価値 → スマイルの IV）を足すと、建値ずれだけが動く
    const deep = run(s, add(m1.id, 75_000, 'put', 'buy'), {
      type: 'editLeg',
      id: 5,
      patch: { entry: 1 },
    });
    const md = metricsOf(deep).m;
    expect(Math.abs(md.premium.entryMismatch)).toBeGreaterThan(1);
    expect(Math.abs(md.scenarioPoint.pnl)).toBeGreaterThan(1);
  });

  it('建値ずれの向き（#260）: 内訳 = 足の詳細の合計 = シナリオ 0 の理論損益（OP だけ・手数料 0）', () => {
    // 建値 1 円の深い ITM の put 買い = 理論より安く買った（有利）。スマイルの IV を使う足
    const deep = run(s, add(m1.id, 75_000, 'put', 'buy'), {
      type: 'editLeg',
      id: 5,
      patch: { entry: 1 },
    });
    // 理論より高く売った（有利）: 板の行の売り足の IV を手で下げる = 建値が理論価格より高い
    const both = run(deep, { type: 'editLeg', id: 1, patch: { iv: 0.05 } });
    for (const st of [deep, both]) {
      const { m } = metricsOf(st);
      const rows = positionModel(chain, st.legs, st.atmBasis, CALENDAR, DEFAULT_SETTINGS).rows;
      const sumRows = rows.reduce((a, r) => a + (r.mismatchYen ?? 0), 0);
      expect(m.premium.entryMismatch).toBeCloseTo(sumRows, 6);
      expect(m.premium.entryMismatch).toBeCloseTo(m.scenarioPoint.pnl, 6);
      // 有利な建値ずれ → 損益への影響は正
      expect(m.premium.entryMismatch).toBeGreaterThan(1);
    }
  });
});

describe('テール表（AC-2 = AC22）', () => {
  const s = run(
    loaded(chain),
    add(m1.id, 64_000, 'put', 'sell'),
    add(m1.id, 71_000, 'call', 'sell'),
    add(m2.id, 60_000, 'put', 'buy'),
    { type: 'setScenario', patch: { days: 4, dSigma: 3, skew: 1, beta: 1.5 } },
  );

  it('5 行 × {SQ, 指定日}。SQ = expiryPnl、指定日 = シナリオ（β 込み）の theoreticalPnl（1e-6 円）、倍率 = 損益 / 受取', () => {
    const { base, m } = metricsOf(s);
    const { tail } = m;
    expect(tail.rows.map((r) => r.shock)).toEqual([-0.05, -0.1, -0.2, -0.3, -0.4]);
    expect(tail.premiumBase.kind).toBe('received');
    expect(tail.premiumBase.amount).toBeCloseTo(m.premium.net, 9);
    for (const r of tail.rows) {
      expect(r.x).toBeCloseTo(base.ctx.x0 * (1 + r.shock), 9);
      expect(Math.abs(r.sq.pnl - expiryPnl(base.legs, r.x, base.ctx, base.settings))).toBeLessThan(
        1e-6,
      );
      const sc: Scenario = { ...s.scenario, dX: r.x - base.ctx.x0 };
      const want = theoreticalPnl(base.legs, r.x, sc, base.ctx, base.settings);
      expect(Math.abs(r.scenario.pnl - want)).toBeLessThan(1e-6);
      expect(r.sq.ratio).toBeCloseTo(r.sq.pnl / tail.premiumBase.amount, 12);
      expect(r.scenario.ratio).toBeCloseTo(r.scenario.pnl / tail.premiumBase.amount, 12);
    }
  });

  it('支払超は掛け金（支払 − 受取 + 手数料）が基準', () => {
    const buy = run(
      loaded(chain),
      add(m1.id, 66_000, 'put', 'buy'),
      add(m1.id, 63_000, 'put', 'sell'),
      { type: 'setFee', fee: 250 },
    );
    const { m } = metricsOf(buy);
    expect(m.premium.net).toBeLessThan(0);
    expect(m.tail.premiumBase).toEqual({ kind: 'paid', amount: -m.premium.net + 500 });
    expect(m.premium.stake).toBe(-m.premium.net + 500);
    for (const r of m.tail.rows) {
      expect(r.sq.ratio).toBeCloseTo(r.sq.pnl / (m.premium.stake as number), 12);
    }
  });
});

describe('急落プリセットと足別 IV（AC-3 = AC23）', () => {
  it('「−10% / +20pt / +3」で ΔX = −10% × X₀・Δσ = +20・Δs = +3（β・d・動き方は保つ）、足別 IV = σ_anchor + 20 + 10 − 3 × ln(K / F_i) / 0.1', () => {
    const before = run(
      loaded(chain),
      add(m1.id, 64_000, 'put', 'sell'),
      add(m1.id, 60_000, 'put', 'buy'),
      add(m1.id, 70_000, 'call', 'sell'),
      add(m2.id, 62_000, 'put', 'sell'),
      add(m2.id, 72_000, 'call', 'buy'),
      { type: 'setScenario', patch: { days: 2 } },
    );
    const base0 = baseOfState(before);
    const x0 = base0.ctx.x0;
    const s = reduce(before, { type: 'applyPreset', index: 0, x0 });
    expect(s.scenario.dX).toBeCloseTo(-0.1 * x0, 9);
    expect(s.scenario).toMatchObject({
      dSigma: 20,
      skew: 3,
      beta: 1,
      days: 2,
      ivDynamics: 'sticky_strike',
      ivShift: 'absolute',
    });
    const { base, m } = metricsOf(s);
    expect(m.scenarioPoint.dXPct).toBeCloseTo(-10, 9);
    base.legs.forEach((p, i) => {
      if (p.leg.kind !== 'option' || !p.option) throw new Error('OP の足だけ');
      const want = p.option.anchor + (20 + 10 - (3 * Math.log(p.leg.strike / p.F)) / 0.1) / 100;
      expect(want).toBeGreaterThan(0.01); // σ_min に当たらない
      const leg = m.scenarioPoint.legs[i];
      expect(leg?.state).toBe('live');
      // 1e-6pt = 1e-8（小数）
      expect(Math.abs((leg?.sigma as number) - want)).toBeLessThan(1e-8);
    });
    // 不正なプリセット番号・X₀ は無視
    expect(reduce(before, { type: 'applyPreset', index: 9, x0 })).toBe(before);
    expect(reduce(before, { type: 'applyPreset', index: 0, x0: Number.NaN })).toBe(before);
  });
});

describe('買いの指標（AC-6 = AC15 (b)）', () => {
  // 架空の値: 5 円の put（K 39,000）を 1 枚買い
  const s = run(loaded(chain), add(m1.id, 39_000, 'put', 'buy'), {
    type: 'editLeg',
    id: 1,
    patch: { entry: 5 },
  });

  it('単位は円、掛け金 = 5,000 円（手数料 0）、テール表の基準は掛け金、N 倍の原資産は満期損益 = N × 掛け金を 1 円で満たす', () => {
    const { base, m } = metricsOf(s);
    expect(m.unit).toBe('yen');
    expect(m.premium.paid).toBe(5_000);
    expect(m.premium.stake).toBe(5_000);
    expect(m.tail.premiumBase).toEqual({ kind: 'paid', amount: 5_000 });
    // basis = F − X₀ = 0（1 限月）なので解析解は X = 39,000 − 5 − 5N
    expect(base.ctx.x0).toBe(m1.F);
    expect(m.premium.multiples.map((v) => v.n)).toEqual([1, 5, 10]);
    for (const { n, xs } of m.premium.multiples) {
      expect(xs).toEqual([39_000 - 5 - 5 * n]);
      const x = xs[0] as number;
      // 1 円以内に解がある: 満期損益の傾きは −1,000 円 / 円
      expect(Math.abs(expiryPnl(base.legs, x, base.ctx) - n * 5_000)).toBeLessThanOrEqual(1_000);
    }
  });

  it('手数料 300 円 / 枚なら掛け金 5,300 円、N 倍の水準も手数料込み', () => {
    const { base, m } = metricsOf(reduce(s, { type: 'setFee', fee: 300 }));
    expect(m.premium.stake).toBe(5_300);
    expect(m.premium.fees).toBe(300);
    expect(m.tail.premiumBase).toEqual({ kind: 'paid', amount: 5_300 });
    for (const { n, xs } of m.premium.multiples) {
      const x = xs[0] as number;
      expect(
        Math.abs(expiryPnl(base.legs, x, base.ctx, base.settings) - n * 5_300),
      ).toBeLessThanOrEqual(500);
    }
  });

  it('受取超（売り）には掛け金と N 倍の原資産を出さない', () => {
    const sell = run(loaded(chain), add(m1.id, 47_000, 'put', 'sell'));
    const { m } = metricsOf(sell);
    expect(m.premium.stake).toBeNull();
    expect(m.premium.multiples).toEqual([]);
  });
});

describe('単位（AC-7）', () => {
  it('受け払いの合計 99,999 円は円、100,000 円は千円。固定の指定が自動より優先', () => {
    expect(amountUnit(60_000, 39_999, 'auto')).toBe('yen');
    expect(amountUnit(60_000, 40_000, 'auto')).toBe('thousand');
    expect(amountUnit(0, 100_000, 'auto')).toBe('thousand');
    expect(amountUnit(99_999, 0, 'auto')).toBe('yen');
    expect(amountUnit(1_805_000, 0, 'yen')).toBe('yen');
    expect(amountUnit(24_000, 0, 'thousand')).toBe('thousand');
  });

  it('整形: 円は整数・桁区切り、千円は ÷1,000（|値| < 10 万円は小数 1 桁）、∞ と欠損', () => {
    expect(fmtAmount(24_000, 'yen')).toBe('24,000');
    expect(fmtAmount(-62_195_000, 'yen')).toBe('−62,195,000');
    expect(fmtAmount(1_805_000, 'thousand')).toBe('1,805');
    expect(fmtAmount(-62_195_000, 'thousand')).toBe('−62,195');
    expect(fmtAmount(5_300, 'thousand')).toBe('5.3');
    expect(fmtAmount(-58_250, 'thousand')).toBe('−58.3');
    expect(fmtAmount(100_000, 'thousand')).toBe('100');
    expect(fmtAmount(1_805_000, 'thousand', true)).toBe('+1,805');
    expect(fmtAmount(0, 'yen', true)).toBe('0');
    expect(fmtAmount(-0.4, 'yen', true)).toBe('0');
    expect(fmtAmount(Number.POSITIVE_INFINITY, 'yen')).toBe('+∞');
    expect(fmtAmount(Number.NEGATIVE_INFINITY, 'thousand')).toBe('−∞');
    expect(fmtAmount(Number.NaN, 'yen')).toBe('—');
    expect(fmtAmount(null, 'yen')).toBe('—');
    expect(fmtRatio(-11.916)).toBe('×11.9');
    expect(fmtRatio(1)).toBe('×1.0');
    expect(fmtRatio(null)).toBe('—');
  });

  it('指標の表示モデルの単位: U4 の受取 24,000 円は円、ストラングル売り（受取 + 支払 ≥ 10 万円）は千円、固定が優先', () => {
    const small = run(loaded(chain), add(m1.id, 47_000, 'put', 'sell'));
    expect(metricsOf(small).m.unit).toBe('yen');
    expect(metricsOf(small).m.unitAuto).toBe(true);
    const big = run(small, add(m1.id, 70_000, 'call', 'sell'));
    expect(metricsOf(big).m.unit).toBe('thousand');
    const fixed = reduce(big, { type: 'setMetricsUnit', unit: 'yen' });
    expect(metricsOf(fixed).m).toMatchObject({ unit: 'yen', unitAuto: false });
  });
});

describe('最大損益と BEP（AC-8）', () => {
  // 設計 6.1 の架空の例: 11 月限 F = 67,810、売り P 64,000 @ 810 と売り C 70,500 @ 995
  const { ctx, rows } = makeMarket();
  const legs: Leg[] = [
    {
      kind: 'option',
      product: 'op_large',
      type: 'put',
      expiry: M1.id,
      strike: 64000,
      side: 'sell',
      qty: 1,
      entry: 810,
    },
    {
      kind: 'option',
      product: 'op_large',
      type: 'call',
      expiry: M1.id,
      strike: 70500,
      side: 'sell',
      qty: 1,
      entry: 995,
    },
  ];
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, preparePosition(legs, ctx), ctx);
  if (!base) throw new Error('基礎が作れない');

  it('ストラングル売り: 最大利益 = 受取、最大損失 = call 側 ∞ と put 側の有限値（SQ = 下端）、満期 BEP は解析解', () => {
    const m = metricsModel({ base, scenario: ZERO_SCENARIO, unit: 'auto' });
    expect(m.premium.received).toBe(1_805_000);
    expect(m.expiry.maxProfit.value).toBe(m.premium.received);
    expect(m.expiry.maxLoss.value).toBe(Number.NEGATIVE_INFINITY);
    expect(m.expiry.lossFinite).toEqual({ value: -62_195_000, x: 0 });
    expect(m.expiry.lossFinite?.x).toBe(m.expiry.xLo);
    expect(m.expiry.profitFinite).toBeNull();
    // 解析解: 64,000 − 1,805 = 62,195、70,500 + 1,805 = 72,305
    expect(m.expiry.breakevens).toEqual([62_195, 72_305]);
    expect(m.unit).toBe('thousand');
  });

  it('指定日（d = 5、Δσ +2）の BEP で理論損益の符号が変わる', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, days: 5, dSigma: 2 };
    const m = metricsModel({ base, scenario: sc, unit: 'auto' });
    expect(m.dateBreakevens.length).toBe(2);
    for (const b of m.dateBreakevens) {
      const f = (x: number) => theoreticalPnl(base.legs, x, sc, base.ctx);
      expect(Math.sign(f(b - 1))).not.toBe(Math.sign(f(b + 1)));
      expect(b).toBeGreaterThanOrEqual(base.full[0]);
      expect(b).toBeLessThanOrEqual(base.full[1]);
    }
  });

  it('call 買い（右端 +∞）は最大利益 ∞ と、折れ点と下端の中の最大を併記', () => {
    const call = pnlDomains(
      board,
      preparePosition([{ ...(legs[1] as Leg), side: 'buy' }], ctx),
      ctx,
    );
    const m = metricsModel({ base: call, scenario: ZERO_SCENARIO, unit: 'auto' });
    expect(m.expiry.maxProfit.value).toBe(Number.POSITIVE_INFINITY);
    expect(m.expiry.profitFinite?.value).toBe(-995_000);
    expect(m.expiry.maxLoss).toEqual({ value: -995_000, x: 0 });
  });

  it('足 0 本は empty（例外なし）、d は最遠の足の SQ に収める', () => {
    expect(metricsModel({ base: null, scenario: ZERO_SCENARIO, unit: 'auto' }).empty).toBe(true);
    const m = metricsModel({ base, scenario: { ...ZERO_SCENARIO, days: 1000 }, unit: 'auto' });
    expect(m.days).toBeCloseTo(base.maxDays, 9);
    expect(m.scenarioPoint.legs.every((l) => l.state === 'expired')).toBe(true);
  });
});

/**
 * #144 AC-6: ΔX −99% / +900%（sticky strike・moneyness、basis が負の足で F' ≤ 0 を含む）、d = 0 と d = 最遠の SQ
 * （満期）で、シナリオ点の損益・合計グリーク・足別の値が有限。
 */
describe('ΔX の数値欄の端で指標が有限（#144）', () => {
  for (const [name, b] of extremeBases()) {
    it(name, () => {
      const X = b.ctx.x0;
      for (const ratio of [-0.99, 9])
        for (const ivDynamics of ['sticky_strike', 'sticky_moneyness'] as const)
          for (const days of [0, b.maxDays]) {
            const sc: Scenario = { ...ZERO_SCENARIO, dX: ratio * X, days, ivDynamics };
            const m = metricsModel({ base: b, scenario: sc, unit: 'auto' });
            const tag = `${ratio} ${ivDynamics} d=${days}`;
            expect(m.empty, tag).toBe(false);
            expect(nonFinitePaths(m.scenarioPoint), tag).toEqual([]);
            expect(m.scenarioPoint.legs.length, tag).toBe(b.legs.length);
            expect(nonFinitePaths(m.dateBreakevens), tag).toEqual([]);
            expect(nonFinitePaths(m.tail), tag).toEqual([]);
          }
    });
  }
});

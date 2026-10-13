import { describe, expect, it } from 'vitest';
import {
  axisOrigin,
  boardOptionLeg,
  type Chain,
  type ChainMonth,
  normalizeChain,
} from '../../data';
import { type AtmBasis, findAtm, type StrikeRow, ZERO_SCENARIO } from '../../model';
import { buildChainJson, type ChainSpec, SPECS } from '../../scripts/synthBoard';
import { CALENDAR } from '../../ui/calendar';
import { linear } from '../../ui/chart/scale';
import type { UiLeg } from '../../ui/state';
import { boardModel } from '../../ui/view/board';
import { headerModel } from '../../ui/view/header';
import {
  DEFAULT_PNL_Y,
  type PnlBase,
  type PnlChartModel,
  pnlChartModel,
  pnlDomains,
} from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { scenarioAtm, scenarioAtmMark, scenarioAtmReference } from '../../ui/view/scenarioAtm';
import { axisValue, type SmileAxis, smileMarkX, smileModel } from '../../ui/view/smile';

/**
 * #26: シナリオ ATM の印（AC20 の後半）。基準価格を 3 通りに変えた合成の板（tests/ui/atm.test.ts と
 * 同じ作り。値は架空）× 基準 A / B × ΔX（円。架空）。
 */
const latest = SPECS.find((s) => s.name === 'latest') as ChainSpec;

function shifted(dF: number, dFuture: number): ChainSpec {
  return {
    ...latest,
    future: { ...latest.future, price: (latest.future.price as number) + dFuture },
    months: latest.months.map((m) => ({ ...m, F: m.F + dF })),
  };
}

const CASES: Array<[string, ChainSpec]> = [
  ['そのまま', latest],
  ['F +190・先物 −260', shifted(190, -260)],
  ['F −440・先物 +330', shifted(-440, 330)],
];

const DXS = [-2000, -500, 0, 300, 1500];
const BASES: AtmBasis[] = ['A', 'B'];
const AXES: SmileAxis[] = ['k', 'moneyness', 'delta'];

describe.each(CASES)('シナリオ ATM（%s）', (_name, spec) => {
  const chain = normalizeChain(buildChainJson(spec));

  it.each(BASES)(
    'AC-1 基準 %s: 全限月で findAtm(rows, X₀,i + ΔX) と一致、ΔX = 0 で市場 ATM',
    (basis) => {
      const x0 = axisOrigin(chain, basis);
      expect(Number.isFinite(x0)).toBe(true);
      for (const month of chain.months) {
        const ref = month.atm[basis].reference.price as number;
        expect(ref).not.toBeNull();
        for (const dX of DXS) {
          expect(scenarioAtmReference(month, basis, x0, dX)).toBeCloseTo(ref + dX, 9);
          const got = scenarioAtm(month, basis, x0, dX);
          const expected = findAtm(month.rows, ref + dX);
          expect(got?.k).toBeDefined();
          expect(got?.k).toBe(expected?.k);
        }
        expect(scenarioAtm(month, basis, x0, 0)?.k).toBe(month.atm[basis].pick?.k);
      }
    },
  );

  it.each(BASES)('AC-1 基準 %s: ΔX の格子で K が単調非減少', (basis) => {
    const x0 = axisOrigin(chain, basis);
    for (const month of chain.months) {
      let prev = Number.NEGATIVE_INFINITY;
      for (let dX = -5000; dX <= 5000; dX += 37) {
        const k = scenarioAtm(month, basis, x0, dX)?.k;
        expect(k).toBeDefined();
        expect(k as number).toBeGreaterThanOrEqual(prev);
        prev = k as number;
      }
    }
  });

  it.each(BASES)('AC-2 基準 %s: 板・スマイル・ヘッダの ATM は ΔX に依らない', (basis) => {
    // 板・スマイル・ヘッダの表示モデルはシナリオを取らない。シナリオ ATM を求めても変わらないことと、
    // 大きい ΔX ではシナリオ ATM と市場 ATM が別の K になることを確かめる
    const x0 = axisOrigin(chain, basis);
    const header0 = headerModel(chain, basis, CALENDAR).months.map((m) => [m.atm, m.atmK]);
    for (const month of chain.months) {
      const market = month.atm[basis].pick?.k;
      const board0 = boardModel(chain, month, basis).atmK;
      const smile0 = AXES.map((a) => smileModel(month, basis, a));
      expect(board0).toBe(market);
      for (const dX of DXS) {
        const scn = scenarioAtm(month, basis, x0, dX);
        expect(boardModel(chain, month, basis).atmK).toBe(board0);
        AXES.forEach((a, i) => {
          const s = smileModel(month, basis, a);
          expect(s.atmK).toBe(smile0[i]?.atmK);
          expect(s.atmX).toBe(smile0[i]?.atmX);
        });
        if (dX === -2000) expect(scn?.k).not.toBe(market);
      }
    }
    expect(headerModel(chain, basis, CALENDAR).months.map((m) => [m.atm, m.atmK])).toEqual(header0);
  });
});

/** 損益グラフの表示モデル（tests/ui/pnlChart.test.ts と同じ作り） */
const chain = normalizeChain(buildChainJson(latest));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');
const PLOT_W = 1000;
const PLOT_H = 200;

function baseOf(c: Chain, basis: AtmBasis): PnlBase {
  const first = c.months[0] as ChainMonth;
  const atm = first.atm[basis].pick?.k as number;
  const built = boardOptionLeg(c, { expiry: first.id, k: atm - 1000, type: 'put', side: 'sell' });
  const legs: UiLeg[] = [{ id: 1, leg: built.leg, marks: built.marks }];
  const pm = positionModel(c, legs, basis, CALENDAR);
  const base = pnlDomains(c, pm.prepared, pm.ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  return base;
}

function chartOf(
  base: PnlBase,
  dX: number,
  month: ChainMonth,
  basis: AtmBasis,
  opts: { viewport?: [number, number] | null; F?: number } = {},
): PnlChartModel {
  const pick = scenarioAtmMark(month, basis, base.ctx.x0, dX);
  return pnlChartModel({
    base,
    scenario: { ...ZERO_SCENARIO, dX },
    viewport: opts.viewport === undefined ? base.full : opts.viewport,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: PLOT_W,
    plotHeight: PLOT_H,
    scenarioAtm: pick ? { monthId: month.id, k: pick.k, F: opts.F ?? month.F } : null,
  });
}

describe('AC-3 損益グラフのシナリオ ATM の画素', () => {
  it.each(BASES)('基準 %s: ΔX で sx(K′ − basis_i) に動く', (basis) => {
    const base = baseOf(chain, basis);
    const x0 = base.ctx.x0;
    expect(x0).toBe(axisOrigin(chain, basis));
    for (const month of chain.months) {
      const pxs: number[] = [];
      for (const dX of [-2000, 1500]) {
        const m = chartOf(base, dX, month, basis);
        const k = scenarioAtm(month, basis, x0, dX)?.k as number;
        const sx = linear(m.domain, [m.plot.left, m.plot.left + m.plot.width]);
        const x = k - (month.F - x0);
        expect(m.scenarioAtm).not.toBeNull();
        expect(m.scenarioAtm?.monthId).toBe(month.id);
        expect(m.scenarioAtm?.k).toBe(k);
        expect(m.scenarioAtm?.x).toBeCloseTo(x, 9);
        expect(m.scenarioAtm?.px).toBeCloseTo(sx(x), 9);
        pxs.push(m.scenarioAtm?.px as number);
      }
      expect(pxs[0]).toBeLessThan(pxs[1] as number);
    }
  });

  it('ΔX = 0・表示範囲外・F が決まらない限月では null', () => {
    const base = baseOf(chain, 'B');
    const x0 = base.ctx.x0;
    expect(chartOf(base, 0, m1, 'B').scenarioAtm).toBeNull();
    // ΔX = 0 でも印を渡された場合に出さない（部品の取り違えの保険）
    const k0 = m1.atm.B.pick?.k as number;
    const m0 = pnlChartModel({
      base,
      scenario: ZERO_SCENARIO,
      viewport: base.full,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
      scenarioAtm: { monthId: m1.id, k: k0, F: m1.F },
    });
    expect(m0.scenarioAtm).toBeNull();
    // 表示範囲を X₀ の近くに絞り、ΔX = −5,000 のシナリオ ATM を範囲外にする
    const narrow = chartOf(base, -5000, m1, 'B', { viewport: [x0 - 300, x0 + 300] });
    expect(narrow.domain[0]).toBeGreaterThan(x0 - 5000 + 500);
    expect(narrow.scenarioAtm).toBeNull();
    expect(chartOf(base, -2000, m1, 'B', { F: Number.NaN }).scenarioAtm).toBeNull();
  });

  it('scenarioAtm を渡さなければ既存の出力は変わらない（null）', () => {
    const base = baseOf(chain, 'B');
    const m = pnlChartModel({
      base,
      scenario: { ...ZERO_SCENARIO, dX: -2000 },
      viewport: null,
      pnlY: DEFAULT_PNL_Y,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
    });
    expect(m.scenarioAtm).toBeNull();
    expect(m.scenarioPx).not.toBeNull();
  });
});

describe('AC-4 スマイルのシナリオ ATM の横軸位置', () => {
  it.each(BASES)('基準 %s: 軸 K / moneyness / デルタで axisValue と一致', (basis) => {
    const x0 = axisOrigin(chain, basis);
    for (const month of chain.months) {
      for (const dX of [-2000, 1500]) {
        const k = scenarioAtmMark(month, basis, x0, dX)?.k as number;
        const info = month.strikes.find((s) => s.k === k);
        expect(info).toBeDefined();
        if (!info) continue;
        for (const axis of AXES) {
          const model = smileModel(month, basis, axis);
          const want = axisValue(month, basis, axis, info);
          expect(want).not.toBeNull();
          expect(smileMarkX(model, month, basis, axis, k)).toBe(want);
        }
      }
    }
  });

  it('ΔX = 0・表示範囲外・K 無しでは null', () => {
    const x0 = axisOrigin(chain, 'B');
    const k0 = scenarioAtmMark(m1, 'B', x0, 0)?.k ?? null;
    expect(k0).toBeNull();
    expect(smileMarkX(smileModel(m1, 'B', 'k'), m1, 'B', 'k', k0)).toBeNull();
    const k = scenarioAtmMark(m1, 'B', x0, -2000)?.k as number;
    // 横軸 K の表示範囲をシナリオ ATM より上に絞る
    const model = smileModel(m1, 'B', 'k', [k + 500, k + 3000]);
    expect(smileMarkX(model, m1, 'B', 'k', k)).toBeNull();
    // 板に無い K
    expect(smileMarkX(smileModel(m1, 'B', 'k'), m1, 'B', 'k', k + 1)).toBeNull();
  });
});

describe('AC-5 範囲外・基準価格なしで無し（例外・NaN なし）', () => {
  // 行使価格を F ±15%（250 円刻み）に絞った合成の板
  const narrowSpec: ChainSpec = {
    ...latest,
    months: latest.months.map((m) => {
      const lo = Math.round((m.F * 0.85) / 250) * 250;
      const hi = Math.round((m.F * 1.15) / 250) * 250;
      const strikes: number[] = [];
      for (let k = lo; k <= hi; k += 250) strikes.push(k);
      return { ...m, callWing: { twoSided: [], askOnly: [] }, strikes };
    }),
  };
  const narrow = normalizeChain(buildChainJson(narrowSpec));

  it.each(BASES)('基準 %s: ΔX = ±40% で板の外 → null', (basis) => {
    const x0 = axisOrigin(narrow, basis);
    for (const month of narrow.months) {
      const ks = month.rows.map((r) => r.k);
      const lo = Math.min(...ks);
      const hi = Math.max(...ks);
      const down = scenarioAtmReference(month, basis, x0, -0.4 * x0) as number;
      const up = scenarioAtmReference(month, basis, x0, 0.4 * x0) as number;
      expect(down).toBeLessThan(lo);
      expect(up).toBeGreaterThan(hi);
      expect(scenarioAtm(month, basis, x0, -0.4 * x0)).toBeNull();
      expect(scenarioAtm(month, basis, x0, 0.4 * x0)).toBeNull();
      expect(scenarioAtmMark(month, basis, x0, -0.4 * x0)).toBeNull();
      // 範囲の端ちょうどは ATM（端の行）
      const ref = month.atm[basis].reference.price as number;
      expect(scenarioAtm(month, basis, x0, lo - ref)?.k).toBe(lo);
      expect(scenarioAtm(month, basis, x0, hi - ref)?.k).toBe(hi);
      expect(scenarioAtm(month, basis, x0, lo - ref - 1)).toBeNull();
      expect(scenarioAtm(month, basis, x0, hi - ref + 1)).toBeNull();
    }
  });

  it('基準価格が無い限月・x0 / dX が非有限・行が無い → null', () => {
    const rows = m1.rows as StrikeRow[];
    const noRef: Pick<ChainMonth, 'atm' | 'rows'> = {
      atm: {
        A: { reference: { basis: 'A', price: null, fellBack: false }, pick: null },
        B: { reference: { basis: 'B', price: null, fellBack: true }, pick: null },
      },
      rows,
    };
    for (const basis of BASES) {
      expect(scenarioAtmReference(noRef, basis, 67000, -500)).toBeNull();
      expect(scenarioAtm(noRef, basis, 67000, -500)).toBeNull();
      expect(scenarioAtmMark(noRef, basis, 67000, -500)).toBeNull();
    }
    const x0 = axisOrigin(chain, 'B');
    for (const [x, d] of [
      [Number.NaN, -500],
      [x0, Number.NaN],
      [Number.POSITIVE_INFINITY, -500],
      [x0, Number.NEGATIVE_INFINITY],
      [0, -500],
      [-1, -500],
    ] as const) {
      expect(scenarioAtmReference(m1, 'B', x, d)).toBeNull();
      expect(scenarioAtm(m1, 'B', x, d)).toBeNull();
      expect(scenarioAtmMark(m1, 'B', x, d)).toBeNull();
    }
    expect(scenarioAtm({ atm: m1.atm, rows: [] }, 'B', x0, -500)).toBeNull();
  });

  it('% モードの基準価格は X₀,i × X′ / X₀', () => {
    const x0 = axisOrigin(chain, 'A');
    const ref = m2.atm.A.reference.price as number;
    const v = scenarioAtmReference(m2, 'A', x0, -1000, 'pct') as number;
    expect(v).toBeCloseTo((ref * (x0 - 1000)) / x0, 9);
    expect(scenarioAtm(m2, 'A', x0, -1000, 'pct')?.k).toBe(findAtm(m2.rows, v)?.k);
  });
});

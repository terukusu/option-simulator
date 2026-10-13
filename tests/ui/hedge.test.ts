import { describe, expect, it } from 'vitest';
import { type Chain, type ChainJson, type ChainMonth, normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, type Scenario } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, parseHedgeTarget, reduce, type State } from '../../ui/state';
import {
  HEDGE_LOTS_MAX,
  HEDGE_REASON_LABEL,
  type HedgeModel,
  hedgeContracts,
  hedgeModel,
  hedgePriceMissing,
} from '../../ui/view/hedge';
import { metricsModel } from '../../ui/view/metrics';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';
import { rng } from '../support/synthChain';

/**
 * #19 AC-3〜AC-6: デルタヘッジのパネルの表示モデルと [追加]（reducer の addFutureLeg）。
 * 固定の合成の板（fixtures/synthetic/latest.json。架空の値）と種つき乱数の足。
 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が無い');
const MONTHS: readonly ChainMonth[] = [m1, m2];

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);
const loaded = (c: Chain = chain) => reduce(initialState, { type: 'loaded', chain: c, label: 'x' });

function views(s: State) {
  const c = s.chain as Chain;
  const settings: ModelSettings = { ...DEFAULT_SETTINGS, feePerLot: s.feePerLot };
  const pm = positionModel(c, s.legs, s.atmBasis, s.calendar, settings);
  const base = pnlDomains(c, pm.prepared, pm.ctx, settings);
  const metrics = metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit });
  const hedge = hedgeModel({
    chain: c,
    ctx: pm.ctx,
    base,
    settings,
    scenario: s.scenario,
    hedge: s.hedge,
    holidays: s.calendar.holidays,
  });
  // ポジション一覧の足別 Δ（ラージ換算）の和
  const listDelta = pm.rows.reduce((a, r) => a + (r.greeks?.deltaLarge ?? 0), 0);
  return { pm, base, metrics, hedge, listDelta };
}

/** 評価点の合計 Δ（シナリオ適用前 = ポジション一覧、シナリオ時点 = 指標のシナリオ点） */
function deltaAt(s: State): number {
  const v = views(s);
  return s.hedge.at === 'base' ? v.listDelta : v.metrics.scenarioPoint.total.deltaLarge;
}

const mini = (h: HedgeModel) => h.lines.find((l) => l.product === 'fut_mini');
const large = (h: HedgeModel) => h.lines.find((l) => l.product === 'fut_large');

/** 両側気配の OTM の行（足の候補） */
function otmRows(m: ChainMonth) {
  return m.rows
    .map((r, i) => ({ r, info: m.strikes[i] }))
    .filter(({ r, info }) => info && (r.k < m.F ? info.put : info.call).quote === 'two_sided')
    .map(({ r }) => ({ k: r.k, type: r.k < m.F ? ('put' as const) : ('call' as const) }));
}

/** 種つき乱数の足（OP 1〜6 本、半分のケースで先物を 1 本含む）とシナリオ */
function randomState(seed: number): State {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  let s = loaded();
  const n = 1 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) {
    const m = pick(MONTHS);
    const row = pick(otmRows(m));
    s = reduce(s, {
      type: 'addBoardLeg',
      expiry: m.id,
      k: row.k,
      optionType: row.type,
      side: r() < 0.5 ? 'buy' : 'sell',
    });
    const id = s.legs[s.legs.length - 1]?.id as number;
    s = reduce(s, { type: 'editLeg', id, patch: { qty: 1 + Math.floor(r() * 5) } });
  }
  if (r() < 0.5) {
    s = reduce(s, {
      type: 'addFutureLeg',
      input: {
        product: pick(['fut_mini', 'fut_large', 'fut_micro'] as const),
        contract: pick(hedgeContracts(chain)),
        side: r() < 0.5 ? 'buy' : 'sell',
        qty: 1 + Math.floor(r() * 3),
      },
    });
  }
  const x0 = views(s).pm.ctx.x0;
  const scenario: Partial<Scenario> = {
    days: Math.floor(r() * 40),
    dX: Math.round((r() * 0.2 - 0.12) * x0),
    dSigma: Math.round(r() * 10 - 3),
  };
  s = reduce(s, { type: 'setScenario', patch: scenario });
  const target = Math.round((r() * 4 - 2) * 100) / 100;
  return reduce(s, { type: 'setHedge', patch: { target } });
}

describe('[追加] で目標 Δ に近づく（AC-3 = AC19 の本体）', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => 1900 + i);

  for (const at of ['base', 'scenario'] as const) {
    it(`評価点 ${at}: ミニを追加すると |Δ − 目標| ≤ 0.05、ラージは ≤ 0.5`, () => {
      let added = 0;
      for (const seed of seeds) {
        const s = reduce(randomState(seed), { type: 'setHedge', patch: { at } });
        const { hedge } = views(s);
        expect(hedge.reason).toBeNull();
        const target = s.hedge.target;
        for (const [ln, tol] of [
          [mini(hedge), 0.05],
          [large(hedge), 0.5],
        ] as const) {
          if (!ln) throw new Error('行が無い');
          expect(Number.isInteger(ln.lots)).toBe(true);
          expect(Math.abs(ln.residual as number)).toBeLessThanOrEqual(tol + 1e-9);
          if (!ln.canAdd || !ln.input) {
            // 0 枚: もともと目標の ±1 枚の Δ / 2 以内
            expect(ln.lots).toBe(0);
            expect(Math.abs(deltaAt(s) - target)).toBeLessThanOrEqual(tol + 1e-9);
            continue;
          }
          const after = reduce(s, { type: 'addFutureLeg', input: ln.input });
          expect(after.legs.length).toBe(s.legs.length + 1);
          expect(after.legError).toBeNull();
          const d = deltaAt(after);
          expect(Math.abs(d - target)).toBeLessThanOrEqual(tol + 1e-9);
          // 残りは追加後の Δ − 目標
          expect(d - target).toBeCloseTo(ln.residual as number, 9);
          // 再ヘッジ: 出し直すと 0 枚
          const again = views(after).hedge;
          expect(ln.product === 'fut_mini' ? mini(again)?.lots : large(again)?.lots).toBe(0);
          added++;
        }
      }
      expect(added).toBeGreaterThan(40);
    });
  }
});

describe('現在の Δ の整合（AC-4）', () => {
  it('シナリオ適用前 = ポジション一覧の足別 Δ の和、シナリオ時点 = 指標のシナリオ点の合計 Δ（1e-12）', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = randomState(seed);
      const b = views(reduce(s, { type: 'setHedge', patch: { at: 'base' } }));
      expect(Math.abs((b.hedge.current?.large as number) - b.listDelta)).toBeLessThanOrEqual(1e-12);
      expect(b.hedge.point).toEqual({ x: b.pm.ctx.x0, days: 0 });
      const sc = views(reduce(s, { type: 'setHedge', patch: { at: 'scenario' } }));
      const want = sc.metrics.scenarioPoint.total.deltaLarge;
      expect(Math.abs((sc.hedge.current?.large as number) - want)).toBeLessThanOrEqual(1e-12);
      expect(sc.hedge.point).toEqual({ x: sc.metrics.scenarioPoint.x, days: sc.metrics.days });
    }
  });

  it('d が最遠の足の SQ を超えるシナリオでも指標と同じ d（収めた値）', () => {
    // 11 月限の足だけ。d = 40 は 11 月の SQ より後・12 月（板の先物）の SQ より前
    const s = run(
      loaded(),
      {
        type: 'addBoardLeg',
        expiry: m1.id,
        k: otmRows(m1)[3]?.k as number,
        optionType: 'put',
        side: 'sell',
      },
      { type: 'setScenario', patch: { days: 40 } },
      { type: 'setHedge', patch: { at: 'scenario', target: 0.5 } },
    );
    const v = views(s);
    expect(v.hedge.point.days).toBe(v.metrics.days);
    expect(v.hedge.point.days).toBeLessThan(40);
    // 11 月限の足は満期 → Δ 0。追加後は d が 40 に延びるが 12 月限の先物はまだ生きている → ミニ +5 枚
    expect(v.hedge.current?.large).toBe(0);
    expect(v.hedge.reason).toBeNull();
    const ln = mini(v.hedge);
    expect(ln?.lots).toBe(5);
    const after = reduce(s, { type: 'addFutureLeg', input: ln?.input as never });
    expect(views(after).metrics.days).toBe(40);
    expect(deltaAt(after)).toBeCloseTo(0.5, 12);
  });

  it('d が先物の SQ 以降なら追加後の d も先物の SQ に収まるので追加しない', () => {
    const s = run(
      loaded(),
      { type: 'addBoardLeg', expiry: m1.id, k: 64_000, optionType: 'put', side: 'sell' },
      { type: 'setScenario', patch: { days: 300 } },
      { type: 'setHedge', patch: { at: 'scenario', target: 0.5 } },
    );
    expect(views(s).hedge.reason).toBe('settled');
  });
});

describe('[追加] の足の中身（AC-5）', () => {
  const s = run(
    loaded(),
    { type: 'addBoardLeg', expiry: m1.id, k: 64_000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: m1.id, k: 64_500, optionType: 'put', side: 'sell' },
  );

  it('既定: ミニ先物・板の先物の限月・売買 = 符号・枚数 = |N|・建値 = 板の先物価格（印なし）', () => {
    const { hedge } = views(s);
    const ln = mini(hedge);
    if (!ln?.input || ln.lots === null) throw new Error('追加できない');
    // put 売り 2 本で Δ > 0 → ミニの売り
    expect(ln.lots).toBeLessThan(0);
    expect(hedge.contract).toBe(chain.future.id);
    expect(hedge.contractManual).toBe(false);
    expect(hedge.entry).toBe(chain.future.price);
    expect(ln.input).toEqual({
      product: 'fut_mini',
      contract: chain.future.id,
      side: 'sell',
      qty: Math.abs(ln.lots),
    });
    const after = reduce(s, { type: 'addFutureLeg', input: ln.input });
    const leg = after.legs[2];
    expect(leg?.leg).toEqual({
      kind: 'future',
      product: 'fut_mini',
      contract: chain.future.id,
      side: 'sell',
      qty: Math.abs(ln.lots),
      entry: chain.future.price,
    });
    expect(leg?.marks).toEqual([]);
  });

  it('ラージの行はラージ先物の足', () => {
    const ln = large(views(reduce(s, { type: 'setHedge', patch: { target: -3 } })).hedge);
    expect(ln?.input?.product).toBe('fut_large');
  });

  it('限月に板の OP の限月を選ぶと「建値は手入力（板の先物と限月違い）」の印で建値 = その月の合成先物', () => {
    expect(m1.id).not.toBe(chain.future.id);
    expect(m1.syntheticOk).toBe(true);
    const s2 = reduce(s, { type: 'setHedge', patch: { contract: m1.id } });
    const { hedge } = views(s2);
    expect(hedge.contract).toBe(m1.id);
    expect(hedge.contractManual).toBe(true);
    expect(hedge.entry).toBe(m1.F);
    const ln = mini(hedge);
    if (!ln?.input) throw new Error('追加できない');
    expect(ln.input.contract).toBe(m1.id);
    const after = reduce(s2, { type: 'addFutureLeg', input: ln.input });
    const leg = after.legs[2];
    expect(leg?.marks).toContain('future_manual');
    expect(leg?.leg.entry).toBe(m1.F);
    expect(leg?.leg.kind === 'future' && leg.leg.contract).toBe(m1.id);
    expect(Math.abs(deltaAt(after) - 0)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it('限月の選択肢は板の先物 + 板の OP の限月（重複除去・昇順）', () => {
    expect(hedgeContracts(chain)).toEqual([...new Set([m1.id, m2.id, chain.future.id])].sort());
  });
});

describe('追加できない場合（AC-6）', () => {
  it('(a) 0 枚なら追加しない。ミニ 0 枚のときマイクロ換算を出す（足 0 本でも表示）', () => {
    const s = reduce(loaded(), { type: 'setHedge', patch: { target: 0.03 } });
    const { hedge } = views(s);
    expect(hedge.current).toEqual({ large: 0, mini: 0 });
    const ln = mini(hedge);
    expect(ln?.lots).toBe(0);
    expect(ln?.canAdd).toBe(false);
    expect(ln?.input).toBeNull();
    expect(ln?.reason).toBeNull();
    expect(hedge.micro?.lots).toBe(3);
    // ミニが 0 枚でなければマイクロは出さない
    expect(views(reduce(s, { type: 'setHedge', patch: { target: 0.3 } })).hedge.micro).toBeNull();
    // 足 0 本・目標 0（マイクロも 0 枚）なら「マイクロ換算 0 枚」を出さない
    const zero = views(loaded()).hedge;
    expect(mini(zero)?.lots).toBe(0);
    expect(zero.micro).toBeNull();
  });

  function nullPrice(): Chain {
    const j: ChainJson = fixture('latest');
    j.future.price = null;
    j.future.price_time = null;
    return normalizeChain(j);
  }

  it('(b) 板の先物価格が null なら理由を出して追加しない（例外・NaN なし）', () => {
    const c = nullPrice();
    const s = run(loaded(c), {
      type: 'addBoardLeg',
      expiry: c.months[0]?.id as string,
      k: 64_000,
      optionType: 'put',
      side: 'sell',
    });
    for (const at of ['base', 'scenario'] as const) {
      const { hedge } = views(reduce(s, { type: 'setHedge', patch: { at } }));
      expect(hedge.reason).toBe('no_price');
      expect(hedge.entry).toBeNull();
      expect(Number.isFinite(hedge.current?.large)).toBe(true);
      for (const ln of hedge.lines) {
        expect(ln.canAdd).toBe(false);
        expect(ln.input).toBeNull();
        expect(ln.reason).toBe('no_price');
        expect(ln.lots).toBeNull();
      }
    }
  });

  it('(b) 先物価格が null でも、限月に合成先物が決まる OP の限月を選べば追加できる（理由は価格が無いときだけ）', () => {
    const c = nullPrice();
    const om = c.months[0];
    if (!om) throw new Error('限月が無い');
    expect(om.syntheticOk).toBe(true);
    expect(hedgePriceMissing(c, c.future.id)).toBe(true);
    expect(hedgePriceMissing(c, om.id)).toBe(false);
    expect(hedgePriceMissing(chain, chain.future.id)).toBe(false);
    const s = run(
      loaded(c),
      { type: 'addBoardLeg', expiry: om.id, k: 64_000, optionType: 'put', side: 'sell' },
      { type: 'setHedge', patch: { contract: om.id } },
    );
    const { hedge } = views(s);
    expect(hedge.reason).toBeNull();
    expect(hedge.entry).toBe(om.F);
    expect(mini(hedge)?.canAdd).toBe(true);
  });

  it('理由の文言は固定（先物価格が無い / 足を作れない を分ける）', () => {
    expect(HEDGE_REASON_LABEL.no_price).toBe('先物価格が無い（足の追加フォームで建値を入れる）');
    expect(HEDGE_REASON_LABEL.no_leg).toBe('この限月の先物の足を作れない（限月を選び直す）');
  });

  it('(c) シナリオ時点の評価日がヘッジに使う先物の SQ 以降なら理由を出して追加しない', () => {
    // 12 月限の足 + 板の先物（12 月限）: d を SQ より先にすると、追加後の d も先物の SQ に収まり Δ 0
    const s = run(
      loaded(),
      { type: 'addBoardLeg', expiry: m2.id, k: 64_000, optionType: 'put', side: 'sell' },
      { type: 'setScenario', patch: { days: 1000 } },
      { type: 'setHedge', patch: { at: 'scenario', target: 1 } },
    );
    const { hedge } = views(s);
    expect(hedge.reason).toBe('settled');
    expect(hedge.lines.every((l) => !l.canAdd && l.reason === 'settled')).toBe(true);
    // 11 月限の先物（OP の限月）を選び、d を 11 月の SQ より後・12 月の SQ より前にしても同じ
    const s2 = run(
      s,
      { type: 'setScenario', patch: { days: 40 } },
      { type: 'setHedge', patch: { contract: m1.id } },
    );
    expect(views(s2).hedge.reason).toBe('settled');
    // シナリオ適用前（d = 0）なら追加できる
    expect(views(reduce(s2, { type: 'setHedge', patch: { at: 'base' } })).hedge.reason).toBeNull();
  });

  it('(d) |枚数| > 100,000 なら理由を出して追加しない（ラージは上限内なら追加できる）', () => {
    const s0 = reduce(loaded(), {
      type: 'addBoardLeg',
      expiry: m1.id,
      k: otmRows(m1)
        .filter((r) => r.type === 'put')
        .at(-1)?.k as number,
      optionType: 'put',
      side: 'sell',
    });
    const s = reduce(s0, {
      type: 'editLeg',
      id: s0.legs[0]?.id as number,
      patch: { qty: 100_000 },
    });
    const { hedge } = views(s);
    const ln = mini(hedge);
    expect(Math.abs(ln?.lots as number)).toBeGreaterThan(HEDGE_LOTS_MAX);
    expect(ln?.canAdd).toBe(false);
    expect(ln?.reason).toBe('over_limit');
    expect(ln?.input).toBeNull();
    const lg = large(hedge);
    expect(Math.abs(lg?.lots as number)).toBeLessThanOrEqual(HEDGE_LOTS_MAX);
    expect(lg?.canAdd).toBe(true);
  });

  it('目標 Δ の入力: −・+・桁区切りを受け、非数・範囲外（|目標| > 1,000）を拒否', () => {
    expect(parseHedgeTarget('−0.5')).toEqual({ ok: true, value: -0.5 });
    expect(parseHedgeTarget('+1,000')).toEqual({ ok: true, value: 1000 });
    expect(parseHedgeTarget(' -1,000 ')).toEqual({ ok: true, value: -1000 });
    expect(parseHedgeTarget('0')).toEqual({ ok: true, value: 0 });
    expect(Object.is((parseHedgeTarget('-0') as { value: number }).value, -0)).toBe(false);
    for (const bad of ['', 'abc', '1,000.01', '-1001', 'Infinity', '0x10', '1e4']) {
      expect(parseHedgeTarget(bad).ok).toBe(false);
    }
    const r = parseHedgeTarget('<b>');
    expect(r).toEqual({ ok: false, message: '目標 Δ は −1,000〜1,000（ラージ換算）' });
  });

  it('setHedge は不正な値を含む更新を丸ごと無視する（状態を変えない）', () => {
    const s = loaded();
    for (const patch of [
      { target: Number.NaN },
      { target: 1000.5 },
      { target: Number.POSITIVE_INFINITY },
      { at: 'later' as never },
      { contract: '2030-01' },
      { target: 1, contract: 'x' },
    ]) {
      expect(reduce(s, { type: 'setHedge', patch })).toBe(s);
    }
    expect(reduce(initialState, { type: 'setHedge', patch: { contract: m1.id } })).toBe(
      initialState,
    );
    const ok = reduce(s, {
      type: 'setHedge',
      patch: { target: -2.5, at: 'scenario', contract: m1.id },
    });
    expect(ok.hedge).toEqual({ target: -2.5, at: 'scenario', contract: m1.id });
    expect(reduce(ok, { type: 'setHedge', patch: { contract: null } }).hedge.contract).toBeNull();
  });

  it('板を読み直して限月が選択肢に無ければ板の先物に戻す（目標・評価点は保つ）', () => {
    const s = reduce(loaded(), {
      type: 'setHedge',
      patch: { target: 0.5, at: 'scenario', contract: m1.id },
    });
    const j: ChainJson = fixture('latest');
    j.months = j.months.slice(1);
    const other = normalizeChain(j);
    const s2 = reduce(s, { type: 'loaded', chain: other, label: 'y' });
    expect(s2.hedge).toEqual({ target: 0.5, at: 'scenario', contract: null });
    // 選択肢にあれば保つ
    const s3 = reduce(s, { type: 'loaded', chain, label: 'z' });
    expect(s3.hedge.contract).toBe(m1.id);
  });

  it('既定の状態は 目標 0・シナリオ適用前・板の先物', () => {
    expect(initialState.hedge).toEqual({ target: 0, at: 'base', contract: null });
    expect(views(loaded()).hedge.lines.map((l) => [l.lots, l.canAdd])).toEqual([
      [0, false],
      [0, false],
    ]);
  });

  it('CALENDAR を使う（板に無い限月は選択肢に出ない）', () => {
    expect(loaded().calendar).toBe(CALENDAR);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, theoreticalPnl } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { boardRows, jumpToOtm, referencePrice } from '../../ui/view/board';
import { hedgeModel } from '../../ui/view/hedge';
import { metricsModel } from '../../ui/view/metrics';
import { type PnlBase, pnlChartModel, pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';

/**
 * #6 AC-9・AC-10: 設計 6.2 の U2・U4（証拠金を除く）、#19 AC-7・#25 AC-2・AC-3: U5（手順 1〜4）を固定の合成の板（架空の値）と reducer で通す。
 * 画面の部品がする操作（板の bid / ask を押す = addBoardLeg、スライダー = setScenario、プリセット = applyPreset）を
 * そのまま action で並べ、表示モデル（損益グラフ・指標・テール表）を確かめる。
 */

const chain = normalizeChain(fixture('latest'));
const m1 = chain.months[0];
if (!m1) throw new Error('限月が無い');

const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);

function views(s: State) {
  const settings: ModelSettings = {
    ...DEFAULT_SETTINGS,
    feePerLot: s.feePerLot,
    futureBasis: s.futureBasis,
  };
  const pm = positionModel(chain, s.legs, s.atmBasis, CALENDAR, settings);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings) as PnlBase;
  if (!base) throw new Error('基礎が作れない');
  const chart = pnlChartModel({
    base,
    scenario: s.scenario,
    viewport: s.pnlViewport,
    pnlY: s.pnlY,
    plotWidth: 600,
    plotHeight: 220,
  });
  const metrics = metricsModel({ base, scenario: s.scenario, unit: s.metricsUnit });
  const hedge = hedgeModel({
    chain,
    ctx: pm.ctx,
    base,
    settings,
    scenario: s.scenario,
    hedge: s.hedge,
    holidays: s.calendar.holidays,
  });
  return { pm, base, chart, metrics, hedge };
}

const start = reduce(initialState, { type: 'loaded', chain, label: 'latest' });

describe('U2: 翌日のイベント前に 1 限月のプット・デビットスプレッド（AC-9）', () => {
  const atm = m1.atm.B.pick?.k as number;
  // 1. ATM の put の ask → 買い、500 円下の put の bid → 売り
  const legs = run(
    start,
    { type: 'addBoardLeg', expiry: m1.id, k: atm, optionType: 'put', side: 'buy' },
    { type: 'addBoardLeg', expiry: m1.id, k: atm - 500, optionType: 'put', side: 'sell' },
  );

  it('足 2 本（買い = ask、売り = bid）で支払超', () => {
    expect(legs.legs.map((l) => [l.leg.side, l.leg.kind === 'option' && l.leg.strike])).toEqual([
      ['buy', atm],
      ['sell', atm - 500],
    ]);
    const { metrics } = views(legs);
    expect(metrics.premium.net).toBeLessThan(0);
    expect(metrics.premium.stake).toBe(-metrics.premium.net);
  });

  it('(i) 経過日数 1・原資産 −3% のシナリオ点の理論損益が指標に出て theoreticalPnl と一致', () => {
    const x0 = views(legs).base.ctx.x0;
    const s = reduce(legs, { type: 'setScenario', patch: { days: 1, dX: -0.03 * x0 } });
    const { base, metrics, chart } = views(s);
    const x = x0 * 0.97;
    expect(metrics.scenarioPoint.x).toBeCloseTo(x, 9);
    expect(metrics.scenarioPoint.dXPct).toBeCloseTo(-3, 9);
    const want = theoreticalPnl(base.legs, x, s.scenario, base.ctx, base.settings);
    expect(Math.abs(metrics.scenarioPoint.pnl - want)).toBeLessThan(1e-6);
    // 下落でデビットスプレッドは利益（put 買いの方が ATM に近い）
    expect(metrics.scenarioPoint.pnl).toBeGreaterThan(0);
    // グラフ: 指定日の線とシナリオ点の縦線（初期範囲は狭いので、縮小してシナリオ点を入れる）
    expect(chart.lines.map((l) => l.kind)).toEqual(['expiry', 'date', 'today']);
    expect(chart.scenarioX).toBeCloseTo(x, 9);
    const wide = views(reduce(s, { type: 'setPnlViewport', viewport: [x - 3_000, x0 + 3_000] }));
    expect(wide.chart.scenarioPx).not.toBeNull();
  });

  it('(ii) 経過日数 0 のまま IV −3pt: 指定日（シナリオ）の線が描かれ、今日の線と異なる', () => {
    const s = reduce(legs, { type: 'setScenario', patch: { days: 0, dX: 0, dSigma: -3 } });
    const { chart, metrics } = views(s);
    const date = chart.lines.find((l) => l.kind === 'date');
    const today = chart.lines.find((l) => l.kind === 'today');
    expect(date).toBeDefined();
    expect(date?.ys.length).toBe(today?.ys.length);
    const maxDiff = Math.max(...(date?.ys.map((y, i) => Math.abs(y - (today?.ys[i] ?? 0))) ?? []));
    expect(maxDiff).toBeGreaterThan(1_000);
    // シナリオ点（X₀）では IV 低下で買いの ATM の put が下がる → 損
    expect(metrics.scenarioPoint.pnl).toBeLessThan(0);
  });
});

describe('U4: 小資金で 1 限月の 30% OTM の put 売り（AC-10。証拠金を除く）', () => {
  const x0 = referencePrice(m1, 'B') as number;
  const rows = boardRows(chain, m1);
  // 1. [OTM 度 30%] へジャンプ。IV 不安定の印が無い行
  const k = jumpToOtm(rows, 'put', x0, 0.3) as number;
  const row = rows.find((r) => r.k === k);
  // 2. bid → 売り
  const s = run(start, { type: 'addBoardLeg', expiry: m1.id, k, optionType: 'put', side: 'sell' });

  it('OTM 度 約 30%・IV 不安定の印なし・両側気配の行', () => {
    expect(Math.abs(1 - k / x0 - 0.3)).toBeLessThan(0.01);
    expect(row?.unstable).toBe(false);
    expect(row?.put.noQuote).toBe(false);
    expect(s.legs[0]?.marks).not.toContain('unstable_iv');
  });

  it('指標は円単位、受取 = bid × 1,000', () => {
    const { metrics } = views(s);
    expect(metrics.unit).toBe('yen');
    expect(metrics.premium.received).toBe((row?.put.bid as number) * 1000);
    expect(metrics.premium.stake).toBeNull();
    expect(metrics.tail.premiumBase).toEqual({
      kind: 'received',
      amount: (row?.put.bid as number) * 1000,
    });
  });

  it('テール表に −5〜−40% の SQ と指定日の損益・倍率。−40% の SQ と −20〜−40% の指定日は受取の何倍かの損失', () => {
    const { metrics } = views(s);
    const { rows: tail, premiumBase } = metrics.tail;
    expect(tail.length).toBe(5);
    for (const r of tail) {
      expect(Number.isFinite(r.sq.pnl)).toBe(true);
      expect(Number.isFinite(r.scenario.pnl)).toBe(true);
      expect(r.sq.ratio).toBeCloseTo(r.sq.pnl / premiumBase.amount, 12);
      expect(r.scenario.ratio).toBeCloseTo(r.scenario.pnl / premiumBase.amount, 12);
    }
    const at = (shock: number) => tail.find((r) => r.shock === shock);
    expect(at(-0.4)?.sq.pnl).toBeLessThan(-premiumBase.amount);
    for (const shock of [-0.2, -0.3, -0.4]) {
      expect(at(shock)?.scenario.pnl).toBeLessThan(0);
    }
  });

  it('3. 縦軸 ±5 倍で折れ点と BEP。急落プリセットで指定日の列の損失が増える（シナリオ 0 より負）', () => {
    const zero = views(s);
    const prem = views(reduce(s, { type: 'setPnlY', patch: { mode: 'premium', n: 5 } })).chart;
    const amount = zero.metrics.premium.received * 5;
    expect(prem.yDomain).toEqual([-amount, amount]);
    expect(prem.kinks.length).toBe(1);
    expect(prem.breakevens.length).toBe(1);
    const crashed = views(reduce(s, { type: 'applyPreset', index: 0, x0: zero.base.ctx.x0 }));
    zero.metrics.tail.rows.forEach((r, i) => {
      const c = crashed.metrics.tail.rows[i];
      if (!c) throw new Error('行が無い');
      // SQ の列はシナリオに依らない
      expect(c.sq.pnl).toBe(r.sq.pnl);
      expect(c.scenario.pnl).toBeLessThan(r.scenario.pnl);
    });
    // シナリオ点（−10%）の理論損益も損
    expect(crashed.metrics.scenarioPoint.pnl).toBeLessThan(0);
  });
});

describe('U5: ミニ先物でデルタを中立に（#19 AC-7 手順 1〜3・#25 AC-2・AC-3 手順 4）', () => {
  const x0 = referencePrice(m1, 'B') as number;
  const rows = boardRows(chain, m1);
  // 1. 1 限月の OTM の put 売り（OTM 度 約 3%）・call 売り（約 6%）各 1 枚（Δ が 0 から離れる組み合わせ）
  const kp = jumpToOtm(rows, 'put', x0, 0.03) as number;
  const kc = jumpToOtm(rows, 'call', x0, 0.06) as number;
  const s1 = run(
    start,
    { type: 'addBoardLeg', expiry: m1.id, k: kp, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: m1.id, k: kc, optionType: 'call', side: 'sell' },
  );
  const listDelta = (s: State) =>
    views(s).pm.rows.reduce((a, r) => a + (r.greeks?.deltaLarge ?? 0), 0);

  it('2. ヘッジ（目標 0、ミニ）→ [追加] 後のポジション一覧・指標の |Δ| ≤ 0.05', () => {
    const { hedge } = views(s1);
    expect(hedge.at).toBe('base');
    expect(hedge.target).toBe(0);
    const mini = hedge.lines[0];
    expect(mini?.product).toBe('fut_mini');
    if (!mini?.input) throw new Error('追加できない');
    const s2 = reduce(s1, { type: 'addFutureLeg', input: mini.input });
    expect(s2.legs.at(-1)?.leg).toMatchObject({ kind: 'future', product: 'fut_mini' });
    expect(Math.abs(listDelta(s2))).toBeLessThanOrEqual(0.05 + 1e-9);
    // シナリオ 0 では指標の合計 Δ も同じ点
    expect(Math.abs(views(s2).metrics.scenarioPoint.total.deltaLarge)).toBeLessThanOrEqual(
      0.05 + 1e-9,
    );
    // 出し直すと 0 枚
    expect(views(s2).hedge.lines[0]?.lots).toBe(0);
  });

  it('3. 原資産 −5%・評価点 = シナリオ時点で枚数が 0 でない → [追加] 後のシナリオ点の |Δ| ≤ 0.05', () => {
    const first = views(s1).hedge.lines[0]?.input;
    if (!first) throw new Error('追加できない');
    const s2 = run(
      s1,
      { type: 'addFutureLeg', input: first },
      { type: 'setScenario', patch: { dX: -0.05 * views(s1).pm.ctx.x0 } },
      { type: 'setHedge', patch: { at: 'scenario' } },
    );
    const { hedge, metrics } = views(s2);
    expect(hedge.current?.large).toBeCloseTo(metrics.scenarioPoint.total.deltaLarge, 12);
    const mini = hedge.lines[0];
    expect(mini?.lots).not.toBe(0);
    if (!mini?.input) throw new Error('追加できない');
    const s3 = reduce(s2, { type: 'addFutureLeg', input: mini.input });
    expect(s3.legs).toHaveLength(4);
    expect(Math.abs(views(s3).metrics.scenarioPoint.total.deltaLarge)).toBeLessThanOrEqual(
      0.05 + 1e-9,
    );
  });

  it('4. [basis 減衰] で満期の線・テール表の SQ 列が w × basis × (1 − factor) だけ動き、今日の線は不変。[basis 固定] で戻る（#25 AC-2）', () => {
    const first = views(s1).hedge.lines[0]?.input;
    if (!first) throw new Error('追加できない');
    const s2 = reduce(s1, { type: 'addFutureLeg', input: first });
    const sd = reduce(s2, { type: 'setFutureBasis', basis: 'decay' });
    const fixed = views(s2);
    const decay = views(sd);
    // 手計算（model の関数を呼ばない）: 先物の足 1 本（ミニ = 乗数 100）、basis = 板の先物価格 − X₀、
    // factor = 残存（OP の SQ → 先物の SQ）/ T0（評価時刻 → 先物の SQ）。ms 差の比
    const fut = s2.legs.at(-1)?.leg;
    if (fut?.kind !== 'future') throw new Error('先物の足が無い');
    expect(fut.product).toBe('fut_mini');
    expect(chain.future.id).not.toBe(m1.id);
    const w = (fut.side === 'buy' ? 1 : -1) * fut.qty * 100;
    const ctx = fixed.pm.ctx;
    const basis = (chain.future.price as number) - ctx.x0;
    const factor = (chain.future.sqTime - m1.sqTime) / (chain.future.sqTime - ctx.evalTime);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeLessThan(1);
    const want = w * basis * (1 - factor);
    // 板の basis ≠ 0 で差が出ること（反証可能性）
    expect(Math.abs(want)).toBeGreaterThan(1);
    for (const x of [ctx.x0 * 0.9, ctx.x0, ctx.x0 * 1.1]) {
      expect(Math.abs(fixed.base.expiry(x) - decay.base.expiry(x) - want)).toBeLessThan(1e-6);
    }
    // テール表の SQ 列は各行で同じ額、指定日の列（d = 0）は変わらない
    const fRows = fixed.metrics.tail.rows;
    const dRows = decay.metrics.tail.rows;
    expect(dRows.length).toBe(fRows.length);
    expect(fRows.length).toBeGreaterThan(0);
    fRows.forEach((r, i) => {
      const d = dRows[i];
      if (!d) throw new Error('行が無い');
      expect(Math.abs(r.sq.pnl - d.sq.pnl - want)).toBeLessThan(1e-6);
      expect(Math.abs(r.scenario.pnl - d.scenario.pnl)).toBeLessThan(1e-6);
    });
    // グラフ（同じ表示範囲で比べる。初期範囲は BEP で変わるため）: 満期の線は同じ額下がり、
    // 今日の線（d = 0）は先物の factor = 1 なので一致
    const vp = { type: 'setPnlViewport', viewport: [ctx.x0 * 0.9, ctx.x0 * 1.1] } as const;
    const fChart = views(reduce(s2, vp)).chart;
    const dChart = views(reduce(sd, vp)).chart;
    const line = (c: typeof fChart, kind: 'expiry' | 'today') =>
      c.lines.find((l) => l.kind === kind);
    expect(line(dChart, 'today')?.xs).toEqual(line(fChart, 'today')?.xs);
    expect(line(fChart, 'today')?.ys.length).toBeGreaterThan(0);
    expect(line(dChart, 'today')?.ys).toEqual(line(fChart, 'today')?.ys);
    const fEx = line(fChart, 'expiry');
    const dEx = line(dChart, 'expiry');
    expect(dEx?.xs).toEqual(fEx?.xs);
    fEx?.ys.forEach((y, i) => {
      expect(Math.abs(y - (dEx?.ys[i] ?? Number.NaN) - want)).toBeLessThan(1e-6);
    });
    // [basis 固定] に戻すと元と一致
    const back = views(reduce(sd, { type: 'setFutureBasis', basis: 'fixed' }));
    for (const x of [ctx.x0 * 0.9, ctx.x0, ctx.x0 * 1.1]) {
      expect(back.base.expiry(x)).toBe(fixed.base.expiry(x));
    }
  });

  it('差が出ない場合: OP だけ、先物と同じ限月の OP + 先物では固定 / 減衰の満期損益が一致（#25 AC-3）', () => {
    const same = (s: State) => {
      const f = views(s).base;
      const d = views(reduce(s, { type: 'setFutureBasis', basis: 'decay' })).base;
      const x0v = f.ctx.x0;
      for (const x of [x0v * 0.9, x0v, x0v * 1.1]) {
        expect(d.expiry(x)).toBe(f.expiry(x));
      }
    };
    // OP だけ（手順 1）
    same(s1);
    // 先物と同じ限月の OP 1 本 + ミニ先物（OP の SQ = 先物の SQ で F = X'）
    const mf = chain.months.find((m) => m.id === chain.future.id);
    if (!mf) throw new Error('先物と同じ限月の OP が無い');
    const kf = jumpToOtm(boardRows(chain, mf), 'put', x0, 0.03) as number;
    const s = run(
      start,
      { type: 'addBoardLeg', expiry: mf.id, k: kf, optionType: 'put', side: 'sell' },
      { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
    );
    expect(s.legs).toHaveLength(2);
    expect(s.legs[1]?.leg).toMatchObject({ kind: 'future', product: 'fut_mini' });
    same(s);
  });
});

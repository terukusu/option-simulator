import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, evaluatePosition, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import { type Action, initialState, reduce } from '../../ui/state';
import { aiEnvFromState } from '../../ui/view/aiContext';
import {
  AI_TOOL_NAMES,
  type AiToolEnv,
  GRID_DX_PCT,
  GRID_IV_PT,
  isToolError,
  PRECOMPUTED_TOOLS,
  precompute,
  runTool,
  scenarioOfResult,
  toolCard,
} from '../../ui/view/aiTools';
import { FAIR_POSITION_LABEL, fairPriceText, fairView } from '../../ui/view/fairValue';
import { fmtNum } from '../../ui/view/format';
import { marginNow, marginPoint, marginTail } from '../../ui/view/margin';
import { metricsModel } from '../../ui/view/metrics';
import { todayScenario } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { fixture } from '../support/fixtures';
import { boardsT0AndLater } from '../support/laterChain';

/**
 * #135 AC3: AI のツール（ui/view/aiTools.ts）。合成の板（fixtures/synthetic/latest.json）と合成のポジション 10 通り
 * （scripts/aiEvalCases.ts）で、ツールの出力が画面の表示モデル（指標のタイル・テール表・証拠金）と同じ値。値は架空。
 */

const latest = fixture('latest');

function envOf(name: string): AiToolEnv {
  const c = AI_EVAL_CASES.find((x) => x.name === name);
  if (!c) throw new Error(name);
  const env = aiEnvFromState(caseState(latest, c), caseMargin(c));
  if (!env?.base) throw new Error(`環境が無い: ${name}`);
  return env;
}

const run = (env: AiToolEnv, name: string, input: Record<string, unknown> = {}) => {
  const r = runTool(name, input, env);
  if (isToolError(r)) throw new Error(`${name}: ${r.error}`);
  // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む（形は pytest が tools.py の形で検査する）
  return r as Record<string, any>;
};
const yen = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v) || 0;

describe.each(AI_EVAL_CASES.map((c) => c.name))('ツール = 画面の表示モデル（%s）', (name) => {
  const env = envOf(name);
  const base = env.base as NonNullable<AiToolEnv['base']>;
  const m = metricsModel({ base, scenario: env.scenario, unit: 'yen' });

  it('position_summary: 指標（プレミアム・満期の最大損益・BEP・シナリオ点）と足のグリーク', () => {
    const r = run(env, 'position_summary');
    expect(r.premium.received_yen).toBe(yen(m.premium.received));
    expect(r.premium.paid_yen).toBe(yen(m.premium.paid));
    expect(r.premium.net_yen).toBe(yen(m.premium.net));
    const lossInf = m.expiry.maxLoss.value === Number.NEGATIVE_INFINITY;
    expect(r.expiry.max_loss_unbounded).toBe(lossInf);
    // 無限なら max_loss_yen は null（proposalSummary と同じ意味）、有限の put 側は put_side_*（#260）
    expect(r.expiry.max_loss_yen).toBe(lossInf ? null : yen(m.expiry.maxLoss.value));
    expect(r.expiry.put_side_max_loss_yen).toBe(lossInf ? yen(m.expiry.lossFinite?.value) : null);
    expect(r.expiry.put_side_max_loss_x).toBe(lossInf ? yen(m.expiry.lossFinite?.x) : null);
    if (lossInf) expect(Number.isFinite(r.expiry.put_side_max_loss_yen)).toBe(true);
    const profitInf = m.expiry.maxProfit.value === Number.POSITIVE_INFINITY;
    expect(r.expiry.max_profit_unbounded).toBe(profitInf);
    expect(r.expiry.max_profit_yen).toBe(profitInf ? null : yen(m.expiry.maxProfit.value));
    expect(r.expiry.put_side_max_profit_yen).toBe(
      profitInf ? yen(m.expiry.profitFinite?.value) : null,
    );
    expect(r.expiry.breakevens_x).toEqual(m.expiry.breakevens.map(yen));
    expect(r.scenario_point.pnl_yen).toBe(yen(m.scenarioPoint.pnl));
    expect(r.scenario_point.greeks.delta_large).toBe(
      Math.round(m.scenarioPoint.total.deltaLarge * 100) / 100 || 0,
    );
    const now = evaluatePosition(base.legs, ZERO_SCENARIO, base.ctx, base.settings);
    expect(r.greeks_now.theta_yen_per_day).toBe(yen(now.total.thetaPerDay));
    expect(r.greeks_now.delta_mini).toBe(Math.round(now.total.deltaMini * 100) / 100 || 0);
    expect(r.n_legs).toBe(base.legs.length);
  });

  it('tail_table: テール表と証拠金の表の行', () => {
    const r = run(env, 'tail_table');
    const rows = marginTail(
      base,
      { ...env.scenario, dX: 0 },
      env.margin.params,
      env.margin.capital,
      env.holidays,
    );
    expect(r.rows).toHaveLength(m.tail.rows.length);
    m.tail.rows.forEach((row, i) => {
      expect(r.rows[i].shock_pct).toBe(Math.round(row.shock * 1000) / 10);
      expect(r.rows[i].sq_pnl_yen).toBe(yen(row.sq.pnl));
      expect(r.rows[i].scenario_pnl_yen).toBe(yen(row.scenario.pnl));
      expect(r.rows[i].margin_yen).toBe(yen(rows[i]?.calc?.result.margin));
      expect(r.rows[i].room_yen).toBe(yen(rows[i]?.calc?.room));
    });
    expect(r.base.amount_yen).toBe(yen(m.tail.premiumBase.amount));
  });

  it('margin_summary: 証拠金のタイル（今・シナリオの点）', () => {
    const r = run(env, 'margin_summary');
    const { params, capital } = env.margin;
    const now = marginNow(base, env.scenario, params, capital, env.holidays);
    const pt = marginPoint(base, env.scenario, params, capital, env.holidays);
    expect(r.now.margin_yen).toBe(yen(now?.result.margin));
    expect(r.now.room_yen).toBe(yen(now?.room));
    expect(r.point.requirement_yen).toBe(yen(pt?.result.requirement));
    expect(r.capital_yen).toBe(capital);
    if (capital === null) expect(r.call_levels_x).toEqual([]);
  });

  it('evaluate_scenario: ΔX 0・日数 0・IV 0 の損益 = 舞台の今日の線の X₀ の値', () => {
    const r = run(env, 'evaluate_scenario', { dx_pct: 0, days: 0, iv_shift_pt: 0, skew_pt: 0 });
    const today = theoreticalPnl(
      base.legs,
      base.ctx.x0,
      { ...todayScenario(env.scenario), ivShift: 'absolute' },
      base.ctx,
      base.settings,
    );
    expect(r.pnl_yen).toBe(yen(today));
    expect(r.expiry_pnl_yen).toBe(yen(base.expiry(base.ctx.x0)));
  });

  it('scenario_grid: 軸と 3 次元の形・中央の点 = evaluate_scenario', () => {
    const r = run(env, 'scenario_grid');
    expect(r.dx_pct).toEqual([...GRID_DX_PCT]);
    expect(r.iv_shift_pt).toEqual([...GRID_IV_PT]);
    expect(r.days[0]).toBe(0);
    expect([...r.days].sort((a: number, b: number) => a - b)).toEqual(r.days);
    expect(r.pnl_yen).toHaveLength(r.days.length);
    for (const plane of r.pnl_yen) {
      expect(plane).toHaveLength(GRID_DX_PCT.length);
      for (const row of plane) expect(row).toHaveLength(GRID_IV_PT.length);
    }
    const ev = run(env, 'evaluate_scenario', { dx_pct: -5, days: 0, iv_shift_pt: 5 });
    expect(r.pnl_yen[0][1][2]).toBe(ev.pnl_yen);
  });
});

describe('ツールの境界', () => {
  const env = envOf('iron_condor');

  it('範囲外・形の違い・ツールの名前', () => {
    expect(runTool('evaluate_scenario', { dx_pct: -80, days: 0, iv_shift_pt: 0 }, env)).toEqual({
      error: 'out_of_range',
    });
    expect(runTool('evaluate_scenario', { days: 0, iv_shift_pt: 0 }, env)).toEqual({
      error: 'bad_input',
    });
    expect(
      runTool('evaluate_scenario', { dx_pct: 1, x: 60000, days: 0, iv_shift_pt: 0 }, env),
    ).toEqual({ error: 'bad_input' });
    expect(
      runTool('evaluate_scenario', { dx_pct: 1, days: 0, iv_shift_pt: 0, cmd: 1 }, env),
    ).toEqual({ error: 'bad_input' });
    expect(runTool('evaluate_scenario', { dx_pct: 1, days: 0, iv_shift_pt: 50 }, env)).toEqual({
      error: 'out_of_range',
    });
    expect(runTool('run_shell', {}, env)).toEqual({ error: 'unknown_tool' });
  });

  it('足 0 本は no_legs（スマイルは出す）', () => {
    const s = caseState(latest, { name: 'empty', label: '', legs: [] });
    const e = aiEnvFromState(s, DEFAULT_MARGIN_PREFS);
    if (!e) throw new Error('環境が無い');
    expect(e.base).toBeNull();
    const legFree = [
      'smile_position',
      'technicals',
      'iv_stats',
      'strike_scan',
      'structure_candidates',
      'propose_position',
      'strike_quote',
    ];
    for (const n of AI_TOOL_NAMES.filter((x) => !legFree.includes(x))) {
      expect(runTool(n, {}, e)).toEqual({ error: 'no_legs' });
    }
    // 提案のツール（#139）・strike_quote（#266）は足が無くても使える（入力が無ければ bad_input）
    for (const n of ['strike_scan', 'structure_candidates', 'propose_position', 'strike_quote']) {
      expect(runTool(n, {}, e)).toEqual({ error: 'bad_input' });
    }
    // technicals（#200）は足に依らない（先物の足が無ければ no_data）
    expect(runTool('technicals', {}, e)).toEqual({ error: 'no_data' });
    // iv_stats（#138・#158）も足に依らない（日次の値が無ければ no_data、あれば足 0 本でも結果）
    expect(runTool('iv_stats', {}, e)).toEqual({ error: 'no_data' });
    const days = [
      {
        d: '2026-10-13',
        t: 1_760_335_200,
        iv: 20,
        f1: 30000,
        l1: '2026-11-12',
        f2: null,
        l2: null,
      },
    ];
    const iv = run({ ...e, ivStats: { days, now: null } }, 'iv_stats', { sections: ['level'] });
    expect(iv.data.iv_now_pct).toBe(20);
    // ツールのカード（今の IV と 1 年の分位、HV20 と IV − HV、スパイクの回数）
    const card = toolCard(
      'iv_stats',
      {},
      {
        data: { iv_now_pct: 24.5, now_source: 'intraday' },
        level: { windows: [{ window: '1y', percentile_pct: 88.2 }] },
        hv: { windows: [{ days: 20, hv_pct: 15.7, iv_minus_hv_pt: 8.8 }] },
        spikes: { n: 3 },
      },
      'ok',
    );
    expect(card.title).toBe('IV の統計（過去）');
    expect(card.lines).toEqual([
      'IV 24.5%（今） · 1 年の分位 88.2%',
      'HV20 15.7% · IV − HV +8.8pt',
      'スパイク 3 回',
    ]);
    expect(
      toolCard('iv_stats', {}, { data: { iv_now_pct: 20, now_source: 'daily_close' } }, 'ok').lines,
    ).toEqual(['IV 20.0%（最後の確定日の終値）']);
    const sm = run(e, 'smile_position');
    expect(sm.expiries.length).toBe(2);
    expect(sm.legs).toEqual([]);
    expect(Object.keys(precompute(e))).toEqual(['smile_position']);
  });

  it('日数は最遠の SQ に収め、収めたことを返す', () => {
    const r = run(env, 'evaluate_scenario', { dx_pct: 2, days: 300, iv_shift_pt: 0 });
    expect(r.scenario.days_clamped).toBe(true);
    expect(r.scenario.days).toBeLessThan(40);
  });

  it('smile_position: 足の IV − ATM の IV（pt）と F に対する位置（%）', () => {
    const r = run(env, 'smile_position');
    for (const l of r.legs) {
      expect(l.iv_minus_atm_pt).toBeCloseTo(l.iv_pct - l.atm_iv_pct, 1);
      expect(Math.sign(l.moneyness_pct)).toBe(l.k > r.expiries[0].forward ? 1 : -1);
    }
  });

  it('事前計算は 5 本・同じ入力 → 同じ出力', () => {
    const a = precompute(env);
    expect(Object.keys(a).sort()).toEqual([...PRECOMPUTED_TOOLS].sort());
    expect(JSON.stringify(precompute(envOf('iron_condor')))).toBe(JSON.stringify(a));
  });

  it('[シナリオに適用] の値（evaluate_scenario の結果の日数・ΔX・Δσ・スキュー）', () => {
    const r = run(env, 'evaluate_scenario', { dx_pct: -6, days: 3, iv_shift_pt: 5, skew_pt: 1 });
    const x0 = env.base?.ctx.x0 ?? Number.NaN;
    const sc = scenarioOfResult(r, x0);
    expect(sc).not.toBeNull();
    expect(sc?.days).toBe(3);
    expect(sc?.dSigma).toBe(5);
    expect(sc?.skew).toBe(1);
    expect(Math.abs((sc?.dX ?? 0) - x0 * -0.06)).toBeLessThan(1);
    expect(scenarioOfResult({ error: 'x' }, x0)).toBeNull();
  });
});

describe('position_summary のカードの最大損失（#260）', () => {
  const card = (expiry: Record<string, unknown>) =>
    toolCard('position_summary', {}, { expiry, greeks_now: { delta_large: 0 } }, 'ok').lines[0];
  it('無限なら「無限」と put 側の値（put_side_max_loss_yen）', () => {
    expect(
      card({ max_loss_yen: null, max_loss_unbounded: true, put_side_max_loss_yen: -1_234_567 }),
    ).toBe('満期の最大損失 無限（put 側 −1,235 千円）');
  });
  it('有限ならその値', () => {
    expect(card({ max_loss_yen: -61_234, max_loss_unbounded: false })).toBe(
      '満期の最大損失 −61,234 円',
    );
  });
});

describe('strike_quote（#266）: 任意の行使価格のスマイルの IV・理論価格・気配', () => {
  const env = envOf('put_sell');
  const month = env.chain.months[0] as AiToolEnv['chain']['months'][number];

  it('板の行は画面の「理論価格（周りの行から）」と同じ数字（理論価格・使った IV・気配の中の位置）', () => {
    const ks = month.strikes.map((s) => s.k).filter((k) => k / month.F >= 0.3 && k / month.F <= 2);
    let compared = 0;
    for (let i = 0; i < ks.length; i += 10) {
      const r = run(env, 'strike_quote', { ks: ks.slice(i, i + 10), expiry: month.id });
      for (const row of r.rows) {
        const j = month.strikes.findIndex((s) => s.k === row.k);
        const info = month.strikes[j];
        const q = month.rows[j];
        if (!info || !q) throw new Error(`板に無い: ${row.k}`);
        const type = info.otmType;
        expect(row.type).toBe(type === 'put' ? 'P' : 'C');
        expect(row.on_board).toBe(true);
        expect(row.iv_unstable).toBe(info.unstable);
        expect(row.smile_iv_pct).toBe(
          info.smileIv === null ? null : Math.round(info.smileIv * 1000) / 10,
        );
        expect(row.smile_mark).toBe(info.mark);
        const view = fairView(month, row.k, type, env.chain.r, q[type].bid, q[type].ask);
        if (view === null) {
          expect(row.fair_yen).toBeNull();
          continue;
        }
        compared++;
        expect(fairPriceText(row.fair_yen)).toBe(view.price);
        expect(fmtNum(row.fair_iv_pct, 1)).toBe(view.iv);
        expect(
          row.fair_position === null
            ? null
            : FAIR_POSITION_LABEL[row.fair_position as keyof typeof FAIR_POSITION_LABEL],
        ).toBe(view.position);
        expect(row.fair_mark === 'extrapolated').toBe(view.extrapolated);
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it('板に無い行使価格（遠い OTM・行の間）も理論価格とスマイルの IV を出し、気配は null', () => {
    const F = month.F;
    const on = new Set(month.strikes.map((s) => s.k));
    const between = month.strikes.map((s) => s.k + 10).find((k) => !on.has(k) && k < F * 0.8);
    const beyond = Math.max(...on) + 5_000;
    if (between === undefined || beyond > F * 2) throw new Error('合成の板の前提が違う');
    const r = run(env, 'strike_quote', { ks: [beyond, between] });
    expect(r.expiry).toBe(month.id);
    expect(r.rows.map((x: { k: number }) => x.k)).toEqual([between, beyond]);
    for (const row of r.rows) {
      expect(row.on_board).toBe(false);
      expect(row.bid_yen).toBeNull();
      expect(row.ask_yen).toBeNull();
      expect(row.fair_position).toBeNull();
      expect(row.iv_unstable).toBeNull();
      expect(row.fair_yen).toBeGreaterThan(0);
      expect(row.smile_iv_pct).toBeGreaterThan(0);
    }
    expect(r.rows[0].type).toBe('P');
    expect(r.rows[1].type).toBe('C');
    expect(r.rows[1].smile_mark).toBe('extrapolated');
    // 理論価格の桁は画面と同じ（100 円未満は小数 1 桁、以上は整数）
    for (const row of r.rows) {
      const f = row.fair_yen as number;
      expect(f < 100 ? Math.round(f * 10) / 10 : Math.round(f)).toBe(f);
    }
  });

  it('種別の指定（ITM 側も可）と限月の指定', () => {
    const second = env.chain.months[1] as typeof month;
    const k = month.strikes.find((s) => s.k < month.F * 0.8)?.k as number;
    const r = run(env, 'strike_quote', { ks: [k], type: 'C', expiry: second.id });
    expect(r.expiry).toBe(second.id);
    expect(r.rows[0].type).toBe('C');
    expect(r.rows[0].fair_yen).toBeGreaterThan(100);
  });

  it('入力の誤り・範囲の外・板に無い限月', () => {
    const k = month.strikes[0]?.k as number;
    const bad = (input: Record<string, unknown>) => runTool('strike_quote', input, env);
    expect(bad({})).toEqual({ error: 'bad_input' });
    expect(bad({ ks: [] })).toEqual({ error: 'bad_input' });
    expect(bad({ ks: Array.from({ length: 11 }, (_, i) => k + i * 250) })).toEqual({
      error: 'bad_input',
    });
    expect(bad({ ks: [-1] })).toEqual({ error: 'bad_input' });
    expect(bad({ ks: [k], strike: k })).toEqual({ error: 'bad_input' });
    expect(bad({ ks: [k], type: 'put' })).toEqual({ error: 'bad_input' });
    expect(bad({ ks: [month.F * 0.29] })).toEqual({ error: 'out_of_range' });
    expect(bad({ ks: [month.F * 2.01] })).toEqual({ error: 'out_of_range' });
    expect(bad({ ks: [k], expiry: '2030-01' })).toEqual({ error: 'not_on_board' });
  });

  it('カード: 行ごとの理論価格（画面と同じ桁・位置の語）と気配、5 本目からは「ほか N 本」', () => {
    const result = {
      expiry: '2026-11',
      rows: [
        {
          k: 45000,
          type: 'P',
          on_board: true,
          fair_yen: 10,
          fair_iv_pct: 40.12,
          fair_mark: 'interpolated',
          bid_yen: 8,
          ask_yen: 12,
          fair_position: 'middle',
        },
        {
          k: 40000,
          type: 'P',
          on_board: true,
          fair_yen: 3.5,
          fair_iv_pct: 50,
          fair_mark: 'extrapolated',
          bid_yen: null,
          ask_yen: 4,
          fair_position: 'below_ask',
        },
        {
          k: 39500,
          type: 'P',
          on_board: false,
          fair_yen: 3.2,
          fair_iv_pct: 51,
          fair_mark: 'extrapolated',
          bid_yen: null,
          ask_yen: null,
          fair_position: null,
        },
        {
          k: 70000,
          type: 'C',
          on_board: true,
          fair_yen: 1002,
          fair_iv_pct: 23.9,
          fair_mark: 'interpolated',
          bid_yen: null,
          ask_yen: null,
          fair_position: null,
        },
        {
          k: 80000,
          type: 'C',
          on_board: true,
          fair_yen: null,
          fair_iv_pct: null,
          fair_mark: null,
          bid_yen: 1,
          ask_yen: 3,
          fair_position: null,
        },
      ],
    };
    const card = toolCard('strike_quote', { ks: [45000] }, result, 'ok');
    expect(card.title).toBe('行使価格の理論価格');
    expect(card.input).toBe('2026-11');
    expect(card.lines).toEqual([
      'P 45,000: 理論 10.0 円（IV 40.1%・気配の中ほど） · 気配 8 / 12',
      'P 40,000: 理論 3.5 円（IV 50.0%・ask より下・外挿） · 気配 — / 4',
      'P 39,500: 理論 3.2 円（IV 51.0%・外挿） · 板に無い',
      'C 70,000: 理論 1,002 円（IV 23.9%） · 気配なし',
      'ほか 1 本',
    ]);
    expect(toolCard('strike_quote', {}, { error: 'out_of_range' }, 'error').lines).toEqual([
      '計算できなかった（F から遠すぎる行使価格）',
    ]);
    // 足・行使価格の語を使わない理由（板に無い行使価格は受け付ける）
    expect(toolCard('strike_quote', {}, { error: 'bad_input' }, 'error').lines).toEqual([
      '計算できなかった（行使価格・種別・限月の指定の書式が違う）',
    ]);
    expect(toolCard('strike_quote', {}, { error: 'not_on_board' }, 'error').lines).toEqual([
      '計算できなかった（板に無い限月（またはスマイルが無い））',
    ]);
    // 提案のツールの文は変わらない
    expect(toolCard('strike_scan', {}, { error: 'bad_input' }, 'error').lines).toEqual([
      '計算できなかった（足の指定の書式が違う）',
    ]);
  });
});

describe('前の板で建てた足（#299 AC11）: position_summary のシナリオ点の損益 = 画面のシナリオ 0 の損益', () => {
  it('t₀ で建てて t₀ + 3 日の板で見る（含み損益から）', () => {
    const { t0, later } = boardsT0AndLater();
    const acts: Action[] = [
      { type: 'loaded', chain: t0, label: 't0' },
      { type: 'addBoardLeg', expiry: '2026-11', k: 64000, optionType: 'put', side: 'sell' },
      { type: 'addBoardLeg', expiry: '2026-12', k: 70000, optionType: 'call', side: 'buy' },
      { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
      { type: 'loaded', chain: later, label: 'later' },
    ];
    const s = acts.reduce(reduce, { ...initialState, feePerLot: 25 });
    const env = aiEnvFromState(s, DEFAULT_MARGIN_PREFS);
    if (!env?.base) throw new Error('環境が無い');
    const settings = { ...DEFAULT_SETTINGS, feePerLot: 25 };
    const pm = positionModel(later, s.legs, s.atmBasis, s.calendar, settings);
    const screen = evaluatePosition(pm.prepared, ZERO_SCENARIO, pm.ctx, settings).pnl;
    expect(Math.abs(screen)).toBeGreaterThan(1000);
    const r = run(env, 'position_summary');
    expect(r.scenario_point.pnl_yen).toBe(yen(screen));
  });
});

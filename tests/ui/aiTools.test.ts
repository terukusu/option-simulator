import { describe, expect, it } from 'vitest';
import { evaluatePosition, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
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
} from '../../ui/view/aiTools';
import { marginNow, marginPoint, marginTail } from '../../ui/view/margin';
import { metricsModel } from '../../ui/view/metrics';
import { todayScenario } from '../../ui/view/pnlChart';
import { fixture } from '../support/fixtures';

/**
 * #135 AC3: AI の道具（ui/view/aiTools.ts）。合成の板（fixtures/synthetic/latest.json）と合成のポジション 10 通り
 * （scripts/aiEvalCases.ts）で、道具の出力が画面の表示モデル（指標のタイル・テール表・証拠金）と同じ値。値は架空。
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

describe.each(AI_EVAL_CASES.map((c) => c.name))('道具 = 画面の表示モデル（%s）', (name) => {
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
    expect(r.expiry.max_loss_yen).toBe(
      yen(lossInf ? m.expiry.lossFinite?.value : m.expiry.maxLoss.value),
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

describe('道具の境界', () => {
  const env = envOf('iron_condor');

  it('範囲外・形の違い・道具の名前', () => {
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
    for (const n of AI_TOOL_NAMES.filter((x) => x !== 'smile_position' && x !== 'technicals')) {
      expect(runTool(n, {}, e)).toEqual({ error: 'no_legs' });
    }
    // technicals（#200）は足に依らない（先物の足が無ければ no_data）
    expect(runTool('technicals', {}, e)).toEqual({ error: 'no_data' });
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

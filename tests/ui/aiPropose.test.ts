import { describe, expect, it } from 'vitest';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { reduce, type State, type UiLeg } from '../../ui/state';
import { aiEnvFromState } from '../../ui/view/aiContext';
import {
  newTabPlan,
  newTabUndoActions,
  planProposal,
  proposalApply,
  proposalCard,
  SCAN_MAX_ROWS,
  STRUCTURES,
  strikeWidths,
} from '../../ui/view/aiPropose';
import { type AiToolEnv, isToolError, runTool, toolCard } from '../../ui/view/aiTools';
import { metricsModel } from '../../ui/view/metrics';
import { fixture } from '../support/fixtures';

/**
 * #139: AI のポジションの提案（ui/view/aiPropose.ts）。合成の板（fixtures/synthetic/latest.json）と合成のポジション
 * （scripts/aiEvalCases.ts）で、候補の生成・板の検査・前 → 後の要約・カード・反映の純関数。値は架空。
 */

const latest = fixture('latest');

function stateOf(name: string): State {
  const c = AI_EVAL_CASES.find((x) => x.name === name);
  if (!c) throw new Error(name);
  return caseState(latest, c);
}
function envOf(name: string, s: State = stateOf(name)): AiToolEnv {
  const c = AI_EVAL_CASES.find((x) => x.name === name);
  if (!c) throw new Error(name);
  const env = aiEnvFromState(s, caseMargin(c));
  if (!env) throw new Error(name);
  return env;
}
const run = (env: AiToolEnv, name: string, input: Record<string, unknown>) => {
  const r = runTool(name, input, env);
  if (isToolError(r)) throw new Error(`${name}: ${r.error}`);
  // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む（形は pytest が tools.py の形で検査する）
  return r as Record<string, any>;
};

describe('strike_scan（最大損失を下限に抑えるヘッジ）', () => {
  const env = envOf('put_ratio');
  const r = run(env, 'strike_scan', { type: 'P', side: 'buy', max_loss_floor_yen: -1_000_000 });

  it('板の両気配の行だけを評価し、行は上限まで・昇順', () => {
    expect(r.expiry).toBe('2026-11');
    expect(r.max_loss_floor_yen).toBe(-1_000_000);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThanOrEqual(SCAN_MAX_ROWS);
    const ks = r.rows.map((x: { k: number }) => x.k);
    expect([...ks].sort((a, b) => a - b)).toEqual(ks);
    const month = env.chain.months.find((m) => m.id === r.expiry);
    for (const k of ks) {
      const info = month?.strikes.find((s) => s.k === k);
      expect(info?.put.quote).toBe('two_sided');
    }
  });

  it('best_k は下限を満たし、その足を足した提案の後の最大損失も下限以上（AC3）', () => {
    expect(r.best_k).not.toBeNull();
    expect(r.before.max_loss_yen).toBeLessThan(-1_000_000);
    const row = r.rows.find((x: { k: number }) => x.k === r.best_k);
    expect(row.meets_floor).toBe(true);
    // 下限を満たす行の中で掛け金が最小（受払が最大）
    for (const x of r.rows.filter((y: { meets_floor: boolean }) => y.meets_floor)) {
      expect(x.leg_premium_yen).toBeLessThanOrEqual(row.leg_premium_yen);
    }
    const p = run(env, 'propose_position', {
      target: 'current',
      changes: [{ action: 'add', type: 'P', expiry: r.expiry, k: r.best_k, side: 'buy' }],
    });
    expect(p.after.max_loss_yen).toBe(row.max_loss_yen);
    expect(p.after.max_loss_yen).toBeGreaterThanOrEqual(-1_000_000);
    expect(p.after.max_loss_unbounded).toBe(false);
  });

  it('入力の検査（種別・下限の符号・板に無い限月）', () => {
    expect(runTool('strike_scan', { type: 'X', side: 'buy' }, env)).toEqual({ error: 'bad_input' });
    expect(runTool('strike_scan', { type: 'P', side: 'buy', max_loss_floor_yen: 5 }, env)).toEqual({
      error: 'bad_input',
    });
    expect(runTool('strike_scan', { type: 'P', side: 'buy', expiry: '2030-01' }, env)).toEqual({
      error: 'not_on_board',
    });
    expect(runTool('strike_scan', { type: 'P', side: 'buy', cmd: 1 }, env)).toEqual({
      error: 'bad_input',
    });
  });
});

describe('structure_candidates（組み合わせの候補）', () => {
  const env = envOf('strangle_sell');

  it.each(STRUCTURES)('%s: 板の行使価格・両気配の足だけで、単体の要約が画面の指標と同じ', (s) => {
    const r = run(env, 'structure_candidates', { structure: s });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThanOrEqual(5);
    const keys = new Set<string>();
    for (const c of r.candidates) {
      const key = JSON.stringify(c.legs);
      expect(keys.has(key)).toBe(false);
      keys.add(key);
      // 同じ足を new_tab で提案すると同じ要約
      const p = run(env, 'propose_position', {
        target: 'new_tab',
        legs: c.legs.map(({ entry_yen: _e, ...l }: Record<string, unknown>) => l),
      });
      expect(p.after).toEqual(c.summary);
      expect(p.before).toBeNull();
    }
  });

  it('短い足の |Δ| が大きいほど受取が増える（ストラングル売り）', () => {
    const r = run(env, 'structure_candidates', { structure: 'short_strangle' });
    const nets = r.candidates.map(
      (c: { summary: { premium_net_yen: number } }) => c.summary.premium_net_yen,
    );
    for (let i = 1; i < nets.length; i++) expect(nets[i]).toBeGreaterThan(nets[i - 1]);
    expect(r.candidates[0].summary.max_loss_unbounded).toBe(true);
    expect(r.candidates[0].summary.max_loss_yen).toBeNull();
    expect(r.candidates[0].shocks).toHaveLength(4);
  });

  it('入力の検査', () => {
    expect(runTool('structure_candidates', { structure: 'butterfly' }, env)).toEqual({
      error: 'bad_input',
    });
    expect(runTool('structure_candidates', { structure: 'bull_put', wing_pct: 30 }, env)).toEqual({
      error: 'bad_input',
    });
  });
});

describe('propose_position（板の検査と前 → 後）', () => {
  const s = stateOf('put_ratio');
  const env = envOf('put_ratio', s);

  it('板に無い行使価格・限月は not_on_board、番号・枚数・組の違いは bad_input（AC2）', () => {
    const bad = (input: Record<string, unknown>) => runTool('propose_position', input, env);
    const add = { action: 'add', type: 'P', expiry: '2026-11', side: 'buy' };
    expect(bad({ target: 'current', changes: [{ ...add, k: 1234 }] })).toEqual({
      error: 'not_on_board',
    });
    expect(bad({ target: 'current', changes: [{ ...add, k: 60000, expiry: '2027-03' }] })).toEqual({
      error: 'not_on_board',
    });
    expect(
      bad({ target: 'current', changes: [{ action: 'move_strike', leg_no: 1, k: 66010 }] }),
    ).toEqual({ error: 'not_on_board' });
    expect(bad({ target: 'current', changes: [{ action: 'remove', leg_no: 4 }] })).toEqual({
      error: 'bad_input',
    });
    expect(bad({ target: 'current', changes: [{ action: 'set_qty', leg_no: 1, qty: 0 }] })).toEqual(
      {
        error: 'bad_input',
      },
    );
    expect(
      bad({
        target: 'current',
        changes: [
          { action: 'remove', leg_no: 1 },
          { action: 'set_qty', leg_no: 1, qty: 3 },
        ],
      }),
    ).toEqual({ error: 'bad_input' });
    expect(bad({ target: 'new_tab', changes: [{ action: 'remove', leg_no: 1 }] })).toEqual({
      error: 'bad_input',
    });
    // 全部を消す提案は出さない
    expect(
      bad({
        target: 'current',
        changes: [1, 2, 3].map((n) => ({ action: 'remove', leg_no: n })),
      }),
    ).toEqual({ error: 'bad_input' });
    // 失敗はカードにしない（1 行の理由だけ）
    expect(proposalCard({ target: 'current' }, { error: 'not_on_board' })).toBeNull();
    expect(toolCard('propose_position', {}, { error: 'not_on_board' }, 'error').lines).toEqual([
      '提案を作れなかった（板に無い限月・行使価格）',
    ]);
  });

  it('差分（削除・行使価格・枚数・追加）を作業中の足に当て、残る足は UiLeg のまま', () => {
    const input = {
      target: 'current',
      changes: [
        { action: 'remove', leg_no: 3 },
        { action: 'move_strike', leg_no: 1, k: 65500 },
        { action: 'set_qty', leg_no: 2, qty: 2 },
        { action: 'add', type: 'P', expiry: '2026-11', k: 60000, side: 'buy', qty: 1 },
      ],
    };
    const plan = planProposal(env, input);
    if ('error' in plan) throw new Error(plan.error);
    const [a, b, c] = plan.legs as [UiLeg, UiLeg, UiLeg];
    expect(plan.legs).toHaveLength(3);
    expect(a.id).toBe(s.legs[0]?.id);
    expect(a.leg.kind === 'option' && a.leg.strike).toBe(65500);
    expect(b.leg.qty).toBe(2);
    expect(b.leg.entry).toBe(s.legs[1]?.leg.entry);
    expect(c.id).toBe(4);
    expect(c.leg.kind === 'option' && [c.leg.strike, c.leg.side]).toEqual([60000, 'buy']);
    const r = run(env, 'propose_position', input);
    expect(r.diff.map((d: { change: string }) => d.change)).toEqual([
      'remove',
      'strike',
      'qty',
      'add',
    ]);
    expect(r.diff[1]).toMatchObject({ leg_no: 1, from_k: 66000, k: 65500 });
    expect(r.diff[2]).toMatchObject({ leg_no: 2, from_qty: 1, qty: 2 });
    expect(r.legs_before).toHaveLength(3);
    // 前 → 後の要約は画面の指標（反映した state）と同じ
    const applied = reduce(s, {
      type: 'replaceLegs',
      legs: plan.legs,
      expect: s.legs,
      tab: s.activeTab,
    });
    const envAfter = envOf('put_ratio', applied);
    const m = metricsModel({ base: envAfter.base, scenario: applied.scenario, unit: 'yen' });
    expect(r.after.max_loss_yen).toBe(Math.round(m.expiry.maxLoss.value));
    expect(r.after.n_legs).toBe(3);
    expect(run(envAfter, 'position_summary', {}).greeks_now.delta_large).toBe(r.after.delta_large);
  });

  it('先物の足は板の先物の限月だけ', () => {
    const e = envOf('mini_future_put');
    const ok = run(e, 'propose_position', {
      target: 'current',
      changes: [{ action: 'add', product: 'fut_mini', side: 'buy', qty: 1 }],
    });
    expect(ok.diff[0]).toMatchObject({ product: 'fut_mini', expiry: e.chain.future.id });
    expect(
      runTool(
        'propose_position',
        {
          target: 'current',
          changes: [{ action: 'add', product: 'fut_mini', side: 'buy', expiry: '2030-03' }],
        },
        e,
      ),
    ).toEqual({ error: 'not_on_board' });
  });
});

describe('カードと反映（AC4）', () => {
  const s = stateOf('put_ratio');
  const env = envOf('put_ratio', s);
  const input = {
    target: 'current',
    changes: [{ action: 'add', type: 'P', expiry: '2026-11', k: 59500, side: 'buy' }],
  };
  const result = run(env, 'propose_position', input);

  it('カード: 差分（＋）と前 → 後の最大損失・必要証拠金・Δ（ラージ / ミニ）・ボタン', () => {
    const card = proposalCard(input, result);
    expect(card?.title).toBe('ポジションの提案（今のタブ）');
    expect(card?.button).toBe('今のタブに適用');
    expect(card?.lines).toEqual([
      { mark: '+', text: expect.stringContaining('2026-11 P 59,500 買 ×1') },
    ]);
    expect(card?.metrics[0]).toMatch(/^満期の最大損失 .+ → .+千円$/);
    expect(card?.metrics[1]).toMatch(/^必要証拠金 /);
    expect(card?.metrics[2]).toMatch(/^Δ .+ 枚（ミニ .+ 枚） → .+ 枚（ミニ .+ 枚）$/);
    // 入力と結果の target が違えばカードにしない
    expect(proposalCard({ ...input, target: 'new_tab' }, result)).toBeNull();
  });

  it('反映: 押した時点の state から作り直して置き換え、[元に戻す] で戻る', () => {
    const r = proposalApply(env, input, result);
    if ('error' in r) throw new Error(r.error);
    expect(r.target).toBe('current');
    const after = reduce(s, {
      type: 'replaceLegs',
      legs: r.legs,
      expect: s.legs,
      tab: s.activeTab,
    });
    expect(after.legs).toHaveLength(4);
    expect(after.nextId).toBe(5);
    const undone = reduce(after, {
      type: 'replaceLegs',
      legs: s.legs,
      expect: r.legs,
      tab: s.activeTab,
    });
    expect(undone.legs).toEqual(s.legs);
    // 別のタブ・足が変わった後の [元に戻す] は何もしない
    expect(reduce(after, { type: 'replaceLegs', legs: s.legs, expect: r.legs, tab: 99 })).toBe(
      after,
    );
    const edited = reduce(after, { type: 'removeLeg', id: 4 });
    expect(
      reduce(edited, { type: 'replaceLegs', legs: s.legs, expect: r.legs, tab: s.activeTab }),
    ).toBe(edited);
  });

  it('提案の後にポジションが変わっていたら反映しない（changed）', () => {
    const moved = reduce(s, { type: 'removeLeg', id: 3 });
    expect(proposalApply(envOf('put_ratio', moved), input, result)).toEqual({ error: 'changed' });
    expect(proposalApply(env, input, { error: 'bad_input' })).toEqual({ error: 'invalid' });
    expect(proposalApply(null, input, result)).toEqual({ error: 'invalid' });
  });

  it('新しいタブ: 足は今のタブに依らず、タブを足して入れる', () => {
    const e = envOf('strangle_sell');
    const c = run(e, 'structure_candidates', { structure: 'iron_condor' }).candidates[0];
    const inNew = {
      target: 'new_tab',
      legs: c.legs.map(({ entry_yen: _e, ...l }: Record<string, unknown>) => l),
    };
    const res = run(e, 'propose_position', inNew);
    const card = proposalCard(inNew, res);
    expect(card?.button).toBe('新しいタブに入れる');
    expect(card?.lines.every((l) => l.mark === '+')).toBe(true);
    expect(card?.metrics[0]).not.toContain('→');
    // 今のタブが変わっても反映できる
    const moved = reduce(stateOf('strangle_sell'), { type: 'clearLegs' });
    const r = proposalApply(envOf('strangle_sell', moved), inNew, res);
    if ('error' in r) throw new Error(r.error);
    const st = reduce(moved, {
      type: 'openPositionInNewTab',
      legs: r.legs.map(({ id: _id, ...rest }) => rest),
      scenario: null,
      feePerLot: null,
      futureBasis: null,
    });
    expect(st.tabs).toHaveLength(2);
    expect(st.legs).toHaveLength(4);
  });
});

describe('k を省いて simulator が選ぶ（1 回の往復で提案まで）', () => {
  it('max_loss_floor_yen: strike_scan の best_k と同じ K、後の最大損失は下限以上', () => {
    const env = envOf('put_ratio');
    const scan = run(env, 'strike_scan', {
      type: 'P',
      side: 'buy',
      max_loss_floor_yen: -1_000_000,
    });
    const r = run(env, 'propose_position', {
      target: 'current',
      changes: [{ action: 'add', type: 'P', side: 'buy', max_loss_floor_yen: -1_000_000 }],
    });
    expect(r.diff[0]).toMatchObject({ k: scan.best_k, picked_by: 'floor', expiry: scan.expiry });
    expect(r.after.max_loss_yen).toBeGreaterThanOrEqual(-1_000_000);
    expect(proposalCard({ target: 'current' }, r)?.lines[0]?.text).toContain(
      '最大損失の下限から選んだ K',
    );
    // 満たす行が無ければ no_candidate、k と一緒・両方の指定は bad_input
    const bad = (c: Record<string, unknown>) =>
      runTool(
        'propose_position',
        { target: 'current', changes: [{ action: 'add', type: 'P', side: 'buy', ...c }] },
        env,
      );
    expect(bad({ max_loss_floor_yen: -1 })).toEqual({ error: 'no_candidate' });
    expect(bad({ max_loss_floor_yen: -1_000_000, k: 59500 })).toEqual({ error: 'bad_input' });
    expect(bad({ max_loss_floor_yen: -1_000_000, abs_delta: 0.1 })).toEqual({ error: 'bad_input' });
    expect(bad({ abs_delta: 0.9 })).toEqual({ error: 'bad_input' });
  });

  it('candidate: structure_candidates の同じ |Δ| の候補と同じ足', () => {
    const env = envOf('strangle_sell');
    const c = run(env, 'structure_candidates', { structure: 'iron_condor' }).candidates.find(
      (x: { target_abs_delta: number }) => x.target_abs_delta === 0.15,
    );
    const r = run(env, 'propose_position', {
      target: 'new_tab',
      candidate: { structure: 'iron_condor', abs_delta: 0.15 },
    });
    expect(r.diff.map((d: Record<string, unknown>) => d.k)).toEqual(
      c.legs.map((l: { k: number }) => l.k),
    );
    expect(r.after).toEqual(c.summary);
  });

  it('反映: 押した時点の板で選び直した足がカードと違えば changed', () => {
    const env = envOf('put_ratio');
    const input = {
      target: 'current',
      changes: [{ action: 'add', type: 'P', side: 'buy', max_loss_floor_yen: -1_000_000 }],
    };
    const r = run(env, 'propose_position', input);
    expect('error' in proposalApply(env, input, r)).toBe(false);
    const forged = { ...r, diff: [{ ...r.diff[0], k: r.diff[0].k - 250 }] };
    expect(proposalApply(env, input, forged)).toEqual({ error: 'changed' });
  });
});

describe('[新しいタブに入れる] の [元に戻す]（#139 レビュー B1）', () => {
  // [A, B] の 2 タブで A を開いている（B は空）
  const a = stateOf('strangle_sell');
  const twoTabs = reduce(reduce(a, { type: 'addTab', mode: 'empty' }), {
    type: 'switchTab',
    id: 1,
  });
  const env = envOf('strangle_sell', twoTabs);
  const input = { target: 'new_tab', candidate: { structure: 'iron_condor', abs_delta: 0.15 } };
  const r = proposalApply(env, input, run(env, 'propose_position', input));
  if ('error' in r) throw new Error(r.error);
  const plan = newTabPlan(twoTabs, r.legs);
  if (!plan) throw new Error('plan');
  const applied = reduce(twoTabs, plan.action);
  const undoAll = (s: State) => {
    const acts = newTabUndoActions(s, plan.undo);
    if (typeof acts === 'string') throw new Error(acts);
    return acts.reduce(reduce, s);
  };

  it('足したタブは元のタブの右隣で開き、[元に戻す] で元のタブに戻って足したタブだけ閉じる', () => {
    expect(twoTabs.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(applied.tabs.map((t) => t.id)).toEqual([1, 3, 2]);
    expect(applied.activeTab).toBe(3);
    const back = undoAll(applied);
    expect(back.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(back.activeTab).toBe(1);
    expect(back.legs).toEqual(twoTabs.legs);
    expect(back.pnlViewport).toEqual(twoTabs.pnlViewport);
  });

  it('別のタブに移ってから押しても、押したときのタブに戻る', () => {
    const moved = reduce(applied, { type: 'switchTab', id: 2 });
    const back = undoAll(moved);
    expect(back.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(back.activeTab).toBe(1);
    expect(back.legs).toEqual(twoTabs.legs);
  });

  it('足したタブを編集していたら戻さない（edited）・もう閉じていたら gone', () => {
    const edited = reduce(applied, { type: 'removeLeg', id: 1 });
    expect(newTabUndoActions(edited, plan.undo)).toBe('edited');
    // 別のタブに移っても編集は退避した足で分かる
    expect(newTabUndoActions(reduce(edited, { type: 'switchTab', id: 1 }), plan.undo)).toBe(
      'edited',
    );
    expect(newTabUndoActions(reduce(applied, { type: 'closeTab', id: 3 }), plan.undo)).toBe('gone');
  });

  it('タブが上限なら計画は null', () => {
    let full = twoTabs;
    for (let i = 0; i < 10; i++) full = reduce(full, { type: 'addTab', mode: 'empty' });
    expect(newTabPlan(full, r.legs)).toBeNull();
  });
});

describe('検査の細部（#139 レビュー L2・L4）', () => {
  const env = envOf('put_ratio');
  it('set_qty・move_strike に関係の無いキーは bad_input', () => {
    const one = (c: Record<string, unknown>) =>
      runTool('propose_position', { target: 'current', changes: [c] }, env);
    expect(one({ action: 'set_qty', leg_no: 1, qty: 2, expiry: '2026-11' })).toEqual({
      error: 'bad_input',
    });
    expect(one({ action: 'move_strike', leg_no: 1, k: 65500, type: 'P' })).toEqual({
      error: 'bad_input',
    });
  });
  it('structure_candidates の枚数は 2 倍の足でも上限を越えない', () => {
    expect(
      runTool(
        'structure_candidates',
        { structure: 'put_ratio', qty: 60_000 },
        envOf('strangle_sell'),
      ),
    ).toEqual({ error: 'bad_input' });
  });
});

describe('形の幅（#260。AI が行使価格の差を自分で引かずに写す）', () => {
  const op = (type: 'put' | 'call', strike: number, side: 'buy' | 'sell', expiry = '2026-11') => ({
    leg: {
      kind: 'option' as const,
      product: 'op_large' as const,
      type,
      expiry,
      strike,
      side,
      qty: 1,
      entry: 100,
    },
  });
  it('アイアンコンドル: put・call の翼の幅と売りの間', () => {
    expect(
      strikeWidths([
        op('put', 61000, 'buy'),
        op('put', 63000, 'sell'),
        op('call', 71000, 'sell'),
        op('call', 72500, 'buy'),
      ]),
    ).toEqual({ put_width_x: 2000, call_width_x: 1500, short_gap_x: 8000 });
  });
  it('put_ratio（1 買 2 売）は縦の幅、ストラドルは間 0、決まらない形は null', () => {
    expect(strikeWidths([op('put', 66000, 'buy'), op('put', 63000, 'sell')])).toEqual({
      put_width_x: 3000,
      call_width_x: null,
      short_gap_x: null,
    });
    expect(strikeWidths([op('put', 67000, 'sell'), op('call', 67000, 'sell')]).short_gap_x).toBe(0);
    // 同じ売買だけ・行使価格が 3 つ・2 限月は幅を出さない
    expect(
      strikeWidths([op('put', 62000, 'sell'), op('put', 63000, 'sell')]).put_width_x,
    ).toBeNull();
    expect(
      strikeWidths([op('put', 60000, 'buy'), op('put', 63000, 'sell'), op('put', 66000, 'buy')])
        .put_width_x,
    ).toBeNull();
    expect(strikeWidths([op('put', 61000, 'buy'), op('put', 63000, 'sell', '2026-12')])).toEqual({
      put_width_x: null,
      call_width_x: null,
      short_gap_x: null,
    });
  });
  it('structure_candidates の iron_condor の要約の幅 = 候補の足の行使価格の差', () => {
    const env = envOf('iron_condor');
    const r = run(env, 'structure_candidates', { structure: 'iron_condor' });
    for (const c of r.candidates) {
      const k = (t: string, side: string) =>
        c.legs.find((l: { type: string; side: string }) => l.type === t && l.side === side).k;
      expect(c.summary.put_width_x).toBe(k('P', 'sell') - k('P', 'buy'));
      expect(c.summary.call_width_x).toBe(k('C', 'buy') - k('C', 'sell'));
      expect(c.summary.short_gap_x).toBe(k('C', 'sell') - k('P', 'sell'));
    }
  });
});

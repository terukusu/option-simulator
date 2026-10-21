/**
 * ツールの出力の見本 fixtures/synthetic/ai_tools.json（#135 AC3）。合成の板 latest と合成のポジション 4 つ
 * （scripts/aiEvalCases.ts）で、画面と同じ組み立て（ui/view/aiContext.ts の aiEnvFromState・buildAiContext）の文脈
 * （事前計算 5 本を含む）と evaluate_scenario の結果・失敗を書く。中継の pytest（api/tests/test_ai_tools.py）が
 * 名前の集合・結果の形・文脈の形を tools.py / allowlist.py に通す = 言語をまたぐ契約。値はすべて架空。
 */

import { validateAtmDailyJson } from '../data/atmDaily';
import { validateAtmIvJson } from '../data/atmIv';
import type { ChainJson } from '../data/chainTypes';
import { ivNowOf } from '../ui/components/ivStatsData';
import { aiEnvFromState, buildAiContext } from '../ui/view/aiContext';
import type { IvStatsData } from '../ui/view/aiIvStats';
import { STRUCTURES } from '../ui/view/aiPropose';
import { AI_TOOL_NAMES, runTool } from '../ui/view/aiTools';
import { AI_EVAL_CASES, caseMargin, caseState } from './aiEvalCases';
import { SYNTH_IV_NOW, synthAtmDaily, synthAtmIv } from './devFixtures.mjs';
import { synthTechnicalsData } from './synthFutBars';

export const AI_TOOLS_FIXTURE_CASES = ['put_sell', 'iron_condor', 'mini_future_put', 'calendar'];

const EVAL_INPUTS: Record<string, unknown>[] = [
  { dx_pct: -6, days: 3, iv_shift_pt: 5 },
  { x: 66000, days: 0, iv_shift_pt: 0, skew_pt: 1 },
  { dx_pct: 4, days: 120, iv_shift_pt: -3 },
];
const ERROR_INPUTS: Record<string, unknown>[] = [
  { dx_pct: -80, days: 0, iv_shift_pt: 0 },
  { days: 0, iv_shift_pt: 0 },
  { dx_pct: 1, x: 66000, days: 0, iv_shift_pt: 0 },
];

const TECH_INPUTS: Record<string, unknown>[] = [
  {},
  { timeframes: ['daily'], indicators: ['rsi'] },
  { timeframes: ['4h', 'weekly'], indicators: ['macd', 'stoch'], horizon_bars: 3 },
  // #206 EMA の 3 本だけ
  { timeframes: ['weekly'], indicators: ['ema'] },
];
const TECH_ERROR_INPUTS: Record<string, unknown>[] = [{ timeframes: ['1m'] }, { horizon_bars: 30 }];

const IV_STATS_INPUTS: Record<string, unknown>[] = [
  {},
  { sections: ['spikes'], spike_rise_pct: 20 },
  { sections: ['moves', 'hv'] },
];
const IV_STATS_ERROR_INPUTS: Record<string, unknown>[] = [
  { sections: ['iv'] },
  { spike_rise_pct: 5 },
];

/** iv_stats（#138・#158）の合成のデータ（dev の /fixtures/atm_daily と /fixtures/atm_iv の 1 時間足の右端。架空の値） */
export function synthIvStatsData(withNow = true): IvStatsData {
  const daily = validateAtmDailyJson(synthAtmDaily(SYNTH_IV_NOW));
  if (!daily.ok) throw new Error('合成の日次の値が検証に通らない');
  const iv = validateAtmIvJson(synthAtmIv('1h', null, SYNTH_IV_NOW), '1h');
  if (!iv.ok) throw new Error('合成の IV 推移が検証に通らない');
  return { days: daily.value.days, now: withNow ? ivNowOf(iv.value) : null };
}

function fail(): never {
  throw new Error('ツールの環境を作れない');
}

export function buildAiToolsFixture(latest: ChainJson): string {
  const cases = AI_TOOLS_FIXTURE_CASES.map((name) => {
    const c = AI_EVAL_CASES.find((x) => x.name === name);
    if (!c) throw new Error(`評価の組が無い: ${name}`);
    const env = aiEnvFromState(caseState(latest, c), caseMargin(c));
    if (!env) throw new Error(`ツールの環境を作れない: ${name}`);
    return {
      name,
      context: buildAiContext(env),
      evaluate: EVAL_INPUTS.map((input) => ({
        input,
        result: runTool('evaluate_scenario', input, env),
      })),
      errors: ERROR_INPUTS.map((input) => ({
        input,
        result: runTool('evaluate_scenario', input, env),
      })),
    };
  });
  // technicals（#200）: 合成の先物の足（scripts/synthFutBars.ts。架空の値）
  const techEnv = {
    ...(aiEnvFromState(
      caseState(latest, AI_EVAL_CASES[0] as (typeof AI_EVAL_CASES)[number]),
      caseMargin(AI_EVAL_CASES[0] as (typeof AI_EVAL_CASES)[number]),
    ) ?? fail()),
    technicals: synthTechnicalsData(),
  };
  const technicals = {
    results: TECH_INPUTS.map((input) => ({ input, result: runTool('technicals', input, techEnv) })),
    errors: [
      ...TECH_ERROR_INPUTS.map((input) => ({
        input,
        result: runTool('technicals', input, techEnv),
      })),
      { input: {}, result: runTool('technicals', {}, { ...techEnv, technicals: null }) },
    ],
  };
  // iv_stats（#138・#158）: 合成の日次の値と今の IV（架空の値）
  const ivEnv = { ...techEnv, ivStats: synthIvStatsData() };
  const ivStats = {
    results: [
      ...IV_STATS_INPUTS.map((input) => ({ input, result: runTool('iv_stats', input, ivEnv) })),
      // 今の IV が読めない（最後の日次の終値で代える）
      {
        input: { sections: ['level'] },
        result: runTool(
          'iv_stats',
          { sections: ['level'] },
          { ...ivEnv, ivStats: synthIvStatsData(false) },
        ),
      },
    ],
    errors: [
      ...IV_STATS_ERROR_INPUTS.map((input) => ({
        input,
        result: runTool('iv_stats', input, ivEnv),
      })),
      { input: {}, result: runTool('iv_stats', {}, { ...ivEnv, ivStats: null }) },
    ],
  };
  // 提案のツール（#139）: レシオ（1 買 2 売）のヘッジの探索と差分、ストラングル売りの文脈の組み合わせの候補と丸ごと
  const envOf = (name: string) => {
    const c = AI_EVAL_CASES.find((x) => x.name === name);
    if (!c) throw new Error(`評価の組が無い: ${name}`);
    return aiEnvFromState(caseState(latest, c), caseMargin(c)) ?? fail();
  };
  const ratio = envOf('put_ratio');
  const scanIn = { type: 'P', side: 'buy', max_loss_floor_yen: -1_000_000 };
  const scan = runTool('strike_scan', scanIn, ratio) as Record<string, unknown>;
  const scanBest = typeof scan.best_k === 'number' ? scan.best_k : fail();
  const strangle = envOf('strangle_sell');
  const candIns = STRUCTURES.map((structure) => ({ structure }));
  const cands = candIns.map((input) => ({
    input,
    result: runTool('structure_candidates', input, strangle),
  }));
  const first = (cands[2]?.result as { candidates?: { legs: Record<string, unknown>[] }[] })
    ?.candidates?.[0];
  const newTabLegs = (first ?? fail()).legs.map(({ entry_yen: _e, ...l }) => l);
  const proposeIns: [string, Record<string, unknown>][] = [
    [
      'put_ratio',
      {
        target: 'current',
        changes: [
          {
            action: 'add',
            product: 'op',
            type: 'P',
            expiry: scan.expiry,
            k: scanBest,
            side: 'buy',
          },
        ],
      },
    ],
    [
      'put_ratio',
      {
        target: 'current',
        changes: [
          { action: 'remove', leg_no: 3 },
          { action: 'move_strike', leg_no: 1, k: 65500 },
        ],
      },
    ],
    ['iron_condor', { target: 'current', changes: [{ action: 'set_qty', leg_no: 2, qty: 2 }] }],
    [
      'mini_future_put',
      { target: 'current', changes: [{ action: 'add', product: 'fut_mini', side: 'buy', qty: 1 }] },
    ],
    ['strangle_sell', { target: 'new_tab', legs: newTabLegs }],
    // k を省いて simulator に選ばせる（1 回の往復で提案まで）
    [
      'put_ratio',
      {
        target: 'current',
        changes: [{ action: 'add', type: 'P', side: 'buy', max_loss_floor_yen: -1_000_000 }],
      },
    ],
    [
      'iron_condor',
      { target: 'current', changes: [{ action: 'add', type: 'P', side: 'buy', abs_delta: 0.05 }] },
    ],
    [
      'strangle_sell',
      { target: 'new_tab', candidate: { structure: 'iron_condor', abs_delta: 0.15 } },
    ],
  ];
  const proposeErrors: [string, Record<string, unknown>][] = [
    [
      'put_ratio',
      {
        target: 'current',
        changes: [{ action: 'add', type: 'P', expiry: scan.expiry, k: 1234, side: 'buy' }],
      },
    ],
    ['put_ratio', { target: 'current', changes: [{ action: 'remove', leg_no: 9 }] }],
    ['put_ratio', { target: 'new_tab', changes: [{ action: 'remove', leg_no: 1 }] }],
    [
      'put_ratio',
      {
        target: 'current',
        changes: [{ action: 'add', type: 'P', side: 'buy', max_loss_floor_yen: -1 }],
      },
    ],
    [
      'strangle_sell',
      { target: 'new_tab', legs: newTabLegs, candidate: { structure: 'short_put' } },
    ],
  ];
  const propose = {
    scan: [
      { input: scanIn, result: scan },
      {
        input: { type: 'C', side: 'buy', qty: 2 },
        result: runTool('strike_scan', { type: 'C', side: 'buy', qty: 2 }, ratio),
      },
    ],
    scan_errors: [
      { type: 'X', side: 'buy' },
      { type: 'P', side: 'buy', expiry: '2030-01' },
    ].map((input) => ({ input, result: runTool('strike_scan', input, ratio) })),
    candidates: cands,
    candidate_errors: [{ structure: 'butterfly' }, { structure: 'iron_condor', wing_pct: 30 }].map(
      (input) => ({ input, result: runTool('structure_candidates', input, strangle) }),
    ),
    proposals: proposeIns.map(([name, input]) => ({
      case: name,
      input,
      result: runTool('propose_position', input, envOf(name)),
    })),
    proposal_errors: proposeErrors.map(([name, input]) => ({
      case: name,
      input,
      result: runTool('propose_position', input, envOf(name)),
    })),
  };
  return `${JSON.stringify({ schema_version: 1, tools: AI_TOOL_NAMES, cases, technicals, iv_stats: ivStats, propose }, null, 1)}\n`;
}

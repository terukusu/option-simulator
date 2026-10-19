/**
 * 道具の出力の見本 fixtures/synthetic/ai_tools.json（#135 AC3）。合成の板 latest と合成のポジション 4 つ
 * （scripts/aiEvalCases.ts）で、画面と同じ組み立て（ui/view/aiContext.ts の aiEnvFromState・buildAiContext）の文脈
 * （事前計算 5 本を含む）と evaluate_scenario の結果・失敗を書く。中継の pytest（api/tests/test_ai_tools.py）が
 * 名前の集合・結果の形・文脈の形を tools.py / allowlist.py に通す = 言語をまたぐ契約。値はすべて架空。
 */

import type { ChainJson } from '../data/chainTypes';
import { aiEnvFromState, buildAiContext } from '../ui/view/aiContext';
import { AI_TOOL_NAMES, runTool } from '../ui/view/aiTools';
import { AI_EVAL_CASES, caseMargin, caseState } from './aiEvalCases';

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

export function buildAiToolsFixture(latest: ChainJson): string {
  const cases = AI_TOOLS_FIXTURE_CASES.map((name) => {
    const c = AI_EVAL_CASES.find((x) => x.name === name);
    if (!c) throw new Error(`評価の組が無い: ${name}`);
    const env = aiEnvFromState(caseState(latest, c), caseMargin(c));
    if (!env) throw new Error(`道具の環境を作れない: ${name}`);
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
  return `${JSON.stringify({ schema_version: 1, tools: AI_TOOL_NAMES, cases }, null, 1)}\n`;
}

import { describe, expect, it } from 'vitest';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { reduce } from '../../ui/state';
import { aiEnvFromState, buildAiContext, contextKey } from '../../ui/view/aiContext';
import { fixture } from '../support/fixtures';

/** #135: AI に送る文脈（ui/view/aiContext.ts）。許可リストのキーだけ・指紋。合成の板・架空の値。 */

const latest = fixture('latest');
const c = AI_EVAL_CASES.find((x) => x.name === 'strangle_sell');
if (!c) throw new Error('組が無い');
const state = caseState(latest, c);

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  }
  return out;
}

describe('buildAiContext', () => {
  const env = aiEnvFromState(state, caseMargin(c));
  if (!env) throw new Error('環境が無い');
  const ctx = buildAiContext(env);

  it('許可リストの形（JPX のグリーク・気配の IV・数量・板の行・自由な文字列を送らない）', () => {
    const top = Object.keys(ctx).sort();
    expect(top).toEqual(['capital', 'expiries', 'position', 'precomputed', 'scenario', 'snapshot']);
    const keys = keysOf(ctx);
    for (const k of ['bid_iv', 'ask_iv', 'volume', 'positions', 'open_interest', 'delta', 'name']) {
      expect(keys.has(k)).toBe(false);
    }
    // 板の行（気配）は送らない（MVP）
    for (const e of ctx.expiries ?? []) expect(e.rows).toBeUndefined();
    expect(ctx.position?.legs).toHaveLength(2);
    expect(ctx.snapshot.source).toBe('synthetic');
    expect(ctx.expiries?.[0]?.smile).toHaveLength(11);
    expect(ctx.capital).toEqual({ capital_yen: 8_000_000 });
  });

  it('指紋: 同じ状態 → 同じ文字列。シナリオが変われば変わる', () => {
    const again = buildAiContext(aiEnvFromState(state, caseMargin(c)) as NonNullable<typeof env>);
    expect(contextKey(again)).toBe(contextKey(ctx));
    const moved = reduce(state, { type: 'setScenario', patch: { days: 7 } });
    const ctx2 = buildAiContext(aiEnvFromState(moved, caseMargin(c)) as NonNullable<typeof env>);
    expect(contextKey(ctx2)).not.toBe(contextKey(ctx));
    expect(ctx2.scenario?.days).toBe(7);
  });

  it('資金が未設定なら capital を送らない・板が無ければ環境なし', () => {
    const e = aiEnvFromState(state, { ...caseMargin(c), capitalYen: null });
    expect(e && buildAiContext(e).capital).toBeUndefined();
    expect(aiEnvFromState({ ...state, chain: null }, caseMargin(c))).toBeNull();
  });
});

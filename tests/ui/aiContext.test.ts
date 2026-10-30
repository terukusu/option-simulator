import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import aiTools from '../../fixtures/synthetic/ai_tools.json';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { reduce } from '../../ui/state';
import { aiEnvFromState, buildAiContext, contextKey } from '../../ui/view/aiContext';
import { fixture } from '../support/fixtures';
import { laterJson } from '../support/laterChain';

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

describe('自分の前提（#156 AC3）', () => {
  const margin = caseMargin(c);
  it('前提があれば profile.text（前後の空白を除く）が入り、指紋が変わる', () => {
    const plain = aiEnvFromState(state, margin);
    const withP = aiEnvFromState(state, margin, '  資金 500 万円。深い OTM の売りが基本  \n');
    if (!plain || !withP) throw new Error('環境が無い');
    const a = buildAiContext(plain);
    const b = buildAiContext(withP);
    expect(a.profile).toBeUndefined();
    expect(b.profile).toEqual({ text: '資金 500 万円。深い OTM の売りが基本' });
    expect(contextKey(a)).not.toBe(contextKey(b));
    const other = aiEnvFromState(state, margin, '損失は 30 万円まで');
    if (!other) throw new Error('環境が無い');
    expect(contextKey(buildAiContext(other))).not.toBe(contextKey(b));
  });
  it('空・空白だけ・上限を超える値は送らない', () => {
    for (const p of ['', '   \n', 'あ'.repeat(1001)]) {
      const e = aiEnvFromState(state, margin, p);
      expect(e && buildAiContext(e).profile).toBeUndefined();
    }
    const e = aiEnvFromState(state, margin, 'あ'.repeat(1000));
    expect(e && buildAiContext(e).profile?.text.length).toBe(1000);
  });
});

describe('保有の情報（#302 AC14）', () => {
  const put = AI_EVAL_CASES.find((x) => x.name === 'put_sell');
  if (!put) throw new Error('組が無い');
  const plain = caseState(latest, put);
  const ctxOf = (s: typeof plain, others = 0) => {
    const e = aiEnvFromState(s, caseMargin(put), undefined, others);
    if (!e) throw new Error('環境が無い');
    return buildAiContext(e);
  };
  const HELD_KEYS = ['held', 'other_held', 'opened_days', 'pnl_now_yen', 'unrealized_yen'];

  it('保有も前の板の足も無い state の文脈は変更前と同じ（見本 ai_tools.json の文脈と同じ指紋）', () => {
    const ctx = ctxOf(plain);
    const keys = keysOf(ctx);
    for (const k of HELD_KEYS) expect(keys.has(k)).toBe(false);
    const sample = aiTools.cases.find((x) => x.name === 'put_sell');
    expect(contextKey(ctx)).toBe(contextKey(sample?.context as unknown as typeof ctx));
  });

  it('保有の作業中のタブで held: true、検討中のタブでは held のキーが無い', () => {
    const held = reduce(plain, { type: 'setTabHeld', held: true });
    expect(ctxOf(held).position?.held).toBe(true);
    expect(Object.keys(ctxOf(plain).position ?? {})).toEqual(['legs']);
    // 保有のタブは前の板の足が無くてもシナリオ 0 の損益を送る（含み損益は送らない）
    const ps = ctxOf(held).precomputed?.position_summary as Record<string, unknown>;
    expect(typeof ps.pnl_now_yen).toBe('number');
    expect('unrealized_yen' in ps).toBe(false);
  });

  it('前の板で建てた足だけに opened_days（建ててから今の板までの暦日）', () => {
    const later = reduce(reduce(plain, { type: 'setTabHeld', held: true }), {
      type: 'loaded',
      chain: normalizeChain(laterJson(3)),
      label: 'later',
    });
    const withNew = reduce(later, {
      type: 'addBoardLeg',
      expiry: '2026-11',
      k: 62000,
      optionType: 'put',
      side: 'buy',
    });
    const legs = ctxOf(withNew).position?.legs ?? [];
    expect(legs.map((l) => l.opened_days)).toEqual([3, undefined]);
  });

  it('ほかの保有があれば other_held（1 以上のときだけ）', () => {
    expect(ctxOf(plain, 2).position?.other_held).toBe(2);
    expect(Object.keys(ctxOf(plain, 0).position ?? {})).toEqual(['legs']);
    expect(contextKey(ctxOf(plain, 0))).toBe(contextKey(ctxOf(plain)));
  });
});

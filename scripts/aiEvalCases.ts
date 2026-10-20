/**
 * AI の評価とツールの見本に使う合成のポジション（#135 AC1。値はすべて架空）。合成の板 fixtures/synthetic/latest.json の
 * 行使価格・気配から、画面の reducer（ui/state.ts の addBoardLeg・addFutureLeg・setScenario）で作る = 建値は板の気配
 * （買いは ask・売りは bid）。scripts/aiEval.mjs（本物の API の評価）と scripts/synthBoard.ts（ツールの見本
 * fixtures/synthetic/ai_tools.json）が使う。
 */

import { type Chain, normalizeChain } from '../data';
import type { ChainJson } from '../data/chainTypes';
import type { Scenario } from '../model';
import { CALENDAR } from '../ui/calendar';
import { DEFAULT_MARGIN_PREFS, type MarginPrefs } from '../ui/prefs';
import { type Action, initialState, reduce, type State } from '../ui/state';

export interface AiEvalCase {
  name: string;
  /** 表示名（評価の出力の見出し） */
  label: string;
  legs: Action[];
  scenario?: Partial<Scenario>;
  /** 資金（円。無ければ未設定） */
  capitalYen?: number;
}

const NOV = '2026-11';
const DEC = '2026-12';
const op = (k: number, optionType: 'put' | 'call', side: 'buy' | 'sell', expiry = NOV): Action => ({
  type: 'addBoardLeg',
  expiry,
  k,
  optionType,
  side,
});

/** 10 通り（Issue の AC1 の順） */
export const AI_EVAL_CASES: readonly AiEvalCase[] = [
  {
    name: 'put_sell',
    label: '売りの put',
    legs: [op(64000, 'put', 'sell')],
    capitalYen: 5_000_000,
  },
  {
    name: 'call_sell',
    label: '売りの call',
    legs: [op(72000, 'call', 'sell')],
    capitalYen: 5_000_000,
  },
  {
    name: 'strangle_sell',
    label: 'ストラングル売り',
    legs: [op(64000, 'put', 'sell'), op(72000, 'call', 'sell')],
    capitalYen: 8_000_000,
  },
  {
    name: 'straddle_sell',
    label: 'ストラドル売り',
    legs: [op(68000, 'put', 'sell'), op(68000, 'call', 'sell')],
    scenario: { days: 5 },
    capitalYen: 10_000_000,
  },
  {
    name: 'put_ratio',
    label: 'プットのレシオ（1 買 2 売）',
    legs: [op(66000, 'put', 'buy'), op(63000, 'put', 'sell'), op(63000, 'put', 'sell')],
    capitalYen: 8_000_000,
  },
  {
    name: 'bull_put',
    label: 'ブル put スプレッド',
    legs: [op(66000, 'put', 'sell'), op(63000, 'put', 'buy')],
    capitalYen: 3_000_000,
  },
  {
    name: 'iron_condor',
    label: 'アイアンコンドル',
    legs: [
      op(63000, 'put', 'buy'),
      op(65000, 'put', 'sell'),
      op(71000, 'call', 'sell'),
      op(73000, 'call', 'buy'),
    ],
    capitalYen: 3_000_000,
  },
  { name: 'long_call', label: '買いの call', legs: [op(70000, 'call', 'buy')] },
  {
    name: 'mini_future_put',
    label: '先物つき（ミニ先物の売り + put 売り）',
    legs: [
      { type: 'addFutureLeg', input: { product: 'fut_mini', side: 'sell', qty: 1 } },
      op(66000, 'put', 'sell'),
    ],
    capitalYen: 5_000_000,
  },
  {
    name: 'calendar',
    label: 'カレンダー（2 限月）',
    legs: [op(68000, 'call', 'sell', NOV), op(68000, 'call', 'buy', DEC)],
    scenario: { days: 10, dSigma: 2 },
    capitalYen: 3_000_000,
  },
];

/** 合成の板 + 足 + シナリオの画面の状態（足を作れなければ例外） */
export function caseState(json: ChainJson, c: AiEvalCase): State {
  const chain: Chain = normalizeChain(json);
  let s = reduce(
    { ...initialState, calendar: CALENDAR },
    { type: 'loaded', chain, label: 'latest' },
  );
  for (const a of c.legs) {
    s = reduce(s, a);
    if (s.legError) throw new Error(`${c.name}: 足を作れない（${s.legError}）`);
  }
  if (c.scenario) s = reduce(s, { type: 'setScenario', patch: c.scenario });
  return s;
}

export function caseMargin(c: AiEvalCase): MarginPrefs {
  return { ...DEFAULT_MARGIN_PREFS, capitalYen: c.capitalYen ?? null };
}

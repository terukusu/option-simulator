/**
 * AI のツール（#135。docs/design.md 14 章・K15、docs/ai-advisor.md 論点 5）。決定論的な計算で、AI に計算させない。
 * 純関数（DOM・通信・時計に依存しない）。画面の表示モデル（ui/view/metrics.ts の metricsModel・ui/view/margin.ts・
 * model/ の tailTable・evaluatePosition）を呼ぶだけ = 画面と同じ数字。
 *
 * - 名前・入力・結果の形は中継の api/src/simulator_api/ai/tools.py の REGISTRY と同じ（生成した見本
 *   fixtures/synthetic/ai_tools.json を pytest が結果の形に通す）
 * - 値は丸めて返す（円は整数、% と pt は小数 1 桁、Δ は小数 2 桁、Γ は小数 3 桁、日は小数 1 桁）。AI が書き写す値 = 照合の値
 *   （ui/view/aiNumbers.ts）。評価できない値（非有限）は null
 * - 単位はキーの名前（`*_yen` 円、`x`・`k`・`*_x` 原資産・行使価格、`*_pct` %、`*_pt` pt、`delta_*` 枚、`*days*` 日、
 *   `*ratio` 倍）
 * - 失敗は `{ error: '<列挙>' }`（no_legs・bad_input・out_of_range・unknown_tool・no_data・not_on_board・no_candidate）。中継へは tool_result の is_error
 * - technicals（#200）は足が無くても使える（先物の足。ui/view/aiTechnicals.ts）。事前計算には入れない
 * - iv_stats（#138・#158）も足が無くても使える（IV と原資産の日次の値。ui/view/aiIvStats.ts）。事前計算には入れない
 * - strike_quote（#266）も足が無くても使える（任意の行使価格のスマイルの IV・理論価格・気配。ui/view/aiQuote.ts）
 */

import type { Chain } from '../../data';
import {
  type AtmBasis,
  evaluatePosition,
  type Holidays,
  type MarginParams,
  type PreparedLeg,
  type Scenario,
  theoreticalPnl,
  ZERO_SCENARIO,
} from '../../model';
import type { ToolStatus } from './aiChat';
import { type IvStatsData, ivStatsTool } from './aiIvStats';
import { type ProposeDraft, proposePosition, strikeScan, structureCandidates } from './aiPropose';
import { strikeQuote } from './aiQuote';
import { fin, greeksOf, legId, r1, r2, round, yen } from './aiRound';
import { type TechnicalsData, technicalsTool } from './aiTechnicals';
import { FAIR_POSITION_LABEL, fairPriceText } from './fairValue';
import { fmtNum } from './format';
import { type MarginCalc, marginLine, marginNow, marginPoint, marginTail } from './margin';
import { AMOUNT_UNIT_LABEL, fmtAmount, metricsModel } from './metrics';
import { clampDays, type PnlBase, THOUSAND_YEN_FROM } from './pnlChart';

export { legId, yen };

export interface AiToolEnv {
  chain: Chain;
  /** 損益グラフ・指標と同じ基礎（足 0 本・評価できる足が無ければ null） */
  base: PnlBase | null;
  scenario: Scenario;
  atmBasis: AtmBasis;
  margin: { params: MarginParams; capital: number | null };
  holidays: Holidays;
  /** 先物の日足・1 時間足（technicals のツールだけ。#200。呼ばれたときだけフックが読んで入れる。無ければ no_data） */
  technicals?: TechnicalsData | null;
  /** iv_stats のツール（#138・#158。呼ばれたときだけフックが日次の値と今の IV を読んで入れる。無ければ no_data） */
  ivStats?: IvStatsData | null;
  /** 提案のツール（#139。作業中のタブの足と、足の列の評価。aiEnvFromState が作る。無ければ no_data） */
  draft?: ProposeDraft | null;
  /** AI に渡す自分の前提（#156。端末の設定の自由記述。文脈に載せるだけで、ツールは使わない） */
  profile?: string;
  /**
   * 保有（#302）: active = 作業中のタブが保有、others = ほかの保有の数（holdings.ts の otherHeldCount）。
   * 文脈の position.held・other_held と position_summary の pnl_now_yen の条件
   */
  held?: { active: boolean; others: number };
}

export type ToolResult = Record<string, unknown>;
export type ToolError = {
  error:
    | 'no_legs'
    | 'bad_input'
    | 'out_of_range'
    | 'unknown_tool'
    | 'no_data'
    | 'not_on_board'
    | 'no_candidate';
};

/** ツールの名前（名前の順。中継の tools.py と同じ集合） */
export const AI_TOOL_NAMES = [
  'evaluate_scenario',
  'iv_stats',
  'margin_summary',
  'position_summary',
  'propose_position',
  'scenario_grid',
  'smile_position',
  'strike_quote',
  'strike_scan',
  'structure_candidates',
  'tail_table',
  'technicals',
] as const;
export type AiToolName = (typeof AI_TOOL_NAMES)[number];
/** 診断で事前計算する 5 本（入力なし。最初の要求の context.precomputed） */
export const PRECOMPUTED_TOOLS: readonly AiToolName[] = [
  'position_summary',
  'tail_table',
  'margin_summary',
  'scenario_grid',
  'smile_position',
];

/** ツールの名前の表示（カードの見出し） */
export const AI_TOOL_LABEL: Record<AiToolName, string> = {
  position_summary: 'ポジションの要約',
  tail_table: 'テール表',
  margin_summary: '証拠金',
  scenario_grid: 'シナリオの格子',
  smile_position: 'スマイルと足の IV',
  evaluate_scenario: 'シナリオの評価',
  technicals: 'テクニカル（先物）',
  iv_stats: 'IV の統計（過去）',
  strike_scan: '行使価格の探索',
  strike_quote: '行使価格の理論価格',
  structure_candidates: '組み合わせの候補',
  propose_position: 'ポジションの提案',
};

export const isAiToolName = (v: unknown): v is AiToolName =>
  typeof v === 'string' && (AI_TOOL_NAMES as readonly string[]).includes(v);

/** シナリオの格子の軸（tools.py の説明と同じ） */
export const GRID_DX_PCT = [-10, -5, -3, 0, 3, 5, 10] as const;
export const GRID_IV_PT = [-5, 0, 5, 10] as const;
/** evaluate_scenario の入力の範囲（tools.py の EVAL_INPUT と同じ） */
export const EVAL_RANGE = {
  dx_pct: [-60, 60],
  days: [0, 400],
  iv_shift_pt: [-10, 40],
  skew_pt: [-5, 5],
} as const;

const ivPctOf = (p: PreparedLeg) => (p.option ? r1(p.option.anchor * 100) : null);

function positionSummary(env: AiToolEnv, base: PnlBase): ToolResult {
  const { legs, ctx, settings } = base;
  const m = metricsModel({ base, scenario: env.scenario, unit: 'yen' });
  // 今（ポジションのパネルの足のグリークと同じ = 今のシナリオを掛けない）
  const now = evaluatePosition(legs, ZERO_SCENARIO, ctx, settings);
  // 保有の値（#302）: 前の板で建てた足（今の値段を使った足）があれば含み損益（指標の内訳と同じ。手数料の前）、
  // 保有のタブか前の板の足があればシナリオ 0 の損益（手数料込み）。どちらも無ければ送らない（文脈は変更前と同じ）
  const marked = m.premium.markedLegs > 0;
  const heldExtra = {
    ...(marked || env.held?.active === true ? { pnl_now_yen: yen(now.pnl) } : {}),
    ...(marked ? { unrealized_yen: yen(m.premium.unrealized) } : {}),
  };
  const e = m.expiry;
  const profitInf = e.maxProfit.value === Number.POSITIVE_INFINITY;
  const lossInf = e.maxLoss.value === Number.NEGATIVE_INFINITY;
  // 無限なら max_*_yen は null（proposalSummary と同じ意味。#260）。画面のタイルが併記する有限の put 側の値は
  // 別の名前 put_side_*（無限でなければ null）で返し、「最大損失」と読み違えないようにする
  const profit = profitInf ? null : e.maxProfit;
  const loss = lossInf ? null : e.maxLoss;
  const profitPut = profitInf ? e.profitFinite : null;
  const lossPut = lossInf ? e.lossFinite : null;
  return {
    x0: yen(ctx.x0),
    max_days: r1(base.maxDays),
    n_legs: legs.length,
    legs: legs.map((p, i) => {
      const d = now.legs[i]?.display;
      return {
        leg_no: i + 1,
        ...legId(p),
        entry_yen: round(p.leg.entry, 1) ?? 0,
        iv_pct: ivPctOf(p),
        days_to_sq: r1(Math.max(p.T0, 0) * 365),
        delta_large: r2(d?.deltaLarge),
        delta_mini: r2(d?.deltaMini),
      };
    }),
    premium: {
      received_yen: yen(m.premium.received),
      paid_yen: yen(m.premium.paid),
      net_yen: yen(m.premium.net),
      fees_yen: yen(m.premium.fees),
      net_after_fees_yen: yen(m.premium.netAfterFees),
    },
    expiry: {
      max_profit_yen: yen(profit?.value),
      max_profit_x: yen(profit?.x),
      max_profit_unbounded: profitInf,
      max_loss_yen: yen(loss?.value),
      max_loss_x: yen(loss?.x),
      max_loss_unbounded: lossInf,
      put_side_max_profit_yen: yen(profitPut?.value),
      put_side_max_profit_x: yen(profitPut?.x),
      put_side_max_loss_yen: yen(lossPut?.value),
      put_side_max_loss_x: yen(lossPut?.x),
      breakevens_x: e.breakevens.slice(0, 20).map(yen),
    },
    greeks_now: greeksOf(now.total),
    scenario_point: {
      days: r1(m.days),
      dx_pct: r1(m.scenarioPoint.dXPct),
      x: yen(m.scenarioPoint.x),
      pnl_yen: yen(m.scenarioPoint.pnl),
      greeks: greeksOf(m.scenarioPoint.total),
    },
    ...heldExtra,
  };
}

function tailTableTool(env: AiToolEnv, base: PnlBase): ToolResult {
  const m = metricsModel({ base, scenario: env.scenario, unit: 'yen' });
  const { params, capital } = env.margin;
  const margin = marginTail(base, { ...env.scenario, dX: 0 }, params, capital, env.holidays);
  return {
    days: r1(m.days),
    base: { kind: m.tail.premiumBase.kind, amount_yen: yen(m.tail.premiumBase.amount) },
    rows: m.tail.rows.map((r, i) => {
      const c = margin[i]?.calc ?? null;
      return {
        shock_pct: r1(r.shock * 100),
        x: yen(r.x),
        sq_pnl_yen: yen(r.sq.pnl),
        sq_ratio: r1(r.sq.ratio),
        scenario_pnl_yen: yen(r.scenario.pnl),
        scenario_ratio: r1(r.scenario.ratio),
        margin_yen: c ? yen(c.result.margin) : null,
        room_yen: c ? yen(c.room) : null,
      };
    }),
  };
}

function marginState(c: MarginCalc | null): ToolResult {
  if (!c) {
    return {
      x: null,
      margin_yen: null,
      requirement_yen: null,
      nov_yen: null,
      room_yen: null,
      multiple: null,
      multiple_unbounded: false,
    };
  }
  const unbounded = c.multiple === Number.POSITIVE_INFINITY;
  return {
    x: yen(c.x),
    margin_yen: yen(c.result.margin),
    requirement_yen: yen(c.result.requirement),
    nov_yen: yen(c.result.nov),
    room_yen: yen(c.room),
    multiple: unbounded ? null : r1(c.multiple),
    multiple_unbounded: unbounded,
  };
}

function marginSummary(env: AiToolEnv, base: PnlBase): ToolResult {
  const { params, capital } = env.margin;
  const sc = env.scenario;
  return {
    capital_yen: capital === null ? null : yen(capital),
    params: {
      range_pct: r1(params.range * 100),
      iv_up_pct: r1(params.ivUp * 100),
      iv_down_pct: r1(params.ivDown * 100),
      factor_pct: r1(params.factor * 100),
      ignore_long_options: params.ignoreLongOptions,
    },
    now: marginState(marginNow(base, sc, params, capital, env.holidays)),
    point: marginState(marginPoint(base, sc, params, capital, env.holidays)),
    call_levels_x: marginLine(base, sc, params, capital, env.holidays).slice(0, 40).map(yen),
  };
}

/** 格子の日数: 0・今のシナリオの日数・最遠の SQ の前日（重複は 1 つ。昇順） */
export function gridDays(base: PnlBase, scenario: Scenario): number[] {
  const d = clampDays(scenario, base.maxDays).days;
  const last = Math.max(base.maxDays - 1, 0);
  const out = [...new Set([0, r1(d) ?? 0, r1(last) ?? 0])].sort((a, b) => a - b);
  return out;
}

function scenarioGrid(env: AiToolEnv, base: PnlBase): ToolResult {
  const { legs, ctx, settings } = base;
  const days = gridDays(base, env.scenario);
  const xs = GRID_DX_PCT.map((p) => ctx.x0 * (1 + p / 100));
  const pnl = days.map((d) =>
    xs.map((x) =>
      GRID_IV_PT.map((iv) =>
        yen(
          theoreticalPnl(
            legs,
            x,
            {
              ...env.scenario,
              days: Math.min(d, base.maxDays),
              dX: x - ctx.x0,
              dSigma: iv,
              ivShift: 'absolute',
            },
            ctx,
            settings,
          ),
        ),
      ),
    ),
  );
  return {
    beta: r2(env.scenario.beta),
    skew_pt: r1(env.scenario.skew),
    days,
    dx_pct: [...GRID_DX_PCT],
    x: xs.map(yen),
    iv_shift_pt: [...GRID_IV_PT],
    pnl_yen: pnl,
  };
}

function smilePosition(env: AiToolEnv): ToolResult {
  const { chain } = env;
  const expiries: ToolResult[] = [];
  const atmIv = new Map<string, number | null>();
  for (const m of chain.months) {
    const smile = m.smile?.smile;
    const k = m.atm[env.atmBasis].pick?.k;
    if (!smile || !fin(m.F) || m.F <= 0 || k === undefined) continue;
    const atm = r1(smile.sigma(Math.log(k / m.F)) * 100);
    const put5 = r1(smile.sigma(Math.log(0.95)) * 100);
    const call5 = r1(smile.sigma(Math.log(1.05)) * 100);
    atmIv.set(m.id, atm);
    if (expiries.length >= 6) continue;
    expiries.push({
      expiry: m.id,
      sq_date: m.sqDate,
      t_days: r1(m.T * 365),
      forward: yen(m.F),
      atm_k: k,
      atm_iv_pct: atm,
      put5_iv_pct: put5,
      call5_iv_pct: call5,
      put5_minus_atm_pt: atm !== null && put5 !== null ? r1(put5 - atm) : null,
      call5_minus_atm_pt: atm !== null && call5 !== null ? r1(call5 - atm) : null,
    });
  }
  const legs: ToolResult[] = [];
  for (const p of env.base?.legs ?? []) {
    const l = p.leg;
    if (l.kind !== 'option' || legs.length >= 20) continue;
    const iv = ivPctOf(p);
    const atm = atmIv.get(l.expiry) ?? null;
    legs.push({
      expiry: l.expiry,
      type: l.type === 'put' ? 'P' : 'C',
      k: l.strike,
      side: l.side,
      qty: l.qty,
      moneyness_pct: fin(p.F) && p.F > 0 ? r1((l.strike / p.F - 1) * 100) : null,
      iv_pct: iv,
      atm_iv_pct: atm,
      iv_minus_atm_pt: iv !== null && atm !== null ? r1(iv - atm) : null,
    });
  }
  return { expiries, legs };
}

const inRange = (v: unknown, [lo, hi]: readonly [number, number]) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function evaluateScenario(env: AiToolEnv, base: PnlBase, input: Record<string, unknown>) {
  const known = new Set(['dx_pct', 'x', 'days', 'iv_shift_pt', 'skew_pt']);
  if (Object.keys(input).some((k) => !known.has(k))) return { error: 'bad_input' } as const;
  const hasDx = input.dx_pct !== undefined;
  const hasX = input.x !== undefined;
  if (hasDx === hasX) return { error: 'bad_input' } as const;
  for (const k of ['dx_pct', 'x', 'days', 'iv_shift_pt', 'skew_pt'] as const) {
    const v = input[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
      return { error: 'bad_input' } as const;
    }
  }
  if (input.days === undefined || input.iv_shift_pt === undefined) {
    return { error: 'bad_input' } as const;
  }
  const { legs, ctx, settings } = base;
  const x0 = ctx.x0;
  const x = hasX ? (input.x as number) : x0 * (1 + (input.dx_pct as number) / 100);
  const dxPct = (x / x0 - 1) * 100;
  if (
    !(x > 0) ||
    !inRange(dxPct, EVAL_RANGE.dx_pct) ||
    !inRange(input.days, EVAL_RANGE.days) ||
    !inRange(input.iv_shift_pt, EVAL_RANGE.iv_shift_pt) ||
    (input.skew_pt !== undefined && !inRange(input.skew_pt, EVAL_RANGE.skew_pt))
  ) {
    return { error: 'out_of_range' } as const;
  }
  const want: Scenario = {
    ...env.scenario,
    days: input.days as number,
    dX: x - x0,
    dSigma: input.iv_shift_pt as number,
    skew: (input.skew_pt as number | undefined) ?? env.scenario.skew,
    ivShift: 'absolute',
  };
  const { days, clamped } = clampDays(want, base.maxDays);
  const sc: Scenario = { ...want, days };
  const ev = evaluatePosition(legs, sc, ctx, settings, x);
  return {
    scenario: {
      days: r1(days),
      dx_pct: r1(dxPct),
      x: yen(x),
      iv_shift_pt: r1(sc.dSigma),
      skew_pt: r1(sc.skew),
      days_clamped: clamped,
    },
    pnl_yen: yen(ev.pnl),
    expiry_pnl_yen: yen(base.expiry(x)),
    greeks: greeksOf(ev.total),
    legs: legs.slice(0, 20).map((p, i) => {
      const e = ev.legs[i];
      return {
        ...legId(p),
        pnl_yen: yen(e?.pnl),
        iv_pct: e && e.sigma !== null ? r1(e.sigma * 100) : null,
      };
    }),
  };
}

/** ツールを実行する（入力は tool_use の input。結果か `{ error }`） */
export function runTool(
  name: string,
  input: Record<string, unknown>,
  env: AiToolEnv,
): ToolResult | ToolError {
  if (!isAiToolName(name)) return { error: 'unknown_tool' };
  if (name === 'smile_position') return smilePosition(env);
  if (name === 'technicals') return technicalsTool(env.technicals ?? null, input);
  if (name === 'iv_stats') return ivStatsTool(env.ivStats ?? null, env.holidays, input);
  // 行使価格の理論価格（#266）も足が無くても使える（板とスマイルだけ）
  if (name === 'strike_quote') return strikeQuote(env, input);
  // 提案のツール（#139）は足が無くても使える（新しいタブの候補・丸ごとの提案）
  if (name === 'strike_scan') return strikeScan(env, input);
  if (name === 'structure_candidates') return structureCandidates(env, input);
  if (name === 'propose_position') return proposePosition(env, input);
  const base = env.base;
  if (!base || base.legs.length === 0) return { error: 'no_legs' };
  switch (name) {
    case 'position_summary':
      return positionSummary(env, base);
    case 'tail_table':
      return tailTableTool(env, base);
    case 'margin_summary':
      return marginSummary(env, base);
    case 'scenario_grid':
      return scenarioGrid(env, base);
    case 'evaluate_scenario':
      return evaluateScenario(env, base, input);
  }
}

export const isToolError = (v: ToolResult | ToolError): v is ToolError =>
  typeof (v as ToolError).error === 'string';

/** 診断の事前計算（5 本。足が無いと smile_position だけ） */
export function precompute(env: AiToolEnv): Record<string, ToolResult> {
  const out: Record<string, ToolResult> = {};
  for (const name of PRECOMPUTED_TOOLS) {
    const r = runTool(name, {}, env);
    if (!isToolError(r)) out[name] = r;
  }
  return out;
}

/** evaluate_scenario の結果のシナリオ（[シナリオに適用] で入れる値。形が違えば null） */
export function scenarioOfResult(
  result: unknown,
  x0: number,
): { days: number; dX: number; dSigma: number; skew: number } | null {
  if (typeof result !== 'object' || result === null) return null;
  const s = (result as { scenario?: unknown }).scenario;
  if (typeof s !== 'object' || s === null) return null;
  const v = s as Record<string, unknown>;
  const nums = [v.days, v.x, v.iv_shift_pt, v.skew_pt];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (!(Number.isFinite(x0) && x0 > 0)) return null;
  return {
    days: v.days as number,
    dX: (v.x as number) - x0,
    dSigma: v.iv_shift_pt as number,
    skew: v.skew_pt as number,
  };
}

// ---------------------------------------------------------------- ツールのカード（画面の表示）

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** 金額（円。10 万円以上は千円。画面の指標の単位の規則と同じ） */
export function cardYen(v: unknown, signed = true): string {
  const n = num(v);
  if (n === null) return '—';
  const unit = Math.abs(n) >= THOUSAND_YEN_FROM ? 'thousand' : 'yen';
  return `${fmtAmount(n, unit, signed)} ${AMOUNT_UNIT_LABEL[unit]}`;
}

const pctText = (v: unknown, signed = true) => {
  const n = num(v);
  if (n === null) return '—';
  const s = fmtNum(n, 1);
  return signed && n > 0 ? `+${s}` : s;
};

/** 提案のツールの失敗の理由（カードの 1 行。strike_quote は QUOTE_ERROR_TEXT が先） */
export const PROPOSE_ERROR_TEXT: Record<string, string> = {
  not_on_board: '板に無い限月・行使価格',
  no_candidate: '条件に合う行使価格が板に無い',
  bad_input: '足の指定の書式が違う',
  no_legs: '足がありません',
  no_data: '板・足を読めない',
  tool_limit: '計算の回数の上限',
  out_of_range: 'F から遠すぎる行使価格',
};

/** strike_quote の失敗の理由（#266。板に無い行使価格は受け付けるので、足・行使価格の語を使わない） */
export const QUOTE_ERROR_TEXT: Record<string, string> = {
  bad_input: '行使価格・種別・限月の指定の書式が違う',
  not_on_board: '板に無い限月（またはスマイルが無い）',
};

/** 組み合わせの型の表示 */
export const STRUCTURE_LABEL: Record<string, string> = {
  short_put: 'put 売り',
  short_call: 'call 売り',
  short_strangle: 'ストラングル売り',
  short_straddle: 'ストラドル売り',
  iron_condor: 'アイアンコンドル',
  bull_put: 'ブル put スプレッド',
  bear_call: 'ベア call スプレッド',
  put_ratio: 'put のレシオ（1 買 2 売）',
};

export interface ToolCard {
  title: string;
  /** 入力の要約（evaluate_scenario だけ） */
  input: string | null;
  lines: string[];
  /** [シナリオに適用] を出す（evaluate_scenario の成功） */
  applicable: boolean;
  /** 結果を待つ間（#242。カードは進み具合の印と「計算中…」） */
  pending?: true;
}

/** strike_quote のカードに出す行の数（残りは「ほか N 本」） */
export const QUOTE_CARD_ROWS = 4;

/**
 * strike_quote の行（`P 45,000: 理論 10.5 円（IV 40.1%・気配の中ほど・外挿）· 気配 9 / 12`）。理論価格の桁・位置の語は
 * 画面の「理論価格（周りの行から）」と同じ（ui/view/fairValue.ts）
 */
function quoteCardLine(x: Record<string, unknown>): string {
  const head = `${x.type === 'C' ? 'C' : 'P'} ${fmtNum(num(x.k), 0)}`;
  const fair = num(x.fair_yen);
  const notes = [
    num(x.fair_iv_pct) === null ? null : `IV ${fmtNum(num(x.fair_iv_pct), 1)}%`,
    typeof x.fair_position === 'string'
      ? (FAIR_POSITION_LABEL[x.fair_position as keyof typeof FAIR_POSITION_LABEL] ?? null)
      : null,
    x.fair_mark === 'extrapolated' ? '外挿' : null,
  ].filter((t) => t !== null);
  const fairText =
    fair === null ? '理論 —' : `理論 ${fairPriceText(fair)} 円（${notes.join('・')}）`;
  const bid = num(x.bid_yen);
  const ask = num(x.ask_yen);
  const quote =
    x.on_board !== true
      ? '板に無い'
      : bid === null && ask === null
        ? '気配なし'
        : `気配 ${bid === null ? '—' : fmtNum(bid)} / ${ask === null ? '—' : fmtNum(ask)}`;
  return `${head}: ${fairText} · ${quote}`;
}

/** 足を読み込んでから計算するツール（待ちが長い。#242） */
const BARS_TOOLS: ReadonlySet<string> = new Set(['technicals', 'iv_stats']);

/**
 * ツールのカードの文字（結果は中継を通った JSON。形が違えば「—」）。結果を待つ間は「計算中…」（足を読むツールは
 * 「足を読み込み中…」）、結果が返らないまま終わったら「結果なし」で、どちらも失敗とは言わない（#242）
 */
export function toolCard(
  name: string,
  _input: Record<string, unknown>,
  result: unknown,
  status: ToolStatus,
): ToolCard {
  const title = isAiToolName(name) ? AI_TOOL_LABEL[name] : name;
  if (status === 'pending') {
    const line = BARS_TOOLS.has(name) ? '足を読み込み中…' : '計算中…';
    return { title, input: null, lines: [line], applicable: false, pending: true };
  }
  if (status === 'missing') {
    return { title, input: null, lines: ['結果なし'], applicable: false };
  }
  const r = obj(result);
  if (status === 'error' || result === null) {
    const code = typeof r.error === 'string' ? r.error : '—';
    const head = name === 'propose_position' ? '提案を作れなかった' : '計算できなかった';
    const propose =
      name === 'propose_position' ||
      name === 'strike_scan' ||
      name === 'structure_candidates' ||
      name === 'strike_quote';
    const why =
      name === 'strike_quote'
        ? (QUOTE_ERROR_TEXT[code] ?? PROPOSE_ERROR_TEXT[code] ?? code)
        : propose
          ? (PROPOSE_ERROR_TEXT[code] ?? code)
          : code;
    return { title, input: null, lines: [`${head}（${why}）`], applicable: false };
  }
  switch (name) {
    case 'evaluate_scenario': {
      const sc = obj(r.scenario);
      const inputText = `ΔX ${pctText(sc.dx_pct)}% · ${fmtNum(num(sc.days), 1)} 日 · IV ${pctText(sc.iv_shift_pt)}pt · スキュー ${pctText(sc.skew_pt)}`;
      return {
        title,
        input: inputText,
        lines: [
          `損益 ${cardYen(r.pnl_yen)}（満期 ${cardYen(r.expiry_pnl_yen)}）`,
          `Δ ${fmtNum(num(obj(r.greeks).delta_large), 2)} 枚（ミニ ${fmtNum(num(obj(r.greeks).delta_mini), 2)} 枚）`,
        ],
        applicable: num(sc.x) !== null,
      };
    }
    case 'position_summary': {
      const e = obj(r.expiry);
      return {
        title,
        input: null,
        lines: [
          e.max_loss_unbounded === true
            ? `満期の最大損失 無限（put 側 ${cardYen(e.put_side_max_loss_yen)}）`
            : `満期の最大損失 ${cardYen(e.max_loss_yen)}`,
          `Δ ${fmtNum(num(obj(r.greeks_now).delta_large), 2)} 枚`,
        ],
        applicable: false,
      };
    }
    case 'tail_table': {
      const rows = Array.isArray(r.rows) ? r.rows.map(obj) : [];
      return {
        title,
        input: null,
        lines: rows.slice(0, 3).map((x) => `${pctText(x.shock_pct)}%: SQ ${cardYen(x.sq_pnl_yen)}`),
        applicable: false,
      };
    }
    case 'margin_summary': {
      const now = obj(r.now);
      return {
        title,
        input: null,
        lines: [`必要証拠金 ${cardYen(now.margin_yen, false)} · 余力 ${cardYen(now.room_yen)}`],
        applicable: false,
      };
    }
    case 'technicals': {
      const frames = Array.isArray(r.frames) ? r.frames.map(obj) : [];
      const tfText: Record<string, string> = { weekly: '週足', daily: '日足', '4h': '4 時間足' };
      return {
        title,
        input: null,
        lines: frames.map((f) => {
          const parts: string[] = [];
          const rsi = obj(f.rsi);
          if (num(rsi.rsi) !== null) parts.push(`RSI ${fmtNum(num(rsi.rsi), 1)}`);
          const m = obj(f.macd);
          const hist = num(m.hist_yen);
          if (hist !== null) parts.push(`MACD H ${hist > 0 ? '+' : ''}${fmtNum(hist, 0)}`);
          const so = obj(f.stoch);
          if (num(so.stoch_k) !== null) parts.push(`SO %K ${fmtNum(num(so.stoch_k), 1)}`);
          return `${tfText[String(f.tf)] ?? '—'}: ${parts.join(' · ') || '—'}`;
        }),
        applicable: false,
      };
    }
    case 'iv_stats': {
      const d = obj(r.data);
      const lines: string[] = [];
      const y1 = (Array.isArray(obj(r.level).windows) ? (obj(r.level).windows as unknown[]) : [])
        .map(obj)
        .find((w) => w.window === '1y');
      const head = `IV ${fmtNum(num(d.iv_now_pct), 1)}%（${d.now_source === 'intraday' ? '今' : '最後の確定日の終値'}）`;
      lines.push(y1 ? `${head} · 1 年の分位 ${fmtNum(num(y1.percentile_pct), 1)}%` : head);
      const hv = obj(r.hv);
      const hv20 = (Array.isArray(hv.windows) ? hv.windows : [])
        .map(obj)
        .find((w) => w.days === 20);
      if (hv20) {
        lines.push(
          `HV20 ${fmtNum(num(hv20.hv_pct), 1)}% · IV − HV ${pctText(hv20.iv_minus_hv_pt)}pt`,
        );
      }
      const sp = obj(r.spikes);
      if (num(sp.n) !== null) lines.push(`スパイク ${fmtNum(num(sp.n))} 回`);
      return { title, input: null, lines, applicable: false };
    }
    case 'strike_scan': {
      const rows = Array.isArray(r.rows) ? r.rows.length : 0;
      const best = num(r.best_k);
      const floor = num(r.max_loss_floor_yen);
      return {
        title,
        input: `${String(r.expiry ?? '')} ${String(r.type ?? '')} ${r.side === 'sell' ? '売' : '買'} ×${fmtNum(num(r.qty))}${floor === null ? '' : ` · 最大損失 ${cardYen(floor)} まで`}`,
        lines: [
          `${fmtNum(num(r.n_scanned))} 行を評価（${fmtNum(rows)} 行を AI に渡した）`,
          ...(floor === null
            ? []
            : [
                best === null
                  ? '下限を満たす行なし'
                  : `下限を満たす中で最も有利な K ${fmtNum(best)}`,
              ]),
        ],
        applicable: false,
      };
    }
    case 'strike_quote': {
      const rows = Array.isArray(r.rows) ? r.rows.map(obj) : [];
      const shown = rows.slice(0, QUOTE_CARD_ROWS);
      const lines = shown.map(quoteCardLine);
      if (rows.length > shown.length) lines.push(`ほか ${rows.length - shown.length} 本`);
      return { title, input: String(r.expiry ?? ''), lines, applicable: false };
    }
    case 'structure_candidates': {
      const cs = Array.isArray(r.candidates) ? r.candidates.map(obj) : [];
      return {
        title,
        input: `${STRUCTURE_LABEL[String(r.structure)] ?? '—'} · ${String(r.expiry ?? '')}`,
        lines: cs.map((c) => {
          const sm = obj(c.summary);
          const legs = Array.isArray(c.legs) ? c.legs.map(obj) : [];
          const ks = legs.map((l) => `${l.type}${fmtNum(num(l.k))}`).join('/');
          return `${String(c.id)}: ${ks} · 受払 ${cardYen(sm.premium_net_yen)} · 最大損失 ${sm.max_loss_unbounded === true ? '無限' : cardYen(sm.max_loss_yen)}`;
        }),
        applicable: false,
      };
    }
    default:
      return { title, input: null, lines: [], applicable: false };
  }
}

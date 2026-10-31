/**
 * AI のポジションの提案（#139。docs/design.md 14 章）。純関数（DOM・通信・時計に依存しない）。
 *
 * 候補は simulator が作り（#120 柱 5: AI に行使価格を自由に選ばせない）、AI は絞って語り、最後に足を **構造化した
 * 入力** で出す（文章から読み取らない）。画面が今の板で検査・評価して通ったときだけ提案のカードを出す。
 *
 * - strike_scan: 今のポジション + 1 本の足を、板の行使価格（両気配の行）ごとに評価する（ヘッジ・調整の探索。例
 *   「最大損失を −1,000 千円に抑える put の買い」）
 * - structure_candidates: 型 × 短い足の |Δ| で板の行使価格から組み合わせの候補を作り、単体で評価する
 * - propose_position: 今のタブへの差分（add / remove / set_qty / move_strike）か、新しいタブの足の丸ごと。検査して
 *   前 → 後の要約（満期の最大損失・必要証拠金・Δ・追証の水準）を返す。[今のタブに適用] / [新しいタブに入れる] は
 *   同じ純関数（planProposal）で、押した時点の state から足の列を作り直す
 *
 * 足の作り方は reducer（ui/state.ts）と同じ: OP は boardOptionLeg（売り = bid・買い = ask。気配が無ければ既定）、先物は
 * futureLeg（板の先物の限月だけ）、行使価格の変更は legAtStrike、枚数の変更は qty だけ。変えない足・評価できない足は
 * UiLeg のまま（建値・IV の編集を保つ）。値は aiTools と同じ丸め（ui/view/aiRound.ts）。
 */

import { boardOptionLeg, type Chain, type ChainMonth, futureLeg } from '../../data';
import {
  evaluatePosition,
  type Leg,
  type OptionType,
  premiumSummary,
  type Side,
  ZERO_SCENARIO,
} from '../../model';
import { legAtStrike, QTY_MAX, type UiLeg } from '../state';
import { fin, greeksOf, legId, r1, r2, yen } from './aiRound';
import type { AiToolEnv, ToolError, ToolResult } from './aiTools';
import { fmtNum } from './format';
import { marginLine, marginNow } from './margin';
import { AMOUNT_UNIT_LABEL, fmtAmount } from './metrics';
import { type PnlBase, THOUSAND_YEN_FROM } from './pnlChart';
import { defaultMonthOf, quotedStrikes, strikeByDelta } from './strikePick';
import { RATIO_GAP, shapeLegs } from './templates';

/** 足の列を評価した結果（aiEnvFromState が useAppController と同じ組み立てで作る） */
export interface DraftEval {
  base: PnlBase | null;
  /** 足ごとに評価できたか（positionModel の行の error が null） */
  evaluable: boolean[];
}

/** 提案のツールの環境（作業中のタブの足と、足の列 → 評価） */
export interface ProposeDraft {
  legs: readonly UiLeg[];
  evalLegs: (legs: readonly UiLeg[]) => DraftEval;
}

/** 足の本数の上限（中継の MAX_LEGS） */
export const PROPOSE_MAX_LEGS = 20;
/** 差分の個数の上限 */
export const PROPOSE_MAX_CHANGES = 10;
/** strike_scan の行の上限 */
export const SCAN_MAX_ROWS = 25;
/** strike_scan の既定の範囲（OTM 側。F に対する比） */
export const SCAN_DEFAULT_RANGE = 0.3;
/** structure_candidates の短い足の |Δ| */
export const CANDIDATE_DELTAS = [0.1, 0.15, 0.2, 0.25, 0.3] as const;
/** レシオの買いの足の |Δ| = 売り + これ */
export const RATIO_BUY_DELTA_GAP = RATIO_GAP;
/** 翼の距離（F に対する %。既定・範囲） */
export const WING_PCT_DEFAULT = 3;
export const WING_PCT_RANGE = [1, 10] as const;
/** 候補の SQ 損益を出す原資産の変化（%） */
export const CANDIDATE_SHOCKS_PCT = [-20, -10, 10, 20] as const;
/** 追証の水準の個数の上限（結果に入れる） */
export const CALL_LEVELS_MAX = 4;

export const STRUCTURES = [
  'short_put',
  'short_call',
  'short_strangle',
  'short_straddle',
  'iron_condor',
  'bull_put',
  'bear_call',
  'put_ratio',
] as const;
export type Structure = (typeof STRUCTURES)[number];

type Err = ToolError['error'];
const err = (e: Err): ToolError => ({ error: e });

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH_RE.test(v);
const isSide = (v: unknown): v is Side => v === 'buy' || v === 'sell';
const optType = (v: unknown): OptionType | null => (v === 'P' ? 'put' : v === 'C' ? 'call' : null);
const FUT_PRODUCTS = ['fut_large', 'fut_mini', 'fut_micro'] as const;
type FutProduct = (typeof FUT_PRODUCTS)[number];
const isFutProduct = (v: unknown): v is FutProduct =>
  typeof v === 'string' && (FUT_PRODUCTS as readonly string[]).includes(v);

/** 入力に知らないキーがあるか */
const unknownKeys = (o: Record<string, unknown>, known: readonly string[]) =>
  Object.keys(o).some((k) => !known.includes(k));

// ---------------------------------------------------------------- 要約

/** 行使価格の幅（円。#260）: put_width_x / call_width_x / short_gap_x。決まらなければ null */
export interface StrikeWidths {
  put_width_x: number | null;
  call_width_x: number | null;
  short_gap_x: number | null;
}

/**
 * 形の幅（#260）: AI が行使価格の差を自分で引かずに写せるように、意味のある幅だけを返す。OP の足が 1 限月のときだけ
 * （先物の足は見ない。2 限月以上は全部 null）。
 * - put_width_x / call_width_x: その種別の行使価格がちょうど 2 つで、買いと売りが両方あるとき（縦の幅。put_ratio・
 *   bull_put・アイアンコンドルの翼）= 高い K − 低い K
 * - short_gap_x: 売りの put と売りの call の行使価格がそれぞれ 1 つのとき（ストラングル・コンドルの間）= call の K − put の K
 */
export function strikeWidths(legs: ReadonlyArray<{ leg: Leg }>): StrikeWidths {
  const none: StrikeWidths = { put_width_x: null, call_width_x: null, short_gap_x: null };
  const ops = legs.flatMap((p) => (p.leg.kind === 'option' ? [p.leg] : []));
  if (ops.length === 0 || new Set(ops.map((l) => l.expiry)).size !== 1) return none;
  const vertical = (type: OptionType): number | null => {
    const xs = ops.filter((l) => l.type === type);
    const ks = [...new Set(xs.map((l) => l.strike))].sort((a, b) => a - b);
    const both = xs.some((l) => l.side === 'buy') && xs.some((l) => l.side === 'sell');
    return ks.length === 2 && both ? (ks[1] as number) - (ks[0] as number) : null;
  };
  const shortK = (type: OptionType) => [
    ...new Set(ops.filter((l) => l.type === type && l.side === 'sell').map((l) => l.strike)),
  ];
  const sp = shortK('put');
  const sc = shortK('call');
  return {
    put_width_x: vertical('put'),
    call_width_x: vertical('call'),
    short_gap_x: sp.length === 1 && sc.length === 1 ? (sc[0] as number) - (sp[0] as number) : null,
  };
}

/** ポジションの要約（提案の前 / 後・候補。満期の最大損益・受払・必要証拠金・余力・何倍・Δ・Θ・V・追証の水準） */
export function proposalSummary(env: AiToolEnv, base: PnlBase, calls = true): ToolResult {
  const { legs, ctx, settings, profile } = base;
  const lossInf = profile.maxLoss.value === Number.NEGATIVE_INFINITY;
  const profitInf = profile.maxProfit.value === Number.POSITIVE_INFINITY;
  // 無限のときは値を出さない（節目の最悪値は無限の側を表さない。候補は shocks の SQ 損益で語る）
  const loss = lossInf ? null : profile.maxLoss;
  const profit = profitInf ? null : profile.maxProfit;
  const prem = premiumSummary(legs, settings);
  const now = evaluatePosition(legs, ZERO_SCENARIO, ctx, settings);
  const { params, capital } = env.margin;
  const m = marginNow(base, env.scenario, params, capital, env.holidays);
  const g = greeksOf(now.total);
  const multipleInf = m?.multiple === Number.POSITIVE_INFINITY;
  return {
    n_legs: legs.length,
    premium_net_yen: yen(prem.net),
    max_profit_yen: yen(profit?.value),
    max_profit_unbounded: profitInf,
    max_loss_yen: yen(loss?.value),
    max_loss_x: yen(loss?.x),
    max_loss_unbounded: lossInf,
    margin_yen: m ? yen(m.result.margin) : null,
    room_yen: m ? yen(m.room) : null,
    multiple: m && !multipleInf ? r1(m.multiple) : null,
    delta_large: g.delta_large,
    delta_mini: g.delta_mini,
    theta_yen_per_day: g.theta_yen_per_day,
    vega_yen_per_pt: g.vega_yen_per_pt,
    ...strikeWidths(legs),
    call_levels_x:
      calls && capital !== null
        ? marginLine(base, env.scenario, params, capital, env.holidays)
            .slice(0, CALL_LEVELS_MAX)
            .map(yen)
        : [],
  };
}

/** 評価できる足（base.legs と同じ並び。leg_no は 1 から） */
function evaluableLegs(draft: ProposeDraft): { legs: UiLeg[]; ev: DraftEval } {
  const ev = draft.evalLegs(draft.legs);
  return { legs: draft.legs.filter((_, i) => ev.evaluable[i] === true), ev };
}

const nextIdOf = (legs: readonly UiLeg[]) => legs.reduce((n, l) => Math.max(n, l.id), 0) + 1;

// ---------------------------------------------------------------- 足を作る

type AddSpec = {
  product: 'op' | FutProduct;
  type?: OptionType;
  expiry?: string;
  k?: number;
  side: Side;
  qty: number;
};

/** 入力の足（add / new_tab の legs）→ 検査した指定（形が違えば bad_input） */
function parseLegInput(o: Record<string, unknown>, extra: readonly string[] = []): AddSpec | Err {
  if (unknownKeys(o, ['product', 'type', 'expiry', 'k', 'side', 'qty', ...extra])) {
    return 'bad_input';
  }
  const product = o.product ?? 'op';
  if (!isSide(o.side)) return 'bad_input';
  const qty = o.qty ?? 1;
  if (!isInt(qty, 1, QTY_MAX)) return 'bad_input';
  if (product === 'op') {
    const type = optType(o.type);
    if (!type || !isMonth(o.expiry) || !isNum(o.k) || o.k <= 0) return 'bad_input';
    return { product, type, expiry: o.expiry, k: o.k, side: o.side, qty };
  }
  if (!isFutProduct(product)) return 'bad_input';
  if (o.type !== undefined || o.k !== undefined) return 'bad_input';
  if (o.expiry !== undefined && !isMonth(o.expiry)) return 'bad_input';
  return { product, ...(o.expiry !== undefined && { expiry: o.expiry }), side: o.side, qty };
}

/** 指定 → 足（板に無ければ not_on_board。reducer の addBoardLeg / addFutureLeg と同じ作り） */
function buildLeg(env: AiToolEnv, a: AddSpec, id: number): UiLeg | Err {
  const { chain } = env;
  if (a.product === 'op') {
    try {
      const built = boardOptionLeg(chain, {
        expiry: a.expiry as string,
        k: a.k as number,
        type: a.type as OptionType,
        side: a.side,
        qty: a.qty,
      });
      return { id, leg: built.leg, marks: built.marks };
    } catch {
      return 'not_on_board';
    }
  }
  // 先物は板の先物の限月だけ（限月違いは手入力の市場になる = 板に無い）
  if (a.expiry !== undefined && a.expiry !== chain.future.id) return 'not_on_board';
  try {
    const built = futureLeg(chain, { product: a.product, side: a.side, qty: a.qty }, env.holidays);
    return {
      id,
      leg: built.leg,
      marks: built.marks,
      futureMarket: { contract: built.leg.contract, market: built.market },
    };
  } catch {
    return 'not_on_board';
  }
}

const quoted = (ui: UiLeg) => !ui.marks.includes('no_quote');

// ---------------------------------------------------------------- propose_position

export type ProposeTarget = 'current' | 'new_tab';

export interface ProposalPlan {
  target: ProposeTarget;
  /** 反映後の足の列（current は作業中のタブの全部の足。new_tab は新しいタブの足） */
  legs: UiLeg[];
  diff: ToolResult[];
  /** 今の評価できる足の名札（current の反映の時点の照合。new_tab は空） */
  legsBefore: Record<string, unknown>[];
  before: PnlBase | null;
  after: PnlBase;
}

const CHANGE_KEYS = [
  'action',
  'leg_no',
  'product',
  'type',
  'expiry',
  'k',
  'side',
  'qty',
  'max_loss_floor_yen',
  'abs_delta',
] as const;
const CANDIDATE_IN_KEYS = ['structure', 'abs_delta', 'expiry', 'qty', 'wing_pct'];
/** abs_delta の範囲（k を省いて |Δ| で選ばせるとき） */
export const ABS_DELTA_RANGE = [0.01, 0.6] as const;
const isAbsDelta = (v: unknown): v is number =>
  isNum(v) && v >= ABS_DELTA_RANGE[0] && v <= ABS_DELTA_RANGE[1];

/**
 * add の k を省いたときに simulator が選ぶ（#139。1 回の往復で提案まで進めるため）: max_loss_floor_yen = strike_scan の
 * best_k（下限を満たす中で受払が最も有利）、abs_delta = OTM 側で |Δ| が最も近い両気配の行。選んだ入力（k 入り）か
 * 理由を返す
 */
function pickStrike(
  env: AiToolEnv,
  c: Record<string, unknown>,
): { input: Record<string, unknown>; by: 'floor' | 'delta' | null } | Err {
  const { action: _a, max_loss_floor_yen: floor, abs_delta: delta, ...rest } = c;
  if (floor === undefined && delta === undefined) return { input: rest, by: null };
  if (rest.k !== undefined || (floor !== undefined && delta !== undefined)) return 'bad_input';
  if ((rest.product ?? 'op') !== 'op') return 'bad_input';
  const type = optType(rest.type);
  if (!type || !isSide(rest.side)) return 'bad_input';
  const m = monthFor(env, rest.expiry);
  if (typeof m === 'string') return m;
  let k: number | null;
  if (floor !== undefined) {
    const r = strikeScan(env, {
      type: rest.type,
      side: rest.side,
      expiry: m.id,
      ...(rest.qty !== undefined && { qty: rest.qty }),
      max_loss_floor_yen: floor,
    });
    if ('error' in r) return r.error;
    k = r.best_k;
  } else {
    if (!isAbsDelta(delta)) return 'bad_input';
    k = strikeByDelta(env.chain, m, type, delta);
  }
  if (k === null) return 'no_candidate';
  return { input: { ...rest, expiry: m.id, k }, by: floor !== undefined ? 'floor' : 'delta' };
}

/** new_tab の candidate（型・|Δ|）→ 足の入力（structure_candidates と同じ作り） */
function candidateLegs(env: AiToolEnv, o: unknown): Record<string, unknown>[] | Err {
  if (!isObj(o) || unknownKeys(o, CANDIDATE_IN_KEYS)) return 'bad_input';
  const s = o.structure;
  if (typeof s !== 'string' || !(STRUCTURES as readonly string[]).includes(s)) return 'bad_input';
  const delta = o.abs_delta ?? 0.15;
  const qty = o.qty ?? 1;
  const wing = o.wing_pct ?? WING_PCT_DEFAULT;
  if (!isAbsDelta(delta) || !isInt(qty, 1, QTY_MAX)) return 'bad_input';
  if (!isNum(wing) || wing < WING_PCT_RANGE[0] || wing > WING_PCT_RANGE[1]) return 'bad_input';
  const m = monthFor(env, o.expiry);
  if (typeof m === 'string') return m;
  const atmK = m.atm[env.atmBasis].pick?.k ?? null;
  const spec = structureLegs(env.chain, atmK, m, s as Structure, delta, wing);
  if (!spec) return 'no_candidate';
  return spec.map((x) => ({
    product: 'op',
    type: x.type === 'put' ? 'P' : 'C',
    expiry: m.id,
    k: x.k,
    side: x.side,
    qty: x.mul * qty,
  }));
}

function diffOf(change: string, ui: UiLeg, legNo: number | null, extra: ToolResult = {}) {
  return {
    change,
    leg_no: legNo,
    ...legId(ui),
    entry_yen: Math.round(ui.leg.entry * 10) / 10 || 0,
    quoted: quoted(ui),
    ...extra,
  };
}

/**
 * propose_position の入力 → 反映の計画（検査に落ちたら { error }）。画面の [適用] も同じ関数で、押した時点の state から
 * 作り直す
 */
export function planProposal(
  env: AiToolEnv,
  input: Record<string, unknown>,
): ProposalPlan | ToolError {
  const draft = env.draft;
  if (!draft) return err('no_data');
  if (unknownKeys(input, ['target', 'changes', 'legs', 'candidate'])) return err('bad_input');
  const target = input.target;
  if (target === 'new_tab') {
    if (input.changes !== undefined) return err('bad_input');
    if ((input.legs === undefined) === (input.candidate === undefined)) return err('bad_input');
    let raw: unknown[];
    if (input.candidate !== undefined) {
      const c = candidateLegs(env, input.candidate);
      if (typeof c === 'string') return err(c);
      raw = c;
    } else if (Array.isArray(input.legs)) raw = input.legs;
    else return err('bad_input');
    if (raw.length < 1 || raw.length > PROPOSE_MAX_LEGS) return err('bad_input');
    const legs: UiLeg[] = [];
    const diff: ToolResult[] = [];
    for (const [i, o] of raw.entries()) {
      if (!isObj(o)) return err('bad_input');
      const spec = parseLegInput(o);
      if (typeof spec === 'string') return err(spec);
      const ui = buildLeg(env, spec, i + 1);
      if (typeof ui === 'string') return err(ui);
      legs.push(ui);
      diff.push(diffOf('add', ui, null));
    }
    const ev = draft.evalLegs(legs);
    if (!ev.base || ev.evaluable.some((x) => !x) || ev.base.legs.length !== legs.length) {
      return err('not_on_board');
    }
    return { target, legs, diff, legsBefore: [], before: null, after: ev.base };
  }
  if (target !== 'current') return err('bad_input');
  if (input.legs !== undefined || input.candidate !== undefined || !Array.isArray(input.changes)) {
    return err('bad_input');
  }
  const changes = input.changes;
  if (changes.length < 1 || changes.length > PROPOSE_MAX_CHANGES) return err('bad_input');
  const { legs: evLegs, ev: evBefore } = evaluableLegs(draft);
  const replaced = new Map<number, UiLeg | null>(); // 評価できる足の番号（0 始まり）→ 新しい足（null = 削除）
  const adds: UiLeg[] = [];
  const diff: ToolResult[] = [];
  let id = nextIdOf(draft.legs);
  for (const c of changes) {
    if (!isObj(c) || unknownKeys(c, CHANGE_KEYS)) return err('bad_input');
    const action = c.action;
    if (action === 'add') {
      if (c.leg_no !== undefined) return err('bad_input');
      const picked = pickStrike(env, c);
      if (typeof picked === 'string') return err(picked);
      const spec = parseLegInput(picked.input);
      if (typeof spec === 'string') return err(spec);
      const ui = buildLeg(env, spec, id++);
      if (typeof ui === 'string') return err(ui);
      adds.push(ui);
      diff.push(diffOf('add', ui, null, picked.by ? { picked_by: picked.by } : {}));
      continue;
    }
    if (action !== 'remove' && action !== 'set_qty' && action !== 'move_strike') {
      return err('bad_input');
    }
    if (c.max_loss_floor_yen !== undefined || c.abs_delta !== undefined) return err('bad_input');
    if (!isInt(c.leg_no, 1, evLegs.length))
      return err(evLegs.length === 0 ? 'no_legs' : 'bad_input');
    const i = c.leg_no - 1;
    if (replaced.has(i)) return err('bad_input'); // 同じ足を 2 回変えない
    const cur = evLegs[i] as UiLeg;
    if (action === 'remove') {
      const extraKeys = ['product', 'type', 'expiry', 'k', 'side', 'qty'].filter(
        (k) => c[k] !== undefined,
      );
      if (extraKeys.length > 0) return err('bad_input');
      replaced.set(i, null);
      diff.push(diffOf('remove', cur, c.leg_no));
      continue;
    }
    if (action === 'set_qty') {
      if (!isInt(c.qty, 1, QTY_MAX) || c.qty === cur.leg.qty) return err('bad_input');
      if (['k', 'side', 'type', 'product', 'expiry'].some((k) => c[k] !== undefined)) {
        return err('bad_input');
      }
      const next: UiLeg = { ...cur, leg: { ...cur.leg, qty: c.qty } };
      replaced.set(i, next);
      diff.push(diffOf('qty', next, c.leg_no, { from_qty: cur.leg.qty }));
      continue;
    }
    // move_strike（板の OP の足だけ）
    if (
      !isNum(c.k) ||
      ['qty', 'side', 'type', 'product', 'expiry'].some((k) => c[k] !== undefined)
    ) {
      return err('bad_input');
    }
    if (cur.leg.kind !== 'option') return err('bad_input');
    if (c.k === cur.leg.strike) return err('bad_input');
    const next = legAtStrike(env.chain, cur, c.k);
    if (!next) return err('not_on_board');
    replaced.set(i, next);
    diff.push(diffOf('strike', next, c.leg_no, { from_k: cur.leg.strike }));
  }
  // 作業中の足の並びのまま置き換え・削除し、追加は末尾
  const evIds = new Map(evLegs.map((l, i) => [l.id, i]));
  const legs: UiLeg[] = [];
  for (const l of draft.legs) {
    const i = evIds.get(l.id);
    if (i === undefined || !replaced.has(i)) legs.push(l);
    else {
      const n = replaced.get(i);
      if (n) legs.push(n);
    }
  }
  legs.push(...adds);
  if (legs.length > PROPOSE_MAX_LEGS) return err('bad_input');
  const ev = draft.evalLegs(legs);
  if (!ev.base || ev.base.legs.length === 0) return err('bad_input'); // 全部を消す提案は出さない
  return {
    target,
    legs,
    diff,
    legsBefore: evLegs.map((l) => legId(l)),
    before: evBefore.base,
    after: ev.base,
  };
}

/** propose_position のツール（検査 + 前 → 後の要約） */
export function proposePosition(env: AiToolEnv, input: Record<string, unknown>) {
  const plan = planProposal(env, input);
  if ('error' in plan) return plan;
  return {
    target: plan.target,
    diff: plan.diff,
    legs_before: plan.legsBefore,
    before: plan.before && plan.before.legs.length > 0 ? proposalSummary(env, plan.before) : null,
    after: proposalSummary(env, plan.after),
  };
}

/** 反映の時点の照合: 今の評価できる足の名札が提案のときと同じか（current だけ） */
export function sameLegsBefore(env: AiToolEnv, result: unknown): boolean {
  if (!isObj(result) || !Array.isArray(result.legs_before) || !env.draft) return false;
  const now = evaluableLegs(env.draft).legs.map((l) => legId(l));
  return JSON.stringify(now) === JSON.stringify(result.legs_before);
}

// ---------------------------------------------------------------- 候補の行使価格

// 仕組みは ui/view/strikePick.ts（#20 で戦略テンプレートと共用にした。中身は #139 のまま）

/** 限月の指定 → 板の限月（省略 = 既定の限月。形の誤りは bad_input、板に無い・スマイルが無いは not_on_board） */
export function monthFor(env: AiToolEnv, expiry: unknown): ChainMonth | Err {
  if (expiry === undefined) return defaultMonthOf(env.chain, env.draft?.legs ?? []) ?? 'no_data';
  if (!isMonth(expiry)) return 'bad_input';
  const m = env.chain.months.find((x) => x.id === expiry);
  if (!m?.smile || !fin(m.F)) return 'not_on_board';
  return m;
}

// ---------------------------------------------------------------- strike_scan

export const SCAN_KEYS = ['type', 'side', 'expiry', 'qty', 'max_loss_floor_yen', 'k_min', 'k_max'];

/** strike_scan のツール */
export function strikeScan(env: AiToolEnv, input: Record<string, unknown>) {
  const draft = env.draft;
  if (!draft) return err('no_data');
  if (unknownKeys(input, SCAN_KEYS)) return err('bad_input');
  const type = optType(input.type);
  const side = input.side;
  const qty = input.qty ?? 1;
  const floor = input.max_loss_floor_yen;
  if (!type || !isSide(side) || !isInt(qty, 1, QTY_MAX)) return err('bad_input');
  if (floor !== undefined && !(isNum(floor) && floor <= 0)) return err('bad_input');
  for (const k of ['k_min', 'k_max'] as const) {
    if (input[k] !== undefined && !(isNum(input[k]) && (input[k] as number) > 0)) {
      return err('bad_input');
    }
  }
  const m = monthFor(env, input.expiry);
  if (typeof m === 'string') return err(m);
  const lo =
    (input.k_min as number | undefined) ?? (type === 'put' ? m.F * (1 - SCAN_DEFAULT_RANGE) : m.F);
  const hi =
    (input.k_max as number | undefined) ?? (type === 'put' ? m.F : m.F * (1 + SCAN_DEFAULT_RANGE));
  if (!(lo <= hi)) return err('bad_input');
  const before = evaluableLegs(draft).ev.base;
  const id = nextIdOf(draft.legs);
  type Row = { k: number; prem: number; out: ToolResult; meets: boolean | null };
  const rows: Row[] = [];
  for (const k of quotedStrikes(m, type)) {
    if (k < lo || k > hi) continue;
    const ui = buildLeg(env, { product: 'op', type, expiry: m.id, k, side, qty }, id);
    if (typeof ui === 'string') continue;
    const ev = draft.evalLegs([...draft.legs, ui]);
    if (!ev.base) continue;
    const s = proposalSummary(env, ev.base, false);
    const legPrem = (side === 'sell' ? 1 : -1) * ui.leg.entry * ui.leg.qty * 1000;
    const lossOk =
      s.max_loss_unbounded === false && typeof s.max_loss_yen === 'number'
        ? s.max_loss_yen >= (floor as number)
        : false;
    const meets = floor === undefined ? null : lossOk;
    rows.push({
      k,
      prem: legPrem,
      meets,
      out: {
        k,
        entry_yen: Math.round(ui.leg.entry * 10) / 10 || 0,
        leg_premium_yen: yen(legPrem),
        max_loss_yen: s.max_loss_yen,
        max_loss_unbounded: s.max_loss_unbounded,
        margin_yen: s.margin_yen,
        delta_large: s.delta_large,
        delta_mini: s.delta_mini,
        meets_floor: meets,
      },
    });
  }
  if (rows.length === 0) return err('not_on_board');
  // 下限を満たす中で受払が最も有利（掛け金が最小 / 受取が最大）な行
  let best: Row | null = null;
  for (const r of rows) if (r.meets === true && (best === null || r.prem > best.prem)) best = r;
  let shown = rows;
  if (rows.length > SCAN_MAX_ROWS) {
    // 下限の境（満たす / 満たさないが入れ替わる所）の周り。無ければ F に近い行
    const edge = rows.findIndex((r, i) => i > 0 && r.meets !== (rows[i - 1] as Row).meets);
    let center = edge;
    if (edge < 0 || floor === undefined) {
      center = 0;
      rows.forEach((r, i) => {
        if (Math.abs(r.k - m.F) < Math.abs((rows[center] as Row).k - m.F)) center = i;
      });
    }
    const start = Math.min(
      Math.max(center - Math.floor(SCAN_MAX_ROWS / 2), 0),
      rows.length - SCAN_MAX_ROWS,
    );
    shown = rows.slice(start, start + SCAN_MAX_ROWS);
  }
  return {
    expiry: m.id,
    type: type === 'put' ? 'P' : 'C',
    side,
    qty,
    forward: yen(m.F),
    max_loss_floor_yen: floor === undefined ? null : yen(floor),
    before: before && before.legs.length > 0 ? proposalSummary(env, before, false) : null,
    best_k: best ? best.k : null,
    n_scanned: rows.length,
    rows: shown.map((r) => r.out),
  };
}

// ---------------------------------------------------------------- structure_candidates

type LegSpec = { type: OptionType; k: number; side: Side; mul: number };

/**
 * 型 × |Δ| の足（put / call の単体の売りはここ、ほかの 6 形は戦略テンプレートの shapeLegs（ui/view/templates.ts。#20 で
 * 共通にした。|Δ| の距離・atmK を渡す = #139 と同じ行を選ぶ））
 */
function structureLegs(
  chain: Chain,
  atmK: number | null,
  m: ChainMonth,
  s: Structure,
  d: number,
  wingPct: number,
): LegSpec[] | null {
  switch (s) {
    case 'short_put': {
      const k = strikeByDelta(chain, m, 'put', d);
      return k === null ? null : [{ type: 'put', k, side: 'sell', mul: 1 }];
    }
    case 'short_call': {
      const k = strikeByDelta(chain, m, 'call', d);
      return k === null ? null : [{ type: 'call', k, side: 'sell', mul: 1 }];
    }
    default: {
      const r = shapeLegs(chain, m, s, {
        basis: 'A',
        dist: { kind: 'delta', value: d },
        n: 0,
        wingPct,
        atmK,
      });
      return r.ok ? r.legs.map(({ type, k, side, mul }) => ({ type, k, side, mul })) : null;
    }
  }
}

export const CANDIDATE_KEYS = ['structure', 'expiry', 'qty', 'wing_pct'];

/** structure_candidates のツール */
export function structureCandidates(env: AiToolEnv, input: Record<string, unknown>) {
  const draft = env.draft;
  if (!draft) return err('no_data');
  if (unknownKeys(input, CANDIDATE_KEYS)) return err('bad_input');
  const s = input.structure;
  if (typeof s !== 'string' || !(STRUCTURES as readonly string[]).includes(s)) {
    return err('bad_input');
  }
  const qty = input.qty ?? 1;
  const wingPct = input.wing_pct ?? WING_PCT_DEFAULT;
  // put_ratio の売りは 2 倍の枚数（枚数の上限を越えない）
  if (!isInt(qty, 1, Math.floor(QTY_MAX / 2))) return err('bad_input');
  if (!isNum(wingPct) || wingPct < WING_PCT_RANGE[0] || wingPct > WING_PCT_RANGE[1]) {
    return err('bad_input');
  }
  const m = monthFor(env, input.expiry);
  if (typeof m === 'string') return err(m);
  const deltas = s === 'short_straddle' ? [0.5] : CANDIDATE_DELTAS;
  const seen = new Set<string>();
  const out: ToolResult[] = [];
  for (const d of deltas) {
    const atmK = m.atm[env.atmBasis].pick?.k ?? null;
    const spec = structureLegs(env.chain, atmK, m, s as Structure, d, wingPct);
    if (!spec) continue;
    const key = JSON.stringify(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    const legs: UiLeg[] = [];
    for (const [i, x] of spec.entries()) {
      const ui = buildLeg(
        env,
        { product: 'op', type: x.type, expiry: m.id, k: x.k, side: x.side, qty: x.mul * qty },
        i + 1,
      );
      if (typeof ui === 'string') break;
      legs.push(ui);
    }
    if (legs.length !== spec.length) continue;
    const ev = draft.evalLegs(legs);
    const base = ev.base;
    if (!base || base.legs.length !== legs.length) continue;
    const x0 = base.ctx.x0;
    out.push({
      id: `c${out.length + 1}`,
      target_abs_delta: s === 'short_straddle' ? null : r2(d),
      legs: legs.map((l) => ({ ...legId(l), entry_yen: Math.round(l.leg.entry * 10) / 10 || 0 })),
      breakevens_x: base.profile.breakevens.slice(0, 4).map(yen),
      shocks: CANDIDATE_SHOCKS_PCT.map((p) => {
        const x = x0 * (1 + p / 100);
        return { shock_pct: p, x: yen(x), sq_pnl_yen: yen(base.expiry(x)) };
      }),
      summary: proposalSummary(env, base),
    });
  }
  if (out.length === 0) return err('not_on_board');
  return {
    structure: s,
    expiry: m.id,
    forward: yen(m.F),
    qty,
    wing_pct: r1(wingPct),
    capital_yen: env.margin.capital === null ? null : yen(env.margin.capital),
    candidates: out,
  };
}

// ---------------------------------------------------------------- カード（画面の表示）

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

function money(v: unknown, signed = true): string {
  const n = num(v);
  if (n === null) return '—';
  const unit = Math.abs(n) >= THOUSAND_YEN_FROM ? 'thousand' : 'yen';
  return `${fmtAmount(n, unit, signed)} ${AMOUNT_UNIT_LABEL[unit]}`;
}

const SIDE_TEXT: Record<string, string> = { buy: '買', sell: '売' };
/** 建値（整数は小数を付けない） */
const entryText = (v: unknown) => {
  const n = num(v);
  return fmtNum(n, n !== null && !Number.isInteger(n) ? 1 : 0);
};
const FUT_TEXT: Record<string, string> = {
  fut_large: 'ラージ先物',
  fut_mini: 'ミニ先物',
  fut_micro: 'マイクロ先物',
};

/** 足の 1 行（限月 種別 K 売買 ×枚数） */
export function legText(l: Record<string, unknown>): string {
  const side = SIDE_TEXT[String(l.side)] ?? '—';
  const qty = num(l.qty);
  if (l.product !== 'op') {
    return `${FUT_TEXT[String(l.product)] ?? '先物'} ${String(l.expiry ?? '')} ${side} ×${fmtNum(qty)}`;
  }
  return `${String(l.expiry ?? '')} ${l.type === 'P' ? 'P' : 'C'} ${fmtNum(num(l.k))} ${side} ×${fmtNum(qty)}`;
}

export interface ProposalLine {
  mark: '+' | '−' | '±';
  text: string;
}

export interface ProposalCard {
  target: ProposeTarget;
  title: string;
  lines: ProposalLine[];
  /** 前 → 後（new_tab は後だけ） */
  metrics: string[];
  button: string;
}

function lossText(s: Record<string, unknown>): string {
  return s.max_loss_unbounded === true ? '無限' : money(s.max_loss_yen);
}

const deltaText = (s: Record<string, unknown>) =>
  `${fmtNum(num(s.delta_large), 2)} 枚（ミニ ${fmtNum(num(s.delta_mini), 2)} 枚）`;

const callsText = (s: Record<string, unknown>) => {
  const xs = Array.isArray(s.call_levels_x) ? s.call_levels_x.map(num) : [];
  const ok = xs.filter((x): x is number => x !== null);
  return ok.length === 0 ? null : ok.map((x) => fmtNum(x)).join(' · ');
};

/**
 * propose_position の結果 → カード（失敗・形が違えば null = カードを出さない）。held = 作業中のタブが保有（#301）:
 * 今のタブ向けの提案もボタンを「新しいタブに入れる」にする（title・差分は今のタブとの比較のまま）
 */
export function proposalCard(
  input: Record<string, unknown>,
  result: unknown,
  held = false,
): ProposalCard | null {
  if (!isObj(result) || typeof result.error === 'string') return null;
  const target =
    result.target === 'new_tab' ? 'new_tab' : result.target === 'current' ? 'current' : null;
  if (target === null || target !== input.target || !Array.isArray(result.diff)) return null;
  const after = obj(result.after);
  if (num(after.n_legs) === null) return null;
  const lines: ProposalLine[] = result.diff.map((d0) => {
    const d = obj(d0);
    const no = num(d.leg_no);
    const at = no === null ? '' : `足 ${fmtNum(no)}: `;
    const q = d.quoted === false ? '（気配なし）' : '';
    switch (d.change) {
      case 'remove':
        return { mark: '−', text: `${at}${legText(d)}` };
      case 'qty':
        return { mark: '±', text: `${at}${legText(d)}（×${fmtNum(num(d.from_qty))} から）` };
      case 'strike':
        return {
          mark: '±',
          text: `${at}K ${fmtNum(num(d.from_k))} → ${fmtNum(num(d.k))}（${legText(d)} · 建値 ${entryText(d.entry_yen)}）${q}`,
        };
      default: {
        const by =
          d.picked_by === 'floor'
            ? ' · 最大損失の下限から選んだ K'
            : d.picked_by === 'delta'
              ? ' · |Δ| から選んだ K'
              : '';
        return { mark: '+', text: `${legText(d)} · 建値 ${entryText(d.entry_yen)}${q}${by}` };
      }
    }
  });
  const before = isObj(result.before) ? result.before : null;
  const arrow = (a: string | null, b: string) => (a === null ? b : `${a} → ${b}`);
  const metrics = [
    `満期の最大損失 ${arrow(before && lossText(before), lossText(after))}`,
    `必要証拠金 ${arrow(before && money(before.margin_yen, false), money(after.margin_yen, false))}`,
    `Δ ${arrow(before && deltaText(before), deltaText(after))}`,
  ];
  const calls = callsText(after);
  if (calls !== null) metrics.push(`追証の水準 ${calls} 円`);
  return {
    target,
    title: target === 'current' ? 'ポジションの提案（今のタブ）' : 'ポジションの提案（新しいタブ）',
    lines,
    metrics,
    button:
      proposeApplyTarget(target, held) === 'current' ? '今のタブに適用' : '新しいタブに入れる',
  };
}

/**
 * 提案を入れる先（#301）: 作業中のタブが保有なら、今のタブ向けの提案も新しいタブ（検討中）に入れる（保有のタブの
 * 足の記録を一括で書き換えない）。足の組は今のタブに適用したときと同じ
 */
export function proposeApplyTarget(target: ProposeTarget, held: boolean): ProposeTarget {
  return held && target === 'current' ? 'new_tab' : target;
}

// ---------------------------------------------------------------- 反映（[今のタブに適用] / [新しいタブに入れる]）

/** 差分の同一性（変更の種類・番号・足の名札・前の値。建値・気配は見ない） */
function diffKey(diff: readonly unknown[]): string {
  const keys = [
    'change',
    'leg_no',
    'product',
    'type',
    'expiry',
    'k',
    'side',
    'qty',
    'from_qty',
    'from_k',
  ];
  return JSON.stringify(diff.map((d) => keys.map((k) => (isObj(d) ? (d[k] ?? null) : null))));
}

export type ProposalApply =
  | { target: ProposeTarget; legs: UiLeg[] }
  /** changed = 提案の後に作業中のタブの足が変わった。invalid = 今の板で作れない（板の読み直し・ツールの結果の形） */
  | { error: 'changed' | 'invalid' };

/**
 * 押した時点のツールの環境で、提案を作り直す（同じ planProposal）。current は今の評価できる足の名札が提案のときと
 * 同じときだけ（違えば changed = 番号がずれた差分を当てない）
 */
export function proposalApply(
  env: AiToolEnv | null,
  input: Record<string, unknown>,
  result: unknown,
): ProposalApply {
  if (!env || !isObj(result) || typeof result.error === 'string') return { error: 'invalid' };
  if (input.target === 'current' && !sameLegsBefore(env, result)) return { error: 'changed' };
  const plan = planProposal(env, input);
  if ('error' in plan) return { error: 'invalid' };
  // k を省いた提案は押した時点の板で選び直す: カードの足と違えば反映しない（板が読み直された）
  if (!Array.isArray(result.diff) || diffKey(plan.diff) !== diffKey(result.diff)) {
    return { error: 'changed' };
  }
  return { target: plan.target, legs: plan.legs };
}

/** 反映できないときのトーストの文 */
export const PROPOSAL_APPLY_ERROR: Record<'changed' | 'invalid', string> = {
  changed: 'ポジションか板が提案の後に変わったので反映しません。もう一度 AI に頼んでください',
  invalid: '今の板では提案の足を作れません（板が変わった可能性）。もう一度 AI に頼んでください',
};

/** タブが上限で新しいタブに入れられないときの文 */
export const newTabFullText = (max: number) =>
  `タブが上限（${max} 個）です。タブを閉じてから [新しいタブに入れる] を押してください`;

// ---------------------------------------------------------------- 新しいタブの [元に戻す]（#139 レビュー B1）

// 仕組みは ui/view/newTab.ts（#301 で保有のタブの建て直しの写しと共用にした）。import 先を変えないよう再び公開する
export { type NewTabUndo, newTabPlan, newTabUndoActions } from './newTab';

/** [元に戻す] できないときの文 */
export const NEW_TAB_UNDO_TEXT = {
  edited: '提案のタブを編集したので戻しません（タブは × で閉じられます）',
  gone: '提案のタブはもう閉じています',
} as const;

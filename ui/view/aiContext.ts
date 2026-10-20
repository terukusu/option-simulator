/**
 * AI に送る文脈（#135。docs/design.md 14 章・K15）。画面の状態 → 中継の許可リスト（api/src/simulator_api/ai/allowlist.py
 * の context_shape）の形。純関数（DOM・通信・時計に依存しない）。
 *
 * - 板: 限月ごとの F・ATM の行使価格と IV（%）・残存日数・スマイルの要約（log-moneyness m = ln(K/F) の 11 点の IV）。
 *   板の行（気配）は送らない（MVP。smile_position のツールで足りる。入力が 1/3 程度になり予約額・速さに効く）
 * - 送らないもの: JPX のグリーク・bid_iv / ask_iv・数量・建玉・自由な文字列（タブ名など）
 * - ポジション: 評価できる足（PnlBase の足）だけ。シナリオ: 日数（最遠の SQ に収めた値）・IV の平行移動・ΔX・スキュー・β・
 *   IV の入れ方・横軸の初期範囲。資金: 端末の設定（未設定なら無し）
 * - precomputed: ツール 5 本の事前計算（ui/view/aiTools.ts）
 * - 指紋（contextKey）: 決定的な JSON（キーの順）。会話の途中で変わったら次の発言に context_update を足す（aiChat.ts）
 */

import type { AiContext } from '../../data/aiStream';
import { DEFAULT_SETTINGS, type ModelSettings } from '../../model';
import type { MarginPrefs } from '../prefs';
import type { State, UiLeg } from '../state';
import type { DraftEval } from './aiPropose';
import { type AiToolEnv, legId, precompute, yen } from './aiTools';
import { capitalOf, marginParamsOf } from './margin';
import { clampDays, pnlDomains, scenarioFull, withScenarioFull } from './pnlChart';
import { positionModel } from './position';

/** スマイルの要約の点（m = ln(K/F)） */
export const CONTEXT_SMILE_M = [
  -0.2, -0.15, -0.1, -0.05, -0.025, 0, 0.025, 0.05, 0.1, 0.15, 0.2,
] as const;
/** 中継の上限（allowlist.py の MAX_EXPIRIES・MAX_LEGS） */
export const CONTEXT_MAX_EXPIRIES = 6;
export const CONTEXT_MAX_LEGS = 20;

const r = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f || 0;
};
const fin = (v: number) => Number.isFinite(v);

function sourceOf(s: string | null): AiContext['snapshot']['source'] {
  if (s === 'bigquery' || s === 'synthetic' || s === 'manual') return s;
  return 'file';
}

/**
 * 画面の状態（ui/state.ts）と端末の証拠金の設定 → ツールの環境（板が無ければ null）。useAppController と同じ組み立て
 * （評価の設定・足の市場・損益グラフの基礎・シナリオ点で広げた全域）。画面（useAiChat）と評価用スクリプトが共用する
 */
export function aiEnvFromState(state: State, margin: MarginPrefs): AiToolEnv | null {
  const chain = state.chain;
  if (!chain) return null;
  const settings: ModelSettings = {
    ...DEFAULT_SETTINGS,
    feePerLot: state.feePerLot,
    futureBasis: state.futureBasis,
  };
  const evalLegs = (legs: readonly UiLeg[]): DraftEval => {
    const pm = positionModel(chain, legs, state.atmBasis, state.calendar, settings);
    const board = pnlDomains(chain, pm.prepared, pm.ctx, settings);
    return {
      base: board ? withScenarioFull(board, scenarioFull(board, state.scenario.dX)) : null,
      evaluable: pm.rows.map((r) => r.error === null),
    };
  };
  const { base } = evalLegs(state.legs);
  return {
    chain,
    base,
    scenario: state.scenario,
    atmBasis: state.atmBasis,
    margin: { params: marginParamsOf(margin), capital: capitalOf(margin) },
    holidays: state.calendar.holidays,
    draft: { legs: state.legs, evalLegs },
  };
}

/** 画面の状態 → 文脈（足が CONTEXT_MAX_LEGS 本を超えるときは呼ばない = aiChat の押せない理由） */
export function buildAiContext(env: AiToolEnv): AiContext {
  const { chain, base, scenario } = env;
  const ctx: AiContext = {
    snapshot: {
      snapshot_at: chain.snapshotAtText,
      source: sourceOf(chain.source),
      delayed_minutes: Math.min(Math.max(Math.round(chain.delayedMinutes), 0), 60),
    },
  };
  const expiries: NonNullable<AiContext['expiries']> = [];
  for (const m of chain.months) {
    const smile = m.smile?.smile;
    const k = m.atm[env.atmBasis].pick?.k;
    if (!smile || !fin(m.F) || m.F <= 0 || k === undefined || !fin(m.T)) continue;
    const atmIv = smile.sigma(Math.log(k / m.F)) * 100;
    const pts = CONTEXT_SMILE_M.map((x) => ({ m: x, iv: r(smile.sigma(x) * 100, 1) }));
    if (!fin(atmIv) || pts.some((p) => !fin(p.iv) || p.iv < 0 || p.iv > 300)) continue;
    expiries.push({
      expiry: m.id,
      sq_date: m.sqDate,
      t_days: r(Math.max(m.T, 0) * 365, 2),
      forward: r(m.F, 1),
      atm_k: k,
      atm_iv: r(atmIv, 1),
      smile: pts,
    });
    if (expiries.length >= CONTEXT_MAX_EXPIRIES) break;
  }
  if (expiries.length > 0) ctx.expiries = expiries;
  if (base && base.legs.length > 0) {
    ctx.position = {
      legs: base.legs.slice(0, CONTEXT_MAX_LEGS).map((p) => ({
        ...(legId(p) as Omit<NonNullable<AiContext['position']>['legs'][number], 'price'>),
        price: r(Math.max(p.leg.entry, 0), 1),
      })),
    };
    const lo = base.initial[0];
    const hi = base.initial[1];
    if (fin(lo) && fin(hi) && lo > 0 && hi > lo) {
      ctx.scenario = {
        days: r(clampDays(scenario, base.maxDays).days, 2),
        iv_shift_pt: r(fin(scenario.dSigma) ? scenario.dSigma : 0, 1),
        x_range: [yen(lo) ?? 0, yen(hi) ?? 0],
        dx_yen: yen(fin(scenario.dX) ? scenario.dX : 0) ?? 0,
        skew_pt: r(fin(scenario.skew) ? scenario.skew : 0, 1),
        beta: r(fin(scenario.beta) ? scenario.beta : 0, 2),
        iv_mode: scenario.ivShift,
      };
    }
  }
  const capital = env.margin.capital;
  if (capital !== null && fin(capital) && capital > 0)
    ctx.capital = { capital_yen: Math.round(capital) };
  const pre = precompute(env);
  if (Object.keys(pre).length > 0) ctx.precomputed = pre;
  return ctx;
}

/** 決定的な JSON（キーの順。中継の allowlist.canonical と同じ並び） */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v).sort();
    return `{${keys
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 文脈の指紋（同じ状態 → 同じ文字列） */
export const contextKey = (c: AiContext): string => canonicalJson(c);

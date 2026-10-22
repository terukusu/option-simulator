/**
 * AI のツール strike_quote（#266。docs/design.md 14 章）。純関数（DOM・通信・時計に依存しない）。
 *
 * 任意の行使価格（板に無い遠い OTM を含む）について、スマイルの IV（今の線）と、#264 の理論価格（周りの行から =
 * その行の気配を使わず、周りの気配の狭い行のスマイルの IV で Black-76）・使った IV・その行の気配と気配の中の位置を返す。
 * 値は画面と同じ関数（model/ の smileFairIvs・fairValueOf・fairPosition、ui/view/fairValue.ts の桁）= 板の K の
 * ポップオーバー・スマイルの操作行・足の詳細の「理論価格（周りの行から）」と同じ数字。
 */

import type { OptionType } from '../../model';
import { fairPosition, fairValueOf, smileFairIvs } from '../../model';
import { monthFor } from './aiPropose';
import { fin, r1, yen } from './aiRound';
import type { AiToolEnv, ToolError, ToolResult } from './aiTools';
import { fairPriceRound } from './fairValue';

/** 1 回で聞ける行使価格の数（中継の QUOTE_MAX_KS） */
export const QUOTE_MAX_KS = 10;
/** 行使価格の F に対する比の範囲（外は out_of_range。スマイルの外挿が意味を持たない所） */
export const QUOTE_K_RATIO = [0.3, 2] as const;
export const QUOTE_KEYS = ['ks', 'expiry', 'type'];

const err = (e: ToolError['error']): ToolError => ({ error: e });

/** strike_quote のツール */
export function strikeQuote(
  env: AiToolEnv,
  input: Record<string, unknown>,
): ToolResult | ToolError {
  if (Object.keys(input).some((k) => !QUOTE_KEYS.includes(k))) return err('bad_input');
  const ks = input.ks;
  if (
    !Array.isArray(ks) ||
    ks.length < 1 ||
    ks.length > QUOTE_MAX_KS ||
    !ks.every((k) => typeof k === 'number' && Number.isFinite(k) && k > 0)
  ) {
    return err('bad_input');
  }
  const want = input.type;
  if (want !== undefined && want !== 'P' && want !== 'C') return err('bad_input');
  const m = monthFor(env, input.expiry);
  if (typeof m === 'string') return err(m);
  const smile = m.smile?.smile;
  if (!smile || !fin(m.F) || m.F <= 0 || !(m.T > 0)) return err('not_on_board');
  const strikes = [...new Set(ks as number[])].sort((a, b) => a - b);
  if (strikes.some((k) => k / m.F < QUOTE_K_RATIO[0] || k / m.F > QUOTE_K_RATIO[1])) {
    return err('out_of_range');
  }
  const r = env.chain.r;
  const ivs = smileFairIvs(m.smile, m.F, m.T, strikes);
  const rows = strikes.map((k, i) => {
    const type: OptionType =
      want === 'P' ? 'put' : want === 'C' ? 'call' : k < m.F ? 'put' : 'call';
    const j = m.strikes.findIndex((s) => s.k === k);
    const info = j >= 0 ? m.strikes[j] : undefined;
    const q = j >= 0 ? m.rows[j]?.[type] : undefined;
    const bid = q && q.bid !== null && q.bid > 0 ? q.bid : null;
    const ask = q && q.ask !== null && q.ask > 0 ? q.ask : null;
    const x = Math.log(k / m.F);
    const fair = fairValueOf(ivs[i] ?? null, m.F, m.T, r, k, type);
    const pos = fair ? fairPosition(fair.price, bid, ask) : null;
    return {
      k,
      type: type === 'put' ? 'P' : 'C',
      on_board: info !== undefined,
      moneyness_pct: r1((k / m.F - 1) * 100),
      smile_iv_pct: r1(smile.sigma(x) * 100),
      smile_mark: smile.mark(x),
      fair_yen: fair ? fairPriceRound(fair.price) : null,
      fair_iv_pct: fair ? r1(fair.iv * 100) : null,
      fair_mark: fair ? fair.mark : null,
      bid_yen: bid,
      ask_yen: ask,
      fair_position: pos,
      iv_unstable: info ? info.unstable : null,
    };
  });
  return {
    expiry: m.id,
    sq_date: m.sqDate,
    t_days: r1(m.T * 365),
    forward: yen(m.F),
    rows,
  };
}

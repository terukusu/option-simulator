/**
 * 建値を今の板に合わせる（#298。純関数。DOM・時計に依存しない）。設計 docs/design.md 5.3。
 *
 * 作業中のタブの足の建値を、今の板で建てたらいくらになるかに一括で合わせ直す:
 * - OP の足: 売り = bid / 買い = ask。必要な側の気配があれば片側気配でも使う（data/legs.ts の quotedSidePrice）。
 *   mid と行の印（気配なし・IV 不安定・外挿・補間）も今の板の行のものにする。IV の編集・id・枚数・売買・並び・
 *   手入力の足の市場（optionMarket）は保つ。手入力の足も限月・行使価格が今の板にあれば同じ規則
 * - 先物の足: data/legs.ts の futureLeg の初期値と同じ（板の先物の限月は先物価格、限月違いはその月の合成先物か
 *   先物価格）。建値だけを変え、印・市場は保つ（板を読んだときに今の板に合わせ済み）
 * - 据え置き: 必要な側の気配が無い行（気配なし・逆転を含む）、板に無い限月・行使価格、先物価格なし。
 *   その足は何も変えない（同じ参照を返す）。気配なしの行の建値の既定（ask − 呼値など）は使わない
 */

import { boardOptionLeg, type Chain, futureLeg, quotedSidePrice } from '../data';
import type { Holidays, OptionLeg } from '../model';
import type { UiLeg } from './state';

export interface RebaseResult {
  /** 建て直した足（入力と同じ本数・並び・id） */
  legs: UiLeg[];
  /** 建値が変わった本数 */
  changed: number;
  /** 建て直せず据え置いた本数（建て直せたが建値が同じ足はどちらにも数えない） */
  kept: number;
}

/** 1 本の足を建て直す（建て直せなければ null）。 */
function rebaseLeg(chain: Chain, ui: UiLeg, holidays: Holidays): UiLeg | null {
  const leg = ui.leg;
  if (leg.kind === 'option') {
    const input = { expiry: leg.expiry, k: leg.strike, type: leg.type, side: leg.side };
    const entry = quotedSidePrice(chain, input);
    if (entry === null) return null;
    try {
      const built = boardOptionLeg(chain, { ...input, qty: leg.qty, entry });
      const next: OptionLeg = { ...built.leg, product: leg.product };
      if (leg.iv !== undefined) next.iv = leg.iv;
      const out: UiLeg = { id: ui.id, leg: next, marks: built.marks };
      if (ui.optionMarket) out.optionMarket = ui.optionMarket;
      return out;
    } catch {
      return null;
    }
  }
  try {
    const built = futureLeg(
      chain,
      { product: leg.product, contract: leg.contract, side: leg.side, qty: leg.qty },
      holidays,
    );
    return { ...ui, leg: { ...leg, entry: built.leg.entry } };
  } catch {
    return null;
  }
}

/**
 * 足の建値を今の板に合わせる。板が無ければ全部を据え置く（例外を投げない）。
 * 冪等: 結果をもう一度通すと changed は 0。
 */
export function rebaseLegs(
  chain: Chain | null,
  legs: readonly UiLeg[],
  holidays: Holidays,
): RebaseResult {
  if (!chain) return { legs: legs.slice(), changed: 0, kept: legs.length };
  let changed = 0;
  let kept = 0;
  const out = legs.map((ui) => {
    const next = rebaseLeg(chain, ui, holidays);
    if (!next) {
      kept += 1;
      return ui;
    }
    if (next.leg.entry !== ui.leg.entry) changed += 1;
    return next;
  });
  return { legs: out, changed, kept };
}

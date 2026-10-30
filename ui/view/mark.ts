/**
 * 今の値段（今の板での評価価格。純関数）。設計 docs/design.md 5.3・13.4（#70・#299）。
 *
 * 保存一覧の評価損益（ui/view/bookList.ts の markToBoard）と、前の板で建てた足の時価評価（ui/view/position.ts の
 * positionModel が prepareLeg に渡す今の値段）が同じ物差しを使う（画面のシナリオ 0 の損益 = 保存一覧の評価損益）。
 * bookList.ts は position.ts を import するので、両方から使うこの関数は別のファイルに置く（循環しない）。
 */

import { type Chain, monthOf } from '../../data';
import { black76Price, DEFAULT_SETTINGS, discountedIntrinsic, type Leg } from '../../model';

/**
 * 評価損益の評価価格（オーナー確認の対象。ここだけ変えれば一覧・説明の文言が変わる）:
 * 'mid' = 両側気配の仲値（無ければスマイルの理論価格）。返済側の気配での決済損益は出さない
 */
export const MARK_BASIS = 'mid' as const;
export const MARK_BASIS_TEXT = '今の板の mid（無ければスマイルの理論価格）';

export interface MarkPrice {
  price: number;
  /** スマイルの理論価格・合成先物で評価した */
  theoretical: boolean;
}

/** 1 本の足の今の板での評価価格（評価できなければ null）。 */
export function markPrice(
  chain: Chain,
  leg: Leg,
  tMin: number = DEFAULT_SETTINGS.tMin,
): MarkPrice | null {
  if (leg.kind === 'future') {
    const p = chain.future.price;
    if (leg.contract === chain.future.id) {
      return p !== null && Number.isFinite(p) ? { price: p, theoretical: false } : null;
    }
    const m = monthOf(chain, leg.contract);
    return m?.syntheticOk && Number.isFinite(m.F) ? { price: m.F, theoretical: true } : null;
  }
  const month = monthOf(chain, leg.expiry);
  if (!month) return null;
  const side = month.strikes.find((s) => s.k === leg.strike)?.[leg.type];
  if (side && side.quote === 'two_sided' && side.mid !== null && Number.isFinite(side.mid)) {
    return { price: side.mid, theoretical: false };
  }
  const F = month.F;
  if (!month.smile || !(Number.isFinite(F) && F > 0)) return null;
  const K = leg.strike;
  const T = month.T;
  const sigma = month.smile.smile.sigma(Math.log(K / F));
  const price =
    T > tMin && Number.isFinite(sigma) && sigma > 0
      ? black76Price(leg.type, F, K, T, sigma, chain.r)
      : discountedIntrinsic(leg.type, F, K, Math.max(T, 0), chain.r);
  return Number.isFinite(price) ? { price, theoretical: true } : null;
}

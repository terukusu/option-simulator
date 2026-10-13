/**
 * シナリオ ATM（純関数）。設計 docs/design.md 5.9・13.4（#26）。
 *
 * - 限月 i の X₀,i' = underlyingAt(X₀,i, X₀, X₀ + ΔX, basisMode)（円モードで X₀,i + ΔX）。X₀,i は選択中の
 *   基準 A / B の基準価格（B が決まらなければ A へのフォールバックは month.atm[basis].reference のまま）
 * - シナリオ ATM = findAtm(month.rows, X₀,i')。板の ATM（市場 ATM）と同じ関数・同じ同距離の規則
 * - X₀,i' が板の行使価格の範囲（最小 K〜最大 K）の外、基準価格が決まらない限月は無し（null）。
 *   端の行使価格を ATM と言わない
 * - d・Δσ・Δs・β・sticky・先物の basis 減衰は効かない（引数に取らない）
 * - 板の ATM 行の強調・ヘッダの ATM・スマイルの市場 ATM はこれを使わない（ΔX で動かない）
 */

import type { ChainMonth } from '../../data';
import { type AtmBasis, type AtmPick, type BasisMode, findAtm, underlyingAt } from '../../model';

const positive = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/** シナリオ後の基準価格 X₀,i'（決まらなければ null）。 */
export function scenarioAtmReference(
  month: Pick<ChainMonth, 'atm'>,
  basis: AtmBasis,
  x0: number,
  dX: number,
  mode: BasisMode = 'yen',
): number | null {
  const ref = month.atm[basis].reference.price;
  if (!positive(ref) || !positive(x0) || !Number.isFinite(dX)) return null;
  const v = underlyingAt(ref, x0, x0 + dX, mode);
  return Number.isFinite(v) ? v : null;
}

/** シナリオ ATM（板の行使価格の範囲外・基準価格が決まらなければ null）。 */
export function scenarioAtm(
  month: Pick<ChainMonth, 'atm' | 'rows'>,
  basis: AtmBasis,
  x0: number,
  dX: number,
  mode: BasisMode = 'yen',
): AtmPick | null {
  const ref = scenarioAtmReference(month, basis, x0, dX, mode);
  if (ref === null || month.rows.length === 0) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const r of month.rows) {
    if (r.k < lo) lo = r.k;
    if (r.k > hi) hi = r.k;
  }
  if (ref < lo || ref > hi) return null;
  return findAtm(month.rows, ref);
}

/**
 * グラフ・スマイルに出すシナリオ ATM の印（ΔX ≠ 0 のときだけ。ΔX = 0 では市場 ATM と同じなので出さない）。
 */
export function scenarioAtmMark(
  month: Pick<ChainMonth, 'atm' | 'rows'>,
  basis: AtmBasis,
  x0: number,
  dX: number,
  mode: BasisMode = 'yen',
): AtmPick | null {
  return dX !== 0 && Number.isFinite(dX) ? scenarioAtm(month, basis, x0, dX, mode) : null;
}

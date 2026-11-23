/**
 * 追証の線（#131 段 C。設計 docs/design.md 5.10）を、入力が止まってから作るフック（DOM・CSS を持たない）。
 *
 * - 入力（useAppController の marginLineInput）は ΔX 以外のシナリオ・足・板・設定・資金・パラメータ・休業日・当て直しの
 *   r・g だけに依存する（ΔX・パン・拡大では参照が変わらない = 作り直さない）
 * - 入力が変わった描画では線を隠し（空）、MARGIN_LINE_SETTLE_MS 変わらなければ作り始める。JSCC の当て直し（#387）は
 *   状態 1 つが数 ms なので、生成器（marginLineSteps）を 1 切れ ≤ 8 ms で回す（useSettledSteps）
 * - 入力が null（資金が未設定・足なし）なら空
 * - useMarginLineState は作っている間を null で返す（保有ポジションの一覧の「計算中…」。#302）
 */

import { type MarginLineInput, marginLineSteps } from '../view/margin';
import { useSettledSteps } from './useSettledSteps';

export type { MarginLineInput };

const NONE: readonly number[] = [];

const steps = (i: MarginLineInput) =>
  marginLineSteps(i.base, i.scenario, i.params, i.capital, i.holidays, i.factors ?? null);

/** 追証の線の X。null = 入力があってまだ作っていない（計算中）。入力が null なら空 */
export function useMarginLineState(input: MarginLineInput | null): readonly number[] | null {
  const xs = useSettledSteps(input, steps);
  if (!input) return NONE;
  return xs;
}

export function useMarginLine(input: MarginLineInput | null): readonly number[] {
  return useMarginLineState(input) ?? NONE;
}

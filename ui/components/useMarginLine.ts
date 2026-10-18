/**
 * 追証の線（#131 段 C。設計 docs/design.md 5.10）を、入力が止まってから作るフック（DOM・CSS を持たない）。
 *
 * - 入力（useAppController の marginLineInput）は ΔX 以外のシナリオ・足・板・設定・資金・パラメータ・休業日だけに
 *   依存する（ΔX・パン・拡大では参照が変わらない = 作り直さない）
 * - 入力が変わった描画では線を隠し（空）、MARGIN_LINE_SETTLE_MS 変わらなければ 1 回だけ作る（d・Δσ・Δs・β の連続の
 *   操作の間は作らない。1 回 ≈ 格子 30 点 × (分割 + 二分法) の評価で、スライダーの 1 フレームに入らないため）
 * - 入力が null（資金が未設定・足なし）なら空
 */

import { useEffect, useState } from 'preact/hooks';
import type { Holidays, MarginParams, Scenario } from '../../model';
import { MARGIN_LINE_SETTLE_MS, marginLine } from '../view/margin';
import type { PnlBase } from '../view/pnlChart';

export interface MarginLineInput {
  base: PnlBase;
  /** ΔX 以外のシナリオ（ΔX は見ない） */
  scenario: Scenario;
  params: MarginParams;
  capital: number;
  holidays: Holidays;
}

const NONE: readonly number[] = [];

export function useMarginLine(input: MarginLineInput | null): readonly number[] {
  const [line, setLine] = useState<{ key: MarginLineInput; xs: readonly number[] } | null>(null);
  useEffect(() => {
    if (!input) return;
    // 次の変化が来たら取り消して待ち直す（止まってから 1 回だけ作る）
    const id = setTimeout(() => {
      const { base, scenario, params, capital, holidays } = input;
      setLine({ key: input, xs: marginLine(base, scenario, params, capital, holidays) });
    }, MARGIN_LINE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [input]);
  // 作った時の入力と今の入力が違えば隠す（入力が変わった描画で前の線を残さない）
  return input && line && line.key === input ? line.xs : NONE;
}

/**
 * 追証マップ（#152。設計 docs/design.md 5.11）のマスの計算を、入力が止まってから列ごとに回すフック（DOM を持たない）。
 *
 * - 入力（useAppController の holdMapInput）は 板の基礎・d・Δs・動き方・パラメータ・資金・休業日だけに依存する
 *   （ΔX・Δσ・β・ivShift・パン・拡大では参照が変わらない = 作り直さない）。軸は過去の点が読めて広がったときだけ変わる
 * - 入力か軸が変わったら HOLD_MAP_SETTLE_MS 待ち（開いただけ = 前に見た入力・軸と同じなら待たない。#176 の holdMapSettleMs）、列（余力と損益）ごとに setTimeout(0) で回す（1 切れ ≤ HOLD_MAP_SLICE_MS。列が単位）。
 *   途中で入力が変わったら捨てて待ち直す。計算中は前のマップを残す（computing = true。部品が薄くして aria-busy）
 * - active（マップが見えている）でなければ計算しない（見えたときに作る）
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type HoldMapAxes,
  type HoldMapPoint,
  holdMapAxes,
  holdMapColumn,
  holdMapPnlColumn,
} from '../../model';
import {
  HOLD_MAP_SLICE_MS,
  type HoldMapInput,
  type HoldMapResult,
  holdMapCalcOf,
  holdMapSettleMs,
} from '../view/holdMap';

export interface HoldMapCtl {
  /** 最後に作り終えたマップ（入力・軸が今と違えば前のマップ） */
  result: HoldMapResult | null;
  /** 今の入力・軸のマップを作っている（前のマップを薄くして残す） */
  computing: boolean;
}

const sameAxis = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** 点（過去の 2 営業日の動き）から軸を作る。値が同じなら前の参照を返す（読み込みの後に作り直さない） */
function useAxes(points: readonly HoldMapPoint[]): HoldMapAxes {
  const prev = useRef<HoldMapAxes | null>(null);
  return useMemo(() => {
    const next = holdMapAxes(points);
    const p = prev.current;
    if (p && sameAxis(p.us, next.us) && sameAxis(p.cs, next.cs)) return p;
    prev.current = next;
    return next;
  }, [points]);
}

export function useHoldMap(
  input: HoldMapInput | null,
  points: readonly HoldMapPoint[],
  active: boolean,
): HoldMapCtl {
  const axes = useAxes(points);
  const [result, setResult] = useState<HoldMapResult | null>(null);
  const done = !!result && result.input === input && result.axes === axes;
  // 前に効果が走ったときの入力・軸（active でないときも控える = 開いただけなら待たない）
  const seen = useRef<{ input: HoldMapInput | null; axes: HoldMapAxes } | null>(null);
  useEffect(() => {
    const prev = seen.current;
    seen.current = { input, axes };
    if (!input || !active || done) return;
    let timer = 0;
    let cancelled = false;
    const calc = holdMapCalcOf(input);
    const rooms: Float64Array[] = [];
    const pnls: Float64Array[] = [];
    const slice = () => {
      if (cancelled) return;
      const t0 = performance.now();
      do {
        // 列ごとに余力と損益（#180）
        pnls.push(holdMapPnlColumn(calc, axes, rooms.length));
        rooms.push(holdMapColumn(calc, axes, rooms.length));
      } while (rooms.length < axes.us.length && performance.now() - t0 < HOLD_MAP_SLICE_MS);
      if (rooms.length < axes.us.length) timer = window.setTimeout(slice, 0);
      else setResult({ input, axes, rooms, pnls });
    };
    timer = window.setTimeout(slice, holdMapSettleMs(prev, input, axes));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, axes, active, done]);
  const shown = input ? result : null;
  const computing = !!input && !done;
  return useMemo(() => ({ result: shown, computing }), [shown, computing]);
}

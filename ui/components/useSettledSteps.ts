/**
 * 入力が止まってから、生成器（1 回の yield = 状態 1 つ）を切れごとに回すフック（DOM・CSS を持たない。#387）。
 *
 * - 入力が変わった描画では作り直しを待ち、MARGIN_LINE_SETTLE_MS 変わらなければ始める（d・Δσ・Δs・β の連続の操作の間は
 *   作らない）。1 切れは SETTLED_SLICE_MS まで（それを超えたら setTimeout(0) で次の切れ = 描画の 1 フレームに収める）
 * - 返す値: 今の入力で作り終えた値。作っている間・待っている間は null（呼び出し側が前の値を出すかを決める）
 * - 入力が null なら null。モデルは時計を読まない（切れの時間はここで測る）
 */

import { useEffect, useState } from 'preact/hooks';
import { MARGIN_LINE_SETTLE_MS } from '../view/margin';

/** 1 切れの上限（ms。追証マップの HOLD_MAP_SLICE_MS と同じ考え方 = 1 フレーム 16 ms の半分） */
export const SETTLED_SLICE_MS = 8;

export function useSettledSteps<I, T>(
  input: I | null,
  make: (input: I) => Generator<void, T, void>,
): T | null {
  const [done, setDone] = useState<{ key: I; value: T } | null>(null);
  useEffect(() => {
    if (input === null) return;
    let timer = 0;
    let alive = true;
    const g = make(input);
    const slice = () => {
      if (!alive) return;
      const t0 = performance.now();
      for (;;) {
        const r = g.next();
        if (r.done) {
          setDone({ key: input, value: r.value });
          return;
        }
        if (performance.now() - t0 >= SETTLED_SLICE_MS) break;
      }
      timer = window.setTimeout(slice, 0);
    };
    timer = window.setTimeout(slice, MARGIN_LINE_SETTLE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // make は呼び出し側の固定の関数（入力の参照だけで作り直す）
  }, [input]);
  if (input === null) return null;
  return done && done.key === input ? done.value : null;
}

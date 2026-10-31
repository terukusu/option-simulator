/**
 * 過去の急落の再生（#307。設計 docs/design.md 5.14）の計算を、入力が止まってから日ごとに回すフック（DOM を持たない）。
 *
 * - 入力（useAppController の replayInput）は 板の基礎・IV の動き方・パラメータ・資金・休業日だけに依存する
 *   （シナリオの d・ΔX・Δσ・β・Δs・パン・拡大では参照が変わらない = 作り直さない）。道筋は NextApp の useMemo
 *   （読み込んだ日次の値・選んだ出来事・nonTradingDays）
 * - 入力か道筋が変わったら HOLD_MAP_SETTLE_MS 待ち（前に見た入力・道筋と同じなら待たない）、日ごとに setTimeout(0) で
 *   回す（1 切れ ≤ REPLAY_SLICE_MS。日が単位）。途中で変わったら捨てて待ち直す。計算中は前の結果を残す
 *   （computing = true。部品が薄くして aria-busy）
 * - active（折りたたみが開いていて指標のパネルが見えている = shell.ts の replayActive）でなければ計算しない
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { HOLD_MAP_SETTLE_MS } from '../view/holdMap';
import {
  REPLAY_SLICE_MS,
  type ReplayInput,
  type ReplayPathOk,
  type ReplayResult,
  replayResultFrom,
  replayStep,
  replayWork,
} from '../view/replay';

export interface ReplayCtl {
  /** 最後に作り終えた結果（入力・道筋が今と違えば前の結果） */
  result: ReplayResult | null;
  /** 今の入力・道筋の結果を作っている */
  computing: boolean;
}

export function useReplay(
  input: ReplayInput | null,
  path: ReplayPathOk | null,
  active: boolean,
): ReplayCtl {
  const [result, setResult] = useState<ReplayResult | null>(null);
  const done = !!result && result.input === input && result.path === path;
  const seen = useRef<{ input: ReplayInput | null; path: ReplayPathOk | null } | null>(null);
  useEffect(() => {
    const prev = seen.current;
    seen.current = { input, path };
    if (!input || !path || !active || done) return;
    let timer = 0;
    let cancelled = false;
    const w = replayWork(input, path);
    const slice = () => {
      if (cancelled) return;
      const t0 = performance.now();
      let more = true;
      do {
        more = replayStep(w, path);
      } while (more && performance.now() - t0 < REPLAY_SLICE_MS);
      if (more) timer = window.setTimeout(slice, 0);
      else setResult(replayResultFrom(input, path, w));
    };
    const settle = prev && prev.input === input && prev.path === path ? 0 : HOLD_MAP_SETTLE_MS;
    timer = window.setTimeout(slice, settle);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [input, path, active, done]);
  // 出来事を変えたら前の出来事の結果は出さない（入力だけ変わったら前の結果を薄くして残す）
  const shown = input && path && result && result.path === path ? result : null;
  const computing = !!input && !!path && !done;
  return useMemo(() => ({ result: shown, computing }), [shown, computing]);
}

import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';
import { LIVE_INITIAL, LIVE_SETTLE_MS, type LiveState, liveNext, liveOn } from '../view/motion';

/**
 * 舞台の `.live` / `[data-live]`（docs/ui-redesign.md §6・§10.1「動き」。#91 段 C）のストア: 規則は ui/view/motion.ts の純関数、
 * 時刻とタイマーはここ。DOM を持たない（document の keydown を 1 つ受けるだけ）。
 * - liveHold(): 押している間 on。返り値で離す（離したら 2 フレーム後に外す = 最後の move の rAF を補間しない）
 * - livePulse(): 最後の 1 回から LIVE_SETTLE_MS の間 on
 * - useLiveAttr(ref): 今の値を要素の data-live 属性に直接入れる（Preact の props に無い属性なので描き直しと競合しない。
 *   切り替えで舞台を描き直さない = 連打・ドラッグの始めと終わりに描画を足さない）
 * 連続の操作の処理の中で dispatch より先に呼ぶ（属性は呼んだ時点で付くので、`d` の変更より先に transition が切れる）
 */
let state: LiveState = LIVE_INITIAL;
let on = false;
let timer = 0;
const subs = new Set<(v: boolean) => void>();

const now = () => performance.now();

function sync() {
  const t = now();
  const next = liveOn(state, t);
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  // パルスの残りの時間で外す（押している間は release が呼ぶ）
  if (next && state.holds === 0) {
    timer = window.setTimeout(sync, Math.max(1, state.pulseAt + LIVE_SETTLE_MS - t));
  }
  if (next === on) return;
  on = next;
  for (const f of subs) f(on);
}

/** 押している間 on。返り値を 1 回呼ぶと（2 フレーム後に）離す */
export function liveHold(): () => void {
  state = liveNext(state, { kind: 'hold' });
  sync();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        state = liveNext(state, { kind: 'release' });
        sync();
      }),
    );
  };
}

/** 1 回の連続の変化（最後から LIVE_SETTLE_MS の間 on） */
export function livePulse(): void {
  state = liveNext(state, { kind: 'pulse', now: now() });
  sync();
}

/** キーの押しっぱなし（repeat）は連続の変更（1 回ずつの押下は離散のまま補間する） */
const onKey = (e: KeyboardEvent) => {
  if (e.repeat) livePulse();
};

/** 今の値を ref の要素の data-live に入れ続ける。最初の購読者で document の keydown（capture）を 1 回だけ登録する */
export function useLiveAttr(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const set = (v: boolean) => ref.current?.toggleAttribute('data-live', v);
    if (subs.size === 0) document.addEventListener('keydown', onKey, true);
    subs.add(set);
    set(on);
    return () => {
      subs.delete(set);
      if (subs.size === 0) document.removeEventListener('keydown', onKey, true);
    };
  }, [ref]);
}

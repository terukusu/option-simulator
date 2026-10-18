/**
 * 動き（docs/ui-redesign.md §6・§10.1「動き」。#91 段 C）: 連続の変更の間だけ舞台の補間を切る `.live` の規則。
 * 純関数（時刻・タイマー・DOM は ui/next/live.ts のストアが持つ）。
 * - hold / release: 押している間（ポインタ。ピンチは 2 本）。release が多くても 0 未満にならない
 * - pulse: 1 回ずつの連続の変化（ホイール・キーの押しっぱなし・スクラブ・± の長押し・舞台の大きさ）。最後の 1 回から
 *   LIVE_SETTLE_MS の間 on
 * - liveBurst: 離散の変更でも、前の線の変化から LINE_MS（補間の時間）未満で続いたら連打 = 連続の変更として扱う
 *   （キーの 1 回ずつの押下・± のクリックの連打。補間が重なって 1 フレームが重くなるのを避ける）
 */
import { PIN_SETTLE_MS } from '../pins';

/** 最後の連続の変化から `.live` を保つ時間（ms）。ピンの線の描き直しの PIN_SETTLE_MS と同じ値 */
export const LIVE_SETTLE_MS = PIN_SETTLE_MS;

/** 線の補間の時間（ms）。tokens.css の --dur-line と同じ値（tests/ui/motion.test.ts で照合） */
export const LINE_MS = 220;

export interface LiveState {
  /** 押している数 */
  holds: number;
  /** 最後のパルスの時刻（ms。performance.now() の値） */
  pulseAt: number;
}

export type LiveEvent = { kind: 'hold' } | { kind: 'release' } | { kind: 'pulse'; now: number };

export const LIVE_INITIAL: LiveState = { holds: 0, pulseAt: Number.NEGATIVE_INFINITY };

export function liveNext(s: LiveState, ev: LiveEvent): LiveState {
  switch (ev.kind) {
    case 'hold':
      return { ...s, holds: s.holds + 1 };
    case 'release':
      return { ...s, holds: Math.max(0, s.holds - 1) };
    case 'pulse':
      if (!Number.isFinite(ev.now) || ev.now <= s.pulseAt) return s;
      return { ...s, pulseAt: ev.now };
  }
}

/** `.live` を付けるか: 押している間か、最後のパルスから LIVE_SETTLE_MS 未満 */
export function liveOn(s: LiveState, now: number): boolean {
  return s.holds > 0 || (Number.isFinite(now) && now - s.pulseAt < LIVE_SETTLE_MS);
}

/** 前の線の変化（prevAt）から LINE_MS 未満で次の変化が来たか（連打） */
export function liveBurst(prevAt: number, now: number): boolean {
  return Number.isFinite(now) && now - prevAt < LINE_MS;
}

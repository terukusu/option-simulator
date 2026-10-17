/**
 * 説明の吹き出し（ⓘ、#63）の純関数。部品は ui/components/Hint.tsx。
 */

/** 開閉のきっかけ。toggle = ⓘ を押した、outside = 外側のタップ、escape = Esc、other = 他の ⓘ が開いた。 */
export type HintEvent = 'toggle' | 'outside' | 'escape' | 'other';

/** 次の開閉の状態。toggle だけが反転し、ほかはすべて閉じる。 */
export function hintNext(open: boolean, ev: HintEvent): boolean {
  return ev === 'toggle' ? !open : false;
}

/**
 * 吹き出しを行（host）の左端に揃えるか右端に揃えるか。
 * ボタンの中心が行の右半分にあれば右端（end）に揃え、画面・列の右へはみ出さないようにする。
 */
export function hintAlign(
  btnCenterX: number,
  hostLeft: number,
  hostRight: number,
): 'start' | 'end' {
  if (!(hostRight > hostLeft)) return 'start';
  return btnCenterX > (hostLeft + hostRight) / 2 ? 'end' : 'start';
}

/**
 * 開いたポップオーバーをスクロールする祖先（host）の中で見せるための scrollTop の増分（px。正 = 下へ。#107）。
 * 下端がはみ出す量だけ動かすが、上端（popTop − hostTop）を越えて動かさない（上を隠さない）。負にならない。
 */
export function revealDelta(
  popTop: number,
  popBottom: number,
  hostTop: number,
  hostBottom: number,
): number {
  const over = popBottom - hostBottom;
  const room = popTop - hostTop;
  if (!(over > 0) || !Number.isFinite(over) || !Number.isFinite(room)) return 0;
  return Math.max(0, Math.min(over, room));
}

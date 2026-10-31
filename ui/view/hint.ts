/**
 * 説明の吹き出し（ⓘ、#63）の純関数。部品は ui/next/parts/Popover.tsx・Menu.tsx（旧画面の Hint は #91 で削除）。
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

/**
 * ポップオーバーをボタンの上に開くか（#320 第 2 弾で見つけた、窓の下端で切れる吹き出し）。下に開くと窓の下端（viewBottom）を
 * 越え、上に開けば窓の上端（viewTop）の内側に収まるときだけ true。どちらにも入らなければ下（今まで）のまま。
 * btnTop / btnBottom はボタン（.pop-wrap）の上端・下端、gap はボタンとポップオーバーのすき間、height はポップオーバーの高さ（px）。
 * 下に開くと btnBottom + gap 〜 + height、上に開くと btnTop − gap − height 〜 btnTop − gap
 */
export function hintAbove(
  btnTop: number,
  btnBottom: number,
  gap: number,
  height: number,
  viewTop: number,
  viewBottom: number,
): boolean {
  if (
    ![btnTop, btnBottom, gap, height, viewTop, viewBottom].every(Number.isFinite) ||
    !(height > 0)
  )
    return false;
  const g = Math.max(0, gap);
  if (btnBottom + g + height <= viewBottom) return false;
  return btnTop - g - height >= viewTop;
}

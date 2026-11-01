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
 * ポップオーバー（Popover）の左右の揃え（#344）。hintAlign の 2 択に、吹き出しの幅を見た第 3 の答え fit を足す。
 * 好み（ボタンの中心が基準の右半分なら end）の側に揃えて基準（host = within の祖先、無ければ窓）の中に入ればそれ、
 * 入らなければ反対側、どちらにも入らなければ fit（窓の左右 8px の内側で中央。.popover.fit）。
 * start = 左端をボタンの左端に揃える（btnLeft + popWidth ≤ hostRight）、end = 右端をボタンの右端に揃える
 * （btnRight − popWidth ≥ hostLeft）。どちらも 0.5px まで許す。測れない値（非有限・popWidth ≤ 0・基準の幅 0）は start。
 * Menu は 2 択の hintAlign のまま（#344 のスコープ外）
 */
export function popAlign(
  btnLeft: number,
  btnRight: number,
  popWidth: number,
  hostLeft: number,
  hostRight: number,
): 'start' | 'end' | 'fit' {
  if (
    ![btnLeft, btnRight, popWidth, hostLeft, hostRight].every(Number.isFinite) ||
    !(popWidth > 0) ||
    !(hostRight > hostLeft)
  )
    return 'start';
  const startFits = btnLeft + popWidth <= hostRight + 0.5;
  const endFits = btnRight - popWidth >= hostLeft - 0.5;
  const pref = hintAlign((btnLeft + btnRight) / 2, hostLeft, hostRight);
  if (pref === 'end' ? endFits : startFits) return pref;
  if (pref === 'end' ? startFits : endFits) return pref === 'end' ? 'start' : 'end';
  return 'fit';
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

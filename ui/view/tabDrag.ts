/**
 * BOX タブの帯のドラッグの並べ替え（#323。DOM・時計を持たない純関数の状態機械）。形は ui/chart/press.ts（パン・拡大の
 * 無い部品の pending / scroll）に倣い、距離・時間は損益グラフ（ui/chart/gesture.ts）と同じ数を使う。
 *
 * - マウス: 押して 6px（TAP_MOVE_PX）動けば grab（つかむ）。6px 未満で離せば何もしない（click = 今の切り替え / メニュー）
 * - タッチ・ペン: 6px 未満のまま LONG_PRESS_MS（450ms）経てば grab（DOM が振動）。その前に 6px 動けば scroll
 *   （帯の横スクロールに譲る。以後この押下は何もしない）
 * - grab: 位置（帯の中身の座標 = clientX − 帯の左 + scrollLeft）とつかんだ時点のチップの中心の並びから入れ替わり先 to を
 *   出し、touchmove を止める（block）。離せば to ≠ from のときだけ drop（確定）、その後の click を捨てる印
 * - 取りやめ（並びは押す前のまま）: Esc・pointercancel・2 本目の指（帯の外でも）・つかんでいる間に外からタブの並び / 数が
 *   変わった・pointer capture を失った・ウィンドウが blur / 隠れた（離すが届かないままつかんだ状態を残さない）
 * - 自動スクロール: つかんだ位置から TAB_EDGE_PX 動くか、一度でも端の帯の外（内側）に入るまでは流さない（端の近くの
 *   チップをつかんだだけで帯が流れない）
 * - click を捨てる印は TAB_CLICK_SWALLOW_MS で下ろす（click が来ないとき、後のキーの click を食わない）
 *
 * 距離は client 座標で見る（帯が横スクロールしても指の動きを数える）。入れ替わり先は帯の中身の座標で見る（自動スクロール
 * で帯が動いても指の下の位置が合う）。
 */

import { LONG_PRESS_MS, TAP_MOVE_PX } from '../chart/gesture';

/** 帯の見えている左右の端からこの距離（CSS px）以内で自動スクロール */
export const TAB_EDGE_PX = 24;
/** 自動スクロールの 1 フレームの最大（CSS px） */
export const TAB_EDGE_STEP_MAX = 12;
/**
 * click を捨てる印の寿命（ms）。ブラウザは離した直後（同じタスクか次のフレーム）に click を出すので、それより後の click
 * （Android の長押しの後の click が来なかったときのキーの Enter / Space など）は捨てない
 */
export const TAB_CLICK_SWALLOW_MS = 400;

export type TabDragMode = 'idle' | 'pending' | 'scroll' | 'grab';
/** pointerType（pen は touch と同じ扱い = 長押しでつかむ） */
export type TabDragKind = 'mouse' | 'touch';

export interface TabDragState {
  mode: TabDragMode;
  /** 追っている pointerId（idle なら null） */
  id: number | null;
  kind: TabDragKind;
  /** 押した位置（client 座標）と時刻 */
  x0: number;
  y0: number;
  t0: number;
  /** 押したチップの添字 */
  from: number;
  /** 今の入れ替わり先の添字（grab の間。それ以外は from） */
  to: number;
  /** 押した時点の各チップの中心（帯の中身の座標。左から昇順） */
  centers: readonly number[];
  /** 押した時点のタブの id の並び */
  ids: readonly number[];
  /** つかんだ位置（client 座標の x。grab の間） */
  gx: number;
  /** 自動スクロールしてよい（つかんだ位置から TAB_EDGE_PX 動いたか、端の帯の外に入った。grab の間） */
  armed: boolean;
}

export interface TabPointer {
  id: number;
  /** client 座標 */
  x: number;
  y: number;
}

export interface TabDragResult {
  state: TabDragState;
  /** つかんだ（DOM: 印・プレビュー・マウスなら pointer capture・メニューを閉じる） */
  grabbed?: true;
  /** 振動（タッチの長押しでつかんだ） */
  vibrate?: true;
  /** touchmove の preventDefault（grab の間） */
  block?: true;
  /** 確定（離した。to ≠ from のときだけ） */
  drop?: { id: number; to: number };
  /** この後の click を捨てる（つかんだ押下の click で切り替え / メニューを開かない） */
  swallowClick?: true;
  /** 取りやめ（プレビューを消して並びを押す前に戻す・タイマーを止める） */
  cancel?: true;
}

export function initialTabDrag(): TabDragState {
  return {
    mode: 'idle',
    id: null,
    kind: 'mouse',
    x0: 0,
    y0: 0,
    t0: 0,
    from: 0,
    to: 0,
    centers: [],
    ids: [],
    gx: 0,
    armed: false,
  };
}

const far = (s: TabDragState, p: TabPointer) => Math.hypot(p.x - s.x0, p.y - s.y0) >= TAP_MOVE_PX;

/**
 * 押下（主ボタン・チップの上だけ DOM が渡す）。idle のときだけ pending。idle でない（2 本目の指など）は取りやめ
 */
export function tabDragDown(
  s: TabDragState,
  p: TabPointer,
  t: number,
  kind: TabDragKind,
  from: number,
  ids: readonly number[],
  centers: readonly number[],
): TabDragResult {
  if (s.mode !== 'idle') return { state: initialTabDrag(), cancel: true };
  if (from < 0 || from >= ids.length || centers.length !== ids.length) return { state: s };
  return {
    state: {
      mode: 'pending',
      id: p.id,
      kind,
      x0: p.x,
      y0: p.y,
      t0: t,
      from,
      to: from,
      centers,
      ids,
      gx: p.x,
      armed: false,
    },
  };
}

/** 移動。cx = 帯の中身の座標（grab の入れ替わり先に使う） */
export function tabDragMove(s: TabDragState, p: TabPointer, cx: number): TabDragResult {
  if (p.id !== s.id) return { state: s };
  if (s.mode === 'pending' && far(s, p)) {
    if (s.kind === 'touch') return { state: { ...s, mode: 'scroll' } };
    const to = dropIndex(s.centers, s.from, cx);
    return { state: { ...s, mode: 'grab', to, gx: p.x, armed: false }, grabbed: true, block: true };
  }
  if (s.mode === 'grab') {
    const to = dropIndex(s.centers, s.from, cx);
    return { state: to === s.to ? s : { ...s, to }, block: true };
  }
  return { state: s };
}

/**
 * 長押しのタイマー（DOM が押下から LONG_PRESS_MS 後に呼ぶ。t は押下と同じ時計）。タッチで pending（6px 未満）のまま
 * LONG_PRESS_MS 経っていれば grab
 */
export function tabDragLongPress(s: TabDragState, t: number): TabDragResult {
  if (s.mode !== 'pending' || s.kind !== 'touch' || t - s.t0 < LONG_PRESS_MS) return { state: s };
  return {
    state: { ...s, mode: 'grab', to: s.from, gx: s.x0, armed: false },
    grabbed: true,
    vibrate: true,
    block: true,
  };
}

/** 離した。grab なら確定（to ≠ from のとき）と click を捨てる印 */
export function tabDragUp(s: TabDragState, p: TabPointer): TabDragResult {
  if (p.id !== s.id) return { state: s };
  if (s.mode !== 'grab') return { state: initialTabDrag() };
  const id = s.ids[s.from];
  const drop = s.to !== s.from && id !== undefined ? { drop: { id, to: s.to } } : {};
  return { state: initialTabDrag(), swallowClick: true, ...drop };
}

/**
 * 取りやめ（Esc・pointercancel・ウィンドウの blur / 隠れた）。pending / grab なら cancel。grab ならこの後の click も捨てる（離した位置のチップを
 * 押したことにしない）
 */
export function tabDragCancel(s: TabDragState): TabDragResult {
  if (s.mode === 'idle') return { state: s };
  if (s.mode === 'scroll') return { state: initialTabDrag() };
  return {
    state: initialTabDrag(),
    cancel: true,
    ...(s.mode === 'grab' ? { swallowClick: true as const } : {}),
  };
}

/**
 * pointer capture を失った（lostpointercapture。マウスでつかんでいる間に別のウィンドウへ移るなどで離すが届かない）。
 * 追っている pointer で grab のときだけ取りやめ（離した・取りやめた後の capture の解放は idle なので何もしない）
 */
export function tabDragLostCapture(s: TabDragState, pointerId: number): TabDragResult {
  if (s.mode !== 'grab' || pointerId !== s.id) return { state: s };
  return tabDragCancel(s);
}

/**
 * 自動スクロールの 1 フレーム。x = 最後の pointer の位置（client 座標）、帯の見えている左端と幅。grab でなければ 0。
 * つかんだ位置から TAB_EDGE_PX 動くか、端の帯の外（edgeScrollStep が 0 の位置）に一度入るまでは 0（armed で覚える）
 */
export function tabDragEdge(
  s: TabDragState,
  x: number,
  viewLeft: number,
  viewWidth: number,
): { state: TabDragState; step: number } {
  if (s.mode !== 'grab') return { state: s, step: 0 };
  const raw = edgeScrollStep(x, viewLeft, viewWidth);
  const armed = s.armed || raw === 0 || Math.abs(x - s.gx) >= TAB_EDGE_PX;
  return { state: armed === s.armed ? s : { ...s, armed }, step: armed ? raw : 0 };
}

/** click を捨てるか（since = 印を立てた時刻。null は印なし）。TAB_CLICK_SWALLOW_MS を過ぎた / 時計が戻ったら捨てない */
export function clickSwallowed(since: number | null, t: number): boolean {
  return since !== null && t >= since && t - since <= TAB_CLICK_SWALLOW_MS;
}

/** タブの並び・数が押した時点と違えば取りやめ（pending / grab の間。外から作業が変わった） */
export function tabDragSync(s: TabDragState, ids: readonly number[]): TabDragResult {
  if (s.mode !== 'pending' && s.mode !== 'grab') return { state: s };
  if (ids.length === s.ids.length && ids.every((id, i) => id === s.ids[i])) return { state: s };
  return { state: initialTabDrag(), cancel: true };
}

/**
 * 位置 x（帯の中身の座標）でのつかんだチップ（from）の入れ替わり先。from より左のチップは中心が x 以下なら左に残り、
 * 右のチップは中心が x 未満なら左へ回る（中心ちょうどは入れ替えない・左右対称）。0..n−1。非有限の x は from
 */
export function dropIndex(centers: readonly number[], from: number, x: number): number {
  if (!Number.isFinite(x)) return from;
  let n = 0;
  centers.forEach((c, j) => {
    if (j < from ? c <= x : j > from && c < x) n++;
  });
  return n;
}

/** 入れ替わって見える並び（id の列。from のタブを to へ） */
export function previewOrder(ids: readonly number[], from: number, to: number): number[] {
  const out = ids.slice();
  if (from < 0 || from >= ids.length) return out;
  const [x] = out.splice(from, 1);
  if (x === undefined) return out;
  out.splice(Math.min(Math.max(to, 0), out.length), 0, x);
  return out;
}

/**
 * 自動スクロールの 1 フレームの量（CSS px）。帯の見えている左右の端から TAB_EDGE_PX 以内（帯より外も含む）で、
 * 端に近いほど大きく（最大 TAB_EDGE_STEP_MAX）、左は負・右は正。それ以外・非有限の入力は 0
 */
export function edgeScrollStep(x: number, viewLeft: number, viewWidth: number): number {
  if (![x, viewLeft, viewWidth].every(Number.isFinite) || viewWidth <= 2 * TAB_EDGE_PX) return 0;
  const step = (d: number) =>
    Math.max(
      1,
      Math.round((TAB_EDGE_STEP_MAX * Math.min(TAB_EDGE_PX - d, TAB_EDGE_PX)) / TAB_EDGE_PX),
    );
  const left = x - viewLeft;
  if (left < TAB_EDGE_PX) return -step(Math.max(left, 0));
  const right = viewLeft + viewWidth - x;
  if (right < TAB_EDGE_PX) return step(Math.max(right, 0));
  return 0;
}

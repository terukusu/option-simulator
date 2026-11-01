/**
 * 足を新しいタブに入れる操作とその [元に戻す]（純関数）。AI の提案の [新しいタブに入れる]（#139 レビュー B1）と、
 * 保有のタブの「写しを今の板で建て直す」（#301）が共用する。ui/view/aiPropose.ts は import 先を変えないよう再び公開する。
 */

import type { Domain } from '../chart/scale';
import { type Action, reduce, type State, sameUiLeg, type UiLeg } from '../state';

/** [新しいタブに入れる] の控え（押した時点の作業中のタブ・横軸の表示範囲・入れた足） */
export interface NewTabUndo {
  /** 足したタブ */
  tab: number;
  /** 押したときに開いていたタブ */
  from: number;
  viewport: Domain | null;
  /** 足したタブに入った足（reducer を通した後。id は除く） */
  legs: ReadonlyArray<Omit<UiLeg, 'id'>>;
  /** 足したタブに保有の印を付けた（画像からの取り込み。#318）。[元に戻す] は印が付いたままのときだけ戻す */
  held?: true;
}

/**
 * [新しいタブに入れる] の action と控え（タブが上限なら null）。入った足は reducer を通した結果（足の市場の作り直しを含む）
 * で控える = [元に戻す] の照合が反映のときと同じ形になる。足したタブは保有の印なし（写しは検討中。#301）。
 * held = true は画像からの取り込み（#318）だけ: 足したタブに保有の印を付ける
 */
export function newTabPlan(
  st: State,
  legs: readonly UiLeg[],
  held = false,
): { action: Action; undo: NewTabUndo } | null {
  const action: Action = {
    type: 'openPositionInNewTab',
    legs: legs.map(({ id: _id, ...rest }) => rest),
    scenario: null,
    feePerLot: null,
    futureBasis: null,
    ...(held ? { held: true } : {}),
  };
  const next = reduce(st, action);
  if (next === st || next.tabs.length === st.tabs.length) return null;
  return {
    action,
    undo: {
      tab: next.activeTab,
      from: st.activeTab,
      viewport: st.pnlViewport,
      legs: next.legs.map(({ id: _id, ...rest }) => rest),
      ...(held ? { held: true as const } : {}),
    },
  };
}

const sameLegs = (
  a: ReadonlyArray<Omit<UiLeg, 'id'>>,
  b: ReadonlyArray<Omit<UiLeg, 'id'>>,
): boolean =>
  a.length === b.length &&
  a.every((l, i) => sameUiLeg({ ...l, id: 0 }, { ...(b[i] as Omit<UiLeg, 'id'>), id: 0 }));

/**
 * [新しいタブに入れる] の [元に戻す]: 押したときのタブに戻り、足したタブだけを閉じ、横軸の表示範囲を戻す。足したタブの
 * 足が反映のときと違う（利用者が編集した）か、利用者が足したタブの保有の印を変えた（#301。取り込み #318 は印を付けて
 * 入れたので、印を外したら変えた扱い）なら戻さない（edited = 利用者の操作を黙って捨てない）。足したタブがもう無ければ gone
 */
export function newTabUndoActions(s: State, u: NewTabUndo): Action[] | 'edited' | 'gone' {
  const slot = s.tabs.find((t) => t.id === u.tab);
  if (!slot) return 'gone';
  if ((slot.held === true) !== (u.held === true)) return 'edited';
  const cur = slot.saved
    ? slot.saved.legs
    : s.legs.map(({ id: _id, ...rest }) => rest as Omit<UiLeg, 'id'>);
  if (!sameLegs(cur, u.legs)) return 'edited';
  const out: Action[] = [];
  if (u.from !== u.tab && s.tabs.some((t) => t.id === u.from)) {
    out.push({ type: 'switchTab', id: u.from });
  }
  out.push({ type: 'closeTab', id: u.tab });
  if (out[0]?.type === 'switchTab') out.push({ type: 'setPnlViewport', viewport: u.viewport });
  return out;
}

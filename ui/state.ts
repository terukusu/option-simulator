/**
 * 画面の状態と reducer（純関数）。ポジションは画面の状態としてだけ持つ（保存は #8）。
 *
 * 足の追加は data/ の boardOptionLeg / manualOptionLeg / futureLeg を呼ぶだけ。評価（アンカー IV・
 * グリーク・建値ずれ）は表示モデル（view/position.ts）が毎回 model/ の preparePosition から求める。
 */

import {
  boardOptionLeg,
  type Chain,
  type FutureLegInput,
  futureLeg,
  type LegMark,
  type ManualOptionLegInput,
  manualOptionLeg,
} from '../data';
import type { AtmBasis, FutureMarket, Leg, OptionExpiryMarket, OptionType, Side } from '../model';
import type { Domain } from './chart/scale';
import type { SmileAxis } from './view/smile';

export interface UiLeg {
  id: number;
  leg: Leg;
  marks: LegMark[];
  /** 手入力の OP の足の市場（板に無い限月） */
  optionMarket?: { expiry: string; market: OptionExpiryMarket };
  /** 先物の足の市場（板の先物と限月違い・先物価格なし） */
  futureMarket?: { contract: string; market: FutureMarket };
}

export interface LoadErrorView {
  message: string;
  errors: string[];
}

export interface State {
  chain: Chain | null;
  /** 読み込んだ板の名前（fixture 名・ファイル名） */
  sourceLabel: string | null;
  loading: boolean;
  loadError: LoadErrorView | null;
  atmBasis: AtmBasis;
  monthId: string | null;
  /** 板の対象の種別（ジャンプ・絞り込み。スマホでは表示列の切替を兼ねる） */
  target: OptionType;
  filterAsk: boolean;
  smileAxis: SmileAxis;
  smileViewport: Domain | null;
  legs: UiLeg[];
  nextId: number;
  /** 足の追加フォームのエラー（data/ の例外の文言） */
  legError: string | null;
}

export const initialState: State = {
  chain: null,
  sourceLabel: null,
  loading: false,
  loadError: null,
  atmBasis: 'B',
  monthId: null,
  target: 'put',
  filterAsk: false,
  smileAxis: 'k',
  smileViewport: null,
  legs: [],
  nextId: 1,
  legError: null,
};

/** 足の編集（画面の入力を検証済みの値にしたもの）。 */
export interface LegPatch {
  qty?: number;
  entry?: number;
  /** IV（小数）。null で編集を取り消す（板の足だけ。建値から IV を求める） */
  iv?: number | null;
  side?: Side;
}

export type Action =
  | { type: 'loading' }
  | { type: 'loaded'; chain: Chain; label: string }
  | { type: 'loadFailed'; error: LoadErrorView }
  | { type: 'setBasis'; basis: AtmBasis }
  | { type: 'setMonth'; monthId: string }
  | { type: 'setTarget'; target: OptionType }
  | { type: 'setFilterAsk'; on: boolean }
  | { type: 'setAxis'; axis: SmileAxis }
  | { type: 'setViewport'; viewport: Domain | null }
  | { type: 'addBoardLeg'; expiry: string; k: number; optionType: OptionType; side: Side }
  | { type: 'addFutureLeg'; input: FutureLegInput }
  | { type: 'addManualLeg'; input: ManualOptionLegInput }
  | { type: 'editLeg'; id: number; patch: LegPatch }
  | { type: 'removeLeg'; id: number }
  | { type: 'clearLegs' }
  | { type: 'clearLegError' };

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '足を追加できない';
}

function pushLeg(state: State, leg: Omit<UiLeg, 'id'>): State {
  return {
    ...state,
    legs: [...state.legs, { ...leg, id: state.nextId }],
    nextId: state.nextId + 1,
    legError: null,
  };
}

function applyPatch(leg: Leg, patch: LegPatch): Leg {
  const next: Leg = { ...leg };
  if (patch.qty !== undefined) next.qty = patch.qty;
  if (patch.entry !== undefined) next.entry = patch.entry;
  if (patch.side !== undefined) next.side = patch.side;
  if (next.kind === 'option' && patch.iv !== undefined) {
    if (patch.iv === null) delete next.iv;
    else next.iv = patch.iv;
  }
  return next;
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: true };
    case 'loaded': {
      const { chain } = action;
      const keep = state.monthId !== null && chain.months.some((m) => m.id === state.monthId);
      return {
        ...state,
        chain,
        sourceLabel: action.label,
        loading: false,
        loadError: null,
        monthId: keep ? state.monthId : (chain.months[0]?.id ?? null),
        smileViewport: null,
      };
    }
    case 'loadFailed':
      // 前の板は保持する
      return { ...state, loading: false, loadError: action.error };
    case 'setBasis':
      return { ...state, atmBasis: action.basis };
    case 'setMonth':
      return action.monthId === state.monthId
        ? state
        : { ...state, monthId: action.monthId, smileViewport: null };
    case 'setTarget':
      return { ...state, target: action.target };
    case 'setFilterAsk':
      return { ...state, filterAsk: action.on };
    case 'setAxis':
      return action.axis === state.smileAxis
        ? state
        : { ...state, smileAxis: action.axis, smileViewport: null };
    case 'setViewport':
      return { ...state, smileViewport: action.viewport };
    case 'addBoardLeg': {
      if (!state.chain) return state;
      try {
        const built = boardOptionLeg(state.chain, {
          expiry: action.expiry,
          k: action.k,
          type: action.optionType,
          side: action.side,
        });
        return pushLeg(state, { leg: built.leg, marks: built.marks });
      } catch (e) {
        return { ...state, legError: errorText(e) };
      }
    }
    case 'addFutureLeg': {
      if (!state.chain) return state;
      try {
        const built = futureLeg(state.chain, action.input);
        return pushLeg(state, {
          leg: built.leg,
          marks: built.marks,
          futureMarket: { contract: built.leg.contract, market: built.market },
        });
      } catch (e) {
        return { ...state, legError: errorText(e) };
      }
    }
    case 'addManualLeg': {
      try {
        const built = manualOptionLeg(state.chain, action.input);
        const onBoard = !built.marks.includes('no_board');
        const leg: Omit<UiLeg, 'id'> = { leg: built.leg, marks: built.marks };
        if (!onBoard) leg.optionMarket = { expiry: built.leg.expiry, market: built.market };
        return pushLeg(state, leg);
      } catch (e) {
        return { ...state, legError: errorText(e) };
      }
    }
    case 'editLeg':
      return {
        ...state,
        legs: state.legs.map((l) =>
          l.id === action.id ? { ...l, leg: applyPatch(l.leg, action.patch) } : l,
        ),
      };
    case 'removeLeg':
      return { ...state, legs: state.legs.filter((l) => l.id !== action.id) };
    case 'clearLegs':
      return { ...state, legs: [] };
    case 'clearLegError':
      return state.legError === null ? state : { ...state, legError: null };
  }
}

// ---------------------------------------------------------------- 入力の検証

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function num(text: string): number {
  const t = text.trim().replace(/,/g, '');
  return t === '' ? Number.NaN : Number(t);
}

/** 枚数: 1 以上の整数。 */
export function parseQty(text: string): Parsed<number> {
  const v = num(text);
  return Number.isInteger(v) && v >= 1 && v <= 100_000
    ? { ok: true, value: v }
    : { ok: false, message: '枚数は 1 以上の整数' };
}

/** 建値: 0 以上の数（円）。 */
export function parseEntry(text: string): Parsed<number> {
  const v = num(text);
  return Number.isFinite(v) && v >= 0
    ? { ok: true, value: v }
    : { ok: false, message: '建値は 0 以上' };
}

/** IV: % で入力した正の数 → 小数。空欄は null（編集の取り消し）。 */
export function parseIvPct(text: string, allowEmpty: boolean): Parsed<number | null> {
  if (text.trim() === '') {
    return allowEmpty ? { ok: true, value: null } : { ok: false, message: 'IV（%）を入れる' };
  }
  const v = num(text);
  return Number.isFinite(v) && v > 0 && v <= 1000
    ? { ok: true, value: v / 100 }
    : { ok: false, message: 'IV は正の数（%）' };
}

/** 行使価格: 正の整数。 */
export function parseStrike(text: string): Parsed<number> {
  const v = num(text);
  return Number.isInteger(v) && v > 0
    ? { ok: true, value: v }
    : { ok: false, message: '行使価格は正の整数' };
}

/** 限月: YYYY-MM。 */
export function parseContract(text: string): Parsed<string> {
  const t = text.trim();
  const m = /^(\d{4})-(\d{2})$/.exec(t);
  const month = m ? Number(m[2]) : 0;
  return m && month >= 1 && month <= 12
    ? { ok: true, value: t }
    : { ok: false, message: '限月は YYYY-MM' };
}

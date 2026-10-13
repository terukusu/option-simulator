/**
 * 画面の状態と reducer（純関数）。ポジションは画面の状態としてだけ持つ（保存は #8）。
 *
 * 足の追加は data/ の boardOptionLeg / manualOptionLeg / futureLeg を呼ぶだけ。評価（アンカー IV・
 * グリーク・建値ずれ）は表示モデル（view/position.ts）が毎回 model/ の preparePosition から求める。
 */

import {
  boardOptionLeg,
  type Calendar,
  type Chain,
  type FutureLegInput,
  futureLeg,
  type LegMark,
  type ManualOptionLegInput,
  manualOptionLeg,
} from '../data';
import {
  type AtmBasis,
  applyPreset,
  CRASH_PRESETS,
  type FutureMarket,
  type Leg,
  type OptionExpiryMarket,
  type OptionType,
  type Scenario,
  type Side,
  ZERO_SCENARIO,
} from '../model';
import { CALENDAR } from './calendar';
import type { Domain } from './chart/scale';
import { parseNum } from './view/format';
import { DEFAULT_HEDGE, HEDGE_TARGET_MAX, type HedgeSettings, hedgeContracts } from './view/hedge';
import { DEFAULT_PNL_Y, type PnlYSettings } from './view/pnlChart';
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
  /** スマイルで選んだ行使価格（操作行を出す。限月の切替・板の読み直しで消す） */
  smilePick: { monthId: string; k: number } | null;
  /** シナリオ（#6 のシナリオのパネルが編集する。グラフ・指標・テール表が使う） */
  scenario: Scenario;
  /** 手数料（1 枚あたり円、既定 0。全足に掛ける） */
  feePerLot: number;
  /** 指標の金額の単位（自動 = 受取 + 支払が 10 万円以上なら千円） */
  metricsUnit: MetricsUnitSetting;
  /** 損益グラフの横軸の表示範囲（null = 初期範囲。描くときに全域へ収める） */
  pnlViewport: Domain | null;
  /** 損益グラフの縦軸 */
  pnlY: PnlYSettings;
  legs: UiLeg[];
  nextId: number;
  /** 足の追加フォームのエラー（data/ の例外の文言） */
  legError: string | null;
  /** 取引カレンダー（板に無い限月の SQ 日を求める休業日。ui/calendar.ts。テストは差し替える） */
  calendar: Calendar;
  /** デルタヘッジのパネル（目標 Δ・評価点・限月。M12・5.8） */
  hedge: HedgeSettings;
}

export type MetricsUnitSetting = 'auto' | 'yen' | 'thousand';

/** 手数料の上限（1 枚あたり円） */
export const FEE_MAX = 100_000;

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
  smilePick: null,
  scenario: ZERO_SCENARIO,
  feePerLot: 0,
  metricsUnit: 'auto',
  pnlViewport: null,
  pnlY: DEFAULT_PNL_Y,
  legs: [],
  nextId: 1,
  legError: null,
  calendar: CALENDAR,
  hedge: DEFAULT_HEDGE,
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
  | { type: 'pickSmile'; pick: { monthId: string; k: number } | null }
  | { type: 'setDays'; days: number }
  | { type: 'setScenario'; patch: Partial<Scenario> }
  | { type: 'applyPreset'; index: number; x0: number }
  | { type: 'resetScenario' }
  | { type: 'setFee'; fee: number }
  | { type: 'setMetricsUnit'; unit: MetricsUnitSetting }
  | { type: 'setPnlViewport'; viewport: Domain | null }
  | { type: 'setPnlY'; patch: Partial<PnlYSettings> }
  | { type: 'addBoardLeg'; expiry: string; k: number; optionType: OptionType; side: Side }
  | { type: 'addFutureLeg'; input: FutureLegInput }
  | { type: 'addManualLeg'; input: ManualOptionLegInput }
  | { type: 'editLeg'; id: number; patch: LegPatch }
  | { type: 'removeLeg'; id: number }
  | { type: 'clearLegs' }
  | { type: 'clearLegError' }
  | { type: 'setHedge'; patch: Partial<HedgeSettings> };

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

/** シナリオの各値の範囲（設計 5.4。d の上限と ΔX の % 範囲は描く側・パネルが X₀ と足から決める） */
function validScenarioPatch(p: Partial<Scenario>): boolean {
  const fin = (v: number | undefined) => v === undefined || Number.isFinite(v);
  const within = (v: number | undefined, lo: number, hi: number) =>
    v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
  return (
    fin(p.dX) &&
    within(p.days, 0, Number.POSITIVE_INFINITY) &&
    within(p.dSigma, -10, 40) &&
    within(p.skew, -5, 5) &&
    within(p.beta, 0, 10) &&
    (p.ivDynamics === undefined ||
      p.ivDynamics === 'sticky_strike' ||
      p.ivDynamics === 'sticky_moneyness') &&
    (p.ivShift === undefined || p.ivShift === 'absolute' || p.ivShift === 'relative')
  );
}

/** ヘッジの設定の更新の検証（目標は有限かつ |t| ≤ 1,000、評価点は 2 値、限月は null か板の選択肢） */
function validHedgePatch(p: Partial<HedgeSettings>, chain: Chain | null): boolean {
  return (
    (p.target === undefined ||
      (Number.isFinite(p.target) && Math.abs(p.target) <= HEDGE_TARGET_MAX)) &&
    (p.at === undefined || p.at === 'base' || p.at === 'scenario') &&
    (p.contract === undefined ||
      p.contract === null ||
      (chain !== null && hedgeContracts(chain).includes(p.contract)))
  );
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: true };
    case 'loaded': {
      const { chain } = action;
      const keep = state.monthId !== null && chain.months.some((m) => m.id === state.monthId);
      // ヘッジの限月が新しい板の選択肢に無ければ板の先物に戻す
      const { hedge } = state;
      const keepContract =
        hedge.contract === null || hedgeContracts(chain).includes(hedge.contract);
      return {
        ...state,
        chain,
        sourceLabel: action.label,
        loading: false,
        loadError: null,
        monthId: keep ? state.monthId : (chain.months[0]?.id ?? null),
        smileViewport: null,
        smilePick: null,
        pnlViewport: null,
        hedge: keepContract ? hedge : { ...hedge, contract: null },
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
        : { ...state, monthId: action.monthId, smileViewport: null, smilePick: null };
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
    case 'pickSmile':
      return { ...state, smilePick: action.pick };
    case 'setDays':
      return Number.isFinite(action.days) && action.days >= 0
        ? { ...state, scenario: { ...state.scenario, days: action.days } }
        : state;
    case 'setScenario':
      // 非有限・範囲外を含む更新は丸ごと無視する（部分的に反映しない）
      return validScenarioPatch(action.patch)
        ? { ...state, scenario: { ...state.scenario, ...action.patch } }
        : state;
    case 'applyPreset': {
      const preset = CRASH_PRESETS[action.index];
      if (!preset || !(Number.isFinite(action.x0) && action.x0 > 0)) return state;
      return { ...state, scenario: applyPreset(state.scenario, preset, action.x0) };
    }
    case 'resetScenario':
      // d・ΔX・Δσ・Δs を 0 に（β・動き方は設定として保つ）
      return { ...state, scenario: { ...state.scenario, days: 0, dX: 0, dSigma: 0, skew: 0 } };
    case 'setFee':
      return Number.isFinite(action.fee) && action.fee >= 0 && action.fee <= FEE_MAX
        ? { ...state, feePerLot: action.fee }
        : state;
    case 'setMetricsUnit':
      return { ...state, metricsUnit: action.unit };
    case 'setPnlViewport':
      return { ...state, pnlViewport: action.viewport };
    case 'setPnlY':
      return { ...state, pnlY: { ...state.pnlY, ...action.patch } };
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
        const built = futureLeg(state.chain, action.input, state.calendar.holidays);
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
        const built = manualOptionLeg(state.chain, action.input, state.calendar.holidays);
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
    case 'removeLeg': {
      const legs = state.legs.filter((l) => l.id !== action.id);
      // 足が 0 本になったら全クリアと同じく初期範囲に戻す
      return { ...state, legs, pnlViewport: legs.length === 0 ? null : state.pnlViewport };
    }
    case 'clearLegs':
      return { ...state, legs: [], pnlViewport: null };
    case 'clearLegError':
      return state.legError === null ? state : { ...state, legError: null };
    case 'setHedge':
      // 不正な値を含む更新は丸ごと無視する（部分的に反映しない）
      return validHedgePatch(action.patch, state.chain)
        ? { ...state, hedge: { ...state.hedge, ...action.patch } }
        : state;
  }
}

// ---------------------------------------------------------------- 入力の検証

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** 数のパース（`−`・先頭の `+`・桁区切りを受ける。view/format.ts の parseNum） */
const num = parseNum;

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

/** 指定日 d（暦日、小数可）: 0 以上・最遠の足の SQ までの日数以下。 */
export function parseDays(text: string, maxDays: number): Parsed<number> {
  const v = num(text);
  const max = Number.isFinite(maxDays) ? Math.max(maxDays, 0) : 0;
  return Number.isFinite(v) && v >= 0 && v <= max + 1e-9
    ? { ok: true, value: Math.min(v, max) }
    : { ok: false, message: `指定日は 0〜${(Math.floor(max * 100) / 100).toString()} 日` };
}

/** 手数料（1 枚あたり円）: 0〜100,000。 */
export function parseFee(text: string): Parsed<number> {
  const v = num(text);
  return Number.isFinite(v) && v >= 0 && v <= FEE_MAX
    ? { ok: true, value: v }
    : { ok: false, message: '手数料は 0〜100,000 円 / 枚' };
}

/** 目標 Δ（ラージ換算）: −1,000〜1,000。 */
export function parseHedgeTarget(text: string): Parsed<number> {
  const v = num(text);
  return Number.isFinite(v) && Math.abs(v) <= HEDGE_TARGET_MAX
    ? { ok: true, value: v || 0 }
    : { ok: false, message: '目標 Δ は −1,000〜1,000（ラージ換算）' };
}

/** 縦軸の手動の範囲（円）: 両方が数で、下端 < 上端。 */
export function parseYRange(loText: string, hiText: string): Parsed<Domain> {
  const lo = num(loText);
  const hi = num(hiText);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { ok: false, message: '下端・上端は数（円）' };
  }
  return lo < hi ? { ok: true, value: [lo, hi] } : { ok: false, message: '下端 < 上端にする' };
}

/** プレミアム基準の N: 0 < N ≤ 1,000。 */
export function parsePremiumN(text: string): Parsed<number> {
  const v = num(text);
  return Number.isFinite(v) && v > 0 && v <= 1000
    ? { ok: true, value: v }
    : { ok: false, message: 'N は 0 より大きく 1,000 以下' };
}

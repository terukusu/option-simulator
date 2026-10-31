/**
 * 画面の状態と reducer（純関数）。足・シナリオ・設定の localStorage への保存と復元は ui/persist.ts
 * （I/O は App。reducer は I/O を持たない。#23）。
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
  type ModelSettings,
  type OptionExpiryMarket,
  type OptionType,
  type Scenario,
  type Side,
  ZERO_SCENARIO,
} from '../model';
import { CALENDAR } from './calendar';
import type { Domain } from './chart/scale';
import { refreshLegMarkets } from './legMarket';
import { cleanName } from './names';
import {
  addPin,
  DEFAULT_PIN_LINE,
  dropTabPins,
  type Pin,
  type PinLineMode,
  type PinSource,
  removePin,
} from './pins';
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

/**
 * 作業中でないタブの中身（検証済みの position。ui/persist.ts の Workspace['position'] と同じ形。#71）。
 * 足は id を持たない（切り替えて作業中にするときに 1..n を振る）。
 */
export interface TabPosition {
  legs: ReadonlyArray<Omit<UiLeg, 'id'>>;
  /** そのタブのシナリオ（共通のシナリオのときは退避したときの写し。保存形式はタブごとに持つ） */
  scenario: Scenario;
  /** 退避したときの板のスナップショット時刻（epoch ミリ秒。板が無ければ null） */
  boardSnapshotAt: number | null;
}

/** 作業中のポジションのタブ（BOX タブ。#71。設計 6.1・13.4） */
export interface TabSlot {
  /** 画面の key・aria 用（保存しない。開くたびに 1..n） */
  id: number;
  /** 名前（sanitizeTabName 済み。外から来た値でも制御文字・双方向の制御を含まない） */
  name: string;
  /** 作業中のタブは null（中身は State の legs / scenario）、他のタブは退避した position */
  saved: TabPosition | null;
  /**
   * 保有の印（#301。設計 13.4「BOX タブ」）。作業中のタブも退避したタブも slot に持つ（切り替え・退避で保たれる）。
   * true のときだけ持つ（false は持たずキーごと消す）。保存形式は position.held（ui/persist.ts）
   */
  held?: true;
}

/** 作業中のタブの印を held にする（同じなら同じ参照） */
function setActiveHeld(state: State, held: boolean): State {
  const tabs = state.tabs.map((t) => (t.id === state.activeTab ? withHeld(t, held) : t));
  return tabs.every((t, i) => t === state.tabs[i]) ? state : { ...state, tabs };
}

/** 作業中のタブが保有か（#301。印の正は TabSlot.held） */
export function activeHeld(state: State): boolean {
  return state.tabs.some((t) => t.id === state.activeTab && t.held === true);
}

/** slot の印を held にする（false はキーごと消す。同じなら同じ参照） */
function withHeld(slot: TabSlot, held: boolean): TabSlot {
  if (held) return slot.held === true ? slot : { ...slot, held: true };
  if (slot.held === undefined) return slot;
  const { held: _h, ...rest } = slot;
  return rest;
}

export interface LoadErrorView {
  message: string;
  errors: string[];
}

export interface State {
  chain: Chain | null;
  /** 読み込んだ板の名前（fixture 名・ファイル名・API） */
  sourceLabel: string | null;
  /** 板を読み込んだ時刻（ブラウザの時計、epoch ミリ秒。#34。失敗しても前の値を保つ） */
  fetchedAt: number | null;
  /** 表示中の板は localStorage に保存した「最後に取れた板」（読み込みに失敗して代わりに使った。#23） */
  boardStale: boolean;
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
  /** 先物の足の basis: 固定 / 先物の SQ で 0 へ線形に減衰（設計 5.8。全ての先物の足に 1 つ。#25） */
  futureBasis: ModelSettings['futureBasis'];
  /** 指標の金額の単位（自動 = 受取 + 支払が 10 万円以上なら千円） */
  metricsUnit: MetricsUnitSetting;
  /** 損益グラフの横軸の表示範囲（null = 初期範囲。描くときに全域へ収める） */
  pnlViewport: Domain | null;
  /** 損益グラフの縦軸 */
  pnlY: PnlYSettings;
  /** 損益グラフの描画域をたたんでいる（操作行・読み取りの帯は残す。板の読み直し・足のクリアでも保つ。#61） */
  pnlFolded: boolean;
  legs: UiLeg[];
  nextId: number;
  /** 足の追加フォームのエラー（data/ の例外の文言） */
  legError: string | null;
  /**
   * 取引カレンダー（板に無い限月の SQ 日を求める休業日）。初期は同梱の版（ui/calendar.ts）、
   * /api/calendar が届いたら API の版（calendarLoaded）。テストは差し替える
   */
  calendar: Calendar;
  /** デルタヘッジのパネル（目標 Δ・評価点・限月。M12・5.8） */
  hedge: HedgeSettings;
  /**
   * 作業中のポジションのタブ（#71）。作業中のタブの中身は上の legs・nextId・scenario で、他のタブは saved に退避する。
   * 不変条件: activeTab の slot がちょうど 1 つでその saved は null、他は非 null。1 ≤ 個数 ≤ MAX_TABS
   */
  tabs: TabSlot[];
  activeTab: number;
  nextTabId: number;
  /**
   * 損益グラフのピン（#22。ui/pins.ts）。保存しない（再読み込みで消える）。
   * 不変条件: 本数 ≤ MAX_PINS・番号が重複しない・tab の重ねのタブが存在し、同じタブの重ねは 1 本まで
   */
  pins: readonly Pin[];
  /** ピンの線（期中 / 満期。全ピン共通。保存しない） */
  pinLine: PinLineMode;
}

export type MetricsUnitSetting = 'auto' | 'yen' | 'thousand';

/** 手数料の上限（1 枚あたり円） */
export const FEE_MAX = 100_000;

/** タブの個数の上限（オーナー確認の対象。#71） */
export const MAX_TABS = 6;
/** タブの名前の長さの上限（コードポイント数。オーナー確認の対象） */
export const TAB_NAME_MAX = 12;
/**
 * シナリオをタブごとに持つか（#71 D3。オーナー確認の対象）。false = 全タブ共通（作業中のシナリオを全タブに使う）。
 * 保存形式はどちらでもタブごとに `position.scenario` を持つので、ここを変えても版は上げない
 */
export const SCENARIO_PER_TAB: boolean = false;

/** タブの名前の正規化（制御文字・双方向の制御を除き、前後の空白を取り、12 字で切る。空なら空文字）。 */
export function sanitizeTabName(s: string): string {
  return cleanName(s, TAB_NAME_MAX);
}

const TAB_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 新しいタブの既定の名前: A〜Z のうち使われていない最初の 1 文字（全部使われていれば番号）。 */
export function nextTabName(taken: ReadonlyArray<{ name: string }>): string {
  const used = new Set(taken.map((t) => t.name));
  for (const c of TAB_LETTERS) if (!used.has(c)) return c;
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

export const initialState: State = {
  chain: null,
  sourceLabel: null,
  fetchedAt: null,
  boardStale: false,
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
  futureBasis: 'fixed',
  metricsUnit: 'auto',
  pnlViewport: null,
  pnlY: DEFAULT_PNL_Y,
  pnlFolded: false,
  legs: [],
  nextId: 1,
  legError: null,
  calendar: CALENDAR,
  hedge: DEFAULT_HEDGE,
  tabs: [{ id: 1, name: 'A', saved: null }],
  activeTab: 1,
  nextTabId: 2,
  pins: [],
  pinLine: DEFAULT_PIN_LINE,
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
  /** fetchedAt は App が Date.now() を渡す（reducer は時計を読まない。省略時は null） */
  | { type: 'loaded'; chain: Chain; label: string; fetchedAt?: number }
  /**
   * 読み込みの失敗。fallback は保存した最後の板（板が 1 枚も無いときだけ使う。#23）。
   * fetchedAt は保存した板の取得時刻、label はデータ元の表示
   */
  | {
      type: 'loadFailed';
      error: LoadErrorView;
      fallback?: { chain: Chain; label: string; fetchedAt: number };
    }
  /** 取引カレンダー（/api/calendar）が届いた。板と独立（7.5） */
  | { type: 'calendarLoaded'; calendar: Calendar }
  /** 取引カレンダーを読めなかった（何も変えない。同梱か前の API の版のまま） */
  | { type: 'calendarFailed' }
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
  | { type: 'setFutureBasis'; basis: ModelSettings['futureBasis'] }
  | { type: 'setMetricsUnit'; unit: MetricsUnitSetting }
  | { type: 'setPnlViewport'; viewport: Domain | null }
  | { type: 'setPnlY'; patch: Partial<PnlYSettings> }
  | { type: 'setPnlFolded'; folded: boolean }
  | { type: 'addBoardLeg'; expiry: string; k: number; optionType: OptionType; side: Side }
  | { type: 'addFutureLeg'; input: FutureLegInput }
  | { type: 'addManualLeg'; input: ManualOptionLegInput }
  | { type: 'editLeg'; id: number; patch: LegPatch }
  /**
   * 板の OP の足の行使価格を変える（#82。舞台の足マーカーのドラッグ）: 同じ id・枚数・売買・限月・種別のまま、
   * 新しい K の足（legAtStrike = boardOptionLeg）に置き換える。作れなければ何もしない
   */
  | { type: 'changeLegStrike'; id: number; k: number }
  /**
   * 足を戻す（#82 の [元に戻す]。#84 の × / 全クリアにも使う）。作業中のタブが tab で、その id の今の足が expect と
   * 構造的に等しい（expect = null なら id が無い）ときだけ、置き換えるか index に挿入する。それ以外は何もしない
   */
  | { type: 'restoreLeg'; leg: UiLeg; index: number; expect: UiLeg | null; tab: number }
  /**
   * 作業中のタブの足を丸ごと置き換える（#139。AI の提案の [今のタブに適用] とその [元に戻す]）。作業中のタブが tab で、
   * 今の足が expect と構造的に等しい（sameUiLeg・同じ並び）ときだけ。id が重なれば何もしない。nextId は id の最大 + 1 以上
   */
  | { type: 'replaceLegs'; legs: readonly UiLeg[]; expect: readonly UiLeg[]; tab: number }
  | { type: 'removeLeg'; id: number }
  | { type: 'clearLegs' }
  /**
   * 作業中のタブの保有の印を付ける / 外す（#301。タブのメニュー）。足 0 本のタブには付けない（state のまま）。
   * 付けたあと足が 0 本になっても外さない
   */
  | { type: 'setTabHeld'; held: boolean }
  | { type: 'clearLegError' }
  | { type: 'setHedge'; patch: Partial<HedgeSettings> }
  /**
   * ポジ帳の項目を開く（#70）: 足・シナリオ・評価の設定（手数料・先物の basis）を置き換える。表示の設定は今のまま。
   * 値は ui/persist.ts の検証を通ったもの。シナリオ・手数料・basis が null なら今のまま（URL 共有 #72 は足と名前だけ）
   */
  | {
      type: 'openPosition';
      legs: ReadonlyArray<Omit<UiLeg, 'id'>>;
      scenario: Scenario | null;
      feePerLot: number | null;
      futureBasis: ModelSettings['futureBasis'] | null;
      /** 開いたタブの名前（URL 共有 #72。renameTab と同じ規則: 正規化して空・他のタブと同じなら今の名前のまま） */
      name?: string;
      /** 保有の印（#301）。作業中のタブの印をこの値にする（省略 = 印なし） */
      held?: boolean;
    }
  /** 保存一覧の項目・URL 共有を新しいタブで開く（#71・#72。上限なら何もしない。作業中のタブは残す） */
  | {
      type: 'openPositionInNewTab';
      legs: ReadonlyArray<Omit<UiLeg, 'id'>>;
      scenario: Scenario | null;
      feePerLot: number | null;
      futureBasis: ModelSettings['futureBasis'] | null;
      name?: string;
      /** 保有の印（#301）。新しいタブに true のときだけ付ける（作業中だったタブの印は変えない） */
      held?: boolean;
    }
  /** タブを足す（作業中のタブの右隣。empty = 足 0 本、copy = 作業中の足の写し）。上限なら何もしない */
  | { type: 'addTab'; mode: 'empty' | 'copy' }
  /** タブを切り替える（作業中を退避して対象を読み込む。板・表示・横軸の表示範囲は保つ） */
  | { type: 'switchTab'; id: number }
  /** タブを閉じる（最後の 1 個は閉じない。作業中なら右隣・無ければ左隣へ切り替える） */
  | { type: 'closeTab'; id: number }
  /** タブの名前を変える（正規化して空・他のタブと同じ名前なら何もしない） */
  | { type: 'renameTab'; id: number; name: string }
  /**
   * タブの並びを変える（#323。メニューの左へ / 右へ移動・Ctrl / ⌘ + Shift + ← →・ドラッグ）。並びだけを変え、id・名前・
   * saved・held・activeTab・nextTabId・pins は変えない。to は 0..n−1 に収める。今の位置・無い id・非有限の to は
   * state をそのまま返す（参照も同じ）
   */
  | { type: 'moveTab'; id: number; to: number }
  /**
   * 閉じたタブを戻す（#87 (B) のトーストの [元に戻す]。docs/ui-redesign.md §4.5・§10.1）。restoreTabAction が閉じる前の
   * state から作る。上限・名前が空・同じ名前のタブがあれば何もしない。active なら作業中にして横軸の表示範囲を viewport に戻す
   */
  | RestoreTabAction
  /**
   * ピンを足す（#22。source は App が作る: ゴーストは今の基礎・シナリオの参照、重ねはタブの id か保存の足の写し）。
   * 上限・同じタブの重ね・無いタブ・作業中のタブの重ねは何もしない
   */
  | { type: 'addPin'; source: PinSource }
  | { type: 'removePin'; no: number }
  | { type: 'clearPins' }
  | { type: 'setPinLine'; line: PinLineMode };

/**
 * 板の OP の足 ui を行使価格 k に建て直した足（#82。reducer の changeLegStrike と画面のトーストが共有）。
 * 限月・種別・売買・枚数・id は同じ、建値・印・mid は新しい K の boardOptionLeg（売り = bid / 買い = ask、
 * 気配が無ければ既定）、手入力の IV は外れる。OP でない・手入力の限月（optionMarket）・同じ K・板に無い K は null。
 */
export function legAtStrike(chain: Chain | null, ui: UiLeg, k: number): UiLeg | null {
  const leg = ui.leg;
  if (!chain || leg.kind !== 'option' || ui.optionMarket || ui.futureMarket) return null;
  if (!Number.isFinite(k) || k === leg.strike) return null;
  try {
    const built = boardOptionLeg(chain, {
      expiry: leg.expiry,
      k,
      type: leg.type,
      side: leg.side,
      qty: leg.qty,
    });
    return { id: ui.id, leg: built.leg, marks: built.marks };
  } catch {
    return null;
  }
}

const sameRecord = (a: object, b: object): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => {
    const va = (a as Record<string, unknown>)[k];
    const vb = rb[k];
    if (va === vb) return true;
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      return Array.isArray(va) === Array.isArray(vb) && sameRecord(va, vb);
    }
    return Number.isNaN(va) && Number.isNaN(vb);
  });
};

/** 足の構造の比較（id・足の全キーと値・印の並び・手入力の市場の有無と中身）。 */
export function sameUiLeg(a: UiLeg, b: UiLeg): boolean {
  return a === b || sameRecord(a, b);
}

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
export function validScenarioPatch(p: Partial<Scenario>): boolean {
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
    // IV の入れ方は absolute だけ（relative を選ぶ部品は無い = 後段。プリセット・AI の文脈の iv_shift_pt は pt の前提。
    // relative は追証マップの model の中だけで使う。#260）
    (p.ivShift === undefined || p.ivShift === 'absolute')
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

const validFee = (v: number) => Number.isFinite(v) && v >= 0 && v <= FEE_MAX;

/**
 * position（id の無い足とシナリオ）を作業中の足に読み込む（openPosition・switchTab・閉じたあとの切り替えが共有）。
 * 足の id は 1..n に振り直す（restoreState と同じ）。板があれば足の市場を今の板から作り直す（loaded と同じ規則。
 * 板の足で限月が板に無ければ行のエラーで残る）。scenario が null なら今のシナリオのまま
 */
function loadLegs(
  state: State,
  src: ReadonlyArray<Omit<UiLeg, 'id'>>,
  scenario: Scenario | null,
): State {
  const legs: UiLeg[] = src.map((l, i) => ({ ...l, id: i + 1 }));
  return {
    ...state,
    legs: state.chain ? refreshLegMarkets(state.chain, legs, state.calendar.holidays) : legs,
    nextId: legs.length + 1,
    scenario: scenario !== null && validScenarioPatch(scenario) ? scenario : state.scenario,
    smilePick: null,
    legError: null,
  };
}

/** 作業中のタブの中身を退避の形にする（足の写し。id を除く）。 */
export function stashActive(state: State): TabPosition {
  return {
    legs: state.legs.map(({ id: _id, ...rest }) => rest),
    scenario: state.scenario,
    boardSnapshotAt: state.chain ? state.chain.snapshotAt : null,
  };
}

/** 作業中のタブを id のタブに切り替える（同じ id・無い id は state のまま）。 */
function switchTo(state: State, id: number): State {
  if (id === state.activeTab) return state;
  const target = state.tabs.find((t) => t.id === id);
  if (!target?.saved) return state;
  const stash = stashActive(state);
  const tabs = state.tabs.map((t) =>
    t.id === state.activeTab ? { ...t, saved: stash } : t.id === id ? { ...t, saved: null } : t,
  );
  const loaded = loadLegs(
    state,
    target.saved.legs,
    SCENARIO_PER_TAB ? target.saved.scenario : null,
  );
  return {
    ...loaded,
    tabs,
    activeTab: id,
    // 横軸の表示範囲は保つ（同じ範囲で見比べる。オーナー確認の対象）。足 0 本のタブなら初期範囲（removeLeg と同じ）
    pnlViewport: loaded.legs.length === 0 ? null : state.pnlViewport,
  };
}

/** 作業中のタブの右隣に新しいタブを作って切り替える（上限なら null）。 */
function addTabWith(
  state: State,
  legs: ReadonlyArray<Omit<UiLeg, 'id'>>,
  scenario: Scenario | null,
  held = false,
): State | null {
  if (state.tabs.length >= MAX_TABS) return null;
  const stash = stashActive(state);
  const id = state.nextTabId;
  const slot: TabSlot = withHeld({ id, name: nextTabName(state.tabs), saved: null }, held);
  const at = state.tabs.findIndex((t) => t.id === state.activeTab);
  const tabs = state.tabs.map((t) => (t.id === state.activeTab ? { ...t, saved: stash } : t));
  tabs.splice(at + 1, 0, slot);
  return { ...loadLegs(state, legs, scenario), tabs, activeTab: id, nextTabId: id + 1 };
}

/** タブの名前を変える（正規化して空・同じ・他のタブと同じ名前なら state のまま）。 */
function renameTab(state: State, id: number, raw: string): State {
  const name = sanitizeTabName(raw);
  const cur = state.tabs.find((t) => t.id === id);
  if (!cur || name === '' || name === cur.name) return state;
  // 他のタブと同じ名前にはしない（読み取り readWorkspace は重複を別の文字に変えるので、ここで作らない）
  if (state.tabs.some((t) => t.id !== id && t.name === name)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? { ...t, name } : t)) };
}

const renameActive = (state: State, raw: string): State => renameTab(state, state.activeTab, raw);

/** タブを to の位置へ動かす（#323。to は 0..n−1 に収める。今の位置・無い id・非有限の to は state のまま）。 */
function moveTab(state: State, id: number, rawTo: number): State {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0 || !Number.isFinite(rawTo)) return state;
  const to = Math.min(Math.max(rawTo, 0), state.tabs.length - 1);
  if (to === i) return state;
  const tabs = state.tabs.slice();
  const [slot] = tabs.splice(i, 1);
  if (!slot) return state;
  tabs.splice(to, 0, slot);
  return { ...state, tabs };
}

/** 閉じたタブを戻す action（#87 (B)）。index は閉じる前の並びの位置、viewport は閉じる前の横軸の表示範囲 */
export interface RestoreTabAction {
  type: 'restoreTab';
  name: string;
  position: TabPosition;
  index: number;
  active: boolean;
  viewport: Domain | null;
  /** 閉じる前のタブの保有の印（#301。戻したタブに付ける） */
  held?: true;
}

/**
 * タブ id を閉じる前の写し（closeTab の前に呼ぶ。#87 (B)）。無い id・最後の 1 個（closeTab が何もしない）は null。
 * 作業中のタブは stashActive、他は退避した saved（同じ参照）
 */
export function restoreTabAction(state: State, id: number): RestoreTabAction | null {
  const index = state.tabs.findIndex((t) => t.id === id);
  const slot = state.tabs[index];
  if (!slot || state.tabs.length <= 1) return null;
  const active = id === state.activeTab;
  const position = active ? stashActive(state) : slot.saved;
  if (!position) return null;
  return {
    type: 'restoreTab',
    name: slot.name,
    position,
    index,
    active,
    viewport: state.pnlViewport,
    ...(slot.held === true ? { held: true as const } : {}),
  };
}

/** restoreTab の本体（戻せなければ state のまま。規則は ui/view/boxTabs.ts の restoreTabError と同じ） */
function restoreTab(state: State, a: RestoreTabAction): State {
  const name = sanitizeTabName(a.name);
  if (state.tabs.length >= MAX_TABS || name === '') return state;
  if (state.tabs.some((t) => t.name === name)) return state;
  const at = Math.min(Math.max(Math.trunc(a.index) || 0, 0), state.tabs.length);
  const id = state.nextTabId;
  if (!a.active) {
    const tabs = state.tabs.slice();
    tabs.splice(at, 0, withHeld({ id, name, saved: a.position }, a.held === true));
    return { ...state, tabs, nextTabId: id + 1 };
  }
  const stash = stashActive(state);
  const tabs: TabSlot[] = state.tabs.map((t) =>
    t.id === state.activeTab ? { ...t, saved: stash } : t,
  );
  tabs.splice(at, 0, withHeld({ id, name, saved: null }, a.held === true));
  const loaded = loadLegs(state, a.position.legs, SCENARIO_PER_TAB ? a.position.scenario : null);
  return {
    ...loaded,
    tabs,
    activeTab: id,
    nextTabId: id + 1,
    // switchTo と同じ規則（足 0 本なら初期範囲）。違いは表示範囲を閉じる前の値に戻すこと
    pnlViewport: loaded.legs.length === 0 ? null : a.viewport,
  };
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
        fetchedAt: action.fetchedAt ?? null,
        boardStale: false,
        // 足の市場（手入力の足の SQ・F、先物の足の SQ・価格）と市場の印は今の板から作り直す。
        // 建値・枚数・売買・IV の編集は変えない（足を追加したときと同じ規則。#23）
        legs: refreshLegMarkets(chain, state.legs, state.calendar.holidays),
        loading: false,
        loadError: null,
        monthId: keep ? state.monthId : (chain.months[0]?.id ?? null),
        smileViewport: null,
        smilePick: null,
        pnlViewport: null,
        hedge: keepContract ? hedge : { ...hedge, contract: null },
      };
    }
    case 'loadFailed': {
      // 板が 1 枚も無ければ保存した最後の板を「古い板」として使う（#23）。エラーは出したまま
      const { fallback } = action;
      if (state.chain === null && fallback) {
        const s = reduce(state, {
          type: 'loaded',
          chain: fallback.chain,
          label: fallback.label,
          fetchedAt: fallback.fetchedAt,
        });
        return { ...s, loadError: action.error, boardStale: true };
      }
      // 前の板・取得時刻・データ元・古い板の印は保持する
      return { ...state, loading: false, loadError: action.error };
    }
    case 'calendarLoaded': {
      const { calendar } = action;
      // 壊れた版で今の版を上書きしない。同じ API の版（304 の再検証）なら描き直さない
      if (!calendar.ok) return state;
      if (
        state.calendar.origin === 'api' &&
        calendar.origin === 'api' &&
        state.calendar.versionAt === calendar.versionAt
      ) {
        return state;
      }
      return {
        ...state,
        calendar,
        // 足の市場（手入力の足・限月違いの先物の足の SQ）を新しい休業日で作り直す。編集は変えない
        legs: state.chain
          ? refreshLegMarkets(state.chain, state.legs, calendar.holidays)
          : state.legs,
      };
    }
    case 'calendarFailed':
      return state;
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
      return validFee(action.fee) ? { ...state, feePerLot: action.fee } : state;
    case 'setFutureBasis':
      return (action.basis === 'fixed' || action.basis === 'decay') &&
        action.basis !== state.futureBasis
        ? { ...state, futureBasis: action.basis }
        : state;
    case 'setMetricsUnit':
      return { ...state, metricsUnit: action.unit };
    case 'setPnlViewport':
      return { ...state, pnlViewport: action.viewport };
    case 'setPnlY':
      return { ...state, pnlY: { ...state.pnlY, ...action.patch } };
    case 'setPnlFolded':
      return action.folded === state.pnlFolded ? state : { ...state, pnlFolded: action.folded };
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
    case 'changeLegStrike': {
      // 保有のタブの足の K は変えない（#301。画面は足マーカーをつかませない。reducer でも守る）
      if (activeHeld(state)) return state;
      const i = state.legs.findIndex((l) => l.id === action.id);
      const cur = state.legs[i];
      const next = cur ? legAtStrike(state.chain, cur, action.k) : null;
      if (!next) return state;
      const legs = state.legs.slice();
      legs[i] = next;
      return { ...state, legs };
    }
    case 'restoreLeg': {
      if (state.activeTab !== action.tab) return state;
      const { leg, expect } = action;
      const i = state.legs.findIndex((l) => l.id === leg.id);
      if (expect === null) {
        if (i >= 0) return state;
        const at = Math.min(Math.max(Math.trunc(action.index) || 0, 0), state.legs.length);
        const legs = state.legs.slice();
        legs.splice(at, 0, leg);
        return { ...state, legs, nextId: Math.max(state.nextId, leg.id + 1) };
      }
      const cur = state.legs[i];
      if (!cur || !sameUiLeg(cur, expect)) return state;
      const legs = state.legs.slice();
      legs[i] = leg;
      return { ...state, legs };
    }
    case 'replaceLegs': {
      if (state.activeTab !== action.tab) return state;
      const { expect } = action;
      if (
        state.legs.length !== expect.length ||
        state.legs.some((l, i) => !sameUiLeg(l, expect[i] as UiLeg))
      ) {
        return state;
      }
      const legs = action.legs.slice();
      if (new Set(legs.map((l) => l.id)).size !== legs.length) return state;
      const maxId = legs.reduce((n, l) => Math.max(n, l.id), 0);
      return {
        ...state,
        legs,
        nextId: Math.max(state.nextId, maxId + 1),
        legError: null,
        pnlViewport: legs.length === 0 ? null : state.pnlViewport,
      };
    }
    case 'removeLeg': {
      const legs = state.legs.filter((l) => l.id !== action.id);
      // 足が 0 本になったら全クリアと同じく初期範囲に戻す
      return { ...state, legs, pnlViewport: legs.length === 0 ? null : state.pnlViewport };
    }
    case 'clearLegs':
      // 保有のタブは全クリアしない（#301。画面は押せない。reducer でも守る）
      if (activeHeld(state)) return state;
      return { ...state, legs: [], pnlViewport: null };
    case 'setTabHeld': {
      if (action.held && state.legs.length === 0) return state;
      return setActiveHeld(state, action.held);
    }
    case 'clearLegError':
      return state.legError === null ? state : { ...state, legError: null };
    case 'openPosition':
    case 'openPositionInNewTab': {
      // 作業中のタブを置き換える（openPosition）か、新しいタブを足して読み込む（#71。上限なら何もしない）
      const { feePerLot, futureBasis } = action;
      const next =
        action.type === 'openPosition'
          ? setActiveHeld(loadLegs(state, action.legs, action.scenario), action.held === true)
          : addTabWith(state, action.legs, action.scenario, action.held === true);
      if (next === null) return state;
      const named = action.name === undefined ? next : renameActive(next, action.name);
      return {
        ...named,
        feePerLot: feePerLot !== null && validFee(feePerLot) ? feePerLot : state.feePerLot,
        futureBasis:
          futureBasis === 'fixed' || futureBasis === 'decay' ? futureBasis : state.futureBasis,
        pnlViewport: null,
      };
    }
    case 'addTab': {
      // 複製は作業中の足の写し（足は reducer が置き換えで更新するので共有しても書き換わらないが、写しで持つ）
      const legs = action.mode === 'copy' ? stashActive(state).legs : [];
      const next = addTabWith(state, legs, null);
      if (next === null) return state;
      return { ...next, pnlViewport: legs.length === 0 ? null : state.pnlViewport };
    }
    case 'switchTab':
      return switchTo(state, action.id);
    case 'closeTab': {
      const i = state.tabs.findIndex((t) => t.id === action.id);
      if (i < 0 || state.tabs.length <= 1) return state;
      let s = state;
      if (action.id === state.activeTab) {
        const neighbor = state.tabs[i + 1] ?? state.tabs[i - 1];
        if (!neighbor) return state;
        s = switchTo(state, neighbor.id);
      }
      // 閉じたタブを重ねたピンも外す（#22）
      return {
        ...s,
        tabs: s.tabs.filter((t) => t.id !== action.id),
        pins: dropTabPins(s.pins, action.id),
      };
    }
    case 'renameTab':
      return renameTab(state, action.id, action.name);
    case 'moveTab':
      return moveTab(state, action.id, action.to);
    case 'restoreTab':
      return restoreTab(state, action);
    case 'addPin': {
      const pins = addPin(
        state.pins,
        action.source,
        state.tabs.map((t) => t.id),
        state.activeTab,
      );
      return pins === state.pins ? state : { ...state, pins };
    }
    case 'removePin': {
      const pins = removePin(state.pins, action.no);
      return pins === state.pins ? state : { ...state, pins };
    }
    case 'clearPins':
      return state.pins.length === 0 ? state : { ...state, pins: [] };
    case 'setPinLine':
      return (action.line === 'period' || action.line === 'expiry') && action.line !== state.pinLine
        ? { ...state, pinLine: action.line }
        : state;
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

/** 枚数の上限 */
export const QTY_MAX = 100_000;

/** 枚数として正しい数か（1〜100,000 の整数。parseQty と保存の検証が使う）。 */
export function validQty(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= QTY_MAX;
}

/** IV（小数）として正しい数か（0 < iv ≤ 10 = 1,000%。parseIvPct と保存の検証が使う）。 */
export function validIv(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 10;
}

/** 限月の ID（YYYY-MM、月 1〜12）か。 */
export function isContractId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  const month = m ? Number(m[2]) : 0;
  return month >= 1 && month <= 12;
}

/** 枚数: 1 以上の整数。 */
export function parseQty(text: string): Parsed<number> {
  const v = num(text);
  return validQty(v) ? { ok: true, value: v } : { ok: false, message: '枚数は 1 以上の整数' };
}

/** 建値の上限（円。保存の検証と揃える） */
export const ENTRY_MAX = 1e9;

/** 建値として正しい数か（0〜1e9。parseEntry と保存の検証が使う）。 */
export function validEntry(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= ENTRY_MAX;
}

/** 建値: 0 以上 1e9 以下の数（円）。 */
export function parseEntry(text: string): Parsed<number> {
  const v = num(text);
  return validEntry(v)
    ? { ok: true, value: v }
    : { ok: false, message: '建値は 0 以上 1,000,000,000 以下' };
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
  return isContractId(t) ? { ok: true, value: t } : { ok: false, message: '限月は YYYY-MM' };
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

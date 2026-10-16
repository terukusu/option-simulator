/**
 * 作業中の状態の保存形式・検証・読み替え・復元と、最後に取れた板の保存形式（純関数）。設計 docs/design.md M8・13.4（#23）。
 *
 * - 保存は端末ごと（localStorage）。I/O は ui/storage.ts、いつ書くかは App
 * - 形式は版つき（`schema_version`）。古い版は MIGRATIONS で順に読み替え、新しい版は読まない（上書きもしない）
 * - 外から来た値として扱う: JSON.parse → 既知のキーだけで新しいオブジェクトを組み立てる（余計なキー・`__proto__` は写さない）
 *   → 範囲を検証。足・シナリオ（position）は 1 つでも不正なら position ごと捨てる（足が 1 本だけ消えて損益の形が
 *   黙って変わるのを防ぐ）。表示の設定（ui）は項目ごとに既定へ戻す
 * - 足は `Leg`（評価前の入力。建値・枚数・売買・IV の編集・mid）をそのまま持つ。足を作り直さない（建値が今の気配に変わるため）。
 *   足の市場は保存するが、板を読んだら今の板から作り直す（ui/legMarket.ts）
 *
 * #70（ポジ帳）・#71（BOX タブ）・#72（URL 共有）は `position`（足 + シナリオ + 板の時刻）を 1 単位として使う。
 * 項目を足すときは版を上げ、MIGRATIONS に読み替えを足し、tests/ui/saved/ の古い版の fixture は変えない。
 */

import {
  type Chain,
  type ChainJson,
  DEFAULT_RATE,
  type LegMark,
  normalizeChain,
  validateChainJson,
} from '../data';
import type {
  AtmBasis,
  FutureLeg,
  FutureProduct,
  IvDynamics,
  IvShiftMode,
  Leg,
  OptionLeg,
  OptionType,
  Scenario,
  Side,
} from '../model';
import type { Domain } from './chart/scale';
import {
  FEE_MAX,
  initialState,
  isContractId,
  type MetricsUnitSetting,
  type State,
  type UiLeg,
  validEntry,
  validIv,
  validQty,
  validScenarioPatch,
} from './state';
import { HEDGE_TARGET_MAX, type HedgeAt, type HedgeSettings } from './view/hedge';
import type { PnlYMode, PnlYSettings } from './view/pnlChart';
import type { SmileAxis } from './view/smile';

/** 作業の保存のキー（origin ごと） */
export const WORKSPACE_KEY = 'option-simulator.workspace';
/** 最後に取れた板のキー */
export const BOARD_KEY = 'option-simulator.lastBoard';

export const WORKSPACE_SCHEMA_VERSION = 1;
export const BOARD_SCHEMA_VERSION = 1;

/** 保存する足の本数の上限（壊れた・巨大な値で固まらない） */
export const MAX_SAVED_LEGS = 200;
/** ΔX の絶対値の上限（円） */
const DX_MAX = 1e6;
/** 保存した板のデータ元の名前の長さの上限 */
const LABEL_MAX = 64;

// ---------------------------------------------------------------- 保存形式（版 1）

export interface SavedOptionLegV1 {
  kind: 'option';
  product: 'op_large';
  type: OptionType;
  expiry: string;
  strike: number;
  side: Side;
  qty: number;
  entry: number;
  iv?: number;
  mid?: number | null;
}

export interface SavedFutureLegV1 {
  kind: 'future';
  product: FutureProduct;
  contract: string;
  side: Side;
  qty: number;
  entry: number;
}

export interface SavedLegV1 {
  leg: SavedOptionLegV1 | SavedFutureLegV1;
  marks: LegMark[];
  /** 手入力の OP の足（板に無い限月）の市場。forward は NaN を null で持つ */
  option_market?: { sq_time: number; forward: number | null };
  /** 先物の足の市場 */
  future_market?: { sq_time: number; price: number };
}

export interface SavedPositionV1 {
  /** 保存したときの板のスナップショット時刻（板の JSON の snapshot_at。板が無ければ null） */
  board_snapshot_at: string | null;
  legs: SavedLegV1[];
  scenario: Scenario;
}

export interface SavedUiV1 {
  atm_basis: AtmBasis;
  month_id: string | null;
  target: OptionType;
  filter_ask: boolean;
  smile_axis: SmileAxis;
  fee_per_lot: number;
  future_basis: 'fixed' | 'decay';
  metrics_unit: MetricsUnitSetting;
  pnl_y: { mode: PnlYMode; manual: [number, number] | null; n: number };
  pnl_folded: boolean;
  hedge: { target: number; at: HedgeAt; contract: string | null };
}

export interface SavedWorkspaceV1 {
  schema_version: 1;
  /** 保存した時刻（ISO 8601） */
  saved_at: string;
  position: SavedPositionV1;
  ui: SavedUiV1;
}

// ---------------------------------------------------------------- 書き出し

function savedLeg(leg: Leg): SavedOptionLegV1 | SavedFutureLegV1 {
  if (leg.kind === 'future') {
    const { product, contract, side, qty, entry } = leg;
    return { kind: 'future', product, contract, side, qty, entry };
  }
  const out: SavedOptionLegV1 = {
    kind: 'option',
    product: leg.product,
    type: leg.type,
    expiry: leg.expiry,
    strike: leg.strike,
    side: leg.side,
    qty: leg.qty,
    entry: leg.entry,
  };
  if (leg.iv !== undefined) out.iv = leg.iv;
  if (leg.mid !== undefined) out.mid = leg.mid;
  return out;
}

const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

function toSavedLeg(ui: UiLeg): SavedLegV1 {
  const out: SavedLegV1 = { leg: savedLeg(ui.leg), marks: [...ui.marks] };
  if (ui.optionMarket) {
    const m = ui.optionMarket.market;
    out.option_market = { sq_time: m.sqTime, forward: finiteOrNull(m.forward) };
  }
  if (ui.futureMarket) {
    const m = ui.futureMarket.market;
    out.future_market = { sq_time: m.sqTime, price: m.price };
  }
  return out;
}

/** 保存の中身のうち、変わったら書く部分（保存の時刻・板の時刻を除く）。 */
function body(state: State): { legs: SavedLegV1[]; scenario: Scenario; ui: SavedUiV1 } {
  const { scenario, pnlY, hedge } = state;
  return {
    legs: state.legs.map(toSavedLeg),
    scenario: {
      days: scenario.days,
      dX: scenario.dX,
      dSigma: scenario.dSigma,
      skew: scenario.skew,
      beta: scenario.beta,
      ivDynamics: scenario.ivDynamics,
      ivShift: scenario.ivShift,
    },
    ui: {
      atm_basis: state.atmBasis,
      month_id: state.monthId,
      target: state.target,
      filter_ask: state.filterAsk,
      smile_axis: state.smileAxis,
      fee_per_lot: state.feePerLot,
      future_basis: state.futureBasis,
      metrics_unit: state.metricsUnit,
      pnl_y: {
        mode: pnlY.mode,
        manual: pnlY.manual ? [pnlY.manual[0], pnlY.manual[1]] : null,
        n: pnlY.n,
      },
      pnl_folded: state.pnlFolded,
      hedge: { target: hedge.target, at: hedge.at, contract: hedge.contract },
    },
  };
}

/**
 * 変更の判定に使う文字列（同じなら書かない。開いているだけのタブが他のタブの保存を上書きしないため）。
 * 保存の時刻・板の時刻と、板を読むたびに今の板から作り直す足の市場・市場の印は含めない
 * （利用者が変えたものだけ: 足の入力値・シナリオ・設定）。
 */
export function persistKey(state: State): string {
  const b = body(state);
  return JSON.stringify({ legs: b.legs.map((l) => l.leg), scenario: b.scenario, ui: b.ui });
}

export function toSaved(state: State, now: number): SavedWorkspaceV1 {
  const b = body(state);
  return {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    saved_at: new Date(now).toISOString(),
    position: {
      board_snapshot_at: state.chain ? state.chain.snapshotAtText : null,
      legs: b.legs,
      scenario: b.scenario,
    },
    ui: b.ui,
  };
}

export function serializeWorkspace(state: State, now: number): string {
  return JSON.stringify(toSaved(state, now));
}

// ---------------------------------------------------------------- 読み取り・検証

/** 検証済みの作業（State に入れる形）。 */
export interface UiPrefs {
  atmBasis: AtmBasis;
  monthId: string | null;
  target: OptionType;
  filterAsk: boolean;
  smileAxis: SmileAxis;
  feePerLot: number;
  futureBasis: 'fixed' | 'decay';
  metricsUnit: MetricsUnitSetting;
  pnlY: PnlYSettings;
  pnlFolded: boolean;
  hedge: HedgeSettings;
}

export interface Workspace {
  /** 保存した時刻（読めなければ null） */
  savedAt: number | null;
  /** 足・シナリオ（不正なら null = 捨てた） */
  position: {
    boardSnapshotAt: number | null;
    legs: Array<Omit<UiLeg, 'id'>>;
    scenario: Scenario;
  } | null;
  ui: UiPrefs;
}

export type ReadResult =
  /** 保存が無い */
  | { kind: 'empty' }
  /** 読めない（JSON でない・版が無い / 知らない古い版）。次の変更で上書きしてよい */
  | { kind: 'invalid' }
  /** 新しい版で保存された（読まない・上書きしない） */
  | { kind: 'newer'; version: number }
  /** 読めた。dropped = 足・シナリオを捨てた */
  | { kind: 'ok'; saved: Workspace; dropped: boolean };

type Obj = Record<string, unknown>;

/** 普通のオブジェクト（配列・null でない）か。 */
function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 自分のキーの値だけ読む（`__proto__` などの継承した値を読まない）。 */
function own(o: Obj, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function oneOf<T extends string>(v: unknown, values: readonly T[]): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const SIDES: readonly Side[] = ['buy', 'sell'];
const OPTION_TYPES: readonly OptionType[] = ['put', 'call'];
const FUTURE_PRODUCTS: readonly FutureProduct[] = ['fut_large', 'fut_mini', 'fut_micro'];
/** 既知の印（Record で LegMark の追加漏れを型で防ぐ） */
const KNOWN_MARKS: Record<LegMark, true> = {
  no_board: true,
  no_quote: true,
  unstable_iv: true,
  extrapolated: true,
  interpolated: true,
  forward_from_future: true,
  future_manual: true,
  no_price: true,
};

function readMarks(v: unknown): LegMark[] | null {
  if (!Array.isArray(v)) return null;
  const out: LegMark[] = [];
  for (const m of v) {
    // 未知の印は捨てる（表示用。足は捨てない）
    if (typeof m === 'string' && Object.hasOwn(KNOWN_MARKS, m) && !out.includes(m as LegMark)) {
      out.push(m as LegMark);
    }
  }
  return out;
}

const validSqTime = (v: unknown): v is number => isFiniteNum(v) && Number.isInteger(v);

function readOptionLeg(o: Obj): OptionLeg | null {
  const type = own(o, 'type');
  const expiry = own(o, 'expiry');
  const strike = own(o, 'strike');
  const side = own(o, 'side');
  const qty = own(o, 'qty');
  const entry = own(o, 'entry');
  const iv = own(o, 'iv');
  const mid = own(o, 'mid');
  if (
    own(o, 'product') !== 'op_large' ||
    !oneOf(type, OPTION_TYPES) ||
    !isContractId(expiry) ||
    !(typeof strike === 'number' && Number.isInteger(strike) && strike > 0) ||
    !oneOf(side, SIDES) ||
    !validQty(qty) ||
    !validEntry(entry) ||
    !(iv === undefined || validIv(iv)) ||
    !(mid === undefined || mid === null || validEntry(mid))
  ) {
    return null;
  }
  const leg: OptionLeg = {
    kind: 'option',
    product: 'op_large',
    type,
    expiry,
    strike,
    side,
    qty,
    entry,
  };
  if (iv !== undefined) leg.iv = iv;
  if (mid !== undefined) leg.mid = mid;
  return leg;
}

function readFutureLeg(o: Obj): FutureLeg | null {
  const product = own(o, 'product');
  const contract = own(o, 'contract');
  const side = own(o, 'side');
  const qty = own(o, 'qty');
  const entry = own(o, 'entry');
  if (
    !oneOf(product, FUTURE_PRODUCTS) ||
    !isContractId(contract) ||
    !oneOf(side, SIDES) ||
    !validQty(qty) ||
    !validEntry(entry)
  ) {
    return null;
  }
  return { kind: 'future', product, contract, side, qty, entry };
}

function readLeg(v: unknown): Omit<UiLeg, 'id'> | null {
  if (!isObj(v)) return null;
  const rawLeg = own(v, 'leg');
  const marks = readMarks(own(v, 'marks'));
  if (!isObj(rawLeg) || !marks) return null;
  const om = own(v, 'option_market');
  const fm = own(v, 'future_market');
  const kind = own(rawLeg, 'kind');
  if (kind === 'option') {
    const leg = readOptionLeg(rawLeg);
    if (!leg || fm !== undefined) return null;
    const out: Omit<UiLeg, 'id'> = { leg, marks };
    // 「板なし（手入力）」の足は足の市場が必須（無ければ評価できない）。限月が板に入った手入力の足も
    // 足の市場を持ち続ける（ui/legMarket.ts）ので、印が無くても持ってよい
    if (marks.includes('no_board') && om === undefined) return null;
    if (om !== undefined) {
      if (!isObj(om)) return null;
      const sq = own(om, 'sq_time');
      const f = own(om, 'forward');
      if (!validSqTime(sq) || !(f === null || (isFiniteNum(f) && f > 0))) return null;
      out.optionMarket = {
        expiry: leg.expiry,
        market: { sqTime: sq, forward: f ?? Number.NaN, smile: null },
      };
    }
    return out;
  }
  if (kind === 'future') {
    const leg = readFutureLeg(rawLeg);
    if (!leg || om !== undefined || !isObj(fm)) return null;
    const sq = own(fm, 'sq_time');
    const price = own(fm, 'price');
    if (!validSqTime(sq) || !validEntry(price)) return null;
    return { leg, marks, futureMarket: { contract: leg.contract, market: { sqTime: sq, price } } };
  }
  return null;
}

function readScenario(v: unknown): Scenario | null {
  if (!isObj(v)) return null;
  const s = {
    days: own(v, 'days'),
    dX: own(v, 'dX'),
    dSigma: own(v, 'dSigma'),
    skew: own(v, 'skew'),
    beta: own(v, 'beta'),
    ivDynamics: own(v, 'ivDynamics'),
    ivShift: own(v, 'ivShift'),
  };
  if (
    !isFiniteNum(s.days) ||
    !isFiniteNum(s.dX) ||
    Math.abs(s.dX) > DX_MAX ||
    !isFiniteNum(s.dSigma) ||
    !isFiniteNum(s.skew) ||
    !isFiniteNum(s.beta) ||
    !oneOf<IvDynamics>(s.ivDynamics, ['sticky_strike', 'sticky_moneyness']) ||
    !oneOf<IvShiftMode>(s.ivShift, ['absolute', 'relative'])
  ) {
    return null;
  }
  const scenario: Scenario = {
    days: s.days,
    dX: s.dX,
    dSigma: s.dSigma,
    skew: s.skew,
    beta: s.beta,
    ivDynamics: s.ivDynamics,
    ivShift: s.ivShift,
  };
  return validScenarioPatch(scenario) ? scenario : null;
}

/** ISO 8601 の時刻 → epoch ミリ秒（読めなければ null）。 */
function readTime(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function readPosition(v: unknown): Workspace['position'] {
  if (!isObj(v)) return null;
  const rawLegs = own(v, 'legs');
  if (!Array.isArray(rawLegs) || rawLegs.length > MAX_SAVED_LEGS) return null;
  const legs: Array<Omit<UiLeg, 'id'>> = [];
  for (const raw of rawLegs) {
    const leg = readLeg(raw);
    if (!leg) return null;
    legs.push(leg);
  }
  const scenario = readScenario(own(v, 'scenario'));
  if (!scenario) return null;
  const snap = own(v, 'board_snapshot_at');
  return { boardSnapshotAt: readTime(snap), legs, scenario };
}

function readPnlY(v: unknown): PnlYSettings {
  const d = initialState.pnlY;
  if (!isObj(v)) return d;
  const mode = own(v, 'mode');
  const manual = own(v, 'manual');
  const n = own(v, 'n');
  let m: Domain | null = d.manual;
  if (manual === null) m = null;
  else if (
    Array.isArray(manual) &&
    manual.length === 2 &&
    isFiniteNum(manual[0]) &&
    isFiniteNum(manual[1]) &&
    manual[0] < manual[1]
  ) {
    m = [manual[0], manual[1]];
  }
  return {
    mode: oneOf<PnlYMode>(mode, ['auto', 'manual', 'premium']) ? mode : d.mode,
    manual: m,
    n: isFiniteNum(n) && n > 0 && n <= 1000 ? n : d.n,
  };
}

function readHedge(v: unknown): HedgeSettings {
  const d = initialState.hedge;
  if (!isObj(v)) return d;
  const target = own(v, 'target');
  const at = own(v, 'at');
  const contract = own(v, 'contract');
  return {
    target: isFiniteNum(target) && Math.abs(target) <= HEDGE_TARGET_MAX ? target : d.target,
    at: oneOf<HedgeAt>(at, ['base', 'scenario']) ? at : d.at,
    contract: contract === null || isContractId(contract) ? contract : d.contract,
  };
}

/** 表示の設定（項目ごとに不正なら既定）。 */
function readUi(v: unknown): UiPrefs {
  const d = initialState;
  const o: Obj = isObj(v) ? v : {};
  const pick = <T>(key: string, ok: (x: unknown) => x is T, fallback: T): T => {
    const x = own(o, key);
    return ok(x) ? x : fallback;
  };
  const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
  const monthId = own(o, 'month_id');
  const fee = own(o, 'fee_per_lot');
  return {
    atmBasis: pick('atm_basis', (x): x is AtmBasis => oneOf(x, ['A', 'B']), d.atmBasis),
    monthId: monthId === null || isContractId(monthId) ? monthId : d.monthId,
    target: pick('target', (x): x is OptionType => oneOf(x, OPTION_TYPES), d.target),
    filterAsk: pick('filter_ask', isBool, d.filterAsk),
    smileAxis: pick(
      'smile_axis',
      (x): x is SmileAxis => oneOf(x, ['k', 'moneyness', 'delta']),
      d.smileAxis,
    ),
    feePerLot: isFiniteNum(fee) && fee >= 0 && fee <= FEE_MAX ? fee : d.feePerLot,
    futureBasis: pick(
      'future_basis',
      (x): x is 'fixed' | 'decay' => oneOf(x, ['fixed', 'decay']),
      d.futureBasis,
    ),
    metricsUnit: pick(
      'metrics_unit',
      (x): x is MetricsUnitSetting => oneOf(x, ['auto', 'yen', 'thousand']),
      d.metricsUnit,
    ),
    pnlY: readPnlY(own(o, 'pnl_y')),
    pnlFolded: pick('pnl_folded', isBool, d.pnlFolded),
    hedge: readHedge(own(o, 'hedge')),
  };
}

/**
 * 古い版 → 次の版の読み替え（キー = 読み替え前の版）。版 1 が最初の版なので今は空。
 * 版 2 を入れるときは `1: (raw) => ...` を足し、tests/ui/saved/workspace-v1.json を v2 へ読み替えるテストを足す。
 */
export const MIGRATIONS: Readonly<Record<number, (raw: Obj) => Obj>> = {};

/** 古い版を今の版まで読み替える（途中の版の読み替えが無ければ null）。 */
export function migrate(
  raw: Obj,
  version: number,
  to: number = WORKSPACE_SCHEMA_VERSION,
): Obj | null {
  let cur = raw;
  for (let v = version; v < to; v++) {
    const step = Object.hasOwn(MIGRATIONS, v) ? MIGRATIONS[v] : undefined;
    if (!step) return null;
    cur = step(cur);
  }
  return cur;
}

/** 保存の文字列の版（JSON でない・オブジェクトでない・版が整数でなければ null）。 */
export function savedVersion(text: string | null): number | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  const v = own(raw, 'schema_version');
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * 保存されている作業が今の版より新しいか。このタブから書かない判定に使う（開いたとき・別のタブの `storage`
 * イベント・書く直前の読み直し）。新しい版をデプロイしたあと、開いたままの古い版のタブが新しい版の保存を
 * 上書きしないため。
 */
export function isNewerWorkspace(text: string | null): boolean {
  const v = savedVersion(text);
  return v !== null && v > WORKSPACE_SCHEMA_VERSION;
}

/**
 * 別のタブの `storage` イベントへの応じ方: 作業のキーでなければ 'none'、新しい版の保存なら 'newer'
 * （このタブは以後書かない）、それ以外（同じ版・古い版・消された）は 'otherTab'（知らせるだけ。後勝ち）。
 */
export function storageChange(
  key: string | null,
  newValue: string | null,
): 'none' | 'newer' | 'otherTab' {
  if (key !== WORKSPACE_KEY) return 'none';
  return isNewerWorkspace(newValue) ? 'newer' : 'otherTab';
}

/** 保存されている板が今の版より新しいか（読めなくても消さない判定）。 */
export function isNewerBoard(text: string | null): boolean {
  const v = savedVersion(text);
  return v !== null && v > BOARD_SCHEMA_VERSION;
}

/** 保存した作業を読む（localStorage の値。無ければ null）。 */
export function readWorkspace(text: string | null): ReadResult {
  if (text === null) return { kind: 'empty' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObj(raw)) return { kind: 'invalid' };
  const version = own(raw, 'schema_version');
  if (typeof version !== 'number' || !Number.isInteger(version)) return { kind: 'invalid' };
  if (version > WORKSPACE_SCHEMA_VERSION) return { kind: 'newer', version };
  const cur = migrate(raw, version);
  if (!cur) return { kind: 'invalid' };
  const position = readPosition(own(cur, 'position'));
  return {
    kind: 'ok',
    saved: { savedAt: readTime(own(cur, 'saved_at')), position, ui: readUi(own(cur, 'ui')) },
    dropped: position === null,
  };
}

/** 保存した作業を state に入れる（板を読む前。限月・ヘッジの限月は最初の loaded が板に合わせる）。 */
export function restoreState(base: State, saved: Workspace): State {
  const legs: UiLeg[] = (saved.position?.legs ?? []).map((l, i) => ({ ...l, id: i + 1 }));
  return {
    ...base,
    ...saved.ui,
    scenario: saved.position ? saved.position.scenario : base.scenario,
    legs,
    nextId: legs.length + 1,
  };
}

/** 開いたときの state（読めた作業があれば復元、無ければ初期状態）。 */
export function bootState(read: ReadResult, base: State = initialState): State {
  return read.kind === 'ok' ? restoreState(base, read.saved) : base;
}

// ---------------------------------------------------------------- 最後に取れた板

export interface SavedBoard {
  chain: Chain;
  /** 板を取った時刻（epoch ミリ秒） */
  fetchedAt: number;
  /** データ元（API など） */
  label: string;
}

/** 最後に取れた板を保存する文字列（板の JSON は API の応答を検証したものそのまま）。 */
export function serializeBoard(json: ChainJson, fetchedAt: number, label: string): string {
  return JSON.stringify({
    schema_version: BOARD_SCHEMA_VERSION,
    fetched_at: new Date(fetchedAt).toISOString(),
    label,
    chain: json,
  });
}

/** 保存した板を読む（壊れている・版が違う・板の JSON が不正なら null）。 */
export function readSavedBoard(text: string | null): SavedBoard | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || own(raw, 'schema_version') !== BOARD_SCHEMA_VERSION) return null;
  const fetchedAt = readTime(own(raw, 'fetched_at'));
  const label = own(raw, 'label');
  if (fetchedAt === null || typeof label !== 'string' || label.length > LABEL_MAX) return null;
  const res = validateChainJson(own(raw, 'chain'));
  if (!res.ok) return null;
  try {
    return { chain: normalizeChain(res.value, { r: DEFAULT_RATE }), fetchedAt, label };
  } catch {
    return null;
  }
}

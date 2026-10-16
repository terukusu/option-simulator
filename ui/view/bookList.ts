/**
 * 保存一覧（ポジ帳）の表示モデル・今の板での評価損益・確認の状態（純関数）。設計 docs/design.md 6.1・13.4（#70）。
 *
 * 1 行 = 名前（+「作業中」）/ 限月・足の数 / 受取 or 掛け金 / 満期の最大損失 / Δ / 今の板での評価損益 /
 * 保存の時刻・保存したときの板の時刻。
 *
 * - 受取 / 掛け金: 建値 × 枚数 × 乗数（板に依存しない）。掛け金 = 支払 − 受取 + 手数料（全足。指標の stake と同じ）。
 *   手数料はその項目に保存した 1 枚あたりの値
 * - 満期の最大損失・Δ: 今の板で足の市場を作り直し（ui/legMarket.ts）、損益グラフ・指標と同じ関数で求める
 *   （Δ は画面の「今日」の Δ = シナリオ 0 のラージ換算）。評価できない足は除いてその旨を出す
 * - 評価損益（markToBoard）: 保存した建値のまま、今の板の評価価格（MARK_BASIS。既定 mid、無ければスマイルの
 *   理論価格）との差 × 売買の符号 × 枚数 × 乗数 − 手数料。評価できない足が 1 本でもあれば出さない（部分和を出さない）
 */

import { type Calendar, type Chain, monthOf } from '../../data';
import {
  type AtmBasis,
  black76Price,
  DEFAULT_SETTINGS,
  discountedIntrinsic,
  evaluatePosition,
  type Leg,
  type ModelSettings,
  PRODUCTS,
  sideSign,
  ZERO_SCENARIO,
} from '../../model';
import {
  BOOK_MAX_CHARS,
  BOOK_WARN_RATIO,
  type BookRead,
  entryKey,
  IMPORT_MAX_BYTES,
  MAX_ENTRIES,
  type OkEntry,
} from '../book';
import type { CommitFail } from '../bookIo';
import { refreshLegMarkets } from '../legMarket';
import type { MetricsUnitSetting, UiLeg } from '../state';
import { DASH, fmtDateTime, fmtNum, fmtSigned } from './format';
import { AMOUNT_UNIT_LABEL, type AmountUnit, amountUnit, fmtAmount } from './metrics';
import { pnlDomains } from './pnlChart';
import { positionModel } from './position';

/**
 * 評価損益の評価価格（オーナー確認の対象。ここだけ変えれば一覧・説明の文言が変わる）:
 * 'mid' = 両側気配の仲値（無ければスマイルの理論価格）。返済側の気配での決済損益は出さない
 */
export const MARK_BASIS = 'mid' as const;
export const MARK_BASIS_TEXT = '今の板の mid（無ければスマイルの理論価格）';

// ---------------------------------------------------------------- 今の板での評価損益

export interface MarkPrice {
  price: number;
  /** スマイルの理論価格・合成先物で評価した */
  theoretical: boolean;
}

/** 1 本の足の今の板での評価価格（評価できなければ null）。 */
export function markPrice(
  chain: Chain,
  leg: Leg,
  tMin: number = DEFAULT_SETTINGS.tMin,
): MarkPrice | null {
  if (leg.kind === 'future') {
    const p = chain.future.price;
    if (leg.contract === chain.future.id) {
      return p !== null && Number.isFinite(p) ? { price: p, theoretical: false } : null;
    }
    const m = monthOf(chain, leg.contract);
    return m?.syntheticOk && Number.isFinite(m.F) ? { price: m.F, theoretical: true } : null;
  }
  const month = monthOf(chain, leg.expiry);
  if (!month) return null;
  const side = month.strikes.find((s) => s.k === leg.strike)?.[leg.type];
  if (side && side.quote === 'two_sided' && side.mid !== null && Number.isFinite(side.mid)) {
    return { price: side.mid, theoretical: false };
  }
  const F = month.F;
  if (!month.smile || !(Number.isFinite(F) && F > 0)) return null;
  const K = leg.strike;
  const T = month.T;
  const sigma = month.smile.smile.sigma(Math.log(K / F));
  const price =
    T > tMin && Number.isFinite(sigma) && sigma > 0
      ? black76Price(leg.type, F, K, T, sigma, chain.r)
      : discountedIntrinsic(leg.type, F, K, Math.max(T, 0), chain.r);
  return Number.isFinite(price) ? { price, theoretical: true } : null;
}

export interface MarkResult {
  /** 評価損益（円。評価できない足があれば null） */
  pnl: number | null;
  theoretical: boolean;
  /** 評価できない足の本数 */
  missing: number;
}

/** 今の板での評価損益 = Σ 符号 × 枚数 × 乗数 × (評価価格 − 建値) − 手数料 × 枚数（全足）。 */
export function markToBoard(chain: Chain, legs: readonly Leg[], feePerLot: number): MarkResult {
  let pnl = 0;
  let theoretical = false;
  let missing = 0;
  for (const leg of legs) {
    const m = markPrice(chain, leg);
    if (!m) {
      missing++;
      continue;
    }
    theoretical ||= m.theoretical;
    pnl += sideSign(leg.side) * leg.qty * PRODUCTS[leg.product].multiplier * (m.price - leg.entry);
    pnl -= feePerLot * leg.qty;
  }
  return { pnl: missing > 0 ? null : pnl, theoretical, missing };
}

// ---------------------------------------------------------------- 1 項目の要約

export interface PremiumOfEntry {
  /** 受取（売りの OP の足） */
  received: number;
  /** 支払（買いの OP の足） */
  paid: number;
  /** 受取超なら received（受取 − 支払）、支払超なら stake（支払 − 受取 + 手数料） */
  kind: 'received' | 'stake';
  amount: number;
}

/** 受取 / 掛け金（建値 × 枚数 × 乗数。板に依存しない。model の premiumSummary・指標の stake と同じ定義）。 */
export function entryPremium(legs: readonly Leg[], feePerLot: number): PremiumOfEntry {
  let received = 0;
  let paid = 0;
  let fees = 0;
  for (const l of legs) {
    fees += feePerLot * l.qty;
    if (l.kind !== 'option') continue;
    const amount = l.entry * l.qty * PRODUCTS[l.product].multiplier;
    if (l.side === 'sell') received += amount;
    else paid += amount;
  }
  const net = received - paid;
  return net >= 0
    ? { received, paid, kind: 'received', amount: net }
    : { received, paid, kind: 'stake', amount: -net + fees };
}

/** 限月（OP の限月・先物の限月を重複なしで昇順。3 つ以上は `2026-11 ほか 2`）。 */
export function entryMonths(legs: readonly Leg[]): string {
  const ms = [...new Set(legs.map((l) => (l.kind === 'option' ? l.expiry : l.contract)))].sort();
  return ms.length >= 3 ? `${ms[0]} ほか ${ms.length - 1}` : ms.join('・');
}

export interface EntrySummary {
  months: string;
  legCount: number;
  premium: PremiumOfEntry;
  /** 満期の最大損失（円。−∞ あり。板が無い・評価できる足が無ければ null） */
  maxLoss: number | null;
  /** Δ（ラージ換算。板が無い・評価できる足が無ければ null） */
  delta: number | null;
  /** 満期の最大損失・Δ から除いた足の本数 */
  excluded: number;
  /** 板に無い限月の足（開くと行のエラー）の本数 */
  offBoard: number;
  /** 今の板での評価損益（板が無ければ null） */
  mark: MarkResult | null;
}

export function entrySummary(
  chain: Chain | null,
  e: OkEntry,
  atmBasis: AtmBasis,
  calendar: Calendar,
): EntrySummary {
  const { position, ui } = e.ws;
  const legs = position.legs.map((l) => l.leg);
  const out: EntrySummary = {
    months: entryMonths(legs),
    legCount: legs.length,
    premium: entryPremium(legs, ui.feePerLot),
    maxLoss: null,
    delta: null,
    excluded: 0,
    offBoard: 0,
    mark: null,
  };
  if (!chain) return out;
  const settings: ModelSettings = {
    ...DEFAULT_SETTINGS,
    feePerLot: ui.feePerLot,
    futureBasis: ui.futureBasis,
  };
  const uiLegs: UiLeg[] = refreshLegMarkets(
    chain,
    position.legs.map((l, i) => ({ ...l, id: i + 1 })),
    calendar.holidays,
  );
  const pm = positionModel(chain, uiLegs, atmBasis, calendar, settings);
  out.offBoard = pm.rows.filter((r) => r.error !== null).length;
  const base = pnlDomains(chain, pm.prepared, pm.ctx, settings);
  out.excluded = legs.length - (base?.legs.length ?? 0);
  if (base) {
    out.maxLoss = base.profile.maxLoss.value;
    out.delta = evaluatePosition(base.legs, ZERO_SCENARIO, pm.ctx, settings).total.deltaLarge;
  }
  out.mark = markToBoard(chain, legs, ui.feePerLot);
  return out;
}

// ---------------------------------------------------------------- 一覧

export interface BookTag {
  text: string;
  warn: boolean;
}

export interface BookRowView {
  id: string;
  status: 'ok' | 'invalid' | 'newer';
  name: string;
  /** 作業中の内容と同じ（足・シナリオ・手数料・basis） */
  current: boolean;
  tags: BookTag[];
  months: string;
  legs: string;
  premiumLabel: string;
  premiumText: string;
  maxLossText: string;
  deltaText: string;
  markText: string;
  /** 評価損益の注記（理論値を含む・値の無い足） */
  markNote: string | null;
  /** 満期の最大損失・Δ の注記（一部の足を除く） */
  note: string | null;
  savedText: string;
  boardText: string;
  legCount: number;
}

export interface BookListView {
  state: 'ok' | 'empty' | 'invalid' | 'newer';
  count: number;
  /** 「N 件・約 X 千字」 */
  sizeText: string;
  /** 容量・件数の 80% を超えた */
  nearFull: boolean;
  unit: AmountUnit;
  unitLabel: string;
  /** 今の板の時刻（板が無ければ null） */
  boardText: string | null;
  rows: BookRowView[];
  /** 作業中の足があり、同じ内容の項目が無い（開くときに確認する） */
  unsaved: boolean;
}

export interface BookListInput {
  chain: Chain | null;
  read: BookRead;
  atmBasis: AtmBasis;
  calendar: Calendar;
  unitSetting: MetricsUnitSetting;
  /** 作業中の内容の bookKey */
  currentKey: string;
  /** 作業中の足の本数 */
  legCount: number;
}

export const INVALID_ROW_TEXT = '読めない項目（この画面では開けない。削除だけできる）';
export const NEWER_ROW_TEXT = '新しい版の項目（この画面では開けない。削除だけできる）';

function sizeText(count: number, chars: number): string {
  return `${count} 件・約 ${fmtNum(chars / 1000, 1)} 千字`;
}

export function bookListModel(input: BookListInput): BookListView {
  const { chain, read, unitSetting } = input;
  const boardText = chain ? fmtDateTime(chain.snapshotAt) : null;
  const base = {
    unit: amountUnit(0, 0, unitSetting),
    unitLabel: AMOUNT_UNIT_LABEL[amountUnit(0, 0, unitSetting)],
    boardText,
    rows: [] as BookRowView[],
    unsaved: input.legCount > 0,
    nearFull: false,
  };
  if (read.kind === 'invalid') return { ...base, state: 'invalid', count: 0, sizeText: '' };
  if (read.kind === 'newer') return { ...base, state: 'newer', count: 0, sizeText: '' };
  if (read.kind === 'empty') {
    return { ...base, state: 'empty', count: 0, sizeText: sizeText(0, 0) };
  }
  const { entries } = read.book;
  const summaries = new Map<string, EntrySummary>();
  let maxSum = 0;
  for (const e of entries) {
    if (e.status !== 'ok') continue;
    const s = entrySummary(chain, e, input.atmBasis, input.calendar);
    summaries.set(e.id, s);
    maxSum = Math.max(maxSum, s.premium.received + s.premium.paid);
  }
  const unit = amountUnit(maxSum, 0, unitSetting);
  let currentFound = false;
  const rows = entries.map((e): BookRowView => {
    const s = e.status === 'ok' ? summaries.get(e.id) : undefined;
    if (e.status !== 'ok' || !s) {
      return {
        id: e.id,
        status: e.status === 'ok' ? 'invalid' : e.status,
        name: e.status === 'newer' ? NEWER_ROW_TEXT : INVALID_ROW_TEXT,
        current: false,
        tags: [],
        months: '',
        legs: '',
        premiumLabel: '',
        premiumText: '',
        maxLossText: '',
        deltaText: '',
        markText: '',
        markNote: null,
        note: null,
        savedText: fmtDateTime(e.status === 'ok' ? null : e.savedAt),
        boardText: DASH,
        legCount: 0,
      };
    }
    const current = input.legCount > 0 && entryKey(e) === input.currentKey;
    currentFound ||= current;
    const tags: BookTag[] = [];
    if (current) tags.push({ text: '作業中', warn: false });
    if (s.offBoard > 0) tags.push({ text: `板に無い足 ${s.offBoard}`, warn: true });
    let markText: string;
    let markNote: string | null = null;
    if (!chain || !s.mark) markText = `${DASH}（板を読むと出る）`;
    else if (s.mark.pnl === null) {
      markText = DASH;
      markNote = `今の板で値の無い足 ${s.mark.missing} 本`;
    } else {
      markText = fmtAmount(s.mark.pnl, unit, true);
      if (s.mark.theoretical) markNote = '理論値を含む';
    }
    return {
      id: e.id,
      status: 'ok',
      name: e.name,
      current,
      tags,
      months: s.months,
      legs: `足 ${s.legCount} 本`,
      premiumLabel: s.premium.kind === 'received' ? '受取' : '掛け金',
      premiumText: fmtAmount(s.premium.amount, unit),
      maxLossText: chain ? fmtAmount(s.maxLoss, unit, true) : DASH,
      deltaText: chain ? fmtSigned(s.delta, 2) : DASH,
      markText,
      markNote,
      note: chain && s.excluded > 0 ? `一部の足を除く（${s.excluded} 本）` : null,
      savedText: fmtDateTime(e.ws.savedAt),
      boardText: fmtDateTime(e.ws.position.boardSnapshotAt),
      legCount: s.legCount,
    };
  });
  return {
    ...base,
    state: entries.length === 0 ? 'empty' : 'ok',
    count: entries.length,
    sizeText: sizeText(entries.length, read.chars),
    nearFull:
      read.chars > BOOK_MAX_CHARS * BOOK_WARN_RATIO ||
      entries.length > MAX_ENTRIES * BOOK_WARN_RATIO,
    unit,
    unitLabel: AMOUNT_UNIT_LABEL[unit],
    rows,
    unsaved: input.legCount > 0 && !currentFound,
  };
}

// ---------------------------------------------------------------- 確認・知らせの文言

/** ダイアログ内の確認（1 つだけ。別の操作・閉じるで消える） */
export type BookConfirm = { kind: 'open' | 'overwrite' | 'remove'; id: string } | { kind: 'clear' };

/** [開く] を押したとき: 未保存の作業があれば確認、無ければすぐ開く。 */
export function requestOpen(unsaved: boolean, id: string): BookConfirm | 'open' {
  return unsaved ? { kind: 'open', id } : 'open';
}

/**
 * 確認の文言（名前は JSX のテキストで入れる。ここでは文字列として組み立てるだけ）。
 * tabName = 作業中のタブの名前（#71。渡せば [開く] が置き換えるタブを書く）。
 */
export function confirmText(
  c: BookConfirm,
  name: string,
  legCount: number,
  tabName?: string,
): string {
  switch (c.kind) {
    case 'open':
      return tabName === undefined
        ? `作業中の足 ${legCount} 本は保存一覧に無い。「${name}」を開くと置き換わる（作業の自動保存は 1 つだけ）`
        : `作業中のタブ ${tabName} の足 ${legCount} 本は保存一覧に無い。「${name}」を開くとこのタブが置き換わる（残すなら [新しいタブで開く]）`;
    case 'overwrite':
      return `「${name}」を作業中の内容（足 ${legCount} 本）で上書きする？`;
    case 'remove':
      return `「${name}」を削除する？`;
    case 'clear':
      return '読めない保存一覧を空にする？（保存されている内容は消える）';
  }
}

export const CONFIRM_LABEL: Record<BookConfirm['kind'], string> = {
  open: '開く',
  overwrite: '上書き',
  remove: '削除',
  clear: '空にする',
};

/** 断ったときの知らせ（固定の文 + 件数だけ。ファイルの中身・ファイル名を反射しない） */
export const BOOK_FAIL_TEXT: Record<CommitFail, string> = {
  full: `保存一覧は ${MAX_ENTRIES} 件まで。不要な項目を削除してから`,
  tooLarge: `保存一覧の容量の上限（約 ${fmtNum(BOOK_MAX_CHARS / 1000)} 千字）を超える。不要な項目を削除してから`,
  notFound: '項目が見つからない（別のタブで変更された）。一覧を読み直した',
  emptyName: '名前を入れる',
  noLegs: '足が無い（足を追加してから保存する）',
  importInvalid: 'ファイルを読めない（保存一覧・作業の JSON でない、または壊れている）',
  importNewer: '新しい版のファイルは読めない（画面を新しくしてから読み込む）',
  importEmpty: 'ファイルに追加できる項目が無い',
  fileTooLarge: `ファイルが大きすぎる（${fmtNum(IMPORT_MAX_BYTES / 1_000_000)} MB まで）`,
  invalid: '保存一覧を読めない（形式が壊れている）。[空にする] で作り直せる',
  newer: '新しい版の画面で保存した一覧は、この画面では変更できない（画面を新しくする）',
  quota: '保存できない（ブラウザの保存容量の不足）',
  unavailable: '保存できない（ブラウザの設定で保存が無効）',
};

/** 読み込みの結果の知らせ（件数だけ）。 */
export function importDoneText(added: number, skipped: number): string {
  return skipped > 0 ? `${added} 件を追加、${skipped} 件は読めなかった` : `${added} 件を追加`;
}

/** 書き出しの知らせ（読めない項目を除いた件数）。 */
export function exportDoneText(count: number, skipped: number): string {
  return skipped > 0
    ? `${count} 件を書き出した（読めない ${skipped} 件は除いた）`
    : `${count} 件を書き出した`;
}

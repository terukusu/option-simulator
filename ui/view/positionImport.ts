/**
 * 建玉の一覧の画像から読み取った結果 → 確認表 → 新しい保有のタブ（#318・docs/design.md 14 章「画像から建玉を読み取る」。
 * 純関数。DOM・時計を読まない。時刻は板の evalTime / snapshotAt だけ）。
 *
 * - 確認表の 1 行 = 1 足の編集できる値（商品・限月・C/P・行使価格・売買・枚数・建値・建てた日）と、読み取りの時の印
 *   （読めない欄・年を補った）。行の判定（対象外・SQ 済み・IV 仮・欄のエラー）は今の値から rowView で毎回出す
 * - 入れる: 板の限月・板の行使価格の OP → 板の足（建値 = 読んだ値）／板の限月・板に無い行使価格 → 手入力の足（板の
 *   市場・その行使価格のスマイルの IV）／板に無い限月の OP → 手入力の足（SQ が最も近い板の限月の ATM IV。印「IV 仮」）／
 *   先物 → 先物の足（板に無い限月は 5.7 の扱い）。建てた日時 = 建てた日の 0:00 JST（#299 の openedAtOf の例外。
 *   取り込みだけ）。入れ先は必ず新しいタブ（openPositionInNewTab）。保有の印はチェックで（既定オン）
 * - 「IV 仮」「年を補った」「対象外」「SQ 済み」「読めない」は確認表だけの印（足の marks = 保存の形には足さない）
 * - 分割の約定（同じ銘柄の行が複数）はまとめない
 */

import {
  type AiStatus,
  boardOptionLeg,
  type Chain,
  type ChainMonth,
  futureLeg,
  manualOptionLeg,
  monthOf,
  type ReadProduct,
  type ReadResult,
} from '../../data';
import { type AtmBasis, type Holidays, monthlyExpiry, type Side } from '../../model';
import { type Action, QTY_MAX, type State, type UiLeg } from '../state';
import { aiErrorText } from './aiChat';
import { type NewTabUndo, newTabPlan } from './newTab';
import { TABS_FULL_TEXT } from './tabs';
import { NO_CHAIN_TEXT } from './topMenu';

// ---------------------------------------------------------------- 文

/**
 * 入口の名前（コマンドパレット・保有ポジションの一覧（⋯ の保有ポジション…）のボタン）。トップバーの ⋯ には足さない
 * （⋯ の行は 6 以下 = EPIC #281 終了条件 4。tests/ui/topMenu.test.ts）
 */
export const IMPORT_LABEL = '画像から建玉を読み取る…';
/** ダイアログの見出し */
export const IMPORT_TITLE = '画像から建玉を読み取る';

/**
 * 送る前の注意（[読み取る] の直前に常に見える文。毎回の確認ダイアログにはしない = docs/ui-guidelines.md P3）。
 * 送り先・扱いの規約・切り取り・保存しないこと
 */
export const IMPORT_NOTICE: readonly string[] = [
  '画像は Anthropic（Claude）に送って読み取ります。Anthropic での扱い（保存の期間・学習への利用）は、この simulator に設定した資格情報（API キー / サブスクリプション）の規約・設定に従います。',
  '口座番号・氏名・残高・メールアドレスなどが写っていれば、端末で切り取ってから選んでください。',
  'simulator は画像を保存しません（サーバーにもこの端末にも）。読み取りは [読み取る] を押したときだけです。',
];

/** 建玉の一覧でない画像（not_positions）の知らせ */
export const NOT_POSITIONS_TEXT =
  '建玉の一覧として読めませんでした。証券会社の建玉の一覧（建玉照会）の画面を選んでください';
/** 読み取りの途中の [中止] の後の文（サーバーは最後まで読むので費用は精算どおり） */
export const ABORTED_TEXT = '中止しました（読み取りの費用は精算どおりかかります）';
/** 画像が大きすぎて作り直しても上限に収まらない */
export const TOO_LARGE_TEXT =
  '画像が大きすぎて送れません（品質を下げても 500 KB を超える）。端末で切り取ってから選んでください';
/** 復号する前に断った巨大な画像 */
export const HUGE_TEXT =
  '画像が大きすぎて開けません（30 MB・4,000 万画素まで）。端末で切り取るか縮めてから選んでください';
/** 画像として読めない */
export const NOT_IMAGE_TEXT =
  '画像として読めませんでした（PNG・JPEG・WebP の画像を選んでください）';
/** 読み取り中の文 */
export const READING_TEXT = '読み取り中…（10〜30 秒ほど）';

export const PRODUCT_LABELS: Readonly<Record<ReadProduct, string>> = {
  op_large: 'ラージ OP',
  fut_large: 'ラージ先物',
  fut_mini: 'ミニ先物',
  fut_micro: 'マイクロ先物',
  unknown: '対象外',
};
export const PRODUCT_ORDER: readonly ReadProduct[] = [
  'op_large',
  'fut_large',
  'fut_mini',
  'fut_micro',
  'unknown',
];

/** [新しいタブに入れる] の [元に戻す] ができないときの文 */
export const IMPORT_NEW_TAB_UNDO_TEXT = {
  edited:
    '取り込んだタブを編集した（または保有の印を外した）ので戻しません（タブは × で閉じられます）',
  gone: '取り込んだタブはもう閉じています',
} as const;

/** 確認表だけの印 */
export const MARK_TEXT = {
  unreadable: '読めない',
  yearFilled: '年を補った',
  ivProvisional: 'IV 仮',
  unknown: '対象外',
  sqDone: 'SQ 済み',
} as const;

/** 読み取りの失敗の文（中継の code・画面の code） */
export function readErrorText(code: string, remainingUsd: number | null = null): string {
  switch (code) {
    case 'too_large':
    case 'bad_request':
      return '画像を受け付けられませんでした（大きさ・形式）。端末で切り取ってから選び直してください';
    case 'bad_result':
    case 'no_result':
    case 'upstream_bad_request':
    case 'upstream_incomplete':
      return '読み取れませんでした。建玉の一覧の画像か確かめて、もう一度押してください';
    case 'timeout':
      return '時間内（50 秒）に読み取れませんでした。もう一度押してください';
    case 'aborted':
      return ABORTED_TEXT;
    default:
      return aiErrorText(code, remainingUsd);
  }
}

// ---------------------------------------------------------------- 押せる / 押せない

/**
 * 入口（⋯・パレット・保有ポジションの一覧）が押せない理由（押せるなら null）。AI の状態をまだ読んでいなければ
 * 押せる扱い（ダイアログが読んで判定する）
 */
export function importEntryBlocked(hasChain: boolean, status: AiStatusLike): string | null {
  if (!hasChain) return NO_CHAIN_TEXT;
  if (status === null || 'error' in status) return null;
  return statusBlocked(status);
}

type AiStatusLike = AiStatus | null | { error: string };

function statusBlocked(st: AiStatus): string | null {
  if (!st.enabled) return 'AI は無効です（管理者の設定）';
  if (st.counted && st.remaining_usd !== null && st.remaining_usd <= 0) {
    return '今日の上限に達しました（日付が変わると戻ります）';
  }
  return null;
}

/** [読み取る] が押せない理由（押せるなら null） */
export function readBlocked(o: {
  hasChain: boolean;
  status: AiStatusLike;
  hasImage: boolean;
  reading: boolean;
}): string | null {
  if (!o.hasChain) return '板がありません（板を読んでから）';
  const st = o.status;
  if (st === null) return 'AI の状態を読んでいます…';
  if ('error' in st) return `AI の状態を読めません（${aiErrorText(st.error)}）`;
  const blocked = statusBlocked(st);
  if (blocked) return blocked;
  if (o.reading) return '読み取り中です';
  if (!o.hasImage) return '画像を選んでください';
  return null;
}

// ---------------------------------------------------------------- 行

export type ImportField =
  | 'product'
  | 'expiry'
  | 'type'
  | 'k'
  | 'side'
  | 'qty'
  | 'entry'
  | 'openedOn';

export interface ImportRow {
  /** 行の番号（1 から。確認表のキーと理由の文） */
  key: number;
  product: ReadProduct;
  /** YYYY-MM */
  expiry: string | null;
  type: 'C' | 'P' | null;
  k: number | null;
  side: Side | null;
  qty: number | null;
  entry: number | null;
  /** YYYY-MM-DD */
  openedOn: string | null;
  /** [外す] で false（対象外・SQ 済みの行は true でも入れない） */
  include: boolean;
  /** 読み取りで null だった欄（印「読めない」。利用者が埋めても残す = どこを直したか分かる） */
  unreadable: readonly ImportField[];
  /** 限月の年を板の日付から補った（印「年を補った」） */
  yearFilled: boolean;
}

const JST_MS = 9 * 3_600_000;
const YM = /^(\d{4})-(\d{2})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, '0');
const isOption = (p: ReadProduct) => p === 'op_large';
const isFuture = (p: ReadProduct): p is 'fut_large' | 'fut_mini' | 'fut_micro' =>
  p === 'fut_large' || p === 'fut_mini' || p === 'fut_micro';

/** 建てた日（YYYY-MM-DD）の 0:00 JST（epoch ミリ秒）。暦に無い日・形の違いは null */
export function openedAtOfDay(day: string): number | null {
  const m = YMD.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return utc - JST_MS;
}

/** 限月の SQ 時刻（板の限月なら板の SQ、無ければ暦から）。形の違いは null */
function sqTimeOf(chain: Chain, expiry: string, holidays: Holidays): number | null {
  const m = monthOf(chain, expiry);
  if (m) return m.sqTime;
  if (expiry === chain.future.id) return chain.future.sqTime;
  const ym = YM.exec(expiry);
  const month = ym ? Number(ym[2]) : Number.NaN;
  if (!ym || !(month >= 1 && month <= 12)) return null;
  return monthlyExpiry(Number(ym[1]), month, holidays).sqTime;
}

/** 年の無い限月: 板の評価時刻より後に SQ が来る最も近い同じ月（板の日付の年か翌年） */
export function fillYear(month: number, chain: Chain, holidays: Holidays): string {
  const y0 = new Date(chain.evalTime + JST_MS).getUTCFullYear();
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const id = `${y}-${pad2(month)}`;
    const sq = sqTimeOf(chain, id, holidays);
    if (sq !== null && sq > chain.evalTime) return id;
  }
  return `${y0 + 1}-${pad2(month)}`;
}

/** 読み取りの結果 → 確認表の行（年なしは補う。対象外・SQ 済みは include を外す） */
export function initialRows(result: ReadResult, chain: Chain, holidays: Holidays): ImportRow[] {
  return result.rows.map((r, i) => {
    const unreadable: ImportField[] = [];
    let expiry: string | null = null;
    let yearFilled = false;
    if (r.expiry_month === null) unreadable.push('expiry');
    else if (r.expiry_year === null) {
      expiry = fillYear(r.expiry_month, chain, holidays);
      yearFilled = true;
    } else expiry = `${r.expiry_year}-${pad2(r.expiry_month)}`;
    const opt = isOption(r.product);
    if (opt && r.type === null) unreadable.push('type');
    if (opt && r.strike === null) unreadable.push('k');
    if (r.side === null) unreadable.push('side');
    if (r.qty === null) unreadable.push('qty');
    if (r.price === null) unreadable.push('entry');
    if (r.opened_on === null) unreadable.push('openedOn');
    const row: ImportRow = {
      key: i + 1,
      product: r.product,
      expiry,
      type: opt ? r.type : null,
      k: opt ? r.strike : null,
      side: r.side,
      qty: r.qty,
      entry: r.price,
      openedOn: r.opened_on,
      include: true,
      unreadable,
      yearFilled,
    };
    row.include = rowView(row, chain, holidays).excluded === null;
    return row;
  });
}

export interface RowError {
  field: ImportField;
  reason: string;
}

export interface RowView {
  excluded: 'unknown' | 'sq_done' | null;
  /** 板に無い限月の OP（IV の初期値が最も近い限月の ATM IV） */
  ivProvisional: boolean;
  errors: RowError[];
}

/** 今の値から行の判定（対象外・SQ 済み・IV 仮・欄のエラー）。入れない行（外した・対象外・SQ 済み）はエラーを出さない */
export function rowView(row: ImportRow, chain: Chain, holidays: Holidays): RowView {
  if (row.product === 'unknown') return { excluded: 'unknown', ivProvisional: false, errors: [] };
  const sq = row.expiry !== null ? sqTimeOf(chain, row.expiry, holidays) : null;
  if (sq !== null && sq <= chain.evalTime) {
    return { excluded: 'sq_done', ivProvisional: false, errors: [] };
  }
  const opt = isOption(row.product);
  const ivProvisional = opt && row.expiry !== null && sq !== null && !monthOf(chain, row.expiry);
  if (!row.include) return { excluded: null, ivProvisional, errors: [] };
  const errors: RowError[] = [];
  if (row.expiry === null) errors.push({ field: 'expiry', reason: '限月が空' });
  else if (sq === null) errors.push({ field: 'expiry', reason: '限月の形（YYYY-MM）' });
  if (opt) {
    if (row.type === null) errors.push({ field: 'type', reason: 'C / P が空' });
    if (row.k === null) errors.push({ field: 'k', reason: '行使価格が空' });
    else if (!(Number.isFinite(row.k) && row.k > 0)) {
      errors.push({ field: 'k', reason: '行使価格は正の数' });
    }
  }
  if (row.side === null) errors.push({ field: 'side', reason: '売買が空' });
  if (row.qty === null) errors.push({ field: 'qty', reason: '枚数が空' });
  else if (!(Number.isInteger(row.qty) && row.qty >= 1 && row.qty <= QTY_MAX)) {
    errors.push({ field: 'qty', reason: `枚数は 1〜${QTY_MAX.toLocaleString('en-US')} の整数` });
  }
  if (row.entry === null) errors.push({ field: 'entry', reason: '建値が空' });
  else if (!(Number.isFinite(row.entry) && row.entry >= 0)) {
    errors.push({ field: 'entry', reason: '建値は 0 以上' });
  }
  if (row.openedOn === null) errors.push({ field: 'openedOn', reason: '建てた日が空' });
  else {
    const at = openedAtOfDay(row.openedOn);
    if (at === null) errors.push({ field: 'openedOn', reason: '建てた日の形（YYYY-MM-DD）' });
    else if (at > chain.snapshotAt) {
      errors.push({ field: 'openedOn', reason: '建てた日が今の板より後' });
    }
  }
  if (ivProvisional && row.expiry !== null && nearestAtmIv(chain, sq as number) === null) {
    errors.push({ field: 'expiry', reason: 'IV の初期値を決められない（板にスマイルが無い）' });
  }
  return { excluded: null, ivProvisional, errors };
}

/** その限月の ATM の IV（小数。スマイルと ATM が無ければ null） */
function atmIv(m: ChainMonth, basis: AtmBasis): number | null {
  const smile = m.smile?.smile;
  if (!smile || !(Number.isFinite(m.F) && m.F > 0)) return null;
  const k = m.atm[basis].pick?.k ?? m.F;
  const v = smile.sigma(Math.log(k / m.F));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** SQ が最も近い板の限月の ATM IV（板に無い限月の手入力の IV の初期値） */
function nearestAtmIv(chain: Chain, sq: number, basis: AtmBasis = 'B'): number | null {
  let best: { d: number; iv: number } | null = null;
  for (const m of chain.months) {
    const iv = atmIv(m, basis);
    if (iv === null) continue;
    const d = Math.abs(m.sqTime - sq);
    if (!best || d < best.d) best = { d, iv };
  }
  return best?.iv ?? null;
}

/** 板の限月で板に無い行使価格の IV（その行使価格のスマイル。無ければ ATM IV） */
function strikeIv(m: ChainMonth, k: number, basis: AtmBasis): number | null {
  const smile = m.smile?.smile;
  if (smile && Number.isFinite(m.F) && m.F > 0) {
    const v = smile.sigma(Math.log(k / m.F));
    if (Number.isFinite(v) && v > 0) return v;
  }
  return atmIv(m, basis);
}

/** 行を直す（利用者の入力。印「読めない」「年を補った」は残す。限月を直したら年の補いは消す） */
export function editRow(
  row: ImportRow,
  patch: Partial<Omit<ImportRow, 'key' | 'unreadable'>>,
): ImportRow {
  const next = { ...row, ...patch };
  if (patch.expiry !== undefined && patch.expiry !== row.expiry) next.yearFilled = false;
  if (patch.product !== undefined && !isOption(patch.product)) {
    next.type = null;
    next.k = null;
  }
  return next;
}

// ---------------------------------------------------------------- 入れる

export interface ImportPlanOk {
  ok: true;
  action: Action;
  undo: NewTabUndo;
  legs: UiLeg[];
  /** 確認表の行の番号ごとの印「IV 仮」（入れた行だけ） */
  ivProvisional: number[];
  text: string;
  /** IV 仮の行があったときの知らせ（足の詳細で IV を確かめる。無ければ null） */
  ivNote: string | null;
}

export type ImportPlan = ImportPlanOk | { ok: false; reasons: string[] };

function buildLeg(
  row: ImportRow,
  chain: Chain,
  holidays: Holidays,
  basis: AtmBasis,
): Omit<UiLeg, 'id'> {
  const expiry = row.expiry as string;
  const side = row.side as Side;
  const qty = row.qty as number;
  const entry = row.entry as number;
  const openedAt = openedAtOfDay(row.openedOn as string) as number;
  if (isFuture(row.product)) {
    const built = futureLeg(
      chain,
      { product: row.product, contract: expiry, side, qty, entry },
      holidays,
    );
    return {
      leg: { ...built.leg, openedAt },
      marks: built.marks,
      futureMarket: { contract: built.leg.contract, market: built.market },
    };
  }
  const type = row.type === 'C' ? 'call' : 'put';
  const k = row.k as number;
  const m = monthOf(chain, expiry);
  if (m?.rows.some((r) => r.k === k)) {
    const built = boardOptionLeg(chain, { expiry, k, type, side, qty, entry });
    return { leg: { ...built.leg, openedAt }, marks: built.marks };
  }
  const sq = sqTimeOf(chain, expiry, holidays) as number;
  const iv = m ? strikeIv(m, k, basis) : nearestAtmIv(chain, sq, basis);
  const built = manualOptionLeg(
    chain,
    { product: 'op_large', expiry, type, k, side, qty, entry, iv: iv as number },
    holidays,
  );
  const leg: Omit<UiLeg, 'id'> = { leg: { ...built.leg, openedAt }, marks: built.marks };
  if (built.marks.includes('no_board')) leg.optionMarket = { expiry, market: built.market };
  return leg;
}

/**
 * [新しいタブに入れる] の action と [元に戻す] の控え（押せないなら理由）。入れる行が 0・エラーの行あり・タブが上限 →
 * ok: false。held = 「保有の印を付ける」
 */
export function importPlan(
  rows: readonly ImportRow[],
  chain: Chain,
  holidays: Holidays,
  state: State,
  held: boolean,
  basis: AtmBasis = 'B',
): ImportPlan {
  const reasons: string[] = [];
  const take: ImportRow[] = [];
  const iv: number[] = [];
  for (const row of rows) {
    const v = rowView(row, chain, holidays);
    if (v.excluded !== null || !row.include) continue;
    if (v.errors.length) {
      reasons.push(`${row.key} 行目: ${v.errors.map((e) => e.reason).join('・')}`);
      continue;
    }
    take.push(row);
    if (v.ivProvisional) iv.push(row.key);
  }
  if (take.length === 0 && reasons.length === 0) reasons.push('入れる行がありません');
  if (reasons.length) return { ok: false, reasons };
  let legs: UiLeg[];
  try {
    legs = take.map((r, i) => ({ ...buildLeg(r, chain, holidays, basis), id: i + 1 }));
  } catch (e) {
    return { ok: false, reasons: [e instanceof Error ? e.message : String(e)] };
  }
  const plan = newTabPlan(state, legs, held);
  if (!plan) return { ok: false, reasons: [TABS_FULL_TEXT] };
  return {
    ok: true,
    action: plan.action,
    undo: plan.undo,
    legs,
    ivProvisional: iv,
    text: `建玉 ${legs.length} 本を新しいタブに入れた`,
    ivNote: ivProvisionalNote(iv),
  };
}

/**
 * IV 仮の行の知らせ（入れた後。足の印には残らないので、どの行の IV を確かめるかをここで示す）。無ければ null
 */
export function ivProvisionalNote(keys: readonly number[]): string | null {
  if (keys.length === 0) return null;
  return `IV 仮の行があります（${keys.map((k) => `${k} 行目`).join('・')}。板に無い限月で、最も近い限月の ATM IV を仮に入れた）。足の詳細で IV を確かめてください`;
}

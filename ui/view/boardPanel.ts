/**
 * 画面の板の表示モデル（純関数。#85、docs/ui-redesign.md §2.4・§4.3・§5・§5.2）。
 * Preact・DOM に依存しない。数値は `ui/view/board.ts` の `boardRows` の値を書式化するだけで、作り直さない。
 *
 * - 列の段階は板の枠（`section.board`、枠線を含む）の幅で 9 / 7 / 5（`boardColumns` は旧画面用だったもの。値は変えない）
 * - 行の文字列（`boardRowTexts`）は板と限月だけで決まる（タブの足・列の段階・限月の切替では作り直さない）
 * - バッジ（`boardBadges`）は作業中のタブの OP の足を売り / 買いで別々に合計する
 */

import { boardOptionLegOnly, type Chain, type ChainMonth } from '../../data';
import type { AtmBasis, OptionLeg, OptionType, Side } from '../../model';
import type { UiLeg } from '../state';
import {
  ASK_FILTER_YEN,
  type BoardRow,
  type BoardSideCell,
  DELTA_JUMPS,
  jumpToDelta,
  jumpToOtm,
  OTM_JUMPS,
  rowMarkLabels,
  sideMarkLabels,
} from './board';
import { DASH, fmtNum } from './format';
import type { HeaderMonthView } from './header';

export type BoardPanelColumns = 9 | 7 | 5;

/** 9 列を出す板の枠の最小幅（px。`section.board` の幅 = 枠線を含む。1800×1000 で 540） */
export const BOARD9_MIN_WIDTH = 540;
/** 7 列を出す板の枠の最小幅（px。1440×900 で 432） */
export const BOARD7_MIN_WIDTH = 410;

/** 列の段階（幅が不明 = 0 以下・非有限は 5 列）。 */
export function boardPanelColumns(width: number): BoardPanelColumns {
  if (!Number.isFinite(width) || width <= 0) return 5;
  if (width >= BOARD9_MIN_WIDTH) return 9;
  if (width >= BOARD7_MIN_WIDTH) return 7;
  return 5;
}

/** 列の見出し（5 列は種別に依らない） */
export const BOARD_COLUMN_HEADS: Readonly<Record<BoardPanelColumns, readonly string[]>> = {
  9: ['Δ', 'IV', 'C bid', 'C ask', 'K', 'P bid', 'P ask', 'IV', 'Δ'],
  7: ['IV', 'C bid', 'C ask', 'K', 'P bid', 'P ask', 'IV'],
  5: ['K', 'bid', 'ask', 'IV', 'Δ'],
};

export type BoardMarkKind = 'unstable' | 'interpolated' | 'extrapolated' | 'noQuote' | 'ivMissing';

/** 印（狭いセルの短い形と、title・読み上げ・ⓘ の全文） */
export interface BoardMark {
  kind: BoardMarkKind;
  short: string;
  full: string;
}

/** 短い形（補間 / 外挿は K の数字の点線の下線。文字は凡例の記号） */
export const BOARD_MARK_SHORT: Readonly<Record<BoardMarkKind, string>> = {
  unstable: '×',
  interpolated: '┄',
  extrapolated: '┄',
  noQuote: '—',
  ivMissing: '—/—',
};

const ROW_MARK_KIND: Readonly<Record<string, BoardMarkKind>> = {
  'IV 不安定': 'unstable',
  補間: 'interpolated',
  外挿: 'extrapolated',
};
const SIDE_MARK_KIND: Readonly<Record<string, BoardMarkKind>> = {
  気配なし: 'noQuote',
  'JPX の IV 欠損': 'ivMissing',
};

const mark = (kind: BoardMarkKind, full: string): BoardMark => ({
  kind,
  short: BOARD_MARK_SHORT[kind],
  full,
});

export interface BoardSideText {
  bid: string;
  ask: string;
  /** `bid の IV/ask の IV`（JPX の IV。1 桁・% なし） */
  iv: string;
  /** スマイルの IV での Δ（2 桁） */
  delta: string;
  /** bid / ask のボタンの aria-label（`64,000 put bid 740 で売り`） */
  bidLabel: string;
  askLabel: string;
  /** ボタンの title と読み上げの名前（片側だけの気配は「（気配なし）」を足す） */
  bidTitle: string;
  askTitle: string;
  noQuote: boolean;
  /** セルの印（`sideMarkLabels` の順） */
  marks: BoardMark[];
}

export interface BoardRowText {
  k: string;
  /** K の数字の点線の下線（補間 / 外挿。無ければ null） */
  kMark: 'interp' | 'extrap' | null;
  /** 行の印（`rowMarkLabels` の順） */
  marks: BoardMark[];
  /** IV 不安定の × を出す側（9 / 7 列。OTM 側。不安定でなければ null） */
  flagSide: OptionType | null;
  call: BoardSideText;
  put: BoardSideText;
}

/** 10 進の数字列 + 小数の桁数 → 小数 digits 桁に四捨五入（中間は大きい方。符号なし） */
function roundDecimal(int: string, frac: string, digits: number): [string, string] {
  if (frac.length <= digits) return [int, frac.padEnd(digits, '0')];
  const up = (frac.charCodeAt(digits) ?? 48) >= 53; // '5'
  const keep = int + frac.slice(0, digits);
  if (!up) return [int, frac.slice(0, digits)];
  const d = keep.split('');
  let i = d.length - 1;
  while (i >= 0) {
    if (d[i] === '9') {
      d[i] = '0';
      i--;
    } else {
      d[i] = String.fromCharCode((d[i] as string).charCodeAt(0) + 1);
      break;
    }
  }
  const all = (i < 0 ? '1' : '') + d.join('');
  return [all.slice(0, all.length - digits), all.slice(all.length - digits)];
}

/**
 * fmtNum と同じ文字列（en-US の桁区切り・小数 digits 桁・負は −・丸めて 0 の負は符号なし・欠損は —）を Intl を通さずに作る。
 * 322 行 × 2 限月の行の文字列（1 万個前後）を 1 フレームで作るため（Intl.NumberFormat.format は 1 回 ≈ 1.4µs）。
 * 丸めは Intl と同じく最短の 10 進表記（String(v)）を四捨五入（中間は絶対値の大きい方 = halfExpand）。
 * 指数表記になる大きさ・小ささは fmtNum に任せる。
 */
export function fmtNumFast(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = String(Math.abs(v));
  if (s.includes('e')) return fmtNum(v, digits);
  const dot = s.indexOf('.');
  const [int, frac] = roundDecimal(
    dot < 0 ? s : s.slice(0, dot),
    dot < 0 ? '' : s.slice(dot + 1),
    digits,
  );
  let out = int;
  if (int.length > 3) {
    out = '';
    for (let i = 0; i < int.length; i++) {
      if (i > 0 && (int.length - i) % 3 === 0) out += ',';
      out += int[i];
    }
  }
  if (digits > 0) out += `.${frac}`;
  return v < 0 && /[1-9]/.test(int + frac) ? `−${out}` : out;
}

/** bid / ask のボタンの aria-label（旧 Board の QuoteButton と同じ式） */
export function quoteLabel(k: number, type: OptionType, side: Side, price: number | null): string {
  return quoteLabelText(fmtNumFast(k), type, side, price === null ? null : fmtNumFast(price));
}

function quoteLabelText(k: string, type: OptionType, side: Side, price: string | null): string {
  const what = side === 'sell' ? 'bid' : 'ask';
  return `${k} ${type} ${what} ${price ?? '気配なし'} で${side === 'sell' ? '売り' : '買い'}`;
}

function sideText(k: string, type: OptionType, c: BoardSideCell): BoardSideText {
  const bid = fmtNumFast(c.bid);
  const ask = fmtNumFast(c.ask);
  const bidLabel = quoteLabelText(k, type, 'sell', c.bid === null ? null : bid);
  const askLabel = quoteLabelText(k, type, 'buy', c.ask === null ? null : ask);
  const title = (label: string, price: number | null) =>
    c.noQuote && price !== null ? `${label}（気配なし）` : label;
  return {
    bid,
    ask,
    // JPX の IV（%）は fmtIvPct（= 1 桁）と同じ
    iv: `${fmtNumFast(c.bidIv, 1)}/${fmtNumFast(c.askIv, 1)}`,
    delta: fmtNumFast(c.delta, 2),
    bidLabel,
    askLabel,
    bidTitle: title(bidLabel, c.bid),
    askTitle: title(askLabel, c.ask),
    noQuote: c.noQuote,
    marks: sideMarkLabels(c).map((t) => mark(SIDE_MARK_KIND[t] ?? 'noQuote', t)),
  };
}

/**
 * 行ごとの文字列と印（`boardRows` の行の k をキーに。O(n)）。表示の並び・絞り込みに依らないので、
 * 板・限月が変わったときだけ作る。
 */
export function boardRowTexts(
  _chain: Chain,
  month: ChainMonth,
  rows: readonly BoardRow[],
): Map<number, BoardRowText> {
  const otm = new Map<number, OptionType>();
  for (const s of month.strikes) otm.set(s.k, s.otmType);
  const out = new Map<number, BoardRowText>();
  for (const r of rows) {
    const marks = rowMarkLabels(r).map((t) => mark(ROW_MARK_KIND[t] ?? 'unstable', t));
    const k = fmtNumFast(r.k);
    out.set(r.k, {
      k,
      kMark: r.mark === 'interpolated' ? 'interp' : r.mark === 'extrapolated' ? 'extrap' : null,
      marks,
      flagSide: r.unstable ? (otm.get(r.k) ?? 'put') : null,
      call: sideText(k, 'call', r.call),
      put: sideText(k, 'put', r.put),
    });
  }
  return out;
}

/** 売り / 買いの枚数のバッジ（`売3`・`買1`。0 枚は空文字） */
export interface BadgePair {
  sell: string;
  buy: string;
}

export type BoardBadges = Map<number, { call?: BadgePair; put?: BadgePair }>;

/**
 * その限月の OP の足（板の足・手入力の足）の枚数を、K・種別ごとに売り / 買いで別々に合計する（先物は数えない）。
 * 足が無ければ空の Map。O(足の本数)。
 */
export function boardBadges(legs: readonly UiLeg[], monthId: string): BoardBadges {
  const sum = new Map<number, Record<OptionType, Record<Side, number>>>();
  for (const { leg } of legs) {
    if (leg.kind !== 'option' || leg.expiry !== monthId) continue;
    let e = sum.get(leg.strike);
    if (!e) {
      e = { call: { sell: 0, buy: 0 }, put: { sell: 0, buy: 0 } };
      sum.set(leg.strike, e);
    }
    e[leg.type][leg.side] += leg.qty;
  }
  const text = (n: number, head: string) => (n > 0 ? `${head}${fmtNum(n)}` : '');
  const out: BoardBadges = new Map();
  for (const [k, e] of sum) {
    const v: { call?: BadgePair; put?: BadgePair } = {};
    for (const t of ['call', 'put'] as const) {
      const p = { sell: text(e[t].sell, '売'), buy: text(e[t].buy, '買') };
      if (p.sell || p.buy) v[t] = p;
    }
    if (v.call || v.put) out.set(k, v);
  }
  return out;
}

export interface BoardChip {
  key: string;
  text: string;
  /** aria-label（短い文字の全文） */
  label: string;
  /** 行き先の K（決まらなければ null） */
  k: number | null;
  disabled: boolean;
}

const pctText = (p: number) => `${Math.round(p * 100)}%`;
const deltaShort = (d: number) => d.toFixed(2).replace(/^0/, '');

/**
 * ジャンプのチップ（OTM 10〜40%・|Δ| .05〜.30）。行き先は今の `jumpToOtm`・`jumpToDelta`（rows は `boardRows` の昇順）。
 * 基準価格が無ければ OTM は押せない（今と同じ）。
 */
export function boardChips(
  rows: readonly BoardRow[],
  target: OptionType,
  x0: number | null,
): BoardChip[] {
  const otm = OTM_JUMPS.map((p, i) => ({
    key: `otm${Math.round(p * 100)}`,
    text: i === 0 ? `OTM ${pctText(p)}` : pctText(p),
    label: `OTM ${pctText(p)} へ`,
    k: jumpToOtm(rows, target, x0, p),
    disabled: x0 === null,
  }));
  const delta = DELTA_JUMPS.map((d, i) => ({
    key: `delta${deltaShort(d)}`,
    text: i === 0 ? `|Δ| ${deltaShort(d)}` : deltaShort(d),
    label: `|Δ| ${d.toFixed(2)} へ`,
    k: jumpToDelta(rows, target, d),
    disabled: false,
  }));
  return [...otm, ...delta];
}

export const ASK_FILTER_TEXT = `ask ≤ ${ASK_FILTER_YEN} 円`;

export interface BoardFoot {
  f: string;
  atm: string;
  sq: string;
  hint: string;
}

/** `YYYY-MM-DD` → `MM/DD`（形が違えばそのまま） */
export function sqShort(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[1]}/${m[2]}` : date;
}

/** 脚注（F・ATM（基準）・SQ・案内）。 */
export function boardFoot(m: HeaderMonthView, basis: AtmBasis): BoardFoot {
  return {
    f: m.noForward ? m.forward : `F ${m.forward}`,
    atm: m.noAtm ? m.atm : `ATM ${m.atm}（${basis}）`,
    sq: `SQ ${sqShort(m.sqDate)}`,
    hint: 'bid = 売り · ask = 買い',
  };
}

export interface MonthSegOption {
  value: string;
  text: string;
  label: string;
}

/** 限月の Seg の選択肢（文字 `11月限`・aria-label `2026-11 限`。同じ月番号が 2 つあれば年を付ける） */
export function monthSegOptions(months: readonly { id: string }[]): MonthSegOption[] {
  const parse = (id: string) => /^(\d{4})-(\d{2})$/.exec(id);
  const count = new Map<string, number>();
  for (const m of months) {
    const p = parse(m.id);
    if (p?.[2]) count.set(p[2], (count.get(p[2]) ?? 0) + 1);
  }
  return months.map((m) => {
    const p = parse(m.id);
    const label = `${m.id} 限`;
    if (!p?.[1] || !p[2]) return { value: m.id, text: label, label };
    const month = `${Number(p[2])}月限`;
    const text = (count.get(p[2]) ?? 0) > 1 ? `${p[1].slice(2)}年${month}` : month;
    return { value: m.id, text, label };
  });
}

export interface MarketAddInput {
  expiry: string;
  k: number;
  type: OptionType;
  side: Side;
}

/**
 * 板・スマイルから入る足（reducer の addBoardLeg と同じ boardOptionLeg の leg。作れなければ null）。印は作らない
 * （boardOptionLegOnly = IV の逆算をしない。コマンドパレットは 322 行の板で ≈ 1,300 回呼ぶ。#89）
 */
export function marketAddPlan(chain: Chain | null, input: MarketAddInput): OptionLeg | null {
  if (!chain) return null;
  try {
    return boardOptionLegOnly(chain, input);
  } catch {
    return null;
  }
}

/** 入る足の短い名前（`売 P 64,000 @740`。建値は整数なら 0 桁、そうでなければ 1 桁 = #82 と同じ）。パレットの足の行も同じ */
export function marketAddLabel(leg: OptionLeg): string {
  const price = fmtNum(leg.entry, Number.isInteger(leg.entry) ? 0 : 1);
  return `${leg.side === 'sell' ? '売' : '買'} ${leg.type === 'put' ? 'P' : 'C'} ${fmtNum(leg.strike, 0)} @${price}`;
}

/** 足を入れたトーストの文（`売 P 64,000 @740 を追加`） */
export function marketAddToast(leg: OptionLeg): string {
  return `${marketAddLabel(leg)} を追加`;
}

/** 見出しの ⓘ（今の「板の使い方」の文 + 印の意味） */
export const BOARD_HINT = [
  'bid = 売り、ask = 買い で足を追加。Δ はスマイルの IV での値。',
  '× = IV 不安定 · K の点線 = 補間 / 外挿 · — = 気配なし · —/— = JPX の IV 欠損 · 売1 / 買2 = 作業中のタブの足の枚数',
] as const;

/** ジャンプ先の行の強調（ms。§4.3・§6） */
export const BOARD_FLASH_MS = 900;

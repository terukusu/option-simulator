/**
 * ポジション一覧の表示モデル（純関数）。設計 docs/design.md M3・5.3・5.6・5.7・K6。
 *
 * 評価は model/ の prepareLeg・evaluatePosition（シナリオ 0、X' = X₀）・displayGreeks をそのまま使う。
 * 建値ずれ（円）= シナリオ 0 の理論損益への影響 = −売買の符号 × mismatch × 乗数 × 枚数
 * （theoreticalPnl のシナリオ 0 と一致する。手数料は含めない）。
 *
 * 前の板で建てた足（建てた日時 < 今の板の時刻。openedBeforeBoard。#299）は今の値段（ui/view/mark.ts の markPrice =
 * 保存一覧の評価損益と同じ物差し。先物は評価に使う先物価格）を prepareLeg に渡して時価評価する
 * （シナリオ 0 の損益 = 含み損益 + 建値ずれ − 手数料）。足ごとに 1 回（グラフの点ごとの評価には足さない）。
 */

import {
  buildMarketContext,
  type Calendar,
  type Chain,
  isExpiryConfirmed,
  type LegMark,
  monthOf,
} from '../../data';
import {
  type AnchorSource,
  type AtmBasis,
  DEFAULT_SETTINGS,
  type DisplayGreeks,
  evaluatePosition,
  type FutureMarket,
  type Leg,
  type LegState,
  type MarketContext,
  type ModelSettings,
  type OptionExpiryMarket,
  type PreparedLeg,
  type Product,
  prepareLeg,
  type Side,
  ZERO_SCENARIO,
} from '../../model';
import { parseQty, type UiLeg } from '../state';
import { fmtDate, fmtNum } from './format';
import { type MarkPrice, markPrice } from './mark';

export const PRODUCT_LABEL: Record<Product, string> = {
  op_large: 'ラージ OP',
  fut_large: 'ラージ先物',
  fut_mini: 'ミニ先物',
  fut_micro: 'マイクロ先物',
};

export const SIDE_LABEL: Record<Side, string> = { buy: '買い', sell: '売り' };

export const LEG_MARK_LABEL: Record<LegMark, string> = {
  no_board: '板なし（手入力）',
  no_quote: '気配なし',
  unstable_iv: 'IV 不安定',
  extrapolated: '外挿',
  interpolated: '補間',
  forward_from_future: 'F は先物で代用',
  future_manual: '建値は手入力（板の先物と限月違い）',
  no_price: '先物価格なし（建値で評価）',
};

/** 建値ずれ（円）を「0」とみなす幅 */
export const MISMATCH_EPS_YEN = 1;

export const MISMATCH_NOTE: Record<AnchorSource, string> = {
  entry: '',
  mark: '',
  smile:
    '建値 ≤ 割引本源的価値のためスマイルの IV を使用（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
  manual: 'IV を手で入れた（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
  none: 'IV を建値から求められない（建値と IV が整合しない。シナリオ 0 でも損益が 0 にならない）',
};

/** 前の板で建てた足（今の値段で時価評価した足）の建値ずれの注記（#299。建値の代わりに今の値段と比べる） */
export const MARK_MISMATCH_NOTE: Record<AnchorSource, string> = {
  entry: '',
  mark: '',
  smile:
    '今の値段 ≤ 割引本源的価値のためスマイルの IV を使用（今の値段と IV が整合しない。シナリオ 0 の損益が含み損益からずれる）',
  manual: 'IV を手で入れた（今の値段と IV が整合しない。シナリオ 0 の損益が含み損益からずれる）',
  none: 'IV を今の値段から求められない（今の値段と IV が整合しない。シナリオ 0 の損益が含み損益からずれる）',
};

// ---------------------------------------------------------------- 建てた日時（#299）

const JST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * 前の板で建てた足か（建てた日時 < 今の板の時刻。オーナー判断 1 = (a)。判定はここ 1 か所）。
 * 建てた日時の無い足（古い保存・板が無いときに入れた手入力の足）は false（今までどおり建値から評価）。
 */
export function openedBeforeBoard(leg: Leg, chain: Chain): boolean {
  return leg.openedAt !== undefined && leg.openedAt < chain.snapshotAt;
}

/** JST の暦日の通し番号（epoch からの日数）。 */
export function jstDay(t: number): number {
  return Math.floor((t + JST_OFFSET_MS) / DAY_MS);
}

/** 建ててから今の板までの暦日（JST）。今の板より後の建てた日時は 0。 */
export function daysSinceOpen(openedAt: number, snapshotAt: number): number {
  return Math.max(jstDay(snapshotAt) - jstDay(openedAt), 0);
}

/**
 * シナリオの d の隣に出す「建ててから N + d 日」（#299）。前の板で建てた足が無い（heldDays が null）なら null。
 * d の丸めは時間レールの現在値（timeRailText）と同じ 2 桁。
 */
export function heldDaysText(heldDays: number | null, days: number): string | null {
  if (heldDays === null || !Number.isFinite(heldDays)) return null;
  const d = Number.isFinite(days) ? days : 0;
  const n = Math.round((heldDays + d) * 100) / 100;
  return `建ててから ${n} 日`;
}

export interface PositionRow {
  id: number;
  kind: 'option' | 'future';
  product: Product;
  productLabel: string;
  /** 限月（YYYY-MM） */
  month: string;
  /** 'P' / 'C'（先物は null） */
  optionType: 'P' | 'C' | null;
  strike: number | null;
  side: Side;
  sideLabel: string;
  qty: number;
  entry: number;
  /** アンカー IV（小数。先物・評価できない足は null） */
  iv: number | null;
  /** IV を編集した（OptionLeg.iv がある） */
  ivEdited: boolean;
  anchorSource: AnchorSource | null;
  /** 足別グリーク（評価できない足は null） */
  greeks: DisplayGreeks | null;
  /** 建値ずれ（円。先物・評価できない足は null） */
  mismatchYen: number | null;
  /** 建値ずれの注記（|建値ずれ| < 1 円なら null） */
  mismatchNote: string | null;
  marks: LegMark[];
  markLabels: string[];
  /** 警告（不安定な IV など） */
  warnings: string[];
  /** SQ 日（YYYY-MM-DD） */
  sqDate: string;
  /**
   * SQ 日を取引カレンダーから求めた足で、その限月の第 2 金曜が確定の最終日より後（休業日未確定）。
   * 板の限月（板の SQ 日を使う）は false
   */
  calendarUnconfirmed: boolean;
  state: LegState | null;
  /** 評価できない理由（読み直した板に限月が無いなど） */
  error: string | null;
  /** 建てた日時（epoch ミリ秒。持たない足は null。#299） */
  openedAt: number | null;
  /** 建てた日（JST の YYYY-MM-DD。持たない足は null） */
  openedDate: string | null;
  /** 建ててから今の板までの暦日（JST。持たない足は null） */
  daysSinceOpen: number | null;
  /** 前の板で建てた足か（openedBeforeBoard） */
  heldBefore: boolean;
  /** 時価評価に使った今の値段（theoretical = スマイルの理論価格・合成先物。使わなかった足は null） */
  heldMark: { price: number; theoretical: boolean } | null;
  /** 含み損益（円 = 符号 × 枚数 × 乗数 × (今の値段 − 建値)。今の値段を使わなかった足は null） */
  unrealizedYen: number | null;
  /** 前の板で建てた足で今の値段が取れない（建値で評価した。OP・板に先物価格の無い先物） */
  markMissing: boolean;
  /** 建てた日時が今の板の時刻より後（古い板を表示している。今の板で入れた足と同じ扱い） */
  openedAfterBoard: boolean;
}

export interface PositionModel {
  rows: PositionRow[];
  ctx: MarketContext;
  prepared: PreparedLeg[];
  /** 前の板で建てた足の「建ててから」の暦日の最大（最も古い足。前の板で建てた足が無ければ null。#299） */
  heldDays: number | null;
}

/** 足の市場を足した MarketContext（板の限月は板を優先）。 */
export function positionContext(chain: Chain, legs: readonly UiLeg[], basis: AtmBasis) {
  const extraOptions: Record<string, OptionExpiryMarket> = {};
  const extraFutures: Record<string, FutureMarket> = {};
  for (const l of legs) {
    if (l.optionMarket) extraOptions[l.optionMarket.expiry] = l.optionMarket.market;
    if (l.futureMarket) extraFutures[l.futureMarket.contract] = l.futureMarket.market;
  }
  return buildMarketContext(chain, { atmBasis: basis, extraOptions, extraFutures });
}

/** 限月 'YYYY-MM' の第 2 金曜が確定の最終日以前か（形が違えば未確定）。 */
function confirmed(calendar: Calendar, month: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m !== null && isExpiryConfirmed(calendar, Number(m[1]), Number(m[2]));
}

function sqOf(chain: Chain, ui: UiLeg, ctx: MarketContext, calendar: Calendar) {
  const leg = ui.leg;
  if (leg.kind === 'option') {
    const m = monthOf(chain, leg.expiry);
    if (m) return { sqDate: m.sqDate, calendarUnconfirmed: false };
    const mk = ctx.options[leg.expiry];
    return {
      sqDate: fmtDate(mk ? mk.sqTime : null),
      calendarUnconfirmed: !confirmed(calendar, leg.expiry),
    };
  }
  if (leg.contract === chain.future.id) {
    return { sqDate: chain.future.sqDate, calendarUnconfirmed: false };
  }
  const m = monthOf(chain, leg.contract);
  if (m) return { sqDate: m.sqDate, calendarUnconfirmed: false };
  const mk = ctx.futures[leg.contract];
  return {
    sqDate: fmtDate(mk ? mk.sqTime : null),
    calendarUnconfirmed: !confirmed(calendar, leg.contract),
  };
}

const finite = (v: number) => Number.isFinite(v);

export function positionModel(
  chain: Chain,
  legs: readonly UiLeg[],
  basis: AtmBasis,
  calendar: Calendar,
  settings: ModelSettings = DEFAULT_SETTINGS,
): PositionModel {
  const ctx = positionContext(chain, legs, basis);
  const prepared: Array<PreparedLeg | null> = [];
  const errors: Array<string | null> = [];
  const marks: Array<MarkPrice | null> = [];
  for (const ui of legs) {
    const mark = heldMarkOf(chain, ui, ctx, settings);
    marks.push(mark);
    try {
      prepared.push(prepareLeg(ui.leg, ctx, settings, mark?.price));
      errors.push(null);
    } catch {
      prepared.push(null);
      errors.push(
        ui.leg.kind === 'option'
          ? `板に無い限月（${ui.leg.expiry}）。足を消すか板を読み直す`
          : `先物の市場が無い（${ui.leg.contract}）`,
      );
    }
  }
  const ok = prepared.filter((p): p is PreparedLeg => p !== null);
  const evaluation = evaluatePosition(ok, ZERO_SCENARIO, ctx, settings);
  let heldDays: number | null = null;
  let j = 0;
  const rows = legs.map((ui, i): PositionRow => {
    const leg = ui.leg;
    const p = prepared[i] ?? null;
    const e = p ? evaluation.legs[j++] : undefined;
    const opt = p?.option;
    const heldBefore = openedBeforeBoard(leg, chain);
    const openedAt = leg.openedAt ?? null;
    const since = openedAt === null ? null : daysSinceOpen(openedAt, chain.snapshotAt);
    if (heldBefore && since !== null) heldDays = Math.max(heldDays ?? 0, since);
    const used = p && p.mark !== null ? p.mark : null;
    const mk = marks[i] ?? null;
    const heldMark =
      used !== null ? { price: used, theoretical: mk ? mk.theoretical : false } : null;
    const unrealizedYen =
      p && used !== null
        ? // || 0: −0 を 0 にする
          p.sign * leg.qty * p.multiplier * (used - leg.entry) || 0
        : null;
    const markMissing = heldBefore && p !== null && mk === null;
    const mismatchYen =
      p && opt && finite(opt.mismatch)
        ? // || 0: −0 を 0 にする
          -p.sign * opt.mismatch * p.multiplier * leg.qty || 0
        : null;
    const showNote = mismatchYen !== null && Math.abs(mismatchYen) >= MISMATCH_EPS_YEN && opt;
    const g = e?.display ?? null;
    const greeks =
      g &&
      finite(g.deltaLarge) &&
      finite(g.gammaPer100) &&
      finite(g.thetaPerDay) &&
      finite(g.vegaPerPt)
        ? g
        : null;
    const warnings: string[] = [];
    if (ui.marks.includes('unstable_iv')) {
      warnings.push('IV 不安定な行（IV の精度が低い。損益・グリークは目安）');
    }
    if (ui.marks.includes('no_quote')) warnings.push('気配なし（建値は既定の手入力値）');
    const sq = sqOf(chain, ui, ctx, calendar);
    return {
      id: ui.id,
      kind: leg.kind,
      product: leg.product,
      productLabel: PRODUCT_LABEL[leg.product],
      month: leg.kind === 'option' ? leg.expiry : leg.contract,
      optionType: leg.kind === 'option' ? (leg.type === 'put' ? 'P' : 'C') : null,
      strike: leg.kind === 'option' ? leg.strike : null,
      side: leg.side,
      sideLabel: SIDE_LABEL[leg.side],
      qty: leg.qty,
      entry: leg.entry,
      iv: opt && finite(opt.anchor) ? opt.anchor : null,
      ivEdited: leg.kind === 'option' && leg.iv !== undefined,
      anchorSource: opt?.anchorSource ?? null,
      greeks,
      mismatchYen,
      mismatchNote:
        showNote && opt
          ? (heldMark ? MARK_MISMATCH_NOTE : MISMATCH_NOTE)[opt.anchorSource] || null
          : null,
      marks: ui.marks,
      markLabels: ui.marks.map((m) => LEG_MARK_LABEL[m]),
      warnings,
      sqDate: sq.sqDate,
      calendarUnconfirmed: sq.calendarUnconfirmed,
      state: e?.state ?? null,
      error: errors[i] ?? null,
      openedAt,
      openedDate: openedAt === null ? null : fmtDate(openedAt),
      daysSinceOpen: since,
      heldBefore,
      heldMark,
      unrealizedYen,
      markMissing,
      openedAfterBoard: openedAt !== null && openedAt > chain.snapshotAt,
    };
  });
  return { rows, ctx, prepared: ok, heldDays };
}

/**
 * 前の板で建てた足の今の値段（今の板で入れた足・建てた日時の無い足は null = 建値から評価）。
 * OP は保存一覧の評価損益と同じ markPrice（両側気配の mid、無ければスマイルの理論価格）、先物は評価に使う
 * 先物価格（ctx.futures。シナリオ 0 の評価価格 = 今の値段）。板に先物価格が無い先物の足（印「先物価格なし」。
 * 足の市場の価格 = 建値で代用している）は今の値段なし（保存一覧の markPrice も評価できない）。
 */
function heldMarkOf(
  chain: Chain,
  ui: UiLeg,
  ctx: MarketContext,
  settings: ModelSettings,
): MarkPrice | null {
  const leg = ui.leg;
  if (!openedBeforeBoard(leg, chain)) return null;
  if (leg.kind === 'future') {
    if (ui.marks.includes('no_price')) return null;
    const m = ctx.futures[leg.contract];
    if (!m || !Number.isFinite(m.price)) return null;
    // 板の先物の限月は板の価格、それ以外（限月違い・先物価格なし）は足の市場の価格（合成先物か建値）
    return { price: m.price, theoretical: leg.contract !== chain.future.id };
  }
  return markPrice(chain, leg, settings.tMin);
}

// ---------------------------------------------------------------- 1 行の簡易表示（#62）

/** 1 行の文言の売買（1 文字） */
export const SIDE_SHORT: Record<Side, string> = { buy: '買', sell: '売' };

/** 行に出す印の短縮ラベル（全文は詳細に LEG_MARK_LABEL で出す） */
export const LEG_MARK_SHORT: Record<LegMark, { text: string; warn: boolean }> = {
  no_board: { text: '手入力', warn: false },
  no_quote: { text: '気配なし', warn: true },
  unstable_iv: { text: 'IV 不安定', warn: true },
  extrapolated: { text: '外挿', warn: false },
  interpolated: { text: '補間', warn: false },
  forward_from_future: { text: 'F 代用', warn: false },
  future_manual: { text: '建値手入力', warn: false },
  no_price: { text: '価格なし', warn: true },
};

/** 前の板で建てた足で今の値段が取れない（建値で評価した）印（#299。全文は詳細の MARK_MISSING_TEXT） */
export const MARK_MISSING_SHORT = '今の値段なし';
export const MARK_MISSING_TEXT = '今の値段が取れない（建値で評価。含み損益は出さない）';

/** 建値: 整数は桁区切り、小数は小数第 2 位まで（末尾の 0 は付けない。丸めて別の値に見せない）。 */
export function fmtEntry(v: number): string {
  if (Number.isInteger(v)) return fmtNum(v);
  const frac = String(v).split('.')[1] ?? '';
  return fmtNum(v, Math.min(2, Math.max(1, frac.length)));
}

/** 1 行の文言（OP `売 P 64,000 ×1 @810`、先物 `ミニ先物 2026-12 買 ×1 @67,880`）。 */
export function legSummary(row: PositionRow): string {
  const tail = `×${fmtNum(row.qty)} @${fmtEntry(row.entry)}`;
  return row.kind === 'option'
    ? `${SIDE_SHORT[row.side]} ${row.optionType} ${fmtNum(row.strike)} ${tail}`
    : `${row.productLabel} ${row.month} ${SIDE_SHORT[row.side]} ${tail}`;
}

/** 足の名前（ボタンの aria-label 用。売買を含めない＝切り替えても名前が変わらない）。 */
export function legName(row: PositionRow): string {
  return row.kind === 'option'
    ? `${row.month} ${row.optionType} ${fmtNum(row.strike)}`
    : `${row.productLabel} ${row.month}`;
}

/** 行に小さく出す印（全文は詳細）。 */
export function legBadges(row: PositionRow): { text: string; warn: boolean }[] {
  const out = row.marks.map((m) => LEG_MARK_SHORT[m]);
  if (row.ivEdited) out.push({ text: 'IV 編集', warn: false });
  if (row.calendarUnconfirmed) out.push({ text: '休業日未確定', warn: false });
  if (row.markMissing) out.push({ text: MARK_MISSING_SHORT, warn: true });
  if (row.error) out.push({ text: 'エラー', warn: true });
  return out;
}

/** 枚数 ±1（parseQty と同じ範囲。範囲外は null）。 */
export function stepQty(qty: number, delta: 1 | -1): number | null {
  const r = parseQty(String(qty + delta));
  return r.ok ? r.value : null;
}

/** 売買の切り替え */
export function toggledSide(side: Side): Side {
  return side === 'buy' ? 'sell' : 'buy';
}

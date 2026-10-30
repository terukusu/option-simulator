/**
 * 保有ポジションの一覧（#302。設計 docs/design.md 13.4「保有ポジションの一覧」）の表示モデル（純関数。DOM・時計を読まない）。
 *
 * - 対象: 保有の印のあるタブ（作業中・退避。帯の順）と、保存一覧の保有の項目（読めた項目だけ。一覧の順 = 新しい順）
 * - 同じ玉の判定は足の指紋（商品・限月・K・種別・売買・建値・建てた日時。枚数・IV の編集・mid は入れない）で行う
 *   （bookKey はシナリオを含むので使わない）。足の組（枚数込み・順不同）が先の行と全く同じなら行にせず先の行にタグ、
 *   指紋が 1 本でも重なれば行に出して合計に入れない、ほかは合計に入れる。足 0 本の保有のタブは行に出して合計に入れない
 * - 計算の時点は「今」（d = ΔX = Δσ = Δs = 0。β・動き方・IV の入れ方は画面の設定 = 指標の「今」と同じ nowScenario）。
 *   画面のシナリオは入力に無い = シナリオを動かしても値が変わらない
 * - 行: 評価損益（markToBoard = 保存一覧と同じ）・必要証拠金（単独の marginNow。余力は出さない）・Δ（シナリオ 0）
 * - 合計: 合計に入れる行の足を 1 つのポジションにまとめて評価（手数料・basis は作業中の値）。評価損益は行の和。
 *   必要証拠金・余力はまとめたポジションの marginNow（行の和にならない）。追証までの距離は marginLine を後で作る
 *   （total.line を useMarginLineState に渡し、distanceText で整形する）
 *
 * 呼ぶのは開いている間だけ描くダイアログ（ui/next/HoldingsDialog.tsx）の memo だけ（AC11）。
 */

import type { Calendar, Chain } from '../../data';
import {
  type AtmBasis,
  evaluatePosition,
  type Leg,
  type MarginParams,
  type ModelSettings,
  type PreparedLeg,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import type { BookRead } from '../book';
import type { MetricsUnitSetting, State, TabSlot, UiLeg } from '../state';
import { MAX_TABS } from '../state';
import {
  type BookTag,
  entryMonths,
  evalLegs,
  type MarkResult,
  markToBoard,
  refreshedLegs,
  settingsOf,
} from './bookList';
import { DASH, fmtDateTime, fmtNum, fmtSigned } from './format';
import { type MarginLineInput, marginNow } from './margin';
import { AMOUNT_UNIT_LABEL, type AmountUnit, amountUnit, fmtAmount } from './metrics';
import { ROOM_NO_CAPITAL_TEXT } from './metricsPanel';
import { type PnlBase, pnlDomains } from './pnlChart';
import { daysSinceOpen, positionContext } from './position';
import { TABS_FULL_TEXT } from './tabs';

// ---------------------------------------------------------------- 対象と同じ玉の判定（板に依らない）

type StoredLeg = Omit<UiLeg, 'id'>;

/** 一覧の源（保有のタブ / 保存一覧の保有の項目） */
export type HoldingSource =
  | {
      kind: 'tab';
      tabId: number;
      name: string;
      /** 作業中のタブ */
      active: boolean;
      /** 作業中は state.legs（市場は state のまま）、退避は saved の足 */
      legs: readonly StoredLeg[];
    }
  | {
      kind: 'book';
      entryId: string;
      name: string;
      legs: readonly StoredLeg[];
      /** その項目の手数料・basis（保存一覧の要約と同じ） */
      feePerLot: number;
      futureBasis: ModelSettings['futureBasis'];
    };

/** 源の列: 保有のタブ（帯の順）→ 保存一覧の保有の項目（一覧の順）。読めない・新しい版・印なしは入れない */
export function holdingSources(
  tabs: readonly TabSlot[],
  activeTab: number,
  legs: readonly UiLeg[],
  read: BookRead,
): HoldingSource[] {
  const out: HoldingSource[] = [];
  for (const t of tabs) {
    if (t.held !== true) continue;
    const active = t.id === activeTab;
    const tabLegs = active ? legs : (t.saved?.legs ?? []);
    out.push({ kind: 'tab', tabId: t.id, name: t.name, active, legs: tabLegs });
  }
  if (read.kind !== 'ok') return out;
  for (const e of read.book.entries) {
    if (e.status !== 'ok' || e.ws.position.held !== true) continue;
    out.push({
      kind: 'book',
      entryId: e.id,
      name: e.name,
      legs: e.ws.position.legs,
      feePerLot: e.ws.ui.feePerLot,
      futureBasis: e.ws.ui.futureBasis,
    });
  }
  return out;
}

/** 足の指紋（決定的な JSON）: 商品・限月・K・種別・売買・建値・建てた日時。枚数・IV の編集・mid は入れない */
export function legFingerprint(leg: Leg): string {
  const o = leg.openedAt ?? null;
  return leg.kind === 'option'
    ? JSON.stringify({
        p: leg.product,
        e: leg.expiry,
        t: leg.type,
        k: leg.strike,
        s: leg.side,
        x: leg.entry,
        o,
      })
    : JSON.stringify({ p: leg.product, c: leg.contract, s: leg.side, x: leg.entry, o });
}

const withQty = (l: StoredLeg) => `${legFingerprint(l.leg)}#${l.leg.qty}`;

/** 足の組が全く同じ（指紋 + 枚数の多重集合が等しい。順不同） */
export function sameLegSet(a: readonly StoredLeg[], b: readonly StoredLeg[]): boolean {
  if (a.length !== b.length) return false;
  const xs = a.map(withQty).sort();
  const ys = b.map(withQty).sort();
  return xs.every((x, i) => x === ys[i]);
}

/** 一覧の行（評価の前） */
export interface HoldingGroup {
  source: HoldingSource;
  /** 合計に入れる */
  counted: boolean;
  /** 同じ玉の判定のタグ（「保存一覧にもある」・重なり・足が無い） */
  tags: BookTag[];
}

/** 重なりのタグの名指し（タブは名前の後に空白、保存一覧は括弧で閉じる） */
const sourceLabel = (s: HoldingSource): string =>
  s.kind === 'tab' ? `タブ ${s.name} ` : `保存一覧の「${s.name}」`;

/**
 * 同じ玉の判定（AC1・2）。順に見て、先の行（表示した行すべて。合計に入れない行も含む）と足の組が全く同じなら
 * 行にせず先の行にタグ、指紋が 1 本でも重なれば行に出して合計に入れない（最初に重なった先の行を名指し）、ほかは合計に入れる
 */
export function groupHoldings(sources: readonly HoldingSource[]): HoldingGroup[] {
  const rows: Array<HoldingGroup & { prints: Set<string> }> = [];
  for (const source of sources) {
    if (source.legs.length === 0) {
      rows.push({
        source,
        counted: false,
        tags: [{ text: '足が無い', warn: true }],
        prints: new Set(),
      });
      continue;
    }
    const comparable = rows.filter((r) => r.source.legs.length > 0);
    const same = comparable.find((r) => sameLegSet(r.source.legs, source.legs));
    if (same) {
      const text = source.kind === 'book' ? '保存一覧にもある' : `タブ ${source.name} にもある`;
      if (!same.tags.some((t) => t.text === text)) same.tags.push({ text, warn: false });
      continue;
    }
    const mine = source.legs.map((l) => legFingerprint(l.leg));
    const prints = new Set(mine);
    const tags: BookTag[] = [];
    let counted = true;
    for (const r of comparable) {
      const n = mine.filter((f) => r.prints.has(f)).length;
      if (n === 0) continue;
      counted = false;
      tags.push({ text: `${sourceLabel(r.source)}と同じ足 ${n} 本・合計に入れない`, warn: true });
      break;
    }
    rows.push({ source, counted, tags, prints });
  }
  return rows.map(({ prints: _p, ...g }) => g);
}

/**
 * 合計に入れる行のうち作業中のタブ以外の数（AI の position.other_held。#302）。足の比較だけで評価しない（板が無くても数える）
 */
export function otherHeldCount(
  state: Pick<State, 'tabs' | 'activeTab' | 'legs'>,
  read: BookRead,
): number {
  return groupHoldings(holdingSources(state.tabs, state.activeTab, state.legs, read)).filter(
    (g) => g.counted && !(g.source.kind === 'tab' && g.source.active),
  ).length;
}

// ---------------------------------------------------------------- 表示モデル

export interface HoldingsInput {
  chain: Chain | null;
  tabs: readonly TabSlot[];
  activeTab: number;
  /** 作業中のタブの足（state.legs） */
  legs: readonly UiLeg[];
  read: BookRead;
  atmBasis: AtmBasis;
  calendar: Calendar;
  /** 作業中の手数料・basis（タブの行と合計） */
  feePerLot: number;
  futureBasis: ModelSettings['futureBasis'];
  unitSetting: MetricsUnitSetting;
  /** 今（d = ΔX = Δσ = Δs = 0。β・動き方・IV の入れ方は画面の設定。useAppController の nowScenario） */
  nowScenario: Scenario;
  params: MarginParams;
  /** 資金（円。未設定なら null） */
  capital: number | null;
}

/** 行の操作 */
export type HoldingAction =
  /** そのタブに切り替える（作業中のタブの行には無い） */
  | { kind: 'switchTab'; tabId: number }
  /** 保存一覧の [新しいタブで開く] と同じ（印ごと）。disabled = 押せない理由 */
  | { kind: 'openNewTab'; entryId: string; disabled: string | null };

export interface HoldingRowView {
  /** 画面の key（tab:<id> / book:<id>） */
  key: string;
  name: string;
  tags: BookTag[];
  counted: boolean;
  months: string;
  legs: string;
  /** 建ててから N 日（無ければ —） */
  heldText: string;
  markText: string;
  markNote: string | null;
  marginText: string;
  /** 必要証拠金・Δ の注記（一部の足を除く） */
  note: string | null;
  deltaText: string;
  action: HoldingAction | null;
  /** 数値（円・枚。表示の前の値 = テストの照合用。板が無い・評価できなければ null） */
  values: HoldingValues;
}

export interface HoldingValues {
  mark: number | null;
  margin: number | null;
  deltaLarge: number | null;
  deltaMini: number | null;
  /** 建ててからの日数 */
  heldDays: number | null;
}

export interface HoldingsTotalView {
  /** 合計に入れた行の数 */
  count: number;
  markText: string;
  markNote: string | null;
  marginText: string;
  roomText: string;
  /** 今すでに余力 < 0（文字でも出す） */
  roomWarn: boolean;
  deltaText: string;
  note: string | null;
  /** 追証までの距離が決まっている文（資金なし・余力 < 0・板なし）。null なら line から作る */
  distanceFixed: string | null;
  /** 追証の線の入力（資金あり ∧ 余力 ≥ 0 のときだけ） */
  line: MarginLineInput | null;
  /** 今の原資産 X₀（距離の % の基準） */
  x0: number | null;
  /** 数値（余力は room。テストの照合用） */
  values: Omit<HoldingValues, 'heldDays'> & { room: number | null };
}

export interface HoldingsView {
  empty: boolean;
  unit: AmountUnit;
  unitLabel: string;
  /** 今の板の時刻（板が無ければ null） */
  boardText: string | null;
  rows: HoldingRowView[];
  /** 合計の行（合計に入れる行が 1 つ以上のときだけ） */
  total: HoldingsTotalView | null;
}

export const HOLDINGS_EMPTY_TEXT =
  '保有の印の付いたポジションが無い（作業中のタブをもう一度押す → 保有にする）';
export const NO_BOARD_VALUE = `${DASH}（板を読むと出る）`;
export const TOTAL_LABEL = '保有全部';
export const DISTANCE_PENDING = '計算中…';
export const DISTANCE_NONE = '範囲内に追証なし';
export const DISTANCE_CALL_NOW = '今 追証の側';

/** Δ の文（指標の Δ と同じ桁） */
const deltaText = (large: number, mini: number) =>
  `${fmtSigned(large, 3)} 枚（ミニ ${fmtSigned(mini, 2)}）`;

/** 評価損益の文と注記（保存一覧と同じ文） */
function markTexts(m: MarkResult | null, unit: AmountUnit): { text: string; note: string | null } {
  if (!m) return { text: NO_BOARD_VALUE, note: null };
  if (m.pnl === null) return { text: DASH, note: `今の板で値の無い足 ${m.missing} 本` };
  return { text: fmtAmount(m.pnl, unit, true), note: m.theoretical ? '理論値を含む' : null };
}

interface RowEval {
  legs: readonly UiLeg[];
  /** 評価できた足（合計で作り直さずに使う。準備は手数料・basis に依らない） */
  prepared: readonly PreparedLeg[];
  mark: MarkResult;
  base: PnlBase | null;
  margin: number | null;
  delta: { large: number; mini: number } | null;
  offBoard: number;
  excluded: number;
  heldDays: number | null;
}

function evalRow(
  chain: Chain,
  g: HoldingGroup,
  input: HoldingsInput,
  working: ModelSettings,
): RowEval {
  const s = g.source;
  const settings = s.kind === 'book' ? settingsOf(s.feePerLot, s.futureBasis) : working;
  const legs: readonly UiLeg[] =
    s.kind === 'tab' && s.active ? input.legs : refreshedLegs(chain, s.legs, input.calendar);
  const { pm, base } = evalLegs(chain, legs, input.atmBasis, input.calendar, settings);
  const calc = base
    ? marginNow(base, input.nowScenario, input.params, null, input.calendar.holidays)
    : null;
  const total = base ? evaluatePosition(base.legs, ZERO_SCENARIO, base.ctx, settings).total : null;
  let oldest: number | null = null;
  for (const l of s.legs) {
    const o = l.leg.openedAt;
    if (o !== undefined && (oldest === null || o < oldest)) oldest = o;
  }
  return {
    legs,
    prepared: pm.prepared,
    mark: markToBoard(
      chain,
      s.legs.map((l) => l.leg),
      settings.feePerLot,
    ),
    base,
    margin: calc ? calc.result.margin : null,
    delta: total ? { large: total.deltaLarge, mini: total.deltaMini } : null,
    offBoard: pm.rows.filter((r) => r.error !== null).length,
    excluded: s.legs.length - (base?.legs.length ?? 0),
    heldDays: oldest === null ? null : daysSinceOpen(oldest, chain.snapshotAt),
  };
}

function actionOf(s: HoldingSource, tabCount: number): HoldingAction | null {
  if (s.kind === 'tab') return s.active ? null : { kind: 'switchTab', tabId: s.tabId };
  return {
    kind: 'openNewTab',
    entryId: s.entryId,
    disabled: tabCount >= MAX_TABS ? TABS_FULL_TEXT : null,
  };
}

/** 一覧の表示モデル（開いている間だけ。HoldingsDialog の memo） */
export function holdingsModel(input: HoldingsInput): HoldingsView {
  const { chain } = input;
  const groups = groupHoldings(holdingSources(input.tabs, input.activeTab, input.legs, input.read));
  const working = settingsOf(input.feePerLot, input.futureBasis);
  const evals = chain
    ? groups.map((g) => (g.source.legs.length > 0 ? evalRow(chain, g, input, working) : null))
    : [];
  // 合計（合計に入れる行の足をまとめた 1 つのポジション）
  const countedIdx = groups.flatMap((g, i) => (g.counted ? [i] : []));
  let totalEval: {
    base: PnlBase | null;
    margin: number | null;
    room: number | null;
    delta: { large: number; mini: number } | null;
    mark: number | null;
    theoretical: boolean;
    excluded: number;
    legCount: number;
  } | null = null;
  if (chain && countedIdx.length > 0) {
    // 行の準備済みの足をつなぐ（準備は手数料・basis に依らない = 1 つのタブに全部の足を入れて評価したのと同じ）。
    // 市場（手入力の限月など）は全部の足から集め直す
    const legs = countedIdx.flatMap((i) => evals[i]?.legs ?? []);
    const prepared = countedIdx.flatMap((i) => evals[i]?.prepared ?? []);
    const ctx = positionContext(chain, legs, input.atmBasis);
    const base = pnlDomains(chain, prepared, ctx, working);
    const calc = base
      ? marginNow(base, input.nowScenario, input.params, input.capital, input.calendar.holidays)
      : null;
    const t = base ? evaluatePosition(base.legs, ZERO_SCENARIO, base.ctx, working).total : null;
    let mark: number | null = 0;
    let theoretical = false;
    for (const i of countedIdx) {
      const m = evals[i]?.mark;
      theoretical ||= m?.theoretical === true;
      mark = m && m.pnl !== null && mark !== null ? mark + m.pnl : null;
    }
    totalEval = {
      base,
      margin: calc ? calc.result.margin : null,
      room: calc ? calc.room : null,
      delta: t ? { large: t.deltaLarge, mini: t.deltaMini } : null,
      mark,
      theoretical,
      excluded: legs.length - (base?.legs.length ?? 0),
      legCount: legs.length,
    };
  }
  // 単位: 評価損益・必要証拠金・余力の最大の絶対値（保存一覧と同じ規則 = 10 万円以上なら千円）
  let maxAbs = 0;
  for (const e of evals) {
    if (!e) continue;
    maxAbs = Math.max(maxAbs, Math.abs(e.mark.pnl ?? 0), Math.abs(e.margin ?? 0));
  }
  // 合計の必要証拠金・余力・評価損益も（資金が大きいと余力が円で長くならないように）
  if (totalEval) {
    for (const v of [totalEval.margin, totalEval.room, totalEval.mark]) {
      if (v !== null && Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }
  const unit = amountUnit(Number.isFinite(maxAbs) ? maxAbs : 0, 0, input.unitSetting);
  const tabCount = input.tabs.length;

  const rows = groups.map((g, i): HoldingRowView => {
    const s = g.source;
    const e = evals[i] ?? null;
    const legsStored = s.legs.map((l) => l.leg);
    const kindTag: BookTag =
      s.kind === 'book'
        ? { text: '保存一覧', warn: false }
        : { text: s.active ? '作業中のタブ' : 'タブ', warn: false };
    const tags: BookTag[] = [kindTag, ...g.tags];
    if (e && e.offBoard > 0) tags.push({ text: `板に無い足 ${e.offBoard}`, warn: true });
    const mark = markTexts(chain && e ? e.mark : null, unit);
    const noValue = !chain || !e;
    return {
      key: s.kind === 'tab' ? `tab:${s.tabId}` : `book:${s.entryId}`,
      name: s.name,
      tags,
      counted: g.counted,
      months: s.legs.length > 0 ? entryMonths(legsStored) : DASH,
      legs: `足 ${s.legs.length} 本`,
      heldText: `建ててから ${e?.heldDays === null || !e ? DASH : `${fmtNum(e.heldDays)} 日`}`,
      markText: s.legs.length === 0 ? DASH : mark.text,
      markNote: mark.note,
      marginText: s.legs.length === 0 ? DASH : noValue ? NO_BOARD_VALUE : fmtAmount(e.margin, unit),
      note: e && e.excluded > 0 ? `一部の足を除く（${e.excluded} 本）` : null,
      deltaText:
        s.legs.length === 0
          ? DASH
          : noValue
            ? NO_BOARD_VALUE
            : e.delta
              ? deltaText(e.delta.large, e.delta.mini)
              : DASH,
      action: actionOf(s, tabCount),
      values: {
        mark: e ? e.mark.pnl : null,
        margin: e ? e.margin : null,
        deltaLarge: e?.delta ? e.delta.large : null,
        deltaMini: e?.delta ? e.delta.mini : null,
        heldDays: e ? e.heldDays : null,
      },
    };
  });

  let total: HoldingsTotalView | null = null;
  if (countedIdx.length > 0) {
    if (!chain || !totalEval) {
      total = {
        count: countedIdx.length,
        markText: NO_BOARD_VALUE,
        markNote: null,
        marginText: NO_BOARD_VALUE,
        roomText: NO_BOARD_VALUE,
        roomWarn: false,
        deltaText: NO_BOARD_VALUE,
        note: null,
        distanceFixed: NO_BOARD_VALUE,
        line: null,
        x0: null,
        values: { mark: null, margin: null, deltaLarge: null, deltaMini: null, room: null },
      };
    } else {
      const t = totalEval;
      const capital = input.capital;
      const roomWarn = capital !== null && t.room !== null && t.room < 0;
      const markNote =
        t.mark === null ? '値の無い足を含む行がある' : t.theoretical ? '理論値を含む' : null;
      let distanceFixed: string | null = null;
      let line: MarginLineInput | null = null;
      if (capital === null) distanceFixed = ROOM_NO_CAPITAL_TEXT;
      else if (!t.base || t.room === null) distanceFixed = DASH;
      else if (t.room < 0) distanceFixed = DISTANCE_CALL_NOW;
      else
        line = {
          base: t.base,
          scenario: input.nowScenario,
          params: input.params,
          capital,
          holidays: input.calendar.holidays,
        };
      total = {
        count: countedIdx.length,
        markText: fmtAmount(t.mark, unit, true),
        markNote,
        marginText: fmtAmount(t.margin, unit),
        roomText: capital === null ? ROOM_NO_CAPITAL_TEXT : fmtAmount(t.room, unit, true),
        roomWarn,
        deltaText: t.delta ? deltaText(t.delta.large, t.delta.mini) : DASH,
        note: t.excluded > 0 ? `一部の足を除く（${t.excluded} 本）` : null,
        distanceFixed,
        line,
        x0: t.base ? t.base.ctx.x0 : null,
        values: {
          mark: t.mark,
          margin: t.margin,
          deltaLarge: t.delta ? t.delta.large : null,
          deltaMini: t.delta ? t.delta.mini : null,
          room: t.room,
        },
      };
    }
  }
  return {
    empty: groups.length === 0,
    unit,
    unitLabel: AMOUNT_UNIT_LABEL[unit],
    boardText: chain ? fmtDateTime(chain.snapshotAt) : null,
    rows,
    total,
  };
}

// ---------------------------------------------------------------- 追証までの距離

const pctText = (level: number, x0: number) => {
  const pct = ((level - x0) / x0) * 100;
  return `${fmtSigned(pct, 1)}%（${fmtNum(level)} 円）`;
};

/**
 * 追証までの距離の文の部分（AC5）。levels = 追証の線（marginLine。null = 計算中）。下 = X₀ 以下で最も近い水準、上 = X₀ を
 * 超えて最も近い水準。% = (水準 − X₀) / X₀ × 100（小数 1 桁・符号つき）。画面は部分ごとに折り返さない
 */
export function distanceParts(x0: number | null, levels: readonly number[] | null): string[] {
  if (levels === null) return [DISTANCE_PENDING];
  if (x0 === null || !Number.isFinite(x0) || x0 <= 0) return [DASH];
  if (levels.length === 0) return [DISTANCE_NONE];
  let below: number | null = null;
  let above: number | null = null;
  for (const l of levels) {
    if (l <= x0) below = below === null ? l : Math.max(below, l);
    else above = above === null ? l : Math.min(above, l);
  }
  return [
    `下 ${below === null ? 'なし' : pctText(below, x0)}`,
    `上 ${above === null ? 'なし' : pctText(above, x0)}`,
  ];
}

/** 追証までの距離の文（`下 −8.3%（X 円）· 上 +15.2%（Y 円）` の形。値は架空） */
export function distanceText(x0: number | null, levels: readonly number[] | null): string {
  return distanceParts(x0, levels).join(' · ');
}

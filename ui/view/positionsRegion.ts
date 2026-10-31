/**
 * 新しい画面のポジションの領域（#84。docs/ui-redesign.md §2・§3・§4.4・§5.2・§9・§11 決定 8）の表示モデル（純関数）。
 * 部品は ui/next/regions/Positions.tsx・LegDialog.tsx・HedgeDialog.tsx。
 *
 * - 行・詳細の値は ui/view/position.ts の positionModel の行を並べ直すだけ（数値を作り直さない）
 * - 足別のシナリオ点は metrics.scenarioPoint.legs（損益グラフの基礎 base.legs と同じ並び）を、行 → prepared →
 *   base.legs の参照で対応させる（base.legs は prepared のうち F が有限の足だけなので、添字はずれうる）
 * - スプレッドコストは足 1 本の model/ の premiumSummary（新しい式を作らない）
 * - × / 全クリアの [元に戻す] は既存の restoreLeg の列（新しい action を足さない）
 * - 足の追加フォームの検証は reducer と同じ関数（futureLeg / manualOptionLeg）を同じ引数で先に呼ぶ
 *
 * 副作用なし（時刻・乱数・DOM・localStorage を読まない）。data/ の例外は捕まえて値で返す。
 * 単位: 金額は円（表示は metrics.unit）、Δ はラージ換算（枚）とミニ換算、IV は小数（表示は %）。
 */

import { type Chain, type FutureLegInput, futureLeg, manualOptionLeg } from '../../data';
import {
  type FutureProduct,
  type Holidays,
  type Leg,
  type LegState,
  type ModelSettings,
  type OptionType,
  type PreparedLeg,
  premiumSummary,
  type Side,
} from '../../model';
import { rebaseLegs } from '../legRebase';
import {
  type Action,
  activeHeld,
  parseContract,
  parseEntry,
  parseIvPct,
  parseQty,
  parseStrike,
  QTY_MAX,
  type State,
} from '../state';
import { FAIR_LABEL, type FairView, fairView } from './fairValue';
import { DASH, fmtIv, fmtNum, fmtSigned } from './format';
import { HEDGE_AT_LABEL, HEDGE_REASON_LABEL, type HedgeModel, type HedgeProduct } from './hedge';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  fmtAmount,
  type LegMetrics,
  type MetricsModel,
} from './metrics';
import { type NewTabUndo, newTabPlan } from './newTab';
import type { PnlBase } from './pnlChart';
import {
  fmtEntry,
  legBadges,
  legName,
  legSummary,
  MARK_MISSING_TEXT,
  type PositionModel,
  type PositionRow,
  PRODUCT_LABEL,
  SIDE_LABEL,
  SIDE_SHORT,
  toggledSide,
} from './position';
import type { StepSpec } from './stepper';
import type { Toast } from './toast';

// ---------------------------------------------------------------- 枚数のステッパー

/**
 * 枚数のステッパーの仕様（parseQty の範囲 1〜100,000・1 段）。def = 今の値（枚数に既定値は無いので .hot にしない）。
 * 範囲の端では stepBy が端の値を返し、Stepper はその方向のボタンを disabled にする（stepQty の null と同じ）。
 */
export function qtySpec(qty: number): StepSpec {
  return { min: 1, max: QTY_MAX, step: 1, def: qty };
}

// ---------------------------------------------------------------- 行

export interface LegRowView {
  id: number;
  side: Side;
  /** 売買バッジ（色だけに頼らず文字で出す） */
  badge: '売' | '買';
  /** 名前（OP `P 64,000`、先物 `ミニ先物`） */
  title: string;
  /** `@` + fmtEntry */
  entry: string;
  sub: {
    month: string;
    /** IV（%、1 桁、% は付けない。先物・求められなければ null） */
    iv: string | null;
    /** Δ（ラージ換算 2 桁、符号つき。求められなければ —） */
    delta: string;
  };
  /** 短縮の印（legBadges と同じ並び） */
  badges: { text: string; warn: boolean }[];
  /** 警告・エラーのある足 */
  warn: boolean;
  /** 足の名前（aria-label 用。売買を含めない） */
  name: string;
  /** 1 行の文言（legSummary） */
  summary: string;
  /** 本文のボタンの aria-label（名前・売買・枚数・@建値・印。中身を上書きするので読み上げに要る情報を全部入れる） */
  aria: string;
}

function rowTitle(row: PositionRow): string {
  return row.kind === 'option' ? `${row.optionType} ${fmtNum(row.strike)}` : row.productLabel;
}

/** 本文のボタンの aria-label（`2026-11 P 64,000 売り ×1 @740 IV 編集 の詳細`）。 */
export function legAria(row: PositionRow): string {
  const badges = legBadges(row)
    .map((b) => ` ${b.text}`)
    .join('');
  return `${legName(row)} ${row.sideLabel} ×${fmtNum(row.qty)} @${fmtEntry(row.entry)}${badges} の詳細`;
}

export function legRow(row: PositionRow): LegRowView {
  return {
    id: row.id,
    side: row.side,
    badge: SIDE_SHORT[row.side] as '売' | '買',
    title: rowTitle(row),
    entry: `@${fmtEntry(row.entry)}`,
    sub: {
      month: row.month,
      iv: row.kind === 'option' && row.iv !== null ? fmtIv(row.iv) : null,
      delta: fmtSigned(row.greeks?.deltaLarge, 2),
    },
    badges: legBadges(row),
    warn: row.warnings.length > 0 || row.error !== null,
    name: legName(row),
    summary: legSummary(row),
    aria: legAria(row),
  };
}

/** 行の表示（行数・順は model.rows と同じ）。 */
export function positionRows(model: PositionModel): LegRowView[] {
  return model.rows.map(legRow);
}

/** 行 → prepared（エラーの無い行の順。positionModel の prepared と同じ並び）。エラーの行は null。 */
function preparedByRow(model: PositionModel): (PreparedLeg | null)[] {
  let j = 0;
  return model.rows.map((r) => (r.error === null ? (model.prepared[j++] ?? null) : null));
}

/**
 * 足別のシナリオ点（metrics.scenarioPoint.legs）を行に対応させる。scenarioPoint.legs[i] は base.legs[i]
 * （prepared のうち F が有限の足）なので、参照で引く。エラーの行・base.legs に無い行は null。
 */
export function scenarioLegsByRow(
  model: PositionModel,
  base: PnlBase | null,
  metrics: MetricsModel,
): (LegMetrics | null)[] {
  const byLeg = new Map<PreparedLeg, LegMetrics>();
  if (base && !metrics.empty) {
    base.legs.forEach((p, i) => {
      const m = metrics.scenarioPoint.legs[i];
      if (m) byLeg.set(p, m);
    });
  }
  return preparedByRow(model).map((p) => (p ? (byLeg.get(p) ?? null) : null));
}

/**
 * 足 1 本のスプレッドコスト（円。premiumSummary([prepared]).spreadCost）。OP の足で mid があるときだけ、
 * それ以外（先物・mid なし・エラー）は null。
 */
export function legSpreadCosts(model: PositionModel, settings: ModelSettings): (number | null)[] {
  return preparedByRow(model).map((p) => {
    if (p?.leg.kind !== 'option' || p.leg.mid === null || p.leg.mid === undefined) return null;
    return premiumSummary([p], settings).spreadCost;
  });
}

/**
 * 足 1 本の理論価格（#264。ui/view/fairValue.ts の fairView）。板にある限月・行使価格の OP の足だけ。位置はその行の
 * 板の気配（建値ではない）に対して。先物・板に無い限月 / 行使価格・出せないときは null。
 */
export function legFairValue(chain: Chain | null, row: PositionRow): FairView | null {
  if (!chain || row.kind !== 'option' || row.strike === null || row.optionType === null)
    return null;
  const month = chain.months.find((m) => m.id === row.month);
  const i = month ? month.strikes.findIndex((s) => s.k === row.strike) : -1;
  const q = month?.rows[i];
  if (!month || !q) return null;
  const type = row.optionType === 'P' ? 'put' : 'call';
  return fairView(month, row.strike, type, chain.r, q[type].bid, q[type].ask);
}

// ---------------------------------------------------------------- 詳細

export interface DetailItem {
  key: string;
  label: string;
  value: string;
  /** 値の後ろの小さな印（IV の「編集」・SQ 日の「休業日未確定」） */
  tag?: string;
  /** 説明文（折り返してよい。建値ずれの注記） */
  note?: string;
  /** 入力欄（部品が置く。value は欄の初期の文字列） */
  field?: 'qty' | 'entry' | 'iv';
}

/** グリークの 1 行（#274。部品は parts を ` · ` の区切りで並べ、幅が足りなければ項目の境目で折り返す） */
export interface GreekLine {
  /** 見出し（`グリーク（シナリオ 0）· 円` / `シナリオ点（足別）· 千円`） */
  head: string;
  parts: string[];
}

export interface LegDetailView {
  /** 上段の編集の 3 欄（枚数・建値・IV。先物の IV は —） */
  fields: DetailItem[];
  /** グリーク（シナリオ 0）の 1 行（Δ ラージ（ミニ）・Γ / 100 円・Θ 円 / 日・V 円 / pt） */
  greeks: GreekLine;
  /** 足別のシナリオ点の 1 行（IV・Δ・Γ・Θ・V・状態。求められなければ —） */
  scenario: GreekLine;
  /** 残りの項目（商品・限月・売買・建値ずれ・スプレッドコスト・理論価格・SQ 日） */
  items: DetailItem[];
  /** 印の全文（markLabels・warnings・error。説明文） */
  marks: { text: string; warn: boolean }[];
  /** IV の欄は空欄にできない（手入力の足） */
  ivRequired: boolean;
}

/** 足の状態（旧 Metrics の足別と同じ語。live は出さない） */
export const LEG_STATE_LABEL: Record<LegState, string> = {
  live: '',
  near_expiry: '満期直前',
  expired: '満期',
  settled_flat: '先物は SQ 済み',
  no_forward: 'F なし',
};

function mismatchText(row: PositionRow): string {
  if (row.mismatchYen === null) return DASH;
  return row.mismatchNote ? fmtSigned(row.mismatchYen, 0) : '0';
}

/**
 * 建てた日の文言（`YYYY-MM-DD（N 日前）`、同じ日は `（当日）`、今の板より後（古い板を表示）は `（今の板より後）`。
 * 建てた日時の無い足は null）
 */
export function openedText(row: PositionRow): string | null {
  if (row.openedDate === null || row.daysSinceOpen === null) return null;
  if (row.openedAfterBoard) return `${row.openedDate}（今の板より後）`;
  return row.daysSinceOpen > 0
    ? `${row.openedDate}（${row.daysSinceOpen} 日前）`
    : `${row.openedDate}（当日）`;
}

/** 今の値段の文言（OP は mid / 理論価格、先物は先物価格 / 代用。#299） */
export function heldMarkText(row: PositionRow): string | null {
  const m = row.heldMark;
  if (!m) return null;
  if (row.kind === 'future') return `${fmtEntry(m.price)} · ${m.theoretical ? '代用' : '先物価格'}`;
  // mid は建値と同じ書式、理論価格は 100 円未満だけ小数 1 桁（理論価格の行と同じ）
  return m.theoretical
    ? `${fmtNum(m.price, m.price < 100 ? 1 : 0)} · 理論価格`
    : `${fmtEntry(m.price)} · mid`;
}

/** 詳細の建てた日・今の値段・含み損益の項目（#299） */
function heldItems(row: PositionRow, unit: AmountUnit): DetailItem[] {
  const out: DetailItem[] = [];
  const opened = openedText(row);
  if (opened !== null) out.push({ key: 'opened', label: '建てた日', value: opened });
  const mark = heldMarkText(row);
  if (mark !== null) {
    out.push({ key: 'mark', label: '今の値段', value: mark });
    out.push({
      key: 'unrealized',
      label: `含み損益 ${AMOUNT_UNIT_LABEL[unit]}`,
      value: fmtAmount(row.unrealizedYen, unit, true),
    });
  } else if (row.markMissing) {
    out.push({ key: 'mark', label: '今の値段', value: DASH, note: MARK_MISSING_TEXT });
  }
  return out;
}

/**
 * 行の詳細（項目と書式は旧 Positions の詳細と同じ + スプレッドコスト + 足別のシナリオ点）。#274 で上段に編集の 3 欄、
 * グリーク（シナリオ 0）と足別のシナリオ点をそれぞれ 1 行に畳んだ（2 列の壁にしない）。
 */
export function legDetail(
  row: PositionRow,
  scen: LegMetrics | null,
  spread: number | null,
  unit: AmountUnit,
  fair: FairView | null = null,
): LegDetailView {
  const g = row.greeks;
  const u = AMOUNT_UNIT_LABEL[unit];
  const fields: DetailItem[] = [
    { key: 'qty', label: '枚数', value: String(row.qty), field: 'qty' },
    { key: 'entry', label: '建値', value: String(row.entry), field: 'entry' },
    row.kind === 'option'
      ? {
          key: 'iv',
          label: 'IV %',
          value: fmtIv(row.iv),
          field: 'iv',
          ...(row.ivEdited && { tag: '編集' }),
        }
      : { key: 'iv', label: 'IV %', value: DASH },
  ];
  const greeks: GreekLine = {
    head: 'グリーク（シナリオ 0）· 円',
    parts: [
      `Δ ${fmtSigned(g?.deltaLarge, 3)}（ミニ ${fmtSigned(g?.deltaMini, 2)}）`,
      `Γ ${fmtSigned(g?.gammaPer100, 4)} / 100 円`,
      `Θ ${fmtSigned(g?.thetaPerDay, 0)} / 日`,
      `V ${fmtSigned(g?.vegaPerPt, 0)} / pt`,
    ],
  };
  const items: DetailItem[] = [
    {
      key: 'product',
      label: '商品・限月',
      value:
        row.optionType === null
          ? `${row.productLabel} ${row.month}`
          : `${row.productLabel} ${row.month} ${row.optionType} ${fmtNum(row.strike)}`,
    },
    { key: 'side', label: '売買', value: row.sideLabel },
    // 建てた日・今の値段・含み損益（#299。前の板で建てた足だけ今の値段と含み損益）
    ...heldItems(row, unit),
    {
      key: 'mismatch',
      label: '建値ずれ 円',
      value: mismatchText(row),
      ...(row.mismatchNote && { note: row.mismatchNote }),
    },
    {
      key: 'spread',
      label: `スプレッドコスト ${u}`,
      value: fmtAmount(spread, unit, true),
    },
    {
      // 理論価格（#264）: 100 円未満は小数 1 桁・板の気配の中の位置・使った IV（スマイルの線の IV と違いうる）。外挿は印
      key: 'fair',
      label: FAIR_LABEL,
      value: fair
        ? [fair.price, fair.position, `IV ${fair.iv}`].filter((t) => t !== null).join(' · ')
        : DASH,
      ...(fair?.extrapolated && { tag: '外挿' }),
    },
    {
      key: 'sq',
      label: 'SQ 日',
      value: row.sqDate,
      ...(row.calendarUnconfirmed && { tag: '休業日未確定' }),
    },
  ];
  const d = scen?.display;
  const state = scen ? LEG_STATE_LABEL[scen.state] : '';
  const scenario: GreekLine = {
    head: `シナリオ点（足別）· ${u}`,
    parts: [
      `IV ${scen && scen.sigma !== null ? fmtIv(scen.sigma) : DASH}`,
      `Δ ${fmtSigned(d?.deltaLarge, 3)}`,
      `Γ ${fmtSigned(d?.gammaPer100, 4)}`,
      `Θ ${fmtAmount(d?.thetaPerDay, unit, true)} / 日`,
      `V ${fmtAmount(d?.vegaPerPt, unit, true)} / pt`,
      // 状態は満期直前・満期・SQ 済み・F なしのときだけ（旧 Metrics の足別と同じ。live は出さない）
      ...(state ? [state] : []),
    ],
  };
  const marks = [
    ...row.markLabels.map((m) => ({ text: m, warn: m === 'IV 不安定' })),
    ...row.warnings.map((w) => ({ text: w, warn: true })),
    ...(row.error ? [{ text: row.error, warn: true }] : []),
  ];
  return {
    fields,
    greeks,
    scenario,
    items,
    marks,
    ivRequired: row.marks.includes('no_board'),
  };
}

// ---------------------------------------------------------------- 見出し行

/** 見出しの副題（`2 本`、0 本は `足なし`）。受取 / 掛け金は指標のタイルに 1 つ（#274） */
export function headSub(rowCount: number): string {
  return rowCount === 0 ? '足なし' : `${rowCount} 本`;
}

// ---------------------------------------------------------------- トーストと [元に戻す]

export interface UndoToast {
  kind: string;
  text: string;
  /** 順に reduce に通す action（restoreLeg だけ） */
  undo: Action[];
}

/** × の [元に戻す]: 消す前に足・位置・作業中のタブを控える（足が無ければ null）。 */
export function removeUndo(state: State, row: PositionRow): UndoToast | null {
  const index = state.legs.findIndex((l) => l.id === row.id);
  const leg = state.legs[index];
  if (!leg) return null;
  return {
    kind: `leg-remove-${row.id}`,
    text: `${legSummary(row)} を消した`,
    undo: [{ type: 'restoreLeg', leg, index, expect: null, tab: state.activeTab }],
  };
}

/**
 * 全クリアの [元に戻す]: 足ごとの restoreLeg を元の順に（0 本は null）。保有のタブ（#301）も null（reducer は
 * clearLegs を無視するので、消していない足のトーストを出さない）
 */
export function clearUndo(state: State): UndoToast | null {
  if (state.legs.length === 0 || activeHeld(state)) return null;
  const tab = state.activeTab;
  return {
    kind: 'leg-clear',
    text: `足 ${state.legs.length} 本を消した`,
    undo: state.legs.map((leg, index) => ({
      type: 'restoreLeg' as const,
      leg,
      index,
      expect: null,
      tab,
    })),
  };
}

/** 建値を今の板に合わせる（#298）: 押したときの action と トースト。 */
export interface RebasePlan {
  /**
   * 建て直したとき 'leg-rebase'（[元に戻す] 付き）、建値も建てた日時も 1 本も変わらないとき 'leg-rebase-same'
   */
  kind: 'leg-rebase' | 'leg-rebase-same';
  text: string;
  /**
   * 作業中のタブの足を丸ごと置き換える（建値も建てた日時も 1 本も変わらなければ null = dispatch しない）。
   * 保有のタブ（#301）は建て直した足を新しいタブに入れる openPositionInNewTab（保有のタブの足は変えない）
   */
  apply: Action | null;
  /** [元に戻す]: apply の逆向きの replaceLegs（apply が null・写しなら null） */
  undo: Action | null;
  /** 保有のタブの写し（#301）の [元に戻す] の控え（newTabUndoActions に渡す）。検討中のタブ・apply が null なら null */
  copy: NewTabUndo | null;
}

/**
 * 建値を今の板に合わせる（ui/legRebase.ts）の action とトーストの文（360px で [元に戻す] と並んで切れない長さ）。板が無い・足 0 本・保有のタブでタブが上限は null（押せない）。
 * 建値も建てた日時（#299）も 1 本も変わらなければ dispatch しない（mid・印だけの差は捨てる）。建値が同じでも
 * 前の板で建てた足は建てた日時を今にする（時価評価をやめてシナリオ 0 の損益を 0 に戻す）。[元に戻す] のトーストを
 * 消さないよう、そのときの知らせは別の kind にする（2 回続けて押しても 1 回目を戻せる）。
 * 保有のタブ（#301）は写し: 建て直した足を新しいタブ（印なし）に入れて切り替える（[元に戻す] は copy で足したタブを閉じる）。
 */
export function rebasePlan(state: State): RebasePlan | null {
  if (state.chain === null || state.legs.length === 0) return null;
  const before = state.legs;
  const {
    legs: after,
    changed,
    reopened,
    rebuilt,
    kept,
  } = rebaseLegs(state.chain, before, state.calendar.holidays);
  if (changed === 0 && reopened === 0) {
    return {
      kind: 'leg-rebase-same',
      text:
        kept === 0
          ? '建値は今の板と同じ'
          : kept === before.length
            ? `気配が無く建値を据え置き（${kept} 本）`
            : `建値は今の板と同じ（据え置き ${kept} 本）`,
      apply: null,
      undo: null,
      copy: null,
    };
  }
  if (activeHeld(state)) {
    // 保有のタブ（#301。オーナー判断 2）: 保有のタブはそのまま、建て直した足を写しのタブ（印なし）に入れる。上限なら押せない
    const plan = newTabPlan(state, after);
    if (plan === null) return null;
    return {
      kind: 'leg-rebase',
      text:
        changed === 0
          ? kept === 0
            ? `写しで建てた日時を今に（${reopened} 本）`
            : `写しで建てた日時を今に ${reopened} 本・据え置き ${kept} 本`
          : kept === 0
            ? `写しを新しいタブで建て直した（${rebuilt} 本）`
            : `写しで建て直した ${rebuilt} 本・据え置き ${kept} 本`,
      apply: plan.action,
      undo: null,
      copy: plan.undo,
    };
  }
  const tab = state.activeTab;
  return {
    kind: 'leg-rebase',
    text:
      changed === 0
        ? // 建値は今の板と同じで、建てた日時だけ今にした（前の板で建てた足の時価評価をやめる。#299）
          kept === 0
          ? `建値は同じ・建てた日時を今に（${reopened} 本）`
          : `建てた日時を今に ${reopened} 本・据え置き ${kept} 本`
        : // 本数は建て直した本数（建値が変わった足 + 建値は同じで建てた日時だけ今にした足）
          kept === 0
          ? `建値を今の板に合わせた（${rebuilt} 本）`
          : `建値を合わせた ${rebuilt} 本・据え置き ${kept} 本`,
    apply: { type: 'replaceLegs', legs: after, expect: before.slice(), tab },
    undo: { type: 'replaceLegs', legs: before.slice(), expect: after, tab },
    copy: null,
  };
}

/** 保有のタブの写し（#301）の [元に戻す] ができないときの文（AI の NEW_TAB_UNDO_TEXT と同じ形） */
export const REBASE_COPY_UNDO_TEXT = {
  edited: '写しのタブを編集したので戻しません（タブは × で閉じられます）',
  gone: '写しのタブはもう閉じています',
} as const;

/** ⇄ のトースト（[元に戻す] なし）。 */
export function flipToast(row: PositionRow): { kind: 'leg-flip'; text: string } {
  const name = row.kind === 'option' ? rowTitle(row) : `${row.productLabel} ${row.month}`;
  return {
    kind: 'leg-flip',
    text: `${SIDE_SHORT[toggledSide(row.side)]} ${name} に切替（建値は保持）`,
  };
}

function futureAddText(product: FutureProduct, contract: string, side: Side, qty: number): string {
  return `${PRODUCT_LABEL[product]} ${contract} ${SIDE_SHORT[side]} ×${fmtNum(qty)} を追加`;
}

/** 足の追加のトースト（[元に戻す] なし。× で消せる）。 */
export function addedToast(leg: Leg): { kind: 'leg-add'; text: string } {
  const text =
    leg.kind === 'future'
      ? futureAddText(leg.product, leg.contract, leg.side, leg.qty)
      : `${leg.expiry} ${SIDE_SHORT[leg.side]} ${leg.type === 'put' ? 'P' : 'C'} ${fmtNum(leg.strike)} ×${fmtNum(leg.qty)} を追加`;
  return { kind: 'leg-add', text };
}

/** [元に戻す] の無いトーストと keep 付き（#87）だけを残す（タブの切り替え。消えるものが無ければ同じ参照）。 */
export function dropUndoToasts(list: readonly Toast[]): Toast[] {
  const next = list.filter((t) => !t.undo || t.keep === true);
  return next.length === list.length ? (list as Toast[]) : next;
}

// ---------------------------------------------------------------- 足の追加フォーム

export type LegFormResult =
  | { ok: true; action: Action; toast: string }
  | { ok: false; message: string };

export interface FutureFormValues {
  product: FutureProduct;
  contract: string;
  side: Side;
  qty: string;
  entry: string;
}

export interface OptionFormValues {
  expiry: string;
  type: OptionType;
  k: string;
  side: Side;
  qty: string;
  entry: string;
  iv: string;
}

/** 先物の足の既定値（旧 LegForms と同じ: ミニ・板の先物の限月・買い・1・建値空欄 = 板の先物） */
export function futureFormDefault(chain: Chain): FutureFormValues {
  return { product: 'fut_mini', contract: chain.future.id, side: 'buy', qty: '1', entry: '' };
}

/** 手入力 OP の足の既定値（旧 LegForms と同じ: put・売り・1） */
export const OPTION_FORM_DEFAULT: OptionFormValues = {
  expiry: '',
  type: 'put',
  k: '',
  side: 'sell',
  qty: '1',
  entry: '',
  iv: '',
};

/** reducer の errorText と同じ文言 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '足を追加できない';
}

/**
 * 先物の足の追加: 旧 LegForms と同じ順のパース（限月 → 枚数 → 建値（空欄なら板の先物））で最初の失敗の文言、
 * 通れば reducer と同じ futureLeg(chain, input, holidays) で組み立てる（投げたらその文言）。
 */
export function futureForm(chain: Chain, holidays: Holidays, f: FutureFormValues): LegFormResult {
  const contract = parseContract(f.contract);
  const qty = parseQty(f.qty);
  const entry = f.entry.trim() === '' ? null : parseEntry(f.entry);
  for (const r of [contract, qty, entry]) {
    if (r !== null && !r.ok) return { ok: false, message: r.message };
  }
  if (!contract.ok || !qty.ok) return { ok: false, message: '足を追加できない' };
  const input: FutureLegInput & { product: FutureProduct; contract: string; qty: number } = {
    product: f.product,
    contract: contract.value,
    side: f.side,
    qty: qty.value,
  };
  if (entry?.ok) input.entry = entry.value;
  try {
    const built = futureLeg(chain, input, holidays);
    return { ok: true, action: { type: 'addFutureLeg', input }, toast: addedToast(built.leg).text };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
}

/**
 * 手入力 OP の足の追加: 旧 LegForms と同じ順のパース（限月 → K → 枚数 → 建値 → IV（空欄不可））、
 * 通れば reducer と同じ manualOptionLeg(chain, input, holidays) で組み立てる（投げたらその文言）。
 */
export function optionForm(chain: Chain, holidays: Holidays, f: OptionFormValues): LegFormResult {
  const expiry = parseContract(f.expiry);
  const k = parseStrike(f.k);
  const qty = parseQty(f.qty);
  const entry = parseEntry(f.entry);
  const iv = parseIvPct(f.iv, false);
  for (const r of [expiry, k, qty, entry, iv]) {
    if (!r.ok) return { ok: false, message: r.message };
  }
  if (!expiry.ok || !k.ok || !qty.ok || !entry.ok || !iv.ok || iv.value === null) {
    return { ok: false, message: '足を追加できない' };
  }
  const input = {
    product: 'op_large' as const,
    expiry: expiry.value,
    type: f.type,
    k: k.value,
    side: f.side,
    qty: qty.value,
    entry: entry.value,
    iv: iv.value,
  };
  try {
    const built = manualOptionLeg(chain, input, holidays);
    return { ok: true, action: { type: 'addManualLeg', input }, toast: addedToast(built.leg).text };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
}

// ---------------------------------------------------------------- デルタヘッジの節

export interface HedgeLineView {
  product: HedgeProduct;
  label: 'ミニ' | 'ラージ';
  /** `−3 枚` / `—` */
  lots: string;
  /** `残り +0.020`（3 桁）。無ければ null */
  residual: string | null;
  canAdd: boolean;
  /** 段の中に出す理由（over_limit / no_delta） */
  reason: string | null;
  input: FutureLegInput | null;
  /** [追加] の aria-label（旧 Hedge と同じ文） */
  aria: string;
  /** [追加] の後のトースト（追加できなければ null） */
  toast: string | null;
}

export interface HedgeSectionView {
  /** `現在 Δ +0.32（ミニ +3.2）→ 目標 0` */
  head: string;
  lines: HedgeLineView[];
  /** 全行に共通の理由（no_price / no_leg / settled）。あれば lines は空 */
  common: string | null;
  /** 説明文の行（限月違いの建値・マイクロ換算・先物の限月と建値） */
  notes: string[];
}

/** 評価点の Seg（文字は短く、aria-label は HEDGE_AT_LABEL の全文） */
export const HEDGE_AT_OPTIONS = [
  { value: 'base', text: '適用前', label: HEDGE_AT_LABEL.base },
  { value: 'scenario', text: 'シナリオ時点', label: HEDGE_AT_LABEL.scenario },
] as const;

const HEDGE_SHORT: Record<HedgeProduct, 'ミニ' | 'ラージ'> = {
  fut_mini: 'ミニ',
  fut_large: 'ラージ',
};

/** 目標 Δ の表示（符号を付けない。小数は入れた桁まで、最大 3 桁） */
function fmtTarget(v: number): string {
  if (Number.isInteger(v)) return fmtNum(v);
  // 指数表記（1e-7 など）は 3 桁
  const t = String(v);
  const frac = t.includes('e') ? '000' : (t.split('.')[1] ?? '');
  return fmtNum(v, Math.min(3, Math.max(1, frac.length)));
}

/** ヘッジのダイアログの中身（評価点ごとのミニ / ラージの行と注記。値は hedgeModel の出力のまま。#274 で節からダイアログへ）。 */
export function hedgeSection(model: HedgeModel): HedgeSectionView {
  const cur = model.current;
  const head = `現在 Δ ${cur ? fmtSigned(cur.large, 2) : DASH}（ミニ ${cur ? fmtSigned(cur.mini, 1) : DASH}）→ 目標 ${fmtTarget(model.target)}`;
  const commonReason =
    model.reason === 'no_price' || model.reason === 'no_leg' || model.reason === 'settled'
      ? model.reason
      : null;
  const lines: HedgeLineView[] = commonReason
    ? []
    : model.lines.map((l) => {
        const input = l.input;
        const canAdd = l.canAdd && input !== null;
        return {
          product: l.product,
          label: HEDGE_SHORT[l.product],
          lots: l.lots === null ? DASH : `${fmtSigned(l.lots)} 枚`,
          residual: l.residual === null ? null : `残り ${fmtSigned(l.residual, 3)}`,
          canAdd,
          reason:
            l.reason === 'over_limit' || l.reason === 'no_delta'
              ? HEDGE_REASON_LABEL[l.reason]
              : null,
          input,
          aria: input
            ? `${PRODUCT_LABEL[l.product]} ${input.contract ?? ''} ${SIDE_LABEL[input.side]} ${fmtNum(input.qty ?? 0)} 枚を追加`
            : `${PRODUCT_LABEL[l.product]}を追加（できない）`,
          toast:
            canAdd && input
              ? futureAddText(
                  l.product,
                  input.contract ?? model.contract,
                  input.side,
                  input.qty ?? 1,
                )
              : null,
        };
      });
  const notes: string[] = [];
  if (model.contractManual && model.entry !== null) {
    notes.push(
      `建値は手入力（板の先物と限月違い）: 初期値 = ${model.contract} 限の合成先物 ${fmtNum(model.entry)}`,
    );
  }
  if (model.micro) {
    notes.push(
      `ミニは 0 枚。マイクロ換算 ${fmtSigned(model.micro.lots)} 枚（残り ${fmtSigned(model.micro.residual, 3)}。マイクロは足の追加フォームから）`,
    );
  }
  if (!model.contractManual && model.entry !== null) {
    notes.push(`先物 ${model.contract} 限 @${fmtNum(model.entry)}`);
  }
  return {
    head,
    lines,
    common: commonReason ? HEDGE_REASON_LABEL[commonReason] : null,
    notes,
  };
}

export interface HedgeSummaryView {
  /**
   * 全文 `現在 Δ −0.06（ミニ −0.6） → ミニ +1 枚`（評価点がシナリオ時点なら `シナリオ時点 Δ …`、目標 ≠ 0 なら
   * `→ 目標 N · ミニ …`、ミニの段に理由があれば末尾に ` · 理由`）。= delta + ' ' + action + why（title・読み上げ）
   */
  text: string;
  /** 前半（今の Δ。入らなければここだけ省略記号）。共通の理由があれば `現在 Δ … · 理由` の全部 */
  delta: string;
  /** 結論 `→ [目標 N · ]ミニ N 枚`（縮めない = 360px でも枚数が読める。#274 再レビュー R5）。共通の理由があれば空 */
  action: string;
  /** ミニの段の理由（` · 枚数が上限…`。無ければ空。入らなければ省略記号） */
  why: string;
  /** [追加] に使うミニの行（全行に共通の理由があれば null = [追加] を出さない） */
  line: HedgeLineView | null;
  /** 理由（共通・ミニの段）があって枚数を出せない */
  warn: boolean;
}

/**
 * デルタヘッジの常設の 1 行（#274。docs/ui-redesign.md §3）: 足 0 本は null（行ごと出さない）。ミニの枚数と [追加] だけを
 * 出し、評価点の切替・ラージ・注記・目標・限月はヘッジのダイアログ（[⋯]）。文の値は hedgeSection と同じ書式
 */
export function hedgeSummary(model: HedgeModel, legCount: number): HedgeSummaryView | null {
  if (legCount === 0) return null;
  const v = hedgeSection(model);
  const cur = model.current;
  // Δ はラージ換算とミニ換算の両方（数値の約束）
  const delta = `${model.at === 'scenario' ? 'シナリオ時点' : '現在'} Δ ${cur ? `${fmtSigned(cur.large, 2)}（ミニ ${fmtSigned(cur.mini, 1)}）` : DASH}`;
  if (v.common !== null) {
    const all = `${delta} · ${v.common}`;
    return { text: all, delta: all, action: '', why: '', line: null, warn: true };
  }
  const mini = v.lines.find((l) => l.product === 'fut_mini') ?? null;
  const goal = model.target === 0 ? '' : `目標 ${fmtTarget(model.target)} · `;
  const action = `→ ${goal}ミニ ${mini ? mini.lots : DASH}`;
  const why = mini?.reason ? ` · ${mini.reason}` : '';
  return {
    text: `${delta} ${action}${why}`,
    delta,
    action,
    why,
    line: mini,
    warn: mini?.reason != null,
  };
}

// ---------------------------------------------------------------- 空の状態・スクロール

/**
 * 足を入れる入口の文言（#325。見出しのボタン・空の欄・パレットで同じ文字）。ポジションの ⋯ の「手入力で足を追加…」は
 * Positions.tsx の項目にリテラルで書く（定数にしない = 文字の出所を 1 つに。ui:check の --flows も同じ文字で探す）。[板から追加] は板を開くリンク
 * （スマホ・タブレットは帯を出し、bid / ask で 1 本入ったらポジションへ戻る。ui/view/shell.ts の pick）
 */
export const PICK_LABEL = '板から追加';
/** 形の一覧を開く入口（#20。⋯・空の欄・パレットで同じ文字。ダイアログは ui/view/shapes.ts） */
export const SHAPES_LABEL = '形から組む…';
/** 空の欄の手入力のボタン（短い形） */
export const MANUAL_ADD_SHORT = '手入力…';
/** 板から追加の帯（スマホ・タブレットの板の見出しの下。案内だけで、ボタンを置かない） */
export const PICK_BAND_TEXT = 'bid / ask を押すとポジションに戻ります';
/** 足 0 本の空の欄の案内 */
export const EMPTY_LEGS_TEXT = `[${PICK_LABEL}] で板の bid（売り）/ ask（買い）を押すか、[${SHAPES_LABEL}] で形を選ぶか、[${MANUAL_ADD_SHORT}] で足を入れる`;

/**
 * 選んだ足の行を見せる .panel-body の scrollTop（座標は同じ基準の px）。見えていれば同じ値、上にはみ出せば
 * 行の上端、下にはみ出せば行の下端に合わせる（行がビューより高ければ上端）。
 */
export function revealScrollTop(
  rowTop: number,
  rowBottom: number,
  viewTop: number,
  viewBottom: number,
  scrollTop: number,
): number {
  const viewH = viewBottom - viewTop;
  if (rowTop < viewTop || rowBottom - rowTop > viewH) return scrollTop - (viewTop - rowTop);
  if (rowBottom > viewBottom) return scrollTop + (rowBottom - viewBottom);
  return scrollTop;
}

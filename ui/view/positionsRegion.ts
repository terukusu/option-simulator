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
import {
  type Action,
  parseContract,
  parseEntry,
  parseIvPct,
  parseQty,
  parseStrike,
  QTY_MAX,
  type State,
} from '../state';
import { DASH, fmtIv, fmtNum, fmtSigned } from './format';
import { HEDGE_AT_LABEL, HEDGE_REASON_LABEL, type HedgeModel, type HedgeProduct } from './hedge';
import {
  AMOUNT_UNIT_LABEL,
  type AmountUnit,
  fmtAmount,
  type LegMetrics,
  type MetricsModel,
} from './metrics';
import type { PnlBase } from './pnlChart';
import {
  fmtEntry,
  legBadges,
  legName,
  legSummary,
  type PositionModel,
  type PositionRow,
  PRODUCT_LABEL,
  SIDE_LABEL,
  SIDE_SHORT,
  toggledSide,
} from './position';
import type { ShellAction, Tier } from './shell';
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

export interface LegDetailView {
  /** 足の項目（商品・売買・枚数・建値・IV・グリーク（シナリオ 0）・建値ずれ・スプレッドコスト・SQ 日） */
  items: DetailItem[];
  /** 足別のシナリオ点（IV・Δ・Γ・Θ・V・状態。求められなければ —） */
  scenario: DetailItem[];
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

/** 行の詳細（項目と書式は旧 Positions の詳細と同じ + スプレッドコスト + 足別のシナリオ点）。 */
export function legDetail(
  row: PositionRow,
  scen: LegMetrics | null,
  spread: number | null,
  unit: AmountUnit,
): LegDetailView {
  const g = row.greeks;
  const u = AMOUNT_UNIT_LABEL[unit];
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
    {
      key: 'delta',
      label: 'Δ ラージ（ミニ）',
      value: `${fmtSigned(g?.deltaLarge, 3)}（${fmtSigned(g?.deltaMini, 2)}）`,
    },
    { key: 'gamma', label: 'Γ / 100 円', value: fmtSigned(g?.gammaPer100, 4) },
    { key: 'theta', label: 'Θ 円 / 日', value: fmtSigned(g?.thetaPerDay, 0) },
    { key: 'vega', label: 'V 円 / pt', value: fmtSigned(g?.vegaPerPt, 0) },
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
      key: 'sq',
      label: 'SQ 日',
      value: row.sqDate,
      ...(row.calendarUnconfirmed && { tag: '休業日未確定' }),
    },
  ];
  const d = scen?.display;
  const state = scen ? LEG_STATE_LABEL[scen.state] : '';
  const scenario: DetailItem[] = [
    {
      key: 's-iv',
      label: 'IV %',
      value: scen && scen.sigma !== null ? fmtIv(scen.sigma) : DASH,
    },
    { key: 's-delta', label: 'Δ ラージ', value: fmtSigned(d?.deltaLarge, 3) },
    { key: 's-gamma', label: 'Γ / 100 円', value: fmtSigned(d?.gammaPer100, 4) },
    { key: 's-theta', label: `Θ ${u} / 日`, value: fmtAmount(d?.thetaPerDay, unit, true) },
    { key: 's-vega', label: `V ${u} / pt`, value: fmtAmount(d?.vegaPerPt, unit, true) },
  ];
  // 状態は満期直前・満期・SQ 済み・F なしのときだけ（旧 Metrics の足別と同じ。live は出さない）
  if (state) scenario.push({ key: 's-state', label: '状態', value: state });
  const marks = [
    ...row.markLabels.map((m) => ({ text: m, warn: m === 'IV 不安定' })),
    ...row.warnings.map((w) => ({ text: w, warn: true })),
    ...(row.error ? [{ text: row.error, warn: true }] : []),
  ];
  return { items, scenario, marks, ivRequired: row.marks.includes('no_board') };
}

// ---------------------------------------------------------------- 見出し行

/** 見出しの副題（`2 本 · 受取 1,575 千円` / `2 本 · 掛け金 …` / `2 本`、0 本は `足なし`）。 */
export function headSub(rowCount: number, metrics: MetricsModel): string {
  if (rowCount === 0) return '足なし';
  const { premium: p, unit } = metrics;
  const u = AMOUNT_UNIT_LABEL[unit];
  if (p.stake !== null) return `${rowCount} 本 · 掛け金 ${fmtAmount(p.stake, unit)} ${u}`;
  if (p.net > 0) return `${rowCount} 本 · 受取 ${fmtAmount(p.net, unit)} ${u}`;
  return `${rowCount} 本`;
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

/** 全クリアの [元に戻す]: 足ごとの restoreLeg を元の順に（0 本は null）。 */
export function clearUndo(state: State): UndoToast | null {
  if (state.legs.length === 0) return null;
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

/** デルタヘッジの節（値は hedgeModel の出力のまま）。 */
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

// ---------------------------------------------------------------- 空の状態・スクロール

/** 空の状態の [板を開く]（スマホ・タブレット = 板のパネル、PC = 市場の列を板に）。 */
export function openBoardActions(tier: Tier): ShellAction[] {
  return tier === 'pc'
    ? [{ type: 'market', market: 'board' }]
    : [{ type: 'open', panel: 'board', tier }];
}

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

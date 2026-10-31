/**
 * 形の一覧のダイアログ（#20。docs/ui-redesign.md「形の一覧」・docs/design.md M7・13.4「戦略テンプレート」）の表示モデル
 * （純関数。Preact・DOM・時計・storage に依存しない）。部品は ui/next/regions/ShapeDialog.tsx。
 *
 * - 一覧: 売り / 買いの 2 群（名前 + 損益の形の小さな図 + 一言）
 * - カード: 限月・距離（[σ | Δ | 円] か ATM から n 本）・翼・枚数、今の板で組んだ足（建値 = 売り bid・買い ask。
 *   reducer と同じ boardOptionLeg）、この形だけの値（指標のタイルと同じ関数 = metricsModel → metricTiles。
 *   シナリオは今 = 指標の「今」と同じ）。組めなければ理由の文で、適用のボタンは押せない
 * - 適用: [このタブに足す] = replaceLegs（前 + 形。expect = 前）と逆向きの [元に戻す]、[新しいタブに入れる] =
 *   openPositionInNewTab と newTabUndoActions（AI の提案と同じ）。新しい action を足さない
 */

import { boardOptionLeg, type Calendar, type Chain, type ChainMonth } from '../../data';
import type { AtmBasis, MarginParams, ModelSettings, Scenario } from '../../model';
import {
  type Action,
  type MetricsUnitSetting,
  QTY_MAX,
  reduce,
  type State,
  type UiLeg,
} from '../state';
import { marketAddLabel, monthSegOptions } from './boardPanel';
import { evalLegs, settingsOf } from './bookList';
import { type MarginView, marginNow, marginPointAt } from './margin';
import { metricsModel } from './metrics';
import { MARGIN_FULL_LABEL, type MetricTile, metricTiles } from './metricsPanel';
import { type NewTabUndo, newTabPlan } from './newTab';
import type { StepSpec } from './stepper';
import { defaultMonthOf, usableMonth } from './strikePick';
import { TABS_FULL_TEXT } from './tabs';
import {
  type DistKind,
  SHAPE_FAIL_TEXT,
  SHAPES,
  type Shape,
  type ShapeFail,
  type ShapeGroup,
  type ShapeId,
  type ShapeLeg,
  shapeLegs,
  shapeOf,
} from './templates';
import { NO_CHAIN_TEXT } from './topMenu';

/** 入口の文字（ポジションの ⋯・空の欄・パレットで同じ。定数は positionsRegion.ts の PICK_LABEL の隣） */
export { SHAPES_LABEL } from './positionsRegion';
/** ダイアログの見出し */
export const SHAPES_TITLE = '形から組む';
/** 形を選んでいないときのカードの代わりの文 */
export const SHAPE_PICK_TEXT = '形を選ぶと今の板で組んだ足と値が出ます';

// ---------------------------------------------------------------- 入力の範囲と既定（13.4）

/** σ の倍率（× σ_ATM） */
export const SIGMA_SPEC: StepSpec = { min: 0.25, max: 3, step: 0.25, def: 1 };
/** |Δ|（AI の提案の既定 0.15） */
export const DELTA_SPEC: StepSpec = { min: 0.05, max: 0.5, step: 0.05, def: 0.15 };
/** X₀ からの円 */
export const YEN_SPEC: StepSpec = { min: 250, max: 20_000, step: 250, def: 3_000 };
/** ATM から n 本 */
export const N_SPEC: StepSpec = { min: -10, max: 10, step: 1, def: 0 };
/** 翼の幅 %（AI の提案の wing_pct と同じ範囲・既定） */
export const WING_SPEC: StepSpec = { min: 1, max: 10, step: 0.5, def: 3 };
/** 枚数（レシオの売り・バタフライの中心が 2 倍でも上限を越えない） */
export const QTY_SPEC: StepSpec = { min: 1, max: Math.floor(QTY_MAX / 2), step: 1, def: 1 };

export const DIST_SPECS: Readonly<Record<DistKind, StepSpec>> = {
  sigma: SIGMA_SPEC,
  delta: DELTA_SPEC,
  yen: YEN_SPEC,
};

/** 距離の Seg の選択肢 */
export const DIST_OPTIONS: readonly { value: DistKind; text: string; label: string }[] = [
  { value: 'sigma', text: 'σ', label: 'σ（ATM の IV × √T の倍率）' },
  { value: 'delta', text: 'Δ', label: '|Δ|' },
  { value: 'yen', text: '円', label: '基準価格からの円' },
];

/** ダイアログの入力（保存しない。形を替えても限月・距離・翼・枚数は引き継ぐ） */
export interface ShapeForm {
  shape: ShapeId | null;
  /** 限月（null = 既定の限月） */
  month: string | null;
  dist: DistKind;
  sigma: number;
  delta: number;
  yen: number;
  n: number;
  wingPct: number;
  qty: number;
}

export const initialShapeForm = (shape: ShapeId | null): ShapeForm => ({
  shape,
  month: null,
  dist: 'sigma',
  sigma: SIGMA_SPEC.def,
  delta: DELTA_SPEC.def,
  yen: YEN_SPEC.def,
  n: N_SPEC.def,
  wingPct: WING_SPEC.def,
  qty: QTY_SPEC.def,
});

// ---------------------------------------------------------------- 一覧

export interface ShapeListItem {
  id: ShapeId;
  name: string;
  note: string;
  /** 図の polyline の points 属性（固定の点列） */
  points: string;
  /** 読み上げ名（名前 + 一言） */
  aria: string;
}

export interface ShapeListGroup {
  group: ShapeGroup;
  /** 見出し（「売り」「買い」） */
  title: string;
  /** role="group" の aria-label */
  label: string;
  items: ShapeListItem[];
}

const GROUP_TITLE: Readonly<Record<ShapeGroup, string>> = { sell: '売り', buy: '買い' };

const pointsAttr = (s: Shape) => s.points.map(([x, y]) => `${x},${y}`).join(' ');

/** 一覧（売り 6・買い 6） */
export function shapeList(): ShapeListGroup[] {
  return (['sell', 'buy'] as const).map((g) => ({
    group: g,
    title: GROUP_TITLE[g],
    label: `${GROUP_TITLE[g]}の形`,
    items: SHAPES.filter((s) => s.group === g).map((s) => ({
      id: s.id,
      name: s.short ?? s.name,
      note: s.note,
      points: pointsAttr(s),
      aria: `${s.name}。${s.note}`,
    })),
  }));
}

// ---------------------------------------------------------------- カード

export interface ShapeCardInput {
  chain: Chain | null;
  basis: AtmBasis;
  /** 作業中のタブの足（既定の限月） */
  legs: readonly UiLeg[];
  calendar: Calendar;
  feePerLot: number;
  futureBasis: ModelSettings['futureBasis'];
  unit: MetricsUnitSetting;
  /** 今のシナリオ（d・ΔX・Δσ・Δs = 0、β・動き方・IV の入れ方は今のまま = 指標の「今」） */
  nowScenario: Scenario;
  params: MarginParams;
  capital: number | null;
  /** 新しいタブを足せる（タブが上限でない） */
  canAddTab: boolean;
}

export interface ShapeLegRow {
  key: string;
  side: 'buy' | 'sell';
  /** `売 P 60,000 @85 ×1`（カレンダーは限月を付ける） */
  text: string;
  /** 売買の印（売 / 買）と残り（`P 60,000 @85 ×1`）。画面は印を色の付いた札にする */
  badge: string;
  body: string;
}

export interface ShapeValue {
  key: MetricTile['key'];
  k: string;
  v: string;
  unit: string;
}

export interface ShapeCard {
  shape: Shape;
  /** 限月の Seg（スマイルと F がある限月だけ。無ければ空） */
  months: { value: string; text: string; label: string }[];
  /** 選んでいる限月（無ければ ''） */
  month: string;
  /** 組んだ足（UiLeg。id は 1..n）。組めなければ空 */
  legs: UiLeg[];
  rows: ShapeLegRow[];
  /** この形だけの値（受取 / 支払・満期の最大損失・BEP・必要証拠金（概算））。組めなければ空 */
  values: ShapeValue[];
  /** 組めない理由（組めれば null） */
  reason: string | null;
  canApply: boolean;
  applyTitle: string | undefined;
  canNewTab: boolean;
  newTabTitle: string | undefined;
}

const VALUE_KEYS = ['premium', 'maxLoss', 'bep', 'margin'] as const;

/** 選べる限月（スマイルと F がある）と、選んでいる限月 */
function monthOf(chain: Chain, form: ShapeForm, legs: readonly UiLeg[]): ChainMonth | null {
  const usable = chain.months.filter(usableMonth);
  return usable.find((m) => m.id === form.month) ?? defaultMonthOf(chain, legs);
}

/**
 * 足の仕様 → UiLeg（reducer の addBoardLeg と同じ boardOptionLeg）。作れない足（両気配でない・板に無い）があれば、その足の
 * 種別の理由（put / call の側に両気配の行が無い。カレンダーの次の限月の足なら no_quote_next）
 */
export function shapeUiLegs(
  chain: Chain,
  spec: readonly ShapeLeg[],
  qty: number,
): { ok: true; legs: UiLeg[] } | { ok: false; reason: ShapeFail } {
  const out: UiLeg[] = [];
  const first = spec[0]?.expiry;
  for (const [i, s] of spec.entries()) {
    const why: ShapeFail =
      s.expiry !== first ? 'no_quote_next' : s.type === 'put' ? 'no_quote_put' : 'no_quote_call';
    try {
      const b = boardOptionLeg(chain, {
        expiry: s.expiry,
        k: s.k,
        type: s.type,
        side: s.side,
        qty: s.mul * qty,
      });
      if (b.marks.includes('no_quote')) return { ok: false, reason: why };
      out.push({ id: i + 1, leg: b.leg, marks: b.marks });
    } catch {
      return { ok: false, reason: why };
    }
  }
  return { ok: true, legs: out };
}

/** 足だけを評価したときの指標のタイル（指標のパネルと同じ関数・今のシナリオ）。評価できなければ空 */
export function shapeTiles(input: ShapeCardInput, legs: readonly UiLeg[]): MetricTile[] {
  const { chain } = input;
  if (!chain || legs.length === 0) return [];
  const settings = settingsOf(input.feePerLot, input.futureBasis);
  const { base } = evalLegs(chain, legs, input.basis, input.calendar, settings);
  if (!base) return [];
  const model = metricsModel({ base, scenario: input.nowScenario, unit: input.unit });
  const now = marginNow(
    base,
    input.nowScenario,
    input.params,
    input.capital,
    input.calendar.holidays,
  );
  const mv: MarginView = {
    capital: input.capital,
    params: input.params,
    now,
    point: now,
    at: marginPointAt(base, input.nowScenario),
    tail: [],
  };
  return metricTiles(model, mv);
}

/** 形のカード（形を選んでいなければ null） */
export function shapeCard(input: ShapeCardInput, form: ShapeForm): ShapeCard | null {
  if (form.shape === null) return null;
  const shape = shapeOf(form.shape);
  const { chain } = input;
  const blocked = (reason: string, months: ShapeCard['months'] = [], month = ''): ShapeCard => ({
    shape,
    months,
    month,
    legs: [],
    rows: [],
    values: [],
    reason,
    canApply: false,
    applyTitle: reason,
    canNewTab: false,
    newTabTitle: reason,
  });
  if (!chain) return blocked(NO_CHAIN_TEXT);
  const usable = chain.months.filter(usableMonth);
  const months = monthSegOptions(usable);
  const m = monthOf(chain, form, input.legs);
  if (!m) return blocked(SHAPE_FAIL_TEXT.no_forward, months);
  const dist = form.dist === 'sigma' ? form.sigma : form.dist === 'delta' ? form.delta : form.yen;
  const r = shapeLegs(chain, m, shape.id, {
    basis: input.basis,
    dist: { kind: form.dist, value: dist },
    n: form.n,
    wingPct: form.wingPct,
  });
  if (!r.ok) return blocked(SHAPE_FAIL_TEXT[r.reason], months, m.id);
  const built = shapeUiLegs(chain, r.legs, form.qty);
  if (!built.ok) return blocked(SHAPE_FAIL_TEXT[built.reason], months, m.id);
  const legs = built.legs;
  const monthText = new Map(monthSegOptions(chain.months).map((o) => [o.value, o.text]));
  const rows = legs.map((l, i): ShapeLegRow => {
    const leg = l.leg;
    if (leg.kind !== 'option')
      return { key: String(i), side: leg.side, text: '', badge: '', body: '' };
    const month = shape.id === 'calendar' ? `（${monthText.get(leg.expiry) ?? leg.expiry}）` : '';
    const text = `${marketAddLabel(leg)} ×${leg.qty}${month}`;
    return {
      key: `${i}:${leg.expiry}:${leg.type}:${leg.strike}:${leg.side}`,
      side: leg.side,
      text,
      badge: text.slice(0, 1),
      body: text.slice(2),
    };
  });
  const tiles = shapeTiles(input, legs);
  const values: ShapeValue[] = [];
  for (const key of VALUE_KEYS) {
    const t = tiles.find((x) => x.key === key);
    if (!t) continue;
    values.push({ key, k: key === 'margin' ? MARGIN_FULL_LABEL : t.k, v: t.v, unit: t.unit });
  }
  return {
    shape,
    months,
    month: m.id,
    legs,
    rows,
    values,
    reason: null,
    canApply: true,
    applyTitle: undefined,
    canNewTab: input.canAddTab,
    newTabTitle: input.canAddTab ? undefined : TABS_FULL_TEXT,
  };
}

// ---------------------------------------------------------------- 適用と [元に戻す]

/** [新しいタブに入れる] の [元に戻す] ができないときの文 */
export const SHAPE_NEW_TAB_UNDO_TEXT = {
  edited: '形を入れたタブを編集したので戻しません（タブは × で閉じられます）',
  gone: '形を入れたタブはもう閉じています',
} as const;

export type ShapeApplyPlan =
  | {
      target: 'current';
      action: Action;
      /** [元に戻す]（逆向きの replaceLegs） */
      undo: Action;
      /** 足した最初の足の id（選ぶ） */
      pickId: number;
      text: string;
    }
  | {
      target: 'new_tab';
      action: Action;
      undo: NewTabUndo;
      pickId: number | null;
      text: string;
    };

/**
 * 適用の計画（押した時点の state から作る）。current = 作業中のタブ（保有のタブでも。板から足すのと同じ）に足す、
 * new_tab = 新しいタブに入れる（タブが上限なら null）。足が無ければ null
 */
export function shapeApplyPlan(
  st: State,
  shape: ShapeId,
  legs: readonly UiLeg[],
  target: 'current' | 'new_tab',
): ShapeApplyPlan | null {
  if (legs.length === 0) return null;
  const name = shapeOf(shape).name;
  const n = legs.length;
  if (target === 'current') {
    const before = st.legs;
    const added = legs.map((l, i) => ({ ...l, id: st.nextId + i }));
    const after = [...before, ...added];
    const tab = st.activeTab;
    return {
      target,
      action: { type: 'replaceLegs', legs: after, expect: before, tab },
      undo: { type: 'replaceLegs', legs: before, expect: after, tab },
      pickId: st.nextId,
      text: `${name}（${n} 本）を足した`,
    };
  }
  const plan = newTabPlan(st, legs);
  if (!plan) return null;
  return {
    target,
    action: plan.action,
    undo: plan.undo,
    pickId: reduce(st, plan.action).legs[0]?.id ?? null,
    text: `${name}（${n} 本）を新しいタブに入れた`,
  };
}

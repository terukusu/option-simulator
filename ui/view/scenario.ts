/**
 * シナリオのパネルの表示モデル（純関数）。設計 docs/design.md M5・5.4、AC26、#6。
 *
 * - スライダー 4 本の範囲・刻み・既定値（d は暦日、ΔX は状態では円・表示は % か円、Δσ は pt、
 *   Δs は pt / moneyness 10%）
 * - キー操作の状態遷移（DOM を持たない）: ←/↓ −1 刻み、→/↑ +1 刻み、Shift + 矢印・PageUp/PageDown ±10 刻み、
 *   Home/End 端、R = そのスライダーの既定値、+ / = / − / - = 損益グラフの拡大・縮小
 * - 数値欄のパース（範囲外・非数は固定の文言で拒否し、状態を変えない）
 * - 「SQ 日 9:00」「取引最終日 15:45」ボタンの対象（足の限月）と d
 * - 損益グラフ上の ΔX（#52）: 長押しドラッグの位置 → ΔX（10 円の格子）、グラフのキー , . < >
 */

import { type Calendar, type Chain, monthOf } from '../../data';
import {
  DAY_MS,
  daysUntil,
  lastTradingCloseInstant,
  monthlyExpiry,
  sqInstant,
  yearFraction,
} from '../../model';
import type { Parsed, UiLeg } from '../state';
import { fmtNum, parseNum } from './format';
import { daysToExpire } from './pnlChart';

export type SliderField = 'days' | 'dX' | 'dSigma' | 'skew';
export type DXUnit = 'pct' | 'yen';

/** ΔX の範囲（X₀ に対する割合。設計 5.4） */
export const DX_MIN_RATIO = -0.4;
export const DX_MAX_RATIO = 0.2;
/** 円表示の ΔX の刻み */
export const DX_YEN_STEP = 100;
/** Shift・PageUp/PageDown の刻みの倍数 */
export const BIG_STEP = 10;
/** β の範囲（pt / 1%） */
export const BETA_MAX = 10;

export interface SliderSpec {
  field: SliderField;
  label: string;
  unit: string;
  /** 表示の単位での範囲・刻み・既定値（ΔX は % か円） */
  min: number;
  max: number;
  step: number;
  def: number;
  /** 操作できない（足 0 本の d、X₀ が決まらない ΔX） */
  disabled: boolean;
}

export interface SliderContext {
  x0: number;
  /** d の上限（最遠の足の SQ までの暦日。足 0 本は 0） */
  maxDays: number;
  dXUnit: DXUnit;
}

const validX0 = (x0: number) => Number.isFinite(x0) && x0 > 0;

/** スライダーの範囲・刻み・既定値。 */
export function sliderSpec(field: SliderField, ctx: SliderContext): SliderSpec {
  switch (field) {
    case 'days': {
      const max = Number.isFinite(ctx.maxDays) ? Math.max(ctx.maxDays, 0) : 0;
      return {
        field,
        label: '経過日数 d',
        unit: '日',
        min: 0,
        max,
        step: 1,
        def: 0,
        disabled: max <= 0,
      };
    }
    case 'dX': {
      if (!validX0(ctx.x0)) {
        return {
          field,
          label: '原資産 ΔX',
          unit: '%',
          min: 0,
          max: 0,
          step: 0.5,
          def: 0,
          disabled: true,
        };
      }
      if (ctx.dXUnit === 'pct') {
        return {
          field,
          label: '原資産 ΔX',
          unit: '%',
          min: DX_MIN_RATIO * 100,
          max: DX_MAX_RATIO * 100,
          step: 0.5,
          def: 0,
          disabled: false,
        };
      }
      // 円: 100 円の格子（0 を含む）に乗る内側の端
      return {
        field,
        label: '原資産 ΔX',
        unit: '円',
        min: Math.ceil((DX_MIN_RATIO * ctx.x0) / DX_YEN_STEP) * DX_YEN_STEP,
        max: Math.floor((DX_MAX_RATIO * ctx.x0) / DX_YEN_STEP) * DX_YEN_STEP,
        step: DX_YEN_STEP,
        def: 0,
        disabled: false,
      };
    }
    case 'dSigma':
      return {
        field,
        label: 'IV 平行移動 Δσ',
        unit: 'pt',
        min: -10,
        max: 40,
        step: 0.5,
        def: 0,
        disabled: false,
      };
    case 'skew':
      return {
        field,
        label: 'スキュー Δs',
        unit: 'pt / 10%',
        min: -5,
        max: 5,
        step: 0.5,
        def: 0,
        disabled: false,
      };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** 刻みの格子（0 基準）に丸める（浮動小数の端数を落とす） */
const snap = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(10));

// ---------------------------------------------------------------- グラフ上の ΔX（#52）

/** 長押しドラッグの ΔX の格子（円） */
export const DRAG_DX_STEP = 10;
/** グラフのキー , / . の刻み（円。スライダーの円の刻みと同じ）と、< / > の刻み */
export const KEY_DX_STEP = DX_YEN_STEP;
export const KEY_DX_BIG = 1000;

/** ΔX の範囲（−40%〜+20% の内側で、step の格子に乗る端。X₀ は有効な値であること）。 */
export function dXRange(x0: number, step: number = DRAG_DX_STEP): [number, number] {
  return [
    snapZero(Math.ceil((DX_MIN_RATIO * x0) / step) * step),
    snapZero(Math.floor((DX_MAX_RATIO * x0) / step) * step),
  ];
}

const snapZero = (v: number) => (v === 0 ? 0 : v);

/**
 * 横軸の値（グラフの位置）→ ΔX: 値 − X₀ を 10 円の格子に丸め、範囲に収める。X₀ が非有限・0 以下、
 * 値が非有限なら null（NaN を状態に入れない）。
 */
export function dXFromAxis(xValue: number, x0: number): number | null {
  if (!validX0(x0) || !Number.isFinite(xValue)) return null;
  const [lo, hi] = dXRange(x0);
  return snapZero(clamp(snap(xValue - x0, DRAG_DX_STEP), lo, hi));
}

const KEY_DX: ReadonlyMap<string, number> = new Map([
  [',', -KEY_DX_STEP],
  ['.', KEY_DX_STEP],
  ['<', -KEY_DX_BIG],
  ['>', KEY_DX_BIG],
]);

/**
 * グラフのキー: , / . で ∓100 円、< / > で ∓1,000 円。現在値から押した向きに動かし（10 円の格子に乗せる）、
 * ドラッグと同じ範囲（dXRange）に収める。範囲の端では動かない（押した向きと逆には動かさない）。
 * 他のキー・X₀ が無効なら null（← / → / + / − / R はグラフの既存の操作のまま）。
 */
export function stepDXKey(dX: number, key: string, x0: number): number | null {
  const delta = KEY_DX.get(key);
  if (delta === undefined || !validX0(x0)) return null;
  const cur = Number.isFinite(dX) ? dX : 0;
  const [lo, hi] = dXRange(x0);
  const next = snapZero(clamp(snap(cur + delta, DRAG_DX_STEP), lo, hi));
  // 範囲の外の値（% のスライダーの端など）から端へ戻すと逆向きになるので、そのときは動かさない
  return (delta > 0 ? next < cur : next > cur) ? cur : next;
}

export type SliderKeyResult = number | 'zoomIn' | 'zoomOut' | null;

/**
 * キー操作の状態遷移。戻り値は新しい値（表示の単位、[min, max] に収めたもの）、
 * 損益グラフの拡大・縮小、または null（このキーは扱わない）。
 */
export function stepSlider(
  spec: SliderSpec,
  value: number,
  key: string,
  shift: boolean,
): SliderKeyResult {
  switch (key) {
    case '+':
    case '=':
      return 'zoomIn';
    case '-':
    case '−':
      return 'zoomOut';
    default:
  }
  if (spec.disabled) return null;
  const cur = Number.isFinite(value) ? clamp(value, spec.min, spec.max) : spec.def;
  const move = (n: number) => clamp(snap(cur + n * spec.step, spec.step), spec.min, spec.max);
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return move(shift ? -BIG_STEP : -1);
    case 'ArrowRight':
    case 'ArrowUp':
      return move(shift ? BIG_STEP : 1);
    case 'PageDown':
      return move(-BIG_STEP);
    case 'PageUp':
      return move(BIG_STEP);
    case 'Home':
      return spec.min;
    case 'End':
      return spec.max;
    case 'r':
    case 'R':
      return spec.def;
    default:
      return null;
  }
}

const rangeText = (spec: SliderSpec) => {
  const digits = spec.field === 'days' ? 2 : spec.step < 1 ? 1 : 0;
  const f = (v: number) => fmtNum(Math.trunc(v * 10 ** digits) / 10 ** digits, digits);
  return `${f(spec.min)}〜${f(spec.max)} ${spec.unit}`;
};

/** 数値欄の文字列 → 表示の単位の値。範囲外・非数は固定の文言（入力文字列は含めない）。 */
export function parseSliderInput(text: string, spec: SliderSpec): Parsed<number> {
  const v = parseNum(text);
  if (Number.isFinite(v) && v >= spec.min - 1e-9 && v <= spec.max + 1e-9) {
    return { ok: true, value: clamp(v, spec.min, spec.max) };
  }
  return { ok: false, message: `${spec.label}は ${rangeText(spec)}` };
}

/** β（pt / 1%）: 0〜10。 */
export function parseBeta(text: string): Parsed<number> {
  const v = parseNum(text);
  return Number.isFinite(v) && v >= 0 && v <= BETA_MAX
    ? { ok: true, value: v }
    : { ok: false, message: `β は 0〜${BETA_MAX}（pt / 1%）` };
}

/** 状態の値（ΔX は円）→ 表示の単位。 */
export function toDisplay(field: SliderField, value: number, x0: number, unit: DXUnit): number {
  if (field !== 'dX' || unit === 'yen') return value;
  return validX0(x0) ? (value / x0) * 100 : 0;
}

/** 表示の単位 → 状態の値（ΔX は円）。 */
export function fromDisplay(field: SliderField, value: number, x0: number, unit: DXUnit): number {
  if (field !== 'dX' || unit === 'yen') return value;
  return validX0(x0) ? (x0 * value) / 100 : 0;
}

/** 数値欄の初期文字列（表示の単位）。 */
export function fmtSliderValue(spec: SliderSpec, value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (spec.field === 'days') return String(Math.round(value * 100) / 100);
  if (spec.field === 'dX' && spec.unit === '円') return fmtNum(value, 0);
  return fmtNum(value, Math.abs(value * 2 - Math.round(value * 2)) < 1e-9 ? 1 : 2);
}

// ---------------------------------------------------------------- 評価時刻ボタン

export interface EvalTimeTarget {
  /** 限月 ID（YYYY-MM） */
  id: string;
  label: string;
  /** SQ 日 09:00 JST */
  sqTime: number;
  /** 取引最終日 15:45 JST */
  lastTradeClose: number;
}

const YM = /^(\d{4})-(\d{2})$/;

function targetOf(chain: Chain, id: string, calendar: Calendar) {
  const m = monthOf(chain, id);
  if (m) {
    return {
      sqTime: sqInstant(m.sqDate),
      lastTradeClose: lastTradingCloseInstant(m.lastTradingDay),
    };
  }
  if (id === chain.future.id) {
    return {
      sqTime: sqInstant(chain.future.sqDate),
      lastTradeClose: lastTradingCloseInstant(chain.future.lastTradingDay),
    };
  }
  const ym = YM.exec(id);
  const month = ym ? Number(ym[2]) : 0;
  if (!ym || month < 1 || month > 12) return null;
  const e = monthlyExpiry(Number(ym[1]), month, calendar.holidays);
  return { sqTime: e.sqTime, lastTradeClose: lastTradingCloseInstant(e.lastTradingDay) };
}

/**
 * ボタンの対象: 足の限月（OP の限月・先物の限月を ID で重複除去、SQ 昇順）。SQ 日・取引最終日は板の限月なら
 * 板の値、板に無い限月は取引カレンダーから（data/ の手入力の足・先物の足と同じ）。
 */
export function evalTimeTargets(
  chain: Chain,
  legs: readonly UiLeg[],
  calendar: Calendar,
): EvalTimeTarget[] {
  const kinds = new Map<string, Set<string>>();
  for (const ui of legs) {
    const id = ui.leg.kind === 'option' ? ui.leg.expiry : ui.leg.contract;
    const set = kinds.get(id) ?? new Set<string>();
    set.add(ui.leg.kind === 'option' ? 'OP' : '先物');
    kinds.set(id, set);
  }
  const out: EvalTimeTarget[] = [];
  for (const [id, set] of kinds) {
    const t = targetOf(chain, id, calendar);
    if (!t) continue;
    out.push({ id, label: `${id} 限（${[...set].sort().join('・')}）`, ...t });
  }
  return out.sort((a, b) => a.sqTime - b.sqTime || a.id.localeCompare(b.id));
}

/**
 * 評価時刻を target に置く d（暦日）。target が評価時刻以前なら null（負の d は作らない）。
 * 上は maxDays に収める。
 */
export function daysToTarget(evalTime: number, target: number, maxDays: number): number | null {
  if (!(Number.isFinite(evalTime) && Number.isFinite(target)) || target <= evalTime) return null;
  // daysUntil と同じ値に、model の T' = T0 − d / 365 が 0 以下になる分（ulp）だけ足す（SQ 日 9:00 で満期にする）
  const d = Math.max(daysUntil(evalTime, target), daysToExpire(yearFraction(evalTime, target)));
  return Number.isFinite(maxDays) ? Math.min(d, Math.max(maxDays, 0)) : d;
}

/** 評価時刻 + d（epoch ミリ秒。表示用） */
export function evalInstant(evalTime: number, days: number): number {
  return evalTime + days * DAY_MS;
}

/**
 * 新しい画面のシナリオの領域（docs/ui-redesign.md §2・§3・§4.2・§5.2。#83）の表示モデル（純関数）。
 * 部品は ui/next/regions/Scenario.tsx。範囲・刻み・パース・評価時刻の値は ui/view/scenario.ts をそのまま使う。
 *
 * - ステッパー 4 つ（d・ΔX・Δσ・Δs）と「モデルの前提」の β: 仕様・値（表示の単位）・文字・副題・hot・無効
 * - 操作 → action（既存の setScenario / applyPreset / resetScenario / setFutureBasis だけ）
 * - 数値入力のパース（parseSliderInput / parseBeta の文言のまま）
 * - プリセットのチップ（リセット + CRASH_PRESETS の順に 急落・下落・反発。リセットを先頭 = 横スクロールせずに見える）・評価時刻のチップ（足の全限月）
 * - 「モデルの前提」の要約 1 行
 */

import { CRASH_PRESETS, type IvDynamics, type Scenario } from '../../model';
import type { Action, Parsed } from '../state';
import { DASH, fmtDateTime, fmtNum, fmtSigned } from './format';
import {
  BETA_MAX,
  type DXUnit,
  daysToTarget,
  type EvalTimeTarget,
  evalInstant,
  fmtSliderValue,
  fromDisplay,
  parseBeta,
  parseSliderInput,
  type SliderField,
  sliderSpec,
  toDisplay,
} from './scenario';
import { isHot, type StepSpec } from './stepper';

export type FutureBasis = 'fixed' | 'decay';

export interface ScenarioRegionInput {
  scenario: Scenario;
  futureBasis: FutureBasis;
  /** 基準原資産 X₀（決まらなければ NaN） */
  x0: number;
  /** d の上限（最遠の足の SQ までの暦日。足 0 本は 0） */
  maxDays: number;
  /** 評価時刻（epoch ミリ秒。足 0 本は null） */
  evalTime: number | null;
  targets: readonly EvalTimeTarget[];
  dXUnit: DXUnit;
}

export type RegionField = SliderField | 'beta';

/** β の段（0〜10・0.1、既定 1 = ZERO_SCENARIO.beta） */
export const BETA_SPEC: StepSpec = { min: 0, max: BETA_MAX, step: 0.1, def: 1 };

/** シナリオの行のステッパーの順 */
export const SCENARIO_FIELDS: readonly SliderField[] = ['days', 'dX', 'dSigma', 'skew'];

export interface StepperView {
  field: RegionField;
  label: string;
  spec: StepSpec;
  /** 表示の単位の値（ΔX は % か円、d は [0, 上限] に収めた値） */
  value: number;
  text: string;
  sub: string | undefined;
  hot: boolean;
  disabled: boolean;
  /** 段の格子に寄せない（d だけ） */
  keepFraction: boolean;
}

const validX0 = (x0: number) => Number.isFinite(x0) && x0 > 0;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const ctxOf = (input: ScenarioRegionInput) => ({
  x0: input.x0,
  maxDays: input.maxDays,
  dXUnit: input.dXUnit,
});
/** 0.5（β は 0.1）の格子なら 1 桁、それ以外 2 桁 */
const onGrid = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-9;
const fin = (v: number) => (Number.isFinite(v) ? v : 0);

/** 表示の単位の値 → ステッパーの文字（§5.2） */
export function stepperText(field: RegionField, v: number, input: ScenarioRegionInput): string {
  switch (field) {
    case 'days':
      return `${Math.round(fin(v) * 100) / 100} 日`;
    case 'dX':
      if (!validX0(input.x0)) return DASH;
      return input.dXUnit === 'pct'
        ? `${fmtSigned(fin(v), onGrid(fin(v), 0.5) ? 1 : 2)}%`
        : `${fmtSigned(fin(v), 0)} 円`;
    case 'dSigma':
      return `${fmtSigned(fin(v), 1)} pt`;
    case 'skew':
      return fmtSigned(fin(v), 1);
    case 'beta':
      return fmtNum(fin(v), onGrid(fin(v), 0.1) ? 1 : 2);
  }
}

/** 副題（§5.2。d は評価日時、ΔX はもう一方の単位と X'） */
export function stepperSub(
  field: RegionField,
  v: number,
  input: ScenarioRegionInput,
): string | undefined {
  switch (field) {
    case 'days': {
      if (input.evalTime === null || !Number.isFinite(input.evalTime)) return undefined;
      const s = fmtDateTime(evalInstant(input.evalTime, fin(v)));
      return s === DASH ? undefined : `${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11)}`;
    }
    case 'dX': {
      if (!validX0(input.x0)) return undefined;
      const yen = fromDisplay('dX', fin(v), input.x0, input.dXUnit);
      const x = `X ${fmtNum(input.x0 + yen, 0)}`;
      return input.dXUnit === 'pct'
        ? `${fmtSigned(yen, 0)} 円 · ${x}`
        : `${fmtSigned((yen / input.x0) * 100, 1)}% · ${x}`;
    }
    case 'dSigma':
      return 'Δσ 平行';
    case 'skew':
      return 'pt / 10%';
    case 'beta':
      return 'pt / 1%';
  }
}

function sliderView(field: SliderField, input: ScenarioRegionInput): StepperView {
  const spec = sliderSpec(field, ctxOf(input));
  const raw = toDisplay(field, fin(input.scenario[field]), input.x0, input.dXUnit);
  const value = field === 'days' ? clamp(raw, 0, Math.max(spec.max, 0)) : raw;
  const step: StepSpec = { min: spec.min, max: spec.max, step: spec.step, def: spec.def };
  return {
    field,
    label: spec.label,
    spec: step,
    value,
    text: stepperText(field, value, input),
    sub: stepperSub(field, value, input),
    hot: !spec.disabled && isHot(step, value),
    disabled: spec.disabled,
    keepFraction: field === 'days',
  };
}

/** シナリオの行のステッパー 4 つ（d・ΔX・Δσ・Δs の順） */
export function scenarioSteppers(input: ScenarioRegionInput): StepperView[] {
  return SCENARIO_FIELDS.map((f) => sliderView(f, input));
}

/** 「モデルの前提」の β のステッパー */
export function betaStepper(input: ScenarioRegionInput): StepperView {
  const value = fin(input.scenario.beta);
  return {
    field: 'beta',
    label: 'IV–原資産連動 β',
    spec: BETA_SPEC,
    value,
    text: stepperText('beta', value, input),
    sub: stepperSub('beta', value, input),
    hot: isHot(BETA_SPEC, value),
    disabled: false,
    keepFraction: false,
  };
}

const disabledOf = (field: RegionField, input: ScenarioRegionInput) =>
  field === 'beta' ? false : sliderSpec(field, ctxOf(input)).disabled;

/**
 * ステッパーの新しい値（表示の単位）→ action。状態の値は fromDisplay（β はそのまま）。無効のステッパー・非有限・
 * 今と同じ値なら null。
 */
export function stepperAction(
  field: RegionField,
  display: number,
  input: ScenarioRegionInput,
): Action | null {
  if (!Number.isFinite(display) || disabledOf(field, input)) return null;
  const v = field === 'beta' ? display : fromDisplay(field, display, input.x0, input.dXUnit);
  if (!Number.isFinite(v) || v === input.scenario[field]) return null;
  return { type: 'setScenario', patch: { [field]: v } };
}

/** 数値入力の文字列 → 表示の単位の値（文言は parseSliderInput / parseBeta のまま。格子に寄せない） */
export function parseStepperInput(
  field: RegionField,
  text: string,
  input: ScenarioRegionInput,
): Parsed<number> {
  if (field === 'beta') return parseBeta(text);
  return parseSliderInput(text, sliderSpec(field, ctxOf(input)));
}

/** 数値入力を開いたときの文字列（表示の単位） */
export function editText(field: RegionField, display: number, input: ScenarioRegionInput): string {
  if (field === 'beta') return Number.isFinite(display) ? fmtNum(display, 1) : '1';
  return fmtSliderValue(sliderSpec(field, ctxOf(input)), display);
}

// ---------------------------------------------------------------- チップ

export interface Chip {
  key: string;
  text: string;
  /** トグルの押下状態（undefined = 1 回の操作） */
  pressed?: boolean;
  disabled: boolean;
  /** 押したときの action（押せなければ null） */
  action: Action | null;
}

/** プリセットの名前（CRASH_PRESETS の順） */
export const PRESET_NAMES: readonly string[] = ['急落', '下落', '反発'];

const sameYen = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/**
 * プリセットのチップ: [リセット][急落 −10% / +20pt / +3][下落 …][反発 …]（リセットを先頭 = スマホでも横スクロールせずに見える）。今のシナリオと同じ値のチップは pressed。
 * X₀ が決まらなければ 3 つは押せない（リセットは押せる）。
 */
export function presetChips(input: ScenarioRegionInput): Chip[] {
  const ok = validX0(input.x0);
  const s = input.scenario;
  const out: Chip[] = CRASH_PRESETS.map((p, index) => {
    const name = PRESET_NAMES[index] ?? `プリセット ${index + 1}`;
    const pressed =
      ok && sameYen(s.dX, (input.x0 * p.dXPct) / 100) && s.dSigma === p.dSigma && s.skew === p.skew;
    return {
      key: `preset-${index}`,
      text: `${name} ${fmtSigned(p.dXPct)}% / ${fmtSigned(p.dSigma)}pt / ${fmtSigned(p.skew)}`,
      pressed,
      disabled: !ok,
      action: ok ? { type: 'applyPreset', index, x0: input.x0 } : null,
    };
  });
  out.unshift({
    key: 'reset',
    text: 'リセット',
    disabled: false,
    action: { type: 'resetScenario' },
  });
  return out;
}

export interface EvalChip extends Chip {
  /** そのチップの d（評価時刻以前・評価時刻なしは null） */
  days: number | null;
}

/**
 * 評価時刻のチップ: 足の全限月（targets の順 = SQ 昇順）ごとに [N月 最終日 15:45][N月 SQ 9:00]。
 * 同じ月番号が 2 つあれば「YYYY年N月」。d は daysToTarget（null は押せない）、今の d と同じものは pressed。
 */
export function evalChips(input: ScenarioRegionInput): EvalChip[] {
  const monthNo = (id: string) => Number(id.slice(5, 7));
  const counts = new Map<number, number>();
  for (const t of input.targets) counts.set(monthNo(t.id), (counts.get(monthNo(t.id)) ?? 0) + 1);
  const cur = fin(input.scenario.days);
  const out: EvalChip[] = [];
  for (const t of input.targets) {
    const m = monthNo(t.id);
    const name = !Number.isFinite(m)
      ? t.id
      : (counts.get(m) ?? 0) > 1
        ? `${t.id.slice(0, 4)}年${m}月`
        : `${m}月`;
    for (const [kind, at, label] of [
      ['last', t.lastTradeClose, '最終日 15:45'],
      ['sq', t.sqTime, 'SQ 9:00'],
    ] as const) {
      const days = input.evalTime === null ? null : daysToTarget(input.evalTime, at, input.maxDays);
      out.push({
        key: `${t.id}:${kind}`,
        text: `${name} ${label}`,
        days,
        pressed: days !== null && Math.abs(days - cur) <= 1e-9,
        disabled: days === null,
        action: days === null ? null : { type: 'setScenario', patch: { days } },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- モデルの前提

/** 「モデルの前提」の要約 1 行（`β 1.0 · sticky strike · basis 固定 · ΔX %`） */
export function advSummary(input: ScenarioRegionInput): string {
  const s = input.scenario;
  const dyn = s.ivDynamics === 'sticky_moneyness' ? 'sticky moneyness' : 'sticky strike';
  const basis = input.futureBasis === 'decay' ? '減衰' : '固定';
  return `β ${fmtNum(fin(s.beta), 1)} · ${dyn} · basis ${basis} · ΔX ${input.dXUnit === 'yen' ? '円' : '%'}`;
}

export function dynamicsAction(v: IvDynamics): Action {
  return { type: 'setScenario', patch: { ivDynamics: v } };
}

export function basisAction(v: FutureBasis): Action {
  return { type: 'setFutureBasis', basis: v };
}

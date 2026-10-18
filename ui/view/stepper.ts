/**
 * ステッパー（#81。docs/ui-redesign.md §5・§4.2）の規則。部品は ui/next/parts/Stepper.tsx。
 * #83: スクラブ・ホイール・全キー・Shift の大きな段・端数を保つ段（d）・± の長押しの連続・数値入力の長押し。
 */

import { LONG_PRESS_MS, TAP_MOVE_PX } from '../chart/gesture';

export interface StepSpec {
  min: number;
  max: number;
  step: number;
  /** 既定値（違えば強調色 .hot） */
  def: number;
}

/** step の小数の桁数（0.1 → 1、0.25 → 2、1 → 0） */
function decimals(step: number): number {
  const s = String(step);
  const e = s.indexOf('e-');
  if (e >= 0) return Number(s.slice(e + 2));
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

/**
 * 段の整数で ±n 動かす: n0 = round((v − min) / step) に n を足し、min + n·step を step の小数桁で丸める
 * （0.2 + 0.1 を 0.30000000000000004 にしない）。範囲で止める。
 */
export function stepBy(spec: StepSpec, value: number, n: number): number {
  const { min, max, step } = spec;
  const digits = Math.max(decimals(step), decimals(min));
  const k = Math.round((value - min) / step) + n;
  const v = round(min + k * step, digits);
  return Math.min(max, Math.max(min, v));
}

/** 既定値と違うか（段の 1e-9 以内は同じとみなす） */
export function isHot(spec: StepSpec, value: number): boolean {
  return Math.abs(value - spec.def) > spec.step * 1e-9;
}

/** ↑ で +1、↓ で −1、ほかは 0 */
export function stepKey(key: string): -1 | 0 | 1 {
  if (key === 'ArrowUp') return 1;
  if (key === 'ArrowDown') return -1;
  return 0;
}

// ---------------------------------------------------------------- #83 の操作

/** スクラブ: この px で 1 段 */
export const SCRUB_PX = 8;
/** Shift + クリック・Shift + 矢印・PageUp / PageDown の段の数 */
export const BIG_STEPS = 10;
/** ± の長押し: 連続が始まるまでの待ち（ms） */
export const REPEAT_DELAY_MS = 400;
/** ± の長押し: 連続の間隔（ms） */
export const REPEAT_INTERVAL_MS = 80;
/** 数値入力を開くタッチの長押し（ms。舞台の長押しと同じ） */
export const EDIT_HOLD_MS = LONG_PRESS_MS;
/** 長押しを取り消す移動量（px。舞台のタップと同じ） */
export const EDIT_MOVE_PX = TAP_MOVE_PX;

/** 押した位置からの横の移動量（px）→ 累計の段（0 に向けて切り捨て）。DOM は「今の累計 − 反映済み」だけ動かす */
export function scrubSteps(dx: number): number {
  return Number.isFinite(dx) ? Math.trunc(dx / SCRUB_PX) || 0 : 0;
}

/** ホイール 1 イベント → 段（上 = +1、下 = −1） */
export function wheelStep(deltaY: number): -1 | 0 | 1 {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return deltaY < 0 ? 1 : -1;
}

export type StepperKeyResult = { n: number } | { to: 'min' | 'max' | 'def' } | null;

/**
 * 値にフォーカスしたキー（§4.2）: ↑ / → +1、↓ / ← −1、Shift + 矢印・PageUp / PageDown ±10、Home / End 端、
 * R 既定値。+ / − / = などは扱わない（null。拡大縮小は舞台のキー）。
 */
export function stepperKey(key: string, shift: boolean): StepperKeyResult {
  const big = shift ? BIG_STEPS : 1;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      return { n: big };
    case 'ArrowDown':
    case 'ArrowLeft':
      return { n: -big };
    case 'PageUp':
      return { n: BIG_STEPS };
    case 'PageDown':
      return { n: -BIG_STEPS };
    case 'Home':
      return { to: 'min' };
    case 'End':
      return { to: 'max' };
    case 'r':
    case 'R':
      return { to: 'def' };
    default:
      return null;
  }
}

/** ± のクリック 1 回の段（Shift で 10） */
export function clickSteps(shift: boolean): number {
  return shift ? BIG_STEPS : 1;
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * 格子に寄せない段（d。§4.2）: 範囲に収めた今の値に n·step を足し、範囲で止める（#82 の stageKey の [ ] と同じ演算順）。
 * 非有限の値は既定値から。
 */
export function stepFree(spec: StepSpec, value: number, n: number): number {
  const { min, max, step } = spec;
  const cur = clampTo(Number.isFinite(value) ? value : spec.def, min, max);
  return clampTo(cur + n * step, min, max);
}

/**
 * n 段動かす（keepFraction なら stepFree、なければ stepBy の格子）。範囲の外の値（数値欄で入れた ΔX の −95% など。
 * #144）からは押した向きと逆に動かさない（下端の外で − は動かず + は下端へ、上端の外で − は上端へ）。
 */
export function stepperMove(
  spec: StepSpec,
  value: number,
  n: number,
  keepFraction: boolean,
): number {
  const v = keepFraction ? stepFree(spec, value, n) : stepBy(spec, value, n);
  return (n < 0 && v > value) || (n > 0 && v < value) ? value : v;
}

/**
 * Home / End / R の行き先。value（今の値）が範囲の外で、端へ行くと逆向きになるなら value のまま（#144。
 * 下端の外で Home、上端の外で End）。R は常に既定値。
 */
export function stepperJump(spec: StepSpec, to: 'min' | 'max' | 'def', value?: number): number {
  if (to === 'def') return spec.def;
  if (value !== undefined) {
    if (to === 'min' && value < spec.min) return value;
    if (to === 'max' && value > spec.max) return value;
  }
  return to === 'min' ? spec.min : spec.max;
}

/**
 * ± の長押し: 押してからの経過（ms）→ それまでに動かした段の累計。押した瞬間に 1、REPEAT_DELAY_MS で 2、
 * 以後 REPEAT_INTERVAL_MS ごとに +1（単調非減少、1 以上）。
 */
export function repeatSteps(elapsedMs: number): number {
  if (!(elapsedMs >= REPEAT_DELAY_MS)) return 1;
  return 2 + Math.floor((elapsedMs - REPEAT_DELAY_MS) / REPEAT_INTERVAL_MS);
}

export type EditOutcome =
  | { type: 'keep' }
  | { type: 'set'; value: number }
  | { type: 'invalid'; message: string };

/**
 * 数値入力の確定（Enter / フォーカスが外れたとき）: 開いたときの文字列から変わっていなければ keep（何もしない。
 * 欄の文字列は丸めた値なので、確定すると端数の d・β などが変わる・上限の d が範囲外で拒否されるため）。
 * 変わっていれば parse の結果（正しければ set、正しくなければ invalid）。前後の空白は比べない。
 */
export function editOutcome(
  opened: string,
  text: string,
  parse: (text: string) => { ok: true; value: number } | { ok: false; message: string },
): EditOutcome {
  if (text.trim() === opened.trim()) return { type: 'keep' };
  const r = parse(text);
  return r.ok ? { type: 'set', value: r.value } : { type: 'invalid', message: r.message };
}

/**
 * 段の起点（B-2）。sent = 最後に送ってまだ props に届いていない値（無ければ null）。
 * 描画で props の値が変わったら（送った値が届いた・ほかの操作で変わった・送る前の値に戻った のどれでも）sent を捨てる
 * （`sentAfterProps`）。起点は「まだ反映していないフレームの値（pending）→ sent → props」の順。
 */
export function sentAfterProps(
  sent: number | null,
  prevValue: number,
  value: number,
): number | null {
  return Object.is(prevValue, value) ? sent : null;
}

export function stepOrigin(pending: number | null, sent: number | null, value: number): number {
  return pending ?? sent ?? value;
}

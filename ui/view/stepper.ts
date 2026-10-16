/**
 * ステッパー（#81。docs/ui-redesign.md §5・§4.2）の規則。部品は ui/next/parts/Stepper.tsx。
 * スクラブ・ホイール・数値入力・Shift の大きな段は #83。
 */

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

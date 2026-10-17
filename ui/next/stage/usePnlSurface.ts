import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Scenario } from '../../../model';
import type { Domain } from '../../chart/scale';
import type { PnlBase } from '../../view/pnlChart';
import {
  planSurface,
  SURFACE_SETTLE_MS,
  type SurfaceGrid,
  type SurfacePlan,
  surfaceDeps,
  surfaceGrid,
} from '../../view/pnlSurface';

/**
 * 面モードの格子（docs/ui-redesign.md §6。#88 段 A）。DOM を持たないフック。規則は ui/view/pnlSurface.ts の
 * planSurface: 入力（基礎・表示範囲・Δσ・Δs・β・動き方・ivShift）が変わったフレームは粗い格子、120ms 変化が
 * 無ければ細かい格子で 1 回。ΔX・d は依存に入れない（同じ参照を返す）。on = false では作らない。
 */
export function usePnlSurface(p: {
  on: boolean;
  base: PnlBase | null;
  scenario: Scenario;
  viewport: Domain | null;
}): SurfaceGrid | null {
  const { on, base, scenario, viewport } = p;
  const [settle, setSettle] = useState(0);
  const planRef = useRef<SurfacePlan | null>(null);
  const gridRef = useRef<SurfaceGrid | null>(null);
  const { dSigma, skew, beta, ivDynamics, ivShift } = scenario;
  const lo = viewport?.[0] ?? null;
  const hi = viewport?.[1] ?? null;
  // ΔX・d は面の値に効かないので依存に入れない（scenario の欄を個別に見る）
  const grid = useMemo(() => {
    if (!on) {
      planRef.current = null;
      gridRef.current = null;
      return null;
    }
    const deps = surfaceDeps(base, scenario, viewport);
    const plan = planSurface(planRef.current, deps, settle);
    if (plan === null) {
      planRef.current = null;
      gridRef.current = null;
      return null;
    }
    if (plan !== planRef.current || gridRef.current === null) {
      planRef.current = plan;
      gridRef.current = surfaceGrid(base, scenario, viewport, plan.res);
    }
    return gridRef.current;
  }, [on, base, lo, hi, dSigma, skew, beta, ivDynamics, ivShift, settle]);
  // 粗い格子を描いたら、120ms 変化が無ければ細かい格子にする（次の粗いフレームで待ち直す）
  useEffect(() => {
    if (grid?.res !== 'coarse') return;
    const t = setTimeout(() => setSettle((n) => n + 1), SURFACE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [grid]);
  return grid;
}

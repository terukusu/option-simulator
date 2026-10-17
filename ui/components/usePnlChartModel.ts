/**
 * 損益グラフの表示モデルの memo の連鎖（DOM・CSS を持たないフック）。旧画面の PnlChart と新しい画面の舞台
 * （ui/next/regions/Stage.tsx）が共有する（#82。docs/ui-redesign.md §10 段 1 d・§10.1）。
 *
 * - 今日の線は表示範囲・幅・β・動き方が変わったときだけ作る（#6）
 * - 指定日の線は ΔX で作り直さない（#52）
 * - ピンの線は前回分を使い回し、拡大縮小のフレームは点数を落として、止まって PIN_SETTLE_MS 経ったら描き直す（#22）
 * - pnlChartModel・pinLabels・scenarioMarks はその後（入力が変わったときだけ）
 *
 * 依存配列は旧 PnlChart.tsx のものをそのまま写した（1 つでも変えると perf の前提が崩れる）。
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Scenario } from '../../model';
import type { Domain } from '../chart/scale';
import { PIN_MAX_SAMPLES, PIN_SETTLE_MS, type PinLineMode, type PinNo } from '../pins';
import type { AmountUnit } from '../view/metrics';
import {
  cachedPinLines,
  type PinLineCacheEntry,
  type PinLineData,
  type PinTarget,
  pinLabels,
  pinSampleCap,
} from '../view/pins';
import {
  dateLine,
  type PnlBase,
  type PnlChartModel,
  type PnlYSettings,
  pnlChartModel,
  pnlViewDomain,
  todayLine,
} from '../view/pnlChart';
import { type ScenarioMarks, scenarioMarks } from '../view/scenarioMarks';

export interface PnlChartModelInput {
  base: PnlBase | null;
  scenario: Scenario;
  viewport: Domain | null;
  pnlY: PnlYSettings;
  plotWidth: number;
  plotHeight: number;
  /** 表示中の限月のシナリオ ATM（#26） */
  scenarioAtm: { monthId: string; k: number; F: number } | null;
  /** ピン（#22。描く対象） */
  pins: readonly PinTarget[];
  pinLine: PinLineMode;
  /** 交点のラベルの金額の単位（指標の単位） */
  amountUnit: AmountUnit;
}

export interface PnlChartModelOutput {
  model: PnlChartModel;
  pinMarks: ReturnType<typeof pinLabels>;
  marks: ScenarioMarks | null;
}

export function usePnlChartModel({
  base,
  scenario,
  viewport,
  pnlY,
  plotWidth,
  plotHeight,
  scenarioAtm,
  pins,
  pinLine,
  amountUnit,
}: PnlChartModelInput): PnlChartModelOutput {
  // 今日の線はシナリオ IV を掛けない（d・ΔX・Δσ・Δs のスライダーで変わらない）ので、表示範囲・幅・β・動き方が
  // 変わったときだけ作る（#6。スライダー 1 回の描き直しを指定日の線 + 指標に絞る）
  const { beta, ivDynamics, ivShift } = scenario;
  const todayYs = useMemo(
    () => todayLine(base, viewport, plotWidth, scenario),
    // scenario の他の値（d・ΔX・Δσ・Δs）は今日の線に効かないので追わない
    [base, viewport, plotWidth, beta, ivDynamics, ivShift],
  );
  // 指定日の線は ΔX で形が変わらない（β は評価点 X' ごと）ので、長押しドラッグ・ΔX のスライダーでは作り直さない
  // （#52。ΔX 以外のシナリオ・表示範囲・幅が変わったときだけ）
  const { days, dSigma, skew } = scenario;
  const dateYs = useMemo(
    () => dateLine(base, viewport, plotWidth, scenario),
    // ΔX は指定日の線に効かないので追わない
    [base, viewport, plotWidth, days, dSigma, skew, beta, ivDynamics, ivShift],
  );
  // ピンの線（#22）: 前回分を使い回す（ゴーストはスライダー・長押しドラッグで作り直さない。重ねは ΔX 以外のシナリオで
  // 作り直す）。表示範囲・幅・線の切替が変わったら作り直す。拡大縮小（表示範囲の幅が変わる）のフレームは点数を
  // PIN_ZOOM_MAX_SAMPLES に下げ、止まって PIN_SETTLE_MS 経ったら通常の点数で描き直す（S1。止まった後の値は同じ）
  const domain = base ? pnlViewDomain(base, viewport) : null;
  const lo = domain ? domain[0] : Number.NaN;
  const hi = domain ? domain[1] : Number.NaN;
  const pinCache = useRef<Map<PinNo, PinLineCacheEntry>>(new Map());
  const pinSpan = useRef<number | null>(null);
  const [pinSettle, setPinSettle] = useState(0);
  const pinData = useMemo(() => {
    const dom: Domain | null = Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
    const cap = pinSampleCap(pinSpan.current, dom);
    pinSpan.current = dom ? hi - lo : null;
    const next = cachedPinLines(pinCache.current, pins, dom, plotWidth, pinLine, cap);
    pinCache.current = next;
    const lines: PinLineData[] = [];
    for (const t of pins) {
      const d = next.get(t.no)?.data;
      if (d) lines.push(d);
    }
    return { lines, coarse: cap < PIN_MAX_SAMPLES && lines.length > 0 };
    // pinSettle: 拡大縮小が止まった後の描き直しの合図（幅は同じなので通常の点数になる）
  }, [pins, lo, hi, plotWidth, pinLine, pinSettle]);
  useEffect(() => {
    if (!pinData.coarse) return;
    // 次の拡大縮小のフレームが来たら取り消して待ち直す（操作が止まってから 1 回だけ描き直す）
    const id = setTimeout(() => setPinSettle((n) => n + 1), PIN_SETTLE_MS);
    return () => clearTimeout(id);
  }, [pinData]);
  const model = useMemo(
    () =>
      pnlChartModel({
        base,
        scenario,
        viewport,
        pnlY,
        plotWidth,
        plotHeight,
        todayYs,
        dateYs,
        scenarioAtm,
        pins: pinData.lines,
      }),
    [base, scenario, viewport, pnlY, plotWidth, plotHeight, todayYs, dateYs, scenarioAtm, pinData],
  );
  const pinMarks = useMemo(() => pinLabels(model), [model]);
  // シナリオ点の縦線と線の交点・金額のラベル（#52。ΔX = 0 でも X₀ 上に出す）
  const marks = useMemo(
    () => scenarioMarks({ base, scenario, chart: model, unit: amountUnit }),
    [base, scenario, model, amountUnit],
  );
  return { model, pinMarks, marks };
}

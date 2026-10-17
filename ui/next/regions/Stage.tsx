import type { MutableRef } from 'preact/hooks';
import { useLayoutEffect, useMemo } from 'preact/hooks';
import type { Domain } from '../../chart/scale';
import type { AppController } from '../../components/useAppController';
import { usePnlChartModel } from '../../components/usePnlChartModel';
import { bigReadout, stageFrame } from '../../view/stage';
import { BigReadout } from '../stage/BigReadout';
import { IvRail } from '../stage/IvRail';
import { PnlPlot } from '../stage/PnlPlot';
import { StageHead } from '../stage/StageHead';
import { TimeRail } from '../stage/TimeRail';
import { useSize } from '../useSize';

/**
 * 舞台（docs/ui-redesign.md §2・§4.1・§5・§8。#82）: 凡例行 → 描画域 + IV レール（右）→ 時間レール → 読み取り。
 * 表示モデルの memo の連鎖は旧画面と同じ usePnlChartModel、付属の表示モデルは ui/view/stage.ts。
 * 状態は reducer の action だけ（マーカーのドラッグ中の K は PnlPlot のローカル）。
 * mini = スマホでシートを全開にした舞台（92px）: 線と読み取りだけ（凡例行・レールは出さない）。
 */
export function Stage(p: {
  c: AppController;
  selectedLeg: number | null;
  mini: boolean;
  onPickLeg: (id: number) => void;
  onChangeStrike: (id: number, k: number) => void;
  /** 今の縦軸の範囲（#87 (C): 設定の縦軸を手動に切り替えたときの初期値。描いた後に入れる = 描き直しは増えない） */
  yNow?: MutableRef<Domain | null>;
}) {
  const { c, mini } = p;
  const { state, dispatch, pnlBase: base, metrics } = c;
  const { scenario } = state;
  const { ref, width, height } = useSize<HTMLDivElement>(320, 160);
  const frame = stageFrame(width, height, mini);
  const { model, pinMarks, marks } = usePnlChartModel({
    base,
    scenario,
    viewport: state.pnlViewport,
    pnlY: state.pnlY,
    plotWidth: frame.plotWidth,
    plotHeight: frame.plotHeight,
    scenarioAtm: c.scenarioAtmView,
    pins: c.pinTargets,
    pinLine: c.pinLine,
    amountUnit: metrics.unit,
  });
  // 描画の後に入れる（描画中に ref へ書かない）
  const { yNow } = p;
  const yDomain = model.yDomain;
  useLayoutEffect(() => {
    if (yNow) yNow.current = yDomain;
  }, [yNow, yDomain]);
  const evalTime = base?.ctx.evalTime ?? null;
  const items = useMemo(
    () => bigReadout(c.readout, metrics.empty ? null : metrics.premium, evalTime, scenario.dSigma),
    [c.readout, metrics, evalTime, scenario.dSigma],
  );
  return (
    <>
      {!mini && (
        <StageHead
          model={model}
          noLegs={!base}
          scenario={scenario}
          pnlY={state.pnlY}
          pins={c.pinTargets}
          pinLine={c.pinLine}
          pinTabs={c.pinTabs}
          onPinCurrent={c.pinCurrent}
          onZoom={c.onZoom}
          dispatch={dispatch}
        />
      )}
      <div class="panel-body stage-main">
        <div class="stage-body">
          <PnlPlot
            chartRef={ref}
            width={width}
            height={height}
            frame={frame}
            model={model}
            marks={marks}
            pinMarks={pinMarks}
            base={base}
            boardX0={c.positions?.ctx.x0 ?? Number.NaN}
            chain={c.chain}
            scenario={scenario}
            legs={c.curLegs}
            legCount={c.curLegs.length}
            selectedLeg={p.selectedLeg}
            mini={mini}
            dispatch={dispatch}
            onPickLeg={p.onPickLeg}
            onChangeStrike={p.onChangeStrike}
          />
          {!mini && <IvRail value={scenario.dSigma} dispatch={dispatch} />}
        </div>
        {!mini && (
          <TimeRail
            days={scenario.days}
            maxDays={base?.maxDays ?? 0}
            evalTime={evalTime}
            targets={c.targets}
            dispatch={dispatch}
          />
        )}
        <BigReadout items={items} mini={mini} />
      </div>
    </>
  );
}

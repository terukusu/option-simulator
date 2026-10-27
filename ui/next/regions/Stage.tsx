import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AppController } from '../../components/useAppController';
import { useMarginLine } from '../../components/useMarginLine';
import { usePnlChartModel } from '../../components/usePnlChartModel';
import { LIVE_SETTLE_MS, liveBurst } from '../../view/motion';
import { pinPopRows } from '../../view/pins';
import { surfaceActive, surfaceLegend } from '../../view/pnlSurface';
import type { ChartMode } from '../../view/shell';
import { bigReadout, stageFrame } from '../../view/stage';
import { liveHold, livePulse, useLiveAttr } from '../live';
import { BigReadout } from '../stage/BigReadout';
import { IvRail } from '../stage/IvRail';
import { PnlPlot } from '../stage/PnlPlot';
import { StageHead } from '../stage/StageHead';
import { TimeRail } from '../stage/TimeRail';
import { usePnlSurface } from '../stage/usePnlSurface';
import { useSize } from '../useSize';

const sameStrings = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 舞台の描画域・レール・読み取りの上の押下（ハンドル・パン・ピンチ・足マーカー・面の点・IV / 時間レール）: 離すまで
 * `.live`（§6）。pointerup / pointercancel はどこで離しても window で受ける（blur・タブが隠れたときは liveHold が離す）
 */
function onStagePointerDown(e: PointerEvent) {
  const id = e.pointerId;
  // blur・タブが隠れて離したときも購読を外す（タッチは pointerId が毎回変わるので、残すと溜まる。#123）
  const release = liveHold(() => {
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  });
  function up(ev: PointerEvent) {
    if (ev.pointerId === id) release();
  }
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

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
  /** グラフの表示（#88。ミニはモードを保ったまま線で描く） */
  chart: ChartMode;
  onChart: (chart: ChartMode) => void;
  /** テーマの解決値（面の色を読み直す） */
  theme: 'dark' | 'light';
  onPickLeg: (id: number) => void;
  onChangeStrike: (id: number, k: number) => void;
}) {
  const { c, mini } = p;
  const { state, dispatch, pnlBase: base, metrics } = c;
  const { scenario } = state;
  const { ref, width, height } = useSize<HTMLDivElement>(320, 160);
  const frame = stageFrame(width, height, mini);
  // 追証の線（#131）: 止まってから作る（ミニの舞台には描かないので作らない）
  const marginLine = useMarginLine(mini ? null : c.marginLineInput);
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
    marginLine,
  });
  // 動き（§6。#91 段 C）: 連続の変更の間は .stage-main の data-live（押下・パルス。ui/next/live.ts が直接入れる）と
  // .live（舞台の大きさの変化・連打。描画の中で前の値と比べて同じ描画で付け、パルスで data-live に引き継ぐ。effect で後から
  // 付けるとその 1 フレームだけ補間が走る）で補間を切る
  const mainRef = useRef<HTMLDivElement>(null);
  useLiveAttr(mainRef);
  const lastSize = useRef<{ width: number; height: number } | null>(null);
  const resized =
    lastSize.current !== null &&
    (lastSize.current.width !== width || lastSize.current.height !== height);
  useLayoutEffect(() => {
    const last = lastSize.current;
    lastSize.current = { width, height };
    if (last && (last.width !== width || last.height !== height)) livePulse();
  }, [width, height]);
  // 連打（前の線の変化から LINE_MS 未満で続く離散の変更 = キー・± のクリックの連打）も連続の変更として同じ描画で切る。
  // 線が変わったかは d の文字列で見る（model は描き直しのたびに作り直されることがある）
  const ds = model.lines.map((l) => l.d);
  const lastDs = useRef(ds);
  const lastLinesAt = useRef(Number.NEGATIVE_INFINITY);
  const linesChanged = !sameStrings(lastDs.current, ds);
  const burst = linesChanged && liveBurst(lastLinesAt.current, performance.now());
  useLayoutEffect(() => {
    if (!linesChanged) return;
    const t = performance.now();
    if (liveBurst(lastLinesAt.current, t)) livePulse();
    lastDs.current = ds;
    lastLinesAt.current = t;
  });
  // .live は描画で付けるので、次の描画が来ないと残る。最後に付けた描画から LIVE_SETTLE_MS で 1 回だけ描き直して外す
  // （その間は data-live のパルスが補間を切っている。続けて変われば次の描画で待ち直す）
  const liveClass = resized || burst;
  const [, settle] = useState(0);
  useEffect(() => {
    if (!liveClass) return;
    const id = setTimeout(() => settle((n) => n + 1), LIVE_SETTLE_MS);
    return () => clearTimeout(id);
  });
  // 面モード（#88）: 格子は入力が変わったフレームは粗く、止まったら細かく（usePnlSurface）。ミニ・空は線モードの表示
  const surfaceOn = surfaceActive(p.chart, mini, model.empty);
  const grid = usePnlSurface({
    on: surfaceOn,
    base,
    scenario,
    viewport: state.pnlViewport,
  });
  const legend = useMemo(
    () => (surfaceOn ? surfaceLegend(grid?.vmax ?? null, metrics.unit) : null),
    [surfaceOn, grid, metrics.unit],
  );
  // 凡例の ①②③ のポップオーバーの行（#125）。シナリオ点 = 指標と同じ X₀ + ΔX（足が無ければ NaN = —）
  const scenarioX = metrics.empty ? Number.NaN : metrics.scenarioPoint.x;
  const pinRows = useMemo(
    () =>
      mini
        ? []
        : pinPopRows({
            targets: c.pinTargets,
            mode: c.pinLine,
            scenarioX,
            unit: metrics.unit,
          }),
    [mini, c.pinTargets, c.pinLine, scenarioX, metrics.unit],
  );
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
          pinRows={pinRows}
          pinLine={c.pinLine}
          pinTabs={c.pinTabs}
          onPinCurrent={c.pinCurrent}
          onZoom={c.onZoom}
          chart={p.chart}
          onChart={p.onChart}
          surfaceLegend={legend}
          dispatch={dispatch}
        />
      )}
      <div
        ref={mainRef}
        class={liveClass ? 'panel-body stage-main live' : 'panel-body stage-main'}
        onPointerDownCapture={onStagePointerDown}
        onWheelCapture={livePulse}
      >
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
            surfaceOn={surfaceOn}
            surface={grid}
            unit={metrics.unit}
            theme={p.theme}
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

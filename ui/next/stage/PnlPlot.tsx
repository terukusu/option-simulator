import type { RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Chain } from '../../../data';
import type { Scenario } from '../../../model';
import { type Domain, pixelToValue } from '../../chart/scale';
import { useChartGestures } from '../../components/useChartGestures';
import type { Action, UiLeg } from '../../state';
import { fmtNum } from '../../view/format';
import type { AmountUnit } from '../../view/metrics';
import type { PinLabel } from '../../view/pins';
import { type PnlBase, type PnlChartModel, Y_UNIT_LABEL } from '../../view/pnlChart';
import {
  parseCssColor,
  SURFACE_Y_UNIT,
  type SurfaceColors,
  type SurfaceGrid,
  surfaceDayTicks,
  surfaceDragPatch,
  surfaceImage,
  surfacePoint,
} from '../../view/pnlSurface';
import { dXFromAxis } from '../../view/scenario';
import type { ScenarioMarks } from '../../view/scenarioMarks';
import {
  emptyStageGrid,
  ivRailObstacle,
  legMarkers,
  MARKER_BAND_PX,
  type StageFrame,
  stageFill,
  stageHandle,
  stageKey,
  stageMarkLabels,
  strikeAtPx,
} from '../../view/stage';
import { SurfaceCanvas } from './SurfaceCanvas';

/** ハンドルをつかむ幅（左右 px。§4.1。旧画面は 12 のまま） */
const STAGE_GRAB_PX = 14;

const KIND_CLASS = { expiry: 'expiry', date: 'date', today: 'today' } as const;

const LINE_LABEL =
  '損益グラフ（ドラッグでパン、ホイール・ピンチで拡大、ダブルクリックでリセット、ハンドルをつかむか長押しして左右にドラッグでシナリオ点 ΔX、足のマーカーで足を選ぶ・長押しして横にドラッグで行使価格。キー: ← / → ΔX ∓100 円（Shift で 1,000 円）、↑ / ↓ Δσ ±0.5pt、[ / ] 経過日数 ∓1 日、0 シナリオを 0 に、+ / − 拡大縮小、R リセット）';
const SURFACE_LABEL =
  '損益の面（横 原資産・縦 経過日数・色 損益。描画域を押してドラッグでシナリオ点の ΔX と経過日数 d を同時に動かす、2 本指・横ホイールでパン、ホイール・ピンチで拡大、ダブルクリック / ダブルタップでリセット、足のマーカーで足を選ぶ・長押しして横にドラッグで行使価格。キー: ← / → ΔX ∓100 円（Shift で 1,000 円）、↑ / ↓ Δσ ±0.5pt、[ / ] 経過日数 ∓1 日、0 シナリオを 0 に、+ / − 拡大縮小、R リセット）';

/** 面の両極の色（テーマの --gain / --loss を読む。読めなければ null = 面を描かない） */
function readSurfaceColors(): SurfaceColors | null {
  const cs = getComputedStyle(document.documentElement);
  const gain = parseCssColor(cs.getPropertyValue('--gain'));
  const loss = parseCssColor(cs.getPropertyValue('--loss'));
  return gain && loss ? { gain, loss } : null;
}

/**
 * 舞台の描画域（docs/ui-redesign.md §4.1・§8。#82）。線・目盛り・BEP・X₀・シナリオ ATM・ピンは pnlChartModel の
 * 出力、ハンドル・塗り・足マーカー・ラベルの退避は ui/view/stage.ts。位置はすべて SVG の属性（style を使わない）。
 * ジェスチャーは useChartGestures（規則は ui/chart/gesture.ts）。ミニ（シート全開）は線だけで操作を受けない。
 * 面モード（#88 段 B）: 描画域を押すとすぐ面の点をつかみ、位置 → (ΔX, d) を 1 フレーム 1 回の setScenario に入れる
 * （surfaceDragPatch）。2 本目の指・cancel は押す前の値に戻す。つかんでいる間は .live。
 */
export function PnlPlot(p: {
  chartRef: RefObject<HTMLDivElement>;
  width: number;
  height: number;
  frame: StageFrame;
  model: PnlChartModel;
  marks: ScenarioMarks | null;
  pinMarks: readonly PinLabel[];
  base: PnlBase | null;
  /** 板の X₀（足 0 本でも板があれば決まる。無ければ NaN）。空の格子の横軸に使う（#111） */
  boardX0: number;
  chain: Chain | null;
  scenario: Scenario;
  legs: readonly UiLeg[];
  legCount: number;
  selectedLeg: number | null;
  mini: boolean;
  /** 面モード（ミニでは false。#88） */
  surfaceOn: boolean;
  /** 面の格子（面モードで作れたとき。maxDays ≤ 0 などは null = canvas に描かない） */
  surface: SurfaceGrid | null;
  /** 指標の金額の単位（面の点のラベル） */
  unit: AmountUnit;
  /** テーマの解決値（変わったら面の色を読み直す） */
  theme: 'dark' | 'light';
  dispatch: (a: Action) => void;
  onPickLeg: (id: number) => void;
  onChangeStrike: (id: number, k: number) => void;
}) {
  const { model, marks, base, scenario, frame, mini, dispatch } = p;
  const surfaceOn = p.surfaceOn && !mini && !model.empty;
  const [dragK, setDragK] = useState<{ id: number; k: number } | null>(null);
  /** 面の点をつかんでいる間（.live）と、押す前の ΔX・d（取り消しで戻す） */
  const [live, setLive] = useState(false);
  const surfaceBefore = useRef<{ dX: number; days: number } | null>(null);
  // つかんでいる間に面モードでなくなった（線へ・ミニ・足が無くなった）ら .live と押す前の値を捨てる
  useEffect(() => {
    if (surfaceOn) return;
    surfaceBefore.current = null;
    setLive(false);
  }, [surfaceOn]);
  const handle = useMemo(() => stageHandle(model, marks), [model, marks]);
  // 面モードでは塗り・交点のラベルを作らない（描かない）
  const fill = useMemo(
    () => (surfaceOn ? { gain: '', loss: '' } : stageFill(model)),
    [model, surfaceOn],
  );
  const markers = useMemo(
    () => legMarkers(p.legs, base, model, { selected: p.selectedLeg, drag: dragK }),
    [p.legs, base, model, p.selectedLeg, dragK],
  );
  // 交点のラベルは IV レールの吹き出し（描画域の右に重ねて描く。レールは同じ高さで右隣）も避ける
  const dSigma = scenario.dSigma;
  const labels = useMemo(() => {
    if (!marks || surfaceOn) return [];
    const obstacles = mini ? [] : [ivRailObstacle(dSigma, p.height, p.width + frame.offsetX)];
    return stageMarkLabels(marks, model, obstacles);
  }, [marks, model, mini, surfaceOn, dSigma, p.height, p.width, frame.offsetX]);
  // 面: 色（テーマが変わったら読み直す。テーマの属性は親のレイアウトの effect が入れるので passive で読む）
  const [colors, setColors] = useState<SurfaceColors | null>(null);
  const { theme } = p;
  useEffect(() => {
    if (!surfaceOn) return;
    const next = readSurfaceColors();
    setColors((c) =>
      c && next && c.gain.join() === next.gain.join() && c.loss.join() === next.loss.join()
        ? c
        : next,
    );
  }, [theme, surfaceOn]);
  const surface = surfaceOn ? p.surface : null;
  const image = useMemo(
    () => (surface && colors ? surfaceImage(surface, colors) : null),
    [surface, colors],
  );
  const surfMaxDays = base?.maxDays ?? 0;
  const dayTicks = useMemo(
    () => (surfaceOn ? surfaceDayTicks(model.plot, surfMaxDays) : []),
    [surfaceOn, model.plot, surfMaxDays],
  );
  const { unit: amountUnit } = p;
  const point = useMemo(
    () =>
      surfaceOn
        ? surfacePoint({
            base,
            scenario,
            chart: model,
            handle,
            unit: amountUnit,
            obstacles: [ivRailObstacle(dSigma, p.height, p.width + frame.offsetX)],
          })
        : null,
    [
      surfaceOn,
      base,
      scenario,
      model,
      handle,
      amountUnit,
      dSigma,
      p.height,
      p.width,
      frame.offsetX,
    ],
  );
  // 足が無い（評価できる足が無い）ときの格子（#111。ミニは今のまま描かない）
  const emptyGrid = useMemo(
    () =>
      model.empty && !mini
        ? emptyStageGrid({
            x0: p.boardX0,
            plotWidth: frame.plotWidth,
            plotHeight: frame.plotHeight,
          })
        : null,
    [model.empty, mini, p.boardX0, frame.plotWidth, frame.plotHeight],
  );
  const { plot } = model;
  const ox = frame.offsetX;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const range: Domain = [plot.left - ox, right - ox];
  const x0 = base?.ctx.x0 ?? Number.NaN;
  const maxDays = base?.maxDays ?? 0;
  /** 面の点の画素（要素の座標） */
  const pointPx = point ? { x: point.px - ox, y: point.py - frame.offsetY } : null;
  const endSurface = () => {
    surfaceBefore.current = null;
    setLive(false);
  };

  /** 足の限月の板の行と F（行使価格の吸い付き） */
  const strikeAt = (id: number, x: number): number | null => {
    const leg = p.legs.find((l) => l.id === id)?.leg;
    if (leg?.kind !== 'option' || !base || !p.chain) return null;
    const expiry = leg.expiry;
    const month = p.chain.months.find((m) => m.id === expiry);
    const F = base.ctx.options[expiry]?.forward ?? Number.NaN;
    return month ? strikeAtPx(x + ox, month.rows, F, x0, base.settings, model) : null;
  };

  useChartGestures(p.chartRef, {
    viewport: model.domain,
    full: model.full,
    minWidth: model.minWidth,
    range,
    disabled: model.empty || mini,
    onViewport: (v) => dispatch({ type: 'setPnlViewport', viewport: v }),
    // 線モード: ハンドル（ΔX = 0 でも X₀ 上）の ±14px で即つかむ。それ以外は長押しでつかむ → ΔX（10 円の格子）
    // 面モード: 押すとすぐ面の点（点の ±14px は飛ばない）→ ΔX と d を同時に（scrub は渡さない）
    ...(surfaceOn
      ? {
          surface: { pointPx, grabPx: STAGE_GRAB_PX },
          onSurfaceStart: () => {
            surfaceBefore.current = { dX: scenario.dX, days: scenario.days };
            setLive(true);
          },
          onSurface: (x: number, y: number) => {
            const patch = surfaceDragPatch({
              x,
              y,
              chart: model,
              offsetX: ox,
              offsetY: frame.offsetY,
              x0,
              maxDays,
              scenario,
              pointPx,
            });
            if (patch) dispatch({ type: 'setScenario', patch });
          },
          onSurfaceEnd: endSurface,
          onSurfaceCancel: () => {
            const before = surfaceBefore.current;
            if (before) dispatch({ type: 'setScenario', patch: before });
            endSurface();
          },
        }
      : {
          scrub: { linePx: handle ? handle.px - ox : null, grabPx: STAGE_GRAB_PX },
          onScrub: (px: number) => {
            const dX = dXFromAxis(pixelToValue(model.domain, range, px), x0);
            if (dX !== null && dX !== scenario.dX) dispatch({ type: 'setScenario', patch: { dX } });
          },
        }),
    arrowPan: false,
    onScrubKey: (key, shift) => {
      const r = stageKey(key, shift, scenario, { x0, maxDays });
      if (r === null) return false;
      if ('reset' in r) dispatch({ type: 'resetScenario' });
      else dispatch({ type: 'setScenario', patch: r.patch });
      return true;
    },
    markers: {
      band: [bottom - MARKER_BAND_PX - frame.offsetY, bottom - frame.offsetY],
      items: markers.map((m) => ({ id: m.id, px: m.px - ox, drag: m.draggable })),
    },
    onMarkerTap: (id) => p.onPickLeg(id),
    onMarkerDrag: (id, x) => {
      const k = strikeAt(id, x);
      if (k !== null) setDragK((d) => (d && d.id === id && d.k === k ? d : { id, k }));
    },
    onMarkerDrop: (id, x) => {
      const k = strikeAt(id, x);
      setDragK(null);
      const ui = p.legs.find((l) => l.id === id);
      if (k !== null && ui?.leg.kind === 'option' && k !== ui.leg.strike) p.onChangeStrike(id, k);
    },
    onMarkerCancel: () => setDragK(null),
    onLongPress: () => {
      navigator.vibrate?.(8);
    },
  });

  const dragMarker = dragK ? markers.find((m) => m.id === dragK.id) : undefined;
  const unit = surfaceOn ? SURFACE_Y_UNIT : Y_UNIT_LABEL[model.yUnit];
  // 描画域の矩形（.chart の CSS px。モデルの画素 − offset）
  const surfaceRect = {
    left: plot.left - ox,
    top: plot.top - frame.offsetY,
    width: plot.width,
    height: plot.height,
  };
  /** 縦の目盛り: 面モードは経過日数、線モードは損益 */
  const yTicks: ReadonlyArray<{ v: number; px: number; label: string }> = surfaceOn
    ? dayTicks.map((t) => ({ v: t.v, px: t.py, label: t.label }))
    : model.yTicks;
  /** ● の縦の画素（面モードは d の画素） */
  const dotPy = surfaceOn ? (point?.py ?? null) : (handle?.dotPy ?? null);

  return (
    <div
      class={mini ? 'chart mini' : surfaceOn ? (live ? 'chart surf live' : 'chart surf') : 'chart'}
      ref={p.chartRef}
      tabIndex={model.empty || mini ? -1 : 0}
      role="application"
      aria-label={surfaceOn ? SURFACE_LABEL : LINE_LABEL}
    >
      {surfaceOn && (
        <SurfaceCanvas width={p.width} height={p.height} image={image} rect={surfaceRect} />
      )}
      {model.empty && emptyGrid && (
        <svg width={p.width} height={p.height} viewBox={frame.viewBox} aria-hidden="true">
          <g class="grid">
            {emptyGrid.yLines.map((y, i) => (
              <line
                key={`y${i}`}
                x1={emptyGrid.plot.left}
                x2={emptyGrid.plot.left + emptyGrid.plot.width}
                y1={y}
                y2={y}
              />
            ))}
            {emptyGrid.xLines.map((x, i) => (
              <line
                key={`x${i}`}
                x1={x}
                x2={x}
                y1={emptyGrid.plot.top}
                y2={emptyGrid.plot.top + emptyGrid.plot.height}
              />
            ))}
          </g>
          <g class="ax">
            {emptyGrid.xTicks.map((t) => (
              <text
                key={`x${t.v}`}
                class="tick-x"
                x={t.px}
                y={emptyGrid.plot.top + emptyGrid.plot.height + 17}
              >
                {t.label}
              </text>
            ))}
          </g>
          <line
            class="zero"
            x1={emptyGrid.plot.left}
            x2={emptyGrid.plot.left + emptyGrid.plot.width}
            y1={emptyGrid.zeroPy}
            y2={emptyGrid.zeroPy}
          />
        </svg>
      )}
      {model.empty ? (
        <p class="note">
          {p.legCount === 0
            ? '足を追加すると損益が出ます'
            : '評価できる足が無い（F が決まらない限月の足だけ）'}
        </p>
      ) : (
        <svg width={p.width} height={p.height} viewBox={frame.viewBox} aria-hidden="true">
          {!mini && (
            <g class="grid">
              {yTicks.map((t) => (
                <line key={`y${t.v}`} x1={plot.left} x2={right} y1={t.px} y2={t.px} />
              ))}
              {model.xTicks.map((t) => (
                <line key={`x${t.v}`} x1={t.px} x2={t.px} y1={plot.top} y2={bottom} />
              ))}
            </g>
          )}
          {!mini && (
            <g class="ax">
              {yTicks.map((t) => (
                <text key={`y${t.v}`} class="tick-y" x={plot.left - 6} y={t.px}>
                  {t.label}
                </text>
              ))}
              {model.xTicks.map((t) => (
                <text key={`x${t.v}`} class="tick-x" x={t.px} y={bottom + 17}>
                  {t.label}
                </text>
              ))}
              <text class="unit" x={plot.left - 6} y={plot.top + 2}>
                {unit}
              </text>
            </g>
          )}
          {/* 描画域の切り抜き（入れ子の svg。clip-path の ID を使わない） */}
          <svg
            x={plot.left}
            y={plot.top}
            width={plot.width}
            height={plot.height}
            viewBox={`${plot.left} ${plot.top} ${plot.width} ${plot.height}`}
            class="clip"
            aria-hidden="true"
          >
            {fill.gain && <path class="fill-gain" d={fill.gain} />}
            {fill.loss && <path class="fill-loss" d={fill.loss} />}
            {!surfaceOn && model.zeroPy !== null && (
              <line class="zero" x1={plot.left} x2={right} y1={model.zeroPy} y2={model.zeroPy} />
            )}
            {!mini && model.x0Px !== null && (
              <line class="x0" x1={model.x0Px} x2={model.x0Px} y1={plot.top} y2={bottom} />
            )}
            {!mini && model.scenarioAtm !== null && (
              <line
                class="atm2"
                x1={model.scenarioAtm.px}
                x2={model.scenarioAtm.px}
                y1={plot.top}
                y2={bottom}
              />
            )}
            {!surfaceOn &&
              model.pins.map((pin) => (
                <path key={`pin${pin.no}`} class={`ln-pin p${pin.no}`} d={pin.d} />
              ))}
            {!surfaceOn &&
              model.lines.map((l) => (
                <path key={l.kind} class={`ln ${KIND_CLASS[l.kind]}`} d={l.d} />
              ))}
            {!mini &&
              !surfaceOn &&
              model.breakevens.map((b) => (
                <path
                  key={`b${b.x}`}
                  class="bep"
                  d={`M${b.px.toFixed(1)} ${(b.py - 5).toFixed(1)}l5 5l-5 5l-5 -5z`}
                />
              ))}
            {handle && (
              <line
                class="vline"
                x1={handle.px}
                x2={handle.px}
                y1={handle.top}
                y2={handle.bottom}
              />
            )}
            {point && <line class="hline" x1={plot.left} x2={right} y1={point.py} y2={point.py} />}
          </svg>
          {!mini && model.x0Px !== null && (
            <text class="legtxt x0-lbl" x={model.x0Px - 3} y={plot.top + 10}>
              X₀
            </text>
          )}
          {!mini &&
            !surfaceOn &&
            marks?.marks.map((m) =>
              m.py === null ? null : (
                <circle
                  key={`mp${m.kind}`}
                  class={`xpt ${KIND_CLASS[m.kind]}`}
                  cx={marks.px}
                  cy={m.py}
                  r={3.5}
                />
              ),
            )}
          {!mini &&
            labels.map((m) => (
              <text
                key={`ml${m.kind}`}
                class={`xpt-lbl ${KIND_CLASS[m.kind]} ${m.anchor}`}
                x={m.labelX}
                y={m.labelY}
              >
                {m.text}
              </text>
            ))}
          {!mini &&
            !surfaceOn &&
            p.pinMarks.map((l) => (
              <text key={`pl${l.no}`} class={`pinlbl p${l.no}`} x={l.x} y={l.y}>
                {l.text}
              </text>
            ))}
          {!mini && handle && (
            <g class="handle-g">
              {dotPy !== null && (
                <>
                  <circle class="handle-ring" cx={handle.px} cy={dotPy} r={11} />
                  <circle class="handle" cx={handle.px} cy={dotPy} r={6} />
                </>
              )}
              <path
                class="grip"
                d={`M${(handle.px - 7).toFixed(1)} ${bottom + 2}L${(handle.px + 7).toFixed(1)} ${bottom + 2}L${handle.px.toFixed(1)} ${bottom + 9}Z`}
              />
              {/* つかむ域（透明の太線。マウスを載せると左右矢印のカーソル） */}
              <line
                class="handle-hit"
                x1={handle.px}
                x2={handle.px}
                y1={handle.top}
                y2={bottom - MARKER_BAND_PX}
              />
            </g>
          )}
          {point && (
            <text class={`surf-lbl ${point.anchor}`} x={point.labelX} y={point.labelY}>
              {point.text}
            </text>
          )}
          {!mini &&
            markers.map((m) => (
              <g key={`lm${m.id}`}>
                <path
                  class={`legmark${m.side === 'sell' ? ' sell' : ''}${m.selected ? ' sel' : ''}${dragK?.id === m.id ? ' drag' : ''}`}
                  data-leg-id={m.id}
                  data-k={m.k}
                  d={m.path}
                />
                {m.times && (
                  <text class="legtxt" x={m.px + 7} y={bottom - 2}>
                    {m.times}
                  </text>
                )}
              </g>
            ))}
          {!mini && dragMarker && (
            <text class="legdrag" x={dragMarker.px} y={bottom - MARKER_BAND_PX - 4}>
              K {fmtNum(dragMarker.k, 0)}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

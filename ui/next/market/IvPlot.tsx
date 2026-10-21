import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import type { IvBar } from '../../../data';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import { useChartGestures } from '../../components/useChartGestures';
import { CROSS_TOUCH_GRAB_PX, crossTapAction } from '../../view/crosshair';
import {
  IV_MIN_BARS,
  IV_PLOT_LABEL,
  type IvMode,
  type IvOverlay,
  type IvSeries,
  type IvTf,
  ivChartModel,
  ivCrosshair,
  ivFullDomain,
  ivIndexAt,
  ivKeyStep,
} from '../../view/ivHistory';
import { useSize } from '../useSize';

export interface IvPlotProps {
  bars: readonly IvBar[];
  tf: IvTf;
  mode: IvMode;
  /** resolveIvViewport の結果 */
  viewport: Domain;
  segments: readonly (readonly [number, number])[];
  rightLoaded: boolean;
  cursor: number | null;
  /** 十字線の横線の高さ（要素の座標の画素。指 / マウスの縦の位置。無ければ null = 足の終値の高さ） */
  cursorY: number | null;
  /** 左の余白（本。左に読む余地があれば IV_LEFT_SLACK） */
  leftSlack: number;
  /** 「今」の印（ivNowPoint。無ければ null） */
  now: { index: number; iv: number } | null;
  /** シナリオの水準（pt。無ければ null） */
  scenario: number | null;
  /** 描画域の上に重ねる状態（読み中・失敗・0 本） */
  status: 'ready' | 'loading' | 'failed' | 'empty';
  /** 失敗した要求の側（左の追加は左上のバッジ） */
  failedSide: string | null;
  /** 読み中のバッジ（足があるとき。left = 左の追加は左上、right = 最新化・右の追加は右上） */
  busy: 'left' | 'right' | null;
  onViewport: (v: Domain | null) => void;
  onCursor: (i: number | null, y?: number | null) => void;
  onRetry: () => void;
  /** 系列の書式（無ければ IV。先物推移は FUT_SERIES。#190） */
  series?: IvSeries;
  /** 描画域・svg の名前（無ければ IV 推移の名前） */
  plotLabel?: string;
  imgLabel?: string;
  /**
   * 限月交代の印（#190。描画域の横の画素範囲 range から x と札を作る。無ければ描かない）。縦の点線 .fut-roll（薄く）と
   * 札 .fut-roll-tag（label が null なら線だけ）
   */
  rolls?: (range: Domain) => readonly { x: number; label: string | null }[];
  /** 価格に重ねる線（#206 先物推移の EMA。無ければ描かない。同じ配列なら座標を作り直さない） */
  overlays?: readonly IvOverlay[];
  /**
   * 描画域の高さ（#207。先物推移の段があるとき = 配置の futPaneLayout の価格の高さ。境目のドラッグで ResizeObserver の
   * 1 フレームの遅れを出さない）。無ければ測った高さ
   */
  height?: number;
  /** 十字線の横線と縦軸の札を描くか（#207。段の上の十字線のときは false = 縦線と横軸の札だけ。無ければ描く） */
  crossH?: boolean;
}

/**
 * IV 推移の描画域（#79。自前の SVG。docs/ui-redesign.md §4.7）。座標は ui/view/ivHistory.ts の ivChartModel、
 * 拡大・パン・ピンチ・ホイール・キーは useChartGestures（スマイル・損益グラフと共用）。PC のホバー・タッチのタップ（#217。交点をつかんで動かす）で
 * カーソルの足を選ぶ（読み取りの 1 行と十字線・軸の札 = ivCrosshair。#130）。高さは残りの高さ（useSize）。色は CSS のクラスだけ（style 属性なし）。
 */
function IvPlotView(p: IvPlotProps) {
  const { bars, viewport, cursor, cursorY, onCursor } = p;
  const n = bars.length;
  const { ref, width, height: measured } = useSize(480, 200);
  const height = p.height ?? measured;
  const model = useMemo(
    () =>
      ivChartModel({
        bars,
        tf: p.tf,
        mode: p.mode,
        viewport,
        segments: p.segments,
        width,
        height,
        rightLoaded: p.rightLoaded,
        now: p.now,
        scenario: p.scenario,
        ...(p.series ? { series: p.series } : {}),
        ...(p.overlays ? { overlays: p.overlays } : {}),
      }),
    [
      bars,
      p.tf,
      p.mode,
      viewport,
      p.segments,
      width,
      height,
      p.rightLoaded,
      p.now,
      p.scenario,
      p.series,
      p.overlays,
    ],
  );
  const { range } = model;
  const { rolls } = p;
  const rollMarks = useMemo(() => (rolls ? rolls(range) : []), [rolls, range]);
  // 十字線と軸の札はカーソルだけで作り直す（O(1)。上のモデルはカーソルに依存しない）
  const cross = useMemo(
    () =>
      ivCrosshair({
        bars,
        tf: p.tf,
        viewport,
        cursor,
        y: cursorY,
        model,
        ...(p.series ? { fmt: p.series.fmt } : {}),
      }),
    [bars, p.tf, viewport, cursor, cursorY, model, p.series],
  );
  // 描画域の外（目盛りの余白）に線・足をはみ出させない
  const clipId = `iv-clip-${useId().replace(/[^\w-]/g, '')}`;
  const full = ivFullDomain(n, p.leftSlack);
  const indexAt = (x: number) => ivIndexAt(x, viewport, range, n);
  // 指 / マウスの縦の位置（要素の座標）と種類（タップは位置を返すが、マウスのクリックは十字線を置かない）
  const pointerY = useRef<number | null>(null);
  const touch = useRef(false);
  const trackY = (e: PointerEvent) => {
    pointerY.current = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
    touch.current = e.pointerType !== 'mouse';
  };
  // タッチのタップで置いた十字線（#217 の共通の規則）: 交点の ±14px をつかんで動かす。カーソルが外れたら終わる
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (cursor === null) setPinned(false);
  }, [cursor]);
  const grab = pinned && cross && p.crossH !== false;

  useChartGestures(ref, {
    viewport,
    full,
    minWidth: Math.min(IV_MIN_BARS, full[1] - full[0]),
    range,
    disabled: n === 0,
    onViewport: (v) => {
      // ダブルタップ・R の初期表示では十字線も消す（ダブルタップの 1 回目で置いた十字線を残さない。#217）
      if (v === null && pinned) onCursor(null);
      p.onViewport(v);
    },
    // タッチのタップ（#217 の共通の規則）: 出ていなければ置く、出ていれば消す。マウスのクリックは今のまま外す（動かせばまた出る）。
    // 「出ている」は描いている十字線（足が表示範囲の外 = 描いていないなら置く。#227）
    onTap: (x, y) => {
      if (!touch.current || crossTapAction(cross !== null) === 'hide') {
        onCursor(null);
        return;
      }
      if (x < range[0] || x > range[1]) return;
      setPinned(true);
      onCursor(indexAt(x), y);
    },
    ...(grab
      ? {
          cross: { pointPx: { x: cross.x, y: cross.y }, grabPx: CROSS_TOUCH_GRAB_PX },
          onCross: (x: number, y: number) =>
            onCursor(indexAt(Math.min(Math.max(x, range[0]), range[1])), y),
        }
      : {}),
    onScrubKey: (key) => {
      if (key !== ',' && key !== '.') return false;
      // 始点は表示範囲の中の足（段と同じ = ivKeyStep。#227）。横線の高さは保つ（キーだけで置いたときは最初の足の終値の高さから）
      onCursor(ivKeyStep(cursor, n, viewport, key === ',' ? -1 : 1), cursorY ?? cross?.y);
      return true;
    },
  });

  // ローソクは up / down の実体・ひげをそれぞれ 1 本の path にまとめる（見えている足の数だけ要素を作らない）。
  // 進行中の足は別の要素（.iv-bar.progress）
  const paths = useMemo(() => {
    const d = { upBody: '', downBody: '', upWick: '', downWick: '' };
    let progress: (typeof model.candles)[number] | null = null;
    for (const c of model.candles) {
      if (c.cls.endsWith('progress')) {
        progress = c;
        continue;
      }
      const up = c.cls.includes(' up');
      const body = `M${c.bodyX} ${c.bodyY}h${c.bodyW}v${c.bodyH}h${-c.bodyW}Z`;
      const wick = `M${c.x} ${c.yHigh}V${c.yLow}`;
      if (up) {
        d.upBody += body;
        d.upWick += wick;
      } else {
        d.downBody += body;
        d.downWick += wick;
      }
    }
    return { ...d, progress };
  }, [model]);
  const { width: w, height: h } = model;
  const pc = paths.progress;

  return (
    <div
      class="iv-wrap"
      ref={ref}
      tabIndex={n === 0 ? -1 : 0}
      role="application"
      aria-label={p.plotLabel ?? IV_PLOT_LABEL}
      onPointerDown={trackY}
      onPointerMove={(e) => {
        trackY(e);
        if (e.pointerType !== 'mouse' || e.buttons !== 0 || n === 0) return;
        setPinned(false); // タッチで置いたあとマウスに持ち替えたら、ホバーの十字線（つかまない）に戻す
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        onCursor(x >= range[0] && x <= range[1] ? indexAt(x) : null, pointerY.current);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') onCursor(null);
      }}
    >
      {n > 0 && (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label={p.imgLabel ?? 'ATM IV（30 日固定）の推移（縦軸 IV %）'}
        >
          <g class="grid">
            {model.yTicks.map((t) => (
              <line key={`y${t.label}`} x1={range[0]} x2={range[1]} y1={t.y} y2={t.y} />
            ))}
            {model.xTicks.map((t) => (
              <line key={`x${t.x}`} x1={t.x} x2={t.x} y1={8} y2={h - 22} />
            ))}
          </g>
          <g class="ax">
            {model.yTicks.map((t) => (
              <text key={`y${t.label}`} x={range[0] - 5} y={t.y} class="ty">
                {t.label}
              </text>
            ))}
            {model.xTicks.map((t) => (
              <text key={`x${t.x}`} x={t.x} y={h - 7} class="tx">
                {t.label}
              </text>
            ))}
          </g>
          <clipPath id={clipId}>
            <rect x={range[0]} y={0} width={Math.max(range[1] - range[0], 0)} height={h} />
          </clipPath>
          <g clip-path={`url(#${clipId})`}>
            {p.mode === 'candle' ? (
              <>
                <path class="iv-bar up wick" d={paths.upWick || 'M0 0'} />
                <path class="iv-bar down wick" d={paths.downWick || 'M0 0'} />
                <path class="iv-bar up body" d={paths.upBody || 'M0 0'} />
                <path class="iv-bar down body" d={paths.downBody || 'M0 0'} />
                {pc && (
                  <g class={pc.cls}>
                    <line class="wick" x1={pc.x} x2={pc.x} y1={pc.yHigh} y2={pc.yLow} />
                    <rect
                      class="body"
                      x={pc.bodyX}
                      y={pc.bodyY}
                      width={pc.bodyW}
                      height={pc.bodyH}
                    />
                  </g>
                )}
              </>
            ) : (
              <>
                <path class="iv-line" d={model.line || 'M0 0'} />
                <path class="iv-dot" d={model.dots || 'M0 0'} />
                {model.progress && <path class="iv-line progress" d={model.progress} />}
              </>
            )}
            {model.overlays.map(
              (o) => o.d && <path key={o.cls} class={o.cls} d={o.d} stroke-width={o.width} />,
            )}
          </g>
          {rollMarks.map((r) => (
            <g key={`roll${r.x}`} class="fut-roll-mark">
              <line class="fut-roll" x1={r.x} x2={r.x} y1={8} y2={h - 22} />
              {r.label && (
                <text class="fut-roll-tag" x={r.x + 3} y={12}>
                  {r.label}
                </text>
              )}
            </g>
          ))}
          {model.scenarioY !== null && (
            <line
              class="iv-scenario"
              x1={range[0]}
              x2={range[1]}
              y1={model.scenarioY}
              y2={model.scenarioY}
            />
          )}
          {model.nowPt && (
            <circle class="iv-now" cx={model.nowPt.x} cy={model.nowPt.y} r={3.5}>
              <title>今</title>
            </circle>
          )}
          {cross && (
            <g class="iv-cross">
              <line class="iv-cursor v" x1={cross.x} x2={cross.x} y1={8} y2={h - 22} />
              {p.crossH !== false && (
                <line class="iv-cursor h" x1={range[0]} x2={range[1]} y1={cross.y} y2={cross.y} />
              )}
              <g class="iv-tag x">
                <rect
                  x={cross.xTag.x}
                  y={cross.xTag.y}
                  width={cross.xTag.w}
                  height={cross.xTag.h}
                />
                <text x={cross.xTag.x + cross.xTag.w / 2} y={cross.xTag.y + cross.xTag.h / 2}>
                  {cross.xTag.text}
                </text>
              </g>
              {p.crossH !== false && (
                <g class="iv-tag y">
                  <rect
                    x={cross.yTag.x}
                    y={cross.yTag.y}
                    width={cross.yTag.w}
                    height={cross.yTag.h}
                  />
                  <text x={cross.yTag.x + cross.yTag.w / 2} y={cross.yTag.y + cross.yTag.h / 2}>
                    {cross.yTag.text}
                  </text>
                </g>
              )}
            </g>
          )}
        </svg>
      )}
      {p.status === 'loading' && (
        <p class="iv-state iv-loading" role="status">
          読み込み中…
        </p>
      )}
      {p.status === 'failed' && (
        <div
          class={
            n === 0
              ? 'iv-state iv-failed'
              : p.failedSide === 'left'
                ? 'iv-badge left iv-failed'
                : 'iv-badge iv-failed'
          }
          role="alert"
        >
          <span>
            {n === 0
              ? '読み込めませんでした'
              : p.failedSide === 'left'
                ? '過去を読めません'
                : '更新できません'}
          </span>
          <button type="button" class="btn sm" onClick={p.onRetry}>
            再試行
          </button>
        </div>
      )}
      {p.status === 'empty' && <p class="iv-state iv-empty">データがありません</p>}
      {p.busy && (
        <span
          class={p.busy === 'left' ? 'iv-badge left iv-loading' : 'iv-badge iv-loading'}
          role="status"
        >
          {p.busy === 'left' ? '過去を読み込み中…' : '更新中…'}
        </span>
      )}
    </div>
  );
}

export const IvPlot = pure(IvPlotView);

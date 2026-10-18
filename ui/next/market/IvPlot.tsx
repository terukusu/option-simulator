import { useId, useMemo } from 'preact/hooks';
import type { IvBar } from '../../../data';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import { useChartGestures } from '../../components/useChartGestures';
import {
  IV_MIN_BARS,
  IV_PLOT_LABEL,
  type IvMode,
  type IvTf,
  ivChartModel,
  ivFullDomain,
  ivIndexAt,
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
  onCursor: (i: number | null) => void;
  onRetry: () => void;
}

/**
 * IV 推移の描画域（#79。自前の SVG。docs/ui-redesign.md §4.7）。座標は ui/view/ivHistory.ts の ivChartModel、
 * 拡大・パン・ピンチ・ホイール・キーは useChartGestures（スマイル・損益グラフと共用）。PC のホバー・タッチの長押しで
 * カーソルの足を選ぶ（読み取りの 1 行）。高さは残りの高さ（useSize）。色は CSS のクラスだけ（style 属性なし）。
 */
function IvPlotView(p: IvPlotProps) {
  const { bars, viewport, cursor, onCursor } = p;
  const n = bars.length;
  const { ref, width, height } = useSize(480, 200);
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
        cursor,
        rightLoaded: p.rightLoaded,
        now: p.now,
        scenario: p.scenario,
      }),
    [
      bars,
      p.tf,
      p.mode,
      viewport,
      p.segments,
      width,
      height,
      cursor,
      p.rightLoaded,
      p.now,
      p.scenario,
    ],
  );
  const { range } = model;
  // 描画域の外（目盛りの余白）に線・足をはみ出させない
  const clipId = `iv-clip-${useId().replace(/[^\w-]/g, '')}`;
  const full = ivFullDomain(n, p.leftSlack);
  const indexAt = (x: number) => ivIndexAt(x, viewport, range, n);

  useChartGestures(ref, {
    viewport,
    full,
    minWidth: Math.min(IV_MIN_BARS, full[1] - full[0]),
    range,
    disabled: n === 0,
    onViewport: p.onViewport,
    onTap: () => onCursor(null),
    scrub: { linePx: null },
    onScrub: (x) => onCursor(indexAt(x)),
    onScrubKey: (key) => {
      if (key !== ',' && key !== '.') return false;
      const from = cursor ?? n - 1;
      onCursor(Math.min(Math.max(from + (key === ',' ? -1 : 1), 0), n - 1));
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
      aria-label={IV_PLOT_LABEL}
      onPointerMove={(e) => {
        if (e.pointerType !== 'mouse' || e.buttons !== 0 || n === 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        onCursor(x >= range[0] && x <= range[1] ? indexAt(x) : null);
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
          aria-label="ATM IV（30 日固定）の推移（縦軸 IV %）"
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
          </g>
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
          {model.cursorX !== null && (
            <line class="iv-cursor" x1={model.cursorX} x2={model.cursorX} y1={8} y2={h - 22} />
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

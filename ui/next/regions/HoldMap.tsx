import { useId, useMemo, useState } from 'preact/hooks';
import type { AtmMovesCtl } from '../../components/useAtmMoves';
import type { HoldMapCtl } from '../../components/useHoldMap';
import {
  HOLD_MAP_CAPTION,
  HOLD_MAP_COMPUTING,
  HOLD_MAP_PLOT_LABEL,
  HOLD_MAP_RETRY,
  HOLD_MAP_TITLE,
  type HoldMapResult,
  type HoldMapSel,
  holdMapDxX,
  holdMapHeight,
  holdMapNote,
  holdMapPick,
  holdMapPlot,
  holdMapReadout,
  holdMapSelMark,
  holdMapStatusText,
  holdMapStep,
  holdMapSummary,
} from '../../view/holdMap';
import type { AmountUnit } from '../../view/metrics';
import { useSize } from '../useSize';

/** 指標パネルに渡す持ちこたえマップの束（NextApp の useMemo。参照が同じなら描き直さない） */
export interface HoldBundle {
  open: boolean;
  onToggle: () => void;
  noLegs: boolean;
  noCapital: boolean;
  map: HoldMapCtl;
  moves: AtmMovesCtl;
  /** シナリオの ΔX（X₀ に対する比。縦の破線だけ。ΔX では計算し直さない） */
  dXRatio: number;
  /** マップの日数（シナリオの d。clampDays 済み） */
  days: number;
}

/** 描画域（開いて資金・足があるときだけ。幅は useSize） */
function HoldMapPlotView({
  result,
  hold,
  unit,
}: {
  result: HoldMapResult | null;
  hold: HoldBundle;
  unit: AmountUnit;
}) {
  const { ref, width } = useSize(320, 0);
  const moves = hold.moves.moves;
  const plot = useMemo(
    () => (result && width > 60 ? holdMapPlot(result, moves, width) : null),
    [result, moves, width],
  );
  const [sel, setSel] = useState<HoldMapSel | null>(null);
  const axes = result?.axes ?? null;
  const dxX = axes && width > 60 ? holdMapDxX(axes, width, hold.dXRatio) : null;
  const mark = plot && axes ? holdMapSelMark(sel, plot, axes) : null;
  const readout = holdMapReadout(sel, result, moves, unit);
  const showMoves = hold.moves.status === 'ok' && moves.length > 0;
  const onClick = (e: MouseEvent) => {
    if (!plot || !axes) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSel(holdMapPick(plot, axes, e.clientX - r.left, e.clientY - r.top));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!axes) return;
    if (e.key === 'Escape') {
      if (sel) {
        setSel(null);
        e.preventDefault();
      }
      return;
    }
    const next = holdMapStep(sel, axes, e.key);
    if (next) {
      setSel(next);
      e.preventDefault();
    }
  };
  const h = holdMapHeight(width);
  return (
    <>
      {plot && showMoves && <p class="hm-sum">{holdMapSummary(plot.count)}</p>}
      <div class={hold.map.computing && plot ? 'hm-plot busy' : 'hm-plot'}>
        <div
          ref={ref}
          class="hm-wrap"
          role="application"
          tabIndex={plot ? 0 : -1}
          aria-label={HOLD_MAP_PLOT_LABEL}
          aria-busy={hold.map.computing}
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          {plot ? (
            <svg
              class="hm-svg"
              width={plot.width}
              height={plot.height}
              viewBox={`0 0 ${plot.width} ${plot.height}`}
              role="img"
              aria-label={
                showMoves
                  ? `${HOLD_MAP_PLOT_LABEL}。${holdMapSummary(plot.count)}`
                  : HOLD_MAP_PLOT_LABEL
              }
            >
              {plot.cells.map((c) => (
                <path key={c.cls} class={c.cls} d={c.d} shape-rendering="crispEdges" />
              ))}
              {plot.contour && <path class="hm-line" d={plot.contour} />}
              {plot.xTicks.map((t) => (
                <text
                  key={t.label}
                  class="hm-tick"
                  x={t.at}
                  y={plot.height - 6}
                  text-anchor="middle"
                >
                  {t.label}
                </text>
              ))}
              {plot.yTicks.map((t) => (
                <text
                  key={t.label}
                  class="hm-tick"
                  x={plot.left - 4}
                  y={t.at + 3}
                  text-anchor="end"
                >
                  {t.label}
                </text>
              ))}
              {dxX !== null && (
                <line class="hm-dx" x1={dxX} x2={dxX} y1={plot.top} y2={plot.bottom} />
              )}
              {showMoves && plot.okDots && <path class="hm-dot" d={plot.okDots} />}
              {showMoves && plot.callMarks && <path class="hm-x" d={plot.callMarks} />}
              {plot.now && (
                <path
                  class="hm-now"
                  d={`M${plot.now.x - 6} ${plot.now.y}h12M${plot.now.x} ${plot.now.y - 6}v12`}
                />
              )}
              {mark &&
                (mark.kind === 'point' ? (
                  <circle class="hm-sel" cx={mark.x} cy={mark.y} r={5} />
                ) : (
                  <rect class="hm-sel" x={mark.x} y={mark.y} width={mark.w} height={mark.h} />
                ))}
            </svg>
          ) : (
            // 初めての計算の間（前のマップが無い）。高さを取っておく
            <svg class="hm-svg" width={Math.max(width, 0)} height={h} aria-hidden="true">
              <text class="hm-tick" x={Math.max(width, 0) / 2} y={h / 2} text-anchor="middle">
                {HOLD_MAP_COMPUTING}
              </text>
            </svg>
          )}
        </div>
      </div>
      <p class="hm-readout" aria-live="polite">
        {readout}
      </p>
      {showMoves && <p class="mx-note">{holdMapNote(moves, hold.days)}</p>}
    </>
  );
}

/**
 * 持ちこたえマップ（#152。docs/ui-redesign.md §3・docs/design.md 5.11）: 指標 · テールの末尾の折りたたみ（既定は閉・
 * 開閉は ShellState.holdMap = セッション中だけ）。表示モデルは ui/view/holdMap.ts、計算の時機は useHoldMap、
 * 過去の点の読み込みは useAtmMoves（どちらも NextApp が持つ）。値は JSX のテキストと SVG の数値の属性だけ。
 */
export function HoldMap({ hold, unit }: { hold: HoldBundle; unit: AmountUnit }) {
  const id = useId();
  const status = holdMapStatusText({
    noLegs: hold.noLegs,
    noCapital: hold.noCapital,
    computing: hold.map.computing && hold.map.result !== null,
    movesStatus: hold.moves.status,
    movesCount: hold.moves.moves.length,
  });
  const blocked = hold.noLegs || hold.noCapital;
  return (
    <>
      <button
        type="button"
        class="hm-toggle"
        aria-expanded={hold.open}
        aria-controls={id}
        onClick={hold.onToggle}
      >
        <span>{HOLD_MAP_TITLE}</span>
      </button>
      {hold.open && (
        <div id={id} class="hm">
          <p class="mx-note">{HOLD_MAP_CAPTION}</p>
          {blocked ? (
            <p class="hm-status">{status.main}</p>
          ) : (
            <>
              {(status.main || status.moves) && (
                <p class="hm-status">
                  {[status.main, status.moves].filter(Boolean).join(' · ')}
                  {status.retry && (
                    <button type="button" class="btn sm hm-retry" onClick={hold.moves.retry}>
                      {HOLD_MAP_RETRY}
                    </button>
                  )}
                </p>
              )}
              <HoldMapPlotView result={hold.map.result} hold={hold} unit={unit} />
            </>
          )}
        </div>
      )}
    </>
  );
}

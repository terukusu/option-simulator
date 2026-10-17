import { useEffect, useRef } from 'preact/hooks';
import type { Action } from '../../state';
import { sliderSpec, stepSlider } from '../../view/scenario';
import {
  IV_RAIL_PAD,
  ivRailBubble,
  ivRailDragValue,
  ivRailRelative,
  ivRailValue,
  ivRailY,
} from '../../view/stage';
import { useSize } from '../useSize';

const SPEC = sliderSpec('dSigma', { x0: 1, maxDays: 0, dXUnit: 'yen' });

/**
 * IV レール（舞台の右。docs/ui-redesign.md §5・§11-4。#82）: 上 = +40pt・下 = −10pt。押した位置・ドラッグの位置の
 * Δσ（0.5 の格子）を 1 フレーム 1 回 setScenario に入れる（レールが短いときは移動量 × 0.25pt/px の相対）。ダブルクリック / ダブルタップで 0、↑ ↓ で ±0.5。
 * 位置は SVG の属性（ui/view/stage.ts の ivRailY / ivRailValue）。touch-action: none（ページ・シートを動かさない）。
 */
export function IvRail({ value, dispatch }: { value: number; dispatch: (a: Action) => void }) {
  const { ref, width, height } = useSize<HTMLDivElement>(34, 200);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  /** 押している指と、押したときの縦の位置・値（相対のドラッグ） */
  const dragging = useRef<{ id: number; y0: number; v0: number; relative: boolean } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastTap = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const set = (v: number) => {
    pending.current = v;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null && next !== valueRef.current) {
        dispatch({ type: 'setScenario', patch: { dSigma: next } });
      }
    });
  };
  const at = (e: PointerEvent) => {
    const el = ref.current;
    if (!el) return valueRef.current;
    return ivRailValue(e.clientY - el.getBoundingClientRect().top, el.clientHeight);
  };

  const y = ivRailY(value, height);
  const y0 = ivRailY(0, height);
  const cx = width / 2;
  // 吹き出しの文言・幅・位置は交点のラベルの退避（ivRailObstacle）と同じ純関数から
  const bubble = ivRailBubble(value, height);
  const text = bubble.text;
  return (
    <div
      class={value !== 0 ? 'ivrail hot' : 'ivrail'}
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="IV 平行移動 Δσ"
      aria-orientation="vertical"
      aria-valuemin={SPEC.min}
      aria-valuemax={SPEC.max}
      aria-valuenow={value}
      aria-valuetext={text}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // タッチのダブルタップ（300ms 以内）で 0
        if (e.pointerType !== 'mouse' && e.timeStamp - lastTap.current < 300) {
          lastTap.current = 0;
          set(0);
          return;
        }
        lastTap.current = e.timeStamp;
        // レールが短いときは押した位置に飛ばさず、移動量で動かす（感度の上限 IV_RAIL_MAX_RATE）
        const relative = ivRailRelative(e.currentTarget.clientHeight);
        dragging.current = { id: e.pointerId, y0: e.clientY, v0: valueRef.current, relative };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture できない環境でも操作は続ける
        }
        if (!relative) set(at(e));
      }}
      onPointerMove={(e) => {
        const d = dragging.current;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        set(d.relative ? ivRailDragValue(d.v0, e.clientY - d.y0) : at(e));
      }}
      onPointerUp={(e) => {
        if (dragging.current?.id === e.pointerId) dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
      onDblClick={(e) => {
        e.preventDefault();
        set(0);
      }}
      onKeyDown={(e) => {
        const next = stepSlider(SPEC, value, e.key, e.shiftKey);
        if (typeof next !== 'number') return;
        e.preventDefault();
        if (next !== value) dispatch({ type: 'setScenario', patch: { dSigma: next } });
      }}
    >
      <svg width={width} height={height} aria-hidden="true">
        <text class="lbl" x={cx} y={12}>
          +40
        </text>
        <line class="track" x1={cx} x2={cx} y1={IV_RAIL_PAD} y2={height - IV_RAIL_PAD} />
        <line class="zero" x1={6} x2={width - 6} y1={y0} y2={y0} />
        <text class="lbl" x={cx} y={height - 6}>
          −10
        </text>
        <g class="cur">
          <rect x={-4 - bubble.w} y={y - 7.5} width={bubble.w} height={15} rx={4} />
          <text x={-8} y={y}>
            {text}
          </text>
        </g>
        <circle class="knob" cx={cx} cy={y} r={9} />
      </svg>
    </div>
  );
}

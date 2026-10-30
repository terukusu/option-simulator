import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { Action } from '../../state';
import type { EvalTimeTarget } from '../../view/scenario';
import {
  railPick,
  TIME_RAIL_COMPACT_PX,
  TIME_RAIL_PAD,
  timeRailLayout,
  timeRailNow,
  timeRailText,
  timeRailTicks,
  timeRailValue,
  timeRailX,
} from '../../view/stage';
import { useSize } from '../useSize';

/** タップとドラッグの境（px。ジェスチャーの TAP_MOVE_PX と同じ） */
const MOVE_PX = 6;
const HEIGHT = 44;

/**
 * 時間レール（舞台の下。docs/ui-redesign.md §5・§8。#82）: 今 → 最遠の SQ。前の板で建てた足があれば現在値の吹き出しに
 * 「建ててから N + d 日」を足す（#299）。ドラッグは 1 日刻み、目盛り（取引最終日・SQ）の
 * タップでその時刻ぴったり（daysToTarget。端数あり）、← → で ±1 日。足 0 本（上限 0）は無効。
 * 位置は SVG の属性（ui/view/stage.ts）。setDays は 1 フレーム 1 回。touch-action: none。
 */
export function TimeRail(p: {
  days: number;
  maxDays: number;
  evalTime: number | null;
  /** 前の板で建てた足の建ててからの暦日（最も古い足。無ければ null。#299） */
  heldDays: number | null;
  targets: readonly EvalTimeTarget[];
  dispatch: (a: Action) => void;
}) {
  const { days, maxDays, dispatch } = p;
  const { ref, width } = useSize<HTMLDivElement>(300, HEIGHT);
  const disabled = !(maxDays > 0);
  const ticks = useMemo(
    () =>
      p.evalTime === null || disabled ? [] : timeRailTicks(p.targets, p.evalTime, maxDays, width),
    [p.targets, p.evalTime, maxDays, width, disabled],
  );
  const now = useMemo(() => timeRailNow(p.evalTime, ticks), [p.evalTime, ticks]);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  const press = useRef<{ id: number; x0: number; moved: boolean } | null>(null);
  const daysRef = useRef(days);
  daysRef.current = days;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const set = (d: number) => {
    pending.current = d;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = pending.current;
      pending.current = null;
      if (next !== null && next !== daysRef.current) dispatch({ type: 'setDays', days: next });
    });
  };
  const xOf = (e: PointerEvent) => {
    const el = ref.current;
    return el ? e.clientX - el.getBoundingClientRect().left : 0;
  };

  const shown = Math.min(Math.max(Number.isFinite(days) ? days : 0, 0), Math.max(maxDays, 0));
  const kx = timeRailX(shown, width, maxDays);
  const text = timeRailText(shown, p.evalTime, p.heldDays, width < TIME_RAIL_COMPACT_PX);
  // 読み上げは幅によらず時刻つきの全文
  const ariaText = timeRailText(shown, p.evalTime, p.heldDays);
  // 吹き出しはつまみの下の文字の行（描画域の目盛りの文字に重ねない）。重なる目盛りの文字・「今」は出さない
  const lay = timeRailLayout(ticks, now, kx, text, width);
  return (
    <div
      class={days > 0 ? 'timerail hot' : 'timerail'}
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="経過日数 d"
      aria-valuemin={0}
      aria-valuemax={Math.max(maxDays, 0)}
      aria-valuenow={shown}
      aria-valuetext={ariaText}
      aria-disabled={disabled ? true : undefined}
      onPointerDown={(e) => {
        if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
        press.current = { id: e.pointerId, x0: xOf(e), moved: false };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // capture できない環境でも操作は続ける
        }
      }}
      onPointerMove={(e) => {
        const pr = press.current;
        if (!pr || pr.id !== e.pointerId) return;
        const x = xOf(e);
        if (!pr.moved && Math.abs(x - pr.x0) < MOVE_PX) return;
        pr.moved = true;
        e.preventDefault();
        set(timeRailValue(x, width, maxDays));
      }}
      onPointerUp={(e) => {
        const pr = press.current;
        press.current = null;
        if (!pr || pr.id !== e.pointerId || pr.moved) return;
        // タップ: 目盛りの近くならその時刻ぴったり、それ以外は 1 日の格子
        set(railPick(xOf(e), ticks, width, maxDays));
      }}
      onPointerCancel={() => {
        press.current = null;
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = shown + 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = shown - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = maxDays;
        if (next === null) return;
        e.preventDefault();
        const d = Math.min(Math.max(next, 0), maxDays);
        if (d !== days) dispatch({ type: 'setDays', days: d });
      }}
    >
      <svg width={width} height={HEIGHT} aria-hidden="true">
        <rect
          class="track"
          x={TIME_RAIL_PAD}
          y={14}
          width={Math.max(width - 2 * TIME_RAIL_PAD, 0)}
          height={6}
          rx={3}
        />
        {!disabled && (
          <rect
            class="fillbar"
            x={TIME_RAIL_PAD}
            y={14}
            width={Math.max(kx - TIME_RAIL_PAD, 0)}
            height={6}
            rx={3}
          />
        )}
        {ticks.map((t) => (
          <line
            key={t.id}
            class={t.kind === 'sq' ? 'mark sq' : 'mark'}
            data-target={t.id}
            data-days={t.days}
            x1={t.x}
            x2={t.x}
            y1={10}
            y2={24}
          />
        ))}
        {lay.ticks.map((t) =>
          t.label === null ? null : (
            <text key={`l${t.id}`} class={`mtxt ${t.anchor}`} x={t.labelX} y={37}>
              {t.label}
            </text>
          ),
        )}
        {lay.now && (
          <text class="mtxt start" x={lay.now.x} y={37}>
            {lay.now.label}
          </text>
        )}
        {!disabled && <circle class="knob" cx={kx} cy={17} r={10} />}
        {!disabled && (
          <g class="cur">
            <rect
              x={lay.bubble.x0}
              y={29}
              width={lay.bubble.x1 - lay.bubble.x0}
              height={14}
              rx={4}
            />
            <text x={lay.bubble.x} y={36}>
              {text}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

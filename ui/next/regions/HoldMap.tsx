import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { LONG_PRESS_MS } from '../../chart/gesture';
import {
  initialPress,
  type PressResult,
  pressCancel,
  pressDown,
  pressLong,
  pressMove,
  pressUp,
} from '../../chart/press';
import type { AtmMovesCtl } from '../../components/useAtmMoves';
import type { HoldMapCtl } from '../../components/useHoldMap';
import {
  HOLD_MAP_CAPTION,
  HOLD_MAP_PLOT_LABEL,
  HOLD_MAP_RETRY,
  HOLD_MAP_TITLE,
  type HoldMapResult,
  type HoldMapSel,
  holdMapCrosshair,
  holdMapDxX,
  holdMapHeight,
  holdMapNote,
  holdMapPick,
  holdMapPlot,
  holdMapReadout,
  holdMapReveal,
  holdMapSelMark,
  holdMapStatusText,
  holdMapStep,
  holdMapSummary,
  holdMapWait,
} from '../../view/holdMap';
import type { AmountUnit } from '../../view/metrics';
import { useSize } from '../useSize';

/** 指標パネルに渡す追証マップの束（NextApp の useMemo。参照が同じなら描き直さない） */
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

/**
 * 描画域（開いて資金・足があるときだけ。幅は useSize）。待ち（wait。#174）の間は枠の中にスピナーと文字を重ねる:
 * 初めては空の枠（高さを取っておく）、前のマップがあれば薄くした上に少し遅れて（.late = CSS で 250ms 後。ちらつかない）
 */
function HoldMapPlotView({
  result,
  hold,
  unit,
  wait,
}: {
  result: HoldMapResult | null;
  hold: HoldBundle;
  unit: AmountUnit;
  wait: string | null;
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
  // 十字線（#217。docs/ui-redesign.md §4.1）: マウスのホバー・タッチの長押し（ドラッグで動かす・離しても残る・タップで消す）。
  // 位置は要素の座標の画素で持ち、マスの中心に吸着して描く（holdMapCrosshair）
  const [hover, setHover] = useState<{ x: number; y: number; touch: boolean } | null>(null);
  const xh = useMemo(
    () =>
      plot && result && hover
        ? holdMapCrosshair(plot, result, hover.x, hover.y, moves, unit)
        : null,
    [plot, result, hover, moves, unit],
  );
  const readout = xh ? xh.readout : holdMapReadout(sel, result, moves, unit);
  const press = useRef(initialPress());
  const last = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longTimer = useRef(0);
  /** 長押しで十字線にした押下の後の click を選択に使わない（時刻） */
  const swallowUntil = useRef(0);
  const lastTouch = useRef(false);
  const hoverFrame = useRef(0);
  const hoverAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(
    () => () => {
      clearTimeout(longTimer.current);
      cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );
  const local = (e: PointerEvent | MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const applyPress = (res: PressResult) => {
    press.current = res.state;
    if (res.cross) setHover({ ...res.cross, touch: true });
    // 長押しの押下を離した直後に来る click だけ（同じ押下の click は離してすぐ。次のタップは捨てない）
    if (res.swallowClick) swallowUntil.current = performance.now() + 120;
    if (res.state.mode !== 'pending') {
      clearTimeout(longTimer.current);
      longTimer.current = 0;
    }
  };
  // 長押しの十字線の間はページ・シートを動かさない（touchmove の preventDefault。スクロールが始まる前なので効く）
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (press.current.mode === 'cross') e.preventDefault();
    };
    const onMenu = (e: Event) => {
      if (press.current.mode !== 'idle') e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('contextmenu', onMenu);
    return () => {
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('contextmenu', onMenu);
    };
  }, [ref]);
  const showMoves = hold.moves.status === 'ok' && moves.length > 0;
  // 遅らせる（.late）かは待ちが始まったときに前のマップがあったかで決め、待ちの間は変えない（初回の読み込み中に
  // 点なしのマップが出ても .late が付いて 250ms 消えない）
  const lateRef = useRef<boolean | null>(null);
  if (wait === null) lateRef.current = null;
  else if (lateRef.current === null) lateRef.current = plot !== null;
  const late = lateRef.current === true;
  const onClick = (e: MouseEvent) => {
    if (!plot || !axes) return;
    if (performance.now() < swallowUntil.current) return;
    // タッチのタップは十字線を消す（選択は今のまま。マウスのクリックはホバーの十字線のまま）
    if (lastTouch.current) setHover(null);
    const at = local(e);
    setSel(holdMapPick(plot, axes, at.x, at.y));
  };
  const onPointerDown = (e: PointerEvent) => {
    lastTouch.current = e.pointerType !== 'mouse';
    if (e.pointerType === 'mouse' || !plot) return;
    const at = local(e);
    last.current = at;
    applyPress(pressDown(press.current, { id: e.pointerId, ...at, t: e.timeStamp }));
    if (press.current.mode === 'pending') {
      clearTimeout(longTimer.current);
      longTimer.current = window.setTimeout(() => {
        longTimer.current = 0;
        applyPress(pressLong(press.current, performance.now(), last.current));
        if (press.current.mode === 'cross') navigator.vibrate?.(8);
      }, LONG_PRESS_MS);
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    const at = local(e);
    if (e.pointerType !== 'mouse') {
      last.current = at;
      applyPress(pressMove(press.current, { id: e.pointerId, ...at, t: e.timeStamp }));
      return;
    }
    // ホバー（ボタンを押していない間。1 フレーム 1 回）
    if (e.buttons !== 0 || !plot) return;
    hoverAt.current = at;
    if (hoverFrame.current) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const h = hoverAt.current;
      if (h) setHover({ ...h, touch: false });
    });
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    const at = local(e);
    const sample = { id: e.pointerId, ...at, t: e.timeStamp };
    applyPress(
      e.type === 'pointercancel'
        ? pressCancel(press.current, sample)
        : pressUp(press.current, sample),
    );
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    hoverAt.current = null;
    setHover((h) => (h && !h.touch ? null : h));
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
      <div class={wait && plot ? 'hm-plot busy' : 'hm-plot'}>
        <div
          ref={ref}
          class="hm-wrap"
          role="application"
          tabIndex={plot ? 0 : -1}
          aria-label={HOLD_MAP_PLOT_LABEL}
          aria-busy={wait !== null}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={onPointerLeave}
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
              {xh && (
                <g class="xc">
                  <line class="xc-line v" x1={xh.x} x2={xh.x} y1={plot.top} y2={plot.bottom} />
                  <line class="xc-line h" x1={plot.left} x2={plot.right} y1={xh.y} y2={xh.y} />
                  {[xh.xTag, xh.yTag].map((t, i) => (
                    <g key={i === 0 ? 'x' : 'y'} class={i === 0 ? 'xc-tag x' : 'xc-tag y'}>
                      <rect x={t.x} y={t.y} width={t.w} height={t.h} />
                      <text x={t.x + t.w / 2} y={t.y + t.h / 2}>
                        {t.text}
                      </text>
                    </g>
                  ))}
                </g>
              )}
            </svg>
          ) : (
            // 初めての計算の間（前のマップが無い）。描画域の大きさの枠を先に出す（文字・スピナーは .hm-wait）
            <svg class="hm-svg" width={Math.max(width, 0)} height={h} aria-hidden="true">
              <rect
                class="hm-frame"
                x={0.5}
                y={0.5}
                width={Math.max(width - 1, 0)}
                height={Math.max(h - 1, 0)}
              />
            </svg>
          )}
        </div>
        {wait && (
          <div class={late ? 'hm-wait late' : 'hm-wait'} role="status">
            <span class="hm-spin" aria-hidden="true" />
            <span class="hm-wait-t">{wait}</span>
          </div>
        )}
      </div>
      {/* 十字線の間は読み上げない（動かすたびに変わる） */}
      <p class="hm-readout" aria-live={xh ? 'off' : 'polite'}>
        {readout}
      </p>
      {showMoves && <p class="mx-note">{holdMapNote(moves, hold.days)}</p>}
    </>
  );
}

/**
 * 追証マップ（#152。docs/ui-redesign.md §3・docs/design.md 5.11）: 指標 · テールの末尾の折りたたみ（既定は閉・
 * 開閉は ShellState.holdMap = セッション中だけ）。表示モデルは ui/view/holdMap.ts、計算の時機は useHoldMap、
 * 過去の点の読み込みは useAtmMoves（どちらも NextApp が持つ）。値は JSX のテキストと SVG の数値の属性だけ。
 */
export function HoldMap({ hold, unit }: { hold: HoldBundle; unit: AmountUnit }) {
  const id = useId();
  const status = holdMapStatusText({
    noLegs: hold.noLegs,
    noCapital: hold.noCapital,
    movesStatus: hold.moves.status,
    movesCount: hold.moves.moves.length,
  });
  const wait = holdMapWait({
    noLegs: hold.noLegs,
    noCapital: hold.noCapital,
    computing: hold.map.computing,
    movesStatus: hold.moves.status,
  });
  const blocked = hold.noLegs || hold.noCapital;
  const bodyRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(hold.open);
  // 開いたとき（前の描画で閉 → 今開。マウント時の開では動かさない）だけ、描画域がパネルのスクロール枠に入るよう
  // 枠の scrollTop だけを動かす（#174。scrollIntoView は祖先・ページまで動かしうるので使わない）。閉じるときは動かさない。
  // 測るのは 2 フレーム後（描画域の高さが useSize の測った幅で決まった後。初めの描画は仮の幅 320px の高さ）
  useLayoutEffect(() => {
    const opened = hold.open && !wasOpen.current;
    wasOpen.current = hold.open;
    if (!opened) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(reveal);
    });
    function reveal() {
      const body = bodyRef.current;
      const host = body?.closest('.panel-body');
      // 資金なし・足なしは描画域が無いので中身（.hm）の全体
      const target = body?.querySelector('.hm-plot') ?? body;
      if (!target || !(host instanceof HTMLElement)) return;
      const oy = getComputedStyle(host).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return;
      const h = host.getBoundingClientRect();
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const t = target.getBoundingClientRect();
      const { delta, behavior } = holdMapReveal(t.top, t.bottom, h.top, h.bottom, reduced);
      if (delta > 0) host.scrollTo({ top: host.scrollTop + delta, behavior });
    }
    return () => cancelAnimationFrame(frame);
  }, [hold.open]);
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
        <div id={id} ref={bodyRef} class="hm">
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
              <HoldMapPlotView result={hold.map.result} hold={hold} unit={unit} wait={wait} />
            </>
          )}
        </div>
      )}
    </>
  );
}

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  initialPress,
  type PressResult,
  pressCancel,
  pressDown,
  pressMove,
  pressUp,
} from '../../chart/press';
import type { AtmMovesCtl } from '../../components/useAtmMoves';
import type { HoldMapCtl } from '../../components/useHoldMap';
import { CROSS_TOUCH_GRAB_PX, crossTapAction } from '../../view/crosshair';
import {
  HOLD_MAP_CALL_NOTE,
  HOLD_MAP_PLOT_LABEL,
  HOLD_MAP_RETRY,
  type HoldMapResult,
  type HoldMapSel,
  holdMapCaption,
  holdMapCrosshair,
  holdMapDxX,
  holdMapHeadSummary,
  holdMapHeight,
  holdMapLegend,
  holdMapNote,
  holdMapPick,
  holdMapPlot,
  holdMapReadout,
  holdMapReveal,
  holdMapRevealRange,
  holdMapSelMark,
  holdMapStatusText,
  holdMapStep,
  holdMapSummary,
  holdMapTitle,
  holdMapWait,
} from '../../view/holdMap';
import type { AmountUnit } from '../../view/metrics';
import { Popover } from '../parts/Popover';
import { useSize } from '../useSize';

/**
 * 追証マップを開いてから、中身の大きさが変わるたびに描画域を枠に入れ直す時間（#254）。開いてから描画域の幅が決まるまでの
 * 実測（dev・合成の板・900 / 1440）は負荷あり（load 6）で中央値 27〜29ms・最大 62ms、さらに CPU を 6 倍遅くして中央値
 * 157ms・最大 296ms。その 3 倍余りの余裕
 */
const HOLD_REVEAL_MS = 1000;

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
  /** 許容損失（円。未設定は null。#180。変えても計算し直さず描き直すだけ） */
  allowedLoss: number | null;
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
  const { allowedLoss } = hold;
  const plot = useMemo(
    () => (result && width > 60 ? holdMapPlot(result, moves, width, allowedLoss) : null),
    [result, moves, width, allowedLoss],
  );
  const legend = holdMapLegend(allowedLoss);
  const [sel, setSel] = useState<HoldMapSel | null>(null);
  const axes = result?.axes ?? null;
  const dxX = axes && width > 60 ? holdMapDxX(axes, width, hold.dXRatio) : null;
  const mark = plot && axes ? holdMapSelMark(sel, plot, axes) : null;
  // 十字線（#217。docs/ui-redesign.md §4.1 の共通の規則）: マウスのホバー、タッチのタップ（出ていなければ置く・出ていれば消す。
  // マス・点の選択は今のまま）、交点の ±14px をつかんでドラッグ（その間はページを止める）。位置は要素の座標の画素で持ち、
  // マスの中心に吸着して描く（holdMapCrosshair）
  const [hover, setHover] = useState<{ x: number; y: number; touch: boolean } | null>(null);
  const xh = useMemo(
    () =>
      plot && result && hover
        ? holdMapCrosshair(plot, result, hover.x, hover.y, moves, unit, allowedLoss)
        : null,
    [plot, result, hover, moves, unit, allowedLoss],
  );
  const readout = xh ? xh.readout : holdMapReadout(sel, result, moves, unit, allowedLoss);
  const press = useRef(initialPress());
  const lastTouch = useRef(false);
  const hoverFrame = useRef(0);
  const hoverAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);
  const local = (e: PointerEvent | MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const applyPress = (res: PressResult) => {
    press.current = res.state;
    if (res.cross) setHover({ ...res.cross, touch: true });
    if (res.tap && plot && axes) {
      const t = res.tap;
      setSel(holdMapPick(plot, axes, t.x, t.y));
      setHover(crossTapAction(xh !== null) === 'hide' ? null : { ...t, touch: true });
    }
  };
  // 交点をつかんでいる間はページ・シートを動かさない（touchmove の preventDefault。押した直後 = スクロールが始まる前なので効く）
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
    // タッチのタップは pointer の状態機械が扱う（click は使わない）。マウスのクリックは選択だけ（ホバーの十字線のまま）
    if (lastTouch.current) return;
    const at = local(e);
    setSel(holdMapPick(plot, axes, at.x, at.y));
  };
  const onPointerDown = (e: PointerEvent) => {
    lastTouch.current = e.pointerType !== 'mouse';
    if (e.pointerType === 'mouse' || !plot) return;
    const grab = hover?.touch && xh ? { x: xh.x, y: xh.y } : null;
    applyPress(
      pressDown(
        press.current,
        { id: e.pointerId, ...local(e), t: e.timeStamp },
        grab,
        CROSS_TOUCH_GRAB_PX,
      ),
    );
  };
  const onPointerMove = (e: PointerEvent) => {
    const at = local(e);
    if (e.pointerType !== 'mouse') {
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
    const sample = { id: e.pointerId, ...local(e), t: e.timeStamp };
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
      // キーで選んだマスの 1 行を出す（ホバー・タップの十字線の 1 行より先に）
      setHover(null);
      setSel(next);
      e.preventDefault();
    }
  };
  const h = holdMapHeight(width);
  return (
    <>
      {legend.length > 0 && (
        <p class="hm-legend">
          {legend.map((k) => (
            <span key={k.cls} class="hm-key">
              <span class={`hm-sw ${k.cls}`} aria-hidden="true" />
              {k.label}
            </span>
          ))}
        </p>
      )}
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
              {plot.lossContour && <path class="hm-loss-line" d={plot.lossContour} />}
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
    </>
  );
}

/**
 * 追証マップ（#152。docs/ui-redesign.md §3・docs/design.md 5.11）: 指標 · テールの末尾の折りたたみ（既定は閉・
 * 開閉は ShellState.holdMap = セッション中だけ）。見出しの行に結論（過去 N 回中 M 回が追証の側。閉じていても出す）と ⓘ
 * （説明・追証の側の注意・過去の点の注記。#274）。表示モデルは ui/view/holdMap.ts、計算の時機は useHoldMap、
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
  // 開いたとき（前の描画で閉 → 今開。マウント時の開では動かさない）だけ、描画域と読み取りがパネルのスクロール枠に入るよう
  // 枠の scrollTop だけを動かす（#174。scrollIntoView は祖先・ページまで動かしうるので使わない）。閉じるときは動かさない。
  // 初めの描画は描画域が仮の幅 320px の高さで、useSize が測った幅の高さになるのは useEffect の後（負荷が高いと 2 フレーム
  // より遅れる。#254）。なので中身（.hm）の大きさを ResizeObserver で見て、開いてから HOLD_REVEAL_MS の間は大きさが
  // 変わるたびに測り直して動かす（最初の通知は observe の直後 = 開いた描画のレイアウトの後）。利用者が枠を操作したら
  // （ホイール・ポインター（マウス・タッチ・ペン）・キー）そこで止める（自分で動かした位置を奪わない）
  useLayoutEffect(() => {
    const opened = hold.open && !wasOpen.current;
    wasOpen.current = hold.open;
    if (!opened) return;
    const body = bodyRef.current;
    const found = body?.closest('.panel-body');
    if (!body || !(found instanceof HTMLElement)) return;
    const host: HTMLElement = found;
    const reveal = () => {
      // 描画域の上端 〜 読み取りの 1 行の下端（#259 H-2。タップの値まで見せる。読み取りは 3 行分の高さで固定）。
      // 資金なし・足なしは描画域が無いので中身（.hm）の全体
      // #274: 見出しの行（.hm-head = 中身の直前）は描画域と一緒に入る高さなら残す（holdMapRevealRange）
      const top = body.querySelector('.hm-plot') ?? body;
      const bottom = body.querySelector('.hm-readout') ?? top;
      // 見出しの行の上の罫線（1px）は隠れてよい = 折りたたみのボタンの上端
      const head = body.previousElementSibling?.querySelector('.hm-toggle') ?? top;
      const oy = getComputedStyle(host).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return;
      const h = host.getBoundingClientRect();
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const t = top.getBoundingClientRect();
      const r = holdMapRevealRange(
        head.getBoundingClientRect().top,
        t.top,
        t.bottom,
        bottom.getBoundingClientRect().bottom,
        h.height,
      );
      const { delta, behavior } = holdMapReveal(r.top, r.bottom, h.top, h.bottom, reduced);
      if (delta !== 0) host.scrollTo({ top: host.scrollTop + delta, behavior });
    };
    const ro = new ResizeObserver(reveal);
    // pointerdown はマウス・タッチ・ペンのどれでも出る
    const stopEvents = ['wheel', 'pointerdown', 'keydown'] as const;
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      ro.disconnect();
      for (const ev of stopEvents) host.removeEventListener(ev, stop);
    };
    ro.observe(body);
    for (const ev of stopEvents) host.addEventListener(ev, stop, { passive: true });
    timer = window.setTimeout(stop, HOLD_REVEAL_MS);
    return stop;
  }, [hold.open]);
  const moves = hold.moves.status === 'ok' ? hold.moves.moves : [];
  const result = hold.map.result;
  const summary = useMemo(
    () => (blocked ? null : holdMapHeadSummary(result, moves)),
    [blocked, result, moves],
  );
  return (
    <>
      <div class="hm-head">
        <button
          type="button"
          class="hm-toggle"
          aria-expanded={hold.open}
          aria-controls={id}
          onClick={hold.onToggle}
        >
          <span class="hm-title">{holdMapTitle(hold.days, !blocked)}</span>
          {summary && <span class={hold.map.computing ? 'hm-sum stale' : 'hm-sum'}>{summary}</span>}
        </button>
        {/* 説明・追証の側の注意・過去の点の注記は ⓘ に（#274。開いた中は凡例・描画域・触った 1 行だけ） */}
        <Popover label="追証マップの読み方" button="ⓘ">
          <p>{holdMapCaption(blocked ? null : hold.allowedLoss)}</p>
          <p>{HOLD_MAP_CALL_NOTE}</p>
          {moves.length > 0 && <p>{holdMapNote(moves, hold.days)}</p>}
        </Popover>
      </div>
      {hold.open && (
        <div id={id} ref={bodyRef} class="hm">
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

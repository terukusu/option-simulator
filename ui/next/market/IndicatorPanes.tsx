import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Indicators } from '../../../model';
import { DOUBLE_TAP_PX } from '../../chart/gesture';
import type { Domain } from '../../chart/scale';
import {
  initialSplit,
  type SplitResult,
  type SplitSample,
  splitCancel,
  splitDown,
  splitMove,
  splitUp,
} from '../../chart/split';
import { pure } from '../../components/pure';
import { useChartGestures } from '../../components/useChartGestures';
import {
  type FutPaneLayout,
  futPaneAt,
  futPaneDrag,
  futSplitAt,
  IND_PANE_MIN_H,
  type IndCross,
  type IndKind,
  type IndPaneHeights,
  type IndPaneModel,
  type IndReadout,
  indCrosshair,
  indPaneModel,
  indReadout,
  indSplitLabel,
} from '../../view/indicators';
import { IV_MIN_BARS, ivFullDomain, ivIndexAt } from '../../view/ivHistory';

/** 段の上の十字線（触っている段・段の座標の高さ・タッチか） */
export interface IndPaneCursor {
  pane: IndKind;
  y: number;
  touch: boolean;
}

export interface IndicatorPanesProps {
  /** 足の並び全体の指標（model の indicators。FutHistory が足・期間ごとに 1 回計算する。期間は ind.params） */
  ind: Indicators;
  n: number;
  viewport: Domain;
  /** 価格の描画域の左の余白（系列の目盛りの列） */
  marginLeft: number;
  cursor: number | null;
  /** 価格と段の配置（#207。futPaneLayout。最大化中はその段だけ） */
  layout: FutPaneLayout;
  /** 価格と段を包む枠（.fut-stack）の幅・高さ */
  width: number;
  stackH: number;
  /** 左の余白（本。価格の描画域と同じ全域を作る） */
  leftSlack: number;
  /** 段の上の十字線（無ければ縦線だけ = 価格の上のカーソル） */
  paneCursor: IndPaneCursor | null;
  onViewport: (v: Domain | null) => void;
  /** カーソルの足（null = 外す）。pane = 触っている段と段の座標の高さ（無ければ縦線だけ） */
  onCursor: (i: number | null, at?: IndPaneCursor | null) => void;
  /** 段の描画域のダブルタップ / ダブルクリック・Enter（最大化 ⇄ 戻す） */
  onMax: (kind: IndKind) => void;
  /** 境目のドラッグ中の高さ（1 フレーム 1 回。null = 押す前に戻す） */
  onPaneLive: (h: IndPaneHeights | null) => void;
  /** 境目を離した・キーで変えた高さ（保存する） */
  onPaneCommit: (h: IndPaneHeights) => void;
  /** 境目のダブルタップ / ダブルクリック・Enter（既定の高さに戻す） */
  onPaneReset: () => void;
}

function Pane({
  m,
  ro,
  cross,
  max,
}: {
  m: IndPaneModel;
  ro: IndReadout;
  cross: IndCross | null;
  max: boolean;
}) {
  const { width: w, height: h, range } = m;
  return (
    <svg
      class={`ind-pane ${m.kind}`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={m.imgLabel}
    >
      <line class="ind-sep" x1={0} x2={w} y1={0.5} y2={0.5} />
      {m.guides.map((g) => (
        <g key={`g${g.label}`}>
          <line
            class={g.zero ? 'ind-guide zero' : 'ind-guide'}
            x1={range[0]}
            x2={range[1]}
            y1={g.y}
            y2={g.y}
          />
          <text class="ind-ty" x={range[0] - 5} y={g.y}>
            {g.label}
          </text>
        </g>
      ))}
      {m.histUp && <path class="ind-hist up" d={m.histUp} />}
      {m.histDown && <path class="ind-hist down" d={m.histDown} />}
      {m.lines.map((l) => (
        <path key={l.cls} class={l.cls} d={l.d || 'M0 0'} />
      ))}
      {ro.cursorX !== null && (
        <line class="ind-cursor" x1={ro.cursorX} x2={ro.cursorX} y1={2} y2={h - 2} />
      )}
      {cross && (
        <g class="ind-cross">
          <line class="ind-cursor h" x1={range[0]} x2={range[1]} y1={cross.y} y2={cross.y} />
          <g class="ind-tag">
            <rect x={cross.tag.x} y={cross.tag.y} width={cross.tag.w} height={cross.tag.h} />
            <text x={cross.tag.x + cross.tag.w / 2} y={cross.tag.y + cross.tag.h / 2}>
              {cross.text}
            </text>
          </g>
        </g>
      )}
      <text class="ind-head" x={range[0] + 4} y={3}>
        <tspan class="name">{m.title}</tspan>
        {ro.values.map((v) => (
          <tspan key={v.cls} class={`v ${v.cls}`} dx={6}>
            {v.k ? `${v.k} ` : ''}
            {v.v}
          </tspan>
        ))}
        {max && (
          <tspan class="hint" dx={10}>
            ダブルタップで戻す
          </tspan>
        )}
      </text>
    </svg>
  );
}

/** 境目を離してからの dblclick を境目のものとみなす時間（ms） */
const SPLIT_DBL_MS = 150;

/** キーで動かす量（px。Shift で 4 倍） */
const SPLIT_KEY_PX = 8;

/**
 * 先物推移の指標の段（#200・#207。docs/ui-redesign.md §4.8）。座標は ui/view/indicators.ts の indPaneModel、値は
 * model/technicals.ts（AI のツール technicals と同じ計算）。価格の描画域（IvPlot）と同じ表示範囲・横の画素範囲。
 * #207: 段の高さは配置（futPaneLayout）の値を svg の height 属性で描く（style 属性なし）。段の前に境目（role="separator"）、
 * 段の枠に useChartGestures（パン・ピンチ・ホイール・キー・長押し / ホバーの十字線・ダブルタップで最大化）。
 * 色は CSS のクラスだけ。
 */
function IndicatorPanesView(p: IndicatorPanesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { layout, width, n, viewport } = p;
  const kinds = layout.panes.map((s) => s.kind);
  const models = useMemo(
    () =>
      layout.panes.map((s) =>
        indPaneModel({
          ind: p.ind,
          kind: s.kind,
          n,
          viewport,
          width,
          marginLeft: p.marginLeft,
          height: s.h,
        }),
      ),
    [p.ind, layout, n, viewport, width, p.marginLeft],
  );
  // 縦線と値はカーソルだけで作り直す（線の座標は作り直さない）
  const readouts = useMemo(
    () => models.map((m) => indReadout(p.ind, m.kind, n, viewport, m.range, p.cursor)),
    [models, p.ind, n, viewport, p.cursor],
  );
  const pc = p.paneCursor;
  const crosses = useMemo(
    () => models.map((m) => (pc && pc.pane === m.kind ? indCrosshair(m, pc.y) : null)),
    [models, pc],
  );
  const range: Domain = models[0]?.range ?? [p.marginLeft, width];
  const full = ivFullDomain(n, p.leftSlack);
  const indexAt = (x: number) => ivIndexAt(x, viewport, range, n);
  // 指 / マウスの位置（段の枠の座標）と種類。長押しの scrub は x だけを返すので押下・移動のたびに控える
  const ptr = useRef<{ y: number; touch: boolean }>({ y: 0, touch: false });
  const track = (e: PointerEvent) => {
    ptr.current = {
      y: e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top,
      touch: e.pointerType !== 'mouse',
    };
  };
  const at = (y: number, touch: boolean): IndPaneCursor | null => {
    const slot = futPaneAt(layout, y);
    return slot ? { pane: slot.kind, y: y - slot.top, touch } : null;
  };

  useChartGestures(ref, {
    viewport,
    full,
    minWidth: Math.min(IV_MIN_BARS, full[1] - full[0]),
    range,
    disabled: n === 0,
    onViewport: p.onViewport,
    onTap: () => p.onCursor(null),
    scrub: { linePx: null },
    onScrub: (x) => p.onCursor(indexAt(x), at(ptr.current.y, ptr.current.touch)),
    onDouble: (_x, y) => {
      // 境目の帯の上のダブルクリックは境目（既定の高さ）が扱う。既定に戻すと配置が変わるので、帯の判定だけでなく
      // 直前（SPLIT_DBL_MS 以内）に境目を離したかでも除く（dblclick は 2 回目の pointerup の直後に来る）
      if (futSplitAt(layout, y, false) !== null) return;
      // 位置は画面の座標で比べる（既定に戻すと段の枠の上端が動く）
      const sa = splitAt.current;
      const cy = y + (ref.current?.getBoundingClientRect().top ?? 0);
      if (performance.now() - sa.t < SPLIT_DBL_MS && Math.abs(cy - sa.y) <= DOUBLE_TAP_PX) return;
      const slot = futPaneAt(layout, y);
      if (slot) p.onMax(slot.kind);
    },
    onScrubKey: (key) => {
      if (key === 'Enter') {
        const k = pc?.pane ?? layout.max ?? kinds[0];
        if (k) p.onMax(k);
        return k !== undefined;
      }
      if (key !== ',' && key !== '.') return false;
      const from = p.cursor ?? n - 1;
      p.onCursor(Math.min(Math.max(from + (key === ',' ? -1 : 1), 0), n - 1), pc);
      return true;
    },
  });

  // 境目（#207）: 押下の状態機械（ui/chart/split.ts）と 1 フレーム 1 回の反映。境目の要素は pointer-events: none
  // （Chrome のタッチの当たりの補正 = touch adjustment が、近くのフォーカスできる境目に段の上の押下を吸い寄せないように）で、
  // 当たり判定は段の枠の座標で futSplitAt が決める。押下は捕捉の段階で取り、useChartGestures に渡さない
  const [hot, setHot] = useState<number | null>(null);
  /** 最後に境目を離した時刻（performance.now）と位置（画面の座標。境目のダブルクリックの dblclick を最大化にしない） */
  const splitAt = useRef({ t: Number.NEGATIVE_INFINITY, y: 0 });
  const latest = useRef(p);
  latest.current = p;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s = initialSplit();
    let start: FutPaneLayout | null = null;
    let border = 0;
    let pendingDy: number | null = null;
    let frame = 0;
    let hotNow: number | null = null;
    const setHotOnce = (v: number | null) => {
      if (v === hotNow) return;
      hotNow = v;
      setHot(v);
    };
    const localY = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;
    const sample = (e: PointerEvent): SplitSample => ({
      id: e.pointerId,
      y: e.clientY,
      t: e.timeStamp,
    });
    const heights = (dy: number) =>
      start ? futPaneDrag(start, border, dy, latest.current.stackH) : null;
    const stopFrame = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pendingDy = null;
    };
    const apply = (res: SplitResult) => {
      s = res.state;
      const o = latest.current;
      if (res.reset || res.cancel || res.end) {
        const h = res.end && res.dy !== undefined ? heights(res.dy) : null;
        stopFrame();
        start = null;
        if (res.reset) o.onPaneReset();
        else if (res.cancel) o.onPaneLive(null);
        else if (h) o.onPaneCommit(h);
        return;
      }
      if (res.dy === undefined) return;
      pendingDy = res.dy;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          const dy = pendingDy;
          pendingDy = null;
          const h = dy === null ? null : heights(dy);
          if (h) latest.current.onPaneLive(h);
        });
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (s.border !== null) return;
      const b = futSplitAt(latest.current.layout, localY(e), e.pointerType !== 'mouse');
      if (b === null) return;
      // 段の操作（パン・長押し・ダブルタップ）には渡さない（押した所が段の枠そのものでも = 同じ要素の後の listener も止める）
      e.stopImmediatePropagation();
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture できない環境でも続ける
      }
      start = latest.current.layout;
      border = b;
      setHotOnce(b);
      apply(splitDown(s, sample(e), b));
    };
    const onMove = (e: PointerEvent) => {
      if (s.border !== null) {
        e.preventDefault();
        apply(splitMove(s, sample(e)));
        return;
      }
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        setHotOnce(futSplitAt(latest.current.layout, localY(e), false));
      }
    };
    const onUp = (e: PointerEvent) => {
      if (s.border === null) return;
      splitAt.current = { t: performance.now(), y: e.clientY };
      apply(splitUp(s, sample(e)));
      if (e.pointerType !== 'mouse') setHotOnce(null);
    };
    const onCancel = () => {
      if (s.border === null) return;
      apply(splitCancel(s));
      setHotOnce(null);
    };
    const onLeave = (e: PointerEvent) => {
      if (s.border === null && e.pointerType === 'mouse') setHotOnce(null);
    };
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('lostpointercapture', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      stopFrame();
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, []);
  // 境目にフォーカスしたキー: ↑ ↓ で 8px（Shift で 32px）、Enter で既定の高さ
  const onSplitKey = (e: KeyboardEvent, b: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      p.onPaneReset();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const step = (e.shiftKey ? 4 : 1) * SPLIT_KEY_PX;
    p.onPaneCommit(futPaneDrag(layout, b, e.key === 'ArrowUp' ? -step : step, p.stackH));
  };

  // スマホ（タッチ）の十字線: 触っている段の名前・横線の値・その足の値を指から離れた所（枠の上端、指が上側なら下端）にも
  const fi = pc?.touch ? models.findIndex((m) => m.kind === pc.pane) : -1;
  const fm = fi >= 0 ? models[fi] : undefined;
  const fc = fi >= 0 ? crosses[fi] : null;
  const fro = fi >= 0 ? readouts[fi] : undefined;
  const slot = fi >= 0 ? layout.panes[fi] : undefined;
  const fingerY = pc && slot ? layout.priceH + slot.top + pc.y : 0;
  const floatBottom = p.stackH > 0 && fingerY < p.stackH * 0.4;

  return (
    <div
      class={`ind-panes n${kinds.length}${layout.max ? ' max' : ''}${hot !== null ? ' split-hot' : ''}`}
      ref={ref}
      tabIndex={n === 0 || layout.panes.length === 0 ? -1 : 0}
      role="application"
      aria-label="指標の段（矢印でパン・+ − で拡大・, . で足を読む・Enter で段を最大化 / 戻す）"
      onPointerDown={track}
      onPointerMove={(e) => {
        track(e);
        if (e.pointerType !== 'mouse' || e.buttons !== 0 || n === 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - r.left;
        const a = at(ptr.current.y, false);
        p.onCursor(x >= range[0] && x <= range[1] && a ? indexAt(x) : null, a);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') p.onCursor(null);
      }}
    >
      {layout.panes.map((s, i) => {
        const m = models[i] as IndPaneModel;
        return (
          <Fragment key={s.kind}>
            {!layout.max && (
              // biome-ignore lint/a11y/useSemanticElements: 動かせる境目（hr は focus・値を持てない）。WAI-ARIA の window splitter
              <div
                class={hot === i ? 'ind-split hot' : 'ind-split'}
                role="separator"
                aria-orientation="horizontal"
                aria-label={indSplitLabel(kinds, i)}
                aria-valuenow={s.h}
                aria-valuemin={IND_PANE_MIN_H}
                aria-valuemax={Math.max(p.stackH, IND_PANE_MIN_H)}
                tabIndex={0}
                onKeyDown={(e) => onSplitKey(e, i)}
              />
            )}
            <Pane
              m={m}
              ro={readouts[i] as IndReadout}
              cross={crosses[i] ?? null}
              max={layout.max !== null}
            />
          </Fragment>
        );
      })}
      {fm && fc && fro && (
        <div class={floatBottom ? 'ind-float bottom' : 'ind-float'} aria-hidden="true">
          <span class="name">{fm.title}</span>
          <span class="ruler">
            <span class="k">横線</span>
            {fc.text}
          </span>
          {fro.values.map((v) => (
            <span key={v.cls} class={`v ${v.cls}`}>
              {v.k ? `${v.k} ` : ''}
              {v.v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export const IndicatorPanes = pure(IndicatorPanesView);

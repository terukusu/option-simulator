import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChainMonth } from '../../../data';
import type { AtmBasis } from '../../../model';
import { type Domain, fitTicks, linear, niceTicks } from '../../chart/scale';
import { pure } from '../../components/pure';
import { useChartGestures } from '../../components/useChartGestures';
import type { Action } from '../../state';
import { CROSS_TOUCH_GRAB_PX } from '../../view/crosshair';
import { fmtNum } from '../../view/format';
import {
  AXIS_LABEL,
  axisTickLabel,
  axisValue,
  pickStrike,
  SCRUB_KEY_STEPS,
  SMILE_MARGIN,
  type SmileAxis,
  type SmileCursor,
  scrubStrike,
  smileCrosshair,
  smileCursorAt,
  smileMarkX,
  smileModel,
  smileTapCursor,
  stepStrike,
  tapStrike,
} from '../../view/smile';
import { SMILE_LINE_CLASS, SMILE_PLOT_LABEL } from '../../view/smilePanel';
import { useSize } from '../useSize';

const M = SMILE_MARGIN;
/** 横軸の刻みの下限（旧 Smile と同じ。#55） */
const X_TICK_MIN_STEP: Record<SmileAxis, number> = { k: 1, moneyness: 0.001, delta: 0.01 };
/** 選択の K のラベルを描画域の端から離す幅（px） */
const LABEL_HALF = 22;

export interface SmilePlotProps {
  month: ChainMonth;
  active: boolean;
  basis: AtmBasis;
  axis: SmileAxis;
  viewport: Domain | null;
  pick: number | null;
  scenarioAtmK: number | null;
  dispatch: (a: Action) => void;
}

/**
 * 限月 1 つのスマイルの描画域（#85。旧 Smile の描画と useChartGestures の設定を写した）。高さは残りの高さ（useSize）。
 * 縦線: ATM = .atm（--handle の破線）、シナリオ ATM = .atm2（--pin2 の点線）、選択 = .sel（--ink）+ 上端の K のラベル。
 * 十字線（#217。docs/ui-redesign.md §4.1 の共通の規則）: PC のホバー、タッチのタップ（点のタップは選択 + 点に吸着、点の外は
 * 置く / 消す。交点の ±14px をつかんで動かす）。長押しは今のまま選択のスクラブ。カーソルは値の座標のローカル state
 * （smileCrosshair）。横軸を替えたら・ダブルタップで消す。
 */
function SmilePlotView(p: SmilePlotProps) {
  const { month, active, basis, axis, viewport, pick, scenarioAtmK, dispatch } = p;
  const model = useMemo(
    () => smileModel(month, basis, axis, viewport),
    [month, basis, axis, viewport],
  );
  const scnAtmX = useMemo(
    () => smileMarkX(model, month, basis, axis, scenarioAtmK),
    [model, month, basis, axis, scenarioAtmK],
  );
  const { ref, width, height } = useSize(480, 200);
  const w = Math.max(width, M.left + M.right + 10);
  const h = Math.max(height, M.top + M.bottom + 10);
  const sx = linear(model.domain, [M.left, w - M.right]);
  const sy = linear(model.yDomain, [h - M.bottom, M.top]);
  const range: Domain = [M.left, w - M.right];
  const xTicks = fitTicks(
    model.domain[0],
    model.domain[1],
    range[1] - range[0],
    (t) => axisTickLabel(axis, t),
    { minStepFor: () => X_TICK_MIN_STEP[axis], widthSample: model.fullDomain },
  );
  const yTicks = niceTicks(model.yDomain[0], model.yDomain[1], h < 180 ? 3 : 4);

  const pickInfo = pick === null ? undefined : month.strikes.find((s) => s.k === pick);
  const pickX = pickInfo ? axisValue(month, basis, axis, pickInfo) : null;
  const pickPx =
    pickX !== null && Number.isFinite(pickX) && pickX >= model.domain[0] && pickX <= model.domain[1]
      ? sx(pickX)
      : null;
  /** 十字線のカーソル（値の座標。#217）と指 / マウスの位置（タッチ・マウスの区別） */
  const [cursor, setCursor] = useState<SmileCursor | null>(null);
  const ptr = useRef<{ y: number; touch: boolean }>({ y: 0, touch: false });
  const hoverFrame = useRef(0);
  const hoverAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);
  useEffect(() => {
    if (!active) setCursor(null);
  }, [active]);
  // 横軸の値の座標が変わるので消す（軸の切替は親の props）
  useEffect(() => {
    if (axis) setCursor(null);
  }, [axis]);
  // タッチの交点をつかんで動かしている間（#227。この間だけ読み取りを指で隠れない所へ）
  const [held, setHeld] = useState(false);
  const xh = useMemo(() => smileCrosshair(model, cursor, w, h, held), [model, cursor, w, h, held]);
  const select = (k: number | null) => {
    if (k !== null && k !== pick) dispatch({ type: 'pickSmile', pick: { monthId: month.id, k } });
  };

  useChartGestures(ref, {
    viewport: model.domain,
    full: model.fullDomain,
    minWidth: model.minWidth,
    range,
    disabled: model.empty || !active,
    onViewport: (v) => {
      // ダブルタップ・R の初期表示ではタッチの十字線も消す（ダブルタップの 1 回目で置いた十字線を残さない。#217）
      if (v === null) setCursor((c) => (c?.touch ? null : c));
      dispatch({ type: 'setViewport', viewport: v });
    },
    onTap: (x, y) => {
      const k = tapStrike(model, x, range, pick);
      dispatch({ type: 'pickSmile', pick: k === null ? null : { monthId: month.id, k } });
      // マウスのクリックは選択だけ（ホバーの十字線のまま）
      if (!ptr.current.touch) return;
      // タッチ（#217 の共通の規則）: 点のタップは選択（今のまま）+ 十字線をその点に。解除したら消す。点の外は
      // 出ていなければ置く・出ていれば消す
      // 「出ている」は描いている十字線（表示範囲の外なら置く。#227）
      setCursor(
        smileTapCursor(model, {
          shown: xh !== null,
          onDot: pickStrike(model, x, range) !== null,
          k,
          x,
          y,
          width: w,
          height: h,
        }),
      );
    },
    ...(cursor?.touch && xh
      ? {
          cross: { pointPx: { x: xh.px, y: xh.py }, grabPx: CROSS_TOUCH_GRAB_PX },
          onCross: (x: number, y: number) =>
            setCursor(smileCursorAt(model, x, y, w, h, true, true)),
        }
      : {}),
    onCrossHold: setHeld,
    // 長押し（今のまま）: 選択を最寄りの点へ切り替える
    scrub: { linePx: null },
    onScrub: (x) => select(scrubStrike(model, x, range)),
    // 長押しの選択のスクラブの間（#223）はマウスのホバーの十字線を出さない（未反映のホバーも捨てる。タッチの十字線は残す）
    onGrab: () => {
      hoverAt.current = null;
      setCursor((c) => (c && !c.touch ? null : c));
    },
    onScrubKey: (key) => {
      const steps = SCRUB_KEY_STEPS[key];
      if (steps === undefined) return false;
      select(stepStrike(model, pick, steps));
      return true;
    },
  });

  // 線・点・× の path は表示範囲と大きさが変わったときだけ作る（限月の切替・選択では作り直さない）
  const paths = useMemo(() => {
    const px = linear(model.domain, [M.left, w - M.right]);
    const py = linear(model.yDomain, [h - M.bottom, M.top]);
    let solid = '';
    let dotted = '';
    for (const s of model.segments) {
      const d = `M${px(s.x1).toFixed(1)} ${py(s.y1).toFixed(1)}L${px(s.x2).toFixed(1)} ${py(s.y2).toFixed(1)}`;
      if (s.style === 'solid') solid += d;
      else dotted += d;
    }
    const dots: Record<'bid' | 'ask' | 'mid', string> = { bid: '', ask: '', mid: '' };
    for (const pt of model.points) {
      const r = pt.kind === 'mid' ? 2.5 : 2;
      const x = px(pt.x) - r;
      const y = py(pt.iv);
      dots[pt.kind] +=
        `M${x.toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
    }
    let cross = '';
    for (const u of model.unstable) {
      const x = px(u.x);
      const y = py(u.iv);
      cross += `M${(x - 4).toFixed(1)} ${(y - 4).toFixed(1)}l8 8M${(x - 4).toFixed(1)} ${(y + 4).toFixed(1)}l8 -8`;
    }
    return { solid, dotted, dots, cross };
  }, [model, w, h]);
  const { solid, dotted, dots, cross } = paths;
  const vline = (cls: string, x: number) => (
    <line class={cls} x1={x} x2={x} y1={M.top} y2={h - M.bottom} />
  );
  const labelX =
    pickPx === null ? 0 : Math.min(Math.max(pickPx, M.left + LABEL_HALF), w - M.right - LABEL_HALF);

  return (
    <div
      class={active ? 'smile-month' : 'smile-month inactive'}
      data-month={month.id}
      aria-hidden={active ? undefined : true}
      inert={!active}
    >
      <div
        class="smile-wrap"
        ref={ref}
        tabIndex={model.empty || !active ? -1 : 0}
        role="application"
        aria-label={SMILE_PLOT_LABEL}
        onPointerDown={(e) => {
          ptr.current = {
            y: e.clientY - e.currentTarget.getBoundingClientRect().top,
            touch: e.pointerType !== 'mouse',
          };
        }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ptr.current = { y: e.clientY - r.top, touch: e.pointerType !== 'mouse' };
          // ホバー（マウス・ボタンを押していない間だけ。1 フレーム 1 回）
          if (e.pointerType !== 'mouse' || e.buttons !== 0 || model.empty) return;
          hoverAt.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          if (hoverFrame.current) return;
          hoverFrame.current = requestAnimationFrame(() => {
            hoverFrame.current = 0;
            const at = hoverAt.current;
            if (at) setCursor(smileCursorAt(model, at.x, at.y, w, h, false, false));
          });
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== 'mouse') return;
          hoverAt.current = null;
          setCursor((c) => (c && !c.touch ? null : c));
        }}
      >
        {model.empty ? (
          <p class="smile-empty">スマイルなし（F が決まらないか、使える気配が無い）</p>
        ) : (
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-label={`${month.id} 限のスマイル（横軸 ${AXIS_LABEL[axis]}、縦軸 IV %）`}
          >
            <g class="grid">
              {yTicks.map((t) => (
                <line key={`y${t}`} x1={M.left} x2={w - M.right} y1={sy(t)} y2={sy(t)} />
              ))}
              {xTicks.map((t) => (
                <line key={`x${t}`} x1={sx(t)} x2={sx(t)} y1={M.top} y2={h - M.bottom} />
              ))}
            </g>
            <g class="ax">
              {yTicks.map((t) => (
                <text key={`y${t}`} x={M.left - 5} y={sy(t)} class="ty">
                  {fmtNum(t, 0)}
                </text>
              ))}
              {xTicks.map((t) => (
                <text key={`x${t}`} x={sx(t)} y={h - M.bottom + 15} class="tx">
                  {axisTickLabel(axis, t)}
                </text>
              ))}
            </g>
            {model.atmX !== null && vline(SMILE_LINE_CLASS.atm, sx(model.atmX))}
            {scnAtmX !== null && vline(SMILE_LINE_CLASS.scenario, sx(scnAtmX))}
            <path class="curve" d={solid || 'M0 0'} />
            <path class="curve ext" d={dotted || 'M0 0'} />
            {(['bid', 'ask', 'mid'] as const).map((kind) => (
              <path key={kind} class={`pt ${kind}`} d={dots[kind] || 'M0 0'} />
            ))}
            <path class="pt x" d={cross || 'M0 0'} />
            {pickPx !== null && vline(SMILE_LINE_CLASS.pick, pickPx)}
            {pickPx !== null && pick !== null && (
              <text class="sellbl" x={labelX} y={M.top - 3}>
                {fmtNum(pick, 0)}
              </text>
            )}
            {xh && (
              <g class="xc">
                <line class="xc-line v" x1={xh.px} x2={xh.px} y1={M.top} y2={h - M.bottom} />
                <line class="xc-line h" x1={M.left} x2={w - M.right} y1={xh.py} y2={xh.py} />
                {xh.dotPy !== null && <circle class="xc-dot" cx={xh.px} cy={xh.dotPy} r={3} />}
                {[xh.xTag, xh.yTag].map((t, i) => (
                  <g key={i === 0 ? 'x' : 'y'} class={i === 0 ? 'xc-tag x' : 'xc-tag y'}>
                    <rect x={t.x} y={t.y} width={t.w} height={t.h} />
                    <text x={t.x + t.w / 2} y={t.y + t.h / 2}>
                      {t.text}
                    </text>
                  </g>
                ))}
                <text
                  class={xh.read.anchor === 'end' ? 'xc-val end' : 'xc-val'}
                  x={xh.read.x}
                  y={xh.read.y}
                >
                  {xh.read.text}
                </text>
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

export const SmilePlot = pure(SmilePlotView);

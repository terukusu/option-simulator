import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChainMonth } from '../../data';
import type { AtmBasis } from '../../model';
import { type Domain, linear, niceTicks, zoom } from '../chart/scale';
import type { Action } from '../state';
import { fmtNum } from '../view/format';
import { AXIS_LABEL, axisTickLabel, type SmileAxis, smileModel } from '../view/smile';
import { pure } from './pure';

const HEIGHT = 240;
const M = { left: 40, right: 12, top: 10, bottom: 26 };

export interface SmileProps {
  month: ChainMonth;
  /** 表示中の限月か（限月ごとに持ち、表示中でないものは CSS で描画を止めて保つ） */
  active: boolean;
  basis: AtmBasis;
  axis: SmileAxis;
  viewport: Domain | null;
  dispatch: (a: Action) => void;
}

function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(200, Math.floor(el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** スマイル（SVG。座標は ui/view/smile.ts・ui/chart/scale.ts の純関数）。 */
function SmileView({ month, active, basis, axis, viewport, dispatch }: SmileProps) {
  const model = useMemo(
    () => smileModel(month, basis, axis, viewport),
    [month, basis, axis, viewport],
  );
  const { ref, width } = useWidth(480);

  const sx = linear(model.domain, [M.left, width - M.right]);
  const sy = linear(model.yDomain, [HEIGHT - M.bottom, M.top]);
  const xTicks = niceTicks(model.domain[0], model.domain[1], width < 420 ? 3 : 5);
  const yTicks = niceTicks(model.yDomain[0], model.yDomain[1], 4);

  let solid = '';
  let dotted = '';
  for (const s of model.segments) {
    const d = `M${sx(s.x1).toFixed(1)} ${sy(s.y1).toFixed(1)}L${sx(s.x2).toFixed(1)} ${sy(s.y2).toFixed(1)}`;
    if (s.style === 'solid') solid += d;
    else dotted += d;
  }
  // 点は種類ごとに 1 本の path（円弧 2 つで円）。要素数を抑えて描き直しを軽くする
  const dots: Record<'bid' | 'ask' | 'mid', string> = { bid: '', ask: '', mid: '' };
  for (const p of model.points) {
    const r = p.kind === 'mid' ? 2.5 : 2;
    const x = sx(p.x) - r;
    const y = sy(p.iv);
    dots[p.kind] +=
      `M${x.toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  }
  let cross = '';
  for (const u of model.unstable) {
    const x = sx(u.x);
    const y = sy(u.iv);
    cross += `M${(x - 4).toFixed(1)} ${(y - 4).toFixed(1)}l8 8M${(x - 4).toFixed(1)} ${(y + 4).toFixed(1)}l8 -8`;
  }

  const zoomBy = (factor: number) =>
    dispatch({
      type: 'setViewport',
      viewport: zoom(model.domain, factor, model.fullDomain, model.minWidth),
    });

  return (
    <div
      class={active ? 'smile' : 'smile inactive'}
      aria-hidden={active ? undefined : true}
      inert={!active}
    >
      <div class="smile-tools">
        <fieldset class="seg" aria-label="横軸">
          {(['k', 'moneyness', 'delta'] as const).map((a) => (
            <button
              type="button"
              key={a}
              aria-pressed={axis === a}
              onClick={() => dispatch({ type: 'setAxis', axis: a })}
            >
              {AXIS_LABEL[a]}
            </button>
          ))}
        </fieldset>
        <fieldset class="seg" aria-label="拡大">
          <button type="button" aria-label="縮小" disabled={model.empty} onClick={() => zoomBy(2)}>
            −
          </button>
          <button
            type="button"
            aria-label="拡大"
            disabled={model.empty}
            onClick={() => zoomBy(0.5)}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label="リセット"
            disabled={model.empty}
            onClick={() => dispatch({ type: 'setViewport', viewport: null })}
          >
            ⟲
          </button>
        </fieldset>
      </div>
      <div class="smile-plot" ref={ref}>
        {model.empty ? (
          <p class="note">スマイルなし（F が決まらないか、使える気配が無い）</p>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={`${month.id} 限のスマイル（横軸 ${AXIS_LABEL[axis]}、縦軸 IV %）`}
          >
            <g class="grid">
              {yTicks.map((t) => (
                <g key={`y${t}`}>
                  <line x1={M.left} x2={width - M.right} y1={sy(t)} y2={sy(t)} />
                  <text x={M.left - 4} y={sy(t)} class="tick-y">
                    {fmtNum(t, 0)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <g key={`x${t}`}>
                  <line x1={sx(t)} x2={sx(t)} y1={M.top} y2={HEIGHT - M.bottom} />
                  <text x={sx(t)} y={HEIGHT - M.bottom + 16} class="tick-x">
                    {axisTickLabel(axis, t)}
                  </text>
                </g>
              ))}
            </g>
            {model.atmX !== null && (
              <line
                class="atm-line"
                x1={sx(model.atmX)}
                x2={sx(model.atmX)}
                y1={M.top}
                y2={HEIGHT - M.bottom}
              />
            )}
            <path class="smile-line solid" d={solid || 'M0 0'} />
            <path class="smile-line dotted" d={dotted || 'M0 0'} stroke-dasharray="3 3" />
            {(['bid', 'ask', 'mid'] as const).map((kind) => (
              <path key={kind} class={`pt ${kind}`} d={dots[kind] || 'M0 0'} />
            ))}
            <path class="unstable-x" d={cross || 'M0 0'} />
          </svg>
        )}
      </div>
      <p class="legend note">
        <span class="lg mid">● mid</span> <span class="lg bid">● bid</span>{' '}
        <span class="lg ask">● ask</span> ─ 節点区間 ┄ 補間・外挿 × IV 不安定{' '}
        <span class="lg atm">│ ATM（{basis}）</span>
      </p>
    </div>
  );
}

/** スマイル（限月ごと）。props が変わらなければ描き直さない */
export const Smile = pure(SmileView);

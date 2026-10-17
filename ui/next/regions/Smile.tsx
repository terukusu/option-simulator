import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Chain } from '../../../data';
import type { AtmBasis } from '../../../model';
import { type Domain, zoom } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { Action } from '../../state';
import { type SmileAxis, smileModel } from '../../view/smile';
import {
  SMILE_AXIS_OPTIONS,
  SMILE_HINT,
  SMILE_LEGEND_HINT,
  smileAct,
  smileLegend,
} from '../../view/smilePanel';
import type { MarketAdd } from '../market/BoardMonth';
import { MonthSeg } from '../market/MonthSeg';
import { SmilePlot } from '../market/SmilePlot';
import { PanelHead } from '../PanelHead';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';

export interface SmileRegionProps {
  chain: Chain;
  monthId: string;
  basis: AtmBasis;
  axis: SmileAxis;
  /** state.smileViewport（表示中の限月だけに効く） */
  viewport: Domain | null;
  /** state.smilePick */
  pick: { monthId: string; k: number } | null;
  /** useAppController の scenarioAtmView（ΔX ≠ 0 のときだけ） */
  scenarioAtm: { monthId: string; k: number } | null;
  dispatch: (a: Action) => void;
  onAdd: MarketAdd;
  marketSeg: ComponentChildren;
}

/**
 * スマイル（docs/ui-redesign.md §3・§4.3・§11 決定 12。#85）: 見出し行（拡大 [− ＋ ⟲]・市場の Seg・ⓘ）→ 道具の行
 * （限月・横軸）→ 描画域（限月ごと。market/SmilePlot.tsx）→ 操作行（グラフの下）→ 凡例。
 */
function SmileView(p: SmileRegionProps) {
  const { chain, monthId, basis, axis, viewport, dispatch, onAdd } = p;
  const month = chain.months.find((m) => m.id === monthId) ?? chain.months[0];
  // 拡大のボタンは全域・最小幅だけを使う（表示範囲に依らない = パンで作り直さない）
  // 全域・最小幅は限月ごとに 1 回（限月の切替で作り直さない）
  const fulls = useMemo(
    () => new Map(chain.months.map((m) => [m.id, smileModel(m, basis, axis, null)])),
    [chain, basis, axis],
  );
  const full = month ? (fulls.get(month.id) ?? null) : null;
  const pick = month && p.pick?.monthId === month.id ? p.pick.k : null;
  const scnK = month && p.scenarioAtm?.monthId === month.id ? p.scenarioAtm.k : null;
  const empty = !full || full.empty;
  const zoomBy = (factor: number) => {
    if (!full || full.empty) return;
    dispatch({
      type: 'setViewport',
      viewport: zoom(viewport ?? full.fullDomain, factor, full.fullDomain, full.minWidth),
    });
  };
  const act = month ? smileAct(month, pick) : null;
  const legend = smileLegend(basis, scnK);

  return (
    <>
      <PanelHead title="スマイル">
        {/* biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"（Seg と同じ） */}
        <div class="seg zoom" role="group" aria-label="拡大">
          <button type="button" aria-label="縮小" disabled={empty} onClick={() => zoomBy(2)}>
            −
          </button>
          <button type="button" aria-label="拡大" disabled={empty} onClick={() => zoomBy(0.5)}>
            ＋
          </button>
          <button
            type="button"
            aria-label="リセット"
            disabled={empty}
            onClick={() => dispatch({ type: 'setViewport', viewport: null })}
          >
            ⟲
          </button>
        </div>
        {p.marketSeg}
        <Popover label="スマイルの操作" button="ⓘ">
          <p>{SMILE_HINT}</p>
          <p>{SMILE_LEGEND_HINT}</p>
        </Popover>
      </PanelHead>
      <div class="panel-body market-body">
        <div class="smile-tools">
          <MonthSeg
            months={chain.months}
            value={month?.id ?? ''}
            onChange={(id) => dispatch({ type: 'setMonth', monthId: id })}
          />
          <Seg
            label="横軸"
            value={axis}
            options={SMILE_AXIS_OPTIONS}
            onChange={(a) => dispatch({ type: 'setAxis', axis: a })}
          />
        </div>
        <div class="smile-months">
          {chain.months.map((m) => {
            const active = m.id === month?.id;
            return (
              <SmilePlot
                key={m.id}
                month={m}
                active={active}
                basis={basis}
                axis={axis}
                viewport={active ? viewport : null}
                pick={active ? pick : null}
                scenarioAtmK={active ? scnK : null}
                dispatch={dispatch}
              />
            );
          })}
        </div>
        <div class="smile-act">
          {!act || 'hint' in act ? (
            <span class="hint">{act?.hint}</span>
          ) : (
            <>
              <span class="who">
                <span class="k">{act.title}</span>
                <span class="sub">
                  <span class="iv">{act.iv}</span>
                  {act.unstable && <span class="tag warn">IV 不安定</span>}
                </span>
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="btn sm"
                aria-label={act.sellLabel}
                onClick={() => month && onAdd(month.id, act.k, act.type, 'sell')}
              >
                <span>売り</span>
                <b class="bid">{act.bid}</b>
              </button>
              <button
                type="button"
                class="btn sm"
                aria-label={act.buyLabel}
                onClick={() => month && onAdd(month.id, act.k, act.type, 'buy')}
              >
                <span>買い</span>
                <b class="ask">{act.ask}</b>
              </button>
              <button
                type="button"
                class="btn ghost icon sm"
                aria-label="選択を消す"
                onClick={() => dispatch({ type: 'pickSmile', pick: null })}
              >
                ×
              </button>
            </>
          )}
        </div>
        <div class="smile-legend">
          {legend.map((i) => (
            <span key={i.key} class={`lg ${i.cls}`} title={i.text}>
              <span class="full">{i.text}</span>
              <span class="short" aria-hidden="true">
                {i.short}
              </span>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

export const Smile = pure(SmileView);

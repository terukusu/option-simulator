import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Chain } from '../../../data';
import type { AtmBasis, Scenario } from '../../../model';
import { type Domain, zoom } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { Action } from '../../state';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import type { AmountUnit } from '../../view/metrics';
import { type SmileAxis, smileModel } from '../../view/smile';
import {
  effAtNow,
  SMILE_EFF_CAUTION,
  SMILE_EFF_CHIP_TITLE,
  SMILE_EFF_HINT,
  type SmileEffBase,
} from '../../view/smileEff';
import {
  SMILE_AXIS_OPTIONS,
  SMILE_EFF_ACT_HINT,
  SMILE_HINT,
  SMILE_LEGEND_HINT,
  smileAct,
  smileLegend,
} from '../../view/smilePanel';
import type { MarketAdd } from '../market/BoardMonth';
import { MonthSeg } from '../market/MonthSeg';
import { SmilePlot } from '../market/SmilePlot';
import { PanelHead } from '../PanelHead';
import { Chip } from '../parts/Chip';
import { Icon } from '../parts/Icon';
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
  /** 売りの効率の線（#163）を重ねているか・切り替え */
  effOn: boolean;
  onEff: (on: boolean) => void;
  /** 効率の線の市場・設定とシナリオ（重ねていないときは null = スライダーで描き直さない） */
  eff: SmileEffBase | null;
  scenario: Scenario | null;
  /** 金額の単位（指標のタイルと同じ。効率の読み取りの証拠金。#259 S-6） */
  unit: AmountUnit;
  dispatch: (a: Action) => void;
  onAdd: MarketAdd;
  marketSeg: ComponentChildren;
}

/**
 * スマイル（docs/ui-redesign.md §3・§4.3・§11 決定 12。#85）: 見出し行（拡大 [− ＋ ⟲]・市場の Seg・ⓘ）→ ツールの行
 * （限月・横軸・[効率]（#163））→ 描画域（限月ごと。market/SmilePlot.tsx）→ 操作行（グラフの下）→ 凡例。
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
  const effShown = p.effOn && p.eff !== null;
  const act = month ? smileAct(month, pick, chain.r, effShown) : null;
  // 効率の線の凡例（#259 S-1）: 今の線はシナリオの点が今でないときだけ（SmilePlot と同じ条件）
  const legend = smileLegend(
    basis,
    scnK,
    effShown ? { now: p.scenario !== null && !effAtNow(p.scenario) } : null,
  );

  return (
    <>
      {/* 見出しの文字は読み上げだけ（Seg の「スマイル」が見出しを兼ねる。1440 の市場の列で `スマ…` に切れた。#279 D-06） */}
      <PanelHead title="スマイル" titleHidden>
        {/* biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"（Seg と同じ） */}
        <div class="seg zoom" role="group" aria-label="拡大">
          <button type="button" aria-label="縮小" disabled={empty} onClick={() => zoomBy(2)}>
            <Icon name="minus" />
          </button>
          <button type="button" aria-label="拡大" disabled={empty} onClick={() => zoomBy(0.5)}>
            <Icon name="plus" />
          </button>
          <button
            type="button"
            aria-label="リセット"
            disabled={empty}
            onClick={() => dispatch({ type: 'setViewport', viewport: null })}
          >
            <Icon name="reset" />
          </button>
        </div>
        {p.marketSeg}
        <Popover label="スマイルの操作" button={<Icon name="info" />}>
          <p>{SMILE_HINT}</p>
          <p>{SMILE_LEGEND_HINT}</p>
          <p>{SMILE_EFF_HINT}</p>
          <p>{SMILE_EFF_CAUTION}</p>
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div
        class="panel-body market-body"
        tabIndex={-1}
        role="group"
        aria-label={PANEL_FOCUS_LABEL.smile}
      >
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
          <Chip
            text="効率"
            label="売りの効率の線"
            title={SMILE_EFF_CHIP_TITLE}
            pressed={p.effOn}
            disabled={empty}
            onClick={() => p.onEff(!p.effOn)}
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
                eff={active ? p.eff : null}
                scenario={active ? p.scenario : null}
                unit={p.unit}
                dispatch={dispatch}
              />
            );
          })}
        </div>
        <div class="smile-act">
          {!act || 'hint' in act ? (
            <span class={act?.hint === SMILE_EFF_ACT_HINT ? 'hint eff' : 'hint'}>{act?.hint}</span>
          ) : (
            <>
              <span class="who">
                <span class="k">{act.title}</span>
                <span class="sub">
                  <span class="iv">{act.iv}</span>
                  {act.fair && (
                    <span class="fair" title={act.fair.label}>
                      理論 {act.fair.price}
                    </span>
                  )}
                  {act.fair?.extrapolated && <span class="tag">外挿</span>}
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
                <Icon name="close" />
              </button>
            </>
          )}
        </div>
        <div class="smile-legend">
          {legend.map((i) => (
            <span key={i.key} class={i.cls} title={i.text}>
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

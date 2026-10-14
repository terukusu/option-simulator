import { useCallback, useEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import { axisOrigin, type Chain, monthOf } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings, ZERO_SCENARIO } from '../../model';
import {
  API_LABEL,
  describeLoadError,
  fixtureUrl,
  initialSource,
  loadFromApi,
  loadFromFile,
  loadFromUrl,
} from '../load';
import { initialState, reduce } from '../state';
import { headerModel, keptBoardNote } from '../view/header';
import { hedgeModel } from '../view/hedge';
import { metricsModel } from '../view/metrics';
import { pnlDomains, zoomViewport } from '../view/pnlChart';
import { positionModel } from '../view/position';
import { readoutModel } from '../view/readout';
import { evalTimeTargets } from '../view/scenario';
import { scenarioAtmMark } from '../view/scenarioAtm';
import { Board } from './Board';
import { Header } from './Header';
import { Hedge } from './Hedge';
import { LegForms } from './LegForms';
import { Loader } from './Loader';
import { Metrics } from './Metrics';
import { PnlChart } from './PnlChart';
import { Positions } from './Positions';
import { ScenarioPanel } from './ScenarioPanel';
import { Smile } from './Smile';

/** dev サーバーだけが配る合成の板（本番のビルドではこの分岐ごと消える） */
const DEV_FIXTURES: readonly string[] = import.meta.env.DEV
  ? ['latest', 'night_early', 'pre_open']
  : [];

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const seq = useRef(0);

  const load = useCallback(async (label: string, fn: () => Promise<Chain>) => {
    const id = ++seq.current;
    dispatch({ type: 'loading' });
    try {
      const chain = await fn();
      // 取得時刻はブラウザの時計（reducer は時計を読まない）
      if (id === seq.current) dispatch({ type: 'loaded', chain, label, fetchedAt: Date.now() });
    } catch (e) {
      if (id === seq.current) dispatch({ type: 'loadFailed', error: describeLoadError(e) });
    }
  }, []);

  // 合成の板の読み込みは dev だけ（本番のビルドでは分岐ごと消え、fixture の URL も残らない）
  const onFixture = useCallback(
    (name: string) => {
      if (import.meta.env.DEV) load(name, () => loadFromUrl(fixtureUrl(name)));
    },
    [load],
  );
  const onFile = useCallback((file: File) => load(file.name, () => loadFromFile(file)), [load]);
  // [最新]: API から読み直す（手動だけ。自動ポーリング・タイマーは入れない。7.3 (4)）
  const onLatest = useCallback(() => load(API_LABEL, () => loadFromApi()), [load]);

  // 開いたら 1 回だけ読む（本番 = API、dev = 合成の latest）
  useEffect(() => {
    const first = initialSource(import.meta.env.DEV);
    if (first.kind === 'api') onLatest();
    else onFixture(first.name);
  }, [onFixture, onLatest]);

  const { chain, atmBasis } = state;
  const month = chain && state.monthId ? (monthOf(chain, state.monthId) ?? null) : null;
  const { calendar, fetchedAt, sourceLabel } = state;
  const header = useMemo(
    () =>
      chain ? headerModel(chain, atmBasis, calendar, { fetchedAt, label: sourceLabel }) : null,
    [chain, atmBasis, calendar, fetchedAt, sourceLabel],
  );
  // 手数料（1 枚あたり円）・先物の basis（固定 / 減衰。#25）は評価の設定（損益・指標・テール表・ヘッジに効く）
  const { feePerLot, futureBasis } = state;
  const settings = useMemo<ModelSettings>(
    () => ({ ...DEFAULT_SETTINGS, feePerLot, futureBasis }),
    [feePerLot, futureBasis],
  );
  const positions = useMemo(
    () => (chain ? positionModel(chain, state.legs, atmBasis, calendar, settings) : null),
    [chain, state.legs, atmBasis, calendar, settings],
  );
  // 損益グラフの横軸の範囲・満期の折れ点など（足・板が変わったときだけ。ドラッグ中は作り直さない）
  const pnlBase = useMemo(
    () =>
      chain && positions ? pnlDomains(chain, positions.prepared, positions.ctx, settings) : null,
    [chain, positions, settings],
  );
  // 指標・テール表（スライダーの操作ごと。グラフの表示モデルと合わせて 1 フレームの予算に収める）
  const metrics = useMemo(
    () => metricsModel({ base: pnlBase, scenario: state.scenario, unit: state.metricsUnit }),
    [pnlBase, state.scenario, state.metricsUnit],
  );
  // 読み取りの帯（シナリオ点の値。指標の値 + 満期・今日の 2 回の評価。#52）
  const readout = useMemo(
    () => readoutModel({ base: pnlBase, metrics, scenario: state.scenario }),
    [pnlBase, metrics, state.scenario],
  );
  // デルタヘッジ（足・目標・評価点・限月の変更ごと。シナリオは評価点がシナリオ時点のときだけ効く）
  const { hedge, scenario } = state;
  const hedgeScenario = hedge.at === 'scenario' ? scenario : null;
  const hedgeView = useMemo(
    () =>
      chain && positions
        ? hedgeModel({
            chain,
            ctx: positions.ctx,
            base: pnlBase,
            settings,
            scenario: hedgeScenario ?? ZERO_SCENARIO,
            hedge,
            holidays: calendar.holidays,
          })
        : null,
    [chain, positions, pnlBase, settings, hedgeScenario, hedge, calendar],
  );
  const targets = useMemo(
    () => (chain ? evalTimeTargets(chain, state.legs, calendar) : []),
    [chain, state.legs, calendar],
  );
  const { pnlViewport } = state;
  const onZoom = useCallback(
    (factor: number) => {
      if (pnlBase) {
        dispatch({ type: 'setPnlViewport', viewport: zoomViewport(pnlBase, pnlViewport, factor) });
      }
    },
    [pnlBase, pnlViewport],
  );
  const { smilePick } = state;
  // 表示中の限月のシナリオ ATM（#26。ΔX ≠ 0 のときだけ。板の ATM・ヘッダ・スマイルの市場 ATM は動かさない）
  const dX = scenario.dX;
  const { basisMode } = settings;
  const scenarioAtmView = useMemo(() => {
    if (!chain || !month) return null;
    const pick = scenarioAtmMark(month, atmBasis, axisOrigin(chain, atmBasis), dX, basisMode);
    return pick ? { monthId: month.id, k: pick.k, F: month.F } : null;
  }, [chain, month, atmBasis, dX, basisMode]);

  return (
    <div class="app">
      <div class="topbar">
        <h1>option-simulator</h1>
        <Loader
          fixtures={DEV_FIXTURES}
          sourceLabel={sourceLabel}
          loading={state.loading}
          error={state.loadError}
          kept={chain ? keptBoardNote(fetchedAt) : null}
          onFixture={onFixture}
          onFile={onFile}
          onLatest={onLatest}
        />
      </div>
      {!chain || !header ? (
        <p class="empty">
          {state.loading
            ? '読み込み中…'
            : state.loadError
              ? '板を読めない。[最新] で読み直すか、板の JSON を選んでください。'
              : '板の JSON を選んでください。'}
        </p>
      ) : (
        <>
          <Header model={header} onBasis={(basis) => dispatch({ type: 'setBasis', basis })} />
          {state.legError && (
            <p class="field-error leg-error" role="alert">
              足を追加できない: {state.legError}{' '}
              <button type="button" onClick={() => dispatch({ type: 'clearLegError' })}>
                閉じる
              </button>
            </p>
          )}
          <nav class="tabs" aria-label="限月">
            {chain.months.map((m) => (
              <button
                type="button"
                key={m.id}
                aria-pressed={m.id === state.monthId}
                onClick={() => dispatch({ type: 'setMonth', monthId: m.id })}
              >
                {m.id} 限
              </button>
            ))}
          </nav>
          <div class="panes">
            <section class="pane pane-board" aria-label="板">
              {chain.months.map((m) => (
                <Board
                  key={m.id}
                  chain={chain}
                  month={m}
                  active={m.id === state.monthId}
                  basis={atmBasis}
                  target={state.target}
                  filterAsk={state.filterAsk}
                  dispatch={dispatch}
                />
              ))}
            </section>
            <section class="pane pane-side">
              {/* グラフ・読み取りの帯（PnlChart の中）・シナリオ欄（帯の sticky はこの範囲だけ効く。#52） */}
              <div class="pnl-group">
                <h2>損益グラフ</h2>
                <PnlChart
                  base={pnlBase}
                  legCount={state.legs.length}
                  scenario={state.scenario}
                  viewport={state.pnlViewport}
                  pnlY={state.pnlY}
                  scenarioAtm={scenarioAtmView}
                  amountUnit={metrics.unit}
                  readout={readout}
                  dispatch={dispatch}
                />
                <ScenarioPanel
                  scenario={state.scenario}
                  futureBasis={futureBasis}
                  x0={positions?.ctx.x0 ?? Number.NaN}
                  maxDays={pnlBase?.maxDays ?? 0}
                  evalTime={chain.evalTime}
                  targets={targets}
                  dispatch={dispatch}
                  onZoom={onZoom}
                />
              </div>
              <Metrics
                model={metrics}
                unitSetting={state.metricsUnit}
                feePerLot={feePerLot}
                dispatch={dispatch}
              />
              <h2>スマイル {month ? `${month.id} 限` : ''}</h2>
              {chain.months.map((m) => {
                const active = m.id === state.monthId;
                return (
                  <Smile
                    key={m.id}
                    month={m}
                    active={active}
                    basis={atmBasis}
                    axis={state.smileAxis}
                    viewport={active ? state.smileViewport : null}
                    pick={active && smilePick?.monthId === m.id ? smilePick.k : null}
                    scenarioAtmK={
                      active && scenarioAtmView?.monthId === m.id ? scenarioAtmView.k : null
                    }
                    dispatch={dispatch}
                  />
                );
              })}
              <Positions model={positions} dispatch={dispatch} />
              {hedgeView && <Hedge model={hedgeView} dispatch={dispatch} />}
              <LegForms chain={chain} dispatch={dispatch} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

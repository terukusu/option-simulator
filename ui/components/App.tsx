import { useCallback, useEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import { type Chain, monthOf } from '../../data';
import { DEFAULT_SETTINGS, type ModelSettings } from '../../model';
import { describeLoadError, fixtureUrl, loadFromFile, loadFromUrl } from '../load';
import { initialState, reduce } from '../state';
import { headerModel } from '../view/header';
import { metricsModel } from '../view/metrics';
import { pnlDomains, zoomViewport } from '../view/pnlChart';
import { positionModel } from '../view/position';
import { evalTimeTargets } from '../view/scenario';
import { Board } from './Board';
import { Header } from './Header';
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
      if (id === seq.current) dispatch({ type: 'loaded', chain, label });
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

  useEffect(() => {
    const first = DEV_FIXTURES[0];
    if (first) onFixture(first);
  }, [onFixture]);

  const { chain, atmBasis } = state;
  const month = chain && state.monthId ? (monthOf(chain, state.monthId) ?? null) : null;
  const { calendar } = state;
  const header = useMemo(
    () => (chain ? headerModel(chain, atmBasis, calendar) : null),
    [chain, atmBasis, calendar],
  );
  // 手数料（1 枚あたり円）は評価の設定（損益・指標・テール表に効く）
  const { feePerLot } = state;
  const settings = useMemo<ModelSettings>(() => ({ ...DEFAULT_SETTINGS, feePerLot }), [feePerLot]);
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

  return (
    <div class="app">
      <div class="topbar">
        <h1>option-simulator</h1>
        <Loader
          fixtures={DEV_FIXTURES}
          sourceLabel={state.sourceLabel}
          loading={state.loading}
          error={state.loadError}
          onFixture={onFixture}
          onFile={onFile}
        />
      </div>
      {!chain || !header ? (
        <p class="empty">{state.loading ? '読み込み中…' : '板の JSON を選んでください。'}</p>
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
              <h2>損益グラフ</h2>
              <PnlChart
                base={pnlBase}
                legCount={state.legs.length}
                scenario={state.scenario}
                viewport={state.pnlViewport}
                pnlY={state.pnlY}
                dispatch={dispatch}
              />
              <ScenarioPanel
                scenario={state.scenario}
                x0={positions?.ctx.x0 ?? Number.NaN}
                maxDays={pnlBase?.maxDays ?? 0}
                evalTime={chain.evalTime}
                targets={targets}
                dispatch={dispatch}
                onZoom={onZoom}
              />
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
                    dispatch={dispatch}
                  />
                );
              })}
              <Positions model={positions} dispatch={dispatch} />
              <LegForms chain={chain} dispatch={dispatch} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

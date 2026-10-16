import { useEffect, useMemo, useState } from 'preact/hooks';
import { CRASH_PRESETS, type IvDynamics, type ModelSettings, type Scenario } from '../../model';
import type { Action } from '../state';
import { fmtDateTime, fmtNum } from '../view/format';
import {
  type DXUnit,
  daysToTarget,
  type EvalTimeTarget,
  evalInstant,
  fmtSliderValue,
  fromDisplay,
  parseBeta,
  parseSliderInput,
  type SliderField,
  type SliderSpec,
  sliderSpec,
  stepSlider,
  toDisplay,
} from '../view/scenario';
import { Hint } from './Hint';

/** パネルの + / − の拡大・縮小の倍率（損益グラフのボタンと同じ） */
const ZOOM_IN = 0.8;
const ZOOM_OUT = 1.25;

const FIELDS: readonly SliderField[] = ['days', 'dX', 'dSigma', 'skew'];

const DYNAMICS: ReadonlyArray<{ v: IvDynamics; label: string }> = [
  { v: 'sticky_strike', label: 'sticky strike' },
  { v: 'sticky_moneyness', label: 'sticky moneyness' },
];

type FutureBasis = ModelSettings['futureBasis'];

/** 先物の足の basis（設計 5.8。#25） */
const FUTURE_BASIS: ReadonlyArray<{ v: FutureBasis; label: string }> = [
  { v: 'fixed', label: 'basis 固定' },
  { v: 'decay', label: 'basis 減衰' },
];

/** スライダー 1 本（range + 数値欄）。値は表示の単位（ΔX は % か円）。 */
function SliderRow(props: {
  spec: SliderSpec;
  value: number;
  onValue: (v: number) => void;
  onZoom: (factor: number) => void;
}) {
  const { spec, value, onValue, onZoom } = props;
  const id = `scn-${spec.field}`;
  const [text, setText] = useState(fmtSliderValue(spec, value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // 外から値が変わったとき（スライダー・プリセット・リセット・単位の切替）は欄を合わせる。
    // 入力中の文字列が同じ値を表すなら上書きしない
    const r = parseSliderInput(text, spec);
    if (!(r.ok && Math.abs(r.value - value) < 1e-9)) {
      setText(fmtSliderValue(spec, value));
      setError(null);
    }
    // text はここでは追わない（入力中の文字列を上書きしない）
  }, [value, spec.unit, spec.max]);

  const onText = (t: string) => {
    setText(t);
    const r = parseSliderInput(t, spec);
    if (r.ok) {
      setError(null);
      if (Math.abs(r.value - value) > 1e-12) onValue(r.value);
    } else setError(r.message);
  };

  return (
    <div class="scn-row">
      <label class="scn-label" for={id}>
        {spec.label}
      </label>
      <input
        id={id}
        class="scn-range"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={Math.min(Math.max(value, spec.min), spec.max)}
        disabled={spec.disabled}
        aria-valuetext={`${fmtSliderValue(spec, value)} ${spec.unit}`}
        aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight R + -"
        onInput={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) onValue(Math.min(Math.max(v, spec.min), spec.max));
        }}
        onKeyDown={(e) => {
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          const r = stepSlider(spec, value, e.key, e.shiftKey);
          if (r === null) return;
          e.preventDefault();
          if (r === 'zoomIn') onZoom(ZOOM_IN);
          else if (r === 'zoomOut') onZoom(ZOOM_OUT);
          else onValue(r);
        }}
      />
      <span class="scn-input">
        <input
          type="text"
          inputMode="decimal"
          size={7}
          aria-label={`${spec.label}（${spec.unit}）`}
          value={text}
          disabled={spec.disabled}
          aria-invalid={error !== null}
          onInput={(e) => onText(e.currentTarget.value)}
        />
        <span class="scn-unit">{spec.unit}</span>
      </span>
      {error && (
        <span class="field-error scn-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface ScenarioPanelProps {
  scenario: Scenario;
  /** 先物の足の basis（固定 / 減衰。全ての先物の足に 1 つ） */
  futureBasis: FutureBasis;
  /** 横軸の基準 X₀（決まらなければ NaN） */
  x0: number;
  /** d の上限（最遠の足の SQ までの暦日。足 0 本・評価できる足が無ければ 0） */
  maxDays: number;
  /** 評価時刻（板の時刻） */
  evalTime: number;
  /** 「SQ 日 9:00」「取引最終日 15:45」の対象（足の限月、SQ 昇順） */
  targets: readonly EvalTimeTarget[];
  dispatch: (a: Action) => void;
  /** 損益グラフの拡大・縮小（+ / −） */
  onZoom: (factor: number) => void;
}

/** シナリオのパネル（M5・5.4）。値の範囲・キー操作・パースは ui/view/scenario.ts の純関数。 */
export function ScenarioPanel(props: ScenarioPanelProps) {
  const { scenario, futureBasis, x0, maxDays, evalTime, targets, dispatch, onZoom } = props;
  const [dXUnit, setDXUnit] = useState<DXUnit>('pct');
  const specs = useMemo(
    () => FIELDS.map((f) => sliderSpec(f, { x0, maxDays, dXUnit })),
    [x0, maxDays, dXUnit],
  );
  const setField = (field: SliderField, display: number) => {
    const v = fromDisplay(field, display, x0, dXUnit);
    if (Number.isFinite(v)) dispatch({ type: 'setScenario', patch: { [field]: v } });
  };

  // β の欄
  const [betaText, setBetaText] = useState(fmtNum(scenario.beta, 1));
  const [betaError, setBetaError] = useState<string | null>(null);
  useEffect(() => {
    const r = parseBeta(betaText);
    if (!(r.ok && r.value === scenario.beta)) {
      setBetaText(fmtNum(scenario.beta, 1));
      setBetaError(null);
    }
  }, [scenario.beta]);
  const onBeta = (t: string) => {
    setBetaText(t);
    const r = parseBeta(t);
    if (r.ok) {
      setBetaError(null);
      if (r.value !== scenario.beta) dispatch({ type: 'setScenario', patch: { beta: r.value } });
    } else setBetaError(r.message);
  };

  // 評価時刻ボタンの対象（既定は評価時刻より後で SQ が最も近い限月）
  const [targetId, setTargetId] = useState<string | null>(null);
  const fallback = targets.find((t) => t.sqTime > evalTime) ?? targets[0] ?? null;
  const target = targets.find((t) => t.id === targetId) ?? fallback;
  const dSq = target ? daysToTarget(evalTime, target.sqTime, maxDays) : null;
  const dLast = target ? daysToTarget(evalTime, target.lastTradeClose, maxDays) : null;
  const x0ok = Number.isFinite(x0) && x0 > 0;

  return (
    <div class="scenario">
      <div class="scn-head">
        <h2>シナリオ</h2>
        <button type="button" onClick={() => dispatch({ type: 'resetScenario' })}>
          シナリオをリセット
        </button>
      </div>
      <fieldset class="seg scn-presets" aria-label="急落プリセット">
        {CRASH_PRESETS.map((p, i) => (
          <button
            type="button"
            key={p.label}
            disabled={!x0ok}
            onClick={() => dispatch({ type: 'applyPreset', index: i, x0 })}
          >
            {p.label}
          </button>
        ))}
      </fieldset>
      {specs.map((spec) => (
        <SliderRow
          key={spec.field}
          spec={spec}
          value={toDisplay(spec.field, scenario[spec.field], x0, dXUnit)}
          onValue={(v) => setField(spec.field, v)}
          onZoom={onZoom}
        />
      ))}
      <div class="scn-opts hint-host">
        <fieldset class="seg" aria-label="ΔX の単位">
          {(['pct', 'yen'] as const).map((u) => (
            <button
              type="button"
              key={u}
              aria-pressed={dXUnit === u}
              disabled={!x0ok}
              onClick={() => setDXUnit(u)}
            >
              ΔX {u === 'pct' ? '%' : '円'}
            </button>
          ))}
        </fieldset>
        <label class="scn-beta">
          β{' '}
          <input
            type="text"
            inputMode="decimal"
            size={4}
            value={betaText}
            aria-invalid={betaError !== null}
            onInput={(e) => onBeta(e.currentTarget.value)}
          />{' '}
          pt / 1%
        </label>
        <fieldset class="seg" aria-label="IV の動き方">
          {DYNAMICS.map((d) => (
            <button
              type="button"
              key={d.v}
              aria-pressed={scenario.ivDynamics === d.v}
              onClick={() => dispatch({ type: 'setScenario', patch: { ivDynamics: d.v } })}
            >
              {d.label}
            </button>
          ))}
        </fieldset>
        <div class="scn-basis">
          <fieldset class="seg" aria-label="先物の basis">
            {FUTURE_BASIS.map((b) => (
              <button
                type="button"
                key={b.v}
                aria-pressed={futureBasis === b.v}
                onClick={() => dispatch({ type: 'setFutureBasis', basis: b.v })}
              >
                {b.label}
              </button>
            ))}
          </fieldset>
          <Hint label="先物の basis">
            先物 basis: 先物の足をその SQ より前に評価するとき F = X' + basis。減衰は先物の SQ で 0
            へ線形。
          </Hint>
        </div>
      </div>
      {betaError && (
        <p class="field-error" role="alert">
          {betaError}
        </p>
      )}
      <div class="scn-eval hint-host">
        {targets.length > 1 && (
          <label>
            対象{' '}
            <select value={target?.id ?? ''} onChange={(e) => setTargetId(e.currentTarget.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {targets.length === 1 && target && <span class="note">{target.label}</span>}
        <button
          type="button"
          disabled={dSq === null}
          onClick={() => dSq !== null && dispatch({ type: 'setScenario', patch: { days: dSq } })}
        >
          SQ 日 9:00
        </button>
        <button
          type="button"
          disabled={dLast === null}
          onClick={() =>
            dLast !== null && dispatch({ type: 'setScenario', patch: { days: dLast } })
          }
        >
          取引最終日 15:45
        </button>
        <span class="note">
          評価時刻 = {fmtDateTime(evalInstant(evalTime, Math.min(scenario.days, maxDays)))}
          （板の時刻 + d）{' '}
          <Hint label="スライダーのキー操作">
            キー: ← → 1 刻み、Shift で 10 刻み、R で既定値、+ / − で損益グラフの拡大・縮小
          </Hint>
        </span>
      </div>
    </div>
  );
}

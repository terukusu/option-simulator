import { useMemo, useState } from 'preact/hooks';
import type { Scenario } from '../../model';
import { type Domain, pixelToValue, zoom } from '../chart/scale';
import { type Action, parsePremiumN, parseYRange } from '../state';
import { fmtNum } from '../view/format';
import { AMOUNT_UNIT_LABEL, type AmountUnit } from '../view/metrics';
import {
  dateLine,
  PNL_MARGIN,
  type PnlBase,
  type PnlLineKind,
  type PnlYMode,
  type PnlYSettings,
  pnlChartModel,
  todayLine,
  Y_UNIT_LABEL,
} from '../view/pnlChart';
import type { ReadoutModel } from '../view/readout';
import { dXFromAxis, stepDXKey } from '../view/scenario';
import { scenarioMarks } from '../view/scenarioMarks';
import { pure } from './pure';
import { Readout } from './Readout';
import { useChartGestures } from './useChartGestures';
import { useWidth } from './useWidth';

/** グラフの高さ（幅 < 560px は低くして、グラフの外でページをスクロールできるようにする） */
const HEIGHT = 260;
const HEIGHT_NARROW = 220;
const NARROW_FROM = 560;
/** ボタンの拡大・縮小の倍率 */
const BUTTON_ZOOM_IN = 0.8;
const BUTTON_ZOOM_OUT = 1.25;

export interface PnlChartProps {
  base: PnlBase | null;
  /** ポジションの足の本数（評価できない足を含む。0 本と「描ける足が無い」の文言の区別） */
  legCount: number;
  scenario: Scenario;
  viewport: Domain | null;
  pnlY: PnlYSettings;
  /** 表示中の限月のシナリオ ATM（ΔX ≠ 0 のときだけ。無ければ null。#26） */
  scenarioAtm: { monthId: string; k: number; F: number } | null;
  /** 交点のラベルの金額の単位（指標の単位。metricsModel の unit。#52） */
  amountUnit: AmountUnit;
  /** 読み取りの帯（シナリオ点の値。App で memo。#52） */
  readout: ReadoutModel;
  dispatch: (a: Action) => void;
}

const LINE_LABEL: Record<PnlLineKind, string> = {
  expiry: '満期（SQ）',
  date: '指定日 + シナリオ',
  today: '今日',
};

const Y_MODE_LABEL: Record<PnlYMode, string> = {
  auto: '自動',
  manual: '手動',
  premium: '±N 倍',
};

const fmtDays = (v: number) => String(Math.round(v * 100) / 100);

const DYNAMICS_LABEL = { sticky_strike: 'sticky strike', sticky_moneyness: 'sticky moneyness' };

/** 損益グラフ（SVG。座標・範囲・目盛りは ui/view/pnlChart.ts と ui/chart/scale.ts の純関数）。 */
function PnlChartView({
  base,
  legCount,
  scenario,
  viewport,
  pnlY,
  scenarioAtm,
  amountUnit,
  readout,
  dispatch,
}: PnlChartProps) {
  const { ref, width } = useWidth(480);
  const height = width < NARROW_FROM ? HEIGHT_NARROW : HEIGHT;
  const plotWidth = Math.max(width - PNL_MARGIN.left - PNL_MARGIN.right, 1);
  const plotHeight = height - PNL_MARGIN.top - PNL_MARGIN.bottom;
  // 今日の線はシナリオ IV を掛けない（d・ΔX・Δσ・Δs のスライダーで変わらない）ので、表示範囲・幅・β・動き方が
  // 変わったときだけ作る（#6。スライダー 1 回の描き直しを指定日の線 + 指標に絞る）
  const { beta, ivDynamics, ivShift } = scenario;
  const todayYs = useMemo(
    () => todayLine(base, viewport, plotWidth, scenario),
    // scenario の他の値（d・ΔX・Δσ・Δs）は今日の線に効かないので追わない
    [base, viewport, plotWidth, beta, ivDynamics, ivShift],
  );
  // 指定日の線は ΔX で形が変わらない（β は評価点 X' ごと）ので、長押しドラッグ・ΔX のスライダーでは作り直さない
  // （#52。ΔX 以外のシナリオ・表示範囲・幅が変わったときだけ）
  const { days, dSigma, skew } = scenario;
  const dateYs = useMemo(
    () => dateLine(base, viewport, plotWidth, scenario),
    // ΔX は指定日の線に効かないので追わない
    [base, viewport, plotWidth, days, dSigma, skew, beta, ivDynamics, ivShift],
  );
  const model = useMemo(
    () =>
      pnlChartModel({
        base,
        scenario,
        viewport,
        pnlY,
        plotWidth,
        plotHeight,
        todayYs,
        dateYs,
        scenarioAtm,
      }),
    [base, scenario, viewport, pnlY, plotWidth, plotHeight, todayYs, dateYs, scenarioAtm],
  );
  // シナリオ点の縦線と線の交点・金額のラベル（#52。ΔX = 0 でも X₀ 上に出す）
  const marks = useMemo(
    () => scenarioMarks({ base, scenario, chart: model, unit: amountUnit }),
    [base, scenario, model, amountUnit],
  );
  const range: Domain = [PNL_MARGIN.left, PNL_MARGIN.left + plotWidth];
  const x0 = base?.ctx.x0 ?? Number.NaN;
  const setDX = (dX: number | null) => {
    if (dX !== null && dX !== scenario.dX) dispatch({ type: 'setScenario', patch: { dX } });
  };

  useChartGestures(ref, {
    viewport: model.domain,
    full: model.full,
    minWidth: model.minWidth,
    range,
    disabled: model.empty,
    onViewport: (v) => dispatch({ type: 'setPnlViewport', viewport: v }),
    // 長押し・縦線をつかむ → ΔX（10 円の格子・−40〜+20%）。キー , . < > で ΔX（#52）
    scrub: { linePx: model.scenarioPx },
    onScrub: (px) => setDX(dXFromAxis(pixelToValue(model.domain, range, px), x0)),
    onScrubKey: (key) => {
      const dX = stepDXKey(scenario.dX, key, x0);
      if (dX === null) return false;
      setDX(dX);
      return true;
    },
  });

  // 入力欄（文字列は部品が持ち、検証できた値だけ状態に入れる）
  const [loText, setLoText] = useState('');
  const [hiText, setHiText] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [nText, setNText] = useState(String(pnlY.n));
  const [nError, setNError] = useState<string | null>(null);

  const noLegs = !base;

  const setMode = (mode: PnlYMode) => {
    if (mode === 'manual' && !pnlY.manual) {
      // 手動に切り替えたら、いま見ている範囲から始める
      const cur: Domain = [Math.round(model.yDomain[0]), Math.round(model.yDomain[1])];
      setLoText(String(cur[0]));
      setHiText(String(cur[1]));
      setRangeError(null);
      dispatch({ type: 'setPnlY', patch: { mode, manual: cur[0] < cur[1] ? cur : null } });
      return;
    }
    if (mode === 'manual' && pnlY.manual) {
      setLoText(String(pnlY.manual[0]));
      setHiText(String(pnlY.manual[1]));
    }
    dispatch({ type: 'setPnlY', patch: { mode } });
  };
  const commitRange = (lo: string, hi: string) => {
    const r = parseYRange(lo, hi);
    if (r.ok) {
      setRangeError(null);
      dispatch({ type: 'setPnlY', patch: { manual: r.value } });
    } else setRangeError(r.message);
  };
  const onN = (text: string) => {
    setNText(text);
    const r = parsePremiumN(text);
    if (r.ok) {
      setNError(null);
      dispatch({ type: 'setPnlY', patch: { n: r.value } });
    } else setNError(r.message);
  };

  const zoomBy = (factor: number) =>
    dispatch({
      type: 'setPnlViewport',
      viewport: zoom(model.domain, factor, model.full, model.minWidth),
    });

  // 入力のエラーは、いま見えている欄の分だけ出す（モードを切り替えたら前のモードの分は出さない）
  const errors = [
    pnlY.mode === 'manual' ? rangeError : null,
    pnlY.mode === 'premium' ? nError : null,
  ].filter((e): e is string => e !== null);

  const { plot } = model;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const unit = Y_UNIT_LABEL[model.yUnit];

  return (
    // ルートは箱を作らない（読み取りの帯の sticky の範囲を親の .pnl-group にする。#52）
    <>
      <div class="pnl-tools">
        <fieldset class="seg" aria-label="縦軸">
          {(['auto', 'manual', 'premium'] as const).map((m) => (
            <button
              type="button"
              key={m}
              aria-pressed={pnlY.mode === m}
              disabled={noLegs}
              onClick={() => setMode(m)}
            >
              {Y_MODE_LABEL[m]}
            </button>
          ))}
        </fieldset>
        {pnlY.mode === 'manual' && (
          <span class="pnl-range">
            <label>
              下端{' '}
              <input
                type="text"
                inputMode="decimal"
                size={9}
                value={loText}
                aria-invalid={rangeError !== null}
                onInput={(e) => setLoText(e.currentTarget.value)}
                onChange={(e) => commitRange(e.currentTarget.value, hiText)}
              />
            </label>{' '}
            <label>
              上端{' '}
              <input
                type="text"
                inputMode="decimal"
                size={9}
                value={hiText}
                aria-invalid={rangeError !== null}
                onInput={(e) => setHiText(e.currentTarget.value)}
                onChange={(e) => commitRange(loText, e.currentTarget.value)}
              />
            </label>{' '}
            円
          </span>
        )}
        {pnlY.mode === 'premium' && (
          <label class="pnl-n">
            N{' '}
            <input
              type="text"
              inputMode="decimal"
              size={4}
              value={nText}
              aria-invalid={nError !== null}
              onInput={(e) => onN(e.currentTarget.value)}
            />
          </label>
        )}
        <fieldset class="seg" aria-label="拡大">
          <button
            type="button"
            aria-label="縮小"
            disabled={model.empty}
            onClick={() => zoomBy(BUTTON_ZOOM_OUT)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="拡大"
            disabled={model.empty}
            onClick={() => zoomBy(BUTTON_ZOOM_IN)}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label="リセット"
            disabled={model.empty}
            onClick={() => dispatch({ type: 'setPnlViewport', viewport: null })}
          >
            ⟲
          </button>
        </fieldset>
      </div>
      {errors.length > 0 && (
        <p class="field-error" role="alert">
          {errors.join(' / ')}
        </p>
      )}
      <div
        class={model.empty ? 'plot-area pnl-plot plot-empty' : 'plot-area pnl-plot'}
        ref={ref}
        tabIndex={model.empty ? -1 : 0}
        role="application"
        aria-label="損益グラフ（ホイール・ピンチで拡大、ドラッグでパン、ダブルクリックでリセット、長押しして左右にドラッグでシナリオ点 ΔX。キー: + / − 拡大縮小、← / → パン、R リセット、, / . で ΔX ∓100 円、< / > で ∓1,000 円）"
      >
        {model.empty ? (
          <p class="note">
            {legCount === 0
              ? '足を追加すると損益が出ます'
              : '評価できる足が無い（F が決まらない限月の足だけ）'}
          </p>
        ) : (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            <g class="grid">
              {model.yTicks.map((t) => (
                <g key={`y${t.v}`}>
                  <line x1={plot.left} x2={right} y1={t.px} y2={t.px} />
                  <text x={plot.left - 4} y={t.px} class="tick-y">
                    {t.label}
                  </text>
                </g>
              ))}
              {model.xTicks.map((t) => (
                <g key={`x${t.v}`}>
                  <line x1={t.px} x2={t.px} y1={plot.top} y2={bottom} />
                  <text x={t.px} y={bottom + 16} class="tick-x">
                    {t.label}
                  </text>
                </g>
              ))}
            </g>
            {/* 描画域の切り抜き（入れ子の svg。clip-path の ID を使わない） */}
            <svg
              x={plot.left}
              y={plot.top}
              width={plot.width}
              height={plot.height}
              viewBox={`${plot.left} ${plot.top} ${plot.width} ${plot.height}`}
              class="pnl-clip"
              aria-hidden="true"
            >
              {model.zeroPy !== null && (
                <line
                  class="pnl-zero"
                  x1={plot.left}
                  x2={right}
                  y1={model.zeroPy}
                  y2={model.zeroPy}
                />
              )}
              {model.x0Px !== null && (
                <line class="pnl-x0" x1={model.x0Px} x2={model.x0Px} y1={plot.top} y2={bottom} />
              )}
              {model.scenarioPx !== null && (
                <line
                  class="pnl-scn"
                  x1={model.scenarioPx}
                  x2={model.scenarioPx}
                  y1={plot.top}
                  y2={bottom}
                />
              )}
              {model.scenarioPx !== null && (
                // つかむ域（透明の太線。マウスを載せると左右矢印のカーソル）
                <line
                  class="pnl-scn-hit"
                  x1={model.scenarioPx}
                  x2={model.scenarioPx}
                  y1={plot.top}
                  y2={bottom}
                />
              )}
              {model.scenarioAtm !== null && (
                <line
                  class="pnl-scn-atm"
                  x1={model.scenarioAtm.px}
                  x2={model.scenarioAtm.px}
                  y1={plot.top}
                  y2={bottom}
                />
              )}
              {model.lines.map((l) => (
                <path key={l.kind} class={`pnl-line ${l.kind}`} d={l.d} />
              ))}
              {model.kinks.map((k) => (
                <circle key={`k${k.x}`} class="pnl-kink" cx={k.px} cy={k.py} r={3} />
              ))}
              {model.breakevens.map((b) => (
                <path
                  key={`b${b.x}`}
                  class="pnl-bep"
                  d={`M${b.px.toFixed(1)} ${(b.py - 5).toFixed(1)}l5 5l-5 5l-5 -5z`}
                />
              ))}
            </svg>
            {/* 交点の点と金額のラベル（切り抜きの外に描く。座標は描画域の内側に収めてある） */}
            {marks?.marks.map((m) =>
              m.py === null ? null : (
                <circle
                  key={`mp${m.kind}`}
                  class={`pnl-mark ${m.kind}`}
                  cx={marks.px}
                  cy={m.py}
                  r={3.5}
                />
              ),
            )}
            {marks?.marks.map((m) => (
              <text
                key={`ml${m.kind}`}
                class={`pnl-mark-label ${m.kind} ${m.anchor}`}
                x={m.labelX}
                y={m.labelY}
              >
                {m.text}
              </text>
            ))}
          </svg>
        )}
      </div>
      {/* グラフのすぐ下に読み取りの帯（シナリオ点の値。#52） */}
      <Readout model={readout} />
      <p class="legend note">
        <span class="lg expiry">━ {LINE_LABEL.expiry}</span>{' '}
        {model.lines.some((l) => l.kind === 'date') ? (
          <span class="lg date">
            ━{' '}
            {model.days > 0
              ? `指定日 d（${fmtDays(model.days)} 日後）+ シナリオ`
              : 'シナリオ（d = 0）'}
          </span>
        ) : (
          <span class="lg date">指定日（d = 0・Δσ = Δs = 0）= 今日</span>
        )}{' '}
        <span class="lg today">┅ {LINE_LABEL.today}</span> ● 満期の折れ点 ◆ 満期の BEP ┆ X₀
        {model.scenarioPx !== null && <span class="lg scn"> ┆ シナリオ点 X₀ + ΔX</span>}
        {model.scenarioAtm !== null && (
          <span class="lg scn-atm">
            {' '}
            ┆ シナリオ ATM（{model.scenarioAtm.monthId} 限 {fmtNum(model.scenarioAtm.k, 0)}）
          </span>
        )}
        {marks && (
          <span class="block">
            縦線上の 満 / 指 / 今 = シナリオ点 X {fmtNum(marks.x)}{' '}
            の満期・指定日・今日の損益（指標の単位 {AMOUNT_UNIT_LABEL[amountUnit]}
            ）。長押しして左右にドラッグでシナリオ点を動かす
          </span>
        )}
        <span class="block">
          横軸 X（円）/ 縦軸 損益（{unit}）。前提: 指定日の線 = シナリオ（Δσ{' '}
          {fmtNum(scenario.dSigma, 1)}
          pt、Δs {fmtNum(scenario.skew, 1)}）、今日の線 = シナリオ IV なし。どちらも β{' '}
          {fmtNum(scenario.beta, 1)}pt/1%（横軸の各点）、{DYNAMICS_LABEL[scenario.ivDynamics]}
        </span>
        {model.premiumFallback && <span class="block warn">プレミアム 0 のため自動</span>}
        {model.daysClamped && (
          <span class="block warn">
            指定日 d を最遠の足の SQ（{fmtDays(model.maxDays)} 日）に収めて描いた
          </span>
        )}
      </p>
    </>
  );
}

/** 損益グラフ。props が変わらなければ描き直さない */
export const PnlChart = pure(PnlChartView);

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Scenario } from '../../model';
import { type Domain, zoom } from '../chart/scale';
import { type Action, parseDays, parsePremiumN, parseYRange } from '../state';
import { fmtNum } from '../view/format';
import {
  PNL_MARGIN,
  type PnlBase,
  type PnlLineKind,
  type PnlYMode,
  type PnlYSettings,
  pnlChartModel,
  Y_UNIT_LABEL,
} from '../view/pnlChart';
import { pure } from './pure';
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
  dispatch: (a: Action) => void;
}

const LINE_LABEL: Record<PnlLineKind, string> = {
  expiry: '満期（SQ）',
  date: '指定日 d',
  today: '今日',
};

const Y_MODE_LABEL: Record<PnlYMode, string> = {
  auto: '自動',
  manual: '手動',
  premium: '±N 倍',
};

const fmtDays = (v: number) => String(Math.round(v * 100) / 100);

/** 損益グラフ（SVG。座標・範囲・目盛りは ui/view/pnlChart.ts と ui/chart/scale.ts の純関数）。 */
function PnlChartView({ base, legCount, scenario, viewport, pnlY, dispatch }: PnlChartProps) {
  const { ref, width } = useWidth(480);
  const height = width < NARROW_FROM ? HEIGHT_NARROW : HEIGHT;
  const plotWidth = Math.max(width - PNL_MARGIN.left - PNL_MARGIN.right, 1);
  const plotHeight = height - PNL_MARGIN.top - PNL_MARGIN.bottom;
  const model = useMemo(
    () => pnlChartModel({ base, scenario, viewport, pnlY, plotWidth, plotHeight }),
    [base, scenario, viewport, pnlY, plotWidth, plotHeight],
  );
  const range: Domain = [PNL_MARGIN.left, PNL_MARGIN.left + plotWidth];

  useChartGestures(ref, {
    viewport: model.domain,
    full: model.full,
    minWidth: model.minWidth,
    range,
    disabled: model.empty,
    onViewport: (v) => dispatch({ type: 'setPnlViewport', viewport: v }),
  });

  // 入力欄（文字列は部品が持ち、検証できた値だけ状態に入れる）
  const [daysText, setDaysText] = useState(fmtDays(scenario.days));
  const [daysError, setDaysError] = useState<string | null>(null);
  useEffect(() => {
    // 外から d が変わったとき（#6 のスライダーなど）は欄を合わせる
    const parsed = Number(daysText.replace(/,/g, ''));
    if (!(Number.isFinite(parsed) && Math.abs(parsed - scenario.days) < 1e-9)) {
      setDaysText(fmtDays(scenario.days));
      setDaysError(null);
    }
    // daysText はここでは追わない（入力中の文字列を上書きしない）
  }, [scenario.days]);
  const [loText, setLoText] = useState('');
  const [hiText, setHiText] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [nText, setNText] = useState(String(pnlY.n));
  const [nError, setNError] = useState<string | null>(null);

  const noLegs = !base;
  const maxDays = base?.maxDays ?? 0;

  const onDays = (text: string) => {
    setDaysText(text);
    const r = parseDays(text, maxDays);
    if (r.ok) {
      setDaysError(null);
      if (r.value !== scenario.days) dispatch({ type: 'setDays', days: r.value });
    } else setDaysError(r.message);
  };

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

  // 上限（最遠の足の SQ）が変わったら、エラーになっていた入力を判定し直す（遠い限月の足を足した後など）
  useEffect(() => {
    if (daysError !== null && !noLegs) onDays(daysText);
  }, [maxDays]);

  const zoomBy = (factor: number) =>
    dispatch({
      type: 'setPnlViewport',
      viewport: zoom(model.domain, factor, model.full, model.minWidth),
    });

  // 入力のエラーは、いま見えている欄の分だけ出す（モードを切り替えたら前のモードの分は出さない）
  const errors = [
    daysError,
    pnlY.mode === 'manual' ? rangeError : null,
    pnlY.mode === 'premium' ? nError : null,
  ].filter((e): e is string => e !== null);

  const { plot } = model;
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const unit = Y_UNIT_LABEL[model.yUnit];

  return (
    <div class="pnl">
      <div class="pnl-tools">
        <label class="pnl-days">
          指定日 d{' '}
          <input
            type="text"
            inputMode="decimal"
            size={6}
            value={daysText}
            disabled={noLegs}
            aria-invalid={daysError !== null}
            onInput={(e) => onDays(e.currentTarget.value)}
          />{' '}
          日<span class="note">（0〜{fmtDays(maxDays)}）</span>
        </label>
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
        aria-label="損益グラフ（ホイール・ピンチで拡大、ドラッグでパン、ダブルクリックでリセット。キー: + / − 拡大縮小、← / → パン、R リセット）"
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
          </svg>
        )}
      </div>
      <p class="legend note">
        <span class="lg expiry">━ {LINE_LABEL.expiry}</span>{' '}
        {model.lines.some((l) => l.kind === 'date') ? (
          <span class="lg date">
            ━ {LINE_LABEL.date}（{fmtDays(model.days)} 日後）
          </span>
        ) : (
          <span class="lg date">指定日（d = 0）= 今日</span>
        )}{' '}
        <span class="lg today">┅ {LINE_LABEL.today}</span> ● 満期の折れ点 ◆ 満期の BEP ┆ X₀
        <span class="block">
          横軸 X（円）/ 縦軸 損益（{unit}）。前提: シナリオ 0（ΔX・Δσ・Δs = 0）、β{' '}
          {fmtNum(scenario.beta, 1)}pt/1%、sticky strike
        </span>
        {model.premiumFallback && <span class="block warn">プレミアム 0 のため自動</span>}
        {model.daysClamped && (
          <span class="block warn">
            指定日 d を最遠の足の SQ（{fmtDays(model.maxDays)} 日）に収めて描いた
          </span>
        )}
      </p>
    </div>
  );
}

/** 損益グラフ。props が変わらなければ描き直さない */
export const PnlChart = pure(PnlChartView);

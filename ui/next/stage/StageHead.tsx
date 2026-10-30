import type { Scenario } from '../../../model';
import { MAX_PINS, type PinLineMode } from '../../pins';
import type { Action } from '../../state';
import { fmtNum } from '../../view/format';
import { HINT_TERMS } from '../../view/glossary';
import type { FullRow } from '../../view/metricsPanel';
import { PIN_MARK, type PinTarget, pinMenuRows } from '../../view/pins';
import type { PnlChartModel, PnlYSettings } from '../../view/pnlChart';
import type { SurfaceLegend } from '../../view/pnlSurface';
import { KIND_PREFIX } from '../../view/scenarioMarks';
import { CHART_MODES, type ChartMode } from '../../view/shell';
import { FullText } from '../parts/FullText';
import { Icon } from '../parts/Icon';
import { Menu, type MenuItem } from '../parts/Menu';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { TermLinks } from '../parts/TermLinks';
import { YAxisFields } from '../parts/YAxisFields';

const fmtDays = (v: number) => String(Math.round(v * 100) / 100);

/**
 * 線の凡例の 1 項目（#276）: 線種 + 名前。舞台の幅 < 560px（stage.css。タブレットの舞台でも省略記号にしない）は十字線・交点のラベルと同じ 1 字（満 / 指 / 今）に替える
 * （省略記号で意味を消さない。全文は title）
 */
const lineLegend = (cls: string, long: string, short: string) => (
  <span title={long}>
    <i class={cls} />
    <span class="lg-long">{long}</span>
    <span class="lg-short">{short}</span>
  </span>
);
const DYNAMICS_LABEL = { sticky_strike: 'sticky strike', sticky_moneyness: 'sticky moneyness' };

/**
 * 舞台の凡例行（docs/ui-redesign.md §3・§9。#82）: 線の凡例・ピン ①②③（スマホは番号だけ）と ×、[ピン N/3] のメニュー、
 * [−][＋][⟲]（舞台の幅 < 480px は ⋯ の中）、⋯（縦軸の自動 / ±N 倍 / 手動）、警告のタグ、ⓘ（前提）。
 * 操作は既存の action だけ。メニュー・ポップオーバーは overflow を切らないこの行に置く。
 * 面モード（#88 段 A）: [線 | 面]（幅 < 480px は ⋯ の中）、線の凡例の代わりに色の見本 + 文言 + ±vmax、ピンのチップと
 * 「プレミアム 0」のタグは出さない、⋯ の縦軸の欄は注記に、ⓘ は面の説明。
 */
export function StageHead(p: {
  model: PnlChartModel;
  noLegs: boolean;
  scenario: Scenario;
  pnlY: PnlYSettings;
  pins: readonly PinTarget[];
  /** ①②③ を押したときのポップオーバーの行（pins と同じ順。ui/view/pins.ts の pinPopRows。#125） */
  pinRows: readonly FullRow[][];
  pinLine: PinLineMode;
  pinTabs: ReadonlyArray<{ id: number; name: string; legCount: number; pinned: boolean }>;
  onPinCurrent: () => void;
  onZoom: (factor: number) => void;
  chart: ChartMode;
  onChart: (chart: ChartMode) => void;
  /** 面モードの凡例（線モードは null） */
  surfaceLegend: SurfaceLegend | null;
  dispatch: (a: Action) => void;
}) {
  const { model, pnlY, pins, dispatch, scenario } = p;
  const legend = p.surfaceLegend;
  // 足が無い（評価できる足が無い）ときは面モードでも線モードの空の表示（[線 | 面] の押された状態は保つ）
  const surf = p.chart === 'surface' && !model.empty;
  const chartSeg = (
    <Seg label="グラフの表示" value={p.chart} options={CHART_MODES} onChange={p.onChart} />
  );
  // 行は ui/view/pins.ts の pinMenuRows（コマンドパレットと同じ規則。#89 段 B）
  const pinItems: MenuItem[] = pinMenuRows({
    noLegs: p.noLegs,
    pins,
    pinLine: p.pinLine,
    pinTabs: p.pinTabs,
  }).map(({ run, ...row }) => ({
    ...row,
    onSelect: () => (run.kind === 'pinCurrent' ? p.onPinCurrent() : dispatch(run.action)),
  }));

  const hasDate = model.lines.some((l) => l.kind === 'date');
  const zoomButtons = (
    <>
      <button
        type="button"
        class="btn ghost icon sm"
        aria-label="縮小"
        title="縮小"
        disabled={model.empty}
        onClick={() => p.onZoom(1.25)}
      >
        <Icon name="minus" />
      </button>
      <button
        type="button"
        class="btn ghost icon sm"
        aria-label="拡大"
        title="拡大"
        disabled={model.empty}
        onClick={() => p.onZoom(0.8)}
      >
        <Icon name="plus" />
      </button>
      <button
        type="button"
        class="btn ghost icon sm"
        aria-label="表示をリセット"
        title="表示をリセット"
        disabled={model.empty}
        onClick={() => dispatch({ type: 'setPnlViewport', viewport: null })}
      >
        <Icon name="reset" />
      </button>
    </>
  );
  return (
    <div class="stage-head">
      <div class="legend">
        {legend && (
          <span class="surf" title={`${legend.long}${legend.vmax ? ` ${legend.vmax}` : ''}`}>
            <i class="surf-sw" />
            <span class="surf-long">{legend.long}</span>
            <span class="surf-short">{legend.short}</span>
            {legend.vmax && <b class="vmax">{legend.vmax}</b>}
          </span>
        )}
        {!legend && lineLegend('exp', '満期', KIND_PREFIX.expiry)}
        {!legend &&
          hasDate &&
          lineLegend(
            'sc',
            model.days > 0 ? `指定日（d ${fmtDays(model.days)} 日後）` : 'シナリオ（d = 0）',
            KIND_PREFIX.date,
          )}
        {!legend && lineLegend('td', '今日', KIND_PREFIX.today)}
        {!legend && model.premiumFallback && <span class="tag warn">プレミアム 0 のため自動</span>}
        {model.daysClamped && <span class="tag warn">指定日 d を最遠の SQ に収めた</span>}
      </div>
      {!legend && pins.length > 0 && (
        // ピンの凡例（①②③ + 名前 + ×）は線の凡例より先に場所を取る（縮むのは名前だけ。スマホ・狭い舞台は番号だけ）
        <div class="pins" data-n={pins.length}>
          {pins.map((t, i) => (
            <span class="pin-chip" key={t.no}>
              <Popover
                label={`ピン ${PIN_MARK[t.no]} ${t.name} の中身`}
                buttonClass="pin-open"
                popClass="pin-pop"
                button={
                  <>
                    <i class={`p${t.no}`} />
                    <span class={`pin-no p${t.no}`}>{PIN_MARK[t.no]}</span>
                    <span class="pin-name" title={t.name}>
                      {t.name}
                    </span>
                  </>
                }
              >
                <FullText rows={p.pinRows[i] ?? []} />
              </Popover>
              <button
                type="button"
                class="pin-x"
                aria-label={`ピン ${PIN_MARK[t.no]} ${t.name} を外す`}
                title="外す"
                onClick={() => dispatch({ type: 'removePin', no: t.no })}
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="stage-tools">
        <span class="cm">{chartSeg}</span>
        <Menu
          label="ピン"
          button={`ピン ${pins.length}/${MAX_PINS}`}
          buttonClass="btn ghost sm pin-btn"
          items={pinItems}
        />
        <span class="zb">{zoomButtons}</span>
        <Popover label="グラフの設定" button={<Icon name="more" />} buttonClass="btn ghost icon sm">
          <div class="stage-pop">
            <div class="row cm-in">
              <span class="lbl">グラフ</span>
              {chartSeg}
            </div>
            {surf ? (
              <p class="surf-note">縦軸は経過日数（面モード）。縦軸の設定は線モードで</p>
            ) : (
              <YAxisFields pnlY={pnlY} current={() => model.yDomain} dispatch={dispatch} />
            )}
            <div class="row zb-in">
              <span class="lbl">表示</span>
              {zoomButtons}
            </div>
          </div>
        </Popover>
        <Popover label="損益グラフの前提" button={<Icon name="info" />}>
          {surf ? (
            <>
              <p>
                色 = 指定日の損益（横 = 原資産、縦 = 経過日数 0（下）〜 最遠の SQ（上））。緑 =
                利益・赤 = 損失、濃さ = |損益| ÷ 格子の最大（±vmax）の 0.6 乗、0 付近は透明。
              </p>
              <p>
                Δσ {fmtNum(scenario.dSigma, 1)}pt・Δs {fmtNum(scenario.skew, 1)}・β ×
                {fmtNum(scenario.beta, 1)}・{DYNAMICS_LABEL[scenario.ivDynamics]}{' '}
                は面の全体に効く。点 = シナリオ点（ΔX・d）。点を押して動かすと ΔX と d
                が同時に動く（離れた所を押すとそこへ。2 本指・横ホイールでパン）。キーは ← → ΔX、[ ]
                d。
              </p>
            </>
          ) : (
            // 線の名前は凡例の行にあるので、ⓘ は指定日と今日の違いの 2 行だけ（#276）
            <>
              <p>満 = 満期・指 = 指定日・今 = 今日（凡例・交点のラベルの 1 字）</p>
              <p>
                指定日 = シナリオ（Δσ {fmtNum(scenario.dSigma, 1)}pt・Δs {fmtNum(scenario.skew, 1)}
                ・β ×{fmtNum(scenario.beta, 1)}・{DYNAMICS_LABEL[scenario.ivDynamics]}）
              </p>
              <p>今日 = シナリオの IV の変化なし（β と IV の動き方は同じ）</p>
            </>
          )}
          <TermLinks ids={HINT_TERMS.stage} />
        </Popover>
      </div>
    </div>
  );
}

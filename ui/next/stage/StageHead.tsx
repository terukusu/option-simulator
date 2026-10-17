import type { Scenario } from '../../../model';
import { MAX_PINS, type PinLineMode, pinAddError } from '../../pins';
import type { Action } from '../../state';
import { fmtNum } from '../../view/format';
import { PIN_MARK, type PinTarget } from '../../view/pins';
import type { PnlChartModel, PnlYSettings } from '../../view/pnlChart';
import { Menu, type MenuItem } from '../parts/Menu';
import { Popover } from '../parts/Popover';
import { YAxisFields } from '../parts/YAxisFields';

const fmtDays = (v: number) => String(Math.round(v * 100) / 100);
const DYNAMICS_LABEL = { sticky_strike: 'sticky strike', sticky_moneyness: 'sticky moneyness' };

/**
 * 舞台の凡例行（docs/ui-redesign.md §3・§9。#82）: 線の凡例・ピン ①②③（スマホは番号だけ）と ×、[ピン N/3] のメニュー、
 * [−][＋][⟲]（舞台の幅 < 480px は ⋯ の中）、⋯（縦軸の自動 / ±N 倍 / 手動）、警告のタグ、ⓘ（前提）。
 * 操作は既存の action だけ。メニュー・ポップオーバーは overflow を切らないこの行に置く。
 */
export function StageHead(p: {
  model: PnlChartModel;
  noLegs: boolean;
  scenario: Scenario;
  pnlY: PnlYSettings;
  pins: readonly PinTarget[];
  pinLine: PinLineMode;
  pinTabs: ReadonlyArray<{ id: number; name: string; legCount: number; pinned: boolean }>;
  onPinCurrent: () => void;
  onZoom: (factor: number) => void;
  dispatch: (a: Action) => void;
}) {
  const { model, pnlY, pins, dispatch, scenario } = p;
  const pinFull = pinAddError(pins);
  const pinItems: MenuItem[] = [
    {
      key: 'current',
      label: '今の線を残す',
      onSelect: p.onPinCurrent,
      disabled: p.noLegs || pinFull !== null,
    },
    ...p.pinTabs.map((t) => ({
      key: `tab${t.id}`,
      label: `${t.name} を重ねる`,
      onSelect: () => dispatch({ type: 'addPin', source: { kind: 'tab', tabId: t.id } }),
      disabled: pinFull !== null || t.pinned || t.legCount === 0,
    })),
    {
      key: 'period',
      label: 'ピンの線: 期中',
      checked: p.pinLine === 'period',
      onSelect: () => dispatch({ type: 'setPinLine', line: 'period' }),
    },
    {
      key: 'expiry',
      label: 'ピンの線: 満期',
      checked: p.pinLine === 'expiry',
      onSelect: () => dispatch({ type: 'setPinLine', line: 'expiry' }),
    },
    ...pins.map((t) => ({
      key: `remove${t.no}`,
      label: `${PIN_MARK[t.no]} ${t.name} を外す`,
      onSelect: () => dispatch({ type: 'removePin', no: t.no }),
    })),
    {
      key: 'clear',
      label: '全部外す',
      onSelect: () => dispatch({ type: 'clearPins' }),
      disabled: pins.length === 0,
    },
  ];

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
        −
      </button>
      <button
        type="button"
        class="btn ghost icon sm"
        aria-label="拡大"
        title="拡大"
        disabled={model.empty}
        onClick={() => p.onZoom(0.8)}
      >
        ＋
      </button>
      <button
        type="button"
        class="btn ghost icon sm"
        aria-label="表示をリセット"
        title="表示をリセット"
        disabled={model.empty}
        onClick={() => dispatch({ type: 'setPnlViewport', viewport: null })}
      >
        ⟲
      </button>
    </>
  );
  return (
    <div class="stage-head">
      <div class="legend">
        <span>
          <i class="exp" />
          <span>満期</span>
        </span>
        {hasDate && (
          <span>
            <i class="sc" />
            <span>
              {model.days > 0 ? `指定日（d ${fmtDays(model.days)} 日後）` : 'シナリオ（d = 0）'}
            </span>
          </span>
        )}
        <span>
          <i class="td" />
          <span>今日</span>
        </span>
        {model.premiumFallback && <span class="tag warn">プレミアム 0 のため自動</span>}
        {model.daysClamped && <span class="tag warn">指定日 d を最遠の SQ に収めた</span>}
      </div>
      {pins.length > 0 && (
        // ピンの凡例（①②③ + 名前 + ×）は線の凡例より先に場所を取る（縮むのは名前だけ。スマホ・狭い舞台は番号だけ）
        <div class="pins" data-n={pins.length}>
          {pins.map((t) => (
            <span class="pin-chip" key={t.no} title={t.name}>
              <i class={`p${t.no}`} />
              <span class={`pin-no p${t.no}`}>{PIN_MARK[t.no]}</span>
              <span class="pin-name">{t.name}</span>
              <button
                type="button"
                class="pin-x"
                aria-label={`ピン ${PIN_MARK[t.no]} ${t.name} を外す`}
                title="外す"
                onClick={() => dispatch({ type: 'removePin', no: t.no })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="stage-tools">
        <Menu
          label="ピン"
          button={`ピン ${pins.length}/${MAX_PINS}`}
          buttonClass="btn ghost sm pin-btn"
          items={pinItems}
        />
        <span class="zb">{zoomButtons}</span>
        <Popover label="グラフの設定" button="⋯" buttonClass="btn ghost icon sm">
          <div class="stage-pop">
            <YAxisFields pnlY={pnlY} current={() => model.yDomain} dispatch={dispatch} />
            <div class="row zb-in">
              <span class="lbl">表示</span>
              {zoomButtons}
            </div>
          </div>
        </Popover>
        <Popover label="損益グラフの前提" button="ⓘ">
          <p>
            満期 = SQ の損益。指定日の線 = シナリオ（Δσ {fmtNum(scenario.dSigma, 1)}pt、Δs{' '}
            {fmtNum(scenario.skew, 1)}）、今日の線 = シナリオ IV なし。どちらも β{' '}
            {fmtNum(scenario.beta, 1)}pt/1%（横軸の各点）、{DYNAMICS_LABEL[scenario.ivDynamics]}。
          </p>
          <p>
            縦線上の 満 / 指 / 今 = シナリオ点の満期・指定日・今日の損益。塗り =
            指定日の線（無ければ今日の線）と 0 の間。横軸の ▲ call / ▼ put = 足（塗り = 買い・白抜き
            = 売り）。◇ = 満期の BEP。
          </p>
        </Popover>
      </div>
    </div>
  );
}

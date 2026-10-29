import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { IvBar } from '../../../data';
import type { Scenario } from '../../../model';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { IvView } from '../../components/useIvHistory';
import { askIvHistory } from '../../view/aiAsk';
import { HINT_TERMS } from '../../view/glossary';
import {
  fmtIvPt,
  IV_FOCUS_LABEL,
  IV_HINT,
  IV_MODES,
  IV_NOTE,
  IV_TFS,
  type IvMode,
  type IvNowValue,
  type IvTf,
  ivCursorShown,
  ivNowPoint,
  ivReadout,
  ivScenarioLevel,
  lineSegments,
} from '../../view/ivHistory';
import { type IvLoadState, ivInProgress, ivLoadView } from '../../view/ivLoad';
import { PanelHead } from '../PanelHead';
import { AskAi } from '../parts/AskAi';
import { Icon } from '../parts/Icon';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { TermLinks } from '../parts/TermLinks';
import { IvPlot } from './IvPlot';

export interface IvHistoryProps {
  load: IvLoadState;
  view: IvView;
  /** useIvHistory の bars・viewport・leftSlack（表示する足・表示範囲・左の余白） */
  bars: readonly IvBar[];
  viewport: Domain;
  leftSlack: number;
  /** 今の板の iv30（ivNowValue。出なければ null） */
  now: IvNowValue | null;
  /** シナリオと舞台の X₀（シナリオの水準） */
  scenario: Scenario;
  x0: number;
  /** 取引カレンダーの is_trading_day = false の日（欠けの判定） */
  nonTradingDays: ReadonlySet<string>;
  /** 見出しの Seg（PC は市場の Seg、スマホ・タブレットは [スマイル | IV 推移]） */
  seg: ComponentChildren;
  onRefresh: () => void;
  onRetry: () => void;
  onTf: (tf: IvTf) => void;
  onMode: (mode: IvMode) => void;
  onViewport: (v: Domain | null) => void;
}

/**
 * IV 推移（#79。docs/ui-redesign.md §4.7）: 見出し行（タイトル・Seg・ⓘ）→ ツールの行（足・ローソク / 線・最新化 ⟳）→
 * 読み取りの 1 行（カーソルの足、無ければ最新の足の 始 / 高 / 安 / 終）→ 描画域（market/IvPlot.tsx）→ 凡例。
 * 状態は NextApp の useIvHistory（パネルを閉じても残る）。ここは表示モデルを描くだけ。
 */
function IvHistoryView(p: IvHistoryProps) {
  const { load, view } = p;
  const tf = load.tf;
  const { bars, viewport } = p;
  const { entry, loading, pending, failed, failedSide } = ivLoadView(load);
  const segments = useMemo(
    () => lineSegments(bars, tf, p.nonTradingDays),
    [bars, tf, p.nonTradingDays],
  );
  // 「今」の印（右端まで読んであり、表の最後の行より新しい板のときだけ）とシナリオの水準（基準 = 今、無ければ最新の
  // 足の close。右端まで読んでいなければ（遠い側を捨てた）最後の足は最新でないので今の値だけ）
  const right = entry?.rightLoaded ?? false;
  const nowPt = useMemo(
    () => (right ? ivNowPoint(p.now, bars, tf, load.lastAt, p.nonTradingDays) : null),
    [right, p.now, bars, tf, load.lastAt, p.nonTradingDays],
  );
  const base = nowPt?.iv ?? (right ? bars.at(-1)?.c : p.now?.iv) ?? null;
  const level = ivScenarioLevel(base, p.scenario, p.x0);
  // カーソルはその足の並びの index と十字線の横線の高さ（画素。足・読み込みが変わったら外す）
  const [cur, setCur] = useState<{ bars: readonly IvBar[]; i: number; y: number | null } | null>(
    null,
  );
  const cursor = cur && cur.bars === bars ? cur.i : null;
  const cursorY = cur && cur.bars === bars ? cur.y : null;
  const onCursor = useMemo(
    () => (i: number | null, y?: number | null) =>
      setCur(i === null ? null : { bars, i, y: y ?? null }),
    [bars],
  );
  // 右端の足が進行中（表の作り直しの中。立会の外・週末で表が止まっていれば確定として描く）
  const rightLoaded = ivInProgress(entry);
  // 読み取りは十字線の足が表示範囲の内のときだけその足（外へパンしたら最新の足 = 十字線と一緒に外す。#227）
  const shown = ivCursorShown(cursor, bars.length, viewport);
  const ro = ivReadout(bars, tf, shown, rightLoaded);
  // [AI に聞く]（#136）: 読み取りの足・今・シナリオの水準（押したときに作る）
  const makeAsk = () =>
    askIvHistory({
      tfLabel: IV_TFS.find((x) => x.value === tf)?.label ?? tf,
      readout: ro,
      cursor: shown !== null,
      now: nowPt ? fmtIvPt(nowPt.iv) : null,
      scenario: level !== null ? fmtIvPt(level) : null,
    });
  const status = !entry
    ? failed
      ? 'failed'
      : 'loading'
    : failed
      ? 'failed'
      : bars.length === 0
        ? 'empty'
        : 'ready';

  return (
    <>
      <PanelHead title="IV 推移">
        {p.seg}
        <Popover label="IV 推移の操作" button={<Icon name="info" />}>
          <p>{IV_HINT}</p>
          <p>{IV_NOTE}</p>
          <TermLinks ids={HINT_TERMS.ivHistory} />
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div class="panel-body market-body" tabIndex={-1} role="group" aria-label={IV_FOCUS_LABEL}>
        <div class="iv-tools">
          <Seg label="足" value={tf} options={IV_TFS} onChange={p.onTf} />
          <Seg label="表示の形" value={view.mode} options={IV_MODES} onChange={p.onMode} />
          <span class="spacer" />
          {bars.length > 0 && (
            <AskAi topic="iv.history" label="ATM IV（30 日固定）" make={makeAsk} short />
          )}
          <button
            type="button"
            class="btn ghost icon sm iv-refresh"
            aria-label="最新化"
            title="最新化（右端を読み直す）"
            disabled={loading || !load.opened}
            onClick={p.onRefresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
        <div class={ro.progress ? 'iv-readout progress' : 'iv-readout'} aria-live="off">
          <span class="time">{ro.time}</span>
          <span class="v">
            <span class="k">始</span>
            {ro.o}
          </span>
          <span class="v">
            <span class="k">高</span>
            {ro.h}
          </span>
          <span class="v">
            <span class="k">安</span>
            {ro.l}
          </span>
          <span class="v">
            <span class="k">終</span>
            {ro.c}
          </span>
          {ro.progress && <span class="tag">確定前</span>}
        </div>
        <IvPlot
          bars={bars}
          tf={tf}
          mode={view.mode}
          viewport={viewport}
          segments={segments}
          rightLoaded={rightLoaded}
          cursor={cursor}
          cursorY={cursorY}
          leftSlack={p.leftSlack}
          now={nowPt}
          scenario={level}
          status={status}
          failedSide={failedSide}
          busy={loading && entry ? (pending === 'left' ? 'left' : 'right') : null}
          onViewport={p.onViewport}
          onCursor={onCursor}
          onRetry={p.onRetry}
        />
        <div class="iv-legend">
          <span class="line">
            ATM IV<span class="long">（30 日固定・%）</span>
          </span>
          {nowPt && (
            <span
              class="now"
              title="今の板から計算した 30 日固定の ATM IV（表の最後の行より新しい）"
            >
              ● 今 {fmtIvPt(nowPt.iv)}
            </span>
          )}
          {level !== null && (
            <span class="sc" title="シナリオの Δσ と β を ATM に適用した水準">
              ┄ シナリオ {fmtIvPt(level)}
            </span>
          )}
          {rightLoaded && <span class="prog">薄い足 = 確定前</span>}
        </div>
      </div>
    </>
  );
}

export const IvHistory = pure(IvHistoryView);

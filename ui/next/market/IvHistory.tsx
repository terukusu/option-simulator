import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { IvBar } from '../../../data';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { IvView } from '../../components/useIvHistory';
import {
  barsForTf,
  IV_FOCUS_LABEL,
  IV_HINT,
  IV_MODES,
  IV_NOTE,
  IV_TFS,
  type IvMode,
  type IvTf,
  ivReadout,
  lineSegments,
  resolveIvViewport,
} from '../../view/ivHistory';
import { type IvLoadState, ivLoadView } from '../../view/ivLoad';
import { PanelHead } from '../PanelHead';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { IvPlot } from './IvPlot';

export interface IvHistoryProps {
  load: IvLoadState;
  view: IvView;
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

const EMPTY: readonly IvBar[] = [];

/**
 * IV 推移（#79。docs/ui-redesign.md §4.7）: 見出し行（タイトル・Seg・ⓘ）→ 道具の行（足・ローソク / 線・最新化 ⟳）→
 * 読み取りの 1 行（カーソルの足、無ければ最新の足の 始 / 高 / 安 / 終）→ 描画域（market/IvPlot.tsx）→ 凡例。
 * 状態は NextApp の useIvHistory（パネルを閉じても残る）。ここは表示モデルを描くだけ。
 */
function IvHistoryView(p: IvHistoryProps) {
  const { load, view } = p;
  const tf = load.tf;
  const { entry, loading, failed } = ivLoadView(load);
  const bars = useMemo(() => (entry ? barsForTf(entry.bars, tf) : EMPTY), [entry, tf]);
  const segments = useMemo(
    () => lineSegments(bars, tf, p.nonTradingDays),
    [bars, tf, p.nonTradingDays],
  );
  const viewport = useMemo(
    () => resolveIvViewport(bars, tf, view.viewport, view.keep),
    [bars, tf, view.viewport, view.keep],
  );
  // カーソルはその足の並びの index（足・読み込みが変わったら外す）
  const [cur, setCur] = useState<{ bars: readonly IvBar[]; i: number } | null>(null);
  const cursor = cur && cur.bars === bars ? cur.i : null;
  const onCursor = useMemo(
    () => (i: number | null) => setCur(i === null ? null : { bars, i }),
    [bars],
  );
  const rightLoaded = entry?.rightLoaded ?? false;
  const ro = ivReadout(bars, tf, cursor, rightLoaded);
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
        <Popover label="IV 推移の操作" button="ⓘ">
          <p>{IV_HINT}</p>
          <p>{IV_NOTE}</p>
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div class="panel-body market-body" tabIndex={-1} role="group" aria-label={IV_FOCUS_LABEL}>
        <div class="iv-tools">
          <Seg label="足" value={tf} options={IV_TFS} onChange={p.onTf} />
          <Seg label="表示の形" value={view.mode} options={IV_MODES} onChange={p.onMode} />
          <span class="spacer" />
          <button
            type="button"
            class="btn ghost icon sm iv-refresh"
            aria-label="最新化"
            title="最新化（右端を読み直す）"
            disabled={loading || !load.opened}
            onClick={p.onRefresh}
          >
            ⟳
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
          status={status}
          busy={loading && !!entry}
          onViewport={p.onViewport}
          onCursor={onCursor}
          onRetry={p.onRetry}
        />
        <div class="iv-legend">
          <span class="line">ATM IV（30 日固定・%）</span>
          <span class="prog">薄い足 = 確定前</span>
        </div>
      </div>
    </>
  );
}

export const IvHistory = pure(IvHistoryView);

import type { ComponentChildren } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import type { FutBar } from '../../../data';
import { type Indicators, indicators, type TechParams } from '../../../model';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { IvView } from '../../components/useIvHistory';
import {
  FUT_FOCUS_LABEL,
  FUT_HINT,
  FUT_IMG_LABEL,
  FUT_LEGEND,
  FUT_LEGEND_LONG,
  FUT_NOTE,
  FUT_PLOT_LABEL,
  FUT_SERIES,
  type FutNowValue,
  fmtYen,
  futNowPoint,
  futReadout,
  futRollMarks,
} from '../../view/futHistory';
import { HINT_TERMS } from '../../view/glossary';
import { IND_KINDS, type IndKind, indKindLabel } from '../../view/indicators';
import { IV_MODES, IV_TFS, type IvMode, type IvTf, lineSegments } from '../../view/ivHistory';
import { type IvLoadState, ivInProgress, ivLoadView } from '../../view/ivLoad';
import { PanelHead } from '../PanelHead';
import { Chip } from '../parts/Chip';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { TermLinks } from '../parts/TermLinks';
import { IndicatorPanes } from './IndicatorPanes';
import { IvPlot } from './IvPlot';

export interface FutHistoryProps {
  load: IvLoadState<FutBar>;
  view: IvView;
  /** useFutureBars の bars・viewport・leftSlack（表示する足・表示範囲・左の余白） */
  bars: readonly FutBar[];
  viewport: Domain;
  leftSlack: number;
  /** 今の板の先物（futNowValue。値が無ければ null） */
  now: FutNowValue | null;
  /** 取引カレンダーの is_trading_day = false の日（欠けの判定） */
  nonTradingDays: ReadonlySet<string>;
  /** 見出しの Seg（PC は市場の Seg、スマホ・タブレットは [IV 推移 | スマイル | 先物]） */
  seg: ComponentChildren;
  onRefresh: () => void;
  onRetry: () => void;
  onTf: (tf: IvTf) => void;
  onMode: (mode: IvMode) => void;
  onViewport: (v: Domain | null) => void;
  /** 指標の段（#200。出す段。IND_KINDS の順。空 = 出さない） */
  indKinds: readonly IndKind[];
  onIndToggle: (kind: IndKind) => void;
  /** 指標の期間（#205。端末の設定。AI のツール technicals と同じ値） */
  techParams: TechParams;
}

const NO_IND: Indicators | null = null;

/**
 * 先物推移（#190。docs/ui-redesign.md §4.8）: IV 推移（IvHistory.tsx）と同じ並び = 見出し行（タイトル・Seg・ⓘ）→ 道具の
 * 行（足・ローソク / 線・最新化 ⟳）→ 読み取りの 1 行（始 / 高 / 安 / 終 = 円と限月）→ 描画域（IvPlot に円の書式と限月
 * 交代の印を渡す）→ 指標の段（#200。IndicatorPanes。凡例の行のトグルで出す）→ 凡例。シナリオの水準は無い。状態は
 * NextApp の useFutureBars（パネルを閉じても残る）。指標は段を 1 つでも出すときだけ足の並び・期間（#205）ごとに 1 回
 * 計算する。
 */
function FutHistoryView(p: FutHistoryProps) {
  const { load, view } = p;
  const tf = load.tf;
  const { bars, viewport } = p;
  const { entry, loading, pending, failed, failedSide } = ivLoadView(load);
  const segments = useMemo(
    () => lineSegments(bars, tf, p.nonTradingDays),
    [bars, tf, p.nonTradingDays],
  );
  // 「今」の印（右端まで読んであり、表の最後の行より新しい板で、限月が最後の足と同じときだけ）
  const right = entry?.rightLoaded ?? false;
  const nowPt = useMemo(
    () => (right ? futNowPoint(p.now, bars, tf, load.lastAt, p.nonTradingDays) : null),
    [right, p.now, bars, tf, load.lastAt, p.nonTradingDays],
  );
  const [cur, setCur] = useState<{ bars: readonly FutBar[]; i: number; y: number | null } | null>(
    null,
  );
  const cursor = cur && cur.bars === bars ? cur.i : null;
  const cursorY = cur && cur.bars === bars ? cur.y : null;
  const onCursor = useMemo(
    () => (i: number | null, y?: number | null) =>
      setCur(i === null ? null : { bars, i, y: y ?? null }),
    [bars],
  );
  const rolls = useCallback(
    (range: Domain) => futRollMarks(bars, viewport, range),
    [bars, viewport],
  );
  const showInd = p.indKinds.length > 0;
  const { techParams } = p;
  const ind = useMemo(
    () => (showInd ? indicators(bars, techParams) : NO_IND),
    [showInd, bars, techParams],
  );
  const rightLoaded = ivInProgress(entry);
  const ro = futReadout(bars, tf, cursor, rightLoaded);
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
      <PanelHead title="先物推移">
        {p.seg}
        <Popover label="先物推移の操作" button="ⓘ">
          <p>{FUT_HINT}</p>
          <p>{FUT_NOTE}</p>
          <TermLinks ids={HINT_TERMS.futHistory} />
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div class="panel-body market-body" tabIndex={-1} role="group" aria-label={FUT_FOCUS_LABEL}>
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
          {ro.contract && <span class="contract">{ro.contract}</span>}
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
          scenario={null}
          status={status}
          failedSide={failedSide}
          busy={loading && entry ? (pending === 'left' ? 'left' : 'right') : null}
          onViewport={p.onViewport}
          onCursor={onCursor}
          onRetry={p.onRetry}
          series={FUT_SERIES}
          plotLabel={FUT_PLOT_LABEL}
          imgLabel={FUT_IMG_LABEL}
          rolls={rolls}
        />
        {ind && bars.length > 0 && (
          <IndicatorPanes
            ind={ind}
            n={bars.length}
            kinds={p.indKinds}
            viewport={viewport}
            marginLeft={FUT_SERIES.marginLeft}
            cursor={cursor}
          />
        )}
        <div class="iv-legend">
          <span class="line">
            {FUT_LEGEND}
            <span class="long">{FUT_LEGEND_LONG}</span>
          </span>
          {nowPt && (
            <span class="now" title="今の板の先物の値（表の最後の行より新しい）">
              ● 今 {fmtYen(nowPt.iv)}
            </span>
          )}
          {rightLoaded && <span class="prog">薄い足 = 確定前</span>}
          {/* biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group" */}
          <span class="ind-toggles" role="group" aria-label="指標の段">
            {IND_KINDS.map((k) => (
              <Chip
                key={k.value}
                text={k.text}
                label={indKindLabel(k.value, techParams)}
                pressed={p.indKinds.includes(k.value)}
                onClick={() => p.onIndToggle(k.value)}
              />
            ))}
          </span>
        </div>
      </div>
    </>
  );
}

export const FutHistory = pure(FutHistoryView);

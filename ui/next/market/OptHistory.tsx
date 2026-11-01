import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Domain } from '../../chart/scale';
import { pure } from '../../components/pure';
import type { OptionBarsCtl } from '../../components/useOptionBars';
import { IV_MODES, ivCursorShown, resolveIvViewport } from '../../view/ivHistory';
import {
  OPT_EMPTY_TEXT,
  OPT_FOCUS_LABEL,
  OPT_HINT,
  OPT_IMG_LABEL,
  OPT_IV_IMG_LABEL,
  OPT_IV_PLOT_LABEL,
  OPT_IV_SERIES,
  OPT_NOTE,
  OPT_PLOT_LABEL,
  OPT_PRICE_SERIES,
  OPT_TFS,
  type OptTarget,
  optBand,
  optEntryLevel,
  optLastAtText,
  optName,
  optPlotBars,
  optReadout,
  optReadoutIndex,
  optSegments,
  optTitle,
  optTradeIvMarks,
  optTradeMarks,
} from '../../view/optHistory';
import { PanelHead } from '../PanelHead';
import { Icon } from '../parts/Icon';
import { ManualLinks } from '../parts/ManualLinks';
import { Popover } from '../parts/Popover';
import { Seg } from '../parts/Seg';
import { IvPlot } from './IvPlot';

export interface OptHistoryProps {
  target: OptTarget;
  ctl: OptionBarsCtl;
  /** 取引カレンダーの is_trading_day = false の日（欠けの判定） */
  nonTradingDays: ReadonlySet<string>;
  /** 見出しの Seg（PC は市場の Seg、スマホ・タブレットは [IV 推移 | スマイル | 先物]。どれも選ばない） */
  seg: ComponentChildren;
  onClose: () => void;
}

const NO_BARS: never[] = [];
type Pane = 'price' | 'iv';

/**
 * 銘柄の推移（#319。docs/design.md 13.4）: 見出し行（タイトル・銘柄・Seg・ⓘ・×）→ ツールの行（足・ローソク / 線・⟳）→
 * 読み取りの 2 行 → 値段の段（mid・bid / ask の帯・約定の点・建値の線）→ IV の段（気配の IV の線・約定 IV の点）→ 凡例。
 * 2 段は同じ表示範囲と十字線の足を持ち、横線と縦軸の札は触っている段だけ（先物推移の段と同じ作法）。表示範囲・カーソルは
 * ここのローカル（NextApp が銘柄 × 足を key にして作り直す = 開くたびに右端）。表示モデルは ui/view/optHistory.ts。
 */
function OptHistoryView(p: OptHistoryProps) {
  const { target, ctl } = p;
  const { tf, entry } = ctl;
  const data = entry?.data ?? null;
  const raw = data?.bars ?? NO_BARS;
  const plot = useMemo(() => optPlotBars(raw), [raw]);
  const { price, skip, iv, ivSkip } = plot;
  const segments = useMemo(
    () => optSegments(price, skip, tf, p.nonTradingDays),
    [price, skip, tf, p.nonTradingDays],
  );
  const ivSegments = useMemo(
    () => optSegments(iv, ivSkip, tf, p.nonTradingDays),
    [iv, ivSkip, tf, p.nonTradingDays],
  );
  const bands = useMemo(() => [optBand(raw)], [raw]);
  const marks = useMemo(() => [optTradeMarks(raw)], [raw]);
  const ivMarks = useMemo(() => [optTradeIvMarks(raw)], [raw]);
  const level = useMemo(() => optEntryLevel(target), [target]);
  const [vp, setVp] = useState<{ bars: unknown; v: Domain | null }>({ bars: null, v: null });
  // 足の並びが変わったら（読み込み・⟳・足の切替）右端の初期表示に戻す
  const explicit = vp.bars === price ? vp.v : null;
  const viewport = useMemo(
    () => resolveIvViewport(price, tf, explicit, null, 0),
    [price, tf, explicit],
  );
  const onViewport = useMemo(() => (v: Domain | null) => setVp({ bars: price, v }), [price]);
  const [cur, setCur] = useState<{
    bars: unknown;
    i: number;
    y: number | null;
    pane: Pane;
  } | null>(null);
  const live = cur && cur.bars === price ? cur : null;
  const shown = ivCursorShown(live?.i ?? null, price.length, viewport);
  const onCursorOf = (pane: Pane) => (i: number | null, y?: number | null) =>
    setCur(i === null ? null : { bars: price, i, y: y ?? null, pane });
  const onPriceCursor = useMemo(() => onCursorOf('price'), [price]);
  const onIvCursor = useMemo(() => onCursorOf('iv'), [price]);
  const ro = optReadout(raw, tf, optReadoutIndex(raw.length, shown, viewport), target);
  const loading = entry?.status === 'loading';
  const failed = entry?.status === 'failed';
  const status = !data
    ? failed
      ? 'failed'
      : 'loading'
    : failed
      ? 'failed'
      : raw.length === 0
        ? 'empty'
        : 'ready';
  const lastAt = optLastAtText(data?.lastAt ?? null);
  const name = optName(target);

  return (
    <>
      <PanelHead title="銘柄の推移" titleHidden sub={optTitle(target)}>
        {p.seg}
        <Popover label="銘柄の推移の操作" button={<Icon name="info" />}>
          <p>{OPT_HINT}</p>
          <p>{OPT_NOTE}</p>
          <ManualLinks place="optHistory" />
        </Popover>
        <button
          type="button"
          class="btn ghost icon sm opt-close"
          aria-label={`${name} の推移を閉じる`}
          title="閉じる（Esc）"
          onClick={p.onClose}
        >
          <Icon name="close" />
        </button>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div class="panel-body market-body" tabIndex={-1} role="group" aria-label={OPT_FOCUS_LABEL}>
        <div class="iv-tools">
          <Seg label="足" value={tf} options={OPT_TFS} onChange={ctl.setTf} />
          <Seg label="表示の形" value={ctl.mode} options={IV_MODES} onChange={ctl.setMode} />
          <span class="spacer" />
          <button
            type="button"
            class="btn ghost icon sm iv-refresh"
            aria-label="読み直す"
            title="読み直す"
            disabled={loading}
            onClick={ctl.refresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
        <div class="iv-readout opt-readout" aria-live="off">
          <span class="time">{ro.time}</span>
          {ro.quote ? (
            <>
              <span class="v">
                <span class="k">始</span>
                {ro.quote.o}
              </span>
              <span class="v">
                <span class="k">高</span>
                {ro.quote.h}
              </span>
              <span class="v">
                <span class="k">安</span>
                {ro.quote.l}
              </span>
              <span class="v">
                <span class="k">終</span>
                {ro.quote.c}
              </span>
            </>
          ) : (
            raw.length > 0 && <span class="tag noquote">気配なし</span>
          )}
        </div>
        <div class="iv-readout opt-readout sub" aria-live="off">
          <span class="v">
            <span class="k">気配</span>
            {ro.bidAsk}
          </span>
          <span class="v">
            <span class="k">IV</span>
            {ro.iv}
          </span>
          {ro.trade && (
            <span class="v">
              <span class="k">約定</span>
              {ro.trade.price}
              <span class="k at">@</span>
              {ro.trade.iv}
            </span>
          )}
          {ro.vsEntry !== null && (
            <span class="v">
              <span class="k">建値比</span>
              {ro.vsEntry}
            </span>
          )}
        </div>
        <div class="opt-stack">
          <IvPlot
            bars={price}
            tf={tf}
            mode={ctl.mode}
            viewport={viewport}
            segments={segments}
            rightLoaded={false}
            cursor={shown}
            cursorY={live?.pane === 'price' ? live.y : null}
            crossH={live?.pane !== 'iv'}
            leftSlack={0}
            now={null}
            scenario={null}
            status={status}
            failedSide={null}
            busy={loading && data ? 'right' : null}
            onViewport={onViewport}
            onCursor={onPriceCursor}
            onRetry={ctl.retry}
            series={OPT_PRICE_SERIES}
            plotLabel={OPT_PLOT_LABEL}
            imgLabel={OPT_IMG_LABEL}
            skip={skip}
            bands={bands}
            marks={marks}
            level={level}
            emptyText={OPT_EMPTY_TEXT}
          />
          <IvPlot
            bars={iv}
            tf={tf}
            mode="line"
            viewport={viewport}
            segments={ivSegments}
            rightLoaded={false}
            cursor={shown}
            cursorY={live?.pane === 'iv' ? live.y : null}
            crossH={live?.pane === 'iv'}
            leftSlack={0}
            now={null}
            scenario={null}
            status="ready"
            failedSide={null}
            busy={null}
            onViewport={onViewport}
            onCursor={onIvCursor}
            onRetry={ctl.retry}
            series={OPT_IV_SERIES}
            plotLabel={OPT_IV_PLOT_LABEL}
            imgLabel={OPT_IV_IMG_LABEL}
            skip={ivSkip}
            marks={ivMarks}
          />
        </div>
        <div class="iv-legend">
          <span class="line">
            mid<span class="long">（気配の中値・円）</span>
          </span>
          <span class="band">▮ 気配</span>
          <span class="trade">● 約定</span>
          {level && <span class="entry">┄ 建値</span>}
          {lastAt && <span class="last">{lastAt}</span>}
        </div>
      </div>
    </>
  );
}

export const OptHistory = pure(OptHistoryView);

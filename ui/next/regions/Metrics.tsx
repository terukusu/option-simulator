import { Fragment } from 'preact';
import { useId, useState } from 'preact/hooks';
import { pure } from '../../components/pure';
import type { MetricsModel } from '../../view/metrics';
import {
  METRICS_EMPTY_TEXT,
  type MetricTile,
  metricsPanel,
  TAIL_HINT,
  type TailCellView,
  UNIT_HINT,
} from '../../view/metricsPanel';
import { PanelHead } from '../PanelHead';
import { FullText } from '../parts/FullText';
import { Popover } from '../parts/Popover';

interface Props {
  /** useAppController の metrics（metricsModel の出力。呼び直さない） */
  model: MetricsModel;
  /** state.feePerLot（表示だけ。入力は #87 の設定） */
  feePerLot: number;
}

/**
 * タイル（§5 の .tile）。6 枚とも押せて、タップ / Enter / Space で全文のポップオーバー（#107。中身は表示モデルの full）。
 * 外側の div は格子の 1 枠（余白・背景はボタン .tile-btn）。ボタンの中は phrasing content だけ（span）。
 */
function Tile({ t }: { t: MetricTile }) {
  return (
    <div class="tile" data-tile={t.key}>
      <Popover
        buttonClass="tile-btn"
        within=".panel-body"
        button={
          <>
            <span class="k">{t.k}</span>
            <span class={t.tone ? `v ${t.tone}` : 'v'}>
              <span>{t.v}</span>
              {t.unit && <small>{t.unit}</small>}
            </span>
            <span class="s">{t.s}</span>
          </>
        }
      >
        <FullText rows={t.full} />
      </Popover>
    </div>
  );
}

/** テール表のセル: 損益の大きさのバー（SVG の rect の width 属性。style を使わない）+ 損益と倍率 */
function TailCell({ c }: { c: TailCellView }) {
  return (
    <td class={c.tone ? `bar ${c.tone}` : 'bar'}>
      {c.bar && (
        <svg
          class="barfill"
          viewBox="0 0 100 1"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <rect class={c.bar.tone} x="0" y="0" width={c.bar.width} height="1" />
        </svg>
      )}
      {/* 主の文字列と倍率は別の行（直下にテキストを置かない = 1 行ずつ） */}
      <span class="txt">
        <span>{c.pnl}</span>
        <small>{c.ratio}</small>
      </span>
    </td>
  );
}

/**
 * 指標 · テール（docs/ui-redesign.md §2・§3・§5・§5.2・§9。#86）: 見出し行（単位の副題・ⓘ）→ タイル 6 枚 →
 * 「内訳」の折りたたみ（旧画面の指標の全項目。既定は閉・保存しない）→ テール表（損益のバー付き）。
 * 表示モデルは ui/view/metricsPanel.ts。action は dispatch しない（単位・手数料の入力は #87 の設定）。
 */
function MetricsView({ model, feePerLot }: Props) {
  const view = metricsPanel(model, feePerLot);
  const [open, setOpen] = useState(false);
  const kvId = useId();
  return (
    <>
      <PanelHead title="指標 · テール" sub={view.unitSub}>
        <Popover label="金額の単位とテール表" button="ⓘ">
          <p>{UNIT_HINT}</p>
          <p>{TAIL_HINT}</p>
        </Popover>
      </PanelHead>
      <div class="panel-body mx-body">
        {view.empty ? (
          <div class="empty-state">
            <p>{METRICS_EMPTY_TEXT}</p>
          </div>
        ) : (
          <>
            <div class="metric-tiles">
              {view.tiles.map((t) => (
                <Tile t={t} key={t.key} />
              ))}
            </div>
            <button
              type="button"
              class="mx-toggle"
              aria-expanded={open}
              aria-controls={kvId}
              onClick={() => setOpen((v) => !v)}
            >
              <span>内訳</span>
            </button>
            {open && (
              <div id={kvId} class="mx-kv">
                <div class="kv-grid">
                  {view.breakdown.map((r, i) => (
                    // 行は毎回同じ順で作り直す（並べ替えない。見出しが空の続きの行があるので位置を key に）
                    <Fragment key={i}>
                      {r.group ? (
                        <div class="grp">{r.k}</div>
                      ) : (
                        <>
                          <div class="k">{r.k}</div>
                          <div class="v">{r.v}</div>
                        </>
                      )}
                    </Fragment>
                  ))}
                </div>
                <p class="mx-note">{view.breakdownNote}</p>
              </div>
            )}
            <div class="sec-head">
              <h3>テール表</h3>
            </div>
            <p class="mx-note">{view.tailCaption}</p>
            <p class="mx-note">{TAIL_HINT}</p>
            <table class="tail">
              <thead>
                <tr>
                  <th scope="col">原資産</th>
                  <th scope="col">SQ</th>
                  <th scope="col">指定日 + シナリオ</th>
                </tr>
              </thead>
              <tbody>
                {view.tail.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">
                      <span>{r.pct}</span>
                      <small>{r.x}</small>
                    </th>
                    <TailCell c={r.sq} />
                    <TailCell c={r.scenario} />
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}

/** 指標パネル。model（useAppController の useMemo）と feePerLot が変わらなければ描き直さない */
export const Metrics = pure(MetricsView);

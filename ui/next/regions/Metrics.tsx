import { Fragment } from 'preact';
import { useId, useState } from 'preact/hooks';
import { pure } from '../../components/pure';
import { askMarginTail, askTail, askTile, TILE_TOPIC } from '../../view/aiAsk';
import { HINT_TERMS, type TermId, termById } from '../../view/glossary';
import { PANEL_FOCUS_LABEL } from '../../view/keys';
import type { MarginView } from '../../view/margin';
import type { MetricsModel } from '../../view/metrics';
import {
  MARGIN_CALL_MARK,
  MARGIN_HINT,
  MARGIN_TAIL_TITLE,
  METRICS_EMPTY_TEXT,
  type MetricTile,
  metricsPanel,
  TAIL_HINT,
  type TailCellView,
  UNIT_HINT,
} from '../../view/metricsPanel';
import { PanelHead } from '../PanelHead';
import { AskAi } from '../parts/AskAi';
import { FullText } from '../parts/FullText';
import { Icon } from '../parts/Icon';
import { Popover } from '../parts/Popover';
import { TermLinks } from '../parts/TermLinks';
import { openTerm } from '../parts/termCard';
import { type HoldBundle, HoldMap } from './HoldMap';

interface Props {
  /** useAppController の metrics（metricsModel の出力。呼び直さない） */
  model: MetricsModel;
  /** state.feePerLot（表示だけ。入力は #87 の設定） */
  feePerLot: number;
  /** 証拠金の概算（useAppController の useMemo。#131。板が無ければ null） */
  margin: MarginView | null;
  /** 追証マップ（#152。NextApp の useMemo） */
  hold: HoldBundle;
}

/**
 * タイル（§5 の .tile）。6 枚とも押せて、タップ / Enter / Space で全文のポップオーバー（#107。中身は表示モデルの full）。
 * 外側の div は格子の 1 枠（余白・背景はボタン .tile-btn）。ボタンの中は phrasing content だけ（span）。
 * 見出しの行 .kh = 見出し .k + 点の印 .at（#164。必要証拠金・余力だけ。入らなければ .at だけ省略記号）。
 * 全文の末尾に [AI に聞く]（#136。質問の文は押したときに作る）
 */
function Tile({ t, unitSub }: { t: MetricTile; unitSub: string }) {
  return (
    <div class="tile" data-tile={t.key}>
      <Popover
        buttonClass="tile-btn"
        within=".panel-body"
        button={
          <>
            <span class="kh">
              <span class="k">{t.k}</span>
              {t.at && <span class="at">{t.at}</span>}
            </span>
            <span class={t.tone ? `v ${t.tone}` : 'v'}>
              <span>{t.v}</span>
              {t.unit && <small>{t.unit}</small>}
            </span>
            <span class="s">{t.s}</span>
          </>
        }
      >
        <FullText rows={t.full} />
        <div class="pop-ask">
          <AskAi topic={TILE_TOPIC[t.key]} label={t.k} make={() => askTile(t, unitSub)} />
        </div>
      </Popover>
    </div>
  );
}

/** 内訳の見出しのボタン（#167。押すと用語の説明カード。文字・大きさは今の見出しのまま） */
function KvTerm({ k, term }: { k: string; term: TermId }) {
  return (
    <button
      type="button"
      class="kv-term"
      aria-haspopup="dialog"
      aria-label={`${k}（用語: ${termById(term)?.title ?? k}）`}
      onClick={() => openTerm(term)}
    >
      {k}
    </button>
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
 * 指標 · テール（docs/ui-redesign.md §2・§3・§5・§5.2・§9。#86）: 見出し行（単位と「証拠金は概算」の副題・ⓘ）→ タイル 6 枚 →
 * 「内訳」の折りたたみ（旧画面の指標の全項目。既定は閉・保存しない）→ テール表（損益のバー付き。指定日の列の説明は ⓘ だけ。#274）→ テールの証拠金の表 →
 * 「追証マップ」の折りたたみ（#152。regions/HoldMap.tsx。既定は閉・開閉は ShellState）。タイルの全文・2 つの表の見出しの
 * 行に [AI に聞く]（#136）。
 * 表示モデルは ui/view/metricsPanel.ts。action は dispatch しない（単位・手数料の入力は #87 の設定）。
 */
function MetricsView({ model, feePerLot, margin, hold }: Props) {
  const view = metricsPanel(model, feePerLot, margin);
  const [open, setOpen] = useState(false);
  const kvId = useId();
  return (
    <>
      <PanelHead title="指標 · テール" sub={view.headSub}>
        <Popover label="金額の単位・テール表・証拠金" button={<Icon name="info" />}>
          <p>{UNIT_HINT}</p>
          <p>{TAIL_HINT}</p>
          <p>{MARGIN_HINT}</p>
          <TermLinks ids={HINT_TERMS.metrics} />
        </Popover>
      </PanelHead>
      {/* biome-ignore lint/a11y/useSemanticElements: 1〜5 の行き先のスクロールする枠に名前を付ける（fieldset にしない） */}
      <div
        class="panel-body mx-body"
        tabIndex={-1}
        role="group"
        aria-label={PANEL_FOCUS_LABEL.metrics}
      >
        {view.empty ? (
          <div class="empty-state">
            <p>{METRICS_EMPTY_TEXT}</p>
          </div>
        ) : (
          <>
            <div class="metric-tiles">
              {view.tiles.map((t) => (
                <Tile t={t} unitSub={view.unitSub} key={t.key} />
              ))}
            </div>
            <button
              type="button"
              class="mx-toggle"
              aria-expanded={open}
              aria-controls={kvId}
              onClick={() => setOpen((v) => !v)}
            >
              <Icon name="chevron" />
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
                          <div class="k">
                            {r.term === undefined ? r.k : <KvTerm k={r.k} term={r.term} />}
                          </div>
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
              <span class="spacer" />
              <AskAi topic="tail.pnl" label="テール表" make={() => askTail(view)} />
            </div>
            <p class="mx-note">{view.tailCaption}</p>
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
            {view.marginTail.length > 0 && (
              <>
                <div class="sec-head">
                  <h3>{MARGIN_TAIL_TITLE}</h3>
                  <span class="spacer" />
                  <AskAi
                    topic="tail.margin"
                    label={MARGIN_TAIL_TITLE}
                    make={() => askMarginTail(view, MARGIN_TAIL_TITLE)}
                  />
                </div>
                <p class="mx-note">{view.marginTailCaption}</p>
                <table class="tail margin-tail">
                  <thead>
                    <tr>
                      <th scope="col">原資産</th>
                      <th scope="col">必要証拠金</th>
                      <th scope="col">余力</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.marginTail.map((r) => (
                      <tr key={r.key}>
                        <th scope="row">
                          <span>{r.pct}</span>
                          <small>{r.x}</small>
                        </th>
                        <td>
                          <span class="txt">
                            <span>{r.margin}</span>
                          </span>
                        </td>
                        <td class={r.tone ?? undefined}>
                          <span class="txt">
                            <span>{r.room}</span>
                            {r.call && <small class="call">{MARGIN_CALL_MARK}</small>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <HoldMap hold={hold} unit={model.unit} />
          </>
        )}
      </div>
    </>
  );
}

/** 指標パネル。model・margin（useAppController の useMemo）と feePerLot が変わらなければ描き直さない */
export const Metrics = pure(MetricsView);

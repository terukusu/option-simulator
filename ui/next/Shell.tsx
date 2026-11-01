import type { ComponentChildren } from 'preact';
import { useMemo, useRef } from 'preact/hooks';
import {
  DOCK_LABELS,
  dockPanels,
  leftView,
  MARKET_VIEWS,
  marketAttr,
  type PanelId,
  type ShellAction,
  type ShellState,
  SMILE_VIEWS,
  smileView,
  type Tier,
  visiblePanel,
} from '../view/shell';
import { AiIcon } from './parts/AiIcon';
import { Seg } from './parts/Seg';

/**
 * ドックのボタンのアイコン（スマホだけ。文字と読み上げの名前は ui/view/shell.ts の DOCK_LABELS）。smile（IV）は推移の
 * 折れ線の SVG（#130。字形は OS で絵文字になり currentColor に従わないものがある。色は押されたときも currentColor）
 */
const DOCK_IC: Record<PanelId, ComponentChildren> = {
  positions: '≡',
  board: '▤',
  scenario: '◐',
  metrics: 'Σ',
  smile: (
    <svg class="ic-line" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <polyline
        points="2,13 6,8 9,11 13,4 16,7"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  ),
  // AI（#135）: 吹き出しの SVG（トップバーの [AI] と共用。#280）
  ai: <AiIcon />,
};

/**
 * 本体の骨組み（docs/ui-redesign.md §2。状態は ui/view/shell.ts）。3 段階のグリッド・ドック・スマホのシート。
 * 舞台（凡例行 + .panel-body）は #82 の regions/Stage.tsx を stage で、シナリオ（見出し行 + .panel-body）は #83 の
 * regions/Scenario.tsx を scenario で、ポジション（見出し行 + .panel-body）は #84 の regions/Positions.tsx を positions で、
 * 指標 · テール（見出し行 + .panel-body）は #86 の regions/Metrics.tsx を metrics で受ける。
 * 板・スマイル（見出し行 + .panel-body）は #85 の regions/Board.tsx・Smile.tsx を board / smile で受ける。
 * PC の見出しの市場の Seg（MARKET_VIEWS）はここで作って渡す（板・スマイルの見出し行の子。他の段階は null）。
 * スマホ・タブレットのスマイル（ドックの「IV」）のパネルには [IV 推移 | スマイル | 先物]（SMILE_VIEWS。#79・#130・#190）を渡す
 * （板は null のまま）。IV 推移は section.smile の領域に描く（中身は呼び出し側が smileView(state, tier) で選ぶ）。
 * 出し分けは .layout の data-panel・data-sheet・data-market と CSS（style 属性を使わない）。
 * #135 で AI のチャット（regions/AiChat.tsx）を ai で受ける: スマホ・タブレットはドックの 6 つ目 / 5 つ目のパネル、
 * PC は左の列（市場: 板 / スマイル / IV 推移 / 先物）を入れ替える（#280。data-left = ShellState.left。#135 では作業台の
 * 列を入れ替えていた）。舞台・ポジション・指標は常に見える。
 */
export function Shell(p: {
  tier: Tier;
  state: ShellState;
  send: (a: ShellAction) => void;
  legCount: number;
  /** 舞台の中身（凡例行 + .panel-body。#82） */
  stage: ComponentChildren;
  /** シナリオの中身（見出し行 + .panel-body。#83） */
  scenario: ComponentChildren;
  /** ポジションの中身（見出し行 + .panel-body。#84） */
  positions: ComponentChildren;
  /** 指標 · テールの中身（見出し行 + .panel-body。#86） */
  metrics: ComponentChildren;
  /**
   * 板・スマイル（IV 推移）の中身（見出し行 + .panel-body。#85・#79）。引数は見出しに置く Seg（PC は市場の Seg、
   * スマイルのパネルは PC 以外で [IV 推移 | スマイル]、板は PC 以外で null）
   */
  board: (marketSeg: ComponentChildren) => ComponentChildren;
  smile: (marketSeg: ComponentChildren) => ComponentChildren;
  /** AI のチャット（見出し行 + .panel-body + 入力。#135） */
  ai: ComponentChildren;
}) {
  const { tier, state, send } = p;
  const panel = visiblePanel(state, tier);
  // つまみはスマホで、見えているシートの先頭に 1 つだけ
  const grabber = (id: PanelId) =>
    tier === 'phone' && panel === id && state.sheet !== 'hidden' ? (
      <Grabber onGrab={(dy) => send({ type: 'grab', dy })} />
    ) : null;
  // 市場の Seg は同じ要素を使い回す（板・スマイルの領域の pure を効かせる）
  const { market } = state;
  // 銘柄の推移（#319）を開いている間はどれも選ばない（押すと推移を閉じてその見え方へ）
  const optOpen = state.opt !== undefined;
  const marketSeg = useMemo(
    () =>
      tier === 'pc' ? (
        <Seg
          label="市場"
          value={optOpen ? null : market}
          options={MARKET_VIEWS}
          onChange={(m) => send({ type: 'market', market: m })}
        />
      ) : null,
    [tier, market, optOpen, send],
  );
  const smileValue = smileView(state, tier);
  const smileSeg = useMemo(
    () =>
      tier === 'pc' ? (
        marketSeg
      ) : (
        <Seg
          label="IV 推移 / スマイル / 先物"
          value={smileValue === 'opt' ? null : smileValue}
          options={SMILE_VIEWS}
          onChange={(m) => send({ type: 'market', market: m })}
        />
      ),
    [tier, marketSeg, smileValue, send],
  );
  const dock = dockPanels(tier);
  return (
    <main
      class="layout"
      data-panel={panel}
      data-sheet={state.sheet}
      data-market={marketAttr(state)}
      data-left={leftView(state)}
    >
      <section class="stage panel" aria-label="損益グラフ">
        {p.stage}
      </section>
      <section class="scenario panel" aria-label="シナリオ">
        {grabber('scenario')}
        {p.scenario}
      </section>
      <section class="panel side positions" aria-label="ポジション">
        {grabber('positions')}
        {p.positions}
      </section>
      <section class="panel side metrics" aria-label="指標 · テール">
        {grabber('metrics')}
        {p.metrics}
      </section>
      <section class="market panel side board" aria-label="板">
        {grabber('board')}
        {p.board(marketSeg)}
      </section>
      <section
        class="market panel side smile"
        aria-label={
          smileValue === 'iv'
            ? 'IV 推移'
            : smileValue === 'fut'
              ? '先物推移'
              : smileValue === 'opt'
                ? '銘柄の推移'
                : 'スマイル'
        }
      >
        {grabber('smile')}
        {p.smile(smileSeg)}
      </section>
      <section class="panel side ai" aria-label="AI">
        {grabber('ai')}
        {p.ai}
      </section>
      {dock.length > 0 && (
        <nav class="dock" aria-label="パネル">
          {dock.map((id) => {
            const d = DOCK_LABELS[id];
            const badge = id === 'positions' && p.legCount > 0 ? p.legCount : null;
            return (
              <button
                type="button"
                key={id}
                data-panel={id}
                aria-pressed={panel === id && (tier !== 'phone' || state.sheet !== 'hidden')}
                aria-label={badge === null ? d.name : `${d.name}（${badge} 本）`}
                onClick={() => send({ type: 'dock', panel: id, tier })}
              >
                <span class="ic" aria-hidden="true">
                  {DOCK_IC[id]}
                </span>
                <span class="lbl">{d.text}</span>
                {badge !== null && (
                  <span class="cnt" aria-hidden="true">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}
    </main>
  );
}

/**
 * シートのつまみ。指に追従させず、離したときの縦の移動量で段階を決める（ui/view/shell.ts の grab）。
 * キーボードの Enter / Space はタップ（peek ⇄ full）。
 */
function Grabber({ onGrab }: { onGrab: (dy: number) => void }) {
  const start = useRef<number | null>(null);
  return (
    <button
      type="button"
      class="grabber"
      aria-label="シートの高さ"
      title="シートの高さ（タップで切替・上下にドラッグ）"
      onPointerDown={(e) => {
        start.current = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        const y0 = start.current;
        start.current = null;
        if (y0 !== null) onGrab(e.clientY - y0);
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onClick={(e) => {
        // ポインタの操作は pointerup で済んでいる。キーボード（detail = 0）だけここで
        if (e.detail === 0) onGrab(0);
      }}
    />
  );
}

import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import {
  dockPanels,
  type PanelId,
  type ShellAction,
  type ShellState,
  type Tier,
  visiblePanel,
} from '../view/shell';
import { PanelHead } from './PanelHead';
import { Seg } from './parts/Seg';

/** ドックのボタン（ラベルは短く。アイコンはスマホだけ） */
const DOCK: Record<PanelId, { text: string; name: string; ic: string }> = {
  positions: { text: 'ポジ', name: 'ポジション', ic: '≡' },
  board: { text: '板', name: '板', ic: '▤' },
  scenario: { text: 'シナリオ', name: 'シナリオ', ic: '◐' },
  metrics: { text: '指標', name: '指標', ic: 'Σ' },
  smile: { text: 'スマイル', name: 'スマイル', ic: '◡' },
};

const MARKET_OPTIONS = [
  { value: 'board', text: '板' },
  { value: 'smile', text: 'スマイル' },
] as const;

/**
 * 本体の骨組み（docs/ui-redesign.md §2。状態は ui/view/shell.ts）。3 段階のグリッド・ドック・スマホのシート。
 * 舞台（凡例行 + .panel-body）は #82 の regions/Stage.tsx を stage で、シナリオ（見出し行 + .panel-body）は #83 の
 * regions/Scenario.tsx を scenario で、ポジション（見出し行 + .panel-body）は #84 の regions/Positions.tsx を positions で、
 * 指標 · テール（見出し行 + .panel-body）は #86 の regions/Metrics.tsx を metrics で受ける。
 * 他の領域は見出し行だけ（#85 が入れる）。
 * 出し分けは .layout の data-panel・data-sheet・data-market と CSS（style 属性を使わない）。
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
}) {
  const { tier, state, send } = p;
  const panel = visiblePanel(state, tier);
  // つまみはスマホで、見えているシートの先頭に 1 つだけ
  const grabber = (id: PanelId) =>
    tier === 'phone' && panel === id && state.sheet !== 'hidden' ? (
      <Grabber onGrab={(dy) => send({ type: 'grab', dy })} />
    ) : null;
  const marketSeg =
    tier === 'pc' ? (
      <Seg
        label="市場"
        value={state.market}
        options={MARKET_OPTIONS}
        onChange={(market) => send({ type: 'market', market })}
      />
    ) : null;
  const dock = dockPanels(tier);
  return (
    <main class="layout" data-panel={panel} data-sheet={state.sheet} data-market={state.market}>
      <section class="stage panel" aria-label="損益グラフ">
        {p.stage}
      </section>
      <section class="scenario panel" aria-label="シナリオ">
        {grabber('scenario')}
        {p.scenario}
      </section>
      <section class="bench panel side positions" aria-label="ポジション">
        {grabber('positions')}
        {p.positions}
      </section>
      <section class="bench panel side metrics" aria-label="指標 · テール">
        {grabber('metrics')}
        {p.metrics}
      </section>
      <section class="market panel side board" aria-label="板">
        {grabber('board')}
        <PanelHead title="板">{marketSeg}</PanelHead>
        <div class="panel-body" />
      </section>
      <section class="market panel side smile" aria-label="スマイル">
        {grabber('smile')}
        <PanelHead title="スマイル">{marketSeg}</PanelHead>
        <div class="panel-body" />
      </section>
      {dock.length > 0 && (
        <nav class="dock" aria-label="パネル">
          {dock.map((id) => {
            const d = DOCK[id];
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
                  {d.ic}
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

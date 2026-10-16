import type { ComponentChildren } from 'preact';

/** 領域の見出し行（.panel-head。高さ 40 / スマホ 36px）。メニュー・ポップオーバーはここかトップバーに置く */
export function PanelHead(p: { title: string; sub?: string; children?: ComponentChildren }) {
  return (
    <div class="panel-head">
      <h2>{p.title}</h2>
      {p.sub && <span class="sub">{p.sub}</span>}
      <span class="spacer" />
      {p.children}
    </div>
  );
}

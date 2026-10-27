import type { ComponentChildren } from 'preact';

/**
 * 領域の見出し行（.panel-head。高さ 40 / スマホ 36px）。メニュー・ポップオーバーはここかトップバーに置く。
 * titleHidden: 見出しの文字を読み上げだけに残す（.sr）。見出し行の Seg の選択が見出しを兼ねる領域（スマイル。#279 D-06）
 */
export function PanelHead(p: {
  title: string;
  sub?: string;
  titleHidden?: boolean;
  children?: ComponentChildren;
}) {
  return (
    <div class="panel-head">
      <h2 class={p.titleHidden ? 'sr' : undefined}>{p.title}</h2>
      {p.sub && <span class="sub">{p.sub}</span>}
      <span class="spacer" />
      {p.children}
    </div>
  );
}

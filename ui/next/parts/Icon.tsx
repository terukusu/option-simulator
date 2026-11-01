import type { ComponentChildren } from 'preact';

/**
 * ボタンの記号のアイコン（#292。docs/ui-redesign.md §5・§10.1）。記号を文字（⟳ ⟲ ＋ − × ⋯ ⇄ ⓘ ☾ ▸）で描くと
 * OS・フォントで太さ・位置がそろわず、絵文字になって currentColor に従わないものがあるので、18 の格子の SVG で描く。
 * 色は currentColor だけ（親のボタンの文字色・:hover・:disabled の opacity に従う）、読み上げない（名前は親の
 * aria-label / title）。大きさは CSS（.ic。parts.css の「アイコン」）。折りたたみの印は chevron を CSS で 90° 回す。
 * 吹き出し・推移の折れ線は既存の .ic-line（AiIcon・Shell の DOCK_IC）
 */
export const ICON_NAMES = [
  'refresh',
  'reset',
  'plus',
  'minus',
  'close',
  'more',
  'swap',
  'info',
  'moon',
  'chevron',
  'back',
  'chart',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const DOT = { fill: 'currentColor', stroke: 'none' } as const;

const PATHS: Record<IconName, ComponentChildren> = {
  // ⟳ 時計回り（最新化）
  refresh: (
    <>
      <path d="M15 9a6 6 0 1 1-1.76-4.24L15 6" />
      <path d="M15 2.5V6h-3.5" />
    </>
  ),
  // ⟲ 反時計回り（元に戻す）= refresh の左右反転
  reset: (
    <>
      <path d="M3 9a6 6 0 1 0 1.76-4.24L3 6" />
      <path d="M3 2.5V6h3.5" />
    </>
  ),
  plus: <path d="M9 3.5v11M3.5 9h11" />,
  minus: <path d="M3.5 9h11" />,
  close: <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" />,
  more: (
    <>
      <circle cx="4" cy="9" r="1.4" {...DOT} />
      <circle cx="9" cy="9" r="1.4" {...DOT} />
      <circle cx="14" cy="9" r="1.4" {...DOT} />
    </>
  ),
  // ⇄ 売り買いの入れ替え
  swap: (
    <>
      <path d="M3.5 6.5h11M11.5 3.5l3 3-3 3" />
      <path d="M14.5 11.5h-11M6.5 8.5l-3 3 3 3" />
    </>
  ),
  // i の字（丸い枠は .hintbtn の border）。小さく描くので線を太く
  info: (
    <>
      <circle cx="9" cy="4.8" r="1.3" {...DOT} />
      <path d="M9 8v5.5" stroke-width="2" />
    </>
  ),
  moon: <path d="M15 10.2A6.25 6.25 0 1 1 7.8 3a4.9 4.9 0 0 0 7.2 7.2z" />,
  // ▸ 折りたたみの印（開いたら CSS で 90°）
  chevron: <path d="M7 4.5l4.5 4.5L7 13.5" />,
  // ← 1 つ前に戻る（説明カードの見出し。#320 第 2 弾）
  back: <path d="M14.5 9h-11M7.5 5l-4 4 4 4" />,
  // 推移の折れ線（#319。銘柄の推移を開く）: 軸の L と折れ線
  chart: (
    <>
      <path d="M3 3v12h12" />
      <path d="M5.5 11.5l3-3.5 2.5 2 4-5" />
    </>
  ),
};

export function Icon(p: { name: IconName }) {
  return (
    <svg
      class={`ic ic-${p.name}`}
      viewBox="0 0 18 18"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {PATHS[p.name]}
    </svg>
  );
}

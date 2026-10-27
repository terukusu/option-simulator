import type { ComponentChildren } from 'preact';

/**
 * チップ（docs/ui-redesign.md §5）。pressed を渡せばトグル（aria-pressed）、渡さなければ 1 回の操作。
 * 高さ 28px、丸い、折り返さない。warn = 絞り込み中など注意の色のトグル。
 */
export function Chip(p: {
  text: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
  warn?: boolean;
  /** aria-label（文字を短くしたときの全文。省略時は属性を出さない。#85） */
  label?: string;
}) {
  return (
    <button
      type="button"
      class={p.warn ? 'chip warn' : 'chip'}
      aria-pressed={p.pressed}
      aria-label={p.label}
      disabled={p.disabled}
      title={p.title}
      onClick={p.onClick}
    >
      {p.text}
    </button>
  );
}

/**
 * チップの行（overflow-x: auto、スクロールバー非表示。折り返さない）。例外: AI の定型の質問の行は ui/next/css/ai.css で
 * 折り返す（#277。全部を見せる。チップの文字は折らない）
 */
export function ChipRow(p: { label: string; children: ComponentChildren }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"
    <div class="chiprow" role="group" aria-label={p.label}>
      {p.children}
    </div>
  );
}

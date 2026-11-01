/**
 * セグメント（2〜3 択の排他。docs/ui-redesign.md §5）。role="group" + aria-label、ボタンは aria-pressed。
 * 高さ 26px、折り返さない（入らなければ呼び出し側で ⋯ メニューへ退避）。
 */

export interface SegOption<T extends string> {
  value: T;
  text: string;
  title?: string;
  disabled?: boolean;
  /** ボタンの aria-label（文字を短くしたときの全文。#84） */
  label?: string;
}

export function Seg<T extends string>(p: {
  label: string;
  /** 選んでいる値（null = どれも選ばない。#319 銘柄の推移を開いている間の市場の Seg） */
  value: T | null;
  onChange: (v: T) => void;
  options: readonly SegOption<T>[];
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset は既定の枠・余白と flex の癖があるので div + role="group"
    <div class="seg" role="group" aria-label={p.label}>
      {p.options.map((o) => (
        <button
          type="button"
          key={o.value}
          aria-pressed={o.value === p.value}
          title={o.title}
          aria-label={o.label}
          disabled={o.disabled}
          onClick={() => {
            if (o.value !== p.value) p.onChange(o.value);
          }}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

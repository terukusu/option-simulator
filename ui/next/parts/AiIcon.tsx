/**
 * AI の吹き出しのアイコン（#135 のドックの AI。#280 でトップバーの [AI] のトグルと共用）。字形の絵文字にしない
 * （OS で絵文字になり currentColor に従わないものがある）。大きさは CSS（.ic-line）
 */
export function AiIcon() {
  return (
    <svg class="ic-line" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <path
        d="M3 4.5h12v7.5H8l-3.5 3v-3H3z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/**
 * 画面の入口の分岐（#81。docs/ui-redesign.md §10.1・§11 の方針 A）。
 * 新しい画面は `?ui=next` でだけ開く（全部そろったら #91 で既定に切り替える）。
 */

export type UiVariant = 'next' | 'legacy';

/** クエリの `ui` がちょうど `next` のときだけ新しい画面（大文字・他の値・無しは旧画面）。 */
export function uiVariant(search: string): UiVariant {
  return new URLSearchParams(search).get('ui') === 'next' ? 'next' : 'legacy';
}

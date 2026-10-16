/**
 * メニューのキー移動（#81。docs/ui-redesign.md §5）。部品は ui/next/parts/Menu.tsx。
 * ↑↓ は 1 つずつ（端で回る）、Home / End は最初 / 最後。無効な項目は飛ばす。
 */

export type MenuKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isMenuKey(key: string): key is MenuKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
}

/** 次にフォーカスする項目の位置。index = 今の位置（-1 = どこにも無い）。有効な項目が無ければ -1。 */
export function menuMove(disabled: readonly boolean[], index: number, key: MenuKey): number {
  const n = disabled.length;
  const enabled = (i: number) => disabled[i] === false;
  if (key === 'Home' || key === 'End') {
    const dir = key === 'Home' ? 1 : -1;
    for (let k = 0, i = key === 'Home' ? 0 : n - 1; k < n; k++, i += dir) {
      if (enabled(i)) return i;
    }
    return -1;
  }
  const dir = key === 'ArrowDown' ? 1 : -1;
  const from = index >= 0 && index < n ? index : dir > 0 ? -1 : n;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (enabled(i)) return i;
  }
  return -1;
}

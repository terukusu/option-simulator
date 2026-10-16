import type { ThemePref } from '../prefs';
import { Menu, type MenuItem } from './parts/Menu';

const THEME_ITEMS: readonly { theme: ThemePref; label: string }[] = [
  { theme: 'auto', label: '端末に合わせる' },
  { theme: 'dark', label: 'ダーク' },
  { theme: 'light', label: 'ライト' },
];

/**
 * トップバー（docs/ui-redesign.md §2.1）。#81 の時点はブランド・[最新]・テーマのメニューだけ
 * （BOX タブ・市場ピル・⋯ は #87）。
 */
export function TopBar(p: {
  loading: boolean;
  onLatest: () => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
}) {
  const items: MenuItem[] = THEME_ITEMS.map((t) => ({
    key: t.theme,
    label: t.label,
    checked: p.theme === t.theme,
    onSelect: () => p.onTheme(t.theme),
  }));
  return (
    <header class="top">
      <h1 class="brand">OP Simulator</h1>
      <span class="spacer" />
      <button
        type="button"
        class="btn sm"
        disabled={p.loading}
        title="API から板を読み直す"
        onClick={() => p.onLatest()}
      >
        最新
      </button>
      <Menu label="テーマ" button="☾" items={items} />
    </header>
  );
}

/**
 * 画面の入口（docs/ui-redesign.md §10.1）。#91 で既定を新しい画面に切り替え、旧画面を削除した: クエリ `ui` はどの値でも
 * 見ない（古い `?ui=next`・`?ui=legacy` も同じ画面）。部品は表示モデル（ui/view/ の純関数）を描くだけ。板・入力値は
 * JSX のテキスト / 属性で入れる（HTML 文字列を DOM に入れる API・style 属性を使わない。CSP script-src 'self'）。
 * CSS は ui/next/main.tsx の import だけ（ビルドでは Vite が head に link を出す。ui/index.html に link を書かない）。
 */

import type { Boot } from './components/useAppController';
import { mount } from './next/main';
import { readWorkspace, WORKSPACE_KEY } from './persist';
import { PREFS_KEY, readPrefs, resolveTheme } from './prefs';
import { getStorage, readKey } from './storage';

const root = document.getElementById('app');
if (root) {
  // 保存した作業は板を読む前に 1 回だけ読む（初期 state に入れる。ちらつかない。#23）
  const storage = getStorage();
  const read = readWorkspace(readKey(storage, WORKSPACE_KEY));
  const boot: Boot = { storage, read };
  const prefs = readPrefs(readKey(storage, PREFS_KEY));
  const prefersLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  // テーマは描く前に入れる（ちらつかない）
  document.documentElement.dataset.theme = resolveTheme(prefs.prefs.theme, prefersLight);
  mount(root, boot, prefs);
}

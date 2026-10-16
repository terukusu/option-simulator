/**
 * 画面の入口（縦切り 1c: ヘッダ・板・スマイル・ポジション）。設計 docs/design.md 6.1。
 * 部品は表示モデル（ui/view/ の純関数）を描くだけ。板・入力値は JSX のテキスト / 属性で入れる
 * （HTML 文字列を DOM に入れる API・style 属性を使わない。CSP script-src 'self'）。
 *
 * `?ui=next` は再設計の新しい画面（#81。docs/ui-redesign.md §10.1）。ui/next/ を動的に import し、
 * 旧 CSS（index.html の link）を無効にする。それ以外は今までどおり旧画面（App）。
 */

import { render } from 'preact';
import { App, type Boot } from './components/App';
import { uiVariant } from './entry';
import { readWorkspace, WORKSPACE_KEY } from './persist';
import { PREFS_KEY, readPrefs, resolveTheme } from './prefs';
import { getStorage, readKey } from './storage';

/** 新しい画面を描く。チャンクを読めなければ旧画面のまま描く（真っ白にしない） */
function startNext(root: HTMLElement, boot: Boot): void {
  // 旧 CSS は起動時にある link だけ（新しい CSS の link は import の補助が後から足す）
  const legacy = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
  const prefs = readPrefs(readKey(boot.storage, PREFS_KEY));
  const prefersLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  // テーマは描く前に入れる（ちらつかない）。旧 CSS は data-theme を使わない
  const html = document.documentElement;
  html.dataset.theme = resolveTheme(prefs.prefs.theme, prefersLight);
  import('./next/main').then(
    ({ mount }) => {
      // 新しい CSS が読めてから旧 CSS を外す（先に外すと素の白い下地が出る。#91 で消す暫定）
      for (const link of legacy) link.disabled = true;
      mount(root, boot, prefs);
    },
    () => {
      delete html.dataset.theme;
      render(<App boot={boot} />, root);
    },
  );
}

const root = document.getElementById('app');
if (root) {
  // 保存した作業は板を読む前に 1 回だけ読む（App が初期 state に入れる。ちらつかない。#23）
  const storage = getStorage();
  const read = readWorkspace(readKey(storage, WORKSPACE_KEY));
  const boot: Boot = { storage, read };
  if (uiVariant(window.location.search) === 'next') startNext(root, boot);
  else render(<App boot={boot} />, root);
}

/**
 * 新しい画面（`?ui=next`）の入口（#81。docs/ui-redesign.md §10.1）。ui/main.tsx が動的に import する
 * （旧画面ではこのチャンクも next.css も読まない）。next.css は旧 CSS と排他（旧 CSS は ui/main.tsx が無効にする）。
 */

import { render } from 'preact';
import type { Boot } from '../components/useAppController';
import type { PrefsRead } from '../prefs';
import './next.css';
import { NextApp } from './NextApp';

export function mount(root: HTMLElement, boot: Boot, prefs: PrefsRead): void {
  // 部品の見本（`?ui=next&parts`）は dev だけ（本番のビルドでは分岐ごと消える）
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('parts')) {
    void import('./dev/PartsGallery').then(({ PartsGallery }) => render(<PartsGallery />, root));
    return;
  }
  render(<NextApp boot={boot} prefs={prefs} />, root);
}

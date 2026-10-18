/**
 * 画面の mount（#81。docs/ui-redesign.md §10.1）。ui/main.tsx が静的に import する（#91 から唯一の画面。CSS は next.css だけ）。
 */

import { render } from 'preact';
import type { Boot } from '../components/useAppController';
import type { PrefsRead } from '../prefs';
import './next.css';
import { NextApp } from './NextApp';

export function mount(root: HTMLElement, boot: Boot, prefs: PrefsRead): void {
  // 部品の見本（`?parts`。古い `?ui=next&parts` も）は dev だけ（本番のビルドでは分岐ごと消える）
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('parts')) {
    void import('./dev/PartsGallery').then(({ PartsGallery }) => render(<PartsGallery />, root));
    return;
  }
  render(<NextApp boot={boot} prefs={prefs} />, root);
}

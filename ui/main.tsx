/**
 * 画面の入口（縦切り 1c: ヘッダ・板・スマイル・ポジション）。設計 docs/design.md 6.1。
 * 部品は表示モデル（ui/view/ の純関数）を描くだけ。板・入力値は JSX のテキスト / 属性で入れる
 * （HTML 文字列を DOM に入れる API・style 属性を使わない。CSP script-src 'self'）。
 */

import { render } from 'preact';
import { App } from './components/App';
import { readWorkspace, WORKSPACE_KEY } from './persist';
import { getStorage, readKey } from './storage';

const root = document.getElementById('app');
if (root) {
  // 保存した作業は板を読む前に 1 回だけ読む（App が初期 state に入れる。ちらつかない。#23）
  const storage = getStorage();
  const read = readWorkspace(readKey(storage, WORKSPACE_KEY));
  render(<App boot={{ storage, read }} />, root);
}

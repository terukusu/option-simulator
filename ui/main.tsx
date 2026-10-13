/**
 * 画面の入口（縦切り 1c: ヘッダ・板・スマイル・ポジション）。設計 docs/design.md 6.1。
 * 部品は表示モデル（ui/view/ の純関数）を描くだけ。板・入力値は JSX のテキスト / 属性で入れる
 * （HTML 文字列を DOM に入れる API・style 属性を使わない。CSP script-src 'self'）。
 */

import { render } from 'preact';
import { App } from './components/App';

const root = document.getElementById('app');
if (root) render(<App />, root);

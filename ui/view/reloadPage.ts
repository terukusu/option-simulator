/**
 * ページを読み直すボタンの文字（#341。docs/ui-redesign.md §10.1「PWA」）。
 * ホーム画面のアプリ（display: standalone）にはブラウザの再読み込みのボタンが無いため、ログイン切れの知らせに出す。
 * 銘柄の推移の ⟳（データの読み直し）と区別するため「ページを」を付ける。知らせの文は REF でこのボタンを指す。
 */
export const RELOAD_PAGE_LABEL = 'ページを読み直す';
/** 文の中でボタンを指す形 */
export const RELOAD_PAGE_REF = `[${RELOAD_PAGE_LABEL}]`;
/** ボタンの title（補足。名前は見える文字のまま） */
export const RELOAD_PAGE_TITLE = 'ページを読み直してログインし直す';
/** 板の読み込みのログイン切れ（ChainLoadError の auth）の文（ui/load.ts の describeLoadError・部品の見本） */
export const AUTH_EXPIRED_TEXT = `ログインが切れた（${RELOAD_PAGE_REF} でログインし直す）`;

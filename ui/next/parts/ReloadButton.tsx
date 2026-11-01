import { RELOAD_PAGE_LABEL, RELOAD_PAGE_TITLE } from '../../view/reloadPage';

/**
 * ページを読み直す（#341。docs/ui-redesign.md §10.1「PWA」）。ホーム画面のアプリ（display: standalone）には
 * ブラウザの再読み込みのボタンが無いため、ログイン切れの知らせ（板の読み込み・AI）に出す。同じ URL の再読み込みだけで、
 * URL を受け取らない・組み立てない（IAP が切れていれば Google のログインを経て開き直す。作業は pagehide で保存済み）。
 */
export const reloadPage = (): void => location.reload();

export function ReloadButton(p: { reload?: () => void; class?: string }) {
  const run = p.reload ?? reloadPage;
  return (
    <button
      type="button"
      class={p.class ? `btn sm ${p.class}` : 'btn sm'}
      title={RELOAD_PAGE_TITLE}
      onClick={() => run()}
    >
      {RELOAD_PAGE_LABEL}
    </button>
  );
}

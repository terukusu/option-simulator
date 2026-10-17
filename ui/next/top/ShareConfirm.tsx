import { Dialog } from '../parts/Dialog';

/**
 * タブが上限のときに共有 URL を開く確認（#87。docs/ui-redesign.md §4.5・§11-8 の例外: 外から来る操作で、
 * 置き換わるのを予期していないため）。文は shareReplaceConfirmText のまま。Esc・× は [やめる] と同じ。
 */
export function ShareConfirm(p: {
  text: string | null;
  onReplace: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={p.text !== null} title="URL のポジションを開く" onClose={p.onCancel}>
      <p class="dlg-text">{p.text}</p>
      <div class="dlg-acts">
        <button type="button" class="btn" onClick={p.onCancel}>
          やめる
        </button>
        <button type="button" class="btn primary" onClick={p.onReplace}>
          置き換える
        </button>
      </div>
    </Dialog>
  );
}

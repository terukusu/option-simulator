import { useEffect, useRef } from 'preact/hooks';
import { Dialog } from '../parts/Dialog';

/**
 * 共有の URL（#87 (B)。docs/ui-redesign.md §3「URL 共有」）: クリップボードに書けないときに URL を読み取り専用の欄に出し、
 * 全文を選ぶ（利用者がそのままコピーできるように）。文は shareCopiedMessage(make, true) のまま。
 */
export function ShareUrlDialog(p: {
  share: { url: string; text: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={p.share !== null} title="共有の URL" onClose={p.onClose}>
      {p.share && <ShareUrlBody url={p.share.url} text={p.share.text} onClose={p.onClose} />}
    </Dialog>
  );
}

function ShareUrlBody(p: { url: string; text: string; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  // showModal の後で欄へフォーカスして全文を選ぶ
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div class="dlg-form">
      <p class="dlg-text">{p.text}</p>
      <input
        class="input"
        ref={ref}
        type="text"
        readOnly
        value={p.url}
        aria-label="共有の URL"
        onFocus={(e) => e.currentTarget.select()}
      />
      <div class="dlg-acts">
        <button type="button" class="btn" onClick={p.onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

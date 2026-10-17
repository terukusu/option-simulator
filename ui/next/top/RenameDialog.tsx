import { useEffect, useRef, useState } from 'preact/hooks';
import { TAB_NAME_MAX } from '../../state';
import { renameError } from '../../view/tabs';
import { Dialog } from '../parts/Dialog';

/**
 * 名前を変える…（#87 (B)。docs/ui-redesign.md §4.5）。欄 + [変える] / [やめる]。Enter・[変える] で renameError を通し、
 * 通れば onRename（reducer の renameTab が同じ規則で正規化）して閉じ、外れたら開いたまま欄の下に role="alert"。
 * Esc・× は [やめる] と同じ（Dialog が開く前の要素 = 作業中のチップへフォーカスを戻す）。ブラウザの入力の窓（prompt）を使わない。
 */
export function RenameDialog(p: {
  open: boolean;
  tabs: ReadonlyArray<{ id: number; name: string }>;
  id: number;
  name: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={p.open} title="名前を変える" onClose={p.onClose}>
      <RenameForm {...p} />
    </Dialog>
  );
}

function RenameForm(p: {
  tabs: ReadonlyArray<{ id: number; name: string }>;
  id: number;
  name: string;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(p.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // showModal（親の useLayoutEffect）が最初のフォーカス可能な要素（×）へ移した後で、欄を選ぶ
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <form
      class="dlg-form"
      onSubmit={(e) => {
        e.preventDefault();
        const err = renameError(p.tabs, p.id, draft);
        if (err !== null) {
          setError(err);
          return;
        }
        p.onRename(draft);
        p.onClose();
      }}
    >
      <input
        class="input"
        ref={inputRef}
        type="text"
        value={draft}
        maxLength={TAB_NAME_MAX}
        aria-label="タブの名前"
        aria-invalid={error !== null}
        autoComplete="off"
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          setError(null);
        }}
      />
      {error !== null && (
        <p class="dlg-error" role="alert">
          {error}
        </p>
      )}
      <div class="dlg-acts">
        <button type="button" class="btn" onClick={p.onClose}>
          やめる
        </button>
        <button type="submit" class="btn primary">
          変える
        </button>
      </div>
    </form>
  );
}

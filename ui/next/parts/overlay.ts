import { useCallback, useEffect, useState } from 'preact/hooks';

/**
 * 開いているメニュー / ポップオーバーの id を 1 つだけ持つ小さな購読ストア（#81。docs/ui-redesign.md §5）。
 * Menu・Popover が共有する（同時に開くのは 1 つだけ。別のものを開くと前のものが閉じる）。
 */

let openId: string | null = null;
const listeners = new Set<() => void>();

function setOpenId(id: string | null): void {
  if (openId === id) return;
  openId = id;
  for (const f of listeners) f();
}

/** いま開いているメニュー / ポップオーバーの id（無ければ null）。全体のキー（#89）が「ふさがっている」を読む */
export function openOverlayId(): string | null {
  return openId;
}

export function useOverlay(id: string): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setLocal] = useState(openId === id);
  useEffect(() => {
    const update = () => setLocal(openId === id);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      // 開いたまま消えたら閉じた扱いにする（次に開くものを邪魔しない）
      if (openId === id) openId = null;
    };
  }, [id]);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) setOpenId(id);
      else if (openId === id) setOpenId(null);
    },
    [id],
  );
  return { open, setOpen };
}

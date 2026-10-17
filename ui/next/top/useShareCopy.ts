import { useEffect, useRef, useState } from 'preact/hooks';
import type { ShareMake } from '../../share';
import { type ShareItemState, type ShareResult, shareItemState } from '../../view/boxTabs';
import { shareCopyDisabled } from '../../view/tabs';

export interface ShareCopyInput {
  /** その [URL をコピー] のあるメニューが開いている */
  open: boolean;
  /** 作業中のタブの足の本数 */
  legCount: number;
  /** このブラウザで URL を作れる（shareSupported() を NextApp で 1 回） */
  supported: boolean;
  /** 作業中のタブの URL を作る（useAppController の makeShareUrl。参照が変わらない） */
  make: () => Promise<ShareMake>;
  /** 作業中のタブの中身が変わったら呼ばれる（useAppController の subscribeShare） */
  subscribe: (f: () => void) => () => void;
  /** 結果（トースト / ダイアログへ振り分ける。参照が変わらない） */
  onResult: (r: ShareResult) => void;
}

/**
 * [URL をコピー]（#87 (B)。docs/ui-redesign.md §3「URL 共有」。旧 WorkTabs #72 の作りの写し）。
 * メニューを開いたとき（と開いている間に作業中のタブの中身が変わったとき）に URL を作っておき、copy（メニューの選択と
 * 同じイベント）では await を挟まずに navigator.clipboard.writeText する（Safari は利用者の操作から await を挟むと
 * クリップボードへの書き込みを断ることがある）。書けない（無い・例外・reject）なら fallback、作れなければ error。
 * 閉じたら作りかけの結果を捨てる（shareSeq）。
 */
export function useShareCopy(p: ShareCopyInput): { item: ShareItemState; copy: () => void } {
  const [made, setMade] = useState<ShareMake | null>(null);
  const seq = useRef(0);
  const blocked = shareCopyDisabled(p.legCount, p.supported) !== null;
  const { open, make, subscribe, onResult } = p;

  useEffect(() => {
    if (!open || blocked) {
      ++seq.current;
      setMade(null);
      return;
    }
    const run = () => {
      const id = ++seq.current;
      setMade(null);
      make().then(
        (m) => {
          if (id === seq.current) setMade(m);
        },
        () => {
          if (id === seq.current) setMade({ kind: 'failed' });
        },
      );
    };
    run();
    const unsubscribe = subscribe(run);
    return () => {
      unsubscribe();
      ++seq.current;
    };
  }, [open, blocked, make, subscribe]);

  const copy = () => {
    if (made === null) return;
    if (made.kind !== 'ok') {
      onResult({ kind: 'error', make: made });
      return;
    }
    const ok = made;
    const fallback = () => onResult({ kind: 'fallback', make: ok });
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip || typeof clip.writeText !== 'function') {
      fallback();
      return;
    }
    try {
      clip.writeText(ok.url).then(() => onResult({ kind: 'copied', make: ok }), fallback);
    } catch {
      fallback();
    }
  };

  return { item: shareItemState(p.legCount, p.supported, made), copy };
}

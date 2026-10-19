import { useEffect, useState } from 'preact/hooks';
import type { TermId } from '../../view/glossary';

/**
 * 開いている説明カードの用語を 1 つだけ持つ小さな購読ストア（#167。./overlay.ts と同じ形）。
 * ⓘ の「用語:」・指標の内訳の見出し・コマンドパレットの用語の行が openTerm を呼び、NextApp に 1 つだけ置いた
 * TermCard が useTermCard で読む（Popover の中身へ props を通さない）。状態は保存しない。
 */

let current: TermId | null = null;
const listeners = new Set<() => void>();

function set(id: TermId | null): void {
  if (current === id) return;
  current = id;
  for (const f of listeners) f();
}

/** 説明カードを開く（開いていれば中身を替える） */
export function openTerm(id: TermId): void {
  set(id);
}

export function closeTerm(): void {
  set(null);
}

/** いま開いている説明カードの用語（無ければ null） */
export function useTermCard(): TermId | null {
  const [id, setLocal] = useState<TermId | null>(current);
  useEffect(() => {
    const update = () => setLocal(current);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return id;
}

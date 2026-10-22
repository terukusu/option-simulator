/**
 * show() で開くダイアログ（コマンドパレット・説明カード）の背景を読み上げから外す（#124。docs/ui-redesign.md §5）。
 * いちばん上に開いているダイアログの兄弟の要素に aria-hidden="true" を付ける（トーストの置き場 .toast-slot は
 * 読み上げの領域なので除く・初めから aria-hidden のものは触らない）。inert にしないのは、inert は継承する計算スタイルで
 * 部分木のスタイルを作り直す（showModal() と同じく 322 行の板で開く操作が重くなる。#89 AC-B5(j)）ため。キーボードは
 * 各ダイアログのフォーカスの守り（Tab を中に留める・外へ出たフォーカスを戻す）、ポインタは窓いっぱいの下敷きで止める。
 *
 * 順の約束: フォーカスを中へ移してから hideBackground、閉じるときは戻す関数を呼んでからフォーカスを戻す
 * （フォーカスのある要素の祖先に aria-hidden を付けない）。戻す関数は何度呼んでもよい。
 */

const KEEP = '.toast-slot';

const stack: Element[] = [];
let hidden = new Set<Element>();

function sync(): void {
  const top = stack.at(-1);
  const want = new Set<Element>();
  for (const el of Array.from(top?.parentElement?.children ?? [])) {
    if (el === top || el.matches(KEEP)) continue;
    // 自分が付けていない aria-hidden は触らない（外すときも残す）
    if (!hidden.has(el) && el.getAttribute('aria-hidden') === 'true') continue;
    want.add(el);
  }
  for (const el of hidden) if (!want.has(el)) el.removeAttribute('aria-hidden');
  for (const el of want) if (!hidden.has(el)) el.setAttribute('aria-hidden', 'true');
  hidden = want;
}

/** dialog の背景を読み上げから外し、戻す関数を返す */
export function hideBackground(dialog: Element): () => void {
  stack.push(dialog);
  sync();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = stack.lastIndexOf(dialog);
    if (i >= 0) stack.splice(i, 1);
    sync();
  };
}

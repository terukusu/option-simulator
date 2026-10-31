import { useEffect, useState } from 'preact/hooks';
import type { TermId } from '../../view/glossary';
import {
  TERM_CHAIN_EMPTY,
  type TermChain,
  type TermChainView,
  termBack,
  termChainView,
  termDrop,
  termOpen,
} from '../../view/termChain';
import { closeLayer, openLayer } from '../backStack';

/**
 * 開いている説明カードの用語の列を持つ小さな購読ストア（#167・#320 第 2 弾。./overlay.ts と同じ形）。
 * ⓘ の「用語:」・指標の内訳の見出し・コマンドパレットの用語の行・AI の返答の用語・カードの関連する用語が openTerm を呼び、
 * NextApp に 1 つだけ置いた TermCard が useTermCard で読む（Popover の中身へ props を通さない）。状態は保存しない。
 *
 * 列の規則は ui/view/termChain.ts（関連する用語で積む・上限 8・用語ごとの本文の位置）。用語ごとに戻るの層
 * `term:<key>` を ../backStack.ts に積む（戻る = backTerm。開く操作の中で積むので利用者の操作として数える）。
 */

let chain: TermChain = TERM_CHAIN_EMPTY;
let nextKey = 1;
const listeners = new Set<() => void>();
/** 今の用語の本文の位置を読む（TermCard が開いている間だけ置く） */
let readScroll: (() => number) | null = null;

const layerOf = (key: number) => `term:${key}`;

function set(next: TermChain): void {
  if (next === chain) return;
  const before = chain;
  chain = next;
  // 外れた用語の層を上から外す（戻るで既に外れていれば closeLayer は何もしない）
  const keep = new Set(next.map((t) => t.key));
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i];
    if (t && !keep.has(t.key)) closeLayer(layerOf(t.key));
  }
  for (const f of listeners) f();
}

/** 説明カードを開く（開いていれば今の本文の位置を控えて、その上に積む） */
export function openTerm(id: TermId): void {
  const r = termOpen(chain, id, readScroll?.() ?? 0, nextKey);
  if (r.chain === chain) return;
  const key = nextKey++;
  // 新しい層を先に積み、捨てた一番古いものの層は set で外す（同じ後始末で差し引きされ履歴は増えない）
  openLayer(layerOf(key), () => set(termDrop(chain, key)));
  set(r.chain);
}

/** 1 つ前の用語へ戻る（最初の用語ならカードを閉じる）。Esc・[← 戻る] */
export function backTerm(): void {
  set(termBack(chain));
}

/** 説明カードを全部閉じる。×・箱の外のクリック */
export function closeTerm(): void {
  set(TERM_CHAIN_EMPTY);
}

/** TermCard が今の本文の位置を読む関数を置く（閉じるとき null） */
export function setTermScrollReader(f: (() => number) | null): void {
  readScroll = f;
}

/** いま開いている説明カード（今の用語・戻り先。閉じていれば current = null） */
export function useTermCard(): TermChainView {
  const [view, setLocal] = useState<TermChainView>(() => termChainView(chain));
  useEffect(() => {
    const update = () => setLocal(termChainView(chain));
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return view;
}

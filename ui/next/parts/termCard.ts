import { useEffect, useState } from 'preact/hooks';
import type { TermId } from '../../view/glossary';
import {
  type CardEntry,
  cardOpen,
  TERM_CHAIN_EMPTY,
  type TermChain,
  type TermChainView,
  termBack,
  termChainView,
  termDrop,
} from '../../view/termChain';
import { closeLayer, openLayer } from '../backStack';
import { manualIndexNow } from './manualDoc';

/**
 * 開いている説明カードの列（用語・マニュアルの節・目次。#167・#320 第 2 弾・#322）を持つ小さな購読ストア（./overlay.ts と同じ形）。
 * ⓘ の「用語:」「マニュアル:」・指標の内訳の見出し・コマンドパレットの用語の行・AI の返答の用語と根拠の節・カードの関連する用語・
 * 節の中のリンク・⋯ の「マニュアル」が openTerm / openManual / openManualRef / openToc を呼び、
 * NextApp に 1 つだけ置いた TermCard が useTermCard で読む（Popover の中身へ props を通さない）。状態は保存しない。
 *
 * 列の規則は ui/view/termChain.ts（押すたびに積む・上限 8・項目ごとの本文の位置）。項目ごとに戻るの層
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

/** 説明カードに項目を開く（開いていれば今の本文の位置を控えて、その上に積む） */
export function openCard(entry: CardEntry): void {
  const r = cardOpen(chain, entry, readScroll?.() ?? 0, nextKey, manualIndexNow());
  if (r.chain === chain) return;
  const key = nextKey++;
  // 新しい層を先に積み、捨てた一番古いものの層は set で外す（同じ後始末で差し引きされ履歴は増えない）
  openLayer(layerOf(key), () => set(termDrop(chain, key)));
  set(r.chain);
}

/** 説明カードに用語を開く */
export function openTerm(id: TermId): void {
  openCard({ kind: 'term', id });
}

/** 説明カードにマニュアルの節を開く（#322。アンカー = 用語の「マニュアル: …」・ⓘ の「マニュアル:」・節の中のリンク・目次） */
export function openManual(anchor: string): void {
  openCard({ kind: 'manual', anchor });
}

/** 説明カードに AI の返答の根拠の節を開く（#322。番号と見出し。節はカードが索引で引く） */
export function openManualRef(id: string, title: string | null): void {
  openCard({ kind: 'ref', id, title });
}

/** 説明カードにマニュアルの目次を開く（#322。⋯ の「マニュアル」・節の末尾の [目次]） */
export function openToc(): void {
  openCard({ kind: 'toc' });
}

/** 1 つ前の項目へ戻る（最初の用語ならカードを閉じる）。Esc・[← 戻る] */
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

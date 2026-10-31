import type { TermId } from './glossary';

/**
 * 説明カードの用語の列（#320 第 2 弾。docs/ui-redesign.md §5「説明カード」）。関連する用語を押すたびに 1 つ積み、
 * 戻る・Esc・[← 戻る] で 1 つ前の用語へ、× と箱の外のクリックで全部閉じる。用語ごとに本文（.tc-body）の
 * スクロール位置を控え、1 つ前に戻ったときにその位置へ戻す（セッション中だけ。保存しない）。
 *
 * 純関数（DOM に触らない）。ストアは ui/next/parts/termCard.ts。
 */

export interface TermChainItem {
  readonly id: TermId;
  /** 列の中で一意の番号（単調に増やす。A → B → A でも重ならない。戻るの層の id `term:<key>`） */
  readonly key: number;
  /** この用語の本文のスクロール位置（px。上に次の用語を積んだときに控える。0 以上） */
  readonly scroll: number;
}

export type TermChain = readonly TermChainItem[];

/** 列の上限（超えたら一番古いものを捨てる） */
export const TERM_CHAIN_MAX = 8;

export const TERM_CHAIN_EMPTY: TermChain = [];

const clampScroll = (y: number): number => (Number.isFinite(y) && y > 0 ? y : 0);

/**
 * 用語を開く（積む）。scrollNow は今の一番上の用語の本文の位置（積むときに控える）。
 * 同じ用語が一番上なら変えない。上限を超えたら一番古いものを捨て、その key を dropped に返す
 */
export function termOpen(
  c: TermChain,
  id: TermId,
  scrollNow: number,
  key: number,
): { chain: TermChain; dropped: number | null } {
  const top = c.at(-1);
  if (top?.id === id) return { chain: c, dropped: null };
  const below: TermChainItem[] =
    top === undefined ? [] : [...c.slice(0, -1), { ...top, scroll: clampScroll(scrollNow) }];
  const next = [...below, { id, key, scroll: 0 }];
  if (next.length > TERM_CHAIN_MAX) {
    const [first, ...rest] = next;
    return { chain: rest, dropped: first?.key ?? null };
  }
  return { chain: next, dropped: null };
}

/** 1 つ前の用語へ戻る（一番上を外す。空なら空） */
export function termBack(c: TermChain): TermChain {
  return c.length === 0 ? c : c.slice(0, -1);
}

/** key の用語を外す（戻るで閉じる層。ふつうは一番上） */
export function termDrop(c: TermChain, key: number): TermChain {
  return c.some((t) => t.key === key) ? c.filter((t) => t.key !== key) : c;
}

/** 全部閉じる */
export function termClose(): TermChain {
  return TERM_CHAIN_EMPTY;
}

export interface TermChainView {
  /** 今の用語（無ければ null = カードを閉じる） */
  readonly current: TermChainItem | null;
  /** 戻り先の用語（1 つ前。無ければ null = [← 戻る] を出さない） */
  readonly prev: TermId | null;
}

export function termChainView(c: TermChain): TermChainView {
  return { current: c.at(-1) ?? null, prev: c.at(-2)?.id ?? null };
}

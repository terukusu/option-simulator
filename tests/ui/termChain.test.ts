import { describe, expect, it } from 'vitest';
import type { TermId } from '../../ui/view/glossary';
import {
  TERM_CHAIN_EMPTY,
  TERM_CHAIN_MAX,
  type TermChain,
  termBack,
  termChainView,
  termClose,
  termDrop,
  termOpen,
} from '../../ui/view/termChain';

/**
 * #320 第 2 弾 AC-2-2: 説明カードの用語の列（関連する用語で積み、戻る・Esc・[← 戻る] で 1 つ前、× で全部）。
 */

/** 順に開く（key は 1 から。scroll は開くときの今の本文の位置） */
function openAll(ids: readonly (readonly [string, number])[], from: TermChain = TERM_CHAIN_EMPTY) {
  let c = from;
  let key = (from.at(-1)?.key ?? 0) + 1;
  const dropped: number[] = [];
  for (const [id, scroll] of ids) {
    const r = termOpen(c, id as TermId, scroll, key++);
    c = r.chain;
    if (r.dropped !== null) dropped.push(r.dropped);
  }
  return { chain: c, dropped };
}

describe('termChain（#320 第 2 弾）', () => {
  it('(a) A → B → C → 1 つ前 → B、戻り先は A', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['gamma', 0],
      ['vega', 0],
    ]);
    expect(termChainView(chain).current?.id).toBe('vega');
    expect(termChainView(chain).prev).toBe('gamma');
    const b = termBack(chain);
    expect(termChainView(b).current?.id).toBe('gamma');
    expect(termChainView(b).prev).toBe('delta');
    const a = termBack(b);
    expect(termChainView(a).current?.id).toBe('delta');
    expect(termChainView(a).prev).toBeNull();
    expect(termChainView(termBack(a)).current).toBeNull();
  });

  it('(b) 同じ用語を続けて開いても積まない', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['delta', 40],
    ]);
    expect(chain.map((t) => t.id)).toEqual(['delta']);
    // 位置も変えない（積んでいないので控えない）
    expect(chain[0]?.scroll).toBe(0);
  });

  it('(c) A → B → A は 3 つ積み、key は重ならない', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['gamma', 0],
      ['delta', 0],
    ]);
    expect(chain.map((t) => t.id)).toEqual(['delta', 'gamma', 'delta']);
    expect(new Set(chain.map((t) => t.key)).size).toBe(3);
    expect(termChainView(chain).prev).toBe('gamma');
  });

  it('(d) 全部閉じる → 空', () => {
    expect(termClose()).toEqual([]);
    expect(termChainView(termClose())).toEqual({ current: null, prev: null });
    expect(termBack(TERM_CHAIN_EMPTY)).toEqual([]);
  });

  it(`(e) 上限 ${TERM_CHAIN_MAX} を超えたら一番古いものを捨てる`, () => {
    const ids = ['delta', 'gamma', 'vega', 'theta', 'iv', 'hv', 'iv30', 'beta'] as const;
    const eight = openAll(ids.map((id) => [id, 0] as const));
    expect(eight.chain).toHaveLength(TERM_CHAIN_MAX);
    expect(eight.dropped).toEqual([]);
    const nine = openAll([['skew', 0]], eight.chain);
    expect(nine.chain).toHaveLength(TERM_CHAIN_MAX);
    expect(nine.chain[0]?.id).toBe('gamma');
    expect(nine.chain.at(-1)?.id).toBe('skew');
    // 捨てたのは最初の用語の key
    expect(nine.dropped).toEqual([eight.chain[0]?.key]);
  });

  it('(f) 用語ごとのスクロール位置を控え、1 つ前に戻ったときに返す', () => {
    const { chain } = openAll([
      ['delta', 0],
      // delta の本文を 120px スクロールしてから gamma
      ['gamma', 120],
      // gamma の本文を 35px スクロールしてから vega
      ['vega', 35],
    ]);
    expect(termChainView(chain).current?.scroll).toBe(0);
    const b = termBack(chain);
    expect(termChainView(b).current?.scroll).toBe(35);
    expect(termChainView(termBack(b)).current?.scroll).toBe(120);
  });

  it('(f) 負・NaN の位置は 0 にする', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['gamma', -5],
      ['vega', Number.NaN],
    ]);
    expect(chain.map((t) => t.scroll)).toEqual([0, 0, 0]);
  });

  it('termDrop は key の用語だけ外す（無い key は変えない）', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['gamma', 0],
    ]);
    const top = chain.at(-1)?.key ?? -1;
    expect(termDrop(chain, top).map((t) => t.id)).toEqual(['delta']);
    expect(termDrop(chain, 999)).toBe(chain);
  });
});

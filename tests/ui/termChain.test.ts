import { describe, expect, it } from 'vitest';
import type { TermId } from '../../ui/view/glossary';
import { manualIndex } from '../../ui/view/manual';
import {
  type CardEntry,
  cardOpen,
  cardTitle,
  sameEntry,
  TERM_CHAIN_EMPTY,
  TERM_CHAIN_MAX,
  type TermChain,
  type TermChainItem,
  termBack,
  termChainView,
  termClose,
  termDrop,
  termOpen,
} from '../../ui/view/termChain';

/**
 * #320 第 2 弾 AC-2-2: 説明カードの用語の列（関連する用語で積み、戻る・Esc・[← 戻る] で 1 つ前、× で全部）。
 */

/** 項目の名前（用語は id、節は #アンカー、根拠の節は @番号、目次は toc） */
function nameOf(e: CardEntry | null | undefined): string | null {
  if (!e) return null;
  if (e.kind === 'term') return e.id;
  if (e.kind === 'manual') return `#${e.anchor}`;
  if (e.kind === 'ref') return `@${e.id}`;
  return 'toc';
}
const idOf = (t: TermChainItem | null | undefined) => nameOf(t?.entry);

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
    expect(idOf(termChainView(chain).current)).toBe('vega');
    expect(nameOf(termChainView(chain).prev)).toBe('gamma');
    const b = termBack(chain);
    expect(idOf(termChainView(b).current)).toBe('gamma');
    expect(nameOf(termChainView(b).prev)).toBe('delta');
    const a = termBack(b);
    expect(idOf(termChainView(a).current)).toBe('delta');
    expect(nameOf(termChainView(a).prev)).toBeNull();
    expect(termChainView(termBack(a)).current).toBeNull();
  });

  it('(b) 同じ用語を続けて開いても積まない', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['delta', 40],
    ]);
    expect(chain.map(idOf)).toEqual(['delta']);
    // 位置も変えない（積んでいないので控えない）
    expect(chain[0]?.scroll).toBe(0);
  });

  it('(c) A → B → A は 3 つ積み、key は重ならない', () => {
    const { chain } = openAll([
      ['delta', 0],
      ['gamma', 0],
      ['delta', 0],
    ]);
    expect(chain.map(idOf)).toEqual(['delta', 'gamma', 'delta']);
    expect(new Set(chain.map((t) => t.key)).size).toBe(3);
    expect(nameOf(termChainView(chain).prev)).toBe('gamma');
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
    expect(idOf(nine.chain[0])).toBe('gamma');
    expect(idOf(nine.chain.at(-1))).toBe('skew');
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
    expect(termDrop(chain, top).map(idOf)).toEqual(['delta']);
    expect(termDrop(chain, 999)).toBe(chain);
  });
});

/** #322 AC5: 用語とマニュアルの節・目次・根拠の節が混ざった列（規則は用語の列と同じ） */
describe('説明カードの列に用語と節が混ざる（#322 AC5）', () => {
  const T = (id: string): CardEntry => ({ kind: 'term', id: id as TermId });
  const M = (anchor: string): CardEntry => ({ kind: 'manual', anchor });
  const R = (id: string, title: string | null = null): CardEntry => ({ kind: 'ref', id, title });
  const TOC: CardEntry = { kind: 'toc' };
  function openEntries(
    es: readonly (readonly [CardEntry, number])[],
    from: TermChain = TERM_CHAIN_EMPTY,
  ) {
    let c = from;
    let key = (from.at(-1)?.key ?? 0) + 1;
    const dropped: number[] = [];
    for (const [e, scroll] of es) {
      const r = cardOpen(c, e, scroll, key++);
      c = r.chain;
      if (r.dropped !== null) dropped.push(r.dropped);
    }
    return { chain: c, dropped };
  }

  it('用語 → 節 → 節 → 1 つ前 → 1 つ前 → 用語 → 閉じる。本文の位置は項目ごと', () => {
    const { chain } = openEntries([
      [T('hold-map'), 0],
      [M('追証マップ'), 80],
      [M('証拠金概算'), 300],
      [TOC, 45],
    ]);
    expect(chain.map(idOf)).toEqual(['hold-map', '#追証マップ', '#証拠金概算', 'toc']);
    expect(nameOf(termChainView(chain).prev)).toBe('#証拠金概算');
    const a = termBack(chain);
    expect(idOf(termChainView(a).current)).toBe('#証拠金概算');
    expect(termChainView(a).current?.scroll).toBe(45);
    const b = termBack(a);
    expect(idOf(termChainView(b).current)).toBe('#追証マップ');
    expect(termChainView(b).current?.scroll).toBe(300);
    const c = termBack(b);
    expect(idOf(termChainView(c).current)).toBe('hold-map');
    expect(termChainView(c).current?.scroll).toBe(80);
    expect(termChainView(termBack(c)).current).toBeNull();
    expect(termClose()).toEqual([]);
  });

  it('同じもの（同じ節・目次・同じ根拠の節）が一番上なら積まない。違う節・違う種類は積む', () => {
    const same = openEntries([
      [M('追証マップ'), 0],
      [M('追証マップ'), 50],
      [TOC, 0],
      [TOC, 10],
      [R('8.5', '追証マップ'), 0],
      [R('8.5', '追証マップ'), 0],
    ]);
    expect(same.chain.map(idOf)).toEqual(['#追証マップ', 'toc', '@8.5']);
    // 節の位置は積んだときの位置（2 回目の 50 は積んでいないので控えない）
    expect(same.chain[0]?.scroll).toBe(0);
    expect(same.chain[1]?.scroll).toBe(0);
    // 用語の hold-map と節の 追証マップ は別のもの。根拠の節は見出しが違えば別のもの
    const other = openEntries([
      [T('hold-map'), 0],
      [M('追証マップ'), 0],
      [R('8.5', '追証マップ'), 0],
      [R('8.5', null), 0],
    ]);
    expect(other.chain).toHaveLength(4);
    expect(sameEntry(R('8.5', 'x'), R('8.5', 'y'))).toBe(false);
    expect(sameEntry(T('delta'), M('delta'))).toBe(false);
  });

  it(`上限 ${TERM_CHAIN_MAX}: 混ざっていても一番古いものを捨てる。termDrop は key の項目だけ`, () => {
    const es: [CardEntry, number][] = [
      [T('delta'), 0],
      [M('a'), 0],
      [T('gamma'), 0],
      [M('b'), 0],
      [TOC, 0],
      [M('c'), 0],
      [T('vega'), 0],
      [R('10'), 0],
    ];
    const eight = openEntries(es);
    expect(eight.chain).toHaveLength(TERM_CHAIN_MAX);
    const nine = openEntries([[M('d'), 0]], eight.chain);
    expect(nine.chain).toHaveLength(TERM_CHAIN_MAX);
    expect(idOf(nine.chain[0])).toBe('#a');
    expect(nine.dropped).toEqual([eight.chain[0]?.key]);
    const top = nine.chain.at(-1)?.key ?? -1;
    expect(idOf(termDrop(nine.chain, top).at(-1))).toBe('@10');
  });

  it('索引があれば、同じ節を指すマニュアルの節と根拠の節は同じもの（2 段積まない。レビュー指摘 7）', () => {
    const idx = manualIndex(
      ['## 8. 指標', '### 追証マップ', '本文', '### テール表', '本文'].join('\n'),
    );
    // 根拠の節 8.5 相当（ここでは 8.1「追証マップ」）→ カードの中の「追証マップ」へのリンク
    const r = cardOpen(TERM_CHAIN_EMPTY, R('8.1', '追証マップ'), 0, 1, idx);
    const same = cardOpen(r.chain, M('追証マップ'), 40, 2, idx);
    expect(same.chain).toBe(r.chain);
    // 逆向き（節 → 番号違いでも見出しで同じ節に引ける根拠の節）も積まない
    const m = cardOpen(TERM_CHAIN_EMPTY, M('追証マップ'), 0, 1, idx);
    expect(cardOpen(m.chain, R('9.9', '追証マップ'), 0, 2, idx).chain).toBe(m.chain);
    // 別の節は積む。索引が無ければ今までどおり別のもの
    expect(cardOpen(r.chain, M('テール表'), 0, 2, idx).chain).toHaveLength(2);
    expect(cardOpen(r.chain, M('追証マップ'), 0, 2).chain).toHaveLength(2);
    expect(sameEntry(R('8.1', null), M('追証マップ'), idx)).toBe(true);
    // 見つからない根拠の節どうしは今までどおり番号と見出しで比べる
    expect(sameEntry(R('99.1', 'x'), R('99.1', 'x'), idx)).toBe(true);
    expect(sameEntry(R('99.1', 'x'), M('無い'), idx)).toBe(false);
    expect(sameEntry(T('hold-map'), M('追証マップ'), idx)).toBe(false);
  });

  it('termOpen は用語の cardOpen と同じ', () => {
    const a = termOpen(TERM_CHAIN_EMPTY, 'delta', 0, 1);
    const b = cardOpen(TERM_CHAIN_EMPTY, T('delta'), 0, 1);
    expect(a).toEqual(b);
  });

  it('cardTitle: 用語は見出し、節は「マニュアル 番号 見出し」、目次、読み込む前は「マニュアル」', () => {
    const idx = manualIndex(['## 1. はじめ', '', '### 開き方', '', '本文'].join('\n'));
    expect(cardTitle(T('delta'), null)).toMatch(/^デルタ/);
    expect(cardTitle(M('開き方'), idx)).toBe('マニュアル 1.1 開き方');
    expect(cardTitle(M('開き方'), null)).toBe('マニュアル');
    expect(cardTitle(M('無い'), idx)).toBe('マニュアル');
    expect(cardTitle(TOC, null)).toBe('マニュアルの目次');
    expect(cardTitle(R('1.1', '開き方'), idx)).toBe('マニュアル 1.1 開き方');
    expect(cardTitle(R('9.9', '無い'), idx)).toBe('マニュアル 9.9');
  });
});

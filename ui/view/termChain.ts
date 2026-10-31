import { type TermId, termById } from './glossary';
import { type ManualIndex, sectionLabel } from './manual';
import { resolveManualRef } from './manualRefs';

/**
 * 説明カードの列（#320 第 2 弾・#322。docs/ui-redesign.md §5「説明カード」）。用語・マニュアルの節・マニュアルの目次を
 * 押すたびに 1 つ積み、戻る・Esc・[← 戻る] で 1 つ前へ、× と箱の外のクリックで全部閉じる。項目ごとに本文（.tc-body）の
 * スクロール位置を控え、1 つ前に戻ったときにその位置へ戻す（セッション中だけ。保存しない）。
 *
 * 純関数（DOM に触らない）。ストアは ui/next/parts/termCard.ts。
 */

/**
 * カードに出すもの: 用語 / マニュアルの節（アンカー）/ AI の根拠の節（番号と見出し。押した後に索引で引く）/ 目次
 */
export type CardEntry =
  | { readonly kind: 'term'; readonly id: TermId }
  | { readonly kind: 'manual'; readonly anchor: string }
  | { readonly kind: 'ref'; readonly id: string; readonly title: string | null }
  | { readonly kind: 'toc' };

/** マニュアルの節・根拠の節が指す節のアンカー（索引が無い・見つからなければ null） */
function sectionOf(e: CardEntry, index: ManualIndex | null): string | null {
  if (index === null) return null;
  if (e.kind === 'manual') return index.byAnchor.has(e.anchor) ? e.anchor : null;
  if (e.kind === 'ref') return resolveManualRef(index, e)?.anchor ?? null;
  return null;
}

/**
 * 同じもの（積まない判定）。index（マニュアルの索引）があれば、マニュアルの節と AI の根拠の節は同じ節を指せば同じ
 * （根拠の節 8.5 → カードの中の「追証マップ」へのリンクで同じ節を 2 段積まない）
 */
export function sameEntry(a: CardEntry, b: CardEntry, index: ManualIndex | null = null): boolean {
  const sa = sectionOf(a, index);
  if (sa !== null && sa === sectionOf(b, index)) return true;
  switch (a.kind) {
    case 'term':
      return b.kind === 'term' && a.id === b.id;
    case 'manual':
      return b.kind === 'manual' && a.anchor === b.anchor;
    case 'ref':
      return b.kind === 'ref' && a.id === b.id && a.title === b.title;
    case 'toc':
      return b.kind === 'toc';
  }
}

export interface TermChainItem {
  readonly entry: CardEntry;
  /** 列の中で一意の番号（単調に増やす。A → B → A でも重ならない。戻るの層の id `term:<key>`） */
  readonly key: number;
  /** この項目の本文のスクロール位置（px。上に次の項目を積んだときに控える。0 以上） */
  readonly scroll: number;
}

export type TermChain = readonly TermChainItem[];

/** 列の上限（超えたら一番古いものを捨てる） */
export const TERM_CHAIN_MAX = 8;

export const TERM_CHAIN_EMPTY: TermChain = [];

const clampScroll = (y: number): number => (Number.isFinite(y) && y > 0 ? y : 0);

/**
 * 項目を開く（積む）。scrollNow は今の一番上の項目の本文の位置（積むときに控える）。
 * 同じものが一番上なら変えない（index があれば同じ節を指す節と根拠の節も同じもの。sameEntry）。上限を超えたら
 * 一番古いものを捨て、その key を dropped に返す
 */
export function cardOpen(
  c: TermChain,
  entry: CardEntry,
  scrollNow: number,
  key: number,
  index: ManualIndex | null = null,
): { chain: TermChain; dropped: number | null } {
  const top = c.at(-1);
  if (top && sameEntry(top.entry, entry, index)) return { chain: c, dropped: null };
  const below: TermChainItem[] =
    top === undefined ? [] : [...c.slice(0, -1), { ...top, scroll: clampScroll(scrollNow) }];
  const next = [...below, { entry, key, scroll: 0 }];
  if (next.length > TERM_CHAIN_MAX) {
    const [first, ...rest] = next;
    return { chain: rest, dropped: first?.key ?? null };
  }
  return { chain: next, dropped: null };
}

/** 用語を開く（cardOpen の用語の形） */
export function termOpen(
  c: TermChain,
  id: TermId,
  scrollNow: number,
  key: number,
): { chain: TermChain; dropped: number | null } {
  return cardOpen(c, { kind: 'term', id }, scrollNow, key);
}

/** 1 つ前へ戻る（一番上を外す。空なら空） */
export function termBack(c: TermChain): TermChain {
  return c.length === 0 ? c : c.slice(0, -1);
}

/** key の項目を外す（戻るで閉じる層。ふつうは一番上） */
export function termDrop(c: TermChain, key: number): TermChain {
  return c.some((t) => t.key === key) ? c.filter((t) => t.key !== key) : c;
}

/** 全部閉じる */
export function termClose(): TermChain {
  return TERM_CHAIN_EMPTY;
}

export interface TermChainView {
  /** 今の項目（無ければ null = カードを閉じる） */
  readonly current: TermChainItem | null;
  /** 戻り先（1 つ前。無ければ null = [← 戻る] を出さない） */
  readonly prev: CardEntry | null;
}

export function termChainView(c: TermChain): TermChainView {
  return { current: c.at(-1) ?? null, prev: c.at(-2)?.entry ?? null };
}

/**
 * カードの見出し（[← 戻る] の名前にも使う）。用語は見出し、マニュアルの節は「マニュアル 8.5 追証マップ」、目次は
 * 「マニュアルの目次」。マニュアルを読み込む前（index = null）・見つからない節は「マニュアル」（根拠の節は番号を付ける）
 */
export function cardTitle(entry: CardEntry, index: ManualIndex | null): string {
  switch (entry.kind) {
    case 'term':
      return termById(entry.id)?.title ?? entry.id;
    case 'toc':
      return 'マニュアルの目次';
    case 'manual': {
      const s = index?.byAnchor.get(entry.anchor);
      return s ? `マニュアル ${sectionLabel(s)}` : 'マニュアル';
    }
    case 'ref': {
      const s = index ? resolveManualRef(index, entry) : null;
      return s ? `マニュアル ${sectionLabel(s)}` : `マニュアル ${entry.id}`;
    }
  }
}

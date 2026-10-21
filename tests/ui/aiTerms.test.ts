import { describe, expect, it } from 'vitest';
import { findTerms } from '../../ui/view/aiTerms';
import { answerModel, type MarkedBlock, type MarkedInline } from '../../ui/view/aiText';
import type { TermId } from '../../ui/view/glossary';

/** #232: AI の返答の中の用語集の用語の印。値は架空。 */

const ids = (text: string, seen = new Set<TermId>()) =>
  findTerms(text, seen).map((h) => [text.slice(h.start, h.end), h.id]);

describe('findTerms', () => {
  it('見出し・短い形・別名・見出しの先頭のカタカナで一致する', () => {
    expect(ids('IV が上がり、追証の線に近づく')).toEqual([
      ['IV', 'iv'],
      ['追証の線', 'margin-line'],
    ]);
    expect(ids('ベガ と ガンマ と スキュー')).toEqual([
      ['ベガ', 'vega'],
      ['ガンマ', 'gamma'],
      ['スキュー', 'skew'],
    ]);
    expect(ids('NOV と JSCC と iv30')).toEqual([
      ['NOV', 'nov'],
      ['JSCC', 'jscc'],
      ['iv30', 'iv30'],
    ]);
  });

  it('長い語が先（ΔX・Δσ・必要証拠金・証拠金所要額）', () => {
    expect(ids('ΔX と Δσ と Δs')).toEqual([
      ['ΔX', 'dx'],
      ['Δσ', 'iv-shift'],
      ['Δs', 'skew'],
    ]);
    expect(ids('必要証拠金と証拠金所要額')).toEqual([
      ['必要証拠金', 'margin'],
      ['証拠金所要額', 'requirement'],
    ]);
  });

  it('英字は大小を区別しない・語の中の空白は 0 個以上', () => {
    expect(ids('iv と Hv')).toEqual([
      ['iv', 'iv'],
      ['Hv', 'hv'],
    ]);
    expect(ids('IVシフト')).toEqual([['IVシフト', 'iv-shift']]);
  });

  it('誤リンクを避ける境界（IVR・デルタヘッジ・1 文字の英字・1σ）', () => {
    expect(ids('IVR は別の指標')).toEqual([]);
    expect(ids('デルタヘッジをする')).toEqual([]);
    expect(ids('V 字に戻る。F 値')).toEqual([]);
    expect(ids('1σ の動き')).toEqual([]);
    expect(ids('σ が上がる')).toEqual([['σ', 'iv']]);
    expect(ids('Δ −0.45 枚、β 0.3')).toEqual([
      ['Δ', 'delta'],
      ['β', 'beta'],
    ]);
  });

  it('同じ用語は seen にある間は付けない（語は消費する = ΔX の中の Δ を拾わない）', () => {
    const seen = new Set<TermId>();
    expect(ids('ΔX と IV', seen)).toEqual([
      ['ΔX', 'dx'],
      ['IV', 'iv'],
    ]);
    expect(ids('ΔX と IV と Δ', seen)).toEqual([['Δ', 'delta']]);
  });

  it('skip（数値トークン）と重なる一致は捨てる', () => {
    const text = 'IV 30 と IV';
    expect(findTerms(text, new Set(), [{ start: 0, end: 5 }])).toEqual([
      { start: 8, end: 10, id: 'iv' },
    ]);
  });
});

const terms = (inl: MarkedInline[]) =>
  inl.flatMap((x) => x.parts.filter((p) => p.term).map((p) => [p.text, p.term]));

describe('answerModel の用語の印', () => {
  const src = [{ rows: [{ sq_pnl_yen: -1234567 }] }];

  it('返答の中で最初の 1 回だけ（段落・箇条書き・表のセルをまたぐ）、見出しには付けない', () => {
    const t = [
      '## IV の上昇に弱い',
      'IV が上がると損が出る。',
      '- IV と Θ',
      '',
      '| 足 | Θ | 追証 |',
      '|---|---|---|',
      '| IV の高い足 | 1 | 2 |',
    ].join('\n');
    const b = answerModel(t, src);
    const h = b[0] as Extract<MarkedBlock, { kind: 'h' }>;
    expect(terms(h.inl)).toEqual([]);
    const p = b[1] as Extract<MarkedBlock, { kind: 'p' }>;
    expect(terms(p.inl)).toEqual([['IV', 'iv']]);
    const ul = b[2] as Extract<MarkedBlock, { kind: 'ul' | 'ol' }>;
    expect(terms(ul.items[0] ?? [])).toEqual([['Θ', 'theta']]);
    const tb = b[3] as Extract<MarkedBlock, { kind: 'table' }>;
    expect(tb.head.flatMap(terms)).toEqual([['追証', 'margin-line']]);
    expect(tb.rows.flat().flatMap(terms)).toEqual([]);
  });

  it('数値トークン・照合できない数字の印の中には付けない（印は今のまま）', () => {
    const b = answerModel('損は 1,235 千円、別に 999 千円。IV は 20%', src);
    const p = b[0] as Extract<MarkedBlock, { kind: 'p' }>;
    expect(p.inl[0]?.parts).toEqual([
      { text: '損は 1,235 千円、別に ', unmatched: false },
      { text: '999 千円', unmatched: true },
      { text: '。', unmatched: false },
      { text: 'IV', unmatched: false, term: 'iv' },
      { text: ' は ', unmatched: false },
      { text: '20%', unmatched: true },
    ]);
  });

  it('太字の中にも付く', () => {
    const b = answerModel('**β** の効き', src);
    const p = b[0] as Extract<MarkedBlock, { kind: 'p' }>;
    expect(p.inl[0]).toEqual({
      bold: true,
      parts: [{ text: 'β', unmatched: false, term: 'beta' }],
    });
  });
});

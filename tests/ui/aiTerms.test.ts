import { describe, expect, it } from 'vitest';
import { findTerms, halfWidth, wordsOf } from '../../ui/view/aiTerms';
import { answerModel, type MarkedBlock, type MarkedInline, markInline } from '../../ui/view/aiText';
import { GLOSSARY, type TermId } from '../../ui/view/glossary';

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

describe('findTerms の追加の規則（レビュー指摘 2・3・4）', () => {
  it('漢字で終わる語の直後が漢字なら付けない（複合語の中）。助詞・記号の前は付く', () => {
    expect(ids('証拠金率が上がる')).toEqual([]);
    expect(ids('原資産価格が動く')).toEqual([]);
    expect(ids('原資産の値と証拠金が増える')).toEqual([
      ['原資産', 'dx'],
      ['証拠金', 'margin'],
    ]);
    expect(ids('必要証拠金の額')).toEqual([['必要証拠金', 'margin']]);
  });

  it('全角の英数字は半角に寄せて照合する（表示の位置は元の文字）', () => {
    expect(halfWidth('ＩＶとｉｖ３０')).toBe('IVとiv30');
    expect(ids('ＩＶ が上がり ＮＯＶ が減る')).toEqual([
      ['ＩＶ', 'iv'],
      ['ＮＯＶ', 'nov'],
    ]);
    expect(ids('ＩＶＲ')).toEqual([]);
  });

  it('数値トークンを丸ごと含む語（30 日固定）は一致し、そのトークンに照合の印を付けない', () => {
    const parts = markInline('IV 推移は 30 日固定の値', [], new Set());
    expect(parts).toEqual([
      { text: 'IV 推移', unmatched: false, term: 'iv30' },
      // 2 回目の 30 日固定は語を消費するので、中の 30 日にも照合の印が付かない
      { text: 'は 30 日固定の値', unmatched: false },
    ]);
    const first = markInline('30 日固定の値', [], new Set());
    expect(first[0]).toEqual({ text: '30 日固定', unmatched: false, term: 'iv30' });
    // 語の途中で切れるトークン（「1σ」の 1）とは重ならない = 付かない
    expect(markInline('1,000σ', [], new Set()).some((p) => p.term)).toBe(false);
  });

  it('用語集の全語: 後ろに助詞が続けばその語の用語に、漢字が続けば漢字で終わる語だけ付かない（取りこぼしの検査）', () => {
    for (const t of GLOSSARY) {
      for (const w of wordsOf(t)) {
        const ok = markInline(`${w}の`, [], new Set()).find((p) => p.term);
        expect(ok?.term, `${w}の`).toBe(t.id);
        expect(ok?.text, `${w}の`).toBe(w);
        const kanjiEnd = /[\u4E00-\u9FFF]$/.test(w);
        const next = markInline(`${w}率`, [], new Set()).find(
          (p) => p.term && p.text.length >= w.length,
        );
        if (kanjiEnd) expect(next, `${w}率`).toBeUndefined();
        else expect(next?.term, `${w}率`).toBe(t.id);
      }
    }
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

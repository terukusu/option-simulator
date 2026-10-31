import { describe, expect, it } from 'vitest';
import { answerModel, type MarkedText, markInline } from '../../ui/view/aiText';
import type { TermId } from '../../ui/view/glossary';
import { manualIndex } from '../../ui/view/manual';
import { docRefs, resolveManualRef } from '../../ui/view/manualRefs';

/**
 * #322 AC4: AI の返答の根拠の節（「マニュアル 8.5「追証マップ」」など）の印と、押した後に索引から節を引く規則。
 * 合成のマニュアル（架空の見出し）と、実際のマニュアルの番号で確かめる。
 */

const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, enc: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const guide = fs.readFileSync(new URL('../../docs/user-guide.md', import.meta.url), 'utf8');
const INDEX = manualIndex(guide);

const refsOf = (s: string) =>
  docRefs(s).map((r) => [s.slice(r.start, r.end), r.doc, r.id, r.title]);

describe('docRefs（#322 AC4）', () => {
  it('「マニュアル N.N「見出し」」・並べた 2 つ目以降・「マニュアルの N 章」・設計書', () => {
    expect(refsOf('根拠はマニュアル 8.5「追証マップ」です')).toEqual([
      ['マニュアル 8.5「追証マップ」', 'manual', '8.5', '追証マップ'],
    ]);
    expect(refsOf('（マニュアル 8.1「タイル」・8.3「テール表」、8.4）')).toEqual([
      ['マニュアル 8.1「タイル」', 'manual', '8.1', 'タイル'],
      ['8.3「テール表」', 'manual', '8.3', 'テール表'],
      ['8.4', 'manual', '8.4', null],
    ]);
    expect(refsOf('マニュアルの 10 章と 16 章を見る')).toEqual([
      ['マニュアルの 10 章', 'manual', '10', null],
      ['16 章', 'manual', '16', null],
    ]);
    expect(refsOf('設計書 5.4「スキュー」と マニュアル 8.5')).toEqual([
      ['設計書 5.4「スキュー」', 'design', '5.4', 'スキュー'],
      ['マニュアル 8.5', 'manual', '8.5', null],
    ]);
    // 見出しの中の「」（1 段）
    expect(refsOf('マニュアル 10.7「「今」の点とシナリオの水準」')).toEqual([
      [
        'マニュアル 10.7「「今」の点とシナリオの水準」',
        'manual',
        '10.7',
        '「今」の点とシナリオの水準',
      ],
    ]);
    // 並べた後の値（「と 3 日」）は節にしない。文書の名前の無い番号も節にしない
    expect(refsOf('マニュアル 8.5 と 3 日後に 8.3 を見る')).toEqual([
      ['マニュアル 8.5', 'manual', '8.5', null],
    ]);
  });

  it('1 つ目も番号だけ（小数点・「章」・「見出し」なし）は節にしない（数を押せる印にしない。レビュー指摘 3）', () => {
    expect(refsOf('マニュアルの 3 つの節を読みました')).toEqual([]);
    expect(refsOf('マニュアル 2 か所に書かれています')).toEqual([]);
    expect(refsOf('マニュアル 8 を見る')).toEqual([]);
    expect(refsOf('設計書の 2 つの章')).toEqual([]);
    // 外した後も続きの文の根拠の節は拾う
    expect(refsOf('マニュアルの 3 つの節（マニュアル 8.5「追証マップ」・10 章）')).toEqual([
      ['マニュアル 8.5「追証マップ」', 'manual', '8.5', '追証マップ'],
      ['10 章', 'manual', '10', null],
    ]);
    // 「章」か「見出し」があれば番号 1 つでも節
    expect(refsOf('マニュアル 8「数字の読み方」')).toEqual([
      ['マニュアル 8「数字の読み方」', 'manual', '8', '数字の読み方'],
    ]);
  });
});

describe('resolveManualRef（#322 AC4）', () => {
  const idx = manualIndex(
    ['## 1. 章', '### 追証マップ', '### テール表', '## 2. 次', '### 同じ', '### 同じ'].join('\n'),
  );
  const get = (id: string, title: string | null) =>
    resolveManualRef(idx, { id, title })?.anchor ?? null;

  it('番号と見出しが合えばその節。番号だけ（「1 章」）は番号で引く', () => {
    expect(get('1.1', '追証マップ')).toBe('追証マップ');
    expect(get('1', null)).toBe('1-章');
    expect(get('1.2', null)).toBe('テール表');
    // 全角・空白の違いは同じ見出し
    expect(get('1.2', 'テール 表')).toBe('テール表');
  });

  it('番号と見出しが食い違えば見出しで引く（文書が変わった後の古い返答）', () => {
    expect(get('1.2', '追証マップ')).toBe('追証マップ');
    expect(get('9.9', 'テール表')).toBe('テール表');
  });

  it('どちらでも見つからなければ null（カードに「マニュアルに見つからない」）。同じ見出しが 2 つなら見出しでは引かない', () => {
    expect(get('9.9', '無い節')).toBeNull();
    expect(get('9.9', null)).toBeNull();
    expect(get('1.1', '同じ')).toBeNull();
  });

  it('実際のマニュアル: 8.5「追証マップ」・8.1「タイル」・10 章', () => {
    expect(resolveManualRef(INDEX, { id: '8.5', title: '追証マップ' })?.anchor).toBe('追証マップ');
    expect(resolveManualRef(INDEX, { id: '8.1', title: 'タイル' })?.anchor).toBe('タイル');
    expect(resolveManualRef(INDEX, { id: '10', title: null })?.level).toBe(2);
    expect(resolveManualRef(INDEX, { id: '10.7', title: '「今」の点とシナリオの水準' })?.id).toBe(
      '10.7',
    );
  });
});

describe('返答の根拠の節の印（#322 AC4）', () => {
  const plain = (xs: MarkedText[]) => xs.map((x) => x.text).join('');

  it('マニュアルの根拠の節は印（番号と見出し）、設計書は文字のまま', () => {
    const s = '（マニュアル 8.1「タイル」・8.3「テール表」、設計書 5.4「スキュー」）';
    const xs = markInline(s, [], new Set<TermId>(), true);
    expect(plain(xs)).toBe(s);
    expect(xs.filter((x) => x.manual).map((x) => [x.text, x.manual])).toEqual([
      ['マニュアル 8.1「タイル」', { id: '8.1', title: 'タイル' }],
      ['8.3「テール表」', { id: '8.3', title: 'テール表' }],
    ]);
  });

  it('「マニュアルの 3 つの節」「マニュアル 2 か所」は印にしない（レビュー指摘 3）', () => {
    for (const s of ['マニュアルの 3 つの節を読みました', 'マニュアル 2 か所に書かれています']) {
      const xs = markInline(s, [], new Set<TermId>(), true);
      expect(plain(xs)).toBe(s);
      expect(xs.some((x) => x.manual)).toBe(false);
    }
  });

  it('根拠の節の中の用語には印を付けない。外の用語・照合できない数字は今と同じ', () => {
    const s = 'マニュアル 8.5「追証マップ」によると追証マップで 1,234 千円';
    const xs = markInline(s, [], new Set<TermId>(), true);
    expect(xs.filter((x) => x.manual).map((x) => x.text)).toEqual(['マニュアル 8.5「追証マップ」']);
    // 外の「追証マップ」に用語の最初の印
    expect(xs.filter((x) => x.term).map((x) => [x.text, x.term])).toEqual([
      ['追証マップ', 'hold-map'],
    ]);
    expect(xs.filter((x) => x.unmatched).map((x) => x.text)).toEqual(['1,234 千円']);
    // refs を渡さなければ今と同じ（根拠の節の印なし）
    const old = markInline(s, [], new Set<TermId>());
    expect(old.some((x) => x.manual)).toBe(false);
    expect(old.filter((x) => x.term).map((x) => x.text)).toEqual(['追証マップ']);
    expect(old.filter((x) => x.unmatched).map((x) => x.text)).toEqual(['1,234 千円']);
  });

  it('answerModel: 段落・箇条書き・表・見出しの根拠の節に印が付く', () => {
    const text = [
      '## マニュアル 8.5「追証マップ」の見方',
      '- 根拠: マニュアルの 10 章',
      '',
      '| 節 | 値 |',
      '|---|---|',
      '| マニュアル 8.3「テール表」 | 1 |',
      '',
      '以上（設計書 5.4）',
    ].join('\n');
    const bs = answerModel(text, []);
    const refs: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) for (const x of v) walk(x);
      else if (v !== null && typeof v === 'object') {
        const m = v as { manual?: { id: string }; text?: string };
        if (m.manual && m.text !== undefined) refs.push(m.text);
        for (const x of Object.values(v)) walk(x);
      }
    };
    walk(bs);
    expect(refs).toEqual([
      'マニュアル 8.5「追証マップ」',
      'マニュアルの 10 章',
      'マニュアル 8.3「テール表」',
    ]);
  });
});

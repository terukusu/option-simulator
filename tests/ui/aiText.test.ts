import { describe, expect, it } from 'vitest';
import {
  answerModel,
  inlineOf,
  type MarkedBlock,
  markNumbers,
  parseAiText,
  type TextBlock,
  tableCells,
} from '../../ui/view/aiText';

/** #135: AI の返答の文字列 → 木（HTML を作らない）と、照合できない数字の印。値は架空。 */

describe('parseAiText', () => {
  it('見出し・箇条書き・番号つき・段落・太字', () => {
    const t = [
      '## 弱点 1: **下落**',
      '−10% で損が膨らむ。',
      '続きの行',
      '',
      '- 一つ目',
      '- 二つ目',
      '1. 番号',
      '### 小見出し',
      '<script>alert(1)</script>',
    ].join('\n');
    expect(parseAiText(t)).toEqual([
      {
        kind: 'h',
        level: 2,
        inl: [
          { text: '弱点 1: ', bold: false },
          { text: '下落', bold: true },
        ],
      },
      { kind: 'p', inl: [{ text: '−10% で損が膨らむ。\n続きの行', bold: false }] },
      {
        kind: 'ul',
        items: [[{ text: '一つ目', bold: false }], [{ text: '二つ目', bold: false }]],
      },
      { kind: 'ol', items: [[{ text: '番号', bold: false }]] },
      { kind: 'h', level: 3, inl: [{ text: '小見出し', bold: false }] },
      // HTML は文字のまま（JSX のテキストで描く）
      { kind: 'p', inl: [{ text: '<script>alert(1)</script>', bold: false }] },
    ]);
  });

  it('閉じていない ** は文字のまま・空文字', () => {
    expect(inlineOf('a **b')).toEqual([{ text: 'a **b', bold: false }]);
    expect(parseAiText('')).toEqual([]);
  });
});

describe('markNumbers', () => {
  it('照合できない数字だけを分ける', () => {
    const src = [{ rows: [{ sq_pnl_yen: -1234567 }] }];
    expect(markNumbers('損は 1,235 千円、別に 999 千円', src)).toEqual([
      { text: '損は 1,235 千円、別に ', unmatched: false },
      { text: '999 千円', unmatched: true },
    ]);
    expect(markNumbers('数字なし', src)).toEqual([{ text: '数字なし', unmatched: false }]);
  });
});

/** #234: 返答の Markdown の表。値は架空。 */
const plain = (xs: { text: string }[]) => xs.map((x) => x.text).join('');
const cellsOf = (b: TextBlock | undefined) => {
  if (b?.kind !== 'table') throw new Error(`表でない: ${b?.kind}`);
  return { head: b.head.map(plain), rows: b.rows.map((r) => r.map(plain)), num: b.num };
};

describe('parseAiText の表（#234）', () => {
  const TABLE = [
    '比べると:',
    '| 足 | 今の建値 | 今の板で建てた場合の建値 |',
    '|:---|---:|:-:|',
    '| P 62,000 の売り（11 月限、期近で一番建玉の多い行使価格） | 120 円 | 135 円 |',
    '| C 70,000 の **買い** | −35 円 | — |',
    '',
    '- 後ろの箇条書き',
  ].join('\n');

  it('見出し・区切り・本文 → table。数字の列の判定・区切りの : は読み捨て・前後のブロックは今と同じ', () => {
    const b = parseAiText(TABLE);
    expect(b.map((x) => x.kind)).toEqual(['p', 'table', 'ul']);
    expect(cellsOf(b[1])).toEqual({
      head: ['足', '今の建値', '今の板で建てた場合の建値'],
      rows: [
        ['P 62,000 の売り（11 月限、期近で一番建玉の多い行使価格）', '120 円', '135 円'],
        ['C 70,000 の 買い', '−35 円', '—'],
      ],
      num: [false, true, true],
    });
    // セルの太字
    const t = b[1] as Extract<TextBlock, { kind: 'table' }>;
    expect(t.rows[1]?.[0]).toEqual([
      { text: 'C 70,000 の ', bold: false },
      { text: '買い', bold: true },
    ]);
  });

  it('セルの分け方（\\| と末尾の | の省略）', () => {
    expect(tableCells('| a \\| b | c |')).toEqual(['a | b', 'c']);
    expect(tableCells('| a | b')).toEqual(['a', 'b']);
    expect(tableCells('|  | b |')).toEqual(['', 'b']);
  });

  it('コードの中の | はセルの文字、閉じていない ` は文字（レビュー指摘 8）', () => {
    expect(tableCells('| `x|y` | b |')).toEqual(['`x|y`', 'b']);
    expect(tableCells('| `x\\|y` | b |')).toEqual(['`x|y`', 'b']);
    expect(tableCells('| a ` b | c |')).toEqual(['a ` b', 'c']);
    const b = parseAiText(['| 式 | 値 |', '|---|---|', '| `max(a|b)` | 1 |'].join('\n'));
    expect(cellsOf(b[0]).rows).toEqual([['`max(a|b)`', '1']]);
  });

  it('| だけの行は表の行にしない（レビュー指摘 9）', () => {
    const b = parseAiText(['| a |', '|-|', '| 1 |', '|'].join('\n'));
    expect(b.map((x) => x.kind)).toEqual(['table', 'p']);
    expect(cellsOf(b[0]).rows).toEqual([['1']]);
    expect(b[1]).toEqual({ kind: 'p', inl: [{ text: '|', bold: false }] });
    // 流れの途中の | だけの最後の行は出さない
    expect(parseAiText(['| a |', '|-|', '| 1 |', '|'].join('\n'), true).map((x) => x.kind)).toEqual(
      ['table'],
    );
  });

  it('数字の列: 単位つき・符号・全角・空。文字が 1 つでもあれば文字の列、空だけの列は文字の列', () => {
    const b = parseAiText(
      [
        '| a | b | c | d |',
        '|---|---|---|---|',
        '| ＋１２ 千円 | 5pt | 約 3 円 | |',
        '| 1.5 倍 | −10% | 4 | |',
      ].join('\n'),
    );
    expect(cellsOf(b[0]).num).toEqual([true, true, false, false]);
  });

  it('本文の列数の合わない行から後だけを表の後の文字に（途中で切れた最後の行・崩れた行。表全体は文字に戻さない）', () => {
    // 失敗・上限で止まった返答（live でない）の欠けた最後の行
    const cut = parseAiText(['| a | b |', '|---|---|', '| 1 | 2 |', '| 3'].join('\n'));
    expect(cut.map((x) => x.kind)).toEqual(['table', 'p']);
    expect(cellsOf(cut[0]).rows).toEqual([['1', '2']]);
    expect(cut[1]).toEqual({ kind: 'p', inl: [{ text: '| 3', bold: false }] });
    // 列数の合わない行の後の `|` の行も文字（表は 1 つ）
    const bad = parseAiText(
      ['| a | b |', '|---|---|', '| 1 | 2 |', '| 1 | 2 | 3 |', '| 4 | 5 |', '後の文'].join('\n'),
    );
    expect(bad.map((x) => x.kind)).toEqual(['table', 'p']);
    expect(cellsOf(bad[0]).rows).toEqual([['1', '2']]);
    expect(bad[1]).toEqual({
      kind: 'p',
      inl: [{ text: '| 1 | 2 | 3 |\n| 4 | 5 |\n後の文', bold: false }],
    });
    // 流れの途中で列数の合わない行が来ても、それまでの表は表のまま
    const live = parseAiText(
      ['| a | b |', '|---|---|', '| 1 | 2 |', '| x | y | z |', ''].join('\n'),
      true,
    );
    expect(live.map((x) => x.kind)).toEqual(['table', 'p']);
    expect(cellsOf(live[0]).rows).toEqual([['1', '2']]);
  });

  it('崩れた表は今どおり段落の文字（区切りなし・区切りの列数違い）', () => {
    for (const t of [
      ['| a | b |', '| 1 | 2 |'],
      ['| a | b |', '|---|---|---|', '| 1 | 2 |'],
    ]) {
      const text = t.join('\n');
      expect(parseAiText(text)).toEqual([{ kind: 'p', inl: [{ text, bold: false }] }]);
    }
  });

  it('表の直後に段落が続く・2 つの表', () => {
    const b = parseAiText(
      ['| a |', '|---|', '| 1 |', '続き', '| x | y |', '|-|-|', '| 2 | 3 |'].join('\n'),
    );
    expect(b.map((x) => x.kind)).toEqual(['table', 'p', 'table']);
  });

  it('流れの途中（live）: 改行で終わらない最後の行・区切り待ちの見出しは出さない。終われば全部', () => {
    const head = '前の文\n| a | b |';
    expect(parseAiText(head, true).map((x) => x.kind)).toEqual(['p']);
    expect(parseAiText(`${head}\n`, true).map((x) => x.kind)).toEqual(['p']);
    expect(parseAiText(`${head}\n|--`, true).map((x) => x.kind)).toEqual(['p']);
    const sep = `${head}\n|---|---|\n`;
    expect(cellsOf(parseAiText(sep, true)[1]).rows).toEqual([]);
    expect(cellsOf(parseAiText(`${sep}| 1 | 2`, true)[1]).rows).toEqual([]);
    expect(cellsOf(parseAiText(`${sep}| 1 | 2 |\n`, true)[1]).rows).toEqual([['1', '2']]);
    // 流れ終わり（live でない）は最後の行も出す
    expect(cellsOf(parseAiText(`${sep}| 1 | 2`)[1]).rows).toEqual([['1', '2']]);
    // 表でない文の途中は今どおり出す
    expect(parseAiText('書きかけの文', true)).toEqual([
      { kind: 'p', inl: [{ text: '書きかけの文', bold: false }] },
    ]);
  });

  it('表のセルに照合の印と用語の印が付く（answerModel）', () => {
    const src = [{ rows: [{ sq_pnl_yen: -1234567 }] }];
    const b = answerModel(
      ['| 条件 | 損益 |', '|---|---|', '| IV +5pt | −1,235 千円 |', '| 下げ | −999 千円 |'].join(
        '\n',
      ),
      src,
    );
    const t = b[0] as Extract<MarkedBlock, { kind: 'table' }>;
    expect(t.num).toEqual([false, true]);
    expect(t.rows[0]?.[0]?.[0]?.parts[0]).toEqual({ text: 'IV', unmatched: false, term: 'iv' });
    expect(t.rows[0]?.[1]?.[0]?.parts).toEqual([{ text: '−1,235 千円', unmatched: false }]);
    expect(t.rows[1]?.[1]?.[0]?.parts).toEqual([{ text: '−999 千円', unmatched: true }]);
  });
});

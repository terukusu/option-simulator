import { describe, expect, it } from 'vitest';
import { inlineOf, markNumbers, parseAiText } from '../../ui/view/aiText';

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

import { describe, expect, it } from 'vitest';
import { checkNumbers, collectValues, sectionsOf } from '../../ui/view/aiNumbers';

/**
 * #135 AC2: AI の返答の数字の照合（ui/view/aiNumbers.ts）。返答の数値トークンを、その会話の context・ツールの結果の
 * 数値と丸めの規則で照合する。値は架空。
 */

const SOURCES = [
  {
    position: { legs: [{ k: 29000, qty: 2, price: 120 }] },
    scenario: { days: 5, iv_shift_pt: -2 },
  },
  {
    expiry: { max_loss_yen: -617234, breakevens_x: [28512] },
    greeks_now: { delta_large: -0.45, delta_mini: -4.5, theta_yen_per_day: 12345 },
    rows: [
      { shock_pct: -10, x: 27000, sq_pnl_yen: -1234567, sq_ratio: -5.2 },
      { shock_pct: -20, x: 24000, sq_pnl_yen: -617499 },
      { shock_pct: -30, x: 21000, sq_pnl_yen: -617500 },
    ],
    smile: { atm_iv_pct: 18.5, put5_minus_atm_pt: 2.3 },
    days_to_sq: 25.5,
  },
];

const statusOf = (text: string) => checkNumbers(text, SOURCES).tokens.map((t) => t.status);

describe('collectValues', () => {
  it('キーの名前から単位を決める（円・水準・%・pt・枚・日・倍）', () => {
    const vs = collectValues(SOURCES);
    const cls = (v: number) => vs.filter((x) => x.value === v).map((x) => x.cls);
    expect(cls(-617234)).toEqual(['money']);
    expect(cls(28512)).toEqual(['level']);
    expect(cls(29000)).toEqual(['level']);
    expect(cls(18.5)).toEqual(['pct']);
    expect(cls(2.3)).toEqual(['pt']);
    expect(cls(-0.45)).toEqual(['lots']);
    expect(cls(25.5)).toEqual(['days']);
    expect(cls(-5.2)).toEqual(['ratio']);
    expect(cls(2)).toEqual(['lots']);
  });
});

describe('checkNumbers', () => {
  it('#200: 分位の名前（下位 10%・上位 10%・p90・10〜90% の幅）は数えない', () => {
    const src = [{ median_pct: -0.4, p10_pct: -3.3 }];
    const r = checkNumbers('下位 10% は -3.3%、上位 10% と p90、10〜90% の幅。中央値 -0.4%', src);
    expect(r.unmatched).toBe(0);
    expect(r.matched).toBe(2);
    // 表の見出しの「10% 点」「90%点」も名前
    expect(checkNumbers('| 中央値 | 10% 点 | 90%点 |', src).unmatched).toBe(0);
    // 名前でない 90% は数える
    expect(checkNumbers('上げ幅は 90% です', src).unmatched).toBe(1);
  });
  it('円・千円・万円への丸め（四捨五入。境界）', () => {
    expect(statusOf('最大損失は -617,234 円')).toEqual(['matched']);
    expect(statusOf('最大損失は 617 千円')).toEqual(['matched']);
    expect(statusOf('約 62 万円')).toEqual(['matched']);
    expect(statusOf('617.2 千円')).toEqual(['matched']);
    // 617,499 → 617 千円 / 617,500 → 618 千円
    expect(checkNumbers('−20% で 617 千円', SOURCES).tokens[1]?.status).toBe('matched');
    expect(checkNumbers('−30% で 618 千円', SOURCES).tokens[1]?.status).toBe('matched');
    expect(checkNumbers('−20% で 616 千円', SOURCES).tokens[1]?.status).toBe('unmatched');
    expect(statusOf('123.5 万円')).toEqual(['matched']);
  });

  it('符号: − / ▲ / + は向きを照合する。言葉（損失）なら絶対値', () => {
    expect(statusOf('−617 千円')).toEqual(['matched']);
    expect(statusOf('▲617 千円')).toEqual(['matched']);
    expect(statusOf('+617 千円')).toEqual(['unmatched']);
    expect(statusOf('損失 1,235 千円')).toEqual(['matched']);
    expect(statusOf('Θ は +12,345 円')).toEqual(['matched']);
  });

  it('pt・%・枚・日・倍', () => {
    expect(statusOf('ATM の IV は 18.5%')).toEqual(['matched']);
    expect(statusOf('ATM より 2.3pt 高い')).toEqual(['matched']);
    expect(statusOf('IV を 2 ポイント下げた')).toEqual(['matched']);
    expect(statusOf('Δ は -0.45 枚（ミニ -4.5 枚）')).toEqual(['matched', 'matched']);
    expect(statusOf('SQ まで 25.5 日')).toEqual(['matched']);
    expect(statusOf('受取の 5.2 倍の損')).toEqual(['matched']);
    expect(statusOf('受取の ×5.2')).toEqual(['matched']);
    expect(statusOf('−10% で')).toEqual(['matched']);
    // 単位の違う値とは一致しない（25.5 は日。% には無い）
    expect(statusOf('25.5%')).toEqual(['unmatched']);
  });

  it('全角の数字・記号', () => {
    expect(statusOf('−６１７ 千円')).toEqual(['matched']);
    expect(statusOf('１８．５％')).toEqual(['matched']);
    expect(statusOf('２９，０００ 円')).toEqual(['matched']);
  });

  it('行使価格・原資産（円・単位なし）', () => {
    expect(statusOf('29,000 の put')).toEqual(['matched']);
    expect(statusOf('BEP は 28,512 円')).toEqual(['matched']);
    expect(statusOf('27,000 円まで下げると')).toEqual(['matched']);
    expect(statusOf('28,000 円まで下げると')).toEqual(['unmatched']);
  });

  it('日付・限月・番号・数の言葉・あたりは ignored（理由つき）', () => {
    const r = checkNumbers(
      [
        '## 弱点 1: 下に弱い',
        '1. 2026-11-13 の SQ（11 月限）',
        '2026 年 11/13 の 9:00',
        '3 つの弱点',
        'Γ は原資産 100 円あたり、Θ は 1 日あたり',
      ].join('\n'),
      SOURCES,
    );
    const ig = r.tokens.filter((t) => t.status === 'ignored').map((t) => [t.raw.trim(), t.reason]);
    expect(ig).toEqual([
      ['1', 'number'],
      ['1', 'number'],
      ['2026-11-13', 'date'],
      ['11', 'month'],
      ['2026', 'date'],
      ['11/13', 'date'],
      ['9:00', 'time'],
      ['3', 'count'],
      ['100 円', 'per_unit'],
      ['1 日', 'per_unit'],
    ]);
    expect(r.unmatched).toBe(0);
  });

  it('不一致の検出と件数・空文字', () => {
    const r = checkNumbers('損失は 999 千円、IV は 31%、Δ は -0.45 枚', SOURCES);
    expect(r.tokens.map((t) => t.status)).toEqual(['unmatched', 'unmatched', 'matched']);
    expect([r.unmatched, r.matched]).toEqual([2, 1]);
    expect(checkNumbers('', SOURCES)).toEqual({ tokens: [], unmatched: 0, matched: 0 });
    expect(checkNumbers('数字なし', [])).toEqual({ tokens: [], unmatched: 0, matched: 0 });
  });

  it('位置（start / end）は元の文字列の添字', () => {
    const text = '最大損失は −617 千円です';
    const t = checkNumbers(text, SOURCES).tokens[0];
    expect(t && text.slice(t.start, t.end)).toBe('−617 千円');
  });

  it('同じ入力 → 同じ出力', () => {
    const text = '−10% で 1,235 千円の損';
    expect(checkNumbers(text, SOURCES)).toEqual(checkNumbers(text, structuredClone(SOURCES)));
  });
});

describe('#135 評価で見つけた書き方', () => {
  it('箇条書きの「- 」は符号にしない・「/ 原資産 100 円」・「2 週間」・スマイルの m を %', () => {
    const src = [...SOURCES, { smile: [{ m: 0.15, iv: 25.4 }] }];
    const r = checkNumbers(
      '- 25.5 日後に\nΓ（−0.005 / 原資産 100 円）\n2 週間後\n+15% で 25.4%',
      src,
    );
    expect(r.tokens.map((t) => [t.raw, t.status])).toEqual([
      ['25.5 日', 'matched'],
      ['−0.005', 'unmatched'],
      ['100 円', 'ignored'],
      ['2', 'ignored'],
      ['+15%', 'matched'],
      ['25.4%', 'matched'],
    ]);
  });
});

describe('#136 文書の節の番号', () => {
  it('「マニュアル 8.1」「設計書 5.6」「マニュアルの 10 章」の番号は数えない（値は今どおり照合）', () => {
    const r = checkNumbers(
      '根拠はマニュアル 8.1「タイル」と設計書 5.6.1「単位」、マニュアルの 10 章。値は 1,235 千円',
      [{ pnl_yen: -1_234_567 }],
    );
    const st = r.tokens.map((t) => [t.raw, t.status, t.reason ?? null]);
    expect(st).toEqual([
      ['8.1', 'ignored', 'number'],
      ['5.6', 'ignored', 'number'],
      ['10', 'ignored', 'number'],
      ['1,235 千円', 'matched', null],
    ]);
    // 文書の名前の無い数は今どおり照合する
    expect(checkNumbers('8.1 の値', []).unmatched).toBe(1);
  });

  it('レビュー指摘 4: 並べた 2 つ目以降の節の番号も数えない（「・」「、」「と」）', () => {
    const r = checkNumbers(
      'マニュアル 8.1「タイル」・8.3「テール表」と設計書 5.6、5.10。マニュアル 8 章と 10 章',
      [],
    );
    expect(r.unmatched).toBe(0);
    expect(r.tokens.every((t) => t.status === 'ignored' && t.reason === 'number')).toBe(true);
    // 節の並びの後の値は今どおり照合する（「マニュアル 8.1 によると 1,235 千円」）
    const v = checkNumbers('マニュアル 8.1 によると損失は 1,235 千円', [{ pnl_yen: -1_234_567 }]);
    expect(v.tokens.map((t) => t.status)).toEqual(['ignored', 'matched']);
    expect(checkNumbers('マニュアル 8.1 によると損失は 999 千円', []).unmatched).toBe(1);
  });

  it('Γ の単位の 100 円（「/ 100 円」「/100円」「100 円動いた」）は数えない。ほかの 100 円は照合する', () => {
    const src = [{ gamma_per_100: 0.012 }];
    for (const t of [
      'Γ は +0.012 / 100 円です',
      'Γ は +0.012/100円',
      '原資産が 100 円動いたときの Δ の変化',
      '原資産が 100 円上がると',
      '100 円の変化あたり',
    ]) {
      expect(checkNumbers(t, src).unmatched, t).toBe(0);
    }
    // 符号つき・100 以外・動きの言葉が無い 100 円は数える（本物の値の取り違えは見逃さない）
    expect(checkNumbers('損益は −100 円動いた', []).unmatched).toBe(1);
    expect(checkNumbers('原資産が 200 円動いたとき', []).unmatched).toBe(1);
    expect(checkNumbers('損益は 100 円です', []).unmatched).toBe(1);
  });
});

describe('sectionsOf', () => {
  it('## 弱点 の節ごとに照合が一致した数の数', () => {
    const text = [
      '## 弱点 1: 下落',
      '−10% で 1,235 千円の損。',
      '## 弱点 2: IV',
      'IV が上がると損（数字なし）',
      '## 確かめるとよいこと',
      '−10% で',
    ].join('\n');
    const s = sectionsOf(text, SOURCES);
    expect(s.map((x) => [x.title, x.weakness, x.matched])).toEqual([
      ['弱点 1: 下落', true, 2],
      ['弱点 2: IV', true, 0],
      ['確かめるとよいこと', false, 1],
    ]);
  });
});

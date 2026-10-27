import { describe, expect, it } from 'vitest';
import { boardOptionLeg, boardOptionLegOnly, normalizeChain } from '../../data';
import type { Leg, OptionLeg } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import type { UiLeg } from '../../ui/state';
import {
  boardRows,
  displayRows,
  jumpToDelta,
  jumpToOtm,
  referencePrice,
  rowMarkLabels,
  sideMarkLabels,
} from '../../ui/view/board';
import {
  BOARD_COLUMN_HEADS,
  BOARD_FLASH_MS,
  BOARD_FOOT_MARKS,
  BOARD_HINT,
  BOARD_MARK_SHORT,
  boardBadges,
  boardChips,
  boardFoot,
  boardKPop,
  boardPanelColumns,
  boardRowTexts,
  fmtNumFast,
  marketAddLabel,
  marketAddPlan,
  marketAddToast,
  monthSegOptions,
  quoteLabel,
  sqShort,
} from '../../ui/view/boardPanel';
import { fairView } from '../../ui/view/fairValue';
import { fmtIvPct, fmtNum } from '../../ui/view/format';
import { headerModel } from '../../ui/view/header';
import { fixture } from '../support/fixtures';

/** #85 AC-2・AC-3: 新しい画面の板の表示モデル。合成の板・架空の値。 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months;
if (!m1 || !m2) throw new Error('限月が 2 つ要る');

describe('K のポップオーバー・title の理論価格（#264）', () => {
  const rows = boardRows(chain, m1);
  const texts = boardRowTexts(chain, m1, rows);

  it('行ごとの理論価格は 1 本ずつ求めた fairView と同じ文字列（板の全行を 1 回で求めても同じ）', () => {
    let n = 0;
    for (const r of rows) {
      const t = texts.get(r.k);
      for (const type of ['call', 'put'] as const) {
        const want = fairView(m1, r.k, type, chain.r, r[type].bid, r[type].ask);
        expect(t?.[type].fair).toEqual(want);
        if (want) n++;
      }
    }
    expect(n).toBeGreaterThan(rows.length);
  });

  it('ポップオーバー: 見出し・OTM 側が先の 2 行（`K 種別 · 理論 N（IV・位置・外挿）`）・印の全文', () => {
    for (const r of rows) {
      const t = texts.get(r.k);
      if (!t) throw new Error('行の文字列が無い');
      const v = boardKPop(t);
      expect(v.head).toBe('理論価格（周りの行から）');
      const order = t.otm === 'put' ? (['put', 'call'] as const) : (['call', 'put'] as const);
      expect(t.otm).toBe(m1.strikes.find((s) => s.k === r.k)?.otmType);
      order.forEach((type, i) => {
        const f = t[type].fair;
        const line = v.lines[i];
        if (!f) expect(line).toEqual({ main: `${t.k} ${type} · 理論 —`, note: null });
        else {
          // 折れるのは「（」の前だけ（main と note はそれぞれ 1 つの塊）
          expect(line?.main).toBe(`${t.k} ${type} · 理論 ${f.price}`);
          expect(line?.note?.startsWith(`（IV ${f.iv}`)).toBe(true);
          expect(line?.note?.endsWith('）')).toBe(true);
          if (f.position) expect(line?.note).toContain(f.position);
          expect(line?.note?.includes('外挿')).toBe(f.extrapolated);
        }
      });
      // 印の全文: 行の印（IV 不安定・補間 / 外挿）と、種別ごとの気配なし・JPX の IV 欠損
      const want = [
        ...rowMarkLabels(r),
        ...order.flatMap((type) => sideMarkLabels(r[type]).map((m) => `${type} ${m}`)),
      ];
      expect(v.marks).toEqual(want);
    }
  });

  it('K の title: OTM 側の理論価格（位置・外挿）と補間 / 外挿の全文（IV 不安定は IV の列）', () => {
    for (const r of rows) {
      const t = texts.get(r.k);
      if (!t) throw new Error('行の文字列が無い');
      const f = t[t.otm].fair;
      const marks = rowMarkLabels(r).filter((m) => m !== 'IV 不安定');
      if (!f && marks.length === 0) {
        expect(t.kTitle).toBeNull();
        continue;
      }
      if (f) expect(t.kTitle?.startsWith(`${t.otm} 理論 ${f.price}`)).toBe(true);
      for (const m of marks) expect(t.kTitle).toContain(m);
    }
  });
});

describe('AC-2(a) 列の段階（section.board の幅）', () => {
  it.each([
    [540, 9],
    [576, 9],
    [539.9, 7],
    [432, 7],
    [410, 7],
    [409.9, 5],
    [360, 5],
    [0, 5],
    [-1, 5],
    [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5],
    [Number.NEGATIVE_INFINITY, 5],
  ])('幅 %s → %s 列', (w, want) => {
    expect(boardPanelColumns(w)).toBe(want);
  });
});

describe('AC-2(b) 列の見出し', () => {
  it('9 / 7 / 5 列の並び', () => {
    expect(BOARD_COLUMN_HEADS[9].join(' ')).toBe('Δ IV C bid C ask K P bid P ask IV Δ');
    expect(BOARD_COLUMN_HEADS[7].join(' ')).toBe('IV C bid C ask K P bid P ask IV');
    expect(BOARD_COLUMN_HEADS[5].join(' ')).toBe('K bid ask IV Δ');
  });
});

describe('AC-2(c) 行の文字列（旧 Board と同じ式）', () => {
  for (const m of chain.months) {
    it(`${m.id}: Δ = fmtNum(delta, 2)・IV = bidIv/askIv・行は displayRows の降順`, () => {
      const rows = boardRows(chain, m);
      const texts = boardRowTexts(chain, m, rows);
      expect(texts.size).toBe(rows.length);
      const desc = displayRows(rows);
      expect(desc.map((r) => r.k)).toEqual([...rows].map((r) => r.k).sort((a, b) => b - a));
      for (const r of desc) {
        const t = texts.get(r.k);
        expect(t).toBeDefined();
        if (!t) continue;
        expect(t.k).toBe(fmtNum(r.k));
        for (const type of ['put', 'call'] as const) {
          expect(t[type].delta).toBe(fmtNum(r[type].delta, 2));
          expect(t[type].iv).toBe(`${fmtIvPct(r[type].bidIv)}/${fmtIvPct(r[type].askIv)}`);
          expect(t[type].bid).toBe(fmtNum(r[type].bid));
          expect(t[type].ask).toBe(fmtNum(r[type].ask));
          expect(t[type].bidLabel).toBe(quoteLabel(r.k, type, 'sell', r[type].bid));
        }
      }
    });
  }

  it('bid / ask のボタンの aria-label は旧 QuoteButton と同じ文', () => {
    expect(quoteLabel(64000, 'put', 'sell', 740)).toBe('64,000 put bid 740 で売り');
    expect(quoteLabel(64000, 'call', 'buy', null)).toBe('64,000 call ask 気配なし で買い');
  });
});

describe('fmtNumFast は fmtNum と同じ文字列', () => {
  it('整数・小数・負・丸めて 0・中間・大きな値・欠損', () => {
    const vals: Array<number | null | undefined> = [
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -0,
      1,
      -1,
      12.5,
      0.125,
      -0.125,
      0.005,
      -0.004,
      -0.005,
      999.5,
      999.95,
      1000,
      1234.5678,
      -1234.5678,
      64000,
      123456789,
      1e21,
      2.675,
      1.005,
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 3000; i++) {
      vals.push((rnd() - 0.5) * 10 ** Math.floor(rnd() * 8));
      vals.push(Math.round(rnd() * 200000) / 8 - 5000);
    }
    for (const v of vals) {
      for (const d of [0, 1, 2]) expect(fmtNumFast(v, d)).toBe(fmtNum(v, d));
    }
  });
});

describe('AC-3(a) 印の短い形と全文', () => {
  const rows = boardRows(chain, m1);
  const texts = boardRowTexts(chain, m1, rows);

  it('行の印（IV 不安定・補間・外挿）は rowMarkLabels と同じ文言', () => {
    const seen = new Set<string>();
    for (const r of rows) {
      const t = texts.get(r.k);
      if (!t) throw new Error('行が無い');
      expect(t.marks.map((x) => x.full)).toEqual(rowMarkLabels(r));
      for (const x of t.marks) {
        expect(x.short).toBe(BOARD_MARK_SHORT[x.kind]);
        seen.add(`${x.kind}:${x.short}:${x.full}`);
      }
      expect(t.flagSide).toBe(
        r.unstable ? (m1.strikes.find((s) => s.k === r.k)?.otmType ?? null) : null,
      );
      expect(t.kMark).toBe(
        r.mark === 'interpolated' ? 'interp' : r.mark === 'extrapolated' ? 'extrap' : null,
      );
    }
    expect(seen).toEqual(
      new Set(['unstable:×:IV 不安定', 'interpolated:┄:補間', 'extrapolated:┄:外挿']),
    );
  });

  it('セルの印（気配なし・JPX の IV 欠損）は sideMarkLabels と同じ文言', () => {
    const seen = new Set<string>();
    for (const r of rows) {
      const t = texts.get(r.k);
      if (!t) throw new Error('行が無い');
      for (const type of ['put', 'call'] as const) {
        expect(t[type].marks.map((x) => x.full)).toEqual(sideMarkLabels(r[type]));
        expect(t[type].noQuote).toBe(r[type].noQuote);
        for (const x of t[type].marks) seen.add(`${x.kind}:${x.short}:${x.full}`);
      }
    }
    expect(seen).toEqual(new Set(['noQuote:—:気配なし', 'ivMissing:—/—:JPX の IV 欠損']));
  });

  it('ⓘ は bid / ask の 1 文、印の凡例は脚注（#276）', () => {
    expect(BOARD_HINT).toHaveLength(1);
    expect(BOARD_HINT[0]).toMatch(/^bid = 売り、ask = 買い で足を追加/);
    expect(BOARD_FOOT_MARKS).toBe('× 不安定 · 点線 補間/外挿');
  });
});

describe('AC-3(b) バッジ', () => {
  let id = 0;
  const opt = (expiry: string, k: number, type: 'put' | 'call', side: 'sell' | 'buy', qty = 1) =>
    ({
      id: ++id,
      marks: [],
      leg: {
        kind: 'option',
        product: 'op_large',
        type,
        expiry,
        strike: k,
        side,
        qty,
        entry: 100,
      } satisfies OptionLeg,
    }) as UiLeg;
  const fut: UiLeg = {
    id: 99,
    marks: [],
    leg: {
      kind: 'future',
      product: 'fut_large',
      contract: m1.id,
      side: 'sell',
      qty: 3,
      entry: 67000,
    } satisfies Leg,
  };

  it('売り 1 + 売り 2 + 買い 1 → 売3・買1。別の限月・別の種別・先物は数えない', () => {
    const legs = [
      opt(m1.id, 64000, 'put', 'sell', 1),
      opt(m1.id, 64000, 'put', 'sell', 2),
      opt(m1.id, 64000, 'put', 'buy', 1),
      opt(m2.id, 64000, 'put', 'sell', 5),
      opt(m1.id, 70000, 'call', 'buy', 2),
      fut,
    ];
    const b = boardBadges(legs, m1.id);
    expect(b.get(64000)).toEqual({ put: { sell: '売3', buy: '買1' } });
    expect(b.get(70000)).toEqual({ call: { sell: '', buy: '買2' } });
    expect(b.size).toBe(2);
    expect(boardBadges(legs, m2.id).get(64000)).toEqual({ put: { sell: '売5', buy: '' } });
  });

  it('足 0 本は空', () => {
    expect(boardBadges([], m1.id).size).toBe(0);
  });

  it('入力を変えない', () => {
    const legs = [opt(m1.id, 64000, 'put', 'sell', 1)];
    const before = JSON.stringify(legs);
    boardBadges(legs, m1.id);
    expect(JSON.stringify(legs)).toBe(before);
  });
});

describe('AC-3(c) チップ', () => {
  const rows = boardRows(chain, m1);
  const x0 = referencePrice(m1, 'B');

  it('OTM 4 つ・|Δ| 4 つの行き先は jumpToOtm・jumpToDelta と同じ K', () => {
    for (const target of ['put', 'call'] as const) {
      const chips = boardChips(rows, target, x0);
      expect(chips.map((c) => c.text)).toEqual([
        'OTM 10%',
        '20%',
        '30%',
        '40%',
        '|Δ| .05',
        '.10',
        '.20',
        '.30',
      ]);
      expect(chips.map((c) => c.label)).toEqual([
        'OTM 10% へ',
        'OTM 20% へ',
        'OTM 30% へ',
        'OTM 40% へ',
        '|Δ| 0.05 へ',
        '|Δ| 0.10 へ',
        '|Δ| 0.20 へ',
        '|Δ| 0.30 へ',
      ]);
      [0.1, 0.2, 0.3, 0.4].forEach((p, i) => {
        expect(chips[i]?.k).toBe(jumpToOtm(rows, target, x0, p));
        expect(chips[i]?.disabled).toBe(false);
      });
      [0.05, 0.1, 0.2, 0.3].forEach((d, i) => {
        expect(chips[4 + i]?.k).toBe(jumpToDelta(rows, target, d));
      });
      expect(new Set(chips.map((c) => c.key)).size).toBe(8);
    }
  });

  it('基準価格が無いと OTM のチップは押せない（|Δ| は押せる）', () => {
    const chips = boardChips(rows, 'put', null);
    expect(chips.slice(0, 4).every((c) => c.disabled && c.k === null)).toBe(true);
    expect(chips.slice(4).every((c) => !c.disabled)).toBe(true);
  });
});

describe('AC-3(d) 脚注', () => {
  it('F・ATM（基準）・SQ MM/DD・案内', () => {
    const header = headerModel(chain, 'B', CALENDAR);
    const hm = header.months[0];
    if (!hm) throw new Error('限月が無い');
    const f = boardFoot(hm, 'B');
    expect(f.f).toBe(`F ${hm.forward}`);
    expect(f.atm).toBe(`ATM ${hm.atm}（B）`);
    expect(f.sq).toBe(`SQ ${hm.sqDate.slice(5, 7)}/${hm.sqDate.slice(8, 10)}`);
    expect(f.marks).toBe(BOARD_FOOT_MARKS);
    expect(f.f).toMatch(/^F [0-9,]+ ±[0-9,]+$/);
  });

  it('F・ATM が無ければ「F なし」「ATM なし」だけ', () => {
    const hm = headerModel(chain, 'A', CALENDAR).months[0];
    if (!hm) throw new Error('限月が無い');
    const f = boardFoot(
      { ...hm, forward: 'F なし', noForward: true, atm: 'ATM なし', noAtm: true },
      'A',
    );
    expect(f.f).toBe('F なし');
    expect(f.atm).toBe('ATM なし');
  });

  it('sqShort', () => {
    expect(sqShort('2026-11-13')).toBe('11/13');
    expect(sqShort('—')).toBe('—');
  });
});

describe('AC-3(f) 限月の Seg', () => {
  it('合成の板の 2 限月: 文字 11月限・aria-label 2026-11 限', () => {
    expect(monthSegOptions(chain.months)).toEqual([
      { value: '2026-11', text: '11月限', label: '2026-11 限' },
      { value: '2026-12', text: '12月限', label: '2026-12 限' },
    ]);
  });

  it('同じ月番号が 2 つあれば年を付ける', () => {
    expect(monthSegOptions([{ id: '2026-11' }, { id: '2027-11' }]).map((o) => o.text)).toEqual([
      '26年11月限',
      '27年11月限',
    ]);
  });
});

describe('AC-3(e) 足を入れる・トーストの文', () => {
  const sell = (k: number, entry: number): OptionLeg => ({
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: m1.id,
    strike: k,
    side: 'sell',
    qty: 1,
    entry,
  });

  it('売り put 64,000・建値 740 → 売 P 64,000 @740 を追加', () => {
    expect(marketAddToast(sell(64000, 740))).toBe('売 P 64,000 @740 を追加');
  });

  it('marketAddLabel はトーストの文から「を追加」を除いたもの（#89 段 B のパレットの足の行と同じ）', () => {
    expect(marketAddLabel(sell(64000, 740))).toBe('売 P 64,000 @740');
    const leg: OptionLeg = { ...sell(71000, 12.5), type: 'call', side: 'buy' };
    expect(marketAddLabel(leg)).toBe('買 C 71,000 @12.5');
    expect(marketAddToast(leg)).toBe(`${marketAddLabel(leg)} を追加`);
  });

  it('買い call・建値 12.5 → 買 C … @12.5 を追加', () => {
    const leg: OptionLeg = { ...sell(71000, 12.5), type: 'call', side: 'buy' };
    expect(marketAddToast(leg)).toBe('買 C 71,000 @12.5 を追加');
  });

  it('marketAddPlan は boardOptionLeg と同じ足（作れなければ null）', () => {
    const k = m1.atm.B.pick?.k ?? 0;
    for (const type of ['put', 'call'] as const) {
      for (const side of ['sell', 'buy'] as const) {
        const input = { expiry: m1.id, k, type, side };
        expect(marketAddPlan(chain, input)).toEqual(boardOptionLeg(chain, input).leg);
      }
    }
    expect(marketAddPlan(chain, { expiry: m1.id, k: 1, type: 'put', side: 'sell' })).toBeNull();
    expect(marketAddPlan(chain, { expiry: '1999-01', k, type: 'put', side: 'sell' })).toBeNull();
    expect(marketAddPlan(null, { expiry: m1.id, k, type: 'put', side: 'sell' })).toBeNull();
  });

  it('marketAddPlan は全行（片側気配・気配なし = manualEntryDefault の経路を含む）で boardOptionLeg と同じ足。entry / qty の指定も同じ（#89 段 B）', () => {
    let manual = 0;
    let total = 0;
    for (const name of ['latest', 'night_early', 'pre_open'] as const) {
      const c = normalizeChain(fixture(name));
      for (const m of c.months) {
        for (const info of m.strikes) {
          for (const type of ['put', 'call'] as const) {
            for (const side of ['sell', 'buy'] as const) {
              const input = { expiry: m.id, k: info.k, type, side };
              const full = boardOptionLeg(c, input).leg;
              expect(marketAddPlan(c, input)).toEqual(full);
              total++;
              if (info[type].quote !== 'two_sided') manual++;
              const given = { ...input, entry: 123.5, qty: 3 };
              expect(boardOptionLegOnly(c, given)).toEqual(boardOptionLeg(c, given).leg);
            }
          }
        }
      }
    }
    // 片側気配・気配なしの行（建値は manualEntryDefault）も比べている
    expect(manual).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(manual);
  });

  it('強調は 0.9 秒', () => {
    expect(BOARD_FLASH_MS).toBe(900);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { black76Greeks, type OptionType } from '../../model';
import { buildWideChainJson, WIDE_STRIKE_COUNT } from '../../scripts/synthBoard';
import {
  ASK_FILTER_YEN,
  atmStrike,
  boardColumns,
  boardModel,
  boardRows,
  displayRows,
  FULL_BOARD_MIN_WIDTH,
  filterByAsk,
  jumpToDelta,
  jumpToOtm,
  referencePrice,
} from '../../ui/view/board';

/**
 * AC-9: 322 行の合成の板（scripts/synthBoard.ts の buildWideChainJson。内部で
 * tests/support/synthChain.ts を使う。値は架空）でのジャンプと絞り込み。
 * 期待値はテスト側で全行を総当たりして求める。
 */
const chain = normalizeChain(buildWideChainJson());

function argmin<T>(items: readonly T[], f: (t: T) => number | null): T | undefined {
  let best: T | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const v = f(it);
    if (v === null || !Number.isFinite(v)) continue;
    if (v < gap) {
      gap = v;
      best = it;
    }
  }
  return best;
}

describe.each(chain.months.map((m) => [m.id, m] as const))('322 行の板（%s）', (_id, month) => {
  const rows = boardRows(chain, month);

  it('行数が 322', () => {
    expect(rows).toHaveLength(WIDE_STRIKE_COUNT);
  });

  it.each(['A', 'B'] as const)('「ATM へ戻る」= 選択中の基準 %s の ATM 行', (basis) => {
    const k = atmStrike(month, basis);
    expect(k).toBe(month.atm[basis].pick?.k);
    expect(rows.some((r) => r.k === k)).toBe(true);
    expect(boardModel(chain, month, basis).atmK).toBe(k);
  });

  it.each<OptionType>(['put', 'call'])(
    '「OTM 度 30%%」（%s）= OTM 度が 0.30 に最も近い行',
    (type) => {
      const x0 = referencePrice(month, 'B') as number;
      expect(x0).toBeGreaterThan(0);
      const otm = (k: number) => (type === 'put' ? 1 - k / x0 : k / x0 - 1);
      const expected = argmin(month.strikes, (s) => Math.abs(otm(s.k) - 0.3))?.k;
      const got = jumpToOtm(rows, type, x0, 0.3);
      expect(got).toBe(expected);
      // 板の範囲（±20,000 円 ≈ ±30%）の中で 0.30 に近い
      expect(Math.abs(otm(got as number) - 0.3)).toBeLessThan(0.02);
    },
  );

  it.each<OptionType>(['put', 'call'])('「|Δ| 0.10」（%s）= |Δ| が 0.10 に最も近い行', (type) => {
    const expected = argmin(month.strikes, (s) => {
      if (s.smileIv === null) return null;
      const d = black76Greeks(type, month.F, s.k, month.T, s.smileIv, chain.r).delta;
      return Math.abs(Math.abs(d) - 0.1);
    })?.k;
    const got = jumpToDelta(rows, type, 0.1);
    expect(got).toBe(expected);
    const row = rows.find((r) => r.k === got);
    expect(Math.abs(Math.abs(row?.[type].delta as number) - 0.1)).toBeLessThan(0.01);
  });

  it.each<OptionType>(['put', 'call'])(
    '「ask ≤ 50 円」（%s）: 残る行はすべて 50 以下、欠けもない',
    (type) => {
      const kept = filterByAsk(rows, type);
      expect(kept.every((r) => (r[type].ask as number) <= ASK_FILTER_YEN)).toBe(true);
      const expected = month.source
        .filter((r) => r[type].ask !== null && (r[type].ask as number) <= ASK_FILTER_YEN)
        .map((r) => r.k);
      expect(kept.map((r) => r.k)).toEqual(expected);
      // 表示モデルは降順（#50）
      expect(boardModel(chain, month, 'B', { target: type, filterAsk: true }).rows).toEqual(
        displayRows(kept),
      );
    },
  );
});

describe.each(chain.months.map((m) => [m.id, m] as const))(
  '板の表示順は行使価格の降順（%s、#50）',
  (_id, month) => {
    const rows = boardRows(chain, month);
    const strictlyDesc = (ks: number[]) => ks.every((k, i) => i === 0 || k < (ks[i - 1] as number));

    it('表示順は行使価格の降順（行の集合は同じ・入力の配列を変えない）', () => {
      const before = rows.map((r) => r.k);
      const shown = displayRows(rows);
      expect(shown).toHaveLength(rows.length);
      expect(strictlyDesc(shown.map((r) => r.k))).toBe(true);
      expect(new Set(shown)).toEqual(new Set(rows)); // 行のオブジェクトは同じ参照
      expect(rows.map((r) => r.k)).toEqual(before); // データは昇順のまま
      expect(strictlyDesc(month.strikes.map((s) => s.k).reverse())).toBe(true);
    });

    it.each<OptionType>(['put', 'call'])('絞り込み（ask ≤ 50 円、%s）後も降順', (type) => {
      // 残る行がある限月は下の「残る行がある」で確認（遠い限月の put は 0 行のことがある）
      const kept = filterByAsk(displayRows(rows), type);
      expect(strictlyDesc(kept.map((r) => r.k))).toBe(true);
      expect(kept.map((r) => r.k)).toEqual(
        filterByAsk(rows, type)
          .map((r) => r.k)
          .reverse(),
      );
    });

    it('boardModel の行は降順', () => {
      const m = boardModel(chain, month, 'B');
      expect(strictlyDesc(m.rows.map((r) => r.k))).toBe(true);
      expect(m.rows).toHaveLength(rows.length);
    });

    it.each<OptionType>(['put', 'call'])(
      'ジャンプの行使価格は並び替えの前後で同じ（%s）',
      (type) => {
        const shown = displayRows(rows);
        const x0 = referencePrice(month, 'B');
        expect(jumpToOtm(shown, type, x0, 0.3)).toBe(jumpToOtm(rows, type, x0, 0.3));
        expect(jumpToDelta(shown, type, 0.1)).toBe(jumpToDelta(rows, type, 0.1));
        const atm = atmStrike(month, 'B');
        expect(shown.some((r) => r.k === atm)).toBe(true);
      },
    );
  },
);

it('「ask ≤ 50 円」で残る行がある（1 限月の put・call）', () => {
  const month = chain.months[0];
  if (!month) throw new Error('限月が無い');
  const rows = boardRows(chain, month);
  expect(filterByAsk(rows, 'put').length).toBeGreaterThan(0);
  expect(filterByAsk(rows, 'call').length).toBeGreaterThan(0);
});

describe('行のオブジェクトは基準に依らない（基準の切替で描き直す行を絞るため）', () => {
  it('boardRows は ATM の基準を受け取らず、Δ はスマイルの IV の Black-76', () => {
    const month = chain.months[0];
    if (!month) throw new Error('限月が無い');
    const rows = boardRows(chain, month);
    const i = month.strikes.findIndex((s) => s.k === month.atm.B.pick?.k);
    const s = month.strikes[i];
    const r = rows[i];
    expect(s?.smileIv).not.toBeNull();
    expect(r?.put.delta).toBeCloseTo(
      black76Greeks('put', month.F, s?.k as number, month.T, s?.smileIv as number, chain.r).delta,
      12,
    );
  });
});

describe('板の列の出し方（板の枠の幅で判定）', () => {
  it('枠が FULL_BOARD_MIN_WIDTH 未満なら compact、以上なら full、不明なら full', () => {
    expect(boardColumns(FULL_BOARD_MIN_WIDTH)).toBe('full');
    expect(boardColumns(FULL_BOARD_MIN_WIDTH - 1)).toBe('compact');
    expect(boardColumns(330)).toBe('compact'); // 幅 360px のスマホ
    expect(boardColumns(338)).toBe('compact'); // 幅 720px の 2 ペイン
    expect(boardColumns(680)).toBe('full'); // 幅 1400px の 2 ペイン
    expect(boardColumns(0)).toBe('full');
    expect(boardColumns(Number.NaN)).toBe('full');
    expect(boardColumns(500, 400)).toBe('full');
  });
});

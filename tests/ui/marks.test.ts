import { describe, expect, it } from 'vitest';
import { normalizeChain } from '../../data';
import { initialState, reduce } from '../../ui/state';
import { boardRows, rowMarkLabels, sideMarkLabels } from '../../ui/view/board';
import { positionModel } from '../../ui/view/position';
import { smileModel } from '../../ui/view/smile';
import { fixture } from '../support/fixtures';

/** AC-10: 印（AC16 の画面部分）。latest.json（合成・架空の値）。 */
describe('印', () => {
  const chain = normalizeChain(fixture('latest'));

  it('前提: latest に帯 > 5pt の不安定行が 3 本以上と ask ≤ 5 円の不安定行がある', () => {
    const nodes = chain.months.flatMap((m) => m.strikes.map((s) => s.node));
    const band = nodes.filter((n) => n?.unstable && (n.bandWidth ?? 0) > 0.05);
    expect(band.length).toBeGreaterThanOrEqual(3);
    const askLow = chain.months.flatMap((m) =>
      m.strikes.filter((s, i) => {
        const src = m.source[i];
        const ask = src?.[s.otmType].ask;
        return s.unstable && ask !== null && ask !== undefined && ask <= 5;
      }),
    );
    expect(askLow.length).toBeGreaterThan(0);
  });

  it('各限月の板とスマイルの両方に印', () => {
    let unstableCount = 0;
    let markCount = 0;
    let missingCount = 0;
    for (const month of chain.months) {
      const rows = boardRows(chain, month);
      const smile = smileModel(month, 'B', 'k');
      const unstableKs = new Set(smile.unstable.map((u) => u.k));
      const before = unstableCount;
      month.strikes.forEach((s, i) => {
        const row = rows[i];
        if (!row) throw new Error('行が無い');
        const labels = rowMarkLabels(row);
        expect(labels.includes('IV 不安定')).toBe(s.unstable);
        if (s.unstable) {
          unstableCount++;
          expect(unstableKs.has(s.k)).toBe(true);
        }
        expect(labels.includes('外挿')).toBe(s.mark === 'extrapolated');
        expect(labels.includes('補間')).toBe(s.mark === 'interpolated');
        if (s.mark === 'extrapolated' || s.mark === 'interpolated') markCount++;
        for (const t of ['call', 'put'] as const) {
          const side = sideMarkLabels(row[t]);
          expect(side.includes('JPX の IV 欠損')).toBe(s[t].jpxIvMissing);
          expect(side.includes('気配なし')).toBe(s[t].quote !== 'two_sided');
          if (s[t].jpxIvMissing) missingCount++;
        }
      });
      expect(unstableKs.size).toBe(unstableCount - before);
    }
    expect(unstableCount).toBeGreaterThan(0);
    expect(markCount).toBeGreaterThan(0);
    expect(missingCount).toBeGreaterThan(0);
  });

  it('不安定な行を足にすると、ポジションの行に警告', () => {
    const month = chain.months[0];
    const info = month?.strikes.find((s) => s.unstable && s.otmType === 'put');
    expect(info).toBeDefined();
    if (!month || !info) return;
    let s = reduce(initialState, { type: 'loaded', chain, label: 'latest' });
    s = reduce(s, {
      type: 'addBoardLeg',
      expiry: month.id,
      k: info.k,
      optionType: 'put',
      side: 'sell',
    });
    expect(s.legs[0]?.marks).toContain('unstable_iv');
    const row = positionModel(chain, s.legs, 'B').rows[0];
    expect(row?.markLabels).toContain('IV 不安定');
    expect(row?.warnings.some((w) => w.includes('IV 不安定'))).toBe(true);
  });
});

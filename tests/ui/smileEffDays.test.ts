import { describe, expect, it } from 'vitest';
import { boardOptionLeg, buildMarketContext, normalizeChain } from '../../data';
import { DEFAULT_MARGIN_PARAMS, DEFAULT_SETTINGS, type Scenario, ZERO_SCENARIO } from '../../model';
import { CALENDAR } from '../../ui/calendar';
import type { UiLeg } from '../../ui/state';
import { marginPointAt } from '../../ui/view/margin';
import { clampDays, clampScenarioDays, pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import { effAtNow, type SmileEffBase, smileEffPoints } from '../../ui/view/smileEff';
import { fixture } from '../support/fixtures';

/**
 * #260: 売りの効率の線の d はタイル（指標・証拠金）と同じ点 = clampDays で最遠の足の SQ に収めた d。
 * 足を消して scenario.days が上限を超えて残っても、画面に出ていない d で線を描かない（合成の板。架空の値）
 */
const chain = normalizeChain(fixture('latest'));
const m1 = chain.months[0];
const m2 = chain.months[1];
if (!m1 || !m2) throw new Error('合成の板に 2 限月が無い');
const effBase: SmileEffBase = {
  ctx: buildMarketContext(chain, { atmBasis: 'B' }),
  settings: DEFAULT_SETTINGS,
  params: DEFAULT_MARGIN_PARAMS,
  holidays: CALENDAR.holidays,
};

/** 期近の put 売り 1 本だけ（最遠の足の SQ = 期近の SQ） */
function nearOnlyBase(expiry: string) {
  const built = boardOptionLeg(chain, { expiry, k: 64000, type: 'put', side: 'sell' });
  const legs: UiLeg[] = [{ id: 1, ...built } as UiLeg];
  const pm = positionModel(chain, legs, 'B', CALENDAR, DEFAULT_SETTINGS);
  const base = pnlDomains(chain, pm.prepared, pm.ctx, DEFAULT_SETTINGS);
  if (!base) throw new Error('基礎が作れない');
  return base;
}

describe('効率の線の d をタイルと同じ点に収める（#260）', () => {
  const base = nearOnlyBase(m1.id);
  const over: Scenario = { ...ZERO_SCENARIO, days: base.maxDays + 15 };

  it('clampScenarioDays の d = タイルの点の d（marginPointAt）= clampDays', () => {
    const sc = clampScenarioDays(over, base.maxDays);
    expect(sc.days).toBe(marginPointAt(base, over).days);
    expect(sc.days).toBe(clampDays(over, base.maxDays).days);
    expect(sc.days).toBeLessThan(over.days);
    // d 以外は変えない
    expect({ ...sc, days: 0 }).toEqual({ ...over, days: 0 });
  });

  it('収める必要が無ければ同じ参照（線を作り直さない）', () => {
    const within: Scenario = { ...ZERO_SCENARIO, days: base.maxDays / 2 };
    expect(clampScenarioDays(within, base.maxDays)).toBe(within);
  });

  it('期先の限月の線: 収めた d で計算し、収める前の d の値とは違う', () => {
    const clamped = clampScenarioDays(over, base.maxDays);
    const atTile = smileEffPoints(m2, 'B', 'k', effBase, {
      ...over,
      days: marginPointAt(base, over).days,
    });
    const line = smileEffPoints(m2, 'B', 'k', effBase, clamped);
    const raw = smileEffPoints(m2, 'B', 'k', effBase, over);
    expect(line.length).toBeGreaterThan(0);
    expect(line).toEqual(atTile);
    const pick = (pts: typeof line) => pts.find((p) => p.k === 64000);
    const a = pick(line);
    const b = pick(raw);
    expect(a && b).toBeTruthy();
    expect(Math.abs((a?.eff ?? 0) - (b?.eff ?? 0))).toBeGreaterThan(1);
  });

  it('足 0 本（maxDays = 0）は d = 0 = 今（時間レールの表示と同じ）', () => {
    const sc = clampScenarioDays({ ...ZERO_SCENARIO, days: 10 }, 0);
    expect(sc.days).toBe(0);
    expect(effAtNow(sc)).toBe(true);
  });
});

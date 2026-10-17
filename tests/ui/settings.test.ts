/**
 * #87 (C) AC-7: 設定のダイアログの表示モデル（settingsModel）と手数料の欄（feeField）。
 * 板は合成の板（fixtures/synthetic の latest。架空の値）。
 */
import { describe, expect, it } from 'vitest';
import { buildCalendar, normalizeChain } from '../../data';
import bundledJson from '../../data/calendar/calendar.json';
import { CALENDAR } from '../../ui/calendar';
import { THEME_PREFS } from '../../ui/prefs';
import { parseFee } from '../../ui/state';
import { headerModel } from '../../ui/view/header';
import { DEFAULT_PNL_Y } from '../../ui/view/pnlChart';
import {
  feeField,
  SETTINGS_NO_BOARD_TEXT,
  type SettingsInput,
  settingsModel,
} from '../../ui/view/settings';
import { fixture } from '../support/fixtures';

const chain = normalizeChain(fixture('latest'));

const base: SettingsInput = {
  atmBasis: 'B',
  metricsUnit: 'auto',
  pnlY: DEFAULT_PNL_Y,
  futureBasis: 'fixed',
  dXUnit: 'pct',
  x0: 68_000,
  theme: 'auto',
  header: headerModel(chain, 'B', CALENDAR),
};

describe('settingsModel（#87 AC-7）', () => {
  it('選択中の値が入力の値と一致する（代表 8 通り）', () => {
    const cases: Partial<SettingsInput>[] = [
      {},
      { atmBasis: 'A' },
      { metricsUnit: 'yen' },
      { metricsUnit: 'thousand', theme: 'dark' },
      { pnlY: { ...DEFAULT_PNL_Y, mode: 'premium', n: 3 } },
      { pnlY: { mode: 'manual', manual: [-100_000, 50_000], n: 2 }, futureBasis: 'decay' },
      { dXUnit: 'yen', theme: 'light' },
      { atmBasis: 'A', metricsUnit: 'yen', futureBasis: 'decay', dXUnit: 'yen', theme: 'dark' },
    ];
    for (const c of cases) {
      const i = { ...base, ...c };
      const v = settingsModel(i);
      expect(v.basis.value).toBe(i.atmBasis);
      expect(v.unit.value).toBe(i.metricsUnit);
      expect(v.yMode).toBe(i.pnlY.mode);
      expect(v.futureBasis.value).toBe(i.futureBasis);
      expect(v.dXUnit.value).toBe(i.dXUnit);
      expect(v.theme.value).toBe(i.theme);
    }
  });

  it('選択肢の並びと文', () => {
    const v = settingsModel(base);
    expect(v.basis.options.map((o) => [o.value, o.text])).toEqual([
      ['B', '合成先物（B）'],
      ['A', 'ラージ先物（A）'],
    ]);
    expect(v.unit.options.map((o) => [o.value, o.text])).toEqual([
      ['auto', '自動'],
      ['yen', '円'],
      ['thousand', '千円'],
    ]);
    expect(v.futureBasis.options.map((o) => [o.value, o.text])).toEqual([
      ['fixed', '固定'],
      ['decay', '減衰'],
    ]);
    expect(v.dXUnit.options.map((o) => [o.value, o.text, o.disabled])).toEqual([
      ['pct', '%', undefined],
      ['yen', '円', undefined],
    ]);
    expect(v.theme.options.map((o) => o.value)).toEqual([...THEME_PREFS]);
    expect(v.theme.options.map((o) => o.text)).toEqual(['端末に合わせる', 'ダーク', 'ライト']);
  });

  it('X₀ が決まらない（NaN・0・負）と ΔX の単位はどちらも押せない（シナリオと同じ条件）', () => {
    for (const x0 of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const v = settingsModel({ ...base, x0 });
      expect(v.dXUnit.options.every((o) => o.disabled === true)).toBe(true);
    }
  });

  it('前提の行は headerModel.assumptions と同じ文・同じ順（期限内は warn なし）', () => {
    const h = headerModel(chain, 'B', CALENDAR);
    const v = settingsModel({ ...base, header: h });
    expect(v.assumptions.map((a) => a.text)).toEqual(h.assumptions);
    expect(v.noBoard).toBeNull();
    if (h.calendarWarning === null) expect(v.assumptions.some((a) => a.warn)).toBe(false);
  });

  it('カレンダー期限切れは前提の行に同じ文で入り、その行だけ warn', () => {
    const cal = buildCalendar({ ...bundledJson, covered_until: '2026-10-12' }, 'bundled');
    const h = headerModel(chain, 'A', cal);
    expect(h.calendarWarning).not.toBeNull();
    const v = settingsModel({ ...base, header: h });
    expect(v.assumptions.map((a) => a.text)).toEqual(h.assumptions);
    expect(v.assumptions.filter((a) => a.warn).map((a) => a.text)).toEqual([h.calendarWarning]);
  });

  it('板が無い → 前提は空・noBoard の文', () => {
    const v = settingsModel({ ...base, header: null });
    expect(v.assumptions).toEqual([]);
    expect(v.noBoard).toBe(SETTINGS_NO_BOARD_TEXT);
    expect(SETTINGS_NO_BOARD_TEXT).toBe('板が無い（前提は板を読むと出る）');
  });
});

describe('feeField（parseFee と同じ文・結果）', () => {
  it('-1・100001・abc・空 → value null と parseFee の文', () => {
    for (const t of ['-1', '100001', 'abc', '']) {
      const r = parseFee(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(feeField(t)).toEqual({ value: null, error: r.message });
    }
    expect(feeField('abc').error).toBe('手数料は 0〜100,000 円 / 枚');
  });

  it('300 → 300・error null、0・100000 も通る', () => {
    expect(feeField('300')).toEqual({ value: 300, error: null });
    expect(feeField('0')).toEqual({ value: 0, error: null });
    expect(feeField('100,000')).toEqual({ value: 100_000, error: null });
  });
});

/**
 * #87 (C) AC-7: 設定のダイアログの表示モデル（settingsModel）と手数料の欄（feeField）。
 * 板は合成の板（fixtures/synthetic の latest。架空の値）。
 */
import { describe, expect, it } from 'vitest';
import { buildCalendar, normalizeChain } from '../../data';
import bundledJson from '../../data/calendar/calendar.json';
import { CALENDAR } from '../../ui/calendar';
import { DEFAULT_MARGIN_PREFS, THEME_PREFS } from '../../ui/prefs';
import { parseFee } from '../../ui/state';
import { headerModel } from '../../ui/view/header';
import { DEFAULT_PNL_Y } from '../../ui/view/pnlChart';
import {
  feeField,
  MARGIN_FIELD_ERROR,
  MARGIN_FIELDS,
  MARGIN_LONG_OPTIONS,
  MARGIN_RESET,
  MARGIN_SETTINGS_NOTES,
  marginField,
  marginFieldText,
  marginLongPatch,
  marginLongValue,
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

/** #131 AC15: 証拠金（概算）の欄の判定（入力ごと。範囲は ui/prefs.ts と同じ） */
describe('証拠金の欄（#131）', () => {
  it('欄の並びと見出し（単位つき。IV の上げ / 下げは % = #150）', () => {
    expect(MARGIN_FIELDS.map((f) => f.key)).toEqual([
      'capitalYen',
      'factorPct',
      'rangePct',
      'ivUpPct',
      'ivDownPct',
    ]);
    expect(MARGIN_FIELDS.map((f) => f.label)).toEqual([
      '資金（円）',
      '掛け目（%）',
      '値動き幅 R（%）',
      'IV の上げ（%）',
      'IV の下げ（%）',
    ]);
  });

  it('資金: 空欄・0 は未設定、桁区切り可、負・小数・範囲外・文字はエラー文', () => {
    expect(marginField('capitalYen', '')).toEqual({ ok: true, value: null });
    expect(marginField('capitalYen', '  ')).toEqual({ ok: true, value: null });
    expect(marginField('capitalYen', '0')).toEqual({ ok: true, value: null });
    expect(marginField('capitalYen', '12,345,678')).toEqual({ ok: true, value: 12_345_678 });
    expect(marginField('capitalYen', '1000000000000')).toEqual({ ok: true, value: 1e12 });
    for (const t of ['-1', '−1', '1.5', '1000000000001', 'abc', '1e', 'Infinity', 'NaN']) {
      expect(marginField('capitalYen', t), t).toEqual({
        ok: false,
        error: MARGIN_FIELD_ERROR.capitalYen,
      });
    }
  });

  it('掛け目・R・IV の上げ / 下げ（%。#150）: 範囲の両端は通る、外・空欄・文字はエラー文', () => {
    const cases = [
      ['factorPct', '50', '300', ['49', '301', '']],
      ['rangePct', '1', '30', ['0.5', '31', '-8']],
      ['ivUpPct', '0', '200', ['-1', '201', 'x']],
      ['ivDownPct', '0', '90', ['-0.5', '91', '']],
    ] as const;
    for (const [key, lo, hi, bad] of cases) {
      expect(marginField(key, lo)).toEqual({ ok: true, value: Number(lo) });
      expect(marginField(key, hi)).toEqual({ ok: true, value: Number(hi) });
      for (const t of bad) {
        expect(marginField(key, t), `${key} ${t}`).toEqual({
          ok: false,
          error: MARGIN_FIELD_ERROR[key],
        });
      }
    }
    expect(marginField('rangePct', '8.5')).toEqual({ ok: true, value: 8.5 });
    expect(marginField('ivUpPct', '37.5')).toEqual({ ok: true, value: 37.5 });
    expect(MARGIN_FIELD_ERROR.ivUpPct).toBe('IV の上げは 0〜200%');
    expect(MARGIN_FIELD_ERROR.ivDownPct).toBe('IV の下げは 0〜90%');
  });

  it('欄の文字列・[既定に戻す] は幅と掛け目だけ（資金は戻さない）・注記', () => {
    expect(marginFieldText('capitalYen', DEFAULT_MARGIN_PREFS)).toBe('');
    expect(marginFieldText('capitalYen', { ...DEFAULT_MARGIN_PREFS, capitalYen: 5_000_000 })).toBe(
      '5000000',
    );
    expect(marginFieldText('factorPct', DEFAULT_MARGIN_PREFS)).toBe('100');
    expect(marginFieldText('ivUpPct', DEFAULT_MARGIN_PREFS)).toBe('50');
    expect(marginFieldText('ivDownPct', DEFAULT_MARGIN_PREFS)).toBe('25');
    // #150 の既定（R 5%・IV +50% / −25%・掛け目 100%）
    expect(MARGIN_RESET).toEqual({
      factorPct: 100,
      rangePct: 5,
      ivUpPct: 50,
      ivDownPct: 25,
      ignoreLongOptions: true,
    });
    expect('capitalYen' in MARGIN_RESET).toBe(false);
    const notes = MARGIN_SETTINGS_NOTES.join(' ');
    expect(notes).toContain('概算');
    expect(notes).toContain('NOV');
    expect(notes).toContain('答え合わせ');
    expect(notes).toContain('未確認');
    expect(notes).toContain('JSCC');
    expect(notes).not.toContain('仮置き');
  });
});

describe('#149 買いの OP の設定', () => {
  it('#149 証拠金の節に買いの OP の 2 択、既定に戻すでオン', () => {
    expect(MARGIN_LONG_OPTIONS).toEqual([
      { value: 'ignore', text: '減らさない' },
      { value: 'offset', text: '相殺する' },
    ]);
    expect(marginLongValue(DEFAULT_MARGIN_PREFS)).toBe('ignore');
    expect(marginLongValue({ ...DEFAULT_MARGIN_PREFS, ignoreLongOptions: false })).toBe('offset');
    expect(marginLongPatch('offset')).toEqual({ ignoreLongOptions: false });
    expect(marginLongPatch('ignore')).toEqual({ ignoreLongOptions: true });
    // [既定に戻す] はオンに戻す。資金は戻さない
    expect(MARGIN_RESET.ignoreLongOptions).toBe(true);
    expect('capitalYen' in MARGIN_RESET).toBe(false);
    // 数値の欄には入れない（2 択は別の行）
    expect(MARGIN_FIELDS.map((f) => f.key as string)).not.toContain('ignoreLongOptions');
    const notes = MARGIN_SETTINGS_NOTES.join(' ');
    expect(notes).toContain('買いの OP');
    expect(notes).toContain('売りの OP と先物だけ');
  });
});

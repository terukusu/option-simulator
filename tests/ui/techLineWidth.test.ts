import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TECH_LINE_WIDTHS,
  isTechLinePx,
  legacyStepWidths,
  TECH_LINE_FIELDS,
  TECH_LINE_PX,
  TECH_LINE_PX_OPTIONS,
  techLinePxOf,
  techLineWidthsOr,
} from '../../ui/view/techLineWidth';

/** #214: 設定の線の太さ（px）→ EMA の 3 本とオシレーターの線（指標の段）の stroke-width（CSS px） */
describe('テクニカルの線の太さ（px）', () => {
  it('選べる値は 1 / 1.5 / 2 / 3 px と段の既定 1.25 px。既定は EMA 1・段 1.25（今の見た目）', () => {
    expect(TECH_LINE_PX).toEqual([1, 1.25, 1.5, 2, 3]);
    expect(DEFAULT_TECH_LINE_WIDTHS).toEqual({ ema: 1, pane: 1.25 });
    for (const px of Object.values(DEFAULT_TECH_LINE_WIDTHS)) expect(isTechLinePx(px)).toBe(true);
  });
  it('選択肢の文字は「1 px」の形、値は px の文字', () => {
    expect(TECH_LINE_PX_OPTIONS.map((o) => o.text)).toEqual([
      '1 px',
      '1.25 px',
      '1.5 px',
      '2 px',
      '3 px',
    ]);
    for (const o of TECH_LINE_PX_OPTIONS) expect(techLinePxOf(o.value)).toBe(Number(o.value));
    expect(techLinePxOf('4')).toBeNull();
    expect(techLinePxOf('')).toBeNull();
    expect(TECH_LINE_FIELDS.map((f) => f.key)).toEqual(['ema', 'pane']);
  });
  it('#223: 設定の表記は「EMA の線 / オシレーターの線」（保存のキー pane は同じ）', () => {
    expect(TECH_LINE_FIELDS.map((f) => [f.key, f.label])).toEqual([
      ['ema', 'EMA の線'],
      ['pane', 'オシレーターの線'],
    ]);
    const pane = TECH_LINE_FIELDS.find((f) => f.key === 'pane');
    expect(pane?.aria).toBe('オシレーター（RSI・MACD・SO）の線の太さ');
    expect(
      TECH_LINE_FIELDS.some((f) => f.label.includes('段の線') || f.aria.includes('段の線')),
    ).toBe(false);
  });
  it('欠けた・不正な項目は既定で埋める', () => {
    expect(techLineWidthsOr(undefined)).toEqual({ ema: 1, pane: 1.25 });
    expect(techLineWidthsOr({ ema: 3 })).toEqual({ ema: 3, pane: 1.25 });
    expect(techLineWidthsOr({ ema: 0.75, pane: 2 })).toEqual({ ema: 1, pane: 2 });
    expect(techLineWidthsOr({ pane: Number.NaN })).toEqual({ ema: 1, pane: 1.25 });
  });
  it('作業中の版の段: 細い → 1、普通 → 既定、太い → 2（EMA・段とも）、ほか → null', () => {
    expect(legacyStepWidths('thin')).toEqual({ ema: 1, pane: 1 });
    expect(legacyStepWidths('normal')).toEqual(DEFAULT_TECH_LINE_WIDTHS);
    expect(legacyStepWidths('thick')).toEqual({ ema: 2, pane: 2 });
    expect(legacyStepWidths('bold')).toBeNull();
    expect(legacyStepWidths(undefined)).toBeNull();
  });
});

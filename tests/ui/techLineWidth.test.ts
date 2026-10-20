import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TECH_LINE_WIDTH,
  isTechLineWidth,
  TECH_LINE_WIDTH_OPTIONS,
  TECH_LINE_WIDTH_VALUES,
  techLineWidths,
} from '../../ui/view/techLineWidth';

/** #214: 設定の線の太さ（細い / 普通 / 太い）→ EMA の 3 本と指標の段の線の stroke-width（px） */
describe('techLineWidths', () => {
  it('段 → 太さの表（普通 = 既定: EMA 1・段 1.25 = #200 の段の太さのまま）', () => {
    expect(DEFAULT_TECH_LINE_WIDTH).toBe('normal');
    expect(techLineWidths('thin')).toEqual({ ema: 0.75, pane: 1 });
    expect(techLineWidths('normal')).toEqual({ ema: 1, pane: 1.25 });
    expect(techLineWidths('thick')).toEqual({ ema: 1.5, pane: 1.75 });
  });
  it('細い < 普通 < 太い（EMA・段とも）。EMA は同じ段の段の線より細い', () => {
    const ws = TECH_LINE_WIDTH_VALUES.map((w) => techLineWidths(w));
    for (let i = 1; i < ws.length; i++) {
      expect(ws[i]?.ema).toBeGreaterThan(ws[i - 1]?.ema ?? Number.POSITIVE_INFINITY);
      expect(ws[i]?.pane).toBeGreaterThan(ws[i - 1]?.pane ?? Number.POSITIVE_INFINITY);
    }
    for (const w of ws) expect(w.ema).toBeLessThan(w.pane);
  });
  it('無い・不正 → 普通', () => {
    expect(techLineWidths(undefined)).toEqual({ ema: 1, pane: 1.25 });
    expect(techLineWidths('bold' as unknown as 'thin')).toEqual({ ema: 1, pane: 1.25 });
    expect(isTechLineWidth('thin')).toBe(true);
    expect(isTechLineWidth('normal')).toBe(true);
    expect(isTechLineWidth(1)).toBe(false);
    expect(isTechLineWidth(null)).toBe(false);
  });
  it('Seg の選択肢: 細い / 普通 / 太い の順で、値は表と同じ', () => {
    expect(TECH_LINE_WIDTH_OPTIONS.map((o) => o.text)).toEqual(['細い', '普通', '太い']);
    expect(TECH_LINE_WIDTH_OPTIONS.map((o) => o.value)).toEqual([...TECH_LINE_WIDTH_VALUES]);
  });
});

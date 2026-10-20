/** #200: 先物推移の指標の段の表示モデル（ui/view/indicators.ts）。値は架空 */
import { describe, expect, it } from 'vitest';
import { indicators } from '../../model';
import {
  IND_KINDS,
  IND_PANE_H,
  indPaneModel,
  indReadout,
  toggleInd,
} from '../../ui/view/indicators';
import { IV_MARGIN, ivChartModel } from '../../ui/view/ivHistory';

const bars = Array.from({ length: 80 }, (_, i) => {
  const c = 30000 + 300 * Math.sin(i / 6) + 5 * i;
  return { t: 1_790_000_000 + i * 3600, o: c - 10, h: c + 40, l: c - 40, c };
});
const ind = indicators(bars);
const base = { ind, n: bars.length, viewport: [20.5, 79.5] as [number, number], width: 360 };

describe('段の切替', () => {
  it('RSI・MACD・SO（aria-label にパラメータ）', () => {
    expect(IND_KINDS.map((k) => [k.value, k.text])).toEqual([
      ['rsi', 'RSI'],
      ['macd', 'MACD'],
      ['stoch', 'SO'],
    ]);
    expect(IND_KINDS[2]?.label).toContain('14・3・3');
  });
  it('反転しても並びは IND_KINDS の順', () => {
    expect(toggleInd([], 'stoch')).toEqual(['stoch']);
    expect(toggleInd(['stoch'], 'rsi')).toEqual(['rsi', 'stoch']);
    expect(toggleInd(['rsi', 'stoch'], 'rsi')).toEqual(['stoch']);
  });
});

describe('段の座標', () => {
  it('横の画素範囲は価格の描画域と同じ（左 = 系列の目盛りの列、右 = IV_MARGIN.right）', () => {
    const m = indPaneModel({ ...base, kind: 'rsi', marginLeft: 48 });
    const price = ivChartModel({
      bars,
      tf: '1h',
      mode: 'line',
      viewport: base.viewport,
      segments: [[0, 79]],
      width: 360,
      height: 200,
      rightLoaded: false,
      series: { fmt: String, marginLeft: 48 },
    });
    expect(m.range).toEqual(price.range);
    expect(m.range).toEqual([48, 360 - IV_MARGIN.right]);
    expect(m.height).toBe(IND_PANE_H);
  });
  it('RSI: 補助線 70 / 30、線は値のある足から（先頭の 14 本は計算に足りない）', () => {
    const m = indPaneModel({ ...base, viewport: [-0.5, 79.5], kind: 'rsi', marginLeft: 48 });
    expect(m.guides.map((g) => g.label)).toEqual(['70', '30']);
    expect(m.lines).toHaveLength(1);
    const d = m.lines[0]?.d ?? '';
    expect(d.startsWith('M')).toBe(true);
    // 足 14〜79 の 66 点（M 1 つ + L 65）
    expect(d.split('L')).toHaveLength(66);
    // 0〜100 の固定 = 段の中に収まる
    for (const y of d.match(/ (-?[\d.]+)/g) ?? []) {
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(IND_PANE_H);
    }
  });
  it('MACD: 0 の線とヒストの棒（正 / 負）、MACD とシグナルの線', () => {
    const m = indPaneModel({ ...base, kind: 'macd', marginLeft: 48 });
    expect(m.guides).toEqual([expect.objectContaining({ label: '0', zero: true })]);
    expect(m.lines.map((l) => l.cls)).toEqual(['ind-line main', 'ind-line sub']);
    expect(m.histUp.length + m.histDown.length).toBeGreaterThan(0);
  });
  it('SO: 補助線 80 / 20、%K と %D の線', () => {
    const m = indPaneModel({ ...base, kind: 'stoch', marginLeft: 48 });
    expect(m.guides.map((g) => g.label)).toEqual(['80', '20']);
    expect(m.lines).toHaveLength(2);
  });
});

describe('段の読み取り（カーソルの足、無ければ最新の足）', () => {
  const range: [number, number] = [48, 350];
  it('カーソルなし = 最新の足の値・縦線なし', () => {
    const r = indReadout(ind, 'rsi', bars.length, base.viewport, range, null);
    expect(r.cursorX).toBeNull();
    expect(r.values[0]?.v).toBe((ind.rsi.at(-1) as number).toFixed(1));
  });
  it('カーソルの足の値と縦線。表示範囲の外なら縦線なし', () => {
    const r = indReadout(ind, 'stoch', bars.length, base.viewport, range, 40);
    expect(r.cursorX).not.toBeNull();
    expect(r.values.map((v) => v.k)).toEqual(['%K', '%D']);
    expect(indReadout(ind, 'macd', bars.length, base.viewport, range, 5).cursorX).toBeNull();
    // 計算に足りない足は —
    expect(indReadout(ind, 'macd', bars.length, base.viewport, range, 5).values[0]?.v).toBe('—');
  });
});

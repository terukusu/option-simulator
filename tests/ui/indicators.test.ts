/** #200: 先物推移の指標の段の表示モデル（ui/view/indicators.ts）。値は架空 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TECH_PARAMS, indicators } from '../../model';
import { linear } from '../../ui/chart/scale';
import {
  FUT_PRICE_MIN_H,
  futPaneAt,
  futPaneDrag,
  futPaneLayout,
  futSplitAt,
  IND_KINDS,
  IND_PANE_H,
  IND_PANE_MIN_H,
  indCrosshair,
  indKindLabel,
  indPaneModel,
  indReadout,
  indSplitLabel,
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
  it('RSI・MACD・SO（aria-label に期間）', () => {
    expect(IND_KINDS.map((k) => [k.value, k.text])).toEqual([
      ['rsi', 'RSI'],
      ['macd', 'MACD'],
      ['stoch', 'SO'],
    ]);
    expect(indKindLabel('stoch', DEFAULT_TECH_PARAMS)).toBe('ストキャスティクス（14・3・3）の段');
    expect(indKindLabel('rsi', { ...DEFAULT_TECH_PARAMS, rsi: 9 })).toBe('RSI（9）の段');
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

describe('縮小（1 画素に 2 本以上）', () => {
  it('線は 1 画素の列に 1 点、ヒストは 1 列に 1 本（点の数は描画域の幅まで）', () => {
    const many = Array.from({ length: 3000 }, (_, i) => {
      const c = 30000 + 300 * Math.sin(i / 25) + 40 * Math.sin(i);
      return { h: c + 30, l: c - 30, c };
    });
    const ind2 = indicators(many);
    const inp = {
      ind: ind2,
      n: many.length,
      viewport: [-0.5, 2999.5] as [number, number],
      width: 360,
      marginLeft: 48,
    };
    const width = 360 - 48 - IV_MARGIN.right;
    const rsi = indPaneModel({ ...inp, kind: 'rsi' });
    expect((rsi.lines[0]?.d.match(/[ML]/g) ?? []).length).toBeLessThanOrEqual(width + 2);
    const macd = indPaneModel({ ...inp, kind: 'macd' });
    const bars = (macd.histUp.match(/M/g) ?? []).length + (macd.histDown.match(/M/g) ?? []).length;
    expect(bars).toBeLessThanOrEqual(width + 2);
    expect(bars).toBeGreaterThan(width / 2);
    // 拡大（1 画素に 1 本未満）は全部の足（左の 1 本外 2899〜2999）
    const zoom = indPaneModel({ ...inp, viewport: [2899.5, 2999.5], kind: 'rsi' });
    expect((zoom.lines[0]?.d.match(/[ML]/g) ?? []).length).toBe(101);
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

describe('期間（#205）', () => {
  it('見出し・svg の名前は計算に使った期間（ind.params）', () => {
    const p = { ...DEFAULT_TECH_PARAMS, rsi: 9, macdFast: 5, macdSlow: 35, macdSignal: 5 };
    const ind9 = indicators(bars, p);
    const rsiM = indPaneModel({ ...base, ind: ind9, kind: 'rsi', marginLeft: 50 });
    expect(rsiM.title).toBe('RSI（9）');
    expect(rsiM.imgLabel).toContain('RSI（9）の推移');
    const macdM = indPaneModel({ ...base, ind: ind9, kind: 'macd', marginLeft: 50 });
    expect(macdM.title).toBe('MACD（5・35・5）');
    const def = indPaneModel({ ...base, kind: 'stoch', marginLeft: 50 });
    expect(def.title).toBe('SO（14・3・3）');
  });
});

describe('#207 価格と段の配置（futPaneLayout）', () => {
  it('覚えた高さが無い段は 56px、価格は残り', () => {
    const l = futPaneLayout({ stackH: 500, kinds: ['rsi', 'macd'], heights: undefined, max: null });
    expect(l.panes).toEqual([
      { kind: 'rsi', h: IND_PANE_H, top: 0 },
      { kind: 'macd', h: IND_PANE_H, top: IND_PANE_H },
    ]);
    expect(l.priceH).toBe(500 - 2 * IND_PANE_H);
    expect(l.max).toBeNull();
  });
  it('覚えた高さ（段ごと）を使い、不正な値は既定', () => {
    const l = futPaneLayout({
      stackH: 600,
      kinds: ['rsi', 'macd', 'stoch'],
      heights: { rsi: 120, macd: 10, stoch: 70.5 },
      max: null,
    });
    expect(l.panes.map((s) => s.h)).toEqual([120, IND_PANE_H, IND_PANE_H]);
    expect(l.priceH).toBe(600 - 120 - 2 * IND_PANE_H);
  });
  it('段の和が「枠 − 価格の下限 80px」を超えたら比で縮め、段の下限は 28px（#200 の縮み方と同じ）', () => {
    const l = futPaneLayout({ stackH: 200, kinds: ['rsi', 'macd', 'stoch'], max: null });
    expect(l.panes.map((s) => s.h)).toEqual([40, 40, 40]);
    expect(l.priceH).toBe(FUT_PRICE_MIN_H);
    expect(l.hidden).toEqual([]);
  });
  it('価格が先: 下限（価格 80px + 段 28px × 数）が入らなければ後ろの段から隠す。和は枠を超えない（#207 はみ出し）', () => {
    const kinds = ['rsi', 'macd', 'stoch'] as const;
    const fit3 = futPaneLayout({ stackH: 164, kinds, max: null });
    expect(fit3.panes.map((s) => s.h)).toEqual([28, 28, 28]);
    expect(fit3.priceH).toBe(80);
    const two = futPaneLayout({ stackH: 150, kinds, max: null });
    expect(two.panes.map((s) => s.kind)).toEqual(['rsi', 'macd']);
    expect(two.hidden).toEqual(['stoch']);
    expect(two.priceH + two.panes.reduce((a, s) => a + s.h, 0)).toBeLessThanOrEqual(150);
    const tiny = futPaneLayout({ stackH: 100, kinds, max: null });
    expect(tiny.panes).toEqual([]);
    expect(tiny.hidden).toEqual(['rsi', 'macd', 'stoch']);
    expect(tiny.priceH).toBe(100);
    // 覚えた高さが大きくても和は枠の中（下限を守って残りを比で分ける）
    for (const stackH of [130, 164, 200, 260, 333, 500]) {
      const l = futPaneLayout({ stackH, kinds, heights: { rsi: 400, macd: 30 }, max: null });
      const sum = l.panes.reduce((a, s) => a + s.h, 0);
      expect(sum + l.priceH).toBeLessThanOrEqual(stackH);
      expect(l.priceH).toBeGreaterThanOrEqual(FUT_PRICE_MIN_H);
      expect(l.panes.every((s) => s.h >= IND_PANE_MIN_H)).toBe(true);
    }
  });
  it('最大化: その段が枠の全部（価格 0・ほかの段なし）。出していない段の最大化は無視', () => {
    const l = futPaneLayout({
      stackH: 400,
      kinds: ['rsi', 'macd'],
      heights: { rsi: 90 },
      max: 'macd',
    });
    expect(l).toEqual({
      priceH: 0,
      panes: [{ kind: 'macd', h: 400, top: 0 }],
      max: 'macd',
      hidden: [],
    });
    const none = futPaneLayout({ stackH: 400, kinds: ['rsi'], max: 'macd' });
    expect(none.max).toBeNull();
    expect(none.panes).toHaveLength(1);
  });
});

describe('#207 境目のドラッグ（futPaneDrag）', () => {
  const start = futPaneLayout({ stackH: 400, kinds: ['rsi', 'macd', 'stoch'], max: null });
  it('境目 0（価格 | 1 段目）: 上へ動かすと 1 段目が高くなり、価格の下限 80px で止まる', () => {
    expect(futPaneDrag(start, 0, -40, 400)).toEqual({ rsi: 96, macd: 56, stoch: 56 });
    expect(futPaneDrag(start, 0, -1000, 400).rsi).toBe(400 - FUT_PRICE_MIN_H - 2 * 56);
    expect(futPaneDrag(start, 0, 1000, 400).rsi).toBe(IND_PANE_MIN_H);
  });
  it('境目 i（段 i−1 | 段 i）: 2 段の和を保ち、どちらも 28px で止まる', () => {
    expect(futPaneDrag(start, 1, 20, 400)).toEqual({ rsi: 76, macd: 36, stoch: 56 });
    expect(futPaneDrag(start, 2, -100, 400)).toEqual({ rsi: 56, macd: 28, stoch: 84 });
    expect(futPaneDrag(start, 1, 100, 400)).toEqual({ rsi: 84, macd: 28, stoch: 56 });
  });
  it('移動量は整数に丸める・NaN は 0', () => {
    expect(futPaneDrag(start, 1, 3.6, 400).rsi).toBe(60);
    expect(futPaneDrag(start, 1, Number.NaN, 400).rsi).toBe(56);
  });
});

describe('#207 当たり判定（futPaneAt・futSplitAt）', () => {
  const l = futPaneLayout({ stackH: 400, kinds: ['rsi', 'macd'], heights: { rsi: 80 }, max: null });
  it('段: 上端を含み下端を含まない', () => {
    expect(futPaneAt(l, 0)?.kind).toBe('rsi');
    expect(futPaneAt(l, 79.9)?.kind).toBe('rsi');
    expect(futPaneAt(l, 80)?.kind).toBe('macd');
    expect(futPaneAt(l, 136)).toBeNull();
    expect(futPaneAt(l, -1)).toBeNull();
  });
  it('境目 0 は 1 段目の上端から下へ 2 × 幅、境目 i は ±幅（マウス 5px・タッチ 10px）', () => {
    expect(futSplitAt(l, 0, false)).toBe(0);
    expect(futSplitAt(l, 10, false)).toBe(0);
    expect(futSplitAt(l, 11, false)).toBeNull();
    expect(futSplitAt(l, 75, false)).toBe(1);
    expect(futSplitAt(l, 85, false)).toBe(1);
    expect(futSplitAt(l, 86, false)).toBeNull();
    expect(futSplitAt(l, 70, true)).toBe(1);
    expect(futSplitAt(l, 40, true)).toBeNull();
  });
  it('幅は段の高さの 1/4 まで（低い段でも十字線を置ける）・最大化中は境目なし', () => {
    const low = futPaneLayout({ stackH: 164, kinds: ['rsi', 'macd', 'stoch'], max: null });
    expect(low.panes.map((s) => s.h)).toEqual([28, 28, 28]);
    expect(futSplitAt(low, 14, true)).toBeNull();
    expect(futSplitAt(low, 28 + 7, true)).toBe(1);
    expect(futSplitAt(low, 28 + 8, true)).toBeNull();
    const max = futPaneLayout({ stackH: 300, kinds: ['rsi', 'macd'], max: 'rsi' });
    expect(futSplitAt(max, 0, true)).toBeNull();
  });
  it('境目の名前', () => {
    expect(indSplitLabel(['rsi', 'macd'], 0)).toContain('価格とRSIの段の境目');
    expect(indSplitLabel(['rsi', 'macd'], 1)).toContain('RSIとMACDの段の境目');
  });
});

describe('#207 段の十字線（indCrosshair）', () => {
  it('横線 = 指の高さ、札 = その高さの値（RSI は小数 1 桁）。描画域の上下で止める', () => {
    const m = indPaneModel({ ...base, kind: 'rsi', marginLeft: 48, height: 114 });
    // 描画域は上 14px・下 4px = y 14 → 100、y 110 → 0
    const c = indCrosshair(m, 38);
    expect(c?.y).toBe(38);
    expect(c?.value).toBeCloseTo(75, 6);
    expect(c?.text).toBe('75.0');
    expect(indCrosshair(m, -50)?.text).toBe('100.0');
    expect(indCrosshair(m, 500)?.text).toBe('0.0');
    expect(indCrosshair(m, null)).toBeNull();
  });
  it('札は目盛りの列（右端 = 描画域の左 − 1）、縦は段の中に収める', () => {
    const m = indPaneModel({ ...base, kind: 'stoch', marginLeft: 48, height: 56 });
    const c = indCrosshair(m, 100);
    expect(c && c.tag.x + c.tag.w).toBeCloseTo(47, 6);
    expect(c && c.tag.y + c.tag.h).toBeLessThanOrEqual(56);
    expect(c?.tag.y).toBeGreaterThanOrEqual(0);
  });
  it('MACD は円の整数（見えている足の範囲の逆変換）', () => {
    const m = indPaneModel({ ...base, kind: 'macd', marginLeft: 48, height: 100 });
    const c = indCrosshair(m, 50);
    expect(c?.text).toMatch(/^−?\d{1,3}(,\d{3})*$/);
    const yv = linear(m.yPx, m.yDomain)(50);
    expect(c?.value).toBeCloseTo(yv, 9);
    // 0 の補助線の高さなら 0
    const zero = m.guides[0]?.y ?? 0;
    expect(Math.abs(indCrosshair(m, zero)?.value ?? 1)).toBeLessThan(
      (m.yDomain[1] - m.yDomain[0]) / 100,
    );
  });
});

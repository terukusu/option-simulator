import { describe, expect, it } from 'vitest';
import { preparePosition, type Scenario, theoreticalPnl, ZERO_SCENARIO } from '../../model';
import { type Domain, linear } from '../../ui/chart/scale';
import { IV_TAG_H } from '../../ui/view/ivHistory';
import { fmtAmount } from '../../ui/view/metrics';
import {
  DEFAULT_PNL_Y,
  PNL_MARGIN,
  type PnlBase,
  type PnlChartModel,
  pnlChartModel,
  pnlDomains,
  todayScenario,
} from '../../ui/view/pnlChart';
import {
  CROSS_X_STEP,
  markLabelBox,
  type PnlCursor,
  pnlCrosshair,
  pnlCursorAt,
  pnlTapCursor,
} from '../../ui/view/pnlCrosshair';
import { labelWidth } from '../../ui/view/scenarioMarks';
import { M1, M2, makeMarket } from '../support/market';
import { PERF_LEGS } from '../support/perfPosition';

/** #201: 損益グラフの十字線（純関数）。合成の板・架空の値。 */

const { ctx, rows } = makeMarket();
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const base = pnlDomains(board, preparePosition(PERF_LEGS.slice(0, 4), ctx), ctx) as PnlBase;
if (!base) throw new Error('損益グラフの基礎が作れない');
const x0 = base.ctx.x0;

/** 幅 360 の画面の舞台の描画域の要素（IV レール 34px を除く）と 1440 の舞台の要素の大きさ（目安） */
const SIZES = [
  { name: '360', width: 300, height: 180 },
  { name: '1440', width: 900, height: 420 },
] as const;

function chartOf(sc: Scenario, width: number, height: number, viewport: Domain | null = null) {
  return pnlChartModel({
    base,
    scenario: sc,
    viewport,
    pnlY: DEFAULT_PNL_Y,
    plotWidth: width - PNL_MARGIN.left - PNL_MARGIN.right,
    plotHeight: height - PNL_MARGIN.top - PNL_MARGIN.bottom,
  });
}

const SC: Scenario = { ...ZERO_SCENARIO, days: 6, dSigma: 2 };

function crossOf(
  chart: PnlChartModel,
  cursor: PnlCursor,
  width: number,
  height: number,
  sc: Scenario = SC,
) {
  return pnlCrosshair({ base, scenario: sc, chart, cursor, width, height });
}

const midY = (c: PnlChartModel) => (c.yDomain[0] + c.yDomain[1]) / 2;

describe('線の値と札（#201）', () => {
  it('3 本の値 = 満期 base.expiry・指定日 theoreticalPnl(d = chart.days)・今日 theoreticalPnl(todayScenario)。X は 10 円の格子', () => {
    const chart = chartOf(SC, 900, 420);
    for (const raw of [x0 - 1_234, x0 + 3, x0 + 2_777]) {
      const r = crossOf(chart, { x: raw, y: midY(chart), pinned: false }, 900, 420);
      if (!r) throw new Error('十字線が無い');
      const x = Math.round(raw / CROSS_X_STEP) * CROSS_X_STEP;
      expect(r.x).toBe(x);
      const by = Object.fromEntries(r.read.items.map((i) => [i.kind, i.value]));
      expect(by.expiry).toBeCloseTo(base.expiry(x), 6);
      expect(by.date).toBeCloseTo(
        theoreticalPnl(base.legs, x, { ...SC, days: chart.days }, base.ctx, base.settings),
        6,
      );
      expect(by.today).toBeCloseTo(
        theoreticalPnl(base.legs, x, todayScenario(SC), base.ctx, base.settings),
        6,
      );
      expect(r.read.items.map((i) => i.kind)).toEqual(['expiry', 'date', 'today']);
      // 横軸の札 = X（円の整数）、縦線 = X の画素
      expect(r.xTag.text).toBe(x.toLocaleString('en-US'));
      const sx = linear(chart.domain, [chart.plot.left, chart.plot.left + chart.plot.width]);
      expect(Math.abs(r.px - sx(x))).toBeLessThanOrEqual(0.05);
    }
  });

  it('指定日の線を描かない（d = 0・Δσ = Δs = 0）なら読み取りは満期と今日の 2 行', () => {
    const sc = { ...ZERO_SCENARIO };
    const chart = chartOf(sc, 900, 420);
    const r = crossOf(chart, { x: x0, y: midY(chart), pinned: false }, 900, 420, sc);
    expect(r?.read.items.map((i) => i.kind)).toEqual(['expiry', 'today']);
  });

  it('縦軸の札 = 横線の高さの損益（グラフの単位）。読み取りは符号つき + 単位', () => {
    const chart = chartOf(SC, 900, 420);
    const level = chart.yDomain[0] + (chart.yDomain[1] - chart.yDomain[0]) * 0.3;
    const r = crossOf(chart, { x: x0, y: level, pinned: false }, 900, 420);
    if (!r || r.py === null || !r.yTag) throw new Error('横線が無い');
    expect(r.level).toBe(level);
    expect(r.yTag.text).toBe(fmtAmount(level, chart.yUnit));
    const sy = linear(chart.yDomain, [chart.plot.top + chart.plot.height, chart.plot.top]);
    expect(Math.abs(r.py - sy(level))).toBeLessThanOrEqual(0.05);
    const unit = chart.yUnit === 'thousand' ? '千円' : '円';
    for (const it of r.read.items) {
      if (Number.isFinite(it.value)) {
        expect(it.text).toContain(fmtAmount(it.value, chart.yUnit, true));
        expect(it.text.endsWith(unit)).toBe(true);
      }
    }
  });

  it('千円の縦軸: −1,000 千円の水準の札は「−1,000」', () => {
    const chart = {
      ...chartOf(SC, 900, 420),
      yUnit: 'thousand' as const,
      yDomain: [-2e6, 1e6] as Domain,
    };
    const r = crossOf(chart, { x: x0, y: -1_000_000, pinned: false }, 900, 420);
    expect(r?.yTag?.text).toBe('−1,000');
  });
});

describe('範囲の外（#201）', () => {
  it('X が表示範囲の外・カーソルなし・空のグラフは null', () => {
    const chart = chartOf(SC, 900, 420);
    const [lo, hi] = chart.domain;
    expect(crossOf(chart, { x: lo - 1_000, y: 0, pinned: false }, 900, 420)).toBeNull();
    expect(crossOf(chart, { x: hi + 1_000, y: 0, pinned: false }, 900, 420)).toBeNull();
    expect(
      pnlCrosshair({ base, scenario: SC, chart, cursor: null, width: 900, height: 420 }),
    ).toBeNull();
    expect(
      pnlCrosshair({
        base: null,
        scenario: SC,
        chart,
        cursor: { x: x0, y: 0, pinned: false },
        width: 900,
        height: 420,
      }),
    ).toBeNull();
  });

  it('損益が縦軸の範囲の外なら横線・縦軸の札なし（縦線と読み取りは出す）', () => {
    const chart = chartOf(SC, 900, 420);
    const r = crossOf(chart, { x: x0, y: chart.yDomain[1] * 10 + 1e9, pinned: false }, 900, 420);
    expect(r).not.toBeNull();
    expect(r?.py).toBeNull();
    expect(r?.yTag).toBeNull();
    expect(r?.read.items.length).toBeGreaterThan(0);
  });

  it('縦軸の範囲の外の線は点なし・読み取りに ▲ / ▼', () => {
    const full = chartOf(SC, 900, 420);
    const v = base.expiry(x0);
    // 縦軸を満期の値より上に寄せる
    const chart = { ...full, yDomain: [v + 1e6, v + 2e6] as Domain };
    const r = crossOf(chart, { x: x0, y: v + 1.5e6, pinned: false }, 900, 420);
    expect(r?.dots.some((d) => d.kind === 'expiry')).toBe(false);
    expect(r?.read.items.find((i) => i.kind === 'expiry')?.text.startsWith('▼')).toBe(true);
  });
});

describe('格子に乗らない表示範囲（#201 レビュー B1）', () => {
  for (const { name, width, height } of SIZES) {
    it(`${name}: 3 円・7 円パンした範囲でも、描画域の左端・右端（端へ寄せたカーソル）で十字線が出て X は範囲の内側の 10 円の格子`, () => {
      const init = chartOf(SC, width, height);
      for (const shift of [3, 7, -3]) {
        const vp: Domain = [init.domain[0] + shift, init.domain[1] + shift];
        const chart = chartOf(SC, width, height, vp);
        const [lo, hi] = chart.domain;
        expect(lo % 10).not.toBe(0);
        const { plot } = chart;
        for (const sx of [
          plot.left - 30,
          plot.left,
          plot.left + plot.width,
          plot.left + plot.width + 30,
        ]) {
          const at = pnlCursorAt(chart, sx, plot.top + plot.height / 2, true);
          if (!at) throw new Error('カーソルが無い');
          const r = crossOf(chart, { ...at, pinned: true }, width, height);
          expect(r).not.toBeNull();
          expect(r?.x).toBeGreaterThanOrEqual(lo);
          expect(r?.x).toBeLessThanOrEqual(hi);
          expect((r?.x ?? 1) % CROSS_X_STEP).toBe(0);
        }
        // 丸める前の X が範囲の外（パンで外れた）なら null
        expect(
          crossOf(chart, { x: lo - 1, y: midY(chart), pinned: true }, width, height),
        ).toBeNull();
        expect(
          crossOf(chart, { x: hi + 1, y: midY(chart), pinned: true }, width, height),
        ).toBeNull();
      }
    });
  }
});

describe('置き場所（#201）', () => {
  for (const { name, width, height } of SIZES) {
    it(`${name}: 札・読み取り・点が svg / 描画域の内側（X を左端〜右端、損益を上端〜下端で 11 × 5 点）`, () => {
      const chart = chartOf(SC, width, height);
      const { plot } = chart;
      const [lo, hi] = chart.domain;
      const [ylo, yhi] = chart.yDomain;
      let n = 0;
      for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 4; j++) {
          for (const pinned of [false, true]) {
            const x = lo + ((hi - lo) * i) / 10;
            const y = ylo + ((yhi - ylo) * j) / 4;
            const r = crossOf(chart, { x, y, pinned }, width, height);
            // 端（i = 0 / 10）も含めてすべて出る
            expect(r).not.toBeNull();
            if (!r) continue;
            n++;
            for (const t of [r.xTag, r.yTag]) {
              if (!t) continue;
              expect(t.x).toBeGreaterThanOrEqual(0);
              expect(t.y).toBeGreaterThanOrEqual(0);
              expect(t.x + t.w).toBeLessThanOrEqual(width + 0.01);
              expect(t.y + t.h).toBeLessThanOrEqual(height + 0.01);
              expect(t.h).toBe(IV_TAG_H);
            }
            const b = r.read.box;
            expect(b.x0).toBeGreaterThanOrEqual(plot.left);
            expect(b.x1).toBeLessThanOrEqual(plot.left + plot.width + 0.01);
            expect(b.y0).toBeGreaterThanOrEqual(plot.top);
            expect(b.y1).toBeLessThanOrEqual(plot.top + plot.height + 0.01);
            // 文字（見積もりの幅）が箱の中
            for (const it of r.read.items) {
              const w = labelWidth(it.text) * 1.1;
              const left = r.read.anchor === 'start' ? r.read.textX : r.read.textX - w;
              expect(left).toBeGreaterThanOrEqual(b.x0 - 0.01);
              expect(left + w).toBeLessThanOrEqual(b.x1 + 0.01);
              expect(it.y).toBeGreaterThan(b.y0);
              expect(it.y).toBeLessThan(b.y1);
            }
            for (const d of r.dots) {
              expect(d.py).toBeGreaterThanOrEqual(plot.top);
              expect(d.py).toBeLessThanOrEqual(plot.top + plot.height);
            }
            expect(r.read.close !== null).toBe(pinned);
          }
        }
      }
      expect(n).toBeGreaterThan(80);
    });
  }

  it('読み取りは縦線と反対の側（右半分なら左、左半分なら右）', () => {
    const chart = chartOf(SC, 900, 420);
    const { plot } = chart;
    const [lo, hi] = chart.domain;
    const right = crossOf(
      chart,
      { x: lo + (hi - lo) * 0.8, y: midY(chart), pinned: false },
      900,
      420,
    );
    const left = crossOf(
      chart,
      { x: lo + (hi - lo) * 0.2, y: midY(chart), pinned: false },
      900,
      420,
    );
    expect(right?.read.anchor).toBe('start');
    expect((right?.read.box.x1 ?? 0) < (right?.px ?? 0)).toBe(true);
    expect(left?.read.anchor).toBe('end');
    expect((left?.read.box.x0 ?? 0) > (left?.px ?? 0)).toBe(true);
    expect(right?.read.box.x0).toBeCloseTo(plot.left + 4, 6);
  });

  it('箱は縦線と反対の側の上端。上端の箱が縦線の上の交点を覆うなら下端（足マーカーの帯の上）。交点は箱の外', () => {
    const wide = chartOf(SC, 900, 420);
    const top = crossOf(wide, { x: x0, y: wide.yDomain[1], pinned: false }, 900, 420);
    // 広い描画域: 箱は縦線に届かないので、横線が上端でも上端のまま
    expect(top?.read.box.y0).toBeCloseTo(wide.plot.top + 4, 6);
    let lowered = 0;
    // 220 = 箱が縦線に届く狭い描画域（下端へ移る場合を作る）
    for (const { width, height } of [...SIZES, { width: 220, height: 180 }]) {
      const chart = chartOf(SC, width, height);
      const { plot } = chart;
      const [lo, hi] = chart.domain;
      const [ylo, yhi] = chart.yDomain;
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; j <= 8; j++) {
          const r = crossOf(
            chart,
            { x: lo + ((hi - lo) * i) / 40, y: ylo + ((yhi - ylo) * j) / 8, pinned: true },
            width,
            height,
          );
          if (!r || r.py === null) continue;
          const b = r.read.box;
          expect(r.px >= b.x0 && r.px <= b.x1 && r.py >= b.y0 && r.py <= b.y1).toBe(false);
          if (b.y0 > plot.top + 4) {
            lowered++;
            expect(b.y1).toBeLessThanOrEqual(plot.top + plot.height - 14);
          }
        }
      }
    }
    expect(lowered).toBeGreaterThan(0);
  });

  it('障害物（IV レールの吹き出し）に重なるならもう一方の高さ', () => {
    const chart = chartOf(SC, 900, 420);
    const [lo, hi] = chart.domain;
    // 縦線は左半分（箱は右）。横線は中ほど。箱の位置に障害物
    const cursor = { x: lo + (hi - lo) * 0.2, y: midY(chart), pinned: false };
    const free = crossOf(chart, cursor, 900, 420);
    const b = free?.read.box;
    if (!b) throw new Error('箱が無い');
    const blocked = pnlCrosshair({
      base,
      scenario: SC,
      chart,
      cursor,
      width: 900,
      height: 420,
      obstacles: [{ x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1 }],
    });
    expect(blocked?.read.box.y0).not.toBe(b.y0);
  });
});

describe('交点のラベルの箱（#201）', () => {
  it('markLabelBox: start は labelX から右、end は左へ。高さは 1 行', () => {
    const t = '満 +1,160千円';
    const w = labelWidth(t) * 1.1;
    const a = markLabelBox({ text: t, labelX: 100, labelY: 50, anchor: 'start' });
    expect(a.x0).toBe(100);
    expect(a.x1).toBeCloseTo(100 + w, 6);
    expect(a.y1 - a.y0).toBe(14);
    const b = markLabelBox({ text: t, labelX: 100, labelY: 50, anchor: 'end' });
    expect(b.x1).toBe(100);
    expect(b.x0).toBeCloseTo(100 - w, 6);
  });
});

describe('画素 → 値・読み取りのタップ（#201）', () => {
  it('pnlCursorAt: 描画域の中は値、外は null（clamp なら端の値）', () => {
    const chart = chartOf(SC, 900, 420);
    const { plot } = chart;
    const at = pnlCursorAt(chart, plot.left + plot.width / 2, plot.top + plot.height / 2, false);
    expect(at?.x).toBeCloseTo((chart.domain[0] + chart.domain[1]) / 2, 6);
    expect(at?.y).toBeCloseTo(midY(chart), 6);
    expect(pnlCursorAt(chart, plot.left - 5, plot.top + 10, false)).toBeNull();
    expect(pnlCursorAt(chart, plot.left + 10, plot.top + plot.height + 5, false)).toBeNull();
    const c = pnlCursorAt(chart, plot.left - 50, plot.top - 50, true);
    expect(c?.x).toBeCloseTo(chart.domain[0], 6);
    expect(c?.y).toBeCloseTo(chart.yDomain[1], 6);
  });
});

describe('#227: タッチのタップ（pnlTapCursor）。表示範囲の外の十字線は「出ていない」ので置く', () => {
  it('描いている十字線があれば消す、表示範囲の外へパンした十字線ならタップした位置に置く', () => {
    const chart = chartOf(SC, 900, 420);
    const { plot } = chart;
    const cursor: PnlCursor = { x: x0, y: midY(chart), pinned: true };
    const sx = plot.left + plot.width * 0.25;
    const sy = plot.top + plot.height * 0.4;
    // 表示範囲の中: 描いている → 消す
    expect(crossOf(chart, cursor, 900, 420)).not.toBeNull();
    expect(pnlTapCursor(chart, crossOf(chart, cursor, 900, 420) !== null, sx, sy)).toBeNull();
    // 右へパンして X₀ が表示範囲の外 → 描いていない → 置く（押した位置の値・pinned）
    const w = chart.domain[1] - chart.domain[0];
    const panned = chartOf(SC, 900, 420, [x0 + w * 0.6, x0 + w * 1.6]);
    expect(crossOf(panned, cursor, 900, 420)).toBeNull();
    const placed = pnlTapCursor(panned, crossOf(panned, cursor, 900, 420) !== null, sx, sy);
    const at = pnlCursorAt(panned, sx, sy, false);
    expect(placed).toEqual({ x: at?.x, y: at?.y, pinned: true });
    // 描画域の外のタップは置かない
    expect(pnlTapCursor(panned, false, plot.left - 5, sy)).toBeNull();
  });
});

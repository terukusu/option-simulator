/**
 * 持ちこたえマップの表示モデル（#152 段 B の B6・B7。ui/view/holdMap.ts）。板・過去の点は合成（架空の値）。
 */

import { describe, expect, it } from 'vitest';
import type { AtmMove } from '../../data/atmDaily';
import {
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  holdMapAxes,
  type Leg,
  type MarginParams,
  preparePosition,
  type Scenario,
  ZERO_SCENARIO,
} from '../../model';
import {
  HOLD_MAP_EMPTY,
  HOLD_MAP_FAILED,
  HOLD_MAP_IDLE_READOUT,
  HOLD_MAP_LOADING,
  HOLD_MAP_MAX_X_TICKS,
  HOLD_MAP_MAX_Y_TICKS,
  HOLD_MAP_NO_CAPITAL,
  HOLD_MAP_NO_LEGS,
  type HoldMapResult,
  holdMapBaseScenario,
  holdMapDxX,
  holdMapInput,
  holdMapNote,
  holdMapPick,
  holdMapPlot,
  holdMapReadout,
  holdMapRooms,
  holdMapStatusText,
  holdMapStep,
  holdMapSummary,
} from '../../ui/view/holdMap';
import { pnlDomains } from '../../ui/view/pnlChart';
import { M1, M2, makeMarket, quoteOf } from '../support/market';
import { widthUnits } from '../support/widthUnits';

const { ctx, rows } = makeMarket();
const rows1 = rows[M1.id] as NonNullable<(typeof rows)[string]>;
const board = {
  months: [
    { F: M1.F, rows: rows[M1.id] ?? [] },
    { F: M2.F, rows: rows[M2.id] ?? [] },
  ],
};
const PARAMS: MarginParams = { ...DEFAULT_MARGIN_PARAMS };

function putSell(k: number, qty = 2): Leg {
  const q = quoteOf(rows1, k, 'put');
  return {
    kind: 'option',
    product: 'op_large',
    type: 'put',
    expiry: M1.id,
    strike: k,
    side: 'sell',
    qty,
    entry: q.bid,
    mid: q.mid,
  };
}

function baseOf(legs: readonly Leg[]) {
  const b = pnlDomains(board, preparePosition(legs, ctx), ctx, DEFAULT_SETTINGS);
  if (!b) throw new Error('基礎が作れない');
  return b;
}

const BASE = baseOf([putSell(62000)]);

/** 架空の 2 営業日の動き（日付・値とも架空） */
const MOVES: AtmMove[] = [
  { d0: '2031-03-03', d1: '2031-03-05', dx: -0.05, iv0: 20, iv1: 26, ivRatio: 1.3, ivPt: 6 },
  {
    d0: '2031-03-04',
    d1: '2031-03-06',
    dx: 0.012,
    iv0: 21,
    iv1: 19.95,
    ivRatio: 0.95,
    ivPt: -1.05,
  },
  { d0: '2031-12-29', d1: '2032-01-02', dx: -0.2, iv0: 18, iv1: 36, ivRatio: 2, ivPt: 18 },
  { d0: '2032-01-05', d1: '2032-01-07', dx: 0.002, iv0: 22, iv1: 22.22, ivRatio: 1.01, ivPt: 0.22 },
];

function resultFor(capital: number, moves: readonly AtmMove[] = MOVES): HoldMapResult {
  const input = holdMapInput(BASE, ZERO_SCENARIO, PARAMS, capital, []);
  if (!input) throw new Error('入力が作れない');
  const axes = holdMapAxes(moves);
  return { input, axes, rooms: holdMapRooms(input, axes) };
}

// 資金は追証の側と余力ありの側の両方が出る額（架空）
const CAPITAL = 6_000_000;
const RESULT = resultFor(CAPITAL);

describe('B6 表示モデル', () => {
  it('マスの色は 2 種（余力あり / 追証）だけ、境目の線の path がある', () => {
    const plot = holdMapPlot(RESULT, MOVES, 600);
    expect(plot.cells.map((c) => c.cls).sort()).toEqual(['hm-call', 'hm-ok']);
    for (const c of plot.cells) expect(c.d).toMatch(/^M[\d.]+ [\d.]+h/);
    expect(plot.contour).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+/);
    expect(plot.now).not.toBeNull();
  });

  it('資金が十分なら 1 色だけ（追証のマスなし・線なし）', () => {
    const plot = holdMapPlot(resultFor(1e9), MOVES, 600);
    expect(plot.cells.map((c) => c.cls)).toEqual(['hm-ok']);
    expect(plot.contour).toBe('');
  });

  it('要約 `過去 N 回の 2 営業日の動きのうち M 回が追証の側`、点の印は 2 形', () => {
    const plot = holdMapPlot(RESULT, MOVES, 600);
    expect(plot.count.n).toBe(MOVES.length);
    expect(plot.count.m).toBeGreaterThan(0);
    expect(plot.count.m).toBeLessThan(plot.count.n);
    expect(holdMapSummary(plot.count)).toBe(
      `過去 ${plot.count.n} 回の 2 営業日の動きのうち ${plot.count.m} 回が追証の側`,
    );
    // −20% · ×2 は追証の側（×）、+0.2% · ×1.01 は余力あり（丸）
    expect(plot.count.calls[2]).toBe(true);
    expect(plot.count.calls[3]).toBe(false);
    expect(plot.callMarks).toMatch(/l5 5m0 -5l-5 5/);
    expect(plot.okDots).toMatch(/a1\.6 1\.6/);
  });

  it('資金が未設定なら案内の文（入力を作らない = マスを作らない）', () => {
    expect(holdMapInput(BASE, ZERO_SCENARIO, PARAMS, null, [])).toBeNull();
    const s = holdMapStatusText({
      noLegs: false,
      noCapital: true,
      computing: false,
      movesStatus: 'idle',
      movesCount: 0,
    });
    expect(s.main).toBe(HOLD_MAP_NO_CAPITAL);
    expect(s.main).toBe('設定で資金を入れてください（⋯ > 設定…）');
    expect(s.moves).toBeNull();
  });

  it('足なし・過去の点の読み込み中 / 失敗（再試行）/ 0 件の文', () => {
    const empty = pnlDomains(board, [], ctx, DEFAULT_SETTINGS);
    expect(holdMapInput(empty, ZERO_SCENARIO, PARAMS, CAPITAL, [])).toBeNull();
    const st = (o: Partial<Parameters<typeof holdMapStatusText>[0]>) =>
      holdMapStatusText({
        noLegs: false,
        noCapital: false,
        computing: false,
        movesStatus: 'ok',
        movesCount: 3,
        ...o,
      });
    expect(st({ noLegs: true }).main).toBe(HOLD_MAP_NO_LEGS);
    expect(st({ movesStatus: 'loading' })).toEqual({
      main: null,
      moves: HOLD_MAP_LOADING,
      retry: false,
    });
    expect(HOLD_MAP_LOADING).toBe('過去の値動きを読み込み中…');
    expect(st({ movesStatus: 'failed' })).toEqual({
      main: null,
      moves: HOLD_MAP_FAILED,
      retry: true,
    });
    expect(HOLD_MAP_FAILED).toBe('過去の値動きを読めない');
    expect(st({ movesCount: 0 }).moves).toBe(HOLD_MAP_EMPTY);
    expect(st({ computing: true }).main).toBe('計算中…');
    expect(st({})).toEqual({ main: null, moves: null, retry: false });
  });

  it('点を触った 1 行: 日付・原資産 ±%・IV a → b %・×r・±pt・余力', () => {
    const s = holdMapReadout({ kind: 'point', k: 0 }, RESULT, MOVES, 'thousand');
    expect(s).toMatch(
      /^2031-03-03 → 03-05 · 原資産 −5\.0% · IV 20\.0 → 26\.0%（×1\.30 · \+6\.0pt）· 余力 [+−]?[\d,.]+ 千円 · (追証|余力あり)$/,
    );
    // 年を跨ぐと d1 は年から
    expect(holdMapReadout({ kind: 'point', k: 2 }, RESULT, MOVES, 'yen')).toMatch(
      /^2031-12-29 → 2032-01-02 · 原資産 −20\.0% · IV 18\.0 → 36\.0%（×2\.00 · \+18\.0pt）· 余力 −[\d,]+ 円 · 追証$/,
    );
    expect(holdMapReadout({ kind: 'point', k: 1 }, RESULT, MOVES, 'yen')).toContain(
      '原資産 +1.2% · IV 21.0 → 20.0%（×0.95 · −1.1pt）',
    );
  });

  it('マスを触った 1 行: 原資産 %・IV ×・余力', () => {
    const { us, cs } = RESULT.axes;
    const i = us.findIndex((u) => Math.abs(u + 0.1) < 1e-9);
    const j = cs.findIndex((c) => Math.abs(c - 1.6) < 1e-9);
    const room = RESULT.rooms[i]?.[j] as number;
    const s = holdMapReadout({ kind: 'cell', i, j }, RESULT, MOVES, 'yen');
    expect(s).toMatch(/^原資産 −10% · IV ×1\.6 · 余力 [+−]?[\d,]+ 円 · (追証|余力あり)$/);
    expect(s.endsWith(room < 0 ? '追証' : '余力あり')).toBe(true);
    expect(holdMapReadout(null, RESULT, MOVES, 'yen')).toBe(HOLD_MAP_IDLE_READOUT);
  });

  it('幅 328px（360px の画面の中身）: SVG の幅はそれ以下、軸のラベルが重ならない（数の上限）', () => {
    for (const width of [328, 296, 420, 1000]) {
      const plot = holdMapPlot(RESULT, MOVES, width);
      expect(plot.width).toBeLessThanOrEqual(width);
      expect(plot.height).toBeGreaterThanOrEqual(200);
      expect(plot.height).toBeLessThanOrEqual(300);
      expect(plot.xTicks.length).toBeGreaterThanOrEqual(3);
      expect(plot.xTicks.length).toBeLessThanOrEqual(HOLD_MAP_MAX_X_TICKS);
      expect(plot.yTicks.length).toBeGreaterThanOrEqual(3);
      expect(plot.yTicks.length).toBeLessThanOrEqual(HOLD_MAP_MAX_Y_TICKS);
      // 横: 隣の目盛りの間 ≥ ラベルの幅（10px の等幅 ≈ 1 単位 6px）+ 余白
      for (let k = 1; k < plot.xTicks.length; k++) {
        const a = plot.xTicks[k - 1];
        const b = plot.xTicks[k];
        if (!a || !b) continue;
        const need = (widthUnits(a.label) + widthUnits(b.label)) * 3 + 4;
        expect(b.at - a.at).toBeGreaterThanOrEqual(need);
        expect(b.at).toBeLessThanOrEqual(plot.width);
      }
      // 縦: 文字の高さ（10px）より離れる
      for (let k = 1; k < plot.yTicks.length; k++) {
        const a = plot.yTicks[k - 1];
        const b = plot.yTicks[k];
        if (a && b) expect(Math.abs(b.at - a.at)).toBeGreaterThanOrEqual(12);
      }
      // 縦のラベルは左の余白（36px）に収まる
      for (const t of plot.yTicks) expect(widthUnits(t.label) * 6).toBeLessThanOrEqual(plot.left);
    }
    const plot = holdMapPlot(RESULT, MOVES, 328);
    expect(plot.xTicks.map((t) => t.label)).toEqual(['−30%', '−20%', '−10%', '0%', '+10%', '+20%']);
    expect(plot.yTicks.map((t) => t.label)).toEqual(['×0.5', '×1', '×1.5', '×2', '×2.5']);
  });

  it('触る: 14px 以内の最も近い点、無ければそのマス、描画域の外は null', () => {
    const plot = holdMapPlot(RESULT, MOVES, 600);
    const x = plot.px[2] as number;
    const y = plot.py[2] as number;
    expect(holdMapPick(plot, RESULT.axes, x + 5, y - 5)).toEqual({ kind: 'point', k: 2 });
    // 点から離れたマス（u = +16%、c = ×2.4）
    const cell = holdMapPick(plot, RESULT.axes, plot.right - 30, plot.top + 15);
    expect(cell?.kind).toBe('cell');
    expect(holdMapPick(plot, RESULT.axes, 2, 2)).toBeNull();
  });

  it('矢印キーでマスを 1 つずつ動かす（初めは今のマス、端で止まる）', () => {
    const { axes } = RESULT;
    const s0 = holdMapStep(null, axes, 'ArrowLeft');
    expect(s0).toEqual({
      kind: 'cell',
      i: axes.us.indexOf(0),
      j: axes.cs.indexOf(1),
    });
    const s1 = holdMapStep(s0, axes, 'ArrowUp');
    expect(s1).toEqual({ kind: 'cell', i: axes.us.indexOf(0), j: axes.cs.indexOf(1) + 1 });
    let s = s1;
    for (let k = 0; k < 40; k++) s = holdMapStep(s, axes, 'ArrowRight');
    expect(s).toEqual({ kind: 'cell', i: axes.us.length - 1, j: axes.cs.indexOf(1) + 1 });
    expect(holdMapStep(s, axes, 'a')).toBeNull();
  });

  it('シナリオの ΔX の縦の破線（0・範囲の外は null）と注記', () => {
    expect(holdMapDxX(RESULT.axes, 600, 0)).toBeNull();
    expect(holdMapDxX(RESULT.axes, 600, -0.6)).toBeNull();
    const x = holdMapDxX(RESULT.axes, 600, -0.1);
    expect(x).not.toBeNull();
    expect(holdMapNote(MOVES, 5)).toBe(
      '点 = 2031-03〜2032-01 の 2 営業日（日中の終値）の原資産と ATM IV（30 日）の倍率。重なりあり・足の IV が同じ倍率で動くと見なした近似。マップの日数はシナリオの d（5 日）',
    );
  });
});

describe('B7 マップの入力は ΔX・Δσ・β で変わらない', () => {
  const sc: Scenario = { ...ZERO_SCENARIO, days: 4, skew: 1, ivDynamics: 'sticky_strike' };
  const key = (
    s: Scenario,
    o: { base?: typeof BASE; capital?: number; params?: MarginParams } = {},
  ) => holdMapInput(o.base ?? BASE, s, o.params ?? PARAMS, o.capital ?? CAPITAL, []);

  it('ΔX・Δσ・β・ivShift だけを変えたシナリオで同じキー', () => {
    const k0 = key(sc);
    for (const patch of [
      { dX: -3000 },
      { dSigma: 12 },
      { beta: 2.5 },
      { ivShift: 'relative' as const },
      { dX: 500, dSigma: -3, beta: 0, ivShift: 'relative' as const },
    ]) {
      expect(key({ ...sc, ...patch })).toEqual(k0);
      expect(holdMapBaseScenario({ ...sc, ...patch })).toEqual(holdMapBaseScenario(sc));
    }
  });

  it('d・Δs・動き方・足・資金・パラメータで違うキー', () => {
    const k0 = key(sc);
    expect(key({ ...sc, days: 5 })).not.toEqual(k0);
    expect(key({ ...sc, skew: 2 })).not.toEqual(k0);
    expect(key({ ...sc, ivDynamics: 'sticky_moneyness' })).not.toEqual(k0);
    expect(key(sc, { base: baseOf([putSell(63000)]) })).not.toEqual(k0);
    expect(key(sc, { capital: CAPITAL + 1 })).not.toEqual(k0);
    expect(key(sc, { params: { ...PARAMS, range: 0.06 } })).not.toEqual(k0);
  });
});

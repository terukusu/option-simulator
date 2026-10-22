/**
 * 追証マップの表示モデル（#152 段 B の B6・B7。ui/view/holdMap.ts）。板・過去の点は合成（架空の値）。
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
  HOLD_MAP_CAPTION,
  HOLD_MAP_COMPUTING,
  HOLD_MAP_EMPTY,
  HOLD_MAP_FAILED,
  HOLD_MAP_IDLE_READOUT,
  HOLD_MAP_LOADING,
  HOLD_MAP_MAX_X_TICKS,
  HOLD_MAP_MAX_Y_TICKS,
  HOLD_MAP_NO_CAPITAL,
  HOLD_MAP_NO_LEGS,
  HOLD_MAP_PLOT_LABEL,
  HOLD_MAP_TITLE,
  type HoldMapResult,
  holdMapBaseScenario,
  holdMapCaption,
  holdMapCellAt,
  holdMapCrosshair,
  holdMapDxX,
  holdMapInput,
  holdMapLegend,
  holdMapNote,
  holdMapPick,
  holdMapPlot,
  holdMapReadout,
  holdMapResultOf,
  holdMapReveal,
  holdMapStatusText,
  holdMapStep,
  holdMapSummary,
  holdMapTitle,
  holdMapWait,
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
  return holdMapResultOf(input, axes);
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
      movesStatus: 'idle',
      movesCount: 0,
    });
    expect(s.main).toBe(HOLD_MAP_NO_CAPITAL);
    expect(s.main).toBe('設定で資金を入れてください（⋯ > 設定…）');
    expect(s.moves).toBeNull();
  });

  it('足なし・過去の点の失敗（再試行）/ 0 件の文', () => {
    const empty = pnlDomains(board, [], ctx, DEFAULT_SETTINGS);
    expect(holdMapInput(empty, ZERO_SCENARIO, PARAMS, CAPITAL, [])).toBeNull();
    const st = (o: Partial<Parameters<typeof holdMapStatusText>[0]>) =>
      holdMapStatusText({
        noLegs: false,
        noCapital: false,
        movesStatus: 'ok',
        movesCount: 3,
        ...o,
      });
    expect(st({ noLegs: true }).main).toBe(HOLD_MAP_NO_LEGS);
    expect(st({ movesStatus: 'failed' })).toEqual({
      main: null,
      moves: HOLD_MAP_FAILED,
      retry: true,
    });
    expect(HOLD_MAP_FAILED).toBe('過去の値動きを読めない');
    expect(st({ movesCount: 0 }).moves).toBe(HOLD_MAP_EMPTY);
    expect(st({})).toEqual({ main: null, moves: null, retry: false });
  });

  it('holdMapStatusText: 読み込み中・計算中の文は状態の行に出さない（失敗・0 件・再試行だけ）', () => {
    for (const movesStatus of ['idle', 'loading'] as const) {
      expect(
        holdMapStatusText({ noLegs: false, noCapital: false, movesStatus, movesCount: 0 }),
      ).toEqual({ main: null, moves: null, retry: false });
    }
  });
  it('点を触った 1 行: 日付・原資産 ±%・IV a → b %・×r・±pt・余力・損益（#180）', () => {
    const s = holdMapReadout({ kind: 'point', k: 0 }, RESULT, MOVES, 'thousand');
    expect(s).toMatch(
      /^2031-03-03 → 03-05 · 原資産 −5\.0% · IV 20\.0 → 26\.0%（×1\.30 · \+6\.0pt）· 余力 [+−]?[\d,.]+ 千円 · (追証|余力あり) · 損益 [+−]?[\d,.]+ 千円$/,
    );
    // 年を跨ぐと d1 は年から
    expect(holdMapReadout({ kind: 'point', k: 2 }, RESULT, MOVES, 'yen')).toMatch(
      /^2031-12-29 → 2032-01-02 · 原資産 −20\.0% · IV 18\.0 → 36\.0%（×2\.00 · \+18\.0pt）· 余力 −[\d,]+ 円 · 追証 · 損益 −[\d,]+ 円$/,
    );
    expect(holdMapReadout({ kind: 'point', k: 1 }, RESULT, MOVES, 'yen')).toContain(
      '原資産 +1.2% · IV 21.0 → 20.0%（×0.95 · −1.1pt）',
    );
  });

  it('マスを触った 1 行: 原資産 %・IV ×・余力・損益（#180）', () => {
    const { us, cs } = RESULT.axes;
    const i = us.findIndex((u) => Math.abs(u + 0.1) < 1e-9);
    const j = cs.findIndex((c) => Math.abs(c - 1.6) < 1e-9);
    const room = RESULT.rooms[i]?.[j] as number;
    const s = holdMapReadout({ kind: 'cell', i, j }, RESULT, MOVES, 'yen');
    expect(s).toMatch(
      /^原資産 −10% · IV ×1\.6 · 余力 [+−]?[\d,]+ 円 · (追証|余力あり) · 損益 [+−]?[\d,]+ 円$/,
    );
    expect(s).toContain(room < 0 ? '· 追証 ·' : '· 余力あり ·');
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

describe('#174 待ちの表示・開いたときのスクロール', () => {
  const wait = (o: Partial<Parameters<typeof holdMapWait>[0]>) =>
    holdMapWait({
      noLegs: false,
      noCapital: false,
      computing: false,
      movesStatus: 'ok',
      ...o,
    });

  it('holdMapWait: 読み込み中（idle / loading）は HOLD_MAP_LOADING、計算中は HOLD_MAP_COMPUTING、終わったら null', () => {
    expect(HOLD_MAP_LOADING).toBe('過去の値動きを読み込み中…');
    expect(HOLD_MAP_COMPUTING).toBe('計算中…');
    expect(wait({ movesStatus: 'idle' })).toBe(HOLD_MAP_LOADING);
    expect(wait({ movesStatus: 'loading' })).toBe(HOLD_MAP_LOADING);
    // 読み込み中は計算中より先（点が読めると軸が広がって作り直しうる）
    expect(wait({ movesStatus: 'loading', computing: true })).toBe(HOLD_MAP_LOADING);
    expect(wait({ computing: true })).toBe(HOLD_MAP_COMPUTING);
    expect(wait({ movesStatus: 'failed', computing: true })).toBe(HOLD_MAP_COMPUTING);
    expect(wait({})).toBeNull();
    expect(wait({ movesStatus: 'failed' })).toBeNull();
  });

  it('holdMapWait: 足なし・資金なしは null', () => {
    expect(wait({ noLegs: true, computing: true, movesStatus: 'loading' })).toBeNull();
    expect(wait({ noCapital: true, computing: true, movesStatus: 'idle' })).toBeNull();
  });

  it('holdMapReveal: 枠の下にはみ出した分だけ下へ・描画域の上端を隠さない・見えていれば 0・reduced-motion は即時（auto）', () => {
    // 枠 100〜500。描画域 520〜760 → はみ出し 260、描画域の上の余地 420 → 260（見出しが 486 なら 226 に残る）
    expect(holdMapReveal(520, 760, 100, 500, false)).toEqual({ delta: 260, behavior: 'smooth' });
    // 描画域が枠より高い: 描画域の上端を枠の上端まで（420）。それ以上は動かさない
    expect(holdMapReveal(520, 1200, 100, 500, false).delta).toBe(420);
    // 見えている（下端 ≤ 枠の下端）なら 0
    expect(holdMapReveal(200, 480, 100, 500, false).delta).toBe(0);
    expect(holdMapReveal(200, 500, 100, 500, false).delta).toBe(0);
    // 描画域の上端が既に枠の上端より上でも負にしない
    expect(holdMapReveal(50, 800, 100, 500, false).delta).toBe(0);
    // reduced-motion は即時
    expect(holdMapReveal(520, 760, 100, 500, true)).toEqual({ delta: 260, behavior: 'auto' });
    // 有限でない値は動かさない
    expect(holdMapReveal(Number.NaN, 800, 100, 500, false).delta).toBe(0);
  });
});

describe('#179 名前と見出しの下の説明', () => {
  it('見出しは「追証マップ」、描画域の名前も同じ名前で始まる', () => {
    expect(HOLD_MAP_TITLE).toBe('追証マップ');
    expect(HOLD_MAP_PLOT_LABEL.startsWith('追証マップ')).toBe(true);
  });

  it('説明は「原資産と IV が同時に動いたときの余力」で始まり、追証の側は概算・実際の判定は引けの清算値と書く', () => {
    expect(HOLD_MAP_CAPTION.startsWith('原資産と IV が同時に動いたときの余力')).toBe(true);
    expect(HOLD_MAP_CAPTION).toContain('概算');
    expect(HOLD_MAP_CAPTION).toContain('引けの清算値');
    expect(HOLD_MAP_CAPTION).toContain('引けで戻れば追証にならない');
    // 過去の点の近似は点の注記（holdMapNote）だけに書く（説明に重ねない）
    expect(HOLD_MAP_CAPTION).not.toContain('近似');
  });
});

describe('追証マップの十字線（#217）', () => {
  it.each([328, 600, 1200])(
    '幅 %d: マスの中心に吸着し、札 = ΔX%%・×倍率、読み取り = そのマスの余力、札は svg の内側',
    (width) => {
      const plot = holdMapPlot(RESULT, MOVES, width);
      const { axes } = RESULT;
      for (const [fx, fy] of [
        [0.01, 0.01],
        [0.5, 0.5],
        [0.99, 0.99],
      ] as const) {
        const x = plot.left + (plot.right - plot.left) * fx;
        const y = plot.top + (plot.bottom - plot.top) * fy;
        const c = holdMapCrosshair(plot, RESULT, x, y, MOVES, 'yen');
        const cell = holdMapCellAt(plot, axes, x, y);
        if (!c || !cell) throw new Error('十字線が無い');
        const u = axes.us[cell.i] as number;
        const cv = axes.cs[cell.j] as number;
        // 吸着: 縦線・横線はマスの中心（指から半マス以内）
        const cw = (plot.right - plot.left) / axes.us.length;
        const ch = (plot.bottom - plot.top) / axes.cs.length;
        expect(Math.abs(c.x - x)).toBeLessThanOrEqual(cw / 2 + 0.1);
        expect(Math.abs(c.y - y)).toBeLessThanOrEqual(ch / 2 + 0.1);
        expect(c.xTag.text).toBe(
          `${u > 0 ? '+' : u < 0 ? '−' : ''}${Math.abs(Math.round(u * 100))}%`,
        );
        expect(c.yTag.text).toBe(`×${cv.toFixed(1)}`);
        // 読み取り = マスの 1 行（holdMapReadout と同じ = 余力はそのマスの値）
        expect(c.readout).toBe(holdMapReadout(cell, RESULT, MOVES, 'yen'));
        expect(c.readout).toContain('余力');
        for (const t of [c.xTag, c.yTag]) {
          expect(t.x).toBeGreaterThanOrEqual(0);
          expect(t.x + t.w).toBeLessThanOrEqual(plot.width + 0.01);
          expect(t.y).toBeGreaterThanOrEqual(0);
          expect(t.y + t.h).toBeLessThanOrEqual(plot.height + 0.01);
        }
      }
    },
  );

  it('描画域の外・非数は null（点の近くでも十字線はマス）', () => {
    const plot = holdMapPlot(RESULT, MOVES, 600);
    expect(holdMapCrosshair(plot, RESULT, 2, 2, MOVES, 'yen')).toBeNull();
    expect(holdMapCrosshair(plot, RESULT, Number.NaN, 50, MOVES, 'yen')).toBeNull();
    const x = plot.px[2] as number;
    const y = plot.py[2] as number;
    const c = holdMapCrosshair(plot, RESULT, x, y, MOVES, 'yen');
    expect(c?.readout.startsWith('原資産')).toBe(true);
  });
});

describe('#180 許容損失の境目', () => {
  const { us, cs } = RESULT.axes;
  // 許容損失（架空）: 余力ありのマスの損益の最小の半分 = 許容損失超かつ追証でないマスができる
  const okPnls = RESULT.pnls.flatMap((col, i) =>
    [...col].filter((_, j) => (RESULT.rooms[i]?.[j] as number) >= 0),
  );
  const LOSS = Math.round(-Math.min(...okPnls) / 2);

  it('(a) 許容損失が未設定なら 2 本目の境目・3 色目のマス・凡例が無く、見出しは「追証マップ」のまま', () => {
    const plot = holdMapPlot(RESULT, MOVES, 600, null);
    expect(plot.lossContour).toBe('');
    expect(plot.cells.map((c) => c.cls)).not.toContain('hm-loss');
    expect(holdMapLegend(null)).toEqual([]);
    expect(holdMapTitle(3, null)).toBe(HOLD_MAP_TITLE);
    // 既定の引数（今までの呼び方）も同じ
    expect(holdMapPlot(RESULT, MOVES, 600)).toEqual(plot);
  });

  it('(b) 設定ありなら見出しに `d 日後`、凡例は 3 項目、許容損失超のマスと 2 本目の境目がある', () => {
    expect(LOSS).toBeGreaterThan(0);
    expect(holdMapTitle(3, LOSS)).toBe('追証マップ · 3 日後');
    expect(holdMapTitle(0, LOSS)).toContain('0 日後');
    expect(holdMapTitle(2.5, LOSS)).toContain('2.5 日後');
    // マップを出さない（資金・足なし）ときは d を付けない
    expect(holdMapTitle(3, LOSS, false)).toBe(HOLD_MAP_TITLE);
    // 説明: 設定ありのときだけ破線と許容損失超の読み方を足す
    expect(holdMapCaption(null)).toBe(HOLD_MAP_CAPTION);
    expect(holdMapCaption(LOSS).startsWith(HOLD_MAP_CAPTION)).toBe(true);
    expect(holdMapCaption(LOSS)).toContain('破線 = d 日後の損益が −許容損失になる境目');
    expect(holdMapLegend(LOSS).map((k) => k.label)).toEqual(['許容内', '許容損失超', '追証']);
    const plot = holdMapPlot(RESULT, MOVES, 600, LOSS);
    expect(plot.lossContour).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+/);
    expect(plot.cells.map((c) => c.cls)).toContain('hm-loss');
    // 追証のマスは許容損失によらず同じ（追証が優先）
    const callOf = (p: typeof plot) => p.cells.find((c) => c.cls === 'hm-call')?.d;
    expect(callOf(plot)).toBe(callOf(holdMapPlot(RESULT, MOVES, 600, null)));
  });

  it('マスの色: 余力 < 0 は追証、余力 ≥ 0 で損益 < −許容損失は許容損失超、ほかは許容内（マスの数が一致）', () => {
    let nCall = 0;
    let nLoss = 0;
    let nOk = 0;
    us.forEach((_, i) => {
      cs.forEach((_, j) => {
        const room = RESULT.rooms[i]?.[j] as number;
        const pnl = RESULT.pnls[i]?.[j] as number;
        if (!Number.isFinite(room)) return;
        if (room < 0) nCall++;
        else if (!Number.isFinite(pnl)) return;
        else if (pnl + LOSS < 0) nLoss++;
        else nOk++;
      });
    });
    const plot = holdMapPlot(RESULT, MOVES, 600, LOSS);
    const count = (cls: string) =>
      (plot.cells.find((c) => c.cls === cls)?.d.match(/M/g) ?? []).length;
    expect([count('hm-call'), count('hm-loss'), count('hm-ok')]).toEqual([nCall, nLoss, nOk]);
    expect(nLoss).toBeGreaterThan(0);
  });

  it('許容損失があるとき、損益が有限でないマスは（余力が有限でも）塗らない。許容損失が無ければ余力の色', () => {
    const { us: u2 } = RESULT.axes;
    const i = u2.findIndex((u) => Math.abs(u) < 1e-9);
    const j = RESULT.axes.cs.findIndex((c) => Math.abs(c - 1) < 1e-9);
    expect(RESULT.rooms[i]?.[j] as number).toBeGreaterThanOrEqual(0);
    const pnls = RESULT.pnls.map((c) => Float64Array.from(c));
    (pnls[i] as Float64Array)[j] = Number.NaN;
    const broken = { ...RESULT, pnls };
    const cellsOf = (p: ReturnType<typeof holdMapPlot>) =>
      p.cells.reduce((n, c) => n + (c.d.match(/M/g) ?? []).length, 0);
    expect(cellsOf(holdMapPlot(broken, MOVES, 600, LOSS))).toBe(
      cellsOf(holdMapPlot(RESULT, MOVES, 600, LOSS)) - 1,
    );
    expect(cellsOf(holdMapPlot(broken, MOVES, 600, null))).toBe(
      cellsOf(holdMapPlot(RESULT, MOVES, 600, null)),
    );
  });

  it('(c) 読み取りの 1 行に損益（設定ありなら 許容内 / 許容損失超）。十字線も同じ', () => {
    const i = us.findIndex((u) => Math.abs(u + 0.1) < 1e-9);
    const j = cs.findIndex((c) => Math.abs(c - 1.6) < 1e-9);
    const pnl = RESULT.pnls[i]?.[j] as number;
    const s = holdMapReadout({ kind: 'cell', i, j }, RESULT, MOVES, 'yen', LOSS);
    expect(s).toContain('損益 ');
    expect(s.endsWith(pnl + LOSS < 0 ? '· 許容損失超' : '· 許容内')).toBe(true);
    const p = holdMapReadout({ kind: 'point', k: 2 }, RESULT, MOVES, 'yen', LOSS);
    expect(p).toMatch(/· 損益 −[\d,]+ 円 · (許容内|許容損失超)$/);
    const plot = holdMapPlot(RESULT, MOVES, 600, LOSS);
    const xh = holdMapCrosshair(plot, RESULT, plot.left + 5, plot.bottom - 5, MOVES, 'yen', LOSS);
    expect(xh?.readout).toMatch(/· 損益 [+−]?[\d,]+ 円 · (許容内|許容損失超)$/);
  });
});

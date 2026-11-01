import { describe, expect, it } from 'vitest';
import type { OptBar } from '../../data';
import { ivChartModel, resolveIvViewport } from '../../ui/view/ivHistory';
import {
  OPT_TFS,
  type OptTarget,
  optBand,
  optEntryLevel,
  optKey,
  optLtdOf,
  optOpenLabel,
  optPlotBars,
  optReadout,
  optReadoutIndex,
  optSegments,
  optTargetOfLeg,
  optTitle,
  optTradeIvMarks,
  optTradeMarks,
} from '../../ui/view/optHistory';
import {
  INITIAL_SHELL,
  ivVisible,
  marketAttr,
  optVisible,
  type ShellState,
  shellReduce,
  smileView,
} from '../../ui/view/shell';

/**
 * #319 AC 4: 銘柄の推移の表示モデル（ui/view/optHistory.ts）と開く所（ui/view/shell.ts の opt / optClose）。
 * 値はすべて架空（合成の足）。
 */

const H = 3600;
const T0 = Date.parse('2026-11-02T09:00:00+09:00') / 1000; // 月曜の日中
const NTD: ReadonlySet<string> = new Set();

/** 気配のある足（mid = v 前後、bid / ask = v ∓ 5） */
const q = (t: number, v: number, over: Partial<OptBar> = {}): OptBar => ({
  t,
  o: v,
  h: v + 3,
  l: v - 3,
  c: v + 1,
  bid: v - 5,
  ask: v + 5,
  bidIv: 20,
  askIv: 21,
  trade: null,
  tradeIv: null,
  ...over,
});
/** 気配の無い約定だけの足 */
const tr = (t: number, px: number, iv: number | null = 22): OptBar => ({
  t,
  o: null,
  h: null,
  l: null,
  c: null,
  bid: null,
  ask: null,
  bidIv: null,
  askIv: null,
  trade: px,
  tradeIv: iv,
});

// 日中 6 本: 2 本目・3 本目が気配なし（約定だけ）、5 本目は約定あり
const BARS: OptBar[] = [
  q(T0, 100),
  tr(T0 + H, 120, 25),
  tr(T0 + 2 * H, 130),
  q(T0 + 3 * H, 110),
  q(T0 + 4 * H, 112, { trade: 113, tradeIv: 21.5 }),
  q(T0 + 5 * H, 115),
];
const TARGET: OptTarget = { month: '2026-11', ltd: '2026-11-12', k: 30000, type: 'put' };

describe('optPlotBars・optSegments（気配の無い足で切る）', () => {
  const p = optPlotBars(BARS);

  it('気配の無い足は skip、値段の段の値は約定の値段（並びに残す）', () => {
    expect(p.skip).toEqual([false, true, true, false, false, false]);
    expect(p.price[1]).toEqual({ t: T0 + H, o: 120, h: 120, l: 120, c: 120 });
    expect(p.price[0]).toEqual({ t: T0, o: 100, h: 103, l: 97, c: 101 });
  });

  it('IV の段: 気配の IV の中値、無ければ約定 IV を入れて ivSkip', () => {
    expect(p.iv[0]?.c).toBe(20.5);
    expect(p.iv[1]?.c).toBe(25);
    expect(p.ivSkip).toEqual([false, true, true, false, false, false]);
  });

  it('線の区間が気配の無い足で分かれる（時間の欠けが無くても）', () => {
    expect(optSegments(p.price, p.skip, '1h', NTD)).toEqual([
      [0, 0],
      [3, 5],
    ]);
    expect(
      optSegments(
        p.price,
        p.price.map(() => false),
        '1h',
        NTD,
      ),
    ).toEqual([[0, 5]]);
  });

  it('逆転した気配（bid > ask）は気配なし（ローソク・帯・気配の IV を描かない）', () => {
    const inv = [q(T0, 100, { bid: 110, ask: 100, trade: 104 })];
    const pi = optPlotBars(inv);
    expect(pi.skip).toEqual([true]);
    expect(pi.ivSkip).toEqual([true]);
    expect(optBand(inv).lo).toEqual([null]);
    expect(optReadout(inv, '1h', 0, null).quote).toBeNull();
  });
});

describe('帯・約定の点・建値の線', () => {
  it('帯は気配の無い足で null（切れる）、約定の点は気配に依らず残る', () => {
    const b = optBand(BARS);
    expect(b.lo).toEqual([95, null, null, 105, 107, 110]);
    expect(b.hi).toEqual([105, null, null, 115, 117, 120]);
    expect(optTradeMarks(BARS).values).toEqual([null, 120, 130, null, 113, null]);
    expect(optTradeIvMarks(BARS).values).toEqual([null, 25, 22, null, 21.5, null]);
  });

  it('建値の線は足の詳細から開いたとき（entry あり）だけ、値は足の建値', () => {
    expect(optEntryLevel(TARGET)).toBeNull();
    expect(optEntryLevel(null)).toBeNull();
    expect(optEntryLevel({ ...TARGET, entry: { price: 88, side: 'sell' } })).toEqual({
      cls: 'opt-entry',
      value: 88,
    });
  });

  it('描画のモデル: 気配の無い足はローソク・帯を描かず、点は描く。帯・点・建値は縦軸に入る', () => {
    const p = optPlotBars(BARS);
    const segments = optSegments(p.price, p.skip, '1h', NTD);
    const m = ivChartModel({
      bars: p.price,
      tf: '1h',
      mode: 'candle',
      viewport: resolveIvViewport(p.price, '1h', null, null),
      segments,
      width: 600,
      height: 300,
      rightLoaded: false,
      skip: p.skip,
      bands: [optBand(BARS)],
      marks: [optTradeMarks(BARS)],
      level: { cls: 'opt-entry', value: 60 },
    });
    expect(m.candles.map((c) => c.t)).toEqual([T0, T0 + 3 * H, T0 + 4 * H, T0 + 5 * H]);
    // 帯: 1 本だけの区間（矩形）と 3 本の区間 = 閉じた塗りが 2 つ
    expect(m.bands[0]?.d.match(/Z/g)).toHaveLength(2);
    // 約定の点は 3 つ（気配の無い 2 本を含む）
    expect(m.marks[0]?.d.match(/M/g)).toHaveLength(3);
    expect(m.yDomain[0]).toBeLessThan(60);
    expect(m.yDomain[1]).toBeGreaterThan(130);
    expect(m.level?.cls).toBe('opt-entry');
  });

  it('線の形: 気配の無い足で線が分かれ、1 本だけの区間は点', () => {
    const p = optPlotBars(BARS);
    const m = ivChartModel({
      bars: p.price,
      tf: '1h',
      mode: 'line',
      viewport: resolveIvViewport(p.price, '1h', null, null),
      segments: optSegments(p.price, p.skip, '1h', NTD),
      width: 600,
      height: 300,
      rightLoaded: false,
      skip: p.skip,
    });
    expect(m.line.match(/M/g)).toHaveLength(1); // [3, 5] の 1 本
    expect(m.dots.match(/M/g)).toHaveLength(1); // [0, 0] の点
  });

  it('IV の段: 値の無い（NaN）足は縦軸に入れない', () => {
    const p = optPlotBars([q(T0, 100), tr(T0 + H, 120, null), q(T0 + 2 * H, 100)]);
    const m = ivChartModel({
      bars: p.iv,
      tf: '1h',
      mode: 'line',
      viewport: resolveIvViewport(p.iv, '1h', null, null),
      segments: optSegments(p.iv, p.ivSkip, '1h', NTD),
      width: 600,
      height: 300,
      rightLoaded: false,
      skip: p.ivSkip,
    });
    expect(Number.isFinite(m.yDomain[0]) && Number.isFinite(m.yDomain[1])).toBe(true);
  });
});

describe('読み取り', () => {
  it('気配の無い足は quote = null（「気配なし」）で約定は出す', () => {
    const r = optReadout(BARS, '1h', 1, null);
    expect(r.quote).toBeNull();
    expect(r.bidAsk).toBe('—');
    expect(r.trade).toEqual({ price: '120', iv: '25.00' });
    expect(r.vsEntry).toBeNull();
  });

  it('気配のある足の始高安終・気配・IV、建値との差（売りは符号を反す）', () => {
    const r = optReadout(BARS, '1h', 0, { ...TARGET, entry: { price: 90, side: 'sell' } });
    expect(r.time).toBe('11/02 09:00');
    expect(r.quote).toEqual({ o: '100', h: '103', l: '97', c: '101' });
    expect(r.bidAsk).toBe('95 / 105');
    expect(r.iv).toBe('20.50');
    expect(r.vsEntry).toBe('−11');
    const buy = optReadout(BARS, '1h', 0, { ...TARGET, entry: { price: 90, side: 'buy' } });
    expect(buy.vsEntry).toBe('+11');
  });

  it('読み取りの足: カーソルが表示範囲の内ならその足、無ければ最新', () => {
    expect(optReadoutIndex(6, null, [-0.5, 8])).toBe(5);
    expect(optReadoutIndex(6, 2, [-0.5, 8])).toBe(2);
    expect(optReadoutIndex(6, 2, [3, 8])).toBe(5);
    expect(optReadoutIndex(0, null, [-0.5, 0.5])).toBeNull();
    expect(optReadout([], '1h', null, null).time).toBe('—');
  });
});

describe('銘柄・ボタンの名前', () => {
  it('見出し・キー・ボタンの名前', () => {
    expect(optTitle(TARGET)).toBe('11月限 30,000 P');
    expect(optKey(TARGET, '1d')).toBe('2026-11-12|30000|put|1d');
    expect(optOpenLabel('2026-11', 30000, 'call')).toBe(
      '2026-11 限 30,000 call の値段と IV の推移を開く',
    );
    expect(OPT_TFS.map((t) => t.value)).toEqual(['1h', '1d']);
  });

  it('足の詳細: ラージの OP の足だけ（先物・取引最終日が求められない足は null）、建値を運ぶ', () => {
    const leg = {
      kind: 'option' as const,
      product: 'op_large',
      month: '2026-11',
      optionType: 'P' as const,
      strike: 30000,
      side: 'sell' as const,
      entry: 85,
    };
    const ltdOf = (m: string) => optLtdOf(m, [{ id: '2026-11', lastTradingDay: '2026-11-12' }], []);
    expect(optTargetOfLeg(leg, ltdOf)).toEqual({
      ...TARGET,
      entry: { price: 85, side: 'sell' },
    });
    expect(optTargetOfLeg({ ...leg, kind: 'future', optionType: null, strike: null }, ltdOf)).toBe(
      null,
    );
    expect(optTargetOfLeg({ ...leg, product: 'fut_mini' }, ltdOf)).toBeNull();
    expect(optTargetOfLeg({ ...leg, month: 'x' }, ltdOf)).toBeNull();
    // 板に無い限月はカレンダーから（SQ = 第 2 金曜の前営業日）
    expect(optLtdOf('2027-01', [], [])).toBe('2027-01-07');
  });
});

describe('開く所（ShellState.opt。reducer）', () => {
  const at = (s: Partial<ShellState>): ShellState => ({ ...INITIAL_SHELL, ...s });

  it('スマホ: 板の K から開く → 銘柄が状態に入り、スマイルのパネル（市場の推移の領域）が銘柄のチャート', () => {
    const s0 = at({ panel: 'board', sheet: 'full' });
    const s1 = shellReduce(s0, { type: 'opt', target: TARGET, tier: 'phone' });
    expect(s1.opt).toEqual(TARGET);
    expect(s1.panel).toBe('smile');
    expect(smileView(s1, 'phone')).toBe('opt');
    expect(optVisible(s1, 'phone')).toBe(true);
    expect(ivVisible(s1, 'phone')).toBe(false); // IV 推移は読まない
    expect(marketAttr(s1)).toBe('opt');
    // 閉じる → 開く前の見え方
    expect(shellReduce(s1, { type: 'optClose' })).toEqual(s0);
  });

  it('隠したシートから開くと peek、閉じると hidden に戻る', () => {
    const s0 = at({ panel: 'positions', sheet: 'hidden' });
    const s1 = shellReduce(s0, { type: 'opt', target: TARGET, tier: 'phone' });
    expect(s1.sheet).toBe('peek');
    expect(shellReduce(s1, { type: 'optClose' })).toEqual(s0);
  });

  it('PC: 左の列が AI なら市場に戻して開き、閉じると AI に戻す。板のまま開いたら data-market は opt', () => {
    const s0 = at({ left: 'ai' });
    const s1 = shellReduce(s0, { type: 'opt', target: TARGET, tier: 'pc' });
    expect(s1.left).toBe('market');
    expect(smileView(s1, 'pc')).toBe('opt');
    expect(optVisible(s1, 'pc')).toBe(true);
    expect(shellReduce(s1, { type: 'optClose' })).toEqual(s0);
    const b1 = shellReduce(INITIAL_SHELL, { type: 'opt', target: TARGET, tier: 'pc' });
    expect(marketAttr(b1)).toBe('opt');
    expect(shellReduce(b1, { type: 'optClose' })).toEqual(INITIAL_SHELL);
  });

  it('開いたまま別の銘柄を開くと銘柄だけ替わり、控えは最初のまま', () => {
    const s0 = at({ panel: 'board' });
    const s1 = shellReduce(s0, { type: 'opt', target: TARGET, tier: 'phone' });
    const other = { ...TARGET, type: 'call' as const };
    const s2 = shellReduce(s1, { type: 'opt', target: other, tier: 'phone' });
    expect(s2.opt).toEqual(other);
    expect(shellReduce(s2, { type: 'optClose' })).toEqual(s0);
  });

  it('市場の Seg・ドック・AI の列・板から追加で推移を外す（同じ見え方を押しても）。つまみでは外さない', () => {
    const s1 = shellReduce(INITIAL_SHELL, { type: 'opt', target: TARGET, tier: 'pc' });
    const m = shellReduce(s1, { type: 'market', market: 'board' });
    expect(m.opt).toBeUndefined();
    expect(m.optPrev).toBeUndefined();
    expect(marketAttr(m)).toBe('board');
    const p1 = shellReduce(at({ panel: 'board' }), { type: 'opt', target: TARGET, tier: 'phone' });
    expect(
      shellReduce(p1, { type: 'dock', panel: 'positions', tier: 'phone' }).opt,
    ).toBeUndefined();
    expect(shellReduce(p1, { type: 'left' }).opt).toBeUndefined();
    expect(shellReduce(p1, { type: 'open', panel: 'smile', tier: 'phone' }).opt).toEqual(TARGET);
    expect(shellReduce(p1, { type: 'open', panel: 'board', tier: 'phone' }).opt).toBeUndefined();
    expect(shellReduce(p1, { type: 'grab', dy: 3 }).opt).toEqual(TARGET);
    expect(shellReduce(INITIAL_SHELL, { type: 'optClose' })).toBe(INITIAL_SHELL);
  });
});

import { describe, expect, it } from 'vitest';
import type { IvBar } from '../../data';
import {
  barsForTf,
  IV_INITIAL_BARS,
  IV_MODES,
  IV_RIGHT_OFFSET,
  IV_TF_SECONDS,
  IV_TFS,
  isIvTradingDay,
  ivChartModel,
  ivFullDomain,
  ivIndexAt,
  ivKeepOf,
  ivReadout,
  ivSource,
  jstDayIndex,
  lineSegments,
  mergeBars,
  resampleBars,
  resolveIvViewport,
  sessionMinutesBetween,
} from '../../ui/view/ivHistory';
import { barsAt, everyStep, jst } from '../support/synthIv';

/**
 * #79 段 B: IV 推移の表示モデル（ui/view/ivHistory.ts）。値は架空（20% 前後）、カレンダーは合成:
 * 2026-11-03（火）= 取引の無い平日（is_trading_day = false）、2026-11-23（月）= 祝日取引の実施日（取引日 = 集合に入らない）。
 */
const NTD = new Set(['2026-11-03']);
const M = 60;
const H = 3600;

const times = (list: string[]) => list.map(jst);
const segOf = (list: string[], tf: Parameters<typeof lineSegments>[1]) =>
  lineSegments(barsAt(times(list)), tf, NTD);

describe('足・形の一覧と足の共有', () => {
  it('足は 1分 5分 15分 1時間 日足（aria-label に全文）、形はローソク / 線', () => {
    expect(IV_TFS.map((t) => [t.value, t.text, t.label])).toEqual([
      ['1m', '1分', '1 分足'],
      ['5m', '5分', '5 分足'],
      ['15m', '15分', '15 分足'],
      ['1h', '1時間', '1 時間足'],
      ['1d', '日足', '日足'],
    ]);
    expect(IV_MODES.map((m) => m.value)).toEqual(['candle', 'line']);
    expect(['1m', '5m', '15m', '1h', '1d'].map((t) => ivSource(t as never))).toEqual([
      '1m',
      '1m',
      '1m',
      '1h',
      '1d',
    ]);
  });
});

describe('取引日と立会の時間', () => {
  it('土日と取引の無い平日は取引日でない（祝日取引の日は取引日）', () => {
    const day = (d: string) => jstDayIndex(jst(`${d}T12:00`));
    expect(isIvTradingDay(day('2026-11-02'), NTD)).toBe(true);
    expect(isIvTradingDay(day('2026-11-03'), NTD)).toBe(false);
    expect(isIvTradingDay(day('2026-11-07'), NTD)).toBe(false);
    expect(isIvTradingDay(day('2026-11-08'), NTD)).toBe(false);
    expect(isIvTradingDay(day('2026-11-23'), NTD)).toBe(true);
  });

  it('立会の時間（分）: 日中 08:45〜15:45・夜間 17:00〜翌 06:00 だけを数える', () => {
    const m = (a: string, b: string) => sessionMinutesBetween(jst(a), jst(b), NTD);
    expect(m('2026-11-02T10:00', '2026-11-02T10:30')).toBe(30);
    expect(m('2026-11-02T15:30', '2026-11-02T17:10')).toBe(25);
    expect(m('2026-11-02T06:00', '2026-11-02T08:45')).toBe(0);
    // 金曜の夜間の後（土 06:00）〜月曜の日中の前
    expect(m('2026-11-07T06:00', '2026-11-09T08:45')).toBe(0);
    // 月曜の夜間の後（火 06:00）〜水曜の日中の前（火曜は取引の無い平日 = 日中・夜間なし）
    expect(m('2026-11-03T06:00', '2026-11-04T08:45')).toBe(0);
    // 取引日の日中を丸ごと = 7 時間
    expect(m('2026-11-02T06:00', '2026-11-02T17:00')).toBe(420);
    expect(m('2026-11-02T10:00', '2026-11-02T10:00')).toBe(0);
  });
});

describe('AC8: 欠けで線を切る（lineSegments）', () => {
  it('(a) 立会中に 30 分以上空いたら分ける（1 分足。29 分は分けない）', () => {
    const base = everyStep(jst('2026-11-02T10:00'), M, 10);
    const at = (t: string) => lineSegments(barsAt([...base, jst(t)]), '1m', NTD);
    // 10:09 の次が 10:40 → [10:10, 10:40) = 30 分
    expect(at('2026-11-02T10:40')).toEqual([
      [0, 9],
      [10, 10],
    ]);
    expect(at('2026-11-02T10:39')).toEqual([[0, 10]]);
  });

  it('(b) iv30 が NULL の足（返らない）の区間: 1 分足の深夜 02:00〜02:59、1 時間足の 02 時の足が無い', () => {
    expect(segOf(['2026-11-03T01:58', '2026-11-03T01:59', '2026-11-03T03:00'], '1m')).toEqual([
      [0, 1],
      [2, 2],
    ]);
    expect(segOf(['2026-11-03T00:00', '2026-11-03T01:00', '2026-11-03T03:00'], '1h')).toEqual([
      [0, 1],
      [2, 2],
    ]);
    // 1 時間足は 60 分未満の空きでは分けない（08 時の足が無くても 08:45〜09:00 の 15 分）
    expect(segOf(['2026-11-02T05:00', '2026-11-02T09:00'], '1h')).toEqual([[0, 1]]);
    // 祝日取引の日（取引日）の日中が丸ごと無ければ分ける
    expect(segOf(['2026-11-23T05:00', '2026-11-23T17:00'], '1h')).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('(c) 立会の切れ目（15:45〜17:00・06:00〜08:45）・土日・取引の無い平日をまたぐ所は分けない', () => {
    expect(segOf(['2026-11-02T15:44', '2026-11-02T17:00'], '1m')).toEqual([[0, 1]]);
    expect(segOf(['2026-11-03T05:59', '2026-11-04T08:45'], '1m')).toEqual([[0, 1]]);
    // 金曜の夜間の最後（土 05:59）→ 月曜の日中の最初
    expect(segOf(['2026-11-07T05:59', '2026-11-09T08:45'], '1m')).toEqual([[0, 1]]);
    // 1 時間足: 15 時の足 → 17 時の足、05 時の足 → 08 時の足
    expect(segOf(['2026-11-02T15:00', '2026-11-02T17:00'], '1h')).toEqual([[0, 1]]);
    expect(segOf(['2026-11-03T05:00', '2026-11-04T08:00'], '1h')).toEqual([[0, 1]]);
    // 5 分足・15 分足は max(足, 30 分) = 30 分
    expect(segOf(['2026-11-02T10:00', '2026-11-02T10:30'], '5m')).toEqual([[0, 1]]);
    expect(segOf(['2026-11-02T10:00', '2026-11-02T10:35'], '5m')).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(segOf(['2026-11-02T10:00', '2026-11-02T10:45'], '15m')).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('日足: 間に取引日が 1 日でもあれば分ける（土日・取引の無い平日だけなら分けない）', () => {
    const d = (list: string[]) => list.map((x) => `${x}T00:00`);
    expect(segOf(d(['2026-11-06', '2026-11-09']), '1d')).toEqual([[0, 1]]);
    expect(segOf(d(['2026-11-02', '2026-11-04']), '1d')).toEqual([[0, 1]]);
    expect(segOf(d(['2026-11-02', '2026-11-05']), '1d')).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('足が 0 本なら区間なし、1 本なら 1 区間', () => {
    expect(lineSegments([], '1h', NTD)).toEqual([]);
    expect(segOf(['2026-11-02T10:00'], '1h')).toEqual([[0, 0]]);
  });
});

describe('束ね直し・つなぎ', () => {
  it('1 分足 → 5 分足: open / close = 最初 / 最後、high / low = 最大 / 最小、UNIX 秒で切る', () => {
    const t0 = jst('2026-11-02T10:00');
    const src: IvBar[] = [
      { t: t0, o: 20, h: 21, l: 19.5, c: 20.5 },
      { t: t0 + 60, o: 20.5, h: 22, l: 20, c: 21 },
      { t: t0 + 240, o: 21, h: 21.2, l: 18, c: 19 },
      { t: t0 + 300, o: 19, h: 19.5, l: 18.5, c: 19.2 },
    ];
    expect(resampleBars(src, 300)).toEqual([
      { t: t0, o: 20, h: 22, l: 18, c: 19 },
      { t: t0 + 300, o: 19, h: 19.5, l: 18.5, c: 19.2 },
    ]);
    expect(barsForTf(src, '15m')).toEqual([{ t: t0, o: 20, h: 22, l: 18, c: 19.2 }]);
    expect(barsForTf(src, '1m')).toBe(src);
    // 元を書き換えない
    expect(src[0]).toEqual({ t: t0, o: 20, h: 21, l: 19.5, c: 20.5 });
  });

  it('時刻をキーにつなぐ（同じ時刻は新しい方）', () => {
    const [a, b, c] = barsAt(everyStep(jst('2026-11-02T10:00'), H, 3), 3) as [IvBar, IvBar, IvBar];
    const b2 = { ...b, c: 30 };
    expect(mergeBars([a, b], [b2, c])).toEqual([a, b2, c]);
    expect(mergeBars([b, c], [a])).toEqual([a, b, c]);
    expect(mergeBars([], [a])).toEqual([a]);
  });
});

describe('表示範囲', () => {
  const bars = barsAt(everyStep(jst('2026-10-01T09:00'), H, 200));

  it('初期表示 = 右端から足ごとの本数 + 右に 3 本の余白。全域は [−0.5, n − 0.5 + 3]', () => {
    expect(ivFullDomain(200)).toEqual([-0.5, 199.5 + IV_RIGHT_OFFSET]);
    expect(resolveIvViewport(bars, '1h', null, null)).toEqual([
      200 - IV_INITIAL_BARS['1h'] - 0.5,
      199.5 + IV_RIGHT_OFFSET,
    ]);
    // 本数が足りなければ全域
    expect(resolveIvViewport(bars.slice(0, 50), '1h', null, null)).toEqual(ivFullDomain(50));
  });

  it('明示の範囲は全域に収める（最小 10 本）', () => {
    expect(resolveIvViewport(bars, '1h', [-50, 20], null)).toEqual([-0.5, 69.5]);
    expect(resolveIvViewport(bars, '1h', [100, 102], null)).toEqual([96, 106]);
  });

  it('足を替えても見ていた時間の範囲を保つ（控えの時刻 → 新しい足の index）', () => {
    const v: [number, number] = [100.5, 130.5];
    const keep = ivKeepOf(bars, v);
    expect(keep).toEqual({
      from: (bars[101] as IvBar).t,
      to: (bars[130] as IvBar).t,
      right: false,
    });
    // 1 時間足 → 1 分足（同じ時間の 1 分足）
    const minute = barsAt(everyStep(jst('2026-10-05T00:00'), M, 60 * 24 * 3));
    const r = resolveIvViewport(minute, '1m', null, keep);
    const from = minute[Math.ceil(r[0])] as IvBar;
    const to = minute[Math.floor(r[1])] as IvBar;
    expect(from.t).toBe(keep?.from);
    expect(to.t).toBe(keep?.to);
    // 右端の足が見えていたら、替えた先でも右端（右の余白込み）
    const right = ivKeepOf(bars, [150, 202]);
    expect(right?.right).toBe(true);
    const rv = resolveIvViewport(minute, '1m', null, right);
    expect(rv[1]).toBe(ivFullDomain(minute.length)[1]);
    expect((minute[Math.ceil(rv[0])] as IvBar).t).toBe(right?.from);
    // 読んだ範囲と重ならなければ初期表示
    const later = barsAt(everyStep(jst('2027-01-04T09:00'), H, 200));
    expect(resolveIvViewport(later, '1h', null, keep)).toEqual(
      resolveIvViewport(later, '1h', null, null),
    );
  });

  it('画素 → 足の index（範囲の外は端）', () => {
    expect(ivIndexAt(40, [-0.5, 9.5], [40, 140], 10)).toBe(0);
    expect(ivIndexAt(95, [-0.5, 9.5], [40, 140], 10)).toBe(5);
    expect(ivIndexAt(400, [-0.5, 9.5], [40, 140], 10)).toBe(9);
    expect(ivIndexAt(50, [-0.5, 9.5], [40, 140], 0)).toBeNull();
  });
});

describe('読み取りの 1 行', () => {
  const bars: IvBar[] = [
    { t: jst('2026-11-02T10:00'), o: 20, h: 21.256, l: 19.5, c: 20.5 },
    { t: jst('2026-11-02T11:00'), o: 20.5, h: 22, l: 20, c: 21 },
  ];
  it('カーソルが無ければ最新の足（右端まで読んでいれば確定前）、時刻は JST・値は小数 2 桁', () => {
    expect(ivReadout(bars, '1h', null, true)).toEqual({
      time: '11/02 11:00',
      o: '20.50',
      h: '22.00',
      l: '20.00',
      c: '21.00',
      progress: true,
    });
    expect(ivReadout(bars, '1h', 0, true)).toMatchObject({ time: '11/02 10:00', h: '21.26' });
    expect(ivReadout(bars, '1h', null, false).progress).toBe(false);
    expect(
      ivReadout([{ ...(bars[0] as IvBar), t: jst('2026-11-02T00:00') }], '1d', null, true).time,
    ).toBe('2026/11/02');
    expect(ivReadout([], '1h', null, true)).toEqual({
      time: '—',
      o: '—',
      h: '—',
      l: '—',
      c: '—',
      progress: false,
    });
  });
});

describe('ivChartModel（描画の座標）', () => {
  const bars = barsAt(everyStep(jst('2026-11-02T09:00'), H, 300), 7);
  const segments = lineSegments(bars, '1h', NTD);
  const base = {
    bars,
    tf: '1h' as const,
    mode: 'candle' as const,
    viewport: resolveIvViewport(bars, '1h', null, null),
    segments,
    width: 600,
    height: 300,
    cursor: null,
    rightLoaded: true,
  };

  it('AC12: 右端（最新）まで読んであれば最後の足だけ .progress（ローソク）、読んでいなければ無し', () => {
    const m = ivChartModel(base);
    const prog = m.candles.filter((c) => c.cls.includes('progress'));
    expect(prog).toHaveLength(1);
    expect(prog[0]?.t).toBe(bars.at(-1)?.t);
    expect(m.candles.at(-1)?.cls).toMatch(/^iv-bar (up|down) progress$/);
    expect(
      ivChartModel({ ...base, rightLoaded: false }).candles.some((c) => c.cls.includes('progress')),
    ).toBe(false);
  });

  it('AC12: 線のモードは最後の区間（最後の 2 本の間）を progress、確定した線はその前で終わる', () => {
    const m = ivChartModel({ ...base, mode: 'line' });
    expect(m.candles).toEqual([]);
    expect(m.progress).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    const lastX = m.progress.split('L')[1]?.split(' ')[0];
    expect(m.line.endsWith(`L${m.progress.slice(1).split('L')[0]}`)).toBe(true);
    expect(m.line).not.toContain(`L${lastX} `);
    expect(ivChartModel({ ...base, mode: 'line', rightLoaded: false }).progress).toBe('');
  });

  it('見えている足だけを描く（ローソクの数 = 表示範囲の足の数）、実体は高さ 1px 以上、ひげは高値 ≤ 安値の y', () => {
    const m = ivChartModel(base);
    expect(m.candles).toHaveLength(IV_INITIAL_BARS['1h']);
    for (const c of m.candles) {
      expect(c.bodyH).toBeGreaterThanOrEqual(1);
      expect(c.yHigh).toBeLessThanOrEqual(c.bodyY + 0.11);
      expect(c.yLow).toBeGreaterThanOrEqual(c.bodyY + c.bodyH - 0.11);
      expect(c.x).toBeGreaterThanOrEqual(m.range[0]);
      expect(c.x).toBeLessThanOrEqual(m.range[1]);
    }
    // 縦軸は見えている足の安値〜高値を含む
    const vis = bars.slice(-IV_INITIAL_BARS['1h']);
    expect(m.yDomain[0]).toBeLessThan(Math.min(...vis.map((b) => b.l)));
    expect(m.yDomain[1]).toBeGreaterThan(Math.max(...vis.map((b) => b.h)));
  });

  it('欠けで分けた区間は別の線（M が区間の数）、1 本だけの区間は点', () => {
    const t = (s: string) => jst(s);
    const b = barsAt([
      t('2026-11-02T10:00'),
      t('2026-11-02T11:00'),
      t('2026-11-02T13:00'),
      t('2026-11-02T14:00'),
      t('2026-11-02T15:00'),
    ]);
    const seg = lineSegments(b, '1h', NTD);
    expect(seg).toEqual([
      [0, 1],
      [2, 4],
    ]);
    const m = ivChartModel({
      ...base,
      bars: b,
      segments: seg,
      mode: 'line',
      viewport: resolveIvViewport(b, '1h', null, null),
      rightLoaded: false,
    });
    expect(m.line.match(/M/g)).toHaveLength(2);
    expect(m.dots).toBe('');
    const single = lineSegments(b.slice(0, 3), '1h', NTD);
    const m2 = ivChartModel({
      ...base,
      bars: b.slice(0, 3),
      segments: single,
      mode: 'line',
      viewport: resolveIvViewport(b.slice(0, 3), '1h', null, null),
      rightLoaded: false,
    });
    expect(m2.dots).toMatch(/^M[\d.]+ [\d.]+a2 2/);
  });

  it('横軸の目盛りは JST・重ならない（日付が変わる所は 月/日）、縦軸の目盛りは描画域の中', () => {
    const m = ivChartModel(base);
    expect(m.xTicks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < m.xTicks.length; i++) {
      expect((m.xTicks[i]?.x ?? 0) - (m.xTicks[i - 1]?.x ?? 0)).toBeGreaterThan(20);
    }
    expect(m.xTicks.every((t) => /^\d{1,2}\/\d{1,2}$|^\d{2}:\d{2}$/.test(t.label))).toBe(true);
    expect(m.yTicks.length).toBeGreaterThanOrEqual(2);
    expect(m.yTicks.every((t) => t.y >= 0 && t.y <= 300)).toBe(true);
    // 日足は月の区切り（1 月は年）
    const days = barsAt(everyStep(jst('2025-11-03T00:00'), 86400, 400));
    const md = ivChartModel({
      ...base,
      bars: days,
      tf: '1d',
      segments: lineSegments(days, '1d', NTD),
      viewport: resolveIvViewport(days, '1d', [-0.5, 402.5], null),
    });
    expect(md.xTicks.some((t) => t.label === '2026')).toBe(true);
    expect(md.xTicks.every((t) => /^\d{4}$|^\d{1,2}月$/.test(t.label))).toBe(true);
  });

  it('カーソルの縦線は足の x、足が 0 本なら空', () => {
    const m = ivChartModel({ ...base, cursor: 299 });
    expect(m.cursorX).toBe(m.candles.at(-1)?.x);
    const e = ivChartModel({ ...base, bars: [], segments: [], viewport: ivFullDomain(0) });
    expect(e.empty).toBe(true);
    expect(e.candles).toEqual([]);
    expect(e.cursorX).toBeNull();
  });

  it('足の長さの表（秒）', () => {
    expect(IV_TF_SECONDS).toEqual({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 });
  });
});

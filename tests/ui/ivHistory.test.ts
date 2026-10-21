import { describe, expect, it } from 'vitest';
import type { IvBar } from '../../data';
import { ZERO_SCENARIO } from '../../model';
import { fmtNum } from '../../ui/view/format';
import {
  barsForTf,
  IV_INITIAL_BARS,
  IV_MARGIN,
  IV_MODES,
  IV_RIGHT_OFFSET,
  IV_TF_SECONDS,
  IV_TFS,
  isIvTradingDay,
  ivChartModel,
  ivCrosshair,
  ivCursorBar,
  ivCursorShown,
  ivFullDomain,
  ivIndexAt,
  ivKeepOf,
  ivKeyStep,
  ivNowPoint,
  ivNowValue,
  ivReadout,
  ivScenarioLevel,
  ivSource,
  ivTradingDayStart,
  jstDayIndex,
  lineSegments,
  mergeBars,
  resampleBars,
  resolveIvViewport,
  sessionMinutesBetween,
} from '../../ui/view/ivHistory';
import { fixture } from '../support/fixtures';
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
  it('足は 1分 5分 15分 1時間 4時間 日足（aria-label に全文）、形はローソク / 線', () => {
    expect(IV_TFS.map((t) => [t.value, t.text, t.label])).toEqual([
      ['1m', '1分', '1 分足'],
      ['5m', '5分', '5 分足'],
      ['15m', '15分', '15 分足'],
      ['1h', '1時間', '1 時間足'],
      ['4h', '4時間', '4 時間足（立会に合わせる）'],
      ['1d', '日足', '日足'],
    ]);
    expect(IV_MODES.map((m) => m.value)).toEqual(['candle', 'line']);
    expect(['1m', '5m', '15m', '1h', '4h', '1d'].map((t) => ivSource(t as never))).toEqual([
      '1m',
      '1m',
      '1m',
      '1h',
      '1h',
      '1d',
    ]);
  });
});

describe('#200: 4 時間足（1 時間足を立会に合わせて束ねる）', () => {
  // 2026-11-04（水）の日中 8 本・夜間 13 本の 1 時間足
  const day = [8, 9, 10, 11, 12, 13, 14, 15].map(
    (h) => `2026-11-04T${String(h).padStart(2, '0')}:00`,
  );
  const night = [
    ...[17, 18, 19, 20, 21, 22, 23].map((h) => `2026-11-04T${h}:00`),
    ...[0, 1, 2, 3, 4, 5].map((h) => `2026-11-05T0${h}:00`),
  ];
  it('1 取引日 = 08・12・17・21・01 時の 5 本（追加の読み込みなし = 1h の読み込みを使う）', () => {
    const out = barsForTf(barsAt(times([...day, ...night])), '4h');
    expect(out.map((b) => b.t)).toEqual(
      times([
        '2026-11-04T08:00',
        '2026-11-04T12:00',
        '2026-11-04T17:00',
        '2026-11-04T21:00',
        '2026-11-05T01:00',
      ]),
    );
    expect(IV_TF_SECONDS['4h']).toBe(4 * H);
    expect(IV_INITIAL_BARS['4h']).toBe(120);
  });
  it('欠け: 日中の後半の足が無い・週末は切らない、夜間の始まりの足が無ければ切る', () => {
    const t4 = (list: string[]) => barsForTf(barsAt(times(list)), '4h');
    // 立会がつながっている（翌日の 08:00 へ）
    expect(lineSegments(t4([...day, ...night, '2026-11-05T08:00']), '4h', NTD)).toEqual([[0, 5]]);
    // 12:00〜15:45 の足が無い（08:00 の次が 17:00）→ 3 時間 45 分 ≥ 2 時間で切る
    expect(lineSegments(t4(['2026-11-04T08:00', '2026-11-04T17:00']), '4h', NTD)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // 金曜の夜間の最後（01:00）→ 月曜の 08:00 は切らない
    expect(lineSegments(t4(['2026-11-07T01:00', '2026-11-09T08:00']), '4h', NTD)).toEqual([[0, 1]]);
  });
  it('「今」の印は同じ 4 時間足なら最後の足、次の区切りなら右', () => {
    const bars = barsForTf(barsAt(times(day)), '4h');
    const at = (s: string) =>
      ivNowPoint({ t: jst(s), iv: 20, method: 'interp' }, bars, '4h', null, NTD);
    expect(at('2026-11-04T15:30')?.index).toBe(1);
    expect(at('2026-11-04T17:10')?.index).toBe(2);
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

  it('足が 0 本なら空（ローソクなし）', () => {
    const e = ivChartModel({ ...base, bars: [], segments: [], viewport: ivFullDomain(0) });
    expect(e.empty).toBe(true);
    expect(e.candles).toEqual([]);
  });

  it('足の長さの表（秒）', () => {
    expect(IV_TF_SECONDS).toEqual({
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400,
    });
  });
});

// ---- #130: 十字線と軸の札（ivCrosshair）。縦線は足に吸着、横線は指 / マウスの高さ（オーナーの決定 2026-10-18）
describe('#130 AC-1: 十字線と軸の札（ivCrosshair）', () => {
  const bars = barsAt(everyStep(jst('2026-11-02T09:00'), H, 300), 7);
  const days = barsAt(everyStep(jst('2026-11-02T00:00'), 86400, 120), 9);
  const chart = (
    b: IvBar[],
    tf: '1h' | '1d',
    mode: 'candle' | 'line',
    width = 600,
    height = 300,
  ) => {
    const viewport = resolveIvViewport(b, tf, null, null);
    const model = ivChartModel({
      bars: b,
      tf,
      mode,
      viewport,
      segments: lineSegments(b, tf, NTD),
      width,
      height,
      rightLoaded: true,
    });
    return { viewport, model };
  };
  /** 見えている足の index の範囲 */
  const seen = (viewport: readonly [number, number], n: number) =>
    [Math.max(0, Math.ceil(viewport[0])), Math.min(n - 1, Math.floor(viewport[1]))] as const;
  const inside = (t: { x: number; y: number; w: number; h: number }, w: number, h: number) =>
    t.x >= 0 && t.y >= 0 && t.x + t.w <= w + 1e-9 && t.y + t.h <= h + 1e-9 && t.w > 0;
  /** 縦軸の目盛りの写像（ivChartModel と同じ: yDomain → [下端, 上端]） */
  const syOf = (m: ReturnType<typeof chart>['model']) => (v: number) =>
    m.height -
    IV_MARGIN.bottom -
    ((v - m.yDomain[0]) / (m.yDomain[1] - m.yDomain[0])) *
      (m.height - IV_MARGIN.bottom - IV_MARGIN.top);
  /** その逆（画素 → IV） */
  const invOf = (m: ReturnType<typeof chart>['model']) => (y: number) =>
    m.yDomain[0] +
    ((m.height - IV_MARGIN.bottom - y) / (m.height - IV_MARGIN.bottom - IV_MARGIN.top)) *
      (m.yDomain[1] - m.yDomain[0]);

  it('十字線: 縦線はカーソルの足の x（ローソク・線の両方）、横線は入力の y（指 / マウスの高さ。足の値に吸着しない）', () => {
    for (const mode of ['candle', 'line'] as const) {
      const { viewport, model } = chart(bars, '1h', mode);
      const [i0, i1] = seen(viewport, bars.length);
      for (const i of [i0, Math.round((i0 + i1) / 2), i1]) {
        const b = bars[i] as IvBar;
        for (const y of [40.5, 150, 260]) {
          const c = ivCrosshair({ bars, tf: '1h', viewport, cursor: i, y, model });
          expect(c).not.toBeNull();
          if (mode === 'candle') {
            expect(c?.x).toBe(model.candles.find((k) => k.t === b.t)?.x);
          } else {
            // 線の頂点（M / L の後の「x y」）の x
            expect(model.line + model.progress).toContain(`${c?.x} `);
          }
          expect(c?.y).toBe(y);
        }
      }
      // 小数のカーソルは四捨五入した足、同じ y なら横線も同じ
      const r = ivCrosshair({ bars, tf: '1h', viewport, cursor: i1 - 0.4, y: 100, model });
      expect(r).toEqual(ivCrosshair({ bars, tf: '1h', viewport, cursor: i1, y: 100, model }));
    }
  });

  it('横線は描画域の上下の端で止まる。y が無い（キーだけ）ときはカーソルの足の終値の高さ', () => {
    const { viewport, model } = chart(bars, '1h', 'candle');
    const i = bars.length - 1;
    const top = ivCrosshair({ bars, tf: '1h', viewport, cursor: i, y: -50, model });
    const bottom = ivCrosshair({ bars, tf: '1h', viewport, cursor: i, y: 999, model });
    expect(top?.y).toBe(IV_MARGIN.top);
    expect(bottom?.y).toBe(model.height - IV_MARGIN.bottom);
    const k = ivCrosshair({ bars, tf: '1h', viewport, cursor: i, y: null, model });
    expect(k?.y).toBeCloseTo(syOf(model)((bars[i] as IvBar).c), 0);
  });

  it('横軸の札の文字は ivReadout の time（1h・1d）、縦軸の札の文字は横線の高さの IV（目盛りの逆変換・読み取りと同じ小数 2 桁）', () => {
    for (const [b, tf] of [
      [bars, '1h'],
      [days, '1d'],
    ] as const) {
      const { viewport, model } = chart(b, tf, 'candle');
      const [i0, i1] = seen(viewport, b.length);
      for (const i of [i0, i1]) {
        for (const y of [IV_MARGIN.top, 123.4, model.height - IV_MARGIN.bottom]) {
          const c = ivCrosshair({ bars: b, tf, viewport, cursor: i, y, model });
          expect(c?.xTag.text).toBe(ivReadout(b, tf, i, true).time);
          expect(c?.yTag.text).toBe(fmtNum(invOf(model)(y), 2));
        }
      }
      // 端の高さ = 縦軸の範囲の端
      const c = ivCrosshair({ bars: b, tf, viewport, cursor: i1, y: IV_MARGIN.top, model });
      expect(c?.yTag.text).toBe(fmtNum(model.yDomain[1], 2));
    }
    // 桁は読み取りの 始・高・安・終 と同じ小数 2 桁（縦軸の目盛りが整数でも）
    const { viewport, model } = chart(bars, '1h', 'candle');
    const c = ivCrosshair({ bars, tf: '1h', viewport, cursor: 299, y: 77, model });
    expect(c?.yTag.text).toMatch(/^\d+\.\d{2}$/);
    expect((ivReadout(bars, '1h', 299, true).c.split('.')[1] ?? '').length).toBe(2);
    // 足の終値の高さ（キーだけ）なら札 = 読み取りの「終」（画素の丸め 0.1px の分だけずれうる）
    const k = ivCrosshair({ bars, tf: '1h', viewport, cursor: 299, y: null, model });
    expect(Number(k?.yTag.text)).toBeCloseTo(Number(ivReadout(bars, '1h', 299, true).c), 1);
    const d = chart(days, '1d', 'candle');
    const cd = ivCrosshair({
      bars: days,
      tf: '1d',
      viewport: d.viewport,
      cursor: days.length - 1,
      y: 100,
      model: d.model,
    });
    expect(cd?.xTag.text).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
  });

  it('札は svg の内側に収まる（表示範囲の左端の足・右端の足・縦の上端 / 下端）', () => {
    for (const [width, height] of [
      [600, 300],
      [328, 180],
      [60, 50],
    ] as const) {
      for (const [b, tf] of [
        [bars, '1h'],
        [days, '1d'],
      ] as const) {
        const { viewport, model } = chart(b, tf, 'candle', width, height);
        const [i0, i1] = seen(viewport, b.length);
        for (const i of [i0, i1]) {
          for (const y of [-100, 0, IV_MARGIN.top, height / 2, height - IV_MARGIN.bottom, 9999]) {
            const c = ivCrosshair({ bars: b, tf, viewport, cursor: i, y, model });
            expect(c).not.toBeNull();
            if (!c) continue;
            expect(inside(c.xTag, model.width, model.height)).toBe(true);
            expect(inside(c.yTag, model.width, model.height)).toBe(true);
            // 縦軸の札は左の余白（右端 = 描画域の左 − 1。狭いときは左端 0 で止める）
            expect(c.yTag.x + c.yTag.w).toBeLessThanOrEqual(
              Math.max(model.range[0] - 1, c.yTag.w) + 1e-9,
            );
            // 横軸の札は目盛りの行（描画域の下）
            expect(c.xTag.y).toBeGreaterThanOrEqual(model.height - IV_MARGIN.bottom);
          }
        }
      }
    }
  });

  it('カーソルが無い・足 0 本では十字線と札を出さない（null）。カーソルの足が表示範囲の外でも null', () => {
    const { viewport, model } = chart(bars, '1h', 'candle');
    expect(ivCrosshair({ bars, tf: '1h', viewport, cursor: null, y: 100, model })).toBeNull();
    const empty = ivChartModel({
      bars: [],
      tf: '1h',
      mode: 'candle',
      viewport: ivFullDomain(0),
      segments: [],
      width: 600,
      height: 300,
      rightLoaded: true,
    });
    expect(
      ivCrosshair({
        bars: [],
        tf: '1h',
        viewport: ivFullDomain(0),
        cursor: 0,
        y: 100,
        model: empty,
      }),
    ).toBeNull();
    // 初期表示は右端の 120 本: 左の足（index 0）は表示範囲の外
    expect(viewport[0]).toBeGreaterThan(1);
    expect(ivCrosshair({ bars, tf: '1h', viewport, cursor: 0, y: 100, model })).toBeNull();
  });
});

// ---- 段 C: 「今」の 1 点とシナリオの水準（AC11）
describe('AC11: 「今」の 1 点', () => {
  const bars = barsAt(everyStep(jst('2026-11-02T09:00'), H, 10), 8);
  const last = bars.at(-1)?.t as number;
  const now = (t: number, iv = 23.45) => ({ t, iv, method: 'm1' as const });

  it('表の最後の行（last_at）より新しい板のときだけ出る。snapshot_at ≤ last_at なら出ない、last_at が無ければ比べない', () => {
    const lastAt = last + 40 * M;
    expect(ivNowPoint(now(lastAt + 60), bars, '1h', lastAt, NTD)).toEqual({ index: 9, iv: 23.45 });
    expect(ivNowPoint(now(lastAt), bars, '1h', lastAt, NTD)).toBeNull();
    expect(ivNowPoint(now(lastAt - 600), bars, '1h', lastAt, NTD)).toBeNull();
    expect(ivNowPoint(now(lastAt + 60), bars, '1h', null, NTD)).not.toBeNull();
    expect(ivNowPoint(null, bars, '1h', null, NTD)).toBeNull();
    expect(ivNowPoint(now(lastAt + 60), [], '1h', null, NTD)).toBeNull();
  });

  it('今の足の区間が最後の足と同じならその足の index、違えば最後の足の右（n）', () => {
    // 1 時間足: 最後の足 = 18:00〜19:00。18:50 の板は同じ足、19:05 は次の足
    expect(ivNowPoint(now(last + 50 * M), bars, '1h', last + 20 * M, NTD)?.index).toBe(9);
    expect(ivNowPoint(now(last + 65 * M), bars, '1h', last + 20 * M, NTD)?.index).toBe(10);
    // 日足: 17:00 からは次の取引日（金曜の夜間は月曜。11-03 は取引の無い平日）
    const days = barsAt([jst('2026-11-02T00:00')], 9);
    expect(ivNowPoint(now(jst('2026-11-02T14:00')), days, '1d', null, NTD)?.index).toBe(0);
    expect(ivNowPoint(now(jst('2026-11-02T17:30')), days, '1d', null, NTD)?.index).toBe(1);
    expect(ivTradingDayStart(jst('2026-11-02T17:30'), NTD)).toBe(jst('2026-11-04T00:00'));
    expect(ivTradingDayStart(jst('2026-11-06T21:00'), NTD)).toBe(jst('2026-11-09T00:00'));
    expect(ivTradingDayStart(jst('2026-11-07T03:00'), NTD)).toBe(jst('2026-11-09T00:00'));
    expect(ivTradingDayStart(jst('2026-11-05T16:59'), NTD)).toBe(jst('2026-11-05T00:00'));
  });

  it('合成の板（fixtures/synthetic/latest.json）から iv30 が出る（定義は model/constantMaturity.ts。値は架空）', () => {
    const json = fixture('latest');
    const v = ivNowValue(json, new Set());
    expect(v?.t).toBe(Date.parse(json.snapshot_at) / 1000);
    expect(v?.method).toBe('m1');
    expect(v?.iv).toBeGreaterThan(5);
    expect(v?.iv).toBeLessThan(80);
    // 印が無ければ出ない
    const none = structuredClone(json);
    for (const m of none.months) for (const r of m.rows) r.call.is_atm = r.put.is_atm = false;
    expect(ivNowValue(none, new Set())).toBeNull();
  });

  it('描画: 見えている「今」の印は縦軸に入り、座標が出る。表示範囲の外なら縦軸に入れない', () => {
    const many = barsAt(everyStep(jst('2026-11-02T09:00'), H, 300), 7);
    const input = {
      bars: many,
      tf: '1h' as const,
      mode: 'candle' as const,
      viewport: resolveIvViewport(many, '1h', null, null),
      segments: lineSegments(many, '1h', NTD),
      width: 600,
      height: 300,
      rightLoaded: true,
    };
    const hi = Math.max(...many.slice(-130).map((b) => b.h));
    const m = ivChartModel({ ...input, now: { index: 300, iv: hi + 10 } });
    expect(m.yDomain[1]).toBeGreaterThan(hi + 10);
    expect(m.nowPt?.x).toBeGreaterThan(m.candles.at(-1)?.x as number);
    expect(m.nowPt?.y).toBeGreaterThanOrEqual(10);
    const off = ivChartModel({ ...input, viewport: [0, 100], now: { index: 300, iv: hi + 10 } });
    expect(off.nowPt).toBeNull();
    expect(off.yDomain[1]).toBeLessThan(hi + 10);
    expect(ivChartModel(input).nowPt).toBeNull();
  });
});

describe('AC11: シナリオの水準', () => {
  const x0 = 41000;
  it('ΔX = 0・Δσ = +5 → 今 + 5pt、ΔX = −10%・Δσ = +5・β = 1.0 → 今 + 15pt', () => {
    expect(ivScenarioLevel(20, { ...ZERO_SCENARIO, dSigma: 5 }, x0)).toBeCloseTo(25, 9);
    expect(
      ivScenarioLevel(20, { ...ZERO_SCENARIO, dX: -0.1 * x0, dSigma: 5, beta: 1 }, x0),
    ).toBeCloseTo(35, 9);
  });

  it('スキュー Δs は効かない（x_eff = 0）、相対モードは base·(1 + Δσ/100) + Δσ_β、下限 1%', () => {
    expect(ivScenarioLevel(20, { ...ZERO_SCENARIO, dSigma: 5, skew: 3 }, x0)).toBeCloseTo(25, 9);
    expect(
      ivScenarioLevel(20, { ...ZERO_SCENARIO, dSigma: 10, ivShift: 'relative' }, x0),
    ).toBeCloseTo(22, 9);
    expect(
      ivScenarioLevel(
        20,
        { ...ZERO_SCENARIO, dX: 0.05 * x0, dSigma: 10, beta: 2, ivShift: 'relative' },
        x0,
      ),
    ).toBeCloseTo(12, 9);
    expect(ivScenarioLevel(20, { ...ZERO_SCENARIO, dSigma: -40 }, x0)).toBeCloseTo(1, 9);
  });

  it('ΔX = Δσ = 0（今と同じ）・基準が無い・X₀ が正でなければ出さない', () => {
    expect(ivScenarioLevel(20, ZERO_SCENARIO, x0)).toBeNull();
    expect(ivScenarioLevel(20, { ...ZERO_SCENARIO, skew: 2, beta: 3 }, x0)).toBeNull();
    expect(ivScenarioLevel(null, { ...ZERO_SCENARIO, dSigma: 5 }, x0)).toBeNull();
    expect(ivScenarioLevel(20, { ...ZERO_SCENARIO, dSigma: 5 }, Number.NaN)).toBeNull();
  });

  it('描画: 水準の横線の y（縦軸に入る）。Δσ を上げると上（y が小さく）へ動く', () => {
    const bars = barsAt(everyStep(jst('2026-11-02T09:00'), H, 50), 7);
    const input = {
      bars,
      tf: '1h' as const,
      mode: 'line' as const,
      viewport: resolveIvViewport(bars, '1h', null, null),
      segments: lineSegments(bars, '1h', NTD),
      width: 600,
      height: 300,
      rightLoaded: true,
    };
    // 足の範囲（18〜22 前後）の中の水準は縦軸を変えず、Δσ を上げると上へ
    const a = ivChartModel({ ...input, scenario: 19.5 });
    const b = ivChartModel({ ...input, scenario: 20.5 });
    expect(b.yDomain).toEqual(a.yDomain);
    expect(b.scenarioY as number).toBeLessThan(a.scenarioY as number);
    // 足より上の水準は縦軸に入る
    expect(ivChartModel({ ...input, scenario: 30 }).yDomain[1]).toBeGreaterThan(30);
    expect(ivChartModel(input).scenarioY).toBeNull();
  });
});

// ---- #227: 十字線の足が表示範囲の内か（ivCursorBar）。十字線と読み取りを一緒に出し入れする
describe('#227 AC2: 十字線の足が表示範囲の内か（ivCursorBar・ivCursorShown）', () => {
  it('表示範囲の外（左・右）は null、端ちょうどは内。四捨五入して端の足で止める', () => {
    const v: [number, number] = [20, 60];
    expect(ivCursorBar(19, 80, v)).toBeNull();
    expect(ivCursorBar(61, 80, v)).toBeNull();
    expect(ivCursorBar(20, 80, v)).toBe(20);
    expect(ivCursorBar(60, 80, v)).toBe(60);
    expect(ivCursorBar(40.4, 80, v)).toBe(40);
    // 19.6 は 20 の足（内）、60.6 は 61 の足（外）
    expect(ivCursorBar(19.6, 80, v)).toBe(20);
    expect(ivCursorBar(60.6, 80, v)).toBeNull();
    // 足の並びの外のカーソルは端の足（表示範囲が左の余白まであれば 0 の足）
    expect(ivCursorBar(-3, 80, [-5, 30])).toBe(0);
    expect(ivCursorBar(200, 80, [60, 85])).toBe(79);
    expect(ivCursorBar(null, 80, v)).toBeNull();
    expect(ivCursorBar(10, 0, v)).toBeNull();
    expect(ivCursorBar(Number.NaN, 80, v)).toBeNull();
  });
  it('ivCursorShown は内ならカーソルのまま、外なら null', () => {
    expect(ivCursorShown(40.4, 80, [20, 60])).toBe(40.4);
    expect(ivCursorShown(70, 80, [20, 60])).toBeNull();
    expect(ivCursorShown(null, 80, [20, 60])).toBeNull();
  });
  it('ivCrosshair は ivCursorBar が null のとき null（画素の判定と同じ）。読み取りは外ならカーソルなしと同じ', () => {
    const bars = barsAt(everyStep(jst('2026-11-02T09:00'), H, 300), 7);
    const full = resolveIvViewport(bars, '1h', null, null);
    // 一部の足だけが見える表示範囲（左右に外の足がある）
    const viewport: [number, number] = [full[1] - 120.3, full[1] - 40.6];
    const model = ivChartModel({
      bars,
      tf: '1h',
      mode: 'candle',
      viewport,
      segments: lineSegments(bars, '1h', NTD),
      width: 600,
      height: 300,
      rightLoaded: true,
    });
    const n = bars.length;
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const c = ivCrosshair({ bars, tf: '1h', viewport, cursor: i, y: 100, model });
      const inView = ivCursorBar(i, n, viewport) !== null;
      expect(c !== null).toBe(inView);
      if (c) expect(c.x).toBeGreaterThanOrEqual(model.range[0]);
      if (c) expect(c.x).toBeLessThanOrEqual(model.range[1]);
      if (!inView) {
        outside++;
        expect(ivReadout(bars, '1h', ivCursorShown(i, n, viewport), false)).toEqual(
          ivReadout(bars, '1h', null, false),
        );
      }
    }
    expect(outside).toBeGreaterThan(200);
  });
});

describe('#227: , . の始点（ivKeyStep）は価格・段とも表示範囲の中の足', () => {
  it('十字線の足が内ならそこから 1 本、外・無いなら表示範囲の右端の足から', () => {
    const v: [number, number] = [20.5, 60.4];
    expect(ivKeyStep(40, 80, v, 1)).toBe(41);
    expect(ivKeyStep(40, 80, v, -1)).toBe(39);
    // 外の足（70）・カーソルなしは右端の足（60）から
    expect(ivKeyStep(70, 80, v, -1)).toBe(59);
    expect(ivKeyStep(5, 80, v, 1)).toBe(61);
    expect(ivKeyStep(null, 80, v, -1)).toBe(59);
    // 表示範囲が足の並びの右の外まで（初期表示の右の余白）なら最新の足から。端で止める
    expect(ivKeyStep(null, 80, [40, 85], -1)).toBe(78);
    expect(ivKeyStep(null, 80, [40, 85], 1)).toBe(79);
    expect(ivKeyStep(0, 80, [-3, 30], -1)).toBe(0);
    expect(ivKeyStep(null, 0, v, 1)).toBeNull();
  });
});

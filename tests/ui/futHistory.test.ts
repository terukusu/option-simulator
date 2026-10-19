import { describe, expect, it } from 'vitest';
import type { ChainJson, FutBar } from '../../data';
import { linear } from '../../ui/chart/scale';
import {
  FUT_NOTE,
  FUT_ROLL_LABEL_GAP_PX,
  FUT_SERIES,
  fmtYen,
  futContractAt,
  futContractLabel,
  futNowPoint,
  futNowValue,
  futReadout,
  futRollMarks,
} from '../../ui/view/futHistory';
import {
  barsForTf,
  ivChartModel,
  ivCrosshair,
  ivKeepOf,
  lineSegments,
  resolveIvViewport,
} from '../../ui/view/ivHistory';
import {
  INITIAL_IV_LOAD,
  type IvData,
  type IvLoadState,
  ivLoadReduce,
  mergeIvEntry,
} from '../../ui/view/ivLoad';
import { barsAt, everyStep, jst } from '../support/synthIv';

/**
 * #190 AC-6: 先物推移の表示モデル（ui/view/futHistory.ts）と、IV 推移の部品を先物で使うときの規則（限月で線を分ける・
 * 円の書式・IV 推移 ⇄ 先物の切替で足と時間の範囲を保つ）。値は架空（先物 30,000 円前後）。
 */

const NONE: ReadonlySet<string> = new Set();
/** 合成の休業日（SQ の規則の全行。架空） */
const HOLIDAYS: ReadonlySet<string> = new Set(['2026-11-03']);

/** 時刻の列に架空の先物の OHLC と限月を付ける（m は時刻ごとの関数） */
function futBars(times: readonly number[], m: (t: number) => string): FutBar[] {
  return barsAt(times).map((b) => ({
    t: b.t,
    o: b.o * 1500,
    h: b.h * 1500,
    l: b.l * 1500,
    c: b.c * 1500,
    m: m(b.t),
  }));
}

/** 2026-09-10（木。9 月限の取引最終日）16:00〜18:59 の 1 分足。17:00 から 12 月限 */
const ROLL = jst('2026-09-10T17:00');
const minutes = futBars(everyStep(jst('2026-09-10T16:00'), 60, 180), (t) =>
  t < ROLL ? '2026-09' : '2026-12',
);

describe('限月交代（期近のつなぎ足・印）', () => {
  it('限月が変わっても線は切らずに 1 本でつなぐ（値は調整しない = 当時の期近の値のまま）', () => {
    expect(lineSegments(minutes, '1m', NONE)).toEqual([[0, 179]]);
    // 線のモードの path は交代の足の前後を L でつなぐ（M は 1 回だけ）
    const model = ivChartModel({
      bars: minutes,
      tf: '1m',
      mode: 'line',
      viewport: [-0.5, 179.5],
      segments: lineSegments(minutes, '1m', NONE),
      width: 480,
      height: 240,
      rightLoaded: false,
      series: FUT_SERIES,
    });
    expect(model.line.match(/M/g)).toHaveLength(1);
    expect(model.line.match(/L/g)).toHaveLength(179);
    // 交代の前後の終値はそのまま（バックアジャストしない）
    const sy = linear(model.yDomain, [240 - 22, 10]);
    const ys = [...model.line.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    for (const i of [59, 60]) {
      expect(ys[i]).toBeCloseTo(sy(minutes[i]?.c ?? 0), 0);
    }
    // 欠け（立会中 30 分以上の空き）では今までどおり分ける
    const gap = [...minutes.slice(0, 60), ...minutes.slice(120).map((b) => ({ ...b }))];
    expect(lineSegments(gap, '1m', NONE)).toEqual([
      [0, 59],
      [60, 119],
    ]);
  });

  it('5 分・15 分に束ねても限月を運び、交代の足は新しい限月の最初の足（線はつながる）', () => {
    const five = barsForTf(minutes, '5m');
    expect(five).toHaveLength(36);
    expect(five[11]?.m).toBe('2026-09');
    expect(five[12]?.m).toBe('2026-12');
    expect(five[12]?.t).toBe(ROLL);
    expect(lineSegments(five, '5m', NONE)).toEqual([[0, 35]]);
  });

  it('印の x は交代の足の左（index − 0.5）、札は新しい限月。見えている範囲だけ', () => {
    const range: [number, number] = [48, 448];
    const marks = futRollMarks(minutes, [-0.5, 179.5], range);
    expect(marks).toEqual([{ x: Math.round((48 + (60 / 180) * 400) * 10) / 10, label: '12月限' }]);
    expect(futRollMarks(minutes, [80, 170], range)).toEqual([]);
    expect(futRollMarks(minutes.slice(0, 1), [-0.5, 0.5], range)).toEqual([]);
    expect(futContractLabel('2027-03')).toBe('3月限');
  });

  it(`札は前の札から ${FUT_ROLL_LABEL_GAP_PX}px 以上離れているときだけ（混むときは線だけ。線は全部の交代に）`, () => {
    // 日足 2 年分（四半期ごとの交代 8 回）を狭い幅で: 線 8 本、札は間引く
    const months = [
      '2025-03',
      '2025-06',
      '2025-09',
      '2025-12',
      '2026-03',
      '2026-06',
      '2026-09',
      '2026-12',
      '2027-03',
    ];
    const days = futBars(everyStep(jst('2025-01-06T00:00'), 86400, 540), (t) => {
      const k = Math.min(
        Math.floor((t - jst('2025-01-06T00:00')) / (86400 * 60)),
        months.length - 1,
      );
      return months[k] as string;
    });
    const narrow = futRollMarks(days, [-0.5, 539.5], [48, 248]);
    expect(narrow).toHaveLength(8);
    const shown = narrow.filter((m) => m.label !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(8);
    for (let i = 1; i < shown.length; i++) {
      expect((shown[i]?.x ?? 0) - (shown[i - 1]?.x ?? 0)).toBeGreaterThanOrEqual(
        FUT_ROLL_LABEL_GAP_PX,
      );
    }
    // 広い幅なら全部に札
    expect(futRollMarks(days, [-0.5, 539.5], [48, 1448]).every((m) => m.label !== null)).toBe(true);
  });
});

describe('書式・文言', () => {
  it('円の整数（桁区切り）。縦の目盛り・読み取り・縦軸の札が同じ書式', () => {
    expect(fmtYen(38500)).toBe('38,500');
    expect(fmtYen(38499.6)).toBe('38,500');
    expect(fmtYen(null)).toBe('—');
    const model = ivChartModel({
      bars: minutes,
      tf: '1m',
      mode: 'line',
      viewport: [-0.5, 179.5],
      segments: lineSegments(minutes, '1m', NONE),
      width: 480,
      height: 240,
      rightLoaded: false,
      series: FUT_SERIES,
    });
    expect(model.range[0]).toBe(FUT_SERIES.marginLeft);
    expect(model.yTicks.every((t) => /^\d{1,3}(,\d{3})*$/.test(t.label))).toBe(true);
    const cross = ivCrosshair({
      bars: minutes,
      tf: '1m',
      viewport: [-0.5, 179.5],
      cursor: 10,
      y: 100,
      model,
      fmt: FUT_SERIES.fmt,
    });
    expect(cross?.yTag.text).toMatch(/^\d{2},\d{3}$/);
    const ro = futReadout(minutes, '1m', 70, false);
    expect(ro.time).toBe('09/10 17:10');
    expect(ro.c).toBe(fmtYen(minutes[70]?.c));
    expect(ro.contract).toBe('12月限');
    expect(futReadout([], '1m', null, false).contract).toBe('');
  });

  it('ⓘ に「実際の約定の高値・安値より狭い」の注記と限月交代の説明', () => {
    expect(FUT_NOTE).toContain('実際の約定の高値・安値より狭い');
    expect(FUT_NOTE).toContain('15 分遅れ');
    expect(FUT_NOTE).toContain('縦の点線');
    expect(FUT_NOTE).toContain('期近のつなぎ足（調整なし）');
  });
});

describe('「今」の 1 点', () => {
  const board = (snapshot: string, price: number | null) =>
    ({ snapshot_at: snapshot, future: { price } }) as unknown as ChainJson;

  it('板の限月はスナップショットの時刻から求める（取引最終日の 17:00 から次の限月）', () => {
    expect(futContractAt(jst('2026-09-10T16:59'), HOLIDAYS, NONE)).toBe('2026-09');
    expect(futContractAt(jst('2026-09-10T17:00'), HOLIDAYS, NONE)).toBe('2026-12');
    expect(futContractAt(jst('2026-12-28T10:00'), HOLIDAYS, NONE)).toBe('2027-03');
    expect(futNowValue(board('2026-09-10T18:59:30+09:00', null), HOLIDAYS, NONE)).toBeNull();
  });

  it('新しい板かつ同じ限月のときだけ', () => {
    const lastAt = minutes.at(-1)?.t ?? 0;
    const now = futNowValue(board('2026-09-10T19:00:30+09:00', 30123), HOLIDAYS, NONE);
    expect(now?.m).toBe('2026-12');
    expect(futNowPoint(now, minutes, '1m', lastAt, NONE)).toEqual({ index: 180, iv: 30123 });
    // 表の最後の行より古い板
    expect(futNowPoint(now, minutes, '1m', (now?.t ?? 0) + 60, NONE)).toBeNull();
    // 限月が最後の足と違う（交代の前の足までしか読んでいない）
    expect(futNowPoint(now, minutes.slice(0, 60), '1m', lastAt, NONE)).toBeNull();
    expect(futNowPoint(null, minutes, '1m', lastAt, NONE)).toBeNull();
  });
});

describe('IV 推移 ⇄ 先物の切替で足と時間の範囲を保つ', () => {
  const ivHours = barsAt(everyStep(jst('2026-08-17T09:00'), 3600, 400));
  const futHours = futBars(everyStep(jst('2026-08-17T09:00'), 3600, 400), (t) =>
    t < ROLL ? '2026-09' : '2026-12',
  );

  it('IV 推移で見ていた時間の範囲（控え）を先物の足で同じ時刻に置く', () => {
    const viewport: [number, number] = [99.5, 199.5];
    const keep = ivKeepOf(ivHours, viewport);
    expect(keep).toEqual({ from: ivHours[100]?.t, to: ivHours[199]?.t, right: false });
    const v = resolveIvViewport(futHours, '1h', null, keep, 0);
    expect(v).toEqual([99.5, 199.5]);
  });

  it('右端が見えていたなら、相手の最後の足が古くても先物の右端（最新の足と「今」）まで見せる', () => {
    // IV 推移の表は先物より最大 2 時間遅れる: IV の最後の足は先物の最後の 2 本前
    const ivShort = ivHours.slice(0, 398);
    const keep = ivKeepOf(ivShort, [297.5, 400.5]);
    expect(keep?.right).toBe(true);
    const v = resolveIvViewport(futHours, '1h', null, keep, 0);
    expect(v[1]).toBe(futHours.length - 0.5 + 3);
    expect(v[0]).toBe(297.5);
  });

  const fut = (bars: FutBar[], over: Partial<IvData<FutBar>> = {}): IvData<FutBar> => ({
    tf: '1h',
    start: bars[0]?.t ?? 0,
    end: (bars.at(-1)?.t ?? 0) + 3600,
    lastAt: bars.at(-1)?.t ?? null,
    bars,
    ...over,
  });
  const loaded = (s: IvLoadState<FutBar>, data: IvData<FutBar>) => {
    const r = ivLoadReduce(s, { type: 'open' });
    const id = r.request?.id ?? 0;
    return ivLoadReduce(r.state, { type: 'loaded', id, data }).state;
  };

  it('先物を開くとき、控えが読み済みの外ならその時間の 1 回分を読む（中なら読まない）', () => {
    const init = INITIAL_IV_LOAD as IvLoadState<FutBar>;
    // まだ開いていない: 控えが過去 → その時間の 1 回分（jump）
    const at = { from: jst('2026-05-01T09:00'), to: jst('2026-05-20T09:00'), right: false };
    const first = ivLoadReduce(init, { type: 'open', at });
    expect(first.request?.side).toBe('jump');
    expect(first.request?.range?.end).toBe(Date.UTC(2026, 4, 21) / 1000);
    // 右端の 1 回分を読んだ後: 控えが読み済みの中なら読まない、外なら jump、右端なら読まない
    const s = loaded(init, fut(futHours, { end: futHours.at(-1)?.t ?? 0 }));
    const inside = { from: futHours[10]?.t ?? 0, to: futHours[50]?.t ?? 0, right: false };
    expect(ivLoadReduce(s, { type: 'open', at: inside }).request).toBeNull();
    expect(ivLoadReduce(s, { type: 'open', at }).request?.side).toBe('jump');
    expect(ivLoadReduce(s, { type: 'open', at: { ...inside, right: true } }).request).toBeNull();
    // 控えが無い（開き直し）は今までどおり読まない
    expect(ivLoadReduce(s, { type: 'open' }).request).toBeNull();
  });

  it('足を替えて受け取る（setTf）と同じ規則で読む・読み済みの限月は保つ', () => {
    const init = INITIAL_IV_LOAD as IvLoadState<FutBar>;
    const s = loaded(init, fut(futHours));
    const r = ivLoadReduce(s, {
      type: 'setTf',
      tf: '1d',
      at: { from: futHours[0]?.t ?? 0, to: futHours[10]?.t ?? 0, right: false },
    });
    expect(r.state.tf).toBe('1d');
    expect(r.request?.src).toBe('1d');
    const e = mergeIvEntry(undefined, fut(futHours), { src: '1h', side: 'right' });
    expect(e.bars.map((b) => b.m)).toEqual(futHours.map((b) => b.m));
  });
});

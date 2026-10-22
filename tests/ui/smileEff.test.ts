import { describe, expect, it } from 'vitest';
import { buildMarketContext, normalizeChain } from '../../data';
import {
  businessDaysAhead,
  DAY_MS,
  DEFAULT_MARGIN_PARAMS,
  DEFAULT_SETTINGS,
  MARGIN_HORIZON_BUSINESS_DAYS,
  type Scenario,
  sellEfficiency,
  underlyingAt,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { linear } from '../../ui/chart/scale';
import { INITIAL_SHELL, shellReduce } from '../../ui/view/shell';
import { axisValue, SMILE_MARGIN, type SmileAxis, smileModel } from '../../ui/view/smile';
import {
  EFF_NOW_SCENARIO,
  EFF_READ_LINE_PX,
  EFF_TOP_RATIO,
  effAtNow,
  effReadYs,
  effTickLabel,
  effTicksClear,
  type SmileEffBase,
  smileEffNearest,
  smileEffPath,
  smileEffPoints,
  smileEffReadLines,
  smileEffTicks,
  smileEffYDomain,
} from '../../ui/view/smileEff';
import { fixture } from '../support/fixtures';
import { rng } from '../support/synthChain';

/** #163: スマイルに重ねる売りの効率の線（合成の板。架空の値） */
const chain = normalizeChain(fixture('latest'));
const month = chain.months[0];
if (!month) throw new Error('合成の板に限月が無い');
const ctx = buildMarketContext(chain, { atmBasis: 'B' });
const base: SmileEffBase = {
  ctx,
  settings: DEFAULT_SETTINGS,
  params: DEFAULT_MARGIN_PARAMS,
  holidays: CALENDAR.holidays,
};
const AXES: SmileAxis[] = ['k', 'moneyness', 'delta'];

describe('売りの効率の線の点（#163）', () => {
  it.each(AXES)(
    '軸 %s: スマイルの IV がある行ごとに OTM 側の点、横軸の値は axisValue と一致',
    (axis) => {
      const pts = smileEffPoints(month, 'B', axis, base, ZERO_SCENARIO);
      // 点がある = スマイルの IV があり、model の sellEfficiency が決まる（呼値未満などで null でない）行。ちょうどその行ごと
      const h = businessDaysAhead(ctx.evalTime, MARGIN_HORIZON_BUSINESS_DAYS, CALENDAR.holidays);
      const rows = month.strikes.filter(
        (s) =>
          s.smileIv !== null &&
          sellEfficiency(
            {
              expiry: month.id,
              strike: s.k,
              type: s.otmType,
              sigma: s.smileIv,
              x: ctx.x0,
              scenario: ZERO_SCENARIO,
              horizonDays: h,
            },
            ctx,
            DEFAULT_SETTINGS,
            DEFAULT_MARGIN_PARAMS,
          ) !== null,
      );
      expect(pts.length).toBeGreaterThan(10);
      expect(pts.map((p) => p.k)).toEqual(rows.map((s) => s.k));
      for (const p of pts) expect(month.strikes[p.i]?.k).toBe(p.k);
      for (const p of pts) {
        const info = month.strikes.find((s) => s.k === p.k);
        if (!info) throw new Error('板に無い行使価格');
        expect(p.type).toBe(info.otmType);
        expect(p.x).toBe(axisValue(month, 'B', axis, info));
        expect(p.eff).toBeGreaterThan(0);
      }
      // K の昇順
      for (let i = 1; i < pts.length; i++) {
        expect((pts[i] as { k: number }).k).toBeGreaterThan((pts[i - 1] as { k: number }).k);
      }
    },
  );

  it('値は model の sellEfficiency をシナリオの点（X₀ + ΔX・h = 2 営業日）で呼んだもの（% は × 100）', () => {
    const sc: Scenario = { ...ZERO_SCENARIO, days: 3, dX: -1500, dSigma: 6, skew: 1 };
    const pts = smileEffPoints(month, 'B', 'k', base, sc);
    const h = businessDaysAhead(
      ctx.evalTime + 3 * DAY_MS,
      MARGIN_HORIZON_BUSINESS_DAYS,
      CALENDAR.holidays,
    );
    for (const p of pts.slice(0, 40)) {
      const info = month.strikes.find((s) => s.k === p.k);
      const r = sellEfficiency(
        {
          expiry: month.id,
          strike: p.k,
          type: p.type,
          sigma: info?.smileIv as number,
          x: ctx.x0 - 1500,
          scenario: sc,
          horizonDays: h,
        },
        ctx,
        DEFAULT_SETTINGS,
        DEFAULT_MARGIN_PARAMS,
      );
      if (!r) throw new Error('効率が決まらない');
      expect(p.margin).toBe(r.margin);
      expect(p.premium).toBe(r.premium);
      expect(p.eff).toBe(r.efficiency * 100);
    }
  });

  it('Δσ を上げると全部の点でプレミアムが増え、線が上へ動く（最大も上がる）', () => {
    const a = smileEffPoints(month, 'B', 'k', base, ZERO_SCENARIO);
    const b = smileEffPoints(month, 'B', 'k', base, { ...ZERO_SCENARIO, dSigma: 10 });
    // IV が上がると呼値未満だった遠い行使価格も点になる（点は増えるだけ）
    expect(b.length).toBeGreaterThanOrEqual(a.length);
    const byK = new Map(b.map((q) => [q.k, q]));
    for (const p of a) {
      const q = byK.get(p.k);
      if (!q) throw new Error('点が無い');
      expect(q.premium).toBeGreaterThan(p.premium);
    }
    const max = (pts: typeof a) => Math.max(...pts.map((p) => p.eff));
    expect(max(b)).toBeGreaterThan(max(a));
  });

  it('シナリオの d が限月の満期を過ぎると点なし', () => {
    const days = (month.sqTime - ctx.evalTime) / DAY_MS + 1;
    expect(smileEffPoints(month, 'B', 'k', base, { ...ZERO_SCENARIO, days })).toEqual([]);
  });

  it('今か = d・ΔX・Δσ・Δs が全部 0（β・動き方・IV の入れ方は問わない）。今のシナリオはそれらを 0 に', () => {
    expect(effAtNow(ZERO_SCENARIO)).toBe(true);
    expect(effAtNow({ ...ZERO_SCENARIO, beta: 0, ivDynamics: 'sticky_moneyness' })).toBe(true);
    for (const patch of [{ days: 1 }, { dX: -10 }, { dSigma: 0.5 }, { skew: -1 }]) {
      expect(effAtNow({ ...ZERO_SCENARIO, ...patch })).toBe(false);
    }
    const s: Scenario = {
      days: 4,
      dX: 300,
      dSigma: 5,
      skew: 2,
      beta: 0.5,
      ivDynamics: 'sticky_moneyness',
      ivShift: 'relative',
    };
    expect(effAtNow(s)).toBe(false);
    // 今の線: β・動き方・IV の入れ方は d = ΔX = Δσ = Δs = 0 では効かない（同じ点になる）
    const now = smileEffPoints(month, 'B', 'k', base, EFF_NOW_SCENARIO);
    const nowOther = smileEffPoints(month, 'B', 'k', base, {
      ...s,
      days: 0,
      dX: 0,
      dSigma: 0,
      skew: 0,
    });
    expect(nowOther.map((p) => [p.k, p.premium, p.margin])).toEqual(
      now.map((p) => [p.k, p.premium, p.margin]),
    );
  });

  it("性質: 線は常に状態 S で OTM の売りだけ（K < F' は put、それ以外は call。種 11 の 60 ケース）", () => {
    const rand = rng(11);
    for (let n = 0; n < 60; n++) {
      const sc: Scenario = {
        ...ZERO_SCENARIO,
        days: rand() * 10,
        dX: (rand() - 0.5) * 0.4 * ctx.x0,
        dSigma: (rand() - 0.3) * 30,
        skew: (rand() - 0.5) * 4,
      };
      const Fp = underlyingAt(month.F, ctx.x0, ctx.x0 + sc.dX, DEFAULT_SETTINGS.basisMode);
      const pts = smileEffPoints(month, 'B', 'k', base, sc);
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        expect(p.type).toBe(p.k < Fp ? 'put' : 'call');
        // OTM の売り: 受取は本源的価値を含まない（時間価値だけ）
        const intrinsic = p.type === 'put' ? Math.max(p.k - Fp, 0) : Math.max(Fp - p.k, 0);
        expect(intrinsic).toBe(0);
      }
    }
  });

  it('ΔX −1,500 でも、今の F で ITM になった行使価格を put の売りとして山にしない（効率の最大は今と同じくらい）', () => {
    const now = smileEffPoints(month, 'B', 'k', base, ZERO_SCENARIO);
    const down = smileEffPoints(month, 'B', 'k', base, { ...ZERO_SCENARIO, dX: -1500 });
    const max = (pts: typeof now) => Math.max(...pts.map((p) => p.eff));
    expect(max(down)).toBeLessThan(max(now) * 1.2);
  });

  it('呼値未満のプレミアム・1 円未満の証拠金の行は点を作らず、線はそこで切る（隣の行どうしだけを結ぶ）', () => {
    const pts = smileEffPoints(month, 'B', 'k', base, ZERO_SCENARIO);
    for (const p of pts) {
      expect(p.premium).toBeGreaterThanOrEqual(1);
      expect(p.margin).toBeGreaterThanOrEqual(1);
    }
    // ファー OTM の端（スマイルはあるが呼値未満）の行が点になっていない
    const withIv = month.strikes.filter((s) => s.smileIv !== null);
    expect(pts.length).toBeLessThan(withIv.length);
    // 真ん中の行を抜くと、その両側を結ばない（path の M が 1 つ増える）
    const y = smileEffYDomain([pts], model0.domain) as [number, number];
    const whole = smileEffPath(pts, model0.domain, y, 400, 240);
    const mid = Math.floor(pts.length / 2);
    const gap = [...pts.slice(0, mid), ...pts.slice(mid + 1)];
    const cut = smileEffPath(gap, model0.domain, y, 400, 240);
    expect((cut.match(/M/g) ?? []).length).toBe((whole.match(/M/g) ?? []).length + 1);
  });
});

const model0 = smileModel(month, 'B', 'k');

describe('売りの効率の線の描画（#163）', () => {
  const pts = smileEffPoints(month, 'B', 'k', base, { ...ZERO_SCENARIO, dSigma: 5 });
  const now = smileEffPoints(month, 'B', 'k', base, ZERO_SCENARIO);
  const model = smileModel(month, 'B', 'k');

  it('縦軸は 0 〜 表示範囲の中の点（今の線を含む）の最大 × 1.15。点が無ければ null', () => {
    const y = smileEffYDomain([pts, now], model.domain);
    if (!y) throw new Error('縦軸が無い');
    const max = Math.max(...[...pts, ...now].map((p) => p.eff));
    expect(y[0]).toBe(0);
    expect(y[1]).toBeCloseTo(max * EFF_TOP_RATIO, 9);
    // 表示範囲を絞ると、その中の点だけで決まる
    const k0 = (pts[0] as { x: number }).x;
    const narrow: [number, number] = [k0, k0 + 1];
    const y2 = smileEffYDomain([pts, null], narrow);
    expect(y2?.[1]).toBeCloseTo((pts[0] as { eff: number }).eff * EFF_TOP_RATIO, 9);
    expect(smileEffYDomain([[], null], model.domain)).toBeNull();
    expect(smileEffYDomain([pts], [-2, -1])).toBeNull();
  });

  it('目盛りは 0 を除き上端以下、文字は %', () => {
    const t = smileEffTicks([0, 57.5]);
    expect(t.length).toBeGreaterThanOrEqual(2);
    for (const v of t) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(57.5);
    }
    expect(effTickLabel(20)).toBe('20%');
    const ticks = [
      { t: 20, y: 100 },
      { t: 40, y: 50 },
      { t: 60, y: 24 },
    ];
    expect(effTicksClear(ticks, [23, 36, 49]).map((q) => q.t)).toEqual([20]);
    expect(effTicksClear(ticks, []).map((q) => q.t)).toEqual([20, 40, 60]);
    expect(effTickLabel(2.5)).toBe('2.5%');
  });

  it('path は表示範囲の中だけ（座標は描画域の内側）', () => {
    const y = smileEffYDomain([pts], model.domain) as [number, number];
    const [w, h] = [400, 240];
    const d = smileEffPath(pts, model.domain, y, w, h);
    expect(d.startsWith('M')).toBe(true);
    const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      expect(nums[i]).toBeGreaterThanOrEqual(SMILE_MARGIN.left - 0.1);
      expect(nums[i]).toBeLessThanOrEqual(w - SMILE_MARGIN.right + 0.1);
      expect(nums[i + 1]).toBeGreaterThanOrEqual(SMILE_MARGIN.top - 0.1);
      expect(nums[i + 1]).toBeLessThanOrEqual(h - SMILE_MARGIN.bottom + 0.1);
    }
    // 1 点目の座標
    const p0 = pts.find((p) => p.x >= model.domain[0]) as (typeof pts)[number];
    const sx = linear(model.domain, [SMILE_MARGIN.left, w - SMILE_MARGIN.right]);
    expect(nums[0]).toBeCloseTo(sx(p0.x), 0);
    // 表示範囲の外だけなら空
    expect(smileEffPath(pts, [1, 2], y, w, h)).toBe('');
  });

  it('読み取り: 縦線に最も近い点（表示範囲の中）の 2 行。単位・Δ のラージ / ミニ', () => {
    const p = pts[Math.floor(pts.length / 3)] as (typeof pts)[number];
    expect(smileEffNearest(pts, p.x + 1, model.domain)?.k).toBe(p.k);
    expect(smileEffNearest(pts, Number.NaN, model.domain)).toBeNull();
    expect(smileEffNearest(pts, p.x, [-2, -1])).toBeNull();
    const [l1, l2] = smileEffReadLines({
      k: 64000,
      i: 0,
      x: 64000,
      type: 'put',
      premium: 85.25,
      margin: 612345.6,
      eff: 13.92,
      deltaLarge: 0.1234,
      deltaMini: 1.234,
    });
    expect(l1).toBe('売り 64,000 put 85.3 円 · 効率 13.9%');
    expect(l2).toBe('証拠金 612,346 円 · Δ +0.12（ミニ +1.2）');
    const [c1] = smileEffReadLines({
      k: 71000,
      i: 1,
      x: 71000,
      type: 'call',
      premium: 410.2,
      margin: 1e6,
      eff: 41,
      deltaLarge: -0.18,
      deltaMini: -1.8,
    });
    expect(c1).toBe('売り 71,000 call 410 円 · 効率 41.0%');
  });

  it('読み取りの行: 上端なら 1 行目を y0 に下へ、下端なら最後の行を y0 に上へ', () => {
    expect(effReadYs(23, 240, 2)).toEqual([23, 23 + EFF_READ_LINE_PX, 23 + 2 * EFF_READ_LINE_PX]);
    expect(effReadYs(207, 240, 2)).toEqual([
      207 - 2 * EFF_READ_LINE_PX,
      207 - EFF_READ_LINE_PX,
      207,
    ]);
    expect(effReadYs(23, 240, 0)).toEqual([23]);
  });
});

describe('効率の線の表示の切替（#163。ui/view/shell.ts。保存しない）', () => {
  it('既定はオフ、smileEff で切り替え、同じ値なら同じ参照、パネルの切替で保つ', () => {
    expect(INITIAL_SHELL.smileEff).toBeUndefined();
    expect(shellReduce(INITIAL_SHELL, { type: 'smileEff', on: false })).toBe(INITIAL_SHELL);
    const s1 = shellReduce(INITIAL_SHELL, { type: 'smileEff', on: true });
    expect(s1).toEqual({ ...INITIAL_SHELL, smileEff: true });
    expect(shellReduce(s1, { type: 'smileEff', on: true })).toBe(s1);
    expect(shellReduce(s1, { type: 'smileEff', on: false }).smileEff).toBe(false);
    expect(shellReduce(s1, { type: 'market', market: 'smile' }).smileEff).toBe(true);
  });
});

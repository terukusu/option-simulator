/**
 * #387 JSCC のシナリオの当て直し（model/jsccRefit.ts）。値は架空（合成の市場・合成の r・g）。
 */
import { describe, expect, it } from 'vitest';
import { black76Price } from '../../model/black76';
import {
  type JsccInstrument,
  jsccEsOfSorted,
  jsccEsSigned,
  jsccTailCount,
} from '../../model/jsccMargin';
import {
  JSCC_REFIT_EWMA_LAMBDA,
  JSCC_REFIT_MAX_MEDIAN_REL,
  type JsccFactors,
  jsccFactorRowOf,
  jsccRefitEwmaScale,
  jsccRefitPlan,
  jsccRefitQuality,
  jsccRefitRoomEvaluator,
  jsccRefitVector,
  marginAtJsccRefit,
  nodeWeight,
} from '../../model/jsccRefit';
import {
  DEFAULT_MARGIN_PARAMS,
  drainSteps,
  type MarginParams,
  type MarginState,
  marginCallLevelsSteps,
  marginNowJscc,
  marginRoom,
} from '../../model/margin';
import {
  DEFAULT_SETTINGS,
  type Leg,
  legSigma,
  legValue,
  type MarketContext,
  type PreparedLeg,
  premiumSummary,
  preparePosition,
} from '../../model/position';
import { ZERO_SCENARIO } from '../../model/scenario';
import { businessDaysAhead } from '../../model/time';
import { FUT, M1, M2, makeMarket, quoteOf, R } from '../support/market';
import {
  jsccData,
  REFIT_NODES,
  realisticSet,
  rng,
  smallSet,
  synthFactors,
} from '../support/synthJscc';

const P: MarginParams = { ...DEFAULT_MARGIN_PARAMS, factor: 1, ignoreLongOptions: false };
const S = DEFAULT_SETTINGS;

function market(withSmile: boolean) {
  const { ctx, rows } = makeMarket({ withSmile });
  const ctxJ: MarketContext = {
    ...ctx,
    options: {
      '2026-11': ctx.options[M1.id],
      '2026-12': ctx.options[M2.id],
    } as MarketContext['options'],
    futures: { '2026-12': ctx.futures[FUT.id] } as MarketContext['futures'],
  };
  const op = (
    month: typeof M1 | typeof M2,
    type: 'call' | 'put',
    k: number,
    side: 'buy' | 'sell',
    qty = 1,
  ): Leg => {
    const q = quoteOf(rows[month.id] ?? [], k, type);
    return {
      kind: 'option',
      product: 'op_large',
      type,
      expiry: month === M1 ? '2026-11' : '2026-12',
      strike: k,
      side,
      qty,
      entry: side === 'buy' ? q.ask : q.bid,
      mid: q.mid,
    };
  };
  const fut = (
    side: 'buy' | 'sell',
    qty: number,
    product: 'fut_large' | 'fut_mini' | 'fut_micro',
  ): Leg => ({ kind: 'future', product, contract: '2026-12', side, qty, entry: FUT.price });
  return { ctx: ctxJ, op, fut };
}

const H = businessDaysAhead(makeMarket().ctx.evalTime, 2, []);
const KEYS = ['NK225E-202611', 'NK225E-202612', 'NK225MF-202612'];

function nowState(ctx: MarketContext, dX = 0): MarginState {
  return { x: ctx.x0 + dX, scenario: { ...ZERO_SCENARIO, dX }, horizonDays: H, marked: false };
}

describe('#387 nodeWeight（節点の添字と重み。節点の外は端の値）', () => {
  it('節点の上・間・外', () => {
    expect(nodeWeight(-9, REFIT_NODES)).toEqual({ m: 0, wt: 0 });
    expect(nodeWeight(-5, REFIT_NODES)).toEqual({ m: 0, wt: 0 });
    expect(nodeWeight(9, REFIT_NODES)).toEqual({ m: 11, wt: 1 });
    expect(nodeWeight(0.25, REFIT_NODES)).toEqual({ m: 7, wt: 0.5 });
    expect(nodeWeight(-1.25, REFIT_NODES).m).toBe(4);
    expect(nodeWeight(-1.25, REFIT_NODES).wt).toBeCloseTo(0.5, 12);
  });
});

describe('#387 当て直しの値（jsccRefitVector）', () => {
  const { ctx, op, fut } = market(false);
  const set = smallSet();
  const n = set.isHist.length;

  it('基準の状態で、独立に組んだ合成の BPF と 1 円も違わず、ES・VaR 証拠金額が今の JSCC の計算と一致', () => {
    const factors = synthFactors(set, KEYS, 11);
    const legs = [
      op(M1, 'put', 66000, 'sell', 2),
      op(M1, 'put', 65000, 'buy', 1),
      op(M2, 'call', 70000, 'sell', 1),
      fut('sell', 3, 'fut_mini'),
    ];
    const p = preparePosition(legs, ctx, S);
    const st = nowState(ctx);
    // 独立に組む: スマイルが無いので ATM の σ = 足の σ（シナリオ 0）
    const inst: Record<string, JsccInstrument> = {};
    for (const pl of p) {
      const L = pl.leg;
      const pnl = new Float64Array(n);
      if (L.kind === 'future') {
        const row = factors.rows.get('NK225MF-202612');
        if (!row) throw new Error('行が無い');
        for (let j = 0; j < n; j++) {
          pnl[j] = Math.round(pl.multiplier * pl.F * (Math.exp(row.r[j] as number) - 1));
        }
        inst['NK225MF-202612'] = {
          aggregationGroup: 'IDX_IDX',
          contractSize: pl.multiplier,
          price: pl.F,
          pnl,
        };
        continue;
      }
      const row = factors.rows.get(`NK225E-${L.expiry.replace('-', '')}`);
      if (!row?.g) throw new Error('行が無い');
      const sigma = legSigma(pl, ctx.x0, ZERO_SCENARIO, ctx, S) as number;
      const T = pl.T0;
      const z = Math.log(L.strike / pl.F) / (sigma * Math.sqrt(T));
      const { m, wt } = nodeWeight(z, REFIT_NODES);
      for (let j = 0; j < n; j++) {
        const g = (1 - wt) * (row.g[j * 13 + m] as number) + wt * (row.g[j * 13 + m + 1] as number);
        const v = black76Price(
          L.type,
          pl.F * Math.exp(row.r[j] as number),
          L.strike,
          T - H / 365,
          sigma * Math.exp(g),
          R,
        );
        pnl[j] = 1000 * Math.max(1, Math.round(v));
      }
      const key = `NK225E-${L.expiry.replace('-', '')}-${L.type === 'call' ? 'C' : 'P'}-${L.strike}`;
      inst[key] = {
        aggregationGroup: 'IDX_IDX',
        contractSize: 1000,
        price: legValue(pl, ctx.x0, ZERO_SCENARIO, ctx, S),
        pnl,
      };
    }
    const now = marginNowJscc(p, st, ctx, S, P, jsccData(set, inst));
    const re = marginAtJsccRefit(p, st, ctx, S, P, factors);
    if (!now || !re) throw new Error('計算にならない');
    let v = new Float64Array(n);
    for (const pl of p) {
      const L = pl.leg;
      const key =
        L.kind === 'future'
          ? 'NK225MF-202612'
          : `NK225E-${L.expiry.replace('-', '')}-${L.type === 'call' ? 'C' : 'P'}-${L.strike}`;
      const row = inst[key] as JsccInstrument;
      v = v.map((x, j) => x + pl.sign * L.qty * (row.pnl[j] as number));
    }
    expect(Array.from(re.v)).toEqual(Array.from(v));
    expect(re.result.jscc?.esSigned).toBe(now.jscc?.esSigned);
    expect(re.result.jscc?.varMargin).toBe(now.jscc?.varMargin);
    expect(re.result.margin).toBe(now.margin);
    expect(re.result.source).toBe('jscc_refit');
    expect(re.result.nov).toBeCloseTo(now.nov, 6);
  });

  it('r = g = 0・h = 0 では V = max(0, ES, ceil(−NOV)) で、ES = −Σ 1 枚の丸めた値', () => {
    const zero: JsccFactors = {
      ...synthFactors(set, KEYS, 1),
      rows: new Map(
        KEYS.map((k) => [k, { r: new Float64Array(n), g: new Float64Array(n * 13) }] as const),
      ),
    };
    const p = preparePosition([op(M1, 'put', 66000, 'sell', 2)], ctx, S);
    const st = { ...nowState(ctx), horizonDays: 0 };
    const re = marginAtJsccRefit(p, st, ctx, S, P, zero);
    if (!re) throw new Error('計算にならない');
    const unit = Math.max(
      1,
      Math.round(legValue(p[0] as PreparedLeg, ctx.x0, ZERO_SCENARIO, ctx, S)),
    );
    expect(new Set(re.v)).toEqual(new Set([-2 * 1000 * unit]));
    expect(re.result.jscc?.esSigned).toBe(2000 * unit);
    expect(re.result.jscc?.varMargin).toBe(
      Math.max(0, 2000 * unit, Math.ceil(-re.result.nov - 1e-6)),
    );
  });

  it('#393 状態 S の基準日（floor）で取引最終日まで K 営業日以内の OP の足を下限から外す。null は外さない', () => {
    const zero: JsccFactors = {
      ...synthFactors(set, KEYS, 1),
      rows: new Map(
        KEYS.map((k) => [k, { r: new Float64Array(n), g: new Float64Array(n * 13) }] as const),
      ),
    };
    // 深い OTM の売り。h を長くとって時間の減価だけのシナリオ（r = g = 0）= ES が下限（−NOV）を下回る
    const p = preparePosition(
      [
        op(M1, 'put', 60000, 'sell', 2),
        op(M2, 'put', 60000, 'sell', 1),
        fut('buy', 1, 'fut_micro'),
      ],
      ctx,
      S,
    );
    const st = { ...nowState(ctx), horizonDays: 20 };
    const none = marginAtJsccRefit(p, st, ctx, S, P, zero);
    // 2026-11 限の取引最終日 = 11-12（木）。11-09（月）→ 3 営業日 = 外す、11-06（金）→ 4 営業日 = 外さない
    const far = marginAtJsccRefit(p, st, ctx, S, P, zero, { baseDate: '2026-11-06', holidays: [] });
    const near = marginAtJsccRefit(p, st, ctx, S, P, zero, {
      baseDate: '2026-11-09',
      holidays: [],
    });
    // 2026-12 限（取引最終日 12-10）まで 3 営業日 = 両方とも外す
    const both = marginAtJsccRefit(p, st, ctx, S, P, zero, {
      baseDate: '2026-12-07',
      holidays: [],
    });
    if (!none || !far || !near || !both) throw new Error('計算にならない');
    const v2 = legValue(p[1] as PreparedLeg, st.x, st.scenario, ctx, S);
    const nov = none.result.nov;
    expect(far.result.jscc).toEqual(none.result.jscc);
    expect(far.result.jscc?.novFloor).toBe(nov);
    expect(near.result.jscc?.novFloor).toBeCloseTo(-1000 * v2, 6);
    expect(both.result.jscc?.novFloor).toBeCloseTo(0, 6);
    for (const r of [far, near, both]) {
      const j = r.result.jscc;
      if (!j) throw new Error('内訳が無い');
      // ES・表示の NOV・所要額の NOV は同じ。下限だけが変わる
      expect(j.esSigned).toBe(none.result.jscc?.esSigned);
      expect(r.result.nov).toBe(nov);
      expect(j.varMargin).toBe(Math.max(0, j.esSigned, Math.ceil(-j.novFloor - 1e-6)));
      expect(r.result.requirement).toBeCloseTo(Math.max(0, j.varMargin - nov), 6);
    }
    // 下限が効いていた = 外すと小さくなる（単調: 外すほど増えない）
    const vm = (r: typeof none) => r.result.jscc?.varMargin ?? Number.NaN;
    expect(vm(near)).toBeLessThan(vm(far));
    expect(vm(both)).toBeLessThanOrEqual(vm(near));
    expect(vm(both)).toBe(Math.max(0, both.result.jscc?.esSigned ?? Number.NaN));
  });

  it('#393 追証の線の評価も同じ floor で（全シナリオの余力 = marginAtJsccRefit の余力）', () => {
    const factors = synthFactors(set, KEYS, 21);
    const p = preparePosition([op(M1, 'put', 60000, 'sell', 2)], ctx, S);
    const floor = { baseDate: '2026-11-09', holidays: [] };
    const prem = premiumSummary(p, S);
    const ev = jsccRefitRoomEvaluator(
      p,
      ZERO_SCENARIO,
      ctx,
      S,
      P,
      H,
      false,
      5e6,
      prem,
      factors,
      floor,
    );
    for (const dX of [-3000, 0, 2000]) {
      const x = ctx.x0 + dX;
      const re = marginAtJsccRefit(p, nowState(ctx, dX), ctx, S, P, factors, floor);
      if (!re) throw new Error('計算にならない');
      expect(ev.room(x)).toBe(marginRoom(5e6, prem, re.result));
    }
  });

  it('同じ銘柄の売り買い同数は 0、枚数を整数倍すると値も同じ倍', () => {
    const factors = synthFactors(set, KEYS, 2);
    const st = nowState(ctx, -800);
    const flat = preparePosition(
      [op(M1, 'put', 66000, 'sell', 3), op(M1, 'put', 66000, 'buy', 3)],
      ctx,
      S,
    );
    const re = marginAtJsccRefit(flat, st, ctx, S, P, factors);
    expect(re?.result.margin).toBe(0);
    expect(re?.result.requirement).toBe(0);
    const one = preparePosition(
      [op(M2, 'call', 70000, 'sell', 1), fut('buy', 1, 'fut_micro')],
      ctx,
      S,
    );
    const four = preparePosition(
      [op(M2, 'call', 70000, 'sell', 4), fut('buy', 4, 'fut_micro')],
      ctx,
      S,
    );
    const a = marginAtJsccRefit(one, st, ctx, S, P, factors);
    const b = marginAtJsccRefit(four, st, ctx, S, P, factors);
    expect(Array.from(b?.v ?? [])).toEqual(Array.from(a?.v ?? []).map((x) => 4 * x));
  });

  it('平行の g = c で σ′ = σ·e^c（Black-76 の値で照合）、g の無い行は IV を動かさない', () => {
    const base = synthFactors(set, KEYS, 3);
    const c = 0.2;
    const withC = (g: Float64Array | null): JsccFactors => ({
      ...base,
      rows: new Map([...base.rows].map(([k, row]) => [k, { r: row.r, g: g ?? row.g }] as const)),
    });
    const p = preparePosition([op(M1, 'put', 65000, 'sell', 1)], ctx, S);
    const st = nowState(ctx, 500);
    const pl = p[0] as PreparedLeg;
    const sigma = legSigma(pl, st.x, st.scenario, ctx, S) as number;
    const F = st.x + pl.basis;
    const r = base.rows.get('NK225E-202611')?.r as Float64Array;
    for (const [g, s] of [
      [new Float64Array(n * 13).fill(c), sigma * Math.exp(c)],
      [null, sigma],
    ] as const) {
      const f =
        g === null ? { ...base, rows: new Map([['NK225E-202611', { r, g: null }]]) } : withC(g);
      const planned = jsccRefitPlan(p, st, ctx, S, P, f);
      if (!planned.ok) throw new Error('計画にならない');
      const v = jsccRefitVector(planned.plan);
      for (const j of [0, 7, n - 1]) {
        const want = Math.max(
          1,
          Math.round(
            black76Price('put', F * Math.exp(r[j] as number), 65000, pl.T0 - H / 365, s, R),
          ),
        );
        expect(v[j]).toBe(-1000 * want);
      }
    }
  });

  it('買いの OP で減らさない（オン）では買いの足を入れない', () => {
    const factors = synthFactors(set, KEYS, 4);
    const p = preparePosition(
      [op(M1, 'put', 66000, 'sell', 1), op(M1, 'put', 65000, 'buy', 1)],
      ctx,
      S,
    );
    const on = jsccRefitPlan(p, nowState(ctx), ctx, S, { ...P, ignoreLongOptions: true }, factors);
    const off = jsccRefitPlan(p, nowState(ctx), ctx, S, P, factors);
    expect(on.ok && on.plan.legs.length).toBe(1);
    expect(off.ok && off.plan.legs.length).toBe(2);
  });

  it('行が無い → missing、枚数が整数でない → fractional、M の足が無い → none', () => {
    const only11 = synthFactors(set, ['NK225E-202611'], 5);
    const st = nowState(ctx);
    const reason = (legs: Leg[], f: JsccFactors) => {
      const r = jsccRefitPlan(preparePosition(legs, ctx, S), st, ctx, S, P, f);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason([op(M2, 'put', 66000, 'sell')], only11)).toBe('missing');
    expect(reason([op(M1, 'put', 66000, 'sell', 1.5)], only11)).toBe('fractional');
    expect(reason([], only11)).toBe('none');
    expect(
      reason([op(M1, 'put', 66000, 'buy')], only11) === 'ok' &&
        jsccRefitPlan(
          preparePosition([op(M1, 'put', 66000, 'buy')], ctx, S),
          st,
          ctx,
          S,
          { ...P, ignoreLongOptions: true },
          only11,
        ).ok,
    ).toBe(false);
    expect(
      marginAtJsccRefit(
        preparePosition([op(M2, 'put', 66000, 'sell')], ctx, S),
        st,
        ctx,
        S,
        P,
        only11,
      ),
    ).toBeNull();
  });

  it('推定の質: 中央値が閾値を超える限月の OP の足があれば poor_fit、超えなければ当て直す。質の一覧は限月ごと', () => {
    const f = synthFactors(set, KEYS, 8);
    const withQ = (med: number | null, p90: number | null): JsccFactors => ({
      ...f,
      rows: new Map(
        [...f.rows].map(([k, r]) => [k, { ...r, checkMedianRel: med, checkP90Rel: p90 }] as const),
      ),
    });
    const p = preparePosition(
      [op(M1, 'put', 66000, 'sell'), op(M2, 'call', 70000, 'sell')],
      ctx,
      S,
    );
    const st = nowState(ctx);
    const plan = (ff: JsccFactors) => {
      const r = jsccRefitPlan(p, st, ctx, S, P, ff);
      return r.ok ? 'ok' : r.reason;
    };
    expect(plan(withQ(JSCC_REFIT_MAX_MEDIAN_REL, 0.5))).toBe('ok');
    expect(plan(withQ(JSCC_REFIT_MAX_MEDIAN_REL + 1e-9, 0.5))).toBe('poor_fit');
    expect(plan(withQ(null, null))).toBe('ok');
    expect(jsccRefitQuality(p, withQ(0.01, 0.2))).toEqual([
      { period: '202611', medianRel: 0.01, p90Rel: 0.2 },
      { period: '202612', medianRel: 0.01, p90Rel: 0.2 },
    ]);
    // 先物だけの足は質を見ない
    const fu = preparePosition([fut('buy', 1, 'fut_mini')], ctx, S);
    expect(jsccRefitPlan(fu, st, ctx, S, P, withQ(0.5, 0.5)).ok).toBe(true);
  });

  it('先物の足の行: 自分の商品 → 同じ限月の NK225E → ほかの先物（先物だけの行は g が空）', () => {
    const f = synthFactors(set, ['NK225E-202612', 'NK225F-202612'], 6, {
      futuresOnly: ['NK225F-202612'],
    });
    const [large, micro] = preparePosition(
      [fut('buy', 1, 'fut_large'), fut('buy', 1, 'fut_micro')],
      ctx,
      S,
    ) as [PreparedLeg, PreparedLeg];
    expect(jsccFactorRowOf(large, f)).toBe(f.rows.get('NK225F-202612'));
    expect(jsccFactorRowOf(micro, f)).toBe(f.rows.get('NK225E-202612'));
    expect(f.rows.get('NK225F-202612')?.g).toBeNull();
    const onlyFut = synthFactors(set, ['NK225F-202612'], 6, { futuresOnly: ['NK225F-202612'] });
    expect(jsccFactorRowOf(micro, onlyFut)).toBe(onlyFut.rows.get('NK225F-202612'));
  });

  it('σ_S を上げる（Δσ）と OP の売りの VaR 証拠金額は減らない', () => {
    const factors = synthFactors(set, KEYS, 7);
    const p = preparePosition([op(M1, 'put', 65000, 'sell', 1)], ctx, S);
    let prev = -1;
    for (const dSigma of [0, 2, 5, 10]) {
      const st: MarginState = { ...nowState(ctx), scenario: { ...ZERO_SCENARIO, dSigma } };
      const v = marginAtJsccRefit(p, st, ctx, S, P, factors)?.result.jscc?.varMargin ?? -1;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

/** KEYS の基準日の F の元（合成の板の F。#395 のテストで少しずらして使う） */
const fwdOf = (k: string) =>
  k === 'NK225E-202611' ? M1.F : k === 'NK225E-202612' ? M2.F : FUT.price;

describe('#387 追証の線: 裾の候補で絞った二分法 = 全シナリオの二分法', () => {
  // 本物より小さい並び（H 300・S 30）で、候補（4 × 裾の本数 + S）が全体より十分に少ない形
  const set = realisticSet(300, 30, 2, 97.5);
  const { ctx, op, fut } = market(true);
  const legsOf = (r: () => number): Leg[] => {
    const out: Leg[] = [];
    const nLegs = 1 + Math.floor(r() * 4);
    for (let i = 0; i < nLegs; i++) {
      const month = r() < 0.6 ? M1 : M2;
      const type = r() < 0.6 ? 'put' : 'call';
      const k = Math.round((month.F * (0.9 + r() * 0.15)) / 250) * 250;
      const side = r() < 0.65 ? 'sell' : 'buy';
      try {
        out.push(op(month, type, k, side, 1 + Math.floor(r() * 3)));
      } catch {
        // 板に無い行使価格は飛ばす
      }
    }
    if (r() < 0.2) out.push(fut(r() < 0.5 ? 'buy' : 'sell', 1, 'fut_mini'));
    return out;
  };

  it('種つき乱数のポジション 200 件で根が 1 円以内で一致', () => {
    expect(jsccTailCount(302, 97.5)).toBe(8);
    const r = rng(3870);
    let compared = 0;
    for (let c = 0; c < 200; c++) {
      const legs = legsOf(r);
      if (legs.length === 0) continue;
      const p = preparePosition(legs, ctx, S);
      // 半分は基準日の F を付けて急変の係数を入れる（#395。x ごとに s が変わっても二分法の根が全シナリオと同じ）
      const factors = synthFactors(
        set,
        KEYS,
        1000 + c,
        c % 2 === 0 ? { forwards: Object.fromEntries(KEYS.map((k) => [k, fwdOf(k) * 0.99])) } : {},
      );
      const premium = premiumSummary(p, S);
      const capital = 300_000 + Math.floor(r() * 3_000_000);
      const sc = { ...ZERO_SCENARIO, days: Math.floor(r() * 5) };
      const ev = jsccRefitRoomEvaluator(p, sc, ctx, S, P, H, false, capital, premium, factors);
      const range = { lo: ctx.x0 * 0.7, hi: ctx.x0 * 1.3 };
      const fast = drainSteps(marginCallLevelsSteps(p, sc, ctx, S, false, ev, range, 16));
      const slow = drainSteps(
        marginCallLevelsSteps(p, sc, ctx, S, false, { room: ev.room }, range, 16),
      );
      expect(fast.length).toBe(slow.length);
      fast.forEach((x, i) => {
        expect(Math.abs(x - (slow[i] as number))).toBeLessThanOrEqual(1);
      });
      compared += fast.length;
    }
    // 根のある形が十分にあること（全部 [] で通るのを防ぐ）
    expect(compared).toBeGreaterThan(50);
  }, 120_000);

  it('区間の両端の v を覚えていなければ refine は null（全シナリオでやり直す）', () => {
    const p = preparePosition([op(M1, 'put', 66000, 'sell', 1)], ctx, S);
    const f = synthFactors(set, KEYS, 9);
    const ev = jsccRefitRoomEvaluator(
      p,
      ZERO_SCENARIO,
      ctx,
      S,
      P,
      H,
      false,
      1e6,
      premiumSummary(p, S),
      f,
    );
    const g = ev.refine?.(60000, 61000, -1, 1);
    expect(g && drainSteps(g)).toBeNull();
  });

  it('jsccEsOfSorted は集めた n 本の小さい方の裾だけで jsccEsSigned と一致（足りなければ例外）', () => {
    const n = set.isHist.length;
    const r = rng(5);
    for (let c = 0; c < 50; c++) {
      const v = Float64Array.from({ length: n }, () => Math.round((r() - 0.5) * 1e6));
      const h = v.filter((_, j) => set.isHist[j]);
      const s = Array.from(v.filter((_, j) => !set.isHist[j])).sort((a, b) => a - b);
      const xs = [...h, ...s.slice(0, set.nStress)].sort((a, b) => a - b);
      const m = h.length + set.nStress;
      const t = jsccTailCount(m, set.confidence);
      expect(jsccEsOfSorted(xs.slice(0, t), m, set)).toBe(jsccEsSigned(v, set));
      expect(() => jsccEsOfSorted(xs.slice(0, t - 1), m, set)).toThrow();
    }
  });
});

describe('#395 急変の係数（縮めない EWMA。r × s）', () => {
  const { ctx, op, fut } = market(false);
  const set = smallSet();
  const n = set.isHist.length;
  const lam = JSCC_REFIT_EWMA_LAMBDA;
  /** H の r の母標準偏差（独立に計算） */
  const hStd = (r: Float64Array) => {
    const h = Array.from(r).filter((_, j) => set.isHist[j]);
    const m = h.reduce((a, b) => a + b, 0) / h.length;
    return Math.sqrt(h.reduce((a, b) => a + (b - m) ** 2, 0) / h.length);
  };

  it('係数の式: |x| ≤ σ は 1、|x| > σ は √(λ + (1 − λ)x²/σ²)、符号によらない、σ が正でなければ 1', () => {
    expect(lam).toBe(0.976);
    expect(jsccRefitEwmaScale(0, 0.03)).toBe(1);
    expect(jsccRefitEwmaScale(0.03, 0.03)).toBe(1);
    expect(jsccRefitEwmaScale(-0.02, 0.03)).toBe(1);
    expect(jsccRefitEwmaScale(0.09, 0.03)).toBeCloseTo(Math.sqrt(lam + (1 - lam) * 9), 14);
    expect(jsccRefitEwmaScale(-0.09, 0.03)).toBe(jsccRefitEwmaScale(0.09, 0.03));
    expect(jsccRefitEwmaScale(0.3, 0.03)).toBeCloseTo(Math.sqrt(lam + (1 - lam) * 100), 14);
    for (const bad of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(jsccRefitEwmaScale(0.1, bad)).toBe(1);
    }
    expect(jsccRefitEwmaScale(Number.NaN, 0.03)).toBe(1);
    // x について単調（|x| が大きいほど大きい）
    let prev = 0;
    for (let x = 0; x <= 0.3; x += 0.01) {
      const v = jsccRefitEwmaScale(x, 0.03);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('基準日の F が無い応答は係数なし（null）で、F が状態と同じ応答（s = 1）と 1 円も違わない', () => {
    const legs = [
      op(M1, 'put', 66000, 'sell', 2),
      op(M2, 'call', 70000, 'sell'),
      fut('buy', 1, 'fut_mini'),
    ];
    const p = preparePosition(legs, ctx, S);
    const st = nowState(ctx);
    const old = synthFactors(set, KEYS, 21);
    const same = synthFactors(set, KEYS, 21, {
      forwards: Object.fromEntries(KEYS.map((k) => [k, fwdOf(k)])),
    });
    const a = jsccRefitPlan(p, st, ctx, S, P, old);
    const b = jsccRefitPlan(p, st, ctx, S, P, same);
    if (!a.ok || !b.ok) throw new Error('計画にならない');
    expect(a.plan.ewmaScale).toBeNull();
    expect(b.plan.ewmaScale).toBe(1);
    expect(Array.from(jsccRefitVector(b.plan))).toEqual(Array.from(jsccRefitVector(a.plan)));
    expect(marginAtJsccRefit(p, st, ctx, S, P, old)?.result.jscc?.ewmaScale).toBeNull();
    expect(marginAtJsccRefit(p, st, ctx, S, P, same)?.result.jscc?.ewmaScale).toBe(1);
  });

  it('大きく動いた状態: s を独立に求め、先物は round(乗数 × F_S (e^{s·r} − 1))、OP は F′ = F_S e^{s·r} の Black-76 と一致', () => {
    // 基準日の F を 8% 上に置く = 状態 S は基準日から約 −8% 下げた（2 日の σ の数倍）
    const f = synthFactors(set, KEYS, 22, {
      forwards: Object.fromEntries(KEYS.map((k) => [k, fwdOf(k) * 1.08])),
    });
    const [pf, po] = preparePosition(
      [fut('sell', 1, 'fut_mini'), op(M1, 'put', 65000, 'sell')],
      ctx,
      S,
    ) as [PreparedLeg, PreparedLeg];
    const st = nowState(ctx);
    const planned = jsccRefitPlan([pf, po], st, ctx, S, P, f);
    if (!planned.ok) throw new Error('計画にならない');
    // 基準の足 = 限月の最も早い M1（2026-11）の OP
    const row1 = f.rows.get('NK225E-202611');
    const rowF = f.rows.get('NK225MF-202612');
    if (!row1?.g || !rowF) throw new Error('行が無い');
    const x = Math.log(po.F / (row1.forward as number));
    const sigma = hStd(row1.r);
    const s = Math.sqrt(Math.max(1, lam + ((1 - lam) * x * x) / (sigma * sigma)));
    expect(s).toBeGreaterThan(1.05);
    expect(planned.plan.ewmaScale).toBeCloseTo(s, 12);
    const v = jsccRefitVector(planned.plan);
    const sig = legSigma(po, ctx.x0, ZERO_SCENARIO, ctx, S) as number;
    const z = Math.log(65000 / po.F) / (sig * Math.sqrt(po.T0));
    const { m, wt } = nodeWeight(z, REFIT_NODES);
    for (const j of [0, 3, 17, n - 1]) {
      const fu = -Math.round(pf.multiplier * pf.F * (Math.exp(s * (rowF.r[j] as number)) - 1));
      const g = (1 - wt) * (row1.g[j * 13 + m] as number) + wt * (row1.g[j * 13 + m + 1] as number);
      const o =
        -1000 *
        Math.max(
          1,
          Math.round(
            black76Price(
              'put',
              po.F * Math.exp(s * (row1.r[j] as number)),
              65000,
              po.T0 - H / 365,
              sig * Math.exp(g),
              R,
            ),
          ),
        );
      expect(v[j]).toBe(fu + o);
    }
  });

  it('係数は状態ごとに 1 つ: 同じ plan のすべての足が同じ s で、x が同じなら限月によらない', () => {
    const f = synthFactors(set, KEYS, 23, {
      forwards: Object.fromEntries(KEYS.map((k) => [k, fwdOf(k) * 0.93])),
    });
    const p = preparePosition(
      [op(M2, 'call', 70000, 'sell'), op(M1, 'put', 65000, 'sell'), fut('sell', 2, 'fut_mini')],
      ctx,
      S,
    );
    const planned = jsccRefitPlan(p, nowState(ctx), ctx, S, P, f);
    if (!planned.ok) throw new Error('計画にならない');
    const s = planned.plan.ewmaScale as number;
    expect(s).toBeGreaterThan(1);
    const rows = [
      f.rows.get('NK225E-202612'),
      f.rows.get('NK225E-202611'),
      f.rows.get('NK225MF-202612'),
    ];
    planned.plan.legs.forEach((L, i) => {
      const r = (rows[i] as { r: Float64Array }).r;
      for (const j of [0, 5, n - 1])
        expect(L.eR[j]).toBeCloseTo(Math.exp(s * (r[j] as number)), 14);
    });
    // 基準は限月の最も早い M1。M1 の基準日の F だけを変えると s が変わり、M2 だけを変えても変わらない
    const shift = (key: string, k: number): JsccFactors => ({
      ...f,
      rows: new Map(
        [...f.rows].map(
          ([kk, r]) => [kk, kk === key ? { ...r, forward: (r.forward as number) * k } : r] as const,
        ),
      ),
    });
    const sOf = (ff: JsccFactors) => {
      const r = jsccRefitPlan(p, nowState(ctx), ctx, S, P, ff);
      return r.ok ? r.plan.ewmaScale : Number.NaN;
    };
    expect(sOf(shift('NK225E-202612', 0.95))).toBe(s);
    expect(sOf(shift('NK225E-202611', 0.95))).not.toBe(s);
  });

  it('h の間に SQ がある足（T′ ≤ 0.5 日）は基準にしない。その足だけなら、その足で求める', () => {
    const f = synthFactors(set, KEYS, 24, {
      forwards: { 'NK225E-202611': M1.F * 1.1, 'NK225E-202612': M2.F * 0.95 },
    });
    const [p1, p2] = preparePosition(
      [op(M1, 'put', 65000, 'sell'), op(M2, 'put', 65000, 'sell')],
      ctx,
      S,
    ) as [PreparedLeg, PreparedLeg];
    // M1 の SQ を h の中に入れる（h = M1 の残存の日数 + 1）
    const st: MarginState = { ...nowState(ctx), horizonDays: Math.ceil(p1.T0 * 365) + 1 };
    const both = jsccRefitPlan([p1, p2], st, ctx, S, P, f);
    const only1 = jsccRefitPlan([p1], st, ctx, S, P, f);
    if (!both.ok || !only1.ok) throw new Error('計画にならない');
    const row2 = f.rows.get('NK225E-202612') as { r: Float64Array; forward: number };
    const row1 = f.rows.get('NK225E-202611') as { r: Float64Array; forward: number };
    expect(both.plan.ewmaScale).toBeCloseTo(
      jsccRefitEwmaScale(Math.log(p2.F / row2.forward), hStd(row2.r)),
      12,
    );
    expect(only1.plan.ewmaScale).toBeCloseTo(
      jsccRefitEwmaScale(Math.log(p1.F / row1.forward), hStd(row1.r)),
      12,
    );
    expect(only1.plan.ewmaScale).toBeGreaterThan(1);
  });

  it('合成の検証: 状態の動きが大きいほど先物の売りの ES が s 倍に近く増え、落ち着いた動き（|x| ≤ σ）では変わらない', () => {
    const p = preparePosition([fut('sell', 1, 'fut_mini')], ctx, S);
    const st = nowState(ctx);
    const base = marginAtJsccRefit(p, st, ctx, S, P, synthFactors(set, KEYS, 25))?.result.jscc
      ?.esSigned;
    if (base === undefined) throw new Error('計算にならない');
    const rowF = synthFactors(set, KEYS, 25).rows.get('NK225MF-202612') as { r: Float64Array };
    const sigma = hStd(rowF.r);
    for (const k of [0.5, 1, 3, 6]) {
      const fw = FUT.price * Math.exp(k * sigma);
      const f = synthFactors(set, KEYS, 25, { forwards: { 'NK225MF-202612': fw } });
      const re = marginAtJsccRefit(p, st, ctx, S, P, f)?.result;
      const s = re?.jscc?.ewmaScale as number;
      const es = re?.jscc?.esSigned as number;
      if (k <= 1) {
        expect(s).toBe(1);
        expect(es).toBe(base);
      } else {
        expect(s).toBeCloseTo(Math.sqrt(lam + (1 - lam) * k * k), 3);
        // 先物の損益は r にほぼ線形（e^{sr} − 1 ≈ s·r）。ES の比は s の 3% 以内
        expect(Math.abs(es / base / s - 1)).toBeLessThan(0.03);
      }
    }
  });
});

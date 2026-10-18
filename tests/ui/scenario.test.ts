import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import {
  DAY_MS,
  evaluatePosition,
  jstInstant,
  lastTradingCloseInstant,
  monthlyExpiry,
  sqInstant,
  ZERO_SCENARIO,
} from '../../model';
import { CALENDAR } from '../../ui/calendar';
import { type Action, initialState, reduce, type State } from '../../ui/state';
import { maxScenarioDays, pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import {
  clampDXInput,
  DRAG_DX_STEP,
  daysToTarget,
  dXFromAxis,
  dXRange,
  evalTimeTargets,
  fmtSliderValue,
  fromDisplay,
  parseBeta,
  parseSliderInput,
  type SliderSpec,
  sliderSpec,
  stepDXKey,
  stepSlider,
  toDisplay,
} from '../../ui/view/scenario';
import { fixture } from '../support/fixtures';

/** #6 AC-4・AC-5（AC26）: スライダーの状態遷移・数値入力・評価時刻ボタン。合成の板（架空の値）。 */

const X0 = 67_810;
const ctx = { x0: X0, maxDays: 58.5, dXUnit: 'pct' as const };

describe('スライダーの仕様（設計 5.4）', () => {
  it('d: 0〜最遠の足の SQ・刻み 1。足 0 本（上限 0）は無効', () => {
    expect(sliderSpec('days', ctx)).toMatchObject({ min: 0, max: 58.5, step: 1, def: 0 });
    expect(sliderSpec('days', ctx).disabled).toBe(false);
    expect(sliderSpec('days', { ...ctx, maxDays: 0 })).toMatchObject({
      min: 0,
      max: 0,
      disabled: true,
    });
    expect(sliderSpec('days', { ...ctx, maxDays: Number.NaN }).max).toBe(0);
  });

  it('ΔX のステッパー: % は −90〜+100・0.5%、円は 100 円の格子に乗る −0.9X₀〜+1.0X₀。X₀ が決まらなければ無効', () => {
    expect(sliderSpec('dX', ctx)).toMatchObject({ min: -90, max: 100, step: 0.5, unit: '%' });
    const yen = sliderSpec('dX', { ...ctx, dXUnit: 'yen' });
    // −0.9 × 67,810 = −61,029 → −61,000、1.0 × 67,810 = 67,810 → 67,800
    expect(yen).toMatchObject({ min: -61_000, max: 67_800, step: 100, unit: '円' });
    expect(sliderSpec('dX', { ...ctx, x0: Number.NaN }).disabled).toBe(true);
    expect(sliderSpec('dX', { ...ctx, x0: 0 }).disabled).toBe(true);
  });

  it('Δσ: −10〜+40pt・0.5、Δs: −5〜+5・0.5', () => {
    expect(sliderSpec('dSigma', ctx)).toMatchObject({ min: -10, max: 40, step: 0.5, def: 0 });
    expect(sliderSpec('skew', ctx)).toMatchObject({ min: -5, max: 5, step: 0.5, def: 0 });
  });

  it('ΔX の % ⇄ 円（状態は円）', () => {
    expect(toDisplay('dX', -6781, X0, 'pct')).toBeCloseTo(-10, 12);
    expect(fromDisplay('dX', -10, X0, 'pct')).toBeCloseTo(-6781, 9);
    expect(toDisplay('dX', -6781, X0, 'yen')).toBe(-6781);
    expect(fromDisplay('dX', 300, X0, 'yen')).toBe(300);
    expect(toDisplay('dSigma', 3, X0, 'pct')).toBe(3);
    expect(fromDisplay('dX', 5, Number.NaN, 'pct')).toBe(0);
  });

  it('ΔX の % → 円は ±1e6 円を超えない（上限の % を戻したときの丸め）', () => {
    // 架空の X₀（1e6 円の頭打ちが効く大きさ）
    for (const x0 of [111_112, 123_456.789, 333_333.33]) {
      const spec = sliderSpec('dX', { ...ctx, x0 });
      const hi = spec.inputMax ?? Number.NaN;
      expect(Math.abs(fromDisplay('dX', hi, x0, 'pct'))).toBeLessThanOrEqual(1e6);
      expect(Math.abs(fromDisplay('dX', 1e4, x0, 'pct'))).toBe(1e6);
    }
  });
});

describe('キー操作の状態遷移（AC-4）', () => {
  const sigma = sliderSpec('dSigma', ctx);
  const days = sliderSpec('days', ctx);
  const dxPct = sliderSpec('dX', ctx);
  const dxYen = sliderSpec('dX', { ...ctx, dXUnit: 'yen' });

  it('矢印 = ±1 刻み、Shift + 矢印・PageUp/PageDown = ±10 刻み', () => {
    expect(stepSlider(sigma, 0, 'ArrowRight', false)).toBe(0.5);
    expect(stepSlider(sigma, 0, 'ArrowUp', false)).toBe(0.5);
    expect(stepSlider(sigma, 0, 'ArrowLeft', false)).toBe(-0.5);
    expect(stepSlider(sigma, 0, 'ArrowDown', false)).toBe(-0.5);
    expect(stepSlider(sigma, 0, 'ArrowRight', true)).toBe(5);
    expect(stepSlider(sigma, 0, 'ArrowLeft', true)).toBe(-5);
    expect(stepSlider(sigma, 0, 'PageUp', false)).toBe(5);
    expect(stepSlider(sigma, 0, 'PageDown', false)).toBe(-5);
    expect(stepSlider(days, 3, 'ArrowRight', false)).toBe(4);
    expect(stepSlider(days, 3, 'ArrowRight', true)).toBe(13);
    expect(stepSlider(dxPct, -3, 'ArrowLeft', false)).toBe(-3.5);
    expect(stepSlider(dxYen, 0, 'ArrowRight', true)).toBe(1000);
    // 刻みの格子に乗せる（0.1 を足し続けても端数が溜まらない）
    let v = 0;
    for (let i = 0; i < 7; i++) v = stepSlider(sigma, v, 'ArrowRight', false) as number;
    expect(v).toBe(3.5);
  });

  it('範囲の端で止まる。Home / End は端', () => {
    expect(stepSlider(sigma, 39.5, 'ArrowRight', true)).toBe(40);
    expect(stepSlider(sigma, 40, 'ArrowRight', false)).toBe(40);
    expect(stepSlider(sigma, -10, 'ArrowLeft', true)).toBe(-10);
    expect(stepSlider(days, 0, 'ArrowLeft', false)).toBe(0);
    expect(stepSlider(days, 55, 'ArrowRight', true)).toBe(58.5);
    expect(stepSlider(dxPct, 100, 'PageUp', false)).toBe(100);
    expect(stepSlider(dxYen, -61_000, 'ArrowLeft', false)).toBe(-61_000);
    expect(stepSlider(sigma, 3, 'Home', false)).toBe(-10);
    expect(stepSlider(sigma, 3, 'End', false)).toBe(40);
    expect(stepSlider(days, 3, 'End', false)).toBe(58.5);
  });

  it('R = そのスライダーの既定値、+ / = / − / - = 損益グラフの拡大・縮小、他のキーは扱わない', () => {
    expect(stepSlider(sigma, 12.5, 'r', false)).toBe(0);
    expect(stepSlider(days, 12, 'R', true)).toBe(0);
    expect(stepSlider(sigma, 12.5, '+', true)).toBe('zoomIn');
    expect(stepSlider(sigma, 12.5, '=', false)).toBe('zoomIn');
    expect(stepSlider(sigma, 12.5, '-', false)).toBe('zoomOut');
    expect(stepSlider(sigma, 12.5, '−', false)).toBe('zoomOut');
    expect(stepSlider(sigma, 12.5, 'a', false)).toBeNull();
    expect(stepSlider(sigma, 12.5, 'Tab', false)).toBeNull();
  });

  it('無効なスライダー（足 0 本の d）は値を変えないが、拡大・縮小は通す', () => {
    const off = sliderSpec('days', { ...ctx, maxDays: 0 });
    expect(stepSlider(off, 0, 'ArrowRight', false)).toBeNull();
    expect(stepSlider(off, 0, '+', false)).toBe('zoomIn');
  });
});

describe('数値入力（AC-4）', () => {
  const sigma = sliderSpec('dSigma', ctx);
  const days = sliderSpec('days', ctx);
  const dxPct = sliderSpec('dX', ctx);

  it('範囲内の数を受ける（空白・桁区切り・先頭の + ・Unicode マイナス）。d は小数可', () => {
    expect(parseSliderInput(' 12.5 ', sigma)).toEqual({ ok: true, value: 12.5 });
    expect(parseSliderInput('+3', sigma)).toEqual({ ok: true, value: 3 });
    expect(parseSliderInput('−3', sigma)).toEqual({ ok: true, value: -3 });
    expect(parseSliderInput('-10', sigma)).toEqual({ ok: true, value: -10 });
    expect(parseSliderInput('12.25', days)).toEqual({ ok: true, value: 12.25 });
    expect(parseSliderInput('58.5', days)).toEqual({ ok: true, value: 58.5 });
    expect(parseSliderInput('−40.0', dxPct)).toEqual({ ok: true, value: -40 });
    const yen = sliderSpec('dX', { ...ctx, dXUnit: 'yen' });
    expect(parseSliderInput('−2,000', yen)).toEqual({ ok: true, value: -2000 });
    // fmtSliderValue の出力はそのまま読み戻せる
    for (const [spec, v] of [
      [sigma, -3.5],
      [dxPct, -12.5],
      [yen, -2000],
      [days, 12.25],
    ] as Array<[SliderSpec, number]>) {
      expect(parseSliderInput(fmtSliderValue(spec, v), spec)).toEqual({ ok: true, value: v });
    }
  });

  it('範囲外・非数は拒否し、文言は入力文字列を含まない（状態は変えない = 部品が dispatch しない）', () => {
    for (const t of ['40.5', '-10.5', 'abc', '', '−', '1e400', '0x10', 'Infinity', '1-2']) {
      const r = parseSliderInput(t, sigma);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toBe('IV 平行移動 Δσは −10.0〜40.0 pt');
        if (t.length > 1) expect(r.message).not.toContain(t);
      }
    }
    // d の上限 = 最遠の足の SQ までの日数
    expect(parseSliderInput('58.6', days).ok).toBe(false);
    expect(parseSliderInput('-1', days).ok).toBe(false);
    expect(parseSliderInput('1', sliderSpec('days', { ...ctx, maxDays: 0 })).ok).toBe(false);
  });

  it('ΔX の数値欄: % は −99〜+900、円は ⌈−0.99X₀⌉〜⌊9X₀⌋ を受け付け、−100・+900.5・円の −X₀・NaN・Infinity・空は固定の文言で拒否（入力文字列を含めない）（#144 AC-2）', () => {
    expect(dxPct).toMatchObject({ min: -90, max: 100, inputMin: -99, inputMax: 900 });
    expect(parseSliderInput('-99', dxPct)).toEqual({ ok: true, value: -99 });
    expect(parseSliderInput('−95', dxPct)).toEqual({ ok: true, value: -95 });
    expect(parseSliderInput('900', dxPct)).toEqual({ ok: true, value: 900 });
    expect(parseSliderInput('+250.5', dxPct)).toEqual({ ok: true, value: 250.5 });
    const yen = sliderSpec('dX', { ...ctx, dXUnit: 'yen' });
    // ⌈−0.99 × 67,810⌉ = ⌈−67,131.9⌉ = −67,131、9 × 67,810 = 610,290
    expect(yen).toMatchObject({ inputMin: -67_131, inputMax: 610_290 });
    expect(parseSliderInput('−67,131', yen)).toEqual({ ok: true, value: -67_131 });
    expect(parseSliderInput('610,290', yen)).toEqual({ ok: true, value: 610_290 });
    for (const [spec, bad, msg] of [
      [
        dxPct,
        ['-100', '-99.5', '900.5', '1000', 'NaN', 'Infinity', '-Infinity', '', 'abc', '1e400'],
        '原資産 ΔXは −99.0〜900.0 %',
      ],
      [
        yen,
        [String(-X0), '-67132', '610291', 'NaN', 'Infinity', '', 'x'],
        '原資産 ΔXは −67,131〜610,290 円',
      ],
    ] as Array<[SliderSpec, string[], string]>) {
      for (const t of bad) {
        const r = parseSliderInput(t, spec);
        expect(r).toEqual({ ok: false, message: msg });
      }
    }
    // 受け付けた値で X₀ + ΔX > 0
    for (const t of ['-99', '-98.5']) {
      const r = parseSliderInput(t, dxPct);
      if (!r.ok) throw new Error(t);
      expect(X0 + fromDisplay('dX', r.value, X0, 'pct')).toBeGreaterThan(0);
    }
    // 上限は保存の検査（|ΔX| ≤ 1e6 円）を超えない: X₀ = 200,000 なら +500%（1e6 円）まで
    const big = { x0: 200_000, maxDays: 58.5 };
    expect(sliderSpec('dX', { ...big, dXUnit: 'pct' }).inputMax).toBe(500);
    expect(sliderSpec('dX', { ...big, dXUnit: 'yen' }).inputMax).toBe(1_000_000);
    expect(parseSliderInput('500.5', sliderSpec('dX', { ...big, dXUnit: 'pct' })).ok).toBe(false);
    // X₀ が決まらなければ数値欄の範囲は付けない（無効）
    expect(sliderSpec('dX', { ...ctx, x0: Number.NaN }).inputMin).toBeUndefined();
  });

  it('β: 0〜10（0 で連動なし）', () => {
    expect(parseBeta('0')).toEqual({ ok: true, value: 0 });
    expect(parseBeta('1.5')).toEqual({ ok: true, value: 1.5 });
    expect(parseBeta('10')).toEqual({ ok: true, value: 10 });
    expect(parseBeta('10.1').ok).toBe(false);
    expect(parseBeta('−1').ok).toBe(false);
    expect(parseBeta('x').ok).toBe(false);
  });
});

describe('「SQ 日 9:00」「取引最終日 15:45」ボタン（AC-5）', () => {
  const chain = normalizeChain(fixture('latest'));
  const [m1, m2] = chain.months;
  if (!m1 || !m2) throw new Error('限月が無い');

  function loaded(c: Chain): State {
    return reduce(initialState, { type: 'loaded', chain: c, label: 'latest' });
  }
  const run = (s: State, ...a: Action[]) => a.reduce(reduce, s);

  // 1 限月の put 売り・2 限月の call 買い・板に無い限月（2027-01）の手入力の put・ミニ先物（板の先物 = 2 限月と同じ限月）
  const state = run(
    loaded(chain),
    { type: 'addBoardLeg', expiry: m1.id, k: 64_000, optionType: 'put', side: 'sell' },
    { type: 'addBoardLeg', expiry: m2.id, k: 72_000, optionType: 'call', side: 'buy' },
    {
      type: 'addManualLeg',
      input: {
        product: 'op_large',
        expiry: '2027-01',
        type: 'put',
        k: 60_000,
        side: 'sell',
        qty: 1,
        entry: 500,
        iv: 0.3,
      },
    },
    {
      type: 'addFutureLeg',
      input: { product: 'fut_mini', contract: chain.future.id, side: 'buy' },
    },
  );

  it('対象 = 足の限月（ID で重複除去、SQ 昇順）。SQ 日・取引最終日は板の値、板に無い限月は取引カレンダー', () => {
    expect(state.legs.length).toBe(4);
    const targets = evalTimeTargets(chain, state.legs, CALENDAR);
    expect(targets.map((t) => t.id)).toEqual([m1.id, m2.id, '2027-01']);
    expect(targets[0]).toMatchObject({
      sqTime: sqInstant(m1.sqDate),
      lastTradeClose: lastTradingCloseInstant(m1.lastTradingDay),
    });
    // 2 限月は OP と先物が同じ限月（1 つにまとめる）
    expect(targets[1]?.label).toBe(`${m2.id} 限（OP・先物）`);
    const jan = monthlyExpiry(2027, 1, CALENDAR.holidays);
    expect(targets[2]).toMatchObject({
      sqTime: jan.sqTime,
      lastTradeClose: lastTradingCloseInstant(jan.lastTradingDay),
    });
    expect(evalTimeTargets(chain, [], CALENDAR)).toEqual([]);
  });

  it('評価時刻 + d が SQ 日 9:00 JST・取引最終日 15:45 JST に 1 ms 以内で一致し、SQ 日 9:00 ではその限月の足が満期', () => {
    const pm = positionModel(chain, state.legs, 'B', CALENDAR);
    const base = pnlDomains(chain, pm.prepared, pm.ctx);
    if (!base) throw new Error('基礎が作れない');
    const evalTime = pm.ctx.evalTime;
    for (const t of evalTimeTargets(chain, state.legs, CALENDAR)) {
      for (const target of [t.sqTime, t.lastTradeClose]) {
        const d = daysToTarget(evalTime, target, base.maxDays);
        if (d === null) throw new Error('d が決まらない');
        expect(Math.abs(evalTime + d * DAY_MS - target)).toBeLessThanOrEqual(1);
        // reducer に入れても同じ（d は範囲内）
        const s = reduce(state, { type: 'setScenario', patch: { days: d } });
        expect(s.scenario.days).toBe(d);
      }
      // SQ 日 9:00: その限月の足は満期（expired / 先物は settled_flat）、それより先の限月の足は live
      const d = daysToTarget(evalTime, t.sqTime, base.maxDays) as number;
      const ev = evaluatePosition(pm.prepared, { ...ZERO_SCENARIO, days: d }, pm.ctx);
      pm.prepared.forEach((p, i) => {
        const id = p.leg.kind === 'option' ? p.leg.expiry : p.leg.contract;
        const st = ev.legs[i]?.state;
        if (id === t.id) expect(st).toBe(p.leg.kind === 'option' ? 'expired' : 'settled_flat');
        else if (p.expiryTime > t.sqTime) expect(st).toBe('live');
      });
      // 取引最終日 15:45 はまだ満期ではない（T' > 0 の Black-76）
      const dl = daysToTarget(evalTime, t.lastTradeClose, base.maxDays) as number;
      const evl = evaluatePosition(pm.prepared, { ...ZERO_SCENARIO, days: dl }, pm.ctx);
      pm.prepared.forEach((p, i) => {
        if (p.leg.kind === 'option' && p.leg.expiry === t.id) {
          expect(evl.legs[i]?.state).toBe('live');
        }
      });
    }
  });

  it('多数の評価時刻でも SQ 日 9:00 の d で満期（浮動小数の端数で near_expiry にならない）', () => {
    const pm0 = positionModel(chain, state.legs, 'B', CALENDAR);
    const sq = sqInstant(m1.sqDate);
    for (let i = 0; i < 500; i++) {
      // 評価時刻を 1 限月の SQ の 0〜40 日前の端数のある時刻に動かす
      const evalTime = sq - Math.floor((i * 7_919_993) % (40 * DAY_MS)) - 1;
      const ctxI = { ...pm0.ctx, evalTime };
      const prepared = pm0.prepared.map((p) => ({
        ...p,
        T0: (p.expiryTime - evalTime) / (365 * DAY_MS),
      }));
      const maxDays = maxScenarioDays(prepared);
      // 1 限月の SQ と、最遠の足（上限 maxDays に当たる）の SQ
      for (const target of [sq, Math.max(...prepared.map((p) => p.expiryTime))]) {
        const d = daysToTarget(evalTime, target, maxDays) as number;
        const ev = evaluatePosition(prepared, { ...ZERO_SCENARIO, days: d }, ctxI);
        prepared.forEach((p, j) => {
          if (p.leg.kind === 'option' && p.expiryTime <= target) {
            expect(ev.legs[j]?.state).toBe('expired');
          }
        });
      }
    }
  });

  it('目標が評価時刻以前なら null（負の d を作らない）、上は最遠の足の SQ に収める', () => {
    const t = jstInstant('2026-10-13', 21, 31);
    expect(daysToTarget(t, t, 30)).toBeNull();
    expect(daysToTarget(t, t - 1, 30)).toBeNull();
    expect(daysToTarget(t, t + 2.5 * DAY_MS, 30)).toBeCloseTo(2.5, 12);
    expect(daysToTarget(t, t + 40 * DAY_MS, 30)).toBe(30);
    expect(daysToTarget(t, Number.NaN, 30)).toBeNull();
  });
});

/** #52 AC-4・AC-5: グラフの位置 → ΔX（10 円の格子）とグラフのキー（, . < >）。架空の X₀。 */
describe('グラフ上の ΔX（#52）', () => {
  const x0 = 33_912.34;

  it('範囲: −90% / +100% の内側の格子の端（#144）', () => {
    // −0.9 × 33,912.34 = −30,521.1 → −30,520、33,912.34 → 33,910
    expect(dXRange(x0)).toEqual([-30_520, 33_910]);
    expect(dXRange(x0, 100)).toEqual([-30_500, 33_900]);
    expect(DRAG_DX_STEP).toBe(10);
  });

  it('横軸の値 − X₀ を 10 円の格子に丸め、範囲に収める', () => {
    expect(dXFromAxis(x0 + 1_234.4, x0)).toBe(1_230);
    expect(dXFromAxis(x0 + 1_235.1, x0)).toBe(1_240);
    expect(dXFromAxis(x0 - 4.9, x0)).toBe(0);
    expect(dXFromAxis(x0 - 777.7, x0)).toBe(-780);
    expect(dXFromAxis(x0 * 3, x0)).toBe(33_910);
    expect(dXFromAxis(0, x0)).toBe(-30_520);
    for (const v of [x0 * 0.3, x0 * 0.7, x0, x0 * 1.1, x0 * 1.5]) {
      const d = dXFromAxis(v, x0) as number;
      expect(Number.isInteger(d / 10)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(-0.9 * x0);
      expect(d).toBeLessThanOrEqual(1.0 * x0);
    }
  });

  it('X₀ が非有限・0 以下、横軸の値が非有限なら変換しない（null）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -100]) {
      expect(dXFromAxis(30_000, bad)).toBeNull();
      expect(stepDXKey(0, '.', bad)).toBeNull();
    }
    expect(dXFromAxis(Number.NaN, x0)).toBeNull();
    expect(dXFromAxis(Number.NEGATIVE_INFINITY, x0)).toBeNull();
  });

  it('キー: , / . で ∓100 円、< / > で ∓1,000 円（現在値から押した向きに動かし、ドラッグと同じ範囲に収める）', () => {
    expect(stepDXKey(0, ',', x0)).toBe(-100);
    expect(stepDXKey(0, '.', x0)).toBe(100);
    expect(stepDXKey(0, '<', x0)).toBe(-1_000);
    expect(stepDXKey(0, '>', x0)).toBe(1_000);
    // ドラッグの 10 円の格子の値からも、押した向きにちょうど 100 円
    expect(stepDXKey(1_230, '.', x0)).toBe(1_330);
    expect(stepDXKey(1_270, ',', x0)).toBe(1_170);
    // 範囲はドラッグと共通（10 円の格子の内側の端）
    expect(stepDXKey(33_250, '>', x0)).toBe(33_910);
    expect(stepDXKey(-30_200, '<', x0)).toBe(-30_520);
    // 非有限の ΔX は 0 から
    expect(stepDXKey(Number.NaN, '.', x0)).toBe(100);
  });

  it('キー: ドラッグで端（上限・下限）まで動かした後は、押した向きに動かない（逆向きにならない）', () => {
    const [lo, hi] = dXRange(x0);
    for (const k of ['.', '>']) expect(stepDXKey(hi, k, x0)).toBe(hi);
    for (const k of [',', '<']) expect(stepDXKey(lo, k, x0)).toBe(lo);
    // 端から内側へは動く
    expect(stepDXKey(hi, ',', x0)).toBe(hi - 100);
    expect(stepDXKey(lo, '.', x0)).toBe(lo + 100);
    // 範囲の外の値（% のステッパーの +100% = 33,912.34 円）から押しても逆向きにならない
    const pctMax = 1.0 * x0;
    expect(stepDXKey(pctMax, '.', x0)).toBe(pctMax);
    expect(stepDXKey(pctMax, ',', x0)).toBe(33_810);
    // 数値欄で入れた操作の範囲の外の値（−99% / +900%）からも逆向きにならない（#144 AC-3）
    for (const v of [-0.99 * x0, -0.95 * x0, 9 * x0, 2 * x0]) {
      for (const k of ['.', '>']) expect(stepDXKey(v, k, x0) as number).toBeGreaterThanOrEqual(v);
      for (const k of [',', '<']) expect(stepDXKey(v, k, x0) as number).toBeLessThanOrEqual(v);
    }
    expect(stepDXKey(-0.99 * x0, ',', x0)).toBe(-0.99 * x0);
    expect(stepDXKey(-0.99 * x0, '.', x0)).toBe(-30_520);
    expect(stepDXKey(9 * x0, '.', x0)).toBe(9 * x0);
    expect(stepDXKey(9 * x0, ',', x0)).toBe(33_910);
    // 押した向きと逆に動くことはない（多数の値）
    for (let v = lo - 50; v <= hi + 50; v += 37) {
      for (const k of ['.', '>']) expect(stepDXKey(v, k, x0) as number).toBeGreaterThanOrEqual(v);
      for (const k of [',', '<']) expect(stepDXKey(v, k, x0) as number).toBeLessThanOrEqual(v);
    }
  });

  it('キー: 他のキー（← / → / + / − / R など）は扱わない', () => {
    for (const k of [
      'ArrowLeft',
      'ArrowRight',
      '+',
      '-',
      '=',
      '−',
      'r',
      'R',
      'a',
      ' ',
      'toString',
      'constructor',
    ]) {
      expect(stepDXKey(0, k, x0)).toBeNull();
    }
  });
});

/** #144 AC-7: 読み込み・X₀ の変化で、数値欄の範囲（−99%〜min(+900%, 1e6 円)）の外の ΔX を端へ寄せる。 */
describe('clampDXInput（#144）', () => {
  const x0 = 33_912.34;

  it('範囲の中はそのまま（同じ値）。−40% の既存の値・% で入れた −99% の端数も動かない', () => {
    for (const v of [0, -0.4 * x0, 0.2 * x0, -0.99 * x0, 9 * x0, -30_520, 12_345.6]) {
      expect(clampDXInput(v, x0)).toBe(v);
    }
  });

  it('外は端へ: 下は −0.99X₀（X > 0 を保つ）、上は min(9X₀, 1e6)', () => {
    expect(clampDXInput(-x0, x0)).toBe(-0.99 * x0);
    expect(clampDXInput(-1e6, x0)).toBe(-0.99 * x0);
    expect(clampDXInput(10 * x0, x0)).toBe(9 * x0);
    expect(clampDXInput(1e6, 200_000)).toBe(1e6);
    expect(clampDXInput(1e6 + 1, 200_000)).toBe(1e6);
    // X₀ が下がって −40,000 円が −99% より下になった
    expect(clampDXInput(-40_000, x0)).toBe(-0.99 * x0);
    expect(x0 + clampDXInput(-40_000, x0)).toBeGreaterThan(0);
  });

  it('冪等。X₀ が無効なら dX をそのまま、非有限の dX は 0', () => {
    for (const v of [-1e6, -x0, 0, 5e5, 1e6]) {
      const once = clampDXInput(v, x0);
      expect(clampDXInput(once, x0)).toBe(once);
    }
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(clampDXInput(-50_000, bad)).toBe(-50_000);
    }
    expect(clampDXInput(Number.NaN, x0)).toBe(0);
    expect(clampDXInput(Number.POSITIVE_INFINITY, x0)).toBe(0);
    expect(clampDXInput(Number.NaN, Number.NaN)).toBe(0);
  });
});

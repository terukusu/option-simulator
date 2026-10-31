import { describe, expect, it } from 'vitest';
import { boardOptionLeg, type Chain, type ChainMonth, normalizeChain } from '../../data';
import type { AtmBasis, OptionType } from '../../model';
import { AI_EVAL_CASES, caseMargin, caseState } from '../../scripts/aiEvalCases';
import { buildChainJson, type ChainSpec, SPECS } from '../../scripts/synthBoard';
import { aiEnvFromState } from '../../ui/view/aiContext';
import { CANDIDATE_DELTAS, WING_PCT_DEFAULT } from '../../ui/view/aiPropose';
import { isToolError, runTool } from '../../ui/view/aiTools';
import { deltaAt } from '../../ui/view/strikePick';
import {
  SHAPE_FAIL_TEXT,
  SHAPE_IDS,
  SHAPES,
  type ShapeId,
  type ShapeLeg,
  type ShapeOpts,
  type ShapeResult,
  shapeLegs,
} from '../../ui/view/templates';
import { fixture } from '../support/fixtures';

/**
 * #20 戦略テンプレート（ui/view/templates.ts）の契約 (a)〜(f)。合成の板（fixtures/synthetic/・scripts/synthBoard.ts の
 * SPECS をずらした板。値は架空）。期待値は板の行・節点から独立に求める（実装の関数を写さない）。
 */

const chain = normalizeChain(fixture('latest'));
const [m1, m2] = chain.months as [ChainMonth, ChainMonth];
const BASIS: AtmBasis = 'B';
const DEF: ShapeOpts = { basis: BASIS, dist: { kind: 'sigma', value: 1 }, n: 0, wingPct: 3 };

const okLegs = (r: ShapeResult): ShapeLeg[] => {
  if (!r.ok) throw new Error(`組めない: ${r.reason}`);
  return r.legs;
};
const reason = (r: ShapeResult) => (r.ok ? 'ok' : r.reason);
const twoSided = (m: ChainMonth, type: OptionType, k: number) =>
  m.strikes.find((s) => s.k === k)?.[type].quote === 'two_sided';
const rowOf = (m: ChainMonth, k: number) => m.rows.find((r) => r.k === k);

/** 独立の参照: その側（put は K ≤ X₀、call は K ≥ X₀）の両気配の行で目標に最も近い行（同じ距離は OTM の遠い方） */
function refNearest(m: ChainMonth, type: OptionType, level: number, x0: number): number | null {
  const cands = m.strikes
    .filter((s) => s[type].quote === 'two_sided' && (type === 'put' ? s.k <= x0 : s.k >= x0))
    .map((s) => s.k)
    .sort((a, b) => {
      const d = Math.abs(a - level) - Math.abs(b - level);
      if (d !== 0) return d;
      return type === 'put' ? a - b : b - a;
    });
  return cands[0] ?? null;
}

describe('(a) AC9 / U1: 2 限月・1σ のストラングル売り', () => {
  const legs = okLegs(shapeLegs(chain, m2, 'short_strangle', DEF));
  const x0 = m2.atm[BASIS].reference.price as number;
  // σ_ATM,2 = ATM の行の OTM 側の節点の mid IV（板の節点から直接読む）
  const atmK = m2.atm[BASIS].pick?.k;
  const sig = m2.strikes.find((s) => s.k === atmK)?.node?.midIv as number;
  const dist = x0 * sig * Math.sqrt(m2.T);

  it('put 売り・call 売り 1 枚ずつ（2 限月）', () => {
    expect(legs.map((l) => [l.type, l.side, l.mul, l.expiry])).toEqual([
      ['put', 'sell', 1, m2.id],
      ['call', 'sell', 1, m2.id],
    ]);
    // 1σ の距離は数千円（架空の板で ATM IV ≈ 25%・58 日 → ≈ 6,900 円）
    expect(dist).toBeGreaterThan(4_000);
    expect(dist).toBeLessThan(9_000);
  });

  it('put の K = X₀ − X₀ × σ_ATM × √T、call の K = X₀ + … に最も近い両気配の行', () => {
    const [p, c] = legs as [ShapeLeg, ShapeLeg];
    expect(p.k).toBe(refNearest(m2, 'put', x0 - dist, x0));
    expect(c.k).toBe(refNearest(m2, 'call', x0 + dist, x0));
    expect(p.k).toBeLessThan(x0);
    expect(c.k).toBeGreaterThan(x0);
  });

  it('建値 = その行の bid（reducer と同じ boardOptionLeg）', () => {
    for (const l of legs) {
      const built = boardOptionLeg(chain, { expiry: l.expiry, k: l.k, type: l.type, side: l.side });
      expect(built.marks).not.toContain('no_quote');
      expect(built.leg.entry).toBe(rowOf(m2, l.k)?.[l.type].bid);
    }
  });

  it('倍率を上げると put の K は下がり call の K は上がる（非増加 / 非減少）', () => {
    let prev: [number, number] | null = null;
    for (let v = 0.25; v <= 3; v += 0.25) {
      const r = shapeLegs(chain, m2, 'short_strangle', {
        ...DEF,
        dist: { kind: 'sigma', value: v },
      });
      if (!r.ok) continue;
      const [p, c] = r.legs as [ShapeLeg, ShapeLeg];
      if (prev) {
        expect(p.k).toBeLessThanOrEqual(prev[0]);
        expect(c.k).toBeGreaterThanOrEqual(prev[1]);
      }
      prev = [p.k, c.k];
    }
    expect(prev).not.toBeNull();
  });

  it('円の距離: X₀ ∓ 円に最も近い両気配の行', () => {
    const r = okLegs(
      shapeLegs(chain, m2, 'long_strangle', { ...DEF, dist: { kind: 'yen', value: 3_000 } }),
    );
    expect(r.map((l) => [l.type, l.side])).toEqual([
      ['put', 'buy'],
      ['call', 'buy'],
    ]);
    expect(r[0]?.k).toBe(refNearest(m2, 'put', x0 - 3_000, x0));
    expect(r[1]?.k).toBe(refNearest(m2, 'call', x0 + 3_000, x0));
  });
});

describe('(b) U3: カレンダー（1 限月・ATM から 0 本）', () => {
  const legs = okLegs(shapeLegs(chain, m1, 'calendar', DEF));
  const k = m1.atm[BASIS].pick?.k as number;

  it('1 限月売り（bid）・2 限月買い（ask）、同じ K = 1 限月の ATM、種別はその行の OTM 側', () => {
    const type = m1.strikes.find((s) => s.k === k)?.otmType;
    expect(legs).toEqual([
      { type, k, side: 'sell', mul: 1, expiry: m1.id },
      { type, k, side: 'buy', mul: 1, expiry: m2.id },
    ]);
    const sell = boardOptionLeg(chain, {
      expiry: m1.id,
      k,
      type: type as OptionType,
      side: 'sell',
    });
    const buy = boardOptionLeg(chain, { expiry: m2.id, k, type: type as OptionType, side: 'buy' });
    expect(sell.leg.entry).toBe(rowOf(m1, k)?.[type as OptionType].bid);
    expect(buy.leg.entry).toBe(rowOf(m2, k)?.[type as OptionType].ask);
  });
});

describe('(c) 12 形が合成の板で組め、足の本数・売買・種別・K の大小が形の定義どおり', () => {
  it('形の表は 12 形（売り 6・買い 6）で ID は重ならない', () => {
    expect(SHAPES.map((s) => s.id)).toEqual([...SHAPE_IDS]);
    expect(SHAPES.filter((s) => s.group === 'sell')).toHaveLength(6);
    expect(SHAPES.filter((s) => s.group === 'buy')).toHaveLength(6);
    for (const s of SHAPES) {
      expect(s.points.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of s.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(32);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(16);
      }
    }
  });

  const SIG: Record<ShapeId, string> = {
    short_strangle: '売P 売C',
    short_straddle: '売P 売C',
    iron_condor: '買P 売P 売C 買C',
    bull_put: '売P 買P',
    bear_call: '売C 買C',
    put_ratio: '買P 売P×2',
    long_strangle: '買P 買C',
    long_straddle: '買P 買C',
    bull_call: '買C 売C',
    bear_put: '買P 売P',
    call_butterfly: '買C 売C×2 買C',
    calendar: '売C 買C',
  };
  const sig = (legs: ShapeLeg[]) =>
    legs
      .map(
        (l) =>
          `${l.side === 'sell' ? '売' : '買'}${l.type === 'put' ? 'P' : 'C'}${l.mul > 1 ? `×${l.mul}` : ''}`,
      )
      .join(' ');

  it.each(SHAPE_IDS)('%s: 既定の値（σ 1.0・ATM から 0 本・翼 3%）で組め、足は両気配の行', (id) => {
    for (const m of [m1, m2]) {
      if (id === 'calendar' && m === m2) continue;
      const legs = okLegs(shapeLegs(chain, m, id, DEF));
      const s = sig(legs);
      // カレンダーの種別は ATM の行の OTM 側（この板の 1 限月の ATM は F より上 = call）
      if (id === 'calendar') expect(s.replace(/P/g, 'C')).toBe(SIG[id]);
      else expect(s).toBe(SIG[id]);
      for (const l of legs) {
        const lm = chain.months.find((x) => x.id === l.expiry) as ChainMonth;
        expect(twoSided(lm, l.type, l.k)).toBe(true);
        expect(Number.isFinite(l.k)).toBe(true);
      }
    }
  });

  it('K の大小: コンドル 買P < 売P < 売C < 買C、バタフライ 下 < 中心 < 上、レシオ 買い > 売り、ストラングル put ≤ X₀ ≤ call', () => {
    for (const m of [m1, m2]) {
      const x0 = m.atm[BASIS].reference.price as number;
      const ks = (id: ShapeId) => okLegs(shapeLegs(chain, m, id, DEF)).map((l) => l.k);
      const [a, b, c, d] = ks('iron_condor') as [number, number, number, number];
      expect(a < b && b < c && c < d).toBe(true);
      const [lo, mid, hi] = ks('call_butterfly') as [number, number, number];
      expect(lo < mid && mid < hi).toBe(true);
      const [buy, sell] = ks('put_ratio') as [number, number];
      expect(buy).toBeGreaterThan(sell);
      for (const id of ['short_strangle', 'long_strangle'] as const) {
        const [p, cc] = ks(id) as [number, number];
        expect(p).toBeLessThanOrEqual(x0);
        expect(cc).toBeGreaterThanOrEqual(x0);
      }
      const [bp, bw] = ks('bull_put') as [number, number];
      expect(bw).toBeLessThan(bp);
      const [cs, cw] = ks('bear_call') as [number, number];
      expect(cw).toBeGreaterThan(cs);
      const [bc, bcw] = ks('bull_call') as [number, number];
      expect(bcw).toBeGreaterThan(bc);
      const [bpp, bpw] = ks('bear_put') as [number, number];
      expect(bpw).toBeLessThan(bpp);
    }
  });

  it('バタフライの両翼は左右対称（中心から同じ幅・両方とも両気配の call）。合成の板 3 種 × 限月 × A / B × 翼 1〜10%', () => {
    let n = 0;
    for (const name of ['latest', 'night_early', 'pre_open'] as const) {
      const c = normalizeChain(fixture(name));
      for (const m of c.months) {
        for (const basis of ['A', 'B'] as const) {
          for (let w = 1; w <= 10; w += 0.5) {
            for (const off of [-4, 0, 4]) {
              const r = shapeLegs(c, m, 'call_butterfly', { ...DEF, basis, wingPct: w, n: off });
              if (!r.ok) {
                expect(['no_wing', 'no_row', 'no_quote_call']).toContain(r.reason);
                continue;
              }
              const [lo, mid, hi] = r.legs as [ShapeLeg, ShapeLeg, ShapeLeg];
              expect(mid.k - lo.k).toBe(hi.k - mid.k);
              expect(twoSided(m, 'call', lo.k) && twoSided(m, 'call', hi.k)).toBe(true);
              n++;
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('バタフライの翼の幅は K × 翼% に最も近い対称の幅（独立に総当たりで求めた幅と同じ）', () => {
    for (const w of [1, 3, 7.5, 10]) {
      const legs = okLegs(shapeLegs(chain, m1, 'call_butterfly', { ...DEF, wingPct: w }));
      const k = legs[1]?.k as number;
      const calls = m1.strikes.filter((s) => s.call.quote === 'two_sided').map((s) => s.k);
      const widths = calls
        .filter((x) => x > k && calls.includes(2 * k - x))
        .map((x) => x - k)
        .sort((a, b) => Math.abs(a - (k * w) / 100) - Math.abs(b - (k * w) / 100) || a - b);
      expect((legs[2]?.k as number) - k).toBe(widths[0]);
    }
  });

  it('バタフライ: 対称の組が無い（片側の call の気配を消した板）→ no_wing（非対称では組まない）', () => {
    const json = fixture('latest');
    const mj = json.months[0];
    if (!mj) throw new Error('1 限月が要る');
    const k = m1.atm[BASIS].pick?.k as number;
    // 中心より下の call の気配を全部消す（上の翼の鏡が無い）
    for (const r of mj.rows) {
      if (r.k < k) {
        r.call.bid = null;
        r.call.ask = null;
      }
    }
    const c = normalizeChain(json);
    const m = c.months[0] as ChainMonth;
    expect(m.atm[BASIS].pick?.k).toBe(k);
    expect(reason(shapeLegs(c, m, 'call_butterfly', DEF))).toBe('no_wing');
  });

  it('put レシオ（σ / 円）: 売りの行の Δ が求まらない（スマイルの IV 無し）→ no_delta（順序の理由にしない）', () => {
    const sell = okLegs(shapeLegs(chain, m2, 'put_ratio', DEF))[1]?.k as number;
    const noIv: ChainMonth = {
      ...m2,
      strikes: m2.strikes.map((s) => (s.k === sell ? { ...s, smileIv: null } : s)),
    };
    expect(reason(shapeLegs(chain, noIv, 'put_ratio', DEF))).toBe('no_delta');
    // Δ の距離は目標の |Δ| + 0.15 なので売りの行の Δ に依らない（AI と同じ）
    expect(
      reason(shapeLegs(chain, noIv, 'put_ratio', { ...DEF, dist: { kind: 'delta', value: 0.15 } })),
    ).not.toBe('no_delta');
  });

  it('put レシオ（σ）: 買いの |Δ| ≈ 売りの |Δ| + 0.15（最も近い行）', () => {
    const [buy, sell] = okLegs(shapeLegs(chain, m2, 'put_ratio', DEF)) as [ShapeLeg, ShapeLeg];
    const ds = Math.abs(deltaAt(chain, m2, sell.k, 'put'));
    const db = Math.abs(deltaAt(chain, m2, buy.k, 'put'));
    expect(Math.abs(db - (ds + 0.15))).toBeLessThan(0.02);
  });

  it('ATM から n 本: ストラドルの K が板の行で n 本ずれる', () => {
    const ks = m2.rows.map((r) => r.k);
    const atm = m2.atm[BASIS].pick?.k as number;
    for (const n of [-2, -1, 1, 3]) {
      const legs = okLegs(shapeLegs(chain, m2, 'long_straddle', { ...DEF, n }));
      expect(legs[0]?.k).toBe(ks[ks.indexOf(atm) + n]);
    }
    expect(reason(shapeLegs(chain, m2, 'long_straddle', { ...DEF, n: 10_000 }))).toBe('no_row');
  });
});

describe('(d) 組めない理由（例外を投げない・NaN を返さない）', () => {
  it('次の限月が無いカレンダー（2 限月を選ぶ）→ no_next_month', () => {
    expect(reason(shapeLegs(chain, m2, 'calendar', DEF))).toBe('no_next_month');
  });

  it('put の OTM 側の気配が無い板 → put の足の形は no_quote_put（call だけの形は組める）', () => {
    const json = fixture('latest');
    const mj = json.months[1];
    if (!mj) throw new Error('2 限月が要る');
    for (const r of mj.rows) {
      if (r.k < m2.F) {
        r.put.bid = null;
        r.put.ask = null;
      }
    }
    const c = normalizeChain(json);
    const m = c.months[1] as ChainMonth;
    // ATM の行（F の下 = put 側）の節点も消えるので距離は円で（σ は no_atm_iv = 下の it）
    const yen: ShapeOpts = { ...DEF, dist: { kind: 'yen', value: 3_000 } };
    expect(reason(shapeLegs(c, m, 'short_strangle', yen))).toBe('no_quote_put');
    expect(reason(shapeLegs(c, m, 'bull_put', yen))).toBe('no_quote_put');
    expect(reason(shapeLegs(c, m, 'iron_condor', yen))).toBe('no_quote_put');
    expect(reason(shapeLegs(c, m, 'bear_call', yen))).toBe('ok');
    expect(reason(shapeLegs(c, m, 'short_strangle', DEF))).toBe('no_atm_iv');
  });

  it('F・スマイルの無い限月 → no_forward', () => {
    const noF: ChainMonth = { ...m2, F: Number.NaN, smile: null };
    const c: Chain = { ...chain, months: [m1, noF] };
    for (const id of SHAPE_IDS) expect(reason(shapeLegs(c, noF, id, DEF))).toBe('no_forward');
    // 1 限月のカレンダーは次の限月（F なし）を買えない
    expect(reason(shapeLegs(c, m1, 'calendar', DEF))).toBe('no_next_month');
  });

  it('ATM の行の気配が無い板（夜間・寄り前の少ない行数の板を模す）: σ は no_atm_iv、Δ・円は組める', () => {
    const night = SPECS.find((s) => s.name === 'night_early') as ChainSpec;
    // ATM（K/F ≈ 1）の行の気配を消す
    const spec: ChainSpec = {
      ...night,
      months: night.months.map((m) => ({ ...m, dropAt: [...(m.dropAt ?? []), 1] })),
    };
    const c = normalizeChain(buildChainJson(spec));
    const m = c.months[1] as ChainMonth;
    const atmK = m.atm[BASIS].pick?.k as number;
    expect(twoSided(m, 'put', atmK) || twoSided(m, 'call', atmK)).toBe(false);
    expect(reason(shapeLegs(c, m, 'short_strangle', DEF))).toBe('no_atm_iv');
    for (const kind of ['delta', 'yen'] as const) {
      const value = kind === 'delta' ? 0.15 : 3_000;
      expect(reason(shapeLegs(c, m, 'short_strangle', { ...DEF, dist: { kind, value } }))).toBe(
        'ok',
      );
    }
    // ATM の形は ATM の行が両気配でないので組めない
    expect(reason(shapeLegs(c, m, 'short_straddle', DEF))).toBe('no_quote_put');
  });

  it('T ≤ 0 の σ → no_time、範囲の外の入力 → bad_input', () => {
    const past: ChainMonth = { ...m2, T: 0 };
    expect(reason(shapeLegs(chain, past, 'short_strangle', DEF))).toBe('no_time');
    expect(
      reason(shapeLegs(chain, m2, 'short_strangle', { ...DEF, dist: { kind: 'sigma', value: 0 } })),
    ).toBe('bad_input');
    expect(
      reason(shapeLegs(chain, m2, 'short_strangle', { ...DEF, dist: { kind: 'delta', value: 1 } })),
    ).toBe('bad_input');
    expect(reason(shapeLegs(chain, m2, 'iron_condor', { ...DEF, wingPct: Number.NaN }))).toBe(
      'bad_input',
    );
    expect(reason(shapeLegs(chain, m2, 'long_straddle', { ...DEF, n: 0.5 }))).toBe('bad_input');
  });

  it('理由ごとに文がある', () => {
    for (const t of Object.values(SHAPE_FAIL_TEXT)) expect(t.length).toBeGreaterThan(4);
  });
});

describe('(e) AC20: テンプレートの ATM = m.atm[basis].pick.k（基準価格 3 通り × A / B）', () => {
  const latest = SPECS.find((s) => s.name === 'latest') as ChainSpec;
  const shifted = (dF: number, dFuture: number): ChainSpec => ({
    ...latest,
    future: { ...latest.future, price: (latest.future.price as number) + dFuture },
    months: latest.months.map((m) => ({ ...m, F: m.F + dF })),
  });
  const CASES: Array<[string, ChainSpec]> = [
    ['そのまま', latest],
    ['F +190・先物 −260', shifted(190, -260)],
    ['F −440・先物 +330', shifted(-440, 330)],
  ];
  describe.each(CASES)('%s', (_name, spec) => {
    const c = normalizeChain(buildChainJson(spec));
    it.each<AtmBasis>(['A', 'B'])('基準 %s', (basis) => {
      const o: ShapeOpts = { ...DEF, basis };
      for (const m of c.months) {
        const atm = m.atm[basis].pick?.k;
        expect(atm).toBeDefined();
        for (const id of ['short_straddle', 'long_straddle', 'bull_call', 'bear_put'] as const) {
          expect(okLegs(shapeLegs(c, m, id, o))[0]?.k).toBe(atm);
        }
        expect(okLegs(shapeLegs(c, m, 'call_butterfly', o))[1]?.k).toBe(atm);
        if (m === c.months[0]) {
          const cal = okLegs(shapeLegs(c, m, 'calendar', o));
          expect(cal.map((l) => l.k)).toEqual([atm, atm]);
        }
      }
    });
  });
});

describe('(f) Δ の距離の 6 形 = AI の structure_candidates の候補の足（同じ限月・|Δ|）', () => {
  const ai = AI_EVAL_CASES.find((x) => x.name === 'strangle_sell');
  if (!ai) throw new Error('strangle_sell');
  const st = caseState(fixture('latest'), ai);
  const env = aiEnvFromState(st, caseMargin(ai));
  if (!env) throw new Error('env');
  const AI6 = [
    'short_strangle',
    'short_straddle',
    'iron_condor',
    'bull_put',
    'bear_call',
    'put_ratio',
  ] as const;

  it.each(AI6)('%s', (id) => {
    for (const m of env.chain.months) {
      const r = runTool('structure_candidates', { structure: id, expiry: m.id }, env);
      if (isToolError(r)) throw new Error(String(r.error));
      // biome-ignore lint/suspicious/noExplicitAny: 結果の JSON を添字で読む
      const cands = (r as any).candidates as { legs: Record<string, unknown>[] }[];
      const atmK = m.atm[env.atmBasis].pick?.k ?? null;
      const deltas = id === 'short_straddle' ? [0.5] : CANDIDATE_DELTAS;
      const seen = new Set<string>();
      const want: string[] = [];
      for (const d of deltas) {
        const s = shapeLegs(env.chain, m, id, {
          basis: env.atmBasis,
          dist: { kind: 'delta', value: d },
          n: 0,
          wingPct: WING_PCT_DEFAULT,
          atmK,
        });
        if (!s.ok) continue;
        const key = s.legs
          .map((l) => `${l.side}${l.type === 'put' ? 'P' : 'C'}${l.k}×${l.mul}`)
          .join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        want.push(key);
      }
      const got = cands.map((c) =>
        c.legs.map((l) => `${l.side}${l.type}${l.k}×${l.qty}`).join(' '),
      );
      expect(got).toEqual(want);
      expect(got.length).toBeGreaterThan(0);
    }
  });
});

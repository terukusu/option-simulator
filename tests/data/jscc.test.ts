/**
 * #382 AC6: JSCC の VaR パラメータの応答の検証・要求の銘柄・基準日・分けて読む（data/jscc.ts・adapter の
 * loadJsccScenarios）。値はすべて架空。
 */

import { describe, expect, it } from 'vitest';
import {
  ChainLoadError,
  JSCC_MAX_KEYS,
  JSCC_MAX_PERIODS,
  jsccBaseDate,
  jsccChunks,
  jsccFactorChunks,
  jsccFactorPeriods,
  jsccFactorsUrl,
  jsccRequestKeys,
  jsccUrl,
  loadJsccFactors,
  loadJsccScenarios,
  mergeJsccFactors,
  mergeJsccResponses,
  tradingDayOf,
  validateJsccFactorsJson,
  validateJsccJson,
} from '../../data';
import type { Leg } from '../../model';
import { jstInstant } from '../../model/time';

const HOL = new Set(['2026-11-23']); // 架空の休業日（月曜）
const D = '2026-11-20';
const KP = 'NK225E-202612-P-45000';
const KF = 'NK225MCF-202612';
const TYPES = 'HHHHS';

function okJson(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    status: 'ok',
    business_date: D,
    confidence_level: 97.5,
    stress_scenario_number: 1,
    scenario_types: TYPES,
    instruments: [
      {
        key: KP,
        aggregation_group: 'IDX_IDX',
        contract_size: 1000,
        price: 120,
        pnl: [1, 2, 3, 4, 5],
      },
    ],
    missing: [KF],
    ...over,
  };
}

describe('基準日', () => {
  it('日中は当日が取引日、17:00 以降・休業日は次の営業日。基準日はその前営業日', () => {
    // 金曜の日中 → 取引日 金曜、基準日 木曜
    expect(tradingDayOf(jstInstant('2026-11-20', 10, 0), HOL)).toBe('2026-11-20');
    expect(jsccBaseDate(jstInstant('2026-11-20', 10, 0), HOL)).toBe('2026-11-19');
    // 金曜の 16:59 はまだ金曜
    expect(jsccBaseDate(jstInstant('2026-11-20', 16, 59), HOL)).toBe('2026-11-19');
    // 金曜の夜間（17:00〜）→ 取引日は月曜（休業日）を飛ばして火曜、基準日は金曜
    expect(tradingDayOf(jstInstant('2026-11-20', 17, 0), HOL)).toBe('2026-11-24');
    expect(jsccBaseDate(jstInstant('2026-11-20', 21, 0), HOL)).toBe('2026-11-20');
    // 土曜の未明（夜間の続き）・日曜・休業日 → 次の営業日（火曜）、基準日 金曜
    expect(jsccBaseDate(jstInstant('2026-11-21', 3, 0), HOL)).toBe('2026-11-20');
    expect(jsccBaseDate(jstInstant('2026-11-23', 12, 0), HOL)).toBe('2026-11-20');
    // 火曜の未明（月曜の夜間の続き = 月曜は休業日なので金曜の夜間からの続き）
    expect(jsccBaseDate(jstInstant('2026-11-24', 3, 0), HOL)).toBe('2026-11-20');
    expect(jsccBaseDate(jstInstant('2026-11-24', 9, 0), HOL)).toBe('2026-11-20');
    expect(jsccBaseDate(jstInstant('2026-11-24', 17, 30), HOL)).toBe('2026-11-24');
  });

  it('データの始まり（2026-11-16）より前・非有限は null', () => {
    expect(jsccBaseDate(jstInstant('2026-11-16', 10, 0), HOL)).toBeNull();
    expect(jsccBaseDate(jstInstant('2026-11-16', 18, 0), HOL)).toBe('2026-11-16');
    expect(jsccBaseDate(Number.NaN, HOL)).toBeNull();
  });
});

describe('要求の銘柄', () => {
  const op = (expiry: string, strike: number, type: 'call' | 'put' = 'put'): Leg => ({
    kind: 'option',
    product: 'op_large',
    type,
    expiry,
    strike,
    side: 'sell',
    qty: 1,
    entry: 100,
  });
  it('重複なし・昇順、基準日の月より前の限月・キーにできない足は入れない', () => {
    const legs: Leg[] = [
      op('2026-12', 45000),
      op('2026-12', 45000),
      op('2026-11', 49000),
      op('2027-01', 47000, 'call'),
      op('M1', 45000),
      { kind: 'future', product: 'fut_micro', contract: '2026-12', side: 'sell', qty: 3, entry: 1 },
    ];
    expect(jsccRequestKeys(legs, '2026-12-01')).toEqual([
      'NK225E-202612-P-45000',
      'NK225E-202701-C-47000',
      'NK225MCF-202612',
    ]);
    expect(jsccRequestKeys(legs, '2026-11-20')).toContain('NK225E-202611-P-49000');
  });

  it('上限（銘柄 64・限月 4）で分ける。限月をまたいで分けても全部の銘柄が入る', () => {
    const keys = [
      ...Array.from({ length: 70 }, (_, i) => `NK225E-202612-P-${40000 + i * 125}`),
      'NK225E-202701-P-40000',
      'NK225E-202702-P-40000',
      'NK225E-202703-P-40000',
      'NK225E-202706-P-40000',
      'NK225E-202709-P-40000',
    ].sort();
    const chunks = jsccChunks(keys);
    expect(chunks.flat().sort()).toEqual(keys);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(JSCC_MAX_KEYS);
      expect(new Set(c.map((k) => k.split('-')[1])).size).toBeLessThanOrEqual(JSCC_MAX_PERIODS);
    }
    expect(jsccChunks([KP])).toEqual([[KP]]);
  });

  it('URL: date と i を繰り返す（キーは URL に入れる文字だけ）', () => {
    expect(jsccUrl('/api/jscc_scenarios', D, [KF, KP])).toBe(
      `/api/jscc_scenarios?date=${D}&i=${KF}&i=${KP}`,
    );
  });
});

describe('応答の検証', () => {
  it('ok: JsccData（並び・パラメータ・銘柄）と missing', () => {
    const r = validateJsccJson(okJson(), D, [KP, KF]);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.status !== 'ok') return;
    expect(r.value.data.businessDate).toBe(D);
    expect(r.value.data.set).toEqual({
      isHist: [true, true, true, true, false],
      confidence: 97.5,
      nStress: 1,
    });
    const inst = r.value.data.instruments.get(KP);
    expect(inst?.contractSize).toBe(1000);
    expect(Array.from(inst?.pnl ?? [])).toEqual([1, 2, 3, 4, 5]);
    expect(r.value.missing).toEqual([KF]);
  });

  it('unavailable: not_ready / inconsistent → not_ready、no_source', () => {
    for (const [reason, want] of [
      ['not_ready', 'not_ready'],
      ['inconsistent', 'not_ready'],
      ['no_source', 'no_source'],
    ] as const) {
      const r = validateJsccJson(
        { schema_version: 1, status: 'unavailable', reason, business_date: D },
        D,
        [KP],
      );
      expect(r).toEqual({ ok: true, value: { status: 'unavailable', reason: want } });
    }
  });

  it.each([
    ['版', { schema_version: 2 }],
    ['日付が要求と違う', { business_date: '2026-11-19' }],
    ['信頼水準', { confidence_level: 100 }],
    ['並び', { scenario_types: 'HHXHS' }],
    ['H が無い', { scenario_types: 'SSSSS', stress_scenario_number: 1 }],
    ['ストレスの本数 > S', { stress_scenario_number: 2 }],
    [
      '要求していない銘柄',
      {
        instruments: [
          {
            key: 'NK225E-202612-C-45000',
            aggregation_group: 'IDX_IDX',
            contract_size: 1000,
            price: 1,
            pnl: [1, 2, 3, 4, 5],
          },
        ],
      },
    ],
    [
      'pnl の長さ',
      {
        instruments: [
          { key: KP, aggregation_group: 'IDX_IDX', contract_size: 1000, price: 1, pnl: [1, 2] },
        ],
      },
    ],
    [
      'pnl が整数でない',
      {
        instruments: [
          {
            key: KP,
            aggregation_group: 'IDX_IDX',
            contract_size: 1000,
            price: 1,
            pnl: [1, 2, 3, 4, 5.5],
          },
        ],
      },
    ],
    ['missing に行のある銘柄', { missing: [KP] }],
    ['status', { status: 'maybe' }],
  ])('壊れた応答は ok = false（%s）', (_name, over) => {
    expect(validateJsccJson(okJson(over), D, [KP, KF]).ok).toBe(false);
  });

  it('分けた応答をまとめる（並び・パラメータが違えば null、どれかが unavailable ならそれ）', () => {
    const a = validateJsccJson(okJson(), D, [KP, KF]);
    const b = validateJsccJson(
      okJson({
        instruments: [
          {
            key: 'NK225E-202703-P-45000',
            aggregation_group: 'IDX_IDX',
            contract_size: 1000,
            price: 5,
            pnl: [0, 0, 0, 0, 0],
          },
        ],
        missing: [],
      }),
      D,
      ['NK225E-202703-P-45000'],
    );
    if (!a.ok || !b.ok) throw new Error('検証に通らない');
    const m = mergeJsccResponses([a.value, b.value]);
    expect(m?.status).toBe('ok');
    if (m?.status === 'ok')
      expect([...m.data.instruments.keys()].sort()).toEqual([KP, 'NK225E-202703-P-45000']);
    const c = validateJsccJson(okJson({ stress_scenario_number: 0 }), D, [KP, KF]);
    if (!c.ok) throw new Error('検証に通らない');
    expect(mergeJsccResponses([a.value, c.value])).toBeNull();
    expect(mergeJsccResponses([a.value, { status: 'unavailable', reason: 'not_ready' }])).toEqual({
      status: 'unavailable',
      reason: 'not_ready',
    });
    expect(mergeJsccResponses([])).toBeNull();
  });
});

describe('loadJsccScenarios', () => {
  const fetchOf = (body: unknown, status = 200) => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    };
    return { f, urls };
  };

  it('読んで検証する（既定の読み先は /api/jscc_scenarios）', async () => {
    const { f, urls } = fetchOf(okJson());
    const r = await loadJsccScenarios(D, [KF, KP], { fetch: f });
    expect(r.status).toBe('ok');
    expect(urls).toEqual([`/api/jscc_scenarios?date=${D}&i=${KF}&i=${KP}`]);
  });

  it('HTTP の失敗・壊れた JSON は ChainLoadError（本文を入れない）', async () => {
    await expect(loadJsccScenarios(D, [KP], { fetch: fetchOf({}, 503).f })).rejects.toBeInstanceOf(
      ChainLoadError,
    );
    await expect(
      loadJsccScenarios(D, [KP], { fetch: fetchOf({ schema_version: 1 }).f }),
    ).rejects.toBeInstanceOf(ChainLoadError);
  });
});

describe('dev の合成の応答（scripts/devFixtures.mjs）', () => {
  it('合成の板 latest の基準日だけ ok で検証に通り、ほかの日は not_ready、形の違う要求は null', async () => {
    const { SYNTH_JSCC_DATE, jsccQuery, synthJscc } = await import('../../scripts/devFixtures.mjs');
    const keys = [
      'NK225E-202611-P-60000',
      'NK225E-202612-C-70000',
      'NK225MF-202612',
      'NK225E-202609-P-60000',
    ];
    const r = validateJsccJson(synthJscc(SYNTH_JSCC_DATE, keys), SYNTH_JSCC_DATE, keys);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.status !== 'ok') return;
    expect(r.value.data.set.isHist.length).toBe(1422);
    expect(r.value.data.instruments.size).toBe(3);
    expect(r.value.missing).toEqual(['NK225E-202609-P-60000']);
    const nr = validateJsccJson(synthJscc('2026-10-14', keys), '2026-10-14', keys);
    expect(nr).toEqual({ ok: true, value: { status: 'unavailable', reason: 'not_ready' } });
    expect(jsccQuery(`/fixtures/jscc_scenarios?date=${SYNTH_JSCC_DATE}&i=NK225F-202612`)).toEqual({
      date: SYNTH_JSCC_DATE,
      keys: ['NK225F-202612'],
    });
    expect(jsccQuery('/fixtures/jscc_scenarios?date=2026-10-13&i=bad')).toBeNull();
    // 合成の板 latest の時刻の基準日 = SYNTH_JSCC_DATE（dev は下限を見ない）
    expect(jsccBaseDate(jstInstant('2026-10-13', 21, 31), new Set(), null)).toBe(SYNTH_JSCC_DATE);
  });
});

describe('#387 当て直しの r・g の応答（validateJsccFactorsJson・loadJsccFactors）', () => {
  const NODES = [-5, -4, -3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3];
  const n = TYPES.length;
  const factorsJson = (over: Record<string, unknown> = {}) => ({
    schema_version: 1,
    status: 'ok',
    business_date: D,
    requested_date: D,
    confidence_level: 97.5,
    stress_scenario_number: 1,
    scenario_types: TYPES,
    nodes: NODES,
    scale: { r: 1_000_000, g: 10_000 },
    rows: [
      {
        key: 'NK225E-202612',
        r: [10000, -20000, 0, 5, -80000],
        g: Array(13 * n).fill(1500),
        check_median_rel: 0.002,
        check_p90_rel: 0.15,
        forward: 41234.5,
      },
      {
        key: 'NK225F-202703',
        r: [1, 2, 3, 4, 5],
        g: null,
        check_median_rel: null,
        check_p90_rel: null,
      },
    ],
    missing: ['202706'],
    ...over,
  });
  const P = ['202612', '202703', '202706'];

  it('ok は整数を刻みで割った r・g（g の無い行は null）、missing はそのまま', () => {
    const r = validateJsccFactorsJson(factorsJson(), D, P);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.status !== 'ok') return;
    const row = r.value.data.rows.get('NK225E-202612');
    expect(Array.from(row?.r ?? [])).toEqual([0.01, -0.02, 0, 0.000005, -0.08]);
    expect(row?.g?.[0]).toBeCloseTo(0.15, 12);
    expect(r.value.data.rows.get('NK225F-202703')?.g).toBeNull();
    expect(row?.checkMedianRel).toBe(0.002);
    expect(row?.checkP90Rel).toBe(0.15);
    expect(r.value.data.rows.get('NK225F-202703')?.checkMedianRel).toBeNull();
    // 基準日の F（#395）: ある行は値、無い行（forward を返す前の応答 = 古いキャッシュ）は null
    expect(row?.forward).toBe(41234.5);
    expect(r.value.data.rows.get('NK225F-202703')?.forward).toBeNull();
    expect(r.value.data.set).toEqual({
      isHist: [true, true, true, true, false],
      confidence: 97.5,
      nStress: 1,
    });
    expect(r.value.missing).toEqual(['202706']);
    expect(r.value.data.nodes).toEqual(NODES);
  });

  it.each([
    ['刻みが違う', { scale: { r: 1000, g: 10_000 } }],
    ['節点が 12 個', { nodes: NODES.slice(1) }],
    ['節点が昇順でない', { nodes: [...NODES.slice(0, 12), 2] }],
    ['要求していない限月の行', { rows: [{ key: 'NK225E-202709', r: [0, 0, 0, 0, 0], g: null }] }],
    ['r の長さ', { rows: [{ key: 'NK225E-202612', r: [0, 0], g: null }] }],
    ['r の範囲', { rows: [{ key: 'NK225E-202612', r: [2_000_000, 0, 0, 0, 0], g: null }] }],
    ['g の長さ', { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: [1] }] }],
    [
      'g が整数でない',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: Array(13 * n).fill(0.5) }] },
    ],
    [
      '質が負',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, check_median_rel: -0.1 }] },
    ],
    [
      '質が文字列',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, check_p90_rel: 'x' }] },
    ],
    [
      '基準日の F が0',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, forward: 0 }] },
    ],
    [
      '基準日の F が負',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, forward: -1 }] },
    ],
    [
      '基準日の F が文字列',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, forward: 'x' }] },
    ],
    [
      '基準日の F が真偽値',
      { rows: [{ key: 'NK225E-202612', r: [0, 0, 0, 0, 0], g: null, forward: true }] },
    ],
    ['週次の行', { rows: [{ key: 'NK225W1-202612', r: [0, 0, 0, 0, 0], g: null }] }],
    ['重複', { rows: [factorsJson().rows[0], factorsJson().rows[0]] }],
    ['使った日が基準日より後', { business_date: '2026-11-21' }],
    ['使った日が遡る範囲より前', { business_date: '2026-10-29' }],
    ['要求の基準日が違う', { requested_date: '2026-11-19' }],
    ['missing が要求していない限月', { missing: ['202901'] }],
  ])('不正: %s', (_name, over) => {
    expect(validateJsccFactorsJson(factorsJson(over), D, P).ok).toBe(false);
  });

  it('遡った日（基準日より前の直近の使える日。#387）は business_date がその日', () => {
    const r = validateJsccFactorsJson(factorsJson({ business_date: '2026-11-13' }), D, P);
    expect(r.ok && r.value.status === 'ok' && r.value.data.businessDate).toBe('2026-11-13');
  });

  it('unavailable は理由（inconsistent は not_ready と同じ、no_recent はそのまま）', () => {
    for (const [reason, want] of [
      ['not_ready', 'not_ready'],
      ['inconsistent', 'not_ready'],
      ['no_source', 'no_source'],
      ['no_recent', 'no_recent'],
    ] as const) {
      const r = validateJsccFactorsJson(
        { schema_version: 1, status: 'unavailable', reason, business_date: D },
        D,
        P,
      );
      expect(r).toEqual({ ok: true, value: { status: 'unavailable', reason: want } });
    }
  });

  it('要求する限月: 足の OP の限月と先物の限月（基準日の月より前は入れない・昇順・重複なし）', () => {
    const legs = [
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2027-03',
        strike: 1,
        side: 'sell',
        qty: 1,
        entry: 1,
      },
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2026-12',
        strike: 1,
        side: 'sell',
        qty: 1,
        entry: 1,
      },
      { kind: 'future', product: 'fut_micro', contract: '2026-12', side: 'buy', qty: 1, entry: 1 },
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2026-10',
        strike: 1,
        side: 'sell',
        qty: 1,
        entry: 1,
      },
      {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: 'M1',
        strike: 1,
        side: 'sell',
        qty: 1,
        entry: 1,
      },
    ] as Leg[];
    expect(jsccFactorPeriods(legs, D, HOL)).toEqual(['202612', '202703']);
    // B1: 基準日の月で SQ を過ぎた限月（2026-11 の SQ = 11/13 ≤ 基準日 11/20）は入れない。SQ 当日も入れない（保守的に）
    const nov: Leg = { ...(legs[1] as Leg), expiry: '2026-11' } as Leg;
    expect(jsccFactorPeriods([nov, ...legs], D, HOL)).toEqual(['202612', '202703']);
    expect(jsccFactorPeriods([nov], '2026-11-12', HOL)).toEqual(['202611']);
    expect(jsccFactorPeriods([nov], '2026-11-13', HOL)).toEqual([]);
    const many = Array.from(
      { length: 26 },
      (_, i) => `${2027 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`,
    );
    expect(jsccFactorChunks(many).map((c) => c.length)).toEqual([24, 2]);
    expect(jsccFactorsUrl('/api/jscc_factors', D, ['202612', '202703'])).toBe(
      `/api/jscc_factors?date=${D}&p=202612&p=202703`,
    );
  });

  it('読み込み（既定の読み先・分けて読んで 1 つに・壊れた応答は ChainLoadError）', async () => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(factorsJson({ rows: [], missing: [] })),
      };
    };
    const r = await loadJsccFactors(D, ['202612'], { fetch: f });
    expect(r.status).toBe('ok');
    expect(urls).toEqual([`/api/jscc_factors?date=${D}&p=202612`]);
    const bad = async () => ({ ok: true, status: 200, text: async () => '{"schema_version":1}' });
    await expect(loadJsccFactors(D, ['202612'], { fetch: bad })).rejects.toBeInstanceOf(
      ChainLoadError,
    );
    const ok = mergeJsccFactors([]);
    expect(ok).toBeNull();
    // N3: 限月が上限を超えて分けて読むときは、2 回目以降を 1 回目の日（at）にそろえる
    const many = Array.from(
      { length: 26 },
      (_, i) => `${2027 + Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, '0')}`,
    );
    const urls2: string[] = [];
    const f2 = async (url: string) => {
      urls2.push(url);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(factorsJson({ business_date: '2026-11-19', rows: [], missing: [] })),
      };
    };
    const r2 = await loadJsccFactors(D, many, { fetch: f2 });
    expect(r2.status === 'ok' && r2.data.businessDate).toBe('2026-11-19');
    expect(urls2).toHaveLength(2);
    expect(urls2[0]).not.toContain('at=');
    expect(urls2[1]).toContain('&at=2026-11-19');
  });

  it('dev の合成の応答: latest の基準日は検証に通り、r = ln(1 + 変化率)・g は節点で同じ（平行）、後の日は遡る・前の日は no_recent', async () => {
    const { SYNTH_JSCC_DATE, jsccFactorQuery, synthJsccFactors } = await import(
      '../../scripts/devFixtures.mjs'
    );
    const periods = ['202609', '202611', '202612'];
    const r = validateJsccFactorsJson(
      synthJsccFactors(SYNTH_JSCC_DATE, periods),
      SYNTH_JSCC_DATE,
      periods,
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.status !== 'ok') return;
    expect(r.value.data.set.isHist.length).toBe(1422);
    expect([...r.value.data.rows.keys()].sort()).toEqual([
      'NK225E-202611',
      'NK225E-202612',
      'NK225F-202612',
    ]);
    expect(r.value.missing).toEqual(['202609']);
    const g = r.value.data.rows.get('NK225E-202611')?.g as Float64Array;
    expect(g[13 * 5]).toBe(g[13 * 5 + 12]);
    expect(
      validateJsccFactorsJson(synthJsccFactors('2026-10-12', periods), '2026-10-12', periods),
    ).toEqual({ ok: true, value: { status: 'unavailable', reason: 'no_recent' } });
    // 基準日より後の要求は latest の日に遡る（#387）
    const back = validateJsccFactorsJson(
      synthJsccFactors('2026-10-16', periods),
      '2026-10-16',
      periods,
    );
    expect(back.ok && back.value.status === 'ok' && back.value.data.businessDate).toBe(
      SYNTH_JSCC_DATE,
    );
    expect(jsccFactorQuery(`/fixtures/jscc_factors?date=${SYNTH_JSCC_DATE}&p=202612`)).toEqual({
      date: SYNTH_JSCC_DATE,
      periods: ['202612'],
    });
    expect(jsccFactorQuery('/fixtures/jscc_factors?date=2026-10-13&p=2026-12')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { type Chain, normalizeChain } from '../../data';
import { ZERO_SCENARIO } from '../../model';
import {
  BOARD_KEY,
  bootState,
  isNewerBoard,
  isNewerWorkspace,
  MAX_SAVED_LEGS,
  migrate,
  persistKey,
  type ReadResult,
  readSavedBoard,
  readWorkspace,
  readWorkspaceValue,
  restoreState,
  savedFromWorkspace,
  savedVersion,
  serializeBoard,
  serializeWorkspace,
  storageChange,
  toSaved,
  WORKSPACE_KEY,
  WORKSPACE_SCHEMA_VERSION,
  type Workspace,
} from '../../ui/persist';
import { type Action, initialState, reduce, type State, type UiLeg } from '../../ui/state';
import { fixture, rawFixture } from '../support/fixtures';
import v1 from './saved/workspace-v1.json';

const NOW = Date.parse('2026-11-02T12:47:00.000Z');

function run(state: State, ...actions: Action[]): State {
  return actions.reduce(reduce, state);
}

function ok(r: ReadResult): { saved: Workspace; dropped: boolean } {
  if (r.kind !== 'ok') throw new Error(`読めない: ${r.kind}`);
  return r;
}

/** 書き換え用の緩い形（壊れた入力を作る） */
type Rec = Record<string, unknown>;
interface RawLeg extends Rec {
  leg: Rec;
}
interface RawV1 extends Rec {
  position: Rec & { legs: RawLeg[]; scenario: Rec };
  ui: Rec & { pnl_y: Rec; hedge: Rec };
}

/** i 番目の足（無ければ例外） */
function L(o: RawV1, i: number): RawLeg {
  const l = o.position.legs[i];
  if (!l) throw new Error(`足 ${i} が無い`);
  return l;
}

/** v1 の fixture を書き換えたもの（壊れた入力を作る） */
function v1With(edit: (o: RawV1) => void): string {
  const o = structuredClone(v1) as unknown as RawV1;
  edit(o);
  return JSON.stringify(o);
}

const stripId = (legs: readonly UiLeg[]) => legs.map(({ id: _id, ...rest }) => rest);

/** AC2: v1 の fixture（tests/ui/saved/workspace-v1.json。一度書いたら変えない）の後方互換。 */
describe('版 1 の保存の読み取り（後方互換の固定）', () => {
  it('v1 の fixture を読むと期待の State になる', () => {
    const { saved, dropped } = ok(readWorkspace(JSON.stringify(v1)));
    expect(dropped).toBe(false);
    expect(saved.savedAt).toBe(NOW);
    expect(saved.position?.boardSnapshotAt).toBe(Date.parse('2026-11-02T21:31:00+09:00'));
    const s = restoreState(initialState, saved);
    expect(s.legs).toEqual([
      {
        id: 1,
        leg: {
          kind: 'option',
          product: 'op_large',
          type: 'put',
          expiry: '2026-11',
          strike: 64000,
          side: 'sell',
          qty: 2,
          entry: 810,
          mid: 815,
        },
        marks: ['interpolated'],
      },
      {
        id: 2,
        leg: {
          kind: 'option',
          product: 'op_large',
          type: 'call',
          expiry: '2027-01',
          strike: 70000,
          side: 'buy',
          qty: 1,
          entry: 500,
          iv: 0.25,
          mid: null,
        },
        marks: ['no_board', 'forward_from_future'],
        optionMarket: {
          expiry: '2027-01',
          market: { sqTime: 1799999000000, forward: Number.NaN, smile: null },
        },
      },
      {
        id: 3,
        leg: {
          kind: 'future',
          product: 'fut_mini',
          contract: '2026-12',
          side: 'buy',
          qty: 3,
          entry: 67880,
        },
        marks: [],
        futureMarket: { contract: '2026-12', market: { sqTime: 1797000000000, price: 67880 } },
      },
    ]);
    expect(s.nextId).toBe(4);
    expect(s.scenario).toEqual({
      days: 2.5,
      dX: -1200,
      dSigma: 3,
      skew: 0.5,
      beta: 1.2,
      ivDynamics: 'sticky_moneyness',
      ivShift: 'relative',
    });
    expect({
      atmBasis: s.atmBasis,
      monthId: s.monthId,
      target: s.target,
      filterAsk: s.filterAsk,
      smileAxis: s.smileAxis,
      feePerLot: s.feePerLot,
      futureBasis: s.futureBasis,
      metricsUnit: s.metricsUnit,
      pnlY: s.pnlY,
      pnlFolded: s.pnlFolded,
      hedge: s.hedge,
    }).toEqual({
      atmBasis: 'A',
      monthId: '2026-12',
      target: 'call',
      filterAsk: true,
      smileAxis: 'delta',
      feePerLot: 300,
      futureBasis: 'decay',
      metricsUnit: 'thousand',
      pnlY: { mode: 'premium', manual: [-50000, 80000], n: 3 },
      pnlFolded: true,
      hedge: { target: 1, at: 'scenario', contract: '2027-03' },
    });
    // 板・読み込み・表示の一時的な状態は保存しない
    expect(s.chain).toBeNull();
    expect(s.boardStale).toBe(false);
    expect(s.smileViewport).toBeNull();
    expect(s.pnlViewport).toBeNull();
  });

  it('復元した state に板を読むと、限月・ヘッジの限月を板に合わせ、足の市場を今の板から作る', () => {
    const chain = normalizeChain(fixture('latest'));
    const restored = bootState(readWorkspace(JSON.stringify(v1)));
    const s = reduce(restored, { type: 'loaded', chain, label: 'API', fetchedAt: NOW });
    expect(s.monthId).toBe('2026-12'); // 板にある
    expect(s.hedge.contract).toBeNull(); // 2027-03 は選択肢に無い
    expect(s.hedge.target).toBe(1);
    // 手入力の足の F（保存は null = NaN）は今の板の先物価格、先物の足は板の先物
    expect(s.legs[1]?.optionMarket?.market.forward).toBe(chain.future.price);
    expect(s.legs[2]?.futureMarket?.market.price).toBe(chain.future.price);
    // 建値・枚数・売買・IV は保存した値のまま
    expect(s.legs.map((l) => l.leg)).toEqual(restored.legs.map((l) => l.leg));

    // 限月が板に無ければ先頭の限月
    const other = bootState(readWorkspace(v1With((o) => (o.ui.month_id = '2027-06'))));
    expect(reduce(other, { type: 'loaded', chain, label: 'API' }).monthId).toBe(
      chain.months[0]?.id,
    );
  });
});

describe('書き出しと往復', () => {
  const chain = normalizeChain(fixture('latest'));
  const month = chain.months[0];
  const k = month?.rows[Math.floor((month?.rows.length ?? 0) / 2)]?.k ?? 0;

  function worked(): State {
    return run(
      reduce(initialState, { type: 'loaded', chain, label: 'API' }),
      { type: 'addBoardLeg', expiry: month?.id ?? '', k, optionType: 'put', side: 'sell' },
      {
        type: 'addManualLeg',
        input: {
          product: 'op_large',
          expiry: '2027-01',
          type: 'call',
          k: 70000,
          side: 'buy',
          entry: 500,
          iv: 0.25,
        },
      },
      {
        type: 'addFutureLeg',
        input: { product: 'fut_micro', contract: '2027-03', side: 'sell', qty: 4 },
      },
      { type: 'editLeg', id: 1, patch: { iv: 0.215, qty: 2, entry: 812.5 } },
      {
        type: 'setScenario',
        patch: { days: 3, dX: 500, dSigma: -2, skew: 1, beta: 0.5, ivShift: 'relative' },
      },
      { type: 'setFee', fee: 250 },
      { type: 'setFutureBasis', basis: 'decay' },
      { type: 'setMetricsUnit', unit: 'yen' },
      { type: 'setPnlY', patch: { mode: 'manual', manual: [-1000, 2000], n: 7 } },
      { type: 'setPnlFolded', folded: true },
      { type: 'setHedge', patch: { target: -2, at: 'scenario', contract: '2026-12' } },
      { type: 'setBasis', basis: 'A' },
      { type: 'setTarget', target: 'call' },
      { type: 'setAxis', axis: 'moneyness' },
      { type: 'setFilterAsk', on: true },
      { type: 'setMonth', monthId: '2026-12' },
    );
  }

  it('往復: 足（id 以外）・シナリオ・設定が一致し、板の時刻・保存の時刻が入る', () => {
    const s = worked();
    const text = serializeWorkspace(s, NOW);
    const { saved } = ok(readWorkspace(text));
    expect(saved.savedAt).toBe(NOW);
    expect(saved.position?.boardSnapshotAt).toBe(chain.snapshotAt);
    const r = restoreState(initialState, saved);
    expect(stripId(r.legs)).toEqual(stripId(s.legs));
    expect(r.legs.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(r.scenario).toEqual(s.scenario);
    expect(persistKey(r)).toBe(persistKey(s));
    const saved1 = toSaved(s, NOW);
    expect(saved1.schema_version).toBe(WORKSPACE_SCHEMA_VERSION);
    // id は書かない
    expect(text).not.toMatch(/"id"/);
  });

  it('NaN の F（先物価格の無い板の手入力の足）は null で書き、NaN に戻す', () => {
    const leg: UiLeg = {
      id: 5,
      leg: {
        kind: 'option',
        product: 'op_large',
        type: 'put',
        expiry: '2027-02',
        strike: 60000,
        side: 'buy',
        qty: 1,
        entry: 100,
        iv: 0.3,
        mid: null,
      },
      marks: ['no_board', 'forward_from_future'],
      optionMarket: {
        expiry: '2027-02',
        market: { sqTime: 1800000000000, forward: Number.NaN, smile: null },
      },
    };
    const s = { ...initialState, legs: [leg], nextId: 6 };
    const text = serializeWorkspace(s, NOW);
    expect(text).toContain('"forward":null');
    const r = restoreState(initialState, ok(readWorkspace(text)).saved);
    expect(r.legs[0]?.optionMarket?.market.forward).toBeNaN();
    expect(stripId(r.legs)).toEqual(stripId(s.legs));
  });

  it('persistKey: 足の市場・印・板が変わっても同じ。足の入力・シナリオ・設定が変われば変わる', () => {
    const s = worked();
    const k0 = persistKey(s);
    const reloaded = reduce(s, {
      type: 'loaded',
      chain: normalizeChain(fixture('night_early')),
      label: 'API',
    });
    expect(reloaded.legs[2]?.futureMarket?.market.price).not.toBe(
      s.legs[2]?.futureMarket?.market.price,
    );
    expect(persistKey(reloaded)).toBe(k0);
    expect(persistKey(reduce(s, { type: 'editLeg', id: 2, patch: { qty: 9 } }))).not.toBe(k0);
    expect(persistKey(reduce(s, { type: 'setDays', days: 1 }))).not.toBe(k0);
    expect(persistKey(reduce(s, { type: 'setFee', fee: 0 }))).not.toBe(k0);
  });

  it('板が無いときは板の時刻を null で書く', () => {
    expect(toSaved(initialState, NOW).position.board_snapshot_at).toBeNull();
  });
});

describe('新しい版の保存の保護（開いたあと・別のタブ・書く直前）', () => {
  const v2 = JSON.stringify({ schema_version: WORKSPACE_SCHEMA_VERSION + 1, saved_at: 'x' });

  it('savedVersion: 版の整数だけを取り出す（中身は検証しない）', () => {
    expect(savedVersion(serializeWorkspace(initialState, 0))).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(savedVersion(v2)).toBe(WORKSPACE_SCHEMA_VERSION + 1);
    for (const text of [
      null,
      '{',
      '[]',
      'null',
      '{}',
      '{"schema_version":"2"}',
      '{"schema_version":2.5}',
    ]) {
      expect(savedVersion(text), String(text)).toBeNull();
    }
    // 継承したキーは読まない
    expect(savedVersion('{"__proto__":{"schema_version":9}}')).toBeNull();
  });

  it('isNewerWorkspace: 今の版より大きいときだけ true（同じ版・古い版・壊れた・無いは false）', () => {
    expect(isNewerWorkspace(v2)).toBe(true);
    expect(isNewerWorkspace(serializeWorkspace(initialState, 0))).toBe(false);
    expect(isNewerWorkspace('{"schema_version":0}')).toBe(false);
    expect(isNewerWorkspace('{')).toBe(false);
    expect(isNewerWorkspace(null)).toBe(false);
  });

  it('storageChange: 別のタブが新しい版で保存したら newer（このタブは書かない）、同じ版は otherTab', () => {
    expect(storageChange(WORKSPACE_KEY, v2)).toBe('newer');
    expect(storageChange(WORKSPACE_KEY, serializeWorkspace(initialState, 0))).toBe('otherTab');
    // 消された・壊れた値は知らせるだけ（後勝ち）
    expect(storageChange(WORKSPACE_KEY, null)).toBe('otherTab');
    expect(storageChange(WORKSPACE_KEY, '{')).toBe('otherTab');
    // 作業以外のキー・clear()（key = null）は何もしない
    expect(storageChange(BOARD_KEY, v2)).toBe('none');
    expect(storageChange(null, null)).toBe('none');
    expect(storageChange('other', v2)).toBe('none');
  });

  it('isNewerBoard: 新しい版の板は読めなくても消さない判定', () => {
    expect(isNewerBoard('{"schema_version":2,"chain":{}}')).toBe(true);
    expect(isNewerBoard('{"schema_version":1}')).toBe(false);
    expect(isNewerBoard('{')).toBe(false);
  });
});

describe('検証（壊れた・他の版・余計なキー・範囲外）', () => {
  it('無い → empty、JSON でない・配列・版が無い / 文字列 / 小数 → invalid', () => {
    expect(readWorkspace(null)).toEqual({ kind: 'empty' });
    for (const text of [
      '{',
      '',
      'null',
      '[]',
      '"x"',
      '1',
      '{}',
      '{"schema_version":"1"}',
      '{"schema_version":1.5}',
    ]) {
      expect(readWorkspace(text).kind, text).toBe('invalid');
    }
  });

  it('新しい版は newer（読まない）、知らない古い版（0）は invalid', () => {
    expect(readWorkspace(v1With((o) => Object.assign(o, { schema_version: 2 })))).toEqual({
      kind: 'newer',
      version: 2,
    });
    expect(readWorkspace(v1With((o) => Object.assign(o, { schema_version: 0 }))).kind).toBe(
      'invalid',
    );
    expect(migrate({}, 0)).toBeNull();
    expect(migrate({ a: 1 }, 1)).toEqual({ a: 1 });
  });

  it('余計なキー・__proto__ は写さず、Object.prototype を汚さない', () => {
    const text = JSON.stringify(v1)
      .replace(
        '"schema_version":1',
        '"schema_version":1,"__proto__":{"polluted":1},"extra":{"x":1}',
      )
      .replace('"strike":64000', '"strike":64000,"__proto__":{"polluted":2},"evil":"<b>x</b>"')
      .replace('"atm_basis":"A"', '"atm_basis":"A","__proto__":{"polluted":3}');
    const { saved } = ok(readWorkspace(text));
    const s = restoreState(initialState, saved);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(s.legs[0]?.leg ?? {}).sort()).toEqual(
      ['entry', 'expiry', 'kind', 'mid', 'product', 'side', 'strike', 'qty', 'type'].sort(),
    );
    expect(Object.getPrototypeOf(s.legs[0]?.leg)).toBe(Object.prototype);
    expect(s).not.toHaveProperty('extra');
    expect(s).not.toHaveProperty('polluted');
  });

  it.each([
    ['qty 0', (o: RawV1) => (L(o, 0).leg.qty = 0)],
    ['qty 1.5', (o: RawV1) => (L(o, 0).leg.qty = 1.5)],
    ['qty 100,001', (o: RawV1) => (L(o, 0).leg.qty = 100_001)],
    ['entry −1', (o: RawV1) => (L(o, 0).leg.entry = -1)],
    ['entry 1e9 + 1（入力の上限と同じ）', (o: RawV1) => (L(o, 0).leg.entry = 1e9 + 1)],
    ['iv 0', (o: RawV1) => (L(o, 1).leg.iv = 0)],
    ['iv 11', (o: RawV1) => (L(o, 1).leg.iv = 11)],
    ['strike 0', (o: RawV1) => (L(o, 0).leg.strike = 0)],
    ['expiry 2026-13', (o: RawV1) => (L(o, 0).leg.expiry = '2026-13')],
    ['side hold', (o: RawV1) => (L(o, 0).leg.side = 'hold')],
    ['product op_mini', (o: RawV1) => (L(o, 0).leg.product = 'op_mini')],
    ['kind 不明', (o: RawV1) => (L(o, 0).leg.kind = 'swap')],
    ['先物の product', (o: RawV1) => (L(o, 2).leg.product = 'op_large')],
    ['先物の市場が無い', (o: RawV1) => delete L(o, 2).future_market],
    ['手入力の足の市場が無い', (o: RawV1) => delete L(o, 1).option_market],
    ['F が負', (o: RawV1) => (L(o, 1).option_market = { sq_time: 1, forward: -1 })],
    ['SQ 時刻が小数', (o: RawV1) => (L(o, 2).future_market = { sq_time: 1.5, price: 1 })],
    ['marks が配列でない', (o: RawV1) => (L(o, 0).marks = 'x')],
    ['scenario.dSigma 41', (o: RawV1) => (o.position.scenario.dSigma = 41)],
    ['scenario.days −1', (o: RawV1) => (o.position.scenario.days = -1)],
    ['scenario の項目が欠ける', (o: RawV1) => delete o.position.scenario.beta],
    ['scenario.ivShift 不明', (o: RawV1) => (o.position.scenario.ivShift = 'log')],
    ['legs が配列でない', (o: RawV1) => ((o.position as Rec).legs = {})],
  ])('足・シナリオが 1 つでも不正なら position ごと捨てる（%s）。設定は残す', (_name, edit) => {
    const { saved, dropped } = ok(readWorkspace(v1With((o) => edit(o))));
    expect(dropped).toBe(true);
    expect(saved.position).toBeNull();
    const s = restoreState(initialState, saved);
    expect(s.legs).toEqual([]);
    expect(s.scenario).toEqual(ZERO_SCENARIO);
    expect(s.feePerLot).toBe(300);
  });

  it('建値の上限 1e9 ちょうどは読める（入力 parseEntry と同じ範囲）', () => {
    const { saved, dropped } = ok(readWorkspace(v1With((o) => (L(o, 0).leg.entry = 1e9))));
    expect(dropped).toBe(false);
    expect(saved.position?.legs[0]?.leg.entry).toBe(1e9);
  });

  it('限月が板に入った手入力の足（「板なし」が無い）も足の市場を持てる（F の null は NaN）', () => {
    const { saved, dropped } = ok(
      readWorkspace(
        v1With((o) => {
          L(o, 1).marks = [];
          L(o, 1).option_market = { sq_time: 1794528000000, forward: null };
        }),
      ),
    );
    expect(dropped).toBe(false);
    expect(saved.position?.legs[1]?.marks).toEqual([]);
    expect(saved.position?.legs[1]?.optionMarket?.market.forward).toBeNaN();
  });

  it(`足が ${MAX_SAVED_LEGS} 本を超えたら position ごと捨てる`, () => {
    const leg = v1.position.legs[2];
    const many = v1With((o) => {
      (o.position as Rec).legs = Array.from({ length: MAX_SAVED_LEGS + 1 }, () => leg);
    });
    expect(ok(readWorkspace(many)).dropped).toBe(true);
    const max = v1With((o) => {
      (o.position as Rec).legs = Array.from({ length: MAX_SAVED_LEGS }, () => leg);
    });
    expect(ok(readWorkspace(max)).saved.position?.legs).toHaveLength(MAX_SAVED_LEGS);
  });

  it('未知の印・重複は捨てる（足は捨てない）', () => {
    const { saved } = ok(
      readWorkspace(
        v1With((o) => {
          L(o, 0).marks = ['interpolated', 'mystery', 'interpolated', 'toString'];
        }),
      ),
    );
    expect(saved.position?.legs[0]?.marks).toEqual(['interpolated']);
  });

  it.each([
    [
      'fee_per_lot 100,001',
      (o: RawV1) => {
        o.ui.fee_per_lot = 100_001;
      },
      'feePerLot',
      0,
    ],
    [
      'pnl_y.n 0',
      (o: RawV1) => {
        o.ui.pnl_y.n = 0;
      },
      'pnlY',
      { mode: 'premium', manual: [-50000, 80000], n: 5 },
    ],
    [
      'pnl_y.manual [5, 1]',
      (o: RawV1) => {
        o.ui.pnl_y.manual = [5, 1];
      },
      'pnlY',
      { mode: 'premium', manual: null, n: 3 },
    ],
    [
      'hedge.target 1,001',
      (o: RawV1) => {
        o.ui.hedge.target = 1001;
      },
      'hedge',
      { target: 0, at: 'scenario', contract: '2027-03' },
    ],
    [
      'hedge.contract 2027-3',
      (o: RawV1) => {
        o.ui.hedge.contract = '2027-3';
      },
      'hedge',
      { target: 1, at: 'scenario', contract: null },
    ],
    [
      'atm_basis C',
      (o: RawV1) => {
        o.ui.atm_basis = 'C';
      },
      'atmBasis',
      'B',
    ],
    [
      'month_id 文字列でない',
      (o: RawV1) => {
        o.ui.month_id = 202612;
      },
      'monthId',
      null,
    ],
    [
      'filter_ask 文字列',
      (o: RawV1) => {
        o.ui.filter_ask = 'true';
      },
      'filterAsk',
      false,
    ],
    [
      'smile_axis 不明',
      (o: RawV1) => {
        o.ui.smile_axis = 'iv';
      },
      'smileAxis',
      'k',
    ],
    [
      'future_basis 不明',
      (o: RawV1) => {
        o.ui.future_basis = 'x';
      },
      'futureBasis',
      'fixed',
    ],
    [
      'metrics_unit 不明',
      (o: RawV1) => {
        o.ui.metrics_unit = 'man';
      },
      'metricsUnit',
      'auto',
    ],
  ] as const)('設定の 1 項目が不正ならその項目だけ既定（%s）', (_name, edit, key, expected) => {
    const { saved, dropped } = ok(readWorkspace(v1With((o) => edit(o))));
    expect(dropped).toBe(false);
    const s = restoreState(initialState, saved);
    expect(s[key]).toEqual(expected);
    expect(s.legs).toHaveLength(3);
    // ほかの項目は保存した値
    if (key !== 'feePerLot') expect(s.feePerLot).toBe(300);
    expect(s.pnlFolded).toBe(true);
  });

  it('ui が丸ごと無い・壊れていれば全て既定、保存の時刻が読めなければ null', () => {
    const { saved } = ok(
      readWorkspace(
        v1With((o) => {
          (o as { ui: unknown }).ui = [1];
          o.saved_at = 'yesterday';
        }),
      ),
    );
    expect(saved.savedAt).toBeNull();
    const s = restoreState(initialState, saved);
    expect(s.feePerLot).toBe(0);
    expect(s.hedge).toEqual(initialState.hedge);
    expect(s.legs).toHaveLength(3);
  });

  it('bootState: 読めなければ初期状態', () => {
    expect(bootState({ kind: 'empty' })).toBe(initialState);
    expect(bootState({ kind: 'invalid' })).toBe(initialState);
    expect(bootState({ kind: 'newer', version: 9 })).toBe(initialState);
  });
});

describe('最後に取れた板の保存', () => {
  const json = fixture('latest');
  const chain: Chain = normalizeChain(json);
  const FETCHED = Date.parse('2026-10-13T12:47:00.000Z');

  it('書いて読むと板・取得時刻・データ元が戻る', () => {
    const back = readSavedBoard(serializeBoard(json, FETCHED, 'API'));
    expect(back?.fetchedAt).toBe(FETCHED);
    expect(back?.label).toBe('API');
    expect(back?.chain.snapshotAt).toBe(chain.snapshotAt);
    expect(back?.chain.months.map((m) => [m.id, m.rows.length])).toEqual(
      chain.months.map((m) => [m.id, m.rows.length]),
    );
    expect(back?.chain.future).toEqual(chain.future);
  });

  it('壊れた・版の違う・板の JSON が不正なら null', () => {
    const good = JSON.parse(serializeBoard(json, FETCHED, 'API')) as Record<string, unknown>;
    expect(readSavedBoard(null)).toBeNull();
    expect(readSavedBoard('{')).toBeNull();
    expect(readSavedBoard(JSON.stringify({ ...good, schema_version: 2 }))).toBeNull();
    expect(readSavedBoard(JSON.stringify({ ...good, fetched_at: 'x' }))).toBeNull();
    expect(readSavedBoard(JSON.stringify({ ...good, label: 'x'.repeat(65) }))).toBeNull();
    const bad = rawFixture('latest');
    bad.schema_version = 2;
    expect(readSavedBoard(JSON.stringify({ ...good, chain: bad }))).toBeNull();
    const broken = rawFixture('latest');
    delete broken.months;
    expect(readSavedBoard(JSON.stringify({ ...good, chain: broken }))).toBeNull();
  });
});

describe('作業の値の検証の切り出し（#70 readWorkspaceValue・savedFromWorkspace）', () => {
  it('readWorkspace と同じ結果（JSON.parse の後を共有する）', () => {
    for (const text of [JSON.stringify(v1), '[]', '{"schema_version":9}', '{"schema_version":1}']) {
      expect(readWorkspaceValue(JSON.parse(text))).toEqual(readWorkspace(text));
    }
    expect(readWorkspaceValue(null)).toEqual({ kind: 'invalid' });
  });

  it('検証済みの作業を保存の形に戻すと、同じ作業に読める（余計なキーを写さない）', () => {
    const { saved } = ok(readWorkspace(JSON.stringify({ ...v1, extra: '<x>' })));
    const back = savedFromWorkspace(saved, 0);
    expect(Object.keys(back)).toEqual(['schema_version', 'saved_at', 'position', 'ui']);
    expect(ok(readWorkspaceValue(back)).saved).toEqual(saved);
    expect(back.position.board_snapshot_at).toBe('2026-11-02T12:31:00.000Z');
    expect(savedFromWorkspace({ ...saved, savedAt: null }, NOW).saved_at).toBe(
      new Date(NOW).toISOString(),
    );
  });
});

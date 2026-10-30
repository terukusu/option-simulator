import { describe, expect, it } from 'vitest';
import {
  boardOptionLeg,
  boardOptionLegOnly,
  type Chain,
  futureLeg,
  manualOptionLeg,
} from '../../data';
import { DEFAULT_SETTINGS, evaluatePosition, ZERO_SCENARIO } from '../../model';
import {
  addEntry,
  EMPTY_BOOK,
  exportBook,
  importIntoBook,
  readBook,
  serializeBook,
} from '../../ui/book';
import { CALENDAR } from '../../ui/calendar';
import { rebaseLegs } from '../../ui/legRebase';
import {
  persistKey,
  readPositionDoc,
  readWorkspace,
  restoreWorkspace,
  savedLeg,
  serializeWorkspace,
  toSaved,
} from '../../ui/persist';
import { DEFAULT_MARGIN_PREFS } from '../../ui/prefs';
import { encodeShareUrl, readShareHash } from '../../ui/share';
import { type Action, initialState, reduce, type State, type UiLeg } from '../../ui/state';
import { aiEnvFromState } from '../../ui/view/aiContext';
import { planProposal } from '../../ui/view/aiPropose';
import { hedgeModel } from '../../ui/view/hedge';
import { pnlDomains } from '../../ui/view/pnlChart';
import { positionModel } from '../../ui/view/position';
import {
  clearUndo,
  heldMarkText,
  legDetail,
  openedText,
  rebasePlan,
  removeUndo,
} from '../../ui/view/positionsRegion';
import { boardsT0AndLater } from '../support/laterChain';

/**
 * #299 建てた日時（足ごと。板のスナップショット時刻）: 操作ごとの付け方（AC12）・建て直し（AC13）・保存の往復（AC14・
 * AC16）・足の詳細（AC18）。合成の板 t₀（latest）と t₀ + 3 日（架空の値）。
 */

const { t0, later } = boardsT0AndLater();
const holidays = initialState.calendar.holidays;
const T0 = t0.snapshotAt;
const T3 = later.snapshotAt;
const NOW = Date.parse('2026-10-16T13:00:00.000Z');

const run = (s: State, ...acts: Action[]) => acts.reduce(reduce, s);
const load = (s: State, c: Chain) => reduce(s, { type: 'loaded', chain: c, label: 'x' });
const sellPut64: Action = {
  type: 'addBoardLeg',
  expiry: '2026-11',
  k: 64000,
  optionType: 'put',
  side: 'sell',
};
const buyCall70: Action = {
  type: 'addBoardLeg',
  expiry: '2026-12',
  k: 70000,
  optionType: 'call',
  side: 'buy',
};
const manualInput = {
  product: 'op_large' as const,
  expiry: '2027-03',
  type: 'put' as const,
  k: 60000,
  side: 'sell' as const,
  entry: 300,
  iv: 0.3,
};

/** t₀ で 板の OP 2 本・先物 1 本・手入力の OP 1 本を入れ、t₀ + 3 日の板を読んだ state */
function heldState(): State {
  return load(
    run(
      load(initialState, t0),
      sellPut64,
      buyCall70,
      { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
      { type: 'addManualLeg', input: manualInput },
    ),
    later,
  );
}
const openedOf = (s: State) => s.legs.map((l) => l.leg.openedAt);

describe('AC12: 足を作る所（data/legs.ts の builder）が今の板の時刻を付ける', () => {
  it('板の足・印なしの足・先物の足・手入力の足（板あり）は板の時刻、板なしの手入力の足は持たない', () => {
    const input = { expiry: '2026-11', k: 64000, type: 'put' as const, side: 'sell' as const };
    expect(boardOptionLeg(t0, input).leg.openedAt).toBe(T0);
    expect(boardOptionLegOnly(later, input).openedAt).toBe(T3);
    expect(futureLeg(t0, { side: 'buy' }, holidays).leg.openedAt).toBe(T0);
    expect(
      futureLeg(t0, { contract: '2026-11', side: 'buy', entry: 67000 }, holidays).leg.openedAt,
    ).toBe(T0);
    expect(manualOptionLeg(t0, manualInput, holidays).leg.openedAt).toBe(T0);
    expect(manualOptionLeg(t0, { ...manualInput, expiry: '2026-11' }, holidays).leg.openedAt).toBe(
      T0,
    );
    expect('openedAt' in manualOptionLeg(null, manualInput, holidays).leg).toBe(false);
  });
});

describe('AC12: 操作ごとの建てた日時（やること 1 の表）', () => {
  it('板・先物・手入力（板あり）の足を入れる → 今の板の時刻', () => {
    const s = run(
      load(initialState, later),
      sellPut64,
      { type: 'addFutureLeg', input: { side: 'buy', qty: 1 } },
      { type: 'addManualLeg', input: manualInput },
    );
    expect(openedOf(s)).toEqual([T3, T3, T3]);
  });

  it('板が無いときに手入力の足を入れる → 持たない', () => {
    const s = reduce(initialState, { type: 'addManualLeg', input: manualInput });
    expect(s.legs).toHaveLength(1);
    expect(s.legs[0]?.leg.openedAt).toBeUndefined();
  });

  it('足マーカーで K を変える（changeLegStrike）→ 今の板の時刻', () => {
    const s = reduce(heldState(), { type: 'changeLegStrike', id: 1, k: 63000 });
    expect(openedOf(s)).toEqual([T3, T0, T0, T0]);
  });

  it('枚数・売買・建値・IV の編集 → 保つ', () => {
    const s = run(
      heldState(),
      { type: 'editLeg', id: 1, patch: { qty: 3 } },
      { type: 'editLeg', id: 2, patch: { side: 'sell' } },
      { type: 'editLeg', id: 3, patch: { entry: 66000 } },
      { type: 'editLeg', id: 1, patch: { iv: 0.31 } },
      { type: 'editLeg', id: 4, patch: { iv: null } },
    );
    expect(openedOf(s)).toEqual([T0, T0, T0, T0]);
  });

  it('足の削除の [元に戻す]・全クリアの [元に戻す] → 押す前の値に戻る', () => {
    const s = heldState();
    const model = positionModel(later, s.legs, 'B', CALENDAR);
    const row = model.rows[1];
    if (!row) throw new Error('行が無い');
    const u = removeUndo(s, row);
    if (!u) throw new Error('戻せない');
    const back = run(reduce(s, { type: 'removeLeg', id: row.id }), ...u.undo);
    expect(back.legs).toEqual(s.legs);
    const c = clearUndo(s);
    if (!c) throw new Error('戻せない');
    const back2 = run(reduce(s, { type: 'clearLegs' }), ...c.undo);
    expect(openedOf(back2)).toEqual([T0, T0, T0, T0]);
    expect(back2.legs).toEqual(s.legs);
  });

  it('replaceLegs（AI の提案の適用・#298 の [元に戻す]）→ 渡した足のまま', () => {
    const s = heldState();
    const r = rebaseLegs(later, s.legs, holidays);
    const applied = reduce(s, {
      type: 'replaceLegs',
      legs: r.legs,
      expect: s.legs,
      tab: s.activeTab,
    });
    const undone = reduce(applied, {
      type: 'replaceLegs',
      legs: s.legs,
      expect: r.legs,
      tab: s.activeTab,
    });
    expect(openedOf(undone)).toEqual([T0, T0, T0, T0]);
  });

  it('タブの複製・保存一覧から開く → 保つ', () => {
    const s = heldState();
    const copied = reduce(s, { type: 'addTab', mode: 'copy' });
    expect(openedOf(copied)).toEqual([T0, T0, T0, T0]);
    const opened = reduce(load(initialState, later), {
      type: 'openPosition',
      legs: s.legs.map(({ id: _id, ...rest }) => rest),
      scenario: null,
      feePerLot: null,
      futureBasis: null,
    });
    expect(openedOf(opened)).toEqual([T0, T0, T0, T0]);
  });

  it('AI の提案（current）: 変えない足・枚数の変更は保つ、行使価格の変更・追加は今の板の時刻', () => {
    const s = heldState();
    const env = aiEnvFromState(s, DEFAULT_MARGIN_PREFS);
    if (!env) throw new Error('環境が無い');
    const plan = planProposal(env, {
      target: 'current',
      changes: [
        { action: 'move_strike', leg_no: 1, k: 63500 },
        { action: 'set_qty', leg_no: 2, qty: 2 },
        { action: 'add', type: 'P', expiry: '2026-11', k: 60000, side: 'buy', qty: 1 },
      ],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.legs.map((l) => l.leg.openedAt)).toEqual([T3, T0, T0, T0, T3]);
  });

  it('ヘッジの [追加]（先物の足）→ 今の板の時刻', () => {
    const s = heldState();
    const settings = { ...DEFAULT_SETTINGS };
    const pm = positionModel(later, s.legs, 'B', CALENDAR, settings);
    const h = hedgeModel({
      chain: later,
      base: pnlDomains(later, pm.prepared, pm.ctx, settings),
      ctx: pm.ctx,
      settings,
      scenario: s.scenario,
      hedge: { ...s.hedge, target: -3 },
      holidays,
    });
    const line = h.lines.find((l) => l.input !== null);
    if (!line?.input) throw new Error('ヘッジの足が無い');
    const after = reduce(s, { type: 'addFutureLeg', input: line.input });
    expect(after.legs.at(-1)?.leg.openedAt).toBe(T3);
  });
});

describe('AC13: #298 の建て直し（建値が同じでも建てた日時を今に）', () => {
  /** t₀ で入れた足の建値を t₀ + 3 日の板の bid / ask にした state（建値は今の板と同じ・建てた日時は t₀） */
  function sameEntryHeld(): State {
    const s = heldState();
    const r = rebaseLegs(later, s.legs, holidays);
    const legs: UiLeg[] = r.legs.map((l, i) => ({
      ...l,
      leg: { ...l.leg, openedAt: s.legs[i]?.leg.openedAt as number },
    }));
    return reduce(s, { type: 'replaceLegs', legs, expect: s.legs, tab: s.activeTab });
  }

  it('建値が同じ前の板の足: 建てた日時が今の板の時刻、reopened、シナリオ 0 の損益が 0 に戻る、シナリオは変わらない', () => {
    const s = run(sameEntryHeld(), { type: 'setScenario', patch: { days: 2, dX: -500 } });
    const pnl0 = (st: State) => {
      const m = positionModel(later, st.legs, 'B', CALENDAR);
      return evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx).pnl;
    };
    // 前の板の足: 建値 = 今の bid / ask、評価 = mid なのでスプレッドの半分だけ 0 でない
    expect(Math.abs(pnl0(s))).toBeGreaterThan(1);
    const r = rebaseLegs(later, s.legs, holidays);
    expect(r.changed).toBe(0);
    // 手入力の足（板に無い限月）は据え置き = 保つ
    expect(r.kept).toBe(1);
    expect(r.reopened).toBe(3);
    expect(r.legs.map((l) => l.leg.openedAt)).toEqual([T3, T3, T3, T0]);
    const plan = rebasePlan(s);
    if (!plan?.apply || !plan.undo) throw new Error('建て直せない');
    expect(plan.kind).toBe('leg-rebase');
    expect(plan.text).toBe('建てた日時を今に 3 本・据え置き 1 本');
    const applied = reduce(s, plan.apply);
    expect(applied.scenario).toEqual(s.scenario);
    const m = positionModel(later, applied.legs, 'B', CALENDAR);
    // 板の足（OP・先物）は 0 に戻る。手入力の足は IV を手で入れた足のまま（建値ずれ）
    const ev = evaluatePosition(m.prepared, ZERO_SCENARIO, m.ctx);
    expect(ev.legs.slice(0, 3).every((e) => Math.abs(e.pnl) < 1e-6)).toBe(true);
    expect(m.heldDays).toBe(3);
    // [元に戻す] で建値・mid・印・建てた日時がすべて戻る
    const undone = reduce(applied, plan.undo);
    expect(undone.legs).toEqual(s.legs);
    expect(pnl0(undone)).toBe(pnl0(s));
    // 2 回目は何も変えない（冪等）
    const again = rebaseLegs(later, applied.legs, holidays);
    expect([again.changed, again.reopened]).toEqual([0, 0]);
    const plan2 = rebasePlan(applied);
    expect(plan2?.kind).toBe('leg-rebase-same');
    expect(plan2?.apply).toBeNull();
  });

  it('建値が変わった足と建てた日時だけ今にした足が混ざると、本数は建て直した本数（両方）', () => {
    const s = sameEntryHeld();
    const mixed = run(reduce(s, { type: 'removeLeg', id: 4 }), {
      type: 'editLeg',
      id: 1,
      patch: { entry: 1 },
    });
    const r = rebaseLegs(later, mixed.legs, holidays);
    expect([r.changed, r.reopened, r.rebuilt, r.kept]).toEqual([1, 3, 3, 0]);
    expect(rebasePlan(mixed)?.text).toBe('建値を今の板に合わせた（3 本）');
    // 据え置きがあれば同じ本数で据え置きも出す
    const withKept = reduce(s, { type: 'editLeg', id: 1, patch: { entry: 1 } });
    expect(rebasePlan(withKept)?.text).toBe('建値を合わせた 3 本・据え置き 1 本');
  });

  it('据え置きが無ければ「建値は同じ・建てた日時を今に（N 本）」', () => {
    const s = sameEntryHeld();
    const only = reduce(s, { type: 'removeLeg', id: 4 });
    expect(rebasePlan(only)?.text).toBe('建値は同じ・建てた日時を今に（3 本）');
  });

  it('建値が変わる足も建てた日時を今に（先物は明示）', () => {
    const s = heldState();
    const r = rebaseLegs(later, s.legs, holidays);
    expect(r.changed).toBe(3);
    expect(r.reopened).toBe(3);
    expect(r.legs[2]?.leg).toMatchObject({
      kind: 'future',
      entry: later.future.price,
      openedAt: T3,
    });
  });
});

describe('AC14: 保存の往復で建てた日時が保たれる', () => {
  const s = heldState();
  const legsOf = (legs: ReadonlyArray<{ leg: UiLeg['leg'] }>) => legs.map((l) => l.leg);

  it('足の保存形: opened_at（ISO 8601）はキーの順の最後、持たない足は書かない', () => {
    const op = savedLeg(s.legs[0]?.leg as UiLeg['leg']);
    expect(Object.keys(op).at(-1)).toBe('opened_at');
    expect((op as { opened_at?: string }).opened_at).toBe(new Date(T0).toISOString());
    const fut = savedLeg(s.legs[2]?.leg as UiLeg['leg']);
    expect(Object.keys(fut).at(-1)).toBe('opened_at');
    const plain = reduce(initialState, { type: 'addManualLeg', input: manualInput });
    expect('opened_at' in savedLeg(plain.legs[0]?.leg as UiLeg['leg'])).toBe(false);
  });

  it('作業のキー（版 2）', () => {
    const r = readWorkspace(serializeWorkspace(s, NOW));
    if (r.kind !== 'ok') throw new Error(r.kind);
    const back = restoreWorkspace(initialState, r.saved);
    expect(legsOf(back.legs)).toEqual(legsOf(s.legs));
    expect(persistKey(back)).toBe(persistKey(s));
  });

  it('建てた日時だけが変わっても変更の判定（persistKey）に出る', () => {
    const r = rebaseLegs(later, s.legs, holidays);
    const moved: UiLeg[] = s.legs.map((l, i) =>
      i === 0 ? { ...l, leg: { ...l.leg, openedAt: T3 } } : l,
    );
    expect(r.legs).toHaveLength(4);
    const s2 = reduce(s, { type: 'replaceLegs', legs: moved, expect: s.legs, tab: s.activeTab });
    expect(persistKey(s2)).not.toBe(persistKey(s));
  });

  it('1 ポジションの文書・保存一覧・書き出し → 読み込み', () => {
    const doc = readPositionDoc(JSON.stringify(toSaved(s, NOW)));
    if (doc.kind !== 'ok' || !doc.saved.position) throw new Error(doc.kind);
    expect(legsOf(doc.saved.position.legs)).toEqual(legsOf(s.legs));
    const added = addEntry(EMPTY_BOOK, toSaved(s, NOW), 'a', NOW, 'a');
    if (!added.ok) throw new Error(added.reason);
    const read = readBook(serializeBook(added.book));
    if (read.kind !== 'ok') throw new Error(read.kind);
    const e = read.book.entries[0];
    if (e?.status !== 'ok') throw new Error('読めない');
    expect(legsOf(e.ws.position.legs)).toEqual(legsOf(s.legs));
    const ex = exportBook(read.book, NOW);
    const im = importIntoBook(EMPTY_BOOK, ex.text, NOW, () => 'b');
    if (!im.ok) throw new Error(im.reason);
    const e2 = im.book.entries[0];
    if (e2?.status !== 'ok') throw new Error('読めない');
    expect(legsOf(e2.ws.position.legs)).toEqual(legsOf(s.legs));
  });

  it('URL', async () => {
    const m = await encodeShareUrl(toSaved(s, NOW), 'A', `https://${'x'.repeat(20)}/`);
    if (m.kind !== 'ok') throw new Error(m.kind);
    const r = await readShareHash(m.url.slice(m.url.indexOf('#')));
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(legsOf(r.shared.legs)).toEqual(legsOf(s.legs));
  });
});

describe('AC16: 建てた日時が不正な足を含む position は捨てる', () => {
  const s = heldState();
  const docWith = (v: unknown) => {
    const doc = JSON.parse(JSON.stringify(toSaved(s, NOW)));
    doc.position.legs[1].leg.opened_at = v;
    return JSON.stringify(doc);
  };
  it.each([
    ['数値', T0],
    ['空文字', ''],
    ['読めない日時', 'x'],
    ['65 字', `2026-10-13T12:31:00.000Z${' '.repeat(41)}`],
    ['null', null],
    ['オブジェクト', {}],
  ])('%s → position を捨てる', (_name, v) => {
    const r = readPositionDoc(docWith(v));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.saved.position).toBeNull();
    expect(r.dropped).toBe(true);
  });

  it('先物の足の不正な opened_at も捨てる、正しい値は読む', () => {
    const doc = JSON.parse(JSON.stringify(toSaved(s, NOW)));
    doc.position.legs[2].leg.opened_at = 'not a date';
    const r = readPositionDoc(JSON.stringify(doc));
    expect(r.kind === 'ok' && r.saved.position).toBeNull();
    const ok = readPositionDoc(docWith('2026-10-13T12:31:00Z'));
    if (ok.kind !== 'ok' || !ok.saved.position) throw new Error('読めない');
    expect(ok.saved.position.legs[1]?.leg.openedAt).toBe(Date.parse('2026-10-13T12:31:00Z'));
  });
});

describe('AC18: 足の詳細に建てた日・今の値段・含み損益', () => {
  const s = heldState();
  const model = positionModel(later, s.legs, 'B', CALENDAR);
  const detail = (i: number) => {
    const row = model.rows[i];
    if (!row) throw new Error('行が無い');
    return legDetail(row, null, null, 'yen');
  };
  const item = (i: number, key: string) => detail(i).items.find((x) => x.key === key);

  it('前の板で建てた OP の足: 建てた日（N 日前）・今の値段（mid）・含み損益（円、符号つき）', () => {
    expect(item(0, 'opened')?.value).toBe('2026-10-13（3 日前）');
    expect(item(0, 'mark')?.value).toMatch(/ · mid$/);
    const r = model.rows[0];
    expect(item(0, 'unrealized')?.label).toBe('含み損益 円');
    expect(item(0, 'unrealized')?.value).toMatch(/^[+−]/);
    expect(r?.unrealizedYen).not.toBeNull();
    // 項目は売買の後・建値ずれの前
    const keys = detail(0).items.map((x) => x.key);
    expect(keys.slice(keys.indexOf('side'), keys.indexOf('mismatch') + 1)).toEqual([
      'side',
      'opened',
      'mark',
      'unrealized',
      'mismatch',
    ]);
  });

  it('先物の足は先物価格、今の値段が取れない手入力の足は — と注記', () => {
    expect(item(2, 'mark')?.value).toMatch(/ · 先物価格$/);
    expect(item(3, 'mark')).toMatchObject({ value: '—' });
    expect(item(3, 'mark')?.note).toContain('今の値段が取れない');
    expect(item(3, 'unrealized')).toBeUndefined();
  });

  it('今の板で入れた足は建てた日（当日）だけ、建てた日時の無い足は出さない', () => {
    const now = reduce(load(initialState, later), sellPut64);
    const r = positionModel(later, now.legs, 'B', CALENDAR).rows[0];
    if (!r) throw new Error('行が無い');
    expect(openedText(r)).toBe('2026-10-16（当日）');
    expect(heldMarkText(r)).toBeNull();
    const keys = legDetail(r, null, null, 'yen').items.map((x) => x.key);
    expect(keys).toContain('opened');
    expect(keys).not.toContain('mark');
    const plain = reduce(initialState, { type: 'addManualLeg', input: manualInput });
    const pr = positionModel(later, plain.legs, 'B', CALENDAR).rows[0];
    if (!pr) throw new Error('行が無い');
    expect(openedText(pr)).toBeNull();
    expect(legDetail(pr, null, null, 'yen').items.map((x) => x.key)).not.toContain('opened');
  });

  it('建てた日時が今の板より後（古い板を表示）は「（当日）」でなく「（今の板より後）」', () => {
    const st = load(reduce(load(initialState, later), sellPut64), t0);
    const r = positionModel(t0, st.legs, 'B', CALENDAR).rows[0];
    if (!r) throw new Error('行が無い');
    expect(r.openedAfterBoard).toBe(true);
    expect(openedText(r)).toBe('2026-10-16（今の板より後）');
  });

  it('今の値段がスマイルの理論価格の足は「理論価格」', () => {
    const st = load(
      run(load(initialState, t0), {
        type: 'addBoardLeg',
        expiry: '2026-11',
        k: 59000,
        optionType: 'put',
        side: 'sell',
      }),
      later,
    );
    const r = positionModel(later, st.legs, 'B', CALENDAR).rows[0];
    if (!r) throw new Error('行が無い');
    expect(heldMarkText(r)).toMatch(/ · 理論価格$/);
  });
});
